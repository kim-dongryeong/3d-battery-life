#!/usr/bin/env node
// Universal entry — works via `npx joule <cmd>` AND as a bun-compiled single binary.
//   serve (default) · sample · record on|off|status · demo · demo2
// serve/sample/record run in-process (so they work inside the compiled binary, no Node needed);
// demo/demo2 shell out to Node (dev/npx only).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sample, applyLiveSMC } from '../lib/battery.js';
import { startServer, resolveRoot, DEMO_VER } from '../server.js';
import { userDataDir, samplesFile, appendSample } from '../lib/paths.js';
import { generateDemoLines } from '../scripts/gen-demo.js';
import { generateDemo2Lines } from '../scripts/gen-demo2.js';

const here = path.dirname(fileURLToPath(import.meta.url));        // .../bin (dev) or virtual (compiled)
const pkgRoot = path.dirname(here);                              // for spawning dev scripts (Node/npx only)
// Let server.js decide where web/ lives: BATTERY_ROOT → exe dir → .app Resources → cwd.
const root = resolveRoot();
const cmd = (process.argv[2] || 'serve').replace(/^-+/, '');

// ── launchd auto-recording ──────────────────────────────────────────────────
const LABEL = 'kr.kdr.joule.sampler';
const AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// What launchd runs each interval: node cli (dev/npm) or the compiled binary (app).
// Detect "compiled" via the Bun global, NOT by argv[1] extension — an npm-installed bin
// shim has no .js suffix, and the old check produced a broken `node sample` plist there.
const COMPILED = typeof Bun !== 'undefined';
function samplerArgv() {
  if (COMPILED) return [process.execPath, 'sample'];             // the single binary itself
  const argv1 = process.argv[1] || '';
  const script = fs.existsSync(argv1) ? argv1 : path.join(pkgRoot, 'bin', 'cli.js');
  return [process.execPath, script, 'sample'];                   // node + this script (works for npm shims too)
}
function plistXML(interval) {
  const data = userDataDir();
  const args = samplerArgv().map(a => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>JOULE_DATA</key><string>${xml(data)}</string></dict>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(data, 'sampler.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(data, 'sampler.err.log'))}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
`;
}
function recordOn(interval) {
  const data = userDataDir();
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.dirname(AGENT), { recursive: true });
  // one-time migration: merge legacy per-project data into the shared log (dedup by timestamp).
  // Merge (not copy) because the launchd sampler may already have written a few to the shared dir.
  const legacy = path.join(pkgRoot, 'data', 'samples.jsonl');
  const marker = path.join(data, '.migrated');
  if (!fs.existsSync(marker) && fs.existsSync(legacy)) {
    const read = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    const seen = new Set(), rows = [];
    for (const line of [...read(legacy), ...read(samplesFile())]) {
      let iso; try { iso = JSON.parse(line).iso; } catch { continue; }
      if (iso && !seen.has(iso)) { seen.add(iso); rows.push([iso, line]); }
    }
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    fs.writeFileSync(samplesFile(), rows.map(r => r[1]).join('\n') + '\n');
    fs.writeFileSync(marker, `merged legacy ${legacy}\n`);
    console.log(`migrated legacy history → ${rows.length} total samples in ${samplesFile()}`);
  }
  fs.writeFileSync(AGENT, plistXML(interval));
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); // idempotent: drop any old one first
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, AGENT], { stdio: 'ignore' });
  const r2 = r.status !== 0 ? spawnSync('launchctl', ['load', '-w', AGENT], { stdio: 'ignore' }) : null;
  if (r.status !== 0 && (!r2 || r2.status !== 0)) {              // don't claim ON when both launchctl paths failed
    console.error(`❌ launchd 등록 실패 (bootstrap/load 모두 실패) — plist는 ${AGENT}에 생성됨`);
    console.error(`   수동 시도: launchctl bootstrap gui/${uid} "${AGENT}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ recording ON — every ${interval}s → ${samplesFile()}`);
  console.log(`   auto-starts at login (survives reboot).  status: joule record status   stop: joule record off`);
}
function recordOff() {
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  const had = fs.existsSync(AGENT);
  if (had) fs.rmSync(AGENT);
  console.log(`🛑 recording OFF${had ? '' : ' (was not installed)'} — data kept at ${userDataDir()}`);
}
function recordStatus() {
  const uid = process.getuid();
  const installed = fs.existsSync(AGENT);
  const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0;
  let n = 0, last = '';
  try {
    const t = fs.readFileSync(samplesFile(), 'utf8').trim();
    if (t) { const lines = t.split('\n'); n = lines.length; last = JSON.parse(lines[n - 1]).iso; }
  } catch { /* no samples yet */ }
  console.log(`recording:  ${loaded ? 'ON (loaded, auto-starts at login)' : installed ? 'installed but not loaded' : 'OFF'}`);
  console.log(`plist:      ${AGENT}${installed ? '' : '  (absent)'}`);
  console.log(`samples:    ${samplesFile()}`);
  console.log(`collected:  ${n} samples${last ? `  (last ${last})` : ''}`);
}

// ── smcd: 앱 없이도 SMC 전력 발행 + 분당 기록을 유지하는 상주 데몬 (launchd KeepAlive) ──────
const SMCD_LABEL = 'kr.kdr.joule.smcd';
const SMCD_AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SMCD_LABEL}.plist`);
function smcdBin() {
  if (COMPILED) return path.join(path.dirname(process.execPath), 'joule-smcd');   // 번들: joule 옆
  return path.join(pkgRoot, 'native', 'smcd', 'target', 'release', 'joule-smcd'); // dev: cargo 산출물
}
function smcdOn() {
  const bin = smcdBin();
  if (!fs.existsSync(bin)) { console.error(`❌ smcd 바이너리 없음: ${bin}\n   빌드: cd native/smcd && cargo build --release`); process.exitCode = 1; return; }
  const data = userDataDir();
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.dirname(SMCD_AGENT), { recursive: true });
  // KeepAlive 상주 프로세스 — StartInterval(Background 타이머 지연) 문제와 무관하게 자체 0.5초 루프
  fs.writeFileSync(SMCD_AGENT, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SMCD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bin)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>JOULE_DATA</key><string>${xml(data)}</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(data, 'smcd.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(data, 'smcd.err.log'))}</string>
</dict>
</plist>
`);
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${SMCD_LABEL}`], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, SMCD_AGENT], { stdio: 'ignore' });
  const r2 = r.status !== 0 ? spawnSync('launchctl', ['load', '-w', SMCD_AGENT], { stdio: 'ignore' }) : null;
  if (r.status !== 0 && (!r2 || r2.status !== 0)) {
    console.error(`❌ smcd launchd 등록 실패 — plist는 ${SMCD_AGENT}에 생성됨`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ smcd ON — 앱이 꺼져 있어도 0.5초 SMC 표본·1분 평균 발행 + 분당 기록 유지 (로그인 시 자동 시작)`);
}
function smcdOff() {
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${SMCD_LABEL}`], { stdio: 'ignore' });
  const had = fs.existsSync(SMCD_AGENT);
  if (had) fs.rmSync(SMCD_AGENT);
  console.log(`🛑 smcd OFF${had ? '' : ' (was not installed)'}`);
}
function smcdStatus() {
  const uid = process.getuid();
  const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${SMCD_LABEL}`], { stdio: 'ignore' }).status === 0;
  console.log(`smcd:  ${loaded ? 'ON (loaded)' : fs.existsSync(SMCD_AGENT) ? 'installed but not loaded' : 'OFF'}`);
  console.log(`plist: ${SMCD_AGENT}${fs.existsSync(SMCD_AGENT) ? '' : '  (absent)'}`);
  console.log(`bin:   ${smcdBin()}${fs.existsSync(smcdBin()) ? '' : '  (absent!)'}`);
}

