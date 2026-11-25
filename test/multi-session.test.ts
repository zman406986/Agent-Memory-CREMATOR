/**
 * ISSUE-415: two live sessions, one mount.
 *
 * The forget/recall tools must resolve their caller from the host tool context
 * and refuse by name when no identity can be resolved; a forget in session B
 * must never queue into session A. An unnamed `agent/turn-stopping` must seal
 * every live session, never skip because more than one is open.
 *
 * Offline test: a fake Cordis context and fake dsh sessions drive the real
 * plugin and the real mount, exactly as `plugin.test.ts` does. No host, no key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshMountContext, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsPlugin } from '../src/plugin.js';

const SOURCE_BODY = 'alpha line\nbeta line\ngamma line\n';
const SOURCE_LINES = ['alpha line', 'beta line', 'gamma line'];

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** A minimal fake dsh session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session = {
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
        type,
        seq,
        data: Object.freeze(structuredClone(data)),
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

/** Append one scripted step, in the shape the mount's transcript walker reads. */
function step(session: FakeSession, params: {
  turn: number;
  step: number;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  result?: { content: unknown[]; meta?: unknown; isError?: boolean };
}): void {
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('system/message', { turn: params.turn, step: params.step,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' }, id: `sys-${String(params.turn)}-${String(params.step)}` } },
  { surfaceOp: 'append' });
  session.append('user/message', { content: [{ type: 'text', text: `task ${String(params.turn)}` }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` }, { surfaceOp: 'append' });
  if (params.toolCall !== undefined) {
    const call = params.toolCall;
    const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
      callId: call.id, name: call.name, arguments: JSON.stringify(call.input) }).seq;
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: call.id, name: call.name,
          arguments: JSON.stringify(call.input) }], id: `asst-${call.id}` } },
    { surfaceOp: 'append' });
    if (params.result !== undefined) {
      const result = params.result;
      session.append('tool/result', { turn: params.turn, step: params.step,
        message: { role: 'tool', source: { kind: 'tool', callId: call.id },
          toolCallId: call.id, content: result.content, isError: result.isError === true,
          id: `result-${call.id}` },
        ...result.meta === undefined ? {} : { meta: result.meta } },
      { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    }
  }
  session.append('step/end', { turn: params.turn, step: params.step });
}

/** A `read` result's host meta: a 1-based origin and the lines it returned. */
function readMeta(path: string, lines: readonly string[]): Record<string, unknown> {
  return { path, offset: 1, totalLines: lines.length,
    lines: lines.map((text, number) => ({ number: number + 1, text })) };
}

interface Harness {
  readonly a: FakeSession;
  readonly b: FakeSession;
  readonly tools: Map<string, { execute(args: unknown, context?: unknown): Promise<unknown> }>;
  boundary(session: FakeSession, turn: number): Promise<void>;
  turnStopping(payload: unknown): Promise<void>;
  setLive(sessions: readonly FakeSession[]): void;
  dispose(): Promise<void>;
}

/**
 * One real plugin over a fake context, two fake sessions, and a host-store
 * `list()` the test drives so "live" means exactly what the row needs.
 */
async function twoSessionHarness(): Promise<Harness> {
  const tools = new Map<string, { execute(args: unknown, context?: unknown): Promise<unknown> }>();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: (() => unknown)[] = [];
  let live: readonly FakeSession[] = [];
  const ctx = {
    logger: { warn: () => {} },
    sessions: { list: () => live },
    tools: {
      register(tool: { name: string; execute(args: unknown, context?: unknown): Promise<unknown> }) {
        tools.set(tool.name, tool);
        return () => { tools.delete(tool.name); };
      },
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
    effect: (register: () => (() => unknown) | void) => {
      const outcome = register();
      if (typeof outcome === 'function') cleanups.push(outcome);
    },
  } as unknown as DshMountContext;
  const plugin = createRacoonsPlugin({ journal: () => {},
    storage: { databasePath: ':memory:' }, config: { barBytes: 8 } });
  await plugin.apply(ctx, {});
  const a = fakeSession('session-a');
  const b = fakeSession('session-b');
  for (const session of [a, b]) {
    session.on((source, event) => {
      const listener = listeners.get('session/event');
      if (listener !== undefined) {
        (listener as (session: FakeSession, event: DshMountEvent) => void)(source, event);
      }
    });
  }
  const boundary = async (session: FakeSession, turn: number): Promise<void> => {
    const preStep = listeners.get('agent/pre-step') as
      (payload: unknown, next: () => unknown) => Promise<unknown>;
    await preStep({ agent: { session }, messages: [], turn, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages: [] }));
  };
  const turnStopping = async (payload: unknown): Promise<void> => {
    const hook = listeners.get('agent/turn-stopping') as
      (given: unknown) => Promise<void>;
    await hook(payload);
  };
  return {
    a, b, tools, boundary, turnStopping,
    setLive: (sessions) => { live = sessions; },
    dispose: async () => { for (const fn of cleanups.reverse()) await fn(); },
  };
}

/** The tool-result replacements (the shape a removal publication appends). */
function replacements(session: FakeSession): DshMountEvent[] {
  return session.log.filter((event) => event.type === 'tool/result'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null);
}

/** The one text body a publication's content blocks carry. */
function receiptText(event: DshMountEvent): string {
  const content = (event.data as
    { message?: { content?: { text?: unknown }[] } } | undefined)?.message?.content ?? [];
  return content.map((block) => typeof block.text === 'string' ? block.text : '').join('');
}

/** The sealed-episode negative facts a session received. */
function negations(session: FakeSession): number {
  return session.log.filter((event) => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind
      === 'racoons/negation').length;
}

/** A failed grep result: the episode the turn-end boundary seals. */
const MISS_META = { shape: 'matches', files: [], truncated: false, total: 0 };

test('a tool context routes forget to its own session, never into the other', async () => {
  const h = await twoSessionHarness();
  try {
    h.setLive([h.a, h.b]);
    for (const session of [h.a, h.b]) {
      step(session, { turn: 1, step: 1,
        toolCall: { id: `c-${session.id}`, name: 'read', input: { file_path: 'big.txt' } },
        result: { content: [{ type: 'text', text: SOURCE_BODY }],
          meta: readMeta('big.txt', SOURCE_LINES) } });
      await h.boundary(session, 1);
    }
    const forget = h.tools.get('forget');
    assert.ok(forget !== undefined, 'the forget tool is registered');
    // Session B forgets; the context names B.
    assert.deepEqual(await forget.execute({ path: 'big.txt' }, { session: h.b }),
      { status: 'scheduled', path: 'big.txt', ranges: [] },
      'forget answers scheduled for the calling session');
    // A's next boundary must apply nothing: B's request was not queued there.
    await h.boundary(h.a, 2);
    assert.equal(replacements(h.a).length, 0,
      'session A never applies the forget issued in session B');
    // B's boundary applies exactly its own request.
    await h.boundary(h.b, 2);
    const applied = replacements(h.b);
    assert.equal(applied.length, 1, 'session B applies its own forget');
    assert.match(receiptText(applied[0] as DshMountEvent),
      /necromancy recall:sha256:[0-9a-f]{64}/u,
      'the applied receipt names a recall id');
  } finally {
    await h.dispose();
  }
});

test('an ambiguous recall refuses by name instead of guessing a session', async () => {
  const h = await twoSessionHarness();
  try {
    h.setLive([h.a, h.b]);
    for (const session of [h.a, h.b]) {
      step(session, { turn: 1, step: 1,
        toolCall: { id: `c-${session.id}`, name: 'read', input: { file_path: 'big.txt' } },
        result: { content: [{ type: 'text', text: SOURCE_BODY }],
          meta: readMeta('big.txt', SOURCE_LINES) } });
      await h.boundary(session, 1);
    }
    const recall = h.tools.get('necromancy');
    assert.ok(recall !== undefined, 'the recall tool is registered');
    await assert.rejects(recall.execute({ id: '0'.repeat(64) }), (error: unknown) => {
      assert.ok(error instanceof Error, 'the tool rejects with an Error');
      assert.equal(error.name, 'CrematorAmbiguousSessionError',
        'the refusal is named for the ambiguous-session condition');
      assert.match(error.message, /recall refused/u, 'the message names the tool');
      assert.match(error.message, /2 live sessions/u, 'the message names the condition');
      return true;
    });
  } finally {
    await h.dispose();
  }
});

test('turn-end seals the session the payload names', async () => {
  const h = await twoSessionHarness();
  try {
    h.setLive([h.a, h.b]);
    for (const session of [h.a, h.b]) {
      step(session, { turn: 1, step: 1,
        toolCall: { id: `g-${session.id}`, name: 'grep',
          input: { pattern: 'NEEDLE', path: 'a.txt' } },
        result: { content: [{ type: 'text', text: 'no matches' }], meta: MISS_META } });
    }
    await h.turnStopping({ turn: 1, agent: { session: h.a } });
    assert.equal(negations(h.a), 1, 'the named session seals its episode');
    assert.equal(negations(h.b), 0, 'the other live session is not touched');
  } finally {
    await h.dispose();
  }
});

test('an unnamed turn-end seals every live session', async () => {
  const h = await twoSessionHarness();
  try {
    h.setLive([h.a, h.b]);
    for (const session of [h.a, h.b]) {
      step(session, { turn: 1, step: 1,
        toolCall: { id: `g-${session.id}`, name: 'grep',
          input: { pattern: 'NEEDLE', path: 'a.txt' } },
        result: { content: [{ type: 'text', text: 'no matches' }], meta: MISS_META } });
    }
    await h.turnStopping({ turn: 1 });
    assert.equal(negations(h.a), 1, 'the first live session seals its episode');
    assert.equal(negations(h.b), 1, 'the second live session seals its episode too');
  } finally {
    await h.dispose();
  }
});
