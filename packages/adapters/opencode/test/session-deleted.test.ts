// ISSUE-379: `session.deleted` is lifecycle eviction. The deleted session's
// entry leaves the open map and its owned ledger closes through the same
// release path `close()` uses, after the ISSUE-356 drain settles in-flight
// work. No cap, no LRU, no timeout: the host's deletion is the only trigger
// (standing rule 7 / ADR-0060). Payload verified against the installed
// @opencode SDK: `data: { sessionID }`, the sibling events' own shape.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  OpencodeHostEvent, OpencodeMessage, OpencodePluginContext, OpencodeSessionContext,
} from '../src/host.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import { openLedger } from '../src/storage.js';
import { assistantMessage, text, userMessage } from './fixtures.js';

const SES_A = 'ses_deleted_a';
const SES_B = 'ses_deleted_b';

/** The smallest request that opens a session ledger. */
function smallMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [text('The note is short.')]),
  ];
}

function deletedEvent(sessionID: string): OpencodeHostEvent {
  return { type: 'session.deleted', data: { sessionID } };
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

async function tick(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve); });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) await tick();
  assert.ok(condition(), 'the awaited condition never held');
}

test('ISSUE-379: session.deleted closes the deleted ledger and evicts only that session', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(SES_A, smallMessages());
    await mount.transform(SES_B, smallMessages());
    const entryA = mount.sessions.get(SES_A);
    const entryB = mount.sessions.get(SES_B);
    assert.ok(entryA !== undefined && entryB !== undefined, 'both sessions opened');
    // Spy on the instance's own close: the mount must call it exactly once.
    let closesA = 0;
    const originalClose = entryA.ledger.close.bind(entryA.ledger);
    entryA.ledger.close = async () => { closesA += 1; await originalClose(); };

    await mount.event(deletedEvent(SES_A));

    assert.equal(mount.sessions.has(SES_A), false, 'the deleted session left the open map');
    assert.equal(mount.sessions.has(SES_B), true, 'the other session is unaffected');
    assert.equal(closesA, 1, 'the owned ledger closed through the release path');
    assert.equal(lines.of('session-evicted').length, 1, 'the eviction is journalled');
    assert.equal(lines.of('session-evicted')[0]?.['sessionId'], SES_A);

    // Idempotent: a second deletion (and one for a session never opened)
    // releases nothing and closes nothing twice.
    await mount.event(deletedEvent(SES_A));
    await mount.event(deletedEvent('ses_never_opened'));
    assert.equal(closesA, 1, 'no second close on an already-released session');
    assert.equal(lines.of('session-evicted').length, 1, 'no second eviction line');
    assert.equal(mount.sessions.has(SES_B), true, 'the survivor still stands');
  } finally {
    await mount.close();
  }
});

test('ISSUE-379: eviction drains in-flight work before releasing (ISSUE-356 path)', async () => {
  const lines = journalLines();
  let opens = 0;
  let releaseOpen = (): void => {};
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    // The second session's open suspends, holding its transform in flight.
    openLedger: async (target, clock) => {
      opens += 1;
      if (opens === 2) await openGate;
      return openLedger(target, clock);
    },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(SES_A, smallMessages());
    const pending = mount.transform(SES_B, smallMessages());
    await waitFor(() => opens === 2);

    const evicting = mount.event(deletedEvent(SES_A));
    await tick();
    assert.equal(mount.sessions.has(SES_A), true,
      'the eviction waits for the in-flight transform, it does not race it');

    releaseOpen();
    await pending;
    await evicting;
    assert.equal(mount.sessions.has(SES_A), false, 'the entry released after the drain');
    assert.equal(mount.sessions.has(SES_B), true, 'the drained session keeps its entry');
    const evictedAt = lines.records.findIndex(record => record.kind === 'session-evicted');
    const settledAt = lines.records.findIndex(record => record.kind === 'at-rest'
      && record['sessionId'] === SES_B && record['reason'] === 'step');
    assert.ok(evictedAt > settledAt && settledAt >= 0,
      'the in-flight transform settled before the eviction was journalled');
  } finally {
    releaseOpen();
    await mount.close();
  }
});

