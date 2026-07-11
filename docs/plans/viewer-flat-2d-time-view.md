# 뷰어 2D 연속 시간축 보기("평면 보기") — 구현 계획서

> 상태: **승인됨 — 구현 대기** · 작성 2026-07-11 (Claude Fable 5)
> ⚠️ **이 문서는 "그대로 따라 하기" 지침서다.** 구현 에이전트는 여기 적힌 설계 결정을 재검토하거나
> 바꾸지 말 것. 코드 블록은 복사해 넣되, **삽입 위치는 반드시 "앵커 코드"(기존 코드 인용)를
> grep으로 찾아 확인한 뒤** 넣는다. 줄번호는 변할 수 있으니 앵커 텍스트가 진실이다.

## 0. 목표 (kdr 요청)

지금 3D 그래프는 X=하루 중 시각(0–24h), Z=경과 일수다. 여기에 **2D 보기 모드**를 추가한다:
- **가로축 = 여러 날짜를 포함하는 하나의 긴 연속 시간축** (첫 샘플 → 현재), 세로축 = 기존 Y(잔량 %/전력 W/변화율).
- 긴 축을 다루는 **편의 기능**: ① 마우스 휠 = 커서 중심 확대/축소 ② 드래그 = 좌우 이동 ③ 기간 프리셋(전체·30일·7일·24시간) ④ "오늘로" 점프 ⑤ **미니맵 브러시**(전체 개형 위에 현재 보는 창을 드래그) ⑥ 더블클릭 = 전체 보기 리셋.
- 3D의 기존 기능이 2D에서도 그대로: 색상 모드 5종, 호버 툴팁·클릭 고정, 방전/충전 예상선, '현재' 마커, 라이트/다크 테마, i18n.

## 1. 코드 지도 — 구현 전에 반드시 읽을 곳 (`web/main.js`)

| 무엇 | 앵커(grep으로 찾기) | 지금 하는 일 |
|---|---|---|
| 월드 상수 | `const X_BASE = 24, Y = 16, Z = 44;` | X=시각축 폭, Y=값 높이, Z=날짜축 깊이 |
| 좌표 함수 | `const xFromTod = h =>` · `const zFromDay = (d, maxDay)` · `const yFromVal = (v, valMax)` | 점 → 월드 좌표 |
| 상태 | `const state = { source: 'real', y: 'pct',` | 한 개의 객체 리터럴. 새 키는 여기에 추가 |
| 카메라 | `const camera = new THREE.PerspectiveCamera(52,` · `const HOME = new THREE.Vector3(34, 26, 40)` | 단일 전역 카메라 (호버 raycast·툴팁 투영·태그가 전부 이 변수를 씀 — **교체 금지, 위치만 이동**) |
| 컨트롤 | `const controls = new OrbitControls(camera, renderer.domElement);` | 회전/줌. 2D에선 끈다 |
| 그룹 | `const sceneRoot` (축·격자) · `lineRoot` (곡선) · `projGroup` (예상선) · `nowGroup` (현재점) | disposeGroup으로 재구축 |
| 곡선 생성 | `function buildLines(report) {` | runs → THREE.Line(점별 vertex color). **핵심 수정 지점** |
| 축 생성 | `function buildAxes(valMax, valLabel, maxDay, firstT) {` | 3D 축·격자·라벨. 2D용은 **별도 함수 신설** |
| 전체 재구축 | `function rebuild() {` | buildLines→buildAxes→예상선→현재마커→범례 |
| 예상선 | `function drawProjection3DInner(r) {` | 자정 넘김 wrap 로직 포함 — 2D 분기 필요 |
| 현재 마커 | `function drawNowMarker(r, yMax, maxDay) {` | 2D 분기 필요 |
| 호버 | `function pickAt(cx, cy) {` | raycast — 카메라만 맞으면 2D에서 그대로 동작 |
| 시각축 배율 | `function setXScale(v) {` · index.html `data-group="xScale"` | 3D 전용. 2D에선 숨김 |
| 리셋 버튼 | index.html `id="reset"` (시점 리셋) | 2D에선 "전체 보기"로 동작 변경 |
| 리사이즈/루프 | `addEventListener('resize', () => {` · `(function animate() {` | 2D 카메라 재핏 필요 |
| 세그 핸들러 | `else if (group === 'xScale') { setXScale(+val); }` | 새 `view` 그룹도 이 스위치에 추가 |
| 데이터 | `state.report.runs[].points[]` — 각 p: `{t, pct, cap, watts, powerW, systemW, tempC, loadPct, ac, charging, lowPower, …}` | t = epoch 초 |

