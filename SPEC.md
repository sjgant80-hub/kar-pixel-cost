# kar-pixel-cost — specification

## Purpose

kar-pixel-cost

## Contract

- **breakEven** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **cheaper** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **fitLaw** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **imageSize** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **judge** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **layoutPixels** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **predictImage** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **score** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **shapeTally** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **tokensForImage** — part of the kar-pixel-cost public surface; deterministic, total (never throws).
- **wrapLines** — part of the kar-pixel-cost public surface; deterministic, total (never throws).

## Guarantees

- **Deterministic** — the same input yields the same output on any machine, any run.
- **Total** — hostile or malformed input returns a defined value, never an exception.
- **Zero-dependency** — no third-party runtime code inside the trust boundary.

## Verification

The suite exercises the public surface directly and is mutation-checked: a change to any guarded line makes a
test fail. konomify admits kar-pixel-cost only when both the structure rubric (acg-assessor) and the behaviour gate
(witness) pass.
