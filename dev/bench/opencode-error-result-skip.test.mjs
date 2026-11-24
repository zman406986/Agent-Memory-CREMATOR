#!/usr/bin/env node
/**
 * A failure envelope is not a removal claim (1f diagnosis FIX 2, replay side).
 *
 * The fixed product never removes an `error`-tagged result or a cancelled
 * `question`; a pre-fix ledger (the 1f capture) still names one. The removal
 * verdict reads the archived tag, records such a recall `not-applicable` with
 * `error-result-retained`, and keeps it out of the measured set — so a replay
 * reports what the fixed product would do instead of failing a removal it would
 * never make. The tag is read from the stored blob, so the sorted-key archive a
 * pre-fix run wrote is classified the same way as a post-fix one.
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
  isArchivedErrorEnvelope, realRouteArchivedResultTag, realRouteRemovalVerdict,
} from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const UNIT_CALL_ID = 'call_00_error_envelope';
const CONTROL_CALL_ID = 'call_00_question_control';
const UNIT_TEXT = `ERROR-ENVELOPE ${'e'.repeat(900)}`;
const NORMAL_TEXT = `NORMAL-ANSWER ${'n'.repeat(900)}`;
const CONTROL_TEXT = `ANSWERED ${'c'.repeat(400)}`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-error-skip-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * One recall whose archived result is the one this test hands it. The archive
 * is written with **sorted** keys on purpose: a pre-fix blob, and the tag must
 * still be read.
 */
function oneRecallLedger(dir, archivedResult) {
  const blobRoot = join(dir, 'blobs');
  const archived = JSON.stringify({
    input: { questions: [{ question: 'Bounded audit?' }] },
    name: 'question',
    result: archivedResult,
  });
  const partHash = sha256(archived);
  const part = writeBlobFile(blobRoot, partHash, archived);
  const manifestText = 'error-skip-manifest';
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
        sourceNodeId: `oc:ses_error_skip:tool:${UNIT_CALL_ID}`,
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

function receiptMessage(recallId) {
  return { role: 'user', content: receiptLineText('Q.md', recallId, '', '', 'i1') };
}

/** The timeline: the unit is declared, its result lands, then a receipt. */
function rowsFor(recallId, beforeText) {
  const task = { role: 'user', content: 'error envelope task' };
  const decl = assistantCall(UNIT_CALL_ID);
  // A second `question` result present in every post-receipt body, so the
  // control case is an ordinary candidate and this test measures only the
  // error-envelope rule (not the once-called-tool skip of FIX 3).
  const declControl = assistantCall(CONTROL_CALL_ID);
  const control = toolResult(CONTROL_CALL_ID, CONTROL_TEXT);
  const receipt = receiptMessage(recallId);
  return [
    realRow(1, [task]),
    realRow(2, [task, decl, declControl]),
    realRow(3, [task, decl, declControl, toolResult(UNIT_CALL_ID, beforeText), control]),
    realRow(4, [task, declControl, control, receipt], { receipt_recall_ids: [recallId] }),
    realRow(5, [task, declControl, control, receipt], { receipt_recall_ids: [recallId] }),
  ];
}

test('1f FIX 2 replay: the archived error tag is read, and a json-tagged cancelled question too',
  () => {
    const dir = scratch();
    try {
      const errorValue = {
        error: { type: 'tool.execution', message: 'This non-interactive run cannot ask…' },
        content: [],
      };
      const cancelled = oneRecallLedger(dir, { type: 'error', value: errorValue });
      const tag = realRouteArchivedResultTag(cancelled.ledger, UNIT_CALL_ID);
      assert.equal(tag?.tag, 'error', 'the error tag is read from the sorted blob');
      assert.equal(tag?.name, 'question', 'the tool name is read from the archive');
      assert.equal(isArchivedErrorEnvelope(tag), true, 'the error tag is an error envelope');
      const jsonCancelled = {
        tag: 'json', name: 'question',
        value: { error: { type: 'tool.execution', message: 'cancelled' }, content: [] },
      };
      assert.equal(isArchivedErrorEnvelope(jsonCancelled), true,
        'a cancelled question tagged json is an error envelope');
      assert.equal(isArchivedErrorEnvelope({
        tag: 'json', name: 'question', value: { answers: [{ answer: 'Bounded' }] },
      }), false, 'a real answer is not');
      assert.equal(isArchivedErrorEnvelope({
        tag: 'text', name: 'read', value: 'bytes',
      }), false, 'a normal result is not');
      assert.equal(isArchivedErrorEnvelope(null), false, 'an unreadable archive is not classified');
      assert.equal(realRouteArchivedResultTag(cancelled.ledger, 'call_absent'), null,
        'a call the ledger does not name is not classified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('1f FIX 2 replay: an archived error unit is not-applicable, a normal unit is a candidate',
  () => {
    const dir = scratch();
    try {
      const errorValue = {
        error: { type: 'tool.execution', message: 'This non-interactive run cannot ask…' },
        content: [],
      };
      const errorWorld = oneRecallLedger(dir, { type: 'error', value: errorValue });
      const errorVerdict = realRouteRemovalVerdict({
        ledger: errorWorld.ledger,
        mains: rowsFor(errorWorld.recallId, JSON.stringify(errorValue)),
      });
      const skip = errorVerdict.notApplicable.find(
        (row) => row.recallId === errorWorld.recallId);
      assert.ok(skip, JSON.stringify(errorVerdict.notApplicable));
      assert.equal(skip.reason, 'error-result-retained', 'the skip carries its named reason');
      assert.deepEqual(skip.callIds, [UNIT_CALL_ID], 'the skip names the error unit');
      assert.match(skip.why, /never removes a failure/u, 'the reason states the product rule');
      assert.equal(errorVerdict.candidates.length, 0, 'the recall is not a candidate');
      assert.equal(errorVerdict.verified, 0, 'it is never a measured removal');
      assert.deepEqual(errorVerdict.failures, [], 'it is not a red failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const controlDir = scratch();
    try {
      // Control: the same timeline and recall shape with a normal text result is
      // an ordinary candidate, so the skip above is the envelope's doing.
      const normal = oneRecallLedger(controlDir, { type: 'text', value: NORMAL_TEXT });
      const verdict = realRouteRemovalVerdict({
        ledger: normal.ledger,
        mains: rowsFor(normal.recallId, NORMAL_TEXT),
      });
      assert.equal(verdict.candidates.length, 1, 'the normal unit stays a candidate');
      assert.equal(verdict.verified, 1, JSON.stringify(verdict.failures));
      assert.deepEqual(verdict.notApplicable, [], 'nothing was skipped');
      assert.equal(verdict.candidates[0].checks.archive, true, 'the archive matched');
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
