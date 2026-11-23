/**
 * The mount's prune apply leg (ISSUE-022 chunk 6; ADR-0009, ADR-0012, ADR-0008).
 *
 * Each claim is tested where it can fail, on the REAL mount/engine/adapter/port
 * with a fake host and a scripted model:
 *
 *   1. `cache: unknown` — the mount's actual shipped state — applies a prune's
 *      removals: one checkpoint-revert for the whole pass and one epoch break
 *      (CRITIC-022a's first missing test).
 *   2. a real WARM watermark, with the cut below it, refuses the pass as
 *      `cut-below-watermark` and moves nothing (CRITIC-022a's second missing
 *      test; ADR-0012 keeps this fence for a stated watermark only), and the
 *      fence's two sides are pinned: a removal exactly at the watermark applies,
 *      one node deeper is refused (ISSUE-035 item 6).
 *   3. the trigger fires once per crossing, not once per step, a session with no
 *      bar and no window never auto-fires, a command step still observes the
 *      latch, and the native-compaction backstop re-arms only when its flag
 *      is on (CRITIC-022 P1-1, P2 #5).
 *   4. the round ordinal persists across a remount on a durable root, and its
 *      file fails open: a corrupt read is 0, a failed write is journaled
 *      (CRITIC-022 P2 #6).
 *   5. nothing to apply sends no engine event, and the skip names which
 *      condition skipped it — `no-application`, `no-removals`, `no-window`
 *      (CRITIC-022 P2 #7, P3 #9).
 *   6. the apply line states the enforcement mode and revert capability the
 *      engine decided under, so an `unchanged` is readable (CRITIC-022 P2 #8).
 *   7. the event id is content-derived, so a reused round is a different event
 *      (CRITIC-022 P2 #6), and every kind this suite sees is in the closed
 *      journal vocabulary (CRITIC-022 P3 #14).
 *   8. an explicit `pruneThresholdTokens` bar wins over the window, re-arms on
 *      one bar of growth or a below-bar excursion, and is refused by name when
 *      it is not a positive safe integer (ADR-0050 decisions 2–3). The
 *      window-only half stays as the deprecated compatibility path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalManifestBytes } from '@cremator/core';
import { createMainWireCapture } from '../src/main-wire.js';
import type {
  DshLlmChunk, DshLlmStreamOptions, DshMountEvent, DshMountSession, RacoonsJournalSink,
} from '../src/plugin.js';
import { createRacoonsMount, resolvePluginConfig, resolveStorage } from '../src/plugin.js';
import { CREMATOR_JOURNAL_KINDS } from '../src/journal-kinds.js';
import { pruneEventId } from '../src/prune-apply.js';
import { PRUNE_ROUND_FILE } from '../src/prune-round-store.js';
import { PruneWindowTrigger } from '../src/prune-trigger.js';

/** Above the 64-byte test bar, so every read is its own unit. */
const BODY = (name: string): string =>
  `${name} line one is the first body line\n${name} line two is the second body line\n`
  + `${name} line three is the third body line\n`;

/** Main's last sent request: the prune fork seeds from it and never edits it. */
const HOST_MAIN = {
  system: 'MAIN SYSTEM BYTES',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read the files' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading them.' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'result bytes' }] },
  ],
};

/** A fake host session: an append-only log with a live surface node list. */
function fakeSession(id: string): DshMountSession & {
  readonly log: DshMountEvent[];
  readonly surfaceNodes: number[];
  setRoute(next: { readonly provider: string; readonly model: string }): void;
} {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  let route = { provider: 'a6', model: 'prune-model' };
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes }; },
    get log() { return log; },
    get surfaceNodes() { return surfaceNodes; },
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

/** One closed turn: system head, user task, assistant call, the read's result. */
function seedRead(session: ReturnType<typeof fakeSession>, params: {
  turn: number; callId: string; target: string; body?: string;
}): void {
  const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });
  const body = params.body ?? BODY(params.target);
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
    content: [text(body)], isError: false, id: `result-${params.callId}` } },
  { surfaceOp: 'append' });
  session.append('step/end', { turn: params.turn, step: 1 });
  session.append('turn/end', { turn: params.turn });
}

/** Three closed turns, all bodies distinct: L1 proves nothing, so all three ask. */
function seedFixture(session: ReturnType<typeof fakeSession>): void {
  seedRead(session, { turn: 1, callId: 'c1', target: 'one.txt' });
  seedRead(session, { turn: 2, callId: 'c2', target: 'two.txt' });
  seedRead(session, { turn: 3, callId: 'c3', target: 'three.txt' });
}

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
  /** Present when the test wants the host model-info seam (ADR-0071). */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal):
    Promise<{ context?: { contextWindow?: number } }>;
}

function fakeLlm(answer: string): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: answer.slice(0, 5) };
        yield { type: 'text-delta', index: 0, text: answer.slice(5) };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

function collector(): { records: { kind: string; [field: string]: unknown }[];
  sink: RacoonsJournalSink } {
  const records: { kind: string; [field: string]: unknown }[] = [];
  return { records, sink: record => { records.push({ ...record }); } };
}

/** A mounted session with the host revert seam, main captured, the fake model. */
async function mounted(params: {
  id: string; answer?: string; window?: number | null; bar?: number; root?: string;
  seedTurnCount?: number; backstop?: boolean; enforcement?: 'apply' | 'record-only';
  mainSystem?: string; capture?: boolean; windowFromHost?: number;
}) {
  const session = fakeSession(params.id);
  if (params.seedTurnCount === undefined) seedFixture(session);
  else for (let turn = 1; turn <= params.seedTurnCount; turn += 1) {
    seedRead(session, { turn, callId: `c${String(turn)}`, target: `f${String(turn)}.txt` });
  }
  const records = collector();
  const mainWire = createMainWireCapture();
  // `capture: false` is a session whose main request has not been seen yet: no
  // prefix exists to count, so the trigger reads transcript content only.
  if (params.capture !== false) {
    mainWire.note({ sessionId: session.id, provider: 'a6', model: 'prune-model',
      ...HOST_MAIN,
      ...(params.mainSystem === undefined ? {} : { system: params.mainSystem }) });
  }
  const llm = params.answer === undefined ? undefined : fakeLlm(params.answer);
  const hostWindow = params.windowFromHost;
  if (llm !== undefined && hostWindow !== undefined) {
    llm.resolveModelInfo = async () => ({ context: { contextWindow: hostWindow } });
  }
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ barBytes: 64,
      ...(params.window === undefined ? {} : { contextWindowTokens: params.window }),
      ...(params.bar === undefined ? {} : { pruneThresholdTokens: params.bar }),
      ...(params.enforcement === undefined ? {} : { enforcement: params.enforcement }),
      ...(params.backstop === undefined ? {} : { nativeCompactionBackstop: params.backstop }) },
    { hostModelInfo: params.windowFromHost !== undefined }),
    storage: params.root === undefined
      ? resolveStorage(undefined) : resolveStorage({ root: params.root }, params.root),
    journal: records.sink, mainWire,
    ...(llm === undefined ? {} : { llm }),
  });
  const entry = await mount.sessionFor(session.id, session);
  for (const event of session.log) mount.observe(session, event);
  mount.syncTranscript(entry, session);
  return { session, mount, entry, records, llm };
}

