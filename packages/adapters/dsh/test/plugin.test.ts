/**
 * The shipped mount entry's seams, with the REAL engine and adapter, against a
 * fake Cordis context and fake dsh sessions.
 *
 * What this covers without dsh: plugin shape, config plumbing (including the
 * ADR-0008 `apply` enforcement default), storage refusal, host-event → item mapping,
 * the two publication shapes, and the S7 rule that a failed result is never
 * queued for removal. Whether the real host accepts those appends is the rig's job.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  LedgerError, canonicalManifestBytes, sha256Sync,
} from '@cremator/core';
import type { RecallRecord } from '@cremator/core';
import type { DshLlmService, DshMountContext, DshMountEvent, DshMountSession }
  from '../src/plugin.js';
import {
  CREMATOR_PLUGIN_INJECT, CREMATOR_PLUGIN_NAME, createRacoonsMount, createRacoonsPlugin,
  engineConfig, eventIdFor, publishAppend, registerPluginTools, resolvePluginConfig,
  resolveSessionStorage, resolveStorage, resultFactsFromMeta, singleLiveSession,
  surfaceTranscript, targetFromInput, toolResultItem,
} from '../src/plugin.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';
import { createMainWireCapture } from '../src/main-wire.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  on(listener: (session: FakeSession, event: DshMountEvent) => void): () => void;
  /** Set the route the host's `requestHeader` reports (ADR-0071 tests). */
  setRoute(provider: string, model: string): void;
}

/**
 * A minimal fake dsh Session: an append-only log with surface markers, a surface
 * node list, `eventAt`, `seq`, and frozen payloads — the host behaviour the
 * mount is written against.
 */
function fakeSession(id = 'session-plugin-1', cwd?: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  let route: { readonly provider: string; readonly model: string } | undefined;
  const listeners = new Set<(session: FakeSession, event: DshMountEvent) => void>();
  const session = {
    id,
    // The host's own creation metadata. dsh validates `cwd` absolute, and the
    // recall source lane reads it as this mount's workspace root (ISSUE-053).
    ...(cwd === undefined ? {} : { header: { cwd } }),
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    requestHeader: () => route === undefined ? undefined : { config: route },
    setRoute(provider: string, model: string) { route = { provider, model }; },
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
        type,
        seq,
        data: Object.freeze(structuredClone(data)),
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

/** Append one scripted step of the shape a real dsh run produces. */
function step(session: FakeSession, params: {
  turn: number;
  step: number;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  result?: { content: unknown[]; meta?: unknown; isError?: boolean };
  /**
   * The step's token accounting, exactly where dsh attaches it: on the
   * `assistant/message` event (G8). Absent means the adapter reported none,
   * which is a fact the mount must journal rather than a zero.
   */
  usage?: Record<string, unknown> | null;
  /** The user message text; defaults to `task <turn>`. */
  userText?: string;
  endTurn?: boolean;
}): void {
  session.append('turn/start', { turn: params.turn });
  session.append('step/start', { turn: params.turn, step: params.step });
  session.append('system/message', { turn: params.turn, step: params.step,
    message: { role: 'system', content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' }, id: `sys-${String(params.turn)}-${String(params.step)}` } },
  { surfaceOp: 'append' });
  session.append('user/message', { content: [{ type: 'text',
    text: params.userText ?? `task ${String(params.turn)}` }],
    source: { kind: 'user' }, role: 'user', id: `user-${String(params.turn)}` }, { surfaceOp: 'append' });
  if (params.toolCall !== undefined) {
    const call = params.toolCall;
    const callSeq = session.append('tool/call', { turn: params.turn, step: params.step,
      callId: call.id, name: call.name, arguments: JSON.stringify(call.input) }).seq;
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: call.id, name: call.name,
          arguments: JSON.stringify(call.input) }], id: `asst-${call.id}` } },
    { surfaceOp: 'append' });
    if (params.result !== undefined) {
      const result = params.result;
      session.append('tool/result', { turn: params.turn, step: params.step,
        message: { role: 'tool', source: { kind: 'tool', callId: call.id },
          toolCallId: call.id, content: result.content, isError: result.isError === true,
          id: `result-${call.id}` },
        ...result.meta === undefined ? {} : { meta: result.meta } },
      { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    }
  }
  // A step with token accounting but no tool call still produced an
  // `assistant/message`: that event is the only place dsh carries usage.
  if (params.toolCall === undefined && params.usage !== undefined && params.usage !== null) {
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: `answer ${String(params.turn)}` }],
        id: `asst-${String(params.turn)}-${String(params.step)}` },
      usage: params.usage }, { surfaceOp: 'append' });
  }
  // A usage-less message is the other shape the mount must journal: a step
  // whose adapter reported no accounting still emitted its message.
  if (params.toolCall === undefined && params.usage === null) {
    session.append('assistant/message', { turn: params.turn, step: params.step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: `answer ${String(params.turn)}` }],
        id: `asst-${String(params.turn)}-${String(params.step)}` } },
    { surfaceOp: 'append' });
  }
  session.append('step/end', { turn: params.turn, step: params.step });
  if (params.endTurn === true) {
    session.append('turn/end', { turn: params.turn, reason: { kind: 'completed' } });
  }
}

function oversizedBody(bytes: number, line = 'x'.repeat(63)): string {
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) { lines.push(line); size += line.length + 1; }
  return lines.join('\n');
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-plugin-'));
}

