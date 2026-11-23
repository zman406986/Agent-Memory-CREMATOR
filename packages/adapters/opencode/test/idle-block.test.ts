// ISSUE-373 (ADR-0062 D2): the idle-origin ask runs inside the awaited
// `session.hook('experimental.idle')` seam, so the host's single drain waits
// for it before any queued prompt — blocking parity with the step-origin ask.
// The event path keeps observe/turn-fact only, and ISSUE-353's turn-ordinal
// guard stays intact. No TUI/status card here (deferred to ISSUE-376).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  OpencodeGenerateInput, OpencodeHostEvent, OpencodeIdleHookInput,
  OpencodeMessage, OpencodePluginContext, OpencodeSessionContext,
} from '../src/host.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import {
  assistantMessage, sessionId, sessionContext, text, textResult, toolCall,
  toolMessage, toolResult, userMessage,
} from './fixtures.js';

/** One large tableable read and one tiny read, in the shipped 2.4.0 shape. */
function largeMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a_small', [
      text('Reading SMALL.md.'),
      toolCall('call_small', 'read', { filePath: 'SMALL.md' }),
    ]),
    toolMessage('msg_t_small', [toolResult('call_small', 'read', textResult('tiny'))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
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

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

async function tick(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve); });
}

/** Let the plugin's event consumer drain pushed events (test-side only). */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) await tick();
  assert.ok(condition(), 'the pushed events reached the mount');
}

/** The smallest event stream the setup's consumer reads. */
class FakeEventStream {
  private readonly queue: OpencodeHostEvent[] = [];
  private readonly waiters: ((result: IteratorResult<OpencodeHostEvent>) => void)[] = [];
  private closed = false;

  push(event: OpencodeHostEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) { waiter({ done: false, value: event }); return; }
    this.queue.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<OpencodeHostEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false as const, value: event });
        if (this.closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise(resolve => { this.waiters.push(resolve); });
      },
      return: async () => {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
          waiter({ done: true, value: undefined });
        }
        return { done: true as const, value: undefined };
      },
    };
  }
}

/** An ephemeral stream: an event pushed before anyone subscribes is lost. */
class EphemeralStream extends FakeEventStream {
  private subscribed = false;

  override push(event: OpencodeHostEvent): void {
    if (!this.subscribed) return;
    super.push(event);
  }

  override [Symbol.asyncIterator](): AsyncIterator<OpencodeHostEvent> {
    this.subscribed = true;
    return super[Symbol.asyncIterator]();
  }
}

test('ISSUE-411: the event consumer is live before the idle hook registers', async () => {
  const lines = journalLines();
  const stream = new EphemeralStream();
  const order: string[] = [];
  let releaseIdleHook = (): void => {};
  const idleHookGate = new Promise<void>(resolve => { releaseIdleHook = resolve; });
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  } = { context: null };
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void> | void) => {
        order.push(`hook:${name}`);
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
          return {};
        }
        // ADR-0074's request hooks register before the idle seam; this row is
        // about the ISSUE-411 ordering, so they are accepted and left unwired.
        if (name !== 'experimental.idle') return {};
        // The awaited idle registration is in progress. The stream has no
        // subscriber under the old ordering, so this event is dropped there.
        stream.push({ type: 'session.compaction.started', data: { sessionID: sessionId } });
        await idleHookGate;
        return {};
      },
      generate: async () => ({ text: '{}' }),
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => Promise<void>) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: {
      subscribe: () => { order.push('subscribe'); return stream; },
    },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  const settingUp = plugin.setup(context);
  try {
    // The consumer must consume the event while the idle hook registration is
    // still pending: that is the ISSUE-411 gap.
    await waitFor(() => lines.of('compacted').length === 1);
    assert.ok(order.indexOf('subscribe') < order.indexOf('hook:experimental.idle'),
      'the subscription is live before the idle hook registers');
    releaseIdleHook();
    const cleanup = await settingUp;
    try {
      assert.equal(lines.of('idle-hook').length, 1, 'the registration is journalled');
      assert.equal(lines.of('idle-hook')[0]?.['registered'], true,
        'the journal says the hook registered, not that it was never called');
    } finally { await cleanup(); }
  } finally { releaseIdleHook(); }
});

