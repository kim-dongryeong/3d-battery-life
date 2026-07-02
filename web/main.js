import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- world dimensions ---------------------------------------------------
// X = 하루 중 시각 (0..24h)  ·  Y = 배터리 %/W (높이)  ·  Z = 경과 일수 (깊이)
// (kdr 호칭: 그가 부르는 x=날짜=내 Z · y=시각=내 X · z=잔량=내 Y — 그래프는 그대로, 명칭만 매핑)
const X = 24, Y = 16, Z = 44;
const xFromTod = h => (h - 12) / 24 * X;                 // 0시 -> -12, 24시 -> +12

// ---- state --------------------------------------------------------------
const state = { source: 'demo2', y: 'pct', color: 'state', report: null, rates: null, rateVersion: 'v4a_pooled', rateLevel: 'pct', selectedBand: null, selectedPeriod: null, trendAll: false, trendBig: false, trendView: 'line', trendGeom: 'lines', period: 'day', metric: 'rate', delta: false, zeroMode: 'both', tickDate: 2, tickBand: 2, tickVal: 2, gridMain: 'lines' };
state.theme = (() => { try { return localStorage.getItem('battTheme') || 'dark'; } catch { return 'dark'; } })();
state.ui = (() => { try { return localStorage.getItem('battUI') || '1'; } catch { return '1'; } })();
state.layout = (() => { try { return localStorage.getItem('battLayout') || 'a'; } catch { return 'a'; } })();
state.tab = '3d';   // active view for single-view layouts (B 탭바 / C 사이드바 / D 도크)

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