function cleanup(dir: string, mount?: { sessions: Map<string, { ledger: { close(): Promise<void> } }> }): void {
  if (mount !== undefined) {
    for (const entry of mount.sessions.values()) void entry.ledger.close();
    mount.sessions.clear();
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

const journalLines: { kind: string; [field: string]: unknown }[] = [];
function journal(): { kind: string; [field: string]: unknown }[] { return journalLines; }

/** Open one mount with a route and read the floor it resolved. */
let floorSessionOrdinal = 0;
async function sessionFloor(config: Parameters<typeof resolvePluginConfig>[0],
  route: { provider: string; model: string } | undefined): Promise<number> {
  floorSessionOrdinal += 1;
  const session = fakeSession(`session-floor-${String(floorSessionOrdinal)}`);
  const journal: { kind: string; [field: string]: unknown }[] = [];
  const mount = createRacoonsMount({
    config: resolvePluginConfig(config), storage: resolveStorage(undefined),
    journal: (record) => { journal.push(record); },
    ...route === undefined ? {} : { judgeRoute: route },
  });
  try {
    const entry = await mount.sessionFor(session.id, session);
    // The per-session capabilities line must state the floor this session
    // resolved, so a recorded run proves which floor it used (ISSUE-235 #7).
    const capabilities = journal.find((line) => line['kind'] === 'capabilities');
    assert.ok(capabilities !== undefined, 'the mount journals its capabilities line');
    assert.equal(typeof capabilities['floorBytes'], 'number',
      'the capabilities line states floorBytes');
    assert.equal(capabilities['floorBytes'], entry.floorBytes,
      'the stated floor is the floor the session resolved');
    return entry.floorBytes;
  } finally {
    await mount.close();
  }
}

// --- usage reconciliation (G8, ISSUE-045 D1) --------------------------------

/** The two host rows the rig recorded on a real run, in dsh's own field names. */
const LIVE_ROW = { inputTokens: 605, outputTokens: 165, totalTokens: 8194, cacheReadTokens: 7424 };

/**
 * Wire the plugin's own `session/event` and `agent/pre-step` listeners to a
 * fake session, the way `apply` wires them to dsh. Returns the pre-step caller
 * and the disposers the plugin registered.
 */
async function mountedWithListener(options: {
  readonly session: FakeSession;
  readonly plugin: ReturnType<typeof createRacoonsPlugin>;
  readonly listeners: Map<string, (...args: never[]) => unknown>;
  readonly llm?: DshLlmService;
}): Promise<{
  preStep(payload: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}> {
  const cleanups: (() => unknown)[] = [];
  await options.plugin.apply({
    logger: { warn: () => {} },
    on: (event, listener) => {
      options.listeners.set(event, listener);
      return () => options.listeners.delete(event);
    },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  } as DshMountContext, {});
  options.session.on((session, event) => {
    const listener = options.listeners.get('session/event');
    if (listener !== undefined) {
      (listener as (session: FakeSession, event: DshMountEvent) => void)(session, event);
    }
  });
  const preStep = options.listeners.get('agent/pre-step') as
    (payload: unknown, next: () => unknown) => Promise<unknown>;
  return {
    preStep: payload => preStep(payload, async () => ({ kind: 'enter', messages: [] })),
    dispose: async () => { for (const fn of cleanups) await fn(); },
  };
}

/** A model seam that answers only `resolveModelInfo`; an ask would throw. */
function windowLlm(answer: (provider: string, model: string) => number | Error): {
  readonly llm: DshLlmService;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const llm = {
    async resolveModelInfo(provider: string, model: string) {
      calls.push(`${provider}/${model}`);
      const value = answer(provider, model);
      if (value instanceof Error) throw value;
      return { context: { contextWindow: value } };
    },
    async *stream() { throw new Error('no ask expected in a window test'); },
  } as unknown as DshLlmService;
  return { llm, calls };
}

/** One pre-step payload the plugin's own listener accepts. */
function boundary(session: FakeSession, turn: number): Record<string, unknown> {
  return { agent: { session }, messages: [], turn, step: 1,
    signal: new AbortController().signal };
}

test('the plugin declares its name and seams, and resolvePluginConfig fills and refuses knobs',
  async () => {
  // The declared shape first: the factory's own value and the module constants.
  const plugin = createRacoonsPlugin();
  const at: Label = what => `row: the factory: ${what}`;
  assert.equal(plugin.name, 'cremator', at('the plugin names itself cremator'));
  assert.deepEqual(plugin.inject, ['llm', 'sessions', 'commands'],
    at('the three seams are injected'));
  assert.equal(typeof plugin.apply, 'function', at('apply is a function'));
  const atConst: Label = what => `row: the module constant: ${what}`;
  assert.equal(CREMATOR_PLUGIN_NAME, 'cremator',
    atConst('the exported name matches the factory'));
  assert.deepEqual(CREMATOR_PLUGIN_INJECT, ['llm', 'sessions', 'commands'],
    atConst('the exported inject list matches the factory'));
  const config = resolvePluginConfig(undefined);
  assert.equal(config.barBytes, 512); // owner ruling 2026-11-08, ADR-0051
  // ADR-0008: absent means apply; record-only is the explicit opt-out.
  assert.equal(config.enforcement, 'apply');
  assert.equal(resolvePluginConfig({ enforcement: 'record-only' }).enforcement, 'record-only');
  assert.equal(resolvePluginConfig({ enforcement: 'apply' }).enforcement, 'apply');
  assert.equal(config.recordName, 'racoons/negation');
  // The judge's two knobs: the shipped tagless arm, and the bounded stream.
  assert.equal(config.anchors, 'off');
  assert.equal(config.judgeTimeoutMs, 120_000);
  assert.equal(resolvePluginConfig({ anchors: 'on' }).anchors, 'on');
  assert.equal(resolvePluginConfig({ judgeTimeoutMs: 0 }).judgeTimeoutMs, 0);
  // ISSUE-022 chunk 6: no window configured means the auto prune is off, which
  // is the record-only rollout's first stage (ADR-0008, ADR-0009 §Amendment).
  assert.equal(config.contextWindowTokens, null);
  assert.equal(resolvePluginConfig({ contextWindowTokens: 200_000 }).contextWindowTokens, 200_000);
  assert.equal(resolvePluginConfig({ contextWindowTokens: null }).contextWindowTokens, null);
  assert.throws(() => resolvePluginConfig({ contextWindowTokens: 0 }), /contextWindowTokens/u);
  assert.throws(() => resolvePluginConfig({ contextWindowTokens: -1 }), /contextWindowTokens/u);
  // ADR-0050 decision 2: the absolute bar. Absent is null, so the deprecated
  // window half decides; an explicit value wins and is validated by name.
  assert.equal(config.pruneThresholdTokens, null);
  // ADR-0050: the bar is absolute but the apply leg still plans against the
  // host window, so a bar without a window is refused; both together resolve.
  assert.throws(() => resolvePluginConfig({ pruneThresholdTokens: 60_000 }),
    /requires contextWindowTokens/u);
  // ADR-0071: the host's model-info seam is the other legal window source.
  assert.equal(resolvePluginConfig({ pruneThresholdTokens: 60_000 },
    { hostModelInfo: true }).pruneThresholdTokens, 60_000);
  assert.equal(resolvePluginConfig({
    contextWindowTokens: 400_000, pruneThresholdTokens: 60_000,
  }).pruneThresholdTokens, 60_000);
  for (const value of [0, -1, 1.5]) {
    assert.throws(() => resolvePluginConfig({
      contextWindowTokens: 400_000, pruneThresholdTokens: value,
    }), /pruneThresholdTokens/u, String(value));
  }
  // The native-compaction backstop (ISSUE-022 DoD; CRITIC-022 P1-1): ON per the
  // owner ruling 2026-10-24, and only a boolean is a value.
  assert.equal(config.nativeCompactionBackstop, true);
  assert.equal(resolvePluginConfig({ nativeCompactionBackstop: false }).nativeCompactionBackstop,
    false);
  assert.equal(resolvePluginConfig({ nativeCompactionBackstop: true }).nativeCompactionBackstop, true);
  assert.throws(() => resolvePluginConfig({ nativeCompactionBackstop: 'yes' as unknown as boolean }),
    /nativeCompactionBackstop/u);
  assert.throws(() => resolvePluginConfig({ anchors: 'both' as 'on' }), /anchors/u);
  assert.throws(() => resolvePluginConfig({ judgeTimeoutMs: -1 }), /judgeTimeoutMs/u);
  assert.throws(() => resolvePluginConfig({ sealMaxLatencyTurns: 2 as 0 }), /sealMaxLatencyTurns/u);
  assert.throws(() => resolvePluginConfig({ barBytes: 0 }), /barBytes/u);
  // ISSUE-128; ADR-0050 decision 4: the entry-ask trigger. Absent is `off` —
  // the product configuration — and an explicit `count` is the compatibility
  // path that keeps the retired per-result cadence.
  assert.deepEqual(config.entryAskTrigger, { mode: 'off' });
  assert.deepEqual(resolvePluginConfig({
    entryAskTrigger: { mode: 'landed-bytes', bytes: 240_000 } }).entryAskTrigger,
  { mode: 'landed-bytes', bytes: 240_000 });
  assert.deepEqual(resolvePluginConfig({ entryAskTrigger: { mode: 'count' } }).entryAskTrigger,
    { mode: 'count' });
  assert.deepEqual(resolvePluginConfig({ entryAskTrigger: { mode: 'count', bytes: 5 } })
    .entryAskTrigger, { mode: 'count', bytes: 5 });
  // ADR-0050 decision 4: `off` needs no number and is the absent default.
  assert.deepEqual(resolvePluginConfig({ entryAskTrigger: { mode: 'off' } }).entryAskTrigger,
    { mode: 'off' });
  assert.throws(() => resolvePluginConfig({ entryAskTrigger: { mode: 'landed-bytes' } }),
    /entryAskTrigger\.bytes/u);
  assert.throws(() => resolvePluginConfig({ entryAskTrigger: { mode: 'landed-bytes', bytes: 0 } }),
    /entryAskTrigger\.bytes/u);
  assert.throws(() => resolvePluginConfig({ entryAskTrigger: { mode: 'bytes' } as never }),
    /entryAskTrigger\.mode/u);
  assert.throws(() => resolvePluginConfig({ entryAskTrigger: 1 as never }),
    /entryAskTrigger must be an object/u);
  // ISSUE-129/183/221: the grammar. Absent is the shipped `jsonl-20` (owner
  // ruling 2026-11-05); every other id core accepts stays selectable by name.
  assert.equal(config.entryAskGrammar, 'jsonl-20');
  assert.equal(resolvePluginConfig({ entryAskGrammar: 'two-option' }).entryAskGrammar,
    'two-option');
  // ISSUE-183: the third grammar the live run selects.
  assert.equal(resolvePluginConfig({ entryAskGrammar: 'jsonl-20' }).entryAskGrammar,
    'jsonl-20');
  // ISSUE-221: core accepts the `nokeepall` variant; the mount must not refuse
  // a config core can read.
  assert.equal(resolvePluginConfig({ entryAskGrammar: 'jsonl-20-nokeepall' })
    .entryAskGrammar, 'jsonl-20-nokeepall');
  assert.throws(() => resolvePluginConfig({ entryAskGrammar: '2option' as never }),
    /entryAskGrammar/u);
  assert.throws(() => resolvePluginConfig({ entryAskGrammar: 'jsonl20' as never }),
    /entryAskGrammar/u);
  // ISSUE-221; ADR-0056: the bulk prune grammar. Absent is `nokeepall`, the
  // shipped default; `3option`, the original contract byte for byte, stays
  // selectable by name, and a typo is refused by name rather than silently
  // defaulted.
  assert.equal(config.pruneAskGrammar, 'nokeepall');
  assert.equal(resolvePluginConfig({ pruneAskGrammar: 'nokeepall' }).pruneAskGrammar,
    'nokeepall');
  assert.equal(resolvePluginConfig({ pruneAskGrammar: '3option' }).pruneAskGrammar,
    '3option');
  assert.throws(() => resolvePluginConfig({ pruneAskGrammar: 'jsonl-20' as never }),
    /pruneAskGrammar/u);
  assert.throws(() => resolvePluginConfig({ pruneAskGrammar: '2option' as never }),
    /pruneAskGrammar/u);
  // ADR-0028: the three protocol keys the judge pass and its turn gate tuned
  // are accepted and ignored for one chunk (core deletes the fields next). An
  // old config row still mounts; no value of theirs is validated or wired.
  assert.doesNotThrow(() => resolvePluginConfig({
    revisitShare: 0, advertisedLabelLimit: -1, retryLimit: 1.5 } as never));
  assert.throws(() => resolvePluginConfig({ enforcement: 'force' as 'apply' }), /enforcement/u);
  assert.throws(() => resolvePluginConfig({ recordName: ' ' }), /recordName/u);
  // ADR-0014 (2026-10-23): the entry-time cap is scrapped, so its two keys are
  // accepted and ignored — an old config file must never crash a mount. Their
  // values never reach the engine: the thresholds carry the core defaults.
  assert.doesNotThrow(() => resolvePluginConfig({ capBytes: -1, capHeadBytes: 1.5 }));
  const engine = engineConfig(resolvePluginConfig({ capBytes: 1024, capHeadBytes: 512,
    sealMaxLatencyTurns: 0, episodeNoNewPathSteps: 3, enforcement: 'apply' }));
  assert.equal(engine.thresholds.capBytes, 8192, 'the cap key is not wired');
  assert.equal(engine.thresholds.capHeadBytes, null, 'the cap key is not wired');
  assert.equal(engine.thresholds.episodeNoNewPathSteps, 3);
  assert.equal(engine.sealMode, 'append');
  assert.equal(engine.protocol.enforcement, 'apply');
  // ADR-0037 / ISSUE-145 / ISSUE-151: both dedupe classes sit beside
  // `entryAskBatchSize`, ship OFF, and map onto core's own config keys.
  assert.equal(config.dedupeSupersededByReread, false, 'class 2 ships off');
  assert.equal(config.dedupeCallEcho, false, 'class 1 ships off');
  assert.equal(resolvePluginConfig({ dedupeSupersededByReread: true }).dedupeSupersededByReread, true);
  assert.equal(resolvePluginConfig({ dedupeCallEcho: true }).dedupeCallEcho, true);
  assert.throws(() => resolvePluginConfig({ dedupeSupersededByReread: 'true' as unknown as boolean }),
    /dedupeSupersededByReread/u);
  assert.throws(() => resolvePluginConfig({ dedupeCallEcho: 'true' as unknown as boolean }),
    /dedupeCallEcho/u);
  assert.equal(config.entryAskBatchSize, 1, 'the dedupe knobs did not disturb the batch knob');
  assert.deepEqual(engine.protocol.dedupe,
    { classes: { supersededByReread: false, callEcho: false } });
  assert.deepEqual(engineConfig(resolvePluginConfig({ dedupeSupersededByReread: true }))
    .protocol.dedupe, { classes: { supersededByReread: true, callEcho: false } });
  assert.deepEqual(engineConfig(resolvePluginConfig({ dedupeCallEcho: true }))
    .protocol.dedupe, { classes: { supersededByReread: false, callEcho: true } });
  // ISSUE-128/129/183: both live-run knobs ride the engine config when a row
  // names them, and a mount with no row carries the shipped grammar default.
  // The default trigger is `off`, which never reaches core; only an explicit
  // count or landed-bytes cadence does.
  assert.equal(engine.entryAskTrigger, undefined, 'the default off never reaches core config');
  assert.equal(engine.entryAskGrammar, 'jsonl-20', 'no row names the shipped grammar');
  const liveEngine = engineConfig(resolvePluginConfig({
    entryAskTrigger: { mode: 'landed-bytes', bytes: 240_000 }, entryAskGrammar: 'two-option' }));
  assert.deepEqual(liveEngine.entryAskTrigger, { mode: 'landed-bytes', bytes: 240_000 });
  assert.equal(liveEngine.entryAskGrammar, 'two-option');
  // The explicit count compatibility path reaches core, which knows that mode.
  assert.deepEqual(engineConfig(resolvePluginConfig({ entryAskTrigger: { mode: 'count' } }))
    .entryAskTrigger, { mode: 'count' });
  // ISSUE-221: the `jsonl-20-nokeepall` entry grammar rides the engine config
  // unchanged once the mount accepts it.
  assert.equal(engineConfig(resolvePluginConfig({ entryAskGrammar: 'jsonl-20-nokeepall' }))
    .entryAskGrammar, 'jsonl-20-nokeepall');
  // ISSUE-221; ADR-0056: the bulk grammar rides the engine config too; no row
  // is `nokeepall`, the shipped default, and an explicit `3option` still selects
  // the original contract.
  assert.equal(engine.pruneAskGrammar, 'nokeepall', 'no row names the shipped bulk grammar');
  assert.equal(engineConfig(resolvePluginConfig({ pruneAskGrammar: '3option' }))
    .pruneAskGrammar, '3option');
  // ADR-0050 decision 4: `off` is a mount switch, never an engine cadence; core's
  // validator knows only `count` and `landed-bytes`, so it must not be carried.
  assert.equal(engineConfig(resolvePluginConfig({ entryAskTrigger: { mode: 'off' } }))
    .entryAskTrigger, undefined, 'off never reaches core config');

  // ADR-0020 Decision 3 / ISSUE-058 item 2: `floorBytes` is a top-level sizing
  // dial, never `barBytes`'s job. Absent is null — "the table decides" — and
  // the table needs the model id, which only the mount's route has.
  const atFloor: Label = what => `row: floorBytes: ${what}`;
    // ADR-0020 Decision 3 / ISSUE-058 item 2: `floorBytes` is a top-level sizing
    // dial, never `barBytes`'s job. Absent is null — "the table decides" — and
    // the table needs the model id, which only the mount's route has.
    assert.equal(resolvePluginConfig(undefined).floorBytes, null,
      atFloor('absent means the table decides'));
    assert.equal(resolvePluginConfig({}).floorBytes, null,
      atFloor('an empty row means the table decides'));
    // The same refusal shape as barBytes: a positive safe integer or nothing.
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => resolvePluginConfig({ floorBytes: value }),
        /floorBytes must be a positive safe integer/u, atFloor(String(value)));
    }
    assert.throws(() => resolvePluginConfig({ floorBytes: '512' as unknown as number }),
      /floorBytes/u, atFloor('a string is refused'));
    for (const value of [1, 256, 512, 1280, 8192]) {
      assert.equal(resolvePluginConfig({ floorBytes: value }).floorBytes, value,
        atFloor(String(value)));
    }
    // The engine config always carries one number, so no reader sees undefined.
    assert.equal(engineConfig(resolvePluginConfig({})).floorBytes, 512,
      atFloor('no knob, the 512 default'));
    assert.equal(engineConfig(resolvePluginConfig({}), 1280).floorBytes, 1280,
      atFloor('the table value is passed through'));
    assert.equal(engineConfig(resolvePluginConfig({ floorBytes: 256 })).floorBytes, 256,
      atFloor('the explicit knob wins'));
    // The resolved per-session value: an explicit knob beats the table, the table
    // beats nothing, and a mount with no route gets the 512 default.
    assert.equal(await sessionFloor({ floorBytes: 256 }, { provider: 'p', model: 'deepseek-v4.1-flash-1017' }),
      256, atFloor('the flat knob wins over the table'));
    assert.equal(await sessionFloor({}, { provider: 'p', model: 'deepseek-v4.1-flash-1017' }), 1280,
      atFloor('the flash model takes its table entry'));
    assert.equal(await sessionFloor({}, { provider: 'p', model: 'deepseek-v4-pro' }), 768,
      atFloor('the pro model takes its table entry'));
    assert.equal(await sessionFloor({}, { provider: 'p', model: 'gpt-6-astra' }), 256,
      atFloor('the astra model takes its table entry'));
    assert.equal(await sessionFloor({}, { provider: 'p', model: 'unlisted-model' }), 512,
      atFloor('an unknown model takes the default'));
    assert.equal(await sessionFloor({}, undefined), 512,
      atFloor('no route, no model, the default'));
    // The engine the session opened reads the same resolved number, never the flat
    // knob alone: the mount and the engine cannot disagree about the floor.
    assert.equal(await sessionFloor({ floorBytes: 1024 }, undefined), 1024,
      atFloor('the engine reads the same resolved number'));
});

/**
 * What one mount does with a landed tool result: S7 refuses to queue a failed
 * one, and a closed episode of zero-match searches publishes exactly one
 * appended negative fact. Two rules, one harness, so they share a table; each
 * row scripts its own steps and names every assertion.
 */
const PUBLISH_ROWS: readonly {
  readonly name: string;
  readonly id: string;
  run(context: {
    readonly session: FakeSession;
    readonly mount: ReturnType<typeof createRacoonsMount>;
    readonly journal: { kind: string; [field: string]: unknown }[];
    readonly at: Label;
  }): Promise<void>;
}[] = [
  {
    name: 'S7 failed result',
    id: 'session-failed',
    async run({ session, mount, journal, at }) {
      const seen: unknown[] = [];
      session.on((s, event) => { seen.push(mount.observe(s, event)); });      step(session, { turn: 1, step: 1,
        toolCall: { id: 'p1', name: 'pwsh', input: { command: '1..600 | % { $_ }' } },
        result: { content: [{ type: 'text', text: oversizedBody(40 * 1024) }], isError: true } });
      // The passive listener saw the result but the mount refused to queue it.
      assert.equal(seen.filter((value) => value !== null).length, 0,
        at('a failed result is observed but never queued'));
      const journalSkip = journal.find((line) => line['reason'] === 'failed-result');
      assert.ok(journalSkip !== undefined, at('the skipped failure is journaled by reason'));
      const before = session.log.length;
      const stepResult = await mount.runStep(session, { turn: 1, step: 2 });
      assert.equal(stepResult.deliveries.length, 0, at('nothing was delivered'));
      assert.equal(stepResult.appendRequest, null, at('no append was requested'));
      assert.equal(session.log.length, before, at('nothing was appended for the failed result'));
      assert.equal(journal.some((line) => line['kind'] === 'publish'), false,
        at('no publish line was written'));
    },
  },
  {
    name: 'sealed episode',
    id: 'session-seal',
    async run({ session, mount, journal, at }) {
      // The mount observes every host event, as the passive listener does.
      session.on((s, event) => { mount.observe(s, event); });
      const missMeta = { shape: 'matches', files: [], truncated: false, total: 0 };
      step(session, { turn: 1, step: 1,
        toolCall: { id: 'g1', name: 'grep', input: { pattern: 'NEEDLE', path: 'a.txt' } },
        result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta } });
      step(session, { turn: 1, step: 2,
        toolCall: { id: 'g2', name: 'grep', input: { pattern: 'NEEDLE', path: 'b.txt' } },
        result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta },
        endTurn: true });
      step(session, { turn: 2, step: 1 });
      const stepResult = await mount.runStep(session, { turn: 2, step: 1 });
      assert.equal(stepResult.deliveries.length, 2, at('both grep results were delivered'));
      assert.equal(stepResult.atRest?.status, 'applied', at('the at-rest pass applied'));
      const request = stepResult.appendRequest;
      assert.ok(request !== null, at('the pass requested one publication'));
      assert.equal(request.application.mode, 'append', at('the publication is an append'));
      assert.equal(request.application.appendRecords.length, 1,
        at('one negative fact for the whole episode'));
      assert.equal(request.application.sealedEpisodeIds.length, 1,
        at('the episode is sealed once'));
      const text = new TextDecoder().decode(
        request.application.appendRecords[0]?.bytes ?? new Uint8Array());
      assert.match(text, /^\[search: NEEDLE\] not found in: /u,
        at('the fact states the pattern and the paths'));
      assert.equal(journal.some((line) => line['kind'] === 'publish'), true,
        at('the publication is journaled'));
      const config = resolvePluginConfig({});
      const appended = publishAppend(session, request, config);
      assert.equal(appended.length, 1, at('exactly one host append landed'));
      assert.equal(appended[0]?.surfaceOp, 'append', at('the fact was appended'));
      const again = await mount.runStep(session, { turn: 2, step: 2 });
      assert.equal(again.appendRequest, null, at('a sealed episode is never published twice'));
    },
  },
];

