#!/bin/bash
# Build the macOS menu-bar app end-to-end: single binary → sidecar → Tauri .app/.dmg.
# Prereqs: bun, Rust (rustup), tauri-cli (npm i -g @tauri-apps/cli@^2), and icons generated once.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found — $2"; exit 1; }; }
need bun   "install: brew install bun"
need cargo "install Rust: https://rustup.rs"
need tauri "install: npm i -g @tauri-apps/cli@^2"

TRIPLE="$(rustc -Vv | sed -n 's/host: //p')"

echo "▶ 1/3  single binary (Bun)"
bash "$DIR/scripts/build-binary.sh"

echo "▶ 2/3  sidecar → src-tauri/binaries/battery-life-$TRIPLE"
mkdir -p "$DIR/src-tauri/binaries"
cp "$DIR/dist/battery-life" "$DIR/src-tauri/binaries/battery-life-$TRIPLE"

if [ ! -f "$DIR/src-tauri/icons/icon.icns" ]; then
  echo "  ! icons missing — generate once with a 512px+ PNG:  (cd src-tauri && tauri icon /path/to/icon.png)"
fi

echo "▶ 3/3  Tauri bundle"
( cd "$DIR" && tauri build )

echo "✅ done → src-tauri/target/release/bundle/  (macos/*.app, dmg/*.dmg)"
