#!/usr/bin/env node
/**
 * The two prefix cuts: `prefixTextAt` (by `landedStep`) and `prefixTextToSeq`
 * (by the trigger's own `seq`).
 *
 * Run: `node --test dev/sim/sim-prefix-cut.test.mjs`
 *
 * The fixtures are synthetic rows here, not a scratchpad record: a prefix cut
 * needs three fields per row (`seq`, `landedStep`, `swapStep`) and the two
 * bodies, and nothing about the cut depends on a transcript. The measured case
 * this guards is two results landing in ONE step: a `landedStep` cut fed at the
 * trigger's step admits both, while the request could only have carried the one
 * whose `seq` is at or below the trigger's.
 *
 * The third test is the no-number-moves property: where no rows interleave, the
 * two cuts select the same rows and must return identical bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimRenderRefusal, prefixAt, prefixAtSeq, prefixTextAt, prefixTextToSeq,
} from "./sim-render.mjs";

const isRefusal = code => error => error instanceof SimRenderRefusal && error.code === code;

/** One rendered-lane row, with only the fields either cut reads. */
function row(seq, landedStep, text, swapStep = null, after = text) {
  return {
    momentId: `m${seq}`,
    seq,
    landedStep,
    swapStep,
    before: text,
    after,
  };
}

const joined = texts => texts.join("\n\n");

/**
 * Two results land in step 5 (seq 3 and seq 4); the trigger is seq 3. Its
 * request cannot have carried seq 4's body, nor its own.
 */
const interleaved = () => ({
  rows: [
    row(1, 2, "A"),
    row(3, 5, "B"),
    row(4, 5, "C"),
    row(6, 8, "D"),
  ],
});

test("a result landing in the trigger's step but after its seq is excluded", () => {
  const rendered = interleaved();
  const text = prefixTextToSeq(rendered, 3, 5);
  assert.equal(text, joined(["A", "B"]));
  assert.ok(text.includes("B"));
  assert.equal(text.includes("C"), false,
    "seq 4 lands in step 5 but after the trigger's seq 3");
  assert.equal(text.includes("D"), false);

  // What a landedStep cut fed at the trigger's step admits: both same-step rows.
  assert.equal(prefixTextAt(rendered, 6), joined(["A", "B", "C"]));
});

test("a same-step result at or below the trigger's seq is included", () => {
  const rendered = interleaved();
  assert.equal(prefixTextToSeq(rendered, 4, 5), joined(["A", "B", "C"]),
    "seq 4 is the trigger itself, so its result is in that request's prefix");
  assert.equal(prefixTextToSeq(rendered, 2, 5), joined(["A"]));
  assert.equal(prefixTextToSeq(rendered, 1, 2), joined(["A"]),
    "the cut is inclusive of the trigger's own seq");
  assert.equal(prefixTextToSeq(rendered, 0, 5), "");
});

test("where nothing interleaves, the seq cut returns the landedStep cut's bytes", () => {
  const rendered = {
    rows: [
      row(0, 0, "alpha"),
      row(2, 3, "beta"),
      row(5, 7, "gamma"),
      row(6, 9, "delta"),
    ],
  };
  for (const trigger of rendered.rows) {
    const step = trigger.landedStep + 1;
    assert.equal(prefixTextToSeq(rendered, trigger.seq, step),
      prefixTextAt(rendered, step), `no rows interleave before seq ${trigger.seq}`);
    const bySeq = prefixAtSeq(rendered, trigger.seq, step);
    const byStep = prefixAt(rendered, step);
    assert.equal(bySeq.prefixSha256, byStep.prefixSha256);
    assert.equal(bySeq.prefixBytes, byStep.prefixBytes);
    assert.equal(bySeq.turns, byStep.turns);
  }
});

test("the seq cut keeps the body-at-step rule: before until the swap, after from it", () => {
  const rendered = { rows: [row(1, 2, "B", 4, "B-shape"), row(2, 3, "C")] };
  assert.equal(prefixTextToSeq(rendered, 1, 4), joined(["B"]),
    "a decision at step 4 is invisible at step 4");
  assert.equal(prefixTextToSeq(rendered, 1, 5), joined(["B-shape"]));
  assert.equal(prefixAtSeq(rendered, 1, 5).swapped, 1);
  assert.equal(prefixAtSeq(rendered, 1, 4).swapped, 0);
});

test("a malformed seq is refused by name, as a malformed step already is", () => {
  const rendered = interleaved();
  assert.throws(() => prefixTextToSeq(rendered, -1, 5), isRefusal("sim-render-seq-invalid"));
  assert.throws(() => prefixTextToSeq(rendered, 1.5, 5), isRefusal("sim-render-seq-invalid"));
  assert.throws(() => prefixTextToSeq(rendered, 3, -1), isRefusal("sim-render-step-invalid"));
  assert.throws(() => prefixAtSeq({ rows: null }, 3, 5), isRefusal("sim-render-record-invalid"));
});
