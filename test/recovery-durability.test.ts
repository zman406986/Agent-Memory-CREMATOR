/**
 * Recovery durability (ISSUE-428). Each test breaks one leg of the resumed-entry
 * recovery and pins what the mount owes the operator:
 *
 *   1. a throw in the surface read leaves a NAMED journal line and does not
 *      clear the recovery latch — the next boundary finishes it;
 *   2. an apply that throws still collapses the ask exchange, so the orphan
 *      cannot reach the next model turn;
 *   3. a kept-mark read the ledger refuses is journaled by name, not a bare
 *      host warning, and the rest of the recovery still completes.
 *
 * They drive the shipped mount over an in-memory session (the latch is the same
 * in both storage modes; ISSUE-414's install boundary is only meaningful when a
 * durable target exists, so nothing here depends on it).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
  RacoonsJournalRecord } from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { createDshPort } from '../src/port.js';

const ROUTE = { provider: 'p', model: 'm' };
const SESSION = 'session-recovery';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  /** Throw once when this seq is read, then forget: a transient surface read. */
  throwAtSeq: number | null;
  /** Throw once on the next `seq` getter read, then forget: a failed apply. */
  throwSeqOnce: boolean;
  /** Throw once on the next surface replace, then cooperate: an unknown collapse. */
  throwReplaceOnce: boolean;
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session: FakeSession = {
    id,
    throwAtSeq: null,
    throwSeqOnce: false,
    throwReplaceOnce: false,
    get seq() {
      if (session.throwSeqOnce) {
        session.throwSeqOnce = false;
        throw new Error('seq read failed');
      }
      return log.length;
    },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => {
      if (session.throwAtSeq === seq) {
        session.throwAtSeq = null;
        throw new Error(`eventAt(${String(seq)}) failed`);
      }
      return log[seq];
    },
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        if (session.throwReplaceOnce) {
          session.throwReplaceOnce = false;
          throw new Error('surface replace failed');
        }
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

const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });

function step(session: FakeSession, body: string, callId = 'c1'): void {
  const message = (id: string, role: string, content: unknown[], source: unknown): void => {
    session.append(`${role}/message`, { turn: 1, step: 1, message: { role, content, source, id } },
      { surfaceOp: 'append' });
  };
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  message('sys-1', 'system', [text('sys')], { kind: 'system-prompt' });
  message('user-1', 'user', [text('task')], { kind: 'user' });
  const callSeq = session.append('tool/call', { turn: 1, step: 1, callId, name: 'read',
    arguments: '{"file_path":"big.txt"}' }).seq;
  message(`asst-${callId}`, 'assistant', [{ type: 'tool-call', id: callId, name: 'read',
    arguments: '{"file_path":"big.txt"}' }], { kind: 'model', provider: 'p', model: 'm' });
  session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId }, toolCallId: callId, content: [text(body)],
    isError: false, id: `result-${callId}` }, meta: { path: 'big.txt' } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn: 1, step: 1 });
}

function oversizedBody(bytes: number): string {
  const line = 'x'.repeat(63);
  return `${`${line}\n`.repeat(Math.ceil(bytes / (line.length + 1)))}`.slice(0, bytes);
}

function answerChunks(value: string): DshLlmChunk[] {
  return [{ type: 'text-delta', index: 0, text: value.slice(0, 5) },
    { type: 'text-delta', index: 0, text: value.slice(5) }, { type: 'finish', reason: 'stop' }];
}

interface JournalLine { readonly kind: string; readonly [field: string]: unknown }
const lines = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

/** True while the surface still derives an orphaned ask turn. */
function holdsOrphanAsk(session: FakeSession): boolean {
  for (const seq of session.surface?.nodes ?? []) {
    const event = session.eventAt?.(seq);
    const data = event?.data as { source?: { kind?: string } } | undefined;
    if (data?.source?.kind === 'racoons/negation/entry-ask') return true;
  }
  return false;
}

const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }],
};

interface Harness {
  readonly session: FakeSession;
  readonly journal: JournalLine[];
  readonly mount: ReturnType<typeof createRacoonsMount>;
  readonly llmCalls: DshLlmStreamOptions[];
}

function harness(options: {
  readonly body?: string;
  readonly entryAsk?: boolean;
  readonly orphanAsk?: boolean;
  readonly armThrowOnStream?: () => void;
  readonly ledger?: { readonly fail: boolean };
  readonly answer?: string;
} = {}): Harness {
  const session = fakeSession(SESSION);
  // A result on the surface BEFORE the mount exists: the only way a mount sees
  // a landing it never observed, i.e. the resumed shape recovery exists for.
  step(session, options.body ?? oversizedBody(40 * 1024));
  session.append('turn/end', { turn: 1 });
  if (options.orphanAsk === true) {
    // An ask exchange a previous process appended and never collapsed: the two
    // `user/message` turns recovery's collapse scan looks for.
    for (const id of ['orphan-ask', 'orphan-answer']) {
      session.append('user/message', { content: [text(id)],
        source: { kind: 'racoons/negation/entry-ask' }, role: 'user', id },
      { surfaceOp: 'append' });
    }
  }
  const journal: JournalLine[] = [];
  const llmCalls: DshLlmStreamOptions[] = [];
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ floorBytes: 16, barBytes: 8192,
      ...(options.entryAsk === true ? { entryAskTrigger: { mode: 'count' } } : {}) }),
    storage: resolveStorage(undefined),
    journal: (record: RacoonsJournalRecord) => journal.push(record),
    judgeRoute: ROUTE,
    ...(options.ledger === undefined ? {} : { openLedger: async () => options.ledger as never }),
    llm: {
      stream(request: DshLlmStreamOptions) {
        llmCalls.push(request);
        options.armThrowOnStream?.();
        return (async function* emit() {
          for (const chunk of answerChunks(options.answer ?? '{"1":{"keepall":true}}')) yield chunk;
        })();
      },
    } as never,
  });
  session.on((live, event) => { mount.observe(live, event); });
  mount.observeWire({ sessionId: SESSION, provider: ROUTE.provider, model: ROUTE.model,
    ...MAIN_WIRE });
  return { session, journal, mount, llmCalls };
}

