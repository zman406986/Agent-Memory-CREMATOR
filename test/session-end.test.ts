// ISSUE-377: `session/end` is lifecycle eviction of the WHOLE per-session
// state. The ended session's entry leaves the open map and its owned ledger
// closes through the same release path `close()` uses, AFTER the owed
// committed appends flush through the ISSUE-342 path — a graceful end loses
// no committed records. The durable baseline (ISSUE-336 round/latch,
// ISSUE-374 pending-append intent) stays on disk, so a reopen restores it.
// No cap, no LRU, no timeout: the host's ending is the only trigger
// (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshMountEvent, DshMountSession, RacoonsApplicationRequest,
} from '../src/plugin.js';
import {
  createRacoonsMount, resolvePluginConfig, resolveSessionStorage, resolveStorage,
} from '../src/plugin.js';
import { createMainWireCapture } from '../src/main-wire.js';
import { readPendingAppends, writePruneRound } from '../src/prune-round-store.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  /** When true, the host refuses this package's record appends (a failed flush). */
  refuseRecords: boolean;
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/**
 * A minimal fake dsh Session: an append-only log with surface markers, a
 * surface node list, `eventAt` and `seq` — the host behaviour the mount is
 * written against (the same harness `plugin.test.ts` drives).
 */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    refuseRecords: false,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const source = (data as { source?: { kind?: string } } | null)?.source;
      if (session.refuseRecords && type === 'user/message' && source?.kind === 'racoons/negation') {
        throw new Error('the host refuses this record append');
      }
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

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-session-end-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

type Line = { kind: string; [field: string]: unknown };

test('ISSUE-377: session/end drains owed appends, then releases the entry', async () => {
  const lines: Line[] = [];
  const mainWire = createMainWireCapture();
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), mainWire,
    journal: (record) => lines.push(record) });
  try {
    const ended = fakeSession('session-377-ended');
    const live = fakeSession('session-377-live');
    for (const session of [ended, live]) {
      session.on((sess, event) => { mount.observe(sess, event); });
    }
    const entry = await mount.sessionFor(ended.id, ended);
    await mount.sessionFor(live.id, live);
    // Spy on the instance's own close: the release must call it exactly once.
    let closes = 0;
    const originalClose = entry.ledger.close.bind(entry.ledger);
    entry.ledger.close = async () => { closes += 1; await originalClose(); };
    mount.observeWire({ sessionId: ended.id, messages: [
      { role: 'user', content: [{ type: 'text', text: 'main request' }] }] });
    entry.pendingAppends.push(owedAppend('rec-377-1', 'negative fact'));

    ended.append('session/end', {});
    await mount.endSession(ended);

    assert.equal(recordCount(ended, 'rec-377-1'), 1,
      'the owed append flushed to the surface BEFORE the release');
    assert.equal(mount.sessions.has(ended.id), false, 'the ended session left the open map');
    assert.equal(mount.sessions.has(live.id), true, 'the live session is unaffected');
    assert.equal(closes, 1, 'the owned ledger closed through the release path');
    assert.equal(mainWire.last(ended.id), null, 'the ended session leaves no capture');
    const evicted = lines.filter(line => line.kind === 'session-evicted');
    assert.equal(evicted.length, 1, 'the eviction is journalled once');
    assert.equal(evicted[0]?.['sessionId'], ended.id);
    assert.equal(evicted[0]?.['reason'], 'session/end');

    // Idempotent: a second end (and one for a session never opened) releases
    // nothing and closes nothing twice.
    await mount.endSession(ended);
    await mount.endSession(fakeSession('session-377-never'));
    assert.equal(closes, 1, 'no second close on an already-released session');
    assert.equal(lines.filter(line => line.kind === 'session-evicted').length, 1,
      'no second eviction line');
    assert.equal(mount.sessions.has(live.id), true, 'the survivor still stands');
  } finally {
    await mount.close();
  }
});

test('ISSUE-377: reopen after end restores the durable baseline; a drained intent is cleared', async () => {
  const root = scratch();
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage({ root }), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-377-durable');
    session.on((sess, event) => { mount.observe(sess, event); });
    const entry = await mount.sessionFor(session.id, session);
    const target = resolveSessionStorage(root, session.id);
    // The baseline a previous process left: round 2 and the latch's post-pass
    // state (ISSUE-336), plus one owed append persisted at commit (ISSUE-374).
    writePruneRound(target, 2, (kind, fields) => { lines.push({ kind, ...fields }); },
      session.id, { lastFireUsage: 1000, belowSinceFire: false, baselinePending: false });
    entry.pendingAppends.push(owedAppend('rec-377-2', 'owed record'));
    entry.persistPendingAppends?.();
    assert.equal(readPendingAppends(target).length, 1, 'the intent is durable before the end');

    session.append('session/end', {});
    await mount.endSession(session);

    assert.equal(recordCount(session, 'rec-377-2'), 1, 'the graceful end flushed the owed record');
    assert.equal(readPendingAppends(target).length, 0,
      'a full drain clears the durable intent (ISSUE-374)');
    assert.equal(mount.sessions.has(session.id), false, 'the entry released');

    // Reopen: a fresh entry over the same durable directory restores the baseline.
    const reopened = await mount.sessionFor(session.id, session);
    assert.notEqual(reopened, entry, 'the reopen built a fresh entry');
    assert.equal(reopened.pruneRounds, 2, 'the round baseline came back from the round file');
    assert.equal(reopened.pruneTrigger.snapshot().lastFireUsage, 1000,
      'the latch baseline came back (ISSUE-336)');
    assert.ok(reopened.persistPendingAppends !== undefined,
      'the durable target was restored for the reopened entry');
  } finally {
    await mount.close();
    cleanup(root);
  }
});