// --- 1. the mount's real cache state: unknown -------------------------------


// --- 2. a stated warm watermark: the fence still applies --------------------



// --- 3. the half-window trigger --------------------------------------------








// --- 4. the round ordinal persists ------------------------------------------



// --- 5. nothing to apply sends nothing --------------------------------------




// --- the round file is the store's own, not a ledger record ------------------

test('an unknown cache applies a prune pass once: one revert, one epoch break', async () => {
  // The pass forgets ONE unit, so the checkpoint-revert shadows one host node
  // (dsh accepts a tool/result replacement as a single content-only node).
  const env = await mounted({ id: 's-apply-unknown', window: 1_000_000,
    answer: '{"2":{"forgetall":true,"summary":"an old read"}}' });
  try {
    // The shipped mount states no cache at all: this is the real state.
    const before = await env.entry.port.snapshot();
    assert.equal(before.cache.kind, 'unknown', 'the mount ships with no cache watermark');
    assert.equal(env.entry.adapter.capabilities.revertHistory, true,
      'the host session yields the revert seam');

    // The pass applied against the transcript it was read from; capture that
    // ordering before the apply replaces the forgotten node's entry.
    const prevItems = env.entry.port.transcript();
    const outcome = await env.mount.runPrune(env.session);
    assert.ok(outcome !== null, 'the pass settled');
    assert.equal(outcome.application?.removals.length, 1, 'the judged removal is the document');
    // The forgotten unit's node id, read from the plan rather than the surface:
    // after the apply the surface holds the receipt in its place.
    const forgottenNodeId = outcome.application?.removals[0]?.unitId === undefined
      ? undefined
      : outcome.plan.units.find(unit => unit.id === outcome.application?.removals[0]?.unitId)?.nodeId;
    assert.ok(forgottenNodeId !== undefined, 'the removal names a unit of this pass');
    const originalBytes = BODY('two.txt');

    const applied = env.records.records.find(record => record['kind'] === 'prune-apply');
    assert.ok(applied !== undefined, 'the pass reached the engine');
    assert.equal(applied['status'], 'applied', JSON.stringify(applied['issues']));
    assert.equal(applied['removals'], 1);
    // The engine's own record: exactly one revert, whatever the batch size.
    const telemetry = env.records.records.filter(record => record['kind'] === 'telemetry')
      .map(record => record['event'] as { kind?: string; cutIndex?: number });
    assert.equal(telemetry.filter(event => event.kind === 'revert-applied').length, 1,
      'one epoch break for the pass');
    const application = telemetry.find(event => event.kind === 'application');
    assert.ok(application !== undefined, 'the host application is journaled');
    // Exactly one surface replacement landed: one checkpoint-revert's append.
    assert.equal(env.session.log.filter(event => {
      const op = event.surfaceOp as { op?: string } | undefined;
      return op?.op === 'replace';
    }).length, 1, 'one shadow-replace, the epoch break');
    // The forgotten bytes are gone from the model-visible surface, and the
    // receipt that can restore them took their POSITION. A whole-unit forget
    // renders the receipt as a RACOONS record node, not as tool content: the
    // host cannot accept a tool/result replacement, so the record is the model's
    // own answer to "what was at that position" (ADR-0002's record shape).
    const items = env.entry.port.transcript();
    assert.equal(items.some(item => new TextDecoder().decode(item.bytes) === originalBytes), false,
      'the forgotten body left the transcript');
    const receipt = items.find((item): item is Extract<typeof item, { recordId: string }> =>
      item.role === 'system' && 'recordId' in item
      && new TextDecoder().decode(item.bytes).startsWith('[not retained]'));
    assert.ok(receipt !== undefined, 'a RACOONS record replaced the forgotten result');
    // Its position is the forgotten node's: the read's assistant turn precedes
    // it and the next turn's system head follows it.
    const at = items.indexOf(receipt);
    const forgottenAt = prevItems.findIndex(item => item.id === forgottenNodeId);
    assert.ok(forgottenAt > 0, 'the forgotten node had a position before the apply');
    assert.equal(at, forgottenAt, 'the record occupies the forgotten node\'s position');
    assert.match(receipt.recordId, /^racoons:/u, 'and carries its receipt identity');
    assert.match(new TextDecoder().decode(receipt.bytes), /recall:sha256:/u,
      'the receipt names the recall id that can restore the bytes');
  } finally {
    await env.mount.close();
  }
});

test('a resolved host window reaches the apply leg and the removed-byte count', async () => {
  const env = await mounted({ id: 's-apply-host-window', window: null, bar: 1_000_000,
    windowFromHost: 200_000,
    answer: '{"2":{"forgetall":true,"summary":"an old read"}}' });
  try {
    const outcome = await env.mount.runPrune(env.session);
    assert.ok(outcome !== null, 'the pass settled');
    const applied = env.records.records.find(record => record['kind'] === 'prune-apply');
    assert.ok(applied !== undefined, 'the pass reached the engine');
    assert.equal(applied['status'], 'applied', JSON.stringify(applied['issues']));
    assert.equal(applied['window'], 200_000,
      'the apply planned against the window resolved from the host (ADR-0071)');
    assert.equal(typeof applied['removedBytes'], 'number',
      'the applied result reports the removed bytes');
    assert.ok((applied['removedBytes'] as number) > 0);
    assert.equal(env.records.records.some(record => record['kind'] === 'window-resolved'), true);
    assert.equal(env.records.records.some(record => record['kind'] === 'window-unresolved'), false);
  } finally {
    await env.mount.close();
  }
});