// ── legacy (`3d-battery-life` / `com.kdr.*`) → joule migration ──────────────
// Idempotent: safe to call on every run — the 2nd+ call is a no-op (old paths/labels are gone
// by then). Invoked below (see migrateLegacy() call), before the switch dispatches on `cmd` —
// i.e. before anything reads userDataDir() or launchd state — so a pre-existing legacy install
// is carried forward transparently on first launch of the renamed CLI/app.
const LEGACY_LABEL = 'com.kdr.3d-battery-life.sampler';
const LEGACY_SMCD_LABEL = 'com.kdr.3d-battery-life.smcd';
function migrateLegacy() {
  // (a) data dir: rename old → new ONLY if the old dir exists and the new one doesn't — this is
  // an atomic rename (fs.renameSync), so samples.jsonl and all history carry over intact. If BOTH
  // exist, do nothing but warn — merging risks duplicating records, so we never merge automatically.
  const oldData = path.join(os.homedir(), 'Library', 'Application Support', '3d-battery-life');
  const newData = path.join(os.homedir(), 'Library', 'Application Support', 'joule');
  let oldIsDir = false;
  try { oldIsDir = fs.statSync(oldData).isDirectory(); } catch { /* absent */ }
  if (oldIsDir && !fs.existsSync(newData)) {
    try { fs.renameSync(oldData, newData); console.log(`migrated legacy data dir → ${newData}`); }
    catch (e) { console.error(`⚠️  legacy data migration failed (${e.message}) — still reading ${oldData}`); }
  } else if (oldIsDir && fs.existsSync(newData)) {
    console.error(`⚠️  both ${oldData} and ${newData} exist — leaving both as-is (no automatic merge)`);
  }

  // (b) old-labeled launchd agents: bootout + delete the plist, then reinstall under the new
  // labels (LABEL/SMCD_LABEL below are already the new kr.kdr.joule.* values) IF they were active.
  const uid = process.getuid();
  const oldSamplerPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
  const oldSmcdPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_SMCD_LABEL}.plist`);
  const samplerWasActive = fs.existsSync(oldSamplerPlist);
  const smcdWasActive = fs.existsSync(oldSmcdPlist);
  for (const [label, plist] of [[LEGACY_LABEL, oldSamplerPlist], [LEGACY_SMCD_LABEL, oldSmcdPlist]]) {
    if (fs.existsSync(plist)) {
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });   // errors ignored — already-unloaded is fine
      try { fs.rmSync(plist); } catch { /* ignore */ }
    }
  }
  // recordOn/smcdOn are function declarations (hoisted) — calling them here, ahead of their
  // textual definition further down, is safe. They install under the NEW labels/paths since
  // LABEL/SMCD_LABEL/userDataDir() have already been updated to the joule identifiers.
  if (samplerWasActive) { recordOn(60); console.log('migrated: sampler reinstalled as kr.kdr.joule.sampler'); }
  if (smcdWasActive) { smcdOn(); console.log('migrated: smcd reinstalled as kr.kdr.joule.smcd'); }
}

// Run the migration on every invocation (idempotent — 2nd+ call is a no-op since the legacy
// paths/plists are gone by then). Placed here, after LABEL/SMCD_LABEL/recordOn/smcdOn are all
// defined (const TDZ + hoisting), and BEFORE the switch below does any real work/reads state.
migrateLegacy();

switch (cmd) {
  case 'serve':
    startServer({ root });
    break;
  case 'sample': {
    const s = sample();
    applyLiveSMC(s, true);   // record the 1-minute AVERAGE power (energy-correct), like the launchd sampler
    const wrote = appendSample(s);   // recency-guarded + locked (no double-write with launchd / resident app)
    if (wrote && s.ac) (await import('../lib/adapters.js')).upsertAdapter(s);   // 충전기 사전 누적
    console.log(`${s.iso}  ${s.pct}%  ${s.watts}W  health ${s.healthPct}%  ${s.ac ? 'AC' : 'BATT'}${wrote ? '' : '  (skipped: 최근 기록 있음)'}`);
    break;
  }
  case 'record': {
    const sub = (process.argv[3] || 'status').replace(/^-+/, '');
    if (sub === 'on') recordOn(parseInt(process.argv[4] || process.env.BATTERY_INTERVAL || '60', 10) || 60);
    else if (sub === 'off') recordOff();
    else recordStatus();
    break;
  }
  case 'install': recordOn(parseInt(process.argv[3] || '60', 10) || 60); break;   // aliases
  case 'uninstall': recordOff(); break;
  case 'smcd': {
    const sub = (process.argv[3] || 'status').replace(/^-+/, '');
    if (sub === 'on') smcdOn();
    else if (sub === 'off') smcdOff();
    else smcdStatus();
    break;
  }
  case 'demo':
  case 'demo2': {
    const l = cmd === 'demo2' ? generateDemo2Lines() : generateDemoLines();
    // compiled binary: pkgRoot is the read-only virtual /$bunfs → write to the shared cache
    // (which the server's demoFile() also reads); dev/npm: write into the repo's data/.
    const dir = COMPILED ? path.join(userDataDir(), 'demo-cache') : path.join(pkgRoot, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, COMPILED ? `${cmd}.v${DEMO_VER}.jsonl` : `${cmd}.jsonl`);   // match server's cache name
    fs.writeFileSync(f, l.join('\n') + '\n');
    console.log(`${cmd}: ${l.length} samples → ${f}`);
    break;
  }
  default:
    console.log(`joule <command>

  serve             start the local web viewer at http://localhost:4317   [default]
  sample            take one battery snapshot → shared samples log
  record on [sec]   start auto-recording every [sec]s (default 60), auto-starts at login
  record off        stop auto-recording (collected data kept)
  record status     show whether recording is on + sample count
  smcd on|off       앱이 꺼져 있어도 SMC 전력(0.5초 표본·1분 평균)+분당 기록을 유지하는 상주 데몬
  demo | demo2      generate demo data (data/demo*.jsonl)                 [Node]

  data (real samples): ${samplesFile()}
  npx joule serve      # or: ./joule serve  (compiled binary)`);
}