좌표 파이프라인(3D): `pos.push(xFromTod(todOf(p.t)), yFromVal(yv, yMax), zFromDay(d, maxDay))` — **2D는 이 한 줄이 `xFlat(p.t), yFromVal(yv, yMax), 0` 으로 바뀌는 것**이 본질이고, 나머지는 축·카메라·내비게이션이다.

## 2. 설계 결정 (변경 금지)

1. **THREE 장면을 재사용한다.** 2D 전용 캔버스를 새로 만들지 않는다 — 곡선이 THREE.Line으로 남아야 색상 모드·호버 raycast·예상선·태그가 공짜로 동작한다.
2. **카메라는 기존 PerspectiveCamera 그대로, 위치만 정면 고정.** OrthographicCamera로 교체하지 않는다(전역 `camera` 변수를 쓰는 코드가 7곳+).
3. **줌/팬은 카메라가 아니라 "보이는 시간 창(window)"으로 한다.** `state.flatWin = null(전체) | {t0, t1}` 을 바꾸고 지오메트리를 다시 만든다(rAF 스로틀). 카메라가 안 움직이므로 라벨·툴팁·태그 투영이 전부 안정적이다.
4. 2D 월드 폭 상수 `FLAT_W = 72` (3D의 X=24보다 넓게, Z=44 격자 스케일과 조화).
5. 미니맵은 **HTML `<canvas>` 오버레이** (THREE 아님 — 2D 드로잉이 단순하고 hit-test가 쉬움).
6. 모드 상태는 `state.view: '3d' | 'flat'`, localStorage `battView`, 딥링크 `?view=flat`.

## 3. 단계별 구현

### Step 1 — 상태·저장·딥링크

`state.xScale = (() => {` 블록 **바로 아래**에 추가:

```js
// ---- 보기 모드: '3d'(시각×날짜 3D) | 'flat'(연속 시간축 2D). 딥링크 ?view=flat 우선.
state.view = (() => {
  try {
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'flat' || q === '3d') return q;
    const s = localStorage.getItem('battView');
    return s === 'flat' ? 'flat' : '3d';
  } catch { return '3d'; }
})();
state.flatWin = null;   // 2D 보이는 시간 창 {t0, t1}(epoch 초) · null = 전체 기간
```

### Step 2 — UI: 보기 세그 + 기간 프리셋 + i18n

**index.html**: `<span class="lbl">시각 축 (X · 가로 폭)</span>` 이 있는 `.grp` **바로 위**에 추가:

```html
    <div class="grp">
      <span class="lbl">보기</span>
      <div class="seg" data-group="view">
        <button data-val="3d" class="on">3D</button>
        <button data-val="flat" title="가로축이 날짜를 잇는 하나의 긴 시간축이 되는 2D 보기">2D 시간축</button>
      </div>
    </div>
    <div class="grp" id="flatRangeGrp" hidden>
      <span class="lbl">기간</span>
      <div class="seg" data-group="flatRange">
        <button data-val="all" class="on">전체</button>
        <button data-val="30d">30일</button>
        <button data-val="7d">7일</button>
        <button data-val="24h">24시간</button>
        <button data-val="end" title="현재 폭을 유지한 채 가장 최근으로 이동">오늘로</button>
      </div>
    </div>
```

**미니맵 DOM**: index.html에서 `<div id="legend">` **바로 위**에 추가:

```html
    <div id="flatMini" hidden><canvas id="flatMiniCv"></canvas></div>
```

**style.css** 끝에 추가:

```css
/* 2D 시간축 미니맵 브러시 */
#flatMini { position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px;
  width: min(72vw, 920px); height: 46px; border: 1px solid var(--line); border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 82%, transparent); overflow: hidden; cursor: crosshair; z-index: 5; }
#flatMini canvas { display: block; width: 100%; height: 100%; }
```

(`--line`/`--panel` 변수는 이미 style.css 상단 테마 변수에 존재 — 없으면 grep으로 실제 변수명 확인해 맞출 것.)

**세그 핸들러**: main.js에서 `else if (group === 'xScale') { setXScale(+val); }` 를 찾아 **그 아래에** 추가:

```js
    else if (group === 'view') { setView(val); }
    else if (group === 'flatRange') { applyFlatRange(val); }
```

**en.json** (`web/locales/en.json`의 flat dict 부분, `"구간별(곡선)"` 근처)에 추가 — ⚠️ 저장 후 반드시 중복 키 검사(§7) 실행:

