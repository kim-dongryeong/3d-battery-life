// Where the user's REAL battery log lives. Shared by every packaging form
// (npx CLI, single binary, Tauri .app) AND the launchd sampler, so they all
// read/write ONE dataset — no matter which form you run, you see the same report.
// Override with the BATTERY_DATA env var. (Shipped demo .jsonl are assets, not here.)
import os from 'node:os';
import path from 'node:path';

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
