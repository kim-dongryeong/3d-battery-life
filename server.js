// Tiny zero-dependency server: serves the web app + live /api/report & /api/rates.
// Exposed as startServer() so the npx CLI and the compiled single-binary can reuse it;
// still runs directly via `node server.js`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { readSamples, buildReport } from './lib/report.js';
import { analyzeRates } from './lib/bucketRates.js';
import { sample, detail } from './lib/battery.js';
import { chargerKey, readAdapters, upsertAdapter } from './lib/adapters.js';
import { chargeStats, ratesWithFallback, classKey, energyBalanceETA } from './lib/chargeRates.js';
import { userDataDir, cacheDir, appendSample } from './lib/paths.js';
import { applyLiveSMC } from './lib/battery.js';
import * as measure from './lib/measure.js';
import { generateDemoLines } from './scripts/gen-demo.js';
import { generateDemo2Lines } from './scripts/gen-demo2.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// Demos are GENERATED on demand (deterministic) and cached — not shipped (keeps the app small).
// If an older bundle still ships one next to the app, prefer that.
// DEMO_VER busts the cache when the generators change — otherwise a stale cached demo
// would silently mask generator updates forever.
export const DEMO_VER = 2;
function demoFile(sp, assetDir) {
  const name = sp === 'demo2' ? 'demo2.jsonl' : 'demo.jsonl';
  const bundled = path.join(assetDir, name);
  if (fs.existsSync(bundled)) return bundled;
  const cached = path.join(cacheDir(), `${sp === 'demo2' ? 'demo2' : 'demo'}.v${DEMO_VER}.jsonl`);
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const lines = sp === 'demo2' ? generateDemo2Lines() : generateDemoLines();
    fs.writeFileSync(cached, lines.join('\n') + '\n');
  }
  return cached;
}

// Only serve requests addressed to localhost — a malicious website using DNS rebinding
// (its hostname re-pointed at 127.0.0.1) would otherwise read the battery/usage log.
let procsCache = { at: 0, data: [] };   // /api/procs cache (shared across requests)
let procsInflight = false;
let detailCache = { at: 0, data: {} };  // /api/detail cache (slow-changing fields)
let sparkCache = { at: 0, data: [] };    // /api/spark cache (recent %, for the popover mini-graph)

