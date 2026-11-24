#!/usr/bin/env node
/**
 * The bench launcher's outcome accounting (ISSUE-038).
 *
 * Two outcomes used to be one: the deny probe's leg B was registered as an arm
 * assertion, so a `partial` probe (a real model never attempted the summon — the
 * known real-route shape) failed the arm, `result.json.passed` went `false`, and
 * the launcher exited 1 before its documented exit 3 could run. The branch was
 * dead code for every real run.
 *
 * This module keeps the two apart as pure functions so every exit code has a
 * path a test can exercise:
 *
 *   `legBOutcome` — what the probe's leg B MEANS for this route.
 *   `exitCodeFor` — which documented code the run ends with.
 *
 * The arm's own assertions are decided before the probe in `exitCodeFor`, so a
 * real failure is never masked by a probe outcome, and an out-of-scope read is
 * never masked by either.
 */

/**
 * Leg B's score.
 *
 * - `skipped`    — mock-replay: the record carries no `subagent` call, so there
 *                  is nothing to measure and the skip is stated, not scored.
 * - `pass`       — the scripted/real summon failed UNKNOWN_TOOL as specified.
 * - `expected`   — real route, `partial`: the model never attempted a summon.
 *                  This is the known shape (round-1 SUMMARY.md item 3; the
 *                  2026-10-24 racoons arm) and must not turn a clean arm red.
 * - `probe-fail` — mock lane, `partial`: the scripted summon was mandatory and
 *                  did not happen, so the probe measured nothing. The arm can be
 *                  clean and the run still must not report a green probe.
 * - `fail`       — a summon happened and did not fail the specified way: the
 *                  deny surface is broken on this arm.
 *
 * @param {{denySkipped: boolean, verdict: string, realApi: boolean}} input
 * @returns {'skipped'|'pass'|'expected'|'probe-fail'|'fail'}
 */
export function legBOutcome({ denySkipped, verdict, realApi }) {
  if (denySkipped) return 'skipped';
  if (verdict === 'pass') return 'pass';
  if (verdict === 'partial') return realApi ? 'expected' : 'probe-fail';
  return 'fail';
}

/** Documented exit codes. Every one is produced by an exercised path. */
export const EXIT_CODES = Object.freeze({
  green: 0,
  armFailed: 1,
  refused: 2,
  denyPartial: 3,
  readOutOfScope: 4,
});

/**
 * The launcher's exit code.
 *
 * Order matters and is the defect's fix:
 *   1. a stopper — exit 1: a killed run is never a result. The kill box and the
 *      token grant are timeouts; `--stop-on-compaction` (ISSUE-182) is a
 *      LANDMARK and takes the same code for the same reason (the child was
 *      killed, so nothing completed), with its own name printed by the launcher
 *      (`stopped-on-compaction`). 0 would let it read as a completed task;
 *   2. an out-of-scope read — exit 4: the A/B pairing is void, and naming that
 *      is more useful than the generic 1 a co-occurring failure would give (the
 *      stderr lines below still name every failed assertion);
 *   3. the arm's own assertions — exit 1;
 *   4. a partial deny probe on the mock lane — exit 3 (the probe measured
 *      nothing);
 *   5. otherwise 0. On the real route a `partial` probe is `expected`, so it
 *      cannot reach 3: the arm completed and the probe's shape is recorded.
 *
 * @param {{watchdogFired: boolean, failures: number, violations: number,
 *          denySkipped: boolean, verdict: string, realApi: boolean,
 *          stoppedOnCompaction?: boolean}} input
 * @returns {number}
 */
export function exitCodeFor({ watchdogFired, failures, violations, denySkipped, verdict, realApi,
  stoppedOnCompaction = false }) {
  if (watchdogFired || stoppedOnCompaction) return EXIT_CODES.armFailed;
  if (violations > 0) return EXIT_CODES.readOutOfScope;
  if (failures > 0) return EXIT_CODES.armFailed;
  if (!denySkipped && verdict === 'partial' && !realApi) return EXIT_CODES.denyPartial;
  return EXIT_CODES.green;
}
