// ISSUE-420: setup is one transaction, and cleanup makes every callback inert.
//
// The defect was that `execute.after` and `event.subscribe` sat outside any
// try/catch: a throw left live hooks on a mount that never closed, and a retry
// registered a second context hook. Here every registration is inside the
// transaction, the context hook registers last, and every host callback checks
// `disposed` so a callback the host kept after cleanup does nothing — it does
// not strip `excludeTools`, does not transform, does not throw.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  OpencodeAfterToolInput, OpencodeCommandDefinition, OpencodeHostEvent, OpencodeIdleHookInput,
  OpencodeMessage, OpencodePluginContext, OpencodeSessionContext, OpencodeToolDefinition,
} from '../src/host.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import { minimalConversation, sessionContext, sessionId } from './fixtures.js';

/** A push/close event stream, the shape `context.event.subscribe` returns. */
class EventStream {
  private readonly queue: OpencodeHostEvent[] = [];
  private readonly waiters: ((result: IteratorResult<OpencodeHostEvent>) => void)[] = [];
  private closed = false;

  push(event: OpencodeHostEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) { waiter({ done: false, value: event }); return; }
    this.queue.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
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
        this.close();
        return { done: true as const, value: undefined };
      },
    };
  }
}

interface Failures {
  readonly context?: boolean;
  readonly executeAfter?: boolean;
  readonly subscribe?: boolean;
}

interface SetupHost {
  readonly context: OpencodePluginContext;
  readonly stream: EventStream;
  readonly tools: OpencodeToolDefinition[];
  readonly commands: OpencodeCommandDefinition[];
  contextRegistrations: number;
  contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  idleHook: ((input: OpencodeIdleHookInput) => Promise<void> | void) | null;
  afterHook: ((input: OpencodeAfterToolInput) => Promise<void> | void) | null;
}

function setupHost(options: Record<string, unknown>, failures: Failures = {}): SetupHost {
  const stream = new EventStream();
  const tools: OpencodeToolDefinition[] = [];
  const commands: OpencodeCommandDefinition[] = [];
  const host: SetupHost = {
    stream, tools, commands, contextRegistrations: 0,
    contextHook: null, idleHook: null, afterHook: null,
    context: {
      options,
      session: {
        hook: async (
          name: 'context' | 'compaction' | 'generate' | 'experimental.idle',
          callback: ((input: OpencodeSessionContext) => Promise<void> | void)
            | ((input: OpencodeIdleHookInput) => Promise<void> | void),
        ) => {
          if (name === 'experimental.idle') {
            host.idleHook = callback as (input: OpencodeIdleHookInput) => Promise<void> | void;
            return {};
          }
          // ADR-0074's request hooks are accepted but not driven here; they are
          // not context registrations.
          if (name !== 'context') return {};
          host.contextRegistrations += 1;
          if (failures.context === true) throw new Error('context refused');
          host.contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          return {};
        },
        generate: async () => ({ text: '{}' }),
      },
      tool: {
        transform: async (callback) => {
          await callback({ add: (tool) => { tools.push(tool); } });
          return {};
        },
        hook: async (
          name: 'execute.after',
          callback: (input: OpencodeAfterToolInput) => Promise<void> | void,
        ) => {
          if (name !== 'execute.after') throw new Error('unexpected tool hook');
          if (failures.executeAfter === true) throw new Error('execute.after refused');
          host.afterHook = callback;
          return {};
        },
      },
      command: {
        transform: async (callback) => {
          await callback({ add: (definition) => { commands.push(definition); } });
          return {};
        },
      },
      event: {
        subscribe: () => {
          if (failures.subscribe === true) throw new Error('subscribe refused');
          return stream;
        },
      },
    },
  };
  return host;
}

function hostMessages(): OpencodeMessage[] {
  return structuredClone(minimalConversation()) as OpencodeMessage[];
}

