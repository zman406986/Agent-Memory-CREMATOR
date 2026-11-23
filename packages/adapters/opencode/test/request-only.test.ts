// ADR-0074 / ISSUE-552: the compaction and generate requests get the same
// settled removals as the agent loop.
//
// OpenCode builds each request kind from its own stored conversation, so the
// checkpoint summary and the ask's own `session.generate` request carry units
// the normal request removed. The mount registers both hooks and runs a
// request-only apply: settled removals only, no ask, no depth reading, no
// meter/latch/idle/ask-state movement, and the compaction hook's `result` is
// never set. A prefix the array cannot address leaves its stored verdict alone.
//
// No live host and no API key: the fakes answer the host shapes, and the mount
// tests drive the same seams directly.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnitTracker } from '@cremator/core';
import { OPENCODE_ASK_FLOOR_BYTES } from '../src/ask.js';
import type {
  OpencodeCommandDefinition, OpencodeGenerateInput, OpencodeHostEvent,
  OpencodeIdleHookInput, OpencodeMessage, OpencodePluginContext, OpencodeSessionContext,
} from '../src/host.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import type { OpencodeJournalRecord, OpencodeMount, OpencodeMountOptions } from '../src/plugin.js';
import { deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, sessionContext, sessionId, text, textResult, toolCall, toolMessage,
  toolResult, userMessage,
} from './fixtures.js';

const NOTE = `# Note\n\n${'alpha-'.repeat(120)}\n`;
const OTHER = `# Other\n\n${'bravo-'.repeat(120)}\n`;
const TWO_REMOVALS = '{"1":{"forgetall":true,"summary":"alpha"}}\n'
  + '{"2":{"forgetall":true,"summary":"bravo"}}';

/** Two independent large results: two units, no L1 or dedupe class applies. */
function twoUnitMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(NOTE))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'), toolCall('call_2', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(OTHER))]),
    assistantMessage('msg_a3', [text('Both notes say body.')]),
  ];
}

/** The transcript being summarized: it holds the first unit and omits the tail. */
function prefixMessages(): OpencodeMessage[] {
  return twoUnitMessages().slice(0, 3);
}

/** The unit id one call id names, read through the adapter's own projection. */
function unitIdOf(callId: string): string {
  const snapshot = deriveOpencodeSnapshot(twoUnitMessages(), { sessionId }).snapshot;
  const unit = new UnitTracker({ sessionId, barBytes: OPENCODE_ASK_FLOOR_BYTES }).units(snapshot)
    .find(candidate => candidate.nodeId.endsWith(`:tool:${callId}`));
  assert.ok(unit !== undefined, `the ${callId} result is one unit`);
  return unit.id;
}

