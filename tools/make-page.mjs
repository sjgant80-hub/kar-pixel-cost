#!/usr/bin/env node
// tools/make-page.mjs — the fixpoint. index.html runs the SAME kernel.mjs the tests and the mutation gate prove, over
// the committed findings: v1's three samples (findings.json) and v2's pre-registered corpus, renders and real counts
// (data/). The v2 headline in README.md and llms.txt is generated from the same kernel, so no v2 number is typed.
// CI regenerates all three and fails if any differs.
import { readFileSync, writeFileSync } from 'node:fs';
const at = (f) => new URL('../' + f, import.meta.url);
const read = (f) => readFileSync(at(f), 'utf8').replace(/\r\n/g, '\n');
const json = (f) => JSON.parse(read(f));
const K = await import(at('kernel.mjs').href);
const kernel = read('kernel.mjs').replace(/^export /gm, '').trimEnd();
const findings = read('findings.json').trim();

const corpus = json('data/corpus.json'), renders = json('data/renders.json'), prereg = json('data/prereg.json');
const cal = json('data/counts-calibration.json'), held = json('data/counts-heldout.json');
const V2 = {
  model: held.model, calibratedAt: cal.measuredAt, heldoutAt: held.measuredAt, metrics: renders.metrics, prereg,
  preregCommit: 'fbeb925', preregSha256: 'f926d3439a6ebc2fe012a2d0a40efb87e80eee5b03cf15c4200afea38ee46ab9',
  samples: corpus.samples.map((s) => ({ id: s.id, shape: s.shape, split: s.split, chars: s.chars, source: s.source, text: s.text })),
  renders: renders.renders.map((r) => ({ id: r.id, width: r.width, height: r.height, formula: r.formula })),
  calibration: cal.rows, heldout: held.rows,
};

// the scored result, through the gated kernel
const rid = Object.fromEntries(V2.renders.map((r) => [r.id, r])), sid = Object.fromEntries(V2.samples.map((s) => [s.id, s]));
const refit = K.fitLaw(cal.rows.map((r) => ({ formula: rid[r.id].formula, real: r.imageTokens })));
if (!refit.ok || refit.a !== prereg.law.a || refit.b !== prereg.law.b) { console.error('the calibration counts no longer give the pre-registered law'); process.exit(1); }
const sc = K.score(held.rows.map((r) => ({ id: r.id, shape: sid[r.id].shape, chars: sid[r.id].chars, textTokens: r.textTokens, formula: rid[r.id].formula, real: r.imageTokens })), prereg.law, prereg.thumb.cStar);
const j = K.judge(sc);
if (!sc.ok || !j.ok) { console.error('the kernel refused the committed data'); process.exit(1); }
const pct = (x) => Math.round(x * 1000) / 10 + '%';
const RULE_TEXT = Object.fromEntries(prereg.rules.map((r) => [r.id, r.rule]));

