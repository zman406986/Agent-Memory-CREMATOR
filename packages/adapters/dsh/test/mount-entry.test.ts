/**
 * The mount's entry checkpoint (ISSUE-058 chunk P3c-2; ADR-0022 §1–§6, §11–§14;
 * ADR-0025 §1–§6).
 *
 * These tests drive the REAL engine, adapter and port through the real mount
 * with a fake host session and a fake model seam. What they pin, one claim per
 * test, each where it can fail:
 *
 *   1. an over-floor result is asked exactly once, seeded from the wire state
 *      AFTER the result landed (main's capture, then the result turn, then the
 *      ask) and the ask never carries the body;
 *   2. an under-floor result is never asked: zero sends, zero journal line;
 *   3. an answered keep-all rewinds the exchange, leaves the result's bytes and
 *      id untouched, and marks the result so a redelivery cannot re-ask it;
 *   4. an answered forget lands ONE shaped turn — the answer's summary above the
 *      kept partials — and the dropped body is bankable byte-exact by recall id;
 *   5. every ask refusal fails open: the result stays whole, nothing is applied,
 *      and the breaker is never touched;
 *   6. a disabled breaker stands the ask lane down with `entry-ask-off`, before
 *      any send;
 *   7. two over-floor results in one step are asked sequentially, one each;
 *   8. a result between the floor and the bulk bar is asked and bankable — the
 *      floor is the entry gate, the bar is the bulk-prune gate (ADR-0020 §3);
 *   9. a result over the bulk bar is asked ONCE and NO gate is ever offered the
 *      step the checkpoint owns, so no later seam can forget what the agent
 *      kept. With the judge pass gone (ADR-0028) this is an absolute claim: the
 *      journal carries no `gate-*` telemetry and no `judge` line at all.
 *  10. `entryAskTrigger: {mode: "off"}` — and an absent trigger, which resolves
 *      to it — is the product configuration (ADR-0050 decision 4): no ask is
 *      sent, every eligible result is journaled `entry-ask-off` with reason
 *      `configured-off`, and it lands whole.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { ENTRY_ASK_END_ANCHOR, PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT,
  PRUNE_ASK_JSONL_20_SLOT, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT,
  PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT, UnitTracker, sha256Sync } from '@cremator/core';
import type {
  EntryAskGrammar, Ledger, LedgerEntry, LedgerEvent,
  PreparableApplication, PreparedIntent, RecallRecord,
} from '@cremator/core';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession,
  RacoonsEntryAskTriggerConfig,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';

const ROUTE = { provider: 'p', model: 'm' };

/** Main's last dispatched request, as the host's waterfall hands it over. */
const MAIN_WIRE = {
  system: 'MAIN SYSTEM PROMPT',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.txt' }] }],
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
  /** ISSUE-432: switch the route the next `requestHeader()` reports. */
  setRoute(next: { readonly provider: string; readonly model: string }): void;
}

/**
 * A minimal fake dsh Session: an append-only log with surface markers, a surface
 * node list, `eventAt`, `seq`, and frozen payloads — the host behaviour the
 * mount is written against (the same harness `plugin.test.ts` drives).
 */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  let route = { ...ROUTE };
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    requestHeader: () => ({ config: { provider: route.provider, model: route.model } }),
    setRoute(next: { readonly provider: string; readonly model: string }) {
      route = { provider: next.provider, model: next.model };
    },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) {
          throw new Error(`surface replace: seq out of surface (${String(op.startSeq)}..${String(op.endSeq)})`);
        }
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options['sourceEventSeqs'];
      const event: DshMountEvent = Object.freeze({
        type, seq, data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined ? {}
          : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) },
      });
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

/** One tool result body of `lines` lines, each with a unique leading marker. */
function bodyOf(lines: number, tag = 'BODY', width = 24): string {
  return `${Array.from({ length: lines }, (_, index) =>
    `${tag}-${String(index + 1)} ${'x'.repeat(width)}`).join('\n')}\n`;
}

/**
 * Append one scripted step holding one `tool/call` per result. The bodies and
 * call ids are the caller's, so a step can hold two results.
 *
 * The user turn's text is `MAIN_WIRE`'s, because the mount seeds the ask from
 * the LIVE SURFACE (ISSUE-058 chunk P3d) and the surface is what main sends: a
 * fixture whose surface and capture disagree would test a state the host cannot
 * produce. A skipped surface node here is a surface main never sent.
 */
