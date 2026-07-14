// Live battery popover (Stats-parity). Loaded in a small Tauri window from the node server,
// so /api/live & /api/procs are same-origin. Three selectable layouts: list · cards · gauge.
const $ = id => document.getElementById(id);
// escape ALL server-derived strings — process names / serial / adapter name are attacker-influenceable
// and CSP is disabled in the popover window, so unescaped innerHTML would execute.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qs = k => { try { return new URLSearchParams(location.search).get(k); } catch { return null; } };
const ls = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// display prefs (popover-only) live in localStorage; menu-bar/alert prefs (cfg) live server-side (/api/config)
let pv = qs('pv') || ls('battPV', 'list');
let theme = qs('theme') || ls('battTheme', 'light');   // light(기본) | dark | system
let unit = ls('battUnit', 'system');                  // system | c | f
let timeFmt = ls('battTimeFmt', 'long');              // short(1:20) | long(1시간 20분)
let procN = +ls('battProcN', '6');                    // top-processes count · 0 = hide
let sparkMode = qs('sm') || ls('battSparkMode', 'pct');   // mini-chart metric: pct | w | 3d
let sparkH = +(qs('sh') ?? ls('battSparkH', '6'));        // mini-chart window hours: 6 | 24 | 0(all)
let three = null, t3d = null, t3dLoading = false;     // lazy Three.js + persistent live-3D scene (survives DOM rebuilds)
let cfg = { colorize: true, low_pct: 20, high_pct: 80, widget: 'icon', glyph_xl: false, shortcut: true, text_pct: true, text_time: false, text_w_sys: true, text_w_bat: false, w7_src: 'sys', digit_deco: true, text_temp: false, text_adp: false };
let live = null, procs = [], detail = {}, spark = [], lastLiveAt = 0, settingsOpen = qs('settings') === '1', moreOpen = false;
// menu-bar preview (settings panel): glyph dumps from the Rust tray renderer via /api/tray-preview
let pvSim = 'cur', pvData = null, pvTimer = 0, pvMeasure = null;

// ── i18n (popover) — shares localStorage 'battLang' + /locales/<lang>.json with the viewer ──
// (popover.js is a classic script, so this is a small self-contained copy of web/i18n.js's logic.)
let I18N = {}, I18N_PAT = [], i18nApplying = false;
let langList = [['ko', '한국어'], ['en', 'English']];
const battLang = () => ls('battLang', 'ko');
function applyI18nPop(root) {
  if (battLang() === 'ko' || !root || i18nApplying) return;
  const scopes = root.matches && root.matches('[data-i18n]') ? [root] : (root.querySelectorAll ? [...root.querySelectorAll('[data-i18n]')] : []);
  if (!scopes.length) return;
  i18nApplying = true;
  try {
    for (const s of scopes) {
      for (const el of [s, ...s.querySelectorAll('[title]')]) { const o = el.getAttribute && el.getAttribute('title'); if (o && I18N[o.trim()]) el.setAttribute('title', I18N[o.trim()]); }
      const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT); const ns = []; let n; while ((n = w.nextNode())) ns.push(n);
      for (const tn of ns) {
        const raw = tn.nodeValue, k = raw.trim(); if (!k) continue;
        if (I18N[k]) { const nv = raw.replace(k, I18N[k]); if (nv !== raw) tn.nodeValue = nv; continue; }   // change-guard: an identical write still fires the observer → infinite loop (e.g. "3D"→"3D")
        if (I18N_PAT.length && /[가-힣]/.test(raw)) { let v = raw; for (const [re, rep] of I18N_PAT) v = v.replace(re, rep); if (v !== raw) tn.nodeValue = v; }
      }
    }
  } finally { i18nApplying = false; }
  // translated text can change the content height (English often wraps differently) → re-measure so the
  // Rust side resizes the window to fit. fitWindow self-defers to the next frame and coalesces, so calling
  // it here (in addition to render's call) collapses to a single post-translation measurement — no flicker.
  if (typeof fitWindow === 'function') fitWindow();
}
async function initI18nPop() {
  try {
    const arr = await (await fetch('/locales/index.json')).json();
    if (Array.isArray(arr) && arr.length) {
      langList = arr.map(x => [x.code, x.name]);
      if (settingsOpen) render();
    }
  } catch (e) { /* ignore */ }

  const l = battLang(); if (!l || l === 'ko') return;
  try { I18N = await (await fetch(`/locales/${l}.json`)).json(); } catch { I18N = {}; }
  try { I18N_PAT = (I18N._patterns || []).map(([re, rep]) => [new RegExp(re, 'gu'), rep]); } catch { I18N_PAT = []; }
  const obs = new MutationObserver(muts => { if (i18nApplying) return; const seen = new Set(); for (const m of muts) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; const sc = el && el.closest && el.closest('[data-i18n]'); if (sc && !seen.has(sc)) { seen.add(sc); applyI18nPop(sc); } } });
  document.querySelectorAll('[data-i18n]').forEach(s => obs.observe(s, { childList: true, subtree: true, characterData: true }));
  applyI18nPop(document);
}
const setLangPop = l => { save('battLang', l); location.reload(); };

