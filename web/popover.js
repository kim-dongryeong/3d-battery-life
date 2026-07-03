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
let theme = qs('theme') || ls('battTheme', 'dark');   // dark | light | system
let unit = ls('battUnit', 'system');                  // system | c | f
let timeFmt = ls('battTimeFmt', 'long');              // short(1:20) | long(1시간 20분)
let procN = +ls('battProcN', '6');                    // top-processes count · 0 = hide
let sparkMode = ls('battSparkMode', 'pct');           // mini-chart metric: pct | w
let sparkH = +ls('battSparkH', '6');                  // mini-chart window hours: 6 | 24 | 0(all)
let cfg = { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: 'icon', glyph_xl: false, shortcut: true };
let live = null, procs = [], detail = {}, spark = [], lastLiveAt = 0, settingsOpen = qs('settings') === '1', moreOpen = false;

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
let lastWinH = 0;
function fitWindow() {
  if (document.hidden) return;   // a hidden webview doesn't lay out reliably → measure only when shown
  const h = Math.min(Math.ceil(document.body.getBoundingClientRect().height), Math.round((screen.availHeight || 900) * 0.95));
  if (Math.abs(h - lastWinH) < 2) return;   // only post when the content height actually changes
  lastWinH = h;
  fetch('/api/height', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ h }) }).catch(() => {});
}
// when the popover is shown, re-pull fresh data and re-measure at the true (visible) layout height
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  lastWinH = 0;
  pull(); pullProcs(); pullDetail();
  requestAnimationFrame(fitWindow);
});
const hideWindow = () => { fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'hide' }) }).catch(() => {}); };
const stateOf = s => s.charging ? '충전 중' : s.full ? '완충' : s.ac ? 'AC 연결(유휴)' : '배터리 사용';
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
  if (!settingsOpen) render();
}

function batterySVG(pct, s) {
  const w = 46, fill = Math.max(4, pct / 100 * (w - 7));
  // charging → bolt · plugged-but-not-charging → plug · on battery → nothing (like Stats)
  const glyph = s.charging
    ? `<path d="M23.6 6.3 L16.4 15.8 H21 L19.4 21.7 L27.2 11.7 H22.4 L24.6 6.3 Z" fill="var(--onfg)"/>`
    : s.ac
      ? `<g fill="var(--onfg)"><rect x="18.5" y="6" width="1.7" height="3.4" rx=".8"/><rect x="23.8" y="6" width="1.7" height="3.4" rx=".8"/><rect x="16.5" y="9" width="11" height="6.2" rx="1.6"/><rect x="20.4" y="15.2" width="3.2" height="4" rx="1"/></g>`
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
    const w = s.adapterW, v = detail.adapterVoltage;
    const a = (w != null && v) ? Math.round(w / v * 1000) : null;   // live adapter current ≈ W/V
    const p = [w != null ? `${w.toFixed(1)} W` : null, v != null ? `${v.toFixed(1)} V` : null, a != null ? `${a} mA` : null].filter(Boolean);
    if (p.length) r.push(['어댑터', p.join(' · ') + (w != null ? ' <i class="ld"></i>' : '')]);
  }
  const bp = s.powerW;
  const bw = bp == null ? null : Math.abs(bp) < 0.05 ? '0 W' : `${bp > 0 ? '+' : '−'}${Math.abs(bp).toFixed(2)} W`;
  const b = [bw, s.voltage != null ? `${s.voltage.toFixed(2)} V` : null, s.amperage != null ? `${s.amperage} mA` : null].filter(Boolean);
  r.push(['배터리', (b.length ? b.join(' · ') : '–') + (s.batLive ? ' <i class="ld"></i>' : '')]);
  return r;
}
// 상태 rows shared by list/gauge: remaining time + live temperature.
function statusRows(s) {
  return [
    [s.charging ? '완충까지' : '남은 시간', timeVal(s)],
    ['온도', fmtTemp(s.tempC) + (s.smc ? ' <i class="ld"></i>' : '')],
  ];
}
function rowsHealth(s) {
  return [
    ['최대 용량(건강)', s.healthPct != null ? `${Math.min(100, Math.round(s.healthPct))}%` : '–'],
    ['사이클', s.cycles != null ? `${s.cycles}회` : '–'],
    ['만충 / 설계', (s.rawMax != null && s.design != null) ? `${s.rawMax} / ${s.design} mAh` : '–'],
  ];
}
const kvHTML = rows => rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('');

