import { call } from "@decky/api";

export interface Drive {
  path: string;
  label: string;
  free_gb: number;
  total_gb: number;
  is_internal?: boolean;
  device?: string;
  fs_type?: string;
}

export async function getAllDrives(): Promise<Drive[]> {
  return call<[], Drive[]>("get_all_drives");
}


export interface Game {
  appid: string;
  name: string;
  size_bytes: number;
  installdir: string;
  library_path: string;
  acf_path: string;
}

export interface CopyResult {
  success: boolean;
  error?: string;
}

export interface CopyProgress {
  copied: number;
  total: number;
  done: boolean;
  error: string | null;
  status?: string;
  already_existed?: boolean;
}

export interface JobProgress extends CopyProgress {
  name?: string;
  stage?: string;
  status?: string;
  pause_reason?: string | null;
  already_existed?: boolean;
  op?: string;
  src?: string;
  dst_dir?: string;
  dst_library?: string;
  dest_path?: string;
  group_id?: string;
  group_total?: number;
  group_total_bytes?: number;
  /** Monotonic finish order for completed jobs (set by backend). */
  completed_seq?: number;
}

export type AllCopyProgress = {
  [appid: string]: JobProgress;
};

export interface AllProgress {
  is_copying: boolean;
  is_stopping: boolean;
  jobs: AllCopyProgress;
}

export async function getDrives(): Promise<Drive[]> {
  return call<[], Drive[]>("get_drives");
}

export async function getInstalledGames(): Promise<Game[]> {
  return call<[], Game[]>("get_installed_games");
}

export async function getShortcutDirs(steamId?: string): Promise<Record<string, string>> {
  return call<[string], Record<string, string>>("get_all_shortcut_dirs", steamId ?? "");
}

export async function copyGame(
  appid: string,
  srcLibrary: string,
  dstLibrary: string,
  name?: string
): Promise<CopyResult> {
  return call<[string, string, string, string?], CopyResult>(
    "copy_game",
    appid,
    srcLibrary,
    dstLibrary,
    name ?? ""
  );
}

export async function getShortcutExe(appid: string | number): Promise<string> {
  return call<[string], string>("get_shortcut_exe", String(appid));
}

/** Returns the raw Exe VDF field, including any launcher prefix/extra args, without stripping outer quotes. */
export async function getShortcutRawExe(appid: string | number): Promise<string> {
  return call<[string], string>("get_shortcut_raw_exe", String(appid));
}

/** Returns the LaunchOptions VDF field for a non-Steam shortcut. */
export async function getShortcutLaunchOptions(appid: string | number): Promise<string> {
  return call<[string], string>("get_shortcut_launch_options", String(appid));
}

export async function getHomeDir(): Promise<string> {
  return call<[], string>("get_home_dir");
}

export async function copyNonSteam(
  jobId: string,
  srcDir: string,
  dstDir: string,
  name: string,
  conflictMode: "skip" | "overwrite" = "skip",
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string, string, string, string], { success: boolean; error?: string }>(
    "copy_nonsteam",
    jobId,
    srcDir,
    dstDir,
    name,
    conflictMode,
  );
}

export async function copyNonSteamFile(
  jobId: string,
  srcFile: string,
  dstFile: string,
  name: string,
  conflictMode: "skip" | "overwrite" = "skip",
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string, string, string, string], { success: boolean; error?: string }>(
    "copy_nonsteam_file",
    jobId,
    srcFile,
    dstFile,
    name,
    conflictMode,
  );
}

export async function getCopyProgress(appid: string): Promise<CopyProgress> {
  return call<[string], CopyProgress>("get_copy_progress", appid);
}

export async function getAllProgress(): Promise<AllProgress> {
  return call<[], AllProgress>("get_all_progress");
}

export async function clearAllProgress(): Promise<void> {
  return call<[], void>("clear_all_progress");
}

