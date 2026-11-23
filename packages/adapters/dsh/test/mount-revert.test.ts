/**
 * The mount's revert seam (ISSUE-024 chunk 1).
 *
 * `revertSessionFromHost` is the only place the shipped mount turns a live dsh
 * session into the adapter's shadow-replace seam, and the capability flag the
 * engine reads is derived from it. Two claims must hold, and both are tested
 * here against the real engine/adapter/port, not a stand-in:
 *
 *   1. a session that can honour the seam yields it, and the mount declares
 *      `revertHistory: true` — proven by driving the derived seam through
 *      `applyValidatedRevert` and reading the host's spliced surface back;
 *   2. a session that cannot yields `null`, and the mount declares
 *      `revertHistory: false`; the engine then records a prune pass and applies
 *      nothing (`unsupported-capability`), so a removal is reported even where
 *      no receipt can be produced.
 *
 * The rebased checkpoint-revert proof drives the BULK PRUNE — ADR-0028's
 * surviving bulk ask — through the real mount, engine, adapter, port and
 * ledger: one pass, one `{kind:'prune'}` event, one shadow-replace.
 *
 * The node identities the seam emits are pinned against `surfaceTranscript`:
 * the port refuses a host surface that disagrees with the transcript it holds,
 * so a drift between the two id formulas would silently disable every apply.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyRequest, ValidatedRevert } from '@cremator/core';
import { revertBytes, sha256Sync } from '@cremator/core';
import { createDshCapabilities } from '../src/capabilities.js';
import { createMainWireCapture } from '../src/main-wire.js';
import { revertSessionFromHost } from '../src/mount-revert.js';
import type { DshMountEvent, DshMountSession } from '../src/plugin.js';
import {
  createRacoonsMount, resolvePluginConfig, resolveStorage, surfaceTranscript,
} from '../src/plugin.js';
import { createDshPort } from '../src/port.js';
import { revertPlanSha256 } from '../src/revert.js';

/** The route both surviving asks read (ADR-0028): the entry ask and the prune. */
const ROUTE = { provider: 'p', model: 'm' };

/** The fake host: an append-only log with surface markers, as `plugin.test.ts` builds. */
function fakeSession(id = 'session-mount-revert'): DshMountSession & {
  readonly log: DshMountEvent[];
  push(type: string, data: unknown, surfaceOp?: unknown, sourceEventSeqs?: readonly number[]): DshMountEvent;
} {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const session = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    push(type: string, data: unknown, surfaceOp?: unknown,
      sourceEventSeqs?: readonly number[]): DshMountEvent {
      const seq = log.length;
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error(`surface replace: seq out of surface (${String(op.startSeq)}..${String(op.endSeq)})`);
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs: Object.freeze([...sourceEventSeqs]) } });
      log.push(event);
      return event;
    },
    append(type: string, data: unknown, options: Record<string, unknown> = {}): DshMountEvent {
      return session.push(type, data, options['surfaceOp'],
        options['sourceEventSeqs'] as readonly number[] | undefined);
    },
  };
  return session;
}

const text = (value: string): { type: string; text: string } => ({ type: 'text', text: value });

/** One scripted turn: system head, user task, assistant call, oversized result. */
function seedTurn(session: ReturnType<typeof fakeSession>, body: string, callId = 'call-1'): void {
  session.push('turn/start', { turn: 1 });
  session.push('step/start', { turn: 1, step: 1 });
  session.push('system/message', { turn: 1, step: 1,
    message: { role: 'system', content: [text('system prompt')], source: { kind: 'system-prompt' },
      id: 'sys-1' } }, 'append');
  session.push('user/message', { content: [text('read big.ts')], source: { kind: 'user' },
    role: 'user', id: 'user-1' }, 'append');
  const callSeq = session.push('tool/call', { turn: 1, step: 1, callId,
    name: 'read', arguments: '{"file_path":"big.ts"}' }).seq;
  session.push('assistant/message', { turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [text('reading'), { type: 'tool-call', id: callId, name: 'read',
        arguments: '{"file_path":"big.ts"}' }], id: `asst-${callId}` } }, 'append');
  session.push('tool/result', { turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [text(body)], isError: false, id: `result-${callId}` } },
  'append', [callSeq]);
  session.push('step/end', { turn: 1, step: 1 });
}

