# 메뉴바 앱 빌드 (Tauri v2) — 스캐폴드 가이드

`src-tauri/`는 **시작점(scaffold)** 입니다. Rust 툴체인이 있어야 빌드되며, Tauri 버전에 따라 API가 조금 다를 수 있으니 [tauri.app v2 문서](https://v2.tauri.app)로 확인하세요. (이 저장소 자체는 빌드 검증을 하지 않았습니다.)

## 동작 개념
메뉴바(트레이) 앱이 켜지면 → 번들된 **`battery-life` 단일 바이너리를 `serve`로 사이드카 실행**(로컬 서버) → 트레이 클릭 시 **`http://localhost:4317`을 띄우는 창**을 보여줍니다. 즉 이미 만든 웹 뷰어를 그대로 재사용합니다.

## 사전 준비
```bash
# 1) Rust + Tauri CLI
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --version "^2"

# 2) 사이드카 바이너리 (Node 없이 도는 단일 실행파일) 빌드
npm run build:binary          # → dist/battery-life  (Bun 필요)

# 3) 사이드카는 '타깃 트리플' 접미사 이름이어야 함. 예(Apple Silicon):
mkdir -p src-tauri/binaries
cp dist/battery-life "src-tauri/binaries/battery-life-$(rustc -Vv | sed -n 's/host: //p')"
#   인텔 맥이면 -x86_64-apple-darwin, 유니버설이면 둘 다.

# 4) 아이콘 생성(한 번): 512px PNG 하나로
cargo tauri icon path/to/icon.png      # → src-tauri/icons/* 채워짐
```

## 실행 / 빌드
```bash
cargo tauri dev      # 개발 실행 (메뉴바 + 사이드카 + 창)
cargo tauri build    # 배포물: .app / .dmg  (src-tauri/target/release/bundle/)
```

## 알아둘 점 / 손볼 수 있는 곳
- **웹 자산**: 사이드카(`battery-life serve`)가 자기 옆 `web/`을 읽습니다. 사이드카 바이너리 옆에 `web/`이 함께 번들되도록 하거나(추가 `resources` 설정), 또는 Tauri의 `frontendDist: ../web`로 직접 서빙하고 `/api/*`만 사이드카로 프록시하는 구조로 바꿔도 됩니다.
- **로컬서버 준비 레이스**: 창이 서버보다 먼저 뜨면 빈 페이지가 보일 수 있습니다 → `main.rs`에서 서버가 응답할 때까지 잠깐 폴링 후 `show`/`navigate` 하도록 보완 권장.
- **배터리 기록(sample)**: 메뉴바 앱이 떠 있을 때만 기록하려면 Rust 타이머로 `battery-life sample`을 주기 실행, 항상 기록하려면 기존 **launchd 에이전트**(`./install.sh`)를 그대로 쓰세요(앱과 독립적으로 1분마다 기록).
- **서명·공증**: 배포하려면 Apple Developer 계정으로 codesign + notarize 필요(`cargo tauri build` 옵션/문서 참고).
- **권한**: `src-tauri/capabilities/default.json`의 `shell:allow-spawn` 사이드카 이름/허용 args가 현재 Tauri 스키마와 맞는지 확인하세요.

## 더 쉬운 시작
처음이면 `npm create tauri-app@latest`로 깡통 프로젝트를 만든 뒤, 이 폴더의 **`src/main.rs`(트레이+사이드카)·`tauri.conf.json`·`capabilities/`** 를 덮어쓰는 게 가장 안전합니다.
