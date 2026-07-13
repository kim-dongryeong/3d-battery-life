import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newSession, acceptSample, coulombPoint, stopSession, summary,
  integrateSignedBalance, GAP_SEC,
} from '../lib/measure.js';

const mk = (seq, monoMs, adapterW, systemW) =>
  ({ seq, monoMs, sampleAtMs: 1_783_941_168_000 + monoMs, adapterW, systemW });

const start = () => newSession({ rawCapMah: 3714, voltageMv: 12432, pct: 84.2, adapter: null }, 1_783_941_168);

test('first sample is a baseline, not an area', () => {
  const st = start();
  assert.equal(acceptSample(st, mk(1, 0, 30, 10)), 'baseline');
  assert.equal(st.acc.adapterWs, 0);
  assert.equal(st.acc.samples, 0);
});

test('duplicate seq is not integrated twice', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  assert.equal(acceptSample(st, mk(2, 2000, 30, 10)), 'integrated');
  const after = st.acc.adapterWs;
  assert.equal(acceptSample(st, mk(2, 2000, 30, 10)), 'dup');
  assert.equal(st.acc.adapterWs, after);
});

test('trapezoid: constant 30W over 10s = 300 Ws', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  acceptSample(st, mk(2, 10_000, 30, 10));
  assert.equal(st.acc.adapterWs, 300);
  assert.equal(st.acc.systemWs, 100);
  assert.equal(st.acc.batChgWs, 200);       // balance +20W × 10s
  assert.equal(st.acc.batDisWs, 0);
});

test('dt beyond GAP_SEC opens a gap and integrates nothing', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  assert.equal(acceptSample(st, mk(2, (GAP_SEC + 100) * 1000, 30, 10)), 'gap');
  assert.equal(st.acc.adapterWs, 0);
  assert.equal(st.acc.gaps.length, 1);
  assert.equal(st.acc.gaps[0].why, 'missing-samples');
  // next good pair integrates again and closes the gap
  assert.equal(acceptSample(st, mk(3, (GAP_SEC + 102) * 1000, 30, 10)), 'integrated');
  assert.equal(st.acc.gaps[0].open, undefined);
});

test('consecutive gap ticks extend ONE gap object (coalesced)', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  acceptSample(st, mk(2, 20_000, 30, 10));   // gap
  acceptSample(st, mk(3, 40_000, 30, 10));   // still gapped (dt=20s)
  assert.equal(st.acc.gaps.length, 1);
});

test('publisher restart (monoMs/seq regression) → new baseline + gap, never negative dt', () => {
  const st = start();
  acceptSample(st, mk(100, 500_000, 30, 10));
  acceptSample(st, mk(101, 502_000, 30, 10));
  const area = st.acc.adapterWs;
  assert.equal(acceptSample(st, mk(1, 2000, 30, 10)), 'baseline');
  assert.equal(st.acc.adapterWs, area);                       // nothing integrated across the restart
  assert.equal(st.acc.gaps.at(-1).why, 'publisher-restart');
  assert.equal(acceptSample(st, mk(2, 4000, 30, 10)), 'integrated');  // resumes from the new baseline
});

test('zero-crossing splits charge and discharge exactly', () => {
  const acc = { batChgWs: 0, batDisWs: 0 };
  integrateSignedBalance(acc, 10, -10, 10);   // crosses zero at t=5s
  assert.equal(acc.batChgWs, 25);             // triangle 10W→0 over 5s
  assert.equal(acc.batDisWs, 25);             // triangle 0→−10W over 5s
});

test('unplug mid-session: balance flips sign, both buckets accumulate', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));         // +20W charging
  acceptSample(st, mk(2, 10_000, 30, 10));
  acceptSample(st, mk(3, 20_000, 0, 10));     // unplugged → −10W avg over the crossing interval
  assert.ok(st.acc.batChgWs > 200);           // 200 from first interval + crossing part
  assert.ok(st.acc.batDisWs > 0);
});

test('coulomb: per-interval average voltage, signed + split accumulation', () => {
  const st = start();
  coulombPoint(st, { t: 0, mah: 3000, mv: 12000 });
  coulombPoint(st, { t: 60, mah: 3100, mv: 12400 });   // +100mAh @ avg 12.2V = +1.22Wh
  coulombPoint(st, { t: 120, mah: 3050, mv: 12000 });  // −50mAh @ avg 12.2V = −0.61Wh
  assert.ok(Math.abs(st.coulomb.whSigned - 0.61) < 1e-9);
  assert.ok(Math.abs(st.coulomb.chgWh - 1.22) < 1e-9);
  assert.ok(Math.abs(st.coulomb.disWh - 0.61) < 1e-9);
});

test('summary: differencePct hidden when |gaugeDeltaWh| < 0.5', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  acceptSample(st, mk(2, 2000, 30, 10));
  coulombPoint(st, { t: 0, mah: 3000, mv: 12000 });
  coulombPoint(st, { t: 60, mah: 3005, mv: 12000 });   // +0.06Wh — tiny denominator
  stopSession(st, 1_783_941_468);
  const s = summary(st);
  assert.equal(s.differencePct, null);
  assert.ok(Number.isFinite(s.differenceWh));
  assert.equal(s.durSec, 300);
});

test('summary: averages use effective (integrated) time, not wall time', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 20, 10));
  acceptSample(st, mk(2, 10_000, 20, 10));
  stopSession(st, st.startedAt + 1000);       // wall 1000s, effective 10s
  const s = summary(st);
  assert.equal(s.avgSystemW, 10);
  assert.equal(s.avgAdapterW, 20);
  assert.equal(s.effectiveSec, 10);
});

test('restart round-trip: state survives JSON serialization', () => {
  const st = start();
  acceptSample(st, mk(1, 0, 30, 10));
  acceptSample(st, mk(2, 2000, 30, 10));
  const revived = JSON.parse(JSON.stringify(st));
  // after a server restart the publisher sample is stale → treat as restart/baseline path
  assert.equal(acceptSample(revived, mk(1, 1000, 30, 10)), 'baseline');
  assert.equal(acceptSample(revived, mk(2, 3000, 30, 10)), 'integrated');
  assert.ok(revived.acc.adapterWs > st.acc.adapterWs);
});
