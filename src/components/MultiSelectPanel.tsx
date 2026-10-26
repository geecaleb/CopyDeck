import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  showModal,
  showContextMenu,
  Menu,
  MenuItem,
  Toggle,
  ConfirmModal,
  TextField,
  SliderField,
  ReorderableList,
  ReorderableEntry,
} from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { toaster } from "@decky/api";
import { forceRefresh } from "../lib/jobNotifier";
import { COPYDECK_BROWSER_ROUTE } from "../constants";
import {
  getDrives,
  getAllDrives,
  getInstalledGames,
  queueGames,
  ejectDrive,
  getSetting,
  setSetting,
  checkPathExists,
  getHomeDir,
  getTargetHistory,
  type Game,
  type Drive,
} from "../utils/backendApi";
import { formatStorageGb } from "../utils/formatStorage";
import { CopyGamesMenu } from "./CopyGamesMenu";
import { BatchProgressPanel } from "./BatchProgressPanel";

export interface BatchJob {
  appid: string;
  name: string;
  sourcePath: string;
  destPath: string;
  copyWorkshop?: boolean;
  copyCompatdata?: boolean;
  skipGame?: boolean;
  conflictMode?: "skip" | "overwrite";
}

export function MultiSelectPanel() {
  const [games, setGames] = useState<Game[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [loading, setLoading] = useState(true);
  const [uninstallInMenu, setUninstallInMenu] = useState(true);
  const [copyInMenu, setCopyInMenu] = useState(true);
  const [browseInMenu, setBrowseInMenu] = useState(true);
  const [setTargetInMenu, setSetTargetInMenu] = useState(true);
  const [subMenuInMenu, setSubMenuInMenu] = useState(true);
  const [copyWorkshopDetect, setCopyWorkshopDetect] = useState(true);
  const [copyCompatdataDetect, setCopyCompatdataDetect] = useState(true);
  const [autoSetTarget, setAutoSetTarget] = useState(true);
  const [nonSteamCompatdataDetect, setNonSteamCompatdataDetect] = useState(true);
  const [settingsCollapsed, setSettingsCollapsed] = useState(true);
  const [contextMenuCollapsed, setContextMenuCollapsed] = useState(true);
  const [otherSettingsCollapsed, setOtherSettingsCollapsed] = useState(true);
  const [gameDestCollapsed, setGameDestCollapsed] = useState(true);
  const [prefixDestCollapsed, setPrefixDestCollapsed] = useState(true);
  const [scanLocationsCollapsed, setScanLocationsCollapsed] = useState(true);
  const [nonSteamCollapsed, setNonSteamCollapsed] = useState(true);
  const [nonSteamLocations, setNonSteamLocations] = useState<string[]>([]);
  const [nonSteamDest, setNonSteamDest] = useState<string>("Games/NonSteam");
  const [nonSteamDestSlots, setNonSteamDestSlots] = useState<{ tag: string; subfolder: string }[]>([]);
  const [reorderingLocs, setReorderingLocs] = useState(false);
  const [reorderingSlots, setReorderingSlots] = useState(false);
  const [nonSteamPrefixDest, setNonSteamPrefixDest] = useState<string>("");
  const [lutrisPrefixDest, setLutrisPrefixDest] = useState<string>("");
  const [lutrisSupport, setLutrisSupport] = useState(true);
  const [autoSkipGameFolder, setAutoSkipGameFolder] = useState(true);
  const [romDetectEnabled, setRomDetectEnabled] = useState(true);
  const [romScanDepth, setRomScanDepth] = useState(3);
  const [copySettingsCollapsed, setCopySettingsCollapsed] = useState(true);
  const [browseDestFallback, setBrowseDestFallback] = useState(false);
  const [copyDestFallback, setCopyDestFallback] = useState(true);
  const [uninstallDestFallback, setUninstallDestFallback] = useState(false);
  const [driveSelectorSize, setDriveSelectorSize] = useState(true);
  const [sortCompletedAlpha, setSortCompletedAlpha] = useState(true);
  const [sortQueuedAlpha, setSortQueuedAlpha] = useState(true);
  const [browseRememberLocation, setBrowseRememberLocation] = useState(true);
  const [cancelPartialPrompt, setCancelPartialPrompt] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [g, d, uninstallSetting, copySetting, browseSetting, setTargetSetting, subMenuSetting, workshopSetting, compatdataSetting, autoSetTargetSetting, nonSteamCompatdataSetting, settingsCollapsedSetting, nonSteamCollapsedSetting] = await Promise.all([
        getInstalledGames(),
        getDrives(),
        getSetting("uninstall_in_menu", "true"),
        getSetting("copy_in_menu", "true"),
        getSetting("browse_in_menu", "true"),
        getSetting("settarget_in_menu", "true"),
        getSetting("submenu_in_menu", "true"),
        getSetting("copy_workshop_detect", "true"),
        getSetting("copy_compatdata_detect", "true"),
        getSetting("auto_set_target", "true"),
        getSetting("nonsteam_compatdata_detect", "true"),
        getSetting("settings_collapsed", "true"),
        getSetting("nonsteam_collapsed", "true"),
      ]);
      setGames(g);
      setDrives(d);
      const enabled = uninstallSetting === "true";
      setUninstallInMenu(enabled);
      // Keep patch.tsx cache in sync
      (window as any).__copydeck_set_uninstall_in_menu?.(enabled);
      const copyEnabled = copySetting === "true";
      setCopyInMenu(copyEnabled);
      (window as any).__copydeck_set_copy_in_menu?.(copyEnabled);
      const browseEnabled = browseSetting === "true";
      setBrowseInMenu(browseEnabled);
      (window as any).__copydeck_set_browse_in_menu?.(browseEnabled);
      const setTargetEnabled = setTargetSetting === "true";
      setSetTargetInMenu(setTargetEnabled);
      (window as any).__copydeck_set_settarget_in_menu?.(setTargetEnabled);
      const subMenuEnabled = subMenuSetting === "true";
      setSubMenuInMenu(subMenuEnabled);
      (window as any).__copydeck_set_submenu_in_menu?.(subMenuEnabled);
      const workshopEnabled = workshopSetting === "true";
      setCopyWorkshopDetect(workshopEnabled);
      (window as any).__copydeck_copy_workshop_detect = workshopEnabled;
      const compatdataEnabled = compatdataSetting === "true";
      setCopyCompatdataDetect(compatdataEnabled);
      (window as any).__copydeck_copy_compatdata_detect = compatdataEnabled;
      const autoSetTargetEnabled = autoSetTargetSetting === "true";
      setAutoSetTarget(autoSetTargetEnabled);
      (window as any).__copydeck_auto_set_target = autoSetTargetEnabled;
      const nonSteamCompatdataEnabled = nonSteamCompatdataSetting === "true";
      setNonSteamCompatdataDetect(nonSteamCompatdataEnabled);
      (window as any).__copydeck_nonsteam_compatdata_detect = nonSteamCompatdataEnabled;
      setSettingsCollapsed(settingsCollapsedSetting !== "false");
      setNonSteamCollapsed(nonSteamCollapsedSetting !== "false");
      // Cache games so context menu patch can resolve library_path
      (window as any).__copydeck_games = g;
      // Pre-warm target history cache for non-Steam games
      try {
        const shortcutDirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
        const nonSteamIds = Object.keys(shortcutDirs);
        const histEntries = await Promise.all(
          nonSteamIds.map(async (id) => [id, await getTargetHistory(id)] as [string, import("../utils/backendApi").TargetSnapshot[]])
        );
        const histCache: Record<string, import("../utils/backendApi").TargetSnapshot[]> = {};
        for (const [id, hist] of histEntries) histCache[id] = hist;
        (window as any).__copydeck_target_history = histCache;
      } catch {}
      // Load saved non-Steam locations
      try {
        const locStr = await getSetting("nonsteam_locations", "[]");
        const locs: string[] = JSON.parse(locStr);
        setNonSteamLocations(locs);
        (window as any).__copydeck_nonsteam_locations = locs;
      } catch { setNonSteamLocations([]); }
      try {
        const dest = await getSetting("nonsteam_dest", "Games/NonSteam");
        setNonSteamDest(dest);
        (window as any).__copydeck_nonsteam_dest = dest;
      } catch {}
      try {
        const slotsStr = await getSetting("nonsteam_dest_slots", "[]");
        const slots: { tag: string; subfolder: string }[] = JSON.parse(slotsStr);
        setNonSteamDestSlots(slots);
        (window as any).__copydeck_nonsteam_dest_slots = slots;
      } catch { setNonSteamDestSlots([]); }
      try {
        const nsPrefixDest = await getSetting("nonsteam_prefix_dest", "");
        setNonSteamPrefixDest(nsPrefixDest);
        (window as any).__copydeck_nonsteam_prefix_dest = nsPrefixDest;
      } catch {}
      try {
        const lutPrefixDest = await getSetting("lutris_prefix_dest", "");
        setLutrisPrefixDest(lutPrefixDest);
        (window as any).__copydeck_lutris_prefix_dest = lutPrefixDest;
      } catch {}
      try {
        const lutrisSupportSetting = await getSetting("lutris_support", "true");
        const lutrisSupportOn = lutrisSupportSetting !== "false";
        setLutrisSupport(lutrisSupportOn);
        (window as any).__copydeck_lutris_support = lutrisSupportOn;
        const romDetect = await getSetting("rom_detect_enabled", "true");
        const romDetectOn = romDetect !== "false";
        setRomDetectEnabled(romDetectOn);
        (window as any).__copydeck_rom_detect_enabled = romDetectOn;
        const depthStr = await getSetting("rom_scan_depth", "3");
        const depthParsed = parseInt(depthStr, 10);
        const depth = Math.max(0, Math.min(4, isNaN(depthParsed) ? 3 : depthParsed));
        setRomScanDepth(depth);
        (window as any).__copydeck_rom_scan_depth = depth;
        const autoSkipGameFolderSetting = await getSetting("auto_skip_game_folder", "true");
        const autoSkipGameFolderOn = autoSkipGameFolderSetting !== "false";
        setAutoSkipGameFolder(autoSkipGameFolderOn);
        (window as any).__copydeck_auto_skip_game_folder = autoSkipGameFolderOn;
      } catch {}
      try {
        const copyCollapsed = await getSetting("copy_settings_collapsed", "true");
        setCopySettingsCollapsed(copyCollapsed !== "false");
        const scanLocCollapsed = await getSetting("scan_locations_collapsed", "true");
        setScanLocationsCollapsed(scanLocCollapsed !== "false");
        const gameDestColl = await getSetting("game_dest_collapsed", "true");
        setGameDestCollapsed(gameDestColl !== "false");
        const prefixDestColl = await getSetting("prefix_dest_collapsed", "true");
        setPrefixDestCollapsed(prefixDestColl !== "false");
        const otherSettColl = await getSetting("other_settings_collapsed", "true");
        setOtherSettingsCollapsed(otherSettColl !== "false");
      } catch {}
      try {
        const destFallback = await getSetting("browse_dest_fallback", "false");
        const destFallbackOn = destFallback === "true";
        setBrowseDestFallback(destFallbackOn);
        (window as any).__copydeck_browse_dest_fallback = destFallbackOn;
        const copyFallback = await getSetting("copy_dest_fallback", "true");
        const copyFallbackOn = copyFallback !== "false";
        setCopyDestFallback(copyFallbackOn);
        (window as any).__copydeck_copy_dest_fallback = copyFallbackOn;
        const uninstallFallback = await getSetting("uninstall_dest_fallback", "false");
        const uninstallFallbackOn = uninstallFallback === "true";
        setUninstallDestFallback(uninstallFallbackOn);
        (window as any).__copydeck_uninstall_dest_fallback = uninstallFallbackOn;
        const driveSelSize = await getSetting("drive_selector_size", "true");
        const driveSelSizeOn = driveSelSize !== "false";
        setDriveSelectorSize(driveSelSizeOn);
        (window as any).__copydeck_drive_selector_size = driveSelSizeOn;
        const sortCompleted = await getSetting("sort_completed_alpha", "true");
        const sortCompletedOn = sortCompleted !== "false";
        setSortCompletedAlpha(sortCompletedOn);
        (window as any).__copydeck_sort_completed_alpha = sortCompletedOn;
        const sortQueued = await getSetting("sort_queued_alpha", "true");
        const sortQueuedOn = sortQueued !== "false";
        setSortQueuedAlpha(sortQueuedOn);
        (window as any).__copydeck_sort_queued_alpha = sortQueuedOn;
        const browseRemember = await getSetting("browse_remember_location", "true");
        const browseRememberOn = browseRemember !== "false";
        setBrowseRememberLocation(browseRememberOn);
        (window as any).__copydeck_browse_remember_location = browseRememberOn;
        if (!browseRememberOn) (window as any).__copydeck_browser_session = null;
        const cancelPartial = await getSetting("cancel_partial_prompt", "true");
        const cancelPartialOn = cancelPartial !== "false";
        setCancelPartialPrompt(cancelPartialOn);
        (window as any).__copydeck_cancel_partial_prompt = cancelPartialOn;
      } catch {}
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onStartBatch = async (jobs: BatchJob[]) => {
    if (jobs.length === 0) return;
    await queueGames(
      jobs.map((j) => ({
        appid: j.appid,
        name: j.name,
        src_library: j.sourcePath,
        dst_library: j.destPath,
        copy_workshop: j.copyWorkshop ?? false,
        copy_compatdata: j.copyCompatdata ?? false,
        skip_game_files: j.skipGame ?? false,
        conflict_mode: j.conflictMode ?? "skip",
      }))
    );
    const firstName = jobs[0]?.name ?? "Game";
    setTimeout(() => {
      if (jobs.length === 1) {
        toaster.toast({ title: "Queued", body: firstName });
      } else {
        toaster.toast({
          title: "Queued",
          body: `${firstName} + ${jobs.length - 1} others`,
        });
      }
    }, 350);
    forceRefresh();
  };


  const saveNonSteamLocations = async (locs: string[]) => {
    setNonSteamLocations(locs);
    (window as any).__copydeck_nonsteam_locations = locs;
    await setSetting("nonsteam_locations", JSON.stringify(locs));
  };

  const saveNonSteamDest = async (dest: string) => {
    const cleaned = dest.trim().replace(/^\//, "").replace(/\/$/, ""); // empty = drive root
    setNonSteamDest(cleaned);
    (window as any).__copydeck_nonsteam_dest = cleaned;
    await setSetting("nonsteam_dest", cleaned);
  };

  const saveNonSteamDestSlots = async (slots: { tag: string; subfolder: string }[]) => {
    setNonSteamDestSlots(slots);
    (window as any).__copydeck_nonsteam_dest_slots = slots;
    await setSetting("nonsteam_dest_slots", JSON.stringify(slots));
  };

  const saveNonSteamPrefixDest = async (dest: string) => {
    const cleaned = dest.trim().replace(/\/$/, "");
    setNonSteamPrefixDest(cleaned);
    (window as any).__copydeck_nonsteam_prefix_dest = cleaned;
    await setSetting("nonsteam_prefix_dest", cleaned);
  };

  const saveLutrisPrefixDest = async (dest: string) => {
    const cleaned = dest.trim().replace(/\/$/, "");
    setLutrisPrefixDest(cleaned);
    (window as any).__copydeck_lutris_prefix_dest = cleaned;
    await setSetting("lutris_prefix_dest", cleaned);
  };
  const openGamesMenu = async () => {
    let freshGames = games;
    try {
      freshGames = await getInstalledGames();
      setGames(freshGames);
      (window as any).__copydeck_games = freshGames;
    } catch {}
    showModal(
      <CopyGamesMenu
        games={freshGames}
        drives={drives}
        onStartBatch={onStartBatch}
        onGamesChange={(next) => {
          setGames(next);
          (window as any).__copydeck_games = next;
        }}
      />,
      window
    );
  };

  if (loading) return null;

  const ejectMenu = async () => {
    const allDrives = await getAllDrives().catch(() => drives);
    const external = allDrives.filter((d) => !d.is_internal);
    if (external.length === 0) {
      toaster.toast({ title: "No drives", body: "No external drives to eject." });
      return;
    }
    showContextMenu(
      <Menu label="Eject Drive" cancelText="Back">
        {external.map((drive) => (
          <MenuItem
            key={drive.path}
            onSelected={async () => {
              const res = await ejectDrive(drive.path);
              if (res.success) {
                toaster.toast({ title: "Ejected", body: drive.label });
                load();
              } else {
                toaster.toast({ title: "Eject failed", body: res.error ?? drive.label });
              }
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <span>{drive.label}</span>
              <span style={{ color: "#888", marginLeft: 16 }}>
                {formatStorageGb(drive.free_gb)} free of {formatStorageGb(drive.total_gb)}
              </span>
            </div>
          </MenuItem>
        ))}
      </Menu>,
      window
    );
  };

  return (
    <Focusable style={{ display: "flex", flexDirection: "column" }}>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => Navigation.Navigate(COPYDECK_BROWSER_ROUTE)}
            disabled={drives.length === 0}
          >
            Browse Files
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={openGamesMenu}
            disabled={games.length === 0}
          >
            Select Games
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={ejectMenu}
            disabled={drives.filter((d) => !d.is_internal).length === 0}
          >
            Eject Drive
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
      <PanelSection title="Toggles">
        <PanelSectionRow>
          <Focusable>
            <DialogButton
              style={{ width: "100%", padding: "2px 0", fontSize: 11, textAlign: "center" }}
              onClick={async () => {
                const next = !settingsCollapsed;
                setSettingsCollapsed(next);
                await setSetting("settings_collapsed", next ? "true" : "false");
              }}
            >
              {settingsCollapsed ? "▼" : "▲"}
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        {!settingsCollapsed && <>
          <div style={{ marginTop: 8 }} />
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Context Menu</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={() => setContextMenuCollapsed(v => !v)}
                >
                  {contextMenuCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!contextMenuCollapsed && <>
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Show Copy</span>}>
              <Focusable>
                <Toggle
                  value={copyInMenu}
                  onChange={async (v) => {
                    setCopyInMenu(v);
                    (window as any).__copydeck_set_copy_in_menu?.(v);
                    await setSetting("copy_in_menu", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Show Uninstall</span>}>
              <Focusable>
                <Toggle
                  value={uninstallInMenu}
                  onChange={async (v) => {
                    setUninstallInMenu(v);
                    (window as any).__copydeck_set_uninstall_in_menu?.(v);
                    await setSetting("uninstall_in_menu", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Show Browse</span>}>
              <Focusable>
                <Toggle
                  value={browseInMenu}
                  onChange={async (v) => {
                    setBrowseInMenu(v);
                    (window as any).__copydeck_set_browse_in_menu?.(v);
                    await setSetting("browse_in_menu", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Show Set Target</span>}>
              <Focusable>
                <Toggle
                  value={setTargetInMenu}
                  onChange={async (v) => {
                    setSetTargetInMenu(v);
                    (window as any).__copydeck_set_settarget_in_menu?.(v);
                    await setSetting("settarget_in_menu", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Group in Sub Menu</span>}>
              <Focusable>
                <Toggle
                  value={subMenuInMenu}
                  onChange={async (v) => {
                    setSubMenuInMenu(v);
                    (window as any).__copydeck_set_submenu_in_menu?.(v);
                    await setSetting("submenu_in_menu", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          </>}
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Copy Settings</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={async () => {
                    const next = !copySettingsCollapsed;
                    setCopySettingsCollapsed(next);
                    await setSetting("copy_settings_collapsed", next ? "true" : "false");
                  }}
                >
                  {copySettingsCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!copySettingsCollapsed && <>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Workshop Detection (Copy)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, workshop content is included when copying Steam games.</span>}
            >
              <Focusable>
                <Toggle
                  value={copyWorkshopDetect}
                  onChange={async (v) => {
                    setCopyWorkshopDetect(v);
                    (window as any).__copydeck_copy_workshop_detect = v;
                    await setSetting("copy_workshop_detect", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Compatdata Detection (Copy)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, compatdata (Proton prefix) is included when copying Steam games.</span>}
            >
              <Focusable>
                <Toggle
                  value={copyCompatdataDetect}
                  onChange={async (v) => {
                    setCopyCompatdataDetect(v);
                    (window as any).__copydeck_copy_compatdata_detect = v;
                    await setSetting("copy_compatdata_detect", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Compatdata Detection (Non-Steam Copy)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, detects and copies the Proton prefix (compatdata) when copying non-Steam games.</span>}
            >
              <Focusable>
                <Toggle
                  value={nonSteamCompatdataDetect}
                  onChange={async (v) => {
                    setNonSteamCompatdataDetect(v);
                    (window as any).__copydeck_nonsteam_compatdata_detect = v;
                    await setSetting("nonsteam_compatdata_detect", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Auto Set Target (Non-Steam Copy)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, the shortcut exe path is automatically updated after a non-Steam game copy completes.</span>}
            >
              <Focusable>
                <Toggle
                  value={autoSetTarget}
                  onChange={async (v) => {
                    setAutoSetTarget(v);
                    (window as any).__copydeck_auto_set_target = v;
                    await setSetting("auto_set_target", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Ask Keep/Remove Partial on Cancel</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, Cancel and Cancel All ask whether to keep or delete the partial destination. When off, cancel just stops and leaves files (old behaviour).</span>}
            >
              <Focusable>
                <Toggle
                  value={cancelPartialPrompt}
                  onChange={async (v) => {
                    setCancelPartialPrompt(v);
                    (window as any).__copydeck_cancel_partial_prompt = v;
                    await setSetting("cancel_partial_prompt", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Destination Subdirectory Fallback (Copy)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, Copy will search the destination subfolder across all drives if the game can't be found in any scan location.</span>}
            >
              <Focusable>
                <Toggle
                  value={copyDestFallback}
                  onChange={async (v) => {
                    setCopyDestFallback(v);
                    (window as any).__copydeck_copy_dest_fallback = v;
                    await setSetting("copy_dest_fallback", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Size on Drive Selector</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, the Copy To drive menu shows the real game folder size (fills in after a quick scan).</span>}
            >
              <Focusable>
                <Toggle
                  value={driveSelectorSize}
                  onChange={async (v) => {
                    setDriveSelectorSize(v);
                    (window as any).__copydeck_drive_selector_size = v;
                    await setSetting("drive_selector_size", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Sort Completed List Alphabetically</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, completed copies are A–Z. When off, they stay in the order they finished.</span>}
            >
              <Focusable>
                <Toggle
                  value={sortCompletedAlpha}
                  onChange={async (v) => {
                    setSortCompletedAlpha(v);
                    (window as any).__copydeck_sort_completed_alpha = v;
                    await setSetting("sort_completed_alpha", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Sort Queue List Alphabetically</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, queued copies are A–Z. When off, they stay in the order they were added.</span>}
            >
              <Focusable>
                <Toggle
                  value={sortQueuedAlpha}
                  onChange={async (v) => {
                    setSortQueuedAlpha(v);
                    (window as any).__copydeck_sort_queued_alpha = v;
                    await setSetting("sort_queued_alpha", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          </>}
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Other Settings</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={async () => {
                    const next = !otherSettingsCollapsed;
                    setOtherSettingsCollapsed(next);
                    await setSetting("other_settings_collapsed", next ? "true" : "false");
                  }}
                >
                  {otherSettingsCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!otherSettingsCollapsed && <>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Remember Browse Location</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, Browse Files keeps your tab and folder until Steam or Plugin Loader restarts. When off, it resets each time you open it.</span>}
            >
              <Focusable>
                <Toggle
                  value={browseRememberLocation}
                  onChange={async (v) => {
                    setBrowseRememberLocation(v);
                    (window as any).__copydeck_browse_remember_location = v;
                    if (!v) (window as any).__copydeck_browser_session = null;
                    await setSetting("browse_remember_location", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Destination Subdirectory Fallback (Browse &amp; Set Target)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, Browse and Set Target will search the destination subfolder across all drives if the game's path can't be found.</span>}
            >
              <Focusable>
                <Toggle
                  value={browseDestFallback}
                  onChange={async (v) => {
                    setBrowseDestFallback(v);
                    (window as any).__copydeck_browse_dest_fallback = v;
                    await setSetting("browse_dest_fallback", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Destination Subdirectory Fallback (Uninstall)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, Uninstall will search the destination subfolder across all drives if the game can't be found in any scan location.</span>}
            >
              <Focusable>
                <Toggle
                  value={uninstallDestFallback}
                  onChange={async (v) => {
                    setUninstallDestFallback(v);
                    (window as any).__copydeck_uninstall_dest_fallback = v;
                    await setSetting("uninstall_dest_fallback", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Enable Lutris Support</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, enables Lutris game detection for Copy, Browse, Set Target, and Uninstall — allowing CopyDeck to read Lutris metadata, copy Wine prefixes, and update Lutris paths after a move. Turn off if you don't use Lutris.</span>}
            >
              <Focusable>
                <Toggle
                  value={lutrisSupport}
                  onChange={async (v) => {
                    setLutrisSupport(v);
                    (window as any).__copydeck_lutris_support = v;
                    await setSetting("lutris_support", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Automatically Skip Game Folder (Roms)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, the game shortcut folder is automatically moved to Skipped in the copy modal when a ROM is detected — so only the ROM is copied by default.</span>}
            >
              <Focusable>
                <Toggle
                  value={autoSkipGameFolder}
                  onChange={async (v) => {
                    setAutoSkipGameFolder(v);
                    (window as any).__copydeck_auto_skip_game_folder = v;
                    await setSetting("auto_skip_game_folder", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Launch Path Detection (Roms)</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>When on, detects rom files linked in non-Steam launch options and offers to copy them alongside the game.</span>}
            >
              <Focusable>
                <Toggle
                  value={romDetectEnabled}
                  onChange={async (v) => {
                    setRomDetectEnabled(v);
                    (window as any).__copydeck_rom_detect_enabled = v;
                    await setSetting("rom_detect_enabled", v ? "true" : "false");
                  }}
                />
              </Focusable>
            </Field>
          </PanelSectionRow>
          {romDetectEnabled && (
            <PanelSectionRow>
              <SliderField
                label="Rom Scan Depth"
                description="How many folder levels deep to search for a rom when its path can't be found directly. 0 = scan location root only."
                value={romScanDepth}
                min={0}
                max={4}
                step={1}
                notchCount={5}
                notchLabels={[
                  { notchIndex: 0, label: "0" },
                  { notchIndex: 1, label: "1" },
                  { notchIndex: 2, label: "2" },
                  { notchIndex: 3, label: "3" },
                  { notchIndex: 4, label: "4" },
                ]}
                onChange={async (v) => {
                  setRomScanDepth(v);
                  (window as any).__copydeck_rom_scan_depth = v;
                  await setSetting("rom_scan_depth", String(v));
                }}
              />
            </PanelSectionRow>
          )}
          </>}
        </>}
      </PanelSection>

      <PanelSection title="Non-Steam">
        <PanelSectionRow>
          <Focusable>
            <DialogButton
              style={{ width: "100%", padding: "2px 0", fontSize: 11, textAlign: "center" }}
              onClick={async () => {
                const next = !nonSteamCollapsed;
                setNonSteamCollapsed(next);
                await setSetting("nonsteam_collapsed", next ? "true" : "false");
              }}
            >
              {nonSteamCollapsed ? "▼" : "▲"}
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        {!nonSteamCollapsed && <>
          <div style={{ marginTop: 8 }} />
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Game Destination</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={async () => {
                    const next = !gameDestCollapsed;
                    setGameDestCollapsed(next);
                    await setSetting("game_dest_collapsed", next ? "true" : "false");
                  }}
                >
                  {gameDestCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!gameDestCollapsed && <>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Destination Subfolder</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>Folder appended to drive root when copying non-Steam games.</span>}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable>
              <DialogButton
                style={{ width: "100%", padding: "6px 10px", fontFamily: "monospace", fontSize: 12, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", textAlign: "left" }}
                onClick={() => {
                  const PathModal = ({ closeModal }: { closeModal?: () => void }) => {
                    const [val, setVal] = (useState as any)(nonSteamDest);
                    return (
                      <ConfirmModal
                        strTitle="Set Destination Subfolder"
                        strDescription="Enter the subfolder path (no leading slash). Appended to the drive root."
                        strOKButtonText="Save"
                        strCancelButtonText="Cancel"
                        onOK={async () => { await saveNonSteamDest(val); closeModal?.(); }}
                        onCancel={() => closeModal?.()}
                      >
                        <TextField
                          autoFocus
                          value={val}
                          onChange={(e: any) => setVal(e.target.value)}
                          style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }}
                        />
                        {val === "" && (
                          <DialogButton style={{ marginTop: 8, padding: "4px 12px", fontSize: 12 }} onClick={() => setVal("Games/NonSteam")}>
                            Use Default (Games/NonSteam)
                          </DialogButton>
                        )}
                      </ConfirmModal>
                    );
                  };
                  showModal(<PathModal />, window);
                }}
              >
                {nonSteamDest || "(drive root)"}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Tagged Destinations</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>Route files by tag. If the source path (target, start dir, or launch option) contains the tag name, those files mirror to that tag's destination subfolder instead of the default. Useful for: keeping NonSteam and Rom folders separate on the destination drive.</span>}
            />
          </PanelSectionRow>
          {nonSteamDestSlots.length > 1 && (
            <PanelSectionRow>
              <Focusable>
                <DialogButton style={{ width: "100%", padding: "4px 10px", fontSize: 12 }} onClick={() => setReorderingSlots(v => !v)}>
                  {reorderingSlots ? "✓ Done Reordering" : "⇅ Reorder Tags"}
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          )}
          <div style={{ marginTop: 4 }} />
          {reorderingSlots && nonSteamDestSlots.length > 1 ? (
            <PanelSectionRow>
              <ReorderableList<{ slot: { tag: string; subfolder: string } }>
                entries={nonSteamDestSlots.map((slot, i) => ({ label: `${slot.tag} → ${slot.subfolder || "(root)"}`, position: i, data: { slot } }))}
                onSave={async (reordered: ReorderableEntry<{ slot: { tag: string; subfolder: string } }>[]) => {
                  await saveNonSteamDestSlots(reordered.map(e => e.data!.slot));
                }}
              />
            </PanelSectionRow>
          ) : nonSteamDestSlots.map((slot, i) => (
            <PanelSectionRow key={i}>
              <div style={{ display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box", overflow: "hidden", marginTop: i > 0 ? 4 : 0 }}>
                <div style={{ fontSize: 11, color: "#4fc3f7", fontWeight: 600, marginBottom: 2, paddingLeft: 4 }}>{slot.tag}</div>
                <Focusable style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", boxSizing: "border-box" }}>
                  <DialogButton
                    style={{
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: "monospace",
                      textAlign: "left",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                      flex: 1,
                      minWidth: 0,
                      maxWidth: "calc(100% - 36px)",
                    }}
                    onClick={() => {
                      const EditModal = ({ closeModal }: { closeModal?: () => void }) => {
                        const [tag, setTag] = (useState as any)(slot.tag);
                        const [sub, setSub] = (useState as any)(slot.subfolder ?? "");
                        return (
                          <ConfirmModal
                            strTitle="Edit Path Tag"
                            strOKButtonText="Save"
                            strCancelButtonText="Cancel"
                            onOK={async () => {
                              const t = tag.trim();
                              const s = sub.trim().replace(/^\//, "").replace(/\/$/, "");
                              if (!t) { closeModal?.(); return; }
                              const updated = [...nonSteamDestSlots];
                              updated[i] = { tag: t, subfolder: s };
                              await saveNonSteamDestSlots(updated);
                              closeModal?.();
                            }}
                            onCancel={() => closeModal?.()}
                          >
                            <div style={{ fontSize: 12, color: "#aaa", marginTop: 8, marginBottom: 4 }}>Single Tag — word found in Target, Start In, or Launch Option:</div>
                            <TextField autoFocus value={tag} onChange={(e: any) => setTag(e.target.value)} style={{ width: "100%", fontSize: 13, fontFamily: "monospace" }} />
                            <div style={{ fontSize: 12, color: "#aaa", marginTop: 8, marginBottom: 4 }}>Destination subfolder (blank = drive root):</div>
                            <TextField value={sub} onChange={(e: any) => setSub(e.target.value)} style={{ width: "100%", fontSize: 13, fontFamily: "monospace" }} />
                          </ConfirmModal>
                        );
                      };
                      showModal(<EditModal />, window);
                    }}
                  >
                    {slot.subfolder || "(drive root)"}
                  </DialogButton>
                  <DialogButton
                    style={{ padding: "2px 4px", minWidth: 0, maxWidth: 28, width: 28, flexShrink: 0, fontSize: 10 }}
                    onClick={() => saveNonSteamDestSlots(nonSteamDestSlots.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </DialogButton>
                </Focusable>
              </div>
            </PanelSectionRow>
          ))}
          <div style={{ marginTop: 4 }} />
          <PanelSectionRow>
            <Focusable>
              <DialogButton
                style={{ width: "100%", padding: "4px 10px", fontSize: 12 }}
                onClick={() => {
                  setReorderingSlots(false);
                  const AddSlotModal = ({ closeModal }: { closeModal?: () => void }) => {
                    const [tag, setTag] = (useState as any)("");
                    const [sub, setSub] = (useState as any)("");
                    return (
                      <ConfirmModal
                        strTitle="Add Path Tag"
                        strOKButtonText="Add"
                        strCancelButtonText="Cancel"
                        onOK={async () => {
                          const t = tag.trim();
                          const s = sub.trim().replace(/^\//, "").replace(/\/$/, "");
                          if (!t) { closeModal?.(); return; }
                          if (nonSteamDestSlots.some(sl => sl.tag === t)) {
                            toaster.toast({ title: "Tag already exists", body: t });
                            return;
                          }
                          await saveNonSteamDestSlots([...nonSteamDestSlots, { tag: t, subfolder: s }]);
                          closeModal?.();
                        }}
                        onCancel={() => closeModal?.()}
                      >
                        <div style={{ fontSize: 12, color: "#aaa", marginTop: 8, marginBottom: 4 }}>Single Tag — word found in Target, Start In, or Launch Option:</div>
                        <TextField autoFocus value={tag} onChange={(e: any) => setTag(e.target.value)} style={{ width: "100%", fontSize: 13, fontFamily: "monospace" }} />
                        <div style={{ fontSize: 12, color: "#aaa", marginTop: 8, marginBottom: 4 }}>Destination subfolder (blank = drive root):</div>
                        <TextField value={sub} onChange={(e: any) => setSub(e.target.value)} style={{ width: "100%", fontSize: 13, fontFamily: "monospace" }} />
                      </ConfirmModal>
                    );
                  };
                  showModal(<AddSlotModal />, window);
                }}
              >
                + Tag
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          </>}
          <div style={{ marginTop: 8 }} />
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Prefix Destination</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={async () => {
                    const next = !prefixDestCollapsed;
                    setPrefixDestCollapsed(next);
                    await setSetting("prefix_dest_collapsed", next ? "true" : "false");
                  }}
                >
                  {prefixDestCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!prefixDestCollapsed && <>
          <div style={{ marginTop: 4 }} />
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Non-Steam Prefix Destination</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>Where non-Steam Proton prefixes (compatdata) are copied on external drives. Leave blank to use steamapps/compatdata on the drive root. Internal drives always follow the Steam library path and ignore this setting.</span>}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable>
              <DialogButton
                style={{ width: "100%", padding: "6px 10px", fontFamily: "monospace", fontSize: 12, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", textAlign: "left" }}
                onClick={() => {
                  const PrefixModal = ({ closeModal }: { closeModal?: () => void }) => {
                    const [val, setVal] = (useState as any)(nonSteamPrefixDest);
                    return (
                      <ConfirmModal
                        strTitle="Set Non-Steam Prefix Destination"
                        strDescription="Path for non-Steam compatdata copies on external drives. Leave blank for [drive root]/steamapps/compatdata. Internal drives always use the Steam library path regardless of this setting."
                        strOKButtonText="Save"
                        strCancelButtonText="Cancel"
                        onOK={async () => { await saveNonSteamPrefixDest(val); closeModal?.(); }}
                        onCancel={() => closeModal?.()}
                      >
                        <TextField
                          autoFocus
                          value={val}
                          onChange={(e: any) => setVal(e.target.value)}
                          style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }}
                        />

                      </ConfirmModal>
                    );
                  };
                  showModal(<PrefixModal />, window);
                }}
              >
                {nonSteamPrefixDest || "steamapps/compatdata"}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          {lutrisSupport && <>
          <PanelSectionRow>
            <Field
              label={<span style={{ fontSize: 13 }}>Lutris Prefix Destination</span>}
              description={<span style={{ fontSize: 11, color: "#888" }}>Where Lutris Wine prefixes are copied. Leave blank to default to ~/Prefixes.</span>}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable>
              <DialogButton
                style={{ width: "100%", padding: "6px 10px", fontFamily: "monospace", fontSize: 12, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", textAlign: "left" }}
                onClick={() => {
                  const LutrisPrefixModal = ({ closeModal }: { closeModal?: () => void }) => {
                    const [val, setVal] = (useState as any)(lutrisPrefixDest);
                    return (
                      <ConfirmModal
                        strTitle="Set Lutris Prefix Destination"
                        strDescription="Full path for Lutris Wine prefix copies. Leave blank to use ~/Prefixes."
                        strOKButtonText="Save"
                        strCancelButtonText="Cancel"
                        onOK={async () => { await saveLutrisPrefixDest(val); closeModal?.(); }}
                        onCancel={() => closeModal?.()}
                      >
                        <TextField
                          autoFocus
                          value={val}
                          onChange={(e: any) => setVal(e.target.value)}
                          style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }}
                        />

                      </ConfirmModal>
                    );
                  };
                  showModal(<LutrisPrefixModal />, window);
                }}
              >
                {lutrisPrefixDest || "~/Prefixes"}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          </>}
          </>}
          <div style={{ marginTop: 8 }} />
          <PanelSectionRow>
            <Field label={<span style={{ fontSize: 13 }}>Scan Locations</span>}>
              <Focusable>
                <DialogButton
                  style={{ padding: "2px 8px", minWidth: 0, fontSize: 11 }}
                  onClick={async () => {
                    setScanLocationsCollapsed(v => {
                      const next = !scanLocationsCollapsed;
                      setSetting("scan_locations_collapsed", next ? "true" : "false");
                      return next;
                    });
                  }}
                >
                  {scanLocationsCollapsed ? "▼" : "▲"}
                </DialogButton>
              </Focusable>
            </Field>
          </PanelSectionRow>
          {!scanLocationsCollapsed && <>
          <div style={{ marginTop: 4 }} />
          <PanelSectionRow>
            <Field description={<span style={{ fontSize: 11, color: "#888" }}>Root folders where your non-Steam games live. Used to find games when their shortcut path is unavailable and to copy the whole game folder rather than just the subfolder the exe is in.</span>} />
          </PanelSectionRow>
          {nonSteamLocations.length > 1 && (
            <PanelSectionRow>
              <Focusable>
                <DialogButton style={{ width: "100%", padding: "4px 10px", fontSize: 12 }} onClick={() => setReorderingLocs(v => !v)}>
                  {reorderingLocs ? "✓ Done Reordering" : "⇅ Reorder Locations"}
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          )}
          <div style={{ marginTop: 4 }} />
          {reorderingLocs && nonSteamLocations.length > 1 ? (
            <PanelSectionRow>
              <ReorderableList<{ loc: string }>
                entries={nonSteamLocations.map((loc, i) => ({ label: loc, position: i, data: { loc } }))}
                onSave={async (reordered: ReorderableEntry<{ loc: string }>[]) => {
                  await saveNonSteamLocations(reordered.map(e => e.data!.loc));
                }}
              />
            </PanelSectionRow>
          ) : nonSteamLocations.map((loc, i) => (
            <PanelSectionRow key={i}>
              <Focusable style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", boxSizing: "border-box", marginTop: i > 0 ? 4 : 0 }}>
                <DialogButton
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    fontFamily: "monospace",
                    textAlign: "left",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    flex: 1,
                    minWidth: 0,
                    maxWidth: "calc(100% - 36px)",
                  }}
                  onClick={() => {
                    const EditModal = ({ closeModal }: { closeModal?: () => void }) => {
                      const [val, setVal] = (useState as any)(loc);
                      const valRef = (useRef as any)(loc);
                      return (
                        <ConfirmModal
                          strTitle="Edit Scan Location"
                          strDescription="Enter the full path to a folder containing non-Steam games:"
                          strOKButtonText="Save"
                          strCancelButtonText="Cancel"
                          onOK={async () => {
                            const trimmed = valRef.current.trim();
                            if (!trimmed) { closeModal?.(); return; }
                            const exists = await checkPathExists(trimmed);
                            if (!exists) {
                              toaster.toast({ title: "Path not found", body: trimmed });
                              return;
                            }
                            const updated = [...nonSteamLocations];
                            updated[i] = trimmed;
                            await saveNonSteamLocations(updated);
                            closeModal?.();
                          }}
                          onCancel={() => closeModal?.()}
                        >
                          <TextField
                            autoFocus
                            value={val}
                            onChange={(e: any) => { valRef.current = e.target.value; setVal(e.target.value); }}
                            style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }}
                          />
                          <DialogButton
                            style={{ marginTop: 8, width: "100%" }}
                            onClick={() => {
                              closeModal?.();
                              (window as any).__copydeck_dirpicker = true;
                              Navigation.Navigate(COPYDECK_BROWSER_ROUTE);
                            }}
                          >
                            📁 Browse to folder…
                          </DialogButton>
                        </ConfirmModal>
                      );
                    };
                    showModal(<EditModal />, window);
                  }}
                >
                  {loc}
                </DialogButton>
                <DialogButton
                  style={{ padding: "2px 4px", minWidth: 0, maxWidth: 28, width: 28, flexShrink: 0, fontSize: 10 }}
                  onClick={() => saveNonSteamLocations(nonSteamLocations.filter((_, idx) => idx !== i))}
                >
                  ✕
                </DialogButton>
              </Focusable>
            </PanelSectionRow>
          ))}
          <div style={{ marginTop: 4 }} />
          <PanelSectionRow>
            <Focusable>
              <DialogButton
                style={{ width: "100%", padding: "4px 10px", fontSize: 12 }}
                onClick={() => {
                  setReorderingLocs(false);
                  const AddModal = ({ closeModal }: { closeModal?: () => void }) => {
                    const [val, setVal] = (useState as any)("");
                    const valRef = (useRef as any)("");
                    return (
                      <ConfirmModal
                        strTitle="Add Scan Location"
                        strDescription="Enter the full path to a folder containing non-Steam games:"
                        strOKButtonText="Add"
                        strCancelButtonText="Cancel"
                        onOK={async () => {
                          const trimmed = valRef.current.trim();
                          if (!trimmed) { closeModal?.(); return; }
                          const exists = await checkPathExists(trimmed);
                          if (!exists) {
                            toaster.toast({ title: "Path not found", body: trimmed });
                            return;
                          }
                          if (nonSteamLocations.includes(trimmed)) {
                            toaster.toast({ title: "Already added", body: trimmed });
                            closeModal?.();
                            return;
                          }
                          await saveNonSteamLocations([...nonSteamLocations, trimmed]);
                          toaster.toast({ title: "Location added", body: trimmed });
                          closeModal?.();
                        }}
                        onCancel={() => closeModal?.()}
                      >
                        <TextField
                          autoFocus
                          value={val}
                          onChange={(e: any) => { valRef.current = e.target.value; setVal(e.target.value); }}
                          style={{ width: "100%", marginTop: 8, fontSize: 13, fontFamily: "monospace" }}
                        />
                        <DialogButton
                          style={{ marginTop: 8, width: "100%" }}
                          onClick={() => {
                            closeModal?.();
                            (window as any).__copydeck_dirpicker = true;
                            Navigation.Navigate(COPYDECK_BROWSER_ROUTE);
                          }}
                        >
                          📁 Browse to folder…
                        </DialogButton>
                      </ConfirmModal>
                    );
                  };
                  showModal(<AddModal />, window);
                }}
              >
                + Scan Location
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
          </>}
        </>}
      </PanelSection>

      <PanelSection title="Copy Progress">
        <BatchProgressPanel />
      </PanelSection>
    </Focusable>
  );
}