const resolveTheme = () => theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
// "system" temperature unit → °F only in the handful of Fahrenheit locales, else °C
const resolveUnit = () => unit === 'system' ? (/^en-(US|LR|MM|BS|BZ|KY|PW|FM|MH)\b/i.test(navigator.language || '') ? 'f' : 'c') : unit;
const fmtTemp = c => c == null ? '–' : resolveUnit() === 'f' ? `${(c * 9 / 5 + 32).toFixed(1)} °F` : `${c.toFixed(1)} °C`;
const fmtTime = min => {
  if (min == null) return '–';
  const h = Math.floor(min / 60), m = min % 60;
  if (timeFmt === 'short') return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}분`;
  return h ? `${h}시간 ${m}분` : `${m}분`;
};
// physical rail relationship (approx — SMC sensors don't perfectly sum): shown under 전원
const powerLegend = s => s.ac ? '어댑터 = 시스템 소비 + 배터리 충전' : '시스템 소비 = 배터리 방전';
// clock time the countdown lands on (empty when discharging / full when charging)
const etaClock = min => {
  const d = new Date(Date.now() + min * 60000);
  let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h < 12 ? '오전' : '오후'; h = h % 12 || 12;
  return `${ap} ${h}:${m}`;
};
// "5시간 40분 · 오후 9:45" — remaining duration + the clock time it ends
const timeVal = s => s.timeRemain == null ? '–' : `${fmtTime(s.timeRemain)} · ${etaClock(s.timeRemain)}`;

// The Tauri webview IPC isn't reliable for this external-localhost window, so report the content
// height (and hide requests) to the tray app through the node bridge, which resizes/hides the
// window from Rust. This makes the window fit the content exactly → no scrollbar, no square margin.
let lastWinH = 0, fitPending = false;
// Coalesce all fitWindow() calls in a frame into ONE measurement on the next animation frame. This
// matters because i18n translates text asynchronously (MutationObserver microtask) AFTER a synchronous
// render() — so a synchronous measure would read the pre-translation (Korean) height, and a second
// post-translation measure would read a different (English) height → the window would flip-flop between
// the two every render (visible flicker) and flood /api/height. rAF runs after microtasks, so the single
// deferred measure always reads the final, translated layout. Height-change guard avoids redundant posts.
function fitWindow() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    if (document.hidden) return;   // a hidden webview doesn't lay out reliably → measure only when shown
    const h = Math.min(Math.ceil(document.body.getBoundingClientRect().height), Math.round((screen.availHeight || 900) * 0.95));
    if (Math.abs(h - lastWinH) < 2) return;   // only post when the content height actually changes
    lastWinH = h;
    fetch('/api/height', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ h }) }).catch(() => {});
  });
}
// when the popover is shown, re-pull fresh data and re-measure at the true (visible) layout height
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stop3D(); return; }   // pause the 3D animation loop while hidden (saves CPU)
  lastWinH = 0;
  pull(); pullProcs(); pullDetail(); pullSpark(); pullMeasure();   // measure state can change while hidden (server resume/other window)
  requestAnimationFrame(fitWindow);
});
const hideWindow = () => { fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'hide' }) }).catch(() => {}); };
const stateOf = s => s.charging ? '충전 중' : s.full ? '완충' : s.ac ? '외부 전원(유휴)' : '배터리 사용';   // "AC" 금지 — 파워뱅크도 외부 전원
const stateIcon = s => s.charging ? '⚡' : s.ac ? '🔌' : '🔋';
const ago = ms => { const t = (Date.now() - ms) / 1000; return t < 3 ? '방금' : `${Math.round(t)}초 전`; };
const barColor = pct => pct <= 20 ? '#e5484d' : pct <= 40 ? '#e8850c' : 'var(--accent)';
// the whole popover tints to this: teal when healthy/charging, amber low, red critical
const stateColor = (s, pct) => s.charging ? 'var(--accent)' : barColor(pct);   // live values are marked with a pulsing dot (.ld) — no "LIVE" word, so every rail is consistent

async function pull() {
  try {
    const r = await fetch('/api/live', { cache: 'no-store' });
    if (r.ok) { live = await r.json(); lastLiveAt = Date.now(); }
  } catch { /* keep last */ }
  if (!settingsOpen) render();   // don't clobber the open settings panel (would reset dropdowns)
}
async function pullProcs() {
  if (procN <= 0) { procs = []; if (!settingsOpen) render(); return; }   // disabled → don't even spawn `top`
  try { const r = await fetch(`/api/procs?n=${procN}`, { cache: 'no-store' }); if (r.ok) procs = await r.json(); } catch { /* keep */ }
  if (!settingsOpen) render();
}
async function pullConfig() {
  try { const r = await fetch('/api/config', { cache: 'no-store' }); if (r.ok) cfg = { ...cfg, ...(await r.json()) }; } catch { /* keep defaults */ }
  if (settingsOpen) render();
}
async function pullDetail() {
  try { const r = await fetch('/api/detail', { cache: 'no-store' }); if (r.ok) detail = await r.json(); } catch { /* keep */ }
  if (!settingsOpen) render();
}
async function pullSpark() {
  try { const r = await fetch(`/api/spark?h=${sparkH}`, { cache: 'no-store' }); if (r.ok) spark = await r.json(); } catch { /* keep */ }
  if (settingsOpen) return;
  if (sparkMode === '3d' && t3d && t3d.active) build3DGeom();   // live 3D up: update geometry in place, don't rebuild the canvas
  else { renderSpark(); fitWindow(); }
}

function batterySVG(pct, s) {
  const w = 46, fill = Math.max(4, pct / 100 * (w - 7));
  // charging → bolt · plugged-but-not-charging → plug · on battery → nothing (like Stats)
  const glyph = s.charging
    ? `<path d="M23.6 6.3 L16.4 15.8 H21 L19.4 21.7 L27.2 11.7 H22.4 L24.6 6.3 Z" fill="var(--chg)" stroke="var(--onfg)" stroke-width=".5" stroke-linejoin="round"/>`
    : s.ac
      ? `<g fill="var(--chg)" stroke="var(--onfg)" stroke-width=".4"><rect x="18.5" y="6" width="1.7" height="3.4" rx=".8"/><rect x="23.8" y="6" width="1.7" height="3.4" rx=".8"/><rect x="16.5" y="9" width="11" height="6.2" rx="1.6"/><rect x="20.4" y="15.2" width="3.2" height="4" rx="1"/></g>`
      : '';
  return `<svg viewBox="0 0 60 28" width="58" height="27" aria-hidden="true">
    <defs><linearGradient id="bf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--state)" stop-opacity="1"/>
      <stop offset="1" stop-color="var(--state)" stop-opacity=".8"/></linearGradient></defs>
    <rect x="1" y="4" width="${w}" height="20" rx="5.5" fill="none" stroke="var(--fg)" stroke-width="1.8" opacity=".5"/>
    <rect x="${w + 2.5}" y="10" width="4" height="8" rx="2" fill="var(--fg)" opacity=".5"/>
    <rect x="3.5" y="6.5" width="${fill}" height="15" rx="3.5" fill="url(#bf)"/>
    ${glyph}
  </svg>`;
}

// 전원 section — the full picture across all three rails, each with W · V · A.
//   시스템 = SMC PSTR (total live draw) · 어댑터 = SMC PDTR + adapter voltage (A computed W/V)
//   배터리 = signed battery power/voltage/current (+ charging · 0 idle · − discharging)
function rowsPower(s) {
  const r = [];
  if (s.systemW != null) r.push(['시스템', `${s.systemW.toFixed(1)} W <i class="ld"></i>`]);
  if (s.ac) {
    // 실측 우선: SMC VD0R(전압)·ID0R(전류) 센서값. SMC 브리지가 없을 때만 공칭 전압 + W/V 파생 전류로 폴백.
    const w = s.adapterW;
    const v = s.dcInV ?? detail.adapterVoltage;
    const a = s.dcInA != null ? Math.round(s.dcInA * 1000)
      : (w != null && v) ? Math.round(w / v * 1000) : null;
    const p = [w != null ? `${w.toFixed(1)} W` : null, v != null ? `${v.toFixed(2)} V` : null, a != null ? `${a} mA` : null].filter(Boolean);
    if (p.length) r.push(['어댑터', p.join(' · ') + (w != null ? ' <i class="ld"></i>' : '')]);
  }
  const bp = s.powerW;
  const bw = bp == null ? null : Math.abs(bp) < 0.05 ? '0 W' : `${bp > 0 ? '+' : '−'}${Math.abs(bp).toFixed(2)} W`;
  const b = [bw, s.voltage != null ? `${s.voltage.toFixed(2)} V` : null, s.amperage != null ? `${s.amperage} mA` : null].filter(Boolean);
  r.push(['배터리', (b.length ? b.join(' · ') : '–') + (s.batLive ? ' <i class="ld"></i>' : '')]);
  return r;
}
// 전력 비교 — 모든 측정 방식을 각각 표기해 눈으로 비교 (배터리 3방식 · 어댑터 2방식). 부호: +충전 −방전.
function powerCompareHTML(s) {
  const V = s.voltage;
  const wva = (w, v, a, signed) => w == null ? '–' :
    [(signed ? `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(2)}` : w.toFixed(2)) + ' W',
     v != null ? `${v.toFixed(2)} V` : null, a != null ? `${Math.round(a)} mA` : null].filter(Boolean).join(' · ');
  const charging = s.powerW != null ? s.powerW > 0.05 : !!s.charging;
  const bat = [
    ['어댑터−시스템 (수지)', wva(s.powerW, V, s.amperage, true)],
    ['ioreg V×I (셀 실측)', wva(s.ioregW, V, s.ioregA, true)],
    ['PPBR (방전 전용)', s.ppbrW == null ? '–' : charging ? '충전 중 ~0 (방전 시만)' : wva(-s.ppbrW, V, V ? -s.ppbrW / V * 1000 : null, true)],
  ];
  let html = `<div class="sec">배터리 전력 (방식별)</div>` + bat.map(([k, v]) => `<div class="cmp"><span>${k}</span><b>${v}</b></div>`).join('');
  if (s.ac) {
    const nw = detail.adapterWatts, nv = detail.adapterVoltage;
    const adp = [
      ['ioreg 공칭/정격', wva(nw, nv, (nw && nv) ? nw / nv * 1000 : null, false)],
      ['SMC 실측 (PDTR·VD0R·ID0R)', wva(s.adapterW, s.dcInV, s.dcInA != null ? s.dcInA * 1000 : null, false)],
    ];
    html += `<div class="sec">어댑터 전력 (방식별)</div>` + adp.map(([k, v]) => `<div class="cmp"><span>${k}</span><b>${v}</b></div>`).join('');
  }
  return html;
}
// 상태 rows shared by list/gauge: remaining time + live temperature.
function statusRows(s) {
  return [
    [s.charging ? '완충까지' : '남은 시간', timeVal(s)],
    ['배터리 온도', fmtTemp(s.tempC) + (s.smc ? ' <i class="ld"></i>' : '')],
  ];
}
function rowsHealth(s) {
  const rows = [
    ['최대 용량(건강)', s.healthPct != null ? `${Math.min(100, Math.round(s.healthPct))}%` : '–'],
  ];
  if (detail.condition) rows.push(['상태(컨디션)', esc(detail.condition)]);   // 건강 지표 옆에 배치
  rows.push(
    ['사이클', s.cycles != null ? `${s.cycles}회` : '–'],
    ['만충 / 설계', (s.rawMax != null && s.design != null) ? `${s.rawMax} / ${s.design} mAh` : '–'],
  );
  return rows;
}
const kvHTML = rows => rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('');

function detailHTML(s) {
  // 컨디션은 '배터리' 건강 섹션으로 이동 · 설계 사이클 한도/시리얼은 뷰어로 이동(팝오버에서 제거)
  const rows = [];
  if (detail.manufactureDate) rows.push(['제조일', `${esc(detail.manufactureDate)}${detail.ageDays ? ` · ${Math.floor(detail.ageDays / 365)}년 ${Math.round((detail.ageDays % 365) / 30)}개월` : ''}`]);
  if (s.ac && detail.adapterWatts) rows.push(['전원 어댑터', `${+detail.adapterWatts} W${detail.adapterName ? ' · ' + esc(detail.adapterName) : ''}`]);
  // 충전 기술 식별 (ioreg AdapterDetails.FamilyCode) — PD인지, 5V 저속인지, 계약과 제공 프로필까지
  const a = detail.adapter;
  if (s.ac && a) {
    const TECH = { 'usbc-pd': 'USB-C PD', 'usbc-5v': 'USB-C 5V', usb: 'USB(구형)', dedicated: '전용 어댑터', unknown: '미상' };
    const bits = [TECH[a.tech] || '미상'];
    if (a.voltage && a.current) bits.push(`계약 ${a.voltage}V×${a.current}A`);
    if (a.manufacturer) bits.push(esc(a.manufacturer));
    rows.push(['충전 기술', bits.join(' · ')]);
    if (a.hvcMenu && a.hvcMenu.length) {   // 충전기가 제공하는 PD 프로필 목록 (PD 충전기만 노출)
      rows.push(['제공 프로필', a.hvcMenu.map(p => `${p.v}V/${p.a}A`).join(' · ')]);
    }
  }
  if (detail.onHold) rows.push(['충전 상태', '🔵 최적화 충전(대기 중)']);
  return rows.length ? `<div class="sec">상세</div>${kvHTML(rows)}` : '';
}
// ── mini trend preview ─────────────────────────────────────────────────────────────
// Lives in its OWN persistent container (#sparkbox), NOT in #pop — because #pop is
// innerHTML-rebuilt every ~2s and that would destroy a live WebGL canvas. So the 3D
// renderer/canvas is created once and survives; renderSpark() only swaps the controls
// and the 2D/3D chart slot. 3D is a live scene: gentle auto-rotate + drag-to-rotate.
const spModeBtns = () => [['pct', '잔량'], ['w', '전력'], ['3d', '잔량 3D']].map(([m, l]) => `<button data-sm="${m}" class="${sparkMode === m ? 'on' : ''}">${l}</button>`).join('');
const spWinBtns = () => [[6, '6시간'], [24, '24시간'], [0, '전체']].map(([w, l]) => `<button data-sh="${w}" class="${sparkH === w ? 'on' : ''}">${l}</button>`).join('');

function spark2D(pts) {
  const W = 296, H = 44, pad = 3;
  const vs = pts.map(p => sparkMode === 'w' ? p.w : p.pct), ts = pts.map(p => p.t);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const tr = Math.max(1, t1 - t0), vr = Math.max(sparkMode === 'w' ? 0.5 : 1, vmax - vmin);
  const X = t => pad + (t - t0) / tr * (W - 2 * pad);
  const Y = v => pad + (1 - (v - vmin) / vr) * (H - 2 * pad);
  const line = pts.map(p => `${X(p.t).toFixed(1)},${Y(sparkMode === 'w' ? p.w : p.pct).toFixed(1)}`).join(' ');
  const area = `${X(t0).toFixed(1)},${H - pad} ${line} ${X(t1).toFixed(1)},${H - pad}`;
  return `<svg class="spark" data-report viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <defs><linearGradient id="sf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${sparkMode === 'pct' ? `<polygon points="${area}" fill="url(#sf)"/>` : ''}
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

function renderSpark() {
  const box = document.getElementById('sparkbox');
  if (!box) return;
  if (!live || live.error || settingsOpen) { stop3D(); box.innerHTML = ''; return; }
  if (!box.querySelector('#spkchart')) box.innerHTML = `<div id="spkctrl"></div><div id="spkchart"></div><div id="spkfoot"></div>`;
  box.querySelector('#spkctrl').innerHTML = `<div class="sec">최근 추세</div><div class="spbtns"><span class="spseg">${spModeBtns()}</span><span class="spseg">${spWinBtns()}</span></div>`;
  const chart = box.querySelector('#spkchart'), foot = box.querySelector('#spkfoot');
  const pts = (spark || []).filter(p => (sparkMode === 'w' ? p.w : p.pct) != null);
  if (pts.length < 3) { stop3D(); chart.innerHTML = `<div class="note spnote">기록 데이터가 쌓이면 표시돼요.</div>`; foot.innerHTML = ''; return; }
  const hrs = Math.max(1, Math.round((pts[pts.length - 1].t - pts[0].t) / 3600));
  let sub;
  if (sparkMode === 'w') { const vs = pts.map(p => p.w); sub = `${Math.min(...vs).toFixed(1)}–${Math.max(...vs).toFixed(1)} W`; }
  else if (sparkMode === '3d') sub = '잔량 3D · 드래그로 회전';
  else { const vs = pts.map(p => p.pct); sub = `${Math.min(...vs)}–${Math.max(...vs)}%`; }   // 창 내 잔량 범위(최저–최고). 순증감(%p)은 긴 창에선 무의미
  foot.innerHTML = `<div class="spmore"><span class="spsub">${hrs}시간 · ${sub}</span><span data-report>3D 분석 리포트 →</span></div>`;
  if (sparkMode === '3d') start3D(chart);
  else { stop3D(); chart.innerHTML = spark2D(pts); }
}

// live rotating 3D — one reused renderer/canvas that persists across popover DOM rebuilds
async function ensure3D() {
  if (t3d || t3dLoading) return;
  t3dLoading = true;
  try {
    if (!three) three = await import('/vendor/three.module.js');
    const T = three, W = 300, H = 172;
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W, H, false);
    const el = renderer.domElement; el.className = 'spark3d';
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(40, W / H, 0.1, 100);
    camera.position.set(2.9, 2.1, 3.6); camera.lookAt(0, 0.45, 0);
    scene.add(new T.AmbientLight(0xffffff, 1.0));
    const dl = new T.DirectionalLight(0xffffff, 0.65); dl.position.set(2, 5, 3); scene.add(dl);
    const group = new T.Group(); scene.add(group);
    t3d = { renderer, scene, camera, group, active: false, raf: 0, dragging: false, lastX: 0, spin: 0 };
    el.addEventListener('pointerdown', e => { t3d.dragging = true; t3d.lastX = e.clientX; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => { if (t3d.dragging) { t3d.spin += (e.clientX - t3d.lastX) * 0.01; t3d.lastX = e.clientX; } });
    const stopDrag = () => { t3d.dragging = false; };
    el.addEventListener('pointerup', stopDrag); el.addEventListener('pointercancel', stopDrag);
  } catch { t3d = null; }
  t3dLoading = false;
  renderSpark(); fitWindow();   // canvas just appeared → grow the window to fit it
}
function build3DGeom() {
  if (!t3d) return;
  const T = three, g = t3d.group;
  while (g.children.length) { const c = g.children.pop(); c.geometry?.dispose?.(); c.material?.dispose?.(); }
  const pts = (spark || []).filter(p => p.pct != null), ps = pts.map(p => p.pct), n = ps.length;
  if (n < 3) return;
  const pmin = Math.min(...ps), pmax = Math.max(...ps), pr = Math.max(1, pmax - pmin);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8fe84a';
  const col = new T.Color(accent), spanX = 3.4, yh = 1.4;
  const xAt = i => (i / (n - 1) - 0.5) * spanX, yAt = v => (v - pmin) / pr * yh + 0.02;
  const shape = new T.Shape(); shape.moveTo(xAt(0), 0);
  ps.forEach((v, i) => shape.lineTo(xAt(i), yAt(v)));
  shape.lineTo(xAt(n - 1), 0); shape.closePath();
  const geo = new T.ExtrudeGeometry(shape, { depth: 0.55, bevelEnabled: false }); geo.translate(0, 0, -0.28);
  g.add(new T.Mesh(geo, new T.MeshLambertMaterial({ color: col, transparent: true, opacity: 0.5 })));
  for (const z of [0.27, -0.27]) g.add(new T.Line(new T.BufferGeometry().setFromPoints(ps.map((v, i) => new T.Vector3(xAt(i), yAt(v), z))), new T.LineBasicMaterial({ color: col })));
  g.add(new T.GridHelper(spanX + 0.4, 10, 0x5a6472, 0x2b333f));
}
function start3D(chart) {
  if (!t3d) { chart.innerHTML = `<div class="note spnote">3D 로딩 중…</div>`; ensure3D(); return; }
  if (!chart.contains(t3d.renderer.domElement)) { chart.innerHTML = ''; chart.appendChild(t3d.renderer.domElement); }
  build3DGeom();
  if (!t3d.active) { t3d.active = true; loop3D(); }
}
function stop3D() { if (t3d && t3d.active) { t3d.active = false; if (t3d.raf) cancelAnimationFrame(t3d.raf); t3d.raf = 0; } }
function loop3D() {
  if (!t3d || !t3d.active) return;
  if (!t3d.dragging) t3d.spin += 0.004;            // gentle turntable auto-rotate
  t3d.group.rotation.y = t3d.spin;
  t3d.renderer.render(t3d.scene, t3d.camera);
  t3d.raf = requestAnimationFrame(loop3D);
}
// ── 전력량 측정 세션 ("전력 분석 세션") ─────────────────────────────────────
// 서버(/api/measure)가 SMC 2초 샘플을 적산 — 여기는 표시와 start/stop 버튼만.
// 배터리는 두 추정치를 동급 병기: 수지(어댑터−시스템 적분) vs 게이지(잔량 델타) — 차이의 원인은 단정하지 않는다.
let msr = { state: 'idle' }, msrNote = '', msrNoteT = 0;
async function pullMeasure() {
  try { const r = await fetch('/api/measure', { cache: 'no-store' }); if (r.ok) msr = await r.json(); } catch { /* keep */ }
}
// a rejected request must never look like "nothing happened" (the 409-swallowed bug): show WHY,
// then resync — the server state (e.g. a session resumed while this window was hidden) wins.
function msrSay(text) {
  msrNote = text;
  clearTimeout(msrNoteT);
  msrNoteT = setTimeout(() => { msrNote = ''; if (!settingsOpen) render(); }, 5000);
}
async function doMeasure(act) {
  try {
    const r = await fetch(`/api/measure/${act}`, { method: 'POST' });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      msrSay(e.error === 'already running' ? '이미 진행 중인 측정이 있어 그 상태를 보여드려요'
        : e.error === 'not running' ? '측정이 이미 정지되어 있어요'
        : '요청이 거부됐어요 — 상태를 다시 불러왔어요');
    }
  } catch { msrSay('서버에 연결할 수 없어요'); }
  await pullMeasure(); if (!settingsOpen) render();
}
const fmtDurS = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
function measureHTML() {
  const m = msr;
  const sW = v => v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} Wh`;
  const uW = v => v == null ? '–' : `${v.toFixed(2)} Wh`;
  let body;
  if (!m.state || m.state === 'idle') {
    body = `<div class="mrow"><button class="mbtn" data-m="start">⏱ 측정 시작</button><span class="mhint">지금부터 전력량(Wh)을 적산해요</span></div>`;
  } else {
    const run = m.state === 'running';
    const rows = [
      ['경과', `${fmtDurS(m.durSec)}${m.gapSec ? ` · 공백 ${fmtDurS(m.gapSec)}` : ''}`],
      ['외부 입력 <em class="mbadge">센서</em>', `${uW(m.adapterWh)}${m.avgAdapterW != null ? ` · ${m.avgAdapterW.toFixed(1)} W` : ''}`],
      ['시스템 사용 <em class="mbadge">센서</em>', `${uW(m.systemWh)}${m.avgSystemW != null ? ` · ${m.avgSystemW.toFixed(1)} W` : ''}`],
      ['배터리 <em class="mbadge">수지 추정</em>', `${sW(m.balanceWh)}${m.balanceChgWh || m.balanceDisWh ? ` (+${uW(m.balanceChgWh)} / −${uW(m.balanceDisWh)})` : ''}`],
      ['배터리 <em class="mbadge">게이지 검산</em>', `${sW(m.gaugeDeltaWh)}${m.gaugeDeltaMah != null ? ` · ${m.gaugeDeltaMah >= 0 ? '+' : ''}${m.gaugeDeltaMah} mAh` : ''}`],
    ];
    if (!run && m.differenceWh != null) rows.push(['두 추정의 차이', `${sW(m.differenceWh)}${m.differencePct != null ? ` (${m.differencePct}%)` : ''}`]);
    body = rows.map(([k, v]) => `<div class="cmp"><span>${k}</span><b>${v}</b></div>`).join('')
      + (m.gapSec ? `<div class="mnote">측정 공백은 적산에서 제외돼요 — 게이지 검산은 공백과 무관해요(칩이 계속 적분)</div>` : '')
      + `<div class="mrow">${run
          ? `<button class="mbtn stop" data-m="stop">■ 정지</button><span class="mhint">피크 시스템 ${m.peakSystemW != null ? m.peakSystemW.toFixed(1) : '–'} W</span>`
          : `<button class="mbtn" data-m="reset">새 측정</button><span class="mhint">결과는 새 측정 시작 전까지 유지돼요</span>`}</div>`;
  }
  return `<div class="sec">전력량 측정</div>${msrNote ? `<div class="mnote mwarn">${msrNote}</div>` : ''}${body}`;
}
function tailHTML(s) { return powerCompareHTML(s) + measureHTML() + detailHTML(s) + procsHTML(); }

// ── settings panel (gear) ──────────────────────────────────────────────
// data-k = a localStorage display pref (popover-only) · data-c = a server cfg key (menu-bar/alerts)
const selEl = (attr, key, cur, opts) => `<select ${attr}="${key}">` +
  opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`).join('') + `</select>`;
