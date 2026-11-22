// ISSUE-418: a `session/end` must not evict the per-session call facts or the
// main-wire capture while an in-flight boundary is still reading them. The
// eviction lives on the release path, after the boundary and the flush, so an
// ask that has not read its seed yet still sees it and no valid seed becomes a
// false `no-seed`.
//
// ISSUE-402: the pending `/cremate` request is per-session state. Eviction
// clears it with the rest of the entry, so a request recorded but never
// consumed cannot fire a paid pass on a later reopen of the same session id.
// No cap, no timeout (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createMainWireCapture } from '../src/main-wire.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** A minimal fake dsh Session: an append-only log with surface markers (ISSUE-377 harness). */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) {
          throw new Error(`surface replace: seq out of surface (${String(op.startSeq)}..${String(op.endSeq)})`);
        }
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options['sourceEventSeqs'];
      const event: DshMountEvent = Object.freeze({
        type, seq, data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined ? {}
          : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) },
      });
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

/** A model seam that enters the ask, signals it, then waits for the test's gate. */
function gatedLlm(): {
  readonly started: Promise<void>;
  open(): void;
  readonly llm: { stream(): AsyncIterable<DshLlmChunk> };
} {
  const entered = gate();
  const waiting = gate();
  return {
    started: entered.promise,
    open: () => waiting.open(),
    llm: {
      stream(): AsyncIterable<DshLlmChunk> {
        return (async function* emit() {
          entered.open();
          await waiting.promise;
          yield { type: 'text-delta', index: 0,
            text: '{"1":{"keeplines":[[1,1]],"summary":"kept the first line"}}' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    },
  };
}

type Line = { kind: string; [field: string]: unknown };

test('ISSUE-418: session/end during an in-flight ask keeps the seed and the call facts', async () => {
  const lines: Line[] = [];
  const model = gatedLlm();
  const mainWire = createMainWireCapture();
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 128,
      entryAskTrigger: { mode: 'count' } }),
    storage: resolveStorage(undefined), mainWire,
    journal: (record) => lines.push(record),
    llm: model.llm as never,
    judgeRoute: { provider: 'p', model: 'm' },
  });
  try {
    const session = fakeSession('session-418-seed');
    session.on((sess, event) => { mount.observe(sess, event); });
    await mount.sessionFor(session.id, session);
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'm',
      system: 'MAIN SYSTEM PROMPT',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }] });
    assert.ok(mainWire.last(session.id) !== null, 'the seed is captured before the boundary');

    // The step's surface: one over-floor result and the call it pairs with.
    const body = `${Array.from({ length: 40 }, (_, index) =>
      `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 2 });
    session.append('user/message', { content: [{ type: 'text', text: 'read big.txt' }],
      source: { kind: 'user' }, role: 'user', id: 'user-1' }, { surfaceOp: 'append' });
    const callSeq = session.append('tool/call', { turn: 1, step: 2, callId: 'c1',
      name: 'read', arguments: '{"file_path":"c1.txt"}' }).seq;
    session.append('assistant/message', { turn: 1, step: 2,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: 'c1', name: 'read',
          arguments: '{"file_path":"c1.txt"}' }], id: 'asst-c1' } },
    { surfaceOp: 'append' });
    session.append('tool/result', { turn: 1, step: 2,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: body }], isError: false, id: 'result-c1' } },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    session.append('step/end', { turn: 1, step: 2 });

    // Start the step and end the session BEFORE the ask reads its seed. The
    // session/end observer runs while the boundary is still in flight.
    const stepPromise = mount.runStep(session, { turn: 1, step: 2 });
    session.append('session/end', {});
    const endPromise = mount.endSession(session);

    assert.ok(mainWire.last(session.id) !== null,
      'the main-wire capture survives the observer; the release evicts it (ISSUE-418)');
    // Nothing was evicted by the observer: the capture still seeds the ask, and
    // a later result still pairs with the call facts stored at boundary start.
    session.append('tool/call', { turn: 1, step: 2, callId: 'c2',
      name: 'read', arguments: '{"file_path":"c2.txt"}' });
    const later = mount.observe(session, { type: 'tool/result', seq: session.log.length,
      surfaceOp: 'append', data: { turn: 1, step: 2, message: { role: 'tool',
        source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2',
        content: [{ type: 'text', text: 'bytes' }], id: 'result-c2' } } });
    assert.equal(later?.toolName, 'read',
      'the call facts are still readable while the boundary runs (ISSUE-418)');

    // The ask reached the model: a `no-seed` refusal leaves before any send.
    const started = await Promise.race([
      model.started.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 1_000); }),
    ]);
    model.open();
    assert.equal(started, true, 'the in-flight ask saw its seed and sent its request');
    await stepPromise;
    await endPromise;

    assert.equal(mainWire.last(session.id), null,
      'the release path evicts the capture once the boundary is done');

    const noSeed = lines.filter((line) => line.kind === 'entry-ask-refused'
      && line['code'] === 'no-seed');
    assert.equal(noSeed.length, 0, 'a seed that existed at boundary start never became no-seed');
    assert.equal(lines.filter((line) => line.kind === 'entry-ask').length, 1,
      'the ask settled on its own merits');
    assert.equal(mount.sessions.has(session.id), false,
      'the release ran after the boundary');
    assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 1,
      'the eviction is journalled once');
  } finally {
    model.open();
    await mount.close();
  }
});

