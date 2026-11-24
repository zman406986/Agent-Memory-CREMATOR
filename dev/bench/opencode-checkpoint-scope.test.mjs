#!/usr/bin/env node
/**
 * The absence claim is scoped at the host's compaction boundary (1h diagnosis
 * §3).
 *
 * The 1h run's four red assertions were ten true removals: the host's
 * compaction request took the raw store, and its checkpoint — a 399,655-char
 * `user` message — re-serialized the exact result text of ten removed units
 * into every later main body. The product cannot rewrite the compaction input
 * and cannot remove text from a user message, so the bench's cheap fix is to
 * make the claim say what it measured: absence and call-entry from the first
 * receipt through the last body before the recorded compaction. The post-segment
 * rows are still read, and disclosed, never failed and never passed.
 *
 * The tests pin every branch, and each branch names its own non-vacuity:
 *
 *   1. a checkpoint re-carries the removed text after the boundary, the unit's
 *      call entry stays gone → `not-applicable: checkpoint-carried-past-segment`,
 *      the claim names the unit count and the checkpoint requests, and the same
 *      world **without** a boundary fails on the carried text (so the boundary
 *      is what changes the verdict, not a relaxed scan);
 *   2. the removed text reappears in an ordinary later tool result **before**
 *      the boundary → `not-applicable: re-exposed-under-later-result`, as
 *      ISSUE-256 already required; the control container that does not carry
 *      the text leaves the unit verified;
 *   3. the unit's own call entry returns **after** the boundary → the unit is
 *      disclosed as `returned-past-segment`, not a pass; without the boundary
 *      the same entry is a red `callEntryAbsent` failure.
 *
 * Offline only: no host binary, no network, no key, no paid run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  REAL_ROUTE_ABSENCE_ASSERTION_NAME, checkpointCarriedLabel,
  notApplicableReasonCounts, notApplicableUnitCount, realRouteRemovalVerdict,
  removalClassLabel, returnedPastSegmentLabel,
} from './opencode-run.mjs';
import { removalAbsenceScopeLabel } from './removal-bodies.mjs';
import { receiptLineText } from './receipt-line.mjs';

const KEPT_CALL_ID = 'call_ck_kept';
const CARRIED_CALL_ID = 'call_ck_carried';
const TWIN_CALL_ID = 'call_ck_twin';
const CONTROL_CALL_ID = 'call_ck_control';
const RETURNED_CALL_ID = 'call_ck_returned';
const CONTAINER_CALL_ID = 'call_ck_container';

/** The unit that verifies: its text must be absent through the segment. */
const KEPT_TEXT = `CK-KEPT-TEXT ${'k'.repeat(900)}`;
/** The unit the host checkpoint re-carries after the boundary. */
const CARRIED_TEXT = `CK-CARRIED-TEXT ${'c'.repeat(900)}`;
/** The unit whose call entry returns after the boundary. */
const RETURNED_TEXT = `CK-RETURNED-TEXT ${'r'.repeat(900)}`;
/** A same-path re-read of the kept unit: the survivor, never required. */
const TWIN_TEXT = KEPT_TEXT;
/** A container result that carries the carried unit's text. */
const CONTAINER_TEXT = `CK-CONTAINER-HEAD\n${CARRIED_TEXT}\nCK-CONTAINER-TAIL`;
/** A container result that shares nothing with the carried unit. */
const CONTAINER_ONLY_TEXT = `CK-CONTAINER-ONLY ${'v'.repeat(900)}`;

/** The compaction request's capture seq: the segment ends at the row before it. */
const BOUNDARY_SEQ = 5;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-checkpoint-'));
}

