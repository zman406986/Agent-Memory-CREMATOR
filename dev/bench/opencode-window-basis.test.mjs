#!/usr/bin/env node
/**
 * The window sentences count on the basis they state (tenth audit).
 *
 * One recall can carry three parts with different fates: the answer to the
 * run-issued `necromancy` restore (a captured result that is not a removable
 * unit) and two calls that never reached a captured body. The recall-level
 * figure is then one row, the unit figure is three, and the reason counts must
 * be weighted by the same basis as the figure they accompany:
 *
 *   - the removal window's `why` states the call-id figure, so its breakdown
 *     must sum to it and equal the claim's not-applicable suffix (FIX 1);
 *   - the zero-candidate verdict detail states the same figure, so it reads the
 *     same weighted phrase instead of the recall-basis counts (FIX 2);
 *   - a verified unit whose receipt named no readable `seq` has no
 *     `measuredSegments` row, so it cannot inherit another verified unit's
 *     recorded compaction bound (FIX 3).
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
  citableClaim, notApplicableClaimLabel, notApplicableReasonCounts,
  notApplicableReasonPhrase, notApplicableUnitCount, removalChecks, verifiedSegmentBound,
} from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const UNIT_TEXT = 'TENTH-AUDIT-UNIT-TEXT';
const MIXED_UNIT_TEXT = 'TENTH-AUDIT-MIXED-UNUSED';
const RESTORE_ANSWER_CALL_ID = 'call_tenth_restore_answer';
const NEVER_SENT_CALL_IDS = ['call_tenth_never_a', 'call_tenth_never_b'];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-window-basis-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

function archivedText(value) {
  return JSON.stringify({ input: { path: 'big.txt' }, name: 'read', result: { type: 'text', value } });
}

/** One manifest and one archived blob per named call id. */
function buildLedger(dir, specs) {
  const blobRoot = join(dir, 'blobs');
  const ledger = { blobRoot, recallIds: [], recallManifests: [], recallParts: [], blobs: [] };
  const seenBlobs = new Set();
  const addBlob = (text) => {
    const hash = sha256(text);
    const blob = writeBlobFile(blobRoot, hash, text);
    if (!seenBlobs.has(hash)) {
      seenBlobs.add(hash);
      ledger.blobs.push({ sha256: hash, byteLength: blob.bytes });
    }
    return { hash, bytes: blob.bytes };
  };
  const recalls = specs.map((spec) => {
    const manifest = addBlob(`manifest-${spec.name}`);
    const recallId = `recall:sha256:${manifest.hash}`;
    ledger.recallIds.push(recallId);
    ledger.recallManifests.push({ recallId, manifestSha256: manifest.hash });
    let partIndex = 0;
    for (const callId of spec.callIds) {
      const part = addBlob(archivedText(spec.unitText));
      ledger.recallParts.push({
        recallId,
        partIndex,
        sourceNodeId: `oc:ses_tenth:tool:${callId}`,
        sourceSha256: part.hash,
        sourceByteLength: part.bytes,
        blobSha256: part.hash,
      });
      partIndex += 1;
    }
    return { recallId, callIds: [...spec.callIds] };
  });
  return { ledger, recalls };
}

function realRow(seq, messages, extra = {}) {
  return { seq, main_turn: seq - 1, messages, ...extra };
}

function assistantCall(callId, name = 'read', args = '{"path":"big.txt"}') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, function: { name, arguments: args } }],
  };
}

function toolResult(callId, content) {
  return { role: 'tool', tool_call_id: callId, content };
}

function receiptMessage(recallId, passId = 'i1') {
  return {
    role: 'user',
    content: receiptLineText('big.txt', recallId, '', '', passId),
  };
}

function necromancyCall(recallId) {
  return assistantCall(RESTORE_ANSWER_CALL_ID, 'necromancy', JSON.stringify({ id: recallId }));
}

/**
 * One measured recall beside one 3-part mixed recall: the mixed recall's parts
 * are the restore answer (a run-issued `necromancy` call whose result is
 * captured) and two calls that never reached a captured body.
 */
