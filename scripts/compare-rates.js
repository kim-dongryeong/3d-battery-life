// Runs the bucket-rate versions on demo + real data and prints how the versions diverge.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSamples } from '../lib/report.js';
import { analyzeRates } from '../lib/bucketRates.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || 'demo';
const level = process.argv[3] || 'pct';
const period = process.argv[4] || 'day';
const file = path.join(dir, '..', 'data', `${src === 'real' ? 'samples' : 'demo'}.jsonl`);

const r = analyzeRates(readSamples(file), { level, period });
console.log(`\nsource=${src}  level=${level}  period=${period}  spans=${r.spans}  atoms=${r.atoms}  cells=${r.perCell.length}`);

const fmt = x => (x == null ? '    -   ' : (x >= 0 ? ' ' : '') + x.toFixed(3)).padStart(8);
console.log(`\n=== per-band: typical-period median (V4a) · pooled · Wh/% ===`);
console.log('band          typMed    pooled     Wh/%    periods');
for (const b of r.byBand) {
  console.log(`${b.label.padEnd(11)} ${fmt(b.typicalDay_median)} ${fmt(b.typicalMinute_pooled)} ${fmt(b.whPerPct_median)} ${String(b.nDays).padStart(7)}`);
}

const ok = r.perCell.filter(p => p.sufficient);
console.log(`\n=== version divergence across ${ok.length} sufficient (period,band) cells ===`);
const vers = ['v0_rawMean', 'v1_fullOnly', 'v4a_pooled', 'v4b_trimEdge', 'v4c_subbin', 'v5_ols'];
for (const v of vers) {
  const vals = ok.map(p => p.versions[v]).filter(x => x != null);
  const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  console.log(`  ${v.padEnd(14)} n=${String(vals.length).padStart(3)}  mean=${m == null ? '-' : m.toFixed(4) + ' %/min'}`);
}
const spread = v => { const ds = ok.filter(p => p.versions.v4a_pooled != null && p.versions[v] != null).map(p => Math.abs(p.versions[v] - p.versions.v4a_pooled)); return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null; };
console.log(`\n  mean |version − V4a| per cell:`);
for (const v of vers) if (v !== 'v4a_pooled') console.log(`    ${v.padEnd(14)} ${spread(v) == null ? '-' : spread(v).toFixed(4)} %/min`);

console.log(`\n=== sample of 6 (period,band) cells ===`);
for (const p of ok.slice(0, 6)) {
  console.log(`  ${p.period} ${p.label.padEnd(9)} drop=${p.dropPct}% over ${p.minutes}min  rate=${p.rate} Wh/%=${p.whPerPct} avgW=${p.avgW}`);
}
console.log('');
