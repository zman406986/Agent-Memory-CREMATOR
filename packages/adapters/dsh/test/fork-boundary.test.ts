/**
 * The fork/clone install boundary (ISSUE-422).
 *
 * A fork is the third case beside a fresh install (ISSUE-414) and a restart: a
 * child session inherits history the parent already settled. dsh announces no
 * fork event in the slice this mount reads, so the in-repo identity is the
 * durable mount state's own `sessionId`: state that names a DIFFERENT session is
 * the parent's copy carried to a child id. These tests build exactly that shape
 * (a real per-session directory copied to a second id) and pin:
 *
 *   1. the child is recognised as a fork by name and replays nothing it
 *      inherited, while its OWN new result is delivered and asked as usual.
 *      The inherited results are ordinary history for the bulk lane: a later
 *      `/cremate` plans and asks over them (no pre-install eligibility gate);
 *   2. the child's first step names the missing capture instead of refusing
 *      `no-seed` — the parent's request is not this session's seed.
 */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { PRUNE_ASK_JSONL_20_SLOT, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT } from '@cremator/core';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession, RacoonsJournalSink,
} from '../src/plugin.js';
import {
  createRacoonsMount, resolvePluginConfig, resolveSessionStorage, resolveStorage,
} from '../src/plugin.js';
import { DatabaseSync } from 'node:sqlite';
import { readPendingForgets, writePendingForgets } from '../src/mount-state.js';
import { readEntryAskFired, readPruneRound, readPruneTriggerState, readTableAskFired,
  writeEntryAskFired, writePendingAppends, writePruneRound,
  writeTableAskFired } from '../src/prune-round-store.js';
import { PREINSTALL_RECORD_FILE } from '../src/preinstall-record.js';
import { PRUNE_COMMAND } from '../src/prune.js';

const ROUTE = { provider: 'p', model: 'm' };
const FORGET = '{"keepall":true}';
/** Main's last dispatched request, as the host's waterfall hands it over. */
const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read the big file' }] }],
};

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
}

/** The minimal fake dsh session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    requestHeader: () => ({ config: { provider: ROUTE.provider, model: ROUTE.model } }),
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
      for (const listener of listeners) listener(session, event);
      return event;
    },
    on(listener: (session: FakeSession, event: DshMountEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return session;
}

const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });

/** One closed step holding one oversized read result. */
function step(session: FakeSession, turn: number, callId: string, body: string): void {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  session.append('system/message', { turn, step: 1, message: { role: 'system',
    content: [text('system prompt')], source: { kind: 'system-prompt' },
    id: `sys-${String(turn)}` } }, { surfaceOp: 'append' });
  session.append('user/message', { content: [text('read the big file')],
    source: { kind: 'user' }, role: 'user', id: `user-${String(turn)}` },
  { surfaceOp: 'append' });
  const callSeq = session.append('tool/call', { turn, step: 1, callId, name: 'read',
    arguments: JSON.stringify({ file_path: `${callId}.txt` }) }).seq;
  session.append('assistant/message', { turn, step: 1, message: {
    role: 'assistant', source: { kind: 'model', provider: ROUTE.provider, model: ROUTE.model },
    content: [{ type: 'tool-call', id: callId, name: 'read',
      arguments: JSON.stringify({ file_path: `${callId}.txt` }) }],
    id: `asst-${callId}` } }, { surfaceOp: 'append' });
  session.append('tool/result', { turn, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId }, toolCallId: callId,
    content: [text(body)], isError: false, id: `result-${callId}` } },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn });
}

function oversizedBody(tag: string): string {
  return `${Array.from({ length: 640 }, (_, index) =>
    `${tag}-${String(index + 1)} ${'x'.repeat(63)}`).join('\n')}\n`;
}

function requestPrune(session: FakeSession, turn: number): void {
  session.append('user/message', { content: [text(PRUNE_COMMAND)],
    source: { kind: 'user' }, role: 'user', id: `user-prune-${String(turn)}` },
  { surfaceOp: 'append' });
}

function fakeLlm(): { calls: DshLlmStreamOptions[]; stream(options: DshLlmStreamOptions):
  AsyncIterable<DshLlmChunk> } {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: FORGET.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: FORGET.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}
type JournalLine = { kind: string; [field: string]: unknown };
const kinds = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

/** One mounted session on a durable root, attached for live events only. */
function mountOn(root: string, journal: JournalLine[], options: {
  readonly grammar?: '3option' | 'jsonl-20';
  readonly llm?: ReturnType<typeof fakeLlm>;
} = {}) {
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ crematorStorageRoot: root, floorBytes: 64,
      barBytes: 64, contextWindowTokens: 200_000,
      entryAskTrigger: { mode: 'count' }, entryAskGrammar: options.grammar ?? '3option' }),
    storage: resolveStorage({ root }, root),
    journal: (record => journal.push(record as unknown as JournalLine)) as RacoonsJournalSink,
    llm: (options.llm ?? fakeLlm()) as never,
    judgeRoute: ROUTE,
  });
  return mount;
}

