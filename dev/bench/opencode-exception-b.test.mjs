#!/usr/bin/env node
/**
 * Exception (b) names a container whose own check verified its removal
 * (seventh audit).
 *
 * The real-route absence scan used to excuse any result whose call id belonged
 * to **any** ledger recall: the excuse was built from every recall the ledger
 * names, so a result owned by a recall the verdict recorded not-applicable (a
 * compaction hid its before-body) or failed (no receipt named its removal)
 * still excused a candidate whose exact text it carried, and the claim then said
 * that text was absent while a live removed result held it.
 *
 * `removalClassLabel` states the rule the code enforces: a container's own
 * check must have verified its removal. These tests pin both directions:
 *
 *   - a not-applicable container does **not** excuse the candidate: the
 *     candidate is recorded `re-exposed-under-later-result`, the claim names it
 *     outside the claim and never says the text is absent;
 *   - a failed container does not excuse it either;
 *   - a verified container does excuse it: the candidate verifies, and the
 *     class sentence names exception (b) with the verified wording;
 *   - a verified container whose result does not hold the candidate's text
 *     changes nothing (the control).
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
  notApplicableReasonCounts, notApplicableUnitCount, realRouteRemovalVerdict, removalClassLabel,
} from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const CANDIDATE_CALL_ID = 'call_exc_b_candidate';
const CONTAINER_CALL_ID = 'call_exc_b_container';
const TWIN_CALL_ID = 'call_exc_b_twin';
const CONTROL_CALL_ID = 'call_exc_b_control';
/** The candidate's exact result text: the bytes the claim must prove absent. */
const CANDIDATE_TEXT = `EXC-B-CANDIDATE ${'c'.repeat(900)}`;
/** The container's result holds the candidate's text verbatim. */
const CONTAINER_TEXT = `EXC-B-CONTAINER-HEAD\n${CANDIDATE_TEXT}\nEXC-B-CONTAINER-TAIL`;
/** The control container's result shares no bytes with the candidate. */
const CONTAINER_ONLY_TEXT = `EXC-B-CONTAINER-ONLY ${'v'.repeat(900)}`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-exc-b-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Two real-route recalls, one per unit: the candidate and the container. Each
 * has its own manifest and its own archived result, so the archive check can
 * name either unit's bytes.
 */
function twoRecallLedger(dir, { containerText = CONTAINER_TEXT } = {}) {
  const blobRoot = join(dir, 'blobs');
  const ledger = {
    blobRoot, recallIds: [], recallManifests: [], recallParts: [], blobs: [],
  };
  const units = [
    { callId: CANDIDATE_CALL_ID, path: 'a.txt', text: CANDIDATE_TEXT },
    { callId: CONTAINER_CALL_ID, path: 'v.txt', text: containerText },
  ];
  const recalls = [];
  for (const [index, unit] of units.entries()) {
    const archived = JSON.stringify({
      input: { path: unit.path },
      name: 'read',
      result: { type: 'text', value: unit.text },
    });
    const partHash = sha256(archived);
    const part = writeBlobFile(blobRoot, partHash, archived);
    const manifestText = `exc-b-manifest-${String(index)}`;
    const manifestHash = sha256(manifestText);
    const manifest = writeBlobFile(blobRoot, manifestHash, manifestText);
    const recallId = `recall:sha256:${manifestHash}`;
    ledger.recallIds.push(recallId);
    ledger.recallManifests.push({ recallId, manifestSha256: manifestHash });
    ledger.recallParts.push({
      recallId,
      partIndex: 0,
      sourceNodeId: `oc:ses_exc_b:tool:${unit.callId}`,
      sourceSha256: partHash,
      sourceByteLength: part.bytes,
      blobSha256: partHash,
    });
    ledger.blobs.push({ sha256: manifestHash, byteLength: manifest.bytes });
    ledger.blobs.push({ sha256: partHash, byteLength: part.bytes });
    recalls.push({ callId: unit.callId, recallId, text: unit.text, path: unit.path });
  }
  const [candidate, container] = recalls;
  return { ledger, candidate, container };
}

function realRow(seq, messages, extra = {}) {
  return { seq, main_turn: seq - 1, messages, ...extra };
}

/**
 * One ledger recall only, for the control-after-boundary case: the container
 * recall would otherwise become a candidate without a receipt.
 */
