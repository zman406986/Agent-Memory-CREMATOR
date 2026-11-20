// The applied claim follows the wire write (audit finding: a staged receipt is
// not an applied receipt). A staging port's `apply` leaves the host array
// untouched; the engine runs the port's `commit` before it records a durable
// receipt. These two rows are the mount's own statement of that ordering: the
// at-rest row says `applied` only when the commit line beside it says a splice
// landed, and the ledger carries exactly one claim for that pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ledger } from '@cremator/core';
import type { OpencodeMessage } from '../src/host.js';
import {
  createOpencodeMount,
} from '../src/plugin.js';
import type {
  OpencodeJournalKind, OpencodeJournalRecord, OpencodeMountPort,
} from '../src/plugin.js';
import type { OpencodePortOptions } from '../src/port.js';
import { createOpencodePort } from '../src/port.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

/**
 * One large read and a later write to the same path: the step pass's stale-read
 * rule plans the removal, so a mount test drives a real application end to end.
 */
function staleReadMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note, then rewrite it.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTE.md.'),
      toolCall('call_read', 'read', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_read', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a2', [
      text('Rewriting NOTE.md.'),
      toolCall('call_write', 'write', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_write', 'write', textResult('written'))]),
    assistantMessage('msg_a3', [text('Done.')]),
  ];
}

function journalLines(): {
  readonly records: OpencodeJournalRecord[];
  of(kind: OpencodeJournalKind): OpencodeJournalRecord[];
} {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/**
 * The shipped port with a commit that answers `false` and splices nothing: a
 * host seam that refuses the staged array. The engine must read that answer as
 * "the wire never carried this pass". The refusal is one this seam can prove —
 * it refused the splice itself — so its lookup answers `not-applied` for the
 * refused stage (ISSUE-306): only an `unknown` lookup, absence the host cannot
 * prove, stays pending. The shipped port alone answers `unknown` for a stage
 * whose commit never ran.
 */
function refusingCommitPort(options: OpencodePortOptions): OpencodeMountPort {
  const inner = createOpencodePort(options);
  let refusedIntent: string | null = null;
  return {
    snapshot: () => inner.snapshot(),
    apply: request => {
      refusedIntent = request.intent.intentId;
      return inner.apply(request);
    },
    lookupReceipt: async intentId => {
      if (intentId === refusedIntent) return { status: 'not-applied' };
      return inner.lookupReceipt(intentId);
    },
    observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
    commit: () => false,
    refusal: () => inner.refusal(),
  };
}

/** The ledger's applied and abandoned intents, in order. */
async function claims(ledger: Ledger): Promise<{
  readonly applied: string[]; readonly abandoned: string[];
}> {
  const applied: string[] = [];
  const abandoned: string[] = [];
  for await (const { event } of ledger.events(sessionId)) {
    if (event.kind === 'applied') applied.push(event.receipt.intentId);
    if (event.kind === 'abandoned') abandoned.push(event.intentId);
  }
  return { applied, abandoned };
}

test('a commit that answers false leaves no applied claim and no applied at-rest row', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' }, createPort: refusingCommitPort,
    journal: record => lines.records.push(record),
  });
  const messages = staleReadMessages();
  const before = structuredClone(messages);
  try {
    await mount.transform(sessionId, messages);
    assert.deepEqual(messages, before, 'the host array keeps every byte');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');

    const { applied, abandoned } = await claims(entry.ledger);
    assert.deepEqual(applied, [], 'no durable applied claim exists');
    assert.equal(abandoned.length, 1, 'the uncommitted stage is abandoned');

    const atRest = lines.of('at-rest').filter(row => row['reason'] === 'step');
    assert.equal(atRest.length, 1, 'one step pass ran');
    assert.notEqual(atRest[0]?.['status'], 'applied',
      'an applied claim is not journalled for a wire write that never landed');
    assert.equal(atRest[0]?.['intentId'], abandoned[0],
      'the at-rest row names the intent the ledger abandoned');
    assert.equal(lines.of('commit').at(-1)?.['committed'], false,
      'the commit line says nothing landed');
  } finally { await mount.close(); }
});

test('a commit that answers true leaves exactly one applied claim and an applied at-rest row',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record),
    });
    const messages = staleReadMessages();
    try {
      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the stale read left the host array');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');

      const { applied, abandoned } = await claims(entry.ledger);
      assert.equal(applied.length, 1, 'exactly one durable applied claim');
      assert.deepEqual(abandoned, [], 'a committed stage is never abandoned');

      const atRest = lines.of('at-rest').filter(row => row['reason'] === 'step');
      assert.equal(atRest.length, 1, 'one step pass ran');
      assert.equal(atRest[0]?.['status'], 'applied', 'the at-rest row says applied');
      assert.equal(atRest[0]?.['intentId'], applied[0],
        'the at-rest row names the intent the ledger applied');
      assert.equal(lines.of('commit').at(-1)?.['committed'], true,
        'the commit line agrees: the splice landed');
    } finally { await mount.close(); }
  });
