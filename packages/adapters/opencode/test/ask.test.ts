// The opencode prune ask's row builder and answer reader (ADR-0050; ADR-0053;
// ADR-0054; ADR-0060). The pass is core's `planPrunePass`, so this file tests
// exactly the two pure halves the mount drives: the plan and table it builds
// from an observed array, and the reading of one reply under the host-honest
// two-option prompt. No model call, no ledger, no host.
//
// Every claim is a row, so a failure names the claim it broke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRUNE_ASK_FINAL_LINE, PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT,
} from '@cremator/core';
import {
  OPENCODE_ASK_FLOOR_BYTES, OPENCODE_ASK_GRAMMAR,
  buildOpencodeAskBatch, readOpencodeAskAnswer,
} from '../src/ask.js';
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
    assert.ok(prompt.includes(PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT),
      at('the prompt is core two-option contract'));
    assert.ok(prompt.endsWith(PRUNE_ASK_FINAL_LINE),
      at('the prompt closes on the contract own final line'));
    assert.doesNotMatch(prompt, /70 percent|40 percent|keep at most/u,
      at('the 70/40 share lines are not in the product prompt'));
    assert.match(prompt, /^1\. \[read\] NOTES\.md \(call #1\)/mu,
      at('the table carries the row address'));
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
    const parsed = readOpencodeAskAnswer(batch, '{"1":{"forgetall":"stale note"}}');
    assert.deepEqual(parsed, [{ index: 1, unitId: batch.unitIds[0], status: 'answered',
      answer: { verdict: { unitId: batch.unitIds[0], answeredInRound: ROUND,
        action: 'forgetall', summary: 'stale note' } } }],
    at('the answer is read under the two-option contract'));
  } },
  { name: 'a-forgetall-summary-past-the-guard-cap-is-refused-at-the-wire', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const fit = summaryWords(25);
    const accepted = readOpencodeAskAnswer(batch,
      JSON.stringify({ 1: { forgetall: fit } }));
    assert.equal(accepted[0]?.status, 'answered',
      at('a 25-word summary is read as the guard accepts it'));
    const over = readOpencodeAskAnswer(batch,
      JSON.stringify({ 1: { forgetall: summaryWords(26) } }));
    assert.deepEqual(over.map(row => [row.index, row.status,
      row.status === 'refused' ? row.code : null,
      row.status === 'refused' ? row.wireCode : null]),
    [[1, 'refused', 'malformed-row', 'summary-too-long']],
    at('a 26-word summary is refused by the wire before the mount can store it'));
  } },
  { name: 'keepall-is-the-offered-keep', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    const parsed = readOpencodeAskAnswer(batch, '{"1":{"keepall":true}}');
    assert.equal(parsed[0]?.status, 'answered', at('keepall is an offered verdict'));
    assert.equal(parsed[0]?.status === 'answered' ? parsed[0].answer.verdict.action : null,
      'keepall', at('the action is the keep the prompt teaches'));
  } },
  { name: 'keeplines-and-forgetlines-are-terminal-not-in-grammar', run(at) {
    const messages = conversation();
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: portFor(messages), round: ROUND,
    });
    assert.ok(batch !== null, at('the batch is built'));
    for (const textRow of [
      '{"1":{"keeplines":[[1,2],"None"]}}',
      '{"1":{"forgetlines":[[1,1],"drop one"]}}',
    ]) {
      const parsed = readOpencodeAskAnswer(batch, textRow);
      assert.deepEqual(parsed.map(row => [row.index, row.status,
        row.status === 'refused' ? row.code : null]),
      [[1, 'refused', 'action-not-in-grammar']],
      at('an action the prompt does not offer is refused, and the unit keeps'));
      const refusal = parsed[0];
      assert.equal(refusal?.status === 'refused' ? refusal.message : null,
        'The answer used an action this grammar does not offer; it takes keepall or '
        + 'forgetall, so the unit is kept.',
        at('the terminal message names keepall and forgetall'));
      assert.doesNotMatch(refusal?.status === 'refused' ? refusal.message : '',
        /takes keeplines/u,
        at('the message does not claim this host offers keeplines'));
    }
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
  { name: 'the-grammar-id-is-the-one-the-mount-sends', run(at) {
    assert.equal(OPENCODE_ASK_GRAMMAR, 'prune-two-option',
      at('the exported grammar names the prompt family this host can apply'));
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
