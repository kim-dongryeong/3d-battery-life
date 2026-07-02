// Live battery popover (Stats-parity). Loaded in a small Tauri window from the node server,
// so /api/live & /api/procs are same-origin. Three selectable layouts: list · cards · gauge.
const $ = id => document.getElementById(id);
// escape ALL server-derived strings — process names / serial / adapter name are attacker-influenceable
// and CSP is disabled in the popover window, so unescaped innerHTML would execute.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pv = (() => { try { return new URLSearchParams(location.search).get('pv') || localStorage.getItem('battPV') || 'list'; } catch { return 'list'; } })();
let theme = (() => { try { return localStorage.getItem('battTheme') || 'dark'; } catch { return 'dark'; } })();
let unit = (() => { try { return localStorage.getItem('battUnit') || 'c'; } catch { return 'c'; } })();
let live = null, procs = [], detail = {}, lastLiveAt = 0;

const fmtTemp = c => c == null ? '–' : unit === 'f' ? `${(c * 9 / 5 + 32).toFixed(1)} °F` : `${c.toFixed(1)} °C`;
const fmtTime = min => min == null ? '–' : min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;
const stateOf = s => s.charging ? '충전 중' : s.full ? '완충' : s.ac ? 'AC 연결(유휴)' : '배터리 사용';
const stateIcon = s => s.charging ? '⚡' : s.ac ? '🔌' : '🔋';
const ago = ms => { const t = (Date.now() - ms) / 1000; return t < 3 ? '방금' : `${Math.round(t)}초 전`; };
const barColor = pct => pct <= 20 ? '#e5484d' : pct <= 40 ? '#e8850c' : 'var(--accent)';

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
  const w = 46, fill = Math.max(3, pct / 100 * (w - 6));
  const glyph = s.charging ? '⚡' : '';
  return `<svg viewBox="0 0 60 28" width="60" height="28" aria-hidden="true">
    <rect x="1" y="4" width="${w}" height="20" rx="4" fill="none" stroke="var(--fg)" stroke-width="2" opacity=".8"/>
    <rect x="${w + 2}" y="10" width="4" height="8" rx="1.5" fill="var(--fg)" opacity=".8"/>
    <rect x="4" y="7" width="${fill}" height="14" rx="2" fill="${barColor(pct)}"/>
    ${glyph ? `<text x="${1 + w / 2}" y="19" text-anchor="middle" font-size="13" fill="#0a0c12">${glyph}</text>` : ''}
  </svg>`;
}

function rowsCore(s) {
  const amp = s.amperage != null ? `${s.amperage} mA` : '–';
  const r = [['전력', `${s.watts != null ? s.watts.toFixed(2) : '–'} W`]];
  if (s.systemW != null) r.push(['시스템 전력', `${s.systemW.toFixed(1)} W · 🔴라이브`]);   // SMC (moves every 2s)
  r.push(['전류', amp], ['전압', `${s.voltage != null ? s.voltage.toFixed(2) : '–'} V`], ['온도', fmtTemp(s.tempC) + (s.smc ? ' · 🔴' : '')]);
  return r;
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
  const timeLbl = s.charging ? '완충까지' : '남은 시간';
  const lpm = s.lowPower ? `<span class="lpm">🟡 저전력 모드</span>` : '';

  if (pv === 'gauge') {
    const R = 52, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
    el.innerHTML =
      `<div class="gauge">
        <svg viewBox="0 0 140 140" width="150" height="150">
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--line)" stroke-width="12"/>
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="${barColor(pct)}" stroke-width="12"
            stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}" transform="rotate(-90 70 70)"/>
          <text x="70" y="66" text-anchor="middle" class="gpct">${pctLbl}</text>
          <text x="70" y="88" text-anchor="middle" class="gsub">${stateIcon(s)} ${s.watts != null ? s.watts.toFixed(1) + 'W' : ''}</text>
        </svg>
        <div class="gstate">${stateOf(s)} ${lpm}</div>
        <div class="gtime">${timeLbl} <b>${fmtTime(s.timeRemain)}</b></div>
      </div>
      <div class="grid2">${kvHTML(rowsCore(s))}</div>
      <div class="hbar"><i style="width:${s.healthPct != null ? Math.min(100, s.healthPct) : 0}%"></i></div>
      <div class="grid2">${kvHTML(rowsHealth(s))}</div>${tailHTML(s)}`;
  } else if (pv === 'cards') {
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="card"><div class="ct">${timeLbl}</div><div class="cv">${fmtTime(s.timeRemain)}</div></div>
      <div class="cards2">
        <div class="card"><div class="ct">전력</div><div class="cv">${s.watts != null ? s.watts.toFixed(1) : '–'}<small>W</small></div></div>
        <div class="card"><div class="ct">온도</div><div class="cv">${fmtTemp(s.tempC).replace(/ °[CF]/,'')}<small>°${unit==='f'?'F':'C'}</small></div></div>
        <div class="card"><div class="ct">건강</div><div class="cv">${s.healthPct != null ? Math.min(100, Math.round(s.healthPct)) : '–'}<small>%</small></div></div>
        <div class="card"><div class="ct">사이클</div><div class="cv">${s.cycles ?? '–'}</div></div>
      </div>
      <div class="grid2">${kvHTML([['전류', s.amperage != null ? s.amperage + ' mA' : '–'], ['전압', (s.voltage != null ? s.voltage.toFixed(2) : '–') + ' V'], ['만충/설계', (s.rawMax != null ? s.rawMax + '/' + s.design : '–') + ' mAh']])}</div>
      ${tailHTML(s)}`;
  } else { // list (Stats-like dense)
    el.innerHTML =
      `<div class="hero">${batterySVG(pct, s)}<div><div class="big">${pctLbl}</div>
        <div class="st">${stateOf(s)} ${lpm}</div></div></div>
      <div class="sec">상태</div>
      <div class="kv"><span>${timeLbl}</span><b>${fmtTime(s.timeRemain)}</b></div>
      ${kvHTML(rowsCore(s))}
      <div class="sec">배터리</div>
      ${kvHTML(rowsHealth(s))}
      ${tailHTML(s)}`;
  }
  $('live').textContent = `🟢 라이브 · ${ago(lastLiveAt)}`;
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
setInterval(() => { if (live && !document.hidden) $('live').textContent = `🟢 라이브 · ${ago(lastLiveAt)}`; }, 1000);
