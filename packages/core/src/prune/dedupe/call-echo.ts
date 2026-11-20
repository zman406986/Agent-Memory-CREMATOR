import type { NodeId } from "../../types/identity.js";
import type {
  MessageNode, ToolResultNode, TranscriptNode,
} from "../../types/transcript.js";
import type { ProcessingUnit } from "../../units/types.js";
import { canonicalManifestBytes, equalBytes, fromBytes } from "../../util/bytes.js";
import type {
  CallEchoFact, DedupeRefusal, DedupeRefusalReason, DedupeRemoval,
} from "./types.js";

/**
 * Class 1: a tool call's arguments echoed by its own result (ADR-0037 decision
 * 2, class 1; ISSUE-151, narrowed by the owner ruling of 2026-11-06).
 *
 * One rule: the result's payload restates the argument payload its own call
 * declared and adds nothing. The comparison is SEMANTIC JSON equality — both
 * sides are parsed, and two values are equal when their canonical JSON encodings
 * are equal, so whitespace and key order do not decide it while array order
 * does. Bytes are never compared directly, because the request and the result
 * are serialised by different hosts.
 *
 * The only field excused beyond the request's own keys is `oldTodos`, the todo
 * tool's previous-state field, and only when it holds nothing new: an empty
 * array, or a repeat of the request's own list. Any other `oldTodos` value is
 * `call-echo-previous-state` — that is the 15,346-pair shape ISSUE-151 measured
 * and the owner explicitly put out of scope. The class never removes a sub-span,
 * so a previous-state field is never edited: a result that carries unique prior
 * state is refused whole.
 *
 * Every guard clause is a reason NOT to plan, and every refusal is named:
 *
 *   - no declared argument payload means the request side is unknown, and an
 *     undeclared payload is never guessed from the result (ADR-0037 decision 2);
 *   - either side failing to parse means the equality is unproved;
 *   - a list that differs in any item, order or value is not an echo;
 *   - a previous-state field with unique data makes the whole result the only
 *     copy of that data, so the whole result must stay;
 *   - a request message that is not live means no copy of the arguments
 *     survives, and the call-echo proof's one live copy is the request;
 *   - a unit that is not the whole result cannot be removed by this class: the
 *     removal shape is the result, whole (ADR-0037 decision 3).
 *
 * Pure and deterministic: transcript order is the only clock, the units are
 * walked in the order the caller supplied them, and neither the units nor the
 * nodes are mutated. The plan names a witness for telemetry only; the guard
 * re-derives the equality and the live request from the snapshot.
 */

/** What the payload comparison decided. */
export type CallEchoCheck =
  | { readonly kind: "not-subject" }
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly reason: DedupeRefusalReason };

/**
 * The equality rule itself, as one pure function over the two declared
 * payloads. `not-subject` means neither side names a `todos` list, so this is
 * not a call-echo subject at all; every other outcome on a subject is `ok` or a
 * named refusal.
 */
export function readCallEcho(
  argumentsBytes: Uint8Array, resultBytes: Uint8Array,
): CallEchoCheck {
  const request = objectOf(argumentsBytes);
  const result = objectOf(resultBytes);
  const requestList = request === null ? undefined : request["todos"];
  const resultList = result === null ? undefined : result["todos"];
  const requestSubject = Array.isArray(requestList);
  const resultSubject = Array.isArray(resultList);
  if (!requestSubject && !resultSubject) return { kind: "not-subject" };
  if (request === null) return refused("call-echo-arguments-invalid");
  if (result === null) return refused("call-echo-result-invalid");
  if (!requestSubject) return refused("call-echo-request-list-absent");
  if (!resultSubject) return refused("call-echo-result-list-absent");
  if (!jsonEqual(requestList, resultList)) return refused("call-echo-list-differs");

  // The previous-state field is the one key the request need not hold. It is
  // allowed only when it restates nothing the request does not already say:
  // empty, or the request's own list. Any other value is unique prior state,
  // and the whole result is then not removable.
  if (Object.hasOwn(result, "oldTodos")) {
    const oldTodos = result["oldTodos"];
    const empty = Array.isArray(oldTodos) && oldTodos.length === 0;
    if (!empty && !jsonEqual(oldTodos, requestList)) {
      return refused("call-echo-previous-state");
    }
  }

  // Every request key must be restated exactly; every result key must come from
  // the request (the previous-state field already handled above), so the result
  // adds nothing.
  for (const key of Object.keys(request)) {
    if (!Object.hasOwn(result, key)) return refused("call-echo-result-omits-arguments");
    if (!jsonEqual(request[key], result[key])) return refused("call-echo-result-differs");
  }
  for (const key of Object.keys(result)) {
    if (key === "oldTodos") continue;
    if (!Object.hasOwn(request, key)) return refused("call-echo-result-adds-state");
  }
  return { kind: "ok" };
}

