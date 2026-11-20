/**
 * The survivor gate (ISSUE-174).
 *
 * Every removal decision in the prune pass is a proof about ONE copy: "a later
 * read carries these same bytes" (L1 family 2), "another unit holds exactly
 * these bytes" (L1 family 3), "a later whole-file read supersedes this one"
 * (the dedupe). Each proof is true against the snapshot it was computed on, and
 * the lanes make their decisions one after another over that same snapshot — so
 * the union of individually-true proofs can remove every copy of a value. That
 * is the defect this module closes: a plan is not the sum of its proofs.
 *
 * The gate runs AFTER the removal decisions are made and BEFORE anything is
 * applied. It asks two questions, and a "no" cancels the removal:
 *
 *   1. content survival — the content this removal deletes keeps at least one
 *      live copy among the units that will remain. Only a class whose every live
 *      member is being removed is a contradiction, and this rule keeps its
 *      newest removable member.
 *   2. survivor survival — the copy this removal's own proof names as the one
 *      that stays stays. A proof that names a survivor which this same plan
 *      removes has lost its licence.
 *
 * A cancelled removal is never repaired and never silent: it comes back as a
 * `RemovalCancellation` the caller carries in its plan document. A plan with no
 * contradiction yields an empty list, so a pass that was already safe is
 * byte-identical to the pass before this module existed.
 *
 * What this gate deliberately does not police. A removal licensed by its own
 * evidence rather than by a second copy — a closed episode's miss body, a judged
 * `forgetall` on a value held once — claims nothing about a copy, so losing the
 * content cannot void it. Those claims are marked `cancelsOnContentLoss: false`
 * and only rule 2 can reach them. A partial-line verdict is not a whole-unit
 * deletion at all, so it never enters the gate (the unit's other lines live).
 *
 * Conservative by construction: every uncertain answer keeps content. Equal
 * content is always reported equal (hash, then length, then the bytes when the
 * caller holds them), and a unit whose bytes cannot be located is never a
 * removal subject — `locateContents` skips it here exactly as `level1.ts` does.
 * An unlocated unit is never a provable SURVIVOR either: its node holds other
 * bytes than it declares, so a class with an unlocated twin survives through
 * its located members alone (`unlocatedIdentities` carries the declared
 * identity into rule 1, ISSUE-333).
 */