function step(session: FakeSession, params: {
  turn: number;
  step: number;
  results: readonly { readonly callId: string; readonly body: string }[];
}): number[] {
  const resultSeqs: number[] = [];
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('system/message', { turn: params.turn, step: params.step,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' }, id: `sys-${String(params.turn)}-${String(params.step)}` } },
  { surfaceOp: 'append' });
  session.append('user/message', { content: [{ type: 'text', text: 'read big.txt' }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` },
  { surfaceOp: 'append' });
  for (const result of params.results) {
    const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
      callId: result.callId, name: 'read',
      arguments: JSON.stringify({ file_path: `${result.callId}.txt` }) }).seq;
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: result.callId, name: 'read',
          arguments: JSON.stringify({ file_path: `${result.callId}.txt` }) }],
        id: `asst-${result.callId}` } },
    { surfaceOp: 'append' });
    resultSeqs.push(session.append('tool/result', { turn: params.turn, step: params.step,
      message: { role: 'tool', source: { kind: 'tool', callId: result.callId },
        toolCallId: result.callId,
        content: [{ type: 'text', text: result.body }],
        isError: false, id: `result-${result.callId}` } },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] }).seq);
  }
  session.append('step/end', { turn: params.turn, step: params.step });
  return resultSeqs;
}

/**
 * Replace one landed result's surface content in place — a host trim, our own
 * prune, or a dedupe rewrite (ISSUE-188). The result node id is minted from the
 * call id, so the transcript still names the same result while its bytes differ.
 * The replacement is published with a `surfaceOp` object, so the mount's
 * `observe` does NOT treat it as a new landing: only the live transcript moves.
 */
function trimResultOnSurface(session: FakeSession, seq: number, params: {
  readonly callId: string; readonly body: string; readonly turn: number; readonly step: number;
}): void {
  session.append('tool/result', { turn: params.turn, step: params.step,
    message: { role: 'tool', source: { kind: 'tool', callId: params.callId },
      toolCallId: params.callId,
      content: [{ type: 'text', text: params.body }],
      isError: false, id: `result-${params.callId}` } },
  { surfaceOp: { startSeq: seq, endSeq: seq } });
}

/** One scripted reply: the answer text split into two deltas, then a finish. */
function answerChunks(text: string): DshLlmChunk[] {
  return [
    { type: 'text-delta', index: 0, text: text.slice(0, 5) },
    { type: 'text-delta', index: 0, text: text.slice(5) },
    { type: 'finish', reason: 'stop' },
  ];
}

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A fake model seam: replies are served in order, the last one repeats. */
function fakeLlm(...replies: readonly (readonly DshLlmChunk[] | (() => AsyncIterable<DshLlmChunk>))[]): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  let served = 0;
  return {
    calls,
    stream(options) {
      calls.push(options);
      const reply = replies[Math.min(served, replies.length - 1)] ?? [];
      served += 1;
      if (typeof reply === 'function') return reply();
      return (async function* emit() { for (const chunk of reply) yield chunk; })();
    },
  };
}

/** The journal kinds one mount wrote, in order. */
type JournalLine = { kind: string; [field: string]: unknown };

interface Harness {
  readonly session: FakeSession;
  readonly mount: ReturnType<typeof createRacoonsMount>;
  readonly journal: JournalLine[];
  readonly llm: FakeLlm;
}

/**
 * One mount with fake host seams. Entry tests below exercise the explicit
 * `count` compatibility cadence unless they name another trigger; the product
 * default is not that cadence, so a test of the absent-trigger shape passes
 * `omitEntryAskTrigger` and gets the production default (`off`).
 */
function harness(params: {
  readonly id?: string;
  readonly llm?: FakeLlm;
  readonly floorBytes?: number;
  readonly barBytes?: number;
  readonly entryAskBatchSize?: number;
  readonly entryAskTrigger?: RacoonsEntryAskTriggerConfig;
  /** Leave the key out entirely so the mount resolves its own default (`off`). */
  readonly omitEntryAskTrigger?: boolean;
  readonly entryAskGrammar?: EntryAskGrammar;
  readonly enforcement?: 'apply' | 'record-only';
  readonly ledger?: Ledger;
} = {}): Harness {
  const session = fakeSession(params.id ?? 'session-entry');
  const journal: JournalLine[] = [];
  const llm = params.llm ?? fakeLlm(answerChunks('{"keepall":true}'));
  const mount = createRacoonsMount({
    config: resolvePluginConfig({
      floorBytes: params.floorBytes ?? 512,
      barBytes: params.barBytes ?? 8192,
      ...(params.entryAskBatchSize === undefined
        ? {} : { entryAskBatchSize: params.entryAskBatchSize }),
      ...(params.omitEntryAskTrigger === true
        ? {}
        : { entryAskTrigger: params.entryAskTrigger ?? { mode: 'count' } }),
      ...(params.entryAskGrammar === undefined
        ? {} : { entryAskGrammar: params.entryAskGrammar }),
      ...(params.enforcement === undefined ? {} : { enforcement: params.enforcement }),
    }),
    storage: resolveStorage(undefined),
    journal: (record) => journal.push(record),
    llm: llm as never,
    judgeRoute: ROUTE,
    ...(params.ledger === undefined ? {} : { openLedger: async () => params.ledger as Ledger }),
  });
  session.on((live, event) => { mount.observe(live, event); });
  return { session, mount, journal, llm };
}

/** Main's last request, as the `llm/stream` observer would see it. */
function wire(h: Harness): void {
  h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
    model: ROUTE.model, ...MAIN_WIRE });
}

/** The message texts of one sent request, in order. */
function sentTexts(sent: DshLlmStreamOptions): string[] {
  const messages = sent['messages'] as readonly { content: readonly { text?: string }[] }[];
  return messages.map(message => message.content[0]?.text ?? '');
}

/** The surface text of the one live tool result for a call id. */
function resultText(session: FakeSession, callId: string): string | null {
  const nodes = session.surface?.nodes ?? [];
  for (const seq of [...nodes].reverse()) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    const data = event.data as { message?: { toolCallId?: string; content?: readonly { text?: string }[] } };
    if (data.message?.toolCallId !== callId) continue;
    return data.message.content?.map(block => block.text ?? '').join('') ?? '';
  }
  return null;
}

/** Every validation failure the ledger holds: the breaker's only fuel. */
async function validationFailures(ledger: Ledger, sessionId: string): Promise<number> {
  let count = 0;
  for await (const row of ledger.events(sessionId)) {
    if (row.event.kind === 'validation' && !row.event.ok) count += 1;
  }
  return count;
}

const entryKinds = (journal: readonly JournalLine[], kind: string): JournalLine[] =>
  journal.filter(line => line.kind === kind);

// --- 1. the ask ------------------------------------------------------------


// --- 2. the floor ----------------------------------------------------------


// --- 3. keep-all -----------------------------------------------------------


// --- 4. forget -------------------------------------------------------------


// --- 5. refusals -----------------------------------------------------------


// --- 6. the breaker --------------------------------------------------------

/** A ledger primed with a disabled breaker, as a resumed session's own rows say. */
class PrimedLedger implements Ledger {
  readonly rows: LedgerEntry[];
  constructor(sessionId: string) {
    const atMs = 1;
    const events: LedgerEvent[] = [
      { kind: 'validation', sessionId, eventKey: 'prime:validation', atMs,
        eventId: 'prime', ok: false,
        issues: [{ code: 'stale-revision', ruleId: null, operationIndex: null,
          nodeId: null, detail: 'primed' }],
        breaker: { consecutiveValidationFailures: 2, disabled: true } },
      { kind: 'breaker-disabled', sessionId, eventKey: 'prime:disabled', atMs,
        turnOrdinal: 1, reason: 'two-validation-failures' },
      { kind: 'breaker-announced', sessionId, eventKey: 'prime:announced', atMs,
        recordId: `racoons:breaker-disabled:${sessionId}` },
    ];
    this.rows = events.map((event, index) => ({ sequence: index + 1, event }));
  }
  async prepare(_application: PreparableApplication): Promise<PreparedIntent> {
    throw new Error('a primed breaker must plan nothing');
  }
  async append(_event: LedgerEvent): Promise<LedgerEntry> {
    throw new Error('a primed breaker appends nothing');
  }
  async *events(sessionId: string): AsyncIterable<LedgerEntry> {
    for (const row of this.rows) if (row.event.sessionId === sessionId) yield row;
  }
  async recall(_id: string): Promise<RecallRecord> {
    throw new Error('nothing is banked');
  }
  async close(): Promise<void> {}
}


// --- 7. two results in one step -------------------------------------------


// --- 8. between the floor and the bar -------------------------------------


// --- 9. the second tool call of a session (P3c-2's live blocker) -----------

/**
 * One ask per eligible result, and what each ask's wire carries: the seed is
 * main's captured request plus the landed result turn, the ask text states the
 * line count and never repeats the body, and two results in one step are asked
 * one after the other in landing order. The rows differ only in how many results
 * the step lands, so they share one body.
 */
const PER_RESULT_ROWS: readonly {
  readonly name: string;
  readonly results: number;
  run(context: {
    readonly h: Harness;
    readonly bodies: readonly string[];
    readonly at: Label;
  }): Promise<void>;
}[] = [
  {
    name: 'one result',
    results: 1,
    async run({ h, bodies, at }) {
      const body = bodies[0] ?? '';
      const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(outcome.deliveries.length, 1, at('the result was delivered'));
      // Exactly one send for one result (the answer needed no correction turn).
      assert.equal(h.llm.calls.length, 1, at('one ask, one send'));
      const texts = sentTexts(h.llm.calls[0] ?? { messages: [] } as never);
      assert.equal(texts[texts.length - 1]?.includes('This result has 40 lines,'), true,
        at('the ask states N'));
      assert.equal(texts[texts.length - 2], body,
        at('the turn before the ask is the landed result, byte for byte'));
      assert.equal(texts[texts.length - 1]?.includes(body.trim()), false,
        at('the ask never carries the body'));
      assert.equal(texts.some(text => text === 'read big.txt'), true,
        at('the fork starts from main\'s captured request'));
      const asked = entryKinds(h.journal, 'entry-ask');
      assert.equal(asked.length, 1, at('one `entry-ask` line per result'));
      assert.equal(asked[0]?.['retried'], false, at('the first ask was not a retry'));
      assert.equal(asked[0]?.['turns'], 2, at('the exchange the mount appends is both turns'));
      assert.equal(asked[0]?.['action'], 'keepall', at('the answer applied as a keep-all'));
      assert.equal(typeof asked[0]?.['unitId'], 'string', at('the line names the landed unit'));
    },
  },
  {
    name: 'two results in one step',
    results: 2,
    async run({ h, bodies, at }) {
      const first = bodies[0] ?? '';
      const second = bodies[1] ?? '';
      const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(outcome.deliveries.length, 2, at('both results were delivered'));
      assert.equal(h.llm.calls.length, 2, at('one ask per result'));
      const firstSent = h.llm.calls[0], secondSent = h.llm.calls[1];
      assert.ok(firstSent !== undefined && secondSent !== undefined,
        at('two requests left the seam'));
      assert.equal(sentTexts(firstSent).includes(first), true,
        at('the first ask is about the first result'));
      assert.equal(sentTexts(firstSent).includes(second), false,
        at('the first ask never carries the second result'));
      assert.equal(sentTexts(secondSent).includes(second), true,
        at('the second ask is about the second result'));
      const asked = entryKinds(h.journal, 'entry-ask');
      assert.deepEqual(asked.map(line => line['eventId']),
        ['dsh:session-entry:result:c1', 'dsh:session-entry:result:c2'],
        at('both results are asked, in landing order'));
      assert.equal(resultText(h.session, 'c1'), first, at('the first result keeps its bytes'));
      assert.equal(resultText(h.session, 'c2'), second, at('the second result keeps its bytes'));
    },
  },
];

test('an over-floor result is asked once, seeded from the landed wire, body-free', async () => {
  await runRows(PER_RESULT_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const bodies = [bodyOf(40, 'RESULTA'), bodyOf(40, 'RESULTB')]
        .slice(0, scenario.results);
      const h = harness({ entryAskGrammar: '3option',
        llm: fakeLlm(answerChunks('{"keepall":true}')) });
      try {
        wire(h);
        step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
          callId: `c${String(index + 1)}`, body })) });
        await scenario.run({ h, bodies, at });
      } finally {
        await h.mount.close();
      }
    },
  })));
});

test('membership needs two quotes: a one-line or unquotable result is not tabled', async () => {
  // ADR-0042 Decision 5: a row is tabled only when it can render two quotes.
  // Both bodies below clear the byte floor, so only the quote rule can keep
  // them out; each lands untouched with no request and no ask journal line.
  const rows: readonly { readonly name: string; readonly id: string; readonly body: string }[] = [
    { name: 'one line', id: 'session-one-line', body: bodyOf(1, 'ONE', 600) },
    { name: 'no quotable line', id: 'session-braces',
      // 300 lines of one code point: no line is quotable and no earlier-line
      // fallback exists, so the row carries no quote at all.
      body: `${Array.from({ length: 300 }, () => '}').join('\n')}\n` },
  ];
  for (const row of rows) {
    assert.ok(encoder.encode(row.body).length >= 512,
      `${row.name}: the body clears the 512-byte floor`);
    const h = harness({ id: row.id, entryAskGrammar: '3option',
      llm: fakeLlm(answerChunks('{"keepall":true}')) });
    try {
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: row.body }] });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(h.llm.calls.length, 0, `${row.name}: no request leaves`);
      assert.deepEqual(h.journal.filter(line => String(line.kind).startsWith('entry-ask')), [],
        `${row.name}: nothing about the ask seam is journaled`);
      assert.equal(resultText(h.session, 'c1'), row.body, `${row.name}: the result lands untouched`);
    } finally {
      await h.mount.close();
    }
  }

  // Two lines are enough: the row is tabled and names both of its lines.
  const two = bodyOf(2, 'TWO', 300);
  const h = harness({ id: 'session-two-line', entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: two }] });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(h.llm.calls.length, 1, 'a two-line row is tabled');
    const ask = lastAskText(h);
    assert.ok(ask.includes('This result has 2 lines,'), 'the visible count is stated');
    assert.ok(ask.includes('line 1 ends with "'), 'the first line is quoted');
    assert.ok(ask.includes('line 2 ends with "'), 'the second line is quoted');
    assert.equal(entryKinds(h.journal, 'entry-ask').length, 1, 'the row was asked once');
  } finally {
    await h.mount.close();
  }
});

test('an over-bar result is asked once and no gate is ever offered the step (ADR-0028)', async () => {
  // The gating defect ADR-0025 §2 pinned, re-pinned after the judge pass's
  // removal (ADR-0028): the checkpoint owns an over-bar result, and NO second
  // seam may name it. The fake model answers every lane, so any judge-side ask
  // would show up as a second send. Nothing judge-shaped exists to journal any
  // more, so the assertion is absolute: no gate telemetry at all, and no
  // journal kind starting with `judge`.
  const body = bodyOf(560, 'OVERBAR', 40);
  assert.ok(body.length > 8192, `the body must clear the 8192-byte bar (${String(body.length)})`);
  const h = harness({ entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}'),
      answerChunks('{"1":{"forgetall":"stale body"}}')) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(outcome.deliveries.length, 1);
    // Exactly ONE ask reaches the model: the checkpoint's.
    assert.equal(h.llm.calls.length, 1, 'the checkpoint ask is the only model call');
    const asked = entryKinds(h.journal, 'entry-ask');
    assert.equal(asked.length, 1, 'one checkpoint ask for the one result');
    const unitId = asked[0]?.['unitId'];
    assert.equal(typeof unitId, 'string', 'the ask names the landed unit');
    // No gate ever presented: the telemetry carries no `gate-*` event, whatever
    // the step's size.
    const presentations = h.journal.filter(line => line.kind === 'telemetry')
      .map(line => line['event'] as { kind?: string })
      .filter(event => event.kind === 'gate-presented' || event.kind === 'gate-settled');
    assert.deepEqual(presentations, [],
      'no gate is offered the step the checkpoint owns');
    // Nothing judge-shaped exists to write: the vocabulary is closed (a
    // removed kind is a compile error), so this also guards a re-introduction.
    assert.deepEqual(h.journal.filter(line => String(line.kind).startsWith('judge')), [],
      'no judge line of any kind');
    // The keep-all is final: the body is still on the surface, byte for byte.
    assert.equal(resultText(h.session, 'c1'), body, 'the kept body survives the step');
    // ...and the next step re-asks nothing, from either seam.
    await h.mount.runStep(h.session, { turn: 2, step: 1 });
    assert.equal(h.llm.calls.length, 1, 'a settled result is never re-asked');
  } finally {
    await h.mount.close();
  }
});

/**
 * The mid-band class, both halves of one rule: a result between the floor and
 * the bar is asked exactly once, applies, and stays settled — and a forget on it
 * is bankable byte-exact by the recall id its receipt names. The two rows differ
 * only in the answer, so they share one body.
 */
const MIDBAND_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  readonly answer: string;
  /** Whether this row proves the ledger can restore the dropped bytes. */
  readonly bankable: boolean;
}[] = [
  { name: 'keep-all settles', id: 'session-midband-keep', answer: '{"keepall":true}',
    bankable: false },
  { name: 'forget is bankable', id: 'session-midband-forget',
    answer: '{"forgetall":"old build log"}', bankable: true },
];

test('a result between the floor and the bar is asked once, applies, and stays settled', async () => {
  await runRows(MIDBAND_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      // ~1.8 KiB: far above the 512-byte floor, far below the 8 KiB bulk bar.
      const body = bodyOf(60, 'MIDDLE');
      const bytes = encoder.encode(body);
      assert.ok(bytes.length > 512 && bytes.length < 8192,
        at(`${String(bytes.length)} bytes sits between the floor and the bar`));
      const h = harness({ id: scenario.id, floorBytes: 512, barBytes: 8192,
        entryAskGrammar: '3option', llm: fakeLlm(answerChunks(scenario.answer)) });
      try {
        wire(h);
        step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
        await h.mount.runStep(h.session, { turn: 1, step: 2 });
        // The bar mints no unit at all, so nothing but the floor could have asked.
        const node = { kind: 'tool-result' as const, id: `dsh:${scenario.id}:result:c1`,
          turnOrdinal: 1, stepOrdinal: 1, bytes, sha256: sha256Sync(bytes),
          byteLength: bytes.length, callId: 'c1', embeddedRecords: [] as const,
          evidence: { kind: 'read' as const, target: null,
            source: { nodeId: `dsh:${scenario.id}:result:c1`, sha256: sha256Sync(bytes),
              byteLength: bytes.length },
            sourceRecallId: null, paths: [] } };
        assert.equal(new UnitTracker({ sessionId: scenario.id, barBytes: 8192 })
          .unitsFor(node).length, 0, at('the bulk bar gives this result no unit'));
        assert.equal(h.llm.calls.length, 1, at('one ask, one send'));
        const asked = entryKinds(h.journal, 'entry-ask');
        assert.equal(asked.length, 1, at('the floor gate asks; the bar never did'));
        // The ask names the unit the port mints over the LANDED body (bar 0), which
        // is the address the guard re-derives when it applies the answer.
        const landedUnit = new UnitTracker({ sessionId: scenario.id, barBytes: 0 })
          .unitsFor(node)[0];
        assert.ok(landedUnit !== undefined, at('the landed body mints a unit'));
        assert.equal(asked[0]?.['unitId'], landedUnit.id,
          at('the ask names the whole-result unit of the landed body'));
        const entry = h.mount.sessions.get(h.session.id);
        assert.ok(entry !== undefined, at('the mount holds this session'));
        assert.equal(entry.entryJudged.has(`dsh:${scenario.id}:result:c1`), true,
          at('the answer settled the result'));
        const applied = entryKinds(h.journal, 'entry-apply');
        assert.equal(applied.length, 1, at('the answer applied once'));
        assert.equal(applied[0]?.['status'], scenario.bankable ? 'landed' : 'rewound',
          at(scenario.bankable
            ? 'a forget lands a shaped turn'
            : 'a keep-all rewinds the exchange'));
        assert.equal(resultText(h.session, 'c1') === body, !scenario.bankable,
          at(scenario.bankable
            ? 'a forgot body is no longer on the surface'
            : 'a kept body keeps its bytes'));
        // A shaped turn is a different node body, so it mints a different unit id
        // (ADR-0025: unit identity is content identity).
        if (scenario.bankable) {
          const shapedUnit = entry.port.landedUnitId(`dsh:${scenario.id}:result:c1`);
          assert.notEqual(shapedUnit, landedUnit.id, at('the shaped turn is new content'));
          const text = resultText(h.session, 'c1');
          assert.ok(text !== null, at('the shaped turn is on the surface'));
          const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(text)?.[1];
          assert.ok(recallId !== undefined, at('the receipt names a recall id'));
          const record = await entry.ledger.recall(recallId as never);
          assert.deepEqual(record.parts[0]?.bytes, bytes,
            at('recall is byte-exact for the middle band'));
        }
        // The next step re-asks nothing, from either seam.
        await h.mount.runStep(h.session, { turn: 2, step: 1 });
        assert.equal(h.llm.calls.length, 1, at('the settled result is never re-asked'));
        assert.equal(entryKinds(h.journal, 'entry-apply').length, 1,
          at('the answer applied exactly once'));
      } finally {
        await h.mount.close();
      }
    },
  })));
});

/**
 * The two answers an entry ask can receive, one row each: a keep-all rewinds the
 * exchange and settles the result without writing a turn, and a forget lands one
 * shaped turn whose receipt names the recall id that restores the dropped bytes.
 * Both settle the unit on `entryJudged`, so both survive a redelivery.
 */
const ANSWER_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  /** The one answer the fake seam delivers. */
  readonly answer: string;
  run(context: { readonly h: Harness; readonly body: string; readonly at: Label }): Promise<void>;
}[] = [
  {
    name: 'keep-all rewinds',
    id: 'session-keepall',
    answer: '{"keepall":true}',
    async run({ h, body, at }) {
      const applied = entryKinds(h.journal, 'entry-apply');
      assert.equal(applied.length, 1, at('the answer applied once'));
      assert.equal(applied[0]?.['status'], 'rewound', at('a keep-all rewinds, it lands nothing'));
      assert.equal(typeof applied[0]?.['exchangeSeq'], 'number',
        at('the rewind names its host seq'));
      assert.equal(applied[0]?.['resultSeq'], null, at('a keep-all writes no result turn'));
      assert.equal(resultText(h.session, 'c1'), body, at('the result turn keeps its bytes'));
      // The exchange left the surface: no ask text survives on the model wire.
      const surface = (h.session.surface?.nodes ?? [])
        .map(seq => h.session.eventAt?.(seq))
        .map(event => JSON.stringify(event?.data ?? {}));
      assert.equal(surface.some(text => text.includes('This result has 40 lines,')), false,
        at('the ask turn is gone from the surface'));
      const entry = h.mount.sessions.get(h.session.id);
      assert.ok(entry !== undefined, at('the mount holds this session'));
      assert.equal(entry.entryJudged.has(`dsh:${h.session.id}:result:c1`), true,
        at('the answer settled the result'));
      // ISSUE-073: an APPLIED keep-all is also the one answer that withholds the
      // unit from a later bulk prune, so it is recorded on its own set.
      assert.equal(entry.entryKept.has(`dsh:${h.session.id}:result:c1`), true,
        at('an applied keep-all is a settled keep'));
    },
  },
  {
    name: 'forget lands a shaped turn',
    id: 'session-forget',
    answer: '{"forgetall":"stale run notes"}',
    async run({ h, body, at }) {
      const applied = entryKinds(h.journal, 'entry-apply');
      assert.equal(applied.length, 1, at('the answer applied once'));
      assert.equal(applied[0]?.['status'], 'landed', at('a forget lands the shaped turn'));
      assert.equal(applied[0]?.['appends'], 2,
        at('the rewind and the shaped turn are two appends'));
      assert.equal(typeof applied[0]?.['exchangeSeq'], 'number',
        at('the rewind names its exchange seq'));
      assert.equal(typeof applied[0]?.['resultSeq'], 'number',
        at('the second append is the shaped result turn'));
      const text = resultText(h.session, 'c1');
      assert.ok(text !== null, at('the shaped turn is on the surface'));
      assert.ok(text.startsWith('stale run notes\n\n'),
        at('the answer\'s summary rides above the shaped bytes'));
      assert.match(text, /\[racoons\] kept 0 of 40 lines · necromancy recall:sha256:[0-9a-f]{64}/u,
        at('the receipt names the kept count and the recall id'));
      assert.equal(text.includes('FORGET-1 '), false, at('no kept line survives a forgetall'));
      // The dropped body is bankable byte-exact by the id the marker names.
      const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(text)?.[1];
      assert.ok(recallId !== undefined, at('the receipt names a recall id'));
      const entry = h.mount.sessions.get(h.session.id);
      assert.ok(entry !== undefined, at('the mount holds this session'));
      const record = await entry.ledger.recall(recallId as never);
      assert.deepEqual(record.parts[0]?.bytes, encoder.encode(body),
        at('recall restores the landed bytes, not the shaped ones'));
      assert.equal(entry.entryJudged.has(`dsh:${h.session.id}:result:c1`), true,
        at('the answer settled the result'));
      assert.equal(entry.entryKept.size, 0, at('a forget settles no keep'));
    },
  },
];

test('an answered ask rewinds or lands, banks its bytes, and settles the unit', async () => {
  await runRows(ANSWER_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const body = bodyOf(40, 'ANSWER');
      const h = harness({ id: scenario.id, entryAskGrammar: '3option',
        llm: fakeLlm(answerChunks(scenario.answer)) });
      try {
        wire(h);
        step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
        await h.mount.runStep(h.session, { turn: 1, step: 2 });
        await scenario.run({ h, body, at });
        // A redelivery of the same result must not be asked again. This is the
        // non-vacuity of the judged mark: without it the floor check passes again.
        for (const event of h.session.log.filter(candidate => candidate.type === 'tool/result')) {
          h.mount.observe(h.session, event);
        }
        await h.mount.runStep(h.session, { turn: 2, step: 1 });
        assert.equal(h.llm.calls.length, 1, at('a settled result is never re-asked'));
        assert.equal(entryKinds(h.journal, 'entry-ask').length, 1,
          at('the checkpoint asked once'));
      } finally {
        await h.mount.close();
      }
    },
  })));
});

/**
 * Every ask refusal fails open, and each row states what its refusal line
 * carries: no seed, a dead stream, no text, an unreadable answer and a fourth
 * action all keep the unit and touch nothing, while a shape failure keeps the
 * answer verbatim, an over-cap answer keeps its bounded prefix, and a deadline
 * carries none at all. One body, one row per refusal shape.
 */
const FAIL_OPEN_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  /** The code the refusal row must name. */
  readonly code: string;
  /** Whether the mount is seeded from main's captured request. */
  readonly seed: boolean;
  /** Whether the row's stream throws instead of answering. */
  readonly deadStream?: boolean;
  /** Whether the stdlib timer must fire instead of the answer arriving. */
  readonly deadline?: boolean;
  /** What the fake seam answers; ignored when the stream dies. */
  readonly answer: string;
  /** The text the refusal row must carry, or null when it claims none. */
  readonly raw: string | null;
  /** The row's own extra claims, after the shared fail-open set. */
  check?(context: { readonly refused: readonly ({ kind: string; [field: string]: unknown }
    | undefined)[]; readonly h: Harness; readonly at: Label }): void;
}[] = [
  { name: 'no seed', id: 'session-refused-0', code: 'no-seed', seed: false,
    answer: '{"keepall":true}', raw: null },
  { name: 'dead stream', id: 'session-refused-1', code: 'stream-error', seed: true,
    deadStream: true, answer: '{"keepall":true}', raw: null },
  { name: 'no text', id: 'session-refused-2', code: 'empty-text', seed: true,
    answer: '', raw: null },
  { name: 'unreadable answer', id: 'session-refused-3', code: 'malformed-json', seed: true,
    answer: '{"keepall":tru', raw: '{"keepall":tru' },
  { name: 'fourth action', id: 'session-refused-4', code: 'unknown-action', seed: true,
    answer: '{"keephead":12}', raw: '{"keephead":12}' },
  { name: 'mixed keys', id: 'session-shape', code: 'mixed-keys', seed: true,
    answer: '{"keepall":true,"keeplines":[[1,2],"x"]}',
    raw: '{"keepall":true,"keeplines":[[1,2],"x"]}' },
  { name: 'missing summary', id: 'session-shape-summary', code: 'summary-missing', seed: true,
    answer: '{"keeplines":[[1,2]]}', raw: '{"keeplines":[[1,2]]}' },
  { name: 'over the cap', id: 'session-cap', code: 'malformed-json', seed: true,
    answer: `{"keepall":${'x'.repeat(5000)}}`,
    raw: `{"keepall":${'x'.repeat(5000)}}`.slice(0, 4000) },
  { name: 'deadline fired', id: 'session-timeout', code: 'timeout', seed: true,
    deadline: true, answer: '{"keepall":true}', raw: null,
    check({ refused, h, at }) {
      assert.equal(refused[0]?.['reason'], 'timeout',
        at('the row states the deadline as its reason'));
      assert.equal(h.llm.calls.length, 1, at('the ask was sent before the deadline fired'));
    } },
];

test('every ask refusal fails open, and its row says what the model answered', async () => {
  await runRows(FAIL_OPEN_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const body = bodyOf(40, 'REFUSED');
      // The entry ask's one deadline is `DEFAULT_ASK_TIMEOUT_MS`; the stdlib
      // timer is replaced so the fired deadline is exercised without waiting.
      const fired = AbortSignal.abort(new DOMException('the ask deadline fired', 'TimeoutError'));
      const patched = scenario.deadline === true
        ? mock.method(AbortSignal, 'timeout', () => fired) : null;
      const calls: DshLlmStreamOptions[] = [];
      const llm: FakeLlm = scenario.deadStream === true
        ? {
          calls,
          stream(options) {
            calls.push(options);
            return (async function* boom(): AsyncGenerator<DshLlmChunk> {
              throw new Error('socket reset');
              yield { type: 'finish', reason: 'stop' };
            })();
          },
        }
        : scenario.answer === '' ? fakeLlm([{ type: 'finish', reason: 'stop' }])
          : fakeLlm(answerChunks(scenario.answer));
      const h = harness({ id: scenario.id, entryAskGrammar: '3option', llm });
      try {
        if (scenario.seed) wire(h);
        step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
        await h.mount.runStep(h.session, { turn: 1, step: 2 });
        const refused = entryKinds(h.journal, 'entry-ask-refused');
        assert.equal(refused.length, 1, at('one refusal line'));
        assert.equal(refused[0]?.['code'], scenario.code, at('the code is named'));
        if (scenario.raw === null) {
          assert.equal(Object.hasOwn(refused[0] ?? {}, 'raw'), false,
            at('no text existed, so the row claims none'));
        } else {
          assert.equal(refused[0]?.['raw'], scenario.raw,
            at('the answer text rides the refusal row'));
        }
        assert.equal(entryKinds(h.journal, 'entry-apply').length, 0,
          at('nothing was applied'));
        assert.equal(entryKinds(h.journal, 'entry-apply-refused').length, 0,
          at('an ask that never answered applies nothing at all'));
        assert.equal(resultText(h.session, 'c1'), body, at('the result is untouched'));
        const entry = h.mount.sessions.get(h.session.id);
        assert.ok(entry !== undefined, at('the mount holds this session'));
        assert.equal(entry.entryJudged.has(`dsh:${scenario.id}:result:c1`), false,
          at('a refusal settles nothing, so a later seam may still ask once'));
        // ISSUE-073's edge: a fail-open entry ask must not silently exclude the
        // unit from a later bulk prune either, so the settled-keep set stays empty.
        assert.equal(entry.entryKept.size, 0, at('a fail-open answer settles no keep'));
        assert.equal(await validationFailures(entry.ledger, entry.sessionId), 0,
          at('no validation failure reached the breaker'));
        assert.equal(entryKinds(h.journal, 'breaker-disabled').length, 0,
          at('the breaker never tripped'));
        scenario.check?.({ refused, h, at });
      } finally {
        patched?.mock.restore();
        await h.mount.close();
      }
    },
  })));
});

/**
 * The two ways the ask lane stands down without sending: the result is under the
 * entry floor, so nothing qualifies, or the breaker is already disabled, so the
 * lane is closed before it looks. Both send nothing and land the result whole;
 * only the journal kind that says so differs.
 */
const STAND_DOWN_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  /** The row's harness: the floor, and the breaker when the row primes one. */
  readonly config: Parameters<typeof harness>[0];
  /** The kind that states the stand-down, or null when no line is written. */
  readonly kind: string | null;
  /** The reason the row's line names, when it writes one. */
  readonly reason: string | null;
  /** The lines the row's body has, which decides whether it clears the floor. */
  readonly lines: number;
  run(context: { readonly h: Harness; readonly body: string; readonly at: Label }): Promise<void>;
}[] = [
  {
    name: 'under the floor',
    id: 'session-under-floor',
    config: { floorBytes: 4096 },
    kind: null,
    reason: null,
    lines: 4,
    async run({ h, body, at }) {
      const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(outcome.deliveries.length, 1, at('the result was delivered'));
      assert.equal(h.llm.calls.length, 0, at('no ask is sent for a below-floor result'));
      assert.deepEqual(h.journal.filter(line => String(line.kind).startsWith('entry-ask')), [],
        at('nothing about the ask seam is journaled'));
      assert.equal(entryKinds(h.journal, 'entry-apply').length, 0, at('nothing was applied'));
      assert.equal(resultText(h.session, 'c1'), body, at('the result lands untouched'));
      // DoD box 2: a sub-floor result runs byte-identical — no ask, no marker,
      // and no ledger row. `prepared`/`applied` are the only rows a shaping or a
      // removal writes, so an archive of this result would appear here.
      const entry = h.mount.sessions.get(h.session.id);
      assert.ok(entry !== undefined, at('the mount holds this session'));
      const rows: string[] = [];
      for await (const row of entry.ledger.events(entry.sessionId)) rows.push(row.event.kind);
      assert.deepEqual(rows, [], at('a sub-floor result writes no ledger row at all'));
    },
  },
  {
    name: 'breaker open',
    id: 'session-entry',
    // Over the entry floor (so the lane would ask) and under the bulk bar (so no
    // gate presents it and the judge cannot consume the send this row counts).
    config: { floorBytes: 512, barBytes: 8192, enforcement: 'record-only',
      ledger: new PrimedLedger('session-entry') as never },
    kind: 'entry-ask-off',
    reason: 'breaker-open',
    lines: 60,
    async run({ h, body, at }) {
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(h.llm.calls.length, 0, at('no request leaves while the breaker is open'));
      assert.equal(resultText(h.session, 'c1'), body, at('the result lands whole'));
    },
  },
];

test('the ask lane stands down before any send, and says why or says nothing', async () => {
  await runRows(STAND_DOWN_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const body = bodyOf(scenario.lines, 'STAND');
      const h = harness({ id: scenario.id, ...scenario.config });
      try {
        wire(h);
        step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
        await scenario.run({ h, body, at });
        if (scenario.kind === null) {
          assert.equal(h.journal.some(line => line['kind'] === 'entry-ask-off'), false,
            at('no stand-down line exists when nothing qualified'));
          return;
        }
        const off = entryKinds(h.journal, scenario.kind);
        assert.equal(off.length, 1, at('one stand-down line'));
        assert.equal(off[0]?.['reason'], scenario.reason, at('the line names the reason'));
      } finally {
        await h.mount.close();
      }
    },
  })));
});

test('entryAskTrigger off journals configured-off, sends no ask and lands the result whole',
  async () => {
    // ADR-0050 decision 4: `off` is the product configuration. The check must
    // prove three things at once — no request leaves, every ELIGIBLE result says
    // why it was not asked, and the off branch never touches the batch state a
    // count cadence would have moved.
    const big = bodyOf(60, 'OFF');
    const tiny = 'tiny\n';
    // Batch size 6 would HOLD an eligible result on the count path; `off` must
    // return before any pending row or accumulator is written.
    const h = harness({ id: 'session-entry-off', entryAskBatchSize: 6,
      entryAskTrigger: { mode: 'off' } });
    try {
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [
        { callId: 'c1', body: big },
        { callId: 'c2', body: tiny },
      ] });
      const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(outcome.deliveries.length, 2, 'both results were delivered');
      assert.equal(h.llm.calls.length, 0, 'no entry ask leaves');
      assert.deepEqual(entryKinds(h.journal, 'entry-ask'), [], 'no ask row');
      assert.deepEqual(entryKinds(h.journal, 'entry-ask-hold'), [], 'nothing is held');
      const off = entryKinds(h.journal, 'entry-ask-off');
      assert.equal(off.length, 1, 'only the eligible result gets a stand-down line');
      const line = off[0];
      assert.ok(line !== undefined, 'the line exists');
      assert.equal(line['reason'], 'configured-off', 'the line names the configuration');
      assert.equal(line['sessionId'], 'session-entry-off');
      assert.equal(line['callId'], 'c1', 'the over-floor result is the one named');
      assert.equal(line['byteLength'], encoder.encode(big).length,
        'the line carries the same size field as the other stand-down rows');
      assert.equal(typeof line['eventId'], 'string', 'and its event id');
      assert.equal(entryKinds(h.journal, 'entry-apply').length, 0, 'nothing was applied');
      assert.equal(resultText(h.session, 'c1'), big, 'the eligible result lands whole');
      assert.equal(resultText(h.session, 'c2'), tiny, 'the under-floor result lands whole');
      const entry = h.mount.sessions.get(h.session.id);
      assert.ok(entry !== undefined, 'the mount holds this session');
      assert.deepEqual(entry.entryBatch, { pending: [] }, 'the batch state is untouched');
      assert.equal(entry.entryLandedBytes, 0, 'the landed-bytes accumulator is untouched');
      assert.equal(entry.entryJudged.size, 0, 'off settles nothing');
    } finally {
      await h.mount.close();
    }
  });

test('an absent entryAskTrigger resolves to off: no ask, configured-off, result whole',
  async () => {
    // ADR-0050 decision 4: `off` is the default, not only an explicit row. The
    // harness leaves the key out, so this pins the resolver's absent branch at
    // the mount, where a wrong default would send a per-result ask.
    const big = bodyOf(60, 'DEFAULT-OFF');
    const h = harness({ id: 'session-default-off', entryAskBatchSize: 6,
      omitEntryAskTrigger: true });
    try {
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: big }] });
      const outcome = await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(outcome.deliveries.length, 1, 'the result was delivered');
      assert.equal(h.llm.calls.length, 0, 'no entry ask leaves');
      assert.deepEqual(entryKinds(h.journal, 'entry-ask'), [], 'no ask row');
      assert.deepEqual(entryKinds(h.journal, 'entry-ask-hold'), [], 'nothing is held');
      const off = entryKinds(h.journal, 'entry-ask-off');
      assert.equal(off.length, 1, 'the eligible result gets one stand-down line');
      assert.equal(off[0]?.['reason'], 'configured-off', 'the line names the default');
      assert.equal(resultText(h.session, 'c1'), big, 'the result lands whole');
      const entry = h.mount.sessions.get(h.session.id);
      assert.ok(entry !== undefined, 'the mount holds this session');
      assert.deepEqual(entry.entryBatch, { pending: [] }, 'the batch state is untouched');
      assert.equal(entry.entryLandedBytes, 0, 'the landed-bytes accumulator is untouched');
    } finally {
      await h.mount.close();
    }
  });

test('a SECOND tool call in one session is asked from the live surface, not the capture', async () => {
  // The blocker: main's second request ends with the FIRST result, because the
  // assistant turn that made the second call is a response no request carries.
  // A capture-only seed appends a second `tool` turn and the fork refuses it
  // (`role-conflict`), which P3c-2 observed as a silent fail-open `no-seed`.
  const first = bodyOf(20, 'FIRST');
  const second = bodyOf(20, 'SECOND');
  const h = harness({ entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: first }] });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    // Now the loop dispatches its next request: it ends at the FIRST result.
    h.mount.observeWire({ sessionId: h.session.id, provider: ROUTE.provider,
      model: ROUTE.model, system: MAIN_WIRE.system, tools: MAIN_WIRE.tools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
        { role: 'assistant', content: [{ type: 'text', text: '[tool call read {"file_path":"c1.txt"}]' }] },
        { role: 'tool', content: [{ type: 'text', text: first }] },
      ] });
    step(h.session, { turn: 1, step: 3, results: [{ callId: 'c2', body: second }] });
    await h.mount.runStep(h.session, { turn: 1, step: 4 });
    const asked = entryKinds(h.journal, 'entry-ask');
    const refused = entryKinds(h.journal, 'entry-ask-refused');
    assert.deepEqual(refused, [], 'no ask failed open on the second result');
    assert.equal(asked.length, 2, 'both results were asked');
    assert.deepEqual(asked.map(line => line['action']), ['keepall', 'keepall']);
    // The second ask's wire carries the SECOND result's own turn last, with the
    // first result's turn still on the prefix: the surface is the seed.
    const secondCall = h.llm.calls[1];
    assert.ok(secondCall !== undefined);
    const texts = sentTexts(secondCall);
    assert.equal(texts.includes(first), true, 'the first result stays on the prefix');
    assert.equal(texts[texts.length - 2], second,
      'the turn before the ask is the second landed result, byte for byte');
    assert.equal(texts.filter(text => text === second).length, 1,
      'the second result appears exactly once, never doubled');
  } finally {
    await h.mount.close();
  }
});

test('both exchange rows are stored as user/message with no turn or step (ISSUE-074)', async () => {
  // dsh's replay validator calls `requireOpenStep` on EVERY stored
  // `assistant/message`, and neither append seam is inside a step: the
  // pre-step seam runs before the host appends `step/start`, the turn-stopping
  // seam after `step/end`. An answer stored as an assistant turn therefore
  // makes the next launch refuse the whole session
  // (`assistant/message does not match an open turn and step`, ISSUE-074). Both
  // rows are user messages, so no step relationship is claimed at all, and the
  // stored log resumes. Scheme A; leader ruling 2026-10-27.
  const body = bodyOf(40, 'STOREDSHAPE');
  const h = harness({ entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const applied = entryKinds(h.journal, 'entry-apply');
    assert.equal(applied.length, 1);
    const exchangeSeq = applied[0]?.['exchangeSeq'];
    assert.equal(typeof exchangeSeq, 'number', 'the rewind names the exchange seq');
    // The reward is the exchange's two appended rows, which the log keeps.
    const rows = h.session.log.filter(event => event.type === 'user/message'
      && event.surfaceOp === 'append'
      && (event.data as { source?: { kind?: string } }).source?.kind === 'racoons/negation/entry-ask');
    assert.equal(rows.length, 2, 'the exchange appended two rows (ask, answer)');
    for (const row of rows) {
      const data = row.data as { turn?: unknown; step?: unknown; role?: unknown };
      assert.equal(data.role, 'user', 'an exchange row is a user message');
      assert.equal(data.turn, undefined, 'an exchange row claims no turn');
      assert.equal(data.step, undefined, 'an exchange row claims no step');
    }
    // And no stored assistant turn came from this mount: the scripted step's
    // own tool-call turn is the only assistant message in the log.
    const assistant = h.session.log.filter(event => event.type === 'assistant/message');
    assert.equal(assistant.length, 1, 'the exchange stored no assistant turn');
  } finally {
    await h.mount.close();
  }
});

// --- the ask's cadence and grammar (ISSUES-117, 128, 129) -------------------

/**
 * One step's ask stream, one row per configuration: how many sends it costs,
 * which rows one send covers, which contract the ask states, and how each row's
 * answer applies. The rows differ only in their knobs and scripted answers, so
 * they share one body; every assertion names the row it belongs to.
 */
const STEP_ASK_ROWS: readonly {
  /** The row's name; every assertion expands to `row: <name>: <what>`. */
  readonly name: string;
  readonly id: string;
  /** How many `bodyOf(40, ...)` results the step lands. */
  readonly results: number;
  /** The knobs this row resolves beside the harness defaults. */
  readonly config: (bodies: readonly string[]) => Parameters<typeof harness>[0];
  /** The answer text the fake stream delivers. */
  readonly answer: string;
  /** The claims only this row makes. */
  check(context: {
    readonly h: Harness;
    readonly bodies: readonly string[];
    readonly at: Label;
  }): void;
}[] = [
  {
    name: 'batch of three',
    id: 'session-batch',
    results: 3,
    config: () => ({ entryAskBatchSize: 3, entryAskGrammar: '3option' }),
    answer: '{"1":{"keepall":true},"2":{"forgetall":"an old numbered listing"},'
      + '"3":{"keeplines":[[1,4],"kept the head of the listing"]}}',
    check({ h, bodies, at }) {
      // The claim the knob makes: at `entryAskBatchSize: 3` three eligible
      // results cost one model call, not three, and each row's answer still
      // applies as its own entry write.
      assert.equal(h.llm.calls.length, 1, at('one ask send covers the batch'));
      const ask = lastAskText(h);
      // The one message names every row by index, in index order.
      const rows = ask.split('\n').filter(line => /^\d+\. \[/u.test(line));
      assert.equal(rows.length, 3, at('one row per result, no row rendered twice'));
      assert.deepEqual(rows.map(line => line.slice(0, 2)), ['1.', '2.', '3.'],
        at('the rows are numbered in table order'));
      assert.equal(ask.endsWith(ENTRY_ASK_END_ANCHOR), true,
        at('the batch ends on the entry ask anchor'));
      for (const body of bodies) {
        assert.equal(ask.includes(body.trim()), false, at('the batch never carries a body'));
      }
      // Three asks journaled, one per row, each naming its batch position.
      const asked = entryKinds(h.journal, 'entry-ask');
      assert.equal(asked.length, 3, at('one `entry-ask` line per answered row'));
      assert.deepEqual(asked.map(line => line['batchIndex']), [1, 2, 3],
        at('each row names its batch position'));
      assert.deepEqual(asked.map(line => line['batchSize']), [3, 3, 3],
        at('each row names the batch size'));
      assert.deepEqual(asked.map(line => line['action']),
        ['keepall', 'forgetall', 'keeplines'], at('each row names its action'));
      // The two held rows journaled their hold, and the hold names the cadence.
      const holds = entryKinds(h.journal, 'entry-ask-hold');
      assert.equal(holds.length, 2, at('rows 1 and 2 were held until row 3 fired'));
      assert.deepEqual(holds.map(line => line['batchSize']), [3, 3],
        at('the holds name the count cadence'));
      assert.deepEqual(holds.map(line => line['pending']), [1, 2],
        at('the holds name how many were pending'));
      assert.equal(holds.every(line => !Object.hasOwn(line, 'landedBytes')), true,
        at('the count cadence names no accumulator'));
      // Three applies landed: the first rewinds, the later two ride `landed`.
      const applied = entryKinds(h.journal, 'entry-apply');
      assert.equal(applied.length, 3, at('every answered row applies as its own write'));
      assert.deepEqual(applied.map(line => line['status']), ['rewound', 'landed', 'landed'],
        at('row 1 rewinds, rows 2..N land shaped turns'));
      assert.equal(applied[0]?.['appends'], 1, at('row 1 rewinds the exchange only'));
      assert.equal(applied[1]?.['appends'], 1,
        at('row 2 appends its shaped turn, no second rewind'));
      assert.equal(applied[2]?.['appends'], 1,
        at('row 3 appends its shaped turn, no second rewind'));
      // The surface at the end holds NO ask turn: the exchange left exactly once.
      const surface = (h.session.surface?.nodes ?? [])
        .map(seq => h.session.eventAt?.(seq))
        .map(event => JSON.stringify(event?.data ?? {}));
      assert.equal(surface.some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
        at('the batch exchange is gone from the surface'));
      // Rows 2 and 3 were shaped: their kept bytes are the answer's, not the body.
      assert.notEqual(resultText(h.session, 'c2'), bodies[1], at('row 2 was forgotten'));
      assert.notEqual(resultText(h.session, 'c3'), bodies[2], at('row 3 was shaped'));
      // Row 1 keeps its bytes, byte for byte.
      assert.equal(resultText(h.session, 'c1'), bodies[0], at('a keep-all row keeps its bytes'));
    },
  },
  {
    name: 'landed-bytes crossing',
    id: 'session-lb',
    results: 2,
    config: bodies => ({ entryAskGrammar: '3option', entryAskTrigger: { mode: 'landed-bytes',
      bytes: bodies.reduce((sum, body) => sum + encoder.encode(body).length, 0) } }),
    answer: '{"1":{"keepall":true},"2":{"forgetall":"the second listing"}}',
    check({ h, bodies, at }) {
      // The accumulator sums each eligible result's OWN bytes as it lands. The
      // threshold here is exactly both bodies, so the first landing is held and
      // the second fires ONE ask over the whole pending stream.
      const firstBytes = encoder.encode(bodies[0] ?? '').length;
      const holds = entryKinds(h.journal, 'entry-ask-hold');
      assert.equal(holds.length, 1, at('only the first landing was under the threshold'));
      assert.equal(holds[0]?.['pending'], 1, at('one row was pending at the hold'));
      assert.equal(holds[0]?.['landedBytes'], firstBytes,
        at('the accumulator grows by the result own bytes as it lands'));
      assert.equal(Object.hasOwn(holds[0] ?? {}, 'batchSize'), false,
        at('the byte cadence names no count'));
      // The crossing fires ONE ask covering the whole pending stream.
      const ask = lastAskText(h);
      assert.equal(ask.split('\n').filter(line => /^\d+\. \[/u.test(line)).length, 2,
        at('the ask covers the whole pending stream, this landing included'));
      assert.equal(ask.endsWith(ENTRY_ASK_END_ANCHOR), true,
        at('the batch ends on the entry ask anchor'));
      // Both rows answered and applied: the first rewinds, the second lands.
      assert.equal(entryKinds(h.journal, 'entry-ask').length, 2, at('both rows answered'));
      assert.deepEqual(entryKinds(h.journal, 'entry-apply').map(line => line['status']),
        ['rewound', 'landed'], at('the first rewinds, the second lands'));
      assert.equal(resultText(h.session, 'c1'), bodies[0], at('a keep-all row keeps its bytes'));
    },
  },
  {
    name: 'two-option grammar',
    id: 'session-grammar',
    results: 2,
    config: () => ({ entryAskBatchSize: 2, entryAskGrammar: 'two-option' }),
    answer: '{"1":{"keepall":true},'
      + '"2":{"keeplines":[[1,4],"kept the head of the listing"]}}',
    check({ h, bodies, at }) {
      // The live run's grammar: the ask states the two-option contract, and an
      // answer that names lines is refused by the grammar and its unit keeps.
      // No correction turn fires, because no range can be wrong.
      assert.equal(h.llm.calls.length, 1, at('one ask and no correction turn'));
      const ask = lastAskText(h);
      assert.ok(ask.startsWith(`${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}\n\n`),
        at('the mount states the two-option contract'));
      assert.equal(ask.includes('keeplines'), false,
        at('the ask never teaches a lined answer'));
      // The lined row is refused by the grammar and keeps its bytes whole.
      const refused = entryKinds(h.journal, 'entry-ask-refused');
      assert.equal(refused.length, 1, at('one row refused'));
      assert.equal(refused[0]?.['code'], 'action-not-in-grammar',
        at('the grammar names the refusal'));
      assert.equal(refused[0]?.['batchIndex'], 2, at('the second row is the refused one'));
      assert.equal(entryKinds(h.journal, 'entry-apply').length, 1,
        at('only the answered row applied'));
      assert.equal(resultText(h.session, 'c2'), bodies[1], at('a refused row keeps its bytes'));
      assert.equal(resultText(h.session, 'c1'), bodies[0], at('the keep-all row keeps its bytes'));
    },
  },
  {
    name: 'jsonl-20 grammar',
    id: 'session-jsonl20',
    results: 2,
    config: () => ({ entryAskBatchSize: 2, entryAskGrammar: 'jsonl-20' }),
    answer: '{"1":{"keepall":true}}\n'
      + '{"2":{"forgetall":true,"summary":"the second listing"}}',
    check({ h, bodies, at }) {
      // The next live run's grammar (ISSUE-183): the ask states the pre-table
      // contract, splices the counted table, and repeats the answer format. One
      // object per line reaches the line reader, and every row answers.
      assert.equal(h.llm.calls.length, 1, at('one ask and no correction turn'));
      const ask = lastAskText(h);
      const prefix = PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.slice(0,
        PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
      assert.ok(ask.startsWith(prefix), at('the mount states the jsonl-20 pre-table contract'));
      assert.equal(ask.includes(PRUNE_ASK_JSONL_20_SLOT), false, at('the table slot is replaced'));
      assert.ok(ask.endsWith(ENTRY_ASK_END_ANCHOR),
        at('the post-table repeat ends the ask'));
      const rows = ask.split('\n').filter(line => /^\d+\. \[/u.test(line));
      assert.equal(rows.length, 2, at('one table line per result'));
      assert.equal(rows.every(line => / \[\d+ lines?\]$/u.test(line)), true,
        at('every row carries its own line count'));
      assert.equal(entryKinds(h.journal, 'entry-ask').length, 2, at('both rows answered'));
      assert.deepEqual(entryKinds(h.journal, 'entry-apply').map(line => line['status']),
        ['rewound', 'landed'], at('the first rewinds, the second lands'));
      assert.equal(resultText(h.session, 'c1'), bodies[0], at('a keep-all row keeps its bytes'));
      assert.notEqual(resultText(h.session, 'c2'), bodies[1], at('the forgetall row lands shaped'));
    },
  },
];

/** The ask text of the last request the seam sent. */
function lastAskText(h: Harness): string {
  const sent = h.llm.calls[h.llm.calls.length - 1];
  const texts = sent === undefined ? [] : sentTexts(sent);
  return texts[texts.length - 1] ?? '';
}

test('one step\'s ask stream is one send over the whole pending stream, under its grammar',
  async () => {
    await runRows(STEP_ASK_ROWS.map((scenario): Row => ({
      name: scenario.name,
      async run(at) {
        const bodies = Array.from({ length: scenario.results },
          (_, index) => bodyOf(40, `STEP${String(index + 1)}`));
        for (const body of bodies) {
          assert.ok(body.length >= 512 && body.length < 8192,
            at(`each body must sit between the floor and the bar (${String(body.length)})`));
        }
        const h = harness({ id: scenario.id, ...scenario.config(bodies),
          llm: fakeLlm(answerChunks(scenario.answer)) });
        try {
          wire(h);
          step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
            callId: `c${String(index + 1)}`, body })) });
          await h.mount.runStep(h.session, { turn: 1, step: 2 });
          assert.equal(h.llm.calls.length, 1, at('the step costs exactly one send'));
          scenario.check({ h, bodies, at });
        } finally {
          await h.mount.close();
        }
      },
    })));
  });

// --- a held row whose bytes moved before the ask (ISSUE-188) ----------------

test('a held row changed before the fire is dropped, and the fresh row still asks and applies (ISSUE-188)', async () => {
  // The defect: the table was built from the copy frozen at landing. A bulk
  // prune or a host trim between landing and fire made the ask describe bytes
  // that no longer existed, and the apply was refused `source-hash-mismatch`.
  // Here the first row is trimmed on the surface after it lands; the batch of
  // two must ask only row 2, in its live bytes, and row 2 must still apply.
  const stale = bodyOf(20, 'STALE');
  const trimmed = bodyOf(8, 'TRIMMED');
  const fresh = bodyOf(20, 'FRESH');
  const h = harness({ id: 'session-stale-row', entryAskBatchSize: 2,
    entryAskGrammar: 'jsonl-20', llm: fakeLlm(answerChunks('{"1":{"keepall":true}}')) });
  try {
    wire(h);
    const seqs = step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: stale }] });
    // Land and HOLD the first row: the landing copy is taken now.
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(h.llm.calls.length, 0, 'the first landing is held, not asked');
    // The host trims the held row before the batch fires.
    trimResultOnSurface(h.session, seqs[0] ?? -1,
      { callId: 'c1', body: trimmed, turn: 1, step: 1 });
    step(h.session, { turn: 2, step: 1, results: [{ callId: 'c2', body: fresh }] });
    await h.mount.runStep(h.session, { turn: 2, step: 2 });
    // One send, and its table carries the fresh row only: the stale row is gone.
    assert.equal(h.llm.calls.length, 1);
    const ask = lastAskText(h);
    const tableRows = ask.split('\n').filter(line => /^\d+\. \[/u.test(line));
    assert.equal(tableRows.length, 1, 'the stale row is absent from the table');
    assert.ok(tableRows[0]?.includes('c2'), 'the surviving row is still numbered 1');
    assert.equal(tableRows[0]?.includes('c1'), false, 'the stale row is never shown');
    // The drop is named, with its batch position and what changed.
    const staleLines = entryKinds(h.journal, 'entry-ask-row-stale');
    assert.equal(staleLines.length, 1);
    assert.equal(staleLines[0]?.['rowIndex'], 1);
    assert.equal(staleLines[0]?.['changed'], 'unit+hash');
    assert.equal(staleLines[0]?.['eventId'], `dsh:session-stale-row:result:c1`);
    // The fresh row is asked and applied; the stale row is neither.
    assert.equal(entryKinds(h.journal, 'entry-ask').length, 1);
    assert.equal(entryKinds(h.journal, 'entry-ask')[0]?.['batchIndex'], 1);
    assert.equal(entryKinds(h.journal, 'entry-apply').length, 1);
    assert.equal(entryKinds(h.journal, 'entry-apply')[0]?.['action'], 'keepall');
    assert.equal(resultText(h.session, 'c2'), fresh, 'the fresh row keeps its bytes');
    assert.equal(resultText(h.session, 'c1'), trimmed, 'the stale row keeps the host\'s trim');
    const entry = h.mount.sessions.get(h.session.id);
    assert.ok(entry !== undefined);
    assert.equal(entry.entryJudged.has('dsh:session-stale-row:result:c1'), false,
      'a dropped row settles nothing');
    assert.equal(await validationFailures(entry.ledger, entry.sessionId), 0,
      'no validation failure reached the breaker');
  } finally {
    await h.mount.close();
  }
});

test('an apply whose row moved after the ask is refused locally, with no validation row (ISSUE-188)', async () => {
  // The second window: the table was current at fire, but a host trim landed
  // while the model answered. Row 1's apply re-syncs the transcript and exposes
  // the moved row; row 2 must be refused by the mount, before the engine sees
  // it, so no validation row exists for the breaker to count.
  const first = bodyOf(20, 'ASKED');
  const second = bodyOf(20, 'MOVED');
  const moved = bodyOf(10, 'MOVED-AFTER');
  let c2Seq = -1;
  let trimmed = false;
  let h: Harness;
  const llm: FakeLlm = {
    calls: [],
    stream(options) {
      llm.calls.push(options);
      if (!trimmed) {
        trimmed = true;
        // The trim publishes while the request is being answered, exactly as a
        // concurrent host write would.
        trimResultOnSurface(h.session, c2Seq, { callId: 'c2', body: moved, turn: 2, step: 1 });
      }
      return (async function* emit() {
        for (const chunk of answerChunks('{"1":{"keepall":true}}\n{"2":{"keepall":true}}')) yield chunk;
      })();
    },
  };
  h = harness({ id: 'session-apply-moved', entryAskBatchSize: 2,
    entryAskGrammar: 'jsonl-20', llm });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: first }] });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const seqs = step(h.session, { turn: 2, step: 1, results: [{ callId: 'c2', body: second }] });
    c2Seq = seqs[0] ?? -1;
    await h.mount.runStep(h.session, { turn: 2, step: 2 });
    // Both rows answered the ask; only row 1 could apply.
    assert.equal(entryKinds(h.journal, 'entry-ask').length, 2);
    assert.equal(entryKinds(h.journal, 'entry-apply').length, 1);
    const refused = entryKinds(h.journal, 'entry-apply-refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.['code'], 'ask-row-stale');
    assert.equal(refused[0]?.['batchIndex'], 2);
    assert.notEqual(refused[0]?.['askSha256'], undefined, 'the ask-time hash is named');
    assert.notEqual(refused[0]?.['liveSha256'], undefined, 'the live hash is named');
    assert.equal(resultText(h.session, 'c2'), moved, 'the moved row keeps the host\'s bytes');
    assert.equal(resultText(h.session, 'c1'), first, 'the applied row keeps its bytes');
    const entry = h.mount.sessions.get(h.session.id);
    assert.ok(entry !== undefined);
    assert.equal(await validationFailures(entry.ledger, entry.sessionId), 0,
      'the local refusal is not a validation failure');
    assert.equal(entryKinds(h.journal, 'breaker-disabled').length, 0, 'the breaker never tripped');
    assert.equal(entry.entryJudged.has('dsh:session-apply-moved:result:c2'), false,
      'a locally refused row settles nothing');
  } finally {
    await h.mount.close();
  }
});

test('the 14-row live refusal shape now yields zero validation events (ISSUE-188)', async () => {
  // The live evidence: fourteen rows of one fired batch had been changed by the
  // prune or a host trim, and every apply was refused source-hash/length. Here
  // fourteen held rows are trimmed before the fire and one fresh row completes
  // it. The fourteen drop; the fresh row asks and applies; no validation fails.
  const staleBodies = Array.from({ length: 14 }, (_, index) => bodyOf(20, `LIVE${String(index + 1)}`));
  const trimmedBodies = staleBodies.map((_, index) => bodyOf(8, `TRIMMED${String(index + 1)}`));
  const fresh = bodyOf(20, 'LIVE15');
  const h = harness({ id: 'session-live-14', entryAskBatchSize: 15,
    entryAskGrammar: 'jsonl-20', llm: fakeLlm(answerChunks('{"1":{"keepall":true}}')) });
  try {
    wire(h);
    const seqs = step(h.session, { turn: 1, step: 1,
      results: staleBodies.map((body, index) => ({ callId: `c${String(index + 1)}`, body })) });
    // Every row is held by the first boundary: the copies frozen when they land.
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(h.llm.calls.length, 0, 'every row is held, none asked yet');
    for (const [index, body] of trimmedBodies.entries()) {
      trimResultOnSurface(h.session, seqs[index] ?? -1,
        { callId: `c${String(index + 1)}`, body, turn: 1, step: 1 });
    }
    step(h.session, { turn: 2, step: 1, results: [{ callId: 'c15', body: fresh }] });
    await h.mount.runStep(h.session, { turn: 2, step: 2 });
    const staleLines = entryKinds(h.journal, 'entry-ask-row-stale');
    assert.equal(staleLines.length, 14, 'every changed row is dropped by name');
    assert.deepEqual(staleLines.map(line => line['rowIndex']), Array.from({ length: 14 }, (_, i) => i + 1));
    assert.equal(entryKinds(h.journal, 'entry-ask').length, 1, 'the one fresh row is asked');
    assert.equal(entryKinds(h.journal, 'entry-apply').length, 1, 'the fresh row applies');
    assert.equal(entryKinds(h.journal, 'entry-apply-refused').length, 0, 'no apply is refused');
    assert.equal(resultText(h.session, 'c15'), fresh, 'the fresh row keeps its bytes');
    assert.equal(resultText(h.session, 'c1'), trimmedBodies[0], 'a stale row keeps the trim');
    const entry = h.mount.sessions.get(h.session.id);
    assert.ok(entry !== undefined);
    assert.equal(await validationFailures(entry.ledger, entry.sessionId), 0,
      'zero validation events for the 14-row shape');
  } finally {
    await h.mount.close();
  }
});

// --- a batch that applies nothing collapses its exchange (ISSUE-185) --------

/**
 * The text of every surface message, as the model would read it: a
 * `user/message`'s own content, or a tool result's message content.
 */
function surfaceTextsOf(h: Harness): string[] {
  const texts: string[] = [];
  for (const seq of h.session.surface?.nodes ?? []) {
    const event = h.session.eventAt?.(seq);
    if (event === undefined) continue;
    const data = event.data as {
      content?: readonly { text?: string }[];
      message?: { content?: readonly { text?: string }[] };
    };
    const blocks = data.content ?? data.message?.content ?? [];
    const text = blocks.map(block => block.text ?? '').join('\n');
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

/**
 * `appendAskTurns` appends the ask and the answer as two `user/message` turns
 * before any row is read. A batch whose every row is refused — or whose answer
 * is unreadable row by row — applies nothing, so no row's apply takes the pair
 * off the surface, and the next model turn answers the stale question instead
 * of the task (the 2026-11-05 live run, seq 45–50).
 *
 * The rule pinned here: when NO row applies, the mount collapses the exchange
 * exactly as a keep-all does. When at least one row applies, that row's rewind
 * already removed it and the refused rows keep their bytes — the pair is never
 * left behind for a refused row, because one batch shares one exchange
 * (ADR-0035 §5).
 */
const COLLAPSE_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  readonly results: number;
  readonly batchSize: number;
  readonly answer: string;
  readonly refused: readonly string[];
  readonly applied: number;
  readonly collapsed: boolean;
}[] = [
  {
    name: 'every row refused',
    id: 'session-collapse-all',
    results: 3,
    batchSize: 3,
    answer: '{"1":{"forgetall":false}}\n{"2":{"forgetall":false}}\n{"3":{"forgetall":false}}',
    refused: ['malformed-row', 'malformed-row', 'malformed-row'],
    applied: 0,
    collapsed: true,
  },
  {
    name: 'the live one-row answer',
    id: 'session-collapse-live',
    results: 1,
    batchSize: 1,
    answer: '{"1":{"forgetall":false,"summary":"placeholder"}}',
    refused: ['malformed-row'],
    applied: 0,
    collapsed: true,
  },
  {
    name: 'every index missing',
    id: 'session-collapse-missing',
    results: 2,
    batchSize: 2,
    answer: '{"9":{"keepall":true}}',
    refused: ['missing-index', 'missing-index'],
    applied: 0,
    collapsed: true,
  },
  {
    name: 'partial refusal: two applied, one refused',
    id: 'session-collapse-partial',
    results: 3,
    batchSize: 3,
    answer: '{"1":{"keepall":true}}\n{"2":{"forgetall":false}}\n'
      + '{"3":{"forgetall":true,"summary":"the third listing"}}',
    refused: ['malformed-row'],
    applied: 2,
    collapsed: false,
  },
];

test('a batch that applies nothing collapses the ask exchange, and a partial one keeps the '
  + 'applied row\'s rewind', async () => {
  await runRows(COLLAPSE_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const bodies = Array.from({ length: scenario.results },
        (_, index) => bodyOf(40, `COL${String(index + 1)}`));
      const h = harness({ id: scenario.id, entryAskBatchSize: scenario.batchSize,
        llm: fakeLlm(answerChunks(scenario.answer), answerChunks('{"1":{"keepall":true}}')) });
      try {
        wire(h);
        step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
          callId: `c${String(index + 1)}`, body })) });
        await h.mount.runStep(h.session, { turn: 1, step: 2 });
        // The refusal codes are the ones this scenario names, in batch order.
        const refused = entryKinds(h.journal, 'entry-ask-refused');
        assert.deepEqual(refused.map(line => line['code']), scenario.refused,
          at('the refused rows journal their own codes'));
        assert.equal(entryKinds(h.journal, 'entry-ask').length, scenario.applied,
          at('only the answered rows journal an entry-ask line'));
        assert.equal(entryKinds(h.journal, 'entry-apply').length, scenario.applied,
          at('only the answered rows apply'));
        // The collapse is one line when nothing applied, and none when a row's
        // own rewind already removed the pair.
        const collapsed = entryKinds(h.journal, 'entry-ask-collapsed');
        assert.equal(collapsed.length, scenario.collapsed ? 1 : 0,
          at('the collapse line is written exactly when nothing applied'));
        if (scenario.collapsed) {
          assert.equal(collapsed[0]?.['status'], 'applied', at('the host accepted the collapse'));
          assert.equal(collapsed[0]?.['batchSize'], scenario.results,
            at('the collapse names the whole batch'));
        }
        // No ask turn survives on the surface, refused or not: the next turn's
        // input holds neither the question nor the answer text.
        const answerLines = scenario.answer.split('\n');
        const surface = surfaceTextsOf(h);
        assert.equal(surface.some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
          at('the ask question is gone from the surface'));
        assert.equal(surface.some(text => answerLines.some(line => text.includes(line))), false,
          at('the answer is gone from the surface'));
        // Every refused row keeps its bytes, byte for byte.
        const answered = new Set(entryKinds(h.journal, 'entry-ask')
          .map(line => line['batchIndex']));
        for (const [index, body] of bodies.entries()) {
          if (answered.has(index + 1)) continue;
          assert.equal(resultText(h.session, `c${String(index + 1)}`), body,
            at(`refused row ${String(index + 1)} keeps its bytes`));
        }
        // The next model turn reads the surface, not the stale question: the
        // next batch's ask is seeded from a transcript that holds no ask text.
        // A batch of N needs N new landings to fire (ADR-0035 §1–§2).
        step(h.session, { turn: 2, step: 1, results: Array.from(
          { length: scenario.batchSize },
          (_, index) => ({ callId: `n${String(index + 1)}`,
            body: bodyOf(40, `NEXT${String(index + 1)}`) })) });
        await h.mount.runStep(h.session, { turn: 2, step: 2 });
        assert.equal(h.llm.calls.length, 2, at('the next batch asks once more'));
        const nextSeed = sentTexts(h.llm.calls[1] ?? { messages: [] } as never).slice(0, -1);
        assert.equal(nextSeed.some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
          at('the next ask is seeded without the earlier question'));
        assert.equal(nextSeed.some(text => answerLines.some(line => text.includes(line))), false,
          at('the next ask is seeded without the earlier answer'));
      } finally {
        await h.mount.close();
      }
    },
  })));
});

// --- a full-range keeplines is the keep-whole form (ISSUE-221) --------------

/**
 * The 2026-11-07 live shape: the model answered `keeplines` naming every line
 * with a real summary, not the taught `"None"` spelling. The two-verdict gate
 * now reads that shape by what it DOES — a whole-range keep removes nothing —
 * so it normalizes to a clean `keepall` before any plan exists. The apply
 * therefore rewinds the exchange, and the fail-open collapse (ISSUE-215) has
 * nothing left to do: the pair is already off the surface.
 *
 * The rule pinned here: a full-range `keeplines` is a keep-whole whatever its
 * summary says; it is never a refusal and never a removal.
 */
const FULL_RANGE_LINES = 20;
/** Every line named, with a real summary: normalized to keepall, not refused. */
const FULL_RANGE_ANSWER = `{"1":{"keeplines":[[1,${String(FULL_RANGE_LINES)}]],`
  + '"summary":"every line stays"}}';

test('a full-range keeplines normalizes to keepall and rewinds the exchange (ISSUE-221)',
  async () => {
    const body = bodyOf(FULL_RANGE_LINES, 'FULLRANGE');
    const h = harness({ id: 'session-fullrange-keepall', entryAskBatchSize: 1,
      llm: fakeLlm(answerChunks(FULL_RANGE_ANSWER), answerChunks('{"1":{"keepall":true}}')) });
    try {
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      // The gate normalized the whole-range keep; the apply rewinds the pair.
      const applied = entryKinds(h.journal, 'entry-apply');
      assert.equal(applied.length, 1, 'the answered row reaches the apply');
      assert.equal(applied[0]?.['status'], 'rewound',
        'a full-range keeplines is a keep-all, not a refusal');
      assert.equal(applied[0]?.['appends'], 1, 'the rewind moved the surface');
      // A successful apply already took the pair off the surface, so the
      // ISSUE-215 collapse must not run a second time.
      assert.equal(entryKinds(h.journal, 'entry-ask-collapsed').length, 0,
        'a successful apply is never collapsed again');
      assert.equal(resultText(h.session, 'c1'), body, 'the landed result stays whole');
      // The next model turn reads the surface, not the stale question.
      const surface = surfaceTextsOf(h);
      assert.equal(surface.some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
        'the ask question is gone from the surface');
      assert.equal(surface.some(text => text.includes('every line stays')), false,
        'the answer is gone from the surface');
      assert.equal(surface.some(text => text.includes('read big.txt')), true,
        'the task is still on the surface');
      // And the next ask is seeded from that surface: no ask text rides into it.
      step(h.session, { turn: 2, step: 1, results: [{ callId: 'c2', body: bodyOf(40, 'NEXT') }] });
      await h.mount.runStep(h.session, { turn: 2, step: 2 });
      assert.equal(h.llm.calls.length, 2, 'the next landing asks once more');
      const nextSeed = sentTexts(h.llm.calls[1] ?? { messages: [] } as never).slice(0, -1);
      assert.equal(nextSeed.some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
        'the next request carries no ask question');
      assert.equal(nextSeed.some(text => text.includes('every line stays')), false,
        'the next request carries no answer text');
    } finally {
      await h.mount.close();
    }
  });

test('a successful apply writes no collapse line (ISSUE-215)', async () => {
  const cases = [
    { name: 'keep-all rewinds the exchange', id: 'session-success-keepall',
      results: 1, batchSize: 1, grammar: undefined, answer: '{"1":{"keepall":true}}',
      statuses: ['rewound'], appends: [1] },
    { name: 'forget lands the shaped turn', id: 'session-success-forget',
      results: 1, batchSize: 1, grammar: undefined,
      answer: '{"1":{"forgetall":true,"summary":"dropped the listing"}}',
      statuses: ['landed'], appends: [2] },
    // ISSUE-221: a full-range `keeplines` is the keep-whole form and normalizes
    // to `keepall`, so both rows rewind; the first row's write takes the shared
    // exchange off the surface, and the second names `rewound: true` without a
    // second append (ADR-0035 §5).
    { name: 'a full-range keep then a keep-all row', id: 'session-success-after-fullrange',
      results: 2, batchSize: 2, grammar: 'jsonl-20' as const,
      answer: `${FULL_RANGE_ANSWER}\n{"2":{"keepall":true}}`,
      statuses: ['rewound', 'rewound'], appends: [1, 0] },
  ] as const;
  for (const scenario of cases) {
    const h = harness({ id: scenario.id, entryAskBatchSize: scenario.batchSize,
      ...(scenario.grammar === undefined ? {} : { entryAskGrammar: scenario.grammar }),
      llm: fakeLlm(answerChunks(scenario.answer)) });
    try {
      wire(h);
      step(h.session, { turn: 1, step: 1, results: Array.from({ length: scenario.results },
        (_, index) => ({ callId: `c${String(index + 1)}`,
          body: bodyOf(20, `OK${String(index + 1)}`) })) });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      const applied = entryKinds(h.journal, 'entry-apply');
      assert.equal(applied.length, scenario.results,
        `${scenario.name}: every answered row applied once`);
      assert.deepEqual(applied.map(line => line['status']), [...scenario.statuses],
        `${scenario.name}: each row's own outcome`);
      assert.deepEqual(applied.map(line => line['appends']), [...scenario.appends],
        `${scenario.name}: the appends the host saw`);
      // The rows' own writes already took the exchange off the surface: a
      // collapse here would be a second write over a range that no longer exists.
      assert.equal(entryKinds(h.journal, 'entry-ask-collapsed').length, 0,
        `${scenario.name}: a successful apply is never collapsed again`);
      assert.equal(surfaceTextsOf(h).some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
        `${scenario.name}: the ask is gone from the surface`);
    } finally {
      await h.mount.close();
    }
  }
});

test('a fail-open apply whose exchange is already off the surface writes nothing '
  + '(ISSUE-215)', async () => {
  // A host trim between the ask and the answer can take the pair off the wire
  // before the collapse runs. The collapse must then refuse by name and write
  // nothing — never append over a range the surface no longer holds.
  const body = bodyOf(FULL_RANGE_LINES, 'GONE');
  const h = harness({ id: 'session-failopen-gone', entryAskBatchSize: 1,
    llm: fakeLlm(answerChunks(FULL_RANGE_ANSWER)) });
  let askTurns = 0;
  let trimmed = false;
  let seqAfterTrim = -1;
  let stop: () => void = () => {};
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    // Registered after the task's own message: the next two `user/message`
    // appends are the ask and its answer.
    stop = h.session.on((live, event) => {
      if (event.type !== 'user/message') return;
      askTurns += 1;
      if (trimmed || askTurns !== 2) return;
      trimmed = true;
      // The host's own delete idiom over the whole pair, recorded in the log: a
      // contentless node replacing `[ask … answer]`.
      const nodes = live.surface?.nodes ?? [];
      const askSeq = nodes[nodes.length - 2], answerSeq = nodes[nodes.length - 1];
      assert.equal(typeof askSeq, 'number', 'the ask turn is on the surface');
      assert.equal(typeof answerSeq, 'number', 'the answer turn is on the surface');
      live.append('system/message', { turn: 1, step: 2,
        message: { role: 'system', content: [], source: { kind: 'system-prompt' },
          id: 'trimmed-exchange' } },
      { surfaceOp: { startSeq: askSeq as number, endSeq: answerSeq as number } });
      seqAfterTrim = live.seq ?? -1;
    });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    stop();
    assert.equal(trimmed, true, 'the host trim ran');
    const applied = entryKinds(h.journal, 'entry-apply');
    assert.equal(applied.length, 1, 'the answered row reaches the apply');
    assert.equal(applied[0]?.['status'], 'fail-open', 'the write at a missing exchange fails open');
    assert.equal(applied[0]?.['appends'], 0, 'and nothing reached the surface');
    const collapsed = entryKinds(h.journal, 'entry-ask-collapsed');
    assert.equal(collapsed.length, 1, 'the collapse is attempted by name');
    assert.equal(collapsed[0]?.['status'], 'refused', 'the surface no longer holds the pair');
    assert.equal(collapsed[0]?.['code'], 'ask-exchange-missing',
      'the refusal names the missing exchange');
    // ISSUE-404 moved the card close after the apply leg, so the only event
    // allowed past the host trim is that log-only `command/done`. The surface
    // itself takes no write: the fail-open collapse must still write nothing.
    const afterTrim = h.session.log.slice(seqAfterTrim);
    assert.deepEqual(afterTrim.map(event => event.type), ['command/done'],
      'the mount wrote only the log-only card close after the host trim');
    assert.ok(afterTrim.every(event => event.surfaceOp === undefined),
      'no surface write followed the host trim');
    assert.equal(resultText(h.session, 'c1'), body, 'the landed result stays whole');
  } finally {
    await h.mount.close();
  }
});

// --- the entry-write slot binds one event's outcome (ISSUE-340) -------------

test('a committed apply whose engine then throws still moves the surface, and the next '
  + 'batch row reads its own write (ISSUE-340)', async () => {
  // The chain the audit named: row 1's forget commits its host write, then the
  // engine faults AFTER the commit. The mount's catch must consume row 1's slot
  // and report the surface move the host actually made, so row 2 names
  // `rewound: true` and lands its OWN shaped turn — never reading row 1's stale
  // `applied` write as a fail-open refusal, and never collapsing the exchange.
  const bodies = [bodyOf(20, 'SLOT1'), bodyOf(20, 'SLOT2')];
  const h = harness({ id: 'session-slot-340', entryAskBatchSize: 2,
    entryAskGrammar: 'jsonl-20',
    llm: fakeLlm(answerChunks('{"1":{"forgetall":true,"summary":"dropped one"}}\n'
      + '{"2":{"forgetall":true,"summary":"dropped two"}}')) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: bodies[0]! }] });
    // The first landing is held by the size-2 batch: no ask yet.
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(h.llm.calls.length, 0, 'the first row is held, not asked');
    const entry = h.mount.sessions.get(h.session.id);
    assert.ok(entry !== undefined);
    // Fault the engine AFTER row 1's answer apply commits. The real engine never
    // throws here, so the wrapper stands in for a host fault past the host write.
    const realProcess = entry.engine.process.bind(entry.engine);
    let answerCalls = 0;
    mock.method(entry.engine, 'process', async (input: any) => {
      const result = await realProcess(input);
      if (input.kind === 'entry' && input.answer !== undefined) {
        answerCalls += 1;
        if (answerCalls === 1) throw new Error('engine fault after the committed apply');
      }
      return result;
    });
    step(h.session, { turn: 2, step: 1, results: [{ callId: 'c2', body: bodies[1]! }] });
    await h.mount.runStep(h.session, { turn: 2, step: 2 });
    assert.equal(answerCalls, 2, 'both rows reached the engine answer');
    // Row 1 threw into the catch (entry-apply-refused, host-error); row 2 applied.
    const refused = entryKinds(h.journal, 'entry-apply-refused');
    assert.equal(refused.length, 1, 'only the engine fault refuses; row 2 is not a stale fail-open');
    assert.equal(refused[0]?.['code'], 'host-error');
    assert.equal(refused[0]?.['eventId'], 'dsh:session-slot-340:result:c1');
    const applied = entryKinds(h.journal, 'entry-apply');
    assert.equal(applied.length, 1, 'row 2 journals its own apply');
    assert.equal(applied[0]?.['eventId'], 'dsh:session-slot-340:result:c2');
    assert.equal(applied[0]?.['status'], 'landed', 'row 2 lands, reading its OWN applied write');
    assert.equal(applied[0]?.['writeStatus'], 'applied');
    assert.equal(applied[0]?.['appends'], 1, 'the exchange was already rewound by row 1');
    // The committed move took the exchange off the surface: no collapse runs.
    assert.equal(entryKinds(h.journal, 'entry-ask-collapsed').length, 0,
      'a committed surface move suppresses the batch collapse');
    assert.ok(resultText(h.session, 'c1')?.includes('dropped one'), 'row 1 shaped before the fault');
    assert.ok(resultText(h.session, 'c2')?.includes('dropped two'), 'row 2 shaped, not left whole');
    assert.equal(surfaceTextsOf(h).some(text => text.includes(ENTRY_ASK_END_ANCHOR)), false,
      'the ask is gone from the surface');
  } finally {
    await h.mount.close();
  }
});

