// Reads a single battery snapshot from macOS (ioreg + os load).
// No sudo, no special permissions required — only ioreg/ps and Node's os module.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

function ioregRaw() {
  return execFileSync('ioreg', ['-rn', 'AppleSmartBattery', '-w0'], { encoding: 'utf8' });
}

// NOTE: require spaces around '=' (\s+, not \s*). Top-level ioreg keys are
// printed as `"Key" = value`; the nested BatteryData blob uses `"Key"=value`
// (no spaces). Using \s* would match the blob's Voltage/CycleCount/etc FIRST.
function num(text, key) {
  const m = text.match(new RegExp('"' + key + '"\\s+=\\s+(-?\\d+)'));
  return m ? Number(m[1]) : null;
}

// Amperage / InstantAmperage are reported as UNSIGNED 64-bit. A discharging
// battery shows up as a huge number (e.g. 18446744073709551268) which is the
// two's-complement encoding of a negative value. Reinterpret as signed.
function signed64(text, key) {
  const m = text.match(new RegExp('"' + key + '"\\s+=\\s+(\\d+)'));
  if (!m) return null;
  let v = BigInt(m[1]);
  if (v >= (1n << 63n)) v -= (1n << 64n);
  return Number(v); // mA, negative = discharging
}

function bool(text, key) {
  const m = text.match(new RegExp('"' + key + '"\\s+=\\s+(Yes|No)'));
  return m ? m[1] === 'Yes' : null;
}

// Cheapest reliable "what's eating the battery" signal: top process by CPU.
function topProcess() {
  try {
    const out = execFileSync('ps', ['-A', '-c', '-r', '-o', '%cpu=', '-o', 'comm='], { encoding: 'utf8' });
    const line = out.split('\n').find(l => l.trim());
    if (line) {
      const m = line.trim().match(/^([\d.]+)\s+(.+)$/);
      if (m) return { name: m[2], cpu: Number(m[1]) };
    }
  } catch { /* non-fatal */ }
  return { name: null, cpu: null };
}

export function sample(now = Date.now()) {
  const io = ioregRaw();
  // guard against empty/garbage ioreg output (e.g. no battery) instead of
  // silently writing an all-null record every minute
  if (!io || !io.includes('AppleSmartBattery') || !/"Voltage"\s+=/.test(io)) {
    throw new Error('unexpected ioreg output — battery not found?');
  }

  const voltageMv = num(io, 'Voltage');
  const voltage = voltageMv != null ? voltageMv / 1000 : null;               // V
  const amperage = signed64(io, 'Amperage') ?? signed64(io, 'InstantAmperage'); // mA, <0 discharge
  const powerW = (voltage != null && amperage != null) ? voltage * amperage / 1000 : null; // signed W

  const rawMax = num(io, 'AppleRawMaxCapacity');   // mAh at full charge now
  const design = num(io, 'DesignCapacity');        // mAh from factory
  const tempRaw = num(io, 'Temperature');          // centi-°C

  const load = os.loadavg();
  const ncpu = os.cpus().length;
  const tp = topProcess();

  return {
    t: Math.round(now / 1000),
    iso: new Date(now).toISOString(),
    pct: num(io, 'CurrentCapacity'),                 // displayed %
    rawCap: num(io, 'AppleRawCurrentCapacity'),      // mAh now
    rawMax,
    design,
    healthPct: (rawMax && design) ? +(rawMax / design * 100).toFixed(1) : null,
    voltage: voltage != null ? +voltage.toFixed(3) : null,
    amperage,                                        // mA signed
    powerW: powerW != null ? +powerW.toFixed(3) : null,   // signed: <0 discharging
    watts: powerW != null ? +Math.abs(powerW).toFixed(3) : null, // magnitude of power flow
    cycles: num(io, 'CycleCount'),
    tempC: tempRaw != null ? +(tempRaw / 100).toFixed(2) : null,
    ac: bool(io, 'ExternalConnected'),               // true = plugged in
    charging: bool(io, 'IsCharging'),
    full: bool(io, 'FullyCharged'),
    timeRemain: num(io, 'TimeRemaining'),            // minutes, OS estimate
    loadPct: ncpu ? +((load[0] / ncpu) * 100).toFixed(1) : null, // 1-min load / cores
    load1: +load[0].toFixed(2),
    ncpu,
    topProc: tp.name,
    topProcCpu: tp.cpu,
  };
}
