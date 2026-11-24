/**
 * The `--capture-log` replay summary's `removalMeasuredAny`.
 *
 * The summary prints the removal count view it reads from the result object
 * beside it. `runBench` states the count view on `removal.removalMeasuredAny`;
 * a result record that carries the `removals` view states it as
 * `removals.measuredAny`. Neither shape has a top-level
 * `removalMeasuredAny`, so that field must never decide the printed value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replayRemovalMeasuredAny } from './opencode-run.mjs';

/** The printed summary fragment, serialized the way the replay prints it. */
function printedSummary(result) {
  return JSON.stringify({ removalMeasuredAny: replayRemovalMeasuredAny(result) });
}

test('the replay summary reads the two count views and never the bare top-level field', () => {
  // The result-record shape.
  assert.equal(printedSummary({ removals: { measured: false, measuredAny: true } }),
    '{"removalMeasuredAny":true}', 'a result record prints its measuredAny');
  assert.equal(printedSummary({ removals: { measured: false, measuredAny: false } }),
    '{"removalMeasuredAny":false}');
  // The runBench shape, read through its removal verdict.
  assert.equal(printedSummary({ removal: { removalMeasuredAny: true } }),
    '{"removalMeasuredAny":true}', 'a runBench result is read through its verdict');
  // Both present: the record wins.
  assert.equal(printedSummary({
    removals: { measuredAny: false },
    removal: { removalMeasuredAny: true },
  }), '{"removalMeasuredAny":false}', 'the removals record wins when both shapes are present');
  // The field that exists on neither shape is ignored.
  assert.equal(printedSummary({ removalMeasuredAny: true }), '{"removalMeasuredAny":false}',
    'the absent top-level field is never read');
  assert.equal(printedSummary({}), '{"removalMeasuredAny":false}');
});