// ADR-0071 / ADR-0072: the routed model's window, its cache, and the switch.

test('ADR-0071: the routed model window arms the latch when none is configured', async () => {
  const session = fakeSession('s-window-resolve');
  session.setRoute('p', 'm');
  const { llm, calls } = windowLlm(() => 200_000);
  const records: { kind: string; [field: string]: unknown }[] = [];
  const plugin = createRacoonsPlugin({
    config: { pruneThresholdTokens: 60_000 },
    journal: record => { records.push(record as unknown as { kind: string; [field: string]: unknown }); },
  });
  const mounted = await mountedWithListener({
    session, plugin, listeners: new Map(), llm,
  });
  try {
    await mounted.preStep(boundary(session, 1));
    const resolved = records.filter(line => line.kind === 'window-resolved');
    assert.equal(resolved.length, 1, 'one line names the resolved window');
    assert.equal(resolved[0]?.['window'], 200_000);
    assert.equal(resolved[0]?.['source'], 'host-model-info');
    const threshold = records.filter(line => line.kind === 'prune-threshold');
    assert.equal(threshold.at(-1)?.['window'], 200_000,
      'the bar line names the window in force');
    assert.equal(threshold.at(-1)?.['windowSource'], 'host-model-info');

    // The same route is not looked up again at the next boundary.
    await mounted.preStep(boundary(session, 2));
    assert.equal(calls.length, 1, 'one exact-route lookup');
    assert.equal(records.some(line => line.kind === 'model-switch'), false,
      'an unchanged route is not a switch');
  } finally {
    await mounted.dispose();
  }
});