// ---- helpers ------------------------------------------------------------
const todOf = t => { const d = new Date(t * 1000); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const percentile = (arr, p) => { if (!arr.length) return 1; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// perceptual-ish ramp: blue -> cyan -> green -> yellow -> red
function ramp(t) { t = clamp(t, 0, 1); return new THREE.Color().setHSL((1 - t) * 0.66, 0.85, 0.55); }

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
const yFromVal = (v, valMax) => clamp(v / (valMax > 0 ? valMax : 1), 0, 1) * Y;

function buildAxes(valMax, valLabel, maxDay, firstT) {
  disposeGroup(sceneRoot);
  const x0 = -X / 2, z0 = -Z / 2, z1 = Z / 2;

  const grid = new THREE.GridHelper(Z, 22, TH().gMain, TH().gMinor);
  sceneRoot.add(grid);

  sceneRoot.add(axisLine([x0, 0, z0], [X / 2, 0, z0], TH().axis));   // X = 시각
  sceneRoot.add(axisLine([x0, 0, z0], [x0, Y, z0], TH().axis));      // Y = 잔량/전력
  sceneRoot.add(axisLine([x0, 0, z0], [x0, 0, z1], TH().axis));      // Z = 날짜

  // X ticks: hours
  for (const h of [0, 6, 12, 18, 24]) {
    const s = makeLabel(`${h}시`, { size: 30, color: TH().tickC }); s.position.set(xFromTod(h), -1, z0 - 1.2); sceneRoot.add(s);
  }
  const xt = makeLabel('하루 중 시각 →', { color: TH().titleC }); xt.position.set(0, -2.6, z0 - 2); sceneRoot.add(xt);

  // Y ticks: battery % or watts (height)
  for (let i = 0; i <= 4; i++) {
    const v = valMax * i / 4, y = Y * i / 4;
    sceneRoot.add(axisLine([x0 - 0.3, y, z0], [x0, y, z0], TH().axisTick));
    const s = makeLabel(state.y === 'pct' ? `${Math.round(v)}%` : `${v.toFixed(0)}W`, { size: 28, color: TH().tickC });
    s.position.set(x0 - 2.2, y, z0); sceneRoot.add(s);
  }
  const yt = makeLabel(valLabel, { color: TH().titleC }); yt.position.set(x0 - 4.5, Y + 1, z0); sceneRoot.add(yt);

  // Z ticks: dates (older -> recent)
  const days = maxDay <= 1 ? [0] : [0, Math.round(maxDay / 2), maxDay];
  for (const d of days) {
    const date = new Date(((firstT || 0) + d * 86400) * 1000);
    const s = makeLabel(`${date.getMonth() + 1}/${date.getDate()}`, { size: 26, color: TH().tickC }); s.position.set(x0 - 1.5, -0.4, zFromDay(d, maxDay)); sceneRoot.add(s);
  }
  const zt = makeLabel('경과 일수 (오래됨 → 최근)', { color: TH().titleC }); zt.position.set(x0 - 2, -2.6, z1 - 6); sceneRoot.add(zt);
}

// ---- battery curves (continuous runs: charge + discharge, gap-split) ----
const C_DISCHARGE = new THREE.Color().setHSL(0.02, 0.85, 0.55); // red-orange
const C_CHARGE = new THREE.Color().setHSL(0.33, 0.80, 0.50);    // green
const C_FULL = new THREE.Color().setHSL(0.55, 0.45, 0.50);      // dim blue
const stateColor = p => (p.charging ? C_CHARGE : (p.ac ? C_FULL : C_DISCHARGE));

let lines = [];
function buildLines(report) {
  // detach the shared highlight material so disposeGroup doesn't free it
  if (hovered) { hovered.material = hovered.userData.base; hovered = null; }
  if (tip) tip.hidden = true;
  disposeGroup(lineRoot); lines = [];
  const runs = report.runs || [];
  if (!runs.length) return { yMax: 100, maxDay: 1, cMin: null, cMax: null };

  const t0 = report.firstT || 0;
  const dayOfT = t => Math.floor((t - t0) / 86400);          // per-point day (handles midnight-crossing runs)
  const maxDay = Math.max(1, report.spanDays || 0, ...runs.map(r => r.dayIndex));
  const numeric = state.color !== 'state';
  let cMin = null, cMax = null;
  if (numeric) {
    const vals = [];
    for (const r of runs) for (const p of r.points) { const v = p[state.color]; if (v != null) vals.push(v); }
    if (vals.length) {                                   // percentile-clamp so one outlier (e.g. a load spike) doesn't wash out the ramp
      cMin = percentile(vals, 0.02); cMax = percentile(vals, 0.98);
      if (cMax <= cMin) cMax = cMin + 1e-6;
    }
  }
  const yMaxRaw = state.y === 'pct' ? 100 : percentile(runs.flatMap(r => r.points.map(p => p.watts ?? 0)), 0.98);
  const yMax = state.y === 'pct' ? 100 : Math.max(5, yMaxRaw);  // value (depth) max

  for (const run of runs) {
    let pos = [], col = [], pts = [], curDay = null;
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
      const yv = state.y === 'pct' ? p.pct : p.watts;
      if (yv == null || !Number.isFinite(yv)) continue;         // skip null/NaN -> no bad vertices
      const d = dayOfT(p.t);
      if (curDay !== null && d !== curDay) flush();             // split at midnight: no cross-day diagonal
      curDay = d;
      pos.push(xFromTod(todOf(p.t)), yFromVal(yv, yMax), zFromDay(d, maxDay));  // X=시각, Y=잔량, Z=날짜(점별)
      const c = numeric
        ? ramp(cMax > cMin && p[state.color] != null ? (p[state.color] - cMin) / (cMax - cMin) : 0.5)
        : stateColor(p);
      col.push(c.r, c.g, c.b);
      pts.push(p);
    }
    flush();
  }
  return { yMax, maxDay, cMin, cMax };
}

// ---- rebuild everything for current state -------------------------------
const COLOR_META = { state: { label: '상태', unit: '' }, tempC: { label: '온도', unit: '°C' }, loadPct: { label: 'CPU 부하(load avg)', unit: '%' }, watts: { label: '전력', unit: 'W' } };
const GRAD_NUM = 'linear-gradient(90deg, hsl(240,85%,55%), hsl(180,85%,55%), hsl(120,85%,55%), hsl(60,85%,55%), hsl(0,85%,55%))';
const GRAD_STATE = 'linear-gradient(90deg, hsl(7,85%,55%) 0 33%, hsl(198,45%,50%) 50%, hsl(119,80%,50%) 66% 100%)';

function rebuild() {
  const r = state.report;
  document.getElementById('empty').hidden = !(r && (!r.runs || r.runs.length === 0));
  if (!r) return;
  const { yMax, maxDay, cMin, cMax } = buildLines(r);
  buildAxes(yMax, state.y === 'pct' ? '배터리 %' : '전력 W', maxDay, r.firstT);

  const cm = COLOR_META[state.color];
  document.getElementById('legLbl').textContent = cm.label;
  const bar = document.querySelector('#legend .bar');
  if (state.color === 'state') {
    document.getElementById('legMin').textContent = '🔋방전';
    document.getElementById('legMax').textContent = '충전🔌';
    bar.style.background = GRAD_STATE;
  } else {
    document.getElementById('legMin').textContent = cMin != null ? `${cMin.toFixed(0)}${cm.unit}` : '';
    document.getElementById('legMax').textContent = cMax != null ? `${cMax.toFixed(0)}${cm.unit}` : '';
    bar.style.background = GRAD_NUM;
  }
  updateHud(r);
}

const avgRate = bs => { const v = (bs || []).filter(b => b.pctPerMin); return v.length ? v.reduce((a, b) => a + b.pctPerMin, 0) / v.length : null; };

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
    rows.push(['현재', `${L.pct}% · ${L.watts}W ${L.charging ? '⚡' : L.ac ? '🔌' : '🔋'}`]);
    rows.push(['배터리 건강도', `${L.healthPct}%`]);
    rows.push(['사이클', `${L.cycles}회`]);
    rows.push(['만충 용량', `${L.rawMax} / ${L.design} mAh`]);
  }
  rows.push(['기록 기간', `${r.spanDays}일 · ${r.sessions.length}방전세션`]);
  rows.push(['샘플 수', `${r.sampleCount.toLocaleString()}개`]);
  stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  renderRates();  // rigorous per-band discharge-rate panel (lib/bucketRates.js, /api/rates)
  if (typeof renderInsight === 'function') renderInsight();   // E 카드 레이아웃 값 갱신
}

