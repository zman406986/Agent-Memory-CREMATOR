// Drive the OpenCode mount the way the host does — every request rebuilt from
// the host's own store — and print the bodies it would send. The dev test
// (`removal-bodies.test.mjs`) feeds these bodies to the corrected removal rule.
//
// Not a test file: `npm run test:dev` matches `*.test.mjs` only. The test spawns
// this script under the repo's TypeScript resolve hook, so it reads the adapter
// source rather than a possibly stale `dist/`.

import { createOpencodeMount } from '../../packages/adapters/opencode/src/plugin.js';
import { deriveOpencodeSnapshot } from '../../packages/adapters/opencode/src/snapshot.js';
import type { OpencodeMessage } from '../../packages/adapters/opencode/src/host.js';

const sessionId = 'ses_removal_bodies';
/** A body with one sentinel: the exact bytes a request must stop carrying. */
const SENTINEL = 'racoons-removal-bodies-sentinel';
const BIG_BODY = `# Note\n\n${SENTINEL}\n${'body line\n'.repeat(1100)}`;

function message(role: OpencodeMessage['role'], id: string, content: unknown[]): OpencodeMessage {
  return { id, role, content } as OpencodeMessage;
}

/** The host's own stored history: two identical reads, so the first is superseded. */
function storedHistory(): OpencodeMessage[] {
  return [
    message('user', 'msg_u1', [{ type: 'text', text: 'Read it.' }]),
    message('assistant', 'msg_a1', [
      { type: 'text', text: 'Reading.' },
      { type: 'tool-call', id: 'call_superseded_1', name: 'read', input: { filePath: 'NOTES.md' } },
    ]),
    message('tool', 'msg_t1', [
      { type: 'tool-result', id: 'call_superseded_1', name: 'read', result: { type: 'text', value: BIG_BODY } },
    ]),
    message('user', 'msg_u2', [{ type: 'text', text: 'Read it again.' }]),
    message('assistant', 'msg_a2', [
      { type: 'text', text: 'Reading again.' },
      { type: 'tool-call', id: 'call_surviving_2', name: 'read', input: { filePath: 'NOTES.md' } },
    ]),
    message('tool', 'msg_t2', [
      { type: 'tool-result', id: 'call_surviving_2', name: 'read', result: { type: 'text', value: BIG_BODY } },
    ]),
  ];
}

function receiptsOf(messages: readonly OpencodeMessage[]): number {
  return messages.filter(message => typeof message['racoonsRecordId'] === 'string').length;
}

function bodyOf(seq: number, messages: readonly OpencodeMessage[]) {
  return { seq, messages: structuredClone(messages), receipt_messages: receiptsOf(messages) };
}

const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
try {
  const store = storedHistory();
  const forgotten = deriveOpencodeSnapshot(store, { sessionId }).snapshot.nodes
    .find(node => node.kind === 'tool-result' && node.id.includes('call_superseded_1'))?.id ?? null;

  // Request 1: the host's first copy.
  const first = structuredClone(store) as OpencodeMessage[];
  await mount.transform(sessionId, first);

  // Request 2: the host rebuilds from the same store, so the base revision is
  // the first request's. Its removal was never persisted; it must happen again.
  const second = structuredClone(store) as OpencodeMessage[];
  await mount.transform(sessionId, second);

  // Request 3: the array a pass left, sent twice. Both hooks must leave it alone.
  const postApply = structuredClone(second) as OpencodeMessage[];
  const replayA = structuredClone(postApply) as OpencodeMessage[];
  const replayB = structuredClone(postApply) as OpencodeMessage[];
  await mount.transform(sessionId, replayA);
  await mount.transform(sessionId, replayB);

  process.stdout.write(`${JSON.stringify({
    removed: BIG_BODY,
    sentinel: SENTINEL,
    // The unit's own marker: its call id names the call and result parts that
    // leave, and no surviving copy carries it. The result body cannot be the
    // marker here because the superseded read's identical twin stays.
    removedUnit: 'call_superseded_1',
    // The surviving twin: the later read of the same file. Its call id and the
    // file's sentinel must be present in every request measured after the
    // removal, or the body lost both halves and proves no removal.
    survivingUnit: 'call_surviving_2',
    forgotten,
    requests: [
      bodyOf(1, first),
      bodyOf(2, second),
      bodyOf(3, replayA),
      bodyOf(4, replayB),
    ],
    postApplyUnchanged: JSON.stringify(replayA) === JSON.stringify(postApply)
      && JSON.stringify(replayB) === JSON.stringify(postApply),
  })}\n`);
} finally {
  await mount.close();
}
