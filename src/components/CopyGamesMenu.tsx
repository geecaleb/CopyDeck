import {
  ConfirmModal,
  DialogBody,
  DialogButton,
  DialogFooter,
  Focusable,
  ModalRoot,
  PanelSectionRow,
  showContextMenu,
  showModal,
  Menu,
  MenuItem,
  TextField,
} from "@decky/ui";
import { toaster } from "@decky/api";
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { resolveConflictMode } from "../utils/copyConflicts";
import {
  type Game,
  type Drive,
  getInstalledGames,
  getGameSizes,
  scanDriveContentAppids,
  uninstallGames,
  getOrphanedEntries,
  getOrphanedCaches,
  deleteOrphanedFolder,
  deleteOrphanedCaches,
  deleteOrphanedWorkshop,
  deleteOrphanedWorkshopAcf,
  type GameSizes,
  type OrphanAcfNoFolder,
  type OrphanFolderNoAcf,
  type OrphanAcfNoWorkshop,
  type OrphanWorkshopNoAcf,
  type OrphanedEntries,
  type OrphanCache,
} from "../utils/backendApi";
import { formatStorageGb } from "../utils/formatStorage";
import { subscribeToProgress } from "../lib/jobNotifier";
import type { BatchJob } from "./MultiSelectPanel";

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return "0 KB";
}

const rowBorder = "1px solid rgba(255,255,255,0.06)";

// Uninstall always removes everything — files, compatdata, shadercache, workshop
const UNINSTALL_OPTS = { files: true, compatdata: true, shadercache: true, workshop: true };

// Orphan selection keys:
//   "acf:{appid}:{library_path}"       — ACF exists, game folder missing
//   "folder:{folder_path}"             — folder exists, no ACF
//   "acf-no-ws:{appid}:{library_path}" — appworkshop ACF present, no content folder
//   "ws-no-acf:{workshop_path}"        — content folder present, no appworkshop ACF

function acfOrphanKey(o: OrphanAcfNoFolder, libraryPath: string) {
  return `acf:${o.appid}:${libraryPath}`;
}
function folderOrphanKey(o: OrphanFolderNoAcf) {
  return `folder:${o.folder_path}`;
}
function acfNoWorkshopKey(o: OrphanAcfNoWorkshop, libraryPath: string) {
  return `acf-no-ws:${o.appid}:${libraryPath}`;
}
function wsNoAcfKey(o: OrphanWorkshopNoAcf) {
  return `ws-no-acf:${o.workshop_path}`;
}

function cacheScKey(o: OrphanCache) {
  return `cache-sc:${o.appid}`;
}
function cacheCdKey(o: OrphanCache) {
  return `cache-cd:${o.appid}`;
}
function nonsteamScKey(o: OrphanCache) {
  return `ns-sc:${o.appid}`;
}
function nonsteamCdKey(o: OrphanCache) {
  return `ns-cd:${o.appid}`;
}

