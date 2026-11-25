/**
 * The restart proof (ISSUE-004 chunk 3, ADR-0013): a bulk-prune removal applied
 * through the shipped plugin mount, the mount closed, and a second mount opened
 * on the same storage root — a new process resuming the same session — recalls
 * the exact original bytes by id.
 *
 * The driver is the bulk prune (ADR-0028 leaves the entry checkpoint and the
 * prune as the only two ask moments): a fake LLM answers the pass's table with
 * one `forgetall`, the engine applies the checkpoint-revert, and the ledger
 * mints the recall id. The cap is off the product path (ADR-0014), so a cap
 * would be vacuous here; the subject is the durable removal, not its rule.
 *
 * Both mounts are the real plugin and the real engine/adapter/ledger, with the
 * fake session `plugin.test.ts` also drives a removal through: a restart changes
 * the storage hand, not the host. The recall goes through the tool the plugin
 * registers after the reopen, which is the path a model takes on a resume.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LedgerError, PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT,
  PRUNE_ASK_JSONL_20_SLOT, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT } from '@cremator/core';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountContext, DshMountEvent, DshMountSession,
  RacoonsJournalRecord, RacoonsPluginConfig,
} from '../src/plugin.js';
import { createRacoonsPlugin, resolveSessionStorage } from '../src/plugin.js';
import { readTableAskFired } from '../src/prune-round-store.js';
import { PRUNE_COMMAND } from '../src/prune.js';

const ROUTE = { provider: 'p', model: 'm' };
/**
 * The one table answer the pass gets: the first row is removed whole. One JSON
 * object per line, the shape the shipped `jsonl-20-nokeepall` ask teaches.
 */
const FORGET = '{"1":{"forgetall":true,"summary":"oversized read"}}';
/**
 * A literal `keepall` on the depth table: the shipped grammar does not offer
 * that action, so the row is a terminal `action-not-in-grammar` refusal — the
 * unit keeps and nothing is applied.
 */
const KEEP = '{"1":{"keepall":true}}';

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A scripted model seam: reply N is the Nth answer, the last answer repeats. */
function fakeLlm(answers: readonly string[]): FakeLlm {
  let index = 0;
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const answer = answers[Math.min(index, answers.length - 1)] ?? '';
      index += 1;
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: answer.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: answer.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}
interface JournalLine { readonly kind: string; readonly [field: string]: unknown }
interface RegisteredTool { readonly name: string; execute(args: unknown): Promise<unknown> }

/** The minimal fake dsh session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  return {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
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
      for (const listener of listeners) listener(this, event);
      return event;
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });

/** One scripted step with an oversized result, the shape a real dsh run produces. */
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

// `tag` keeps two bodies in one session from nesting: identical filler makes the
// shorter body a substring of the longer one, and the retention rules then keep
// it (ISSUE-519). Each body a test needs removed names its own character.
function oversizedBody(bytes: number, tag = 'x'): string {
  const line = tag.repeat(63);
  return `${`${line}\n`.repeat(Math.ceil(bytes / (line.length + 1)))}`.slice(0, bytes);
}

/**
 * One plugin mount on a storage root. Nothing is durable until `apply`, which is
 * what a host process does on load; `close` runs the effect the plugin
 * registered, which is the host's own teardown path.
 *
 * `wire` dispatches the `llm/stream` observer main's outgoing request reaches:
 * it is the prune's only seed (ADR-0010), and a pass with no seed asks nothing.
 */
