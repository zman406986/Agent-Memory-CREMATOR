import type { NodeId, UnitId } from "../../types/identity.js";
import type { TranscriptNode, ToolResultNode } from "../../types/transcript.js";
import type { ProcessingUnit } from "../../units/types.js";
import { writePathSpellings } from "../../units/writes.js";
import { readPathKey } from "./identity.js";
import type { DedupeRemoval, SupersededByRereadFact } from "./types.js";

/**
 * Class 2: older snapshots of the same object (ADR-0037 decision 2, row 2).
 *
 * One rule: a later read of the same `pathKey` that succeeded, covered the whole
 * file, and had no write to that path between the two reads makes the earlier
 * read an older copy. The surviving such read is the witness — it is the copy that
 * survives — and every earlier read whose witness it is becomes a removal.
 *
 * Every guard clause is a reason NOT to plan:
 *
 *   - a partial later read names a slice of the file, not the object, so it is
 *     not a newer snapshot of what the earlier read held;
 *   - a later read whose host declared no coverage is unannotated, and an
 *     unannotated read is never a witness (absence is never a guess);
 *   - a failed later read returned no content, so it proves nothing;
 *   - a write to the path between the two reads means the two reads are of
 *     different states, not of one object; the write's own bytes are the newer
 *     copy, and that is the stale-read lane's business (ADR-0018). The window
 *     must be provably quiet, not merely free of write-kind nodes: a shell
 *     result or an unanswered call in it withholds the burn too (ISSUE-330,
 *     `writtenBetween` below);
 *   - a node this same pass REMOVES is not a witness (ISSUE-174). The pass
 *     applies its removals as one checkpoint-revert, so a witness L1 proved away
 *     is destroyed by the same application that would rely on it. ADR-0038
 *     guard 1 — one live copy always survives — is a property of the whole
 *     application, so the witness rule is read against the survivors, never
 *     against the pre-removal snapshot.
 *
 * Pure and deterministic: transcript order is the only clock, the units are
 * walked in the order the caller supplied them, and neither the units nor the
 * nodes are mutated. The plan names a witness as a fact for telemetry only; the
 * guard re-derives the same fact from the snapshot and never trusts this one.
 */
export function planSupersededByReread(
  units: readonly ProcessingUnit[], nodes: readonly TranscriptNode[],
  removedNodeIds: ReadonlySet<NodeId> = new Set(),
): readonly DedupeRemoval[] {
  const positions = nodePositions(nodes);
  const unitByNode = new Map<NodeId, UnitId>();
  for (const unit of units) if (!unitByNode.has(unit.nodeId)) unitByNode.set(unit.nodeId, unit.id);
  // The answered set depends only on `nodes`, and this pass never mutates them:
  // build it once for the whole pass instead of once per witness probe
  // (ISSUE-382). It is pass-scoped, never cached across calls — the array is
  // the host's and may change between calls.
  const answered = answeredCallIds(nodes);

  const removals: DedupeRemoval[] = [];
  for (const unit of units) {
    const index = positions.get(unit.nodeId);
    if (index === undefined) continue;
    const node = nodes[index];
    if (node === undefined) continue;
    const pathKey = readPathKey(node);
    if (pathKey === null) continue;
    const witnessIndex = survivingRead(nodes, index, pathKey, removedNodeIds, answered);
    if (witnessIndex === null) continue;
    const witness = nodes[witnessIndex];
    if (witness === undefined) continue;
    const fact: SupersededByRereadFact = { kind: "superseded-by-reread", pathKey, witnessIndex };
    removals.push({
      unitId: unit.id,
      rule: "superseded-by-reread",
      proof: {
        rule: "superseded-by-reread",
        identityKey: pathKey,
        witnessNodeId: witness.id,
        witnessUnitId: unitByNode.get(witness.id) ?? null,
        fact,
      },
    });
  }
  return removals;
}

/** Each node id's transcript position; a repeated id keeps its first position. */
function nodePositions(nodes: readonly TranscriptNode[]): ReadonlyMap<NodeId, number> {
  const positions = new Map<NodeId, number>();
  nodes.forEach((node, index) => {
    if (!positions.has(node.id)) positions.set(node.id, index);
  });
  return positions;
}

