/**
 * Focused tests for `replay-depth-table.mjs` (ISSUE-510).
 *
 * The pure parts are tested on synthetic rows: the surface fold (append,
 * in-place replace, compaction `shadowedSeqs`), the seed-wire projection, the
 * corrected and legacy asks, the partial-line byte arithmetic and the stub
 * answer's determinism. The pinned-world cases need the 2026-11-18 evidence
 * under `scratchpad/launch/` (disposable by law) and SKIP, naming the path,
 * when it is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSONL_20_REFUSAL_CODES, readJsonl20NoKeepallAnswer } from '@cremator/core';
import { BULK_CODE_OF } from 'cremator-dsh';
import {
  LEGACY_FORK_FRAME, MOMENTS, PRODUCT_REFUSAL_CODE, assertAllGated, classifyRecordedBaseline,
  computeOffline, correctedAsk, entryRowsOfPlan, foldSurface, legacyBulkAsk, lineCountOf, loadKey,
  mergeLiveEvidence, offlineBaselineOf, partialFreedBytes, readAnswerFor, seedWireOf,
  splitComparable, stubAnswerText, totalsOf,
} from './replay-depth-table.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'replay-depth-table.mjs');
const WORLD = path.resolve(HERE, '..', '..', 'scratchpad', 'launch', '2026-11-18-leak-safe-110');
const hasWorld = fs.existsSync(WORLD);
const skip = hasWorld ? false : `input absent: ${WORLD} (scratchpad/ is disposable by law)`;
const LIVE_FILES = [
  path.resolve(HERE, '..', '..', 'scratchpad', 'launch', '2026-11-23-replay-depth-table-live',
    'replay-depth-table-deepseek.json'),
  path.resolve(HERE, '..', '..', 'scratchpad', 'launch', '2026-11-23-replay-depth-table-live-2',
    'replay-depth-table-deepseek.json'),
];
const skipLive = skip !== false ? skip
  : LIVE_FILES.every((file) => fs.existsSync(file)) ? false
    : `live evidence absent: ${LIVE_FILES.join(', ')}`;

const unitOf = (text, lines) => ({
  id: 'unit:test', nodeId: 'node:test',
  source: { nodeId: 'node:test', sha256: '0'.repeat(64), byteLength: Buffer.byteLength(text) },
  path: 'a.ts',
  span: { byteRange: { startByte: 0, endByteExclusive: Buffer.byteLength(text) },
    lineRange: lines > 0 ? { startLine: 1, endLineInclusive: lines } : null },
  byteLength: Buffer.byteLength(text),
});
const rowOf = (index, unit) => ({
  index, unit, anchor: { kind: 'Read', path: 'a.ts', callOrdinal: 1, anchors: ['1: line'] },
});

test('foldSurface drops shadowedSeqs only at the checkpoint that owns them', () => {
  const rows = [
    { seq: 0, type: 'system/message', surfaceOp: 'append' },
    { seq: 1, type: 'tool/result', surfaceOp: 'append' },
    { seq: 2, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    { seq: 3, type: 'compaction/summary',
      data: { compactionId: 'c1', shadowedSeqs: [0] } },
    { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      data: { source: { kind: 'compact-checkpoint', compactionId: 'c1' } } },
  ];
  const folded = foldSurface(rows);
  assert.deepEqual(folded.surface, [4, 2]);
  assert.equal(folded.gaps, 0);
  assert.equal(folded.unappliedShadows, 0);

  const unrelated = foldSurface([
    { seq: 0, type: 'system/message', surfaceOp: 'append' },
    { seq: 1, type: 'tool/result', surfaceOp: 'append' },
    { seq: 2, type: 'compaction/summary', data: { compactionId: 'c1', shadowedSeqs: [1] } },
    { seq: 3, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
  ]);
  assert.deepEqual(unrelated.surface, [3, 1], 'an unrelated replace never drops another compaction\u2019s seqs');
  assert.equal(unrelated.unappliedShadows, 1);

  const orphan = foldSurface([
    { seq: 0, type: 'system/message', surfaceOp: 'append' },
    { seq: 1, type: 'compaction/summary', data: { compactionId: 'c1', shadowedSeqs: [0] } },
  ]);
  assert.deepEqual(orphan.surface, [0], 'no checkpoint arrived, so nothing is shadowed');
  assert.equal(orphan.unappliedShadows, 1);

  const gap = foldSurface([{ seq: 0, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 } }]);
  assert.equal(gap.gaps, 1);
});

test('seedWireOf reproduces the capture projection', () => {
  const rows = [
    { seq: 0, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'SYS' }] } } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":1}' },
      { type: 'text', text: 'done' },
    ] } } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'body' }] } } },
  ];
  const wire = seedWireOf(rows, [0, 1, 2, 3], [{ name: 'read' }]);
  assert.equal(wire.system, '');
  assert.deepEqual(wire.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(wire.messages[2].text, '[tool call read {"p":1}]done');
  assert.equal(wire.messages[3].text, 'body');
  assert.equal(wire.droppedBlocks, 1, 'the reasoning block is dropped, never sent');
  assert.equal(wire.droppedMessages, 0);
});

test('the corrected ask is the three-piece nokeepall message at 70 and 40', () => {
  const unit = unitOf('aaa\nbbbb\ncc\n', 3);
  const rows = [rowOf(1, unit)];
  assert.equal(lineCountOf(unit), 3);
  assert.equal(entryRowsOfPlan(rows)[0].lineCount, 3);

  const first = correctedAsk(rows, true);
  const later = correctedAsk(rows, false);
  assert.match(first, /keep at most 70 percent/);
  assert.match(later, /keep at most 40 percent/);
  assert.match(first, /\[3 lines\]/);
  assert.match(first, /\[Read\] a\.ts/);
  assert.notEqual(first, later);

  const legacy = legacyBulkAsk(rows);
  assert.ok(legacy.startsWith(LEGACY_FORK_FRAME));
  assert.notEqual(legacy, first);
});

test('a zero-line row is read with the sentinel L=1 and cannot throw', () => {
  const rows = [rowOf(1, unitOf('', 0))];
  assert.equal(lineCountOf(rows[0].unit), null);
  const outside = readAnswerFor(rows, '{"1":{"keeplines":[[1,2]],"summary":"x"}}');
  assert.equal(outside.rows[0].status, 'refused');
  assert.equal(outside.rows[0].code, 'spans-outside-result');
  // The reader normalizes `[[1,1]]` to `keepall`; a zero-line row refuses BOTH
  // spellings, as judge-tables.ts does.
  const whole = readAnswerFor(rows, '{"1":{"keeplines":[[1,1]],"summary":"None"}}');
  assert.equal(whole.rows[0].status, 'refused');
  assert.equal(whole.rows[0].code, 'spans-outside-result');
  const keep = readAnswerFor(rows, '{"1":{"keepall":true}}');
  assert.equal(keep.rows[0].status, 'refused');
  assert.equal(keep.rows[0].code, 'action-not-in-grammar', 'a direct keepall is the reader\u2019s own refusal');
  const forget = readAnswerFor(rows, '{"1":{"forgetall":true,"summary":"gone"}}');
  assert.equal(forget.rows[0].status, 'answered');
  // The non-zero row keeps the whole-range shape: normalized to a clean keep.
  const oneLine = [rowOf(1, unitOf('x\n', 1))];
  const normalized = readAnswerFor(oneLine, '{"1":{"keeplines":[[1,1]],"summary":"None"}}');
  assert.equal(normalized.rows[0].status, 'answered');
  assert.equal(normalized.rows[0].answer.action, 'keepall');
  assert.equal(normalized.rows[0].keepallSource, 'normalized-keeplines',
    'a whole keep is the reader\u2019s normalization, never a literal keepall');
  // The literal spelling is refused under this grammar, so no accepted keepall
  // can be confused with it.
  const literal = readAnswerFor(oneLine, '{"1":{"keepall":true}}');
  assert.equal(literal.rows[0].status, 'refused');
  assert.equal(literal.rows[0].code, 'action-not-in-grammar');
});

test('the replay refusal map is the product map for every code', () => {
  // The product's closed vocabulary, pinned here so a change to the export is
  // reviewed rather than silently absorbed.
  const expected = {
    'answer-unreadable': 'answer-unreadable',
    'missing-index': 'missing-index',
    'duplicate-index': 'duplicate-index',
    'action-not-in-grammar': 'action-not-in-grammar',
    'malformed-row': 'malformed-row',
    'mixed-keys': 'malformed-row',
    'both-forgotten-and-summary': 'malformed-row',
    'summary-missing': 'malformed-row',
    'summary-too-long': 'malformed-row',
    'bad-range': 'malformed-row',
    'ranges-unordered': 'malformed-row',
    'spans-outside-result': 'spans-outside-result',
  };
  const rowCodes = JSONL_20_REFUSAL_CODES.filter((code) => code !== 'unknown-index');
  assert.deepEqual(Object.keys(expected).sort(), [...rowCodes].sort(),
    'the pinned map covers every row-refusal code and no other');
  assert.equal(PRODUCT_REFUSAL_CODE, BULK_CODE_OF, 'the replay imports the product map, never a copy');
  for (const code of rowCodes) {
    assert.equal(BULK_CODE_OF[code], expected[code], `product map: ${code}`);
    assert.equal(PRODUCT_REFUSAL_CODE[code], BULK_CODE_OF[code], `replay map: ${code}`);
  }
});

test('row refusals report the product vocabulary and keep the jsonl-20 detail', () => {
  const rows = [rowOf(1, unitOf('x\n', 1))];
  const reading = readAnswerFor(rows, '{"1":{"forgetall":true}}');
  assert.equal(reading.rows[0].status, 'refused');
  assert.equal(reading.rows[0].code, 'malformed-row');
  assert.equal(reading.rows[0].detail, 'summary-missing');
});

const FAILED_MOMENTS = new Set([
  'racoons-n1-correct r23', 'racoons-n2-correct r12', 'racoons-n3-correct-3 r17',
]);

test('a failed recording is not a real zero: the signals decide, not the counters', () => {
  const failed = classifyRecordedBaseline([
    { kind: 'prune-recorded', round: 4,
      l2RemovalCount: { keeplines: 0, forgetall: 0, forgetlines: 0 },
      tableAttempts: [1, 2, 3].map(() => ({ tableUnits: 7, answered: 0,
        refusedByCode: { 'answer-unreadable': 7 } })) },
    { kind: 'prune-apply-skipped', round: 4, reason: 'no-removals' },
  ], 4);
  assert.equal(failed.failed, true);
  assert.equal(failed.comparable, false);
  assert.match(failed.reason, /answer-unreadable on every row of all 3 attempt/);
  assert.match(failed.reason, /l2RemovalCount all zero/);
  assert.match(failed.reason, /prune-apply-skipped no-removals/);

  // A real zero: the table was ANSWERED on every attempt and every row kept its
  // unit, so the same l2 zeros and the same missing apply follow from verdicts.
  const realZero = classifyRecordedBaseline([
    { kind: 'prune-recorded', round: 4,
      l2RemovalCount: { keeplines: 0, forgetall: 0, forgetlines: 0 },
      tableAttempts: [{ tableUnits: 7, answered: 7,
        refusedByCode: { 'answer-unreadable': 0 } }] },
    { kind: 'prune-apply-skipped', round: 4, reason: 'no-removals' },
  ], 4);
  assert.equal(realZero.failed, false, 'a real zero is not a failed recording');
  assert.equal(realZero.comparable, true);
  assert.match(realZero.reason, /real zero/);

  // One failed signal without the others is neither: the gate names it.
  const ambiguous = classifyRecordedBaseline([
    { kind: 'prune-recorded', round: 4,
      l2RemovalCount: { keeplines: 0, forgetall: 0, forgetlines: 0 },
      tableAttempts: [{ tableUnits: 7, answered: 0,
        refusedByCode: { 'answer-unreadable': 7 } }] },
  ], 4);
  assert.equal(ambiguous.failed, null);
  assert.equal(ambiguous.comparable, false);
  assert.match(ambiguous.reason, /mixed signals/);
});

test('the comparable aggregate drops a failed baseline and keeps a real zero', () => {
  const readings = [
    { moment: { run: 'a', round: 1 }, recorded: { units: 2, bytesFreed: 100 },
      recordedComparable: true, newUnits: 3, newBytesFreed: 150 },
    { moment: { run: 'a', round: 2 }, recorded: { units: 0, bytesFreed: 0 },
      recordedComparable: false, newUnits: 4, newBytesFreed: 400 },
    { moment: { run: 'a', round: 3 }, recorded: { units: 1, bytesFreed: 50 },
      recordedComparable: true, newUnits: 0, newBytesFreed: 0 },
    { moment: { run: 'a', round: 4 }, recorded: { units: 0, bytesFreed: 0 },
      recordedComparable: true, newUnits: 0, newBytesFreed: 0 },
  ];
  const all = totalsOf(readings);
  assert.equal(all.moments, 4);
  assert.equal(all.deltaUnits, 7 - 3);
  assert.equal(all.deltaBytes, 550 - 150);
  const comp = splitComparable(readings);
  assert.equal(comp.label, 'COMPARABLE-3');
  assert.equal(comp.moments, 3, 'the real zero (a r4) stays in the comparable subset');
  assert.equal(comp.recordedUnits, 3);
  assert.equal(comp.recordedBytesFreed, 150);
  assert.equal(comp.newUnits, 3);
  assert.equal(comp.newBytesFreed, 150);
  assert.equal(comp.deltaUnits, 0, 'the failed baseline no longer credits the delta');
  assert.equal(comp.deltaBytes, 0);
  assert.deepEqual(comp.excluded, ['a r2']);
});

test('offlineBaselineOf prints both aggregates and names the excluded moments', () => {
  const results = [
    { moment: { run: 'a', round: 1 }, recorded: { units: 2, bytesFreed: 100, failed: false },
      recordedComparable: true, tableUnits: 2, tableBytesAtStake: 120 },
    { moment: { run: 'a', round: 2 }, recorded: { units: 0, bytesFreed: 0, failed: true },
      recordedComparable: false, tableUnits: 5, tableBytesAtStake: 500 },
  ];
  const baseline = offlineBaselineOf(results);
  assert.equal(baseline.recordedUnits, 2);
  assert.equal(baseline.tableUnits, 7);
  assert.equal(baseline.comparable.label, 'COMPARABLE-1');
  assert.equal(baseline.comparable.tableUnits, 2);
  assert.equal(baseline.comparable.deltaBytesAtStake, 20, 'the failed zero is not a 500-byte win');
  assert.deepEqual(baseline.comparable.excluded, ['a r2']);
});

test('loadKey reads only the refs block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-key-'));
  fs.mkdirSync(path.join(home, '.dsh'));
  fs.writeFileSync(path.join(home, '.dsh', '.credentials.yaml'),
    'version: 1\nother:\n  DEEPSEEK_API_KEY: decoy\nrefs:\n  DEEPSEEK_API_KEY: refs-value\n');
  assert.equal(loadKey(home).key, 'refs-value');
});

test('partialFreedBytes frees the kept lines\u2019 complement', () => {
  const text = 'aaa\nbbbb\ncc\n';
  const unit = unitOf(text, 3);
  const bytes = Buffer.from(text);
  assert.equal(partialFreedBytes(unit, bytes, [{ from: 1, to: 1 }]), Buffer.byteLength('bbbb\ncc\n'));
  assert.equal(partialFreedBytes(unit, bytes, [{ from: 1, to: 3 }]), 0);
  assert.equal(partialFreedBytes(unit, bytes, [[1, 2]]), Buffer.byteLength('cc\n'));
});

test('the stub answer is deterministic and exercises both verdicts and a refusal', () => {
  const rows = [rowOf(1, unitOf('a\nb\nc\n', 3)), rowOf(2, unitOf('x\n', 1)), rowOf(3, unitOf('y\n', 1))];
  const once = stubAnswerText(rows);
  assert.equal(stubAnswerText(rows), once);
  const counts = new Map(rows.map((r) => [r.index, lineCountOf(r.unit)]));
  const reading = readJsonl20NoKeepallAnswer(once, rows.map((r) => r.index), counts);
  const byIndex = new Map(reading.rows.map((r) => [r.index, r]));
  assert.equal(byIndex.get(1).status, 'answered');
  assert.equal(byIndex.get(1).answer.action, 'keeplines');
  assert.equal(byIndex.get(2).status, 'answered');
  assert.equal(byIndex.get(2).answer.action, 'forgetall');
  assert.equal(byIndex.get(3).status, 'refused');
  assert.equal(byIndex.get(3).code, 'action-not-in-grammar', 'the stub keepall is a refusal in this grammar');
});

test('the send lane refuses when any gate failed', () => {
  assert.equal(assertAllGated([{ moment: { run: 'a', round: 1 }, ok: true }]), null);
  const blocked = assertAllGated([
    { moment: { run: 'a', round: 1 }, ok: true },
    { moment: { run: 'b', round: 7 }, ok: false },
  ]);
  assert.match(blocked, /b r7/);
});

test('no 15-moment replay is a PAYABLE claim: send needs the owner and a grant', () => {
  const noOwner = spawnSync(process.execPath, [SCRIPT, '--transport', 'deepseek',
    '--token-grant', '1000', '--kill-ms', '60000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(noOwner.status, 2);
  assert.match(noOwner.stderr, /--i-am-the-owner/);

  const noGrant = spawnSync(process.execPath, [SCRIPT, '--transport', 'deepseek',
    '--i-am-the-owner', '--kill-ms', '60000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(noGrant.status, 2);
  assert.match(noGrant.stderr, /--token-grant/);
});

test('the 15 moments replay green and pin the first ask', { skip }, () => {
  const corpus = computeOffline(WORLD);
  assert.equal(corpus.results.length, 15);
  for (const result of corpus.results) {
    assert.equal(result.ok, true, `${result.moment.run} r${result.moment.round}: `
      + result.gates.filter((g) => !g.ok).map((g) => `${g.name} ${g.detail}`).join('; '));
    assert.equal(result.firstTrigger, result.moment.round === 1);
    // Every moment carries the classification gate, and it agrees with the
    // three failed recordings by name.
    const gate = result.gates.find((g) => g.name === 'recorded-baseline');
    assert.ok(gate !== undefined, `${result.moment.run} r${result.moment.round} has no recorded-baseline gate`);
    assert.equal(gate.ok, true);
    const label = `${result.moment.run} r${result.moment.round}`;
    if (FAILED_MOMENTS.has(label)) {
      assert.equal(result.recordedFailed, true, `${label} is a failed recording`);
      assert.equal(result.recordedComparable, false);
      assert.equal(result.recorded.units, 0, 'the raw zero stays for display');
      assert.equal(result.recorded.bytesFreed, 0);
      assert.equal(result.deltaTableUnits, null, 'no delta against a table that never parsed');
      assert.equal(result.deltaTableBytes, null);
      assert.match(gate.detail, /FAILED RECORDING/);
      assert.match(gate.detail, /excluded from the comparable aggregate/);
    } else {
      assert.equal(result.recordedComparable, true, `${label} is a comparable baseline`);
      assert.equal(result.recordedFailed, false);
      assert.equal(typeof result.deltaTableUnits, 'number');
    }
  }
  const excluded = corpus.results.filter((r) => r.recordedFailed)
    .map((r) => `${r.moment.run} r${r.moment.round}`).sort();
  assert.deepEqual(excluded, [...FAILED_MOMENTS].sort());
  const pinOf = (run, round) => corpus.results.find(
    (r) => r.moment.run === run && r.moment.round === round);
  const n1r1 = pinOf('racoons-n1-correct', 1);
  assert.equal(n1r1.legacy.bytes, 4177);
  assert.equal(n1r1.legacy.sha256, '7ae5c8a0625d4afa5cdfa9e8151c9d6d179b5c7eba51988a487d092ea81b7b17');
  assert.equal(n1r1.corrected.bytes, 5884);
  assert.equal(n1r1.corrected.sha256, '4097d23c7771faeeedc9187fde21a3a47f21f1c86eddd5e9d6b2095e53998b39');
  assert.equal(n1r1.recorded.units, 15);
  assert.equal(n1r1.recorded.bytesFreed, 95687);
  assert.equal(n1r1.tableUnits, 15);

  // Pins of the rebuilt core dist, where entry rows number their `(call #n)` by
  // kind+path. The ISSUE-525 key rename adds the same 142 bytes to every
  // corrected ask; n1 r16 and n2 r1 keep their own numbering-driven sizes.
  const n1r16 = pinOf('racoons-n1-correct', 16);
  assert.equal(n1r16.legacy.bytes, 6583, 'the old bulk ask is unaffected by the entry numbering');
  assert.equal(n1r16.legacy.sha256, '42ae316bd07e7e435fa80a63288fa92408c776fe208362b36d6ebed8d0a04f10');
  assert.equal(n1r16.corrected.bytes, 8290);
  assert.equal(n1r16.corrected.sha256, '7e71017438a498b4d1deb68926da3e2f6c63798fbb8a4105863ad691d9de707f');
  const n2r1 = pinOf('racoons-n2-correct', 1);
  assert.equal(n2r1.corrected.bytes, 7882);
  assert.equal(n2r1.corrected.sha256, '4c35c68916e20abb9dd60d8bf7c371c5d32a13a998a6fb185cbf7eb6ca0652fc');
  assert.ok(MOMENTS.every((m) => Number.isSafeInteger(m.crossLine) && m.planLine === m.crossLine + 1));
});

test('the stub transport sends once per moment and the bytes add up', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-depth-table-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--token-grant', '100000000', '--kill-ms', '120000', '--out', out],
  { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 0, run.stderr);
  const file = path.join(out, 'replay-depth-table-stub.json');
  assert.ok(fs.existsSync(file));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(report.transport, 'stub');
  assert.equal(report.records.length, 15);
  assert.equal(report.aggregate.sends, 15, 'ISSUE-510 is one request per moment');
  for (const record of report.records) {
    assert.equal(record.sends, 1, `${record.moment} sent more than once`);
    assert.equal(record.ok, true);
    assert.equal(record.wholeUnitBytesFreed + record.partialLineBytesFreed + record.keptBytes,
      record.bytesAtStake, `${record.moment} byte accounting does not add up`);
    assert.equal(record.newBytesFreed, record.wholeUnitBytesFreed + record.partialLineBytesFreed);
    assert.equal(typeof record.wholeKeeps, 'number');
    assert.equal(record.keepallSource, 'normalized-keeplines');
    if (FAILED_MOMENTS.has(record.moment)) {
      assert.equal(record.recordedFailed, true);
      assert.equal(record.recordedComparable, false);
      assert.equal(record.deltaBytes, null, 'a failed baseline yields no delta');
      assert.equal(record.deltaUnits, null);
      assert.match(record.recordedFailReason, /answer-unreadable/);
    } else {
      assert.equal(record.recordedComparable, true);
      assert.equal(typeof record.deltaBytes, 'number');
    }
  }
  assert.equal(report.aggregate.providerTokens, 0, 'a stub reading is never a billed one');
  assert.equal(report.aggregate.momentsOk, 15);
  assert.equal(report.aggregate.successOnly, false);
  assert.equal(report.aggregate.coverageLimited, false);
  assert.ok(report.aggregate.syntheticTokens > 0);
  assert.ok(report.aggregate.wholeUnitBytesFreed > 0);
  assert.ok(report.aggregate.partialLineBytesFreed > 0);
  assert.equal(report.aggregate.wholeUnitBytesFreed + report.aggregate.partialLineBytesFreed
    + report.aggregate.keptBytes, report.aggregate.bytesAtStake);
  assert.equal(report.aggregate.newBytesFreed, report.aggregate.wholeUnitBytesFreed
    + report.aggregate.partialLineBytesFreed);
  // Both aggregates are present and the comparable one drops the three failed
  // recordings by name.
  assert.equal(report.aggregate.all15.moments, 15);
  assert.equal(report.aggregate.comparable.label, 'COMPARABLE-12');
  assert.equal(report.aggregate.comparable.moments, 12);
  assert.deepEqual([...report.aggregate.comparable.excluded].sort(), [...FAILED_MOMENTS].sort());
  assert.equal(report.aggregate.comparable.recordedUnits, report.aggregate.all15.recordedUnits,
    'the failed baselines contributed no recorded units');
  assert.equal(report.aggregate.comparable.recordedBytesFreed,
    report.aggregate.all15.recordedBytesFreed);
  assert.ok(report.aggregate.comparable.newBytesFreed < report.aggregate.all15.newBytesFreed,
    'the failed baselines only contribute to ALL');
  assert.equal(report.aggregate.keepallSource, 'normalized-keeplines');
  // The per-moment console line names every verdict, so `decided` reconciles.
  assert.match(run.stdout, /decided=\d+\/\d+ forgetall=\d+ keeplines=\d+ keepall=\d+ forgetlines=\d+/);
  assert.match(run.stdout, /wholeKeeps=\d+/);
  assert.match(run.stdout, /\[aggregate\] ALL-15 /);
  assert.match(run.stdout, /\[aggregate\] COMPARABLE-12 /);
  assert.match(run.stdout, /excludedFailingBaselines=\[.*racoons-n1-correct r23/);
});

test('a length-trip charges the grant and marks the run coverage-limited', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-length-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--stub-fail', 'length-trip', '--token-grant', '100000000', '--kill-ms', '120000', '--out', out],
  { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'replay-depth-table-stub.json'), 'utf8'));
  assert.equal(report.records.length, 15);
  for (const record of report.records) {
    assert.equal(record.ok, false);
    assert.equal(record.error, 'length-trip');
    assert.equal(record.chargedTokens, 1001, 'a billed truncated draw is charged');
  }
  assert.equal(report.aggregate.failures, 15);
  assert.equal(report.aggregate.successOnly, true);
  assert.equal(report.aggregate.coverageLimited, true);
  assert.deepEqual(report.aggregate.coverageReasons, ['transport-failures']);
  assert.equal(report.aggregate.syntheticTokens, 15 * 1001);
});

test('a transport failure is successOnly and names transport-failures', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-transport-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--stub-fail', 'transport-error', '--token-grant', '100000000', '--kill-ms', '120000', '--out', out],
  { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'replay-depth-table-stub.json'), 'utf8'));
  for (const record of report.records) {
    assert.equal(record.ok, false);
    assert.equal(record.chargedTokens, 0, 'no usage was stated, so nothing is charged');
  }
  assert.equal(report.aggregate.successOnly, true);
  assert.equal(report.aggregate.coverageLimited, true);
  assert.deepEqual(report.aggregate.coverageReasons, ['transport-failures']);
  assert.equal(report.aggregate.syntheticTokens, 0);
});

test('offline mode writes its report under the requested dir', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-offline-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 0, run.stderr);
  const file = path.join(out, 'replay-depth-table-offline.json');
  assert.ok(fs.existsSync(file));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(report.mode, 'offline');
  assert.equal(report.moments.length, 15);
  assert.ok(report.moments.every((m) => m.ok));
  assert.equal(report.baseline.recordedUnits, 500);
  assert.equal(report.baseline.recordedBytesFreed, 1560778);
  assert.equal(report.baseline.tableBytesAtStake, 2190387);
  // The all-moment baseline keeps the failed recordings at their raw zeros;
  // the comparable one drops them and names them.
  assert.equal(report.baseline.all15.moments, 15);
  assert.equal(report.baseline.all15.tableUnits, 630);
  assert.equal(report.baseline.comparable.label, 'COMPARABLE-12');
  assert.equal(report.baseline.comparable.moments, 12);
  assert.equal(report.baseline.comparable.recordedUnits, 500);
  assert.equal(report.baseline.comparable.tableUnits, 515);
  assert.equal(report.baseline.comparable.tableBytesAtStake, 1660772);
  assert.equal(report.baseline.comparable.deltaUnits, 15);
  assert.equal(report.baseline.comparable.deltaBytesAtStake, 99994);
  assert.deepEqual([...report.baseline.comparable.excluded].sort(), [...FAILED_MOMENTS].sort());
  const failedMoment = report.moments.find((m) => m.moment === 'racoons-n1-correct r23');
  assert.equal(failedMoment.recordedFailed, true);
  assert.equal(failedMoment.recordedComparable, false);
  assert.equal(failedMoment.recorded.units, 0, 'the raw recorded zero stays for display');
  assert.equal(failedMoment.deltaTableUnits, null);
  assert.match(failedMoment.recordedFailReason, /answer-unreadable/);
  assert.match(run.stdout, /\[baseline\] ALL-15 /);
  assert.match(run.stdout, /\[baseline\] COMPARABLE-12 .*excludedFailingBaselines=\[/);
});

test('the recorded live evidence folds into ALL-15 and COMPARABLE-12', { skip: skipLive }, () => {
  const corpus = computeOffline(WORLD);
  const live = mergeLiveEvidence(LIVE_FILES, corpus.results);
  assert.equal(live.all15.moments, 15);
  assert.equal(live.all15.recordedUnits, 500);
  assert.equal(live.all15.recordedBytesFreed, 1560778);
  assert.equal(live.all15.newUnits, 507);
  assert.equal(live.all15.newBytesFreed, 1658588);
  assert.equal(live.all15.deltaUnits, 7);
  assert.equal(live.all15.deltaBytes, 97810);
  assert.equal(live.comparable.label, 'COMPARABLE-12');
  assert.equal(live.comparable.recordedUnits, 500);
  assert.equal(live.comparable.recordedBytesFreed, 1560778);
  assert.equal(live.comparable.newUnits, 398);
  assert.equal(live.comparable.newBytesFreed, 1182129);
  assert.equal(live.comparable.deltaUnits, -102);
  assert.equal(live.comparable.deltaBytes, -378649);
  assert.deepEqual([...live.comparable.excluded].sort(), [...FAILED_MOMENTS].sort());
});

test('the token grant stops the stub lane before an over-grant request', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-grant-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--token-grant', '1', '--kill-ms', '120000', '--out', out],
  { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'replay-depth-table-stub.json'), 'utf8'));
  assert.equal(report.aggregate.stoppedAtBudget, true);
  assert.equal(report.aggregate.coverageLimited, true);
  assert.deepEqual(report.aggregate.coverageReasons, ['token-budget']);
  assert.match(report.caveat, /token budget/);
  assert.equal(report.aggregate.sends, 0);
  assert.equal(report.records.length, 0);
});

test('a failed offline gate refuses the send lane before any key read', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-world-'));
  const src = path.join(WORLD, 'racoons-n1-correct');
  const copy = path.join(root, 'racoons-n1-correct');
  fs.cpSync(src, copy, { recursive: true });
  const journal = path.join(copy, 'evidence', 'racoons', 'cremator-events.jsonl');
  const text = fs.readFileSync(journal, 'utf8');
  const tampered = text.replace(/"seedHash":"[0-9a-f]{64}"/, `"seedHash":"${'0'.repeat(64)}"`);
  assert.notEqual(tampered, text);
  fs.writeFileSync(journal, tampered);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-out-'));
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--only', 'racoons-n1-correct:1',
    '--transport', 'deepseek', '--i-am-the-owner', '--token-grant', '1000000',
    '--kill-ms', '60000', '--out', out], { encoding: 'utf8', timeout: 180000 });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /offline gates failed/);
  assert.doesNotMatch(run.stdout + run.stderr, /\[key\]/, 'no key was read before the gate refusal');
  assert.equal(fs.existsSync(path.join(out, 'replay-depth-table-deepseek.json')), false,
    'no evidence may be written when the lane refuses');
});
