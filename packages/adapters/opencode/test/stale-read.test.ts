// The stale-read proof on the OpenCode adapter (ADR-0046; ISSUE-197).
//
// The rule burns a read when a later call wrote one of the paths that read
// observed (`packages/core/src/rules/stale.ts:32-45`). On this adapter that
// needs `write` to be its own evidence kind and to carry the same call-argument
// path the read side uses. Before ADR-0046 the classifier mapped `write` to
// `other`, so no later node could ever satisfy the rule and every row here
// failed to remove anything.
//
// The rows are:
//   1. the snapshot states the fact: the read is `read`, the write is `write`,
//      and both name NOTES.md;
//   2. a later write of the same path removes the read whole, with a receipt;
//   3. a later write of a different path keeps the read (the control);
//   4. two rebuilt requests each lose the read and carry none of its bytes,
//      which is the opencode per-request application model (ISSUE-196).
//
// No live host, no API key: the mount runs the real engine and a ledger in
// memory over plain message objects.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeMessage } from '../src/host.js';
import {
  OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot, opencodeToolNodeId,
} from '../src/snapshot.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

/** Above `DEFAULT_CONFIG.protocol.barBytes` (512), so the read is one unit. */
const SENTINEL = 'STALE_READ_SENTINEL_9f3c';
const BIG_BODY = `# Note\n\n${'body line\n'.repeat(1100)}${SENTINEL}\n`;

const READ_NODE = opencodeToolNodeId(sessionId, 'call_1');

/**
 * One prompt, one read of NOTES.md, then one write of `writePath` and its
 * result. The write result is deliberately small: the rule reads the write
 * node's kind and path, never its size.
 */
function readThenWrite(writePath: string): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read it, then write.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(BIG_BODY))]),
    assistantMessage('msg_a2', [
      text('Writing.'),
      toolCall('call_2', 'write', { filePath: writePath, content: 'replaced' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'write', textResult(`Wrote ${writePath}`))]),
  ];
}

function rebuild(store: readonly OpencodeMessage[]): OpencodeMessage[] {
  return structuredClone(store) as OpencodeMessage[];
}

function nodesOf(messages: readonly OpencodeMessage[]) {
  return deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes;
}

function isReceipt(message: OpencodeMessage): boolean {
  return typeof message[OPENCODE_RECORD_ID_FIELD] === 'string';
}

function receipts(messages: readonly OpencodeMessage[]): OpencodeMessage[] {
  return messages.filter(isReceipt);
}

/** The receipt text of the one receipt this fixture can carry. */
function receiptText(messages: readonly OpencodeMessage[]): string {
  const found = receipts(messages);
  assert.equal(found.length, 1, 'exactly one receipt is expected');
  const content = found[0]?.content ?? [];
  return content.filter(part => part.type === 'text').map(part => String(part['text'])).join('');
}

const ROWS: readonly Row[] = [
  { name: 'a later write of the same path removes the read whole, with a receipt',
    async run(at) {
      const store = readThenWrite('NOTES.md');
      const request = rebuild(store);
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, request);
        assert.equal(nodesOf(request).some(node => node.id === READ_NODE), false,
          at('the stale read is gone from the request'));
        assert.equal(request.some(message => message.role === 'tool'
          && message.content.some(part => part['id'] === 'call_1')), false,
          at('the read result part is gone too'));
        assert.equal(request.some(message => JSON.stringify(message).includes(SENTINEL)), false,
          at('none of the read bytes survive anywhere in the request'));
        assert.equal(receipts(request).length, 1, at('the burn leaves one receipt'));
        assert.match(receiptText(request), /NOTES\.md|call_1/u,
          at('the receipt names the burned read by its path (a read is a hit path)'));
        assert.equal(receipts(request)[0]?.['racoonsReceiptOf'] === undefined, false,
          at('the receipt carries its ledger record id'));
      } finally { await mount.close(); }
    } },
  { name: 'the snapshot states a read and a later write of the same path', run(at) {
    const snapshot = deriveOpencodeSnapshot(readThenWrite('NOTES.md'), { sessionId });
    const read = snapshot.snapshot.nodes.find(node => node.id === READ_NODE);
    const write = snapshot.snapshot.nodes
      .find(node => node.kind === 'tool-result' && node.callId === 'call_2');
    assert.ok(read !== undefined && read.kind === 'tool-result', at('the read is a unit'));
    assert.ok(write !== undefined && write.kind === 'tool-result', at('the write is a unit'));
    assert.equal(read.evidence.kind, 'read', at('the read keeps its kind'));
    assert.equal(write.evidence.kind, 'write',
      at('write is its own evidence kind, not other (ADR-0046)'));
    assert.deepEqual(write.evidence.target, { key: 'NOTES.md', label: 'NOTES.md' },
      at('the write names its path with the read side\'s extraction'));
    const readPaths = new Set(read.evidence.paths.map(path => path.pathKey));
    const writePaths = write.evidence.paths.map(path => path.pathKey);
    assert.ok(writePaths.includes('NOTES.md') && readPaths.has('NOTES.md'),
      at('the two observations name the same path key'));
  } },
  { name: 'a later write of a different path keeps the read (the control)',
    async run(at) {
      const store = readThenWrite('OTHER.md');
      const request = rebuild(store);
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, request);
        assert.equal(nodesOf(request).some(node => node.id === READ_NODE), true,
          at('a write to another path proves nothing about NOTES.md'));
        assert.equal(receipts(request).length, 0, at('nothing is removed, so no receipt'));
        assert.equal(request.some(message => JSON.stringify(message).includes(SENTINEL)), true,
          at('the read bytes stay in the request'));
      } finally { await mount.close(); }
    } },
  { name: 'two rebuilt requests each lose the read and carry none of its bytes',
    async run(at) {
      const store = readThenWrite('NOTES.md');
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        const first = rebuild(store);
        await mount.transform(sessionId, first);
        assert.equal(nodesOf(first).some(node => node.id === READ_NODE), false,
          at('request 1 lost the stale read'));
        assert.equal(receipts(first).length, 1, at('request 1 carries one receipt'));

        // The host rebuilds from its own store: same base revision, the removal
        // from request 1 was never persisted, so request 2 must get its own.
        const second = rebuild(store);
        assert.equal(
          deriveOpencodeSnapshot(second, { sessionId }).snapshot.revision,
          deriveOpencodeSnapshot(store, { sessionId }).snapshot.revision,
          at('the rebuilt array describes the same base revision'),
        );
        await mount.transform(sessionId, second);
        assert.equal(nodesOf(second).some(node => node.id === READ_NODE), false,
          at('request 2 lost the stale read too'));
        assert.equal(receipts(second).length, 1, at('request 2 carries exactly one receipt'));
        for (const [label, request] of [['request 1', first], ['request 2', second]] as const) {
          assert.equal(request.some(message => JSON.stringify(message).includes(SENTINEL)), false,
            at(`${label} carries none of the removed content`));
        }
      } finally { await mount.close(); }
    } },
];

test('stale-read: a later write of the read\'s path burns it on every request', async () => {
  await runRows(ROWS);
});