test('a host refusal reaches the journal with its own code, not null (ISSUE-340)', async () => {
  // The result's SURFACE body changes while the answer turn lands, after the
  // port's transcript was last synced: the mount's local re-read still matches
  // (the transcript is unchanged), so the row reaches the port, whose surface
  // check refuses `result-turn-changed`. That refusal must ride the slot into
  // `DshEntryAnswerOutcome.refusal` and the journal — never `code: null`.
  const body = bodyOf(20, 'REFUSE');
  const h = harness({ id: 'session-refusal-340', entryAskBatchSize: 1,
    entryAskGrammar: 'jsonl-20',
    llm: fakeLlm(answerChunks('{"1":{"forgetall":true,"summary":"dropped"}}')) });
  let askTurns = 0;
  let trimmed = false;
  let stop: () => void = () => {};
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    stop = h.session.on((live, event) => {
      if (event.type !== 'user/message' || trimmed) return;
      const data = event.data as { source?: { kind?: string } };
      if (data.source?.kind !== 'racoons/negation/entry-ask') return;
      askTurns += 1;
      // The second entry-ask turn is the answer: both turns are on the surface,
      // and the apply has not run yet. Change the result body without syncing
      // the port, exactly as a concurrent host write would.
      if (askTurns !== 2) return;
      trimmed = true;
      let resultSeq = -1;
      for (const seq of live.surface?.nodes ?? []) {
        const ev = live.eventAt?.(seq);
        if (ev?.type === 'tool/result'
          && (ev.data as { message?: { toolCallId?: string } }).message?.toolCallId === 'c1') {
          resultSeq = seq;
        }
      }
      assert.notEqual(resultSeq, -1, 'the result is on the surface');
      trimResultOnSurface(live, resultSeq, { callId: 'c1', body: 'changed body', turn: 1, step: 1 });
    });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    stop();
    assert.equal(trimmed, true, 'the host trim ran');
    const refused = entryKinds(h.journal, 'entry-apply-refused');
    assert.equal(refused.length, 1, 'the answered row reaches the apply and is refused');
    assert.equal(refused[0]?.['code'], 'result-turn-changed',
      'the host refusal code reaches the journal, not null');
    const applied = entryKinds(h.journal, 'entry-apply');
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.['status'], 'fail-open');
    assert.equal(applied[0]?.['appends'], 0, 'the refusal wrote nothing to the surface');
    assert.equal(resultText(h.session, 'c1'), 'changed body', 'the refused row keeps the host\'s bytes');
  } finally {
    await h.mount.close();
  }
});

