/**
 * The install boundary (ISSUE-414). These tests drive the shipped plugin mount
 * over a durable storage root and a fake host session, one claim each:
 *
 *   1. a mount installed into a session that already holds history records the
 *      install and the inherited set, and a later `/cremate` pass tables and
 *      removes the pre-install result exactly like a result it observed land;
 *   2. a later mount over the SAME durable state is a restart: it recovers the
 *      landings the previous process left on the surface, exactly as before.
 *
 * The two shapes differ only in whether durable mount state already existed, so
 * the durable root is the subject of the test, not a convenience.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountContext, DshMountEvent, DshMountSession,
  RacoonsJournalRecord,
} from '../src/plugin.js';
import { createRacoonsMount, createRacoonsPlugin, resolvePluginConfig,
  resolveSessionStorage, resolveStorage } from '../src/plugin.js';
import { readDurableReceipts, writeDurableReceipt, writeInstall } from '../src/mount-state.js';
import { PREINSTALL_RECORD_FILE } from '../src/preinstall-record.js';
import { PRUNE_COMMAND } from '../src/prune.js';

const ROUTE = { provider: 'p', model: 'm' };
// The shipped prune grammar's `forgetall`: a boolean action plus its summary.
const FORGET = '{"1":{"forgetall":true,"summary":"oversized read"}}';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}
interface JournalLine { readonly kind: string; readonly [field: string]: unknown }
interface RegisteredTool { readonly name: string; execute(args: unknown): Promise<unknown> }

function fakeLlm(answers: readonly string[]): { stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk> } {
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

/** One scripted step with an oversized result. */
function step(session: FakeSession, body: string, callId = 'c1', path = 'big.txt',
  turn = 1): void {
  const message = (id: string, role: string, content: unknown[], source: unknown): void => {
    session.append(`${role}/message`, { turn, step: 1, message: { role, content, source, id } },
      { surfaceOp: 'append' });
  };
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  message(`sys-${String(turn)}`, 'system', [text('sys')], { kind: 'system-prompt' });
  message(`user-${String(turn)}`, 'user', [text('task')], { kind: 'user' });
  const callSeq = session.append('tool/call', { turn, step: 1, callId, name: 'read',
    arguments: JSON.stringify({ file_path: path }) }).seq;
  message(`asst-${callId}`, 'assistant', [{ type: 'tool-call', id: callId, name: 'read',
    arguments: JSON.stringify({ file_path: path }) }], { kind: 'model', provider: 'p', model: 'm' });
  session.append('tool/result', { turn, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId }, toolCallId: callId, content: [text(body)],
    isError: false, id: `result-${callId}` },
    meta: { path, offset: 1, lines: Array.from({ length: 640 }, () => '') } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn, step: 1 });
}

function oversizedBody(bytes: number): string {
  const line = 'x'.repeat(63);
  return `${`${line}\n`.repeat(Math.ceil(bytes / (line.length + 1)))}`.slice(0, bytes);
}

interface FakeMount {
  readonly listeners: Map<string, (...args: never[]) => unknown>;
  readonly tools: RegisteredTool[];
  readonly journal: JournalLine[];
  wire(sessionId: string): void;
  apply(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One plugin mount on a storage root. `entryAsk` turns the entry checkpoint on
 * (`count`, one verdict) so a pre-install replay WOULD ask; the install
 * boundary's claim is that it does not.
 */
function fakeMount(root: string, journal: JournalLine[],
  options: { readonly entryAsk?: boolean } = {}): FakeMount {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const tools: RegisteredTool[] = [];
  const cleanups: (() => unknown)[] = [];
  const ctx: DshMountContext = {
    logger: { warn: () => {} },
    tools: { register: (tool: unknown) => { tools.push(tool as RegisteredTool); return () => {}; } } as never,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    llm: fakeLlm([FORGET]),
  };
  const plugin = createRacoonsPlugin({ journal: (record: RacoonsJournalRecord) => journal.push(record),
    judgeRoute: ROUTE,
    config: { crematorStorageRoot: root, floorBytes: 1,
      ...(options.entryAsk === true ? { entryAskTrigger: { mode: 'count' } } : {}),
      barBytes: 64, contextWindowTokens: 200_000 } });
  return { listeners, tools, journal,
    wire: (sessionId) => { dispatchWire(listeners, sessionId); },
    apply: async () => { await plugin.apply(ctx, {}); },
    close: async () => {
      for (const fn of [...cleanups].reverse()) await fn();
      cleanups.length = 0;
    } };
}

function dispatchWire(listeners: Map<string, (...args: never[]) => unknown>, sessionId: string): void {
  const listener = listeners.get('llm/stream') as
    ((options: unknown, next: () => unknown) => unknown) | undefined;
  assert.ok(listener !== undefined, 'the mount installed its llm/stream observer');
  listener({ sessionId, provider: ROUTE.provider, model: ROUTE.model,
    system: 'MAIN SYSTEM PROMPT',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }] },
  () => (async function* empty() {})());
}