function oneRecallLedger(dir) {
  const { ledger, candidate } = twoRecallLedger(dir);
  const keep = candidate.recallId;
  return {
    ledger: {
      ...ledger,
      recallIds: ledger.recallIds.filter((id) => id === keep),
      recallManifests: ledger.recallManifests.filter((row) => row.recallId === keep),
      recallParts: ledger.recallParts.filter((row) => row.recallId === keep),
    },
    candidate,
  };
}

function assistantCall(callId, path) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, function: { name: 'read', arguments: JSON.stringify({ path }) } }],
  };
}

function toolResult(callId, content) {
  return { role: 'tool', tool_call_id: callId, content };
}

/** The adapter's receipt line on the user wire, with no marker fields. */
function receiptMessage(recallId) {
  return { role: 'user', content: receiptLineText('exc-b.txt', recallId, '', '', 'i1') };
}

/**
 * The timeline every case shares.
 *
 *   request 2/3: the candidate is declared and its result lands (the before-body)
 *   request 4:   the candidate's receipt; the container's declaration and
 *                result; a same-path twin of the candidate, so the candidate
 *                has a survivor; a non-removed read as the same-tool control
 *   request 5:   the candidate's receipt; the twin and the control survive; the
 *                container's result again when `containerLaterResult`
 *   request 6:   the candidate's receipt, plus the container's receipt when
 *                `containerReceipt` (a failed container gets none)
 */
function rowsFor({ candidateRecallId, containerRecallId, containerReceipt = true,
  containerLaterResult = false, containerCapturedText = CONTAINER_TEXT,
  compaction = false } = {}) {
  const task = { role: 'user', content: 'exception (b) task' };
  const declCandidate = assistantCall(CANDIDATE_CALL_ID, 'a.txt');
  const declContainer = assistantCall(CONTAINER_CALL_ID, 'v.txt');
  const declTwin = assistantCall(TWIN_CALL_ID, 'a.txt');
  const declControl = assistantCall(CONTROL_CALL_ID, 'c.txt');
  const receiptCandidate = receiptMessage(candidateRecallId);
  const receiptContainer = receiptMessage(containerRecallId);
  const rows = [
    realRow(1, [task]),
    realRow(2, [task, declCandidate, declControl]),
    realRow(3, [task, declCandidate, declControl,
      toolResult(CANDIDATE_CALL_ID, CANDIDATE_TEXT), toolResult(CONTROL_CALL_ID, 'control bytes')]),
    realRow(4, [task, declTwin, declContainer, declControl,
      toolResult(TWIN_CALL_ID, CANDIDATE_TEXT), toolResult(CONTAINER_CALL_ID, containerCapturedText),
      toolResult(CONTROL_CALL_ID, 'control bytes'), receiptCandidate],
    { receipt_recall_ids: [candidateRecallId] }),
    realRow(5, [task, declTwin, declControl,
      toolResult(TWIN_CALL_ID, CANDIDATE_TEXT),
      ...(containerLaterResult
        ? [toolResult(CONTAINER_CALL_ID, containerCapturedText)] : []),
      toolResult(CONTROL_CALL_ID, 'control bytes'), receiptCandidate],
    { receipt_recall_ids: [candidateRecallId] }),
  ];
  const finalReceipts = containerReceipt ? [candidateRecallId, containerRecallId]
    : [candidateRecallId];
  rows.push(realRow(6, [task, declTwin, declControl,
    toolResult(TWIN_CALL_ID, CANDIDATE_TEXT), toolResult(CONTROL_CALL_ID, 'control bytes'),
    receiptCandidate, ...(containerReceipt ? [receiptContainer] : [])],
  { receipt_recall_ids: finalReceipts }));
  return { rows, compactions: compaction ? [{ atSeq: 5, source: 'capture:compaction_prompt.seq' }] : [] };
}

function classLabelFor(verdict) {
  const figure = notApplicableUnitCount(verdict.notApplicable);
  return removalClassLabel({
    realRoute: true,
    claimed: true,
    removalMeasured: verdict.pass,
    candidateUnits: verdict.candidateCount,
    measuredUnits: verdict.verified,
    notApplicableCount: verdict.notApplicable.length,
    notApplicableUnits: figure.basis === 'call-ids' ? figure.count : null,
    notApplicableReasons: notApplicableReasonCounts(verdict.notApplicable, figure.basis),
  });
}

