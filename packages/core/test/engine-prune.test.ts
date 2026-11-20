import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import { salvageShare } from '../src/engine/telemetry.js';
import type { EngineOptions } from '../src/engine/types.js';
import type { ValidatedRevert } from '../src/guard/types.js';
import { Meter } from '../src/meter/meter.js';
import { applyPruneAnswers } from '../src/prune/pass-answers.js';
import { planPrunePass } from '../src/prune/pass.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import type { SessionSnapshot, ToolResultNode, TranscriptNode } from '../src/types/transcript.js';
import { UnitTracker } from '../src/units/tracker.js';
import { sha256, sha256Sync } from '../src/util/hash.js';
import { TestLedger, TestPort } from './engine-fixtures.js';

type Application = Extract<TelemetryEvent, { kind: 'application' }>;
type Reverted = Extract<TelemetryEvent, { kind: 'revert-applied' }>;

const applications = (events: readonly TelemetryEvent[]): Application[] =>
  events.filter((event): event is Application => event.kind === 'application');
const revertedEvents = (events: readonly TelemetryEvent[]): Reverted[] =>
  events.filter((event): event is Reverted => event.kind === 'revert-applied');

function collector(): { events: TelemetryEvent[]; sink: (event: TelemetryEvent) => void } {
  const events: TelemetryEvent[] = [];
  return { events, sink: event => events.push(event) };
}

/** The revert payload of every application the host accepted. */
function acceptedReverts(port: { readonly requests: readonly {
  readonly application: { readonly revert?: ValidatedRevert } }[] }): ValidatedRevert[] {
  return port.requests.flatMap(request =>
    request.application.revert === undefined ? [] : [request.application.revert]);
}

function nodeCount(live: { readonly nodes: readonly { readonly id: string }[] }, id: string): number {
  return live.nodes.filter(node => node.id === id).length;
}

const CAPABILITIES = { mutateResult: true, rewriteHistory: false, atRest: true,
  liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false,
  revertHistory: true } as const;

const OPTIONS_BASE = {
  clock: { nowMs: () => 100 },
  meter: new Meter({ estimate: content => content.length }),
  rules: [],
  capabilities: CAPABILITIES,
  config: {
    thresholds: { capBytes: 1024 * 1024, capHeadBytes: null, episodeNoNewPathSteps: null,
      sealMaxLatencyTurns: 1 },
    freshZone: { maxNodes: null, maxBytes: null }, sealMode: 'append' as const,
    validationFailureLimit: 2,
    protocol: { barBytes: 8, minCutFreedBytes: 4096 },
  },
} as const;

const snapshotOf = (nodes: readonly TranscriptNode[], currentStepOrdinal: number): SessionSnapshot => ({
  sessionId: 'session-1', revision: 'revision-1', currentTurnOrdinal: 2,
  completedThroughTurnOrdinal: 1, currentStepOrdinal,
  nodes, cache: { kind: 'warm', watermarkNodeIndex: 0 }, retentionEvidence: [],
});

/**
 * A settled session of 20 above-bar tool results, one unit each (the bar is 8
 * bytes and every body is longer). Nothing is protected and every call is
 * answered: the snapshot is exactly what a prune pass reviews.
 */
async function pruneFixture(count = 20) {
  const messageBytes = new TextEncoder().encode('Read many files');
  const callIds = Array.from({ length: count }, (_, index) => `call-${String(index + 1)}`);
  const nodes: TranscriptNode[] = [{
    kind: 'message', id: 'assistant-1', role: 'assistant', toolCallIds: callIds,
    turnOrdinal: 1, stepOrdinal: 0, bytes: messageBytes,
    sha256: await sha256(messageBytes), byteLength: messageBytes.length,
  }];
  const results: ToolResultNode[] = [];
  for (let index = 1; index <= count; index += 1) {
    const bytes = new TextEncoder().encode(
      `src/file-${String(index)}.ts body for the prune test ${String(index)}\n`.repeat(2),
    );
    const hash = await sha256(bytes);
    const node: ToolResultNode = {
      kind: 'tool-result', id: `result-${String(index)}`, turnOrdinal: 1,
      stepOrdinal: index, bytes, sha256: hash, byteLength: bytes.length,
      callId: `call-${String(index)}`, embeddedRecords: [],
      evidence: {
        kind: 'read', target: null, source: { nodeId: `result-${String(index)}`,
          sha256: hash, byteLength: bytes.length },
        sourceRecallId: null,
        paths: [{ pathKey: `src/file-${String(index)}.ts`,
          displayPath: `src/file-${String(index)}.ts`, title: null, lineCount: 2,
          byteLength: bytes.length, outcome: 'hit' }],
      },
    };
    results.push(node);
    nodes.push(node);
  }
  const snapshot = snapshotOf(nodes, count + 1);
  const ledger = new TestLedger();
  const port = new TestPort(snapshot, results[0] as ToolResultNode);
  const options: EngineOptions = { sessionId: snapshot.sessionId, port, ledger, ...OPTIONS_BASE };
  const units = new UnitTracker({ sessionId: snapshot.sessionId, barBytes: 8 }).units(snapshot);
  return { ledger, port, options, snapshot, units, results };
}

