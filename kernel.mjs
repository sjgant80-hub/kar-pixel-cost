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
