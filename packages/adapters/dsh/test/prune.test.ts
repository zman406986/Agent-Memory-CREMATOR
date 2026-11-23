/**
 * The mount's record-only prune pass (ISSUE-022 chunk 5), with a fake LLM and
 * the REAL engine, adapter and port — and its ask on a fork of main's wire
 * state (ISSUE-027, ADR-0010).
 *
 * Seven claims, each tested where it can fail:
 *
 *   1. the ask that leaves is the seed plus appended turns: `system` and
 *      `tools` byte-identical to what main sent, the history as the seed's own
 *      message prefix, and NO flattening — the ask text never repeats it;
 *   2. a carried row is re-asked in a second APPENDED table, never re-rendered:
 *      request 2 repeats request 1 as an exact prefix;
 *   3. a mixed answer journals counts that name the rules and actions that
 *      produced them, and surfaces the `keeplines` trailers;
 *   4. record-only is structural: not one append, replacement or engine event;
 *   5. a refused answer keeps every unit and is counted by code;
 *   6. the `/cremate` command enters through the mount's own pre-step seam, and
 *      the same path is what a direct `runPrune` call reaches;
 *   7. an empty session records a zero pass and never crashes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENTRY_ASK_END_ANCHOR, PRUNE_ASK_FINAL_LINE, PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_SLOT,
  PRUNE_ASK_SYSTEM_PROMPT, wireRequestHash,
} from '@cremator/core';
import type { PruneAskGrammar, WireRequest } from '@cremator/core';
import type { MountJournal } from '../src/journal-kinds.js';
import { createMainWireCapture } from '../src/main-wire.js';
import type { CapturedMainRequest } from '../src/main-wire.js';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession, RacoonsJournalSink,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { PRUNE_COMMAND, runRecordOnlyPrune } from '../src/prune.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';

const encoder = new TextEncoder();

const OVERSIZED = `${'y'.repeat(63)}\n`.repeat(40);
/** Above the 64-byte bar, so the tracker builds a unit for it. */
const DISTINCT = `${'distinct line\n'.repeat(6)}`;

/**
 * Main's last dispatched request, as the host hands it to the capture: a
 * system slot, a tool list and the conversation in main's order.
 */
const MAIN_SYSTEM = 'MAIN SYSTEM BYTES — the prune pass must never replace these';
const MAIN_TOOLS = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }];
const HOST_MAIN = {
  system: MAIN_SYSTEM,
  tools: MAIN_TOOLS,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'the oversized result bytes' }] },
  ],
};
/** The same request in the fork's own shape, for the seed-hash assert. */
const MAIN: WireRequest = { system: MAIN_SYSTEM, tools: MAIN_TOOLS, messages: [
  { role: 'user', text: 'read big.txt' },
  { role: 'assistant', text: 'Reading it.' },
  { role: 'tool', text: 'the oversized result bytes' },
] };

/** A fake host session: an append-only log with a surface node list. */
function fakeSession(id: string): DshMountSession & {
  readonly log: DshMountEvent[];
  readonly surfaceNodes: number[];
} {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes }; },
    get log() { return log; },
    get surfaceNodes() { return surfaceNodes; },
    requestHeader: () => ({ config: { provider: 'a6', model: 'prune-model' } }),
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
  return session;
}

/** One user turn, one read call, its result. `target` groups rereads. */
function seedRead(session: ReturnType<typeof fakeSession>, params: {
  turn: number; callId: string; target: string; body: string; meta?: unknown;
}): void {
  const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: 1 });
  session.append('system/message', { turn: params.turn, step: 1, message: { role: 'system',
    content: [text('system prompt')], source: { kind: 'system-prompt' },
    id: `sys-${String(params.turn)}` } }, { surfaceOp: 'append' });
  session.append('user/message', { content: [text(`read ${params.target}`)],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` },
  { surfaceOp: 'append' });
  session.append('tool/call', { turn: params.turn, step: 1, callId: params.callId,
    name: 'read', arguments: JSON.stringify({ file_path: params.target }) });
  session.append('assistant/message', { turn: params.turn, step: 1, message: {
    role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
    content: [text('reading'), { type: 'tool-call', id: params.callId, name: 'read',
      arguments: JSON.stringify({ file_path: params.target }) }],
    id: `asst-${params.callId}` } }, { surfaceOp: 'append' });
  session.append('tool/result', { turn: params.turn, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId: params.callId }, toolCallId: params.callId,
    content: [text(params.body)], isError: false, id: `result-${params.callId}` },
  ...(params.meta === undefined ? {} : { meta: params.meta }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: params.turn, step: 1 });
  session.append('turn/end', { turn: params.turn });
}

/** One user turn, one write call, its result: the fact a later pass reads. */
function seedWrite(session: ReturnType<typeof fakeSession>, params: {
  turn: number; callId: string; target: string;
}): void {
  const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: 1 });
  session.append('user/message', { content: [text(`write ${params.target}`)],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` },
  { surfaceOp: 'append' });
  session.append('tool/call', { turn: params.turn, step: 1, callId: params.callId,
    name: 'write', arguments: JSON.stringify({ file_path: params.target }) });
  session.append('assistant/message', { turn: params.turn, step: 1, message: {
    role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
    content: [text('writing'), { type: 'tool-call', id: params.callId, name: 'write',
      arguments: JSON.stringify({ file_path: params.target }) }],
    id: `asst-${params.callId}` } }, { surfaceOp: 'append' });
  session.append('tool/result', { turn: params.turn, step: 1, message: { role: 'tool',
    source: { kind: 'tool', callId: params.callId }, toolCallId: params.callId,
    content: [text('wrote it')], isError: false, id: `result-${params.callId}` } },
  { surfaceOp: 'append' });
  session.append('step/end', { turn: params.turn, step: 1 });
  session.append('turn/end', { turn: params.turn });
}

/**
 * Three reads: `big` twice with the SAME bytes (L1 proves the first stale) and
 * one distinct body (L1 proves nothing, so the ask covers it).
 */
function seedFixture(session: ReturnType<typeof fakeSession>): void {
  seedRead(session, { turn: 1, callId: 'c1', target: 'big.txt', body: OVERSIZED });
  seedRead(session, { turn: 2, callId: 'c2', target: 'big.txt', body: OVERSIZED });
  seedRead(session, { turn: 3, callId: 'c3', target: 'small.txt', body: DISTINCT });
}

/** The exact answer texts one fake stream delivers, split into deltas. */
function textChunks(text: string): DshLlmChunk[] {
  return [
    { type: 'text-delta', index: 0, text: text.slice(0, 7) },
    { type: 'text-delta', index: 0, text: text.slice(7) },
    { type: 'finish', reason: 'stop' },
  ];
}

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

function fakeLlm(answer: string | readonly string[]): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  const texts = typeof answer === 'string' ? [answer] : [...answer];
  let index = 0;
  return {
    calls,
    stream(options) {
      calls.push(options);
      const text = texts[Math.min(index, texts.length - 1)] ?? '';
      index += 1;
      return (async function* emit() { for (const chunk of textChunks(text)) yield chunk; })();
    },
  };
}

/** Collects both journal shapes: the mount's record sink and the seam's (kind, fields). */
function collector(): { records: { kind: string; [field: string]: unknown }[];
  sink: RacoonsJournalSink; journal: MountJournal } {
  const records: { kind: string; [field: string]: unknown }[] = [];
  return {
    records,
    sink: record => { records.push({ ...record }); },
    journal: (kind, fields) => { records.push({ kind, ...fields }); },
  };
}

/** One message's text from the host's request shape the send seam builds. */
function textOfMessage(message: unknown): string {
  const content = (message as { content?: { text?: string }[] } | undefined)?.content;
  return content?.[0]?.text ?? '';
}

interface MountSetup {
  readonly session: ReturnType<typeof fakeSession>;
  readonly mount: ReturnType<typeof createRacoonsMount>;
  readonly entry: Awaited<ReturnType<ReturnType<typeof createRacoonsMount>['sessionFor']>>;
  readonly records: ReturnType<typeof collector>;
  /** Main's last captured request, as the plugin's `runPrune` reads it. */
  readonly seed: () => CapturedMainRequest | null;
  readonly mutationSpy: { applies: number; setTranscript: number };
  /** Host appends since the fixture was seeded; the pass must leave it at zero. */
  readonly appendSpy: { appends: number };
}

