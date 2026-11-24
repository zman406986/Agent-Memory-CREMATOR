/**
 * The two skipped-leg assertions the `1d` run exposed, recorded by named reason.
 *
 * A run that never issued a `necromancy` call claims
 * `removal (archived exact bytes; restore not exercised)`; its restore
 * assertion must record `not-applicable` with `restore-not-exercised`, not
 * fail. A byte-check assertion whose only unchecked units are the removal
 * verdict's named skips (`re-exposed-under-later-result`, and so on) records
 * `not-applicable` with the reason counts; a recall with no check at all still
 * fails, and an unverified candidate is not hidden inside the skip disclosure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOT_APPLICABLE_UNITS_REASON, RESTORE_NOT_EXERCISED_REASON,
  byteLevelCheckVerdict, restoreAssertionVerdict, restoreNotExercisedRecord,
} from './opencode-run.mjs';

const reExposed = (recallId, callId) => ({
  recallId, callIds: [callId], status: 'not-applicable',
  reason: 're-exposed-under-later-result', why: 'the unit reappeared under a later result',
});

test('zero restore calls with ledger removals records not-applicable: restore-not-exercised', () => {
  const removal = {
    restore: { requiredRecallIds: ['recall:sha256:a'] },
    restoreAttempted: false,
    restoreIssuedCallIds: [],
    realRoute: true,
  };
  const row = restoreNotExercisedRecord(removal);
  assert.equal(row.status, 'not-applicable');
  assert.equal(row.reason, RESTORE_NOT_EXERCISED_REASON);
  assert.match(row.detail, /not exercised/u);
  // No ledger removal: there is nothing to restore, so this is not the record.
  assert.equal(restoreNotExercisedRecord({ ...removal,
    restore: { requiredRecallIds: [] } }), null);
});

test('an attempted but unproven restore still fails', () => {
  const removal = {
    restore: {
      requiredRecallIds: ['recall:sha256:a'],
      restorableRecallIds: ['recall:sha256:a'],
      pass: false,
      detail: 'the restored bytes differ from the archived unit',
    },
    restoreAttempted: true,
    restoreIssuedCallIds: ['call_restore'],
    restoreAttempts: [{
      callId: 'call_restore', recallId: 'recall:sha256:a', pass: false,
      why: 'the restored bytes differ from the archived unit',
    }],
    realRoute: true,
  };
  // The not-exercised record does not apply: an attempt exists.
  assert.equal(restoreNotExercisedRecord(removal), null);
  const row = restoreAssertionVerdict(removal);
  assert.equal(row.status, 'fail');
  assert.match(row.detail, /call_restore/u);
  assert.match(row.detail, /bytes differ/u);
});

test('two named skips and every remaining unit verified records not-applicable', () => {
  const removal = {
    callIdOnlyRecallIds: [],
    notApplicable: [
      reExposed('recall:sha256:a', 'call_a'),
      reExposed('recall:sha256:b', 'call_b'),
    ],
  };
  const generic = {
    candidates: [
      { recallId: 'recall:sha256:c', unitCallId: 'call_c', pass: true },
      { recallId: 'recall:sha256:d', unitCallId: 'call_d', pass: true },
    ],
    outside: [],
  };
  const verdict = byteLevelCheckVerdict(removal, generic);
  assert.equal(verdict.status, 'not-applicable');
  assert.equal(verdict.reason, NOT_APPLICABLE_UNITS_REASON);
  assert.deepEqual(verdict.reasons, { 're-exposed-under-later-result': 2 });
  assert.match(verdict.detail, /^2 unit\(s\) have no byte-level captured-body check/u);
  assert.match(verdict.detail, /re-exposed under a later result/u);
});

test('a recall with no byte-level check at all still fails', () => {
  const verdict = byteLevelCheckVerdict({
    callIdOnlyRecallIds: ['recall:sha256:x'],
    notApplicable: [],
  }, { candidates: [], outside: [] });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /recall:sha256:x/u);
});

test('an unverified candidate is not hidden by the skipped-unit disclosure', () => {
  const verdict = byteLevelCheckVerdict({
    callIdOnlyRecallIds: [],
    notApplicable: [reExposed('recall:sha256:a', 'call_a')],
  }, {
    candidates: [
      { recallId: 'recall:sha256:c', unitCallId: 'call_c', pass: true },
      { recallId: 'recall:sha256:e', unitCallId: 'call_e', pass: false },
    ],
    outside: [],
  });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /call_e/u);
});

test('every candidate verified and no skips passes', () => {
  const verdict = byteLevelCheckVerdict({ callIdOnlyRecallIds: [], notApplicable: [] }, {
    candidates: [{ recallId: 'recall:sha256:c', unitCallId: 'call_c', pass: true }],
    outside: [],
  });
  assert.equal(verdict.status, 'pass');
});
