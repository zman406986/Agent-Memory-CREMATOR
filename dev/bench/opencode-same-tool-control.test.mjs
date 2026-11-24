#!/usr/bin/env node
/**
 * A once-called tool has no same-tool control, and that is a named skip
 * (1f diagnosis FIX 3).
 *
 * The removal verdict's no-survivor branch requires one non-removed result of
 * the unit's own tool in every post-receipt body, so a host that drops a whole
 * tool family cannot pass as a removal. The 1f capture showed the control has no
 * subject when the tool was called exactly once: the unit's own call is the only
 * result that tool ever produced. The verdict recorded that as a red failure and
 * failed 3 assertions on a removal the decoder-level absence check had already
 * proven.
 *
 * The rule now: when every measurable unit of a recall has a tool declared
 * exactly once and that call is the unit, and no other check is unproven, the
 * recall is `not-applicable` with `same-tool-control-unavailable` — disclosed
 * beside the other skips, never passed. A tool with another non-removed result
 * still owes the control, and a host that drops it still fails.
 *
 * Offline only: no host binary, no key, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { realRouteRemovalVerdict } from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const UNIT_CALL_ID = 'call_question_once';
const CONTROL_CALL_ID = 'call_question_control';
/** The unit's result text: the bytes the claim proves absent. */
const UNIT_TEXT = `ANSWERED ${'q'.repeat(900)}`;
/** A second question result, unrelated to the unit's bytes. */
const CONTROL_TEXT = `CONTROL ${'c'.repeat(400)}`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-same-tool-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** One recall whose archived unit is the question call's normal answer. */
function oneRecallLedger(dir) {
  const blobRoot = join(dir, 'blobs');
  const archived = JSON.stringify({
    input: { questions: [{ question: 'Bounded audit or multi-session audit?' }] },
    name: 'question',
    result: { type: 'text', value: UNIT_TEXT },
  });
  const partHash = sha256(archived);
  const part = writeBlobFile(blobRoot, partHash, archived);
  const manifestText = 'same-tool-control-manifest';
  const manifestHash = sha256(manifestText);
  const manifest = writeBlobFile(blobRoot, manifestHash, manifestText);
  const recallId = `recall:sha256:${manifestHash}`;
  return {
    recallId,
    ledger: {
      blobRoot,
      recallIds: [recallId],
      recallManifests: [{ recallId, manifestSha256: manifestHash }],
      recallParts: [{
        recallId,
        partIndex: 0,
        sourceNodeId: `oc:ses_same_tool:tool:${UNIT_CALL_ID}`,
        sourceSha256: partHash,
        sourceByteLength: part.bytes,
        blobSha256: partHash,
      }],
      blobs: [
        { sha256: manifestHash, byteLength: manifest.bytes },
        { sha256: partHash, byteLength: part.bytes },
      ],
    },
  };
}

function realRow(seq, messages) {
  return { seq, main_turn: seq - 1, messages };
}

function assistantCall(callId) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: callId,
      function: {
        name: 'question',
        arguments: JSON.stringify({ questions: [{ question: 'Bounded audit?' }] }),
      },
    }],
  };
}

function toolResult(callId, content) {
  return { role: 'tool', tool_call_id: callId, content };
}

/** The adapter's receipt line on the user wire, with no marker fields. */
function receiptMessage(recallId) {
  return { role: 'user', content: receiptLineText('Q.md', recallId, '', '', 'i1') };
}

/**
 * The timeline: the unit is declared and its result lands, then the receipt
 * request and one later request. `secondResult` decides whether the same tool
 * has another non-removed result and where it survives:
 *   - `'every-body'`: present before and in every post-receipt body;
 *   - `'before-only'`: present before the receipt, absent after it;
 *   - `null`: the tool is called exactly once.
 */
