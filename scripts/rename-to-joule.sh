#!/usr/bin/env bash
# ~/dev/3d-battery-life → ~/dev/joule 로컬 폴더 rename (+ Claude 히스토리 + _env 부트스트랩)
# GitHub repo는 이미 joule-battery-power-charging-analyzer 로 rename 완료(remote URL 갱신됨).
#
# ⚠️ 순서: 먼저 deploy-v030-local.sh 로 v0.3.0을 설치하세요. v0.3.0부터는 기록 데몬(sampler)이
#   dev 폴더가 아니라 /Applications/Joule.app 을 가리키므로, 이 폴더 이동은 데몬과 무관해집니다.
# ⚠️ 실행 전:
#   1) 이 프로젝트에서 열린 Claude/Codex/VS Code 세션을 모두 닫으세요 (열려 있으면 슬러그 이동이 꼬임).
#   2) 옮길 폴더 밖에서 실행:  cp ~/dev/3d-battery-life/scripts/rename-to-joule.sh ~/rename-to-joule.sh
#                              cd ~ && bash ~/rename-to-joule.sh
set -euo pipefail

OLD="$HOME/dev/3d-battery-life"
NEW="$HOME/dev/joule"
BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
OLD_PROJ="$BASE/$(printf '%s' "$OLD" | sed 's/[^a-zA-Z0-9]/-/g')"
NEW_PROJ="$BASE/$(printf '%s' "$NEW" | sed 's/[^a-zA-Z0-9]/-/g')"
ENV="$HOME/dev/_env"

echo "폴더        : $OLD  →  $NEW"
echo "Claude 슬러그 : $OLD_PROJ  →  $NEW_PROJ"
echo "부트스트랩    : _env REPOS/vscode + ~/bin/git-autosync.sh"
echo "데몬          : 건드리지 않음 (v0.3.0 sampler는 앱을 가리켜 dev 폴더와 무관)"
echo

# ── 안전 점검 ────────────────────────────────────────────────
[ -d "$OLD" ] || { echo "✗ 원본 폴더 없음: $OLD"; exit 1; }
[ -e "$NEW" ] && { echo "✗ 대상이 이미 있음: $NEW"; exit 1; }
case "$PWD/" in "$OLD"/*|"$OLD/") echo "✗ 옮길 폴더 안에서 실행 중. 'cd ~' 후 다시 실행하세요."; exit 1;; esac
read -r -p "위 내용으로 진행할까요? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || { echo "취소."; exit 0; }

# 1) dev 폴더 이동 (git은 상대경로라 이동해도 그대로 동작)
mv "$OLD" "$NEW"
echo "✓ 폴더 이동"

# 2) Claude 세션 + 메모리 이동 (memory/ 도 슬러그 하위라 함께)
if [ -d "$OLD_PROJ" ] && [ ! -e "$NEW_PROJ" ]; then
  mv "$OLD_PROJ" "$NEW_PROJ"; echo "✓ Claude 세션+메모리 이동"
else
  echo "… Claude 슬러그 이동 건너뜀(없거나 대상 존재): $OLD_PROJ"
fi

# 3) _env 부트스트랩: REPOS(경로+URL) + vscode 중앙폴더
if [ -d "$ENV" ]; then
  sed -i '' \
    -e 's#git@github.com:kim-dongryeong/3d-battery-life\.git#git@github.com:kim-dongryeong/joule-battery-power-charging-analyzer.git#' \
    -e 's#"3d-battery-life#"joule#' \
    "$ENV/install-git-autosync.sh"
  [ -d "$ENV/vscode/3d-battery-life" ] && mv "$ENV/vscode/3d-battery-life" "$ENV/vscode/joule"
  echo "✓ _env REPOS 행 + vscode 폴더 갱신"
fi

# 5) repo 안의 .vscode 심링크 재지정 (gitignore라 커밋 대상 아님)
if [ -L "$NEW/.vscode" ] || [ -e "$NEW/.vscode" ]; then
  rm -f "$NEW/.vscode"; ln -s "../_env/vscode/joule" "$NEW/.vscode"
  echo "✓ .vscode 심링크 → ../_env/vscode/joule"
fi

# 6) 생성물 ~/bin/git-autosync.sh 즉시 패치 (다음 부트스트랩 때 REPOS에서 재생성됨)
[ -f "$HOME/bin/git-autosync.sh" ] && { sed -i '' 's#dev/3d-battery-life#dev/joule#g' "$HOME/bin/git-autosync.sh"; echo "✓ git-autosync.sh 경로 패치"; }

# 7) _env 커밋+푸시 (private repo)
if [ -d "$ENV/.git" ]; then
  git -C "$ENV" add -A
  GIT_AUTHOR_NAME='Kim Dongryeong' GIT_AUTHOR_EMAIL='kdr@namouli.com' \
  GIT_COMMITTER_NAME='Kim Dongryeong' GIT_COMMITTER_EMAIL='kdr@namouli.com' \
    git -C "$ENV" commit -q -m "repo rename: 3d-battery-life → joule (folder ~/dev/joule, GitHub joule-battery-power-charging-analyzer)" || echo "  (변경 없음/커밋 스킵)"
  git -C "$ENV" push -q 2>/dev/null && echo "✓ _env 커밋+푸시" || echo "  ⚠️ _env push 실패 — 수동 push 필요"
fi

echo
echo "완료 ✓  검증:"
echo "  ls \"$NEW\" && git -C \"$NEW\" remote -v | head -1        # 새 폴더 + 새 remote URL"
echo "  launchctl print gui/$UID_N/com.kdr.3d-battery-life.sampler | grep -A2 arguments   # 새 경로"
echo "  node \"$NEW/bin/cli.js\" record status                    # 기록 살아있는지"
echo "  readlink \"$NEW/.vscode\"                                 # → ../_env/vscode/joule"
echo "  ls \"$NEW_PROJ\"                                          # transcripts + memory/"
echo
echo "데이터(~/Library/Application Support/3d-battery-life/)와 smcd 데몬은 의도적으로 그대로 — 20k+ 기록 연속성 유지."