// --- a delivery throw re-queues the landing (ISSUE-343) ---------------------

test('a deliverEntry throw re-queues the landing for the next boundary (ISSUE-343)', async () => {
  // The buffer is drained before delivery; a throw used to consume the event
  // without delivering it, so the landing was skipped forever. The fault must
  // re-queue the capture: the next boundary delivers it and the result gets its
  // unit consideration. The ask is off so only the delivery lane is exercised.
  const body = bodyOf(20, 'REQUEUE');
  const h = harness({ id: 'session-requeue-343', entryAskTrigger: { mode: 'off' } });
  const eventId = 'dsh:session-requeue-343:result:c1';
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    const entry = await h.mount.sessionFor(h.session.id, h.session);
    const realProcess = entry.engine.process.bind(entry.engine);
    let deliveryCalls = 0;
    mock.method(entry.engine, 'process', async (input: any) => {
      if (input.kind === 'entry' && input.answer === undefined) {
        deliveryCalls += 1;
        if (deliveryCalls === 1) throw new Error('transient engine fault on delivery');
      }
      return realProcess(input);
    });
    // First boundary: the delivery throws and is journaled, not delivered.
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    const errors = entryKinds(h.journal, 'entry-error');
    assert.equal(errors.length, 1, 'the throw is journaled once');
    assert.equal(errors[0]?.['eventId'], eventId);
    assert.equal(entryKinds(h.journal, 'entry').filter(line => line['eventId'] === eventId).length, 0,
      'the first boundary delivered nothing');
    // Second boundary: the re-queued capture is delivered.
    await h.mount.runStep(h.session, { turn: 1, step: 3 });
    assert.equal(deliveryCalls, 2, 'the landing was attempted again, not skipped forever');
    const delivered = entryKinds(h.journal, 'entry').filter(line => line['eventId'] === eventId);
    assert.equal(delivered.length, 1, 'the retry delivers the entry event');
    assert.notEqual(entry.port.landedUnitId(eventId), null,
      'the result got its processing-unit consideration on the retry');
  } finally {
    await h.mount.close();
  }
});

