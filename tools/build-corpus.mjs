#!/usr/bin/env node
// tools/build-corpus.mjs — the v2 corpus: 96 samples, eight content shapes × 12, every one real text from the estate
// or seeded random bytes, each with its provenance (repository, file, commit). Built once and committed
// (data/corpus.json); its sha256 goes into the pre-registration, so the samples cannot change after the law is fixed.
//   node tools/build-corpus.mjs [--from <dir holding the source repositories>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FROM = resolve(process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : join(ROOT, '..'));
const SEED = 20260930, PER_SHAPE = 12, MIN = 280, MAX = 460;
const SHAPES = ['prose', 'law', 'code', 'json', 'keyvalue', 'csv', 'hex', 'base64'];

// mulberry32 — a small seeded PRNG, so the draw is reproducible
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(SEED);
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = (repo) => execFileSync('git', ['-C', join(FROM, repo), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const cut = (s, max = MAX) => { if (s.length <= max) return s; const i = s.lastIndexOf(' ', max); return s.slice(0, i > MIN ? i : max); };
const inRange = (s) => s.length >= MIN && s.length <= MAX;

const candidates = Object.fromEntries(SHAPES.map((k) => [k, []]));
const add = (shape, text, source) => { if (inRange(text)) candidates[shape].push({ text, source }); };

// prose — paragraphs from the estate's READMEs, markdown stripped to plain sentences
for (const repo of ['fallfloor', 'fallfloor-enterprise', 'fallstack', 'fall-euaiact', 'konomify', 'kar-pixel-cost', 'fallforgemint', 'dual-map']) {
  const p = join(FROM, repo, 'README.md');
  if (!existsSync(p)) continue;
  const at = repo + '@' + sha(repo) + ':README.md';
  for (const para of read(p).split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t || /^(#|-|\*|\||```|>|\d+\.|<)/.test(t) || t.includes('```')) continue;
    const plain = t.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s*\n\s*/g, ' ').trim();
    if (/https?:\/\//.test(plain)) continue;
    add('prose', cut(plain), at);
  }
}
// law — the statutory quotes in fall-euaiact's verified law, packed into passages
{
  const L = JSON.parse(read(join(FROM, 'fall-euaiact', 'law', 'law.json')));
  const at = 'fall-euaiact@' + sha('fall-euaiact') + ':law/law.json';
  const quotes = L.duties.map((d) => d.quote.trim());
  for (let i = 0; i < quotes.length; i++) {
    let s = '';
    for (let j = i; j < quotes.length && s.length < MIN; j++) s = s ? s + ' ' + quotes[j] : quotes[j];
    add('law', cut(s), at);
  }
}
// code — consecutive lines from the estate's gated kernels, newlines kept
for (const [repo, file] of [['fallstack', 'prices.mjs'], ['fallstack', 'stack.mjs'], ['fall-euaiact', 'comply.mjs'], ['fall-euaiact', 'kernel.mjs'], ['fallfloor-enterprise', 'kernel.mjs'], ['konomify', 'konomify.mjs'], ['fallfloor', 'kernel.mjs']]) {
  const p = join(FROM, repo, file);
  if (!existsSync(p)) continue;
  const at = repo + '@' + sha(repo) + ':' + file;
  const lines = read(p).split('\n');
  for (let i = 0; i < lines.length; i += 7) {
    let s = '';
    for (let j = i; j < lines.length && s.length < MIN; j++) s = s ? s + '\n' + lines[j] : lines[j];
    if (s.length > MAX) s = s.slice(0, s.lastIndexOf('\n', MAX) > MIN ? s.lastIndexOf('\n', MAX) : MAX);
    if (s.trim().length > MIN * 0.9) add('code', s, at);
  }
}
// json, keyvalue, csv — fallstack's price registry, the estate's real data
{
  const reg = JSON.parse(read(join(FROM, 'fallstack', 'registry', 'prices.json')));
  const at = 'fallstack@' + sha('fallstack') + ':registry/prices.json';
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, pre + k + '.') : [pre + k + '=' + (Array.isArray(v) ? v.join('|') : String(v))]));
  for (const e of reg.entries) {
    const j = JSON.stringify(e);
    add('json', j.length <= MAX ? j : j.slice(0, j.lastIndexOf(',', MAX)) , at);
    const kv = flat(e);
    let s = '';
    for (const line of kv) { if ((s + '\n' + line).length > MAX) break; s = s ? s + '\n' + line : line; }
    add('keyvalue', s, at);
  }
  const rows = reg.entries.map((e) => [e.id, e.kind, e.price ?? e.value ?? e.inPerM ?? e.gbpPerUsd ?? e.pencePerKwh ?? e.wattsLow ?? e.low ?? '', e.currency ?? '', e.checked].join(','));
  for (let i = 0; i < rows.length; i++) {
    let s = 'id,kind,figure,currency,checked';
    for (let j = i; j < rows.length && s.length < MIN; j++) s += '\n' + rows[j];
    if (s.length > MAX) s = s.slice(0, s.lastIndexOf('\n', MAX));
    add('csv', s, at);
  }
}
// hex, base64 — seeded random bytes: no structure a tokenizer or a picture can exploit
for (let i = 0; i < PER_SHAPE * 2; i++) {
  const n = 220 + Math.floor(R() * 110);
  const bytes = Buffer.from(Array.from({ length: n }, () => Math.floor(R() * 256)));
  add('hex', bytes.toString('hex').slice(0, MAX), 'seeded bytes (mulberry32, seed ' + SEED + ')');
  add('base64', bytes.toString('base64').slice(0, MAX), 'seeded bytes (mulberry32, seed ' + SEED + ')');
}

const samples = [];
for (const shape of SHAPES) {
  const pool = shuffle(candidates[shape].filter((c, i, a) => a.findIndex((x) => x.text === c.text) === i));
  if (pool.length < PER_SHAPE) { console.error('not enough ' + shape + ' candidates: ' + pool.length); process.exit(1); }
  pool.slice(0, PER_SHAPE).forEach((c, k) => samples.push({ id: shape + '-' + String(k + 1).padStart(2, '0'), shape, chars: c.text.length, text: c.text, source: c.source }));
}
// the split: four of each shape calibrate the law, eight are held out — drawn by the same seeded PRNG
const split = {};
for (const shape of SHAPES) shuffle(samples.filter((s) => s.shape === shape).map((s) => s.id)).forEach((id, k) => { split[id] = k < 4 ? 'calibration' : 'heldout'; });
for (const s of samples) s.split = split[s.id];
const corpus = { kind: 'kar-pixel-cost-corpus', v: 2, seed: SEED, shapes: SHAPES, perShape: PER_SHAPE, charRange: [MIN, MAX], samples };
const text = JSON.stringify(corpus, null, 1) + '\n';
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'corpus.json'), text);
console.log('corpus: ' + samples.length + ' samples · ' + SHAPES.map((s) => s + ' ' + candidates[s].length).join(', ') + ' candidates · sha256 ' + createHash('sha256').update(text).digest('hex'));
