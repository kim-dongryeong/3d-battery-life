// Measurement session ("전력 분석 세션") — pure accumulator, no I/O. The server owns the timers,
// file reads and persistence; this module owns every calculation so tests can drive it directly.
//
// Design (per the reviewed plan note "전력량 측정 세션(멀티미터 모드) 구현 계획", Claude 재검토 §최종 확정):
//  - samples are deduped by the publisher's `seq`; dt comes from the MONOTONIC `monoMs` delta
//    (wall clocks step across NTP/timezone changes; sampleAtMs is kept for display only)
//  - trapezoidal integration; the battery balance (adapterW − systemW) splits at zero crossings
//    so charge and discharge accumulate separately
//  - a monoMs/seq regression means the publisher (tray app) restarted → new baseline + gap
//  - battery energy is reported as TWO co-equal estimates: the rail balance integral (balanceWh)
//    and the gauge delta (gaugeDeltaWh). Their difference is shown without naming a cause.
//  - gaps are a state machine: one open gap gets extended, closed by the next accepted sample.

export const GAP_SEC = 15;          // dt beyond this is a gap, not an integration interval
export const PERSIST_MS = 30_000;   // server snapshots state this often (crash safety)
export const PCT_MIN_WH = 0.5;      // |gaugeDeltaWh| below this → hide differencePct (denominator blows up)

export function newSession(start, nowSec) {
  return {
    v: 1,
    state: 'running',
    startedAt: nowSec,
    stoppedAt: null,
    start,                                  // { rawCapMah, voltageMv, pct, adapter } — informational
    last: null,                             // last accepted publisher sample (seq/monoMs/adapterW/systemW/sampleAtMs)
    acc: {
      adapterWs: 0, systemWs: 0, batChgWs: 0, batDisWs: 0,
      peakSystemW: 0, peakAdapterW: 0,
      effectiveSec: 0,                      // integrated time (excludes gaps)
      samples: 0,
      gaps: [],                             // [{ from, to, why, open? }] — wall-clock seconds, for display
    },
    coulomb: {
      whSigned: 0, chgWh: 0, disWh: 0,      // chg/dis are per-point-delta approximations ("근사")
      trace: [],                            // [{ t, mah, mv }] one point / ~60s
    },
    nextPersistAt: 0,                       // ms timestamp the server compares against
  };
}

function openOrExtendGap(acc, fromSec, toSec, why) {
  const g = acc.gaps[acc.gaps.length - 1];
  if (g && g.open) { g.to = toSec; return; }
  acc.gaps.push({ from: fromSec, to: toSec, why, open: true });
}

function closeGap(acc, toSec) {
  const g = acc.gaps[acc.gaps.length - 1];
  if (g && g.open) { g.to = Math.max(g.to, toSec); delete g.open; }
}

// Integrate the signed balance b(t) (linear between b0→b1 over dtSec), splitting the area at the
// zero crossing so charge (b>0) and discharge (b<0) land in separate buckets.
export function integrateSignedBalance(acc, b0, b1, dtSec) {
  const put = (area) => { if (area >= 0) acc.batChgWs += area; else acc.batDisWs += -area; };
  if (b0 === 0 && b1 === 0) return;
  if (b0 >= 0 === b1 >= 0) { put((b0 + b1) / 2 * dtSec); return; }
  const tc = dtSec * Math.abs(b0) / (Math.abs(b0) + Math.abs(b1));   // time of the zero crossing
  put(b0 / 2 * tc);
  put(b1 / 2 * (dtSec - tc));
}