/** A ledger two mounts share: the durable record a resumed process re-reads. */
class SharedLedger implements Ledger {
  readonly rows: LedgerEntry[] = [];
  async prepare(_application: PreparableApplication): Promise<PreparedIntent> {
    throw new Error('a keep-all plans nothing');
  }
  async append(event: LedgerEvent): Promise<LedgerEntry> {
    const row: LedgerEntry = { sequence: this.rows.length + 1, event };
    this.rows.push(row);
    return row;
  }
  async *events(sessionId: string): AsyncIterable<LedgerEntry> {
    for (const row of this.rows) if (row.event.sessionId === sessionId) yield row;
  }
  async recall(_id: string): Promise<RecallRecord> {
    throw new Error('nothing is banked');
  }
  async close(): Promise<void> {}
}

test('resume collapses an orphaned ask exchange and re-delivers the landing (ISSUE-341)', async () => {
  // A death between `appendAskTurns` and apply leaves the ask pair on the
  // surface and the checkpoint state in memory only. The resumed process (a
  // fresh mount over the same surface and ledger) must collapse the orphan,
  // re-deliver the landed result as an entry event, and honour the keep-all the
  // ledger already settled instead of asking the agent twice.
  const ledger = new SharedLedger();
  const h = harness({ id: 'session-resume-341', ledger, entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    const body = bodyOf(40);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    // The death: every host REPLACE throws, so the keep-all's rewind and the
    // batch's collapse both fail open and the exchange stays orphaned.
    const realAppend = h.session.append;
    h.session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      if (typeof options['surfaceOp'] === 'object' && options['surfaceOp'] !== null) {
        throw new Error('host died before the apply landed');
      }
      return realAppend(type, data, options);
    };
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    h.session.append = realAppend;
    const askNodes = (): number[] => (h.session.surface?.nodes ?? []).filter(seq => {
      const event = h.session.eventAt?.(seq);
      return event?.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'racoons/negation/entry-ask';
    });
    assert.equal(askNodes().length, 2, 'the death left the ask pair orphaned on the surface');
    assert.equal(resultText(h.session, 'c1'), body, 'the result stands whole');
    // The resumed process: a fresh mount, the same surface, the same ledger.
    const journal2: JournalLine[] = [];
    const llm2 = fakeLlm(answerChunks('{"keepall":true}'));
    const mount2 = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
        entryAskTrigger: { mode: 'count' }, entryAskGrammar: '3option' }),
      storage: resolveStorage(undefined), journal: record => journal2.push(record),
      llm: llm2 as never, judgeRoute: ROUTE, openLedger: async () => ledger,
    });
    try {
      const outcome = await mount2.runStep(h.session, { turn: 1, step: 3 });
      assert.equal(askNodes().length, 0,
        'resume removed the orphaned ask/answer exchange from the model wire');
      assert.equal(outcome.deliveries.length, 1,
        'the buffered result was re-delivered as an entry event');
      assert.equal(llm2.calls.length, 0,
        'the keep-all the ledger settled was not asked again');
      assert.equal(resultText(h.session, 'c1'), body, 'the kept result keeps its bytes');
      assert.equal(entryKinds(journal2, 'entry-resume-recovered').length, 1,
        'the recovery is journaled once');
    } finally {
      await mount2.close();
    }
  } finally {
    await h.mount.close();
  }
});

