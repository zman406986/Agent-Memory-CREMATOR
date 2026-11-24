# `dev/bench/fixtures/sim/` — the synthetic shape fixture

ISSUE-059 T-2. A **committed, deterministic, pin-verified** transcript with a
**known composition**, so the sim's later tickets (T-3's render, T-4's chain)
have an offline oracle. It is not a live record and never a performance sample:
it holds the shape, not a reading.

`dev/bench/fixtures/live/` (the 040 pair) is real and stays the converter's
census oracle. It cannot be the render oracle: it carries 0 shaped rows, 0 ask
turns and 65 `ask-failed-fail-open` units. This directory is the other half.

## Files

| File | What it is |
| --- | --- |
| `build-fixture.mjs` | the builder and verifier — `--verify` checks every pin below; no clock, no randomness, no network |
| `sim.session.v4.jsonl` | the `racoons` arm: eight landed results, seven of them over the floor |
| `sim-control.session.v4.jsonl` | the `vanilla` arm: the same reads landed whole, no ask, no rewrite |
| `manifest.json` | the converter's input: two arms, their roots, session id, row counts, sha256 |
| `expected-composition.json` | the pinned composition, the converter's own `compositionRules`, and every moment's five render terms |
| `sha256.txt` | `sha256sum`-format lines over the four data files |
| `.gitattributes` | `* text eol=lf`; the pin is over bytes, so a CRLF checkout would void it |

Verify the committed bytes with:

```
node dev/bench/fixtures/sim/build-fixture.mjs --verify
node --test dev/bench/fixtures/sim/sim-fixture.test.mjs
```

`--verify` is the supported path. The reasoning and prunes cuts are sanitized in
place (masked strings, unchanged byte lengths and line counts), so a build into
this directory is refused: regenerating them from the private scratchpad source
would write the owner's home path and private text back into the tree. A build
with `--out <fresh-dir>` writes an inspection copy only, never the committed
fixture. The builder still needs `packages/core/dist` and
`packages/adapters/dsh/dist` (it imports the shipped renderers) for that path;
run `npm run build` first if they are absent.

## The seven moments, and why each one exists

One landed row per class the converter's six `compositionRules` can produce:

| Moment | Class | Shape it exercises |
| --- | --- | --- |
| `lead-gap` | `forget-with-partials` | one marker **before** the kept lines: the header is dropped, the tail is kept |
| `multi-gap` | `forget-with-partials` | **three** markers between three kept spans: the multi-gap arithmetic |
| `forget-all` | `forget-all` | the empty-form marker, zero kept lines, `dropped = bytes` |
| `keepall` | `keepall` | an ask turn, its answer, and ONE rewind over the pair; no replace at the result's seq |
| `machinery` | `machinery-censored` | the whole body is one `[not retained] … · recall <id>` receipt: an at-rest burn, no decision |
| `ask-failed-fail-open` | `ask-failed-fail-open` | an over-floor result with no ask turn after it and no rewind; `d = 0` |
| `below-floor` | `below-floor` | a landed result under 1 280 B: excluded before composition is asked |
| `trailing-gap` | `forget-with-partials` | the marker **after** the kept lines (the eighth landed row, a second partial shape) |

That is eight landed rows, seven units: `below-floor` is a landed result but
never a unit, which is exactly what its class says.

## Where the bytes come from

A shaped body is not retyped here. `build-fixture.mjs` calls
`renderShapeTurn` (core) for the kept ranges and marker, and
`composeEntryShapeTurn` (dsh) for the summary prefix, so the fixture and the
product cannot disagree about what a marker or a summary line looks like — only
about which lines were kept. The ask prompt is `entryAskMessage`, the receipt is
`receiptLine`, and the answer text is `forgetlines`/`forgetall`/`keepall` JSON
whose forgotten spans are the complement of the kept ones.

The converter's `compositionRules` block is read out of
`dev/bench/multiturn/live-convert.mjs` at build time and stored verbatim in
`expected-composition.json`. The plan forbids a second definition of the six
classes; the test asserts the stored copy is still the converter's.

## What the test proves

`sim-fixture.test.mjs` (run with `node --test`) holds four things:

1. every required moment class is present, the lead-gap and multi-gap partials
   are distinct shapes, and the machinery receipt is one whole body;
2. **an independent parser** — one written from the shipped templates and the
   receipt renderer, never from the converter's own helpers — reproduces
   `expected-composition.json` exactly: the six-line table, the per-class census,
   and every shaped row's `kept`, `markerBytes`, `summary`, `framing` and
   `dropped`, with framing measured at 0;
3. `--verify` passes against the committed sanitized cuts, a build into this
   directory refuses by name, and every file matches `sha256.txt`;
4. the pin is **not vacuous**: bumping one marker's `<B>` slot by one byte
   reddens `marker-arithmetic-mismatch` by name, and mutating one kept line
   reddens the sha pin while the composition table still parses.

## Determinism rules this directory obeys

- No `Date.now()`, no `new Date()`, no `Math.random()`, no network. Every value
  is a constant in the builder; a test greps the builder for the banned calls.
- Every file is written with an explicit `\n`; the builder refuses to emit a
  transcript carrying `\r`.
- The arm root is a fictional `C:\sim\arm`, so no real home directory is named
  and the join's `<ARM>` substitution is exercised rather than inherited.
- The `vanilla` arm is a real second transcript, so the converter's two-arm join
  produces `T1 = 7` again on every run. Nothing in the control arm is scored.