/** One observed host event that never reached the fake session's surface. */
function synthetic(type: string, seq: number, data: unknown): DshMountEvent {
  return { type, seq, surfaceOp: 'append', data };
}

test('ISSUE-433: a session that never opened an entry is evicted too', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-433-entryless');
    // A host can emit a message and a result before the first pre-step, so the
    // mount-wide maps fill while `sessions` holds no entry. The events are not
    // appended to the surface, so nothing but the carried maps can deliver them
    // into a reopened life.
    mount.observe(session, synthetic('user/message', 100,
      { content: [{ type: 'text', text: '/cremate' }], source: { kind: 'user' } }));
    const item = mount.observe(session, synthetic('tool/result', 101, { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: 'stale result' }], isError: false, id: 'result-c1' } }));
    assert.ok(item !== null, 'the result was captured before any entry existed');
    assert.equal(mount.sessions.has(session.id), false, 'no entry was opened');

    await mount.endSession(session);
    assert.equal(mount.sessions.size, 0, 'the ended id holds no entry');

    // Reopen the same id and drive a boundary: the carried-over capture and
    // `/cremate` request must not survive into the new life.
    await mount.sessionFor(session.id, session);
    const before = lines.length;
    const stepResult = await mount.runStep(session, { turn: 1, step: 1 });
    assert.equal(stepResult.deliveries.length, 0, 'no carried-over capture was delivered');
    assert.equal(lines.filter((line) => line.kind === 'entry').length, 0,
      'no stale result reached the engine');
    assert.equal(lines.filter((line) => line.kind === 'prune-requested').length, 1,
      'the request was recorded in the first life');
    const after = lines.slice(before);
    assert.equal(after.some((line) => line.kind.startsWith('prune-')), false,
      'no prune lane ran on the reopened entry');
  } finally {
    await mount.close();
  }
});

test('ISSUE-433: an opened session is evicted on session/end as before', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-433-opened');
    await mount.sessionFor(session.id, session);
    mount.observe(session, synthetic('user/message', 200,
      { content: [{ type: 'text', text: '/cremate' }], source: { kind: 'user' } }));
    assert.ok(mount.observe(session, synthetic('tool/result', 201, { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2',
        content: [{ type: 'text', text: 'stale result' }], isError: false, id: 'result-c2' } }))
      !== null);

    await mount.endSession(session);
    assert.equal(mount.sessions.has(session.id), false, 'the opened entry was released');

    await mount.sessionFor(session.id, session);
    const before = lines.length;
    const stepResult = await mount.runStep(session, { turn: 1, step: 1 });
    assert.equal(stepResult.deliveries.length, 0,
      'the released entry left no capture for the reopened life');
    const after = lines.slice(before);
    assert.equal(after.some((line) => line.kind.startsWith('prune-')), false,
      'no unrequested paid pass runs on the reopened entry');
  } finally {
    await mount.close();
  }
});