test('ISSUE-482: an idle during the idle-hook registration asks exactly once', async () => {
  const lines = journalLines();
  const stream = new FakeEventStream();
  let asks = 0;
  let releaseRegistration = (): void => {};
  const registrationGate = new Promise<void>(resolve => { releaseRegistration = resolve; });
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
    idle: ((input: OpencodeIdleHookInput) => Promise<void> | void) | null;
  } = { context: null, idle: null };
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void> | void) => {
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
          return {};
        }
        if (name !== 'experimental.idle') throw new Error(`unexpected session hook: ${name}`);
        hooks.idle = callback as unknown as typeof hooks.idle;
        // Hold the registration open: this is the pre-registration window.
        await registrationGate;
        return {};
      },
      generate: async () => ({ text: '{"1":{"keepall":true}}' }),
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => Promise<void>) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: { subscribe: () => stream },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: '{"1":{"keepall":true}}' }; },
    journal: record => lines.records.push(record),
  });
  const settingUp = plugin.setup(context);
  try {
    // ISSUE-482: the context hook is live while `experimental.idle` is still
    // registering, so this test walks the registration window on a mount that
    // really registers, not on `createOpencodeMount`'s default flag.
    await waitFor(() => hooks.context !== null);
    const deliver = hooks.context as (input: OpencodeSessionContext) => Promise<void> | void;
    assert.equal(lines.of('idle-hook').length, 0, 'the idle registration has not returned');
    // Step 1 ships the units; a below-bar host reading keeps the step ask quiet.
    await deliver(sessionContext(largeMessages()));
    stream.push(stepUsage('msg_482_1', 50));
    await waitFor(() => lines.of('usage-reconciled').length === 1);
    await deliver(sessionContext(largeMessages()));
    stream.push(stepUsage('msg_482_2', 150));
    await waitFor(() => lines.of('usage-reconciled').length === 2);
    // An idle delivered inside the pending registration is the event path's.
    stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
    await waitFor(() => lines.of('ask').length === 1);
    assert.equal(asks, 1, 'the idle that arrives before the hook registers asks once');
    assert.equal(lines.of('ask')[0]?.['origin'], 'idle', 'the fire names the idle origin');
    // Registration completes; the hook firing for the same revision asks nothing.
    releaseRegistration();
    const cleanup = await settingUp;
    try {
      assert.equal(lines.of('idle-hook').length, 1, 'the registration is journalled');
      await hooks.idle?.({ sessionID: sessionId, background: [] });
      assert.equal(asks, 1, 'the hook firing for the same revision never stacks a second ask');
      assert.equal(lines.of('ask').length, 1, 'still exactly one fire');
    } finally { await cleanup(); }
  } finally {
    releaseRegistration();
    await settingUp.catch(() => {});
  }
});

test('ISSUE-411: a refused idle hook keeps the event-path ask', async () => {
  const lines = journalLines();
  const stream = new FakeEventStream();
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  } = { context: null };
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void> | void) => {
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
          return {};
        }
        throw new Error(`this host predates ${name}`);
      },
      generate: async () => ({ text: '{"1":{"keepall":true}}' }),
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => Promise<void>) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: { subscribe: () => stream },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    journal: record => lines.records.push(record),
  });
  const cleanup = await plugin.setup(context);
  try {
    assert.equal(lines.of('idle-hook-error').length, 1, 'the refusal is journalled');
    assert.ok(hooks.context !== null, 'the context hook is registered');
    await hooks.context(sessionContext(largeMessages()));
    stream.push(stepUsage('msg_411_1', 50));
    await waitFor(() => lines.of('usage-reconciled').length === 1);
    await hooks.context(sessionContext(largeMessages()));
    stream.push(stepUsage('msg_411_2', 150));
    await waitFor(() => lines.of('usage-reconciled').length === 2);
    // No awaited hook: the event path still owns the idle ask.
    stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
    await waitFor(() => lines.of('ask').length === 1);
    assert.equal(lines.of('ask')[0]?.['origin'], 'idle', 'the event path asked');
  } finally { await cleanup(); }
});