import type { NoteId, Sha256, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import { equalBytes, sliceBytes } from "../util/bytes.js";
import { sha256Sync } from "../util/hash.js";
import type { DedupeClass, DedupePlan } from "./dedupe/types.js";
import type { Level1Removal, Level1Rule } from "./types.js";

/**
 * One unit's content, as the gate compares it. `content` is absent when the
 * caller holds only the identity (the merged verdict document does), and then
 * the comparison is sha256 plus byte length.
 */
export interface UnitContent {
  readonly unitId: UnitId;
  readonly contentSha256: Sha256;
  readonly byteLength: number;
  /** The bytes themselves; omitted when the caller carries identity only. */
  readonly content?: Uint8Array;
}

/** Why one removal was cancelled. */
export type CancellationReason =
  /** The content the removal deletes would lose its last live copy. */
  | "last-live-copy"
  /** The copy this removal's own proof names as surviving is removed by the same plan. */
  | "survivor-removed";

/** One planned removal, as the gate reads it. */
export interface RemovalClaim<R extends string = string> {
  readonly unitId: UnitId;
  readonly rule: R;
  /**
   * The unit this removal's proof names as the copy that stays — L1's
   * `survivorUnitId`/`keptUnitId`, the dedupe's witness. `null` when the proof
   * names no single copy (a closed episode, a judged verdict).
   */
  readonly survivorUnitId: UnitId | null;
  /**
   * Whether losing the last live copy of this unit's content cancels this
   * removal. False only where the proof's own claim is not "another copy
   * exists" — a closed episode proved these bytes absent.
   */
  readonly cancelsOnContentLoss: boolean;
  /** The lane that planned it: L1's families or the superseded-read dedupe. */
  readonly origin: RemovalOrigin;
}

/** One removal the gate refused, with the evidence it refused on. */
export interface RemovalCancellation<R extends string = string> {
  readonly unitId: UnitId;
  readonly rule: R;
  /** The lane that planned the removal this cancellation refuses. */
  readonly origin: RemovalOrigin;
  readonly reason: CancellationReason;
  /** The kept unit's content identity; the same identity its cancelled copy carries. */
  readonly contentSha256: Sha256;
  readonly byteLength: number;
  /** The unit whose own removal voided the proof; null for a content-loss cancel. */
  readonly conflictsWithUnitId: UnitId | null;
}

/**
 * The lane a removal came from. `l1` and `dedupe` plan before any model answer
 * exists; `l2` is a judged verdict read from a reply. The gate treats all three
 * the same way — a removal is a removal — and the name is evidence.
 */
export type RemovalOrigin = "l1" | "dedupe" | "l2";

/**
 * One cancellation as a plan document carries it. The alias is deliberately the
 * same shape: a plan's cancellations and a gate's cancellations are one
 * vocabulary, so nothing has to be translated between evidence and plan.
 */
export type PlanCancellation<R extends string = string> = RemovalCancellation<R>;

/**
 * Reads every unit's content bytes out of the nodes, in the caller's unit order.
 * A unit whose node is absent, whose declared source hash names other bytes, or
 * whose span falls outside the node is skipped: it is unprovable, so it is never
 * a removal subject and never a survivor candidate either.
 */
export function locateContents(
  units: readonly {
    readonly id: UnitId;
    readonly nodeId: string;
    readonly source: { readonly sha256: string; readonly byteLength: number };
    readonly span: { readonly byteRange: {
      readonly startByte: number; readonly endByteExclusive: number } };
  }[],
  nodes: readonly ToolResultNode[],
): readonly UnitContent[] {
  const byId = new Map<string, ToolResultNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const located: UnitContent[] = [];
  for (const unit of units) {
    const node = byId.get(unit.nodeId);
    if (node === undefined) continue;
    if (unit.source.sha256 !== node.sha256 || unit.source.byteLength !== node.bytes.length) continue;
    const { startByte, endByteExclusive } = unit.span.byteRange;
    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByteExclusive)) continue;
    if (startByte < 0 || endByteExclusive <= startByte || endByteExclusive > node.bytes.length) continue;
    const content = sliceBytes(node.bytes, startByte, endByteExclusive);
    located.push({ unitId: unit.id, contentSha256: sha256Sync(content),
      byteLength: content.length, content });
  }
  return located;
}

/**
 * The same contents without their bytes: what a plan document carries so the
 * merged verdict step can run the same gate without holding the transcript
 * twice. The identity pair is the one the L1 families compare first, so the
 * gate's answer is unchanged wherever it is read.
 */
export function contentIdentities(copies: readonly UnitContent[]): readonly UnitContent[] {
  return copies.map(copy => ({
    unitId: copy.unitId, contentSha256: copy.contentSha256, byteLength: copy.byteLength,
  }));
}

/**
 * The declared content identities of the units `locateContents` could NOT
 * locate (ISSUE-333): the source hash the unit declared at segmentation, and
 * the unit's own span length. A declaration names the bytes the unit was
 * planned over; when the node no longer matches it, the claim is stale, not
 * invented. These identities are claims, not proofs: rule 1 reads them as class
 * membership that can never survive, never as a live copy. A segment's source
 * hash names the whole node, so its identity can only match a class of the same
 * length — a whole-node span — never a partial class by accident.
 */
export function unlocatedIdentities(
  units: readonly {
    readonly id: UnitId;
    readonly byteLength: number;
    readonly source: { readonly sha256: string };
  }[],
  located: readonly UnitContent[],
): readonly UnitContent[] {
  const locatedIds = new Set(located.map(copy => copy.unitId));
  const identities: UnitContent[] = [];
  for (const unit of units) {
    if (locatedIds.has(unit.id)) continue;
    identities.push({ unitId: unit.id, contentSha256: unit.source.sha256,
      byteLength: unit.byteLength });
  }
  return identities;
}