const OVERSIZED = `${'x'.repeat(63)}\n`.repeat(700);

// --- branch 1: the seam exists ----------------------------------------------



// --- branch 2: no seam, no false capability ---------------------------------



// --- the one prune an apply needs (ADR-0028: the two surviving asks) --------

/** One journal collector, the same sink shape `createRacoonsMount` takes. */
function journalCollector(): { records: { kind: string; [field: string]: unknown }[];
  sink: (record: { kind: string; [field: string]: unknown }) => void } {
  const records: { kind: string; [field: string]: unknown }[] = [];
  return { records, sink: record => { records.push(record); } };
}

/** A model seam that answers every prune table with one whole-unit forget. */
function forgetLlm(answer = '{"1":{"forgetall":true,"summary":"big read"}}'): {
  readonly calls: readonly unknown[];
  stream(options: never): AsyncIterable<{ type: string; [field: string]: unknown }>;
} {
  const calls: unknown[] = [];
  return {
    calls,
    stream(options: never) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: answer };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}



const RECEIPT_TEXT = '[not retained] big.ts · necromancy recall:sha256:aa';

/** Seals a plan the way the guard does, so the port's digest check passes. */
function sealedPlan(plan: Omit<ValidatedRevert, 'planSha256'>): ValidatedRevert {
  return { ...plan, planSha256: revertPlanSha256({ ...plan, planSha256: '' } as ValidatedRevert) };
}

function revertRequest(plan: ValidatedRevert, baseRevision: string): ApplyRequest {
  const body = new TextEncoder().encode(RECEIPT_TEXT);
  const application = {
    sessionId: 'session-with-seam', eventId: 'verdict-event', baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: 'application-1', replacements: [],
    appendRecords: [{ recordId: 'racoons:receipt-1', bytes: body, sha256: sha256Sync(body) }],
    archives: [], sealedEpisodeIds: [], createdAtMs: 1234, revert: plan,
  } as unknown as ApplyRequest['application'];
  return { application, intent: { intentId: 'intent-1', sessionId: 'session-with-seam',
    eventId: 'verdict-event', baseRevision, applicationSha256: 'application-1' } };
}

test('a live session yields the seam, and the mount declares revertHistory true', async () => {
  const session = fakeSession('session-with-seam');
  seedTurn(session, OVERSIZED);
  const seam = revertSessionFromHost(session);
  assert.ok(seam !== null, 'a session with append/eventAt/seq/surface supplies the seam');
  assert.equal(seam.nextSeq(), session.seq);
  const surface = seam.surface();
  assert.deepEqual(surface.map(node => node.seq), [...(session.surface?.nodes ?? [])]);
  // The ids are the port's own transcript identities, not a second vocabulary.
  const projected = surfaceTranscript(session, { sessionId: session.id });
  assert.deepEqual(surface.map(node => node.id), projected.items.map(item => item.id),
    'the seam and surfaceTranscript must name the same nodes or the port refuses every apply');

  const mount = createRacoonsMount({ config: resolvePluginConfig({ capBytes: 8192, capHeadBytes: 2048 }),
    storage: resolveStorage(undefined), journal: () => {} });
  try {
    const entry = await mount.sessionFor(session.id, session);
    assert.equal(entry.adapter.capabilities.revertHistory, true,
      'the mount declares the capability its seam can honour');
    assert.equal(entry.adapter.capabilities.rewriteHistory, false,
      'a shadow-replace append is not an in-place rewrite');
  } finally {
    await mount.close();
  }
});