// ---- per-band panel: metric (rate %/min ↔ aging Wh/%), period, version/level ----
const RATE_VERS = [['v4a_pooled', 'V4a'], ['v0_rawMean', 'V0'], ['v1_fullOnly', 'V1'], ['v4c_subbin', 'V4c'], ['v5_ols', 'V5']];
const PERIODS = [['day', '일'], ['week', '주'], ['month', '월']];
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const METRICS = {
  rate:  { label: '속도',     unit: '%/min', pos: false, hint: '음수=방전. 부하+노화 섞인 체감속도' },
  wh:    { label: '노화Wh/%', unit: 'Wh/%',  pos: true,  hint: '낮을수록 노화(부하와 무관)' },
  watts: { label: '전력',     unit: 'W',     pos: true,  hint: '방전 중 평균 소비전력 = 순수 부하' },
  temp:  { label: '온도',     unit: '°C',    pos: true,  hint: '방전 중 평균 온도 = 발열/스트레스' },
};
const M = () => METRICS[state.metric] || METRICS.rate;
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
  if (!rt || !rt.byBand) { el.innerHTML = '<h2>구간별 방전 속도</h2><div class="note">불러오는 중…</div>'; return; }
  const vals = rt.byBand.map(bandVal).filter(v => v != null).map(Math.abs);
  const maxV = vals.length ? Math.max(...vals) : 0.001;
  const metBtns = [['rate', '속도'], ['wh', '노화Wh/%'], ['watts', '전력W'], ['temp', '온도°C']].map(([k, l]) => `<button data-rm="${k}" class="${k === state.metric ? 'on' : ''}">${l}</button>`).join('');
  const perBtns = PERIODS.map(([k, l]) => `<button data-rp="${k}" class="${k === state.period ? 'on' : ''}">${l}</button>`).join('');
  const verBtns = RATE_VERS.map(([k, lbl]) => `<button data-rv="${k}" class="${k === state.rateVersion ? 'on' : ''}">${lbl}</button>`).join('');
  const lvlBtns = [['pct', '정수%'], ['rawcap', 'mAh정밀']].map(([k, l]) => `<button data-rl="${k}" class="${k === state.rateLevel ? 'on' : ''}">${l}</button>`).join('');
  const body = rt.byBand.map(b => {
    const v = bandVal(b), sel = b.band === state.selectedBand ? ' class="sel"' : '';
    if (v == null) return `<tr data-band="${b.band}"${sel}><td>${b.label}</td><td class="rt">–</td><td></td></tr>`;
    const w = Math.round(Math.abs(v) / maxV * 44);
    const col = `hsl(${Math.round((1 - Math.abs(v) / maxV) * 120)},80%,55%)`;
    return `<tr data-band="${b.band}"${sel}><td>${b.label}</td><td class="rt">${v.toFixed(3)}</td><td><span class="spd" style="width:${w}px;background:${col}"></span></td></tr>`;
  }).join('');
  const infoTip = isWh()
    ? `<b>Wh/% = "1%가 담고 있는 실제 에너지의 크기"</b><br>≈ 만충용량 ÷ 100. 측정 전력을 시간 적분한 소비 에너지 ÷ 그동안 빠진 %. 부하와 무관해서 <b>낮을수록 배터리 노화</b>.`
    : state.metric === 'watts'
    ? `<b>전력(W) = 방전 중 평균 소비전력</b><br>순수 <b>부하</b> 지표. 속도가 빨라졌는데 W도 올랐다면 노화가 아니라 부하 때문.`
    : state.metric === 'temp'
    ? `<b>온도(°C) = 방전 중 평균 배터리 온도</b><br>발열/스트레스 지표. 높은 온도가 지속되면 노화를 가속.`
    : `<b>%/min = 분당 떨어지는 배터리 %</b><br>음수 = 방전. 부하 + 노화가 섞인 "체감 속도".`;
  const infoBadge = `<span class="info">i<span class="ftip">${infoTip}</span></span>`;
  el.innerHTML =
    `<h2>구간별 ${isRate() ? '방전 속도' : M().label} <small>${metricUnit()} · ${M().hint}</small>${infoBadge}</h2>` +
    `<div class="rseg" data-rgroup="rm">${metBtns}</div>` +
    `<div class="rseg" data-rgroup="rp"><span class="rlbl">기간</span>${perBtns}</div>` +
    (isRate() ? `<div class="rseg" data-rgroup="rv">${verBtns}</div>` : '') +
    `<div class="rseg" data-rgroup="rl"><span class="rlbl">레벨</span>${lvlBtns}</div>` +
    `<table><tr><th>구간</th><th>${isRate() ? '속도' : metricUnit()}</th><th></th></tr>${body}</table>` +
    `<div class="note">${periodLabel()}별 중앙값 · ${isRate() ? (state.rateVersion === 'v4a_pooled' ? 'V4a' : state.rateVersion.split('_')[0].toUpperCase()) : M().label} · ${rt.spans} spans · 행 클릭→추세</div>`;
  renderTrend();
}

