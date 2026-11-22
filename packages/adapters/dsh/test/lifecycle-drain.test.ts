// ISSUE-401: every in-flight boundary per session is drained before its
// release. The registry is a per-session SET of boundary promises, so a second
// concurrent boundary (a direct `runPrune` overlapping an in-flight ask) cannot
// escape the drain, and boundaries that settle out of order remove only their
// own registration.
//
// ISSUE-416: `close()` is a shutdown, not a release loop. It sets a closing
// guard that refuses new work by name, flushes owed appends, drains every
// boundary of every session, and only then releases. No cap, no timeout
// (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshMountEvent, DshMountSession, RacoonsApplicationRequest,
} from '../src/plugin.js';
import {
  RacoonsClosingError, createRacoonsMount, resolvePluginConfig, resolveStorage,
} from '../src/plugin.js';

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

/** One committed append the host has not received yet (the ISSUE-342 queue). */
function owedAppend(recordId: string, text: string): RacoonsApplicationRequest {
  return { application: { mode: 'append', appendRecords: [
    { recordId, bytes: new TextEncoder().encode(text) }] } } as unknown as RacoonsApplicationRequest;
}

/** How many of this package's records the host surface holds. */
function recordCount(session: FakeSession, recordId: string): number {
  let count = 0;
  for (const seq of session.surface?.nodes ?? []) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'user/message') continue;
    const source = (event.data as { source?: { kind?: string; recordId?: string } }).source;
    if (source?.kind === 'racoons/negation' && source.recordId === recordId) count += 1;
  }
  return count;
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

/**
 * A fake model seam whose nth `stream` call suspends on the nth gate until the
 * test opens it; a call with no gate proceeds at once. `answers[index]` is the
 * reply text that call delivers (`{"keepall":true}` when none is named).
 */
function gatedLlm(gates: readonly Gate[], answers: readonly string[] = []): {
  readonly started: (index: number) => Promise<void>;
  readonly llm: { stream(): AsyncIterable<DshLlmChunk> };
} {
  const entered = gates.map(() => gate());
  let position = 0;
  return {
    started: (index: number) => entered[index]?.promise ?? Promise.resolve(),
    llm: {
      stream(): AsyncIterable<DshLlmChunk> {
        const index = position;
        position += 1;
        const waiting = gates[index];
        const wake = entered[index];
        const text = answers[index] ?? '{"keepall":true}';
        return (async function* emit() {
          wake?.open();
          if (waiting !== undefined) await waiting.promise;
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    },
  };
}

/** One scripted step whose over-floor, over-bar result both lanes may ask about. */
function stepSurface(session: FakeSession): void {
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
}

function seedWire(mount: { observeWire(options: unknown): void }, sessionId: string): void {
  mount.observeWire({ sessionId, provider: 'p', model: 'm',
    system: 'MAIN SYSTEM PROMPT',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }] });
}

/** Wait one macrotask so an asynchronous lifecycle step can run. */
function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type Line = { kind: string; [field: string]: unknown };

test('ISSUE-401: endSession drains a direct runPrune and a step ask that settle out of order', async () => {
  const lines: Line[] = [];
  // Call 0 is the direct prune, call 1 the step's entry ask. The prune settles
  // FIRST; the old single-slot registry would have released the session while
  // the step was still inside its ask.
  const pruneGate = gate();
  const stepGate = gate();
  const model = gatedLlm([pruneGate, stepGate],
    ['{"keeplines":[[1,40],"None"]}', '{"keepall":true}']);
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 128,
      entryAskTrigger: { mode: 'count' } }),
    storage: resolveStorage(undefined),
    journal: (record) => lines.push(record),
    llm: model.llm as never,
    judgeRoute: { provider: 'p', model: 'm' },
  });
  try {
    const session = fakeSession('session-401-order');
    session.on((sess, event) => { mount.observe(sess, event); });
    const entry = await mount.sessionFor(session.id, session);
    let closes = 0;
    const originalClose = entry.ledger.close.bind(entry.ledger);
    entry.ledger.close = async () => { closes += 1; await originalClose(); };
    seedWire(mount, session.id);
    stepSurface(session);

    // The direct prune registers first and suspends in its own ask.
    const prunePromise = mount.runPrune(session);
    await model.started(0);
    // The step registers second and suspends in its entry ask.
    const stepPromise = mount.runStep(session, { turn: 1, step: 2 });
    await model.started(1);

    session.append('session/end', {});
    const endPromise = mount.endSession(session);

    // The prune settles first. The step is still in flight, so the session must
    // stay open until it too settles.
    pruneGate.open();
    const pruneOutcome = await prunePromise;
    await tick();
    assert.equal(mount.sessions.has(session.id), true,
      'the still-running step keeps the session open (ISSUE-401)');
    assert.equal(closes, 0, 'no ledger was closed under a live boundary');

    stepGate.open();
    const stepResult = await stepPromise;
    await endPromise;

    assert.equal(pruneOutcome !== null, true, 'the prune boundary ran to its own end');
    assert.equal(stepResult.entry.sessionId, session.id, 'the step boundary ran to its own end');
    assert.equal(mount.sessions.has(session.id), false, 'the release ran after both boundaries');
    assert.equal(closes, 1, 'the owned ledger closed exactly once');
    assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 1,
      'the eviction is journalled once');
    assert.equal(lines.some((line) => line.kind === 'at-rest-error'), false,
      'no pass aborted against a closed ledger');
  } finally {
    pruneGate.open();
    stepGate.open();
    await mount.close();
  }
});

