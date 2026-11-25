// ISSUE-443: a host `tools.register` refusal is named in the mount journal and
// stays fail-open. Registration is all-or-nothing, so the line states that no
// tool is advertised: before the fix the mount wrote only a host warning and
// read exactly like a healthy mount that offers both tools.
//
// No cap, no timeout (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DshMountContext, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import {
  RacoonsClosingError, createRacoonsMount, createRacoonsPlugin, resolvePluginConfig,
} from '../src/plugin.js';
import { resolveStorage } from '../src/storage.js';
import type { DshToolHost } from '../src/tools.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** A minimal fake dsh Session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: [], contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown) {
      const event: DshMountEvent = Object.freeze({ type, seq: log.length,
        data: Object.freeze(structuredClone(data)) });
      log.push(event);
      for (const listener of listeners) listener(session, event);
      return event;
    },
    on(listener: (session: FakeSession, event: DshMountEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return session;
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, open: release };
}

/** Wait one macrotask so an asynchronous lifecycle step can run. */
function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type Line = { kind: string; [field: string]: unknown };

test('ISSUE-454: a mount with no tools service names the absent outcome', async () => {
  const lines: Line[] = [];
  const plugin = createRacoonsPlugin({ journal: (record) => lines.push(record),
    storage: { databasePath: ':memory:' } });
  await plugin.apply({
    logger: { warn: () => {} },
    on: () => () => {},
    effect: () => {},
  } as unknown as DshMountContext, {});

  const outcome = lines.filter((line) => line.kind === 'tool-registration');
  assert.equal(outcome.length, 1, 'the absent service is named once');
  assert.equal(outcome[0]?.['status'], 'absent');
  assert.equal(outcome[0]?.['registered'], 0, 'no tool is advertised');
  assert.deepEqual(outcome[0]?.['offered'], ['forget', 'necromancy'],
    'the offered inventory is still named');
  assert.equal(outcome[0]?.['reason'], 'no-tools-service');
  assert.equal(lines.filter((line) => line.kind === 'mounted').length, 1,
    'the apply completed and journaled its mounted line');
});

test('ISSUE-454: a successful registration is distinguishable from an absent service', async () => {
  const lines: Line[] = [];
  const registered: string[] = [];
  const host = {
    register(tool: unknown): () => void {
      registered.push((tool as { readonly name: string }).name);
      return () => {};
    },
  } as unknown as DshToolHost;
  const plugin = createRacoonsPlugin({ journal: (record) => lines.push(record),
    storage: { databasePath: ':memory:' } });
  await plugin.apply({
    logger: { warn: () => {} },
    tools: host,
    on: () => () => {},
    effect: () => {},
  } as unknown as DshMountContext, {});

  const outcome = lines.filter((line) => line.kind === 'tool-registration');
  assert.equal(outcome.length, 1);
  assert.equal(outcome[0]?.['status'], 'registered');
  assert.equal(outcome[0]?.['registered'], 2);
  assert.deepEqual(outcome[0]?.['offered'], ['forget', 'necromancy']);
  assert.equal(outcome[0]?.['reason'], undefined, 'an absent service is not claimed');
  assert.deepEqual(registered, ['forget', 'necromancy'],
    'both offered tools reached the host registry');
  assert.equal(lines.filter((line) => line.kind === 'tool-registration-error').length, 0,
    'a successful registration writes no error line');
});

test('ISSUE-443: a refusing tool host is a named, fail-open mount', async () => {
  const lines: Line[] = [];
  const warnings: string[] = [];
  const registered: string[] = [];
  const host = {
    register(tool: unknown): () => void {
      const named = tool as { readonly name: string };
      // The second registration is refused, exactly the all-or-nothing shape:
      // `registerPluginTools` undoes the first and rethrows.
      if (named.name === 'necromancy') throw new Error('the host refused necromancy');
      registered.push(named.name);
      return () => {
        const at = registered.indexOf(named.name);
        if (at >= 0) registered.splice(at, 1);
      };
    },
  } as unknown as DshToolHost;
  const plugin = createRacoonsPlugin({
    journal: (record) => lines.push(record),
    storage: { databasePath: ':memory:' },
  });
  const ctx = {
    logger: { warn: (message: string) => { warnings.push(message); } },
    tools: host,
    on: () => () => {},
    effect: () => {},
  } as unknown as DshMountContext;

  await plugin.apply(ctx, {});

  const failed = lines.filter((line) => line.kind === 'tool-registration-error');
  assert.equal(failed.length, 1, 'exactly one named registration line');
  assert.equal(failed[0]?.['registered'], 0, 'the line states that no tool is advertised');
  assert.deepEqual(failed[0]?.['offered'], ['forget', 'necromancy'],
    'the line names the inventory the mount tried to advertise');
  assert.equal(failed[0]?.['allOrNothing'], true);
  assert.match(String(failed[0]?.['message']), /refused necromancy/u);
  assert.deepEqual(registered, [], 'neither forget nor recall stayed registered');
  assert.equal(warnings.length, 1, 'the host logger still sees the failure');
  assert.equal(lines.filter((line) => line.kind === 'mounted').length, 1,
    'the apply completed and journaled its mounted line');
});