```json
  "보기": "View", "2D 시간축": "2D timeline", "기간": "Range",
  "전체": "All", "30일": "30d", "7일": "7d", "24시간": "24h", "오늘로": "Latest",
  "날짜/시간 →": "Date/time →",
  "가로축이 날짜를 잇는 하나의 긴 시간축이 되는 2D 보기": "2D view where the horizontal axis is one continuous timeline across days",
  "현재 폭을 유지한 채 가장 최근으로 이동": "Jump to the latest, keeping the current width",
```
("전체"·"기간" 등이 이미 있으면 그 줄은 빼라 — `grep '"전체"' web/locales/en.json` 으로 하나씩 확인.)

### Step 3 — 좌표: 시간 창과 xFlat

main.js의 `const xFromTod = h =>` **바로 아래**에 추가:

```js
// ---- 2D 연속 시간축 (state.view === 'flat') --------------------------------------------------
const FLAT_W = 72;                 // 2D 시간축의 월드 폭
const FUTURE_PAD = 24 * 3600;      // 미래(예상선) 쪽으로 팬 허용 여유
// 전체 기간 [span0, span1]: 첫 샘플의 자정 ~ max(마지막 샘플, 지금)
function flatSpan() {
  const r = state.report;
  const d0 = new Date(((r && r.firstT) || Date.now() / 1000) * 1000); d0.setHours(0, 0, 0, 0);
  const s0 = d0.getTime() / 1000;
  const last = (r && r.latest && r.latest.t) || s0 + 86400;
  return [s0, Math.max(last, Date.now() / 1000)];
}
function flatWindow() {            // 현재 보이는 창 (없으면 전체)
  const [s0, s1] = flatSpan();
  if (!state.flatWin) return { w0: s0, w1: s1 };
  return { w0: state.flatWin.t0, w1: state.flatWin.t1 };
}
let _fw = { w0: 0, w1: 1 };        // buildLines 시점에 고정된 창 — 모든 좌표 함수가 이걸 공유
const xFlat = t => ((t - _fw.w0) / (_fw.w1 - _fw.w0) - 0.5) * FLAT_W;
// 창 변경 → rAF 스로틀 재구축 (휠/드래그 연타에 프레임당 1회만)
let _flatRAF = 0;
function setFlatWin(t0, t1) {
  const [s0, s1] = flatSpan();
  const span = Math.max(600, Math.min(t1 - t0, s1 + FUTURE_PAD - s0));   // 최소 10분
  t0 = clamp(t0, s0, s1 + FUTURE_PAD - span); t1 = t0 + span;
  state.flatWin = (t0 <= s0 + 1 && t1 >= s1 - 1) ? null : { t0, t1 };    // 전체와 같으면 null로 정규화
  if (!_flatRAF) _flatRAF = requestAnimationFrame(() => { _flatRAF = 0; rebuild(); });
}
```

### Step 4 — buildLines의 2D 분기

`function buildLines(report) {` 안에서:

**(a)** `const maxDay = Math.max(1, report.spanDays || 0, lastDay, ...runs.map(r => r.dayIndex));` 앵커 **바로 아래**에:

```js
  const flat = state.view === 'flat';
  if (flat) { const w = flatWindow(); _fw = w; }
  const pad = flat ? (_fw.w1 - _fw.w0) * 0.02 : 0;   // 창 가장자리에서 선이 뚝 끊기지 않게 살짝 여유
```

**(b)** 점 좌표를 넣는 앵커 줄
`pos.push(xFromTod(todOf(p.t)), yFromVal(yv, yMax), zFromDay(d, maxDay));  // X=시각, Y=값, Z=날짜(점별)`
을 아래로 **교체**:

```js
      if (flat && (p.t < _fw.w0 - pad || p.t > _fw.w1 + pad)) { flush(); continue; }   // 창 밖 점은 스킵(선분 단절)
      if (flat) pos.push(xFlat(p.t), yFromVal(yv, yMax), 0);                            // X=연속 시간, Z=0 평면
      else pos.push(xFromTod(todOf(p.t)), yFromVal(yv, yMax), zFromDay(d, maxDay));     // X=시각, Y=값, Z=날짜(점별)
```

⚠️ 주의: `flush(); continue;` 는 창 밖으로 나갔다가 돌아오는 run을 두 개의 선분으로 쪼갠다 — 의도된 동작.

**(c)** 자정 분할 앵커 `if (curDay !== null && d !== curDay) flush();             // split at midnight: no cross-day diagonal`
을 아래로 **교체** (2D는 시간축이 이어지므로 자정에 쪼갤 이유가 없음):