async function preStep(listeners: Map<string, (...args: never[]) => unknown>,
  session: DshMountSession): Promise<void> {
  const listener = listeners.get('agent/pre-step') as
    ((payload: unknown, next: () => unknown) => Promise<unknown>) | undefined;
  assert.ok(listener !== undefined, 'the mount installed its pre-step hook');
  await listener({ agent: { session }, messages: [], turn: 1, step: 1, signal: {} },
    async () => ({ kind: 'enter', messages: [] }));
}

function attach(mount: FakeMount, session: FakeSession): void {
  session.on((s, event) => {
    const listener = mount.listeners.get('session/event');
    if (listener !== undefined) (listener as (session: FakeSession, event: DshMountEvent) => void)(s, event);
  });
}

function requestPrune(session: FakeSession): void {
  session.append('user/message', { content: [text(PRUNE_COMMAND)],
    source: { kind: 'user' }, role: 'user', id: 'user-prune' }, { surfaceOp: 'append' });
}

const kinds = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

/** The model-visible text of every node on the session's live surface. */
function liveSurfaceTexts(session: FakeSession): string[] {
  const texts: string[] = [];
  for (const seq of session.surface?.nodes ?? []) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const data = event.data as { message?: { content?: readonly { text?: string }[] } };
    texts.push(data.message?.content?.map(block => block.text ?? '').join('') ?? '');
  }
  return texts;
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

