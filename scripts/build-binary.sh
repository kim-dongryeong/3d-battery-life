#!/bin/bash
# Build a single self-contained executable (no Node needed at runtime) with Bun.
# Output: dist/battery-life  +  dist/web/  (assets ship alongside the binary).
#   run:  ./dist/battery-life serve     ./dist/battery-life sample
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$DIR/dist"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found."
  echo "  install:  curl -fsSL https://bun.sh/install | bash"
  echo "  (alternatives: 'deno compile' or Node 21+ '--experimental-sea' — see TAURI.md/README)"
  exit 1
fi

# Per-arch: pass 'x64' or 'arm64' to cross-compile (bun cross-compiles fine). NOTE: you can NOT
# lipo two bun --compile binaries into one universal file — bun appends the JS bundle as a trailer
# that `lipo -create` drops, breaking the result. Ship per-arch binaries instead.
case "${1:-host}" in
  x64)   BT=bun-darwin-x64 ;;
  arm64) BT=bun-darwin-arm64 ;;
  *)     BT=bun ;;
esac
rm -rf "$OUT"; mkdir -p "$OUT/data"
echo "▶ compiling bin/cli.js ($BT) → $OUT/battery-life"
bun build "$DIR/bin/cli.js" --compile --minify --target="$BT" --outfile "$OUT/battery-life"
cp -R "$DIR/web" "$OUT/web"     # static viewer assets, read next to the executable

echo
echo "✅ built: $OUT/battery-life"
echo "   ship $OUT/battery-life together with $OUT/web/ (and a data/ dir is created on first run)"
echo "   try:  ($OUT/battery-life demo2 needs Node)  then  $OUT/battery-life serve  →  http://localhost:4317"
