// Live battery popover (Stats-parity). Loaded in a small Tauri window from the node server,
// so /api/live & /api/procs are same-origin. Three selectable layouts: list · cards · gauge.
const $ = id => document.getElementById(id);
// escape ALL server-derived strings — process names / serial / adapter name are attacker-influenceable
// and CSP is disabled in the popover window, so unescaped innerHTML would execute.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pv = (() => { try { return new URLSearchParams(location.search).get('pv') || localStorage.getItem('battPV') || 'list'; } catch { return 'list'; } })();
let theme = (() => { try { return new URLSearchParams(location.search).get('theme') || localStorage.getItem('battTheme') || 'dark'; } catch { return 'dark'; } })();
let unit = (() => { try { return localStorage.getItem('battUnit') || 'c'; } catch { return 'c'; } })();
let live = null, procs = [], detail = {}, lastLiveAt = 0;

const fmtTemp = c => c == null ? '–' : unit === 'f' ? `${(c * 9 / 5 + 32).toFixed(1)} °F` : `${c.toFixed(1)} °C`;
const fmtTime = min => min == null ? '–' : min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;
const stateOf = s => s.charging ? '충전 중' : s.full ? '완충' : s.ac ? 'AC 연결(유휴)' : '배터리 사용';
const stateIcon = s => s.charging ? '⚡' : s.ac ? '🔌' : '🔋';
const ago = ms => { const t = (Date.now() - ms) / 1000; return t < 3 ? '방금' : `${Math.round(t)}초 전`; };
const barColor = pct => pct <= 20 ? '#e5484d' : pct <= 40 ? '#e8850c' : 'var(--accent)';
// the whole popover tints to this: teal when healthy/charging, amber low, red critical
const stateColor = (s, pct) => s.charging ? 'var(--accent)' : barColor(pct);
const LIVE = `<span class="livet"><i class="ld"></i><span class="livew">LIVE</span></span>`;  // own literal, safe HTML

