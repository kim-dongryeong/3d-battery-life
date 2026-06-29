// Tiny zero-dependency server: serves the web app and a live /api/report
// computed from the JSONL logs. No build step.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSamples, buildReport } from './lib/report.js';
import { analyzeRates } from './lib/bucketRates.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4317;
const webDir = fs.realpathSync(path.join(dir, 'web'));   // canonical base for containment checks
const dataDir = path.join(dir, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/report') {
    const sp = url.searchParams.get('source'); const source = sp === 'demo' ? 'demo.jsonl' : sp === 'demo2' ? 'demo2.jsonl' : 'samples.jsonl';
    try {
      const report = buildReport(readSamples(path.join(dataDir, source)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/rates') {
    const sp = url.searchParams.get('source'); const source = sp === 'demo' ? 'demo.jsonl' : sp === 'demo2' ? 'demo2.jsonl' : 'samples.jsonl';
    const level = url.searchParams.get('level') === 'rawcap' ? 'rawcap' : 'pct';
    const period = url.searchParams.get('period');                    // day | week | month
    try {
      const r = analyzeRates(readSamples(path.join(dataDir, source)), { level, period });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ opt: r.opt, spans: r.spans, atoms: r.atoms, byBand: r.byBand, periods: r.periods, perCell: r.perCell }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  // resolve symlinks and confirm the REAL target is still inside webDir
  fs.realpath(file, (e, real) => {
    if (e || path.relative(webDir, real).startsWith('..')) { res.writeHead(404); res.end('not found'); return; }
    fs.readFile(real, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(real)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`3d-battery-life ▶  http://localhost:${PORT}`));