export function CopyGamesMenu({
  games: gamesProp,
  drives,
  closeModal,
  onStartBatch,
  onGamesChange,
}: {
  games: Game[];
  drives: Drive[];
  closeModal?: () => void;
  onStartBatch: (jobs: BatchJob[]) => void | Promise<void>;
  onGamesChange?: (games: Game[]) => void;
}) {
  const [liveGames, setLiveGames] = useState<Game[]>(gamesProp);
  const [expandedStack, setExpandedStack] = useState<number[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"alpha" | "size" | "appid" | "compatdata" | "workshop">("alpha");
  const uninstallOpts = UNINSTALL_OPTS;
  const [gameSizes, setGameSizes] = useState<Record<string, GameSizes>>({});
  const [loadingSizes, setLoadingSizes] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLiveGames(gamesProp);
  }, [gamesProp]);

  const applyGames = useCallback((next: Game[]) => {
    setLiveGames(next);
    onGamesChange?.(next);
    (window as any).__copydeck_games = next;
  }, [onGamesChange]);

  const refreshGames = useCallback(async () => {
    try {
      const g = await getInstalledGames();
      applyGames(g);
    } catch {
      // keep current list
    }
  }, [applyGames]);

  // When a Steam library copy finishes while this menu is open, re-scan installs
  // so the destination drive list updates without closing/reopening.
  const prevJobStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    return subscribeToProgress((state) => {
      let shouldRefresh = false;
      for (const [id, job] of Object.entries(state.jobs)) {
        const prev = prevJobStatusRef.current[id];
        const status = job.status ?? "";
        prevJobStatusRef.current[id] = status;
        // Game copies: keyed by appid, carry dst_library, no file-op `op`
        if (
          status === "done" &&
          prev !== "done" &&
          !job.op &&
          (job.dst_library || job.dest_path)
        ) {
          shouldRefresh = true;
        }
      }
      if (shouldRefresh) void refreshGames();
    });
  }, [refreshGames]);

  // Per-drive sets of appids that have compatdata / workshop folders.
  // Populated on demand when sorting by those modes.
  const [driveCompatdata, setDriveCompatdata] = useState<Record<string, Set<string>>>({});
  const [driveWorkshop, setDriveWorkshop] = useState<Record<string, Set<string>>>({});

  // Orphan state
  const [orphanData, setOrphanData] = useState<Record<string, OrphanedEntries>>({});
  const [orphanLoading, setOrphanLoading] = useState<Set<string>>(new Set());
  const [orphanExpanded, setOrphanExpanded] = useState<Set<string>>(new Set());
  const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());
  const [orphanSizes, setOrphanSizes] = useState<Record<string, { bytes: number; loading: boolean }>>({});

  // Cache orphan state — per drive (steam only, no non-steam appids)
  const [cacheOrphans, setCacheOrphans] = useState<Record<string, OrphanCache[] | null>>({});
  // Non-steam cache state — per drive
  const [nonsteamCaches, setNonsteamCaches] = useState<Record<string, OrphanCache[] | null>>({});
  const [cacheOrphansLoading, setCacheOrphansLoading] = useState<Set<string>>(new Set());
  // Names resolved from Steam's internal app list for orphaned appids
  const [orphanNames, setOrphanNames] = useState<Record<string, string>>({});
  const [cacheScExpanded, setCacheScExpanded] = useState(false);
  const [cacheCdExpanded, setCacheCdExpanded] = useState(false);
  const [workshopOrphanExpanded, setWorkshopOrphanExpanded] = useState<Set<string>>(new Set());
  const [acfNoFolderExpanded, setAcfNoFolderExpanded] = useState<Set<string>>(new Set());
  const [folderNoAcfExpanded, setFolderNoAcfExpanded] = useState<Set<string>>(new Set());
  // Non-steam section expand state — per drive
  const [nonsteamExpanded, setNonsteamExpanded] = useState<Set<string>>(new Set());
  const [nonsteamCdExpanded, setNonsteamCdExpanded] = useState(false);
  const [nonsteamScExpanded, setNonsteamScExpanded] = useState(false);

  // Resolve names for a list of appids using Steam's internal app registry.
  // Already-resolved appids are skipped. Results are merged into orphanNames.
  const resolveOrphanNames = (appids: string[]) => {
    const toResolve = appids.filter((id) => !orphanNames[id]);
    if (toResolve.length === 0) return;
    const resolved: Record<string, string> = {};
    let remaining = toResolve.length;
    for (const appid of toResolve) {
      try {
        const { unregister } = (window as any).SteamClient.Apps.RegisterForAppDetails(
          parseInt(appid),
          (details: any) => {
            unregister();
            if (details?.strDisplayName) resolved[appid] = details.strDisplayName;
            remaining--;
            if (remaining === 0) setOrphanNames((prev) => ({ ...prev, ...resolved }));
          }
        );
        setTimeout(() => { unregister(); remaining--; if (remaining === 0) setOrphanNames((prev) => ({ ...prev, ...resolved })); }, 1500);
      } catch {
        remaining--;
      }
    }
  };

  const sortedDrives = useMemo(
    () =>
      [...drives].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
      ),
    [drives]
  );

  const gamesByDrive = useMemo(() => {
    const map: Record<string, Game[]> = {};
    for (const d of drives) {
      const list = liveGames.filter((g) => g.library_path === d.path);
      if (sortMode === "size") {
        list.sort((a, b) => b.size_bytes - a.size_bytes);
      } else if (sortMode === "compatdata") {
        const cdSet = driveCompatdata[d.path];
        list.sort((a, b) => {
          const aHas = cdSet ? (cdSet.has(a.appid) ? 1 : 0) : 0;
          const bHas = cdSet ? (cdSet.has(b.appid) ? 1 : 0) : 0;
          if (bHas !== aHas) return bHas - aHas;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
      } else if (sortMode === "workshop") {
        const wsSet = driveWorkshop[d.path];
        list.sort((a, b) => {
          const aHas = wsSet ? (wsSet.has(a.appid) ? 1 : 0) : 0;
          const bHas = wsSet ? (wsSet.has(b.appid) ? 1 : 0) : 0;
          if (bHas !== aHas) return bHas - aHas;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
      } else if (sortMode === "appid") {
        list.sort((a, b) => parseInt(a.appid) - parseInt(b.appid));
      } else {
        list.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
      }
      map[d.path] = list;
    }
    return map;
  }, [liveGames, drives, sortMode, driveCompatdata, driveWorkshop]);

  const searchLower = searchQuery.trim().toLowerCase();
  const filteredGamesByDrive = useMemo(() => {
    if (!searchLower) return gamesByDrive;
    const map: Record<string, Game[]> = {};
    for (const path of Object.keys(gamesByDrive)) {
      map[path] = gamesByDrive[path].filter((g) =>
        g.name.toLowerCase().includes(searchLower)
      );
    }
    return map;
  }, [gamesByDrive, searchLower]);

  const toggleDrive = (driveIndex: number) => {
    setExpandedStack((prev) =>
      prev.includes(driveIndex)
        ? prev.filter((i) => i !== driveIndex)
        : [...prev, driveIndex]
    );
  };

  // When sorting by compatdata or workshop, scan each expanded drive's
  // steamapps/compatdata and steamapps/workshop/content directories to get
  // the list of appids that have content there. One fast listdir call per
  // drive instead of a full size walk per game.
  useEffect(() => {
    if (sortMode !== "compatdata" && sortMode !== "workshop") return;
    for (const driveIndex of expandedStack) {
      const drive = sortedDrives[driveIndex];
      if (!drive) continue;
      const alreadyHave = sortMode === "compatdata"
        ? driveCompatdata[drive.path]
        : driveWorkshop[drive.path];
      if (alreadyHave) continue; // already scanned
      scanDriveContentAppids(drive.path).then((result) => {
        setDriveCompatdata((s) => ({ ...s, [drive.path]: new Set(result.compatdata_appids) }));
        setDriveWorkshop((s) => ({ ...s, [drive.path]: new Set(result.workshop_appids) }));
      }).catch(() => {});
    }
  }, [sortMode, expandedStack]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = () => {
    if (expandedStack.length > 0) {
      setExpandedStack((p) => p.slice(0, -1));
      return;
    }
    closeModal?.();
  };

  // ── Regular game sizes ──────────────────────────────────────────────────────

  const loadSizes = (appid: string, libraryPath: string) => {
    if (gameSizes[appid] || loadingSizes.has(appid)) return;
    setLoadingSizes((s) => new Set(s).add(appid));
    getGameSizes(appid, libraryPath)
      .then((sizes) => {
        setGameSizes((s) => ({ ...s, [appid]: sizes }));
        // Cache for patch.tsx context menu uninstall workshop detection
        if (!(window as any).__copydeck_sizes) (window as any).__copydeck_sizes = {};
        (window as any).__copydeck_sizes[appid] = sizes;
      })
      .catch(() => {})
      .finally(() => {
        setLoadingSizes((s) => {
          const n = new Set(s);
          n.delete(appid);
          return n;
        });
      });
  };

  const gameKey = (appid: string, libraryPath: string) => `${appid}:${libraryPath}`;

  const toggleGame = (appid: string, libraryPath: string) => {
    const key = gameKey(appid, libraryPath);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        loadSizes(appid, libraryPath);
      }
      return next;
    });
  };

  // ── Orphan scanning ─────────────────────────────────────────────────────────

  const toggleOrphanSection = (drivePath: string) => {
    setOrphanExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(drivePath)) {
        next.delete(drivePath);
      } else {
        next.add(drivePath);
        // Trigger per-drive scan on first expand
        if (!orphanData[drivePath] && !orphanLoading.has(drivePath)) {
          setOrphanLoading((s) => new Set(s).add(drivePath));
          getOrphanedEntries(drivePath)
            .then((result) => {
              setOrphanData((s) => ({ ...s, [drivePath]: result }));
              const wsAppids = (result.workshop_no_acf ?? []).map((o) => o.appid);
              const acfAppids = (result.acf_no_workshop ?? []).map((o) => o.appid);
              const acfNoFolderAppids = (result.acf_no_folder ?? []).map((o) => o.appid);
              resolveOrphanNames([...wsAppids, ...acfAppids, ...acfNoFolderAppids]);
            })
            .catch(() => {
              setOrphanData((s) => ({
                ...s,
                [drivePath]: { acf_no_folder: [], folder_no_acf: [], acf_no_workshop: [], workshop_no_acf: [] },
              }));
            })
            .finally(() => {
              setOrphanLoading((s) => {
                const n = new Set(s);
                n.delete(drivePath);
                return n;
              });
            });
        }
        // Trigger cache scan per-drive on first expand
        if (!(drivePath in cacheOrphans) && !cacheOrphansLoading.has(drivePath)) {
          setCacheOrphansLoading((s) => new Set(s).add(drivePath));
          getOrphanedCaches(drivePath)
            .then((result) => {
              setCacheOrphans((s) => ({ ...s, [drivePath]: result.caches }));
              setNonsteamCaches((s) => ({ ...s, [drivePath]: result.nonsteam_caches ?? [] }));
              resolveOrphanNames([
                ...result.caches.map((o) => o.appid),
                ...(result.nonsteam_caches ?? []).map((o) => o.appid),
              ]);
            })
            .catch(() => {
              setCacheOrphans((s) => ({ ...s, [drivePath]: [] }));
              setNonsteamCaches((s) => ({ ...s, [drivePath]: [] }));
            })
            .finally(() => setCacheOrphansLoading((s) => { const n = new Set(s); n.delete(drivePath); return n; }));
        }
      }
      return next;
    });
  };

  // Load sizes for ACF-orphan (appid known, library_path known)
  const loadOrphanAcfSizes = (key: string, appid: string, libraryPath: string) => {
    if (orphanSizes[key]?.loading) return;
    setOrphanSizes((s) => ({ ...s, [key]: { bytes: 0, loading: true } }));
    getGameSizes(appid, libraryPath)
      .then((sizes) => {
        // For ACF-no-folder orphan: game_size should be 0, but compatdata/shadercache may exist
        const total = sizes.compatdata_size + sizes.shadercache_size;
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: total, loading: false } }));
        // Also store full sizes under the appid key for breakdown display
        setGameSizes((gs) => ({ ...gs, [appid]: sizes }));
      })
      .catch(() => {
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: 0, loading: false } }));
      });
  };

  // For folder-no-acf: size already known from scan result
  const toggleOrphanAcf = (o: OrphanAcfNoFolder, libraryPath: string) => {
    const key = acfOrphanKey(o, libraryPath);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        loadOrphanAcfSizes(key, o.appid, libraryPath);
      }
      return next;
    });
  };

  const toggleOrphanFolder = (o: OrphanFolderNoAcf) => {
    const key = folderOrphanKey(o);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.size_bytes, loading: false } }));
      }
      return next;
    });
  };

  const toggleOrphanCacheSc = (o: OrphanCache) => {
    const key = cacheScKey(o);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else {
        next.add(key);
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.shadercache_size, loading: false } }));
      }
      return next;
    });
  };
  const toggleOrphanCacheCd = (o: OrphanCache) => {
    const key = cacheCdKey(o);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else {
        next.add(key);
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.compatdata_size, loading: false } }));
      }
      return next;
    });
  };

  const toggleOrphanWsNoAcf = (o: OrphanWorkshopNoAcf) => {
    const key = wsNoAcfKey(o);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else {
        next.add(key);
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.workshop_size, loading: false } }));
      }
      return next;
    });
  };

  const toggleOrphanAcfNoWorkshop = (o: OrphanAcfNoWorkshop, libraryPath: string) => {
    const key = acfNoWorkshopKey(o, libraryPath);
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else {
        next.add(key);
        setOrphanSizes((s) => ({ ...s, [key]: { bytes: 0, loading: false } }));
      }
      return next;
    });
  };


  // ── Copy ────────────────────────────────────────────────────────────────────

  const copySelectedTo = (drivePath: string) => {
    const allSelected = liveGames.filter(
      (g) => selected.has(gameKey(g.appid, g.library_path))
    );
    // Games already on the destination are skipped — if everything was already there, say so
    const alreadyThere = allSelected.filter((g) => g.library_path === drivePath);
    const rawList = allSelected.filter((g) => g.library_path !== drivePath);

    if (rawList.length === 0) {
      if (alreadyThere.length > 0) {
        const names = alreadyThere.length === 1
          ? alreadyThere[0].name
          : `${alreadyThere.length} games`;
        toaster.toast({ title: "Already on drive", body: `${names} already on destination` });
      }
      closeModal?.();
      return;
    }

    // If the same appid is selected from multiple source drives, keep only one —
    // prefer the copy with the largest total size (most complete data).
    const seenAppids = new Set<string>();
    const sorted = [...rawList].sort((a, b) => {
      const sA = gameSizes[a.appid];
      const sB = gameSizes[b.appid];
      const tA = sA ? sA.game_size + sA.acf_size + sA.compatdata_size + sA.shadercache_size + (sA.workshop_size ?? 0) : a.size_bytes;
      const tB = sB ? sB.game_size + sB.acf_size + sB.compatdata_size + sB.shadercache_size + (sB.workshop_size ?? 0) : b.size_bytes;
      return tB - tA;
    });
    const list = sorted.filter((g) => {
      if (seenAppids.has(g.appid)) return false;
      seenAppids.add(g.appid);
      return true;
    });

    const workshopDetect = (window as any).__copydeck_copy_workshop_detect !== false;
    const compatdataDetect = (window as any).__copydeck_copy_compatdata_detect !== false;

    const withWorkshop = workshopDetect ? list.filter((g) => (gameSizes[g.appid]?.workshop_size ?? 0) > 0) : [];
    const withCompatdata = compatdataDetect ? list.filter((g) => (gameSizes[g.appid]?.compatdata_size ?? 0) > 0) : [];
    const hasWorkshop = withWorkshop.length > 0;
    const hasCompatdata = withCompatdata.length > 0;


    {
      const totalWs = withWorkshop.reduce((n, g) => n + (gameSizes[g.appid]?.workshop_size ?? 0), 0);
      const totalCd = withCompatdata.reduce((n, g) => n + (gameSizes[g.appid]?.compatdata_size ?? 0), 0);
      const totalGame = list.reduce((n, g) => n + (gameSizes[g.appid]?.game_size ?? g.size_bytes ?? 0), 0);

      const srcDriveLabel = (() => {
        const lib = list[0]?.library_path ?? "";
        const d = drives.find((dr) => lib.startsWith(dr.is_internal ? "/home" : dr.path));
        return d ? (d.is_internal ? "Internal Storage" : d.label) : "Source Drive";
      })();

      type BatchKey = "game" | "workshop" | "compatdata";
      interface BatchItem { key: BatchKey; label: string; path: string; sizeStr: string | null; }
      const batchItems: BatchItem[] = [
        { key: "game", label: "Game files",
          path: list.length === 1
            ? (list[0].library_path + "/steamapps/common")
            : `${list.length} games`,
          sizeStr: totalGame > 0 ? formatSize(totalGame) : null },
        ...(hasWorkshop ? [{ key: "workshop" as BatchKey, label: "Workshop Content",
          path: withWorkshop.length === 1
            ? (gameSizes[withWorkshop[0].appid]?.workshop_path ?? `${withWorkshop[0].library_path}/steamapps/workshop`)
            : `${withWorkshop.length} games`,
          sizeStr: totalWs > 0 ? formatSize(totalWs) : null }] : []),
        ...(hasCompatdata ? [{ key: "compatdata" as BatchKey, label: "Compatdata",
          path: withCompatdata.length === 1
            ? (gameSizes[withCompatdata[0].appid]?.compatdata_path ?? `${withCompatdata[0].library_path}/steamapps/compatdata`)
            : `${withCompatdata.length} games`,
          sizeStr: totalCd > 0 ? formatSize(totalCd) : null }] : []),
      ];

      const ExtraContentModal = ({ closeModal }: { closeModal?: () => void }) => {
        const [skipped, setSkipped] = useState<Set<BatchKey>>(new Set());
        const [skippedOpen, setSkippedOpen] = useState(false);
        const copyBtnRef = useRef<HTMLDivElement>(null);
        useEffect(() => {
          let frame: number;
          const tryFocus = () => { if (copyBtnRef.current) { copyBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
          frame = requestAnimationFrame(tryFocus);
          return () => cancelAnimationFrame(frame);
        }, []);

        const toggle = (key: BatchKey) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
        const active = batchItems.filter(i => !skipped.has(i.key));
        const skippedItems = batchItems.filter(i => skipped.has(i.key));
        const nothingToCopy = active.length === 0;

        const doCopy = async () => {
          closeModal?.();
          const copyGame = !skipped.has("game");
          const copyWorkshop = !skipped.has("workshop") && workshopDetect;
          const copyCompatdata = !skipped.has("compatdata") && compatdataDetect;

          const checks: Array<{ src: string; dst_dir: string }> = [];
          for (const g of list) {
            const s = gameSizes[g.appid];
            if (copyGame) {
              const installdir = s?.installdir || g.name;
              checks.push({
                src: `${g.library_path}/steamapps/common/${installdir}`,
                dst_dir: `${drivePath}/steamapps/common`,
              });
            }
            if (copyWorkshop && (s?.workshop_size ?? 0) > 0) {
              checks.push({
                src: s?.workshop_path || `${g.library_path}/steamapps/workshop/content/${g.appid}`,
                dst_dir: `${drivePath}/steamapps/workshop/content`,
              });
            }
            if (copyCompatdata && (s?.compatdata_size ?? 0) > 0) {
              checks.push({
                src: s?.compatdata_path || `${g.library_path}/steamapps/compatdata/${g.appid}`,
                dst_dir: `${drivePath}/steamapps/compatdata`,
              });
            }
          }
          const conflictMode = await resolveConflictMode(checks);
          if (conflictMode === null) return;

          const jobs: BatchJob[] = list.map((g) => ({
            appid: g.appid,
            name: g.name,
            sourcePath: g.library_path,
            destPath: drivePath,
            copyWorkshop: copyWorkshop && (gameSizes[g.appid]?.workshop_size ?? 0) > 0,
            copyCompatdata: copyCompatdata && (gameSizes[g.appid]?.compatdata_size ?? 0) > 0,
            skipGame: !copyGame,
            conflictMode,
          }));
          const dstLabel = (() => {
            const d = drives.find((dr) => drivePath.startsWith(dr.is_internal ? "/home" : dr.path));
            return d ? (d.is_internal ? "Internal Storage" : d.label) : "destination";
          })();
          await onStartBatch(jobs);
          const count = jobs.length;
          toaster.toast({
            title: "Copy queued",
            body: count === 1 ? `${jobs[0].name} → ${dstLabel}` : `${count} games → ${dstLabel}`,
          });
          setSelected(new Set());
        };

        const ItemCard = ({ item, inSkipped }: { item: BatchItem; inSkipped: boolean }) => (
          <Focusable
            onActivate={() => toggle(item.key)}
            style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
          >
            <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#aaa", marginBottom: 2 }}>{item.label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all", marginBottom: 3 }}>{item.path}</div>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
              <span>📁 {srcDriveLabel}</span>
              {item.sizeStr && <span>· {item.sizeStr}</span>}
            </div>
          </Focusable>
        );

        const title = list.length === 1 ? `Copy ${list[0].name}` : `Copy ${list.length} games`;

        return (
          <ModalRoot onCancel={closeModal}>
            <DialogBody>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{title}</div>
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
      showModal(<ExtraContentModal />, window);
    }
  };

  const showDrivePicker = () => {
    if (selected.size === 0 || drives.length === 0) return;
    showContextMenu(
      <Menu label="Copy to drive..." cancelText="Back">
        {sortedDrives.map((drive) => (
          <MenuItem
            key={drive.path}
            onSelected={() => copySelectedTo(drive.path)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <span>{drive.label}</span>
              <span style={{ color: "#888", marginLeft: 16 }}>
                {formatStorageGb(drive.free_gb)} free of{" "}
                {formatStorageGb(drive.total_gb)}
              </span>
            </div>
          </MenuItem>
        ))}
      </Menu>,
      window
    );
  };

  // ── Uninstall (regular games) ───────────────────────────────────────────────

  const selectedGames = useMemo(
    () => liveGames.filter((g) => selected.has(gameKey(g.appid, g.library_path))),
    [liveGames, selected]
  );

  const totalUninstallSize = useMemo(() => {
    let total = 0;
    for (const g of selectedGames) {
      const s = gameSizes[g.appid];
      if (!s) continue;
      if (uninstallOpts.files) total += s.game_size + s.acf_size;
      if (uninstallOpts.compatdata) total += s.compatdata_size;
      if (uninstallOpts.shadercache) total += s.shadercache_size;
      if (uninstallOpts.workshop) total += s.workshop_size ?? 0;
    }
    return total;
  }, [selectedGames, gameSizes, uninstallOpts]);


  const confirmUninstall = () => {
    if (selectedGames.length === 0) return;
    if (!uninstallOpts.files && !uninstallOpts.compatdata && !uninstallOpts.shadercache && !uninstallOpts.workshop) return;

    const getDriveLabel = (libraryPath: string) => {
      const d = drives.find((dr) => libraryPath.startsWith(dr.is_internal ? "/home" : dr.path));
      return d ? (d.is_internal ? "Internal Storage" : d.label) : "Storage";
    };

    const title = selectedGames.length === 1
      ? `Uninstall ${selectedGames[0].name}`
      : `Uninstall ${selectedGames.length} Games`;

    const SteamUninstallModal = ({ closeModal }: { closeModal?: () => void }) => {
      const [skipped, setSkipped] = useState<Set<string>>(new Set());
      const [skippedOpen, setSkippedOpen] = useState(false);
      const uninstallBtnRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        let frame: number;
        const tryFocus = () => { if (uninstallBtnRef.current) { uninstallBtnRef.current.focus(); } else { frame = requestAnimationFrame(tryFocus); } };
        frame = requestAnimationFrame(tryFocus);
        return () => cancelAnimationFrame(frame);
      }, []);

      const toggle = (key: string) => setSkipped(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
      const shownGames = selectedGames.slice(0, 3);
      const activeGames = shownGames.filter(g => !skipped.has(g.appid));
      const skippedGames = shownGames.filter(g => skipped.has(g.appid));
      // overflow games (beyond 3) always included — no per-row card for them
      const overflowCount = selectedGames.length - 3;
      const nothingToDelete = activeGames.length === 0 && overflowCount <= 0;

      const GameCard = ({ g, inSkipped }: { g: typeof selectedGames[0]; inSkipped: boolean }) => {
        const s = gameSizes[g.appid];
        const total = s
          ? (uninstallOpts.files ? s.game_size + s.acf_size : 0)
            + (uninstallOpts.compatdata ? s.compatdata_size : 0)
            + (uninstallOpts.shadercache ? s.shadercache_size : 0)
            + (uninstallOpts.workshop ? (s.workshop_size ?? 0) : 0)
          : 0;
        const gamePath = s?.installdir
          ? `${g.library_path}/steamapps/common/${s.installdir}`
          : `${g.library_path}/steamapps/common`;
        return (
          <Focusable
            onActivate={() => toggle(g.appid)}
            style={{ marginBottom: 6, padding: "8px 10px", background: inSkipped ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", borderRadius: 6, border: `1px solid ${inSkipped ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", outline: "none" }}
          >
            {selectedGames.length > 1 && (
              <div style={{ fontSize: 12, color: inSkipped ? "#666" : "#ddd", marginBottom: 3, fontWeight: 500 }}>{g.name}</div>
            )}
            <div style={{ fontFamily: "monospace", fontSize: 10, color: inSkipped ? "#555" : "#ddd", wordBreak: "break-all", marginBottom: 3 }}>{gamePath}</div>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: inSkipped ? "#555" : "#aaa" }}>
              <span>📁 {getDriveLabel(g.library_path)}</span>
              {total > 0 && <span>· {formatSize(total)}</span>}
            </div>
          </Focusable>
        );
      };

      const doFilteredUninstall = () => {
        closeModal?.();
        // For skipped shown games, remove them from the job list; overflow always included
        const jobGames = [
          ...shownGames.filter(g => !skipped.has(g.appid)),
          ...selectedGames.slice(3),
        ];
        if (jobGames.length === 0) return;
        const jobs = jobGames.map((g) => ({
          appid: g.appid,
          library_path: g.library_path,
          delete_files: uninstallOpts.files,
          delete_acf: uninstallOpts.files,
          delete_compatdata: uninstallOpts.compatdata,
          delete_shadercache: uninstallOpts.shadercache,
          delete_workshop: uninstallOpts.workshop && (gameSizes[g.appid]?.workshop_size ?? 0) > 0,
        }));
        Promise.resolve(uninstallGames(jobs)).then((result) => {
          const count = jobGames.length;
          if (result.success && (!result.errors || result.errors.length === 0)) {
            toaster.toast({ title: "Uninstalled", body: count === 1 ? jobGames[0].name : `${count} games uninstalled` });
          } else {
            toaster.toast({ title: "Uninstall failed", body: result.errors?.[0]?.error ?? "Unknown error" });
          }
          if (uninstallOpts.files) {
            for (const g of jobGames) {
              (window as any).SteamClient?.Apps?.UninstallApp?.(Number(g.appid)).catch?.(() => {});
            }
          }
          setSelected(new Set());
          // Drop removed installs from the open menu immediately, then re-scan.
          if (uninstallOpts.files) {
            const removed = new Set(jobGames.map((g) => gameKey(g.appid, g.library_path)));
            setLiveGames((prev) => {
              const next = prev.filter((g) => !removed.has(gameKey(g.appid, g.library_path)));
              onGamesChange?.(next);
              (window as any).__copydeck_games = next;
              return next;
            });
            setGameSizes((prev) => {
              const next = { ...prev };
              for (const g of jobGames) delete next[g.appid];
              return next;
            });
            const affectedDrives = new Set(jobGames.map((g) => g.library_path));
            setDriveCompatdata((prev) => {
              const next = { ...prev };
              for (const p of affectedDrives) delete next[p];
              return next;
            });
            setDriveWorkshop((prev) => {
              const next = { ...prev };
              for (const p of affectedDrives) delete next[p];
              return next;
            });
          }
          void refreshGames();
        });
      };

      return (
        <ModalRoot onCancel={closeModal}>
          <DialogBody>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{title}</div>
            {activeGames.map(g => <GameCard key={g.appid} g={g} inSkipped={false} />)}
            {skippedGames.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <Focusable onActivate={() => setSkippedOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", cursor: "pointer", outline: "none" }}>
                  <span style={{ fontSize: 11, color: "#888" }}>{skippedOpen ? "▼" : "▶"}</span>
                  <span style={{ fontSize: 11, color: "#888" }}>Skipped ({skippedGames.length})</span>
                </Focusable>
                {skippedOpen && skippedGames.map(g => <GameCard key={g.appid} g={g} inSkipped={true} />)}
              </div>
            )}
            {overflowCount > 0 && (
              <div style={{ fontSize: 11, color: "#888", padding: "4px 10px" }}>
                + {overflowCount} more game{overflowCount === 1 ? "" : "s"}
              </div>
            )}
            <div style={{ fontSize: 12, color: "#e57373", marginTop: 8 }}>Deleted files cannot be recovered.</div>
            <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Note: Steam must be restarted to reflect the change. If the game was on an external drive, eject and re-insert it instead.</div>
          </DialogBody>
          <DialogFooter>
            <Focusable flow-children="right" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <DialogButton
                ref={uninstallBtnRef}
                className={nothingToDelete ? undefined : "Primary"}
                disabled={nothingToDelete}
                style={{ padding: "6px 10px", fontSize: 12, minHeight: 0, opacity: nothingToDelete ? 0.4 : 1 }}
                onClick={doFilteredUninstall}
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

  // ── Orphan cleanup ──────────────────────────────────────────────────────────

  // Build list of selected orphans with their context
  const selectedOrphanList = useMemo(() => {
    const list: Array<
      | { type: "acf"; orphan: OrphanAcfNoFolder; libraryPath: string; key: string }
      | { type: "folder"; orphan: OrphanFolderNoAcf; key: string }
      | { type: "cache-sc"; orphan: OrphanCache; key: string }
      | { type: "cache-cd"; orphan: OrphanCache; key: string }
      | { type: "ns-sc"; orphan: OrphanCache; key: string }
      | { type: "ns-cd"; orphan: OrphanCache; key: string }
      | { type: "acf-no-workshop"; orphan: OrphanAcfNoWorkshop; libraryPath: string; key: string }
      | { type: "ws-no-acf"; orphan: OrphanWorkshopNoAcf; key: string }
    > = [];
    for (const [drivePath, data] of Object.entries(orphanData)) {
      for (const o of data.acf_no_folder) {
        const key = acfOrphanKey(o, drivePath);
        if (selectedOrphans.has(key)) list.push({ type: "acf", orphan: o, libraryPath: drivePath, key });
      }
      for (const o of data.folder_no_acf) {
        const key = folderOrphanKey(o);
        if (selectedOrphans.has(key)) list.push({ type: "folder", orphan: o, key });
      }
      for (const o of (data.acf_no_workshop ?? [])) {
        const key = acfNoWorkshopKey(o, drivePath);
        if (selectedOrphans.has(key)) list.push({ type: "acf-no-workshop", orphan: o, libraryPath: drivePath, key });
      }
      for (const o of (data.workshop_no_acf ?? [])) {
        const key = wsNoAcfKey(o);
        if (selectedOrphans.has(key)) list.push({ type: "ws-no-acf", orphan: o, key });
      }
    }
    for (const driveOrphans of Object.values(cacheOrphans)) {
      for (const o of driveOrphans ?? []) {
        const scKey = cacheScKey(o);
        const cdKey = cacheCdKey(o);
        if (selectedOrphans.has(scKey)) list.push({ type: "cache-sc", orphan: o, key: scKey });
        if (selectedOrphans.has(cdKey)) list.push({ type: "cache-cd", orphan: o, key: cdKey });
      }
    }
    for (const driveNs of Object.values(nonsteamCaches)) {
      for (const o of driveNs ?? []) {
        const scKey = nonsteamScKey(o);
        const cdKey = nonsteamCdKey(o);
        if (selectedOrphans.has(scKey)) list.push({ type: "ns-sc", orphan: o, key: scKey });
        if (selectedOrphans.has(cdKey)) list.push({ type: "ns-cd", orphan: o, key: cdKey });
      }
    }
    return list;
  }, [selectedOrphans, orphanData, cacheOrphans, nonsteamCaches]);

  const totalOrphanSize = useMemo(() => {
    return selectedOrphanList.reduce((sum, item) => {
      const s = orphanSizes[item.key];
      return sum + (s?.bytes ?? 0);
    }, 0);
  }, [selectedOrphanList, orphanSizes]);

  const doOrphanCleanup = useCallback(async () => {
    const errors: string[] = [];
    for (const item of selectedOrphanList) {
      try {
        if (item.type === "acf") {
          await uninstallGames([{
            appid: item.orphan.appid,
            library_path: item.libraryPath,
            delete_files: false,
            delete_acf: true,
            delete_compatdata: true,
            delete_shadercache: true,
          }]);
        } else if (item.type === "folder") {
          const res = await deleteOrphanedFolder(item.orphan.folder_path);
          if (!res.success) errors.push(res.error ?? item.orphan.name);
        } else if (item.type === "cache-sc") {
          const res = await deleteOrphanedCaches(item.orphan.appid, item.orphan.library_path, true, false);
          if (!res.success) errors.push(...res.errors);
        } else if (item.type === "cache-cd") {
          const res = await deleteOrphanedCaches(item.orphan.appid, item.orphan.library_path, false, true);
          if (!res.success) errors.push(...res.errors);
        } else if (item.type === "ns-sc") {
          const res = await deleteOrphanedCaches(item.orphan.appid, item.orphan.library_path, true, false);
          if (!res.success) errors.push(...res.errors);
        } else if (item.type === "ns-cd") {
          const res = await deleteOrphanedCaches(item.orphan.appid, item.orphan.library_path, false, true);
          if (!res.success) errors.push(...res.errors);
        } else if (item.type === "ws-no-acf") {
          const res = await deleteOrphanedWorkshop((item.orphan as OrphanWorkshopNoAcf).workshop_path);
          if (!res.success) errors.push(res.error ?? item.orphan.appid);
        } else if (item.type === "acf-no-workshop") {
          const res = await deleteOrphanedWorkshopAcf((item.orphan as OrphanAcfNoWorkshop).acf_path);
          if (!res.success) errors.push(res.error ?? item.orphan.appid);
        }
      } catch (e: any) {
        errors.push(String(e));
      }
    }
    const count = selectedOrphanList.length;
    if (errors.length === 0) {
      toaster.toast({ title: "Cleaned up", body: `${count} orphaned ${count === 1 ? "entry" : "entries"} removed` });
    } else {
      toaster.toast({ title: "Cleanup errors", body: errors[0] });
    }
    setSelectedOrphans(new Set());
    // Re-scan cache orphans (per-drive) if any were cleaned
    const affectedCacheDrives = new Set(
      selectedOrphanList
        .filter((i) => i.type === "cache-sc" || i.type === "cache-cd" || i.type === "ns-sc" || i.type === "ns-cd")
        .map((i) => (i.orphan as OrphanCache).library_path)
    );
    for (const drivePath of affectedCacheDrives) {
      setCacheOrphansLoading((s) => new Set(s).add(drivePath));
      getOrphanedCaches(drivePath)
        .then((result) => {
          setCacheOrphans((s) => ({ ...s, [drivePath]: result.caches }));
          setNonsteamCaches((s) => ({ ...s, [drivePath]: result.nonsteam_caches ?? [] }));
        })
        .catch(() => {
          setCacheOrphans((s) => ({ ...s, [drivePath]: [] }));
          setNonsteamCaches((s) => ({ ...s, [drivePath]: [] }));
        })
        .finally(() => setCacheOrphansLoading((s) => { const n = new Set(s); n.delete(drivePath); return n; }));
    }
    // Re-scan affected drives (acf, folder, ws-no-acf all require a drive re-scan)
    const affectedDrives = new Set(
      selectedOrphanList
        .filter((i) => i.type === "acf")
        .map((i) => (i as any).libraryPath as string)
    );
    for (const item of selectedOrphanList) {
      if (item.type === "folder" || item.type === "ws-no-acf") {
        for (const drivePath of Object.keys(orphanData)) affectedDrives.add(drivePath);
      }
    }
    for (const drivePath of affectedDrives) {
      setOrphanLoading((s) => new Set(s).add(drivePath));
      getOrphanedEntries(drivePath)
        .then((result) => {
          setOrphanData((s) => ({ ...s, [drivePath]: result }));
          const wsAppids = (result.workshop_no_acf ?? []).map((o) => o.appid);
          const acfAppids = (result.acf_no_workshop ?? []).map((o) => o.appid);
          const acfNoFolderAppids = (result.acf_no_folder ?? []).map((o) => o.appid);
          resolveOrphanNames([...wsAppids, ...acfAppids, ...acfNoFolderAppids]);
        })
        .catch(() => {})
        .finally(() => setOrphanLoading((s) => { const n = new Set(s); n.delete(drivePath); return n; }));
    }
  }, [selectedOrphanList, orphanData]);

  const confirmOrphanCleanup = () => {
    if (selectedOrphanList.length === 0) return;
    const count = selectedOrphanList.length;
    const sizeStr = totalOrphanSize > 0 ? ` (~${formatSize(totalOrphanSize)})` : "";
    showModal(
      <ConfirmModal
        strTitle="Clean Up?"
        strDescription={`Remove ${count} ${count === 1 ? "entry" : "entries"}${sizeStr}? This cannot be undone.`}
        strOKButtonText="Clean Up"
        strCancelButtonText="Cancel"
        onOK={doOrphanCleanup}
      />,
      window
    );
  };

  // ── Derived state ───────────────────────────────────────────────────────────

  const selectedCount = selected.size;
  const canCopy = selectedCount > 0 && drives.length >= 2;
  const canUninstall =
    selectedCount > 0 &&
    (uninstallOpts.files || uninstallOpts.compatdata || uninstallOpts.shadercache || uninstallOpts.workshop);
  const canCleanup = selectedOrphanList.length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <ModalRoot onCancel={handleCancel}>
      <Focusable
        style={{
          padding: "16px 20px",
          width: "460px",
          maxHeight: "80vh",
          overflow: "auto",
          margin: "0 auto",
          boxSizing: "border-box",
        }}
        onCancel={handleCancel}
        noFocusRing={false}
      >
        <style>{`
          .cdeck-game-sel { background: rgba(76,110,245,0.18) !important; outline: 2px solid #4c6ef5; }
          .cdeck-orphan-sel { background: rgba(250,82,82,0.15) !important; outline: 2px solid #fa5252; }
          .cdeck-row:focus { outline: 2px solid rgba(76,110,245,0.5); border-radius: 4px; }
          .cdeck-btn-uninstall:focus {
            outline: 3px solid #ff6b6b !important;
            box-shadow: 0 0 0 2px rgba(192,57,43,0.5) !important;
          }
          .cdeck-btn-copy:focus { outline: 3px solid #74c0fc !important; }
          .cdeck-btn-cleanup:focus {
            outline: 3px solid #ffcc80 !important;
            box-shadow: 0 0 0 2px rgba(230,81,0,0.6) !important;
          }
        `}</style>

        {/* ── Action buttons ── */}
        <Focusable flow-children="right" style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <DialogButton
            className="cdeck-btn-copy"
            onClick={showDrivePicker}
            disabled={!canCopy}
            style={{ flex: 1 }}
          >
            Copy to Drive{selectedCount > 0 ? ` (${selectedCount})` : ""}
          </DialogButton>
          <DialogButton
            className="cdeck-btn-uninstall"
            onClick={confirmUninstall}
            disabled={!canUninstall}
            style={{
              flex: 1,
              background: canUninstall ? "#8b1a1a" : undefined,
              color: canUninstall ? "#ffcdd2" : undefined,
              border: canUninstall ? "1px solid #c0392b" : undefined,
            }}
          >
            Uninstall
            {selectedCount > 0
              ? ` (${selectedCount}${totalUninstallSize > 0 ? ` · ~${formatSize(totalUninstallSize)}` : ""})`
              : ""}
          </DialogButton>
        </Focusable>

        {/* ── Sort button ── */}
        <div style={{ marginBottom: 10 }}>
          <Focusable>
            <DialogButton
              onClick={() => showContextMenu(
                <Menu label="Sort by" cancelText="Back">
                  {(["alpha", "size", "appid", "compatdata", "workshop"] as const).map((mode) => {
                    const labels: Record<string, string> = {
                      alpha: "Alphabetically",
                      size: "Size",
                      appid: "App ID",
                      compatdata: "Compatdata",
                      workshop: "Workshop",
                    };
                    return (
                      <MenuItem key={mode} onSelected={() => setSortMode(mode)}>
                        {sortMode === mode ? "✓ " : "   "}{labels[mode]}
                      </MenuItem>
                    );
                  })}
                </Menu>,
                window
              )}
              style={{ width: "100%", fontSize: 12 }}
            >
              Sort by: {sortMode === "alpha" ? "Alphabetically" : sortMode === "size" ? "Size" : sortMode === "appid" ? "App ID" : sortMode === "compatdata" ? "Compatdata" : "Workshop"}
            </DialogButton>
          </Focusable>
        </div>

        {/* ── Orphan cleanup button — only shown when orphans are selected ── */}
        {canCleanup && (
          <div style={{ marginBottom: 10 }}>
            <Focusable>
              <DialogButton
                className="cdeck-btn-cleanup"
                onClick={confirmOrphanCleanup}
                style={{
                  width: "100%",
                  background: "#5a0000",
                  color: "#ffcdd2",
                  border: "1px solid #fa5252",
                }}
              >
                Clean Up ({selectedOrphanList.length}
                {totalOrphanSize > 0 ? ` · ~${formatSize(totalOrphanSize)}` : ""})
              </DialogButton>
            </Focusable>
          </div>
        )}

        {/* ── Search ── */}
        <PanelSectionRow>
          <Focusable style={{ marginBottom: 8 }}>
            <TextField
              label="Search games"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </Focusable>
        </PanelSectionRow>

        <div style={{ fontSize: 11, color: "#666", marginBottom: 8, textAlign: "center" }}>
          A = select · B = collapse / close
        </div>

        {/* ── Drive + game list ── */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#888",
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Drives
        </div>

        {sortedDrives.map((drive, driveIndex) => {
          const isExpanded = expandedStack.includes(driveIndex);
          const driveGames = gamesByDrive[drive.path] || [];
          const filteredGames = filteredGamesByDrive[drive.path] || [];
          const orphans = orphanData[drive.path];
          const orphanIsLoading = orphanLoading.has(drive.path);
          const orphanIsExpanded = orphanExpanded.has(drive.path);
          const driveCacheOrphans = cacheOrphans[drive.path] ?? [];
          const driveNonsteamCaches = nonsteamCaches[drive.path] ?? [];
          const cacheOrphanRowCount = driveCacheOrphans.reduce(
            (n, o) => n + (o.has_shadercache ? 1 : 0) + (o.has_compatdata ? 1 : 0), 0
          );
          const nonsteamIsExpanded = nonsteamExpanded.has(drive.path);
          const nonsteamScCount = driveNonsteamCaches.filter(o => o.has_shadercache).length;
          const nonsteamCdCount = driveNonsteamCaches.filter(o => o.has_compatdata).length;
          const wsNoAcfCount = orphans ? (orphans.workshop_no_acf ?? []).length : 0;
          const acfNoWorkshopCount = orphans ? (orphans.acf_no_workshop ?? []).length : 0;
          const totalOrphans = (orphans
            ? orphans.acf_no_folder.length + orphans.folder_no_acf.length
            : 0) + cacheOrphanRowCount + wsNoAcfCount + acfNoWorkshopCount;
          return (
            <div key={drive.path} style={{ marginBottom: 4 }}>
              {/* Drive header */}
              <Focusable
                className="cdeck-row"
                onActivate={() => toggleDrive(driveIndex)}
                onCancel={handleCancel}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "8px 12px",
                  width: "100%",
                  boxSizing: "border-box",
                  backgroundColor: "rgba(255,255,255,0.08)",
                  borderRadius: 4,
                  marginBottom: 4,
                }}
                noFocusRing={false}
              >
                <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#aaa" }}>
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span style={{ flex: 1, fontWeight: 500 }}>{drive.label}</span>
                <span style={{ flexShrink: 0, fontSize: 11, color: "#888" }}>
                  {formatStorageGb(drive.free_gb)} free
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, color: "#666", marginLeft: 8 }}>
                  {searchLower
                    ? `${filteredGames.length}/${driveGames.length}`
                    : driveGames.length}{" "}
                  games
                </span>
              </Focusable>

              {/* Game rows */}
              {isExpanded && (
                <div
                  style={{
                    paddingLeft: 8,
                    paddingBottom: 6,
                    borderLeft: "2px solid rgba(255,255,255,0.06)",
                    marginLeft: 8,
                  }}
                >
                  {/* ── Orphaned entries section ── */}
                  <Focusable
                    className="cdeck-row"
                    onActivate={() => toggleOrphanSection(drive.path)}
                    onCancel={handleCancel}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "7px 12px",
                      marginBottom: 6,
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid rgba(230,81,0,0.35)",
                      borderRadius: 4,
                    }}
                    noFocusRing={false}
                  >
                    <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>
                      {orphanIsExpanded ? "▼" : "▶"}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>
                      {orphanIsLoading
                        ? "Scanning orphaned entries..."
                        : orphans
                        ? `Orphaned Steam Entries (${totalOrphans})`
                        : "Scan Orphaned Steam Entries"}
                    </span>
                    {orphans && totalOrphans > 0 && (
                      <span style={{ fontSize: 11, color: "#e65100" }}>⚠</span>
                    )}
                  </Focusable>

                  {/* Orphan rows */}
                  {orphanIsExpanded && !orphanIsLoading && orphans && (
                    <div style={{ paddingLeft: 8, marginLeft: 4, marginBottom: 6, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>
                      {totalOrphans === 0 ? (
                        <div style={{ fontSize: 12, color: "#666", padding: "6px 12px" }}>
                          No orphaned entries found.
                        </div>
                      ) : (
                        <>
                          {/* ── Orphaned Compatdata dropdown (per drive) ── */}
                          {(() => {
                            const cdOrphans = driveCacheOrphans.filter(o => o.has_compatdata);
                            const totalCdSize = cdOrphans.reduce((n, o) => n + o.compatdata_size, 0);
                            if (cacheOrphansLoading.has(drive.path) || cdOrphans.length === 0) return null;
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={() => setCacheCdExpanded(v => !v)}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(230,81,0,0.4)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>{cacheCdExpanded ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>Orphaned Compatdata ({cdOrphans.length})</span>
                                  <span style={{ fontSize: 11, color: "#e65100" }}>{formatSize(totalCdSize)}</span>
                                </Focusable>
                                {cacheCdExpanded && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>
                                    {cdOrphans.map((o) => {
                                      const key = cacheCdKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      const displayName = orphanNames[o.appid] ?? `App ${o.appid}`;
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => toggleOrphanCacheCd(o)}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{displayName}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.compatdata_size)}</span>
                                        </Focusable>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* ── Orphaned Shader Cache dropdown (per drive) ── */}
                          {(() => {
                            const scOrphans = driveCacheOrphans.filter(o => o.has_shadercache);
                            const totalScSize = scOrphans.reduce((n, o) => n + o.shadercache_size, 0);
                            if (cacheOrphansLoading.has(drive.path)) return (
                              <div style={{ fontSize: 11, color: "#888", padding: "5px 12px" }}>Scanning caches...</div>
                            );
                            if (scOrphans.length === 0) return null;
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={() => setCacheScExpanded(v => !v)}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(230,81,0,0.4)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>{cacheScExpanded ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>Orphaned Shader Cache ({scOrphans.length})</span>
                                  <span style={{ fontSize: 11, color: "#e65100" }}>{formatSize(totalScSize)}</span>
                                </Focusable>
                                {cacheScExpanded && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>
                                    {scOrphans.map((o) => {
                                      const key = cacheScKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      const displayName = orphanNames[o.appid] ?? `App ${o.appid}`;
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => toggleOrphanCacheSc(o)}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{displayName}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.shadercache_size)}</span>
                                        </Focusable>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* ── Orphaned Workshop dropdown ── */}
                          {(() => {
                            const wsNoAcfItems = orphans.workshop_no_acf ?? [];
                            const acfNoWsItems = orphans.acf_no_workshop ?? [];
                            const totalWsSize = wsNoAcfItems.reduce((n, o) => n + o.workshop_size, 0);
                            const totalCount = wsNoAcfItems.length + acfNoWsItems.length;
                            if (totalCount === 0) return null;
                            const isExp = workshopOrphanExpanded.has(drive.path);
                            const toggleWs = () => setWorkshopOrphanExpanded(prev => {
                              const next = new Set(prev);
                              if (next.has(drive.path)) next.delete(drive.path); else next.add(drive.path);
                              return next;
                            });

                            // Split ws-no-acf by whether the game is installed
                            const noGameWsItems = wsNoAcfItems.filter(o => !o.game_installed);
                            const gameInstalledWsItems = wsNoAcfItems.filter(o => o.game_installed);

                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={toggleWs}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(230,81,0,0.4)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>{isExp ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>Orphaned Workshop ({totalCount})</span>
                                  {totalWsSize > 0 && <span style={{ fontSize: 11, color: "#e65100" }}>{formatSize(totalWsSize)}</span>}
                                </Focusable>
                                {isExp && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>

                                    {/* ── No Game Installed, Workshop Content Exists ── */}
                                    <div style={{ fontSize: 10, color: "#e65100", padding: "4px 8px 2px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                      — No Game Installed, Workshop Content Exists
                                    </div>
                                    {noGameWsItems.length === 0 ? (
                                      <div style={{ fontSize: 11, color: "#666", padding: "4px 12px 6px" }}>None</div>
                                    ) : noGameWsItems.map((o) => {
                                      const key = wsNoAcfKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => toggleOrphanWsNoAcf(o)}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{orphanNames[o.appid] ?? `App ${o.appid}`}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.workshop_size)}</span>
                                        </Focusable>
                                      );
                                    })}

                                    {/* ── Workshop Content, No ACF (game is installed) ── */}
                                    <div style={{ fontSize: 10, color: "#888", padding: "8px 8px 2px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                      — Workshop Content, No ACF
                                    </div>
                                    {gameInstalledWsItems.length === 0 ? (
                                      <div style={{ fontSize: 11, color: "#666", padding: "4px 12px 6px" }}>None</div>
                                    ) : gameInstalledWsItems.map((o) => {
                                      const key = wsNoAcfKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => toggleOrphanWsNoAcf(o)}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{orphanNames[o.appid] ?? `App ${o.appid}`}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.workshop_size)}</span>
                                        </Focusable>
                                      );
                                    })}

                                    {/* ── ACF, No Workshop Content ── */}
                                    <div style={{ fontSize: 10, color: "#888", padding: "8px 8px 2px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                      — ACF, No Workshop Content
                                    </div>
                                    {acfNoWsItems.length === 0 ? (
                                      <div style={{ fontSize: 11, color: "#666", padding: "4px 12px 6px" }}>None</div>
                                    ) : acfNoWsItems.map((o) => {
                                      const key = acfNoWorkshopKey(o, drive.path);
                                      const isSel = selectedOrphans.has(key);
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => toggleOrphanAcfNoWorkshop(o, drive.path)}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{orphanNames[o.appid] ?? `App ${o.appid}`}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#888" }}>
                                            {o.game_installed ? "ACF only" : "No game install"}
                                          </span>
                                        </Focusable>
                                      );
                                    })}

                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {/* ACF no folder */}
                          {orphans.acf_no_folder.length > 0 && (() => {
                            const isExp = acfNoFolderExpanded.has(drive.path);
                            const toggle = () => setAcfNoFolderExpanded(prev => {
                              const next = new Set(prev);
                              if (next.has(drive.path)) next.delete(drive.path); else next.add(drive.path);
                              return next;
                            });
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={toggle}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(230,81,0,0.4)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>{isExp ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>Manifest present, no game folder ({orphans.acf_no_folder.length})</span>
                                </Focusable>
                                {isExp && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>
                                    {orphans.acf_no_folder.map((o) => {
                                const key = acfOrphanKey(o, drive.path);
                                const isSel = selectedOrphans.has(key);
                                const sz = orphanSizes[key];
                                const sizesData = gameSizes[o.appid];
                                return (
                                  <Focusable
                                    key={key}
                                    className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                    onActivate={() => toggleOrphanAcf(o, drive.path)}
                                    onCancel={handleCancel}
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      alignItems: "stretch",
                                      padding: "7px 12px",
                                      width: "100%",
                                      boxSizing: "border-box",
                                      
                                      borderRadius: 4,
                                      marginBottom: 2,
                                    }}
                                    noFocusRing={false}
                                  >
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                      <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>
                                        {isSel ? "☑" : "☐"}
                                      </span>
                                      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{o.name}</div>
                                        <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                      </div>
                                      <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>
                                        no game folder
                                      </span>
                                    </div>
                                    {isSel && (
                                      <div style={{ marginTop: 5, marginLeft: 26, padding: "5px 8px", background: "rgba(0,0,0,0.25)", borderRadius: 4 }}>
                                        {sz?.loading ? (
                                          <div style={{ fontSize: 11, color: "#666" }}>Loading sizes...</div>
                                        ) : sizesData ? (
                                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                            <SizeRow label="Game files" bytes={0} redZero />
                                            <SizeRow label="Compatdata" bytes={sizesData.compatdata_size} />
                                            <SizeRow label="Shader cache" bytes={sizesData.shadercache_size} />
                                            <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>
                                              Cleanup will delete: manifest{sizesData.compatdata_size > 0 ? ", compatdata" : ""}{sizesData.shadercache_size > 0 ? ", shader cache" : ""}
                                            </div>
                                          </div>
                                        ) : (
                                          <div style={{ fontSize: 11, color: "#666" }}>Loading...</div>
                                        )}
                                      </div>
                                    )}
                                  </Focusable>
                                );
                              })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Folder no ACF */}
                          {orphans.folder_no_acf.length > 0 && (() => {
                            const isExp = folderNoAcfExpanded.has(drive.path);
                            const toggle = () => setFolderNoAcfExpanded(prev => {
                              const next = new Set(prev);
                              if (next.has(drive.path)) next.delete(drive.path); else next.add(drive.path);
                              return next;
                            });
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={toggle}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(230,81,0,0.4)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#e65100" }}>{isExp ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#ffcc80" }}>Game folder present, no manifest ({orphans.folder_no_acf.length})</span>
                                </Focusable>
                                {isExp && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(230,81,0,0.2)" }}>
                                    {orphans.folder_no_acf.map((o) => {
                                const key = folderOrphanKey(o);
                                const isSel = selectedOrphans.has(key);
                                const sz = orphanSizes[key];
                                return (
                                  <Focusable
                                    key={key}
                                    className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                    onActivate={() => toggleOrphanFolder(o)}
                                    onCancel={handleCancel}
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      alignItems: "stretch",
                                      padding: "7px 12px",
                                      width: "100%",
                                      boxSizing: "border-box",
                                      
                                      borderRadius: 4,
                                      marginBottom: 2,
                                    }}
                                    noFocusRing={false}
                                  >
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                      <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>
                                        {isSel ? "☑" : "☐"}
                                      </span>
                                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                                        {o.name}
                                      </span>
                                      <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>
                                        {formatSize(o.size_bytes)}
                                      </span>
                                    </div>
                                    {isSel && (
                                      <div style={{ marginTop: 5, marginLeft: 26, padding: "5px 8px", background: "rgba(0,0,0,0.25)", borderRadius: 4 }}>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                          <SizeRow label="Game folder" bytes={o.size_bytes} />
                                          <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>
                                            No manifest — cleanup will delete the folder only.
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </Focusable>
                                );
                              })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        </>
                      )}
                    </div>
                  )}

                  {/* ── Non-Steam Entries section ── */}
                  <Focusable
                    className="cdeck-row"
                    onActivate={() => {
                      setNonsteamExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(drive.path)) { next.delete(drive.path); } else { next.add(drive.path); }
                        return next;
                      });
                      // Trigger scan if not yet loaded (same call as orphan scan)
                      if (!(drive.path in cacheOrphans) && !cacheOrphansLoading.has(drive.path)) {
                        setCacheOrphansLoading((s) => new Set(s).add(drive.path));
                        getOrphanedCaches(drive.path)
                          .then((result) => {
                            setCacheOrphans((s) => ({ ...s, [drive.path]: result.caches }));
                            setNonsteamCaches((s) => ({ ...s, [drive.path]: result.nonsteam_caches ?? [] }));
                            resolveOrphanNames([
                              ...result.caches.map((o) => o.appid),
                              ...(result.nonsteam_caches ?? []).map((o) => o.appid),
                            ]);
                          })
                          .catch(() => {
                            setCacheOrphans((s) => ({ ...s, [drive.path]: [] }));
                            setNonsteamCaches((s) => ({ ...s, [drive.path]: [] }));
                          })
                          .finally(() => setCacheOrphansLoading((s) => { const n = new Set(s); n.delete(drive.path); return n; }));
                      }
                    }}
                    onCancel={handleCancel}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "7px 12px",
                      marginBottom: 6, width: "100%", boxSizing: "border-box",
                      border: "1px solid rgba(38,166,91,0.4)",
                      borderRadius: 4,
                    }}
                    noFocusRing={false}
                  >
                    <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#4caf7d" }}>
                      {nonsteamIsExpanded ? "▼" : "▶"}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, color: "#a5d6a7" }}>
                      {cacheOrphansLoading.has(drive.path)
                        ? "Scanning non-Steam entries..."
                        : drive.path in nonsteamCaches
                        ? `Non-Steam Entries (${nonsteamScCount + nonsteamCdCount})`
                        : "Scan Non-Steam Entries"}
                    </span>
                    {(nonsteamScCount + nonsteamCdCount) > 0 && (
                      <span style={{ fontSize: 11, color: "#4caf7d" }}>●</span>
                    )}
                  </Focusable>

                  {nonsteamIsExpanded && !cacheOrphansLoading.has(drive.path) && drive.path in nonsteamCaches && (
                    <div style={{ paddingLeft: 8, marginLeft: 4, marginBottom: 6, borderLeft: "2px solid rgba(38,166,91,0.25)" }}>
                      {(nonsteamScCount + nonsteamCdCount) === 0 ? (
                        <div style={{ fontSize: 12, color: "#666", padding: "6px 12px" }}>No non-Steam entries found.</div>
                      ) : (
                        <>
                          {/* ── Non-Steam Compatdata ── */}
                          {(() => {
                            const nsCdItems = driveNonsteamCaches.filter(o => o.has_compatdata);
                            const totalNsCdSize = nsCdItems.reduce((n, o) => n + o.compatdata_size, 0);
                            if (nsCdItems.length === 0) return null;
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={() => setNonsteamCdExpanded(v => !v)}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(38,166,91,0.35)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#4caf7d" }}>{nonsteamCdExpanded ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#a5d6a7" }}>Compatdata ({nsCdItems.length})</span>
                                  <span style={{ fontSize: 11, color: "#4caf7d" }}>{formatSize(totalNsCdSize)}</span>
                                </Focusable>
                                {nonsteamCdExpanded && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(38,166,91,0.2)" }}>
                                    {nsCdItems.map((o) => {
                                      const key = nonsteamCdKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => {
                                            setSelectedOrphans((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(key)) { next.delete(key); } else {
                                                next.add(key);
                                                setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.compatdata_size, loading: false } }));
                                              }
                                              return next;
                                            });
                                          }}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "#ccc" }}>{orphanNames[o.appid] ?? `App ${o.appid}`}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.compatdata_size)}</span>
                                        </Focusable>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* ── Non-Steam Shader Cache ── */}
                          {(() => {
                            const nsScItems = driveNonsteamCaches.filter(o => o.has_shadercache);
                            const totalNsScSize = nsScItems.reduce((n, o) => n + o.shadercache_size, 0);
                            if (nsScItems.length === 0) return null;
                            return (
                              <div style={{ marginBottom: 2 }}>
                                <Focusable
                                  className="cdeck-row"
                                  onActivate={() => setNonsteamScExpanded(v => !v)}
                                  onCancel={handleCancel}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(38,166,91,0.35)", borderRadius: 4, marginBottom: 2 }}
                                  noFocusRing={false}
                                >
                                  <span style={{ flexShrink: 0, width: 16, fontSize: 10, color: "#4caf7d" }}>{nonsteamScExpanded ? "▼" : "▶"}</span>
                                  <span style={{ flex: 1, fontSize: 12, color: "#a5d6a7" }}>Shader Cache ({nsScItems.length})</span>
                                  <span style={{ fontSize: 11, color: "#4caf7d" }}>{formatSize(totalNsScSize)}</span>
                                </Focusable>
                                {nonsteamScExpanded && (
                                  <div style={{ paddingLeft: 8, marginLeft: 4, borderLeft: "2px solid rgba(38,166,91,0.2)" }}>
                                    {nsScItems.map((o) => {
                                      const key = nonsteamScKey(o);
                                      const isSel = selectedOrphans.has(key);
                                      return (
                                        <Focusable
                                          key={key}
                                          className={`cdeck-row${isSel ? " cdeck-orphan-sel" : ""}`}
                                          onActivate={() => {
                                            setSelectedOrphans((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(key)) { next.delete(key); } else {
                                                next.add(key);
                                                setOrphanSizes((s) => ({ ...s, [key]: { bytes: o.shadercache_size, loading: false } }));
                                              }
                                              return next;
                                            });
                                          }}
                                          onCancel={handleCancel}
                                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", width: "100%", boxSizing: "border-box", borderRadius: 4, marginBottom: 2 }}
                                          noFocusRing={false}
                                        >
                                          <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSel ? "#fa5252" : "#555" }}>{isSel ? "☑" : "☐"}</span>
                                          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "#ccc" }}>{orphanNames[o.appid] ?? `App ${o.appid}`}</div>
                                            <div style={{ fontSize: 10, color: "#555" }}>{o.appid}</div>
                                          </div>
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "#fa5252" }}>{formatSize(o.shadercache_size)}</span>
                                        </Focusable>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  )}

                  {/* ── Separator between orphans and games ── */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      margin: "8px 0 6px",
                    }}
                  >
                    <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
                    <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>
                      Installed games
                    </span>
                    <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
                  </div>

                  {/* Game list */}
                  {filteredGames.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#666", padding: "6px 12px" }}>
                      {driveGames.length === 0 ? "No games on this drive." : "No matching games."}
                    </div>
                  ) : (
                    filteredGames.map((game, idx) => {
                      const isSelected = selected.has(gameKey(game.appid, game.library_path));
                      const sizes = gameSizes[game.appid];
                      const isLoadingSize = loadingSizes.has(game.appid);

                      // Separator between "has" and "does not have" for compatdata/workshop sorts
                      let separator: React.ReactElement | null = null;
                      if (sortMode === "compatdata" || sortMode === "workshop") {
                        const prevGame = filteredGames[idx - 1];
                        const contentSet = sortMode === "compatdata"
                          ? driveCompatdata[drive.path]
                          : driveWorkshop[drive.path];
                        const getFlag = (g: typeof game) => contentSet ? contentSet.has(g.appid) : false;
                        const thisHas = getFlag(game);
                        const prevHas = prevGame ? getFlag(prevGame) : true;
                        if (prevGame && prevHas && !thisHas) {
                          const label = sortMode === "compatdata" ? "End of Compatdata List" : "End of Workshop List";
                          separator = (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", marginBottom: 2 }}>
                              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
                              <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0 }}>
                                — {label} —
                              </span>
                              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
                            </div>
                          );
                        }
                      }
                      return (
                        <React.Fragment key={game.appid}>
                          {separator}
                          <Focusable
                            className={`cdeck-row${isSelected ? " cdeck-game-sel" : ""}`}
                            onActivate={() => toggleGame(game.appid, game.library_path)}
                            onCancel={handleCancel}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "stretch",
                              padding: "8px 12px",
                              width: "100%",
                              boxSizing: "border-box",
                              backgroundColor: "rgba(255,255,255,0.04)",
                              borderRadius: 4,
                              marginBottom: 2,
                              borderBottom: rowBorder,
                            }}
                            noFocusRing={false}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span style={{ flexShrink: 0, width: 16, fontSize: 13, color: isSelected ? "#4c6ef5" : "#555" }}>
                                {isSelected ? "☑" : "☐"}
                              </span>
                              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{game.name}</div>
                                <div style={{ fontSize: 10, color: "#555" }}>{game.appid}</div>
                              </div>
                              <span style={{ flexShrink: 0, fontSize: 11, color: "#888" }}>
                                {formatSize(game.size_bytes)}
                              </span>
                            </div>
                            {isSelected && (
                              <div style={{ marginTop: 5, marginLeft: 26, padding: "5px 8px", background: "rgba(0,0,0,0.25)", borderRadius: 4 }}>
                                {isLoadingSize ? (
                                  <div style={{ fontSize: 11, color: "#666" }}>Loading sizes...</div>
                                ) : sizes ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                    <SizeRow label="Game files" bytes={sizes.game_size + sizes.acf_size} />
                                    {sizes.compatdata_size > 0 && <SizeRow label="Compatdata" bytes={sizes.compatdata_size} />}
                                    {sizes.shadercache_size > 0 && <SizeRow label="Shader cache" bytes={sizes.shadercache_size} />}
                                    {(sizes.workshop_size ?? 0) > 0 && <SizeRow label="Workshop" bytes={sizes.workshop_size} />}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 11, color: "#666" }}>Size info unavailable</div>
                                )}
                              </div>
                            )}
                          </Focusable>
                        </React.Fragment>
                      );
                    })
                  )}

                </div>
              )}
            </div>
          );
        })}
      </Focusable>
    </ModalRoot>
  );
}

function SizeRow({
  label,
  bytes,
  redZero,
}: {
  label: string;
  bytes: number;
  redZero?: boolean;
}) {
  const hasData = bytes > 0;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
      <span style={{ color: "#aaa" }}>{label}</span>
      <span style={{ color: hasData ? "#fa5252" : redZero ? "#fa5252" : "#555" }}>
        {hasData ? formatSize(bytes) : redZero ? "no game folder" : "not found"}
      </span>
    </div>
  );
}