function fakeMount(root: string, journal: JournalLine[],
  answers: readonly string[] = [FORGET], config: RacoonsPluginConfig = {}): {
  readonly listeners: Map<string, (...args: never[]) => unknown>;
  readonly tools: RegisteredTool[];
  readonly llm: FakeLlm;
  wire(sessionId: string): void;
  apply(): Promise<void>;
  close(): Promise<void>;
} {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const tools: RegisteredTool[] = [];
  const cleanups: (() => unknown)[] = [];
  const llm = fakeLlm(answers);
  const ctx: DshMountContext = {
    logger: { warn: () => {} },
    tools: { register: (tool: unknown) => { tools.push(tool as RegisteredTool); return () => {}; } } as never,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    llm,
  };
  const plugin = createRacoonsPlugin({ journal: (record: RacoonsJournalRecord) => journal.push(record),
    judgeRoute: ROUTE,
    // The entry checkpoint's ask is its own seam (ISSUE-058 chunk P3c-2): by
    // default this test isolates the prune/storage lane, so the floor sits
    // above every fixture body and no entry ask competes for the answers.
    config: { crematorStorageRoot: root, floorBytes: 1 << 20,
      barBytes: 64, contextWindowTokens: 200_000, ...config } });
  return { listeners, tools, llm,
    wire: (sessionId) => { dispatchWire(listeners, sessionId); },
    apply: async () => { await plugin.apply(ctx, {}); },
    close: async () => {
      for (const fn of [...cleanups].reverse()) await fn();
      cleanups.length = 0;
    } };
}

/** Main's last dispatched request, as the host's `llm/stream` waterfall hands it over. */
function dispatchWire(
  listeners: Map<string, (...args: never[]) => unknown>, sessionId: string,
): void {
  const listener = listeners.get('llm/stream') as
    ((options: unknown, next: () => unknown) => unknown) | undefined;
  assert.ok(listener !== undefined, 'the mount installed its llm/stream observer');
  listener({
    sessionId, provider: ROUTE.provider, model: ROUTE.model,
    system: 'MAIN SYSTEM PROMPT',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }],
  }, () => (async function* empty() {})());
}

/** The one applied prune the mount ran, or undefined. */
function appliedPrune(journal: JournalLine[]): JournalLine | undefined {
  return journal.find((line) => line.kind === 'prune-apply' && line['status'] === 'applied');
}

/** Queue one prune pass at the next pre-step, as the `/cremate` command does. */
function requestPrune(session: FakeSession): void {
  session.append('user/message', { content: [text(PRUNE_COMMAND)],
    source: { kind: 'user' }, role: 'user', id: 'user-prune' }, { surfaceOp: 'append' });
}

/** The applied prune lines the mount journaled, in order. */
function appliedPrunes(journal: JournalLine[]): JournalLine[] {
  return journal.filter((line) => line.kind === 'prune-apply' && line['status'] === 'applied');
}

/** The recall id a `[not retained]` receipt line names. */
function receiptRecallId(text: string): string | undefined {
  return /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(text)?.[1];
}

/** Dispatch one `agent/pre-step` through the hook the mount installed. */
async function preStep(
  listeners: Map<string, (...args: never[]) => unknown>, session: DshMountSession,
): Promise<void> {
  const listener = listeners.get('agent/pre-step') as
    ((payload: unknown, next: () => unknown) => Promise<unknown>) | undefined;
  assert.ok(listener !== undefined, 'the mount installed its pre-step hook');
  await listener({ agent: { session }, messages: [], turn: 1, step: 1, signal: {} },
    async () => ({ kind: 'enter', messages: [] }));
}

/** Wire a session to one mount's `session/event` hook, as the host does. */
function attach(mount: ReturnType<typeof fakeMount>, session: FakeSession): void {
  session.on((s, event) => {
    const listener = mount.listeners.get('session/event');
    if (listener !== undefined) (listener as (session: FakeSession, event: DshMountEvent) => void)(s, event);
  });
}