// Feed one publisher sample. Returns 'integrated' | 'baseline' | 'dup' | 'gap' | 'invalid'.
export function acceptSample(st, cur) {
  if (st.state !== 'running') return 'invalid';
  if (!cur || !Number.isFinite(cur.seq) || !Number.isFinite(cur.monoMs)
      || !Number.isFinite(cur.adapterW) || !Number.isFinite(cur.systemW)) return 'invalid';
  const prev = st.last;
  if (prev && cur.seq === prev.seq) return 'dup';
  // publisher restart: seq or monoMs went backwards → the old baseline is meaningless
  if (prev && (cur.seq < prev.seq || cur.monoMs <= prev.monoMs)) {
    openOrExtendGap(st.acc, prev.sampleAtMs / 1000, cur.sampleAtMs / 1000, 'publisher-restart');
    st.last = cur;
    return 'baseline';
  }
  st.last = cur;
  if (!prev) return 'baseline';                       // first unique sample: baseline only, no area
  const dtSec = (cur.monoMs - prev.monoMs) / 1000;
  if (dtSec > GAP_SEC) {
    openOrExtendGap(st.acc, prev.sampleAtMs / 1000, cur.sampleAtMs / 1000, 'missing-samples');
    return 'gap';
  }
  closeGap(st.acc, prev.sampleAtMs / 1000);
  const trap = (a, b) => (a + b) / 2 * dtSec;
  st.acc.adapterWs += trap(prev.adapterW, cur.adapterW);
  st.acc.systemWs += trap(prev.systemW, cur.systemW);
  integrateSignedBalance(st.acc, prev.adapterW - prev.systemW, cur.adapterW - cur.systemW, dtSec);
  st.acc.peakSystemW = Math.max(st.acc.peakSystemW, cur.systemW);
  st.acc.peakAdapterW = Math.max(st.acc.peakAdapterW, cur.adapterW);
  st.acc.effectiveSec += dtSec;
  st.acc.samples++;
  return 'integrated';
}

// Feed one gauge point (~60s cadence). mAh→Wh uses the interval's average pack voltage;
// per-point deltas approximate the charge/discharge split (sign flips inside 60s are lost — "근사").
export function coulombPoint(st, p) {
  if (!p || !Number.isFinite(p.mah) || !Number.isFinite(p.mv)) return;
  const prev = st.coulomb.trace[st.coulomb.trace.length - 1];
  st.coulomb.trace.push({ t: p.t, mah: p.mah, mv: p.mv });
  if (!prev) return;
  const wh = (p.mah - prev.mah) * ((p.mv + prev.mv) / 2) / 1e6;
  st.coulomb.whSigned += wh;
  if (wh >= 0) st.coulomb.chgWh += wh; else st.coulomb.disWh += -wh;
}

export function stopSession(st, nowSec) {
  st.state = 'stopped';
  st.stoppedAt = nowSec;
  closeGap(st.acc, nowSec);
}

export function summary(st) {
  const a = st.acc, c = st.coulomb;
  const wh = (ws) => +(ws / 3600).toFixed(3);
  const durSec = (st.stoppedAt ?? Math.floor(Date.now() / 1000)) - st.startedAt;
  const gapSec = Math.round(a.gaps.reduce((s, g) => s + Math.max(0, g.to - g.from), 0));
  const balanceWh = wh(a.batChgWs - a.batDisWs);           // net rail-balance estimate (signed)
  const gaugeDeltaWh = +c.whSigned.toFixed(3);             // net gauge estimate (signed)
  const differenceWh = +(balanceWh - gaugeDeltaWh).toFixed(3);
  const differencePct = Math.abs(gaugeDeltaWh) >= PCT_MIN_WH
    ? +((differenceWh / Math.abs(gaugeDeltaWh)) * 100).toFixed(1) : null;   // hidden when denominator ~0
  return {
    state: st.state, startedAt: st.startedAt, stoppedAt: st.stoppedAt,
    durSec, gapSec, effectiveSec: Math.round(a.effectiveSec), samples: a.samples,
    adapterWh: wh(a.adapterWs), systemWh: wh(a.systemWs),
    balanceChgWh: wh(a.batChgWs), balanceDisWh: wh(a.batDisWs), balanceWh,
    gaugeDeltaWh, gaugeChgWh: +c.chgWh.toFixed(3), gaugeDisWh: +c.disWh.toFixed(3),
    gaugeDeltaMah: c.trace.length >= 2 ? c.trace[c.trace.length - 1].mah - c.trace[0].mah : null,
    differenceWh, differencePct,
    avgSystemW: a.effectiveSec > 0 ? +(a.systemWs / a.effectiveSec).toFixed(2) : null,
    avgAdapterW: a.effectiveSec > 0 ? +(a.adapterWs / a.effectiveSec).toFixed(2) : null,
    peakSystemW: +a.peakSystemW.toFixed(2), peakAdapterW: +a.peakAdapterW.toFixed(2),
    gaps: a.gaps.map(g => ({ from: g.from, to: g.to, why: g.why })),
    start: st.start,
  };
}
