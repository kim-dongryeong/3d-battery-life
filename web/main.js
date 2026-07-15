import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initI18n, observeI18n, tr, curLang, t } from './i18n.js';
import * as FV from './flatViewport.js';   // 2D 시간 창 상태 전이 (순수 모듈, tests/flatViewport.test.js)

// ---- world dimensions ---------------------------------------------------
// X = 하루 중 시각 (0..24h)  ·  Y = 배터리 %/W (높이)  ·  Z = 경과 일수 (깊이)
// (kdr 호칭: 그가 부르는 x=날짜=내 Z · y=시각=내 X · z=잔량=내 Y — 그래프는 그대로, 명칭만 매핑)
const X_BASE = 24, Y = 16, Z = 44;
let X = X_BASE;                                          // effective time-axis width — stretchable via state.xScale
const xFromTod = h => (h - 12) / 24 * X;                 // 0시 -> -X/2, 24시 -> +X/2

// ---- 2D 연속 시간축 (state.view === 'flat') ----------------------------------------------------
const FLAT_W = 72;                    // 2D 시간축의 월드 폭 (3D의 X=24보다 넓게)
let _fw = { w0: 0, w1: 1 };           // buildLines 시점에 고정된 보이는 창 — 좌표·축·예상선이 공유
const xFlat = tt => ((tt - _fw.w0) / (_fw.w1 - _fw.w0) - 0.5) * FLAT_W;
const flatSpanNow = () => FV.span(state.report);
// 창 적용: 이미 flatViewport 전이 함수로 정규화된 창(null 허용)만 받는다. rAF 스로틀 재구축.
let _flatRAF = 0;
function applyFlatWin(win) {
  state.flatWin = win;
  if (!_flatRAF) _flatRAF = requestAnimationFrame(() => { _flatRAF = 0; rebuild(); });
}

// ---- state --------------------------------------------------------------
const state = { source: 'real', y: 'pct', color: 'state', report: null, rates: null, detail: null, chargeRates: null, chargeCompare: '', rateVersion: 'v4a_pooled', rateLevel: 'rawcap', rateWin: 300, markerSize: 0.2, wattsRail: 'battery', powerMethod: 'balance', floorGuide: 'on', valGuide: 'step', projDis: 'on', projChg: 'on', selectedBand: null, selectedPeriod: null, trendAll: true, trendBig: false, trendMore: false, trendView: '3d', trendGeom: 'lines', period: 'day', metric: 'rate', delta: false, zeroMode: 'both', tickDate: 2, tickBand: 2, tickVal: 2, gridMain: 'lines' };
// 뷰어 기본 = 다크 (kdr 2026-07-12: 팝오버는 라이트, 뷰어는 다크). 팝오버와 키를 분리
// (battTheme는 팝오버 몫) — 같은 키를 쓰면 한쪽 설정이 다른 쪽 기본값을 덮어쓴다.
state.theme = (() => { try { return localStorage.getItem('battViewerTheme') || 'dark'; } catch { return 'dark'; } })();
state.ui = '1';       // 테마 스킨 셀렉터 제거 — 기본 고정 (프리셋 코드는 유지)
state.layout = 'a';   // 대시보드 고정 — 대체 레이아웃 셀렉터 제거 (코드는 유지)
state.tab = '3d';
state.showTicks = false;   // 추세 눈금 밀도 조절 줄 — 기본 숨김(헤더 소음 감소), '눈금' 버튼으로 토글
state.foldBuckets = (() => { try { return localStorage.getItem('battFoldB') === '1'; } catch { return false; } })();
state.foldTrend = (() => { try { return localStorage.getItem('battFoldT') === '1'; } catch { return false; } })();
state.xScale = (() => {
  try {
    const q = +new URLSearchParams(location.search).get('xs');   // ?xs=2 deep-link (shareable view)
    if (q >= 1 && q <= 3) return q;
    return Math.min(3, Math.max(1, +localStorage.getItem('battXScale') || 1));
  } catch { return 1; }
})();
X = X_BASE * state.xScale;   // apply the saved time-axis stretch before the first build
// ---- 보기 모드: '3d'(시각×날짜) | 'flat'(연속 시간축 2D). 딥링크 ?view=flat 우선.
state.view = (() => {
  try {
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'flat' || q === '3d') return q;
    return localStorage.getItem('battView') === 'flat' ? 'flat' : '3d';
  } catch { return '3d'; }
})();
state.flatWin = null;   // 2D 보이는 시간 창 {t0,t1}(epoch 초) · null = 전체 — 전이는 web/flatViewport.js 경유만
// deep-linkable view (shareable): ?y=pct|watts|rate · ?color=state|lowPower|tempC|loadPct|watts
try {
  const q = new URLSearchParams(location.search);
  if (['pct', 'watts', 'rate'].includes(q.get('y'))) state.y = q.get('y');
  if (['state', 'lowPower', 'tempC', 'loadPct', 'watts'].includes(q.get('color'))) state.color = q.get('color');
} catch { /* ignore */ }
try { const w = +localStorage.getItem('battRateWin'); if ([120, 300, 600, 1200].includes(w)) state.rateWin = w; } catch { /* ignore */ }
try { const m = +localStorage.getItem('battMarkerSize'); if ([0.12, 0.2, 0.32].includes(m)) state.markerSize = m; } catch { /* ignore */ }
try { const r = localStorage.getItem('battWattsRail'); if (['battery', 'system', 'adapter'].includes(r)) state.wattsRail = r; } catch { /* ignore */ }
try { const c = localStorage.getItem('battFloorGuide'); if (['on', 'off'].includes(c)) state.floorGuide = c; } catch { /* ignore */ }
try { const c = localStorage.getItem('battValGuide'); if (['diag', 'step', 'dot', 'plane', 'off'].includes(c)) state.valGuide = c; } catch { /* ignore */ }
try { const l = localStorage.getItem('battRateLevel'); if (l === 'pct' || l === 'rawcap') state.rateLevel = l; } catch { /* ignore */ }   // '정수% 사용' 전역 설정
try { const m = localStorage.getItem('battPowerMethod'); if (['balance', 'ioreg', 'hybrid'].includes(m)) state.powerMethod = m; } catch { /* ignore */ }   // 배터리 전력 측정 방식(그래프+구간별)
try {   // 3D 방전/충전 예상선 표시 (각각 독립 on/off) — 구버전 battProjLine을 방전 기본값으로 승계
  const old = localStorage.getItem('battProjLine');
  const pd = localStorage.getItem('battProjDis') ?? old, pc = localStorage.getItem('battProjChg');
  if (['on', 'off'].includes(pd)) state.projDis = pd;
  if (['on', 'off'].includes(pc)) state.projChg = pc;
} catch { /* ignore */ }
try { const q = new URLSearchParams(location.search).get('level'); if (q === 'pct' || q === 'rawcap') state.rateLevel = q; } catch { /* ignore */ }   // ?level= deep-link (overrides)

// ---- color themes (dark / light) for WebGL scenes + SVG charts -----------
const THEMES = {
  dark: { sceneBg: 0x0a0c12, trendBg: 0x0c0f17, fog: [95, 220], gMain: 0x2a3043, gMinor: 0x171b27, axis: 0x4a5570, axisTick: 0x3a4258, scaffold: 0x9aa7c4, wire: 0x0a0c12, tickC: '#7f8aa3', titleC: '#aab3c8', svgText: '#8a93a6', svgAxis: '#2a3043', svgGrid: '#171b27', svgGrid0: '#3a4258', miss: '#11141c' },
  light: { sceneBg: 0xeef1f6, trendBg: 0xf4f6fa, fog: [120, 320], gMain: 0xc6cedd, gMinor: 0xe3e8f0, axis: 0x9aa6bd, axisTick: 0xc4ccda, scaffold: 0x7a86a0, wire: 0xffffff, tickC: '#566074', titleC: '#3a4252', svgText: '#566074', svgAxis: '#c4ccda', svgGrid: '#e4e9f1', svgGrid0: '#aab3c8', miss: '#e9edf4' },
};
const TH = () => THEMES[state.theme] || THEMES.dark;
document.documentElement.classList.toggle('light', state.theme === 'light');

// ---- three.js boilerplate ----------------------------------------------
const host = document.getElementById('scene');
const scene = new THREE.Scene();
scene.background = new THREE.Color(TH().sceneBg);
scene.fog = new THREE.Fog(TH().sceneBg, TH().fog[0], TH().fog[1]);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 1000);
const HOME = new THREE.Vector3(34, 26, 40), LOOK = new THREE.Vector3(0, Y / 2, 0);
camera.position.copy(HOME);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
host.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.copy(LOOK);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(20, 40, 30); scene.add(key);

const sceneRoot = new THREE.Group(); scene.add(sceneRoot);   // axes + grid (rebuilt on mode change)
const lineRoot = new THREE.Group(); scene.add(lineRoot);     // session curves
const overlay = new THREE.Group(); overlay.visible = false; scene.add(overlay);   // hover marker + guide lines (persists across rebuilds)
const projGroup = new THREE.Group(); scene.add(projGroup);   // 방전 예상선(현재→0%) — 배터리 % 모드에서만
const nowGroup = new THREE.Group(); scene.add(nowGroup);     // '현재' 위치 점(실시간 잔량) — 잔량 모드에서 항상
const intervalGroup = new THREE.Group(); scene.add(intervalGroup);   // 구간 전력량 강조 밴드(2D 시간축)
let projYMax = 100, projMaxDay = 1;   // stashed from the last buildLines so loadRates can redraw the projection alone
let pinned = null, curHover = null;   // 마커 고정 상태 · 현재 호버 결과 {vp,point,dayIndex,line}
let tipManual = false;                // 고정 툴팁을 드래그해 직접 배치했는지 → 그러면 마커 추적 중단

// ---- helpers ------------------------------------------------------------
const todOf = t => { const d = new Date(t * 1000); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const percentile = (arr, p) => { if (!arr.length) return 1; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// perceptual-ish ramp: blue -> cyan -> green -> yellow -> red
// magnitude ramp: cold(dim blue) → hot(bright orange) via violet — no green leg, so it
// stays ordered under red-green CVD (a full rainbow doesn't)
function ramp(t) {   // numeric color modes; light theme runs darker so 1px lines hold on white
  t = clamp(t, 0, 1);
  const h = ((215 + 180 * t) % 360) / 360;
  return state.theme === 'light'
    ? new THREE.Color().setHSL(h, 0.62 + 0.33 * t, 0.46 - 0.10 * t)
    : new THREE.Color().setHSL(h, 0.45 + 0.5 * t, 0.45 + 0.15 * t);
}

function makeLabel(text, { size = 38, color = '#cfd6e6' } = {}) {
  const pad = 6, c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = `600 ${size}px -apple-system, sans-serif`;
  c.width = g.measureText(text).width + pad * 2; c.height = size + pad * 2;
  g.font = `600 ${size}px -apple-system, sans-serif`; g.fillStyle = color;
  g.textBaseline = 'middle'; g.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(c.width / c.height * 1.6, 1.6, 1); sp.userData.isLabel = true;
  return sp;
}

// free GPU resources before clearing a group (rebuilds happen on every toggle)
function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
  });
  group.clear();
}

function axisLine(a, b, color) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
}

// ---- axes / grid --------------------------------------------------------
// X = 하루 중 시각, Y = 배터리 %/W (높이), Z = 경과 일수 (깊이)
const zFromDay = (d, maxDay) => (d / Math.max(1, maxDay)) * Z - Z / 2;
const yFromVal = (v, valMax) => isSignedY()
  ? clamp((v + valMax) / (2 * (valMax > 0 ? valMax : 1)), 0, 1) * Y   // signed: −valMax→floor, 0→중앙, +valMax→top
  : clamp(v / (valMax > 0 ? valMax : 1), 0, 1) * Y;

function buildAxes(valMax, valLabel, maxDay, firstT) {
  disposeGroup(sceneRoot);
  const x0 = -X / 2, z0 = -Z / 2, z1 = Z / 2;
  const signed = isSignedY();                                       // 잔량 변화율·배터리 전력: 바닥·축·눈금을 0(충전↔방전 경계)에 붙인다
  const baseY = signed ? Y / 2 : 0;
  const axC = signed ? 0x4dd0c0 : TH().axis;                        // 0 평면 축은 청록으로 강조

  const gsize = Math.max(Z, X);                                    // floor must cover the stretched time axis
  const grid = new THREE.GridHelper(gsize, Math.round(gsize / 2), TH().gMain, TH().gMinor);
  grid.position.y = baseY;                                         // rate 모드: 바닥격자 = 0-변화율 평면
  sceneRoot.add(grid);

  sceneRoot.add(axisLine([x0, baseY, z0], [X / 2, baseY, z0], axC));   // X = 시각 (0 평면에 붙음)
  sceneRoot.add(axisLine([x0, 0, z0], [x0, Y, z0], TH().axis));        // Y = 값 (수직 전체: −max..0..+max)
  sceneRoot.add(axisLine([x0, baseY, z0], [x0, baseY, z1], axC));      // Z = 날짜 (0 평면에 붙음)

  // X ticks: hours
  for (const h of [0, 6, 12, 18, 24]) {
    const s = makeLabel(tr(`${h}시`), { size: 30, color: TH().tickC }); s.position.set(xFromTod(h), baseY - 1, z0 - 1.2); sceneRoot.add(s);
  }
  const xt = makeLabel(tr('하루 중 시각 →'), { color: TH().titleC }); xt.position.set(0, baseY - 2.6, z0 - 2); sceneRoot.add(xt);

  // Y ticks: battery %/watts run 0..max · 잔량 변화율은 부호축(−max..0..+max, 0=바닥격자 평면)
  for (let i = 0; i <= 4; i++) {
    const v = signed ? valMax * (i / 2 - 1) : valMax * i / 4, y = Y * i / 4;
    sceneRoot.add(axisLine([x0 - 0.3, y, z0], [x0, y, z0], TH().axisTick));
    const s = makeLabel(state.y === 'pct' ? `${Math.round(v)}%` : state.y === 'rate' ? v.toFixed(2) : `${v.toFixed(0)}W`, { size: 28, color: TH().tickC });
    s.position.set(x0 - 2.2, y, z0); sceneRoot.add(s);
  }
  const yt = makeLabel(tr(valLabel), { color: TH().titleC }); yt.position.set(x0 - 4.5, Y + 1, z0); sceneRoot.add(yt);

  // Z ticks: dates (older -> recent)
  const days = maxDay <= 1 ? [0] : [0, Math.round(maxDay / 2), maxDay];
  for (const d of days) {
    const date = new Date(((firstT || 0) + d * 86400) * 1000);
    const s = makeLabel(`${date.getMonth() + 1}/${date.getDate()}`, { size: 26, color: TH().tickC }); s.position.set(x0 - 1.5, baseY - 0.4, zFromDay(d, maxDay)); sceneRoot.add(s);
  }
  const zt = makeLabel(tr('경과 일수 (오래됨 → 최근)'), { color: TH().titleC }); zt.position.set(x0 - 2, baseY - 2.6, z1 - 6); sceneRoot.add(zt);
}

// 2D 시간축 모드의 축·격자 — 세로선 = 날짜/시간 눈금(DST 안전, Intl 라벨), 가로선 = 값 눈금.
// 전부 z=0 평면(XY). 3D buildAxes는 건드리지 않는다.
function buildFlatAxes(valMax, valLabel) {
  disposeGroup(sceneRoot);
  const x0 = -FLAT_W / 2, x1 = FLAT_W / 2;
  const signed = isSignedY();
  const baseY = signed ? Y / 2 : 0;

  // 값(가로) 격자선 + 라벨 — 3D buildAxes의 Y 눈금과 같은 수식
  for (let i = 0; i <= 4; i++) {
    const v = signed ? valMax * (i / 2 - 1) : valMax * i / 4, y = Y * i / 4;
    const mid = signed && i === 2;                            // 부호축의 0선(충전↔방전 경계)은 청록 강조
    sceneRoot.add(axisLine([x0, y, 0], [x1, y, 0], mid ? 0x4dd0c0 : (i === 0 ? TH().gMain : TH().gMinor)));
    const s = makeLabel(state.y === 'pct' ? `${Math.round(v)}%` : state.y === 'rate' ? v.toFixed(2) : `${v.toFixed(0)}W`, { size: 28, color: TH().tickC });
    s.position.set(x0 - 2.2, y, 0); sceneRoot.add(s);
  }
  // 값축 제목: 종전엔 좌측 끝(x0−4.5)에 두어 좌상단 HUD 패널에 가렸다 → 플롯 위 중앙으로 이동(패널과 충돌 없음)
  const yt = makeLabel(tr(valLabel), { color: TH().titleC }); yt.position.set(0, Y + 2, 0); sceneRoot.add(yt);

  // 시간(세로) 눈금 — flatViewport.calendarTicks: 라벨(≤12) + 세부선(≤64) 2단 사다리,
  // DST에도 로컬 자정/정시 유지. label=null 인 세부선은 선만 긋는다(줌 비례로 개수 변동).
  for (const tk of FV.calendarTicks(state.flatWin, flatSpanNow(), curLang())) {
    const x = xFlat(tk.t);
    if (x < x0 - 0.01 || x > x1 + 0.01) continue;
    sceneRoot.add(axisLine([x, 0, 0], [x, tk.label ? Y : Y * 0.985, 0], tk.major ? TH().gMain : TH().gMinor));
    if (tk.label) { const s = makeLabel(tk.label, { size: 26, color: TH().tickC }); s.position.set(x, baseY - 1, 0); sceneRoot.add(s); }
  }
  // 주말 음영: 창 안의 토·일 구간을 옅은 판으로 — 달력 연산으로 하루씩 전진(DST 안전)
  const d = new Date(_fw.w0 * 1000); d.setHours(0, 0, 0, 0);
  while (d.getTime() / 1000 < _fw.w1) {
    const a0 = d.getTime() / 1000, day = d.getDay();
    d.setDate(d.getDate() + 1);
    const b0 = d.getTime() / 1000;
    if (day !== 0 && day !== 6) continue;
    const a = Math.max(a0, _fw.w0), b = Math.min(b0, _fw.w1);
    if (b <= a) continue;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(xFlat(b) - xFlat(a), Y),
      new THREE.MeshBasicMaterial({ color: TH().gMain, transparent: true, opacity: 0.10, depthWrite: false }));
    m.position.set((xFlat(a) + xFlat(b)) / 2, Y / 2, -0.05);   // 곡선(z=0)보다 살짝 뒤
    sceneRoot.add(m);
  }
  const xt = makeLabel(tr('날짜/시간 →'), { color: TH().titleC }); xt.position.set(0, baseY - 2.6, 0); sceneRoot.add(xt);
}

// ---- battery curves (continuous runs: charge + discharge, gap-split) ----
// per-theme palette: WebGL lines are 1px, so the lightness tuned for the dark scene washes out
// on the light background — light theme gets darker, more saturated inks (incl. LPM yellow→ochre)
const CURVE_C = {
  dark: {
    dis: new THREE.Color().setHSL(0.02, 0.85, 0.55),   // red-orange
    chg: new THREE.Color().setHSL(0.33, 0.80, 0.50),   // green
    full: new THREE.Color().setHSL(0.55, 0.45, 0.50),  // dim blue
    lpm: new THREE.Color(0xffcc0a),                    // 저전력 ON (macOS systemYellow, matches live.rs)
    lpmOff: new THREE.Color(0x51617a),                 // 저전력 off / 기록 이전(unknown)
  },
  light: {
    dis: new THREE.Color().setHSL(0.02, 0.90, 0.42),
    chg: new THREE.Color().setHSL(0.33, 0.90, 0.30),
    full: new THREE.Color().setHSL(0.55, 0.60, 0.38),
    lpm: new THREE.Color(0xc79b00),
    lpmOff: new THREE.Color(0xb7c1d2),                 // recedes on white so the yellow pops
  },
};
const CC = () => CURVE_C[state.theme] || CURVE_C.dark;
const stateColor = p => (p.charging ? CC().chg : (p.ac ? CC().full : CC().dis));

// per-point SIGNED rate d(잔량)/dt in %/min over a short backward window.
// Uses the fine mAh-based level (p.cap, ~0.02% res) so the curve is smooth — pct is macOS's INTEGER %
// (60s samples), whose Δ is a useless 0/±1 staircase. Sign: + 충전(잔량↑) · − 방전(잔량↓).
// battery level for a point: precise mAh% (rawCap/rawMax, default) — or macOS integer % when the
// global '정수%' option is on (state.rateLevel==='pct'). Every %-based calc goes through this.
const levelPct = p => state.rateLevel === 'pct' ? p.pct : (p.cap != null ? p.cap : p.pct);
function windowedRates(points, winSec = 300) {
  const lvl = levelPct;
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i++) {
    if (lvl(points[i]) == null) continue;
    let j = i;
    while (j > 0 && points[i].t - points[j - 1].t <= winSec) j--;   // earliest point within the window (or run start)
    const dtMin = (points[i].t - points[j].t) / 60;
    if (dtMin <= 0 || lvl(points[j]) == null) continue;
    out[i] = (lvl(points[i]) - lvl(points[j])) / dtMin;            // signed %/min (+ charge / − discharge)
  }
  return out;
}