// tray.json = the settings the menu-bar (Rust) and the popover settings panel both share.
// The Rust ticker re-reads it every 2s, so a popover change applies to the menu bar live.
const TRAY_DEFAULTS = { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: 'icon', glyph_xl: false, shortcut: true, digit_deco: true, bolt_style: 'classic' };
const trayPath = () => path.join(userDataDir(), 'tray.json');
function readTray() {
  let t;
  try { t = { ...TRAY_DEFAULTS, ...JSON.parse(fs.readFileSync(trayPath(), 'utf8')) }; } catch { t = { ...TRAY_DEFAULTS }; }
  // read-side migration: files predating the 텍스트 chips carry the legacy `info` enum (0–7).
  // Same mapping as Rust's Cfg::title_items — GET always returns the chip keys so the popover
  // never needs to know about `info`. First chip save persists them (sanitizeCfg below).
  if (t.text_pct == null && t.text_w_sys == null) {
    const i = Number.isInteger(t.info) && t.info >= 0 && t.info <= 7 ? t.info : 4;
    t.text_pct = [1, 4, 5, 7].includes(i);
    t.text_time = [2, 5].includes(i);
  }
  // power chips are now INDEPENDENT (system + battery). Derive from the old single text_w+w_src
  // (or the legacy enum's sysW=3/4, batW=6/7) when the new keys are absent.
  if (t.text_w_sys == null && t.text_w_bat == null) {
    if (t.text_w != null) {
      const bat = t.w_src === 'bat';
      t.text_w_sys = !!t.text_w && !bat;
      t.text_w_bat = !!t.text_w && bat;
    } else {
      const i = Number.isInteger(t.info) && t.info >= 0 && t.info <= 7 ? t.info : 4;
      t.text_w_sys = [3, 4].includes(i);
      t.text_w_bat = [6, 7].includes(i);
    }
  }
  if (t.w7_src == null) t.w7_src = 'sys';
  if (t.text_temp == null) t.text_temp = false;   // post-chips additions: absent = off
  if (t.text_adp == null) t.text_adp = false;
  return t;
}
// only accept known keys with valid types/ranges — tray.json is deserialized by Rust (serde),
// so a wrong type would break the menu-bar reader.
function sanitizeCfg(p) {
  const o = {};
  if (Number.isInteger(p.info) && p.info >= 0 && p.info <= 7) o.info = p.info;
  if (typeof p.colorize === 'boolean') o.colorize = p.colorize;
  if (Number.isInteger(p.low_pct) && p.low_pct >= 0 && p.low_pct <= 100) o.low_pct = p.low_pct;
  if (Number.isInteger(p.high_pct) && p.high_pct >= 0 && p.high_pct <= 100) o.high_pct = p.high_pct;
  if (['icon', 'iconpct', 'combo', 'stack', 'wstack', 'bar', 'text'].includes(p.widget)) o.widget = p.widget;
  if (typeof p.glyph_xl === 'boolean') o.glyph_xl = p.glyph_xl;
  if (typeof p.shortcut === 'boolean') o.shortcut = p.shortcut;
  if (typeof p.text_pct === 'boolean') o.text_pct = p.text_pct;
  if (typeof p.text_time === 'boolean') o.text_time = p.text_time;
  if (typeof p.text_w === 'boolean') o.text_w = p.text_w;
  if (['sys', 'bat'].includes(p.w_src)) o.w_src = p.w_src;
  if (typeof p.text_w_sys === 'boolean') o.text_w_sys = p.text_w_sys;
  if (typeof p.text_w_bat === 'boolean') o.text_w_bat = p.text_w_bat;
  if (['sys', 'bat'].includes(p.w7_src)) o.w7_src = p.w7_src;
  if (typeof p.digit_deco === 'boolean') o.digit_deco = p.digit_deco;
  if (['classic', 'bold'].includes(p.bolt_style)) o.bolt_style = p.bolt_style;
  if (typeof p.text_temp === 'boolean') o.text_temp = p.text_temp;
  if (typeof p.text_adp === 'boolean') o.text_adp = p.text_adp;
  if (['current', 'waterline', 'thermo', 'swap', 'outline', 'badge', 'hybrid'].includes(p.chg_fill)) o.chg_fill = p.chg_fill;   // 충전 표시(저잔량) 모드
  if (typeof p.small_unit === 'boolean') o.small_unit = p.small_unit;   // 단위 W 작게 (아이콘 축소 + 텍스트 ᵂ)
  return o;
}

// ── 전력 분석(측정) 세션 — calculations live in lib/measure.js (tested); this block owns only
// timers + persistence. Samples come from live-smc.json (the tray app's ~2s SMC publish, now
// carrying seq/monoMs); the gauge trace comes from sample()'s coulomb fields every ~60s.
const measureFile = () => path.join(userDataDir(), 'measure-session.json');
let mSt = null, mTick = null, mCoul = null;
function measurePersist() {
  if (!mSt) { try { fs.unlinkSync(measureFile()); } catch { /* absent */ } return; }
  const f = measureFile();
  try { fs.writeFileSync(f + '.tmp', JSON.stringify(mSt)); fs.renameSync(f + '.tmp', f); } catch { /* disk hiccup — next snapshot retries */ }
}
function readLiveSMC() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'live-smc.json'), 'utf8'));
    return (Date.now() / 1000 - s.at < 6) ? s : null;    // same stale rule as applyLiveSMC
  } catch { return null; }
}
function coulombTick() {
  if (!mSt || mSt.state !== 'running') return;
  try {
    const s = sample();
    if (s.rawCap != null && s.voltage) measure.coulombPoint(mSt, { t: s.t, mah: s.rawCap, mv: Math.round(s.voltage * 1000) });
  } catch { /* ioreg 실패 → 다음 분에 재시도 */ }
}
function measureTimersStart() {
  if (mTick) return;
  // Poll at 250ms so EVERY ~0.5s SMC publish is integrated (dedup by seq), not just one per 2s —
  // energy must use every 0.5s sample even though the popover UI refreshes on its own slower cadence.
  mTick = setInterval(() => {
    if (!mSt || mSt.state !== 'running') return;
    const smc = readLiveSMC();
    // stale/missing publisher: no acceptSample call — the next unique sample's monoMs delta
    // exceeds GAP_SEC and lib/measure.js records the whole silence as one coalesced gap.
    // acceptSample dedups by seq, so reading faster than the publish rate is harmless (dups skipped).
    if (smc) measure.acceptSample(mSt, smc);
    const now = Date.now();
    if (now >= (mSt.nextPersistAt || 0)) { mSt.nextPersistAt = now + measure.PERSIST_MS; measurePersist(); }
  }, 250);
  mCoul = setInterval(coulombTick, 60_000);
}
function measureTimersStop() { clearInterval(mTick); clearInterval(mCoul); mTick = mCoul = null; }
// ⚠️ resume lives in startServer(), NEVER at module level: server.js is imported by bin/cli.js for
// EVERY subcommand — a module-level resume turned the launchd sampler's one-shot `cli.js sample`
// into an immortal zombie (armed setInterval = event loop never drains) that kept a stale session
// integrating + re-persisting all night, overwriting stop/reset done on the real server (유령 세션).
function measureResume() {
  try { mSt = JSON.parse(fs.readFileSync(measureFile(), 'utf8')); } catch { mSt = null; }
  if (mSt && mSt.state === 'running') measureTimersStart();
}