test('a session that cannot honour the seam yields none, and the flag stays false', async () => {
  const incomplete = [
    // No eventAt: the surface could only be guessed.
    { id: 'no-event-at', seq: 1, surface: { nodes: [] },
      append: () => ({ seq: 0 }) },
    // No seq: every span bound would be a guess.
    { id: 'no-seq', surface: { nodes: [] }, eventAt: () => undefined,
      append: () => ({ seq: 0 }) },
    // No surface: nothing to replace over.
    { id: 'no-surface', seq: 1, eventAt: () => undefined, append: () => ({ seq: 0 }) },
    // No append: the one primitive is missing.
    { id: 'no-append', seq: 1, surface: { nodes: [] }, eventAt: () => undefined },
  ];
  for (const value of incomplete) {
    assert.equal(revertSessionFromHost(value as unknown as DshMountSession), null,
      `${value.id} must not yield a seam`);
  }
  assert.equal(revertSessionFromHost(undefined), null);

  const mount = createRacoonsMount({ config: resolvePluginConfig({}), storage: resolveStorage(undefined),
    journal: () => {} });
  try {
    // No host passed: the offline/placeholder branch a test or a probe mount uses.
    const entry = await mount.sessionFor('session-offline');
    assert.equal(entry.adapter.capabilities.revertHistory, false,
      'no host session, no declared capability');
  } finally {
    await mount.close();
  }
});

test('with a seam and an unknown cache, a prune pass applies and seals a receipt (ADR-0012)', async () => {
  // ADR-0028 leaves the bulk prune as the mount's only bulk ask, so the
  // checkpoint-revert proof lives here: one pass, one engine event, one
  // shadow-replace, and the bank restores what the pass removed. No watermark
  // is ever stated — exactly the state the mount ships in — and under ADR-0012
  // an unknown cache carries no fence.
  const session = fakeSession('session-settled');
  seedTurn(session, OVERSIZED);
  session.push('turn/end', { turn: 1 });
  const { records, sink } = journalCollector();
  const llm = forgetLlm();
  const mainWire = createMainWireCapture();
  mainWire.note({ sessionId: session.id,
    system: 'MAIN SYSTEM PROMPT',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.ts' }] }] });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ barBytes: 64, contextWindowTokens: 200_000 }),
    storage: resolveStorage(undefined), journal: sink, mainWire, judgeRoute: ROUTE,
    llm: llm as never });
  try {
    const entry = await mount.sessionFor(session.id, session);
    assert.equal(entry.adapter.capabilities.revertHistory, true);
    for (const event of session.log) mount.observe(session, event);
    const outcome = await mount.runPrune(session);
    assert.ok(outcome !== null, 'the pass ran');
    assert.equal(outcome.application?.removals.length, 1, 'the pass decided one removal');
    const applied = records.find(record => record['kind'] === 'prune-apply');
    assert.equal(applied?.['status'], 'applied', 'the pass reached the host');
    // The engine journaled the applied revert: the bank restores what was cut.
    const telemetry = records.filter(record => record['kind'] === 'telemetry')
      .map(record => record['event'] as { kind?: string });
    assert.ok(telemetry.some(event => event.kind === 'revert-applied'),
      'the apply is journaled by name');
    assert.ok(records.some(record => record['kind'] === 'prune-recorded'),
      'the pass wrote its one record');
    const surfaced = surfaceTranscript(session, { sessionId: session.id });
    // A whole-unit forget of a tool result keeps the node's type and call
    // pairing, so the receipt arrives as that result's new content.
    const receipt = surfaced.items.find(item => item.role === 'tool'
      && new TextDecoder().decode(item.bytes).startsWith('[not retained]'));
    assert.ok(receipt !== undefined, 'the receipt is on the model-visible surface');
    // The console byte budget, not the console: the unit's own bytes are gone.
    assert.equal(surfaced.items.filter(item => item.role === 'tool'
      && new TextDecoder().decode(item.bytes) === OVERSIZED).length, 0);
  } finally {
    await mount.close();
  }
});

