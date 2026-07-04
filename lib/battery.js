// Reads a single battery snapshot from macOS (ioreg + os load).
// No sudo, no special permissions required — only ioreg/ps and Node's os module.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { userDataDir } from './paths.js';

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
  // handle quoted values that contain commas ("Apple, Inc. USB-C") and unquoted numbers
  const inDict = (blk, k) => { const m = blk.match(new RegExp('"' + k + '"=(?:"([^"]*)"|([^,}]*))')); return m ? (m[1] ?? m[2]) : undefined; };
  const rawMax = num(io, 'AppleRawMaxCapacity') ?? num(io, 'MaxCapacity') ?? num(io, 'NominalChargeCapacity');
  const design = num(io, 'DesignCapacity');
  const healthPct = (rawMax && design) ? rawMax / design * 100 : null;
  const pfs = num(io, 'PermanentFailureStatus');
  // Apple's "Battery Condition": Normal, or Service Recommended when a permanent failure is flagged
  // or capacity has degraded a lot. (Apple's exact threshold is private; ~80% is the common cutoff.)
  const condition = (pfs && pfs !== 0) ? '서비스 권장'
    : (healthPct != null && healthPct < 80) ? '교체 권장(용량 저하)'
    : '정상';
  // Manufacture date: the Smart-Battery format packs it in 16 bits ((year-1980)<<9 | month<<5 | day).
  // Newer Apple Silicon reports a large opaque value instead (and the serial is randomized) →
  // manufacture date is unavailable, exactly as coconutBattery notes for new devices.
  let manufactureDate = null, ageDays = null;
  const mdRaw = +((io.match(/"ManufactureDate"=(\d+)/) || [])[1]);
  if (mdRaw > 0 && mdRaw <= 0xffff) {
    const day = mdRaw & 0x1f, month = (mdRaw >> 5) & 0xf, year = 1980 + (mdRaw >> 9);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      manufactureDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      ageDays = Math.max(0, Math.round((Date.now() - Date.parse(manufactureDate)) / 86400000));
    }
  }
  const ad = dict('AdapterDetails');
  const cd = dict('ChargerData');
  const notCharging = +inDict(cd, 'NotChargingReason') || 0;
  // NotChargingReason is also non-zero simply when on battery, or at 100% — "on hold" (optimized
  // charging) is specifically: plugged in, explicitly NOT charging, below 100%, with a reason set.
  const acNow = bool(io, 'ExternalConnected'), chgNow = bool(io, 'IsCharging'), fullNow = bool(io, 'FullyCharged');
  return {
    serial: (io.match(/"Serial"\s+=\s+"([^"]+)"/) || [])[1] || null,
    condition,
    permanentFailure: pfs,
    designCycleCount: num(io, 'DesignCycleCount9C') ?? num(io, 'DesignCycleCount70'),
    manufactureDate,        // "YYYY-MM-DD" or null (unavailable on new randomized-serial Macs)
    ageDays,
    adapterWatts: inDict(ad, 'Watts') ? +inDict(ad, 'Watts') : null,
    adapterName: inDict(ad, 'Name') || inDict(ad, 'Description') || null,
    adapterVoltage: inDict(ad, 'AdapterVoltage') ? +inDict(ad, 'AdapterVoltage') / 1000 : null,
    onHold: acNow === true && chgNow === false && fullNow !== true && notCharging !== 0, // optimized charging hold
  };
}

// Merge the running app's live SMC bridge (systemW/adapterW + real-time battery power) into a sample
// when fresh. This is how the launchd sampler comes to RECORD system/adapter power — SMC is only
// readable by the Rust tray app, which publishes live-smc.json every ~2s. No app running → ioreg only.
export function applyLiveSMC(s) {
  try {
    const smc = JSON.parse(fs.readFileSync(`${userDataDir()}/live-smc.json`, 'utf8'));
    if (!smc || Date.now() / 1000 - smc.at >= 6) return s;      // stale/missing → leave ioreg-only
    if (smc.tempC != null) s.tempC = smc.tempC;
    if (smc.systemW != null) s.systemW = smc.systemW;           // SMC PSTR: total system draw
    if (smc.adapterW != null) s.adapterW = smc.adapterW;        // SMC PDTR: adapter input
    s.smc = true;
    if (smc.batteryW != null && smc.systemW != null) {          // live battery rail (PPBR), signed
      const charging = (smc.adapterW ?? 0) - smc.systemW >= 0;
      const signed = charging ? smc.batteryW : -smc.batteryW;
      s.powerW = +signed.toFixed(3);
      s.watts = +Math.abs(signed).toFixed(3);
      if (s.voltage) s.amperage = Math.round(signed / s.voltage * 1000);
      s.batLive = true;
    }
  } catch { /* no bridge / app not running → ioreg only */ }
  return s;
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

  return applyLiveSMC({
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
    // TimeRemaining: 65535 = "still calculating"; filter that + negatives to null
    timeRemain: (() => { const t = num(io, 'TimeRemaining'); return (t == null || t < 0 || t >= 65535) ? null : t; })(),
    loadPct: ncpu ? +((load[0] / ncpu) * 100).toFixed(1) : null, // 1-min load / cores
    load1: +load[0].toFixed(2),
    ncpu,
    topProc: tp.name,
    topProcCpu: tp.cpu,
  });
}