export async function clearCompletedProgress(): Promise<void> {
  return call<[], void>("clear_completed_progress");
}

export async function clearCompletedJob(jobId: string): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>("clear_completed_job", jobId);
}

export async function queueGames(
  jobs: Array<{
    appid: string;
    name: string;
    src_library: string;
    dst_library: string;
    copy_workshop?: boolean;
    copy_compatdata?: boolean;
    skip_game_files?: boolean;
    conflict_mode?: "skip" | "overwrite";
  }>
): Promise<{ success: boolean; job_count: number }> {
  return call<
    [Array<{ appid: string; name: string; src_library: string; dst_library: string; copy_workshop?: boolean; copy_compatdata?: boolean; skip_game_files?: boolean; conflict_mode?: string }>],
    { success: boolean; job_count: number }
  >(
    "queue_games",
    jobs.map((j) => ({
      appid: j.appid,
      name: j.name,
      src_library: j.src_library,
      dst_library: j.dst_library,
      copy_workshop: j.copy_workshop ?? false,
      copy_compatdata: j.copy_compatdata ?? false,
      skip_game_files: j.skip_game_files ?? false,
      conflict_mode: j.conflict_mode ?? "skip",
    }))
  );
}

export async function removeFromQueue(appid: string): Promise<{ success: boolean }> {
  return call<[string], { success: boolean }>("remove_from_queue", appid);
}

export async function removeGroupFromQueue(groupId: string): Promise<{ success: boolean }> {
  return call<[string], { success: boolean }>("remove_group_from_queue", groupId);
}

export async function pauseGroup(groupId: string): Promise<{ success: boolean }> {
  return call<[string], { success: boolean }>("pause_group", groupId);
}

export async function resumeGroup(groupId: string): Promise<{ success: boolean }> {
  return call<[string], { success: boolean }>("resume_group", groupId);
}


export async function cancelCopy(): Promise<{ success: boolean }> {
  return call<[], { success: boolean }>("cancel_copy");
}

export async function cancelAll(removePartial: boolean = false): Promise<{ success: boolean }> {
  return call<[boolean], { success: boolean }>("cancel_all", removePartial);
}

export async function cancelJob(
  jobId: string,
  removePartial: boolean = false,
): Promise<{ success: boolean; error?: string }> {
  return call<[string, boolean], { success: boolean; error?: string }>(
    "cancel_job",
    jobId,
    removePartial,
  );
}

export async function cancelGroup(
  groupId: string,
  removePartial: boolean = false,
): Promise<{ success: boolean }> {
  return call<[string, boolean], { success: boolean }>("cancel_group", groupId, removePartial);
}

export async function pauseCopy(appid: string): Promise<{ success: boolean }> {
  return call<[string], { success: boolean }>("pause_copy", appid);
}

export async function resumeCopy(
  appid: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "resume_copy",
    appid
  );
}

export async function ejectDrive(
  path: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "eject_drive",
    path
  );
}

export interface GameSizes {
  game_size: number;
  acf_size: number;
  compatdata_size: number;
  shadercache_size: number;
  workshop_size: number;
  installdir: string;
  compatdata_path: string;
  shadercache_path: string;
  workshop_path: string;
}

export interface UninstallJob {
  appid: string;
  library_path: string;
  delete_files: boolean;
  delete_acf: boolean;
  delete_compatdata: boolean;
  delete_shadercache: boolean;
  delete_workshop?: boolean;
}

export async function scanDriveContentAppids(libraryPath: string): Promise<{ compatdata_appids: string[]; workshop_appids: string[] }> {
  return call<[string], { compatdata_appids: string[]; workshop_appids: string[] }>("scan_drive_content_appids", libraryPath);
}

export async function getGameSizes(
  appid: string,
  libraryPath: string
): Promise<GameSizes> {
  return call<[string, string], GameSizes>("get_game_sizes", appid, libraryPath);
}

