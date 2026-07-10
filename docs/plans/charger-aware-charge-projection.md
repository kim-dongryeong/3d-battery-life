# 충전기 프로필별 충전 예상(완충까지) — 상세 설계 계획

> 상태: **P1–P4 구현 완료** (2026-07-11) · P5 실측 검증은 다음 충전 세션들에서 진행
> 구현: `lib/battery.js parseAdapter` · `lib/adapters.js` · `lib/chargeRates.js`(+`tests/`, 10 pass) ·
> `/api/charge-rates` · 뷰어 `renderChargeCard`(#chgChart) · 팝오버 '충전 기술/제공 프로필' 행.
> 검증된 사실: FamilyCode 매핑은 IOPM.h+IOReturn.h로 확정(0xE0004009=USBCTypeC, 0xE000400A=USBCPD,
> 전용 어댑터 = 0xE0024000대). 과거 데이터도 adapterWnom·Vnom 부분 키로 4개 충전기(30W@20V·15W@5V·
> 27W@20V·35W@20V)가 이미 분리됨을 확인.
> 배경 요청: "충전기 종류·충전 테크놀로지(PD, PPS, …)·파워에 따라 충전 속도가 아주 많이 달라진다.
> 구간별 충전 통계에 충전기 프로필을 넣어서 시뮬레이션하자."

## 0. 문제 정의

현재 충전 예상(뷰어 `computeCharge` + 3D 충전 예상선)은 **모든 과거 충전 이력을 하나로 pooled**한
10% 구간별 속도를 쓴다. 15W 파워뱅크로 충전한 이력과 96W 충전기로 충전한 이력이 섞여 있으면
어느 쪽에도 맞지 않는 평균이 나온다. 목표: **"지금 꽂혀 있는 충전기"의 과거 이력으로 예상**하고,
이력이 부족하면 비슷한 급의 충전기 → 전체 순으로 우아하게 폴백한다.

## 1. 플랫폼 조사 — macOS가 충전기에 대해 알려주는 것 (2026-07-10 실측)

### 1-1. `ioreg -rn AppleSmartBattery`의 `AdapterDetails` 딕셔너리

이 맥에서 15W 파워뱅크(추정) 연결 중 실측 원문:

```
"AdapterDetails" = {"IsWireless"=No,"AdapterID"=10,"AdapterVoltage"=5000,
  "FamilyCode"=18446744073172697097,"AdapterPowerTier"=1,"Watts"=15,
  "UsbHvcHvcIndex"=255,"Current"=3000,"PMUConfiguration"=3000,"UsbHvcMenu"=()}
```

| 필드 | 의미 | 활용 |
|---|---|---|
| `Watts` | 협상된 계약의 정격 전력 (15) | 프로필 키 + 클래스 분류 |
| `AdapterVoltage` (mV) | **협상 전압** (5000 = 5V) | PD 20V vs 5V 저속을 즉시 구분 |
| `Current` (mA) | 협상 전류 (3000) | V×A = 계약 전력 검산 |
| `AdapterID` | 어댑터 식별자 (같은 모델이면 동일 경향) | 프로필 키 |
| `FamilyCode` | **연결 기술 패밀리** (아래 1-2) | 기술 라벨의 근거 |
| `UsbHvcMenu` | 충전기가 **제공하는 고전압 계약(HVC) 목록** — PD 충전기면 (9V/xxA, 15V/xxA, 20V/xxA…) 배열 | 상세 패널에 "제공 프로필" 표시; PD 판별 보조 |
| `UsbHvcHvcIndex` | 선택된 HVC 인덱스 (255 = 없음/5V) | 협상 상태 |
| `Name` / `Description` / `Manufacturer` / `SerialString` | Apple 정품·MagSafe·일부 인증 충전기만 채워짐 ("96W USB-C Power Adapter" 등). 오늘의 무명 충전기엔 **없음** | 있으면 사람이 읽는 이름으로 사용 |
| `IsWireless` | 무선 여부 (Mac은 사실상 No) | 기록만 |
| `AdapterPowerTier` | Apple 내부 전력 티어 | 참고 기록 |

- 같은 내용의 요약이 `pmset -g ac`로도 나온다 (Wattage/Current/Voltage/AdapterID/Family Code).
- 이미 우리 sampler는 `adapterWnom`(정격 W)·`adapterVnom`(협상 V)·`adapterName`을 분당 기록 중
  ([battery.js:204-216](../../lib/battery.js#L204-L216)) → **AdapterID·FamilyCode·Current(mA)·UsbHvcMenu만 추가하면 됨**.

### 1-2. `FamilyCode` → 충전 기술 라벨 (IOPSKeys.h 매핑)

오늘 실측값 `18446744073172697097` = 부호 확장된 **`0xE0004009`**.

| FamilyCode | 헤더 상수(추정) | 우리 라벨 |
|---|---|---|
| `0xE000400B` | USB-C PD | **USB-C PD** (고속) |
| `0xE000400A` | USB-C Type-C 전류(5V/1.5A·3A) | **USB-C 5V** |
| `0xE0004009` | USB-C Brick / 5V 고정 | **USB-C 5V** (오늘 실측) |
| `0xE0004001..8` | USB 호스트/전용 충전 포트 등 구형 USB | **USB(구형)** |
| `0xE0024000` | AC (구형 MagSafe 1/2 등) | **전용 어댑터** |
| 기타/없음 | — | **미상** |

> ⚠️ 구현 P1에서 Apple SDK `IOPSKeys.h` 원문으로 이 매핑을 **검증**하고 표를 확정한다(계획 단계 추정 포함).
> 원칙: 라벨은 매핑 실패 시에도 raw hex를 함께 저장하므로 데이터는 잃지 않는다.

### 1-3. 알 수 없는 것 (한계 — UI에 정직하게)

- **PPS vs 고정 PD**: PPS(APDO)는 `UsbHvcMenu`에 노출되지 않음. Mac 자신도 PPS를 쓰지 않으므로 실익 없음.
- **삼성 AFC·퀄컴 퀵차지**: Mac은 이 프로토콜을 **협상하지 않는다**. 그런 충전기를 꽂으면 USB 기본 5V로만
  동작 → 우리 데이터에는 "USB-C 5V/저전력 클래스"로 잡히는 것이 물리적으로 올바른 표현이다.
- **듀얼 포트 충전기의 실시간 배분**: 정격은 계약값일 뿐. 대신 SMC 실측(PDTR·VD0R·ID0R)이 진실을 말해준다.

### 1-4. 실측 보조 신호 (이미 수집 중)

- SMC `PDTR` = 어댑터 입력 전력(W), `VD0R`/`ID0R` = 실측 DC-in 전압·전류 → **협상 전압 확인**(20V vs 5V)과
  "정격 대비 실제 공급" 비교가 가능. 앱 실행 중에만 기록된다는 제약 명시.

## 2. 충전기 지문(chargerKey) 설계

```
chargerKey = "<Watts>W@<AdapterVoltage:V>V/<familyHex>#<AdapterID>"
예: "15W@5V/e0004009#10" · "96W@20V/e000400b#30183"
```

- **Serial은 제외**(프라이버시 + 같은 모델 두 개를 구분할 실익 낮음). Name은 키에 넣지 않고 사전에서 보여준다.
- `data/adapters.json` (기존 data/ 규칙과 동일하게 **커밋 금지**) — 키 → 메타 사전:

```json
{ "15W@5V/e0004009#10": { "name": null, "manufacturer": null, "watts": 15,
    "voltage": 5, "current": 3.0, "family": "e0004009", "tech": "usbc-5v",
    "hvcMenu": [], "firstSeen": 1783670000, "lastSeen": 1783706000, "chargeMin": 412 } }
```

## 3. 데이터 스키마 변경

### 3-1. samples.jsonl (분당 레코드) — 외부 전원 연결 중에만 추가

| 새 필드 | 값 | 비고 |
|---|---|---|
| `adapterId` | ioreg `AdapterID` | 숫자 |
| `familyCode` | `"e0004009"` (hex 문자열) | 부호 확장 정리 후 하위 32bit |
| `adapterAnom` | 협상 전류 A (3.0) | `Current`/1000 |

기존 `adapterWnom`·`adapterVnom`·`adapterName`은 그대로. **레코드 크기 증가 ≈ 40바이트/분(연결 중만)** — 허용.
`UsbHvcMenu`는 분당 기록하지 않고(부피) adapters.json 사전에만 저장.

### 3-2. 과거 데이터 소급

- `adapterWnom`이 있는 기간(수집 시작 이후): `Watts+Vnom`만으로 **부분 키**(`"15W@5V/?#?"`)를 만들어 클래스 분류에 활용.
- 그 이전: 충전기 **"미상"** 프로필. 소급 조작은 하지 않는다(데이터 불변 원칙).

## 4. 통계 — `lib/chargeRates.js` 신설

### 4-1. run 태깅

- `report.js buildRuns`의 charge run에 chargerKey 부여. run 도중 키가 바뀌면(어댑터 교체) **그 지점에서 run 분할**.
- 제외/태그 규칙: `onHold`(최적화 충전 대기) 구간 제외 · 샘플 간격 >3600s 제외(기존과 동일) ·
  LPM은 태그만(속도에 유의미하면 v2에서 분리).

### 4-2. 구간별 속도 (기존 수학 재사용)

- 10% 밴드 × chargerKey → `rise(%)/time(s)` 누적 → %/min. (뷰어 `chargeRatesByBand`의 수학을 라이브러리로 옮기고
  charger 차원만 추가 — **계산식 자체는 검증된 기존 것**.)

### 4-3. 계층 폴백 (핵심 설계)

밴드별 최소 표본 `MIN_SEC = 480`(8분) 미달 시 상위 계층으로:

```
① 같은 chargerKey
② 같은 클래스: tech 동일 && 정격 W 밴드 동일   (W 밴드: ≤20 · 21–45 · 46–70 · 71+)
③ 전체 pooled (현행과 동일)
```

- v1은 단순 threshold 폴백. v2 옵션: shrinkage 가중 평균 `w = n/(n+k)` 으로 계층 혼합.
- 예상 결과에 **어느 계층을 썼는지 표기**("이 충전기 이력 3.2h 기준" / "비슷한 급 충전기 기준" / "전체 평균").

### 4-4. 에너지 수지(energy-balance) 예측기 — kdr 제안 (2026-07-10)

구간별 통계와 **상호보완**되는 두 번째 예측기. 이 충전기로 충전해본 이력이 없어도(콜드스타트)
"현재 DC-in + 충전기와 무관한 시스템 전력 이력"만으로 완충 시간을 낸다.

```
잔여 에너지 E(Wh) ≈ (rawMax − rawCap)[mAh] × V[V] / 1000 ÷ η      (충전 효율 η ≈ 0.92)
충전 전력 P_bat(T) = P_dc − avgSys(지난 T시간)                      (아래 레짐 판별 참조)
완충 시간 T* : T = E / P_bat(T) 의 자기일관해(고정점)
```

- **고정점 풀이는 반복 대신 스캔**: 후보 창 T ∈ {0.5, 1, 1.5, …, 8h}의 avgSys를 미리 계산해
  |T − E/P_bat(T)| 최소인 창을 고른다. (순수 반복은 과거 부하가 울퉁불퉁하면 두 창 사이를
  진동할 수 있음 — 스캔은 같은 답을 주면서 발산이 없다. kdr의 "10번 반복"과 동치인 안전판.)
- **레짐 판별 (중요)**:
  - *어댑터 포화* (실측 PDTR ≈ 정격 W, 예: 15W 파워뱅크): `P_bat = 정격W − avgSys(T)` — 제안 모델 그대로.
  - *배터리 제한* (PDTR ≪ 정격, 예: 96W): 부하 증가는 DC-in이 흡수하고 배터리 몫은 불변 →
    `P_bat = 현재 수지(PDTR−PSTR) 실측`을 그대로 쓰고 창 반복은 생략.
- **완충 불가 판정**: P_bat(T) ≤ 0.5W면 "이 부하로는 완충까지 못 감" — 오류가 아니라 유의미한 답으로 표시.
- **CV 꼬리 스플라이스**: 이 모델은 벌크(CC) 구간에서만 유효 — **현재→80%는 에너지 수지,
  80%→100%는 4-2의 구간별 통계**로 이어붙인다(마지막 구간은 배터리 특성이 지배해 수지 모델이 항상 낙관적).
- 데이터는 이미 전부 있음: `systemW`(분당, PSTR 1분 평균)·`adapterW`(PDTR)·`rawCap/rawMax`·`voltage`.
  앱 미실행 구간은 systemW 결측 → 해당 분은 창 평균에서 제외(결측 시간이 창의 반 이상이면 예측기 비활성).
- UI: 충전 예상 카드에 **제3의 선/행**으로 "에너지 수지(현재 부하 기준)" 병기 — 구간별(이 충전기 이력)·
  에너지 수지(현재 부하)·macOS 추정 3개를 나란히. 프로필 이력이 없을 땐 폴백 ②③보다 이걸 우선 표시.
- 구현 페이즈: **P3에 포함**(lib/chargeRates.js 옆 `energyBalanceETA()`), UI는 P4.

### 4-5. v2+ (이번 빌드 범위 밖, 기록만)

- 시스템 부하 보정: 충전 속도 ≈ f(어댑터 공급 − 시스템 소비). 충전 중 `systemW` 중앙값을 프로필에 저장,
  현재 부하와의 차이로 예상 보정.
- 온도 déraiting(고온 시 충전 제한) 태그.

## 5. API·UI

### 5-1. 서버

- `/api/charge-rates` 신설: `{ current: <chargerKey|null>, profiles: { key: { meta, byBand, totalMin } }, fallbackOrder }`.
  `/api/live`에 `adapterId`·`familyCode`·`tech` 추가.

### 5-2. 뷰어 (충전 예상 카드 + 3D 충전 예상선)

- 카드 헤더에 **현재 충전기 배지**: `⚡ USB-C 5V · 15W(5V×3A) · 실측 12.7W` (이름 있으면 이름 우선).
- 예상선·완충 ETA는 현재 chargerKey의 구간별 속도로. 사용 계층 문구 병기.
- **충전기 비교 셀렉터**: 사전에 있는 다른 프로필을 골라 "그 충전기라면" 가상 ETA를 겹쳐 표시.
- 색·용어: 기존 라이트/다크 팔레트 준수, **"AC" 용어 금지 — "외부 전원"**.

### 5-3. 팝오버 상세 "전원 어댑터" 행 확장

```
전원 어댑터   96W USB-C Power Adapter (Apple)
              USB-C PD · 계약 20V×4.7A(96W) · 실측 19.8V·2.1A(41.6W)
              제공 프로필: 5V/3A · 9V/3A · 15V/3A · 20V/4.7A     ← UsbHvcMenu
```

무명 충전기(오늘의 파워뱅크)는: `USB-C 5V · 계약 5V×3A(15W) · 실측 …` 처럼 기술 라벨만으로 표시.

## 6. 구현 페이즈 (승인 후 빌드 순서 — 페이즈당 1커밋)

| 페이즈 | 내용 | 검증 |
|---|---|---|
| **P1 수집** | battery.js AdapterDetails 전체 파싱(adapterId·familyCode·Anom·UsbHvcMenu) + FamilyCode 매핑 검증(IOPSKeys.h) + 팝오버 상세 기술 라벨 | ioreg fixture 파서 테스트 · 실기기 15W로 육안 |
| **P2 사전** | adapters.json 누적(sampler에서 upsert) + report charge run에 chargerKey 태깅·분할 | run 분할 단위 테스트 |
| **P3 통계** | lib/chargeRates.js (밴드×프로필 + 계층 폴백) | 합성 샘플 테스트(15W vs 96W 시나리오) |
| **P4 예상 UI** | /api/charge-rates + 뷰어 카드 배지·비교 셀렉터 + 3D 충전선 연결 | 실충전 세션 관찰 |
| **P5 실측 검증** | 파워뱅크(15W)와 고출력 충전기로 각각 충전해 예상 vs 실제 비교, 문서에 기록 | 오차 리포트 |

## 7. 엣지 케이스 목록

- 충전 중 어댑터 교체 → run 분할(4-1)로 처리.
- 파워뱅크 잔량 고갈로 공급 저하 → 정격은 그대로, 실측(PDTR)만 하락 — 프로필 오염은 pooled 평균이 흡수, v2 부하보정에서 개선.
- 모니터/독 경유 충전 → 독이 어댑터로 보임(Name "LG UltraFine" 등) — 정상: 그것도 하나의 충전기 프로필.
- MagSafe 3 → USB-C PD의 변형. FamilyCode/Name으로 자연 분리.
- 클램셸·슬립 중 충전 → 샘플 없음 → run gap 제외 규칙이 이미 커버(그 구간 통계 없음, 한계로 문서화).
- 80% 최적화 충전 hold → `onHold` 제외(4-1).
- 앱 미실행(sampler만) → 공칭값은 기록됨, SMC 실측만 결측 — 통계는 %상승 기반이라 영향 없음.
- 90%↑ CV 꼬리 → 밴드별 통계가 원래 흡수하는 구조(구간별 곡선의 존재 이유).

## 8. 리스크

- **초기 표본 부족**: 당분간 대부분 폴백 ②/③로 동작 — 배지에 계층 표기로 정직하게.
- FamilyCode 매핑 오류 가능성 → raw hex 병행 저장으로 재분류 가능.
- 과거 이력은 "미상" 프로필 → 시간이 지나며 자연 개선.