function copySession(root: string, from: string, to: string): void {
  const source = dirname(resolveSessionStorage(root, from).databasePath);
  const target = dirname(resolveSessionStorage(root, to).databasePath);
  cpSync(source, target, { recursive: true });
}

/** Rebuild a child host session whose surface already holds the parent's log. */
function inheritedSession(id: string, parent: FakeSession): FakeSession {
  const child = fakeSession(id);
  for (const event of parent.log) {
    child.append(event.type, event.data,
      event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp });
  }
  return child;
}

function surfaceResultText(session: FakeSession, callId: string): string | null {
  for (const seq of [...(session.surface?.nodes ?? [])].reverse()) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    const data = event.data as { message?: { toolCallId?: string;
      content?: readonly { text?: string }[] } };
    if (data.message?.toolCallId !== callId) continue;
    return data.message.content?.map(block => block.text ?? '').join('') ?? null;
  }
  return null;
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

/** A parent session with one settled result, then its state copied to a child. */
async function forkedFixture(beforeCopy?: (root: string) => void): Promise<{
  readonly dir: string;
  readonly root: string;
  readonly parent: FakeSession;
  readonly child: FakeSession;
  readonly body: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-fork-'));
  const root = join(dir, 'racoons');
  const first = mountOn(root, []);
  const parent = fakeSession('session-parent');
  const body = oversizedBody('PARENT');
  try {
    await first.sessionFor(parent.id, parent);
    await first.runStep(parent, { turn: 1, step: 1 });
    // The result lands AFTER the mount's entry exists, so it is the parent's own
    // unit: delivered, asked, and eligible for the bulk lane.
    parent.on((live, event) => first.observe(live, event));
    step(parent, 1, 'c1', body);
    await first.runStep(parent, { turn: 1, step: 2 });
  } finally {
    await first.close();
  }
  beforeCopy?.(root);
  copySession(root, 'session-parent', 'session-child');
  return { dir, root, parent, child: inheritedSession('session-child', parent), body };
}

test('ISSUE-422: a forked child replays nothing and tables its inherited surface', async () => {
  const fixture = await forkedFixture();
  const journal: JournalLine[] = [];
  const second = mountOn(fixture.root, journal);
  try {
    const { child, parent } = fixture;
    const inheritedId = 'dsh:session-child:result:c1';
    await second.sessionFor(child.id, child);
    second.observeWire({ sessionId: child.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE });
    // Only NEW events are observed: the host restored the inherited log before
    // the mount existed, exactly like a fork.
    child.on((live, event) => second.observe(live, event));

    const boundary = kinds(journal, 'install-boundary');
    assert.equal(boundary.length, 1, 'one install-boundary line');
    assert.equal(boundary[0]?.['state'], 'fork',
      'state naming another session is recognised as a fork by name');
    assert.equal(boundary[0]?.['parentSessionId'], 'session-parent',
      'the child names the session the copied state belongs to');
    assert.equal(boundary[0]?.['preInstall'], 1,
      'the inherited surface result is the child\'s pre-install history');
    assert.equal(boundary[0]?.['fresh'], false,
      'a copied state is not a fresh install');
    assert.deepEqual(
      (JSON.parse(readFileSync(join(dirname(resolveSessionStorage(fixture.root,
        'session-child').databasePath), 'mount-state.json'), 'utf8')) as
        { readonly install?: { readonly sessionId?: string } }).install?.sessionId,
      'session-child',
      'the child records its OWN install identity over the copy');

    // The fork still recovers nothing from the parent (the child's first mount
    // never replays inherited work), but the parent's results are no longer
    // excluded from the bulk lane: `/cremate` plans and asks over them.
    await second.runStep(child, { turn: 2, step: 1 });
    assert.equal(kinds(journal, 'entry').length, 0, 'no inherited landing was re-delivered');
    assert.equal(kinds(journal, 'entry-resume-recovered').length, 0,
      'a fork recovers nothing from the parent');
    assert.equal(kinds(journal, 'entry-ask').length, 0, 'no entry ask fired over inherited history');
    requestPrune(child, 2);
    await second.runStep(child, { turn: 2, step: 2 });
    const inheritedPlan = kinds(journal, 'prune-plan')[0];
    assert.equal(inheritedPlan?.['units'], 1,
      'the bulk lane plans the inherited content like any other');
    assert.equal(inheritedPlan?.['askRows'], 1, 'and puts it on the table');
    assert.equal(kinds(journal, 'prune-table').length > 0, true,
      'the prune ask left the seam');
    assert.equal(surfaceResultText(child, 'c1'), fixture.body,
      'the inherited result keeps every byte because this answer kept it');

    // The child's OWN next result is ordinary: delivered and asked once.
    step(child, 3, 'c2', oversizedBody('CHILD'));
    await second.runStep(child, { turn: 3, step: 2 });
    const deliveries = kinds(journal, 'entry');
    assert.equal(deliveries.length, 1, 'only the child\'s own result is delivered');
    assert.equal(deliveries[0]?.['eventId'], 'dsh:session-child:result:c2');
    const asked = kinds(journal, 'entry-ask');
    assert.equal(asked.length, 1, 'the child asks about its own unit, never the parent\'s');
    assert.equal(asked[0]?.['eventId'], 'dsh:session-child:result:c2');
    assert.notEqual(asked[0]?.['unitId'], inheritedId,
      'the asked unit is not the inherited result');
    assert.notEqual(parent.id, child.id, 'the fixture really used two ids');
    assert.equal(kinds(journal, 'entry-ask-refused').length, 0,
      'the child\'s own ask was not refused');
  } finally {
    await second.close();
    cleanup(fixture.dir);
  }
});