export async function uninstallGames(
  jobs: UninstallJob[]
): Promise<{ success: boolean; errors: Array<{ appid: string; error: string }> }> {
  return call<[UninstallJob[]], { success: boolean; errors: Array<{ appid: string; error: string }> }>(
    "uninstall_games",
    jobs
  );
}

export async function getSetting(key: string, defaultVal: string): Promise<string> {
  return call<[string, string], string>("get_setting", key, defaultVal);
}

export async function setSetting(key: string, value: string): Promise<{ success: boolean }> {
  return call<[string, string], { success: boolean }>("set_setting", key, value);
}

export interface OrphanAcfNoFolder {
  appid: string;
  name: string;
  installdir: string;
  acf_path: string;
  size_bytes: number;
}

export interface OrphanFolderNoAcf {
  name: string;
  folder_path: string;
  size_bytes: number;
}

export interface OrphanCache {
  appid: string;
  name: string;
  library_path: string;
  has_shadercache: boolean;
  shadercache_size: number;
  shadercache_path: string;
  has_compatdata: boolean;
  compatdata_size: number;
  compatdata_path: string;
  total_size: number;
}

export interface OrphanedCachesResult {
  caches: OrphanCache[];
  nonsteam_caches: OrphanCache[];
}

export interface OrphanedEntries {
  acf_no_folder: OrphanAcfNoFolder[];
  folder_no_acf: OrphanFolderNoAcf[];
  acf_no_workshop: OrphanAcfNoWorkshop[];
  workshop_no_acf: OrphanWorkshopNoAcf[];
}

export interface OrphanAcfNoWorkshop {
  appid: string;
  name: string;
  acf_path: string;
  game_installed: boolean;
}

export interface OrphanWorkshopNoAcf {
  appid: string;
  name: string;
  workshop_path: string;
  workshop_size: number;
  game_installed: boolean;
}

export async function getOrphanedEntries(libraryPath: string): Promise<OrphanedEntries> {
  return call<[string], OrphanedEntries>("get_orphaned_entries", libraryPath);
}

export async function deleteOrphanedFolder(
  folderPath: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "delete_orphaned_folder",
    folderPath
  );
}

export async function getOrphanedCaches(libraryPath: string): Promise<OrphanedCachesResult> {
  return call<[string], OrphanedCachesResult>("get_orphaned_caches", libraryPath);
}

export async function deleteOrphanedCaches(
  appid: string,
  libraryPath: string,
  deleteShadercache: boolean = true,
  deleteCompatdata: boolean = true,
): Promise<{ success: boolean; errors: string[] }> {
  return call<[string, string, boolean, boolean], { success: boolean; errors: string[] }>(
    "delete_orphaned_caches",
    appid,
    libraryPath,
    deleteShadercache,
    deleteCompatdata,
  );
}

export async function deleteOrphanedWorkshop(
  workshopPath: string,
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "delete_orphaned_workshop",
    workshopPath,
  );
}

export async function deleteOrphanedWorkshopAcf(
  acfPath: string,
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "delete_orphaned_workshop_acf",
    acfPath,
  );
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  link_target: string | null;
  size_bytes: number;
  item_count?: number | null;
  mtime?: number;
  ctime?: number;
}

export async function deletePath(
  path: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>("delete_path", path);
}

export async function getPathSize(
  path: string
): Promise<{ success: boolean; size_bytes: number; error?: string }> {
  return call<[string], { success: boolean; size_bytes: number; error?: string }>("get_path_size", path);
}

export async function createDir(
  path: string
): Promise<{ success: boolean; path?: string; name?: string; error?: string }> {
  return call<[string], { success: boolean; path?: string; name?: string; error?: string }>("create_dir", path);
}

export async function createFile(
  path: string
): Promise<{ success: boolean; path?: string; name?: string; error?: string }> {
  return call<[string], { success: boolean; path?: string; name?: string; error?: string }>("create_file", path);
}