function measuredAndMixed3(dir) {
  const { ledger, recalls } = buildLedger(dir, [
    { name: 'measured', unitText: UNIT_TEXT, callIds: ['call_tenth_measured'] },
    {
      name: 'mixed3',
      unitText: MIXED_UNIT_TEXT,
      callIds: [RESTORE_ANSWER_CALL_ID, ...NEVER_SENT_CALL_IDS],
    },
  ]);
  const [measured, mixed] = recalls;
  const task = { role: 'user', content: 'tenth audit FIX 1 task' };
  const declaration = assistantCall('call_tenth_measured');
  const twin = [
    assistantCall('call_tenth_measured_twin'),
    toolResult('call_tenth_measured_twin', UNIT_TEXT),
  ];
  const receipt = receiptMessage(measured.recallId);
  const restore = necromancyCall(mixed.recallId);
  const restoreAnswer = toolResult(RESTORE_ANSWER_CALL_ID, 'RESTORED BYTES');
  const rows = [
    realRow(1, [task]),
    realRow(2, [task, declaration]),
    realRow(3, [task, declaration, toolResult('call_tenth_measured', UNIT_TEXT)]),
    // The restore call first appears after request 1, so this run issued it.
    realRow(4, [task, ...twin, restore, restoreAnswer, receipt],
      { receipt_recall_ids: [measured.recallId] }),
    realRow(5, [task, ...twin, restore, restoreAnswer, receipt],
      { receipt_recall_ids: [measured.recallId] }),
  ];
  return { ledger, rows, measured };
}

/** The mixed recall alone: no unit reached a captured removable result. */
function mixed3Only(dir) {
  const { ledger, recalls } = buildLedger(dir, [{
    name: 'mixed3',
    unitText: MIXED_UNIT_TEXT,
    callIds: [RESTORE_ANSWER_CALL_ID, ...NEVER_SENT_CALL_IDS],
  }]);
  const [mixed] = recalls;
  const task = { role: 'user', content: 'tenth audit FIX 2 task' };
  const restore = necromancyCall(mixed.recallId);
  const rows = [
    realRow(1, [task]),
    realRow(2, [task, restore]),
    realRow(3, [task, restore, toolResult(RESTORE_ANSWER_CALL_ID, 'RESTORED BYTES')]),
  ];
  return { ledger, rows };
}

function removalClaimInput(removal) {
  return {
    claimed: removal.claimed,
    realRoute: true,
    removalMeasured: removal.removalMeasured,
    removalMeasuredAny: removal.removalMeasuredAny,
    restoreNotExercised: removal.restoreNotExercised,
    restoreAttempted: removal.restoreAttempted,
    restoreProven: removal.restoreProven,
    restore: removal.restore,
    removalCounts: {
      candidates: removal.generic?.candidateCount ?? 0,
      verified: removal.generic?.verified ?? 0,
    },
    captureAvailable: true,
    arm: 'test',
    controlBound: true,
    mainRequests: [],
  };
}

