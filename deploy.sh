#!/usr/bin/env bash
# Copy only the Decky plugin files into deploy/CopyDeck so you can
# copy that folder to your Decky plugins directory (e.g. ~/homebrew/plugins/).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/deploy/CopyDeck"

echo "Building frontend..."
cd "$SCRIPT_DIR"
npm run build

echo "Preparing deploy/CopyDeck..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/dist"

cp "$SCRIPT_DIR/plugin.json"   "$OUT_DIR/"
cp "$SCRIPT_DIR/main.py"       "$OUT_DIR/"
cp "$SCRIPT_DIR/package.json"  "$OUT_DIR/"
cp "$SCRIPT_DIR/dist/index.js" "$OUT_DIR/dist/"
cp "$SCRIPT_DIR/dist/index.js.map" "$OUT_DIR/dist/" 2>/dev/null || true

echo "Done. Copy to Decky plugins:"
echo "  cp -r $OUT_DIR ~/homebrew/plugins/"
echo "  (or your Decky plugin path)"