/** The live tool/result texts on a fake session's surface. */
function surfaceTexts(session: FakeSession): string[] {
  return (session.surface?.nodes ?? []).map((seq) => session.eventAt?.(seq))
    .filter((event) => event?.type === 'tool/result')
    .map((event) => (event?.data as { message: { content: { text: string }[] } })
      .message.content[0]?.text ?? '');
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

test('a prune removal through the mount restores its exact bytes after a reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const first = fakeMount(root, journal1);
  const second = fakeMount(root, journal2);
  try {
    // 1. Mount on the temp root: the durable per-session plan, no ':memory:'.
    await first.apply();
    const mounted1 = journal1.find((line) => line.kind === 'mounted');
    assert.equal(mounted1?.['ledgerSource'], 'durable');
    const target = resolveSessionStorage(root, 'session-restart');
    assert.equal(target.databasePath, join(root, 'sessions', 'session-restart', 'ledger.sqlite'));
    // The mount line names the root; the effective plan is its own line.
    assert.equal(mounted1?.['storageRoot'], root);
    assert.equal(mounted1?.['storage'], undefined,
      'the mount line carries no unrefined <sessionId> path');

    // 2. Drive one prune removal through the mount: the `/cremate` command makes
    //    the next pre-step run a pass, the fake LLM answers its table with one
    //    forgetall, the engine applies it, and the receipt line names the minted
    //    recall id. The entry floor sits above the body, so only the pass asks.
    const body = oversizedBody(40 * 1024);
    const originalBytes = new TextEncoder().encode(body);
    const session = fakeSession('session-restart');
    attach(first, session);
    step(session, body);
    // The pass reads a completed turn: an in-flight turn protects its own nodes.
    session.append('turn/end', { turn: 1 });
    first.wire('session-restart');
    session.append('user/message', { content: [text(PRUNE_COMMAND)],
      source: { kind: 'user' }, role: 'user', id: 'user-prune' }, { surfaceOp: 'append' });
    await preStep(first.listeners, session);
    const surface = (session.surface?.nodes ?? []).map((seq) => session.eventAt?.(seq))
      .filter((event) => event?.type === 'tool/result');
    assert.equal(surface.length, 1, 'one tool result stays on the surface');
    const removedText = (surface[0]?.data as { message: { content: { text: string }[] } })
      .message.content[0]?.text ?? '';
    assert.match(removedText, /\[not retained\] /u, 'the receipt line replaced the unit');
    const recallId = receiptRecallId(removedText);
    assert.ok(recallId !== undefined, 'the receipt line names a minted recall id');
    const settled = appliedPrune(journal1);
    assert.ok(settled !== undefined, 'the prune applied through the durable ledger');
    assert.equal(typeof settled['intentId'], 'string', 'the applied prune names its intent');

    // 3. Close the mount cleanly.
    await first.close();

    // 4. The row, the file and the body survive the close, with no handle open.
    assert.ok(existsSync(target.databasePath), 'the per-session sqlite file exists');
    assert.ok(statSync(target.databasePath).size > 0, 'the sqlite file is non-empty');
    const sourceSha256 = createHash('sha256').update(originalBytes).digest('hex');
    const blobPath = join(target.blobRoot, 'sha256', sourceSha256.slice(0, 2), sourceSha256.slice(2));
    assert.ok(existsSync(blobPath), 'the original body is a blob on disk');
    assert.deepEqual(new Uint8Array(readFileSync(blobPath)), originalBytes,
      'the blob holds the exact original bytes');
    const inspection = new DatabaseSync(target.databasePath);
    try {
      assert.equal(Number(inspection.prepare('SELECT count(*) AS n FROM recalls WHERE recall_id = ?')
        .get(recallId)?.['n']), 1, 'the recall row survives in the sqlite file');
      assert.ok(Number(inspection.prepare('SELECT count(*) AS n FROM ledger_events')
        .get()?.['n']) > 0, 'the ledger history survives');
    } finally { inspection.close(); }

    // 5. A second mount on the same storage paths: a new process resuming.
    await second.apply();
    const mounted2 = journal2.find((line) => line.kind === 'mounted');
    assert.equal(mounted2?.['ledgerSource'], 'durable', 'the reopened mount journals durable');
    assert.equal(mounted2?.['storageRoot'], mounted1?.['storageRoot'],
      'the same root is reopened');
    const resumed = fakeSession('session-restart');
    attach(second, resumed);
    // Opening the session reopens its ledger; one plain turn gives the resumed
    // transcript content of its own. A resumed transcript's calls are new nodes:
    // reusing the pre-restart call id would name the event the ledger already
    // records as applied.
    step(resumed, 'small result', 'r1');
    await preStep(second.listeners, resumed);
    assert.ok((resumed.seq ?? 0) > 0, 'the resumed transcript has content');
    const plan = journal2.find((line) => line.kind === 'storage-plan');
    assert.equal(plan?.['databasePath'], target.databasePath,
      'the reopened session refines to the same ledger path');
    const recallTool = second.tools.find((tool) => tool.name === 'necromancy');
    assert.ok(recallTool !== undefined, 'the reopened mount registered necromancy');
    // The host contract: a tool value must be lossless JSON, so the handler
    // returns the projected output, not the ledger record's `Uint8Array` parts.
    const record = await recallTool.execute({ id: recallId }) as {
      recallId: string; text: string | null; byteLength: number;
      parts: { nodeId: string; byteLength: number; sha256: string; text: string }[];
    };
    assert.equal(record.recallId, recallId);
    assert.equal(record.parts.length, 1);
    assert.equal(record.parts[0]?.byteLength, originalBytes.length);
    assert.equal(record.parts[0]?.sha256, sourceSha256,
      'the recall names the exact source body hash');
    assert.equal(record.text, new TextDecoder().decode(originalBytes),
      'recall after the reopen returns the exact original bytes');
    assert.equal(record.byteLength, originalBytes.length);

    // 6. Negative control: an id this ledger never minted is a typed refusal,
    //    and the resumed transcript is untouched by it.
    const seqBefore = resumed.seq;
    await assert.rejects(() => recallTool.execute({ id: `recall:sha256:${'f'.repeat(64)}` }),
      (error: unknown) => error instanceof LedgerError && error.code === 'not-found');
    await assert.rejects(() => recallTool.execute({ id: 'not-a-recall-id' }),
      (error: unknown) => error instanceof LedgerError && error.code === 'not-found');
    assert.equal(resumed.seq, seqBefore, 'a refused recall appends no event');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});

/** The text the ask seam actually sent (the last message's text blocks). */
function promptText(options: DshLlmStreamOptions): string {
  const last = options.messages[options.messages.length - 1] as {
    readonly content?: readonly { readonly text?: string }[];
  } | undefined;
  return (last?.content ?? []).map(block => block.text ?? '').join('');
}

const FIRST_PREFIX = PRUNE_ASK_JSONL_20_SYSTEM_PROMPT
  .slice(0, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
const LATER_PREFIX = PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT
  .slice(0, PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));

test('the first-ask share line is not repeated after a restart (ISSUE-406)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-first-ask-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const config: RacoonsPluginConfig = { floorBytes: 512, barBytes: 8192,
    entryAskTrigger: { mode: 'count' }, entryAskGrammar: 'jsonl-20' };
  const first = fakeMount(root, journal1, [KEEP], config);
  const second = fakeMount(root, journal2, [KEEP], config);
  try {
    // 1. A genuinely first ask states the 70 percent share line.
    await first.apply();
    const session = fakeSession('session-restart-first-ask');
    attach(first, session);
    first.wire(session.id);
    step(session, oversizedBody(2_000), 'c1');
    await preStep(first.listeners, session);
    assert.equal(first.llm.calls.length, 1, 'the first ask left the seam');
    assert.equal(promptText(first.llm.calls[0] as DshLlmStreamOptions)
      .slice(0, FIRST_PREFIX.length), FIRST_PREFIX,
    'the first ask states the first-ask share line');
    await first.close();

    // 2. The restart: a fresh mount and surface over the SAME durable state.
    //    New call ids, because the ledger already records the old event applied.
    await second.apply();
    const resumed = fakeSession('session-restart-first-ask');
    attach(second, resumed);
    second.wire(resumed.id);
    step(resumed, oversizedBody(2_000), 'r1');
    await preStep(second.listeners, resumed);
    assert.equal(second.llm.calls.length, 1, 'the resumed ask left the seam');
    assert.equal(promptText(second.llm.calls[0] as DshLlmStreamOptions)
      .slice(0, LATER_PREFIX.length), LATER_PREFIX,
    'the resumed ask states the later share line, not the first-ask one');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});