test('ISSUE-373: the idle-origin ask blocks inside the awaited experimental.idle hook', async () => {
  const lines = journalLines();
  const stream = new FakeEventStream();
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
    idle: ((input: OpencodeIdleHookInput) => Promise<void> | void) | null;
  } = { context: null, idle: null };
  const generateCalls: OpencodeGenerateInput[] = [];
  let releaseAsk: (answer: { text: string }) => void = () => {};
  let markAskStarted: () => void = () => {};
  const askStarted = new Promise<void>(resolve => { markAskStarted = resolve; });
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void> | void) => {
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
        } else if (name === 'experimental.idle') {
          hooks.idle = callback as unknown as typeof hooks.idle;
        } else {
          throw new Error(`unexpected session hook: ${name}`);
        }
        return {};
      },
      generate: async (input: OpencodeGenerateInput) => {
        generateCalls.push(input);
        markAskStarted();
        // The ask suspends: the host's drain is waiting on the idle hook.
        return new Promise<{ text: string }>(resolve => { releaseAsk = resolve; });
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => Promise<void>) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: { subscribe: () => stream },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    journal: record => lines.records.push(record),
  });
  const cleanup = await plugin.setup(context);
  try {
    assert.ok(hooks.context !== null, 'the context hook is registered');
    assert.ok(hooks.idle !== null,
      'the plugin registers the awaited experimental.idle hook (ADR-0062 D2)');
    // Step 1 ships the units; a below-bar host reading keeps the step ask quiet.
    await hooks.context(sessionContext(largeMessages()));
    stream.push(stepUsage('msg_idle_block_1', 50));
    await waitFor(() => lines.of('usage-reconciled').length === 1);
    await hooks.context(sessionContext(largeMessages()));
    assert.equal(generateCalls.length, 0, 'the step ask stayed quiet below the bar');
    stream.push(stepUsage('msg_idle_block_2', 150));
    await waitFor(() => lines.of('usage-reconciled').length === 2);
    // The turn ends: the host awaits this hook inside its single drain.
    const idleCall = Promise.resolve(hooks.idle({ sessionID: sessionId, background: [] }));
    await askStarted;
    assert.equal(generateCalls.length, 1, 'the idle hook fired the ask');
    let settled = false;
    void idleCall.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false,
      'the awaited hook stays pending while the ask is in flight: the drain queues new input behind it');
    // A prompt the host delivers anyway is skipped whole — the second lock.
    await hooks.context(sessionContext(largeMessages()));
    assert.equal(lines.of('transform').at(-1)?.['reason'], 'ask-in-flight',
      'a re-entrant context hook during the ask is still skipped whole');
    // The event path runs no second ask while the hook owns the turn.
    stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
    await waitFor(() => lines.of('at-rest').some(line => line['reason'] === 'turn-end'));
    assert.equal(generateCalls.length, 1, 'the event path did not stack a second ask');
    releaseAsk({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' });
    await idleCall;
    assert.equal(lines.of('ask').length, 1, 'one fire');
    assert.equal(lines.of('ask')[0]?.['origin'], 'idle', 'the fire names the idle origin');
    // The queued prompt now transforms normally: the ask no longer backgrounds it.
    const stepsBefore = lines.of('at-rest').filter(line => line['reason'] === 'step').length;
    await hooks.context(sessionContext(largeMessages()));
    assert.equal(lines.of('at-rest').filter(line => line['reason'] === 'step').length,
      stepsBefore + 1, 'the queued prompt runs its pass after the ask resolved');
  } finally { await cleanup(); }
});

test('ISSUE-373: the wired idle hook keeps ISSUE-353\'s turn-ordinal guard on the event path', async () => {
  const lines = journalLines();
  let askCalls = 0;
  let releaseAsk: (answer: { text: string }) => void = () => {};
  let markAskStarted: () => void = () => {};
  const askStarted = new Promise<void>(resolve => { markAskStarted = resolve; });
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: () => {
      askCalls += 1;
      if (askCalls === 1) {
        markAskStarted();
        return new Promise<{ text: string }>(resolve => { releaseAsk = resolve; });
      }
      return Promise.resolve({ text: '{"1":{"keepall":true}}' });
    },
    journal: record => lines.records.push(record),
  });
  try {
    // The plugin sets this once the awaited hook registers; the event path
    // then keeps only observe/turn-fact.
    mount.idleAskOnEvent = false;
    await mount.transform(sessionId, largeMessages());
    await mount.event(stepUsage('msg_353_idle_1', 50));
    await mount.transform(sessionId, largeMessages());
    await mount.event(stepUsage('msg_353_idle_2', 150));
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session is mounted');
    assert.equal(entry.completedThroughTurnOrdinal, null, 'no idle has delivered a fact');
    const idleCall = mount.idle(sessionId);
    await askStarted;
    assert.equal(entry.askInFlight, true, 'the hook\'s ask is in flight');
    // A nested ask's own idle hook firing is not a second pass.
    await mount.idle(sessionId);
    assert.equal(askCalls, 1, 'the in-flight ask guards a re-entrant idle hook');
    // The nested generate's turn end arrives on the event path while the ask lives.
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, null,
      'ISSUE-353: the nested ask\'s idle records no completed-turn fact for the live turn');
    assert.equal(askCalls, 1, 'the event path ran no ask while the hook owns it');
    releaseAsk({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' });
    await idleCall;
    assert.equal(entry.askInFlight, false, 'the ask resolved');
    // The turn's OWN idle, with no ask in flight, still records the fact.
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, 0,
      'a genuine turn-end idle records the turn it ended');
    assert.equal(lines.of('ask').length, 1, 'one fire');
    assert.equal(lines.of('ask')[0]?.['origin'], 'idle', 'the fire names the idle origin');
  } finally { await mount.close(); }
});

