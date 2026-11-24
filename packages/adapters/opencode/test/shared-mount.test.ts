// The host activates a plugin once per location in one process (2.4.0's
// `Context.location`). The adapter shares one process-wide mount per durable
// root across those activations: one ledger per session, one ask lane, one
// mount lock. Each activation still registers its own location-scoped command,
// tools and hooks, and forwards them to the shared mount. This file drives two
// locations against one root and pins the behaviour the owner saw broken:
//
//   - a session in the second folder reaches the mount, and `/cremate` (the
//     RPC the menu parts call) fires for it;
//   - the ask uses the activation that served the session, not the first one;
//   - one event delivered to both location streams is processed once;
//   - cleaning up one location leaves the other working; the last cleanup
//     releases the root.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  OpencodeAfterToolInput, OpencodeCompactionContext,
  OpencodeHostEvent, OpencodeIdleHookInput, OpencodeMessage, OpencodePluginContext,
  OpencodeSessionContext, OpencodeToolDefinition,
} from '../src/host.js';
import { createOpencodeMount, createOpencodePlugin } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-shared-'));
}

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

interface RegisteredRpc {
  readonly handlers: Readonly<Record<string, (input: unknown) => Promise<unknown> | unknown>>;
  alive: boolean;
}
interface FakeHost {
  readonly context: OpencodePluginContext;
  readonly stream: EventStream;
  readonly tools: OpencodeToolDefinition[];
  readonly rpc: RegisteredRpc[];
  contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  idleHook: ((input: OpencodeIdleHookInput) => Promise<void> | void) | null;
  afterHook: ((input: OpencodeAfterToolInput) => Promise<void> | void) | null;
}

