#!/bin/bash
# Installs the launchd agent that samples the battery every 60s, forever.
# Re-running is safe (it reloads). No sudo needed — runs as your user.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
LABEL="com.kdr.3d-battery-life.sampler"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -z "$NODE" ] && { echo "error: node not found on PATH"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
# '#' delimiter so paths containing '|' don't break sed
sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" "$DIR/launchd/$LABEL.plist" > "$DEST"

# modern bootout/bootstrap, falling back to load/unload on older macOS
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST" 2>/dev/null || launchctl load "$DEST"

echo "✅ installed: $LABEL"
echo "   node:    $NODE"
echo "   samples: $DIR/data/samples.jsonl  (every 60s)"
echo "   logs:    $DIR/data/sampler.log"
echo
echo "View it:   cd \"$DIR\" && node server.js   →  http://localhost:4317"
echo "Stop it:   ./uninstall.sh"
