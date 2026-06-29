#!/bin/bash
# Stops and removes the background sampler. Your collected data is left intact.
set -euo pipefail
LABEL="com.kdr.3d-battery-life.sampler"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "🛑 removed $LABEL (data/ kept)"