test('the half-window trigger fires once per crossing, not once per step', async () => {
  // Three seeded turns estimate at 123 content tokens (measured on this
  // fixture); the captured system+tools prefix adds 29 more, so the mount's
  // whole-request reading (ADR-0009 §Amendment 2026-10-24) is above the line
  // from the first step of a 300-token window (threshold 150; the 75% skip line
  // is 225, so these readings stay fireable). Each step appends ~31 tokens of
  // receipt, and the re-arm policy (CRITIC-022 P1-1) re-fires only on half a
  // window of growth past the last pass, which 62 tokens of steps never
  // reaches: one crossing, one pass.
  const env = await mounted({ id: 's-trigger', window: 300, answer: '{"1":{"keepall":true}}' });
  try {
    assert.equal(env.entry.pruneTrigger.enabled, true);
    assert.equal(env.entry.pruneTrigger.threshold, 150);
    for (let step = 1; step <= 3; step += 1) {
      await env.mount.runStep(env.session, { turn: 4, step });
    }
    const passes = env.records.records.filter(record => record['kind'] === 'prune-recorded');
    assert.equal(passes.length, 1, 'three steps above the line, one pass');
    const lines = env.records.records.filter(record => record['kind'] === 'prune-threshold');
    assert.equal(lines.length, 3, 'every boundary that evaluated the bar is journaled');
    const crossing = lines.filter(record => record['crossed'] === true);
    assert.equal(crossing.length, 1, 'the crossing is journaled once');
    assert.equal(crossing[0]?.['threshold'], 150);
  } finally {
    await env.mount.close();
  }
});

test('ISSUE-092: the latch reads the host\'s billed prompt, never the text-only estimate', async () => {
  // The 078 run's shape, synthetic: the request's mass sits in tool-call
  // arguments and the cached prefix, and the local estimate (message text plus
  // tool-result bytes) sees none of it. Eight steps stay at ~150 estimated
  // tokens, so a 2 000-token bar is unreachable by the estimate; the host's
  // billed prompt (`input + cacheRead`) crosses at the fifth boundary. Under
  // the pre-fix wiring the latch never armed — that is the regression pinned.
  const env = await mounted({ id: 's-billed', window: 4_000,
    answer: '{"1":{"keepall":true}}' });
  try {
    assert.equal(env.entry.pruneTrigger.threshold, 2_000);
    const billed = [400, 800, 1_100, 1_500, 2_100, 2_400, 2_700, 3_000];
    const passesAfter: number[] = [];
    for (let step = 1; step <= 8; step += 1) {
      const pressure = billed[step - 1] ?? 0;
      // The host attaches the accounting to the step's `assistant/message`,
      // where `session/event` sees it between two boundaries.
      env.mount.observe(env.session, env.session.append('assistant/message', {
        turn: 4, step,
        message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: 'still working' }], id: `asst-${String(step)}` },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: pressure - 100 },
      }, { surfaceOp: 'append' }));
      await env.mount.runStep(env.session, { turn: 4, step });
      passesAfter.push(env.records.records
        .filter(record => record['kind'] === 'prune-recorded').length);
    }
    assert.deepEqual(passesAfter, [0, 0, 0, 0, 1, 1, 1, 1],
      'the bar arms at the fifth boundary and only once');
    const lines = env.records.records.filter(record => record['kind'] === 'prune-threshold');
    assert.equal(lines.length, 8, 'every boundary that evaluated the bar is journaled');
    const crossing = lines.filter(record => record['crossed'] === true);
    assert.equal(crossing.length, 1, 'the crossing is journaled once');
    assert.equal(crossing[0]?.['estimatedTokens'], 2_100, 'the reading is the host billed prompt');
    assert.equal(crossing[0]?.['barReading'], 'host-billed-prompt');
    // The line below the bar is the evidence a non-crossing run used to lack:
    // the evaluation is journaled, names the source it read, and is not a fire.
    const below = lines[0];
    assert.equal(below?.['crossed'], false, 'a boundary below the bar is an evaluation, not a fire');
    assert.equal(below?.['barReading'], 'host-billed-prompt',
      'and it still says which depth source the bar read');
    assert.equal(lines.slice(0, 4).every(record => record['crossed'] === false), true,
      'the four boundaries under the bar journal crossings of false');
    assert.equal(lines.every(record => record['barReading'] !== undefined), true,
      'no line is silent about its depth source');
    // The local estimate the old wiring read stays far below the bar: this
    // fixture would never arm without the host's count.
    const local = Number(crossing[0]?.['contentTokens'])
      + Number(crossing[0]?.['prefixTokens']);
    assert.ok(local < 2_000, `the text-only estimate (${String(local)}) stays under the bar`);
  } finally {
    await env.mount.close();
  }
});

test('the native-compaction backstop: with the flag on a compaction re-arms the latch', async () => {
  // The flag is the ISSUE-022 DoD's backstop wiring (CRITIC-022 P1-1). It never
  // suppresses or rewrites the host's compaction; it only decides whether the
  // end of one re-arms our latch, because a compaction leaves the old growth
  // baseline describing a surface that no longer exists.
  const passCount = (records: { readonly kind: string }[]): number =>
    records.filter(record => record['kind'] === 'prune-recorded').length;
  for (const backstop of [true, false]) {
    const env = await mounted({ id: `s-compaction-${String(backstop)}`, window: 300,
      backstop, answer: '{"1":{"keepall":true}}' });
    try {
      await env.mount.runStep(env.session, { turn: 4, step: 1 });
      await env.mount.runStep(env.session, { turn: 4, step: 2 });
      assert.equal(passCount(env.records.records), 1,
        'the first crossing fired, the grown session did not re-fire');
      // The host compacts: one log event, appended by the host, never by us.
      env.mount.observe(env.session, env.session.append('compaction/end', {
        turn: 4, summary: 'the host summarized the conversation' }));
      const line = env.records.records.find(record => record['kind'] === 'native-compaction');
      assert.ok(line !== undefined, 'the compaction is observed and journaled either way');
      assert.equal(line['rearmed'], backstop);
      await env.mount.runStep(env.session, { turn: 4, step: 3 });
      assert.equal(passCount(env.records.records), backstop ? 2 : 1,
        backstop
          ? 'the flag on: the next above-half observation fires again'
          : 'the flag off: the observation is ignored and the latch keeps its baseline');
    } finally {
      await env.mount.close();
    }
  }
});