test('ADR-0071: a configured window is authoritative and the host seam is never called',
  async () => {
    const session = fakeSession('s-window-config');
    session.setRoute('p', 'm');
    const { llm, calls } = windowLlm(() => 1);
    const records: { kind: string; [field: string]: unknown }[] = [];
    const plugin = createRacoonsPlugin({
      config: { contextWindowTokens: 400_000, pruneThresholdTokens: 60_000 },
      journal: record => { records.push(record as unknown as { kind: string; [field: string]: unknown }); },
    });
    const mounted = await mountedWithListener({
      session, plugin, listeners: new Map(), llm,
    });
    try {
      await mounted.preStep(boundary(session, 1));
      assert.equal(calls.length, 0, 'the host is not consulted');
      assert.equal(records.some(line => line.kind === 'window-resolved'), false,
        'no resolution line for a configured window');
      const threshold = records.filter(line => line.kind === 'prune-threshold');
      assert.equal(threshold.at(-1)?.['window'], 400_000);
      assert.equal(threshold.at(-1)?.['windowSource'], 'config');
    } finally {
      await mounted.dispose();
    }
  });

test('ADR-0071: an unresolved window writes one line per route and leaves the latch off',
  async () => {
    const session = fakeSession('s-window-unresolved');
    session.setRoute('p', 'm');
    const { llm } = windowLlm(() => new Error('no capacity'));
    const records: { kind: string; [field: string]: unknown }[] = [];
    const plugin = createRacoonsPlugin({
      config: { pruneThresholdTokens: 60_000 },
      journal: record => { records.push(record as unknown as { kind: string; [field: string]: unknown }); },
    });
    const mounted = await mountedWithListener({
      session, plugin, listeners: new Map(), llm,
    });
    try {
      await mounted.preStep(boundary(session, 1));
      await mounted.preStep(boundary(session, 2));
      const unresolved = records.filter(line => line.kind === 'window-unresolved');
      assert.equal(unresolved.length, 1, 'one line for the route, not one per boundary');
      assert.equal(unresolved[0]?.['reason'], 'model-info-failed');
      assert.equal(records.filter(line => line.kind === 'prune-threshold').length, 0,
        'no automatic observation runs without a window');
    } finally {
      await mounted.dispose();
    }
  });

test('ADR-0072: a route change re-arms and journals model-switch without a pass', async () => {
  const session = fakeSession('s-window-switch');
  session.setRoute('p', 'm1');
  const { llm, calls } = windowLlm((_provider, model) =>
    model === 'm1' ? 200_000 : 100_000);
  const records: { kind: string; [field: string]: unknown }[] = [];
  const plugin = createRacoonsPlugin({
    config: { pruneThresholdTokens: 60_000 },
    journal: record => { records.push(record as unknown as { kind: string; [field: string]: unknown }); },
  });
  const mounted = await mountedWithListener({
    session, plugin, listeners: new Map(), llm,
  });
  try {
    await mounted.preStep(boundary(session, 1));
    session.setRoute('p', 'm2');
    await mounted.preStep(boundary(session, 2));

    const switched = records.filter(line => line.kind === 'model-switch');
    assert.equal(switched.length, 1, 'one line for the changed route');
    assert.deepEqual(switched[0]?.['from'],
      { provider: 'p', model: 'm1', window: 200_000 });
    assert.deepEqual(switched[0]?.['to'],
      { provider: 'p', model: 'm2', window: 100_000 });
    assert.equal(switched[0]?.['windowSource'], 'host-model-info');
    assert.equal(records.filter(line => line.kind === 'window-resolved').length, 2,
      'each route resolves once');
    const threshold = records.filter(line => line.kind === 'prune-threshold');
    assert.equal(threshold.at(-1)?.['window'], 100_000,
      'the bar reads the destination window');
    assert.equal(threshold.at(-1)?.['crossed'], false,
      'the switch itself fires no pass');
    assert.equal(calls.length, 2, 'one lookup per route');
  } finally {
    await mounted.dispose();
  }
});

test('ADR-0072: a route change re-arms even when the window is configured', async () => {
  const session = fakeSession('s-window-config-switch');
  session.setRoute('p', 'm1');
  const { llm, calls } = windowLlm(() => 1);
  const records: { kind: string; [field: string]: unknown }[] = [];
  const plugin = createRacoonsPlugin({
    config: { contextWindowTokens: 400_000, pruneThresholdTokens: 60_000 },
    journal: record => { records.push(record as unknown as { kind: string; [field: string]: unknown }); },
  });
  const mounted = await mountedWithListener({
    session, plugin, listeners: new Map(), llm,
  });
  try {
    await mounted.preStep(boundary(session, 1));
    session.setRoute('p', 'm2');
    await mounted.preStep(boundary(session, 2));

    const switched = records.filter(line => line.kind === 'model-switch');
    assert.equal(switched.length, 1, 'the route change is named');
    assert.deepEqual(switched[0]?.['from'],
      { provider: 'p', model: 'm1', window: 400_000 });
    assert.deepEqual(switched[0]?.['to'],
      { provider: 'p', model: 'm2', window: 400_000 });
    assert.equal(switched[0]?.['windowSource'], 'config');
    assert.equal(calls.length, 0, 'the configured window never asks the host');
    assert.equal(records.some(line => line.kind === 'window-resolved'), false);
    const threshold = records.filter(line => line.kind === 'prune-threshold');
    assert.equal(threshold.at(-1)?.['windowSource'], 'config');
    assert.equal(threshold.at(-1)?.['crossed'], false,
      'the switch itself fires no pass');
  } finally {
    await mounted.dispose();
  }
});

test('a failed result is never queued, and a sealed episode publishes one fact', async () => {
  await runRows(PUBLISH_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const dir = scratch();
      journalLines.length = 0;
      let mount: ReturnType<typeof createRacoonsMount> | undefined;
      try {
        const session = fakeSession(scenario.id);
        mount = createRacoonsMount({ config: resolvePluginConfig({}),
          storage: resolveStorage(undefined),
          journal: (record) => journalLines.push(record) });
        await scenario.run({ session, mount, journal: journalLines, at });
      } finally {
        await mount?.close();
        cleanup(dir);
      }
    },
  })));
});

test('a publishAppend that throws mid-list recovers its records on the next pass (ISSUE-342)', async () => {
  // Two sealed episodes produce two negative-fact records in one append. The
  // host append throws on the SECOND record: the first lands, the second does
  // not, and the application is already claimed applied. The next boundary must
  // recover the missing record — never silently drop it while the ledger claims
  // applied.
  const dir = scratch();
  journalLines.length = 0;
  let mount: ReturnType<typeof createRacoonsMount> | undefined;
  try {
    const session = fakeSession('session-append-342');
    const created = createRacoonsMount({ config: resolvePluginConfig({}),
      storage: resolveStorage(undefined), journal: (record) => journalLines.push(record) });
    mount = created;
    session.on((s, event) => { created.observe(s, event); });
    const missMeta = { shape: 'matches', files: [], truncated: false, total: 0 };
    step(session, { turn: 1, step: 1,
      toolCall: { id: 'g1', name: 'grep', input: { pattern: 'NEEDLE1', path: 'a.txt' } },
      result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta } });
    step(session, { turn: 1, step: 2,
      toolCall: { id: 'g2', name: 'grep', input: { pattern: 'NEEDLE2', path: 'b.txt' } },
      result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta }, endTurn: true });
    step(session, { turn: 2, step: 1 });
    const stepResult = await created.runStep(session, { turn: 2, step: 1 });
    assert.equal(stepResult.atRest?.status, 'applied', 'the at-rest pass applied the seal');
    const request = stepResult.appendRequest;
    assert.ok(request !== null, 'the pass requested one publication');
    assert.equal(request.application.appendRecords.length, 2, 'two negative facts, one per episode');
    const factCount = (): number => {
      let count = 0;
      for (const seq of session.surface?.nodes ?? []) {
        const event = session.eventAt?.(seq);
        if (event?.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind === 'racoons/negation') count += 1;
      }
      return count;
    };
    // Force the host append to throw on the second record only.
    const realAppend = session.append;
    let recordAppends = 0;
    let armed = true;
    session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      const source = (data as { source?: { kind?: string } }).source;
      if (type === 'user/message' && source?.kind === 'racoons/negation') {
        recordAppends += 1;
        if (armed && recordAppends === 2) { armed = false; throw new Error('host append failed mid-list'); }
      }
      return realAppend(type, data, options);
    };
    assert.throws(() => publishAppend(session, request, resolvePluginConfig({})),
      /host append failed mid-list/u);
    session.append = realAppend;
    assert.equal(factCount(), 1, 'only the first record landed before the throw');
    // The next boundary recovers the record the host never received.
    await created.runStep(session, { turn: 2, step: 2 });
    assert.equal(factCount(), 2,
      'the next pass recovers the missing record; the applied claim is backed by the surface');
  } finally {
    await mount?.close();
    cleanup(dir);
  }
});