```js
      if (!flat && curDay !== null && d !== curDay) flush();    // 3D만 자정 분할 (2D는 연속)
```

**(d) 성능 가드** — (b)에서 만든 창-스킵 분기 **바로 위**(for 루프 안 `pi++;` 다음)에:

```js
      if (flat && flatStride > 1 && (pi % flatStride) !== 0) continue;   // 넓은 창 다운샘플
```

그리고 (a) 블록 아래에 stride 계산 추가:

```js
  // 넓은 창에서 점이 5만 개를 넘으면 stride 간격으로 건너뛰어 재구축을 가볍게 유지
  let flatStride = 1;
  if (flat) {
    const total = runs.reduce((s, r) => s + r.points.length, 0);
    const frac = Math.min(1, (_fw.w1 - _fw.w0) / (flatSpan()[1] - flatSpan()[0]));
    flatStride = Math.max(1, Math.ceil(total * frac / 50000));
  }
```

### Step 5 — 2D 축·격자: buildFlatAxes 신설

`function buildAxes(...)` **함수 전체 바로 아래**에 신설 (3D 쪽은 절대 수정 금지):

```js
// 2D 시간축 모드의 축·격자: 세로선 = 날짜/시간 눈금, 가로선 = 값 눈금. 모두 z=0 평면(XY)에 그린다.
function buildFlatAxes(valMax, valLabel) {
  disposeGroup(sceneRoot);
  const x0 = -FLAT_W / 2, x1 = FLAT_W / 2;
  const signed = isSignedY();
  const baseY = signed ? Y / 2 : 0;
  const { w0, w1 } = _fw;
  const spanH = (w1 - w0) / 3600;

  // 값(가로) 격자선 + 라벨 — 3D buildAxes의 Y 눈금 5개와 같은 수식
  for (let i = 0; i <= 4; i++) {
    const v = signed ? valMax * (i / 2 - 1) : valMax * i / 4, y = Y * i / 4;
    sceneRoot.add(axisLine([x0, y, 0], [x1, y, 0], i === (signed ? 2 : 0) ? (signed ? 0x4dd0c0 : TH().gMain) : TH().gMinor));
    const s = makeLabel(state.y === 'pct' ? `${Math.round(v)}%` : state.y === 'rate' ? v.toFixed(2) : `${v.toFixed(0)}W`, { size: 28, color: TH().tickC });
    s.position.set(x0 - 2.2, y, 0); sceneRoot.add(s);
  }
  const yt = makeLabel(tr(valLabel), { color: TH().titleC }); yt.position.set(x0 - 4.5, Y + 1, 0); sceneRoot.add(yt);

  // 시간(세로) 눈금 — 창 폭에 따라 밀도 자동: ≤48h는 3시간 간격, 그 위는 자정(일 단위, 최대 ~12개)
  const ticks = [];
  if (spanH <= 48) {
    const step = spanH <= 12 ? 1 : 3;                              // 시간 간격
    const d = new Date(w0 * 1000); d.setMinutes(0, 0, 0);
    for (let t = d.getTime() / 1000; t <= w1; t += step * 3600) {
      if (t < w0) continue;
      const dd = new Date(t * 1000);
      ticks.push([t, dd.getHours() === 0 ? `${dd.getMonth() + 1}/${dd.getDate()}` : tr(`${dd.getHours()}시`), dd.getHours() === 0]);
    }
  } else {
    const days = Math.ceil(spanH / 24), stepD = Math.max(1, Math.ceil(days / 12));
    const d = new Date(w0 * 1000); d.setHours(0, 0, 0, 0);
    for (let t = d.getTime() / 1000; t <= w1; t += stepD * 86400) {
      if (t < w0) continue;
      const dd = new Date(t * 1000);
      ticks.push([t, `${dd.getMonth() + 1}/${dd.getDate()}`, true]);
    }
  }
  for (const [t, label, major] of ticks) {
    const x = xFlat(t);
    sceneRoot.add(axisLine([x, 0, 0], [x, Y, 0], major ? TH().gMain : TH().gMinor));
    const s = makeLabel(label, { size: 26, color: TH().tickC }); s.position.set(x, baseY - 1, 0); sceneRoot.add(s);
  }
  // 주말 음영: 창 안의 토·일 하루 구간을 옅은 판으로 (라이트/다크 공용 — 낮은 불투명도)
  const wd = new Date(w0 * 1000); wd.setHours(0, 0, 0, 0);
  for (let t = wd.getTime() / 1000; t < w1; t += 86400) {
    const day = new Date(t * 1000).getDay();
    if (day !== 0 && day !== 6) continue;
    const a = Math.max(t, w0), b = Math.min(t + 86400, w1);
    if (b <= a) continue;
    const geo = new THREE.PlaneGeometry(xFlat(b) - xFlat(a), Y);
    const mat = new THREE.MeshBasicMaterial({ color: TH().gMain, transparent: true, opacity: 0.10, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.set((xFlat(a) + xFlat(b)) / 2, Y / 2, -0.05);   // 곡선(z=0)보다 살짝 뒤
    sceneRoot.add(m);
  }
  const xt = makeLabel(tr('날짜/시간 →'), { color: TH().titleC }); xt.position.set(0, baseY - 2.6, 0); sceneRoot.add(xt);
}
```