let lines = [];
function buildLines(report) {
  // detach the shared highlight material so disposeGroup doesn't free it
  if (hovered) { hovered.material = hovered.userData.base; hovered = null; }
  if (tip) tip.hidden = true;
  overlay.visible = false; pinned = null; curHover = null; tipManual = false; if (tip) tip.classList.remove('pinned');   // clear stale hover/pinned marker on rebuild
  disposeGroup(lineRoot); lines = [];
  const runs = report.runs || [];
  if (!runs.length) return { yMax: 100, maxDay: 1, cMin: null, cMax: null };

  // anchor day slices at LOCAL MIDNIGHT (not the first sample's clock time) — otherwise a run
  // crossing midnight isn't split there and draws a full-width wrap line across the scene
  const d0 = new Date((report.firstT || 0) * 1000); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime() / 1000;
  const dayOfT = t => Math.floor((t - t0) / 86400);
  // midnight anchor can push the last slice to spanDays+1 — include it so Z never overshoots the grid
  const lastDay = runs.length ? dayOfT(runs[runs.length - 1].points[runs[runs.length - 1].points.length - 1].t) : 0;
  const maxDay = Math.max(1, report.spanDays || 0, lastDay, ...runs.map(r => r.dayIndex));
  // 2D 연속 시간축: 이 빌드에서 쓸 창을 고정하고, 창 폭 비례로 다운샘플 stride를 정한다
  const flat = state.view === 'flat';
  if (flat) {
    const sp = flatSpanNow();
    _fw = state.flatWin ? { w0: state.flatWin.t0, w1: state.flatWin.t1 } : { w0: sp.min, w1: sp.max };
  }
  const flatPad = flat ? (_fw.w1 - _fw.w0) * 0.02 : 0;   // 창 가장자리에서 선이 뚝 끊기지 않게 여유
  let flatStride = 1;
  if (flat) {
    const total = runs.reduce((s, r) => s + r.points.length, 0);
    const sp = flatSpanNow();
    const frac = Math.min(1, (_fw.w1 - _fw.w0) / Math.max(1, sp.max - sp.min));
    flatStride = Math.max(1, Math.ceil(total * frac / 50000));
  }
  const numeric = state.color !== 'state' && state.color !== 'lowPower';   // 'state'/'lowPower' are categorical, not ramped
  let cMin = null, cMax = null;
  if (numeric) {
    const vals = [];
    for (const r of runs) for (const p of r.points) { const v = p[state.color]; if (v != null) vals.push(v); }
    if (vals.length) {                                   // percentile-clamp so one outlier (e.g. a load spike) doesn't wash out the ramp
      cMin = percentile(vals, 0.02); cMax = percentile(vals, 0.98);
      if (cMax <= cMin) cMax = cMin + 1e-6;
    }
  }
  // 방전속도(%/min): per-point rate computed per run so the derivative spans midnight (only the drawn line splits)
  const runRates = state.y === 'rate' ? runs.map(r => windowedRates(r.points, state.rateWin)) : null;
  let yMax;
  if (state.y === 'rate') {
    const mags = runRates.flat().filter(v => v != null && Number.isFinite(v)).map(Math.abs);
    yMax = mags.length ? Math.max(0.1, percentile(mags, 0.98)) : 1;   // symmetric ±yMax; p98 so one spike doesn't flatten it
  } else if (state.y === 'pct') {
    yMax = 100;
  } else {   // watts: 배터리는 부호축이라 |값|의 p98(대칭 ±yMax), 시스템/어댑터는 값 그대로
    const sgn = isSignedY();
    const vals = runs.flatMap(r => r.points.map(wattValueOf)).filter(v => v != null).map(v => sgn ? Math.abs(v) : v);
    yMax = Math.max(5, vals.length ? percentile(vals, 0.98) : 5);
  }

  let ri = -1;
  for (const run of runs) {
    ri++;
    const rates = runRates ? runRates[ri] : null;
    let pos = [], col = [], pts = [], curDay = null, pi = -1;
    const flush = () => {
      if (pos.length >= 6) {                                    // >=2 vertices
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
        line.userData = { run, pts, dayIndex: curDay };
        lineRoot.add(line); lines.push(line);
      }
      pos = []; col = []; pts = [];
    };
    for (const p of run.points) {
      pi++;
      if (flat && (p.t < _fw.w0 - flatPad || p.t > _fw.w1 + flatPad)) { flush(); continue; }   // 창 밖 점 스킵(선분 단절)
      if (flat && flatStride > 1 && (pi % flatStride) !== 0) continue;                          // 넓은 창 다운샘플
      const yv = state.y === 'rate' ? (rates ? rates[pi] : null) : (state.y === 'pct' ? levelPct(p) : wattValueOf(p));   // 배터리 %는 정밀도, 전력은 레일+측정방식 설정
      if (yv == null || !Number.isFinite(yv)) { flush(); continue; }   // 값 없는 구간(예: 앱 미실행 시 systemW=null)은 선을 끊는다 — 빈 구간을 직선으로 잇지 않음
      const d = dayOfT(p.t);
      if (!flat && curDay !== null && d !== curDay) flush();    // 3D만 자정 분할 (2D는 시간축이 이어짐)
      curDay = d;
      if (flat) pos.push(xFlat(p.t), yFromVal(yv, yMax), 0);                                    // X=연속 시간, Z=0 평면
      else pos.push(xFromTod(todOf(p.t)), yFromVal(yv, yMax), zFromDay(d, maxDay));             // X=시각, Y=값, Z=날짜(점별)
      const c = numeric
        ? ramp(cMax > cMin && p[state.color] != null ? (p[state.color] - cMin) / (cMax - cMin) : 0.5)
        : state.color === 'lowPower' ? (p.lowPower ? CC().lpm : CC().lpmOff)
          : stateColor(p);
      col.push(c.r, c.g, c.b);
      if (state.y === 'rate') p._rate = yv;   // stash the signed rate so the hover tooltip can show it
      pts.push(p);
    }
    flush();
  }
  return { yMax, maxDay, cMin, cMax };
}

// ---- rebuild everything for current state -------------------------------
const COLOR_META = { state: { label: '상태', unit: '' }, lowPower: { label: '저전력 모드', unit: '' }, tempC: { label: '온도', unit: '°C' }, loadPct: { label: 'CPU 부하(load avg)', unit: '%' }, watts: { label: '전력', unit: 'W' } };
const Y_LABEL = { pct: '배터리 %', watts: '전력 W', rate: '잔량 변화 %/min (+충전/−방전)' };
// 배터리 레일은 부호 있는 powerW(방전 −/충전 +) — 시스템/어댑터는 단방향이라 크기 그대로.
const WRAIL = { battery: 'powerW', system: 'systemW', adapter: 'adapterW' };   // '전력 W' 그래프의 레일 → 포인트 필드
const WLABEL = { battery: '배터리 전력 W (+충전/−방전)', system: '시스템 전력 W', adapter: '어댑터 전력 W' };
const PM_LABEL = { balance: '수지 PDTR−PSTR', ioreg: 'ioreg V×I', hybrid: '혼합(방전 PPBR·충전 수지)' };
const yLabel = () => state.y === 'watts'
  ? (state.wattsRail === 'battery' ? `배터리 전력 W · ${PM_LABEL[state.powerMethod]} (+충전/−방전)` : WLABEL[state.wattsRail])
  : (Y_LABEL[state.y] || '배터리 %');
const wattField = () => WRAIL[state.wattsRail] || 'watts';
// Signed battery power W for the selected measurement method (배터리 레일). balance=PDTR−PSTR(=powerW),
// ioreg=ioreg V×I(ioregW), hybrid=방전 PPBR(음수)·충전 수지. Legacy rows missing a field fall back to
// powerW (old data's powerW already = ioreg V×I). Mirrors lib/bucketRates.js battWMag.
function battWatt(p) {
  const bal = p.powerW;
  if (state.powerMethod === 'ioreg') return p.ioregW != null ? p.ioregW : bal;
  if (state.powerMethod === 'hybrid') {
    const charging = bal != null ? bal > 0.05 : !!p.charging;
    if (!charging && p.ppbrW != null) return -Math.abs(p.ppbrW);
    return bal;
  }
  return bal;
}
const wattValueOf = p => state.wattsRail === 'battery' ? battWatt(p) : p[wattField()];
// 부호축(0을 중앙, 아래=음수)이 필요한 모드: 잔량 변화율 · 배터리 전력
const isSignedY = () => state.y === 'rate' || (state.y === 'watts' && state.wattsRail === 'battery');
// legend gradients follow the same per-theme curve inks as buildLines
const GRAD_NUM = () => state.theme === 'light'
  ? 'linear-gradient(90deg, hsl(215,62%,46%), hsl(260,70%,44%), hsl(305,78%,41%), hsl(350,87%,39%), hsl(35,95%,36%))'
  : 'linear-gradient(90deg, hsl(215,45%,45%), hsl(260,56%,49%), hsl(305,68%,52%), hsl(350,80%,56%), hsl(35,95%,60%))';
const GRAD_STATE = () => state.theme === 'light'
  ? 'linear-gradient(90deg, hsl(7,90%,42%) 0 33%, hsl(198,60%,38%) 50%, hsl(119,90%,30%) 66% 100%)'
  : 'linear-gradient(90deg, hsl(7,85%,55%) 0 33%, hsl(198,45%,50%) 50%, hsl(119,80%,50%) 66% 100%)';

function rebuild() {
  const rwg = document.getElementById('rateWinGrp');
  if (rwg) rwg.hidden = state.y !== 'rate';   // 평활 창 컨트롤은 방전속도(rate) 모드에서만
  const wrg = document.getElementById('wattsRailGrp');
  if (wrg) wrg.hidden = state.y !== 'watts';  // 전력 레일(배터리/시스템/어댑터)은 전력 W 모드에서만
  const r = state.report;
  document.getElementById('empty').hidden = !(r && (!r.runs || r.runs.length === 0));
  if (!r) return;
  const { yMax, maxDay, cMin, cMax } = buildLines(r);
  if (state.view === 'flat') buildFlatAxes(yMax, yLabel()); else buildAxes(yMax, yLabel(), maxDay, r.firstT);
  projYMax = yMax; projMaxDay = maxDay; drawProjection3D();   // 방전 예상선(현재→0%) 겹쳐 그리기
  drawNowMarker(r, yMax, maxDay);   // '현재' 위치 점 — 자다 깬 직후에도 지금 잔량을 찍어줌
  drawIntervalOverlay();            // 구간 전력량 넓이 음영(2D) — 창 팬/줌마다 다시 그림
  ivRecompute();                    // 그래프 계열이 바뀌면 구간 전력량 결과도 그 계열로 재계산
  syncFlatUI();                     // 2D 전용 UI(기간 세그·미니맵·힌트 문구) 표시/갱신

  const cm = COLOR_META[state.color];
  document.getElementById('legLbl').textContent = cm.label;
  const bar = document.querySelector('#legend .bar');
  if (state.color === 'state') {
    document.getElementById('legMin').textContent = '🔋방전';
    document.getElementById('legMax').textContent = '충전🔌';
    bar.style.background = GRAD_STATE();
  } else if (state.color === 'lowPower') {
    document.getElementById('legMin').textContent = '꺼짐';
    document.getElementById('legMax').textContent = '🟡 켜짐';
    bar.style.background = state.theme === 'light'
      ? 'linear-gradient(90deg, #b7c1d2 0 50%, #c79b00 50% 100%)'
      : 'linear-gradient(90deg, #51617a 0 50%, #ffcc0a 50% 100%)';
  } else {
    document.getElementById('legMin').textContent = cMin != null ? `${cMin.toFixed(0)}${cm.unit}` : '';
    document.getElementById('legMax').textContent = cMax != null ? `${cMax.toFixed(0)}${cm.unit}` : '';
    bar.style.background = GRAD_NUM();
  }
  updateHud(r);
}

const avgRate = bs => { const v = (bs || []).filter(b => b.pctPerMin); return v.length ? v.reduce((a, b) => a + b.pctPerMin, 0) / v.length : null; };

const fmtWhen = ms => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
};
const agoText = ms => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? '방금' : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
};
const fmtDur = sec => {                                     // 초 → "1일 3시간" / "5시간 20분" / "40분"
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};