test('ISSUE-395: a nested idle during an in-flight step ask runs no depth latch', async () => {
  const lines = journalLines();
  let askCalls = 0;
  let releaseAsk: (answer: { text: string }) => void = () => {};
  let markAskStarted: () => void = () => {};
  const askStarted = new Promise<void>(resolve => { markAskStarted = resolve; });
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: () => {
      askCalls += 1;
      markAskStarted();
      return new Promise<{ text: string }>(resolve => { releaseAsk = resolve; });
    },
    journal: record => lines.records.push(record),
  });
  // A hook-refusing host: `idleAskOnEvent` stays true, so the event path owns
  // the idle ask. The step ask suspends with `stepAskFired` still false.
  try {
    await mount.transform(sessionId, largeMessages());
    await mount.event(stepUsage('msg_395_1', 50));
    await mount.transform(sessionId, largeMessages());
    await mount.event(stepUsage('msg_395_2', 150));
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session is mounted');
    // The third transform crosses the bar and fires the step ask, which suspends.
    const stepCall = mount.transform(sessionId, largeMessages());
    await askStarted;
    assert.equal(entry.askInFlight, true, 'the step ask is in flight');
    assert.equal(entry.stepAskFired, false, 'the step ask has not resolved');
    // A stated main row grows the host meter one re-arm delta while the ask
    // lives, so a depth reading here would cross and arm a refused pass.
    const grown = stepUsage('msg_395_3', 260);
    await mount.event({ type: grown.type,
      data: { ...(grown.data as Record<string, unknown>), requestKind: 'main' } });
    const latchBefore = entry.pruneTrigger.snapshot();
    const depthLinesBefore = lines.of('prune-threshold').length;
    // The nested generate's idle arrives on the event path mid-ask.
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(lines.of('prune-threshold').length, depthLinesBefore,
      'no depth reading runs while the step ask is in flight (ADR-0050)');
    assert.deepEqual(entry.pruneTrigger.snapshot(), latchBefore,
      'the nested idle neither consumes nor arms a baseline for the refused pass');
    assert.equal(askCalls, 1, 'no second generate stacked on the in-flight ask');
    releaseAsk({ text: '{"1":{"keepall":true}}' });
    await stepCall;
    assert.equal(entry.askInFlight, false, 'the step ask resolved');
  } finally {
    // Release even on a failed assertion so close never waits out the ask timeout.
    releaseAsk({ text: '{"1":{"keepall":true}}' });
    await mount.close();
  }
});

test('ISSUE-394: an observe throw on the idle path never kills the event consumer', async () => {
  const lines = journalLines();
  const stream = new FakeEventStream();
  const hooks: {
    context: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  } = { context: null };
  const context = {
    session: {
      hook: async (name: string, callback: (input: never) => Promise<void> | void) => {
        if (name === 'context') {
          hooks.context = callback as unknown as typeof hooks.context;
          return {};
        }
        // A hook-refusing host: the event path keeps the idle ask.
        throw new Error(`host refuses hook: ${name}`);
      },
      generate: async () => ({ text: '{"1":{"keepall":true}}' }),
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => Promise<void>) => {
        await callback({ add: () => {} });
        return {};
      },
      hook: async () => ({}),
    },
    event: { subscribe: () => stream },
  } as unknown as OpencodePluginContext;
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    journal: record => lines.records.push(record),
  });
  const cleanup = await plugin.setup(context);
  try {
    assert.ok(hooks.context !== null, 'the context hook is registered');
    await hooks.context(sessionContext(largeMessages()));
    // A non-array host payload: transformStep stores it before its try and
    // fails open, but the next idle's observe throws on it.
    await hooks.context({
      sessionID: sessionId,
      messages: 'not-an-array' as unknown as OpencodeMessage[],
      tools: {},
    });
    assert.ok(lines.of('transform-error').length >= 1, 'the transform failed open');
    stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
    // Red: the rejection escapes event() and the consumer loop exits
    // ('event-error'). Green: idleAsk/idlePass fail open ('at-rest-error').
    await waitFor(() => lines.of('event-error').length + lines.of('at-rest-error').length >= 1);
    // The consumer must still process later events: a session.deleted eviction
    // (ISSUE-379) after the poison idle proves the loop is alive.
    await hooks.context(sessionContext(largeMessages()));
    stream.push({ type: 'session.deleted', data: { sessionID: sessionId } });
    await waitFor(() => lines.of('session-evicted').length === 1);
    assert.equal(lines.of('event-error').length, 0,
      'the consumer loop never saw a rejection: the observe throw failed open');
  } finally { await cleanup(); }
});