import {
  afterPatch,
  ConfirmModal,
  DialogBody,
  DialogButton,
  DialogFooter,
  fakeRenderComponent,
  findInReactTree,
  findModuleByExport,
  findInTree,
  Focusable,
  MenuItem,
  MenuGroup,
  ModalRoot,
  Navigation,
  Patch,
  showModal,
  showContextMenu,
  Menu,
  type Export,
} from "@decky/ui";
import React, { useState, useEffect, useRef } from "react";
import { toaster } from "@decky/api";
import { uninstallGames, getGameSizes, getSetting, getInstalledGames, getShortcutDirs, getTargetHistory, addTargetHistory, removeTargetHistory, getShortcutExe, getShortcutSnapshot, updateLutrisPaths, detectLutrisShortcut, getAllDrives, checkPathExists, type TargetSnapshot, type LutrisGameInfo } from "./utils/backendApi";

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function driveLabel(path: string): string {
  const p = path.split("/");
  if (p[1] === "run" && p[2] === "media") return p[4] ?? p[3] ?? "Drive";
  if (p[1] === "media") return p[3] ?? p[2] ?? "Drive";
  if (p[1] === "home") return "Internal";
  return p[2] ?? "Drive";
}

// Returns [label, isHome, relativePath] for a history exe/install path.
// e.g. "/run/media/deck/SSD/Games/Game" -> ["SSD", false, "/Games/Game"]
// e.g. "/home/deck/Games/Game"          -> ["Home", true,  "/Games/Game"]
function parseDrivePath(exePath: string): { label: string; isHome: boolean; rel: string } {
  const p = exePath.split("/");
  let driveRoot = "";
  let label = "Drive";
  let isHome = false;
  if (p[1] === "run" && p[2] === "media" && p[4]) {
    driveRoot = "/" + p.slice(1, 5).join("/");
    label = p[4];
  } else if (p[1] === "run" && p[2] === "media" && p[3]) {
    driveRoot = "/" + p.slice(1, 4).join("/");
    label = p[3];
  } else if (p[1] === "media" && p[3]) {
    driveRoot = "/" + p.slice(1, 4).join("/");
    label = p[3];
  } else if (p[1] === "media" && p[2]) {
    driveRoot = "/" + p.slice(1, 3).join("/");
    label = p[2];
  } else if ((p[1] === "home" || p[1] === "var" && p[2] === "home") && p[p[1] === "home" ? 2 : 3]) {
    // Covers /home/<user>/... and /var/home/<user>/... (Bazzite/ostree)
    const userIdx = p[1] === "home" ? 2 : 3;
    driveRoot = "/" + p.slice(1, userIdx + 1).join("/");
    label = "Home";
    isHome = true;
  } else if (p[1] === "root") {
    // root user home
    driveRoot = "/root";
    label = "Home";
    isHome = true;
  }
  const rel = driveRoot ? exePath.slice(driveRoot.length) || "/" : exePath;
  return { label, isHome, rel };
}

// Load games at startup so Browse works without opening the QAM first
getInstalledGames().then((g) => {
  (window as any).__copydeck_games = g;
});

// Returns the active Steam account's 32-bit account ID as a string.
// window.App.m_CurrentUser.strSteamID is a 64-bit SteamID; the userdata folder
// name is the lower 32 bits (the account ID portion).
const getActiveSteamId = (): string => {
  try {
    const id64 = (window as any).App?.m_CurrentUser?.strSteamID;
    if (id64) return BigInt.asUintN(32, BigInt(id64)).toString();
  } catch {}
  return (window as any).__copydeck_steam_id ?? "";
};

// Load non-Steam shortcut dirs once Steam's user session and services are fully
// ready. Mirrors the pattern used by Tabmaster:
//   1. RegisterForLoginStateChange fires when the account is known
//   2. WaitForServicesInitialized resolves when all Steam stores are ready
//   3. Only then do we read VDF — guaranteeing we get the right account ID
export let _loginUnregisterer: { unregister: () => void } | null = null;
const _loadShortcutDirs = async () => {
  try {
    await (window as any).App?.WaitForServicesInitialized?.();
  } catch {}
  const steamId = getActiveSteamId();
  (window as any).__copydeck_steam_id = steamId;
  const dirs = await getShortcutDirs(steamId);
  (window as any).__copydeck_shortcut_dirs = dirs;
};
try {
  _loginUnregisterer = (window as any).SteamClient?.User?.RegisterForLoginStateChange(
    async (username: string) => {
      if (username) await _loadShortcutDirs();
    }
  );
} catch {}
// Also fire immediately in case the user is already logged in when the plugin loads
_loadShortcutDirs();
import { showDriveSubmenu, showNonSteamDriveSubmenu, showNonSteamUninstallMenu, showLutrisUninstallMenu } from "./components/DriveSubmenu";