test('ISSUE-377: a failed flush still releases; the durable intent replays on reopen', async () => {
  const root = scratch();
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage({ root }), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-377-refused');
    session.on((sess, event) => { mount.observe(sess, event); });
    const entry = await mount.sessionFor(session.id, session);
    const target = resolveSessionStorage(root, session.id);
    // One landed tool result on the surface: its capture sits in the buffer
    // the release must clear (the reopen rebuilds it from the surface).
    const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: 'c1',
      name: 'read', arguments: '{"path":"a"}' }).seq;
    session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool',
      source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
      content: [{ type: 'text', text: 'result bytes' }], id: 'result-c1' } },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    entry.pendingAppends.push(owedAppend('rec-377-3', 'owed record'));
    entry.persistPendingAppends?.();

    session.refuseRecords = true;
    session.append('session/end', {});
    await mount.endSession(session);

    assert.equal(mount.sessions.has(session.id), false,
      'fail-open: the entry released despite the failed flush');
    assert.ok(lines.some(line => line.kind === 'append-publish-failed'),
      'the failed flush is journalled');
    assert.equal(recordCount(session, 'rec-377-3'), 0, 'the host holds no record yet');
    assert.equal(readPendingAppends(target).length, 1,
      'the durable intent survived the failed flush (ISSUE-374)');

    // Reopen at the next boundary: the ISSUE-341 recovery replays the intent
    // and re-queues the landing the released buffer lost.
    session.refuseRecords = false;
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(recordCount(session, 'rec-377-3'), 1,
      'the reopened boundary replayed the owed record');
    const recovered = lines.find(line => line.kind === 'entry-resume-recovered');
    assert.ok(recovered !== undefined, 'the replay rides the resume-recovery seam');
    assert.equal(recovered['appends'], 1, 'the recovery line counts the replayed record');
    assert.ok(Number(recovered['redelivered']) >= 1,
      'the released buffer was rebuilt from the surface');
    await mount.runStep(session, { turn: 1, step: 3 });
    assert.equal(recordCount(session, 'rec-377-3'), 1, 'the replay is idempotent');
  } finally {
    await mount.close();
    cleanup(root);
  }
});

test('ISSUE-397: session/end waits for an in-flight step boundary before releasing', async () => {
  const lines: Line[] = [];
  // The ask gate: the step's entry ask suspends inside the model seam until
  // the test opens it, so `session/end` lands while the boundary is in flight.
  let openAsk!: () => void;
  const askGate = new Promise<void>(resolve => { openAsk = resolve; });
  let askEntered!: () => void;
  const askStarted = new Promise<void>(resolve => { askEntered = resolve; });
  const llm = {
    stream(): AsyncIterable<DshLlmChunk> {
      return (async function* emit() {
        askEntered();
        await askGate;
        yield { type: 'text-delta', index: 0, text: '{"keepall":true}' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' } }),
    storage: resolveStorage(undefined),
    journal: (record) => lines.push(record),
    llm: llm as never,
    judgeRoute: { provider: 'p', model: 'm' },
  });
  try {
    const session = fakeSession('session-397-inflight');
    session.on((sess, event) => { mount.observe(sess, event); });
    const entry = await mount.sessionFor(session.id, session);
    let closes = 0;
    const originalClose = entry.ledger.close.bind(entry.ledger);
    entry.ledger.close = async () => { closes += 1; await originalClose(); };
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'm',
      system: 'MAIN SYSTEM PROMPT',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }] });
    // One scripted step whose single over-floor result is askable, plus a
    // `/cremate` request so the boundary's tail prune runs too.
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
    session.append('user/message', { content: [{ type: 'text', text: '/cremate' }],
      source: { kind: 'user' } });
    session.append('step/end', { turn: 1, step: 2 });

    // The boundary starts and suspends inside its entry ask.
    const stepPromise = mount.runStep(session, { turn: 1, step: 2 });
    await askStarted;
    // The host ends the session WHILE the ask is in flight.
    session.append('session/end', {});
    const endPromise = mount.endSession(session);
    // Only now does the ask settle; the boundary runs its tail on the entry.
    openAsk();
    let stepRejected = false;
    await stepPromise.catch(() => { stepRejected = true; });
    await endPromise;

    assert.equal(stepRejected, false,
      'the boundary completed on its own open entry, not on a closed ledger');
    assert.equal(mount.sessions.has(session.id), false,
      'the settled boundary never reopened a released entry');
    assert.equal(closes, 1, 'the owned ledger closed exactly once, after the boundary');
    assert.equal(lines.filter(line => line.kind === 'session-evicted').length, 1,
      'the eviction is journalled once');
    assert.equal(lines.some(line => line.kind === 'at-rest-error'), false,
      'no pass aborted against a closed ledger');
  } finally {
    openAsk();
    await mount.close();
  }
});