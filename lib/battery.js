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

// ---- 충전기(어댑터) 식별 ----------------------------------------------------------------------
// AdapterDetails can contain NESTED dicts (UsbHvcMenu's PD-contract entries), so a flat
// "[^}]*" regex truncates at the first inner '}' — extract the block with a brace counter.
function adapterBlockRaw(io) {
  const at = io.indexOf('"AdapterDetails" = {');
  if (at < 0) return '';
  const open = io.indexOf('{', at);
  let depth = 0;
  for (let k = open; k < io.length; k++) {
    if (io[k] === '{') depth++;
    else if (io[k] === '}' && --depth === 0) return io.slice(open + 1, k);
  }
  return '';
}
// FamilyCode → charging-technology class. Verified against the macOS SDK headers:
//   IOPM.h  kIOPSFamilyCode* = iokit_family_err(sub, n)
//   IOReturn.h  sub_iokit_usb = err_sub(1) → USB family = 0xE0004000+n
//               sub_iokit_pmu = err_sub(9) → 전용(AC) family = 0xE0024000+n
//   n: …8 USBCBrick · 9 USBCTypeC(5V 계약) · 10 USBCPD
// Macs never negotiate Samsung AFC / Qualcomm QuickCharge — such chargers appear as plain
// 5V USB here, which is also the physical truth of what the Mac can draw from them.
export function adapterTech(familyHex) {
  const f = parseInt(familyHex, 16);
  if (!Number.isFinite(f) || f === 0) return null;             // disconnected/unreported
  if (f === 0xE000400A) return 'usbc-pd';
  if (f === 0xE0004008 || f === 0xE0004009) return 'usbc-5v';  // Type-C 5V 계약(비-PD)
  if (f >= 0xE0004000 && f <= 0xE0004007) return 'usb';        // 구형 USB 호스트/전용 충전 포트
  if (f >= 0xE0024000 && f <= 0xE0024009) return 'dedicated';  // 전용 어댑터(구 MagSafe/AC 계열)
  return 'unknown';
}
export const TECH_LABEL = { 'usbc-pd': 'USB-C PD', 'usbc-5v': 'USB-C 5V', usb: 'USB(구형)', dedicated: '전용 어댑터', unknown: '미상' };
// Parse the full AdapterDetails into one object; null when nothing is connected/reported.
export function parseAdapter(io) {
  const blk = adapterBlockRaw(io);
  if (!blk) return null;
  const g = k => { const m = blk.match(new RegExp('"' + k + '"=(?:"([^"]*)"|(-?\\d+))')); return m ? (m[1] ?? Number(m[2])) : null; };
  // FamilyCode is sign-extended to unsigned 64-bit (> 2^53 — Number would LOSE PRECISION and
  // corrupt the code) → parse the digit string with BigInt and keep the meaningful low 32 bits.
  const famStr = (blk.match(/"FamilyCode"=(-?\d+)/) || [])[1] ?? null;
  const famRaw = famStr != null ? BigInt.asUintN(32, BigInt(famStr)) : null;
  const familyCode = famRaw != null ? famRaw.toString(16) : null;
  const hvcMenu = [];
  const hm = blk.match(/"UsbHvcMenu"=\(([\s\S]*?)\)/);   // the PD contracts the charger OFFERS
  if (hm) for (const e of hm[1].matchAll(/\{([^}]*)\}/g)) {
    const gv = k => { const m2 = e[1].match(new RegExp('"' + k + '"=(-?\\d+)')); return m2 ? Number(m2[1]) : null; };
    const mv = gv('MaxVoltage'), ma = gv('MaxCurrent');
    if (mv != null && ma != null) hvcMenu.push({ v: mv / 1000, a: ma / 1000 });
  }
  const watts = g('Watts');
  if (!watts && !famRaw) return null;   // disconnected: Watts 0/absent + FamilyCode 0 (0n is falsy)
  return {
    watts,                                                                       // 협상 계약 정격 W
    voltage: g('AdapterVoltage') != null ? g('AdapterVoltage') / 1000 : null,    // 협상 전압 V
    current: g('Current') != null ? g('Current') / 1000 : null,                  // 협상 전류 A
    adapterId: g('AdapterID'),
    familyCode,
    tech: adapterTech(familyCode),
    name: g('Name') || g('Description') || null,          // Apple 정품·인증 충전기만 채워짐
    manufacturer: g('Manufacturer') || null,
    hvcIndex: g('UsbHvcHvcIndex'),
    hvcMenu,
    isWireless: /"IsWireless"=Yes/.test(blk),
    // 개체(현물) 식별 증거 — 서드파티 충전기가 흔히 채우는 후보들. name/manufacturer만으론 같은
    // 모델의 서로 다른 실물을 구분 못 하므로 (b) 충전기 개체 식별을 위해 원문째로 함께 보존한다.
    serial: g('Serial'),
    hwVersion: g('HwVersion'),
    fwVersion: g('FwVersion'),
    description: g('Description'),
    rawDetails: blk.trim(),        // AdapterDetails 블록 원문(트림) — 위 필드들이 못 잡아낸 값도 여기 남는다
  };
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
  const adp = parseAdapter(io);   // 충전기 식별(기술·계약·제공 프로필) — 레거시 필드도 여기서 파생
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
    adapterWatts: adp?.watts ?? null,
    adapterName: adp?.name ?? null,
    adapterVoltage: adp?.voltage ?? null,
    adapter: adp,   // full identification — 기술(PD/5V)·계약 V×A·제공 프로필(UsbHvcMenu)·제조사
    onHold: acNow === true && chgNow === false && fullNow !== true && notCharging !== 0, // optimized charging hold
  };
}