test('a committed append survives death before the flush and replays exactly once (ISSUE-374)', async () => {
  // The ISSUE-342 residual gap: the seal commits (ledger claims applied, the
  // queue holds the records) but the process DIES before any boundary flushes
  // the queue to the host. The in-memory queue is lost with the mount; only a
  // durable pending-append record can carry the intent across the restart. A
  // fresh mount over the same durable root and the same host surface must
  // replay the unflushed records at its first boundary — exactly once.
  const root = scratch();
  journalLines.length = 0;
  let mount: ReturnType<typeof createRacoonsMount> | undefined;
  try {
    const session = fakeSession('session-append-374');
    const created = createRacoonsMount({ config: resolvePluginConfig({}),
      storage: resolveStorage({ root }), journal: (record) => journalLines.push(record) });
    mount = created;
    session.on((s, event) => { created.observe(s, event); });
    const missMeta = { shape: 'matches', files: [], truncated: false, total: 0 };
    step(session, { turn: 1, step: 1,
      toolCall: { id: 'g1', name: 'grep', input: { pattern: 'NEEDLE1', path: 'a.txt' } },
      result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta } });
    step(session, { turn: 1, step: 2,
      toolCall: { id: 'g2', name: 'grep', input: { pattern: 'NEEDLE2', path: 'b.txt' } },
      result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta }, endTurn: true });
    step(session, { turn: 2, step: 1 });
    const stepResult = await created.runStep(session, { turn: 2, step: 1 });
    assert.equal(stepResult.atRest?.status, 'applied', 'the at-rest pass applied the seal');
    const request = stepResult.appendRequest;
    assert.ok(request !== null, 'the pass requested one publication');
    assert.equal(request.application.appendRecords.length, 2, 'two negative facts, one per episode');
    const factCount = (): number => {
      let count = 0;
      for (const seq of session.surface?.nodes ?? []) {
        const event = session.eventAt?.(seq);
        if (event?.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind === 'racoons/negation') count += 1;
      }
      return count;
    };
    // The death: the append is committed but NEVER flushed — no publishAppend,
    // no boundary flush. A dead process never runs `close()` (and since
    // ISSUE-416 `close()` is a graceful shutdown that would flush), so this
    // mount is simply abandoned with its in-memory queue; the durable intent
    // written at commit is the only thing that survives.
    assert.equal(factCount(), 0, 'the host holds no record before the flush');
    // The resumed process: a fresh mount, the same durable root, the same surface.
    const journal2: { kind: string; [field: string]: unknown }[] = [];
    const resumed = createRacoonsMount({ config: resolvePluginConfig({}),
      storage: resolveStorage({ root }), journal: (record) => journal2.push(record) });
    try {
      await resumed.runStep(session, { turn: 2, step: 2 });
      assert.equal(factCount(), 2,
        'recovery replays the committed-but-unflushed append on remount');
      const recovered = journal2.find((line) => line['kind'] === 'entry-resume-recovered');
      assert.ok(recovered !== undefined, 'the replay rides the resume-recovery seam');
      assert.equal(recovered['appends'], 2, 'the recovery line counts the replayed records');
      // Exactly once: a later boundary must not duplicate what already landed.
      await resumed.runStep(session, { turn: 2, step: 3 });
      assert.equal(factCount(), 2, 'the replay is idempotent — no duplicate host append');
    } finally {
      await resumed.close();
    }
  } finally {
    await mount?.close();
    cleanup(root);
  }
});

test('ISSUE-350: ending or releasing a session evicts its capture and call facts', async () => {
  // Both per-session maps must track LIVE sessions only. A `session/end` surface
  // event and the mount's entry-release seam (`close`) each evict the ended
  // session's main-wire capture and its tool-call facts — lifecycle eviction,
  // never a size cap (ADR-0060).
  const dir = scratch();
  journalLines.length = 0;
  const mainWire = createMainWireCapture();
  let mount: ReturnType<typeof createRacoonsMount> | undefined;
  try {
    const created = createRacoonsMount({ config: resolvePluginConfig({}),
      storage: resolveStorage(undefined), journal: (record) => journalLines.push(record),
      mainWire });
    mount = created;
    // Read one session's call facts straight from the per-session calls map:
    // observe a result paired with the call; the item's tool name comes from the
    // stored facts (no surface fallback), so an evicted entry reads as ''.
    const factsFor = (session: FakeSession, callId: string): string => {
      const item = created.observe(session, { type: 'tool/result', seq: session.log.length,
        surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool',
          source: { kind: 'tool', callId }, toolCallId: callId,
          content: [{ type: 'text', text: 'bytes' }], id: `result-${callId}` } } });
      return item?.toolName ?? '';
    };
    const open = async (id: string): Promise<FakeSession> => {
      const session = fakeSession(id);
      session.on((s, event) => { created.observe(s, event); });
      await created.sessionFor(id, session);
      created.observeWire({ sessionId: id, messages: [
        { role: 'user', content: [{ type: 'text', text: `main ${id}` }] }] });
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read',
        arguments: '{"path":"a"}' });
      return session;
    };
    const live = await open('session-350-live');
    const endedA = await open('session-350-ended-a');
    const endedB = await open('session-350-ended-b');
    // Baseline: every open session holds a capture and its call facts.
    for (const session of [live, endedA, endedB]) {
      assert.ok(mainWire.last(session.id) !== null, `capture held for ${session.id}`);
      assert.equal(factsFor(session, 'c1'), 'read', `call facts held for ${session.id}`);
    }
    // Two sessions end; the third stays live. `close()` is now a graceful
    // shutdown that flushes and releases every session, so the test settles the
    // end explicitly (ISSUE-416) and reads the release path's eviction.
    endedA.append('session/end', {});
    endedB.append('session/end', {});
    await created.endSession(endedA);
    await created.endSession(endedB);
    assert.equal(mainWire.last(endedA.id), null, 'the ended session leaves no capture');
    assert.equal(mainWire.last(endedB.id), null, 'the second ended session leaves no capture');
    assert.ok(mainWire.last(live.id) !== null, 'the live session keeps its capture');
    assert.equal(factsFor(endedA, 'c1'), '', 'the ended session leaves no call facts');
    assert.equal(factsFor(endedB, 'c1'), '', 'the second ended session leaves no call facts');
    assert.equal(factsFor(live, 'c1'), 'read', 'the live session keeps its call facts');
    // Releasing the mount's entries evicts the remaining live session too.
    await created.close();
    mount = undefined;
    assert.equal(mainWire.last(live.id), null, 'a released entry leaves no capture');
    assert.equal(factsFor(live, 'c1'), '', 'a released entry leaves no call facts');
  } finally {
    await mount?.close();
    cleanup(dir);
  }
});

test('G8: a reconciled usage reading reaches telemetry and the meter', async () => {
  const dir = scratch();
  journalLines.length = 0;
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const plugin = createRacoonsPlugin({ journal: (record) => journalLines.push(record),
    storage: { databasePath: ':memory:' }, config: { barBytes: 64 } });
  try {
    const session = fakeSession('session-usage');
    const mounted = await mountedWithListener({ session, plugin, listeners });
    // One boundary, so the mount has a measured request to reconcile against.
    step(session, { turn: 1, step: 1 });
    await mounted.preStep({ agent: { session }, messages: [], turn: 1, step: 1, signal: {} });
    assert.equal(journalLines.filter((line) => line['kind'] === 'usage-reconciled').length, 0,
      'no row yet: nothing to reconcile');
    // The host then reports that request's accounting on its own
    // `assistant/message`, in dsh's disjoint field names.
    step(session, { turn: 1, step: 2, usage: LIVE_ROW });
    const reconciled = journalLines.filter((line) => line['kind'] === 'usage-reconciled');
    assert.equal(reconciled.length, 1, 'one host row, one reconciled reading');
    assert.equal(reconciled[0]?.['inputTokens'], 605 + 7424, 'cached input is inside the prompt');
    assert.equal(reconciled[0]?.['outputTokens'], 165);
    assert.equal(reconciled[0]?.['cachedInputTokens'], 7424, 'the cache share stays readable');
    const estimated = Number(reconciled[0]?.['estimatedInputTokens']);
    assert.ok(Number.isSafeInteger(estimated) && estimated > 0,
      'the reading names the estimate it was measured against');
    // The reading reaches telemetry, not only the journal: the engine emits
    // `usage-reconciled` once, and carries the meter's own arithmetic.
    const telemetry = journalLines
      .filter((line) => line['kind'] === 'telemetry')
      .map((line) => line['event'] as { kind?: string; reading?: { inputTokens?: number;
        cachedInputTokens?: number | null; estimateErrorTokens?: number } });
    const usageEvents = telemetry.filter((event) => event.kind === 'usage-reconciled');
    assert.equal(usageEvents.length, 1, 'one telemetry event per reconciled request');
    assert.equal(usageEvents[0]?.reading?.inputTokens, 8029);
    assert.equal(usageEvents[0]?.reading?.cachedInputTokens, 7424);
    assert.equal(usageEvents[0]?.reading?.estimateErrorTokens, 8029 - estimated);
    // A second row is a second request: one reading each, never a merged count.
    step(session, { turn: 1, step: 3,
      usage: { inputTokens: 240, outputTokens: 81, cacheReadTokens: 7296 } });
    assert.equal(journalLines.filter((line) => line['kind'] === 'usage-reconciled').length, 2);
    await mounted.dispose();
  } finally {
    cleanup(dir);
  }
});

/**
 * The transcript's ordinal projection, all three paths: an appended node keeps
 * the (turn, step) pair it was written with, a walk across turns numbers the
 * pairs globally, and a replacement landing at a later log seq keeps the ordinal
 * of the position it took over — never its arrival seq (ISSUE-064 R-3).
 */