test('ISSUE-453: close() waits for an in-flight session/end release', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const closeGate = gate();
  try {
    const session = fakeSession('session-453-close');
    const entry = await mount.sessionFor(session.id, session);
    const entered = gate();
    let closes = 0;
    entry.ledger.close = async () => {
      closes += 1;
      entered.open();
      await closeGate.promise;
    };

    const ending = mount.endSession(session);
    await entered.promise;
    // The end is parked inside its ledger close; a shutdown must not resolve
    // until it settles.
    const closing = mount.close();
    let resolved = false;
    void closing.then(() => { resolved = true; });
    await tick();
    assert.equal(resolved, false,
      'close() stays pending while an in-flight end release closes');
    assert.equal(lines.some((line) => line.kind === 'session-evicted'), false,
      'no eviction line lands before the end settles');

    closeGate.open();
    await Promise.all([ending, closing]);
    assert.equal(resolved, true, 'close() resolves once the end settled');
    assert.equal(closes, 1, 'the owned ledger closed exactly once');
    assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 1,
      'the eviction is journalled once, before close resolved');
  } finally {
    closeGate.open();
    await mount.close();
  }
});

test('ISSUE-473: a second end with no reopen waits for the gated release and close drains both', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const closeGate = gate();
  try {
    const session = fakeSession('session-473-second-end');
    const entry = await mount.sessionFor(session.id, session);
    const entered = gate();
    let closes = 0;
    entry.ledger.close = async () => {
      closes += 1;
      entered.open();
      await closeGate.promise;
    };

    // End A owns the life and parks inside its ledger close. A second end with
    // no reopen has no mapped entry, so it does not coalesce with A; it must
    // still not settle before A's ledger closed.
    const endingA = mount.endSession(session);
    await entered.promise;
    const endingB = mount.endSession(session);
    let bSettled = false;
    void endingB.then(() => { bSettled = true; });
    await tick();
    assert.equal(bSettled, false,
      'the second end waits for the first life\'s ledger close');

    // A shutdown started in that window must drain both registrations.
    const closing = mount.close();
    let resolved = false;
    void closing.then(() => { resolved = true; });
    await tick();
    assert.equal(resolved, false, 'close() stays pending while a gated end is live');
    assert.equal(lines.some((line) => line.kind === 'session-evicted'), false,
      'no eviction line lands before the gated release settles');

    closeGate.open();
    await Promise.all([endingA, endingB, closing]);
    assert.equal(bSettled, true, 'the second end settled after the gated release');
    assert.equal(closes, 1, 'the owned ledger closed exactly once');
    assert.equal(lines.filter((line) => line.kind === 'session-evicted').length, 1,
      'exactly one eviction line for the first life');
  } finally {
    closeGate.open();
    await mount.close();
  }
});

