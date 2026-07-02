// 더미2 — "showcase" demo built to PERSUADE: it makes the tool's core value pop.
//   Phase 1 (month 0-1, honeymoon): new battery, light load (~5W) → slow discharge.
//   Phase 2 (month 1-6, adoption):  load climbs 5→15W → discharge ~3x faster,
//                                    BUT battery still healthy → Wh/% barely moves
//                                    ⇒ "the speed-up is LOAD, not aging."
//   Phase 3 (month 6-12, aging):    health 96%→78%, cycles climb → Wh/% clearly drops
//                                    ⇒ "now it's real battery aging."
// Plus weekday/weekend rhythm (heatmap striping) and per-band intensity (3D relief).
// Physics kept honest (same as the live tool): %-drop integrated from watts & capacity;
// Wh/% = fullWh/100 falls ONLY with aging (load cancels) — that's what sells it.
//
// Deterministic (seeded PRNG) so it can be generated ON DEMAND instead of shipped:
// exports generateDemo2Lines(); only writes a file when run directly (dev).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let seed = 7770001;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const chance = p => rnd() < p;
const rng = (a, b) => a + rnd() * (b - a);
const noise = a => (rnd() - 0.5) * 2 * a;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const DESIGN = 4629, NOMINAL_V = 11.4;
const DAY = 86400 * 1000, HOUR = 3600 * 1000, STEP = 300;       // 5-min cadence
const refEnd = Date.parse('2026-06-29T09:00:00Z');
const startMs = refEnd - 365 * DAY;

const healthAt = d => 1 - 0.22 * Math.pow(smooth(d, 20, 365), 1.35);  // 100% honeymoon → ~78%, accelerating
const rawMaxAt = d => Math.round(DESIGN * healthAt(d));
const cyclesAt = d => Math.round(d * 1.1);
const baseWattsAt = d => 5 + 10 * smooth(d, 20, 170);                 // ~5W → ~15W over months 1-6, then sustained
const bandFactor = lvl => {                                          // per-level usage intensity → 3D relief
  let f = 1;
  if (lvl > 90) f *= 0.82;                  // just unplugged, settling
  else if (lvl >= 30 && lvl <= 80) f *= 1.18; // active working range (faster)
  if (lvl < 18) f *= 0.5;                    // low-power mode throttles near empty (slower)
  return f;
};
const PROCS = ['Xcode', 'Final Cut Pro', 'Google Chrome', 'Docker', 'Slack', 'Figma', 'zoom.us'];

const lines = [];
function emit(state, t, pct, watts, ctx) {
  const charging = state === 'CHARGE', full = state === 'ACIDLE', ac = charging || full;
  const voltage = +(11.0 + pct / 100 * 1.2 + (ac ? 0.35 : 0) + noise(0.03)).toFixed(3);
  let amperage, powerW, w = watts;
  if (state === 'BATT') { amperage = -Math.round(watts / voltage * 1000); powerW = -watts; }
  else if (charging) { amperage = Math.round(watts / voltage * 1000); powerW = watts; }
  else { w = +rng(0.2, 1.0).toFixed(2); amperage = Math.round(Math.abs(noise(35))); powerW = 0; }
  const loadPct = +clamp((state === 'BATT' ? watts : charging ? watts * 0.4 : 2) / 28 * 100 + noise(5), 1, 100).toFixed(1);
  lines.push(JSON.stringify({
    t: Math.round(t / 1000), iso: new Date(t).toISOString(),
    pct: Math.round(pct), rawCap: Math.round(ctx.rawMax * pct / 100), rawMax: ctx.rawMax, design: DESIGN, healthPct: ctx.health,
    voltage, amperage, powerW: +powerW.toFixed(3), watts: +w.toFixed(3),
    cycles: ctx.cycles, tempC: +(26 + w * 0.6 + (charging ? 3 : 0) + noise(0.8)).toFixed(2),
    ac, charging, full,
    timeRemain: state === 'BATT' ? Math.round(pct / 100 * ctx.fullWh / Math.max(0.5, watts) * 60) : null,
    loadPct, load1: +(loadPct / 100 * 10).toFixed(2), ncpu: 10,
    topProc: state === 'BATT' && watts > 12 ? PROCS[Math.floor(rnd() * PROCS.length)] : ac ? 'WindowServer' : 'Google Chrome',
    topProcCpu: loadPct,
  }));
}