const ORDINAL_ROWS: readonly Row[] = [
  {
    name: 'ordinary append',
    run(at) {
      // The regression pin for the ISSUE-064 fix: an appended node sits inside its
      // own step, so its own pair and its log position agree. The projection must
      // not move for the append path.
      const session = fakeSession('session-append-ordinals');
      step(session, { turn: 1, step: 1,
        toolCall: { id: 'c1', name: 'read', input: { file_path: 'big.txt' } },
        result: { content: [{ type: 'text', text: 'body' }] } });
      step(session, { turn: 1, step: 2 });
      step(session, { turn: 1, step: 3, endTurn: true });
      const projected = surfaceTranscript(session, { sessionId: session.id });
      assert.deepEqual(projected.items.map((item) => [item.role, item.turnOrdinal,
        item.stepOrdinal]), [
        ['system', 1, 1], ['user', 1, 1], ['assistant', 1, 1], ['tool', 1, 1],
        ['system', 1, 2], ['user', 1, 2],
        ['system', 1, 3], ['user', 1, 3],
      ], at('an append keeps the ordinal it was written with'));
      assert.equal(projected.currentTurnOrdinal, 1, at('the current turn is 1'));
      assert.equal(projected.currentStepOrdinal, 3,
        at('dsh restarts step per turn; the walk does not'));
      assert.equal(projected.completedThroughTurnOrdinal, 1, at('turn/end completed turn 1'));
    },
  },
  {
    name: 'global numbering',
    run(at) {
      const session = fakeSession();
      step(session, { turn: 1, step: 1 });
      step(session, { turn: 1, step: 2, endTurn: true });
      step(session, { turn: 2, step: 1 });
      const synced = surfaceTranscript(session, { sessionId: session.id });
      assert.equal(synced.currentTurnOrdinal, 2, at('the walk reaches turn 2'));
      // dsh restarts `step` at 1 each turn; the projection must not.
      assert.equal(synced.currentStepOrdinal, 3, at('the step ordinal keeps counting'));
      assert.equal(synced.completedThroughTurnOrdinal, 1, at('only turn 1 completed'));
      const steps = synced.items.filter((item) => item.role === 'user')
        .map((item) => item.stepOrdinal);
      assert.deepEqual(steps, [1, 2, 3], at('the user turns are numbered 1, 2, 3'));
    },
  },
  {
    name: 'replace at a later seq',
    run(at) {
      // The live shape (ISSUE-064, R-3): the at-rest proof burn replaced the result
      // captured at step 5 with a node appended while the session stood at step 28.
      // The replaced node still occupies its step-5 surface position, and the node
      // right after it is a step-5 message. Stamping the replacement with its
      // arrival seq (1:28) makes the walk go backwards into that 1:5 neighbour, and
      // the guard latches `adjacency-changed` on the honest path.
      const session = fakeSession('session-replaced-ordinal');
      // Steps 1-4 are ordinary, so the pair (1, 5) is the transcript's 5th step —
      // the live numbering, where the replaced result reads `1:5`.
      for (let at = 1; at <= 4; at += 1) step(session, { turn: 1, step: at });
      step(session, { turn: 1, step: 5,
        toolCall: { id: 'c5', name: 'read', input: { file_path: 'big.txt' } },
        result: { content: [{ type: 'text', text: 'ORIGINAL BODY' }] } });
      // A surface node AFTER the result, inside the same step, carrying no
      // (turn, step) of its own (the live `message:97` shape).
      session.append('user/message', { content: [{ type: 'text', text: 'an ask that stays put' }],
        source: { kind: 'user' }, role: 'user', id: 'ask-1' }, { surfaceOp: 'append' });
      for (let at = 6; at <= 28; at += 1) step(session, { turn: 1, step: at });
      const origin = session.log.find((event) => event.type === 'tool/result'
        && event.surfaceOp === 'append');
      assert.ok(origin !== undefined, at('the step-5 result is on the surface'));

      // Exactly the host write an entry apply performs: one content-only
      // `tool/result` replace over the captured node, carrying the ORIGINAL
      // `turn`/`step` (1:5) while landing at step 28's log position.
      session.append('tool/result', { turn: 1, step: 5,
        message: { role: 'tool', source: { kind: 'tool', callId: 'c5' }, toolCallId: 'c5',
          content: [{ type: 'text', text: '[not retained] necromancy recall:sha256:0' }], isError: false,
          id: 'result-c5' } },
      { surfaceOp: { op: 'replace', startSeq: origin.seq, endSeq: origin.seq },
        sourceEventSeqs: [origin.seq] });

      const projected = surfaceTranscript(session, { sessionId: session.id });
      const result = projected.items.find((item) =>
        item.id === 'dsh:session-replaced-ordinal:result:c5');
      assert.ok(result !== undefined, at('the replaced result is on the surface'));
      assert.deepEqual([result.turnOrdinal, result.stepOrdinal], [1, 5],
        at('the replacement carries the ordinal of the position it occupies, '
          + 'not its arrival seq (1:28)'));
      for (let index = 1; index < projected.items.length; index += 1) {
        const previous = projected.items[index - 1];
        const current = projected.items[index];
        assert.ok(previous !== undefined && current !== undefined,
          at(`item ${String(index)} has both neighbours`));
        assert.ok(current.turnOrdinal > previous.turnOrdinal
          || (current.turnOrdinal === previous.turnOrdinal
            && current.stepOrdinal >= previous.stepOrdinal),
        at(`the walked ordinal decreases at ${current.id}: ${String(previous.turnOrdinal)}:`
          + `${String(previous.stepOrdinal)} -> ${String(current.turnOrdinal)}:`
          + `${String(current.stepOrdinal)} (a replace must not renumber the surface)`));
      }
    },
  },
];

test('the ordinal projection holds for an append, a global walk and a late replacement '
  + '(ISSUE-064)', async () => {
  await runRows(ORDINAL_ROWS);
});

test('the tool result carries the call\'s declared argument payload (ISSUE-151)', () => {
  // The call-echo dedupe compares the result against the request's own
  // argument text; a projection that dropped `arguments` would make the class
  // silently unplannable on every live session.
  const session = fakeSession('session-call-echo');
  const input = { todos: [{ content: 'one', status: 'pending' }] };
  step(session, { turn: 1, step: 1,
    toolCall: { id: 'todo-1', name: 'TodoWrite', input },
    result: { content: [{ type: 'text', text: JSON.stringify({ todos: input.todos }) }] } });
  const projected = surfaceTranscript(session, { sessionId: session.id });
  const tool = projected.items.find((item) => item.role === 'tool');
  assert.ok(tool !== undefined, 'the tool item was projected');
  assert.equal(tool.callArguments, JSON.stringify(input),
    'the request payload is carried verbatim, not re-rendered');
  assert.deepEqual(tool.input, input, 'the parsed evidence input is unchanged');
});

// --- ISSUE-053: per-path coverage rows and the recall source lane ------------

/** The three-line body both issues drive a real mount with. */
const SOURCE_BODY = 'alpha line\nbeta line\ngamma line\n';
const SOURCE_LINES = ['alpha line', 'beta line', 'gamma line'];

/** A `read` result's host meta: a 1-based origin and the lines it returned. */
function readMeta(path: string, lines: readonly string[]): Record<string, unknown> {
  return { path, offset: 1, totalLines: lines.length,
    lines: lines.map((text, number) => ({ number: number + 1, text })) };
}

test('G3: a synced transcript carries per-path byte rows on the snapshot (ISSUE-053)', async () => {
  const dir = scratch();
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: () => {} });
  try {
    const session = fakeSession('session-coverage');
    const entry = await mount.sessionFor(session.id, session);
    // A read whose own meta proves it returned the file's content...
    step(session, { turn: 1, step: 1,
      toolCall: { id: 'c1', name: 'read', input: { file_path: 'big.txt' } },
      result: { content: [{ type: 'text', text: SOURCE_BODY }], meta: readMeta('big.txt', SOURCE_LINES) } });
    // ...and a shell result naming the same path: the meter is tool-name
    // agnostic, and an unknown outcome is counted but proves nothing.
    const shell = 'shell copy\n';
    step(session, { turn: 1, step: 2,
      toolCall: { id: 'c2', name: 'pwsh', input: { command: 'cat big.txt', path: 'big.txt' } },
      result: { content: [{ type: 'text', text: shell }] } });
    mount.syncTranscript(entry, session);
    // The engine plans against exactly this snapshot (`port.snapshot()`), so
    // the rows reach every rule and the guard.
    const snapshot = await entry.port.snapshot();
    assert.deepEqual(snapshot.pathCoverage, [{ pathKey: 'big.txt',
      bytes: SOURCE_BODY.length + shell.length, hitBytes: SOURCE_BODY.length,
      missBytes: 0, unknownBytes: shell.length, observations: 2 }],
    'one row per path: byte facts only, no threshold, bar or score (ADR-0006)');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

interface RecallMount {
  readonly dir: string;
  /** The workspace root the fake host names, or null when it names none. */
  readonly root: string | null;
  readonly ledgerPath: string;
  readonly recallId: string;
  recall(args: unknown): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

/**
 * One live mount that forges a recall id through the `forget` tool, then loses
 * the ledger row: the state a source-lane recall has to answer in. `workspace`
 * decides whether the host names a root at all — a dsh session header carries
 * `cwd`, and that root is the boundary the source lane may read inside.
 */
async function forgetThenRecall(options: {
  readonly workspace: boolean;
  readonly sessionId: string;
}): Promise<RecallMount> {
  const dir = scratch();
  const root = options.workspace ? join(dir, 'work') : null;
  if (root !== null) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'big.txt'), SOURCE_BODY);
  }
  const storageRoot = join(dir, 'storage');
  const tools = new Map<string, { execute(args: unknown): Promise<unknown> }>();
  const listeners = new Map<string,
    (payload: unknown, next: () => unknown) => Promise<unknown>>();
  const cleanups: (() => unknown)[] = [];
  const plugin = createRacoonsPlugin({ journal: () => {},
    storage: { root: storageRoot }, config: { barBytes: 8 } });
  await plugin.apply({
    logger: { warn: () => {} },
    tools: { register(tool: { name: string; execute(args: unknown): Promise<unknown> }) {
      tools.set(tool.name, tool);
      return () => { tools.delete(tool.name); };
    } },
    on: (event: string, listener: (payload: unknown, next: () => unknown) => Promise<unknown>) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect: (register: () => (() => unknown) | void) => {
      const outcome = register();
      if (typeof outcome === 'function') cleanups.push(outcome);
    },
  } as unknown as DshMountContext, {});
  const session = fakeSession(options.sessionId, root ?? undefined);
  const preStep = listeners.get('agent/pre-step');
  assert.ok(preStep !== undefined, 'the plugin registers a pre-step');
  const boundary = async (turn: number): Promise<void> => {
    await preStep({ agent: { session }, messages: [], turn, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages: [] }));
  };
  step(session, { turn: 1, step: 1,
    toolCall: { id: 'c1', name: 'read', input: { file_path: 'big.txt' } },
    result: { content: [{ type: 'text', text: SOURCE_BODY }], meta: readMeta('big.txt', SOURCE_LINES) } });
  await boundary(1);
  // The agent forgets the result; the NEXT boundary applies it and mints the id.
  const forget = tools.get('forget');
  assert.ok(forget !== undefined, 'the forget tool is registered');
  assert.deepEqual(await forget.execute({ path: 'big.txt' }),
    { status: 'scheduled', path: 'big.txt', ranges: [] });
  await boundary(2);
  const replaced = session.log.filter((event) => event.type === 'tool/result'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null);
  const content = (replaced[0]?.data as
    { message: { content: { type: string; text: string }[] } } | undefined)?.message.content ?? [];
  const receipt = content.map((block) => block.text).join('');
  const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(receipt)?.[1];
  assert.ok(recallId !== undefined, 'the applied receipt names a recall id');
  // A ledger that lost the row: the miss is real, not a fake refusal. The
  // schema forbids a DELETE (ADR-0003's trigger), so the test drops that one
  // trigger on its own handle — the row is gone for every later open, which is
  // the state a source-lane recall has to answer in.
  const ledgerPath = resolveSessionStorage(storageRoot, session.id).databasePath;
  const db = new DatabaseSync(ledgerPath, { enableForeignKeyConstraints: false });
  try {
    db.exec('DROP TRIGGER IF EXISTS recalls_no_delete');
    db.prepare('DELETE FROM recalls WHERE recall_id = ?').run(recallId);
  } finally { db.close(); }
  return {
    dir, root, ledgerPath, recallId,
    recall: async (args: unknown) => {
      const recall = tools.get('necromancy');
      assert.ok(recall !== undefined, 'the recall tool is registered');
      return await recall.execute(args) as Record<string, unknown>;
    },
    dispose: async () => {
      for (const fn of cleanups.reverse()) await fn();
      cleanup(dir);
    },
  };
}

