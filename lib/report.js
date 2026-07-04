// Turns raw JSONL samples into discharge sessions + metrics for the 3D view.
import fs from 'node:fs';

export function readSamples(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip corrupt line */ }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const GAP = 15 * 60; // seconds: a gap longer than this (sleep/shutdown) splits a session

// A "session" = a continuous stretch of running on battery (ac === false).
export function buildSessions(samples) {
  const sessions = [];
  let cur = null;
  for (const s of samples) {
    const onBatt = s.ac === false;
    if (!onBatt) { if (cur) { sessions.push(cur); cur = null; } continue; }
    if (cur && s.t - cur[cur.length - 1].t > GAP) { sessions.push(cur); cur = null; }
    if (!cur) cur = [];
    cur.push(s);
  }
  if (cur) sessions.push(cur);
  return sessions.filter(ss => ss.length >= 2).map(summarize);
}

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, n = 2) => (v == null ? null : +v.toFixed(n));

// Time taken to cross each multiple-of-10 boundary on the way down.
// This is the headline "100→90 took N minutes" metric.
function tenPctSegments(ss) {
  const valid = ss.filter(s => s.pct != null);
  if (valid.length < 2) return [];
  const startLevel = Math.floor(valid[0].pct / 10) * 10;
  const reached = new Map();   // level -> time first crossed going down (deduped)
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1], b = valid[i];
    if (b.pct >= a.pct) continue;                 // only downward steps
    for (let level = startLevel; level >= 0; level -= 10) {
      if (reached.has(level)) continue;
      if (level <= a.pct && level >= b.pct) {     // includes the start boundary (level === a.pct)
        const frac = a.pct === b.pct ? 0 : (a.pct - level) / (a.pct - b.pct);
        reached.set(level, a.t + frac * (b.t - a.t));
      }
    }
  }
  const levels = [...reached.keys()].sort((x, y) => y - x);  // descending
  const segs = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i - 1] - levels[i] === 10) {
      const minutes = round((reached.get(levels[i]) - reached.get(levels[i - 1])) / 60, 1);
      if (minutes > 0) segs.push({ from: levels[i - 1], to: levels[i], minutes });  // drop 0-duration boundary artifacts
    }
  }
  return segs;
}

function summarize(ss) {
  const first = ss[0], last = ss[ss.length - 1];
  const durMin = (last.t - first.t) / 60;
  // null pct must NOT default to 0 — that would fabricate a discharge/charge
  const dropPct = (first.pct != null && last.pct != null) ? first.pct - last.pct : null;
  const watts = ss.map(s => s.watts).filter(v => v != null);
  const temps = ss.map(s => s.tempC).filter(v => v != null);
  const loads = ss.map(s => s.loadPct).filter(v => v != null);
  const ratePctPerHour = (durMin > 0 && dropPct != null) ? dropPct / (durMin / 60) : null;
  const minsPer10 = ratePctPerHour > 0 ? 600 / ratePctPerHour : null; // 10% / rate

  // worst CPU offender seen during the session
  let culprit = null, culpritCpu = -1;
  for (const s of ss) if (s.topProcCpu != null && s.topProcCpu > culpritCpu) { culpritCpu = s.topProcCpu; culprit = s.topProc; }

  return {
    start: first.t, end: last.t, startIso: first.iso, endIso: last.iso,
    durMin: round(durMin, 1),
    startPct: first.pct, endPct: last.pct, dropPct,
    ratePctPerHour: round(ratePctPerHour),
    minsPer10: round(minsPer10, 1),
    avgWatts: round(avg(watts)), maxWatts: watts.length ? round(Math.max(...watts)) : null,
    avgTempC: round(avg(temps), 1), maxTempC: temps.length ? round(Math.max(...temps), 1) : null,
    avgLoadPct: round(avg(loads), 1),
    healthPct: last.healthPct, rawMax: last.rawMax, cycles: last.cycles,
    culprit, culpritCpu: culpritCpu >= 0 ? culpritCpu : null,
    segments: tenPctSegments(ss),
    points: ss.map(s => ({ t: s.t, pct: s.pct, watts: s.watts, tempC: s.tempC, loadPct: s.loadPct,
      cap: (s.rawMax > 0 && s.rawCap != null) ? +(s.rawCap / s.rawMax * 100).toFixed(3) : null })),   // 정밀 mAh% for bucketStats
  };
}

// Continuous drawable runs: consecutive samples split only by real time gaps
// (sleep / shutdown). Keeps charge AND discharge in one line so the picture is
// honest — no "magic jump" back to 100%. Gaps become visual gaps, not vertical lines.
const RUN_GAP = 8 * 60; // seconds
function buildRuns(samples, dayOf) {
  const runs = [];
  let cur = null;
  for (const s of samples) {
    if (cur && s.t - cur.points[cur.points.length - 1].t > RUN_GAP) { runs.push(cur); cur = null; }
    if (!cur) cur = { points: [] };
    cur.points.push({ t: s.t, pct: s.pct, watts: s.watts, tempC: s.tempC, loadPct: s.loadPct, ac: s.ac, charging: s.charging, lowPower: s.lowPower,
      cap: (s.rawMax > 0 && s.rawCap != null) ? +(s.rawCap / s.rawMax * 100).toFixed(3) : null });   // fine mAh-based % (~0.02% res) for a smooth rate — pct is macOS's integer %
  }
  if (cur) runs.push(cur);
  return runs.filter(r => r.points.length >= 2).map(r => {
    const p = r.points, first = p[0], last = p[p.length - 1];
    const battFrac = p.filter(x => x.ac === false).length / p.length;
    const dpct = (first.pct != null && last.pct != null) ? last.pct - first.pct : null; // don't fabricate from null
    const kind = battFrac > 0.6 ? 'discharge'
      : dpct == null ? (battFrac > 0 ? 'discharge' : 'idle')
      : dpct > 1 ? 'charge' : dpct < -1 ? 'discharge' : 'idle';
    return { startT: first.t, endT: last.t, dayIndex: dayOf(first.t), kind, points: p };
  });
}

