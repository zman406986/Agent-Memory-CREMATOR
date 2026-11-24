/**
 * The big prune's mount wiring, record-only (ISSUE-022 chunk 5; ADR-0009), and
 * its ask shape: a fork of main's sent wire state, grown append-only
 * (ISSUE-027; ADR-0010).
 *
 * One pass over the mount's own state: units and nodes from the authoritative
 * snapshot, episodes from the tracker the engine already uses. `planPrunePass`
 * runs L1, numbers every remaining unit,
 * and splits the display; this module seeds ONE fork from main's last captured
 * request (`seedFork`, byte-copied, hash-asserted) and grows it through
 * `./judge-tables.ts` — the shared table loop — appending each prune table
 * as a new user turn and reading each reply through the core's
 * `parsePruneAnswer`. The contract, the table and the final line ride INSIDE the
 * ask text: the fork's system slot is main's, untouched, because replacing it
 * would change byte 0 of the prefix the fork exists to have served from cache.
 *
 * The tables are the pass's: one table asks every eligible unit (the 12-row cap
 * of ADR-0009 §Amendment 2026-10-24 was removed by the 2026-11-16 owner ruling
 * recorded in ADR-0060 §Amendment), carried-over rows re-asked at the front of
 * the next table. `plan.tables` stays ACCOUNTING ONLY: its token estimate is the
 * record's `estTokens`, not the send split.
 *
 * Record-only is structural, not a flag: nothing here calls the engine, the
 * port or the host. There is no append, no receipt, no recall id and no ledger
 * kind. The result is counts (`pruneRecordOf`) plus the judged removals, which
 * the caller may journal and a rig may assert on.
 *
 * Fail-open: no model seam, no route, no captured seed, a dead stream, bad JSON
 * — every one is a named journal record and the units stay. The pass grants one
 * re-ask, and only inside itself: the next table of the same pass is that one
 * re-ask (ADR-0009's second amendment), never a retry across passes.
 */
import { EpisodeTracker, UnitTracker } from '@cremator/core';
import {
  applyPruneAnswers, computeInvalidation, ForkError, isTwoVerdictGrammar, planPrunePass, seedFork,
} from '@cremator/core';
import type {
  DedupeClasses, Episode, PrunePlanGrammar, PruneCallFacts,
  PrunePassApplication, PrunePassPlan, ProcessingUnit, SessionSnapshot, ToolResultNode,
  UnitId, WireAnswer, WireFork,
} from '@cremator/core';
import type { DshTranscriptItem } from './envelope.js';
import { runTables } from './judge-tables.js';
import type { TableLoopOutcome } from './judge-tables.js';
import type { MountJournal } from './journal-kinds.js';
import { messageOf } from './llm-ask.js';
import { seedRouteStale } from './main-wire.js';
import type { CapturedMainRequest } from './main-wire.js';
import type { DshLlmService } from './plugin.js';
import { journalPruneRecord, recordOnlyOutcome } from './prune-record.js';
import type { PruneRefusalReason, RecordOnlyPruneOutcome } from './prune-record.js';
import { retryRefusedRows } from './prune-retry.js';
import type { JudgeRoute } from './route.js';
import { dshRetentionOf } from './retention.js';

export type { PruneRefusalReason, PruneSummaryTrace, RecordOnlyPruneOutcome } from './prune-record.js';
export { PRUNE_COMMAND } from './prune-record.js';

