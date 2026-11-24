/**
 * The stable-receipt pairing and the provider-prefix gate (ISSUE-256 item 1
 * cost fix). Pure over hand-built journals and captured bodies: no host, no
 * network, no evidence directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { opencodeReceiptEntryId } from 'cremator-opencode';
import { perRequestReapplication, prefixStability, runBench } from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

/** One receipt line in the writer's shape, naming `passId`. */
function receiptMessage(recallId, passId, callId = 'call_1') {
  return {
    role: 'user',
    content: receiptLineText(`oc:ses_test:tool:${callId}`, recallId, '', '', passId),
  };
}

/** Two applied passes; the second re-applies the first's removal. */
function stablePassJournal() {
  return {
    atRest: [
      { eventId: 'e1', reason: 'step', status: 'applied', intentId: 'i1' },
      { eventId: 'e2', reason: 'step', status: 'applied', intentId: 'i2' },
    ],
    applications: [
      { intentId: 'i1', recallIds: ['recall:a'] },
      { intentId: 'i2', recallIds: ['recall:a'] },
    ],
  };
}

test('perRequestReapplication: two requests carrying the same byte-stable receipt both pass', () => {
  const verdict = perRequestReapplication(stablePassJournal(), [
    { seq: 2, main_turn: 1, messages: [receiptMessage('recall:a', 'i1')],
      receipt_recall_ids: ['recall:a'] },
    { seq: 3, main_turn: 2, messages: [receiptMessage('recall:a', 'i1')],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.deepEqual(verdict.groups.map((group) => [group.intentId, group.firstSeq]), [['i1', 2]]);
  assert.deepEqual(verdict.groups[0].seqs, [2, 3]);
  assert.equal(verdict.rows.every((row) => row.matched === true), true);
});

test('perRequestReapplication: a re-applied removal without a receipt rewrite passes', () => {
  // Pass i2 applied the same recall id again; the receipt still names i1 and
  // its bytes did not change. The checker must not demand a fresh group.
  const verdict = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2, messages: [receiptMessage('recall:a', 'i1')],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.deepEqual(verdict.reapplied, ['i2']);
  assert.match(verdict.detail, /re-applied an already-receipted removal/u);
  assert.match(verdict.detail, /no receipt rewrite/u);
});

test('perRequestReapplication: a later record id over a stable receipt line is accepted', () => {
  // The host rebuilds the entry, so its record id names the re-application
  // pass while the line keeps the first pass. The line is the carrier; the
  // record is accepted when it names a later pass that re-applied the ids.
  const entry = {
    id: opencodeReceiptEntryId('i2', 0),
    role: 'user',
    content: receiptLineText('oc:ses_test:tool:call_1', 'recall:a', '', '', 'i1'),
    racoonsRecordId: opencodeReceiptEntryId('i2', 0),
  };
  const verdict = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2, messages: [entry], receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.deepEqual(verdict.groups.map((group) => group.intentId), ['i1']);
  assert.deepEqual(verdict.reapplied, ['i2']);
});

test('perRequestReapplication: a stable receipt does not excuse the old failures', () => {
  // A pass this run never applied.
  const never = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2, messages: [receiptMessage('recall:a', 'i9')],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(never.pass, false);
  assert.match(never.detail, /which this run did not apply/u);

  // An id outside the named pass.
  const outside = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2, messages: [receiptMessage('recall:b', 'i1')],
      receipt_recall_ids: ['recall:b'] },
  ]);
  assert.equal(outside.pass, false);
  assert.match(outside.detail, /which pass 1 did not apply/u);
  assert.match(outside.detail, /a receipt is a subset of its own pass's ids/u);

  // A receipt naming no pass.
  const noPass = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2,
      messages: [{ role: 'user', content: '[not retained] big.txt · necromancy recall:a' }],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(noPass.pass, false);
  assert.match(noPass.detail, /the receipt line names no pass/u);

  // A unit whose forgotten node is back in the array.
  const back = perRequestReapplication(stablePassJournal(), [
    { seq: 3, main_turn: 2,
      messages: [receiptMessage('recall:a', 'i1'),
        { role: 'tool', tool_call_id: 'call_1', content: 'the unit came back' }],
      receipt_recall_ids: ['recall:a'] },
  ], {
    ledger: { recallParts: [{ recallId: 'recall:a', sourceNodeId: 'oc:ses:tool:call_1' }] },
  });
  assert.equal(back.pass, false);
  assert.match(back.detail, /the receipt says the unit left/u);
  assert.match(back.detail, /a unit is the call entry and its result/u);

  // A receipt whose pass applied a different range: the pass applied a and b,
  // the receipt names only a, so b has no receipt.
  const range = perRequestReapplication({
    atRest: [{ eventId: 'e1', reason: 'step', status: 'applied', intentId: 'i1' }],
    applications: [{ intentId: 'i1', recallIds: ['recall:a', 'recall:b'] }],
  }, [
    { seq: 3, main_turn: 2, messages: [receiptMessage('recall:a', 'i1')],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(range.pass, false);
  assert.match(range.detail, /no receipt of that pass covers it/u);
});

/** One clean conversation: a call and its result, then a receipt that replaces them. */
function conversation(passId = 'i1') {
  const system = { role: 'system', content: 'system' };
  const user = { role: 'user', content: 'task' };
  const call = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const result = { role: 'tool', tool_call_id: 'call_1', content: 'big result' };
  const receipt = {
    role: 'user',
    content: receiptLineText('oc:ses_test:tool:call_1', 'recall:a', '', '', passId),
  };
  return { system, user, call, result, receipt };
}

test('prefixStability: a stable receipt with appended messages passes', () => {
  const { system, user, call, result, receipt } = conversation('i1');
  const verdict = prefixStability([
    { seq: 1, messages: [system, user, call, result] },
    { seq: 2, messages: [system, user, receipt, { role: 'assistant', content: 'reply' }] },
    { seq: 3, messages: [system, user, receipt, { role: 'assistant', content: 'reply' },
      { role: 'assistant', content: 'more' }] },
  ]);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.checked, 2);
  assert.equal(verdict.churned, 0);
  assert.equal(verdict.firstChurnSeq, null);
  assert.equal(verdict.changedMessages, 0);
  assert.deepEqual(verdict.changedMessageSample, []);
  assert.equal(verdict.pass, true, verdict.detail);
});

test('prefixStability: the same world with the pass id rewritten on request 2 fails by name', () => {
  const stable = conversation('i1');
  const rewritten = conversation('i2');
  const verdict = prefixStability([
    { seq: 1, messages: [stable.system, stable.user, stable.call, stable.result] },
    { seq: 2, messages: [stable.system, stable.user, stable.receipt,
      { role: 'assistant', content: 'reply' }] },
    { seq: 3, messages: [rewritten.system, rewritten.user, rewritten.receipt,
      { role: 'assistant', content: 'reply' }, { role: 'assistant', content: 'more' }] },
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.churned, 1);
  assert.equal(verdict.firstChurnSeq, 3);
  assert.equal(verdict.changedMessages, 1);
  assert.equal(verdict.changedMessageSample.length, 1);
  assert.deepEqual(verdict.changedMessageSample[0].fromPass, ['i1']);
  assert.deepEqual(verdict.changedMessageSample[0].toPass, ['i2']);
  assert.deepEqual(verdict.changedMessageSample[0].recallIds, ['recall:a']);
  assert.match(verdict.detail, /receipt-pass-churn/u);
  assert.match(verdict.detail, /invalidates the provider prefix cache/u);
});

test('prefixStability: appended messages and a new removal do not fail', () => {
  const first = conversation('i1');
  const call2 = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const result2 = { role: 'tool', tool_call_id: 'call_2', content: 'second result' };
  const receipt2 = {
    role: 'user',
    content: receiptLineText('oc:ses_test:tool:call_2', 'recall:b', '', '', 'i2'),
  };
  const verdict = prefixStability([
    { seq: 1, messages: [first.system, first.user, first.call, first.result, call2, result2] },
    { seq: 2, messages: [first.system, first.user, first.receipt, call2, result2,
      { role: 'assistant', content: 'reply' }] },
    { seq: 3, messages: [first.system, first.user, first.receipt, receipt2,
      { role: 'assistant', content: 'reply' }, { role: 'assistant', content: 'more' }] },
  ]);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.equal(verdict.churned, 0);
});

test('prefixStability: a shared message changed beyond the pass segment fails prefix-rewritten', () => {
  const { system, user, call, result, receipt } = conversation('i1');
  const verdict = prefixStability([
    { seq: 1, messages: [system, user, call, result] },
    { seq: 2, messages: [system, user, receipt, { role: 'assistant', content: 'reply' }] },
    { seq: 3, messages: [system, { role: 'user', content: 'a different task' }, receipt,
      { role: 'assistant', content: 'reply' }] },
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.churned, 0);
  assert.match(verdict.detail, /prefix-rewritten/u);
});

test('prefixStability: one request is an absence, not a pass', () => {
  const { system, user, call, result } = conversation('i1');
  const verdict = prefixStability([{ seq: 1, messages: [system, user, call, result] }]);
  assert.equal(verdict.applicable, false);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checked, 0);
  assert.match(verdict.detail, /fewer than two main requests/u);
});

test('runBench: the prefix gate is a named assertion and fails on receipt-pass-churn', () => {
  const ledger = {
    exists: false, refused: 'no ledger in this test', sessions: [], sessionId: null,
    carrierSessions: [], intentIds: [], recallIds: [], recallParts: [], removalRules: [],
    eventKinds: [], tables: {}, columns: {}, error: null,
  };
  const journal = {
    available: false, records: 0, unreadable: [], mounted: null, atRest: [], commits: [],
    errors: [], storageUnavailable: [], rejected: [], disabled: [], appliedIntentIds: [],
    compacted: [], asks: [], askErrors: [],
  };
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const row = (seq, receiptPass) => ({
    seq,
    kind: 'main',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      receiptMessage('recall:a', receiptPass),
      ...Array.from({ length: seq }, (_, at) => ({
        role: 'assistant', content: `reply ${String(at + 1)}`,
      })),
    ],
    body_sha256: sha(`body-${String(seq)}`),
  });
  const name = 'requests: every consecutive main body keeps the previous body as a prefix except '
    + 'appended messages and removal sites (no receipt-pass-churn)';
  const churned = runBench({
    requests: [row(1, 'i1'), row(2, 'i2')],
    task: 'DONE',
    arm: 'test',
    ledger,
    journal,
  });
  const churnRow = churned.assertions.find((assertion) => assertion.name === name);
  assert.ok(churnRow, 'the prefix gate is recorded');
  assert.equal(churnRow.status, 'fail');
  assert.match(churnRow.detail, /receipt-pass-churn/u);
  assert.ok(churned.prefixStability?.churned >= 1);
  assert.equal(churned.prefixStability.firstChurnSeq, 2);

  const stable = runBench({
    requests: [row(1, 'i1'), row(2, 'i1')],
    task: 'DONE',
    arm: 'test',
    ledger,
    journal,
  });
  const stableRow = stable.assertions.find((assertion) => assertion.name === name);
  assert.ok(stableRow, 'the prefix gate is recorded');
  assert.equal(stableRow.status, 'pass', stableRow.detail);
  assert.equal(stable.prefixStability?.churned, 0);
});
