#!/usr/bin/env node
/**
 * The removable fixture and the runner's removal/journal helpers (ISSUE-196).
 *
 * Offline only: no host binary, no API key, no mock server. These tests pin the
 * fixture's determinism and the rule that reads request bodies instead of
 * receipts, plus the run-level pieces the live bench depends on (journal summary,
 * recall-id cross-check, redirect map, real-data change detection).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createDefaultRules, DEFAULT_CONFIG } from '@cremator/core';
import { opencodeReceiptEntryId } from 'cremator-opencode';
import { receiptLineText } from './receipt-line.mjs';

import {
  LANE_RULES, MIN_FIXTURE_BYTES, PRODUCT_BAR_BYTES, READER_CAP_BYTES, checkProductBar,
  fixtureFileBytes, hostReaderCapRecord, laneFileSentinels, laneMarkers, laneRule, laneTurns,
  laneTwinMarkers, laneTwinResults, productBarAtLaunch, renderScript, validateFixture,
  writeFixtureWorld,
} from './opencode-removal-fixture.mjs';
import {
  CLAIMED_SUBJECTS, HARNESS_MODULES, MEASURED_REMOVAL_RULES, absentRecord, armSessionDbs,
  artifactDrift, callIdFromNodeId, childEnv,
  citableClaim, citableVerdict, consecutiveBodyHashes, contentBaselineSubject,
  controlLaneVerdicts, databaseFingerprint,
  exitCodeForRun,
  exportIdentity, fingerprintChanges, freshRunSessionIdentity,
  harnessFingerprint, harnessModulesFromSource, journalStoragePlansHold, laneApplicationVerdict,
  localImportClosure,
  messageJsonBytes,
  missingSeededRows, moduleEntryRelation, pathInside, perRequestReapplication, pluginArtifact,
  productConstantsAtLaunch, readJournal, readLedger, readRequests, readerHeadText,
  requestContentStability,
  realDataChanges, realDataSnapshot, recallCallIds, recallPartCoverage, recallWireCrossCheck,
  redirectEnv, removalChecks, removalLaneVerdict, removedSeededContentForRequest,
  replayContentBaseline, replayContinuation, scriptedReplyAccounting, seededContentEverywhere,
  sourceRemovalMarker,
  seededRowHashes,
  sessionReceiptRecallIds, sessionSendableContent, staleBuildRefusal, unitResultBytes,
  unitWireBytes, wireVerdict,
} from './opencode-run.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(BENCH_DIR, 'opencode-offline.script.json');

function loadScript() {
  return JSON.parse(readFileSync(SCRIPT, 'utf8'));
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-fixture-'));
}


/**
 * A restore verdict a test may pass to `removalChecks`/`wireVerdict` when it is
 * measuring the lanes rather than the restore lane. The restore lane itself is
 * tested by its own cases, with real blob files.
 */
function restorePass(recallIds) {
  return {
    pass: true, measured: true, reason: null,
    requiredRecallIds: [...recallIds], restoredRecallIds: [...recallIds],
    byteCheckedRecallIds: [...recallIds], rows: [], failures: [],
    detail: 'synthetic restore verdict: this case measures the lanes, not the restore lane',
  };
}

/* ------------------------------------------------------------------ the fixture */

test('fixture: every shipped file is above the reader cap and deterministic', () => {
  const script = loadScript();
  const checked = validateFixture(script);
  assert.equal(checked.ok, true, checked.refused);
  for (const file of checked.fixture.files) {
    const first = fixtureFileBytes(file);
    const second = fixtureFileBytes(file);
    assert.equal(first, second, `${file.name} is deterministic`);
    assert.ok(first.startsWith(`${file.sentinel}\n`), `${file.name} starts with its sentinel`);
    assert.ok(Buffer.byteLength(first, 'utf8') >= PRODUCT_BAR_BYTES + 1,
      `${file.name} is at or above the product bar`);
    if (file.bytes > READER_CAP_BYTES) {
      assert.ok(Buffer.byteLength(first, 'utf8') >= MIN_FIXTURE_BYTES,
        `${file.name} is above the cap it declares`);
    } else {
      assert.ok(Buffer.byteLength(first, 'utf8') <= READER_CAP_BYTES,
        `${file.name} is below the reader cap, so its restore can be whole`);
    }
  }
});

test('fixture: the declared reader cap and product bar must equal the bench constants', () => {
  const base = loadScript();
  assert.equal(base.fixture.readerCapBytes, READER_CAP_BYTES);
  assert.equal(base.fixture.productBarBytes, PRODUCT_BAR_BYTES);
  const wrongCap = structuredClone(base);
  wrongCap.fixture.readerCapBytes = READER_CAP_BYTES + 1;
  assert.match(validateFixture(wrongCap).refused, /readerCapBytes/u);
  const wrongBar = structuredClone(base);
  wrongBar.fixture.productBarBytes = PRODUCT_BAR_BYTES - 1;
  assert.match(validateFixture(wrongBar).refused, /productBarBytes/u);
  const missingCap = structuredClone(base);
  delete missingCap.fixture.readerCapBytes;
  assert.match(validateFixture(missingCap).refused, /readerCapBytes/u);
});

test('fixture: the world is written with the declared bytes and a stable hash', () => {
  const dir = scratch();
  try {
    const script = loadScript();
    const checked = validateFixture(script);
    assert.equal(checked.ok, true, checked.refused);
    const first = writeFixtureWorld(dir, checked.fixture);
    const second = writeFixtureWorld(dir, checked.fixture);
    assert.deepEqual(first.map((file) => file.sha256), second.map((file) => file.sha256));
    for (const file of first) {
      assert.equal(file.bytes, Buffer.byteLength(readFileSync(file.path, 'utf8')));
      assert.ok(file.bytes > 0);
    }
    const units = first.filter((file) => file.sentinel !== null);
    assert.ok(units.every((file) => file.bytes >= PRODUCT_BAR_BYTES));
    assert.ok(units.some((file) => file.aboveReaderCap), 'the large lanes are above the cap');
    assert.ok(units.some((file) => !file.aboveReaderCap),
      'one unit is below the cap, so its restore can reach the model whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture: the shipped lanes resolve to the turns the proof needs', () => {
  const script = loadScript();
  const checked = validateFixture(script);
  assert.equal(checked.ok, true, checked.refused);
  const lanes = new Map(checked.fixture.lanes.map((lane) => [lane.name, lane]));
  const single = lanes.get('single');
  const batch = lanes.get('multi-unit-pass');
  const stale = lanes.get('stale');
  assert.ok(single !== undefined && batch !== undefined && stale !== undefined);
  assert.deepEqual(laneTurns(single, script), {
    rule: 'superseded-read', unitTurn: 0, triggerTurn: 1, twinTurn: 1,
    supersederTurn: 1, firstRemovalTurn: 2, firstStableTurn: 2,
  });
  assert.deepEqual(laneTurns(batch, script), {
    rule: 'superseded-read', unitTurn: 2, triggerTurn: 3, twinTurn: 3,
    supersederTurn: 3, firstRemovalTurn: 4, firstStableTurn: 4,
  });
  // Read, write, read: the write is the trigger and the later read is the twin,
  // so the measured window starts one request after the write result.
  assert.deepEqual(laneTurns(stale, script), {
    rule: 'stale-read', unitTurn: 4, triggerTurn: 5, twinTurn: 6,
    supersederTurn: 6, firstRemovalTurn: 6, firstStableTurn: 7,
  });
  // One sub-cap unit whose restore can reach the model whole (ISSUE-214 P1).
  const small = lanes.get('restore-small');
  assert.ok(small !== undefined);
  assert.deepEqual(laneTurns(small, script), {
    rule: 'superseded-read', unitTurn: 9, triggerTurn: 10, twinTurn: 10,
    supersederTurn: 10, firstRemovalTurn: 11, firstStableTurn: 11,
  });
  // The sentinel names the unit's call id, not the file bytes: the superseding
  // read legitimately carries the same file sentinel.
  assert.deepEqual(laneMarkers(checked.fixture, single),
    ['call_single_1_RS-SINGLE-UNIT', 'RS-SINGLE-UNIT']);
  assert.deepEqual(laneFileSentinels(checked.fixture, single), ['RACOONS-FIXTURE-SINGLE-9f1c7a']);
  assert.deepEqual(laneTwinMarkers(checked.fixture, single), ['call_single_2']);
  assert.deepEqual(laneTwinResults(checked.fixture, single), [{
    callId: 'call_single_2', markers: ['RACOONS-FIXTURE-SINGLE-9f1c7a'],
  }]);
  // The stale lane carries a marker the call id cannot hide: the content marker
  // is in the pre-write body, and the write that follows replaces the file with
  // bytes that do not carry it.
  assert.deepEqual(laneMarkers(checked.fixture, stale),
    ['call_stale_1_RS-STALE', 'RS-STALE', 'RACOONS-PREWRITE-STALE-7c31af']);
  const staleFile = checked.fixture.files.find((file) => file.name === 'big-stale.txt');
  assert.equal(fixtureFileBytes(staleFile).includes('RACOONS-PREWRITE-STALE-7c31af'), true,
    'the content marker is in the file the removed read carried');
  assert.equal(stale.unitCalls[0].includes('RACOONS-PREWRITE-STALE-7c31af'), false,
    'the content marker is not part of the call id');
  assert.equal(JSON.stringify(script).split('RACOONS-PREWRITE-STALE-7c31af').length - 1, 2,
    'the marker appears only as the file marker and the lane declaration, never in a call input');
  // The twin's file sentinel is scoped to the twin's own result: the stale
  // lane's write call carries the same bytes, so a body-wide sentinel scan
  // cannot prove the twin read's result survived.
  assert.deepEqual(laneTwinMarkers(checked.fixture, stale), ['call_stale_2']);
  assert.deepEqual(laneTwinResults(checked.fixture, stale), [{
    callId: 'call_stale_2', markers: ['RACOONS-FIXTURE-STALE-7d4e2c'],
  }]);
  for (const sentinel of laneMarkers(checked.fixture, single)) {
    assert.equal(fixtureFileBytes(checked.fixture.files[0]).includes(sentinel), false,
      'the unit marker does not appear in the file bytes');
  }
});

test('fixture: the replay script exercises both rules in one run', () => {
  const script = JSON.parse(readFileSync(join(BENCH_DIR, 'opencode-replay.script.json'), 'utf8'));
  const checked = validateFixture(script);
  assert.equal(checked.ok, true, checked.refused);
  const lanes = checked.fixture.lanes;
  assert.deepEqual(lanes.map((lane) => lane.name).sort(), ['replay-single', 'replay-stale']);
  assert.deepEqual(lanes.map((lane) => laneRule(lane)).sort(), ['stale-read', 'superseded-read']);
  // The stale lane carries the byte-level marker; the superseded lane does not,
  // because its twin legitimately carries the same file bytes.
  const stale = lanes.find((lane) => laneRule(lane) === 'stale-read');
  assert.deepEqual(stale.contentMarkers, ['RACOONS-PREWRITE-REPLAY-STALE-2f9b61']);
  const single = lanes.find((lane) => laneRule(lane) === 'superseded-read');
  assert.equal(single.contentMarkers, undefined);
  // One replay runs both: the reasoning measurement (ADR-0045) and the stale
  // read (ADR-0046) are no longer exclusive.
  assert.equal(lanes.length, 2);
  // Six turns run the two lanes; the seventh calls necromancy for both removed
  // units and the eighth replies DONE (the restore lane, ISSUE-214 P1).
  assert.equal(script.replies.length, 8, 'the eight turns both lanes and the restore need');
});

test('fixture: the rendered script has no {{WORK}} token and names the arm path', () => {
  const script = loadScript();
  const rendered = renderScript(script, 'C:\\world\\work');
  const text = JSON.stringify(rendered);
  assert.equal(text.includes('{{WORK}}'), false);
  assert.ok(text.includes('C:/world/work/big-single.txt'));
  assert.equal(JSON.stringify(script).includes('{{WORK}}'), true, 'the source script is untouched');
});

test('fixture: a malformed fixture is refused by name', () => {
  const base = loadScript();
  assert.match(validateFixture({ replies: [] }).refused, /no fixture block/u);

  const belowBar = structuredClone(base);
  belowBar.fixture.files[0].bytes = PRODUCT_BAR_BYTES;
  assert.match(validateFixture(belowBar).refused, /at least/u);

  const lateSuperseder = structuredClone(base);
  lateSuperseder.fixture.lanes[0].supersedingCalls = ['call_single_1_RS-SINGLE-UNIT'];
  assert.match(validateFixture(lateSuperseder).refused, /trigger must come later|must come later|twin/u);

  const staleNoTrigger = structuredClone(base);
  const staleLane = staleNoTrigger.fixture.lanes.find((lane) => lane.rule === 'stale-read');
  delete staleLane.triggerCalls;
  assert.match(validateFixture(staleNoTrigger).refused, /names no triggerCalls/u);

  const staleWrongTrigger = structuredClone(base);
  const wrongLane = staleWrongTrigger.fixture.lanes.find((lane) => lane.rule === 'stale-read');
  wrongLane.triggerCalls = ['call_stale_2'];
  assert.match(validateFixture(staleWrongTrigger).refused, /not write calls|twin read must come after/u);

  const unknownCall = structuredClone(base);
  unknownCall.fixture.lanes[0].supersedingCalls = ['call_never_issued'];
  assert.match(validateFixture(unknownCall).refused, /never issues/u);

  const badSentinel = structuredClone(base);
  badSentinel.fixture.lanes[0].markerSentinels = ['NOT-IN-THE-CALL'];
  assert.match(validateFixture(badSentinel).refused, /not part of its unit call/u);
});

/* ------------------------------------------------------------------ the lane verdict */

function synthetic() {
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-X', name: 'read' }] } },
      { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_s', name: 'read' }] } },
    ],
  };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-SENTINEL', bytes: 200000 }],
    lanes: [{
      name: 'synthetic', unitCalls: ['call_u_RS-X'], supersedingCalls: ['call_s'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-X'],
    }],
  };
  const unit = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_u_RS-X', function: { name: 'read' } }],
  };
  // The unit's own result: above the product bar, because the bar is a fact
  // about this result, not about the request's total.
  const unitResult = {
    role: 'tool', tool_call_id: 'call_u_RS-X',
    content: `FILE-SENTINEL ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}`,
  };
  // The surviving twin: its call id and its file sentinel are both on the wire,
  // and both must be present in every request measured after the removal.
  const twin = {
    role: 'tool',
    tool_call_id: 'call_s',
    content: 'FILE-SENTINEL still here',
  };
  const receipt = {
    role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:rrr',
  };
  const ledger = {
    recallIds: ['recall:sha256:rrr'],
    recallParts: [{ recallId: 'recall:sha256:rrr', sourceNodeId: 'oc:ses:tool:call_u_RS-X' }],
    removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:sha256:rrr' }],
  };
  /** The tool name each scripted call was issued under, as the wire carries it. */
  const callNames = new Map();
  for (const entry of script.replies) {
    for (const call of entry.reply?.calls ?? []) callNames.set(call.id, call.name);
  }
  /**
   * One captured request row. A real host posts an assistant message declaring
   * every tool call before its result, with the function name; the lane's
   * sentinel count reads that name to tell a read result from a write's echo, so
   * this helper adds the declaration a hand-built body would otherwise omit.
   */
  const row = (seq, turn, messages, receiptCount, recallIds) => {
    const declared = new Set(messages.flatMap((message) => (message.tool_calls ?? [])
      .map((call) => call.id)));
    const missing = messages
      .filter((message) => typeof message.tool_call_id === 'string'
        && !declared.has(message.tool_call_id))
      .map((message) => message.tool_call_id);
    const withDeclarations = missing.length === 0 ? messages : [
      {
        role: 'assistant',
        content: null,
        tool_calls: missing.map((id) => ({
          id, function: { name: callNames.get(id) ?? 'read' },
        })),
      },
      ...messages,
    ];
    return {
      seq, main_turn: turn, messages: withDeclarations,
      receipt_messages: receiptCount, receipt_recall_ids: recallIds,
      tool_results_bytes: 60_000,
    };
  };
  return { script, fixture, lane: fixture.lanes[0], ledger, unit, unitResult, twin, receipt, row };
}

test('removal lane: the body decides, and a fully re-applied removal is cumulative', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.positiveControl, true, 'the unit is present before the superseder lands');
  assert.equal(verdict.filePositiveControl, true, 'the oversized bytes reached the wire');
  assert.equal(verdict.bodies.pass, true, verdict.bodies.statement);
  assert.equal(verdict.cumulative, true);
  assert.equal(verdict.firstReceiptComplete, true);
  assert.equal(verdict.measuredWindow.pass, true, JSON.stringify(verdict.measuredWindow));
  assert.equal(verdict.removalMeasured, true);
  assert.deepEqual(verdict.ledgerRecallIds, ['recall:sha256:rrr']);
  assert.equal(recallWireCrossCheck(ledger, mains).pass, true);
});

test('removal lane: a re-keyed removed call keeps the file bytes, and the sentinel count fails it', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The re-key hole for a superseded lane, which has no content marker: the host
  // drops the removed call id but keeps its result under a new id. The body scan
  // sees the old id gone and the twin present, so it would call this a clean
  // removal. The byte count sees two tool-result messages carrying the file
  // sentinel and names the second.
  const rekeyedResult = {
    role: 'tool', tool_call_id: 'call_u_rekeyed', content: unitResult.content,
  };
  const broken = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [rekeyedResult, twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [rekeyedResult, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, broken);
  assert.equal(verdict.bodies.pass, true,
    'the removed call id is gone and the twin is present, so id-only checks pass');
  assert.equal(verdict.sentinelResults.pass, false);
  assert.match(verdict.sentinelResults.failures[0].why, /2 read-side result message\(s\)/u);
  assert.match(verdict.sentinelResults.failures[0].why, /re-keyed removed result/u);
  assert.equal(verdict.removalMeasured, false, 'the byte-level half is part of the lane verdict');
  // The same rows without the re-keyed copy pass, so the failure is the second
  // result message and nothing else.
  const restored = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(restored.sentinelResults.pass, true, JSON.stringify(restored.sentinelResults));
  assert.equal(restored.removalMeasured, true);
});

