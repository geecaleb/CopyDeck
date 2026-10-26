# CopyDeck

A Decky Loader plugin for the Steam Deck that copies games and non-Steam titles between drives — instead of Valve's move-only option.

## Features

### Steam Games

- **Copy via context menu** — Focus any installed game, press **Start → Copy To... →** pick a destination drive. The full game folder and `appmanifest_<AppID>.acf` are copied so Steam sees it on the destination when mounted.
- **Bulk copy from the Quick Access panel** — Open CopyDeck from the Quick Access Menu, select multiple games, press **Copy selected to...**, and choose a drive. Everything runs in a background queue with per-job progress bars.
- **Optional extras per copy** — Choose to also copy Workshop content, Proton compatdata (saves / prefix), and shader cache alongside the game files.
- **Conflict handling** — If files already exist at the destination you get a prompt to skip duplicates or overwrite all.
- **Duplicate installs supported** — Having the same game on two drives at once works fine; just avoid mounting both simultaneously if you want to avoid Steam's update manager seeing two installs.

### Non-Steam & Lutris Games

- **Copy non-Steam shortcuts** — Copy the game folder of any non-Steam shortcut to a configurable destination path, with optional compatdata copying.
- **Set target path** — After copying, CopyDeck can automatically (or on demand) update the shortcut's Exe and Start Dir fields to point at the new location, so you can launch from the copied drive without editing anything manually.
- **Target history** — CopyDeck remembers up to 6 previous copy destinations per game. One tap swaps the shortcut back and forth between locations.
- **Lutris support** — Detects Lutris-managed shortcuts and updates the Lutris `pga.db` database and per-game YAML config when you set a new target path, keeping Lutris in sync automatically.
- **ROM detection** — Configurable scan depth for ROM-based non-Steam shortcuts.

### File Browser

- **Built-in file browser** — Browse any mounted drive from inside the plugin panel. Supports copy, move, rename, delete, create folder/file, and symlink creation.
- **Archive support** — Extract and compress files as `.tar.gz` or `.zip` directly from the browser.
- **Multi-tab browsing** — Each mounted drive gets its own tab; add custom tabs pinned to any path. Tabs are persistent across sessions.
- **PDF preview** — Render PDF pages inline for a quick look without leaving Game Mode.

### Queue & Progress

- Real-time progress bars with speed readout (B/s → GB/s) and bytes transferred.
- Pause, resume, or cancel individual jobs or entire groups.
- Option to remove partial files on cancel.
- Completed jobs stay visible until manually cleared.

### Drive Tools

- **Drive info** — See free/total space per drive in the selector.
- **Eject drives** — Safely unmount a drive from the plugin panel.
- **Orphan scanner** — Find and clean up leftover ACF manifests, game folders without manifests, orphaned compatdata, shader caches, and workshop content.

### Uninstall

Uninstall games (or batch-uninstall selected games) with granular control: delete game files, ACF, compatdata, shader cache, and/or workshop content independently.

## Install

### Option A — Install as ZIP (manual)

1. On your Steam Deck, go to **Settings → System** and enable **Developer Mode**.
2. Open **Decky Loader → Settings** and enable **Allow installation from ZIP files**.
3. Download **CopyDeck.zip** from the latest [GitHub Release](https://github.com/geecaleb/CopyDeck/releases/latest).
4. In Decky, choose **Install from ZIP** and select the downloaded file.

### Option C — Extract manually

1. Download **CopyDeck.zip** from the latest [GitHub Release](https://github.com/geecaleb/CopyDeck/releases/latest).
2. Extract it so you have `~/homebrew/plugins/CopyDeck/` (with `main.py`, `plugin.json`, and `dist/` inside).
3. Restart Decky Loader or reload plugins.

## Build from source

```bash
npm install
bash deploy.sh
# then:
cp -r deploy/CopyDeck ~/homebrew/plugins/
```

## Requirements

- Steam Deck running SteamOS with Decky Loader installed.
- At least two Steam library locations (e.g. internal storage + SD card or external USB drive).

## Usage Tips

- **Non-Steam target path** — In the plugin settings you can configure a default destination subfolder for non-Steam copies (e.g. `Games/NonSteam`). Each drive gets a configurable slot so copies land exactly where you want them.
- **Lutris prefix destination** — Set a separate destination path for Lutris Wine prefixes so your saves and prefix don't end up inside the game folder.
- **Auto set target** — Enable "Auto set target" in settings to have CopyDeck automatically update a non-Steam shortcut's launch paths right after a copy completes, with no extra steps.
- **Context menu toggles** — Each entry in the game context menu (Copy, Uninstall, Browse, Set Target) can be individually shown or hidden from the CopyDeck settings panel.

## License

MIT
