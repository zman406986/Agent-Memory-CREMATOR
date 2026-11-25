/**
 * C12 (ISSUE-045): one end-to-end adapter path through every gap the
 * core-completion job closed, with the REAL engine, guard, ledger and mount —
 * only the host is fake.
 *
 * The chain, in the order it would happen in a session:
 *
 *   1. a tool result arrives and the at-rest boundary settles the transcript;
 *   2. the agent calls the additive `forget` tool: it answers `scheduled` and
 *      applies nothing while the call is open;
 *   3. the next boundary applies it as one content-only surface replacement
 *      whose receipt names a minted recall id (G1);
 *   4. the `recall` tool restores the exact bytes by that id, and the engine
 *      emits its own `recall` telemetry (G5's ledger lane);
 *   5. a later step's `assistant/message` carries the host's usage row, and the
 *      mount reconciles it against the estimate it measured at its last
 *      boundary (G8).
 *
 * Why one test and not five: each leg's own suite proves its details; what no
 * other file proves is that the five legs meet on one session, one ledger and
 * one surface. A break in any seam between them — a receipt with no archive, a
 * recall id the ledger does not hold, a usage row fed before any request was
 * measured — fails here and only here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshMountContext, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsPlugin } from '../src/plugin.js';

const BODY = 'alpha line\nbeta line\ngamma line\n';
const BAR = 8;

/**
 * The read meta proving the span returned: one entry per body line, the live
 * dsh read shape (ISSUE-051). A forget resolves only from read evidence
 * (ISSUE-327), so the chain's held result is a read, never a grep hit.
 */
const READ_META = { path: 'big.txt', offset: 1, totalLines: 3,
  lines: BODY.replace(/\n$/u, '').split('\n')
    .map((text, index) => ({ number: index + 1, text })) };

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** The host session the mount is written against: an append-only log with a surface list. */
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
        type, seq, data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined
          ? {} : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) },
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