// --- a partial ask append never leaves an orphan (ISSUE-403) ----------------

test('a host failure on the answer turn collapses the ask already on the surface (ISSUE-403)',
  async () => {
    const h = harness({ id: 'session-append-fail-403', entryAskGrammar: '3option',
      llm: fakeLlm(answerChunks('{"keepall":true}')) });
    try {
      wire(h);
      const body = bodyOf(40);
      step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
      // The death this time is INSIDE `appendAskTurns`: the ask turn lands, the
      // answer turn throws. The prefix must collapse in the same call.
      const realAppend = h.session.append;
      let askTurns = 0;
      h.session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
        const source = (data as { source?: { kind?: string } }).source;
        if (type === 'user/message' && source?.kind === 'racoons/negation/entry-ask') {
          askTurns += 1;
          if (askTurns === 2) throw new Error('host failed on the answer turn');
        }
        return realAppend(type, data, options);
      };
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      h.session.append = realAppend;
      assert.equal(askTurns, 2, 'the answer turn was attempted');
      const askNodes = (h.session.surface?.nodes ?? []).filter(seq => {
        const event = h.session.eventAt?.(seq);
        return event?.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind
            === 'racoons/negation/entry-ask';
      });
      assert.equal(askNodes.length, 0, 'the written ask prefix left no orphan on the wire');
      const failed = entryKinds(h.journal, 'entry-ask-append-failed');
      assert.equal(failed.length, 1, 'the failure is journaled by name');
      assert.equal(failed[0]?.['appended'], 1, 'one turn had been written');
      assert.equal(failed[0]?.['collapse'], 'applied', 'the prefix was rewound');
      assert.equal(entryKinds(h.journal, 'entry-ask').length, 0,
        'nothing was recorded as an answered exchange');
      assert.equal(resultText(h.session, 'c1'), body, 'the result stands whole');
    } finally {
      await h.mount.close();
    }
  });

