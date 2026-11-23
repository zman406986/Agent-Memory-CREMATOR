// ISSUE-432: opencode bound `session.generate` at setup and kept the bar and
// window at their mount-option values, all with no record of the provider/model
// they were chosen for. A mid-session switch therefore left stale parameters
// silently in place. This suite drives a provider+model change through the real
// context-hook seam and proves the adapter names the switch, stamps every value
// with the model it was derived from, and states which seam it could not use.
//
// Offline test: no model call, no key, a fake `session.generate`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  OpencodeHostEvent, OpencodeIdleHookInput, OpencodeMessage, OpencodeModelCatalog,
  OpencodePluginContext, OpencodeSessionContext,
} from '../src/host.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import type { OpencodeJournalRecord, OpencodeMountOptions } from '../src/plugin.js';
import {
  assistantMessage, sessionContext, sessionId, text, textResult, toolCall, toolMessage,
  toolResult, userMessage,
} from './fixtures.js';

const MODEL_A = Object.freeze({ id: 'model-a', providerID: 'prov-a' });
const MODEL_B = Object.freeze({ id: 'model-b', providerID: 'prov-b' });
const STAMP_A = Object.freeze({ provider: 'prov-a', model: 'model-a', variant: null });
const STAMP_B = Object.freeze({ provider: 'prov-b', model: 'model-b', variant: null });

/** One result the pass could table, small enough to stay under a 60k bar. */
function requestMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult('# Note\n\nbody\n'))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

function depthOptions(overrides: OpencodeMountOptions = {}): OpencodeMountOptions {
  return {
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    // The latch never reaches the bar here, so no ask is sent; the fake is
    // required only because a configured depth trigger needs the ask lane.
    askGenerate: async () => ({ text: '{"1":{"keepall":true}}' }),
    ...overrides,
  };
}

test('ISSUE-432: a provider/model switch names the stale window and its source model', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount(depthOptions({
    resolveModelWindow: ref => ref.model === 'model-b' ? 1_000_000 : null,
    journal: record => lines.records.push(record),
  }));
  try {
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    assert.equal(lines.of('model-change').length, 0,
      'the first model stamps the parameters; it is not a change');

    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    const change = lines.of('model-change').at(-1);
    assert.ok(change !== undefined, 'the switch is named');
    assert.deepEqual(change['from'], STAMP_A, 'the line names the model just left');
    assert.deepEqual(change['to'], STAMP_B, 'the line names the model now in use');
    assert.equal(change['generate'], 'host-resolved',
      'the generate binding carries no model, so the host resolves the switch');
    assert.deepEqual(change['stale'], ['window'],
      'an explicit bar is the operator\'s count; only the window is model-derived');
    assert.deepEqual(change['parameters'], {
      window: { value: 400_000, derivedFrom: STAMP_A },
      bar: { value: 60_000, derivedFrom: null },
      skipAt: { value: 300_000, derivedFrom: STAMP_A },
    }, 'each value carries the model it came from');
    assert.equal(change['hostSeam'], 'model-catalog', 'the host seam was consulted');
    assert.equal(change['hostWindow'], 1_000_000,
      'the new model\'s declared window is named, not adopted');
    assert.equal(change['reason'], 'window-not-re-derived');

    const reading = lines.of('prune-threshold').at(-1);
    assert.equal(reading?.['window'], 400_000, 'the configured window still describes model A');
    assert.deepEqual(reading?.['derivedFrom'], STAMP_A,
      'every reading states the model its numbers describe');
  } finally { await mount.close(); }
});

test('ISSUE-432: a window-only mount names the bar derived from the old window too', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount(depthOptions({
    pruneThresholdTokens: null,
    resolveModelWindow: () => 1_000_000,
    journal: record => lines.records.push(record),
  }));
  try {
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    const change = lines.of('model-change').at(-1);
    assert.ok(change !== undefined, 'the switch is named');
    assert.deepEqual(change['stale'], ['bar', 'window'],
      'the bar came from the window, so it is stale with it');
    assert.deepEqual(change['parameters'], {
      window: { value: 400_000, derivedFrom: STAMP_A },
      bar: { value: 200_000, derivedFrom: STAMP_A },
      skipAt: { value: 300_000, derivedFrom: STAMP_A },
    }, 'the derived bar carries the model as well');
  } finally { await mount.close(); }
});

test('ISSUE-432: with no model catalog the adapter names the seam it could not use', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount(depthOptions({
    journal: record => lines.records.push(record),
  }));
  try {
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    const change = lines.of('model-change').at(-1);
    assert.ok(change !== undefined, 'the switch is named even without a catalog');
    assert.equal(change['hostSeam'], 'absent', 'the missing seam is named');
    assert.equal(change['reason'], 'no-host-window-declared');
    assert.equal('hostWindow' in change, false, 'no window is claimed without a seam');
    assert.deepEqual(change['stale'], ['window'], 'the stale window is still named');
  } finally { await mount.close(); }
});

