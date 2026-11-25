/**
 * ISSUE-501: an entry ask and a direct prune ask can be in flight at once
 * (ISSUE-423 already allows a compaction to land inside either one).
 *
 * The ISSUE-423 deferral is only as good as its window bookkeeping. With one
 * shared slot, whichever lane finishes first clears the window for both: the
 * deferred latch re-arm then runs while the other ask is still open, which is
 * exactly the mid-flight re-arm ISSUE-423 removed.
 *
 * The observable here is the durable round file the re-arm writes: with both
 * windows open the deferred re-arm must not touch it, and it must run once the
 * last window closes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMainWireCapture } from '../src/main-wire.js';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import {
  createRacoonsMount, resolvePluginConfig, resolveSessionStorage, resolveStorage,
} from '../src/plugin.js';
import { readPruneTriggerState, writePruneRound } from '../src/prune-round-store.js';
import type { PruneWindowTriggerState } from '@cremator/core';

const ROUTE = { provider: 'p', model: 'm' };
const KEEPALL = '{"keepall":true}';
// The depth table's reply, in the jsonl-20 line-per-row shape its ask teaches.
const FORGET_ONE = '{"1":{"forgetall":true,"summary":"an old read"}}';
const HOST_MAIN = {
  system: 'MAIN SYSTEM BYTES',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read the files' }] }],
};

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  readonly surfaceNodes: number[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes } as const; },
    get log() { return log; },
    get surfaceNodes() { return surfaceNodes; },
    requestHeader: () => ({ config: { provider: ROUTE.provider, model: ROUTE.model } }),
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error('surface replace out of range');
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options['sourceEventSeqs'];
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined ? {}
          : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) } });
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

const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });

/** One closed turn: system head, user task, assistant call, the read's result. */
function seedRead(session: FakeSession, params: {
  turn: number; callId: string; target: string; body: string;
}): void {
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: 1 });
  session.append('system/message', { turn: params.turn, step: 1, message: { role: 'system',
    content: [text('system prompt')], source: { kind: 'system-prompt' },
    id: `sys-${String(params.turn)}` } }, { surfaceOp: 'append' });
  session.append('user/message', { content: [text(`read ${params.target}`)],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` },
  { surfaceOp: 'append' });
  const callSeq = session.append('tool/call', { turn: params.turn, step: 1,
    callId: params.callId, name: 'read',
    arguments: JSON.stringify({ file_path: params.target }) }).seq;
  session.append('assistant/message', { turn: params.turn, step: 1, message: {
    role: 'assistant', source: { kind: 'model', provider: ROUTE.provider, model: ROUTE.model },
    content: [text('reading'), { type: 'tool-call', id: params.callId, name: 'read',
      arguments: JSON.stringify({ file_path: params.target }) }],
    id: `asst-${params.callId}` } }, { surfaceOp: 'append' });
  session.append('tool/result', { turn: params.turn, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId: params.callId }, toolCallId: params.callId,
    content: [text(params.body)], isError: false, id: `result-${params.callId}` } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: params.turn, step: 1 });
  session.append('turn/end', { turn: params.turn });
}

function oversizedBody(tag: string): string {
  return `${Array.from({ length: 640 }, (_, index) =>
    `${tag}-${String(index + 1)} ${'x'.repeat(63)}`).join('\n')}\n`;
}

interface Gate {
  readonly opened: Promise<void>;
  readonly answered: Promise<string>;
  open(): void;
  answer(text: string): void;
}

/** A model seam where every call parks until the test answers that call. */
function gatedLlm(): {
  readonly calls: DshLlmStreamOptions[];
  opened(index: number): Promise<void>;
  release(index: number, answer: string): void;
  releaseAll(answer: string): void;
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
} {
  const calls: DshLlmStreamOptions[] = [];
  const gates: Gate[] = [];
  const arrivals = new Map<number, () => void>();
  let defaultAnswer: string | null = null;
  return {
    calls,
    async opened(index) {
      while (gates[index] === undefined) {
        await new Promise<void>(resolve => { arrivals.set(index, resolve); });
      }
      await gates[index]?.opened;
    },
    release(index, answer) {
      gates[index]?.answer(answer);
    },
    releaseAll(answer) {
      defaultAnswer = answer;
      for (const gate of gates) gate.answer(answer);
    },
    stream(options) {
      const index = calls.length;
      calls.push(options);
      let open: () => void = () => {};
      let answer: (value: string) => void = () => {};
      const opened = new Promise<void>(resolve => { open = resolve; });
      const answered = new Promise<string>(resolve => { answer = resolve; });
      gates.push({ opened, answered, open, answer });
      if (defaultAnswer !== null) answer(defaultAnswer);
      arrivals.get(index)?.();
      arrivals.delete(index);
      return (async function* emit() {
        gates[index]?.open();
        const reply = await (gates[index]?.answered ?? Promise.resolve(''));
        yield { type: 'text-delta', index: 0, text: reply.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: reply.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

type JournalLine = { kind: string; [field: string]: unknown };

const kinds = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-overlap-501-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

test('ISSUE-501: an entry ask overlapping a prune ask keeps the deferred re-arm '
  + 'until both windows close', async () => {
  const root = scratch();
  const session = fakeSession('s-overlap-501');
  const journal: JournalLine[] = [];
  const mainWire = createMainWireCapture();
  mainWire.note({ sessionId: session.id, ...HOST_MAIN });
  const llm = gatedLlm();
  const target = resolveSessionStorage(root, session.id);
  // A latch with a pending post-pass baseline: the re-arm this test watches is
  // observable in the round file only while the baseline is still pending.
  const latched: PruneWindowTriggerState = { lastFireUsage: 5, belowSinceFire: true,
    baselinePending: true };
  writePruneRound(target, 1, () => {}, session.id, latched);
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 64, barBytes: 64,
      contextWindowTokens: 200_000, pruneThresholdTokens: 1_000_000,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option',
      nativeCompactionBackstop: true }),
    storage: resolveStorage({ root }),
    journal: record => { journal.push(record as unknown as JournalLine); },
    mainWire,
    llm: llm as never,
    judgeRoute: ROUTE,
  });
  session.on((live, event) => mount.observe(live, event));
  try {
    mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
      model: ROUTE.model, ...HOST_MAIN });
    const entry = await mount.sessionFor(session.id, session);
    assert.deepEqual(entry.pruneTrigger.snapshot(), latched,
      'the primed latch is restored before the overlap');

    seedRead(session, { turn: 1, callId: 'c1', target: 'big.txt',
      body: oversizedBody('OVERLAP') });
    // The entry ask opens first and parks on the model seam.
    const entryPending = mount.runStep(session, { turn: 1, step: 2 });
    entryPending.catch(() => {});
    await llm.opened(0);
    // A direct prune starts while the entry ask is still open, and parks too.
    const prunePending = mount.runPrune(session);
    prunePending.catch(() => {});
    await llm.opened(1);

    // The host compacts while BOTH ask/apply windows are open.
    session.append('compaction/start', { turn: 1 });
    session.append('compaction/end', { turn: 1 });
    const deferred = kinds(journal, 'native-compaction-deferred');
    assert.equal(deferred.length, 2, 'both phases deferred their latch re-arm');
    for (const line of deferred) {
      assert.equal(line['window'], 'entry+prune',
        'the journal names every open window, not the last one to be set');
    }
    for (const line of kinds(journal, 'native-compaction')) {
      assert.equal(line['rearmed'], false, 'no re-arm was taken mid-window');
    }

    // The ENTRY lane finishes first: its window closes, the prune's is open.
    llm.release(0, KEEPALL);
    await entryPending;
    assert.deepEqual(readPruneTriggerState(target), latched,
      'the deferred re-arm waits while the prune window is still open');

    // The prune lane finishes last and its close takes the owed re-arm.
    llm.release(1, FORGET_ONE);
    await prunePending;
    assert.equal(entry.compactionRearmDeferred, false,
      'the last window closed and the deferred re-arm was taken');
    assert.deepEqual(readPruneTriggerState(target),
      { lastFireUsage: null, belowSinceFire: false, baselinePending: false },
      'the re-armed latch dropped the stale baseline');
  } finally {
    llm.releaseAll('{"1":{"keepall":true}}');
    await mount.close();
    cleanup(root);
  }
});

test('ISSUE-501: a prune ask ending first does not re-arm under the open entry ask',
  async () => {
    const session = fakeSession('s-overlap-501-reverse');
    const journal: JournalLine[] = [];
    const mainWire = createMainWireCapture();
    mainWire.note({ sessionId: session.id, ...HOST_MAIN });
    const llm = gatedLlm();
    const mount = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 64, barBytes: 64,
        contextWindowTokens: 200_000, pruneThresholdTokens: 1_000_000,
        entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option',
        nativeCompactionBackstop: true }),
      storage: resolveStorage(undefined),
      journal: record => { journal.push(record as unknown as JournalLine); },
      mainWire,
      llm: llm as never,
      judgeRoute: ROUTE,
    });
    session.on((live, event) => mount.observe(live, event));
    try {
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const entry = await mount.sessionFor(session.id, session);
      entry.pruneTrigger.restore({ lastFireUsage: 5, belowSinceFire: true,
        baselinePending: true });
      seedRead(session, { turn: 1, callId: 'c1', target: 'big.txt',
        body: oversizedBody('REVERSE') });
      const entryPending = mount.runStep(session, { turn: 1, step: 2 });
      entryPending.catch(() => {});
      await llm.opened(0);
      const prunePending = mount.runPrune(session);
      prunePending.catch(() => {});
      await llm.opened(1);

      session.append('compaction/end', { turn: 1 });
      llm.release(1, FORGET_ONE);
      await prunePending;
      assert.equal(entry.pruneTrigger.snapshot().baselinePending, true,
        'the prune pass left its baseline pending; the entry window keeps the re-arm owed');
      assert.equal(entry.compactionRearmDeferred, true,
        'the deferred re-arm is still owed to the entry window');

      llm.release(0, KEEPALL);
      await entryPending;
      assert.equal(entry.compactionRearmDeferred, false,
        'the last open window took the owed re-arm');
    } finally {
      llm.releaseAll('{"1":{"keepall":true}}');
      await mount.close();
    }
  });