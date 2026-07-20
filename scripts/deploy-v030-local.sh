#!/usr/bin/env bash
# 이 Mac에 Joule v0.3.0 설치 + 데이터/데몬을 joule 신원으로 전환.
# 배경: 빌드 검증 중 새 코드가 마이그레이션을 조기 실행해, 원본 이력이 이미
#   ~/Library/Application Support/joule/ 로 옮겨졌고(정본), 구버전 데몬이 옛
#   ~/.../3d-battery-life/ 에 tail을 계속 씀. 이 스크립트가 그 split을 정리하고 v0.3.0으로 넘긴다.
# 안전: 데이터는 매 단계 백업. 옛 데몬은 bootout만(plist는 남겨 v0.3.0 마이그레이션이 새 라벨로 재설치).
set -euo pipefail
AS="$HOME/Library/Application Support"
OLD="$AS/3d-battery-life"; NEW="$AS/joule"
DMG="$HOME/dev/3d-battery-life/dist/release-0.3.0/Joule_0.3.0_aarch64.dmg"   # 이 Mac=Apple Silicon
UID_N="$(id -u)"

[ -f "$DMG" ] || { echo "✗ DMG 없음: $DMG (release-0.3.0 위치 확인)"; exit 1; }
[ -f "$NEW/samples.jsonl" ] || { echo "✗ 정본 joule/samples.jsonl 없음 — 중단"; exit 1; }
echo "v0.3.0 설치 + 데이터/데몬 전환을 진행합니다:"
echo "  · 실행 중 Joule 종료 → /Applications/Joule.app 을 v0.3.0으로 교체"
echo "  · 옛 데이터(3d-battery-life) tail을 joule로 최종 병합(중복 제거) 후 백업 보관"
echo "  · 옛 데몬(com.kdr.3d-battery-life.*) 정지 → v0.3.0이 kr.kdr.joule.* 로 재설치"
read -r -p "진행? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || { echo "취소."; exit 0; }

# 1) 옛 앱 종료
osascript -e 'tell application "Joule" to quit' 2>/dev/null || true; sleep 2
pkill -f "/Applications/Joule.app" 2>/dev/null || true; sleep 1

# 2) 옛 데몬 정지 (plist는 남겨둠 — v0.3.0 migrate_legacy가 '활성이었음' 보고 새 라벨로 재설치)
launchctl bootout "gui/$UID_N/com.kdr.3d-battery-life.sampler" 2>/dev/null || true
launchctl bootout "gui/$UID_N/com.kdr.3d-battery-life.smcd" 2>/dev/null || true
sleep 1
echo "✓ 옛 앱·데몬 정지"

# 3) 최종 데이터 병합: 3d-battery-life tail → joule (ts 기준 dedup) + 백업
if [ -f "$OLD/samples.jsonl" ]; then
  cp "$NEW/samples.jsonl" "$NEW/samples.jsonl.pre-final-merge.bak"
  python3 - "$OLD/samples.jsonl" "$NEW/samples.jsonl" <<'PY'
import json,sys,os
old,new=sys.argv[1],sys.argv[2]
def load(p):
    o=[]
    for l in open(p):
        l=l.strip()
        if not l: continue
        try: o.append((json.loads(l)['t'], l))
        except: pass
    return o
seen={}
for t,l in load(new)+load(old):   # 정본(joule)이 동률 우선
    seen.setdefault(t,l)
lines=[seen[t] for t in sorted(seen)]
tmp=new+'.tmp'; open(tmp,'w').write('\n'.join(lines)+'\n'); os.replace(tmp,new)
print(f"✓ 최종 병합 → joule/samples.jsonl : {len(lines)} unique")
PY
fi

# 4) 옛 데이터 폴더 백업 후 치움 (v0.3.0 마이그레이션 data 단계가 깨끗한 no-op 되도록)
if [ -d "$OLD" ]; then
  rm -rf "$AS/3d-battery-life.pre-v030-bak"
  mv "$OLD" "$AS/3d-battery-life.pre-v030-bak"
  echo "✓ 옛 데이터 폴더 → 3d-battery-life.pre-v030-bak (백업)"
fi

# 5) v0.3.0 설치 (서명·공증됨)
MNT="/tmp/joule-v030-install"; hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null
rm -rf /Applications/Joule.app
cp -R "$MNT/Joule.app" /Applications/
hdiutil detach "$MNT" >/dev/null
echo "✓ /Applications/Joule.app ← v0.3.0"

# 6) 실행 → migrate_legacy: data는 no-op(3d-battery-life 없음), 데몬은 옛 plist 감지 → 새 라벨 재설치
open /Applications/Joule.app
sleep 10

# 7) 검증
echo
echo "── 검증 ─────────────────────────"
echo "bundle id : $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Joule.app/Contents/Info.plist)"
echo "새 데몬   : $(launchctl list | grep -E 'kr.kdr.joule' | awk '{print $3}' | tr '\n' ' ')"
echo "옛 데몬   : $(launchctl list | grep -E 'com.kdr.3d-battery-life' | awk '{print $3}' | tr '\n' ' ')  (비어 있어야 정상)"
echo "옛 plist  : $(ls ~/Library/LaunchAgents/com.kdr.3d-battery-life.* 2>/dev/null | wc -l | tr -d ' ')개  (0이어야 정상)"
echo "데이터    : joule/samples.jsonl = $(wc -l < "$NEW/samples.jsonl" | tr -d ' ') samples"
echo "백업      : $NEW/samples.jsonl.pre-final-merge.bak · $AS/3d-battery-life.pre-v030-bak"
echo
echo "정상이면 백업 정리: rm -rf \"$AS/3d-battery-life.pre-v030-bak\" \"$NEW/samples.jsonl.pre-final-merge.bak\""