/** One host usage row: the only reading the depth latch observes. */
function stepUsage(messageId: string, inputTokens: number): OpencodeHostEvent {
  return {
    type: 'session.step.ended',
    data: {
      sessionID: sessionId, assistantMessageID: messageId, finish: 'stop', cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

function journalLines(): {
  readonly records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[];
} {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

function options(
  askGenerate: (input: OpencodeGenerateInput) => Promise<{ text: string }>,
  records: OpencodeJournalRecord[],
): OpencodeMountOptions {
  return {
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    // Deadline off: the test answers every ask immediately, no timer.
    askTimeoutMs: 0,
    askGenerate,
    journal: record => records.push(record),
  };
}

interface Seeded {
  readonly mount: OpencodeMount;
  readonly entry: NonNullable<ReturnType<OpencodeMount['sessions']['get']>>;
  readonly lines: ReturnType<typeof journalLines>;
  readonly generateCalls: OpencodeGenerateInput[];
}

/**
 * Two requests and an idle, so the session has stored verdicts for both units
 * and has not applied them yet (`deferredApply` holds them for the next step).
 */
async function seedSettledVerdicts(): Promise<Seeded> {
  const lines = journalLines();
  const generateCalls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount(options(async (input) => {
    generateCalls.push(input);
    return { text: TWO_REMOVALS };
  }, lines.records));
  await mount.transform(sessionId, twoUnitMessages());
  await mount.event(stepUsage('msg_usage_1', 50));
  await mount.transform(sessionId, twoUnitMessages());
  await mount.event(stepUsage('msg_usage_2', 150));
  await mount.idle(sessionId);
  const entry = mount.sessions.get(sessionId);
  assert.ok(entry !== undefined, 'the session is mounted');
  assert.equal(generateCalls.length, 1, 'the seed ask fired once');
  assert.equal(entry.askVerdicts.size, 2, 'both readable verdicts are stored');
  assert.equal(entry.deferredApply, true, 'the apply waits for a request');
  return { mount, entry, lines, generateCalls };
}

/** Every text part of a message, joined. */
function messageText(message: OpencodeMessage): string {
  return message.content
    .filter(part => part.type === 'text' && typeof part['text'] === 'string')
    .map(part => String(part['text']))
    .join('');
}

/** The receipt message a rewritten array holds, if any. */
function receiptOf(messages: readonly OpencodeMessage[]): OpencodeMessage | undefined {
  return messages.find(message => messageText(message).startsWith('[not retained] '));
}

/** True when this array still carries the tool result one call id produced. */
function carriesResult(messages: readonly OpencodeMessage[], callId: string): boolean {
  return messages.some(message => message.content.some(part =>
    part.type === 'tool-result' && part['id'] === callId));
}

test('ADR-0074: a compaction prefix gets the settled removal and its receipt', async () => {
  const seeded = await seedSettledVerdicts();
  const { mount, entry, lines } = seeded;
  try {
    const input = sessionContext(prefixMessages());
    assert.equal(carriesResult(input.messages, 'call_1'), true, 'the prefix carries the unit');
    await mount.requestOnly('compaction', input);

    assert.equal(carriesResult(input.messages, 'call_1'), false,
      `the unit the prefix carries left the summary request: `
        + JSON.stringify(lines.of('request-only').at(-1)));
    const receipt = receiptOf(input.messages);
    assert.ok(receipt !== undefined, 'the request carries its receipt');
    assert.match(messageText(receipt), /\[not retained\] .*· necromancy recall:sha256:[0-9a-f]{64}$/u,
      'the receipt is the product line with the recall id');
    const applied = lines.of('request-only').at(-1);
    assert.equal(applied?.['requestKind'], 'compaction');
    assert.equal(applied?.['applied'], true);
    assert.equal(applied?.['removals'], 1);
    assert.equal(applied?.['skipped'], 1, 'the unit outside the prefix was skipped');
  } finally {
    await mount.close();
  }
});

test('ADR-0074: a unit outside the compaction prefix keeps its stored verdict', async () => {
  const seeded = await seedSettledVerdicts();
  const { mount, entry } = seeded;
  const firstUnit = unitIdOf('call_1');
  const secondUnit = unitIdOf('call_2');
  try {
    const verdictsBefore = [...entry.askVerdicts.keys()].sort();
    const askedBefore = [...entry.askedUnitIds].sort();
    await mount.requestOnly('compaction', sessionContext(prefixMessages()));
    assert.deepEqual([...entry.askVerdicts.keys()].sort(), verdictsBefore,
      'no verdict was dropped: a missing unit is not proof it is gone');
    assert.equal(entry.askVerdicts.has(firstUnit), true);
    assert.equal(entry.askVerdicts.has(secondUnit), true,
      'the unit outside the prefix keeps its verdict for the normal request');
    assert.deepEqual([...entry.askedUnitIds].sort(), askedBefore,
      'no claim was released or added');
    assert.equal(entry.durableAskVerdicts.size, 2, 'the durable record still owes both');
  } finally {
    await mount.close();
  }
});

test('ADR-0074: a generate request gets the settled removals', async () => {
  const seeded = await seedSettledVerdicts();
  const { mount, entry, generateCalls } = seeded;
  try {
    const input = sessionContext(twoUnitMessages());
    await mount.requestOnly('generate', input);
    assert.equal(carriesResult(input.messages, 'call_1'), false, 'the first unit left');
    assert.equal(carriesResult(input.messages, 'call_2'), false, 'the second unit left');
    assert.equal(input.messages.filter(message =>
      messageText(message).startsWith('[not retained] ')).length, 2, 'one receipt per unit');
    assert.equal(generateCalls.length, 1,
      'the request-only path makes no model call of its own');
    assert.equal(entry.askVerdicts.size, 2, 'applied verdicts stay stored for a rebuild');
  } finally {
    await mount.close();
  }
});

test('ADR-0074: no request-only call moves the latch, meter, idle fact or ask state',
  async () => {
    const seeded = await seedSettledVerdicts();
    const { mount, entry } = seeded;
    try {
      const meterBefore = entry.meter.latest();
      const latchBefore = entry.pruneTrigger.snapshot();
      const idleBefore = entry.completedThroughTurnOrdinal;
      const passRoundBefore = entry.passRound;
      const askFiresBefore = entry.askFires;
      const stepAskFiredBefore = entry.stepAskFired;
      const deferredBefore = entry.deferredApply;
      const verdictsBefore = [...entry.askVerdicts.keys()].sort();
      const claimedBefore = [...entry.askedUnitIds].sort();
      const retriedBefore = [...entry.retriedUnitIds].sort();
      const refusedBefore = [...entry.refusedRetriedUnitIds].sort();
      const pendingBefore = entry.pendingEstimates.map(estimate => estimate?.revision ?? null);
      const seenBefore = [...entry.seenNodeIds].sort();
      const pendingSeenBefore = [...entry.pendingSeenNodeIds].sort();
      const generationsBefore = [entry.compactionGeneration, entry.askGeneration,
        entry.verdictGeneration];
      const lastMessagesBefore = entry.lastMessages;

      await mount.requestOnly('compaction', sessionContext(prefixMessages()));
      await mount.requestOnly('generate', sessionContext(twoUnitMessages()));

      assert.deepEqual(entry.meter.latest(), meterBefore, 'the meter did not move');
      assert.deepEqual(entry.pruneTrigger.snapshot(), latchBefore, 'the depth latch did not move');
      assert.equal(entry.completedThroughTurnOrdinal, idleBefore, 'the idle fact did not move');
      assert.equal(entry.passRound, passRoundBefore, 'the pass round did not advance');
      assert.equal(entry.askFires, askFiresBefore, 'no fire was recorded');
      assert.equal(entry.stepAskFired, stepAskFiredBefore, 'the step ask flag did not move');
      assert.equal(entry.deferredApply, deferredBefore, 'the deferred apply did not move');
      assert.deepEqual([...entry.askVerdicts.keys()].sort(), verdictsBefore);
      assert.deepEqual([...entry.askedUnitIds].sort(), claimedBefore);
      assert.deepEqual([...entry.retriedUnitIds].sort(), retriedBefore);
      assert.deepEqual([...entry.refusedRetriedUnitIds].sort(), refusedBefore);
      assert.deepEqual(entry.pendingEstimates.map(estimate => estimate?.revision ?? null),
        pendingBefore, 'no estimate was pushed');
      assert.deepEqual([...entry.seenNodeIds].sort(), seenBefore, 'no node became seen');
      assert.deepEqual([...entry.pendingSeenNodeIds].sort(), pendingSeenBefore,
        'no shipped set was recorded');
      assert.deepEqual([entry.compactionGeneration, entry.askGeneration,
        entry.verdictGeneration], generationsBefore, 'no generation moved');
      assert.equal(entry.lastMessages, lastMessagesBefore,
        'the idle path still holds the normal request array');
    } finally {
      await mount.close();
    }
  });

test('ADR-0074: a generate apply during an in-flight ask keeps the ask state',
  async () => {
    const seeded = await seedSettledVerdicts();
    const { mount, entry, lines, generateCalls } = seeded;
    try {
      const verdictsBefore = [...entry.askVerdicts.keys()].sort();
      const claimsBefore = [...entry.askedUnitIds].sort();
      // The ask flow holds this flag while its own generate request is built.
      entry.askInFlight = true;
      // A compaction request does not stack on the open ask: it is named and
      // skipped whole.
      const compaction = sessionContext(prefixMessages());
      await mount.requestOnly('compaction', compaction);
      assert.equal(carriesResult(compaction.messages, 'call_1'), true,
        'the compaction request waits for the ask');
      assert.equal(lines.of('request-only').at(-1)?.['reason'], 'busy');
      // The ask's own generate request is served, and its stored verdicts are
      // applied without touching the ask's state.
      const generate = sessionContext(twoUnitMessages());
      await mount.requestOnly('generate', generate);
      entry.askInFlight = false;
      assert.equal(carriesResult(generate.messages, 'call_1'), false);
      assert.equal(carriesResult(generate.messages, 'call_2'), false);
      assert.deepEqual([...entry.askVerdicts.keys()].sort(), verdictsBefore,
        'the verdicts are not cleared under the ask');
      assert.deepEqual([...entry.askedUnitIds].sort(), claimsBefore,
        'the claims are not moved under the ask');
      assert.equal(generateCalls.length, 1, 'the request-only path asked nothing');
      assert.equal(entry.askInFlight, false, 'the flag is the test\'s own, not the apply\'s');
    } finally {
      entry.askInFlight = false;
      await mount.close();
    }
  });

test('ADR-0074: a host compaction makes the stored verdicts stale for this lane too',
  async () => {
    const seeded = await seedSettledVerdicts();
    const { mount, entry, lines } = seeded;
    try {
      await mount.event({ type: 'session.compaction.started',
        data: { sessionID: sessionId } });
      assert.equal(entry.compactionGeneration, 1, 'the compaction generation moved');
      const input = sessionContext(prefixMessages());
      await mount.requestOnly('compaction', input);
      assert.equal(carriesResult(input.messages, 'call_1'), true,
        'a verdict the host compaction made stale is not applied');
      assert.equal(entry.askVerdicts.size, 2,
        'the verdicts stay for the normal request to drop by name');
      assert.equal(lines.of('request-only').at(-1)?.['staleVerdicts'], true,
        'the journal names the stale verdicts');
    } finally {
      await mount.close();
    }
  });

test('ADR-0074: a second identical request is idempotent', async () => {
  const seeded = await seedSettledVerdicts();
  const { mount } = seeded;
  try {
    const first = sessionContext(prefixMessages());
    await mount.requestOnly('compaction', first);
    const firstReceipt = receiptOf(first.messages);
    assert.ok(firstReceipt !== undefined, 'the first request gets its receipt');
    const text = messageText(firstReceipt);

    // The host rebuilds the request from its store: the unit is back, the
    // receipt is not. The re-application lands the same single receipt line.
    const rebuilt = sessionContext(prefixMessages());
    await mount.requestOnly('compaction', rebuilt);
    const rebuiltReceipt = receiptOf(rebuilt.messages);
    assert.ok(rebuiltReceipt !== undefined, 'the rebuilt request gets its receipt');
    assert.equal(messageText(rebuiltReceipt), text,
      'the receipt line is the one the recall id already names');
    assert.equal(rebuilt.messages.filter(message =>
      messageText(message).startsWith('[not retained] ')).length, 1,
    'a rebuilt request carries one receipt, never a duplicate');

    // The same array again: the unit is already gone, so nothing applies and
    // nothing moves.
    const before = structuredClone(first.messages);
    await mount.requestOnly('compaction', first);
    assert.deepEqual(first.messages, before, 'a replayed request is byte-identical');
  } finally {
    await mount.close();
  }
});

// --- the plugin's registration and both hooks, end to end --------------------

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

interface FakeHost {
  readonly context: OpencodePluginContext;
  readonly journal: OpencodeJournalRecord[];
  readonly stream: EventStream;
  readonly registered: string[];
  readonly generateCalls: OpencodeGenerateInput[];
  runContext(messages: OpencodeMessage[]): Promise<void>;
  runIdle(): Promise<void>;
  runCompaction(input: OpencodeSessionContext & { result?: unknown }): Promise<void>;
  runGenerate(input: OpencodeSessionContext): Promise<void>;
}

/**
 * `refuse` throws on that hook's registration, the shape of a host that
 * predates ADR-0074's seams. The ask (`session.generate`) is the only model
 * call the fake answers.
 */
function fakeHost(options: {
  readonly reply?: string;
  readonly refuse?: readonly ('compaction' | 'generate')[];
} = {}): FakeHost {
  const stream = new EventStream();
  const journal: OpencodeJournalRecord[] = [];
  const registered: string[] = [];
  const generateCalls: OpencodeGenerateInput[] = [];
  let contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null = null;
  let idleHook: ((input: OpencodeIdleHookInput) => Promise<void> | void) | null = null;
  let compactionHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null = null;
  let generateHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null = null;
  const host: FakeHost = {
    journal, stream, registered, generateCalls,
    runContext: async (messages) => {
      assert.ok(contextHook !== null, 'the context hook registered');
      await contextHook({ sessionID: sessionId, messages, tools: {} });
    },
    runIdle: async () => {
      assert.ok(idleHook !== null, 'the idle hook registered');
      await idleHook({ sessionID: sessionId, background: [] });
    },
    runCompaction: async (input) => {
      assert.ok(compactionHook !== null, 'the compaction hook registered');
      await compactionHook(input);
    },
    runGenerate: async (input) => {
      assert.ok(generateHook !== null, 'the generate hook registered');
      await generateHook(input);
    },
    context: {
      options: {},
      session: {
        hook: async (name: 'context' | 'compaction' | 'generate' | 'experimental.idle',
          callback: ((input: OpencodeSessionContext) => Promise<void> | void)
            | ((input: OpencodeIdleHookInput) => Promise<void> | void)) => {
          registered.push(name);
          if (options.refuse?.includes(name as 'compaction' | 'generate') === true) {
            throw new Error(`${name} seam refused`);
          }
          if (name === 'context') {
            contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          } else if (name === 'experimental.idle') {
            idleHook = callback as (input: OpencodeIdleHookInput) => Promise<void> | void;
          } else if (name === 'compaction') {
            compactionHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          } else {
            generateHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          }
          return {};
        },
        generate: async (input: OpencodeGenerateInput) => {
          generateCalls.push(input);
          return { text: options.reply ?? TWO_REMOVALS };
        },
      },
      tool: {
        transform: async () => ({}),
        hook: async () => ({}),
      },
      command: { transform: async (_callback: (editor: {
        add(definition: OpencodeCommandDefinition): void }) => Promise<void> | void) => ({}) },
      event: { subscribe: () => stream },
    },
  };
  return host;
}

test('ADR-0074: setup registers compaction and generate, and both apply settled removals',
  async () => {
    const host = fakeHost();
    const cleanup = await createOpencodePlugin({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option', askTimeoutMs: 0,
      askGenerate: async (input) => {
        host.generateCalls.push(input);
        return { text: TWO_REMOVALS };
      },
      journal: record => host.journal.push(record),
    }).setup(host.context);
    try {
      assert.deepEqual(host.registered,
        ['context', 'compaction', 'generate', 'experimental.idle'],
        'both request hooks register beside context');
      await host.runContext(twoUnitMessages());
      await host.runContext(twoUnitMessages());
      await host.runContext(twoUnitMessages());
      await host.runIdle();
      assert.equal(host.generateCalls.length, 1, 'the seed ask fired once');

      const compactionInput: OpencodeSessionContext & { result?: unknown } = {
        ...sessionContext(prefixMessages()),
      };
      await host.runCompaction(compactionInput);
      assert.equal(carriesResult(compactionInput.messages, 'call_1'), false,
        'the compaction request carries the settled removal');
      assert.ok(receiptOf(compactionInput.messages) !== undefined,
        'and its receipt');
      assert.equal(compactionInput['result'], undefined, 'the summary slot stays unset');
      assert.equal('result' in compactionInput, false,
        'the hook never writes the host\'s result key');

      const generateInput = sessionContext(twoUnitMessages());
      await host.runGenerate(generateInput);
      assert.equal(carriesResult(generateInput.messages, 'call_1'), false,
        'the generate request carries the settled removals');
      assert.equal(host.generateCalls.length, 1,
        'neither request-only hook made a model call');

      assert.deepEqual(host.registered,
        ['context', 'compaction', 'generate', 'experimental.idle'],
        'the request-only path registered no further session hook');
      const lines = host.journal.filter(record => record.kind === 'request-only');
      assert.equal(lines.filter(line => line['requestKind'] === 'compaction').length, 1);
      assert.equal(lines.filter(line => line['requestKind'] === 'generate').length, 1);
    } finally {
      await cleanup();
      host.stream.close();
    }
  });

test('ADR-0074: a host that refuses either registration still mounts', async () => {
  const host = fakeHost({ refuse: ['compaction', 'generate'] });
  const cleanup = await createOpencodePlugin({
    storage: { databasePath: ':memory:' }, journal: record => host.journal.push(record),
  }).setup(host.context);
  try {
    const refused = host.journal.filter(record => record.kind === 'request-only-error');
    assert.equal(refused.length, 2, 'both refusals are journalled');
    assert.deepEqual(refused.map(line => line['hook'] as string).sort(),
      ['compaction', 'generate']);
    assert.equal(refused.every(line => line['reason'] === 'register-failed'), true);
    // The mount keeps working through the context hook.
    await host.runContext([userMessage('msg_u1', [text('Hello.')])]);
    assert.equal(host.journal.some(record => record.kind === 'at-rest'), true,
      'the context hook still runs');
  } finally {
    await cleanup();
    host.stream.close();
  }
});
