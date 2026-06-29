# 🔋 3D Battery Life

macOS 배터리의 **방전 속도를 시간에 따라 기록**하고, 브라우저에서 **3D로 탐색**하는 도구.

"새것일 땐 100→90%가 1시간, 한 달 뒤엔 30분, 1년 뒤엔 20분" 같은 변화를 입체로 비교하고,
그게 **부하(Watts) 때문인지 배터리 노화 때문인지**를 분리해서 보여준다.

## 왜 단순 배터리 앱과 다른가

방전 속도(%/시간)는 두 가지가 섞인 결과다:

1. **부하** — CPU를 많이 쓰면 전력 소모(W)가 올라가 같은 배터리라도 빨리 닳음
2. **노화** — 만충 용량(mAh)이 줄어 같은 부하에서도 빨리 닳음

이 도구는 `ioreg`에서 **실시간 전력(전압×전류)**, **만충 용량**, **사이클**, **온도**를 함께 기록하므로,
"지금 빨리 닳는 게 무거운 작업 탓인지, 배터리가 늙어서인지"를 구분할 수 있다.

## 빠른 시작

```bash
# 1) 백그라운드 자동 기록 시작 (60초마다, launchd, sudo 불필요)
./install.sh

# 2) 데모 데이터 생성 (1년치 시뮬레이션 — 지금 바로 3D를 보려고)
npm run demo

# 3) 뷰어 실행
npm run serve          # → http://localhost:4317
```

브라우저에서 우측 패널의 **데모(1년) ↔ 내 데이터**를 전환할 수 있다.
내 데이터는 기록이 쌓일수록(하루~한 달) 점점 풍부해진다.

## 3D 화면 읽는 법

| 축/요소 | 의미 |
|---|---|
| **X (가로)** | 하루 중 시각 (0~24시) |
| **Y (세로)** | 배터리 % 또는 전력(W) — 패널에서 전환 |
| **Z (깊이)** | 경과 일수 (뒤=오래됨, 앞=최근) |
| **색상** | 온도 / CPU 부하 / 전력 — 패널에서 전환 |
| **곡선 1개** | 방전 세션 1회 (충전 뽑고 → 다시 꽂을 때까지) |

곡선이 시간이 갈수록(Z축 앞으로) **가팔라지면** 방전이 빨라지는 것. 곡선에 마우스를 올리면
그 세션의 `100→90% 소요 시간`, 평균 전력, 온도, 건강도, 최다 CPU 사용 프로세스가 뜬다.

## 구성

```
bin/sampler.js      한 번 실행 → 배터리 스냅샷 1개를 data/samples.jsonl 에 append
lib/battery.js      ioreg/pmset 파싱 (전류 2's-complement 변환 포함)
lib/report.js       JSONL → 세션 분리 + 지표(방전속도, 100→90 시간, 건강도 추이)
server.js           정적 웹 + /api/report (의존성 0)
web/                Three.js 3D 뷰어
scripts/gen-demo.js 물리적으로 일관된 1년치 데모 데이터 생성
launchd/            60초 주기 LaunchAgent 템플릿
```

## 기록되는 항목 (샘플 1줄 = JSON)

`pct, rawCap, rawMax, design, healthPct, voltage, amperage, powerW, watts,
cycles, tempC, ac, charging, timeRemain, loadPct, topProc/topProcCpu`

- 전류(`Amperage`)는 macOS가 unsigned 64-bit로 주므로 음수(방전)로 재해석한다.
- `watts = |전압 × 전류|` 가 핵심 — 부하의 직접 측정값.
- `healthPct = 만충용량 / 설계용량` 이 노화 지표.

## 의존성 / 권한

- **Node 18+** 만 필요 (npm 패키지 0개, Three.js는 `web/vendor/`에 동봉).
- `sudo` 불필요, 특별한 개인정보 권한 프롬프트 없음 (`ioreg`/`ps`만 사용).
- 데이터는 전부 로컬(`data/`)에만 저장된다.

## 중지

```bash
./uninstall.sh        # 기록 중단 (data/ 는 보존)
```