function fakeHost(directory: string): FakeHost {
  const stream = new EventStream();
  const tools: OpencodeToolDefinition[] = [];
  const rpc: RegisteredRpc[] = [];
  const host: FakeHost = {
    stream, tools, rpc,
    contextHook: null, idleHook: null, afterHook: null,
    context: {
      location: { directory },
      options: {},
      session: {
        hook: async (
          name: 'context' | 'experimental.idle' | 'compaction' | 'generate',
          callback: ((input: OpencodeSessionContext) => Promise<void> | void)
            | ((input: OpencodeIdleHookInput) => Promise<void> | void)
            | ((input: OpencodeCompactionContext) => Promise<void> | void),
        ) => {
          if (name === 'experimental.idle') {
            host.idleHook = callback as (input: OpencodeIdleHookInput) => Promise<void> | void;
            return {};
          }
          if (name === 'context') {
            host.contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          }
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
          host.afterHook = callback;
          return {};
        },
      },
      rpc: {
        register: async (_definition, handlers) => {
          const entry: RegisteredRpc = {
            handlers: handlers as unknown as RegisteredRpc['handlers'],
            alive: true,
          };
          rpc.push(entry);
          return {
            dispose: () => {
              entry.alive = false;
              const index = rpc.indexOf(entry);
              if (index >= 0) rpc.splice(index, 1);
            },
          };
        },
      },
      event: { subscribe: () => stream },
    },
  };
  return host;
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** One large read result: tableable, above the ask floor, removable whole. */
function readConversation(tag: string, sentinel = 'body'): OpencodeMessage[] {
  const body = `# Note\n\n${`${sentinel}-`.repeat(240)}\n`;
  return [
    userMessage(`msg_${tag}_u1`, [text('Read the note.')]),
    assistantMessage(`msg_${tag}_a1`, [
      toolCall(`call_${tag}`, 'read', { filePath: 'NOTES.md' })]),
    toolMessage(`msg_${tag}_t1`, [
      toolResult(`call_${tag}`, 'read', textResult(body))]),
    assistantMessage(`msg_${tag}_a2`, [text('The note says body.')]),
  ];
}

function contextOf(
  messages: OpencodeMessage[], id: string = sessionId,
): OpencodeSessionContext {
  return { sessionID: id, messages };
}

/** The live RPC handler the menu's last registration would dispatch to. */
function liveRpc(host: FakeHost): RegisteredRpc | null {
  const live = host.rpc.filter(entry => entry.alive);
  return live.length === 0 ? null : live[live.length - 1] ?? null;
}

test('a second folder reaches the shared mount; `/cremate` and the RPC fire for it', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const lines = journalLines();
  let firstAsks = 0;
  let secondAsks = 0;
  const journal = (record: OpencodeJournalRecord): void => { lines.records.push(record); };
  const first = createOpencodePlugin({
    storage, journal, askGrammar: 'prune-two-option',
    askGenerate: async () => { firstAsks += 1; return { text: '{}' }; },
  });
  const second = createOpencodePlugin({
    storage, journal, askGrammar: 'prune-two-option',
    askGenerate: async () => {
      secondAsks += 1;
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
  });
  const hostA = fakeHost(join(dir, 'folder-a'));
  const hostB = fakeHost(join(dir, 'folder-b'));
  const cleanupA = await first.setup(hostA.context);
  const cleanupB = await second.setup(hostB.context);
  try {
    assert.equal(lines.of('mounted').length, 1, 'one mount serves both locations');
    assert.deepEqual(lines.of('mount-shared').map(line => line['status']),
      ['created', 'reused'], 'the second activation joins the live mount');

    // The first folder's session is served by the first activation.
    await hostA.contextHook?.(contextOf([]));
    // The second folder's session is served by the second activation.
    const folderBSession = 'ses_folder_b';
    const messages = readConversation('b');
    await hostB.contextHook?.(contextOf(messages, folderBSession));
    assert.equal(hostA.contextHook !== null && hostB.contextHook !== null, true,
      'both locations registered a context hook');

    // The menu's RPC route: the second location's registration dispatches to
    // the shared mount's manual pass for its own session.
    const rpc = liveRpc(hostB);
    assert.ok(rpc !== null, 'the second location registered the RPC');
    const call = rpc.handlers['cremate'];
    assert.ok(call !== undefined, 'the RPC declares the cremate method');
    const answer = await call({ sessionID: folderBSession });
    assert.deepEqual(answer, { ok: true, fired: true, reason: 'table', rows: 1 },
      'the RPC fires the manual pass for the other folder');
    assert.equal(secondAsks, 1, 'the ask uses the session-serving activation');
    assert.equal(firstAsks, 0, 'the first activation is not asked for another folder');

    // The RPC registered at the second location remains live after the first
    // location is disabled, and its own cleanup is what closes the mount. The
    // stored verdict applies at the next request, exactly as `/cremate`
    // documents; the new unit is tableable by the RPC after that.
    await cleanupA();
    const surviving = liveRpc(hostB);
    assert.ok(surviving !== null, 'the second location RPC survives');
    const more = [...messages, ...readConversation('b2', 'more')];
    await hostB.contextHook?.(contextOf(more, folderBSession));
    assert.equal(more.some(message => message.id === 'msg_b_t1'), false,
      'the manual pass verdict applied at the next request');
    await surviving.handlers['cremate']?.({ sessionID: folderBSession });
    assert.equal(secondAsks, 2, 'the second location RPC still fires after the first left');

    // The last cleanup released the root: a direct mount can claim it again.
    await cleanupB();
    const reopened = createOpencodeMount({ storage });
    try { await reopened.transform(sessionId, readConversation('reopen')); }
    finally { await reopened.close(); }
  } finally {
    try { await cleanupA(); } catch { /* the test may already have cleaned it */ }
    try { await cleanupB(); } catch { /* the test may already have cleaned it */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('one event delivered to both location streams is processed exactly once', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const lines = journalLines();
  const journal = (record: OpencodeJournalRecord): void => { lines.records.push(record); };
  const hostA = fakeHost(join(dir, 'folder-a'));
  const hostB = fakeHost(join(dir, 'folder-b'));
  const cleanupA = await createOpencodePlugin({ storage, journal }).setup(hostA.context);
  const cleanupB = await createOpencodePlugin({ storage, journal }).setup(hostB.context);
  const sessionA = 'ses_location_a';
  const sessionB = 'ses_location_b';
  try {
    await hostA.contextHook?.({ sessionID: sessionA, messages: [] });
    await hostB.contextHook?.({ sessionID: sessionB, messages: [] });

    // The same idle reaches both server-wide streams, naming location A.
    const idleA: OpencodeHostEvent = {
      type: 'session.idle',
      data: { sessionID: sessionA },
      location: { directory: join(dir, 'folder-a') },
    };
    hostA.stream.push(idleA);
    hostB.stream.push(idleA);
    // Location B's own idle also reaches both streams.
    const idleB: OpencodeHostEvent = {
      type: 'session.idle',
      data: { sessionID: sessionB },
      location: { directory: join(dir, 'folder-b') },
    };
    hostA.stream.push(idleB);
    hostB.stream.push(idleB);
    // A global event with no location reaches both and is forwarded once.
    const idleGlobal: OpencodeHostEvent = {
      type: 'session.idle',
      data: { sessionID: sessionA },
    };
    hostA.stream.push(idleGlobal);
    hostB.stream.push(idleGlobal);

    // Let both consumers drain; the mount journals synchronously once it runs.
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 10); });
    }

    const turnEnds = lines.of('at-rest').filter(line => line['reason'] === 'turn-end');
    assert.equal(turnEnds.filter(line => line['sessionId'] === sessionA).length, 2,
      'location A processes its own idle once, plus the global one once');
    assert.equal(turnEnds.filter(line => line['sessionId'] === sessionB).length, 1,
      'location B processes its own idle once');
  } finally {
    await cleanupA();
    await cleanupB();
    rmSync(dir, { recursive: true, force: true });
  }
});