function detailHTML(s) {
  const rows = [];
  if (detail.condition) rows.push(['상태(컨디션)', esc(detail.condition)]);
  if (detail.designCycleCount) rows.push(['설계 사이클 한도', `${+detail.designCycleCount}회`]);
  if (detail.manufactureDate) rows.push(['제조일', `${esc(detail.manufactureDate)}${detail.ageDays ? ` · ${Math.floor(detail.ageDays / 365)}년 ${Math.round((detail.ageDays % 365) / 30)}개월` : ''}`]);
  if (s.ac && detail.adapterWatts) rows.push(['전원 어댑터', `${+detail.adapterWatts} W${detail.adapterName ? ' · ' + esc(detail.adapterName) : ''}`]);
  if (detail.onHold) rows.push(['충전 상태', '🔵 최적화 충전(대기 중)']);
  if (detail.serial) rows.push(['배터리 시리얼', esc(detail.serial)]);
  return rows.length ? `<div class="sec">상세</div>${kvHTML(rows)}` : '';
}
// mini "3D 리포트" preview — selectable 2D charts: 잔량(%) area · 전력(W) line, over 6h/24h/전체.
// Clicking the chart / "전체 3D 그래프 →" opens the full 3D report.
function sparkHTML() {
  const modeBtns = [['pct', '잔량'], ['w', '전력']].map(([m, l]) => `<button data-sm="${m}" class="${sparkMode === m ? 'on' : ''}">${l}</button>`).join('');
  const winBtns = [[6, '6시간'], [24, '24시간'], [0, '전체']].map(([w, l]) => `<button data-sh="${w}" class="${sparkH === w ? 'on' : ''}">${l}</button>`).join('');
  const head = `<div class="sec">최근 추세</div><div class="spbtns"><span class="spseg">${modeBtns}</span><span class="spseg">${winBtns}</span></div>`;
  const pts = spark.filter(p => (sparkMode === 'w' ? p.w : p.pct) != null);
  if (!Array.isArray(spark) || pts.length < 3) return head + `<div class="note spnote">기록 데이터가 쌓이면 표시돼요.</div>`;
  const W = 296, H = 44, pad = 3;
  const vs = pts.map(p => sparkMode === 'w' ? p.w : p.pct), ts = pts.map(p => p.t);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const tr = Math.max(1, t1 - t0), vr = Math.max(sparkMode === 'w' ? 0.5 : 1, vmax - vmin);
  const X = t => pad + (t - t0) / tr * (W - 2 * pad);
  const Y = v => pad + (1 - (v - vmin) / vr) * (H - 2 * pad);
  const line = pts.map(p => `${X(p.t).toFixed(1)},${Y(sparkMode === 'w' ? p.w : p.pct).toFixed(1)}`).join(' ');
  const area = `${X(t0).toFixed(1)},${H - pad} ${line} ${X(t1).toFixed(1)},${H - pad}`;
  const hrs = Math.max(1, Math.round((t1 - t0) / 3600));
  const sub = sparkMode === 'w'
    ? `${vmin.toFixed(1)}–${vmax.toFixed(1)} W`
    : `${(vs[vs.length - 1] - vs[0]) >= 0 ? '+' : ''}${(vs[vs.length - 1] - vs[0])}%p`;
  return head +
    `<svg class="spark" data-report viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <defs><linearGradient id="sf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${sparkMode === 'pct' ? `<polygon points="${area}" fill="url(#sf)"/>` : ''}
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>` +
    `<div class="spmore"><span class="spsub">${hrs}시간 · ${sub}</span><span data-report>전체 3D 그래프 →</span></div>`;
}
function tailHTML(s) { return sparkHTML() + detailHTML(s) + procsHTML(); }

