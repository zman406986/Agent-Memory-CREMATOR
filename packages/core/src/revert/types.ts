import type { NodeId, NoteId, Revision } from "../types/identity.js";

/** One transcript entry in order. `id` is the entry key, `nodeId` the node it names. */
export interface RevertItem {
  readonly id: NodeId;
  readonly nodeId: NodeId;
  readonly byteLength: number;
  /**
   * The bytes this node frees when forgotten: the dropped ranges of its removal
   * (ISSUE-509). Absent means the whole node — a `forgetall` or any whole-node
   * removal. A partial keep drops only part of the node; the remainder stays in
   * the request and is priced as kept bytes, never as freed ones.
   */
  readonly freedByteLength?: number;
}

/** A receipt anchored to the survivor before it; null means the transcript head. */
export interface RevertAppend {
  readonly afterNodeId: NodeId | null;
  readonly noteId: NoteId;
}

/**
 * One single-node replacement: the forgotten node itself and the receipt that
 * takes its place (ADR-0036). A host that refuses the batched span applies this
 * ordered list instead — one content-only replacement per node, that node's own
 * id kept, its own receipt carried, and no survivor re-emitted.
 */
export interface RevertNodeAppend {
  readonly nodeId: NodeId;
  readonly noteId: NoteId;
}

/** Salvage arithmetic for one candidate cut (design-protocol §2). */
export interface RevertCost {
  readonly cutIndex: number;
  readonly freedBytes: number;
  readonly keptBytes: number;
  readonly receiptBytes: number;
  readonly netFreedBytes: number;
}

export interface RevertChoice {
  readonly cutIndex: number;
  readonly cost: RevertCost;
}

/**
 * What the host receives for a checkpoint-revert (ADR-0004, ADR-0007): the
 * prefix before `cutIndex` stays verbatim, survivors follow in order, and each
 * receipt appends at its anchor. Nothing inside the cached prefix is rewritten.
 *
 * The plan carries both applicable shapes on purpose (ADR-0036): `appends` is
 * the batched single-span rebuild, and `perNode` is the same approved revert as
 * one single-node replacement per forgotten node. The host tries the batched
 * shape first and falls back to the per-node one only on a
 * `multi-node-tool-result` refusal, so the mode the host applies is decided by
 * the host's own rule — never derived here. Both shapes name the same receipts.
 */
export interface RevertPlan {
  /** Nodes [0, cutIndex) stay verbatim: the salvage. */
  readonly cutIndex: number;
  /** Nodes [cutIndex, n) minus the forgotten ones, in transcript order. */
  readonly survivors: readonly NodeId[];
  readonly appends: readonly RevertAppend[];
  /** One single-node replacement per forgotten node, in transcript order. */
  readonly perNode: readonly RevertNodeAppend[];
  readonly cost: RevertCost;
  readonly baseRevision: Revision;
}

/** Pure inputs to the cut chooser; indices are transcript positions. */
export interface RevertInput {
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  /**
   * The node identity each forgotten index is meant to name (ISSUE-322). When
   * present, the chooser cross-checks `nodes[index].nodeId` against it, so a
   * stale index that now marks a different node is a named error rather than a
   * silent wrong cut. Absent means the caller declared no identity and only the
   * range check applies.
   */
  readonly forgottenNodeIds?: ReadonlyMap<number, NodeId>;
  /** `computeFreshZone(...).startNodeIndex`; a cut below it is forbidden. */
  readonly freshStart: number;
  readonly receiptBytes: (index: number) => number;
  readonly minCutFreedBytes: number;
}
