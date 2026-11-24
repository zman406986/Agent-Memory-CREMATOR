/**
 * Receipt-line text stability across requests (the 1e checker defect). Pure
 * over hand-built journals and captured bodies: no host, no network, no
 * evidence directory.
 *
 * The provider-visible receipt line carries a ` — about:` segment. A later
 * pass that re-renders the same recall id without that segment changes the
 * line's bytes while keeping every recall id and pass id. The pairing check
 * and the prefix check must both name that shape `receipt-text-rewritten`, not
 * report a generic prefix rewrite or "kept its receipt bytes".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { perRequestReapplication, prefixStability } from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const LABEL = ' — about: docs/project index content, re-readable later';

/** One receipt line in the writer's shape, naming `passId`. */
function receiptMessage(about = LABEL, passId = 'i1', recallId = 'recall:a', callId = 'call_1') {
  return {
    role: 'user',
    content: receiptLineText(`oc:ses_test:tool:${callId}`, recallId, '', about, passId),
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

/** Three main bodies: a removal on request 2, a re-application on request 3. */
function world(aboutOnRequest2, aboutOnRequest3) {
  const system = { role: 'system', content: 'system' };
  const user = { role: 'user', content: 'task' };
  const call = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const result = { role: 'tool', tool_call_id: 'call_1', content: 'big result' };
  return [
    { seq: 1, main_turn: 1, messages: [system, user, call, result] },
    { seq: 2, main_turn: 2, messages: [system, user, receiptMessage(aboutOnRequest2),
      { role: 'assistant', content: 'reply' }] },
    { seq: 3, main_turn: 3, messages: [system, user, receiptMessage(aboutOnRequest3),
      { role: 'assistant', content: 'reply' }, { role: 'assistant', content: 'more' }] },
  ];
}

test('perRequestReapplication: a dropped about label fails by name receipt-text-rewritten', () => {
  const verdict = perRequestReapplication(stablePassJournal(), world(LABEL, ''));
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, false);
  assert.match(verdict.detail, /receipt-text-rewritten/u);
  assert.match(verdict.detail, /"recall:a"/u);
  assert.match(verdict.detail, /"i1"/u);
  const failure = verdict.failures.find((row) => row.why.startsWith('receipt-text-rewritten'));
  assert.ok(failure, 'the failure carries the named class');
  assert.equal(failure.recallId, 'recall:a');
  assert.equal(failure.passId, 'i1');
});

test('prefixStability: a dropped about label fails by name receipt-text-rewritten', () => {
  const verdict = prefixStability(world(LABEL, ''));
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.textRewriteCount, 1);
  assert.match(verdict.detail, /receipt-text-rewritten/u);
  assert.match(verdict.detail, /recall:a/u);
  assert.match(verdict.detail, /i1/u);
  assert.doesNotMatch(verdict.detail, /prefix-rewritten/u);
  assert.equal(verdict.churned, 0);
  const pair = verdict.perPair.find((row) => row.to === 3);
  assert.equal(pair.textRewriteCount, 1);
  assert.equal(pair.textRewrites[0].recallIds[0], 'recall:a');
  assert.deepEqual(pair.textRewrites[0].passIds, ['i1']);
});

test('perRequestReapplication: the same world with identical receipt bytes passes', () => {
  const verdict = perRequestReapplication(stablePassJournal(), world(LABEL, LABEL));
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.deepEqual(verdict.reapplied, ['i2']);
  assert.match(verdict.detail, /no receipt rewrite/u);
  assert.equal(verdict.failures.length, 0);
});

test('prefixStability: the same world with identical receipt bytes passes', () => {
  const verdict = prefixStability(world(LABEL, LABEL));
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.equal(verdict.churned, 0);
  assert.equal(verdict.textRewriteCount, 0);
  assert.deepEqual(verdict.textRewrites, []);
});

test('prefixStability: a pass-id change still reports receipt-pass-churn', () => {
  const reply = { role: 'assistant', content: 'reply' };
  const verdict = prefixStability([
    { seq: 2, messages: [{ role: 'system', content: 'system' },
      { role: 'user', content: 'task' }, receiptMessage(LABEL, 'i1'), reply] },
    { seq: 3, messages: [{ role: 'system', content: 'system' },
      { role: 'user', content: 'task' }, receiptMessage(LABEL, 'i2'), reply,
      { role: 'assistant', content: 'more' }] },
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.churned, 1);
  assert.equal(verdict.textRewriteCount, 0);
  assert.match(verdict.detail, /receipt-pass-churn/u);
  assert.doesNotMatch(verdict.detail, /receipt-text-rewritten/u);
});

test('perRequestReapplication: a pass-id change alone is not a receipt-text-rewritten failure', () => {
  // The check compares the line with the pass segment removed: the same head
  // with a different pass id is the prefix gate's `receipt-pass-churn`, not
  // this class.
  const verdict = perRequestReapplication(stablePassJournal(), [
    { seq: 2, main_turn: 1, messages: [receiptMessage(LABEL, 'i1')],
      receipt_recall_ids: ['recall:a'] },
    { seq: 3, main_turn: 2, messages: [receiptMessage(LABEL, 'i2')],
      receipt_recall_ids: ['recall:a'] },
  ]);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.equal(verdict.failures.length, 0);
});

test('prefixStability: a moved receipt is named receipt-moved when it breaks the prefix', () => {
  const system = { role: 'system', content: 'system' };
  const user = { role: 'user', content: 'task' };
  const receiptA = receiptMessage('', 'i1', 'recall:a', 'call_1');
  const receiptB = receiptMessage('', 'i2', 'recall:b', 'call_2');
  const reply = { role: 'assistant', content: 'reply' };
  const verdict = prefixStability([
    { seq: 2, messages: [system, user, receiptA, receiptB, reply] },
    { seq: 3, messages: [system, user, receiptB, receiptA, reply,
      { role: 'assistant', content: 'more' }] },
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.textRewriteCount, 0);
  assert.match(verdict.detail, /receipt-moved/u);
  assert.match(verdict.detail, /recall:a/u);
  assert.match(verdict.detail, /message index 2 to 3/u);
  assert.doesNotMatch(verdict.detail, /prefix-rewritten/u);
});