// 배터리 건강도(=최대 용량, rawMax/design)의 일별 추세 — 작은 선그래프.
// 노화는 몇 달에 걸쳐 나타나므로 며칠짜리 기록은 거의 평평(펌웨어 재보정 노이즈 ±수 mAh).
function healthChartHTML(health) {
  const hs = (health || []).filter(h => h.healthPct != null);
  if (hs.length < 2) return '';
  const W = 240, H = 60, pL = 26, pR = 5, pT = 5, pB = 12;
  const hp = hs.map(h => h.healthPct), lo0 = Math.min(...hp), hi0 = Math.max(...hp);
  // 최소 스팬 8%p로 잡아 100% 부근 미세 변동이 급격해 보이지 않게 (실제 노화는 스팬을 키움)
  const mid = (lo0 + hi0) / 2, span = Math.max(8, (hi0 - lo0) * 3), yLo = mid - span / 2, yHi = mid + span / 2;
  const d0 = hs[0].day, dr = Math.max(1, hs[hs.length - 1].day - d0);
  const X = d => pL + (d - d0) / dr * (W - pL - pR);
  const Yv = v => pT + (1 - (v - yLo) / span) * (H - pT - pB);
  const line = hs.map(h => `${X(h.day).toFixed(1)},${Yv(h.healthPct).toFixed(1)}`).join(' ');
  const cur = hs[hs.length - 1], fdt = ts => { const d = new Date(ts * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const yLab = v => `<text x="${pL - 3}" y="${(Yv(v) + 2.6).toFixed(1)}" text-anchor="end" class="hcAx">${v.toFixed(0)}</text>`;
  const ref100 = (100 >= yLo && 100 <= yHi) ? `<line x1="${pL}" y1="${Yv(100).toFixed(1)}" x2="${W - pR}" y2="${Yv(100).toFixed(1)}" class="hcRef"/>` : '';
  return `<div class="hcHdr">건강도(최대 용량) 추세 <small>일별 · ${cur.rawMax ? `${cur.rawMax}mAh · ` : ''}${cur.healthPct}%</small></div>
    <svg class="hcSvg" viewBox="0 0 ${W} ${H}" width="100%">
      <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${H - pB}" class="hcAx2"/>
      ${ref100}${yLab(yHi)}${yLab(mid)}${yLab(yLo)}
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${pL}" y="${H - 2}" class="hcAx">${fdt(hs[0].t)}</text>
      <text x="${W - pR}" y="${H - 2}" text-anchor="end" class="hcAx">${fdt(hs[hs.length - 1].t)}</text>
    </svg>`;
}

// ── 방전 예상: 현재 잔량 → 0% 까지를 과거 방전 속도로 투영 (직선 등속 + 구간별 곡선) ──
// 팝오버의 "남은 시간"은 macOS(ioreg TimeRemaining)의 자체 추정치(공식 비공개)라, 여기선 우리 방식을
// 투명하게 계산해 그래프로 보여준다. 직선 = 현재 구간의 과거 평균 방전율로 등속 가정 · 곡선 = 각 10%
// 구간의 실제 과거 방전율을 이어붙임(구간마다 속도가 달라 휜다). rate는 lib/bucketRates의 구간별 pooled.
function projRates(rt) {
  const m = {};
  for (const b of (rt && rt.byBand || [])) {
    // 표에 보이는 그 구간 속도(선택된 버전)와 동일하게 — 없으면 pooled로 대체. %/min·방전은 음수→크기만
    const r = (b.versions && b.versions[state.rateVersion] != null) ? b.versions[state.rateVersion] : b.typicalMinute_pooled;
    if (r != null && Number.isFinite(r) && Math.abs(r) > 1e-4) m[b.band] = Math.abs(r);
  }
  return m;
}
// Shared projection math (used by the 2D card AND the 3D line). Per-band rates = what the table shows.
function computeProjection() {
  const L = state.report && state.report.latest, rates = projRates(state.rates);
  const L0 = state.rateLevel === 'pct' ? (L && L.pct != null ? L.pct : null)   // basis matches /api/rates?level=…
    : (L && L.rawCap > 0 && L.rawMax > 0) ? +(L.rawCap / L.rawMax * 100).toFixed(1) : (L && L.pct != null ? L.pct : null);
  if (L0 == null || L0 <= 0 || !Object.keys(rates).length) return null;
  const sorted = Object.values(rates).sort((a, b) => a - b), fallback = sorted[sorted.length >> 1];
  const rateAt = lvl => rates[Math.min(100, Math.max(10, Math.ceil(lvl / 10) * 10))] ?? fallback;
  const rLin = rateAt(L0), linMin = L0 / rLin;            // 직선: 현재 구간 기울기로 등속
  const pts = [{ t: 0, lvl: L0 }]; let t = 0, lvl = L0, guard = 0;   // 곡선: 구간별 실제 속도로 하강
  while (lvl > 0.01 && guard++ < 40) { const lo = Math.max(0, Math.floor((lvl - 1e-6) / 10) * 10); t += (lvl - lo) / rateAt(lvl); lvl = lo; pts.push({ t, lvl }); }
  return { L, L0, rLin, linMin, curveMin: t, pts, baseT: (L && L.t) ? L.t : Date.now() / 1000,
    macos: (L && L.timeRemain != null && !L.charging) ? L.timeRemain : null };
}
// 과거 '충전' 구간에서 뽑은 구간별 충전 속도(양수 %/min). 충전은 상단(CV)에서 느려져 구간마다 다름.
function chargeRatesByBand() {
  const r = state.report; if (!r || !r.runs) return {};
  const usePct = state.rateLevel === 'pct';
  const lvlOf = p => usePct ? p.pct : (p.cap != null ? p.cap : p.pct);
  const acc = {};
  for (const run of r.runs) {
    if (run.kind !== 'charge') continue;
    const ps = run.points;
    for (let i = 1; i < ps.length; i++) {
      const la = lvlOf(ps[i - 1]), lb = lvlOf(ps[i]), dt = ps[i].t - ps[i - 1].t;
      if (la == null || lb == null || !(dt > 0) || dt > 3600 || lb <= la) continue;   // 상승(충전)만
      const band = Math.min(100, Math.max(10, Math.ceil((la + lb) / 2 / 10) * 10));   // 중간 레벨의 10% 밴드에 배분
      (acc[band] ??= { rise: 0, time: 0 }); acc[band].rise += lb - la; acc[band].time += dt;
    }
  }
  const m = {};
  for (const band in acc) if (acc[band].time > 0 && acc[band].rise > 0) m[band] = acc[band].rise / acc[band].time * 60;
  return m;
}
// 충전 구간별 %/min의 소스 결정 — 내 데이터면 서버의 충전기 프로필 통계(계층 폴백 적용,
// /api/charge-rates)를 쓰고, 데모/미로드면 종전처럼 리포트 run에서 직접 뽑는다.
function chargeBands() {
  const cr = state.source === 'real' ? state.chargeRates : null;
  if (cr && cr.resolved && Object.keys(cr.resolved.byBand || {}).length) {
    return { rates: cr.resolved.byBand, tier: cr.resolved.tier, tierByBand: cr.resolved.tierByBand, totalMin: cr.resolved.totalMin };
  }
  return { rates: chargeRatesByBand(), tier: null, tierByBand: null, totalMin: null };
}
// 비교용: 특정 충전기 프로필의 밴드 속도. 그 충전기의 실제 이력이 있는 밴드는 그대로 쓰고,
// 없는 밴드는 전체 pooled를 **정격 기반 물리 추정으로 스케일링**해서 메운다 — 그냥 전체 평균을
// 쓰면 15W 파워뱅크와 96W가 같은 예상이 나오는 거짓말이 되기 때문(kdr 지적, 2026-07-11).
//   추정: 밴드의 전체 평균 속도 g가 암시하는 배터리 충전 전력 P_ref = g × 배터리Wh/100 × 60.
//   대상 충전기의 가용 전력 P_avail = 정격W×효율 − 충전 중 시스템 평균. 스케일 = min(P_avail, P_ref)/P_ref
//   — 작은 충전기는 비례로 느려지고, 큰 충전기는 관측된 배터리 수용 한도(P_ref) 이상으로
//   빨라진다고 주장하지 않는다(보수적·정직). CC/CV 구분 없이 min이 자연스럽게 처리.
const CHG_EFF = 0.88;
function bandsForProfile(key) {
  const cr = state.chargeRates; if (!cr) return null;
  const prof = cr.profiles && cr.profiles[key];
  // 어댑터 필드 기록 전의 같은 충전기(부분 키 "35W@20V/?#?") 이력도 이 충전기 것으로 잇는다
  const legacy = key && !key.endsWith('/?#?') ? cr.profiles && cr.profiles[key.replace(/\/[^/]*$/, '/?#?')] : null;
  const L = state.report && state.report.latest;
  const capWh = L && L.rawMax > 0 ? L.rawMax / 1000 * (L.voltage || 11.5) : null;
  const watts = (cr.adapters && cr.adapters[key] && cr.adapters[key].watts) || +((/^(\d+)W@/.exec(key) || [])[1] || 0) || null;
  const sysW = cr.avgSysChargeW;
  const pAvail = (watts && sysW != null) ? Math.max(0.3, watts * CHG_EFF - sysW) : null;
  const toW = rate => rate * capWh / 100 * 60;               // %/min → 그 속도가 뜻하는 배터리 전력(W)
  const out = {};
  let estimated = false;
  for (let b = 10; b <= 100; b += 10) {
    const ownOf = p => p && p.byBand[b] != null && (p.secByBand[b] || 0) >= 480 ? p.byBand[b] : null;
    const own = ownOf(prof) ?? ownOf(legacy);
    if (own != null) { out[b] = own; continue; }
    const g = cr.global && cr.global.byBand[b] != null ? cr.global.byBand[b] : null;
    if (g == null) continue;
    if (pAvail != null && capWh) {
      // 이 밴드에서 "어떤 충전기로든 실제로 관측된" 최대 배터리 수용 전력 — 여기까지는 상향 허용.
      // 단, 그 기록을 세운 충전기가 그때 "어댑터 포화"(실측 입력 ≥ 정격×0.85)였다면 그 기록은
      // 배터리 수용 한도가 아니라 어댑터 한도의 관측이다 → 더 큰 충전기는 선형 상향 허용
      // (안전 상한 ≈0.85C). 포화 증거가 없는 밴드(CV 꼬리 등)는 관측 최대에 캡 — 배터리 제한.
      // (이 규칙이 없으면 "지금 30W가 갱신 중인 관측 최대"에 35W가 캡돼 항상 동일 ETA가 나온다.)
      let pCap = toW(g), satSeen = false;
      for (const [pk2, p] of Object.entries(cr.profiles || {})) {
        if (!(p.byBand[b] != null && (p.secByBand[b] || 0) >= 480)) continue;
        pCap = Math.max(pCap, toW(p.byBand[b]));
        const rated = +((/^(\d+)W@/.exec(pk2) || [])[1] || 0);
        const adp = p.adpWByBand && p.adpWByBand[b];
        if (rated && adp != null && adp >= rated * 0.85) satSeen = true;
      }
      if (satSeen) pCap = Math.max(pCap, Math.min(pAvail, capWh * 0.85));   // 포화 증거 → pAvail까지 (0.85C 안전 상한)
      const pRef = toW(g);
      out[b] = +(g * Math.min(pAvail, pCap) / pRef).toFixed(4);
      estimated = true;
    } else { out[b] = g; estimated = true; }
  }
  return Object.keys(out).length ? { rates: out, estimated } : null;
}
// 충전 예상: 현재 잔량 → 100% (구간별 곡선 + 현재구간 등속 직선). 완충/충전이력없음 → null.
// `ratesOverride` = 비교 셀렉터가 고른 다른 충전기 프로필의 밴드 속도.
function computeCharge(ratesOverride = null) {
  const r = state.report, L = r && r.latest;
  const L0 = state.rateLevel === 'pct' ? (L && L.pct != null ? L.pct : null)
    : (L && L.rawCap > 0 && L.rawMax > 0) ? +(L.rawCap / L.rawMax * 100).toFixed(1) : (L && L.pct != null ? L.pct : null);
  if (L0 == null || L0 >= 99.5) return null;                 // 완충/거의 완충 → 충전 예상선 없음
  const src = ratesOverride ? { rates: ratesOverride, tier: 'compare', totalMin: null } : chargeBands();
  const rates = src.rates; if (!rates || !Object.keys(rates).length) return null;   // 충전 이력 없음
  const sorted = Object.values(rates).sort((a, b) => a - b), fallback = sorted[sorted.length >> 1];
  const rateAt = lvl => rates[Math.min(100, Math.max(10, Math.ceil(lvl / 10) * 10))] ?? fallback;
  const rLin = rateAt(Math.min(100, Math.ceil((L0 + 1e-6) / 10) * 10)), linMin = (100 - L0) / rLin;
  const pts = [{ t: 0, lvl: L0 }]; let t = 0, lvl = L0, guard = 0;
  const mins = { }; // 구간 경계 도달 시각 (에너지 수지 스플라이스용: 80% 등)
  while (lvl < 99.99 && guard++ < 40) { const hi = Math.min(100, Math.ceil((lvl + 1e-6) / 10) * 10); t += (hi - lvl) / rateAt(hi); lvl = hi; mins[hi] = t; pts.push({ t, lvl }); }
  return { L0, target: 100, rLin, linMin, curveMin: t, pts, minsAt: mins,
    tier: src.tier, tierMin: src.totalMin, baseT: (L && L.t) ? L.t : Date.now() / 1000 };
}
function renderProjection() {
  const box = document.getElementById('projChart'); if (!box) return;
  const P = computeProjection(); if (!P) { box.innerHTML = ''; return; }
  const { L, L0, rLin, linMin, curveMin, pts, baseT, macos } = P;
  const Tmax = Math.max(linMin, curveMin, 1);
  const dur = min => fmtDur(min * 60), eta = min => fmtWhen((baseT + min * 60) * 1000);
  const W = 248, H = 104, pL = 30, pR = 8, pT = 8, pB = 16;
  const xOf = tt => pL + tt / Tmax * (W - pL - pR), yOf = v => pT + (1 - v / L0) * (H - pT - pB);
  const curve = pts.map(p => `${xOf(p.t).toFixed(1)},${yOf(p.lvl).toFixed(1)}`).join(' ');
  const linePts = `${xOf(0).toFixed(1)},${yOf(L0).toFixed(1)} ${xOf(linMin).toFixed(1)},${yOf(0).toFixed(1)}`;
  const yLab = (v, lab) => `<text x="${pL - 3}" y="${(yOf(v) + 2.6).toFixed(1)}" text-anchor="end" class="hcAx">${lab ?? v.toFixed(0)}</text>`;
  box.innerHTML = `
    <div class="hcHdr">방전 예상 <small>현재 ${L0.toFixed(1)}% → 0% · 과거 방전 속도 기준${L && L.charging ? ' (지금 뽑으면)' : ''}</small></div>
    <svg class="hcSvg" viewBox="0 0 ${W} ${H}" width="100%">
      <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${(H - pB).toFixed(1)}" class="hcAx2"/>
      <line x1="${pL}" y1="${yOf(0).toFixed(1)}" x2="${W - pR}" y2="${yOf(0).toFixed(1)}" class="hcAx2"/>
      ${yLab(L0, L0.toFixed(1))}${yLab(L0 / 2)}${yLab(0, '0')}
      <polyline points="${linePts}" fill="none" stroke="var(--dim)" stroke-width="1.3" stroke-dasharray="4 3" opacity=".85"/>
      <polyline points="${curve}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${xOf(0).toFixed(1)}" cy="${yOf(L0).toFixed(1)}" r="2.4" fill="var(--accent)"/>
      <text x="${pL}" y="${H - 3}" class="hcAx">지금</text>
      <text x="${W - pR}" y="${H - 3}" text-anchor="end" class="hcAx">${dur(Tmax)} 뒤</text>
    </svg>
    <div class="prjF">
      <div class="prjR"><span class="prjK"><i class="prjL solid"></i>구간별(곡선)</span><b>${dur(curveMin)}</b> · ${eta(curveMin)}</div>
      <div class="prjR"><span class="prjK"><i class="prjL dash"></i>직선 등속</span><b>${dur(linMin)}</b> · ${eta(linMin)}</div>
      <div class="prjEq">직선 기울기 = 현재 ${L0.toFixed(1)}% 구간 방전율 <b>${rLin.toFixed(3)}%/분</b> → ${L0.toFixed(1)} ÷ ${rLin.toFixed(3)} = ${dur(linMin)}</div>
      <div class="prjEq">곡선 = Σ (각 10% 구간 ÷ 그 구간 방전율) — 구간마다 속도가 달라 휨</div>
      ${macos != null ? `<div class="prjEq">macOS 추정(ioreg): <b>${dur(macos)}</b> · ${eta(macos)} <span class="prjMuted">— 참고(공식 비공개)</span></div>` : ''}
    </div>`;
}

// ── 충전 예상 카드: 충전기 프로필별 통계 + 에너지 수지 + macOS 추정 3종 병기 ─────────────────
// 충전 중(또는 비교 셀렉터 사용 중)에만 보인다. 속도의 출처(이 충전기 이력/비슷한 급/전체 평균)를
// 배지로 정직하게 표기 — docs/plans/charger-aware-charge-projection.md.
const TECH_KO = { 'usbc-pd': 'USB-C PD', 'usbc-5v': 'USB-C 5V', usb: 'USB(구형)', dedicated: '전용 어댑터', unknown: '미상' };
const TIER_KO = { profile: '이 충전기 이력 기준', class: '비슷한 급 충전기 기준', global: '전체 충전 이력 평균' };
function chargerLabel(key, meta) {
  const m = /^(\d+)W@(\S+?)V\//.exec(key || '');
  // 같은 물리 충전기라도 계약이 다르면(듀얼포트 35W→27W) 별도 프로필 — 이름만 쓰면 목록에
  // "35W USB-C Power Adapter"가 두 개 떠서 구분이 안 된다 → 이름 뒤에 계약을 병기
  if (meta && meta.name) return m ? `${meta.name} · 계약 ${m[1]}W` : meta.name;
  if (key === 'unknown') return '미상(과거 기록)';   // 어댑터 필드가 없던 시기의 충전 이력
  const tech = meta && meta.tech ? `${TECH_KO[meta.tech] || ''} ` : '';
  return m ? `${tech}${m[1]}W (${m[2]}V)`.trim() : (key || '충전기');
}
function renderChargeCard() {
  const box = document.getElementById('chgChart'); if (!box) return;
  const cr = state.source === 'real' ? state.chargeRates : null;
  const L = state.report && state.report.latest;
  const charging = !!(L && L.charging);
  if (!cr) { box.innerHTML = ''; return; }
  const P = computeCharge();
  if (!P) { box.innerHTML = ''; return; }   // 완충/이력 없음 — 카드 숨김 (방전 카드처럼 비충전 중에도 '지금 충전한다면'으로 표시)
  const dur = min => fmtDur(min * 60), eta = min => fmtWhen(((P ? P.baseT : Date.now() / 1000) + min * 60) * 1000);
  const rows = [];
  // ① 구간별 통계(=그래프의 실선 "곡선") + 직선 등속(=그래프의 점선) — 그래프와 1:1 대응
  if (P) {
    const tierNote = P.tier && TIER_KO[P.tier] ? `${TIER_KO[P.tier]}${P.tier === 'profile' && P.tierMin ? ` · ${dur(P.tierMin)} 분량` : ''}` : '';
    rows.push(`<div class="prjR"><span class="prjK"><i class="prjL solid"></i>구간별 통계 (곡선)</span><b>${dur(P.curveMin)}</b> · ${eta(P.curveMin)}</div>`);
    rows.push(`<div class="prjR"><span class="prjK"><i class="prjL dash"></i>직선 등속</span><b>${dur(P.linMin)}</b> · ${eta(P.linMin)}</div>`);
    if (tierNote) rows.push(`<div class="prjEq">속도 출처: ${tierNote} · 직선 = 현재 구간 속도로 등속 외삽</div>`);
  }
  // ② 에너지 수지 (kdr 방식): →80%는 수지, 80→100%는 구간별 통계로 스플라이스
  const eb = cr.energyBalance;
  if (charging && eb) {
    if (!eb.feasible) {
      rows.push(`<div class="prjR"><span class="prjK">⚖ 에너지 수지</span><b>이 부하로는 완충 불가</b></div>`);
      rows.push(`<div class="prjEq">공급 여유 ${eb.pBat != null ? eb.pBat.toFixed(1) : '?'}W ≤ 0 — 소비가 충전을 앞서고 있어요</div>`);
    } else {
      const tail = P && P.L0 < 80 && P.minsAt && P.minsAt[80] != null ? P.curveMin - P.minsAt[80] : 0;   // 80→100% 밴드 통계
      const total = (eb.minutes || 0) + Math.max(0, tail);
      rows.push(`<div class="prjR"><span class="prjK">⚖ 에너지 수지</span><b>${dur(total)}</b> · ${eta(total)}</div>`);   // 그래프에는 안 그리는 제3 추정
      rows.push(`<div class="prjEq">→80% 수지 ${dur(eb.minutes)} (${eb.regime === 'adapter-limited'
        ? `어댑터 포화 · 지난 ${eb.window}h 시스템 평균 ${eb.avgSysW != null ? eb.avgSysW.toFixed(1) : '?'}W 차감`
        : '배터리 제한 · 현재 수지'} · 충전 여유 ${eb.pBat}W)${tail > 0 ? ` + 80→100% 통계 ${dur(tail)}` : ''}</div>`);
    }
  }
  // ③ macOS 자체 추정 (참고)
  if (charging && L.timeRemain != null) rows.push(`<div class="prjEq">macOS 추정(ioreg): <b>${dur(L.timeRemain)}</b> · ${eta(L.timeRemain)} <span class="prjMuted">— 참고(공식 비공개)</span></div>`);
  // ④ 다른 충전기와 비교 — 사전(adapters.json) ∪ 통계 이력이 있는 프로필(10분 이상)
  const keys = [...new Set([...Object.keys(cr.adapters || {}), ...Object.keys(cr.profiles || {})])]
    .filter(k => (!cr.current || k !== cr.current.key) && (!cr.profiles[k] || cr.profiles[k].totalMin >= 10));
  let cmpHTML = '';
  if (keys.length) {
    const opts = ['<option value="">다른 충전기라면…</option>']
      .concat(keys.map(k => `<option value="${k}"${state.chargeCompare === k ? ' selected' : ''}>${chargerLabel(k, cr.adapters[k])}</option>`));
    let cmpRow = '';
    if (state.chargeCompare) {
      const CB = bandsForProfile(state.chargeCompare);
      const CP = CB ? computeCharge(CB.rates) : null;
      cmpRow = CP ? `<div class="prjR"><span class="prjK">↳ 그 충전기라면</span><b>${dur(CP.curveMin)}</b> · ${eta(CP.curveMin)}</div>${
        CB.estimated ? '<div class="prjEq prjMuted">이력 없는 구간은 정격 전력 기반 추정</div>' : ''}`
        : '<div class="prjEq prjMuted">그 충전기의 충전 이력이 아직 부족해요</div>';
    }
    cmpHTML = `<div class="prjR"><select id="chgCmp">${opts.join('')}</select></div>${cmpRow}`;
  }
  const cur = cr.current;
  const badge = cur
    ? `${chargerLabel(cur.key, cur.meta)}${cur.meta && cur.meta.tech ? ` · ${TECH_KO[cur.meta.tech]}` : ''}${cur.meta && cur.meta.voltage && cur.meta.current ? ` · 계약 ${cur.meta.voltage}V×${cur.meta.current}A` : ''}`
    : '충전기 미상';
  // 미연결 시엔 "가장 최근 충전기"를 가정해 예측 — 어떤 충전기 기준인지 항상 명시
  const badgeLine = cur ? ` · 🔌 ${cur.assumed ? `${tr('마지막 충전기 기준')}: ` : ''}${badge}` : '';
  box.innerHTML = `
    <div class="hcHdr">⚡ 충전 예상 <small>현재 ${P.L0.toFixed(1)}% → 100%${charging ? '' : ' (지금 충전한다면)'}${badgeLine}</small></div>
    <div class="prjF">${rows.join('')}${cmpHTML}</div>`;
  const sel = document.getElementById('chgCmp');
  if (sel) sel.onchange = () => { state.chargeCompare = sel.value; renderChargeCard(); };
}

// 3D 방전 예상선: 현재 지점에서 앞으로 시간을 진행시키며 %가 0으로 떨어지는 곡선/직선을 3D 그래프에 겹쳐
// 그림. X=시각(자정을 지나면 감기며 Z(날짜)가 +1), Y=배터리 %(과거 데이터와 같은 축). 배터리 % 모드에서만.
// 예상선의 0% 도달 지점은 다음날(격자 밖) 바닥 구석으로 내려가 코너 패널에 가리므로, 3D 스프라이트
// 라벨로는 화면 각도에 따라 안 보인다. 대신 그 월드좌표를 매 프레임 화면좌표로 투영해, 패널 위에
// 항상 뜨는 HTML 태그(#projTags)로 도착 시각을 표기한다 → 카메라·패널과 무관하게 "확실히 인지".
let proj3DTags = [];   // [{vp: THREE.Vector3, el, yBias}]
let projLines = [];    // 예상 곡선/직선 THREE.Line — 데이터 곡선처럼 마우스 호버(레이캐스트) 대상
function clearProjTags() { for (const t of proj3DTags) t.el.remove(); proj3DTags = []; }
function addProjTag(vp, text, color, yBias = 0) {
  const el = document.createElement('div');
  el.className = 'projTag'; el.textContent = tr(text);   // #projTags live on <body>, outside any [data-i18n] scope → translate here
  el.style.color = color; el.style.borderColor = color;
  document.body.appendChild(el);
  proj3DTags.push({ vp, el, yBias });
}
// '현재' 위치 점: 실시간 최신 표본(서버가 /api/report 끝에 붙여줌)의 잔량을 3D에 하나 찍는다.
// 자다 깬 직후처럼 방전 이력에 sleep 공백이 있으면 그 점은 1-포인트 run이라 선으로는 안 그려지므로
// (buildRuns가 ≥2점만 통과), 이렇게 별도 마커로 "지금 여기"를 항상 보이게 한다. 잔량(%) 모드 전용.
function drawNowMarker(r, yMax, maxDay) {
  disposeGroup(nowGroup);
  if (!r || state.source !== 'real' || state.y !== 'pct') return;
  const L = r.latest; if (!L || L.pct == null) return;
  const d0 = new Date((r.firstT || 0) * 1000); d0.setHours(0, 0, 0, 0);
  const day = Math.floor((L.t - d0.getTime() / 1000) / 86400);
  const lvl = state.rateLevel === 'pct' ? L.pct : (L.cap != null ? L.cap : L.pct);
  if (state.view === 'flat' && (L.t < _fw.w0 || L.t > _fw.w1)) return;   // 창 밖이면 생략
  const pos = state.view === 'flat'
    ? new THREE.Vector3(xFlat(L.t), yFromVal(lvl, yMax), 0)
    : new THREE.Vector3(xFromTod(todOf(L.t)), yFromVal(lvl, yMax), zFromDay(day, maxDay));
  const col = L.charging ? CC().chg : (L.ac ? CC().full : CC().dis);   // 상태색과 일치
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 18), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  dot.position.copy(pos); nowGroup.add(dot);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 18), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32 }));
  halo.position.copy(pos); nowGroup.add(halo);
}