const tglEl = (key, on) => `<button class="tgl${on ? ' on' : ''}" data-c="${key}" role="switch" aria-checked="${on}"><i></i></button>`;
const pctOpts = steps => steps.map(v => [String(v), v === 0 ? '끄기' : `${v}%`]);

// 메뉴바 위젯: 모양은 실물 썸네일 갤러리, 텍스트는 독립 칩 — 조합을 글로 상상하는 대신 위의
// 미리보기(트레이 렌더러가 덤프한 진짜 픽셀)로 결과를 확인하고 고른다.
const WIDGETS = [
  ['icon', '채움', '넓음'], ['combo', '채움+숫자', '최다 정보'], ['iconpct', '테두리+숫자', 'macOS풍'],
  ['stack', '숫자↑아이콘', '좁음'], ['wstack', '전력↑잔량', '전력+잔량'], ['bar', '세로 막대', '가장 좁음'], ['text', '텍스트만', '아이콘 없음'],
];
const PV_SIMS = [['cur', '현재'], ['chg', '충전'], ['low', '부족'], ['lpm', '저전력']];
const widgetHasDigits = w => w === 'combo' || w === 'iconpct' || w === 'stack' || w === 'wstack';

function menubarHTML() {
  const digitsIn = widgetHasDigits(cfg.widget);
  const pctForced = cfg.widget === 'text' && !cfg.text_time && !cfg.text_w_sys && !cfg.text_w_bat && !cfg.text_temp && !cfg.text_adp;   // text-only never goes blank
  const chip = (key, label, on, locked, badge, tip) =>
    `<button class="chip${on ? ' on' : ''}${locked ? ' locked' : ''}"${locked ? '' : ` data-t="${key}"`} aria-pressed="${on}"${tip ? ` title="${tip}"` : ''}><i class="cdot"></i>${label}${badge ? `<em>${badge}</em>` : ''}</button>`;
  return `
    <div class="sec">메뉴바</div>
    <div class="pvstrip" id="pvstrip"></div>
    <div class="pvmeta"><span class="pvwidth" id="pvwidth"></span><span class="simseg">${
      PV_SIMS.map(([k, l]) => `<button data-sim="${k}" class="${pvSim === k ? 'on' : ''}">${l}</button>`).join('')}</span></div>
    <div class="ssub">모양</div>
    <div class="gal">${WIDGETS.map(([k, l, sub]) =>
      `<button data-w="${k}" class="${cfg.widget === k ? 'on' : ''}" aria-pressed="${cfg.widget === k}"><span class="gth" data-gth="${k}"></span><span class="glb">${l}<small>${sub}</small></span></button>`).join('')}</div>
    <div class="ssub">옆에 붙는 텍스트</div>
    <div class="chips">
      ${digitsIn ? chip('pct', '잔량 %', true, true, '아이콘에 포함')
        : pctForced ? chip('pct', '잔량 %', true, true, '기본 표시')
        : chip('pct', '잔량 %', !!cfg.text_pct, false)}
      ${chip('time', '남은/완충 시간', !!cfg.text_time, false)}
      ${chip('wsys', '시스템 전력', !!cfg.text_w_sys, false)}
      ${chip('wbat', '배터리 전력', !!cfg.text_w_bat, false, null, '양수(+)는 충전, 음수(−)는 방전 — 배터리로 드나드는 전력')}
      ${chip('adp', '어댑터 전력', !!cfg.text_adp, false, null, '충전기가 공급 중인 실측 전력 — 외부 전원 연결 중에만 보여요')}
      ${chip('temp', '온도', !!cfg.text_temp, false, null, '배터리 온도(°C) — 센서가 읽힐 때만 보여요')}
    </div>
    <div class="chiphint">${digitsIn ? '이 모양은 잔량 숫자를 아이콘 안에 그려요 — 옆 텍스트와 중복되지 않아요.'
      : pctForced ? '텍스트만 모양은 비워둘 수 없어 잔량을 기본 표시해요.'
      : '켠 항목이 공백으로 이어져 아이콘 옆에 붙어요. 시스템·배터리 전력을 둘 다 켤 수도 있어요.'}</div>
    ${(cfg.text_w_bat || (cfg.widget === 'wstack' && cfg.w7_src === 'bat')) ? '<div class="chiphint signhint">배터리 전력은 부호로 방향을 나타내요 — 양수(+)는 충전, 음수(−)는 방전. 시스템 전력은 항상 양수(소비)예요.</div>' : ''}
    <div class="srow"><span>상태별 색상</span>${tglEl('colorize', cfg.colorize)}</div>
    ${cfg.widget === 'icon' ? `<div class="srow"><span>큰 아이콘</span>${tglEl('glyph_xl', cfg.glyph_xl)}</div>` : ''}
    ${cfg.widget === 'stack' ? `<div class="srow"><span>숫자 색·테두리</span>${tglEl('digit_deco', cfg.digit_deco)}</div>` : ''}
    ${cfg.widget === 'wstack' ? `<div class="srow"><span>위 숫자 전력</span><span class="subseg"><button data-w7="sys" class="${cfg.w7_src !== 'bat' ? 'on' : ''}">시스템</button><button data-w7="bat" class="${cfg.w7_src === 'bat' ? 'on' : ''}">배터리</button></span></div>` : ''}
    <div class="srow"><span>열기 단축키 <kbd>⌥⌃B</kbd></span>${tglEl('shortcut', cfg.shortcut)}</div>`;
}