test('ISSUE-432: the same model files nothing; each switch away files exactly one line', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount(depthOptions({
    journal: record => lines.records.push(record),
  }));
  try {
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    assert.equal(lines.of('model-change').length, 0,
      'naming the same model again is not a switch');
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    assert.equal(lines.of('model-change').length, 1, 'one line for the switch away');
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    assert.equal(lines.of('model-change').length, 1, 'the new model repeating files nothing');
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    assert.equal(lines.of('model-change').length, 1,
      'returning to the model the parameters were derived from leaves nothing stale');
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    const changes = lines.of('model-change');
    assert.equal(changes.length, 2, 'leaving the derived model again files one more line');
    assert.deepEqual(changes[1]?.['from'], STAMP_A);
    assert.deepEqual(changes[1]?.['to'], STAMP_B);
    // The generate binding is host-resolved on every switch: it carries no
    // model of its own, so it is never part of the stale set.
    for (const change of changes) {
      assert.equal(change['generate'], 'host-resolved',
        'the host resolves the session\'s active model for session.generate');
      assert.equal((change['stale'] as string[]).includes('generate'), false,
        'the generate binding follows the switch; it is not stale');
    }
  } finally { await mount.close(); }
});

test('ISSUE-432: with no window configured the switch is named with an empty stale set', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount(depthOptions({
    contextWindowTokens: null,
    pruneThresholdTokens: null,
    journal: record => lines.records.push(record),
  }));
  try {
    await mount.transform(sessionId, requestMessages(), { model: MODEL_A });
    await mount.transform(sessionId, requestMessages(), { model: MODEL_B });
    const change = lines.of('model-change').at(-1);
    assert.ok(change !== undefined, 'the switch is named without any depth settings');
    assert.deepEqual(change['stale'], [], 'no window means no model-derived value to stale');
    assert.equal(change['reason'], 'no-window-configured');
    assert.deepEqual(change['parameters'], {
      window: { value: null, derivedFrom: STAMP_A },
      bar: { value: null, derivedFrom: STAMP_A },
      skipAt: { value: null, derivedFrom: STAMP_A },
    }, 'the unset values still carry the model the first hook named');
  } finally { await mount.close(); }
});

interface PluginFixture {
  readonly context: OpencodePluginContext;
  /** The context callback `setup` registered, once it has returned. */
  hook(): ((input: OpencodeSessionContext) => Promise<void> | void) | null;
}

/** The smallest host `createOpencodePlugin` mounts against, with one idle stream. */
function pluginFixture(model?: OpencodeModelCatalog): PluginFixture {
  let contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null = null;
  let pending: ((result: IteratorResult<OpencodeHostEvent>) => void) | null = null;
  const stream = {
    [Symbol.asyncIterator](): AsyncIterator<OpencodeHostEvent> {
      return {
        next: () => new Promise<IteratorResult<OpencodeHostEvent>>(resolve => { pending = resolve; }),
        return: async () => {
          pending?.({ done: true, value: undefined });
          pending = null;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const context: OpencodePluginContext = {
    options: {
      crematorContextWindowTokens: 400_000,
      crematorPruneThresholdTokens: 60_000,
      crematorAskGrammar: 'prune-two-option',
    },
    session: {
      hook: async (
        name: 'context' | 'compaction' | 'generate' | 'experimental.idle',
        callback: ((input: OpencodeSessionContext) => Promise<void> | void)
          | ((input: OpencodeIdleHookInput) => Promise<void> | void),
      ) => {
        // This fake predates ADR-0074's request hooks: both registrations are
        // refused, which the mount journals and survives.
        if (name !== 'context') throw new Error(`no ${name} seam`);
        contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
        return {};
      },
      generate: async () => ({ text: '{"1":{"keepall":true}}' }),
    },
    tool: {
      transform: async () => ({}),
      hook: async () => ({}),
    },
    event: { subscribe: () => stream },
    ...(model === undefined ? {} : { model }),
  };
  return { context, hook: () => contextHook };
}

test('ISSUE-432: the plugin reads the hook model and the host catalog for the new model', async () => {
  const lines = journalLines();
  const read: string[] = [];
  const host = pluginFixture({
    get: (provider, model) => {
      read.push(`${provider}/${model}`);
      return model === 'model-b' ? { limit: { context: 1_000_000 } } : undefined;
    },
  });
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  const cleanup = await plugin.setup(host.context);
  try {
    const hook = host.hook();
    assert.ok(hook !== null, 'the context hook registered');
    await hook(sessionContext(requestMessages(), { model: MODEL_A }));
    await hook(sessionContext(requestMessages(), { model: MODEL_B }));
    const change = lines.of('model-change').at(-1);
    assert.ok(change !== undefined, 'the plugin handed the model to the mount');
    assert.deepEqual(change['to'], STAMP_B, 'the switch names both sides');
    assert.equal(change['hostWindow'], 1_000_000, 'the catalog supplied the new window');
    assert.deepEqual(read, ['prov-b/model-b'],
      'the catalog is read for the model now in use, not the one it left');
  } finally { await cleanup(); }
});
