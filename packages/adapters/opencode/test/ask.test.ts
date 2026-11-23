// The opencode prune ask's row builder and answer reader (ADR-0050; ADR-0053;
// ADR-0054; ADR-0060; ISSUE-509). The pass is core's `planPrunePass`, so this
// file tests exactly the two pure halves the mount drives: the plan and table it
// builds from an observed array, and the reading of one reply under core's
// `jsonl-20-nokeepall` grammar (the same message and reader dsh's depth table
// uses). No model call, no ledger, no host.
//
// Every claim is a row, so a failure names the claim it broke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENTRY_ASK_END_ANCHOR, entryBatchAskMessage, isRefusedPruneAnchor,
} from '@cremator/core';
import type { EntryBatchRow, PruneAnchorRefusal, PruneAskRow } from '@cremator/core';
import {
  OPENCODE_ASK_FLOOR_BYTES, OPENCODE_ASK_GRAMMAR, OPENCODE_ASK_PROMPT_GRAMMAR,
  askPromptOf, buildOpencodeAskBatch, readOpencodeAskAnswer,
} from '../src/ask.js';
import type { OpencodeAskBatch } from '../src/ask.js';
import { createOpencodePort } from '../src/port.js';
import {
  assistantMessage, errorResult, sessionId, text, toolCall, toolMessage, toolResult,
  textResult, userMessage,
} from './fixtures.js';
import type { OpencodeMessage } from '../src/host.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

const CLOCK = { nowMs: () => 1 };
const ROUND = 1;

/** A body at the product floor's side: the ask tables only >= 512 bytes. */
const LARGE_BODY = `# Note\n\n${'body-'.repeat(180)}\n`;

/** A summary of exactly `count` whitespace-delimited words. */
function summaryWords(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${String(index)}`).join(' ');
}

function portFor(messages: readonly OpencodeMessage[]) {
  return createOpencodePort({ sessionId, clock: CLOCK, messages });
}

function conversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(LARGE_BODY))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

/**
 * A batch whose one row states `lines` lines. A real mount derives the row's L
 * from the unit's span over the result's decoded text (ISSUE-511); this stub is
 * the reader's contract at a chosen count, including counts a small fixture
 * does not reach on its own.
 */
function syntheticBatch(lines: number): OpencodeAskBatch {
  return {
    rows: [{
      index: 1,
      unit: {
        id: 'unit:synthetic',
        nodeId: 'node:synthetic',
        source: { nodeId: 'node:synthetic', sha256: '', byteLength: 0 },
        path: null,
        span: {
          byteRange: { startByte: 0, endByteExclusive: 1 },
          // `0` is a zero-line unit: no range at all.
          lineRange: lines === 0 ? null : { startLine: 1, endLineInclusive: lines },
        },
        byteLength: 1,
      },
      anchor: { kind: 'read', path: 'NOTES.md', callOrdinal: 1, anchors: ['line one'] },
    }],
    indices: [1],
    stamps: new Map([[1, { unitId: 'unit:synthetic', answeredInRound: ROUND }]]),
  } as unknown as OpencodeAskBatch;
}

/** The line count a row's own range proves, as `entryBatchAskMessage` needs it. */
function lineCountOf(row: PruneAskRow): number {
  const range = row.unit.span.lineRange;
  if (range === null) return 0;
  const count = range.endLineInclusive - range.startLine + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/**
 * The entry message's row shape, built independently of `ask.ts`, so the parity
 * test compares two derivations and would catch a drift in either.
 */
function parityRows(rows: readonly PruneAskRow[]): readonly EntryBatchRow[] {
  return rows.map(row => {
    const anchor = row.anchor;
    return {
      index: row.index,
      call: anchor.kind,
      ...(anchor.path === undefined ? {} : { path: anchor.path }),
      callOrdinal: anchor.callOrdinal,
      ...(isRefusedPruneAnchor(anchor)
        ? { anchorLines: [], anchorRefusal: anchor.refusal }
        : { anchorLines: anchor.anchors }),
      lineCount: lineCountOf(row),
    };
  });
}

/**
 * One synthetic row for the byte tests: a zero-line unit and a refused anchor
 * are not producible from a real context array here, but both shapes must
 * render the core message's own bytes.
 */
function syntheticRow(
  shape: { readonly lineRange: { readonly startLine: number;
    readonly endLineInclusive: number } | null; readonly refusal?: PruneAnchorRefusal },
): PruneAskRow {
  return {
    index: 1,
    unit: {
      id: 'unit:synthetic',
      nodeId: 'node:synthetic',
      source: { nodeId: 'node:synthetic', sha256: '', byteLength: 1 },
      path: null,
      span: {
        byteRange: { startByte: 0, endByteExclusive: 1 },
        lineRange: shape.lineRange,
      },
      byteLength: 1,
    },
    anchor: shape.refusal === undefined
      ? { kind: 'read', path: 'NOTES.md', callOrdinal: 1, anchors: ['line one'] }
      : { kind: 'read', path: 'NOTES.md', callOrdinal: 1, refusal: shape.refusal },
  };
}

/** A conversation with two identical `read NOTES.md` calls and different bodies. */
function twoIdenticalCallConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note twice.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# One\n\n${'alpha-'.repeat(120)}\n`))]),
    assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read',
      textResult(`# Two\n\n${'bravo-'.repeat(120)}\n`))]),
    assistantMessage('msg_a3', [text('Both read.')]),
  ];
}

