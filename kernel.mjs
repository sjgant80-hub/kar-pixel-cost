// kernel.mjs — the pure, gated part of the pixel-cost experiment (2026-09-23).
//
// This experiment asks: does rendering text as an image cost more or fewer tokens than the
// text itself, for a vision model reading it back? Two functions here are pure and total,
// gated by witness — the REST of the experiment (real API token counts, real vision reads)
// is empirical and documented honestly in findings.json, never pretended to be gated.

// Anthropic's own published image-token estimate: tokens ≈ (width_px × height_px) / 750.
// https://docs.anthropic.com/en/docs/build-with-claude/vision — cited, not invented.
export function tokensForImage(width, height) {
  if (!Number.isInteger(width) || width <= 0) return { ok: false, why: 'width must be a positive integer' };
  if (!Number.isInteger(height) || height <= 0) return { ok: false, why: 'height must be a positive integer' };
  return { ok: true, tokens: Math.ceil((width * height) / 750) };
}

// Given a font size and a max line width (px), how many characters fit per line and how many
// lines are needed for a string of `charCount` characters — the pure layout math behind the
// renderer, so the "how many pixels does this text need to stay legible" question is testable
// without ever touching a canvas. Uses a fixed average-char-width heuristic (monospace-style,
// charWidthPx per character) — the renderer itself uses a real font metric; this pins the
// SHAPE of the math (total pixel area needed), not the exact font rendering.
export function layoutPixels(charCount, opts = {}) {
  if (!Number.isInteger(charCount) || charCount < 0) return { ok: false, why: 'charCount must be a non-negative integer' };
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) return { ok: false, why: 'opts must be an object' };
  const fontPx = opts.fontPx === undefined ? 16 : opts.fontPx;
  const charWidthPx = opts.charWidthPx === undefined ? fontPx * 0.6 : opts.charWidthPx;
  const maxWidthPx = opts.maxWidthPx === undefined ? 640 : opts.maxWidthPx;
  const linePx = opts.linePx === undefined ? Math.ceil(fontPx * 1.4) : opts.linePx;
  if (!Number.isFinite(fontPx) || fontPx <= 0) return { ok: false, why: 'fontPx must be a positive number' };
  if (!Number.isFinite(charWidthPx) || charWidthPx <= 0) return { ok: false, why: 'charWidthPx must be a positive number' };
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return { ok: false, why: 'maxWidthPx must be a positive number' };
  if (!Number.isFinite(linePx) || linePx <= 0) return { ok: false, why: 'linePx must be a positive number' };

  const charsPerLine = Math.max(1, Math.floor(maxWidthPx / charWidthPx));
  const lines = charCount === 0 ? 1 : Math.ceil(charCount / charsPerLine);
  const width = Math.min(maxWidthPx, Math.max(charWidthPx, charCount * charWidthPx));
  const height = lines * linePx;
  return { ok: true, width: Math.ceil(width), height: Math.ceil(height), charsPerLine, lines };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v2 · THE CROSSOVER LAW (2026-09-30) — from three samples to a pre-registered law.
//
// v1 found, from n=3, that the answer "depends on how efficiently the content tokenizes as text".
// v2 turns that into something that can be wrong: calibrate the real image cost of THIS renderer on
// one third of a 96-sample corpus (eight content shapes), write the law and its pass bars down and
// seal them BEFORE the other two thirds are counted, then score the law on the held-out samples.
// Everything below is pure and total; the counts themselves are real API measurements (data/).
// ════════════════════════════════════════════════════════════════════════════════════════════════

const isStr2 = (v) => typeof v === 'string';
const isNum2 = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj2 = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// wrapLines(text, charsPerLine) — the v2 renderer's line breaking. Honours '\n' as a hard break
// (v1's renderer flowed newlines into spaces), word-wraps on spaces, and hard-splits a word longer
// than a line (v1 would have drawn it off the edge of the canvas — invisible, but still counted).
export function wrapLines(text, charsPerLine) {
  if (!isStr2(text)) return { ok: false, why: 'text must be a string' };
  if (!Number.isInteger(charsPerLine) || charsPerLine < 1) return { ok: false, why: 'charsPerLine must be a positive integer' };
  const lines = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      let w = word;
      while (w.length > charsPerLine) {              // a word longer than a line: close the line, fill whole lines, carry the rest
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, charsPerLine));
        w = w.slice(charsPerLine);
      }
      const trial = cur ? cur + ' ' + w : w;
      if (trial.length > charsPerLine) { lines.push(cur); cur = w; }
      else cur = trial;
    }
    lines.push(cur);
  }
  return { ok: true, lines };
}