/**
 * G5, both sides of the source lane: with a workspace root a ledger miss is
 * answered from the unchanged source (and a changed file refuses), and with no
 * root the miss stays a miss. Only the mount's workspace differs, so both rows
 * share one body; each names its own expectations through `at`.
 */
const SOURCE_LANE_ROWS: readonly {
  readonly name: string;
  readonly sessionId: string;
  readonly workspace: boolean;
  run(mounted: RecallMount, at: Label): Promise<void>;
}[] = [
  {
    name: 'a named root answers from the source',
    sessionId: 'session-source',
    workspace: true,
    async run(mounted, at) {
      const root = mounted.root;
      assert.ok(root !== null, at('this mount names a workspace root'));
      // The ledger row is gone: the only lane left is the unchanged source.
      const restored = await mounted.recall({ id: mounted.recallId });
      assert.equal(restored['text'], SOURCE_BODY, at('the unchanged source answers byte-exactly'));
      assert.equal(restored['byteLength'], SOURCE_BODY.length, at('the byte length matches'));
      // A changed file is a refusal, never a substitute (PRD §6.7).
      const edited = new TextEncoder().encode(SOURCE_BODY);
      edited[0] = (edited[0] ?? 0) ^ 0x20;
      writeFileSync(join(root, 'big.txt'), edited);
      assert.equal(edited.byteLength, SOURCE_BODY.length,
        at('same length, one byte different: a length check alone would pass it'));
      await assert.rejects(mounted.recall({ id: mounted.recallId }),
        (error: unknown) => error instanceof LedgerError && error.code === 'hash-mismatch',
        at('a changed file refuses instead of answering'));
    },
  },
  {
    name: 'no root keeps the not-found refusal',
    sessionId: 'session-no-root',
    workspace: false,
    async run(mounted, at) {
      assert.equal(mounted.root, null, at('this mount names no root'));
      await assert.rejects(mounted.recall({ id: mounted.recallId }),
        (error: unknown) => error instanceof LedgerError && error.code === 'not-found',
        at('no root, no reader: a ledger miss stays a miss'));
    },
  },
];

test('G5: a live recall after a ledger miss answers from the source, or keeps the miss '
  + '(ISSUE-053)', async () => {
  await runRows(SOURCE_LANE_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const mounted = await forgetThenRecall(
        { workspace: scenario.workspace, sessionId: scenario.sessionId });
      try {
        await scenario.run(mounted, at);
      } finally {
        await mounted.dispose();
      }
    },
  })));
});


/**
 * The pure projections the mount reads host facts through: the call pair a
 * target name comes from, the search space a meta proves, and the span a read
 * meta claims. One row per projection; the case loops inside each still name
 * the meta that produced a wrong verdict.
 */
const PROJECTION_ROWS: readonly Row[] = [
  {
    name: 'targetFromInput',
    run(at) {
      assert.deepEqual(targetFromInput('read', { file_path: 'a.txt' }),
        { key: 'a.txt', label: 'a.txt' }, at('a read names its file path'));
      assert.deepEqual(targetFromInput('grep', { pattern: 'NEEDLE' }),
        { key: 'NEEDLE', label: 'NEEDLE' }, at('grep names its pattern'));
      assert.deepEqual(targetFromInput('glob', { pattern: '*.ts' }),
        { key: '*.ts', label: '*.ts' }, at('glob names its pattern'));
      assert.equal(targetFromInput('pwsh', { command: 'dir' }), null,
        at('a shell call names no target: only grep/glob use the pattern'));
    },
  },
  {
    name: 'search miss',
    run(at) {
      const miss = resultFactsFromMeta('grep', { path: 'src' },
        { shape: 'matches', files: [], truncated: false, total: 0 });
      assert.equal(miss.complete, true, at('a complete zero-match grep proves a miss'));
      assert.equal(miss.paths?.[0]?.matchCount, 0, at('the miss names its zero count'));
      const globMiss = resultFactsFromMeta('glob', { pattern: '*.ts' },
        { shape: 'paths', paths: [], truncated: false, total: 0 });
      assert.equal(globMiss.complete, true, at('a complete zero-path glob proves a miss'));
      for (const meta of [
        { shape: 'matches', files: [], truncated: true, total: 0 },
        { shape: 'matches', files: [{ path: 'a' }], truncated: true, total: 1 },
        { shape: 'paths', paths: [], truncated: true, total: 0 },
        { cwd: 'C:/work' },
        null,
      ]) {
        assert.notEqual(resultFactsFromMeta('grep', { pattern: 'N' }, meta).paths?.[0]?.matchCount,
          0, at(`meta ${JSON.stringify(meta)} must not prove a miss`));
      }
    },
  },
  {
    name: 'read span',
    run(at) {
      // The live shape: 1-based `offset`, `lines` entries, `totalLines` for the file.
      const partial = resultFactsFromMeta('read', { file_path: 'src/app.ts' }, {
        path: 'src/app.ts', offset: 400, totalLines: 1648,
        lines: Array.from({ length: 130 }, (_, index) => ({ number: 400 + index, text: 'x' })),
      });
      assert.equal(partial.complete, false, at('a read proves no search space'));
      assert.deepEqual(partial.paths,
        [{ path: 'src/app.ts', pathKey: 'src/app.ts', lineCount: 130 }],
        at('the span it covered, never the file total'));
      // A meta whose `path` resolves differently from the call keeps both spellings.
      const renamed = resultFactsFromMeta('read', { file_path: 'a.ts' },
        { path: 'C:\\work\\a.ts', offset: 1, totalLines: 2,
          lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] });
      assert.equal(renamed.paths?.[0]?.pathKey, 'a.ts', at('the call spelling is the key'));
      assert.equal(renamed.paths?.[0]?.displayPath, 'C:\\work\\a.ts',
        at('the meta spelling is the display path'));
      // No span in the meta (or no 1-based origin) proves nothing: count-free, so unknown.
      for (const meta of [
        { path: 'a.ts', totalLines: 3 },
        { path: 'a.ts', offset: 1, lines: [] },
        { path: 'a.ts', offset: 0, lines: [{ number: 0, text: 'a' }] },
        { path: 'a.ts', lines: [{ number: 1, text: 'a' }] },
      ]) {
        const facts = resultFactsFromMeta('read', { file_path: 'a.ts' }, meta);
        assert.equal(facts.paths?.[0]?.lineCount, undefined,
          at(`meta ${JSON.stringify(meta)} must not claim a span`));
      }
    },
  },
];

test('the host-fact projections name their target, search space and span', async () => {
  await runRows(PROJECTION_ROWS);
});

/**
 * The turn-stopping seam's session choice: a payload naming no agent resolves
 * through `singleLiveSession`, which answers only for exactly one live session.
 * The pure picker's four states are its own rows; the seam's two outcomes (no
 * session, so nothing is appended; one session, so the turn seals) ride a real
 * plugin over a fake context.
 */
const SINGLE_SESSION_ROWS: readonly {
  readonly name: string;
  readonly live: 'none' | 'zero' | 'two' | 'one';
  run(at: Label): void;
}[] = [
  {
    name: 'no sessions seam',
    live: 'none',
    run(at) {
      const ctx = { on: () => undefined } as unknown as DshMountContext;
      assert.equal(singleLiveSession(ctx), undefined, at('a context with no seam picks nothing'));
    },
  },
  {
    name: 'zero live sessions',
    live: 'zero',
    run(at) {
      const ctx = { on: () => undefined, sessions: { list: () => [] } } as unknown as DshMountContext;
      assert.equal(singleLiveSession(ctx), undefined, at('zero live sessions picks nothing'));
    },
  },
  {
    name: 'two live sessions',
    live: 'two',
    run(at) {
      const a = fakeSession('a');
      const b = fakeSession('b');
      const ctx = { on: () => undefined,
        sessions: { list: () => [a, b] } } as unknown as DshMountContext;
      assert.equal(singleLiveSession(ctx), undefined, at('two live sessions picks nothing'));
    },
  },
  {
    name: 'exactly one live session',
    live: 'one',
    run(at) {
      const only = fakeSession('a');
      const ctx = { on: () => undefined,
        sessions: { list: () => [only] } } as unknown as DshMountContext;
      assert.equal(singleLiveSession(ctx), only, at('one live session is picked'));
    },
  },
];

test('the turn-stopping seam seals only for exactly one live session', async () => {
  // The pure picker first: four states, four rows.
  await runRows(SINGLE_SESSION_ROWS.map((scenario): Row => ({
    name: scenario.name,
    run: at => { scenario.run(at); },
  })));
  // Then the seam over a real plugin: no session appends nothing, one seals.
  const dir = scratch();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const cleanups: (() => unknown)[] = [];
  const ctx: DshMountContext = {
    logger: { warn: () => {} },
    sessions: { list: () => [] },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
  };
  const at: Label = what => `row: the seam over a plugin: ${what}`;
  const plugin = createRacoonsPlugin({ storage: { databasePath: ':memory:' } });
  try {
    const session = fakeSession('session-turn-hook');
    await plugin.apply(ctx, {});
    session.on((s, event) => {
      const listener = listeners.get('session/event');
      if (listener !== undefined) (listener as (session: FakeSession, event: DshMountEvent) => void)(s, event);
    });
    const missMeta = { shape: 'matches', files: [], truncated: false, total: 0 };
    step(session, { turn: 1, step: 1,
      toolCall: { id: 'g1', name: 'grep', input: { pattern: 'NEEDLE', path: 'a.txt' } },
      result: { content: [{ type: 'text', text: 'no matches' }], meta: missMeta } });
    const before = session.seq ?? 0;
    const turnStopping = listeners.get('agent/turn-stopping') as
      (payload: unknown) => Promise<void>;
    await turnStopping({ turn: 1 });
    assert.equal(session.seq, before,
      at('no session was named and none was live, so nothing was appended'));
    // With exactly one live session the same payload seals.
    (ctx.sessions as { list(): unknown[] }).list = () => [session];
    await turnStopping({ turn: 1 });
    const facts = session.log.filter((event) => event.type === 'user/message'
      && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind
        === 'racoons/negation');
    assert.equal(facts.length, 1, at('the single-session fallback sealed one fact'));
  } finally {
    for (const fn of cleanups) await fn();
    cleanup(dir);
  }
});