function settingsHTML() {
  return `<div class="settings">
    <div class="sec">표시</div>
    <div class="srow"><span>언어 / Language</span>${selEl('data-lang', 'lang', battLang(), langList)}</div>
    <div class="srow"><span>레이아웃</span>${selEl('data-k', 'pv', pv, [['list', '목록'], ['cards', '카드'], ['gauge', '게이지']])}</div>
    <div class="srow"><span>테마</span>${selEl('data-k', 'theme', theme, [['dark', '다크'], ['light', '라이트'], ['system', '시스템']])}</div>
    <div class="srow"><span>온도 단위</span>${selEl('data-k', 'unit', unit, [['system', '시스템'], ['c', '°C'], ['f', '°F']])}</div>
    <div class="srow"><span>시간 형식</span>${selEl('data-k', 'timeFmt', timeFmt, [['short', '1:20'], ['long', '1시간 20분']])}</div>
    <div class="srow"><span>상위 프로세스 수</span>${selEl('data-k', 'procN', procN, [['0', '끄기'], ['3', '3'], ['5', '5'], ['6', '6'], ['8', '8'], ['10', '10'], ['15', '15']])}</div>
    ${menubarHTML()}
    <div class="sec">알림</div>
    <div class="srow"><span>배터리 부족</span>${selEl('data-c', 'low_pct', cfg.low_pct, pctOpts([0, 10, 15, 20, 25, 30]))}</div>
    <div class="srow"><span>충전 완료</span>${selEl('data-c', 'high_pct', cfg.high_pct, pctOpts([0, 70, 75, 80, 85, 90, 100]))}</div>

    <div class="shint">메뉴바·알림 설정은 즉시 저장되어 메뉴바에 반영됩니다.</div>
  </div>`;
}