// ---- 2D 전용 UI 동기화 + 미니맵 브러시 --------------------------------------------------------
// 미니맵: 전체 기간의 잔량 개형(600버킷 산술평균) + 현재 창. 창 안 드래그=이동, 가장자리=크기,
// 바깥 클릭=그 지점으로 점프. body 직속 오버레이(#flatMini — 248px #panel 안에 두면 잘림, P0-1).
function syncFlatUI() {
  const on = state.view === 'flat';
  const mini = document.getElementById('flatMini'); if (mini) mini.hidden = !on;
  const rng = document.getElementById('flatRangeGrp'); if (rng) rng.hidden = !on;
  const xs = document.getElementById('xScaleGrp'); if (xs) xs.hidden = on;        // 3D 전용 가로폭 배율
  const spinLbl = document.getElementById('spin'); if (spinLbl && spinLbl.parentElement) spinLbl.parentElement.style.visibility = on ? 'hidden' : '';   // 자동회전은 3D 전용
  const hint = document.getElementById('sceneHint');
  if (hint) hint.textContent = tr(on ? '드래그=이동 · 휠=커서 중심 줌 · 더블클릭=전체 · 아래 미니맵으로 구간 선택'
    : '드래그=회전 · 휠=줌 · 우클릭드래그=이동 · 곡선에 마우스를 올리면 그 세션 정보가 보입니다.');
  const reset = document.getElementById('reset'); if (reset) reset.textContent = tr(on ? '전체 보기' : '시점 리셋');
  if (rng) rng.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.val === 'all' && !state.flatWin));
  if (on) drawFlatMini();
}
function drawFlatMini() {
  const cv = document.getElementById('flatMiniCv'); if (!cv || !state.report) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  const sp = flatSpanNow();
  const { w0, w1 } = state.flatWin ? { w0: state.flatWin.t0, w1: state.flatWin.t1 } : { w0: sp.min, w1: sp.max };
  const xOf = tt => (tt - sp.min) / Math.max(1, sp.max - sp.min) * W;
  // 잔량 개형: 버킷별 sum/count 산술평균 ((old+v)/2는 순서 의존 지수가중 — Codex P1 지적으로 교체)
  const N = 600, sum = new Float64Array(N), cnt = new Float64Array(N);
  for (const r of (state.report.runs || [])) for (const p of r.points) {
    const v = levelPct(p); if (v == null) continue;
    const b = clamp(Math.floor((p.t - sp.min) / Math.max(1, sp.max - sp.min) * N), 0, N - 1);
    sum[b] += v; cnt[b]++;
  }
  g.strokeStyle = state.theme === 'light' ? '#4a5570' : '#9aa7c4'; g.lineWidth = dpr;
  g.beginPath(); let pen = false;
  for (let b = 0; b < N; b++) {
    if (!cnt[b]) { pen = false; continue; }
    const x = (b + 0.5) / N * W, y = H - (sum[b] / cnt[b]) / 100 * (H - 4 * dpr) - 2 * dpr;
    if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
  }
  g.stroke();
  // 현재 창 표시
  g.fillStyle = state.theme === 'light' ? 'rgba(12,143,128,.16)' : 'rgba(77,208,192,.20)';
  g.fillRect(xOf(w0), 0, Math.max(2, xOf(w1) - xOf(w0)), H);
  g.strokeStyle = state.theme === 'light' ? '#0c8f80' : '#4dd0c0'; g.lineWidth = dpr;
  g.strokeRect(xOf(w0) + 0.5, 0.5, Math.max(2, xOf(w1) - xOf(w0)) - 1, H - 1);
}
let miniDrag = null;   // {mode:'move'|'l'|'r', startT, t0, t1}
{
  const cv = document.getElementById('flatMiniCv');
  if (cv) {
    const tAt = e => { const r = cv.getBoundingClientRect(); const sp = flatSpanNow(); return sp.min + (e.clientX - r.left) / Math.max(1, r.width) * (sp.max - sp.min); };
    cv.addEventListener('pointerdown', e => {
      const sp = flatSpanNow();
      const { w0, w1 } = state.flatWin ? { w0: state.flatWin.t0, w1: state.flatWin.t1 } : { w0: sp.min, w1: sp.max };
      const tt = tAt(e);
      const r = cv.getBoundingClientRect();
      const edge = 6 * (sp.max - sp.min) / Math.max(1, r.width);           // 6px 분량의 시간
      const mode = Math.abs(tt - w0) < edge ? 'l' : Math.abs(tt - w1) < edge ? 'r' : (tt > w0 && tt < w1) ? 'move' : 'jump';
      if (mode === 'jump') { const span = Math.min(w1 - w0, sp.max - sp.min); applyFlatWin(FV.normalizeWindow({ t0: tt - span / 2, t1: tt + span / 2 }, sp)); return; }
      miniDrag = { mode, startT: tt, t0: w0, t1: w1 };
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    cv.addEventListener('pointermove', e => {
      if (!miniDrag) return;
      const sp = flatSpanNow(), tt = tAt(e), d = tt - miniDrag.startT;
      if (miniDrag.mode === 'move') applyFlatWin(FV.normalizeWindow({ t0: miniDrag.t0 + d, t1: miniDrag.t1 + d }, sp));
      else if (miniDrag.mode === 'l') applyFlatWin(FV.normalizeWindow({ t0: Math.min(tt, miniDrag.t1 - FV.MIN_DUR), t1: miniDrag.t1 }, sp));
      else applyFlatWin(FV.normalizeWindow({ t0: miniDrag.t0, t1: Math.max(tt, miniDrag.t0 + FV.MIN_DUR) }, sp));
    });
    cv.addEventListener('pointerup', () => { miniDrag = null; });
  }
}
function drawProjection3D() {
  // 예상선을 dispose 하기 전에, 그 위의 호버 하이라이트(공유 HI 재질)를 원복해 dispose 대상에서 뺀다
  // (안 그러면 disposeGroup이 공유 HI를 dispose → 이후 모든 호버 하이라이트가 깨짐)
  if (hovered && hovered.userData && hovered.userData.proj) { hovered.material = hovered.userData.base; hovered = null; }
  disposeGroup(projGroup);
  clearProjTags();
  // 예상선을 지우면 그 위에 걸려 있던 호버/고정 마커도 함께 정리 (dangling 참조 방지)
  if (curHover && curHover.proj) { curHover = null; if (!pinned) { tip.hidden = true; overlay.visible = false; } }
  if (pinned && pinned.proj) { pinned = null; tipManual = false; tip.classList.remove('pinned'); tip.hidden = true; overlay.visible = false; }
  projLines = [];
  const r = state.report;
  if ((state.projDis !== 'on' && state.projChg !== 'on') || state.y !== 'pct' || !r) return;
  try { drawProjection3DInner(r); } catch (e) { /* projection is non-essential — never let it break the 3D graph */ }
}
// 방전(현재→0%)·충전(현재→100%) 예상선을 3D 그래프에 겹쳐 그림. 방향별로 곡선(구간별)+직선(등속),
// 종점은 각 목표면(0% 또는 100%)에서 화면좌표 태그로 도착 시각 표기. 자정을 지나면 Z(날짜)가 +1.
function drawProjection3DInner(r) {
  const d0 = new Date((r.firstT || 0) * 1000); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime() / 1000, dayOfT = t => Math.floor((t - t0) / 86400);
  const yMax = projYMax, maxDay = projMaxDay;
  const flat = state.view === 'flat';   // 2D: 연속 시간축에 한 줄로, 창 밖은 clip (Codex P0-5)
  const posOf = (rt, lvl) => flat
    ? new THREE.Vector3(xFlat(rt), yFromVal(lvl, yMax), 0)
    : new THREE.Vector3(xFromTod(todOf(rt)), yFromVal(lvl, yMax), zFromDay(dayOfT(rt), maxDay));
  const inWin = rt => !flat || (rt >= _fw.w0 && rt <= _fw.w1);
  let startDrawn = false;

  const drawSet = (P, dir) => {   // P: {L0, target, curveMin, linMin, pts, baseT}
    const isChg = dir === 'charge';
    const lvlAtMin = tm => {                                // interpolate the piecewise curve at projection-minute tm
      const ps = P.pts;
      for (let i = 1; i < ps.length; i++) if (tm <= ps[i].t) { const a = ps[i - 1], b = ps[i]; return a.lvl + (b.lvl - a.lvl) * (b.t === a.t ? 0 : (tm - a.t) / (b.t - a.t)); }
      return P.target;
    };
    const build = (endMin, isLinear, color, dashed, opacity, kind) => {
      const segs = [[]], metas = [[]]; let prevDay = null;   // metas: 정점별 {t, lvl, mm, dir} — 호버 툴팁용
      for (let tm = 0; tm <= endMin + 1e-6; tm += Math.max(2, endMin / 90)) {
        const mm = Math.min(tm, endMin);
        const lvl = isLinear ? P.L0 + (P.target - P.L0) * (mm / endMin) : lvlAtMin(mm);
        const rt = P.baseT + mm * 60, day = dayOfT(rt);
        // clip: 카메라 가로 여유(±6%)까지만 그린다 — 그 밖은 어차피 화면 밖이고, 창이 바뀌면 재구축된다
        const margin = (_fw.w1 - _fw.w0) * 0.06;
        if (flat && rt > _fw.w1 + margin) break;
        if (flat && rt < _fw.w0 - margin) continue;
        if (!flat && prevDay !== null && day !== prevDay) { segs.push([]); metas.push([]); }   // 3D만 자정 분리 → 가로 점프선 방지
        prevDay = day;
        segs[segs.length - 1].push(posOf(rt, lvl));
        metas[metas.length - 1].push({ t: rt, lvl, mm, dir });
      }
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si]; if (seg.length < 2) continue;
        const g = new THREE.BufferGeometry().setFromPoints(seg);
        const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.7, gapSize: 0.5, transparent: true, opacity })
          : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        const line = new THREE.Line(g, m); if (dashed) line.computeLineDistances();
        line.userData = { proj: true, kind, dir, meta: metas[si] };
        projGroup.add(line); projLines.push(line);          // 레이캐스트 대상에 추가
      }
    };
    const lt = state.theme === 'light';   // 라이트 배경에선 예상선도 진하게 (1px 선이 희미해짐)
    const curveHex = isChg ? (lt ? 0x1f9e57 : 0x46d17f) : (lt ? 0x0f8f80 : 0x4dd0c0);
    const lineHex = isChg ? (lt ? 0x4d8f68 : 0x8fd6a8) : (lt ? 0x5b7691 : 0x8aa0b8);
    const curveStr = isChg ? (lt ? '#1f9e57' : '#46d17f') : (lt ? '#0f8f80' : '#4dd0c0');
    const lineStr = isChg ? (lt ? '#4d8f68' : '#8fd6a8') : (lt ? '#5b7691' : '#9fb2c6');
    build(P.curveMin, false, curveHex, false, 0.9, isChg ? 'chgCurve' : 'disCurve');   // 구간별 곡선 (실선)
    build(P.linMin, true, lineHex, true, lt ? 0.8 : 0.6, isChg ? 'chgLine' : 'disLine');   // 등속 직선 (점선)
    if (!startDrawn && inWin(P.baseT)) {   // 시작점(현재 잔량) 표식 + '예상' 라벨 — 방전·충전이 같은 지점에서 출발하므로 한 번만
      startDrawn = true;
      const sp = posOf(P.baseT, P.L0);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: lt ? 0x2b3444 : 0xffffff }));
      dot.position.copy(sp); projGroup.add(dot);
      const lab = makeLabel(t('예상'), { size: 26, color: lt ? '#2f5e50' : '#dfeeea' }); lab.position.copy(sp).add(new THREE.Vector3(0, 1, 0)); projGroup.add(lab);
    }
    // 목표면(0% 또는 100%) 도달 지점: 작은 종점 점 + 화면좌표로 항상 뜨는 시각 태그
    const markEnd = (endMin, colHex, colStr, prefix, yBias) => {
      const rt = P.baseT + endMin * 60;
      if (!inWin(rt)) return;   // 2D에서 종점이 창 밖이면 점·태그 모두 생략 (P0-5: 태그가 화면 가장자리에 clamp돼 오독됨)
      // 2D: 예상 시각 태그는 치역(0–100%) "밖"에 — 충전(→100%)은 윗선 위로, 방전(→0%)은 아랫선 아래로
      if (flat) yBias = isChg ? -(34 + yBias) : (10 + yBias);
      const p = posOf(rt, P.target);
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), new THREE.MeshBasicMaterial({ color: colHex }));
      d.position.copy(p); projGroup.add(d);
      addProjTag(p.clone(), `${prefix} ${P.target}% · ${fmtWhen(rt * 1000)}`, colStr, yBias);
    };
    markEnd(P.curveMin, curveHex, curveStr, '곡선', 0);
    markEnd(P.linMin, lineHex, lineStr, '직선', 24);        // 세로로 조금 내려 겹침 방지
  };

  if (state.projDis === 'on') { const P = computeProjection(); if (P) drawSet({ ...P, target: 0 }, 'discharge'); }
  if (state.projChg === 'on') { const C = computeCharge(); if (C) drawSet(C, 'charge'); }
}

