// ADR-0073 / ISSUE-551: the manual pass is observable through the host RPC
// channel. Every test drives a fake host whose `rpc.register` answers a fake
// registration, so the lifecycle is asserted end to end — no live host, no API
// key. The fake's `events.emit` records each event in call order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREMATE_RPC_DEFINITION, CREMATE_RPC_EVENT_APPLIED, CREMATE_RPC_EVENT_ENDED,
  CREMATE_RPC_EVENT_FAILED, CREMATE_RPC_EVENT_STARTED,
} from '../src/cremate-rpc.js';
import type {
  OpencodeHostEvent,
  OpencodeIdleHookInput, OpencodeMessage, OpencodePluginContext, OpencodeRpcRegistration,
  OpencodeSessionContext,
} from '../src/host.js';
import { createOpencodePlugin } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

const NOTE_RESULT = `# Note\n\n${'alpha-'.repeat(120)}\n`;
const OTHER_RESULT = `# Other\n\n${'bravo-'.repeat(120)}\n`;
/** The unit body is the result text itself, so the removed bytes are these. */
const EXPECTED_BYTES = Buffer.byteLength(NOTE_RESULT, 'utf8')
  + Buffer.byteLength(OTHER_RESULT, 'utf8');
const TWO_REMOVALS = '{"1":{"forgetall":true,"summary":"alpha"}}\n'
  + '{"2":{"forgetall":true,"summary":"bravo"}}';

/** Two independent large results: a two-row table and a two-unit apply. */
function twoUnitMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(NOTE_RESULT))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'), toolCall('call_2', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(OTHER_RESULT))]),
    assistantMessage('msg_a3', [text('Both notes say body.')]),
  ];
}

/** A push/close event stream, the shape `context.event.subscribe` returns. */
class EventStream {
  private readonly waiters: ((result: IteratorResult<OpencodeHostEvent>) => void)[] = [];
  private closed = false;
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<OpencodeHostEvent> {
    return {
      next: () => this.closed
        ? Promise.resolve({ done: true as const, value: undefined })
        : new Promise(resolve => { this.waiters.push(resolve); }),
      return: async () => { this.close(); return { done: true as const, value: undefined }; },
    };
  }
}

type Emitted = { readonly name: string; readonly data: Readonly<Record<string, unknown>> };
type CremateReply = { readonly ok: boolean; readonly fired: boolean;
  readonly reason: string; readonly rows: number };
interface FakeHost {
  readonly context: OpencodePluginContext;
  readonly emitted: Emitted[];
  readonly journal: OpencodeJournalRecord[];
  readonly stream: EventStream;
  definition: unknown;
  runContext(messages: OpencodeMessage[]): Promise<void>;
  cremate(input: unknown): Promise<CremateReply>;
}

/** `withEvents: false` answers a registration with no `events` channel. */
function fakeHost(options: { readonly withEvents?: boolean; readonly reply?: string } = {}) {
  const stream = new EventStream();
  const emitted: Emitted[] = [];
  const journal: OpencodeJournalRecord[] = [];
  let contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null = null;
  let handler: ((input: unknown, context: unknown) => Promise<unknown> | unknown) | null = null;
  const host: FakeHost = {
    emitted, journal, stream, definition: null,
    runContext: async (messages) => {
      assert.ok(contextHook !== null, 'the context hook registered');
      await contextHook({ sessionID: sessionId, messages, tools: {} });
    },
    cremate: async (input) => {
      assert.ok(handler !== null, 'the RPC handler registered');
      return await handler(input, {}) as CremateReply;
    },
    context: {
      options: {},
      session: {
        hook: async (name: 'context' | 'compaction' | 'generate' | 'experimental.idle',
          callback: ((input: OpencodeSessionContext) => Promise<void> | void)
            | ((input: OpencodeIdleHookInput) => Promise<void> | void)) => {
          // The row only drives the context hook; ADR-0074's request hooks are
          // accepted and left unwired, so this fake never runs them.
          if (name === 'context') {
            contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          }
          return {};
        },
        generate: async () => ({ text: options.reply ?? '{}' }),
      },
      tool: {
        transform: async (callback) => { await callback({ add: () => {} }); return {}; },
        hook: async () => ({}),
      },
      rpc: { register: async (definition, handlers): Promise<OpencodeRpcRegistration> => {
        host.definition = definition;
        handler = handlers['cremate'] ?? null;
        if (options.withEvents === false) return {};
        return { events: { emit: async (name: string, data: Readonly<Record<string, unknown>>) => {
          emitted.push({ name, data });
        } } };
      } },
      event: { subscribe: () => stream },
    },
  };
  return host;
}

function eventNames(host: FakeHost): string[] {
  return host.emitted.map(event => event.name);
}

test('the definition declares the four lifecycle events with object payloads', () => {
  assert.deepEqual(Object.keys(CREMATE_RPC_DEFINITION.events),
    [CREMATE_RPC_EVENT_STARTED, CREMATE_RPC_EVENT_ENDED,
      CREMATE_RPC_EVENT_FAILED, CREMATE_RPC_EVENT_APPLIED]);
  for (const definition of Object.values(CREMATE_RPC_DEFINITION.events)) {
    const schema = definition.schema as { type?: unknown; required?: readonly unknown[] };
    assert.equal(schema.type, 'object', 'every payload is an object schema');
    assert.equal(schema.required?.[0], 'sessionID', 'every payload names the session');
  }
  const output = CREMATE_RPC_DEFINITION.methods.cremate.output;
  assert.deepEqual(Object.keys(output.properties), ['ok', 'fired', 'reason', 'rows']);
  assert.deepEqual(output.required, ['ok'], 'ok stays the only required output field');
});