function writeBlobFile(blobRoot, hash, text) {
  const path = join(blobRoot, 'sha256', hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * One recall per named unit, each with its own manifest and archived result so
 * the archive check can name either unit's bytes. A unit is a `read` of its own
 * file path; same-path reads are the only surviving twins.
 */
function ledgerFor(dir, units) {
  const blobRoot = join(dir, 'blobs');
  const ledger = {
    blobRoot, recallIds: [], recallManifests: [], recallParts: [], blobs: [],
  };
  const recalls = new Map();
  for (const [index, unit] of units.entries()) {
    const archived = JSON.stringify({
      input: { path: unit.path },
      name: 'read',
      result: { type: 'text', value: unit.text },
    });
    const partHash = sha256(archived);
    const part = writeBlobFile(blobRoot, partHash, archived);
    const manifestText = `ck-manifest-${String(index)}-${unit.callId}`;
    const manifestHash = sha256(manifestText);
    const manifest = writeBlobFile(blobRoot, manifestHash, manifestText);
    const recallId = `recall:sha256:${manifestHash}`;
    ledger.recallIds.push(recallId);
    ledger.recallManifests.push({ recallId, manifestSha256: manifestHash });
    ledger.recallParts.push({
      recallId,
      partIndex: 0,
      sourceNodeId: `oc:ses_ck:tool:${unit.callId}`,
      sourceSha256: partHash,
      sourceByteLength: part.bytes,
      blobSha256: partHash,
    });
    ledger.blobs.push({ sha256: manifestHash, byteLength: manifest.bytes });
    ledger.blobs.push({ sha256: partHash, byteLength: part.bytes });
    recalls.set(unit.callId, {
      callId: unit.callId, recallId, text: unit.text, path: unit.path,
    });
  }
  return { ledger, recalls };
}

function realRow(seq, messages, extra = {}) {
  return { seq, main_turn: seq - 1, messages, ...extra };
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
function receiptMessage(recallId, target = 'ck.txt') {
  return { role: 'user', content: receiptLineText(target, recallId, '', '', 'i1') };
}

function compactionsFor(compaction) {
  return compaction ? [{ atSeq: BOUNDARY_SEQ, source: 'capture:compaction_prompt.seq' }] : [];
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
    checkpointCarried: verdict.checkpointCarried,
    returnedPastSegment: verdict.returnedPastSegment,
    segmentBound: verdict.segmentScoped,
  });
}

/**
 * The shared timeline. Two units are removed at request 4 (their receipts name
 * both recalls); request 4 is the only body of the measured segment when a
 * compaction is recorded at seq 5.
 *
 *   request 2/3: both units are declared and their results land (before-body)
 *   request 4:   both receipts; the kept unit's same-path twin result; the
 *                carried unit's same-tool control result; both units' own
 *                results and call entries are gone
 *   request 6/7: after the boundary, the `carrier` chooses what comes back —
 *                a `checkpoint` user message carrying the carried unit's text,
 *                a `container` tool result carrying it, a `call-entry`
 *                assistant message declaring the unit again, or `none`.
 */
function rowsFor({
  keptRecallId, carriedRecallId, carrier = 'checkpoint', compaction = true,
  containerText = CONTAINER_TEXT, inSegmentContainer = false,
} = {}) {
  const task = { role: 'user', content: 'checkpoint scope task' };
  const declKept = assistantCall(KEPT_CALL_ID, 'kept.txt');
  const declCarried = assistantCall(CARRIED_CALL_ID, 'carried.txt');
  const declTwin = assistantCall(TWIN_CALL_ID, 'kept.txt');
  const declControl = assistantCall(CONTROL_CALL_ID, 'control.txt');
  const declContainer = assistantCall(CONTAINER_CALL_ID, 'container.txt');
  const receiptKept = receiptMessage(keptRecallId, 'kept.txt');
  const receiptCarried = receiptMessage(carriedRecallId, 'carried.txt');
  const checkpoint = {
    role: 'user',
    content: `<conversation-checkpoint><recent-context>[Tool result] ${CARRIED_TEXT}`
      + '</recent-context></conversation-checkpoint>',
  };
  const rows = [
    realRow(1, [task]),
    realRow(2, [task, declKept, declCarried, declControl]),
    realRow(3, [task, declKept, declCarried, declControl,
      toolResult(KEPT_CALL_ID, KEPT_TEXT), toolResult(CARRIED_CALL_ID, CARRIED_TEXT),
      toolResult(CONTROL_CALL_ID, 'control bytes')]),
    realRow(4, [task, declTwin, declControl,
      ...(inSegmentContainer ? [declContainer, toolResult(CONTAINER_CALL_ID, containerText)] : []),
      toolResult(TWIN_CALL_ID, TWIN_TEXT), toolResult(CONTROL_CALL_ID, 'control bytes'),
      receiptKept, receiptCarried],
    { receipt_recall_ids: [keptRecallId, carriedRecallId] }),
  ];
  const afterBoundary = [task, declTwin, declControl,
    toolResult(TWIN_CALL_ID, TWIN_TEXT), toolResult(CONTROL_CALL_ID, 'control bytes'),
    receiptKept, receiptCarried];
  if (carrier === 'checkpoint') afterBoundary.push(checkpoint);
  if (carrier === 'container') {
    afterBoundary.push(declContainer, toolResult(CONTAINER_CALL_ID, containerText));
  }
  if (carrier === 'call-entry') afterBoundary.push(declCarried);
  rows.push(realRow(6, [...afterBoundary], { receipt_recall_ids: [keptRecallId, carriedRecallId] }));
  rows.push(realRow(7, [...afterBoundary], { receipt_recall_ids: [keptRecallId, carriedRecallId] }));
  return { rows, compactions: compactionsFor(compaction) };
}

function twoUnitWorld(dir, options = {}) {
  const { ledger, recalls } = ledgerFor(dir, [
    { callId: KEPT_CALL_ID, path: 'kept.txt', text: KEPT_TEXT },
    { callId: CARRIED_CALL_ID, path: 'carried.txt', text: CARRIED_TEXT },
  ]);
  const kept = recalls.get(KEPT_CALL_ID);
  const carried = recalls.get(CARRIED_CALL_ID);
  const world = rowsFor({
    keptRecallId: kept.recallId, carriedRecallId: carried.recallId, ...options,
  });
  return { ledger, kept, carried, ...world };
}

test('checkpoint scope: a post-segment checkpoint re-carry is not-applicable and the claim names it', () => {
  const dir = scratch();
  try {
    const world = twoUnitWorld(dir, { carrier: 'checkpoint', compaction: true });
    const verdict = realRouteRemovalVerdict({
      ledger: world.ledger, mains: world.rows, compactions: world.compactions,
    });
    /**
     * The kept unit verifies inside the segment; the carried unit is not a
     * candidate and not a failure: it is recorded not-applicable with the named
     * checkpoint reason.
     */
    const keptRow = verdict.candidates.find((row) => row.recallId === world.kept.recallId);
    assert.ok(keptRow, JSON.stringify(verdict.failures));
    assert.equal(keptRow.pass, true, JSON.stringify(keptRow.problems));
    assert.equal(verdict.candidates.some((row) => row.recallId === world.carried.recallId), false,
      'the checkpoint-carried unit is not a measured removal');
    assert.deepEqual(verdict.failures, []);
    const carriedRow = verdict.notApplicable.find((row) => row.recallId === world.carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.notApplicable));
    assert.equal(carriedRow.reason, 'checkpoint-carried-past-segment');
    assert.deepEqual(carriedRow.callIds, [CARRIED_CALL_ID]);
    assert.match(carriedRow.why, /host checkpoint message/u);
    assert.match(carriedRow.why, /request 6-7/u);
    /**
     * The unit's call entry stayed absent: the record says so, and the
     * post-segment carry is the only observation.
     */
    const carriedUnit = verdict.pastSegmentObservations.find(
      (row) => row.callId === CARRIED_CALL_ID);
    assert.ok(carriedUnit, JSON.stringify(verdict.pastSegmentObservations));
    assert.equal(carriedUnit.reason, 'checkpoint-carried-past-segment');
    assert.deepEqual(carriedUnit.checkpointSeqs, [6, 7]);
    assert.deepEqual(carriedUnit.carriedSeqs, [6, 7]);
    assert.deepEqual(carriedUnit.boundary, { atSeq: BOUNDARY_SEQ, source: 'capture:compaction_prompt.seq' });
    assert.equal(carriedUnit.segmentToSeq, 4);
    /** The run-level record: one unit, the boundary, and the carrier requests. */
    assert.equal(verdict.checkpointCarried.unitCount, 1);
    assert.deepEqual(verdict.checkpointCarried.callIds, [CARRIED_CALL_ID]);
    assert.deepEqual(verdict.checkpointCarried.boundarySeqs, [BOUNDARY_SEQ]);
    assert.deepEqual(verdict.checkpointCarried.checkpointSeqs, [6, 7]);
    assert.deepEqual(verdict.checkpointCarried.carriedSeqs, [6, 7]);
    assert.deepEqual(verdict.checkpointCarried.segmentToSeqs, [4]);
    assert.equal(verdict.returnedPastSegment.unitCount, 0);
    /** The claim is segment-scoped: the verified segment ends at the compaction. */
    assert.equal(verdict.segmentScoped, true);
    assert.deepEqual(keptRow.segmentScope, {
      fromSeq: 4, toSeq: 4, compactionAtSeq: BOUNDARY_SEQ,
      compactionSource: 'capture:compaction_prompt.seq', scoped: true,
    });
    assert.equal(verdict.pass, true, 'the candidate set verifies inside the segment');
    assert.match(verdict.detail, /of its measured segment \(the segment ends at the recorded compaction\)/u);
    assert.match(verdict.detail, /1 unit\(s\) are carried past the measured segment/u);
    assert.match(verdict.detail, /request 6-7/u);
    const label = classLabelFor(verdict);
    assert.match(label, /within the measured segment \(the window ends at the recorded compaction\)/u);
    assert.match(label, /1 unit\(s\) are carried past the measured segment/u);
    assert.match(label, /host checkpoint message\(s\) at request 6-7/u);
    assert.match(label, /not counted as measured removals/u);
    assert.doesNotMatch(label, /did not verify and are outside the claim/u,
      'the checkpoint-carried unit is not a failed candidate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope non-vacuity: the same checkpoint without a boundary is a red carried-text failure', () => {
  const dir = scratch();
  try {
    const world = twoUnitWorld(dir, { carrier: 'checkpoint', compaction: false });
    const verdict = realRouteRemovalVerdict({ ledger: world.ledger, mains: world.rows });
    const carriedRow = verdict.candidates.find((row) => row.recallId === world.carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.failures));
    assert.equal(carriedRow.pass, false);
    assert.equal(carriedRow.checks.laterAbsence, false);
    assert.ok(carriedRow.carriedTexts.length > 0, JSON.stringify(carriedRow.carriedTexts));
    assert.ok(carriedRow.problems.some((problem) => /exact result text is still carried/u.test(problem)),
      JSON.stringify(carriedRow.problems));
    assert.equal(verdict.notApplicable.some(
      (row) => row.reason === 'checkpoint-carried-past-segment'), false,
      'no boundary means no segment-scoped excuse');
    assert.equal(verdict.checkpointCarried.unitCount, 0);
    assert.equal(verdict.segmentScoped, false);
    assert.equal(verdict.pass, false);
    const label = classLabelFor(verdict);
    assert.match(label, /no removal measured at the run level/u);
    assert.doesNotMatch(label, /are carried past the measured segment/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope: a return inside the measured segment is re-exposed-under-later-result, as before', () => {
  const dir = scratch();
  try {
    const { ledger, recalls } = ledgerFor(dir, [
      { callId: CARRIED_CALL_ID, path: 'carried.txt', text: CARRIED_TEXT },
      { callId: KEPT_CALL_ID, path: 'kept.txt', text: KEPT_TEXT },
    ]);
    const carried = recalls.get(CARRIED_CALL_ID);
    const kept = recalls.get(KEPT_CALL_ID);
    const world = rowsFor({
      keptRecallId: kept.recallId, carriedRecallId: carried.recallId,
      carrier: 'none', compaction: true, containerText: CONTAINER_TEXT,
      inSegmentContainer: true,
    });
    /**
     * The container lands at request 4, inside the segment: the unit's text is
     * re-exposed where the claim measures absence, so the unit is not-applicable
     * by ISSUE-256's rule, never a pass. The compaction at 5 is irrelevant to
     * this hit.
     */
    const verdict = realRouteRemovalVerdict({
      ledger, mains: world.rows, compactions: world.compactions,
    });
    const carriedRow = verdict.notApplicable.find((row) => row.recallId === carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.notApplicable));
    assert.equal(carriedRow.reason, 're-exposed-under-later-result');
    assert.match(carriedRow.why, new RegExp(CONTAINER_CALL_ID, 'u'));
    assert.equal(verdict.candidates.some((row) => row.recallId === carried.recallId), false);
    assert.equal(verdict.checkpointCarried.unitCount, 0,
      'an in-segment container hit is not a checkpoint carry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope non-vacuity: a container without the unit text leaves the unit verified', () => {
  const dir = scratch();
  try {
    const { ledger, recalls } = ledgerFor(dir, [
      { callId: CARRIED_CALL_ID, path: 'carried.txt', text: CARRIED_TEXT },
      { callId: KEPT_CALL_ID, path: 'kept.txt', text: KEPT_TEXT },
    ]);
    const carried = recalls.get(CARRIED_CALL_ID);
    const kept = recalls.get(KEPT_CALL_ID);
    const world = rowsFor({
      keptRecallId: kept.recallId, carriedRecallId: carried.recallId,
      carrier: 'none', compaction: true, containerText: CONTAINER_ONLY_TEXT,
      inSegmentContainer: true,
    });
    const verdict = realRouteRemovalVerdict({
      ledger, mains: world.rows, compactions: world.compactions,
    });
    const carriedRow = verdict.candidates.find((row) => row.recallId === carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.failures));
    assert.equal(carriedRow.pass, true, JSON.stringify(carriedRow.problems));
    assert.deepEqual(carriedRow.returnedTexts, []);
    assert.equal(verdict.notApplicable.some(
      (row) => row.recallId === carried.recallId), false);
    assert.equal(verdict.verified, 2);
    assert.equal(verdict.pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope: a call entry returning after the boundary is disclosed, not a pass', () => {
  const dir = scratch();
  try {
    const world = twoUnitWorld(dir, { carrier: 'call-entry', compaction: true });
    const verdict = realRouteRemovalVerdict({
      ledger: world.ledger, mains: world.rows, compactions: world.compactions,
    });
    assert.equal(verdict.candidates.some((row) => row.recallId === world.carried.recallId), false,
      'a unit whose call entry returns after the boundary is not a measured removal');
    const carriedRow = verdict.notApplicable.find((row) => row.recallId === world.carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.notApplicable));
    assert.equal(carriedRow.reason, 'returned-past-segment');
    assert.match(carriedRow.why, /request 6-7/u);
    assert.deepEqual(verdict.returnedPastSegment.callIds, [CARRIED_CALL_ID]);
    assert.deepEqual(verdict.returnedPastSegment.returnedSeqs, [6, 7]);
    assert.deepEqual(verdict.returnedPastSegment.boundarySeqs, [BOUNDARY_SEQ]);
    assert.equal(verdict.checkpointCarried.unitCount, 0);
    assert.match(verdict.detail, /return after the measured segment/u);
    const label = classLabelFor(verdict);
    assert.match(label, /1 unit\(s\) return after the measured segment/u);
    assert.match(label, /the segment claim stands and the whole-run removal cannot be made/u);
    assert.doesNotMatch(label, /did not verify and are outside the claim/u);
    /** The other unit still verifies inside the segment. */
    assert.equal(verdict.verified, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope non-vacuity: the same call entry without a boundary is a red call-entry failure', () => {
  const dir = scratch();
  try {
    const world = twoUnitWorld(dir, { carrier: 'call-entry', compaction: false });
    const verdict = realRouteRemovalVerdict({ ledger: world.ledger, mains: world.rows });
    const carriedRow = verdict.candidates.find((row) => row.recallId === world.carried.recallId);
    assert.ok(carriedRow, JSON.stringify(verdict.failures));
    assert.equal(carriedRow.pass, false);
    assert.equal(carriedRow.checks.callEntryAbsent, false);
    assert.ok(carriedRow.callEntryReturns.length > 0);
    assert.ok(carriedRow.problems.some((problem) =>
      /call entry is still declared/u.test(problem)), JSON.stringify(carriedRow.problems));
    assert.equal(verdict.returnedPastSegment.unitCount, 0);
    assert.equal(verdict.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint scope: the labels state the unit count and the carrier requests, and nothing without a record', () => {
  const record = {
    unitCount: 10,
    callIds: [CARRIED_CALL_ID],
    segmentToSeqs: [144],
    boundarySeqs: [145],
    checkpointSeqs: [146, 147, 148, 158],
    carriedSeqs: [146, 147, 148, 158],
  };
  const label = checkpointCarriedLabel(record);
  assert.match(label, /^10 unit\(s\) are carried past the measured segment/u);
  assert.match(label, /request 144/u);
  assert.match(label, /compaction at request 145/u);
  assert.match(label, /host checkpoint message\(s\) at request 146-148, 158/u);
  assert.match(label, /not counted as measured removals/u);
  assert.equal(checkpointCarriedLabel({ unitCount: 0, checkpointSeqs: [1] }), '',
    'a record with no unit says nothing');
  assert.equal(checkpointCarriedLabel(null), '');
  const returned = returnedPastSegmentLabel({
    unitCount: 1, segmentToSeqs: [144], boundarySeqs: [145], returnedSeqs: [150],
  });
  assert.match(returned, /^1 unit\(s\) return after the measured segment ending at request 144/u);
  assert.match(returned, /compaction at request 145/u);
  assert.match(returned, /present again at request 150/u);
  assert.equal(returnedPastSegmentLabel({ unitCount: 0 }), '');
  /** The absence assertion still names the segment bound and every exception. */
  assert.match(REAL_ROUTE_ABSENCE_ASSERTION_NAME,
    /same-tool control in every post-receipt body within the measured segment/u);
});

test('checkpoint scope: the raw-body label states the measured segment and the unsearched requests', () => {
  const base = {
    kind: 'decoded-string', requests: 112, rawBodyRows: 112,
    fragments: [{ sha256: 'a'.repeat(64), bytes: 900 }], unexplained: [],
  };
  const scoped = removalAbsenceScopeLabel({
    ...base,
    measuredSegment: { throughSeq: 144, boundarySeqs: [145], excludedRequests: 36 },
  });
  assert.match(scoped, /the search stops at the measured segment's boundary/u);
  assert.match(scoped, /through request 144/u);
  assert.match(scoped, /a host compaction at request 145 ends it/u);
  assert.match(scoped, /the 36 later request\(s\) are outside the segment and were not searched/u);
  const unscoped = removalAbsenceScopeLabel(base);
  assert.doesNotMatch(unscoped, /measured segment/u,
    'a capture with no measured segment keeps the whole-capture sentence');
  assert.match(unscoped, /searched in the raw body text of all 112 request\(s\)/u);
});

test('checkpoint scope: the two new reasons are counted and phrased by the reason vocabulary', () => {
  const counts = notApplicableReasonCounts([{
    recallId: 'recall:sha256:aa',
    callIds: [CARRIED_CALL_ID, RETURNED_CALL_ID],
    reason: 'checkpoint-carried-past-segment',
    partReasons: [
      { callId: CARRIED_CALL_ID, reason: 'checkpoint-carried-past-segment' },
      { callId: RETURNED_CALL_ID, reason: 'returned-past-segment' },
    ],
  }], 'call-ids');
  assert.deepEqual(counts, {
    'checkpoint-carried-past-segment': 1,
    'returned-past-segment': 1,
  });
  const figure = notApplicableUnitCount([{
    callIds: [CARRIED_CALL_ID, RETURNED_CALL_ID],
  }]);
  assert.equal(figure.basis, 'call-ids');
  assert.equal(figure.count, 2);
});