test('the depth table keeps its first-ask share line across a restart (ISSUE-508)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-table-ask-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  // The shipped default grammar (`nokeepall`): the table IS the entry three-piece
  // message, so the first table ask states 70 percent and every later one 40.
  const first = fakeMount(root, journal1, [KEEP]);
  const second = fakeMount(root, journal2, [KEEP]);
  try {
    // 1. A genuinely first table ask states the 70 percent share line.
    await first.apply();
    const session = fakeSession('session-restart-table-ask');
    attach(first, session);
    step(session, oversizedBody(8_000), 'c1');
    session.append('turn/end', { turn: 1 });
    first.wire(session.id);
    requestPrune(session);
    await preStep(first.listeners, session);
    assert.equal(first.llm.calls.length, 1, 'the first table ask left the seam');
    assert.ok(promptText(first.llm.calls[0] as DshLlmStreamOptions)
      .includes('keep at most 70 percent'), 'the first table ask states 70');
    // The flag landed on the per-session store beside the round.
    const target = resolveSessionStorage(root, 'session-restart-table-ask');
    assert.equal(readTableAskFired(target), true, 'the table-ask flag is persisted');
    await first.close();

    // 2. The restart: a fresh mount and surface over the SAME durable state.
    await second.apply();
    const resumed = fakeSession('session-restart-table-ask');
    attach(second, resumed);
    step(resumed, oversizedBody(8_000), 'r1');
    resumed.append('turn/end', { turn: 1 });
    second.wire(resumed.id);
    requestPrune(resumed);
    await preStep(second.listeners, resumed);
    assert.equal(second.llm.calls.length, 1, 'the resumed table ask left the seam');
    const later = promptText(second.llm.calls[0] as DshLlmStreamOptions);
    assert.ok(later.includes('keep at most 40 percent'),
      'the restart\'s first table ask states the later share');
    assert.equal(later.includes('keep at most 70 percent'), false);
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});