test('ISSUE-422: a forked child\'s first ask names the missing capture, not `no-seed`',
  async () => {
    const fixture = await forkedFixture();
    const journal: JournalLine[] = [];
    const second = mountOn(fixture.root, journal);
    try {
      const { child } = fixture;
      await second.sessionFor(child.id, child);
      child.on((live, event) => second.observe(live, event));
      // No `llm/stream` dispatch happens for the child, so main's request was
      // never captured: the parent's request is not this session's seed.
      step(child, 2, 'c2', oversizedBody('CHILD-NOSEED'));
      await second.runStep(child, { turn: 2, step: 2 });

      assert.equal(kinds(journal, 'entry-ask').length, 0, 'no ask request left the seam');
      const refused = kinds(journal, 'entry-ask-refused');
      assert.equal(refused.some(line => line['code'] === 'no-seed'), false,
        'a forked child does not refuse `no-seed` before its own capture exists');
      const off = kinds(journal, 'entry-ask-off');
      assert.equal(off.length, 1, 'the skipped ask is journaled, not silent');
      assert.equal(off[0]?.['reason'], 'inherited-no-capture',
        'the line names the missing capture');
      assert.equal(off[0]?.['installBoundary'], 'fork', 'and names the boundary');
      assert.equal(surfaceResultText(child, 'c2'), oversizedBody('CHILD-NOSEED'),
        'the child\'s result lands whole');
    } finally {
      await second.close();
      cleanup(fixture.dir);
    }
  });

test('ISSUE-437: a fork drops the parent\'s owed forgets and appends', async () => {
  const fixture = await forkedFixture((root) => {
    const parentTarget = resolveSessionStorage(root, 'session-parent');
    writePendingForgets(parentTarget, [{ eventId: 'parent-forget', unitId: 'unit-parent',
      source: 'parent.txt', label: null, ranges: [{ startLine: 1, endLineInclusive: 2 }] }],
    () => {}, 'session-parent');
    writePendingAppends(parentTarget, [{ recordId: 'parent-append',
      bytesBase64: Buffer.from('parent record').toString('base64') }], () => {}, 'session-parent');
  });
  const journal: JournalLine[] = [];
  const second = mountOn(fixture.root, journal);
  const childJournal: JournalLine[] = [];
  const third = mountOn(fixture.root, childJournal);
  const parentJournal: JournalLine[] = [];
  const fourth = mountOn(fixture.root, parentJournal);
  const stateFile = (id: string): string =>
    join(dirname(resolveSessionStorage(fixture.root, id).databasePath), 'mount-state.json');
  const roundFile = (id: string): string =>
    join(dirname(resolveSessionStorage(fixture.root, id).databasePath), 'prune-round.json');
  try {
    await second.sessionFor(fixture.child.id, fixture.child);
    const dropped = kinds(journal, 'fork-state-dropped');
    assert.equal(dropped.length, 1, 'the fork names what it dropped, once');
    assert.equal(dropped[0]?.['parentSessionId'], 'session-parent',
      'the line names the session the facts belonged to');
    assert.equal(dropped[0]?.['forgets'], 1, 'one inherited forget');
    assert.equal(dropped[0]?.['appends'], 1, 'one inherited append');
    const childState = JSON.parse(readFileSync(stateFile('session-child'), 'utf8')) as
      { readonly forgets?: unknown };
    assert.equal(childState.forgets, undefined, 'the child carries no inherited forget');
    const childRound = JSON.parse(readFileSync(roundFile('session-child'), 'utf8')) as
      { readonly appends?: unknown };
    assert.equal(childRound.appends, undefined, 'the child carries no inherited append');
    await second.close();

    // The child's later mount is a restart: it replays neither inherited fact.
    const childAgain = inheritedSession('session-child', fixture.parent);
    await third.sessionFor(childAgain.id, childAgain);
    await third.runStep(childAgain, { turn: 2, step: 1 });
    assert.equal(kinds(childJournal, 'forget-recovered').length, 0,
      'no inherited forget was re-queued');
    // The restart recovers the surface (the inherited result is ordinary
    // history now), but the parent's append is never replayed.
    assert.equal(kinds(childJournal, 'entry-resume-recovered')
      .filter(line => line['appends'] !== undefined && line['appends'] !== 0).length, 0,
    'no inherited append was replayed');
    assert.equal(kinds(childJournal, 'forget').length, 0, 'no forget ran in the child');

    // A parent restart on its own directory still replays both facts.
    const parentAgain = inheritedSession('session-parent', fixture.parent);
    await fourth.sessionFor(parentAgain.id, parentAgain);
    await fourth.runStep(parentAgain, { turn: 2, step: 1 });
    assert.equal(kinds(parentJournal, 'forget-recovered')[0]?.['count'], 1,
      'the parent restart re-queues its own forget');
    assert.equal(kinds(parentJournal, 'entry-resume-recovered')[0]?.['appends'], 1,
      'the parent restart replays its own append');
  } finally {
    await second.close();
    await third.close();
    await fourth.close();
    cleanup(fixture.dir);
  }
});

