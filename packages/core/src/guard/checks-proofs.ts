import { readCallEcho } from "../prune/dedupe/call-echo.js";
import { answeredCallIds, writtenBetween } from "../prune/dedupe/superseded-by-reread.js";
import type { ProofKind, Removal, RulePlan } from "../rules/types.js";
import type { LineRange } from "../types/identity.js";
import type { TranscriptNode, ToolResultNode } from "../types/transcript.js";
import { hitSpellings } from "../units/invalidation.js";
import { UnitTracker } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import { writePathSpellings } from "../units/writes.js";
import { equal } from "./bytes.js";
import type { CheckContext, Report } from "./context.js";
import { reporter } from "./context.js";
/**
 * The proof lane's guard check (ADR-0018; PRD §6.6).
 *
 * A `proof` operation claims a byte fact — the file was written after the read,
 * or a later exact re-read superseded it — and this check re-derives that claim
 * from the snapshot, exactly as `checks-verdicts.ts` re-derives a verdict
 * removal. The plan is never trusted for its arithmetic:
 *
 * - the op names a unit the snapshot holds, computed here with the tracker's own
 *   bar (a unit the snapshot has is the only thing a proof can burn);
 * - its removal is exactly that unit's own span, one source and one range;
 * - `stale-read` proves a write to one of the read's HIT path spellings *after*
 *   it in transcript order (a write before the read is not proof: the read is
 *   the newer bytes). Path identity is the invalidation lane's own reading
 *   (ISSUE-339): `hitSpellings` on the read, `writePathSpellings` on the write,
 *   matched by spelling intersection — the same shared functions the rule uses;
 * - `superseded-read` proves a later read of the same non-empty target key
 *   holding the exact same bytes over the removed range (the comparison
 *   `prune/level1-families.ts` uses, restructured, never its plumbing);
 * - `superseded-by-reread` proves a later read of the same non-empty target key
 *   that succeeded, covered the WHOLE file, and had no mutation evidence
 *   between the two reads (ADR-0037 decision 2, class 2; ISSUE-330). The
 *   whole-file part is the host's own declaration on the observation
 *   (`coverage === "full"`; a partial, failed or unannotated read is not a
 *   witness), and the between part is the planner's own `writtenBetween`
 *   predicate re-run against the snapshot — one shared reading, so a forged or
 *   stale claim fails here;
 * - `call-echo` proves the removed node is a WHOLE result whose declared
 *   `callArguments` payload the result's own bytes restate exactly and add
 *   nothing to (the same pure predicate the planner uses, re-run here against
 *   the snapshot), and that a live assistant message names the call, so the
 *   request copy survives (ADR-0037 decision 2, class 1; ISSUE-151). A result
 *   that carries unique previous state (`oldTodos`) is refused, never edited;
 * - **the witness survives this batch** (ISSUE-174). Every fact above is
 *   re-derived from the snapshot, but one plan is validated at a time and the
 *   batch is applied as one checkpoint-revert — so a witness a SIBLING plan
 *   removes is destroyed by the same application that relies on it. "One live
 *   copy always survives" (ADR-0038 guard 1) is a property of the batch, so the
 *   witness rule is read against the batch's removals, not the snapshot alone.
 *   A proof whose only witness is burned is `proof-unproven`, never repaired;
 * - the receipt names the unit's path and its own line ranges and no descriptor.
 *
 * A forged proof is rejected as `proof-unproven`, never repaired. Absence of a
 * proof removes nothing (ADR-0006): the failure mode is always "keep the bytes".
 */