// ── v2b: the read-back — every transcript graded here by the kernel against the committed source, and the spend
// priced by the kernel from the provider's own counts at the locked list price. No read-back number is typed.
const rbPre = json('data/readback-prereg.json'), rb = json('data/readback.json');
const plumbs = [json('data/readback-plumbing-1.json'), json('data/readback-plumbing.json')];
const lock = json('prices.lock.json');
const price = lock.entries.find((e) => e.id === rbPre.call.model), fx = lock.entries.find((e) => e.id === 'fx-gbp-usd').gbpPerUsd;
const kinds = (u) => {
  const cc = u.cache_creation || {}, w5 = cc.ephemeral_5m_input_tokens || 0, w1 = cc.ephemeral_1h_input_tokens || 0;
  if ((u.cache_creation_input_tokens || 0) !== w5 + w1) { console.error('a cache write is not split into 5m and 1h'); process.exit(1); }
  return { input_tokens: u.input_tokens, cache_write_5m: w5, cache_write_1h: w1, cache_read: u.cache_read_input_tokens || 0, output_tokens: u.output_tokens };
};
V2.readback = {
  sealCommit: 'cfdb150', amendCommit: rb.sealedIn.slice(0, 7), preregSha256: rb.preregSha256,
  system: rbPre.call.system, instruction: rbPre.call.instruction, model: rbPre.call.model, rules: rbPre.rules, predictions: rbPre.predictions,
  amendment: rbPre.amendments[0], cacheMultiples: rbPre.cacheMultiples, price: { inPerM: price.inPerM, outPerM: price.outPerM, currency: price.currency, source: price.source }, gbpPerUsd: fx,
  cheaperAsImage: rbPre.heldout.cheaperAsImage, credential: [...new Set(rb.rows.map((r) => r.init && r.init.apiKeySource))], cli: [...new Set(rb.rows.map((r) => r.init && r.init.version))],
  purse: rb.purse.line, ranAt: rb.ranAt, cliUsd: Math.round(rb.rows.reduce((a, r) => a + (r.cliCostUsd || 0), 0) * 1e4) / 1e4,
  rows: rb.rows.map((r) => ({ id: r.id, ok: !!r.ok, transcript: r.ok ? r.transcript : null, usage: r.rawUsage ? kinds(r.rawUsage) : null })),
  plumbing: plumbs.map((p) => ({ pass: p.pass, usage: kinds(p.rows[0].rawUsage), transcript: p.rows[0].transcript, id: p.rows[0].id })),
};
const RBV = V2.readback, rbRow = Object.fromEntries(RBV.rows.map((r) => [r.id, r])), hc = Object.fromEntries(held.rows.map((r) => [r.id, r]));
const rbRows = rbPre.heldout.ids.map((id) => {
  const r = rbRow[id], g = K.gradeRead(K.expectedLayout(sid[id].text, renders.metrics), r && r.ok ? r.transcript : '');
  return { id, shape: sid[id].shape, contentExact: g.contentExact, layoutExact: g.layoutExact, contentCer: g.contentCer, cheaperAsImage: RBV.cheaperAsImage.includes(id), saved: hc[id].textTokens - hc[id].imageTokens };
});
const rj = K.readbackJudge(rbRows);
const spHeld = K.spend(RBV.rows.filter((r) => r.usage).map((r) => r.usage), price, fx, RBV.cacheMultiples);
const spAll = K.spend([...RBV.rows.filter((r) => r.usage).map((r) => r.usage), ...RBV.plumbing.map((p) => p.usage)], price, fx, RBV.cacheMultiples);
if (!rj.ok || !spHeld.ok || !spAll.ok) { console.error('the kernel refused the read-back data'); process.exit(1); }
const banked = rbRows.filter((r) => r.cheaperAsImage && r.contentExact), cheap = rbRows.filter((r) => r.cheaperAsImage);
const sum = (rs) => rs.reduce((a, r) => a + r.saved, 0);
const byShape = {};
for (const r of rbRows) { const t = (byShape[r.shape] ||= { n: 0, exact: 0, layout: 0, cers: [] }); t.n++; t.exact += r.contentExact; t.layout += r.layoutExact; t.cers.push(r.contentCer); }
const RB_RULE_TEXT = Object.fromEntries(rbPre.rules.map((r) => [r.id, r.rule]));
const cerPct = (x) => Math.round(x * 10000) / 100 + '%';
const L = [];
L.push('**v2 · the crossover law — pre-registered, ' + V2.samples.length + ' samples, ' + j.passed + ' of ' + j.of + ' rules passed.**');
L.push('');
L.push('The real image cost is predictable from pixel size alone: real = ' + prereg.law.a + ' × ceil(w×h/750) + ' + prereg.law.b + ' tokens, fitted on ' + prereg.law.n + ' calibration samples and sealed (commit ' + V2.preregCommit + ') before the ' + sc.n + ' held-out samples were counted. On the held-out samples it was off by ' + sc.medianAbsErrPct + '% at the median and ' + sc.maxAbsErrPct + '% at worst, and with the text token count it picked the cheaper encoding ' + pct(sc.lawAccuracy) + ' of the time. Characters per text token alone — v1\'s framing — picked right only ' + pct(sc.thumbAccuracy) + ' of the time: an image pays for its rendered area, and short lines waste it.');
L.push('');
L.push('| Shape | Cheaper as an image | Mean image vs text | Read back exactly |');
L.push('|---|---|---|---|');
for (const [k, t] of Object.entries(j.tally)) L.push('| ' + k + ' | ' + t.image + ' of ' + t.n + (t.tie ? ' (' + t.tie + ' tied)' : '') + ' | ' + (t.meanPct > 0 ? '+' : '') + t.meanPct + '% | ' + byShape[k].exact + ' of ' + byShape[k].n + ' |');
L.push('');
L.push('| Pre-registered rule | Result | |');
L.push('|---|---|---|');
for (const r of j.rules) L.push('| ' + RULE_TEXT[r.id] + ' | ' + r.value + ' | ' + (r.pass ? 'PASS' : 'FAIL') + ' |');
L.push('');
L.push('Counts: Anthropic\'s /v1/messages/count_tokens, ' + V2.model + ', text and the rendered PNG for every sample. Whether the model reads them back is measured next.');
L.push('');
const fmt = (n) => n.toLocaleString('en-GB');
const misses = rbRows.filter((r) => !r.contentExact);
L.push('**v2b · the read-back — pre-registered, all ' + rbRows.length + ' held-out pictures, ' + rj.passed + ' of ' + rj.of + ' rules passed.**');
L.push('');
L.push('Each held-out picture was shown alone to ' + RBV.model + ' — the model whose tokens were counted — with one fixed instruction and no tools; it never saw the source text. Each transcript was graded by the kernel against the committed source, every non-whitespace character in order, with no model judging a model. The grading, the five bars and a prediction were sealed first (commit ' + RBV.sealCommit + ', amended before any held-out picture in ' + RBV.amendCommit + '). ' + (rbRows.length - misses.length) + ' of ' + rbRows.length + ' read back exactly and the median character error was ' + rj.rules.find((r) => r.id === 'median-cer').value.replace('median ', '') + '. Of the ' + cheap.length + ' samples cheaper as an image, ' + banked.length + ' read back exactly: ' + fmt(sum(banked)) + ' of the ' + fmt(sum(cheap)) + ' input tokens the pictures saved survive the read.');
L.push('');
L.push('| Pre-registered read-back rule | Result | | Predicted |');
L.push('|---|---|---|---|');
for (const r of rj.rules) L.push('| ' + RB_RULE_TEXT[r.id] + ' | ' + r.value + ' | ' + (r.pass ? 'PASS' : 'FAIL') + ' | ' + RBV.predictions[r.id] + ' |');
L.push('');
L.push('Every miss, where the source and the read first part (whitespace ignored):');
L.push('');
L.push('| Sample | Edits | Character error | Source | Read |');
L.push('|---|---|---|---|---|');
const span = (id) => {
  const r = rbRow[id], a = K.normalizeRead(K.expectedLayout(sid[id].text, renders.metrics)).replace(/\s+/g, ''), b = K.normalizeRead(r && r.ok ? r.transcript : '').replace(/\s+/g, '');
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let ea = a.length - 1, eb = b.length - 1; while (ea >= i && eb >= i && a[ea] === b[eb]) { ea--; eb--; }
  const cut = (s, from, to) => { const x = s.slice(Math.max(0, from - 4), to + 5); return (x.length > 34 ? x.slice(0, 16) + '…' + x.slice(-16) : x).replace(/\|/g, '\\|'); };
  return { edits: K.levenshtein(a, b), src: cut(a, i, ea), got: cut(b, i, eb) };
};
for (const r of misses) { const s = span(r.id); L.push('| ' + r.id + ' | ' + s.edits + ' | ' + cerPct(r.contentCer) + ' | `' + s.src + '` | `' + s.got + '` |'); }
L.push('');
// the worst miss, explained from the data: its longest run of one character in the source and in the read, and
// whether everything outside those runs matched
const longRun = (s) => { let best = { ch: '', n: 0 }; for (let i = 0; i < s.length;) { let k = i; while (k < s.length && s[k] === s[i]) k++; if (k - i > best.n) best = { ch: s[i], n: k - i }; i = k; } return best; };
const worst = rbRows.reduce((a, r) => (r.contentCer > a.contentCer ? r : a));
const wA = K.normalizeRead(K.expectedLayout(sid[worst.id].text, renders.metrics)).replace(/\s+/g, ''), wB = K.normalizeRead(rbRow[worst.id].transcript || '').replace(/\s+/g, '');
const ra = longRun(wA), rw = longRun(wB);
const cutRuns = (s, ch) => s.replace(new RegExp('(?:' + ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '){10,}', 'gu'), '¦');
const restExact = ra.n >= 10 && rw.n >= 10 && cutRuns(wA, ra.ch) === cutRuns(wB, rw.ch);
const runsOf = (s, ch) => (s.match(new RegExp('(?:' + ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '){10,}', 'gu')) || []).map((m) => [...m].length);
const lens = (xs) => [...new Set(xs)].join(' and ');
V2.readback.worst = { id: worst.id, cer: worst.contentCer, srcCh: ra.ch, srcRuns: runsOf(wA, ra.ch), readCh: rw.ch, readRuns: runsOf(wB, rw.ch), restExact };
const W = V2.readback.worst;
L.push('The worst miss, ' + worst.id + ', is one misread made ' + W.srcRuns.length + ' times: its source has ' + W.srcRuns.length + ' rulers of ' + lens(W.srcRuns) + ' × `' + W.srcCh + '` (U+' + W.srcCh.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + (W.srcCh.codePointAt(0) >= 0x2500 && W.srcCh.codePointAt(0) <= 0x257f ? ', box drawing' : '') + '), and the read gave ' + W.readRuns.length + ' of ' + lens(W.readRuns) + ' × `' + W.readCh + '`' + (restExact ? ' — every other character read exactly. A look-alike glyph in a long run is where exactness broke, not the words.' : '.'));
L.push('');
L.push('Spend: ' + spAll.calls + ' calls (' + spHeld.calls + ' held-out + ' + RBV.plumbing.length + ' plumbing checks), ' + fmt(spAll.input) + ' input tokens and ' + fmt(spAll.output) + ' output tokens by the provider\'s own count — **$' + spAll.usd.toFixed(4) + ' (£' + spAll.gbp.toFixed(4) + ')** at the ' + RBV.model + ' list price in prices.lock.json ($' + RBV.price.inPerM + ' in / $' + RBV.price.outPerM + ' out per million; 1-hour cache writes at ' + RBV.cacheMultiples.write1h + '×). The held-out run alone: $' + spHeld.usd.toFixed(4) + ' (£' + spHeld.gbp.toFixed(4) + '). Paid by the Claude subscription through the official claude CLI (credential source: ' + RBV.credential.join(', ') + ' — no API key), so this is what an API key would have paid, not new money. The CLI\'s own figure for the held-out run, $' + RBV.cliUsd.toFixed(4) + ', is ' + Math.round((RBV.cliUsd / spHeld.usd) * 100) / 100 + '× that: CLI ' + RBV.cli.join(', ') + ' still prices ' + RBV.model + ' at the rise Anthropic\'s pricing page says will not happen.');
const block = L.join('\n');