/** A mount over the seeded session, with every port mutation seam spied. */
async function setup(id: string, params: {
  llm?: FakeLlm; barBytes?: number; records?: ReturnType<typeof collector>;
}): Promise<MountSetup> {
  const session = fakeSession(id);
  seedFixture(session);
  // Count host appends from here on: the fixture's own writes are setup, and a
  // record-only pass must never add one of its own.
  const appendSpy = { appends: 0 };
  const append = session.append.bind(session);
  session.append = (type, data, options = {}) => {
    appendSpy.appends += 1;
    return append(type, data, options);
  };
  const records = params.records ?? collector();
  // Main dispatched this request before the pass: the fork seeds from it.
  const mainWire = createMainWireCapture();
  mainWire.note({ sessionId: session.id, ...HOST_MAIN });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ barBytes: params.barBytes ?? 64, capBytes: 1 << 20,
      episodeNoNewPathSteps: null }),
    storage: resolveStorage(undefined), journal: records.sink, mainWire,
    ...params.llm === undefined ? {} : { llm: params.llm },
  });
  const entry = await mount.sessionFor(session.id, session);
  // Feed every seeded event through the mount's own observer, so the call facts
  // (`tool/call` name and arguments) exist exactly as a live run would have them.
  // Without them the transcript cannot name a target and L1's reread rule cannot
  // group two reads of one file.
  for (const event of session.log) mount.observe(session, event);
  // Spy on the two paths that can move bytes or transcript state. Record-only
  // must never touch either; `updateState` is excluded because a sync rewrites
  // ordinals and that is ordinary observation, not a mutation of the record.
  const mutationSpy = { applies: 0, setTranscript: 0 };
  const apply = entry.port.apply.bind(entry.port);
  entry.port.apply = async request => { mutationSpy.applies += 1; return apply(request); };
  const setTranscript = entry.port.setTranscript.bind(entry.port);
  entry.port.setTranscript = items => { mutationSpy.setTranscript += 1; setTranscript(items); };
  return { session, mount, entry, records, mutationSpy, appendSpy,
    seed: () => mainWire.last(entry.sessionId) };
}

/** The transcript the mount holds for this session, as the pass receives it. */
async function passOver(setupResult: MountSetup, params: {
  llm?: FakeLlm; round?: number; records: ReturnType<typeof collector>;
  settledNodeIds?: ReadonlySet<string>; grammar?: PruneAskGrammar;
}) {
  const { mount, entry, session } = setupResult;
  mount.syncTranscript(entry, session);
  return runRecordOnlyPrune({
    sessionId: entry.sessionId,
    snapshot: await entry.port.snapshot(),
    transcript: entry.port.transcript(),
    round: params.round ?? 1,
    barBytes: 64,
    episodeNoNewPathSteps: null,
    ...params.llm === undefined ? {} : { llm: params.llm },
    ...params.settledNodeIds === undefined ? {} : { settledNodeIds: params.settledNodeIds },
    ...params.grammar === undefined ? {} : { grammar: params.grammar },
    route: () => ({ provider: 'a6', model: 'prune-model' }),
    seed: setupResult.seed,
    journal: params.records.journal,
  });
}

function recordOf(records: ReturnType<typeof collector>) {
  return records.records.find(record => record['kind'] === 'prune-recorded');
}

function telemetryOf(records: ReturnType<typeof collector>) {
  return records.records.filter(record => record['kind'] === 'telemetry')
    .map(record => record['event'] as { kind?: string });
}

// --- the asked pass ---------------------------------------------------------


/**
 * The carry-over round (ADR-0009's second amendment) through the fork: table 1
 * leaves index 2 unanswered, the core carries it, and the catch-up table is
 * APPENDED to the same fork — request 2 repeats request 1 as an exact prefix and
 * renders only the carried row.
 */


// --- the pass's one correction turn (ISSUE-113) -----------------------------

/** The last user turn of the Nth request the seam sent. */
function askTextOf(call: DshLlmStreamOptions | undefined): string {
  return textOfMessage((call?.messages as readonly unknown[])?.at(-1));
}

/** The correction lines of a request, or [] when it carried none. */
function correctionOf(call: DshLlmStreamOptions | undefined): string[] {
  const text = askTextOf(call);
  if (!text.includes('Your previous answer could not be applied')) return [];
  return text.split('\n');
}

