/**
 * The three failure-evidence gaps of ISSUE-430.
 *
 *   1. The `mounted` line must ride the mount's swallowing journal wrapper: a
 *      throwing sink cannot reject the plugin apply.
 *   2. A host write that moved while `recordApplied` failed is recovery-pending,
 *      not "core planned nothing to apply"; the line must name the true cause.
 *   3. A malformed pending-append record is named on a fresh process instead of
 *      reading as an empty queue.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type {
  Ledger, LedgerEntry, LedgerEvent, PreparableApplication, PreparedIntent, RecallRecord,
  SessionId,
} from '@cremator/core';
import type { DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession } from '../src/plugin.js';
import { createRacoonsMount, createRacoonsPlugin, resolvePluginConfig,
  resolveStorage } from '../src/plugin.js';
import { openLedger, resolveSessionStorage } from '../src/storage.js';
import { readPendingAppends } from '../src/prune-round-store.js';

const ROUTE = { provider: 'p', model: 'm' };
const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;
const clock = { nowMs: () => Date.now() };

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  return {
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
      return event;
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

interface JournalLine { readonly kind: string; readonly [field: string]: unknown }

test('a throwing journal sink cannot reject the plugin apply (the mounted line is swallowed)', async () => {
  let writes = 0;
  const plugin = createRacoonsPlugin({
    journal: () => { writes += 1; throw new Error('journal sink exploded'); },
  });
  const cleanups: (() => unknown)[] = [];
  const ctx = {
    on: () => {},
    effect: (register: () => (() => unknown) | void) => {
      const fn = register();
      if (typeof fn === 'function') cleanups.push(fn);
    },
  };
  await plugin.apply(ctx as never, {});
  // Both mount-time lines ride the swallowing wrapper: `mounted` and the
  // ISSUE-454 tool outcome. Each throw is contained, so the apply resolves.
  assert.equal(writes, 2, 'both mount lines reached the throwing sink');
  for (const fn of [...cleanups].reverse()) await fn();
});

/** The real in-memory ledger, with only `applied` writes failing. */
class FailAppliedLedger implements Ledger {
  private readonly inner: Ledger;
  constructor(inner: Ledger) { this.inner = inner; }
  prepare(application: PreparableApplication): Promise<PreparedIntent> {
    return this.inner.prepare(application);
  }
  append(event: LedgerEvent): Promise<LedgerEntry> {
    if (event.kind === 'applied') {
      return Promise.reject(new Error('the applied record could not be written'));
    }
    return this.inner.append(event);
  }
  events(sessionId: SessionId): AsyncIterable<LedgerEntry> {
    return this.inner.events(sessionId);
  }
  recall(id: string, options?: Parameters<Ledger['recall']>[1]): Promise<RecallRecord> {
    return this.inner.recall(id as Parameters<Ledger['recall']>[0], options);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

test('a recordApplied failure after a host write journals the true recovery-pending cause', async () => {
  const real = await openLedger(resolveStorage(undefined), clock);
  const ledger = new FailAppliedLedger(real);
  const journal: JournalLine[] = [];
  const llm = fakeLlm('{"forgetall":"stale read"}');
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option',
      episodeNoNewPathSteps: null }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: llm as never,
    judgeRoute: ROUTE,
    openLedger: async () => ledger,
  });
  try {
    const session = fakeSession('s-record-applied');
    landResult(session);
    for (const event of session.log) mount.observe(session, event);
    mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE,
      messages: [...MAIN_WIRE.messages,
        { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(llm.calls.length, 1, 'the ask was sent');
    const applied = journal.find(line => line.kind === 'entry-apply');
    assert.ok(applied !== undefined, 'the apply leg ran');
    assert.ok(Number(applied['appends']) > 0,
      `the host write moved: ${JSON.stringify(applied)}`);
    assert.equal(applied['engineStatus'], 'recovery-pending',
      'the apply record did not land');
    const refused = journal.find(line => line.kind === 'entry-apply-refused');
    assert.ok(refused !== undefined, 'the fail-open outcome is journaled');
    assert.equal(refused['engineStatus'], 'recovery-pending');
    assert.match(String(refused['detail']), /host write moved/u,
      'the true recovery-pending cause is named');
    assert.notEqual(refused['detail'], 'core planned nothing to apply',
      'the generic detail does not hide a moved write');
  } finally {
    await mount.close();
    await real.close();
  }
});

test('a malformed pending-append record is named on a fresh process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-evidence-'));
  try {
    const target = resolveSessionStorage(dir, 'session-corrupt');
    mkdirSync(dirname(target.databasePath), { recursive: true });
    writeFileSync(join(dirname(target.databasePath), 'prune-round.json'),
      `${JSON.stringify({ round: 4,
        appends: [{ recordId: 'r1', bytesBase64: 'not base64 !!!' }] })}\n`, 'utf8');
    const journal: JournalLine[] = [];
    const records = readPendingAppends(target, (kind, fields) => {
      journal.push({ kind, ...fields });
    }, 'session-corrupt');
    assert.deepEqual(records, [], 'the malformed intent reads as empty, fail-open');
    const lines = journal.filter(line => line.kind === 'pending-append-corrupt');
    assert.equal(lines.length, 1, 'the corruption is one named line');
    assert.equal(lines[0]?.['position'], 0, 'the line names the record position');
    assert.match(String(lines[0]?.['detail']), /round-trip/u, 'the defect is named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
