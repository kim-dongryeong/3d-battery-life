#!/bin/bash
# Build the macOS menu-bar app → per-arch .app/.dmg (Apple Silicon AND Intel).
# We build SEPARATE per-arch bundles (not universal): bun --compile binaries can't be lipo'd into a
# universal file (the appended JS trailer is dropped), so a universal app would ship a broken sidecar.
# Prereqs: bun, Rust + `rustup target add x86_64-apple-darwin aarch64-apple-darwin`, tauri-cli, icons.
#   ./build-app.sh            → both arches (two .dmgs)
#   ./build-app.sh --native   → host arch only (fast, dev)
#   ./build-app.sh --arm64 | --x86_64
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-both}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found — $2"; exit 1; }; }
need bun "brew install bun"; need cargo "https://rustup.rs"; need tauri "npm i -g @tauri-apps/cli@^2"
BINDIR="$DIR/src-tauri/binaries"; mkdir -p "$BINDIR"
[ -f "$DIR/src-tauri/icons/icon.icns" ] || echo "  ! icons missing — (cd src-tauri && tauri icon /path/to/icon.png)"

build_one() { # <triple> <bun-target>
  local triple="$1" bt="$2"
  echo "▶ [$triple] sidecar"
  bun build "$DIR/bin/cli.js" --compile --minify --target="$bt" --outfile "$BINDIR/joule-$triple"
  chmod +x "$BINDIR/joule-$triple"
  echo "▶ [$triple] smcd (앱 없이도 SMC 발행·분당 기록 유지하는 상주 데몬)"
  ( cd "$DIR/native/smcd" && cargo build --release --target "$triple" )
  cp "$DIR/native/smcd/target/$triple/release/joule-smcd" "$BINDIR/joule-smcd-$triple"
  chmod +x "$BINDIR/joule-smcd-$triple"
  echo "▶ [$triple] Tauri bundle"
  ( cd "$DIR" && tauri build --target "$triple" )
  echo "✅ [$triple] → src-tauri/target/$triple/release/bundle/"
}

case "$MODE" in
  --native) t="$(rustc -Vv | sed -n 's/host: //p')"; [ "${t%%-*}" = x86_64 ] && b=bun-darwin-x64 || b=bun-darwin-arm64; build_one "$t" "$b" ;;
  --arm64)  build_one aarch64-apple-darwin bun-darwin-arm64 ;;
  --x86_64) build_one x86_64-apple-darwin  bun-darwin-x64 ;;
  both|*)   build_one aarch64-apple-darwin bun-darwin-arm64; build_one x86_64-apple-darwin bun-darwin-x64
            echo "✅ both: Apple Silicon .dmg + Intel .dmg (distribute the matching one, or both)" ;;
esac