// ---- trend over time: single/all bands · 2D line · heatmap · 3D · metric/period/delta ----
const bandColor = band => `hsl(${Math.round((100 - band) / 10 * 32)},70%,56%)`;
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
  const series = trendSeries();
  const view = state.trendAll ? state.trendView : 'line';
  const ctrls = `<span class="tbtns">` +
    `<button data-tall class="${state.trendAll ? 'on' : ''}">전체구간</button>` +
    (state.trendAll ? Object.keys(VIEWS).map(v => `<button data-tview="${v}" class="${view === v ? 'on' : ''}">${VIEWS[v]}</button>`).join('') : '') +
    (view === '3d' ? Object.keys(GEOMS).map(g => `<button data-tgeom="${g}" class="${state.trendGeom === g ? 'on' : ''}">${GEOMS[g]}</button>`).join('') : '') +
    ((view !== 'heat' && (!posMetric() || state.delta)) ? `<span class="zg">0:${(view === '3d' ? [['off', '끔'], ['line', '선'], ['plane', '면'], ['both', '선+면']] : [['off', '끔'], ['line', '선']]).map(([m, l]) => `<button data-tzero="${m}" class="${state.zeroMode === m ? 'on' : ''}">${l}</button>`).join('')}</span>` : '') +
    `<button data-tdelta class="${state.delta ? 'on' : ''}">델타</button>` +
    `<button data-tbig class="${state.trendBig ? 'on' : ''}">${state.trendBig ? '축소' : '확대'}</button></span>`;
  const what = isRate() ? '방전속도' : M().label;
  const sub = `${metricUnit()}${state.delta ? ' · Δ기준대비' : ''} · ${VIEWS[view]}`;
  const tg = (g, gl, label) => `<span class="tickg">${label}<span class="seg2">${[1, 2, 3].map(v => `<button data-tick="${g}" data-v="${v}" class="${state[gl] === v ? 'on' : ''}">${['적', '중', '촘'][v - 1]}</button>`).join('')}</span></span>`;
  const tickRow = `<div class="trow">눈금 ${tg('date', 'tickDate', '날짜')} ${tg('band', 'tickBand', '잔량')}${view !== 'heat' ? ' ' + tg('val', 'tickVal', '속도') : ''}</div>`;
  const title = state.trendAll
    ? `<h2>구간별 ${what} 추세 <small>${sub}</small>${ctrls}</h2>`
    : `<h2>${series[0]?.label ?? ''} ${what} 추세 <small>${metricUnit()}${state.delta ? ' · Δ' : ''}${series[0] ? ' · ' + series[0].pts.length + periodLabel() : ''}</small>${ctrls}</h2>`;
  const head = title + tickRow;
  if (!el.querySelector('#trend-head')) el.innerHTML = `<div id="trend-head"></div><div id="trend-body"></div>`;
  el.querySelector('#trend-head').innerHTML = head;
  const body = el.querySelector('#trend-body');

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
  for (let i = 0; i <= ny; i++) {
    const yy = ymin + (ymax - ymin) * i / ny, py = Y(yy);
    grid += `<line x1="${pL}" y1="${py.toFixed(1)}" x2="${W - pR}" y2="${py.toFixed(1)}" stroke="${Math.abs(yy) < 1e-9 ? TH().svgGrid0 : TH().svgGrid}"/>`;
    ylab += `<text x="${pL - 6}" y="${(py + 3).toFixed(1)}" text-anchor="end" fill="${TH().svgText}" font-size="${fs}">${yy.toFixed(3)}</text>`;
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
      footer = `<div class="slope">추세: 30일당 <b>${per30 >= 0 ? '+' : ''}${per30.toFixed(4)}</b> ${metricUnit()} ${dir}</div>`;
    } else {                                                // too little data → don't extrapolate a misleading 30-day slope
      footer = `<div class="slope note">추세선은 데이터가 더 쌓이면 표시돼요 (현재 ${n}${periodLabel()}치 · 최소 4${periodLabel()} 필요)</div>`;
    }
  }
  if (state.trendAll) legend = `<div class="tlegend">` + series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('') + `</div>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">` + grid + xgrid +
    `<line x1="${pL}" y1="${pT}" x2="${pL}" y2="${H - pB}" stroke="${TH().svgAxis}"/>` +
    `<line x1="${pL}" y1="${H - pB}" x2="${W - pR}" y2="${H - pB}" stroke="${TH().svgAxis}"/>` +
    ylab + xlab + paths + `</svg>` + footer + legend;
}