// imageSize(text, m) — the exact pixel size the v2 renderer draws: m = { charWidthPx, fontPx,
// maxWidthPx, pad } measured from the real canvas. Width is fixed; height is lines × line + padding.
export function imageSize(text, m) {
  if (!isObj2(m) || !isNum2(m.charWidthPx) || m.charWidthPx <= 0 || !isNum2(m.fontPx) || m.fontPx <= 0 || !Number.isInteger(m.maxWidthPx) || !Number.isInteger(m.pad) || m.pad < 0 || m.maxWidthPx <= 2 * m.pad) return { ok: false, why: 'metrics: charWidthPx, fontPx, integer maxWidthPx and pad, with room between the pads' };
  const charsPerLine = Math.max(1, Math.floor((m.maxWidthPx - 2 * m.pad) / m.charWidthPx));
  const w = wrapLines(text, charsPerLine);
  if (!w.ok) return w;
  const linePx = Math.ceil(m.fontPx * 1.4);
  return { ok: true, width: m.maxWidthPx, height: w.lines.length * linePx + 2 * m.pad, lines: w.lines.length, charsPerLine, linePx };
}

// fitLaw(points) — least squares, real = a × formula + b, over { formula, real } points. The formula is
// Anthropic's published ceil(w×h/750); the fit measures how the real count departs from it.
export function fitLaw(points) {
  if (!Array.isArray(points) || points.length < 2) return { ok: false, why: 'at least two calibration points' };
  if (points.some((p) => !isObj2(p) || !isNum2(p.formula) || !isNum2(p.real))) return { ok: false, why: 'each point needs a numeric formula and real count' };
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.formula, 0) / n, my = points.reduce((s, p) => s + p.real, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.formula - mx) ** 2, 0), sxy = points.reduce((s, p) => s + (p.formula - mx) * (p.real - my), 0);
  if (!(sxx > 0)) return { ok: false, why: 'the calibration images must not all be the same size' };
  const a = sxy / sxx, b = my - a * mx;
  return { ok: true, a: Math.round(a * 1e6) / 1e6, b: Math.round(b * 1e4) / 1e4, n };
}

// predictImage(formula, law) — the law's prediction for one image's real token count.
export function predictImage(formula, law) {
  if (!isNum2(formula) || !isObj2(law) || !isNum2(law.a) || !isNum2(law.b)) return null;
  return Math.round((law.a * formula + law.b) * 100) / 100;
}

// cheaper(textTokens, imageTokens) — which encoding costs fewer input tokens: 'image', 'text' or 'tie'.
export function cheaper(textTokens, imageTokens) {
  if (!isNum2(textTokens) || !isNum2(imageTokens)) return null;
  return imageTokens < textTokens ? 'image' : textTokens < imageTokens ? 'text' : 'tie';
}

// breakEven(law, m) — the rule of thumb: for full lines of this renderer, an image costs
// a × (maxWidth × linePx / 750) tokens per line of charsPerLine characters. Text wins while it packs
// more characters into a token than that; so image is cheaper when chars-per-text-token < c*.
export function breakEven(law, m) {
  const s = imageSize('', m);
  if (!s.ok || !isObj2(law) || !isNum2(law.a) || !(law.a > 0)) return null;
  const perLine = law.a * (m.maxWidthPx * s.linePx) / 750;
  return Math.round((s.charsPerLine / perLine) * 1000) / 1000;
}

const median = (xs) => { const s = [...xs].sort((x, y) => x - y), k = s.length; return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2; };

// score(samples, law, cStar) — the held-out test: per sample, the law's predicted image cost against
// the real count, whether the law picks the cheaper encoding, and whether the one-number rule
// (chars per text token < c*) does. samples: [{ id, shape, chars, textTokens, formula, real }].
// A tie counts as picked correctly whichever way the rule points — there is nothing to save.
export function score(samples, law, cStar) {
  if (!Array.isArray(samples) || samples.length === 0) return { ok: false, why: 'the held-out samples' };
  if (!isNum2(cStar) || !(cStar > 0)) return { ok: false, why: 'the break-even c*' };
  const rows = [];
  for (const s of samples) {
    if (!isObj2(s) || !isStr2(s.id) || !Number.isInteger(s.chars) || s.chars < 1 || !isNum2(s.textTokens) || !(s.textTokens > 0) || !isNum2(s.formula) || !isNum2(s.real) || !(s.real > 0)) return { ok: false, why: 'sample ' + String(s && s.id) + ' needs id, chars, textTokens, formula and real' };
    const pred = predictImage(s.formula, law);
    if (pred === null) return { ok: false, why: 'the law needs numeric a and b' };
    const truth = cheaper(s.textTokens, s.real);
    const byLaw = cheaper(s.textTokens, pred);
    const cpt = s.chars / s.textTokens;
    const byThumb = cpt < cStar ? 'image' : 'text';
    rows.push({ id: s.id, shape: s.shape, predicted: pred, real: s.real, errPct: Math.round(((pred - s.real) / s.real) * 10000) / 100, truth, imageVsTextPct: Math.round(((s.real - s.textTokens) / s.textTokens) * 10000) / 100, lawRight: truth === 'tie' || byLaw === truth, thumbRight: truth === 'tie' || byThumb === truth, charsPerToken: Math.round(cpt * 1000) / 1000 });
  }
  const abs = rows.map((r) => Math.abs(r.errPct));
  return {
    ok: true, n: rows.length, rows,
    medianAbsErrPct: Math.round(median(abs) * 100) / 100, maxAbsErrPct: Math.max(...abs),
    lawAccuracy: Math.round((rows.filter((r) => r.lawRight).length / rows.length) * 1000) / 1000,
    thumbAccuracy: Math.round((rows.filter((r) => r.thumbRight).length / rows.length) * 1000) / 1000,
  };
}