test('a fresh install into a session with history tables and removes the old result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-install-'));
  const root = join(dir, 'racoons');
  const journal: JournalLine[] = [];
  const mount = fakeMount(root, journal, { entryAsk: true });
  try {
    // The session already holds a result BEFORE the plugin exists: it can only
    // be pre-install history.
    const session = fakeSession('session-install');
    const body = oversizedBody(40 * 1024);
    step(session, body);
    session.append('turn/end', { turn: 1 });
    const surfaceSeq = (session.surface?.nodes ?? []).find(seq => session.eventAt?.(seq)?.type === 'tool/result');
    assert.notEqual(surfaceSeq, undefined, 'the fixture has one surface result');
    const preInstallId = `dsh:session-install:result:c1`;

    await mount.apply();
    attach(mount, session);
    mount.wire('session-install');
    requestPrune(session);
    await preStep(mount.listeners, session);

    // The install boundary is recorded and still names the inherited set. The
    // set is durable identity evidence, not an eligibility gate.
    const boundary = kinds(journal, 'install-boundary');
    assert.equal(boundary.length, 1, 'one install-boundary line');
    assert.equal(boundary[0]?.['fresh'], true, 'a mount with no durable state is a fresh install');
    assert.equal(boundary[0]?.['preInstall'], 1, 'the result already on the surface is recorded');
    const statePath = join(dirname(resolveSessionStorage(root, 'session-install').databasePath),
      'mount-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as
      { readonly install?: { readonly preInstallNodeIds?: readonly string[] } };
    assert.deepEqual(state.install?.preInstallNodeIds, [preInstallId],
      'the durable install identity names the inherited node');

    // No entry replay at mount (a fresh install runs no recovery), but the
    // `/cremate` pass treats the inherited result exactly like a new one: it is
    // planned, asked over, and removed.
    assert.equal(kinds(journal, 'entry').length, 0, 'a fresh install delivers nothing at mount');
    assert.equal(kinds(journal, 'entry-resume-recovered').length, 0, 'a fresh install recovers nothing');
    const plan = kinds(journal, 'prune-plan')[0];
    assert.equal(plan?.['units'], 1, 'the bulk lane plans the inherited result');
    assert.equal(plan?.['askRows'], 1, 'and puts it on the ask table');
    assert.equal(kinds(journal, 'prune-table').length > 0, true, 'the ask left the seam');
    const verdict = kinds(journal, 'prune-verdict');
    assert.equal(verdict.length, 1, 'the inherited unit was tabled for removal');
    assert.equal(verdict[0]?.['action'], 'forgetall', 'the judged action is named');
    const applied = kinds(journal, 'prune-apply').filter(line => line['status'] === 'applied');
    assert.equal(applied.length, 1, 'the removal landed through the apply leg');
    assert.equal(applied[0]?.['removals'], 1);
    // The host surface no longer holds the pre-install body; a record that can
    // restore it took its place.
    const liveTexts = liveSurfaceTexts(session);
    assert.equal(liveTexts.includes(body), false, 'the pre-install body left the model surface');
    assert.equal(liveTexts.some(text => text.startsWith('[not retained]')), true,
      'a recall record replaced the forgotten result');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

test('a scheduled forget is durable before the answer and replayed after a remount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-forget-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const forgetPath = () => join(dirname(resolveSessionStorage(root, 'session-forget').databasePath),
    'mount-state.json');
  const forgets = (): readonly unknown[] => {
    const state = JSON.parse(readFileSync(forgetPath(), 'utf8')) as
      { readonly forgets?: readonly unknown[] };
    return state.forgets ?? [];
  };
  const first = fakeMount(root, journal1);
  const second = fakeMount(root, journal2);
  try {
    await first.apply();
    const session = fakeSession('session-forget');
    attach(first, session);
    step(session, oversizedBody(40 * 1024));
    session.append('turn/end', { turn: 1 });
    await preStep(first.listeners, session);

    // The forget tool resolves against the live snapshot and answers scheduled.
    const forget = first.tools.find(tool => tool.name === 'forget');
    assert.notEqual(forget, undefined, 'the mount registered the forget tool');
    const answer = await forget?.execute({ path: 'big.txt' }) as { status?: string };
    assert.equal(answer.status, 'scheduled', 'the request is scheduled, not applied in-call');
    assert.equal(forgets().length, 1, 'the accepted request is durable BEFORE the answer left');
    await first.close();

    // The remount replays it as owed work instead of losing it.
    await second.apply();
    attach(second, session);
    await preStep(second.listeners, session);
    assert.equal(kinds(journal2, 'forget-recovered')[0]?.['count'], 1,
      'the remount reports the recovered request by count');
    assert.equal(kinds(journal2, 'forget').length, 1, 'the drain named the forget outcome');
    assert.equal(forgets().length, 0, 'the applied request leaves the durable queue');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});

test('a restart on the same durable state still recovers its own landings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-'));
  const root = join(dir, 'racoons');
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const first = fakeMount(root, journal1);
  const second = fakeMount(root, journal2);
  try {
    await first.apply();
    const session = fakeSession('session-restart-414');
    attach(first, session);
    step(session, oversizedBody(40 * 1024));
    session.append('turn/end', { turn: 1 });
    await preStep(first.listeners, session);
    // The result arrived after the plugin was applied, so it is NOT pre-install.
    assert.equal(kinds(journal1, 'install-boundary')[0]?.['preInstall'], 0,
      'a result observed after apply is not pre-install history');
    assert.equal(kinds(journal1, 'entry').length, 1, 'the first mount delivered the landing');
    await first.close();

    // A second mount over the same durable state is a restart, not an install.
    await second.apply();
    attach(second, session);
    await preStep(second.listeners, session);
    const boundary = kinds(journal2, 'install-boundary');
    assert.equal(boundary.length, 1, 'one install-boundary line');
    assert.equal(boundary[0]?.['fresh'], false, 'existing durable state makes this a restart');
    assert.equal(boundary[0]?.['generation'], 2, 'the mount generation advances');
    const recovered = kinds(journal2, 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'the restart recovered as before');
    assert.equal(recovered[0]?.['redelivered'], 1, 'the surface landing was re-queued');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});

