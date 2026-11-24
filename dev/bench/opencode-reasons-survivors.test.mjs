#!/usr/bin/env node
/**
 * Ninth audit: the not-applicable reason per unit, the survivor sentence per
 * unit, and the receipt exemption in content stability.
 *
 * Three defects, one file:
 *
 *   - FIX 1: a mixed recall (one restore-answer part beside one never-sent
 *     part) kept its strongest reason on the flattened `notApplicable` row, so
 *     `notApplicableReasonCounts` weighted every call id to
 *     `restore-answer-excluded` and the claim, the window `why`, the class
 *     sentence and the verdict detail said
 *     "(2 unit(s) not-applicable: restore answer excluded from the removal
 *     scan)" although one call id was `never-sent-to-model`;
 *   - FIX 2: the survivor sentence counted candidate recalls, and a candidate
 *     is `same-path` only when **every** unit survives, so a two-unit recall
 *     with one surviving unit and one control said "no same-path survivor" —
 *     false for the surviving unit;
 *   - FIX 3: `requestContentStability` exempted any message
 *     `isReceiptMessage` accepts, so a tool result whose whole content quotes a
 *     receipt line could vanish between requests and the pair still passed.
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
  notApplicableClaimLabel,
  notApplicableReasonCounts,
  notApplicableUnitCount,
  realRouteRemovalVerdict,
  removalChecks,
  removalClassLabel,
  requestContentStability,
} from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const SHA256_HEX = 'a'.repeat(64);
const RESTORE_RECALL_ID = `recall:sha256:${SHA256_HEX}`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-reasons-'));
}

/** Write one content-addressed blob the way the adapter's store does. */
function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * One recall whose `recall_parts` name the given call ids, each with its own
 * archived `{name,input,result}` envelope and blob file.
 */
function recallLedger(dir, units) {
  const blobRoot = join(dir, 'blobs');
  const manifestText = 'ninth-audit-mixed-manifest';
  const manifestHash = sha256(manifestText);
  const manifest = writeBlobFile(blobRoot, manifestHash, manifestText);
  const recallId = `recall:sha256:${manifestHash}`;
  const ledger = {
    blobRoot,
    recallIds: [recallId],
    recallManifests: [{ recallId, manifestSha256: manifestHash }],
    recallParts: [],
    blobs: [{ sha256: manifestHash, byteLength: manifest.bytes }],
  };
  for (const [index, unit] of units.entries()) {
    const archived = JSON.stringify({
      input: unit.input ?? { path: unit.path ?? 'big.txt' },
      name: unit.name ?? 'read',
      result: { type: 'text', value: unit.text },
    });
    const hash = sha256(archived);
    const blob = writeBlobFile(blobRoot, hash, archived);
    ledger.recallParts.push({
      recallId,
      partIndex: index,
      sourceNodeId: `oc:ses_ninth:tool:${unit.callId}`,
      sourceSha256: hash,
      sourceByteLength: blob.bytes,
      blobSha256: hash,
    });
    ledger.blobs.push({ sha256: hash, byteLength: blob.bytes });
  }
  return { ledger, recallId };
}

function realRow(seq, messages, extra = {}) {
  return { seq, main_turn: seq - 1, messages, ...extra };
}

function assistantCall(callId, name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, function: { name, arguments: args } }],
  };
}

function toolResult(callId, content) {
  return { role: 'tool', tool_call_id: callId, content };
}

/* ---------------------------------------------------- FIX 1: reasons per unit */

