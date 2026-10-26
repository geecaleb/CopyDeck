import { useState, useEffect, useRef } from "react";
import { Menu, MenuItem, showContextMenu, showModal, ModalRoot, DialogBody, DialogFooter, DialogButton, Focusable } from "@decky/ui";
import { toaster } from "@decky/api";
import {
  getDrives,
  getAllDrives,
  getInstalledGames,
  getGameSizes,
  queueGames,
  getHomeDir,
  copyNonSteam,
  copyNonSteamFile,
  findNonSteamCompatdata,
  copyNonSteamCompatdata,
  checkPathExists,
  getCopyProgress,
  getShortcutExe,
  getShortcutRawExe,
  getShortcutLaunchOptions,
  getShortcutSnapshot,
  addTargetHistory,
  getTargetHistory,
  uninstallNonSteam,
  deletePath,
  getPathSize,
  listDir,
  detectLutrisShortcut,
  findLutrisPrefix,
  copyLutrisGame,
  updateLutrisPaths,
  uninstallLutris,
  type LutrisGameInfo,
  type Drive,
  type Game,
  type GameSizes,
} from "../utils/backendApi";
import { formatStorageGb } from "../utils/formatStorage";
import { forceRefresh } from "../lib/jobNotifier";
import { resolveConflictMode, type ConflictMode } from "../utils/copyConflicts";

/**
 * Free/total for a drive row, with optional game size filled in asynchronously.
 * Kept as a leaf component (not wrapping Menu) so Decky's showContextMenu stays stable —
 * remounting/re-rendering the Menu root was falling back to the game context menu.
 */