/**
 * ISSUE-439 / ISSUE-458: the install identity is the input to every later
 * classification, so a failed write must not be read as "no durable state".
 * On a FIRST mount the computed inherited set is a proved fact — this mount
 * never observed those results land — so the failure path must not demote it.
 * The set is identity, never an eligibility gate: the result is ordinary
 * history a later pass may table and remove. A directory at the file's own path
 * is the portable write injection.
 */
test('ISSUE-458: a failed install write on a first mount keeps the inherited set',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'racoons-install-write-'));
    const root = join(dir, 'racoons');
    const sessionId = 'session-install-write';
    const statePath = join(dirname(resolveSessionStorage(root, sessionId).databasePath),
      'mount-state.json');
    // The blocker makes every install publish fail until it is removed.
    mkdirSync(statePath, { recursive: true });
    const journal1: JournalLine[] = [];
    const journal2: JournalLine[] = [];
    const first = fakeMount(root, journal1);
    const second = fakeMount(root, journal2);
    try {
      await first.apply();
      const session = fakeSession(sessionId);
      const body = oversizedBody(40 * 1024);
      // The result predates the plugin: it is inherited history, never observed.
      step(session, body);
      session.append('turn/end', { turn: 1 });
      const surfaceSeq = (session.surface?.nodes ?? [])
        .find(seq => session.eventAt?.(seq)?.type === 'tool/result');
      assert.notEqual(surfaceSeq, undefined, 'the fixture has one surface result');
      const preInstallId = `dsh:${sessionId}:result:c1`;
      attach(first, session);
      await preStep(first.listeners, session);

      const failed = kinds(journal1, 'install-persist-error');
      assert.equal(failed.length, 1, 'the failed write is named, not silent');
      assert.equal(failed[0]?.['state'], 'inherited',
        'the line names the boundary the write was for');
      assert.equal(kinds(journal1, 'install-boundary').length, 0,
        'no boundary is claimed that the file does not hold');
      // The failed write makes this mount owe recovery, and nothing excludes the
      // inherited result any more: recovery re-queues it as ordinary history.
      assert.equal(kinds(journal1, 'entry')[0]?.['eventId'], preInstallId,
        'the inherited result is delivered like any other');
      assert.equal(kinds(journal1, 'entry-ask').length, 0,
        'the entry ask trigger is off in this fixture');
      assert.equal(kinds(journal1, 'prune-apply').filter(line => line['status'] === 'applied').length,
        0, 'no pass ran, so nothing was removed');
      const surfaceText = (session.eventAt?.(surfaceSeq ?? -1)?.data as
        { message?: { content?: readonly { text?: string }[] } } | undefined)
        ?.message?.content?.map(block => block.text ?? '').join('') ?? '';
      assert.equal(surfaceText, body, 'the inherited result keeps every byte');

      // The blocker clears: the retry lands the SAME computed set, not an empty
      // one, and names the boundary that was attempted.
      rmSync(statePath, { recursive: true, force: true });
      await preStep(first.listeners, session);
      const boundary = kinds(journal1, 'install-boundary');
      assert.equal(boundary.length, 1, 'the retry journals the boundary it wrote');
      assert.equal(boundary[0]?.['state'], 'inherited',
        'the retried boundary names what was attempted, never restart');
      assert.equal(boundary[0]?.['preInstall'], 1, 'the computed inherited id is kept');
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as
        { readonly install?: { readonly preInstallNodeIds?: readonly string[] } };
      assert.deepEqual(state.install?.preInstallNodeIds, [preInstallId],
        'the retried file still records it as inherited');
      await first.close();

      // A later mount is a restart over the same durable state. The inherited
      // result is recovered as ordinary history, exactly like a new landing.
      await second.apply();
      attach(second, session);
      await preStep(second.listeners, session);
      const remount = kinds(journal2, 'install-boundary');
      assert.equal(remount[0]?.['state'], 'restart', 'the next mount is a restart');
      assert.equal(remount[0]?.['preInstall'], 1,
        'the inherited id survives to the next mount');
      assert.equal(kinds(journal2, 'entry')[0]?.['eventId'], preInstallId,
        'the restart recovers the result instead of skipping it');
    } finally {
      await first.close();
      await second.close();
      cleanup(dir);
    }
  });