function chooseEpisode(hour, plugged, pct, mobility) {
  if (pct < 7 && !plugged) return { state: 'CHARGE', plugged: true, durMin: rng(40, 120) };
  const middaySleep = hour >= 12.5 && hour < 13.5 ? 0.3 : 0;
  if (chance(0.05 + middaySleep)) return { state: 'SLEEP', plugged, durMin: rng(20, 75) };
  let plug = plugged;
  if (!plugged && pct < 25) plug = chance(0.8);
  else if (!plugged) plug = chance(0.2 + 0.3 * (1 - mobility));
  else if (pct >= 100) plug = !chance(0.5 * mobility);
  else plug = !chance(0.25 * mobility);
  if (plug) return { state: pct >= 99.5 ? 'ACIDLE' : 'CHARGE', plugged: true, durMin: rng(20, 110) };
  return { state: 'BATT', plugged: false, durMin: rng(25, 150) };
}

export function generateDemo2Lines() {
  seed = 7770001; lines.length = 0;                 // reset → deterministic re-run
  for (let day = 0; day <= 365; day += 2) {
    const dow = new Date(startMs + day * DAY).getDay();              // 0=Sun..6=Sat
    const weekend = dow === 0 || dow === 6;
    const useMul = weekend ? 0.55 : 1.0;
    const rawMax = rawMaxAt(day);
    const ctx = { rawMax, fullWh: rawMax * NOMINAL_V / 1000, cycles: cyclesAt(day), health: +(rawMax / DESIGN * 100).toFixed(1) };
    const dayBase = baseWattsAt(day) * useMul * rng(0.9, 1.1);
    const mobility = weekend ? rng(0.15, 0.4) : rng(0.45, 0.85);     // weekdays unplugged/mobile more
    let pct = chance(0.85) ? rng(97, 100) : rng(60, 88);
    let plugged = chance(0.25);
    let t = startMs + day * DAY + 7 * HOUR + rng(0, 1 * HOUR);
    const dayEnd = startMs + day * DAY + 23 * HOUR + rng(0, 1.2 * HOUR);

    while (t < dayEnd) {
      const hour = (t - (startMs + day * DAY)) / HOUR;
      const ep = chooseEpisode(hour, plugged, pct, mobility);
      plugged = ep.plugged;
      const steps = Math.max(1, Math.round(ep.durMin * 60 / STEP));
      for (let s = 0; s < steps && t < dayEnd; s++) {
        if (ep.state === 'SLEEP') {
          pct = plugged ? Math.min(100, pct + 0.45 * (STEP / 60)) : Math.max(0, pct - 0.012 * (STEP / 60));
        } else if (ep.state === 'BATT') {
          const watts = Math.max(2, dayBase * bandFactor(pct) + 1.5 * Math.sin(t / 7e5) + (chance(0.04) ? rng(6, 14) : 0) + noise(0.8));
          pct = Math.max(0, pct - watts * (STEP / 3600) / ctx.fullWh * 100);
          emit('BATT', t, pct, watts, ctx);
        } else if (ep.state === 'CHARGE') {
          const rate = pct < 80 ? 0.6 : pct < 95 ? 0.35 : 0.12;
          pct = Math.min(100, pct + rate * (STEP / 60));
          emit(pct >= 100 ? 'ACIDLE' : 'CHARGE', t, pct, rate / 100 * ctx.fullWh * 60, ctx);
        } else { pct = 100; emit('ACIDLE', t, pct, 0, ctx); }
        t += STEP * 1000;
      }
    }
  }
  return lines;
}

// run directly (node scripts/gen-demo2.js) → write the file for dev
if ((process.argv[1] || '').endsWith('gen-demo2.js')) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo2.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const l = generateDemo2Lines();
  fs.writeFileSync(out, l.join('\n') + '\n');
  console.log(`demo2 written: ${l.length} samples -> ${out}`);
}
