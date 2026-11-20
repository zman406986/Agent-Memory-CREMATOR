import assert from "node:assert/strict";
import { test } from "node:test";
import * as landedTrigger from "../src/entry/landed-bytes-trigger.js";
import type { EntryLandedBytesState } from "../src/entry/landed-bytes-trigger.js";
import { landedBytesTriggerVerdict, landedBytesVerdict } from "../src/entry/landed-bytes-trigger.js";

/**
 * The entry seam's landed-bytes trigger (ISSUE-128 slices 1–2; the live run's
 * configuration). The semantics are the sim's, restated in core: the accumulator
 * sums the eligible results' OWN byte lengths as they land, only a fire zeroes
 * it, and the verdict fires at the threshold only with work pending
 * (`dev/sim/sim-batch-units.mjs:639-650,704-709,740-741`).
 *
 * These tests pin the arithmetic; the mount's eligibility floor, the adapter
 * wiring and the bench flags are the ticket's later slices.
 */

/** The live run's chosen value (plan §5b): a probe value, not an optimum. */
const THRESHOLD = 240_000;

const EMPTY: EntryLandedBytesState = { pending: [], landedBytes: 0 };
const unit = (id: string, bytes: number): { readonly id: string; readonly bytes: number } =>
  ({ id, bytes });

/** Drives one stream and returns every fire, in order, plus the final state. */
function drive(
  units: readonly { readonly id: string; readonly bytes: number }[],
): { readonly batches: readonly (readonly string[])[]; readonly state: EntryLandedBytesState } {
  let state: EntryLandedBytesState = EMPTY;
  const batches: (readonly string[])[] = [];
  for (const next of units) {
    const verdict = landedBytesTriggerVerdict(state, THRESHOLD, next);
    state = verdict.state;
    if (verdict.kind === "fire") batches.push([...verdict.batch]);
  }
  return { batches, state };
}

interface StreamCase {
  readonly row: string;
  readonly units: readonly { readonly id: string; readonly bytes: number }[];
  readonly batches: readonly (readonly string[])[];
  readonly state: EntryLandedBytesState;
  /** Every accumulator reading, in landing order, before and after each verdict. */
  readonly readings?: readonly number[];
}

/**
 * One landing stream per row: what fires, what the batch names, and where the
 * accumulator ends. Every expected value is a literal, so a stream whose
 * arithmetic drifts fails on its own row name.
 */
const STREAM_CASES: readonly StreamCase[] = [
  {
    row: "an exact threshold fires and zeroes the accumulator",
    units: [unit("result:a", THRESHOLD - 1), unit("result:b", 1)],
    batches: [["result:a", "result:b"]],
    state: { pending: [], landedBytes: 0 },
    readings: [THRESHOLD - 1, 0],
  },
  {
    row: "below the threshold holds every landing in arrival order",
    units: [unit("result:a", 60_000), unit("result:b", 60_000), unit("result:c", 60_000)],
    batches: [],
    state: { pending: ["result:a", "result:b", "result:c"], landedBytes: 180_000 },
    readings: [60_000, 120_000, 180_000],
  },
  {
    row: "the fired batch is the whole pending stream, and only that stream",
    units: [unit("result:a", 90_000), unit("result:b", 90_000), unit("result:c", 60_000),
      unit("result:d", 200_000)],
    batches: [["result:a", "result:b", "result:c"]],
    state: { pending: ["result:d"], landedBytes: 200_000 },
    readings: [90_000, 180_000, 0, 200_000],
  },
  {
    row: "a landing that reaches the threshold fires alone",
    units: [unit("result:a", THRESHOLD), unit("result:b", THRESHOLD)],
    // A fire always carries rows, so no batch is ever empty.
    batches: [["result:a"], ["result:b"]],
    state: { pending: [], landedBytes: 0 },
    readings: [0, 0],
  },
  {
    row: "no removal lowers the accumulator: a host prune of a pending id is invisible",
    // `result:a` is shadowed by a host prune between landings. The trigger is
    // never told, because the sim never tells it either: pending is not filtered
    // by host removals, and the accumulator is not a depth that a removal lowers.
    units: [unit("result:a", 120_000), unit("result:b", 60_000), unit("result:c", 60_000)],
    // Monotone through the prune, then the crossing fires and resets. The fire
    // named the pruned id too: only a fire empties pending.
    batches: [["result:a", "result:b", "result:c"]],
    state: { pending: [], landedBytes: 0 },
    readings: [120_000, 180_000, 0],
  },
];

