/**
 * The ask turn's native status card (ISSUE-372; ADR-0062 D1).
 *
 * Both dsh asks — the entry checkpoint's and the bulk prune's — ride the host's
 * own command lifecycle: `command/run {commandId, name}` before the ask and a
 * finally-guaranteed `command/done {commandId, kind, text}` after it, on the
 * answered, refused and provider-error paths alike. The pair is log-only: no
 * surface op, never a model-surface node. The harness is the same fake session
 * and fake model seam `mount-entry.test.ts` and `prune.test.ts` drive.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

const ROUTE = { provider: 'p', model: 'm' };
const CARD_NAME = 'Cremating memory trash';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  /** Throw once on the next `seq` getter read, then forget: a failed apply. */
  throwSeqOnce: boolean;
  /** Throw on every `surface` read once armed: a torn-down host session. */
  throwSurface: boolean;
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** The append-only fake host session the other mount tests drive, in miniature. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    throwSeqOnce: false,
    throwSurface: false,
    get seq() {
      if (session.throwSeqOnce) {
        session.throwSeqOnce = false;
        throw new Error('seq read failed');
      }
      return log.length;
    },
    get surface() {
      if (session.throwSurface) throw new Error('surface read failed');
      return { nodes: surfaceNodes, contentGeneration: log.length };
    },
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
      const event: DshMountEvent = Object.freeze({
        type, seq, data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
      });
      log.push(event);
      for (const listener of listeners) listener(session, event);
      return event;
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return session;
}

/** One reply split into two deltas and a finish, as the other harnesses serve it. */
function answerChunks(text: string): DshLlmChunk[] {
  return [
    { type: 'text-delta', index: 0, text: text.slice(0, 5) },
    { type: 'text-delta', index: 0, text: text.slice(5) },
    { type: 'finish', reason: 'stop' },
  ];
}

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A fake model seam; `onCall` sees the session log as it stands at each send. */
function fakeLlm(chunks: readonly DshLlmChunk[], onCall?: () => void): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      onCall?.();
      return (async function* emit() { for (const chunk of chunks) yield chunk; })();
    },
  };
}

/** A stream that dies before any text: the provider-error path. */
function deadStreamLlm(): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* boom(): AsyncGenerator<DshLlmChunk> {
        throw new Error('socket reset');
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/** One scripted step landing one oversized read result. */
function landResult(session: FakeSession, body: string): void {
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
      content: [{ type: 'text', text: body }], isError: false, id: 'result-c1' } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: 1, step: 1 });
}

/** Main's last dispatched request, ending at the landed result's own turn. */
const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }] },
  ],
};

/** A 40-line body with unique markers: over the entry floor, quotable rows. */
const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;

/** The lifecycle pair one ask wrote, paired by commandId. */
function cardPair(session: FakeSession): { run: DshMountEvent; done: DshMountEvent } {
  const runs = session.log.filter(event => event.type === 'command/run');
  const dones = session.log.filter(event => event.type === 'command/done');
  assert.equal(runs.length, 1, 'exactly one command/run');
  assert.equal(dones.length, 1, 'exactly one command/done');
  const run = runs[0] as DshMountEvent, done = dones[0] as DshMountEvent;
  const runData = run.data as { commandId?: string; name?: string };
  const doneData = done.data as { commandId?: string; kind?: string; text?: string };
  assert.equal(runData.name, CARD_NAME, 'the card carries the custom title');
  assert.equal(typeof runData.commandId, 'string', 'the run mints a pairing id');
  assert.equal(doneData.commandId, runData.commandId, 'done pairs by commandId');
  assert.ok(doneData.kind === 'success' || doneData.kind === 'error', 'done names a kind');
  assert.equal(typeof doneData.text, 'string', 'done carries a text');
  return { run, done };
}

/** The pair never touches the model surface: no surface op, no surface node. */
function assertLogOnly(session: FakeSession, pair: { run: DshMountEvent; done: DshMountEvent }): void {
  for (const event of [pair.run, pair.done]) {
    assert.equal(event.surfaceOp, undefined, `${event.type} carries no surface op`);
    assert.equal((session.surface?.nodes ?? []).includes(event.seq), false,
      `${event.type} is not a surface node`);
  }
}

