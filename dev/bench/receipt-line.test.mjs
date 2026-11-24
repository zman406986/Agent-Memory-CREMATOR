// The one receipt-line parser the bench checker and the mock share
// (ISSUE-256 item 1). The product writes
// `[not retained] <target> · pass <intent id> · necromancy <recall id>`;
// a receipt from an older writer stops at the recall id, and the reader must
// say "no pass named" rather than assume the request's pass order.
//
// The non-vacuity rule (docs/guides/law-verification-non-vacuity.md): every
// expected value here is written by hand or by `receiptLineText`, which mirrors
// the product's template; the parser under test is the only thing that reads a
// line, and each test names the answer a wrong reader would give.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PASS_COMMAND, allowedReceiptString, isAdapterReceiptMessage, isReceiptLineText, isReceiptMessage,
  isWireReceiptMessage, receiptLineText, receiptPassIdOfLine, receiptPassOfLine, receiptRecallIdsOfLine,
} from './receipt-line.mjs';

/** The pass id the product writes: the intent of the apply (prepare.ts). */
const PASS_ID = `intent:sha256:${'a'.repeat(64)}`;
const RECALL_ID = `recall:sha256:${'b'.repeat(64)}`;

test('receipt pass: the writer\'s line names its exact pass id', () => {
  const line = receiptLineText('docs/a.md', RECALL_ID, ' lines 3–9', ' — about: retry', PASS_ID);
  assert.equal(line,
    `[not retained] docs/a.md lines 3–9 — about: retry · pass ${PASS_ID} · necromancy ${RECALL_ID}`);
  assert.equal(isReceiptLineText(line), true, 'the line is still the product\'s receipt');
  assert.deepEqual(receiptPassOfLine(line), { status: 'named', passId: PASS_ID });
  assert.equal(receiptPassIdOfLine(line), PASS_ID);
  // The pass segment did not move the recall id off the end of the line.
  assert.deepEqual(receiptRecallIdsOfLine(line), [RECALL_ID]);
});

test('receipt pass: a line with no pass segment names none', () => {
  const oldLine = receiptLineText('docs/a.md', RECALL_ID, ' lines 3–9', ' — about: retry');
  assert.equal(isReceiptLineText(oldLine), true, 'the older line is still a receipt');
  assert.deepEqual(receiptPassOfLine(oldLine), { status: 'absent' });
  assert.equal(receiptPassIdOfLine(oldLine), null,
    'an older receipt is never read as a pass from request order');
});

test('receipt pass: garbage is refused by its own name, never read as a pass', () => {
  // A marker with no id: the line cannot name a pass.
  const noId = `${receiptLineText('docs/a.md', RECALL_ID)}`.replace(
    ` · necromancy ${RECALL_ID}`, ` · pass · necromancy ${RECALL_ID}`);
  assert.deepEqual(receiptPassOfLine(noId), { status: 'malformed' });
  assert.equal(receiptPassIdOfLine(noId), null);

  // Two pass segments: the reader will not pick one.
  const twice = receiptLineText('docs/a.md', RECALL_ID, '', '', PASS_ID).replace(
    ` · pass ${PASS_ID}`, ` · pass ${PASS_ID} · pass intent:sha256:${'c'.repeat(64)}`);
  assert.deepEqual(receiptPassOfLine(twice), {
    status: 'ambiguous', passIds: [PASS_ID, `intent:sha256:${'c'.repeat(64)}`],
  });

  // A pass token after the recall marker is not the writer's position.
  const afterRecall = `${receiptLineText('docs/a.md', RECALL_ID)} · pass ${PASS_ID}`;
  assert.deepEqual(receiptPassOfLine(afterRecall), { status: 'malformed' });
  assert.equal(receiptPassIdOfLine(afterRecall), null);

  // A marker that only starts a longer word is not the command.
  const passage = receiptLineText('docs/a.md', RECALL_ID, '', ' — about: · passage 2');
  assert.deepEqual(receiptPassOfLine(passage), { status: 'absent' },
    '`· passage` is a label, not a pass marker');

  // Text that is not the product's receipt line at all.
  assert.deepEqual(receiptPassOfLine('a plain note · pass ' + PASS_ID), { status: 'not-a-receipt' });
  assert.deepEqual(receiptPassOfLine(''), { status: 'not-a-receipt' });
  assert.deepEqual(receiptPassOfLine(null), { status: 'not-a-receipt' });
});

