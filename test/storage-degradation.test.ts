/**
 * Storage degradation (ISSUE-004 chunk 4, ADR-0013 ruling 4) and the restart
 * semantics ADR-0015 rules (ISSUE-030).
 *
 * Part 1: a durable ledger that cannot open is retried at the next step
 * boundary (critic fix P2#4). The first failure journals `storage-retry`, warns,
 * and skips that boundary; only when the retry also fails does the mount install
 * the refusing ledger and journal `storage-unavailable` once. A retry that
 * succeeds journals `storage-recovered` and the mount is fully live.
 *
 * Part 2: after a clean close and remount on chunk 3's durable layout, the
 * fresh port answers `unknown` for the pre-restart intent — and the ledger's
 * `applied` receipt is the record of record, so `committedState` commits from
 * the ledger and new removals APPLY (ADR-0015). A host that positively answers
 * `not-applied` is the only contradicting party: it blocks and journals a
 * `receipt-conflict` (the conflict variant below).
 *
 * The removal driver is the bulk prune (ADR-0028 leaves the entry checkpoint
 * and the prune as the only two ask moments): the `/cremate` command makes the
 * next pre-step run a pass, a fake LLM answers its table with one `forgetall`,
 * the engine applies the checkpoint-revert, and the ledger mints the recall id.
 * The cap is off the product path (ADR-0014), so a cap would be vacuous here;
 * the subject is storage and restart, not the rule.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountContext, DshMountEvent, DshMountSession,
  RacoonsJournalRecord,
} from '../src/plugin.js';
import { createRacoonsMount, createRacoonsPlugin, resolvePluginConfig,
  resolveSessionStorage } from '../src/plugin.js';
import { readDurableReceipts } from '../src/mount-state.js';
import { RacoonsStorageRetryError, resolveStorage } from '../src/storage.js';
import { PRUNE_COMMAND } from '../src/prune.js';

const ROUTE = { provider: 'p', model: 'm' };
/** The one table answer the pass gets: the first row is removed whole. */
const FORGET = '{"1":{"forgetall":true,"summary":"oversized read"}}';

