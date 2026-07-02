#!/usr/bin/env node
// One-shot: take a battery snapshot and append it to the shared samples log.
// Designed to be run repeatedly by launchd (StartInterval) — it exits
// immediately, so there is no resident daemon and ~0% idle CPU cost.
import { sample } from '../lib/battery.js';
import { appendSample } from '../lib/paths.js';

try {
  const s = sample();
  appendSample(s);   // recency-guarded + locked: won't double-write with the resident app / a racing writer
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