function DriveSpaceWithSize({
  drive,
  sizePromise,
}: {
  drive: Drive;
  sizePromise: Promise<string | null> | null;
}) {
  const [gameSizeStr, setGameSizeStr] = useState<string | null>(null);

  useEffect(() => {
    if (!sizePromise) return;
    let cancelled = false;
    sizePromise.then((s) => {
      if (!cancelled && s) setGameSizeStr(s);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sizePromise]);

  const freeTotal = `${formatStorageGb(drive.free_gb)} free of ${formatStorageGb(drive.total_gb)}`;
  return (
    <span style={{ color: "#888", marginLeft: 16 }}>
      {gameSizeStr && (
        <>
          <span style={{ color: "#bbb" }}>{gameSizeStr}</span>
          {" · "}
        </>
      )}
      {freeTotal}
    </span>
  );
}

/** Start one shared size walk for a drive-selector open (rows all subscribe to the same promise). */
function startDriveSelectorSizePromise(
  fetcher?: () => Promise<number | null | undefined>,
): Promise<string | null> | null {
  if ((window as any).__copydeck_drive_selector_size === false || !fetcher) return null;
  return (async () => {
    try {
      const bytes = await fetcher();
      return bytes != null && bytes > 0 ? formatSize(bytes) : null;
    } catch {
      return null;
    }
  })();
}

const normPath = (p: string) => p.replace(/\/$/, "");

/** Remember the real copy origin so cancel → retry doesn't treat a partial dest as source. */
function stashNonSteamOrigin(appid: string, srcPath: string): void {
  if (!appid || !srcPath) return;
  const map = ((window as any).__copydeck_ns_origins ?? {}) as Record<string, string>;
  map[appid] = normPath(srcPath);
  (window as any).__copydeck_ns_origins = map;
}

function getStashedNonSteamOrigin(appid: string): string | null {
  const map = ((window as any).__copydeck_ns_origins ?? {}) as Record<string, string>;
  return map[appid] ? normPath(map[appid]) : null;
}

function stashRomOrigin(appid: string, srcPath: string): void {
  if (!appid || !srcPath) return;
  const map = ((window as any).__copydeck_ns_rom_origins ?? {}) as Record<string, string>;
  map[appid] = normPath(srcPath);
  (window as any).__copydeck_ns_rom_origins = map;
}

function getStashedRomOrigin(appid: string): string | null {
  const map = ((window as any).__copydeck_ns_rom_origins ?? {}) as Record<string, string>;
  return map[appid] ? normPath(map[appid]) : null;
}

/** Same-path recovery for ROMs: stashed origin, then same filename on other drives / scan locs. */
async function findAlternateRomSource(
  appid: string,
  romPath: string,
  excludePath: string,
  driveRoots: string[],
): Promise<string | null> {
  const excl = normPath(excludePath);
  const tryPath = async (p: string | null | undefined): Promise<string | null> => {
    if (!p) return null;
    const n = normPath(p);
    if (!n || n === excl) return null;
    return (await checkPathExists(n).catch(() => false)) ? n : null;
  };

  const stashed = await tryPath(getStashedRomOrigin(appid));
  if (stashed) return stashed;

  const fileName = romPath.replace(/\/$/, "").split("/").pop();
  if (!fileName) return null;

  // Same relative path under another drive root (e.g. Emulation/roms/game.nsp)
  for (const root of driveRoots) {
    if (!root) continue;
    if (romPath.startsWith(root + "/")) {
      const rel = romPath.slice(root.length + 1);
      for (const other of driveRoots) {
        if (!other || other === root) continue;
        const hit = await tryPath(`${other}/${rel}`);
        if (hit) return hit;
      }
      break;
    }
  }

  // Filename under scan locations
  const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
  const romScanDepth: number = (window as any).__copydeck_rom_scan_depth ?? 3;
  const scanDir = async (dir: string, depthLeft: number): Promise<string | null> => {
    const direct = await tryPath(`${dir}/${fileName}`);
    if (direct) return direct;
    if (depthLeft <= 0) return null;
    const entries = await listDir(dir).catch(() => []);
    for (const e of entries.filter((x) => x.is_dir)) {
      const found = await scanDir(e.path, depthLeft - 1);
      if (found) return found;
    }
    return null;
  };
  for (const loc of savedLocs) {
    const found = await scanDir(normPath(loc), romScanDepth);
    if (found) return found;
  }
  return null;
}

// ── Destination subdirectory fallback helper ─────────────────────────────────
// Used by copy and uninstall when a game can't be found via scan locations.
// Checks [drive]/<destSubfolder>/<gameName> across all mounted drives.
// Only runs when the corresponding toggle flag is enabled.
const findOnDestDrivesFor = async (
  gameName: string,
  flag: "__copydeck_copy_dest_fallback" | "__copydeck_uninstall_dest_fallback",
  knownPath: string = "",
  excludePath: string = "",
): Promise<string | null> => {
  if ((window as any)[flag] === false) return null;
  try {
    const destSubfolder = ((window as any).__copydeck_nonsteam_dest as string | undefined)
      ?.trim().replace(/^\//, "").replace(/\/$/, "") ?? "Games/NonSteam";
    if (!gameName) return null;
    const excl = excludePath ? normPath(excludePath) : "";
    // Build name candidates: display name first, then path segments from knownPath
    // (deepest to shallowest), same strategy as scan location tree-walk.
    const pathSegments = knownPath.replace(/\/$/, "").split("/").filter(Boolean);
    const namesToTry = Array.from(new Set([gameName, ...pathSegments].filter(Boolean)));
    const drives = await getAllDrives();
    for (const drive of drives) {
      const root = destSubfolder ? `${drive.path}/${destSubfolder}` : drive.path;
      for (const name of namesToTry) {
        const candidate = `${root}/${name}`;
        if (excl && normPath(candidate) === excl) continue;
        if (await checkPathExists(candidate)) return candidate;
      }
    }
  } catch { /* best-effort */ }
  return null;
};

/**
 * Find a copy source that is NOT excludePath (the destination / partial leftover).
 * Used when cancel → retry would otherwise resolve source == destination.
 */
async function findAlternateNonSteamSource(
  appid: string,
  gameName: string,
  knownPath: string,
  excludePath: string,
): Promise<string | null> {
  const excl = normPath(excludePath);
  const tryPath = async (p: string | null | undefined): Promise<string | null> => {
    if (!p) return null;
    const n = normPath(p);
    if (!n || n === excl) return null;
    return (await checkPathExists(n).catch(() => false)) ? n : null;
  };

  // 1. Origin stashed when a distinct src→dst copy was queued earlier this session
  const stashed = await tryPath(getStashedNonSteamOrigin(appid));
  if (stashed) return stashed;

  // 2. Target history (previous StartDir / exe parents from successful copies)
  try {
    const hist = await getTargetHistory(appid);
    for (const snap of hist) {
      const dir = snap.startDir?.replace(/^"|"$/g, "").trim()
        || (snap.exe ? snap.exe.replace(/^"|"$/g, "").replace(/\/[^/]+$/, "") : "");
      const hit = await tryPath(dir);
      if (hit) return hit;
    }
  } catch { /* ignore */ }

  // 3. Scan locations
  const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
  const namesToTry = Array.from(
    new Set([gameName, ...knownPath.replace(/\/$/, "").split("/").filter(Boolean)].filter(Boolean)),
  );
  for (const loc of savedLocs) {
    const normLoc = normPath(loc);
    for (const name of namesToTry) {
      const hit = await tryPath(`${normLoc}/${name}`);
      if (hit) return hit;
    }
  }

  // 4. Other drives' dest folders (skip the excluded partial)
  return findOnDestDrivesFor(gameName, "__copydeck_copy_dest_fallback", knownPath, excl);
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return "0 KB";
}

async function queueWithPrompt(
  game: Game,
  drive: Drive,
  workshopSize: number,
  compatdataSize: number,
  sizes?: { workshop_path?: string; compatdata_path?: string; game_size?: number; installdir?: string },
): Promise<void> {
  const workshopDetect = (window as any).__copydeck_copy_workshop_detect !== false;
  const compatdataDetect = (window as any).__copydeck_copy_compatdata_detect !== false;

  const hasWorkshop = workshopDetect && workshopSize > 0;
  const hasCompatdata = compatdataDetect && compatdataSize > 0;

  const doQueue = async (
    copyGame: boolean,
    copyWorkshop: boolean,
    copyCompatdata: boolean,
    conflictMode: ConflictMode = "skip",
  ) => {
    if (!copyGame && !copyWorkshop && !copyCompatdata) return;
    await queueGames([{
      appid: game.appid,
      name: game.name,
      src_library: game.library_path,
      dst_library: drive.path,
      copy_workshop: copyWorkshop,
      copy_compatdata: copyCompatdata,
      skip_game_files: !copyGame,
      conflict_mode: conflictMode,
    }]);
    const extras: string[] = [];
    if (copyWorkshop) extras.push("workshop");
    if (copyCompatdata) extras.push("compatdata");
    const label = extras.length > 0 ? `${game.name} + ${extras.join(" + ")}` : game.name;
    setTimeout(() => toaster.toast({ title: "Queued", body: label }), 350);
    forceRefresh();
  };

  const startSteamCopy = async (copyGame: boolean, copyWorkshop: boolean, copyCompatdata: boolean) => {
    if (!copyGame && !copyWorkshop && !copyCompatdata) return;
    const installdir = sizes?.installdir || game.name;
    const checks: Array<{ src: string; dst_dir: string }> = [];
    if (copyGame) {
      checks.push({
        src: `${game.library_path}/steamapps/common/${installdir}`,
        dst_dir: `${drive.path}/steamapps/common`,
      });
    }
    if (copyWorkshop) {
      checks.push({
        src: sizes?.workshop_path || `${game.library_path}/steamapps/workshop/content/${game.appid}`,
        dst_dir: `${drive.path}/steamapps/workshop/content`,
      });
    }
    if (copyCompatdata) {
      checks.push({
        src: sizes?.compatdata_path || `${game.library_path}/steamapps/compatdata/${game.appid}`,
        dst_dir: `${drive.path}/steamapps/compatdata`,
      });
    }
    const mode = await resolveConflictMode(checks);
    if (mode === null) return;
    await doQueue(copyGame, copyWorkshop, copyCompatdata, mode);
  };

  const srcDriveLabel = (() => {
    const p = game.library_path.split("/");
    if (p[1] === "run" && p[2] === "media") return p[4] ?? p[3] ?? "Source Drive";
    if (p[1] === "media") return p[3] ?? p[2] ?? "Source Drive";
    if (p[1] === "home") return "Internal Storage";
    return p[2] ?? "Source Drive";
  })();

  const gameFolderPath = sizes?.installdir
    ? `${game.library_path}/steamapps/common/${sizes.installdir}`
    : `${game.library_path}/steamapps/common/${game.name}`;
  const gameSizeStr = sizes?.game_size ? formatSize(sizes.game_size) : null;

  type SteamCopyKey = "game" | "workshop" | "compatdata";
  interface SteamCopyItem { key: SteamCopyKey; label: string; path: string; sizeStr: string | null; }
  const allItems: SteamCopyItem[] = [
    { key: "game", label: "Game files", path: gameFolderPath, sizeStr: gameSizeStr },
    ...(hasWorkshop ? [{ key: "workshop" as SteamCopyKey, label: "Workshop Content", path: sizes?.workshop_path ?? `${game.library_path}/steamapps/workshop`, sizeStr: workshopSize > 0 ? formatSize(workshopSize) : null }] : []),
    ...(hasCompatdata ? [{ key: "compatdata" as SteamCopyKey, label: "Compatdata", path: sizes?.compatdata_path ?? `${game.library_path}/steamapps/compatdata`, sizeStr: compatdataSize > 0 ? formatSize(compatdataSize) : null }] : []),
  ];

  if (!hasWorkshop && !hasCompatdata) {
    await startSteamCopy(true, false, false);
    return;
  }

  const ExtraContentModal = ({ closeModal }: { closeModal?: () => void }) => {
    const [skipped, setSkipped] = useState<Set<SteamCopyKey>>(new Set());
    const [skippedOpen, setSkippedOpen] = useState(false);
    const copyBtnRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      let frame: number;
      const tryFocus = () => { if (copyBtnRef.current) { copyBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
      frame = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(frame);
    }, []);

    const toggle = (key: SteamCopyKey) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    const active = allItems.filter(i => !skipped.has(i.key));
    const skippedItems = allItems.filter(i => skipped.has(i.key));
    const nothingToCopy = active.length === 0;

    const ItemCard = ({ item, inSkipped }: { item: SteamCopyItem; inSkipped: boolean }) => (
      <Focusable
        onActivate={() => toggle(item.key)}
        style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
      >
        <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: inSkipped ? "#555" : "#80cbc4", wordBreak: "break-all", marginBottom: 3 }}>{item.path}</div>
        <div style={{ display: "flex", gap: 10, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
          <span>📁 {srcDriveLabel}</span>
          {item.sizeStr && <span>· {item.sizeStr}</span>}
        </div>
      </Focusable>
    );

    return (
      <ModalRoot onCancel={closeModal}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Copy {game.name}</div>
          {active.map(item => <ItemCard key={item.key} item={item} inSkipped={false} />)}
          {skippedItems.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Focusable onActivate={() => setSkippedOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", cursor: "pointer", outline: "none" }}>
                <span style={{ fontSize: 11, color: "#888" }}>{skippedOpen ? "▼" : "▶"}</span>
                <span style={{ fontSize: 11, color: "#888" }}>Skipped ({skippedItems.length})</span>
              </Focusable>
              {skippedOpen && skippedItems.map(item => <ItemCard key={item.key} item={item} inSkipped={true} />)}
            </div>
          )}
          
        </DialogBody>
        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DialogButton
              ref={copyBtnRef}
              className={nothingToCopy ? undefined : "Primary"}
              disabled={nothingToCopy}
              style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToCopy ? 0.4 : 1 }}
              onClick={() => {
                closeModal?.();
                startSteamCopy(
                  !skipped.has("game"),
                  !skipped.has("workshop") && hasWorkshop,
                  !skipped.has("compatdata") && hasCompatdata,
                );
              }}
            >
              Copy
            </DialogButton>
            <DialogButton style={{ padding: "6px 10px", fontSize: 12, minHeight: 0 }} onClick={() => closeModal?.()}>Cancel</DialogButton>
          </Focusable>
        </DialogFooter>
      </ModalRoot>
    );
  };
  showModal(<ExtraContentModal />, window);
}

export async function showNonSteamDriveSubmenu(appid: string, gameDir: string, gameName: string): Promise<void> {
  const [drives, homeDir] = await Promise.all([getDrives(), getHomeDir()]);
  if (drives.length === 0) {
    toaster.toast({ title: "CopyDeck", body: "No drives found." });
    return;
  }

  // Resolve the actual source dir: try shortcut target first, then saved locations
  let resolvedGameDir = gameDir;
  let foundInSavedLocation = false;

  // ── Resolve actual game root ──────────────────────────────────────────────
  // Strategy (same order as before, plus stash only when StartDir is missing):
  //   1. Live shortcut StartDir if it exists on disk
  //   2. Session stash from a prior queued copy (cancel→retry when StartDir is gone/stale)
  //   3. Scan locations → dest-folder fallback
  //
  // Same-path recovery in doNonSteamCopy still uses stash/history when StartDir
  // incorrectly points at the destination partial.
  const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
  const stashedOrigin = getStashedNonSteamOrigin(appid);

  if (gameDir && await checkPathExists(gameDir)) {
    // Path exists — use it directly; no tree-walk needed. (unchanged happy path)
    resolvedGameDir = gameDir;
  } else if (stashedOrigin && await checkPathExists(stashedOrigin).catch(() => false)) {
    resolvedGameDir = stashedOrigin;
    foundInSavedLocation = true;
  } else {
    // Path missing or stale — fall back to scan-location tree-walk.
    // Build the parent chain: every path segment of gameDir from deepest to shallowest.
    const gameDirSegments = gameDir.replace(/\/$/, "").split("/").filter(Boolean);
    // Display name first (most reliable), then path segments deepest to shallowest.
    const namesToTry = [gameName, ...gameDirSegments];

    for (const loc of savedLocs) {
      const normLoc = loc.replace(/\/$/, "");
      for (const name of namesToTry) {
        const candidate = `${normLoc}/${name}`;
        if (await checkPathExists(candidate)) {
          resolvedGameDir = candidate;
          foundInSavedLocation = true;
          break;
        }
      }
      if (foundInSavedLocation) break;
    }
    // Scan locations came up empty — try dest subfolder on all drives as last resort
    if (!foundInSavedLocation) {
      const destHit = await findOnDestDrivesFor(gameName, "__copydeck_copy_dest_fallback", gameDir);
      if (destHit) { resolvedGameDir = destHit; foundInSavedLocation = true; }
    }
  }

  // ── Guard against system/launcher paths ──────────────────────────────────
  const SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap"];
  const isSystemPath = !resolvedGameDir.includes("/") ||
    SYSTEM_PREFIXES.some(p => resolvedGameDir === p || resolvedGameDir.startsWith(p + "/"));
  let gameIsSystemPath = false;
  if (isSystemPath && !foundInSavedLocation) {
    // Game folder is a system/flatpak path and scan locations didn't find it.
    // The launch options may still reference a rom we can copy — mark and continue.
    gameIsSystemPath = true;
  }

  // ── Game not found — don't bail yet ──────────────────────────────────────
  // If the game folder can't be located we still want to check launch options for a
  // ROM path before showing an error. Mark gameIsSystemPath=true so the per-drive
  // handler skips the game copy but still runs ROM detection. If no ROM is found
  // either, the handler will show the "can't copy" toast at that point.
  const gameNotFound = !foundInSavedLocation && !(await checkPathExists(resolvedGameDir)) && !gameIsSystemPath;
  if (gameNotFound) {
    gameIsSystemPath = true; // reuse the "skip game copy, try ROM" code path
  }

  // ── Copy root trimming ────────────────────────────────────────────────────
  // If resolvedGameDir was found inside a scan location but is still a subfolder
  // (e.g. scan loc matched "Launcher" before "Tarkov"), trim back to the first
  // segment under the scan location so we copy the whole game, not just the subfolder.
  const normalised = (p: string) => p.replace(/\/$/, "");
  const sortedLocs = [...savedLocs]
    .map(normalised)
    .sort((a, b) => b.length - a.length); // longest (most specific) first

  let copyRoot = resolvedGameDir;
  for (const loc of sortedLocs) {
    if (resolvedGameDir.startsWith(loc + "/")) {
      const remainder = resolvedGameDir.slice(loc.length + 1); // e.g. "MyGame/bin/x64"
      const gameRootName = remainder.split("/")[0];             // e.g. "MyGame"
      if (gameRootName) {
        copyRoot = `${loc}/${gameRootName}`;
        break;
      }
    }
  }
  resolvedGameDir = copyRoot;
  // ─────────────────────────────────────────────────────────────────────────

  const folderName = resolvedGameDir.replace(/\/$/, "").split("/").pop() ?? gameName;

  // Build the drive list for the Copy To menu.
  // When game and ROM live on SEPARATE drives both drives must appear as valid targets
  // (e.g. game on /home, ROM on /run/media/deck/SSD → user should be able to copy
  // the ROM to /home AND copy the game to the SSD).
  // We therefore collect ALL source drives (game + ROM — ROM is detected lazily in
  // onSelected, so we conservatively exclude only drives where ALL known items live).
  // Simplest correct rule: exclude a drive only if it is the SOLE source of content
  // AND no ROM could live elsewhere. Since we can't know the ROM drive at menu-build
  // time, we show every drive and let the per-drive copy handler deal with same-source
  // items (the backend already-there check handles those gracefully).
  const gameDrivePath = drives.find((d) => {
    const root = d.is_internal ? homeDir : d.path;
    return root && resolvedGameDir.startsWith(root);
  })?.path ?? null;

  // Only exclude the game's drive when it is the only drive present (nothing to copy to).
  // As soon as there are ≥2 drives we show all of them so a ROM on a different drive
  // doesn't silently disappear from the selector.
  const targets = drives.length > 1
    ? drives                                                  // show all drives
    : drives.filter((d) => d.path !== gameDrivePath);        // single-drive: nothing to show
  const rawDestSetting = ((window as any).__copydeck_nonsteam_dest as string | undefined)?.trim().replace(/^\//, "").replace(/\/$/, "") ?? "";
  const defaultDestSubfolder = rawDestSetting; // may be empty — means drive root
  const destSlots: { tag: string; subfolder: string }[] = (window as any).__copydeck_nonsteam_dest_slots ?? [];

  // Pick destination dir for a given absolute source path.
  // - Tagged slots: strip the source drive root from the path, mirror the remainder
  //   onto the destination. If the slot has a subfolder, nest under it first.
  //   e.g. tag=Emulation, no subfolder: /home/deck/Emulation → [drive]/Emulation
  //   e.g. tag=Emulation, subfolder=Games: /home/deck/Emulation → [drive]/Games/Emulation
  // - Default slot: [drive]/<destSubfolder>/<folderName> (original behaviour)
  // Pick destination path for a given absolute source path.
  // For both game folders and rom files: drop the name into the destination subfolder.
  // Tagged slots: if the source path contains the tag, use that slot's subfolder instead.
  // e.g. src=/home/deck/Emulation/roms/switch/game.nsp, tag=.nsp, subfolder=Games/Switch
  //   → [drive]/Games/Switch/game.nsp
  // e.g. src=/home/deck/Emulation/tools/ryujinx, tag=Emulation, no subfolder
  //   → [drive]/Emulation/ryujinx  (subfolder blank = drive root, then append name)
  // Default (no tag match): [drive]/<destSubfolder>/<name>
  const pickDstDir = (srcPath: string, driveRoot: string): string => {
    const name = srcPath.replace(/\/$/, "").split("/").pop() ?? folderName;
    for (const slot of destSlots) {
      if (!slot.tag || !srcPath.includes(slot.tag)) continue;
      const prefix = slot.subfolder ? `${driveRoot}/${slot.subfolder}` : driveRoot;
      return `${prefix}/${name}`;
    }
    return defaultDestSubfolder
      ? `${driveRoot}/${defaultDestSubfolder}/${name}`
      : `${driveRoot}/${name}`;
  };

  if (targets.length === 0) {
    toaster.toast({ title: "CopyDeck", body: "No other drives to copy to." });
    return;
  }

  // ── Lightweight Lutris detection for menu label accuracy ─────────────────
  // Check the three shortcut fields for Lutris signals (mirrors Python _detect_lutris_id).
  // This is a pure string check — no DB/file I/O — so it's instant.
  // If Lutris is detected we also resolve the install_dir so the label shows the
  // real game folder instead of the launcher path (e.g. "/usr/bin/lutris").
  let lutrisLabelSrcDir: string | null = null;
  {
    const snap = await getShortcutSnapshot(appid).catch(() => ({ exe: "", startDir: "", launchOptions: "" }));
    const combined = `${snap.exe} ${snap.startDir} ${snap.launchOptions}`;
    const isLutrisShortcut =
      combined.includes("lutris:rungameid/") ||
      combined.includes("lutris:rungame/") ||
      combined.includes("net.lutris.Lutris");
    if (isLutrisShortcut && (window as any).__copydeck_lutris_support !== false) {
      // Try to get the install_dir from the DB so the label is accurate.
      // Fall back to resolvedGameDir if the DB call fails or returns nothing.
      try {
        const lutrisResult = await detectLutrisShortcut(appid);
        if (lutrisResult.is_lutris && lutrisResult.game_info?.install_dir) {
          const rawDir = lutrisResult.game_info.install_dir;
          if (await checkPathExists(rawDir)) {
            lutrisLabelSrcDir = rawDir;
          } else {
            // install_dir stale — try tree-walk like doLutrisCopy does.
            // Filter out dest subfolder name and scan loc root names to avoid
            // matching infrastructure paths instead of the actual game folder.
            const locs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
            const scanLocNames = new Set(
              locs.map(l => l.replace(/\/$/, "").split("/").pop() ?? "").filter(Boolean)
            );
            const destSubName = rawDestSetting.split("/").pop() ?? "";
            const rawSegments = rawDir.replace(/\/$/, "").split("/").filter(Boolean);
            const safeSegments = rawSegments.filter(
              seg => !scanLocNames.has(seg) && seg !== destSubName
            );
            outer: for (const loc of locs) {
              for (const n of [gameName, ...safeSegments]) {
                const c = `${loc.replace(/\/$/, "")}/${n}`;
                if (await checkPathExists(c)) { lutrisLabelSrcDir = c; break outer; }
              }
            }
            // Scan locations also empty — try dest subfolder fallback
            if (!lutrisLabelSrcDir) {
              const destSubfolder = rawDestSetting;
              const namesToTry = [gameName, ...safeSegments].filter(Boolean);
              const allDrives = await getAllDrives().catch(() => [] as import("../utils/backendApi").Drive[]);
              outerDest: for (const drive of allDrives) {
                const root = destSubfolder ? `${drive.path}/${destSubfolder}` : drive.path;
                for (const name of namesToTry) {
                  const c = `${root}/${name}`;
                  if (await checkPathExists(c)) { lutrisLabelSrcDir = c; break outerDest; }
                }
              }
            }
          }
        }
      } catch {}
      // If DB gave nothing, fall back to resolvedGameDir (already resolved above)
      if (!lutrisLabelSrcDir) lutrisLabelSrcDir = resolvedGameDir;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Prefer Lutris install dir when known; otherwise the resolved game folder.
  const nsSizePath = !gameIsSystemPath ? (lutrisLabelSrcDir ?? resolvedGameDir) : "";
  const nsSizePromise = startDriveSelectorSizePromise(
    nsSizePath
      ? async () => {
          try {
            const r = await getPathSize(nsSizePath);
            return r?.success ? r.size_bytes : null;
          } catch {
            return null;
          }
        }
      : undefined,
  );

  showContextMenu(
    <Menu label="Copy To..." cancelText="Back">
      {targets.map((drive) => {
        const driveRoot = drive.is_internal ? homeDir : drive.path;
        // Use the resolved Lutris install dir for the label when available,
        // so the path shown matches where the copy will actually land.
        const labelSrc = lutrisLabelSrcDir ?? resolvedGameDir;
        const dstDir = pickDstDir(labelSrc, driveRoot);
        return (
          <MenuItem
            key={drive.path}
            onSelected={async () => {
              const numericAppid = parseInt(appid, 10);
              // Read current raw exe + launch options fresh from VDF (Steam flushes synchronously).
              // Snapshot all three fields from VDF in one pass for history
              const currentSnapshot = await getShortcutSnapshot(appid).catch(() => ({ exe: "", startDir: "", launchOptions: "" }));
              const currentExe = currentSnapshot.exe;
              const rawExe = await getShortcutRawExe(appid).catch(() => "");
              const launchOptions = currentSnapshot.launchOptions || await getShortcutLaunchOptions(appid).catch(() => "");

              // Compute the old game folder prefix as the shortcut knows it.
              // currentExe from getShortcutSnapshot strips only the leading quote so it may
              // contain the full raw command string — unreliable for segment splitting.
              // Search rawExe directly for the game folder name instead.
              let oldGameDirInShortcut = resolvedGameDir;
              if (foundInSavedLocation) {
                const _gfn = resolvedGameDir.replace(/\/$/, "").split("/").pop() ?? "";
                if (_gfn && rawExe) {
                  const _needle = "/" + _gfn;
                  const _ni = rawExe.indexOf(_needle);
                  if (_ni !== -1) {
                    let _ps = _ni;
                    while (_ps > 0 && rawExe[_ps - 1] !== '"' && rawExe[_ps - 1] !== "'" && rawExe[_ps - 1] !== " ") _ps--;
                    oldGameDirInShortcut = rawExe.slice(_ps, _ni + _needle.length);
                  }
                }
              }

              // ── Detect absolute paths in launch options that are outside the game folder ──
              const SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap", "/run/host"];
              const absPathRe = /(?:"'([^']+)'"|"([^"]+)"|'([^']+)'|(?:^|\s)(\/[^\s"']+))/g;

              // Build a list of all known drive roots so we can detect when a path
              // already lives on a different drive (i.e. was previously copied there).
              const allDriveRoots = drives.map(d => d.is_internal ? homeDir : d.path).filter(Boolean);

              // Strip any known drive root prefix from a path and return the relative portion.
              // e.g. "/run/media/deck/SSD/Emulation/roms/switch/game.nsp" + homeDir="/home/deck"
              //   → "Emulation/roms/switch/game.nsp"
              const stripDriveRoot = (p: string): string | null => {
                for (const root of allDriveRoots) {
                  if (p.startsWith(root + "/")) return p.slice(root.length + 1);
                }
                return null;
              };

              let externalRomPath: string | null = null;  // resolved source path we will copy FROM
              let externalRomPathInLaunchOptions: string | null = null; // raw path as it appears in launch options
              let romFoundInField: "launchOptions" | "exe" | null = null; // which shortcut field the ROM path came from

              const romDetectEnabled = (window as any).__copydeck_rom_detect_enabled !== false;
              const romScanDepth: number = (window as any).__copydeck_rom_scan_depth ?? 3;

              // Scan a string for external ROM paths. Returns { romPath, romPathInField } or null.
              const scanFieldForRom = async (fieldText: string, skipFirstToken: boolean): Promise<{ romPath: string; romPathInField: string } | null> => {
                const reLocal = /(?:"'([^']+)'"|"([^"]+)"|'([^']+)'|(?:^|\s)(\/[^\s"']+))/g;
                let m: RegExpExecArray | null;
                let tokenIndex = 0;
                while ((m = reLocal.exec(fieldText)) !== null) {
                  const p = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
                  if (!p || !p.startsWith("/")) continue;
                  tokenIndex++;
                  // When scanning the Exe field, skip the first token (the emulator path)
                  if (skipFirstToken && tokenIndex === 1) continue;
                  if (SYSTEM_PREFIXES.some(sp => p === sp || p.startsWith(sp + "/"))) continue;

                  const exists = await checkPathExists(p).catch(() => false);
                  if (exists) {
                    const dstRoot = drive.is_internal ? homeDir : drive.path;
                    if (p.startsWith(dstRoot + "/")) {
                      const rel = stripDriveRoot(p);
                      if (rel) {
                        let foundOnSource: string | null = null;
                        for (const root of allDriveRoots) {
                          if (root === dstRoot) continue;
                          const candidate = `${root}/${rel}`;
                          if (await checkPathExists(candidate).catch(() => false)) {
                            foundOnSource = candidate; break;
                          }
                        }
                        if (foundOnSource) return { romPath: foundOnSource, romPathInField: p };
                      }
                    } else {
                      return { romPath: p, romPathInField: p };
                    }
                  }

                  // Path not found — scan saved locations by filename
                  const fileName = p.split("/").pop();
                  if (fileName) {
                    const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
                    const scanDir = async (dir: string, depthLeft: number): Promise<string | null> => {
                      if (await checkPathExists(`${dir}/${fileName}`).catch(() => false)) return `${dir}/${fileName}`;
                      if (depthLeft <= 0) return null;
                      const entries = await listDir(dir).catch(() => []);
                      for (const e of entries.filter(e => e.is_dir)) {
                        const found = await scanDir(e.path, depthLeft - 1);
                        if (found) return found;
                      }
                      return null;
                    };
                    for (const loc of savedLocs) {
                      const found = await scanDir(loc.replace(/\/$/, ""), romScanDepth);
                      if (found) return { romPath: found, romPathInField: p };
                    }
                  }
                }
                return null;
              };

              if (romDetectEnabled) {
                // First scan launch options (most common location for ROM paths)
                if (launchOptions) {
                  const hit = await scanFieldForRom(launchOptions, false);
                  if (hit) {
                    externalRomPath = hit.romPath;
                    externalRomPathInLaunchOptions = hit.romPathInField;
                    romFoundInField = "launchOptions";
                  }
                }
                // If not found in launch options, scan the Exe field (e.g. Ryujinx style:
                // "/path/to/emulator.AppImage" --flag "/path/to/rom.nsp")
                if (!externalRomPath && rawExe) {
                  const hit = await scanFieldForRom(rawExe, true);
                  if (hit) {
                    externalRomPath = hit.romPath;
                    externalRomPathInLaunchOptions = hit.romPathInField;
                    romFoundInField = "exe";
                  }
                }
              }



              // Rom destination uses the same tagged/default routing as the game folder.
              // pickDstDir mirrors the source path relative to its drive root, respecting
              // any tagged slots, so roms land in the right place automatically.
              const romDstPath = externalRomPath
                ? pickDstDir(externalRomPath, driveRoot)
                : null;

              // ── remapPaths helper ──────────────────────────────────────────
              const remapPaths = (cmd: string, oldDir: string, newDir: string): string => {
                if (!cmd || !oldDir) return cmd;
                const escaped = oldDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                // 1. Double-quoted wrapping single-quoted path: "'/old/path/...'"
                cmd = cmd.replace(
                  new RegExp(`"'(${escaped}[^']*)'"`,"g"),
                  (_match, p) => `"'${newDir}${p.slice(oldDir.length)}'"`
                );
                // 2. Plain double-quoted paths
                cmd = cmd.replace(
                  new RegExp(`"(${escaped}[^"]*)"`, "g"),
                  (_match, p) => `"${newDir}${p.slice(oldDir.length)}"`
                );
                // 3. Plain single-quoted paths
                cmd = cmd.replace(
                  new RegExp(`'(${escaped}[^']*)'`, "g"),
                  (_match, p) => `'${newDir}${p.slice(oldDir.length)}'`
                );
                // 4. Unquoted bare paths
                cmd = cmd.replace(
                  new RegExp(`(^|\\s)(${escaped}[^\\s"']*)`, "g"),
                  (_match, pre, p) => `${pre}${newDir}${p.slice(oldDir.length)}`
                );
                return cmd;
              };

              // ── Compatdata detection ──────────────────────────────────────
              const nonSteamCompatdataDetect = (window as any).__copydeck_nonsteam_compatdata_detect !== false;
              // Destination steamapps folder for compatdata — use drive.path (the VDF library
              // root) not driveRoot, so internal correctly resolves to ~/.local/share/Steam/steamapps
              // rather than ~/steamapps. Mirrors exactly what Steam game copies use as dst_root.
              // For internal drives, always use the Steam library's own steamapps folder.
              // For external drives: use nonsteam_prefix_dest setting if set, else drive root steamapps.
              const nsPrefixDestSetting = ((window as any).__copydeck_nonsteam_prefix_dest as string | undefined)?.trim().replace(/\/$/, "") ?? "";
              const dstSteamapps = drive.is_internal
                ? `${drive.path}/steamapps`
                : nsPrefixDestSetting
                  ? nsPrefixDestSetting
                  : `${drive.path}/steamapps`;

              // ── Core copy executor ────────────────────────────────────────
              const doNonSteamCopy = async (copyGame: boolean, copyRom: boolean, copyCompatdata: boolean = false) => {
                // After a cancelled partial copy, resolution can point source at the
                // incomplete destination (StartDir remapped / dest-fallback). Recover
                // the real origin instead of aborting — that's what makes skip/overwrite
                // resume work on retry.
                let gameSrc = resolvedGameDir;
                let romSrc = externalRomPath;
                if (copyGame && gameSrc && normPath(gameSrc) === normPath(dstDir)) {
                  const alt = await findAlternateNonSteamSource(appid, gameName, gameDir || gameSrc, dstDir);
                  if (alt) {
                    gameSrc = alt;
                  } else {
                    toaster.toast({
                      title: "CopyDeck",
                      body: "Can't find the original game folder to copy from (source is the same as the destination). Add it under Non-Steam scan locations.",
                    });
                    return;
                  }
                }
                if (copyRom && romSrc && romDstPath && normPath(romSrc) === normPath(romDstPath)) {
                  const altRom = await findAlternateRomSource(
                    appid,
                    romSrc,
                    romDstPath,
                    allDriveRoots,
                  );
                  if (altRom) {
                    romSrc = altRom;
                  } else {
                    toaster.toast({
                      title: "CopyDeck",
                      body: "Can't find the original ROM to copy from (source is the same as the destination).",
                    });
                    return;
                  }
                }

                const checks: Array<{ src: string; dst_dir: string }> = [];
                if (copyGame && gameSrc) {
                  const dstParent = dstDir.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";
                  checks.push({ src: gameSrc, dst_dir: dstParent });
                }
                if (copyRom && romSrc && romDstPath) {
                  const romParent = romDstPath.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";
                  checks.push({ src: romSrc, dst_dir: romParent });
                }
                if (copyCompatdata && nonSteamCompatdataDetect && nonSteamCompatdataSrcPath) {
                  checks.push({ src: nonSteamCompatdataSrcPath, dst_dir: `${dstSteamapps}/compatdata` });
                }
                const conflictMode = await resolveConflictMode(checks);
                if (conflictMode === null) return;

                // Copy compatdata first (fast, synchronous on backend)
                if (copyCompatdata && nonSteamCompatdataDetect) {
                  try {
                    const cr = await copyNonSteamCompatdata(appid, dstSteamapps, nonSteamCompatdataSrcPath, conflictMode);
                    if (!cr.success) {
                      toaster.toast({ title: "Compatdata copy failed", body: cr.error ?? "Unknown error" });
                    }
                  } catch {}
                }

                if (copyGame && gameSrc) {
                  // Remember distinct origin so a later cancel → retry still finds it.
                  if (normPath(gameSrc) !== normPath(dstDir)) {
                    stashNonSteamOrigin(appid, gameSrc);
                  }
                  const jobId = `nonsteam_${appid}_${Date.now()}`;
                  const r = await copyNonSteam(jobId, gameSrc, dstDir, gameName, conflictMode);
                  if (r.success) {
                    setTimeout(() => toaster.toast({ title: "Queued", body: gameName }), 350);
                    forceRefresh();
                    (async () => {
                      for (let i = 0; i < 1800; i++) {
                        await new Promise(res => setTimeout(res, 1000));
                        try {
                          const prog = await getCopyProgress(jobId);
                          if (prog.done && !prog.error && prog.status !== "cancelled" && !prog.already_existed) {
                            // jobNotifier handles the completion/already-there toast.
                            // Only remap after a real copy — remapping on already_existed can
                            // point the shortcut at a leftover partial from a cancelled run.
                            //
                            // Strategy: find the old game folder prefix as the shortcut knows it,
                            // then call remapPaths() on the full raw exe string — exactly the same
                            // way the direct-path case has always worked. This ensures the exe,
                            // any embedded ISO/ROM paths, and extra args all get updated in one pass.
                            //
                            // For direct-path copies the prefix is just resolvedGameDir.
                            // For scan-location copies resolvedGameDir is where we found the game
                            // on disk (e.g. /run/media/deck/SD/Xenia) but currentExe still uses
                            // the old stale shortcut path (e.g. /home/deck/Games/Xenia/xenia.exe).
                            // We recover the old prefix by finding the game folder name as a
                            // segment inside currentExe and taking everything up to that segment.
                            //
                            // SetShortcutStartDir always gets dstDir unconditionally because we
                            // copied the whole game folder there.

                            let newRawExe = rawExe;
                            let newExePath = dstDir; // safe default

                            if (rawExe) {
                              // Remap ALL occurrences of the old game dir in the raw string.
                              // This handles the exe path, embedded ISO/ROM paths, and any
                              // extra args — identical behaviour to the direct-path case.
                              newRawExe = remapPaths(rawExe, oldGameDirInShortcut, dstDir);
                            }

                            if (newRawExe && newRawExe !== rawExe) {
                              // Extract the new exe path from the first quoted token.
                              const firstQuoted = newRawExe.match(/^"([^"]+)"/);
                              if (firstQuoted && firstQuoted[1].startsWith("/")) {
                                newExePath = firstQuoted[1];
                              }
                              // else newExePath stays as dstDir (safe default)
                            } else if (currentExe && currentExe.startsWith("/")) {
                              // remapPaths had no effect — exe is outside the game folder
                              // (system emulator, etc.). Leave it unchanged.
                              newExePath = currentExe;
                            }

                            // Remap launch options for game-dir paths only
                            let newLaunchOptions: string | null = null;
                            if (launchOptions) {
                              const remapped = remapPaths(launchOptions, gameSrc, dstDir);
                              if (remapped !== launchOptions) newLaunchOptions = remapped;
                            }
                            const quotedExe = `"${newExePath}"`;
                            const quotedDir = `"${dstDir}"`;
                            try {
                              if ((window as any).__copydeck_auto_set_target !== false) {
                                (window as any).SteamClient?.Apps?.SetShortcutExe?.(numericAppid, newRawExe || quotedExe);
                                (window as any).SteamClient?.Apps?.SetShortcutStartDir?.(numericAppid, quotedDir);
                                if (newLaunchOptions !== null) {
                                  (window as any).SteamClient?.Apps?.SetShortcutLaunchOptions?.(numericAppid, newLaunchOptions);
                                }
                                const dirs = (window as any).__copydeck_shortcut_dirs ?? {};
                                dirs[appid] = dstDir;
                                (window as any).__copydeck_shortcut_dirs = dirs;
                              }
                              // History keeps the pre-copy origin; stash now follows the new home.
                              if (currentExe) await addTargetHistory(numericAppid, { ...currentSnapshot, exe: currentExe });
                              stashNonSteamOrigin(appid, dstDir);
                            } catch (e) {
                              toaster.toast({ title: "Copy done, shortcut update failed", body: String(e) });
                            }
                            break;
                          } else if (prog.done && prog.error) {
                            break;
                          }
                        } catch { break; }
                      }
                    })();
                  } else {
                    toaster.toast({ title: "Copy failed", body: r.error ?? "Unknown error" });
                  }
                }

                if (copyRom && romSrc && romDstPath) {
                  if (normPath(romSrc) !== normPath(romDstPath)) {
                    stashRomOrigin(appid, romSrc);
                  }
                  const romJobId = `nonsteam_rom_${appid}_${Date.now()}`;
                  const romName = romSrc.split("/").pop() ?? "rom";
                  const r2 = await copyNonSteamFile(romJobId, romSrc, romDstPath, romName, conflictMode);
                  if (r2.success) {
                    setTimeout(() => toaster.toast({ title: "Queued", body: romName }), 400);
                    forceRefresh();
                    (async () => {
                      for (let i = 0; i < 1800; i++) {
                        await new Promise(res => setTimeout(res, 1000));
                        try {
                          const prog = await getCopyProgress(romJobId);
                          if (prog.done && !prog.error && prog.status !== "cancelled" && !prog.already_existed) {
                            // jobNotifier handles the completion/already-there toast.
                            // Remap only after a real copy (not a no-op already-there skip).
                            // Remap launch options: replace whatever path appears in launch
                            // options with the destination path (from tagged/default routing).
                            // We replace both the path-as-in-launch-options and externalRomPath
                            // to handle cases where the shortcut was already remapped once before.
                            if ((window as any).__copydeck_auto_set_target !== false) {
                              if (romFoundInField === "exe" && rawExe) {
                                // ROM path was in the Exe field (e.g. Xenia-style shortcut with
                                // exe + ISO in the same field). Read fresh from VDF so we don't
                                // overwrite the xenia path that the game copy handler already updated.
                                const freshRawExe = await getShortcutRawExe(String(numericAppid)).catch(() => rawExe);
                                // The original ISO path as it appeared in the shortcut at scan time.
                                const origRomPathInField = externalRomPathInLaunchOptions ?? romSrc;
                                // If the game copy handler already ran, it will have remapped the ISO
                                // path from oldGameDirInShortcut → dstDir (same as the exe). Try that
                                // mutated form first; fall back to the original scan-time path.
                                const gameRemappedRomPath = remapPaths(origRomPathInField, oldGameDirInShortcut, dstDir);
                                const searchPath = freshRawExe.includes(gameRemappedRomPath)
                                  ? gameRemappedRomPath
                                  : origRomPathInField;
                                const remappedExe = remapPaths(freshRawExe, searchPath, romDstPath!);
                                if (remappedExe !== freshRawExe) {
                                  (window as any).SteamClient?.Apps?.SetShortcutExe?.(numericAppid, remappedExe);
                                }
                              } else if (launchOptions) {
                                // ROM path was in launch options (standard case)
                                let remapped = launchOptions;
                                // Try replacing as it appears in launch options first
                                if (externalRomPathInLaunchOptions) {
                                  remapped = remapPaths(remapped, externalRomPathInLaunchOptions, romDstPath!);
                                }
                                // Also replace the resolved source path (catches double-remap cases)
                                if (romSrc && remapped === launchOptions) {
                                  remapped = remapPaths(remapped, romSrc, romDstPath!);
                                }
                                if (remapped !== launchOptions) {
                                  (window as any).SteamClient?.Apps?.SetShortcutLaunchOptions?.(numericAppid, remapped);
                                }
                              }
                              // When copyGame is also true the game copy handler owns the exe remap —
                              // don't touch it here or we risk corrupting a path already updated.

                              // Save a history snapshot for ROM-only copies so the old launch
                              // options / exe (pre-remap) can be restored later. When copyGame
                              // is also true, the game copy handler above already saves
                              // currentSnapshot — don't double-write here.
                              if (!copyGame) {
                                await addTargetHistory(numericAppid, currentSnapshot);
                              }
                              stashRomOrigin(appid, romDstPath!);
                            }
                            break;
                          } else if (prog.done && prog.error) {
                            break;
                          }
                        } catch { break; }
                      }
                    })();
                  } else {
                    toaster.toast({ title: "Rom copy failed", body: r2.error ?? "Unknown error" });
                  }
                }
              };

              // ── Lutris copy executor ──────────────────────────────────────
              const doLutrisCopy = async (copyPrefix: boolean = true, copyGame: boolean = true) => {
                if (!lutrisGameInfo) return;
                const lutPrefixDestSetting = ((window as any).__copydeck_lutris_prefix_dest as string | undefined)?.trim().replace(/\/$/, "") ?? "";
                // Use the selected drive for the prefix destination, not always internal.
                // Matches how non-Steam dstSteamapps is derived from drive.path.
                const dstPrefixDir = lutPrefixDestSetting
                  ? lutPrefixDestSetting
                  : drive.is_internal
                    ? `${homeDir}/Prefixes`
                    : `${drive.path}/Prefixes`;

                // ── Resolve Lutris source dir ─────────────────────────────────────────
                // Strategy: raw install_dir first, then path-segment walk, then name walk.
                // Path segments from install_dir are tried before gameName to avoid
                // matching a different game that happens to share the same display name.
                const rawInstallDir = lutrisGameInfo.install_dir ?? resolvedGameDir;
                let lutrisSrcDir = rawInstallDir;
                const lutrisSavedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
                let lutrisFoundInSavedLoc = false;

                if (await checkPathExists(rawInstallDir)) {
                  // Raw path exists — use it directly; no scan needed.
                  lutrisSrcDir = rawInstallDir;
                } else if (lutrisSavedLocs.length > 0) {
                  // Raw path missing — fall back to tree-walk.
                  // Filter installSegments to exclude the dest subfolder name and any
                  // bare scan location root names — these are infrastructure paths, not
                  // game folder names, and matching them causes the wrong game to be picked
                  // up (e.g. a "test" dest subfolder matching a "test" scan location entry).
                  const installSegments = rawInstallDir.replace(/\/$/, "").split("/").filter(Boolean);
                  const scanLocNames = new Set(
                    lutrisSavedLocs.map(l => l.replace(/\/$/, "").split("/").pop() ?? "").filter(Boolean)
                  );
                  const destSubfolderName = rawDestSetting.split("/").pop() ?? "";
                  const safeSegments = installSegments.filter(
                    seg => !scanLocNames.has(seg) && seg !== destSubfolderName
                  );
                  const lutrisNamesToTry = [gameName, ...safeSegments];
                  outer: for (const loc of lutrisSavedLocs) {
                    const normLoc = loc.replace(/\/$/, "");
                    for (const name of lutrisNamesToTry) {
                      const candidate = `${normLoc}/${name}`;
                      if (await checkPathExists(candidate)) {
                        lutrisSrcDir = candidate;
                        lutrisFoundInSavedLoc = true;
                        break outer;
                      }
                    }
                  }
                }
                // Trim to game root (same copy-root logic as non-Steam)
                if (lutrisFoundInSavedLoc) {
                  const sortedLutrisLocs = [...lutrisSavedLocs]
                    .map(l => l.replace(/\/$/, ""))
                    .sort((a, b) => b.length - a.length);
                  for (const loc of sortedLutrisLocs) {
                    if (lutrisSrcDir.startsWith(loc + "/")) {
                      const rem = lutrisSrcDir.slice(loc.length + 1);
                      const root = rem.split("/")[0];
                      if (root) { lutrisSrcDir = `${loc}/${root}`; break; }
                    }
                  }
                } else if (!(await checkPathExists(lutrisSrcDir))) {
                  // Scan locations empty — try dest subfolder on all drives as last resort
                  const destHit = await findOnDestDrivesFor(gameName, "__copydeck_copy_dest_fallback", rawInstallDir);
                  if (destHit) {
                    lutrisSrcDir = destHit;
                  } else {
                    toaster.toast({ title: "Lutris game not found", body: `Could not locate "${gameName}". Add its folder in Non-Steam scan locations.` });
                    return;
                  }
                }
                // ─────────────────────────────────────────────────────────────────────

                // Guard against copying system/flatpak paths — same as non-Steam.
                const LUTRIS_SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap", "/run/host"];
                if (LUTRIS_SYSTEM_PREFIXES.some(sp => lutrisSrcDir === sp || lutrisSrcDir.startsWith(sp + "/"))) {
                  toaster.toast({ title: "Can't copy — root path", body: `"${gameName}" resolved to a system path. Check the install_dir in Lutris.` });
                  return;
                }

                // dst mirrors non-Steam: same folder name under the drive's steamapps/../<name>
                // Use pickDstDir so Lutris copies respect __copydeck_nonsteam_dest and tagged slots,
                // exactly like non-Steam games do.
                const lutrisDstDir = pickDstDir(lutrisSrcDir, driveRoot);

                if (!copyGame && !copyPrefix) return;

                const lutChecks: Array<{ src: string; dst_dir: string }> = [];
                if (copyGame) {
                  const lutParent = lutrisDstDir.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";
                  lutChecks.push({ src: lutrisSrcDir, dst_dir: lutParent });
                }
                if (copyPrefix) {
                  const pfxSrc = lutrisPrefixSrcPath || lutrisGameInfo.prefix_path || "";
                  if (pfxSrc) {
                    lutChecks.push({ src: pfxSrc, dst_dir: dstPrefixDir });
                  }
                }
                const lutConflictMode = await resolveConflictMode(lutChecks);
                if (lutConflictMode === null) return;

                const jobId = `lutris_${appid}_${Date.now()}`;
                const r = await copyLutrisGame(
                  jobId,
                  lutrisSrcDir,
                  lutrisDstDir,
                  gameName,
                  lutrisGameInfo.id ?? 0,
                  lutrisGameInfo.pga_db ?? "",
                  lutrisGameInfo.yml_path ?? "",
                  // Only pass prefix args when the user chose to copy the prefix.
                  // Use lutrisPrefixSrcPath (resolved by findLutrisPrefix) not prefix_path
                  // from the DB, which may be stale if the prefix was previously moved.
                  // Backend passes empty string for prefix_path → skips prefix copy and
                  // leaves the YML prefix entry unchanged (update_lutris_paths only writes
                  // new_prefix_path when non-empty).
                  copyPrefix ? (lutrisPrefixSrcPath || lutrisGameInfo.prefix_path || "") : "",
                  copyPrefix ? dstPrefixDir : "",
                  copyGame,
                  lutConflictMode,
                );
                if (r.success) {
                  setTimeout(() => toaster.toast({ title: "Queued", body: gameName }), 350);
                  forceRefresh();
                  // ── Completion loop ── poll until done, then save history snapshot.
                  // Do NOT update SetShortcutExe / StartDir / LaunchOptions for Lutris —
                  // those are managed by Lutris itself. Save a history entry with the
                  // source state so restoring it points Lutris back to where things were.
                  (async () => {
                    for (let i = 0; i < 1800; i++) {
                      await new Promise(res => setTimeout(res, 1000));
                      try {
                        const prog = await getCopyProgress(jobId);
                        if (prog.done && !prog.error && prog.status !== "cancelled") {
                          try {
                            // Save snapshot of the *source* state (mirrors non-Steam).
                            // lutrisPrefixPath is only recorded when the prefix was actually
                            // copied — if game-only, leave it blank so restore doesn't move it.
                            await addTargetHistory(numericAppid, {
                              exe: currentExe || lutrisSrcDir,
                              startDir: currentSnapshot.startDir || lutrisSrcDir,
                              launchOptions: launchOptions ?? "",
                              isLutris: true,
                              lutrisId: lutrisGameInfo.id ?? 0,
                              lutrisPgaDb: lutrisGameInfo.pga_db ?? "",
                              lutrisYmlPath: lutrisGameInfo.yml_path ?? "",
                              lutrisInstallDir: lutrisSrcDir,
                              lutrisPrefixPath: copyPrefix
                                ? (lutrisPrefixSrcPath || lutrisGameInfo.prefix_path || "")
                                : "",
                            });
                          } catch {}
                          break;
                        } else if (prog.done && prog.error) {
                          break;
                        }
                      } catch { break; }
                    }
                  })();
                } else {
                  toaster.toast({ title: "Lutris copy failed", body: r.error ?? "Unknown error" });
                }
              };

              // ── Lutris detection (runs first — skip non-Steam compatdata if Lutris) ──
              let isLutrisGame = false;
              let lutrisGameInfo: LutrisGameInfo | null = null;
              let hasLutrisPrefix = false;
              let lutrisPrefixSrcPath: string = "";
              if ((window as any).__copydeck_lutris_support !== false) try {
                const lutrisResult = await detectLutrisShortcut(appid);
                if (lutrisResult.is_lutris && lutrisResult.game_info) {
                  isLutrisGame = true;
                  lutrisGameInfo = lutrisResult.game_info;
                  // Check for an existing prefix to copy
                  const lutPrefixDestSetting = ((window as any).__copydeck_lutris_prefix_dest as string | undefined)?.trim().replace(/\/$/, "") ?? "";
                  // Pass all other drive roots so find_lutris_prefix can look for the
                  // prefix on external drives using the same dest subfolder pattern.
                  const otherDriveRoots = drives
                    .filter(d => d.path !== (drive.is_internal ? homeDir : drive.path))
                    .map(d => d.is_internal ? homeDir : d.path)
                    .join(",");
                  const lpResult = await findLutrisPrefix(appid, lutrisGameInfo.prefix_path ?? "", lutPrefixDestSetting, otherDriveRoots);
                  hasLutrisPrefix = lpResult.found === true;
                  lutrisPrefixSrcPath = lpResult.path ?? "";
                }
              } catch {}

              // ── Compatdata existence check ───────────────────────────────
              let hasNonSteamCompatdata = false;
              let nonSteamCompatdataSrcPath: string = "";
              // Skip non-Steam compatdata detection for Lutris games — handled above
              if (!isLutrisGame && nonSteamCompatdataDetect) {
                try {
                  // Pass resolvedGameDir so the backend checks the game's current drive
                  // first (covers already-copied games on external drives) then falls back
                  // to Steam's own install steamapps.
                  const cdResult = await findNonSteamCompatdata(appid, resolvedGameDir);
                  hasNonSteamCompatdata = cdResult.found === true;
                  nonSteamCompatdataSrcPath = cdResult.path ?? "";
                } catch {}
              }

              // ── Show modal if extra content detected, else copy directly ──
              const needsModal = (externalRomPath && romDstPath) || isLutrisGame || (!isLutrisGame && hasNonSteamCompatdata);

              if (gameIsSystemPath && !isLutrisGame && !externalRomPath) {
                toaster.toast({ title: "CopyDeck", body: `Game folder not found for "${gameName}" and no ROM detected. Add its location in Non-Steam settings.` });
              } else if (!needsModal) {
                // Nothing extra detected — copy directly
                if (isLutrisGame) {
                  await doLutrisCopy(false);
                } else {
                  await doNonSteamCopy(true, false, false);
                }
              } else {
                // Unified copy modal with skippable cards
                const getDriveLabel = (path: string) => {
                  const p = path.split("/");
                  if (p[1] === "run" && p[2] === "media") return p[4] ?? p[3] ?? "Drive";
                  if (p[1] === "media") return p[3] ?? p[2] ?? "Drive";
                  if (p[1] === "home") return "Internal Storage";
                  return p[2] ?? "Drive";
                };

                type NSCopyKey = "game" | "rom" | "compatdata" | "prefix";
                interface NSCopyItem { key: NSCopyKey; label: string; path: string; driveLabel: string; sizeStr: string | null; }

                const copyItems: NSCopyItem[] = [];

                // ROM — skippable
                if (externalRomPath && romDstPath) {
                  copyItems.push({ key: "rom", label: "ROM file", path: externalRomPath, driveLabel: getDriveLabel(externalRomPath), sizeStr: null });
                }

                // Game folder — skippable; for Lutris use lutrisLabelSrcDir (resolved independently
                // of gameDir which typically points at the Lutris launcher binary, not the game)
                if (isLutrisGame ? !!lutrisLabelSrcDir : !gameIsSystemPath) {
                  const gameFolderPath = isLutrisGame ? (lutrisLabelSrcDir ?? resolvedGameDir) : resolvedGameDir;
                  copyItems.push({ key: "game", label: "Game folder", path: gameFolderPath, driveLabel: getDriveLabel(gameFolderPath), sizeStr: null });
                }

                // Lutris prefix — skippable
                if (isLutrisGame && hasLutrisPrefix) {
                  copyItems.push({ key: "prefix", label: "Wine prefix", path: lutrisPrefixSrcPath, driveLabel: getDriveLabel(lutrisPrefixSrcPath), sizeStr: null });
                }

                // Non-Steam compatdata — skippable
                if (!isLutrisGame && hasNonSteamCompatdata) {
                  copyItems.push({ key: "compatdata", label: "Proton prefix (compatdata)", path: nonSteamCompatdataSrcPath || `${dstSteamapps}/compatdata/${appid}`, driveLabel: getDriveLabel(nonSteamCompatdataSrcPath || dstSteamapps), sizeStr: null });
                }

                // Load sizes async inside modal
                const autoSkipGameFolder: boolean = (window as any).__copydeck_auto_skip_game_folder !== false;
                const hasRomItem = copyItems.some(i => i.key === "rom");
                const hasGameItem = copyItems.some(i => i.key === "game");
                const initialSkipped: Set<NSCopyKey> = new Set(
                  autoSkipGameFolder && hasRomItem && hasGameItem ? ["game"] : []
                );
                const NonSteamCopyModal = ({ closeModal }: { closeModal?: () => void }) => {
                  const [sizeMap, setSizeMap] = useState<Partial<Record<NSCopyKey, string>>>({});
                  const [skipped, setSkipped] = useState<Set<NSCopyKey>>(initialSkipped);
                  const [skippedOpen, setSkippedOpen] = useState(false);
                  const copyBtnRef = useRef<HTMLDivElement>(null);

                  useEffect(() => {
                    let frame: number;
                    const tryFocus = () => { if (copyBtnRef.current) { copyBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
                    frame = requestAnimationFrame(tryFocus);
                    return () => cancelAnimationFrame(frame);
                  }, []);

                  useEffect(() => {
                    const load = async () => {
                      const updates: Partial<Record<NSCopyKey, string>> = {};
                      for (const item of copyItems) {
                        if (item.path) {
                          try {
                            const r = await getPathSize(item.path);
                            if (r?.success && r.size_bytes) updates[item.key] = formatSize(r.size_bytes);
                          } catch {}
                        }
                      }
                      setSizeMap(updates);
                    };
                    load();
                  }, []);

                  const toggle = (key: NSCopyKey) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
                  const active = copyItems.filter(i => !skipped.has(i.key));
                  const skippedItems = copyItems.filter(i => skipped.has(i.key));
                  const nothingToCopy = active.length === 0;

                  const ItemCard = ({ item, inSkipped }: { item: NSCopyItem; inSkipped: boolean }) => (
                    <Focusable
                      onActivate={() => toggle(item.key)}
                      style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
                    >
                      <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
                      <div style={{ fontFamily: "monospace", fontSize: 10, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all", marginBottom: 3 }}>{item.path}</div>
                      <div style={{ display: "flex", gap: 10, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
                        <span>📁 {item.driveLabel}</span>
                        {sizeMap[item.key] && <span>· {sizeMap[item.key]}</span>}
                      </div>
                    </Focusable>
                  );

                  const doCopy = async () => {
                    closeModal?.();
                    if (isLutrisGame) {
                      await doLutrisCopy(!skipped.has("prefix"), !skipped.has("game"));
                    } else {
                      const copyGame = !skipped.has("game") && !gameIsSystemPath;
                      const copyRom = !skipped.has("rom") && !!externalRomPath && !!romDstPath;
                      const copyCompatdata = !skipped.has("compatdata") && hasNonSteamCompatdata;
                      await doNonSteamCopy(copyGame, copyRom, copyCompatdata);
                    }
                  };

                  return (
                    <ModalRoot onCancel={closeModal}>
                      <DialogBody>
                        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Copy {gameName}</div>
                        {gameIsSystemPath && !isLutrisGame && (
                          <div style={{ fontSize: 11, color: "#ff8a65", background: "rgba(255,80,0,0.1)", borderRadius: 4, padding: "5px 8px", marginBottom: 8 }}>
                            ⚠ Game uses a system/flatpak launcher — only the ROM can be copied.
                          </div>
                        )}
                        {active.map(item => <ItemCard key={item.key} item={item} inSkipped={false} />)}
                        {skippedItems.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <Focusable onActivate={() => setSkippedOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", cursor: "pointer", outline: "none" }}>
                              <span style={{ fontSize: 11, color: "#888" }}>{skippedOpen ? "▼" : "▶"}</span>
                              <span style={{ fontSize: 11, color: "#888" }}>Skipped ({skippedItems.length})</span>
                            </Focusable>
                            {skippedOpen && skippedItems.map(item => <ItemCard key={item.key} item={item} inSkipped={true} />)}
                          </div>
                        )}
                        {isLutrisGame && hasLutrisPrefix && (
                          <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
                            If prefix is copied, the Lutris YML prefix path will be updated to the new location.
                          </div>
                        )}
                      </DialogBody>
                      <DialogFooter>
                        <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <DialogButton
                            ref={copyBtnRef}
                            className={nothingToCopy ? undefined : "Primary"}
                            disabled={nothingToCopy}
                            style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToCopy ? 0.4 : 1 }}
                            onClick={doCopy}
                          >
                            Copy
                          </DialogButton>
                          <DialogButton style={{ padding: "6px 10px", fontSize: 12, minHeight: 0 }} onClick={() => closeModal?.()}>Cancel</DialogButton>
                        </Focusable>
                      </DialogFooter>
                    </ModalRoot>
                  );
                };
                showModal(<NonSteamCopyModal />, window);
              }
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{drive.label}</span>
                <DriveSpaceWithSize drive={drive} sizePromise={nsSizePromise} />
              </div>
              <span style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{dstDir}</span>
            </div>
          </MenuItem>
        );
      })}
    </Menu>,
    window
  );
}

export async function showDriveSubmenu(appid: string): Promise<void> {
  const [drives, games] = await Promise.all([
    getDrives(),
    getInstalledGames(),
  ]);
  const game = games.find((g) => g.appid === appid);
  if (!game) return;
  const targets = drives.filter((d) => d.path !== game.library_path);
  if (targets.length === 0) {
    toaster.toast({ title: "CopyDeck", body: "No other drives to copy to." });
    return;
  }

  // Share one getGameSizes walk between the row size label and drive selection.
  let cachedSizes: GameSizes | null = null;
  const loadSizes = async (): Promise<GameSizes | null> => {
    if (cachedSizes) return cachedSizes;
    try {
      cachedSizes = await getGameSizes(game.appid, game.library_path);
      return cachedSizes;
    } catch {
      return null;
    }
  };
  const sizePromise = startDriveSelectorSizePromise(async () => {
    const sizes = await loadSizes();
    return sizes?.game_size ?? null;
  });

  showContextMenu(
    <Menu label="Copy To..." cancelText="Back">
      {targets.map((drive) => (
        <MenuItem
          key={drive.path}
          onSelected={async () => {
            const sizes = await loadSizes();
            const workshopSize = sizes?.workshop_size ?? 0;
            const compatdataSize = sizes?.compatdata_size ?? 0;
            const fullSizes = sizes
              ? {
                  workshop_path: sizes.workshop_path,
                  compatdata_path: sizes.compatdata_path,
                  game_size: sizes.game_size,
                  installdir: sizes.installdir,
                }
              : undefined;
            await queueWithPrompt(game, drive, workshopSize, compatdataSize, fullSizes);
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
            <span>{drive.label}</span>
            <DriveSpaceWithSize drive={drive} sizePromise={sizePromise} />
          </div>
        </MenuItem>
      ))}
    </Menu>,
    window
  );
}

export async function showNonSteamUninstallMenu(appid: string, gameDir: string, gameName: string): Promise<void> {
  const [drives, homeDir] = await Promise.all([getDrives(), getHomeDir()]);

  // ── Resolve game dir — fall back to scan locations if path is missing ────
  let resolvedGameDir = gameDir;
  const gameFolderName = gameDir.replace(/\/$/, "").split("/").pop() ?? gameName;

  if (gameDir && !(await checkPathExists(gameDir))) {
    const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
    const namesToTry = Array.from(new Set([gameName, gameFolderName].filter(Boolean)));
    outer: for (const loc of savedLocs) {
      for (const name of namesToTry) {
        const candidate = `${loc.replace(/\/$/, "")}/${name}`;
        if (await checkPathExists(candidate)) { resolvedGameDir = candidate; break outer; }
      }
    }
    // Scan locations empty — try dest subfolder on all drives as last resort
    if (resolvedGameDir === gameDir) {
      const destHit = await findOnDestDrivesFor(gameName, "__copydeck_uninstall_dest_fallback", gameDir);
      if (destHit) resolvedGameDir = destHit;
    }
  }

  const UNINSTALL_SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap"];
  const isSystemPath = (p: string) =>
    !p.includes("/") || UNINSTALL_SYSTEM_PREFIXES.some(sp => p === sp || p.startsWith(sp + "/"));

  // Whether the game folder itself is a real deletable path
  const gamePathExists = resolvedGameDir && await checkPathExists(resolvedGameDir);
  const gameIsSystemPath = gamePathExists && isSystemPath(resolvedGameDir);

  if (!gamePathExists && !gameIsSystemPath) {
    // Game folder unrecoverable — ROM detection may still find something
    // (mirrors copy flow behaviour). We'll continue and check for a ROM.
  }

  if (gameIsSystemPath) {
    toaster.toast({ title: "Can't uninstall — root path", body: "Add scan location in Non-Steam settings." });
    return;
  }

  // ── Normalise game folder to its scan-location root ──────────────────────
  const savedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
  const normalised = (p: string) => p.replace(/\/$/, "");
  const sortedLocs = [...savedLocs].map(normalised).sort((a, b) => {
    const aOnDrive = resolvedGameDir.startsWith(a.substring(0, a.indexOf("/", 1) + 1) || a);
    const bOnDrive = resolvedGameDir.startsWith(b.substring(0, b.indexOf("/", 1) + 1) || b);
    if (aOnDrive !== bOnDrive) return aOnDrive ? -1 : 1;
    return b.length - a.length;
  });

  if (gamePathExists) {
    let copyRoot = resolvedGameDir;
    for (const loc of sortedLocs) {
      if (resolvedGameDir.startsWith(loc + "/")) {
        const remainder = resolvedGameDir.slice(loc.length + 1);
        const gameRootName = remainder.split("/")[0];
        if (gameRootName) { copyRoot = `${loc}/${gameRootName}`; break; }
      }
    }
    resolvedGameDir = copyRoot;
  }

  // ── ROM detection (mirrors copy flow) ────────────────────────────────────
  const launchOptions = await getShortcutLaunchOptions(appid).catch(() => "");
  const SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap", "/run/host"];
  const absPathRe = /(?:"'([^']+)'"|"([^"]+)"|'([^']+)'|(?:^|\s)(\/[^\s"']+))/g;
  const allDriveRoots = drives.map(d => d.is_internal ? homeDir : d.path).filter(Boolean) as string[];

  let romPath: string | null = null;
  const romDetectEnabled = (window as any).__copydeck_rom_detect_enabled !== false;
  const romScanDepth: number = (window as any).__copydeck_rom_scan_depth ?? 3;

  // Scan a field string for an external ROM path (mirrors copy-flow scanFieldForRom).
  const uninstallScanFieldForRom = async (fieldText: string, skipFirstToken: boolean): Promise<string | null> => {
    const reLocal = /(?:"'([^']+)'"|"([^"]+)"|'([^']+)'|(?:^|\s)(\/[^\s"']+))/g;
    let m2: RegExpExecArray | null;
    let tokenIndex = 0;
    while ((m2 = reLocal.exec(fieldText)) !== null) {
      const p = (m2[1] ?? m2[2] ?? m2[3] ?? m2[4] ?? "").trim();
      if (!p || !p.startsWith("/")) continue;
      tokenIndex++;
      if (skipFirstToken && tokenIndex === 1) continue;
      if (SYSTEM_PREFIXES.some(sp => p === sp || p.startsWith(sp + "/"))) continue;
      if (resolvedGameDir && p.startsWith(resolvedGameDir + "/")) continue;

      if (await checkPathExists(p).catch(() => false)) {
        return p;
      }

      // Path not found — scan saved locations by filename
      const fileName = p.split("/").pop();
      if (fileName) {
        const scanDir2 = async (dir: string, depthLeft: number): Promise<string | null> => {
          if (await checkPathExists(`${dir}/${fileName}`).catch(() => false)) return `${dir}/${fileName}`;
          if (depthLeft <= 0) return null;
          const entries = await listDir(dir).catch(() => []);
          for (const e of entries.filter((e: any) => e.is_dir)) {
            const found = await scanDir2(e.path, depthLeft - 1);
            if (found) return found;
          }
          return null;
        };
        for (const loc of savedLocs) {
          const found = await scanDir2(loc.replace(/\/$/, ""), romScanDepth);
          if (found) return found;
        }
      }
    }
    return null;
  };

  if (romDetectEnabled) {
    // First check launch options (most common)
    if (launchOptions) {
      const hit = await uninstallScanFieldForRom(launchOptions, false);
      if (hit) romPath = hit;
    }
    // If not found in launch options, also check the Exe field
    // (e.g. Ryujinx: "/home/deck/Applications/Ryujinx.AppImage" "/path/to/rom.nsp")
    if (!romPath) {
      const rawExeUninstall = await getShortcutRawExe(appid).catch(() => "");
      if (rawExeUninstall) {
        const hit = await uninstallScanFieldForRom(rawExeUninstall, true);
        if (hit) romPath = hit;
      }
    }
  }

  // ── Compatdata + shadercache detection ───────────────────────────────────
  let compatdataPath: string | null = null;
  let shadercachePath: string | null = null;
  try {
    const cdResult = await findNonSteamCompatdata(appid, resolvedGameDir ?? "");
    if (cdResult.found && cdResult.path && await checkPathExists(cdResult.path).catch(() => false)) {
      compatdataPath = cdResult.path;
    }
    // Shadercache is returned directly by the backend, resolved from Steam's own steamapps.
    // This avoids the previous approach of string-replacing /compatdata/ → /shadercache/ in the
    // compatdata path, which would produce a wrong path when compatdata was copied to an external
    // drive (candidate 1 in find_nonsteam_compatdata) while shadercache stays on Steam's internal
    // steamapps. The backend always checks Steam's own steamapps for shadercache independently.
    if (cdResult.shadercache_path && await checkPathExists(cdResult.shadercache_path).catch(() => false)) {
      shadercachePath = cdResult.shadercache_path;
    }
  } catch { /* best-effort */ }

  // ── Build labels ──────────────────────────────────────────────────────────
  const getDriveLabel = (path: string) => {
    const d = drives.find(d => {
      const root = d.is_internal ? homeDir : d.path;
      return root && path.startsWith(root);
    });
    return d ? (d.is_internal ? "Internal Storage" : d.label) : "Unknown Drive";
  };

  const gameDriveLabel = gamePathExists ? getDriveLabel(resolvedGameDir) : null;
  const romName = romPath ? romPath.split("/").pop() ?? "ROM" : null;
  const romDriveLabel = romPath ? getDriveLabel(romPath) : null;
  const compatdataDriveLabel = compatdataPath ? getDriveLabel(compatdataPath) : null;
  const shadercacheDriveLabel = shadercachePath ? getDriveLabel(shadercachePath) : null;

  // Fetch sizes (best-effort, non-blocking)
  const [gameSize, romSize, compatdataSize, shadercacheSize] = await Promise.all([
    gamePathExists  ? getPathSize(resolvedGameDir).catch(() => null) : Promise.resolve(null),
    romPath         ? getPathSize(romPath).catch(() => null)         : Promise.resolve(null),
    compatdataPath  ? getPathSize(compatdataPath).catch(() => null)  : Promise.resolve(null),
    shadercachePath ? getPathSize(shadercachePath).catch(() => null) : Promise.resolve(null),
  ]);
  const fmtBytes = (r: { success: boolean; size_bytes: number } | null) =>
    r?.success ? formatSize(r.size_bytes) : null;
  const gameSizeStr        = fmtBytes(gameSize);
  const romSizeStr         = fmtBytes(romSize);
  const compatdataSizeStr  = fmtBytes(compatdataSize);
  const shadercacheSizeStr = fmtBytes(shadercacheSize);

  // ── ModalRoot uninstall dialog — stateful so items can be skipped ─────────
  type ItemKey = "game" | "rom" | "compatdata" | "shadercache";
  interface UninstallItem {
    key: ItemKey;
    label: string;
    path: string;
    driveLabel: string | null;
    sizeStr: string | null;
  }
  const allItems: UninstallItem[] = [
    ...(gamePathExists   ? [{ key: "game"        as ItemKey, label: "Game folder",               path: resolvedGameDir,  driveLabel: gameDriveLabel,        sizeStr: gameSizeStr        }] : []),
    ...(romPath          ? [{ key: "rom"         as ItemKey, label: "ROM file",                  path: romPath,          driveLabel: romDriveLabel,         sizeStr: romSizeStr         }] : []),
    ...(compatdataPath   ? [{ key: "compatdata"  as ItemKey, label: "Proton prefix (compatdata)", path: compatdataPath,  driveLabel: compatdataDriveLabel,  sizeStr: compatdataSizeStr  }] : []),
    ...(shadercachePath  ? [{ key: "shadercache" as ItemKey, label: "Shader cache",              path: shadercachePath,  driveLabel: shadercacheDriveLabel, sizeStr: shadercacheSizeStr }] : []),
  ];

  const UninstallModal = ({ closeModal }: { closeModal?: () => void }) => {
    const [skipped, setSkipped] = useState<Set<ItemKey>>(new Set());
    const [skippedOpen, setSkippedOpen] = useState(false);
    const uninstallBtnRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let frame: number;
      const tryFocus = () => {
        if (uninstallBtnRef.current) {
          uninstallBtnRef.current.focus();
        } else {
          frame = requestAnimationFrame(tryFocus);
        }
      };
      frame = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(frame);
    }, []);

    const toggle = (key: ItemKey) =>
      setSkipped(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });

    const active = allItems.filter(i => !skipped.has(i.key));
    const skippedItems = allItems.filter(i => skipped.has(i.key));
    const nothingToDelete = active.length === 0;

    const ItemCard = ({ item, inSkipped }: { item: UninstallItem; inSkipped: boolean }) => (
      <Focusable
        onActivate={() => toggle(item.key)}
        style={{
          marginBottom: 6, padding: "8px 10px",
          background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)",
          borderRadius: 6,
          border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`,
          cursor: "pointer", outline: "none",
        }}
      >
        <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all" }}>{item.path}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
          <span>📁 {item.driveLabel}</span>
          {item.sizeStr && <span>· {item.sizeStr}</span>}
        </div>
      </Focusable>
    );

    const doUninstall = async () => {
      closeModal?.();
      const errors: string[] = [];
      for (const item of active) {
        let result: { success: boolean; error?: string };
        if (item.key === "game") {
          result = await uninstallNonSteam(resolvedGameDir, appid);
        } else {
          result = await deletePath(item.path);
        }
        if (!result.success) errors.push(result.error ?? item.label);
      }
      if (errors.length === 0) {
        const names = active.map(i => i.key === "game" ? gameName : i.key === "rom" ? (romName ?? "ROM") : i.key === "shadercache" ? "shader cache" : "prefix").join(" + ");
        toaster.toast({ title: "Uninstalled", body: names });
      } else {
        toaster.toast({ title: "Uninstall failed", body: errors.join(", ") });
      }
    };

    return (
      <ModalRoot onCancel={closeModal}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
            Uninstall {gameName}
          </div>

          {/* Active items */}
          {active.length > 0
            ? active.map(item => <ItemCard key={item.key} item={item} inSkipped={false} />)
            : !gamePathExists && (
              <div style={{ marginBottom: 10, padding: "8px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)" }}>
                <div style={{ fontSize: 12, color: "#888" }}>No game files found</div>
              </div>
            )
          }

          {/* Skipped sub-section */}
          {skippedItems.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Focusable
                onActivate={() => setSkippedOpen(v => !v)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", cursor: "pointer", outline: "none" }}
              >
                <span style={{ fontSize: 11, color: "#888" }}>{skippedOpen ? "▼" : "▶"}</span>
                <span style={{ fontSize: 11, color: "#888" }}>Skipped ({skippedItems.length})</span>
              </Focusable>
              {skippedOpen && skippedItems.map(item => <ItemCard key={item.key} item={item} inSkipped={true} />)}
            </div>
          )}

          <div style={{ fontSize: 12, color: "#e57373", marginTop: 8, textAlign: "center" }}>
            Deleted files cannot be recovered.
          </div>
        </DialogBody>

        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DialogButton
              ref={uninstallBtnRef}
              className={nothingToDelete ? undefined : "Primary"}
              disabled={nothingToDelete}
              style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToDelete ? 0.4 : 1 }}
              onClick={doUninstall}
            >
              Uninstall
            </DialogButton>
            <DialogButton
              style={{ padding: "6px 10px", fontSize: 12, minHeight: 0 }}
              onClick={() => closeModal?.()}
            >
              Cancel
            </DialogButton>
            {romPath && (
              <div style={{ fontSize: 10, color: "#666", lineHeight: 1.4, textAlign: "center" }}>
                ROM = Game File (Launch Options Path) · Game Folder = Target Directory Path
              </div>
            )}
          </Focusable>
        </DialogFooter>
      </ModalRoot>
    );
  };

  showModal(<UninstallModal />, window);
}

export async function showLutrisUninstallMenu(appid: string, gameName: string): Promise<void> {
  const [drives, homeDir] = await Promise.all([getDrives(), getHomeDir()]);

  // ── Detect Lutris game info ───────────────────────────────────────────────
  const lutrisResult = await detectLutrisShortcut(appid).catch(() => null);
  if (!lutrisResult?.is_lutris || !lutrisResult.game_info) {
    toaster.toast({ title: "CopyDeck", body: "Lutris game info not found." });
    return;
  }
  const info = lutrisResult.game_info;
  const gameDir = info.install_dir ?? "";

  const SYSTEM_PREFIXES = ["/usr", "/app", "/bin", "/lib", "/lib64", "/snap", "/run/host"];
  const isSystemPath = (p: string) =>
    !p.includes("/") || SYSTEM_PREFIXES.some(sp => p === sp || p.startsWith(sp + "/"));

  let resolvedGameDir = gameDir;

  if (gameDir && isSystemPath(gameDir)) {
    toaster.toast({ title: "Can't uninstall — root path", body: "Lutris install_dir points to a system path." });
    return;
  }

  // If install_dir is missing or stale, try scan locations then dest subfolder
  if (gameDir && !(await checkPathExists(gameDir).catch(() => false))) {
    const lutrisSavedLocs: string[] = (window as any).__copydeck_nonsteam_locations ?? [];
    const namesToTry = Array.from(new Set([gameName, ...gameDir.replace(/\/$/, "").split("/").filter(Boolean)].filter(Boolean)));
    outer: for (const loc of lutrisSavedLocs) {
      for (const name of namesToTry) {
        const candidate = `${loc.replace(/\/$/, "")}/${name}`;
        if (await checkPathExists(candidate).catch(() => false)) { resolvedGameDir = candidate; break outer; }
      }
    }
    if (resolvedGameDir === gameDir) {
      const destHit = await findOnDestDrivesFor(gameName, "__copydeck_uninstall_dest_fallback", gameDir);
      if (destHit) resolvedGameDir = destHit;
    }
  }

  // ── Detect prefix ─────────────────────────────────────────────────────────
  const lutPrefixDestSetting = ((window as any).__copydeck_lutris_prefix_dest as string | undefined)?.trim().replace(/\/$/, "") ?? "";
  const allDriveRoots = drives.map(d => d.is_internal ? homeDir : d.path).filter(Boolean) as string[];
  const otherDriveRoots = allDriveRoots.join(",");
  const lpResult = await findLutrisPrefix(appid, info.prefix_path ?? "", lutPrefixDestSetting, otherDriveRoots).catch(() => ({ found: false, path: null }));
  const prefixDir = lpResult.found ? (lpResult.path ?? "") : "";

  // ── Existence checks ──────────────────────────────────────────────────────
  const [gameExists, prefixExists] = await Promise.all([
    resolvedGameDir ? checkPathExists(resolvedGameDir).catch(() => false) : Promise.resolve(false),
    prefixDir ? checkPathExists(prefixDir).catch(() => false) : Promise.resolve(false),
  ]);

  if (!gameExists && !prefixExists) {
    toaster.toast({ title: "CopyDeck", body: `No files found for "${gameName}".` });
    return;
  }

  // ── Drive label helper ────────────────────────────────────────────────────
  const getDriveLabel = (path: string) => {
    const d = drives.find(d => {
      const root = d.is_internal ? homeDir : d.path;
      return root && path.startsWith(root);
    });
    return d ? (d.is_internal ? "Internal Storage" : d.label) : "Unknown Drive";
  };

  // ── Sizes ─────────────────────────────────────────────────────────────────
  const [gameSize, prefixSize] = await Promise.all([
    gameExists  ? getPathSize(resolvedGameDir).catch(() => null)   : Promise.resolve(null),
    prefixExists ? getPathSize(prefixDir).catch(() => null) : Promise.resolve(null),
  ]);
  const fmtBytes = (r: { success: boolean; size_bytes: number } | null) =>
    r?.success ? formatSize(r.size_bytes) : null;
  const gameSizeStr   = fmtBytes(gameSize);
  const prefixSizeStr = fmtBytes(prefixSize);
  const gameDriveLabel   = gameExists   ? getDriveLabel(resolvedGameDir)   : null;
  const prefixDriveLabel = prefixExists ? getDriveLabel(prefixDir) : null;

  // ── Delete helpers ────────────────────────────────────────────────────────
  const doDeleteLutris = (game: boolean, prefix: boolean) =>
    uninstallLutris(game ? resolvedGameDir : "", prefix ? prefixDir : "");

  // ── Modal ─────────────────────────────────────────────────────────────────
  type LutrisItemKey = "game" | "prefix";
  interface LutrisUninstallItem { key: LutrisItemKey; label: string; path: string; driveLabel: string | null; sizeStr: string | null; }
  const lutrisItems: LutrisUninstallItem[] = [
    ...(gameExists   ? [{ key: "game"   as LutrisItemKey, label: "Game folder", path: resolvedGameDir, driveLabel: gameDriveLabel,   sizeStr: gameSizeStr   }] : []),
    ...(prefixExists ? [{ key: "prefix" as LutrisItemKey, label: "Wine prefix", path: prefixDir,       driveLabel: prefixDriveLabel, sizeStr: prefixSizeStr }] : []),
  ];

  const LutrisUninstallModal = ({ closeModal }: { closeModal?: () => void }) => {
    const [skipped, setSkipped] = useState<Set<LutrisItemKey>>(new Set());
    const [skippedOpen, setSkippedOpen] = useState(false);
    const uninstallBtnRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      let frame: number;
      const tryFocus = () => { if (uninstallBtnRef.current) { uninstallBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
      frame = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(frame);
    }, []);

    const toggle = (key: LutrisItemKey) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    const active = lutrisItems.filter(i => !skipped.has(i.key));
    const skippedItems = lutrisItems.filter(i => skipped.has(i.key));
    const nothingToDelete = active.length === 0;

    const ItemCard = ({ item, inSkipped }: { item: LutrisUninstallItem; inSkipped: boolean }) => (
      <Focusable
        onActivate={() => toggle(item.key)}
        style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
      >
        <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all" }}>{item.path}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
          <span>📁 {item.driveLabel}</span>
          {item.sizeStr && <span>· {item.sizeStr}</span>}
        </div>
      </Focusable>
    );

    return (
      <ModalRoot onCancel={closeModal}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Uninstall {gameName}</div>
          {active.length > 0
            ? active.map(item => <ItemCard key={item.key} item={item} inSkipped={false} />)
            : <div style={{ marginBottom: 10, padding: "8px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)" }}><div style={{ fontSize: 12, color: "#888" }}>No game files found</div></div>
          }
          {skippedItems.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Focusable onActivate={() => setSkippedOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", cursor: "pointer", outline: "none" }}>
                <span style={{ fontSize: 11, color: "#888" }}>{skippedOpen ? "▼" : "▶"}</span>
                <span style={{ fontSize: 11, color: "#888" }}>Skipped ({skippedItems.length})</span>
              </Focusable>
              {skippedOpen && skippedItems.map(item => <ItemCard key={item.key} item={item} inSkipped={true} />)}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#e57373", marginTop: 8, textAlign: "center" }}>Deleted files cannot be recovered.</div>
        </DialogBody>
        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DialogButton
              ref={uninstallBtnRef}
              className={nothingToDelete ? undefined : "Primary"}
              disabled={nothingToDelete}
              style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToDelete ? 0.4 : 1 }}
              onClick={async () => {
                closeModal?.();
                const doGame = !skipped.has("game") && gameExists;
                const doPrefix = !skipped.has("prefix") && prefixExists;
                const r = await doDeleteLutris(doGame, doPrefix);
                if (r.success) {
                  const label = [doGame && gameName, doPrefix && "prefix"].filter(Boolean).join(" + ");
                  toaster.toast({ title: "Uninstalled", body: label });
                } else {
                  toaster.toast({ title: "Uninstall failed", body: r.error ?? "Unknown error" });
                }
              }}
            >
              Uninstall
            </DialogButton>
            <DialogButton style={{ padding: "6px 10px", fontSize: 12, minHeight: 0 }} onClick={() => closeModal?.()}>Cancel</DialogButton>
          </Focusable>
        </DialogFooter>
      </ModalRoot>
    );
  };

  showModal(<LutrisUninstallModal />, window);
}