test('removal lane: a re-keyed result under the script\'s own write id is counted (P2)', () => {
  // The shipped fixture issues `call_stale_write` as a write from a later main
  // turn. A removed result re-keyed to that id arrives beside the write's own
  // echo: two results under one call id. Excluding both because the script
  // issued the id as a non-read tool keeps the count at one and hides the copy.
  const script = { replies: [
    { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-X', name: 'read' }] } },
    { match: { main_turn: 1 }, reply: { calls: [
      { id: 'call_w', name: 'write' },
      { id: 'call_s', name: 'read' },
    ] } },
  ] };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-SENTINEL', bytes: 200000 }],
    lanes: [{
      name: 'synthetic', unitCalls: ['call_u_RS-X'], supersedingCalls: ['call_s'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-X'],
    }],
  };
  const unit = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_u_RS-X', function: { name: 'read' } }],
  };
  const unitResult = {
    role: 'tool', tool_call_id: 'call_u_RS-X',
    content: `FILE-SENTINEL ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}`,
  };
  const writeDeclarations = {
    role: 'assistant', content: null,
    tool_calls: [
      { id: 'call_w', function: { name: 'write' } },
      { id: 'call_s', function: { name: 'read' } },
    ],
  };
  const writeEcho = {
    role: 'tool', tool_call_id: 'call_w', content: 'FILE-SENTINEL what the write wrote',
  };
  const rekeyed = {
    role: 'tool', tool_call_id: 'call_w', content: unitResult.content,
  };
  const twin = { role: 'tool', tool_call_id: 'call_s', content: 'FILE-SENTINEL still here' };
  const receipt = {
    role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:rrr',
  };
  const ledger = {
    recallIds: ['recall:sha256:rrr'],
    recallParts: [{ recallId: 'recall:sha256:rrr', sourceNodeId: 'oc:ses:tool:call_u_RS-X' }],
    removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:sha256:rrr' }],
  };
  const rowOf = (seq, turn, messages, receiptCount, recallIds) => ({
    seq, main_turn: turn, messages,
    receipt_messages: receiptCount, receipt_recall_ids: recallIds, tool_results_bytes: 60_000,
  });
  const broken = [
    rowOf(1, 0, [unit], 0, []),
    rowOf(2, 1, [unit, unitResult], 0, []),
    rowOf(3, 2, [writeDeclarations, writeEcho, rekeyed, twin, receipt], 1, ['recall:sha256:rrr']),
    rowOf(4, 3, [writeDeclarations, writeEcho, rekeyed, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, broken);
  assert.equal(verdict.bodies.pass, true,
    'the removed call id is gone and the twin is present, so id-only checks pass');
  assert.equal(verdict.sentinelResults.pass, false);
  assert.match(verdict.sentinelResults.failures[0].why, /2 read-side result message\(s\)/u);
  assert.match(verdict.sentinelResults.failures[0].why, /call_w/u);
  assert.equal(verdict.removalMeasured, false);
  // The same rows with the write's own echo only pass: the exclusion still
  // serves the legitimate echo, so the fix does not fail a clean removal.
  const restored = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, [
    rowOf(1, 0, [unit], 0, []),
    rowOf(2, 1, [unit, unitResult], 0, []),
    rowOf(3, 2, [writeDeclarations, writeEcho, twin, receipt], 1, ['recall:sha256:rrr']),
    rowOf(4, 3, [writeDeclarations, writeEcho, twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(restored.sentinelResults.pass, true, JSON.stringify(restored.sentinelResults));
  assert.equal(restored.removalMeasured, true);
});

test('control lane: the unit\'s call id alone is not its result, and every request is checked', () => {
  const script = { replies: [
    { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-X', name: 'read' }] } },
    { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_s', name: 'read' }] } },
  ] };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-SENTINEL', bytes: 200000 }],
    lanes: [{
      name: 'synthetic', unitCalls: ['call_u_RS-X'], supersedingCalls: ['call_s'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-X'],
    }],
  };
  const unit = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_u_RS-X', function: { name: 'read' } }],
  };
  const unitResult = {
    role: 'tool', tool_call_id: 'call_u_RS-X', content: 'FILE-SENTINEL the unit result',
  };
  const twinDeclaration = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_s', function: { name: 'read' } }],
  };
  const twin = { role: 'tool', tool_call_id: 'call_s', content: 'FILE-SENTINEL the twin result' };
  const rowOf = (seq, turn, messages) => ({ seq, main_turn: turn, messages });
  const passing = controlLaneVerdicts(fixture, script, [
    rowOf(1, 0, [unit]),
    rowOf(2, 1, [unit, unitResult]),
    rowOf(3, 2, [unit, unitResult, twinDeclaration, twin]),
    rowOf(4, 3, [unit, unitResult, twinDeclaration, twin]),
  ]);
  assert.equal(passing[0].pass, true, passing[0].statement);

  // The vanilla host kept the unit's call id in an assistant message but never
  // sent the unit's tool result. The old control read `carriesRemoved`, which
  // one marker satisfies, and checked only the last request; both now fail.
  const unitResultAbsent = controlLaneVerdicts(fixture, script, [
    rowOf(1, 0, [unit]),
    rowOf(2, 1, [unit, unitResult]),
    rowOf(3, 2, [unit, unitResult, twinDeclaration, twin]),
    rowOf(4, 3, [unit, twinDeclaration, twin]),
  ]);
  assert.equal(unitResultAbsent[0].pass, false);
  assert.deepEqual(unitResultAbsent[0].unitMissing, [4],
    'the call id is not the result');
  assert.match(unitResultAbsent[0].statement, /unit is missing from request\(s\) 4/u);

  // A middle request that lost the result and a later one that re-added it also
  // fails: every request in the scope is checked, not just the last.
  const middleDrop = controlLaneVerdicts(fixture, script, [
    rowOf(1, 0, [unit]),
    rowOf(2, 1, [unit, unitResult]),
    rowOf(3, 2, [unit, twinDeclaration, twin]),
    rowOf(4, 3, [unit, unitResult, twinDeclaration, twin]),
  ]);
  assert.equal(middleDrop[0].pass, false);
  assert.deepEqual(middleDrop[0].unitMissing, [3]);
  // An empty scope is a failure, never a vacuous pass.
  const empty = controlLaneVerdicts(fixture, script, []);
  assert.equal(empty[0].pass, false);
  assert.match(empty[0].statement, /no main request is at or after/u);
});

test('seeded removal: a content marker outside the reader head is not used (P10)', () => {
  // The host sends a produced result's head only (2,000 lines or 50 KiB). A
  // marker beyond that head is absent from the wire whether or not the removal
  // happened, so it cannot prove anything. The unique text here is past the
  // byte cap; the other call shares the whole head.
  const sharedHead = 'shared-head-line '.repeat(4000);
  const ownPastBytes = `${sharedHead}\nUNIQUE-TAIL-MARKER-9d3f`;
  const pastBytes = { perCall: {
    call_removed: { resultStrings: [ownPastBytes] },
    call_other: { resultStrings: [sharedHead] },
  } };
  assert.equal(sourceRemovalMarker(pastBytes, ['call_removed']), null,
    'the only unique text is beyond the 50 KiB head');
  // A unique marker inside the head is used.
  const inHead = `UNIQUE-HEAD-MARKER-2a7c\n${'filler\n'.repeat(128)}`;
  assert.match(sourceRemovalMarker({ perCall: {
    call_removed: { resultStrings: [inHead] },
  } }, ['call_removed']), /UNIQUE-HEAD-MARKER-2a7c/u);
  // The line cap is part of the head: line 2,100 is never sent even though the
  // result is under 50 KiB.
  const lines = Array.from({ length: 2100 }, (_, index) => (index === 2099
    ? 'UNIQUE-LINE-2100-MARKER-6b1e' : 'filler line'));
  const pastLines = { perCall: {
    call_removed: { resultStrings: [lines.join('\n')] },
    call_other: { resultStrings: [lines.slice(0, 2000).join('\n')] },
  } };
  assert.equal(sourceRemovalMarker(pastLines, ['call_removed']), null,
    'the only unique text is on a line past the 2,000-line head');
  assert.equal(readerHeadText(lines.join('\n')).includes('UNIQUE-LINE-2100-MARKER-6b1e'),
    false);
});

test('removal lane: a receipt line carrying the removed call id fails the removed-content half', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The product's own line is excluded from the removed-byte scan because its
  // target names the unit it replaced. That exclusion must not be a hole: a
  // call id planted inside the line is the removed unit still on the wire.
  const leaking = {
    role: 'user',
    content: '[not retained] big.txt · necromancy recall:sha256:rrr call_u_RS-X',
  };
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, leaking], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, leaking], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(verdict.bodies.pass, false);
  assert.match(verdict.bodies.statement, /call_u_RS-X/u);
  assert.equal(verdict.removalMeasured, false);
  // The same requests with the product's plain receipt line pass, so the
  // failure is the marker inside the allowed line.
  const clean = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(clean.bodies.pass, true, clean.bodies.statement);
});

test('removal lane: a twin-missing request fails even when the unit is absent', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The host dropped the tail: the removed unit is gone and so is its twin. The
  // old rule read this as a clean removal; the twin half must name the failure.
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.bodies.pass, false);
  assert.match(verdict.bodies.statement, /surviving twin is absent/u);
  assert.match(verdict.bodies.statement, /call_s/u);
  assert.match(verdict.bodies.statement, /FILE-SENTINEL/u);
  assert.equal(verdict.measuredWindow.pass, false, 'a lost twin makes the lane unmeasured');
  assert.equal(verdict.removalMeasured, false);
  // The same fixture with the twin restored passes, so the failure is the twin.
  const restored = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(restored.bodies.pass, true, restored.bodies.statement);
});

test('removal lane: a receipt on a request that still carries the unit is not a removal', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [unit, twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [unit, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.bodies.pass, false);
  assert.equal(verdict.cumulative, false);
  assert.match(verdict.bodies.statement, /removed bytes are still in every request body/u);
  const cross = recallWireCrossCheck(ledger, mains);
  assert.equal(cross.pass, false);
  assert.equal(cross.uncovered.length, 1);
});

test('removal lane: a later request with no receipt is not cumulative', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin], 0, []),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.bodies.pass, true, 'the bytes are absent and the twin survives');
  assert.equal(verdict.cumulative, false, 'without the receipt the removal was not re-applied');
});

test('removal lane: receipts may grow as later units leave', () => {
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [
        { id: 'call_a1_RS-A', name: 'read' },
        { id: 'call_b1_RS-B', name: 'read' },
      ] } },
      { match: { main_turn: 1 }, reply: { calls: [
        { id: 'call_a2', name: 'read' },
        { id: 'call_b2', name: 'read' },
      ] } },
    ],
  };
  const fixture = {
    files: [
      { name: 'a.txt', sentinel: 'FILE-A', bytes: 200000 },
      { name: 'b.txt', sentinel: 'FILE-B', bytes: 200000 },
    ],
    lanes: [{
      name: 'two-pass',
      rule: 'superseded-read',
      unitCalls: ['call_a1_RS-A', 'call_b1_RS-B'],
      supersedingCalls: ['call_a2', 'call_b2'],
      unitFiles: ['a.txt', 'b.txt'],
      markerSentinels: ['RS-A', 'RS-B'],
    }],
  };
  const ledger = {
    recallIds: ['recall:sha256:a', 'recall:sha256:b'],
    recallParts: [
      { recallId: 'recall:sha256:a', sourceNodeId: 'oc:ses:tool:call_a1_RS-A' },
      { recallId: 'recall:sha256:b', sourceNodeId: 'oc:ses:tool:call_b1_RS-B' },
    ],
    removalRules: [
      { ruleId: 'superseded-read', recallId: 'recall:sha256:a' },
      { ruleId: 'superseded-read', recallId: 'recall:sha256:b' },
    ],
  };
  const twinA = { role: 'tool', tool_call_id: 'call_a2', content: 'FILE-A still here' };
  const twinB = { role: 'tool', tool_call_id: 'call_b2', content: 'FILE-B still here' };
  const unitResultA = { role: 'tool', tool_call_id: 'call_a1_RS-A',
    content: `FILE-A ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const unitResultB = { role: 'tool', tool_call_id: 'call_b1_RS-B',
    content: `FILE-B ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const receiptA = { role: 'user', content: '[not retained] a · necromancy recall:sha256:a' };
  const receiptB = { role: 'user', content: '[not retained] b · necromancy recall:sha256:b' };
  const row = (seq, turn, messages, ids) => ({
    seq, main_turn: turn, messages,
    receipt_messages: ids.length, receipt_recall_ids: ids,
    tool_results_bytes: 60_000,
  });
  // Unit A leaves on request 3; unit B is still there. Unit B leaves on request
  // 4. The first receipt set is smaller than the final one, which the old
  // all-on-the-first-request rule called a failure.
  const mains = [
    row(1, 0, [{ role: 'assistant', tool_calls: [
      { id: 'call_a1_RS-A' }, { id: 'call_b1_RS-B' },
    ] }], []),
    row(2, 1, [{ role: 'assistant', tool_calls: [
      { id: 'call_a1_RS-A' }, { id: 'call_b1_RS-B' },
    ] }, unitResultA, unitResultB], []),
    row(3, 2, [
      { role: 'tool', tool_call_id: 'call_b1_RS-B', content: 'B body' },
      twinA, twinB, receiptA,
    ], ['recall:sha256:a']),
    row(4, 3, [twinA, twinB, receiptA, receiptB],
      ['recall:sha256:a', 'recall:sha256:b']),
  ];
  const verdict = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, mains);
  assert.equal(verdict.bodies.pass, true, verdict.bodies.statement);
  assert.equal(verdict.cumulative, true, 'each unit is covered from its own first removal');
  assert.equal(verdict.firstReceiptComplete, true);
  assert.equal(verdict.removalMeasured, true);
  // The lane's byte rows start each unit at its own proof request.
  assert.deepEqual(verdict.byteDelta.perUnit.map((unit) => unit.mainTurn), [2, 3]);
});

/* ------------------------------------------------------------------ journal and redirect */

test('journal: applied, commit, refusal and error lines are summarised by name', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'journal.jsonl');
    const records = [
      { kind: 'mounted', atMs: 1 },
      { kind: 'at-rest', atMs: 2, eventId: 'e1', reason: 'step', status: 'applied', intentId: 'i1' },
      { kind: 'commit', atMs: 3, eventId: 'e1', committed: true },
      { kind: 'telemetry', atMs: 3, event: { kind: 'application', intentId: 'i1',
        outcome: 'applied', removedBytes: 100, generatedBytes: 10, recallIds: ['r1'] } },
      { kind: 'at-rest', atMs: 4, eventId: 'e2', reason: 'step', status: 'rejected', intentId: null },
      { kind: 'at-rest', atMs: 5, eventId: 'e3', reason: 'step', status: 'disabled', intentId: null },
      { kind: 'transform-error', atMs: 6, message: 'bad' },
      { kind: 'compacted', atMs: 7, phase: 'started' },
      { kind: 'storage-unavailable', atMs: 8, code: 'relative-root' },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const summary = readJournal(path);
    assert.equal(summary.available, true);
    assert.equal(summary.records, records.length);
    assert.equal(summary.unreadable.length, 0);
    assert.deepEqual(summary.appliedIntentIds, ['i1']);
    assert.deepEqual(summary.applications, [{
      intentId: 'i1', outcome: 'applied', removedBytes: 100, generatedBytes: 10, recallIds: ['r1'],
    }]);
    assert.equal(summary.commits.filter((row) => row.committed).length, 1);
    assert.equal(summary.rejected.length, 1);
    assert.equal(summary.disabled.length, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.compacted.length, 1);
    assert.equal(summary.storageUnavailable.length, 1);
    assert.equal(readJournal(join(dir, 'missing.jsonl')).available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One receipt message per recall id, all naming the pass that wrote them. */
function passReceipts(recallIds, passId) {
  return recallIds.map((recallId, at) => ({
    id: opencodeReceiptEntryId(passId, at),
    role: 'user',
    content: receiptLineText('big.txt', recallId, '', '', passId),
    racoonsRecordId: opencodeReceiptEntryId(passId, at),
  }));
}

test('journal: each receipt-bearing request pairs with its own applied pass, in order', () => {
  const summary = {
    applications: [
      { intentId: 'i1', outcome: 'applied', removedBytes: 1, generatedBytes: 1, recallIds: ['r1'] },
      { intentId: 'i2', outcome: 'applied', removedBytes: 2, generatedBytes: 1, recallIds: ['r1'] },
      { intentId: 'i3', outcome: 'applied', removedBytes: 3, generatedBytes: 1, recallIds: ['r1', 'r2'] },
    ],
    atRest: [
      { eventId: 'e0', reason: 'step', status: 'unchanged', intentId: null },
      { eventId: 'e1', reason: 'step', status: 'applied', intentId: 'i1' },
      { eventId: 'e2', reason: 'step', status: 'applied', intentId: 'i2' },
      { eventId: 'e3', reason: 'step', status: 'applied', intentId: 'i3' },
    ],
  };
  const mains = [
    { seq: 1, main_turn: 0, receipt_recall_ids: [] },
    { seq: 2, main_turn: 1, messages: passReceipts(['r1'], 'i1'), receipt_recall_ids: ['r1'] },
    { seq: 3, main_turn: 2, messages: passReceipts(['r1'], 'i2'), receipt_recall_ids: ['r1'] },
    { seq: 4, main_turn: 3, messages: passReceipts(['r1', 'r2'], 'i3'),
      receipt_recall_ids: ['r1', 'r2'] },
  ];
  const pass = perRequestReapplication(summary, mains);
  assert.equal(pass.pass, true, pass.detail);
  assert.deepEqual(pass.rows.map((row) => [row.seq, row.passIndex, row.matched]), [
    [2, 1, true], [3, 2, true], [4, 3, true],
  ]);
  // A stale receipt: request 5 carries only i3's r1, but pass 3 applied r1 and r2.
  const stale = perRequestReapplication(summary, [
    mains[0], mains[1], mains[2],
    { seq: 5, main_turn: 4, messages: passReceipts(['r1'], 'i3'), receipt_recall_ids: ['r1'] },
  ]);
  assert.equal(stale.pass, false);
  assert.match(stale.detail, /no receipt of that pass covers it/u);
  // A receipt naming a pass this journal did not apply: i2 has no pass left.
  const reused = perRequestReapplication({
    ...summary,
    applications: summary.applications.slice(0, 1),
    atRest: summary.atRest.slice(0, 2),
  }, [mains[1], mains[2]]);
  assert.equal(reused.pass, false);
  assert.match(reused.detail, /which this run did not apply/u);
  // An applied pass with no request that carried its receipt.
  const orphaned = perRequestReapplication(summary, [mains[1]]);
  assert.equal(orphaned.pass, false);
  assert.match(orphaned.detail, /had no request that carried their receipt/u);
});

test('journal: a receipt the seeded session already carried is not this run\'s pass', () => {
  const summary = {
    applications: [
      { intentId: 'i1', outcome: 'applied', removedBytes: 1, generatedBytes: 1, recallIds: ['r1'] },
      { intentId: 'i2', outcome: 'applied', removedBytes: 2, generatedBytes: 1, recallIds: ['r1'] },
      { intentId: 'i3', outcome: 'applied', removedBytes: 3, generatedBytes: 1, recallIds: ['r1', 'r2'] },
    ],
    atRest: [
      { eventId: 'e1', reason: 'step', status: 'applied', intentId: 'i1' },
      { eventId: 'e2', reason: 'step', status: 'applied', intentId: 'i2' },
      { eventId: 'e3', reason: 'step', status: 'applied', intentId: 'i3' },
    ],
  };
  const seeded = 'recall:sha256:from-the-source-session';
  /**
   * The seeded receipt names the source session's pass (`i0`), which this
   * journal never applied. Its only id is seeded, so it is the source session's
   * receipt and must not be paired with this run's pass order.
   */
  const seededReceipt = passReceipts([seeded], 'i0');
  const mains = [
    { seq: 1, main_turn: 0, messages: seededReceipt, receipt_recall_ids: [seeded] },
    { seq: 2, main_turn: 1, messages: [...seededReceipt, ...passReceipts(['r1'], 'i1')],
      receipt_recall_ids: [seeded, 'r1'] },
    { seq: 3, main_turn: 2, messages: [...seededReceipt, ...passReceipts(['r1'], 'i2')],
      receipt_recall_ids: [seeded, 'r1'] },
    { seq: 4, main_turn: 3, messages: [...seededReceipt, ...passReceipts(['r1', 'r2'], 'i3')],
      receipt_recall_ids: [seeded, 'r1', 'r2'] },
  ];
  // Without the exclusion request 1 carries a receipt for `i0`, a pass this run
  // never applied: the stale receipt failure P6 reports. With it, the seeded id
  // is not this run's receipt and the source's pass is not paired.
  assert.equal(perRequestReapplication(summary, mains).pass, false);
  const pass = perRequestReapplication(summary, mains, { seededRecallIds: [seeded] });
  assert.equal(pass.pass, true, pass.detail);
  assert.deepEqual(pass.seededRecallIds, [seeded]);
  assert.deepEqual(pass.rows.map((row) => [row.seq, row.matched]), [[2, true], [3, true], [4, true]]);
});

test('byte delta: the unit bytes are the call entry plus the tool message', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_u', type: 'function', function: { name: 'read' } }] },
    { role: 'tool', tool_call_id: 'call_u', content: 'BODY' },
    { role: 'tool', tool_call_id: 'call_other', content: 'OTHER' },
  ];
  const measured = unitWireBytes(messages, 'call_u');
  assert.equal(measured.parts, 2);
  assert.equal(measured.bytes,
    messageJsonBytes(messages[0].tool_calls[0]) + messageJsonBytes(messages[1]));
  assert.ok(measured.bytes > Buffer.byteLength('BODY'));
  assert.deepEqual(unitWireBytes(messages, 'call_missing'), { bytes: 0, parts: 0 });
});