function rowsFor({ recallId, secondResult = null }) {
  const task = { role: 'user', content: 'same-tool control task' };
  const declUnit = assistantCall(UNIT_CALL_ID);
  const declControl = secondResult === null ? null : assistantCall(CONTROL_CALL_ID);
  const controlBefore = secondResult === null ? [] : [toolResult(CONTROL_CALL_ID, CONTROL_TEXT)];
  const controlAfter = secondResult === 'every-body'
    ? [toolResult(CONTROL_CALL_ID, CONTROL_TEXT)] : [];
  const receipt = receiptMessage(recallId);
  return [
    realRow(1, [task]),
    realRow(2, [task, declUnit, ...(declControl === null ? [] : [declControl])]),
    realRow(3, [task, declUnit, ...(declControl === null ? [] : [declControl]),
      toolResult(UNIT_CALL_ID, UNIT_TEXT), ...controlBefore]),
    realRow(4, [task, ...(declControl === null ? [] : [declControl]), ...controlAfter,
      receipt], { receipt_recall_ids: [recallId] }),
    realRow(5, [task, ...(declControl === null ? [] : [declControl]), ...controlAfter,
      receipt], { receipt_recall_ids: [recallId] }),
  ];
}

test('1f FIX 3: a once-called tool unit is not-applicable, not a red failure', () => {
  const dir = scratch();
  try {
    const { ledger, recallId } = oneRecallLedger(dir);
    const verdict = realRouteRemovalVerdict({ ledger, mains: rowsFor({ recallId }) });
    const skip = verdict.notApplicable.find((row) => row.recallId === recallId);
    assert.ok(skip, JSON.stringify({ failures: verdict.failures, notApplicable: verdict.notApplicable }));
    assert.equal(skip.reason, 'same-tool-control-unavailable',
      'the skip carries its named reason');
    assert.deepEqual(skip.callIds, [UNIT_CALL_ID], 'the skip names the once-called unit');
    assert.match(skip.why, /declared exactly once/u, 'the reason says why the control is absent');
    assert.match(skip.why, /question/u, 'the reason names the tool');
    assert.equal(verdict.candidates.length, 0, 'the recall is not a candidate');
    assert.equal(verdict.verified, 0, 'a skipped unit is never a measured removal');
    assert.equal(verdict.pass, false, 'the run did not pass a claim it could not control');
    assert.deepEqual(verdict.failures, [], 'the skip is not a red failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1f FIX 3: a tool with another non-removed result still requires the control', () => {
  const dir = scratch();
  try {
    const { ledger, recallId } = oneRecallLedger(dir);
    const verdict = realRouteRemovalVerdict({
      ledger, mains: rowsFor({ recallId, secondResult: 'every-body' }),
    });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 1, 'the unit verified with its control present');
    const candidate = verdict.candidates.find((row) => row.recallId === recallId);
    assert.ok(candidate, 'the recall is a candidate');
    assert.equal(candidate.checks.sameToolControl, true, 'the control held in every body');
    assert.equal(candidate.sameToolControl.toolCalledOnce, false,
      'the tool was declared twice, so the unit is not the once-called case');
    assert.equal(candidate.sameToolControl.toolDeclarations, 2,
      'both declarations are counted');
    assert.equal(candidate.sameToolControl.presentInEveryPostReceiptBody, true,
      'the control is recorded per unit');
    assert.deepEqual(verdict.notApplicable, [], 'nothing was skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1f FIX 3: a tool called twice still fails when its other result is not in every body', () => {
  const dir = scratch();
  try {
    const { ledger, recallId } = oneRecallLedger(dir);
    // The second result never reaches a post-receipt body: the control this
    // two-call tool still owes is missing, so the ordinary failure stays.
    const verdict = realRouteRemovalVerdict({
      ledger, mains: rowsFor({ recallId, secondResult: 'before-only' }),
    });
    assert.equal(verdict.candidates.length, 1, 'the recall stays a candidate');
    const candidate = verdict.candidates[0];
    assert.equal(candidate.pass, false, 'the removal is not proven');
    assert.equal(candidate.checks.sameToolControl, false, 'the control sub-check failed');
    assert.equal(candidate.sameToolControl.toolCalledOnce, false,
      'a tool called twice is never the once-called skip');
    assert.match(candidate.problems.join('; '), /no same-tool control/u,
      'the failure is named, with the missing requests');
    assert.match(candidate.problems.join('; '), /question/u, 'the failure names the tool');
    assert.equal(verdict.notApplicable.some((row) => row.recallId === recallId), false,
      'the recall was not downgraded to a skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