// The wire shape is what opencode keeps: it serializes a receipt to
// `{role: "user", content: "<line>"}` and drops `racoonsRecordId` and the
// message `id`. The exemption therefore has to recognise that exact shape; a
// tool result, a user message with any other text, and a restored archive stay
// ordinary messages for the removed-byte scan. The marker field is still
// sufficient when a host keeps it.
test('receipt exemption: a marker field or the exact user wire shape grants the allowance', () => {
  const line = receiptLineText('docs/a.md', RECALL_ID);
  // A tool result that quotes the product's line is still a receipt by text...
  const quoted = { role: 'tool', tool_call_id: 'call_q', content: line };
  assert.equal(isReceiptMessage(quoted), true);
  // ...but it is not a user message, so it has no adapter record and none of
  // its strings are exempt.
  assert.equal(isAdapterReceiptMessage(quoted), false);
  assert.equal(allowedReceiptString(quoted, line), false,
    'a quoted receipt line is scanned, not exempted');

  // The adapter's marker field is sufficient when a host keeps it.
  const marked = {
    ...quoted,
    id: 'racoons-record:intent-1:0',
    racoonsRecordId: 'racoons-record:intent-1:0',
  };
  assert.equal(isAdapterReceiptMessage(marked), true);
  assert.equal(allowedReceiptString(marked, line), true);
  // The record-id carrier alone survives a host rebuild that drops the field.
  const idOnly = { id: 'racoons-record:intent-1:0', role: 'user', content: line };
  assert.equal(isAdapterReceiptMessage(idOnly), true);
  assert.equal(allowedReceiptString(idOnly, line), true);

  // The wire shape a user receipt serializes to: role user, only receipt lines.
  const wire = { role: 'user', content: line };
  assert.equal(isWireReceiptMessage(wire), true);
  assert.equal(isAdapterReceiptMessage(wire), true);
  assert.equal(allowedReceiptString(wire, line), true);
  // The pass segment the adapter inserts is part of the same shape, and one
  // content string may carry more than one receipt line.
  const withPass = { role: 'user', content: receiptLineText('docs/a.md', RECALL_ID, '', '', PASS_ID) };
  assert.equal(isAdapterReceiptMessage(withPass), true);
  assert.equal(allowedReceiptString(withPass, withPass.content), true);
  const twoLines = { role: 'user', content: `${line}\n${withPass.content}` };
  assert.equal(isWireReceiptMessage(twoLines), true);
  assert.equal(allowedReceiptString(twoLines, twoLines.content), true);
  // One non-receipt line, or receipt text plus anything else, is not the shape.
  const mixed = { role: 'user', content: `${line}\nREMOVED-BYTES` };
  assert.equal(isWireReceiptMessage(mixed), false, 'extra text is not a receipt');
  assert.equal(isAdapterReceiptMessage(mixed), false);
  assert.equal(allowedReceiptString(mixed, mixed.content), false);
  const trailing = { role: 'user', content: `${line}` };
  assert.equal(isAdapterReceiptMessage({ ...trailing, content: `${line} · extra` }), false,
    'text after the recall id is not the adapter line');
  // A restored archive is not a user wire receipt however its line reads.
  const archive = { role: 'assistant', content: [{ type: 'text', text: line }] };
  assert.equal(isAdapterReceiptMessage(archive), false);
  assert.equal(allowedReceiptString(archive, line), false);
  // A negative fact is a record only when the adapter marks it too; a quoted
  // `[search: …]` line has no marker and stays scanned.
  const negative = { role: 'user', content: '[search: missing] nothing matched' };
  assert.equal(isReceiptMessage(negative), true);
  assert.equal(isAdapterReceiptMessage(negative), false);
  assert.equal(allowedReceiptString(negative,
    '[search: missing] nothing matched'), false);

  // A wire receipt may name the removed call id in its target slot.
  const callId = 'call_single_1_RS-SINGLE-UNIT';
  const wireLine = receiptLineText(`oc:ses_1:tool:${callId}`, RECALL_ID, '', '', PASS_ID);
  const wireNamingUnit = { role: 'user', content: wireLine };
  assert.equal(isWireReceiptMessage(wireNamingUnit), true);
  // The unit's own call id and marker sentinel sit in the target slot once:
  // the product's pointer, not the unit still being there.
  assert.equal(allowedReceiptString(wireNamingUnit, wireLine, {
    markers: [callId, 'RS-SINGLE-UNIT'], contentMarkers: ['FILE-SENTINEL'],
  }), true);
  // A content marker has no legitimate home in the line, including its target.
  assert.equal(allowedReceiptString(wireNamingUnit, wireLine, {
    markers: [callId], contentMarkers: ['FILE-SENTINEL'],
  }), true, 'the line does not carry the content marker');
  const leak = { role: 'user', content: receiptLineText('FILE-SENTINEL', RECALL_ID) };
  assert.equal(allowedReceiptString(leak, leak.content, {
    markers: [callId], contentMarkers: ['FILE-SENTINEL'],
  }), false, 'the file sentinel in the target is scanned');
  // Twice in the target, or once outside it, is a leak.
  const twice = { role: 'user', content: receiptLineText(`${callId} ${callId}`, RECALL_ID) };
  assert.equal(allowedReceiptString(twice, twice.content, { markers: [callId] }), false);
  const label = {
    role: 'user',
    content: receiptLineText('big.txt', RECALL_ID, '', ` — about: ${callId}`),
  };
  assert.equal(allowedReceiptString(label, label.content, { markers: [callId] }), false,
    'the call id in the label is not the target slot');
  // The same text in a tool result is scanned whole.
  const tool = { role: 'tool', tool_call_id: 'call_q', content: line };
  assert.equal(allowedReceiptString(tool, line, { markers: [callId] }), false);
});
