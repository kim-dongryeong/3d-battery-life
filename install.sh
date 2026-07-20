#!/bin/bash
# Start background battery recording (launchd, every 60s, auto-starts at login).
# Thin wrapper around `joule record on` so all the logic lives in one place.
# Re-running is safe. No sudo needed. Optional interval: ./install.sh <seconds>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "error: node not found on PATH"; exit 1; }
exec "$NODE" "$DIR/bin/cli.js" record on "$@"
