/**
 * The decision document of one prune pass (ISSUE-022 chunk 4; ADR-0009).
 *
 * The pass asks every unit still in memory; `./pass-answers.ts` reads the
 * answers per index, and this module turns those decisions into the document.
 * Record-only by ruling: a removal names the unit, the action, the judged ranges
 * and summary, and (for L1) its proof. No receipt, recall id, ledger event or
 * transcript byte appears anywhere — those are claims only an archive can make
 * true, and record-only archives none.
 *
 * The only throws are caller bugs, and they are the reader's, not this module's.
 * Answer data never throws.
 */

import type { UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";
import type { KeptLineSpan } from "../verdicts/types.js";
import type { WireAnswer, WireVerdictErrorCode } from "../verdicts/wire.js";
import type { PruneAnswerRejection, PruneAnswerRefusalCode } from "./ask-answer.js";
import { isTwoVerdictGrammar } from "./ask-message.js";
import type { DedupeClass, DedupeProof } from "./dedupe/types.js";
import type { PrunePassPlan } from "./pass.js";
import { gateRemovals, locateContents, unlocatedIdentities } from "./survivors.js";
import type { RemovalCancellation, RemovalClaim } from "./survivors.js";
import type { Level1Proof, Level1Rule } from "./types.js";
import { normalizeWireTwoVerdictAnswer } from "./two-verdict.js";

/** One unit L1 removed whole; the proof travels verbatim. */
export interface PruneL1Removal {
  readonly unitId: UnitId;
  readonly origin: "l1";
  readonly action: "forgetall";
  readonly rule: Level1Rule;
  /** The structured evidence `planLevel1Prune` filed, byte-identical. */
  readonly proof: Level1Proof;
}

/**
 * One unit the superseded-read dedupe removed (ADR-0037; ISSUE-145). It carries no
 * `action`: a dedupe removal is not a judged answer, it is a byte fact the
 * guard re-derives. It travels the proof lane — `planDedupeProofs` turns each
 * one into a `proof` operation — so its receipt is a `proof-receipt` and never
 * a described one.
 */
export interface PruneDedupeRemoval {
  readonly unitId: UnitId;
  readonly origin: "dedupe";
  readonly rule: DedupeClass;
  /** The fact that supersedes this unit; the guard re-derives it, never trusts it. */
  readonly proof: DedupeProof;
}

/** One unit the ask removes; the fields are the judged claim, not a receipt. */
export type PruneL2Removal =
  | {
      readonly unitId: UnitId;
      readonly origin: "l2";
      readonly action: "keeplines";
      /** 1-based line spans the unit keeps, as the wire parser normalised them. */
      readonly ranges: readonly KeptLineSpan[];
      /** The `keeplines` trailer summary, carried verbatim when the answer had one. */
      readonly keeplinesSummary?: string;
      readonly answeredInRound: number;
    }
  | {
      readonly unitId: UnitId;
      readonly origin: "l2";
      readonly action: "forgetlines";
      /** 1-based line spans the unit DROPS, as the wire parser normalised them. */
      readonly ranges: readonly KeptLineSpan[];
      /** The `forgetlines` trailer summary, carried verbatim when the answer had one. */
      readonly forgetlinesSummary?: string;
      readonly answeredInRound: number;
    }
  | {
      readonly unitId: UnitId;
      readonly origin: "l2";
      readonly action: "forgetall";
      /** The `forgetall` descriptor exactly as the wire parser read it; blank is legal. */
      readonly summary: string | null;
      readonly answeredInRound: number;
    };

export type PruneRemoval = PruneL1Removal | PruneL2Removal | PruneDedupeRemoval;

/** One verdict that could not be read; its unit is kept. */
export interface PrunePassRefusal {
  readonly unitId: UnitId;
  readonly index: number;
  readonly code: PruneAnswerRefusalCode;
  readonly message: string;
  readonly wireCode: WireVerdictErrorCode | null;
  /** Which answer text produced it; null when the answer was absent or duplicated. */
  readonly answerIndex: number | null;
}

/** A key an answer carried that addresses no unit of this pass. */
export interface PrunePassRejection extends PruneAnswerRejection {
  /** Which answer text carried the key. */
  readonly answerIndex: number;
}

/** The merged pass: what would move, what stays, and why anything was unreadable. */
export interface PrunePassApplication {
  /** Transcript order; L1 proofs first-class, L2 claims beside them. */
  readonly removals: readonly PruneRemoval[];
  /** Transcript order, the units this pass decided to keep. */
  readonly kept: readonly UnitId[];
  /** Transcript order, one entry per unit whose verdict could not be read. */
  readonly refused: readonly PrunePassRefusal[];
  /** Answer order per text, then key order; no unit is affected by one. */
  readonly rejected: readonly PrunePassRejection[];
  /**
   * The removals the survivor gate refused once every decision was in
   * (ISSUE-174), in plan order: L1's, the dedupe's, then the judged answers'.
   *
   * A verdict is where this bites hardest. The L1 families keep a content
   * class's copy alive and then offer it as an ask row; a `forgetall` on that row
   * would take the class's last live copy, and every lane would report success.
   * A cancelled unit is kept and is named here — never silently dropped.
   *
   * Always present on a document `mergePass` builds, and empty when nothing was
   * contradicted. Optional on the TYPE because a hand-built document (a test
   * fixture, a host replay) may predate the gate; absent reads as "none", which
   * is exactly the document those callers meant.
   */
  readonly cancellations?: readonly RemovalCancellation<Level1Rule | DedupeClass | "verdict">[];
}

/**
 * The decision document. L1's removals go in first, then the superseded-read
 * dedupe's, and an L2 answer never overrides either: a byte proof outranks a
 * verdict (today the ask cannot offer a unit either proof claimed, so the guard
 * is a second lock). `keepall` produces nothing.
 *
 * Then the survivor gate runs over the WHOLE document (ISSUE-174). The prune
 * pass already gated the pre-answer lanes; this second read is what catches a
 * VERDICT. L1 keeps one copy of every content class and then offers it as an ask
 * row by construction, so `forgetall` on that row would delete the class's last
 * live copy with every lane reporting success. A cancelled unit is kept, its
 * verdict is recorded as cancelled, and the refusal is named — never silent.
 *
 * `@internal` — `applyPruneAnswers` is the entry point; this is the second half
 * of it, exported so the answer reader and this document share one module graph.
 *
 * Under `grammar: "nokeepall"` every verdict is normalized BEFORE any removal is
 * merged (`./two-verdict.ts`): a whole-range `keeplines` becomes a clean
 * `keepall`, so it is neither counted as a removal nor priced, and any other
 * action the grammar does not offer becomes a terminal `action-not-in-grammar`
 * refusal. That refusal is recorded here, after the ask read the row, so the
 * row is never re-asked and the pass spends no second reply on it.
 */
export function mergePass(
  plan: PrunePassPlan,
  verdicts: ReadonlyMap<UnitId, WireAnswer>,
  refusals: ReadonlyMap<UnitId, PrunePassRefusal>,
  rejected: readonly PrunePassRejection[],
): PrunePassApplication {
  const normalized = normalizeAnswers(plan, verdicts, refusals);
  const removed = new Map<UnitId, PruneRemoval>();
  for (const removal of plan.l1.removals) {
    removed.set(removal.unitId, {
      unitId: removal.unitId, origin: "l1", action: "forgetall",
      rule: removal.rule, proof: removal.proof,
    });
  }
  for (const removal of plan.dedupe.removals) {
    removed.set(removal.unitId, {
      unitId: removal.unitId, origin: "dedupe", rule: removal.rule, proof: removal.proof,
    });
  }
  for (const [unitId, answer] of normalized.verdicts) {
    if (removed.has(unitId)) continue;
    const removal = l2Removal(unitId, answer);
    if (removal !== null) removed.set(unitId, removal);
  }

  // The gate over the merged document. Claims: the pre-answer lanes keep the
  // survivor they named; a judged removal claims no copy at all (the agent's
  // answer is about VALUE, not about a duplicate), so only a whole-unit forget
  // is subject to content survival, and a partial-line answer never is. The
  // unlocated units' declared identities ride along (ISSUE-333): a forgetall
  // on a located twin whose unlocated twin also forgets must not erase the
  // class before the apply-time source check ever runs.
  const claims: RemovalClaim<Level1Rule | DedupeClass | "verdict">[] = [];
  for (const removal of removed.values()) {
    const claim = claimOf(removal);
    if (claim !== null) claims.push(claim);
  }
  const cancellations = gateRemovals(plan.contents, claims,
    unlocatedIdentities(plan.units, plan.contents));
  const cancelled = new Set(cancellations.map(entry => entry.unitId));
  for (const unitId of cancelled) removed.delete(unitId);

  const removals: PruneRemoval[] = [];
  const kept: UnitId[] = [];
  const denied: PrunePassRefusal[] = [];
  for (const unit of plan.units) {
    const removal = removed.get(unit.id);
    if (removal !== undefined && !cancelled.has(unit.id)) removals.push(removal);
    // A cancelled unit is kept: the pass could not prove its removal was safe,
    // and keeping the content is always the safe side (ISSUE-174).
    else kept.push(unit.id);
    const refusal = normalized.refusals.get(unit.id);
    if (refusal !== undefined) denied.push(refusal);
  }
  return { removals, kept, refused: denied, rejected, cancellations };
}

/**
 * The ask's own apply document (ADR-0054 decision 5).
 *
 * The opencode ask tables a bounded set of the request's live units, never the
 * pass planner's numbered list, so it cannot hand `mergePass` a `PrunePassPlan`:
 * its rows name different units. This builds the same document over the units
 * the ask could have tabled: one removal per readable `forgetall` through
 * `l2Removal`, every other unit kept.
 *
 * A `keeplines` verdict is kept, never applied (ADR-0054 decision 2). The host
 * removes whole messages, so applying a partial keep would drop the whole node
 * while the archive and the receipt name only the dropped lines; the kept lines
 * would leave the request unnamed. `forgetlines` and `keepall` keep too — the
 * entry reader already normalized `jsonl-20-nokeepall`, and this document
 * invents no action.
 *
 * The survivor gate is `mergePass`'s own (`gateRemovals` over
 * `locateContents`): a `forgetall` that would leave a content class with no live
 * copy is cancelled, its unit is kept, and the cancellation is named — never
 * silent. No L1 and no dedupe run here: the ask judged units, and the document
 * names only what it decided.
 *
 * `refused` and `rejected` are empty by construction: only readable answers
 * enter the map, and a unit no answer names is kept. The ask's own refusals and
 * stray keys are the adapter's journal record, which the guard reads neither of.
 */
export function applicationFromVerdicts(input: {
  /** Every live unit the ask could have tabled, in transcript order. */
  readonly units: readonly ProcessingUnit[];
  /** The snapshot's nodes: the bytes the survivor gate locates each unit in. */
  readonly nodes: readonly ToolResultNode[];
  /** One readable verdict per unit; only a `forgetall` becomes a removal. */
  readonly verdicts: ReadonlyMap<UnitId, WireAnswer>;
}): PrunePassApplication {
  const removed = new Map<UnitId, PruneRemoval>();
  for (const [unitId, answer] of input.verdicts) {
    if (answer.verdict.action !== "forgetall") continue;
    const removal = l2Removal(unitId, answer);
    if (removal !== null) removed.set(unitId, removal);
  }

  // The gate `mergePass` runs, over the same copies: only a whole-unit forget is
  // a content-survival claim, and a cancelled unit is kept (ISSUE-174). The
  // unlocated units' declared identities ride along too (ISSUE-333).
  const claims: RemovalClaim<Level1Rule | DedupeClass | "verdict">[] = [];
  for (const removal of removed.values()) {
    const claim = claimOf(removal);
    if (claim !== null) claims.push(claim);
  }
  const copies = locateContents(input.units, input.nodes);
  const cancellations = gateRemovals(copies, claims, unlocatedIdentities(input.units, copies));
  const cancelled = new Set(cancellations.map(entry => entry.unitId));

  const removals: PruneRemoval[] = [];
  const kept: UnitId[] = [];
  for (const unit of input.units) {
    const removal = removed.get(unit.id);
    if (removal !== undefined && !cancelled.has(unit.id)) removals.push(removal);
    // A cancelled unit is kept: the gate could not prove its removal safe, and
    // keeping the content is always the safe side (ISSUE-174).
    else kept.push(unit.id);
  }
  return { removals, kept, refused: [], rejected: [], cancellations };
}

/** One pass's answers with the grammar gate applied before any merge. */
interface NormalizedAnswers {
  readonly verdicts: ReadonlyMap<UnitId, WireAnswer>;
  readonly refusals: ReadonlyMap<UnitId, PrunePassRefusal>;
}

/**
 * The answer gate, applied to every verdict before a removal is merged. A
 * whole-range `keeplines` becomes a clean `keepall` on every grammar: it removes
 * nothing, so it is never counted as a removal or priced. Under `nokeepall` the
 * gate additionally refuses every action that grammar does not offer, as a
 * terminal `action-not-in-grammar` keeps. The refusal is filed under the row's
 * own index so the record counts it and the kept list still names the unit.
 *
 * Nothing here re-reads an answer or mutates the caller's maps.
 */
function normalizeAnswers(
  plan: PrunePassPlan,
  verdicts: ReadonlyMap<UnitId, WireAnswer>,
  refusals: ReadonlyMap<UnitId, PrunePassRefusal>,
): NormalizedAnswers {
  // Every two-verdict spelling (`nokeepall`, `jsonl-20-nokeepall`) gates the
  // same way; only `3option` carries the three-way contract (ISSUE-522). The
  // predicate is core's one decision, so a future grammar id is not two-verdict
  // by accident.
  const twoVerdict = isTwoVerdictGrammar(plan.grammar ?? "3option");
  const units = new Map(plan.units.map(unit => [unit.id, unit] as const));
  const indices = new Map(plan.askRows.map(row => [row.unit.id, row.index] as const));
  const normalized = new Map<UnitId, WireAnswer>();
  const refused = new Map(refusals);
  for (const [unitId, answer] of verdicts) {
    // On the shipped grammar only the both-ends shape is normalized; its
    // `keepall` and `forgetlines` are the grammar's own answers and cross as-is.
    if (!twoVerdict && answer.verdict.action !== "keeplines") {
      normalized.set(unitId, answer);
      continue;
    }
    const outcome = normalizeWireTwoVerdictAnswer(answer, lineCountOf(units.get(unitId)));
    if (outcome.status === "answered") {
      normalized.set(unitId, outcome.answer);
      continue;
    }
    const index = indices.get(unitId);
    if (index === undefined) {
      throw new RangeError(
        `A ${String(plan.grammar)} verdict names unit ${unitId}, which this pass never asked about.`,
      );
    }
    refused.set(unitId, {
      unitId, index, code: outcome.code, message: outcome.message,
      wireCode: null, answerIndex: null,
    });
  }
  return { verdicts: normalized, refusals: refused };
}

/** A unit's own positive line count, or null for a zero-line/absent unit. */
function lineCountOf(unit: ProcessingUnit | undefined): number | null {
  const range = unit?.span.lineRange;
  if (range === null || range === undefined) return null;
  const count = range.endLineInclusive - range.startLine + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/**
 * One merged removal as the gate reads it, or `null` when the gate must not see
 * it at all.
 *
 *   - an L1 removal names the copy its proof keeps, and only a whole-unit proof
 *     may be cancelled for content loss;
 *   - a dedupe removal names its witness (`witnessUnitId`) — except a call echo,
 *     whose witness is the request message, outside the unit set, so losing the
 *     last unit copy does not void its proof;
 *   - an L2 `forgetall` claims no copy, so it IS subject to content survival —
 *     that is bug 3's fix, and it is why the removed unit's own bytes decide;
 *   - an L2 `keeplines`/`forgetlines` removes lines, not the unit, so it never
 *     enters the gate: the unit's remaining lines keep that content alive.
 */
function claimOf(
  removal: PruneRemoval,
): RemovalClaim<Level1Rule | DedupeClass | "verdict"> | null {
  if (removal.origin === "l1") {
    if (removal.rule === "stale-exact-reread" && removal.proof.rule === "stale-exact-reread") {
      return { unitId: removal.unitId, rule: removal.rule, origin: "l1",
        survivorUnitId: removal.proof.survivorUnitId,
        cancelsOnContentLoss: true };
    }
    if (removal.rule === "byte-identical-duplicates"
      && removal.proof.rule === "byte-identical-duplicates") {
      return { unitId: removal.unitId, rule: removal.rule, origin: "l1",
        survivorUnitId: removal.proof.keptUnitId,
        cancelsOnContentLoss: true };
    }
    return { unitId: removal.unitId, rule: removal.rule, origin: "l1",
      survivorUnitId: null, cancelsOnContentLoss: false };
  }
  if (removal.origin === "dedupe") {
    return { unitId: removal.unitId, rule: removal.rule, origin: "dedupe",
      survivorUnitId: removal.proof.witnessUnitId,
      // The call echo's surviving copy is the request message, which is never a
      // unit; content survival over units would cancel every call echo.
      cancelsOnContentLoss: removal.rule !== "call-echo" };
  }
  if (removal.action !== "forgetall") return null;
  return { unitId: removal.unitId, rule: "verdict", origin: "l2",
    survivorUnitId: null, cancelsOnContentLoss: true };
}

/** The L2 removal one answered verdict claims, or null for `keepall`. */
function l2Removal(unitId: UnitId, answer: WireAnswer): PruneL2Removal | null {
  const verdict = answer.verdict;
  if (verdict.action === "keepall") return null;
  if (verdict.action === "keeplines") {
    return {
      unitId, origin: "l2", action: "keeplines", ranges: verdict.ranges,
      answeredInRound: verdict.answeredInRound,
      ...(answer.keeplinesSummary === undefined ? {} : { keeplinesSummary: answer.keeplinesSummary }),
    };
  }
  if (verdict.action === "forgetlines") {
    return {
      unitId, origin: "l2", action: "forgetlines", ranges: verdict.ranges,
      answeredInRound: verdict.answeredInRound,
      ...(answer.forgetlinesSummary === undefined
        ? {} : { forgetlinesSummary: answer.forgetlinesSummary }),
    };
  }
  return {
    unitId, origin: "l2", action: "forgetall", summary: verdict.summary,
    answeredInRound: verdict.answeredInRound,
  };
}