test('ninth audit FIX 1: a mixed recall names both part reasons in the claim, window and class sentence', () => {
  const dir = scratch();
  try {
    const restoreCallId = 'call_restore_ninth';
    const neverCallId = 'call_never_ninth';
    const { ledger, recallId } = recallLedger(dir, [
      {
        callId: restoreCallId,
        name: 'necromancy',
        input: { id: RESTORE_RECALL_ID },
        text: 'RESTORED-BYTES ninth audit',
      },
      { callId: neverCallId, path: 'never-ninth.txt', text: 'NEVER-SENT-BYTES ninth audit' },
    ]);
    // The run-issued necromancy call answers with the restored bytes; the other
    // part is never declared or sent in this capture.
    const task = { role: 'user', content: 'ninth audit FIX 1 task' };
    const restoreCall = assistantCall(restoreCallId, 'necromancy',
      JSON.stringify({ id: recallId }));
    const rows = [
      realRow(1, [task]),
      realRow(2, [task, restoreCall]),
      realRow(3, [task, restoreCall,
        toolResult(restoreCallId, 'RESTORED-BYTES ninth audit')]),
    ];
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.candidateCount, 0);
    assert.equal(verdict.notApplicable.length, 1, JSON.stringify(verdict.notApplicable));
    const mixed = verdict.notApplicable[0];
    assert.deepEqual(mixed.callIds, [restoreCallId, neverCallId]);
    assert.equal(mixed.reason, 'restore-answer-excluded',
      'the row keeps the strongest reason for a one-reason reader');
    assert.deepEqual(mixed.partReasons.map((part) => part.reason),
      ['restore-answer-excluded', 'never-sent-to-model']);
    assert.deepEqual(notApplicableReasonCounts(verdict.notApplicable, 'call-ids'),
      { 'restore-answer-excluded': 1, 'never-sent-to-model': 1 },
      'the call-id breakdown reads each part, never the row first');
    assert.match(verdict.detail,
      /1 never sent to the model, 1 restore answer excluded from the removal scan/u);
    assert.doesNotMatch(verdict.detail, /2 restore answer excluded/u);

    /**
     * The run-level flattening must keep `partReasons`. A copy that drops the
     * field makes the counter fall back to the row's strongest reason and the
     * false phrase returns in the claim, the window and the class sentence.
     */
    const checks = removalChecks({
      arm: 'test', fixture: null, script: { replies: [] }, ledger, mains: rows,
      capture: true, seededRecallIds: [], source: 'http-request-hook',
    });
    assert.equal(checks.notApplicable.length, 1);
    assert.deepEqual(checks.notApplicable[0].partReasons.map((part) => part.reason),
      ['restore-answer-excluded', 'never-sent-to-model'],
      'the flattened row carries partReasons');
    const figure = notApplicableUnitCount(checks.notApplicable);
    assert.deepEqual(figure, { count: 2, basis: 'call-ids' });
    assert.equal(notApplicableClaimLabel('removal', checks),
      'removal (2 unit(s) not-applicable: 1 never sent to the model, '
        + '1 restore answer excluded from the removal scan)');
    assert.match(checks.removalWindow.why,
      /1 never sent to the model, 1 restore answer excluded from the removal scan/u);
    const classSentence = removalClassLabel({
      realRoute: true,
      claimed: false,
      measuredUnits: 0,
      candidateUnits: 0,
      notApplicableCount: checks.notApplicable.length,
      notApplicableUnits: figure.count,
      notApplicableReasons: notApplicableReasonCounts(checks.notApplicable, figure.basis),
    });
    assert.match(classSentence,
      /2 unit\(s\) are outside the claim \(1 never sent to the model, 1 restore answer excluded from the removal scan\)/u);
    assert.doesNotMatch(classSentence, /2 unit\(s\) are outside the claim \(restore answer excluded/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------ FIX 2: survivors counted per unit */

test('ninth audit FIX 2: a two-unit recall with one survivor and one control names the unit facts', () => {
  const dir = scratch();
  try {
    const callA = 'call_ninth_a';
    const callB = 'call_ninth_b';
    const callControl = 'call_ninth_control';
    const callTwinA = 'call_ninth_twin_a';
    const textA = 'NINTH-A-BYTES the surviving unit';
    const textB = 'NINTH-B-BYTES the unit without a same-path read';
    const { ledger, recallId } = recallLedger(dir, [
      { callId: callA, path: 'ninth-a.txt', text: textA },
      { callId: callB, path: 'ninth-b.txt', text: textB },
    ]);
    const task = { role: 'user', content: 'ninth audit FIX 2 task' };
    const declA = assistantCall(callA, 'read', JSON.stringify({ path: 'ninth-a.txt' }));
    const declB = assistantCall(callB, 'read', JSON.stringify({ path: 'ninth-b.txt' }));
    const declControl = assistantCall(callControl, 'read',
      JSON.stringify({ path: 'ninth-control.txt' }));
    const declTwinA = assistantCall(callTwinA, 'read', JSON.stringify({ path: 'ninth-a.txt' }));
    const receipt = {
      role: 'user',
      content: receiptLineText('ninth-a.txt', recallId, '', '', 'i1'),
    };
    // Unit A has a same-path re-read from request 4 onward. Unit B has none;
    // a non-removed read result is present in every post-receipt body, so its
    // same-tool control holds.
    const rows = [
      realRow(1, [task]),
      realRow(2, [task, declA, declB, declControl]),
      realRow(3, [task, declA, declB, declControl,
        toolResult(callA, textA), toolResult(callB, textB),
        toolResult(callControl, 'NINTH-CONTROL-BYTES')]),
      realRow(4, [task, declTwinA, toolResult(callTwinA, textA),
        toolResult(callControl, 'NINTH-CONTROL-BYTES'), receipt],
      { receipt_recall_ids: [recallId] }),
      realRow(5, [task, declTwinA, toolResult(callTwinA, textA),
        toolResult(callControl, 'NINTH-CONTROL-BYTES'), receipt],
      { receipt_recall_ids: [recallId] }),
    ];
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 1);
    const candidate = verdict.candidates[0];
    assert.equal(candidate.survivor, 'none',
      'the candidate-level rollup is same-path only when every unit survives');
    assert.deepEqual(candidate.units.map((unit) => unit.survivor), ['same-path', 'none']);
    assert.equal(candidate.checks.sameToolControl, true);
    assert.match(candidate.survivorNote,
      /^1 of 2 unit\(s\) had a same-path survivor recorded from its landing request onward as a fact/u);
    assert.match(candidate.survivorNote,
      /at least one unit has no same-path survivor and the same-tool control is present in every post-receipt body/u);
    assert.match(verdict.detail,
      /1 of 2 unit\(s\) had a same-path survivor present from its landing request onward; at least one unit has no same-path survivor and the same-tool control is present in every post-receipt body, so only a host that drops the exact recall-named result/u);
    assert.doesNotMatch(verdict.detail, /no same-path survivor; same-tool control present/u,
      'the sentence never says the recall has no survivor when one unit has one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------- FIX 3: only an adapter receipt is exempt */

test('ninth audit FIX 3: a tool result quoting a receipt line still fails content stability', () => {
  const quotedReceipt = `[not retained] big.txt · necromancy ${RESTORE_RECALL_ID}`;
  const task = { role: 'user', content: 'ninth audit FIX 3 task' };
  const rows = [
    { seq: 1, messages: [task, { role: 'tool', tool_call_id: 'call_quoted_ninth',
      content: quotedReceipt }] },
    { seq: 2, messages: [task] },
  ];
  // The recall names the dropped call id and the quoting result is the only
  // receipt-shaped message. Under the old predicate that tool result dated the
  // recall's receipt, so the disappearance was exempted; the quoting result is
  // not the adapter's record, so the pair must fail.
  const verdict = requestContentStability(rows, {
    recalls: [{ recallId: RESTORE_RECALL_ID, callId: 'call_quoted_ninth' }],
  });
  assert.equal(verdict.pass, false, verdict.detail);
  assert.deepEqual(verdict.perPair[0].droppedResults.map((row) => row.callId),
    ['call_quoted_ninth']);
  assert.deepEqual(verdict.perPair[0].exemptedResults, []);
  assert.match(verdict.detail, /call_quoted_ninth/u);
});

test('ninth audit FIX 3: a disappearing adapter receipt is still exempt', () => {
  const task = { role: 'user', content: 'ninth audit FIX 3 receipt task' };
  // The host's serialized wire shape: a user message whose whole text is the
  // adapter's receipt line.
  const wireReceipt = {
    role: 'user',
    content: receiptLineText('big.txt', RESTORE_RECALL_ID, '', '', 'i1'),
  };
  assert.equal(requestContentStability([
    { seq: 1, messages: [task, wireReceipt] },
    { seq: 2, messages: [task] },
  ]).pass, true);
  // The adapter's marker survives on a hand-built row; the marker alone is
  // enough, and the receipt is a record, not content.
  const markedReceipt = {
    role: 'user',
    content: 'record body that is not a receipt line',
    racoonsRecordId: 'racoons-record:i1:0',
  };
  assert.equal(requestContentStability([
    { seq: 1, messages: [task, markedReceipt] },
    { seq: 2, messages: [task] },
  ]).pass, true);
});