const ROWS: readonly Row[] = [
  { name: 'the-pass-tables-the-observed-array-and-keeps-l1', run(at) {
    const messages = conversation();
    const untouched = structuredClone(messages);
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('one result node is tabled'));
    assert.equal(batch.rows.length, 1, at('one row per tool result'));
    assert.deepEqual(batch.indices, [1], at('indices are assigned from 1'));
    assert.equal(batch.rows[0]?.anchor.path, 'NOTES.md',
      at('the row names the call target'));
    assert.equal(batch.rows[0]?.anchor.callOrdinal, 1, at('the call ordinal is numbered'));
    const anchor = batch.rows[0]?.anchor;
    assert.ok(anchor !== undefined && 'anchors' in anchor && anchor.anchors.length >= 1,
      at('the anchor quotes the node'));
    assert.equal(batch.floorBytes, OPENCODE_ASK_FLOOR_BYTES,
      at('the batch names the product floor it used'));
    assert.equal(batch.dropped.l1Removed, 0, at('one read proves no L1 removal'));
    assert.equal(batch.dropped.dedupeRemoved, 0, at('the dedupe is off by default'));
    assert.deepEqual(batch.dropped, {
      subFloor: 0, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
      errorResult: 0, l1Removed: 0, dedupeRemoved: 0,
    }, at('the one eligible unit reached the table'));
    const prompt = batch.prompt ?? '';
    assert.ok(batch.prompt !== null, at('a table exists, so a prompt exists'));
    assert.equal(prompt,
      entryBatchAskMessage(parityRows(batch.rows), 'jsonl-20-nokeepall', true),
      at('the prompt is core\'s jsonl-20-nokeepall entry message, byte for byte'));
    assert.match(prompt, /keep at most 70 percent of the total lines/u,
      at('the session\'s first table ask states the 70 percent share'));
    assert.doesNotMatch(prompt, /keep at most 40 percent/u,
      at('the first ask never mixes in the later share'));
    assert.match(prompt, /^1\. \[read\] NOTES\.md \(call #1\)/mu,
      at('the table carries the row address'));
    const lines = lineCountOf(batch.rows[0] as PruneAskRow);
    assert.ok(lines > 0, at('the row proves a positive line count'));
    const label = `[${String(lines)} line${lines === 1 ? '' : 's'}]`;
    assert.match(prompt,
      new RegExp(`^1\\. \\[read\\] NOTES\\.md \\(call #1\\).* ${label.replace('[', '\\[').replace(']', '\\]')}$`, 'mu'),
      at('every row ends with its [L line(s)] count'));
    assert.ok(prompt.trimEnd().endsWith(ENTRY_ASK_END_ANCHOR),
      at('the post-table repeat closes on the end anchor'));
    assert.equal(prompt.split('Answer format:').length - 1, 2,
      at('the contract, the table and the repeat are the three pieces'));
    assert.deepEqual(messages, untouched, at('building the ask mutates nothing'));
  } },
  { name: 'asked-units-are-never-tabled-again', run(at) {
    const messages = conversation();
    const port = portFor(messages);
    const first = buildOpencodeAskBatch({ sessionId, messages, port, round: ROUND });
    assert.ok(first !== null, at('the first build tables the unit'));
    const second = buildOpencodeAskBatch({
      sessionId, messages, port, round: ROUND + 1,
      askedUnitIds: new Set(first.unitIds),
    });
    assert.equal(second?.rows.length, 0, at('a unit already asked yields no second row'));
    assert.equal(second?.prompt, null, at('no row means no table and no generate call'));
  } },
  { name: 'no-tool-result-yields-no-pass', run(at) {
    const messages: OpencodeMessage[] = [
      userMessage('msg_u1', [text('hello')]),
      assistantMessage('msg_a1', [text('hi')]),
    ];
    assert.equal(buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    }), null, at('a request with no result node has nothing to table'));
  } },
  { name: 'forgetall-reads-as-an-answered-verdict', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const parsed = readOpencodeAskAnswer(batch,
      '{"1":{"forgetall":true,"summary":"stale note"}}');
    assert.deepEqual(parsed, [{ index: 1, unitId: batch.unitIds[0], status: 'answered',
      answer: { verdict: { unitId: batch.unitIds[0], answeredInRound: ROUND,
        action: 'forgetall', summary: 'stale note' } } }],
    at('the answer is read under core\'s jsonl-20-nokeepall reader'));
  } },
  { name: 'a-forgetall-summary-past-the-reader-tolerance-is-refused', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const accepted = readOpencodeAskAnswer(batch,
      JSON.stringify({ 1: { forgetall: true, summary: summaryWords(30) } }));
    assert.equal(accepted[0]?.status, 'answered',
      at('a 30-word summary is inside the reader\'s tolerance'));
    const over = readOpencodeAskAnswer(batch,
      JSON.stringify({ 1: { forgetall: true, summary: summaryWords(31) } }));
    assert.deepEqual(over.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'malformed-row']],
    at('a 31-word summary is refused, and the row keeps'));
  } },
  { name: 'a-literal-keepall-is-the-terminal-not-in-grammar-refusal', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const parsed = readOpencodeAskAnswer(batch, '{"1":{"keepall":true}}');
    assert.deepEqual(parsed.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'action-not-in-grammar']],
    at('keepall is not offered; the row is refused and the unit keeps'));
  } },
  { name: 'a-partial-keeplines-is-answered-and-passed-through', run(at) {
    const batch = syntheticBatch(5);
    const parsed = readOpencodeAskAnswer(batch,
      '{"1":{"keeplines":[[1,3]],"summary":"keep the head"}}');
    assert.deepEqual(parsed, [{ index: 1, unitId: 'unit:synthetic', status: 'answered',
      answer: {
        verdict: { unitId: 'unit:synthetic', answeredInRound: ROUND,
          action: 'keeplines', ranges: [{ from: 1, to: 3 }] },
        keeplinesSummary: 'keep the head',
      } }],
    at('a partial keeplines is answered, never refused, so the apply path can remove its lines'));
  } },
  { name: 'a-whole-range-keeplines-normalizes-to-a-clean-keep', run(at) {
    const batch = syntheticBatch(5);
    const parsed = readOpencodeAskAnswer(batch,
      '{"1":{"keeplines":[[1,5]],"summary":"None"}}');
    assert.equal(parsed[0]?.status === 'answered'
      ? parsed[0].answer.verdict.action : null, 'keepall',
    at('the whole row keeps whole, whatever the summary says'));
  } },
  { name: 'a-keeplines-past-the-row-line-count-is-refused', run(at) {
    const batch = syntheticBatch(5);
    const parsed = readOpencodeAskAnswer(batch,
      '{"1":{"keeplines":[[1,6]],"summary":"None"}}');
    assert.deepEqual(parsed.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'spans-outside-result']],
    at('a span past the row\'s own L keeps the row'));
  } },
  { name: 'forgetlines-is-refused-not-in-grammar', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const parsed = readOpencodeAskAnswer(batch,
      '{"1":{"forgetlines":[[1,1]],"summary":"drop one"}}');
    assert.deepEqual(parsed.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'action-not-in-grammar']],
    at('forgetlines is not an action this grammar reads'));
  } },
  { name: 'a-missing-row-keeps-its-unit', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const parsed = readOpencodeAskAnswer(batch, '{}');
    assert.deepEqual(parsed.map(row => [row.index, row.status]), [[1, 'refused']],
      at('an answer with no verdict refuses the row and keeps it'));
  } },
  { name: 'the-first-ask-states-70-percent-and-every-later-one-40', run(at) {
    const messages = conversation();
    const first = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: 1, firstTrigger: true,
    });
    const later = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: 2, firstTrigger: false,
    });
    assert.match(first?.prompt ?? '', /keep at most 70 percent of the total lines/u,
      at('the first table ask states 70 percent'));
    assert.doesNotMatch(first?.prompt ?? '', /keep at most 40 percent/u,
      at('one message never states both shares'));
    assert.match(later?.prompt ?? '', /keep at most 40 percent of the total lines/u,
      at('a later table ask states 40 percent'));
    assert.doesNotMatch(later?.prompt ?? '', /keep at most 70 percent/u,
      at('a later ask never restates the first share'));
    assert.equal((later?.prompt ?? '').split('keep at most 40 percent').length - 1, 2,
      at('the pre-table contract and the post-table repeat state the same share'));
  } },
  { name: 'a-zero-line-row-states-zero-lines-and-the-same-bytes', run(at) {
    const rows = [syntheticRow({ lineRange: null })];
    const prompt = askPromptOf(rows, true);
    assert.match(prompt, /^1\. \[read\] NOTES\.md \(call #1\).* \[0 lines\]$/mu,
      at('a zero-line unit states its own count, never a blank suffix'));
    assert.equal(prompt,
      entryBatchAskMessage(parityRows(rows), 'jsonl-20-nokeepall', true),
      at('the zero-line row renders the core message\'s bytes'));
  } },
  { name: 'a-refused-anchor-renders-its-note-and-the-same-bytes', run(at) {
    const rows = [syntheticRow({
      lineRange: { startLine: 1, endLineInclusive: 1 }, refusal: 'missing-node',
    })];
    const prompt = askPromptOf(rows, true);
    assert.match(prompt, /anchor unavailable: missing-node/u,
      at('a refused anchor renders its note instead of an empty list'));
    assert.equal(prompt,
      entryBatchAskMessage(parityRows(rows), 'jsonl-20-nokeepall', true),
      at('the refused-anchor row renders the core message\'s bytes'));
  } },
  { name: 'a-whole-range-keeplines-on-a-zero-line-row-is-refused', run(at) {
    const batch = syntheticBatch(0);
    const whole = readOpencodeAskAnswer(batch,
      '{"1":{"keeplines":[[1,1]],"summary":"None"}}');
    assert.deepEqual(whole.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'spans-outside-result']],
    at('the sentinel normalization of a whole-range keeplines on a zero-line row keeps it'));
    const literal = readOpencodeAskAnswer(batch, '{"1":{"keepall":true}}');
    assert.deepEqual(literal.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null]),
    [[1, 'refused', 'action-not-in-grammar']],
    at('a literal keepall is still the grammar refusal, never a keep'));
  } },
  { name: 'the-row-call-ordinal-is-the-pass-ordinal-not-a-recount', run(at) {
    const messages = twoIdenticalCallConversation();
    const first = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(first !== null, at('the probe pass is built'));
    assert.deepEqual(first.rows.map(row => [row.index, row.anchor.callOrdinal]),
      [[1, 1], [2, 2]], at('the pass numbers both identical calls in row order'));
    const second = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND + 1,
      askedUnitIds: new Set(first.unitIds.slice(0, 1)),
    });
    assert.ok(second !== null, at('the filtered pass is built'));
    assert.equal(second.rows.length, 1, at('the first identical call is already asked'));
    assert.equal(second.rows[0]?.anchor.callOrdinal, 2,
      at('the tabled row keeps the pass ordinal'));
    assert.match(second.prompt ?? '',
      /^2\. \[read\] NOTES\.md \(call #2\)/mu,
      at('the table prints the pass ordinal, never a recount of the tabled subset'));
    assert.equal(second.prompt,
      entryBatchAskMessage(parityRows(second.rows), 'jsonl-20-nokeepall', true),
      at('the filtered table still renders the core message bytes'));
  } },
  { name: 'the-grammar-id-is-the-one-the-mount-sends', run(at) {
    assert.equal(OPENCODE_ASK_GRAMMAR, 'prune-two-option',
      at('the mount-option id stays stable; its message and reader are jsonl-20-nokeepall'));
    assert.equal(OPENCODE_ASK_PROMPT_GRAMMAR, 'jsonl-20-nokeepall',
      at('the wire grammar the journal names is the message that actually ran'));
  } },
];

