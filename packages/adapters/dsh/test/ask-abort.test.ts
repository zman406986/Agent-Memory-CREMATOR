/**
 * ISSUE-405: the dsh ask deadline and the host pre-step abort signal.
 *
 * Both asks now read the configured `judgeTimeoutMs` (0 = deadline off) and the
 * host's own pre-step `signal`, so a cancelled turn preempts the stream instead
 * of parking it for the 120 s default deadline. Each case asserts the ask
 * settled as a typed refusal, the card closed, and the run finished promptly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

const ROUTE = { provider: 'p', model: 'm' };

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  return {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes }; },
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
        if (start < 0 || end < 0) throw new Error('surface replace out of range');
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp } });
      log.push(event);
      return event;
    },
  };
}

/** A stream that never produces a chunk: only the deadline or the signal ends it. */
function stalledLlm(): { readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk> } {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* stall(): AsyncGenerator<DshLlmChunk> {
        await new Promise(() => {});
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;

function landResult(session: FakeSession): void {
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' }, id: 'sys-1' } }, { surfaceOp: 'append' });
  session.append('user/message', { content: [{ type: 'text', text: 'read big.txt' }],
    source: { kind: 'user' }, role: 'user', id: 'user-1' }, { surfaceOp: 'append' });
  const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: 'c1',
    name: 'read', arguments: JSON.stringify({ file_path: 'big.txt' }) }).seq;
  session.append('assistant/message', { turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'c1', name: 'read',
        arguments: JSON.stringify({ file_path: 'big.txt' }) }], id: 'asst-c1' } },
  { surfaceOp: 'append' });
  session.append('tool/result', { turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
      content: [{ type: 'text', text: BODY }], isError: false, id: 'result-c1' } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: 1, step: 1 });
}

const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }] },
  ],
};

interface JournalLine { readonly kind: string; readonly [field: string]: unknown }

function mountWith(config: Parameters<typeof resolvePluginConfig>[0],
  llm: ReturnType<typeof stalledLlm>, journal: JournalLine[]) {
  return createRacoonsMount({
    config: resolvePluginConfig(config),
    storage: resolveStorage(undefined),
    journal: (record: JournalLine) => journal.push(record),
    llm: llm as never,
    judgeRoute: ROUTE,
  });
}

function cardKind(session: FakeSession): unknown {
  const done = session.log.filter(event => event.type === 'command/done');
  return done.length === 1 ? (done[0]?.data as { kind?: unknown }).kind : null;
}

test('ISSUE-405: the configured judge deadline reaches the entry ask', { timeout: 5_000 },
  async () => {
    const session = fakeSession('s-entry-deadline');
    const journal: JournalLine[] = [];
    const llm = stalledLlm();
    const mount = mountWith({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option',
      judgeTimeoutMs: 40 }, llm, journal);
    try {
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      landResult(session);
      await mount.runStep(session, { turn: 1, step: 2 });
      assert.equal(llm.calls.length, 1, 'one entry ask left the seam');
      const refused = journal.filter(line => line.kind === 'entry-ask-refused');
      assert.equal(refused.length, 1, 'the stalled ask is a typed refusal');
      assert.equal(refused[0]?.['code'], 'timeout', 'the configured deadline fired');
      assert.equal(cardKind(session), 'error', 'the card settled');
    } finally {
      await mount.close();
    }
  });

test('ISSUE-405: the host pre-step signal aborts the entry ask promptly', { timeout: 5_000 },
  async () => {
    const session = fakeSession('s-entry-abort');
    const journal: JournalLine[] = [];
    const llm = stalledLlm();
    // 0 is the documented deadline-off switch: only the host signal can end it.
    const mount = mountWith({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option',
      judgeTimeoutMs: 0 }, llm, journal);
    const controller = new AbortController();
    try {
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      landResult(session);
      const started = Date.now();
      const running = mount.runStep(session, { turn: 1, step: 2 }, controller.signal);
      setTimeout(() => { controller.abort(); }, 20);
      await running;
      assert.ok(Date.now() - started < 2_000, 'the ask did not wait out a deadline');
      const refused = journal.filter(line => line.kind === 'entry-ask-refused');
      assert.equal(refused.length, 1, 'the aborted ask is a typed refusal');
      assert.equal(refused[0]?.['reason'], 'aborted', 'the refusal names the abort');
      assert.equal(cardKind(session), 'error', 'the card settled');
    } finally {
      await mount.close();
    }
  });

test('ISSUE-405: the host pre-step signal aborts the prune ask promptly', { timeout: 5_000 },
  async () => {
    const session = fakeSession('s-prune-abort');
    const journal: JournalLine[] = [];
    const llm = stalledLlm();
    const mount = mountWith({ barBytes: 64, capBytes: 1 << 20,
      episodeNoNewPathSteps: null, entryAskTrigger: { mode: 'off' },
      judgeTimeoutMs: 0 }, llm, journal);
    const controller = new AbortController();
    try {
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      landResult(session);
      for (const event of session.log) mount.observe(session, event);
      session.append('user/message', { content: [{ type: 'text', text: '/cremate' }],
        source: { kind: 'user' }, role: 'user', id: 'user-cremate' });
      for (const event of session.log) mount.observe(session, event);
      const started = Date.now();
      const running = mount.runStep(session, { turn: 1, step: 2 }, controller.signal);
      setTimeout(() => { controller.abort(); }, 20);
      await running;
      assert.ok(Date.now() - started < 2_000, 'the ask did not wait out a deadline');
      const skip = journal.filter(line => line.kind === 'prune-skip');
      assert.equal(skip.length, 1, 'the aborted prune send is journaled');
      assert.equal(skip[0]?.['reason'], 'aborted', 'the line names the abort');
      assert.equal(cardKind(session), 'error', 'the card settled');
    } finally {
      await mount.close();
    }
  });
