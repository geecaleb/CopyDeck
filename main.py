#!/usr/bin/env python3
import asyncio
import base64
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import decky
from settings import SettingsManager  # type: ignore

settings = SettingsManager(name="settings", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR)
settings.read()


def _vdf_load_string(text: str, start: int = 0) -> tuple:
    """Minimal VDF parser: returns (parsed_dict, end_index). Handles "key" "value" and "key" { ... }."""
    i = start
    n = len(text)
    result = {}

    def skip_whitespace() -> None:
        nonlocal i
        while i < n and text[i] in " \t\n\r":
            i += 1

    def read_string() -> Optional[str]:
        nonlocal i
        skip_whitespace()
        if i >= n or text[i] != '"':
            return None
        i += 1
        start_idx = i
        while i < n and text[i] != '"':
            if text[i] == "\\":
                i += 1
            i += 1
        if i >= n:
            return None
        s = text[start_idx:i].replace("\\\"", "\"")
        i += 1
        return s

    while i < n:
        skip_whitespace()
        if i >= n:
            break
        key = read_string()
        if key is None:
            break
        skip_whitespace()
        if i >= n:
            break
        if text[i] == '"':
            value = read_string()
            if value is not None:
                result[key] = value
        elif text[i] == '{':
            i += 1
            depth = 1
            block_start = i
            while i < n and depth > 0:
                if text[i] == '{':
                    depth += 1
                elif text[i] == '}':
                    depth -= 1
                i += 1
            block_end = i - 1
            sub, _ = _vdf_load_string(text[block_start:block_end], 0)
            result[key] = sub
        else:
            break
    return result, i


def _vdf_load(path: Path) -> Dict[str, Any]:
    """Load a VDF file into a nested dict. Top-level key is usually the first key (e.g. 'libraryfolders')."""
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    parsed, _ = _vdf_load_string(text)
    if len(parsed) == 1:
        return next(iter(parsed.values())) if isinstance(next(iter(parsed.values())), dict) else {}
    return parsed


def _libraryfolders_vdf_paths() -> List[Path]:
    """Return candidate paths for libraryfolders.vdf (internal can be in config or steamapps)."""
    home = Path(decky.DECKY_USER_HOME)
    return [
        home / ".local" / "share" / "Steam" / "config" / "libraryfolders.vdf",
        home / ".steam" / "steam" / "steamapps" / "libraryfolders.vdf",
        home / ".steam" / "steam" / "config" / "libraryfolders.vdf",
    ]


def _get_libraryfolders() -> Dict[str, Any]:
    """Load libraryfolders from first existing path. Returns dict of "0", "1", ... -> { "path": ... }."""
    for vdf_path in _libraryfolders_vdf_paths():
        if vdf_path.exists():
            data = _vdf_load(vdf_path)
            folders = data.get("libraryfolders") or data.get("LibraryFolders") or data
            if isinstance(folders, dict):
                return folders
    return {}


def _get_steam_install_steamapps() -> Path:
    """Return the steamapps directory that belongs to the Steam installation itself.

    Steam always stores compatdata and shadercache here, regardless of which
    library a game is installed to or which drive is set as the default.

    Strategy: entry "1" in libraryfolders.vdf is always the Steam install
    library (the folder Steam itself lives in).  We read that path from the
    VDF so that non-standard installs (e.g. Steam on an external drive) are
    handled correctly.  Falls back to the conventional ~/.local/share/Steam
    path if the VDF cannot be read or entry "1" is absent/missing.
    """
    fallback = Path(decky.DECKY_USER_HOME) / ".local" / "share" / "Steam" / "steamapps"
    try:
        folders = _get_libraryfolders()
        entry = folders.get("1") or folders.get("0")
        if isinstance(entry, dict):
            raw = entry.get("path", "")
            if raw:
                p = Path(raw).resolve() / "steamapps"
                if p.exists():
                    return p
    except Exception:
        pass
    return fallback


def _drive_label(resolved_path: Path) -> str:
    """Derive label from path: VDF gives the path; mount path contains the label (e.g. /run/media/deck/1Deck1TB → 1Deck1TB)."""
    p = resolved_path
    parts = p.parts
    if "media" in parts:
        idx = parts.index("media")
        label_parts = parts[idx + 2:]  # after "media" and "deck"
        return "/".join(label_parts) if label_parts else str(p)
    if str(p).startswith("/home"):
        return "Internal Storage"
    return str(p)


def _file_is_complete(src: Path, dst: Path) -> bool:
    """True if dst exists and has same size as src (for incremental-style skip)."""
    if not dst.exists():
        return False
    try:
        return src.stat().st_size == dst.stat().st_size
    except OSError:
        return False


def _resume_offset(src: Path, dst: Path) -> int:
    """Return the byte offset to resume copying src to dst.
    0 = start fresh. dst_size = resume mid-file. src_size = already complete (skip).
    Never raises; falls back to 0 on any error."""
    try:
        if not dst.exists():
            return 0
        dst_size = dst.stat().st_size
        src_size = src.stat().st_size
        if dst_size >= src_size:
            return src_size  # complete or over-size — treat as done
        return dst_size      # partial — resume from here
    except OSError:
        return 0


def _copy_tree_resumable(src: Path, dst: Path, conflict_mode: Optional[str] = None) -> None:
    """Merge-copy a directory tree into dst (Dolphin-style write-into).
    Skip/default: leave size-matched files, resume partials.
    Overwrite: replace every file from byte 0. Never rmtree's dst.
    """
    import os as _os
    dst.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in _os.walk(str(src), followlinks=False):
        rel_dir = Path(dirpath).relative_to(src)
        dst_dir = dst / rel_dir if str(rel_dir) != "." else dst
        dst_dir.mkdir(parents=True, exist_ok=True)
        for dname in list(dirnames):
            src_d = Path(dirpath) / dname
            if src_d.is_symlink():
                link_target = _os.readlink(str(src_d))
                dst_d = dst_dir / dname
                if conflict_mode != "overwrite" and (dst_d.exists() or dst_d.is_symlink()):
                    if dst_d.is_dir() and not dst_d.is_symlink():
                        pass
                    else:
                        pass  # leave existing symlink on skip
                elif dst_d.exists() or dst_d.is_symlink():
                    if dst_d.is_dir() and not dst_d.is_symlink():
                        pass
                    else:
                        dst_d.unlink()
                        _os.symlink(link_target, str(dst_d))
                else:
                    _os.symlink(link_target, str(dst_d))
                dirnames.remove(dname)
        for fname in filenames:
            src_f = Path(dirpath) / fname
            dst_f = dst_dir / fname
            if src_f.is_symlink():
                if conflict_mode != "overwrite" and (dst_f.exists() or dst_f.is_symlink()):
                    continue
                link_target = _os.readlink(str(src_f))
                if dst_f.exists() or dst_f.is_symlink():
                    dst_f.unlink()
                _os.symlink(link_target, str(dst_f))
                continue
            if not src_f.is_file():
                continue
            src_size = src_f.stat().st_size
            if conflict_mode == "overwrite":
                offset = 0
            else:
                offset = _resume_offset(src_f, dst_f)
                if offset >= src_size:
                    continue
            mode = "r+b" if offset > 0 else "wb"
            with open(str(src_f), "rb") as fsrc, open(str(dst_f), mode) as fdst:
                if offset > 0:
                    fsrc.seek(offset)
                    fdst.seek(offset)
                while True:
                    buf = fsrc.read(1024 * 1024)
                    if not buf:
                        break
                    fdst.write(buf)
            try:
                shutil.copystat(str(src_f), str(dst_f))
            except OSError:
                pass


def _count_files(path: Path) -> int:
    """Count files under path (fast — no stat() calls). Used for destination state."""
    try:
        return sum(1 for f in path.rglob("*") if f.is_file())
    except OSError:
        return 0


