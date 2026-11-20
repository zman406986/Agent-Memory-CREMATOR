// The replay gate for a host that rebuilds every request (ISSUE-192; ADR-0044;
// ADR-0045). `rewriteHistory: false` says the host keeps its own store: the
// mutation a context hook makes is visible to one request only. So the same
// base revision can come back on the next request, and the removal must happen
// again — a committed event id is not a receipt the model can see.
//
// The rows here are:
//   1. two hooks, the second handed a freshly rebuilt array from the original
//      parts at the same base revision: both requests must lose the unit, each
//      carries one receipt;
//   2. two hooks over the same post-apply array: no second receipt, no change.
//
// No live host, no API key: the mount runs the real engine and a ledger in
// memory over plain message objects.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeMessage } from '../src/host.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

/** Above `DEFAULT_CONFIG.protocol.barBytes` (512), so the read is one unit. */
const BIG_BODY = `# Note\n\n${'body line\n'.repeat(1100)}`;

/**
 * The host's own stored history: one prompt, one read of NOTES.md, a second
 * prompt, the identical read again (which supersedes the first), and a closing
 * answer. This is what the host rebuilds every request from.
 */
function storedHistory(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read it.')]),
    assistantMessage('msg_a1', [text('Reading.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(BIG_BODY))]),
    userMessage('msg_u2', [text('Read it again.')]),
    assistantMessage('msg_a2', [text('Reading again.'), toolCall('call_2', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(BIG_BODY))]),
  ];
}

/** One request the way the host builds it: a fresh deep copy of its own store. */
function rebuild(store: readonly OpencodeMessage[]): OpencodeMessage[] {
  return structuredClone(store) as OpencodeMessage[];
}

function revisions(messages: readonly OpencodeMessage[]): string {
  return deriveOpencodeSnapshot(messages, { sessionId }).snapshot.revision;
}

/** The node the superseded-read rule burns: the first of the two identical reads. */
function supersededUnitId(messages: readonly OpencodeMessage[]): string {
  const node = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .find(candidate => candidate.kind === 'tool-result' && candidate.id.includes('call_1'));
  assert.ok(node !== undefined, 'the fixture holds the first read as a unit');
  return node.id;
}

function isReceipt(message: OpencodeMessage): boolean {
  return typeof message[OPENCODE_RECORD_ID_FIELD] === 'string';
}

function receiptCount(messages: readonly OpencodeMessage[]): number {
  return messages.filter(isReceipt).length;
}

const REPLAY_ROWS: readonly Row[] = [
  { name: 'a rebuilt request at the same base revision is rewritten again',
    async run(at) {
      const store = storedHistory();
      const gone = supersededUnitId(store);
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        // Request 1: the host's first copy. The mount plans and commits here.
        const first = rebuild(store);
        await mount.transform(sessionId, first);
        assert.equal(
          deriveOpencodeSnapshot(first, { sessionId }).snapshot.nodes.some(node => node.id === gone),
          false, at('request 1 lost the superseded read'));
        assert.equal(receiptCount(first), 1, at('request 1 carries one receipt'));

        // Request 2: the host rebuilt from the same store, so the base revision
        // is identical. The removal from request 1 was never persisted; this
        // request must get its own.
        const second = rebuild(store);
        assert.equal(revisions(second), revisions(store),
          at('the rebuilt array describes the same base revision'));
        await mount.transform(sessionId, second);
        assert.equal(
          deriveOpencodeSnapshot(second, { sessionId }).snapshot.nodes.some(node => node.id === gone),
          false, at('request 2 lost the superseded read too'));
        assert.equal(receiptCount(second), 1, at('request 2 carries exactly one receipt'));
        assert.equal(
          second.some(message => message.role === 'tool'
            && message.content.some(part => part['id'] === 'call_1')),
          false, at('the superseded result message is gone from request 2'));
      } finally { await mount.close(); }
    } },
  { name: 'the same post-apply array twice takes no second receipt',
    async run(at) {
      const store = storedHistory();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        const first = rebuild(store);
        await mount.transform(sessionId, first);
        assert.equal(receiptCount(first), 1, at('the first request carries one receipt'));
        const postApply = structuredClone(first) as OpencodeMessage[];
        assert.equal(revisions(postApply), revisions(first),
          at('the copy is the array the commit left'));

        const firstReplay = structuredClone(postApply) as OpencodeMessage[];
        await mount.transform(sessionId, firstReplay);
        assert.deepEqual(firstReplay, postApply, at('a hook over the post-apply array changes nothing'));
        assert.equal(receiptCount(firstReplay), 1, at('one receipt, never a second'));

        const secondReplay = structuredClone(postApply) as OpencodeMessage[];
        await mount.transform(sessionId, secondReplay);
        await mount.transform(sessionId, secondReplay);
        assert.deepEqual(secondReplay, postApply,
          at('repeated hooks over the post-apply array change nothing'));
        assert.equal(receiptCount(secondReplay), 1, at('still one receipt after repeated hooks'));
      } finally { await mount.close(); }
    } },
];

test('replay: a rebuilt request is rewritten again, and the post-apply array is inert', async () => {
  await runRows(REPLAY_ROWS);
});