test('the prune round persists across a remount on a durable root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-round-'));
  try {
    const first = await mounted({ id: 's-round', root, answer: '{"1":{"keepall":true}}',
      window: 1_000_000 });
    let firstRound: number;
    try {
      firstRound = first.entry.pruneRounds;
      assert.equal(firstRound, 0, 'a fresh session starts at round 0');
      await first.mount.runPrune(first.session);
      assert.equal(first.entry.pruneRounds, 1, 'the pass took round 1');
      await first.mount.runPrune(first.session);
      assert.equal(first.entry.pruneRounds, 2, 'and the next one round 2');
    } finally {
      await first.mount.close();
    }
    // A new mount over the same root is what a resumed dsh process does.
    const second = await mounted({ id: 's-round', root, answer: '{"1":{"keepall":true}}',
      window: 1_000_000 });
    try {
      assert.equal(second.entry.pruneRounds, 2, 'the counter survives the remount');
      const resumed = second.records.records.find(record => record['kind'] === 'prune-round-resumed');
      assert.equal(resumed?.['round'], 2, 'the read-back is journaled');
      await second.mount.runPrune(second.session);
      assert.equal(second.entry.pruneRounds, 3, 'the resumed process continues the count');
      const pass = second.records.records.find(record => record['kind'] === 'prune-recorded');
      assert.equal(pass?.['round'], 3, 'the pass stamps the continued ordinal');
    } finally {
      await second.mount.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt round file reads as 0 and never as garbage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-corrupt-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(root, 'sessions', 's-corrupt');
    mkdirSync(dir, { recursive: true });
    const target = { databasePath: join(dir, 'ledger.sqlite'),
      blobRoot: join(dir, 'blobs') };
    const { readPruneRound } = await import('../src/prune-round-store.js');
    for (const junk of ['{not json', '{"round":"two"}', '{"round":-1}', '{"round":1.5}', 'null']) {
      writeFileSync(join(dir, PRUNE_ROUND_FILE), junk, 'utf8');
      assert.equal(readPruneRound(target), 0, `"${junk}" is not a round and must not be trusted`);
    }
    // A round written by the store is read back unchanged: the safe failure is
    // "start over", and it must not also reject a good file.
    const { writePruneRound } = await import('../src/prune-round-store.js');
    const journaled: string[] = [];
    assert.equal(writePruneRound(target, 7, (kind) => { journaled.push(kind); }, 's-corrupt'),
      true);
    assert.equal(readPruneRound(target), 7);
    assert.deepEqual(journaled, [], 'a good write journals nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ISSUE-336: the latch state rides the round file and fails open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-latch-store-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(root, 'sessions', 's-latch-store');
    mkdirSync(dir, { recursive: true });
    const target = { databasePath: join(dir, 'ledger.sqlite'),
      blobRoot: join(dir, 'blobs') };
    const { readPruneTriggerState, writePruneRound } = await import('../src/prune-round-store.js');
    assert.equal(readPruneTriggerState(target), null, 'no file is no state');
    const state = { lastFireUsage: 214_000, belowSinceFire: false, baselinePending: true };
    assert.equal(writePruneRound(target, 3, () => {}, 's-latch-store', state), true);
    assert.deepEqual(readPruneTriggerState(target), state, 'the state reads back unchanged');
    // A round-only file (the pre-336 shape) carries no state, never garbage.
    writeFileSync(join(dir, PRUNE_ROUND_FILE), '{"round":3}\n', 'utf8');
    assert.equal(readPruneTriggerState(target), null, 'an old round-only file has no latch state');
    for (const junk of ['{not json',
      '{"round":1,"trigger":{"lastFireUsage":-5,"belowSinceFire":false,"baselinePending":true}}',
      '{"round":1,"trigger":{"lastFireUsage":null,"belowSinceFire":"no","baselinePending":true}}',
      '{"round":1,"trigger":7}']) {
      writeFileSync(join(dir, PRUNE_ROUND_FILE), junk, 'utf8');
      assert.equal(readPruneTriggerState(target), null, `"${junk}" must not be trusted`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a killed write never tears the round file: the old ordinal survives (ISSUE-347)', async (t) => {
  // The header claims the file is never torn. A bare in-place write falsifies
  // that under a kill: truncate + partial bytes leave a file the reader treats
  // as round 0, silently restarting the ordinal. Simulate the kill — the write
  // lays down partial bytes then the process dies (the throw stands in for
  // death) — and pin that the previous complete round survives.
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-kill-'));
  try {
    const dir = join(root, 'sessions', 's-kill');
    const target = { databasePath: join(dir, 'ledger.sqlite'), blobRoot: join(dir, 'blobs') };
    const { writePruneRound, readPruneRound, PRUNE_ROUND_FILE } = await import('../src/prune-round-store.js');
    const journaled: { kind: string; [field: string]: unknown }[] = [];
    const journal = (kind: string, fields: Record<string, unknown>): void => {
      journaled.push({ kind, ...fields });
    };
    // A completed round 5 is on disk before the kill.
    assert.equal(writePruneRound(target, 5, journal, 's-kill'), true);
    assert.equal(readPruneRound(target), 5);
    const realWrite = fs.writeFileSync.bind(fs);
    t.mock.method(fs, 'writeFileSync', ((path: fs.PathLike) => {
      realWrite(path, '{"round":', 'utf8');   // partial: unreadable as a round
      throw new Error('kill mid-write');
    }) as typeof fs.writeFileSync);
    assert.equal(writePruneRound(target, 6, journal, 's-kill'), false,
      'the caller learns the round is not durable');
    assert.equal(readPruneRound(target), 5,
      'the old ordinal survives a killed write; it never silently restarts to 0');
    const failed = journaled.find(record => record['kind'] === 'prune-round-error');
    assert.ok(failed !== undefined, 'the failure is named, not swallowed');
    assert.equal(failed['round'], 6);
    assert.deepEqual(fs.readdirSync(dir).filter(name => name !== PRUNE_ROUND_FILE), [],
      'a killed write leaves no torn temp beside the round file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ISSUE-336: the post-pass latch baseline survives a remount on a durable root', async () => {
  // The restart-after-pass scenario: a pass ran, the process died, a new mount
  // opens the same session directory. The first above-bar observation must be
  // the pass's post-removal baseline, not an immediate re-ask of just-judged
  // units. The bar (100) is under the fixture's first reading, so the remount's
  // first step is above it; the window is wide, so the 75% skip never applies.
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-latch-'));
  try {
    const first = await mounted({ id: 's-latch', root, window: 1_000_000, bar: 100,
      answer: '{"1":{"keepall":true}}' });
    try {
      await first.mount.runStep(first.session, { turn: 4, step: 1 });
      const passes = first.records.records.filter(record => record['kind'] === 'prune-recorded');
      assert.equal(passes.length, 1, 'the first crossing fired one pass');
    } finally {
      await first.mount.close();
    }
    // A new mount over the same root is what a resumed dsh process does.
    const second = await mounted({ id: 's-latch', root, window: 1_000_000, bar: 100,
      answer: '{"1":{"keepall":true}}' });
    try {
      const resumed = second.records.records
        .find(record => record['kind'] === 'prune-trigger-resumed');
      assert.ok(resumed !== undefined, 'the latch read-back is journaled');
      assert.equal(resumed['baselinePending'], true, 'the post-pass baseline is what resumed');
      await second.mount.runStep(second.session, { turn: 4, step: 1 });
      const afterFirst = second.records.records
        .filter(record => record['kind'] === 'prune-recorded');
      assert.equal(afterFirst.length, 0,
        'the first above-bar reading after the remount is the baseline, not a wasted re-ask');
      assert.equal(second.records.records
        .filter(record => record['kind'] === 'prune-threshold').at(-1)?.['crossed'], false);
      // The latch is not dead: one bar of new growth still fires it. The host
      // appends a fresh read turn whose body alone is several bars of bytes,
      // then the next step observes the grown surface.
      const seen = second.session.log.length;
      seedRead(second.session, { turn: 5, callId: 'c5', target: 'five.txt',
        body: 'growth bytes '.repeat(120) });
      for (const event of second.session.log.slice(seen)) {
        second.mount.observe(second.session, event);
      }
      await second.mount.runStep(second.session, { turn: 5, step: 1 });
      const afterGrowth = second.records.records
        .filter(record => record['kind'] === 'prune-recorded');
      assert.equal(afterGrowth.length, 1, 'one bar of growth past the rehydrated baseline fires');
    } finally {
      await second.mount.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the round file is published by temp+rename, never written in place (ISSUE-347)', async (t) => {
  // The atomic mechanism itself: a successful write stages a temp and renames it
  // onto the round file, so the final path only ever holds a complete ordinal.
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-atomic-'));
  try {
    const dir = join(root, 'sessions', 's-atomic');
    const target = { databasePath: join(dir, 'ledger.sqlite'), blobRoot: join(dir, 'blobs') };
    const { writePruneRound, readPruneRound, PRUNE_ROUND_FILE } = await import('../src/prune-round-store.js');
    const renames: { from: string; to: string }[] = [];
    const realRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      renames.push({ from: String(from), to: String(to) });
      realRename(from, to);
    });
    assert.equal(writePruneRound(target, 9, () => {}, 's-atomic'), true);
    assert.equal(readPruneRound(target), 9);
    const final = join(dir, PRUNE_ROUND_FILE);
    assert.equal(renames.length, 1, 'exactly one atomic publish');
    assert.equal(renames[0]?.to, final, 'the rename targets the round file');
    assert.notEqual(renames[0]?.from, final, 'the source is a temp, not the round file itself');
    assert.match(renames[0]?.from ?? '', /\.tmp$/u, 'the temp name is distinguishable from the round file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a warm watermark at the removal\'s node applies; one node deeper refuses', async () => {
  // ISSUE-035 item 6: the refusal test above puts the watermark past every
  // node, so it never shows the fence's two sides. ADR-0012's arithmetic is
  // `index < freshStart` for a verdict cut, and a warm cache's freshStart is
  // the watermark: a removal whose node sits exactly AT the watermark applies,
  // the same removal one node deeper into the cached prefix is refused.
  const atFence = await mounted({ id: 's-watermark-at', window: 1_000_000,
    answer: '{"2":{"forgetall":true,"summary":"an old read"}}' });
  try {
    const items = atFence.entry.port.transcript();
    const at = items.findIndex(item => item.id === `dsh:${atFence.session.id}:result:c2`);
    assert.ok(at > 0, 'turn 2\'s read is a live node');
    atFence.entry.port.updateState({ cache: { kind: 'warm', watermarkNodeIndex: at } });
    const outcome = await atFence.mount.runPrune(atFence.session);
    assert.equal(outcome?.application?.removals.length, 1, 'the judged removal is unchanged');
    const applied = atFence.records.records.find(record => record['kind'] === 'prune-apply');
    assert.equal(applied?.['status'], 'applied',
      `the cut lands exactly at the fence: ${JSON.stringify(applied?.['issues'])}`);
    // The forgotten body left the model-visible surface: the fence moved nothing.
    assert.equal(atFence.entry.port.transcript().some(item =>
      new TextDecoder().decode(item.bytes) === BODY('two.txt')), false,
    'the removal at the fence applied and moved the bytes');
  } finally {
    await atFence.mount.close();
  }

  // The same pass with the fence one node deeper: the removal's node is now
  // below it, and the cut is refused before any candidate is built.
  const deeper = await mounted({ id: 's-watermark-deeper', window: 1_000_000,
    answer: '{"2":{"forgetall":true,"summary":"an old read"}}' });
  try {
    const items = deeper.entry.port.transcript();
    const at = items.findIndex(item => item.id === `dsh:${deeper.session.id}:result:c2`);
    assert.ok(at > 0, 'the same node is live in the second fixture');
    deeper.entry.port.updateState({ cache: { kind: 'warm', watermarkNodeIndex: at + 1 } });
    const outcome = await deeper.mount.runPrune(deeper.session);
    assert.equal(outcome?.application?.removals.length, 1, 'the same removal is planned');
    const applied = deeper.records.records.find(record => record['kind'] === 'prune-apply');
    assert.equal(applied?.['status'], 'rejected', 'one node deeper the fence refuses');
    const issues = applied?.['issues'] as readonly { code?: string }[];
    assert.deepEqual(issues.map(issue => issue.code), ['cut-below-watermark'],
      'and speaks the fence\'s own code');
    // ISSUE-462: the visible card names the rejected apply, never "settled".
    const done = deeper.session.log.find(event => event.type === 'command/done');
    const doneData = done?.data as { kind?: string; text?: string } | undefined;
    assert.equal(doneData?.kind, 'error', 'a rejected apply does not settle success');
    assert.match(doneData?.text ?? '', /rejected/u, 'the text names the apply status');
    assert.match(doneData?.text ?? '', /cut-below-watermark/u, 'and the guard code');
    assert.equal(deeper.session.log.filter(event => event.surfaceOp !== undefined
      && event.surfaceOp !== 'append').length, 0, 'nothing moved on the host surface');
  } finally {
    await deeper.mount.close();
  }
});

test('ISSUE-470: a stale main-wire capture refuses the prune seed by name', async () => {
  const env = await mounted({ id: 's-prune-seed-stale', window: 1_000_000,
    answer: '{"1":{"forgetall":true,"summary":"an old read"}}' });
  try {
    // Captured under the opening route; the pass now runs under another model.
    env.session.setRoute({ provider: 'a6', model: 'gpt-6-astra' });
    const outcome = await env.mount.runPrune(env.session);
    assert.equal(env.llm?.calls.length, 0, 'no request left the seam');
    assert.equal(outcome?.refusedFor, 'seed-model-stale', 'the pass refuses by name');
    const stale = env.records.records.filter(record => record['kind'] === 'seed-model-stale');
    assert.equal(stale.length, 1, 'one named refusal line');
    assert.equal(stale[0]?.['seedModel'], 'prune-model', 'the capture route is named');
    assert.equal(stale[0]?.['routeModel'], 'gpt-6-astra', 'the live route is named');
    assert.equal(env.records.records.filter(record => record['kind'] === 'prune-seed').length, 0,
      'the stale capture never seeded a fork');
  } finally {
    await env.mount.close();
  }
});

test('the pre-first-usage fallback estimate counts the captured system+tools prefix', async () => {
  // ADR-0009 §Amendment 2026-10-24: the context window prices the whole
  // request, so the fallback reading is the captured system+tools prefix plus
  // the live transcript. Here the transcript alone stays under the 500-token
  // line and the prefix is what carries the session over it, so a
  // transcript-only estimate would never fire. Since ISSUE-092 this reading is
  // the fallback only: once a usage row exists the bar reads the host's own
  // billed prompt (pinned in `prune-apply.test.ts`). The 1,000-token window
  // puts the 75% skip line at 750, above this fixture's ~623-token reading.
  const BIG_SYSTEM = 'S'.repeat(2000);
  const env = await mounted({ id: 's-trigger-prefix', window: 1_000, mainSystem: BIG_SYSTEM,
    answer: '{"1":{"keepall":true}}' });
  try {
    // The captured prefix is measured as the canonical bytes of the same
    // `system` and `tools` fields main dispatched.
    const prefixTokens = Math.ceil(canonicalManifestBytes({
      system: BIG_SYSTEM, tools: HOST_MAIN.tools }).byteLength / 4);
    // The estimate is taken after the at-rest pass and the judge but before
    // this step's receipt is appended (appendReceipts runs at runStep end), so
    // the pre-step snapshot is exactly the content the trigger reads.
    const contentTokens = (await env.entry.port.snapshot()).nodes
      .reduce((sum, node) => sum + Math.ceil(node.bytes.length / 4), 0);
    assert.ok(contentTokens < 500,
      `the transcript-only reading (${String(contentTokens)}) is below the line`);
    assert.ok(prefixTokens > 0, 'the captured request has a prefix to count');
    assert.ok(contentTokens + prefixTokens >= 500,
      'the prefix carries the whole-request reading over the line');

    await env.mount.runStep(env.session, { turn: 4, step: 1 });

    const threshold = env.records.records.find(record => record['kind'] === 'prune-threshold');
    assert.ok(threshold !== undefined, 'the crossing is journaled');
    assert.equal(threshold['estimatedTokens'], contentTokens + prefixTokens,
      'the estimate is the whole request');
    assert.equal(threshold['contentTokens'], contentTokens,
      'the transcript share is reported on its own field');
    assert.equal(threshold['prefixTokens'], prefixTokens,
      'and the captured system+tools share is its own field');
    assert.equal(threshold['estimate'], 'content+prefix',
      'the line names the denominator it used');
    assert.equal(threshold['barReading'], 'local-estimate',
      'no usage row yet, so the bar took the fallback estimate');
    assert.equal(threshold['billedPromptTokens'], null,
      'and there is no host reading to report');
    assert.equal(threshold['threshold'], 500);
    assert.equal(env.records.records.filter(record => record['kind'] === 'prune-recorded').length,
      1, 'the crossing scheduled exactly one pass');
  } finally {
    await env.mount.close();
  }

  // CONTROL: the same transcript with no captured main request has no prefix to
  // count. The reading stays transcript-only, below the line, and nothing fires.
  const control = await mounted({ id: 's-trigger-no-prefix', window: 400, capture: false,
    answer: '{"1":{"keepall":true}}' });
  try {
    await control.mount.runStep(control.session, { turn: 4, step: 1 });
    const evaluated = control.records.records.filter(record => record['kind'] === 'prune-threshold');
    assert.equal(evaluated.length, 1, 'a below-the-line boundary still journals its evaluation');
    assert.equal(evaluated[0]?.['crossed'], false, 'and it is not a crossing');
    assert.equal(evaluated[0]?.['barReading'], 'local-estimate',
      'the fallback source is named even though nothing fired');
    assert.equal(control.records.records.some(record => record['kind'] === 'prune-recorded'),
      false, 'and schedules no pass');
  } finally {
    await control.mount.close();
  }
});

test('a command step still observes the latch, and one step runs one pass', async () => {
  // CRITIC-022 P2 #5: the old `else if` skipped the observation on a step that
  // carried a `/cremate`, so that step's reading never reached the latch. The
  // crossing must be journaled here too (the manual pass then consumes it).
  const env = await mounted({ id: 's-command-observe', window: 300,
    answer: '{"1":{"keepall":true}}' });
  try {
    // A `/cremate` user message, observed the way the host delivers it.
    env.session.append('user/message', { content: [{ type: 'text', text: '/cremate' }],
      source: { kind: 'user' }, role: 'user', id: 'user-prune' }, { surfaceOp: 'append' });
    env.mount.observe(env.session, env.session.log.at(-1)!);
    await env.mount.runStep(env.session, { turn: 4, step: 1 });
    const threshold = env.records.records.filter(record => record['kind'] === 'prune-threshold');
    assert.equal(threshold.length, 1, 'the command step observed the latch and crossed');
    assert.equal(threshold[0]?.['crossed'], true, 'and the answer was a fire');
    assert.equal(env.records.records.filter(record => record['kind'] === 'prune-recorded').length,
      1, 'the command and the crossing share ONE pass, never two');
    // The pass's finally re-armed the latch; its first post-removal reading is
    // the new baseline, so the next step does not re-fire on the same content.
    await env.mount.runStep(env.session, { turn: 4, step: 2 });
    assert.equal(env.records.records.filter(record => record['kind'] === 'prune-recorded').length,
      1, 'a consumed crossing never re-fires');
  } finally {
    await env.mount.close();
  }
});

test('a manual pass with a removal and no window records, and names no-window', async () => {
  // CRITIC-022 P2 #7: the previous no-window test only ran a step and asserted
  // no pass fired, so the `no-window` branch in the apply leg was never reached
  // — a vacuous pin. Here the pass really produces a removal and the mount has
  // no window, which is the exact state the branch exists for: record-only is
  // the rollout's first stage, so nothing is sent to the engine and the skip
  // says why.
  const env = await mounted({ id: 's-no-window-removal',
    answer: '{"2":{"forgetall":true,"summary":"an old read"}}' });
  try {
    const outcome = await env.mount.runPrune(env.session);
    assert.equal(outcome?.application?.removals.length, 1, 'the pass did produce a removal');
    assert.equal(env.records.records.some(record => record['kind'] === 'prune-apply'), false,
      'with no window the pass is not handed to the engine');
    const skipped = env.records.records.find(record => record['kind'] === 'prune-apply-skipped');
    assert.equal(skipped?.['reason'], 'no-window', 'and the line names the known state');
    assert.equal(env.session.log.filter(event => event.surfaceOp !== undefined
      && event.surfaceOp !== 'append').length, 0, 'nothing moved on the host surface');
  } finally {
    await env.mount.close();
  }
});

test('a pass whose answers remove nothing sends no engine event at all', async () => {
  const env = await mounted({ id: 's-no-removals', window: 1_000_000,
    answer: '{"1":{"keepall":true},"2":{"keepall":true},"3":{"keepall":true}}' });
  try {
    const outcome = await env.mount.runPrune(env.session);
    assert.equal(outcome?.application?.removals.length, 0, 'every answer kept');
    assert.equal(env.records.records.some(record => record['kind'] === 'prune-apply'), false,
      'an empty document is not sent to the engine');
    const skipped = env.records.records.find(record => record['kind'] === 'prune-apply-skipped');
    assert.equal(skipped?.['reason'], 'no-removals');
  } finally {
    await env.mount.close();
  }
});

test('a pass that never asked names no-application, not no-removals', async () => {
  // CRITIC-022 P3 #9: an unasked pass has no document at all. Sharing the
  // `no-removals` code made the journal say the judge kept everything when in
  // fact nothing was ever asked.
  const env = await mounted({ id: 's-no-application', window: 1_000_000 });
  try {
    const outcome = await env.mount.runPrune(env.session);
    assert.equal(outcome?.application, null, 'no model seam: no document');
    const skipped = env.records.records.find(record => record['kind'] === 'prune-apply-skipped');
    assert.equal(skipped?.['reason'], 'no-application',
      'the line separates an unasked pass from an all-keep pass');
  } finally {
    await env.mount.close();
  }
});

test('a failed round write journals prune-round-error and loses only durability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-prune-unwritable-'));
  try {
    const { writeFileSync } = await import('node:fs');
    // A FILE where the session directory must be: `mkdirSync` cannot create it,
    // so the write fails the way a permission or read-only-volume failure does.
    const blocker = join(root, 'blocked');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const target = { databasePath: join(blocker, 'ledger.sqlite'),
      blobRoot: join(blocker, 'blobs') };
    const { writePruneRound, readPruneRound } = await import('../src/prune-round-store.js');
    const journaled: { kind: string; [field: string]: unknown }[] = [];
    assert.equal(writePruneRound(target, 4,
      (kind, fields) => { journaled.push({ kind, ...fields }); }, 's-unwritable'), false,
    'the caller learns the round is not durable');
    const failed = journaled.find(record => record['kind'] === 'prune-round-error');
    assert.ok(failed !== undefined, 'the failure is named, not swallowed');
    assert.equal(failed['round'], 4);
    assert.equal(typeof failed['message'], 'string');
    assert.equal(readPruneRound(target), 0, 'nothing was persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the event id is content-derived, so a repeated round is a different event', () => {
  // CRITIC-022 P2 #6: a corrupt round file reads as 0 and a failed write leaves
  // the old ordinal on disk, so a restarted process re-uses a round. An id made
  // of the round alone would make the engine treat that new pass as a replay of
  // the old one and report the prior intent id while applying nothing.
  const doc = (unitId: string): Parameters<typeof pruneEventId>[2] => ({
    removals: [{ unitId, origin: 'l2', action: 'forgetall', summary: 'old', answeredInRound: 1 }],
    kept: [], refused: [], rejected: [],
  });
  const first = pruneEventId('s', 1, doc('u-1'));
  assert.equal(pruneEventId('s', 1, doc('u-1')), first, 'identical content is one event');
  assert.notEqual(pruneEventId('s', 1, doc('u-2')), first,
    'the same round over a different document is a new event');
  assert.notEqual(pruneEventId('s', 2, doc('u-1')), first, 'and so is a new round');
  assert.match(first, /^dsh:s:prune:1:[0-9a-f]{64}$/u,
    'the session and round stay legible; the digest is the identity');
});

// --- 8. the absolute bar (ADR-0050 decision 1–2) ----------------------------

test('an explicit prune bar fires at 60,000 on a 400,000 window, not at the half',
  () => {
    // The product's test value (ADR-0050 decision 2): an absolute bar wins over
    // the window, so the retired 200,000 half never decides a crossing.
    const trigger = new PruneWindowTrigger(400_000, 60_000);
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.threshold, 60_000);
    assert.equal(trigger.observe(30_000), false, 'below the bar is an excursion only');
    assert.equal(trigger.observe(59_999), false, 'one token under the bar does not fire');
    assert.equal(trigger.observe(60_000), true, 'the explicit bar fires at 60,000');
  });

test('after a fire at the bar, the next fire needs one bar of growth', () => {
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(60_000), true);
  assert.equal(trigger.observe(100_000), false, '40,000 of growth is under one bar');
  assert.equal(trigger.observe(119_999), false, 'one token under the re-arm delta');
  assert.equal(trigger.observe(120_000), true, 'one bar of growth re-fires');
});

test('after a pass, the next fire is one bar above the post-removal reading', () => {
  // ADR-0050 Amendment 2026-11-18: a pass at 254,000 that removes 40,000
  // leaves 214,000, so the next fire is at 274,000 — not at 314,000.
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(254_000), true, 'the pre-pass reading fires');
  trigger.notePassCompleted();
  assert.equal(trigger.observe(214_000), false,
    'the post-removal reading only becomes the baseline, even though it is above the bar');
  assert.equal(trigger.observe(273_999), false, 'one token under the corrected bar');
  assert.equal(trigger.observe(274_000), true,
    'one bar of NEW growth above what the pass left re-fires');
});

test('the pass baseline is not the pre-pass reading when nothing was removed', () => {
  // A refused or failed pass leaves the surface where it was; the same
  // post-removal rule then makes the next reading the baseline, so the next
  // fire still needs a full bar of new growth rather than re-firing at once.
  // The readings stay below the 75% skip line (300,000 on this window).
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(200_000), true);
  trigger.notePassCompleted();
  assert.equal(trigger.observe(200_000), false, 'the unchanged reading is the new baseline');
  assert.equal(trigger.observe(259_999), false, 'one token short of one bar of growth');
  assert.equal(trigger.observe(260_000), true);
});

test('a compaction clears a pending pass baseline and keeps the immediate backstop', () => {
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(254_000), true);
  trigger.notePassCompleted();
  trigger.noteNativeCompaction();
  assert.equal(trigger.observe(214_000), true,
    'the host rewrite re-arms a fresh latch; the next above-bar observation fires');
});

test('the automatic ask is skipped at or above 75% of the host window', () => {
  // ADR-0050 Amendment 2026-11-18 (second): at 300,000 on a 400,000 window the
  // host's compaction is imminent, so the ask would buy a few turns and cost one.
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.skipThreshold, 300_000);
  assert.equal(trigger.observe(299_999), true, 'just under the line is a normal fire');
  assert.equal(trigger.observe(300_000), false, 'the skip line itself never fires');
  assert.equal(trigger.observe(319_999), false, 'nor does a deeper reading');
  assert.equal(new PruneWindowTrigger(200_000, 60_000).skipThreshold, 150_000,
    'the 200k window skips at 150,000');
  assert.equal(new PruneWindowTrigger(null, 60_000).skipThreshold, null,
    'no window means no skip guard');
});

test('a fractional 75% line is the first integer at or above it', () => {
  // ISSUE-300 audit bug 8: 333,333 × 0.75 = 249,999.75. A fractional line
  // cannot be journalled as a token count; the bench's safe-integer reader
  // records it as null and loses the skip. The ceiling is 250,000: 249,999 is
  // still a normal crossing, 250,000 is the skip line.
  const under = new PruneWindowTrigger(333_333, 60_000);
  assert.equal(under.skipThreshold, 250_000,
    'the skip line is the ceiling, not the fractional 249,999.75');
  assert.equal(under.observe(249_999), true, 'one token under the line still fires');
  const at = new PruneWindowTrigger(333_333, 60_000);
  assert.equal(at.skipThreshold, 250_000);
  assert.equal(at.observe(250_000), false, 'the line itself never fires');
});

test('a skipped reading keeps the latch; compaction then re-arms a fresh trigger', () => {
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(150_000), true, 'the first crossing fires');
  trigger.notePassCompleted();
  assert.equal(trigger.observe(310_000), false, 'the post-pass reading above 75% is skipped');
  assert.equal(trigger.observe(319_999), false, 'still skipped before the host compaction');
  trigger.noteNativeCompaction();
  assert.equal(trigger.observe(100_000), true,
    'after compaction the fresh latch fires on the first above-bar reading');
});

test('an observation below the bar re-arms the next crossing', () => {
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(60_000), true);
  assert.equal(trigger.observe(59_999), false, 'the excursion alone never fires');
  assert.equal(trigger.observe(60_000), true, 'the next crossing fires without a full bar');
});

test('a bad prune bar is refused by name, in the trigger and in the config', () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => new PruneWindowTrigger(400_000, bad), /pruneThresholdTokens/u,
      `the latch refuses ${String(bad)}`);
    assert.throws(() => resolvePluginConfig({ pruneThresholdTokens: bad }), /pruneThresholdTokens/u,
      `the config refuses ${String(bad)}`);
  }
});

test('the window-only compatibility path still fires at half the window', () => {
  // ADR-0050 decision 2: an old launch row with only a window keeps the old
  // arithmetic, byte for byte. No window and no explicit bar stays off.
  const windowOnly = new PruneWindowTrigger(400_000);
  assert.equal(windowOnly.enabled, true, 'a window alone still arms the latch');
  assert.equal(windowOnly.threshold, 200_000, 'the deprecated bar is the window half');
  assert.equal(windowOnly.observe(199_999), false);
  assert.equal(windowOnly.observe(200_000), true, 'half the window fires as before');
  const disabled = new PruneWindowTrigger(null);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.threshold, null);
  assert.equal(disabled.observe(1_000_000), false, 'nothing is armed without a bar');
  const barOnly = new PruneWindowTrigger(null, 60_000);
  assert.equal(barOnly.enabled, true, 'an explicit bar arms with no window at all');
  assert.equal(barOnly.threshold, 60_000);
  assert.equal(barOnly.observe(60_000), true);
});
