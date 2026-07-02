// Reads a single battery snapshot from macOS (ioreg + os load).
// No sudo, no special permissions required — only ioreg/ps and Node's os module.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

// timeout on every subprocess so a hung ioreg/pmset/ps can't freeze a sync caller (e.g. /api/live)
const EXEC = { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024 };
function ioregRaw() {
  return execFileSync('ioreg', ['-rn', 'AppleSmartBattery', '-w0'], EXEC);
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

// Low Power Mode is a powerd setting, not in the battery ioreg node. `pmset -g` prints the
// LIVE state as `lowpowermode <0|1>` (unlike `pmset -g custom`, which lists the configured
// value per power source). Returns true/false, or null if unreadable (older macOS).
function lowPowerMode() {
  try {
    const out = execFileSync('pmset', ['-g'], EXEC);
    const m = out.match(/^\s*lowpowermode\s+(\d+)/m);
    return m ? m[1] === '1' : null;
  } catch { return null; }
}

// Cheapest reliable "what's eating the battery" signal: top process by CPU.
function topProcess() {
  try {
    const out = execFileSync('ps', ['-A', '-c', '-r', '-o', '%cpu=', '-o', 'comm='], EXEC);
    const line = out.split('\n').find(l => l.trim());
    if (line) {
      const m = line.trim().match(/^([\d.]+)\s+(.+)$/);
      if (m) return { name: m[2], cpu: Number(m[1]) };
    }
  } catch { /* non-fatal */ }
  return { name: null, cpu: null };
}

// Slow-changing extras (condition, serial, design cycles, adapter, optimized-charging "on hold").
// Read on demand (popover open), NOT into every 60s sample — a serial string ×40k records is waste.
export function detail() {
  const io = ioregRaw();
  const dict = key => (io.match(new RegExp('"' + key + '"\\s+=\\s+\\{([^}]*)\\}')) || [])[1] || '';
  const inDict = (blk, k) => (blk.match(new RegExp('"' + k + '"=("?)([^",}]*)\\1')) || [])[2];
  const rawMax = num(io, 'AppleRawMaxCapacity') ?? num(io, 'MaxCapacity') ?? num(io, 'NominalChargeCapacity');
  const design = num(io, 'DesignCapacity');
  const healthPct = (rawMax && design) ? rawMax / design * 100 : null;
  const pfs = num(io, 'PermanentFailureStatus');
  // Apple's "Battery Condition": Normal, or Service Recommended when a permanent failure is flagged
  // or capacity has degraded a lot. (Apple's exact threshold is private; ~80% is the common cutoff.)
  const condition = (pfs && pfs !== 0) ? '서비스 권장'
    : (healthPct != null && healthPct < 80) ? '교체 권장(용량 저하)'
    : '정상';
  const ad = dict('AdapterDetails');
  const cd = dict('ChargerData');
  const notCharging = +inDict(cd, 'NotChargingReason') || 0;
  // NotChargingReason is also non-zero simply when on battery — "on hold" (optimized charging)
  // is specifically: plugged in, NOT charging, below 100%, with a reason set.
  const acNow = bool(io, 'ExternalConnected'), chgNow = bool(io, 'IsCharging');
  return {
    serial: (io.match(/"Serial"\s+=\s+"([^"]+)"/) || [])[1] || null,
    condition,
    permanentFailure: pfs,
    designCycleCount: num(io, 'DesignCycleCount9C') ?? num(io, 'DesignCycleCount70'),
    adapterWatts: inDict(ad, 'Watts') ? +inDict(ad, 'Watts') : null,
    adapterName: inDict(ad, 'Name') || inDict(ad, 'Description') || null,
    adapterVoltage: inDict(ad, 'AdapterVoltage') ? +inDict(ad, 'AdapterVoltage') / 1000 : null,
    onHold: !!(acNow && !chgNow && notCharging !== 0), // optimized charging (plugged, held below 100%)
  };
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

  // Capacity keys differ by arch: Apple Silicon exposes AppleRaw{Current,Max}Capacity (mAh) and
  // CurrentCapacity as a 0–100 %. Intel Macs often lack the AppleRaw* keys and report MaxCapacity /
  // CurrentCapacity in mAh instead (with the % derived). Fall back so health/mAh work on both.
  const rawMax = num(io, 'AppleRawMaxCapacity') ?? num(io, 'MaxCapacity') ?? num(io, 'NominalChargeCapacity');
  const rawCap = num(io, 'AppleRawCurrentCapacity') ?? num(io, 'CurrentCapacity');
  const design = num(io, 'DesignCapacity');        // mAh from factory
  const tempRaw = num(io, 'Temperature') ?? num(io, 'VirtualTemperature'); // centi-°C

  // % : CurrentCapacity is 0–100 on Apple Silicon; on Intel it may be mAh → derive from rawCap/rawMax.
  let pct = num(io, 'CurrentCapacity');
  if (pct != null && pct > 100 && rawMax) pct = Math.round((rawCap / rawMax) * 100);

  const load = os.loadavg();
  const ncpu = os.cpus().length;
  const tp = topProcess();

  return {
    t: Math.round(now / 1000),
    iso: new Date(now).toISOString(),
    pct,                                             // displayed %  (0–100, arch-normalized)
    rawCap,                                          // mAh now
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
    lowPower: lowPowerMode(),                         // Low Power Mode on/off (null if unreadable)
    timeRemain: num(io, 'TimeRemaining'),            // minutes, OS estimate
    loadPct: ncpu ? +((load[0] / ncpu) * 100).toFixed(1) : null, // 1-min load / cores
    load1: +load[0].toFixed(2),
    ncpu,
    topProc: tp.name,
    topProcCpu: tp.cpu,
  };
}