/** One class-1 subject: the result's unit and the request that declared it. */
export function planCallEcho(
  units: readonly ProcessingUnit[], nodes: readonly TranscriptNode[],
  removedNodeIds: ReadonlySet<NodeId> = new Set(),
): { readonly removals: readonly DedupeRemoval[]; readonly refusals: readonly DedupeRefusal[] } {
  const positions = nodePositions(nodes);
  const claimed = new Set<NodeId>();
  const removals: DedupeRemoval[] = [];
  const refusals: DedupeRefusal[] = [];
  for (const unit of units) {
    const index = positions.get(unit.nodeId);
    if (index === undefined) continue;
    const node = nodes[index];
    if (node === undefined || node.kind !== "tool-result") continue;
    if (claimed.has(node.id)) continue;

    const check = checkSubject(node);
    if (check.kind === "not-subject") continue;
    claimed.add(node.id);
    if (check.kind === "refused") {
      refusals.push({ unitId: unit.id, rule: "call-echo", reason: check.reason });
      continue;
    }
    if (!isWholeResult(unit, node)) {
      refusals.push({ unitId: unit.id, rule: "call-echo", reason: "call-echo-not-whole-result" });
      continue;
    }
    const request = liveRequest(nodes, index, node.callId, removedNodeIds);
    if (request === null) {
      refusals.push({ unitId: unit.id, rule: "call-echo", reason: "call-echo-request-not-live" });
      continue;
    }
    const fact: CallEchoFact = {
      kind: "call-echo", callId: node.callId, witnessIndex: request.index,
    };
    removals.push({
      unitId: unit.id,
      rule: "call-echo",
      proof: {
        rule: "call-echo",
        identityKey: node.callId,
        witnessNodeId: request.node.id,
        witnessUnitId: null,
        fact,
      },
    });
  }
  return { removals, refusals };
}

/**
 * Whether the node is a class-1 subject, and if so whether its payload is an
 * exact echo. Absence of the declared argument payload is a refusal only for a
 * result that itself names a todo list: every other tool result is simply not
 * this class's object.
 */
function checkSubject(node: ToolResultNode): CallEchoCheck {
  const argumentsBytes = node.callArguments;
  if (argumentsBytes === undefined) {
    return resultNamesTodos(node) ? refused("call-echo-arguments-absent") : { kind: "not-subject" };
  }
  return readCallEcho(argumentsBytes, node.bytes);
}

function resultNamesTodos(node: ToolResultNode): boolean {
  const result = objectOf(node.bytes);
  return result !== null && Array.isArray(result["todos"]);
}

/**
 * The unit is the whole result, so the removal shape is the result, whole. The
 * span bounds alone are not enough: a stale unit record can still name the full
 * byte range while its `source` no longer describes the node's bytes (ISSUE-337).
 * The source identity (sha256 and byteLength) must match the node too, so a
 * removal is never planned from mismatched bytes.
 */
function isWholeResult(unit: ProcessingUnit, node: ToolResultNode): boolean {
  return unit.span.byteRange.startByte === 0
    && unit.span.byteRange.endByteExclusive === node.bytes.length
    && unit.source.sha256 === node.sha256
    && unit.source.byteLength === node.byteLength;
}

/**
 * The nearest assistant message before the result that names the call, and that
 * this pass does not remove. That message is the live copy the class relies on:
 * the result's echoed bytes add nothing this request did not already say.
 */
function liveRequest(
  nodes: readonly TranscriptNode[], before: number, callId: string,
  removedNodeIds: ReadonlySet<NodeId>,
): { readonly node: MessageNode; readonly index: number } | null {
  for (let at = before - 1; at >= 0; at -= 1) {
    const node = nodes[at];
    if (node === undefined || node.kind !== "message" || node.role !== "assistant") continue;
    if (!node.toolCallIds.includes(callId)) continue;
    if (removedNodeIds.has(node.id)) continue;
    return { node, index: at };
  }
  return null;
}

/** Each node id's transcript position; a repeated id keeps its first position. */
function nodePositions(nodes: readonly TranscriptNode[]): ReadonlyMap<NodeId, number> {
  const positions = new Map<NodeId, number>();
  nodes.forEach((node, index) => {
    if (!positions.has(node.id)) positions.set(node.id, index);
  });
  return positions;
}

function refused(reason: DedupeRefusalReason): CallEchoCheck {
  return { kind: "refused", reason };
}

/** One parsed JSON object, or null: arrays and scalars are not an argument object. */
function objectOf(bytes: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(fromBytes(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/**
 * Semantic JSON equality: canonical encodings (sorted keys, no whitespace)
 * must be byte-equal. Arrays keep their order; objects do not. A value the
 * canonical encoder refuses is unequal, never guessed equal.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return equalBytes(canonicalManifestBytes(left), canonicalManifestBytes(right));
  } catch {
    return false;
  }
}
