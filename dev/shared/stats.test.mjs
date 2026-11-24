#!/usr/bin/env node
/**
 * ISSUE-072's gate for the one shared `median`.
 *
 * Run: `node --test dev/shared/stats.test.mjs`
 *
 * The even-length case is the whole reason this file exists: three copies
 * disagreed on it (two rounded the midpoint, one did not), so one record could
 * print two medians. The pinned behavior is the unrounded midpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from './stats.mjs';

test('median — the odd, even, empty and unsorted cases, and no mutation', () => {
  assert.equal(median([3, 1, 2]), 2, 'an odd-length sample is its middle value');
  assert.equal(median([5]), 5);

  // The disagreement, pinned: 1 and 2 give 1.5, never 2.
  assert.equal(median([1, 2]), 1.5, 'an even-length sample is the unrounded midpoint');
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([100000, 100001]), 100000.5);

  // "Not defined on this record" — the reading every call site already prints.
  assert.equal(median([]), null, 'an empty sample is null, not zero');

  assert.equal(median([-0.5, -2, 0]), -0.5, 'negative values sort numerically');
  assert.equal(median([-1, 1]), 0);
  assert.equal(median([10, -10]), 0);

  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2], 'the input is not mutated');
});

test('rounding at the call site reproduces the old rounded copies', () => {
  // `select.mjs` and `lanes.mjs` used Math.round((a+b)/2); score.mjs used
  // (a+b)/2. For every sample, Math.round of this median is the old rounded
  // value, and for odd samples it is a no-op. This is the re-baseline guarantee.
  const samples = [
    [], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [0, 1], [166000, 166001],
    [-1, 0], [2, 2], [2, 2, 2, 3], [7, 7, 7, 7],
  ];
  for (const sample of samples) {
    const sorted = [...sample].sort((a, b) => a - b);
    const old = sorted.length === 0 ? null : sorted.length % 2 === 1
      ? sorted[sorted.length >> 1]
      : Math.round((sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2);
    assert.equal(median(sample) === null ? null : Math.round(median(sample)), old,
      JSON.stringify(sample));
  }
});