test('the prune ask: the pass plan, the table, and one reading per index', async () => {
  await runRows(ROWS);
});

test('a sub-floor result is never tabled', () => {
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('read it')]),
    assistantMessage('msg_a1', [toolCall('call_small', 'read', { filePath: 'small.txt' })]),
    toolMessage('msg_t1', [toolResult('call_small', 'read', textResult('small body'))]),
  ];
  assert.equal(buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  }), null, 'a result below the 512-byte floor yields no unit and no pass');
});

test('the dropped counts name every unit the observed array carried', () => {
  // One large result is tabled; one sub-floor result is not minted.
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('read both')]),
    assistantMessage('msg_a1', [toolCall('call_small', 'read', { filePath: 'small.txt' })]),
    toolMessage('msg_t1', [toolResult('call_small', 'read', textResult('small body'))]),
    assistantMessage('msg_a2', [toolCall('call_large', 'read', { filePath: 'large.txt' })]),
    toolMessage('msg_t2', [toolResult('call_large', 'read', textResult(LARGE_BODY))]),
  ];
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  });
  assert.ok(batch !== null);
  assert.equal(batch.rows.length, 1, 'only the large result is tabled');
  assert.deepEqual(batch.dropped, {
    subFloor: 1, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
    errorResult: 0, l1Removed: 0, dedupeRemoved: 0,
  }, 'the sub-floor result is counted, not silently lost');
});