// ── settings panel (gear) ──────────────────────────────────────────────
// data-k = a localStorage display pref (popover-only) · data-c = a server cfg key (menu-bar/alerts)
const INFO_OPTS = [['0', '아이콘만'], ['1', '퍼센트'], ['2', '남은 시간'], ['3', '전력(W)'], ['4', '퍼센트+전력'], ['5', '퍼센트+시간']];
const selEl = (attr, key, cur, opts) => `<select ${attr}="${key}">` +
  opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`).join('') + `</select>`;
const tglEl = (key, on) => `<button class="tgl${on ? ' on' : ''}" data-c="${key}" role="switch" aria-checked="${on}"><i></i></button>`;
const pctOpts = steps => steps.map(v => [String(v), v === 0 ? '끄기' : `${v}%`]);

function settingsHTML() {
  return `<div class="settings">
    <div class="sec">표시</div>
    <div class="srow"><span>레이아웃</span>${selEl('data-k', 'pv', pv, [['list', '목록'], ['cards', '카드'], ['gauge', '게이지']])}</div>
    <div class="srow"><span>테마</span>${selEl('data-k', 'theme', theme, [['dark', '다크'], ['light', '라이트'], ['system', '시스템']])}</div>
    <div class="srow"><span>온도 단위</span>${selEl('data-k', 'unit', unit, [['system', '시스템'], ['c', '°C'], ['f', '°F']])}</div>
    <div class="srow"><span>시간 형식</span>${selEl('data-k', 'timeFmt', timeFmt, [['short', '1:20'], ['long', '1시간 20분']])}</div>
    <div class="srow"><span>상위 프로세스 수</span>${selEl('data-k', 'procN', procN, [['0', '끄기'], ['3', '3'], ['5', '5'], ['6', '6'], ['8', '8'], ['10', '10'], ['15', '15']])}</div>

    <div class="sec">메뉴바</div>
    <div class="srow"><span>표시 텍스트</span>${selEl('data-c', 'info', cfg.info, INFO_OPTS)}</div>
    <div class="srow"><span>위젯 모양</span>${selEl('data-c', 'widget', cfg.widget, [['icon', '아이콘'], ['iconpct', '아이콘+숫자'], ['bar', '막대'], ['text', '텍스트']])}</div>
    <div class="srow"><span>아이콘 색상</span>${tglEl('colorize', cfg.colorize)}</div>
    <div class="srow"><span>큰 아이콘</span>${tglEl('glyph_xl', cfg.glyph_xl)}</div>
    <div class="srow"><span>열기 단축키 <kbd>⌥⌃B</kbd></span>${tglEl('shortcut', cfg.shortcut)}</div>

    <div class="sec">알림</div>
    <div class="srow"><span>배터리 부족</span>${selEl('data-c', 'low_pct', cfg.low_pct, pctOpts([0, 10, 15, 20, 25, 30]))}</div>
    <div class="srow"><span>충전 완료</span>${selEl('data-c', 'high_pct', cfg.high_pct, pctOpts([0, 70, 75, 80, 85, 90, 100]))}</div>

    <div class="shint">메뉴바·알림 설정은 즉시 저장되어 메뉴바에 반영됩니다.</div>
  </div>`;
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
function render() { paint(); fitWindow(); }   // fitWindow reads getBoundingClientRect (forces layout) → works even while the window is hidden (rAF is paused then)
function paint() {
  const el = $('pop');
  document.documentElement.className = resolveTheme();
  document.body.dataset.pv = pv;
  document.body.classList.toggle('settings-open', settingsOpen);
  document.querySelectorAll('.vsel button').forEach(b => b.classList.toggle('on', b.dataset.pv === pv));
  if (settingsOpen) { el.innerHTML = settingsHTML(); $('live').textContent = ''; return; }
  if (!live || live.error) { el.innerHTML = `<div class="err">배터리 정보를 읽을 수 없습니다${live && live.error ? ` (${esc(live.error)})` : ''}.</div>`; $('live').textContent = ''; return; }
  const s = live;
  const known = s.pct != null;
  const pct = known ? Math.round(s.pct) : 0;   // unknown → gauge shows 0 fill but label reads "?"
  const pctLbl = known ? `${pct}%` : '?';
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
        <div class="gstate">${stateOf(s)}</div> ${lpm ? `<div style="margin-top:6px">${lpm}</div>` : ''}
        <div class="gtime">${timeLbl} <b>${timeVal(s)}</b></div>
      </div>
      <div class="sec">상태</div>
      <div class="kv"><span>온도</span><b>${fmtTemp(s.tempC)}${s.smc ? ' <i class="ld"></i>' : ''}</b></div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      <div class="hbar"><i style="width:${s.healthPct != null ? Math.min(100, s.healthPct) : 0}%"></i></div>
      ${kvHTML(rowsHealth(s))}${tailHTML(s)}`;
  } else if (pv === 'cards') {
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="card"><div class="ct">${timeLbl}</div><div class="cv">${timeVal(s)}</div></div>
      <div class="cards2">
        <div class="card"><div class="ct">${s.systemW != null ? '시스템 전력' : '전력'}</div><div class="cv">${s.systemW != null ? s.systemW.toFixed(1) : (s.watts != null ? s.watts.toFixed(1) : '–')}<small>W</small></div></div>
        <div class="card"><div class="ct">온도</div><div class="cv">${fmtTemp(s.tempC).replace(/ °[CF]/,'')}<small>°${resolveUnit()==='f'?'F':'C'}</small></div></div>
        <div class="card"><div class="ct">건강</div><div class="cv">${s.healthPct != null ? Math.min(100, Math.round(s.healthPct)) : '–'}<small>%</small></div></div>
        <div class="card"><div class="ct">사이클</div><div class="cv">${s.cycles ?? '–'}</div></div>
      </div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      ${kvHTML([['만충 / 설계', (s.rawMax != null && s.design != null ? s.rawMax + ' / ' + s.design : '–') + ' mAh']])}
      ${tailHTML(s)}`;
  } else { // list (Stats-like dense)
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="sec">상태</div>
      ${kvHTML(statusRows(s))}
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="leg">${powerLegend(s)}</div>
      <div class="sec">배터리</div>
      ${kvHTML(rowsHealth(s))}
      ${tailHTML(s)}`;
  }
  setLive();
}