test('the port applies a revert through the derived seam: one append, prefix intact', async () => {
  const session = fakeSession('session-with-seam');
  seedTurn(session, 'giant body');
  const seam = revertSessionFromHost(session);
  assert.ok(seam !== null);
  const projected = surfaceTranscript(session, { sessionId: session.id });
  const port = createDshPort({ sessionId: 'session-with-seam', clock: { nowMs: () => 100 },
    transcript: projected.items, revert: seam });
  const before = await port.snapshot();
  const statement = sealedPlan({ unitIds: ['unit:sha256:one'], cutIndex: 3, survivors: [],
    appends: [{ afterNodeId: 'dsh:session-with-seam:message:5', noteId: 'racoons:receipt-1' }],
    perNode: [{ nodeId: 'dsh:session-with-seam:result:call-1', noteId: 'racoons:receipt-1' }],
    cost: { cutIndex: 3, freedBytes: 10, keptBytes: 0,
      receiptBytes: RECEIPT_TEXT.length, netFreedBytes: 10 - RECEIPT_TEXT.length },
    baseRevision: before.revision });
  const result = await port.apply(revertRequest(statement, before.revision));
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const surfaced = seam.surface();
  assert.equal(surfaced.length, 4, 'the replacement took the shadowed node\'s place');
  assert.equal(surfaced.at(-1)?.blocks.map(block => block.text).join(''), RECEIPT_TEXT,
    'the receipt is what the model now reads at that position');
  // The prefix the plan promised to keep still carries the host's own payload.
  const hostSeqs = surfaced.slice(0, 3).map(node => node.seq);
  assert.deepEqual(hostSeqs, [2, 3, 5], 'the prefix keeps its original event seqs');
  for (const node of surfaced.slice(0, 3)) {
    assert.deepEqual(node.data, session.log[node.seq]?.data, `seq ${String(node.seq)} was not rewritten`);
  }
});

test('the derived seam appends exactly one shadow-replace over the surface', () => {
  const session = fakeSession('session-append-shape');
  seedTurn(session, 'giant body', 'call-1');
  const seam = revertSessionFromHost(session);
  assert.ok(seam !== null);
  const surface = seam.surface();
  const target = surface.find(node => node.type === 'tool/result');
  assert.ok(target !== undefined);
  const nextSeq = seam.nextSeq();
  const { seq } = seam.append('tool/result',
    { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1', content: [text('[not retained] big.ts · necromancy recall:sha256:aa')] } },
    { surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
      sourceEventSeqs: [target.seq] });
  assert.equal(seq, nextSeq, 'the append takes the next host seq');
  const appended = session.log[seq];
  assert.deepEqual(appended?.surfaceOp, { op: 'replace', startSeq: target.seq, endSeq: target.seq });
  assert.deepEqual([...(appended?.sourceEventSeqs ?? [])], [target.seq]);
  // The host spliced the surface: the replaced node is gone, the new one is in.
  const nodes = [...(session.surface?.nodes ?? [])];
  assert.equal(nodes.includes(target.seq), false);
  assert.equal(nodes.includes(seq), true);
});

test('without a seam a prune pass records its answers and applies nothing', async () => {
  const session = fakeSession('session-no-seam');
  seedTurn(session, OVERSIZED);
  session.push('turn/end', { turn: 1 });
  const { records, sink } = journalCollector();
  const llm = forgetLlm();
  const mainWire = createMainWireCapture();
  mainWire.note({ sessionId: session.id,
    system: 'MAIN SYSTEM PROMPT',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read big.ts' }] }] });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ barBytes: 64, capBytes: 1 << 20, contextWindowTokens: 200_000 }),
    storage: resolveStorage(undefined), journal: sink, mainWire, judgeRoute: ROUTE,
    llm: llm as never });
  try {
    // No host: the offline branch. The flag is false by construction.
    const entry = await mount.sessionFor(session.id);
    assert.equal(entry.adapter.capabilities.revertHistory, false);
    for (const event of session.log) mount.observe(session, event);
    const outcome = await mount.runPrune(session);
    assert.ok(outcome !== null, 'the pass still ran and asked');
    assert.equal(outcome.application?.removals.length, 1, 'the pass decided one removal');
    // No seam: nothing applies, the session keeps running.
    const applied = records.find(record => record['kind'] === 'prune-apply');
    assert.equal(applied?.['status'], 'unchanged', 'no seam, no application');
    // The answers are still recorded, by name, and the refusal is loud.
    assert.ok(records.some(record => record['kind'] === 'prune-recorded'),
      'the answer survives as the pass record');
    const skipped = records.filter(record => record['kind'] === 'telemetry')
      .map(record => record['event'] as { kind?: string; reason?: string })
      .filter(event => event.kind === 'skip');
    assert.ok(skipped.some(event => event.reason === 'unsupported-capability'),
      'the refusal is a named skip, never silence');
    assert.equal(session.log.filter(event => event.type === 'tool/result'
      && typeof event.surfaceOp === 'object').length, 0, 'no replacement was published');
  } finally {
    await mount.close();
  }
});