test('ISSUE-402: a pending /cremate request is cleared by eviction, not replayed on reopen', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const prunes = (): number => lines.filter((line) => line.kind === 'prune-recorded').length;
  try {
    // (a) Recorded and never consumed: the eviction must clear it.
    const session = fakeSession('session-402-evicted');
    session.on((sess, event) => { mount.observe(sess, event); });
    await mount.sessionFor(session.id, session);
    session.append('user/message', { content: [{ type: 'text', text: '/cremate' }],
      source: { kind: 'user' }, role: 'user', id: 'cremate-1' });
    assert.equal(lines.filter((line) => line.kind === 'prune-requested').length, 1,
      'the request is recorded');
    session.append('session/end', {});
    await mount.endSession(session);

    // Reopen the same id and drive a boundary: the stale request must not fire.
    await mount.sessionFor(session.id, session);
    await mount.runStep(session, { turn: 1, step: 1 });
    assert.equal(prunes(), 0, 'no unrequested pass runs on the reopened entry');

    // (b) Recorded, consumed by a pass, then evicted: still no residual state.
    const consumed = fakeSession('session-402-consumed');
    consumed.on((sess, event) => { mount.observe(sess, event); });
    await mount.sessionFor(consumed.id, consumed);
    consumed.append('user/message', { content: [{ type: 'text', text: '/cremate' }],
      source: { kind: 'user' }, role: 'user', id: 'cremate-2' });
    await mount.runStep(consumed, { turn: 1, step: 1 });
    assert.equal(prunes(), 1, 'a request in an open session fires exactly once');
    await mount.runStep(consumed, { turn: 1, step: 2 });
    assert.equal(prunes(), 1, 'a consumed request never fires a second time');

    consumed.append('session/end', {});
    await mount.endSession(consumed);
    await mount.sessionFor(consumed.id, consumed);
    await mount.runStep(consumed, { turn: 1, step: 3 });
    assert.equal(prunes(), 1, 'the consumed-then-evicted request leaves nothing to replay');
  } finally {
    await mount.close();
  }
});

test('ISSUE-452: a session/end after a reopen releases the reopened life', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const firstClose = gate();
  try {
    const session = fakeSession('session-452-second-life');
    const first = await mount.sessionFor(session.id, session);
    const firstEntered = gate();
    const closeFirst = first.ledger.close.bind(first.ledger);
    let firstCloses = 0;
    first.ledger.close = async () => {
      firstCloses += 1;
      firstEntered.open();
      await firstClose.promise;
      await closeFirst();
    };

    // End A owns the first life and is gated inside its ledger close.
    const endingA = mount.endSession(session);
    await firstEntered.promise;

    // The host reopens the id and ends the NEW life before A settles.
    const second = await mount.sessionFor(session.id, session);
    assert.notEqual(second, first, 'the reopen built a fresh entry');
    const closeSecond = second.ledger.close.bind(second.ledger);
    let secondCloses = 0;
    second.ledger.close = async () => { secondCloses += 1; await closeSecond(); };
    const endingB = mount.endSession(session);
    const settledBeforeGate = await Promise.race([
      endingB.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 50); }),
    ]);
    assert.equal(settledBeforeGate, true,
      'the reopened life releases without waiting on the old gated close');
    assert.equal(secondCloses, 1, 'the reopened ledger closed once');
    assert.equal(mount.sessions.has(session.id), false, 'the reopened life left the map');
    assert.ok(lines.some((line) => line.kind === 'session-evicted'
      && line['sessionId'] === session.id),
    'the second life named its eviction before the old close finished');

    firstClose.open();
    await Promise.all([endingA, endingB]);
    assert.equal(firstCloses, 1, 'the old ledger closed once');
    assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 2,
      'each life named its own eviction');
  } finally {
    firstClose.open();
    await mount.close();
  }
});

test('ISSUE-455: close() evicts a main-wire-only session id', async () => {
  const lines: Line[] = [];
  const mainWire = createMainWireCapture();
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), mainWire, journal: (record) => lines.push(record) });
  mount.observeWire({ sessionId: 'session-455-wire-only', messages: [
    { role: 'user', content: [{ type: 'text', text: 'main request' }] }] });
  assert.notEqual(mainWire.last('session-455-wire-only'), null,
    'the request was captured before any session event');
  assert.deepEqual(mainWire.sessionIds(), ['session-455-wire-only']);

  await mount.close();

  assert.equal(mainWire.last('session-455-wire-only'), null,
    'close() evicted the wire-only id');
  assert.deepEqual(mainWire.sessionIds(), [],
    'the store holds no id after the shutdown');
});