// ── Cached settings ───────────────────────────────────────────────────────────
// The context menu patch runs synchronously inside React's render cycle.
// Awaiting getSetting() there causes the splice to arrive after the menu
// has already painted. We cache the value here and MultiSelectPanel updates
// it via window.__copydeck_set_uninstall_in_menu when the toggle changes.

let _uninstallInMenu = true;
let _copyInMenu = true;
let _browseInMenu = true;
let _setTargetInMenu = true;
let _subMenuInMenu = true;

(window as any).__copydeck_set_uninstall_in_menu = (v: boolean) => {
  _uninstallInMenu = v;
};
(window as any).__copydeck_set_copy_in_menu = (v: boolean) => {
  _copyInMenu = v;
};
(window as any).__copydeck_set_browse_in_menu = (v: boolean) => {
  _browseInMenu = v;
};
(window as any).__copydeck_set_settarget_in_menu = (v: boolean) => {
  _setTargetInMenu = v;
};
(window as any).__copydeck_set_submenu_in_menu = (v: boolean) => {
  _subMenuInMenu = v;
};

getSetting("uninstall_in_menu", "true").then((v) => {
  _uninstallInMenu = v === "true";
});
getSetting("copy_in_menu", "true").then((v) => {
  _copyInMenu = v === "true";
});
getSetting("browse_in_menu", "true").then((v) => {
  _browseInMenu = v === "true";
});
getSetting("settarget_in_menu", "true").then((v) => {
  _setTargetInMenu = v === "true";
});
getSetting("submenu_in_menu", "true").then((v) => {
  _subMenuInMenu = v === "true";
});

// Load settings that are also read by patch.tsx at runtime, so they're available
// before the user opens the QAM panel for the first time.
getSetting("nonsteam_dest", "Games/NonSteam").then((v) => {
  (window as any).__copydeck_nonsteam_dest = v;
});
getSetting("browse_dest_fallback", "false").then((v) => {
  (window as any).__copydeck_browse_dest_fallback = v !== "false";
});
getSetting("nonsteam_prefix_dest", "").then((v) => {
  (window as any).__copydeck_nonsteam_prefix_dest = v;
});
getSetting("lutris_prefix_dest", "").then((v) => {
  (window as any).__copydeck_lutris_prefix_dest = v;
});
getSetting("lutris_support", "true").then((v) => {
  (window as any).__copydeck_lutris_support = v !== "false";
});
getSetting("copy_compatdata_detect", "true").then((v) => {
  (window as any).__copydeck_copy_compatdata_detect = v !== "false";
});
getSetting("nonsteam_compatdata_detect", "true").then((v) => {
  (window as any).__copydeck_nonsteam_compatdata_detect = v !== "false";
});
getSetting("nonsteam_locations", "[]").then((v) => {
  try { (window as any).__copydeck_nonsteam_locations = JSON.parse(v); } catch { (window as any).__copydeck_nonsteam_locations = []; }
});
getSetting("nonsteam_dest_slots", "[]").then((v) => {
  try { (window as any).__copydeck_nonsteam_dest_slots = JSON.parse(v); } catch { (window as any).__copydeck_nonsteam_dest_slots = []; }
});
getSetting("rom_detect_enabled", "true").then((v) => {
  (window as any).__copydeck_rom_detect_enabled = v !== "false";
});
getSetting("rom_scan_depth", "3").then((v) => {
  const d = parseInt(v, 10); (window as any).__copydeck_rom_scan_depth = isNaN(d) ? 3 : d;
});
getSetting("auto_skip_game_folder", "true").then((v) => {
  (window as any).__copydeck_auto_skip_game_folder = v !== "false";
});
getSetting("copy_dest_fallback", "true").then((v) => {
  (window as any).__copydeck_copy_dest_fallback = v !== "false";
});
getSetting("uninstall_dest_fallback", "false").then((v) => {
  (window as any).__copydeck_uninstall_dest_fallback = v !== "false";
});
getSetting("copy_workshop_detect", "true").then((v) => {
  (window as any).__copydeck_copy_workshop_detect = v !== "false";
});
getSetting("cancel_partial_prompt", "true").then((v) => {
  (window as any).__copydeck_cancel_partial_prompt = v !== "false";
});
getSetting("auto_set_target", "true").then((v) => {
  (window as any).__copydeck_auto_set_target = v !== "false";
});
getSetting("drive_selector_size", "true").then((v) => {
  (window as any).__copydeck_drive_selector_size = v !== "false";
});