test('the entry ask rides a log-only command card, run before the send and done after',
  async () => {
    const session = fakeSession('session-card-entry');
    const atSend: string[][] = [];
    const llm = fakeLlm(answerChunks('{"keepall":true}'),
      () => { atSend.push(session.log.map(event => event.type)); });
    const mount = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
        entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
      storage: resolveStorage(undefined), journal: () => {},
      llm: llm as never, judgeRoute: ROUTE,
    });
    try {
      session.on((live, event) => { mount.observe(live, event); });
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      landResult(session, BODY);
      await mount.runStep(session, { turn: 1, step: 2 });
      assert.equal(llm.calls.length, 1, 'one ask left the seam');
      const seen = atSend[0] ?? [];
      assert.equal(seen[seen.length - 1], 'command/run',
        'the card opened before the send');
      assert.equal(seen.includes('command/done'), false, 'the card had not closed at send');
      const pair = cardPair(session);
      assert.equal((pair.done.data as { kind: string }).kind, 'success',
        'an answered ask settles success');
      assert.ok(pair.run.seq < pair.done.seq, 'run precedes done');
      assertLogOnly(session, pair);
    } finally {
      await mount.close();
    }
  });

test('the entry card closes on the refusal and provider-error paths too', async () => {
  const scenarios = [
    { name: 'provider error', id: 'session-card-dead', llm: deadStreamLlm() },
    { name: 'unreadable answer', id: 'session-card-refused',
      llm: fakeLlm(answerChunks('not a json answer')) },
  ];
  for (const scenario of scenarios) {
    const session = fakeSession(scenario.id);
    const mount = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
        entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
      storage: resolveStorage(undefined), journal: () => {},
      llm: scenario.llm as never, judgeRoute: ROUTE,
    });
    try {
      session.on((live, event) => { mount.observe(live, event); });
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      landResult(session, BODY);
      await mount.runStep(session, { turn: 1, step: 2 });
      const pair = cardPair(session);
      assert.equal((pair.done.data as { kind: string }).kind, 'error',
        `${scenario.name}: the card settles error`);
      assertLogOnly(session, pair);
    } finally {
      await mount.close();
    }
  }
});

test('ISSUE-404: an entry ask whose route is off posts no success card', async () => {
  const session = fakeSession('session-card-entry-off');
  const journal: { readonly kind: string; readonly [field: string]: unknown }[] = [];
  const llm = fakeLlm(answerChunks('{"keepall":true}'));
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined), journal: record => journal.push(record),
    llm: llm as never, judgeRoute: { provider: '', model: '' },
  });
  try {
    session.on((live, event) => { mount.observe(live, event); });
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'm', ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    landResult(session, BODY);
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(llm.calls.length, 0, 'no ask was sent');
    assert.equal(session.log.filter(event => event.type === 'command/run').length, 0,
      'no card implies an ask');
    const off = journal.filter(line => line.kind === 'entry-ask-off');
    assert.ok(off.length >= 1 && off.every(line => line['reason'] === 'not-configured'),
      'each eligible result names the absent route');
  } finally {
    await mount.close();
  }
});

test('ISSUE-404: a prune pass with zero ask rows says no ask was sent', async () => {
  const session = fakeSession('session-card-prune-empty');
  const llm = fakeLlm(answerChunks('{"1":{"forgetall":true,"summary":"an old copy"}}'));
  const mount = createRacoonsMount({
    // The bar sits above the fixture body, so the plan has no eligible unit.
    config: resolvePluginConfig({ barBytes: 1 << 20, capBytes: 1 << 20,
      episodeNoNewPathSteps: null }),
    storage: resolveStorage(undefined), journal: () => {},
    llm: llm as never, judgeRoute: ROUTE,
  });
  try {
    landResult(session, BODY);
    mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    for (const event of session.log) mount.observe(session, event);
    const outcome = await mount.runPrune(session);
    assert.equal(outcome?.plan.askRows.length, 0, 'the pass had nothing to ask');
    assert.equal(llm.calls.length, 0, 'no model call was made');
    const pair = cardPair(session);
    const done = pair.done.data as { kind: string; text: string };
    assert.equal(done.kind, 'success', 'the pass did run');
    assert.match(done.text, /no ask was sent/u, 'the text names the truth');
  } finally {
    await mount.close();
  }
});

