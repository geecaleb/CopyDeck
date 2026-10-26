# CopyDeck

Decky Loader plugin to **copy** Steam games between drives (instead of Valve’s move-only).

- **Game context menu:** Focus a game → press **Start** → **Copy To...** → choose destination drive.
- **Plugin panel:** Open CopyDeck from the Quick Access menu → select multiple games → **Copy selected to...** → choose drive.

Copy is full folder + `appmanifest_<AppID>.acf`. Steam will see the copy when that drive is mounted. Having the same game on two drives at once is supported; avoid mounting both at the same time if you want to avoid Steam’s update manager seeing two installs.

## Install (release zip)

1. Download **CopyDeck.zip** from the latest [GitHub Release](https://github.com/geecaleb/CopyDeck/releases/latest).
2. Extract it into your Decky plugins folder so you have `~/homebrew/plugins/CopyDeck/` (with `main.py`, `plugin.json`, and `dist/` inside).
3. Restart Decky Loader or reload plugins.

## Build from source

```bash
npm install
bash deploy.sh
# then: cp -r deploy/CopyDeck ~/homebrew/plugins/
```

## Requirements

- SteamOS / Steam Deck with Decky Loader.
- At least two Steam library locations (e.g. internal + SD card).