test('source fingerprint: the WAL is hashed and every field is compared', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'source.db');
    writeFileSync(path, 'db bytes');
    writeFileSync(`${path}-wal`, 'wal bytes');
    const before = databaseFingerprint(path);
    assert.equal(before.sha256Of, 'database-file');
    assert.equal(before.wal.exists, true);
    assert.equal(before.wal.sha256Of, 'write-ahead-log');
    assert.equal(before.wal.sha256,
      createHash('sha256').update('wal bytes').digest('hex'));
    assert.deepEqual(fingerprintChanges(before, databaseFingerprint(path)), []);
    writeFileSync(`${path}-wal`, 'wal bytes changed');
    // Pin a later mtime: two writes inside the same clock tick would leave
    // `mtimeMs` unchanged and make the field list depend on timer resolution.
    utimesSync(`${path}-wal`, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    assert.deepEqual(fingerprintChanges(before, databaseFingerprint(path))
      .map((change) => change.field), ['wal.sizeBytes', 'wal.mtimeIso', 'wal.sha256']);
    assert.match(fingerprintChanges(before, databaseFingerprint(path))[2].field, /wal\.sha256/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removal checks: a stale-read-only fixture is a removal measurement', () => {
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-S', name: 'read' }] } },
      { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_w', name: 'write' }] } },
      { match: { main_turn: 2 }, reply: { calls: [{ id: 'call_t', name: 'read' }] } },
    ],
  };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-S', bytes: 200000 }],
    lanes: [{
      name: 'stale', rule: 'stale-read',
      unitCalls: ['call_u_RS-S'], triggerCalls: ['call_w'], supersedingCalls: ['call_t'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-S'],
    }],
  };
  const ledger = {
    recallIds: ['recall:sha256:s'],
    recallParts: [{ recallId: 'recall:sha256:s', sourceNodeId: 'oc:ses:tool:call_u_RS-S' }],
    removalRules: [{ ruleId: 'stale-read', recallId: 'recall:sha256:s' }],
  };
  const unit = { role: 'assistant', tool_calls: [{ id: 'call_u_RS-S' }] };
  const unitResult = { role: 'tool', tool_call_id: 'call_u_RS-S',
    content: `FILE-S ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const receipt = { role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:s' };
  const twin = { role: 'tool', tool_call_id: 'call_t', content: 'FILE-S still here' };
  const row = (seq, turn, messages, ids) => ({
    seq, main_turn: turn, messages,
    receipt_messages: ids.length, receipt_recall_ids: ids,
    tool_results_bytes: 60_000,
  });
  const mains = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [receipt], ['recall:sha256:s']),
    row(4, 3, [twin, receipt], ['recall:sha256:s']),
    row(5, 4, [twin, receipt], ['recall:sha256:s']),
  ];
  const checks = removalChecks({
    arm: 'test', fixture, script, ledger, mains, capture: true,
    restore: restorePass(ledger.recallIds),
    journal: {
      available: true,
      atRest: [{ reason: 'step', status: 'applied', intentId: 'i1' }],
      applications: [{ intentId: 'i1', recallIds: ['recall:sha256:s'], removedBytes: 1,
        generatedBytes: 1 }],
    },
  });
  assert.equal(checks.claimed, true);
  assert.equal(checks.lanes[0].rule, 'stale-read');
  assert.equal(checks.lanes[0].declaredRuleMeasured, true);
  assert.equal(checks.lanes[0].removalMeasured, true);
  assert.equal(checks.lanesMeasured, true);
  assert.equal(checks.journalApplied, true);
  assert.equal(checks.removalMeasured, true);
  // The same lane with no ledger removal (the rule never fired) is not a
  // measurement, and the run may not be cited as one.
  const unfired = removalChecks({
    arm: 'test', fixture, script, capture: true,
    ledger: { recallIds: [], recallParts: [], removalRules: [] },
    mains,
  });
  assert.equal(unfired.claimed, true);
  assert.equal(unfired.lanes[0].declaredRuleMeasured, false);
  assert.equal(unfired.lanes[0].removalMeasured, false);
  assert.equal(unfired.removalMeasured, false);
});

test('removal checks: a replay that produced no removal is not a measurement', () => {
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-R', bytes: 200000 }],
    lanes: [{
      name: 'replay', rule: 'superseded-read', unitCalls: ['call_u_RS-R'],
      supersedingCalls: ['call_s'], unitFiles: ['big.txt'], markerSentinels: ['RS-R'],
    }],
  };
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-R', name: 'read' }] } },
      { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_s', name: 'read' }] } },
    ],
  };
  const mains = [{
    seq: 1, main_turn: 0,
    messages: [{ role: 'assistant', tool_calls: [{ id: 'call_u_RS-R' }] }],
    receipt_recall_ids: [],
  }];
  const checks = removalChecks({
    arm: 'test', fixture, script, capture: true,
    ledger: { recallIds: [], recallParts: [], removalRules: [] }, mains,
  });
  assert.equal(checks.claimed, true, 'the fixture is a claim');
  assert.equal(checks.removalMeasured, false, 'no removal was measured');
});

test('removal checks: a single-unit lane with no journal is not a run-level removal measurement', () => {
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-N', bytes: 200000 }],
    lanes: [{
      name: 'single-no-journal', rule: 'stale-read',
      unitCalls: ['call_u_RS-N'], triggerCalls: ['call_w'], supersedingCalls: ['call_t'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-N'],
    }],
  };
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-N', name: 'read' }] } },
      { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_w', name: 'write' }] } },
      { match: { main_turn: 2 }, reply: { calls: [{ id: 'call_t', name: 'read' }] } },
    ],
  };
  const ledger = {
    recallIds: ['recall:sha256:n'],
    recallParts: [{ recallId: 'recall:sha256:n', sourceNodeId: 'oc:ses:tool:call_u_RS-N' }],
    removalRules: [{ ruleId: 'stale-read', recallId: 'recall:sha256:n' }],
  };
  const unit = { role: 'assistant', tool_calls: [{ id: 'call_u_RS-N' }] };
  const unitResult = { role: 'tool', tool_call_id: 'call_u_RS-N',
    content: `FILE-N ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const twin = { role: 'tool', tool_call_id: 'call_t', content: 'FILE-N still here' };
  const receipt = { role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:n' };
  const row = (seq, turn, messages, ids) => ({
    seq, main_turn: turn, messages, receipt_messages: ids.length, receipt_recall_ids: ids,
    tool_results_bytes: 60_000,
  });
  const mains = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [twin, receipt], ['recall:sha256:n']),
    row(4, 3, [twin, receipt], ['recall:sha256:n']),
  ];
  // The lane passes every check it can make on its own. A single-unit lane has
  // no multi-unit claim (`oneRecallPerUnit` is null, never a vacuous true).
  const noJournal = removalChecks({
    arm: 'test', fixture, script, ledger, mains, capture: true,
  });
  assert.equal(noJournal.lanes[0].removalMeasured, true);
  assert.equal(noJournal.lanesMeasured, true);
  assert.equal(noJournal.journalApplied, false);
  assert.equal(noJournal.removalMeasured, false,
    'a single-unit lane with no journal cannot say which at-rest pass removed the unit');
  // The same run with an applied step pass is a run-level measurement.
  const withJournal = removalChecks({
    arm: 'test', fixture, script, ledger, mains, capture: true,
    restore: restorePass(ledger.recallIds),
    journal: {
      available: true,
      atRest: [{ reason: 'step', status: 'applied', intentId: 'i1' }],
      applications: [{ intentId: 'i1', recallIds: ['recall:sha256:n'], removedBytes: 1,
        generatedBytes: 1 }],
    },
  });
  assert.equal(withJournal.journalApplied, true);
  assert.equal(withJournal.removalMeasured, true);
});

test('removal rules: both rules the ADRs declare on this adapter are measured', () => {
  assert.deepEqual([...MEASURED_REMOVAL_RULES], ['superseded-read', 'stale-read']);
  const script = loadScript();
  const checked = validateFixture(script);
  assert.equal(checked.ok, true, checked.refused);
  const laneRules = checked.fixture.lanes.map((lane) => lane.rule ?? 'superseded-read');
  for (const rule of MEASURED_REMOVAL_RULES) {
    assert.ok(laneRules.includes(rule), `the shipped fixture has a ${rule} lane`);
  }
});

test('redirect: every host data fallback points inside the world', () => {  const redirects = redirectEnv('C:\\arm\\world');
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR']) {
    assert.ok(redirects[name].startsWith('C:\\arm\\world'), `${name} is redirected`);
  }
  // The arm-world database candidates are derived from the redirect map, so a
  // session under state, cache or temp cannot hide from replayContinuation.
  const candidates = armSessionDbs('C:\\arm\\world').map((row) => row.path);
  for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    assert.ok(candidates.some((path) => path.startsWith(redirects[name])),
      `${name} has an arm-world database candidate: ${JSON.stringify(candidates)}`);
  }
});

test('redirect: a changed real data file is named, an unchanged set is empty', () => {
  const before = [
    { path: 'db', exists: true, sizeBytes: 10, mtimeMs: 1 },
    { path: 'db-wal', exists: true, sizeBytes: 4, mtimeMs: 2 },
    { path: 'db-shm', exists: false, sizeBytes: 0, mtimeMs: null },
  ];
  assert.deepEqual(realDataChanges(before, structuredClone(before)), []);
  const after = structuredClone(before);
  after[1].mtimeMs = 3;
  assert.deepEqual(realDataChanges(before, after), [
    { path: 'db-wal', why: 'mtime changed (2 -> 3)' },
  ]);
  const appeared = structuredClone(before);
  appeared[2] = { path: 'db-shm', exists: true, sizeBytes: 1, mtimeMs: 4 };
  assert.match(realDataChanges(before, appeared)[0].why, /existence changed/u);
});