test('ISSUE-456: a failed append clear is never claimed dropped and a child never replays it',
  async () => {
    const fixture = await forkedFixture((root) => {
      writePendingAppends(resolveSessionStorage(root, 'session-parent'),
        [{ recordId: 'parent-append',
          bytesBase64: Buffer.from('parent record').toString('base64') }], () => {}, 'session-parent');
    });
    // A read-only file keeps the append visible while the clear's rename fails.
    const roundFile = join(dirname(resolveSessionStorage(fixture.root, 'session-child').databasePath),
      'prune-round.json');
    chmodSync(roundFile, 0o444);
    const journal: JournalLine[] = [];
    const second = mountOn(fixture.root, journal);
    const restartJournal: JournalLine[] = [];
    const third = mountOn(fixture.root, restartJournal);
    try {
      await second.sessionFor(fixture.child.id, fixture.child);
      assert.equal(kinds(journal, 'fork-state-dropped').length, 0,
        'a clear that returned false is never counted as dropped');
      const failed = kinds(journal, 'fork-clear-failed');
      const appendFailure = failed.find(line => line['fact'] === 'appends');
      assert.notEqual(appendFailure, undefined, 'the failed clear is named');
      assert.equal(appendFailure?.['file'], 'prune-round.json', 'the line names the file that refused');
      assert.equal(appendFailure?.['count'], 1, 'and how many copies remain');
      assert.equal(kinds(journal, 'install-boundary').length, 0,
        'the child identity is withheld while the parent fact remains');

      // The disk recovers: the next boundary retries the clear and only then
      // records the child's own install identity.
      chmodSync(roundFile, 0o666);
      await second.runStep(fixture.child, { turn: 2, step: 1 });
      assert.equal(kinds(journal, 'fork-state-dropped').at(-1)?.['appends'], 1,
        'the retry drops the append it could not clear before');
      assert.equal(kinds(journal, 'install-boundary').at(-1)?.['state'], 'fork',
        'the install identity lands only after the fact is gone');
      await second.close();

      // The child's next mount is a restart and publishes none of the parent's
      // records: the append was cleared before the identity landed.
      await third.sessionFor(fixture.child.id, fixture.child);
      await third.runStep(fixture.child, { turn: 2, step: 1 });
      assert.equal(kinds(restartJournal, 'entry-resume-recovered')
        .filter(line => line['appends'] !== undefined && line['appends'] !== 0).length, 0,
      'the parent append is never replayed into the child');
    } finally {
      try { chmodSync(roundFile, 0o666); } catch { /* already writable or gone */ }
      await second.close();
      await third.close();
      cleanup(fixture.dir);
    }
  });