test('an already-asked unit is counted, never retabled', () => {
  const first = conversation();
  const firstBatch = buildOpencodeAskBatch({
    sessionId, messages: first, port: portFor(first), round: ROUND,
  });
  assert.ok(firstBatch !== null);
  const messages: OpencodeMessage[] = [
    ...structuredClone(first),
    assistantMessage('msg_a3', [toolCall('call_2', 'read', { filePath: 'second.txt' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(`# Other\n\n${'x-'.repeat(400)}`))]),
  ];
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND + 1,
    askedUnitIds: new Set(firstBatch.unitIds),
  });
  assert.ok(batch !== null);
  assert.equal(batch.rows.length, 1, 'only the new unit is tabled');
  assert.equal(batch.dropped.asked, 1, 'the already-asked unit is counted');
});

test('a seen filter tables only what a sent request carried', () => {
  const messages = conversation();
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
    seenNodeIds: new Set(),
  });
  assert.ok(batch !== null, 'the pass still plans the array');
  assert.equal(batch.rows.length, 0, 'nothing is tabled before a request carried it');
  assert.equal(batch.prompt, null, 'no row means no prompt');
  assert.equal(batch.dropped.unseen, 1, 'the unsent unit is counted by name');
});

test('an orphan result is skipped with its own bucket, a paired one is tabled', () => {
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('read the notes')]),
    // No tool-call part for this call id: apply.ts refuses exactly this shape
    // as `tool-pair-split`, so the table must not offer it (ISSUE-269).
    toolMessage('msg_t_orphan', [toolResult('call_orphan', 'read',
      textResult(`# Orphan\n\n${'orphan-'.repeat(90)}\n`))]),
    assistantMessage('msg_a1', [toolCall('call_ok', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_ok', 'read', textResult(LARGE_BODY))]),
  ];
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  });
  assert.ok(batch !== null, 'the paired result is still tableable');
  assert.equal(batch.rows.length, 1, 'the orphan result is never a row');
  assert.equal(batch.dropped.orphan, 1, 'the orphan result has its own named counter');
  assert.ok((batch.prompt ?? '').includes('NOTES.md'),
    'the paired result reaches the table');
  assert.doesNotMatch(batch.prompt ?? '', /orphan-/u,
    'no bytes of the orphan result are quoted in the table');
});