test('a fired manual pass publishes started then ended', async () => {
  const host = fakeHost({ reply: TWO_REMOVALS });
  const cleanup = await createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000, pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option', journal: record => host.journal.push(record),
  }).setup(host.context);
  try {
    await host.runContext([userMessage('msg_install', [text('Session start.')])]);
    await host.runContext(twoUnitMessages());
    assert.deepEqual(eventNames(host), [], 'a step transform publishes no lifecycle event');
    assert.deepEqual(await host.cremate({ sessionID: sessionId }),
      { ok: true, fired: true, reason: 'table', rows: 2 });
    assert.deepEqual(eventNames(host), [CREMATE_RPC_EVENT_STARTED, CREMATE_RPC_EVENT_ENDED],
      'started precedes ended');
    assert.deepEqual(host.emitted[0]?.data, { sessionID: sessionId, trigger: 'manual' });
    assert.deepEqual(host.emitted[1]?.data,
      { sessionID: sessionId, fired: true, reason: 'table', rows: 2 });

    // The RPC lane runs the same `mount.cremate`: a second /cremate at the
    // same revision is refused by the durable unit claim, and `failed` goes out.
    await host.cremate({ sessionID: sessionId });
    assert.deepEqual(host.emitted.at(-1),
      { name: CREMATE_RPC_EVENT_FAILED, data: { sessionID: sessionId, reason: 'claimed-unit' } });
    assert.equal(eventNames(host).filter(name => name === CREMATE_RPC_EVENT_STARTED).length, 1,
      'a refusal publishes no started');
  } finally { await cleanup(); host.stream.close(); }
});

test('a refusal publishes failed with its named reason and no started', async () => {
  const host = fakeHost();
  // No ask grammar: the mount is legal, and every manual pass refuses.
  const cleanup = await createOpencodePlugin({
    storage: { databasePath: ':memory:' }, journal: record => host.journal.push(record),
  }).setup(host.context);
  try {
    await host.runContext([userMessage('msg_u1', [text('Hello.')])]);
    assert.deepEqual(await host.cremate({ sessionID: sessionId }),
      { ok: true, fired: false, reason: 'ask-off', rows: 0 });
    assert.deepEqual(await host.cremate({ sessionID: 'ses_absent' }),
      { ok: true, fired: false, reason: 'no-session', rows: 0 });
    assert.deepEqual(host.emitted, [
      { name: CREMATE_RPC_EVENT_FAILED, data: { sessionID: sessionId, reason: 'ask-off' } },
      { name: CREMATE_RPC_EVENT_FAILED, data: { sessionID: 'ses_absent', reason: 'no-session' } },
    ], 'each refusal names its own reason');
  } finally { await cleanup(); host.stream.close(); }
});

test('an apply publishes applied once for new removals, never on a banked re-application',
  async () => {
    const host = fakeHost({ reply: TWO_REMOVALS });
    const cleanup = await createOpencodePlugin({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option', journal: record => host.journal.push(record),
    }).setup(host.context);
    try {
      await host.runContext([userMessage('msg_install', [text('Session start.')])]);
      await host.runContext(twoUnitMessages());
      assert.equal((await host.cremate({ sessionID: sessionId })).fired, true);
      assert.deepEqual(eventNames(host), [CREMATE_RPC_EVENT_STARTED, CREMATE_RPC_EVENT_ENDED],
        'the fire itself applies nothing, so no applied event');

      // The deferred apply runs on the next rebuilt request.
      await host.runContext(twoUnitMessages());
      const applied = host.emitted.filter(event => event.name === CREMATE_RPC_EVENT_APPLIED);
      assert.equal(applied.length, 1, 'the apply publishes exactly one applied event');
      assert.deepEqual(applied[0]?.data,
        { sessionID: sessionId, removals: 2, bytes: EXPECTED_BYTES },
        'the event counts the removed units and sums their byte lengths');

      // A third rebuilt request re-applies the removal from the banked ledger
      // row: the bytes move again, but nothing new was removed.
      await host.runContext(twoUnitMessages());
      assert.equal(host.journal.filter(record => record.kind === 'ask-apply'
        && record['banked'] === true).length >= 2, true,
      'the banked removal was re-applied on the rebuilt request');
      assert.equal(host.emitted.filter(event => event.name === CREMATE_RPC_EVENT_APPLIED).length,
        1, 'a banked re-application publishes no second applied event');
    } finally { await cleanup(); host.stream.close(); }
  });

test('a host whose registration has no event channel still runs the pass', async () => {
  const host = fakeHost({ withEvents: false, reply: TWO_REMOVALS });
  const cleanup = await createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000, pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option', journal: record => host.journal.push(record),
  }).setup(host.context);
  try {
    await host.runContext([userMessage('msg_install', [text('Session start.')])]);
    await host.runContext(twoUnitMessages());
    assert.deepEqual(await host.cremate({ sessionID: sessionId }),
      { ok: true, fired: true, reason: 'table', rows: 2 },
      'a registration without events changes nothing');
    assert.deepEqual(host.emitted, [], 'nothing could be emitted, and nothing threw');
  } finally { await cleanup(); host.stream.close(); }
});
