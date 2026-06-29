// Tiny zero-dependency server: serves the web app + live /api/report & /api/rates.
// Exposed as startServer() so the npx CLI and the compiled single-binary can reuse it;
// still runs directly via `node server.js`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSamples, buildReport } from './lib/report.js';
import { analyzeRates } from './lib/bucketRates.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const fileFor = sp => sp === 'demo' ? 'demo.jsonl' : sp === 'demo2' ? 'demo2.jsonl' : 'samples.jsonl';

// In dev, assets sit next to this file. In a bun-compiled binary the source lives in a
// virtual fs (no web/ there) → fall back to the directory of the executable.
function resolveRoot(root) {
  if (root) return root;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exe = path.dirname(process.execPath);
  // dev (next to source) · compiled binary (next to exe) · Tauri .app (Contents/Resources) · cwd
  for (const c of [here, exe, path.join(exe, '..', 'Resources'), process.cwd()]) {
    try { if (fs.existsSync(path.join(c, 'web'))) return c; } catch { /* ignore */ }
  }
  return exe;
}

export function startServer({ root, port } = {}) {
  const base = resolveRoot(root);
  const PORT = port || process.env.PORT || 4317;
  const webDir = fs.realpathSync(path.join(base, 'web'));
  const dataDir = path.join(base, 'data');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/report') {
      try {
        const report = buildReport(readSamples(path.join(dataDir, fileFor(url.searchParams.get('source')))));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (url.pathname === '/api/rates') {
      const level = url.searchParams.get('level') === 'rawcap' ? 'rawcap' : 'pct';
      const period = url.searchParams.get('period');
      try {
        const r = analyzeRates(readSamples(path.join(dataDir, fileFor(url.searchParams.get('source')))), { level, period });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ opt: r.opt, spans: r.spans, atoms: r.atoms, byBand: r.byBand, periods: r.periods, perCell: r.perCell }));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
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
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`3d-battery-life ▶  http://localhost:${PORT}   (data: ${dataDir})`));
  return server;
}

// auto-start only for `node server.js` (NOT when imported by the CLI or compiled into the binary,
// which would double-bind the port). The CLI's `serve` command calls startServer() itself.
if ((process.argv[1] || '').endsWith('server.js')) startServer();
