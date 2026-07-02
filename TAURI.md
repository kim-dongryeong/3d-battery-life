# 메뉴바 앱 (Tauri v2) — 빌드 가이드

`src-tauri/`는 **빌드·실행이 검증된** 메뉴바(트레이) 앱입니다. (Apple Silicon에서 `.app`+`.dmg` 생성 → 실행 → 사이드카가 번들된 뷰어를 `localhost:4317`에 서빙하는 것까지 확인.)

## 동작 개념
앱을 켜면 → 번들된 **`battery-life serve` 사이드카**(로컬 서버)가 실행되고 → 트레이(메뉴바) 아이콘 메뉴로 **뷰어 열기 / 배터리 기록 시작 / 배터리 기록 중지 / 종료**. "뷰어 열기"는 `http://localhost:4317`을 띄우는 네이티브 창. 이미 만든 웹 뷰어를 그대로 재사용합니다.

**첫 실행 동의**: 기록이 아직 설정 안 됐고 물어본 적 없으면, 첫 실행 때 osascript 네이티브 다이얼로그로 "배터리 기록을 켤까요?"를 한 번 묻고, 승낙하면 `record on`을 실행(launchd 등록). 이후엔 메뉴바 토글로 켜고 끕니다. (기록 명령은 번들 안 `Contents/MacOS/battery-life` 바이너리를 직접 호출 → 별도 플러그인/권한 불필요.)

자산 위치는 `server.js`의 `resolveRoot()`가 자동으로 찾습니다: **`BATTERY_ROOT` 환경변수 → 실행파일 옆 → `.app`의 `Contents/Resources` → cwd** 순. 그래서 사이드카가 `Contents/MacOS/`에 있어도 `Contents/Resources/web`·`Contents/Resources/data/demo2.jsonl`을 찾아냅니다(`tauri.conf.json`의 `bundle.resources`로 번들됨).

## 사전 준비 (한 번)
```bash
brew install bun                       # 단일 바이너리(사이드카) 컴파일용
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y   # Rust
npm install -g @tauri-apps/cli@^2      # Tauri CLI (cargo install보다 빠름)

# 아이콘 생성(한 번): 512px+ PNG 하나로 → src-tauri/icons/* 채워짐
( cd src-tauri && tauri icon /path/to/icon.png )
```

## 빌드 / 실행
```bash
npm run build:app      # ① 바이너리 → ② 사이드카(타깃 트리플로 복사) → ③ tauri build  (한 방에)
# 또는 개발 실행:
( . "$HOME/.cargo/env"; tauri dev )
```
결과물: `src-tauri/target/release/bundle/macos/3D Battery Life.app`, `.../dmg/*.dmg`.
앱 더블클릭 → 메뉴바 아이콘 → "뷰어 열기".

## 알아둘 점
- **배터리 기록(sample)**: `battery-life record on`(= `./install.sh`)으로 launchd가 1분마다 **공유 데이터 폴더** `~/Library/Application Support/3d-battery-life/`에 기록. `.app`·바이너리·CLI 모두 그 폴더의 **같은 실데이터**를 읽으므로, 메뉴바 앱에서 "내 데이터"가 그대로 보입니다(데모는 앱에 동봉). 끄기 `record off`, 상태 `record status`.
- **서명·공증 안 함**: 직접 빌드한 `.app`은 로컬 실행은 되지만, 남에게 배포하면 Gatekeeper가 막습니다 → Apple Developer 계정으로 codesign + notarize 필요.
- **서버 준비 레이스**: 창이 서버보다 먼저 뜨면 잠깐 빈 화면일 수 있음 → 필요하면 `main.rs`에서 폴링 후 `show` 보완.
- **다른 칩**: Intel 맥은 `build-app.sh`가 자동으로 `-x86_64-apple-darwin` 트리플로 사이드카를 복사합니다(그 맥에서 빌드 시).

## 구조
- `src-tauri/src/main.rs` — 사이드카 spawn + 첫 실행 동의(osascript) + 트레이 메뉴(뷰어 열기·기록 시작/중지·종료)
- `src-tauri/tauri.conf.json` — 창/번들 설정, `externalBin`(사이드카), `resources`(web·데모)
- `src-tauri/capabilities/default.json` — 사이드카 실행 권한