/**
 * One pass over `f`'s units with only the first `count` ask rows forgotten and
 * every other row answered `keepall`. The answers still go through the real
 * `applyPruneAnswers`, so the pass is a genuine partial removal: the suffix
 * keeps survivors for the revert plan to re-emit.
 */
function forgetFirstRows(
  plan: ReturnType<typeof planPrunePass>, count: number,
) {
  const answer: Record<string, unknown> = {};
  for (const [offset, row] of plan.askRows.entries()) {
    answer[String(row.index)] = offset < count
      ? { forgetall: `file ${String(row.index)} result` } : { keepall: true };
  }
  const merged = applyPruneAnswers(plan, [JSON.stringify(answer)], {
    indices: plan.askRows.map(row => row.index), stamps: plan.stamps,
  });
  assert.equal(merged.removals.length, count);
  assert.equal(merged.refused.length, 0);
  assert.equal(merged.kept.length, plan.askRows.length - count);
  return merged;
}

/** The merged document of the fixture's pass with every unit forgotten. */
async function twentyRemovals(f: Awaited<ReturnType<typeof pruneFixture>>) {
  const plan = planPrunePass({
    units: f.units, nodes: f.results, episodes: [], classes: {}, round: 1,
    grammar: "3option",
  });
  // Distinct bytes and distinct targets: L1 proves nothing, so all 20 units
  // reach the ask and every removal is the judge's own answer.
  assert.equal(plan.l1.removals.length, 0);
  assert.equal(plan.askRows.length, 20);
  return forgetFirstRows(plan, plan.askRows.length);
}

/**
 * The fixture host stamps a receipt with the session's current turn and step,
 * and a revert inserts receipts ahead of earlier-turn survivors, so the
 * resulting transcript's ordinals fall out of order. A host rebuilding a
 * reverted transcript numbers it by position; the test performs that host-side
 * step explicitly, because the next pass would otherwise be refused on an
 * ordinal the revert itself produced.
 */
function renumbered(snapshot: SessionSnapshot): SessionSnapshot {
  return { ...snapshot, nodes: snapshot.nodes.map((node, index) => ({
    ...node, turnOrdinal: 1, stepOrdinal: index,
  })) };
}

/**
 * A settled session with one same-path re-read pair and one unrelated result:
 * `result-1` and `result-2` are two whole-file reads of `src/a.ts` with
 * DIFFERENT bytes, so L1 proves nothing and the superseded-read dedupe owns
 * `result-1`; `result-3` is an ordinary result the ask decides.
 */
async function dedupeFixture() {
  const messageBytes = new TextEncoder().encode('Read the file twice');
  const nodes: TranscriptNode[] = [{
    kind: 'message', id: 'assistant-1', role: 'assistant',
    toolCallIds: ['call-1', 'call-2', 'call-3'],
    turnOrdinal: 1, stepOrdinal: 0, bytes: messageBytes,
    sha256: await sha256(messageBytes), byteLength: messageBytes.length,
  }];
  const bodies = [
    { id: 'result-1', path: 'src/a.ts', text: 'export const a = 1;\n' },
    { id: 'result-2', path: 'src/a.ts', text: 'export const a = 2;\nexport const b = 3;\n' },
    { id: 'result-3', path: 'src/b.ts', text: 'src/b.ts body for the dedupe test\n'.repeat(2) },
  ];
  const results: ToolResultNode[] = [];
  for (const [index, body] of bodies.entries()) {
    const bytes = new TextEncoder().encode(body.text);
    const hash = await sha256(bytes);
    const node: ToolResultNode = {
      kind: 'tool-result', id: body.id, turnOrdinal: 1, stepOrdinal: index + 1,
      bytes, sha256: hash, byteLength: bytes.length, callId: `call-${String(index + 1)}`,
      embeddedRecords: [],
      evidence: {
        kind: 'read', target: { key: body.path, label: body.path },
        source: { nodeId: body.id, sha256: hash, byteLength: bytes.length },
        sourceRecallId: null,
        paths: [{ pathKey: body.path, displayPath: body.path, title: null, lineCount: 2,
          byteLength: bytes.length, outcome: 'hit', coverage: 'full' }],
      },
    };
    results.push(node);
    nodes.push(node);
  }
  const snapshot = snapshotOf(nodes, 4);
  const ledger = new TestLedger();
  const port = new TestPort(snapshot, results[0] as ToolResultNode);
  const options: EngineOptions = { sessionId: snapshot.sessionId, port, ledger, ...OPTIONS_BASE };
  const units = new UnitTracker({ sessionId: snapshot.sessionId, barBytes: 8 }).units(snapshot);
  return { ledger, port, options, snapshot, units, results };
}