export async function createSymlink(
  target: string,
  linkPath: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string], { success: boolean; error?: string }>(
    "create_symlink",
    target,
    linkPath
  );
}

export async function readTextFile(
  path: string
): Promise<{ success: boolean; text?: string; error?: string }> {
  return call<[string], { success: boolean; text?: string; error?: string }>("read_text_file", path);
}

export async function writeTextFile(
  path: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string], { success: boolean; error?: string }>("write_text_file", path, text);
}

export async function readBinaryFile(
  path: string
): Promise<{ success: boolean; data?: string; mime?: string; error?: string }> {
  return call<[string], { success: boolean; data?: string; mime?: string; error?: string }>("read_binary_file", path);
}

export async function listDir(path: string): Promise<FsEntry[]> {
  try {
    const result = await call<[string], FsEntry[]>("list_dir", path);
    return result ?? [];
  } catch {
    return [];
  }
}

export interface FileOpJob {
  op: "copy" | "move";
  src: string;
  dst_dir: string;
  label: string;
  group_id: string;
  group_total: number;
  group_total_bytes?: number;
  /** From browse duplicate prompt: skip existing files, or overwrite all. */
  conflict_mode?: "skip" | "overwrite";
}

export async function checkFileOpConflicts(
  jobs: Array<{ src: string; dst_dir: string }>
): Promise<{ has_conflicts: boolean; error?: string }> {
  return call<[Array<{ src: string; dst_dir: string }>], { has_conflicts: boolean; error?: string }>(
    "check_file_op_conflicts",
    jobs
  );
}

export async function queueFileOps(
  jobs: FileOpJob[]
): Promise<{ success: boolean; job_count?: number; error?: string }> {
  return call<[FileOpJob[]], { success: boolean; job_count?: number; error?: string }>(
    "queue_file_ops",
    jobs
  );
}

export async function renamePath(
  src: string,
  newName: string
): Promise<{ success: boolean; new_path?: string; error?: string }> {
  return call<[string, string], { success: boolean; new_path?: string; error?: string }>(
    "rename_path",
    src,
    newName
  );
}

export async function writeClipboardFile(
  text: string
): Promise<{ success: boolean; error?: string }> {
  return call<[string], { success: boolean; error?: string }>(
    "write_clipboard_file",
    text,
  );
}

export async function readClipboardFile(): Promise<{ success: boolean; text?: string; error?: string }> {
  return call<[], { success: boolean; text?: string; error?: string }>(
    "read_clipboard_file",
  );
}

export async function renameSymlink(
  linkPath: string,
  newName: string,
  newTarget: string
): Promise<{ success: boolean; new_path?: string; error?: string }> {
  return call<[string, string, string], { success: boolean; new_path?: string; error?: string }>(
    "rename_symlink",
    linkPath,
    newName,
    newTarget
  );
}

export interface ExtractJob {
  src: string;
  dst_dir: string;
  password?: string;
  label?: string;
  group_id?: string;
}

export async function queueCompress(
  jobs: Array<{ srcs: string[]; dst: string; fmt: "targz" | "zip"; label: string }>
): Promise<{ success: boolean; job_count: number; job_ids?: string[]; error?: string }> {
  return call<
    [Array<{ srcs: string[]; dst: string; fmt: string; label: string }>],
    { success: boolean; job_count: number; job_ids?: string[]; error?: string }
  >("queue_compress", jobs);
}

export async function queueExtract(
  jobs: ExtractJob[]
): Promise<{ success: boolean; job_count: number; job_ids?: string[]; error?: string }> {
  return call<[ExtractJob[]], { success: boolean; job_count: number; job_ids?: string[]; error?: string }>(
    "queue_extract",
    jobs
  );
}

export async function renderPdfPages(
  path: string,
  dpi: number = 150
): Promise<{ success: boolean; pages?: string[]; error?: string }> {
  return call<[string, number], { success: boolean; pages?: string[]; error?: string }>(
    "render_pdf_pages",
    path,
    dpi
  );
}

