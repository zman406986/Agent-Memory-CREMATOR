#!/usr/bin/env node
/**
 * The claim surface's wording matches the measurement (eighth audit).
 *
 * These tests pin the sentences, not a new checker:
 *
 *   - a run that claimed a removal and verified units but failed the run-level
 *     measurement says "no removal measured at the run level", never "claims no
 *     removal" (FIX 1);
 *   - the unclaimed real-route reason note names each part's own reason instead
 *     of hardcoding `never-sent-to-model` (FIX 2);
 *   - the class sentence's segment bound is derived from the verified units'
 *     segments only (FIX 4);
 *   - a recall with one restore-answer part and one never-sent part records
 *     both call ids with their reasons (FIX 5).
 *
 * Offline only: no host binary, no key, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  REAL_ROUTE_ABSENCE_ASSERTION_NAME, notApplicableReasonCounts, notApplicableUnitCount,
  realRouteRemovalVerdict, removalClassLabel, removalReasonNote, verifiedSegmentBound,
} from './opencode-run.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-claim-text-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/* --------------------------------------------------------------- FIX 1 */

test('eighth audit FIX 1: a partial claimed run states the run-level failure, not "claims no removal"', () => {
  // 1 of 2 recalls verified, run-level measurement false: the claim label
  // names the verified recall, so the class sentence must not say the run
  // claims no removal.
  const partial = removalClassLabel({
    realRoute: true, claimed: true, measuredUnits: 1, candidateUnits: 2, removalMeasured: false,
  });
  assert.match(partial, /no removal measured at the run level/u);
  assert.match(partial, /1 verified recall\(s\) of 2 candidate recall\(s\)/u);
  assert.match(partial, /the run-level measurement did not hold/u);
  assert.doesNotMatch(partial, /claims no removal/u,
    'a partial run that claimed a removal never reads as a no-claim run');
  // A 1/1 raw leak has the same shape: every candidate verified, the run-level
  // field refused it, and the claim is still a removal claim.
  const leak = removalClassLabel({
    realRoute: true, claimed: true, measuredUnits: 1, candidateUnits: 1, removalMeasured: false,
  });
  assert.match(leak, /no removal measured at the run level/u);
  assert.match(leak, /the run-level measurement did not hold/u);
  assert.doesNotMatch(leak, /claims no removal/u);
  // The rule: "claims no removal" belongs only to `claimed !== true` or
  // `measuredUnits === 0`.
  const unclaimed = removalClassLabel({
    realRoute: true, claimed: false, measuredUnits: 1, candidateUnits: 1, removalMeasured: false,
  });
  assert.match(unclaimed, /no removal claimed/u);
  assert.doesNotMatch(unclaimed, /run-level/u);
  const zero = removalClassLabel({
    realRoute: true, claimed: true, measuredUnits: 0, candidateUnits: 2, removalMeasured: false,
  });
  assert.match(zero, /no removal claimed/u);
  assert.doesNotMatch(zero, /run-level/u);
});

/* --------------------------------------------------------------- FIX 2 */

test('eighth audit FIX 2: the unclaimed real-route reason note names each part\'s own reason', () => {
  const cases = [
    ['not-in-this-runs-capture', "not in this run's capture"],
    ['re-exposed-under-later-result', 're-exposed under a later result'],
    ['restore-answer-excluded', 'restore answer excluded from the removal scan'],
    ['before-body-before-compaction', 'before a recorded compaction'],
  ];
  for (const [reason, phrase] of cases) {
    const note = removalReasonNote({
      claimed: false,
      realRoute: true,
      captureAvailable: true,
      outsideCount: 1,
      notApplicableCount: 1,
      notApplicableUnits: 1,
      notApplicableReasons: notApplicableReasonCounts(
        [{ recallId: 'recall:sha256:aa', reason, callIds: ['call_claim_text'] }], 'call-ids'),
    });
    assert.match(note, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), note);
    assert.match(note, /1 unit\(s\) are not-applicable/u, note);
    assert.doesNotMatch(note, /never reached a captured request body/u,
      'the note never hardcodes the never-sent wording');
    assert.doesNotMatch(note, /\(never-sent-to-model\)/u);
    assert.doesNotMatch(note, /never sent to the model/u, note);
  }
});

/* --------------------------------------------------------------- FIX 3 */