test('ISSUE-379: the plugin subscribes session.deleted and evicts through the stream', async () => {
  const lines = journalLines();
  const queue: OpencodeHostEvent[] = [];
  const waiters: ((result: IteratorResult<OpencodeHostEvent>) => void)[] = [];
  let subscribedTypes: readonly string[] = [];
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void>) | null;
  } = { context: null };
  const stream: AsyncIterable<OpencodeHostEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false as const, value: event });
        return new Promise(resolve => { waiters.push(resolve); });
      },
      return: async () => {
        for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
        return { done: true as const, value: undefined };
      },
    }),
  };
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void>) => {
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
          return {};
        }
        throw new Error('this fake predates the awaited idle seam');
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => void) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: {
      subscribe: (options?: { types?: readonly string[] }) => {
        subscribedTypes = options?.types ?? [];
        return stream;
      },
    },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  const cleanup = await plugin.setup(context);
  try {
    assert.ok(subscribedTypes.includes('session.deleted'),
      'the subscription names session.deleted');
    await hooks.context?.({ sessionID: SES_A, messages: smallMessages() });
    const push = (event: OpencodeHostEvent): void => {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ done: false, value: event });
      else queue.push(event);
    };
    push(deletedEvent(SES_A));
    await waitFor(() => lines.of('session-evicted').length === 1);
    assert.equal(lines.of('session-evicted')[0]?.['sessionId'], SES_A,
      'the streamed deletion evicted the session');
  } finally {
    await cleanup();
  }
});

test('ISSUE-393: a hook during close() neither re-opens a released session nor transforms a closing one', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  // One 'storage-plan' line per real ledger open: the re-open detector.
  const opens = (): number => lines.of('storage-plan').length;
  let closing: Promise<void> | null = null;
  let releaseClose = (): void => {};
  try {
    await mount.transform(SES_A, smallMessages());
    await mount.transform(SES_B, smallMessages());
    assert.equal(opens(), 2, 'both sessions opened once');
    const entryA = mount.sessions.get(SES_A);
    assert.ok(entryA !== undefined, 'session A opened');
    // Suspend the FIRST release's ledger close: A has left the map, B is still
    // mapped, and the host can still deliver hooks during the await.
    let markClosing = (): void => {};
    const closingStarted = new Promise<void>(resolve => { markClosing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const originalClose = entryA.ledger.close.bind(entryA.ledger);
    entryA.ledger.close = async () => { markClosing(); await closeGate; await originalClose(); };
    closing = mount.close();
    await closingStarted;
    assert.equal(mount.sessions.has(SES_A), false, 'the released session left the map');
    assert.equal(mount.sessions.has(SES_B), true, 'the next session is still mapped');
    const atRestBefore = lines.of('at-rest').length;
    // A hook for the released session must not re-open an owned handle the
    // consumed key snapshot never revisits.
    await mount.transform(SES_A, smallMessages());
    // A hook for the still-mapped session must not start a pass whose ledger
    // close is next in the loop (the ISSUE-356 closed-ledger write class).
    await mount.transform(SES_B, smallMessages());
    assert.equal(opens(), 2, 'no ledger re-opened during close');
    assert.equal(lines.of('at-rest').length, atRestBefore, 'no pass started during close');
    releaseClose();
    await closing;
    closing = null;
    assert.equal(mount.sessions.size, 0, 'every session released');
    // Idempotent: a second close releases nothing and opens nothing.
    await mount.close();
    assert.equal(opens(), 2, 'the second close opened nothing');
    assert.equal(mount.sessions.size, 0, 'the second close left the map empty');
  } finally {
    releaseClose();
    if (closing !== null) await closing;
    // Red leaves a re-opened entry the first close's snapshot never visited;
    // the second close releases it so no handle outlives the test.
    await mount.close();
  }
});