export async function checkPathExists(path: string): Promise<boolean> {
  return call<[string], boolean>("check_path_exists", path);
}

export async function uninstallNonSteam(gameDir: string, appid?: string): Promise<{ success: boolean; error?: string }> {
  return call<[string, string], { success: boolean; error?: string }>("uninstall_nonsteam", gameDir, appid ?? "");
}

/** Copy a non-Steam game's compatdata from Steam's internal location to a destination steamapps folder. */
export async function findNonSteamCompatdata(
  appid: string,
  gameDir: string = "",
): Promise<{ found: boolean; path?: string | null; shadercache_path?: string | null; error?: string }> {
  return call<[string, string], { found: boolean; path?: string | null; shadercache_path?: string | null; error?: string }>(
    "find_nonsteam_compatdata",
    appid,
    gameDir,
  );
}

export async function copyNonSteamCompatdata(
  appid: string,
  dstSteamapps: string,
  srcPath: string = "",
  conflictMode: "skip" | "overwrite" = "skip",
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string, string, string], { success: boolean; error?: string }>(
    "copy_nonsteam_compatdata",
    appid,
    dstSteamapps,
    srcPath,
    conflictMode,
  );
}

/** Returns exe, startDir, and launchOptions for a non-Steam shortcut in one VDF pass. */
export async function getShortcutSnapshot(appid: string | number): Promise<{ exe: string; startDir: string; launchOptions: string }> {
  return call<[string], { exe: string; startDir: string; launchOptions: string }>("get_shortcut_snapshot", String(appid));
}

// ── Per-game target history (stored via Decky SettingsManager) ───────────────
const HISTORY_MAX = 6;

export interface TargetSnapshot {
  exe: string;
  startDir: string;
  launchOptions: string;
  // Lutris-specific fields — present only on snapshots saved by doLutrisCopy.
  // When isLutris is true, restore writes back to the YML + pga.db via
  // updateLutrisPaths instead of touching the Steam shortcut.
  isLutris?: boolean;
  lutrisId?: number;
  lutrisPgaDb?: string;
  lutrisYmlPath?: string;
  // New install dir and prefix path for Lutris snapshots.
  // Stored separately from exe/launchOptions so restore has both without ambiguity.
  lutrisInstallDir?: string;
  lutrisPrefixPath?: string;
  lutrisArgs?: string;
  lutrisWorkingDir?: string;
}

export async function getTargetHistory(appid: string | number): Promise<TargetSnapshot[]> {
  try {
    const raw = await getSetting(`target_history_${appid}`, "[]");
    const parsed = JSON.parse(raw);
    // Back-compat: old entries were plain strings
    return (parsed as any[]).map((e) =>
      typeof e === "string" ? { exe: e, startDir: "", launchOptions: "" } : e
    ) as TargetSnapshot[];
  } catch {
    return [];
  }
}

export async function addTargetHistory(appid: string | number, snapshot: TargetSnapshot): Promise<void> {
  try {
    const hist = await getTargetHistory(appid);
    // For Lutris snapshots deduplicate on exe path.
    // For non-Steam snapshots deduplicate on exe as before.
    const isSameLutris = (h: TargetSnapshot) =>
      snapshot.isLutris && h.isLutris && h.exe === snapshot.exe;
    const isSameNonSteam = (h: TargetSnapshot) =>
      !snapshot.isLutris && !h.isLutris && h.exe === snapshot.exe;
    const next = [snapshot, ...hist.filter((h) => !isSameLutris(h) && !isSameNonSteam(h))].slice(0, HISTORY_MAX);
    await setSetting(`target_history_${appid}`, JSON.stringify(next));
    // Also update the in-memory cache patch.tsx reads
    const cache: Record<string, TargetSnapshot[]> = (window as any).__copydeck_target_history ?? {};
    cache[String(appid)] = next;
    (window as any).__copydeck_target_history = cache;
  } catch {}
}