/** L1's removals as the gate reads them. */
export function l1Claims(
  removals: readonly Level1Removal[],
): readonly RemovalClaim<Level1Rule>[] {
  return removals.map(removal => {
    if (removal.rule === "stale-exact-reread") {
      return { unitId: removal.unitId, rule: removal.rule, origin: "l1" as const,
        survivorUnitId: removal.proof.survivorUnitId, cancelsOnContentLoss: true };
    }
    if (removal.rule === "byte-identical-duplicates") {
      return { unitId: removal.unitId, rule: removal.rule, origin: "l1" as const,
        survivorUnitId: removal.proof.keptUnitId, cancelsOnContentLoss: true };
    }
    // A closed episode proved these bytes absent. Nothing is claimed about a
    // copy, so losing this content cannot void that proof.
    return { unitId: removal.unitId, rule: removal.rule, origin: "l1" as const,
      survivorUnitId: null, cancelsOnContentLoss: false };
  });
}

/** The dedupe's removals as the gate reads them: each names its witness. */
export function dedupeClaims(plan: DedupePlan): readonly RemovalClaim<DedupeClass>[] {
  return plan.removals.map(removal => ({
    unitId: removal.unitId, rule: removal.rule, origin: "dedupe" as const,
    // Class 2's witness is a newer snapshot of the same path, so its bytes
    // differ by construction: the claim is about TIME, not about a content copy,
    // and it stays cancellable when the class would vanish because keeping
    // content is always the safe side.
    //
    // Class 1's witness is the request message, outside the unit set. Rule 1
    // compares units only, so applying it here would cancel every call echo —
    // the request can never be one of the units that remain. Its own proof is
    // the survival guarantee ("the arguments stay untouched"), so it does not
    // enter content survival.
    survivorUnitId: removal.proof.witnessUnitId,
    cancelsOnContentLoss: removal.rule !== "call-echo",
  }));
}

/**
 * The gate itself: every planned removal, re-checked against the set that will
 * remain. Pure and deterministic — the same copies and the same claims always
 * yield the same cancellations, in the caller's order.
 *
 * Rule 2 runs FIRST, and the ordering is a product decision. When an agent's own
 * verdict removes the copy an automatic proof named as its survivor, the PROOF
 * gives way, never the verdict (ADR-0006: the agent judges what leaves its
 * context). A byte proof was true about a snapshot; once its survivor leaves it
 * simply stops applying, the duplicated copy comes back, and no content is lost
 * either way.
 *
 * Rule 1 is then the backstop: cancel a removal only if a whole content class
 * would vanish. A class of one is never touched — a unique value's removal is
 * licensed by its own evidence (an episode proved it absent), not by a claim
 * that another copy exists. A class with an UNLOCATED twin is not a class of
 * one: the twin claims the same identity but can never prove a live copy, so
 * the class survives through its located members alone (ISSUE-333).
 */
