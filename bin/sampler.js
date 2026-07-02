#!/usr/bin/env node
// One-shot: take a battery snapshot and append it to the shared samples log.
// Designed to be run repeatedly by launchd (StartInterval) — it exits
// immediately, so there is no resident daemon and ~0% idle CPU cost.
import fs from 'node:fs';
import path from 'node:path';
import { sample } from '../lib/battery.js';
import { userDataDir } from '../lib/paths.js';

const dataDir = userDataDir();
const file = path.join(dataDir, 'samples.jsonl');

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const s = sample();
  fs.appendFileSync(file, JSON.stringify(s) + '\n');   // O_APPEND → atomic per line, safe if two writers race
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