test('a throw in the surface read is named and the next boundary finishes recovery', async () => {
  const h = harness();
  try {
    // `turn/start` is a log row the collapse scan never reads (it walks surface
    // nodes), but `surfaceTranscript` does: the throw lands in `surface-read`.
    const turnStart = h.session.log.find(event => event.type === 'turn/start');
    assert.notEqual(turnStart, undefined, 'the fixture has an off-surface row');
    h.session.throwAtSeq = turnStart?.seq ?? null;

    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const retry = lines(h.journal, 'entry-recovery-retry');
    assert.equal(retry.length, 1, 'the failed leg is journaled by name');
    assert.equal(retry[0]?.['step'], 'surface-read', 'the line names the leg');
    assert.equal(lines(h.journal, 'entry-resume-recovered').length, 0,
      'an unfinished recovery does not claim to have recovered');

    // The latch still owes recovery: the very next boundary finishes it.
    await h.mount.runStep(h.session, { turn: 1, step: 3 });
    const recovered = lines(h.journal, 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'the next boundary recovered');
    assert.equal(recovered[0]?.['redelivered'], 1, 'the surface landing was re-queued');
  } finally {
    await h.mount.close();
  }
});

test('an apply that throws still collapses the ask exchange', async () => {
  const h = harness({ entryAsk: true,
    // The model seam runs immediately before the apply; arming the one-shot
    // `seq` throw here makes `applyEntryAnswer` (its first reader) throw.
    armThrowOnStream: () => { h.session.throwSeqOnce = true; } });
  try {
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const refused = lines(h.journal, 'entry-apply-refused');
    assert.equal(refused.length, 1, 'the throwing apply is journaled by name');
    assert.equal(refused[0]?.['code'], 'apply-threw', 'the line names the throw');
    const collapsed = lines(h.journal, 'entry-ask-collapsed');
    assert.equal(collapsed.length, 1, 'the exchange was still collapsed');
    assert.notEqual(collapsed[0]?.['status'], 'refused', 'the collapse wrote the surface');
  } finally {
    await h.mount.close();
  }
});

test('ISSUE-463: an unknown collapse keeps the exchange owed and retries next boundary',
  async () => {
    const h = harness({ orphanAsk: true });
    try {
      assert.equal(holdsOrphanAsk(h.session), true, 'the fixture starts with an orphan');
      // The one replace the collapse makes throws: the port answers `unknown`,
      // which is not proof the range left the surface.
      h.session.throwReplaceOnce = true;
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      const retry = lines(h.journal, 'entry-recovery-retry')
        .filter(line => line['step'] === 'collapse');
      assert.equal(retry.length, 1, 'the unknown collapse names its retry');
      assert.equal(retry[0]?.['reason'], 'collapse-unknown', 'and the host uncertainty');
      assert.equal(lines(h.journal, 'entry-resume-recovered').length, 0,
        'an unknown collapse never claims recovery');
      assert.equal(holdsOrphanAsk(h.session), true, 'the exchange stays on the surface');

      // The same mount, next boundary: the latch still owes the exchange.
      await h.mount.runStep(h.session, { turn: 1, step: 3 });
      const recovered = lines(h.journal, 'entry-resume-recovered');
      assert.equal(recovered.length, 1, 'the next boundary recovered it');
      assert.equal(recovered[0]?.['collapsed'], 1, 'one applied collapse counted');
      assert.equal(holdsOrphanAsk(h.session), false, 'the pair left the surface');
    } finally {
      await h.mount.close();
    }
  });

test('a remounted port resolves an applied receipt from its durable source', async () => {
  // The exact row a previous process minted at the host write. Without the
  // durable seed the remount answers unknown and the prepared ledger row blocks
  // every later pass; with it, recovery can settle the row instead (ISSUE-417).
  const receipt = { intentId: 'intent-crash-1', sessionId: SESSION, baseRevision: '0:1',
    resultRevision: '0:2', applicationSha256: 'a'.repeat(64), appliedAtMs: 1 };
  const clock = { nowMs: () => 0 };
  const cold = createDshPort({ sessionId: SESSION, clock });
  assert.deepEqual(await cold.lookupReceipt('intent-crash-1' as never), { status: 'unknown' },
    'a port with no durable source cannot answer for the intent');
  const remounted = createDshPort({ sessionId: SESSION, clock, receipts: [receipt as never] });
  const lookup = await remounted.lookupReceipt('intent-crash-1' as never);
  assert.equal(lookup.status, 'applied', 'the durable receipt resolves the prepared row');
  assert.equal(lookup.status === 'applied' ? lookup.receipt.intentId : null, 'intent-crash-1');
});

test('a refused kept-mark read is journaled by name and recovery still completes', async () => {
  const ledger = { fail: true };
  const h = harness({ ledger });
  try {
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const markError = lines(h.journal, 'entry-recovery-mark-error');
    assert.equal(markError.length, 1, 'the kept-mark read failure is named');
    assert.equal(typeof markError[0]?.['message'], 'string', 'the line carries the reason');
    const recovered = lines(h.journal, 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'the surface recovery still completed');
    assert.equal(recovered[0]?.['redelivered'], 1, 'the surface landing was re-queued');
  } finally {
    await h.mount.close();
  }
});