test('ISSUE-404: an answered ask whose apply fails settles an error card', async () => {
  const session = fakeSession('session-card-apply-fail');
  const journal: { readonly kind: string; readonly [field: string]: unknown }[] = [];
  const llm = fakeLlm(answerChunks('{"keepall":true}'),
    () => { session.throwSeqOnce = true; });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined), journal: record => journal.push(record),
    llm: llm as never, judgeRoute: ROUTE,
  });
  try {
    session.on((live, event) => { mount.observe(live, event); });
    mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    landResult(session, BODY);
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(llm.calls.length, 1, 'the ask was sent');
    const refused = journal.filter(line => line.kind === 'entry-apply-refused');
    assert.equal(refused[0]?.['code'], 'apply-threw', 'the failed apply is named');
    const pair = cardPair(session);
    const done = pair.done.data as { kind: string; text: string };
    assert.equal(done.kind, 'error', 'the card does not read success');
    assert.match(done.text, /failed to apply/u, 'the text names the failed leg');
  } finally {
    await mount.close();
  }
});

test('ISSUE-461: a surface throw after the ask still closes one error card', async () => {
  const session = fakeSession('session-card-throw');
  const llm = fakeLlm(answerChunks('{"forgetall":"an old copy"}'),
    () => { session.throwSurface = true; });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined), journal: () => {},
    llm: llm as never, judgeRoute: ROUTE,
  });
  try {
    session.on((live, event) => { mount.observe(live, event); });
    mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    landResult(session, BODY);
    // The host's surface read throws after the answer; the throw may escape the
    // step, but the card is settled before it does.
    try { await mount.runStep(session, { turn: 1, step: 2 }); } catch { /* the host throw */ }
    const pair = cardPair(session);
    const done = pair.done.data as { kind: string; text: string };
    assert.equal(done.kind, 'error', 'a thrown pass is an error card, never a success');
    assert.match(done.text, /surface read failed/u, 'the text names the failure');
    session.throwSurface = false;
    assertLogOnly(session, pair);
  } finally {
    session.throwSurface = false;
    await mount.close();
  }
});

test('the bulk prune pass rides the same card, and closes it on a dead stream', async () => {
  const scenarios = [
    { name: 'answered pass', id: 'session-card-prune',
      llm: fakeLlm(answerChunks('{"1":{"forgetall":true,"summary":"an old copy"}}')), kind: 'success' },
    { name: 'dead stream', id: 'session-card-prune-dead',
      llm: deadStreamLlm(), kind: 'error' },
  ];
  for (const scenario of scenarios) {
    const session = fakeSession(scenario.id);
    const mount = createRacoonsMount({
      config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20,
        episodeNoNewPathSteps: null }),
      storage: resolveStorage(undefined), journal: () => {},
      llm: scenario.llm as never, judgeRoute: ROUTE,
    });
    try {
      landResult(session, BODY);
      mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE,
        messages: [...MAIN_WIRE.messages,
          { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
      for (const event of session.log) mount.observe(session, event);
      const outcome = await mount.runPrune(session);
      assert.ok(outcome !== null, `${scenario.name}: the pass ran`);
      assert.ok(scenario.llm.calls.length >= 1, `${scenario.name}: the ask left the seam`);
      const pair = cardPair(session);
      assert.equal((pair.done.data as { kind: string }).kind, scenario.kind,
        `${scenario.name}: the card settles ${scenario.kind}`);
      assertLogOnly(session, pair);
    } finally {
      await mount.close();
    }
  }
});