// ── Copy To splice ────────────────────────────────────────────────────────────

const COPYDECK_MENU_KEY = "copydeck-copy-to";

const spliceCopyToItem = (children: any[], appid: number, short = false) => {
  const idx = children.findIndex(
    (item: any) =>
      item?.key === COPYDECK_MENU_KEY ||
      findInReactTree(item, (x: any) =>
        x?.onSelected?.toString?.().includes("showDriveSubmenu")
      )
  );
  if (idx !== -1) children.splice(idx, 1);

  const propertiesMenuItemIdx = children.findIndex((item: any) =>
    findInReactTree(item, (x: any) =>
      x?.onSelected?.toString?.().includes("AppProperties")
    )
  );
  const insertIdx =
    propertiesMenuItemIdx >= 0 ? propertiesMenuItemIdx : children.length;

  children.splice(
    insertIdx,
    0,
    <MenuItem
      key={COPYDECK_MENU_KEY}
      onSelected={async () => {
        if (isNonSteamGame(appid)) {
          // Re-read from VDF (correct account only) to pick up any changes.
          // VDF is flushed synchronously by Steam so fresh read always has the latest state.
          try {
            const freshDirs = await getShortcutDirs(getActiveSteamId());
            (window as any).__copydeck_shortcut_dirs = freshDirs;
          } catch {}
          const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
          const gameDir = shortcutDirs[String(appid)] ?? "";
          const overview = (globalThis as any).appStore?.GetAppOverviewByAppID?.(appid);
          const gameName: string = overview?.display_name ?? overview?.strDisplayName ?? `App ${appid}`;
          showNonSteamDriveSubmenu(String(appid), gameDir, gameName);
          return;
        }
        showDriveSubmenu(String(appid));
      }}
    >
      <span style={{ color: "#69db7c" }}>{short ? "Copy" : "Copy (CopyDeck)"}</span>
    </MenuItem>
  );
};

// ── Uninstall helpers ─────────────────────────────────────────────────────────

const runUninstall = async (
  appid: number,
  libraryPath: string,
  gameName: string,
  opts?: { delete_files?: boolean; delete_acf?: boolean; delete_compatdata?: boolean; delete_shadercache?: boolean; delete_workshop?: boolean },
) => {
  const result = await uninstallGames([
    {
      appid: String(appid),
      library_path: libraryPath,
      delete_files: opts?.delete_files ?? true,
      delete_acf: opts?.delete_acf ?? true,
      delete_compatdata: opts?.delete_compatdata ?? true,
      delete_shadercache: opts?.delete_shadercache ?? true,
      delete_workshop: opts?.delete_workshop ?? true,
    },
  ]);

  if (result.success && (!result.errors || result.errors.length === 0)) {
    toaster.toast({ title: "Uninstalled", body: gameName });
  } else {
    const errMsg = result.errors?.[0]?.error ?? "Unknown error";
    toaster.toast({ title: "Uninstall failed", body: errMsg });
  }

  try {
    await (window as any).SteamClient?.Apps?.UninstallApp?.(Number(appid));
  } catch {
    // Not fatal — files are already deleted
  }
};

