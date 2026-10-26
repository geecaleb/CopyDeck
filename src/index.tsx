import { definePlugin, staticClasses } from "@decky/ui";
import { routerHook } from "@decky/api";
import { FaCopy } from "react-icons/fa";
import contextMenuPatch, { LibraryContextMenu, _loginUnregisterer } from "./patch";
import { MultiSelectPanel } from "./components/MultiSelectPanel";
import { startJobNotifier, stopJobNotifier } from "./lib/jobNotifier";
import { FileBrowserPage } from "./components/FileBrowserPage";
import { COPYDECK_BROWSER_ROUTE } from "./constants";
import { getTargetHistory, type TargetSnapshot } from "./utils/backendApi";

async function preWarmHistoryCache() {
  // shortcut dirs are loaded by patch.tsx via RegisterForLoginStateChange + WaitForServicesInitialized
  // so we only need to warm the target history cache here
  try {
    // Wait briefly for the dirs cache to be populated by patch.tsx before reading it
    for (let i = 0; i < 20; i++) {
      if ((window as any).__copydeck_shortcut_dirs) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const dirs: Record<string, string> = (window as any).__copydeck_shortcut_dirs ?? {};
    const ids = Object.keys(dirs);
    const entries = await Promise.all(ids.map(async (id) => [id, await getTargetHistory(id)] as [string, TargetSnapshot[]]));
    const cache: Record<string, TargetSnapshot[]> = {};
    for (const [id, hist] of entries) cache[id] = hist;
    (window as any).__copydeck_target_history = cache;
  } catch {}
}

export default definePlugin(() => {
  startJobNotifier();
  preWarmHistoryCache();
  routerHook.addRoute(COPYDECK_BROWSER_ROUTE, FileBrowserPage, { exact: true });

  const menuPatches = LibraryContextMenu
    ? contextMenuPatch(LibraryContextMenu)
    : null;

  return {
    title: <div className={staticClasses.Title}>CopyDeck</div>,
    content: <MultiSelectPanel />,
    icon: <FaCopy />,
    onDismount() {
      stopJobNotifier();
      menuPatches?.unpatch?.();
      routerHook.removeRoute(COPYDECK_BROWSER_ROUTE);
      _loginUnregisterer?.unregister();
    },
  };
});
