import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensForImage, layoutPixels } from './kernel.mjs';

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
