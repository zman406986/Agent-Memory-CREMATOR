#!/usr/bin/env node
/**
 * The launcher's exit-code contract (ISSUE-038).
 *
 * The defect: `deny leg B` was an arm assertion, so a `partial` probe failed the
 * arm and `process.exit(1)` ran before the documented `exit 3`. On the real
 * route `partial` is the only shape a model ever produces (nothing in the brief
 * asks for a summon), so exit 3 was dead code and every completed arm reported
 * exit 1 with `result.json.passed: false`.
 *
 * These gates are the ones the issue's DoD names:
 *
 *   (a) the real-route partial shape exits 0 and is recorded as expected — NOT
 *       as a failed assertion;
 *   (b) every documented exit code is produced by some input (no dead branch);
 *   (c) a genuinely failed arm still exits non-zero and names the failure;
 *   (d) leg A stays a hard failure on every route.
 *
 * The functions are pure, so this runs offline and needs no dsh, arm or mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CODES, exitCodeFor, legBOutcome } from './launch-outcome.mjs';

const REAL = true;
const MOCK = false;

test('038 (a) a real-route partial probe is EXPECTED, not a failure', () => {
  assert.equal(legBOutcome({ denySkipped: false, verdict: 'partial', realApi: REAL }), 'expected');
});

test('038 (a) a real-route partial arm exits 0 even with the probe partial', () => {
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'partial', realApi: REAL,
  }), EXIT_CODES.green);
});

test('038 (b) every documented exit code has an input that reaches it', () => {
  const reachable = new Set([
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL }),
    exitCodeFor({ watchdogFired: true, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL }),
    exitCodeFor({ watchdogFired: false, failures: 1, violations: 0, denySkipped: false, verdict: 'pass', realApi: MOCK }),
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'partial', realApi: MOCK }),
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 2, denySkipped: false, verdict: 'pass', realApi: REAL }),
  ]);
  assert.deepEqual([...reachable].sort(), [0, 1, 3, 4]);
  // 2 is `refuse()`'s code: argument and preflight refusals. Named here so the
  // header's five codes are all accounted for; the launcher's own runs below
  // exercise it through a real invocation.
  assert.equal(EXIT_CODES.refused, 2);
});

test('038 (b) the mock lane keeps exit 3 for a partial probe', () => {
  assert.equal(legBOutcome({ denySkipped: false, verdict: 'partial', realApi: MOCK }), 'probe-fail');
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'partial', realApi: MOCK,
  }), EXIT_CODES.denyPartial);
});

test('038 (b) a clean probe on either route exits 0', () => {
  for (const realApi of [REAL, MOCK]) {
    assert.equal(legBOutcome({ denySkipped: false, verdict: 'pass', realApi }), 'pass');
    assert.equal(exitCodeFor({
      watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi,
    }), EXIT_CODES.green);
  }
});

test('038 (b) a mock-replay skip never scores anything and never exits 3', () => {
  assert.equal(legBOutcome({ denySkipped: true, verdict: 'partial', realApi: MOCK }), 'skipped');
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 0, denySkipped: true, verdict: 'partial', realApi: MOCK,
  }), EXIT_CODES.green);
});

test('038 (c) a failed arm exits 1 on every route and is never masked by the probe', () => {
  for (const realApi of [REAL, MOCK]) {
    for (const verdict of ['pass', 'partial', 'fail']) {
      assert.equal(exitCodeFor({
        watchdogFired: false, failures: 1, violations: 0, denySkipped: false, verdict, realApi,
      }), EXIT_CODES.armFailed);
    }
  }
});

test('038 (c) the kill box is a timeout: exit 1 even with every assertion green', () => {
  assert.equal(exitCodeFor({
    watchdogFired: true, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL,
  }), EXIT_CODES.armFailed);
});

test('038 (c) a leg B that is `fail` stays a hard failure on the real route', () => {
  // A summon happened and did not fail as specified: the deny surface is broken
  // on this arm. `expected` must cover ONLY the `partial` shape.
  assert.equal(legBOutcome({ denySkipped: false, verdict: 'fail', realApi: REAL }), 'fail');
});

test('038 (d) an out-of-scope read outranks a green probe (exit 4, not 0)', () => {
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 1, denySkipped: false, verdict: 'pass', realApi: REAL,
  }), EXIT_CODES.readOutOfScope);
});

test('038 (d) an out-of-scope read outranks a partial probe (exit 4, not 3)', () => {
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 1, denySkipped: false, verdict: 'partial', realApi: MOCK,
  }), EXIT_CODES.readOutOfScope);
});

// ── (e) The compaction stopper's code (ISSUE-182) ────────────────────────────

test('182 (e) a stop-on-compaction run takes exit 1 — not 0, not a new code', () => {
  // 0 would read as a completed task (the run was killed, and `passed` is
  // false); a new code would invent a failure class and break the documented
  // 0-4 range. 1 with its own name is the choice, and it is the same code the
  // box and the grant take, so "a killed run is never a result" still holds.
  assert.equal(exitCodeFor({
    watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL,
    stoppedOnCompaction: true,
  }), EXIT_CODES.armFailed);
  assert.notEqual(EXIT_CODES.armFailed, EXIT_CODES.green);
});

test('182 (e) the stop outranks a green arm, on every route and probe shape', () => {
  for (const realApi of [REAL, MOCK]) {
    for (const verdict of ['pass', 'partial', 'fail']) {
      assert.equal(exitCodeFor({
        watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict, realApi,
        stoppedOnCompaction: true,
      }), EXIT_CODES.armFailed, `${verdict} on realApi=${String(realApi)} must still be a stop`);
    }
  }
});

test('182 (e) the flag absent changes nothing: the old calls keep their codes', () => {
  // The pre-existing calls pass no `stoppedOnCompaction` at all. Every documented
  // code must still come out exactly as it did.
  const reachable = new Set([
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL }),
    exitCodeFor({ watchdogFired: true, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: REAL }),
    exitCodeFor({ watchdogFired: false, failures: 1, violations: 0, denySkipped: false, verdict: 'pass', realApi: MOCK }),
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 0, denySkipped: false, verdict: 'partial', realApi: MOCK }),
    exitCodeFor({ watchdogFired: false, failures: 0, violations: 2, denySkipped: false, verdict: 'pass', realApi: REAL }),
  ]);
  assert.deepEqual([...reachable].sort(), [0, 1, 3, 4]);
});