export interface RecordOnlyPruneOptions {
  readonly sessionId: string;
  /** The authoritative snapshot the units and nodes come from. */
  readonly snapshot: SessionSnapshot;
  /** The port's items: the history the ask renders and the whole calls it names. */
  readonly transcript: readonly DshTranscriptItem[];
  /** The pass ordinal; the caller owns it so two passes never share a stamp. */
  readonly round: number;
  /** Same bar the engine's own `UnitTracker` uses (`config.barBytes`). */
  readonly barBytes: number;
  /** Same threshold the engine's episode detection uses. */
  readonly episodeNoNewPathSteps: number | null;
  /** The host's model seam; absent means the pass records its L1 layer only. */
  readonly llm?: DshLlmService;
  /** The host route the asks go to, snapshotted ONCE per pass (ISSUE-349). */
  readonly route: () => { readonly provider: string; readonly model: string } | null;
  /**
   * Main's last captured sent request; null means no fork can be seeded, so the
   * pass asks nothing and fails open. Required: a prune ask has no other shape
   * on the live path (ISSUE-027).
   */
  readonly seed: () => CapturedMainRequest | null;
  readonly journal: MountJournal;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Which superseded-read dedupe classes run (ADR-0037; ISSUE-145), passed straight
   * from the mount's resolved config. Absent means every class is off — today's
   * pass, byte for byte.
   */
  readonly classes?: DedupeClasses;
  /**
   * Result node ids whose ENTRY ask answered `keepall` and applied (ISSUE-073).
   * The mount's `entryJudged` is not enough: it marks every settled answer, and
   * only a keep settles the unit as content still worth asking about later. A
   * `forget` replaced its node, so its id names no unit here anyway.
   * Omitted means "the mount settled nothing": every unit stays listable.
   */
  readonly settledNodeIds?: ReadonlySet<string>;
  /**
   * The bulk ask's answer grammar (ISSUE-221), passed straight from the mount's
   * resolved config. The mount's shipped default is `nokeepall` (ADR-0056); a
   * direct caller that omits it gets `3option`, the original contract byte for
   * byte. `nokeepall` sends the `jsonl-20-nokeepall` three-piece message and
   * reads it with that grammar's reader (ISSUE-508); `3option` keeps the shipped
   * bytes. The plan carries it, so the table, correction and estimate paths all
   * select the same one.
   */
  readonly grammar?: PrunePlanGrammar;
  /**
   * Whether this pass's first table ask is the session's first table ask
   * (ISSUE-508). The mount reads it from its persisted `tableAskFired` fact:
   * `true` (a fresh session) states the 70 percent share line, `false` (a
   * restart, or a pass after any table ask left) states 40 percent. Omitted is
   * `true`, a first ask.
   */
  readonly firstTrigger?: boolean;
  /**
   * Called when a table request actually left the seam and was answered or
   * refused after the send (ISSUE-508). The mount persists `tableAskFired` here;
   * a refused append, a refused send and a throw never call it.
   */
  readonly onTableAskLeft?: () => void;
}

/**
 * The units a settled entry keep withholds from this pass (ISSUE-073).
 *
 * Two readings, both the product's existing ones rather than new ones:
 *
 *   - the settled set is the plan's own units whose node is a settled keep. A
 *     result below the bar has no unit, so nothing about it can be withheld;
 *   - a unit a later WRITE invalidated is not settled any more: the entry kept
 *     bytes that are now a stale copy, so the unit is ordinary content again and
 *     stays listable. `computeInvalidation` is the one rule for that (PRD §6.7),
 *     read here rather than restated.
 *
 * Fail-open and refused entry asks never reach `settledNodeIds`: their `keepall`
 * was never established, so they are never in this set.
 */
function settledUnitsOf(units: readonly ProcessingUnit[], snapshot: SessionSnapshot,
  settledNodeIds: ReadonlySet<string> | undefined,
): ReadonlySet<UnitId> | undefined {
  if (settledNodeIds === undefined || settledNodeIds.size === 0) return undefined;
  const kept = units.filter(unit => settledNodeIds.has(unit.nodeId));
  if (kept.length === 0) return undefined;
  const invalidated = computeInvalidation({ snapshot, units }).byUnit;
  const settled = new Set<UnitId>();
  for (const unit of kept) {
    if (invalidated.has(unit.id)) continue;
    settled.add(unit.id);
  }
  return settled.size === 0 ? undefined : settled;
}

/**
 * What the mount knows about each whole call, keyed by node id. The transcript
 * item is the only source: `toolName` and the target it named, never inferred
 * from the unit's text. A result with no item keeps its node's own evidence, so
 * the row still renders a call.
 */
export function callFactsOf(transcript: readonly DshTranscriptItem[],
): ReadonlyMap<string, PruneCallFacts> {
  const facts = new Map<string, PruneCallFacts>();
  for (const item of transcript) {
    if (item.role !== 'tool' || facts.has(item.id)) continue;
    const key = item.target?.key;
    facts.set(item.id, {
      ...(item.toolName.length > 0 ? { toolName: item.toolName } : {}),
      ...(key === undefined || key.length === 0 ? {} : { targetPath: key }),
    });
  }
  return facts;
}