test('redirect: a --replay-db source is in the real-data snapshot list', () => {
  const dir = scratch();
  try {
    const dbPath = join(dir, 'opencode.db');
    writeFileSync(dbPath, 'source');
    const snapshot = realDataSnapshot([dbPath]);
    const main = snapshot.find((row) => row.path === dbPath);
    assert.ok(main, 'the source database itself is statted');
    assert.equal(main.exists, true);
    assert.equal(main.sizeBytes, 6);
    // The WAL beside it is statted too: a WAL-mode database's committed rows
    // live there. Its `-shm` is shared memory a reader may touch, so it is not
    // a data-change witness.
    assert.ok(snapshot.some((row) => row.path === `${dbPath}-wal`));
    assert.equal(snapshot.some((row) => row.path === `${dbPath}-shm`), false);
    // A child that wrote to the source is a named change.
    writeFileSync(dbPath, 'source plus a turn');
    const changes = realDataChanges(snapshot, realDataSnapshot([dbPath]))
      .filter((row) => row.path === dbPath);
    assert.equal(changes.some((row) => row.why === 'size changed (6 -> 18)'), true,
      JSON.stringify(changes));
    assert.equal(changes.every((row) => row.path === dbPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ recall mapping */

test('recall: a node id names its call, and a recall maps through recall_parts', () => {
  assert.equal(callIdFromNodeId('oc:ses:tool:call_1'), 'call_1');
  assert.equal(callIdFromNodeId('oc:ses:msg:id'), null);
  const ledger = {
    recallParts: [
      { recallId: 'r1', sourceNodeId: 'oc:ses:tool:call_1' },
      { recallId: 'r1', sourceNodeId: 'oc:ses:tool:call_2' },
      { recallId: 'r2', sourceNodeId: 'oc:ses:msg:x' },
    ],
  };
  assert.deepEqual(recallCallIds(ledger, 'r1'), ['call_1', 'call_2']);
  assert.deepEqual(recallCallIds(ledger, 'r2'), []);
});

test('recall: a mixed recall naming a tool unit and a text part is uncovered', () => {
  const ledger = {
    recallIds: ['recall:sha256:mixed'],
    recallParts: [
      { recallId: 'recall:sha256:mixed', sourceNodeId: 'oc:ses:tool:call_m' },
      { recallId: 'recall:sha256:mixed', sourceNodeId: 'oc:ses:msg:part_text' },
    ],
  };
  const receipt = { role: 'user',
    content: '[not retained] mixed · necromancy recall:sha256:mixed' };
  const mains = [{
    seq: 1, main_turn: 0, messages: [receipt], receipt_messages: 1,
    receipt_recall_ids: ['recall:sha256:mixed'],
  }];
  // The old `recallCallIds` dropped the text part and returned only call_m, so
  // this recall was read as a covered tool removal while the text removal went
  // unmeasured. The whole recall is now uncovered.
  const coverage = recallPartCoverage(ledger, 'recall:sha256:mixed');
  assert.deepEqual(coverage.callIds, ['call_m']);
  assert.deepEqual(coverage.nonToolNodeIds, ['oc:ses:msg:part_text']);
  assert.equal(coverage.complete, false);
  const cross = recallWireCrossCheck(ledger, mains);
  assert.equal(cross.pass, false);
  assert.equal(cross.uncovered.length, 1);
  assert.match(cross.uncovered[0].why, /not a tool node/u);
  assert.match(cross.uncovered[0].why, /whole recall is uncovered/u);
  assert.deepEqual(cross.uncovered[0].nonToolNodeIds, ['oc:ses:msg:part_text']);
  // The same recall with only its tool part is covered by the same request.
  const onlyTool = { ...ledger, recallParts: ledger.recallParts.slice(0, 1) };
  assert.equal(recallWireCrossCheck(onlyTool, mains).pass, true);
});

/* ------------------------------------------------------------------ replay gating (§1) */

test('removal checks: a replay arm with a ledger recall and no fixture is cross-checked', () => {
  const ledger = {
    recallIds: ['recall:sha256:rrr'],
    recallParts: [{ recallId: 'recall:sha256:rrr', sourceNodeId: 'oc:ses:tool:call_u_RS-X' }],
  };
  const base = { arm: 'test', fixture: null, script: { replies: [] }, ledger };
  // The old gate: `claimed = arm === 'test' && fixture !== null` is false here, so
  // the cross-check was `null` and a staged recall passed unread. It must run.
  const blind = removalChecks({
    ...base,
    mains: [{ seq: 1, main_turn: 0, messages: [{ role: 'user', content: 'no receipt' }],
      receipt_recall_ids: [] }],
  });
  assert.equal(blind.claimed, false, 'a replay claims no fixture removal');
  assert.notEqual(blind.crossCheck, null, 'the cross-check runs without a fixture');
  assert.equal(blind.crossCheck.pass, false);
  assert.match(JSON.stringify(blind.crossCheck.uncovered), /no request carried its receipt/u);

  // The same replay with the receipt on the wire and the unit absent passes.
  const shown = removalChecks({
    ...base,
    mains: [{
      seq: 1,
      main_turn: 0,
      messages: [{ role: 'user',
        content: '[not retained] big.txt · necromancy recall:sha256:rrr' }],
      receipt_recall_ids: ['recall:sha256:rrr'],
    }],
  });
  assert.notEqual(shown.crossCheck, null);
  assert.equal(shown.crossCheck.pass, true);
  assert.deepEqual(shown.crossCheck.checked[0].requests, [1]);

  // A test arm with neither fixture nor ledger recall has nothing to check.
  assert.equal(removalChecks({ ...base, ledger: { recallIds: [], recallParts: [] },
    mains: [] }).crossCheck, null);
});

test('recall cross-check: a seeded removal that comes back on a later request fails the run', () => {
  const { script, fixture, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  const removedThenKept = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [unit, unitResult, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  // The earlier rule passed this: ANY request carried the receipt and lacked the
  // unit (request 3), so the reappearance on request 4 was never read.
  const cross = recallWireCrossCheck(ledger, removedThenKept);
  assert.equal(cross.pass, false);
  assert.deepEqual(cross.uncovered.map((row) => row.returned), [[4]]);
  assert.match(cross.uncovered[0].why, /came back on request\(s\) 4/u);
  assert.equal(cross.checked[0].firstRemoved, 3);
  assert.equal(cross.checked[0].returned[0], 4);

  // The audit's exact shape: request 1 removed, request 2 re-carries it.
  const twoRows = [
    row(1, 0, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(2, 1, [unit, unitResult, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const two = recallWireCrossCheck(ledger, twoRows);
  assert.equal(two.pass, false);
  assert.equal(two.checked[0].firstRemoved, 1);
  assert.deepEqual(two.checked[0].returned, [2]);

  // The same rows with request 4 still lacking the unit pass, so the failure is
  // the return and nothing else.
  const staysRemoved = removedThenKept.map((entry, index) => (index === 3
    ? row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr'])
    : entry));
  assert.equal(recallWireCrossCheck(ledger, staysRemoved).pass, true);
  assert.equal(removalChecks({
    arm: 'test', fixture, script, ledger, mains: removedThenKept, capture: true,
  }).crossCheck.pass, false);
  assert.equal(removalChecks({
    arm: 'test', fixture, script, ledger, mains: staysRemoved, capture: true,
  }).crossCheck.pass, true);
});

test('seeded removal: a re-keyed result with the old call id gone is call-id only and not citable', () => {
  // The seeded source session already removed this unit, so no captured request
  // ever carried its call declaration or its result under the old id. The host
  // re-keyed the result: the old call id is gone, the bytes are still there.
  // The call-id check cannot see that, which is why the removal is recorded as
  // call-id only and blocks a citation.
  const ledger = {
    recallIds: ['recall:sha256:seed'],
    recallParts: [{ recallId: 'recall:sha256:seed', sourceNodeId: 'oc:ses:tool:call_seed_RS' }],
    removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:sha256:seed' }],
  };
  const rekeyed = {
    role: 'tool', tool_call_id: 'call_rekeyed', content: 'SEEDED RESULT BYTES',
  };
  const receipt = { role: 'user',
    content: '[not retained] seeded.txt · necromancy recall:sha256:seed' };
  const mains = [{
    seq: 1, main_turn: 0, messages: [rekeyed, receipt], receipt_messages: 1,
    receipt_recall_ids: ['recall:sha256:seed'],
  }];
  const checks = removalChecks({
    arm: 'test', fixture: null, script: { replies: [] }, ledger, mains, capture: true,
    seededRecallIds: ['recall:sha256:seed'],
  });
  assert.notEqual(checks.crossCheck, null);
  assert.equal(checks.crossCheck.pass, true,
    'the old call id is gone, so the call-id check passes');
  assert.equal(checks.crossCheck.checked[0].seeded, true);
  assert.equal(checks.crossCheck.checked[0].removalCheck, 'call-id only');
  assert.equal(checks.seedRemoval, 'call-id only');
  assert.equal(checks.seedRemovalCallIdOnly, true);
  assert.deepEqual(checks.seedRemovals.map((row) => row.recallId), ['recall:sha256:seed']);
  // The run-level field cannot be a removal measurement without a lane, and the
  // citation is refused by the seedRemoval rule even with every check green.
  assert.equal(checks.removalMeasured, false);
  const verdict = citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: false,
    removalMeasured: false, claim: 'reasoning', seedRemovalCallIdOnly: true, assertions: [],
  });
  assert.equal(verdict.citable, false);
  assert.match(verdict.citableBlockedBy.join(' '), /call id only/u);
  // The same rows without the seeded flag are not a seeded removal: the ledger
  // still holds no fixture lane, so the run claims no removal either way.
  const unseeded = removalChecks({
    arm: 'test', fixture: null, script: { replies: [] }, ledger, mains, capture: true,
  });
  assert.equal(unseeded.crossCheck.checked[0].seeded, false);
  assert.equal(unseeded.seedRemoval, 'none');
});

test('seeded removal: a unit the mount removes on request 3 is byte-checked from the source (P3)', () => {
  // A vanilla source session carries no receipt for this unit, so the old
  // receipt-keyed flag called it unseeded and checked only the old call id. The
  // unit's bytes were still in the source (`sourceContent.perCall`), so the
  // seeded rule applies: its own content marker must be gone from every request
  // from the removal onward.
  const removedText = 'SEEDED-REMOVED-RESULT-BYTES that no other source call carries';
  const twinText = 'TWIN-BYTES: the later read of the same file';
  const sourceContent = {
    strings: ['the seeded user text', removedText, twinText],
    counts: { textParts: 1, toolResults: 2, toolCallInputs: 0 },
    perCall: {
      call_seed_unit: { inputStrings: [], resultStrings: [removedText] },
      call_twin: { inputStrings: [], resultStrings: [twinText] },
    },
  };
  const ledger = {
    recallIds: ['recall:sha256:seed'],
    recallParts: [{ recallId: 'recall:sha256:seed',
      sourceNodeId: 'oc:ses:tool:call_seed_unit' }],
    removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:sha256:seed' }],
  };
  const receipt = {
    role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:seed',
  };
  const removed = { role: 'tool', tool_call_id: 'call_seed_unit', content: removedText };
  const twin = { role: 'tool', tool_call_id: 'call_twin', content: twinText };
  const seededText = { role: 'user', content: 'the seeded user text' };
  const task = 'the run task';
  const row = (seq, messages, receipted) => ({
    seq, main_turn: seq - 1, messages,
    receipt_messages: receipted ? 1 : 0,
    receipt_recall_ids: receipted ? ['recall:sha256:seed'] : [],
  });
  const mains = [
    row(1, [seededText, { role: 'user', content: task }, removed, twin], false),
    row(2, [seededText, { role: 'user', content: task }, removed, twin], false),
    row(3, [seededText, { role: 'user', content: task }, receipt, twin], true),
    row(4, [seededText, { role: 'user', content: task }, receipt, twin], true),
  ];
  // The old flag: no receipt in the source, so not seeded.
  const cross = recallWireCrossCheck(ledger, mains, { seededRecallIds: [] });
  assert.equal(cross.checked[0].seeded, false, 'the receipt-only rule misses this unit');
  // The fixed flag keys on the source's units and byte-checks the result.
  const withSource = recallWireCrossCheck(ledger, mains, { sourceContent });
  assert.equal(withSource.pass, true, JSON.stringify(withSource.uncovered));
  assert.equal(withSource.checked[0].seeded, true);
  assert.equal(withSource.checked[0].seededBy, 'source-unit');
  assert.equal(withSource.checked[0].contentMarkerChecked, true);
  assert.equal(withSource.checked[0].removalCheck, 'call-id-and-content-marker');
  assert.deepEqual(withSource.checked[0].markerPresentAt, []);
  const checks = removalChecks({
    arm: 'test', fixture: null, script: { replies: [] }, ledger, mains, capture: true,
    seededRecallIds: [], sourceContent,
  });
  assert.equal(checks.seedRemoval, 'none');
  assert.equal(checks.seedRemovalCallIdOnly, false);
  assert.deepEqual(checks.markerCheckedRecallIds, ['recall:sha256:seed']);

  // The removal allowance is per request. Request 3 and 4 carry the receipt for
  // the removed unit; requests 1 and 2 do not, so they still require its bytes.
  const strings = sourceContent.strings;
  const everywhere = seededContentEverywhere(mains, strings, task, {
    removedForRow: (entry) => removedSeededContentForRequest(entry, ledger, sourceContent),
  });
  assert.equal(everywhere.pass, true, everywhere.detail);
  assert.deepEqual(everywhere.perRequest.map((entry) => entry.removed), [0, 0, 1, 1]);
  // The old single allowance was request 1's (empty), so request 3 failed on a
  // correct removal and request 4 was never reached.
  const appliedEverywhere = seededContentEverywhere(mains, strings, task, {
    removed: removedSeededContentForRequest(mains[0], ledger, sourceContent),
  });
  assert.equal(appliedEverywhere.pass, false);
  assert.deepEqual(appliedEverywhere.failures.map((entry) => entry.seq), [3, 4]);
});

test('seeded removal: a re-keyed request-1 removal that reappears later fails the content marker (P3)', () => {
  const removedText = 'RE-KEYED-RESULT-BYTES unique to the removed read';
  const twinText = 'TWIN-BYTES: the surviving later read';
  const sourceContent = {
    strings: [removedText, twinText],
    counts: { textParts: 0, toolResults: 2, toolCallInputs: 0 },
    perCall: {
      call_seed_unit: { inputStrings: [], resultStrings: [removedText] },
      call_twin: { inputStrings: [], resultStrings: [twinText] },
    },
  };
  const ledger = {
    recallIds: ['recall:sha256:seed'],
    recallParts: [{ recallId: 'recall:sha256:seed',
      sourceNodeId: 'oc:ses:tool:call_seed_unit' }],
    removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:sha256:seed' }],
  };
  const receipt = {
    role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:seed',
  };
  const twin = { role: 'tool', tool_call_id: 'call_twin', content: twinText };
  const rekeyed = { role: 'tool', tool_call_id: 'call_rekeyed', content: removedText };
  const row = (seq, messages) => ({
    seq, main_turn: seq - 1, messages,
    receipt_messages: 1, receipt_recall_ids: ['recall:sha256:seed'],
  });
  // Request 1 proves the removal by the old call id being gone; the bytes come
  // back under a new call id on request 3. The old call-id check sees a clean
  // removal on every request.
  const mains = [
    row(1, [receipt, twin]),
    row(2, [receipt, twin]),
    row(3, [receipt, twin, rekeyed]),
  ];
  const callIdOnly = recallWireCrossCheck(ledger, mains, { sourceContent });
  assert.equal(callIdOnly.pass, false);
  assert.equal(callIdOnly.checked[0].firstRemoved, 1);
  assert.deepEqual(callIdOnly.checked[0].returned, []);
  assert.equal(callIdOnly.checked[0].contentMarkerChecked, false);
  assert.deepEqual(callIdOnly.checked[0].markerPresentAt, [3]);
  assert.equal(callIdOnly.uncovered.length, 1);
  assert.match(callIdOnly.uncovered[0].why, /content marker/u);
  assert.match(callIdOnly.uncovered[0].why, /request\(s\) 3/u);
});

/* ------------------------------------------------------------------ the multi-unit application shape */

test('removal lane: one recall per unit and every applied pass covering all three satisfy the multi-unit lane', () => {
  const unitCalls = ['call_a', 'call_b', 'call_c'];
  const coverage = unitCalls.map((callId, index) => ({
    callId, recallIds: [`recall:sha256:r${index}`],
  }));
  const laneRecallIds = coverage.flatMap((row) => row.recallIds);
  const atRest = [
    { reason: 'step', status: 'applied', intentId: 'i1' },
    { reason: 'step', status: 'applied', intentId: 'i2' },
  ];
  const applications = atRest.map((row) => ({
    intentId: row.intentId, recallIds: [...laneRecallIds], removedBytes: 3,
  }));
  const verdict = laneApplicationVerdict(atRest, applications, laneRecallIds, coverage, unitCalls);
  assert.equal(verdict.oneRecallPerUnit, true);
  assert.equal(verdict.everyPassAppliesEveryUnit, true);
  assert.equal(verdict.passCount, 2);
  assert.equal(verdict.derivationCount, 'not measured',
    'the ledger records recalls and intents, not how many derivations produced them');
  assert.deepEqual(verdict.distinctRecallIds,
    ['recall:sha256:r0', 'recall:sha256:r1', 'recall:sha256:r2']);

  // The shape the product does not produce: one recall naming all three units.
  // Coverage still maps every unit, but the lane's per-unit expectation fails.
  const oneRecallCoverage = unitCalls.map((callId) => ({
    callId, recallIds: ['recall:sha256:one'],
  }));
  const oneRecall = laneApplicationVerdict(atRest, atRest.map((row) => ({
    intentId: row.intentId, recallIds: ['recall:sha256:one'], removedBytes: 3,
  })), ['recall:sha256:one'], oneRecallCoverage, unitCalls);
  assert.equal(oneRecall.oneRecallPerUnit, false);
  assert.equal(oneRecall.everyPassAppliesEveryUnit, true,
    'the old shape still applies every unit together; only the per-unit recall check rejects it');

  // A per-unit pass: each applied intent names one unit, so the lane fails even
  // though each unit has its own recall id.
  const splitApplications = unitCalls.map((callId, index) => ({
    intentId: `i${index + 1}`, recallIds: [coverage[index].recallIds[0]], removedBytes: 1,
  }));
  const splitAtRest = splitApplications.map((row) => ({
    reason: 'step', status: 'applied', intentId: row.intentId,
  }));
  const split = laneApplicationVerdict(splitAtRest, splitApplications, laneRecallIds, coverage, unitCalls);
  assert.equal(split.oneRecallPerUnit, true);
  assert.equal(split.everyPassAppliesEveryUnit, false);

  // A single-unit lane has no multi-unit claim: the per-unit shape is null, and
  // the derivation count is still recorded as not measured.
  const single = laneApplicationVerdict(
    [{ reason: 'step', status: 'applied', intentId: 'i1' }],
    [{ intentId: 'i1', recallIds: ['recall:sha256:r0'], removedBytes: 1 }],
    ['recall:sha256:r0'], [coverage[0]], ['call_a']);
  assert.equal(single.oneRecallPerUnit, null);
  assert.equal(single.derivationCount, 'not measured');
});

/* ------------------------------------------------------------------ one recall, several parts (§4) */

test('removal lane: one recall naming three parts maps all three units for the wire check, not the multi-unit shape', () => {
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [
        { id: 'call_a1_RS-A', name: 'read' },
        { id: 'call_b1_RS-B', name: 'read' },
        { id: 'call_c1_RS-C', name: 'read' },
      ] } },
      { match: { main_turn: 1 }, reply: { calls: [
        { id: 'call_a2', name: 'read' },
        { id: 'call_b2', name: 'read' },
        { id: 'call_c2', name: 'read' },
      ] } },
    ],
  };
  const fixture = {
    files: [
      { name: 'a.txt', sentinel: 'FILE-A', bytes: 200000 },
      { name: 'b.txt', sentinel: 'FILE-B', bytes: 200000 },
      { name: 'c.txt', sentinel: 'FILE-C', bytes: 200000 },
    ],
    lanes: [{
      name: 'batch',
      unitCalls: ['call_a1_RS-A', 'call_b1_RS-B', 'call_c1_RS-C'],
      supersedingCalls: ['call_a2', 'call_b2', 'call_c2'],
      unitFiles: ['a.txt', 'b.txt', 'c.txt'],
      markerSentinels: ['RS-A', 'RS-B', 'RS-C'],
    }],
  };
  const ledger = {
    recallIds: ['recall:sha256:one'],
    recallParts: [
      { recallId: 'recall:sha256:one', sourceNodeId: 'oc:ses:tool:call_a1_RS-A' },
      { recallId: 'recall:sha256:one', sourceNodeId: 'oc:ses:tool:call_b1_RS-B' },
      { recallId: 'recall:sha256:one', sourceNodeId: 'oc:ses:tool:call_c1_RS-C' },
    ],
  };
  const unitMessages = [{ role: 'assistant', content: null, tool_calls: [
    { id: 'call_a1_RS-A' }, { id: 'call_b1_RS-B' }, { id: 'call_c1_RS-C' },
  ] }];
  const twinMessages = [
    { role: 'tool', tool_call_id: 'call_a2', content: 'FILE-A still here' },
    { role: 'tool', tool_call_id: 'call_b2', content: 'FILE-B still here' },
    { role: 'tool', tool_call_id: 'call_c2', content: 'FILE-C still here' },
  ];
  const receiptMessages = [{ role: 'user',
    content: '[not retained] three files · necromancy recall:sha256:one' }];
  const row = (seq, turn, messages, recallIds) => ({
    seq, main_turn: turn, messages,
    receipt_messages: recallIds.length, receipt_recall_ids: recallIds,
  });
  const mains = [
    row(1, 0, unitMessages, []),
    row(2, 1, unitMessages, []),
    row(3, 2, [...twinMessages, ...receiptMessages], ['recall:sha256:one']),
    row(4, 3, [...twinMessages, ...receiptMessages], ['recall:sha256:one']),
  ];
  const verdict = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, mains);
  assert.equal(verdict.ledgerRecallIds.length, 1, 'one recall id, not three');
  assert.equal(verdict.expectedUnits, 3, 'three unit calls');
  assert.equal(verdict.everyUnitMapped, true);
  assert.deepEqual(verdict.unitCallCoverage, [
    { callId: 'call_a1_RS-A', recallIds: ['recall:sha256:one'] },
    { callId: 'call_b1_RS-B', recallIds: ['recall:sha256:one'] },
    { callId: 'call_c1_RS-C', recallIds: ['recall:sha256:one'] },
  ]);
  assert.equal(verdict.cumulative, true, 'one receipt per request covers all three parts');
  assert.equal(verdict.firstReceiptComplete, true);
  assert.equal(verdict.application.oneRecallPerUnit, null,
    'no journal was supplied, so the multi-unit shape is unmeasured');
  assert.equal(recallWireCrossCheck(ledger, mains).pass, true);

  // Drop one part: the recall no longer maps that unit call, so the lane fails
  // even though the count of receipts is unchanged.
  const partial = { ...ledger, recallParts: ledger.recallParts.slice(0, 2) };
  const missing = removalLaneVerdict(fixture.lanes[0], fixture, script, partial, mains);
  assert.equal(missing.ledgerRecallIds.length, 1);
  assert.equal(missing.everyUnitMapped, false);
  assert.equal(missing.cumulative, false);
});

/* ------------------------------------------------------------------ the ledger session */

test('ledger: the run\'s session is selected exactly, and two carriers are refused', () => {
  const dir = scratch();
  try {
    const makeLedger = (sessionId) => {
      const sessionDir = join(dir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const db = new DatabaseSync(join(sessionDir, 'ledger.sqlite'));
      db.exec('CREATE TABLE recalls (recall_id TEXT, created_at_ms INTEGER)');
      db.prepare('INSERT INTO recalls VALUES (?, ?)').run(`recall:${sessionId}`, 1);
      db.close();
    };
    makeLedger('ses_a');
    const one = readLedger(dir, 'ses_a');
    assert.equal(one.refused, null);
    assert.equal(one.exists, true);
    assert.equal(one.sessionId, 'ses_a');
    assert.deepEqual(one.recallIds, ['recall:ses_a']);
    assert.equal(one.sha256.length, 64, 'the ledger database is hashed');
    assert.ok(one.bytes > 0);
    // The hash covers the bytes the SQL read, not a later re-read: the ledger is
    // fingerprinted before the connection opens and again after it closes.
    assert.equal(one.databaseStable, true);
    assert.deepEqual(one.databaseBefore, one.database);
    assert.deepEqual(one.databaseChanges, []);

    // The run's session has no ledger: refused by name, never read from another.
    const wrong = readLedger(dir, 'ses_b');
    assert.equal(wrong.exists, false);
    assert.match(wrong.refused, /no ledger for session ses_b/u);

    // A replay seed plus a host-created session leaves two carriers. The old
    // rule read the first one and attributed its recalls to this run; now the
    // root is refused instead.
    makeLedger('ses_b');
    const two = readLedger(dir, 'ses_a');
    assert.equal(two.exists, false);
    assert.match(two.refused, /2 ledger carriers \(ses_a, ses_b\)/u);
    assert.deepEqual(two.recallIds, [], 'no session\'s recall ids are attributed');
    assert.match(readLedger(dir).refused, /names no session/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requests: the hash is taken from the bytes that were parsed (P1)', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'requests.jsonl');
    const text = '{"seq":1,"kind":"main"}\n{"seq":2,"kind":"title"}\n';
    writeFileSync(path, text, 'utf8');
    const read = readRequests(path);
    assert.equal(read.rows.length, 2);
    assert.equal(read.rows[0].seq, 1);
    assert.equal(read.sha256, createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(read.bytes, Buffer.byteLength(text, 'utf8'));
    // A later read that differs is a different hash. The evidence comparison
    // reads the file again, so this is the mismatch it names.
    writeFileSync(path, `${text}{"seq":3,"kind":"main"}\n`, 'utf8');
    const later = readRequests(path);
    assert.equal(later.rows.length, 3);
    assert.notEqual(later.sha256, read.sha256);
    // A missing file has no hash to compare, never the empty-string hash.
    assert.deepEqual(readRequests(join(dir, 'absent.jsonl')),
      { rows: [], sha256: null, bytes: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit code: a passing but non-citable run never exits 0 (P6)', () => {
  assert.equal(exitCodeForRun(true, true), 0);
  assert.equal(exitCodeForRun(true, false), 3);
  assert.equal(exitCodeForRun(false, true), 1);
  assert.equal(exitCodeForRun(false, false), 1);
  // The status is the conjunction, not either field alone.
  assert.notEqual(exitCodeForRun(true, false), 0);
  assert.notEqual(exitCodeForRun(false, true), 0);
});

/* ------------------------------------------------------------------ replay continuation */

test('replay: every world data location is read, so a second session cannot hide', () => {
  const seeded = 'ses_seeded';
  const db = (path, ids, exists = true, ok = true) => ({
    path, exists, ok, total: ids.length, ids,
    error: ok ? null : 'unreadable',
  });
  const onlySeed = [db('world/.local/share/opencode/opencode.db', [seeded])];
  assert.equal(replayContinuation(onlySeed, seeded).pass, true);

  // The host wrote to APPDATA: the seed is untouched (still one row) and a new
  // session exists beside it. Reading only the seeded database used to pass.
  const appdata = [
    db('world/.local/share/opencode/opencode.db', [seeded]),
    db('world/appdata/roaming/opencode/opencode.db', ['ses_host_created']),
  ];
  const verdict = replayContinuation(appdata, seeded);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.sessions, [seeded, 'ses_host_created']);

  // The seed was renamed or replaced: one session, not the seeded id.
  assert.equal(replayContinuation(
    [db('world/.local/share/opencode/opencode.db', ['ses_other'])], seeded,
  ).pass, false);
  // Two sessions in one database: also refused.
  assert.equal(replayContinuation(
    [db('world/.local/share/opencode/opencode.db', [seeded, 'ses_second'])], seeded,
  ).pass, false);
  // An existing candidate that cannot be read could hide a session.
  const unreadable = [
    db('world/.local/share/opencode/opencode.db', [seeded]),
    db('world/appdata/local/opencode/opencode.db', [], true, false),
  ];
  assert.equal(replayContinuation(unreadable, seeded).pass, false);
  assert.equal(replayContinuation(unreadable, seeded).unreadable.length, 1);
});

/* ------------------------------------------------------------------ the twin's own result */
test('removal lane: a lost twin result fails even when the write call kept the sentinel', () => {
  // The stale-read shape: read (unit), write (trigger), read (twin). The write
  // call's own arguments carry the bytes it wrote, including the file sentinel.
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [{ id: 'call_u_RS-T', name: 'read' }] } },
      { match: { main_turn: 1 }, reply: { calls: [{ id: 'call_w', name: 'write' }] } },
      { match: { main_turn: 2 }, reply: { calls: [{ id: 'call_t', name: 'read' }] } },
    ],
  };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-TWIN', bytes: 200000 }],
    lanes: [{
      name: 'stale', rule: 'stale-read',
      unitCalls: ['call_u_RS-T'], triggerCalls: ['call_w'], supersedingCalls: ['call_t'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-T'],
    }],
  };
  const ledger = {
    recallIds: ['recall:sha256:t'],
    recallParts: [{ recallId: 'recall:sha256:t', sourceNodeId: 'oc:ses:tool:call_u_RS-T' }],
    removalRules: [{ ruleId: 'stale-read', recallId: 'recall:sha256:t' }],
  };
  const unit = { role: 'assistant', tool_calls: [{ id: 'call_u_RS-T' }] };
  const unitResult = { role: 'tool', tool_call_id: 'call_u_RS-T',
    content: `FILE-TWIN ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const writeCall = {
    role: 'assistant',
    tool_calls: [{
      id: 'call_w',
      function: { name: 'write',
        arguments: JSON.stringify({ path: 'big.txt', content: 'FILE-TWIN\nafter the write\n' }) },
    }],
  };
  const writeResult = { role: 'tool', tool_call_id: 'call_w', content: 'Wrote file successfully' };
  // The twin's call declaration is present, so the call id is in the body; its
  // result message is not. The write call's arguments still carry the sentinel.
  const twinCallOnly = { role: 'assistant', tool_calls: [{ id: 'call_t' }] };
  const receipt = { role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:t' };
  const row = (seq, turn, messages, ids) => ({
    seq, main_turn: turn, messages,
    receipt_messages: ids.length, receipt_recall_ids: ids,
    tool_results_bytes: 60_000,
  });
  const broken = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [writeCall, writeResult, twinCallOnly, receipt], ['recall:sha256:t']),
    row(4, 3, [writeCall, writeResult, twinCallOnly, receipt], ['recall:sha256:t']),
  ];
  const verdict = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, broken);
  assert.equal(verdict.bodies.pass, false, 'a twin call id is not the twin result');
  assert.match(verdict.bodies.statement, /no tool-result message addressed to it/u);
  assert.match(verdict.bodies.statement, /call_t/u);
  assert.equal(verdict.measuredWindow.pass, false);
  assert.equal(verdict.removalMeasured, false);

  // Put the twin's result back: the same rows now pass, so the failure is the
  // missing result and nothing else.
  const twinResult = { role: 'tool', tool_call_id: 'call_t', content: 'FILE-TWIN after the write' };
  const fixed = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [writeCall, writeResult, twinCallOnly, twinResult, receipt], ['recall:sha256:t']),
    row(4, 3, [writeCall, writeResult, twinCallOnly, twinResult, receipt], ['recall:sha256:t']),
  ];
  const restored = removalLaneVerdict(fixture.lanes[0], fixture, script, ledger, fixed);
  assert.equal(restored.bodies.pass, true, restored.bodies.statement);
  assert.equal(restored.removalMeasured, true, JSON.stringify(restored.measuredWindow));
});

/* ------------------------------------------------------------------ the product bar */

test('fixture: the product bar is imported from core, and a mismatch is refused', async () => {
  assert.deepEqual(checkProductBar(PRODUCT_BAR_BYTES), {
    ok: true,
    value: PRODUCT_BAR_BYTES,
    source: '@cremator/core DEFAULT_CONFIG.protocol.barBytes',
  });
  const mismatch = checkProductBar(PRODUCT_BAR_BYTES + 1);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.refused, /productBarBytes=512/u);
  assert.equal(checkProductBar(undefined).ok, false);
  assert.equal(checkProductBar('8192').ok, false);

  // The launch-time read of the product's own constant. If this fails, the
  // fixture's constant is not the product's bar and every run must refuse.
  const launch = await productBarAtLaunch();
  assert.equal(launch.ok, true, launch.refused);
  assert.equal(launch.value, PRODUCT_BAR_BYTES);
  assert.equal(launch.source, '@cremator/core DEFAULT_CONFIG.protocol.barBytes');

  // The host reader cap is declared, not read from the installed package, and
  // the result says so.
  const cap = hostReaderCapRecord('C:/bin/opencode.exe');
  assert.equal(cap.value, READER_CAP_BYTES);
  assert.equal(cap.readFromHost, false);
  assert.equal(cap.source, 'declared');
});

/* ------------------------------------------------------------------ the replay content baseline */

test('replay content: request 1 is compared with the seeded strings plus the task', () => {
  const source = ['read the file', 'on it', 'file contents'];
  const task = 'read "the file" again';
  const row = (texts) => ({ seq: 1, messages: texts.map((text) => ({ role: 'user', content: text })) });
  const pass = replayContentBaseline(row([...source, task]), source, task);
  assert.equal(pass.pass, true, pass.detail);
  // The host's `run` posts the task wrapped in one pair of literal double
  // quotes, with real newlines inside and every inner double quote escaped as
  // `\"`. One occurrence is normalised.
  const quoted = replayContentBaseline(
    row([...source, `"${task.replace(/"/gu, '\\"')}"`]), source, task);
  assert.equal(quoted.pass, true, quoted.detail);
  const twice = replayContentBaseline(
    row([...source, task, `"${task.replace(/"/gu, '\\"')}"`]), source, task);
  assert.equal(twice.pass, false, 'a second copy is still an extra');
  const missing = replayContentBaseline(row([source[0], task]), source, task);
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.missing, ['on it', 'file contents']);
  const extra = replayContentBaseline(row([...source, task, 'a fabricated row']), source, task);
  assert.equal(extra.pass, false);
  assert.deepEqual(extra.extra, ['a fabricated row']);
  // A receipt and a system prompt are not seeded content on either side.
  const scoped = replayContentBaseline({
    seq: 1,
    messages: [
      { role: 'system', content: 'the host prompt' },
      ...source.map((text) => ({ role: 'user', content: text })),
      { role: 'user', content: task },
      { role: 'user', content: '[not retained] x · necromancy recall:sha256:x' },
    ],
  }, source, task);
  assert.equal(scoped.pass, true, scoped.detail);
  // The host's own truncation is the one allowed difference, and it is named.
  const truncated = replayContentBaseline({
    seq: 1,
    messages: [
      { role: 'user', content: source[0] },
      { role: 'user', content: source[1] },
      { role: 'tool', content: `${source[2].slice(0, 10)}[showing lines 1-2 of 20; full output saved to /t]` },
      { role: 'user', content: task },
    ],
  }, source, task);
  assert.equal(truncated.pass, true, truncated.detail);
  assert.equal(truncated.truncated.length, 1);
  assert.equal(replayContentBaseline(null, source, task).pass, false);
});

test('replay content: the every-request containment normalises the quoted task', () => {
  const source = ['seed one'];
  const task = 'read "the file" again';
  const quoted = `"${task.replace(/"/gu, '\\"')}"`;
  const mains = [
    { seq: 1, messages: [{ role: 'user', content: source[0] }, { role: 'user', content: quoted }] },
    { seq: 2, messages: [{ role: 'user', content: source[0] }, { role: 'user', content: quoted }] },
  ];
  const verdict = seededContentEverywhere(mains, source, task);
  assert.equal(verdict.pass, true, verdict.detail);
});

/* ------------------------------------------------------------------ the child env (§8) */

test('env: the child env is an allow-list, so A6_KEY and OPENAI_KEY are stripped', () => {
  const { env, stripped, allowed } = childEnv({ XDG_DATA_HOME: 'world' }, {}, {
    PATH: 'C:/bin',
    SystemRoot: 'C:/Windows',
    LANG: 'en',
    A6_KEY: 'secret-a6',
    OPENAI_KEY: 'secret-openai',
    OPENAI_API_KEY: 'secret-openai-api',
    HOME: 'C:/Users/xxxxx',
    DEEPSEEK_API_KEY: 'secret-deepseek',
    NODE_OPTIONS: '--require evil',
  });
  assert.equal(env.PATH, 'C:/bin');
  assert.equal(env.SystemRoot, 'C:/Windows');
  assert.equal(env.LANG, 'en');
  assert.equal(env.XDG_DATA_HOME, 'world', 'the redirect is written after the strip');
  // The home NAME is on the shared list; at launch the redirect overrides its
  // value, so the child reads the world's home, never the owner's.
  assert.equal(env.HOME, 'C:/Users/xxxxx', 'the home name is inherited');
  for (const name of ['A6_KEY', 'OPENAI_KEY', 'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} survived the allow-list`);
    assert.ok(stripped.includes(name), `${name} is named as stripped`);
  }
  assert.ok(allowed.includes('PATH'));

  // The real route may name its one key variable; every other name stays out.
  const real = childEnv({}, { allowKeyNames: ['DEEPSEEK_API_KEY'] }, {
    PATH: 'C:/bin', DEEPSEEK_API_KEY: 'secret', A6_KEY: 'secret-a6',
  });
  assert.equal(real.env.DEEPSEEK_API_KEY, 'secret');
  assert.equal(Object.hasOwn(real.env, 'A6_KEY'), false);
  assert.ok(real.stripped.includes('A6_KEY'));
});

/* ------------------------------------------------------------------ the byte-level marker */

/**
 * The stale-read shape with a byte-level content marker. The removed read is
 * the only copy of `PRE-WRITE-FILLER`; the write replaces the file with short
 * bytes that do not carry it. A host that re-keys the call id keeps the result
 * bytes under a new id — exactly what a call-id-only check misses.
 */
function staleSynthetic() {
  const script = {
    replies: [
      { match: { main_turn: 0 }, reply: { calls: [
        { id: 'call_u_RS-T', name: 'read', input: { path: 'big.txt' } },
      ] } },
      { match: { main_turn: 1 }, reply: { calls: [
        { id: 'call_w', name: 'write', input: { path: 'big.txt', content: 'FILE-TWIN\nafter the write\n' } },
      ] } },
      { match: { main_turn: 2 }, reply: { calls: [
        { id: 'call_t', name: 'read', input: { path: 'big.txt' } },
      ] } },
    ],
  };
  const fixture = {
    files: [{ name: 'big.txt', sentinel: 'FILE-TWIN', bytes: 200000, markers: ['PRE-WRITE-FILLER'] }],
    lanes: [{
      name: 'stale', rule: 'stale-read',
      unitCalls: ['call_u_RS-T'], triggerCalls: ['call_w'], supersedingCalls: ['call_t'],
      unitFiles: ['big.txt'], markerSentinels: ['RS-T'], contentMarkers: ['PRE-WRITE-FILLER'],
    }],
  };
  const ledger = {
    recallIds: ['recall:sha256:t'],
    recallParts: [{ recallId: 'recall:sha256:t', sourceNodeId: 'oc:ses:tool:call_u_RS-T' }],
    removalRules: [{ ruleId: 'stale-read', recallId: 'recall:sha256:t' }],
  };
  const unit = { role: 'assistant', tool_calls: [{ id: 'call_u_RS-T' }] };
  const unitResult = { role: 'tool', tool_call_id: 'call_u_RS-T',
    content: `FILE-TWIN PRE-WRITE-FILLER ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const writeCall = { role: 'assistant', tool_calls: [{ id: 'call_w' }] };
  const writeResult = { role: 'tool', tool_call_id: 'call_w', content: 'Wrote file successfully' };
  const twinResult = { role: 'tool', tool_call_id: 'call_t', content: 'FILE-TWIN after the write' };
  const receipt = { role: 'user', content: '[not retained] big.txt · necromancy recall:sha256:t' };
  // The host re-keyed the call: the same bytes, a new call id. The old id is
  // gone, the content marker is not.
  const rekeyedCall = { role: 'assistant', tool_calls: [{ id: 'call_u_rekeyed' }] };
  const rekeyedResult = { role: 'tool', tool_call_id: 'call_u_rekeyed',
    content: `FILE-TWIN PRE-WRITE-FILLER ${'x'.repeat(PRODUCT_BAR_BYTES + 1)}` };
  const row = (seq, turn, messages, ids) => ({
    seq, main_turn: turn, messages,
    receipt_messages: ids.length, receipt_recall_ids: ids,
    tool_results_bytes: 60_000,
  });
  const rekeyed = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [rekeyedCall, rekeyedResult, writeCall, writeResult, twinResult, receipt],
      ['recall:sha256:t']),
    row(4, 3, [rekeyedCall, rekeyedResult, writeCall, writeResult, twinResult, receipt],
      ['recall:sha256:t']),
  ];
  return { script, fixture, lane: fixture.lanes[0], ledger, rekeyed, row, unit, unitResult,
    writeCall, writeResult, twinResult, receipt };
}

test('removal lane: a re-keyed call id keeps the bytes, and the byte marker fails it', () => {
  const { script, fixture, lane, ledger, rekeyed } = staleSynthetic();
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, rekeyed);
  // The call id left and the marker sentinel left with it; the result bytes did
  // not. A verdict built from the call id alone would call this a clean removal.
  assert.equal(verdict.bodies.pass, false, verdict.bodies.statement);
  assert.match(verdict.bodies.statement, /PRE-WRITE-FILLER|never left|still in every request/u);
  assert.equal(verdict.removalMeasured, false);
  // Dropping the content marker is the old, id-only check: the same rows pass,
  // which is the defect the marker exists to close.
  const idOnly = removalLaneVerdict({ ...lane, contentMarkers: [] }, fixture, script, ledger, rekeyed);
  assert.equal(idOnly.bodies.pass, true, idOnly.bodies.statement);
});

test('removal lane: the filler must be present before the trigger, or presence is unproven', () => {
  const { script, fixture, lane, ledger, row, writeCall, writeResult, twinResult, receipt } =
    staleSynthetic();
  // The request before the trigger carries the read, but neither its call id nor
  // its content marker: the only bytes the lane names are gone before anything
  // removed them, so "the unit was present, then left" is not proven.
  const lostFiller = [
    row(1, 0, [{ role: 'assistant', tool_calls: [{ id: 'call_u_RS-T' }] }], []),
    row(2, 1, [{ role: 'assistant', tool_calls: [{ id: 'call_u_rekeyed' }] },
      { role: 'tool', tool_call_id: 'call_u_rekeyed', content: 'FILE-TWIN body' }], []),
    row(3, 2, [writeCall, writeResult, twinResult, receipt], ['recall:sha256:t']),
    row(4, 3, [writeCall, writeResult, twinResult, receipt], ['recall:sha256:t']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, lostFiller);
  assert.equal(verdict.positiveControl, false, 'no named marker was present before the trigger');
  assert.equal(verdict.removalMeasured, false);
});

test('removal lane: a tail drop after a good measured request is not a removal', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    // The host dropped the tail: the receipt survives, the twin result does not.
    row(4, 3, [receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.measuredWindow.pass, false);
  assert.deepEqual(verdict.measuredWindow.twinMissing, [4]);
  assert.equal(verdict.removalMeasured, false);
});

test('removal lane: a first absence before the stable turn still measures', () => {
  const { script, fixture, lane, ledger, row, unit, unitResult, writeCall, writeResult,
    twinResult, receipt } = staleSynthetic();
  // The unit leaves one request before the twin read's own result exists. The
  // measured window starts at the stable turn, so the earlier absence is
  // recorded but is not held to a twin it could not carry.
  const mains = [
    row(1, 0, [unit], []),
    row(2, 1, [unit, unitResult], []),
    row(3, 2, [writeCall, writeResult, receipt], ['recall:sha256:t']),
    row(4, 3, [writeCall, writeResult, twinResult, receipt], ['recall:sha256:t']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.requests[0].measured, false, 'the pre-stable request is not measured');
  assert.equal(verdict.requests[1].measured, true);
  assert.equal(verdict.measuredWindow.pass, true, JSON.stringify(verdict.measuredWindow));
  assert.equal(verdict.removalMeasured, true, JSON.stringify({
    bodies: verdict.bodies.pass,
    cumulative: verdict.cumulative,
    firstReceiptComplete: verdict.firstReceiptComplete,
    everyUnitMapped: verdict.everyUnitMapped,
    declaredRuleMeasured: verdict.declaredRuleMeasured,
    positiveControl: verdict.positiveControl,
    filePositiveControl: verdict.filePositiveControl,
  }));
});

/* ------------------------------------------------------------------ the content baseline subject */

test('replay content: a seeded session\'s own removable unit is allowed on request 1 and recorded', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'source.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)');
    const readText = `SEEDED-READ-RESULT ${'y'.repeat(PRODUCT_BAR_BYTES + 1)}`;
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
      'msg_0', 'ses_seed', 'user', 0, JSON.stringify({ type: 'user', text: 'read big.txt' }),
    );
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
      'msg_1', 'ses_seed', 'assistant', 1,
      JSON.stringify({
        type: 'assistant',
        content: [{
          type: 'tool', id: 'call_seed_unit', name: 'read',
          state: { status: 'completed', input: { path: 'big.txt' }, output: readText },
        }],
      }),
    );
    const receiptText = '[not retained] big.txt · necromancy recall:seed:unit';
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
      'msg_2', 'ses_seed', 'user', 2, JSON.stringify({ type: 'user', text: receiptText }),
    );
    db.close();
    const source = new DatabaseSync(path, { readOnly: true });
    let content;
    let seededReceipts;
    try {
      content = sessionSendableContent(source, 'ses_seed');
      seededReceipts = sessionReceiptRecallIds(source, 'ses_seed');
    } finally {
      source.close();
    }
    assert.deepEqual(content.perCall.call_seed_unit.inputStrings, ['big.txt']);
    assert.deepEqual(content.perCall.call_seed_unit.resultStrings, [readText]);
    assert.deepEqual(seededReceipts, ['recall:seed:unit']);
    const ledger = {
      recallIds: ['recall:seed:unit'],
      recallParts: [{ recallId: 'recall:seed:unit',
        sourceNodeId: 'oc:ses_seed:tool:call_seed_unit' }],
      removalRules: [{ ruleId: 'superseded-read', recallId: 'recall:seed:unit' }],
    };
    const task = 'read big.txt again';
    const firstRequest = {
      seq: 1,
      receipt_recall_ids: ['recall:seed:unit'],
      messages: [
        { role: 'user', content: 'read big.txt' },
        { role: 'user', content: receiptText },
        { role: 'user', content: task },
      ],
    };
    const removed = removedSeededContentForRequest(firstRequest, ledger, content);
    assert.deepEqual(removed.recallIds, ['recall:seed:unit']);
    assert.deepEqual(removed.callIds, ['call_seed_unit']);
    const baseline = replayContentBaseline(firstRequest, content.strings, task, { removed });
    assert.equal(baseline.pass, true, baseline.detail);
    assert.equal(baseline.removed.receiptsCarried, true);
    assert.equal(baseline.removed.strings, 2, 'the call input and the removed result');
    assert.match(baseline.detail, /ledger-recorded removal/u);
    // Without the ledger-recorded removal the same body is a missing seeded row.
    const without = removedSeededContentForRequest(
      { ...firstRequest, receipt_recall_ids: [] }, ledger, content,
    );
    const missing = replayContentBaseline(firstRequest, content.strings, task, { removed: without });
    assert.equal(missing.pass, false);
    assert.equal(missing.missing.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay content: an empty source leaves the baseline with no subject', () => {
  const task = 'read the file again';
  const row = { seq: 1, messages: [{ role: 'user', content: task }] };
  const empty = replayContentBaseline(row, [], task);
  assert.equal(empty.pass, true, 'with no source the task alone matches the task');
  assert.equal(empty.expected, 1);
  const noSubject = contentBaselineSubject(empty, { textParts: 0, toolResults: 0, toolCallInputs: 0 },
    { seeded: true });
  assert.equal(noSubject.pass, false);
  assert.match(noSubject.detail, /nothing to be compared with/u);
  // A source with strings still fails when the baseline expects only the task.
  const taskOnly = contentBaselineSubject(empty, { textParts: 2, toolResults: 1, toolCallInputs: 1 },
    { seeded: true });
  assert.equal(taskOnly.pass, false);
  assert.match(taskOnly.detail, /more than the task alone/u);
  // A fresh run's subject is the task itself.
  assert.equal(contentBaselineSubject(empty, null, { seeded: false }).pass, true);
  assert.equal(contentBaselineSubject({ ...empty, expected: 0 }, null, { seeded: false }).pass, false);
});

test('replay content: the truncation allowance does not accept an empty prefix', () => {
  const source = `SOURCE-HEAD ${'h'.repeat(600)}`;
  const note = '[showing lines 1-2 of 3; full output saved to C:/tmp/out.txt]';
  const task = 'do it';
  const withResult = (content) => ({
    seq: 1,
    messages: [
      { role: 'user', content: task },
      { role: 'tool', tool_call_id: 'call_1', content },
    ],
  });
  // `''.startsWith` every string: before the fix this candidate was accepted as
  // the source's truncated head for ANY source.
  const emptyPrefix = replayContentBaseline(withResult(note), [source], task);
  assert.equal(emptyPrefix.pass, false);
  assert.equal(emptyPrefix.truncated.length, 0);
  assert.equal(emptyPrefix.missing.length, 1);
  // A prefix of a few characters is still not the declared head.
  const tinyPrefix = replayContentBaseline(withResult(`S${note}`), [source], task);
  assert.equal(tinyPrefix.pass, false);
  assert.equal(tinyPrefix.truncated.length, 0);
  // A real head prefix — three quarters of the declared head or more — is the
  // host's truncation and is counted as carried.
  const realHead = source.slice(0, 400);
  const truncated = replayContentBaseline(withResult(`${realHead}${note}`), [source], task);
  assert.equal(truncated.pass, true, truncated.detail);
  assert.equal(truncated.truncated.length, 1);
});

test('replay content: a removed string still on the wire fails even when a duplicate absorbs it', () => {
  const task = 'do it';
  const duplicated = 'DUP-SEEDED-STRING that appears twice in the source';
  const firstRequest = {
    seq: 1,
    receipt_recall_ids: ['recall:sha256:dup'],
    messages: [{ role: 'user', content: task }, { role: 'user', content: duplicated }],
  };
  // The source carries the string twice and the request-1 removal subtracts one
  // occurrence, so the one-for-one comparison still matches the carried copy:
  // `missing` and `extra` are both empty. The removal is contradicted anyway,
  // and `stillCarried` is what names it.
  const baseline = replayContentBaseline(
    firstRequest,
    [duplicated, duplicated],
    task,
    { removed: { recallIds: ['recall:sha256:dup'], callIds: ['call_dup'], strings: [duplicated] } },
  );
  assert.deepEqual(baseline.missing, []);
  assert.deepEqual(baseline.extra, []);
  assert.equal(baseline.removed.stillCarried, 1);
  assert.equal(baseline.pass, false, 'a removed string on the wire is a failure, not a count');
  assert.match(baseline.detail, /string\(s\) of a ledger-recorded removal are still carried/u);
  // The same request with the duplicated occurrence absent passes.
  const clean = replayContentBaseline(
    { ...firstRequest, messages: [{ role: 'user', content: task }] },
    [duplicated],
    task,
    { removed: { recallIds: ['recall:sha256:dup'], callIds: ['call_dup'], strings: [duplicated] } },
  );
  assert.equal(clean.removed.stillCarried, 0);
  assert.equal(clean.pass, true, clean.detail);
});

/* ------------------------------------------------------------------ the scripted turns */

test('script: the ordered matched replies equal the script, once each', () => {
  const script = { replies: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const ok = scriptedReplyAccounting([
    { matched_reply: 'a', matched_content_key: true },
    { matched_reply: 'b', matched_content_key: true },
    { matched_reply: 'c', matched_content_key: true },
  ], script);
  assert.equal(ok.pass, true, ok.detail);
  assert.deepEqual(ok.matched, ['a', 'b', 'c']);
  // A refused request shifts every later boundary: fewer mains than turns.
  const short = scriptedReplyAccounting([
    { matched_reply: 'a', matched_content_key: true },
    { matched_reply: 'b', matched_content_key: true },
  ], script);
  assert.equal(short.pass, false);
  assert.match(short.detail, /2 main request\(s\) for 3 scripted reply\(s\)/u);
  // A duplicated reply leaves the last turn unanswered.
  const duplicated = scriptedReplyAccounting([
    { matched_reply: 'a', matched_content_key: true },
    { matched_reply: 'a', matched_content_key: true },
    { matched_reply: 'b', matched_content_key: true },
  ], script);
  assert.equal(duplicated.pass, false);
  assert.match(duplicated.detail, /exactly once|where the script names/u);
  // An extra request moves the boundary even when the names are in order.
  const extra = scriptedReplyAccounting([
    { matched_reply: 'a', matched_content_key: true },
    { matched_reply: 'b', matched_content_key: true },
    { matched_reply: 'c', matched_content_key: true },
    { matched_reply: 'c', matched_content_key: true },
  ], script);
  assert.equal(extra.pass, false);
  // A replay's seeded turns are history, not scripted replies: the count is the
  // script's own, and no seeded name appears here.
  const replay = scriptedReplyAccounting([{ matched_reply: 'a', matched_content_key: true }],
    { replies: [{ name: 'a' }] });
  assert.equal(replay.pass, true);
});

/* ------------------------------------------------------------------ journal attribution */

test('journal: the mount and storage-plan lines are kept, and plans are held to the run', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'journal.jsonl');
    const root = join(dir, 'storage');
    writeFileSync(path, [
      JSON.stringify({ kind: 'mounted', atMs: 1, plugin: 'cremator-opencode',
        storageRoot: root, journalFile: path, excludeTools: ['subagent'], revertHistory: false }),
      JSON.stringify({ kind: 'storage-plan', atMs: 2, sessionId: 'ses_run',
        databasePath: join(root, 'sessions', 'ses_run', 'ledger.sqlite'),
        blobRoot: join(root, 'sessions', 'ses_run', 'blobs') }),
      JSON.stringify({ kind: 'at-rest', atMs: 3, sessionId: 'ses_run', eventId: 'e1',
        reason: 'step', status: 'applied', intentId: 'i1' }),
      JSON.stringify({ kind: 'commit', atMs: 4, sessionId: 'ses_run', eventId: 'e1', committed: true }),
    ].join('\n'));
    const summary = readJournal(path);
    assert.equal(summary.mounted.storageRoot, root);
    assert.deepEqual(summary.mounted.excludeTools, ['subagent']);
    assert.equal(summary.mounted.revertHistory, false);
    assert.equal(summary.storagePlans.length, 1);
    assert.equal(summary.storagePlans[0].sessionId, 'ses_run');
    assert.equal(summary.atRest[0].sessionId, 'ses_run');
    assert.equal(summary.commits[0].sessionId, 'ses_run');
    assert.equal(journalStoragePlansHold(summary, root, 'ses_run').pass, true);
    // Another session's plan is another run's ledger.
    const other = journalStoragePlansHold(summary, root, 'ses_other');
    assert.equal(other.pass, false);
    assert.match(other.detail, /another run/u);
    // A plan outside the root is refused even when the session matches.
    const outside = { ...summary, storagePlans: [{ ...summary.storagePlans[0],
      databasePath: join(dir, 'elsewhere', 'ledger.sqlite') }] };
    assert.equal(journalStoragePlansHold(outside, root, 'ses_run').pass, false);
    assert.equal(pathInside(join(root, 'sessions', 'x', 'ledger.sqlite'), root), true);
    assert.equal(pathInside(join(dir, 'elsewhere', 'ledger.sqlite'), root), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the artifact under test */

test('artifact: the declared entry, the dist tree and the core build are hashed', () => {
  const dir = scratch();
  try {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // The host mounts a package directory and resolves its own `./server`
    // export; the bench refuses unless that declaration is the file it hashes.
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'cremator-opencode',
      version: '0.1.0',
      exports: { './server': { default: './dist/server.js' } },
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'dist', 'server.js'), 'export const built = 1;\n');
    writeFileSync(join(dir, 'dist', 'apply.js'), 'export const other = 1;\n');
    writeFileSync(join(src, 'index.ts'), 'export const source = 1;\n');
    // The adapter's resolved @cremator/core build, a separate package.
    const core = join(dir, 'node_modules', '@cremator', 'core');
    mkdirSync(join(core, 'dist'), { recursive: true });
    writeFileSync(join(core, 'package.json'), `${JSON.stringify({
      name: '@cremator/core', version: '0.1.0', exports: { '.': './dist/index.js' },
    }, null, 2)}\n`);
    writeFileSync(join(core, 'dist', 'index.js'), 'export const core = 1;\n');
    const now = Date.now() / 1000;
    for (const file of ['server.js', 'apply.js']) {
      utimesSync(join(dir, 'dist', file), now - 60, now - 60);
    }
    utimesSync(join(src, 'index.ts'), now, now);
    const artifact = pluginArtifact(dir);
    assert.equal(artifact.entrySha256.length, 64);
    assert.equal(artifact.packageJsonSha256.length, 64);
    assert.equal(artifact.declaredEntry.ok, true, artifact.declaredEntry.refused);
    assert.equal(artifact.entryMatchesDeclared, true);
    assert.equal(artifact.declaredEntry.declaredPath.endsWith('server.js'), true);
    // Every file under dist/ is hashed, not only the entry.
    assert.deepEqual(artifact.distFiles.map((file) => file.relativePath).sort(),
      ['apply.js', 'server.js']);
    assert.equal(artifact.distSha256.length, 64);
    // The resolved core build is hashed too.
    assert.equal(artifact.coreBuild.ok, true, artifact.coreBuild.refused);
    assert.equal(artifact.coreBuild.sha256.length, 64);
    assert.deepEqual(artifact.coreBuild.files.map((file) => file.relativePath), ['index.js']);
    assert.equal(artifact.entryNewerThanSource, false);
    const stale = staleBuildRefusal(artifact);
    assert.match(stale, /older than/u);
    assert.match(stale, /index\.ts/u);
    assert.match(stale, /npm run build -w cremator-opencode/u);
    // A non-entry dist file moving moves the dist hash, so a swapped build is
    // not hidden behind an untouched entry.
    writeFileSync(join(dir, 'dist', 'apply.js'), 'export const other = 2;\n');
    utimesSync(join(dir, 'dist', 'apply.js'), now + 60, now + 60);
    const swapped = pluginArtifact(dir);
    assert.notEqual(swapped.distSha256, artifact.distSha256);
    assert.equal(swapped.entrySha256, artifact.entrySha256, 'the entry itself did not move');
    // A fresh build passes, and its hashes are stable.
    utimesSync(join(dir, 'dist', 'server.js'), now + 60, now + 60);
    const fresh = pluginArtifact(dir);
    assert.equal(fresh.entryNewerThanSource, true);
    assert.equal(staleBuildRefusal(fresh), null);
    // A declaration that resolves elsewhere is refused by name.
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'cremator-opencode',
      exports: { './server': { default: './dist/index.js' } },
    }, null, 2)}\n`);
    const wrong = pluginArtifact(dir);
    assert.equal(wrong.entryMatchesDeclared, false);
    assert.match(wrong.declaredEntry.refused, /resolves .* to|resolves to/u);
    assert.match(staleBuildRefusal(wrong), /mounted entry is not proven/u);
    // The host's ESM import resolves `import` before `default`, in the manifest's
    // own key order. A fixed list that tests `default` first resolved the
    // fallback and called the mounted entry a different file.
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'cremator-opencode',
      exports: {
        './server': {
          types: './dist/server.d.ts',
          import: './dist/server.js',
          default: './dist/index.js',
        },
      },
    }, null, 2)}\n`);
    const esm = pluginArtifact(dir);
    assert.equal(esm.declaredEntry.ok, true, esm.declaredEntry.refused);
    assert.equal(esm.declaredEntry.declared, './dist/server.js');
    assert.deepEqual(esm.declaredEntry.otherCandidates.map((row) => row.target),
      ['./dist/server.d.ts', './dist/index.js']);
    assert.equal(esm.entryMatchesDeclared, true);
    assert.equal(pluginArtifact(join(dir, 'missing')), null);
    assert.match(staleBuildRefusal(null), /npm run build/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact: a core package.json changed after launch is named', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'cremator-opencode',
      version: '0.1.0',
      exports: { './server': { default: './dist/server.js' } },
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'dist', 'server.js'), 'export const built = 1;\n');
    const core = join(dir, 'node_modules', '@cremator', 'core');
    mkdirSync(join(core, 'dist'), { recursive: true });
    writeFileSync(join(core, 'package.json'), `${JSON.stringify({
      name: '@cremator/core', version: '0.1.0', exports: { '.': './dist/index.js' },
    }, null, 2)}\n`);
    writeFileSync(join(core, 'dist', 'index.js'), 'export const core = 1;\n');
    const before = pluginArtifact(dir);
    assert.equal(before.coreBuild.ok, true, before.coreBuild.refused);
    // The manifest moves after launch; the entry and the dist tree do not. The
    // comparison must name the one field that changed, not stay silent because
    // the entry hash is unchanged.
    writeFileSync(join(core, 'package.json'), `${JSON.stringify({
      name: '@cremator/core', version: '0.1.1', exports: { '.': './dist/index.js' },
    }, null, 2)}\n`);
    const after = pluginArtifact(dir);
    assert.notEqual(after.coreBuild.packageJsonSha256, before.coreBuild.packageJsonSha256);
    assert.equal(after.coreBuild.entrySha256, before.coreBuild.entrySha256);
    assert.equal(after.coreBuild.sha256, before.coreBuild.sha256);
    assert.deepEqual(artifactDrift(before, after).map((row) => row.field),
      ['coreBuild.packageJsonSha256']);
    // An unchanged artifact has no drift at all, so the failure is the change.
    assert.deepEqual(artifactDrift(after, pluginArtifact(dir)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the seeded rows */

test('replay: every seeded table is re-hashed, and a rewrite is named', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'opencode.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, '
      + 'title TEXT, model TEXT, time_created INTEGER, tokens_input INTEGER, tokens_output INTEGER)');
    db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, '
      + 'time_updated INTEGER)');
    db.exec('CREATE TABLE worktree (project_id TEXT, directory TEXT)');
    db.exec('CREATE TABLE todo (session_id TEXT, seq INTEGER, data TEXT)');
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE migration (id TEXT PRIMARY KEY, at INTEGER)');
    db.prepare('INSERT INTO project VALUES (?, ?, ?, ?)').run('proj_1', 'C:/src', 1, 1);
    db.prepare('INSERT INTO worktree VALUES (?, ?)').run('proj_1', 'C:/src');
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'ses_run', 'proj_1', 'C:/src', 'a title', 'mock/mock-model', 1, 10, 2,
    );
    db.prepare('INSERT INTO todo VALUES (?, ?, ?)').run('ses_run', 1, '{"a":1}');
    db.prepare('INSERT INTO todo VALUES (?, ?, ?)').run('ses_run', 2, '{"a":2}');
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('migration.v1-v2', '{"done":true}');
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('models-dev:v2:catalog', '{"cache":"not copied"}');
    db.prepare('INSERT INTO migration VALUES (?, ?)').run('m1', 1);
    db.close();
    const before = seededRowHashes(path, 'ses_run');
    // session_v2 + project + worktree + 2 todo rows + the one kv marker + migration.
    assert.equal(before.rows, 7);
    assert.equal(before.sha256.length, 64);
    assert.deepEqual(before.tables.map((row) => row.table).sort(),
      ['kv', 'migration', 'project', 'session_v2', 'todo', 'worktree']);
    // The host advances the counters it owns: no seeded row looks missing.
    const counters = new DatabaseSync(path);
    counters.prepare('UPDATE session_v2 SET tokens_input = 99, tokens_output = 9').run();
    counters.prepare('UPDATE project SET time_updated = 2').run();
    counters.close();
    assert.deepEqual(missingSeededRows(before, seededRowHashes(path, 'ses_run')), []);
    // A rewrite of a seeded session_v2 content column is named.
    const session = new DatabaseSync(path);
    session.prepare('UPDATE session_v2 SET directory = ?').run('C:/elsewhere');
    session.close();
    assert.equal(missingSeededRows(before, seededRowHashes(path, 'ses_run')).length, 1);
    // A dropped seeded content row is named.
    const todoDrop = new DatabaseSync(path);
    todoDrop.prepare('DELETE FROM todo WHERE seq = 1').run();
    todoDrop.close();
    assert.equal(missingSeededRows(before, seededRowHashes(path, 'ses_run')).length, 2);
    // A dropped migration marker is named too.
    const kvDrop = new DatabaseSync(path);
    kvDrop.exec("DELETE FROM kv WHERE key = 'migration.v1-v2'");
    kvDrop.close();
    assert.equal(missingSeededRows(before, seededRowHashes(path, 'ses_run')).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay: a rewritten message body is a rewrite, not an untouched row', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'opencode.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, '
      + 'time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'msg_1', 'ses_run', 'user', 1, 1, JSON.stringify({ type: 'user', text: 'read it' }),
    );
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'msg_2', 'ses_run', 'assistant', 2, 2,
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'reading' }],
        time: { created: 2 } }),
    );
    db.close();
    const before = seededRowHashes(path, 'ses_run');
    const table = before.tables.find((row) => row.table === 'session_message');
    assert.ok(table, 'session_message is one of the hashed tables');
    assert.equal(table.columns.includes('data'), true,
      'the conversation column is part of the projection');
    assert.equal(table.projection, 'stable-columns');
    assert.match(table.why, /data/u);
    assert.deepEqual(table.excludedSubfields, ['time.completed'],
      'the one host-owned subfield inside data is named');
    // The host stamping the completion on the last assistant message is not a
    // rewrite of the seeded row: only that one subfield is excluded.
    const stamped = new DatabaseSync(path);
    stamped.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'reading' }],
        time: { created: 2, completed: 1_700_000_000 } }),
      'msg_2',
    );
    stamped.close();
    assert.deepEqual(missingSeededRows(before, seededRowHashes(path, 'ses_run')), []);
    // The host appending a row is not a change to a seeded row.
    const appended = new DatabaseSync(path);
    appended.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'msg_3', 'ses_run', 'assistant', 3, 3, JSON.stringify({ type: 'assistant', text: 'done' }),
    );
    appended.close();
    assert.deepEqual(missingSeededRows(before, seededRowHashes(path, 'ses_run')), []);
    // A rewritten message body used to pass: the projection skipped `data`, so
    // the row hashed the same. Now the rewrite is named.
    const rewrite = new DatabaseSync(path);
    rewrite.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'REWRITTEN' }] }),
      'msg_2',
    );
    rewrite.close();
    assert.equal(missingSeededRows(before, seededRowHashes(path, 'ses_run')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the product's own constants */

test('constants: the bench uses the product\'s exports, not local copies', async () => {
  assert.equal(MEASURED_REMOVAL_RULES, LANE_RULES, 'one rule list, imported');
  const product = await productConstantsAtLaunch();
  assert.equal(product.ok, true, product.refused);
  assert.deepEqual([...product.excludeTools], ['subagent']);
  assert.equal(product.recallTool, 'necromancy');
  assert.deepEqual(product.inactiveL1Rules, [],
    'no L1 family is inactive after the fact derivation');
  assert.deepEqual(product.l1Facts.map(fact => fact.rule).sort(),
    ['closed-episode', 'superseded-by-reread'],
    'the launch path carries both derived L1 facts');
  assert.ok(product.l1Facts.every(fact =>
    typeof fact.derives === 'string' && fact.derives.length > 0),
  'each derived fact states how it is proved');
  assert.deepEqual([...product.l1Residuals], [
    'a text-only error body without the host\'s structured error tag is not treated as an error',
    'truncation detection depends on the host\'s English notice',
  ], 'the launch path carries the residual limits verbatim');
});

/* ------------------------------------------------------------------ citable */

test('citable: a claimed subject recorded not-applicable blocks a passing run', () => {
  const base = {
    passed: true, refusal: null, captureAvailable: true, claimed: true, removalMeasured: true,
    restoreProven: true, claim: 'removal', replyFramesAllAnswered: true,
  };
  assert.equal(citableVerdict({ ...base, assertions: [] }).citable, true);
  // A not-applicable the run did not claim (a fresh run's source bound) is
  // recorded but does not block.
  assert.equal(citableVerdict({
    ...base,
    assertions: [{ name: 'reasoning: the source accounting explains every raw byte', blocksCitable: false }],
  }).citable, true);
  // This is the P6 defect: every assertion passes, one claimed subject was
  // recorded not-applicable, and the run is not citable.
  const blocked = citableVerdict({
    ...base,
    assertions: [
      { name: 'reasoning: request 1 carried exactly the sendable source bound', blocksCitable: true },
      { name: 'journal: every request that carried a receipt had its own fresh applied pass',
        blocksCitable: false },
    ],
  });
  assert.equal(blocked.citable, false);
  assert.deepEqual(blocked.citableBlockedBy,
    ['reasoning: request 1 carried exactly the sendable source bound']);
  // A claimed removal with no measured removal stays un-citable.
  assert.equal(citableVerdict({ ...base, removalMeasured: false, assertions: [] }).citable, false);
  // No capture is never citable.
  assert.equal(citableVerdict({ ...base, captureAvailable: false, assertions: [] }).citable, false);
  // A refusal is never citable.
  assert.equal(citableVerdict({ ...base, refusal: { code: 'redirect-not-held' }, assertions: [] }).citable,
    false);
});


/* ------------------------------------------------------------------ the claim label (§P7) */

test('citable: a fresh one-request run with zero reasoning is not citable as reasoning', () => {
  const base = {
    claimed: false, removalMeasured: false, captureAvailable: true, arm: 'test',
  };
  // The pin exempts a fresh run's first request, so this run passes the pin while
  // measuring no reasoning. The label used to read 'reasoning'.
  assert.equal(citableClaim({ ...base, mainRequests: [{ seq: 1, reasoning_messages: 0 }] }),
    'none (no reasoning measured)');
  assert.equal(citableClaim({ ...base, mainRequests: [] }), 'none (no reasoning measured)');
  // One measured request carrying reasoning is the claim.
  assert.equal(citableClaim({ ...base, mainRequests: [
    { seq: 1, reasoning_messages: 1 }, { seq: 2, reasoning_messages: 1 },
  ] }), 'reasoning');
  // A single request that carried reasoning is enough: the claim is about what
  // reached the wire, not about the request count.
  assert.equal(citableClaim({ ...base, mainRequests: [{ seq: 1, reasoning_messages: 1 }] }),
    'reasoning');
  // The other labels keep their own rules.
  assert.equal(citableClaim({
    ...base, claimed: true, removalMeasured: true, restoreProven: true, controlBound: true,
  }), 'removal');
  // A test-arm removal with no bound vanilla control says so and is not citable
  // (audit 19).
  assert.equal(citableClaim({ ...base, claimed: true, removalMeasured: true, restoreProven: true }),
    'removal (control procedural, not bound)');
  assert.equal(citableClaim({ ...base, claimed: true, removalMeasured: false, restoreProven: true,
    controlBound: true }),
  'none (claimed a removal, measured none)');
  // No restore, no removal label (P1).
  assert.equal(citableClaim({ ...base, claimed: true, removalMeasured: false, restoreProven: false,
    controlBound: true }),
  'removal (no restore proven)');
  assert.equal(citableClaim({ ...base, captureAvailable: false }), 'none (no captured request body)');
  /**
   * A vanilla control claim rests on request stability, not a lane
   * (ISSUE-242). A lane pass no longer creates a claim, and a lane miss does
   * not remove one; the stability record decides.
   */
  const stablePairs = {
    pass: true,
    pairs: 2,
    perPair: [
      { from: 1, to: 2, droppedTexts: [], droppedResults: [] },
      { from: 2, to: 3, droppedTexts: [], droppedResults: [] },
    ],
  };
  assert.equal(citableClaim({
    ...base, arm: 'vanilla', controlLaneCount: 2,
    controlLanes: [
      { control: { unit: 'pass', twin: 'pass' } },
      { control: { unit: 'pass', twin: 'pass' } },
    ],
    requestStability: stablePairs,
  }), 'control (no result disappeared without the mount; 0 compaction requests)');
  assert.equal(citableClaim({
    ...base, arm: 'vanilla', controlLaneCount: 1,
    controlLanes: [{ control: { unit: 'fail', twin: 'fail' } }],
    requestStability: stablePairs,
  }), 'control (no result disappeared without the mount; 0 compaction requests)',
  'a lane miss does not unbind a stable control');
  assert.equal(citableClaim({ ...base, arm: 'vanilla', controlLaneCount: 1,
    controlLanes: [{ control: { unit: 'pass', twin: 'pass' } }] }),
  'none (vanilla control: no request stability pair was measured)',
  'a lane pass alone creates no claim');
});

/* ------------------------------------------------------------------ the harness hash (§P6) */

test('harness: every module the runner imports is hashed', () => {
  const fingerprint = harnessFingerprint();
  assert.deepEqual([...fingerprint.files.map((file) => file.name)].sort(), [...HARNESS_MODULES].sort());
  // The list is derived from the runner's own static imports, not compared with
  // a literal. A module the runner imports but the list omits would take part in
  // the verdict and never be hashed while a literal comparison still passed.
  const source = readFileSync(join(BENCH_DIR, 'opencode-run.mjs'), 'utf8');
  const derived = harnessModulesFromSource(source);
  assert.deepEqual([...HARNESS_MODULES].sort(), [...derived].sort());
  assert.ok(HARNESS_MODULES.includes('opencode-run.mjs'), 'the runner itself is hashed');
  for (const name of derived) {
    if (name === 'opencode-run.mjs') continue;
    assert.ok(source.includes(`from './${name}'`), `${name} is imported by the runner it is derived from`);
  }
  // A source that imports one more local module derives one more hashed file:
  // an omitted module cannot hide behind the runner's own file name.
  const extra = harnessModulesFromSource(
    "import './opencode-run.mjs';\nimport './bench-flags.test.mjs';\n");
  assert.deepEqual(extra, ['bench-flags.test.mjs', 'opencode-run.mjs']);
  for (const file of fingerprint.files) {
    assert.equal(file.sha256.length, 64, `${file.name} is hashed`);
    assert.ok(file.bytes > 0, `${file.name} is not empty`);
  }
  assert.equal(fingerprint.sha256.length, 64);
  // The aggregate is over the file names and digests, so a changed module moves it.
  const tampered = {
    files: fingerprint.files.map((file, index) => (index === 0
      ? { ...file, sha256: '0'.repeat(64) } : file)),
  };
  assert.notEqual(createHash('sha256')
    .update(tampered.files.map((file) => `${file.name}\u0000${file.sha256}`).join('\n'))
    .digest('hex'), fingerprint.sha256);
});

test('harness: a local import the list cannot hash is refused, never dropped (P9)', () => {
  // A local module that takes part in the verdict must be hashable. The earlier
  // rule dropped a candidate that was not a file, so an omitted module could
  // compute a verdict the harness fingerprint never covered.
  assert.throws(() => harnessModulesFromSource("import './not-a-file.mjs';\n"),
    /does not resolve to a file/u);
  assert.throws(() => harnessModulesFromSource("import '../outside.mjs';\n"),
    /escapes the bench directory/u);
  // The shared dev arg parser (ISSUE-387) is a launcher dependency: node:util
  // only, no verdict, so it is exempt from the fingerprint while every other
  // ../ import above is still refused.
  assert.deepEqual(harnessModulesFromSource("import '../shared/args.mjs';\n"),
    ['opencode-run.mjs']);
  assert.throws(() => harnessModulesFromSource("import './module.js';\n"),
    /not a \.\/\*\.mjs/u);
  // A comment that quotes an import is not an import.
  assert.deepEqual(harnessModulesFromSource("// from './not-a-file.mjs'\n"),
    ['opencode-run.mjs']);
  assert.deepEqual(harnessModulesFromSource(" * `import './not-a-file.mjs'`\n"),
    ['opencode-run.mjs']);
});

test('module closure: every module is hashed, including one outside dist (P9)', () => {
  const dir = scratch();
  try {
    // The mounted entry imports a local module that is NOT under dist/. The
    // artifact hash covers dist/, so before this rule the module was named by
    // the closure and never hashed.
    writeFileSync(join(dir, 'server.js'), "export { payload } from './outside.js';\n", 'utf8');
    writeFileSync(join(dir, 'outside.js'), 'export const payload = 42;\n', 'utf8');
    const closure = localImportClosure(join(dir, 'server.js'));
    assert.equal(closure.failures.length, 0);
    assert.equal(closure.modules.length, 2);
    for (const module of closure.modules) {
      assert.equal(module.bytes, readFileSync(module.path).length);
      assert.equal(module.sha256,
        createHash('sha256').update(readFileSync(module.path)).digest('hex'),
        `${module.path} is hashed from its own bytes`);
    }
    const relation = moduleEntryRelation(join(dir, 'server.js'), join(dir, 'server.js'),
      { packageRoot: dir });
    assert.equal(relation.pass, true, relation.detail);
    assert.equal(relation.unhashed.length, 0);
    assert.deepEqual(relation.closureHashes.map((row) => row.path).sort(),
      closure.modules.map((row) => row.path).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ the wire check list (§P10) */

/** One captured main request row, in the mock's shape. */
function capturedRow(seq, turn, messages, options = {}) {
  return {
    seq,
    main_turn: turn,
    messages,
    receipt_messages: Array.isArray(options.receiptRecallIds) ? options.receiptRecallIds.length : 0,
    receipt_recall_ids: options.receiptRecallIds ?? [],
    reasoning_messages: options.reasoningMessages ?? 0,
    reasoning_bytes: options.reasoningBytes ?? 0,
    reply_reasoning_text: options.replyReasoningText ?? null,
  };
}

test('citable: a fresh one-request run that measured no reasoning is not citable', () => {
  const mains = [capturedRow(1, 0, [{ role: 'user', content: 'do the task' }],
    { reasoningMessages: 0 })];
  const base = {
    claimed: false, removalMeasured: false, captureAvailable: true, arm: 'test',
  };
  // The reasoning pin exempts a fresh run's first request (there is no earlier
  // turn to carry reasoning from), so this run passes the pin while measuring
  // nothing. The label says so; the verdict must not be citable beside it.
  const claim = citableClaim({ ...base, mainRequests: mains });
  assert.equal(claim, 'none (no reasoning measured)');
  const verdict = citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: false,
    removalMeasured: false, claim, assertions: [],
  });
  assert.equal(verdict.citable, false);
  assert.equal(verdict.claimCitable, false);
  assert.equal(verdict.citableBlockedBy.length, 1, 'the claim itself blocks, and names itself');
  assert.match(verdict.citableBlockedBy[0], /^claim: none \(no reasoning measured\)/u);
  // The same shape with one request carrying reasoning is citable as reasoning.
  const withReasoning = [capturedRow(1, 0, [{ role: 'user', content: 'do the task' }],
    { reasoningMessages: 1 })];
  const measuredClaim = citableClaim({ ...base, mainRequests: withReasoning });
  assert.equal(measuredClaim, 'reasoning');
  assert.equal(citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: false,
    removalMeasured: false, claim: measuredClaim, assertions: [],
    replyFramesAllAnswered: true,
  }).citable, true);
  // A script that supplied no reasoning for an answered turn leaves the label
  // claiming more than the run measured: not citable, though nothing failed.
  const framesMissing = citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: false,
    removalMeasured: false, claim: measuredClaim, assertions: [],
    replyFramesAllAnswered: false,
  });
  assert.equal(framesMissing.citable, false);
  assert.match(framesMissing.citableBlockedBy.join(' '), /no reasoning for some answered/u);
  // P7: the requirement binds every citable claim, not only `reasoning`. A
  // removal citation and a control citation measure a context too, so a script
  // that supplied no reasoning for an answered turn blocks both.
  const removalBlocked = citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: true,
    removalMeasured: true, restoreProven: true, claim: 'removal', assertions: [],
    replyFramesAllAnswered: false,
  });
  assert.equal(removalBlocked.citable, false,
    'a removal citation reads the context the script built, reasoning included');
  assert.match(removalBlocked.citableBlockedBy.join(' '), /^removal: .*no reasoning/u);
  const controlBlocked = citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: false,
    removalMeasured: false, claim: 'control (the unit and its twin survive without the mount)',
    assertions: [], replyFramesAllAnswered: false,
  });
  assert.equal(controlBlocked.citable, false);
  assert.match(controlBlocked.citableBlockedBy.join(' '), /^control \(.*no reasoning/u);
  // The same removal claim with the script's reasoning coverage is citable.
  assert.equal(citableVerdict({
    passed: true, refusal: null, captureAvailable: true, claimed: true,
    removalMeasured: true, restoreProven: true, claim: 'removal', assertions: [],
    replyFramesAllAnswered: true,
  }).citable, true);
});

test('wire: a body with zero reasoning fails the run-level verdict', () => {
  const mains = [
    capturedRow(1, 0, [{ role: 'user', content: 'carry the seeded thinking' }]),
    capturedRow(2, 1, [{ role: 'user', content: 'carry the seeded thinking' }]),
  ];
  const wire = wireVerdict({
    arm: 'test',
    replay: true,
    capture: true,
    mains,
    task: 'carry the seeded thinking',
    sourceReasoning: { bytes: 1200, raw: { bytes: 1200, parts: 3 }, excluded: { bytes: 0, parts: 0 } },
    sourceReasoningTexts: ['the seeded thinking'],
    sourceContent: { strings: [], counts: { textParts: 1, toolResults: 0, toolCallInputs: 0 } },
    ledger: { recallIds: [], recallParts: [] },
    fixture: null,
    script: { replies: [] },
  });
  assert.equal(wire.reasoning.pin.pass, false,
    'a replay whose requests carry zero reasoning fails the pin');
  assert.match(wire.reasoning.pin.detail, /request\(s\) 1, 2 carried 0/u);
  assert.equal(wire.reasoning.measured, false);
  assert.equal(wire.pass, false, 'the run-level verdict fails with the pin');

  // The same bodies with the seed's reasoning on request 1 pass the pin.
  const withReasoning = [
    capturedRow(1, 0, [{ role: 'user', content: 'carry the seeded thinking' }],
      { reasoningMessages: 1, reasoningBytes: 1200 }),
    capturedRow(2, 1, [{ role: 'user', content: 'carry the seeded thinking' }],
      { reasoningMessages: 1, reasoningBytes: 1200, replyReasoningText: 'the reply thinking' }),
  ];
  // Request 2's expected set includes the reply's reasoning, which this body does
  // not carry; the set check is the second half and is tested by its own suite.
  assert.equal(wireVerdict({
    arm: 'test', replay: true, capture: true, mains: withReasoning,
    task: 'carry the seeded thinking',
    sourceReasoning: { bytes: 1200, raw: { bytes: 1200, parts: 3 }, excluded: { bytes: 0, parts: 0 } },
    sourceReasoningTexts: ['the seeded thinking'],
    sourceContent: { strings: [], counts: { textParts: 1, toolResults: 0, toolCallInputs: 0 } },
    ledger: { recallIds: [], recallParts: [] }, fixture: null, script: { replies: [] },
  }).reasoning.pin.pass, true);
});

test('wire: a seeded removal re-carried on request 2 fails the run-level verdict', () => {
  const task = 'the run task';
  const seeded = 'seeded user text';
  const receipt = {
    role: 'user',
    content: '[not retained] big.txt · necromancy recall:sha256:seed',
  };
  const unit = { role: 'assistant', tool_calls: [{ id: 'call_seeded_unit' }] };
  const twin = { role: 'tool', tool_call_id: 'call_twin', content: 'TWIN-BYTES' };
  const ledger = {
    recallIds: ['recall:sha256:seed'],
    recallParts: [{ recallId: 'recall:sha256:seed',
      sourceNodeId: 'oc:ses:tool:call_seeded_unit' }],
    removalRules: [],
  };
  const thinking = (text) => ({ role: 'assistant', reasoning_content: text, content: null });
  const base = {
    arm: 'test',
    replay: true,
    capture: true,
    task,
    sourceReasoning: { bytes: 120, raw: { bytes: 120, parts: 1 }, excluded: { bytes: 0, parts: 0 } },
    sourceReasoningTexts: ['think'],
    sourceContent: {
      // The removed unit's own bytes are a seeded string the adapter took on
      // request 1; the seeded user text and the twin's bytes stay.
      strings: [seeded, 'seeded tool result bytes', 'TWIN-BYTES'],
      counts: { textParts: 1, toolResults: 1, toolCallInputs: 0 },
      perCall: { call_seeded_unit: { resultStrings: ['seeded tool result bytes'] } },
    },
    ledger,
    fixture: null,
    script: { replies: [] },
  };
  // Request 1 proves the removal: it carries the receipt and lacks the unit.
  // Request 2 re-carries the unit under the same receipt.
  const removedThenBack = [
    capturedRow(1, 0, [{ role: 'user', content: seeded }, { role: 'user', content: task },
      thinking('think'), receipt, twin],
    { receiptRecallIds: ['recall:sha256:seed'], reasoningMessages: 1, reasoningBytes: 120 }),
    capturedRow(2, 1, [{ role: 'user', content: seeded }, { role: 'user', content: task },
      thinking('think'), receipt, twin, unit],
    { receiptRecallIds: ['recall:sha256:seed'], reasoningMessages: 1, reasoningBytes: 120 }),
  ];
  const wire = wireVerdict({ ...base, mains: removedThenBack });
  assert.equal(wire.removal.crossCheck.pass, false);
  assert.deepEqual(wire.removal.crossCheck.uncovered.map((row) => row.returned), [[2]]);
  assert.match(wire.removal.crossCheck.uncovered[0].why, /came back on request\(s\) 2/u);
  assert.equal(wire.pass, false);

  // The same rows with request 2 still lacking the unit pass every wired check.
  const staysRemoved = removedThenBack.map((row, index) => (index === 1
    ? capturedRow(2, 1, [{ role: 'user', content: seeded }, { role: 'user', content: task },
      thinking('think'), receipt, twin],
    { receiptRecallIds: ['recall:sha256:seed'], reasoningMessages: 1, reasoningBytes: 120 })
    : row));
  const controlled = wireVerdict({
    ...base, mains: staysRemoved, restore: restorePass(['recall:sha256:seed']),
  });
  assert.equal(controlled.removal.crossCheck.pass, true, JSON.stringify(controlled.removal.crossCheck));
  assert.equal(controlled.pass, true, JSON.stringify({
    pin: controlled.reasoning.pin,
    cumulative: controlled.reasoning.cumulative,
    content: controlled.content,
  }));
});


/* ------------------------------------------------------------------ the ninth audit's fixes */

test('session identity: a fresh run with zero or two session ids has no identity', () => {
  // The defect: `ledger.sessionId === runSessionId` compared null to null when
  // the arm world held no single id, and passed while proving nothing.
  const zero = freshRunSessionIdentity([]);
  assert.equal(zero.pass, false);
  assert.equal(zero.sessionId, null, 'no id is not an identity');
  assert.match(zero.why, /no session id/u);

  const two = freshRunSessionIdentity([
    { path: 'a/opencode.db', exists: true, ok: true, total: 1, ids: ['ses_a'], error: null },
    { path: 'b/opencode.db', exists: true, ok: true, total: 1, ids: ['ses_b'], error: null },
  ]);
  assert.equal(two.pass, false);
  assert.equal(two.sessionId, null, 'two ids are not one identity, and null is not a subject');
  assert.deepEqual(two.sessions, ['ses_a', 'ses_b']);
  assert.match(two.why, /2 session ids/u);

  const one = freshRunSessionIdentity([
    { path: 'a/opencode.db', exists: true, ok: true, total: 1, ids: ['ses_a'], error: null },
    { path: 'b/opencode.db', exists: false, ok: true, total: 0, ids: [], error: null },
  ]);
  assert.equal(one.pass, true);
  assert.equal(one.sessionId, 'ses_a');

  // An existing database that cannot be read could hide a second session, so it
  // is not an identity either even when one readable id is present.
  const unreadable = freshRunSessionIdentity([
    { path: 'a/opencode.db', exists: true, ok: true, total: 1, ids: ['ses_a'], error: null },
    { path: 'b/opencode.db', exists: true, ok: false, total: 0, ids: [], error: 'not a database' },
  ]);
  assert.equal(unreadable.pass, false);
  assert.equal(unreadable.sessionId, null);
  assert.equal(unreadable.unreadable.length, 1);
});

test('replay content: request 2 that drops a seeded user message fails the every-request check', () => {
  const seeded = 'the seeded user text';
  const task = 'do the task';
  const mains = [
    { seq: 1, messages: [
      { role: 'user', content: seeded }, { role: 'user', content: task },
    ] },
    // Request 2 silently drops the seeded user message. The request-1 baseline
    // cannot see it; the every-request containment check names it.
    { seq: 2, messages: [{ role: 'user', content: task }] },
  ];
  const verdict = seededContentEverywhere(mains, [seeded], task);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.requests, 2);
  assert.deepEqual(verdict.failures, [{ seq: 2, missing: [seeded] }]);
  assert.match(verdict.detail, /1 of 2 main request\(s\) dropped seeded content/u);
  assert.equal(replayContentBaseline(mains[0], [seeded], task).pass, true,
    'the request-1 baseline passes, which is exactly why the old check could not see this');

  // The run-level verdict fails on it too.
  const thinking = (text) => ({ role: 'assistant', reasoning_content: text, content: null });
  const base = {
    arm: 'test', replay: true, capture: true, task,
    sourceReasoning: { bytes: 120, raw: { bytes: 120, parts: 1 }, excluded: { bytes: 0, parts: 0 } },
    sourceReasoningTexts: ['think'],
    sourceContent: { strings: [seeded], counts: { textParts: 1, toolResults: 0, toolCallInputs: 0 } },
    ledger: { recallIds: [], recallParts: [] }, fixture: null, script: { replies: [] },
  };
  const captured = (seq, turn, texts) => ({
    seq, main_turn: turn, messages: [...texts.map((text) => ({ role: 'user', content: text })),
      thinking('think')],
    receipt_messages: 0, receipt_recall_ids: [], reasoning_messages: 1, reasoning_bytes: 120,
  });
  const dropped = wireVerdict({
    ...base,
    mains: [captured(1, 0, [seeded, task]), captured(2, 1, [task])],
  });
  assert.equal(dropped.content.baseline.pass, true);
  assert.equal(dropped.content.everywhere.pass, false);
  assert.equal(dropped.pass, false);

  // The same two requests with the seeded text on both pass the containment check.
  const kept = wireVerdict({
    ...base,
    mains: [captured(1, 0, [seeded, task]), captured(2, 1, [seeded, task])],
  });
  assert.equal(kept.content.everywhere.pass, true, kept.content.everywhere.detail);
});

test('request stability: a dropped keepalive read fails without a recall, and a recall explains it (P2)', () => {
  const keep = {
    role: 'tool', tool_call_id: 'call_keep',
    content: 'KEEPALIVE-BYTES: the read that must survive every later request',
  };
  const note = { role: 'assistant', content: 'I will keep this result for later.' };
  const receipt = {
    role: 'user', content: '[not retained] other.txt · necromancy recall:sha256:keep',
  };
  const rowOf = (seq, messages) => ({
    seq, main_turn: seq - 1, messages, receipt_messages: 0, receipt_recall_ids: [],
  });
  const stable = requestContentStability([
    rowOf(1, [note, keep]), rowOf(2, [note, keep]),
  ]);
  assert.equal(stable.pass, true, stable.detail);
  assert.equal(stable.pairs, 1);

  // The rebuild silently drops an unrelated tool result. The seeded-content
  // checks cannot see it: the result was never source content.
  const dropped = [rowOf(1, [note, keep]), rowOf(2, [note])];
  const fail = requestContentStability(dropped);
  assert.equal(fail.pass, false);
  assert.deepEqual(fail.perPair[0].droppedResults.map((row) => row.callId), ['call_keep']);
  assert.match(fail.detail, /request 2/u);
  assert.match(fail.detail, /call_keep/u);
  // A ledger recall naming the call id explains the removal only when its
  // receipt landed at or before the pair. Here no captured request carries the
  // receipt, so the recall has no receipt-bearing request to date the removal.
  assert.equal(requestContentStability(dropped,
    { recalls: [{ recallId: 'recall:sha256:keep', callId: 'call_keep' }] }).pass, false);
  // A receipt line alone does not: the receipt is excluded from the text scan,
  // but the missing result still has no recall naming its call id.
  const receipted = [
    rowOf(1, [note, keep]),
    { ...rowOf(2, [note, receipt]), receipt_messages: 1,
      receipt_recall_ids: ['recall:sha256:keep'] },
  ];
  assert.equal(requestContentStability(receipted).pass, false);
  const exempted = requestContentStability(receipted,
    { recalls: [{ recallId: 'recall:sha256:keep', callId: 'call_keep' }] });
  assert.equal(exempted.pass, true, exempted.detail);
  assert.deepEqual(exempted.perPair[0].exemptedResults,
    [{ callId: 'call_keep', recallId: 'recall:sha256:keep' }]);
  // A recall received in a LATER request does not explain an earlier drop. The
  // recall belongs to request 3; the result vanished between requests 1 and 2,
  // before any receipt named it.
  const lateReceipt = [
    rowOf(1, [note, keep]),
    rowOf(2, [note]),
    { ...rowOf(3, [note, receipt]), receipt_messages: 1,
      receipt_recall_ids: ['recall:sha256:keep'] },
  ];
  const late = requestContentStability(lateReceipt,
    { recalls: [{ recallId: 'recall:sha256:keep', callId: 'call_keep' }] });
  assert.equal(late.pass, false,
    'a recall whose first receipt is later than the pair cannot explain the drop');
  assert.deepEqual(late.perPair[0].droppedResults.map((row) => row.callId), ['call_keep']);
  assert.deepEqual(late.perPair[0].exemptedResults, []);

  // An assistant text that vanishes fails too; it has no call id to exempt it.
  const textFail = requestContentStability([rowOf(1, [note, keep]), rowOf(2, [keep])]);
  assert.equal(textFail.pass, false);
  assert.equal(textFail.perPair[0].droppedTexts.length, 1);
  assert.match(textFail.detail, /assistant text/u);
  // One request has no pair; that is not a stability measurement.
  assert.equal(requestContentStability([rowOf(1, [note, keep])]).pass, false);
});

test('wire: a rebuild that drops a keepalive read after request 1 fails the run-level verdict (P2)', () => {
  const task = 'the run task';
  const seeded = 'seeded user text';
  const thinking = (text) => ({ role: 'assistant', reasoning_content: text, content: null });
  const note = { role: 'assistant', content: 'keepalive note' };
  const keep = { role: 'tool', tool_call_id: 'call_keep', content: 'KEEPALIVE-BYTES' };
  const base = {
    arm: 'test', replay: true, capture: true, task,
    sourceReasoning: { bytes: 120, raw: { bytes: 120, parts: 1 }, excluded: { bytes: 0, parts: 0 } },
    sourceReasoningTexts: ['think'],
    sourceContent: {
      strings: [seeded], counts: { textParts: 1, toolResults: 0, toolCallInputs: 0 },
      perCall: {},
    },
    ledger: { recallIds: [], recallParts: [] }, fixture: null, script: { replies: [] },
  };
  const row = (seq, messages) => ({
    seq, main_turn: seq - 1, messages,
    receipt_messages: 0, receipt_recall_ids: [], reasoning_messages: 1, reasoning_bytes: 120,
  });
  const head = [{ role: 'user', content: seeded }, { role: 'user', content: task },
    thinking('think')];
  const withKeep = [...head, note, keep];
  const kept = [row(1, head), row(2, withKeep), row(3, withKeep)];
  const keptVerdict = wireVerdict({ ...base, mains: kept });
  assert.equal(keptVerdict.content.stability.pass, true, keptVerdict.content.stability.detail);
  assert.equal(keptVerdict.pass, true, JSON.stringify({
    stability: keptVerdict.content.stability, baseline: keptVerdict.content.baseline,
    everywhere: keptVerdict.content.everywhere,
  }));

  // Request 3 drops the keepalive read the run itself produced on request 2.
  // Every seeded string is still there, so only the pair check can name it.
  const dropped = [row(1, head), row(2, withKeep), row(3, [...head, note])];
  const droppedVerdict = wireVerdict({ ...base, mains: dropped });
  assert.equal(droppedVerdict.content.everywhere.pass, true,
    'the seeded containment check cannot see content the run produced after request 1');
  assert.equal(droppedVerdict.content.stability.pass, false);
  assert.match(droppedVerdict.content.stability.detail, /call_keep/u);
  assert.equal(droppedVerdict.pass, false);
});

test('request bodies: consecutive main requests must not share a body hash', () => {
  const distinct = consecutiveBodyHashes([
    { seq: 1, main_turn: 0, body_sha256: 'a'.repeat(64) },
    { seq: 2, main_turn: 1, body_sha256: 'b'.repeat(64) },
    { seq: 3, main_turn: 2, body_sha256: 'c'.repeat(64) },
  ]);
  assert.equal(distinct.pass, true, distinct.detail);

  // The host replayed the same body: named by hash, without reading its effects.
  const replayed = consecutiveBodyHashes([
    { seq: 1, main_turn: 0, body_sha256: 'a'.repeat(64) },
    { seq: 2, main_turn: 1, body_sha256: 'b'.repeat(64) },
    { seq: 3, main_turn: 2, body_sha256: 'b'.repeat(64) },
  ]);
  assert.equal(replayed.pass, false);
  assert.equal(replayed.repeats.length, 1);
  assert.deepEqual(replayed.repeats[0].previous, { seq: 2, mainTurn: 1 });
  assert.deepEqual(replayed.repeats[0].current, { seq: 3, mainTurn: 2 });
  assert.match(replayed.detail, /1 pair\(s\) of consecutive main requests carry the same body/u);

  // A row with no hash is unmeasured, not a pass: the mock always writes one.
  const missing = consecutiveBodyHashes([
    { seq: 1, main_turn: 0, body_sha256: 'a'.repeat(64) },
    { seq: 2, main_turn: 1 },
  ]);
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.missing, [{ seq: 2, mainTurn: 1 }]);
  assert.equal(consecutiveBodyHashes([]).pass, false);
});

test('not-applicable records derive blocksCitable from the claimed subject (P8)', () => {
  // Every subject: claimed means the absence contradicts the claim, so it blocks
  // a citation; not claimed means an honest absence.
  for (const subject of CLAIMED_SUBJECTS) {
    const claimed = absentRecord('a check', 'the subject is absent', { [subject]: true }, subject);
    assert.equal(claimed.status, 'not-applicable');
    assert.equal(claimed.pass, false);
    assert.equal(claimed.blocksCitable, true, `${subject} claimed, so the record must block`);
    assert.equal(claimed.subject, subject);
    const honest = absentRecord('a check', 'the subject is absent', { [subject]: false }, subject);
    assert.equal(honest.blocksCitable, false, `${subject} not claimed, so the absence is honest`);
  }
  // An unknown or unnamed subject is a programming error, not a silent false.
  assert.throws(() => absentRecord('a check', 'x', { wireCapture: true }, 'not-a-subject'),
    /must name a claimed subject/u);
  assert.throws(() => absentRecord('a check', 'x', { wireCapture: true }), /must name a claimed/u);
  // A subject the run never computed a claim for is refused too.
  assert.throws(() => absentRecord('a check', 'x', { wireCapture: true }, 'journal'),
    /no claim was computed/u);

  // Every not-applicable record in the runner whose subject the run claims must
  // carry the flag, and no call site may set it by hand. Both are static facts
  // about the runner, which is where the records are built.
  const source = readFileSync(join(BENCH_DIR, 'opencode-run.mjs'), 'utf8');
  const calls = [];
  const needle = 'checkAbsent(';
  let at = source.indexOf(needle);
  while (at >= 0) {
    calls.push(source.slice(at, at + 900));
    at = source.indexOf(needle, at + needle.length);
  }
  assert.ok(calls.length >= 9, `every call site is checked (${calls.length} found)`);
  for (const call of calls) {
    const span = call.split('});')[0];
    assert.match(span, /subject: '[a-zA-Z]+'/u, `a checkAbsent call names no subject: ${span}`);
    assert.equal(span.includes('blocksCitable'), false,
      `a checkAbsent call sets blocksCitable by hand: ${span}`);
  }
  // The claims map has a key for every subject the call sites can name.
  for (const subject of CLAIMED_SUBJECTS) {
    assert.ok(source.includes(`${subject}:`), `the runner computes a claim for ${subject}`);
  }
});

test('module entry: the product "." entry must not load code the mounted entry does not', () => {
  const dir = scratch();
  try {
    const root = join(dir, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'plugin.js'), 'export const shared = 1;\n');
    writeFileSync(join(root, 'dist', 'server.js'),
      "import { shared } from './plugin.js';\nexport default shared;\n");
    writeFileSync(join(root, 'dist', 'index.js'), "export { shared } from './plugin.js';\n");
    const productEntry = join(root, 'dist', 'index.js');
    const mountedEntry = join(root, 'dist', 'server.js');

    // The shipped layout: two files, but a barrel over modules the mount loads.
    const barrel = moduleEntryRelation(productEntry, mountedEntry, { packageRoot: root });
    assert.equal(barrel.pass, true, barrel.detail);
    assert.equal(barrel.sameFile, false);
    assert.equal(barrel.reachableFromMounted, false, 'server.js never imports index.js');
    assert.deepEqual(barrel.extraModules, []);
    assert.equal(barrel.sharedModules.length, 1);
    assert.match(barrel.detail, /adds no code the host does not run/u);

    // The same file is the easy case.
    const same = moduleEntryRelation(mountedEntry, mountedEntry, { packageRoot: root });
    assert.equal(same.pass, true);
    assert.equal(same.sameFile, true);

    // The tenth audit's stub: a `"."` entry that imports nothing. Its closure is
    // itself, so the old subset test found no extra module and passed while the
    // entry shared no code with the file the host mounts.
    writeFileSync(join(root, 'dist', 'index-stub.js'), 'export const unrelated = 1;\n');
    const stub = moduleEntryRelation(join(root, 'dist', 'index-stub.js'), mountedEntry,
      { packageRoot: root });
    assert.equal(stub.pass, false, 'a stub entry that shares no module must fail');
    assert.deepEqual(stub.extraModules, []);
    assert.deepEqual(stub.sharedModules, []);
    assert.match(stub.detail, /shares no module/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('module entry: both entries must export the product constants as the same values', async () => {
  const dir = scratch();
  try {
    const root = join(dir, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'shared.js'), [
      "export const OPENCODE_TEST_EXCLUDE_TOOLS = Object.freeze(['subagent']);",
      "export const OPENCODE_RECALL_TOOL_NAME = 'necromancy';",
      "export const OPENCODE_SUBAGENT_TOOL = 'subagent';",
      'export const OPENCODE_CAPABILITIES = Object.freeze({ mutateResult: false, log: true });',
      '',
    ].join('\n'));
    // The mounted entry exports its plugin definition only; the constants live
    // in the modules its closure loads, which is the shipped layout.
    writeFileSync(join(root, 'dist', 'server.js'),
      "import './shared.js';\nexport default { id: 'pkg' };\n");
    writeFileSync(join(root, 'dist', 'index.js'),
      "export * from './shared.js';\n");
    const productEntry = join(root, 'dist', 'index.js');
    const mountedEntry = join(root, 'dist', 'server.js');

    const same = await exportIdentity(productEntry, mountedEntry);
    assert.equal(same.pass, true, same.detail);
    assert.deepEqual(same.names.map((row) => row.name).sort(), [
      'OPENCODE_CAPABILITIES', 'OPENCODE_RECALL_TOOL_NAME', 'OPENCODE_SUBAGENT_TOOL',
      'OPENCODE_TEST_EXCLUDE_TOOLS',
    ]);
    assert.equal(same.names.every((row) => row.mounted.length === 1), true,
      'each constant is found in one mounted module');

    // The same code, one constant shadowed with a different value: the closure
    // relation passes, the value comparison must not.
    writeFileSync(join(root, 'dist', 'index-shadowed.js'),
      "export * from './shared.js';\n"
      + "export const OPENCODE_TEST_EXCLUDE_TOOLS = Object.freeze(['other']);\n");
    const shadowed = await exportIdentity(join(root, 'dist', 'index-shadowed.js'), mountedEntry);
    assert.equal(shadowed.pass, false);
    const exclude = shadowed.names.find((row) => row.name === 'OPENCODE_TEST_EXCLUDE_TOOLS');
    assert.equal(exclude.same, false);
    assert.match(shadowed.detail, /OPENCODE_TEST_EXCLUDE_TOOLS/u);
    // The relation alone cannot see it: the shadowed barrel loads only the
    // mounted entry's own module.
    assert.equal(moduleEntryRelation(join(root, 'dist', 'index-shadowed.js'), mountedEntry,
      { packageRoot: root }).pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('module entry: an extra module, a foreign root and an unwalkable closure fail', () => {
  const dir = scratch();
  try {
    const root = join(dir, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'plugin.js'), 'export const shared = 1;\n');
    writeFileSync(join(root, 'dist', 'server.js'),
      "import { shared } from './plugin.js';\nexport default shared;\n");
    const mountedEntry = join(root, 'dist', 'server.js');

    // A checked entry that loads its own module is not the code the host runs.
    writeFileSync(join(root, 'dist', 'extra.js'), 'export const onlyHere = 2;\n');
    writeFileSync(join(root, 'dist', 'index-extra.js'),
      "export { shared } from './plugin.js';\nexport { onlyHere } from './extra.js';\n");
    const extra = moduleEntryRelation(join(root, 'dist', 'index-extra.js'), mountedEntry,
      { packageRoot: root });
    assert.equal(extra.pass, false);
    assert.deepEqual(extra.extraModules, [join(root, 'dist', 'extra.js')]);
    assert.match(extra.detail, /never loads/u);

    // An entry outside the mounted package cannot be covered by its dist hash.
    const outside = join(dir, 'outside.js');
    writeFileSync(outside, "export { shared } from './pkg/dist/plugin.js';\n");
    const foreign = moduleEntryRelation(outside, mountedEntry, { packageRoot: root });
    assert.equal(foreign.pass, false);
    assert.equal(foreign.insidePackageRoot, false);
    assert.match(foreign.detail, /outside the package root/u);

    // A relative specifier that names no file is a failure, not a smaller closure.
    writeFileSync(join(root, 'dist', 'index-missing.js'), "export { x } from './missing.js';\n");
    const missing = moduleEntryRelation(join(root, 'dist', 'index-missing.js'), mountedEntry,
      { packageRoot: root });
    assert.equal(missing.pass, false);
    assert.match(JSON.stringify(missing.failures), /missing\.js/u);

    // A module the lexer cannot parse is a failure too: the subset check would
    // otherwise pass by omission.
    writeFileSync(join(root, 'dist', 'broken.js'), 'export { \n');
    writeFileSync(join(root, 'dist', 'index-broken.js'), "export { x } from './broken.js';\n");
    const broken = moduleEntryRelation(join(root, 'dist', 'index-broken.js'), mountedEntry,
      { packageRoot: root });
    assert.equal(broken.pass, false);
    assert.equal(broken.failures.length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removal checks: a passing lane does not measure a call-id-only seeded removal (P2)', () => {
  const { script, fixture, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The lane passes on its own, and the source session also carried a removal
  // this run can only check by call id. `removals.measured` must be false: a
  // seeded removal whose bytes were never proven absent is an unproven removal.
  const seeded = {
    recallIds: [...ledger.recallIds, 'recall:sha256:seed'],
    recallParts: [
      ...ledger.recallParts,
      { recallId: 'recall:sha256:seed', sourceNodeId: 'oc:ses:tool:call_seed' },
    ],
    removalRules: [
      ...ledger.removalRules,
      { ruleId: 'superseded-read', recallId: 'recall:sha256:seed' },
    ],
  };
  const ids = ['recall:sha256:rrr', 'recall:sha256:seed'];
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 2, ids),
    row(4, 3, [twin, receipt], 2, ids),
  ];
  const checks = removalChecks({
    arm: 'test', fixture, script, ledger: seeded, mains, capture: true,
    journal: { available: true, atRest: [{ reason: 'step', status: 'applied', intentId: 'i-1' }] },
    seededRecallIds: ['recall:sha256:seed'],
  });
  assert.equal(checks.lanesMeasured, true, 'the lane itself measures the removal');
  assert.equal(checks.crossCheck.pass, true);
  assert.equal(checks.journalApplied, true);
  assert.equal(checks.seedRemovalCallIdOnly, true);
  assert.equal(checks.seedRemoval, 'call-id only');
  assert.equal(checks.removalMeasured, false,
    'a seeded removal checked by call id only leaves the run not measured');

  // Without the seeded recall the same lane and cross-check do measure the run.
  const clean = removalChecks({
    arm: 'test', fixture, script, ledger, mains: [
      row(1, 0, [unit], 0, []),
      row(2, 1, [unit, unitResult], 0, []),
      row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
      row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
    ], capture: true,
    restore: restorePass(ledger.recallIds),
    journal: { available: true, atRest: [{ reason: 'step', status: 'applied', intentId: 'i-1' }] },
  });
  assert.equal(clean.seedRemovalCallIdOnly, false);
  assert.equal(clean.removalMeasured, true);
});

test('removal lane: a write result echoing the file bytes does not fail the sentinel count (P7)', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The script issues the write. A call id the script never issued would now be
  // counted whatever name it declares (P4), so the echo must be the script's
  // own write for this to be the tool-name case.
  script.replies[1].reply.calls.push({ id: 'call_w', name: 'write' });
  // The stale-style write returns the content it wrote, which carries the file
  // sentinel. With the count unaware of the tool name, two results carry the
  // sentinel and the lane fails although the removal reached the model.
  const writeCall = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_w', function: { name: 'write' } }],
  };
  const writeEcho = {
    role: 'tool', tool_call_id: 'call_w', content: 'FILE-SENTINEL written by the host',
  };
  const mains = [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [writeCall, writeEcho, twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [writeCall, writeEcho, twin, receipt], 1, ['recall:sha256:rrr']),
  ];
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, mains);
  assert.equal(verdict.sentinelResults.toolNames.length, 1);
  assert.equal(verdict.sentinelResults.toolNames[0], 'read');
  assert.equal(verdict.sentinelResults.pass, true, JSON.stringify(verdict.sentinelResults));
  const writeRow = verdict.requests.find((row) => row.seq === 3);
  assert.equal(writeRow.unitResults[0].resultMessages, 1);
  assert.equal(writeRow.unitResults[0].excludedResults.length, 1);
  assert.equal(writeRow.unitResults[0].excludedResults[0].toolName, 'write');
  assert.equal(verdict.removalMeasured, true, 'the removal reached the model, so the lane measures');

  // The same echo addressed to a call that names no tool is counted, so a second
  // copy can never hide behind a missing name.
  const orphanEcho = { role: 'tool', tool_call_id: 'call_orphan', content: 'FILE-SENTINEL x' };
  const orphanRow = (seq, turn) => ({
    seq, main_turn: turn, messages: [orphanEcho, twin, receipt],
    receipt_messages: 1, receipt_recall_ids: ['recall:sha256:rrr'], tool_results_bytes: 60_000,
  });
  const withOrphan = removalLaneVerdict(lane, fixture, script, ledger, [
    ...mains.slice(0, 2),
    orphanRow(3, 2),
    orphanRow(4, 3),
  ]);
  assert.equal(withOrphan.sentinelResults.pass, false,
    'an unattributable carrier is counted, so two carriers fail the count');
  assert.match(withOrphan.sentinelResults.failures[0].why, /name no tool/u);
});

test('removal lane: a receipt target carrying one line of the removed result fails (P4)', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // A superseded lane has no content marker: its twin carries the same file
  // bytes. The receipt target is a node id and never file bytes, so a receipt
  // that puts the file sentinel in its target slot is the removed result hiding
  // in the one line the scan used to skip whole.
  const leaking = {
    role: 'user',
    content: '[not retained] FILE-SENTINEL still here · necromancy recall:sha256:rrr',
  };
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, leaking], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, leaking], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(verdict.bodies.pass, false, verdict.bodies.statement);
  assert.match(verdict.bodies.statement, /never left/u);
  assert.equal(verdict.removalMeasured, false);
  // The plain product line with the same recall id passes, so the failure is
  // the sentinel inside the allowed line and nothing else.
  const clean = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(clean.bodies.pass, true, clean.bodies.statement);
});

test('removal lane: a removed result re-keyed to a non-read call counts (P4)', () => {
  const { script, fixture, lane, ledger, unit, unitResult, twin, receipt, row } = synthetic();
  // The script never issues `call_rekeyed`. A host can keep the removed bytes
  // under a new call id and label that call `write`; the old rule excluded it
  // by tool name, so the second copy was invisible. An unissued call id is not
  // the script's own write echo and must count.
  const writeCall = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_rekeyed', function: { name: 'write' } }],
  };
  const rekeyed = {
    role: 'tool', tool_call_id: 'call_rekeyed', content: 'FILE-SENTINEL re-keyed bytes',
  };
  const verdict = removalLaneVerdict(lane, fixture, script, ledger, [
    row(1, 0, [unit], 0, []),
    row(2, 1, [unit, unitResult], 0, []),
    row(3, 2, [writeCall, rekeyed, twin, receipt], 1, ['recall:sha256:rrr']),
    row(4, 3, [writeCall, rekeyed, twin, receipt], 1, ['recall:sha256:rrr']),
  ]);
  assert.equal(verdict.sentinelResults.pass, false, JSON.stringify(verdict.sentinelResults));
  const rekeyedRow = verdict.requests.find((entry) => entry.seq === 3);
  assert.equal(rekeyedRow.unitResults[0].excludedResults.length, 0,
    'an unissued call id is never excluded by its declared tool name');
  assert.equal(rekeyedRow.unitResults[0].unattributedResults.length, 1);
  assert.equal(rekeyedRow.unitResults[0].unattributedResults[0].toolName, 'write');
  assert.match(verdict.sentinelResults.failures[0].why, /2 read-side result message/u);
});