/**
 * ISSUE-458: on a genuine restart a failed install write keeps the restart
 * classification and the result eligible. The prior identity names this
 * session, so the surface result was observed by the previous process.
 */
test('ISSUE-458: a failed install write on a restart keeps the result eligible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-restart-write-'));
  const root = join(dir, 'racoons');
  const sessionId = 'session-restart-write';
  const target = resolveSessionStorage(root, sessionId);
  const statePath = join(dirname(target.databasePath), 'mount-state.json');
  // A prior install for THIS session with no pre-install history: a restart.
  writeInstall(target, { generation: 1, installedAtMs: 1, preInstallNodeIds: [],
    sessionId }, () => {}, sessionId);
  // A read-only file stays readable but cannot be replaced: the write fails.
  chmodSync(statePath, 0o444);
  const journal: JournalLine[] = [];
  const mount = fakeMount(root, journal);
  try {
    await mount.apply();
    const session = fakeSession(sessionId);
    // The result is already on the surface from the previous process.
    step(session, oversizedBody(40 * 1024));
    session.append('turn/end', { turn: 1 });
    attach(mount, session);
    await preStep(mount.listeners, session);

    const failed = kinds(journal, 'install-persist-error');
    assert.equal(failed.length, 1, 'the failed write is named');
    assert.equal(failed[0]?.['state'], 'restart',
      'a genuine restart keeps its classification, not inherited');
    assert.equal(kinds(journal, 'entry')[0]?.['eventId'], `dsh:${sessionId}:result:c1`,
      'the observed result stays eligible');

    // Unblock: the retry lands the restart identity it attempted.
    chmodSync(statePath, 0o666);
    await preStep(mount.listeners, session);
    const boundary = kinds(journal, 'install-boundary').at(-1);
    assert.equal(boundary?.['state'], 'restart');
    assert.equal(boundary?.['preInstall'], 0, 'a restart promotes nothing to pre-install');
    assert.equal(boundary?.['generation'], 2, 'the generation advances from the recorded one');
  } finally {
    try { chmodSync(statePath, 0o666); } catch { /* already writable or gone */ }
    await mount.close();
    cleanup(dir);
  }
});

/**
 * ISSUE-436: the durable receipt is a crash-window record, not per-session
 * storage. Once the ledger's `applied` row is durable, the copy is collected.
 */