/** One step, of the shape a dsh run produces; `usage` rides the assistant message. */
function step(session: FakeSession, params: {
  turn: number;
  step: number;
  callId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  meta?: unknown;
  usage?: Record<string, unknown>;
  assistantOnly?: boolean;
}): void {
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('user/message', {
    content: [{ type: 'text', text: `task ${String(params.turn)}` }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}`,
  }, { surfaceOp: 'append' });
  if (params.assistantOnly === true) {
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: `answer ${String(params.turn)}` }],
        id: `asst-${String(params.turn)}-${String(params.step)}` },
      ...params.usage === undefined ? {} : { usage: params.usage } },
    { surfaceOp: 'append' });
    session.append('step/end', { turn: params.turn, step: params.step });
    return;
  }
  const callId = params.callId ?? `c${String(params.turn)}`;
  const name = params.toolName ?? 'grep';
  const input = params.input ?? { pattern: 'alpha', path: 'big.txt' };
  const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
    callId, name, arguments: JSON.stringify(input) }).seq;
  session.append('assistant/message', { turn: params.turn, step: params.step,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(input) }],
      id: `asst-${callId}` } },
  { surfaceOp: 'append', ...params.usage === undefined ? {} : { usage: params.usage } });
  session.append('tool/result', { turn: params.turn, step: params.step,
    message: { role: 'tool', source: { kind: 'tool', callId },
      toolCallId: callId, content: [{ type: 'text', text: BODY }], isError: false,
      id: `result-${callId}` },
    meta: params.meta ?? { shape: 'matches', truncated: false, total: 1,
      files: [{ path: 'big.txt', matches: [{ line: 1 }] }] } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: params.turn, step: params.step });
}

interface RegisteredTool {
  readonly name: string;
  execute(args: unknown): Promise<unknown>;
  readonly output: { render(args: unknown, value: unknown): { text: string }[] };
}

/** The mount, its tool host and its boundaries, wired the way `apply` wires them. */
async function mountHost(options: {
  readonly session: FakeSession;
  readonly journal: { kind: string; [field: string]: unknown }[];
}): Promise<{
  readonly tools: Map<string, RegisteredTool>;
  boundary(turn: number): Promise<void>;
  dispose(): Promise<void>;
}> {
  const tools = new Map<string, RegisteredTool>();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: (() => unknown)[] = [];
  const plugin = createRacoonsPlugin({ journal: record => options.journal.push(record),
    storage: { databasePath: ':memory:' }, config: { barBytes: BAR } });
  await plugin.apply({
    logger: { warn: () => {} },
    tools: { register(tool: unknown) {
      const named = tool as RegisteredTool;
      tools.set(named.name, named);
      return () => { tools.delete(named.name); };
    } },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
  } as DshMountContext, {});
  options.session.on((session, event) => {
    const listener = listeners.get('session/event');
    if (listener !== undefined) (listener as (s: FakeSession, e: DshMountEvent) => void)(session, event);
  });
  const preStep = listeners.get('agent/pre-step') as
    (payload: unknown, next: () => unknown) => Promise<unknown>;
  return { tools,
    boundary: async turn => {
      await preStep({ agent: { session: options.session }, messages: [], turn, step: 1, signal: {} },
        async () => ({ kind: 'enter', messages: [] }));
    },
    dispose: async () => { for (const fn of cleanups) await fn(); } };
}

function tool(tools: ReadonlyMap<string, RegisteredTool>, name: string): RegisteredTool {
  const found = tools.get(name);
  assert.ok(found !== undefined, `${name} is registered`);
  return found;
}

function replacements(session: FakeSession): DshMountEvent[] {
  return session.log.filter(event => event.type === 'tool/result'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null);
}

/** The live host row shape: disjoint buckets, cache read separate (G8). */
const LIVE_ROW = { inputTokens: 605, outputTokens: 165, totalTokens: 8194, cacheReadTokens: 7424 };

test('forget → receipt → recall → usage reconcile runs end to end on one session', async () => {
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const session = fakeSession('session-core-completion');
  const wired = await mountHost({ session, journal });
  try {
    // 1 — a result the agent holds: one read carrying the file's three lines.
    step(session, { turn: 1, step: 1, callId: 'r1', toolName: 'read',
      input: { file_path: 'big.txt' }, meta: READ_META });
    session.append('turn/end', { turn: 1 });
    await wired.boundary(1);
    const original = session.log.find(event => event.type === 'tool/result'
      && event.surfaceOp === 'append');
    assert.ok(original !== undefined, 'the result is on the live surface');
    assert.deepEqual([...wired.tools.keys()].sort(), ['forget', 'necromancy'],
      'the mount registers both additive tools');

    // 2 — the agent forgets the whole unit. The answer is a scheduling fact:
    // nothing moves while the model's own call is still unanswered.
    const answer = await tool(wired.tools, 'forget').execute({ path: 'big.txt' });
    assert.deepEqual(answer, { status: 'scheduled', path: 'big.txt', ranges: [] });
    assert.equal(replacements(session).length, 0, 'a tool call never applies its own removal');

    // 3 — the next boundary applies it: one replacement, content only, and a
    // receipt that names a recall id the ledger minted.
    await wired.boundary(2);
    const replaced = replacements(session);
    assert.equal(replaced.length, 1, 'one forget, one surface replacement');
    assert.deepEqual(replaced[0]?.surfaceOp,
      { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    'the replacement shadows exactly the forgotten result');
    const content = (replaced[0]?.data as { message: { content: { type: string; text: string }[] } })
      .message.content;
    assert.equal(content.length, 1, 'content-only: the call pairing stays whole');
    const receipt = content[0]?.text ?? '';
    assert.match(receipt, /^\[not retained\] big\.txt · necromancy recall:sha256:[0-9a-f]{64}$/u,
      'the receipt is the floor line: path, no ranges, one recall id');
    const forgetLine = journal.filter(line => line['kind'] === 'forget');
    assert.equal(forgetLine.length, 1, 'one request, one journal line');
    assert.equal(forgetLine[0]?.['status'], 'applied');
    assert.equal(forgetLine[0]?.['path'], 'big.txt');

    // 4 — the recall id restores the exact bytes, through the engine (its own
    // `recall` telemetry is emitted) rather than a mount-side cache.
    const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(receipt)?.[1];
    assert.ok(recallId !== undefined, 'the receipt names a recall id');
    const restored = await tool(wired.tools, 'necromancy').execute({ id: recallId }) as
      Record<string, unknown>;
    assert.equal(restored['text'], BODY, 'recall returns the forgotten bytes exactly');
    assert.equal(restored['byteLength'], new TextEncoder().encode(BODY).length);
    const recalls = journal.filter(line => line['kind'] === 'telemetry')
      .map(line => line['event'] as { kind?: string; recallId?: string })
      .filter(event => event.kind === 'recall');
    assert.equal(recalls.length, 1, 'the engine recorded the recall');
    assert.equal(recalls[0]?.recallId, recallId, 'the engine recorded the id it answered');

    // 5 — a later step reports the provider's own counts. One boundary measures
    // the request first, so the row is reconciled against a real estimate.
    await wired.boundary(3);
    step(session, { turn: 3, step: 1, assistantOnly: true, usage: LIVE_ROW });
    const reconciled = journal.filter(line => line['kind'] === 'usage-reconciled');
    assert.equal(reconciled.length, 1, 'one host row, one reconciled reading');
    assert.equal(reconciled[0]?.['inputTokens'], 605 + 7424,
      'the cached bucket is inside the whole prompt the core measures');
    assert.equal(reconciled[0]?.['outputTokens'], 165);
    assert.equal(reconciled[0]?.['cachedInputTokens'], 7424, 'the cache share stays readable');
    const estimate = Number(reconciled[0]?.['estimatedInputTokens']);
    assert.ok(Number.isSafeInteger(estimate) && estimate > 0,
      'the reading names the estimate the mount measured at its boundary');
    const usageTelemetry = journal.filter(line => line['kind'] === 'telemetry')
      .map(line => line['event'] as { kind?: string; reading?: { inputTokens?: number } })
      .filter(event => event.kind === 'usage-reconciled');
    assert.equal(usageTelemetry.length, 1, 'the reconciled reading reached telemetry');
    assert.equal(usageTelemetry[0]?.reading?.inputTokens, 8029);

    // The chain left no second copy behind: one boundary more applies nothing.
    const after = replacements(session).length;
    await wired.boundary(4);
    assert.equal(replacements(session).length, after, 'no boundary replays the forget');
    assert.equal(journal.filter(line => line['kind'] === 'forget').length, 1);
  } finally {
    await wired.dispose();
  }
});

test('a refused forget stops the chain before any byte moves', async () => {
  // The other side of the same seam: a request core's lookup refuses never
  // reaches the engine, so no archive, receipt or reconcile can follow from it.
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const session = fakeSession('session-core-completion-refused');
  const wired = await mountHost({ session, journal });
  try {
    step(session, { turn: 1, step: 1, callId: 'r1', toolName: 'read',
      input: { file_path: 'big.txt' }, meta: READ_META });
    session.append('turn/end', { turn: 1 });
    await wired.boundary(1);
    const answer = await tool(wired.tools, 'forget')
      .execute({ path: 'big.txt', ranges: [{ startLine: 40, endLine: 41 }] }) as
      Record<string, unknown>;
    assert.equal(answer['status'], 'refused');
    assert.equal(answer['code'], 'unresolved-request');
    await wired.boundary(2);
    assert.equal(replacements(session).length, 0, 'nothing was applied');
    assert.equal(journal.some(line => line['kind'] === 'forget'), false,
      'a refusal is answered at the call and never journaled as an application');
  } finally {
    await wired.dispose();
  }
});