test('an error result is its own drop bucket beside a normal result', () => {
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('read both')]),
    assistantMessage('msg_a1', [toolCall('call_err', 'read', { filePath: 'GONE.md' })]),
    toolMessage('msg_te', [toolResult('call_err', 'read',
      errorResult(`ENOENT: ${'missing-'.repeat(90)}`))]),
    assistantMessage('msg_a2', [toolCall('call_ok', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_ok', 'read', textResult(LARGE_BODY))]),
  ];
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  });
  assert.ok(batch !== null, 'the normal result is tableable');
  assert.deepEqual(batch.rows.map(row => row.anchor.path), ['NOTES.md'],
    'only the normal result reaches the table');
  assert.equal(batch.dropped.errorResult, 1,
    'the error result is counted in its own bucket');
  assert.equal(batch.dropped.contained, 0,
    'the error result is never counted as contained');
  assert.doesNotMatch(batch.prompt ?? '', /missing-/u,
    'no bytes of the error result are quoted in the table');
});

test('L1 removes a byte-identical duplicate before the table is built', () => {
  // Two identical `bash` calls with the exact same input and body: the
  // duplicate family proves one copy redundant, and the pass carries the
  // removal in its plan (a read would hit the stale-exact-reread family first).
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('run both')]),
    assistantMessage('msg_a1', [toolCall('call_a', 'bash', { command: 'ls' })]),
    toolMessage('msg_ta', [toolResult('call_a', 'bash', textResult(LARGE_BODY))]),
    assistantMessage('msg_a2', [toolCall('call_b', 'bash', { command: 'ls' })]),
    toolMessage('msg_tb', [toolResult('call_b', 'bash', textResult(LARGE_BODY))]),
  ];
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  });
  assert.ok(batch !== null);
  assert.equal(batch.plan.l1.removals.length, 1,
    'the duplicate family proves one removal in the pass plan');
  assert.equal(batch.plan.l1.removals[0]?.rule, 'byte-identical-duplicates',
    'the proof names the family');
  assert.equal(batch.rows.length, 1, 'the surviving copy is the only table row');
  assert.equal(batch.dropped.l1Removed, 1, 'the plan removal is counted by name');
});

