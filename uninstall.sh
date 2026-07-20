#!/bin/bash
# Stop background battery recording. Your collected data is left intact.
# Thin wrapper around `joule record off`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "error: node not found on PATH"; exit 1; }
exec "$NODE" "$DIR/bin/cli.js" record off
