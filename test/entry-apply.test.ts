/**
 * ISSUE-502: the shipped entry flow applies through the port's own
 * rewind-and-append host write (ISSUE-058 / ADR-0022 §12). The port never
 * stages an entry candidate and never calls its publish callback for one, so a
 * post-commit entry-publish queue cannot receive a live payload.
 *
 * This drives the REAL engine, adapter and port through one answered entry ask
 * and pins both halves of the ruling: the replacement lands inside the step
 * (synchronous, receipt-protected), and the dead queue — its method field, its
 * entryApplications outcome, its per-entry state and its journal kinds — is
 * not kept around as a mechanism that never fires.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMainWireCapture } from '../src/main-wire.js';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

const ROUTE = { provider: 'p', model: 'm' };
const FORGET_ALL = '{"forgetall":"stale run notes"}';
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

function fakeLlm(answer: string): {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
} {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
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

test('ISSUE-502: the live entry apply owns its host write and the dead publish queue is gone',
  async () => {
    const session = fakeSession('session-502-live');
    const journal: JournalLine[] = [];
    const mainWire = createMainWireCapture();
    mainWire.note({ sessionId: session.id, ...HOST_MAIN });
    const llm = fakeLlm(FORGET_ALL);
    const mount = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
        contextWindowTokens: 200_000, entryAskTrigger: { mode: 'count' },
        entryAskGrammar: '3option' }),
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
      seedRead(session, { turn: 1, callId: 'c1', target: 'big.txt',
        body: oversizedBody('LIVE') });
      const outcome = await mount.runStep(session, { turn: 1, step: 2 });

      // The shipped flow: one ask, one synchronous replacement inside the step.
      assert.equal(llm.calls.length, 1, 'one entry ask left the seam');
      const applied = kinds(journal, 'entry-apply');
      assert.equal(applied.length, 1, 'the port recorded the apply receipt');
      assert.equal(applied[0]?.['status'], 'landed', 'a forget lands its shaped turn');
      assert.equal(applied[0]?.['appends'], 2, 'the rewind and the shaped turn are two appends');
      const landed = resultText(session, 'c1');
      assert.ok(landed !== null, 'the shaped turn is on the surface');
      assert.ok(landed.startsWith('stale run notes\n\n'),
        'the answer summary rides above the shaped bytes');
      assert.match(landed,
        /\[racoons\] kept 0 of 640 lines · necromancy recall:sha256:[0-9a-f]{64}/u,
        'the receipt names the kept count and the recall id');

      // The dead queue is removed, not kept as a mechanism that never fires.
      const api: Record<string, unknown> = mount as unknown as Record<string, unknown>;
      assert.equal('publishEntryApplications' in api, false,
        'the unreachable entry-publish queue method is removed');
      assert.equal('entryApplications' in outcome, false,
        'a step outcome no longer carries an entry-publish queue');
      const entryState: Record<string, unknown> = outcome.entry as unknown as Record<string, unknown>;
      assert.equal('pendingEntryPublishes' in entryState, false,
        'the per-entry queue is removed');
      assert.equal('persistPendingEntryPublishes' in entryState, false,
        'the durable queue intent is removed');
      assert.deepEqual(journal.filter(line => line.kind.startsWith('entry-publish-')), [],
        'the removed queue writes no journal kind');
    } finally {
      await mount.close();
    }
  });