function updateHud(r) {
  const L = r.latest, stats = document.getElementById('stats');

  // prominent Maximum Capacity (like macOS 배터리 성능) — big number + precise value
  const hb = document.getElementById('healthBig');
  if (L && L.healthPct != null) {
    const cap = Math.min(100, Math.round(L.healthPct));          // macOS caps display at 100%
    hb.innerHTML = `🔋 최대 용량 <b>${cap}%</b><span class="hbsub">정밀 ${L.healthPct}% · ${L.cycles != null ? L.cycles + '사이클' : ''}</span>`;
    hb.hidden = false;
  } else { hb.hidden = true; }

  // trend: average 10%-drain time, early vs recent (robust to messy real data)
  const trend = document.getElementById('trend');
  const e = avgRate(r.bucketsEarly), n = avgRate(r.bucketsRecent);
  if (e && n) trend.innerHTML = `10% 소모 평균: <b>${(10 / e).toFixed(0)}분</b>(초기) → <b>${(10 / n).toFixed(0)}분</b>(최근)`;
  else { const a = avgRate(r.buckets); trend.innerHTML = a ? `10% 소모 평균: <b>${(10 / a).toFixed(0)}분</b>` : '아직 방전 데이터가 부족합니다.'; }

  const rows = [];
  if (L) {
    const ms = L.t ? L.t * 1000 : (L.iso ? Date.parse(L.iso) : NaN);
    const live = state.source === 'real';
    asofMs = Number.isFinite(ms) ? ms : null; asofLive = live;
    rows.push([`현재${live ? ' 🟢' : ''}`, `${L.pct}% · ${L.watts}W ${L.charging ? '⚡' : L.ac ? '🔌' : '🔋'}`]);
    if (Number.isFinite(ms)) rows.push(['기준 시각', live ? `${fmtWhen(ms)} · ${agoText(ms)}` : `${fmtWhen(ms)} (데모)`]);
    if (L.lowPower != null) rows.push(['저전력 모드', L.lowPower ? '🟡 켜짐' : '꺼짐']);   // pmset lowpowermode
    const sc = r.sinceCharge;   // 마지막 전원분리 이후: 경과(잠자기 포함) + 그중 실사용(깨어있던)
    if (sc && !sc.onAC && sc.unplugT) {
      rows.push(['마지막 충전 이후', `${sc.knownStart ? '' : '≥ '}${fmtDur(sc.wallSec)} · ${fmtWhen(sc.unplugT * 1000)} 분리`]);
      rows.push(['그중 사용(켜짐)', fmtDur(sc.awakeSec)]);
    }
    rows.push(['배터리 건강도', `${L.healthPct}%`]);
    rows.push(['사이클', `${L.cycles}회`]);
    rows.push(['만충 용량', `${L.rawMax} / ${L.design} mAh`]);
    const d = state.detail;   // 팝오버에서 이관: 시리얼 · 설계 사이클 한도 (내 데이터에서만)
    if (d) {
      if (d.designCycleCount) rows.push(['설계 사이클 한도', `${+d.designCycleCount}회`]);
      if (d.serial) rows.push(['배터리 시리얼', String(d.serial).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))]);
    }
  }
  rows.push(['기록 기간', `${r.spanDays}일 · ${r.sessions.length}방전세션`]);
  rows.push(['샘플 수', `${r.sampleCount.toLocaleString()}개`]);
  stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd${k === '기준 시각' ? ' id="asof"' : ''}>${v}</dd>`).join('');
  document.getElementById('healthChart').innerHTML = healthChartHTML(r.health);
  renderProjection();   // 방전 예상(직선+구간별 곡선) — 과거 방전 속도로 현재%→0% 투영
  renderChargeCard();   // 충전 예상(충전기 프로필·에너지 수지·macOS 3종) — 충전 중에만 표시

  renderRates();  // rigorous per-band discharge-rate panel (lib/bucketRates.js, /api/rates)
  if (typeof renderInsight === 'function') renderInsight();   // E 카드 레이아웃 값 갱신
}

// ---- per-band panel: metric (rate %/min ↔ aging Wh/%), period, version/level ----
const RATE_VERS = [['v4a_pooled', 'V4a'], ['v0_rawMean', 'V0'], ['v1_fullOnly', 'V1'], ['v4c_subbin', 'V4c'], ['v5_ols', 'V5']];
const PERIODS = [['day', '일'], ['week', '주'], ['month', '월']];
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const METRICS = {
  rate:  { label: '속도',     unit: '%/min', pos: false, dec: 3, hot: 'lo', hint: '음수=방전' },
  wh:    { label: '노화Wh/%', unit: 'Wh/%',  pos: true,  dec: 3, hot: 'lo', hint: '낮을수록 노화' },
  watts: { label: '전력',     unit: 'W',     pos: true,  dec: 1, hot: 'hi', hint: '순수 부하' },
  temp:  { label: '온도',     unit: '°C',    pos: true,  dec: 1, hot: 'hi', hint: '발열' },
};
const M = () => METRICS[state.metric] || METRICS.rate;
const fmtVal = v => v == null ? '–' : (+v).toFixed(M().dec);   // per-metric decimals (W·°C don't need 3)
const isWh = () => state.metric === 'wh';
const isRate = () => state.metric === 'rate';
const posMetric = () => !!M().pos;                    // positive-only (wh/watts/temp) vs rate (straddles 0)
const metricUnit = () => M().unit;
const cellVal = c => state.metric === 'wh' ? c.whPerPct
  : state.metric === 'watts' ? c.avgW
  : state.metric === 'temp' ? c.avgTempC
  : (c.versions ? c.versions[state.rateVersion] : null);
const bandVal = b => state.metric === 'wh' ? b.whPerPct_median
  : state.metric === 'watts' ? b.avgW_median
  : state.metric === 'temp' ? b.avgTempC_median
  : b.versions[state.rateVersion];
const periodLabel = () => (PERIODS.find(p => p[0] === state.period) || PERIODS[0])[1];
// axis tick-density (적/중/촘) → tick counts
const TICKN = { date: { 1: 3, 2: 5, 3: 9 }, val: { 1: 4, 2: 6, 3: 9 } };
const nDate = big => (TICKN.date[state.tickDate] || 5) + (big ? 2 : 0);
const nVal = () => TICKN.val[state.tickVal] || 6;
const bandEvery = () => (state.tickBand === 1 ? 2 : 1);   // 적음 = 한 칸 건너 라벨
const zLineOn = () => state.zeroMode === 'line' || state.zeroMode === 'both';
const zPlaneOn = () => state.zeroMode === 'plane' || state.zeroMode === 'both';

function renderRates() {
  const el = document.getElementById('buckets');
  const rt = state.rates;
  el.classList.toggle('folded', !!state.foldBuckets);
  if (!rt || !rt.byBand) {
    el.innerHTML = '<h2>구간별 방전 속도</h2><div class="note">불러오는 중…</div>';
    disposeTrend3D();                                          // stop the 3D trend rAF loop — it would spin forever if rates never arrive
    document.getElementById('trendchart').hidden = true;
    return;
  }
  const vals = rt.byBand.map(bandVal).filter(v => v != null).map(Math.abs);
  const maxV = vals.length ? Math.max(...vals) : 0.001;
  const metBtns = [['rate', '속도'], ['wh', '노화Wh/%'], ['watts', '전력W'], ['temp', '온도°C']].map(([k, l]) => `<button data-rm="${k}" class="${k === state.metric ? 'on' : ''}">${l}</button>`).join('');
  const perBtns = PERIODS.map(([k, l]) => `<button data-rp="${k}" class="${k === state.period ? 'on' : ''}">${l}</button>`).join('');
  const verBtns = RATE_VERS.map(([k, lbl]) => `<button data-rv="${k}" class="${k === state.rateVersion ? 'on' : ''}">${lbl}</button>`).join('');
  const body = rt.byBand.map(b => {
    const v = bandVal(b), sel = b.band === state.selectedBand ? ' class="sel"' : '';
    if (v == null) return `<tr data-band="${b.band}"${sel}><td>${b.label}</td><td class="rt">–</td><td></td></tr>`;
    const w = Math.round(Math.abs(v) / maxV * 44);   // one measure → one color (length carries the value; red→green ramp was CVD-unsafe)
    return `<tr data-band="${b.band}"${sel}><td>${b.label}</td><td class="rt">${fmtVal(v)}</td><td><span class="spd" style="width:${w}px"></span></td></tr>`;
  }).join('');
  const infoTip = isWh()
    ? `<b>Wh/% = "1%가 담고 있는 실제 에너지의 크기"</b><br>≈ 만충용량 ÷ 100. 측정 전력을 시간 적분한 소비 에너지 ÷ 그동안 빠진 %. 부하와 무관해서 <b>낮을수록 배터리 노화</b>.`
    : state.metric === 'watts'
    ? `<b>전력(W) = 방전 중 평균 소비전력</b><br>순수 <b>부하</b> 지표. 속도가 빨라졌는데 W도 올랐다면 노화가 아니라 부하 때문.`
    : state.metric === 'temp'
    ? `<b>온도(°C) = 방전 중 평균 배터리 온도</b><br>발열/스트레스 지표. 높은 온도가 지속되면 노화를 가속.`
    : `<b>%/min = 분당 떨어지는 배터리 %</b><br>음수 = 방전. 부하 + 노화가 섞인 "체감 속도".`;
  const infoBadge = `<span class="info">i<span class="ftip">${infoTip}</span></span>`;
  const bFold = `<button class="pcollapse" data-bfold title="${state.foldBuckets ? '펼치기' : '접기(최소화)'}">${state.foldBuckets ? '▸' : '▾'}</button>`;
  el.innerHTML =
    `<h2>${bFold}구간별 ${isRate() ? '방전 속도' : M().label} <small>${metricUnit()} · ${M().hint}</small>${infoBadge}</h2>` +
    `<div class="rseg" data-rgroup="rm">${metBtns}</div>` +
    `<div class="rseg" data-rgroup="rp"><span class="rlbl">기간</span>${perBtns}</div>` +
    (isRate() ? `<div class="rseg" data-rgroup="rv">${verBtns}</div>` : '') +
    `<table><tr><th>구간</th><th>${isRate() ? '속도' : metricUnit()}</th><th></th></tr>${body}</table>` +
    `<div class="note">${periodLabel()}별 중앙값 · ${isRate() ? (state.rateVersion === 'v4a_pooled' ? 'V4a' : state.rateVersion.split('_')[0].toUpperCase()) : M().label} · ${rt.spans} spans · 행 클릭→추세</div>`;
  renderTrend();
}

// ---- trend over time: single/all bands · 2D line · heatmap · 3D · metric/period/delta ----
// band identity = battery level → the universal battery semantic: full=green → empty=red
// (ordered warm sweep, no blue/purple leg; legend + hover carry exact identity)
const bandColor = band => `hsl(${Math.round((band - 10) / 90 * 125)},62%,${state.theme === 'light' ? 40 : 55}%)`;
function trendSeries() {
  const rt = state.rates;
  const bands = state.trendAll ? [100, 90, 80, 70, 60, 50, 40, 30, 20, 10] : (state.selectedBand == null ? [] : [state.selectedBand]);
  const series = [];
  for (const band of bands) {
    let pts = rt.perCell.filter(c => c.band === band && c.sufficient && cellVal(c) != null)
      .map(c => ({ x: c.periodStart / 86400, y: cellVal(c), cell: c })).sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    if (state.delta) { const k = Math.max(1, Math.round(pts.length * 0.2)); const base = med(pts.slice(0, k).map(p => p.y)); pts = pts.map(p => ({ ...p, y: p.y - base, raw: p.y })); }
    series.push({ band, label: `(${band - 10},${band}]`, color: bandColor(band), pts });
  }
  return series;
}

const VIEWS = { line: '2D선', heat: '히트맵', '3d': '3D' }, GEOMS = { lines: '선', ridges: '능선', grid: '선+능선', surface: '면' };
function renderTrend() {
  const el = document.getElementById('trendchart');
  const rt = state.rates;
  if (!rt || !rt.perCell) { disposeTrend3D(); el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('big', !!state.trendBig);
  el.classList.toggle('folded', !!state.foldTrend);
  const series = trendSeries();
  const view = state.trendAll ? state.trendView : 'line';
  // collapsed (not 확대) hides the fiddly controls behind "⋯" so the small graph stays uncluttered
  const showExtras = state.trendBig || state.trendMore;
  const geomBtns = (view === '3d') ? Object.keys(GEOMS).map(g => `<button data-tgeom="${g}" class="${state.trendGeom === g ? 'on' : ''}">${GEOMS[g]}</button>`).join('') : '';
  const zeroBtns = (view !== 'heat' && (!posMetric() || state.delta)) ? `<span class="zg">0:${(view === '3d' ? [['off', '끔'], ['line', '선'], ['plane', '면'], ['both', '선+면']] : [['off', '끔'], ['line', '선']]).map(([m, l]) => `<button data-tzero="${m}" class="${state.zeroMode === m ? 'on' : ''}">${l}</button>`).join('')}</span>` : '';
  const extra = showExtras ? (geomBtns + zeroBtns +
    `<button data-tdelta class="${state.delta ? 'on' : ''}">델타</button>` +
    `<button data-tticks class="${state.showTicks ? 'on' : ''}" title="축 눈금 밀도 조절">눈금</button>`) : '';
  const moreBtn = state.trendBig ? '' : `<button data-tmore class="more${state.trendMore ? ' on' : ''}" title="${state.trendMore ? '간단히' : '더 보기'}">⋯</button>`;
  const ctrls = `<span class="tbtns">` +
    `<button data-tall class="${state.trendAll ? 'on' : ''}">전체구간</button>` +
    (state.trendAll ? Object.keys(VIEWS).map(v => `<button data-tview="${v}" class="${view === v ? 'on' : ''}">${VIEWS[v]}</button>`).join('') : '') +
    extra + moreBtn +
    `<button data-tbig class="${state.trendBig ? 'on' : 'hl'}">${state.trendBig ? '축소' : '확대'}</button></span>`;
  const what = isRate() ? '방전속도' : M().label;
  const sub = `${metricUnit()}${state.delta ? ' · Δ기준대비' : ''} · ${VIEWS[view]}`;
  const tg = (g, gl, label) => `<span class="tickg">${label}<span class="seg2">${[1, 2, 3].map(v => `<button data-tick="${g}" data-v="${v}" class="${state[gl] === v ? 'on' : ''}">${['적', '중', '촘'][v - 1]}</button>`).join('')}</span></span>`;
  const tickRow = (showExtras && state.showTicks) ? `<div class="trow">눈금 ${tg('date', 'tickDate', '날짜')} ${tg('band', 'tickBand', '잔량')}${view !== 'heat' ? ' ' + tg('val', 'tickVal', '속도') : ''}</div>` : '';
  const title = state.foldTrend
    ? `<h2>구간별 ${what} 추세 <span class="fviews">(3D · 2D · 히트맵)</span></h2>`   // 접힘: 무엇인지 알아보게 뷰 종류를 함께 표기
    : state.trendAll
    ? `<h2>구간별 ${what} 추세 <small>${sub}</small>${ctrls}</h2>`
    : `<h2>${series[0]?.label ?? ''} ${what} 추세 <small>${metricUnit()}${state.delta ? ' · Δ' : ''}${series[0] ? ' · ' + series[0].pts.length + periodLabel() : ''}</small>${ctrls}</h2>`;
  const head = title + tickRow;
  if (!el.querySelector('#trend-head')) el.innerHTML = `<button class="tcollapse" data-tfold></button><div id="trend-head"></div><div id="trend-body"></div>`;
  const fb = el.querySelector('.tcollapse'); if (fb) { fb.textContent = state.foldTrend ? '▸' : '▾'; fb.title = state.foldTrend ? '펼치기' : '접기'; }
  el.querySelector('#trend-head').innerHTML = head;
  const body = el.querySelector('#trend-body');

  if (state.foldTrend) { disposeTrend3D(); body.innerHTML = ''; return; }   // folded → slim header only
  if (view === 'heat') { disposeTrend3D(); body.innerHTML = renderHeatmap(); return; }
  if (series.flatMap(s => s.pts).length < 2) { disposeTrend3D(); body.innerHTML = `<div class="note">충분한 데이터가 없습니다.</div>`; return; }
  if (view === '3d') { renderTrend3D(series, body); return; }
  disposeTrend3D();
  body.innerHTML = renderTrend2D(series);
}

function renderTrend2D(series) {
  const big = !!state.trendBig, allPts = series.flatMap(s => s.pts);
  const W = big ? 1000 : 478, H = big ? 520 : 184, pL = 54, pR = 16, pT = 22, pB = 32, fs = big ? 12 : 10;
  const xs = allPts.map(p => p.x); const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const inc0 = !posMetric() || state.delta;   // rate/delta straddle 0; Wh/%·W·°C are positive — don't force 0
  let ymin = Math.min(...allPts.map(p => p.y), inc0 ? 0 : Infinity), ymax = Math.max(...allPts.map(p => p.y), inc0 ? 0 : -Infinity);
  const pad = (ymax - ymin) * 0.08 || 0.02; ymin -= pad; ymax += pad;
  const X = x => pL + (xmax === xmin ? 0.5 : (x - xmin) / (xmax - xmin)) * (W - pL - pR);
  const Y = y => pT + (1 - (y - ymin) / (ymax - ymin)) * (H - pT - pB);
  const dfmt = x => { const d = new Date(x * 86400000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
  let grid = '', ylab = '';
  const ny = nVal();
  const span = ymax - ymin;
  const decY = span >= 20 ? 0 : span >= 2 ? 1 : span >= 0.2 ? 2 : 3;   // adaptive tick decimals (W doesn't need .000)
  for (let i = 0; i <= ny; i++) {
    const yy = ymin + (ymax - ymin) * i / ny, py = Y(yy);
    grid += `<line x1="${pL}" y1="${py.toFixed(1)}" x2="${W - pR}" y2="${py.toFixed(1)}" stroke="${Math.abs(yy) < 1e-9 ? TH().svgGrid0 : TH().svgGrid}"/>`;
    ylab += `<text x="${pL - 6}" y="${(py + 3).toFixed(1)}" text-anchor="end" fill="${TH().svgText}" font-size="${fs}">${yy.toFixed(decY)}</text>`;
  }
  const xt = nDate(big); let xgrid = '', xlab = '';
  for (let i = 0; i <= xt; i++) {
    const xx = xmin + (xmax - xmin) * i / xt, px = X(xx);
    xgrid += `<line x1="${px.toFixed(1)}" y1="${pT}" x2="${px.toFixed(1)}" y2="${H - pB}" stroke="${TH().svgGrid}"/>`;
    const a = i === 0 ? 'start' : i === xt ? 'end' : 'middle';
    xlab += `<text x="${px.toFixed(1)}" y="${H - pB + 15}" text-anchor="${a}" fill="${TH().svgText}" font-size="${big ? 11 : 9}">${dfmt(xx)}</text>`;
  }
  if (ymin < 0 && ymax > 0) {                    // mark the 0 (no-discharge) line on the speed axis
    const yz = Y(0);
    if (zLineOn()) grid += `<line x1="${pL}" y1="${yz.toFixed(1)}" x2="${W - pR}" y2="${yz.toFixed(1)}" stroke="#4dd0c0" stroke-dasharray="4 3"/>`;
    ylab += `<text x="${pL - 6}" y="${(yz + 3).toFixed(1)}" text-anchor="end" fill="#4dd0c0" font-size="${fs}">0</text>`;
  }
  let paths = '', footer = '', legend = '';
  for (const s of series) {
    paths += `<polyline points="${s.pts.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${big ? 1.6 : 1.3}" opacity="${state.trendAll ? 0.92 : 0.55}"/>`;
    if (!state.trendAll) paths += s.pts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${big ? 2.6 : 2}" fill="${s.color}" opacity=".85"/>`).join('');
  }
  if (!state.trendAll && series[0] && series[0].pts.length >= 2) {
    const pts = series[0].pts, n = pts.length, spanDays = xmax - xmin;
    if (n >= 4 && spanDays >= 6) {                          // enough points & span for a meaningful 30-day trend
      let sx = 0, sy = 0; for (const o of pts) { sx += o.x; sy += o.y; }
      const mx = sx / n, my = sy / n; let num = 0, den = 0; for (const o of pts) { num += (o.x - mx) * (o.y - my); den += (o.x - mx) ** 2; }
      const slope = den ? num / den : 0, fit = x => my + slope * (x - mx), per30 = slope * 30;
      paths += `<line x1="${X(xmin).toFixed(1)}" y1="${Y(fit(xmin)).toFixed(1)}" x2="${X(xmax).toFixed(1)}" y2="${Y(fit(xmax)).toFixed(1)}" stroke="#e8590c" stroke-width="${big ? 2.4 : 2}"/>`;
      let dir;
      if (isRate()) dir = per30 < 0 ? '↘ 점점 빨라짐(노화/부하↑)' : '↗ 안정/개선';
      else if (isWh()) dir = per30 < 0 ? '↘ Wh/% 하락 = 노화 진행' : '↗ 안정';
      else dir = per30 > 0 ? `↗ 평균 ${M().label} 증가` : per30 < 0 ? `↘ 평균 ${M().label} 감소` : '– 변화 없음';
      footer = `<div class="slope">추세: 30일당 <b>${per30 >= 0 ? '+' : ''}${per30.toFixed(Math.min(4, M().dec + 1))}</b> ${metricUnit()} ${dir}</div>`;
    } else {                                                // too little data → don't extrapolate a misleading 30-day slope
      footer = `<div class="slope note">추세선은 데이터가 더 쌓이면 표시돼요 (현재 ${n}${periodLabel()}치 · 최소 4${periodLabel()} 필요)</div>`;
    }
  }
  if (state.trendAll && (state.trendBig || state.trendMore)) legend = `<div class="tlegend">` + series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('') + `</div>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">` + grid + xgrid +
    `<line x1="${pL}" y1="${pT}" x2="${pL}" y2="${H - pB}" stroke="${TH().svgAxis}"/>` +
    `<line x1="${pL}" y1="${H - pB}" x2="${W - pR}" y2="${H - pB}" stroke="${TH().svgAxis}"/>` +
    ylab + xlab + paths + `</svg>` + footer + legend;
}

// ---- heatmap: period(date) × band grid, color=metric, opacity=coverage, click=date slice ----
function heatColor(v, lo, hi, diverging) {
  if (v == null) return TH().miss;
  if (diverging) {   // warm ↔ cool with a NEUTRAL midpoint (Δ≈0 must read as "nothing", not a hue)
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1, t = Math.max(-1, Math.min(1, v / m)), a = Math.abs(t);
    return `hsl(${t < 0 ? 18 : 212},${Math.round(74 * a)}%,${Math.round(60 - 22 * a)}%)`;
  }
  // sequential: ONE hue, light→dark (red→green ramp was CVD-unsafe); dark end = "intense" per metric
  let t = Math.max(0, Math.min(1, hi === lo ? 0.5 : (v - lo) / (hi - lo)));
  if (M().hot === 'lo') t = 1 - t;   // rate/Wh%: lower(-) = faster/older = darker; W/°C: higher = darker
  return `hsl(212,66%,${Math.round(72 - 46 * t)}%)`;
}
function renderHeatmap() {
  const rt = state.rates, big = !!state.trendBig;
  const periods = rt.periods || [], bands = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  if (!periods.length) return `<div class="note">데이터 부족</div>`;
  const byPB = new Map(); for (const c of rt.perCell) byPB.set(c.period + '|' + c.band, c);
  const base = {};
  if (state.delta) for (const b of bands) { const ys = periods.map(p => byPB.get(p.key + '|' + b)).filter(c => c && c.sufficient && cellVal(c) != null).map(cellVal); const k = Math.max(1, Math.round(ys.length * 0.2)); base[b] = ys.length ? med(ys.slice(0, k)) : 0; }
  const valOf = c => { if (!c || !c.sufficient) return null; let v = cellVal(c); if (v == null) return null; return state.delta ? v - (base[c.band] || 0) : v; };
  const vals = []; for (const c of rt.perCell) { const v = valOf(c); if (v != null) vals.push(v); }
  if (!vals.length) return `<div class="note">충분한 데이터가 없습니다.</div>`;
  const sorted = [...vals].sort((a, b) => a - b), pc = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  let lo = pc(0.02), hi = pc(0.98); if (lo === hi) { lo = Math.min(...vals); hi = Math.max(...vals); }  // clamp to p2..p98 so outlier bands don't wash out the gradient
  const maxMin = Math.max(...rt.perCell.map(c => c.minutes || 0), 1);

  const W = big ? 1000 : 478, H = big ? 440 : 252, pL = 50, pR = 12, pT = 8, pBx = 34, pBh = 28;
  const gx = pL, gy = pT, gw = W - pL - pR, gh = H - pT - pBx - pBh, cw = gw / periods.length, chh = gh / bands.length;
  let cells = '';
  periods.forEach((p, ci) => bands.forEach((b, ri) => {
    const c = byPB.get(p.key + '|' + b), v = valOf(c), x = gx + ci * cw, y = gy + ri * chh;
    const sel = p.key === state.selectedPeriod ? ' stroke="#e8e9ef" stroke-width="1.1"' : '';
    if (v == null) { cells += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(2)}" height="${chh.toFixed(2)}" fill="${TH().miss}" data-period="${p.key}"${sel}/>`; return; }
    const alpha = Math.max(0.35, Math.min(1, (c.minutes || 0) / (maxMin * 0.6)));
    cells += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(2)}" height="${chh.toFixed(2)}" fill="${heatColor(v, lo, hi, state.delta)}" fill-opacity="${alpha.toFixed(2)}" data-period="${p.key}"${sel}><title>${p.key} (${b - 10},${b}]\n${metricUnit()}: ${fmtVal(v)}${state.delta ? ' Δ' : ''}\n관측 ${c.minutes}분 · 평균 ${c.avgW}W</title></rect>`;
  }));
  let ylab = ''; bands.forEach((b, ri) => { if (ri % bandEvery() !== 0) return; ylab += `<text x="${pL - 5}" y="${(gy + ri * chh + chh / 2 + 3).toFixed(1)}" text-anchor="end" fill="${TH().svgText}" font-size="${big ? 11 : 9}">${b - 10}-${b}</text>`; });
  let xlab = ''; const nx = Math.min(periods.length, nDate(big));
  for (let i = 0; i < nx; i++) { const idx = Math.round(i * (periods.length - 1) / Math.max(1, nx - 1)), p = periods[idx], px = gx + (idx + 0.5) * cw, d = new Date(p.start * 1000); xlab += `<text x="${px.toFixed(1)}" y="${(gy + gh + 13).toFixed(1)}" text-anchor="middle" fill="${TH().svgText}" font-size="${big ? 10 : 8}">${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}</text>`; }
  // health overlay strip
  const hy0 = gy + gh + pBx, hh = pBh - 4, hv = periods.map(p => p.healthPct).filter(v => v != null);
  let health = '';
  if (hv.length > 1) {
    const hlo = Math.min(...hv), hhi = Math.max(...hv), HY = v => hy0 + hh - (hhi === hlo ? hh / 2 : (v - hlo) / (hhi - hlo) * hh);
    const poly = periods.map((p, ci) => p.healthPct == null ? null : `${(gx + (ci + 0.5) * cw).toFixed(1)},${HY(p.healthPct).toFixed(1)}`).filter(Boolean).join(' ');
    health = `<polyline points="${poly}" fill="none" stroke="#4dd0c0" stroke-width="1.3"/><text x="${pL - 5}" y="${(hy0 + 7).toFixed(1)}" text-anchor="end" fill="#4dd0c0" font-size="${big ? 10 : 8}">건강 ${hhi.toFixed(0)}%</text><text x="${pL - 5}" y="${(hy0 + hh).toFixed(1)}" text-anchor="end" fill="#4dd0c0" font-size="${big ? 10 : 8}">${hlo.toFixed(0)}%</text>`;
  }
  const mid = (lo + hi) / 2;   // legend gradient sampled from heatColor itself → always matches cells & metric direction
  const hgrad = `linear-gradient(90deg, ${heatColor(lo, lo, hi, state.delta)}, ${heatColor(mid, lo, hi, state.delta)}, ${heatColor(hi, lo, hi, state.delta)})`;
  const legend = `<div class="hlegend"><span>${fmtVal(lo)}</span><i class="hbar" style="background:${hgrad}"></i><span>${fmtVal(hi)} ${metricUnit()}${state.delta ? ' Δ' : ''}</span><span class="hcov">불투명도=관측분량 · 셀 클릭=날짜 선택 · 청록선=건강도</span></div>`;
  let inset = '';
  if (state.selectedPeriod) {
    const rows = bands.map(b => ({ b, v: valOf(byPB.get(state.selectedPeriod + '|' + b)) }));
    const mv = Math.max(...rows.map(r => r.v != null ? Math.abs(r.v) : 0), 0.001);
    inset = `<div class="hinset"><b>${state.selectedPeriod}</b> 날짜 단면 · 구간별 ${metricUnit()}<table>` +
      rows.map(r => r.v == null ? `<tr><td>${r.b - 10}-${r.b}</td><td class="rt">–</td><td></td></tr>` : `<tr><td>${r.b - 10}-${r.b}</td><td class="rt">${fmtVal(r.v)}</td><td><span class="spd" style="width:${Math.round(Math.abs(r.v) / mv * 40)}px;background:${heatColor(r.v, lo, hi, state.delta)}"></span></td></tr>`).join('') +
      `</table></div>`;
  }
  return `<div class="hwrap"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${cells}${ylab}${xlab}${health}</svg>${legend}</div>${inset}`;
}