test('ISSUE-436: a durable receipt is collected once its applied row is durable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-receipts-'));
  const root = join(dir, 'racoons');
  const sessionId = 'session-receipts';
  const journal: JournalLine[] = [];
  const mount = fakeMount(root, journal);
  const statePath = join(dirname(resolveSessionStorage(root, sessionId).databasePath),
    'mount-state.json');
  const receipts = (): readonly unknown[] => {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as
      { readonly receipts?: readonly unknown[] };
    return state.receipts ?? [];
  };
  try {
    await mount.apply();
    const session = fakeSession(sessionId);
    attach(mount, session);
    // Three separate results, each its own forgettable unit.
    step(session, oversizedBody(40 * 1024), 'c1', 'a.txt', 1);
    step(session, oversizedBody(40 * 1024), 'c2', 'b.txt', 2);
    step(session, oversizedBody(40 * 1024), 'c3', 'c.txt', 3);
    session.append('turn/end', { turn: 3 });
    await preStep(mount.listeners, session);
    const forget = mount.tools.find(tool => tool.name === 'forget');
    assert.notEqual(forget, undefined, 'the mount registered the forget tool');
    // One forget per boundary: each apply rewrites one unit's position, so the
    // next request must resolve against the surface the boundary re-synced.
    for (const path of ['a.txt', 'b.txt', 'c.txt']) {
      const answer = await forget?.execute({ path }) as { status?: string };
      assert.equal(answer.status, 'scheduled', `${path} is queued`);
      await preStep(mount.listeners, session);
      const line = kinds(journal, 'forget').at(-1);
      assert.equal(line?.['status'], 'applied', `${path} applied through the ledger`);
    }
    assert.equal(receipts().length, 0,
      'each receipt is collected once its applied row is durable, so the file does not grow');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

/**
 * ISSUE-417: the crash window is a prepared row whose process died before the
 * ledger's `applied` row. The receipt must still answer it after a remount,
 * which is what ISSUE-436's collection must never take away.
 */
test('ISSUE-417: the mount keeps a crash-window receipt with no applied row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-crash-window-'));
  const root = join(dir, 'racoons');
  const sessionId = 'session-crash-window';
  const intentId = 'crash-intent-1';
  const sha = 'a'.repeat(64);
  const target = resolveSessionStorage(root, sessionId);
  // The receipt the previous process wrote at the host write, before it died.
  writeDurableReceipt(target, { intentId, sessionId, baseRevision: 'rev-0',
    resultRevision: 'rev-1', applicationSha256: sha, appliedAtMs: 1 } as never, () => {}, sessionId);
  // A ledger that holds the prepared row and no `applied` row: the crash window.
  const prepared = {
    async prepare() { throw new Error('unused'); },
    async append() { throw new Error('unused'); },
    async *events(id: string) {
      if (id !== sessionId) return;
      yield { sequence: 1, event: { kind: 'prepared', sessionId, atMs: 1,
        eventKey: `engine-prepared:${intentId}`, intentId,
        applicationSha256: sha } };
    },
    async recall() { throw new Error('unused'); },
    async close() {},
  };
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ crematorStorageRoot: root }),
    storage: resolveStorage({ root }, root),
    journal: () => {},
    openLedger: async () => prepared as never,
  });
  try {
    const entry = await mount.sessionFor(sessionId, fakeSession(sessionId));
    assert.equal((await entry.port.lookupReceipt(intentId as never)).status, 'applied',
      'a prepared row with no applied row still resolves from its durable receipt');
    assert.equal(readDurableReceipts(target).length, 1,
      'the mount sweep collects only receipts the ledger already records as applied');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

/**
 * ISSUE-460: the only record of a successful install is a file write; a death
 * before the retry lands leaves none. The ledger still holds this session's own
 * rows, which is proof it already ran here. A next mount must classify a
 * restart — its own results eligible, never promoted to inherited history.
 */
test('ISSUE-460: ledger rows rescue the classification after a lost install write',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'racoons-ledger-fallback-'));
    const root = join(dir, 'racoons');
    const sessionId = 'session-ledger-fallback';
    const statePath = join(dirname(resolveSessionStorage(root, sessionId).databasePath),
      'mount-state.json');
    mkdirSync(statePath, { recursive: true });
    const journal1: JournalLine[] = [];
    const journal2: JournalLine[] = [];
    const first = fakeMount(root, journal1);
    const second = fakeMount(root, journal2);
    try {
      // First process: the install write never lands; the run still settles the
      // entry but (a keepall entry plans nothing) leaves no validation row.
      await first.apply();
      const session = fakeSession(sessionId);
      attach(first, session);
      step(session, oversizedBody(40 * 1024));
      session.append('turn/end', { turn: 1 });
      await preStep(first.listeners, session);
      assert.equal(kinds(journal1, 'install-persist-error').length > 0, true,
        'the install write really failed');
      await first.close();
      // Plant the validation row this session's own earlier pass would have
      // written, with the store's own schema: the only evidence it ran here.
      const db = new DatabaseSync(resolveSessionStorage(root, sessionId).databasePath);
      try {
        db.prepare(`INSERT INTO ledger_events
          (event_key, session_id, intent_id, kind, at_ms, payload_json)
          VALUES (?, ?, NULL, 'validation', 1, ?)`).run(
          'prior-validation', sessionId,
          JSON.stringify({ kind: 'validation', sessionId, eventKey: 'prior-validation',
            atMs: 1, eventId: 'prior', ok: true, issues: [],
            breaker: { consecutiveValidationFailures: 0, disabled: false } }));
      } finally { db.close(); }

      // Second process: still no readable install file, but the ledger has rows.
      await second.apply();
      const again = fakeSession(sessionId);
      attach(second, again);
      step(again, oversizedBody(40 * 1024));
      again.append('turn/end', { turn: 1 });
      await preStep(second.listeners, again);
      const fallback = kinds(journal2, 'install-fallback');
      assert.equal(fallback.length, 1, 'the fallback is named for the operator');
      assert.equal(fallback[0]?.['reason'], 'ledger-rows');
      assert.equal(kinds(journal2, 'entry').length, 1,
        'the session\'s own result stays eligible (a restart, not inherited)');
    } finally {
      await first.close();
      await second.close();
      cleanup(dir);
    }
  });

