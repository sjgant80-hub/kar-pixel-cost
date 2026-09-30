#!/usr/bin/env node
// tools/readback.mjs — the paid read-back, exactly as sealed in data/readback-prereg.json. Each picture goes, ALONE,
// to claude-sonnet-5 through the official claude CLI: no tools, no MCP, an empty working directory, the sealed system
// line and instruction, the image sent as a content block on stdin. The model never sees the source text. Transcripts,
// the CLI's init receipt (tools, MCP servers, credential source) and the provider's token counts are written out;
// grading is the kernel's, later, not a model's.
//
// Spend is governed by si-didy's purse: opened with a ceiling of one call per picture and a token cap, asked BEFORE
// every call, charged after with what the provider reported. This script never reads or handles a credential — the
// CLI does, as it does for everything else on this machine.
//   node tools/readback.mjs --plumbing   the one calibration picture → data/readback-plumbing.json
//   node tools/readback.mjs              the 64 held-out pictures → data/readback.json (needs a passed plumbing check)
// Both refuse unless the pre-registration is committed and on GitHub, and both run once.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const J = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const PLUMBING = process.argv.includes('--plumbing');
const OUT = join(ROOT, 'data', PLUMBING ? 'readback-plumbing.json' : 'readback.json');
const die = (m) => { console.error(m); process.exit(1); };
if (existsSync(OUT)) die(OUT.split(/[\\/]/).pop() + ' exists — it runs once');

// seal before you spend: the pre-registration must be committed AND on GitHub before the first paid call
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', 'data/readback-prereg.json', 'tools/readback.mjs', 'kernel.mjs')) die('commit the pre-registration, the runner and the kernel first');
git('fetch', '-q', 'origin');
const sealedIn = git('log', '-1', '--format=%H', '--', 'data/readback-prereg.json');
if (!sealedIn) die('data/readback-prereg.json is not committed');
try { git('merge-base', '--is-ancestor', 'HEAD', 'origin/master'); } catch { die('push first — HEAD is not on origin/master'); }
const pre = J('data/readback-prereg.json');
const preSha = createHash('sha256').update(readFileSync(join(ROOT, 'data', 'readback-prereg.json'))).digest('hex');

// what gets read, and the sealed hash of each picture
const renders = J('data/renders.json');
const pngSha = Object.fromEntries(renders.renders.map((r) => [r.id, r.pngSha256]));
let ids;
if (PLUMBING) ids = [pre.plumbing.id];
else {
  if (!existsSync(join(ROOT, 'data', 'readback-plumbing.json'))) die('run the plumbing check first: node tools/readback.mjs --plumbing');
  const p = J('data/readback-plumbing.json');
  if (!p.pass) die('the plumbing check did not pass — fix the pipe and amend the pre-registration first');
  ids = pre.heldout.ids;
  const sealedIds = J('data/prereg.json').heldout.ids;
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...sealedIds].sort())) die('the read-back ids are not the sealed held-out ids');
}

// the purse — si-didy's route for paid calls; its caps come from the pre-registration, not from this script
const cap = PLUMBING ? pre.purse.plumbing : pre.purse.heldout;
process.env.SOUL_MAX_CALLS = String(cap.calls);
process.env.SOUL_MAX_TOKENS = String(cap.tokens);
const PURSE = process.env.PURSE_MODULE || join(homedir(), 'si-didy', 'purse.mjs');
const { openPurse, mayCall, charged, state, proves } = await import(pathToFileURL(PURSE).href);
const purse = await openPurse();

