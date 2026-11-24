/**
 * The receipt/pass ordering rule is source-aware (`receipt-pass-order`).
 *
 * A loopback-mock capture is stamped by the mock process, while the journal's
 * `atMs` is stamped by the host process. Those clocks disagree by a few
 * milliseconds, so the gate pair failed at requests 3 and 5 even though each
 * receipt was inside the request body. On that source the rule must order by
 * sequence, not by wall-clock. A same-process `http-request-hook` capture keeps
 * the timestamp check.
 *
 * Pure over hand-built journals and captured bodies: no host, no network, no
 * evidence directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { perRequestReapplication } from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

/** One adapter receipt message, naming `passId` and `recallId`. */
function receiptMessage(passId, recallId, callId = 'call_1') {
  return {
    id: `racoons-record:${passId}:0`,
    racoonsRecordId: `racoons-record:${passId}:0`,
    role: 'user',
    content: receiptLineText(`oc:ses_test:tool:${callId}`, recallId, '', '', passId),
  };
}

/** One applied step pass with its journal timestamp and the ids it applied. */
function journalWithPasses(passes) {
  return {
    appliedPasses: passes.map((pass, at) => ({
      eventId: `e${at + 1}`,
      intentId: pass.intentId,
      reason: 'step',
      status: 'applied',
      committed: true,
      atMs: pass.atMs,
    })),
    applications: passes.map((pass) => ({
      intentId: pass.intentId,
      recallIds: pass.recallIds,
    })),
  };
}

test('perRequestReapplication: a loopback-mock 2 ms reversal passes by sequence', () => {
  // The pass row is stamped 2 ms after the request row, but the receipt is in
  // that request's body and its applied ordinal is before the request's.
  const journal = journalWithPasses([
    { intentId: 'i1', recallIds: ['recall:a'], atMs: 1002 },
  ]);
  const mains = [{
    seq: 3, main_turn: 2, atMs: 1000,
    messages: [receiptMessage('i1', 'recall:a')],
    receipt_recall_ids: ['recall:a'],
  }];
  const verdict = perRequestReapplication(journal, mains, {
    captureSource: 'loopback-mock-jsonl',
  });
  assert.equal(verdict.applicable, true, verdict.detail);
  assert.equal(verdict.pass, true, verdict.detail);
  assert.equal(verdict.ordering, 'sequence');
  assert.match(verdict.detail, /ordering: sequence/u);
  assert.doesNotMatch(verdict.detail, /receipt-pass-order/u);
  assert.equal(verdict.failures.length, 0);
});

test('perRequestReapplication: a real-route pass after the request still fails by wall clock', () => {
  // The same rows on the same-process capture: the pass is 2 ms later than the
  // request that carries its receipt, which is a real ordering failure there.
  const journal = journalWithPasses([
    { intentId: 'i1', recallIds: ['recall:a'], atMs: 1002 },
  ]);
  const mains = [{
    seq: 3, main_turn: 2, atMs: 1000,
    messages: [receiptMessage('i1', 'recall:a')],
    receipt_recall_ids: ['recall:a'],
  }];
  const verdict = perRequestReapplication(journal, mains, {
    captureSource: 'http-request-hook',
  });
  assert.equal(verdict.applicable, true, verdict.detail);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.ordering, 'wall-clock');
  assert.match(verdict.detail, /receipt-pass-order/u);
  assert.match(verdict.detail, /ordering: wall-clock/u);
  assert.match(verdict.detail, /applied after the request/u);
  assert.match(verdict.detail, /"passAtMs":1002/u);
  assert.match(verdict.detail, /"requestAtMs":1000/u);
});

test('perRequestReapplication: a loopback-mock pass after the request still fails by sequence', () => {
  // Two applied passes, one main request. Pass 2's applied ordinal is after
  // the request's, and the receipt names an id pass 2 never applied, so the
  // ids fallback cannot accept the pair either.
  const journal = journalWithPasses([
    { intentId: 'i1', recallIds: ['recall:a'], atMs: 1000 },
    { intentId: 'i2', recallIds: ['recall:b'], atMs: 1002 },
  ]);
  const mains = [{
    seq: 3, main_turn: 2, atMs: 1004,
    messages: [receiptMessage('i2', 'recall:c')],
    receipt_recall_ids: ['recall:c'],
  }];
  const verdict = perRequestReapplication(journal, mains, {
    captureSource: 'loopback-mock-jsonl',
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.ordering, 'sequence');
  assert.match(verdict.detail, /receipt-pass-order/u);
  assert.match(verdict.detail, /ordering: sequence/u);
  assert.match(verdict.detail, /by sequence/u);
  assert.match(verdict.detail, /"passIndex":2/u);
  assert.match(verdict.detail, /"requestIndex":1/u);
});

test('perRequestReapplication: two applies in one request are accepted when the ids hold', () => {
  // The at-rest commit and the ask commit can apply in the same request, so
  // pass 2's applied ordinal is after the request's ordinal. Every id the
  // receipt names is one pass 2 applied, so the sequence fallback accepts the
  // pair; the subset/coverage rule still reads it.
  const journal = journalWithPasses([
    { intentId: 'i1', recallIds: ['recall:a'], atMs: 1000 },
    { intentId: 'i2', recallIds: ['recall:a'], atMs: 1001 },
  ]);
  const mains = [{
    seq: 3, main_turn: 2, atMs: 1002,
    messages: [receiptMessage('i1', 'recall:a'), receiptMessage('i2', 'recall:a')],
    receipt_recall_ids: ['recall:a'],
  }];
  const verdict = perRequestReapplication(journal, mains, {
    captureSource: 'loopback-mock-jsonl',
  });
  assert.equal(verdict.pass, true, verdict.detail);
  assert.equal(verdict.ordering, 'sequence');
  assert.match(verdict.detail, /ordering: sequence/u);
  assert.equal(verdict.failures.length, 0);
});
