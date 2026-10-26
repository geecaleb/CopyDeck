import { Focusable, Navigation, Tabs, gamepadTabbedPageClasses, Menu, MenuItem, MenuGroup, showContextMenu, TextField, showModal, ConfirmModal, DialogButton, ModalRoot, DialogBody, DialogFooter, DialogControlsSection, ReorderableList, ReorderableEntry } from "@decky/ui";
import { toaster, addEventListener, removeEventListener } from "@decky/api";
import { useState, useEffect, useCallback, useRef, useMemo, VFC } from "react";
import {
  getAllDrives, ejectDrive, queueFileOps, renamePath, renameSymlink, queueExtract, queueCompress, deletePath, createSymlink, createDir, createFile, getPathSize,
  readTextFile, writeTextFile, writeClipboardFile, readBinaryFile, renderPdfPages,
  addTargetHistory, getSetting, setSetting, getHomeDir,
  getShortcutExe, getShortcutSnapshot, updateLutrisPaths, getLutrisGameInfo,
  type Drive, type FsEntry, listDir,
} from "../utils/backendApi";
import { subscribeToProgress, forceRefresh } from "../lib/jobNotifier";
import { resolveConflictMode } from "../utils/copyConflicts";

// ── Custom Tab Types ──────────────────────────────────────────────────────────
interface CustomTab {
  id: string;
  name: string;
  path: string;
  driveDevice?: string; // Device identifier to track which drive this tab belongs to
}

interface DriveTabSettings {
  id: string; // Drive ID (from tabId(drive))
  customName?: string; // Optional custom name override
  position: number; // Position in tab order
}

interface TabsConfiguration {
  customTabs: CustomTab[];
  driveSettings: Record<string, DriveTabSettings>; // Keyed by drive ID
  tabOrder: string[]; // Array of tab IDs in display order
  defaultDrive?: string; // ID of the default drive to open on startup
  defaultTabReordered?: boolean; // True if user manually reordered after setting a default
}

// Decky getSetting/setSetting-based persistence for tabs configuration
const TABS_CONFIG_DEFAULT: TabsConfiguration = { customTabs: [], driveSettings: {}, tabOrder: [], defaultDrive: undefined, defaultTabReordered: false };

function loadTabsConfig(): TabsConfiguration {
  return TABS_CONFIG_DEFAULT;
}

async function saveTabsConfig(config: TabsConfiguration): Promise<void> {
  try {
    await setSetting("browser_tabs_config", JSON.stringify(config));
  } catch (e) {
    console.error("Failed to save tabs config:", e);
  }
}

async function loadTabsConfigAsync(): Promise<TabsConfiguration> {
  try {
    const stored = await getSetting("browser_tabs_config", "");
    if (stored) return { ...TABS_CONFIG_DEFAULT, ...JSON.parse(stored) };
  } catch (e) {
    console.error("Failed to load tabs config:", e);
  }
  return TABS_CONFIG_DEFAULT;
}
// ──────────────────────────────────────────────────────────────────────────────

// ── Browser display settings persistence (Decky getSetting/setSetting) ────────
interface BrowserSettings { showHidden: boolean; showItemCount: boolean; showAppIdNames: boolean; fileSortMode: "alpha" | "appid" | "size" | "modified" | "created" | "type"; }
function loadBrowserSettings(): BrowserSettings {
  return { showHidden: false, showItemCount: false, showAppIdNames: false, fileSortMode: "alpha" };
}
async function saveBrowserSettings(s: BrowserSettings): Promise<void> {
  await Promise.all([
    setSetting("browser_show_hidden", s.showHidden ? "true" : "false"),
    setSetting("browser_show_item_count", s.showItemCount ? "true" : "false"),
    setSetting("browser_show_appid_names", s.showAppIdNames ? "true" : "false"),
    setSetting("browser_file_sort_mode", s.fileSortMode),
  ]);
}

