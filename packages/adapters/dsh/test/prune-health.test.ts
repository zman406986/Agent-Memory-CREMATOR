/**
 * The bulk prune's health precheck (ISSUE-426).
 *
 * The entry ask already stands down before paying when the ledger is unreadable
 * or the breaker is disabled. The prune was written separately and had neither
 * check: it paid for a table, then the apply leg refused on the same ledger.
 * These tests drive `runPrune` directly with a healthy result planted, so the
 * only thing that can stop a send is the precheck itself.
 *
 * Every case asserts three facts: no model request left, one named
 * `prune-off` line, and `prune-plan` was never written — the guard ran before
 * the pass planned anything. A second pass proves fail-open: it runs again and
 * journals again instead of throwing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Ledger, LedgerEntry, LedgerEvent, PreparableApplication, PreparedIntent, RecallRecord,
} from '@cremator/core';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { createRefusingLedger } from '../src/refusing-ledger.js';

const ROUTE = { provider: 'p', model: 'm' };
const BODY = `${Array.from({ length: 40 }, (_, index) =>
  `BODY-${String(index + 1)} ${'x'.repeat(24)}`).join('\n')}\n`;

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

function fakeLlm(answer: string): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        yield { type: 'text-delta', index: 0, text: answer.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: answer.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
}

/** The append-only fake session the mount tests share, in miniature. */
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

/** One scripted step landing one oversized read result. */
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

type Mount = ReturnType<typeof createRacoonsMount>;

function mountWith(ledger: Ledger, journal: JournalLine[], llm: FakeLlm): Mount {
  return createRacoonsMount({
    config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20,
      episodeNoNewPathSteps: null }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: llm as never,
    judgeRoute: ROUTE,
    openLedger: async () => ledger,
  });
}

/** Plant the result and main's captured request, exactly as the host would. */
function prepare(mount: Mount, session: FakeSession): void {
  landResult(session);
  for (const event of session.log) mount.observe(session, event);
  mount.observeWire({ sessionId: session.id, provider: ROUTE.provider,
    model: ROUTE.model, ...MAIN_WIRE,
    messages: [...MAIN_WIRE.messages,
      { role: 'tool', content: [{ type: 'text', text: BODY }] }] });
}

/** A ledger holding one `prepared` intent with no applied/abandoned record. */
class PendingLedger implements Ledger {
  private readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }
  async prepare(_application: PreparableApplication): Promise<PreparedIntent> {
    throw new Error('the precheck must not prepare');
  }
  async append(_event: LedgerEvent): Promise<LedgerEntry> {
    throw new Error('the precheck must not append');
  }
  async *events(sessionId: string): AsyncIterable<LedgerEntry> {
    if (sessionId !== this.sessionId) return;
    yield { sequence: 1, event: { kind: 'prepared', sessionId,
      eventKey: 'engine-prepared:ip', atMs: 1, intentId: 'ip',
      applicationSha256: 'a'.repeat(64) } as LedgerEvent };
  }
  async recall(_id: string): Promise<RecallRecord> {
    throw new Error('nothing is banked');
  }
  async close(): Promise<void> {}
}

/** A ledger whose last validation row carries a disabled breaker. */
class DisabledBreakerLedger implements Ledger {
  private readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }
  async prepare(_application: PreparableApplication): Promise<PreparedIntent> {
    throw new Error('the precheck must not prepare');
  }
  async append(_event: LedgerEvent): Promise<LedgerEntry> {
    throw new Error('the precheck must not append');
  }
  async *events(sessionId: string): AsyncIterable<LedgerEntry> {
    if (sessionId !== this.sessionId) return;
    yield { sequence: 1, event: { kind: 'validation', sessionId,
      eventKey: 'prime:validation', atMs: 1, eventId: 'prime', ok: false, issues: [],
      breaker: { consecutiveValidationFailures: 2, disabled: true } } as LedgerEvent };
  }
  async recall(_id: string): Promise<RecallRecord> {
    throw new Error('nothing is banked');
  }
  async close(): Promise<void> {}
}