test('ISSUE-456: a failed forget clear is not applied to the child', async () => {
  const fixture = await forkedFixture((root) => {
    writePendingForgets(resolveSessionStorage(root, 'session-parent'),
      [{ eventId: 'parent-forget', unitId: 'unit-parent', source: 'parent.txt', label: null,
        ranges: [{ startLine: 1, endLineInclusive: 2 }] }], () => {}, 'session-parent');
  });
  const stateFile = join(dirname(resolveSessionStorage(fixture.root, 'session-child').databasePath),
    'mount-state.json');
  chmodSync(stateFile, 0o444);
  const journal: JournalLine[] = [];
  const second = mountOn(fixture.root, journal);
  try {
    await second.sessionFor(fixture.child.id, fixture.child);
    assert.equal(kinds(journal, 'fork-state-dropped')
      .every(line => (line['forgets'] ?? 0) === 0), true,
    'the failed forget clear is not claimed dropped');
    const failed = kinds(journal, 'fork-clear-failed');
    const forgetFailure = failed.find(line => line['fact'] === 'forgets');
    assert.notEqual(forgetFailure, undefined, 'the failed clear is named');
    assert.equal(forgetFailure?.['file'], 'mount-state.json');
    assert.equal(forgetFailure?.['count'], 1);
    await second.runStep(fixture.child, { turn: 2, step: 1 });
    assert.equal(kinds(journal, 'forget').length, 0, 'no inherited forget is applied to the child');
    assert.equal(kinds(journal, 'forget-recovered').length, 0,
      'no inherited forget is re-queued in the child');
  } finally {
    try { chmodSync(stateFile, 0o666); } catch { /* already writable or gone */ }
    await second.close();
    cleanup(fixture.dir);
  }
});

