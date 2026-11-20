import type { NodeId, ToolCallId, UnitId } from "../../types/identity.js";
import type { TranscriptNode } from "../../types/transcript.js";
import type { ProcessingUnit } from "../../units/types.js";

/**
 * The superseded-read dedupe pass's declarations (ADR-0037; ISSUE-145).
 *
 * One record class per object the evidence measured, each with one identity key
 * and one guard. Phase 1 ships class 2 only (`superseded-by-reread`): the four
 * names stay declared here so a plan's shape does not change when the next class
 * lands, and every switch is absent or false unless an operator turns one on.
 *
 * Nothing in this module reads bytes: identity comes from node metadata and from
 * declarations the mount supplies, never from content, role or wording
 * (ADR-0037 decision 2 and 5).
 */
export type DedupeClass =
  /** Class 2 — an earlier read of a path whose later read covered the whole file. */
  | "superseded-by-reread"
  /**
   * Class 1 — a tool call's arguments echoed by its own result. Only the EXACT
   * echo is plannable: the result's payload must restate the declared argument
   * payload and add no state of its own (ADR-0037 decision 2, class 1; the owner
   * ruling of 2026-11-06 narrows the class to this case).
   */
  | "call-echo"
  /** Class 3 — an agent launch receipt; blocked on its probe. */
  | "launch-receipt"
  /** Class 4 — repeated harness bookkeeping; outside this record's scope (needs an ADR). */
  | "harness-copy";

/** Every class, in the order the record's counts and its config keys spell them. */
export const DEDUPE_CLASSES = [
  "superseded-by-reread",
  "call-echo",
  "launch-receipt",
  "harness-copy",
] as const satisfies readonly DedupeClass[];

/** Per-class switch; absent or false plans nothing. Values come from config. */
export interface DedupeClasses {
  readonly supersededByReread?: boolean;
  readonly callEcho?: boolean;
  readonly launchReceipt?: boolean;
  readonly harnessCopy?: boolean;
}

export interface DedupeInput {
  /** L1's kept units, transcript order. Duplicate ids are ignored (first position wins). */
  readonly units: readonly ProcessingUnit[];
  /** Every transcript node: a witness may be a message or a below-floor result. */
  readonly nodes: readonly TranscriptNode[];
  readonly classes: DedupeClasses;
  /**
   * The node ids L1 REMOVED in this same pass (ISSUE-174). A removed node is
   * never a witness: the pass deletes it in the same checkpoint-revert, so a
   * proof citing it would name a copy the application itself destroys. Omitted
   * means no node was removed, which is the reading a caller with no L1 layer
   * (a standalone dedupe probe) intends.
   */
  readonly removedNodeIds?: ReadonlySet<NodeId>;
}

/**
 * Class 2's byte fact: a later read of `pathKey` covered the whole file with no
 * write to that path in between. `witnessIndex` is the witness's position in the
 * snapshot — transcript order is the clock — and it is a fact for telemetry
 * only: the guard re-derives the same fact from the snapshot and never reads a
 * plan's claim (ADR-0037 decision 2; `guard/checks-proofs.ts`).
 */
export interface SupersededByRereadFact {
  readonly kind: "superseded-by-reread";
  readonly pathKey: string;
  /** The node index of the newer full read: transcript order is the clock. */
  readonly witnessIndex: number;
}

/**
 * Class 1's fact: the result's payload is an exact restatement of the argument
 * payload its own call declared, so the result adds nothing the call did not
 * already say. `witnessIndex` is the request message's position in the snapshot
 * — transcript order is the clock — and it is a fact for telemetry only: the
 * guard re-derives the same equality and the same live request from the
 * snapshot (`guard/checks-proofs.ts`), never from a plan's claim.
 */
export interface CallEchoFact {
  readonly kind: "call-echo";
  readonly callId: ToolCallId;
  /** The node index of the assistant message that declared the call. */
  readonly witnessIndex: number;
}

/**
 * The fact a removal rests on. A discriminated union so each later class adds
 * its own member without touching the plan's shape.
 */
export type DedupeFact = SupersededByRereadFact | CallEchoFact;

/**
 * Why one unit is an older copy. `identityKey` is the class's shared key (the
 * `pathKey` for class 2, the `callId` for class 1), carried for telemetry;
 * `witnessNodeId` and `witnessUnitId` name the copy that stays — for class 2
 * the later read, for class 1 the assistant message that declared the call. The
 * unit id is null when the witness is below the size floor or is a message, so
 * no unit exists for it at all.
 */
export interface DedupeProof {
  readonly rule: DedupeClass;
  /** The shared key that made the two copies comparable, for telemetry only. */
  readonly identityKey: string;
  readonly witnessNodeId: NodeId;
  /** Null when the witness is below the floor or is a message (no unit exists). */
  readonly witnessUnitId: UnitId | null;
  /** What the guard re-derives; never a rendering and never a receipt. */
  readonly fact: DedupeFact;
}

/** One planned removal: the older copy's unit and the fact that supersedes it. */
export interface DedupeRemoval {
  readonly unitId: UnitId;
  readonly rule: DedupeClass;
  readonly proof: DedupeProof;
}

/**
 * Why a class-1 subject was NOT planned, by the clause whose test it failed.
 * A refusal is a named answer, never a silent skip: "the result echoed its
 * arguments except for a previous-state field" and "the result's argument was
 * never declared" are different facts, and a reader must be able to tell them
 * apart. The 15,346 non-identical pairs ISSUE-151 measured all land in
 * `call-echo-previous-state` (or one of the shape codes beside it).
 */
export type DedupeRefusalReason =
  /** The node declares no `callArguments`; the request payload is unknown. */
  | "call-echo-arguments-absent"
  /** The declared argument payload is not a JSON object. */
  | "call-echo-arguments-invalid"
  /** The result's bytes are not a JSON object. */
  | "call-echo-result-invalid"
  /** The result names a `todos` list but the request declares none. */
  | "call-echo-request-list-absent"
  /** The request names a `todos` list but the result declares none. */
  | "call-echo-result-list-absent"
  /** The two lists differ: an item was added, removed, reordered or changed. */
  | "call-echo-list-differs"
  /** The result's `oldTodos` holds state the request never declared. */
  | "call-echo-previous-state"
  /** The result carries a field the request never declared. */
  | "call-echo-result-adds-state"
  /** The result omits a field the request declared. */
  | "call-echo-result-omits-arguments"
  /** A declared field's value differs between the request and the result. */
  | "call-echo-result-differs"
  /** The unit is a slice, so removing it would not remove the whole result. */
  | "call-echo-not-whole-result"
  /** No live assistant message names the call the result answers. */
  | "call-echo-request-not-live";

/** One subject a class refused, named by its clause. */
export interface DedupeRefusal {
  readonly unitId: UnitId;
  readonly rule: DedupeClass;
  readonly reason: DedupeRefusalReason;
}

/**
 * What one dedupe pass decides: its removals in transcript order, one entry per
 * unit, a count per class, and the class-1 subjects it refused by name. A class
 * that is off, or that plans nothing, is a zero — the record always carries
 * every class's key. Class 2 has no refusal vocabulary: a read that is not a
 * witness is simply not a subject.
 */
export interface DedupePlan {
  readonly removals: readonly DedupeRemoval[];
  readonly counts: Readonly<Record<DedupeClass, number>>;
  readonly refusals: readonly DedupeRefusal[];
}
