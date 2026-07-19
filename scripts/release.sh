#!/bin/bash
# Joule 릴리스 파이프라인 — 빌드(양 아키) → Developer ID 서명 → DMG 공증+staple
# → 업데이터 아티팩트(.app.tar.gz + .sig) → latest.json → GitHub 릴리스.
# 사용자 앱의 tauri-plugin-updater가 releases/latest/download/latest.json을 구독해
# 자동 업데이트한다 (Sparkle appcast에 해당).
#
#   ./scripts/release.sh 0.2.0
#
# 선행 조건(머신 1회): Developer ID 인증서, notarytool 프로필 "AC_PASSWORD",
#   ~/.tauri/joule.key (tauri signer generate), gh auth.
# 참고: ~/notes/brain/ "macOS 앱 자동 업데이트 배포 파이프라인 구축 매뉴얼" —
#   릴리스 게이트("DMG 마운트→복사→복사본 실행")와 버그 카탈로그는 그대로 유효.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="${1:?usage: release.sh <version e.g. 0.2.0>}"
REPO="kim-dongryeong/3d-battery-life"
SIGN_ID="Developer ID Application: Dongryeong Kim (58V5P2LQ68)"
KEY="$HOME/.tauri/joule.key"
[ -f "$KEY" ] || { echo "error: $KEY 없음 (tauri signer generate)"; exit 1; }

# 1) 버전 범프 — updater는 tauri.conf.json version vs latest.json version의 semver 비교로만 판단
node -e "
  const fs=require('fs'), p='$DIR/src-tauri/tauri.conf.json';
  const c=JSON.parse(fs.readFileSync(p,'utf8')); c.version='$VER';
  fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
  const pk='$DIR/package.json', k=JSON.parse(fs.readFileSync(pk,'utf8')); k.version='$VER';
  fs.writeFileSync(pk, JSON.stringify(k,null,2)+'\n');
"
# Cargo.toml도 동기화(표시용)
sed -i '' "s/^version = \".*\"/version = \"$VER\"/" "$DIR/src-tauri/Cargo.toml"
echo "▶ version → $VER"

# 2) 서명+업데이터 아티팩트 포함 빌드 (양 아키). APPLE_SIGNING_IDENTITY → codesign,
#    TAURI_SIGNING_PRIVATE_KEY_PATH → .app.tar.gz의 EdDSA .sig 생성
export APPLE_SIGNING_IDENTITY="$SIGN_ID"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"   # (_PATH 변수는 이 CLI 버전이 무시함 — 실측)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
bash "$DIR/scripts/build-app.sh"

OUT="$DIR/dist/release-$VER"; rm -rf "$OUT"; mkdir -p "$OUT"
declare -a NOTES_SHA=()
for ARCH in aarch64 x86_64; do
  B="$DIR/src-tauri/target/$ARCH-apple-darwin/release/bundle"
  DMG="$(ls "$B"/dmg/Joule_"$VER"_*.dmg)"
  TGZ="$(ls "$B"/macos/Joule.app.tar.gz)"
  SIG="$(ls "$B"/macos/Joule.app.tar.gz.sig)"
  # 3) DMG 공증 + staple (업데이트 tar.gz는 앱이 직접 받아 quarantine이 없으므로 공증 불필요)
  echo "▶ [$ARCH] notarize"
  xcrun notarytool submit "$DMG" --keychain-profile "AC_PASSWORD" --wait
  xcrun stapler staple "$DMG"
  # 4) 검증 게이트 — spctl + staple 확인 (하나라도 실패 시 중단: set -e)
  MNT="/tmp/joule-rel-$ARCH"; hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
  spctl --assess --type execute -vv "$MNT/Joule.app" 2>&1 | grep -q "accepted" || { echo "❌ spctl 거부"; hdiutil detach "$MNT"; exit 1; }
  hdiutil detach "$MNT" >/dev/null
  xcrun stapler validate "$DMG" >/dev/null
  cp "$DMG" "$OUT/Joule_${VER}_${ARCH}.dmg"
  cp "$TGZ" "$OUT/Joule_${VER}_${ARCH}.app.tar.gz"
  cp "$SIG" "$OUT/Joule_${VER}_${ARCH}.app.tar.gz.sig"
  NOTES_SHA+=("$(cd "$OUT" && shasum -a 256 "Joule_${VER}_${ARCH}.dmg")")
done

# 5) latest.json — 업데이트 피드 (appcast 해당). signature = .sig 파일 내용 그대로
node -e "
  const fs=require('fs');
  const out='$OUT', ver='$VER', repo='$REPO';
  const plat={};
  for (const [arch,key] of [['aarch64','darwin-aarch64'],['x86_64','darwin-x86_64']]) {
    plat[key]={
      signature: fs.readFileSync(out+'/Joule_'+ver+'_'+arch+'.app.tar.gz.sig','utf8').trim(),
      url: 'https://github.com/'+repo+'/releases/download/v'+ver+'/Joule_'+ver+'_'+arch+'.app.tar.gz'
    };
  }
  fs.writeFileSync(out+'/latest.json', JSON.stringify({
    version: ver, notes: 'https://github.com/'+repo+'/releases/tag/v'+ver,
    pub_date: new Date().toISOString(), platforms: plat }, null, 2)+'\n');
"

# 6) GitHub 릴리스 — DMG(수동 설치) + app.tar.gz/sig(자동 업데이트) + latest.json(피드)
{ echo "### SHA-256"; printf '    %s\n' "${NOTES_SHA[@]}"; } > "$OUT/notes.md"
gh release create "v$VER" -R "$REPO" --title "v$VER" --notes-file "$OUT/notes.md" \
  "$OUT"/Joule_"$VER"_*.dmg "$OUT"/Joule_"$VER"_*.app.tar.gz "$OUT"/latest.json

# 7) 최종 재검증 — 실제 서빙되는 latest.json이 로컬과 동일한지
sleep 3
curl -sL "https://github.com/$REPO/releases/latest/download/latest.json" | diff - "$OUT/latest.json" \
  && echo "✅ v$VER 릴리스 완료 — 기존 사용자 앱이 24h 내(또는 재시작 15초 뒤) 업데이트를 제안합니다" \
  || echo "⚠️ latest.json 불일치 — releases/latest가 이 릴리스인지 확인할 것"
echo "☞ 남은 게이트(수동): DMG 마운트→/tmp 복사→복사본 실행 확인 후 소스 push"