/** The pass's merged document for `plan`, with the given answer per ask row. */
function mergeAnswers(
  plan: ReturnType<typeof planPrunePass>, answers: readonly unknown[],
): ReturnType<typeof applyPruneAnswers> {
  const text: Record<string, unknown> = {};
  plan.askRows.forEach((row, at) => { text[String(row.index)] = answers[at]; });
  return applyPruneAnswers(plan, [JSON.stringify(text)], {
    indices: plan.askRows.map(row => row.index), stamps: plan.stamps,
  });
}

/** Row-bound assertions: every failure names the case row that produced it. */
interface At {
  eq(actual: unknown, expected: unknown, detail: string): void;
  deep(actual: unknown, expected: unknown, detail: string): void;
  ok(value: unknown, detail: string): void;
}

function at(row: string): At {
  const tag = (detail: string): string => `row: ${row} — ${detail}`;
  return {
    eq: (actual, expected, detail) => { assert.equal(actual, expected, tag(detail)); },
    deep: (actual, expected, detail) => { assert.deepEqual(actual, expected, tag(detail)); },
    ok: (value, detail) => { assert.ok(value, tag(detail)); },
  };
}

test('a prune, its revert and a re-apply journal the exact survivor ids at each record', async () => {
  // The named live assertion (ISSUE-124): the journal names the ids the host
  // kept, in transcript order, not just how many it kept. Fails by name here if
  // the survivor list stops being written or stops matching the surface.
  const row = 'a prune, its revert and a re-apply journal the exact survivor ids at each record';
  const a = at(row);
  const f = await pruneFixture();
  const { events, sink } = collector();
  const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: sink });

  // Apply 1: the first five results are forgotten; results 6–20 survive.
  const plan = planPrunePass({ units: f.units, nodes: f.results, episodes: [], classes: {}, round: 1,
    grammar: "3option" });
  const first = await engine.process({ kind: 'prune', eventId: 'prune-1', round: 1,
    verdicts: forgetFirstRows(plan, 5), window: 200_000 });
  a.eq(first.status, 'applied', 'the first pass applies');
  const afterFirst = f.port.live;

  // Re-apply: the host's next snapshot, then three more results are forgotten.
  f.port.live = renumbered(f.port.live);
  const live = f.port.live;
  const units = new UnitTracker({ sessionId: live.sessionId, barBytes: 8 }).units(live);
  const results = live.nodes.filter((node): node is ToolResultNode => node.kind === 'tool-result');
  const nextPlan = planPrunePass({ units, nodes: results, episodes: [], classes: {}, round: 2,
    grammar: "3option" });
  const second = await engine.process({ kind: 'prune', eventId: 'prune-2', round: 2,
    verdicts: forgetFirstRows(nextPlan, 3), window: 200_000 });
  a.eq(second.status, 'applied', 'the re-apply applies');

  // Each applied pass left one record, and each names its survivors exactly, in
  // transcript order — the ids the host kept, not just how many it kept.
  const reverts = revertedEvents(events);
  a.eq(reverts.length, 2, 'one revert record per applied pass');
  const [firstRecord, secondRecord] = reverts;
  a.ok(firstRecord !== undefined && secondRecord !== undefined, 'both records exist');
  a.deep(firstRecord?.survivors, f.results.slice(5).map(node => node.id),
    'the first record names results 6–20');
  a.deep(secondRecord?.survivors, f.results.slice(8).map(node => node.id),
    'the second record names the surviving 12, in order');
  for (const record of reverts) {
    a.eq(record.survivorCount, record.survivors.length,
      'the count still matches the ids it journals');
  }
  // The journal matches the surface each apply left: every named survivor is
  // still the same node on the transcript, and no forgotten id is named.
  for (const id of firstRecord?.survivors ?? []) {
    a.ok(afterFirst.nodes.some(node => node.id === id), `${id} kept its nodeId`);
  }
  for (const forgotten of f.results.slice(0, 5)) {
    a.eq(firstRecord?.survivors.includes(forgotten.id), false, `${forgotten.id} was not a survivor`);
  }
  for (const id of secondRecord?.survivors ?? []) {
    a.ok(f.port.live.nodes.some(node => node.id === id), `${id} kept its nodeId`);
  }
});