/**
 * ISSUE-477: the ISSUE-460 ledger fallback must still record the inherited set.
 * The first mount computes it before its install write fails; that set is
 * durable in its own file, so a death that leaves a ledger row behind still
 * names the inherited result on the remount. It is identity evidence, not a
 * skip: the result is recovered and delivered like any other.
 */
test('ISSUE-477: the ledger fallback keeps the inherited set as identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-ledger-inherited-'));
  const root = join(dir, 'racoons');
  const sessionId = 'session-ledger-inherited';
  const statePath = join(dirname(resolveSessionStorage(root, sessionId).databasePath),
    'mount-state.json');
  const proofPath = join(dirname(resolveSessionStorage(root, sessionId).databasePath),
    PREINSTALL_RECORD_FILE);
  mkdirSync(statePath, { recursive: true });
  const journal1: JournalLine[] = [];
  const journal2: JournalLine[] = [];
  const first = fakeMount(root, journal1);
  const second = fakeMount(root, journal2);
  try {
    await first.apply();
    const session = fakeSession(sessionId);
    const body = oversizedBody(40 * 1024);
    // The result predates the plugin: inherited history, never observed.
    step(session, body);
    session.append('turn/end', { turn: 1 });
    attach(first, session);
    await preStep(first.listeners, session);
    assert.equal(kinds(journal1, 'install-persist-error').length > 0, true,
      'the install write really failed');
    const preInstallId = `dsh:${sessionId}:result:c1`;
    const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as {
      readonly sessionId?: string; readonly ids?: readonly string[] };
    assert.equal(proof.sessionId, sessionId, 'the proof names this session');
    assert.deepEqual(proof.ids, [preInstallId],
      'the computed inherited set is durable before the first pass');
    assert.equal(kinds(journal1, 'entry')[0]?.['eventId'], preInstallId,
      'the first mount recovers the inherited result like any other');
    await first.close();

    // Plant the validation row this session's own earlier pass wrote: the only
    // evidence the ISSUE-460 fallback would read.
    const db = new DatabaseSync(resolveSessionStorage(root, sessionId).databasePath);
    try {
      db.prepare(`INSERT INTO ledger_events
        (event_key, session_id, intent_id, kind, at_ms, payload_json)
        VALUES (?, ?, NULL, 'validation', 1, ?)`).run(
        'prior-validation', sessionId,
        JSON.stringify({ kind: 'validation', sessionId, eventKey: 'prior-validation',
          atMs: 1, eventId: 'prior', ok: true, issues: [],
          breaker: { consecutiveValidationFailures: 0, disabled: false } }));
    } finally { db.close(); }

    // Second mount: still no readable install file, but the ledger has rows.
    await second.apply();
    const again = fakeSession(sessionId);
    step(again, body);
    again.append('turn/end', { turn: 1 });
    attach(second, again);
    await preStep(second.listeners, again);
    const fallback = kinds(journal2, 'install-fallback');
    assert.equal(fallback.length, 1, 'the fallback is named for the operator');
    assert.equal(fallback[0]?.['reason'], 'ledger-rows', 'the ledger rescued classification');
    assert.equal(fallback[0]?.['source'], 'preinstall-record',
      'the journal names the durable proof as the source of the set');
    assert.equal(fallback[0]?.['preInstall'], 1, 'the inherited set is still recorded');
    assert.equal(kinds(journal2, 'entry')[0]?.['eventId'], preInstallId,
      'the pre-existing result is recovered, not skipped');
    assert.equal(kinds(journal2, 'entry-ask').length, 0,
      'the entry ask trigger is off in this fixture');
    assert.equal(kinds(journal2, 'prune-apply')
      .filter(line => line['status'] === 'applied').length, 0,
    'no pass ran, so nothing was removed');
  } finally {
    await first.close();
    await second.close();
    cleanup(dir);
  }
});