/** Every tool-result node of a snapshot, in transcript order. */
function nodesOf(snapshot: SessionSnapshot): readonly ToolResultNode[] {
  return snapshot.nodes.filter((node): node is ToolResultNode => node.kind === 'tool-result');
}

/**
 * Runs one record-only pass. The only throw is a caller bug from core's own
 * planners (an invalid round, a foreign stamp); every host or model failure is
 * a journaled record and an empty judged layer.
 */
export async function runRecordOnlyPrune(
  options: RecordOnlyPruneOptions,
): Promise<RecordOnlyPruneOutcome> {
  const { sessionId, journal } = options;
  // Every result the snapshot holds is eligible, including results that were
  // already on the host surface when this session's durable state was created.
  // There is no pre-install exclusion: the pass plans over exactly the surface
  // it was handed, so a later `/cremate` or automatic pass can table and remove
  // history this mount did not observe land.
  const snapshot = options.snapshot;
  const allUnits = new UnitTracker({ sessionId, barBytes: options.barBytes }).units(snapshot);
  // ISSUE-519: the two retention rules gate the units BEFORE any plan exists. A
  // unit whose node is the recall tool's own answer, or whose text another live
  // result already contains, keeps: it is not planned, it is not asked about,
  // and the journal names the marker. The nodes stay in the snapshot, so a
  // retained result still serves as a witness for every other unit.
  const units = allUnits.filter(unit => {
    const verdict = dshRetentionOf(unit.nodeId, options.transcript);
    if (verdict === null) return true;
    journal('prune-retained', { sessionId, round: options.round, unitId: unit.id,
      nodeId: unit.nodeId, byteLength: unit.byteLength, reason: verdict.code,
      containedInNodeId: verdict.containedInNodeId });
    return false;
  });
  const nodes = nodesOf(snapshot);
  const episodes: readonly Episode[] = new EpisodeTracker({
    noNewPathSteps: options.episodeNoNewPathSteps,
  }).detect({ sessionId, results: nodes,
    currentStepOrdinal: snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: snapshot.completedThroughTurnOrdinal });
  const settled = settledUnitsOf(units, snapshot, options.settledNodeIds);
  const plan = planPrunePass({
    units, nodes, episodes,
    // The dedupe's call-echo witness is a message (class 1), so it reads the
    // whole snapshot; L1 keeps its tool-result list above.
    transcriptNodes: snapshot.nodes,
    callFacts: callFactsOf(options.transcript),
    round: options.round,
    classes: options.classes ?? {},
    // ISSUE-221: the plan carries the grammar, so the table, correction and
    // estimate paths cannot disagree about which contract the pass states.
    grammar: options.grammar ?? '3option',
    ...(settled === undefined ? {} : { settled }),
  });
  journal('prune-plan', { sessionId, round: plan.round, units: units.length,
    askRows: plan.askRows.length, tables: plan.tables.length,
    l1Removals: plan.l1.removals.length, dedupeRemovals: plan.dedupe.removals.length,
    dedupeRefusals: plan.dedupe.refusals.length,
    settledWithheld: plan.settledWithheld.length });

  // ISSUE-349: ONE route snapshot per pass. The refusal check, the tables and
  // the correction all ride this single read, so a mid-pass config change
  // cannot redirect the correction ask. A throwing getter is contained HERE,
  // before any journal obligation: it fails open as a null route, which the
  // refusal below names `not-configured`, and its message rides the off line.
  let route: JudgeRoute | null = null;
  let routeMessage: string | undefined;
  try { route = options.route(); }
  catch (error) { routeMessage = messageOf(error); }

  const refusedFor = refusalOf(options.llm, route);
  if (refusedFor !== null || options.llm === undefined) {
    const outcome = recordOnlyOutcome(plan, null, refusedFor ?? 'no-llm-service', 0);
    journal('prune-off', { sessionId, round: plan.round,
      reason: refusedFor ?? 'no-llm-service', askRows: plan.askRows.length,
      ...(routeMessage === undefined ? {} : { message: routeMessage }) });
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  // No row to ask: no fork is needed and no model call is made. The merge still
  // reports L1's removals, which is the pass's whole provable layer.
  if (plan.askRows.length === 0) {
    const application = applyPruneAnswers(plan, [], { indices: [], stamps: plan.stamps });
    const outcome = recordOnlyOutcome(plan, application, null, 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  const seeded = seedOnce(options, journal);
  if (seeded === null) {
    // No fork can exist without main's sent bytes; the pass asks nothing and
    // says so once, by name, instead of inventing a seed.
    journal('prune-unseeded', { sessionId, round: plan.round,
      askRows: plan.askRows.length, reason: 'no-seed',
      message: "main's sent request was never captured; no fork can be seeded" });
    const outcome = recordOnlyOutcome(plan, null, 'no-seed', 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }
  // ISSUE-470: the same route comparison the entry ask applies. A capture
  // dispatched under another model must not seed a request sent to this one.
  if (route !== null && seedRouteStale(seeded, route)) {
    journal('seed-model-stale', { sessionId, round: plan.round,
      seedProvider: seeded.provider, seedModel: seeded.model,
      routeProvider: route.provider, routeModel: route.model,
      action: 'seed-invalidated' });
    const outcome = recordOnlyOutcome(plan, null, 'seed-model-stale', 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }
  const fork = forkOf(seeded, options, journal);
  if (fork === null) {
    const outcome = recordOnlyOutcome(plan, null, 'seed-refused', 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  const loop = await runTables({ sessionId, round: plan.round, fork,
    rows: plan.askRows, stamps: plan.stamps, llm: options.llm,
    route, journal, grammar: plan.grammar,
    ...(options.firstTrigger === undefined ? {} : { firstTrigger: options.firstTrigger }),
    ...(options.onTableAskLeft === undefined ? {} : { onTableAskLeft: options.onTableAskLeft }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  // The pass's ONE correction turn (ISSUE-113): rows whose last attempt still
  // refused are re-asked once, as the approved message appended to the same
  // fork. A clean answer leaves `loop` untouched — this call returns it
  // unchanged, so the bytes and the journals of a clean pass are today's.
  const corrected = await retryRefusedRows({ sessionId, round: plan.round,
    rows: plan.askRows, loop, stamps: plan.stamps, llm: options.llm,
    route, journal, grammar: plan.grammar,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const application = mergeSettled(plan, corrected);
  const outcome = recordOnlyOutcome(plan, application, null, corrected.answeredTables,
    { tables: corrected.attempts, pass: corrected.attemptTotals });
  journalPruneRecord(sessionId, outcome, journal);
  for (const removal of application.removals) {
    journal('prune-verdict', { sessionId, round: plan.round, unitId: removal.unitId,
      origin: removal.origin,
      // A dedupe removal carries a class, not an action: it is a byte fact, not a
      // judged answer (ADR-0037). Both travel under `rule`, so one field names
      // whichever proof removed the unit. `rule` is the class token, renamed by
      // ISSUE-160 to `superseded-by-reread`; a row journaled before that rename
      // keeps its old token and is read as history, never rewritten. The recall
      // id beside it (`dedupe:${unitId}`) never carried the class name at all.
      ...(removal.origin === 'dedupe' ? { rule: removal.rule }
        : { action: removal.action,
          ...(removal.origin === 'l1' ? { rule: removal.rule } : {}) }) });
  }
  return outcome;
}

/**
 * Core's merge, fed the SETTLED verdicts: the table loop already read every
 * reply and carried every unanswered index to its one re-ask, so each answered
 * row is handed to `applyPruneAnswers` exactly once. The refused rows and the
 * stray keys come from the loop's own reading — a re-rendered answer text could
 * not carry their codes — and are spliced into the document core returned.
 *
 * A DEFERRED row (ISSUE-177) appears in neither list, by construction: only the
 * loop's ANSWERED rows are handed to `applyPruneAnswers`, so a deferred index
 * earns no verdict entry and no refusal entry, and `mergePass` keeps it like
 * every other unit with no verdict. The loop's halt drain no longer writes a
 * deferral into `loop.refused`, which is what used to turn it into a
 * `refusedCount` decision. The count travels in the attempt totals instead.
 */
function mergeSettled(plan: PrunePassPlan, loop: TableLoopOutcome): PrunePassApplication {
  // ISSUE-221: under a two-verdict grammar a full-range `keeplines` was
  // normalized to a clean `keepall` before the carry scheduler saw it.
  // Re-encoding that keep as `{"keepall":true}` would make core's own gate read
  // it as an action this grammar does not offer, so the keep is not sent back at
  // all: a keep verdict produces no removal, and the merge keeps every unit with
  // no verdict. Every other answer is handled exactly as before.
  const answered = [...loop.kept.entries()]
    .filter(([, row]) => !isTwoVerdictGrammar(plan.grammar)
      || row.answer.verdict.action !== 'keepall')
    .sort(([left], [right]) => left - right);
  const text = answered.length === 0 ? [] : [JSON.stringify(Object.fromEntries(
    answered.map(([index, row]) => [String(index), wireAnswerOf(row.answer)])))];
  const base = applyPruneAnswers(plan, text, {
    indices: answered.map(([index]) => index), stamps: plan.stamps });
  const rows = new Map(plan.askRows.map(row => [row.index, row] as const));
  const position = new Map(plan.units.map((unit, at) => [unit.id, at] as const));
  const refused = [...base.refused];
  for (const [index, refusal] of loop.refused) {
    const row = rows.get(index);
    if (row === undefined) continue;
    refused.push({ unitId: row.unit.id, index, code: refusal.code,
      message: refusal.message, wireCode: refusal.wireCode, answerIndex: refusal.table });
  }
  refused.sort((left, right) => (position.get(left.unitId) ?? 0) - (position.get(right.unitId) ?? 0));
  const rejected = loop.rejected.map(entry => ({ key: entry.key, index: entry.index,
    code: entry.code, message: entry.message, answerIndex: entry.table }));
  return { ...base, refused, rejected };
}

/**
 * One settled answer back in the wire notation `applyPruneAnswers` reads. This
 * is the verdict's transport into core's merge, not a re-render of the ask: the
 * spans are the parser's normalized ones, so the second read is idempotent. Each
 * partial class is re-encoded under its OWN key: re-encoding a `forgetlines`
 * answer as `keeplines` would flip its polarity and drop the kept lines instead
 * of the dropped ones (ADR-0026 §4).
 */
function wireAnswerOf(answer: WireAnswer): Readonly<Record<string, unknown>> {
  const verdict = answer.verdict;
  if (verdict.action === 'keepall') return { keepall: true };
  if (verdict.action === 'forgetall') return { forgetall: verdict.summary ?? '' };
  if (verdict.action === 'forgetlines') {
    return { forgetlines: [...verdict.ranges.map(range => [range.from, range.to]),
      answer.forgetlinesSummary ?? ''] };
  }
  return { keeplines: [...verdict.ranges.map(range => [range.from, range.to]),
    answer.keeplinesSummary ?? ''] };
}

/** Read main's last captured request, journaling a throwing reader as a refusal. */
function seedOnce(options: RecordOnlyPruneOptions, journal: MountJournal): CapturedMainRequest | null {
  try { return options.seed(); }
  catch (error) {
    journal('prune-seed-refused', { sessionId: options.sessionId, round: options.round,
      code: null, message: messageOf(error) });
    return null;
  }
}

/** Seed the fork from the capture, or journal why it could not be seeded. */
function forkOf(seeded: CapturedMainRequest, options: RecordOnlyPruneOptions,
  journal: MountJournal): WireFork | null {
  try {
    const fork = seedFork(seeded.wire);
    journal('prune-seed', { sessionId: options.sessionId, round: options.round,
      seedHash: seeded.seedHash, systemFromMessage: seeded.systemFromMessage,
      droppedMessages: seeded.droppedMessages, droppedBlocks: seeded.droppedBlocks,
      messages: seeded.wire.messages.length, tools: seeded.wire.tools.length });
    return fork;
  } catch (error) {
    journal('prune-seed-refused', { sessionId: options.sessionId, round: options.round,
      code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
    return null;
  }
}

/**
 * The route's own refusal, checked before any ask is composed. ISSUE-349: it
 * reads the pass's ONE snapshot, never `options.route()` again, so the check
 * and every ask of the pass cannot disagree about the route.
 */
function refusalOf(llm: DshLlmService | undefined, route: JudgeRoute | null): PruneRefusalReason | null {
  if (llm === undefined) return 'no-llm-service';
  if (route === null || route.provider.trim() === '' || route.model.trim() === '') {
    return 'not-configured';
  }
  return null;
}
