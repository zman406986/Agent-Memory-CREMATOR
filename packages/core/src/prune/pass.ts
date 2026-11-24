/**
 * The big prune's pass planner (ISSUE-022 chunk 4; ADR-0009).
 *
 * One pass, in cost order: L1 runs first and removes only what bytes prove, L2
 * asks every unit still in memory by an index we assigned, L3 keeps the rest.
 * This module binds the two layers into ONE record-only plan document; reading
 * the answers back into that document is `./pass-merge.ts`.
 *
 * What the plan is NOT: a receipt, a recall id, a ledger event or a transcript
 * change. Record-only means nothing moves and nothing is archived, so a receipt
 * line or recall id would be a false claim — the id only exists after the bytes
 * are archived. The plan names unit ids, actions, line ranges and L1 proofs;
 * chunk 5 renders it, and the apply rollout turns it into one checkpoint-revert.
 *
 * Ordering: every list follows transcript order — the input unit order. L1's own
 * lists are transcript-ordered by construction, ask rows are numbered over L1's
 * kept list, and the merge walks the pass's unit list. Nothing here reorders.
 *
 * Nothing here calls a model: the ask's round trip is the caller's job, so the
 * planner stays pure, deterministic and testable. The only throw is a caller bug
 * — an invalid round, an index this pass never assigned, a stamp naming another
 * unit. Transcript data never throws.
 */