// ---- heatmap: period(date) × band grid, color=metric, opacity=coverage, click=date slice ----
function heatColor(v, lo, hi, diverging) {
  if (v == null) return TH().miss;
  if (diverging) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1, t = Math.max(-1, Math.min(1, v / m)); return t < 0 ? `hsl(8,75%,${(42 - t * 16).toFixed(0)}%)` : `hsl(205,70%,${(42 + t * 16).toFixed(0)}%)`; }
  const t = Math.max(0, Math.min(1, hi === lo ? 0.5 : (v - lo) / (hi - lo))); return `hsl(${Math.round(t * 120)},75%,52%)`;
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
    cells += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(2)}" height="${chh.toFixed(2)}" fill="${heatColor(v, lo, hi, state.delta)}" fill-opacity="${alpha.toFixed(2)}" data-period="${p.key}"${sel}><title>${p.key} (${b - 10},${b}]\n${metricUnit()}: ${v.toFixed(3)}${state.delta ? ' Δ' : ''}\n관측 ${c.minutes}분 · 평균 ${c.avgW}W</title></rect>`;
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
  const legend = `<div class="hlegend"><span>${lo.toFixed(3)}</span><i class="hbar${state.delta ? ' div' : ''}"></i><span>${hi.toFixed(3)} ${metricUnit()}${state.delta ? ' Δ' : ''}</span><span class="hcov">불투명도=관측분량 · 셀 클릭=날짜 선택 · 청록선=건강도</span></div>`;
  let inset = '';
  if (state.selectedPeriod) {
    const rows = bands.map(b => ({ b, v: valOf(byPB.get(state.selectedPeriod + '|' + b)) }));
    const mv = Math.max(...rows.map(r => r.v != null ? Math.abs(r.v) : 0), 0.001);
    inset = `<div class="hinset"><b>${state.selectedPeriod}</b> 날짜 단면 · 구간별 ${metricUnit()}<table>` +
      rows.map(r => r.v == null ? `<tr><td>${r.b - 10}-${r.b}</td><td class="rt">–</td><td></td></tr>` : `<tr><td>${r.b - 10}-${r.b}</td><td class="rt">${r.v.toFixed(3)}</td><td><span class="spd" style="width:${Math.round(Math.abs(r.v) / mv * 40)}px;background:${heatColor(r.v, lo, hi, state.delta)}"></span></td></tr>`).join('') +
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
  const nv = nVal(); for (let i = 0; i <= nv; i++) { const rr = rmin + (rmax - rmin) * i / nv, l = makeLabel(rr.toFixed(2), { size: 22, color: TH().tickC }); l.position.set(x0 - 3.2, Y(rr), zf); g.add(l); }
  const L = (t, o, x, y, z) => { const l = makeLabel(t, o); l.position.set(x, y, z); return l; };  // (Sprite.position is read-only — must .set, not reassign)
  g.add(L('날짜 →', { color: TH().titleC }, 0, -3.4, zf));
  g.add(L((state.delta ? 'Δ ' : '') + metricUnit(), { color: TH().titleC }, x0 - 5.5, Yh + 1.5, zf));
  g.add(L('구간(잔량) →', { color: TH().titleC }, x0 - 2, -1.6, zb - 5));
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
    const res = await fetch(`/api/rates?source=${state.source}&level=${state.rateLevel}&period=${state.period}`);
    state.rates = await res.json();
  } catch { state.rates = null; }
  if (state.rates && state.rates.byBand && !state.rates.byBand.some(b => b.band === state.selectedBand)) {
    const best = [...state.rates.byBand].sort((a, b) => b.nDays - a.nDays)[0];   // default = band with most days
    state.selectedBand = best ? best.band : null;
  }
  renderRates();
}