// 3D trend: X=date, Y=value(height), Z=band(depth) — its own little Three.js view
let t3 = null;
function ensureTrend3D(w, h) {
  if (!t3) {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(TH().trendBg);
    const camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 2000); camera.position.set(34, 24, 42);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.style.cssText = 'display:block;border-radius:8px;cursor:grab';
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.target.set(0, 9, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dl = new THREE.DirectionalLight(0xffffff, 0.5); dl.position.set(20, 40, 30); scene.add(dl);
    const group = new THREE.Group(); scene.add(group);
    t3 = { scene, camera, renderer, controls, group, raf: null };
  }
  if (!t3.raf) { const loop = () => { t3.raf = requestAnimationFrame(loop); t3.controls.update(); t3.renderer.render(t3.scene, t3.camera); }; loop(); }
  return t3;
}
function disposeTrend3D() {
  if (!t3) return;
  if (t3.raf) { cancelAnimationFrame(t3.raf); t3.raf = null; }
  if (t3.renderer.domElement.parentElement) t3.renderer.domElement.parentElement.removeChild(t3.renderer.domElement);
}
function renderTrend3D(series, body) {
  const big = !!state.trendBig;
  const w = Math.max(320, body.clientWidth || (big ? 1000 : 450)), h = big ? 480 : 240;
  body.innerHTML = '';
  const t = ensureTrend3D(w, h);
  body.appendChild(t.renderer.domElement);
  t.renderer.setSize(w, h); t.camera.aspect = w / h; t.camera.updateProjectionMatrix();
  buildTrend3D(series);
  if (!(state.trendBig || state.trendMore)) return;   // collapsed → hide the legend/geometry note
  const note = document.createElement('div');
  const bandColored = state.trendGeom === 'lines' || (state.trendGeom === 'grid' && state.gridMain === 'lines');
  if (bandColored) {
    note.className = 'tlegend';
    note.innerHTML = (state.trendGeom === 'grid' ? '<span class="tnote">격자 · 메인=구간선(색)·능선=회색 · "선+능선" 또 클릭→전환</span>' : '') + series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  } else {
    note.className = 'note';
    note.textContent = state.trendGeom === 'surface' ? '면 = 방전속도 지형 (색=값, 빈 날짜는 메우지 않음)'
      : state.trendGeom === 'grid' ? '격자 · 메인=능선(파랑=과거→빨강=최근)·구간선=회색 · "선+능선" 또 클릭→전환'
      : '능선 = 날짜별 구간 프로파일 (파랑=과거 → 빨강=최근)';
  }
  note.classList.add('tl3d');   // fixed-height slot: geometry toggle (선/능선/면) must not resize the bottom-anchored panel
  body.appendChild(note);
}
function buildTrend3D(series) {
  const g = t3.group; disposeGroup(g);
  const big = !!state.trendBig;
  const allPts = series.flatMap(s => s.pts); if (allPts.length < 2) return;
  const xs = allPts.map(p => p.x); const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const inc0 = !posMetric() || state.delta;
  let rmin = Math.min(...allPts.map(p => p.y), inc0 ? 0 : Infinity), rmax = Math.max(...allPts.map(p => p.y), inc0 ? 0 : -Infinity);
  const rpad = (rmax - rmin) * 0.08 || 0.02; rmin -= rpad; rmax += rpad;
  const Xs = 40, Yh = 18, Zs = 26, bmin = 10, bmax = 100;
  const X = x => (xmax === xmin ? 0 : (x - xmin) / (xmax - xmin) - 0.5) * Xs;
  const Y = r => (rmax === rmin ? 0 : (r - rmin) / (rmax - rmin)) * Yh;
  const Z = b => ((b - bmin) / (bmax - bmin) - 0.5) * Zs;
  const x0 = -Xs / 2, zf = -Zs / 2, zb = Zs / 2;
  const grid = new THREE.GridHelper(Xs, 16, TH().gMain, TH().gMinor); grid.scale.z = Zs / Xs; g.add(grid);
  g.add(axisLine([x0, 0, zf], [Xs / 2, 0, zf], TH().axis));
  g.add(axisLine([x0, 0, zf], [x0, Yh, zf], TH().axis));
  g.add(axisLine([x0, 0, zf], [x0, 0, zb], TH().axis));
  const dfmt = x => { const d = new Date(x * 86400000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
  const nd = nDate(big); for (let i = 0; i < nd; i++) { const f = nd > 1 ? i / (nd - 1) : 0.5, xx = xmin + (xmax - xmin) * f, l = makeLabel(dfmt(xx), { size: 22, color: TH().tickC }); l.position.set(X(xx), -1.6, zf); g.add(l); }
  const decR = (rmax - rmin) >= 20 ? 0 : (rmax - rmin) >= 2 ? 1 : 2;
  const nv = nVal(); for (let i = 0; i <= nv; i++) { const rr = rmin + (rmax - rmin) * i / nv, l = makeLabel(rr.toFixed(decR), { size: 22, color: TH().tickC }); l.position.set(x0 - 3.2, Y(rr), zf); g.add(l); }
  const L = (t, o, x, y, z) => { const l = makeLabel(t, o); l.position.set(x, y, z); return l; };  // (Sprite.position is read-only — must .set, not reassign)
  g.add(L(tr('날짜 →'), { color: TH().titleC }, 0, -3.4, zf));
  g.add(L((state.delta ? 'Δ ' : '') + metricUnit(), { color: TH().titleC }, x0 - 5.5, Yh + 1.5, zf));
  g.add(L(tr('구간(잔량) →'), { color: TH().titleC }, x0 - 2, -1.6, zb - 5));
  if (0 > rmin && 0 < rmax) {                               // 0 (= no discharge) position on the value/speed axis
    g.add(L('0', { size: 22, color: '#4dd0c0' }, x0 - 3.2, Y(0), zf));
    if (zLineOn()) g.add(axisLine([x0, Y(0), zf], [Xs / 2, Y(0), zf], 0x4dd0c0));
    if (zPlaneOn()) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(Xs, Zs), new THREE.MeshBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: 0.07, side: THREE.DoubleSide }));
      plane.rotation.x = -Math.PI / 2; plane.position.set(0, Y(0), 0); g.add(plane);
    }
  }

  const geom = state.trendGeom, bandsArr = series.map(s => s.band);
  const xsArr = [...new Set(allPts.map(p => p.x))].sort((a, b) => a - b);
  const gv = new Map(); for (const s of series) for (const p of s.pts) gv.set(s.band + '|' + p.x, p.y);
  bandsArr.forEach((b, bi) => { if (bi % bandEvery() !== 0) return; g.add(L(`${b}`, { size: 18, color: TH().tickC }, x0 - 1.5, -0.7, Z(b))); });   // 잔량 ticks (all modes, density-aware)

  const drawBandLines = scaffold => {                       // line per band, across dates (scaffold=faint gray)
    for (const s of series) {
      const z = Z(s.band), pos = [];
      for (const p of s.pts) pos.push(X(p.x), Y(p.y), z);
      if (pos.length >= 6) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.add(new THREE.Line(geo, scaffold ? new THREE.LineBasicMaterial({ color: TH().scaffold, transparent: true, opacity: 0.55 }) : new THREE.LineBasicMaterial({ color: new THREE.Color(s.color) })));
      }
      if (!scaffold) g.add(L(s.label, { size: 20, color: s.color }, Xs / 2 + 3.5, Y(s.pts[s.pts.length - 1].y), z));
    }
  };
  const drawRidges = scaffold => {                          // line per date, across bands (scaffold=faint gray)
    xsArr.forEach((x, xi) => {
      const pos = []; for (const b of bandsArr) { const y = gv.get(b + '|' + x); if (y != null) pos.push(X(x), Y(y), Z(b)); }
      if (pos.length < 6) return;
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const t = xsArr.length > 1 ? xi / (xsArr.length - 1) : 0.5;
      g.add(new THREE.Line(geo, scaffold
        ? new THREE.LineBasicMaterial({ color: TH().scaffold, transparent: true, opacity: 0.7 })
        : new THREE.LineBasicMaterial({ color: new THREE.Color().setHSL((1 - t) * 0.66, 0.7, 0.55), transparent: true, opacity: 0.85 })));
    });
  };

  if (geom === 'ridges') drawRidges(false);
  else if (geom === 'grid') {                                // 선+능선 = wireframe net; gridMain = which family is colored
    if (state.gridMain === 'ridges') { drawBandLines(true); drawRidges(false); }
    else { drawRidges(true); drawBandLines(false); }
  }
  else if (geom === 'surface') {                           // continuous mesh over valid cells only (no gap-fill)
    const positions = [], colors = [], index = [], vid = new Map();
    bandsArr.forEach((b, bi) => xsArr.forEach((x, xi) => { const y = gv.get(b + '|' + x); if (y != null) { vid.set(bi + '|' + xi, positions.length / 3); positions.push(X(x), Y(y), Z(b)); const c = new THREE.Color(heatColor(y, rmin, rmax, state.delta)); colors.push(c.r, c.g, c.b); } }));
    for (let bi = 0; bi < bandsArr.length - 1; bi++) for (let xi = 0; xi < xsArr.length - 1; xi++) {
      const a = vid.get(bi + '|' + xi), b2 = vid.get(bi + '|' + (xi + 1)), c2 = vid.get((bi + 1) + '|' + xi), d2 = vid.get((bi + 1) + '|' + (xi + 1));
      if (a != null && b2 != null && c2 != null && d2 != null) index.push(a, b2, d2, a, d2, c2);
    }
    if (index.length) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.setIndex(index);
      g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })));
      g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: TH().wire, transparent: true, opacity: 0.18 })));
    }
  } else drawBandLines();                                   // 'lines' (default)

  // date cut-plane at the selected period
  if (state.selectedPeriod && state.rates.periods) {
    const p = state.rates.periods.find(q => q.key === state.selectedPeriod);
    if (p) { const xx = p.start / 86400; if (xx >= xmin && xx <= xmax) {
      const px = X(xx);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(Zs, Yh), new THREE.MeshBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
      plane.rotation.y = Math.PI / 2; plane.position.set(px, Yh / 2, 0); g.add(plane);
      g.add(axisLine([px, 0, zf], [px, Yh, zf], 0x4dd0c0));
    } }
  }
}

async function loadRates() {
  try {
    const res = await fetch(`/api/rates?source=${state.source}&level=${state.rateLevel}&period=${state.period}&method=${state.powerMethod}`);
    state.rates = await res.json();
  } catch { state.rates = null; }
  if (state.rates && state.rates.byBand && !state.rates.byBand.some(b => b.band === state.selectedBand)) {
    const best = [...state.rates.byBand].sort((a, b) => b.nDays - a.nDays)[0];   // default = band with most days
    state.selectedBand = best ? best.band : null;
  }
  renderRates();
  renderProjection();   // rates 로드 후 방전 예상 갱신(구간별 곡선은 byBand 필요)
  renderChargeCard();
  drawProjection3D();   // 3D 예상선도 rates 로드 후 갱신
}

// ---- hover (raycast lines) ---------------------------------------------
const ray = new THREE.Raycaster(); ray.params.Line.threshold = 0.6;
const mouse = new THREE.Vector2();
const tip = document.getElementById('tip');
let hovered = null;
const HI = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
// stock-chart-style hover cue: a dot on the exact point + a vertical drop line to the base plane
const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
marker.scale.setScalar(state.markerSize);   // adjustable in the gear settings (default smaller than before)
const mkGuide = op => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: op }));
const xLine = mkGuide(0.5), zLine = mkGuide(0.5);   // 바닥 안내선 → 하루 중 시각(X) · 날짜(Z) 축
const valLine = mkGuide(0.65);                      // 값(z축=세로) 안내선: 대각선/직각
const valDot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4dd0c0 }));
const valPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false }));
valPlane.rotation.x = -Math.PI / 2;                 // 바닥(x-z)과 평행한 수평면
overlay.add(marker, xLine, zLine, valLine, valDot, valPlane);

// 마커에서 시각(X)·날짜(Z) 축(바닥) + 값(z축=세로) 축으로 안내선/점/면 배치
function placeGuides(vp) {
  // 2D 시간축(flat): 축 상수가 다르다 — 값축 x0=-FLAT_W/2, 평면 z0=0 (Codex P0-2: 3D 상수를
  // 고정 사용하면 안내선이 옛 3D 축으로 뻗음). 수평면(valPlane)은 정면 뷰에서 무의미 → 숨김.
  const flat = state.view === 'flat';
  const baseY = isSignedY() ? Y / 2 : 0, x0 = flat ? -FLAT_W / 2 : -X / 2, z0 = flat ? 0 : -Z / 2;
  const fp = new THREE.Vector3(vp.x, baseY, vp.z);            // 바닥 투영점
  marker.position.copy(vp);
  const fg = state.floorGuide === 'on';
  xLine.visible = fg;
  zLine.visible = fg && !flat;                                // 날짜(Z)축 안내선은 3D 전용
  if (fg) {
    // flat: 점→시간축(baseY)으로 수직 낙하 · 3D: 바닥 투영점→시각(X)축
    xLine.geometry.setFromPoints(flat ? [vp.clone(), fp.clone()] : [fp.clone(), new THREE.Vector3(vp.x, baseY, z0)]);
    if (!flat) zLine.geometry.setFromPoints([fp.clone(), new THREE.Vector3(x0, baseY, vp.z)]);   // → 날짜(Z)축
  }
  const vg = state.valGuide;                                  // diag | step | dot | plane | off
  const VA = new THREE.Vector3(x0, vp.y, z0);                 // 값축(세로 x0,z0) 위, 같은 높이
  valLine.visible = vg === 'diag' || vg === 'step';
  valDot.visible = vg === 'dot';
  valPlane.visible = vg === 'plane' && !flat;
  if (vg === 'diag') valLine.geometry.setFromPoints([vp.clone(), VA.clone()]);                                   // 대각선 바로 축으로
  else if (vg === 'step') valLine.geometry.setFromPoints(flat
    ? [vp.clone(), VA.clone()]                                                                                   // flat: 값축까지 수평선
    : [fp.clone(), vp.clone(), new THREE.Vector3(x0, vp.y, vp.z), VA.clone()]);   // 바닥→수직↑→축과평행→값축
  else if (vg === 'dot') { valDot.position.copy(VA); valDot.scale.setScalar(Math.max(0.12, state.markerSize * 0.9)); }              // 값축에 점만
  else if (vg === 'plane' && !flat) { valPlane.position.set(0, vp.y, 0); valPlane.scale.set(X + 0.5, Z + 0.5, 1); }                 // 그 높이의 수평면
}

function pickAt(cx, cy) {   // raycast the curves → nearest vertex, or null
  mouse.x = (cx / innerWidth) * 2 - 1;
  mouse.y = -(cy / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  // vendored three의 Line.raycast는 distanceToRay를 안 채우므로, 교점(point)의 시선(ray) 수직거리를 직접 계산.
  const rd2 = h => ray.ray.distanceSqToPoint(h.point);            // 커서 시선과의 수직거리² (작을수록 커서 바로 아래)
  const dataHit = ray.intersectObjects(lines, false)[0] || null;   // 데이터 곡선: 종전대로 카메라 최근접
  let projHit = null;                                              // 예상선(곡선·직선): 커서에 시각적으로 가장 가까운 쪽
  if (projLines.length) for (const h of ray.intersectObjects(projLines, false)) if (!projHit || rd2(h) < rd2(projHit)) projHit = h;
  // 예상선이 커서 시선에 더 가까우면 예상선을, 아니면 데이터 곡선을 집는다 (두 예상선이 겹쳐도 각각 선택 가능)
  let hit = dataHit;
  if (projHit && (!dataHit || rd2(projHit) < rd2(dataHit))) hit = projHit;
  if (!hit) return null;
  const line = hit.object, arr = line.userData.proj ? line.userData.meta : line.userData.pts;
  const i = clamp(hit.index ?? 0, 0, arr.length - 1), j = Math.min(i + 1, arr.length - 1);
  const pos = line.geometry.attributes.position;
  const lp = line.worldToLocal(hit.point.clone());
  const di = lp.distanceToSquared(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  const dj = lp.distanceToSquared(new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j)));
  const idx = dj < di ? j : i;
  const vp = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx)); line.localToWorld(vp);
  if (line.userData.proj) return { line, vp, proj: { ...line.userData.meta[idx], kind: line.userData.kind } };
  return { line, vp, point: arr[idx], dayIndex: line.userData.dayIndex };
}
function setHovered(line) {
  if (hovered === line) return;
  if (hovered) hovered.material = hovered.userData.base;
  hovered = line || null;
  if (hovered) { hovered.userData.base = hovered.material; hovered.material = HI; }
}
function clearHover() {
  if (pinned) return;                                          // 고정 상태는 유지
  setHovered(null); curHover = null; tip.hidden = true; overlay.visible = false;
}
addEventListener('pointermove', e => {
  if (pinned) return;                                          // 고정 중엔 드래그로 회전만 (호버 변경 X)
  if (e.target !== renderer.domElement) { clearHover(); return; }
  const h = pickAt(e.clientX, e.clientY);
  if (!h) { clearHover(); return; }
  setHovered(h.line); curHover = h; placeGuides(h.vp); overlay.visible = true;
  if (h.proj) showProjTip(h.proj, e.clientX, e.clientY, false);
  else showTip(h.dayIndex, h.point, e.clientX, e.clientY, false);
});
// 클릭 = 마커 고정 토글 (그다음 드래그로 각도 바꿔가며 관찰) — 드래그(회전)와는 이동량으로 구분
let downXY = null;
renderer.domElement.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]); downXY = null;
  if (moved > 5) return;                                       // 드래그(회전) → 클릭 아님
  if (pinned) { pinned = null; tipManual = false; tip.classList.remove('pinned'); setHovered(null); tip.hidden = true; overlay.visible = false; return; }   // 고정 해제
  if (curHover) { pinned = curHover; tipManual = false; tip.classList.add('pinned'); placeGuides(curHover.vp); overlay.visible = true;
    if (curHover.proj) showProjTip(curHover.proj, e.clientX, e.clientY, true);
    else showTip(curHover.dayIndex, curHover.point, e.clientX, e.clientY, true); }
});
// ---- 2D 시간축 내비게이션: 휠 = 커서 중심 줌 · 드래그 = 팬 · 더블클릭 = 전체 ------------------
// 카메라는 고정이므로 화면 x(px) → z=0 평면의 월드 x → epoch 초로 되돌린다.
function flatTimeAtScreen(cx) {
  const ndc = new THREE.Vector3((cx / innerWidth) * 2 - 1, 0, 0.5).unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const k = -camera.position.z / dir.z;
  const wx = camera.position.x + dir.x * k;
  return _fw.w0 + (wx / FLAT_W + 0.5) * (_fw.w1 - _fw.w0);
}
renderer.domElement.addEventListener('wheel', e => {
  if (state.view !== 'flat') return;
  e.preventDefault();                                          // 페이지 스크롤 방지
  const sp = flatSpanNow();
  const unit = e.deltaMode === 1 ? 16 : 1;                     // Firefox line-mode 보정
  // 좌/우 스크롤(두 손가락 가로 스와이프) = 팬 — 절대 줌하지 않는다.
  // (종전엔 deltaY≈0이 "줌 인"으로 처리돼 가로 스크롤이 줌+이동처럼 보였음)
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const w = state.flatWin ? { ...state.flatWin } : { t0: sp.min, t1: sp.max };
    const dt = e.deltaX * unit / innerWidth * (w.t1 - w.t0) * _flatK;   // _flatK = 화면 폭에 보이는 창 비율
    applyFlatWin(FV.normalizeWindow({ t0: w.t0 + dt, t1: w.t1 + dt }, sp));
    return;
  }
  // 위/아래 스크롤 = 커서 중심 줌 — delta 크기 비례 지수 배율.
  // 계수 0.00022 ≈ 종전 고정 1.25(휠 한 칸 deltaY≈100)의 1/10 속도 (kdr: "10배 느리게")
  const f = Math.exp(e.deltaY * unit * 0.00022);
  applyFlatWin(FV.zoomAt(state.flatWin, sp, flatTimeAtScreen(e.clientX), f));
}, { passive: false });
let flatDrag = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (state.view !== 'flat') return;
  const w = state.flatWin ? { ...state.flatWin } : (() => { const sp = flatSpanNow(); return { t0: sp.min, t1: sp.max }; })();
  flatDrag = { x: e.clientX, ...w, moved: false };
});
addEventListener('pointermove', e => {
  if (!flatDrag || state.view !== 'flat') return;
  const dx = e.clientX - flatDrag.x;
  if (Math.abs(dx) > 3) flatDrag.moved = true;
  if (!flatDrag.moved) return;
  // _flatK = fitFlatCamera가 계산한 화면 폭 대비 가시 월드 비율 — 화면 px → 시간의 환산에 반영
  const dt = -dx / innerWidth * (flatDrag.t1 - flatDrag.t0) * _flatK;
  applyFlatWin(FV.normalizeWindow({ t0: flatDrag.t0 + dt, t1: flatDrag.t1 + dt }, flatSpanNow()));
});
addEventListener('pointerup', () => { flatDrag = null; });
renderer.domElement.addEventListener('dblclick', () => { if (state.view === 'flat') applyFlatWin(null); });