test("landed bytes accumulate by own length, fire at the threshold and reset — one row per stream", () => {
  for (const expected of STREAM_CASES) {
    const row = `row: ${expected.row}`;
    const { batches, state } = drive(expected.units);
    assert.deepEqual(batches, expected.batches, `${row} — the fires, in order`);
    assert.deepEqual(state, expected.state, `${row} — the final state`);
    for (const batch of batches) {
      assert.ok(batch.length > 0, `${row} — a fire never asks about nothing`);
    }
    if (expected.readings !== undefined) {
      // Re-drive to read the accumulator at each step, including after a fire.
      let walked: EntryLandedBytesState = EMPTY;
      const readings: number[] = [];
      for (const next of expected.units) {
        const verdict = landedBytesTriggerVerdict(walked, THRESHOLD, next);
        walked = verdict.state;
        readings.push(walked.landedBytes);
      }
      assert.deepEqual(readings, expected.readings, `${row} — the accumulator at each landing`);
    }
  }

  // The rule's own edge, called directly: a crossing with nothing pending holds
  // and moves no checkpoint, so the work that arrives later fires at once
  // instead of waiting for a second crossing.
  assert.deepEqual(
    landedBytesVerdict({ landedBytes: THRESHOLD + 1, threshold: THRESHOLD, pending: 0 }),
    { kind: "hold", landedBytes: THRESHOLD + 1 },
    "row: crossing with nothing pending holds and moves no checkpoint",
  );
  assert.deepEqual(
    landedBytesVerdict({ landedBytes: THRESHOLD, threshold: THRESHOLD, pending: 1 }),
    { kind: "fire", landedBytes: THRESHOLD },
    "row: the exact threshold with work pending fires",
  );
  assert.deepEqual(
    landedBytesVerdict({ landedBytes: THRESHOLD - 1, threshold: THRESHOLD, pending: 1 }),
    { kind: "hold", landedBytes: THRESHOLD - 1 },
    "row: one byte under the threshold holds",
  );

  // There is no subtract path at all: the module's runtime surface is the two
  // verdicts, so neither a host prune nor the lane's own removal can reduce the
  // bytes. A `forget`/`remove` export is exactly what monotonicity forbids.
  assert.deepEqual(Object.keys(landedTrigger).sort(),
    ["landedBytesTriggerVerdict", "landedBytesVerdict"],
    "row: the module exports no path that lowers the accumulator");
});

test("a bad threshold or byte count refuses by name, not by silence", () => {
  const thresholdCases: readonly [string, number][] = [
    ["zero threshold", 0], ["negative threshold", -1], ["fractional threshold", 1.5],
    ["NaN threshold", Number.NaN], ["infinite threshold", Number.POSITIVE_INFINITY],
  ];
  for (const [row, threshold] of thresholdCases) {
    assert.throws(
      () => landedBytesTriggerVerdict(EMPTY, threshold, unit("result:x", 1)),
      /positive safe integer/u,
      `row: ${row}`,
    );
  }
  const byteCases: readonly [string, number][] = [
    ["negative byte count", -1], ["fractional byte count", 0.5],
    ["NaN byte count", Number.NaN], ["infinite byte count", Number.POSITIVE_INFINITY],
  ];
  for (const [row, bytes] of byteCases) {
    assert.throws(
      () => landedBytesTriggerVerdict(EMPTY, THRESHOLD, unit("result:x", bytes)),
      /non-negative safe integer/u,
      `row: ${row}`,
    );
  }
});