// Merge the running app's live SMC bridge into a sample when fresh. SMC is only readable by the Rust
// tray app, which publishes live-smc.json every ~2s with BOTH the instantaneous reading AND a rolling
// 60-second average (∫W dt / 60s). No app running → ioreg only.
//   useAvg=false (default, /api/live popover) → instantaneous (real-time "now").
//   useAvg=true  (the recorder) → the 1-minute average, so a per-minute record integrates to the true
//                energy for that minute (a 0.1s spike no longer counts as a full minute at that power).
export function applyLiveSMC(s, useAvg = false) {
  try {
    const smc = JSON.parse(fs.readFileSync(`${userDataDir()}/live-smc.json`, 'utf8'));
    if (!smc || Date.now() / 1000 - smc.at >= 6) return s;      // stale/missing → leave ioreg-only
    const pick = (avgK, instK) => (useAvg && smc[avgK] != null) ? smc[avgK] : smc[instK];
    const sysW = pick('systemWAvg', 'systemW');                 // SMC PSTR: total system draw
    const adpW = pick('adapterWAvg', 'adapterW');               // SMC PDTR: adapter input
    if (smc.tempC != null) s.tempC = smc.tempC;
    if (sysW != null) s.systemW = sysW;
    if (adpW != null) s.adapterW = adpW;
    // raw inputs kept so every measurement METHOD can be shown/derived downstream (popover compare, tooltip, graph)
    if (smc.batteryW != null) s.ppbrW = pick('batteryWAvg', 'batteryW');   // SMC PPBR (discharge power; ~0 charging)
    if (smc.dcInV != null) s.dcInV = smc.dcInV;                 // SMC VD0R: measured DC-in voltage
    if (smc.dcInA != null) s.dcInA = smc.dcInA;                 // SMC ID0R: measured DC-in current
    s.smc = true;
    // battery power via ENERGY BALANCE: adapter_in − system (+ charge / − discharge). The SMC "battery"
    // key (PPBR) reads ~0 while charging, so it is NOT the charge power — the surplus adapter−system is.
    // (Verified vs the actual %-gain rate: ioreg 1178mA·12.4V≈14.6W ≈ adapter−system, PPBR said 0.9W.)
    if (sysW != null) {
      // preserve raw ioreg V×I (signed) before overwriting powerW with the balance. Guard against a
      // SECOND applyLiveSMC pass (the recorder runs instant-in-sample() THEN avg) clobbering the raw
      // ioreg with the already-computed balance — capture once, keep the first (true ioreg) value.
      if (s.ioregW == null) { s.ioregW = s.powerW; s.ioregA = s.amperage; }
      const signed = (adpW ?? 0) - sysW;
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

  const rec = applyLiveSMC({
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
  // Adapter NOMINAL rating (ioreg AdapterDetails: Watts / AdapterVoltage) — the "공칭/정격" numbers,
  // recorded only when plugged in so the viewer can compare them against SMC's measured PDTR/VD0R/ID0R.
  // (Reuses the ioreg blob already read above — no extra subprocess.)
  if (rec.ac) {
    // charger IDENTITY per minute while plugged in, so the charge stats can be split per charger
    // profile (Serial is skipped — privacy + waste). Reuses the ioreg blob already read above.
    const adp = parseAdapter(io);
    if (adp) {
      if (adp.watts != null) rec.adapterWnom = adp.watts;                    // 정격 W (계약)
      if (adp.voltage != null) rec.adapterVnom = +adp.voltage.toFixed(3);    // 협상 전압 V
      if (adp.current != null) rec.adapterAnom = adp.current;                // 협상 전류 A
      if (adp.adapterId != null) rec.adapterId = adp.adapterId;
      if (adp.familyCode) rec.familyCode = adp.familyCode;                   // hex, 기술 판별의 근거
      if (adp.name) rec.adapterName = adp.name;
    }
  }
  return rec;
}
