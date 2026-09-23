#!/usr/bin/env node
// gen-holdout.mjs — generates the anti-contamination fidelity test set. Deterministic (seeded),
// but its OUTPUT VALUES are never printed to stdout — only a confirmation message and the
// resulting file paths. The values live ONLY in ground-truth.json until the comparison step,
// specifically so that generating this file does not put the plaintext values into the visible
// transcript of the session that will later "read" the rendered image. This is the harness's
// actual defense against contamination, not just a stated intention.
import { writeFileSync } from 'node:fs';

const SEED = 20260923;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; }; }
const r = rng(SEED);

const WORDS = ['zephyr','quartz','ember','flux','onyx','cobalt','pixel','fable','granite','marble','ripple','vortex'];
const rows = [];
for (let i = 0; i < 10; i++) {
  const word = WORDS[r() % WORDS.length];
  const code = 1000 + (r() % 9000);
  rows.push({ word, code });
}

writeFileSync(new URL('./ground-truth.json', import.meta.url), JSON.stringify({ seed: SEED, rows }, null, 1));
const lines = rows.map((row) => row.word + ': ' + row.code).join('\n');
writeFileSync(new URL('./holdout-text.txt', import.meta.url), lines);

console.log('generated ' + rows.length + ' held-out rows (seed ' + SEED + ') -> ground-truth.json + holdout-text.txt. Values not printed here on purpose.');
