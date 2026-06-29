#!/usr/bin/env node
// Universal entry — works via `npx battery-life <cmd>` AND as a bun-compiled single binary.
//   serve (default) · sample · demo · demo2 · install · uninstall
// serve/sample run in-process (so they work inside the compiled binary, no Node needed);
// demo/demo2/install shell out to Node/bash (dev/npx only).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sample } from '../lib/battery.js';
import { startServer, resolveRoot } from '../server.js';

const here = path.dirname(fileURLToPath(import.meta.url));        // .../bin (dev) or virtual (compiled)
const pkgRoot = path.dirname(here);                              // for spawning dev scripts (Node/npx only)
// Let server.js decide where web/ & data/ live: BATTERY_ROOT → exe dir → .app Resources → cwd.
// (Don't force exe dir here — that would hide the Tauri Resources/ layout from resolveRoot.)
const root = resolveRoot();
const dataDir = path.join(root, 'data');
const cmd = (process.argv[2] || 'serve').replace(/^-+/, '');
const node = rel => spawnSync(process.execPath, [path.join(pkgRoot, rel)], { stdio: 'inherit' });
const bash = rel => spawnSync('bash', [path.join(pkgRoot, rel)], { stdio: 'inherit' });

switch (cmd) {
  case 'serve':
    startServer({ root });
    break;
  case 'sample': {
    fs.mkdirSync(dataDir, { recursive: true });
    const s = sample();
    fs.appendFileSync(path.join(dataDir, 'samples.jsonl'), JSON.stringify(s) + '\n');
    console.log(`${s.iso}  ${s.pct}%  ${s.watts}W  health ${s.healthPct}%  ${s.ac ? 'AC' : 'BATT'}`);
    break;
  }
  case 'demo': node('scripts/gen-demo.js'); break;
  case 'demo2': node('scripts/gen-demo2.js'); break;
  case 'install': bash('install.sh'); break;
  case 'uninstall': bash('uninstall.sh'); break;
  default:
    console.log(`battery-life <command>

  serve        start the local web viewer at http://localhost:4317   [default]
  sample       take one battery snapshot → data/samples.jsonl
  demo         generate realistic demo data (data/demo.jsonl)        [Node]
  demo2        generate showcase demo data (data/demo2.jsonl)        [Node]
  install      install the launchd sampler (every 60s)               [Node, macOS]
  uninstall    remove the launchd sampler                            [macOS]

  npx battery-life serve      # or: ./battery-life serve  (compiled binary)`);
}