test('the first-table-ask flag is per session, never shared (ISSUE-508 F7)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-table-ask-sessions-'));
  const root = join(dir, 'racoons');
  const journal: JournalLine[] = [];
  const KEEP_TWO = '{"1":{"keepall":true}}\n{"2":{"keepall":true}}';
  // Call order: session A's first pass, session B's first pass, session A's second.
  const mount = fakeMount(root, journal, [KEEP, KEEP, KEEP_TWO]);
  try {
    await mount.apply();
    const sessionA = fakeSession('session-table-ask-a');
    const sessionB = fakeSession('session-table-ask-b');
    attach(mount, sessionA);
    attach(mount, sessionB);
    const runOnePass = async (session: FakeSession, callId: string): Promise<string> => {
      const before = mount.llm.calls.length;
      step(session, oversizedBody(8_000), callId);
      session.append('turn/end', { turn: 1 });
      mount.wire(session.id);
      requestPrune(session);
      await preStep(mount.listeners, session);
      assert.equal(mount.llm.calls.length, before + 1, `${session.id}: one table ask left`);
      return promptText(mount.llm.calls[before] as DshLlmStreamOptions);
    };

    const firstA = await runOnePass(sessionA, 'a1');
    assert.ok(firstA.includes('keep at most 70 percent'), 'session A states 70 first');

    // A second session on the same mount and root: its own first ask is still 70.
    const firstB = await runOnePass(sessionB, 'b1');
    assert.ok(firstB.includes('keep at most 70 percent'),
      'session B states 70, not the 40 that session A has earned');
    assert.equal(firstB.includes('keep at most 40 percent'), false);

    // A's next pass states 40: its own flag moved, B's did not.
    const laterA = await runOnePass(sessionA, 'a2');
    assert.ok(laterA.includes('keep at most 40 percent'), 'session A now states 40');

    const targetA = resolveSessionStorage(root, 'session-table-ask-a');
    const targetB = resolveSessionStorage(root, 'session-table-ask-b');
    assert.equal(readTableAskFired(targetA), true);
    assert.equal(readTableAskFired(targetB), true);
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

test('removal applies after restart — ledger is record of record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-removal-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  // Pass 1 keeps the first result; pass 2 removes the second and keeps the
  // first again (the prune asks every candidate on every pass).
  const first = fakeMount(root, journal1, [KEEP,
    '{"1":{"keepall":true}}\n{"2":{"forgetall":true,"summary":"oversized read"}}']);
  const second = fakeMount(root, journal2);
  const target = resolveSessionStorage(root, 'session-restart-removal');
  try {
    // 1. Run a keep-all pass, then a removing pass, through the first mount.
    await first.apply();
    const kept = oversizedBody(16 * 1024, 'k');
    const original = oversizedBody(40 * 1024, 'o');
    const session = fakeSession('session-restart-removal');
    attach(first, session);
    step(session, kept, 'k1');
    session.append('turn/end', { turn: 1 });
    first.wire('session-restart-removal');
    requestPrune(session);
    await preStep(first.listeners, session);
    assert.equal(surfaceTexts(session).length, 1, 'the kept unit stays on the surface');
    assert.equal(appliedPrunes(journal1).length, 0, 'a keep-all pass applies nothing');
    // The second pass is the removal: this intent is the one the restart must
    // reconcile.
    step(session, original, 'c1');
    session.append('turn/end', { turn: 1 });
    requestPrune(session);
    await preStep(first.listeners, session);
    const firstTexts = surfaceTexts(session);
    assert.equal(firstTexts.length, 2, 'the kept unit and the receipt line');
    const firstRecallId = receiptRecallId(firstTexts[1] ?? '');
    assert.ok(firstRecallId !== undefined, 'the first mount minted a recall id');
    const firstIntent = appliedPrunes(journal1)[0]?.['intentId'];
    assert.equal(typeof firstIntent, 'string', 'the first removal names its intent');
    await first.close();

    // 2. Remount on the same paths: a new process resuming the same session.
    await second.apply();
    const resumed = fakeSession('session-restart-removal');
    attach(second, resumed);
    const fresh = oversizedBody(32 * 1024, 'f');
    // A resumed transcript's calls are new nodes: reusing the pre-restart call
    // id would name the event the ledger already records as applied.
    step(resumed, fresh, 'r1');
    resumed.append('turn/end', { turn: 1 });
    second.wire('session-restart-removal');
    requestPrune(resumed);
    await preStep(second.listeners, resumed);

    // 3. The removal APPLIES: receipt line on the surface, a fresh receipt in
    //    the durable ledger, and a minted recall id (ADR-0015, ISSUE-030 R5).
    const texts = surfaceTexts(resumed);
    assert.equal(texts.length, 1, 'one tool result stays on the surface');
    assert.match(texts[0] ?? '', /\[not retained\] /u,
      'the new removal applies after the restart');
    const recallId = receiptRecallId(texts[0] ?? '');
    assert.ok(recallId !== undefined, 'the post-restart removal minted a recall id');
    assert.notEqual(recallId, firstRecallId, 'the post-restart removal is its own');
    const settled = appliedPrunes(journal2);
    assert.equal(settled.length, 1, 'exactly one removal was applied after the restart');
    const intentId = settled[0]?.['intentId'];
    assert.equal(typeof intentId, 'string');
    assert.notEqual(intentId, firstIntent, 'the fresh removal has a fresh intent');
    assert.equal(journal2.filter((line) => line.kind === 'prune-error').length, 0,
      'nothing was refused by name');
    assert.ok(journal2.filter((line) => line.kind === 'at-rest')
      .every((line) => line['status'] !== 'recovery-pending'),
    'no at-rest pass after the restart is recovery-pending');

    // 4. The receipt is durable: the ledger holds an `applied` event for the
    //    new intent next to the pre-restart one.
    const inspection = new DatabaseSync(target.databasePath);
    try {
      const applied = (id: unknown): number => Number(inspection.prepare(
        "SELECT count(*) AS n FROM ledger_events WHERE intent_id = ? AND kind = 'applied'")
        .get(id as string)?.['n']);
      assert.equal(applied(firstIntent), 1, 'the pre-restart receipt survives');
      assert.equal(applied(intentId), 1, 'the post-restart receipt is in the durable ledger');
    } finally { inspection.close(); }

    // 5. Both removals stay recallable by their own ids.
    const recallTool = second.tools.find((tool) => tool.name === 'necromancy');
    assert.ok(recallTool !== undefined, 'the reopened mount registered necromancy');
    assert.equal((await recallTool.execute({ id: firstRecallId }) as { text: string | null }).text,
      original, 'recall of the pre-restart id returns the exact bytes');
    assert.equal((await recallTool.execute({ id: recallId }) as { text: string | null }).text,
      fresh, 'recall of the post-restart id returns the exact bytes');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});