interface PruneCase {
  readonly row: string;
  readonly check: (a: At) => Promise<void>;
}

/**
 * One prune outcome per row — a full removal, a replay, a new event against a
 * spent snapshot, the dedupe riding the pass, its recall, and the switch off.
 * Each row drives the real engine against the fault-free host, so a row whose
 * behaviour drifts fails on its own name.
 */
const PRUNE_CASES: readonly PruneCase[] = [
  {
    row: 'a 20-removal prune applies once, breaks the epoch once and journals 20 recall ids',
    check: async a => {
      const f = await pruneFixture();
      const { events, sink } = collector();
      const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: sink });
      const merged = await twentyRemovals(f);
      const outcome = await engine.process({
        kind: 'prune', eventId: 'prune-1', round: 1, verdicts: merged, window: 200_000,
      });
      a.eq(outcome.status, 'applied', 'the pass applies');

      // One application reached the host, and it is one checkpoint-revert of all 20.
      a.eq(f.port.requests.length, 1, 'one port.apply for the whole pass');
      const reverts = acceptedReverts(f.port);
      a.eq(reverts.length, 1, 'one revert for the whole pass');
      a.eq(reverts[0]?.unitIds.length, 20, 'the revert names all 20 units');
      a.eq(reverts[0]?.cutIndex, 1, 'the cut is the first forgotten node');
      a.eq(revertedEvents(events).length, 1, 'one revert-applied: the epoch break');

      // Salvage share per revisit (PRD §6.9, §13): every suffix node here was
      // forgotten, so the cut keeps nothing and the share is a measured zero.
      const [appliedRevert] = revertedEvents(events);
      a.ok(appliedRevert !== undefined, 'the revert record exists');
      a.eq(appliedRevert?.keptBytes, 0, 'the cut kept nothing');
      a.ok((appliedRevert?.freedBytes ?? 0) > 0, 'the cut freed bytes');
      a.eq(appliedRevert?.salvageShare, 0, 'a fully forgotten suffix salvages nothing');
      // A zero-survivor revert journals an empty list, never an absent field: the
      // record's shape does not depend on how many nodes survived (ISSUE-124).
      a.ok(appliedRevert !== undefined && 'survivors' in appliedRevert,
        'the revert record always carries the ids');
      a.deep(appliedRevert?.survivors, [], 'a full removal journals an empty survivor list');
      a.eq(appliedRevert?.survivorCount, appliedRevert?.survivors.length,
        'the count agrees with the empty list');
      // The formula on both branches: kept over the measured suffix, and null —
      // not NaN — when the cut measured no suffix bytes at all.
      a.eq(salvageShare(300, 100), 0.75, 'the share is kept over the measured suffix');
      a.eq(salvageShare(0, 0), null, 'no measured suffix bytes is null, not NaN');

      // One approved application and one applied receipt: the single break is
      // recorded once, not once per removed unit (ADR-0009).
      const approvals = [...f.ledger.applications.values()];
      a.eq(approvals.length, 1, 'one intent was prepared');
      a.eq(approvals[0]?.mode, 'revert', 'the intent is a revert');
      a.eq(approvals[0]?.phase, 'at-rest', 'the intent is applied at rest');
      a.eq(f.ledger.entries.filter(entry => entry.event.kind === 'applied').length, 1,
        'one applied receipt');

      // 20 recall ids were minted by the ledger's archival path and each resolves.
      const recorded = applications(events);
      a.eq(recorded.length, 1, 'one application event');
      const recallIds = recorded[0]?.recallIds ?? [];
      a.eq(recallIds.length, 20, '20 recall ids were minted');
      a.eq(new Set(recallIds).size, 20, 'every removal owns a distinct recall id');
      for (const id of recallIds) {
        a.ok(f.ledger.recalls.has(id), `the ledger archived ${id}`);
        a.ok((await engine.recall(id)).parts.length > 0, `${id} resolves to parts`);
      }

      // All 20 forgotten nodes left the transcript; the prefix tail stays.
      for (const result of f.results) {
        a.eq(nodeCount(f.port.live, result.id), 0, `${result.id} was forgotten`);
      }
      a.eq(nodeCount(f.port.live, 'assistant-1'), 1, 'the assistant message stays');
    },
  },
  {
    row: 'replaying the same prune eventId does not apply a second time',
    check: async a => {
      const f = await pruneFixture();
      const { events, sink } = collector();
      const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: sink });
      const merged = await twentyRemovals(f);
      const event = { kind: 'prune' as const, eventId: 'prune-1', round: 1,
        verdicts: merged, window: 200_000 };
      const first = await engine.process(event);
      a.eq(first.status, 'applied', 'the first event applies');

      const replay = await engine.process(structuredClone(event));
      // Dedupe is by eventId: the committed receipt answers the replay.
      a.eq(replay.status, 'applied', 'the replay reports applied');
      a.eq(replay.intentId, first.intentId, 'the replay reuses the intent');
      a.eq(f.port.requests.length, 1, 'the replay never reached the host');
      a.eq(revertedEvents(events).length, 1, 'the replay breaks no second epoch');
      a.eq(f.ledger.entries.filter(entry => entry.event.kind === 'applied').length, 1,
        'the replay writes no second receipt');

      // Pinned honestly: a NEW eventId is not deduped by content, but the document
      // names units the snapshot no longer holds, so nothing is planned and nothing
      // applies.
      const renamed = await engine.process({ ...event, eventId: 'prune-2' });
      a.eq(renamed.status, 'unchanged', 'a new eventId against a spent snapshot changes nothing');
      a.eq(f.port.requests.length, 1, 'the renamed event never reached the host');
      a.eq(revertedEvents(events).length, 1, 'the renamed event breaks no epoch');
    },
  },
  {
    row: 'a dedupe removal and a verdict removal apply as one revert, one intent, two receipts',
    check: async a => {
      const f = await dedupeFixture();
      const { events, sink } = collector();
      const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: sink });
      const plan = planPrunePass({ units: f.units, nodes: f.results, episodes: [], round: 1,
        grammar: "3option", classes: { supersededByReread: true } });
      a.deep(plan.l1.removals, [], 'L1 proves nothing: the two reads differ');
      a.deep(plan.dedupe.removals.map(removal => removal.unitId), [f.units[0]?.id],
        'the dedupe owns the earlier read');
      // The deduped unit is never asked about; the witness and the other result are.
      a.deep(plan.askRows.map(row => row.unit.id), [f.units[1]?.id, f.units[2]?.id],
        'the ask skips the deduped unit');
      const merged = mergeAnswers(plan, [{ keepall: true }, { forgetall: 'the b.ts result' }]);
      a.deep(merged.removals.map(removal => removal.origin), ['dedupe', 'l2'],
        'the document carries one removal of each origin');

      const outcome = await engine.process({ kind: 'prune', eventId: 'prune-dedupe-1', round: 1,
        verdicts: merged, window: 200_000 });
      a.eq(outcome.status, 'applied', 'the pass applies');

      // ONE application, ONE checkpoint-revert, ONE intent: the dedupe rides the
      // pass's existing break and adds no second one (ADR-0037 decision 1).
      a.eq(f.port.requests.length, 1, 'one port.apply for the whole pass');
      a.eq(applications(events).length, 1, 'one applyApplication');
      a.eq(revertedEvents(events).length, 1, 'one revert-applied: one epoch break');
      a.eq(f.ledger.applications.size, 1, 'one intent was prepared');
      a.eq(f.ledger.entries.filter(entry => entry.event.kind === 'applied').length, 1,
        'one applied receipt');
      const [application] = [...f.ledger.applications.values()];
      a.ok(application !== undefined, 'the application was recorded');
      a.eq(application?.mode, 'revert', 'the intent is a revert');
      // Two removed units, two receipt records: one per burn, no descriptor.
      a.eq(application?.appendRecords.length, 2, 'two receipt records');
      a.eq(application?.archives.length, 2, 'two archives');
      a.deep(application?.archives.map(archive => archive.ruleId).sort(),
        ['superseded-by-reread', 'verdict'], 'one archive per rule');
      a.eq(application?.archives.find(archive => archive.ruleId === 'superseded-by-reread')
        ?.operationKind, 'proof', 'the dedupe archive is a proof');
      a.eq(applications(events)[0]?.recallIds.length, 2, 'two recall ids were minted');
      // Both burns left the surface; the witness read is the copy that stays.
      a.eq(nodeCount(f.port.live, 'result-1'), 0, 'the older read was forgotten');
      a.eq(nodeCount(f.port.live, 'result-3'), 0, 'the verdict removal was forgotten');
      a.eq(nodeCount(f.port.live, 'result-2'), 1, 'the surviving read');
    },
  },
  {
    row: 'recall on a dedupe receipt returns the exact removed bytes',
    check: async a => {
      const f = await dedupeFixture();
      const engine = await RacoonsEngine.open(f.options);
      const plan = planPrunePass({ units: f.units, nodes: f.results, episodes: [], round: 1,
        grammar: "3option", classes: { supersededByReread: true } });
      const merged = mergeAnswers(plan, [{ keepall: true }, { forgetall: 'the b.ts result' }]);
      const outcome = await engine.process({ kind: 'prune', eventId: 'prune-dedupe-recall',
        round: 1, verdicts: merged, window: 200_000 });
      a.eq(outcome.status, 'applied', 'the pass applies');

      const [application] = [...f.ledger.applications.values()];
      a.ok(application !== undefined, 'the application was recorded');
      const archive = application?.archives.find(candidate => candidate.ruleId === 'superseded-by-reread');
      a.ok(archive !== undefined, 'the dedupe burn was archived');
      if (archive === undefined) return;
      const record = await engine.recall(archive.recall.id);
      const bytes = new Uint8Array(record.parts.flatMap(part => [...part.bytes]));
      const removed = f.results[0];
      a.ok(removed !== undefined, 'the fixture has the older read');
      if (removed === undefined) return;
      a.eq(bytes.length, removed.bytes.length, 'the recall returns the whole body');
      a.deep(bytes, removed.bytes, 'byte-equal: the older snapshot, whole');
      a.eq(sha256Sync(bytes), removed.sha256, 'hash-equal');
    },
  },
  {
    row: 'with the switch off the same fixture yields one removal and no dedupe rule',
    check: async a => {
      const f = await dedupeFixture();
      const { events, sink } = collector();
      const engine = await RacoonsEngine.open({ ...f.options, onTelemetry: sink });
      const plan = planPrunePass({ units: f.units, nodes: f.results, episodes: [], round: 1,
        grammar: "3option", classes: {} });
      a.deep(plan.dedupe.removals, [], 'no class is on');
      // Today's ask: every unit still in memory, the re-read pair included.
      a.deep(plan.askRows.map(row => row.unit.id), f.units.map(unit => unit.id),
        'every unit is asked about');
      const merged = mergeAnswers(plan,
        [{ keepall: true }, { keepall: true }, { forgetall: 'the b.ts result' }]);
      a.deep(merged.removals.map(removal => removal.origin), ['l2'], 'one verdict removal');

      const outcome = await engine.process({ kind: 'prune', eventId: 'prune-dedupe-off', round: 1,
        verdicts: merged, window: 200_000 });
      a.eq(outcome.status, 'applied', 'the pass applies');
      const [application] = [...f.ledger.applications.values()];
      a.ok(application !== undefined, 'the application was recorded');
      a.eq(application?.archives.length, 1, 'today\u2019s one receipt');
      a.eq(application?.archives[0]?.ruleId, 'verdict', 'the receipt is the verdict\u2019s');
      a.eq(application?.archives.every(archive => archive.ruleId !== 'superseded-by-reread'), true,
        'no dedupe receipt was written');
      a.eq(applications(events)[0]?.recallIds.length, 1, 'one recall id was minted');
      a.eq(nodeCount(f.port.live, 'result-3'), 0, 'the verdict removal was forgotten');
      a.eq(nodeCount(f.port.live, 'result-1'), 1, 'the earlier read stays');
    },
  },
];

test('a prune outcome per row — counted, replayed, deduped, recalled and switched off', async () => {
  for (const expected of PRUNE_CASES) await expected.check(at(expected.row));
});