// ── Steamapps AppID name resolution helpers ───────────────────────────────────
// Detect which folder context the current path is in, and extract an appid
// from an entry name if applicable. Returns null if not in a relevant folder.
//
// Relevant contexts and entry name patterns:
//   steamapps/                  → appmanifest_APPID.acf (files) OR numeric APPID dirs
//   compatdata/                 → numeric APPID dirs OR appmanifest_APPID.acf (any parent)
//   shadercache/                → numeric APPID dirs (any parent)
//   steamapps/workshop/         → appworkshop_APPID.acf
//   steamapps/workshop/content/ → numeric APPID dirs
function extractSteamAppId(currentPath: string, entryName: string, isDir: boolean): string | null {
  const p = currentPath.replace(/\/+$/, "");
  const last = p.substring(p.lastIndexOf("/") + 1);
  const parent = p.substring(0, p.lastIndexOf("/"));
  const parentLast = parent.substring(parent.lastIndexOf("/") + 1);
  const isSteamapps = last === "steamapps" || last === "SteamApps";
  const isCompatdata = last === "compatdata" || last === "CompatData";
  const isShadercache = last === "shadercache" || last === "ShaderCache";

  // steamapps root: manifests and numeric appid folders (e.g. save mirrors)
  if (isSteamapps) {
    if (!isDir) {
      const m = entryName.match(/^appmanifest_(\d+)\.acf$/i);
      return m ? m[1] : null;
    }
    return /^\d+$/.test(entryName) ? entryName : null;
  }

  // Any folder named compatdata (not only under steamapps): dirs + manifests
  if (isCompatdata) {
    if (isDir) return /^\d+$/.test(entryName) ? entryName : null;
    const m = entryName.match(/^appmanifest_(\d+)\.acf$/i);
    return m ? m[1] : null;
  }

  // Any folder named shadercache: numeric dirs
  if (isShadercache && isDir) {
    return /^\d+$/.test(entryName) ? entryName : null;
  }

  // steamapps/workshop: match appworkshop_APPID.acf files
  if ((last === "workshop" || last === "Workshop") &&
      (parentLast === "steamapps" || parentLast === "SteamApps")) {
    const m = entryName.match(/^appworkshop_(\d+)\.acf$/i);
    return m ? m[1] : null;
  }

  // steamapps/workshop/content/APPID
  if (last === "content" && isDir) {
    const grandparent = parent.substring(0, parent.lastIndexOf("/"));
    const grandparentLast = grandparent.substring(grandparent.lastIndexOf("/") + 1);
    if (parentLast === "workshop" && (grandparentLast === "steamapps" || grandparentLast === "SteamApps")) {
      return /^\d+$/.test(entryName) ? entryName : null;
    }
  }

  // Custom non-Steam prefix destination set in QAM settings
  const customPrefixDest: string = ((window as any).__copydeck_nonsteam_prefix_dest ?? "").replace(/\/+$/, "");
  if (customPrefixDest && p === customPrefixDest && isDir) {
    return /^\d+$/.test(entryName) ? entryName : null;
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

// Copy text to clipboard. execCommand works inside the Decky iframe;
// navigator.clipboard is a fallback for desktop mode.
async function copyTextToClipboard(text: string): Promise<boolean> {
  await writeClipboardFile(text).catch(() => {});
  const inp = document.createElement("input");
  inp.value = text;
  inp.style.cssText = "position:absolute;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(inp);
  try { inp.focus(); inp.select(); if (document.execCommand("copy")) { document.body.removeChild(inp); return true; } } catch {}
  document.body.removeChild(inp);
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  return false;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}
function formatGb(gb: number): string {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(gb * 1024).toFixed(0)} MB`;
}

const TEXT_EXTS = new Set([
  "txt","md","sh","bat","py","js","ts","jsx","tsx","json","yaml","yml",
  "toml","ini","cfg","conf","log","xml","html","css","env","gitignore",
  "dockerfile","makefile","csv","rs","go","c","cpp","h","java","rb","php",
  "acf",
]);
function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const base = name.toLowerCase();
  return TEXT_EXTS.has(ext) || base === "makefile" || base === "dockerfile";
}

const NONSTEAM_EXTS = new Set(["exe","appimage","sh","bat","cmd","py","bin"]);
function isExecutable(name: string): boolean {
  return NONSTEAM_EXTS.has(name.split(".").pop()?.toLowerCase() ?? "");
}

const IMAGE_EXTS = new Set(["jpg","jpeg","png","gif","webp","bmp","svg","ico"]);
const PDF_EXTS   = new Set(["pdf"]);
const AUDIO_EXTS = new Set(["mp3","ogg","flac","wav","m4a","aac"]);
function isImageFile(name: string): boolean { return IMAGE_EXTS.has(name.split(".").pop()?.toLowerCase() ?? ""); }
function isPdfFile(name: string):  boolean { return PDF_EXTS.has(name.split(".").pop()?.toLowerCase() ?? ""); }
function isAudioFile(name: string): boolean { return AUDIO_EXTS.has(name.split(".").pop()?.toLowerCase() ?? ""); }

// ── Inline file viewer (image + PDF) ─────────────────────────────────────────
// ── File viewer modal (image + PDF) ──────────────────────────────────────────
// Uses showModal + ModalRoot so Steam's nav tree is properly captured.
// Images: For single images on browser page, < > buttons navigate between all images.
// PDFs: one page at a time — < > buttons or d-pad or L1/R1 to flip pages,
//       so the modal never overflows and no scroll fighting needed.
interface FileViewerModalProps { 
  entry: FsEntry; 
  kind: "image" | "pdf" | "audio"; 
  closeModal?: () => void;
  allEntries?: FsEntry[]; // For image navigation between files
}
const FileViewerModal: VFC<FileViewerModalProps> = ({ entry, kind, closeModal, allEntries = [] }) => {
  const [pages, setPages]     = useState<string[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [err, setErr]         = useState<string | null>(null);
  const [status, setStatus]   = useState("Loading…");
  const [currentEntry, setCurrentEntry] = useState(entry);

  // Audio-specific state
  const audioRef                        = useRef<HTMLAudioElement>(null);
  const [paused, setPaused]             = useState(false);
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]         = useState(0);
  const [shuffle, setShuffle]           = useState(false);
  const [repeat, setRepeat]             = useState(false);
  const shuffleOrder = useRef<number[]>([]);
  const shufflePos   = useRef<number>(-1);

  const isAudio = kind === "audio";

  // Audio entries from directory (same pattern as imageEntries)
  const audioEntries = useMemo(() => {
    if (!isAudio || !allEntries.length) return [];
    return allEntries.filter(e => !e.is_dir && isAudioFile(e.name));
  }, [isAudio, allEntries]);

  const currentAudioIdx = useMemo(() => {
    if (!isAudio || !audioEntries.length) return -1;
    return audioEntries.findIndex(e => e.path === currentEntry.path);
  }, [isAudio, audioEntries, currentEntry.path]);

  const goToAudio = useCallback((idx: number) => {
    const wrapped = ((idx % audioEntries.length) + audioEntries.length) % audioEntries.length;
    setCurrentEntry(audioEntries[wrapped]);
    setCurrentTime(0);
    setDuration(0);
    setPaused(false);
  }, [audioEntries]);

  // Build/advance a Fisher-Yates shuffle order
  const buildShuffle = useCallback((currentIdx: number) => {
    const indices = audioEntries.map((_, i) => i).filter(i => i !== currentIdx);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    // Put current track first so position 0 = now playing
    shuffleOrder.current = [currentIdx, ...indices];
    shufflePos.current = 0;
  }, [audioEntries]);

  const nextTrackShuffle = useCallback(() => {
    if (!audioEntries.length) return;
    if (shuffleOrder.current.length !== audioEntries.length) {
      buildShuffle(currentAudioIdx);
    }
    shufflePos.current = (shufflePos.current + 1) % shuffleOrder.current.length;
    goToAudio(shuffleOrder.current[shufflePos.current]);
  }, [audioEntries, currentAudioIdx, buildShuffle, goToAudio]);

  const prevTrackShuffle = useCallback(() => {
    if (!audioEntries.length) return;
    if (shuffleOrder.current.length !== audioEntries.length) {
      buildShuffle(currentAudioIdx);
    }
    shufflePos.current = (shufflePos.current - 1 + shuffleOrder.current.length) % shuffleOrder.current.length;
    goToAudio(shuffleOrder.current[shufflePos.current]);
  }, [audioEntries, currentAudioIdx, buildShuffle, goToAudio]);

  const prevTrack = useCallback(() => {
    if (shuffle) prevTrackShuffle();
    else goToAudio(currentAudioIdx - 1);
  }, [shuffle, prevTrackShuffle, goToAudio, currentAudioIdx]);

  const nextTrack = useCallback(() => {
    if (shuffle) nextTrackShuffle();
    else goToAudio(currentAudioIdx + 1);
  }, [shuffle, nextTrackShuffle, goToAudio, currentAudioIdx]);

  const toggleShuffle = useCallback(() => {
    setShuffle(s => {
      if (!s) buildShuffle(currentAudioIdx); // build fresh order when enabling
      return !s;
    });
  }, [buildShuffle, currentAudioIdx]);

  const toggleRepeat = useCallback(() => setRepeat(r => !r), []);

  const togglePause = useCallback(() => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) { audioRef.current.play(); setPaused(false); }
    else { audioRef.current.pause(); setPaused(true); }
  }, []);

  const skipBack    = useCallback(() => {
    if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15);
  }, []);
  const skipForward = useCallback(() => {
    if (audioRef.current) audioRef.current.currentTime = Math.min(duration || 0, audioRef.current.currentTime + 15);
  }, [duration]);

  // For image mode: find all images in the directory
  const imageEntries = useMemo(() => {
    if (kind !== "image" || !allEntries.length) return [];
    return allEntries.filter(e => !e.is_dir && isImageFile(e.name));
  }, [kind, allEntries]);

  const currentImageIdx = useMemo(() => {
    if (kind !== "image" || !imageEntries.length) return -1;
    return imageEntries.findIndex(e => e.path === currentEntry.path);
  }, [kind, imageEntries, currentEntry.path]);

  const prevPage = () => {
    if (kind === "pdf") {
      setPageIdx((i) => Math.max(0, i - 1));
    } else if (kind === "image" && imageEntries.length > 1) {
      const prevIdx = currentImageIdx > 0 ? currentImageIdx - 1 : imageEntries.length - 1;
      setCurrentEntry(imageEntries[prevIdx]);
      setPageIdx(0);
    }
  };

  const nextPage = () => {
    if (kind === "pdf") {
      setPageIdx((i) => Math.min(pages.length - 1, i + 1));
    } else if (kind === "image" && imageEntries.length > 1) {
      const nextIdx = currentImageIdx < imageEntries.length - 1 ? currentImageIdx + 1 : 0;
      setCurrentEntry(imageEntries[nextIdx]);
      setPageIdx(0);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setErr(null);
    setStatus("Loading…");
    (async () => {
      try {
        if (kind === "image") {
          const r = await readBinaryFile(currentEntry.path);
          if (cancelled) return;
          if (!r.success || !r.data) { setErr(r.error ?? "Failed to read"); setStatus(""); return; }
          setPages([`data:${r.mime};base64,${r.data}`]);
          setStatus("");
        } else if (kind === "audio") {
          const r = await readBinaryFile(currentEntry.path);
          if (cancelled) return;
          if (!r.success || !r.data) { setErr(r.error ?? "Failed to read"); setStatus(""); return; }
          setPages([`data:${r.mime};base64,${r.data}`]);
          setStatus("");
        } else {
          setStatus("Rendering PDF…");
          const r = await renderPdfPages(currentEntry.path, 185);
          if (cancelled) return;
          if (!r.success || !r.pages) { setErr(r.error ?? "Failed to render PDF"); setStatus(""); return; }
          setPages(r.pages.map((b64) => `data:image/png;base64,${b64}`));
          setStatus("");
        }
      } catch (e: any) {
        if (!cancelled) { setErr(String(e?.message ?? e)); setStatus(""); }
      }
    })();
    return () => { cancelled = true; };
  }, [currentEntry.path, kind]);

  const currentSrc  = pages[pageIdx] ?? null;
  const pdfCanNav   = kind === "pdf"   && pages.length > 1;
  const imgCanNav   = kind === "image" && imageEntries.length > 1;
  const canNavigate = pdfCanNav || imgCanNav;

  const pageLabel = kind === "pdf"
    ? `${pageIdx + 1} / ${pages.length}`
    : currentImageIdx >= 0
      ? `${currentImageIdx + 1} / ${imageEntries.length}`
      : isAudio && audioEntries.length > 1
        ? `${currentAudioIdx + 1} / ${audioEntries.length}`
        : "";

  const fmtTime = (s: number) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const btnStyle: React.CSSProperties = {
    padding: "6px 14px",
    minWidth: 36,
    fontSize: 11,
    fontWeight: "bold",
  };

  return (
    <ModalRoot onCancel={closeModal}>
      <Focusable
        noFocusRing
        onCancelButton={closeModal}
        onCancelActionDescription="Close"
        onSecondaryButton={isAudio ? skipBack : (canNavigate ? prevPage : undefined)}
        onSecondaryActionDescription={isAudio ? "X - −15s" : (canNavigate ? "X - Previous" : undefined)}
        onOptionsButton={isAudio ? skipForward : (canNavigate ? nextPage : undefined)}
        onOptionsActionDescription={isAudio ? "Y - +15s" : (canNavigate ? "Y - Next" : undefined)}
      >
        <DialogBody>
          <DialogControlsSection>
            {/* ── Title row ── */}
            <div style={{
              fontSize: 12, color: "#aaa",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              paddingBottom: isAudio ? 12 : 4,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {kind === "image" ? "🖼️" : kind === "audio" ? "🎵" : "📕"}<span style={{ marginLeft: kind === "audio" ? 8 : 4 }}>{currentEntry.name}</span>
              </span>
              {pageLabel && (
                <span style={{ flexShrink: 0, marginLeft: 12, color: "#666", fontSize: 11 }}>
                  {pageLabel}
                </span>
              )}
            </div>

            {/* ── Content area — fixed height so Steam's modal stays in bounds ── */}
            <div style={{ height: "55vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              {err ? (
                <div style={{ color: "#fa5252", padding: 16, fontSize: 13, textAlign: "center" }}>{err}</div>
              ) : status ? (
                <div style={{ color: "#888", padding: 16, fontSize: 13, textAlign: "center" }}>{status}</div>
              ) : isAudio && currentSrc ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, width: "100%" }}>
                  {/* Hidden audio element */}
                  <audio
                    ref={audioRef}
                    src={currentSrc}
                    autoPlay
                    loop={repeat && audioEntries.length <= 1}
                    onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
                    onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)}
                    onEnded={() => {
                      if (repeat) {
                        if (audioEntries.length <= 1) return;
                        if (audioRef.current) { audioRef.current.currentTime = 0; audioRef.current.play(); }
                      } else if (audioEntries.length > 1) {
                        nextTrack();
                      }
                    }}
                    onPlay={() => setPaused(false)}
                    onPause={() => setPaused(true)}
                    style={{ display: "none" }}
                  />
                  <div style={{ fontSize: 52, lineHeight: 1 }}>🎵</div>
                  <div style={{ width: "85%", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ width: "100%", height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{
                        height: "100%",
                        width: duration > 0 ? `${(currentTime / duration) * 100}%` : "0%",
                        background: "rgba(255,255,255,0.6)",
                        borderRadius: 2,
                        transition: "width 0.5s linear",
                      }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#666" }}>
                      <span>{fmtTime(currentTime)}</span>
                      <span>{fmtTime(duration)}</span>
                    </div>
                  </div>
                  <Focusable flow-children="right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <DialogButton style={{ ...btnStyle, fontSize: 15, opacity: shuffle ? 1 : 0.45, background: shuffle ? "rgba(76,110,245,0.35)" : undefined }} onClick={toggleShuffle}>⇄</DialogButton>
                    <DialogButton style={{ ...btnStyle, fontSize: 15 }} onClick={prevTrack}>⏮</DialogButton>
                    <DialogButton style={{ ...btnStyle, fontSize: 17 }} onClick={togglePause}>{paused ? "▶" : "⏸"}</DialogButton>
                    <DialogButton style={{ ...btnStyle, fontSize: 15 }} onClick={nextTrack}>⏭</DialogButton>
                    <DialogButton style={{ ...btnStyle, fontSize: 16, opacity: repeat ? 1 : 0.45, background: repeat ? "rgba(76,110,245,0.35)" : undefined }} onClick={toggleRepeat}>↺</DialogButton>
                  </Focusable>
                </div>
              ) : currentSrc ? (
                <img
                  src={currentSrc}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
                />
              ) : null}
            </div>

            {/* ── Bottom nav buttons (pdf/image only) ── */}
            {canNavigate && !status && !err && (
              <Focusable flow-children="right" style={{ display: "flex", justifyContent: "center", gap: 8, paddingTop: 8 }}>
                <DialogButton style={btnStyle} onClick={prevPage}>&#8249; Prev</DialogButton>
                <DialogButton style={btnStyle} onClick={nextPage}>Next &#8250;</DialogButton>
              </Focusable>
            )}

            {/* ── Hint row ── */}
            {!status && !err && (
              <div style={{ fontSize: 10, color: "#555", textAlign: "center", paddingTop: 4 }}>
                {isAudio ? "X / Y  ·  −15s / +15s    " : canNavigate ? "X / Y  ·  prev / next    " : ""}B  ·  close
              </div>
            )}
          </DialogControlsSection>
        </DialogBody>
      </Focusable>
    </ModalRoot>
  );
};

function openFileViewer(entry: FsEntry, kind: "image" | "pdf" | "audio", allEntries: FsEntry[] = []) {
  showModal(<FileViewerModal entry={entry} kind={kind} allEntries={allEntries} />, window);
}

// Image and PDF viewers use showModal so the nav tree is properly captured.

type BrowseMode = "navigate" | "select";

interface SymlinkClipboard { kind: "symlink"; path: string; name: string; }
interface PathClipboard    { kind: "path";    path: string; name: string; }
type GlobalClip = SymlinkClipboard | PathClipboard | null;

let _moduleClip: GlobalClip = (window as any).__copydeck_clip ?? null;
function getGlobalClip(): GlobalClip { return _moduleClip; }
function setGlobalClip(c: GlobalClip) { _moduleClip = c; (window as any).__copydeck_clip = c; }

interface FileClipboard { op: "copy" | "cut"; paths: string[]; names: string[]; sourceDir: string; }

interface DriveState {
  stack: string[]; allEntries: FsEntry[]; loading: boolean; errorMsg: string | null;
  showHidden: boolean; showItemCount: boolean; mode: BrowseMode; selected: Set<string>; focusedPath: string | null;
}

/** Session-only browse location (tab + stacks). Survives leaving Browse;
 *  cleared when Steam / Plugin Loader restarts. */
interface BrowserSession {
  activeTab: string;
  driveStates: Record<string, DriveState>;
}
function getBrowserSession(): BrowserSession | null {
  return ((window as any).__copydeck_browser_session as BrowserSession | undefined) ?? null;
}
function setBrowserSession(s: BrowserSession | null) {
  (window as any).__copydeck_browser_session = s;
}
/** Default on — keep last Browse tab/path until Steam / Plugin Loader restarts. */
function isBrowseRememberOn(): boolean {
  return (window as any).__copydeck_browse_remember_location !== false;
}

function makeDriveState(rootPath: string): DriveState {
  const saved = loadBrowserSettings();
  return { stack: rootPath ? [rootPath] : [], allEntries: [], loading: false, errorMsg: null,
    showHidden: saved.showHidden, showItemCount: false, mode: "navigate", selected: new Set(), focusedPath: null };
}
function rootPathFor(drive: Drive): string { return drive.is_internal ? "/home/deck" : (drive.path || ""); }
function toastLabel(names: string[]): string {
  if (!names.length) return "items";
  if (names.length === 1) return names[0];
  return `${names[0]} & ${names.length - 1} other${names.length - 1 === 1 ? "" : "s"}`;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg","jpeg","png","gif","webp","bmp","svg","ico"].includes(ext)) return "🖼️";
  if (["mp4","mkv","avi","mov","webm","flv"].includes(ext)) return "🎬";
  if (["mp3","flac","ogg","wav","aac","m4a","opus"].includes(ext)) return "🎵";
  if (["zip","tar","gz","xz","bz2","7z","rar","zst"].includes(ext)) return "📦";
  if (["sh","bat","cmd"].includes(ext)) return "⚙️";
  if (["py","js","ts","jsx","tsx","rs","go","c","cpp","java","rb","php"].includes(ext)) return "💻";
  if (["json","yaml","yml","toml","xml","ini","cfg","conf","env"].includes(ext)) return "📋";
  if (["txt","md","log","csv"].includes(ext)) return "📝";
  if (["pdf"].includes(ext)) return "📕";
  if (["exe","AppImage","deb","rpm"].includes(ext)) return "🚀";
  return "📄";
}

// ── Text editor modal ─────────────────────────────────────────────────────────
// Plain overlay (no ConfirmModal) so we own all gamepad button bindings.
// ☰ = add line. X = remove line. Y = save. B while editing = exit edit only.
interface TextEditorModalProps { entry: FsEntry; closeModal?: () => void; onSaved: () => void; }
const TextEditorModal: VFC<TextEditorModalProps> = ({ entry, closeModal, onSaved }) => {
  const [lines, setLines]       = useState<string[] | null>(null);
  const [loadErr, setLoadErr]   = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [editIdx, setEditIdx]   = useState<number | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number>(0);

  useEffect(() => {
    readTextFile(entry.path).then((r) => {
      if (r.success) setLines((r.text ?? "").split("\n"));
      else setLoadErr(r.error ?? "Failed to load");
    });
  }, [entry.path]);

  const handleSave = useCallback(async () => {
    if (lines === null) return;
    setSaving(true);
    const res = await writeTextFile(entry.path, lines.join("\n"));
    setSaving(false);
    if (res.success) {
      toaster.toast({ title: "Saved", body: entry.name });
      setDirty(false);
      onSaved();
      closeModal?.();
    } else {
      toaster.toast({ title: "Save failed", body: res.error ?? "Unknown error" });
    }
  }, [lines, entry, onSaved, closeModal]);

  const updateLine = (i: number, val: string) => {
    setLines((prev) => { if (!prev) return prev; const n = [...prev]; n[i] = val; return n; });
    setDirty(true);
  };

  const insertLineAfter = useCallback((i: number) => {
    setLines((prev) => {
      if (!prev) return prev;
      const n = [...prev.slice(0, i + 1), "", ...prev.slice(i + 1)];
      setTimeout(() => { setFocusedIdx(i + 1); }, 0);
      return n;
    });
    setDirty(true);
  }, []);

  const removeLine = useCallback((i: number) => {
    setLines((prev) => {
      if (!prev || prev.length <= 1) return prev;
      const n = prev.filter((_, idx) => idx !== i);
      setFocusedIdx(Math.min(i, n.length - 1));
      setEditIdx(null);
      return n;
    });
    setDirty(true);
  }, []);

  const editorBtnStyle: React.CSSProperties = {
    padding: "6px 20px",
    minWidth: 80,
    fontSize: 11,
    fontWeight: "bold",
  };

  return (
    <ModalRoot onCancel={closeModal}>
      <Focusable
        noFocusRing
        onCancelButton={closeModal}
        onCancelActionDescription="Close"
        // X button = remove line
        onSecondaryButton={() => { if (lines !== null && editIdx === null) removeLine(focusedIdx); }}
        onSecondaryActionDescription="X - Remove line"
        // Y button = add line
        onOptionsButton={() => { if (lines !== null && editIdx === null) insertLineAfter(focusedIdx); }}
        onOptionsActionDescription="Y - Add line below"
        // Menu button = save
        onMenuButton={handleSave}
        onMenuActionDescription={saving ? "Saving…" : "≡ Save"}
      >
        <DialogBody>
          <DialogControlsSection>
            {/* ── Title row ── */}
            <div style={{
              fontSize: 12, color: "#aaa",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              paddingBottom: 4,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                ✏️ {entry.name}{dirty ? " •" : ""}
              </span>
              <span style={{ flexShrink: 0, marginLeft: 12, color: "#555", fontSize: 10 }}>
                {lines !== null ? `${lines.length} line${lines.length !== 1 ? "s" : ""}` : ""}
                {saving ? "  · Saving…" : dirty ? "  · Unsaved" : ""}
              </span>
            </div>

            {/* ── Content — fixed height scrollable area ── */}
            {loadErr ? (
              <div style={{ color: "#fa5252", fontSize: 13, padding: 8 }}>{loadErr}</div>
            ) : lines === null ? (
              <div style={{ color: "#555", fontSize: 13, padding: 8 }}>Loading…</div>
            ) : (
              <div style={{
                height: "55vh",
                background: "#0d0d14",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 4,
                overflowY: "auto",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: "1.7",
              }}>
                {lines.map((line, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "stretch",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    background: editIdx === i ? "#ffffff" : focusedIdx === i ? "rgba(76,110,245,0.18)" : "transparent",
                  }}>
                    <span style={{
                      fontSize: 10, color: editIdx === i ? "#888" : "#333",
                      width: 30, flexShrink: 0,
                      background: "rgba(0,0,0,0.25)", userSelect: "none",
                      borderRight: "1px solid rgba(255,255,255,0.04)",
                      display: "flex", alignItems: "center", justifyContent: "flex-end",
                      paddingRight: 6,
                    }}>{i + 1}</span>
                    {editIdx === i ? (
                      <Focusable
                        onCancelButton={() => setEditIdx(null)}
                        onCancelActionDescription="Stop editing"
                        style={{ flex: 1, minWidth: 0, width: "100%" }}
                      >
                        <TextFieldWithContextMenu
                          autoFocus
                          value={line}
                          onChange={(e: any) => updateLine(i, e.target.value)}
                          onKeyDown={(e: any) => {
                            if (e.key === "Enter" || e.key === "Escape") {
                              e.preventDefault();
                              setEditIdx(null);
                            }
                          }}
                          style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 12, background: "#ffffff", color: "#111", borderRadius: 0 }}
                        />
                      </Focusable>
                    ) : (
                      <Focusable
                        onActivate={() => setEditIdx(i)}
                        onFocus={() => setFocusedIdx(i)}
                        noFocusRing={false}
                        style={{ flex: 1, padding: "4px 8px", color: "#d4d4d4", whiteSpace: "pre-wrap", wordBreak: "break-all", minHeight: 26, cursor: "pointer" }}
                      >
                        {line || " "}
                      </Focusable>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── Bottom buttons ── */}
            {!loadErr && lines !== null && (
              <Focusable flow-children="right" style={{ display: "flex", justifyContent: "center", gap: 8, paddingTop: 8 }}>
                <DialogButton className="Primary" style={editorBtnStyle} onClick={handleSave}>
                  {saving ? "Saving…" : "Save"}
                </DialogButton>
                <DialogButton style={editorBtnStyle} onClick={closeModal}>Close</DialogButton>
              </Focusable>
            )}

            {/* ── Hint row ── */}
            <div style={{ fontSize: 10, color: "#555", textAlign: "center", paddingTop: 4 }}>
              A=edit · X=remove · B=close · Y=add · ≡=save
            </div>
          </DialogControlsSection>
        </DialogBody>
      </Focusable>
    </ModalRoot>
  );
};

// openTextEditor: call showModal directly — no overlay state needed.
function openTextEditorModal(entry: FsEntry, onSaved: () => void) {
  showModal(<TextEditorModal entry={entry} onSaved={onSaved} />, window);
}

// ── Overlay input (path edit + rename) ───────────────────────────────────────
// ── SizeModal ────────────────────────────────────────────────────────────────
// Shows a live-calculating size for one or more paths, like Dolphin's Properties.
interface SizeModalProps { paths: string[]; label: string; closeModal?: () => void; }
const SizeModal: VFC<SizeModalProps> = ({ paths, label, closeModal }) => {
  const [size, setSize] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let total = 0;
      for (const p of paths) {
        if (cancelled) return;
        const r = await getPathSize(p);
        if (r.success) total += r.size_bytes;
        if (!cancelled) setSize(total);
      }
      if (!cancelled) setDone(true);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <ConfirmModal
      strTitle={`Size — ${label}`}
      strOKButtonText="Done"
      onOK={closeModal}
      onCancel={closeModal}
    >
      <div style={{ padding: "8px 0", fontSize: 15, color: "#cdd6f4", textAlign: "center" }}>
        {size === null ? (
          <span style={{ color: "#888" }}>Calculating…</span>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>{formatSize(size)}</span>
            {!done && <span style={{ fontSize: 11, color: "#555", marginLeft: 8 }}>scanning…</span>}
          </>
        )}
      </div>
      {done && size !== null && (
        <div style={{ fontSize: 11, color: "#555", textAlign: "center", marginTop: 4 }}>
          {size.toLocaleString()} bytes
        </div>
      )}
    </ConfirmModal>
  );
};
// ─────────────────────────────────────────────────────────────────────────────

// ── TextFieldWithContextMenu ─────────────────────────────────────────────────
// Wraps TextField with a compact right-click context menu that works in
// gaming mode. Copy uses the writeClipboardFile hack so it persists after
// the browser overlay closes.
interface TFCMProps {
  value?: string;
  defaultValue?: string;
  autoFocus?: boolean;
  onChange?: (e: any) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  style?: React.CSSProperties;
}
const TextFieldWithContextMenu: VFC<TFCMProps> = (props) => {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    // Let Steam's native right-click menu show normally.
    // Intercept the 'copy' event so that whenever the user picks Copy from
    // the native menu (or presses Ctrl+C), we ALSO run writeClipboardFile so
    // the text survives after the browser overlay closes in gaming mode.
    let attached: HTMLInputElement | HTMLTextAreaElement | null = null;

    const onCopy = async (e: Event) => {
      const input = attached;
      if (!input) return;
      const sel = input.value.substring(input.selectionStart ?? 0, input.selectionEnd ?? input.value.length);
      const text = sel || input.value;
      try { await writeClipboardFile(text); } catch {}
    };

    const attachToInput = () => {
      const input = el.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      if (input && input !== attached) {
        if (attached) attached.removeEventListener("copy", onCopy);
        input.addEventListener("copy", onCopy);
        attached = input;
      }
    };

    attachToInput();
    const obs = new MutationObserver(attachToInput);
    obs.observe(el, { childList: true, subtree: true });

    return () => {
      obs.disconnect();
      if (attached) attached.removeEventListener("copy", onCopy);
    };
  }, []);

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <TextField {...props} />
    </div>
  );
};
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayInputProps { label: string; value: string; onChange: (v: string) => void; onCommit: () => void; onCancel: () => void; }
const OverlayInput: VFC<OverlayInputProps> = ({ label, value, onChange, onCommit, onCancel }) => (
  <Focusable
    style={{ position: "absolute", inset: 0, zIndex: 99, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.75)" }}
    onCancelButton={onCancel} onCancelActionDescription="Cancel"
    noFocusRing
  >
    <div style={{ width: "80%", background: "#1e1e2e", borderRadius: 8, padding: "16px 20px",
      border: "1px solid rgba(76,110,245,0.5)" }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{label}</div>
      <TextFieldWithContextMenu autoFocus value={value} onChange={(e: any) => onChange(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        style={{ width: "100%", fontSize: 13, boxSizing: "border-box" }} />
      <div style={{ fontSize: 11, color: "#555", marginTop: 6, textAlign: "right" }}>Enter = confirm  ·  B = cancel</div>
    </div>
  </Focusable>
);

// ── DriveBrowser ──────────────────────────────────────────────────────────────
interface DriveBrowserProps {
  drive: Drive; state: DriveState; onStateChange: (patch: Partial<DriveState>) => void;
  fileClipboard: FileClipboard | null; onFileClipboard: (cb: FileClipboard | null) => void;
  onExit: () => void; onDriveChanged: () => void;
  onNavigateToDrive: (drivePath: string, targetPath: string) => void;
  drives: Drive[];
  customTabs: CustomTab[];
  onAddTab: (tab: CustomTab) => void;
  onRemoveTab: (tabId: string) => void;
  onRenameTab: (tabId: string, newName: string) => void;
  onFileSelect?: (path: string) => void;
  onDirSelect?: (path: string) => void;
  /** Banner text when picking a directory (scan location / Ludasavi / etc.) */
  dirSelectBanner?: string;
  isLutrisFilepicker?: boolean;
  bookmarks: string[];
  onBookmarksChange: (bookmarks: string[]) => void;
  onTabButton?: (evt: any) => void;
}

const DriveBrowser: VFC<DriveBrowserProps> = ({ drive, state, onStateChange, fileClipboard, onFileClipboard, onExit, onDriveChanged, onNavigateToDrive, drives, customTabs, onAddTab, onRemoveTab, onRenameTab, onFileSelect, onDirSelect, dirSelectBanner, isLutrisFilepicker, bookmarks, onBookmarksChange, onTabButton }) => {
  const { stack, allEntries, loading, errorMsg, showHidden, mode, selected, focusedPath } = state;
  const [globalClip, setGlobalClipState] = useState<GlobalClip>(getGlobalClip());
  // Seed from window cache so remounts (leave Browse → return, especially custom tabs)
  // don't flash false and race-write that into settings before the async load finishes.
  const cachedBrowser = ((window as any).__copydeck_browser_display ?? {}) as Partial<BrowserSettings>;
  const [showItemCount, setShowItemCount] = useState(() => cachedBrowser.showItemCount === true);
  const [showAppIdNames, setShowAppIdNames] = useState(() => cachedBrowser.showAppIdNames === true);
  // Cache of appid → resolved display name (seed from session so leave/return keeps names)
  const [appIdNames, setAppIdNames] = useState<Record<string, string>>(
    () => (((window as any).__copydeck_appid_names ?? {}) as Record<string, string>),
  );
  const [fileSortMode, setFileSortMode] = useState<BrowserSettings["fileSortMode"]>(
    () => cachedBrowser.fileSortMode || "alpha",
  );
  const [browserSettingsReady, setBrowserSettingsReady] = useState(
    () => (window as any).__copydeck_browser_display != null,
  );
  const listFocusRef = useRef<HTMLDivElement>(null);
  // Tracks current sixth position (0-6) for LT/RT trigger jumps
  const quarterIdxRef = useRef<number>(0);
  const [triggerStep, setTriggerStep] = useState<number>(0);
  const triggerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keeps focusedPath and entries fresh inside the hold-repeat closure
  const triggerLiveRef = useRef<{ focusedPath: string | null; entries: typeof entries }>({ focusedPath: null, entries: [] });

  // Load persisted display settings on mount
  useEffect(() => {
    Promise.all([
      getSetting("browser_show_hidden", "false"),
      getSetting("browser_show_item_count", "false"),
      getSetting("browser_show_appid_names", "false"),
      getSetting("browser_file_sort_mode", "alpha"),
    ]).then(([hidden, itemCount, appIdNamesVal, sortMode]) => {
      const next: BrowserSettings = {
        showHidden: hidden === "true",
        showItemCount: itemCount === "true",
        showAppIdNames: appIdNamesVal === "true",
        fileSortMode: (["alpha", "appid", "size", "modified", "created", "type"] as const).includes(sortMode as any)
          ? (sortMode as BrowserSettings["fileSortMode"])
          : "alpha",
      };
      (window as any).__copydeck_browser_display = next;
      setShowItemCount(next.showItemCount);
      setShowAppIdNames(next.showAppIdNames);
      setFileSortMode(next.fileSortMode);
      if (next.showHidden) onStateChange({ showHidden: true });
      setBrowserSettingsReady(true);
    }).catch(() => { setBrowserSettingsReady(true); });
  }, []);

  // Persist only after the initial load — otherwise remount starts at false and
  // overwrites the user's saved "Show AppId Names" before load completes.
  useEffect(() => {
    if (!browserSettingsReady) return;
    const next = { showHidden, showItemCount, showAppIdNames, fileSortMode };
    (window as any).__copydeck_browser_display = next;
    saveBrowserSettings(next);
  }, [browserSettingsReady, showHidden, showItemCount, showAppIdNames, fileSortMode]);


  const updateGlobalClip = (c: GlobalClip) => { setGlobalClip(c); setGlobalClipState(c); };
  const currentPath = stack[stack.length - 1] ?? "";
  const rawEntries = showHidden ? allEntries : allEntries.filter((e) => !e.name.startsWith("."));

  // Apply sort mode on top of the raw entry list
  const entries = useMemo(() => {
    const list = [...rawEntries];
    // When showAppIdNames is on, use the resolved display name as the alpha sort key
    const sortName = (entry: typeof rawEntries[0]): string => {
      if (showAppIdNames) {
        const appid = extractSteamAppId(currentPath, entry.name, entry.is_dir);
        if (appid && appIdNames[appid]) return appIdNames[appid];
      }
      return entry.name;
    };
    if (fileSortMode === "appid") {
      // Sort by raw filename (appid/original name) regardless of resolved display names
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    } else if (fileSortMode === "size") {
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.size_bytes - a.size_bytes;
      });
    } else if (fileSortMode === "modified") {
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return (b.mtime ?? 0) - (a.mtime ?? 0);
      });
    } else if (fileSortMode === "created") {
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return (b.ctime ?? 0) - (a.ctime ?? 0);
      });
    } else if (fileSortMode === "type") {
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        const extA = a.name.includes(".") ? a.name.split(".").pop()!.toLowerCase() : "";
        const extB = b.name.includes(".") ? b.name.split(".").pop()!.toLowerCase() : "";
        if (extA !== extB) return extA.localeCompare(extB);
        return sortName(a).localeCompare(sortName(b), undefined, { sensitivity: "base" });
      });
    } else {
      // alpha (default) — dirs first
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return sortName(a).localeCompare(sortName(b), undefined, { sensitivity: "base" });
      });
    }
    return list;
  }, [rawEntries, fileSortMode, showAppIdNames, appIdNames, currentPath]);

  // Appids that need names for the current folder (stable key — not the sorted entries array)
  const neededAppIdKey = useMemo(() => {
    if (!showAppIdNames || !currentPath || !allEntries.length) return "";
    const ids = new Set<string>();
    for (const entry of allEntries) {
      const appid = extractSteamAppId(currentPath, entry.name, entry.is_dir);
      if (appid) ids.add(appid);
    }
    return [...ids].sort().join(",");
  }, [showAppIdNames, currentPath, allEntries]);

  // Resolve Steam display names. Keep this close to the original behaviour, but:
  // - key off neededAppIdKey (not `entries`, which changes every sort)
  // - apply each name as it arrives
  // - mirror into window so remounts (custom tabs / leave-return) still have names
  useEffect(() => {
    if (!showAppIdNames || !neededAppIdKey) return;
    const toResolve = neededAppIdKey.split(",").filter(Boolean);
    const windowCache = ((window as any).__copydeck_appid_names ?? {}) as Record<string, string>;

    // Remount / leave-return: pull any already-known names into React state immediately
    const fromCache: Record<string, string> = {};
    for (const appid of toResolve) {
      if (windowCache[appid]) fromCache[appid] = windowCache[appid];
    }
    if (Object.keys(fromCache).length > 0) {
      setAppIdNames((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, name] of Object.entries(fromCache)) {
          if (next[id] !== name) {
            next[id] = name;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const applyName = (appid: string, name: string) => {
      // Always keep the window cache — callbacks often land after effect cleanup
      // (leave tab / remount), and we must not lose those names.
      (window as any).__copydeck_appid_names = {
        ...((window as any).__copydeck_appid_names ?? {}),
        [appid]: name,
      };
      if (cancelled) return;
      setAppIdNames((prev) => (prev[appid] === name ? prev : { ...prev, [appid]: name }));
    };

    for (const appid of toResolve) {
      if (windowCache[appid]) continue; // already known — no Steam re-request
      try {
        const { unregister } = (window as any).SteamClient.Apps.RegisterForAppDetails(
          parseInt(appid, 10),
          (details: any) => {
            try { unregister(); } catch { /* ignore */ }
            if (details?.strDisplayName) applyName(appid, details.strDisplayName);
          },
        );
        timers.push(setTimeout(() => { try { unregister(); } catch { /* ignore */ } }, 2500));
      } catch { /* ignore */ }
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [showAppIdNames, neededAppIdKey]);
  // Keep live ref current so the hold-repeat closure always reads fresh state
  useEffect(() => { triggerLiveRef.current = { focusedPath, entries }; }, [focusedPath, entries]);


  // Set to true by user-initiated navigation (pushDir/goUpDir/popDir) so
  // loadPath moves focus to the ↑.. row after loading. Never set on mount
  // or tab switch, so focus is never stolen from the tab strip.
  const refocusOnLoad = useRef(false);

  const loadPath = useCallback(async (path: string) => {
    if (!path) return;
    const shouldRefocus = refocusOnLoad.current;
    refocusOnLoad.current = false;
    quarterIdxRef.current = 0;
    setTriggerStep(0);
    onStateChange({ loading: true, errorMsg: null, selected: new Set(), focusedPath: null });
    try {
      const raw = await listDir(path);
      // Store raw (alpha+dirs-first) as allEntries; fileSortMode memo applies on top
      const sorted = [...raw].sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      onStateChange({ allEntries: sorted, loading: false });
      if (shouldRefocus) {
        setTimeout(() => {
          const el = listFocusRef.current?.querySelector("[tabindex]") as HTMLElement | null;
          el?.focus();
        }, 30);
      }
    } catch (e: any) { onStateChange({ errorMsg: String(e), loading: false }); }
  }, [onStateChange]);

  const prevPathRef = useRef<string>("");
  useEffect(() => {
    if (currentPath && currentPath !== prevPathRef.current) {
      prevPathRef.current = currentPath;
      loadPath(currentPath);
    }
  }, [currentPath, loadPath]);
  useEffect(() => {
    if (currentPath && allEntries.length === 0 && !loading && !errorMsg) { prevPathRef.current = ""; loadPath(currentPath); }
  }, []); // eslint-disable-line

  // Auto-refresh the file list when a copy/move/extract/compress job targeting this
  // directory finishes or is cancelled (cancelled compress deletes the partial archive).
  const prevJobSettled = useRef<Set<string>>(new Set());
  useEffect(() => {
    return subscribeToProgress((state) => {
      for (const [jobId, job] of Object.entries(state.jobs)) {
        const op = job.op;
        if (op !== "extract" && op !== "copy" && op !== "move" && op !== "compress") continue;
        const dstDir = job.dst_dir;
        // Refresh on done OR cancelled — cancelled compress deletes the partial file,
        // cancelled copy/move leaves no trace, but a refresh is harmless.
        const isSettled = job.status === "done" || job.status === "cancelled";
        const wasSettled = prevJobSettled.current.has(jobId);
        if (isSettled && !wasSettled && dstDir && currentPath) {
          if (dstDir === currentPath || currentPath.startsWith(dstDir + "/")) {
            loadPath(currentPath);
          }
        }
        if (isSettled) prevJobSettled.current.add(jobId);
        else prevJobSettled.current.delete(jobId);
      }
    });
  }, [currentPath, loadPath]);

  const pushDir = (path: string) => {
    refocusOnLoad.current = true;
    onStateChange({ mode: "navigate", selected: new Set(), stack: [...stack, path], focusedPath: null });
  };
  const popDir = useCallback(() => {
    if (mode === "select") { onStateChange({ mode: "navigate", selected: new Set() }); return; }
    if (stack.length > 1) { refocusOnLoad.current = true; onStateChange({ stack: stack.slice(0, -1) }); }
  }, [mode, stack, onStateChange, onExit]);

  // Go up one directory in the filesystem (always works, even at stack root)
  const goUpDir = useCallback(() => {
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
    if (parentPath !== currentPath) {
      refocusOnLoad.current = true;
      onStateChange({ mode: "navigate", selected: new Set(), stack: [...stack, parentPath], focusedPath: null });
    }
  }, [currentPath, stack, onStateChange]);

  const getTargets = useCallback((): FsEntry[] => {
    if (selected.size > 0) return entries.filter((e) => selected.has(e.path));
    if (focusedPath) { const entry = entries.find((e) => e.path === focusedPath); return entry ? [entry] : []; }
    return [];
  }, [selected, focusedPath, entries]);

  const doPaste = useCallback(async () => {
    if (!fileClipboard?.paths.length || !currentPath) return;
    const groupId = `fileop_${Date.now()}`;
    const fileOp = fileClipboard.op === "cut" ? "move" : "copy";
    const clip = fileClipboard;

    const conflictMode = await resolveConflictMode(
      clip.paths.map((src) => ({ src, dst_dir: currentPath }))
    );
    if (conflictMode === null) return; // cancelled

    const sizeResults = await Promise.all(
      clip.paths.map((src) => getPathSize(src).catch(() => ({ success: false, size_bytes: 0 })))
    );
    const groupTotalBytes = sizeResults.reduce((sum, r) => sum + (r.success ? r.size_bytes : 0), 0);
    const jobs = clip.paths.map((src, i) => ({
      op: fileOp as "copy" | "move", src, dst_dir: currentPath,
      label: clip.names[i] ?? src.split("/").pop() ?? src, group_id: groupId, group_total: clip.paths.length,
      group_total_bytes: groupTotalBytes > 0 ? groupTotalBytes : undefined,
      conflict_mode: conflictMode,
    }));
    const result = await queueFileOps(jobs);
    if (result.success) {
      toaster.toast({ title: fileOp === "copy" ? "Copying queued" : "Moving queued", body: toastLabel(clip.names) });
      if (fileOp === "move") onFileClipboard(null);
      forceRefresh();
    } else {
      toaster.toast({ title: "Queue failed", body: result.error ?? "Unknown error" });
    }
  }, [fileClipboard, currentPath, onFileClipboard]);

  const doSymlinkPaste = useCallback(async () => {
    const gc = getGlobalClip();
    if (gc?.kind !== "symlink" || !currentPath) return;
    const linkPath = `${currentPath}/${gc.name}`;
    const res = await createSymlink(gc.path, linkPath);
    if (res.success) { toaster.toast({ title: "Symlink created", body: gc.name }); updateGlobalClip(null); loadPath(currentPath); }
    else { toaster.toast({ title: "Symlink failed", body: res.error ?? "Unknown error" }); }
  }, [currentPath, loadPath]);

  const openPathEdit = () => {
    let path = currentPath;
    showModal(<ConfirmModal
      strTitle="Go to Path"
      strDescription="Enter a path to navigate to:"
      strOKButtonText="Go"
      strCancelButtonText="Cancel"
      onOK={() => { const t = path.trim(); if (t) onStateChange({ stack: [t] }); }}
    >
      <TextFieldWithContextMenu autoFocus
        defaultValue={currentPath}
        onChange={(e: any) => { path = e.target.value; }}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); } }}
        style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }} />
    </ConfirmModal>, window);
  };


  const openRename = useCallback((entry: FsEntry) => {
    if (entry.is_symlink) {
      // Symlink rename: two fields in a ConfirmModal
      const RenameSymlinkModal: VFC<{ closeModal?: () => void }> = ({ closeModal }) => {
        const [linkName, setLinkName] = useState(entry.name);
        const [linkTarget, setLinkTarget] = useState(entry.link_target ?? "");
        const doRename = async () => {
          if (!linkName.trim()) return;
          const result = await renameSymlink(entry.path, linkName.trim(), linkTarget.trim() || entry.link_target || "");
          if (result.success) loadPath(currentPath);
          else toaster.toast({ title: "Rename failed", body: result.error ?? "Unknown error" });
          closeModal?.();
        };
        return (
          <ConfirmModal
            strTitle="🔗 Rename Symlink"
            strOKButtonText="Rename"
            strCancelButtonText="Cancel"
            onOK={doRename}
            onCancel={closeModal}
          >
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Link name</div>
              <TextFieldWithContextMenu autoFocus value={linkName}
                onChange={(e: any) => setLinkName(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); doRename(); } }}
                style={{ width: "100%", fontSize: 13, marginBottom: 10 }} />
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Target path</div>
              <TextFieldWithContextMenu value={linkTarget}
                onChange={(e: any) => setLinkTarget(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); doRename(); } }}
                style={{ width: "100%", fontSize: 13, fontFamily: "monospace" }} />
            </div>
          </ConfirmModal>
        );
      };
      showModal(<RenameSymlinkModal />, window);
    } else {
      let name = entry.name;
      showModal(<ConfirmModal
        strTitle={`Rename "${entry.name}"`}
        strDescription="Enter a new name:"
        strOKButtonText="Rename"
        strCancelButtonText="Cancel"
        onOK={async () => {
          if (!name.trim()) return;
          const result = await renamePath(entry.path, name.trim());
          if (result.success) loadPath(currentPath);
          else toaster.toast({ title: "Rename failed", body: result.error ?? "Unknown error" });
        }}
      >
        <TextFieldWithContextMenu autoFocus
          defaultValue={entry.name}
          onChange={(e: any) => { name = e.target.value; }}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); } }}
          style={{ width: "100%", marginTop: 8, fontSize: 13 }} />
      </ConfirmModal>, window);
    }
  }, [currentPath, loadPath]);

  const openTextEditor = useCallback((entry: FsEntry) => {
    openTextEditorModal(entry, () => loadPath(currentPath));
  }, [currentPath, loadPath]);

  const doDelete = useCallback((targets: FsEntry[]) => {
    const label = toastLabel(targets.map((t) => t.name));
    showModal(<ConfirmModal
      strTitle={targets.length > 1 ? `Delete ${targets.length} items?` : `Delete "${targets[0].name}"?`}
      strDescription={targets.length > 1 ? `Permanently delete ${targets.length} items? This cannot be undone.` : `Permanently delete "${targets[0].name}"? This cannot be undone.`}
      strOKButtonText="Delete" strCancelButtonText="Cancel"
      onOK={async () => {
        let failed = 0;
        for (const t of targets) { const res = await deletePath(t.path); if (!res.success) { failed++; toaster.toast({ title: "Delete failed", body: res.error ?? t.name }); } }
        if (!failed) toaster.toast({ title: "Deleted", body: label });
        onStateChange({ mode: "navigate", selected: new Set() }); loadPath(currentPath);
      }} />, window);
  }, [currentPath, loadPath, onStateChange]);

  const openFileMenu = useCallback(() => {
    const targets = getTargets();
    const hasTargets = targets.length > 0;
    const hasFileClip = fileClipboard !== null && fileClipboard.paths.length > 0;
    const gc = getGlobalClip();
    const hasSymlinkClip = gc?.kind === "symlink";
    const singleTarget = targets.length === 1 ? targets[0] : null;

    const canAddNonSteam = !!(singleTarget && !singleTarget.is_dir);
    const archiveExts = [".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".tar", ".7z", ".rar"];
    const isArchive = (name: string) => archiveExts.some(ext => name.toLowerCase().endsWith(ext));
    const canExtract = !!(singleTarget && !singleTarget.is_dir && isArchive(singleTarget.name));

    // Total size: files have size_bytes; dirs need async fetch

    const doExtract = (entry: FsEntry, password?: string) => {
      const dst = entry.path.substring(0, entry.path.lastIndexOf("/"));
      const groupId = `extract_${Date.now()}`;
      queueExtract([{ src: entry.path, dst_dir: dst, password, label: entry.name, group_id: groupId }])
        .then(r => {
          if (r.success) { toaster.toast({ title: "Extraction queued", body: entry.name }); forceRefresh(); }
          else toaster.toast({ title: "Queue failed", body: r.error ?? "Unknown error" });
        });
    };

    const promptExtract = (entry: FsEntry) => {
      // Try without password first; if the archive needs one, prompt
      doExtract(entry);
    };

    const promptExtractWithPassword = (entry: FsEntry) => {
      let pw = "";
      showModal(<ConfirmModal
        strTitle="Archive Password"
        strDescription={`Enter password for "${entry.name}"`}
        strOKButtonText="Extract"
        strCancelButtonText="Cancel"
        onOK={() => doExtract(entry, pw)}
      >
        <TextFieldWithContextMenu autoFocus
          onChange={(e: any) => { pw = e.target.value; }}
          style={{ width: "100%", marginTop: 8, fontSize: 13 }} />
      </ConfirmModal>, window);
    };


    const openSizeMenu = () => {
      const paths = hasTargets ? targets.map(t => t.path) : [currentPath];
      const label = hasTargets
        ? targets.length === 1 ? targets[0].name : `${targets.length} items`
        : currentPath.split("/").pop() || currentPath;
      showModal(<SizeModal paths={paths} label={label} />, window);
    };

    showContextMenu(<Menu label="Actions" cancelText="Close">
      <MenuItem disabled={!hasTargets} onSelected={() => {
        const names = targets.map((t) => t.name);
        onFileClipboard({ op: "copy", paths: targets.map((t) => t.path), names, sourceDir: currentPath });
        onStateChange({ mode: "navigate", selected: new Set() });
        toaster.toast({ title: "Copied", body: toastLabel(names) });
      }}>{`Copy${hasTargets ? ` (${targets.length})` : ""}`}</MenuItem>
      <MenuItem disabled={!hasFileClip} onSelected={doPaste}>
        {hasFileClip ? `Paste "${toastLabel(fileClipboard!.names)}" here` : "Paste"}
      </MenuItem>
      <MenuItem disabled={!hasTargets} onSelected={() => { if (hasTargets) doDelete(targets); }}>
        {`Delete${hasTargets ? ` (${targets.length})` : ""}`}
      </MenuItem>
      <MenuItem disabled={!hasTargets} onSelected={() => {
        const names = targets.map((t) => t.name);
        onFileClipboard({ op: "cut", paths: targets.map((t) => t.path), names, sourceDir: currentPath });
        onStateChange({ mode: "navigate", selected: new Set() });
        toaster.toast({ title: "Cut", body: toastLabel(names) });
      }}>{`Cut${hasTargets ? ` (${targets.length})` : ""}`}</MenuItem>
      <MenuGroup label="Actions">
        <MenuItem onSelected={() => onStateChange({ mode: "select", selected: new Set() })}>Select</MenuItem>
        <MenuItem onSelected={() => onStateChange({ mode: "select", selected: new Set(entries.map((e) => e.path)) })}>Select All</MenuItem>
        <MenuItem disabled={!singleTarget} onSelected={async () => {
          if (!singleTarget) return;
          updateGlobalClip({ kind: "path", path: singleTarget.path, name: singleTarget.name });
          onStateChange({ mode: "navigate", selected: new Set() });
          const ok = await copyTextToClipboard(singleTarget.path);
          toaster.toast({ title: ok ? "Path copied" : "Path saved (clipboard unavailable)", body: singleTarget.path });
        }}>Copy Path</MenuItem>
        <MenuItem disabled={!singleTarget} onSelected={() => { if (singleTarget) openRename(singleTarget); }}>Rename</MenuItem>
        <MenuItem onSelected={() => {
          let name = "New Document.txt";
          showModal(<ConfirmModal
            strTitle="New Document"
            strDescription="Enter a name for the new text document:"
            strOKButtonText="Create"
            strCancelButtonText="Cancel"
            onOK={async () => {
              const finalName = name.endsWith(".txt") ? name : `${name}.txt`;
              const res = await createFile(`${currentPath}/${finalName}`);
              if (res.success) { toaster.toast({ title: "File created", body: res.name ?? finalName }); loadPath(currentPath); }
              else toaster.toast({ title: "Failed", body: res.error ?? "Unknown error" });
            }}
          >
            <TextFieldWithContextMenu autoFocus
              defaultValue="New Document.txt"
              onChange={(e: any) => { name = e.target.value.trim() || "New Document.txt"; }}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); } }}
              style={{ width: "100%", marginTop: 8, fontSize: 13 }} />
          </ConfirmModal>, window);
        }}>Create New Document</MenuItem>
        <MenuItem onSelected={() => {
          let name = "New Folder";
          showModal(<ConfirmModal
            strTitle="New Folder"
            strDescription="Enter a name for the new folder:"
            strOKButtonText="Create"
            strCancelButtonText="Cancel"
            onOK={async () => {
              const res = await createDir(`${currentPath}/${name}`);
              if (res.success) { toaster.toast({ title: "Folder created", body: res.name ?? name }); loadPath(currentPath); }
              else toaster.toast({ title: "Failed", body: res.error ?? "Unknown error" });
            }}
          >
            <TextFieldWithContextMenu autoFocus
              defaultValue="New Folder"
              onChange={(e: any) => { name = e.target.value.trim() || "New Folder"; }}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); } }}
              style={{ width: "100%", marginTop: 8, fontSize: 13 }} />
          </ConfirmModal>, window);
        }}>Create New Folder</MenuItem>
        <MenuItem disabled={!canAddNonSteam} onSelected={async () => {
          if (!singleTarget) return;
          try {
            const name = singleTarget.name.replace(/\.[^.]+$/, "");
            const dir = singleTarget.path.substring(0, singleTarget.path.lastIndexOf("/"));
            const appid = await (window as any).SteamClient.Apps.AddShortcut(name, singleTarget.path, dir, "");
            toaster.toast({ title: "Added to Steam", body: name });
            try { (window as any).SteamClient.Apps.SetShortcutName(appid, name); } catch {}
          } catch (e: any) {
            toaster.toast({ title: "Failed to add", body: String(e?.message ?? e) });
          }
        }}>Add to Steam</MenuItem>
      </MenuGroup>
      <MenuGroup label="Extra">
        <MenuItem disabled={!singleTarget?.is_dir} onSelected={() => {
          if (!singleTarget?.is_dir) return;
          const tabPath = singleTarget.path;
          const dirName = singleTarget.name;
          const matchingDrive = drives
            .filter(d => d.path && tabPath.startsWith(d.path))
            .sort((a, b) => b.path.length - a.path.length)[0]
            ?? drives.find(d => d.is_internal);
          const newTab: CustomTab = {
            id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: dirName,
            path: tabPath,
            driveDevice: matchingDrive?.device,
          };
          onAddTab(newTab);
          toaster.toast({ title: "Tab Added", body: dirName });
        }}>Add Tab (Directory)</MenuItem>
        <MenuItem onSelected={() => onStateChange({ showHidden: !showHidden })}>
          {showHidden ? "Hide Hidden Files" : "Show Hidden Files"}
        </MenuItem>
        <MenuItem onSelected={() => setShowItemCount(v => !v)}>
          {showItemCount ? "Hide Number of Items" : "Show Number of Items"}
        </MenuItem>
        <MenuItem onSelected={() => setShowAppIdNames(v => !v)}>
          {showAppIdNames ? "Hide AppId Names" : "Show AppId Names"}
        </MenuItem>

        <MenuItem onSelected={openSizeMenu}>Show Size</MenuItem>
        <MenuGroup label="Sort by">
          {(["alpha", "appid", "size", "modified", "created", "type"] as const).map((mode) => {
            const labels: Record<string, string> = {
              alpha: "Alphabetically",
              appid: "AppId (steamapps)",
              size: "Size",
              modified: "Date Modified",
              created: "Date Created",
              type: "Type",
            };
            return (
              <MenuItem key={mode} onSelected={() => setFileSortMode(mode)}>
                {fileSortMode === mode ? "✓ " : "   "}{labels[mode]}
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuGroup label="Symlinks">
          <MenuItem disabled={!(singleTarget?.is_symlink && singleTarget?.link_target)} onSelected={() => {
            if (!singleTarget?.link_target) return;
            const target = singleTarget.link_target;
            const absTarget = target.startsWith("/")
              ? target
              : `${singleTarget.path.substring(0, singleTarget.path.lastIndexOf("/"))}/${target}`;
            const targetDir = absTarget.substring(0, absTarget.lastIndexOf("/")) || absTarget;
            onNavigateToDrive(absTarget, targetDir);
          }}>Show Target Path</MenuItem>
          <MenuItem disabled={!singleTarget} onSelected={() => {
            if (!singleTarget) return;
            updateGlobalClip({ kind: "symlink", path: singleTarget.path, name: singleTarget.name });
            onStateChange({ mode: "navigate", selected: new Set() });
            toaster.toast({ title: "Symlink target set", body: "Navigate to destination and use Create Symlink Here" });
          }}>Copy Path (Symlink)</MenuItem>
          <MenuItem disabled={!hasSymlinkClip} onSelected={doSymlinkPaste}>
            {hasSymlinkClip ? `Create Symlink → "${gc!.name}" here` : "Create Symlink Here"}
          </MenuItem>
        </MenuGroup>
        <MenuGroup label="Compression">
          <MenuItem disabled={!hasTargets} onSelected={async () => {
            const label = toastLabel(targets.map(t => t.name));
            const baseName = targets.length === 1
              ? targets[0].name.replace(/\.[^.]+$/, "")
              : targets[0].name;
            const dst = `${currentPath}/${baseName}.tar.gz`;
            const r = await queueCompress([{
              srcs: targets.map(t => t.path),
              dst,
              fmt: "targz",
              label: `${label}.tar.gz`,
            }]);
            if (r.success) { toaster.toast({ title: "Compression queued", body: `${label} → ${baseName}.tar.gz` }); forceRefresh(); }
            else toaster.toast({ title: "Compress failed", body: r.error ?? "Unknown error" });
          }}>Compress .tar.gz</MenuItem>
          <MenuItem disabled={!hasTargets} onSelected={async () => {
            const label = toastLabel(targets.map(t => t.name));
            const baseName = targets.length === 1
              ? targets[0].name.replace(/\.[^.]+$/, "")
              : targets[0].name;
            const dst = `${currentPath}/${baseName}.zip`;
            const r = await queueCompress([{
              srcs: targets.map(t => t.path),
              dst,
              fmt: "zip",
              label: `${label}.zip`,
            }]);
            if (r.success) { toaster.toast({ title: "Compression queued", body: `${label} → ${baseName}.zip` }); forceRefresh(); }
            else toaster.toast({ title: "Compress failed", body: r.error ?? "Unknown error" });
          }}>Compress .zip</MenuItem>
          <MenuItem disabled={!canExtract} onSelected={() => {
            if (singleTarget) promptExtract(singleTarget);
          }}>Unzip / Extract</MenuItem>
          <MenuItem disabled={!canExtract} onSelected={() => {
            if (singleTarget) promptExtractWithPassword(singleTarget);
          }}>Extract with Password…</MenuItem>
        </MenuGroup>
      </MenuGroup>
      <MenuGroup label="Bookmarks">
        <MenuItem onSelected={async () => {
          const home = await getHomeDir().catch(() => "");
          if (home) onStateChange({ stack: [...stack, home], mode: "navigate", selected: new Set(), focusedPath: null });
        }}>🏠 Go Home</MenuItem>
        {bookmarks.map((bm, i) => (
          <MenuItem key={i} onSelected={() => {
            onStateChange({ stack: [...stack, bm], mode: "navigate", selected: new Set(), focusedPath: null });
          }}>{bm}</MenuItem>
        ))}
        {bookmarks.length > 0 && (
          <MenuItem onSelected={() => onBookmarksChange([])}>
            <span style={{ color: "#888" }}>Clear All Bookmarks</span>
          </MenuItem>
        )}
        <MenuItem onSelected={() => {
          if (!bookmarks.includes(currentPath)) {
            onBookmarksChange([...bookmarks, currentPath]);
            toaster.toast({ title: "Bookmarked", body: currentPath });
          } else {
            toaster.toast({ title: "Already bookmarked", body: currentPath });
          }
        }}>
          <span style={{ color: "#a9e34b" }}>+ Bookmark This Directory</span>
        </MenuItem>
      </MenuGroup>
    </Menu>, window);
  }, [getTargets, fileClipboard, entries, currentPath, showHidden, showItemCount, showAppIdNames, onStateChange, onFileClipboard, doPaste, openRename, doDelete, doSymlinkPaste, setShowItemCount, setShowAppIdNames, loadPath, bookmarks, onBookmarksChange]);

  const toggleSelect = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    onStateChange({ selected: next });
  };
  const handleActivate = (entry: FsEntry) => {
    if (mode === "select") { toggleSelect(entry.path); return; }
    if (onFileSelect && !entry.is_dir) { onFileSelect(entry.path); return; }
    if (entry.is_dir) { pushDir(entry.path); return; }
    if (isTextFile(entry.name))  { openTextEditor(entry); return; }
    if (isImageFile(entry.name)) { openFileViewer(entry, "image", entries); return; }
    if (isPdfFile(entry.name))   { openFileViewer(entry, "pdf", entries); return; }
    if (isAudioFile(entry.name)) { openFileViewer(entry, "audio", entries); return; }
  };

  const fileClipBanner = fileClipboard ? `${fileClipboard.op === "copy" ? "📋" : "✂️"} ${toastLabel(fileClipboard.names)} ready to paste` : null;
  const gc = globalClip;
  const globalBanner = gc ? (gc.kind === "symlink" ? `🔗 Symlink target: ${gc.name}` : `📌 Path copied: ${gc.name}`) : null;
  const hintText = onDirSelect
    ? `A=open  ·  B=${stack.length > 1 ? "go up" : "exit"}  ·  X=save this folder`
    : onFileSelect
    ? `A=select as target  ·  B=${stack.length > 1 ? "go up" : "exit"}  ·  X=cancel`
    : mode === "select" ? `${selected.size} selected  ·  A=toggle  ·  B=cancel  ·  Y=select  ·  ☰=menu  ·  X=exit`
    : `A=open  ·  B=${stack.length > 1 ? "go up" : "exit"}  ·  Y=select  ·  ☰=menu  ·  X=exit`;

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {onDirSelect && (
        <div style={{ padding: "4px 16px", background: "rgba(96,165,250,0.12)", borderBottom: "1px solid rgba(96,165,250,0.4)", fontSize: 11, color: "#60a5fa", flexShrink: 0, fontWeight: 600 }}>
          {dirSelectBanner || "📁 Browse to folder — press X to save this directory"}
        </div>
      )}
      {!onDirSelect && onFileSelect && (
        <div style={{ padding: "4px 16px", background: isLutrisFilepicker ? "rgba(249,168,37,0.12)" : "rgba(169,227,75,0.12)", borderBottom: `1px solid ${isLutrisFilepicker ? "rgba(249,168,37,0.4)" : "rgba(169,227,75,0.4)"}`, fontSize: 11, color: isLutrisFilepicker ? "#f9a825" : "#a9e34b", flexShrink: 0, fontWeight: 600 }}>
          {isLutrisFilepicker ? "📂 Select Lutris target file — press A on the exe / AppImage / script" : "📂 Select target file — press A on the exe / AppImage / script"}
        </div>
      )}
      

      <Focusable style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
        onButtonDown={(evt: any) => {
          onTabButton?.(evt);
          const btn = evt?.detail?.button;
          // LT (7) = jump back a sixth, RT (8) = jump forward a sixth
          if (btn !== 7 && btn !== 8) return;
          // Clear any existing hold repeat
          if (triggerTimeoutRef.current) { clearTimeout(triggerTimeoutRef.current); triggerTimeoutRef.current = null; }
          if (triggerIntervalRef.current) { clearInterval(triggerIntervalRef.current); triggerIntervalRef.current = null; }
          // Step function — reads live state from ref so repeat stays accurate
          const doStep = () => {
            const rows = listFocusRef.current?.querySelectorAll<HTMLElement>("[tabindex]");
            if (!rows || rows.length === 0) return;
            const totalRows = rows.length;
            if (totalRows < 2) return;
            const { focusedPath: livePath, entries: liveEntries } = triggerLiveRef.current;
            if (livePath) {
              const entryIdx = liveEntries.findIndex((e) => e.path === livePath);
              if (entryIdx >= 0) {
                const lastEntryIdx = liveEntries.length - 1;
                quarterIdxRef.current = entryIdx === lastEntryIdx
                  ? 6
                  : Math.round((entryIdx / lastEntryIdx) * 6);
              }
            }
            if (btn === 8) {
              quarterIdxRef.current = Math.min(quarterIdxRef.current + 1, 6);
            } else {
              quarterIdxRef.current = Math.max(quarterIdxRef.current - 1, 0);
            }
            setTriggerStep(quarterIdxRef.current);
            const targetIdx = Math.round((quarterIdxRef.current / 6) * (totalRows - 1));
            rows[targetIdx]?.focus();
            rows[targetIdx]?.scrollIntoView({ block: "nearest" });
          };
          // Fire immediately, then hold: 200ms before repeat, 150ms repeat rate
          doStep();
          triggerTimeoutRef.current = setTimeout(() => {
            triggerTimeoutRef.current = null;
            triggerIntervalRef.current = setInterval(doStep, 150);
          }, 200);
        }}
        onButtonUp={(evt: any) => {
          const btn = evt?.detail?.button;
          if (btn !== 7 && btn !== 8) return;
          if (triggerTimeoutRef.current) { clearTimeout(triggerTimeoutRef.current); triggerTimeoutRef.current = null; }
          if (triggerIntervalRef.current) { clearInterval(triggerIntervalRef.current); triggerIntervalRef.current = null; }
        }}
        onSecondaryButton={onDirSelect ? () => onDirSelect(currentPath) : onExit}
        onSecondaryActionDescription={onDirSelect ? "Save this folder" : "Exit browser"}
        onCancelButton={popDir}
        onCancelActionDescription={mode === "select" ? "Cancel select" : "Go back"}
        onOptionsButton={() => onStateChange({ mode: "select", selected: new Set() })}
        onOptionsActionDescription="Select"
        onMenuButton={openFileMenu}
        onMenuActionDescription="Menu">

        <Focusable onActivate={openPathEdit} onCancelButton={popDir}
          style={{ padding: "8px 16px", margin: "4px 8px", background: "rgba(255,255,255,0.05)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.07)", flexShrink: 0 }}
          noFocusRing={false}>
          <span style={{ fontSize: 13, color: "#aaa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{currentPath}</span>
        </Focusable>

        {fileClipBanner && (
          <div style={{ padding: "3px 16px", background: "rgba(245,158,11,0.12)", borderBottom: "1px solid rgba(245,158,11,0.3)", fontSize: 11, color: "#fbbf24", flexShrink: 0 }}>
            {fileClipBanner}
          </div>
        )}
        {globalBanner && (
          <div style={{ padding: "3px 16px", background: gc?.kind === "symlink" ? "rgba(99,102,241,0.12)" : "rgba(16,185,129,0.10)",
            borderBottom: `1px solid ${gc?.kind === "symlink" ? "rgba(99,102,241,0.35)" : "rgba(16,185,129,0.3)"}`,
            fontSize: 11, color: gc?.kind === "symlink" ? "#818cf8" : "#34d399", flexShrink: 0 }}>
            {globalBanner}
          </div>
        )}
        {mode === "select" && (
          <div style={{ padding: "4px 16px", background: "rgba(76,110,245,0.2)", borderBottom: "1px solid rgba(76,110,245,0.4)", fontSize: 12, color: "#a5b4fc", flexShrink: 0, fontWeight: 600 }}>
            SELECT MODE — {selected.size} selected
            {(() => {
              const selEntries = allEntries.filter(e => selected.has(e.path));
              const totalBytes = selEntries.reduce((s, e) => s + (e.size_bytes ?? 0), 0);
              return totalBytes > 0 ? ` · ${formatSize(totalBytes)}` : "";
            })()}
          </div>
        )}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>

        <Focusable ref={listFocusRef as any} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.25) transparent" }} noFocusRing onCancelButton={popDir}>
          {mode === "navigate" && (
            <Focusable 
              onActivate={goUpDir} 
              onCancelButton={popDir} 
              style={{
                ...rowStyle(false, false),
                opacity: currentPath === "/" ? 0.4 : 1,
                pointerEvents: currentPath === "/" ? "none" : "auto"
              }} 
              noFocusRing={false}
            >
              <span style={iconColStyle}>↑</span>
              <span style={{ fontSize: 13, color: "#74c0fc" }}>..</span>
            </Focusable>
          )}
          {loading && <div style={centerMsg}>Loading...</div>}
          {!loading && errorMsg && <div style={{ ...centerMsg, color: "#fa5252" }}>{errorMsg}</div>}
          {!loading && !errorMsg && entries.length === 0 && <div style={centerMsg}>Empty</div>}
          {!loading && !errorMsg && entries.map((entry) => {
            const isSelected = selected.has(entry.path);
            const isDotfile  = entry.name.startsWith(".");
            const isCut      = fileClipboard?.op === "cut" && fileClipboard.paths.includes(entry.path);
            const isSymSrc   = gc?.kind === "symlink" && gc.path === entry.path;
            const canEdit    = !entry.is_dir && isTextFile(entry.name);
            return (
              <Focusable key={entry.path} onActivate={() => handleActivate(entry)}
                onFocus={() => onStateChange({ focusedPath: entry.path })}
                onCancelButton={popDir}
                style={{ ...rowStyle(entry.is_dir, isSelected), opacity: isCut ? 0.4 : 1 }} noFocusRing={false}>
                {mode === "select" && (
                  <span style={{ fontSize: 14, width: 18, flexShrink: 0, color: isSelected ? "#a5b4fc" : "#444" }}>
                    {isSelected ? "☑" : "☐"}
                  </span>
                )}
                <span style={{ position: "relative", width: 22, flexShrink: 0, textAlign: "center", fontSize: 15 }}>
                  {entry.is_dir ? "📁" : fileIcon(entry.name)}
                  {entry.is_symlink && (
                    <span style={{ position: "absolute", bottom: 2, right: -4, fontSize: 9, lineHeight: 1, background: "#1e1e2e", borderRadius: 2, padding: "0 1px" }}>🔗</span>
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", fontSize: 13,
                  color: isDotfile ? "#555" : (entry.is_dir ? "#dde" : (canEdit ? "#c3dafe" : "#999")),
                  fontStyle: isDotfile ? "italic" : "normal" }}>
                  {(() => {
                    const appid = showAppIdNames ? extractSteamAppId(currentPath, entry.name, entry.is_dir) : null;
                    const resolvedName = appid ? appIdNames[appid] : null;
                    if (resolvedName) {
                      return (
                        <>
                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                            {resolvedName}
                            {entry.is_symlink && entry.link_target && (
                              <span style={{ fontSize: 10, color: "#444", marginLeft: 6 }}>→ {entry.link_target}</span>
                            )}
                            {isSymSrc && <span style={{ fontSize: 10, color: "#818cf8", marginLeft: 6 }}>symlink target</span>}
                          </span>
                          <span style={{ display: "block", fontSize: 10, color: "#555", lineHeight: 1.3 }}>
                            {entry.name}
                          </span>
                        </>
                      );
                    }
                    return (
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.name}
                        {entry.is_symlink && entry.link_target && (
                          <span style={{ fontSize: 10, color: "#444", marginLeft: 6 }}>→ {entry.link_target}</span>
                        )}
                        {isSymSrc && <span style={{ fontSize: 10, color: "#818cf8", marginLeft: 6 }}>symlink target</span>}
                      </span>
                    );
                  })()}
                  {showItemCount && entry.is_dir && entry.item_count != null && (
                    <span style={{ display: "block", fontSize: 10, color: "#555", lineHeight: 1.2 }}>
                      {entry.item_count} {entry.item_count === 1 ? "item" : "items"}
                    </span>
                  )}
                </span>
                {canEdit && mode === "navigate" && <span style={{ flexShrink: 0, fontSize: 9, color: "#3b4f7a", marginRight: 4 }}>✏️</span>}
                {!entry.is_dir && entry.size_bytes > 0 && <span style={{ flexShrink: 0, fontSize: 11, color: "#444" }}>{formatSize(entry.size_bytes)}</span>}
                {entry.is_dir && mode === "navigate" && <span style={{ flexShrink: 0, fontSize: 14, color: "#333" }}>›</span>}

              </Focusable>
            );
          })}
        </Focusable>
        </div>

        <div style={{ padding: "4px 16px", background: "rgba(0,0,0,0.3)", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: 11, color: "#555", flexShrink: 0, textAlign: "center" }}>
          {hintText}
        </div>
      </Focusable>
    </div>
  );
};

const centerMsg: React.CSSProperties = { padding: 20, textAlign: "center", color: "#555", fontSize: 13 };
const rowStyle = (isDir: boolean, isSelected: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.04)",
  background: isSelected ? "rgba(76,110,245,0.15)" : "transparent", flexShrink: 0,
});
const iconColStyle: React.CSSProperties = { fontSize: 14, width: 22, textAlign: "center", flexShrink: 0, color: "#74c0fc" };

// ── FileBrowserPage ───────────────────────────────────────────────────────────
export const FileBrowserPage: VFC = () => {
  const sessionInit = isBrowseRememberOn() ? getBrowserSession() : null;
  const [drives, setDrives]               = useState<Drive[]>([]);
  const [activeTab, setActiveTab]         = useState<string>(() => sessionInit?.activeTab ?? "");
  const [loading, setLoading]             = useState(true);
  const [driveStates, setDriveStates]     = useState<Record<string, DriveState>>(
    () => sessionInit?.driveStates ?? {}
  );
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null);
  const [tabsConfig, setTabsConfig]       = useState<TabsConfiguration>(TABS_CONFIG_DEFAULT);
  const [tabsConfigLoaded, setTabsConfigLoaded] = useState(false);
  
  // Convenience accessors
  const customTabs = tabsConfig.customTabs;
  const driveSettings = tabsConfig.driveSettings;

  const loadDrives = useCallback(async () => {
    try {
      const d = await getAllDrives();
      const sorted = [...d].sort((a, b) => {
        if (a.is_internal && !b.is_internal) return -1;
        if (!a.is_internal && b.is_internal) return 1;
        return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
      });
      setDrives(sorted);
      setDriveStates((prev) => {
        const next: Record<string, DriveState> = {};
        // Initialize states for drives
        for (const drive of sorted) { 
          const id = tabId(drive); 
          next[id] = prev[id] ?? makeDriveState(rootPathFor(drive)); 
        }
        // Initialize states for custom tabs
        for (const tab of customTabs) {
          next[tab.id] = prev[tab.id] ?? makeDriveState(tab.path);
        }
        // Tabs config loads async — until it's ready, keep any session-restored
        // custom-tab states so the first loadDrives pass doesn't wipe them.
        if (!tabsConfigLoaded) {
          for (const [id, state] of Object.entries(prev)) {
            if (!(id in next)) next[id] = state;
          }
        }
        return next;
      });
      setActiveTab((prev) => { 
        // Get all valid tab IDs (drives + custom tabs)
        const driveIds = sorted.map(tabId);
        const customTabIds = customTabs.map(t => t.id);
        const allValidIds = [...driveIds, ...customTabIds];
        
        // If there's already an active tab and it's valid, keep it
        if (allValidIds.includes(prev)) return prev;

        // Config not loaded yet — keep session-restored custom tab id
        if (!tabsConfigLoaded && prev) return prev;
        
        // Use default tab if set and available (use current tabsConfig state)
        if (tabsConfig.defaultDrive && allValidIds.includes(tabsConfig.defaultDrive)) {
          return tabsConfig.defaultDrive;
        }
        
        // Fall back to first drive
        return driveIds[0] ?? "";
      });
    } finally { setLoading(false); }
  }, [customTabs, tabsConfigLoaded, tabsConfig.defaultDrive]);

  useEffect(() => {
    loadDrives();
    const unsub = addEventListener("drives_changed", loadDrives);
    return () => removeEventListener("drives_changed", loadDrives);
  }, [loadDrives]);

  const handleExit = useCallback(() => Navigation.NavigateBack(), []);
  const makeStateUpdater = useCallback((id: string) => (patch: Partial<DriveState>) =>
    setDriveStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? makeDriveState("")), ...patch } })), []);

  // ── Tabs config async load ────────────────────────────────────────────────
  useEffect(() => {
    loadTabsConfigAsync().then((config) => {
      setTabsConfig(config);
      setTabsConfigLoaded(true);
      // Immediately seed driveStates for custom tabs so their stack/path
      // is ready before loadDrives re-runs (fixes blank path bar on re-entry)
      if (config.customTabs.length > 0) {
        setDriveStates((prev) => {
          const next = { ...prev };
          for (const tab of config.customTabs) {
            if (!next[tab.id]) next[tab.id] = makeDriveState(tab.path);
          }
          return next;
        });
      }
      // Apply default tab only when nothing is selected yet (don't clobber session restore)
      if (config.defaultDrive) {
        setActiveTab((prev) => prev || config.defaultDrive || prev);
      }
    });
  }, []);

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  useEffect(() => {
    getSetting("browser_bookmarks", "[]").then((raw) => {
      try { setBookmarks(JSON.parse(raw)); } catch { setBookmarks([]); }
    }).catch(() => {});
  }, []);
  const handleBookmarksChange = useCallback((next: string[]) => {
    setBookmarks(next);
    setSetting("browser_bookmarks", JSON.stringify(next)).catch(() => {});
  }, []);

  // ── Filepicker mode (Set Target) ──────────────────────────────────────────
  const [filepicker, setFilepicker] = useState<{ appid: number; initialPath?: string; isLutris?: boolean; lutrisId?: number; lutrisPgaDb?: string; lutrisYmlPath?: string } | null>(null);
  // ── Dirpicker mode (Add Scan Location, or return path to another plugin) ──
  type DirPickerRequest = {
    mode: "scan_location" | "return";
    initialPath?: string;
    banner?: string;
    onSelect?: (path: string) => void | Promise<void>;
  };
  const [dirpicker, setDirpicker] = useState<DirPickerRequest | false>(false);

  // Keep browse tab + paths across leave/re-enter within this Steam session.
  // Skip while in Set Target / Add Location pickers so they don't overwrite
  // the user's last normal Browse location. Honours the Remember Browse Location toggle.
  useEffect(() => {
    if (filepicker || dirpicker) return;
    if (!isBrowseRememberOn()) return;
    if (!activeTab && Object.keys(driveStates).length === 0) return;
    setBrowserSession({ activeTab, driveStates });
  }, [activeTab, driveStates, filepicker, dirpicker]);

  // Sync remember-location setting (also set from QAM toggles via window cache)
  useEffect(() => {
    getSetting("browse_remember_location", "true").then((v) => {
      const on = v !== "false";
      (window as any).__copydeck_browse_remember_location = on;
      if (!on) setBrowserSession(null);
    }).catch(() => {});
  }, []);

  // Read global filepicker/dirpicker flags on mount only
  useEffect(() => {
    const fp = (window as any).__copydeck_filepicker;
    if (fp) {
      (window as any).__copydeck_filepicker = null;
      setFilepicker(fp);
      if (fp.initialPath) {
        setDriveStates((prev) => {
          const next = { ...prev };
          for (const id of Object.keys(next)) {
            next[id] = { ...next[id], stack: [fp.initialPath], focusedPath: null };
          }
          return next;
        });
      }
    }
    const dp = (window as any).__copydeck_dirpicker;
    if (dp) {
      (window as any).__copydeck_dirpicker = null;
      if (dp === true) {
        setDirpicker({ mode: "scan_location" });
      } else if (typeof dp === "object") {
        setDirpicker({
          mode: dp.mode === "return" ? "return" : "scan_location",
          initialPath: dp.initialPath,
          banner: dp.banner,
          onSelect: typeof dp.onSelect === "function" ? dp.onSelect : undefined,
        });
      }
    }
  }, []);

  // Once drives are loaded, jump to initialPath for filepicker or dirpicker
  useEffect(() => {
    const initialPath = filepicker?.initialPath || (dirpicker && dirpicker.initialPath) || "";
    if (!initialPath || drives.length === 0) return;
    const matchingDrive = drives
      .filter(d => d.path && initialPath.startsWith(d.path))
      .sort((a: Drive, b: Drive) => b.path.length - a.path.length)[0];
    const matchingCustom = !matchingDrive
      ? tabsConfig.customTabs.find(t => initialPath.startsWith(t.path))
      : null;
    // Internal home paths (e.g. /home/deck/.local/share/Steam/...) map to internal drive
    const internal = !matchingDrive && !matchingCustom
      ? drives.find(d => d.is_internal)
      : null;
    const targetId = matchingDrive ? tabId(matchingDrive) : (matchingCustom?.id ?? (internal ? tabId(internal) : undefined));
    if (!targetId) return;
    setActiveTab(targetId);
    setDriveStates(prev => ({
      ...prev,
      [targetId]: { ...(prev[targetId] ?? makeDriveState(initialPath)), stack: [initialPath], focusedPath: null },
    }));
  }, [filepicker, dirpicker, drives, tabsConfig.customTabs]);

  const handleFileSelect = useCallback(async (filePath: string) => {
    if (!filepicker) return;
    const { appid, isLutris, lutrisId, lutrisPgaDb, lutrisYmlPath } = filepicker;

    if (isLutris) {
      // Lutris game — write new exe to YML only (no Steam shortcut changes).
      // Snapshot current YML state first so we can save the OLD location to history.
      const installDir = filePath.substring(0, filePath.lastIndexOf("/")) || filePath;
      try {
        // Read current state before overwriting — this becomes the history entry
        let oldExe = "";
        let oldInstallDir = "";
        let oldPrefix = "";
        let oldArgs = "";
        let oldWorkingDir = "";
        try {
          const oldInfo = await getLutrisGameInfo(String(lutrisId ?? 0));
          oldExe = oldInfo.exe ?? "";
          oldInstallDir = oldInfo.install_dir ?? "";
          oldPrefix = oldInfo.prefix_path ?? "";
          oldArgs = oldInfo.args ?? "";
          oldWorkingDir = oldInfo.working_dir ?? "";
        } catch { /* best-effort */ }

        const result = await updateLutrisPaths(
          lutrisPgaDb ?? "",
          lutrisId ?? 0,
          lutrisYmlPath ?? "",
          installDir,
          "", // prefix path unchanged when setting target manually
          filePath, // explicit exe path
          "", // args unchanged
          oldWorkingDir ? installDir : "", // update working_dir to new install dir if it was set
        );
        if (result.success) {
          toaster.toast({ title: "Lutris target updated", body: filePath });
          // Save OLD location to history (so it can be restored), not the new one
          if (oldExe && oldExe !== filePath) {
            await addTargetHistory(appid, {
              exe: oldExe,
              startDir: "",
              launchOptions: "",
              isLutris: true,
              lutrisId: lutrisId ?? 0,
              lutrisPgaDb: lutrisPgaDb ?? "",
              lutrisYmlPath: lutrisYmlPath ?? "",
              lutrisInstallDir: oldInstallDir || (oldExe.substring(0, oldExe.lastIndexOf("/")) || oldExe),
              lutrisPrefixPath: oldPrefix,
              lutrisArgs: oldArgs,
              lutrisWorkingDir: oldWorkingDir,
            });
          }
        } else {
          toaster.toast({ title: "Lutris target failed", body: (result.errors ?? []).join(", ") || "Unknown error" });
        }
      } catch (e) {
        toaster.toast({ title: "Lutris target failed", body: String(e) });
      }
      setFilepicker(null);
      Navigation.NavigateBack();
      return;
    }

    // Non-Steam shortcut
    const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    const quotedExe = `"${filePath}"`;
    const quotedDir = `"${dir}"`;
    try {
      // Snapshot current state from VDF before overwriting
      const oldSnapshot = await getShortcutSnapshot(appid).catch(() => ({ exe: "", startDir: "", launchOptions: "" }));
      (window as any).SteamClient?.Apps?.SetShortcutExe?.(appid, quotedExe);
      (window as any).SteamClient?.Apps?.SetShortcutStartDir?.(appid, quotedDir);
      // Update shortcut_dirs so the menu reflects the new location immediately
      const dirs = (window as any).__copydeck_shortcut_dirs ?? {};
      dirs[String(appid)] = dir;
      (window as any).__copydeck_shortcut_dirs = dirs;
      toaster.toast({ title: "Target updated", body: filePath });
      if (oldSnapshot.exe && oldSnapshot.exe !== filePath) await addTargetHistory(appid, oldSnapshot);
    } catch (e) {
      toaster.toast({ title: "Failed to set target", body: String(e) });
    }
    setFilepicker(null);
    Navigation.NavigateBack();
  }, [filepicker]);

  const handleDirSelect = useCallback(async (dirPath: string) => {
    if (!dirpicker) return;
    if (dirpicker.mode === "return") {
      try {
        await dirpicker.onSelect?.(dirPath);
      } catch (e) {
        toaster.toast({ title: "Failed to save folder", body: String(e) });
      }
      setDirpicker(false);
      Navigation.NavigateBack();
      return;
    }
    try {
      const locs: string[] = JSON.parse(await getSetting("nonsteam_locations", "[]"));
      if (!locs.includes(dirPath)) {
        locs.push(dirPath);
        await setSetting("nonsteam_locations", JSON.stringify(locs));
        (window as any).__copydeck_nonsteam_locations = locs;
      }
      toaster.toast({ title: "Scan location added", body: dirPath });
    } catch (e) {
      toaster.toast({ title: "Failed to save location", body: String(e) });
    }
    setDirpicker(false);
    Navigation.NavigateBack();
  }, [dirpicker]);

  // Navigate to a specific path, switching drive tab if needed.
  // Push onto the existing history stack (don't reset) so B/back returns
  // to the previous folder — e.g. after "Browse (CopyDeck)" on a game.
  const handleNavigateToDrive = useCallback((absTarget: string, targetDir: string) => {
    const matchingDrive = drives
      .filter(d => d.path && absTarget.startsWith(d.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
      ?? drives.find(d => d.is_internal);
    if (!matchingDrive) { toaster.toast({ title: "Drive not found", body: targetDir }); return; }
    const id = tabId(matchingDrive);
    setDriveStates(prev => {
      const existing = prev[id] ?? makeDriveState(rootPathFor(matchingDrive));
      const stack = existing.stack.length > 0 ? existing.stack : [rootPathFor(matchingDrive)];
      const top = stack[stack.length - 1];
      const nextStack = top === targetDir ? stack : [...stack, targetDir];
      return {
        ...prev,
        [id]: {
          ...existing,
          stack: nextStack,
          focusedPath: null,
          mode: "navigate",
          selected: new Set(),
        },
      };
    });
    setActiveTab(id);
  }, [drives]);

  // Navigate to path set by context menu "Browse (CopyDeck)"
  useEffect(() => {
    if (!drives.length || loading) return;
    const targetPath = (window as any).__copydeck_browse_path;
    if (!targetPath) return;
    (window as any).__copydeck_browse_path = null;
    handleNavigateToDrive(targetPath, targetPath);
  }, [drives, loading, handleNavigateToDrive]);

  // Unified tab management handlers - work for both drive tabs and custom tabs
  const handleAddTab = useCallback((tab: CustomTab) => {
    const newConfig: TabsConfiguration = {
      ...tabsConfig,
      customTabs: [...tabsConfig.customTabs, tab]
    };
    setTabsConfig(newConfig);
    saveTabsConfig(newConfig);
    
    // Initialize DriveState for this custom tab
    setDriveStates(prev => ({
      ...prev,
      [tab.id]: makeDriveState(tab.path)
    }));
    
    setActiveTab(tab.id);
  }, [tabsConfig]);

  const handleRemoveTab = useCallback((tabIdToRemove: string) => {
    const newConfig: TabsConfiguration = {
      ...tabsConfig,
      customTabs: tabsConfig.customTabs.filter(t => t.id !== tabIdToRemove),
      tabOrder: tabsConfig.tabOrder.filter(id => id !== tabIdToRemove)
    };
    setTabsConfig(newConfig);
    saveTabsConfig(newConfig);
    
    // If we're on the tab being removed, switch to first tab
    if (activeTab === tabIdToRemove) {
      setActiveTab(drives[0] ? tabId(drives[0]) : "");
    }
  }, [tabsConfig, activeTab, drives]);

  // Rename handler - works for both custom tabs and drives
  const handleRenameTab = useCallback((tabIdToRename: string, newName: string) => {
    // Check if it's a custom tab
    const customTab = tabsConfig.customTabs.find(t => t.id === tabIdToRename);
    
    if (customTab) {
      // Rename custom tab
      const newConfig: TabsConfiguration = {
        ...tabsConfig,
        customTabs: tabsConfig.customTabs.map(t => 
          t.id === tabIdToRename ? { ...t, name: newName } : t
        )
      };
      setTabsConfig(newConfig);
      saveTabsConfig(newConfig);
    } else {
      // Rename drive tab
      const newConfig: TabsConfiguration = {
        ...tabsConfig,
        driveSettings: {
          ...tabsConfig.driveSettings,
          [tabIdToRename]: {
            ...(tabsConfig.driveSettings[tabIdToRename] || { id: tabIdToRename, position: 0 }),
            customName: newName
          }
        }
      };
      setTabsConfig(newConfig);
      saveTabsConfig(newConfig);
    }
  }, [tabsConfig]);

  // Reorder all tabs (drives + custom)
  const handleReorderTabs = useCallback((newOrder: string[]) => {
    const newConfig: TabsConfiguration = {
      ...tabsConfig,
      tabOrder: newOrder,
      // If a default tab is set, mark that the user has now manually reordered
      defaultTabReordered: tabsConfig.defaultDrive ? true : tabsConfig.defaultTabReordered,
    };
    setTabsConfig(newConfig);
    saveTabsConfig(newConfig);
  }, [tabsConfig]);

  // Set a tab as the default startup tab
  const handleSetDefaultDrive = useCallback((driveId: string) => {
    const newConfig: TabsConfiguration = {
      ...tabsConfig,
      defaultDrive: driveId,
      defaultTabReordered: false, // reset so default tab floats to first position
    };
    setTabsConfig(newConfig);
    saveTabsConfig(newConfig);
    toaster.toast({ title: "Default Tab Set", body: `This tab will open on startup` });
  }, [tabsConfig]);

  // Unset the default tab
  const handleUnsetDefaultDrive = useCallback(() => {
    const newConfig: TabsConfiguration = {
      ...tabsConfig,
      defaultDrive: undefined,
      defaultTabReordered: false,
    };
    setTabsConfig(newConfig);
    saveTabsConfig(newConfig);
    toaster.toast({ title: "Default Tab Cleared", body: "Will open internal drive on startup" });
  }, [tabsConfig]);

  // Prompt to rename ANY tab (drive or custom)
  const promptRenameTab = useCallback((tabIdToRename: string, currentName: string) => {
    const RenameModal: VFC<{ closeModal?: () => void }> = ({ closeModal }) => {
      const [newName, setNewName] = useState(currentName);

      return (
        <ConfirmModal
          strTitle="Rename Tab"
          strDescription={`Rename "${currentName}"`}
          strOKButtonText="Rename"
          strCancelButtonText="Cancel"
          onOK={() => {
            if (newName.trim()) {
              handleRenameTab(tabIdToRename, newName.trim());
              toaster.toast({ title: "Tab Renamed", body: newName.trim() });
            }
            closeModal?.();
          }}
          onCancel={closeModal}
        >
          <TextFieldWithContextMenu 
            value={newName} 
            onChange={(e: any) => setNewName(e.target.value)}
            style={{ width: "100%", marginTop: 8, fontSize: 13 }} 
          />
        </ConfirmModal>
      );
    };
    
    showModal(<RenameModal />, window);
  }, [handleRenameTab]);

  const promptRemoveTab = useCallback((tab: CustomTab) => {
    const RemoveTabModal: VFC<{ closeModal?: () => void }> = ({ closeModal }) => {
      let executed = false;
      return (
        <ConfirmModal
          strTitle="Remove Tab"
          strDescription={`Remove "${tab.name}" from tabs? This won't delete the folder.`}
          strOKButtonText="Remove"
          strCancelButtonText="Cancel"
          onOK={() => {
            if (executed) return; // Prevent double execution
            executed = true;
            closeModal?.();
            // Remove tab after modal closes to prevent re-render interference
            setTimeout(() => {
              handleRemoveTab(tab.id);
              toaster.toast({ title: "Tab Removed", body: tab.name });
            }, 50);
          }}
          onCancel={closeModal}
        />
      );
    };
    
    showModal(<RemoveTabModal />, window);
  }, [handleRemoveTab]);

  const promptReorderTabs = useCallback(() => {
    const ReorderModal: VFC<{ closeModal?: () => void }> = ({ closeModal }) => {
      // Build entries for ALL tabs (drives + custom), respecting current order if it exists
      const allTabEntries: Array<{ id: string; label: string; isDrive: boolean }> = [];
      
      // Add drive tabs
      drives.forEach(drive => {
        const id = tabId(drive);
        const setting = tabsConfig.driveSettings[id];
        const label = setting?.customName || drive.label;
        allTabEntries.push({ id, label, isDrive: true });
      });
      
      // Add custom tabs
      tabsConfig.customTabs.forEach(tab => {
        allTabEntries.push({ id: tab.id, label: tab.name, isDrive: false });
      });
      
      // Sort by current tabOrder if it exists, otherwise keep natural order
      // Then float the default tab to first position (matching the tab bar display order)
      const baseOrder = tabsConfig.tabOrder.length > 0
        ? tabsConfig.tabOrder
            .map(id => allTabEntries.find(e => e.id === id))
            .filter((e): e is typeof allTabEntries[0] => e !== undefined)
            .concat(allTabEntries.filter(e => !tabsConfig.tabOrder.includes(e.id)))
        : allTabEntries;
      const sorted = tabsConfig.defaultDrive && !tabsConfig.defaultTabReordered
        ? [
            ...baseOrder.filter(e => e.id === tabsConfig.defaultDrive),
            ...baseOrder.filter(e => e.id !== tabsConfig.defaultDrive),
          ]
        : baseOrder;
      
      const entries: ReorderableEntry<{ id: string }>[] = sorted.map((entry, index) => ({
        label: entry.label,
        position: index,
        data: { id: entry.id },
      }));

      const mountedDevices = new Set(drives.map(d => d.device).filter(Boolean));
      const unusedTabs = tabsConfig.customTabs.filter(t => t.driveDevice && !mountedDevices.has(t.driveDevice));
      const hasUnused = unusedTabs.length > 0;

      return (
        <ModalRoot closeModal={closeModal} onCancel={closeModal}>
          <DialogBody>
            <DialogControlsSection>
              <div style={{
                fontSize: 15,
                fontWeight: 700,
                color: "#c6d4df",
                marginBottom: 12,
                letterSpacing: "0.02em",
              }}>
                Reorder Tabs
              </div>
              <div style={{
                background: "rgba(0,0,0,0.35)",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.07)",
                overflow: "hidden",
                marginBottom: 14,
                padding: "4px 8px",
              }}>
                <ReorderableList<{ id: string }>
                  entries={entries}
                  onSave={(reorderedEntries: ReorderableEntry<{ id: string }>[]) => {
                    handleReorderTabs(reorderedEntries.map(e => e.data!.id));
                    toaster.toast({ title: "Tabs Reordered", body: "Order saved" });
                  }}
                />
              </div>
              <DialogButton
                onClick={() => {
                  if (!hasUnused) return;
                  const unusedIds = new Set(unusedTabs.map(t => t.id));
                  const newConfig = {
                    ...tabsConfig,
                    customTabs: tabsConfig.customTabs.filter(t => !unusedIds.has(t.id)),
                    tabOrder: tabsConfig.tabOrder.filter(id => !unusedIds.has(id)),
                    defaultDrive: unusedIds.has(tabsConfig.defaultDrive ?? "") ? undefined : tabsConfig.defaultDrive,
                  };
                  setTabsConfig(newConfig);
                  saveTabsConfig(newConfig);
                  toaster.toast({ title: "Cleared", body: `Removed ${unusedTabs.length} unused tab${unusedTabs.length > 1 ? "s" : ""}` });
                  closeModal?.();
                }}
                style={{ marginBottom: 8, opacity: hasUnused ? 1 : 0.35 }}
              >
                Clear Unused Tabs
              </DialogButton>
              <DialogButton onClick={closeModal}>
                Close
              </DialogButton>
            </DialogControlsSection>
          </DialogBody>
        </ModalRoot>
      );
    };
    
    showModal(<ReorderModal />, window);
  }, [drives, tabsConfig, handleReorderTabs, setTabsConfig]);


  const tabsWrapperRef = useRef<HTMLDivElement>(null);
  // Keep a ref to the latest tabs array so handleTabButton can read it
  // without being in its dependency list (breaks the circular dep).
  const tabsRef = useRef<Array<{ id: string }>>([]);
  // Decky/Steam Tabs: activeTab paints the right content, but gamepad focus
  // still starts on pill 0. Anchor focus onto the Selected pill once on open.
  const didAnchorTabFocus = useRef(false);

  const focusSelectedTabPill = useCallback((): boolean => {
    const root = tabsWrapperRef.current;
    if (!root) return false;
    const c = gamepadTabbedPageClasses;
    const tabEl = c?.TabRow && c?.Selected
      ? (root.querySelector(`.${c.TabRow} .${c.Selected}`) as HTMLElement | null)
      : null;
    if (!tabEl) return false;
    try { tabEl.focus(); } catch { /* ignore */ }
    // Plain focus() often isn't enough for gamepad nav — ask FocusNavController.
    try {
      const fnc: any = (window as any).FocusNavController;
      const trees: any[] =
        fnc?.m_ActiveContext?.m_rgGamepadNavigationTrees
        ?? fnc?.m_rgGamepadNavigationTrees
        ?? [];
      for (const t of trees) {
        const rootNode = t?.Root ?? t?.m_Root;
        if (!rootNode) continue;
        const stack: any[] = [rootNode];
        while (stack.length) {
          const n = stack.pop();
          if (!n) continue;
          const nEl = n.m_element ?? n.Element;
          if (nEl === tabEl) {
            try { (n.BTakeFocus ?? n.TakeFocus)?.call(n, 3); } catch { /* ignore */ }
            return true;
          }
          const kids = n.m_rgChildren ?? n.Children;
          if (Array.isArray(kids)) for (const k of kids) stack.push(k);
        }
      }
    } catch { /* ignore */ }
    return true;
  }, []);

  // After restore, point gamepad focus at the active tab pill so L/R continues
  // from there instead of jumping back to the first tab.
  useEffect(() => {
    if (loading || !activeTab || !tabsConfigLoaded || drives.length === 0) return;
    if (didAnchorTabFocus.current) return;
    if (!tabsRef.current.some((t) => t.id === activeTab)) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      tries++;
      if (focusSelectedTabPill()) {
        didAnchorTabFocus.current = true;
        return;
      }
      if (tries < 30) window.setTimeout(tick, 40);
    };
    window.setTimeout(tick, 50);
    return () => { cancelled = true; };
  }, [loading, activeTab, tabsConfigLoaded, drives.length, focusSelectedTabPill]);

  // LB/RB from content: round-trip focus to the tab strip so Steam's swoop
  // animation originates there (no swoop), then restore focus to content.
  const handleTabButton = useCallback((evt: any) => {
    const btn = evt?.detail?.button;
    if (btn !== 5 && btn !== 6) return;

    focusSelectedTabPill();

    // Switch tab using the ref (always current, no dep cycle)
    setActiveTab((cur) => {
      const tabList = tabsRef.current;
      const idx = tabList.findIndex(t => t.id === cur);
      if (idx < 0) return cur;
      const next = tabList[((idx + (btn === 6 ? 1 : -1)) % tabList.length + tabList.length) % tabList.length];
      return next ? next.id : cur;
    });

    // Round-trip done. Focus stays on the tab strip naturally — no setTimeout needed.
  }, [focusSelectedTabPill]);

  const tabs = useMemo(() => {
    // Build all tabs (drives + custom) with full metadata
    const allTabs: Array<{
      id: string;
      title: JSX.Element | string;
      content: JSX.Element;
      footer?: any;
      displayName: string; // For sorting/display
      isDrive: boolean;
    }> = [];
    
    // ── Drive Tabs ──
    drives.forEach((drive) => {
      const id = tabId(drive);
      const ds = driveStates[id] ?? makeDriveState(rootPathFor(drive));
      const setting = tabsConfig.driveSettings[id];
      const displayName = setting?.customName || drive.label;
      
      allTabs.push({
        id,
        displayName,
        isDrive: true,
        title: (
          <span>
            {tabsConfig.defaultDrive === id && <span style={{ color: '#4ade80', marginRight: 4 }}>●</span>}
            {displayName}{!drive.is_internal && drive.free_gb > 0 && (
            <span style={{ fontSize: 9, color: "#555", marginLeft: 4 }}>{formatGb(drive.free_gb)} free</span>
          )}</span>
        ),
        content: (
          <DriveBrowser key={id} drive={drive} state={ds} onStateChange={makeStateUpdater(id)}
            fileClipboard={filepicker ? null : fileClipboard} onFileClipboard={setFileClipboard}
            onExit={handleExit} onDriveChanged={loadDrives}
            onNavigateToDrive={handleNavigateToDrive}
            drives={drives}
            customTabs={customTabs}
            onAddTab={handleAddTab}
            onRemoveTab={handleRemoveTab}
            onRenameTab={handleRenameTab}
            onFileSelect={filepicker ? handleFileSelect : undefined}
            onDirSelect={dirpicker ? handleDirSelect : undefined}
            dirSelectBanner={dirpicker ? dirpicker.banner : undefined}
            isLutrisFilepicker={filepicker?.isLutris ?? false}
            bookmarks={bookmarks}
            onBookmarksChange={handleBookmarksChange}
            onTabButton={handleTabButton}
 />
        ),
        footer: {
          onMenuButton: () => {
            showContextMenu(<Menu label={displayName} cancelText="Close">
              <MenuItem onSelected={() => promptRenameTab(id, displayName)}>
                Rename Tab
              </MenuItem>
              <MenuItem onSelected={() => promptReorderTabs()}>
                Reorder Tabs
              </MenuItem>
              {tabsConfig.defaultDrive === id
                ? <MenuItem onSelected={() => handleUnsetDefaultDrive()}>Unset Default Tab</MenuItem>
                : <MenuItem onSelected={() => handleSetDefaultDrive(id)}>Set as Default Tab</MenuItem>
              }
              {!drive.is_internal && drive.path && (
                <MenuItem onSelected={async () => {
                  const res = await ejectDrive(drive.path);
                  if (res.success) { toaster.toast({ title: "Ejected", body: drive.label }); loadDrives(); }
                  else { toaster.toast({ title: "Eject failed", body: res.error ?? "Unknown error" }); }
                }}>Eject</MenuItem>
              )}
            </Menu>, window);
          },
          onMenuActionDescription: "Tab options",
        },
      });
    });
    
    // ── Custom Tabs ──
    const mountedDevices = new Set(drives.map(d => d.device).filter(Boolean));
    const visibleCustomTabs = customTabs.filter(tab => 
      !tab.driveDevice || mountedDevices.has(tab.driveDevice)
    );
    
    visibleCustomTabs.forEach((customTab) => {
      const id = customTab.id;
      const ds = driveStates[id] ?? makeDriveState(customTab.path);
      
      // Find which drive this tab belongs to (for content rendering, fall back to internal)
      const ejectableDrive = drives
        .filter(d => d.path && !d.is_internal && customTab.path.startsWith(d.path))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
      const matchingDrive = ejectableDrive
        ?? drives.filter(d => d.path && customTab.path.startsWith(d.path)).sort((a, b) => b.path.length - a.path.length)[0]
        ?? drives.find(d => d.is_internal);
      
      allTabs.push({
        id,
        displayName: customTab.name,
        isDrive: false,
        title: (
          <span>
            {tabsConfig.defaultDrive === id && <span style={{ color: '#4ade80', marginRight: 4 }}>●</span>}
            {customTab.name}
          </span>
        ),
        content: matchingDrive ? (
          <DriveBrowser 
            key={id} 
            drive={matchingDrive} 
            state={ds}
            onStateChange={makeStateUpdater(id)}
            fileClipboard={filepicker ? null : fileClipboard}
            onFileClipboard={setFileClipboard}
            onExit={handleExit}
            onDriveChanged={loadDrives}
            onNavigateToDrive={handleNavigateToDrive}
            drives={drives}
            customTabs={customTabs}
            onAddTab={handleAddTab}
            onRemoveTab={handleRemoveTab}
            onRenameTab={handleRenameTab}
            onFileSelect={filepicker ? handleFileSelect : undefined}
            onDirSelect={dirpicker ? handleDirSelect : undefined}
            dirSelectBanner={dirpicker ? dirpicker.banner : undefined}
            isLutrisFilepicker={filepicker?.isLutris ?? false}
            bookmarks={bookmarks}
            onBookmarksChange={handleBookmarksChange}
            onTabButton={handleTabButton}
          />
        ) : <div style={centeredStyle}>Drive not found</div>,
        footer: {
          onMenuButton: () => {
            showContextMenu(<Menu label={customTab.name} cancelText="Close">
              <MenuItem onSelected={() => promptRenameTab(id, customTab.name)}>
                Rename Tab
              </MenuItem>
              <MenuItem onSelected={() => promptReorderTabs()}>
                Reorder Tabs
              </MenuItem>
              {tabsConfig.defaultDrive === id
                ? <MenuItem onSelected={() => handleUnsetDefaultDrive()}>Unset Default Tab</MenuItem>
                : <MenuItem onSelected={() => handleSetDefaultDrive(id)}>Set as Default Tab</MenuItem>
              }
              {ejectableDrive && (
                <MenuItem onSelected={async () => {
                  const res = await ejectDrive(ejectableDrive.path);
                  if (res.success) { toaster.toast({ title: "Ejected", body: ejectableDrive.label }); loadDrives(); }
                  else { toaster.toast({ title: "Eject failed", body: res.error ?? "Unknown error" }); }
                }}>Eject {ejectableDrive.label}</MenuItem>
              )}
              <MenuItem onSelected={() => promptRemoveTab(customTab)}>
                Remove Tab
              </MenuItem>
            </Menu>, window);
          },
          onMenuActionDescription: "Tab options",
        },
      });
    });
    
    // ── Apply Custom Ordering ──
    // If user has manually reordered after setting a default, respect tabOrder exactly.
    // Otherwise, float the default tab to position 0 (so D-pad down lands on it),
    // then apply tabOrder for the remaining tabs.
    const orderedTabs = tabsConfig.tabOrder.length > 0
      ? tabsConfig.tabOrder
          .map(id => allTabs.find(t => t.id === id))
          .filter((t): t is typeof allTabs[0] => t !== undefined)
          .concat(allTabs.filter(t => !tabsConfig.tabOrder.includes(t.id)))
      : allTabs;

    const sortedTabs = tabsConfig.defaultDrive && !tabsConfig.defaultTabReordered
      ? [
          ...orderedTabs.filter(t => t.id === tabsConfig.defaultDrive),
          ...orderedTabs.filter(t => t.id !== tabsConfig.defaultDrive),
        ]
      : orderedTabs;
    
    return sortedTabs.map(({ id, title, content, footer }) => ({ id, title, content, footer }));
  }, [drives, tabsConfig, driveStates, makeStateUpdater, fileClipboard, handleExit, loadDrives, handleNavigateToDrive, handleAddTab, handleRemoveTab, handleRenameTab, handleSetDefaultDrive, handleUnsetDefaultDrive, promptRenameTab, promptRemoveTab, promptReorderTabs]);
  // Keep tabsRef in sync so handleTabButton always sees the latest list
  tabsRef.current = tabs;



  if (loading) return <div style={centeredStyle}>Loading drives...</div>;
  if (drives.length === 0) return <div style={centeredStyle}>No drives found.</div>;

  return (
    <div ref={tabsWrapperRef} style={{ marginTop: 40, height: "calc(100% - 40px)" }}>
      <Tabs activeTab={activeTab}
        onShowTab={(id: string) => { setActiveTab(id); }}
        tabs={tabs} />
    </div>
  );
};

function tabId(drive: Drive): string { return drive.path || drive.device || drive.label; }
const centeredStyle: React.CSSProperties = {
  marginTop: 40, height: "calc(100% - 40px)",
  display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontSize: 14,
};
