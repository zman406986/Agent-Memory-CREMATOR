import assert from "node:assert/strict";
import { test } from "node:test";
import * as batchTrigger from "../src/entry/batch-trigger.js";
import { batchVerdict } from "../src/entry/batch-trigger.js";
import type { EntryBatchState } from "../src/entry/batch-trigger.js";

/**
 * The entry seam's batch trigger (ISSUE-117 chunk B1; ADR-0035 §1–§3, §6).
 *
 * The trigger counts NEW eligible results and nothing else: at `entryAskBatchSize`
 * 1 every result fires its own ask (today's cadence); above 1 the results hold
 * until the count reaches the knob, one ask then covers the batch and the count
 * resets. A partial batch at session end is carried, never flushed — hence there
 * is no `flush` entry point to call. These tests pin the arithmetic; the wired
 * ask path and the applies are B3's.
 */
function drive(size: number, count: number): readonly (readonly string[])[] {
  let state: EntryBatchState = { pending: [] };
  const batches: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    const verdict = batchVerdict(state, size, `result:${String(i)}`);
    state = verdict.state;
    if (verdict.kind === "fire") batches.push([...verdict.batch]);
  }
  return batches;
}

/**
 * One row per knob setting. Each row drives the same stream — six ids at the
 * knob's cadence — so the rows differ only in the size, and a fixed size
 * substituted for the knob fails the row that names the other. The carried-tail
 * assertions live beside them because a size that fires the tail early is the
 * same defect as a size that fires a row early.
 */
const CASES: readonly (readonly [string, () => void])[] = [
  ["batchSize 1 fires one ask per eligible result and holds nothing", () => {
    const name = "batchSize 1 fires one ask per eligible result and holds nothing";
    assert.deepEqual(drive(1, 3), [["result:0"], ["result:1"], ["result:2"]],
      `row: ${name} — every result is its own one-row batch`);
    const first = batchVerdict({ pending: [] }, 1, "result:x");
    assert.equal(first.kind, "fire", `row: ${name} — size 1 fires`);
    assert.deepEqual(first.state, { pending: [] }, `row: ${name} — size 1 carries no state between calls`);
  }],
  ["batchSize 3 fires on the third and resets", () => {
    const name = "batchSize 3 fires on the third and resets";
    assert.deepEqual(drive(3, 6), [
      ["result:0", "result:1", "result:2"],
      ["result:3", "result:4", "result:5"],
    ], `row: ${name} — two full batches, in arrival order`);
  }],
  ["a partial batch is carried and never flushed", () => {
    const name = "a partial batch is carried and never flushed";
    // Five calls at 3: one fire, then two results held — and no sixth call exists.
    let state: EntryBatchState = { pending: [] };
    const batches: (readonly string[])[] = [];
    for (let i = 0; i < 5; i += 1) {
      const verdict = batchVerdict(state, 3, `result:${String(i)}`);
      state = verdict.state;
      if (verdict.kind === "fire") batches.push(verdict.batch);
    }
    assert.deepEqual(batches, [["result:0", "result:1", "result:2"]],
      `row: ${name} — the tail raises no ask of its own`);
    assert.deepEqual(state.pending, ["result:3", "result:4"],
      `row: ${name} — the carried two are still named in the state the last call returned`);
    // There is no flush: the module's runtime surface is `batchVerdict` alone.
    // A `flush` export is exactly what "never flushed" forbids, so its absence is
    // part of the contract, not an incidental detail. Names come from the loaded
    // module namespace, so a helper added beside the trigger fails this row.
    assert.deepEqual(Object.keys(batchTrigger), ["batchVerdict"],
      `row: ${name} — the module exports the trigger and nothing a caller could flush with`);
  }],
];

test("batch trigger — one row per knob setting and the carried tail", () => {
  for (const [name, run] of CASES) {
    try { run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});

test("a hold names the pending batch and changes no unit", () => {
  const held = batchVerdict({ pending: ["result:a"] }, 3, "result:b");
  assert.equal(held.kind, "hold",
    "row: a hold names the pending batch — a partly filled batch asks nothing");
  assert.deepEqual(held.state.pending, ["result:a", "result:b"],
    "row: a hold names the pending batch — the new id is appended in arrival order");
  const fired = batchVerdict({ pending: ["result:a", "result:b"] }, 3, "result:c");
  assert.equal(fired.kind, "fire",
    "row: a hold names the pending batch — the id that fills the knob fires it");
  assert.deepEqual(fired.kind === "fire" ? fired.batch : [], ["result:a", "result:b", "result:c"],
    "row: a hold names the pending batch — the fired batch is every held id plus the new one");
  assert.deepEqual(fired.state, { pending: [] },
    "row: a hold names the pending batch — firing resets the accumulator");
});