test('ISSUE-457: a fork resets the parent round, latch and first-ask flag', async () => {
  const fixture = await forkedFixture((root) => {
    const parentTarget = resolveSessionStorage(root, 'session-parent');
    writePruneRound(parentTarget, 3, () => {}, 'session-parent',
      { lastFireUsage: 100, belowSinceFire: true, baselinePending: false });
    writeEntryAskFired(parentTarget, true, () => {}, 'session-parent');
    // ISSUE-508: the depth table's first-ask flag is parent history too.
    writeTableAskFired(parentTarget, true, () => {}, 'session-parent');
  });
  const childTarget = resolveSessionStorage(fixture.root, 'session-child');
  const parentTarget = resolveSessionStorage(fixture.root, 'session-parent');
  const roundFile = (target: typeof childTarget): string =>
    join(dirname(target.databasePath), 'prune-round.json');
  const journal: JournalLine[] = [];
  const llm = fakeLlm();
  const second = mountOn(fixture.root, journal, { grammar: 'jsonl-20', llm });
  const parentJournal: JournalLine[] = [];
  const fourth = mountOn(fixture.root, parentJournal);
  // The child's first ask states the 70 percent line; a later ask the 40 one.
  const firstPrefix = PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.slice(0,
    PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
  const lastText = (options: DshLlmStreamOptions): string => {
    const last = options.messages[options.messages.length - 1] as {
      readonly content?: readonly { readonly text?: string }[] } | undefined;
    return (last?.content ?? []).map(block => block.text ?? '').join('');
  };
  try {
    const entry = await second.sessionFor(fixture.child.id, fixture.child);
    assert.equal(entry.entryAskFired, false, 'the child starts with no ask history');
    assert.equal(entry.tableAskFired, false, 'and no table-ask history');
    assert.deepEqual(JSON.parse(readFileSync(roundFile(childTarget), 'utf8')),
      { round: 0, entryAskFired: false, tableAskFired: false },
      'the child\'s round file carries none of the parent\'s facts');
    assert.equal(readPruneRound(parentTarget), 3, 'the parent keeps its round');
    assert.notEqual(readPruneTriggerState(parentTarget), null, 'the parent keeps its latch');
    assert.equal(readEntryAskFired(parentTarget), true, 'the parent keeps its first-ask history');
    assert.equal(readTableAskFired(parentTarget), true,
      'the parent keeps its table-ask history');
    const dropped = kinds(journal, 'fork-state-dropped').at(-1);
    assert.equal(dropped?.['round'], 3, 'the drop line names the dropped round');
    assert.equal(dropped?.['latch'], true, 'and the latch');
    assert.equal(dropped?.['entryAskFired'], true, 'and the first-ask flag');
    assert.equal(dropped?.['tableAskFired'], true, 'and the table-ask flag');

    // The child's first real ask uses the first-ask share line.
    second.observeWire({ sessionId: fixture.child.id, provider: ROUTE.provider,
      model: ROUTE.model, ...MAIN_WIRE });
    fixture.child.on((live, event) => second.observe(live, event));
    step(fixture.child, 2, 'c2', oversizedBody('CHILD'));
    await second.runStep(fixture.child, { turn: 2, step: 2 });
    assert.equal(llm.calls.length, 1, 'the child\'s first ask left the seam');
    assert.equal(lastText(llm.calls[0] as DshLlmStreamOptions).slice(0, firstPrefix.length),
      firstPrefix, 'the child states the first-ask share line, not the parent\'s later one');
    await second.close();

    // A parent restart on its own directory still restores round, latch and flag.
    const parentAgain = inheritedSession('session-parent', fixture.parent);
    const parentEntry = await fourth.sessionFor(parentAgain.id, parentAgain);
    assert.equal(parentEntry.pruneRounds, 3, 'the parent restart resumes its own round');
    assert.equal(parentEntry.entryAskFired, true, 'and its own first-ask history');
    assert.equal(kinds(parentJournal, 'prune-trigger-resumed').length, 1,
      'and its own latch');
  } finally {
    await second.close();
    await fourth.close();
    cleanup(fixture.dir);
  }
});

/**
 * ISSUE-459 / ADR-0064: the copied ledger's rows carry the parent's session id,
 * so the child's engine — which asks the store for its own id — never reads the
 * parent's prepared row. This fixture plants that row under the parent's id in
 * the child's copy and pins the production store shape: the child sees none, is
 * never blocked by it, and never writes an abandoned/applied row for it. A
 * prepared row under the child's own id does not exist on a fork (the copy was
 * written entirely by the parent).
 */
test('ISSUE-459: a parent prepared row sits under the parent id and never blocks the child',
  async () => {
    const fixture = await forkedFixture(() => { /* no extra durable facts */ });
    const childTarget = resolveSessionStorage(fixture.root, 'session-child');
    const intentId = 'inherited-intent';
    const sha = 'a'.repeat(64);
    // Write the parent's prepared row straight into the child's copied file with
    // the store's own schema, as the parent's engine would have.
    const raw = new DatabaseSync(childTarget.databasePath);
    try {
      const next = raw.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM ledger_events').get() as { seq: number };
      raw.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        intentId, 'session-parent', 'event-fork', 'rev-0', 'entry', sha,
        JSON.stringify({ archives: [], appendRecords: [], sealedEpisodeIds: [] }), 1);
      raw.prepare('INSERT INTO ledger_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        next.seq, `engine-prepared:${intentId}`, 'session-parent', intentId, 'prepared', 1,
        JSON.stringify({ kind: 'prepared', sessionId: 'session-parent',
          eventKey: `engine-prepared:${intentId}`, atMs: 1, intentId, applicationSha256: sha }));
    } finally { raw.close(); }

    const journal: JournalLine[] = [];
    const mount = mountOn(fixture.root, journal);
    try {
      const entry = await mount.sessionFor(fixture.child.id, fixture.child);
      const childRows: unknown[] = [];
      for await (const row of entry.ledger.events(fixture.child.id)) childRows.push(row);
      assert.equal(childRows.length, 0, 'the child\'s own view of the copied ledger is empty');
      const parentRows: { readonly event: { readonly kind: string } }[] = [];
      for await (const row of entry.ledger.events('session-parent')) parentRows.push(row);
      assert.equal(parentRows[0]?.event.kind, 'prepared',
        'the parent\'s row sits under the parent id');

      await mount.runStep(fixture.child, { turn: 2, step: 1 });
      assert.notEqual(kinds(journal, 'at-rest').at(-1)?.['status'], 'recovery-pending',
        'the parent row never blocks the child');
    } finally {
      await mount.close();
    }

    // No terminal row was written for the parent's intent in the child's copy.
    const after = new DatabaseSync(childTarget.databasePath);
    try {
      const rows = after.prepare('SELECT kind FROM ledger_events WHERE intent_id = ?')
        .all(intentId) as { readonly kind: string }[];
      assert.deepEqual(rows.map(row => row.kind), ['prepared'],
        'the child never abandons or applies the parent\'s intent');
    } finally {
      after.close();
      cleanup(fixture.dir);
    }
  });

/**
 * ISSUE-475: the retry must clear only what the fork inherited at mount. A
 * child that wrote its own round, first-ask flag and accepted forget after
 * mount keeps all three; none is attributed to the parent.
 */