test('eighth audit FIX 3: the absence assertion name states the exceptions and the segment bound', () => {
  assert.match(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /except \(a\) under a new call id declaring a read of the same file path/u);
  assert.match(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /\(b\) inside another removed unit's own result whose own check verified its removal/u);
  assert.match(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /\(c\) in the answer to that recall's own run-issued `necromancy` restore/u);
  assert.match(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /same-tool control in every post-receipt body within the measured segment/u);
  assert.doesNotMatch(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /same-tool control in every post-receipt body;/u);
});

/* --------------------------------------------------------------- FIX 4 */

test('eighth audit FIX 4: a compaction on a failed candidate does not bound a verified unit sentence', () => {
  const candidates = [
    { unitCallId: 'call_verified', pass: true },
    { unitCallId: 'call_failed', pass: false },
  ];
  // The failed candidate's segment ends at a compaction; the verified unit's
  // segment is open, so the phrase must not say the window ends there.
  const failedBounded = [
    { unitCallId: 'call_verified', compactionAtSeq: null },
    { unitCallId: 'call_failed', compactionAtSeq: 6 },
  ];
  assert.equal(verifiedSegmentBound(failedBounded, candidates), false);
  const label = removalClassLabel({
    realRoute: true, claimed: true, measuredUnits: 1, candidateUnits: 2,
    segmentBound: verifiedSegmentBound(failedBounded, candidates),
  });
  assert.doesNotMatch(label, /through the measured segment/u);
  assert.doesNotMatch(label, /the window ends at the recorded compaction/u);
  // A verified segment that does end at a compaction bounds the sentence.
  const verifiedBounded = [
    { unitCallId: 'call_verified', compactionAtSeq: 6 },
    { unitCallId: 'call_failed', compactionAtSeq: null },
  ];
  assert.equal(verifiedSegmentBound(verifiedBounded, candidates), true);
  assert.match(removalClassLabel({
    realRoute: true, claimed: true, measuredUnits: 1, candidateUnits: 2,
    segmentBound: verifiedSegmentBound(verifiedBounded, candidates),
  }), /the window ends at the recorded compaction/u);
  // The phrase covers every verified unit; one open verified segment keeps the
  // unbounded wording even when another verified segment is bounded.
  assert.equal(verifiedSegmentBound([
    { unitCallId: 'call_one', compactionAtSeq: 6 },
    { unitCallId: 'call_two', compactionAtSeq: null },
  ], [
    { unitCallId: 'call_one', pass: true },
    { unitCallId: 'call_two', pass: true },
  ]), false);
  assert.equal(verifiedSegmentBound(failedBounded, []), false,
    'a run with no verified unit has no bounded window to name');
});

/* --------------------------------------------------------------- FIX 5 */

/**
 * One ledger recall with two tool parts: the run-issued `necromancy` answer
 * (so the ask can remove the answer itself) and a call that never reached the
 * capture. The archive bytes are valid, so the ledger/blobs check has a
 * subject even though no candidate is measured.
 */
function mixedRecallLedger(dir) {
  const blobRoot = join(dir, 'blobs');
  const partText = 'mix-part-bytes';
  const partHash = sha256(partText);
  const part = writeBlobFile(blobRoot, partHash, partText);
  const manifestText = 'mix-manifest';
  const manifestHash = sha256(manifestText);
  const manifest = writeBlobFile(blobRoot, manifestHash, manifestText);
  const recallId = `recall:sha256:${manifestHash}`;
  return {
    recallId,
    answerCallId: 'call_mix_restore_answer',
    neverSentCallId: 'call_mix_never_sent',
    ledger: {
      blobRoot,
      recallIds: [recallId],
      recallManifests: [{ recallId, manifestSha256: manifestHash }],
      recallParts: [
        {
          recallId,
          partIndex: 0,
          sourceNodeId: `oc:ses_mix:tool:call_mix_restore_answer`,
          sourceSha256: partHash,
          sourceByteLength: part.bytes,
          blobSha256: partHash,
        },
        {
          recallId,
          partIndex: 1,
          sourceNodeId: `oc:ses_mix:tool:call_mix_never_sent`,
          sourceSha256: partHash,
          sourceByteLength: part.bytes,
          blobSha256: partHash,
        },
      ],
      blobs: [
        { sha256: manifestHash, byteLength: manifest.bytes },
        { sha256: partHash, byteLength: part.bytes },
      ],
    },
  };
}

test('eighth audit FIX 5: a mixed recall records the restore-answer part beside the never-sent part', () => {
  const dir = scratch();
  try {
    const { recallId, answerCallId, neverSentCallId, ledger } = mixedRecallLedger(dir);
    const task = { role: 'user', content: 'mixed recall task' };
    const declaration = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: answerCallId,
        function: { name: 'necromancy', arguments: JSON.stringify({ id: recallId }) },
      }],
    };
    const rows = [
      { seq: 1, main_turn: 0, messages: [task] },
      { seq: 2, main_turn: 1, messages: [task, declaration] },
      {
        seq: 3,
        main_turn: 2,
        messages: [task, declaration,
          { role: 'tool', tool_call_id: answerCallId, content: 'RESTORED BYTES' }],
      },
    ];
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.candidates.length, 0, JSON.stringify(verdict.failures));
    const row = verdict.notApplicable.find((item) => item.recallId === recallId);
    assert.ok(row, JSON.stringify(verdict.notApplicable));
    assert.deepEqual(row.callIds, [answerCallId, neverSentCallId],
      'both parts stay in the not-applicable accounting');
    assert.deepEqual(row.partReasons, [
      { callId: answerCallId, reason: 'restore-answer-excluded' },
      { callId: neverSentCallId, reason: 'never-sent-to-model' },
    ]);
    assert.equal(row.reason, 'restore-answer-excluded',
      'the row keeps the strongest reason of its parts');
    assert.match(row.why, /restore-answer-excluded/u);
    assert.match(row.why, new RegExp(neverSentCallId, 'u'));
    assert.deepEqual(notApplicableUnitCount([row]), { count: 2, basis: 'call-ids' });
    assert.deepEqual(notApplicableReasonCounts(verdict.notApplicable, 'call-ids'),
      { 'restore-answer-excluded': 1, 'never-sent-to-model': 1 },
      'the call-id weighting counts each part under its own reason (ninth audit FIX 1); '
        + 'the row\'s strongest reason is only the one-reason fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
