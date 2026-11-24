/**
 * The reasoning set check, matched by identity and ledger-aware.
 *
 * The `1c`/`1d` shape: RACOONS removes a tool call and its result, the stripped
 * assistant message has no text and no reasoning, so the host leaves it off the
 * wire, and the assistant count stays flat while the next request carries the
 * new reply's reasoning. The old positional delta (`entries.slice(
 * previousEntries.length)`) read no reply and reported `71 vs 70` with no
 * string dropped or duplicated. These tests pin the exact shape, and pin that a
 * genuinely dropped or duplicated string still fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningCumulative } from './opencode-run.mjs';
import { receiptLineText } from './receipt-line.mjs';

const RECALL = 'recall:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const assistant = (content, options = {}) => ({
  role: 'assistant',
  content,
  ...(options.reasoning === undefined ? {} : { reasoning_content: options.reasoning }),
  ...(options.callId === undefined ? {} : {
    tool_calls: [{ id: options.callId, type: 'function',
      function: { name: 'read', arguments: '{"path":"big.txt"}' } }],
  }),
});

const receipt = (callId) => ({ role: 'user', content: receiptLineText(`oc:ses_x:tool:${callId}`, RECALL) });

const seedRow = (seq, messages) => ({ seq, messages, reply_reasoning_observable: true });

test('1d shape: a removal that empties an assistant message does not hide the new reply', () => {
  // Request 2 carries the seed plus the tool-call reply. Request 3 drops that
  // call (no text, no reasoning, so the message leaves the wire) and carries
  // the new reply's reasoning. The count is flat: 2 -> 2.
  const rows = [
    seedRow(1, [assistant('seed body', { reasoning: 'seed-1' })]),
    seedRow(2, [
      assistant('seed body', { reasoning: 'seed-1' }),
      assistant(null, { callId: 'call_A' }),
    ]),
    {
      seq: 3,
      messages: [
        assistant('seed body', { reasoning: 'seed-1' }),
        receipt('call_A'),
        assistant(null, { callId: 'call_B', reasoning: 'reply-2' }),
      ],
      reply_reasoning_observable: false,
      receipt_recall_ids: [RECALL],
    },
  ];
  const result = reasoningCumulative(rows, { texts: ['seed-1'], bytes: 6 },
    { recalls: [{ recallId: RECALL, callId: 'call_A' }] });
  assert.equal(result.pass, true, result.detail);
  assert.equal(result.perRequest[2].carried, 2);
  assert.equal(result.perRequest[2].expected, 2,
    'the expected set is the seed plus the observed reply, not 1');
  assert.deepEqual(result.perRequest[2].missing, []);
  assert.deepEqual(result.perRequest[2].extra, []);
  assert.equal(result.perRequest[2].replyContinuity.dropped.length, 0);
  assert.deepEqual(result.perRequest[2].replyContinuity.exempted,
    [{ callIds: ['call_A'], recallId: RECALL, reasoningStrings: 0 }]);
});

test('1d shape: a removed message that carried reasoning is exempted too', () => {
  const rows = [
    seedRow(1, [assistant('seed body', { reasoning: 'seed-1' })]),
    seedRow(2, [
      assistant('seed body', { reasoning: 'seed-1' }),
      assistant(null, { callId: 'call_A', reasoning: 'removed-think' }),
    ]),
    {
      seq: 3,
      messages: [
        assistant('seed body', { reasoning: 'seed-1' }),
        receipt('call_A'),
        assistant(null, { callId: 'call_B', reasoning: 'reply-2' }),
      ],
      reply_reasoning_observable: false,
      receipt_recall_ids: [RECALL],
    },
  ];
  const result = reasoningCumulative(rows, { texts: ['seed-1'], bytes: 6 },
    { recalls: [{ recallId: RECALL, callId: 'call_A' }] });
  assert.equal(result.pass, true, result.detail);
  assert.equal(result.perRequest[2].expected, 2,
    'the removed reasoning string leaves the expected set with its message');
});

test('a genuinely dropped reasoning string still fails, and names it', () => {
  const rows = [
    seedRow(1, [assistant('seed body', { reasoning: 'seed-1' })]),
    seedRow(2, [
      assistant('seed body', { reasoning: 'seed-1' }),
      assistant('reply one', { reasoning: 'reply-1' }),
    ]),
    {
      seq: 3,
      messages: [
        assistant('seed body', { reasoning: 'seed-1' }),
        assistant('reply two', { reasoning: 'reply-2' }),
      ],
      reply_reasoning_observable: false,
    },
  ];
  const result = reasoningCumulative(rows, { texts: ['seed-1'], bytes: 6 });
  assert.equal(result.pass, false);
  assert.deepEqual(result.perRequest[2].missing, ['reply-1']);
  assert.match(result.detail, /missing "reply-1"/u);
});

test('a genuinely duplicated reasoning string still fails', () => {
  // A mock row carries the script's own record of the reply, so the expected
  // set is not extended by the duplicate message: two carried copies where the
  // script names one are an extra.
  const carried = (seq, texts, reply) => ({
    seq,
    messages: texts.map((text) => assistant('ok', { reasoning: text })),
    reply_reasoning_text: reply,
  });
  const result = reasoningCumulative([
    carried(1, ['seed-1'], 'reply-1'),
    carried(2, ['seed-1', 'reply-1'], 'reply-2'),
    carried(3, ['seed-1', 'reply-1', 'reply-1'], ''),
  ], { texts: ['seed-1'], bytes: 6 });
  assert.equal(result.pass, false);
  assert.deepEqual(result.perRequest[2].extra, ['reply-1']);
  assert.match(result.detail, /extra "reply-1"/u);
});
