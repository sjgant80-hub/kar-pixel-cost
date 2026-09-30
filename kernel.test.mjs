import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokensForImage, layoutPixels, wrapLines, imageSize, fitLaw, predictImage, cheaper, breakEven, score, shapeTally, judge } from './kernel.mjs';

// ── tokensForImage: Anthropic's published (w*h)/750 estimate ──
test('rejects non-integer or non-positive width/height', () => {
  assert.equal(tokensForImage(0, 100).ok, false);
  assert.equal(tokensForImage(100, 0).ok, false);
  assert.equal(tokensForImage(-5, 100).ok, false);
  assert.equal(tokensForImage(1.5, 100).ok, false);
  assert.equal(tokensForImage(100, 1.5).ok, false);
});
test('computes the documented formula exactly for a clean multiple of 750', () => {
  const r = tokensForImage(750, 1); // 750 px^2 / 750 = 1
  assert.equal(r.ok, true);
  assert.equal(r.tokens, 1);
});
test('rounds UP (ceil), not down, for a non-exact division — isolates the rounding direction', () => {
  const r = tokensForImage(751, 1); // 751/750 = 1.00133... -> ceil = 2
  assert.equal(r.tokens, 2);
});
test('a 1x1 image still costs at least 1 token (ceil of a tiny fraction)', () => {
  const r = tokensForImage(1, 1);
  assert.equal(r.tokens, 1);
});
test('a real-world example: a 1092x1092 image (Anthropic\'s own max-recommended edge) costs 1590 tokens', () => {
  const r = tokensForImage(1092, 1092);
  assert.equal(r.tokens, Math.ceil((1092 * 1092) / 750));
});

// ── layoutPixels: the pure layout math behind the renderer ──
test('rejects a negative or non-integer charCount', () => {
  assert.equal(layoutPixels(-1).ok, false);
  assert.equal(layoutPixels(1.5).ok, false);
});
test('rejects non-positive fontPx/charWidthPx/maxWidthPx/linePx, each in isolation', () => {
  assert.equal(layoutPixels(10, { fontPx: 0 }).ok, false);
  assert.equal(layoutPixels(10, { charWidthPx: 0 }).ok, false);
  assert.equal(layoutPixels(10, { maxWidthPx: 0 }).ok, false);
  assert.equal(layoutPixels(10, { linePx: 0 }).ok, false);
});
test('rejects opts that is null, an array, or a non-object, each isolated (exact why)', () => {
  assert.match(layoutPixels(10, null).why, /opts must be an object/);
  assert.match(layoutPixels(10, []).why, /opts must be an object/);
  assert.match(layoutPixels(10, 'nope').why, /opts must be an object/);
});
test('rejects fontPx=0 in isolation — other opts explicitly valid so only this clause can catch it', () => {
  // fontPx=0 alone would cascade (charWidthPx defaults to fontPx*0.6=0 too) and get caught by a
  // DIFFERENT clause, masking this boundary — override charWidthPx explicitly so only fontPx<=0
  // can be the reason.
  const r = layoutPixels(10, { fontPx: 0, charWidthPx: 8 });
  assert.equal(r.ok, false);
  assert.match(r.why, /fontPx must be a positive number/);
});
test('rejects a negative fontPx, isolated from the NaN/non-finite clause', () => {
  const r = layoutPixels(10, { fontPx: -5, charWidthPx: 8 });
  assert.equal(r.ok, false);
  assert.match(r.why, /fontPx must be a positive number/);
});
test('rejects a NaN fontPx, isolated from the <=0 clause (NaN<=0 is false)', () => {
  const r = layoutPixels(10, { fontPx: NaN, charWidthPx: 8 });
  assert.equal(r.ok, false);
  assert.match(r.why, /fontPx must be a positive number/);
});
test('zero characters still needs one line, not zero', () => {
  const r = layoutPixels(0);
  assert.equal(r.ok, true);
  assert.equal(r.lines, 1);
});
test('a short string fits on one line, width scales with character count', () => {
  const r = layoutPixels(10, { fontPx: 16, charWidthPx: 10, maxWidthPx: 640, linePx: 20 });
  assert.equal(r.lines, 1);
  assert.equal(r.width, 100); // 10 chars * 10px
  assert.equal(r.height, 20);
});
test('a string exceeding maxWidthPx wraps to multiple lines, isolated boundary', () => {
  // charWidthPx=10, maxWidthPx=100 -> 10 chars/line exactly
  const exact = layoutPixels(10, { charWidthPx: 10, maxWidthPx: 100, linePx: 20 });
  assert.equal(exact.lines, 1); // exactly fills one line
  const overOne = layoutPixels(11, { charWidthPx: 10, maxWidthPx: 100, linePx: 20 });
  assert.equal(overOne.lines, 2); // one char over -> wraps to a second line
});
test('height scales linearly with the number of wrapped lines', () => {
  const r = layoutPixels(35, { charWidthPx: 10, maxWidthPx: 100, linePx: 20 }); // 10 chars/line -> 4 lines
  assert.equal(r.lines, 4);
  assert.equal(r.height, 80);
});
test('width never exceeds maxWidthPx even for a very long string', () => {
  const r = layoutPixels(10000, { charWidthPx: 10, maxWidthPx: 640 });
  assert.equal(r.width, 640);
});
test('charsPerLine is at least 1 even with an absurdly wide charWidthPx', () => {
  const r = layoutPixels(5, { charWidthPx: 10000, maxWidthPx: 100 });
  assert.equal(r.charsPerLine, 1);
});