// the CLI, spawned directly (no shell — a shell mangles long arguments on Windows), as si-didy does
const CLI = (() => {
  const npm = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : join(homedir(), '.npm-global');
  for (const p of [join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'), join(homedir(), '.local', 'bin', 'claude')]) if (existsSync(p)) return p;
  return null;
})();
if (!CLI) die('the claude CLI binary was not found');
const args = pre.call.args.map((a) => (a === '<system>' ? pre.call.system : a));

function readOne(id) {
  return new Promise((done) => {
    const cwd = mkdtempSync(join(tmpdir(), 'kar-readback-'));
    const child = spawn(CLI, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', init = null, result = null;
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') init = ev;
        else if (ev.type === 'result') { result = ev; child.stdin.end(); }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { rmSync(cwd, { recursive: true, force: true }); } catch {}
      done({ code, init, result, stderr: err.slice(0, 300) });
    });
    const png = readFileSync(join(ROOT, 'data', 'images', id + '.png')).toString('base64');
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: pre.call.instruction },
    ] } }) + '\n');
  });
}

const rows = [];
for (const id of ids) {
  const png = readFileSync(join(ROOT, 'data', 'images', id + '.png'));
  if (createHash('sha256').update(png).digest('hex') !== pngSha[id]) die(id + '.png is not the sealed picture');
  const may = await mayCall(purse, 'subscription-cli');
  if (!may.ok) { console.error('the purse refused call ' + (rows.length + 1) + ': ' + may.why); rows.push({ id, refused: may.why }); continue; }
  const r = await readOne(id);
  const res = r.result || {};
  const u = res.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const usage = { input_tokens: input, output_tokens: u.output_tokens || 0 };
  if (r.result) await charged(purse, usage);
  const row = {
    id,
    ok: !!r.result && !res.is_error,
    transcript: typeof res.result === 'string' ? res.result : null,
    usage, rawUsage: u, modelUsage: res.modelUsage || null, cliCostUsd: res.total_cost_usd ?? null,
    turns: res.num_turns ?? null, ms: res.duration_ms ?? null,
    init: r.init ? { model: r.init.model, tools: r.init.tools, mcp_servers: r.init.mcp_servers, apiKeySource: r.init.apiKeySource, version: r.init.claude_code_version || null } : null,
    receipt: (await proves(purse, purse.receipts.length - 1)).ok,
  };
  if (!row.ok) row.error = (res.subtype || 'no result') + (r.stderr ? ' · ' + r.stderr : '');
  rows.push(row);
  console.log((rows.length + '/' + ids.length).padStart(5) + '  ' + id.padEnd(12) + (row.ok ? ' ok  in ' + usage.input_tokens + ' out ' + usage.output_tokens : ' FAILED ' + row.error));
}

const st = state(purse);
const out = { kind: PLUMBING ? 'kar-pixel-cost-readback-plumbing' : 'kar-pixel-cost-readback', v: 1, sealedIn, preregSha256: preSha, ranAt: new Date().toISOString(), purse: { line: st.line, calls: st.calls, tokens: st.tokens, refused: st.refused, lastRefusal: st.lastRefusal }, rows };
if (PLUMBING) {
  const r = rows[0], counted = pre.plumbing.countedImageTokens;
  const models = r.modelUsage ? Object.keys(r.modelUsage) : [];
  const checks = [
    ['the call succeeds', !!r.ok],
    ['no tools and no MCP servers', !!r.init && Array.isArray(r.init.tools) && r.init.tools.length === 0 && Array.isArray(r.init.mcp_servers) && r.init.mcp_servers.length === 0],
    ['only claude-sonnet-5 was used', models.length > 0 && models.every((m) => m.startsWith('claude-sonnet-5'))],
    ['input ≤ counted image tokens + 300 (' + (r.usage ? r.usage.input_tokens : '?') + ' ≤ ' + (counted + 300) + ')', !!r.usage && r.usage.input_tokens <= counted + 300],
  ];
  out.checks = checks.map(([what, pass]) => ({ what, pass }));
  out.pass = checks.every(([, p]) => p);
  for (const [what, pass] of checks) console.log((pass ? '  ✓ ' : '  ✗ ') + what);
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log((PLUMBING ? 'plumbing ' + (out.pass ? 'PASSED' : 'FAILED') : 'read back ' + rows.filter((r) => r.ok).length + ' of ' + ids.length + ' pictures') + ' · ' + st.line);