⚠️ `axisLine` 은 기존 헬퍼(grep `function axisLine`) — 시그니처가 `axisLine([x,y,z],[x,y,z],color)` 인지 먼저 확인하고 다르면 맞출 것.

### Step 6 — rebuild 분기 + 카메라 고정 + setView

**rebuild()**: 앵커 `buildAxes(yMax, yLabel(), maxDay, r.firstT);` 를 아래로 **교체**:

```js
  if (state.view === 'flat') buildFlatAxes(yMax, yLabel()); else buildAxes(yMax, yLabel(), maxDay, r.firstT);
```

같은 함수에서 `drawNowMarker(r, yMax, maxDay);` **바로 아래**에:

```js
  syncFlatUI();   // 미니맵·기간 세그 표시/갱신 (flat 모드에서만 보임)
```

**setView + 카메라**: `function setXScale(v) {` **바로 위**에 신설:

```js
// 보기 모드 전환: 2D는 카메라를 정면 고정하고 OrbitControls를 끈다(팬/줌은 시간 창으로).
function setView(v) {
  state.view = v === 'flat' ? 'flat' : '3d';
  try { localStorage.setItem('battView', state.view); } catch { /* ignore */ }
  if (state.view === 'flat') { controls.enabled = false; fitFlatCamera(); }
  else { controls.enabled = true; camera.position.copy(HOME).multiplyScalar(0.6 + 0.4 * state.xScale); controls.target.copy(LOOK); }
  rebuild();
}
// 정면 카메라: FLAT_W가 화면 가로에 (여유 6%로) 꽉 차는 거리 D를 fov/종횡비로 계산
function fitFlatCamera() {
  const vFov = camera.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const D = (FLAT_W / 2 * 1.06) / Math.tan(hFov / 2);
  camera.position.set(0, Y / 2, D);
  camera.lookAt(0, Y / 2, 0);
}
```

**resize 핸들러**: 앵커 `camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();` **바로 아래**에:

```js
  if (state.view === 'flat') fitFlatCamera();
```

**animate 루프**: `controls.update();` 를 `if (controls.enabled) controls.update();` 로 교체.

**초기화**: main.js 마지막의 초기 `load()` 호출부 근처(grep `load();` 하단부)에서, 첫 load 전에 `if (state.view === 'flat') { controls.enabled = false; fitFlatCamera(); }` 를 한 번 실행.

**자동회전 체크박스**(`id="spin"`)와 **시점 리셋**(`id="reset"`) 핸들러를 grep으로 찾아, flat 모드일 때: spin은 무시(`if (state.view === 'flat') return;` 추가), reset은 `state.flatWin = null; rebuild();` 로 분기.

### Step 7 — 휠 줌·드래그 팬·더블클릭 (2D 전용 입력)

`renderer.domElement.addEventListener('pointerdown', e => { downXY = ...` 앵커 근처(호버 코드 블록 끝)에 추가:

```js
// ---- 2D 시간축 내비게이션: 휠 = 커서 중심 줌 · 드래그 = 팬 · 더블클릭 = 전체 ----
function flatTimeAtScreen(cx) {   // 화면 x(px) → epoch 초 (고정 카메라의 z=0 평면 교점)
  const ndc = new THREE.Vector3((cx / innerWidth) * 2 - 1, 0, 0.5).unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const k = -camera.position.z / dir.z;
  const wx = camera.position.x + dir.x * k;
  return _fw.w0 + (wx / FLAT_W + 0.5) * (_fw.w1 - _fw.w0);
}
renderer.domElement.addEventListener('wheel', e => {
  if (state.view !== 'flat') return;
  e.preventDefault();
  const { w0, w1 } = flatWindow();
  const f = e.deltaY > 0 ? 1.25 : 1 / 1.25;                     // 아래로 굴리면 축소
  const ct = clamp(flatTimeAtScreen(e.clientX), w0, w1);
  const r = (ct - w0) / (w1 - w0);
  const span = (w1 - w0) * f;
  setFlatWin(ct - span * r, ct + span * (1 - r));
}, { passive: false });
let flatDrag = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (state.view !== 'flat') return;
  flatDrag = { x: e.clientX, w0: flatWindow().w0, w1: flatWindow().w1 };
});
addEventListener('pointermove', e => {
  if (!flatDrag || state.view !== 'flat') return;
  const dt = -(e.clientX - flatDrag.x) / innerWidth * (flatDrag.w1 - flatDrag.w0) / 0.94;   // 1.06 여유 보정
  setFlatWin(flatDrag.w0 + dt, flatDrag.w1 + dt);
});
addEventListener('pointerup', () => { flatDrag = null; });
renderer.domElement.addEventListener('dblclick', () => { if (state.view === 'flat') { state.flatWin = null; rebuild(); } });
```

⚠️ 함정: 기존 `pointerup` 핸들러의 클릭-고정(pin) 로직은 `moved > 5` 검사로 드래그와 구분하므로 그대로 두면 충돌하지 않는다. **건드리지 말 것.**

### Step 8 — 기간 프리셋

Step 6의 setView 아래에 신설:

```js
function applyFlatRange(v) {
  const [s0, s1] = flatSpan();
  if (v === 'all') { state.flatWin = null; rebuild(); return; }
  if (v === 'end') { const { w0, w1 } = flatWindow(); const span = w1 - w0; setFlatWin(s1 - span, s1); return; }
  const H = { '30d': 720, '7d': 168, '24h': 24 }[v]; if (!H) return;
  setFlatWin(s1 - H * 3600, s1);
}
```

### Step 9 — 예상선·현재 마커의 2D 분기

**drawNowMarker**: 앵커 `const pos = new THREE.Vector3(xFromTod(todOf(L.t)), yFromVal(lvl, yMax), zFromDay(day, maxDay));` 를 아래로 교체:

```js
  const pos = state.view === 'flat'
    ? new THREE.Vector3(xFlat(L.t), yFromVal(lvl, yMax), 0)
    : new THREE.Vector3(xFromTod(todOf(L.t)), yFromVal(lvl, yMax), zFromDay(day, maxDay));
  if (state.view === 'flat' && (L.t < _fw.w0 || L.t > _fw.w1)) return;   // 창 밖이면 생략
```

**drawProjection3DInner**: 함수 안에서 점 좌표를 만드는 곳이 3곳이다(앵커: `segs[segs.length - 1].push(new THREE.Vector3(xFromTod(todOf(rt)),` · `const sp = new THREE.Vector3(xFromTod(todOf(P.baseT)),` · `const p = new THREE.Vector3(xFromTod(todOf(rt)),`). 함수 첫머리에 다음 헬퍼를 추가하고:

```js
  const flat = state.view === 'flat';
  const posOf = (rt, lvl) => flat
    ? new THREE.Vector3(xFlat(rt), yFromVal(lvl, projYMax), 0)
    : null;   // null이면 기존 3D 경로 사용
```

세 앵커 각각을 `flat ? posOf(rt, lvl값) : (기존식)` 형태로 감싼다. 또한 자정 wrap 분할 조건(grep `day !== curDay` 또는 해당 함수 내 세그 분할 조건)을 `!flat && (기존 조건)` 으로 바꿔 **2D에서는 한 줄로 이어지게** 한다. 예상선이 창 오른쪽 밖(미래)으로 나가면 그대로 두되(카메라 밖으로 잘려 보임), `xFlat(rt)` 가 `FLAT_W` 를 크게 초과하는 점은 push하지 않는다: `if (flat && rt > _fw.w1 + (_fw.w1 - _fw.w0)) break;` 를 루프에 추가.

### Step 10 — 미니맵 브러시

Step 8 아래에 신설. 전체 코드를 그대로 넣는다:

```js
// ---- 미니맵 브러시: 전체 기간의 잔량 개형 + 현재 창. 드래그=이동, 가장자리=크기, 클릭=점프 ----
function syncFlatUI() {
  const mini = document.getElementById('flatMini'), rng = document.getElementById('flatRangeGrp');
  const on = state.view === 'flat';
  if (mini) mini.hidden = !on;
  if (rng) rng.hidden = !on;
  const xs = document.querySelector('[data-group="xScale"]');
  if (xs) xs.parentElement.style.display = on ? 'none' : '';   // 3D 전용 배율 세그는 숨김
  if (on) drawFlatMini();
}
function drawFlatMini() {
  const cv = document.getElementById('flatMiniCv'); if (!cv || !state.report) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
  if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  const [s0, s1] = flatSpan(); const { w0, w1 } = flatWindow();
  const xOf = t => (t - s0) / (s1 - s0) * W;
  // 잔량 개형(600버킷 평균) — 어두운/밝은 테마 공용 잉크
  const buckets = new Array(600).fill(null);
  for (const r of (state.report.runs || [])) for (const p of r.points) {
    const v = levelPct(p); if (v == null) continue;
    const b = clamp(Math.floor((p.t - s0) / (s1 - s0) * 600), 0, 599);
    buckets[b] = buckets[b] == null ? v : (buckets[b] + v) / 2;
  }
  g.strokeStyle = state.theme === 'light' ? '#4a5570' : '#9aa7c4'; g.lineWidth = dpr;
  g.beginPath(); let pen = false;
  for (let b = 0; b < 600; b++) {
    if (buckets[b] == null) { pen = false; continue; }
    const x = b / 600 * W, y = H - buckets[b] / 100 * (H - 4 * dpr) - 2 * dpr;
    if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
  }
  g.stroke();
  // 현재 창
  g.fillStyle = state.theme === 'light' ? 'rgba(45,110,90,.18)' : 'rgba(90,200,160,.20)';
  g.fillRect(xOf(w0), 0, Math.max(2, xOf(w1) - xOf(w0)), H);
  g.strokeStyle = state.theme === 'light' ? '#2d6e5a' : '#5ac8a0'; g.lineWidth = dpr;
  g.strokeRect(xOf(w0) + 0.5, 0.5, Math.max(2, xOf(w1) - xOf(w0)) - 1, H - 1);
}
let miniDrag = null;   // {mode:'move'|'l'|'r'|'jump', startX, w0, w1}
(function wireMini() {
  const cv = document.getElementById('flatMiniCv'); if (!cv) return;
  const tAt = e => { const r = cv.getBoundingClientRect(); const [s0, s1] = flatSpan(); return s0 + (e.clientX - r.left) / r.width * (s1 - s0); };
  cv.addEventListener('pointerdown', e => {
    const { w0, w1 } = flatWindow(); const t = tAt(e);
    const r = cv.getBoundingClientRect(); const [s0, s1] = flatSpan();
    const pxT = (s1 - s0) / r.width;                                   // 1px가 몇 초인가
    const edge = 5 * pxT;
    const mode = Math.abs(t - w0) < edge ? 'l' : Math.abs(t - w1) < edge ? 'r' : (t > w0 && t < w1) ? 'move' : 'jump';
    if (mode === 'jump') { const span = w1 - w0; setFlatWin(t - span / 2, t + span / 2); return; }
    miniDrag = { mode, startT: t, w0, w1 };
    try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  cv.addEventListener('pointermove', e => {
    if (!miniDrag) return;
    const t = tAt(e), d = t - miniDrag.startT;
    if (miniDrag.mode === 'move') setFlatWin(miniDrag.w0 + d, miniDrag.w1 + d);
    else if (miniDrag.mode === 'l') setFlatWin(Math.min(t, miniDrag.w1 - 600), miniDrag.w1);
    else setFlatWin(miniDrag.w0, Math.max(t, miniDrag.w0 + 600));
  });
  cv.addEventListener('pointerup', () => { miniDrag = null; });
})();
```

그리고 **rebuild() 안의 `syncFlatUI();`(Step 6에서 추가)가 창 변경 때마다 미니맵을 다시 그린다** — 별도 훅 불필요.

### Step 11 — 새 데이터 도착 시 창 추적

`load()` 안에서 `state.report = await res.json();` **바로 아래**에:

```js
    // 2D에서 창이 끝(최신)에 붙어 있었다면, 새 샘플이 들어와도 계속 끝을 따라간다
    if (state.view === 'flat' && state.flatWin) {
      const [, s1] = flatSpan();
      if (state.flatWin.t1 >= s1 - 180) { const span = state.flatWin.t1 - state.flatWin.t0; state.flatWin = { t0: s1 - span, t1: s1 }; }
    }
```

## 4. 하지 말 것 (함정 목록)