/** The unit counts a reason phrase names, e.g. `2 never sent to the model`. */
function phraseTotal(phrase) {
  return [...phrase.matchAll(/(\d+)\s+[^,;)]+/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

/* --------------------------------------------------------------- FIX 1 */

test('tenth audit FIX 1: the window why sums to the unit figure and matches the claim suffix', () => {
  const dir = scratch();
  try {
    const { ledger, rows } = measuredAndMixed3(dir);
    const removal = removalChecks({
      arm: 'test', fixture: null, script: { replies: [] }, ledger, mains: rows,
      capture: true, source: 'http-request-hook',
    });
    assert.equal(removal.generic.candidateCount, 1, JSON.stringify(removal.generic.failures));
    assert.equal(removal.generic.verified, 1, JSON.stringify(removal.generic.failures));

    const notApplicable = removal.notApplicable;
    assert.equal(notApplicable.length, 1, JSON.stringify(notApplicable));
    assert.deepEqual(notApplicable[0].callIds,
      [RESTORE_ANSWER_CALL_ID, ...NEVER_SENT_CALL_IDS]);
    assert.deepEqual(notApplicable[0].partReasons, [
      { callId: RESTORE_ANSWER_CALL_ID, reason: 'restore-answer-excluded' },
      { callId: NEVER_SENT_CALL_IDS[0], reason: 'never-sent-to-model' },
      { callId: NEVER_SENT_CALL_IDS[1], reason: 'never-sent-to-model' },
    ]);
    const figure = notApplicableUnitCount(notApplicable);
    assert.deepEqual(figure, { count: 3, basis: 'call-ids' });

    const why = removal.removalWindow.why;
    assert.equal(why,
      'the measured removal window holds 1 verified of 1 candidate recall(s); 3 unit(s) are '
        + 'not-applicable: 2 never sent to the model, 1 restore answer excluded from the removal '
        + 'scan');
    const whyPhrase = /are not-applicable: (.+)$/u.exec(why)?.[1] ?? '';
    assert.equal(phraseTotal(whyPhrase), figure.count,
      `the why's reason counts sum to its unit figure: ${why}`);
    assert.doesNotMatch(why, /1 never sent/u,
      'the recall basis undercounted the two never-sent parts');

    const labelled = notApplicableClaimLabel(citableClaim(removalClaimInput(removal)), removal);
    const claimPhrase = /not-applicable: (.+)\)$/u.exec(labelled)?.[1] ?? '';
    assert.match(labelled, /\(3 unit\(s\) not-applicable: /u, labelled);
    assert.equal(whyPhrase, claimPhrase,
      'the window why and the claim suffix state the same breakdown');
    assert.equal(phraseTotal(claimPhrase), figure.count, labelled);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- FIX 2 */

test('tenth audit FIX 2: the zero-candidate detail states the unit basis, not the recall basis', () => {
  const dir = scratch();
  try {
    const { ledger, rows } = mixed3Only(dir);
    const removal = removalChecks({
      arm: 'test', fixture: null, script: { replies: [] }, ledger, mains: rows,
      capture: true, source: 'http-request-hook',
    });
    assert.equal(removal.claimed, false);
    assert.equal(removal.generic.candidateCount, 0,
      JSON.stringify(removal.generic.failures));
    const figure = notApplicableUnitCount(removal.notApplicable);
    assert.deepEqual(figure, { count: 3, basis: 'call-ids' });

    const detail = removal.generic.detail;
    assert.ok(detail.endsWith(
      '; 3 unit(s) are recorded not-applicable (2 never sent to the model, 1 restore answer '
        + 'excluded from the removal scan) and are not counted as measured removals'), detail);
    assert.doesNotMatch(detail, /1 recall\(s\) name a tool part/u,
      'the row count and the recall-basis breakdown are gone');
    assert.doesNotMatch(detail, /1 never sent to the model/u, detail);

    const detailPhrase = /not-applicable \((.+)\) and are not counted/u.exec(detail)?.[1] ?? '';
    assert.equal(phraseTotal(detailPhrase), figure.count,
      `the detail's reason counts sum to its unit figure: ${detail}`);
    assert.equal(detailPhrase,
      notApplicableReasonPhrase(
        notApplicableReasonCounts(removal.notApplicable, figure.basis), 'claim'),
      'the detail states the phrase the claim suffix uses');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- FIX 3 */

test('tenth audit FIX 3: a verified unit with no segment row does not inherit a bound', () => {
  const candidates = [
    { unitCallId: 'call_tenth_bounded', pass: true },
    // A receipt whose `seq` is null gives this verified unit no
    // `measuredSegments` row at all (`realRouteRemovalVerdict`).
    { unitCallId: 'call_tenth_null_receipt', pass: true, measuredSegments: [] },
  ];
  assert.equal(verifiedSegmentBound(
    [{ unitCallId: 'call_tenth_bounded', compactionAtSeq: 6 }], candidates), false,
  'the bounded unit cannot speak for the unit whose segment was never recorded');
  assert.equal(verifiedSegmentBound([
    { unitCallId: 'call_tenth_bounded', compactionAtSeq: 6 },
    { unitCallId: 'call_tenth_null_receipt', compactionAtSeq: 6 },
  ], candidates), true, 'both verified units end at a recorded compaction');
  assert.equal(verifiedSegmentBound([
    { unitCallId: 'call_tenth_bounded', compactionAtSeq: 6 },
    { unitCallId: 'call_tenth_null_receipt', compactionAtSeq: null },
  ], candidates), false, 'an open verified segment keeps the sentence unbounded');
});