test('ISSUE-435: endSession drains an in-flight recall before closing the ledger', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-435-end');
    const entry = await mount.sessionFor(session.id, session);

    let closes = 0;
    const closeLedger = entry.ledger.close.bind(entry.ledger);
    entry.ledger.close = async () => { closes += 1; await closeLedger(); };
    const started = gate();
    const release = gate();
    const readRecall = entry.ledger.recall.bind(entry.ledger);
    entry.ledger.recall = async (id, options) => {
      started.open();
      await release.promise;
      return readRecall(id, options);
    };

    let settledAt = -1;
    const work = mount.runToolWork(entry.sessionId,
      () => entry.adapter.recall(`recall:sha256:${'0'.repeat(64)}` as never))
      .finally(() => { settledAt = lines.length; });
    await started.promise;

    // The session ends while the recall is still reading the ledger.
    const ending = mount.endSession(session);
    await tick();
    assert.equal(mount.sessions.has(session.id), true,
      'the entry stays while the tool boundary is in flight');
    assert.equal(closes, 0, 'the ledger is not closed under the recall');

    release.open();
    // The recall now reads an OPEN ledger: whatever it finds is a ledger fact
    // (a miss), never the `LedgerError` a closed ledger produces.
    await assert.rejects(work, (error: unknown) => !/closed/iu.test(String(error)),
      'the recall never fails because its ledger closed underneath it');
    await ending;

    assert.equal(mount.sessions.has(session.id), false, 'the entry is released afterwards');
    assert.equal(closes, 1, 'the ledger closes exactly once, after the recall');
    const evictedAt = lines.findIndex((line) => line.kind === 'session-evicted');
    assert.ok(evictedAt >= settledAt, '`session-evicted` is written after the recall settled');
  } finally {
    await mount.close();
  }
});

test('ISSUE-435: close() drains an in-flight forget before closing the ledger', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const session = fakeSession('session-435-close');
  const entry = await mount.sessionFor(session.id, session);

  let closes = 0;
  const closeLedger = entry.ledger.close.bind(entry.ledger);
  entry.ledger.close = async () => { closes += 1; await closeLedger(); };
  const started = gate();
  const release = gate();
  const applyForget = entry.adapter.forget.bind(entry.adapter);
  entry.adapter.forget = async (request) => {
    started.open();
    await release.promise;
    return applyForget(request);
  };

  const work = mount.runToolWork(entry.sessionId,
    () => entry.adapter.forget({ path: 'big.txt' } as never));
  await started.promise;
  const closing = mount.close();
  await tick();

  assert.equal(mount.sessions.has(session.id), true, 'the entry stays during the drain');
  assert.equal(closes, 0, 'the ledger stays open for the in-flight forget');
  assert.throws(() => mount.runToolWork(session.id, async () => 0),
    (error: unknown) => error instanceof RacoonsClosingError,
    'a tool call that starts once close() began is refused by name');

  release.open();
  await work;
  await closing;
  assert.equal(closes, 1, 'the ledger closes exactly once, after the forget');
  assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 0,
    'close() is a shutdown: no end-of-session eviction is claimed before the tool settled');
});

test('ISSUE-435: a tool call after release refuses by name', async () => {
  const lines: Line[] = [];
  const tools = new Map<string, { execute(args: unknown): Promise<unknown> }>();
  const toolHost = {
    register(tool: unknown): () => void {
      const named = tool as { readonly name: string;
        execute(args: unknown): Promise<unknown> };
      tools.set(named.name, named);
      return () => { tools.delete(named.name); };
    },
  } as unknown as DshToolHost;
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: unknown[] = [];
  const plugin = createRacoonsPlugin({ journal: (record) => lines.push(record),
    storage: { databasePath: ':memory:' } });
  await plugin.apply({
    logger: { warn: () => {} },
    tools: toolHost,
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
    effect: (run: () => unknown) => { cleanups.push(run()); },
  } as unknown as DshMountContext, {});
  try {
    const session = fakeSession('session-435-refuse');
    const off = session.on((current, event) => {
      const listener = listeners.get('session/event') as
        ((target: FakeSession, incoming: DshMountEvent) => void) | undefined;
      listener?.(current, event);
    });
    const preStep = listeners.get('agent/pre-step') as
      (payload: unknown, next: () => unknown) => Promise<unknown>;
    await preStep({ agent: { session }, messages: [], turn: 1, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages: [] }));

    session.append('session/end', {});
    await tick(50);

    const recall = tools.get('necromancy');
    assert.ok(recall !== undefined, 'the recall tool stayed registered');
    await assert.rejects(recall.execute({ id: `recall:sha256:${'0'.repeat(64)}` }),
      (error: unknown) => (error as Error).name === 'CrematorToolSessionError',
      'a call after release refuses by its own name, not a driver error');
    off();
  } finally {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') await (cleanup as () => unknown)();
    }
  }
});
