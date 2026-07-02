// Where the user's REAL battery log lives. Shared by every packaging form
// (npx CLI, single binary, Tauri .app) AND the launchd sampler, so they all
// read/write ONE dataset — no matter which form you run, you see the same report.
// Override with the BATTERY_DATA env var. (Shipped demo .jsonl are assets, not here.)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function userDataDir() {
  return process.env.BATTERY_DATA || path.join(os.homedir(), 'Library', 'Application Support', '3d-battery-life');
}

export function samplesFile() {
  return path.join(userDataDir(), 'samples.jsonl');
}

// Demos are generated on demand (not shipped) and cached here.
export function cacheDir() {
  return path.join(userDataDir(), 'demo-cache');
}

// Read just the last sample's timestamp (tail read, not the whole file).
function lastSampleT(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(8192, size);            // records are <500B; 8KB always spans the last full line
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const s = buf.toString('utf8');
    // walk backward over the last few complete lines; a single corrupt/truncated tail line
    // must NOT disable the recency guard (fall back to the previous good record)
    const lines = s.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
      try { const t = JSON.parse(lines[i]).t; if (t != null) return t; } catch { /* try previous line */ }
    }
    return null;
  } catch { return null; }
}

// Append a sample with a recency guard + a lockfile, so the launchd sampler and the resident
// app (or two racing writers) never double-record the same minute. Returns true if written.
export function appendSample(s, { minGapSec = 55 } = {}) {
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = samplesFile();
  const lock = file + '.lock';
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');   // atomic create — the normal, race-free path
  } catch {
    // lock exists: steal it ONLY if stale, and atomically (rename wins for exactly one racer,
    // so two processes can't both blind-rm the lock and both proceed → no duplicate append)
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs <= (minGapSec + 5) * 1000) return false;   // a live writer holds it
      const stolen = lock + '.' + process.pid;
      fs.renameSync(lock, stolen);   // throws if another racer already renamed it
      fs.rmSync(stolen, { force: true });
      fd = fs.openSync(lock, 'wx');
    } catch { return false; }        // lost the steal race, or not actually stale
  }
  try {
    const lastT = lastSampleT(file);
    if (lastT != null && s.t - lastT < minGapSec) return false;   // too soon after the last record → skip
    fs.appendFileSync(file, JSON.stringify(s) + '\n');            // O_APPEND: atomic per line
    return true;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
  }
}
