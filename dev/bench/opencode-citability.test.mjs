#!/usr/bin/env node
/**
 * The removal claim's citability surface (ninth audit FIX 1-4).
 *
 * These tests drive the claim and the verdict end to end, not only the class
 * sentence:
 *
 *   - a run with one verified candidate and one text-only recall is not
 *     `measured none`; the claim names the verified count and the refused
 *     run-level measurement, and stays non-citable;
 *   - the citable blocker says `no tool call id this bench can locate` for a
 *     `no-locatable-tool-call` row and keeps the tool-part wording for a part;
 *   - the verdict detail's survivor window follows the verified units'
 *     segments, so a compaction before the receipt with none after is
 *     unbounded;
 *   - a verified recall with one outside part is one `unit(s)`, not one
 *     `recall(s)`, in the removal window's why.
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
  citableClaim, citableVerdict, isCitableClaim, notApplicableUnitCount,
  realRouteRemovalVerdict, removalChecks, verifiedSegmentBound,
} from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-citability-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
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

function archivedText(value) {
  return JSON.stringify({ input: { path: 'big.txt' }, name: 'read', result: { type: 'text', value } });
}

/**
 * A real-route ledger with one manifest and one blob per part. Each recall spec
 * names either tool call ids (`callIds`) or non-tool parts (`nonToolParts`).
 */
function buildLedger(dir, specs) {
  const blobRoot = join(dir, 'blobs');
  const ledger = {
    blobRoot, recallIds: [], recallManifests: [], recallParts: [], blobs: [],
  };
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
    for (const callId of spec.callIds ?? []) {
      const part = addBlob(archivedText(spec.unitText));
      ledger.recallParts.push({
        recallId,
        partIndex,
        sourceNodeId: `oc:ses_ninth:tool:${callId}`,
        sourceSha256: part.hash,
        sourceByteLength: part.bytes,
        blobSha256: part.hash,
      });
      partIndex += 1;
    }
    for (let index = 0; index < (spec.nonToolParts ?? 0); index += 1) {
      const part = addBlob(`non-tool-part-${spec.name}-${index}`);
      ledger.recallParts.push({
        recallId,
        partIndex,
        sourceNodeId: `oc:ses_ninth:reasoning:${index}`,
        sourceSha256: part.hash,
        sourceByteLength: part.bytes,
        blobSha256: part.hash,
      });
      partIndex += 1;
    }
    return { recallId, callIds: [...(spec.callIds ?? [])] };
  });
  return { ledger, recalls };
}

const UNIT_TEXT = 'NINTH-AUDIT-UNIT-TEXT';