test('exception (b): a not-applicable container does not excuse the candidate text', () => {
  const dir = scratch();
  try {
    const { ledger, candidate, container } = twoRecallLedger(dir);
    const { rows, compactions } = rowsFor({
      candidateRecallId: candidate.recallId,
      containerRecallId: container.recallId,
      containerReceipt: true,
      containerLaterResult: true,
      compaction: true,
    });
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows, compactions });
    /**
     * The reproduction: the container is present in the candidate's receipt
     * request and the request after it, but a recorded compaction hides the
     * container's before-body, so its own removal cannot be measured.
     */
    const containerRow = verdict.notApplicable.find((row) => row.recallId === container.recallId);
    assert.ok(containerRow, JSON.stringify(verdict.notApplicable));
    assert.equal(containerRow.reason, 'before-body-before-compaction');
    assert.equal(verdict.candidates.some((row) => row.recallId === candidate.recallId), false,
      'the candidate is not a measured removal while a live container holds its text');
    const candidateRow = verdict.notApplicable.find((row) => row.recallId === candidate.recallId);
    assert.ok(candidateRow, JSON.stringify(verdict.notApplicable));
    assert.equal(candidateRow.reason, 're-exposed-under-later-result');
    assert.match(candidateRow.why, new RegExp(CONTAINER_CALL_ID, 'u'));
    assert.match(candidateRow.why, /did not verify its removal/u,
      'the reason names the unverified container, not a new call id');
    assert.equal(verdict.verified, 0);
    const label = classLabelFor(verdict);
    assert.match(label, /no removal claimed/u);
    assert.match(label, /not proven absent/u);
    assert.doesNotMatch(label,
      /the exact result text is absent from every request after its first receipt/u,
      'the claim never says the text is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exception (b): a failed container does not excuse the candidate text', () => {
  const dir = scratch();
  try {
    const { ledger, candidate, container } = twoRecallLedger(dir);
    const { rows } = rowsFor({
      candidateRecallId: candidate.recallId,
      containerRecallId: container.recallId,
      containerReceipt: false,
      containerLaterResult: true,
    });
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    /** The container's result was captured, but no receipt ever named its removal. */
    const containerCandidate = verdict.candidates.find(
      (row) => row.recallId === container.recallId);
    assert.ok(containerCandidate, JSON.stringify(verdict.failures));
    assert.equal(containerCandidate.pass, false);
    assert.equal(containerCandidate.checks.receipt, false);
    assert.equal(verdict.candidates.some((row) => row.recallId === candidate.recallId), false,
      'the candidate is not a measured removal while the failed container holds its text');
    const candidateRow = verdict.notApplicable.find((row) => row.recallId === candidate.recallId);
    assert.ok(candidateRow, JSON.stringify(verdict.notApplicable));
    assert.equal(candidateRow.reason, 're-exposed-under-later-result');
    assert.match(candidateRow.why, /did not verify its removal/u);
    assert.equal(verdict.verified, 0);
    const label = classLabelFor(verdict);
    assert.match(label, /no removal claimed/u);
    assert.match(label, /not proven absent/u);
    assert.doesNotMatch(label,
      /the exact result text is absent from every request after its first receipt/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exception (b): a verified container excuses the candidate text and the claim names it', () => {
  const dir = scratch();
  try {
    const { ledger, candidate, container } = twoRecallLedger(dir);
    const { rows } = rowsFor({
      candidateRecallId: candidate.recallId,
      containerRecallId: container.recallId,
      containerReceipt: true,
    });
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 2);
    const candidateCandidate = verdict.candidates.find(
      (row) => row.recallId === candidate.recallId);
    assert.ok(candidateCandidate, JSON.stringify(verdict.failures));
    assert.equal(candidateCandidate.pass, true, JSON.stringify(candidateCandidate.problems));
    assert.deepEqual(candidateCandidate.returnedTexts, [],
      'the verified container result is the stated exception, not a return');
    assert.equal(candidateCandidate.checks.laterAbsence, true);
    const containerCandidate = verdict.candidates.find(
      (row) => row.recallId === container.recallId);
    assert.equal(containerCandidate.pass, true, JSON.stringify(containerCandidate.problems));
    const label = classLabelFor(verdict);
    assert.match(label, /for 2 verified recall\(s\) of 2 candidate recall\(s\)/u);
    assert.match(label, /inside another removed unit's own result/u);
    assert.match(label, /whose own check verified its removal/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exception (b): a verified container without the candidate text changes nothing', () => {
  const dir = scratch();
  try {
    const { ledger, candidate, container } = twoRecallLedger(dir,
      { containerText: CONTAINER_ONLY_TEXT });
    const { rows } = rowsFor({
      candidateRecallId: candidate.recallId,
      containerRecallId: container.recallId,
      containerReceipt: true,
      containerCapturedText: CONTAINER_ONLY_TEXT,
    });
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 2);
    assert.deepEqual(verdict.notApplicable, []);
    const candidateCandidate = verdict.candidates.find(
      (row) => row.recallId === candidate.recallId);
    assert.deepEqual(candidateCandidate.returnedTexts, [],
      'the control container holds none of the candidate text, so no hit is recorded');
    assert.equal(candidateCandidate.checks.laterAbsence, true);
    assert.equal(candidateCandidate.pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eighth audit FIX 3: a verified container result after the receipt still passes and the detail names exception (b)', () => {
  const dir = scratch();
  try {
    const { ledger, candidate, container } = twoRecallLedger(dir);
    const { rows } = rowsFor({
      candidateRecallId: candidate.recallId,
      containerRecallId: container.recallId,
      containerReceipt: true,
      containerLaterResult: true,
    });
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 2);
    const candidateCandidate = verdict.candidates.find(
      (row) => row.recallId === candidate.recallId);
    assert.deepEqual(candidateCandidate.returnedTexts, [],
      'the verified container result after the receipt is exception (b), not a return');
    assert.equal(candidateCandidate.checks.laterAbsence, true);
    assert.match(verdict.detail, /inside another removed unit's own result/u,
      'the detail names exception (b)');
    assert.match(verdict.detail, /whose own check verified its removal/u,
      'the detail says the container check verified its own removal');
    assert.match(verdict.detail, /own run-issued `necromancy` restore/u,
      'the detail names exception (c)');
    assert.match(verdict.detail, /under a new call id/u,
      'the detail names exception (a)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eighth audit FIX 3: a control absent after the compaction boundary still passes, and the detail says within the segment', () => {
  const dir = scratch();
  try {
    const { ledger, candidate } = oneRecallLedger(dir);
    const task = { role: 'user', content: 'control after boundary task' };
    const declUnit = assistantCall(CANDIDATE_CALL_ID, 'a.txt');
    const declControl = assistantCall(CONTROL_CALL_ID, 'c.txt');
    const receipt = receiptMessage(candidate.recallId);
    /**
     * Request 4 is the candidate's receipt; the compaction at seq 5 ends its
     * measured segment at request 6. The same-tool control is present in every
     * body of the segment (requests 4 and 5) and absent after the boundary.
     */
    const rows = [
      realRow(1, [task]),
      realRow(2, [task, declUnit, declControl]),
      realRow(3, [task, declUnit, declControl,
        toolResult(CANDIDATE_CALL_ID, CANDIDATE_TEXT),
        toolResult(CONTROL_CALL_ID, 'control bytes')]),
      realRow(4, [task, declControl, toolResult(CONTROL_CALL_ID, 'control bytes'), receipt],
        { receipt_recall_ids: [candidate.recallId] }),
      realRow(5, [task, declControl, toolResult(CONTROL_CALL_ID, 'control bytes'), receipt],
        { receipt_recall_ids: [candidate.recallId] }),
      realRow(6, [task, declControl, receipt],
        { receipt_recall_ids: [candidate.recallId] }),
    ];
    const verdict = realRouteRemovalVerdict({
      ledger,
      mains: rows,
      compactions: [{ atSeq: 5, source: 'capture:compaction_prompt.seq' }],
    });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures, null, 2));
    assert.equal(verdict.verified, 1);
    assert.match(verdict.detail,
      /same-tool control present in every post-receipt body within the measured segment/u);
    assert.doesNotMatch(verdict.detail,
      /same-tool control present in every post-receipt body, so only a/u,
      'the detail never claims a post-receipt body after the boundary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
