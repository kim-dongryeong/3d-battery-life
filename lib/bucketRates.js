// Per-10%-band battery DISCHARGE RATE (signed %/min) + load-normalized energy (Wh per %),
// aggregated over a chosen time PERIOD (day / week / month).
//
// Design + code reviewed adversarially with Codex + agy (see "AI build-loop protocol").
// Core method = CLIPPED INTERVAL ACCUMULATION (not "segment rates then average"):
//   clip each adjacent in-span sample pair at every 1% level + local-midnight boundary,
//   accumulate drop, time AND energy (W·s) into the (day, 10%-band) atom; then re-pool atoms
//   by the chosen period. Ratio-of-sums (V4a) is segmentation-invariant.
//
// Rate versions (diagnostics): V4a pooled (default), V4b trim-edge, V4c 1%-subbin,
//   V0 raw-mean, V1 full-only, V5 per-occupancy OLS.
// Load-normalized aging metric: Wh-per-% = Σenergy / Σ%drop  (robust; not the noisy %/min÷W).

const round = (v, n = 4) => (v == null || !isFinite(v) ? null : +v.toFixed(n));
const dayKey = t => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nextLocalMidnight = t => { const d = new Date(t * 1000); d.setHours(24, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const bandHigh = lvl => { let h = Math.ceil(lvl / 10) * 10; if (h - lvl >= 10) h -= 10; return Math.min(100, Math.max(10, h)); };
const interpT = (a, b, L) => a.t + (a.lvl - L) / (a.lvl - b.lvl) * (b.t - a.t);
const interpLvl = (a, b, t) => a.lvl + (t - a.t) / (b.t - a.t) * (b.lvl - a.lvl);

// map a 'YYYY-MM-DD' day to its period key + start epoch (local)
function periodInfo(dayStr, period) {
  const [Y, M, D] = dayStr.split('-').map(Number);
  if (period === 'month') { const d = new Date(Y, M - 1, 1); return { key: `${Y}-${String(M).padStart(2, '0')}`, start: Math.floor(d.getTime() / 1000) }; }
  if (period === 'week') {
    const d = new Date(Y, M - 1, D), dow = (d.getDay() + 6) % 7, mon = new Date(Y, M - 1, D - dow);
    return { key: `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`, start: Math.floor(mon.getTime() / 1000) };
  }
  return { key: dayStr, start: Math.floor(new Date(Y, M - 1, D).getTime() / 1000) };
}

export function autoGLin(samples) {
  const dts = [];
  for (let i = 1; i < samples.length; i++) { const dt = samples[i].t - samples[i - 1].t; if (dt > 0 && dt < 3600) dts.push(dt); }
  dts.sort((a, b) => a - b);
  return Math.max(120, Math.round(2.2 * (dts.length ? dts[dts.length >> 1] : 60)));
}

// Battery power MAGNITUDE (W) for the chosen measurement method, used for energy (Wh/%) + avgW.
// balance = |PDTR−PSTR| (recorded s.watts) · ioreg = |ioreg V×I| · hybrid = 방전:PPBR, 충전:balance.
// (bucketRates only spans discharge, but the helper stays regime-correct.) Legacy rows lacking a
// method-specific field fall back to s.watts — which on old data already IS the ioreg V×I magnitude.
function battWMag(s, method) {
  if (method === 'ioreg') return s.ioregW != null ? Math.abs(s.ioregW) : (s.watts != null ? Math.abs(s.watts) : null);
  if (method === 'hybrid') {
    const charging = s.powerW != null ? s.powerW > 0.05 : !!s.charging;
    if (!charging && s.ppbrW != null) return Math.abs(s.ppbrW);
  }
  return s.watts != null ? Math.abs(s.watts) : null;
}

// ---- valid discharge spans (carry watts + temp for energy / context) ----
export function buildSpans(samples, opt = {}) {
  const gLin = opt.gLin ?? autoGLin(samples);
  const level = opt.level ?? 'pct';
  const method = opt.method === 'ioreg' || opt.method === 'hybrid' ? opt.method : 'balance';
  const riseTol = opt.riseTol ?? (level === 'rawcap' ? 0.3 : 1);
  const maxRate = opt.maxRate ?? 5;
  const lvlOf = s => level === 'rawcap' ? (s.rawMax > 0 ? s.rawCap / s.rawMax * 100 : null) : s.pct;
  const spans = [];
  let cur = null;
  const close = () => { if (cur && cur.length >= 2) spans.push(cur); cur = null; };
  for (const s of samples) {
    const lvl0 = lvlOf(s);
    if (!(s.ac === false) || lvl0 == null || !Number.isFinite(lvl0)) { close(); continue; }
    let lvl = Math.max(0, Math.min(100, lvl0));
    if (cur) {
      const last = cur[cur.length - 1], dt = s.t - last.t;
      if (dt <= 0 || dt > gLin) close();
      else if (lvl > last.lvl) { if (lvl - last.lvl <= riseTol) lvl = last.lvl; else close(); }
      else if ((last.lvl - lvl) / (dt / 60) > maxRate) close();
    }
    if (!cur) cur = [];
    cur.push({ t: s.t, lvl, w: battWMag(s, method), tc: s.tempC ?? null, raw: s });
  }
  close();
  return spans;
}

// ---- clipped atomic intervals (1% + day boundaries), with energy (W·s) ----
export function atomicIntervals(spans) {
  const atoms = [];
  let spanId = 0;
  for (const span of spans) {
    spanId++;
    const start0 = atoms.length;
    for (let i = 1; i < span.length; i++) {
      const a = span[i - 1], b = span[i];
      // missing watts must NOT count as 0 W — that silently deflates Wh/% and avgW.
      // Gate energy like temperature is gated (hasW ↔ hasT); ws/time only pooled over hasW atoms.
      const hasW = a.w != null && b.w != null;
      const avgW = hasW ? (a.w + b.w) / 2 : null;
      const avgTc = (a.tc != null && b.tc != null) ? (a.tc + b.tc) / 2 : (a.tc ?? b.tc);
      const cuts = [];
      const m = nextLocalMidnight(a.t); if (m > a.t && m < b.t) cuts.push({ t: m, lvl: interpLvl(a, b, m) });
      if (b.lvl < a.lvl) for (let L = Math.floor(a.lvl); L > b.lvl; L--) if (L < a.lvl && L > b.lvl) cuts.push({ t: interpT(a, b, L), lvl: L });
      cuts.sort((x, y) => x.t - y.t);
      let pt = { t: a.t, lvl: a.lvl };
      for (const nx of [...cuts, { t: b.t, lvl: b.lvl }]) {
        const time = nx.t - pt.t, drop = pt.lvl - nx.lvl;
        if (time > 0) {
          const mid = (pt.lvl + nx.lvl) / 2 || 0.001;
          atoms.push({ spanId, day: dayKey(pt.t), band: bandHigh(mid), subbin: Math.min(100, Math.max(1, Math.ceil(mid))), drop, time, ws: hasW ? avgW * time : 0, hasW, ts: avgTc != null ? avgTc * time : 0, hasT: avgTc != null });
        }
        pt = nx;
      }
    }
    if (atoms.length > start0) { atoms[start0]._spanFirst = true; atoms[atoms.length - 1]._spanLast = true; }
  }
  return atoms;
}

function episodesOf(atoms) {
  const eps = []; let cur = null;
  for (const at of atoms) {
    if (!cur || cur.spanId !== at.spanId || cur.day !== at.day || cur.band !== at.band) {
      cur = { spanId: at.spanId, day: at.day, band: at.band, drop: 0, time: 0, ws: 0, isFirst: !!at._spanFirst, isLast: false };
      eps.push(cur);
    }
    cur.drop += at.drop; cur.time += at.time; cur.ws += at.ws;
    if (at._spanLast) cur.isLast = true;
  }
  for (const e of eps) e.coverage = e.drop / 10;
  return eps;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const poolRate = items => { let d = 0, t = 0; for (const a of items) { d += a.drop; t += a.time; } return t > 0 ? -60 * d / t : null; };
function olsSlope(points) {
  const n = points.length; if (n < 2) return null;
  let st = 0, sl = 0; for (const p of points) { st += p.t; sl += p.lvl; }
  const mt = st / n, ml = sl / n; let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.lvl - ml); den += (p.t - mt) ** 2; }
  return den > 0 ? num / den * 60 : null;
}

const VKEYS = ['v0_rawMean', 'v1_fullOnly', 'v4a_pooled', 'v4b_trimEdge', 'v4c_subbin', 'v5_ols'];

export function analyzeRates(samples, opt = {}) {
  const period = opt.period === 'week' || opt.period === 'month' ? opt.period : 'day';
  const gate = { minDur: opt.minDur ?? 600, minDrop: opt.minDrop ?? 2, minIntervals: opt.minIntervals ?? 3 };
  const gLin = opt.gLin ?? autoGLin(samples);
  opt = { ...opt, gLin };
  const spans = buildSpans(samples, opt);
  const atoms = atomicIntervals(spans);
  const episodes = episodesOf(atoms);

  const pkOfDay = new Map();   // dayStr -> {key,start}
  const pk = day => { let v = pkOfDay.get(day); if (!v) { v = periodInfo(day, period); pkOfDay.set(day, v); } return v; };

  // raw in-band points per (periodKey|band|spanId) for V5
  const rawByK = new Map();
  let sid = 0;
  for (const span of spans) {
    sid++;
    for (const s of span) {
      const k = `${pk(dayKey(s.t)).key}|${bandHigh(s.lvl)}`;
      let g = rawByK.get(k); if (!g) { g = new Map(); rawByK.set(k, g); }
      let arr = g.get(sid); if (!arr) { arr = []; g.set(sid, arr); }
      arr.push({ t: s.t, lvl: s.lvl });
    }
  }
  const v5slope = groups => {
    if (!groups) return null;
    let wsum = 0, sw = 0;
    for (const pts of groups.values()) { const sl = olsSlope(pts); if (sl == null) continue; const dur = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0; if (dur <= 0) continue; wsum += sl * dur; sw += dur; }
    return sw > 0 ? wsum / sw : null;
  };

  const cellKey = x => `${pk(x.day).key}|${x.band}`;
  const aByK = new Map(), eByK = new Map();
  for (const a of atoms) (aByK.get(cellKey(a)) || aByK.set(cellKey(a), []).get(cellKey(a))).push(a);
  for (const e of episodes) (eByK.get(cellKey(e)) || eByK.set(cellKey(e), []).get(cellKey(e))).push(e);

  const perCell = [];
  for (const [k, as] of aByK) {
    const [pkey, bandStr] = k.split('|'); const band = +bandStr;
    const eps = eByK.get(k) || [];
    const sumDrop = as.reduce((x, a) => x + a.drop, 0), sumTime = as.reduce((x, a) => x + a.time, 0);
    const sumWs = as.reduce((x, a) => x + (a.hasW ? a.ws : 0), 0), sumDropW = as.reduce((x, a) => x + (a.hasW ? a.drop : 0), 0), sumTimeW = as.reduce((x, a) => x + (a.hasW ? a.time : 0), 0);
    const sumTs = as.reduce((x, a) => x + (a.hasT ? a.ts : 0), 0), sumTtime = as.reduce((x, a) => x + (a.hasT ? a.time : 0), 0);
    const bySub = new Map();
    for (const a of as) (bySub.get(a.subbin) || bySub.set(a.subbin, []).get(a.subbin)).push(a);
    const subRates = [...bySub.values()].map(poolRate).filter(v => v != null);
    const versions = {
      v0_rawMean: round(mean(eps.map(e => -60 * e.drop / e.time).filter(isFinite))),
      v1_fullOnly: round(mean(eps.filter(e => e.coverage >= 0.95).map(e => -60 * e.drop / e.time))),
      v4a_pooled: round(poolRate(as)),
      v4b_trimEdge: round(poolRate(eps.filter(e => !((e.isFirst || e.isLast) && e.coverage < 0.95)))),
      v4c_subbin: round(mean(subRates)),
      v5_ols: round(v5slope(rawByK.get(k))),
    };
    perCell.push({
      period: pkey, periodStart: pk(as[0].day).start, band, label: `(${band - 10},${band}]`,
      versions, rate: versions.v4a_pooled,
      whPerPct: sumDropW > 0 ? round(sumWs / 3600 / sumDropW, 4) : null,   // Wh per 1% drained, over watts-known atoms only
      avgW: sumTimeW > 0 ? round(sumWs / sumTimeW, 2) : null,
      avgTempC: sumTtime > 0 ? round(sumTs / sumTtime, 1) : null,
      minutes: round(sumTime / 60, 1), dropPct: round(sumDrop, 2), nAtoms: as.length, nEpisodes: eps.length,
      sufficient: sumTime >= gate.minDur && sumDrop >= gate.minDrop && as.length >= gate.minIntervals,
    });
  }
  perCell.sort((p, q) => p.periodStart - q.periodStart || q.band - p.band);

  // period timeline with health/cycles (median/max over that period's samples)
  const perMap = new Map();
  for (const s of samples) {
    const info = pk(dayKey(s.t)); let v = perMap.get(info.key);
    if (!v) { v = { key: info.key, start: info.start, health: [], cycles: 0 }; perMap.set(info.key, v); }
    if (s.healthPct != null) v.health.push(s.healthPct);
    if (s.cycles != null) v.cycles = Math.max(v.cycles, s.cycles);
  }
  const periods = [...perMap.values()].sort((a, b) => a.start - b.start)
    .map(p => ({ key: p.key, start: p.start, healthPct: round(median(p.health), 1), cycles: p.cycles }));

  // per-band aggregate across periods (typical period median + pooled)
  const byBand = [];
  for (let high = 100; high >= 10; high -= 10) {
    const cells = perCell.filter(c => c.band === high && c.sufficient);
    const allAtoms = atoms.filter(a => a.band === high);
    const versions = {}; for (const kk of VKEYS) versions[kk] = round(median(cells.map(c => c.versions[kk]).filter(x => x != null)));
    byBand.push({
      band: high, label: `(${high - 10},${high}]`, versions,
      typicalDay_median: versions.v4a_pooled, typicalMinute_pooled: round(poolRate(allAtoms)),
      whPerPct_median: round(median(cells.map(c => c.whPerPct).filter(x => x != null))),
      avgW_median: round(median(cells.map(c => c.avgW).filter(x => x != null))),
      avgTempC_median: round(median(cells.map(c => c.avgTempC).filter(x => x != null)), 1),
      nDays: cells.length, totalMin: round(allAtoms.reduce((x, a) => x + a.time, 0) / 60, 1),
    });
  }

  const method = opt.method === 'ioreg' || opt.method === 'hybrid' ? opt.method : 'balance';
  return { opt: { level: opt.level ?? 'pct', period, method, gLin, gate }, spans: spans.length, atoms: atoms.length, perCell, periods, byBand };
}