// shapeTally(rows) — per content shape: how many samples were cheaper as an image, as text, or tied, and the mean
// real image-vs-text difference in per cent (negative = the image is cheaper).
export function shapeTally(rows) {
  if (!Array.isArray(rows)) return {};
  const t = {};
  for (const r of rows) {
    if (!isObj2(r) || !isStr2(r.shape) || !['image', 'text', 'tie'].includes(r.truth) || !isNum2(r.imageVsTextPct)) continue;
    const x = t[r.shape] || (t[r.shape] = { n: 0, image: 0, text: 0, tie: 0, sumPct: 0 });
    x.n++; x[r.truth]++; x.sumPct += r.imageVsTextPct;
  }
  return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, { n: x.n, image: x.image, text: x.text, tie: x.tie, meanPct: Math.round((x.sumPct / x.n) * 10) / 10 }]));
}

// judge(scored) — the five rules pre-registered in data/prereg.json (sealed in commit fbeb925 before the held-out
// count), each with the number that decided it. The bars below are that file's, copied, not tuned.
export function judge(scored) {
  if (!isObj2(scored) || scored.ok !== true || !Array.isArray(scored.rows)) return { ok: false, why: 'a held-out score' };
  const tally = shapeTally(scored.rows);
  const all = (shapes, side) => shapes.every((k) => tally[k] && tally[k][side] === tally[k].n);
  const count = (shapes, side) => shapes.reduce((a, k) => a + (tally[k] ? tally[k][side] : 0), 0) + '/' + shapes.reduce((a, k) => a + (tally[k] ? tally[k].n : 0), 0);
  const rules = [
    { id: 'cost-law', pass: scored.medianAbsErrPct <= 3 && scored.maxAbsErrPct <= 10, value: 'median ' + scored.medianAbsErrPct + '%, worst ' + scored.maxAbsErrPct + '%' },
    { id: 'decision', pass: scored.lawAccuracy >= 0.9, value: Math.round(scored.lawAccuracy * 1000) / 10 + '%' },
    { id: 'thumb-fails', pass: scored.thumbAccuracy < 0.75, value: Math.round(scored.thumbAccuracy * 1000) / 10 + '%' },
    { id: 'shape-image', pass: all(['hex', 'base64'], 'image'), value: count(['hex', 'base64'], 'image') + ' cheaper as an image' },
    { id: 'shape-text', pass: all(['law', 'code', 'keyvalue'], 'text'), value: count(['law', 'code', 'keyvalue'], 'text') + ' cheaper as text' },
  ];
  return { ok: true, rules, passed: rules.filter((r) => r.pass).length, of: rules.length, tally };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v2b · THE READ-BACK (2026-09-30) — a saving is worth nothing if the read is wrong.
//
// Every held-out picture is shown, alone, to the model whose tokens were counted, with one fixed instruction; it
// never sees the source. Each transcript is graded here, deterministically, against the committed source — no model
// judges a model. The grading and the pass bars were sealed (data/readback-prereg.json) before the first paid call.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// expectedLayout(text, m) — what the picture shows: the text broken into the renderer's lines.
export function expectedLayout(text, m) {
  const s = imageSize(text, m);
  if (!s.ok) return null;
  return wrapLines(text, s.charsPerLine).lines.join('\n');
}

// normalizeRead(t) — the only clean-up a transcript gets: CRLF to LF; a reply wholly inside one code fence is
// unwrapped; trailing spaces are cut from each line; blank lines at the very start and end are dropped.
export function normalizeRead(t) {
  if (!isStr2(t)) return null;
  let s = t.replace(/\r\n?/g, '\n');
  const fence = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(s);
  if (fence) s = fence[1];
  s = s.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

// levenshtein(a, b) — edits (insert, delete, substitute) to turn a into b.
export function levenshtein(a, b) {
  if (!isStr2(a) || !isStr2(b)) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const squash = (s) => s.replace(/\s+/g, '');

// gradeRead(expected, transcript) — content is every non-whitespace character, in order: contentExact when they all
// match, contentCer = edits ÷ expected content length. layoutExact also asks for the line breaks and spaces.
export function gradeRead(expected, transcript) {
  if (!isStr2(expected) || squash(expected).length === 0) return { ok: false, why: 'the expected text' };
  const got = normalizeRead(transcript);
  if (got === null) return { ok: false, why: 'the transcript must be a string' };
  const want = normalizeRead(expected), a = squash(want), b = squash(got);
  const d = levenshtein(a, b);
  return { ok: true, layoutExact: got === want, contentExact: a === b, edits: d, contentCer: Math.round((d / a.length) * 10000) / 10000 };
}

// readbackJudge(rows) — the five read-back rules sealed in data/readback-prereg.json, each with the number that
// decided it. rows: [{ id, shape, contentExact, contentCer, cheaperAsImage }].
export function readbackJudge(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((r) => !isObj2(r) || !isStr2(r.shape) || typeof r.contentExact !== 'boolean' || !isNum2(r.contentCer))) return { ok: false, why: 'graded rows: shape, contentExact, contentCer' };
  const exact = (rs) => rs.filter((r) => r.contentExact).length;
  const of = (shape) => rows.filter((r) => r.shape === shape);
  const cers = rows.map((r) => r.contentCer);
  const cheap = rows.filter((r) => r.cheaperAsImage === true);
  const med = median(cers);
  // a shape with no rows gives 0 over 0, which is NaN, and NaN never clears a bar: a missing shape never passes
  const rules = [
    { id: 'median-cer', pass: med <= 0.01, value: 'median ' + Math.round(med * 10000) / 100 + '%' },
    { id: 'exact-overall', pass: exact(rows) / rows.length >= 0.7, value: exact(rows) + '/' + rows.length },
    { id: 'exact-hex', pass: exact(of('hex')) / of('hex').length >= 0.75, value: exact(of('hex')) + '/' + of('hex').length },
    { id: 'exact-base64', pass: exact(of('base64')) / of('base64').length >= 0.75, value: exact(of('base64')) + '/' + of('base64').length },
    { id: 'no-wreck', pass: Math.max(...cers) <= 0.1, value: 'worst ' + Math.round(Math.max(...cers) * 10000) / 100 + '%' },
  ];
  return { ok: true, rules, passed: rules.filter((r) => r.pass).length, of: rules.length, banked: { cheaper: cheap.length, readExactly: exact(cheap) } };
}

// spend(usages, price, gbpPerUsd, cache) — what the calls cost at the model's list price, from the provider's own
// counts. Each usage: fresh input_tokens and output_tokens, and optionally the cached kinds (cache_write_5m,
// cache_write_1h, cache_read), which the provider prices as multiples of the input rate — cache carries those
// multiples ({ write5m, write1h, read }) and is only needed when a cached kind is non-zero.
const USAGE_KINDS = ['input_tokens', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output_tokens'];
export function spend(usages, price, gbpPerUsd, cache) {
  if (!Array.isArray(usages) || usages.some((u) => !isObj2(u) || !Number.isInteger(u.input_tokens) || !Number.isInteger(u.output_tokens) || USAGE_KINDS.some((k) => u[k] !== undefined && !(Number.isInteger(u[k]) && u[k] >= 0)))) return { ok: false, why: 'usage: integer input_tokens and output_tokens per call, and whole cached counts' };
  if (!isObj2(price) || !isNum2(price.inPerM) || !isNum2(price.outPerM) || price.currency !== 'USD' || !isNum2(gbpPerUsd) || !(gbpPerUsd > 0)) return { ok: false, why: 'a USD list price per million tokens and the pound rate' };
  const t = Object.fromEntries(USAGE_KINDS.map((k) => [k, usages.reduce((s, u) => s + (u[k] || 0), 0)]));
  const cached = t.cache_write_5m + t.cache_write_1h + t.cache_read;
  const c = isObj2(cache) && [cache.write5m, cache.write1h, cache.read].every(isNum2) ? cache : null;
  if (cached > 0 && !c) return { ok: false, why: 'cached tokens need the cache multiples' };
  const inputUnits = t.input_tokens + (c ? t.cache_write_5m * c.write5m + t.cache_write_1h * c.write1h + t.cache_read * c.read : 0);
  const usd = (inputUnits * price.inPerM + t.output_tokens * price.outPerM) / 1e6;
  return { ok: true, calls: usages.length, input: t.input_tokens + cached, fresh: t.input_tokens, cacheWrite: t.cache_write_5m + t.cache_write_1h, cacheRead: t.cache_read, output: t.output_tokens, usd: Math.round(usd * 1e4) / 1e4, gbp: Math.round(usd * gbpPerUsd * 1e4) / 1e4 };
}