test('a host whose answer append writes then throws leaves the exchange owed, and the next '
  + 'boundary collapses it on the same mount (ISSUE-479)', async () => {
  const h = harness({ id: 'session-append-wrote-threw', entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    const body = bodyOf(40);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    // The death: the answer turn is WRITTEN, then the host throws. The append
    // returned no event, so the mount never sees that turn.
    const realAppend = h.session.append;
    let askTurns = 0;
    h.session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      const source = (data as { source?: { kind?: string } }).source;
      if (type === 'user/message' && source?.kind === 'racoons/negation/entry-ask') {
        askTurns += 1;
        if (askTurns === 2) {
          realAppend(type, data, options);
          throw new Error('host failed after writing the answer turn');
        }
      }
      return realAppend(type, data, options);
    };
    const askNodes = (): number[] => (h.session.surface?.nodes ?? []).filter(seq => {
      const event = h.session.eventAt?.(seq);
      return event?.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind
          === 'racoons/negation/entry-ask';
    });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    h.session.append = realAppend;
    assert.equal(askTurns, 2, 'the answer append was attempted');
    const failed = entryKinds(h.journal, 'entry-ask-append-failed');
    assert.equal(failed.length, 1, 'the failure is journaled by name');
    assert.equal(failed[0]?.['appended'], 1, 'only the ask turn was returned');
    assert.equal(failed[0]?.['collapse'], 'applied', 'the returned prefix was rewound');
    // The unreturned answer turn landed and is still on the surface: the
    // collapse of `[ask…ask]` cannot prove it left.
    assert.equal(askNodes().length, 1, 'the orphan answer turn survives the failed boundary');
    assert.equal(entryKinds(h.journal, 'entry-resume-recovered').length, 0,
      'the failing boundary claims no recovery');
    assert.equal(resultText(h.session, 'c1'), body, 'the result stands whole');
    // The same mount owes the exchange now, so the next boundary's surface scan
    // collapses the turns that actually landed.
    await h.mount.runStep(h.session, { turn: 1, step: 3 });
    assert.equal(askNodes().length, 0, 'the next boundary removed the orphan');
    const recovered = entryKinds(h.journal, 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'the next boundary finished the recovery');
    assert.equal(recovered[0]?.['collapsed'], 1, 'the orphan answer was one applied collapse');
  } finally {
    await h.mount.close();
  }
});

test('a host whose FIRST ask append writes then throws still owes the exchange, and the next '
  + 'boundary collapses the landed turn (ISSUE-479)', async () => {
  const h = harness({ id: 'session-append-first-threw', entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    const body = bodyOf(40);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    // The death: the FIRST ask turn is written, then the host throws. No append
    // returned an event, so `events` is empty and there is no range to collapse.
    const realAppend = h.session.append;
    let askTurns = 0;
    h.session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      const source = (data as { source?: { kind?: string } }).source;
      if (type === 'user/message' && source?.kind === 'racoons/negation/entry-ask') {
        askTurns += 1;
        if (askTurns === 1) {
          realAppend(type, data, options);
          throw new Error('host failed after writing the first ask turn');
        }
      }
      return realAppend(type, data, options);
    };
    const askNodes = (): number[] => (h.session.surface?.nodes ?? []).filter(seq => {
      const event = h.session.eventAt?.(seq);
      return event?.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind
          === 'racoons/negation/entry-ask';
    });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    h.session.append = realAppend;
    assert.equal(askTurns, 1, 'the first append threw before returning an event');
    const failed = entryKinds(h.journal, 'entry-ask-append-failed');
    assert.equal(failed.length, 1, 'the failure is journaled by name');
    assert.equal(failed[0]?.['appended'], 0, 'no append returned an event');
    assert.equal(failed[0]?.['collapse'], undefined,
      'with zero returned events there is no range to collapse at the failure');
    // The written ask turn is orphaned; the debt must survive even though the
    // empty event list gives the failure path nothing to rewind.
    assert.equal(askNodes().length, 1, 'the written ask turn survives the failed boundary');
    assert.equal(entryKinds(h.journal, 'entry-resume-recovered').length, 0,
      'the failing boundary claims no recovery');
    assert.equal(resultText(h.session, 'c1'), body, 'the result stands whole');
    // The same mount owes the exchange now, so the next boundary's surface scan
    // collapses the lone `entry-ask` turn that actually landed.
    await h.mount.runStep(h.session, { turn: 1, step: 3 });
    assert.equal(askNodes().length, 0, 'the next boundary removed the orphaned ask turn');
    const recovered = entryKinds(h.journal, 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'the next boundary finished the recovery');
    assert.equal(recovered[0]?.['collapsed'], 1, 'the lone ask turn was one applied collapse');
  } finally {
    await h.mount.close();
  }
});

test('a mixed batch with one undecided row settles an error card naming the count (ISSUE-480)',
  async () => {
    const h = harness({ id: 'session-batch-refused-row', entryAskBatchSize: 2,
      entryAskGrammar: '3option', llm: fakeLlm(answerChunks('{"1":{"keepall":true}}')) });
    try {
      wire(h);
      const bodies = [bodyOf(40, 'ROW1'), bodyOf(40, 'ROW2')];
      step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
        callId: `c${String(index + 1)}`, body })) });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      // Row 1 applies; index 2 carries no verdict, so the table reader refuses
      // it and the row keeps its unit whole.
      const refused = entryKinds(h.journal, 'entry-ask-refused');
      assert.equal(refused.length, 1, 'the undecided row is refused by name');
      assert.equal(refused[0]?.['batchIndex'], 2, 'the second row is the refused one');
      assert.equal(refused[0]?.['code'], 'missing-index', 'the reader names the omission');
      assert.equal(entryKinds(h.journal, 'entry-apply').length, 1, 'the answered row still applied');
      assert.equal(resultText(h.session, 'c2'), bodies[1], 'the refused row keeps its bytes');
      // The visible card must not read as a completed ask while a paid answer
      // was lost.
      const done = h.session.log.filter(event => event.type === 'command/done');
      assert.equal(done.length, 1, 'exactly one card settled');
      const data = done[0]?.data as { kind?: string; text?: string } | undefined;
      assert.equal(data?.kind, 'error', 'a mixed batch is an error card');
      assert.match(data?.text ?? '', /1 row\(s\) refused/u, 'the text names the refused count');
    } finally {
      await h.mount.close();
    }
  });

test('a mixed batch whose second row moves between ask and apply settles an error card naming '
  + 'the refused count (ISSUE-480)', async () => {
  let h!: Harness;
  let staleSeq = -1;
  // The host trims the second row while the model is answering: its bytes move
  // between the ask's read and the apply's re-read, so the answer names content
  // that no longer exists.
  const staleBody = bodyOf(40, 'ROW2-STALE');
  const answer = answerChunks('{"1":{"keepall":true},"2":{"keepall":true}}');
  const llm = fakeLlm(() => (async function* emit() {
    trimResultOnSurface(h.session, staleSeq, { callId: 'c2', body: staleBody,
      turn: 1, step: 1 });
    for (const chunk of answer) yield chunk;
  })());
  h = harness({ id: 'session-batch-stale-row', entryAskBatchSize: 2,
    entryAskGrammar: '3option', llm });
  try {
    wire(h);
    const bodies = [bodyOf(40, 'ROW1'), bodyOf(40, 'ROW2')];
    const seqs = step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
      callId: `c${String(index + 1)}`, body })) });
    staleSeq = seqs[1] as number;
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    // The model answers both rows, but row 2's bytes moved before the apply, so
    // the apply lane refuses it locally and the row keeps its unit whole.
    const stale = entryKinds(h.journal, 'entry-apply-refused');
    assert.equal(stale.length, 1, 'the moved row is refused by the apply lane');
    assert.equal(stale[0]?.['code'], 'ask-row-stale', 'the refusal names the stale read');
    assert.equal(stale[0]?.['batchIndex'], 2, 'the second row is the stale one');
    assert.equal(entryKinds(h.journal, 'entry-apply').length, 1, 'the first row still applied');
    assert.equal(resultText(h.session, 'c2'), staleBody, 'the stale row keeps its live bytes');
    // The visible card must not read as a completed ask while a paid answer was
    // refused for moved bytes.
    const done = h.session.log.filter(event => event.type === 'command/done');
    assert.equal(done.length, 1, 'exactly one card settled');
    const data = done[0]?.data as { kind?: string; text?: string } | undefined;
    assert.equal(data?.kind, 'error', 'a stale row makes the batch an error card');
    assert.match(data?.text ?? '', /1 row\(s\) refused/u, 'the text names the refused count');
  } finally {
    await h.mount.close();
  }
});

test('a refused recovery collapse keeps resume recovery owing, and the retry still lands '
  + '(ISSUE-403)', async () => {
  const ledger = new SharedLedger();
  const h = harness({ id: 'session-refused-recovery-403', ledger, entryAskGrammar: '3option',
    llm: fakeLlm(answerChunks('{"keepall":true}')) });
  try {
    wire(h);
    const body = bodyOf(40);
    step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body }] });
    // The death: every host REPLACE throws, so the ask pair stays orphaned.
    const realAppend = h.session.append;
    h.session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      if (typeof options['surfaceOp'] === 'object' && options['surfaceOp'] !== null) {
        throw new Error('host died before the apply landed');
      }
      return realAppend(type, data, options);
    };
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    h.session.append = realAppend;
    const asks = (): number[] => (h.session.surface?.nodes ?? []).filter(seq => {
      const event = h.session.eventAt?.(seq);
      return event?.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'racoons/negation/entry-ask';
    });
    assert.equal(asks().length, 2, 'the death left the pair orphaned');
    const answerSeq = asks()[1] as number;
    // Cold recovery reads the answer once as an ask turn, then the port's
    // surface derivation reads it again. Make that second read disagree, so the
    // rewind refuses `ask-exchange-missing` instead of writing.
    const realEventAt = h.session.eventAt as (seq: number) => DshMountEvent | undefined;
    let answerReads = 0;
    h.session.eventAt = (seq: number) => {
      const event = realEventAt(seq);
      if (seq !== answerSeq || event === undefined) return event;
      answerReads += 1;
      return answerReads <= 1 ? event : Object.freeze({ ...event, type: 'tool/result',
        data: { message: { source: { callId: 'ghost' } } } }) as DshMountEvent;
    };
    const journal2: JournalLine[] = [];
    const mount2 = createRacoonsMount({
      config: resolvePluginConfig({ floorBytes: 512, barBytes: 8192,
        entryAskTrigger: { mode: 'off' } }),
      storage: resolveStorage(undefined), journal: record => journal2.push(record),
      llm: fakeLlm(answerChunks('{"keepall":true}')) as never, judgeRoute: ROUTE,
      openLedger: async () => ledger,
    });
    try {
      await mount2.runStep(h.session, { turn: 1, step: 3 });
      // The flip was only for the recovery's surface derivation; restore the
      // host before the assertion reads the surface again.
      h.session.eventAt = realEventAt;
      assert.equal(asks().length, 2, 'a refused rewind leaves the pair in place');
      const collapsed = entryKinds(journal2, 'entry-ask-collapsed');
      assert.equal(collapsed[0]?.['status'], 'refused', 'the host refused the rewind');
      const retry = entryKinds(journal2, 'entry-recovery-retry');
      assert.equal(retry.length, 1, 'the retry is named, not silently dropped');
      assert.equal(retry[0]?.['step'], 'collapse');
      assert.equal(retry[0]?.['reason'], 'collapse-refused');
      assert.equal(entryKinds(journal2, 'entry-resume-recovered').length, 0,
        'a refused collapse is not counted as recovered');
      // The next boundary retries with the healthy host and finishes the recovery.
      await mount2.runStep(h.session, { turn: 1, step: 4 });
      assert.equal(asks().length, 0, 'the retry removed the orphan');
      assert.equal(entryKinds(journal2, 'entry-resume-recovered').length, 1,
        'the recovery finished once the host cooperated');
    } finally {
      await mount2.close();
    }
  } finally {
    await h.mount.close();
  }
});

// --- the refused row's inner code (ISSUE-179) -------------------------------

/**
 * `entry-ask-refused` carries the wire parser's own code under `wireCode` when a
 * malformed row had one, so a future run can never report "136 malformed rows"
 * without saying what was wrong with them. The field is additive: a refusal with
 * no inner defect (a missing row, a grammar refusal, a whole-text failure) writes
 * no `wireCode` at all, and a reader of the older rows sees the same shapes it
 * always saw.
 */
test('a refused batch row journals the wire parser\'s own code, and a refusal with no inner '
  + 'defect claims none', async () => {
  const bodies = [bodyOf(40, 'WC1'), bodyOf(40, 'WC2'), bodyOf(40, 'WC3')];
  /** `wireCode` value the journal line carries, or the string `<absent>`. */
  const wireCodeOf = (line: JournalLine | undefined): unknown =>
    line !== undefined && Object.hasOwn(line, 'wireCode') ? line['wireCode'] : '<absent>';
  const rows: Row[] = [
    {
      name: 'a malformed row journals its inner code beside the coarse one',
      async run(at) {
        const h = harness({ id: 'session-wirecode-1', entryAskBatchSize: 3,
          entryAskGrammar: '3option',
          llm: fakeLlm(answerChunks('{"1":{"keeplines":[[0,5],"s"]},'
            + '"2":{"keepall":true},"3":{"forgetall":"stale"}}')) });
        try {
          wire(h);
          step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
            callId: `c${String(index + 1)}`, body })) });
          await h.mount.runStep(h.session, { turn: 1, step: 2 });
          const refused = entryKinds(h.journal, 'entry-ask-refused');
          assert.equal(refused.length, 1, at('only the zero-based span row is refused'));
          assert.equal(refused[0]?.['code'], 'malformed-row', at('the coarse code is unchanged'));
          assert.equal(wireCodeOf(refused[0]), 'invalid-span',
            at('the inner defect is named — a zero-based span, not just "malformed"'));
          assert.equal(entryKinds(h.journal, 'entry-ask').length, 2,
            at('the two well-formed rows still applied'));
        } finally {
          await h.mount.close();
        }
      },
    },
    {
      name: 'a bare partial action is refused under ADR-0039 and its inner code is journaled',
      async run(at) {
        // `"keeplines"` is the shape ADR-0039 keeps refused: it names spans it
        // does not carry, so its `malformed-row` must say which defect.
        const h = harness({ id: 'session-wirecode-4', entryAskBatchSize: 3,
          entryAskGrammar: '3option',
          llm: fakeLlm(answerChunks('{"1":"keeplines","2":"keepall","3":"forgetall"}')) });
        try {
          wire(h);
          step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
            callId: `c${String(index + 1)}`, body })) });
          await h.mount.runStep(h.session, { turn: 1, step: 2 });
          const refused = entryKinds(h.journal, 'entry-ask-refused');
          assert.equal(refused.length, 1, at('only the bare partial row is refused'));
          assert.equal(wireCodeOf(refused[0]), 'not-an-object',
            at('the inner defect is named — a string is not a wire verdict object'));
          // The two bare whole-unit rows answered, so the normalisation held
          // beside the journal field rather than one hiding the other.
          const asked = entryKinds(h.journal, 'entry-ask');
          assert.deepEqual(asked.map(line => line['action']), ['keepall', 'forgetall'],
            at('both bare whole-unit rows applied'));
        } finally {
          await h.mount.close();
        }
      },
    },
    {
      name: 'a hole in the answer claims no wireCode, because no parser defect made it',
      async run(at) {
        const h = harness({ id: 'session-wirecode-2', entryAskBatchSize: 3,
          entryAskGrammar: '3option',
          llm: fakeLlm(answerChunks('{"2":{"keepall":true},"3":{"keepall":true}}')) });
        try {
          wire(h);
          step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
            callId: `c${String(index + 1)}`, body })) });
          await h.mount.runStep(h.session, { turn: 1, step: 2 });
          const missing = entryKinds(h.journal, 'entry-ask-refused')
            .find(line => line['code'] === 'missing-index');
          assert.ok(missing !== undefined, at('the absent row is refused by its own code'));
          assert.equal(wireCodeOf(missing), '<absent>',
            at('a missing row had no parser defect, so the field is not written at all'));
        } finally {
          await h.mount.close();
        }
      },
    },
    {
      name: 'a grammar refusal claims no wireCode, because the wire read fine',
      async run(at) {
        const h = harness({ id: 'session-wirecode-3',
          entryAskBatchSize: 3, entryAskGrammar: 'two-option',
          llm: fakeLlm(answerChunks('{"1":{"keepall":true},"2":{"keepall":true},'
            + '"3":{"keeplines":[[1,4],"kept the head"]}}')) });
        try {
          wire(h);
          step(h.session, { turn: 1, step: 1, results: bodies.map((body, index) => ({
            callId: `c${String(index + 1)}`, body })) });
          await h.mount.runStep(h.session, { turn: 1, step: 2 });
          const refused = entryKinds(h.journal, 'entry-ask-refused');
          assert.equal(refused.length, 1, at('the lined row is refused under two-option'));
          assert.equal(refused[0]?.['code'], 'action-not-in-grammar',
            at('the grammar names the refusal'));
          assert.equal(wireCodeOf(refused[0]), '<absent>',
            at('the wire parsed cleanly, so there is no inner code to claim'));
        } finally {
          await h.mount.close();
        }
      },
    },
  ];
  await runRows(rows);
});