// ---- hover (raycast lines) ---------------------------------------------
const ray = new THREE.Raycaster(); ray.params.Line.threshold = 0.6;
const mouse = new THREE.Vector2();
const tip = document.getElementById('tip');
let hovered = null;
const HI = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });

addEventListener('pointermove', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(lines, false)[0];
  if (hit) {
    const line = hit.object;
    if (hovered !== line) {
      if (hovered) hovered.material = hovered.userData.base;
      hovered = line; line.userData.base = line.material; line.material = HI;
    }
    const pts = line.userData.pts;
    // hit.index is the segment START vertex; pick whichever endpoint is nearer the hit point
    const i = clamp(hit.index ?? 0, 0, pts.length - 1), j = Math.min(i + 1, pts.length - 1);
    const pos = line.geometry.attributes.position;
    const lp = line.worldToLocal(hit.point.clone());            // compare in the line's own space
    const di = lp.distanceToSquared(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    const dj = lp.distanceToSquared(new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j)));
    showTip(line.userData.dayIndex, pts[dj < di ? j : i], e.clientX, e.clientY);
  } else {
    if (hovered) { hovered.material = hovered.userData.base; hovered = null; }
    tip.hidden = true;
  }
});

function showTip(dayIndex, p, x, y) {
  const d = new Date(p.t * 1000);
  const st = p.charging ? '⚡ 충전 중' : p.ac ? '🔌 만충/유휴' : '🔋 방전 중';
  tip.innerHTML = `
    <h3>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${dayIndex}일차</h3>
    <div><span class="big">${p.pct}%</span> &nbsp; ${st}</div>
    <table>
      <tr><td class="k">전력</td><td>${p.watts ?? '?'} W</td></tr>
      <tr><td class="k">온도</td><td>${p.tempC ?? '?'}°C</td></tr>
      <tr><td class="k">CPU 부하</td><td>${p.loadPct ?? '?'}%</td></tr>
    </table>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 16, innerWidth - r.width - 8) + 'px';
  tip.style.top = Math.min(y + 16, innerHeight - r.height - 8) + 'px';
}

// ---- data ---------------------------------------------------------------
async function load() {
  const res = await fetch(`/api/report?source=${state.source}`);
  state.report = await res.json();
  rebuild();
  loadRates();                 // per-band rate panel (concurrent)
}

// ---- UI wiring ----------------------------------------------------------
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const group = seg.dataset.group, val = b.dataset.val;
    if (group === 'source') { state.source = val; load(); }
    else if (group === 'ui') { applyUI(val); }
    else if (group === 'layout') { applyLayout(val); }
    else { state[group] = val; rebuild(); }
  });
});
document.getElementById('spin').addEventListener('change', e => { controls.autoRotate = e.target.checked; controls.autoRotateSpeed = 0.6; });
document.getElementById('reset').addEventListener('click', () => { camera.position.copy(HOME); controls.target.copy(LOOK); });

// theme (dark / light) — recolors WebGL scenes + SVG charts + CSS panels, persisted
function applyTheme() {
  document.documentElement.classList.toggle('light', state.theme === 'light');
  try { localStorage.setItem('battTheme', state.theme); } catch { /* ignore */ }
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
    if (btn.dataset.rm) { state.metric = btn.dataset.rm; renderRates(); }
    else if (btn.dataset.rp) { state.period = btn.dataset.rp; state.selectedPeriod = null; loadRates(); }
    else if (btn.dataset.rv) { state.rateVersion = btn.dataset.rv; renderRates(); }
    else if (btn.dataset.rl) { state.rateLevel = btn.dataset.rl; loadRates(); }
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
  else if (b.hasAttribute('data-tbig')) state.trendBig = !state.trendBig;
  renderTrend();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// keep labels readable (face camera handled by Sprite; nothing extra needed)
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
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

load();