async function pull() {
  try {
    const r = await fetch('/api/live', { cache: 'no-store' });
    if (r.ok) { live = await r.json(); lastLiveAt = Date.now(); }
  } catch { /* keep last */ }
  render();
}
async function pullProcs() {
  try { const r = await fetch('/api/procs?n=6', { cache: 'no-store' }); if (r.ok) procs = await r.json(); } catch { /* keep */ }
  render();
}
async function pullDetail() {
  try { const r = await fetch('/api/detail', { cache: 'no-store' }); if (r.ok) detail = await r.json(); } catch { /* keep */ }
  render();
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
  if (s.systemW != null) r.push(['시스템', `${s.systemW.toFixed(1)} W&nbsp; ${LIVE}`]);
  if (s.ac) {
    const w = s.adapterW, v = detail.adapterVoltage;
    const a = (w != null && v) ? Math.round(w / v * 1000) : null;   // live adapter current ≈ W/V
    const p = [w != null ? `${w.toFixed(1)} W` : null, v != null ? `${v.toFixed(1)} V` : null, a != null ? `${a} mA` : null].filter(Boolean);
    if (p.length) r.push(['어댑터', p.join(' · ') + (w != null ? ' <i class="ld"></i>' : '')]);
  }
  const bp = s.powerW;
  const bw = bp == null ? null : Math.abs(bp) < 0.05 ? '0 W' : `${bp > 0 ? '+' : '−'}${Math.abs(bp).toFixed(2)} W`;
  const b = [bw, s.voltage != null ? `${s.voltage.toFixed(2)} V` : null, s.amperage != null ? `${s.amperage} mA` : null].filter(Boolean);
  r.push(['배터리', b.length ? b.join(' · ') : '–']);
  return r;
}
// 상태 rows shared by list/gauge: remaining time + live temperature.
function statusRows(s) {
  return [
    [s.charging ? '완충까지' : '남은 시간', fmtTime(s.timeRemain)],
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
function tailHTML(s) { return detailHTML(s) + procsHTML(); }

function procsHTML() {
  if (!procs.length) return '';
  const max = Math.max(...procs.map(p => p.power), 1);
  return `<div class="sec">배터리 소모 상위 (power)</div>` + procs.map(p =>
    `<div class="proc"><span class="pn" title="${esc(p.name)}">${esc(p.name)}</span>` +
    `<span class="pbarwrap"><i class="pbar" style="width:${Math.round((+p.power || 0) / max * 100)}%"></i></span>` +
    `<b>${(+p.power || 0).toFixed(1)}</b></div>`).join('');
}

function render() {
  const el = $('pop');
  document.documentElement.className = theme;
  document.body.dataset.pv = pv;
  document.querySelectorAll('.vsel button').forEach(b => b.classList.toggle('on', b.dataset.pv === pv));
  $('themeBtn').textContent = theme === 'light' ? '☀️' : '🌙';
  $('unitBtn').textContent = unit === 'f' ? '°F' : '°C';
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
          <text x="70" y="88" text-anchor="middle" class="gsub">${stateIcon(s)} ${s.watts != null ? s.watts.toFixed(1) + 'W' : ''}</text>
        </svg>
        <div class="gstate">${stateOf(s)}</div> ${lpm ? `<div style="margin-top:6px">${lpm}</div>` : ''}
        <div class="gtime">${timeLbl} <b>${fmtTime(s.timeRemain)}</b></div>
      </div>
      <div class="sec">상태</div>
      <div class="kv"><span>온도</span><b>${fmtTemp(s.tempC)}${s.smc ? ' <i class="ld"></i>' : ''}</b></div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
      <div class="sec">배터리</div>
      <div class="hbar"><i style="width:${s.healthPct != null ? Math.min(100, s.healthPct) : 0}%"></i></div>
      ${kvHTML(rowsHealth(s))}${tailHTML(s)}`;
  } else if (pv === 'cards') {
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="card"><div class="ct">${timeLbl}</div><div class="cv">${fmtTime(s.timeRemain)}</div></div>
      <div class="cards2">
        <div class="card"><div class="ct">${s.systemW != null ? '시스템 전력' : '전력'}</div><div class="cv">${s.systemW != null ? s.systemW.toFixed(1) : (s.watts != null ? s.watts.toFixed(1) : '–')}<small>W</small></div></div>
        <div class="card"><div class="ct">온도</div><div class="cv">${fmtTemp(s.tempC).replace(/ °[CF]/,'')}<small>°${unit==='f'?'F':'C'}</small></div></div>
        <div class="card"><div class="ct">건강</div><div class="cv">${s.healthPct != null ? Math.min(100, Math.round(s.healthPct)) : '–'}<small>%</small></div></div>
        <div class="card"><div class="ct">사이클</div><div class="cv">${s.cycles ?? '–'}</div></div>
      </div>
      <div class="sec">전원</div>
      ${kvHTML(rowsPower(s))}
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
      <div class="sec">배터리</div>
      ${kvHTML(rowsHealth(s))}
      ${tailHTML(s)}`;
  }
  $('live').textContent = `라이브 · ${ago(lastLiveAt)}`;
}

// controls
$('foot').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.pv) { pv = b.dataset.pv; try { localStorage.setItem('battPV', pv); } catch {} render(); }
  else if (b.id === 'themeBtn') { theme = theme === 'light' ? 'dark' : 'light'; try { localStorage.setItem('battTheme', theme); } catch {} render(); }
  else if (b.id === 'unitBtn') { unit = unit === 'c' ? 'f' : 'c'; try { localStorage.setItem('battUnit', unit); } catch {} render(); }
});

render();
pull(); pullProcs(); pullDetail();
setInterval(() => { if (!document.hidden) pull(); }, 2000);
setInterval(() => { if (!document.hidden) pullProcs(); }, 5000);
setInterval(() => { if (!document.hidden) pullDetail(); }, 12000);
setInterval(() => { if (live && !document.hidden) $('live').textContent = `라이브 · ${ago(lastLiveAt)}`; }, 1000);