test('ISSUE-401: close drains an in-flight ask and a direct runPrune, then releases', async () => {
  const lines: Line[] = [];
  const stepGate = gate();
  const pruneGate = gate();
  // Call 0 is the step's ask, call 1 the prune's; either order is a boundary.
  const model = gatedLlm([stepGate, pruneGate],
    ['{"keepall":true}', '{"keeplines":[[1,40],"None"]}']);
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 128,
      entryAskTrigger: { mode: 'count' } }),
    storage: resolveStorage(undefined),
    journal: (record) => lines.push(record),
    llm: model.llm as never,
    judgeRoute: { provider: 'p', model: 'm' },
  });
  try {
    const session = fakeSession('session-401-close');
    session.on((sess, event) => { mount.observe(sess, event); });
    const entry = await mount.sessionFor(session.id, session);
    let closes = 0;
    const originalClose = entry.ledger.close.bind(entry.ledger);
    entry.ledger.close = async () => { closes += 1; await originalClose(); };
    seedWire(mount, session.id);
    stepSurface(session);

    const stepPromise = mount.runStep(session, { turn: 1, step: 2 });
    await model.started(0);
    const prunePromise = mount.runPrune(session);
    await model.started(1);

    const closePromise = mount.close();
    await tick();
    assert.equal(mount.sessions.has(session.id), true,
      'close waits for the in-flight boundaries instead of releasing them');
    assert.equal(closes, 0, 'nothing closed while a boundary still runs');

    // The prune settles first; close must keep waiting for the step.
    pruneGate.open();
    await prunePromise;
    await tick();
    assert.equal(mount.sessions.has(session.id), true,
      'close still waits for the second boundary after the first settled');

    stepGate.open();
    const stepResult = await stepPromise;
    await closePromise;

    assert.equal(stepResult.entry.sessionId, session.id, 'the drained step completed');
    assert.equal(mount.sessions.has(session.id), false, 'close released every session');
    assert.equal(closes, 1, 'the owned ledger closed exactly once');
    assert.equal(lines.some((line) => line.kind === 'at-rest-error'), false,
      'no pass aborted against a closed ledger');
  } finally {
    stepGate.open();
    pruneGate.open();
    await mount.close();
  }
});

test('ISSUE-416: close flushes owed appends before releasing; a second close is a no-op', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  const session = fakeSession('session-416-flush');
  session.on((sess, event) => { mount.observe(sess, event); });
  const entry = await mount.sessionFor(session.id, session);
  let closes = 0;
  const originalClose = entry.ledger.close.bind(entry.ledger);
  entry.ledger.close = async () => { closes += 1; await originalClose(); };
  entry.pendingAppends.push(owedAppend('rec-416-1', 'owed at close'));

  await mount.close();

  assert.equal(recordCount(session, 'rec-416-1'), 1,
    'close flushed the committed-but-unpublished record');
  assert.equal(mount.sessions.has(session.id), false, 'close released the session');
  assert.equal(closes, 1, 'the owned ledger closed exactly once');
  const failed = lines.filter((line) => line.kind === 'append-publish-failed');
  assert.equal(failed.length, 0, 'the close-time flush succeeded');

  // A second close finds the flag set and the map empty: nothing re-opens and
  // nothing closes twice.
  await mount.close();
  assert.equal(closes, 1, 'the second close closed nothing');
});

test('ISSUE-416: a boundary arriving during close is refused by name, not served', async () => {
  const lines: Line[] = [];
  const stepGate = gate();
  const model = gatedLlm([stepGate]);
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 128,
      entryAskTrigger: { mode: 'count' } }),
    storage: resolveStorage(undefined),
    journal: (record) => lines.push(record),
    llm: model.llm as never,
    judgeRoute: { provider: 'p', model: 'm' },
  });
  try {
    const session = fakeSession('session-416-guard');
    session.on((sess, event) => { mount.observe(sess, event); });
    await mount.sessionFor(session.id, session);
    seedWire(mount, session.id);
    stepSurface(session);

    // An in-flight boundary keeps close() open long enough for a host hook to
    // arrive mid-shutdown.
    const stepPromise = mount.runStep(session, { turn: 1, step: 2 });
    await model.started(0);
    const closePromise = mount.close();

    const other = fakeSession('session-416-late');
    await assert.rejects(mount.sessionFor(other.id, other),
      (error: unknown) => error instanceof RacoonsClosingError
        && error.name === 'RacoonsClosingError',
      'sessionFor refuses new work once close starts');
    assert.equal(mount.sessions.has(other.id), false,
      'a refused boundary never opens a session');
    await assert.rejects(mount.runStep(other, { turn: 1, step: 1 }),
      (error: unknown) => error instanceof RacoonsClosingError,
      'a pre-step arriving during close is refused, not served');
    await assert.rejects(mount.runTurnEnd(session, 1),
      (error: unknown) => error instanceof RacoonsClosingError,
      'a turn-end for a still-mapped entry is refused too');
    assert.equal(mount.sessions.size, 1,
      'the session count does not grow during close');

    // The already-running boundary still settles, then close releases.
    stepGate.open();
    const stepResult = await stepPromise;
    await closePromise;
    assert.equal(stepResult.entry.sessionId, session.id,
      'the boundary that was in flight at close was awaited, not abandoned');
    assert.equal(mount.sessions.size, 0, 'close released every session');
  } finally {
    stepGate.open();
    await mount.close();
  }
});