test('no row cap: one ask tables every eligible unit, past the old twelve', () => {
  // ADR-0009 §Amendment set a 12-row entry table cap; the 2026-11-16 owner
  // ruling (ADR-0060 §Amendment) removed it. Fourteen eligible units ride ONE
  // ask; nothing is left unasked for a later fire.
  const count = 14;
  const messages: OpencodeMessage[] = [userMessage('msg_u', [text('read many')])];
  for (let index = 0; index < count; index += 1) {
    const callId = `call_${String(index)}`;
    messages.push(assistantMessage(`msg_a_${String(index)}`,
      [toolCall(callId, 'read', { filePath: `file-${String(index)}.txt` })]));
    messages.push(toolMessage(`msg_t_${String(index)}`,
      [toolResult(callId, 'read', textResult(`file-${String(index)}: ${'y'.repeat(600)}`))]));
  }
  const batch = buildOpencodeAskBatch({
    sessionId, messages, port: portFor(messages), round: ROUND,
  });
  assert.ok(batch !== null);
  assert.equal(batch.rows.length, count,
    'one ask tables every eligible unit — no row cap');
  assert.deepEqual(batch.indices,
    Array.from({ length: count }, (_, index) => index + 1),
    'the tabled rows are numbered 1..N in transcript order');
  assert.deepEqual(batch.dropped, {
    subFloor: 0, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
    errorResult: 0, l1Removed: 0, dedupeRemoved: 0,
  }, 'no unit was dropped, and no cap bucket exists');
  assert.equal(batch.unitIds.length, count,
    'every tabled unit is claimed for the ask-once set');
  // The prompt renders one row per unit, last index included.
  assert.match(batch.prompt ?? '', new RegExp(`^${String(count)}\\. \\[read\\] file-`, 'mu'),
    'the last unit is addressed by its own index');
});
