// Generates a REALISTIC fake year of data so the 3D view is rich immediately.
//
// Unlike a naive "drain 100->0 then teleport back to 100" model, this simulates
// a real life rhythm with a small state machine:
//   SLEEP   — laptop asleep: NO samples (launchd doesn't run) => visible gaps
//   BATT    — awake on battery: discharging
//   CHARGE  — awake plugged in, battery rising
//   ACIDLE  — awake plugged in, already full (~100%)
// Plug/unplug, wake/sleep and load all vary randomly across each day, and the
// long-term trends are preserved so the new->month->year story still holds:
//   - battery ages   (full capacity 100% -> ~82% over the year)
//   - load grows     (apps pile up: ~5W -> ~11W over the first month) + spikes
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, '..', 'data', 'demo.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });

let seed = 20260629;                                  // deterministic PRNG
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const chance = p => rnd() < p;
const rng = (a, b) => a + rnd() * (b - a);
const noise = a => (rnd() - 0.5) * 2 * a;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const DESIGN = 4629, NOMINAL_V = 11.4;
const DAY = 86400 * 1000, HOUR = 3600 * 1000, STEP = 180; // emit every 180s (demo cadence)
const refEnd = Date.parse('2026-06-29T09:00:00Z');
const startMs = refEnd - 365 * DAY;

const rawMaxAt = day => Math.round(DESIGN * (1 - 0.18 * day / 365));   // 100% -> 82%
const cyclesAt = day => Math.round(day * 0.9);
const baseWattsAt = day => 5 + 6 * Math.min(day, 30) / 30;            // apps pile up first month

const lines = [];

function emit(state, t, pct, watts, ctx) {
  const charging = state === 'CHARGE';
  const full = state === 'ACIDLE';
  const ac = charging || full;
  const voltage = +(11.0 + pct / 100 * 1.2 + (ac ? 0.35 : 0) + noise(0.04)).toFixed(3);
  let amperage, powerW, w = watts;
  if (state === 'BATT') { amperage = -Math.round(watts / voltage * 1000); powerW = -watts; }
  else if (charging) { amperage = Math.round(watts / voltage * 1000); powerW = watts; }
  else { w = +rng(0.2, 1.1).toFixed(2); amperage = Math.round(Math.abs(noise(40))); powerW = 0; } // ACIDLE: trickle only, never negative
  const loadPct = +clamp((state === 'BATT' ? watts : charging ? watts * 0.4 : 2) / 28 * 100 + noise(6), 1, 100).toFixed(1);
  lines.push(JSON.stringify({
    t: Math.round(t / 1000), iso: new Date(t).toISOString(),
    pct: Math.round(pct), rawCap: Math.round(ctx.rawMax * pct / 100), rawMax: ctx.rawMax, design: DESIGN, healthPct: ctx.health,
    voltage, amperage, powerW: +powerW.toFixed(3), watts: +w.toFixed(3),
    cycles: ctx.cycles, tempC: +(26 + w * 0.6 + (charging ? 3 : 0) + noise(1)).toFixed(2),
    ac, charging, full,
    timeRemain: state === 'BATT' ? Math.round(pct / 100 * ctx.fullWh / Math.max(0.5, watts) * 60) : null,
    loadPct, load1: +(loadPct / 100 * 10).toFixed(2), ncpu: 10,
    topProc: state === 'BATT' && watts > 14 ? 'ffmpeg' : ac ? 'WindowServer' : watts > 9 ? 'Google Chrome' : 'WindowServer',
    topProcCpu: loadPct,
  }));
}

// pick the next episode given the hour-of-day (0..24), plug state, and charge level
function chooseEpisode(hour, plugged, pct, mobility) {
  if (pct < 7 && !plugged) return { state: 'CHARGE', plugged: true, durMin: rng(40, 120) }; // emergency plug-in
  const middaySleep = hour >= 12.5 && hour < 13.5 ? 0.3 : 0;
  if (chance(0.05 + middaySleep)) return { state: 'SLEEP', plugged, durMin: rng(20, 75) }; // meeting/lunch nap
  let plug = plugged;
  if (!plugged && pct < 25) plug = chance(0.8);
  else if (!plugged) plug = chance(0.2 + 0.3 * (1 - mobility));
  else if (pct >= 100) plug = !chance(0.5 * mobility);     // when full, maybe unplug & go mobile
  else plug = !chance(0.25 * mobility);                    // while charging, mostly stay plugged
  if (plug) return { state: pct >= 99.5 ? 'ACIDLE' : 'CHARGE', plugged: true, durMin: rng(20, 110) };
  return { state: 'BATT', plugged: false, durMin: rng(25, 150) };
}

for (let day = 0; day <= 365; day += 5) {
  const rawMax = rawMaxAt(day);
  const ctx = { rawMax, fullWh: rawMax * NOMINAL_V / 1000, cycles: cyclesAt(day), health: +(rawMax / DESIGN * 100).toFixed(1) };
  const dayBase = baseWattsAt(day) * rng(0.8, 1.4);       // some days heavier than others
  const mobility = rng(0.2, 0.95);                        // how often used away from charger
  let pct = chance(0.8) ? rng(96, 100) : rng(55, 85);     // usually charged overnight
  let plugged = chance(0.3);
  let t = startMs + day * DAY + 6 * HOUR + rng(0, 1.5 * HOUR);     // wake ~06:00-07:30
  const dayEnd = startMs + day * DAY + 23 * HOUR + rng(0, 1.5 * HOUR); // sleep ~23:00-00:30

  while (t < dayEnd) {
    const hour = (t - (startMs + day * DAY)) / HOUR;
    const ep = chooseEpisode(hour, plugged, pct, mobility);
    plugged = ep.plugged;
    const steps = Math.max(1, Math.round(ep.durMin * 60 / STEP));
    for (let s = 0; s < steps && t < dayEnd; s++) {
      if (ep.state === 'SLEEP') {
        pct = plugged ? Math.min(100, pct + 0.4 * (STEP / 60)) : Math.max(0, pct - 0.015 * (STEP / 60)); // drift, no sample
      } else if (ep.state === 'BATT') {
        const watts = Math.max(2.5, dayBase + 2 * Math.sin(t / 6e5) + (chance(0.06) ? rng(8, 18) : 0) + noise(1.2));
        pct = Math.max(0, pct - watts * (STEP / 3600) / ctx.fullWh * 100);
        emit('BATT', t, pct, watts, ctx);
      } else if (ep.state === 'CHARGE') {
        const rate = pct < 80 ? 0.55 : pct < 95 ? 0.35 : 0.12;       // %/min, tapers near full
        const chargeW = rate / 100 * ctx.fullWh * 60;                 // power into battery
        pct = Math.min(100, pct + rate * (STEP / 60));
        emit(pct >= 100 ? 'ACIDLE' : 'CHARGE', t, pct, chargeW, ctx);
      } else { // ACIDLE
        pct = 100;
        emit('ACIDLE', t, pct, 0, ctx);
      }
      t += STEP * 1000;
    }
  }
}

fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`demo written: ${lines.length} samples across ~${Math.round(365 / 5)} days -> ${out}`);