/** The one measured recall: a captured unit, a same-path twin, a receipt. */
function measuredRows(recallId, callId, { task = 'ninth audit task' } = {}) {
  const taskMessage = { role: 'user', content: task };
  const declaration = assistantCall(callId, 'read', '{"path":"big.txt"}');
  const twinCallId = `${callId}_twin`;
  const twinParts = [
    assistantCall(twinCallId, 'read', '{"path":"big.txt"}'),
    toolResult(twinCallId, UNIT_TEXT),
  ];
  const receipt = receiptMessage(recallId);
  return [
    realRow(1, [taskMessage]),
    realRow(2, [taskMessage, declaration]),
    realRow(3, [taskMessage, declaration, toolResult(callId, UNIT_TEXT)]),
    realRow(4, [taskMessage, ...twinParts, receipt], { receipt_recall_ids: [recallId] }),
    realRow(5, [taskMessage, ...twinParts, receipt], { receipt_recall_ids: [recallId] }),
  ];
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

/* --------------------------------------------------------------- FIX 1 */

test('ninth audit FIX 1: a verified candidate with a refused run-level measurement is not "measured none"', () => {
  const dir = scratch();
  try {
    const { ledger, recalls } = buildLedger(dir, [
      { name: 'measured', unitText: UNIT_TEXT, callIds: ['call_ninth_a'] },
      { name: 'text-only', unitText: 'unused', nonToolParts: 1 },
    ]);
    const [measured, textOnly] = recalls;
    const rows = measuredRows(measured.recallId, measured.callIds[0]);
    const removal = removalChecks({
      arm: 'test', fixture: null, script: { replies: [] }, ledger, mains: rows,
      capture: true, source: 'http-request-hook',
    });
    assert.equal(removal.claimed, true);
    assert.equal(removal.generic.candidateCount, 1, JSON.stringify(removal.generic.failures));
    assert.equal(removal.generic.verified, 1, JSON.stringify(removal.generic.failures));
    assert.equal(removal.removalMeasuredAny, true);
    assert.equal(removal.removalMeasured, false,
      'the text-only outside recall refuses the run-level measurement');
    assert.equal(removal.callIdOnlyRecallIds.length, 1);
    assert.equal(removal.callIdOnlyRecallIds[0].recallId, textOnly.recallId);
    assert.equal(removal.callIdOnlyRecallIds[0].check, 'no-locatable-tool-call');

    const claim = citableClaim(removalClaimInput(removal));
    assert.equal(claim,
      'removal (1 of 1 recall(s) verified; run-level measurement refused)');
    assert.equal(isCitableClaim(claim), false,
      'a refused run-level measurement is never a citable removal');
    assert.doesNotMatch(claim, /measured none/u,
      'the claim names the verified count instead of erasing it');

    const state = citableVerdict({
      passed: true,
      passedReason: '1 measured captured-body assertion(s); none failed',
      refusal: null,
      captureAvailable: true,
      claimed: removal.claimed,
      removalMeasured: removal.removalMeasured,
      removalCounts: {
        candidates: removal.generic.candidateCount,
        verified: removal.generic.verified,
      },
      claim,
      arm: 'test',
      controlBound: true,
      restoreProven: removal.restoreProven,
      replyFramesAllAnswered: true,
      unmeasuredRecalls: removal.callIdOnlyRecallIds,
      assertions: [],
    });
    assert.equal(state.citable, false);
    const joined = state.citableBlockedBy.join(' ');
    assert.match(joined, /1 of 1 candidate recall\(s\) verified/u, joined);
    assert.match(joined, /another run-level check refused the removal/u, joined);
    assert.doesNotMatch(joined, /measured none/u,
      'the blocker and the claim agree on the verified count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- FIX 2 */

test('ninth audit FIX 2: the citable blocker distinguishes a text-only recall from an unsent tool part', () => {
  const base = {
    passed: true, refusal: null, captureAvailable: true, claimed: true,
    removalMeasured: true, restoreProven: true, claim: 'removal', arm: 'test',
    controlBound: true, replyFramesAllAnswered: true, assertions: [],
  };
  const textOnly = citableVerdict({
    ...base,
    unmeasuredRecalls: [{
      recallId: 'recall:text-only',
      check: 'no-locatable-tool-call',
      why: 'every part the recall names is not a tool node',
    }],
  });
  assert.equal(textOnly.citable, false);
  const textOnlyBlocker = textOnly.citableBlockedBy.join(' ');
  assert.match(textOnlyBlocker,
    /recall\(s\) recall:text-only names no tool call id this bench can locate/u, textOnlyBlocker);
  assert.doesNotMatch(textOnlyBlocker, /tool part that never reached/u,
    'a text-only recall names no tool part');

  const part = citableVerdict({
    ...base,
    unmeasuredRecalls: [{
      recallId: 'recall:unsent-part',
      check: 'call-id only',
      why: 'no byte-level captured-body check covers this removal',
    }],
  });
  assert.equal(part.citable, false);
  const partBlocker = part.citableBlockedBy.join(' ');
  assert.match(partBlocker,
    /recall\(s\) recall:unsent-part names a tool part that never reached a captured request body/u,
    partBlocker);
  assert.doesNotMatch(partBlocker, /no tool call id this bench can locate/u);

  // The ids-only shape keeps the conservative tool-part wording.
  const idsOnly = citableVerdict({ ...base, unmeasuredRecallIds: ['recall:ids-only'] });
  assert.match(idsOnly.citableBlockedBy.join(' '),
    /recall\(s\) recall:ids-only names a tool part that never reached a captured request body/u);
});

/* --------------------------------------------------------------- FIX 3 */

test('ninth audit FIX 3: a pre-receipt compaction with no later boundary leaves the verdict detail unbounded', () => {
  const dir = scratch();
  try {
    const { ledger, recalls } = buildLedger(dir, [
      { name: 'bounded', unitText: UNIT_TEXT, callIds: ['call_ninth_bounded'] },
    ]);
    const [recall] = recalls;
    const callId = recall.callIds[0];
    const taskMessage = { role: 'user', content: 'ninth audit FIX 3 task' };
    const declaration = assistantCall(callId, 'read', '{"path":"big.txt"}');
    const unitResult = toolResult(callId, UNIT_TEXT);
    const twinCallId = `${callId}_twin`;
    const twinParts = [
      assistantCall(twinCallId, 'read', '{"path":"big.txt"}'),
      toolResult(twinCallId, UNIT_TEXT),
    ];
    const receipt = receiptMessage(recall.recallId);
    const rows = [
      realRow(1, [taskMessage]),
      realRow(2, [taskMessage, declaration]),
      realRow(3, [taskMessage, declaration, unitResult]),
      // The compaction is the captured line at seq 4; the unit is still present
      // after it, so its before-body is inside the measured segment.
      realRow(5, [taskMessage, declaration, unitResult]),
      realRow(6, [taskMessage, ...twinParts, receipt], { receipt_recall_ids: [recall.recallId] }),
      realRow(7, [taskMessage, ...twinParts, receipt], { receipt_recall_ids: [recall.recallId] }),
    ];
    const verdict = realRouteRemovalVerdict({
      ledger,
      mains: rows,
      compactions: [{ atSeq: 4, source: 'capture:compaction_prompt.seq' }],
    });
    assert.equal(verdict.candidateCount, 1, JSON.stringify(verdict.failures));
    assert.equal(verdict.verified, 1, JSON.stringify(verdict.failures));
    assert.equal(verdict.pass, true, JSON.stringify(verdict.failures));
    assert.equal(verdict.compactions.boundaries.length, 1,
      'the pre-receipt compaction is recorded');
    assert.deepEqual(verdict.measuredSegments.map((segment) => segment.compactionAtSeq), [null],
      'no compaction follows the receipt');
    assert.equal(verifiedSegmentBound(verdict.measuredSegments, verdict.candidates), false);
    assert.doesNotMatch(verdict.detail,
      /through the measured segment|the window ends at the recorded compaction/u,
      verdict.detail);
    assert.match(verdict.detail, /from its landing request onward/u, verdict.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- FIX 4 */

test('ninth audit FIX 4: a verified recall with one outside part reports the unit figure, not a recall', () => {
  const dir = scratch();
  try {
    const { ledger, recalls } = buildLedger(dir, [{
      name: 'mixed-parts',
      unitText: UNIT_TEXT,
      callIds: ['call_ninth_sent', 'call_ninth_outside'],
    }]);
    const [recall] = recalls;
    const rows = measuredRows(recall.recallId, recall.callIds[0]);
    const verdict = realRouteRemovalVerdict({ ledger, mains: rows });
    assert.equal(verdict.candidateCount, 1, JSON.stringify(verdict.failures));
    assert.equal(verdict.verified, 1, JSON.stringify(verdict.failures));
    const candidate = verdict.candidates[0];
    assert.deepEqual(candidate.notApplicableParts.map((part) => part.callId),
      [recall.callIds[1]], JSON.stringify(candidate.notApplicableParts));

    const removal = removalChecks({
      arm: 'test', fixture: null, script: { replies: [] }, ledger, mains: rows,
      capture: true, source: 'http-request-hook',
    });
    assert.equal(removal.notApplicable.length, 1);
    assert.deepEqual(removal.notApplicable[0].callIds, [recall.callIds[1]]);
    assert.deepEqual(notApplicableUnitCount(removal.notApplicable),
      { count: 1, basis: 'call-ids' });
    assert.match(removal.removalWindow.why, /1 unit\(s\) are not-applicable/u,
      removal.removalWindow.why);
    assert.doesNotMatch(removal.removalWindow.why, /1 recall\(s\) are not-applicable/u,
      removal.removalWindow.why);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
