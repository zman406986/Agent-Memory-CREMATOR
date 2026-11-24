#!/usr/bin/env node
/**
 * A `prune-threshold` line is an EVALUATION; `crossed: true` is a FIRE.
 *
 * The mount began writing one line per step boundary that read the bar, with a
 * `crossed` field on each, so the raw line count stopped being a fire count. A
 * live run's headline is how many times the prune fired, so a reader that
 * counts lines inflates the number by the number of steps.
 *
 * What is held here:
 *
 *   (a) three evaluation lines, one crossed, count as ONE fire;
 *   (b) a pre-change journal (no `crossed` at all) still counts every line: a
 *       line existed only when it fired, so a missing field means a fire;
 *   (c) a mixed file — old lines then new ones — counts the old ones in full;
 *   (d) the predicate ignores other kinds and tolerates a non-array;
 *   (e) the two real consumers use it: `run.mjs` filters its threshold
 *       assertions, `bench-run.mjs` reports `pruneFires`, and neither counts
 *       raw `prune-threshold` lines as fires.
 *
 * `run.mjs` ends in `await main()`, so it cannot be imported; (e) is a static
 * assertion on its source, as `real-path-journal.test.mjs` does for its own
 * launcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRUNE_THRESHOLD_KIND, countPruneFires, isPruneFire } from './prune-fires.mjs';

const RIG_DIR = fileURLToPath(new URL('./', import.meta.url));
const BENCH_DIR = join(RIG_DIR, '..', 'bench');

/** One journal line, in the mount's shape. */
function threshold(crossed, extra = {}) {
  return { kind: 'prune-threshold', threshold: 20_000, estimatedTokens: 25_000, ...extra,
    ...(crossed === undefined ? {} : { crossed }) };
}

test('(a) three evaluation lines with one crossing count as one fire', () => {
  const lines = [
    threshold(false),
    threshold(true),
    threshold(false),
  ];
  assert.equal(countPruneFires(lines), 1);
  assert.equal(lines.filter(isPruneFire).length, 1,
    'exactly the crossed line is a fire');
  assert.equal(lines.find(isPruneFire), lines[1],
    'and it is the one that crossed');
});

test('(b) a pre-change line has no `crossed` and is a fire', () => {
  // The back-compat rule: before the change a line existed only when it fired.
  const old = [threshold(undefined), threshold(undefined)];
  assert.equal(isPruneFire(old[0]), true);
  assert.equal(countPruneFires(old), 2);
  // An explicit false is still a reading: the rule keys on the FIELD's absence.
  assert.equal(countPruneFires([threshold(false)]), 0);
});

test('(c) a mixed file counts old fires and new crossed lines together', () => {
  const lines = [
    threshold(undefined), // pre-change fire
    threshold(false),     // new evaluation
    threshold(true),      // new fire
    threshold(undefined), // pre-change fire
  ];
  assert.equal(countPruneFires(lines), 3);
});

test('(d) other kinds are never fires, and a non-array counts as zero', () => {
  assert.equal(isPruneFire({ kind: 'prune-recorded' }), false);
  assert.equal(isPruneFire({ kind: 'prune-threshold-other' }), false);
  assert.equal(isPruneFire(null), false);
  assert.equal(countPruneFires(null), 0);
  assert.equal(countPruneFires(undefined), 0);
  assert.equal(PRUNE_THRESHOLD_KIND, 'prune-threshold',
    'the predicate names the kind it reads');
});