1. **`camera` 변수를 새 카메라로 교체하지 말 것** — pickAt·animate 툴팁 투영·projTag가 전부 그 변수를 참조한다. 위치만 옮긴다.
2. **buildAxes(3D)·xFromTod·zFromDay를 수정하지 말 것** — 3D 모드는 한 픽셀도 달라지면 안 된다.
3. `state` 리터럴에 키를 추가할 땐 **기존 줄을 건드리지 말고** Step 1의 블록만 추가.
4. en.json에 **중복 키 금지** — 추가 후 §7의 파이썬 검사 필수 (전에 "온도" 중복 사고 있었음).
5. 미니맵은 `#pop`류 innerHTML 재구축 영역이 아닌 **body 직속/`#view` 섹션 밖 고정 오버레이**로 — index.html의 legend 옆이면 안전.
6. 휠 핸들러는 반드시 `{ passive: false }` + `preventDefault()` — 아니면 페이지가 스크롤된다.
7. `setFlatWin` 밖에서 `state.flatWin`을 직접 대입하지 말 것(클램프를 건너뛰게 됨). 예외: 'all' 리셋(`null` 대입)만 허용.
8. 데모 소스(demo/demo2)에서도 2D가 그대로 동작해야 한다 — `report.firstT/latest`는 데모에도 있다. 특별 처리 금지.
9. 커밋에 `data/` 절대 포함 금지. 커밋 정체성: `GIT_AUTHOR_NAME='Kim Dongryeong' GIT_AUTHOR_EMAIL='dongryeong.kim@gmail.com'` + 같은 값의 COMMITTER 환경변수, 트레일러 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
10. 라이트 테마가 기본값 — 새 색은 반드시 두 테마 다 지정(위 코드처럼 `state.theme==='light' ? A : B`).

## 5. 검증 절차 (순서대로 전부)

```bash
node --check web/main.js
python3 - <<'EOF'
import re, collections
src = open('web/locales/en.json').read()
keys = re.findall(r'"((?:[^"\\]|\\.)*)"\s*:', src)
print('dup:', [k for k,c in collections.Counter(keys).items() if c>1])
EOF
npm test
# 헤드리스 렌더 (⚠️ --disable-gpu 금지 — WebGL이 죽는다. swiftshader 필수)
PORT=4399 node server.js & sleep 1.5
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --use-angle=swiftshader --enable-unsafe-swiftshader --virtual-time-budget=15000 \
  --window-size=1400,1000 --screenshot=/tmp/flat.png "http://localhost:4399/?view=flat"
# → 스크린샷에서: 가로로 긴 시간축 + 날짜 눈금 + 미니맵이 보여야 함. 3D도 회귀 확인: ?view=3d
```

수동 체크리스트(스크린샷/실행으로 확인 후 각 항목을 보고에 명시):
- [ ] 3D↔2D 토글이 즉시 전환되고, 3D는 기존과 픽셀 단위로 동일
- [ ] 2D에서 전체 기간이 한 눈에, 날짜 눈금 겹침 없음 (≤12개)
- [ ] 휠 줌이 커서 위치를 중심으로 동작, 10분 아래로 안 내려감
- [ ] 드래그 팬 + 미니맵(이동/양끝 리사이즈/바깥 클릭 점프) 동작
- [ ] 프리셋 전체/30일/7일/24h/오늘로 동작
- [ ] 호버 툴팁·클릭 고정, 예상선(방전·충전)이 2D에서 미래 방향으로 이어짐, '현재' 점 표시
- [ ] 색상 5종·라이트/다크·EN 전환 정상, `?view=flat` 딥링크·새로고침 유지
- [ ] 창을 최신 끝에 두고 1분 대기 → 새 샘플 도착 시 창이 따라감

## 6. 배포·커밋

```bash
bash scripts/build-app.sh --native
pkill -f "3D Battery Life"; sleep 1
rm -rf "/Applications/3D Battery Life.app"
ditto "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/3D Battery Life.app" "/Applications/3D Battery Life.app"
open "/Applications/3D Battery Life.app"
```
커밋은 기능 단위 1~2개(코어 + 미니맵/프리셋), push까지. **kdr은 /Applications 사본을 실행하므로 dev 번들만 열고 끝내면 안 된다.**

## 7. 수용 기준 (전부 만족해야 완료)

§5 체크리스트 전 항목 + `npm test` 통과 + 3D 모드 무회귀 + `?view=flat` 스크린샷 확보. 완료 보고에는 스크린샷 경로와 체크리스트 결과를 포함할 것.