/** A stream that finishes with no text at all: the halt path's own reply. */
function silentLlm(calls: DshLlmStreamOptions[]): FakeLlm {
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* silent(): AsyncGenerator<DshLlmChunk> {
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/** A stream that throws before any text: the socket that died mid-ask. */
function deadStreamLlm(calls: DshLlmStreamOptions[]): FakeLlm {
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* boom(): AsyncGenerator<DshLlmChunk> {
        throw new Error('socket reset');
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

type PassOutcome = Awaited<ReturnType<typeof passOver>>;

interface AskScenario {
  /** The row's name; every assertion in the row expands to `row: <name>: ...`. */
  readonly name: string;
  /** The session id the mount opens under. */
  readonly id: string;
  /** The answer texts the fake stream delivers, one per send; null is silence. */
  readonly answers: readonly string[] | null;
  /** How many sends the pass owes: tables, catch-ups and the one correction. */
  readonly sends: number;
  /** Whether the row's stream throws instead of answering. */
  readonly deadStream?: boolean;
  /** The claims only this row makes. */
  check(context: {
    readonly llm: FakeLlm;
    readonly outcome: PassOutcome;
    readonly records: ReturnType<typeof collector>;
    readonly at: Label;
  }): void;
}

/**
 * The ask's one correction turn, and the catch-up table it rides beside: each
 * row scripts its own answer stream and keeps every claim its own test used to
 * make. The shared half asserts the fork property every multi-send row relies
 * on — request N+1 repeats request N as an exact message prefix, so nothing is
 * ever re-rendered — and the row's `check` names its own claims.
 */
function askRow(scenario: AskScenario): Row {
  return {
    name: scenario.name,
    async run(at) {
      const llm = scenario.deadStream === true ? deadStreamLlm([])
        : scenario.answers === null ? silentLlm([]) : fakeLlm(scenario.answers);
      const setupResult = await setup(scenario.id, { llm });
      try {
        const outcome = await passOver(setupResult, { llm, records: setupResult.records });
        assert.equal(llm.calls.length, scenario.sends, at('the scripted number of sends'));
        // The cache property: each request is its predecessor plus appended
        // turns, byte for byte, never a re-render.
        for (let index = 1; index < llm.calls.length; index += 1) {
          const previous = llm.calls[index - 1];
          const current = llm.calls[index];
          assert.ok(previous !== undefined && current !== undefined,
            at(`request ${String(index + 1)} follows request ${String(index)}`));
          const earlier = previous.messages as readonly unknown[];
          const later = current.messages as readonly unknown[];
          for (let message = 0; message < earlier.length; message += 1) {
            assert.equal(JSON.stringify(later[message]), JSON.stringify(earlier[message]),
              at(`request ${String(index + 1)} repeats request ${String(index)}'s `
                + `message ${String(message)} byte for byte`));
          }
          assert.equal(current.system, llm.calls[0]?.system,
            at('system bytes are frozen per fork'));
        }
        scenario.check({ llm, outcome, records: setupResult.records, at });
      } finally {
        await setupResult.mount.close();
      }
    },
  };
}

/** The one `prune-correction` row a corrected pass journals. */
function correctionLine(records: ReturnType<typeof collector>) {
  return records.records.find(record => record['kind'] === 'prune-correction');
}

const ASK_SCENARIOS: readonly AskScenario[] = [
  {
    name: 'clean first answer',
    id: 's-clean',
    answers: ['{"1":{"keepall":true},"2":{"forgetall":"a stale build log"}}'],
    sends: 1,
    check({ llm, outcome, records, at }) {
      // The pass with a clean answer must not gain a call, a turn or a journal
      // line: this is the byte-identical path the ticket requires.
      assert.equal(outcome.asks, 1, at('the one table answered'));
      const askText = askTextOf(llm.calls[0]);
      assert.equal(askText.includes('Your previous answer could not be applied'), false,
        at('a clean answer never sees a correction turn'));
      assert.ok(askText.includes(PRUNE_ASK_SYSTEM_PROMPT), at('the ask states the contract'));
      assert.ok(askText.endsWith(PRUNE_ASK_FINAL_LINE), at('the final line closes the ask'));
      assert.equal(records.records.some(record => record['kind'] === 'prune-correction'), false,
        at('no correction is journaled'));
      const record = recordOf(records);
      assert.deepEqual(record?.['passAttempts'],
        { tables: 1, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 },
        at('the plain path\'s attempt telemetry'));
      assert.deepEqual(record?.['l2RemovalCount'],
        { keeplines: 0, forgetall: 1, forgetlines: 0 }, at('one forgetall was counted'));
      assert.equal(outcome.application?.refused.length, 0, at('nothing was refused'));
    },
  },
  {
    name: 'one refused row',
    id: 's-correct-one',
    answers: ['{"1":{"forgetall":"a stale copy"}}',
      // A row-shaped refusal, so the reason names THAT row rather than the answer.
      '{"2":{"keepall":false}}',
      '{"2":{"forgetall":"an old read"}}'],
    sends: 3,
    check({ llm, outcome, records, at }) {
      // Table 1 answers index 1 and refuses index 2 (absent). The carry
      // scheduler re-asks 2 in a catch-up table; that reply refuses it again, so
      // the pass's correction turn is the third send — and it names row 2 alone.
      const correction = correctionOf(llm.calls[2]);
      assert.ok(correction.length > 0, at('the third send is the correction turn'));
      const rowLines = correction.filter(line => /^\d+\. \[/u.test(line));
      assert.equal(rowLines.length, 1, at('exactly one refused row'));
      assert.match(rowLines[0] ?? '', /^2\. \[read\] small\.txt \(call #1\)/u,
        at('the correction names the refused row by its anchor'));
      assert.equal(correction.some(line => /^1\. \[/u.test(line)), false,
        at('the accepted row is not re-asked'));
      assert.equal(correction[0]?.includes('for 1 of 2 rows'), true,
        at(`the reason names the count: ${String(correction[0])}`));
      assert.equal(correction[0]?.includes('index 2 is not a readable verdict'), true,
        at('the reason is the parser\'s own wording for that refusal'));
      assert.equal(outcome.application?.refused.length, 0, at('the correction answered'));
      const l2 = outcome.application?.removals.filter(removal => removal.origin === 'l2') ?? [];
      assert.deepEqual(l2.map(removal => removal.unitId),
        outcome.plan.askRows.map(row => row.unit.id), at('both rows still move'));
      // The correction is journaled as a turn, naming the row it re-asked.
      const line = correctionLine(records);
      assert.ok(line !== undefined, at('the correction is journaled'));
      assert.equal(line['refusedRows'], 1, at('one row was refused'));
      assert.equal(line['corrected'], 1, at('the correction settled it'));
      assert.deepEqual(line['reasons'], ['2:malformed-row'], at('the refusal code is named'));
      // The correction's own table attempt is journaled too, at its own ordinal.
      const tableLines = records.records.filter(record => record['kind'] === 'prune-table');
      const last = tableLines[tableLines.length - 1];
      assert.equal(last?.['retried'], true, at('the correction is the retried table'));
      assert.equal(last?.['turns'], 2, at('the corrected table asked both turns'));
      assert.equal(last?.['tableUnits'], 1, at('the correction table carried one unit'));
      assert.deepEqual(recordOf(records)?.['passAttempts'],
        { tables: 3, carried: 1, reasked: 2, finalRefusals: 0, deferred: 0 },
        at('table 1, its catch-up, and the correction'));
    },
  },
  {
    name: 'retry still refused',
    id: 's-correct-still-bad',
    answers: ['{"1":{"forgetall":"a stale copy"}}', '{}', '{"2":{"keepall":false}}'],
    sends: 3,
    check({ llm, outcome, records, at }) {
      // Every send refuses index 2, so the correction is spent and lost: the
      // unit keeps, the record counts it under the CORRECTION's code (not the
      // earlier attempt's), and the pass still settles its round.
      assert.deepEqual(outcome.application?.refused.map(entry => [entry.index, entry.code]),
        [[2, 'malformed-row']], at('the correction\'s own refusal is the reported one'));
      const l2 = outcome.application?.removals.filter(removal => removal.origin === 'l2') ?? [];
      assert.equal(l2.length, 1, at('the accepted row is the only L2 removal'));
      // ISSUE-174: index 1 forgets the surviving copy of `big.txt`, which is the
      // only live copy of the bytes L1's stale-exact-reread proof named as its
      // survivor. The PROOF gives way, not the verdict (ADR-0006), so `r1` stays
      // and the cancellation is named rather than silently dropped.
      assert.equal(outcome.application?.removals.some(removal =>
        removal.origin === 'l1'), false, at('the contradicted L1 proof gives way'));
      assert.deepEqual(outcome.application?.cancellations?.map(entry =>
        [entry.origin, entry.rule, entry.reason]),
      [['l1', 'stale-exact-reread', 'survivor-removed']],
      at('the cancelled proof is recorded with its lane, rule and reason'));
      assert.equal(llm.calls.length, 3, at('one correction, never a loop'));
      const record = recordOf(records);
      assert.equal((record?.['refusedCount'] as Record<string, number>)['malformed-row'], 1,
        at('the correction\'s refusal is counted'));
      assert.equal((record?.['refusedCount'] as Record<string, number>)['missing-index'], 0,
        at('the earlier attempt\'s code is not what the record reports'));
      const line = correctionLine(records);
      assert.equal(line?.['corrected'], 0, at('the correction settled nothing'));
      assert.equal(line?.['stillRefused'], 1, at('the row was still refused'));
      assert.deepEqual(line?.['reasons'], ['2:missing-index'],
        at('the reason states why the correction was needed'));
      assert.equal(record?.['round'], 1, at('the pass still settled its round'));
      assert.equal(record?.['reason'], null, at('the pass names no refusal reason'));
    },
  },
  {
    name: 'whole-object failure',
    id: 's-correct-all',
    answers: ['not json at all', 'still not json',
      '{"1":{"keepall":true},"2":{"keepall":true}}'],
    sends: 3,
    check({ llm, outcome, records, at }) {
      // The first reply is not one JSON object, so every index refuses
      // `answer-unreadable`. The carry table re-asks all of them and fails the
      // same way; the correction then names BOTH rows and the whole-answer reason.
      const correction = correctionOf(llm.calls[2]);
      assert.ok(correction.length > 0, at('the third send is the correction turn'));
      const rowLines = correction.filter(line => /^\d+\. \[/u.test(line));
      assert.equal(rowLines.length, 2, at('both rows are re-asked'));
      assert.deepEqual(rowLines.map(line => line.slice(0, 2)), ['1.', '2.'],
        at('the same indices, in table order'));
      assert.equal(correction[0]?.includes('for 2 of 2 rows'), true,
        at(`the reason names the count: ${String(correction[0])}`));
      assert.equal(correction[0]?.includes('the answer was not readable JSON'), true,
        at('a whole-answer refusal names the answer, not a row'));
      assert.equal(outcome.application?.refused.length, 0, at('both answered on the correction'));
      assert.deepEqual(recordOf(records)?.['l2RemovalCount'],
        { keeplines: 0, forgetall: 0, forgetlines: 0 }, at('keepall removes nothing'));
    },
  },
  {
    name: 'same fork, one correction',
    id: 's-correct-fork',
    answers: ['{"1":{"forgetall":"a stale copy"}}', '{"2":{"keepall":false}}',
      '{"2":{"keepall":false}}', '{"2":{"keepall":true}}'],
    sends: 3,
    check({ llm, records, at }) {
      // The structural half: request 3 = request 1 + the refused reply + the
      // catch-up ask + the catch-up's reply + the correction. The fourth scripted
      // answer is never asked for, so the send count is the assertion.
      const first = llm.calls[0];
      const third = llm.calls[2];
      assert.ok(first !== undefined && third !== undefined, at('three requests left the seam'));
      const firstMessages = first.messages as readonly unknown[];
      const thirdMessages = third.messages as readonly unknown[];
      assert.equal(thirdMessages.length, firstMessages.length + 4,
        at('the correction rides four turns after the first ask'));
      assert.deepEqual(third.tools, first.tools, at('the tool list is frozen per fork'));
      const roles = thirdMessages.slice(firstMessages.length)
        .map(message => (message as { role: string }).role);
      assert.deepEqual(roles, ['assistant', 'user', 'assistant', 'user'],
        at('the reply, the catch-up ask, its reply, the correction turn'));
      // The correction restates no history: it carries the refused row and the
      // instruction, nothing of main's conversation.
      const correction = askTextOf(third);
      for (const message of MAIN.messages) {
        assert.equal(correction.includes(message.text), false,
          at(`the correction re-renders seed text: ${message.text}`));
      }
      // Exactly one correction line for the whole pass, however many rows it asked.
      const corrections = records.records.filter(record => record['kind'] === 'prune-correction');
      assert.equal(corrections.length, 1, at('one correction attempt per pass'));
    },
  },
  {
    name: 'halted ask',
    id: 's-correct-halt',
    answers: null,
    sends: 1,
    check({ llm, outcome, records, at }) {
      // The halt path writes no text, so no "your previous answer" claim is made.
      assert.equal(outcome.asks, 0, at('a halted table answered nothing'));
      // ISSUE-177: a halt decides nothing, so the record refuses nothing either.
      // This row used to expect two `answer-unreadable` refusals, which is what
      // made `refusedCount` report a decision the pass never made.
      assert.deepEqual(outcome.application?.refused.map(entry => entry.code), [],
        at('a halted row is deferred, never refused'));
      assert.equal(outcome.application?.removals.length, 1,
        at('only the plan\'s own L1 removal survives a halt'));
      assert.deepEqual(recordOf(records)?.['passAttempts'],
        { tables: 1, carried: 0, reasked: 0, finalRefusals: 0, deferred: 2 },
        at('both rows are counted as deferred'));
      const refusedCount = recordOf(records)?.['refusedCount'] as Record<string, number>;
      assert.equal(refusedCount['answer-unreadable'], 0,
        at('no row is counted under a refusal code on a halt'));
      assert.equal(llm.calls.length, 1, at('a halted table is not corrected'));
      assert.equal(records.records.some(record => record['kind'] === 'prune-correction'), false,
        at('no correction line exists'));
    },
  },
  {
    name: 'carried row',
    id: 's-carry',
    answers: ['{"1":{"forgetall":"a stale copy"}}', '{"2":{"forgetall":"an old copy"}}'],
    sends: 2,
    check({ llm, outcome, records, at }) {
      // Table 1 leaves index 2 unanswered, the core carries it, and the catch-up
      // table is APPENDED to the same fork, rendering only the carried row.
      assert.equal(outcome.asks, 2, at('both tables answered'));
      const firstMessages = llm.calls[0]?.messages as readonly unknown[] | undefined;
      const secondMessages = llm.calls[1]?.messages as readonly unknown[] | undefined;
      assert.ok(firstMessages !== undefined && secondMessages !== undefined,
        at('two requests left the seam'));
      assert.equal(secondMessages.length, firstMessages.length + 2,
        at('request 2 is request 1 plus the verdict and the next ask'));
      assert.equal(JSON.stringify(llm.calls[1]?.tools), JSON.stringify(llm.calls[0]?.tools),
        at('the tool list is frozen per session'));
      const verdict = secondMessages[firstMessages.length] as
        { role: string; content: { text: string }[] };
      assert.equal(verdict.role, 'assistant', at('the reply is the next appended turn'));
      assert.equal(verdict.content[0]?.text, '{"1":{"forgetall":"a stale copy"}}',
        at('the verdict turn carries the answer verbatim'));
      const catchUp = secondMessages[firstMessages.length + 1] as
        { role: string; content: { text: string }[] };
      assert.equal(catchUp.role, 'user', at('the catch-up is a user turn'));
      const catchUpText = catchUp.content[0]?.text ?? '';
      assert.match(catchUpText, /2\. \[read\] small\.txt \(call #1\) — line \d+ of \d+ ends with "/u,
        at('the carried row is asked again'));
      assert.equal(catchUpText.includes('1. [read] big.txt'), false,
        at('only the carried row; the answered one is not re-rendered'));
      const l2 = outcome.application?.removals.filter(removal => removal.origin === 'l2') ?? [];
      assert.deepEqual(l2.map(removal => removal.unitId),
        outcome.plan.askRows.map(row => row.unit.id), at('one verdict from each table'));
      assert.equal(outcome.application?.refused.length, 0, at('nothing was refused'));
      const record = recordOf(records);
      assert.deepEqual(record?.['l2RemovalCount'],
        { keeplines: 0, forgetall: 2, forgetlines: 0 }, at('one verdict from each table'));
      // The attempt telemetry is the REAL path's, not a hand-built stand-in
      // (ISSUE-022 chunk 6): table 1 asked two rows and answered one, so the core
      // carried one row and the catch-up table re-asked it at attempt 2.
      assert.deepEqual(record?.['passAttempts'],
        { tables: 2, carried: 1, reasked: 1, finalRefusals: 0, deferred: 0 },
        at('one carry, one re-ask'));
      const attempts = record?.['tableAttempts'] as
        readonly { tableUnits: number; attempt: number; answered: number }[];
      assert.deepEqual(attempts.map(entry => [entry.tableUnits, entry.attempt, entry.answered]),
        [[2, 1, 1], [1, 2, 1]], at('one entry per attempt group, at the re-ask ordinal'));
      assert.deepEqual(outcome.attempts?.tables, attempts,
        at('the outcome carries the same entries'));
      assert.deepEqual(outcome.attempts?.pass, record?.['passAttempts'],
        at('the outcome carries the same totals'));
    },
  },
  {
    name: 'unreadable answer',
    id: 's-bad-json',
    answers: ['{"1":{"keepall":tru'],
    sends: 3,
    check({ outcome, records, at }) {
      // The stream answered, so the merge ran: every ask row refuses as
      // unreadable and the plan's L1 removal still stands.
      assert.deepEqual(outcome.application?.refused.map(entry => entry.code),
        ['answer-unreadable', 'answer-unreadable'],
        at('every asked index is refused as unreadable'));
      assert.equal(outcome.application?.removals.length, 1,
        at('the plan\'s one L1 removal stands'));
      assert.equal(outcome.asks, 3, at('every send is counted, none of them readable'));
      const record = recordOf(records);
      assert.deepEqual(record?.['l1RemovalCount'],
        { 'stale-exact-reread': 1, 'closed-episode': 0, 'byte-identical-duplicates': 0 },
        at('L1 is counted and untouched'));
      assert.deepEqual(record?.['l2RemovalCount'],
        { keeplines: 0, forgetall: 0, forgetlines: 0 }, at('no L2 row removed anything'));
      assert.equal((record?.['refusedCount'] as Record<string, number>)['answer-unreadable'], 2,
        at('both rows are counted under the refusal code'));
    },
  },
  {
    name: 'dead stream',
    id: 's-stream-error',
    answers: [],
    sends: 1,
    deadStream: true,
    check({ outcome, records, at }) {
      // The socket dies before any text exists, so no answer is read at all and
      // nothing is decided: every pending index is DEFERRED (ISSUE-177), never
      // refused. This row used to expect two refusals — the defect itself.
      assert.deepEqual(outcome.application?.refused.map(entry => entry.code), [],
        at('a dead stream defers every pending index, it refuses none'));
      assert.equal(outcome.asks, 0, at('a dead stream answers nothing'));
      const skip = records.records.find(record => record['kind'] === 'prune-skip');
      assert.equal(skip?.['reason'], 'stream-error', at('the failed send is journaled'));
      const record = recordOf(records);
      assert.equal((record?.['refusedCount'] as Record<string, number>)['answer-unreadable'], 0,
        at('no row is counted under a refusal code on a dead stream'));
      assert.deepEqual(record?.['passAttempts'],
        { tables: 1, carried: 0, reasked: 0, finalRefusals: 0, deferred: 2 },
        at('both rows are counted as deferred'));
      assert.deepEqual(record?.['l2RemovalCount'],
        { keeplines: 0, forgetall: 0, forgetlines: 0 }, at('no L2 row removed anything'));
    },
  },
];

test('the correction turn and the catch-up table re-ask only what is still open', async () => {
  await runRows(ASK_SCENARIOS.map(askRow));
});

test('every paid send of a corrected pass journals its cost, correction included', async () => {
  // ISSUE-178: the bulk prune's asks are the lane's main spend, and before this
  // ticket `runTables` and `retryRefusedRows` received `reply.usage` and dropped
  // it. This walks the three-send scenario — table, catch-up table, correction —
  // with a seam that reports a `{type:'usage'}` chunk on every call, and pins
  // that each send leaves exactly one `prune-ask` record carrying the host's
  // reading in the entry lane's field names.
  const records = collector();
  const answers = ['{"1":{"forgetall":"a stale copy"}}', '{}', '{"2":{"keepall":false}}'];
  const calls: DshLlmStreamOptions[] = [];
  const llm: FakeLlm = {
    calls,
    stream(options) {
      calls.push(options);
      const ordinal = calls.length;
      const text = answers[Math.min(ordinal - 1, answers.length - 1)] ?? '';
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        // The host writes its accounting before the answer, as the live stream does.
        yield { type: 'usage',
          usage: { inputTokens: 1000 * ordinal, cacheReadTokens: 200 * ordinal, outputTokens: 5 } };
        for (const chunk of textChunks(text)) yield chunk;
      })();
    },
  };
  const setupResult = await setup('s-priced-correction', { llm, records });
  try {
    const outcome = await passOver(setupResult, { llm, records });
    assert.equal(calls.length, 3, 'table, catch-up, correction');
    const asks = records.records.filter(record => record['kind'] === 'prune-ask');
    assert.equal(asks.length, 3, 'one cost line per send, none dropped');
    assert.deepEqual(asks.map(entry => entry['tables']), [1, 2, 3],
      'each line names the table ordinal the pass journaled');
    assert.deepEqual(asks.map(entry => entry['retried'] === true), [false, false, true],
      'only the correction is the retried send');
    assert.deepEqual(asks.map(entry => (entry['usage'] as { inputTokens: number }).inputTokens),
      [1200, 2400, 3600], 'the reading is the whole billed prompt of that send');
    // The sum is what a meter reads: the prune lane's own cost for this pass.
    const pruneTokens = asks.reduce((total, entry) =>
      total + Number((entry['usage'] as { inputTokens: number }).inputTokens), 0);
    assert.equal(pruneTokens, 7200, 'the pass\'s measured prune spend');
    // The correction still settled nothing and the pass still settled its round.
    assert.equal(outcome.application?.refused.length, 1);
  } finally {
    await setupResult.mount.close();
  }
});


// --- the /prune entry -------------------------------------------------------

/** A mount over one session, with only the journal collected. */
function mountOver(session: ReturnType<typeof fakeSession>, llm?: FakeLlm) {
  const records = collector();
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20 }),
    storage: resolveStorage(undefined), journal: records.sink,
    ...llm === undefined ? {} : { llm },
  });
  return { records, mount };
}

test('the pass sends one ask over main\'s wire, moves nothing, and journals the same record twice',
  async () => {
    // The no-flatten claim, the mixed answer's counts and trailer, ADR-0020's
    // no-exclusion claim, record-only as a structural fact, and determinism: two
    // identical passes journal the same record.
    const answer = '{"1":{"forgetall":"a stale build log"},'
      + '"2":{"keeplines":[[1,2],"dropped the last two lines"]}}';
    const llm = fakeLlm(answer);
    const setupResult = await setup('s-mixed', { llm });
    // Two further mounts over the same seed, for the determinism half: its own
    // answer, because a keeplines row names a unit id that hashes the session.
    const twinAnswer = '{"1":{"keepall":true},"2":{"forgetall":"an old copy"}}';
    const first = await setup('s-deterministic-a', { llm: fakeLlm(twinAnswer) });
    const second = await setup('s-deterministic-b', { llm: fakeLlm(twinAnswer) });
    try {
      // Spy on the engine's own entry point: record-only must never reach it.
      let processed = 0;
      const original = setupResult.entry.engine.process.bind(setupResult.entry.engine);
      setupResult.entry.engine.process = async input => { processed += 1; return original(input); };
      const outcome = await passOver(setupResult, { llm, records: setupResult.records });
      // The ask covers L1's kept list: the stale copy of big.txt is proved out, so
      // the two rows are the surviving big.txt and the distinct read.
      assert.deepEqual(outcome.plan.askRows.map(row => row.index), [1, 2]);
      assert.equal('excluded' in outcome.plan, false, 'the plan carries no exclusion list');
      assert.deepEqual(outcome.plan.askRows.map(row => row.unit.id), outcome.plan.l1.kept,
        'every L1-kept unit is a row');
      assert.equal(outcome.asks, 1);
      assert.equal(llm.calls.length, 1);
      // ISSUE-174: index 1 forgets the surviving `big.txt`, the only live copy of
      // the bytes L1 proved the earlier read a duplicate of, so L1's proof gives
      // way (ADR-0006) and is recorded as cancelled. The two judged removals
      // still apply; nothing else changes.
      assert.equal(outcome.application?.removals.length, 2, 'two L2 removals, L1 cancelled');
      assert.deepEqual(outcome.application?.cancellations?.map(entry =>
        [entry.origin, entry.rule, entry.reason]),
      [['l1', 'stale-exact-reread', 'survivor-removed']],
      'the cancelled L1 proof is named');

      const record = recordOf(setupResult.records);
      assert.ok(record !== undefined, 'the pass journals prune-recorded');
      // The cancelled proof is not counted: the record counts what was ACTED on.
      assert.deepEqual(record['l1RemovalCount'],
        { 'stale-exact-reread': 0, 'closed-episode': 0, 'byte-identical-duplicates': 0 });
      assert.deepEqual(record['l2RemovalCount'], { keeplines: 1, forgetall: 1, forgetlines: 0 });
      assert.deepEqual(record['refusedCount'],
        { 'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
          'answer-not-an-object': 0, 'answer-unreadable': 0, 'action-not-in-grammar': 0,
          'spans-outside-result': 0 });
      assert.equal(record['rejectedCount'], 0);
      assert.equal(record['reason'], null);
      assert.deepEqual(record['estTokens'], outcome.record.estTokens);
      // The keeplines trailer is surfaced verbatim, beside its unit id.
      const summaries = record['keeplinesSummaries'] as { unitId: string; summary: string }[];
      assert.deepEqual(summaries.map(entry => entry.summary), ['dropped the last two lines']);
      assert.equal(summaries[0]?.unitId, outcome.keeplinesSummaries[0]?.unitId);

      // Record-only: the ask is the only model call and nothing was mutated.
      assert.equal(setupResult.mutationSpy.applies, 0, 'no application was attempted');
      assert.equal(setupResult.mutationSpy.setTranscript, 1, 'only the test\'s own sync');
      assert.equal(setupResult.appendSpy.appends, 0, 'the whole pass appended nothing');
      assert.equal(processed, 0, 'no engine event was sent');
      assert.deepEqual(telemetryOf(setupResult.records)
        .filter(event => event.kind === 'verdict-recorded'), [], 'no engine verdict event');

      // THE NO-FLATTEN ASSERT: the request is main's wire state, untouched, plus
      // one appended user turn. Canonical bytes, not a shape comparison.
      const sent = llm.calls[0];
      assert.ok(sent !== undefined, 'one request left the seam');
      assert.equal(sent.system, MAIN_SYSTEM, 'the system slot is main\'s, byte for byte');
      assert.deepEqual(sent.tools, MAIN_TOOLS, 'the tool list is main\'s, byte for byte');
      const messages = sent.messages as readonly { role: string; content: { text: string }[] }[];
      assert.equal(messages.length, MAIN.messages.length + 1, 'seed + one appended ask');
      assert.deepEqual(
        messages.slice(0, MAIN.messages.length).map(message =>
          [message.role, message.content[0]?.text]),
        MAIN.messages.map(message => [message.role === 'tool' ? 'user' : message.role, message.text]),
        'the seed history arrives as its own message prefix, unmodified',
      );
      const ask = messages[MAIN.messages.length];
      assert.ok(ask !== undefined);
      assert.equal(ask.role, 'user', 'the ask is a NEW user turn');
      const askText = ask.content[0]?.text ?? '';
      // The contract, the table and the final line all ride INSIDE the ask.
      assert.ok(askText.includes(PRUNE_ASK_SYSTEM_PROMPT), 'the contract is in the ask');
      // A row carries the shared anchor format, not a quoted excerpt.
      assert.match(askText, /1\. \[read\] big\.txt \(call #1\) — line \d+ of \d+ ends with "/u);
      assert.match(askText, /2\. \[read\] small\.txt \(call #1\) — line \d+ of \d+ ends with "/u);
      assert.ok(askText.endsWith(PRUNE_ASK_FINAL_LINE), 'the final line closes the ask');
      // NO FLATTENING: not one seed message's text is repeated inside the ask.
      for (const message of MAIN.messages) {
        assert.equal(askText.includes(message.text), false,
          `the ask re-renders seed text: ${message.text}`);
      }
      // The table names lines, never a whole body: an anchor is a short tail, so
      // the table stays a fraction of the 2560-byte unit.
      const tableStart = askText.indexOf('Units still in memory');
      assert.ok(tableStart > 0);
      assert.ok(askText.slice(tableStart).length < OVERSIZED.length / 2,
        'anchors, not the whole body');
      // The fork's root is main's request hash, journaled at the seed.
      const seedRecord = setupResult.records.records.find(entry => entry['kind'] === 'prune-seed');
      assert.equal(seedRecord?.['seedHash'], wireRequestHash(MAIN),
        'the fork root is main\'s last sent request');

      // Determinism: two identical passes journal the same record, and the two
      // journal rows differ only by the mount's session id.
      const a = await passOver(first, { llm: fakeLlm(twinAnswer), records: first.records });
      const b = await passOver(second, { llm: fakeLlm(twinAnswer), records: second.records });
      assert.deepEqual(a.record, b.record, 'the same pass journals the same record');
      const strip = (row: { [field: string]: unknown } | undefined): string => {
        const { sessionId: _sessionId, ...rest } = row ?? {};
        return JSON.stringify(rest);
      };
      assert.equal(strip(recordOf(second.records)), strip(recordOf(first.records)),
        'only the session id differs between two identical passes');
    } finally {
      await setupResult.mount.close();
      await first.mount.close();
      await second.mount.close();
    }
  });

/**
 * The two refusals that never send: no `llm` seam, and no captured main request
 * to seed a fork from. Both keep L1's provable layer, count no judged row, and
 * name their reason; only the reason and the journal kind differ.
 */
const NO_ASK_SCENARIOS: readonly {
  readonly name: string;
  readonly id: string;
  /** Whether a mounted `llm` exists at all. */
  readonly seam: boolean;
  /** The refusal the pass names. */
  readonly reason: string;
  /** The journal kind that carries the refusal. */
  readonly kind: string;
}[] = [
  { name: 'no llm seam', id: 's-no-llm', seam: false, reason: 'no-llm-service',
    kind: 'prune-off' },
  { name: 'no captured seed', id: 's-no-seed', seam: true, reason: 'no-seed',
    kind: 'prune-unseeded' },
];

test('a pass that cannot ask still records L1 and names its reason', async () => {
  await runRows(NO_ASK_SCENARIOS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const llm = fakeLlm('{"1":{"keepall":true}}');
      const setupResult = await setup(scenario.id, scenario.seam ? { llm } : {});
      try {
        // A pass with a seam but no capture has no fork root: `setup` installed
        // the mount's own capture, so this row hands `seed: null` instead and
        // syncs the transcript the way a live pre-step would.
        setupResult.mount.syncTranscript(setupResult.entry, setupResult.session);
        const outcome = scenario.seam
          ? await runRecordOnlyPrune({
            sessionId: setupResult.entry.sessionId,
            snapshot: await setupResult.entry.port.snapshot(),
            transcript: setupResult.entry.port.transcript(),
            round: 1, barBytes: 64, episodeNoNewPathSteps: null, llm,
            route: () => ({ provider: 'a6', model: 'prune-model' }),
            seed: () => null,
            journal: setupResult.records.journal,
          })
          : await passOver(setupResult, { records: setupResult.records });
        assert.equal(outcome.application, null, at('nothing was judged'));
        assert.equal(outcome.refusedFor, scenario.reason, at('the reason is named'));
        assert.equal(outcome.asks, 0, at('no table was answered'));
        assert.equal(llm.calls.length, 0, at('no request left the seam'));
        const line = setupResult.records.records.find(record => record['kind'] === scenario.kind);
        assert.equal(line?.['reason'], scenario.reason, at('the refusal is journaled by name'));
        const record = recordOf(setupResult.records);
        assert.equal(record?.['reason'], scenario.reason, at('the record carries the reason'));
        // The provable layer still stands, and no judged count is claimed.
        assert.deepEqual(record?.['l1RemovalCount'],
          { 'stale-exact-reread': 1, 'closed-episode': 0, 'byte-identical-duplicates': 0 },
          at('L1 is counted and stands'));
        assert.deepEqual(record?.['l2RemovalCount'],
          { keeplines: 0, forgetall: 0, forgetlines: 0 }, at('no L2 row removed anything'));
        assert.deepEqual(record?.['refusedCount'],
          { 'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
            'answer-not-an-object': 0, 'answer-unreadable': 0, 'action-not-in-grammar': 0,
            'spans-outside-result': 0 },
          at('no index was refused, because none was asked'));
        // No table was sent, so no attempt exists: an empty list and four zeros,
        // never a fabricated table (ISSUE-022 chunk 6).
        assert.deepEqual(record?.['tableAttempts'], [], at('no table attempt was journaled'));
        assert.deepEqual(record?.['passAttempts'],
          { tables: 0, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 },
          at('the attempt totals are four zeros'));
        assert.equal(outcome.attempts, null, at('the outcome names no attempts'));
        assert.equal(setupResult.mutationSpy.applies, 0, at('nothing was applied'));
      } finally {
        await setupResult.mount.close();
      }
    },
  })));
});

// --- the bulk ask's grammar (ISSUE-221) -------------------------------------

test('pruneAskGrammar: nokeepall reaches the ask, its rows and the merge', async () => {
  // Both rows answer the keep-whole form: a `keeplines` over the row's own
  // `1..L`. The plan, the ask and the merge must all state `nokeepall`; a
  // whole-range keep removes nothing, so no L2 removal is counted. The reply is
  // one JSON object per line, the shape the jsonl-20-nokeepall ask teaches.
  const answer = '{"1":{"keeplines":[[1,40]],"summary":"the whole build log stays"}}\n'
    + '{"2":{"keeplines":[[1,6]],"summary":"None"}}';
  const llm = fakeLlm(answer);
  const setupResult = await setup('s-nokeepall', { llm });
  try {
    const outcome = await passOver(setupResult, { llm, records: setupResult.records,
      grammar: 'nokeepall' });
    assert.equal(outcome.plan.grammar, 'nokeepall', 'the plan carries the grammar');
    assert.equal(outcome.asks, 1, 'one table answered');
    // The ask IS the entry jsonl-20-nokeepall message: its pre-table contract,
    // each row's own [L], and its post-table repeat closed by the end anchor.
    const sent = llm.calls[0];
    assert.ok(sent !== undefined, 'one request left the seam');
    const messages = sent.messages as readonly { content: { text: string }[] }[];
    const askText = messages[messages.length - 1]?.content[0]?.text ?? '';
    // The contract's own bytes up to its table slot, which the table replaced.
    const contract = PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT.slice(0,
      PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
    assert.ok(askText.startsWith(contract), 'the nokeepall contract opens the ask');
    assert.equal(askText.includes(PRUNE_ASK_SYSTEM_PROMPT), false,
      'the 3option contract is not');
    assert.ok(askText.includes(PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT),
      'the post-table repeat closes the ask');
    assert.ok(askText.endsWith(ENTRY_ASK_END_ANCHOR), 'the end anchor is last');
    assert.equal(askText.includes(PRUNE_ASK_FINAL_LINE), false);
    assert.match(askText, /1\. \[read\] big\.txt \(call #1\) — .* \[40 lines\]$/mu);
    assert.match(askText, /2\. \[read\] small\.txt \(call #1\) — .* \[6 lines\]$/mu);
    assert.equal(askText.includes('"keepall"'), false, 'the grammar never teaches keepall');
    // A whole-range keep is not a removal, and it is not a refusal either.
    assert.equal(outcome.application?.removals.filter(removal => removal.origin === 'l2').length,
      0, 'no L2 removal was planned');
    assert.equal(outcome.application?.refused.length, 0, 'no row was refused');
    const record = recordOf(setupResult.records);
    assert.deepEqual(record?.['l2RemovalCount'],
      { keeplines: 0, forgetall: 0, forgetlines: 0 });
    assert.deepEqual(record?.['refusedCount'],
      { 'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
        'answer-not-an-object': 0, 'answer-unreadable': 0, 'action-not-in-grammar': 0,
        'spans-outside-result': 0 });
    // The estimate priced the table under the same grammar the rows stated: the
    // nokeepall rows carry their `[L line(s)]`, so the same table costs more
    // bytes than the identical 3option table.
    const twoVerdictTokens = (record?.['estTokens'] as { askTableTokens: number })
      .askTableTokens;
    assert.ok(twoVerdictTokens > 0);
    const shippedRecords = collector();
    // ADR-0056: `3option` is named explicitly; it is no longer the absent-value
    // default, so the comparison must not lean on a helper fallback.
    const shipped = await passOver(setupResult, {
      llm: fakeLlm('{"1":{"keepall":true},"2":{"keepall":true}}'), records: shippedRecords,
      grammar: '3option' });
    assert.equal(shipped.plan.grammar, '3option', 'the second pass names the 3option grammar');
    const shippedTokens = (recordOf(shippedRecords)?.['estTokens'] as { askTableTokens: number })
      .askTableTokens;
    assert.ok(twoVerdictTokens > shippedTokens,
      'the nokeepall table is priced with its [L] suffixes, the 3option one without');
  } finally {
    await setupResult.mount.close();
  }
});

test('nokeepall: a partial keeplines reaches the apply path as its own removal', async () => {
  // Both rows keep only part of their lines, so each answer removes the rest.
  // The reader hands the partial ranges through unchanged and the merge counts
  // them as `keeplines` removals.
  const llm = fakeLlm('{"1":{"keeplines":[[1,20]],"summary":"keep half the log"}}\n'
    + '{"2":{"keeplines":[[1,3]],"summary":"the first lines only"}}');
  const setupResult = await setup('s-nokeepall-partial', { llm });
  try {
    const outcome = await passOver(setupResult, { llm, records: setupResult.records,
      grammar: 'nokeepall' });
    assert.equal(outcome.asks, 1, 'one table answered');
    assert.equal(outcome.application?.refused.length, 0, 'no row was refused');
    const removals = outcome.application?.removals.filter(removal => removal.origin === 'l2')
      ?? [];
    assert.equal(removals.length, 2, 'both partial keeps removed their complement');
    assert.deepEqual(recordOf(setupResult.records)?.['l2RemovalCount'],
      { keeplines: 2, forgetall: 0, forgetlines: 0 });
  } finally {
    await setupResult.mount.close();
  }
});

// --- the settled set (ISSUE-073) --------------------------------------------

/** The fixture result's entry-seam id, as the mount's `entryKept` carries it. */
const SETTLED_C3 = 'dsh:s-settled:result:c3';

/**
 * The settled set, all three edges in one table: a settled keep is withheld, an
 * id naming no unit of this pass withholds nothing, and a keep a later write
 * invalidated is listable again. Only the third needs its own fixture (a read
 * then a write over one path), so it names a `fixture` the row builds instead of
 * the shared seed.
 */
const SETTLED_SCENARIOS: readonly {
  readonly name: string;
  readonly id: string;
  /** The mount's answer, one per remaining row. */
  readonly answer: string;
  /** The ids this pass is told are settled. */
  readonly settled: (id: string) => readonly string[];
  /** A fixture of its own, when the shared seed cannot produce the state. */
  readonly fresh: boolean;
  check(context: {
    readonly outcome: Awaited<ReturnType<typeof runRecordOnlyPrune>>; readonly at: Label;
  }): void;
}[] = [
  {
    name: 'settled keep withheld',
    id: 's-settled',
    answer: '{"1":{"keepall":true}}',
    settled: () => [SETTLED_C3],
    fresh: false,
    check({ outcome, at }) {
      // `c1` is the copy L1 proves stale, so it can never be a row; `c2` is the
      // surviving big.txt read and `c3` the distinct one. Settle only `c3`.
      const settledUnit = outcome.plan.units.find(unit => unit.nodeId === SETTLED_C3);
      assert.ok(settledUnit !== undefined, at('the settled node has a unit'));
      assert.deepEqual(outcome.plan.settledWithheld, [settledUnit.id],
        at('the settled unit is withheld from the ask'));
      assert.equal(outcome.plan.askRows.some(row => row.unit.id === settledUnit.id), false,
        at('no row names the settled unit'));
      assert.deepEqual(outcome.plan.askRows.map(row => row.unit.nodeId),
        ['dsh:s-settled:result:c2'], at('the unsettled unit is still listed'));
      // L1 is untouched: the withheld unit is still in the plan's own unit list
      // and L1's proof over `c1` still stands.
      assert.equal(outcome.plan.units.some(unit => unit.id === settledUnit.id), true,
        at('a withheld unit stays in the plan\'s unit list'));
      assert.equal(outcome.plan.l1.removals.length, 1, at('L1 still proves the stale copy'));
    },
  },
  {
    name: 'foreign id',
    id: 's-settled-foreign',
    answer: '{"1":{"keepall":true},"2":{"keepall":true}}',
    settled: () => ['dsh:someone-else:result:c9'],
    fresh: false,
    check({ outcome, at }) {
      assert.deepEqual(outcome.plan.settledWithheld, [], at('nothing here settled'));
      assert.equal(outcome.plan.askRows.length, outcome.plan.l1.kept.length,
        at('every kept unit is still a row'));
    },
  },
  {
    name: 'invalidated by a later write',
    id: 's-settled-write',
    answer: '{"1":{"keepall":true}}',
    settled: () => ['dsh:s-settled-write:result:c1'],
    fresh: true,
    check({ outcome, at }) {
      // `small.txt` is read (a unit), then WRITTEN: the read's bytes are a stale
      // copy, so the entry keep no longer settles anything about that path. The
      // read's `meta.lines` is what makes it a HIT, which is the only shape a
      // write can invalidate (`holdsFileBytes`, PRD §6.7).
      const readUnit = outcome.plan.units.find(unit =>
        unit.nodeId === 'dsh:s-settled-write:result:c1');
      assert.ok(readUnit !== undefined, at('the invalidated read still has a unit'));
      assert.deepEqual(outcome.plan.settledWithheld, [],
        at('an invalidated unit is not settled any more'));
      assert.equal(outcome.plan.askRows.some(row => row.unit.id === readUnit.id), true,
        at('the invalidated unit is listed again'));
    },
  },
];

test('the settled set withholds only the units that still settle', async () => {
  await runRows(SETTLED_SCENARIOS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const llm = fakeLlm(scenario.answer);
      // The third row's state cannot come from the shared seed: one read then a
      // write over the same path, which is what unsets the entry keep.
      const session = fakeSession(scenario.id);
      if (scenario.fresh) {
        seedRead(session, { turn: 1, callId: 'c1', target: 'small.txt', body: DISTINCT,
          meta: { path: 'small.txt', offset: 1, lines: [{ number: 1, text: 'x' }] } });
        seedWrite(session, { turn: 2, callId: 'w1', target: 'small.txt' });
      } else {
        seedFixture(session);
      }
      const records = collector();
      const mount = createRacoonsMount({
        config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20,
          episodeNoNewPathSteps: null }),
        storage: resolveStorage(undefined), journal: records.sink, llm,
      });
      try {
        const entry = await mount.sessionFor(session.id, session);
        for (const event of session.log) mount.observe(session, event);
        mount.syncTranscript(entry, session);
        const outcome = await runRecordOnlyPrune({
          sessionId: entry.sessionId,
          snapshot: await entry.port.snapshot(),
          transcript: entry.port.transcript(),
          round: 1, barBytes: 64, episodeNoNewPathSteps: null, llm,
          settledNodeIds: new Set(scenario.settled(scenario.id)),
          route: () => ({ provider: 'a6', model: 'prune-model' }),
          // The shared seed's own capture is what the mount holds; a fresh
          // fixture has none, and neither row needs a fork to plan.
          seed: scenario.fresh ? () => null : () => null,
          journal: records.journal,
        });
        scenario.check({ outcome, at });
        if (scenario.name !== 'settled keep withheld') return;
        const plan = records.records.find(record => record['kind'] === 'prune-plan');
        assert.equal(plan?.['settledWithheld'], 1, at('the journal states the withholding'));
        assert.equal(plan?.['askRows'], 1, at('the journal counts the one ask row'));
      } finally {
        await mount.close();
      }
    },
  })));
});

// --- the pass's ONE route snapshot (ISSUE-349) ------------------------------

test('one route snapshot per pass: a mid-pass config change cannot redirect the correction',
  async () => {
    // The three-send correction script: table 1 answers index 1, the catch-up
    // refuses index 2, the correction settles it. The route getter hands config
    // A to the FIRST read and config B to every later one, so a pass that reads
    // the route per consumer sends its table and its correction to B while the
    // refusal check saw A. The pass must read ONCE and ride that snapshot.
    const llm = fakeLlm(['{"1":{"forgetall":"a stale copy"}}',
      '{"2":{"keepall":false}}', '{"2":{"forgetall":"an old read"}}']);
    const setupResult = await setup('s-route-snapshot', { llm });
    try {
      setupResult.mount.syncTranscript(setupResult.entry, setupResult.session);
      let reads = 0;
      const outcome = await runRecordOnlyPrune({
        sessionId: setupResult.entry.sessionId,
        snapshot: await setupResult.entry.port.snapshot(),
        transcript: setupResult.entry.port.transcript(),
        round: 1, barBytes: 64, episodeNoNewPathSteps: null, llm,
        route: () => {
          reads += 1;
          return reads === 1 ? { provider: 'a6', model: 'prune-model' }
            : { provider: 'b7', model: 'other-model' };
        },
        seed: setupResult.seed,
        journal: setupResult.records.journal,
      });
      assert.equal(reads, 1, 'the pass reads the route once, not per consumer');
      assert.equal(llm.calls.length, 3, 'table, catch-up, correction');
      assert.ok(correctionOf(llm.calls[2]).length > 0, 'the third send is the correction');
      for (const [index, call] of llm.calls.entries()) {
        assert.equal(call.provider, 'a6',
          `send ${String(index + 1)} rides the snapshot's provider`);
        assert.equal(call.model, 'prune-model',
          `send ${String(index + 1)} rides the snapshot's model`);
      }
      assert.equal(outcome.refusedFor, null, 'the snapshot route is configured');
      assert.equal(outcome.application?.refused.length, 0, 'the correction answered');
    } finally {
      await setupResult.mount.close();
    }
  });

test('a throwing route getter is contained as a journaled off outcome, never a throw',
  async () => {
    // The getter throws on its first read. Before the fix the throw escaped
    // `refusalOf` and only the mount's catch contained it, leaving the pass
    // unjournaled. The pass must fail open: a named refusal, the off line, the
    // record, and L1's provable layer still standing.
    const llm = fakeLlm('{"1":{"keepall":true}}');
    const setupResult = await setup('s-route-throws', { llm });
    try {
      setupResult.mount.syncTranscript(setupResult.entry, setupResult.session);
      const outcome = await runRecordOnlyPrune({
        sessionId: setupResult.entry.sessionId,
        snapshot: await setupResult.entry.port.snapshot(),
        transcript: setupResult.entry.port.transcript(),
        round: 1, barBytes: 64, episodeNoNewPathSteps: null, llm,
        route: () => { throw new Error('route config exploded'); },
        seed: setupResult.seed,
        journal: setupResult.records.journal,
      });
      assert.equal(outcome.refusedFor, 'not-configured', 'the throw fails open as a refusal');
      assert.equal(outcome.application, null, 'nothing was judged');
      assert.equal(outcome.asks, 0, 'no table was answered');
      assert.equal(llm.calls.length, 0, 'no request left the seam');
      const off = setupResult.records.records.find(record => record['kind'] === 'prune-off');
      assert.equal(off?.['reason'], 'not-configured', 'the off line names the refusal');
      assert.equal(off?.['message'], 'route config exploded',
        'the getter\'s own error is journaled, not swallowed');
      const record = recordOf(setupResult.records);
      assert.equal(record?.['reason'], 'not-configured', 'the record carries the reason');
      assert.deepEqual(record?.['l1RemovalCount'],
        { 'stale-exact-reread': 1, 'closed-episode': 0, 'byte-identical-duplicates': 0 },
        'L1 is counted and stands');
    } finally {
      await setupResult.mount.close();
    }
  });

/**
 * The trigger is exact-whole-message (`plugin.ts`): `textOf(...).trim()`
 * compared for equality with `/cremate`. A sentence that contains the command
 * never fires; a message padded with whitespace still does.
 */
interface TriggerScenario {
  readonly name: string;
  /** User messages to append, one after the other: the row's own shapes. */
  readonly messages: readonly string[];
  /** Whether the last message must be recognised as the command. */
  readonly fires: boolean;
  /**
   * Whether this row mounts a model seam and a captured main request, so the
   * pre-step runs a real forked pass instead of naming the missing seam.
   */
  readonly seeded: boolean;
}

const TRIGGER_SCENARIOS: readonly TriggerScenario[] = [
  { name: 'inside a sentence', messages: ['run /prune'], fires: false, seeded: false },
  { name: 'after a sentence', messages: ['please /prune'], fires: false, seeded: false },
  { name: 'padded with whitespace', messages: [`  ${PRUNE_COMMAND}  `], fires: true,
    seeded: false },
  { name: 'on the fork', messages: [PRUNE_COMMAND], fires: true, seeded: true },
];

test('the /prune trigger fires on the whole message only, and runs on the fork', async () => {
  await runRows(TRIGGER_SCENARIOS.map((scenario, position): Row => ({
    name: scenario.name,
    async run(at) {
      const session = fakeSession(`s-trigger-${String(position)}`);
      seedFixture(session);
      // A seeded row mounts a model seam, so the pre-step runs a real pass over
      // main's captured request; the others mount none, so the pass can only
      // name the missing seam.
      // The reply is the jsonl-20 shape: one object per row per line. A literal
      // `keepall` is a terminal `action-not-in-grammar` refusal under the
      // shipped `nokeepall` grammar, so it keeps the unit without a verdict.
      const llm = fakeLlm(['{"1":{"keepall":true}}\n{"2":{"keepall":true}}\n'
        + '{"3":{"forgetall":true,"summary":"an old copy"}}']);
      const records = collector();
      const mount = createRacoonsMount({
        config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20 }),
        storage: resolveStorage(undefined), journal: records.sink,
        ...scenario.seeded ? { llm } : {},
      });
      try {
        const entry = await mount.sessionFor(session.id, session);
        mount.syncTranscript(entry, session);
        if (scenario.seeded) {
          // Main's last dispatched request, captured where the host hands it over.
          mount.observeWire({ sessionId: session.id, ...HOST_MAIN });
        }
        for (const event of session.log) mount.observe(session, event);
        let appended: DshMountEvent | undefined;
        for (const [index, text] of scenario.messages.entries()) {
          const before = session.seq ?? 0;
          appended = session.append('user/message', {
            content: [{ type: 'text', text }], source: { kind: 'user' },
            role: 'user', id: `user-trigger-${String(position)}-${String(index)}`,
          }, { surfaceOp: 'append' });
          mount.observe(session, appended);
          assert.equal(session.log.length, before + 1,
            at('observing the message appends nothing'));
          assert.equal(records.records.some(record => record['kind'] === 'prune-requested'),
            scenario.fires, at(`"${text}" is${scenario.fires ? '' : ' not'} the whole message`));
        }
        // The judge may append its own receipt, so this row counts no host
        // appends; the record-only proof lives where the pass runs alone.
        const stepResult = await mount.runStep(session, { turn: 4, step: 1 });
        const passes = records.records.filter(record => record['kind'] === 'prune-recorded');
        assert.equal(passes.length, scenario.fires ? 1 : 0,
          at(`"${scenario.messages.join('" then "')}" ${scenario.fires ? 'ran' : 'ran no'} pass`));
        if (!scenario.fires) return;
        if (!scenario.seeded) {
          assert.equal(passes[0]?.['reason'], 'no-llm-service',
            at('the mounted pass names the missing seam'));
          assert.deepEqual(passes[0]?.['l2RemovalCount'],
            { keeplines: 0, forgetall: 0, forgetlines: 0 }, at('no row removed anything'));
          return;
        }
        // The command's pass ran on the fork: main's system slot, the ask appended.
        assert.equal(passes[0]?.['round'], 1, at('the pre-step ran the pass at round 1'));
        assert.equal(passes[0]?.['asks'], 1, at('the pass sent one table'));
        assert.deepEqual(passes[0]?.['l2RemovalCount'],
          { keeplines: 0, forgetall: 1, forgetlines: 0 }, at('the one forgetall was counted'));
        const pruneCall = llm.calls.find(call =>
          textOfMessage((call.messages as readonly unknown[]).at(-1))
            .endsWith(ENTRY_ASK_END_ANCHOR));
        assert.ok(pruneCall !== undefined, at('the prune ask left the seam'));
        assert.equal(pruneCall.system, MAIN_SYSTEM,
          at('no system-slot replacement on the live path'));
        // No publication follows a record-only pass, and the command is not
        // re-processed on the next step.
        assert.equal(stepResult.appendRequest, null, at('nothing was published'));
        await mount.runStep(session, { turn: 4, step: 2 });
        const again = records.records.filter(record => record['kind'] === 'prune-recorded');
        assert.equal(again.length, 1, at('one command, one pass'));
        assert.equal(appended?.type, 'user/message', at('the command row is a user message'));
      } finally {
        await mount.close();
      }
    },
  })));
});
