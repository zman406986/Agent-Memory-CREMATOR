/**
 * The ask card's failure evidence and containment (ISSUE-429).
 *
 * The card is presentation wrapped around the ask. Two gaps let it change a
 * product outcome: a `command/run` throw was never closed or journaled, and an
 * unguarded `options.warn` call in either catch could throw out of the card and
 * either skip the ask or replace its result. These tests make both seams throw
 * and the warn sink throw, and assert the ask still runs and settles with its
 * real verdict while the journal names the card failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';

const ROUTE = { provider: 'p', model: 'm' };
const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
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
      for (const listener of listeners) listener(session, event);
      return event;
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return session;
}

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

function fakeLlm(text: string): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        yield { type: 'text-delta', index: 0, text: text.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: text.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

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

/** A mount whose warn sink throws: the card must contain it. */
function mountWithThrowingWarn(journal: JournalLine[]) {
  return createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: fakeLlm('{"keepall":true}') as never,
    judgeRoute: ROUTE,
    warn: () => { throw new Error('warn sink exploded'); },
  });
}

function observePrompt(session: FakeSession, mount: ReturnType<typeof mountWithThrowingWarn>): void {
  landResult(session);
  for (const event of session.log) mount.observe(session, event);
  mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
    model: ROUTE.model, ...MAIN_WIRE,
    messages: [...MAIN_WIRE.messages,
      { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
}

test('a throwing command/run is journaled and the ask still runs and settles', async () => {
  const journal: JournalLine[] = [];
  const mount = mountWithThrowingWarn(journal);
  try {
    const session = fakeSession('s-card-open');
    const realAppend = session.append;
    session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      if (type === 'command/run') throw new Error('the card seam is down');
      return realAppend(type, data, options);
    };
    observePrompt(session, mount);
    await mount.runStep(session, { turn: 1, step: 2 });
    const cardErrors = journal.filter(line => line.kind === 'ask-card-error');
    assert.equal(cardErrors.length, 1, 'the failed open is one named line');
    assert.equal(cardErrors[0]?.['phase'], 'open', 'the line names the open phase');
    assert.match(String(cardErrors[0]?.['message']), /card seam is down/u,
      'the seam\'s own message rides the line');
    assert.equal(session.log.some(event => event.type === 'command/run'), false,
      'the failed open wrote no card');
    assert.equal(session.log.some(event => event.type === 'command/done'), false,
      'nothing to close: no done is written');
    assert.ok(journal.some(line => line.kind === 'entry-ask'), 'the ask ran and answered');
    assert.ok(session.log.filter(event => event.type === 'tool/result').length > 0,
      'the step settled instead of throwing out of the card');
  } finally {
    await mount.close();
  }
});

test('a throwing command/done is journaled and cannot replace the ask outcome', async () => {
  const journal: JournalLine[] = [];
  const mount = mountWithThrowingWarn(journal);
  try {
    const session = fakeSession('s-card-close');
    const attempted: string[] = [];
    const realAppend = session.append;
    session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      attempted.push(type);
      if (type === 'command/done') throw new Error('the close seam is down');
      return realAppend(type, data, options);
    };
    observePrompt(session, mount);
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(session.log.filter(event => event.type === 'command/run').length, 1,
      'the card opened');
    assert.equal(session.log.some(event => event.type === 'command/done'), false,
      'the failed close wrote no done');
    const cardErrors = journal.filter(line => line.kind === 'ask-card-error');
    assert.equal(cardErrors.length, 1,
      `the failed close is one named line: ${JSON.stringify(journal.map(line => line.kind))}`
      + ` attempted=${JSON.stringify(attempted)}`);
    assert.equal(cardErrors[0]?.['phase'], 'close', 'the line names the close phase');
    assert.ok(journal.some(line => line.kind === 'entry-ask'),
      'the ask kept its real answered outcome');
  } finally {
    await mount.close();
  }
});