const swap = (text, begin, end, body, name) => {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) { console.error('markers missing in ' + name + ': ' + begin); process.exit(1); }
  return text.slice(0, a + begin.length) + '\n' + body + '\n' + text.slice(b);
};
const RB = '<!-- ⟦V2-RESULTS-BEGIN⟧ generated by tools/make-page.mjs — do not edit here -->', RE = '<!-- ⟦V2-RESULTS-END⟧ -->';
for (const f of ['README.md', 'llms.txt']) writeFileSync(at(f), swap(read(f), RB, RE, block, f));
let page = read('index.html');
page = swap(page, '// ⟦KERNEL-BEGIN⟧ generated from kernel.mjs by make-page.mjs — do not edit here', '// ⟦KERNEL-END⟧', kernel, 'index.html');
page = swap(page, '// ⟦FINDINGS-BEGIN⟧ generated from findings.json by make-page.mjs — do not edit here', '// ⟦FINDINGS-END⟧', 'const FINDINGS = ' + findings + ';', 'index.html');
page = swap(page, '// ⟦V2-BEGIN⟧ generated from data/ by tools/make-page.mjs — do not edit here', '// ⟦V2-END⟧', 'const V2 = ' + JSON.stringify(V2).replace(/</g, '\\u003c') + ';', 'index.html');
// the read-back's FAQ entry for answer engines — the same numbers, generated
const firstSlip = (id) => { const a = K.normalizeRead(K.expectedLayout(sid[id].text, renders.metrics)).replace(/\s+/g, ''), b = K.normalizeRead(rbRow[id].transcript || '').replace(/\s+/g, ''); let i = 0; while (i < a.length && a[i] === b[i]) i++; if (a.slice(i, i + 8) === b.slice(i + 1, i + 9)) return 'an extra ' + b[i]; if (a.slice(i + 1, i + 9) === b.slice(i, i + 8)) return a[i] + ' dropped'; return (a[i] || '∅') + ' read as ' + (b[i] || '∅'); };
const slipKinds = [...new Set(misses.map((r) => firstSlip(r.id)))];
const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Does a vision model read text rendered as an image back exactly?',
  acceptedAnswer: { '@type': 'Answer', text: 'Mostly, and not always. Shown only the picture, ' + RBV.model + ' read ' + (rbRows.length - misses.length) + ' of ' + rbRows.length + ' held-out samples back exactly, every non-whitespace character, graded deterministically against the source with no model as judge; the median character error was ' + rj.rules.find((r) => r.id === 'median-cer').value.replace('median ', '') + '. Of the ' + cheap.length + ' samples that were cheaper as an image, ' + banked.length + ' read back exactly. The misses were character slips, never words (' + slipKinds.join('; ') + '), and ' + rj.passed + ' of ' + rj.of + ' pre-registered rules passed. The ' + spHeld.calls + ' held-out reads cost $' + spHeld.usd.toFixed(4) + ' at list price.' } }] };
page = swap(page, '<!-- ⟦RB-FAQ-BEGIN⟧ generated by tools/make-page.mjs — do not edit here -->', '<!-- ⟦RB-FAQ-END⟧ -->', '<script type="application/ld+json">' + JSON.stringify(faq).replace(/</g, '\\u003c') + '</script>', 'index.html');
writeFileSync(at('index.html'), page);
console.log('page: kernel ' + kernel.length + ' chars · v2 data ' + JSON.stringify(V2).length + ' chars · ' + j.passed + '/' + j.of + ' rules · median ' + sc.medianAbsErrPct + '% · decision ' + pct(sc.lawAccuracy));
