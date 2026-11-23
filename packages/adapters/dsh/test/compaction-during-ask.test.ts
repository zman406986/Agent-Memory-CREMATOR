/**
 * Compaction during an in-flight ask (ISSUE-423).
 *
 * The host can compact while an ask is waiting on the model. Two things must
 * hold, and each is tested where it can fail:
 *
 *   1. the entry ask is stamped with the compaction generation it was built
 *      under. A compaction that lands during the ask does not append a second
 *      ask/answer turn pair, does not apply, and refuses by name
 *      (`compaction-generation-changed`) — the result keeps every byte, so no
 *      orphan ask turns are left in the model's view; and
 *   2. the depth latch is not re-armed mid-flight. The observation inside the
 *      open ask/apply window is deferred (`native-compaction-deferred`), so no
 *      second above-bar ask is armed from inside the first one's apply. The
 *      bulk lane applies the same rule and refuses its pass by name.
 *
 * dsh emits `compaction/end`; `compaction/start` is read too when present, so
 * an ask learns as early as possible that its array is gone. That the host
 * emits either during a pending ask is a host fact this repo cannot confirm.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMainWireCapture } from '../src/main-wire.js';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

const ROUTE = { provider: 'p', model: 'm' };
const KEEPALL = '{"keepall":true}';
const FORGET_ONE = '{"1":{"forgetall":"an old read"}}';
const HOST_MAIN = {
  system: 'MAIN SYSTEM BYTES',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read the files' }] }],
};

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  readonly surfaceNodes: number[];
  /** One external surface replacement, without a compaction event (ISSUE-548). */
  bumpSurface(): void;
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