export function gateRemovals<R extends string>(
  copies: readonly UnitContent[],
  claims: readonly RemovalClaim<R>[],
  unlocated: readonly UnitContent[] = [],
): readonly RemovalCancellation<R>[] {
  const byUnit = new Map<UnitId, UnitContent>();
  for (const copy of copies) if (!byUnit.has(copy.unitId)) byUnit.set(copy.unitId, copy);
  const byClaim = new Map<UnitId, RemovalClaim<R>>();
  for (const claim of claims) if (!byClaim.has(claim.unitId)) byClaim.set(claim.unitId, claim);

  const planned = new Set(claims.map(claim => claim.unitId));
  const cancellations: RemovalCancellation<R>[] = [];
  const cancel = (
    claim: RemovalClaim<R>, reason: CancellationReason, conflictsWithUnitId: UnitId | null,
  ): void => {
    planned.delete(claim.unitId);
    const copy = byUnit.get(claim.unitId);
    cancellations.push({
      unitId: claim.unitId, rule: claim.rule, reason, origin: claim.origin,
      // An unlocated unit carries no identity; its removal is not what this rule
      // is about, so nothing is invented for it.
      contentSha256: copy?.contentSha256 ?? "",
      byteLength: copy?.byteLength ?? 0,
      conflictsWithUnitId,
    });
  };

  // Rule 2 — proof validity. A removal whose named survivor this plan also
  // removes proves nothing about this plan, so it is the removal that gives way.
  // Iterated to a fixed point: cancelling one removal makes its own survivor
  // live, which can restore another removal's licence. It only ever cancels, so
  // it terminates after at most one pass over the claims.
  for (let changed = true; changed;) {
    changed = false;
    for (const claim of claims) {
      if (!planned.has(claim.unitId)) continue;
      const survivor = claim.survivorUnitId;
      if (survivor === null || survivor === claim.unitId) continue;
      if (!planned.has(survivor)) continue;
      cancel(claim, "survivor-removed", survivor);
      changed = true;
    }
  }

  // Rule 1 — content survival, as the backstop. Only a class whose every live
  // member is still planned is a contradiction; the newest member whose own
  // proof allows it is the one that stays. An unlocated twin (ISSUE-333) claims
  // the class's identity but its node holds other bytes, so it is never a live
  // copy: a class with one survives through its located members alone, and the
  // class-of-one skip does not apply to it.
  for (const members of contentClasses(copies)) {
    const head = members[0];
    if (head === undefined) continue;
    const hasUnlocatedTwin = unlocated.some(copy => sameContent(head, copy));
    if (members.length < 2 && !hasUnlocatedTwin) continue;
    const classClaims: RemovalClaim<R>[] = [];
    let everyMemberPlanned = true;
    for (const member of members) {
      const claim = byClaim.get(member.unitId);
      if (claim === undefined || !planned.has(member.unitId)) { everyMemberPlanned = false; break; }
      classClaims.push(claim);
    }
    if (!everyMemberPlanned) continue;
    const newest = [...classClaims].reverse().find(claim => claim.cancelsOnContentLoss);
    if (newest !== undefined) cancel(newest, "last-live-copy", null);
  }
  return cancellations;
}

/**
 * A gate result as the plan document carries it: the same rows, in the same
 * order, with the lane that planned each removal. A caller that also wants the
 * per-rule type keeps the gate's own return; this is only the plan's shape.
 */
export function planCancellations<R extends string>(
  cancellations: readonly RemovalCancellation<R>[],
): readonly PlanCancellation[] {
  return cancellations.map(cancellation => ({ ...cancellation }));
}

/**
 * The content classes among these copies, each class in the caller's order and
 * the classes in first-appearance order. Equality is the one L1 uses: same
 * length, same sha256, and — when both sides hold bytes — byte equality.
 */
function contentClasses(copies: readonly UnitContent[]): readonly (readonly UnitContent[])[] {
  // Hash bucket (ISSUE-383): the key carries sha256 and length, so a bucket
  // holds one class unless two distinct contents collide on both; `sameContent`
  // inside the bucket keeps that case exact. `classes` keeps first-appearance
  // order — the gate's cancellation order reads it — and each class's first
  // member stays its head.
  const classes: UnitContent[][] = [];
  const byContent = new Map<string, UnitContent[][]>();
  for (const copy of copies) {
    const key = `${copy.contentSha256}:${copy.byteLength}`;
    const bucket = byContent.get(key);
    const match = bucket?.find(members => {
      const head = members[0];
      return head !== undefined && sameContent(head, copy);
    });
    if (match === undefined) {
      const fresh = [copy];
      classes.push(fresh);
      if (bucket === undefined) byContent.set(key, [fresh]);
      else bucket.push(fresh);
    } else match.push(copy);
  }
  return classes;
}

/** Whether two units hold the same bytes, or the same identity when bytes are absent. */
function sameContent(left: UnitContent, right: UnitContent): boolean {
  if (left.contentSha256 !== right.contentSha256) return false;
  if (left.byteLength !== right.byteLength) return false;
  if (left.content !== undefined && right.content !== undefined) {
    return equalBytes(left.content, right.content);
  }
  return true;
}

/** Re-exported so a caller can name the note id it filed a cancellation under. */
export type CancellationNoteId = NoteId;