test('ISSUE-475: a fork retry keeps the round, first-ask flag and forget the child wrote',
  async () => {
    const fixture = await forkedFixture((root) => {
      const parentTarget = resolveSessionStorage(root, 'session-parent');
      writePendingForgets(parentTarget, [{ eventId: 'parent-forget', unitId: 'unit-parent',
        source: 'parent.txt', label: null, ranges: [{ startLine: 1, endLineInclusive: 2 }] }],
      () => {}, 'session-parent');
      writePruneRound(parentTarget, 3, () => {}, 'session-parent',
        { lastFireUsage: 100, belowSinceFire: true, baselinePending: false });
      writeEntryAskFired(parentTarget, true, () => {}, 'session-parent');
    });
    const childTarget = resolveSessionStorage(fixture.root, 'session-child');
    const stateFile = join(dirname(childTarget.databasePath), 'mount-state.json');
    // Readable but not replaceable: the parent's forget clear fails while the
    // round file stays writable, so the header clears at mount.
    chmodSync(stateFile, 0o444);
    const journal: JournalLine[] = [];
    const second = mountOn(fixture.root, journal);
    try {
      await second.sessionFor(fixture.child.id, fixture.child);
      assert.equal(kinds(journal, 'install-boundary').length, 0,
        'the identity is withheld while the parent forget remains');
      assert.notEqual(kinds(journal, 'fork-clear-failed')
        .find(line => line['fact'] === 'forgets'), undefined,
      'the failed parent forgot clear is named');

      // The disk recovers, then the child does its own work after mount.
      chmodSync(stateFile, 0o666);
      writePruneRound(childTarget, 1, () => {}, 'session-child');
      writeEntryAskFired(childTarget, true, () => {}, 'session-child');
      writePendingForgets(childTarget, [{ eventId: 'child-forget', unitId: 'unit-child',
        source: 'child.txt', label: null, ranges: [{ startLine: 1, endLineInclusive: 1 }] }],
      () => {}, 'session-child');

      const before = journal.length;
      await second.runStep(fixture.child, { turn: 2, step: 1 });
      const retried = journal.slice(before);
      assert.equal(kinds(retried, 'fork-clear-failed').length, 0,
        'the retry names no child-written fact as the parent\'s');
      assert.equal(kinds(retried, 'fork-state-dropped')
        .every(line => (line['forgets'] ?? 0) === 0), true,
      'the retry claims no child forget as dropped');
      assert.equal(readPruneRound(childTarget), 1, 'the child round survives the retry');
      assert.equal(readEntryAskFired(childTarget), true,
        'the child first-ask flag survives the retry');
      assert.deepEqual(readPendingForgets(childTarget).map(record => record.eventId),
        ['child-forget'], 'the accepted forget survives the retry');
      assert.equal(kinds(journal, 'install-boundary').at(-1)?.['state'], 'fork',
        'the identity lands once nothing of the parent\'s is owed');
    } finally {
      try { chmodSync(stateFile, 0o666); } catch { /* already writable or gone */ }
      await second.close();
      cleanup(fixture.dir);
    }
  });

/**
 * ISSUE-475: the mount-time snapshot can hold a round with no latch (a parent
 * that never re-armed one). The retry still finds that ordinal, so it must keep
 * the latch the child wrote there: the child's latch is not the parent's, even
 * though the snapshot held none to compare it against.
 */
test('ISSUE-475: a fork retry keeps a latch the child wrote over a bare parent round',
  async () => {
    const fixture = await forkedFixture((root) => {
      const parentTarget = resolveSessionStorage(root, 'session-parent');
      writePendingForgets(parentTarget, [{ eventId: 'parent-forget', unitId: 'unit-parent',
        source: 'parent.txt', label: null, ranges: [{ startLine: 1, endLineInclusive: 2 }] }],
      () => {}, 'session-parent');
      // A round with no latch: the snapshot has no latch to compare against.
      writePruneRound(parentTarget, 3, () => {}, 'session-parent');
    });
    const childTarget = resolveSessionStorage(fixture.root, 'session-child');
    const stateFile = join(dirname(childTarget.databasePath), 'mount-state.json');
    const roundFile = join(dirname(childTarget.databasePath), 'prune-round.json');
    // Both files refuse their write at mount, so the parent's round and forget
    // both stay owed and the retry is armed.
    chmodSync(stateFile, 0o444);
    chmodSync(roundFile, 0o444);
    const journal: JournalLine[] = [];
    const second = mountOn(fixture.root, journal);
    const childLatch = { lastFireUsage: 5, belowSinceFire: true, baselinePending: false };
    try {
      await second.sessionFor(fixture.child.id, fixture.child);
      assert.notEqual(kinds(journal, 'fork-clear-failed')
        .find(line => line['fact'] === 'round'), undefined,
      'the failed parent round clear is named');

      // The disk recovers and the child re-arms its own latch at the same
      // ordinal the snapshot captured.
      chmodSync(stateFile, 0o666);
      chmodSync(roundFile, 0o666);
      writePruneRound(childTarget, 3, () => {}, 'session-child', childLatch);

      const before = journal.length;
      await second.runStep(fixture.child, { turn: 2, step: 1 });
      assert.equal(kinds(journal.slice(before), 'fork-clear-failed').length, 0,
        'the retry clears the parent facts and names none');
      assert.equal(readPruneRound(childTarget), 0, 'the parent round is still reset');
      assert.deepEqual(readPruneTriggerState(childTarget), childLatch,
        'the latch the child wrote survives the retry');
    } finally {
      try { chmodSync(stateFile, 0o666); } catch { /* already writable or gone */ }
      try { chmodSync(roundFile, 0o666); } catch { /* already writable or gone */ }
      await second.close();
      cleanup(fixture.dir);
    }
  });