// footer: layout segmented + gear (settings)
$('foot').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.pv) { pv = b.dataset.pv; save('battPV', pv); settingsOpen = false; render(); }
  else if (b.id === 'reportBtn') openReport();
  else if (b.id === 'moreBtn') { moreOpen = !moreOpen; renderMenu(); }
});

// settings controls (delegated — #pop is rebuilt on every render)
const coerce = (k, v) => (k === 'info' || k === 'low_pct' || k === 'high_pct') ? +v : v;
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
  if (t.matches('select[data-k]')) applyDisplay(t.dataset.k, t.value);
  else if (t.matches('select[data-c]')) applyCfg(t.dataset.c, coerce(t.dataset.c, t.value));
});
$('pop').addEventListener('click', e => {
  const sm = e.target.closest('[data-sm]'); if (sm) { sparkMode = sm.dataset.sm; save('battSparkMode', sparkMode); render(); return; }
  const sh = e.target.closest('[data-sh]'); if (sh) { sparkH = +sh.dataset.sh; save('battSparkH', String(sparkH)); pullSpark(); return; }
  if (e.target.closest('[data-report]')) { openReport(); return; }   // spark preview → full 3D report
  const b = e.target.closest('.tgl'); if (!b) return;   // boolean toggle
  applyCfg(b.dataset.c, !cfg[b.dataset.c]);
});
// ── overflow (⋮) menu: settings + the app actions from the right-click tray menu ──
// 설정 opens the in-popover panel; record/quit POST to /api/action → a file the tray app consumes.
function renderMenu() {
  const m = $('moreBtn'); if (m) m.style.color = moreOpen ? 'var(--fg)' : '';
  const el = $('omenu');
  if (!moreOpen) { el.hidden = true; el.innerHTML = ''; return; }
  const recLabel = (live && live.recording) ? '⏸  배터리 기록 중지' : '▶  배터리 기록 시작';
  el.innerHTML =
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

render();
pull(); pullProcs(); pullDetail(); pullConfig(); pullSpark();
setInterval(() => { if (!document.hidden) pull(); }, 2000);
setInterval(() => { if (!document.hidden) pullProcs(); }, 5000);
setInterval(() => { if (!document.hidden) pullDetail(); }, 12000);
setInterval(() => { if (!document.hidden) pullSpark(); }, 30000);