// --- 13. the live-run configuration at its own numbers (ISSUE-128/129) ------

/** One tool-result body of EXACTLY `bytes` ASCII bytes (whole lines, then a tail). */
function exactBody(bytes: number, tag: string): string {
  const line = `${tag}-line ${'z'.repeat(40)}\n`;
  const whole = Math.floor(bytes / line.length);
  return line.repeat(whole) + 't'.repeat(bytes - whole * line.length);
}

/**
 * The two entry cadences at their own numbers, one row each: the explicit
 * `count` compatibility cadence asks each eligible result on its own in the
 * shipped `jsonl-20` contract, and the live `landed-bytes` cadence holds under
 * 240,000 and fires one ask over the whole pending stream at the crossing. Each
 * row scripts its own landings.
 */
const CADENCE_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  run(context: { readonly h: Harness; readonly at: Label }): Promise<void>;
}[] = [
  {
    name: 'count cadence',
    id: 'session-count',
    async run({ h, at }) {
      // The explicit `count` compatibility trigger: each eligible result is
      // asked on its own, in the shipped `jsonl-20` contract (owner ruling
      // 2026-11-05). A run that silently adopted the batch or byte trigger
      // would change this.
      const bodies = [bodyOf(40, 'CNTA'), bodyOf(40, 'CNTB')];
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [
        { callId: 'c1', body: bodies[0] ?? '' }, { callId: 'c2', body: bodies[1] ?? '' }] });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(h.llm.calls.length, 2, at('the count cadence is one ask per result'));
      // ISSUE-194: the session's first ask states the 70 percent share line;
      // every later ask states 40 percent. One ask per result, two variants.
      const prefixOf = (prompt: string): string =>
        prompt.slice(0, prompt.indexOf(PRUNE_ASK_JSONL_20_SLOT));
      const prefixes = [
        prefixOf(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT),
        prefixOf(PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT),
      ];
      for (const [position, call] of h.llm.calls.entries()) {
        const texts = sentTexts(call);
        const ask = texts[texts.length - 1] ?? '';
        assert.ok(ask.startsWith(prefixes[position] ?? ''),
          at(`ask ${String(position + 1)} states the ${position === 0 ? 'first' : 'later'}`
            + ' trigger jsonl-20 pre-table contract'));
        assert.equal(ask.split('\n').filter(line => /^\d+\. \[/u.test(line)).length, 1,
          at('a one-row batch is one counted table line'));
      }
      assert.equal(entryKinds(h.journal, 'entry-ask-hold').length, 0,
        at('count mode at its default holds nothing'));
      const asked = entryKinds(h.journal, 'entry-ask');
      assert.deepEqual(asked.map(line => line['batchSize']), [1, 1],
        at('each ask names a batch of one'));
      assert.deepEqual(asked.map(line => line['action']), ['keepall', 'keeplines'],
        at('each answer applied by its own action'));
      assert.equal(entryKinds(h.journal, 'entry-ask-refused').length, 0,
        at('the default grammar admits keeplines'));
      assert.deepEqual(entryKinds(h.journal, 'entry-apply').map(line => line['status']),
        ['rewound', 'landed'], at('the keep-all rewinds, the lined row lands'));
      assert.equal(resultText(h.session, 'c1'), bodies[0],
        at('a keep-all row keeps its bytes'));
      assert.notEqual(resultText(h.session, 'c2'), bodies[1], at('the lined row was shaped'));
    },
  },
  {
    name: 'landed-bytes 240,000',
    id: 'session-lb-live',
    async run({ h, at }) {
      // The live run's own configuration: the accumulator sums each eligible
      // result's own bytes and fires at 240,000. Two landings stay under it and
      // send nothing; the landing that makes the sum exactly 240,000 fires ONE
      // ask over the WHOLE pending stream, in the two-option contract.
      const first = exactBody(120_000, 'LBA');
      const second = exactBody(119_000, 'LBB');
      const third = exactBody(1_000, 'LBC');
      assert.equal(encoder.encode(first).length, 120_000, at('the first body is 120,000 bytes'));
      assert.equal(encoder.encode(second).length, 119_000,
        at('the second body is 119,000 bytes'));
      assert.equal(encoder.encode(third).length, 1_000, at('the third body is 1,000 bytes'));
      wire(h);
      step(h.session, { turn: 1, step: 1, results: [{ callId: 'c1', body: first }] });
      await h.mount.runStep(h.session, { turn: 1, step: 2 });
      assert.equal(h.llm.calls.length, 0, at('120,000 bytes is under 240,000: nothing fires'));
      step(h.session, { turn: 2, step: 1, results: [{ callId: 'c2', body: second }] });
      await h.mount.runStep(h.session, { turn: 2, step: 2 });
      assert.equal(h.llm.calls.length, 0,
        at('239,000 bytes is still under 240,000: nothing fires'));
      // The two held landings name the accumulator, not a count.
      const holds = entryKinds(h.journal, 'entry-ask-hold');
      assert.deepEqual(holds.map(line => line['landedBytes']), [120_000, 239_000],
        at('the accumulator sums each landing'));
      assert.deepEqual(holds.map(line => line['pending']), [1, 2],
        at('each hold names its pending count'));
      assert.equal(holds.every(line => !Object.hasOwn(line, 'batchSize')), true,
        at('the byte cadence names no count'));
      // The landing that reaches exactly 240,000 is the fire.
      step(h.session, { turn: 3, step: 1, results: [{ callId: 'c3', body: third }] });
      await h.mount.runStep(h.session, { turn: 3, step: 2 });
      assert.equal(h.llm.calls.length, 1,
        at('exactly at 240,000 the trigger fires one ask'));
      assert.equal(entryKinds(h.journal, 'entry-ask-hold').length, 2,
        at('the crossing landing is never held: the fire includes it'));
      const ask = lastAskText(h);
      // The contract the ask states is the two-option prompt, byte for byte.
      assert.ok(ask.startsWith(`${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}

`),
        at('the fired ask states the two-option contract'));
      assert.equal(ask.includes('There is no line-level option'), true,
        at('the ask says plainly that a row is not partially kept'));
      assert.equal(ask.includes('keeplines'), false,
        at('the absent lined example is the whole point of the grammar'));
      // One row per pending result, in arrival order: the whole stream, not the newcomer.
      const rows = ask.split('\n').filter(line => /^\d+\. \[/u.test(line));
      assert.equal(rows.length, 3, at('the ask covers the whole pending stream'));
      assert.equal(ask.endsWith(ENTRY_ASK_END_ANCHOR), true,
        at('the batch ends on the entry anchor'));
      // Every row answered and applied: rows 4 and 5 never re-ask a held result.
      const asked = entryKinds(h.journal, 'entry-ask');
      assert.deepEqual(asked.map(line => line['batchIndex']), [1, 2, 3],
        at('each pending row answered at its batch position'));
      assert.deepEqual(entryKinds(h.journal, 'entry-apply').map(line => line['status']),
        ['rewound', 'landed', 'landed'], at('row 1 rewinds, rows 2 and 3 land'));
      assert.equal(resultText(h.session, 'c1'), first, at('a keep-all row keeps its bytes'));
    },
  },
];

test('the explicit count cadence and the live landed-bytes cadence each keep their stream',
  async () => {
    await runRows(CADENCE_ROWS.map((scenario): Row => ({
      name: scenario.name,
      async run(at) {
        // The landed-bytes row needs its own trigger; the count row takes the
        // shipped defaults. Both answer with keep-all, forget, forget.
        const h = scenario.name === 'count cadence'
          ? harness({ id: scenario.id, llm: fakeLlm(answerChunks('{"1":{"keepall":true}}'),
            answerChunks('{"1":{"keeplines":[[1,4]],"summary":"kept the head of the listing"}}')) })
          : harness({ id: scenario.id,
            entryAskTrigger: { mode: 'landed-bytes', bytes: 240_000 },
            entryAskGrammar: 'two-option',
            llm: fakeLlm(answerChunks('{"1":{"keepall":true},'
              + '"2":{"forgetall":"the second listing"},'
              + '"3":{"forgetall":"the third listing"}}')) });
        try {
          await scenario.run({ h, at });
        } finally {
          await h.mount.close();
        }
      },
    })));
  });

// --- 14. a keep-all on a later batch row (ISSUE-130) -----------------------

test('a keep-all on the middle row of a three-row batch applies rewound, not fail-open', async () => {
  // The 5d-i reproduction: rows 1 and 3 forget, row 2 keeps. Before ISSUE-130
  // the keep row called `port.rewindAskExchange` on an exchange an earlier row
  // had already taken off the surface, so it journalled fail-open and never
  // settled. The kept row must apply as `rewound` (it still keeps its bytes),
  // settle on both marker sets, and never be re-asked by a redelivery.
  const bodies = [bodyOf(40, 'LATEA'), bodyOf(40, 'LATEB'), bodyOf(40, 'LATEC')];
  const composite = '{"1":{"forgetall":"the first listing"},'
    + '"2":{"keepall":true},"3":{"forgetall":"the third listing"}}';
  const h = harness({ entryAskBatchSize: 3, entryAskGrammar: 'two-option',
    llm: fakeLlm(answerChunks(composite)) });
  try {
    wire(h);
    step(h.session, { turn: 1, step: 1, results: [
      { callId: 'c1', body: bodies[0] ?? '' },
      { callId: 'c2', body: bodies[1] ?? '' },
      { callId: 'c3', body: bodies[2] ?? '' }] });
    await h.mount.runStep(h.session, { turn: 1, step: 2 });
    assert.equal(h.llm.calls.length, 1, 'one ask covers the whole batch');
    const applied = entryKinds(h.journal, 'entry-apply');
    assert.deepEqual(applied.map(line => line['status']), ['landed', 'rewound', 'landed'],
      'the middle keep-all rewinds, the two forgets land');
    assert.equal(applied.some(line => line['status'] === 'fail-open'), false,
      'no row falls open');
    assert.equal(h.journal.some(line => JSON.stringify(line).includes('planned nothing to apply')),
      false, 'no row reports an empty plan');
    assert.equal(resultText(h.session, 'c2'), bodies[1], 'the kept row keeps its bytes');
    // Both marker sets hold the kept row: the answer settled it.
    const entry = h.mount.sessions.get(h.session.id);
    assert.ok(entry !== undefined);
    assert.equal(entry.entryJudged.has('dsh:session-entry:result:c2'), true,
      'the keep-all settled the middle row');
    assert.equal(entry.entryKept.has('dsh:session-entry:result:c2'), true,
      'an applied keep-all is a settled keep');
    // A redelivery of the kept row must not re-ask it.
    for (const event of h.session.log.filter(candidate => candidate.type === 'tool/result')) {
      h.mount.observe(h.session, event);
    }
    await h.mount.runStep(h.session, { turn: 2, step: 1 });
    assert.equal(h.llm.calls.length, 1, 'the settled kept row is never re-asked');
    assert.equal(entryKinds(h.journal, 'entry-ask').length, 3, 'the batch asked each row once');
  } finally {
    await h.mount.close();
  }
});

// --- ISSUE-432: model-derived parameters follow the live host route ----------

test('ISSUE-469: a smaller-floor model switch lets an answered removal apply', async () => {
  const session = fakeSession('session-engine-floor');
  const journal: JournalLine[] = [];
  const llm = fakeLlm(answerChunks('{"forgetall":"an old listing"}'));
  const mount = createRacoonsMount({
    // No explicit floor and no fixed route: the host header is the only route
    // source, so the opening floor is the 1280-byte model.
    config: resolvePluginConfig({ barBytes: 8192, entryAskTrigger: { mode: 'count' },
      entryAskGrammar: '3option' }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: llm as never,
  });
  session.on((live, event) => { mount.observe(live, event); });
  try {
    session.setRoute({ provider: 'p', model: 'deepseek-v4.1-flash-1017' });
    mount.observeWire({ sessionId: session.id, provider: 'p',
      model: 'deepseek-v4.1-flash-1017', ...MAIN_WIRE });
    step(session, { turn: 1, step: 1, results: [] });
    await mount.runStep(session, { turn: 1, step: 1 });
    assert.equal(llm.calls.length, 0, 'the 1280-byte opening floor asks nothing yet');

    session.setRoute({ provider: 'p', model: 'gpt-6-astra' });
    mount.observeWire({ sessionId: session.id, provider: 'p', model: 'gpt-6-astra',
      ...MAIN_WIRE });
    // ~620 bytes: below the old 1280 floor, above the new 256-byte floor.
    step(session, { turn: 2, step: 1, results: [{ callId: 'c-small', body: bodyOf(20) }] });
    await mount.runStep(session, { turn: 2, step: 1 });

    assert.equal(llm.calls.length, 1, 'the refreshed floor made the result askable');
    const refresh = entryKinds(journal, 'model-refresh');
    assert.equal(refresh.length, 1, 'the switch is named once');
    assert.deepEqual(refresh[0]?.['to'],
      { provider: 'p', model: 'gpt-6-astra', floorBytes: 256 }, 'the entry floor follows');
    const applied = entryKinds(journal, 'entry-apply');
    assert.deepEqual(applied.map(line => line['status']), ['landed'],
      'the engine guard enforced the same floor as the ask gate');
    assert.equal(journal.some(line => line['code'] === 'unknown-unit'), false,
      'no paid answer is refused against a stale floor');
  } finally {
    await mount.close();
  }
});

test('ISSUE-432: a mid-session model switch re-derives the entry floor', async () => {
  const session = fakeSession('session-model-switch');
  const journal: JournalLine[] = [];
  const mount = createRacoonsMount({
    // No explicit `floorBytes` and no fixed `judgeRoute`: the host header is
    // the only route source, exactly the shape that can switch mid-session.
    config: resolvePluginConfig({ barBytes: 8192, entryAskTrigger: { mode: 'off' } }),
    storage: resolveStorage(undefined),
    journal: record => journal.push(record),
    llm: fakeLlm(answerChunks('{}')) as never,
  });
  session.on((live, event) => { mount.observe(live, event); });
  try {
    step(session, { turn: 1, step: 1, results: [{ callId: 'call_floor_a', body: bodyOf(1) }] });
    await mount.runStep(session, { turn: 1, step: 1 });
    assert.equal(journal.filter(line => line.kind === 'model-refresh').length, 0,
      'the opening route is stamped, not reported as a change');

    session.setRoute({ provider: 'p', model: 'deepseek-v4-pro' });
    step(session, { turn: 2, step: 1, results: [{ callId: 'call_floor_b', body: bodyOf(1) }] });
    await mount.runStep(session, { turn: 2, step: 1 });

    const refresh = journal.filter(line => line.kind === 'model-refresh');
    assert.equal(refresh.length, 1, 'the switch is named once');
    assert.deepEqual(refresh[0]?.['from'],
      { provider: 'p', model: 'm', floorBytes: 512 }, 'the old route and floor are named');
    assert.deepEqual(refresh[0]?.['to'],
      { provider: 'p', model: 'deepseek-v4-pro', floorBytes: 768 },
    'the new route and its table floor are named');
    assert.equal(refresh[0]?.['window'], 'host-model-info',
      'the window is named as model-derived (ADR-0071), not claimed refreshed');
    const entry = mount.sessions.get(session.id);
    assert.equal(entry?.floorBytes, 768, 'the entry now reads the new model floor');
    assert.equal(entry?.floorModel, 'deepseek-v4-pro');
  } finally {
    await mount.close();
  }
});