function hostAllowed(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
}
// The user's real samples live in the shared, writable user data dir — so every
// packaging form (CLI · binary · app) shows the same report.
const readSource = (sp, assetDir) => {
  if (sp === 'demo' || sp === 'demo2') return readSamples(demoFile(sp, assetDir));
  const f = path.join(userDataDir(), 'samples.jsonl');
  return fs.existsSync(f) ? readSamples(f) : [];
};

// In dev, assets sit next to this file. In a bun-compiled binary the source lives in a
// virtual fs (no web/ there) → fall back to the directory of the executable.
export function resolveRoot(root) {
  if (root) return root;
  if (process.env.BATTERY_ROOT) return process.env.BATTERY_ROOT;   // explicit (Tauri sets this to its resource dir)
  const exe = path.dirname(process.execPath);
  let here = exe;
  try { here = path.dirname(fileURLToPath(import.meta.url)); } catch { /* compiled: import.meta.url not a file URL */ }
  // dev (next to source) · compiled binary (next to exe) · Tauri .app (Contents/Resources) · cwd
  const cands = [here, exe, path.resolve(exe, '..', 'Resources'), process.cwd()];
  for (const c of cands) {
    let hit = false;
    try { hit = fs.existsSync(path.join(c, 'web')); } catch { /* ignore */ }
    if (process.env.BATTERY_DEBUG) console.error('[resolveRoot] try', JSON.stringify(c), '->', hit);
    if (hit) return c;
  }
  return exe;
}