// Per-10% bucket average discharge rate. Answers: "while the battery is in the
// 90–100% band, how fast does it drain on average (%/min)?"
// It INTEGRATES every downward step into the band(s) it spans, so a session that
// started at 97% still contributes to the 90–100 band — we don't require a clean
// 100->90 crossing. band rate = total %-drained-in-band / total minutes-in-band.
function bucketStats(sessions) {
  const lvl = p => (p.cap != null ? p.cap : p.pct);   // 정밀 mAh%(있으면), 없으면 정수%
  const acc = Array.from({ length: 10 }, () => ({ drop: 0, min: 0 }));
  for (const s of sessions) {
    const pts = s.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const la = lvl(a), lb = lvl(b);
      if (la == null || lb == null || lb > la) continue;               // discharge/flat only
      const dtMin = (b.t - a.t) / 60, dPct = la - lb;
      if (!(dtMin > 0)) continue;                                       // skip duplicate/non-increasing timestamps
      if (dPct === 0) {
        // flat pair (mostly when falling back to integer %): dwell time is real discharge time.
        const k = Math.min(9, Math.max(0, Math.floor((100 - la) / 10)));  // band (lo, hi] containing level
        acc[k].min += dtMin;
        continue;
      }
      for (let k = 0; k < 10; k++) {
        const bandHi = 100 - 10 * k, bandLo = 90 - 10 * k;             // band (bandLo, bandHi]
        const top = Math.min(la, bandHi), bot = Math.max(lb, bandLo);
        if (top > bot) { acc[k].drop += top - bot; acc[k].min += dtMin * (top - bot) / dPct; }
      }
    }
  }
  return acc.map((a, k) => {
    const hi = 100 - 10 * k, lo = 90 - 10 * k;
    const pctPerMin = a.min > 0 ? a.drop / a.min : null;
    return {
      hi, lo, label: `${lo}–${hi}%`,
      pctPerMin: round(pctPerMin, 3),
      minPer10: pctPerMin ? round(10 / pctPerMin, 1) : null,
      minutes: round(a.min, 1),     // total observed minutes in this band (confidence)
    };
  });
}

// 마지막 충전(전원 연결) 이후: wall = 경과(잠자기 포함) · awake = 그중 시스템이 깨어 있던 시간.
// 샘플러는 깨어 있을 때만 ~60s마다 기록하므로, 큰 샘플 공백(>3분)은 잠자기로 보고 awake에서 제외한다.
function sinceLastCharge(samples) {
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  if (last.ac === true) return { onAC: true, unplugT: null, wallSec: 0, awakeSec: 0, asOfT: last.t };
  let k = samples.length - 1;
  while (k >= 0 && samples[k].ac === false) k--;      // k = last AC (plugged) sample, or -1 if none in history
  const startIdx = k + 1;                             // first on-battery sample of the current unplugged stretch
  const unplugT = samples[startIdx].t;
  const knownStart = k >= 0;                          // false ⇒ history begins already on battery (lower bound)
  const SLEEP_GAP = 180;
  let awakeSec = 0;
  for (let j = startIdx + 1; j < samples.length; j++) {
    const gap = samples[j].t - samples[j - 1].t;
    if (gap > 0 && gap <= SLEEP_GAP) awakeSec += gap;
  }
  return { onAC: false, unplugT, knownStart, wallSec: last.t - unplugT, awakeSec, asOfT: last.t };
}

export function buildReport(samples) {
  const t0 = samples.length ? samples[0].t : 0;
  const dayOf = t => Math.floor((t - t0) / 86400);

  const sessions = buildSessions(samples);
  for (const s of sessions) s.dayIndex = dayOf(s.start);

  // health timeline: last known health per day
  const perDay = new Map();
  for (const s of samples) {
    if (s.healthPct == null) continue;
    perDay.set(dayOf(s.t), { day: dayOf(s.t), t: s.t, iso: s.iso, healthPct: s.healthPct, rawMax: s.rawMax, cycles: s.cycles });
  }
  const health = [...perDay.values()].sort((a, b) => a.day - b.day);

  const latest = samples.length ? samples[samples.length - 1] : null;
  const spanDays = latest ? dayOf(latest.t) : 0;
  const runs = buildRuns(samples, dayOf);
  const early = sessions.filter(s => s.dayIndex <= spanDays / 3);
  const recent = sessions.filter(s => s.dayIndex >= spanDays * 2 / 3);
  return {
    sampleCount: samples.length,
    firstT: t0,
    lastT: latest ? latest.t : 0,
    spanDays,
    latest,
    sinceCharge: sinceLastCharge(samples),
    sessions,
    runs,
    health,
    buckets: bucketStats(sessions),
    bucketsEarly: bucketStats(early),
    bucketsRecent: bucketStats(recent),
  };
}