/**
 * ISSUE-478: withholding the fork identity is not the only durable marker of
 * "clear pending". The preinstall record keeps the fork's inherited set, so a
 * death before the retry re-clears the parent's fact without reclassifying the
 * child's own result as inherited history.
 */
test('ISSUE-478: a withheld fork identity keeps the child\'s own result eligible',
  async () => {
    const fixture = await forkedFixture((root) => {
      writePendingForgets(resolveSessionStorage(root, 'session-parent'),
        [{ eventId: 'parent-forget', unitId: 'unit-parent', source: 'parent.txt',
          label: null, ranges: [{ startLine: 1, endLineInclusive: 2 }] }],
        () => {}, 'session-parent');
    });
    const childTarget = resolveSessionStorage(fixture.root, 'session-child');
    const stateFile = join(dirname(childTarget.databasePath), 'mount-state.json');
    const proofFile = join(dirname(childTarget.databasePath), PREINSTALL_RECORD_FILE);
    chmodSync(stateFile, 0o444);
    const journal: JournalLine[] = [];
    const second = mountOn(fixture.root, journal);
    try {
      await second.sessionFor(fixture.child.id, fixture.child);
      assert.equal(kinds(journal, 'install-boundary').length, 0,
        'the child identity is withheld while the parent forget remains');
      const proof = JSON.parse(readFileSync(proofFile, 'utf8')) as {
        readonly sessionId?: string; readonly ids?: readonly string[]; readonly pendingClear?: boolean };
      assert.equal(proof.pendingClear, true, 'the pending clear is its own durable marker');
      assert.equal(proof.sessionId, 'session-child', 'the marker names the child');
      assert.deepEqual(proof.ids, ['dsh:session-child:result:c1'],
        'only the inherited result is pre-install');

      // The child produces its own result while the identity stays withheld.
      second.observeWire({ sessionId: fixture.child.id, provider: ROUTE.provider,
        model: ROUTE.model, ...MAIN_WIRE });
      fixture.child.on((live, event) => second.observe(live, event));
      step(fixture.child, 2, 'c2', oversizedBody('CHILD'));
      await second.runStep(fixture.child, { turn: 2, step: 1 });
      assert.equal(kinds(journal, 'entry').some(line =>
        line['eventId'] === 'dsh:session-child:result:c2'), true,
      'the child\'s own result is delivered in its first life');
      await second.close();
    } finally {
      try { chmodSync(stateFile, 0o666); } catch { /* already writable or gone */ }
      await second.close();
    }

    const thirdJournal: JournalLine[] = [];
    const third = mountOn(fixture.root, thirdJournal);
    try {
      await third.sessionFor(fixture.child.id, fixture.child);
      assert.equal(kinds(thirdJournal, 'fork-clear-pending').length, 1,
        'the remount names the pending-clear marker');
      const boundaryIndex = thirdJournal.findIndex(line => line.kind === 'install-boundary');
      const droppedIndex = thirdJournal.findIndex(line => line.kind === 'fork-state-dropped'
        && line['forgets'] === 1);
      assert.notEqual(droppedIndex, -1, 'the parent forget is cleared');
      assert.notEqual(boundaryIndex, -1, 'the child identity lands');
      assert.equal(droppedIndex < boundaryIndex, true,
        'the clear completes before the identity lands');
      assert.equal(kinds(thirdJournal, 'install-boundary').at(-1)?.['preInstall'], 1,
        'only the inherited result is recorded on the remount');
      const childState = JSON.parse(readFileSync(join(dirname(resolveSessionStorage(
        fixture.root, 'session-child').databasePath), 'mount-state.json'), 'utf8')) as
        { readonly install?: { readonly preInstallNodeIds?: readonly string[] } };
      assert.deepEqual(childState.install?.preInstallNodeIds,
        ['dsh:session-child:result:c1'],
        'the child\'s own result is not inherited history (identity, not eligibility)');

      // Recovery re-queues every surface result, including the inherited one:
      // the set no longer gates delivery.
      await third.runStep(fixture.child, { turn: 2, step: 2 });
      assert.equal(kinds(thirdJournal, 'entry').some(line =>
        line['eventId'] === 'dsh:session-child:result:c2'), true,
      'the remount delivers the child\'s own result');
      assert.equal(kinds(thirdJournal, 'entry').some(line =>
        line['eventId'] === 'dsh:session-child:result:c1'), true,
      'the inherited result is recovered like any other');
    } finally {
      await third.close();
      cleanup(fixture.dir);
    }
  });