import type { Episode } from "../episodes/types.js";
import type { PrunePlanGrammar } from "../config.js";
import type { NodeId, UnitId } from "../types/identity.js";
import type { ToolResultNode, TranscriptNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";
import { byteLengthOf } from "../util/bytes.js";
import type { WireStamp } from "../verdicts/wire.js";
import type { PruneCallFacts } from "./anchor.js";
import { buildPruneAskRows, nextTable, renderPruneAskTable } from "./ask.js";
import type { PruneAskItem, PruneAskRow, PruneAskTable } from "./ask.js";
import { planDedupe } from "./dedupe/index.js";
import { DEDUPE_CLASSES } from "./dedupe/types.js";
import type { DedupeClass, DedupeClasses, DedupePlan } from "./dedupe/types.js";
import { planLevel1Prune } from "./level1.js";
import { dedupeClaims, gateRemovals, l1Claims, locateContents, planCancellations, contentIdentities } from "./survivors.js";
import type { PlanCancellation, RemovalCancellation, UnitContent } from "./survivors.js";
import type { Level1PrunePlan } from "./types.js";

export interface PrunePassInput {
  /** Every unit still in memory, in transcript order. Duplicate ids are ignored. */
  readonly units: readonly ProcessingUnit[];
  /** The tool-result nodes the units came from; L1's own subject set. */
  readonly nodes: readonly ToolResultNode[];
  /**
   * Every transcript node, when the caller has them (ISSUE-151). The dedupe's
   * witness set is read from here: class 2's witness is a later result, class
   * 1's witness is the assistant message that declared the call, and a message
   * is not in `nodes`. Omitted means `nodes` — the reading a caller with only
   * tool results intends, and exactly the class-2-only pass before this field.
   */
  readonly transcriptNodes?: readonly TranscriptNode[];
  readonly episodes: readonly Episode[];
  /** What the mount knows per node; see `./anchor.ts`. */
  readonly callFacts?: ReadonlyMap<NodeId, PruneCallFacts>;
  /** The pass's round ordinal; stamped on every assigned index. */
  readonly round: number;
  /**
   * Which superseded-read dedupe classes run (ADR-0037; ISSUE-145), from
   * `config.protocol.dedupe.classes`. Every class is absent or false unless an
   * operator turned it on, and a class that is off plans nothing, so an existing
   * mount's pass is byte-for-byte today's.
   */
  readonly classes: DedupeClasses;
  /**
   * Unit ids a SETTLED entry keep already settled (ISSUE-073): the unit a
   * result checkpoint answered `keepall` for and applied. Omitted or empty
   * excludes nothing. The caller supplies it post-invalidation — a unit a later
   * write invalidated is not settled any more and must not be here.
   */
  readonly settled?: ReadonlySet<UnitId>;
  /**
   * The answer grammar this pass's tables state. Absent is `nokeepall`, the
   * shipped default (ADR-0056): each row carries its `[L line(s)]`, the closing
   * line states the two verdicts that grammar offers, and the answer gate the
   * merge applies refuses every action it does not. `3option`, the original
   * shipped contract byte for byte, stays selectable by name. The plan carries
   * the grammar so the table, correction and estimate paths select the same one.
   */
  readonly grammar?: PrunePlanGrammar;
}

/** One pass as a document: the two layers, the dedupe, and its ask tables. */
export interface PrunePassPlan {
  readonly round: number;
  /** The grammar the ask tables state; `nokeepall` when the caller named none. */
  readonly grammar: PrunePlanGrammar;
  /** L1's own verdict. */
  readonly l1: Level1PrunePlan;
  /**
   * The superseded-read dedupe's own verdict (ADR-0037). Empty — with a zero count
   * in every class — when no class is on or no class proves anything. Its
   * removals travel the pass document as proofs, so they are never ask rows.
   */
  readonly dedupe: DedupePlan;
  /** L1's kept list minus the deduped units, in transcript order. */
  readonly askRows: readonly PruneAskRow[];
  /** `askRows` in one whole table, in order; there is no row cap. */
  readonly tables: readonly PruneAskTable[];
  /** `index → unitId + round`, ready for `parsePruneAnswer`. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
  /** Every unit the pass was given, deduplicated, in transcript order. */
  readonly units: readonly ProcessingUnit[];
  /**
   * Every located unit's content identity, in `units` order (ISSUE-174). The
   * merged document reads this to run the same survivor gate over the answers,
   * so the verdict step and the plan step cannot disagree about what a content
   * class is: one comparison, one place.
   *
   * Identity only — no bytes — because a plan document travels to the merge and
   * this field must not make the document carry the transcript twice. A unit
   * whose bytes could not be located is absent, and it is never a removal
   * subject either.
   */
  readonly contents: readonly UnitContent[];
  /**
   * The removals the survivor gate refused (ISSUE-174), in plan order: L1's
   * first, then the dedupe's. A cancelled unit is never applied and, when the
   * cancelled lane was the dedupe, it is asked about instead — the safe side is
   * always "keep the content and let a verdict decide".
   *
   * Always present and empty on a pass the families could not contradict, so a
   * pass that was already safe is byte-identical to the pass before this field
   * existed.
   */
  readonly cancellations: readonly PlanCancellation[];
  /**
   * The units this pass withholds from its ask because a settled entry keep
   * already decided them (ISSUE-073), in transcript order. Always a subset of
   * `l1.kept`; empty when the caller passed no settled set.
   */
  readonly settledWithheld: readonly UnitId[];
}

/**
 * Plans one record-only pass. L1 runs over the units first, then the
 * superseded-read dedupe over L1's kept units (ADR-0037). The ask covers L1's kept
 * list minus two exclusions: the units the dedupe proved superseded — a byte
 * proof outranks a verdict, so asking about one would spend ask tokens and
 * invite a contradiction — and the units a SETTLED entry keep already settled
 * (ISSUE-073). Every other unit still in memory is re-asked, including units an
 * earlier pass kept, because asking is the only way to learn it is now unneeded
 * (Ruling 8: L2 asks everything still in memory). The settled set is the
 * caller's: a unit whose entry ask failed open, was refused or was never asked
 * is not in it and stays listable. No content class is held back (ADR-0020).
 */
export function planPrunePass(input: PrunePassInput): PrunePassPlan {
  const { round } = input;
  if (!Number.isSafeInteger(round) || round < 0) {
    throw new RangeError("round must be a non-negative safe integer.");
  }
  const units: ProcessingUnit[] = [];
  const seen = new Set<UnitId>();
  for (const unit of input.units) {
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    units.push(unit);
  }
  const l1 = planLevel1Prune({ units, nodes: input.nodes, episodes: input.episodes });
  // The dedupe runs inside this pass and before any ask row is built (ADR-0037
  // decision 1). It sees only L1's KEPT units, so a unit an L1 family already
  // proved is never planned twice and one unit never carries two removals. It
  // runs over every kept unit regardless of the settled set: a settled keep is a
  // verdict about value, and a duplicate is a byte fact about a newer copy
  // (ADR-0037 decision 7).
  //
  // Its WITNESS set is L1's removed NODES (ISSUE-174): a node this pass deletes
  // is not a copy that survives, so a burn may not cite it. Without this the
  // dedupe proved an earlier read stale against a witness L1 had already proved
  // away, and the two lanes together erased content neither could erase alone.
  const keptUnits = new Set(l1.kept);
  const byId = new Map(units.map(unit => [unit.id, unit] as const));
  const l1RemovedNodes = new Set<NodeId>();
  for (const removal of l1.removals) {
    const unit = byId.get(removal.unitId);
    if (unit !== undefined) l1RemovedNodes.add(unit.nodeId);
  }
  const rawDedupe = planDedupe({
    units: units.filter(unit => keptUnits.has(unit.id)),
    // The dedupe's witness may be a message (class 1's request), so it reads the
    // caller's full snapshot when one was supplied. `nodes` alone is exactly the
    // class-2-only reading the pass had before call echoes existed.
    nodes: input.transcriptNodes ?? input.nodes,
    classes: input.classes,
    removedNodeIds: l1RemovedNodes,
  });

  // ONE gate over the WHOLE plan, after every removal decision exists. L1 gated
  // its own three families (they can contradict each other); this gate is the
  // union, which is where the lanes contradict ACROSS lanes — a dedupe burn that
  // deletes the copy an L1 proof named as its survivor, or an L1 keeper whose
  // only remaining copy the dedupe then takes. Rule 1 keeps the newest copy of
  // any content class the plan would erase; rule 2 voids a proof whose named
  // survivor the plan removes. Both only ever cancel, so nothing is repaired and
  // nothing is invented.
  const copies = locateContents(units, input.nodes);
  const unionCancellations = gateRemovals(copies, [
    ...l1Claims(l1.removals),
    ...dedupeClaims(rawDedupe),
  ]);
  const cancelledIds = new Set(unionCancellations.map(entry => entry.unitId));

  // Rebuild both lanes against the union verdict, so each plan document is
  // internally consistent: a unit is in exactly one of its two lists, and the
  // removals it reports are exactly the removals that will be applied.
  const l1Plan: Level1PrunePlan = rebuildL1(l1, units, cancelledIds);
  const dedupe = rebuildDedupe(rawDedupe, cancelledIds);
  const deduped = new Set(dedupe.removals.map(removal => removal.unitId));
  const nodes = new Map<NodeId, ToolResultNode>();
  for (const node of input.nodes) {
    if (node.kind === "tool-result" && !nodes.has(node.id)) nodes.set(node.id, node);
  }

  const items: PruneAskItem[] = [];
  const settled = input.settled;
  const withheld: UnitId[] = [];
  for (const unitId of l1Plan.kept) {
    // A unit the dedupe proved superseded is removed by the same revert, so it
    // is not withheld by a settled keep and never reaches a table.
    if (deduped.has(unitId)) continue;
    // A settled keep is final (ISSUE-073): the entry checkpoint already decided
    // this unit, so a later table never lists it again. Only the ask is
    // withheld — L1's byte proofs run over every unit regardless.
    if (settled !== undefined && settled.has(unitId)) { withheld.push(unitId); continue; }
    const unit = byId.get(unitId);
    // L1's kept list is drawn from these units, so this cannot miss; skipping
    // would drop a unit from the ask, which is the one thing the ask must not do.
    if (unit === undefined) continue;
    const node = nodes.get(unit.nodeId);
    const facts = input.callFacts?.get(unit.nodeId);
    items.push({
      unit,
      ...(node === undefined ? {} : { node }),
      ...(facts === undefined ? {} : { callFacts: facts }),
    });
  }
  const askRows = buildPruneAskRows(items);
  const stamps = new Map<number, WireStamp>();
  for (const row of askRows) {
    stamps.set(row.index, { unitId: row.unit.id, answeredInRound: round });
  }
  return {
    round, grammar: input.grammar ?? "nokeepall",
    l1: l1Plan, dedupe, askRows, stamps, units, settledWithheld: withheld,
    contents: contentIdentities(copies),
    cancellations: planCancellations(unionCancellations),
    tables: buildAskTables(askRows),
  };
}

/**
 * L1's plan with the union gate's cancellations applied. A cancelled removal
 * returns to `kept`, so the unit is asked about again rather than dropped from
 * both lists; its cancellation is carried beside the plan, never discarded.
 */
function rebuildL1(
  plan: Level1PrunePlan, units: readonly ProcessingUnit[],
  cancelled: ReadonlySet<UnitId>,
): Level1PrunePlan {
  if (cancelled.size === 0) return plan;
  const removed = new Set(plan.removals.map(removal => removal.unitId));
  if (![...cancelled].some(unitId => removed.has(unitId))) return plan;
  const order = new Map(units.map((unit, index) => [unit.id, index] as const));
  const back: UnitId[] = [];
  for (const unitId of cancelled) if (removed.has(unitId)) back.push(unitId);
  const backSet = new Set(back);
  const kept = [...plan.kept, ...back]
    .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  return {
    removals: plan.removals.filter(removal => !backSet.has(removal.unitId)),
    kept,
    cancellations: plan.cancellations,
  };
}

/**
 * The dedupe's plan with the union gate's cancellations applied. Its per-class
 * counts are recomputed from what survives, so a class that cancelled a removal
 * reads as the smaller number it will actually act on.
 */
function rebuildDedupe(plan: DedupePlan, cancelled: ReadonlySet<UnitId>): DedupePlan {
  const kept = plan.removals.filter(removal => !cancelled.has(removal.unitId));
  if (kept.length === plan.removals.length) return plan;
  const counts: Record<DedupeClass, number> = Object.fromEntries(
    DEDUPE_CLASSES.map(name => [name, 0] as const),
  ) as Record<DedupeClass, number>;
  for (const removal of kept) counts[removal.rule] += 1;
  // A refusal names a subject the class never planned; the survivor gate cannot
  // turn one into a removal, so the list travels unchanged.
  return { removals: kept, counts, refusals: plan.refusals };
}

/**
 * The pass's tables: the ONE table `nextTable` builds over the ask rows, whole —
 * there is no row cap (the 12-row cap of ADR-0009 §Amendment 2026-10-24 was
 * removed by the 2026-11-16 owner ruling recorded in ADR-0060 §Amendment). A
 * pass plan carries no re-asks (no reply exists yet), so the table has no
 * carried rows; a later table exists only when a reply leaves rows carried, and
 * that split is the send loop's, never this plan's.
 */
function buildAskTables(rows: readonly PruneAskRow[]): readonly PruneAskTable[] {
  return rows.length === 0 ? [] : [nextTable(rows)];
}

/**
 * The estimate the bench and the meter share: four bytes per token, rounded up —
 * `CharHeuristicTokenMeter`'s rule, computed without materialising the bytes.
 *
 * `l1RemovalsBytes` counts the L1 removals this pass would act on, and
 * `dedupeRemovalsBytes` the dedupe burns it would act on (ISSUE-338): both are
 * priced at bytes/4, so a dedupe-only pass is not near-zero while its count is
 * non-zero. `askTableTokens` is the sum over the pass's tables, each measured at
 * its own rendered table (the heading repeats per table). `total` is
 * `ceil(l1RemovalsBytes / 4) + ceil(dedupeRemovalsBytes / 4) + askTableTokens`:
 * the cost of the pass in the one unit the product reports, with the history
 * and the final instruction line excluded because they are the caller's
 * budget, not the pass's.
 *
 * `cancelled` names units the survivor gate refused (ISSUE-174). Their bytes are
 * not counted in either lane: the pass will not act on them, and pricing them
 * would report a saving the pass does not take. Omitted means nothing was
 * cancelled, which is the reading for a plan with no merged document yet.
 */
export function estimatePassTokens(
  plan: PrunePassPlan, cancelled: ReadonlySet<UnitId> = new Set(),
): {
  readonly l1RemovalsBytes: number;
  readonly dedupeRemovalsBytes: number;
  readonly askTableTokens: number;
  readonly total: number;
} {
  const byId = new Map(plan.units.map(unit => [unit.id, unit] as const));
  let l1RemovalsBytes = 0;
  for (const removal of plan.l1.removals) {
    if (cancelled.has(removal.unitId)) continue;
    l1RemovalsBytes += byId.get(removal.unitId)?.byteLength ?? 0;
  }
  let dedupeRemovalsBytes = 0;
  for (const removal of plan.dedupe.removals) {
    if (cancelled.has(removal.unitId)) continue;
    dedupeRemovalsBytes += byId.get(removal.unitId)?.byteLength ?? 0;
  }
  const askTableTokens = plan.tables.reduce(
    (sum, table) => sum + Math.ceil(byteLengthOf(renderPruneAskTable(
      table.rows, undefined, { grammar: plan.grammar })) / 4),
    0,
  );
  return { l1RemovalsBytes, dedupeRemovalsBytes, askTableTokens,
    total: Math.ceil(l1RemovalsBytes / 4) + Math.ceil(dedupeRemovalsBytes / 4) + askTableTokens };
}