export function startServer({ root, port } = {}) {
  measureResume();   // resume a crash-interrupted measurement — only the real server, never importers
  // Resident backup recorder: launchd's StartInterval job is ProcessType=Background, which macOS
  // timer-coalesces on battery/low-power — observed minutes-long holes (e.g. 08:20, 08:22–24 on
  // 2026-07-16 while fully awake). While this server is running, append a record each minute too;
  // appendSample's lock + 55s recency guard makes the two writers race-safe (never a double record).
  setInterval(() => {
    try {
      const s = sample();
      applyLiveSMC(s, true);   // 1-minute AVERAGE power, same as bin/sampler.js
      if (appendSample(s) && s.ac) upsertAdapter(s);
    } catch { /* ioreg hiccup → launchd sampler or next minute covers it */ }
  }, 60_000);
  const base = resolveRoot(root);
  const PORT = port || process.env.PORT || 4317;
  const webDir = fs.realpathSync(path.join(base, 'web'));
  const assetDir = path.join(base, 'data');            // shipped demo .jsonl

  const server = http.createServer((req, res) => {
    try { handle(req, res); }                                  // a malformed request must not crash the server
    catch (e) { try { res.writeHead(400); res.end('bad request'); } catch { /* already sent */ } }
  });

  function handle(req, res) {
    if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden'); return; }
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/report') {
      try {
        const level = url.searchParams.get('level') === 'pct' ? 'pct' : 'rawcap';   // HUD 10%-trend precision
        const source = url.searchParams.get('source');
        let samples = readSource(source, assetDir);
        // '내 데이터'엔 지금 이 순간을 실시간 ioreg 한 점으로 덧붙인다. 1분 샘플러가 아직 안 찍은
        // 창(특히 자다 깬 직후 최대 1분)에도 그래프·HUD가 과거가 아니라 현재를 가리키게 하려는 것.
        // best-effort: 실시간 읽기가 실패해도 저장된 샘플만으로 정상 리포트를 반환한다.
        if (source !== 'demo' && source !== 'demo2') {
          try {
            const now = sample();
            const last = samples.length ? samples[samples.length - 1] : null;
            if (now && now.t && (!last || now.t > last.t)) samples = samples.concat(now);
          } catch { /* live read failed → 저장 샘플만 사용 */ }
        }
        const report = buildReport(samples, { level });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (url.pathname === '/api/rates') {
      const level = url.searchParams.get('level') === 'rawcap' ? 'rawcap' : 'pct';
      const period = url.searchParams.get('period');
      const mq = url.searchParams.get('method');
      const method = mq === 'ioreg' || mq === 'hybrid' ? mq : 'balance';   // 배터리 전력 측정 방식(구간별전력)
      try {
        const r = analyzeRates(readSource(url.searchParams.get('source'), assetDir), { level, period, method });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ opt: r.opt, spans: r.spans, atoms: r.atoms, byBand: r.byBand, periods: r.periods, perCell: r.perCell }));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // live: a fresh single reading (ioreg + pmset + top-proc) — the popover polls this every ~2s.
    // When the tray app is running it writes live-smc.json (real-time SMC temp/system-power); merge
    // that over ioreg's 60s-quantized temp so the live UI actually moves second-to-second.
    if (url.pathname === '/api/live') {
      try {
        const s = sample();
        // whether the launchd sampler is installed (so the popover's recording toggle shows the right label)
        try { s.recording = fs.existsSync(path.join(process.env.HOME || '', 'Library/LaunchAgents/com.kdr.3d-battery-life.sampler.plist')); } catch { /* ignore */ }
        // systemW/adapterW + the live battery rail are merged inside sample() now (applyLiveSMC),
        // so both /api/live AND the launchd sampler record them when the app is running.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(s));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // 충전기 프로필별 충전 통계 + 계층 폴백 + 에너지 수지 ETA — 뷰어 충전 예상 카드/3D 충전선의 소스.
    // 내 데이터 전용(데모엔 충전기 정보가 없음). 계산은 lib/chargeRates.js(테스트됨), 여기선 조립만.
    if (url.pathname === '/api/charge-rates') {
      try {
        const level = url.searchParams.get('level') === 'pct' ? 'pct' : 'rawcap';
        let samples = readSource('real', assetDir);
        let live = null;
        try { live = sample(); if (live && live.t && samples.length && live.t > samples[samples.length - 1].t) samples = samples.concat(live); } catch { /* ioreg 실패 → 저장 샘플만 */ }
        const stats = chargeStats(samples, level);
        const adapters = readAdapters();
        let key = null, cls = null, assumed = false;
        if (live && live.ac) { key = chargerKey(live); cls = classKey(live); }
        else {
          // 미연결: "가장 최근에 목격한 충전기"를 가정해 예측 — 어떤 충전기 기준인지 배지로 명시(kdr)
          const ents = Object.entries(adapters);
          if (ents.length) {
            const [k, m] = ents.reduce((a, b) => ((b[1].lastSeen || 0) > (a[1].lastSeen || 0) ? b : a));
            key = k; cls = classKey({ familyCode: m.family, adapterWnom: m.watts }); assumed = true;
          }
        }
        const resolved = ratesWithFallback(stats, key, cls);
        // 에너지 수지: 벌크(→80%) + 참고용 전체(→100%, CV 꼬리는 낙관적이라 뷰어가 밴드 통계로 스플라이스)
        const eb = live ? energyBalanceETA({ samples, live, targetPct: 80 }) : null;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        // avgSysChargeW: 클라이언트의 "정격 기반 물리 추정"(bandsForProfile 스케일링)의 기준값 —
        // 이 키가 빠지면 스케일링이 조용히 비활성화되어 15W와 96W가 같은 ETA를 내는 회귀가 된다
        res.end(JSON.stringify({ current: key ? { key, cls, meta: adapters[key] || null, assumed } : null,
          resolved, profiles: stats.profiles, classes: stats.classes, global: stats.global,
          avgSysChargeW: stats.avgSysChargeW, adapters, energyBalance: eb }));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // 전력 분석(측정) 세션: start/stop/reset + 상태 폴링. 계산은 lib/measure.js(테스트됨).
    if (url.pathname === '/api/measure' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(mSt ? measure.summary(mSt) : { state: 'idle' }));
      return;
    }
    if (url.pathname === '/api/measure/start' && req.method === 'POST') {
      if (mSt && mSt.state === 'running') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'already running' })); return; }
      let startInfo = null;
      try {
        const s = sample();
        startInfo = { rawCapMah: s.rawCap ?? null, voltageMv: s.voltage ? Math.round(s.voltage * 1000) : null, pct: s.pct ?? null,
          adapter: s.ac ? { key: chargerKey(s), watts: s.adapterWnom ?? null } : null };
        mSt = measure.newSession(startInfo, s.t);
        if (s.rawCap != null && s.voltage) measure.coulombPoint(mSt, { t: s.t, mah: s.rawCap, mv: Math.round(s.voltage * 1000) });
      } catch { mSt = measure.newSession({ rawCapMah: null, voltageMv: null, pct: null, adapter: null }, Math.round(Date.now() / 1000)); }
      measurePersist(); measureTimersStart();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(measure.summary(mSt)));
      return;
    }
    if (url.pathname === '/api/measure/stop' && req.method === 'POST') {
      if (!mSt || mSt.state !== 'running') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not running' })); return; }
      coulombTick();                                      // 마지막 게이지 점을 확정하고 나서 멈춘다
      measure.stopSession(mSt, Math.round(Date.now() / 1000));
      measureTimersStop(); measurePersist();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(measure.summary(mSt)));
      return;
    }
    if (url.pathname === '/api/measure/reset' && req.method === 'POST') {
      if (mSt && mSt.state === 'running') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'still running' })); return; }
      mSt = null; measurePersist();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ state: 'idle' }));
      return;
    }

    // slow-changing extras (condition, serial, design cycles, adapter, on-hold) — cached ~10s
    if (url.pathname === '/api/detail') {
      try {
        if (Date.now() - detailCache.at > 10000) {
          detailCache = { at: Date.now(), data: detail() };
          // 충전기 사전 보강: 이름·제조사·제공 프로필(UsbHvcMenu)은 detail에만 있음 — 팝오버가
          // 열릴 때 채워 넣는다 (charging:false → chargeMin은 sampler만 집계, 이중 계상 없음)
          const a = detailCache.data.adapter;
          if (a && a.watts) upsertAdapter({ t: Math.round(Date.now() / 1000), adapterWnom: a.watts,
            adapterVnom: a.voltage, adapterAnom: a.current, adapterId: a.adapterId,
            familyCode: a.familyCode, charging: false }, a);
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(detailCache.data));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // the popover reports its content height → a file the tray app reads to size the window
    // exactly (no scrollbar, no square margin around the rounded body).
    // viewer's localized native window title → a file the tray app's ticker reads and applies via
    // set_title (Tauri doesn't mirror document.title; IPC is unreliable for this external-URL window).
    if (url.pathname === '/api/main-title' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e3) req.destroy(); });
      req.on('end', () => {
        try {
          const tt = String(JSON.parse(body || '{}').title || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);
          if (tt) { fs.mkdirSync(userDataDir(), { recursive: true }); fs.writeFileSync(path.join(userDataDir(), 'main-title'), tt); }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
        } catch { res.writeHead(400); res.end('bad'); }
      });
      return;
    }

    if (url.pathname === '/api/height' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e3) req.destroy(); });
      req.on('end', () => {
        try {
          const h = Math.round(+JSON.parse(body || '{}').h);
          if (h >= 120 && h <= 2000) { fs.mkdirSync(userDataDir(), { recursive: true }); fs.writeFileSync(path.join(userDataDir(), 'popover-h'), String(h)); }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
        } catch { res.writeHead(400); res.end('bad'); }
      });
      return;
    }

    // popover overflow actions → a file the tray app's ticker consumes (report / record / quit / hide).
    // File-bridged (not Tauri IPC) so it works regardless of webview IPC availability.
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        try {
          const a = String(JSON.parse(body || '{}').do || '');
          if (['report', 'record', 'quit', 'hide'].includes(a)) {
            fs.mkdirSync(userDataDir(), { recursive: true });
            fs.writeFileSync(path.join(userDataDir(), 'action'), a);
          }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
        } catch { res.writeHead(400); res.end('bad'); }
      });
      return;
    }

    // shared settings (tray.json): GET returns current, POST merges a patch and writes it.
    // The menu-bar reader (Rust) re-reads tray.json every tick, so changes here apply live.
    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', () => {
          try {
            const merged = { ...readTray(), ...sanitizeCfg(JSON.parse(body || '{}')) };
            fs.mkdirSync(userDataDir(), { recursive: true });
            fs.writeFileSync(trayPath(), JSON.stringify(merged));
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(merged));
          } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(readTray()));
      return;
    }

    // menu-bar glyph previews (written by the Rust ticker as raw-RGBA-base64) — the settings
    // panel renders these directly, so its preview is the tray renderer's actual output.
    if (url.pathname === '/api/tray-preview') {
      try {
        const j = fs.readFileSync(path.join(userDataDir(), 'tray-preview.json'));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(j);
      } catch { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no preview yet"}'); }
      return;
    }

    // recent battery % for the popover's mini "3D 리포트 미리보기" sparkline — the last ~6h of the
    // user's real samples, downsampled. Cached ~20s (samples only change each minute anyway).
    if (url.pathname === '/api/spark') {
      try {
        const raw = url.searchParams.get('h');   // window hours (0 = all); keep an explicit 0
        const h = raw === null ? 6 : Math.max(0, Math.min(720, +raw || 0));
        if (Date.now() - sparkCache.at > 20000 || sparkCache.h !== h) {
          const file = path.join(userDataDir(), 'samples.jsonl');
          const all = fs.existsSync(file) ? readSamples(file) : [];
          const last = all.length ? all[all.length - 1].t : 0;
          let recent = all.filter(s => s.pct != null && (h === 0 || s.t >= last - h * 3600));
          const N = 72;
          if (recent.length > N) { const step = recent.length / N; recent = Array.from({ length: N }, (_, i) => recent[Math.floor(i * step)]); }
          sparkCache = { at: Date.now(), h, data: recent.map(s => ({ t: s.t, pct: s.pct, w: s.watts, chg: !!s.charging })) };
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(sparkCache.data));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // top battery-consuming processes (like Stats): `top -o power`. Async so `top -l 2` (~1-2s)
    // doesn't block the event loop; cached ~4s + in-flight-coalesced so overlapping polls don't
    // each spawn a `top` (client polls at ~5s, each top takes ~2s).
    if (url.pathname === '/api/procs') {
      const n = Math.max(1, Math.min(20, +url.searchParams.get('n') || 8));
      const sendCache = () => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(procsCache.data.slice(0, n))); };
      if (Date.now() - procsCache.at < 4000 || procsInflight) { sendCache(); return; }
      procsInflight = true;
      execFile('top', ['-l', '2', '-o', 'power', '-n', '20', '-stats', 'pid,command,power'], { timeout: 5000 }, (err, stdout) => {
        procsInflight = false;
        if (err) procsCache.at = Date.now();   // back off on failure — don't respawn `top` every poll
        if (!err) {
          const blocks = stdout.split(/^Processes:/m);           // 2nd sample = last block
          const rows = [];
          for (const line of (blocks[blocks.length - 1] || stdout).split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s*$/);
            if (m) rows.push({ pid: +m[1], name: m[2].trim(), power: +m[3] });
          }
          procsCache = { at: Date.now(), data: rows };
        }
        sendCache();
      });
      return;
    }

    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    fs.realpath(file, (e, real) => {                              // resolve symlinks, confirm inside webDir
      if (e || path.relative(webDir, real).startsWith('..')) { res.writeHead(404); res.end('not found'); return; }
      fs.readFile(real, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(real)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
  }

  // As a Tauri sidecar (BATTERY_SIDECAR=1): a dying/killed parent can't always kill us (SIGKILL/crash
  // skips RunEvent::Exit) — an orphaned server then keeps port 4317 + stale in-memory measure state
  // while re-writing its persist file (the 유령 측정 세션 incident). Orphaned ⇒ ppid becomes 1 ⇒ exit.
  if (process.env.BATTERY_SIDECAR === '1') {
    setInterval(() => { if (process.ppid === 1) { measurePersist(); process.exit(0); } }, 5000);
  }
  let binds = 0;
  server.on('error', e => {   // EADDRINUSE etc. — say what happened instead of an unhandled crash
    if (e.code === 'EADDRINUSE' && ++binds <= 6) {   // predecessor may still be releasing the port (reaped orphan)
      console.error(`port ${PORT} busy — retry ${binds}/6`);
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 500);
      return;
    }
    console.error(e.code === 'EADDRINUSE'
      ? `error: port ${PORT} is already in use — another viewer running? (PORT=<n> to change)`
      : `server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`3d-battery-life ▶  http://localhost:${PORT}   (samples: ${path.join(userDataDir(), 'samples.jsonl')})`));
  return server;
}

// auto-start only for `node server.js` (NOT when imported by the CLI or compiled into the binary,
// which would double-bind the port). The CLI's `serve` command calls startServer() itself.
if ((process.argv[1] || '').endsWith('server.js')) startServer();