const showUninstallConfirm = (
  appid: number,
  libraryPath: string,
  gameName: string
) => {
  const gamePath = `${libraryPath}/steamapps/common`;

  const SteamUninstallModal = ({ closeModal }: { closeModal?: () => void }) => {
    const [sizes, setSizes] = useState<{ game: number; compatdata: number; shadercache: number; workshop: number; compatdata_path: string; shadercache_path: string; workshop_path: string } | null>(null);
    const [installdir, setInstalldir] = useState<string | null>(null);
    const [skipped, setSkipped] = useState<Set<string>>(new Set());
    const [skippedOpen, setSkippedOpen] = useState(false);
    const uninstallBtnRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let frame: number;
      const tryFocus = () => { if (uninstallBtnRef.current) { uninstallBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
      frame = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(frame);
    }, []);

    useEffect(() => {
      getGameSizes(String(appid), libraryPath).then((s) => {
        setSizes({
          game: s.game_size,
          compatdata: s.compatdata_size,
          shadercache: s.shadercache_size,
          workshop: s.workshop_size,
          compatdata_path: s.compatdata_path,
          shadercache_path: s.shadercache_path,
          workshop_path: s.workshop_path,
        });
        setInstalldir(s.installdir ?? null);
      }).catch(() => {});
    }, []);

    const fullGamePath = installdir ? `${libraryPath}/steamapps/common/${installdir}` : gamePath;

    type SteamKey = "game" | "compatdata" | "shadercache" | "workshop";
    interface SteamItem { key: SteamKey; label: string; path: string; sizeStr: string | null; }
    const s = sizes; // narrowed non-null reference for use inside array literals
    const allItems: SteamItem[] = [
      { key: "game",        label: "Game files",   path: fullGamePath, sizeStr: s ? formatSize(s.game) : null },
      ...(s && s.compatdata  > 0 ? [{ key: "compatdata"  as SteamKey, label: "Compatdata",   path: s.compatdata_path  || `${libraryPath}/steamapps/compatdata`,  sizeStr: formatSize(s.compatdata)  }] : []),
      ...(s && s.shadercache > 0 ? [{ key: "shadercache" as SteamKey, label: "Shader cache", path: s.shadercache_path || `${libraryPath}/steamapps/shadercache`, sizeStr: formatSize(s.shadercache) }] : []),
      ...(s && s.workshop    > 0 ? [{ key: "workshop"    as SteamKey, label: "Workshop",      path: s.workshop_path    || `${libraryPath}/steamapps/workshop`,    sizeStr: formatSize(s.workshop)    }] : []),
    ];

    const toggle = (key: SteamKey) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    const active = allItems.filter(i => !skipped.has(i.key));
    const skippedItems = allItems.filter(i => skipped.has(i.key));
    const nothingToDelete = active.length === 0;
    const gameSkipped = skipped.has("game");

    const ItemCard = ({ item, inSkipped }: { item: SteamItem; inSkipped: boolean }) => (
      <Focusable
        onActivate={() => toggle(item.key)}
        style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
      >
        <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all" }}>{item.path}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
          <span>📁 {driveLabel(libraryPath)}</span>
          {item.sizeStr && <span>· {item.sizeStr}</span>}
        </div>
      </Focusable>
    );

    return (
      <ModalRoot onCancel={closeModal}>
        <DialogBody>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Uninstall {gameName}</div>
          {sizes === null && <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Loading sizes…</div>}
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
          <div style={{ fontSize: 12, color: "#e57373", marginTop: 8 }}>Deleted files cannot be recovered.</div>
          {!gameSkipped && <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Note: Steam must be restarted to reflect the change. If the game was on an external drive, eject and re-insert it instead.</div>}
        </DialogBody>
        <DialogFooter>
          <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DialogButton
              ref={uninstallBtnRef}
              className={nothingToDelete ? undefined : "Primary"}
              disabled={nothingToDelete}
              style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToDelete ? 0.4 : 1 }}
              onClick={() => {
                closeModal?.();
                runUninstall(appid, libraryPath, gameName, {
                  delete_files: !skipped.has("game"),
                  delete_acf: !skipped.has("game"),
                  delete_compatdata: !skipped.has("compatdata"),
                  delete_shadercache: !skipped.has("shadercache"),
                  delete_workshop: !skipped.has("workshop"),
                });
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

  showModal(<SteamUninstallModal />, window);
};

// ── Uninstall splice ──────────────────────────────────────────────────────────

const COPYDECK_UNINSTALL_KEY = "copydeck-uninstall";

const spliceUninstallItem = (children: any[], appid: number, short = false) => {
  // Always remove stale entry first
  const idx = children.findIndex(
    (item: any) => item?.key === COPYDECK_UNINSTALL_KEY
  );
  if (idx !== -1) children.splice(idx, 1);

  // Don't re-add if toggled off
  if (!_uninstallInMenu) return;

  const propertiesMenuItemIdx = children.findIndex((item: any) =>
    findInReactTree(item, (x: any) =>
      x?.onSelected?.toString?.().includes("AppProperties")
    )
  );
  const insertIdx =
    propertiesMenuItemIdx >= 0 ? propertiesMenuItemIdx : children.length;

  children.splice(
    insertIdx,
    0,
    <MenuItem
      key={COPYDECK_UNINSTALL_KEY}
      onSelected={async () => {
        const ov = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
        const gameName = ov?.display_name ?? `App ${appid}`;

        // Check Lutris first
        if (isNonSteamGame(appid)) {
          if ((window as any).__copydeck_lutris_support !== false) try {
            const lutrisResult = await detectLutrisShortcut(String(appid));
            if (lutrisResult.is_lutris) {
              showLutrisUninstallMenu(String(appid), gameName);
              return;
            }
          } catch {}
          // Non-Lutris non-Steam — folder-delete flow
          const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
          const gameDir = shortcutDirs[String(appid)] ?? "";
          showNonSteamUninstallMenu(String(appid), gameDir, gameName);
          return;
        }

        const allGames: any[] = (window as any).__copydeck_games ?? [];
        const matches = allGames.filter(
          (g: any) => String(g.appid) === String(appid)
        );

        if (matches.length === 0) {
          toaster.toast({
            title: "CopyDeck",
            body: "Game not found — open the CopyDeck panel first.",
          });
          return;
        }

        if (matches.length === 1) {
          showUninstallConfirm(appid, matches[0].library_path, matches[0].name);
        } else {
          // Game installed on multiple drives — pick which one to uninstall
          showContextMenu(
            <Menu label="Uninstall from which drive?" cancelText="Back">
              {matches.map((g: any) => (
                <MenuItem
                  key={g.library_path}
                  onSelected={() =>
                    showUninstallConfirm(appid, g.library_path, g.name)
                  }
                >
                  {g.library_path}
                </MenuItem>
              ))}
            </Menu>,
            window
          );
        }
      }}
    >
      <span style={{ color: "#fa5252" }}>{short ? "Uninstall" : "Uninstall (CopyDeck)"}</span>
    </MenuItem>
  );
};


// ── Destination subdirectory browse helpers ───────────────────────────────────
// resolveGamePath: returns knownPath if set, otherwise searches the destination
// subfolder across all mounted drives if browse_dest_fallback is enabled.
const findOnDestDrives = async (appid: number, knownPath: string = ""): Promise<string | null> => {
  try {
    const destSubfolder = ((window as any).__copydeck_nonsteam_dest as string | undefined)?.trim().replace(/^\//, "").replace(/\/$/, "") ?? "Games/NonSteam";
    const appName: string = (window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name ?? "";
    // Build name candidates: display name first, then path segments from knownPath
    const pathSegments = knownPath.replace(/\/$/, "").split("/").filter(Boolean);
    const namesToTry = Array.from(new Set([appName, ...pathSegments].filter(Boolean)));
    if (!namesToTry.length) return null;
    const drives = await getAllDrives();
    for (const drive of drives) {
      const root = destSubfolder ? `${drive.path}/${destSubfolder}` : drive.path;
      for (const name of namesToTry) {
        const candidate = `${root}/${name}`;
        if (await checkPathExists(candidate)) return candidate;
      }
    }
  } catch { /* best-effort */ }
  return null;
};

const resolveGamePath = async (appid: number, knownPath: string | null): Promise<string | null> => {
  if (knownPath && await checkPathExists(knownPath).catch(() => false)) return knownPath;
  const fallback: boolean = (window as any).__copydeck_browse_dest_fallback !== false;
  if (fallback) return await findOnDestDrives(appid, knownPath ?? "");
  return knownPath || null;
};

// Alias for call sites that have no known path (pure fallback)
const findGameOnDrives = (appid: number) => resolveGamePath(appid, null);

// ── Browse splice ────────────────────────────────────────────────────────────

const COPYDECK_BROWSE_KEY = "copydeck-browse";

const spliceBrowseItem = (children: any[], appid: number, short = false) => {
  const idx = children.findIndex((item: any) => item?.key === COPYDECK_BROWSE_KEY);
  if (idx !== -1) children.splice(idx, 1);

  if (!_browseInMenu) return;

  const propertiesMenuItemIdx = children.findIndex((item: any) =>
    findInReactTree(item, (x: any) =>
      x?.onSelected?.toString?.().includes("AppProperties")
    )
  );
  const insertIdx =
    propertiesMenuItemIdx >= 0 ? propertiesMenuItemIdx : children.length;

  children.splice(
    insertIdx,
    0,
    <MenuItem
      key={COPYDECK_BROWSE_KEY}
      onSelected={async () => {
        const allGames: any[] = (window as any).__copydeck_games ?? [];
        const match = allGames.find((g: any) => String(g.appid) === String(appid));
        if (match) {
          const gamePath = `${match.library_path}/steamapps/common/${match.installdir}`;
          (window as any).__copydeck_browse_path = gamePath;
        } else {
          // Check if this is a Lutris game — use install_dir from YML if so
          if ((window as any).__copydeck_lutris_support !== false) try {
            const lutrisResult = await detectLutrisShortcut(String(appid));
            if (lutrisResult.is_lutris && lutrisResult.game_info?.install_dir) {
              (window as any).__copydeck_browse_path = await resolveGamePath(appid, lutrisResult.game_info.install_dir);
            } else {
              const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
              const knownDir = shortcutDirs[String(appid)] ?? null;
              (window as any).__copydeck_browse_path = await resolveGamePath(appid, knownDir);
            }
          } catch {
            const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
            const knownDir = shortcutDirs[String(appid)] ?? null;
            (window as any).__copydeck_browse_path = await resolveGamePath(appid, knownDir);
          }
        }
        Navigation.Navigate("/copydeck/browse");
      }}
    >
      <span style={{ color: "#74c0fc" }}>{short ? "Browse" : "Browse (CopyDeck)"}</span>
    </MenuItem>
  );
};

// ── Set Target splice (non-Steam games only) ──────────────────────────────────

const COPYDECK_SET_TARGET_KEY = "copydeck-set-target";

const isNonSteamGame = (appid: number): boolean => {
  const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
  if (shortcutDirs[String(appid)] !== undefined) return true;
  // Also check appStore if available (app_type 1073741824 = non-Steam shortcut)
  try {
    const ov = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
    if (ov?.app_type === 1073741824) return true;
  } catch { /* ignore */ }
  return false;
};

const applyShortcutTarget = async (appid: number, snapshot: TargetSnapshot) => {
  const { exe: exePath, startDir, launchOptions, isLutris, lutrisId, lutrisPgaDb, lutrisYmlPath, lutrisInstallDir, lutrisPrefixPath, lutrisArgs, lutrisWorkingDir } = snapshot;

  if (isLutris) {
    // Lutris snapshot — write back to YML only, do NOT touch the Steam shortcut.
    const installDir = lutrisInstallDir ?? exePath; // back-compat with old snapshots
    const prefixPath = lutrisPrefixPath ?? launchOptions ?? ""; // back-compat
    const args = lutrisArgs ?? "";
    const workingDir = lutrisWorkingDir ?? "";
    try {
      const result = await updateLutrisPaths(
        lutrisPgaDb ?? "",
        lutrisId ?? 0,
        lutrisYmlPath ?? "",
        installDir,
        prefixPath,
        exePath, // restore exact exe path
        args,
        workingDir,
      );
      if (result.success) {
        toaster.toast({ title: "Lutris paths restored", body: exePath });
      } else {
        toaster.toast({ title: "Lutris restore failed", body: (result.errors ?? []).join(", ") || "Unknown error" });
      }
    } catch (e) {
      toaster.toast({ title: "Lutris restore failed", body: String(e) });
    }
    return;
  }

  // Standard non-Steam shortcut restore
  const dir = startDir || (exePath.substring(0, exePath.lastIndexOf("/")) || "/");
  const quotedExe = `"${exePath}"`;
  const quotedDir = `"${dir}"`;
  try {
    const oldSnapshot = await getShortcutSnapshot(appid).catch(() => ({ exe: "", startDir: "", launchOptions: "" }));
    (window as any).SteamClient?.Apps?.SetShortcutExe?.(appid, quotedExe);
    (window as any).SteamClient?.Apps?.SetShortcutStartDir?.(appid, quotedDir);
    if (launchOptions !== undefined) {
      (window as any).SteamClient?.Apps?.SetShortcutLaunchOptions?.(appid, launchOptions);
    }
    // Update shortcut_dirs so subsequent menu opens reflect the new location
    const dirs = (window as any).__copydeck_shortcut_dirs ?? {};
    dirs[String(appid)] = dir;
    (window as any).__copydeck_shortcut_dirs = dirs;
    if (oldSnapshot.exe && oldSnapshot.exe !== exePath) await addTargetHistory(appid, oldSnapshot);
    toaster.toast({ title: "Target restored", body: exePath });
  } catch (e) {
    toaster.toast({ title: "Failed to set target", body: String(e) });
  }
};

const spliceSetTargetItem = (children: any[], appid: number, short = false) => {
  const idx = children.findIndex((item: any) => item?.key === COPYDECK_SET_TARGET_KEY);
  if (idx !== -1) children.splice(idx, 1);

  if (!_setTargetInMenu) return;
  if (!isNonSteamGame(appid)) return;

  const propertiesMenuItemIdx = children.findIndex((item: any) =>
    findInReactTree(item, (x: any) =>
      x?.onSelected?.toString?.().includes("AppProperties")
    )
  );
  const insertIdx =
    propertiesMenuItemIdx >= 0 ? propertiesMenuItemIdx : children.length;

  // Read history from in-memory cache (populated on QAM load or previous set target)
  const histCache: Record<string, TargetSnapshot[]> = (window as any).__copydeck_target_history ?? {};
  const history: TargetSnapshot[] = histCache[String(appid)] ?? [];

  if (history.length === 0) {
    // No history yet — simple menu item
    children.splice(
      insertIdx,
      0,
      <MenuItem
        key={COPYDECK_SET_TARGET_KEY}
        onSelected={async () => {
          // Detect Lutris first — use install_dir as initial path if so
          if ((window as any).__copydeck_lutris_support !== false) try {
            const lutrisResult = await detectLutrisShortcut(String(appid));
            if (lutrisResult.is_lutris && lutrisResult.game_info) {
              const info = lutrisResult.game_info;
              const lutrisInitial = await resolveGamePath(appid, info.install_dir || null) || undefined;
              (window as any).__copydeck_filepicker = {
                appid,
                initialPath: lutrisInitial,
                isLutris: true,
                lutrisId: info.id,
                lutrisPgaDb: info.pga_db,
                lutrisYmlPath: info.yml_path,
              };
              Navigation.Navigate("/copydeck/browse");
              return;
            }
          } catch {}
          // Non-Steam fallback — try shortcut exe, then last-resort drive search
          const exe = await getShortcutExe(appid).catch(() => "");
          const cleanExe = exe.replace(/^"|"$/g, "").trim();
          const dir = cleanExe ? cleanExe.substring(0, cleanExe.lastIndexOf("/")) : "";
          const initialPath = await resolveGamePath(appid, dir || null) || undefined;
          (window as any).__copydeck_filepicker = { appid, initialPath };
          Navigation.Navigate("/copydeck/browse");
        }}
      >
        <span style={{ color: "#a9e34b" }}>{short ? "Set Target" : "Set Target (CopyDeck)"}</span>
      </MenuItem>
    );
  } else {
    // History exists — show as MenuGroup with New Target + History submenu
    children.splice(
      insertIdx,
      0,
      <MenuGroup key={COPYDECK_SET_TARGET_KEY} label={short ? "Set Target" : "Set Target (CopyDeck)"}>
        <MenuItem
          onSelected={async () => {
            // Detect Lutris first — use install_dir as initial path if so
            if ((window as any).__copydeck_lutris_support !== false) try {
              const lutrisResult = await detectLutrisShortcut(String(appid));
              if (lutrisResult.is_lutris && lutrisResult.game_info) {
                const info = lutrisResult.game_info;
                const lutrisInitial = await resolveGamePath(appid, info.install_dir || null) || undefined;
                (window as any).__copydeck_filepicker = {
                  appid,
                  initialPath: lutrisInitial,
                  isLutris: true,
                  lutrisId: info.id,
                  lutrisPgaDb: info.pga_db,
                  lutrisYmlPath: info.yml_path,
                };
                Navigation.Navigate("/copydeck/browse");
                return;
              }
            } catch {}
            // Non-Steam fallback — try shortcut exe, then last-resort drive search
            const exe = await getShortcutExe(appid).catch(() => "");
            const cleanExe = exe.replace(/^"|"$/g, "").trim();
            const dir = cleanExe ? cleanExe.substring(0, cleanExe.lastIndexOf("/")) : "";
            const initialPath = await resolveGamePath(appid, dir || null) || undefined;
            (window as any).__copydeck_filepicker = { appid, initialPath };
            Navigation.Navigate("/copydeck/browse");
          }}
        >
          <span style={{ color: "#a9e34b" }}>New Target</span>
        </MenuItem>
        <MenuGroup label="History">
          {history.map((h, i) => (
            <MenuItem key={i} onSelected={() => applyShortcutTarget(appid, h)}>
              {h.isLutris ? (
                <span style={{ fontSize: 12, fontFamily: "monospace", display: "block", textAlign: "left", width: "100%" }}>
                  <span style={{ color: "#f9a825", marginRight: 4 }}>[Lutris]</span>
                  {h.exe}
                </span>
              ) : (
                (() => {
                const { label, isHome, rel } = parseDrivePath(h.exe);
                return (
                  <span style={{ fontSize: 12, fontFamily: "monospace", display: "block", textAlign: "left", width: "100%" }}>
                    <span style={{ color: isHome ? "#a9e34b" : "#60a5fa", marginRight: 4 }}>[{label}]</span>{rel}
                  </span>
                );
              })()
              )}
            </MenuItem>
          ))}
          <MenuItem onSelected={() => removeTargetHistory(appid)}>
            <span style={{ color: "#888", fontSize: 12 }}>Clear All History</span>
          </MenuItem>
        </MenuGroup>
      </MenuGroup>
    );
  }
};

const COPYDECK_SUBMENU_KEY = "copydeck-submenu";

// ── Menu patching ─────────────────────────────────────────────────────────────

const isAppContextMenu = (items: any[]): boolean => {
  if (!items?.length) return false;
  return !!findInReactTree(
    items,
    (x: any) => x?.props?.onSelected?.toString?.().includes("launchSource")
  );
};

const patchMenuItems = (menuItems: any[], appid: number) => {
  let resolvedAppid = appid;
  const parentOverview = menuItems.find(
    (x: any) =>
      x?._owner?.pendingProps?.overview?.appid &&
      x._owner.pendingProps.overview.appid !== appid
  );
  if (parentOverview) {
    resolvedAppid = parentOverview._owner.pendingProps.overview.appid;
  }
  const foundApp = findInTree(menuItems, (x: any) => x?.app?.appid, {
    walkable: ["props", "children"],
  });
  if (foundApp?.app?.appid) {
    resolvedAppid = foundApp.app.appid;
  }

  // Remove existing submenu wrapper so it can be re-inserted cleanly
  const subIdx = menuItems.findIndex((item: any) => item?.key === COPYDECK_SUBMENU_KEY);
  if (subIdx !== -1) menuItems.splice(subIdx, 1);

  if (_subMenuInMenu) {
    // Build individual items into a temp array, then wrap in a MenuGroup
    const temp: any[] = [];
    if (_copyInMenu) spliceCopyToItem(temp, resolvedAppid, true);
    if (_uninstallInMenu) spliceUninstallItem(temp, resolvedAppid, true);
    spliceSetTargetItem(temp, resolvedAppid, true);
    if (_browseInMenu) spliceBrowseItem(temp, resolvedAppid, true);

    if (temp.length === 0) return;

    // Find insert position (before Properties)
    const propertiesIdx = menuItems.findIndex((item: any) =>
      findInReactTree(item, (x: any) =>
        x?.onSelected?.toString?.().includes("AppProperties")
      )
    );
    const insertIdx = propertiesIdx >= 0 ? propertiesIdx : menuItems.length;

    menuItems.splice(
      insertIdx,
      0,
      <MenuGroup key={COPYDECK_SUBMENU_KEY} label="CopyDeck">
        {temp}
      </MenuGroup>
    );
  } else {
    if (_copyInMenu) spliceCopyToItem(menuItems, resolvedAppid);
    if (_uninstallInMenu) spliceUninstallItem(menuItems, resolvedAppid);
    spliceSetTargetItem(menuItems, resolvedAppid);
    if (_browseInMenu) spliceBrowseItem(menuItems, resolvedAppid);
  }
};

// ── LibraryContextMenu finder ─────────────────────────────────────────────────

function getLibraryContextMenu(): any {
  try {
    const module = findModuleByExport((e: Export) =>
      e?.toString?.()?.includes("().LibraryContextMenu")
    ) as Record<string, unknown>;
    const component = Object.values(module).find((s: unknown) =>
      (s as any)?.toString?.()?.includes("navigator:")
    ) as Function;
    return fakeRenderComponent(component).type;
  } catch {
    return null;
  }
}

export const LibraryContextMenu = getLibraryContextMenu();

// ── Context menu patch ────────────────────────────────────────────────────────

const contextMenuPatch = (LibraryContextMenuComponent: any) => {
  if (!LibraryContextMenuComponent?.prototype) {
    return { unpatch: () => null };
  }
  const patches: {
    outer?: Patch;
    inner?: Patch;
    unpatch: () => void;
  } = { unpatch: () => null };

  patches.outer = afterPatch(
    LibraryContextMenuComponent.prototype,
    "render",
    (_: Record<string, unknown>[], component: any) => {
      let appid: number = 0;
      if (component._owner?.pendingProps?.overview?.appid != null) {
        appid = component._owner.pendingProps.overview.appid;
      } else {
        const found = findInTree(
          component.props?.children,
          (x: any) => x?.app?.appid,
          { walkable: ["props", "children"] }
        );
        if (found?.app?.appid) appid = found.app.appid;
      }

      if (!patches.inner) {
        patches.inner = afterPatch(component, "type", (_: any, ret: any) => {
          afterPatch(ret.type.prototype, "render", (_: any, ret2: any) => {
            const menuItems = ret2.props?.children?.[0];
            if (!menuItems || !isAppContextMenu(menuItems)) return ret2;
            try {
              patchMenuItems(menuItems, appid);
            } catch {
              return ret2;
            }
            return ret2;
          });
          afterPatch(
            ret.type.prototype,
            "shouldComponentUpdate",
            ([nextProps]: any, shouldUpdate: any) => {
              try {
                if (nextProps?.children) {
                  patchMenuItems(nextProps.children, appid);
                }
              } catch {
                return shouldUpdate;
              }
              return shouldUpdate;
            }
          );
          return ret;
        });
      } else {
        const menuItems = component.props?.children?.[0];
        if (menuItems && isAppContextMenu(menuItems)) {
          patchMenuItems(menuItems, appid);
        }
      }
      return component;
    }
  );

  patches.unpatch = () => {
    patches.outer?.unpatch();
    patches.inner?.unpatch();
  };
  return patches;
};

export default contextMenuPatch;
