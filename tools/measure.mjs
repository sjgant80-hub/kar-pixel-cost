#!/usr/bin/env node
// tools/measure.mjs — the real counts: Anthropic's /v1/messages/count_tokens for each sample's text and for its
// rendered PNG, same model as v1 (claude-sonnet-5). Same security pattern as count-tokens.mjs: the credential is
// resolved by auth.mjs and used ONLY in a request header — never printed, logged or written; only the integer
// counts leave this script. Counting is free; nothing is generated.
//   node tools/measure.mjs --split calibration|heldout
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolve as resolveAuth, OAUTH_BETA } from '../auth.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const split = process.argv[process.argv.indexOf('--split') + 1];
if (!['calibration', 'heldout'].includes(split)) { console.error('usage: measure.mjs --split calibration|heldout'); process.exit(2); }
const out = join(ROOT, 'data', 'counts-' + split + '.json');
if (existsSync(out)) { console.error(out + ' exists — counts are measured once; delete it by hand only if a run failed part-way'); process.exit(1); }
if (split === 'heldout' && !existsSync(join(ROOT, 'data', 'prereg.json'))) { console.error('the held-out samples are counted only after the pre-registration is sealed (data/prereg.json)'); process.exit(1); }

const MODEL = 'claude-sonnet-5';
const corpus = JSON.parse(readFileSync(join(ROOT, 'data', 'corpus.json'), 'utf8'));
const auth = await resolveAuth();
if (auth.tier !== 'oauth' && auth.tier !== 'byok') { console.error('no frontier tier reachable: ' + auth.why); process.exit(1); }
const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
if (auth.tier === 'byok') headers['x-api-key'] = auth.key; else { headers.Authorization = 'Bearer ' + auth.key; headers['anthropic-beta'] = OAUTH_BETA; }
const count = async (content) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }] }) });
    if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
    const body = await r.text();
    if (!r.ok) throw new Error('API ' + r.status + ': ' + body.slice(0, 200));
    return JSON.parse(body).input_tokens;
  }
  throw new Error('rate-limited four times running');
};
const rows = [];
for (const s of corpus.samples.filter((x) => x.split === split)) {
  const png = readFileSync(join(ROOT, 'data', 'images', s.id + '.png')).toString('base64');
  const textTokens = await count([{ type: 'text', text: s.text }]);
  const imageTokens = await count([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
  rows.push({ id: s.id, textTokens, imageTokens });
  await new Promise((ok) => setTimeout(ok, 250));
}
const d = new Date();
writeFileSync(out, JSON.stringify({ kind: 'kar-pixel-cost-counts', v: 2, split, model: MODEL, endpoint: 'https://api.anthropic.com/v1/messages/count_tokens', measuredAt: d.toISOString(), rows }, null, 1) + '\n');
console.log('counted ' + rows.length + ' ' + split + ' samples (text and image each) → ' + out.replace(ROOT, '.'));
