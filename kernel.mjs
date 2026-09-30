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
    rows.push({ id: s.id, shape: s.shape, predicted: pred, real: s.real, errPct: Math.round(((pred - s.real) / s.real) * 10000) / 100, truth, lawRight: truth === 'tie' || byLaw === truth, thumbRight: truth === 'tie' || byThumb === truth, charsPerToken: Math.round(cpt * 1000) / 1000 });
  }
  const abs = rows.map((r) => Math.abs(r.errPct));
  return {
    ok: true, n: rows.length, rows,
    medianAbsErrPct: Math.round(median(abs) * 100) / 100, maxAbsErrPct: Math.max(...abs),
    lawAccuracy: Math.round((rows.filter((r) => r.lawRight).length / rows.length) * 1000) / 1000,
    thumbAccuracy: Math.round((rows.filter((r) => r.thumbRight).length / rows.length) * 1000) / 1000,
  };
}