export function checkProofs(c: CheckContext, plans: readonly RulePlan[]): void {
  // A proof burn applies by checkpoint-revert, and an entry application is
  // mode "entry" — the one mode that may not carry a revert payload
  // (guard/types.ts). Fence the lane to non-entry events so an injected proof
  // plan is a coded refusal here, never a hash-mismatch crash at ledger
  // prepare (ISSUE-307).
  if (c.value.input.kind === "entry") {
    for (const plan of plans) {
      plan.operations.forEach((op, index) => {
        if (op.kind !== "proof") return;
        reporter(c, plan.ruleId, index)("invalid-plan", "A proof plan applies only on a non-entry event");
      });
    }
    return;
  }
  const units = paidUnits(c);
  // Every node the batch removes, read off the plans' own removals. A removal's
  // source names the node its bytes belong to, so this is the set the batch
  // deletes whatever rule planned it.
  const removedNodeIds = removedNodesOf(plans);
  for (const plan of plans) {
    plan.operations.forEach((op, index) => {
      // A non-proof op is `checkOperations`' and `checkVerdicts`' business.
      if (op.kind !== "proof") return;
      const report = reporter(c, plan.ruleId, index);
      const unit = units.get(op.unitId);
      if (unit === undefined) {
        report("proof-unproven", "A proof names no unit the snapshot holds");
        return;
      }
      const removal = plan.removals.find(candidate => candidate.id === op.removalId);
      if (removal === undefined || !isOwnSpan(removal, unit)) {
        report("proof-unproven", "A proof removal must archive exactly the unit's own span", unit.nodeId);
        return;
      }
      const node = c.nodes.get(unit.nodeId);
      if (node === undefined || node.kind !== "tool-result") {
        report("proof-unproven", "A proof names no authoritative node", unit.nodeId);
        return;
      }
      if (!provesBytes(c, node, unit, op.proofKind, removedNodeIds)) {
        report("proof-unproven", PROOF_REFUSALS[op.proofKind], node.id);
      }
      const note = plan.notes.find(candidate => candidate.id === op.noteId);
      if (note === undefined || note.kind !== "proof-receipt") return; // `checkOperations` speaks.
      checkReceipt(note, unit, report);
    });
  }
}

/**
 * Every node the batch's removals address, whatever the rule. A plan's removal
 * declares the source node its bytes come from, so this is the exact set of
 * nodes this application deletes — the set a witness must survive.
 */
function removedNodesOf(plans: readonly RulePlan[]): ReadonlySet<string> {
  const nodes = new Set<string>();
  for (const plan of plans) {
    for (const removal of plan.removals) {
      for (const source of removal.sources) nodes.add(source.source.nodeId);
    }
  }
  return nodes;
}

/** The units a plan may burn: the tracker's own set, at the configured bar. */
function paidUnits(c: CheckContext): ReadonlyMap<string, ProcessingUnit> {
  const tracker = new UnitTracker({
    sessionId: c.value.snapshot.sessionId,
    barBytes: c.value.config.protocol.barBytes,
  });
  return new Map(tracker.units(c.value.snapshot).map(unit => [unit.id, unit]));
}

/** One source naming the unit's node and exactly the unit's own byte range. */
function isOwnSpan(removal: Removal, unit: ProcessingUnit): boolean {
  if (removal.sources.length !== 1) return false;
  const only = removal.sources[0];
  if (only === undefined || only.ranges.length !== 1) return false;
  const range = only.ranges[0];
  return only.source.nodeId === unit.nodeId
    && only.source.sha256 === unit.source.sha256
    && only.source.byteLength === unit.source.byteLength
    && range !== undefined
    && range.startByte === unit.span.byteRange.startByte
    && range.endByteExclusive === unit.span.byteRange.endByteExclusive;
}

/**
 * The byte fact itself, re-derived from the snapshot's own nodes. Every kind
 * needs the removed node to be a read: a write's bytes are not a claim about a
 * search space, so nothing about them can be stale or superseded content, and a
 * write is never an older snapshot of a file it changed.
 */
function provesBytes(
  c: CheckContext, node: ToolResultNode, unit: ProcessingUnit,
  kind: ProofKind, removedNodeIds: ReadonlySet<string>,
): boolean {
  const index = c.value.snapshot.nodes.findIndex(candidate => candidate.id === node.id);
  if (index < 0) return false;
  if (kind === "call-echo") {
    return echoesRequestArgument(c, node, unit, index, removedNodeIds);
  }
  if (node.evidence.kind !== "read") return false;
  switch (kind) {
    case "stale-read": return writtenAfter(c, node, index);
    case "superseded-read": return rereadLater(c, node, unit, index, removedNodeIds);
    case "superseded-by-reread": return fullReadLater(c, node, index, removedNodeIds);
  }
}