/**
 * The necromancy tool's two output halves over one registration: the handler
 * projects a plain-JSON value (never a `Uint8Array`), and the renderer turns a
 * multi-part record into one block per part (never a joined body).
 */
const RECALL_ROWS: readonly Row[] = [
  {
    name: 'projected handler output',
    async run(at) {
      // The host snapshots every tool value as lossless JSON before it renders
      // (`snapshotJsonValue` in @deepseek-ai/dsh-util-values); a `RecallRecord`
      // carries `Uint8Array` bodies and is rejected `INVALID_TOOL_OUTPUT`. The rig's
      // durable-recall run found this: the tool answered, the host refused the value.
      const encoder = new TextEncoder();
      const body = 'row 1\r\nrow 2\r\n';
      const bytes = encoder.encode(body);
      const sha = sha256Sync(bytes);
      const source = { nodeId: 'result-1', sha256: sha, byteLength: bytes.length };
      const manifest = { version: 1 as const, sessionId: 'session-recall',
        parts: [{ source, blobSha256: sha, removedRanges: [] }] };
      const record: RecallRecord = {
        id: `recall:sha256:${sha256Sync(canonicalManifestBytes(manifest))}`,
        manifestSha256: sha256Sync(canonicalManifestBytes(manifest)), manifest,
        parts: [{ source, bytes, removedRanges: [] }] };
      let execute: ((args: unknown) => Promise<unknown>) | undefined;
      const host = {
        register: (tool: { name: string; execute: (args: unknown) => Promise<unknown> }) => {
          assert.equal(tool.name, 'necromancy', at('the tool registers under its own name'));
          execute = tool.execute;
          return () => {};
        },
      };
      registerPluginTools(host as never, { recall: async () => record });
      assert.ok(execute !== undefined, at('the recall tool is registered'));
      const output = await execute({ id: record.id }) as Record<string, unknown>;
      assert.deepEqual(output, { recallId: record.id, text: body,
        byteLength: bytes.length, parts: [{ nodeId: 'result-1', byteLength: bytes.length,
          sha256: sha, text: body }] }, at('the output is the projected record'));
      // The contract the host enforces: the returned value is plain JSON.
      assert.doesNotThrow(() => structuredClone(JSON.parse(JSON.stringify(output))),
        at('the output survives a lossless JSON round trip'));
      assert.equal(JSON.stringify(output).includes('Uint8Array'), false,
        at('no raw bytes reach the host'));
    },
  },
  {
    name: 'multi-part render',
    async run(at) {
      // The projection (`tools.ts` `recallText`) sets `text` only when the record has
      // exactly one part and `null` when it has several, so a render that reads only
      // `text` hands the model an empty block and drops every restored byte.
      const encoder = new TextEncoder();
      const bodies = ['alpha row\n', 'beta row\n'];
      const recordOf = (given: readonly string[]): RecallRecord => {
        const parts = given.map((body, index) => {
          const bytes = encoder.encode(body), hash = sha256Sync(bytes);
          return { source: { nodeId: `result-${String(index)}`, sha256: hash,
            byteLength: bytes.length },
            bytes, removedRanges: [{ range: { startByte: 0, endByteExclusive: bytes.length },
              sha256: hash }] };
        });
        const manifest = { version: 1 as const, sessionId: 'session-render',
          parts: parts.map(part => ({ source: part.source, blobSha256: part.source.sha256,
            removedRanges: part.removedRanges })) };
        const sha = sha256Sync(canonicalManifestBytes(manifest));
        return { id: `recall:sha256:${sha}`, manifestSha256: sha, manifest, parts };
      };
      let record = recordOf(['only row\n']);
      let execute: ((args: unknown) => Promise<unknown>) | undefined;
      let render: ((args: unknown, value: unknown) => { text: string }[]) | undefined;
      const host = { register: (tool: { name: string; execute(args: unknown): Promise<unknown>;
        output: { render(args: unknown, value: unknown): { text: string }[] } }) => {
        if (tool.name === 'necromancy') { execute = tool.execute; render = tool.output.render; }
        return () => {};
      } };
      registerPluginTools(host as never, { recall: async () => record });
      assert.ok(execute !== undefined, at('the recall tool is registered'));
      assert.ok(render !== undefined, at('the recall tool declares a render'));
      const run = execute, intoText = render;
      // The host's own path: execute projects, then `render` turns the value into text.
      const answer = async (): Promise<string[]> => {
        const value = await run({ id: record.id });
        return intoText(undefined, value).map(block => block.text);
      };

      // The single-part fast path stays one block of exact bytes, no envelope.
      assert.deepEqual(await answer(), ['only row\n'],
        at('a single part renders as its own bytes'));

      // A multi-part record: no joined body, every part in part order.
      record = recordOf(bodies);
      const blocks = await answer();
      assert.equal(blocks.length, 1, at('one text block carries the answer'));
      assert.notEqual(blocks[0], '', at('a multi-part answer never renders as empty text'));
      const parsed = JSON.parse(blocks[0] ?? '') as { text: unknown; parts: { text: string }[] };
      assert.equal(parsed.text, null, at('no single body is claimed for a multi-part record'));
      assert.deepEqual(parsed.parts.map(part => part.text), bodies,
        at('each part restores its own bytes, in part order'));
      assert.notEqual(blocks[0], bodies.join(''), at('the render never joins the parts'));
    },
  },
];

test('the necromancy tool projects plain JSON and renders every part (ISSUE-062)', async () => {
  await runRows(RECALL_ROWS);
});

/**
 * The entry seam's two ends: the unit id it captures is the id the surface
 * projection reproduces (a seq-vs-call-id drift would ask a unit no snapshot can
 * settle, ISSUE-024 chunk 2), and a mount with no `llm` seam journals its reason
 * instead of asking silently (ADR-0028 leaves the entry ask and the prune as the
 * two ask moments).
 */
const ENTRY_ROWS: readonly Row[] = [
  {
    name: 'the captured id matches the projection',
    run(at) {
      const session = fakeSession('session-identity');
      const mount = createRacoonsMount({ config: resolvePluginConfig({ barBytes: 64 }),
        storage: resolveStorage(undefined), journal: () => {} });
      const seen: string[] = [];
      session.on((s, event) => {
        const item = mount.observe(s, event);
        if (item !== null) seen.push(item.id);
      });
      step(session, { turn: 1, step: 1,
        toolCall: { id: 'c9', name: 'read', input: { file_path: 'big.txt' } },
        result: { content: [{ type: 'text', text: oversizedBody(4096) }] } });
      const projected = surfaceTranscript(session, { sessionId: session.id });
      const result = projected.items.find((item) => item.role === 'tool');
      assert.deepEqual(seen, [result?.id], at('capture and projection name the same node'));
      assert.equal(seen[0], 'dsh:session-identity:result:c9', at('the id names the call, not a seq'));
    },
  },
  {
    name: 'no llm service',
    async run(at) {
      const dir = scratch();
      journalLines.length = 0;
      const listeners = new Map<string, (...args: never[]) => unknown>();
      const cleanups: (() => unknown)[] = [];
      const ctx: DshMountContext = {
        logger: { warn: () => {} },
        on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
        effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
      };
      const plugin = createRacoonsPlugin({ journal: (record) => journalLines.push(record),
        storage: { databasePath: ':memory:' },
        // The stand-down rows are about the entry lane, so this test selects the
        // explicit count compatibility cadence; the absent default is `off`.
        config: { barBytes: 64, entryAskTrigger: { mode: 'count' } } });
      try {
        const session = fakeSession('session-no-llm');
        await plugin.apply(ctx, {});
        session.on((s, event) => {
          const listener = listeners.get('session/event');
          if (listener !== undefined) {
            (listener as (session: FakeSession, event: DshMountEvent) => void)(s, event);
          }
        });
        step(session, { turn: 1, step: 1,
          toolCall: { id: 'g1', name: 'read', input: { file_path: 'big.txt' } },
          result: { content: [{ type: 'text', text: oversizedBody(4096) }] } });
        const preStep = listeners.get('agent/pre-step') as
          (payload: unknown, next: () => unknown) => Promise<unknown>;
        await preStep({ agent: { session }, messages: [], turn: 1, step: 2, signal: {} },
          async () => ({ kind: 'enter', messages: [] }));
        const off = journalLines.find((line) => line['kind'] === 'entry-ask-off');
        assert.equal(off?.['reason'], 'no-llm-service', at('the refusal names the missing seam'));
        assert.equal(journalLines.some((line) => line['kind'] === 'entry-ask'), false,
          at('no ask was journaled'));
        // The mount line names no judge arm any more; the prune's deadline stays.
        const mounted = journalLines.find((line) => line['kind'] === 'mounted');
        assert.equal(mounted?.['judge'], undefined, at('the mount names no judge arm'));
        assert.equal(typeof mounted?.['judgeTimeoutMs'], 'number',
          at('the prune deadline still rides the mount line'));
        assert.equal(session.log.filter((event) => typeof event.surfaceOp === 'object').length, 0,
          at('nothing was replaced: no answer was received'));
      } finally {
        for (const fn of cleanups) await fn();
        cleanup(dir);
      }
    },
  },
];

test('the entry seam names its unit by call id, and states its reason when it cannot ask',
  async () => {
    // Two claims about the entry checkpoint, both checked through a real mount:
    // the id it captures is the id the surface projection reproduces, and a
    // mount with no `llm` seam journals why rather than asking silently.
    await runRows(ENTRY_ROWS);
  });
