#!/usr/bin/env node
// Universal entry — works via `npx battery-life <cmd>` AND as a bun-compiled single binary.
//   serve (default) · sample · record on|off|status · demo · demo2
// serve/sample/record run in-process (so they work inside the compiled binary, no Node needed);
// demo/demo2 shell out to Node (dev/npx only).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sample } from '../lib/battery.js';
import { startServer, resolveRoot } from '../server.js';
import { userDataDir, samplesFile } from '../lib/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));        // .../bin (dev) or virtual (compiled)
const pkgRoot = path.dirname(here);                              // for spawning dev scripts (Node/npx only)
// Let server.js decide where web/ lives: BATTERY_ROOT → exe dir → .app Resources → cwd.
const root = resolveRoot();
const cmd = (process.argv[2] || 'serve').replace(/^-+/, '');
const node = rel => spawnSync(process.execPath, [path.join(pkgRoot, rel)], { stdio: 'inherit' });

// ── launchd auto-recording ──────────────────────────────────────────────────
const LABEL = 'com.kdr.3d-battery-life.sampler';
const AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// What launchd runs each interval: node cli (dev) or the compiled binary (app).
function samplerArgv() {
  const argv1 = process.argv[1] || '';
  return argv1.endsWith('.js')
    ? [process.execPath, path.join(pkgRoot, 'bin', 'cli.js'), 'sample']
    : [process.execPath, 'sample'];
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
  <dict><key>BATTERY_DATA</key><string>${xml(data)}</string></dict>
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
  if (r.status !== 0) spawnSync('launchctl', ['load', '-w', AGENT], { stdio: 'ignore' });
  console.log(`✅ recording ON — every ${interval}s → ${samplesFile()}`);
  console.log(`   auto-starts at login (survives reboot).  status: battery-life record status   stop: battery-life record off`);
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

switch (cmd) {
  case 'serve':
    startServer({ root });
    break;
  case 'sample': {
    const dir = userDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const s = sample();
    fs.appendFileSync(path.join(dir, 'samples.jsonl'), JSON.stringify(s) + '\n');
    console.log(`${s.iso}  ${s.pct}%  ${s.watts}W  health ${s.healthPct}%  ${s.ac ? 'AC' : 'BATT'}`);
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
  case 'demo': node('scripts/gen-demo.js'); break;
  case 'demo2': node('scripts/gen-demo2.js'); break;
  default:
    console.log(`battery-life <command>

  serve             start the local web viewer at http://localhost:4317   [default]
  sample            take one battery snapshot → shared samples log
  record on [sec]   start auto-recording every [sec]s (default 60), auto-starts at login
  record off        stop auto-recording (collected data kept)
  record status     show whether recording is on + sample count
  demo | demo2      generate demo data (data/demo*.jsonl)                 [Node]

  data (real samples): ${samplesFile()}
  npx battery-life serve      # or: ./battery-life serve  (compiled binary)`);
}