/**
 * Why a proof failed, in the fact's own words. A refusal names the missing
 * witness, so a supervisor can see which clause of the rule the snapshot failed.
 */
const PROOF_REFUSALS: Readonly<Record<ProofKind, string>> = {
  "stale-read": "No later write to this read's path proves its bytes stale",
  "superseded-read": "No later read of this target holds the same bytes, so nothing is superseded",
  "superseded-by-reread": "No later whole-file read of this path makes this snapshot an older copy",
  "call-echo": "No live request and exact argument echo prove this result adds nothing to its call",
};

/**
 * A write after the read on one of the read's own hit path spellings. Transcript
 * order is the clock: a write that lands earlier is already reflected in the
 * read's bytes, so it proves nothing about them. A miss read holds no file
 * bytes, so no write can stale it (ISSUE-339: the invalidation lane's hit rule).
 */
function writtenAfter(c: CheckContext, node: ToolResultNode, index: number): boolean {
  const paths = new Set(hitSpellings(node));
  if (paths.size === 0) return false;
  const nodes = c.value.snapshot.nodes;
  for (let at = index + 1; at < nodes.length; at++) {
    const later = nodes[at];
    if (later === undefined || later.kind !== "tool-result") continue;
    // writePathSpellings yields nothing for a non-write or a failed write
    // (ISSUE-328): the guard re-derives the same exclusion the rule reads.
    for (const key of writePathSpellings(later)) if (paths.has(key)) return true;
  }
  return false;
}

/**
 * A later read of the same non-empty target key holding exactly the removed
 * bytes over the removed range, whose node this batch does not remove. An
 * unknown target key groups nothing: two unnamed reads that happen to print the
 * same text are not one source.
 */
function rereadLater(
  c: CheckContext, node: ToolResultNode, unit: ProcessingUnit, index: number,
  removedNodeIds: ReadonlySet<string>,
): boolean {
  const target = node.evidence.target;
  if (target === null || target.key.length === 0) return false;
  const { startByte, endByteExclusive } = unit.span.byteRange;
  const removed = node.bytes.slice(startByte, endByteExclusive);
  const nodes = c.value.snapshot.nodes;
  for (let at = index + 1; at < nodes.length; at++) {
    const later: TranscriptNode | undefined = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "read") continue;
    // A copy this batch deletes is not a survivor (ISSUE-174).
    if (removedNodeIds.has(later.id)) continue;
    const other = later.evidence.target;
    if (other === null || other.key !== target.key) continue;
    const candidate = later.bytes.slice(startByte, endByteExclusive);
    if (candidate.length === removed.length && equal(candidate, removed)) return true;
  }
  return false;
}

/**
 * A later read of the same non-empty target key that succeeded, covered the
 * whole file, and has no write to that path between the two reads (ADR-0037
 * decision 2, class 2).
 *
 * Both halves are re-derived here and neither is taken from the plan:
 *
 * - "covered the whole file" is the host's declaration on the observation —
 *   `outcome: "hit"` says the call returned the path's content, `coverage:
 *   "full"` says it returned all of it. A partial read, a failed read and a read
 *   with no declaration are each not a witness, and this check never guesses one.
 * - "no write between" is the transcript's own order: a write node naming the
 *   path, anywhere strictly after the removed read and before the candidate
 *   witness, means the two reads are of different states, so the later one is
 *   not a newer copy of the same object.
 *
 * A candidate this BATCH removes is not a witness either (ISSUE-174): the batch
 * applies as one checkpoint-revert, so the witness would be destroyed by the
 * same application that cites it. ADR-0038 guard 1 is a property of the batch,
 * which is why this check reads the whole plan set and not one plan.
 */
function fullReadLater(
  c: CheckContext, node: ToolResultNode, index: number,
  removedNodeIds: ReadonlySet<string>,
): boolean {
  const target = node.evidence.target;
  if (target === null || target.key.length === 0) return false;
  const nodes = c.value.snapshot.nodes;
  // One answered set per witness walk, not per candidate: the snapshot does not
  // change mid-check, and the set is never cached across checks (ISSUE-382).
  const answered = answeredCallIds(nodes);
  for (let at = nodes.length - 1; at > index; at--) {
    const later: TranscriptNode | undefined = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "read") continue;
    if (!isWholeFileRead(later, target.key)) continue;
    if (removedNodeIds.has(later.id)) continue;
    if (writtenBetween(nodes, index, at, target.key, answered)) continue;
    return true;
  }
  return false;
}

