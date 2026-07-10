#!/usr/bin/env node
// One-shot: take a battery snapshot and append it to the shared samples log.
// Designed to be run repeatedly by launchd (StartInterval) — it exits
// immediately, so there is no resident daemon and ~0% idle CPU cost.
import { sample, applyLiveSMC } from '../lib/battery.js';
import { appendSample } from '../lib/paths.js';
import { upsertAdapter } from '../lib/adapters.js';

try {
  const s = sample();
  applyLiveSMC(s, true);   // RECORD the 1-minute AVERAGE power (∫W dt / 60s), not a single instant → energy-correct
  const wrote = appendSample(s);   // recency-guarded + locked: won't double-write with the resident app / a racing writer
  if (wrote && s.ac) upsertAdapter(s);   // 충전기 사전 누적 (기록된 분만 — chargeMin 이중 집계 방지)
  if (process.stdout.isTTY) {
    console.log(
      `${s.iso}  ${s.pct}%  ${s.watts}W  ${s.tempC}°C  ` +
      `health ${s.healthPct}%  cyc ${s.cycles}  ${s.ac ? 'AC' : 'BATT'}` +
      (s.topProc ? `  top:${s.topProc}(${s.topProcCpu}%)` : '')
    );
  }
} catch (e) {
  console.error('sampler error:', e.message);
  process.exit(1);
}
