#!/usr/bin/env node
// tools/render-corpus.mjs — render every corpus sample with the v2 renderer in headless Chrome (driven over the
// DevTools protocol; a throwaway localhost file server only so the page can import the kernel). Writes each PNG to
// data/images/<id>.png and data/renders.json with its size, the canvas metrics, and whether the kernel's imageSize
// predicted that size exactly (it must, for every sample, or the run stops).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const K = await import(new URL('../kernel.mjs', import.meta.url).href);
const corpus = JSON.parse(readFileSync(join(ROOT, 'data', 'corpus.json'), 'utf8'));

// a localhost-only static server for the repository (the page imports ../kernel.mjs as a module)
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'pixcost-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu', 'http://127.0.0.1:' + port + '/tools/render-v2.html'], { stdio: 'ignore' });
const wsUrl = await (async () => {
  for (let i = 0; i < 100; i++) {
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) {
      const [p] = readFileSync(f, 'utf8').split('\n');
      const list = await (await fetch('http://127.0.0.1:' + p + '/json')).json().catch(() => []);
      const page = list.find((t) => t.type === 'page' && t.url.includes('render-v2'));
      if (page) return page.webSocketDebuggerUrl;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome did not open the renderer');
})();
const ws = new WebSocket(wsUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let seq = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
const evaluate = (expression) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, (m) => (m.error || m.result.exceptionDetails ? no(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 300))) : ok(m.result.result.value))); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
for (let i = 0; i < 50 && !(await evaluate('window.__ready === true')); i++) await new Promise((r) => setTimeout(r, 200));

mkdirSync(join(ROOT, 'data', 'images'), { recursive: true });
const renders = [];
let metrics = null;
for (const s of corpus.samples) {
  const r = await evaluate('window.__render2(' + JSON.stringify(s.text) + ')');
  if (!r || !r.ok) throw new Error(s.id + ': ' + JSON.stringify(r));
  metrics = r.metrics;
  const predicted = K.imageSize(s.text, r.metrics);
  if (predicted.width !== r.width || predicted.height !== r.height) throw new Error(s.id + ': the kernel predicted ' + predicted.width + '×' + predicted.height + ', the canvas drew ' + r.width + '×' + r.height);
  const png = Buffer.from(r.dataUrl.split(',')[1], 'base64');
  writeFileSync(join(ROOT, 'data', 'images', s.id + '.png'), png);
  const f = K.tokensForImage(r.width, r.height);
  renders.push({ id: s.id, width: r.width, height: r.height, lines: r.lines, formula: f.tokens, pngSha256: createHash('sha256').update(png).digest('hex'), bytes: png.length });
}
ws.close(); chrome.kill(); server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold the profile a moment */ }
writeFileSync(join(ROOT, 'data', 'renders.json'), JSON.stringify({ kind: 'kar-pixel-cost-renders', v: 2, metrics, renders }, null, 1) + '\n');
console.log('rendered ' + renders.length + ' samples · metrics ' + JSON.stringify(metrics) + ' · every size predicted exactly by the kernel · heights ' + Math.min(...renders.map((r) => r.height)) + '–' + Math.max(...renders.map((r) => r.height)) + 'px');
