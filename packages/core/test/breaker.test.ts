import assert from "node:assert/strict";
import { test } from "node:test";
import { Breaker } from "../src/guard/breaker.js";
import type { BreakerState } from "../src/guard/types.js";

/**
 * Every breaker rule reads the same three-value accounting (0, 1, 2 and the
 * disable that follows), so each row drives a step sequence and names the whole
 * state it expects after every step. A row that pinned only `disabled` would let
 * the streak drift, and the streak is what a reopened session restores.
 */
const CASES: readonly (readonly [string, () => void])[] = [
  ["the default state is quiet", () => {
    const name = "the default state is quiet";
    const quiet: BreakerState = { consecutiveValidationFailures: 0, disabled: false };
    assert.deepEqual(new Breaker().state(), quiet, `row: ${name} — an unseeded breaker starts quiet`);
    assert.deepEqual(new Breaker(quiet).state(), quiet, `row: ${name} — an explicitly quiet breaker is the same state`);
  }],
  ["two refusals disable; a completed validation re-arms", () => {
    const name = "two refusals disable; a completed validation re-arms";
    const b = new Breaker();
    b.recordFailure();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 1, disabled: false },
      `row: ${name} — one refusal is a streak, not a disable`);
    b.recordFailure();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 2, disabled: true },
      `row: ${name} — the second refusal must disable`);
    // The disable lasts until a validation completes, never for the whole run.
    b.recordSuccess();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 0, disabled: false },
      `row: ${name} — a completed validation re-arms the breaker`);
  }],
  ["one failure then a completed validation resets the streak", () => {
    const name = "one failure then a completed validation resets the streak";
    const b = new Breaker();
    b.recordFailure();
    b.recordSuccess();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 0, disabled: false },
      `row: ${name} — the streak must clear`);
  }],
  ["a refusal while quiet does not extend the disable", () => {
    const name = "a refusal while quiet does not extend the disable";
    const b = new Breaker();
    for (let i = 0; i < 5; i += 1) b.recordFailure();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 2, disabled: true },
      `row: ${name} — a refusal past the disable is its own answer, not a new failure`);
    b.recordSuccess();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 0, disabled: false },
      `row: ${name} — the streak clears exactly as it would without the extra refusals`);
  }],
  ["a persisted streak carries, and one more refusal disables", () => {
    const name = "a persisted streak carries, and one more refusal disables";
    const b = new Breaker({ consecutiveValidationFailures: 1, disabled: false });
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 1, disabled: false },
      `row: ${name} — the constructor must carry the streak`);
    b.recordFailure();
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 2, disabled: true },
      `row: ${name} — one more refusal reaches the disable`);
  }],
  ["a persisted full streak is already disabled", () => {
    const name = "a persisted full streak is already disabled";
    const b = new Breaker({ consecutiveValidationFailures: 2, disabled: true });
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 2, disabled: true },
      `row: ${name} — a reopened session keeps its disable`);
  }],
  ["an inconsistent persisted state is refused", () => {
    const name = "an inconsistent persisted state is refused";
    assert.throws(() => new Breaker({ consecutiveValidationFailures: 0, disabled: true }),
      `row: ${name} — disabled without a full streak is impossible`);
  }],
  ["a returned state does not alias internals", () => {
    const name = "a returned state does not alias internals";
    const b = new Breaker();
    b.recordFailure();
    const first = b.state();
    assert.deepEqual(first, { consecutiveValidationFailures: 1, disabled: false },
      `row: ${name} — the first read names the streak`);
    b.recordFailure();
    assert.deepEqual(first, { consecutiveValidationFailures: 1, disabled: false },
      `row: ${name} — a returned state must not change under a later record`);
    assert.deepEqual(b.state(), { consecutiveValidationFailures: 2, disabled: true },
      `row: ${name} — the breaker's own state advanced`);
  }],
];

test("breaker accounting — one row per step sequence", () => {
  for (const [name, run] of CASES) {
    try { run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});