// 고정된 툴팁은 드래그로 옮길 수 있음 (그래프 관찰 시 걸리적거리지 않게)
let tipDrag = null;
tip.addEventListener('pointerdown', e => {
  if (!pinned) return;
  const r = tip.getBoundingClientRect();
  tipDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  try { tip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.stopPropagation(); e.preventDefault();
});
tip.addEventListener('pointermove', e => {
  if (!tipDrag) return;
  tipManual = true;                                          // 이후 회전해도 이 자리에 고정
  tip.style.left = Math.max(4, Math.min(innerWidth - 40, e.clientX - tipDrag.dx)) + 'px';
  tip.style.top = Math.max(4, Math.min(innerHeight - 24, e.clientY - tipDrag.dy)) + 'px';
});
tip.addEventListener('pointerup', () => { tipDrag = null; });

// All battery/adapter power measurement METHODS shown separately (직접 비교), like the popover.
// The row actually feeding the 전력 W graph is badged 그래프 (in hybrid mode the badge follows
// charge↔discharge). Rows whose method-field is absent (old data / on battery) are omitted.
function powerRowsHTML(p) {
  const V = p.voltage;
  const sw = (w, v, a, signed) => {
    if (w == null) return '–';
    const wt = signed ? `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(2)}` : w.toFixed(2);
    return [`${wt} W`, v != null ? `${v.toFixed(2)} V` : null, a != null ? `${Math.round(a)} mA` : null].filter(Boolean).join(' · ');
  };
  const charging = p.powerW != null ? p.powerW > 0.05 : !!p.charging;
  const graphIs = state.powerMethod === 'hybrid' ? (charging ? 'balance' : 'ppbr') : state.powerMethod;
  const tag = k => graphIs === k ? ' <span class="pmg">그래프</span>' : '';
  const rows = [['배터리 · 수지 PDTR−PSTR' + tag('balance'), sw(p.powerW, V, p.amperage, true)]];
  if (p.ioregW != null) rows.push(['배터리 · ioreg V×I' + tag('ioreg'), sw(p.ioregW, V, p.ioregA, true)]);
  if (p.ppbrW != null) rows.push(['배터리 · PPBR 방전' + tag('ppbr'), charging ? '충전 중 ~0' : sw(-Math.abs(p.ppbrW), V, V ? -Math.abs(p.ppbrW) / V * 1000 : null, true)]);
  if (p.systemW != null) rows.push(['시스템 PSTR', `${p.systemW.toFixed(1)} W`]);
  if (p.adapterName) rows.push(['어댑터 종류', p.adapterName]);
  if (p.adapterWnom != null) rows.push(['어댑터 · ioreg 공칭', sw(p.adapterWnom, p.adapterVnom, (p.adapterWnom && p.adapterVnom) ? p.adapterWnom / p.adapterVnom * 1000 : null, false)]);
  if (p.adapterW != null) rows.push(['어댑터 · SMC 실측 PDTR', sw(p.adapterW, p.dcInV, p.dcInA != null ? p.dcInA * 1000 : null, false)]);
  return rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
}

function showTip(dayIndex, p, x, y, isPinned) {
  const d = new Date(p.t * 1000);
  const st = p.charging ? '⚡ 충전 중' : p.ac ? '🔌 만충/유휴' : '🔋 방전 중';
  tip.innerHTML = `
    <h3>${isPinned ? '📌 ' : ''}${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${dayIndex}일차</h3>
    <div><span class="big">${state.rateLevel === 'pct' ? (p.pct ?? '?') : (p.cap != null ? p.cap.toFixed(1) : (p.pct ?? '?'))}%</span> <span class="tsm">${state.rateLevel === 'pct' ? (p.cap != null ? `정밀 ${p.cap.toFixed(1)}%` : '') : `정수 ${p.pct ?? '?'}%`}</span> &nbsp; ${st}</div>
    <table>
      ${state.y === 'rate' && p._rate != null ? `<tr><td class="k">변화율 <small class="tsm">과거 ${Math.round(state.rateWin / 60)}분 평균</small></td><td>${p._rate >= 0 ? '+' : ''}${p._rate.toFixed(3)} %/min</td></tr>` : ''}
      ${powerRowsHTML(p)}
      <tr><td class="k">배터리 온도</td><td>${p.tempC ?? '?'}°C</td></tr>
      <tr><td class="k">CPU 부하</td><td>${p.loadPct ?? '?'}%</td></tr>
      ${p.lowPower != null ? `<tr><td class="k">저전력</td><td>${p.lowPower ? '🟡 켜짐' : '꺼짐'}</td></tr>` : ''}
    </table>`;
  tip.hidden = false;
  positionTip(x, y);
}
function positionTip(x, y) {
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(Math.max(8, x + 16), innerWidth - r.width - 8) + 'px';
  tip.style.top = Math.min(Math.max(8, y + 16), innerHeight - r.height - 8) + 'px';
}
// 예상선(방전/충전 · 곡선/직선) 위 호버 툴팁 — 실측이 아니라 미래 추정이므로 별도 서식(시각·%·경과).
function showProjTip(pj, x, y, isPinned) {
  const d = new Date(pj.t * 1000);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const isChg = pj.dir === 'charge', isCurve = /Curve$/.test(pj.kind || '');
  const col = isChg ? (isCurve ? '#46d17f' : '#8fd6a8') : (isCurve ? '#4dd0c0' : '#9fb2c6');
  const head = isChg ? '⚡ 충전 예상' : '📉 방전 예상';
  const goal = isChg ? '완충(100%)까지' : '0%까지';
  const kindSub = isCurve ? '(각 구간 과거 속도)' : `(현재 구간 ${isChg ? '충전' : '방전'}속도로 외삽)`;
  tip.innerHTML = `
    <h3>${isPinned ? '📌 ' : ''}<span style="color:${col}">${head} · ${isCurve ? '곡선' : '직선'}</span></h3>
    <div><span class="big" style="color:${col}">${pj.lvl.toFixed(1)}%</span> <span class="tsm">${d.getMonth() + 1}/${d.getDate()} ${clock} 예상</span></div>
    <table>
      <tr><td class="k">예상 시각</td><td>${d.getMonth() + 1}/${d.getDate()} ${clock}</td></tr>
      <tr><td class="k">지금부터</td><td>${fmtDur(pj.mm * 60)} 뒤</td></tr>
      <tr><td class="k">${goal}</td><td>${isCurve ? '구간별 곡선' : '직선 등속'} <small class="tsm">${kindSub}</small></td></tr>
    </table>
    <div class="tsm" style="margin-top:6px; opacity:.8">과거 ${isChg ? '충전' : '방전'} 속도 기반 추정 · 실제와 다를 수 있음</div>`;
  tip.hidden = false;
  positionTip(x, y);
}

// ---- data ---------------------------------------------------------------
const emptyDefaultHTML = document.getElementById('empty').innerHTML;

// The launchd sampler appends a new reading every 60s. Only '내 데이터' is live —
// demos are fixed simulated logs — so poll only for source==='real', and only when the
// tab is visible. A ticker also refreshes the "N분 전" label between fetches.
let liveTimer = null, tickTimer = null, asofMs = null, asofLive = false;
function refreshAsOf() {                                   // update just the "기준 시각" cell, not the whole HUD
  const el = document.getElementById('asof');
  if (el && asofMs && asofLive) el.textContent = `${fmtWhen(asofMs)} · ${agoText(asofMs)}`;
}
function scheduleLive() {
  clearInterval(liveTimer); clearInterval(tickTimer); liveTimer = tickTimer = null;
  if (state.source !== 'real') return;
  liveTimer = setInterval(() => { if (!document.hidden) load(); }, 60000);    // pull new samples
  tickTimer = setInterval(() => { if (!document.hidden) refreshAsOf(); }, 20000);  // tick the relative age
}

async function load() {
  // 최신 추적 판정은 fetch "이전" 창·스팬으로 (P0-4: 새 데이터 도착 후 판정하면 긴 공백에 추적을 잃음)
  const oldSp = state.report ? flatSpanNow() : null;
  const wasFollowing = oldSp ? FV.isFollowingEnd(state.flatWin, oldSp) : true;
  try {
    const res = await fetch(`/api/report?source=${state.source}&level=${state.rateLevel}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.report = await res.json();
    // 2D에서 끝(최신)을 보고 있었다면 "지금 기준 상대 위치"를 유지하며 Δ만큼 따라간다
    // (끝점 스냅 방식은 미래 패드로 팬해 둔 창을 매분 왼쪽으로 되돌렸음)
    if (state.view === 'flat' && wasFollowing) state.flatWin = FV.followEnd(state.flatWin, flatSpanNow(), oldSp ? oldSp.max : null);
    document.getElementById('empty').innerHTML = emptyDefaultHTML;
  } catch (e) {
    // keep the previous report on screen (don't clobber state with an error body);
    // surface the failure instead of silently showing the old source's data
    const el = document.getElementById('empty');
    el.hidden = false;
    el.innerHTML = `데이터를 불러오지 못했습니다 (${e.message}).<br/>서버가 실행 중인지 확인하고 다시 선택해 주세요.`;
    return;
  }
  rebuild();
  loadRates();                 // per-band rate panel (concurrent)
  // 배터리 상세(시리얼·설계 사이클 한도) — 내 데이터에서만, 팝오버에서 뷰어로 이관
  if (state.source === 'real') {
    fetch('/api/detail').then(res => res.ok ? res.json() : null).then(d => { state.detail = d; if (state.report) updateHud(state.report); }).catch(() => {});
    // 충전기 프로필별 충전 통계 + 에너지 수지 — 충전 예상 카드/3D 충전선의 소스 (내 데이터 전용)
    fetch(`/api/charge-rates?level=${state.rateLevel}`).then(res => res.ok ? res.json() : null)
      .then(cr => { state.chargeRates = cr; renderChargeCard(); drawProjection3D(); }).catch(() => {});
  } else { state.chargeRates = null; renderChargeCard(); if (state.detail) { state.detail = null; if (state.report) updateHud(state.report); } }
  scheduleLive();              // (re)arm the 60s live refresh for '내 데이터'
}

// 자다 깨거나 창을 다시 보면 60s 타이머를 기다리지 않고 즉시 새로고침 → 화면이 과거에 머무르지 않음.
// (sleep 중 JS 타이머는 멈추고, 깨어난 뒤 setInterval 복귀엔 지연이 있을 수 있어 별도 트리거가 필요.)
let lastWakeLoad = 0;
function wakeRefresh() {
  if (document.hidden || state.source !== 'real') return;
  const now = Date.now();
  if (now - lastWakeLoad < 3000) return;   // visibilitychange + focus 중복 억제
  lastWakeLoad = now;
  load();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeRefresh(); });
window.addEventListener('focus', wakeRefresh);

// ---- UI wiring ----------------------------------------------------------
// ── 구간 전력량 (interval energy) ────────────────────────────────────────────────────────────
// 현재 '전력 W' 그래프가 그리는 바로 그 계열(레일+측정방식 — 수지/ioreg V×I/혼합/시스템/어댑터)을
// 지정 구간에서 적분한다. 라이브 "전력량 측정"과 정확도 동일(각 1분 에너지 = 평균전력×60초 = ∫W dt).
// 배터리 게이지 검산(rawCap 쿨롱 델타)도 함께 보여준다. 2D에선 곡선과 0선 사이 '넓이'를 음영으로
// 칠해 적분을 시각화한다. 끝점은 선형보간으로 클립하고, 값이 없는(예: 앱 미실행) 구간은 제외.
state.intervalSel = null;   // { t0, t1 } — 선택 구간
// 현재 그래프의 전력 계열 이름 (Y=watts일 때만 의미). wattValueOf가 실제 적분 대상.
function ivSeriesLabel() {
  if (state.y !== 'watts') return null;
  return state.wattsRail === 'battery' ? `배터리 · ${PM_LABEL[state.powerMethod]}` : WLABEL[state.wattsRail];
}
function computeIntervalEnergy(t0, t1) {
  const r = state.report;
  if (!r || !r.runs || !(t1 > t0)) return null;
  const powerOf = state.y === 'watts' ? wattValueOf : null;   // 현재 그래프 계열 (없으면 전력 적분 생략)
  const signed = isSignedY();
  let ws = 0, wsChg = 0, wsDis = 0, effSec = 0;               // 전력 적분 (watt-seconds)
  let gWh = 0, capFirst = null, capLast = null, gEff = 0;     // 게이지 검산 (rawCap 쿨롱)
  for (const run of r.runs) {
    const p = run.points;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const s0 = Math.max(a.t, t0), s1 = Math.min(b.t, t1);
      if (!(s1 > s0)) continue;
      const span = b.t - a.t; if (!(span > 0)) continue;
      const f0 = (s0 - a.t) / span, f1 = (s1 - a.t) / span, dt = s1 - s0;
      const ip = (va, vb) => [va + (vb - va) * f0, va + (vb - va) * f1];
      if (powerOf) {
        const va = powerOf(a), vb = powerOf(b);
        if (va != null && vb != null && Number.isFinite(va) && Number.isFinite(vb)) {
          const [w0, w1] = ip(va, vb);
          const area = (w0 + w1) / 2 * dt; ws += area;
          if (area >= 0) wsChg += area; else wsDis += -area;
          effSec += dt;
        }
      }
      if (a.rawCap != null && b.rawCap != null && a.voltage > 0 && b.voltage > 0) {
        const [c0, c1] = ip(a.rawCap, b.rawCap), [v0, v1] = ip(a.voltage, b.voltage);
        gWh += (c1 - c0) / 1000 * (v0 + v1) / 2;   // Δ전하(Ah)×평균전압 = Wh (방전 시 rawCap↓ → 음수)
        if (capFirst == null) capFirst = c0;
        capLast = c1; gEff += dt;
      }
    }
  }
  return {
    y: state.y, seriesLabel: ivSeriesLabel(), signed,
    hasPower: !!powerOf && effSec > 0,
    wh: ws / 3600, whChg: wsChg / 3600, whDis: wsDis / 3600,
    avgW: effSec > 0 ? ws / effSec : null, effSec,
    gaugeWh: capFirst != null ? gWh : null,
    gaugeMah: (capFirst != null && capLast != null) ? Math.round(capLast - capFirst) : null,
    gaugeSec: gEff,
    gapSec: Math.max(0, (t1 - t0) - Math.max(effSec, gEff)),
  };
}
const pad2 = n => String(n).padStart(2, '0');
// datetime-local 입력값 ↔ epoch (달력 피커 유지). value 는 "YYYY-MM-DDTHH:MM"(로컬).
const epochToInput = t => { const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const inputToEpoch = v => { const t = new Date(v).getTime(); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
// 결과에 보여줄 연도 우선 표기: "2026/07/12 06:00 PM"
function epochToText(t) {
  const d = new Date(t * 1000); let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(h)}:${pad2(d.getMinutes())} ${ap}`;
}
const fmtDurSec = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`; };
const sgnW = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
function renderIvResult(res, t0, t1) {
  const el = document.getElementById('ivResult'); if (!el) return;
  if (!res) { el.hidden = false; el.innerHTML = `<span class="warn">시작/끝 시각이 올바르지 않아요. 예: 2026/07/12 06:00 PM</span>`; return; }
  const rows = [];
  rows.push(`<div class="range">${epochToText(t0)} ~ ${epochToText(t1)}</div>`);
  // 1) 현재 그래프 계열의 전력량
  if (res.y !== 'watts') {
    rows.push(`<div class="warn">‘세로축 = 전력 W’로 바꾸면 그 전력의 구간 전력량도 계산해요.</div>`);
  } else if (res.hasPower) {
    rows.push(`<div class="serieslbl">${res.seriesLabel}</div>`);
    rows.push(`<div class="big">${res.signed ? sgnW(res.wh) : res.wh.toFixed(2)}<small>Wh</small></div>`);
    if (res.signed && (res.whChg > 0.005 || res.whDis > 0.005))
      rows.push(`<div class="row"><span>충전 / 방전</span><b><span class="chg">+${res.whChg.toFixed(2)}</span> / <span class="dis">−${res.whDis.toFixed(2)}</span> Wh</b></div>`);
    rows.push(`<div class="row"><span>평균 전력</span><b>${res.signed ? sgnW(res.avgW) : res.avgW.toFixed(1)} W</b></div>`);
    rows.push(`<div class="row"><span>유효 시간</span><b>${fmtDurSec(res.effSec)}</b></div>`);
  } else {
    rows.push(`<div class="warn">이 구간엔 ‘${res.seriesLabel}’ 데이터가 없어요 (앱 미실행 시 시스템·어댑터 전력은 기록되지 않아요).</div>`);
  }
  // 2) 배터리 게이지 검산 (항상, 배터리 기록이 있으면)
  if (res.gaugeMah != null) {
    rows.push(`<div class="gauge"><span>배터리 게이지 검산</span><b>${sgnW(res.gaugeWh)} Wh · ${res.gaugeMah >= 0 ? '+' : ''}${res.gaugeMah.toLocaleString()} mAh</b></div>`);
  }
  if (res.gapSec > 90) rows.push(`<div class="warn">이 구간에 기록 공백 ${fmtDurSec(res.gapSec)} — 그 시간은 제외됐어요.</div>`);
  el.hidden = false; el.innerHTML = rows.join('');
}
// 저장된 구간을 현재 그래프 계열로 다시 계산·표시 (rebuild/계열 변경 시 동기화)
function ivRecompute() {
  if (!state.intervalSel) return;
  const { t0, t1 } = state.intervalSel;
  renderIvResult(computeIntervalEnergy(t0, t1), t0, t1);
}
function ivCalc() {
  const t0 = inputToEpoch(document.getElementById('ivStart').value);
  const t1 = inputToEpoch(document.getElementById('ivEnd').value);
  if (t0 == null || t1 == null || !(t1 > t0)) { state.intervalSel = null; renderIvResult(null); drawIntervalOverlay(); return; }
  state.intervalSel = { t0, t1 };
  renderIvResult(computeIntervalEnergy(t0, t1), t0, t1);
  drawIntervalOverlay();
}
// datetime-local의 native 표기는 로케일(월-우선)이라, 그 위에 연도우선 텍스트를 직접 그려 덮는다.
function ivSyncShow(id) {
  const inp = document.getElementById(id), show = document.getElementById(id + 'Show'); if (!inp || !show) return;
  const t = inputToEpoch(inp.value);
  if (t != null) { show.textContent = epochToText(t); show.classList.remove('empty'); }
  else { show.textContent = id === 'ivStart' ? '시작 시각' : '끝 시각'; show.classList.add('empty'); }
}
function ivFillFromView() {
  const sp = flatSpanNow(); const w = state.flatWin ? state.flatWin : { t0: sp.min, t1: sp.max };
  document.getElementById('ivStart').value = epochToInput(w.t0);
  document.getElementById('ivEnd').value = epochToInput(Math.min(w.t1, sp.max));
  ivSyncShow('ivStart'); ivSyncShow('ivEnd');
}
// 선택 구간에서 현재 계열 곡선과 0선 사이의 '넓이'를 음영으로(= 적분 시각화). 2D·3D 모두 지원.
// 3D는 가로축이 '하루 중 시각'·깊이축이 '날짜'라, 여러 날에 걸친 구간은 날짜 레이어마다 음영이
// 나뉘어 그려진다(자정 경계에서 끊음). 계산 자체는 보기와 무관하게 동일하다.
function drawIntervalOverlay() {
  disposeGroup(intervalGroup);
  intervalGroup.visible = !!state.intervalSel && !!state.report;
  if (!intervalGroup.visible) return;
  const flat = state.view === 'flat';
  const t0 = state.intervalSel.t0, t1 = state.intervalSel.t1;
  const a = flat ? Math.max(t0, _fw.w0) : t0, b = flat ? Math.min(t1, _fw.w1) : t1;
  if (!(b > a)) return;   // (2D) 선택 구간이 현재 창 밖
  const yMax = projYMax || 1, base = yFromVal(0, yMax);
  // 3D 날짜 인덱스: buildLines와 동일하게 report.firstT의 로컬 자정 기준
  const rf = new Date((state.report.firstT || 0) * 1000); rf.setHours(0, 0, 0, 0);
  const dayBase = rf.getTime() / 1000, dayOfT = t => Math.floor((t - dayBase) / 86400);
  const X3 = t => flat ? xFlat(t) : xFromTod(todOf(t));
  const Z3 = t => flat ? 0 : zFromDay(dayOfT(t), projMaxDay);
  if (state.y === 'watts') {   // 곡선 아래 넓이(적분) 음영
    const pos = [];
    for (const run of state.report.runs) {
      const p = run.points;
      for (let i = 1; i < p.length; i++) {
        const pa = p[i - 1], pb = p[i];
        if (!flat && dayOfT(pa.t) !== dayOfT(pb.t)) continue;   // 3D: 자정 경계는 잇지 않음
        const s0 = Math.max(pa.t, a), s1 = Math.min(pb.t, b);
        if (!(s1 > s0)) continue;
        const va = wattValueOf(pa), vb = wattValueOf(pb), span = pb.t - pa.t;
        if (va == null || vb == null || !Number.isFinite(va) || !Number.isFinite(vb) || !(span > 0)) continue;
        const f0 = (s0 - pa.t) / span, f1 = (s1 - pa.t) / span;
        const y0 = yFromVal(va + (vb - va) * f0, yMax), y1 = yFromVal(va + (vb - va) * f1, yMax);
        const x0 = X3(s0), x1 = X3(s1), z0 = Z3(s0), z1 = Z3(s1);
        pos.push(x0, base, z0, x0, y0, z0, x1, y1, z1);   // 곡선과 0선 사이 사각형 → 두 삼각형
        pos.push(x0, base, z0, x1, y1, z1, x1, base, z1);
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      intervalGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false })));
    }
  } else if (flat) {   // 비-전력 2D 보기: 선택 구간을 옅은 세로 밴드로만
    const x0 = xFlat(a), x1 = xFlat(b);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, Y + 1), new THREE.MeshBasicMaterial({ color: 0x4dd0c0, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide }));
    plane.position.set((x0 + x1) / 2, Y / 2, 0.02); intervalGroup.add(plane);
  }
  if (flat) {   // 2D: 양 끝 세로선 (3D는 자정 wrap이라 단일 세로선이 모호해 생략)
    for (const [x, edge] of [[xFlat(a), t0 >= _fw.w0], [xFlat(b), t1 <= _fw.w1]]) {
      if (!edge) continue;
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -0.4, 0.05), new THREE.Vector3(x, Y + 0.4, 0.05)]);
      intervalGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x4dd0c0 })));
    }
  }
}
{
  document.getElementById('ivCalc').addEventListener('click', ivCalc);
  document.getElementById('ivNow').addEventListener('click', ivFillFromView);
  document.getElementById('ivClear').addEventListener('click', () => {
    state.intervalSel = null; document.getElementById('ivResult').hidden = true; drawIntervalOverlay();
  });
  for (const id of ['ivStart', 'ivEnd']) {
    const inp = document.getElementById(id);
    inp.addEventListener('input', () => ivSyncShow(id));
    inp.addEventListener('change', () => ivSyncShow(id));
    ivSyncShow(id);   // 초기 플레이스홀더
  }
}

document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (seg.dataset.group === 'projToggle') {   // 방전/충전 = 독립 토글(라디오 아님)
      const on = !b.classList.contains('on'); b.classList.toggle('on', on);
      const key = b.dataset.pt === 'dis' ? 'projDis' : 'projChg', ls = b.dataset.pt === 'dis' ? 'battProjDis' : 'battProjChg';
      state[key] = on ? 'on' : 'off';
      try { localStorage.setItem(ls, state[key]); } catch { /* ignore */ }
      drawProjection3D();
      return;
    }
    seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const group = seg.dataset.group, val = b.dataset.val;
    if (group === 'source') { state.source = val; state.selectedPeriod = null; state.flatWin = null; load(); }   // stale period keys don't cross sources · 2D 창은 소스별 epoch라 반드시 리셋(P0-3)
    else if (group === 'ui') { applyUI(val); }
    else if (group === 'layout') { applyLayout(val); }
    else if (group === 'view') { setView(val); }
    else if (group === 'flatRange') { applyFlatRange(val); }
    else if (group === 'xScale') { setXScale(+val); }
    else if (group === 'rateWin') { state.rateWin = +val; try { localStorage.setItem('battRateWin', val); } catch { /* ignore */ } rebuild(); }
    else if (group === 'wattsRail') { state.wattsRail = val; try { localStorage.setItem('battWattsRail', val); } catch { /* ignore */ } rebuild(); }
    else if (group === 'powerMethod') { state.powerMethod = val; try { localStorage.setItem('battPowerMethod', val); } catch { /* ignore */ } rebuild(); loadRates(); }   // 그래프 배터리 전력 + 구간별전력 재계산
    else if (group === 'markerSize') { state.markerSize = +val; marker.scale.setScalar(+val); try { localStorage.setItem('battMarkerSize', val); } catch { /* ignore */ } }
    else if (group === 'rateLevel') { state.rateLevel = val; try { localStorage.setItem('battRateLevel', val); } catch { /* ignore */ } load(); }   // 전역 정밀도: 리포트+속도패널+그래프 전부 재계산
    else if (group === 'floorGuide') { state.floorGuide = val; try { localStorage.setItem('battFloorGuide', val); } catch { /* ignore */ } if (pinned || curHover) { placeGuides((pinned || curHover).vp); overlay.visible = true; } }
    else if (group === 'valGuide') { state.valGuide = val; try { localStorage.setItem('battValGuide', val); } catch { /* ignore */ } if (pinned || curHover) { placeGuides((pinned || curHover).vp); overlay.visible = true; } }
    else { state[group] = val; rebuild(); }
  });
});
// i18n: translate static + dynamic viewer content. Language is chosen in the POPOVER settings
// (shared via localStorage 'battLang' — same origin), so the viewer just reads and applies it.
initI18n().then(() => {
  observeI18n();
  const title = t('3D 분석 리포트');
  document.title = title;   // browser tab
  // Native window title bar: Tauri doesn't mirror document.title, and Tauri IPC is unreliable for this
  // external-URL window, so send it through the same file bridge as height/actions → Rust set_title.
  fetch('/api/main-title', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).catch(() => {});
});

// The language is chosen in the POPOVER (writes localStorage 'battLang', same origin). An already-open
// viewer must pick that up too — the popover reloads itself, but this window won't unless we react.
// Reload when battLang changes: via the standard cross-document 'storage' event, plus a light poll
// fallback because Tauri's separate webviews don't reliably deliver 'storage' across windows.
window.addEventListener('storage', e => { if (e.key === 'battLang' && (e.newValue || 'ko') !== curLang()) location.reload(); });
setInterval(() => { try { if ((localStorage.getItem('battLang') || 'ko') !== curLang()) location.reload(); } catch { /* ignore */ } }, 1500);

// reflect current state on every segmented control (defaults + deep-linked y/color/xScale)
document.querySelectorAll('.seg').forEach(seg => {
  const g = seg.dataset.group;
  if (g === 'projToggle') { seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.pt === 'dis' ? state.projDis : state.projChg) === 'on')); return; }
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', g === 'xScale' ? +b.dataset.val === state.xScale : String(state[g]) === b.dataset.val));
});

// ?안내 — the Tauri (WKWebView) window swallows target=_blank, so show help.html in an in-app modal (works in a browser too)
{
  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');
  const helpFrame = document.getElementById('helpFrame');
  if (helpBtn && helpModal && helpFrame) {
    const close = () => { helpModal.hidden = true; };
    helpBtn.addEventListener('click', e => {
      e.preventDefault();
      if (!helpFrame.dataset.loaded) {   // lazy-load once — prefer the translated help.<lang>.html, fall back to Korean
        helpFrame.dataset.loaded = '1';
        const lang = curLang();
        if (lang && lang !== 'ko') {
          const cand = `/help.${lang}.html`;
          fetch(cand, { method: 'HEAD' }).then(r => { helpFrame.src = r.ok ? cand : '/help.html'; }).catch(() => { helpFrame.src = '/help.html'; });
        } else helpFrame.src = '/help.html';
      }
      helpModal.hidden = false;
    });
    document.getElementById('helpClose').addEventListener('click', close);
    helpModal.addEventListener('click', e => { if (e.target === helpModal) close(); });   // backdrop click
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !helpModal.hidden) close(); });
  }
}

document.getElementById('spin').addEventListener('change', e => { if (state.view === 'flat') { e.target.checked = false; return; } controls.autoRotate = e.target.checked; controls.autoRotateSpeed = 0.6; });
document.getElementById('reset').addEventListener('click', () => {
  if (state.view === 'flat') { applyFlatWin(null); return; }   // 2D: 전체 보기로 리셋
  camera.position.copy(HOME).multiplyScalar(0.6 + 0.4 * state.xScale); controls.target.copy(LOOK);
});
// info (i) tooltips: portal a copy to <body> on hover so a panel's overflow:auto can't clip them
{
  const portal = document.createElement('div');
  portal.className = 'ftip-portal'; portal.hidden = true; document.body.appendChild(portal);
  document.addEventListener('mouseover', e => {
    const info = e.target.closest && e.target.closest('.info'); if (!info) return;
    const ft = info.querySelector('.ftip'); if (!ft) return;
    portal.innerHTML = ft.innerHTML;
    const r = info.getBoundingClientRect();
    portal.style.left = Math.max(8, Math.min(innerWidth - 252, r.left - 110)) + 'px';
    portal.style.top = 'auto'; portal.style.bottom = (innerHeight - r.top + 6) + 'px';   // above the icon
    portal.hidden = false;
  });
  document.addEventListener('mouseout', e => { if (e.target.closest && e.target.closest('.info')) portal.hidden = true; });
}
document.getElementById('gear').addEventListener('click', () => {   // ⚙ 뷰어 설정 (마커 크기 · 정밀도)
  const s = document.getElementById('viewerSettings');
  s.hidden = !s.hidden;
  document.getElementById('gear').classList.toggle('on', !s.hidden);
});

// stretch the 하루 중 시각 (X) axis so a day's curve spreads out horizontally; dolly the camera out to keep it framed
// ---- 보기 모드 전환 (3D ↔ 2D 시간축) ----------------------------------------------------------
// 2D는 카메라를 정면 고정하고 OrbitControls를 끈다 — 팬/줌은 시간 창(state.flatWin)으로 한다.
// 전역 `camera` 변수는 교체하지 않는다(pickAt·툴팁 투영·projTag가 참조).
function setView(v) {
  state.view = v === 'flat' ? 'flat' : '3d';
  try { localStorage.setItem('battView', state.view); } catch { /* ignore */ }
  if (state.view === 'flat') { controls.enabled = false; controls.autoRotate = false; fitFlatCamera(); }
  else { controls.enabled = true; camera.position.copy(HOME).multiplyScalar(0.6 + 0.4 * state.xScale); controls.target.copy(LOOK); }
  rebuild();
}
// 정면 카메라: FLAT_W가 좌우 오버레이 패널을 뺀 "빈 가로 구간"에 꽉 차게 거리·x를 계산.
// (종전엔 창 전체 폭 기준이라 원점·세로축이 왼쪽 패널에, 그래프 오른쪽 끝이 #panel에 가려짐)
let _flatK = 1.17;   // 화면 전체 폭에 보이는 월드 폭 / FLAT_W — px→시간 환산(팬)이 재사용
// A panel is "shown" if it takes real space. NOTE: these panels are position:fixed, whose
// offsetParent is ALWAYS null — so the old offsetParent check treated every panel as hidden and
// never applied the offset (the bug that left the axis/right edge covered). Test computed display +
// a non-empty rect instead.
function panelRect(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  const r = el.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) ? r : null;
}
function flatFreeStrip() {
  // 왼쪽(#hud·#buckets)·오른쪽(#panel) 고정 오버레이가 차지하는 폭을 실측 — 숨김(display:none)은 제외
  let L = 0, R = 0;
  for (const id of ['hud', 'buckets']) {
    const r = panelRect(id);
    if (r) L = Math.max(L, r.right);
  }
  const p = panelRect('panel');
  if (p) R = Math.max(0, innerWidth - p.left);
  L = Math.max(0, L);
  // 창이 아주 좁아 패널이 화면 대부분을 덮으면 종전 전체-폭 맞춤으로 후퇴 (그래프가 실처럼 눌리는 것 방지)
  if (innerWidth - L - R < innerWidth * 0.4) return { L: 0, R: 0 };
  return { L, R };
}
function fitFlatCamera() {
  const vFov = camera.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const { L, R } = flatFreeStrip();
  const W = Math.max(1, innerWidth);
  // 여유 17%: 값 라벨(x0−2.2)·축 제목(x0−4.5)까지 빈 구간 안에 — 빈 구간 기준으로 전체 가시 폭을 역산
  const Vw = FLAT_W * 1.17 * W / Math.max(1, W - L - R);
  _flatK = Vw / FLAT_W;
  const D = (Vw / 2) / Math.tan(hFov / 2);
  const cx = (R - L) / 2 * Vw / W;   // 월드 x=0(그래프 중앙)이 빈 구간의 중앙에 오도록 카메라를 평행 이동
  camera.position.set(cx, Y / 2, D);
  camera.lookAt(cx, Y / 2, 0);
}
// 패널 접기/펼치기·내용 변화로 오버레이 폭이 바뀌면 빈 구간이 달라진다 → 카메라만 다시 맞춤
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => { if (state.view === 'flat') fitFlatCamera(); });
  for (const id of ['hud', 'buckets', 'panel']) { const el = document.getElementById(id); if (el) ro.observe(el); }
}
function applyFlatRange(v) {
  applyFlatWin(FV.presetWindow(v, state.flatWin, flatSpanNow()));
}

function setXScale(v) {
  state.xScale = v;
  X = X_BASE * v;
  try { localStorage.setItem('battXScale', String(v)); } catch { /* ignore */ }
  camera.position.copy(HOME).multiplyScalar(0.6 + 0.4 * v); controls.target.copy(LOOK);
  rebuild();
}

// theme (dark / light) — recolors WebGL scenes + SVG charts + CSS panels, persisted
function applyTheme() {
  document.documentElement.classList.toggle('light', state.theme === 'light');
  try { localStorage.setItem('battViewerTheme', state.theme); } catch { /* ignore */ }
  document.getElementById('theme').textContent = state.theme === 'light' ? '☀️ 라이트' : '🌙 다크';
  scene.background = new THREE.Color(TH().sceneBg);
  scene.fog = new THREE.Fog(TH().sceneBg, TH().fog[0], TH().fog[1]);
  if (t3) t3.scene.background = new THREE.Color(TH().trendBg);
  if (state.report) rebuild();      // main axes/lines
  if (state.rates) renderRates();   // panel + 2D/heatmap/3D trend
}
document.getElementById('theme').addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme(); });
applyTheme();   // set initial button label / class

// UI style presets (1 기본 · 2 컴팩트 · 3 널찍 · 4 글래스 · 5 카드) — CSS-only, persisted
function applyUI(v) {
  document.documentElement.classList.remove('ui-1', 'ui-2', 'ui-3', 'ui-4', 'ui-5');
  state.ui = v; document.documentElement.classList.add('ui-' + v);
  try { localStorage.setItem('battUI', v); } catch { /* ignore */ }
  document.querySelectorAll('.seg[data-group="ui"] button').forEach(x => x.classList.toggle('on', x.dataset.val === v));
}
applyUI(state.ui);   // apply persisted preset + mark button

// ===== Layout / flow presets: A 대시보드 · B 탭바 · C 사이드바 · D 도크 · E 카드 =====
// Reuses the existing panels (#hud/#panel/#buckets/#trendchart/#scene); layout classes on <html>
// reposition/show-hide them, and a shared nav (#lnav) + insight cards (#insight) provide the flow.
const LTABS = [['3d', '🧊 3D'], ['speed', '📊 속도'], ['trend', '📈 추세'], ['health', '🔋 건강'], ['settings', '⚙ 설정']];
const SINGLE_VIEW = { b: 1, c: 1, d: 1 };
function renderLnav() {
  const nav = document.getElementById('lnav');
  if (!SINGLE_VIEW[state.layout]) { nav.innerHTML = ''; return; }
  nav.innerHTML = LTABS.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('');
}
function setTab(t) {
  state.tab = t;
  const h = document.documentElement;
  ['3d', 'speed', 'trend', 'health', 'settings'].forEach(x => h.classList.remove('tab-' + x));
  h.classList.add('tab-' + t);
  if (t === 'trend' && state.selectedBand == null && !state.trendAll) { state.trendAll = true; renderRates(); }
  renderLnav();
}
function renderInsight() {
  const el = document.getElementById('insight');
  if (state.layout !== 'e') { el.hidden = true; return; }
  el.hidden = false;
  const r = state.report;
  if (!r) { el.innerHTML = '<div class="icard">불러오는 중…</div>'; return; }
  const L = r.latest;
  const cap = L && L.healthPct != null ? Math.min(100, Math.round(L.healthPct)) : null;
  const aged = cap != null ? 100 - cap : null;
  const e = avgRate(r.bucketsEarly), n = avgRate(r.bucketsRecent);
  const early = e ? (10 / e).toFixed(0) : null, recent = n ? (10 / n).toFixed(0) : null;
  el.innerHTML =
    `<div class="icard big"><span class="ik">배터리 최대 용량</span><span class="iv">${cap != null ? cap + '%' : '–'}</span><span class="isub">노화 ${aged != null ? aged + '%p' : '–'}${L ? ' · ' + L.cycles + '사이클' : ''}</span></div>` +
    `<div class="icard"><span class="ik">10% 소모 시간 (초기→최근)</span><span class="iv">${early && recent ? `${early}→${recent}분` : '–'}</span><span class="isub">${early && recent ? (recent < early ? '점점 빨라짐' : '안정') : '데이터 더 필요'}</span></div>` +
    `<div class="icard drill" data-tab="trend"><span class="ik">왜 빨라졌나?</span><span class="iv">추세로 확인 →</span><span class="isub">부하(W) vs 노화(Wh/%) 분리해서 보기</span></div>` +
    `<div class="idrill"><button data-tab="3d">🧊 3D</button><button data-tab="speed">📊 속도</button><button data-tab="trend">📈 추세</button><button data-tab="settings">⚙ 설정</button></div>`;
}
function applyLayout(l) {
  const h = document.documentElement;
  ['a', 'b', 'c', 'd', 'e'].forEach(x => h.classList.remove('lay-' + x));
  h.classList.remove('single-view');
  state.layout = l; h.classList.add('lay-' + l);
  if (SINGLE_VIEW[l]) h.classList.add('single-view');
  try { localStorage.setItem('battLayout', l); } catch { /* ignore */ }
  document.querySelectorAll('.seg[data-group="layout"] button').forEach(x => x.classList.toggle('on', x.dataset.val === l));
  renderInsight();
  if (SINGLE_VIEW[l]) setTab(state.tab); else renderLnav();
}
document.getElementById('lnav').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.tab) setTab(b.dataset.tab); });
document.getElementById('insight').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { applyLayout('b'); setTab(b.dataset.tab); } });
applyLayout(state.layout);   // apply persisted layout

// rate panel: version toggle (re-render) / level toggle (re-fetch)
document.getElementById('buckets').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn) {
    if (btn.hasAttribute('data-bfold')) {
      state.foldBuckets = !state.foldBuckets;
      try { localStorage.setItem('battFoldB', state.foldBuckets ? '1' : '0'); } catch { /* ignore */ }
      renderRates();
    }
    else if (btn.dataset.rm) { state.metric = btn.dataset.rm; renderRates(); }
    else if (btn.dataset.rp) { state.period = btn.dataset.rp; state.selectedPeriod = null; loadRates(); }
    else if (btn.dataset.rv) { state.rateVersion = btn.dataset.rv; renderRates(); }
    return;
  }
  const tr = e.target.closest('tr[data-band]');
  if (tr) { state.selectedBand = +tr.dataset.band; state.trendAll = false; renderRates(); }
});
document.getElementById('trendchart').addEventListener('click', e => {
  const cell = e.target.closest('[data-period]');
  if (cell && !e.target.closest('button')) { state.selectedPeriod = cell.dataset.period; renderTrend(); return; }
  const b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-tall')) state.trendAll = !state.trendAll;
  else if (b.hasAttribute('data-tview')) state.trendView = b.getAttribute('data-tview');
  else if (b.hasAttribute('data-tgeom')) { const gm = b.getAttribute('data-tgeom'); if (gm === 'grid' && state.trendGeom === 'grid') state.gridMain = state.gridMain === 'lines' ? 'ridges' : 'lines'; else state.trendGeom = gm; }
  else if (b.hasAttribute('data-tzero')) state.zeroMode = b.getAttribute('data-tzero');
  else if (b.hasAttribute('data-tick')) { const g = b.getAttribute('data-tick'); state['tick' + g[0].toUpperCase() + g.slice(1)] = +b.getAttribute('data-v'); }
  else if (b.hasAttribute('data-tdelta')) state.delta = !state.delta;
  else if (b.hasAttribute('data-tticks')) state.showTicks = !state.showTicks;
  else if (b.hasAttribute('data-tmore')) state.trendMore = !state.trendMore;
  else if (b.hasAttribute('data-tfold')) {
    state.foldTrend = !state.foldTrend;
    if (state.foldTrend) state.trendBig = false;   // 확대 상태에서 최소화 → 가운데가 아니라 아래(기본 위치)로
    try { localStorage.setItem('battFoldT', state.foldTrend ? '1' : '0'); } catch { /* ignore */ }
  }
  else if (b.hasAttribute('data-tbig')) state.trendBig = !state.trendBig;
  renderTrend();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (state.view === 'flat') fitFlatCamera();
  renderer.setSize(innerWidth, innerHeight);
  if (t3 && state.trendAll && state.trendView === '3d' && !state.foldTrend) renderTrend();   // 3D trend canvas resizes too
});

// keep labels readable (face camera handled by Sprite; nothing extra needed)
(function animate() {
  requestAnimationFrame(animate);
  if (controls.enabled) controls.update();   // 2D 모드에선 카메라 고정(팬/줌은 시간 창)
  if (pinned && !tipManual) {   // 고정 마커를 화면좌표로 투영해 툴팁이 따라붙게 (단, 직접 드래그로 옮겼으면 그 자리 유지)
    const s = pinned.vp.clone().project(camera);
    positionTip((s.x * 0.5 + 0.5) * innerWidth, (-s.y * 0.5 + 0.5) * innerHeight - 16);
  }
  for (const t of proj3DTags) {   // 예상 종료시각 태그를 3D 크로싱 지점에 화면좌표로 붙여 항상 위에 표시
    const s = t.vp.clone().project(camera);
    if (s.z > 1) { t.el.style.display = 'none'; continue; }   // 카메라 뒤면 숨김
    t.el.style.display = '';
    const x = (s.x * 0.5 + 0.5) * innerWidth, y = (-s.y * 0.5 + 0.5) * innerHeight, r = t.el.getBoundingClientRect();
    t.el.style.left = Math.min(Math.max(6, x - r.width / 2), innerWidth - r.width - 6) + 'px';
    t.el.style.top = Math.min(Math.max(6, y + 10 + t.yBias), innerHeight - r.height - 6) + 'px';
  }
  renderer.render(scene, camera);
})();

// optional shareable view via URL hash: #all #heat #3d #ridge #surface #wh #week #month
{ const h = location.hash;
  if (/all|heat|3d|ridge|surface|grid/.test(h)) state.trendAll = true;
  if (h.includes('heat')) state.trendView = 'heat';
  if (/3d|ridge|surface|grid/.test(h)) state.trendView = '3d';
  if (h.includes('ridge')) state.trendGeom = 'ridges';
  if (h.includes('grid')) state.trendGeom = 'grid';
  if (h.includes('gridr')) state.gridMain = 'ridges';
  if (h.includes('surface')) state.trendGeom = 'surface';
  if (h.includes('wh')) state.metric = 'wh';
  if (h.includes('week')) state.period = 'week';
  if (h.includes('month')) state.period = 'month';
  if (h.includes('big')) state.trendBig = true;
  if (h.includes('light')) { state.theme = 'light'; applyTheme(); } }

// 저장/딥링크로 2D 시간축 모드로 시작하는 경우: 첫 로드 전에 카메라 고정 + 회전 컨트롤 off
if (state.view === 'flat') { controls.enabled = false; fitFlatCamera(); }
load();