test('ISSUE-474: observation during close cannot repopulate an evicted session', async () => {
  const lines: Line[] = [];
  const mainWire = createMainWireCapture();
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), mainWire, journal: (record) => lines.push(record) });
  const releaseGate = gate();
  try {
    const session = fakeSession('session-474-late-observe');
    const entry = await mount.sessionFor(session.id, session);
    const entered = gate();
    entry.ledger.close = async () => {
      entered.open();
      await releaseGate.promise;
    };

    // The shutdown begins and parks inside the release's ledger close, after
    // the id was evicted and the observed-id list was read once.
    const closing = mount.close();
    await entered.promise;

    // The host still dispatches to the listeners that stay attached through
    // dispose: a call fact, a cappable result, a `/cremate` request and a main
    // request, all for the id close() just evicted.
    assert.equal(mount.observe(session, synthetic('tool/call', 401, { turn: 1, step: 1,
      callId: 'c1', name: 'read', arguments: '{"file_path":"c1.txt"}' })), null,
    'a call during close is refused, so calls hold no id');
    assert.equal(mount.observe(session, synthetic('tool/result', 402, { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: 'late result' }], isError: false, id: 'result-c1' } })),
    null, 'a result during close is refused, so buffers hold no id');
    assert.equal(mount.observe(session, synthetic('user/message', 403,
      { content: [{ type: 'text', text: '/cremate' }], source: { kind: 'user' } })), null,
    'a /cremate request during close is refused');
    mount.observeWire({ sessionId: session.id, messages: [
      { role: 'user', content: [{ type: 'text', text: 'late main request' }] }] });

    releaseGate.open();
    await closing;

    assert.equal(mainWire.last(session.id), null,
      'mainWire holds no id after close resolved');
    assert.deepEqual(mainWire.sessionIds(), [],
      'no observed id survives the shutdown');
    assert.equal(lines.filter((line) => line.kind === 'prune-requested').length, 0,
      'the late /cremate request was never recorded, so pruneRequests holds no id');
    // The DoD names every per-session map, not only the three readable through
    // the journal and the main-wire capture. `observedSessionIds()` is the union
    // of `calls`, `buffers`, `pruneRequests` and the rest, so an empty answer is
    // the assertion the vacuous `observe(...) === null` checks above cannot make:
    // it fails if the late `tool/call` re-adds the id to `calls` or the late
    // `tool/result` re-adds it to `buffers`.
    assert.deepEqual(mount.observedSessionIds(), [],
      'no per-session map (calls, buffers, pruneRequests, …) holds the id after close');
    assert.equal(mount.counters.captured, 0,
      'the late tool/result was never buffered, so buffers holds no capture');
    assert.equal(mount.sessions.size, 0, 'close released the entry');
  } finally {
    releaseGate.open();
    await mount.close();
  }
});

test('ISSUE-451: a gated release does not evict a reopen that lands during the await', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-451-reopen');
    const entry = await mount.sessionFor(session.id, session);
    const entered = gate();
    const release = gate();
    const closeLedger = entry.ledger.close.bind(entry.ledger);
    let closes = 0;
    entry.ledger.close = async () => {
      closes += 1;
      entered.open();
      await release.promise;
      await closeLedger();
    };

    const ending = mount.endSession(session);
    await entered.promise;

    // The host reopens the same id while the old release is inside its gated
    // ledger close (ISSUE-374 allows this).
    const reopened = await mount.sessionFor(session.id, session);
    assert.notEqual(reopened, entry, 'the reopen built a fresh entry');
    const captured = mount.observe(session, synthetic('tool/result', 301, { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c9' }, toolCallId: 'c9',
        content: [{ type: 'text', text: 'new life capture' }], isError: false,
        id: 'result-c9' } }));
    assert.ok(captured !== null, 'the new life captured a result');

    release.open();
    await ending;

    assert.equal(mount.sessions.get(session.id), reopened,
      'the old release did not evict the reopened entry');
    assert.equal(closes, 1, 'the old ledger closed once');
    await mount.runStep(session, { turn: 1, step: 1 });
    assert.ok(lines.some((line) => (line.kind === 'entry' || line.kind === 'entry-error')
      && line['callId'] === 'c9'),
    'the reopened life kept its capture through the old ledger close');
  } finally {
    await mount.close();
  }
});