export async function removeTargetHistory(appid: string | number, exe?: string): Promise<void> {
  try {
    const hist = exe
      ? (await getTargetHistory(appid)).filter((h) => h.exe !== exe)
      : [];
    await setSetting(`target_history_${appid}`, JSON.stringify(hist));
    const cache: Record<string, TargetSnapshot[]> = (window as any).__copydeck_target_history ?? {};
    cache[String(appid)] = hist;
    (window as any).__copydeck_target_history = cache;
  } catch {}
}

// ─── Lutris support ──────────────────────────────────────────────────────────

export interface LutrisGameInfo {
  found: boolean;
  id?: number;
  slug?: string;
  name?: string;
  install_dir?: string;
  exe?: string;
  args?: string;
  working_dir?: string;
  yml_path?: string;
  prefix_path?: string;
  kind?: "flatpak" | "native";
  pga_db?: string;
  error?: string;
}

export interface LutrisShortcutResult {
  is_lutris: boolean;
  lutris_id?: string | null;
  game_info?: LutrisGameInfo | null;
  error?: string;
}

export interface LutrisInstalledGame {
  id: number;
  slug: string;
  name: string;
  runner: string;
  install_dir: string;
  yml_path: string;
  prefix_path: string;
  kind: string;
  pga_db: string;
}

export async function detectLutrisShortcut(appid: string): Promise<LutrisShortcutResult> {
  return call<[string], LutrisShortcutResult>("detect_lutris_shortcut", appid);
}

export async function getLutrisGameInfo(lutrisId: string): Promise<LutrisGameInfo> {
  return call<[string], LutrisGameInfo>("get_lutris_game_info", lutrisId);
}

export async function getLutrisInstalledGames(): Promise<LutrisInstalledGame[]> {
  return call<[], LutrisInstalledGame[]>("get_lutris_installed_games");
}

export async function findLutrisPrefix(
  appid: string,
  prefixPath: string,
  lutrisPrefixDest: string,
  otherDriveRoots: string = "",
): Promise<{ found: boolean; path: string | null }> {
  return call<[string, string, string, string], { found: boolean; path: string | null }>(
    "find_lutris_prefix", appid, prefixPath, lutrisPrefixDest, otherDriveRoots
  );
}

export async function copyLutrisGame(
  jobId: string,
  srcDir: string,
  dstDir: string,
  name: string,
  lutrisId: number,
  pgaDb: string,
  ymlPath: string,
  prefixPath: string,
  dstPrefixDir: string,
  copyGame: boolean,
  conflictMode: "skip" | "overwrite" = "skip",
): Promise<CopyResult> {
  return call<[string, string, string, string, number, string, string, string, string, boolean, string], CopyResult>(
    "copy_lutris_game", jobId, srcDir, dstDir, name, lutrisId, pgaDb, ymlPath, prefixPath, dstPrefixDir, copyGame, conflictMode
  );
}

export async function updateLutrisPaths(
  pgaDb: string,
  lutrisId: number,
  ymlPath: string,
  newInstallDir: string,
  newPrefixPath: string,
  newExePath: string = "",
  newArgs: string = "",
  newWorkingDir: string = "",
): Promise<{ success: boolean; errors?: string[] }> {
  return call<[string, number, string, string, string, string, string, string], { success: boolean; errors?: string[] }>(
    "update_lutris_paths", pgaDb, lutrisId, ymlPath, newInstallDir, newPrefixPath, newExePath, newArgs, newWorkingDir
  );
}

export async function uninstallLutris(
  gameDir: string,
  prefixDir: string,
): Promise<{ success: boolean; error?: string }> {
  return call<[string, string], { success: boolean; error?: string }>(
    "uninstall_lutris", gameDir, prefixDir
  );
}