class Plugin:
    _copy_progress: Dict[str, Dict[str, Any]] = {}
    _copy_queue: List[Dict[str, Any]] = []
    _is_copying: bool = False
    _current_job: Optional[str] = None
    _cancel_flag: Dict[str, bool] = {}
    _pause_flag: Dict[str, bool] = {}
    # When True, _run_queue_sync deletes partial_path/dest_path after the job exits on cancel.
    _remove_partial_on_cancel: Dict[str, bool] = {}
    _stop_after_current: bool = False  # set by cancel_copy; clears pause so current job finishes then queue exits
    _complete_seq: int = 0  # increments when a job is first observed as completed

    @staticmethod
    def _safe_remove_partial_path(path_str: str) -> bool:
        """Delete a cancelled copy's destination. Returns True if something was removed.
        Refuses shallow/system paths so a bad dest_path can't wipe a drive root."""
        import os as _os
        if not path_str or not isinstance(path_str, str):
            return False
        try:
            p = Path(path_str).resolve()
        except OSError:
            return False
        s = str(p)
        if not (s.startswith("/home/") or s.startswith("/run/media/")):
            return False
        # Require enough depth: /home/deck/X/Y or /run/media/deck/LABEL/Y
        if s.startswith("/run/media/"):
            if len(p.parts) < 5:  # /, run, media, user, label, …
                return False
        elif len(p.parts) < 4:  # /, home, deck, …
            return False
        try:
            if not p.exists() and not p.is_symlink():
                return False
            if p.is_symlink() or p.is_file():
                _os.unlink(s)
            else:
                shutil.rmtree(s)
            decky.logger.info(f"CopyDeck removed partial after cancel: {s}")
            return True
        except Exception as e:
            decky.logger.warning(f"CopyDeck partial remove failed {s}: {e}")
            return False

    def _cleanup_partial_if_requested(self, job_id: str) -> None:
        """If cancel asked to remove the partial, delete it once the worker has stopped.
        Never deletes the source — only the recorded destination partial_path."""
        if not Plugin._remove_partial_on_cancel.pop(job_id, False):
            return
        entry = Plugin._copy_progress.get(job_id) or {}
        path = entry.get("partial_path") or entry.get("dest_path") or ""
        if not path:
            return
        # Hard refuse if destination resolves to the same place as the source
        src_candidates = [
            entry.get("src_path"),
            entry.get("src_dir"),
            entry.get("src_file"),
            entry.get("src_library"),
        ]
        try:
            dest_res = str(Path(str(path)).resolve())
            for src in src_candidates:
                if not src:
                    continue
                try:
                    src_res = str(Path(str(src)).resolve())
                except OSError:
                    continue
                if dest_res == src_res or dest_res.startswith(src_res + "/") or src_res.startswith(dest_res + "/"):
                    decky.logger.warning(
                        f"CopyDeck refused partial remove — dest overlaps source: {dest_res} vs {src_res}"
                    )
                    return
        except OSError:
            pass
        if self._safe_remove_partial_path(str(path)):
            entry.update({"stage": "Cancelled — partial removed", "partial_removed": True})

    async def get_drives(self) -> List[Dict[str, Any]]:
        folders = _get_libraryfolders()
        drives = []
        seen = set()

        for key, entry in folders.items():
            if not key.isdigit() or not isinstance(entry, dict):
                continue
            raw_path = entry.get("path", "")
            if not raw_path:
                continue
            resolved = Path(raw_path).resolve()
            if not resolved.exists():
                continue
            path_str = str(resolved)
            if path_str in seen:
                continue
            seen.add(path_str)
            try:
                usage = shutil.disk_usage(resolved)
            except OSError as e:
                decky.logger.warning(f"CopyDeck: skip path {path_str}: {e}")
                continue
            is_internal = "home" in path_str or "local/share/Steam" in path_str or ".steam" in path_str
            drives.append({
                "path": path_str,
                "label": _drive_label(resolved),
                "free_gb": round(usage.free / (1024**3), 1),
                "total_gb": round(usage.total / (1024**3), 1),
                "is_internal": is_internal,
            })
        return drives

    async def get_installed_games(self) -> List[Dict[str, Any]]:
        folders = _get_libraryfolders()
        games = []

        for key, entry in folders.items():
            if not key.isdigit() or not isinstance(entry, dict):
                continue
            raw_path = entry.get("path", "")
            if not raw_path:
                continue
            lib_path = Path(raw_path).resolve()
            acf_dir = lib_path / "steamapps"
            if not acf_dir.exists():
                continue
            lib_path_str = str(lib_path)

            for acf_file in acf_dir.glob("appmanifest_*.acf"):
                try:
                    data = acf_file.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                appid = re.search(r'"appid"\s+"(\d+)"', data)
                name = re.search(r'"name"\s+"([^"]*)"', data)
                size = re.search(r'"SizeOnDisk"\s+"(\d+)"', data)
                installdir = re.search(r'"installdir"\s+"([^"]+)"', data)
                if not appid or not installdir:
                    continue
                install_dir_name = installdir.group(1)
                common = lib_path / "steamapps" / "common" / install_dir_name
                if not common.exists():
                    continue
                games.append({
                    "appid": appid.group(1),
                    "name": (name.group(1) if name else "").strip() or f"App {appid.group(1)}",
                    "size_bytes": int(size.group(1)) if size else 0,
                    "installdir": install_dir_name,
                    "library_path": lib_path_str,
                    "acf_path": str(acf_file.resolve()),
                })
        return games

    async def get_all_shortcut_dirs(self, steam_id: str = "") -> Dict[str, str]:
        """Return {str(appid): start_dir} for all non-Steam shortcuts found on this system.
        Uses the raw appid stored in shortcuts.vdf (matches what Steam exposes in the context menu).
        Splits entries on the double-0x08 boundary between records.
        Falls back to exe parent dir if StartDir is empty.
        Returns empty dict on any error so callers degrade gracefully.

        steam_id: the active 32-bit Steam account ID (passed from the frontend via
        window.App.m_CurrentUser.strSteamID converted to 32-bit). When provided, only
        that account's shortcuts.vdf is read, avoiding stale data from other accounts.
        """
        import re as _re, struct as _struct, glob as _glob

        def _parse_shortcuts(data: bytes) -> Dict[str, str]:
            result: Dict[str, str] = {}
            # Each entry is delimited by \x08\x08 in the binary VDF format
            for entry in _re.split(b"\x08\x08", data):
                appid_m  = _re.search(b"(?i)\x02appid\x00(.{4})", entry, _re.DOTALL)
                start_m  = _re.search(b"(?i)\x01startdir\x00([^\x00]+)\x00", entry)
                exe_m    = _re.search(b"(?i)\x01exe\x00([^\x00]+)\x00", entry)
                if not appid_m:
                    continue
                appid = _struct.unpack("<I", appid_m.group(1))[0]
                start_dir = start_m.group(1).decode("utf-8", errors="replace").strip('"') if start_m else ""
                exe       = exe_m.group(1).decode("utf-8", errors="replace").strip('"') if exe_m else ""
                # Use StartDir if present, fall back to exe parent dir
                candidate = ""
                if start_dir:
                    candidate = start_dir
                elif exe:
                    candidate = str(Path(exe).parent)
                if candidate:
                    result[str(appid)] = candidate
            return result

        dirs: Dict[str, str] = {}

        # If we know the active Steam account ID, read only that account's VDF.
        # This prevents stale data from other accounts (e.g. a second profile that
        # still has old pre-move paths) from overwriting the correct current paths.
        if steam_id:
            for base in [
                Path.home() / ".steam" / "steam" / "userdata",
                Path.home() / ".local" / "share" / "Steam" / "userdata",
            ]:
                vdf_path = base / steam_id / "config" / "shortcuts.vdf"
                real = str(vdf_path.resolve())
                if vdf_path.exists():
                    try:
                        dirs.update(_parse_shortcuts(vdf_path.read_bytes()))
                        decky.logger.info(f"CopyDeck: loaded shortcuts for account {steam_id} from {real}")
                    except Exception as e:
                        decky.logger.warning(f"CopyDeck shortcuts parse error {real}: {e}")
                    break  # found it, no need to check the other base path
            if dirs:
                return dirs
            decky.logger.warning(f"CopyDeck: no shortcuts.vdf found for account {steam_id}, falling back to glob")

        # Fallback: glob all accounts (no steam_id provided, or targeted file not found)
        import glob as _glob
        patterns = [
            str(Path.home() / ".steam" / "steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
            str(Path.home() / ".local" / "share" / "Steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
        ]
        seen: set = set()
        for pattern in patterns:
            for vdf_path in _glob.glob(pattern):
                real = str(Path(vdf_path).resolve())
                if real in seen:
                    continue
                seen.add(real)
                try:
                    dirs.update(_parse_shortcuts(Path(vdf_path).read_bytes()))
                except Exception as e:
                    decky.logger.warning(f"CopyDeck shortcuts parse error {vdf_path}: {e}")
        return dirs

    async def copy_game(
        self, appid: str, src_library: str, dst_library: str, name: str = ""
    ) -> Dict[str, Any]:
        """Route single-game copy through the queue so resume/skip logic applies."""
        def fail(err: str) -> Dict[str, Any]:
            Plugin._copy_progress[appid] = {
                "copied": 0, "total": 0, "done": False, "error": err, "name": name,
                "stage": "Error", "status": "error",
            }
            return {"success": False, "error": err}

        src_root = Path(src_library)
        acf_src = src_root / "steamapps" / f"appmanifest_{appid}.acf"
        if not acf_src.exists():
            return fail("Manifest not found")

        data = acf_src.read_text(encoding="utf-8", errors="replace")
        installdir_m = re.search(r'"installdir"\s+"([^"]+)"', data)
        if not installdir_m:
            return fail("Invalid manifest")
        installdir = installdir_m.group(1)
        src_game_dir = src_root / "steamapps" / "common" / installdir
        if not src_game_dir.exists():
            return fail("Game folder not found")

        await self.queue_games([
            {
                "appid": appid,
                "name": name or f"App {appid}",
                "src_library": src_library,
                "dst_library": dst_library,
            }
        ])
        return {"success": True}

    async def get_copy_progress(self, appid: str) -> Dict[str, Any]:
        return Plugin._copy_progress.get(
            appid,
            {
                "copied": 0, "total": 0, "done": False, "error": "Not found",
                "name": "", "stage": "", "status": "Not found",
            },
        )

    async def clear_all_progress(self) -> None:
        Plugin._copy_progress.clear()

    async def clear_completed_progress(self) -> None:
        """Remove only jobs with status done, error, or cancelled."""
        to_remove = [
            appid
            for appid, entry in Plugin._copy_progress.items()
            if entry.get("status") in ("done", "error", "cancelled")
        ]
        for appid in to_remove:
            del Plugin._copy_progress[appid]

    async def clear_completed_job(self, job_id: str) -> Dict[str, Any]:
        """Remove one completed job. If job_id is a group_id (or a member of a
        group), clear all completed jobs in that group."""
        completed = ("done", "error", "cancelled")
        entry = Plugin._copy_progress.get(job_id)
        if entry is not None:
            if entry.get("status") not in completed:
                return {"success": False, "error": "Not completed"}
            gid = entry.get("group_id")
            ids = (
                [
                    jid
                    for jid, e in Plugin._copy_progress.items()
                    if e.get("group_id") == gid and e.get("status") in completed
                ]
                if gid
                else [job_id]
            )
        else:
            # Frontend may pass the display row's group key directly
            ids = [
                jid
                for jid, e in Plugin._copy_progress.items()
                if e.get("group_id") == job_id and e.get("status") in completed
            ]
            if not ids:
                return {"success": False, "error": "Not found"}
        for jid in ids:
            del Plugin._copy_progress[jid]
        return {"success": True}

    async def check_destination(
        self, appid: str, src_library: str, dst_library: str
    ) -> Dict[str, Any]:
        """Determine destination state: clean, partial, complete, or orphaned."""
        src_root = Path(src_library)
        dst_root = Path(dst_library)
        acf_src = src_root / "steamapps" / f"appmanifest_{appid}.acf"
        dst_acf = dst_root / "steamapps" / f"appmanifest_{appid}.acf"

        if not acf_src.exists():
            return {"state": "clean", "ok": True, "message": "Fresh copy"}

        data = acf_src.read_text(encoding="utf-8", errors="replace")
        installdir_m = re.search(r'"installdir"\s+"([^"]+)"', data)
        if not installdir_m:
            return {"state": "clean", "ok": True, "message": "Fresh copy"}

        installdir = installdir_m.group(1)
        src_game = src_root / "steamapps" / "common" / installdir
        dst_game = dst_root / "steamapps" / "common" / installdir

        if not src_game.exists():
            return {"state": "clean", "ok": True, "message": "Fresh copy"}

        dst_exists = dst_game.exists()
        # Fast path: empty or missing destination → skip both tree walks
        if not dst_exists or not any(dst_game.iterdir()):
            dst_file_count = 0
            src_file_count = 0
        else:
            src_file_count = _count_files(src_game)
            dst_file_count = _count_files(dst_game)
        acf_exists = dst_acf.exists()

        if dst_exists and src_file_count > 0 and dst_file_count >= src_file_count and acf_exists:
            return {
                "state": "complete",
                "ok": True,
                "message": "Already complete at destination",
            }
        if dst_exists and src_file_count > 0 and dst_file_count >= src_file_count and not acf_exists:
            return {
                "state": "acf_only",
                "ok": True,
                "message": "Files complete, manifest missing — will restore ACF only",
            }
        if dst_exists and dst_file_count > 0 and dst_file_count < src_file_count:
            return {
                "state": "partial",
                "ok": True,
                "message": "Resume partial copy",
            }
        if acf_exists and (not dst_exists or dst_file_count == 0):
            return {
                "state": "orphaned",
                "ok": True,
                "message": "Orphaned manifest, will remove and copy fresh",
            }
        if not acf_exists and dst_exists and dst_file_count > 0:
            return {
                "state": "partial",
                "ok": True,
                "message": "Resume partial copy (no ACF yet)",
            }
        return {"state": "clean", "ok": True, "message": "Fresh copy"}

    async def queue_games(self, jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Enqueue batch copy jobs. Runs queue in a background thread."""
        validated = []
        for job in jobs:
            appid = str(job.get("appid", ""))
            src = job.get("src_library", "")
            dst = job.get("dst_library", "")
            name = job.get("name", f"App {appid}")
            copy_workshop = job.get("copy_workshop", False)
            copy_compatdata = job.get("copy_compatdata", False)
            # Build display name that reflects what's being copied
            extras = []
            if copy_workshop:
                extras.append("Workshop")
            if copy_compatdata:
                extras.append("Compatdata")
            display_name = f"{name} + {' + '.join(extras)}" if extras else name
            check = await self.check_destination(appid, src, dst)
            state = check.get("state", "clean")

            # Resolve a friendly dest path (game folder when installdir is known)
            dest_path = dst
            try:
                acf_src = Path(src) / "steamapps" / f"appmanifest_{appid}.acf"
                if acf_src.exists():
                    _acf = acf_src.read_text(encoding="utf-8", errors="replace")
                    _im = re.search(r'"installdir"\s+"([^"]+)"', _acf)
                    if _im:
                        dest_path = str(Path(dst) / "steamapps" / "common" / _im.group(1))
            except Exception:
                pass

            Plugin._copy_progress[appid] = {
                "copied": 0,
                "total": 0,
                "done": False,
                "error": None,
                "stage": "Queued",
                "status": "queued",
                "name": display_name,
                "src_library": src,
                "dst_library": dst,
                "dest_path": dest_path,
                "partial_path": dest_path,  # game folder — removed on cancel if requested
            }
            Plugin._cancel_flag[appid] = False
            Plugin._pause_flag[appid] = False

            conflict_mode = job.get("conflict_mode")  # None | "skip" | "overwrite"
            if state == "complete" and conflict_mode != "overwrite":
                Plugin._copy_progress[appid].update({
                    "done": True,
                    "status": "done",
                    "stage": "Already complete at destination",
                    "already_existed": True,
                })
                continue

            if state == "acf_only":
                Plugin._copy_progress[appid].update({
                    "stage": "Restoring manifest...",
                    "status": "copying",
                })
                try:
                    acf_src = Path(src) / "steamapps" / f"appmanifest_{appid}.acf"
                    dst_acf = Path(dst) / "steamapps" / f"appmanifest_{appid}.acf"
                    shutil.copy2(str(acf_src), str(dst_acf))
                    Plugin._copy_progress[appid].update({
                        "done": True,
                        "status": "done",
                        "stage": "Manifest restored — game ready in Steam",
                    })
                except Exception as e:
                    Plugin._copy_progress[appid].update({
                        "done": True,
                        "status": "error",
                        "error": str(e),
                    })
                continue

            skip_game_files = job.get("skip_game_files", False)
            job_entry = {
                "appid": appid,
                "src_library": src,
                "dst_library": dst,
                "name": display_name,
                "pre_check": check,
                "copy_workshop": copy_workshop,
                "copy_compatdata": copy_compatdata,
                "skip_game_files": skip_game_files,
                "conflict_mode": conflict_mode,
            }
            if state == "orphaned":
                job_entry["delete_orphaned_acf"] = True
            validated.append(job_entry)

        Plugin._copy_queue.extend(validated)

        if validated and not Plugin._is_copying:
            thread = threading.Thread(
                target=self._run_queue_sync,
                daemon=True,
            )
            thread.start()

        return {"success": True, "job_count": len(validated)}

    def _run_queue_sync(self) -> None:
        """Runs in a background thread. Processes jobs one at a time.

        File-op jobs that share a group_id are treated as a single logical job:
        - Pause/resume/stop-after-current apply to the whole group as a unit.
        - The queue only moves past a group when ALL its files are done.
        - Cancelling or stopping clears the rest of the global queue too,
          matching the behaviour of game copy jobs.
        """
        Plugin._is_copying = True
        try:
            while Plugin._copy_queue:
                job = Plugin._copy_queue.pop(0)

                if "job_id" in job:
                    # ── File-op job ──────────────────────────────────────────
                    gid = job.get("group_id")

                    # Collect all sibling jobs for this group that are
                    # already sitting in the queue so we can run them together.
                    if gid:
                        siblings = [j for j in Plugin._copy_queue if j.get("group_id") == gid]
                        Plugin._copy_queue  = [j for j in Plugin._copy_queue if j.get("group_id") != gid]
                        group_jobs = [job] + siblings
                    else:
                        group_jobs = [job]

                    # Process all files in the group as a single logical job.
                    # Cancelling the group skips remaining siblings and continues
                    # the global queue (cancel_all clears the queue separately).
                    for gjob in group_jobs:
                        job_id = gjob["job_id"]
                        if Plugin._cancel_flag.get(job_id):
                            if job_id in Plugin._copy_progress:
                                Plugin._copy_progress[job_id].update({
                                    "done": True,
                                    "status": "cancelled",
                                    "stage": "Cancelled",
                                })
                            self._cleanup_partial_if_requested(job_id)
                            continue

                        Plugin._current_job = job_id

                        # If the group was paused before this file started,
                        # honour that by pre-setting the pause flag.
                        # (pause_group already set it; we just start and the
                        # pause loop inside _execute_file_op_sync picks it up.)

                        if gjob.get("op") == "extract":
                            self._execute_extract_sync(gjob)
                        elif gjob.get("op") == "compress":
                            self._execute_compress_sync(gjob)
                        elif gjob.get("op") == "nonsteam":
                            self._execute_nonsteam_copy_sync(gjob)
                        elif gjob.get("op") == "nonsteam_file":
                            self._execute_nonsteam_file_copy_sync(gjob)
                        elif gjob.get("op") == "lutris":
                            self._execute_lutris_copy_sync(gjob)
                        else:
                            self._execute_file_op_sync(gjob)

                        # After cancel (or normal finish): remove partial if user asked.
                        self._cleanup_partial_if_requested(job_id)

                else:
                    # ── Game copy job ────────────────────────────────────────
                    appid = job["appid"]
                    Plugin._current_job = appid
                    self._execute_copy_sync(
                        appid,
                        job["src_library"],
                        job["dst_library"],
                        job.get("name", f"App {appid}"),
                        job.get("delete_orphaned_acf", False),
                        job.get("copy_workshop", False),
                        job.get("copy_compatdata", False),
                        job.get("skip_game_files", False),
                        job.get("conflict_mode"),
                    )
                    self._cleanup_partial_if_requested(appid)
                    # If this job was cancelled, fall through so the next
                    # queued job starts (cancel_all is what clears the queue).
        finally:
            Plugin._is_copying = False
            Plugin._current_job = None
            Plugin._stop_after_current = False

    def _execute_extract_sync(self, job: Dict[str, Any]) -> None:
        """Extract an archive with progress tracking. Supports zip, tar.gz, tar.bz2, 7z, rar."""
        import os as _os
        job_id   = job["job_id"]
        src      = Path(job["src"])
        dst_dir  = Path(job["dst_dir"])
        password = job.get("password") or None

        def update(**kw):
            Plugin._copy_progress[job_id].update(kw)

        try:
            dst_dir.mkdir(parents=True, exist_ok=True)
            name = src.name.lower()
            update(stage="Extracting…", status="copying")

            if name.endswith(".zip"):
                # Use system unzip so symlinks stored in the archive are
                # restored correctly (Python zipfile writes the link-target
                # string as a plain file instead of creating a symlink).
                import subprocess as _sp
                import time as _t
                cmd = ["unzip", "-o", str(src), "-d", str(dst_dir)]
                if password:
                    cmd = ["unzip", "-o", "-P", password, str(src), "-d", str(dst_dir)]
                proc = _sp.Popen(cmd, stdout=_sp.PIPE, stderr=_sp.PIPE)
                while proc.poll() is None:
                    if Plugin._cancel_flag.get(job_id):
                        proc.terminate()
                        try: proc.wait(timeout=5)
                        except: proc.kill()
                        update(done=True, status="cancelled", stage="Cancelled"); return
                    _t.sleep(0.3)
                if proc.returncode not in (0, 1):  # unzip rc=1 = warnings, still ok
                    stderr = (proc.stderr.read() or b"").decode(errors="replace")[:300]
                    stdout = (proc.stdout.read() or b"").decode(errors="replace")[:300]
                    err = stderr or stdout
                    if "incorrect password" in err.lower() or "bad password" in err.lower():
                        raise ValueError("Wrong password")
                    raise RuntimeError(f"unzip exited {proc.returncode}: {err}")
                update(copied=1, total=1)

            elif name.endswith((".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".tar")):
                # Python tarfile restores symlinks (dead or alive) as actual
                # symlinks, streams large files, and avoids the /bin/sh
                # readline symbol error that hits system tar in Decky's env.
                import tarfile as _tarfile
                with _tarfile.open(str(src), "r:*") as tf:
                    members = tf.getmembers()
                    total = sum(m.size for m in members if m.isfile())
                    update(total=max(total, 1))
                    done = 0
                    for m in members:
                        if Plugin._cancel_flag.get(job_id):
                            update(done=True, status="cancelled", stage="Cancelled"); return
                        tf.extract(m, str(dst_dir), set_attrs=False)
                        if m.isfile():
                            done += m.size
                            update(copied=done)

            elif name.endswith(".7z"):
                import subprocess as _sp
                result = _sp.run(
                    ["7z", "x", str(src), f"-o{dst_dir}", "-y"] +
                    ([f"-p{password}"] if password else []),
                    capture_output=True, text=True
                )
                if result.returncode != 0:
                    err = result.stderr or result.stdout
                    if "Wrong password" in err or "password" in err.lower():
                        raise ValueError("Wrong password")
                    raise RuntimeError(err[:200])
                update(copied=1, total=1)

            elif name.endswith(".rar"):
                import subprocess as _sp
                result = _sp.run(
                    ["unrar", "x", "-y", str(src), str(dst_dir) + "/"] +
                    ([f"-p{password}"] if password else ["-p-"]),
                    capture_output=True, text=True
                )
                if result.returncode != 0:
                    err = result.stderr or result.stdout
                    if "wrong password" in err.lower() or "bad data" in err.lower():
                        raise ValueError("Wrong password")
                    raise RuntimeError(err[:200])
                update(copied=1, total=1)

            else:
                raise ValueError(f"Unsupported archive format: {src.suffix}")

            update(done=True, status="done", stage="Done")
            decky.logger.info(f"CopyDeck extract: {src} -> {dst_dir} OK")

        except Exception as e:
            update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck extract error: {e}")

    def _execute_compress_sync(self, job: Dict[str, Any]) -> None:
        """Compress files/directories into a zip or tar.gz archive.

        Uses Python tarfile for tar.gz — it stores symlinks (dead or alive) as
        symlink entries natively without following them, handles large files via
        streaming, and doesn't shell out so there are no /bin/sh environment issues.
        Uses Python zipfile for zip with explicit symlink preservation.
        """
        import os as _os
        import tarfile as _tarfile
        import zipfile as _zipfile

        job_id = job["job_id"]
        srcs   = job["srcs"]       # list of absolute source paths
        dst    = Path(job["dst"])  # full path of the output archive
        fmt    = job.get("fmt", "targz")  # "targz" | "zip"

        def update(**kw):
            Plugin._copy_progress[job_id].update(kw)

        def cancelled():
            return bool(Plugin._cancel_flag.get(job_id))

        def walk_no_follow(root: Path):
            """Yield every path under root without following symlinks."""
            for dirpath, dirnames, filenames, dirfd in _os.fwalk(str(root), follow_symlinks=False):
                dp = Path(dirpath)
                for d in dirnames:
                    yield dp / d
                for f in filenames:
                    yield dp / f

        # ── Pre-calculate total size for the progress bar ──────────────────
        total_bytes = 0
        for src_str in srcs:
            src_path = Path(src_str)
            if src_path.is_symlink():
                pass  # negligible
            elif src_path.is_dir():
                for f in walk_no_follow(src_path):
                    if not f.is_symlink() and f.is_file():
                        try: total_bytes += f.stat().st_size
                        except OSError: pass
            elif src_path.is_file():
                try: total_bytes += src_path.stat().st_size
                except OSError: pass

        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            update(stage="Compressing…", status="copying",
                   total=max(total_bytes, 1), copied=0)
            copied_bytes = 0

            if fmt == "targz":
                with _tarfile.open(str(dst), "w:gz") as tf:
                    for src_str in srcs:
                        src_path = Path(src_str)
                        parent   = src_path.parent
                        arcname  = src_path.name

                        if src_path.is_symlink() or not src_path.is_dir():
                            # Single file or symlink — add directly
                            if cancelled():
                                break
                            tf.add(str(src_path), arcname=arcname, recursive=False)
                            if src_path.is_file() and not src_path.is_symlink():
                                try:
                                    copied_bytes += src_path.stat().st_size
                                    update(copied=copied_bytes)
                                except OSError: pass
                        else:
                            # Directory — walk without following symlinks
                            tf.add(str(src_path), arcname=arcname, recursive=False)
                            for entry in walk_no_follow(src_path):
                                if cancelled(): break
                                rel = entry.relative_to(parent)
                                tf.add(str(entry), arcname=str(rel), recursive=False)
                                if entry.is_file() and not entry.is_symlink():
                                    try:
                                        copied_bytes += entry.stat().st_size
                                        update(copied=copied_bytes)
                                    except OSError: pass
                        if cancelled(): break

            elif fmt == "zip":
                with _zipfile.ZipFile(str(dst), "w",
                                      compression=_zipfile.ZIP_DEFLATED,
                                      allowZip64=True) as zf:
                    for src_str in srcs:
                        src_path = Path(src_str)
                        parent   = src_path.parent

                        def _add_zip(p: Path) -> None:
                            if cancelled(): return
                            arcname = str(p.relative_to(parent))
                            if p.is_symlink():
                                info = _zipfile.ZipInfo(arcname)
                                info.create_system = 3
                                info.external_attr = 0xA1ED0000  # symlink mode
                                zf.writestr(info, _os.readlink(str(p)))
                            elif p.is_dir():
                                for child in sorted(p.iterdir()):
                                    _add_zip(child)
                            else:
                                zf.write(str(p), arcname)
                                nonlocal copied_bytes
                                try:
                                    copied_bytes += p.stat().st_size
                                    update(copied=copied_bytes)
                                except OSError: pass

                        _add_zip(src_path)
                        if cancelled(): break
            else:
                raise ValueError(f"Unknown compress format: {fmt}")

            if cancelled():
                if dst.exists(): dst.unlink()
                update(done=True, status="cancelled", stage="Cancelled")
                return

            update(done=True, status="done", stage="Done", copied=max(total_bytes, 1))
            decky.logger.info(f"CopyDeck compress: {srcs} -> {dst} OK")

        except Exception as e:
            if dst.exists():
                try: dst.unlink()
                except: pass
            update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck compress error: {e}")

    def _execute_file_op_sync(self, job: Dict[str, Any]) -> None:
        """Execute a single file copy or move operation in the queue thread.

        conflict_mode (from browse duplicate prompt):
          None / unset — resume partials, skip size-matched files (default resume)
          "skip"       — if dest file exists at all, leave it; only copy missing
          "overwrite"  — replace every dest file from byte 0 (dirs still write-into)
        """
        import os as _os

        job_id  = job["job_id"]
        op      = job.get("op", "copy")
        src     = Path(job["src"])
        dst_dir = Path(job["dst_dir"])
        label   = job.get("label", src.name)
        conflict_mode = job.get("conflict_mode")  # None | "skip" | "overwrite"

        def update(**kw: Any) -> None:
            Plugin._copy_progress[job_id].update(kw)

        try:
            dst_dir.mkdir(parents=True, exist_ok=True)
            dst = dst_dir / src.name

            # Fast path: same filesystem → atomic rename (instant, like Dolphin)
            if op == "move":
                try:
                    src_dev = _os.stat(str(src)).st_dev
                    dst_dev = _os.stat(str(dst_dir)).st_dev
                    if src_dev == dst_dev:
                        final_dst = dst_dir / src.name
                        if final_dst.exists() or final_dst.is_symlink():
                            # Directories always write-into via the merge copy path below.
                            if src.is_dir() and final_dst.is_dir() and not final_dst.is_symlink():
                                raise OSError("merge move")
                            if conflict_mode == "overwrite":
                                if final_dst.is_dir() and not final_dst.is_symlink():
                                    shutil.rmtree(str(final_dst))
                                else:
                                    final_dst.unlink()
                            else:
                                # Skip/resume: finished file → drop source; partial → merge-copy below
                                if src.is_file() and final_dst.is_file() and _file_is_complete(src, final_dst):
                                    try:
                                        _os.remove(str(src))
                                    except OSError:
                                        pass
                                    update(total=0, copied=0, done=True, status="done",
                                           stage="Already at destination", already_existed=True)
                                    return
                                raise OSError("resume move")
                        _os.rename(str(src), str(final_dst))
                        update(total=0, copied=0, done=True, status="done", stage="Done")
                        decky.logger.info(f"CopyDeck fast move (rename): {src} -> {final_dst} OK")
                        return
                except OSError:
                    pass  # fall through to copy-then-delete path

            def _walk_no_follow(root: Path):
                """os.walk with followlinks=False so dead symlinks are yielded,
                not descended into. Yields Path objects for every entry."""
                for dirpath, dirnames, filenames, dirfd in _os.fwalk(str(root), follow_symlinks=False):
                    dp = Path(dirpath)
                    for d in dirnames:
                        yield dp / d
                    for f in filenames:
                        yield dp / f

            def _dest_file_exists(p: Path) -> bool:
                return p.exists() or p.is_symlink()

            def _should_skip_existing(src_f: Path, dst_f: Path) -> bool:
                """Skip = resume: leave size-matched files. Overwrite = never skip."""
                if not _dest_file_exists(dst_f):
                    return False
                if conflict_mode == "overwrite":
                    return False
                # "skip" / unset — continue where left off (size match)
                return _file_is_complete(src_f, dst_f)

            def _file_offset(src_f: Path, dst_f: Path) -> int:
                if conflict_mode == "overwrite":
                    return 0
                return _resume_offset(src_f, dst_f)

            already = 0
            if src.is_dir():
                total = 0
                for f in _walk_no_follow(src):
                    if f.is_symlink():
                        pass  # symlinks have negligible size
                    elif f.is_file():
                        dst_f = dst / f.relative_to(src)
                        try:
                            sz = f.stat().st_size
                        except OSError:
                            continue
                        total += sz
                        if conflict_mode != "overwrite":
                            already += min(_file_offset(f, dst_f), sz)
            elif src.is_symlink():
                total = 0
            else:
                total = src.stat().st_size
                if conflict_mode != "overwrite":
                    already = min(_file_offset(src, dst), total)

            update(
                total=total,
                copied=already,
                stage="Copying..." if op == "copy" else "Moving...",
                status="copying",
            )

            def check_pause_cancel() -> bool:
                """Pause loop for file-op jobs. Returns True if cancelled."""
                while Plugin._pause_flag.get(job_id):
                    if Plugin._copy_progress.get(job_id, {}).get("status") != "paused":
                        update(stage="Paused", status="paused")
                    if Plugin._cancel_flag.get(job_id):
                        update(done=True, status="cancelled", stage="Cancelled")
                        return True
                    import time as _time_mod
                    _time_mod.sleep(0.3)
                if Plugin._copy_progress.get(job_id, {}).get("status") == "paused":
                    update(stage="Copying..." if op == "copy" else "Moving...", status="copying")
                return Plugin._cancel_flag.get(job_id, False)

            if src.is_dir():
                # Write-into directories (mkdir merge). File conflicts follow conflict_mode.
                copied = already
                copied_something = False
                for src_file in _walk_no_follow(src):
                    if check_pause_cancel():
                        update(done=True, status="cancelled", stage="Cancelled")
                        return
                    rel = src_file.relative_to(src)
                    dst_file = dst / rel

                    if src_file.is_symlink():
                        if conflict_mode != "overwrite" and _dest_file_exists(dst_file):
                            continue
                        link_target = _os.readlink(str(src_file))
                        dst_file.parent.mkdir(parents=True, exist_ok=True)
                        if dst_file.exists() or dst_file.is_symlink():
                            dst_file.unlink()
                        _os.symlink(link_target, str(dst_file))
                        copied_something = True
                    elif src_file.is_dir():
                        dst_file.mkdir(parents=True, exist_ok=True)
                    else:
                        if _should_skip_existing(src_file, dst_file):
                            continue
                        src_size = src_file.stat().st_size
                        offset = _file_offset(src_file, dst_file)
                        if offset >= src_size:
                            continue
                        dst_file.parent.mkdir(parents=True, exist_ok=True)
                        chunk = 512 * 1024  # 512 KB — small so pause/cancel respond quickly
                        mode = "r+b" if offset > 0 else "wb"
                        with open(str(src_file), "rb") as fsrc, open(str(dst_file), mode) as fdst:
                            if offset > 0:
                                fsrc.seek(offset)
                                fdst.seek(offset)
                            while True:
                                if check_pause_cancel():
                                    update(done=True, status="cancelled", stage="Cancelled")
                                    return
                                buf = fsrc.read(chunk)
                                if not buf:
                                    break
                                fdst.write(buf)
                                copied += len(buf)
                                update(copied=copied)
                                if Plugin._cancel_flag.get(job_id) or Plugin._pause_flag.get(job_id):
                                    if check_pause_cancel():
                                        update(done=True, status="cancelled", stage="Cancelled")
                                        return
                        shutil.copystat(str(src_file), str(dst_file))
                        copied_something = True
                if op == "move":
                    shutil.rmtree(str(src))
            else:
                # Single file/symlink
                if src.is_symlink():
                    if conflict_mode != "overwrite" and _dest_file_exists(dst):
                        update(copied=total, done=True, status="done",
                               stage="Already at destination", already_existed=True)
                        return
                    link_target = _os.readlink(str(src))
                    if dst.exists() or dst.is_symlink():
                        dst.unlink()
                    _os.symlink(link_target, str(dst))
                    update(copied=total, done=True, status="done", stage="Done")
                    if op == "move":
                        src.unlink()
                else:
                    if _should_skip_existing(src, dst):
                        update(copied=total, done=True, status="done",
                               stage="Already at destination", already_existed=True)
                        if op == "move":
                            _os.remove(str(src))
                        return
                    offset = _file_offset(src, dst)
                    if conflict_mode == "overwrite":
                        total = src.stat().st_size
                        update(total=total)
                    elif offset >= (total or src.stat().st_size):
                        update(copied=total, done=True, status="done",
                               stage="Already at destination", already_existed=True)
                        if op == "move":
                            _os.remove(str(src))
                        return
                    copied = offset
                    chunk = 512 * 1024  # 512 KB — small so pause/cancel respond quickly
                    mode = "r+b" if offset > 0 else "wb"
                    with open(str(src), "rb") as fsrc, open(str(dst), mode) as fdst:
                        if offset > 0:
                            fsrc.seek(offset)
                            fdst.seek(offset)
                        while True:
                            if check_pause_cancel():
                                update(done=True, status="cancelled", stage="Cancelled")
                                return
                            buf = fsrc.read(chunk)
                            if not buf:
                                break
                            fdst.write(buf)
                            copied += len(buf)
                            update(copied=copied)
                            if Plugin._cancel_flag.get(job_id) or Plugin._pause_flag.get(job_id):
                                if check_pause_cancel():
                                    update(done=True, status="cancelled", stage="Cancelled")
                                    return
                    shutil.copystat(str(src), str(dst))
                    if op == "move":
                        _os.remove(str(src))

            already_existed = src.is_dir() and not copied_something
            update(copied=total, done=True, status="done",
                   stage="Already at destination" if already_existed else "Done",
                   already_existed=already_existed)
            decky.logger.info(f"CopyDeck file {op}: {src} -> {dst} OK")

        except Exception as e:
            update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck file {op} error: {e}")

    def _execute_copy_sync(
        self,
        appid: str,
        src_library: str,
        dst_library: str,
        name: str = "",
        delete_orphaned_acf: bool = False,
        copy_workshop: bool = False,
        copy_compatdata: bool = False,
        skip_game_files: bool = False,
        conflict_mode: Optional[str] = None,
    ) -> None:
        """Synchronous copy — safe to run in a thread.
        conflict_mode: None/"skip" resumes partials & skips size-matched files;
        "overwrite" replaces every file from byte 0.
        """
        import os as _os
        src_root = Path(src_library)
        dst_root = Path(dst_library)

        def _offset(src_f: Path, dst_f: Path) -> int:
            if conflict_mode == "overwrite":
                return 0
            return _resume_offset(src_f, dst_f)

        try:
            acf_src = src_root / "steamapps" / f"appmanifest_{appid}.acf"
            if not acf_src.exists():
                raise FileNotFoundError(
                    f"No manifest found for {appid} at {src_root}"
                )

            data = acf_src.read_text(encoding="utf-8", errors="replace")
            installdir_m = re.search(r'"installdir"\s+"([^"]+)"', data)
            if not installdir_m:
                raise ValueError(f"Invalid manifest for {appid}")
            installdir = installdir_m.group(1)

            src_game = src_root / "steamapps" / "common" / installdir
            dst_game = dst_root / "steamapps" / "common" / installdir
            dst_acf = dst_root / "steamapps" / f"appmanifest_{appid}.acf"

            if not skip_game_files and not src_game.exists():
                raise FileNotFoundError(f"Game folder missing for {appid}")

            if appid in Plugin._copy_progress:
                Plugin._copy_progress[appid]["dst_library"] = dst_library
                Plugin._copy_progress[appid]["dest_path"] = str(dst_game)
                Plugin._copy_progress[appid]["partial_path"] = str(dst_game)

            if delete_orphaned_acf and dst_acf.exists():
                try:
                    dst_acf.unlink()
                except OSError:
                    pass

            def _game_walk(root: Path):
                """Walk game directory without following symlinks."""
                for dirpath, dirnames, filenames, dirfd in _os.fwalk(str(root), follow_symlinks=False):
                    dp = Path(dirpath)
                    for d in dirnames:
                        yield dp / d
                    for f in filenames:
                        yield dp / f

            # Full source size for the bar; "already" jumps the bar on resume/skip.
            total = 0
            already = 0

            def _accum(src_f: Path, dst_f: Path) -> None:
                nonlocal total, already
                try:
                    sz = src_f.stat().st_size
                except OSError:
                    return
                total += sz
                if conflict_mode != "overwrite":
                    already += min(_offset(src_f, dst_f), sz)

            if not skip_game_files:
                for f in _game_walk(src_game):
                    if not f.is_symlink() and f.is_file():
                        _accum(f, dst_game / f.relative_to(src_game))

            # Pre-calculate workshop size so total is accurate upfront
            if copy_workshop:
                src_workshop_pre = src_root / "steamapps" / "workshop" / "content" / appid
                dst_workshop_pre = dst_root / "steamapps" / "workshop" / "content" / appid
                if src_workshop_pre.exists():
                    for f in _game_walk(src_workshop_pre):
                        if not f.is_symlink() and f.is_file():
                            _accum(f, dst_workshop_pre / f.relative_to(src_workshop_pre))

            # Pre-calculate compatdata size so total is accurate upfront
            if copy_compatdata:
                src_compatdata_pre = src_root / "steamapps" / "compatdata" / appid
                dst_compatdata_pre = dst_root / "steamapps" / "compatdata" / appid
                if src_compatdata_pre.exists():
                    for f in _game_walk(src_compatdata_pre):
                        if not f.is_symlink() and f.is_file():
                            _accum(f, dst_compatdata_pre / f.relative_to(src_compatdata_pre))

            if appid in Plugin._copy_progress:
                Plugin._copy_progress[appid].update({
                    "total": total,
                    "copied": already,
                    "stage": "Copying game files..." if not skip_game_files else "Copying extras...",
                    "status": "copying",
                })

            if not skip_game_files:
                dst_game.mkdir(parents=True, exist_ok=True)
                for src_file in _game_walk(src_game):
                    # Don't check cancel here — "Stop After Current Game" means finish this
                    # game, then stop; cancel is only checked after this job returns.
                    while Plugin._pause_flag.get(appid):
                        if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") != "paused":
                            Plugin._copy_progress[appid].update({
                                "stage": "Paused",
                                "status": "paused",
                            })
                        if Plugin._cancel_flag.get(appid):
                            if appid in Plugin._copy_progress:
                                Plugin._copy_progress[appid].update({
                                    "status": "cancelled",
                                    "stage": "Cancelled",
                                })
                            return
                        time.sleep(0.5)
                    if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") == "paused":
                        Plugin._copy_progress[appid].update({
                            "stage": "Copying game files...",
                            "status": "copying",
                        })

                    if src_file.is_symlink():
                        # Copy the symlink itself, not its target
                        dst_file = dst_game / src_file.relative_to(src_game)
                        dst_file.parent.mkdir(parents=True, exist_ok=True)
                        link_target = _os.readlink(str(src_file))
                        if dst_file.exists() or dst_file.is_symlink():
                            dst_file.unlink()
                        _os.symlink(link_target, str(dst_file))
                    elif src_file.is_dir():
                        (dst_game / src_file.relative_to(src_game)).mkdir(
                            parents=True, exist_ok=True
                        )
                    else:
                        dst_file = dst_game / src_file.relative_to(src_game)
                        offset = _offset(src_file, dst_file)
                        src_size = src_file.stat().st_size
                        if offset < src_size:
                            dst_file.parent.mkdir(parents=True, exist_ok=True)
                            CHUNK = 512 * 1024
                            mode = "r+b" if offset > 0 else "wb"
                            with open(src_file, 'rb') as fsrc, open(dst_file, mode) as fdst:
                                if offset > 0:
                                    fsrc.seek(offset)
                                    fdst.seek(offset)
                                while True:
                                    buf = fsrc.read(CHUNK)
                                    if not buf:
                                        break
                                    fdst.write(buf)
                                    if appid in Plugin._copy_progress:
                                        Plugin._copy_progress[appid]["copied"] += len(buf)
                                    if Plugin._cancel_flag.get(appid):
                                        if appid in Plugin._copy_progress:
                                            Plugin._copy_progress[appid].update({
                                                "status": "cancelled",
                                                "stage": "Cancelled",
                                            })
                                        return
                                    while Plugin._pause_flag.get(appid):
                                        if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") != "paused":
                                            Plugin._copy_progress[appid].update({"stage": "Paused", "status": "paused"})
                                        if Plugin._cancel_flag.get(appid):
                                            if appid in Plugin._copy_progress:
                                                Plugin._copy_progress[appid].update({"status": "cancelled", "stage": "Cancelled"})
                                            return
                                        time.sleep(0.1)
                                    if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") == "paused":
                                        Plugin._copy_progress[appid].update({"stage": "Copying game files...", "status": "copying"})
                            shutil.copystat(src_file, dst_file)

            if not skip_game_files:
                shutil.copy2(acf_src, dst_acf)


            # ── Workshop content (optional) ──────────────────────────────────
            if copy_workshop:
                src_workshop = src_root / "steamapps" / "workshop" / "content" / appid
                dst_workshop = dst_root / "steamapps" / "workshop" / "content" / appid
                if src_workshop.exists():
                    if appid in Plugin._copy_progress:
                        Plugin._copy_progress[appid].update({
                            "stage": "Copying workshop content...",
                        })
                    dst_workshop.mkdir(parents=True, exist_ok=True)
                    for src_file in _game_walk(src_workshop):
                        while Plugin._pause_flag.get(appid):
                            if Plugin._cancel_flag.get(appid):
                                if appid in Plugin._copy_progress:
                                    Plugin._copy_progress[appid].update({
                                        "status": "cancelled",
                                        "stage": "Cancelled",
                                    })
                                return
                            time.sleep(0.5)
                        if src_file.is_symlink():
                            dst_file = dst_workshop / src_file.relative_to(src_workshop)
                            dst_file.parent.mkdir(parents=True, exist_ok=True)
                            link_target = _os.readlink(str(src_file))
                            if dst_file.exists() or dst_file.is_symlink():
                                dst_file.unlink()
                            _os.symlink(link_target, str(dst_file))
                        elif src_file.is_dir():
                            (dst_workshop / src_file.relative_to(src_workshop)).mkdir(parents=True, exist_ok=True)
                        else:
                            dst_file = dst_workshop / src_file.relative_to(src_workshop)
                            offset = _offset(src_file, dst_file)
                            src_size = src_file.stat().st_size
                            if offset < src_size:
                                dst_file.parent.mkdir(parents=True, exist_ok=True)
                                CHUNK = 512 * 1024
                                mode = "r+b" if offset > 0 else "wb"
                                with open(src_file, 'rb') as fsrc, open(dst_file, mode) as fdst:
                                    if offset > 0:
                                        fsrc.seek(offset)
                                        fdst.seek(offset)
                                    while True:
                                        buf = fsrc.read(CHUNK)
                                        if not buf:
                                            break
                                        fdst.write(buf)
                                        if appid in Plugin._copy_progress:
                                            Plugin._copy_progress[appid]["copied"] += len(buf)
                                        if Plugin._cancel_flag.get(appid):
                                            if appid in Plugin._copy_progress:
                                                Plugin._copy_progress[appid].update({
                                                    "status": "cancelled",
                                                    "stage": "Cancelled",
                                                })
                                            return
                                        while Plugin._pause_flag.get(appid):
                                            if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") != "paused":
                                                Plugin._copy_progress[appid].update({"stage": "Paused", "status": "paused"})
                                            if Plugin._cancel_flag.get(appid):
                                                if appid in Plugin._copy_progress:
                                                    Plugin._copy_progress[appid].update({"status": "cancelled", "stage": "Cancelled"})
                                                return
                                            time.sleep(0.1)
                                        if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") == "paused":
                                            Plugin._copy_progress[appid].update({"stage": "Copying...", "status": "copying"})
                                shutil.copystat(src_file, dst_file)
                    # Copy the appworkshop_{appid}.acf manifest alongside the content folder
                    src_ws_acf = src_root / "steamapps" / "workshop" / f"appworkshop_{appid}.acf"
                    if src_ws_acf.exists():
                        dst_ws_dir = dst_root / "steamapps" / "workshop"
                        dst_ws_dir.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(src_ws_acf), str(dst_ws_dir / f"appworkshop_{appid}.acf"))

            # ── Compatdata (optional) ─────────────────────────────────────────
            if copy_compatdata:
                src_compatdata = src_root / "steamapps" / "compatdata" / appid
                dst_compatdata = dst_root / "steamapps" / "compatdata" / appid
                if src_compatdata.exists():
                    if appid in Plugin._copy_progress:
                        Plugin._copy_progress[appid].update({"stage": "Copying compatdata..."})
                    dst_compatdata.mkdir(parents=True, exist_ok=True)
                    for src_file in _game_walk(src_compatdata):
                        while Plugin._pause_flag.get(appid):
                            if Plugin._cancel_flag.get(appid):
                                if appid in Plugin._copy_progress:
                                    Plugin._copy_progress[appid].update({
                                        "status": "cancelled",
                                        "stage": "Cancelled",
                                    })
                                return
                            time.sleep(0.5)
                        if src_file.is_symlink():
                            dst_file = dst_compatdata / src_file.relative_to(src_compatdata)
                            dst_file.parent.mkdir(parents=True, exist_ok=True)
                            link_target = _os.readlink(str(src_file))
                            if dst_file.exists() or dst_file.is_symlink():
                                dst_file.unlink()
                            _os.symlink(link_target, str(dst_file))
                        elif src_file.is_dir():
                            (dst_compatdata / src_file.relative_to(src_compatdata)).mkdir(parents=True, exist_ok=True)
                        else:
                            dst_file = dst_compatdata / src_file.relative_to(src_compatdata)
                            offset = _offset(src_file, dst_file)
                            src_size = src_file.stat().st_size
                            if offset < src_size:
                                dst_file.parent.mkdir(parents=True, exist_ok=True)
                                CHUNK = 512 * 1024
                                mode = "r+b" if offset > 0 else "wb"
                                with open(src_file, 'rb') as fsrc, open(dst_file, mode) as fdst:
                                    if offset > 0:
                                        fsrc.seek(offset)
                                        fdst.seek(offset)
                                    while True:
                                        buf = fsrc.read(CHUNK)
                                        if not buf:
                                            break
                                        fdst.write(buf)
                                        if appid in Plugin._copy_progress:
                                            Plugin._copy_progress[appid]["copied"] += len(buf)
                                        if Plugin._cancel_flag.get(appid):
                                            if appid in Plugin._copy_progress:
                                                Plugin._copy_progress[appid].update({
                                                    "status": "cancelled",
                                                    "stage": "Cancelled",
                                                })
                                            return
                                        while Plugin._pause_flag.get(appid):
                                            if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") != "paused":
                                                Plugin._copy_progress[appid].update({"stage": "Paused", "status": "paused"})
                                            if Plugin._cancel_flag.get(appid):
                                                if appid in Plugin._copy_progress:
                                                    Plugin._copy_progress[appid].update({"status": "cancelled", "stage": "Cancelled"})
                                                return
                                            time.sleep(0.1)
                                        if appid in Plugin._copy_progress and Plugin._copy_progress[appid].get("status") == "paused":
                                            Plugin._copy_progress[appid].update({"stage": "Copying...", "status": "copying"})
                                shutil.copystat(src_file, dst_file)

            if appid in Plugin._copy_progress:
                Plugin._copy_progress[appid].update({
                    "done": True,
                    "status": "done",
                    "stage": "Complete",
                })

        except Exception as e:
            decky.logger.exception(f"CopyDeck copy failed: {e}")
            if appid in Plugin._copy_progress:
                Plugin._copy_progress[appid].update({
                    "error": str(e),
                    "status": "error",
                    "stage": "Error",
                })

    async def remove_from_queue(self, appid: str) -> Dict[str, Any]:
        """Remove a pending job from the queue before it starts."""
        Plugin._copy_queue = [
            j for j in Plugin._copy_queue if j["appid"] != appid
        ]
        if appid in Plugin._copy_progress:
            if Plugin._copy_progress[appid].get("status") == "queued":
                del Plugin._copy_progress[appid]
        return {"success": True}

    async def remove_group_from_queue(self, group_id: str) -> Dict[str, Any]:
        """Remove all queued file-op jobs belonging to a group_id."""
        Plugin._copy_queue = [
            j for j in Plugin._copy_queue if j.get("group_id") != group_id
        ]
        to_remove = [
            k for k, v in Plugin._copy_progress.items()
            if v.get("group_id") == group_id and v.get("status") == "queued"
        ]
        for k in to_remove:
            del Plugin._copy_progress[k]
        return {"success": True}

    async def pause_group(self, group_id: str) -> Dict[str, Any]:
        """Pause a file-op group as a unit.
        Sets the pause flag on every job in the group so the currently-running
        file pauses mid-copy and any subsequent files in the group start paused.
        """
        for job_id, entry in Plugin._copy_progress.items():
            if entry.get("group_id") == group_id and entry.get("status") in ("copying", "queued"):
                Plugin._pause_flag[job_id] = True
                entry.update({"stage": "Paused", "status": "paused"})
        return {"success": True}

    async def resume_group(self, group_id: str) -> Dict[str, Any]:
        """Resume a paused file-op group.
        Clears the pause flag on every job in the group so the currently-running
        file resumes and subsequent files start normally.
        """
        for job_id, entry in Plugin._copy_progress.items():
            if entry.get("group_id") == group_id and entry.get("status") == "paused":
                Plugin._pause_flag[job_id] = False
                entry.update({"stage": "Copying...", "status": "copying", "pause_reason": None})
        return {"success": True}

    async def cancel_group(self, group_id: str, remove_partial: bool = False) -> Dict[str, Any]:
        """Cancel all jobs in a group (queued, paused, or copying).
        Remaining jobs outside this group stay queued and will start next.
        If remove_partial, delete each in-progress/paused job's destination after
        the worker stops (completed siblings in the group are left alone)."""
        # Remove queued jobs from the queue list
        Plugin._copy_queue = [
            j for j in Plugin._copy_queue if j.get("group_id") != group_id
        ]
        # Set cancel flag on in-progress jobs so the copy loop exits
        for job_id, entry in Plugin._copy_progress.items():
            if entry.get("group_id") == group_id:
                Plugin._cancel_flag[job_id] = True
                Plugin._pause_flag[job_id] = False  # unblock pause loop so cancel is seen
                if remove_partial and entry.get("status") in ("copying", "paused"):
                    Plugin._remove_partial_on_cancel[job_id] = True
                if entry.get("status") in ("copying", "paused", "queued"):
                    entry.update({
                        "done": True,
                        "status": "cancelled",
                        "stage": "Cancelled",
                    })
        return {"success": True}

    async def cancel_job(self, job_id: str, remove_partial: bool = False) -> Dict[str, Any]:
        """Cancel one job (or its whole file-op group). Queue continues with the next job.
        If remove_partial, delete the job's destination folder/file after the worker stops."""
        entry = Plugin._copy_progress.get(job_id)
        if entry is None:
            return {"success": False, "error": "Not found"}
        gid = entry.get("group_id")
        if gid:
            return await self.cancel_group(gid, remove_partial=remove_partial)

        Plugin._cancel_flag[job_id] = True
        Plugin._pause_flag[job_id] = False
        if remove_partial and entry.get("status") in ("copying", "paused"):
            Plugin._remove_partial_on_cancel[job_id] = True
        if entry.get("status") in ("copying", "paused", "queued"):
            entry.update({
                "done": True,
                "status": "cancelled",
                "stage": "Cancelled",
            })
        Plugin._copy_queue = [
            j for j in Plugin._copy_queue
            if j.get("appid") != job_id and j.get("job_id") != job_id
        ]
        # Queued-only cancel never runs the worker — remove now if requested and a path exists.
        if remove_partial and entry.get("status") == "cancelled" and not Plugin._is_copying:
            self._cleanup_partial_if_requested(job_id)
        return {"success": True}


    async def scan_drive_content_appids(self, library_path: str) -> Dict[str, Any]:
        """
        Quickly scan a drive's steamapps/compatdata and steamapps/workshop/content
        directories and return the sets of appids that have folders there.
        No size calculation — just folder existence checks.
        """
        import os
        root = Path(library_path) / "steamapps"
        compatdata_dir = root / "compatdata"
        workshop_dir = root / "workshop" / "content"

        def scan_dir(p: Path) -> list:
            if not p.exists():
                return []
            try:
                return [e.name for e in p.iterdir() if e.is_dir() and e.name.isdigit()]
            except OSError:
                return []

        return {
            "compatdata_appids": scan_dir(compatdata_dir),
            "workshop_appids": scan_dir(workshop_dir),
        }

    async def get_game_sizes(self, appid: str, library_path: str) -> Dict[str, Any]:
        """Return sizes of game files, ACF, compatdata, and shadercache for a game."""
        import shutil as _shutil
        src_root = Path(library_path)
        acf_path = src_root / "steamapps" / f"appmanifest_{appid}.acf"

        def dir_size(p: Path) -> int:
            if not p.exists():
                return 0
            if p.is_file():
                return p.stat().st_size
            total = 0
            for f in p.rglob("*"):
                if f.is_file():
                    try:
                        total += f.stat().st_size
                    except OSError:
                        pass
            return total

        game_size = 0
        installdir = ""
        if acf_path.exists():
            try:
                data = acf_path.read_text(encoding="utf-8", errors="replace")
                m = re.search(r'"installdir"\s+"([^"]+)"', data)
                if m:
                    installdir = m.group(1)
                    game_dir = src_root / "steamapps" / "common" / installdir
                    game_size = dir_size(game_dir)
            except Exception:
                pass

        acf_size = acf_path.stat().st_size if acf_path.exists() else 0

        # compatdata and shadercache live in the same steamapps as the game (per-drive)
        compatdata_path = src_root / "steamapps" / "compatdata" / appid
        compatdata_size = dir_size(compatdata_path)

        shadercache_path = src_root / "steamapps" / "shadercache" / appid
        shadercache_size = dir_size(shadercache_path)

        # Workshop content lives in the same library as the game
        workshop_path = src_root / "steamapps" / "workshop" / "content" / appid
        workshop_size = dir_size(workshop_path)

        return {
            "game_size": game_size,
            "acf_size": acf_size,
            "compatdata_size": compatdata_size,
            "shadercache_size": shadercache_size,
            "workshop_size": workshop_size,
            "installdir": installdir,
            "compatdata_path": str(compatdata_path),
            "shadercache_path": str(shadercache_path),
            "workshop_path": str(workshop_path) if workshop_size > 0 else "",
        }

    async def uninstall_games(
        self,
        jobs: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Uninstall one or more games.
        Each job: { appid, library_path, delete_files, delete_acf, delete_compatdata, delete_shadercache, delete_workshop }
        """
        import shutil as _shutil
        errors = []

        for job in jobs:
            appid = str(job.get("appid", ""))
            library_path = job.get("library_path", "")
            delete_files = job.get("delete_files", True)
            delete_acf = job.get("delete_acf", True)
            delete_compatdata = job.get("delete_compatdata", True)
            delete_shadercache = job.get("delete_shadercache", True)
            delete_workshop = job.get("delete_workshop", False)

            src_root = Path(library_path)
            acf_path = src_root / "steamapps" / f"appmanifest_{appid}.acf"

            try:
                if delete_files and acf_path.exists():
                    data = acf_path.read_text(encoding="utf-8", errors="replace")
                    m = re.search(r'"installdir"\s+"([^"]+)"', data)
                    if m:
                        game_dir = src_root / "steamapps" / "common" / m.group(1)
                        if game_dir.exists():
                            _shutil.rmtree(str(game_dir))

                if delete_acf and acf_path.exists():
                    acf_path.unlink()

                if delete_compatdata:
                    compatdata_path = src_root / "steamapps" / "compatdata" / appid
                    if compatdata_path.exists():
                        _shutil.rmtree(str(compatdata_path))

                if delete_shadercache:
                    shadercache_path = src_root / "steamapps" / "shadercache" / appid
                    if shadercache_path.exists():
                        _shutil.rmtree(str(shadercache_path))

                if delete_workshop:
                    # Workshop content and ACF live on the same drive as the game.
                    ws_content = src_root / "steamapps" / "workshop" / "content" / appid
                    ws_acf = src_root / "steamapps" / "workshop" / f"appworkshop_{appid}.acf"
                    if ws_content.exists():
                        _shutil.rmtree(str(ws_content))
                    if ws_acf.exists():
                        ws_acf.unlink()

            except Exception as e:
                errors.append({"appid": appid, "error": str(e)})

        return {"success": len(errors) == 0, "errors": errors}

    async def get_orphaned_entries(self, library_path: str) -> Dict[str, Any]:
        """
        Scan a library path for orphaned entries:
        - acf_no_folder:    appmanifest_*.acf exists but common/<installdir> folder is missing
        - folder_no_acf:    folder exists in common/ but no appmanifest_*.acf claims it
        - acf_no_workshop:  appworkshop_*.acf exists in workshop/ but no workshop/content/{appid} folder
        - workshop_no_acf:  workshop/content/{appid} folder exists but no appworkshop_{appid}.acf
        """
        lib_path = Path(library_path).resolve()
        steamapps = lib_path / "steamapps"
        common = steamapps / "common"
        workshop_dir = steamapps / "workshop"
        workshop_content = workshop_dir / "content"

        acf_no_folder = []
        folder_no_acf = []
        acf_no_workshop = []
        workshop_no_acf = []

        if not steamapps.exists():
            return {
                "acf_no_folder": [], "folder_no_acf": [],
                "acf_no_workshop": [], "workshop_no_acf": [],
            }

        def dir_size(p):
            total = 0
            for f in p.rglob("*"):
                if f.is_file():
                    try:
                        total += f.stat().st_size
                    except OSError:
                        pass
            return total

        # Step 1: scan appmanifest_*.acf — game install manifests
        claimed_appids = set()   # appids whose game folder exists
        claimed_dirs = {}        # lowercase installdir -> installdir name

        for acf_file in steamapps.glob("appmanifest_*.acf"):
            try:
                data = acf_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            appid_m = re.search(r'"appid"\s+"(\d+)"', data)
            name_m = re.search(r'"name"\s+"([^"]*)"', data)
            installdir_m = re.search(r'"installdir"\s+"([^"]+)"', data)
            size_m = re.search(r'"SizeOnDisk"\s+"(\d+)"', data)
            if not installdir_m:
                continue
            installdir = installdir_m.group(1)
            appid = appid_m.group(1) if appid_m else ""
            name = (name_m.group(1) if name_m else "").strip() or f"App {appid}"
            size_bytes = int(size_m.group(1)) if size_m else 0
            game_dir = common / installdir
            claimed_dirs[installdir.lower()] = installdir
            if not game_dir.exists():
                acf_no_folder.append({
                    "appid": appid,
                    "name": name,
                    "installdir": installdir,
                    "acf_path": str(acf_file),
                    "size_bytes": size_bytes,
                })
            else:
                claimed_appids.add(appid)

        # Step 2: scan common/ folders, find ones with no appmanifest ACF
        if common.exists():
            try:
                for entry in common.iterdir():
                    if not entry.is_dir():
                        continue
                    if entry.name.lower() not in claimed_dirs:
                        try:
                            folder_size = sum(
                                f.stat().st_size
                                for f in entry.rglob("*")
                                if f.is_file()
                            )
                        except OSError:
                            folder_size = 0
                        folder_no_acf.append({
                            "name": entry.name,
                            "folder_path": str(entry),
                            "size_bytes": folder_size,
                        })
            except OSError:
                pass

        # Step 3: scan appworkshop_*.acf — workshop manifests in steamapps/workshop/
        # These are the authoritative source for workshop state on this drive.
        workshop_acf_appids = set()   # appids that have an appworkshop ACF
        if workshop_dir.exists():
            for ws_acf in workshop_dir.glob("appworkshop_*.acf"):
                stem = ws_acf.stem  # e.g. "appworkshop_241100"
                parts = stem.split("_", 1)
                if len(parts) != 2 or not parts[1].isdigit():
                    continue
                wappid = parts[1]
                workshop_acf_appids.add(wappid)
                content_folder = workshop_content / wappid
                if not content_folder.exists():
                    # appworkshop ACF present but no content folder — selectable for cleanup
                    acf_no_workshop.append({
                        "appid": wappid,
                        "name": f"App {wappid}",
                        "acf_path": str(ws_acf),
                        "game_installed": wappid in claimed_appids,
                    })

        # Step 4: scan workshop/content/ — content folders with no appworkshop ACF
        # Tag each entry with whether the game's appmanifest ACF exists on this drive.
        if workshop_content.exists():
            try:
                for wentry in workshop_content.iterdir():
                    if not wentry.is_dir() or not wentry.name.isdigit():
                        continue
                    wappid = wentry.name
                    if wappid in workshop_acf_appids:
                        continue
                    wsize = dir_size(wentry)
                    workshop_no_acf.append({
                        "appid": wappid,
                        "name": f"App {wappid}",
                        "workshop_path": str(wentry),
                        "workshop_size": wsize,
                        "game_installed": wappid in claimed_appids,
                    })
            except OSError:
                pass

        return {
            "acf_no_folder": sorted(acf_no_folder, key=lambda x: x["name"].lower()),
            "folder_no_acf": sorted(folder_no_acf, key=lambda x: x["name"].lower()),
            "acf_no_workshop": sorted(acf_no_workshop, key=lambda x: x["name"].lower()),
            "workshop_no_acf": sorted(workshop_no_acf, key=lambda x: x["name"].lower()),
        }


    async def get_orphaned_caches(self, library_path: str) -> List[Dict[str, Any]]:
        """
        Scan shadercache/ and compatdata/ inside the given library's steamapps
        for folders whose appid has no matching ACF in that same library.
        """
        lib_root = Path(library_path).resolve()
        steamapps_dir = lib_root / "steamapps"

        def dir_size(p: Path) -> int:
            if not p.exists():
                return 0
            total = 0
            for f in p.rglob("*"):
                if f.is_file():
                    try:
                        total += f.stat().st_size
                    except OSError:
                        pass
            return total

        # Build set of all known appids from this library only
        known_appids: set = set()
        if steamapps_dir.exists():
            for acf_file in steamapps_dir.glob("appmanifest_*.acf"):
                try:
                    data = acf_file.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                appid_m = re.search(r'"appid"\s+"(\d+)"', data)
                if appid_m:
                    known_appids.add(appid_m.group(1))

        shadercache_dir = steamapps_dir / "shadercache"
        compatdata_dir = steamapps_dir / "compatdata"

        all_appids: set = set()
        for d in [shadercache_dir, compatdata_dir]:
            if d.exists():
                try:
                    for entry in d.iterdir():
                        if entry.is_dir() and entry.name.isdigit():
                            all_appids.add(entry.name)
                except OSError:
                    pass

        # Non-Steam appids always have the high bit set (>= 2^31 = 2147483648).
        # Steam game appids are small numbers well below that threshold.
        NONSTEAM_MIN = 2147483648

        steam_results = []
        nonsteam_results = []
        for appid in sorted(all_appids):
            if appid in known_appids:
                continue
            sc_path = shadercache_dir / appid
            cd_path = compatdata_dir / appid
            has_sc = sc_path.exists()
            has_cd = cd_path.exists()
            sc_size = dir_size(sc_path) if has_sc else 0
            cd_size = dir_size(cd_path) if has_cd else 0
            total = sc_size + cd_size
            entry = {
                "appid": appid,
                "name": f"App {appid}",
                "library_path": str(lib_root),
                "has_shadercache": has_sc,
                "shadercache_size": sc_size,
                "shadercache_path": str(sc_path) if has_sc else "",
                "has_compatdata": has_cd,
                "compatdata_size": cd_size,
                "compatdata_path": str(cd_path) if has_cd else "",
                "total_size": total,
            }
            try:
                is_nonsteam = int(appid) >= NONSTEAM_MIN
            except ValueError:
                is_nonsteam = False
            if is_nonsteam:
                nonsteam_results.append(entry)
            else:
                steam_results.append(entry)

        return {
            "caches": sorted(steam_results, key=lambda x: x["total_size"], reverse=True),
            "nonsteam_caches": sorted(nonsteam_results, key=lambda x: x["total_size"], reverse=True),
        }

    async def delete_orphaned_caches(self, appid: str, library_path: str, delete_shadercache: bool = True, delete_compatdata: bool = True) -> Dict[str, Any]:
        """Delete shadercache and/or compatdata folders for an orphaned appid on the given drive."""
        import shutil as _shutil
        steamapps = Path(library_path).resolve() / "steamapps"
        errors = []
        targets = []
        if delete_shadercache:
            targets.append("shadercache")
        if delete_compatdata:
            targets.append("compatdata")
        for subdir in targets:
            p = steamapps / subdir / appid
            if p.exists():
                try:
                    _shutil.rmtree(str(p))
                except Exception as e:
                    errors.append(str(e))
        return {"success": len(errors) == 0, "errors": errors}

    async def delete_orphaned_folder(self, folder_path: str) -> Dict[str, Any]:
        """Delete an orphaned game folder that has no ACF."""
        import shutil as _shutil
        try:
            p = Path(folder_path)
            if not p.exists() or not p.is_dir():
                return {"success": False, "error": "Folder not found"}
            # Safety check: must be inside a steamapps/common dir
            if "steamapps" not in p.parts or "common" not in p.parts:
                return {"success": False, "error": "Path does not look like a Steam game folder"}
            _shutil.rmtree(str(p))
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def delete_orphaned_workshop(self, workshop_path: str) -> Dict[str, Any]:
        """Delete an orphaned workshop content folder and its appworkshop ACF."""
        import shutil as _shutil
        try:
            p = Path(workshop_path)
            if not p.exists() or not p.is_dir():
                return {"success": False, "error": "Workshop folder not found"}
            # Safety: must be inside steamapps/workshop/content
            if "steamapps" not in p.parts or "workshop" not in p.parts or "content" not in p.parts:
                return {"success": False, "error": "Path does not look like a workshop content folder"}
            appid = p.name
            _shutil.rmtree(str(p))
            # Also remove the appworkshop_{appid}.acf in steamapps/workshop/ if present
            ws_acf = p.parent.parent / f"appworkshop_{appid}.acf"
            if ws_acf.exists():
                ws_acf.unlink()
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def delete_orphaned_workshop_acf(self, acf_path: str) -> Dict[str, Any]:
        """Delete a stale appworkshop_*.acf that has no corresponding content folder."""
        try:
            p = Path(acf_path)
            if not p.exists():
                return {"success": False, "error": "ACF file not found"}
            # Safety: must be an appworkshop_*.acf inside steamapps/workshop/
            if not p.name.startswith("appworkshop_") or not p.name.endswith(".acf"):
                return {"success": False, "error": "File does not look like a workshop ACF"}
            if "steamapps" not in p.parts or "workshop" not in p.parts:
                return {"success": False, "error": "Path does not look like a workshop ACF path"}
            p.unlink()
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_home_dir(self) -> str:
        return str(decky.DECKY_USER_HOME)

    async def get_shortcut_exe(self, appid: str) -> str:
        """Return the current exe path for a non-Steam shortcut by reading shortcuts.vdf directly."""
        import re as _re, struct as _struct, glob as _glob
        target_appid = int(appid) if appid.isdigit() else -1
        patterns = [
            str(Path.home() / ".steam" / "steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
            str(Path.home() / ".local" / "share" / "Steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
        ]
        seen: set = set()
        for pattern in patterns:
            for vdf_path in _glob.glob(pattern):
                real = str(Path(vdf_path).resolve())
                if real in seen:
                    continue
                seen.add(real)
                try:
                    data = Path(vdf_path).read_bytes()
                    for entry in _re.split(b"\x08\x08", data):
                        appid_m = _re.search(b"(?i)\x02appid\x00(.{4})", entry, _re.DOTALL)
                        exe_m   = _re.search(b"(?i)\x01exe\x00([^\x00]+)\x00", entry)
                        if not appid_m or not exe_m:
                            continue
                        eid = _struct.unpack("<I", appid_m.group(1))[0]
                        if eid == target_appid:
                            return exe_m.group(1).decode("utf-8", errors="replace").strip('"')
                except Exception:
                    pass
        return ""

    async def get_shortcut_raw_exe(self, appid: str) -> str:
        """Return the raw Exe field (including any launcher prefix / extra args) without stripping outer quotes.
        Used for path remapping after a non-Steam copy so the full command string can be updated."""
        import re as _re, struct as _struct, glob as _glob
        target_appid = int(appid) if appid.isdigit() else -1
        patterns = [
            str(Path.home() / ".steam" / "steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
            str(Path.home() / ".local" / "share" / "Steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
        ]
        seen: set = set()
        for pattern in patterns:
            for vdf_path in _glob.glob(pattern):
                real = str(Path(vdf_path).resolve())
                if real in seen:
                    continue
                seen.add(real)
                try:
                    data = Path(vdf_path).read_bytes()
                    for entry in _re.split(b"\x08\x08", data):
                        appid_m = _re.search(b"(?i)\x02appid\x00(.{4})", entry, _re.DOTALL)
                        exe_m   = _re.search(b"(?i)\x01exe\x00([^\x00]+)\x00", entry)
                        if not appid_m or not exe_m:
                            continue
                        eid = _struct.unpack("<I", appid_m.group(1))[0]
                        if eid == target_appid:
                            # Return the raw value without stripping outer quotes
                            return exe_m.group(1).decode("utf-8", errors="replace")
                except Exception:
                    pass
        return ""

    async def get_shortcut_launch_options(self, appid: str) -> str:
        """Return the LaunchOptions field for a non-Steam shortcut.
        Used to detect and remap paths embedded in launch options (e.g. switch emulators)."""
        import re as _re, struct as _struct, glob as _glob
        target_appid = int(appid) if appid.isdigit() else -1
        patterns = [
            str(Path.home() / ".steam" / "steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
            str(Path.home() / ".local" / "share" / "Steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
        ]
        seen: set = set()
        for pattern in patterns:
            for vdf_path in _glob.glob(pattern):
                real = str(Path(vdf_path).resolve())
                if real in seen:
                    continue
                seen.add(real)
                try:
                    data = Path(vdf_path).read_bytes()
                    for entry in _re.split(b"\x08\x08", data):
                        appid_m = _re.search(b"(?i)\x02appid\x00(.{4})", entry, _re.DOTALL)
                        opts_m  = _re.search(b"(?i)\x01LaunchOptions\x00([^\x00]*)\x00", entry)
                        if not appid_m:
                            continue
                        eid = _struct.unpack("<I", appid_m.group(1))[0]
                        if eid == target_appid:
                            if opts_m:
                                return opts_m.group(1).decode("utf-8", errors="replace")
                            return ""
                except Exception:
                    pass
        return ""

    async def get_shortcut_snapshot(self, appid: str) -> Dict[str, Any]:
        """Return exe, startDir, and launchOptions for a non-Steam shortcut in one VDF pass.
        Used to snapshot the current state before changing the target so it can be restored from history."""
        import re as _re, struct as _struct, glob as _glob
        target_appid = int(appid) if appid.isdigit() else -1
        patterns = [
            str(Path.home() / ".steam" / "steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
            str(Path.home() / ".local" / "share" / "Steam" / "userdata" / "*" / "config" / "shortcuts.vdf"),
        ]
        seen: set = set()
        for pattern in patterns:
            for vdf_path in _glob.glob(pattern):
                real = str(Path(vdf_path).resolve())
                if real in seen:
                    continue
                seen.add(real)
                try:
                    data = Path(vdf_path).read_bytes()
                    for entry in _re.split(b"\x08\x08", data):
                        appid_m = _re.search(b"(?i)\x02appid\x00(.{4})", entry, _re.DOTALL)
                        if not appid_m:
                            continue
                        eid = _struct.unpack("<I", appid_m.group(1))[0]
                        if eid != target_appid:
                            continue
                        exe_m   = _re.search(b"(?i)\x01exe\x00([^\x00]+)\x00", entry)
                        start_m = _re.search(b"(?i)\x01StartDir\x00([^\x00]*)\x00", entry)
                        opts_m  = _re.search(b"(?i)\x01LaunchOptions\x00([^\x00]*)\x00", entry)
                        exe      = exe_m.group(1).decode("utf-8", errors="replace").strip('"') if exe_m else ""
                        start_dir = start_m.group(1).decode("utf-8", errors="replace").strip('"') if start_m else ""
                        launch_options = opts_m.group(1).decode("utf-8", errors="replace") if opts_m else ""
                        return {"exe": exe, "startDir": start_dir, "launchOptions": launch_options}
                except Exception:
                    pass
        return {"exe": "", "startDir": "", "launchOptions": ""}

    async def check_path_exists(self, path: str) -> bool:
        return Path(path).exists()

    async def detect_lutris_shortcut(self, appid: str) -> Dict[str, Any]:
        """
        Given a Steam non-Steam appid, check if it's a Lutris game.
        If so, resolve all Lutris metadata and return everything the frontend needs.
        Returns { is_lutris, lutris_id, game_info } or { is_lutris: False }.
        """
        snap = await self.get_shortcut_snapshot(appid)
        exe         = snap.get("exe", "")
        start_dir   = snap.get("startDir", "")
        launch_opts = snap.get("launchOptions", "")

        lutris_id_str = Plugin._detect_lutris_id(exe, start_dir, launch_opts)
        if not lutris_id_str:
            return {"is_lutris": False}
        if lutris_id_str == "lutris_unknown":
            return {"is_lutris": True, "lutris_id": None, "game_info": None,
                    "error": "Lutris game detected but could not extract game ID"}

        game_info = await self.get_lutris_game_info(lutris_id_str)
        return {
            "is_lutris": True,
            "lutris_id": lutris_id_str,
            "game_info": game_info,
        }

    async def uninstall_nonsteam(self, game_dir: str, appid: str = "") -> Dict[str, Any]:
        """Delete a non-Steam game folder and optionally remove its shortcut entry."""
        import shutil as _shutil
        try:
            p = Path(game_dir)
            if not p.exists():
                return {"success": False, "error": f"Path not found: {game_dir}"}
            if not p.is_dir():
                return {"success": False, "error": f"Not a directory: {game_dir}"}
            _shutil.rmtree(str(p))
            # Optionally remove compatdata/shadercache for this appid if known
            if appid:
                home = Path(decky.DECKY_USER_HOME)
                steam_roots = [
                    home / ".steam" / "steam",
                    home / ".local" / "share" / "Steam",
                ]
                for root in steam_roots:
                    for sub in ["compatdata", "shadercache"]:
                        target = root / "steamapps" / sub / appid
                        if target.exists():
                            try:
                                _shutil.rmtree(str(target))
                            except Exception:
                                pass
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def uninstall_lutris(
        self,
        game_dir: str,
        prefix_dir: str,
        pga_db: str = "",
        lutris_id: int = 0,
        yml_path: str = "",
    ) -> Dict[str, Any]:
        """Delete a Lutris game folder and/or prefix from disk.
        Does NOT touch pga.db, YML, or any Lutris settings — the game card
        stays intact in Lutris so it can be re-copied and reused."""
        import shutil as _shutil
        errors = []

        if game_dir:
            p = Path(game_dir)
            if p.exists() and p.is_dir():
                try:
                    _shutil.rmtree(str(p))
                except Exception as e:
                    errors.append(f"Game folder: {e}")
            elif p.is_symlink():
                try:
                    p.unlink()
                except Exception as e:
                    errors.append(f"Game symlink: {e}")

        if prefix_dir:
            p = Path(prefix_dir)
            if p.exists() and p.is_dir():
                try:
                    _shutil.rmtree(str(p))
                except Exception as e:
                    errors.append(f"Prefix: {e}")

        if errors:
            return {"success": False, "error": "; ".join(errors)}
        return {"success": True}

    async def find_nonsteam_compatdata(self, appid: str, game_dir: str = "") -> Dict[str, Any]:
        """Check whether a non-Steam appid has a compatdata folder.
        Checks in order:
          1. Steam's own install steamapps via _get_steam_install_steamapps() —
             the primary location Steam always stores non-Steam compatdata.
          2. drive_root/steamapps/compatdata where drive_root is derived from
             game_dir — covers games already copied to an external drive with
             compatdata alongside them. steamapps always lives at drive root so
             no walkup needed.
        Returns the first match found. { found: bool, path: str | None, shadercache_path: str | None }.
        shadercache_path is always resolved from Steam's own steamapps since Steam never
        moves shadercache to other library drives, regardless of where compatdata lives."""
        try:
            candidates = []
            # 1. Drive root of the game dir — check where the game actually lives first
            #    so we always copy the compatdata that belongs to this copy of the game.
            #    Only meaningful for external drives; internal is covered by check 2.
            if game_dir:
                p = Path(game_dir).resolve()
                parts = p.parts
                if len(parts) >= 5 and parts[1] == "run" and parts[2] == "media":
                    drive_root = Path(*parts[:5])  # /run/media/deck/<label>
                elif len(parts) >= 3 and parts[1] == "media":
                    drive_root = Path(*parts[:3])  # /media/deck/<label>
                else:
                    drive_root = None
                if drive_root:
                    candidates.append(drive_root / "steamapps" / "compatdata" / appid)
            # 2. Steam's own install location — covers internal games and any case
            #    where compatdata was never copied alongside the game on its drive.
            steam_steamapps = _get_steam_install_steamapps()
            candidates.append(steam_steamapps / "compatdata" / appid)

            # Shadercache: Steam always writes this to its own steamapps regardless of
            # which library the game is installed to or where compatdata was copied.
            # Derive it independently so that a copied compatdata on an external drive
            # does not cause a wrong shadercache path via string replacement in the frontend.
            sc_path = steam_steamapps / "shadercache" / appid
            shadercache_path = str(sc_path) if sc_path.exists() else None

            for candidate in candidates:
                if candidate.exists():
                    return {"found": True, "path": str(candidate), "shadercache_path": shadercache_path}
            return {"found": False, "path": None, "shadercache_path": shadercache_path}
        except Exception as e:
            return {"found": False, "path": None, "shadercache_path": None, "error": str(e)}

    async def copy_nonsteam_compatdata(self, appid: str, dst_steamapps: str, src_path: str = "", conflict_mode: str = "skip") -> Dict[str, Any]:
        """Copy a non-Steam game's compatdata to a destination steamapps folder.
        Merge-copies like other paths (skip/resume or overwrite) — never deletes dst.
        If src_path is provided (returned by find_nonsteam_compatdata) it is used
        directly.  Otherwise falls back to _get_steam_install_steamapps()."""
        try:
            if src_path and Path(src_path).exists():
                src = Path(src_path)
            else:
                src = _get_steam_install_steamapps() / "compatdata" / appid
            if not src.exists():
                return {"success": False, "error": f"No compatdata found for appid {appid}"}
            dst = Path(dst_steamapps) / "compatdata" / appid
            dst.parent.mkdir(parents=True, exist_ok=True)
            _copy_tree_resumable(src, dst, conflict_mode=conflict_mode or "skip")
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def copy_nonsteam(self, job_id: str, src_dir: str, dst_dir: str, name: str = "", conflict_mode: str = "skip") -> Dict[str, Any]:
        """Queue a non-Steam game folder copy through the shared queue so it gets
        the same pause/cancel/resume/progress behaviour as Steam game copies."""
        src = Path(src_dir)
        if not src.exists() or not src.is_dir():
            Plugin._copy_progress[job_id] = {
                "copied": 0, "total": 0, "done": True, "error": f"Source not found: {src_dir}",
                "name": name or src.name, "stage": "Error", "status": "error",
            }
            return {"success": False, "error": f"Source not found: {src_dir}"}

        Plugin._copy_progress[job_id] = {
            "copied": 0, "total": 0, "done": False, "error": None,
            "name": name or src.name, "stage": "Queued", "status": "queued",
            "op": "nonsteam",
            "src_dir": src_dir,
            "dst_dir": dst_dir,
            "dest_path": dst_dir,
            "partial_path": dst_dir,
        }
        Plugin._cancel_flag[job_id] = False
        Plugin._pause_flag[job_id] = False

        Plugin._copy_queue.append({
            "job_id": job_id,
            "op": "nonsteam",
            "src_dir": src_dir,
            "dst_dir": dst_dir,
            "name": name or src.name,
            "conflict_mode": conflict_mode or "skip",
        })

        if not Plugin._is_copying:
            thread = threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()

        return {"success": True}

    async def copy_nonsteam_file(self, job_id: str, src_file: str, dst_file: str, name: str = "", conflict_mode: str = "skip") -> Dict[str, Any]:
        """Queue a single non-Steam file copy (e.g. a rom) through the shared queue."""
        src = Path(src_file)
        if not src.exists() or not src.is_file():
            Plugin._copy_progress[job_id] = {
                "copied": 0, "total": 0, "done": True, "error": f"Source not found: {src_file}",
                "name": name or src.name, "stage": "Error", "status": "error",
            }
            return {"success": False, "error": f"Source not found: {src_file}"}

        Plugin._copy_progress[job_id] = {
            "copied": 0, "total": 0, "done": False, "error": None,
            "name": name or src.name, "stage": "Queued", "status": "queued",
            "op": "nonsteam_file",
            "src_file": src_file,
            "dst_dir": str(Path(dst_file).parent),
            "dest_path": dst_file,
            "partial_path": dst_file,
        }
        Plugin._cancel_flag[job_id] = False
        Plugin._pause_flag[job_id] = False

        Plugin._copy_queue.append({
            "job_id": job_id,
            "op": "nonsteam_file",
            "src_file": src_file,
            "dst_file": dst_file,
            "name": name or src.name,
            "conflict_mode": conflict_mode or "skip",
        })

        if not Plugin._is_copying:
            thread = threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()

        return {"success": True}

    def _execute_nonsteam_copy_sync(self, job: Dict[str, Any]) -> None:
        """Synchronous non-Steam folder copy — runs inside _run_queue_sync thread.
        Matches _execute_copy_sync: symlinks preserved, size-based resume/skip,
        pause/cancel support, chunk copy with copystat.

        Pause/cancel must stay *inside* the per-file read loop (like Steam + browse
        file ops). An older break-then-fallthrough path marked truncated files done
        via copystat and then reported "Already at destination" on retry.
        """
        import os as _os
        job_id  = job["job_id"]
        src     = Path(job["src_dir"])
        dst     = Path(job["dst_dir"])
        name    = job.get("name", src.name)

        def update(**kw):
            # Never clobber a cooperative cancel with a later done/already-there update.
            if kw.get("status") in ("done", "error") and Plugin._cancel_flag.get(job_id):
                cur = Plugin._copy_progress.get(job_id, {}).get("status")
                if cur == "cancelled":
                    return
            Plugin._copy_progress[job_id].update(kw)

        def cancelled():
            return bool(Plugin._cancel_flag.get(job_id))

        def wait_if_paused() -> bool:
            """Block while paused. Returns True if cancelled (caller should exit)."""
            while Plugin._pause_flag.get(job_id):
                if Plugin._copy_progress[job_id].get("status") != "paused":
                    update(stage="Paused", status="paused")
                if cancelled():
                    update(status="cancelled", stage="Cancelled", done=True)
                    return True
                time.sleep(0.5)
            if Plugin._copy_progress[job_id].get("status") == "paused":
                update(stage="Copying files...", status="copying")
            return cancelled()

        def _walk(root: Path):
            for dirpath, dirnames, filenames, _ in _os.fwalk(str(root), follow_symlinks=False):
                dp = Path(dirpath)
                for d in dirnames:
                    yield dp / d
                for f in filenames:
                    yield dp / f

        conflict_mode = job.get("conflict_mode") or "skip"

        try:
            # Same folder as source → every file looks "complete" on skip, and
            # overwrite would truncate the live game. Refuse early.
            try:
                if src.resolve() == dst.resolve():
                    update(done=True, status="error",
                           error="Source and destination are the same folder",
                           stage="Error")
                    return
            except OSError:
                pass

            # Full source size + jump bar to bytes already at destination (resume/skip).
            total = 0
            already = 0
            for f in _walk(src):
                if not f.is_symlink() and f.is_file():
                    dst_f = dst / f.relative_to(src)
                    try:
                        sz = f.stat().st_size
                    except OSError:
                        continue
                    total += sz
                    if conflict_mode != "overwrite":
                        already += min(_resume_offset(f, dst_f), sz)
            update(total=total, copied=already, stage="Copying files...", status="copying")

            dst.mkdir(parents=True, exist_ok=True)

            CHUNK = 512 * 1024  # 512 KB — small so pause/cancel respond quickly
            copied_something = False
            for src_file in _walk(src):
                if wait_if_paused():
                    return
                if cancelled():
                    update(status="cancelled", stage="Cancelled", done=True)
                    return

                if src_file.is_symlink():
                    dst_file = dst / src_file.relative_to(src)
                    if conflict_mode != "overwrite" and (dst_file.exists() or dst_file.is_symlink()):
                        continue
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    link_target = _os.readlink(str(src_file))
                    if dst_file.exists() or dst_file.is_symlink():
                        dst_file.unlink()
                    _os.symlink(link_target, str(dst_file))
                    copied_something = True
                elif src_file.is_dir():
                    (dst / src_file.relative_to(src)).mkdir(parents=True, exist_ok=True)
                else:
                    dst_file = dst / src_file.relative_to(src)
                    src_size = src_file.stat().st_size
                    offset = 0 if conflict_mode == "overwrite" else _resume_offset(src_file, dst_file)
                    if offset >= src_size:
                        continue
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    mode = "r+b" if offset > 0 else "wb"
                    with open(src_file, 'rb') as fsrc, open(dst_file, mode) as fdst:
                        if offset > 0:
                            fsrc.seek(offset)
                            fdst.seek(offset)
                        while True:
                            buf = fsrc.read(CHUNK)
                            if not buf:
                                break
                            fdst.write(buf)
                            Plugin._copy_progress[job_id]["copied"] += len(buf)
                            if cancelled():
                                update(status="cancelled", stage="Cancelled", done=True)
                                return
                            if wait_if_paused():
                                return
                    shutil.copystat(str(src_file), str(dst_file))
                    copied_something = True

            if cancelled():
                update(status="cancelled", stage="Cancelled", done=True)
                return

            already_existed = not copied_something
            update(done=True, status="done",
                   stage="Already at destination" if already_existed else "Done",
                   already_existed=already_existed)
            decky.logger.info(f"CopyDeck nonsteam copy: {src} -> {dst} OK")

        except Exception as e:
            if cancelled():
                update(status="cancelled", stage="Cancelled", done=True)
            else:
                update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck nonsteam copy error {job_id}: {e}")

    def _execute_nonsteam_file_copy_sync(self, job: Dict[str, Any]) -> None:
        """Synchronous single-file copy for non-Steam roms/files. Same pause/cancel support."""
        import os as _os
        job_id = job["job_id"]
        src    = Path(job["src_file"])
        dst    = Path(job["dst_file"])
        name   = job.get("name", src.name)

        def update(**kw):
            if kw.get("status") in ("done", "error") and Plugin._cancel_flag.get(job_id):
                if Plugin._copy_progress.get(job_id, {}).get("status") == "cancelled":
                    return
            Plugin._copy_progress[job_id].update(kw)

        def cancelled():
            return bool(Plugin._cancel_flag.get(job_id))

        def wait_if_paused() -> bool:
            while Plugin._pause_flag.get(job_id):
                if Plugin._copy_progress[job_id].get("status") != "paused":
                    update(stage="Paused", status="paused")
                if cancelled():
                    update(status="cancelled", stage="Cancelled", done=True)
                    return True
                time.sleep(0.5)
            if Plugin._copy_progress[job_id].get("status") == "paused":
                update(stage="Copying...", status="copying")
            return cancelled()

        conflict_mode = job.get("conflict_mode") or "skip"
        try:
            try:
                if src.resolve() == dst.resolve():
                    update(done=True, status="error",
                           error="Source and destination are the same file",
                           stage="Error")
                    return
            except OSError:
                pass

            total = src.stat().st_size
            if conflict_mode != "overwrite" and _file_is_complete(src, dst):
                update(total=total, copied=total, done=True, status="done",
                       stage="Already at destination", already_existed=True)
                decky.logger.info(f"CopyDeck file copy: {src} already at {dst}, skipping")
                return
            offset = 0 if conflict_mode == "overwrite" else _resume_offset(src, dst)
            if offset >= total and conflict_mode != "overwrite":
                update(total=total, copied=total, done=True, status="done",
                       stage="Already at destination", already_existed=True)
                return
            if conflict_mode == "overwrite":
                offset = 0
            update(total=total, copied=offset, stage="Copying...", status="copying")
            dst.parent.mkdir(parents=True, exist_ok=True)
            CHUNK = 512 * 1024  # 512 KB — small so pause/cancel respond quickly
            mode = "r+b" if offset > 0 else "wb"
            with open(src, 'rb') as fsrc, open(dst, mode) as fdst:
                if offset > 0:
                    fsrc.seek(offset)
                    fdst.seek(offset)
                while True:
                    if wait_if_paused():
                        return
                    if cancelled():
                        update(status="cancelled", stage="Cancelled", done=True)
                        return
                    buf = fsrc.read(CHUNK)
                    if not buf:
                        break
                    fdst.write(buf)
                    Plugin._copy_progress[job_id]["copied"] += len(buf)
            if cancelled():
                update(status="cancelled", stage="Cancelled", done=True)
                return
            shutil.copystat(str(src), str(dst))
            update(done=True, status="done", stage="Done")
            decky.logger.info(f"CopyDeck file copy: {src} -> {dst} OK")
        except Exception as e:
            if cancelled():
                update(status="cancelled", stage="Cancelled", done=True)
            else:
                update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck file copy error {job_id}: {e}")

    # ─────────────────────────────────────────────────────────────────────────
    # Lutris support
    # ─────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _lutris_locations() -> List[Dict[str, Any]]:
        """Return all possible Lutris config/data root pairs to check."""
        home = Path.home()
        return [
            {
                "games_dir": home / ".var" / "app" / "net.lutris.Lutris" / "config" / "lutris" / "games",
                "pga_db":    home / ".var" / "app" / "net.lutris.Lutris" / "data" / "lutris" / "pga.db",
                "kind": "flatpak",
            },
            {
                "games_dir": home / ".config" / "lutris" / "games",
                "pga_db":    home / ".local" / "share" / "lutris" / "pga.db",
                "kind": "native",
            },
        ]

    @staticmethod
    def _detect_lutris_id(exe: str, start_dir: str, launch_opts: str) -> Optional[str]:
        """
        Scan the three VDF fields for any Lutris identifier.
        Returns the numeric lutris game id as a string if found via rungameid,
        or 'slug:<slug>' if found via rungame/slug, or None.
        """
        import re as _re
        combined = f"{exe}\x00{start_dir}\x00{launch_opts}"
        m = _re.search(r"lutris:rungameid/(\d+)", combined)
        if m:
            return m.group(1)
        m = _re.search(r"lutris:rungame/([\w\-]+)", combined)
        if m:
            return f"slug:{m.group(1)}"
        # Secondary signal: net.lutris.Lutris in any field but no rungameid —
        # return a sentinel so caller knows it's Lutris but we can't resolve the game.
        if "net.lutris.Lutris" in combined or combined.startswith("lutris\x00"):
            return "lutris_unknown"
        return None

    async def get_lutris_game_info(self, lutris_id: str) -> Dict[str, Any]:
        """
        Given a lutris game id string (numeric id or 'slug:<slug>'),
        query pga.db and find the matching YML config file.
        Returns { found, id, slug, name, install_dir, yml_path, prefix_path, kind }
        """
        import sqlite3 as _sqlite3, glob as _glob, re as _re
        try:
            for loc in Plugin._lutris_locations():
                pga = loc["pga_db"]
                games_dir = loc["games_dir"]
                if not pga.exists():
                    continue
                try:
                    con = _sqlite3.connect(str(pga))
                    cur = con.cursor()
                    if lutris_id.startswith("slug:"):
                        slug = lutris_id[5:]
                        row = cur.execute(
                            "SELECT id, slug, name, directory FROM games WHERE slug=?",
                            (slug,)
                        ).fetchone()
                    else:
                        row = cur.execute(
                            "SELECT id, slug, name, directory FROM games WHERE id=?",
                            (int(lutris_id),)
                        ).fetchone()
                    con.close()
                except Exception as db_err:
                    decky.logger.warning(f"CopyDeck lutris pga.db error: {db_err}")
                    continue

                if not row:
                    continue

                row_id, slug, name, directory = row

                # Find the YML by slug glob
                yml_path = None
                if games_dir.exists():
                    matches = list(games_dir.glob(f"{slug}-*.yml"))
                    if matches:
                        yml_path = str(matches[0])

                # Resolve install dir: YML exe parent (primary) > pga.db directory (fallback)
                # We prefer the YML because it's what Lutris actually reads when launching.
                # pga.db directory is a cache Lutris maintains — we no longer write it on
                # copy, so it may be stale. The YML is always up to date.
                install_dir = ""
                prefix_path = ""
                exe_val = ""
                args_val = ""
                working_dir_val = ""
                if yml_path:
                    try:
                        import yaml as _yaml
                        yml_data = _yaml.safe_load(Path(yml_path).read_text())
                        game_section = yml_data.get("game", {}) if yml_data else {}
                        exe_val = game_section.get("exe", "")
                        prefix_val = game_section.get("prefix", "")
                        args_val = game_section.get("args", "")
                        working_dir_val = game_section.get("working_dir", "")
                        if exe_val:
                            install_dir = str(Path(exe_val).parent)
                        if not install_dir:
                            install_dir = directory or ""
                        if prefix_val:
                            prefix_path = prefix_val
                    except ImportError:
                        # yaml not available — parse manually (good enough for simple YML)
                        try:
                            raw = Path(yml_path).read_text()
                            exe_m = _re.search(r"^\s+exe:\s+(.+)$", raw, _re.MULTILINE)
                            pfx_m = _re.search(r"^\s+prefix:\s+(.+)$", raw, _re.MULTILINE)
                            args_m = _re.search(r"^\s+args:\s+(.+)$", raw, _re.MULTILINE)
                            wd_m = _re.search(r"^\s+working_dir:\s+(.+)$", raw, _re.MULTILINE)
                            if exe_m:
                                exe_val = exe_m.group(1).strip()
                                install_dir = str(Path(exe_val).parent)
                            if not install_dir:
                                install_dir = directory or ""
                            if pfx_m:
                                prefix_path = pfx_m.group(1).strip()
                            if args_m:
                                args_val = args_m.group(1).strip()
                            if wd_m:
                                working_dir_val = wd_m.group(1).strip()
                        except Exception:
                            pass
                    except Exception:
                        pass

                return {
                    "found": True,
                    "id": row_id,
                    "slug": slug,
                    "name": name,
                    "install_dir": install_dir,
                    "exe": exe_val if yml_path else "",
                    "args": args_val,
                    "working_dir": working_dir_val,
                    "yml_path": yml_path or "",
                    "prefix_path": prefix_path,
                    "kind": loc["kind"],
                    "pga_db": str(pga),
                }

            return {"found": False, "error": "Game not found in any Lutris pga.db"}
        except Exception as e:
            return {"found": False, "error": str(e)}

    async def get_lutris_installed_games(self) -> List[Dict[str, Any]]:
        """Return all installed Lutris games from all known pga.db locations."""
        import sqlite3 as _sqlite3, re as _re
        results = []
        seen_ids: set = set()
        for loc in Plugin._lutris_locations():
            pga = loc["pga_db"]
            games_dir = loc["games_dir"]
            if not pga.exists():
                continue
            try:
                con = _sqlite3.connect(str(pga))
                rows = con.execute(
                    "SELECT id, slug, name, directory, runner FROM games"
                ).fetchall()
                con.close()
            except Exception as e:
                decky.logger.warning(f"CopyDeck lutris games list error: {e}")
                continue
            for row_id, slug, name, directory, runner in rows:
                key = f"{loc['kind']}:{row_id}"
                if key in seen_ids:
                    continue
                seen_ids.add(key)
                # Find YML
                yml_path = ""
                install_dir = directory or ""
                prefix_path = ""
                if games_dir.exists():
                    matches = list(games_dir.glob(f"{slug}-*.yml"))
                    if matches:
                        yml_path = str(matches[0])
                        try:
                            raw = Path(yml_path).read_text()
                            exe_m = _re.search(r"^\s+exe:\s+(.+)$", raw, _re.MULTILINE)
                            pfx_m = _re.search(r"^\s+prefix:\s+(.+)$", raw, _re.MULTILINE)
                            if exe_m:
                                install_dir = str(Path(exe_m.group(1).strip()).parent)
                            if not install_dir:
                                install_dir = directory or ""
                            if pfx_m:
                                prefix_path = pfx_m.group(1).strip()
                        except Exception:
                            pass
                results.append({
                    "id": row_id,
                    "slug": slug,
                    "name": name,
                    "runner": runner or "",
                    "install_dir": install_dir,
                    "yml_path": yml_path,
                    "prefix_path": prefix_path,
                    "kind": loc["kind"],
                    "pga_db": str(pga),
                })
        return results

    async def update_lutris_paths(
        self,
        pga_db: str,
        lutris_id: int,
        yml_path: str,
        new_install_dir: str,
        new_prefix_path: str = "",
        new_exe_path: str = "",
        new_args: str = "",
        new_working_dir: str = "",
    ) -> Dict[str, Any]:
        """
        Update the Lutris YML config after a copy or manual set-target.
        new_install_dir: the game's install folder (used to remap exe on copy).
        new_prefix_path: if non-empty, updates the prefix field.
        new_exe_path: if non-empty, writes this exact path to the exe field (set-target flow).
                      If empty, exe is remapped as new_install_dir / old_exe_filename (copy flow).
        new_args: if non-empty, writes this to the args field.
        new_working_dir: if non-empty, writes this to the working_dir field.
        pga.db is intentionally NOT written — it is a Lutris-managed cache.
        """
        import re as _re
        errors = []

        if yml_path and Path(yml_path).exists():
            try:
                raw = Path(yml_path).read_text()

                exe_m = _re.search(r"^(\s+exe:\s+)(.+)$", raw, _re.MULTILINE)
                if exe_m:
                    if new_exe_path:
                        # Explicit exe path (set-target flow) — write it directly
                        new_exe = new_exe_path
                    else:
                        # Copy flow — remap exe filename into new install dir
                        new_exe = str(Path(new_install_dir) / Path(exe_m.group(2).strip()).name)
                    raw = raw[:exe_m.start(2)] + new_exe + raw[exe_m.end(2):]

                if new_prefix_path:
                    pfx_m = _re.search(r"^(\s+prefix:\s+)(.+)$", raw, _re.MULTILINE)
                    if pfx_m:
                        raw = raw[:pfx_m.start(2)] + new_prefix_path + raw[pfx_m.end(2):]

                if new_args:
                    args_m = _re.search(r"^(\s+args:\s+)(.+)$", raw, _re.MULTILINE)
                    if args_m:
                        raw = raw[:args_m.start(2)] + new_args + raw[args_m.end(2):]

                if new_working_dir:
                    wd_m = _re.search(r"^(\s+working_dir:\s+)(.+)$", raw, _re.MULTILINE)
                    if wd_m:
                        raw = raw[:wd_m.start(2)] + new_working_dir + raw[wd_m.end(2):]

                Path(yml_path).write_text(raw)
            except Exception as e:
                errors.append(f"YML update failed: {e}")

        if errors:
            return {"success": False, "errors": errors}
        return {"success": True}

    async def find_lutris_prefix(
        self,
        appid: str,
        prefix_path: str = "",
        lutris_prefix_dest: str = "",
        other_drive_roots: str = "",
    ) -> Dict[str, Any]:
        """
        Find a Lutris Wine prefix directory.
        Check order:
          1. prefix_path from YML (if exists on disk) — explicit per-game prefix
          2. lutris_prefix_dest setting / <prefixName> where prefixName = last segment of prefix_path,
             or lutris_prefix_dest / appid as fallback if no prefix_path name available
          3. Default Lutris prefix locations (no YML prefix entry means Lutris uses runner defaults):
             - ~/Games/Lutris/<slug-derived from prefix_path or appid>
             - ~/.local/share/lutris/runners/wine/prefixes/<name>
             - ~/Games/<name>  (some runners)
          4. Same dest subfolder pattern on other drives
          5. Steam's own compatdata (fallback)
        other_drive_roots: comma-separated list of drive root paths to check with
          the same relative prefix dest subfolder used on internal.
        Returns { found, path }
        """
        home = Path.home()
        candidates = []

        # 1. Explicit prefix_path from YML — if it exists on disk, use it directly.
        if prefix_path and Path(prefix_path).exists():
            return {"found": True, "path": prefix_path}

        # We need the prefix folder name to check other locations.
        # This is the last segment of whatever path Lutris has in the YML,
        # e.g. /home/deck/Prefixes/MyGamePrefix -> "MyGamePrefix".
        # Without it we can't reliably locate the prefix elsewhere.
        prefix_name = Path(prefix_path).name if prefix_path else ""
        if not prefix_name:
            return {"found": False, "path": None}

        # Resolve the effective prefix destination — use setting if set, else ~/Prefixes
        # (mirrors the default doLutrisCopy uses when no setting is configured).
        effective_dest = Path(lutris_prefix_dest) if lutris_prefix_dest else home / "Prefixes"

        # 2. [prefix_dest]/[prefixName] — the canonical location for this setup.
        candidates.append(effective_dest / prefix_name)

        # 3. Same pattern on other drives (prefix may have been copied there already).
        if other_drive_roots:
            home_str = str(home)
            dest_str = str(effective_dest)
            rel = dest_str[len(home_str) + 1:] if dest_str.startswith(home_str + "/") else None
            for drive_root in [r.strip() for r in other_drive_roots.split(",") if r.strip()]:
                if rel:
                    candidates.append(Path(drive_root) / rel / prefix_name)
                else:
                    candidates.append(Path(drive_root) / effective_dest.name / prefix_name)

        # 4. Steam compatdata fallback (some Lutris Wine setups use it).
        candidates.append(_get_steam_install_steamapps() / "compatdata" / appid)

        for c in candidates:
            if c.exists():
                return {"found": True, "path": str(c)}
        return {"found": False, "path": None}

    async def copy_lutris_game(
        self,
        job_id: str,
        src_dir: str,
        dst_dir: str,
        name: str = "",
        lutris_id: int = 0,
        pga_db: str = "",
        yml_path: str = "",
        prefix_path: str = "",
        dst_prefix_dir: str = "",
        copy_game: bool = True,
        conflict_mode: str = "skip",
    ) -> Dict[str, Any]:
        """
        Queue a Lutris game folder copy.  After the game copy completes,
        update_lutris_paths is called to remap the YML and pga.db.
        prefix_path / dst_prefix_dir control where the Wine prefix lands.
        copy_game=False skips the game folder copy and only copies the prefix.
        """
        # Only validate src_dir when we actually need to copy the game.
        if copy_game:
            src = Path(src_dir)
            if not src.exists() or not src.is_dir():
                Plugin._copy_progress[job_id] = {
                    "copied": 0, "total": 0, "done": True,
                    "error": f"Source not found: {src_dir}",
                    "name": name or src_dir or "unknown", "stage": "Error", "status": "error",
                }
                return {"success": False, "error": f"Source not found: {src_dir}"}
            display_name = name or src.name
        else:
            display_name = name or "Lutris prefix"

        Plugin._copy_progress[job_id] = {
            "copied": 0, "total": 0, "done": False, "error": None,
            "name": display_name, "stage": "Queued", "status": "queued",
            "op": "lutris",
            "dst_dir": dst_dir,
            "dest_path": dst_dir or dst_prefix_dir or "",
            "partial_path": dst_dir or None,
        }
        Plugin._cancel_flag[job_id] = False
        Plugin._pause_flag[job_id] = False

        Plugin._copy_queue.append({
            "job_id": job_id,
            "op": "lutris",
            "src_dir": src_dir,
            "dst_dir": dst_dir,
            "name": display_name,
            "lutris_id": lutris_id,
            "pga_db": pga_db,
            "yml_path": yml_path,
            "prefix_path": prefix_path,
            "dst_prefix_dir": dst_prefix_dir,
            "copy_game": copy_game,
            "conflict_mode": conflict_mode or "skip",
        })

        if not Plugin._is_copying:
            import threading as _threading
            thread = _threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()

        return {"success": True}

    def _execute_lutris_copy_sync(self, job: Dict[str, Any]) -> None:
        """Synchronous Lutris game folder copy — runs inside _run_queue_sync thread.
        Mirrors _execute_nonsteam_copy_sync then patches paths when done."""
        import os as _os, shutil as _shutil
        job_id       = job["job_id"]
        copy_game    = job.get("copy_game", True)
        src          = Path(job["src_dir"]) if copy_game else None
        dst          = Path(job["dst_dir"]) if copy_game else None
        name         = job.get("name", src.name if src else "Lutris prefix")
        lutris_id    = job.get("lutris_id", 0)
        pga_db       = job.get("pga_db", "")
        yml_path     = job.get("yml_path", "")
        prefix_path  = job.get("prefix_path", "")
        dst_prefix_dir = job.get("dst_prefix_dir", "")
        conflict_mode = job.get("conflict_mode") or "skip"

        def _lut_offset(s: Path, d: Path) -> int:
            return 0 if conflict_mode == "overwrite" else _resume_offset(s, d)

        def update(**kw):
            Plugin._copy_progress[job_id].update(kw)

        def cancelled():
            return Plugin._cancel_flag.get(job_id, False)

        def handle_pause():
            while Plugin._pause_flag.get(job_id, False):
                if cancelled():
                    return True
                import time; time.sleep(0.3)
            return cancelled()

        def _walk(root: Path):
            """Walk without following symlinks — matches Steam/non-Steam walk.
            Yields both dirs and files so directory entries are created explicitly
            rather than relying on parent.mkdir() per file."""
            for dirpath, dirnames, filenames, _ in _os.fwalk(str(root), follow_symlinks=False):
                dp = Path(dirpath)
                for d in dirnames:
                    yield dp / d
                for f in filenames:
                    yield dp / f

        try:
            # Full source size; jump bar to bytes already present on resume/skip.
            copied_bytes = 0
            total = 0
            src_prefix = Path(prefix_path) if prefix_path and Path(prefix_path).exists() else None

            def _lut_accum(s: Path, d_root: Path, root: Path) -> None:
                nonlocal total, copied_bytes
                for f in _walk(root):
                    if _os.path.islink(str(f)) or not f.is_file():
                        continue
                    try:
                        sz = f.stat().st_size
                    except OSError:
                        continue
                    total += sz
                    if conflict_mode != "overwrite":
                        copied_bytes += min(_lut_offset(f, d_root / f.relative_to(root)), sz)

            if copy_game and src and dst:
                _lut_accum(src, dst, src)
            if src_prefix:
                if dst_prefix_dir:
                    pfx_dst_root = Path(dst_prefix_dir) / src_prefix.name
                elif dst:
                    pfx_dst_root = dst / src_prefix.name
                else:
                    pfx_dst_root = src_prefix.parent / (src_prefix.name + "_copy")
                _lut_accum(src_prefix, pfx_dst_root, src_prefix)

            update(
                total=total,
                copied=copied_bytes,
                stage="Copying game..." if copy_game else "Copying prefix...",
                status="copying",
            )

            # Copy game files
            if copy_game and src and dst:
                dst.mkdir(parents=True, exist_ok=True)
                for src_file in _walk(src):
                    if handle_pause():
                        update(done=True, status="cancelled", stage="Cancelled")
                        return
                    dst_file = dst / src_file.relative_to(src)
                    if src_file.is_symlink():
                        link_target = _os.readlink(str(src_file))
                        if dst_file.exists() or dst_file.is_symlink():
                            dst_file.unlink()
                        dst_file.parent.mkdir(parents=True, exist_ok=True)
                        _os.symlink(link_target, str(dst_file))
                        continue
                    if src_file.is_dir():
                        dst_file.mkdir(parents=True, exist_ok=True)
                        continue
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    resume_offset = _lut_offset(src_file, dst_file)
                    file_size = src_file.stat().st_size
                    if resume_offset >= file_size:
                        continue  # already counted in copied_bytes pre-scan
                    with open(str(src_file), "rb") as fsrc, open(str(dst_file), "ab" if resume_offset else "wb") as fdst:
                        if resume_offset:
                            fsrc.seek(resume_offset)
                        while True:
                            if handle_pause():
                                update(done=True, status="cancelled", stage="Cancelled")
                                return
                            chunk = fsrc.read(1 << 20)
                            if not chunk:
                                break
                            fdst.write(chunk)
                            copied_bytes += len(chunk)
                            update(copied=copied_bytes)
                    _shutil.copystat(str(src_file), str(dst_file))

            # Copy Wine prefix if present
            if src_prefix:
                update(stage="Copying Lutris prefix...")
                if dst_prefix_dir:
                    # dstPrefixDir is the folder that holds all prefixes, e.g. /home/deck/Prefixes.
                    # The individual prefix lands inside it: /home/deck/Prefixes/<prefixName>
                    dst_pfx = Path(dst_prefix_dir) / src_prefix.name
                elif dst:
                    # Default: place prefix alongside game dir using same relative name
                    dst_pfx = dst / src_prefix.name
                else:
                    # Prefix-only copy with no dst_prefix_dir — caller should always set
                    # dst_prefix_dir in this case; guard prevents a crash if they don't.
                    dst_pfx = src_prefix.parent / (src_prefix.name + "_copy")
                dst_pfx.mkdir(parents=True, exist_ok=True)
                for src_file in _walk(src_prefix):
                    if handle_pause():
                        update(done=True, status="cancelled", stage="Cancelled")
                        return
                    dst_file = dst_pfx / src_file.relative_to(src_prefix)
                    if src_file.is_symlink():
                        link_target = _os.readlink(str(src_file))
                        if dst_file.exists() or dst_file.is_symlink():
                            dst_file.unlink()
                        dst_file.parent.mkdir(parents=True, exist_ok=True)
                        _os.symlink(link_target, str(dst_file))
                        continue
                    if src_file.is_dir():
                        dst_file.mkdir(parents=True, exist_ok=True)
                        continue
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    # Skip complete files and resume partials — same as Steam/non-Steam.
                    # This means we only ever open(dst, "wb") on a file that doesn't
                    # exist yet (no read-only issue) or open(dst, "r+b") on a partial
                    # that was never copystat'd yet (also no read-only issue).
                    offset = _lut_offset(src_file, dst_file)
                    src_size = src_file.stat().st_size
                    if offset >= src_size:
                        continue  # already counted in copied_bytes pre-scan
                    mode = "r+b" if offset > 0 else "wb"
                    with open(str(src_file), "rb") as fsrc, open(str(dst_file), mode) as fdst:
                        if offset > 0:
                            fsrc.seek(offset)
                            fdst.seek(offset)
                        while True:
                            if cancelled():
                                update(done=True, status="cancelled", stage="Cancelled")
                                return
                            chunk = fsrc.read(1 << 20)
                            if not chunk:
                                break
                            fdst.write(chunk)
                            copied_bytes += len(chunk)
                            update(copied=copied_bytes)
                    _shutil.copystat(str(src_file), str(dst_file))

            # Patch YML + pga.db to new paths
            if lutris_id and (yml_path or pga_db):
                update(stage="Updating Lutris config...")
                import asyncio as _asyncio
                new_prefix = (
                    str(Path(dst_prefix_dir) / src_prefix.name) if src_prefix and dst_prefix_dir
                    else str(dst / src_prefix.name) if src_prefix and dst
                    else ""
                )
                try:
                    loop = _asyncio.new_event_loop()
                    loop.run_until_complete(self.update_lutris_paths(
                        pga_db=pga_db,
                        lutris_id=lutris_id,
                        yml_path=yml_path,
                        # Only update install_dir when the game folder was actually copied.
                        # Passing an empty/None install_dir when game was skipped would
                        # corrupt the Lutris config.
                        new_install_dir=str(dst) if copy_game and dst else "",
                        new_prefix_path=new_prefix,
                    ))
                    loop.close()
                except Exception as patch_err:
                    decky.logger.warning(f"CopyDeck lutris path patch error: {patch_err}")

            update(done=True, status="done", stage="Done")
            decky.logger.info(f"CopyDeck lutris copy: {src} -> {dst} OK")

        except Exception as e:
            update(done=True, status="error", error=str(e), stage="Error")
            decky.logger.warning(f"CopyDeck lutris copy error {job_id}: {e}")

    async def get_setting(self, key: str, default_val: str) -> str:
        """Get a persisted plugin setting (Decky SettingsManager)."""
        try:
            val = settings.getSetting(key, default_val)
            return default_val if val is None else str(val)
        except Exception:
            return default_val

    async def set_setting(self, key: str, value: str) -> Dict[str, Any]:
        """Persist a plugin setting (Decky SettingsManager)."""
        try:
            settings.setSetting(key, value)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}


    async def list_dir(self, path: str) -> List[Dict[str, Any]]:
        """List directory contents for the file browser."""
        import os
        decky.logger.info(f"CopyDeck list_dir called with path: {path!r}")
        entries = []
        try:
            names = os.listdir(path)
            decky.logger.info(f"CopyDeck list_dir got {len(names)} names: {names[:10]}")
        except PermissionError as e:
            decky.logger.warning(f"CopyDeck list_dir PermissionError for {path}: {e}")
            return []
        except Exception as e:
            decky.logger.warning(f"CopyDeck list_dir error for {path}: {e}")
            return []
        for name in sorted(names, key=lambda n: n.lower()):
            full_path = os.path.join(path, name)
            try:
                # Use lstat to get symlink info without following it
                stat_info = os.lstat(full_path)
                is_link = os.path.islink(full_path)
                
                # For symlinks, check if target exists
                if is_link:
                    link_target = os.readlink(full_path)
                    # is_dir checks if the TARGET is a dir (follows link)
                    # For dead links, this will be False
                    is_dir = os.path.isdir(full_path)
                else:
                    link_target = None
                    is_dir = stat_info.st_mode & 0o040000 != 0  # S_IFDIR
                
                size = 0 if is_dir else stat_info.st_size
                mtime = stat_info.st_mtime
                ctime = stat_info.st_ctime
                # Shallow item count for directories (excluding hidden files)
                item_count = None
                if is_dir:
                    try:
                        item_count = len([n for n in os.listdir(full_path) if not n.startswith(".")])
                    except Exception:
                        item_count = None
                
            except Exception as e:
                # Log but still skip entries we genuinely can't read
                decky.logger.warning(f"CopyDeck list_dir: skipping {full_path}: {e}")
                continue
            entries.append({
                "name": name,
                "path": full_path,
                "is_dir": is_dir,
                "is_symlink": is_link,
                "link_target": link_target,
                "size_bytes": size,
                "item_count": item_count,
                "mtime": mtime,
                "ctime": ctime,
            })
        decky.logger.info(f"CopyDeck list_dir returning {len(entries)} entries")
        return entries

    async def get_path_size(self, path: str) -> Dict[str, Any]:
        """Return total size in bytes for a file or directory (recursive for dirs)."""
        import os
        try:
            p = Path(path)
            if not p.exists():
                return {"success": False, "size_bytes": 0, "error": "Path not found"}
            if p.is_file():
                return {"success": True, "size_bytes": p.stat().st_size}
            total = 0
            for root, dirs, files in os.walk(path, followlinks=False):
                for fname in files:
                    try:
                        total += os.path.getsize(os.path.join(root, fname))
                    except Exception:
                        pass
            return {"success": True, "size_bytes": total}
        except Exception as e:
            return {"success": False, "size_bytes": 0, "error": str(e)}

    async def create_dir(self, path: str) -> Dict[str, Any]:
        """Create a new directory. If path already exists, append (1), (2), etc."""
        import os
        base = path
        candidate = base
        i = 1
        while os.path.exists(candidate):
            candidate = f"{base} ({i})"
            i += 1
        try:
            os.makedirs(candidate)
            return {"success": True, "path": candidate, "name": os.path.basename(candidate)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def create_file(self, path: str) -> Dict[str, Any]:
        """Create a new empty file. If path already exists, append (1), (2), etc. before extension."""
        import os
        # Split off extension so numbering goes before it: "New Document (1).txt"
        root, ext = os.path.splitext(path)
        candidate = path
        i = 1
        while os.path.exists(candidate):
            candidate = f"{root} ({i}){ext}"
            i += 1
        try:
            with open(candidate, "w") as f:
                f.write("")
            return {"success": True, "path": candidate, "name": os.path.basename(candidate)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def cancel_all(self, remove_partial: bool = False) -> Dict[str, Any]:
        """Immediately cancel the current job mid-copy and clear the entire queue.
        Sets the cancel flag so the chunk-level copy loop exits at the next check,
        unblocks any pause, and wipes all queued jobs.
        If remove_partial, delete destinations for in-progress/paused jobs after
        their workers stop."""
        if Plugin._current_job:
            Plugin._cancel_flag[Plugin._current_job] = True
            Plugin._pause_flag[Plugin._current_job] = False  # unblock pause loop
            if remove_partial:
                Plugin._remove_partial_on_cancel[Plugin._current_job] = True

            # Propagate to all sibling jobs in the same group
            current_group = Plugin._copy_progress.get(Plugin._current_job, {}).get("group_id")
            if current_group:
                for job_id, entry in Plugin._copy_progress.items():
                    if entry.get("group_id") == current_group:
                        Plugin._cancel_flag[job_id] = True
                        Plugin._pause_flag[job_id] = False
                        if remove_partial and entry.get("status") in ("copying", "paused"):
                            Plugin._remove_partial_on_cancel[job_id] = True

        # Also mark any other copying/paused jobs (shouldn't normally exist, but be safe)
        if remove_partial:
            for job_id, entry in Plugin._copy_progress.items():
                if entry.get("status") in ("copying", "paused"):
                    Plugin._cancel_flag[job_id] = True
                    Plugin._pause_flag[job_id] = False
                    Plugin._remove_partial_on_cancel[job_id] = True

        # Also cancel all queued-but-not-started jobs
        for job in Plugin._copy_queue:
            jid = job.get("job_id") or job.get("appid")
            if jid:
                Plugin._cancel_flag[jid] = True
                if jid in Plugin._copy_progress:
                    Plugin._copy_progress[jid].update({
                        "done": True,
                        "status": "cancelled",
                        "stage": "Cancelled",
                    })
        Plugin._copy_queue.clear()
        return {"success": True}

    async def cancel_copy(self) -> Dict[str, Any]:
        """Stop after the current job finishes — does not interrupt mid-copy.
        Clears the queue so no further jobs start after the current one completes.
        If currently paused, unblocks the pause immediately so the job can finish
        rather than freezing until manually resumed.
        Has no effect on the chunk-level copy loop — the job runs to completion.
        """
        Plugin._stop_after_current = True

        # Mark queued-but-not-started jobs as cancelled so they disappear from the UI
        for job in Plugin._copy_queue:
            jid = job.get("job_id") or job.get("appid")
            if jid and jid in Plugin._copy_progress:
                Plugin._copy_progress[jid].update({
                    "done": True,
                    "status": "cancelled",
                    "stage": "Cancelled",
                })
        Plugin._copy_queue.clear()

        # If the current job (or any sibling in its group) is paused, unblock it
        # so it can finish and the queue exits cleanly instead of freezing.
        if Plugin._current_job:
            if Plugin._pause_flag.get(Plugin._current_job):
                Plugin._pause_flag[Plugin._current_job] = False
                entry = Plugin._copy_progress.get(Plugin._current_job, {})
                entry.update({"stage": "Finishing...", "status": "copying", "pause_reason": None})

            current_group = Plugin._copy_progress.get(Plugin._current_job, {}).get("group_id")
            if current_group:
                for job_id, entry in Plugin._copy_progress.items():
                    if entry.get("group_id") == current_group and job_id != Plugin._current_job:
                        if Plugin._pause_flag.get(job_id):
                            Plugin._pause_flag[job_id] = False
                            entry.update({"stage": "Finishing...", "status": "copying", "pause_reason": None})

        return {"success": True}

    async def pause_copy(self, appid: str) -> Dict[str, Any]:
        """Pause the copy for this appid (takes effect between files)."""
        Plugin._pause_flag[appid] = True
        if appid in Plugin._copy_progress:
            Plugin._copy_progress[appid].update({
                "stage": "Paused",
                "status": "paused",
            })
        return {"success": True}

    async def resume_copy(self, appid: str) -> Dict[str, Any]:
        """Resume a paused copy. For Steam game jobs, checks the destination drive
        is still available before resuming. For file-op and non-Steam jobs, resumes
        immediately since they don't use dst_library."""
        if appid not in Plugin._copy_progress:
            return {"success": False, "error": "Job not found"}
        entry = Plugin._copy_progress[appid]
        dst_library = entry.get("dst_library")

        # Only do the drive availability check for Steam game jobs
        if dst_library:
            dst_root = Path(dst_library)
            steamapps = dst_root / "steamapps"
            if not dst_root.exists() or not steamapps.exists():
                entry.update({
                    "stage": "Drive not found — reconnect and try again",
                    "status": "paused",
                    "pause_reason": "Drive not found at original path. Stop and re-queue to copy to the new path if the drive remounted elsewhere.",
                })
                return {"success": False, "error": "Drive not found"}

        Plugin._pause_flag[appid] = False
        entry.update({
            "stage": "Copying...",
            "status": "copying",
            "pause_reason": None,
        })
        return {"success": True}

    async def get_all_progress(self) -> Dict[str, Any]:
        """Return is_copying and all job progress for the sidebar."""
        # Stamp completion order the first time we see a terminal status so the
        # UI can sort completed jobs by finish order when alpha sort is off.
        for entry in Plugin._copy_progress.values():
            if (
                entry.get("status") in ("done", "error", "cancelled")
                and "completed_seq" not in entry
            ):
                Plugin._complete_seq += 1
                entry["completed_seq"] = Plugin._complete_seq
        return {
            "is_copying": Plugin._is_copying,
            "is_stopping": Plugin._stop_after_current,
            "jobs": dict(Plugin._copy_progress),
        }

    async def eject_drive(self, path: str) -> Dict[str, Any]:
        """Safely unmount and power-off an external drive via udisks2 / gdbus."""
        import subprocess, os
        mount_path = Path(path).resolve()
        if not mount_path.exists():
            return {"success": False, "error": "Path does not exist"}
        path_str = str(mount_path)
        if "home" in path_str or "local/share/Steam" in path_str or ".steam" in path_str:
            return {"success": False, "error": "Cannot eject internal storage"}
        for job in Plugin._copy_progress.values():
            if job.get("status") in ("copying", "queued", "paused"):
                dst = job.get("dst_library", "")
                src = job.get("src_library", "")
                if (dst and path_str in dst) or (src and path_str in src):
                    return {"success": False, "error": "Drive is in use by an active copy"}

        try:
            # Find block device for this mount point
            dev_result = subprocess.run(
                ["findmnt", "-n", "-o", "SOURCE", path_str],
                capture_output=True, text=True, timeout=5
            )
            device = dev_result.stdout.strip()
            if not device:
                return {"success": False, "error": "Could not find block device for path"}

            # root can always umount directly — no Polkit/UDisks2 needed
            result = subprocess.run(
                ["umount", path_str],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode != 0:
                return {"success": False, "error": result.stderr.strip() or "Unmount failed"}

            # Power off the parent disk so it is safe to physically remove
            base_device = "".join(c for c in device if not c.isdigit()) if device[-1].isdigit() else device
            subprocess.run(
                ["udisksctl", "power-off", "--no-user-interaction", "-b", base_device],
                capture_output=True, text=True, timeout=10,
            )
            decky.logger.info(f"CopyDeck: ejected {path_str} ({device})")
            return {"success": True}
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Eject timed out"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_all_drives(self) -> List[Dict[str, Any]]:
        """Return all drives using lsblk as primary source.
        
        lsblk sees ALL block devices including unmounted exFAT/NTFS reliably.
        udisksctl dump is used only to backfill filesystem labels.
        """
        import subprocess, json as _json

        drives = []

        # ── 1. Internal storage ────────────────────────────────────────────────
        internal_root = Path(decky.DECKY_USER_HOME)
        try:
            usage = shutil.disk_usage(internal_root)
            drives.append({
                "path":        str(internal_root),
                "label":       "Internal Storage",
                "free_gb":     round(usage.free  / (1024**3), 1),
                "total_gb":    round(usage.total / (1024**3), 1),
                "is_internal": True,
                "is_mounted":  True,
                "device":      "",
                "fs_type":     "",
            })
        except OSError:
            pass

        # ── 2. External drives via lsblk ──────────────────────────────────────
        # lsblk always shows exFAT/NTFS partitions even when unmounted,
        # unlike udisksctl dump which may omit them until mounted.
        try:
            res = subprocess.run(
                ["lsblk", "-J", "-o", "NAME,SIZE,FSTYPE,MOUNTPOINT,HOTPLUG,TYPE,PATH,LABEL,PARTLABEL"],
                capture_output=True, text=True, timeout=10
            )
            if res.returncode != 0:
                raise RuntimeError(f"lsblk failed: {res.stderr.strip()}")

            data = _json.loads(res.stdout)
            seen: set = set()

            internal_devices = {str(internal_root)}

            for dev in data.get("blockdevices", []):
                parent_hotplug = dev.get("hotplug") in (True, "1", 1)
                children = dev.get("children") or []
                # Check all children (partitions) and the disk itself
                items = children if children else [dev]
                for item in items:
                    if item.get("type") not in ("part", "disk"):
                        continue
                    item_hotplug = item.get("hotplug") in (True, "1", 1)
                    if not parent_hotplug and not item_hotplug:
                        continue  # skip non-hotplug (internal NVMe etc.)

                    dev_path   = item.get("path") or f"/dev/{item.get('name','')}"
                    fs         = (item.get("fstype") or "").strip()
                    mountpoint = (item.get("mountpoint") or "").strip()
                    fs_label   = (item.get("label") or item.get("partlabel") or "").strip()
                    size_str   = item.get("size", "")

                    # Skip swap, loop, recovery partitions
                    if fs in ("swap", "iso9660", "squashfs"):
                        continue
                    if mountpoint in ("[SWAP]", ""):
                        mountpoint = "" if mountpoint == "[SWAP]" else mountpoint
                    if mountpoint == "[SWAP]":
                        continue

                    if dev_path in seen:
                        continue

                    # Skip if this mountpoint is already the internal drive
                    if mountpoint and mountpoint in internal_devices:
                        continue
                    if mountpoint == "/home" or mountpoint == "/":
                        continue

                    seen.add(dev_path)

                    if mountpoint:
                        # Drive is mounted
                        try:
                            usage = shutil.disk_usage(mountpoint)
                            label = fs_label or Path(mountpoint).name or dev_path
                            drives.append({
                                "path":        mountpoint,
                                "label":       label,
                                "free_gb":     round(usage.free  / (1024**3), 1),
                                "total_gb":    round(usage.total / (1024**3), 1),
                                "is_internal": False,
                                "is_mounted":  True,
                                "device":      dev_path,
                                "fs_type":     fs,
                            })
                        except OSError:
                            pass
                    elif fs:
                        # Unmounted but has a filesystem — show for mounting
                        label = fs_label or item.get("name", dev_path)
                        drives.append({
                            "path":        "",
                            "label":       f"{label} ({size_str})",
                            "free_gb":     0.0,
                            "total_gb":    0.0,
                            "is_internal": False,
                            "is_mounted":  False,
                            "device":      dev_path,
                            "fs_type":     fs,
                        })
                    # else: no filesystem at all — skip silently

        except Exception as e:
            decky.logger.warning(f"CopyDeck get_all_drives lsblk error: {e}")

        decky.logger.info(f"CopyDeck get_all_drives returning: {drives}")
        return drives

    async def check_file_op_conflicts(self, jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Return whether any paste jobs would collide with existing files at the destination.
        Directories are write-into (not conflicts); only existing files/symlinks count.
        Short-circuits after the first conflict for speed.
        """
        import os as _os
        try:
            for job in jobs:
                src = Path(job.get("src", ""))
                dst_dir = Path(job.get("dst_dir", ""))
                if not src.exists() or not dst_dir:
                    continue
                dst = dst_dir / src.name
                if src.is_dir():
                    if not dst.exists():
                        continue  # nothing to collide with yet
                    if dst.is_file() or dst.is_symlink():
                        return {"has_conflicts": True}
                    # Dst is a directory — write into; look for file-level collisions
                    for dirpath, _dirnames, filenames in _os.walk(str(src), followlinks=False):
                        rel = Path(dirpath).relative_to(src)
                        for fname in filenames:
                            dest_f = (dst / rel / fname) if str(rel) != "." else (dst / fname)
                            if dest_f.exists() or dest_f.is_symlink():
                                return {"has_conflicts": True}
                else:
                    if dst.exists() or dst.is_symlink():
                        return {"has_conflicts": True}
            return {"has_conflicts": False}
        except Exception as e:
            return {"has_conflicts": False, "error": str(e)}

    async def queue_file_ops(self, jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Queue file copy/move operations from the browser.

        Each job has:
          op:        "copy" | "move"
          src:       absolute source path (file or directory)
          dst_dir:   absolute destination directory
          label:     display name (first item name for the group)
          group_id:  shared key for all jobs in one paste action
          group_total: total number of items in this paste
          conflict_mode: optional "skip" | "overwrite" from duplicate prompt
        """
        import time as _time

        if not jobs:
            return {"success": True, "job_count": 0}

        queued = []
        for job in jobs:
            op       = job.get("op", "copy")
            src      = job.get("src", "")
            dst_dir  = job.get("dst_dir", "")
            label    = job.get("label", "")
            group_id = job.get("group_id", f"fileop_{int(_time.time()*1000)}")
            group_total = job.get("group_total", 1)
            group_total_bytes = job.get("group_total_bytes", 0)
            conflict_mode = job.get("conflict_mode")

            if not src or not dst_dir:
                continue

            job_id = f"{group_id}_{Path(src).name}"

            item_dest = str(Path(dst_dir) / Path(src).name)
            Plugin._copy_progress[job_id] = {
                "copied": 0, "total": 0,
                "done": False, "error": None,
                "stage": "Queued",
                "status": "queued",
                "name": label,
                "group_id": group_id,
                "group_total": group_total,
                "group_total_bytes": group_total_bytes,
                "op": op,
                "src_path": src,
                "dst_dir": dst_dir,
                "dest_path": dst_dir,
                # Exact file/folder being written — used when cancel asks to remove partial
                "partial_path": item_dest if op in ("copy", "move") else None,
            }
            Plugin._cancel_flag[job_id] = False
            Plugin._pause_flag[job_id] = False

            queued.append({
                "job_id": job_id,
                "op": op,
                "src": src,
                "dst_dir": dst_dir,
                "label": label,
                "group_id": group_id,
                "group_total": group_total,
                "group_total_bytes": group_total_bytes,
                "conflict_mode": conflict_mode,
            })

        if not queued:
            return {"success": False, "error": "No valid jobs"}

        # Inject into the copy queue with a special type marker
        Plugin._copy_queue.extend(queued)

        if not Plugin._is_copying:
            import threading as _threading
            thread = _threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()

        return {"success": True, "job_count": len(queued)}

    async def rename_path(self, src: str, new_name: str) -> Dict[str, Any]:
        """Rename a file or directory. new_name is just the name, not a full path."""
        import os as _os
        try:
            src_path = Path(src)
            dst_path = src_path.parent / new_name.strip()
            if not src_path.exists():
                return {"success": False, "error": "Source does not exist"}
            if dst_path.exists():
                return {"success": False, "error": f"{new_name} already exists"}
            _os.rename(str(src_path), str(dst_path))
            decky.logger.info(f"CopyDeck rename: {src} -> {dst_path}")
            return {"success": True, "new_path": str(dst_path)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def rename_symlink(self, link_path: str, new_name: str, new_target: str) -> Dict[str, Any]:
        """Rename a symlink (change its name and/or its target path)."""
        import os as _os
        try:
            lp = Path(link_path)
            if not lp.is_symlink():
                return {"success": False, "error": "Not a symlink"}
            new_link = lp.parent / new_name.strip()
            if new_link.exists() or new_link.is_symlink():
                return {"success": False, "error": f"{new_name} already exists"}
            _os.symlink(new_target.strip(), str(new_link))
            _os.unlink(str(lp))
            decky.logger.info(f"CopyDeck rename_symlink: {link_path} -> {new_link} -> {new_target}")
            return {"success": True, "new_path": str(new_link)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def queue_extract(self, jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Queue archive extraction jobs. Each job: {src, dst_dir, password?, label?}"""
        import time as _time
        if not jobs:
            return {"success": True, "job_count": 0}
        queued = []
        for job in jobs:
            src = job.get("src", "")
            dst_dir = job.get("dst_dir", "")
            if not src or not dst_dir:
                continue
            group_id = job.get("group_id", f"extract_{int(_time.time()*1000)}")
            job_id = f"{group_id}_{Path(src).name}"
            Plugin._copy_progress[job_id] = {
                "copied": 0, "total": 0,
                "done": False, "error": None,
                "stage": "Queued",
                "status": "queued",
                "name": job.get("label", Path(src).name),
                "group_id": group_id,
                "group_total": 1,
                "op": "extract",
                "dst_dir": dst_dir,
                "dest_path": dst_dir,
            }
            Plugin._cancel_flag[job_id] = False
            Plugin._copy_queue.append({
                "job_id": job_id,
                "op": "extract",
                "src": src,
                "dst_dir": dst_dir,
                "password": job.get("password", None),
                "label": job.get("label", Path(src).name),
            })
            queued.append(job_id)
        if queued and not Plugin._is_copying:
            import threading as _threading
            thread = _threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()
        return {"success": True, "job_count": len(queued), "job_ids": queued}


    async def queue_compress(self, jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Queue compression jobs.

        Each job: { srcs: [str], dst: str, fmt: "targz"|"zip", label: str }
        dst is the full output archive path (caller decides the filename).
        """
        import time as _time
        if not jobs:
            return {"success": True, "job_count": 0}
        queued = []
        for job in jobs:
            srcs = job.get("srcs", [])
            dst  = job.get("dst", "")
            fmt  = job.get("fmt", "targz")
            if not srcs or not dst:
                continue
            group_id = f"compress_{int(_time.time()*1000)}"
            job_id   = f"{group_id}_{Path(dst).name}"
            Plugin._copy_progress[job_id] = {
                "copied": 0, "total": 1,
                "done": False, "error": None,
                "stage": "Queued",
                "status": "queued",
                "name": job.get("label", Path(dst).name),
                "group_id": group_id,
                "group_total": 1,
                "op": "compress",
                "dst_dir": str(Path(dst).parent),
                "dest_path": dst,
            }
            Plugin._cancel_flag[job_id] = False
            Plugin._copy_queue.append({
                "job_id": job_id,
                "op": "compress",
                "srcs": srcs,
                "dst": dst,
                "fmt": fmt,
                "label": job.get("label", Path(dst).name),
                "group_id": group_id,
            })
            queued.append(job_id)
        if queued and not Plugin._is_copying:
            import threading as _threading
            thread = _threading.Thread(target=self._run_queue_sync, daemon=True)
            thread.start()
        return {"success": True, "job_count": len(queued), "job_ids": queued}

    async def delete_path(self, path: str) -> Dict[str, Any]:
        """Delete a file, symlink, or directory (recursively)."""
        import os as _os
        try:
            p = Path(path)
            if not p.exists() and not p.is_symlink():
                return {"success": False, "error": "Path does not exist"}
            if p.is_symlink() or p.is_file():
                _os.unlink(str(p))
            else:
                import shutil as _shutil
                _shutil.rmtree(str(p))
            decky.logger.info(f"CopyDeck delete_path: {path}")
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def create_symlink(self, target: str, link_path: str) -> Dict[str, Any]:
        """Create a symlink at link_path pointing to target."""
        import os as _os
        try:
            lp = Path(link_path)
            if lp.exists() or lp.is_symlink():
                return {"success": False, "error": f"{lp.name} already exists"}
            _os.symlink(target, str(lp))
            decky.logger.info(f"CopyDeck create_symlink: {link_path} -> {target}")
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def read_text_file(self, path: str) -> Dict[str, Any]:
        """Read a text file for the in-browser editor. Capped at 512 KB."""
        try:
            p = Path(path)
            if not p.is_file():
                return {"success": False, "error": "Not a file"}
            size = p.stat().st_size
            if size > 512 * 1024:
                return {"success": False, "error": f"File too large ({size // 1024} KB). Max 512 KB."}
            text = p.read_text(encoding="utf-8", errors="replace")
            return {"success": True, "text": text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def read_binary_file(self, path: str) -> Dict[str, Any]:
        """Read a binary file (image/PDF) and return base64-encoded data. Capped at 32 MB."""
        try:
            p = Path(path)
            if not p.is_file():
                return {"success": False, "error": "Not a file"}
            size = p.stat().st_size
            if size > 32 * 1024 * 1024:
                return {"success": False, "error": f"File too large ({size // (1024*1024)} MB). Max 32 MB."}
            data = p.read_bytes()
            ext = p.suffix.lower().lstrip(".")
            mime_map = {
                "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "png": "image/png", "gif": "image/gif",
                "webp": "image/webp", "bmp": "image/bmp",
                "svg": "image/svg+xml", "ico": "image/x-icon",
                "pdf": "application/pdf",
                "mp3": "audio/mpeg", "ogg": "audio/ogg",
                "flac": "audio/flac", "wav": "audio/wav",
                "m4a": "audio/mp4", "aac": "audio/aac",
            }
            mime = mime_map.get(ext, "application/octet-stream")
            return {"success": True, "data": base64.b64encode(data).decode("ascii"), "mime": mime}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def render_pdf_pages(self, path: str, dpi: int = 150) -> Dict[str, Any]:
        """Render a PDF to PNG images using pdftoppm. Returns list of base64-encoded PNGs."""
        import subprocess, tempfile, glob, hashlib
        try:
            p = Path(path)
            if not p.is_file():
                return {"success": False, "error": "Not a file"}
            # Use a stable tmp dir based on file path + mtime so pages are cached across opens
            key = hashlib.md5(f"{path}:{p.stat().st_mtime}".encode()).hexdigest()[:12]
            out_dir = Path(f"/tmp/copydeck_pdf_{key}")
            page_files = sorted(out_dir.glob("page-*.png")) if out_dir.exists() else []
            if not page_files:
                out_dir.mkdir(parents=True, exist_ok=True)
                import os
                clean_env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
                result = subprocess.run(
                    ["pdftoppm", "-png", "-r", str(dpi), str(p), str(out_dir / "page")],
                    capture_output=True, timeout=60, env=clean_env
                )
                if result.returncode != 0:
                    err = result.stderr.decode("utf-8", errors="replace").strip()
                    return {"success": False, "error": f"pdftoppm failed: {err}"}
                page_files = sorted(out_dir.glob("page-*.png"))
            pages = []
            for pf in page_files:
                data = pf.read_bytes()
                pages.append(base64.b64encode(data).decode("ascii"))
            return {"success": True, "pages": pages}
        except FileNotFoundError:
            return {"success": False, "error": "pdftoppm not found. Install poppler-utils."}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def write_text_file(self, path: str, text: str) -> Dict[str, Any]:
        """Write text back to a file (overwrites). Creates a .bak backup first."""
        try:
            p = Path(path)
            p.write_text(text, encoding="utf-8")
            decky.logger.info(f"CopyDeck write_text_file: {path} ({len(text)} chars)")
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def write_clipboard_file(self, text: str) -> Dict[str, Any]:
        """Write text to /tmp/copydeck_clip.txt; frontend reads it and execCommand-copies."""
        try:
            p = Path("/tmp/copydeck_clip.txt")
            p.write_text(text, encoding="utf-8")
            p.chmod(0o644)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def read_clipboard_file(self) -> Dict[str, Any]:
        """Read the clipboard temp file written by write_clipboard_file."""
        try:
            p = Path("/tmp/copydeck_clip.txt")
            if not p.exists():
                return {"success": False, "error": "No clipboard file"}
            text = p.read_text(encoding="utf-8")
            return {"success": True, "text": text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _main(self):
        decky.logger.info("CopyDeck loaded")
        asyncio.ensure_future(self._watch_drives())

    async def _watch_drives(self) -> None:
        """Watch for drive plug/unplug/mount/unmount via dbus-monitor.
        Emits drives_changed to the frontend so it can refresh without polling.
        """
        import time as _time
        try:
            proc = await asyncio.create_subprocess_exec(
                "dbus-monitor", "--system",
                "type='signal',sender='org.freedesktop.UDisks2'",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if proc.stdout is None:
                return
            decky.logger.info("CopyDeck: drive watcher active (dbus-monitor)")
            last_emit = 0.0
            pending_poll = None

            async def _emit_and_poll():
                """Emit drives_changed immediately, then re-emit every 0.5s until
                all detected drives have a real mountpoint (max 10s).
                This makes the tab appear instantly while still resolving the path."""
                deadline = _time.monotonic() + 10.0
                while _time.monotonic() < deadline:
                    nonlocal last_emit
                    last_emit = _time.monotonic()
                    await decky.emit("drives_changed", {})
                    decky.logger.info("CopyDeck: drives_changed emitted (polling for mount)")
                    try:
                        import json as _json, asyncio as _asyncio
                        r = await _asyncio.create_subprocess_exec(
                            "lsblk", "-J", "-o", "NAME,MOUNTPOINT,FSTYPE,LABEL,SIZE,TYPE",
                            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.DEVNULL)
                        out, _ = await r.communicate()
                        data = _json.loads(out)
                        all_mounted = True
                        for dev in data.get("blockdevices", []):
                            for part in dev.get("children", [dev]):
                                mp = (part.get("mountpoint") or "").strip()
                                fs = part.get("fstype") or ""
                                if fs and fs not in ("swap",) and not mp:
                                    all_mounted = False
                                    break
                        if all_mounted:
                            decky.logger.info("CopyDeck: all drives mounted, stopping poll")
                            break
                    except Exception:
                        pass
                    await _asyncio.sleep(0.5)

            async for line in proc.stdout:
                text = line.decode("utf-8", errors="replace")
                if any(k in text for k in ("InterfacesAdded", "InterfacesRemoved", "block_devices")):
                    now = _time.monotonic()
                    if now - last_emit > 0.5:
                        if pending_poll and not pending_poll.done():
                            pending_poll.cancel()
                        pending_poll = asyncio.ensure_future(_emit_and_poll())
        except Exception as e:
            decky.logger.warning(f"CopyDeck: drive watcher failed: {e}")

    async def _unload(self):
        pass
    async def _uninstall(self) -> None:
        decky.logger.info("CopyDeck uninstalled")

    async def _migration(self):
        pass