function fakeSession(id: string, counters = true): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  let replaceGeneration = 0;
  let contentGeneration = 0;
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    get seq() { return log.length; },
    get surface() {
      return counters
        ? { nodes: surfaceNodes, replaceGeneration, contentGeneration } as const
        : { nodes: surfaceNodes } as const;
    },
    get log() { return log; },
    get surfaceNodes() { return surfaceNodes; },
    bumpSurface() { replaceGeneration += 1; contentGeneration += 1; },
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
function seedRead(session: ReturnType<typeof fakeSession>, params: {
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

/** A model seam that parks in the middle of the reply until the test releases it. */
function gatedLlm(answer: string): {
  readonly calls: DshLlmStreamOptions[];
  readonly opened: Promise<void>;
  release(): void;
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
} {
  const calls: DshLlmStreamOptions[] = [];
  let open: () => void = () => {};
  let release: () => void = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {
    calls,
    opened,
    release: () => { release(); },
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        open();
        await gate;
        yield { type: 'text-delta', index: 0, text: answer.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: answer.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

type JournalLine = { kind: string; [field: string]: unknown };
const kinds = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

function resultText(session: FakeSession, callId: string): string | null {
  for (const seq of [...session.surfaceNodes].reverse()) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    const data = event.data as { message?: { toolCallId?: string;
      content?: readonly { text?: string }[] } };
    if (data.message?.toolCallId !== callId) continue;
    return data.message.content?.map(block => block.text ?? '').join('') ?? null;
  }
  return null;
}

function harness(params: { readonly id: string; readonly answer: string;
  readonly gated: boolean; readonly counters?: boolean }) {
  const session = fakeSession(params.id, params.counters ?? true);
  const journal: JournalLine[] = [];
  const mainWire = createMainWireCapture();
  mainWire.note({ sessionId: session.id, ...HOST_MAIN });
  const llm = params.gated ? gatedLlm(params.answer) : undefined;
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 64, barBytes: 64,
      contextWindowTokens: 200_000, pruneThresholdTokens: 1_000_000,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined),
    journal: record => { journal.push(record as unknown as JournalLine); },
    mainWire,
    ...(llm === undefined ? {} : { llm: llm as never }),
    judgeRoute: ROUTE,
  });
  session.on((live, event) => mount.observe(live, event));
  return { session, journal, llm, mount };
}

test('ISSUE-423: a compaction during the entry ask refuses the apply and leaves no ask turns',
  async () => {
    const h = harness({ id: 's-compaction-entry', answer: KEEPALL, gated: true });
    const llm = h.llm;
    assert.ok(llm !== undefined);
    try {
      h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const body = oversizedBody('ENTRY');
      seedRead(h.session, { turn: 1, callId: 'c1', target: 'big.txt', body });
      const nodesBefore = h.session.surfaceNodes.length;

      const pending = h.mount.runStep(h.session, { turn: 1, step: 2 });
      await llm.opened;
      // The host compacts while the ask waits on the model.
      h.session.append('compaction/start', { turn: 1 });
      h.session.append('compaction/end', { turn: 1 });
      llm.release();
      const outcome = await pending;

      assert.equal(outcome.deliveries.length, 1, 'the result was delivered once');
      assert.equal(llm.calls.length, 1, 'exactly one ask left the seam');
      const refused = kinds(h.journal, 'entry-ask-refused');
      assert.equal(refused.length, 1, 'the answer was refused, not applied');
      assert.equal(refused[0]?.['code'], 'compaction-generation-changed',
        'the refusal names the generation that changed under it');
      assert.equal(refused[0]?.['askGeneration'], 0, 'the ask was stamped generation 0');
      assert.equal(refused[0]?.['compactionGeneration'], 2,
        'start and end each bumped the generation');
      assert.equal(kinds(h.journal, 'entry-ask').length, 0, 'no exchange was recorded');
      assert.equal(kinds(h.journal, 'entry-apply').length, 0, 'no receipt was recorded');
      assert.equal(h.session.surfaceNodes.length, nodesBefore,
        'no ask/answer turn pair was appended after the compaction');
      assert.equal(resultText(h.session, 'c1'), body, 'the result keeps every byte');
    } finally {
      await h.mount.close();
    }
  });

test('ISSUE-423: a compaction inside the prune window defers the latch and refuses the pass',
  async () => {
    const h = harness({ id: 's-compaction-prune', answer: FORGET_ONE, gated: true });
    const llm = h.llm;
    assert.ok(llm !== undefined);
    try {
      h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const bodies = ['PRUNE-ONE', 'PRUNE-TWO', 'PRUNE-THREE']
        .map(tag => oversizedBody(tag));
      seedRead(h.session, { turn: 1, callId: 'c1', target: 'one.txt', body: bodies[0] ?? '' });
      seedRead(h.session, { turn: 2, callId: 'c2', target: 'two.txt', body: bodies[1] ?? '' });
      seedRead(h.session, { turn: 3, callId: 'c3', target: 'three.txt', body: bodies[2] ?? '' });

      const pending = h.mount.runPrune(h.session);
      await llm.opened;
      h.session.append('compaction/start', { turn: 3 });
      h.session.append('compaction/end', { turn: 3 });
      llm.release();
      const outcome = await pending;

      assert.equal(outcome, null, 'the pass did not settle into an application');
      assert.ok(llm.calls.length >= 1, 'the pass sent its ask');
      assert.ok((kinds(h.journal, 'prune-plan')[0]?.['units'] as number) > 0,
        'the pass planned units before the compaction');
      assert.equal(kinds(h.journal, 'prune-apply').length, 0,
        'no receipt was recorded for the pre-ask array');
      const off = kinds(h.journal, 'prune-off');
      assert.equal(off.some(line => line['reason'] === 'compaction-generation-changed'), true,
        'the refused pass is named');
      const deferred = kinds(h.journal, 'native-compaction-deferred');
      assert.equal(deferred.length, 2, 'both phases deferred their latch re-arm');
      assert.equal(deferred[0]?.['window'], 'prune', 'the open window was the pass');
      const compaction = kinds(h.journal, 'native-compaction');
      assert.equal(compaction.at(-1)?.['rearmed'], false,
        'the latch was not re-armed mid-pass');
      for (const [index, callId] of ['c1', 'c2', 'c3'].entries()) {
        assert.equal(resultText(h.session, callId), bodies[index],
          'every result keeps its bytes');
      }
    } finally {
      await h.mount.close();
    }
  });

test('ISSUE-548: a surface replacement without a compaction event refuses the entry apply',
  async () => {
    const h = harness({ id: 's-surface-entry', answer: KEEPALL, gated: true });
    const llm = h.llm;
    assert.ok(llm !== undefined);
    try {
      h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const body = oversizedBody('SURFACE-ENTRY');
      seedRead(h.session, { turn: 1, callId: 'c1', target: 'big.txt', body });
      const nodesBefore = h.session.surfaceNodes.length;

      const pending = h.mount.runStep(h.session, { turn: 1, step: 2 });
      await llm.opened;
      // Another plugin replaced a node; no compaction/start|end was emitted.
      h.session.bumpSurface();
      llm.release();
      const outcome = await pending;

      assert.equal(outcome.deliveries.length, 1, 'the result was delivered once');
      assert.equal(llm.calls.length, 1, 'the ask still left the seam');
      const refused = kinds(h.journal, 'entry-ask-refused');
      assert.equal(refused.length, 1, 'the answer was refused, not applied');
      assert.equal(refused[0]?.['code'], 'surface-generation-changed',
        'the refusal names the surface counter that moved');
      assert.equal(refused[0]?.['askReplaceGeneration'], 0, 'the ask saw generation 0');
      assert.equal(refused[0]?.['replaceGeneration'], 1, 'one replacement landed under it');
      assert.equal(refused[0]?.['askContentGeneration'], 0, 'the ask saw content generation 0');
      assert.equal(refused[0]?.['contentGeneration'], 1, 'the content counter moved too');
      assert.equal(kinds(h.journal, 'entry-ask').length, 0, 'no exchange was recorded');
      assert.equal(kinds(h.journal, 'entry-apply').length, 0, 'no receipt was recorded');
      assert.equal(h.session.surfaceNodes.length, nodesBefore,
        'no ask/answer turn pair was appended after the replacement');
      assert.equal(resultText(h.session, 'c1'), body, 'the result keeps every byte');
    } finally {
      await h.mount.close();
    }
  });

test('ISSUE-548: a surface replacement without a compaction event refuses the prune pass',
  async () => {
    const h = harness({ id: 's-surface-prune', answer: FORGET_ONE, gated: true });
    const llm = h.llm;
    assert.ok(llm !== undefined);
    try {
      h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const bodies = ['SURFACE-ONE', 'SURFACE-TWO', 'SURFACE-THREE']
        .map(tag => oversizedBody(tag));
      seedRead(h.session, { turn: 1, callId: 'c1', target: 'one.txt', body: bodies[0] ?? '' });
      seedRead(h.session, { turn: 2, callId: 'c2', target: 'two.txt', body: bodies[1] ?? '' });
      seedRead(h.session, { turn: 3, callId: 'c3', target: 'three.txt', body: bodies[2] ?? '' });

      const pending = h.mount.runPrune(h.session);
      await llm.opened;
      h.session.bumpSurface();
      llm.release();
      const outcome = await pending;

      assert.equal(outcome, null, 'the pass did not settle into an application');
      assert.equal(kinds(h.journal, 'prune-apply').length, 0,
        'no receipt was recorded for the pre-ask array');
      const off = kinds(h.journal, 'prune-off')
        .find(line => line['reason'] === 'surface-generation-changed');
      assert.ok(off !== undefined, 'the refused pass is named by its surface counter');
      assert.equal(off['askReplaceGeneration'], 0);
      assert.equal(off['replaceGeneration'], 1);
      assert.equal(off['askContentGeneration'], 0);
      assert.equal(off['contentGeneration'], 1);
      for (const [index, callId] of ['c1', 'c2', 'c3'].entries()) {
        assert.equal(resultText(h.session, callId), bodies[index],
          'every result keeps its bytes');
      }
    } finally {
      await h.mount.close();
    }
  });

test('ISSUE-548: a host without surface counters keeps the compaction check only',
  async () => {
    const h = harness({ id: 's-no-surface-counters', answer: KEEPALL, gated: true,
      counters: false });
    const llm = h.llm;
    assert.ok(llm !== undefined);
    try {
      h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...HOST_MAIN });
      const body = oversizedBody('NO-COUNTERS');
      seedRead(h.session, { turn: 1, callId: 'c1', target: 'big.txt', body });

      const pending = h.mount.runStep(h.session, { turn: 1, step: 2 });
      await llm.opened;
      llm.release();
      const outcome = await pending;

      assert.equal(outcome.deliveries.length, 1);
      assert.equal(kinds(h.journal, 'entry-ask').length, 1,
        'the answered ask is recorded normally');
      assert.equal(kinds(h.journal, 'entry-ask-refused').length, 0,
        'no counter means no surface refusal');
      assert.equal(resultText(h.session, 'c1'), body, 'a keep keeps every byte');
    } finally {
      await h.mount.close();
    }
  });