test('a failed registration closes the mount; a retry registers one context hook', async () => {
  const failures: { subscribe?: boolean } = { subscribe: true };
  const host = setupHost({}, failures);
  const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' } });

  await assert.rejects(plugin.setup(host.context), /subscribe refused/u,
    'a required registration failure rejects the setup');

  assert.equal(host.contextRegistrations, 0,
    'the context hook registers last, so a failed transaction leaves none');
  assert.equal(host.contextHook, null, 'no stale context hook was left behind');

  // The seams registered before the failure are still on the host. Each one
  // must be inert now that the mount closed.
  assert.equal(typeof host.afterHook, 'function', 'the after hook was registered before the throw');
  await host.afterHook?.({
    tool: 'read', sessionID: sessionId, id: 'call_1', status: 'completed',
    result: { content: 'x'.repeat(4096) },
  });
  const disposedTool = host.tools[0];
  assert.ok(disposedTool !== undefined, 'the tool was registered before the throw');
  const stale = await disposedTool.execute({ id: 'anything' }, { sessionID: sessionId });
  assert.match(String(stale.content), /disposed/u,
    'a stale tool answers with a plain result instead of throwing');

  // Retry on the same host: exactly one context hook is registered.
  failures.subscribe = false;
  const cleanup = await plugin.setup(host.context);
  try {
    assert.equal(host.contextRegistrations, 1, 'the retry registered the context hook once');
    assert.equal(typeof host.contextHook, 'function');
  } finally { await cleanup(); }
});

test('after cleanup every host callback is inert and nothing throws outward', async () => {
  const host = setupHost({ excludeTools: ['hidden_tool'] });
  const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' } });
  const cleanup = await plugin.setup(host.context);
  assert.equal(typeof host.contextHook, 'function');
  assert.equal(typeof host.idleHook, 'function');
  assert.equal(typeof host.afterHook, 'function');
  assert.ok(host.tools[0] !== undefined);

  await cleanup();

  // A stale context hook must not strip `excludeTools` and must not transform.
  const messages = hostMessages();
  const untouched = structuredClone(messages);
  const tools = {
    hidden_tool: { description: 'x', input: {} },
    read: { description: 'y', input: {} },
  };
  const context: OpencodeSessionContext = { ...sessionContext(messages), tools };
  await host.contextHook?.(context);
  assert.ok(context.tools?.['hidden_tool'] !== undefined,
    'the stale context hook did not delete the excluded tool');
  assert.deepEqual(messages, untouched, 'the stale context hook transformed nothing');

  // The remaining callbacks are inert and do not throw.
  await host.idleHook?.({ sessionID: sessionId });
  await host.afterHook?.({ tool: 'read', sessionID: sessionId, id: 'call_1' });
  await host.commands[0]?.execute({ sessionID: sessionId });
  host.stream.push({ type: 'session.idle', data: { sessionID: sessionId } });

  const stale = await host.tools[0]?.execute({ id: 'anything' }, { sessionID: sessionId });
  assert.match(String(stale?.content), /disposed/u,
    'recall after cleanup returns a plain result, never a thrown error');
});

test('a closed mount refuses post-dispose work and writes no journal line', async () => {
  const records: Record<string, unknown>[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => { records.push(record as unknown as Record<string, unknown>); },
  });
  const messages = hostMessages();
  await mount.transform(sessionId, messages);
  await mount.close();

  const afterClose = records.length;
  assert.equal(mount.disposed, true, 'the mount reports itself disposed');

  await mount.transform(sessionId, hostMessages());
  await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
  await mount.afterTool({ tool: 'read', sessionID: sessionId, id: 'call_1' });
  await mount.idle(sessionId);
  assert.equal((await mount.cremate(sessionId)).fired, false, 'the manual pass is refused');

  assert.equal(records.length, afterClose, 'no post-dispose call wrote a journal line');
  const stale = await mount.tool.execute({ id: 'anything' }, { sessionID: sessionId });
  assert.match(String(stale.content), /disposed/u);
});