interface FakeLlm {
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A scripted model seam: reply N is the Nth answer, the last answer repeats. */
function fakeLlm(answers: readonly string[]): FakeLlm {
  let calls = 0;
  return {
    stream(options) {
      void options;
      const answer = answers[Math.min(calls, answers.length - 1)] ?? '';
      calls += 1;
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

function oversizedBody(bytes: number): string {
  const line = 'x'.repeat(63);
  return `${`${line}\n`.repeat(Math.ceil(bytes / (line.length + 1)))}`.slice(0, bytes);
}

/**
 * One plugin mount on a storage root; `close` runs the effect the plugin
 * registered. `wire` dispatches the `llm/stream` observer main's request reaches:
 * it is the prune's only seed (ADR-0010), and a pass with no seed asks nothing.
 */
function fakeMount(root: string, journal: JournalLine[], warns: string[] = [],
  answers: readonly string[] = [FORGET]): {
  readonly listeners: Map<string, (...args: never[]) => unknown>;
  readonly tools: RegisteredTool[];
  wire(sessionId: string): void;
  apply(): Promise<void>;
  close(): Promise<void>;
} {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const tools: RegisteredTool[] = [];
  const cleanups: (() => unknown)[] = [];
  const ctx: DshMountContext = {
    logger: { warn: (message: string) => { warns.push(message); } },
    tools: { register: (tool: unknown) => { tools.push(tool as RegisteredTool); return () => {}; } } as never,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    llm: fakeLlm(answers),
  };
  const plugin = createRacoonsPlugin({ journal: (record: RacoonsJournalRecord) => journal.push(record),
    judgeRoute: ROUTE,
    // The entry checkpoint's ask is its own seam (ISSUE-058 chunk P3c-2): this
    // test isolates storage degradation and the prune lane, so the floor sits
    // above every fixture body and no entry ask competes for the answers.
    config: { crematorStorageRoot: root, floorBytes: 1 << 20,
      barBytes: 64, contextWindowTokens: 200_000 } });
  return { listeners, tools,
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

/** The applied prune lines the mount journaled, in order. */
function appliedPrunes(journal: JournalLine[]): JournalLine[] {
  return journal.filter((line) => line.kind === 'prune-apply' && line['status'] === 'applied');
}

/** The recall id a `[not retained]` receipt line names. */
function receiptRecallId(text: string): string | undefined {
  return /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(text)?.[1];
}

/** A mount on the test-only in-memory pair. */
function memoryMount(journal: JournalLine[], answers: readonly string[] = [FORGET]):
ReturnType<typeof fakeMount> {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const tools: RegisteredTool[] = [];
  const cleanups: (() => unknown)[] = [];
  const ctx: DshMountContext = {
    logger: { warn: () => {} },
    tools: { register: (tool: unknown) => { tools.push(tool as RegisteredTool); return () => {}; } } as never,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    llm: fakeLlm(answers),
  };
  const plugin = createRacoonsPlugin({ journal: (record: RacoonsJournalRecord) => journal.push(record),
    judgeRoute: ROUTE,
    config: { barBytes: 64, contextWindowTokens: 200_000 },
    storage: { databasePath: ':memory:' } });
  return { listeners, tools,
    wire: (sessionId) => { dispatchWire(listeners, sessionId); },
    apply: async () => { await plugin.apply(ctx, {}); },
    close: async () => {
      for (const fn of [...cleanups].reverse()) await fn();
      cleanups.length = 0;
    } };
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





/** The `receipt-conflict` telemetry the mount journaled, in order. */
function conflicts(journal: JournalLine[]): { intentId: string | undefined; host: string | undefined }[] {
  return journal.flatMap((line) => {
    const event = line['event'] as { kind?: string; intentId?: string; host?: string } | undefined;
    return line.kind === 'telemetry' && event?.kind === 'receipt-conflict'
      ? [{ intentId: event.intentId, host: event.host }] : [];
  });
}

test('an unopenable durable ledger: retry once at the next boundary, then refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-refusing-'));
  // A FILE where the storage root expects a directory: mkdir fails, and the
  // ledger cannot open on any OS.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const root = join(blocker, 'racoons');
  const expectedPath = join(root, 'sessions', 'session-refusing', 'ledger.sqlite');
  const journal: JournalLine[] = [];
  const warns: string[] = [];
  const mount = fakeMount(root, journal, warns);
  try {
    await mount.apply();
    const session = fakeSession('session-refusing');
    attach(mount, session);
    const body = oversizedBody(40 * 1024);
    step(session, body, 'c1');
    const eventsBefore = session.seq ?? 0;
    // The first boundary fails to open: it warns, journals `storage-retry`, and
    // is skipped. Nothing reaches the engine or the transcript yet.
    await preStep(mount.listeners, session);
    assert.equal(session.seq, eventsBefore, 'the retrying boundary appended nothing');
    assert.deepEqual(surfaceTexts(session), [body], 'the oversized result keeps every byte');
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 0,
      'the first failure is a retry, not a refusal');
    assert.equal(journal.filter((line) => line.kind === 'at-rest').length, 0,
      'the skipped boundary ran no engine pass');
    const retry = journal.find((line) => line.kind === 'storage-retry');
    assert.equal(retry?.['attempt'], 1);
    assert.equal(retry?.['attempts'], 2);
    assert.equal(retry?.['code'], 'durable-open-failed');
    assert.equal(retry?.['path'], expectedPath, 'the retry line names the unopenable path');
    assert.equal(retry?.['sessionId'], 'session-refusing');
    assert.equal(retry?.['node'], process.version, 'the runtime is recorded in the mount');
    assert.equal(warns.length, 1, 'the retry warns through the host logger');
    assert.match(warns[0] ?? '', /retrying at the next step boundary/u);

    // A second step in the same session: the retry also fails, so the mount
    // installs the refusing ledger and journals `storage-unavailable` once.
    step(session, oversizedBody(24 * 1024), 'c2');
    const secondBefore = session.seq ?? 0;
    await preStep(mount.listeners, session);
    assert.equal(session.seq, secondBefore, 'no removal across the retried step');
    assert.deepEqual(surfaceTexts(session), [body, oversizedBody(24 * 1024)],
      'both results stay uncut on the surface');

    const unavailable = journal.filter((line) => line.kind === 'storage-unavailable');
    assert.equal(unavailable.length, 1, 'storage-unavailable is journaled exactly once');
    assert.equal(unavailable[0]?.['code'], 'durable-open-failed');
    assert.equal(unavailable[0]?.['path'], expectedPath, 'the line names the unopenable path');
    assert.equal(unavailable[0]?.['sessionId'], 'session-refusing');
    assert.equal(unavailable[0]?.['node'], process.version, 'the runtime is recorded in the mount');
    assert.equal(journal.filter((line) => line.kind === 'storage-retry').length, 1,
      'the open was retried exactly once');
    assert.ok(journal.some((line) => line.kind === 'mounted' && line['ledgerSource'] === 'durable'),
      'the plan was durable; the open is what failed');
    assert.equal(journal.filter((line) => line.kind === 'publish').length, 0,
      'no application was ever published');
    const outcomes = journal.filter((line) => line.kind === 'entry' || line.kind === 'at-rest');
    assert.ok(outcomes.length > 0 && outcomes.every((line) => line['status'] === 'recovery-pending'),
      `every engine pass reports recovery-pending: ${JSON.stringify(outcomes)}`);
    assert.equal(existsSync(expectedPath), false, 'no ledger file was created under a file path');

    // A third step: the refusal is not retried again and no second line is written.
    step(session, oversizedBody(16 * 1024), 'c3');
    await preStep(mount.listeners, session);
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 1,
      'the refusal stays once-only for the session lifetime');
    assert.equal(journal.filter((line) => line.kind === 'storage-retry').length, 1,
      'a degraded session is not retried on every step');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

/** Queue one prune pass at the next pre-step, as the `/cremate` command does. */
function requestPrune(session: FakeSession): void {
  session.append('user/message', { content: [text(PRUNE_COMMAND)],
    source: { kind: 'user' }, role: 'user', id: 'user-prune' }, { surfaceOp: 'append' });
}

test("':memory:' still removes normally: the refusing fallback never becomes the default", async () => {
  const journal: JournalLine[] = [];
  const mount = memoryMount(journal);
  try {
    await mount.apply();
    const session = fakeSession('session-memory');
    attach(mount, session);
    step(session, oversizedBody(40 * 1024));
    session.append('turn/end', { turn: 1 });
    mount.wire('session-memory');
    requestPrune(session);
    await preStep(mount.listeners, session);
    const [removed = ''] = surfaceTexts(session);
    assert.match(removed, /\[not retained\] /u, 'a memory mount still removes');
    assert.equal(appliedPrune(journal)?.['status'], 'applied');
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 0,
      'no storage failure on the in-memory pair');
    const atRest = journal.find((line) => line.kind === 'at-rest');
    assert.notEqual(atRest?.['status'], 'recovery-pending');
  } finally {
    await mount.close();
  }
});

test('a host that confirms not-applied blocks and journals a receipt conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-conflict-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const first = fakeMount(root, journal1);
  const config = resolvePluginConfig({ barBytes: 2048, crematorStorageRoot: root });
  const secondMount = createRacoonsMount({ config, storage: resolveStorage({ root }, root),
    journal: (record) => journal2.push(record), warn: () => {} });
  try {
    // 1. Remove one unit through the shipped mount, then close it cleanly. The
    //    `/cremate` command is the surviving bulk ask (ADR-0028).
    await first.apply();
    const session1 = fakeSession('session-conflict');
    attach(first, session1);
    step(session1, oversizedBody(40 * 1024));
    session1.append('turn/end', { turn: 1 });
    first.wire('session-conflict');
    requestPrune(session1);
    await preStep(first.listeners, session1);
    const intentId = appliedPrune(journal1)?.['intentId'];
    assert.equal(typeof intentId, 'string');
    await first.close();

    // 2. A fresh mount on the same root. The ledger holds the applied row, so
    //    this intent's crash-window receipt has been collected (ISSUE-436): the
    //    durable file tracks only live obligations, and the ledger is the record
    //    of record (ADR-0015). The crash WINDOW itself (a receipt with no applied
    //    row) is covered by the recovery-durability suite.
    const session2 = fakeSession('session-conflict');
    const entry = await secondMount.sessionFor('session-conflict', session2);
    assert.deepEqual(readDurableReceipts(resolveSessionStorage(root, 'session-conflict')), [],
      'the applied intent\'s crash-window receipt was collected');
    // 3. The variant: a host that actively lost the application confirms
    //    not-applied. That is the one answer that outranks the durable record.
    entry.port.lookupReceipt = async () => ({ status: 'not-applied' });
    session2.on((s, event) => { secondMount.observe(s, event); });
    const fresh = oversizedBody(32 * 1024);
    step(session2, fresh, 'r1');
    const outcome = await secondMount.runStep(session2, { turn: 1, step: 1 });

    // 4. Blocked: no removal, no publication, recovery-pending by name.
    assert.equal(outcome.atRest?.status, 'recovery-pending',
      'the contradicting host answer blocks the pass');
    const atRest = journal2.find((line) => line.kind === 'at-rest');
    assert.equal(atRest?.['status'], 'recovery-pending');
    assert.equal(journal2.filter((line) => line.kind === 'publish').length, 0,
      'a blocked pass publishes nothing');
    assert.equal(outcome.deliveries[0]?.status, 'recovery-pending',
      'the new oversized result is refused, not applied');
    assert.deepEqual(surfaceTexts(session2), [fresh],
      'the new result keeps every byte on the surface');
    // 5. The conflict is journaled and its telemetry fired exactly once.
    assert.deepEqual(conflicts(journal2), [{ intentId, host: 'not-applied' }],
      'the contradiction is a receipt-conflict, deduped per intent and host');
  } finally {
    await first.close();
    await secondMount.close();
    cleanup(dir);
  }
});

test('a transient open failure recovers on the retry: the mount then removes normally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-recover-'));
  // The root does not exist yet; its parent is a file, so the first mkdir fails.
  // Removing the blocker between the two boundaries makes the retry succeed.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const root = join(blocker, 'racoons');
  const journal: JournalLine[] = [];
  const warns: string[] = [];
  const mount = fakeMount(root, journal, warns);
  try {
    await mount.apply();
    const session = fakeSession('session-recover');
    attach(mount, session);
    step(session, oversizedBody(40 * 1024), 'c1');
    await preStep(mount.listeners, session);
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 0,
      'the transient failure is not a refusal');
    assert.equal(journal.filter((line) => line.kind === 'storage-recovered').length, 0,
      'nothing recovered yet');

    // The condition clears; the next boundary retries and succeeds.
    rmSync(blocker, { force: true });
    step(session, 'small result', 'c2');
    // The pass reads a completed turn: an in-flight turn protects its own nodes.
    session.append('turn/end', { turn: 1 });
    mount.wire('session-recover');
    requestPrune(session);
    await preStep(mount.listeners, session);
    const recovered = journal.find((line) => line.kind === 'storage-recovered');
    assert.equal(recovered?.['attempts'], 1, 'the successful retry names the failed attempt');
    assert.equal(recovered?.['sessionId'], 'session-recover');
    assert.equal(recovered?.['storage'], join(root, 'sessions', 'session-recover', 'ledger.sqlite'));
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 0,
      'no refusal was ever installed');
    // The retried mount is fully live: the queued oversized result is removed
    // by the prune pass, and its receipt line names the minted recall id.
    const [removed = ''] = surfaceTexts(session);
    assert.match(removed, /\[not retained\] /u, 'the recovered mount removes normally');
    assert.equal(appliedPrunes(journal)[0]?.['status'], 'applied');
    assert.equal(warns.length, 1, 'only the failed attempt warned');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

test('an unsafe session id is refused through the refusing-ledger path, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-bad-id-'));
  const root = join(dir, 'racoons');
  const journal: JournalLine[] = [];
  const mount = fakeMount(root, journal);
  try {
    await mount.apply();
    // A session id that would escape the root. A retry cannot fix it, so it must
    // never reach the retry loop (critic fix P3#8).
    const session = fakeSession('a/b');
    attach(mount, session);
    const body = oversizedBody(40 * 1024);
    step(session, body, 'c1');
    const before = session.seq ?? 0;
    await preStep(mount.listeners, session);
    assert.equal(session.seq, before, 'the bad id appends nothing');
    assert.deepEqual(surfaceTexts(session), [body], 'the result keeps every byte');
    const unavailable = journal.filter((line) => line.kind === 'storage-unavailable');
    assert.equal(unavailable.length, 1, 'the refusal journals once, like a failed open');
    assert.equal(unavailable[0]?.['code'], 'invalid-session-id');
    assert.equal(unavailable[0]?.['path'], 'a/b', 'the line names the offending id');
    assert.equal(unavailable[0]?.['sessionId'], 'a/b');
    assert.equal(journal.filter((line) => line.kind === 'storage-retry').length, 0,
      'an unfixable id is never retried');
    assert.equal(journal.filter((line) => line.kind === 'storage-plan').length, 0,
      'no per-session plan exists for a refused id');
    const outcomes = journal.filter((line) => line.kind === 'entry' || line.kind === 'at-rest');
    assert.ok(outcomes.length > 0 && outcomes.every((line) => line['status'] === 'recovery-pending'),
      `every engine pass reports recovery-pending: ${JSON.stringify(outcomes)}`);
    assert.equal(existsSync(join(root, 'sessions')), false,
      'nothing was written under the storage root');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

/** A mount over one durable root, journaling to `journal` (ISSUE-434). */
function durableMount(root: string, journal: JournalLine[]): ReturnType<typeof createRacoonsMount> {
  return createRacoonsMount({
    config: resolvePluginConfig({ crematorStorageRoot: root }),
    storage: resolveStorage({ root }, root),
    journal: (record) => journal.push(record),
    warn: () => {},
  });
}

test('ISSUE-434: the storage retry budget dies with the ended session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-434-budget-'));
  // A FILE where the storage root expects a directory: every open fails.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const root = join(blocker, 'racoons');
  const journal: JournalLine[] = [];
  const mount = durableMount(root, journal);
  try {
    const session = fakeSession('session-434-budget');
    // First life: the open fails once, no entry is ever installed.
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError);
    await mount.endSession(session);

    // Reopened life starts with a FRESH allowance: the next failure retries
    // again instead of installing the refusing ledger on its first failure.
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError);
    // The second failure of this life now refuses (the budget is two), and the
    // refusing ledger lands on an entry.
    const refused = await mount.sessionFor(session.id, session);
    assert.ok(refused !== undefined, 'the second failure installs the refusing ledger');
    assert.equal(journal.filter((line) => line.kind === 'storage-unavailable').length, 1,
      'exactly one refusal was ever installed, in the reopened life');

    // The refusal is installed on an entry; release it and reopen once more:
    // the allowance is fresh again, so this is a retry, not a silent refusal.
    await mount.endSession(session);
    const retriesBefore = journal.filter((line) => line.kind === 'storage-retry').length;
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError,
      'a released entry leaves a fresh retry allowance');
    const retries = journal.filter((line) => line.kind === 'storage-retry');
    assert.equal(retries.length, retriesBefore + 1);
    assert.ok(retries.every((line) => line['attempt'] === 1),
      'every life starts its retry count at one');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

test('ISSUE-434: a reopened life journals its own plan and recovery lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-434-plan-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const root = join(blocker, 'racoons');
  const journal: JournalLine[] = [];
  const mount = durableMount(root, journal);
  try {
    const session = fakeSession('session-434-plan');
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError);
    await mount.endSession(session);

    // Reopened life, still blocked: its own `storage-plan` and its own retry.
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError);
    // The condition clears; the next boundary of the reopened life recovers.
    rmSync(blocker, { force: true });
    const entry = await mount.sessionFor(session.id, session);
    assert.ok(entry !== undefined);

    const plans = journal.filter((line) => line.kind === 'storage-plan');
    assert.equal(plans.length, 2, 'each life journals its own effective plan');
    assert.equal(plans.at(-1)?.['sessionId'], session.id);
    const recovered = journal.filter((line) => line.kind === 'storage-recovered');
    assert.equal(recovered.length, 1, 'the reopen retry recovered the ledger');
    assert.equal(recovered[0]?.['attempts'], 1, 'the recovered retry names one failed attempt');
    await mount.endSession(session);
  } finally {
    await mount.close();
    cleanup(dir);
  }
});