// ── fuzz: total, never throws ──
test('fuzz: garbage inputs never throw', () => {
  const garbage = [undefined, null, {}, [], () => {}, Symbol('x'), NaN, Infinity, -Infinity, '', 'x', true, new Date()];
  for (const g of garbage) {
    assert.doesNotThrow(() => tokensForImage(g, g));
    assert.doesNotThrow(() => layoutPixels(g));
    assert.doesNotThrow(() => layoutPixels(10, g));
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v2 · the crossover law
// ════════════════════════════════════════════════════════════════════════════════════════════════
const M = { charWidthPx: 8.796875, fontPx: 16, maxWidthPx: 640, pad: 12 };   // the real canvas metrics (data/renders.json)

test('wrapLines: word wrap, hard breaks on newlines, long words split across lines', () => {
  assert.deepEqual(wrapLines('ab cd', 4).lines, ['ab', 'cd']);
  assert.deepEqual(wrapLines('ab cd', 5).lines, ['ab cd']);
  assert.deepEqual(wrapLines('abcd', 4).lines, ['abcd']);
  assert.deepEqual(wrapLines('abcde', 4).lines, ['abcd', 'e']);
  assert.deepEqual(wrapLines('x abcdefghij y', 4).lines, ['x', 'abcd', 'efgh', 'ij y']);
  assert.deepEqual(wrapLines('abcdefgh', 4).lines, ['abcd', 'efgh']);
  assert.deepEqual(wrapLines('a\nb c', 10).lines, ['a', 'b c']);
  assert.deepEqual(wrapLines('a\n\nb', 10).lines, ['a', '', 'b']);
  assert.deepEqual(wrapLines('', 3).lines, ['']);
  assert.deepEqual(wrapLines('aa bb cc', 5).lines, ['aa bb', 'cc']);
  assert.deepEqual(wrapLines('a  b', 10).lines, ['a  b']);
  assert.deepEqual(wrapLines('abc', 1).lines, ['a', 'b', 'c']);
  assert.deepEqual(wrapLines('ab abcdefghij', 4).lines, ['ab', 'abcd', 'efgh', 'ij']);
  for (const [t, c, re] of [[1, 4, /text must be a string/], [null, 4, /text must be a string/], ['a', 0, /charsPerLine/], ['a', 1.5, /charsPerLine/], ['a', '4', /charsPerLine/]]) assert.match(wrapLines(t, c).why, re);
});

test('imageSize: the exact pixels the v2 renderer draws', () => {
  assert.deepEqual(imageSize('hello world', M), { ok: true, width: 640, height: 47, lines: 1, charsPerLine: 70, linePx: 23 });
  assert.deepEqual(imageSize('a\nb\nc', M), { ok: true, width: 640, height: 93, lines: 3, charsPerLine: 70, linePx: 23 });
  assert.equal(imageSize('x'.repeat(71), M).lines, 2);
  assert.equal(imageSize('x'.repeat(70), M).lines, 1);
  assert.equal(imageSize('hi', { ...M, pad: 0 }).height, 23);
  assert.equal(imageSize('hi', { ...M, fontPx: 10 }).linePx, 14);
  assert.equal(imageSize('hi', { ...M, maxWidthPx: 25, pad: 12 }).charsPerLine, 1);   // one pixel of room still holds one character
  for (const m of [null, [], { ...M, charWidthPx: 0 }, { ...M, charWidthPx: 'x' }, { ...M, fontPx: 0 }, { ...M, fontPx: NaN }, { ...M, maxWidthPx: 640.5 }, { ...M, pad: -1 }, { ...M, pad: 1.5 }, { ...M, maxWidthPx: 24, pad: 12 }, { ...M, maxWidthPx: undefined }])
    assert.match(imageSize('hi', m).why, /metrics/);
  assert.match(imageSize(5, M).why, /text must be a string/);
});

test('fitLaw: least squares, real = a × formula + b', () => {
  assert.deepEqual(fitLaw([{ formula: 100, real: 108 }, { formula: 200, real: 215 }]), { ok: true, a: 1.07, b: 1, n: 2 });
  assert.deepEqual(fitLaw([{ formula: 1, real: 3 }, { formula: 2, real: 5 }, { formula: 3, real: 7 }]), { ok: true, a: 2, b: 1, n: 3 });
  assert.deepEqual(fitLaw([{ formula: 0, real: 0 }, { formula: 1, real: 1 }, { formula: 2, real: 1 }]), { ok: true, a: 0.5, b: 0.1667, n: 3 });
  assert.equal(fitLaw([{ formula: 3, real: 1 }, { formula: 1, real: 3 }]).a, -1);
  for (const [p, re] of [[null, /two calibration points/], [[{ formula: 1, real: 1 }], /two calibration points/], [[{ formula: 1, real: 1 }, null], /numeric formula and real/], [[{ formula: 1, real: 1 }, { formula: '2', real: 1 }], /numeric/], [[{ formula: 1, real: 1 }, { formula: 2, real: NaN }], /numeric/], [[{ formula: 5, real: 1 }, { formula: 5, real: 9 }], /not all be the same size/]])
    assert.match(fitLaw(p).why, re);
});

test('predictImage, cheaper, breakEven', () => {
  assert.equal(predictImage(100, { a: 1.008871, b: 7.6873 }), 108.57);
  assert.equal(predictImage(0, { a: 2, b: -1 }), -1);
  for (const [f, l] of [['1', { a: 1, b: 0 }], [1, null], [1, { a: 1 }], [1, { a: 'x', b: 0 }], [1, []]]) assert.equal(predictImage(f, l), null);
  assert.deepEqual([cheaper(10, 9), cheaper(9, 10), cheaper(9, 9)], ['image', 'text', 'tie']);
  assert.equal(cheaper('9', 9), null);
  assert.equal(cheaper(9, NaN), null);
  assert.equal(breakEven({ a: 1.008871, b: 7.6873 }, M), 3.535);
  assert.equal(breakEven({ a: 1, b: 0 }, M), 3.567);
  assert.equal(breakEven({ a: 0, b: 1 }, M), null);
  assert.equal(breakEven({ a: -1, b: 1 }, M), null);
  assert.equal(breakEven(null, M), null);
  assert.equal(breakEven({ a: 1, b: 0 }, null), null);
});

test('score: the held-out test — cost error, the law\'s pick, the one-number rule\'s pick', () => {
  const law = { a: 1, b: 10 };
  const s = score([
    { id: 'hex', shape: 'hex', chars: 400, textTokens: 300, formula: 150, real: 160 },   // image cheaper; law right; 1.33 chars/token → thumb says image
    { id: 'kv', shape: 'kv', chars: 300, textTokens: 150, formula: 260, real: 280 },     // text cheaper; 2 chars/token → thumb says image (wrong)
    { id: 'tie', shape: 'p', chars: 200, textTokens: 100, formula: 88, real: 100 },      // a tie: right whichever way
  ], law, 3);
  assert.equal(s.ok, true);
  assert.deepEqual(s.rows.map((r) => r.imageVsTextPct), [-46.67, 86.67, 0]);
  assert.deepEqual(s.rows.map((r) => [r.id, r.predicted, r.errPct, r.truth, r.lawRight, r.thumbRight, r.charsPerToken]), [
    ['hex', 160, 0, 'image', true, true, 1.333],
    ['kv', 270, -3.57, 'text', true, false, 2],
    ['tie', 98, -2, 'tie', true, true, 2],
  ]);
  assert.deepEqual([s.n, s.medianAbsErrPct, s.maxAbsErrPct, s.lawAccuracy, s.thumbAccuracy], [3, 2, 3.57, 1, 0.667]);
  assert.equal(score([{ id: 'a', chars: 10, textTokens: 5, formula: 10, real: 20 }, { id: 'b', chars: 10, textTokens: 5, formula: 10, real: 40 }], law, 3).medianAbsErrPct, 25);   // even count: the mean of the middle two
  const wrongLaw = score([{ id: 'x', chars: 100, textTokens: 50, formula: 30, real: 60 }], law, 1);
  assert.deepEqual([wrongLaw.rows[0].truth, wrongLaw.rows[0].lawRight, wrongLaw.rows[0].thumbRight], ['text', false, true]);
  assert.equal(score([{ id: 'x', chars: 100, textTokens: 50, formula: 30, real: 60 }], law, 2.01).rows[0].thumbRight, false);
  assert.equal(score([{ id: 'x', chars: 100, textTokens: 50, formula: 30, real: 60 }], law, 2).rows[0].thumbRight, true);   // exactly c*: the rule says text
  for (const [samples, c, re] of [[[], 3, /held-out samples/], ['x', 3, /held-out samples/], [[{ id: 'a', chars: 1, textTokens: 1, formula: 1, real: 1 }], 0, /c\*/], [[{ id: 'a', chars: 1, textTokens: 1, formula: 1, real: 1 }], 'x', /c\*/]])
    assert.match(score(samples, law, c).why, re);
  const ok = { id: 'a', chars: 10, textTokens: 5, formula: 10, real: 20 };
  for (const bad of [null, { ...ok, id: 5 }, { ...ok, chars: 0 }, { ...ok, chars: 1.5 }, { ...ok, textTokens: 0 }, { ...ok, textTokens: '5' }, { ...ok, formula: 'x' }, { ...ok, real: 0 }, { ...ok, real: NaN }])
    assert.match(score([ok, bad], law, 3).why, /needs id, chars, textTokens, formula and real/);
  assert.match(score([ok], { a: 1 }, 3).why, /numeric a and b/);
  assert.equal(score([{ id: 'one', chars: 1, textTokens: 1, formula: 1, real: 1 }], law, 3).ok, true);   // a one-character sample is still a sample
});

test('the committed v2 data: every size predicted, the law refits from the calibration third, the held-out score', () => {
  const J = (f) => JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8'));
  const C = J('data/corpus.json'), R = J('data/renders.json'), P = J('data/prereg.json'), CAL = J('data/counts-calibration.json'), HO = J('data/counts-heldout.json');
  const rid = Object.fromEntries(R.renders.map((r) => [r.id, r]));
  for (const s of C.samples) { const z = imageSize(s.text, R.metrics); assert.deepEqual([z.width, z.height], [rid[s.id].width, rid[s.id].height], s.id); assert.equal(tokensForImage(z.width, z.height).tokens, rid[s.id].formula, s.id); }
  const law = fitLaw(CAL.rows.map((r) => ({ formula: rid[r.id].formula, real: r.imageTokens })));
  assert.deepEqual([law.a, law.b], [P.law.a, P.law.b]);
  assert.equal(breakEven(law, R.metrics), P.thumb.cStar);
  assert.deepEqual(HO.rows.map((r) => r.id).sort(), [...P.heldout.ids].sort());
  const sid = Object.fromEntries(C.samples.map((s) => [s.id, s]));
  const sc = score(HO.rows.map((r) => ({ id: r.id, shape: sid[r.id].shape, chars: sid[r.id].chars, textTokens: r.textTokens, formula: rid[r.id].formula, real: r.imageTokens })), P.law, P.thumb.cStar);
  assert.deepEqual([sc.n, sc.medianAbsErrPct, sc.maxAbsErrPct, sc.lawAccuracy, sc.thumbAccuracy], [64, 1.32, 4.79, 0.969, 0.531]);
});

test('fuzz: the v2 kernel never throws', () => {
  const junk = [undefined, null, 0, -1, NaN, '', 'x', [], {}, [null], { a: 1, b: 2 }, M, () => 1];
  for (const a of junk) for (const b of junk) assert.doesNotThrow(() => { wrapLines(a, b); imageSize(a, b); fitLaw(a); predictImage(a, b); cheaper(a, b); breakEven(a, b); score(a, b, 3); score([a], b, 3); shapeTally([a, b]); judge(a); judge({ ok: true, rows: [a, b] }); });
});

test('shapeTally and judge: the per-shape picture and the five pre-registered rules', () => {
  const row = (shape, truth, pct) => ({ shape, truth, imageVsTextPct: pct });
  assert.deepEqual(shapeTally([row('hex', 'image', -40), row('hex', 'image', -50), row('kv', 'text', 60), row('kv', 'tie', 0), null, row('x', 'maybe', 1), row('x', 'text', 'n'), { truth: 'text', imageVsTextPct: 1 }]), {
    hex: { n: 2, image: 2, text: 0, tie: 0, meanPct: -45 }, kv: { n: 2, image: 0, text: 1, tie: 1, meanPct: 30 },
  });
  assert.deepEqual(shapeTally('x'), {});
  const mk = (over, rows) => ({ ok: true, medianAbsErrPct: 1, maxAbsErrPct: 4, lawAccuracy: 0.95, thumbAccuracy: 0.5, rows, ...over });
  const rows = [...['hex', 'base64'].map((s) => row(s, 'image', -40)), ...['law', 'code', 'keyvalue'].map((s) => row(s, 'text', 30))];
  const j = judge(mk({}, rows));
  assert.deepEqual(j.rules.map((r) => [r.id, r.pass, r.value]), [
    ['cost-law', true, 'median 1%, worst 4%'], ['decision', true, '95%'], ['thumb-fails', true, '50%'],
    ['shape-image', true, '2/2 cheaper as an image'], ['shape-text', true, '3/3 cheaper as text'],
  ]);
  assert.deepEqual([j.passed, j.of], [5, 5]);
  // each bar at its edge, then just past it
  assert.equal(judge(mk({ medianAbsErrPct: 3, maxAbsErrPct: 10 }, rows)).rules[0].pass, true);
  assert.equal(judge(mk({ medianAbsErrPct: 3.01 }, rows)).rules[0].pass, false);
  assert.equal(judge(mk({ maxAbsErrPct: 10.01 }, rows)).rules[0].pass, false);
  assert.equal(judge(mk({ lawAccuracy: 0.9 }, rows)).rules[1].pass, true);
  assert.equal(judge(mk({ lawAccuracy: 0.899 }, rows)).rules[1].pass, false);
  assert.equal(judge(mk({ thumbAccuracy: 0.749 }, rows)).rules[2].pass, true);
  assert.equal(judge(mk({ thumbAccuracy: 0.75 }, rows)).rules[2].pass, false);
  const oneCodeImage = rows.map((r) => (r.shape === 'code' ? row('code', 'image', -1) : r));
  assert.deepEqual([judge(mk({}, oneCodeImage)).rules[4].pass, judge(mk({}, oneCodeImage)).rules[4].value], [false, '2/3 cheaper as text']);
  const hexTie = rows.map((r) => (r.shape === 'hex' ? row('hex', 'tie', 0) : r));
  assert.deepEqual([judge(mk({}, hexTie)).rules[3].pass, judge(mk({}, hexTie)).rules[3].value], [false, '1/2 cheaper as an image']);
  const noBase64 = rows.filter((r) => r.shape !== 'base64');
  assert.deepEqual([judge(mk({}, noBase64)).rules[3].pass, judge(mk({}, noBase64)).rules[3].value], [false, '1/1 cheaper as an image']);   // a missing shape can never pass
  assert.match(judge(mk({}, rows.filter((r) => r.shape !== 'law'))).rules[4].value, /^2\/2/);
  assert.equal(judge(mk({}, rows.filter((r) => r.shape !== 'law'))).rules[4].pass, false);
  for (const bad of [null, {}, { ok: false, rows: [] }, { ok: true, rows: 'x' }]) assert.match(judge(bad).why, /a held-out score/);
});

test('the committed held-out result, judged against the pre-registration', () => {
  const J = (f) => JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8'));
  const C = J('data/corpus.json'), R = J('data/renders.json'), P = J('data/prereg.json'), HO = J('data/counts-heldout.json');
  const rid = Object.fromEntries(R.renders.map((r) => [r.id, r])), sid = Object.fromEntries(C.samples.map((s) => [s.id, s]));
  const j = judge(score(HO.rows.map((r) => ({ id: r.id, shape: sid[r.id].shape, chars: sid[r.id].chars, textTokens: r.textTokens, formula: rid[r.id].formula, real: r.imageTokens })), P.law, P.thumb.cStar));
  assert.deepEqual(j.rules.map((r) => [r.id, r.pass]), [['cost-law', true], ['decision', true], ['thumb-fails', true], ['shape-image', true], ['shape-text', false]]);
  assert.deepEqual(j.rules.map((r) => r.id), P.rules.map((r) => r.id), 'the judged rules are exactly the pre-registered ones');
  assert.deepEqual([j.tally.hex.meanPct, j.tally.base64.meanPct, j.tally.keyvalue.meanPct, j.tally.code.image], [-43.7, -60.4, 64.1, 2]);
});