/**
 * A tool result that restates its own call's argument payload and adds nothing
 * (ADR-0037 decision 2, class 1; ISSUE-151).
 *
 * Three facts are re-derived here, never read from the plan:
 *
 * - the unit is the WHOLE result. The apply lane removes whole units, and this
 *   class has no sub-span shape: a slice would be a different removal, so it is
 *   refused rather than narrowed;
 * - the node declares a `callArguments` payload, and `readCallEcho` proves the
 *   result's bytes are that payload with no state of its own. The predicate is
 *   semantic JSON equality; a unique previous-state field is a refusal, never
 *   an edit;
 * - a live assistant message before the result names the call, and this batch
 *   does not remove it. That message is the copy the proof says survives.
 */
function echoesRequestArgument(
  c: CheckContext, node: ToolResultNode, unit: ProcessingUnit, index: number,
  removedNodeIds: ReadonlySet<string>,
): boolean {
  if (unit.span.byteRange.startByte !== 0
    || unit.span.byteRange.endByteExclusive !== node.bytes.length) return false;
  const argumentsBytes = node.callArguments;
  if (argumentsBytes === undefined || argumentsBytes.length === 0) return false;
  if (!requestMessageLive(c.value.snapshot.nodes, index, node.callId, removedNodeIds)) {
    return false;
  }
  return readCallEcho(argumentsBytes, node.bytes).kind === "ok";
}

/**
 * The nearest assistant message before the result that names the call and is
 * not removed by this batch. A message is the only witness kind this class
 * accepts: the arguments are assistant text, and a result whose request is gone
 * has no live copy of what it repeats.
 */
function requestMessageLive(
  nodes: readonly TranscriptNode[], before: number, callId: string,
  removedNodeIds: ReadonlySet<string>,
): boolean {
  for (let at = before - 1; at >= 0; at--) {
    const node = nodes[at];
    if (node === undefined || node.kind !== "message" || node.role !== "assistant") continue;
    if (!node.toolCallIds.includes(callId)) continue;
    if (removedNodeIds.has(node.id)) continue;
    return true;
  }
  return false;
}

/**
 * A read whose own observation of this path declares both success and full
 * coverage. The declaration lives on the observation, not on the target: it is
 * the host's statement about what the call returned.
 */
function isWholeFileRead(node: ToolResultNode, pathKey: string): boolean {
  const target = node.evidence.target;
  if (target === null || target.key !== pathKey) return false;
  const observation = node.evidence.paths.find(path => path.pathKey === pathKey);
  return observation !== undefined
    && observation.outcome === "hit" && observation.coverage === "full";
}

/**
 * The receipt a proof burn leaves: the unit's path (or its node id when the host
 * named no path) and the burned line ranges, with no descriptor (ADR-0018; a
 * proven removal has nothing to describe). A whole-node burn names no range.
 */
function checkReceipt(
  note: Extract<RulePlan["notes"][number], { kind: "proof-receipt" }>,
  unit: ProcessingUnit, report: Report,
): void {
  if (note.path !== (unit.path ?? unit.nodeId)) {
    report("invalid-note", "A proof receipt names a path other than its unit's", unit.nodeId);
  }
  if (!sameLines(note.ranges, receiptRanges(unit))) {
    report("invalid-note", "A proof receipt names ranges other than the burned span", unit.nodeId);
  }
}

function receiptRanges(unit: ProcessingUnit): readonly LineRange[] {
  const { byteRange } = unit.span;
  const wholeNode = byteRange.startByte === 0 && byteRange.endByteExclusive === unit.source.byteLength;
  if (wholeNode || unit.span.lineRange === null) return [];
  return [unit.span.lineRange];
}

function sameLines(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return other !== undefined && range.startLine === other.startLine
      && range.endLineInclusive === other.endLineInclusive;
  });
}