/**
 * The surviving read after `after` that covered the whole file, with no write to
 * that path in between, and that this pass does not remove. It walks backwards,
 * so the copy that survives is the latest one the transcript witnessed.
 */
function survivingRead(
  nodes: readonly TranscriptNode[], after: number, pathKey: string,
  removedNodeIds: ReadonlySet<NodeId>, answered: ReadonlySet<string>,
): number | null {
  for (let at = nodes.length - 1; at > after; at -= 1) {
    const node = nodes[at];
    if (node === undefined || !isFullReadOf(node, pathKey)) continue;
    // A node this pass removes is not a survivor: citing it would make the burn
    // depend on bytes the same application deletes (ISSUE-174).
    if (removedNodeIds.has(node.id)) continue;
    if (writtenBetween(nodes, after, at, pathKey, answered)) continue;
    return at;
  }
  return null;
}

/**
 * A read of this path that succeeded and covered the whole file. Both facts are
 * declared by the host on the observation: `outcome` says the call returned the
 * path's content, `coverage` says it returned all of it.
 */
function isFullReadOf(node: TranscriptNode, pathKey: string): node is ToolResultNode {
  if (node.kind !== "tool-result" || node.evidence.kind !== "read") return false;
  const target = node.evidence.target;
  if (target === null || target.key !== pathKey) return false;
  const observation = node.evidence.paths.find(path => path.pathKey === pathKey);
  if (observation === undefined) return false;
  return observation.outcome === "hit" && observation.coverage === "full";
}

/**
 * Mutation evidence between two reads, read in the unsafe direction's opposite
 * (ISSUE-330): the burn is withheld unless the window is provably quiet.
 *
 * Three facts block, and absence of a write-kind node is NOT proof that nothing
 * changed:
 *
 *   - a write to this path strictly between the reads, through every spelling
 *     the host recorded (`writePathSpellings`: key, display form, declared
 *     target). A failed write yields no spelling (ISSUE-328) and blocks nothing;
 *   - any `other`-kind result in the window: a shell `sed -i` classifies as
 *     `other`, and its side effects are not attributable to a path, so the whole
 *     window is unproven;
 *   - a call declared by an assistant message in the window that no tool-result
 *     node anywhere in the snapshot answers: an aborted or in-flight call, whose
 *     effect before it died (or lands) is unknown.
 *
 * Exported so the guard re-derives the identical fact from the snapshot
 * (`guard/checks-proofs.ts` imports this one predicate; parity by construction,
 * the same sharing `readCallEcho` already has).
 *
 * `answered` may be supplied by a caller that probes many windows over one
 * unchanged array (the pass, the guard's witness walk): it is then built once
 * per walk instead of once per window (ISSUE-382). It is never cached across
 * calls — `nodes` is the host's array, and a memo keyed on its identity could
 * go stale when the host appends to or edits it between calls.
 */
export function writtenBetween(
  nodes: readonly TranscriptNode[], from: number, to: number, pathKey: string,
  answered: ReadonlySet<string> = answeredCallIds(nodes),
): boolean {
  for (let at = from + 1; at < to; at += 1) {
    const node = nodes[at];
    if (node === undefined) continue;
    if (node.kind === "tool-result") {
      if (node.evidence.kind === "other") return true;
      if (node.evidence.kind === "write"
        && writePathSpellings(node).includes(pathKey)) return true;
      continue;
    }
    if (node.kind === "message" && node.role === "assistant") {
      for (const callId of node.toolCallIds) {
        if (!answered.has(callId)) return true;
      }
    }
  }
  return false;
}

/**
 * Every callId some tool-result node in the snapshot answers. Shared with the
 * guard so both sides read one definition (parity by construction).
 */
export function answeredCallIds(nodes: readonly TranscriptNode[]): ReadonlySet<string> {
  const answered = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "tool-result") answered.add(node.callId);
  }
  return answered;
}