// ── menu-bar preview (settings) ────────────────────────────────────────
// The glyphs are the Rust tray renderer's own pixels (dumped per state as base64 RGBA), so the
// preview cannot drift from the real menu bar. The title text is composed here with the exact
// rules tray_title() uses — % skipped when drawn in the glyph, time only when known, text-only
// never blank — which is what the locked chips above visualize.
function pvState() {
  if (pvSim !== 'cur' && pvData && pvData.states && pvData.states[pvSim]) return pvData.states[pvSim];
  const s = live || {};
  // pct comes from the DUMP (the tray's own number) so the strip text can never disagree with
  // the glyph digits next to it; W/time are live (they move every tick, cosmetic for preview)
  const trayPct = pvData && pvData.states && pvData.states.cur ? pvData.states.cur.pct : null;
  // batW mirrors the widget's 혼합 method: 방전 → SMC PPBR(음수), 그 외 → 수지(powerW, signed)
  const batW = (!s.charging && s.ppbrW != null) ? -Math.abs(s.ppbrW) : (+s.powerW || 0);
  return { pct: trayPct ?? s.pct ?? 0, min: s.timeRemain ?? null, sysW: s.systemW ?? s.watts ?? 0, batW,
    tempC: s.tempC ?? null, adpW: s.adapterW ?? null };
}
const fmtSignedW = n => Math.abs(n) < 0.05 ? '0.0W' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}W`;
function composeTrayTitle(st) {
  const parts = [];
  if (cfg.text_pct && !widgetHasDigits(cfg.widget)) parts.push(`${Math.round(st.pct)}%`);
  if (cfg.text_time && st.min != null) parts.push(`${Math.floor(st.min / 60)}:${String(st.min % 60).padStart(2, '0')}`);
  if (cfg.text_w_sys) parts.push(`${(+st.sysW || 0).toFixed(1)}W`);   // system draw — always ≥0
  if (cfg.text_w_bat) parts.push(fmtSignedW(+st.batW || 0));           // battery rail — signed
  if (cfg.text_adp && st.adpW != null) parts.push(`${(+st.adpW).toFixed(1)}W`);   // adapter measured — AC only
  if (cfg.text_temp && st.tempC != null) parts.push(`${Math.round(st.tempC)}°`);  // battery temp (°C)
  if (cfg.widget === 'text' && !parts.length) parts.push(`${Math.round(st.pct)}%`);
  return parts.join(' ');   // 공백 구분 — " · "를 빼서 메뉴바 폭 절약 (tray_title과 동일)
}
function glyphCanvas(styleKey, dispH, pixelated) {
  const set = pvData && pvData.glyphs && pvData.glyphs[pvSim];
  const variant = styleKey === 'icon' && cfg.glyph_xl ? 'icon_xl'
    : styleKey === 'stack' && !cfg.digit_deco ? 'stack_plain'
    : styleKey === 'wstack' && cfg.w7_src === 'bat' ? 'wstack_bat' : styleKey;
  const g = set && set[variant];
  if (!g) return null;
  try {
    const raw = atob(cfg.colorize ? g.c : g.m);
    const arr = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    const c = document.createElement('canvas');
    c.width = g.w; c.height = g.h;
    c.getContext('2d').putImageData(new ImageData(arr, g.w, g.h), 0, 0);
    c.style.height = dispH + 'px'; c.style.width = Math.round(g.w * dispH / g.h) + 'px';
    if (pixelated) c.style.imageRendering = 'pixelated';
    return c;
  } catch { return null; }
}
function renderPreviewZone() {
  const strip = $('pvstrip'); if (!strip) return;
  const st = pvState(), title = composeTrayTitle(st);
  strip.textContent = '';
  const g = cfg.widget === 'text' ? null : glyphCanvas(cfg.widget, 17, false);
  if (g) strip.appendChild(g);
  else if (cfg.widget !== 'text' && !pvData) { const ph = document.createElement('span'); ph.className = 'pvph'; ph.textContent = '미리보기 준비 중…'; strip.appendChild(ph); }
  if (title) { const t = document.createElement('span'); t.className = 'pvtxt'; t.textContent = title; strip.appendChild(t); }
  // 점유 폭 추정: 글리프(메뉴바 높이 스케일) + 텍스트(시스템 13px) + 트레이 항목 좌우 패딩
  if (!pvMeasure) pvMeasure = document.createElement('canvas').getContext('2d');
  pvMeasure.font = '500 13px -apple-system, system-ui, sans-serif';
  const gw = g ? parseFloat(g.style.width) : 0;
  const tw = title ? pvMeasure.measureText(title).width + (g ? 5 : 0) : 0;
  const wEl = $('pvwidth'); if (wEl) wEl.innerHTML = `점유 폭 <b>≈${Math.round(gw + tw + 14)}pt</b>`;
  document.querySelectorAll('.gal [data-gth]').forEach(th => {
    th.textContent = '';
    const k = th.dataset.gth;
    if (k === 'text') { const t = document.createElement('b'); t.textContent = `${Math.round(st.pct)}%`; th.appendChild(t); return; }
    const c = glyphCanvas(k, k === 'stack' ? 22 : 20, true);
    if (c) th.appendChild(c);
  });
}
async function pullPreview() {
  try { const r = await fetch('/api/tray-preview', { cache: 'no-store' }); if (r.ok) pvData = await r.json(); } catch { /* keep last */ }
  if (settingsOpen) renderPreviewZone();   // refresh strip/thumbs in place — no full re-render (would reset open selects)
}
// chips save as ONE patch (all text keys) so tray.json gains the full set at once — after the
// first save neither side needs the legacy `info`/`text_w` fallback again.
function applyTextChip(k) {
  const patch = { text_pct: !!cfg.text_pct, text_time: !!cfg.text_time, text_w_sys: !!cfg.text_w_sys, text_w_bat: !!cfg.text_w_bat, text_temp: !!cfg.text_temp, text_adp: !!cfg.text_adp };
  if (k === 'pct') patch.text_pct = !patch.text_pct;
  else if (k === 'time') patch.text_time = !patch.text_time;
  else if (k === 'wsys') patch.text_w_sys = !patch.text_w_sys;   // system & battery power independent
  else if (k === 'wbat') patch.text_w_bat = !patch.text_w_bat;
  else if (k === 'adp') patch.text_adp = !patch.text_adp;
  else if (k === 'temp') patch.text_temp = !patch.text_temp;
  cfg = { ...cfg, ...patch };
  render();
  fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
}

function procsHTML() {
  if (!procs.length) return '';
  const max = Math.max(...procs.map(p => p.power), 1);
  return `<div class="sec">배터리 소모 상위 (power)</div>` + procs.map(p =>
    `<div class="proc"><span class="pn" title="${esc(p.name)}">${esc(p.name)}</span>` +
    `<span class="pbarwrap"><i class="pbar" style="width:${Math.round((+p.power || 0) / max * 100)}%"></i></span>` +
    `<b>${(+p.power || 0).toFixed(1)}</b></div>`).join('');
}

// footer status: green live dot + (when the launchd sampler is on) a red "기록 중" dot
function setLive() {
  const rec = live && live.recording ? `<i class="pdot rec"></i>기록 중 · ` : '';
  $('live').innerHTML = `${rec}<i class="pdot live"></i>라이브`;
}
function render() { paint(); renderSpark(); fitWindow(); }   // fitWindow reads getBoundingClientRect (forces layout) → works even while the window is hidden (rAF is paused then)
function paint() {
  const el = $('pop');
  document.documentElement.className = resolveTheme();
  document.body.dataset.pv = pv;
  document.body.classList.toggle('settings-open', settingsOpen);
  document.querySelectorAll('.vsel button').forEach(b => b.classList.toggle('on', b.dataset.pv === pv));
  if (settingsOpen) {
    el.innerHTML = settingsHTML(); $('poptail').innerHTML = ''; $('live').textContent = '';
    renderPreviewZone();
    if (!pvData) pullPreview();
    // poll while open: keeps the "현재" preview live and picks up fresh dumps as % changes
    if (!pvTimer) pvTimer = setInterval(() => { if (!document.hidden && settingsOpen) pullPreview(); }, 2000);
    return;
  }
  if (pvTimer) { clearInterval(pvTimer); pvTimer = 0; }
  if (!live || live.error) { el.innerHTML = `<div class="err">배터리 정보를 읽을 수 없습니다${live && live.error ? ` (${esc(live.error)})` : ''}.</div>`; $('poptail').innerHTML = ''; $('live').textContent = ''; return; }
  const s = live;
  const known = s.pct != null;
  const pct = known ? Math.round(s.pct) : 0;   // unknown → gauge shows 0 fill but label reads "?"
  const pctLbl = known ? `${pct}%` : '?';
  // 팝오버는 대중용 → 정수%가 기본, 정밀%(rawCap/rawMax)는 작게 병기
  const capPct = (s.rawCap > 0 && s.rawMax > 0) ? s.rawCap / s.rawMax * 100 : null;
  const precSmall = capPct != null ? `<div class="psm">정밀 ${capPct.toFixed(1)}%</div>` : '';
  document.documentElement.style.setProperty('--state', stateColor(s, pct));   // tint whole UI to battery state
  const timeLbl = s.charging ? '완충까지' : '남은 시간';
  const lpm = s.lowPower ? `<span class="lpm">🟡 저전력 모드</span>` : '';

  if (pv === 'gauge') {
    const R = 52, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
    el.innerHTML =
      `<div class="gauge">
        <svg viewBox="0 0 140 140" width="150" height="150">
          <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="var(--state)" stop-opacity="1"/>
            <stop offset="1" stop-color="var(--state)" stop-opacity=".68"/></linearGradient></defs>
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--line)" stroke-width="11"/>
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="url(#gg)" stroke-width="11"
            stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}" transform="rotate(-90 70 70)"/>
          <text x="70" y="66" text-anchor="middle" class="gpct">${pctLbl}</text>
          <text x="70" y="88" text-anchor="middle" class="gsub">${stateIcon(s)} ${(s.systemW ?? s.watts) != null ? (s.systemW ?? s.watts).toFixed(1) + 'W' : ''}</text>
        </svg>
        <div class="gstate">${stateOf(s)}</div>${precSmall} ${lpm ? `<div style="margin-top:6px">${lpm}</div>` : ''}
        <div class="gtime">${timeLbl} <b>${timeVal(s)}</b></div>
      </div>
      <div class="sec">상태</div>
      <div class="kv"><span>배터리 온도</span><b>${fmtTemp(s.tempC)}${s.smc ? ' <i class="ld"></i>' : ''}</b></div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      <div class="hbar"><i style="width:${s.healthPct != null ? Math.min(100, s.healthPct) : 0}%"></i></div>
      ${kvHTML(rowsHealth(s))}`;
  } else if (pv === 'cards') {
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>${precSmall}
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="card"><div class="ct">${timeLbl}</div><div class="cv">${timeVal(s)}</div></div>
      <div class="cards2">
        <div class="card"><div class="ct">${s.systemW != null ? '시스템 전력' : '전력'}</div><div class="cv">${s.systemW != null ? s.systemW.toFixed(1) : (s.watts != null ? s.watts.toFixed(1) : '–')}<small>W</small></div></div>
        <div class="card"><div class="ct">배터리 온도</div><div class="cv">${fmtTemp(s.tempC).replace(/ °[CF]/,'')}<small>°${resolveUnit()==='f'?'F':'C'}</small></div></div>
        <div class="card"><div class="ct">건강</div><div class="cv">${s.healthPct != null ? Math.min(100, Math.round(s.healthPct)) : '–'}<small>%</small></div></div>
        <div class="card"><div class="ct">사이클</div><div class="cv">${s.cycles ?? '–'}</div></div>
      </div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      ${kvHTML([...(detail.condition ? [['상태(컨디션)', esc(detail.condition)]] : []), ['만충 / 설계', (s.rawMax != null && s.design != null ? s.rawMax + ' / ' + s.design : '–') + ' mAh']])}`;
  } else { // list (Stats-like dense)
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>${precSmall}
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="sec">상태</div>
      ${kvHTML(statusRows(s))}
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      ${kvHTML(rowsHealth(s))}`;
  }
  $('poptail').innerHTML = tailHTML(s);   // 상세 + 프로세스 render below the trend preview (#sparkbox sits between)
  setLive();
}

// footer: layout segmented + gear (settings)
$('foot').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.pv) { pv = b.dataset.pv; save('battPV', pv); settingsOpen = false; render(); }
  else if (b.id === 'moreBtn') { moreOpen = !moreOpen; renderMenu(); }
});

// settings controls (delegated — #pop is rebuilt on every render)
const coerce = (k, v) => (k === 'low_pct' || k === 'high_pct') ? +v : v;
function applyDisplay(k, v) {
  if (k === 'pv') { pv = v; save('battPV', v); }
  else if (k === 'theme') { theme = v; save('battTheme', v); }
  else if (k === 'unit') { unit = v; save('battUnit', v); }
  else if (k === 'timeFmt') { timeFmt = v; save('battTimeFmt', v); }
  else if (k === 'procN') { procN = +v; save('battProcN', v); pullProcs(); }
  render();
}
async function applyCfg(k, v) {
  cfg = { ...cfg, [k]: v };
  render();   // reflect toggle/select immediately
  try { await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [k]: v }) }); } catch { /* keep local */ }
}
$('pop').addEventListener('change', e => {
  const t = e.target;
  if (t.matches('select[data-lang]')) setLangPop(t.value);   // 언어: 앱 전체 공용(localStorage) → 새로고침
  else if (t.matches('select[data-k]')) applyDisplay(t.dataset.k, t.value);
  else if (t.matches('select[data-c]')) applyCfg(t.dataset.c, coerce(t.dataset.c, t.value));
});
$('pop').addEventListener('click', e => {
  const mb = e.target.closest('[data-m]');             // 전력량 측정 start/stop/reset
  if (mb) { doMeasure(mb.dataset.m); return; }
  const sim = e.target.closest('[data-sim]');          // preview state simulator (현재/충전/부족/저전력)
  if (sim) { pvSim = sim.dataset.sim; render(); return; }
  const w7 = e.target.closest('[data-w7]');            // widget-7 power source (checked before [data-w])
  if (w7) { applyCfg('w7_src', w7.dataset.w7); return; }
  const w = e.target.closest('[data-w]');              // widget shape gallery
  if (w) { applyCfg('widget', w.dataset.w); return; }
  const t = e.target.closest('[data-t]');              // text item chips
  if (t) { applyTextChip(t.dataset.t); return; }
  const b = e.target.closest('.tgl'); if (!b) return;  // boolean toggle (settings)
  applyCfg(b.dataset.c, !cfg[b.dataset.c]);
});
// trend preview lives in its own persistent container (#sparkbox) so the live 3D canvas survives
$('sparkbox').addEventListener('click', e => {
  const sm = e.target.closest('[data-sm]'); if (sm) { sparkMode = sm.dataset.sm; save('battSparkMode', sparkMode); renderSpark(); fitWindow(); return; }
  const sh = e.target.closest('[data-sh]'); if (sh) { sparkH = +sh.dataset.sh; save('battSparkH', String(sparkH)); pullSpark(); return; }
  if (e.target.closest('[data-report]')) openReport();   // spark preview → full 3D report
});
// ── overflow (⋮) menu: settings + the app actions from the right-click tray menu ──
// 설정 opens the in-popover panel; record/quit POST to /api/action → a file the tray app consumes.
function renderMenu() {
  const m = $('moreBtn'); if (m) m.style.color = moreOpen ? 'var(--fg)' : '';
  const el = $('omenu');
  if (!moreOpen) { el.hidden = true; el.innerHTML = ''; return; }
  const recLabel = (live && live.recording) ? '⏸  배터리 기록 중지' : '▶  배터리 기록 시작';
  el.innerHTML =
    `<button data-m="report">📊  3D 분석 리포트</button>` +
    `<button data-m="settings">⚙  설정<span class="mk">⌘,</span></button>` +
    `<button data-m="record">${recLabel}</button>` +
    `<button data-m="quit" class="danger">⏻  앱 종료</button>`;
  el.hidden = false;
}
async function postAction(act) {
  try { await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: act }) }); } catch { /* ignore */ }
}
function openReport() { moreOpen = false; renderMenu(); postAction('report'); }   // Rust shows the report window AND hides the popover (one action → no file race with hide)
$('omenu').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  moreOpen = false; renderMenu();
  if (b.dataset.m === 'settings') { settingsOpen = true; pullConfig(); render(); }
  else postAction(b.dataset.m);   // record / quit
});
// clicking anywhere else closes the overflow menu
document.addEventListener('click', e => {
  if (moreOpen && !e.target.closest('#omenu') && !e.target.closest('#moreBtn')) { moreOpen = false; renderMenu(); }
});

// called from Rust: tray "설정 열기…" jumps into settings; a plain icon-click resets to the dashboard
window.openSettings = () => { settingsOpen = true; pullConfig(); render(); };
window.closeSettings = () => { if (settingsOpen) { settingsOpen = false; render(); } };
// ESC closes the settings panel (→ dashboard); on the dashboard, blur so the window auto-hides
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (moreOpen) { moreOpen = false; renderMenu(); }        // ESC closes the ⋯ menu first
    else if (settingsOpen) { settingsOpen = false; render(); }   // then settings → dashboard
    else { hideWindow(); }                                   // then the popover itself
  } else if (e.key === ',' && e.metaKey) {                   // ⌘, — macOS Preferences shortcut → open settings
    e.preventDefault();
    if (!settingsOpen) { settingsOpen = true; pullConfig(); render(); }
  } else if ((e.key === 'r' || e.key === 'R') && e.metaKey) { // ⌘R — open the 3D report
    e.preventDefault();
    openReport();
  }
});

initI18nPop();   // 언어(팝오버 설정에서 선택, localStorage 공용) 적용 + 이후 렌더 자동 번역
render();
pull(); pullProcs(); pullDetail(); pullConfig(); pullSpark(); pullMeasure();
setInterval(() => { if (!document.hidden) pull(); }, 2000);
setInterval(() => { if (!document.hidden) pullMeasure(); }, 2000);   // 상태 무관 상시 폴링 — idle 게이트는 숨김→복귀 시 stale UI를 만들었음(409 유령 세션 사건)
setInterval(() => { if (!document.hidden) pullProcs(); }, 5000);
setInterval(() => { if (!document.hidden) pullDetail(); }, 12000);
setInterval(() => { if (!document.hidden) pullSpark(); }, 30000);
