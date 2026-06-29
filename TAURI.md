# 메뉴바 앱 (Tauri v2) — 빌드 가이드

`src-tauri/`는 **빌드·실행이 검증된** 메뉴바(트레이) 앱입니다. (Apple Silicon에서 `.app`+`.dmg` 생성 → 실행 → 사이드카가 번들된 뷰어를 `localhost:4317`에 서빙하는 것까지 확인.)

## 동작 개념
앱을 켜면 → 번들된 **`battery-life serve` 사이드카**(로컬 서버)가 실행되고 → 트레이(메뉴바) 아이콘의 **"뷰어 열기"** 로 `http://localhost:4317`을 띄우는 네이티브 창이 나옵니다. 이미 만든 웹 뷰어를 그대로 재사용합니다.

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
- **배터리 기록(sample)**: `.app` 안 자산 경로는 읽기전용이라 라이브 기록은 **launchd 에이전트(`./install.sh`)** 를 쓰세요(앱과 독립적으로 1분마다 `data/`에 기록). 메뉴바 앱은 그 데이터를 보여주는 뷰어 역할.
- **서명·공증 안 함**: 직접 빌드한 `.app`은 로컬 실행은 되지만, 남에게 배포하면 Gatekeeper가 막습니다 → Apple Developer 계정으로 codesign + notarize 필요.
- **서버 준비 레이스**: 창이 서버보다 먼저 뜨면 잠깐 빈 화면일 수 있음 → 필요하면 `main.rs`에서 폴링 후 `show` 보완.
- **다른 칩**: Intel 맥은 `build-app.sh`가 자동으로 `-x86_64-apple-darwin` 트리플로 사이드카를 복사합니다(그 맥에서 빌드 시).

## 구조
- `src-tauri/src/main.rs` — 사이드카 spawn + 트레이 메뉴(+창 표시)
- `src-tauri/tauri.conf.json` — 창/번들 설정, `externalBin`(사이드카), `resources`(web·데모)
- `src-tauri/capabilities/default.json` — 사이드카 실행 권한