async function assertStandsDown(params: {
  readonly id: string;
  readonly ledger: Ledger;
  readonly reason: string;
}): Promise<void> {
  const journal: JournalLine[] = [];
  const llm = fakeLlm('{"1":{"forgetall":"an old read"}}');
  const mount = mountWith(params.ledger, journal, llm);
  try {
    const session = fakeSession(params.id);
    prepare(mount, session);
    const outcome = await mount.runPrune(session);
    assert.equal(outcome, null, 'the standdown pass claims nothing');
    assert.equal(llm.calls.length, 0, `${params.reason}: no host request left the seam`);
    assert.equal(journal.some(line => line.kind === 'prune-plan'), false,
      `${params.reason}: the guard ran before the pass planned`);
    const off = journal.filter(line => line.kind === 'prune-off');
    assert.equal(off.length, 1, `${params.reason}: one named standdown line`);
    assert.equal(off[0]?.['reason'], params.reason, `${params.reason}: the reason is named`);
    // Fail-open: the next pass runs again and journals again, never throws.
    const again = await mount.runPrune(session);
    assert.equal(again, null, `${params.reason}: the later pass also does nothing`);
    assert.equal(journal.filter(line => line.kind === 'prune-off').length, 2,
      `${params.reason}: the later pass still runs and says why`);
    assert.equal(llm.calls.length, 0, `${params.reason}: still no request`);
  } finally {
    await mount.close();
  }
}

/**
 * ISSUE-440: the ENTRY lane asks the same three-way health question before its
 * paid send. A `prepared`-only intent means core would answer `recovery-pending`
 * and apply nothing, so no request may leave and every eligible result names it.
 */
async function assertEntryStandsDown(params: {
  readonly id: string;
  readonly ledger: Ledger;
  readonly reason: string;
}): Promise<void> {
  const journal: JournalLine[] = [];
  const llm = fakeLlm('{"keepall":true}');
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined), journal: record => journal.push(record),
    llm: llm as never, judgeRoute: ROUTE, openLedger: async () => params.ledger,
  });
  try {
    const session = fakeSession(params.id);
    prepare(mount, session);
    await mount.runStep(session, { turn: 1, step: 2 });
    assert.equal(llm.calls.length, 0, `${params.reason}: no entry request left the seam`);
    const off = journal.filter(line => line.kind === 'entry-ask-off');
    assert.ok(off.length >= 1, `${params.reason}: the eligible result is named`);
    assert.ok(off.every(line => line['reason'] === params.reason),
      `${params.reason}: every standdown carries the same name`);
    assert.equal(journal.some(line => line.kind === 'entry-ask'
      || line.kind === 'entry-ask-refused'), false, `${params.reason}: nothing was asked`);
    assert.equal(session.log.some(event => event.type === 'command/run'), false,
      `${params.reason}: no ask card implies a send`);
    // Fail-open: a later boundary still runs its lane and stands the next
    // eligible result down by the same name, never throws or latches.
    const seen = session.log.length;
    const callSeq = session.append('tool/call', { turn: 1, step: 2, callId: 'c2',
      name: 'read', arguments: JSON.stringify({ file_path: 'big.txt' }) }).seq;
    session.append('assistant/message', { turn: 1, step: 2,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: 'c2', name: 'read',
          arguments: JSON.stringify({ file_path: 'big.txt' }) }], id: 'asst-c2' } },
    { surfaceOp: 'append' });
    session.append('tool/result', { turn: 1, step: 2,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2',
        content: [{ type: 'text', text: BODY }], isError: false, id: 'result-c2' } },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    for (const event of session.log.slice(seen)) mount.observe(session, event);
    await mount.runStep(session, { turn: 1, step: 3 });
    assert.equal(llm.calls.length, 0, `${params.reason}: the later boundary stays down`);
    assert.ok(journal.filter(line => line.kind === 'entry-ask-off').length > off.length,
      `${params.reason}: the later boundary still runs and says why`);
  } finally {
    await mount.close();
  }
}

test('a recovery-pending ledger stands the paid ENTRY ask down before it is sent (ISSUE-440)',
  async () => {
    const ledger = new PendingLedger('s-entry-recovery');
    await assertEntryStandsDown({ id: 's-entry-recovery', ledger, reason: 'recovery-pending' });
  });

test('a refusing ledger stands the paid prune ask down before it is sent', async () => {
  const ledger = createRefusingLedger({ code: 'open-failed', path: null,
    message: 'the ledger could not open' });
  await assertStandsDown({ id: 's-prune-refusing', ledger, reason: 'ledger-unavailable' });
});

test('a recovery-pending ledger stands the paid prune ask down before it is sent', async () => {
  const ledger = new PendingLedger('s-prune-recovery');
  await assertStandsDown({ id: 's-prune-recovery', ledger, reason: 'recovery-pending' });
});

test('a disabled breaker stands the paid prune ask down before it is sent', async () => {
  const ledger = new DisabledBreakerLedger('s-prune-breaker');
  await assertStandsDown({ id: 's-prune-breaker', ledger, reason: 'breaker-open' });
});
