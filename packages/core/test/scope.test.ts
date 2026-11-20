import assert from "node:assert/strict";
import { test } from "node:test";
import { RacoonsEngine } from "../src/engine/engine.js";
import { liveUnits, unitsFromWindow } from "../src/engine/protocol.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationIssue, ValidationInput } from "../src/guard/types.js";
import type { Rule, RuleContext, RulePlan } from "../src/rules/types.js";
import type { UnitId } from "../src/types/identity.js";
import type {
       MessageNode, MessageProvenance, RacoonsRecordNode, SessionSnapshot, ToolResultNode,
       TranscriptNode,
} from "../src/types/transcript.js";
import { isCandidateNode, UnitTracker, unitIdFor } from "../src/units/tracker.js";
import { sha256Sync } from "../src/util/hash.js";
import { fixture, protocolFixture } from "./engine-fixtures.js";
import { entry, ledger, pruneEvent } from "./guard-fixtures.js";
import type { EngineInput } from "../src/engine/types.js";
import type { PrunePassApplication } from "../src/prune/pass-merge.js";

/**
 * ADR-0020: removal scope is toolcall results only, and that scope is enforced
 * as **selection**, not as protection.
 *
 * A candidate is a tool-result node or a processing unit cut from one. A
 * message — system, developer, user or assistant, so the human's input and the
 * agent's own output — and a RACOONS record are not a protected class; they are
 * never units. No rule, verdict, prune ask, manual forget or entry decision can
 * name them because no unit id exists to name.
 *
 * These tests are the DoD proof, so they assert that selection and only that
 * (design §1, N21; ADR-0020). The automatic protection layer is deleted, so
 * there is no protected set to assert against: a message or a record stays out
 * of reach because no unit id exists for it, not because anything refuses.
 */

const encoder = new TextEncoder();
const SESSION = "session-scope";
const BAR = 8;

function toolResult(id: string, text: string, stepOrdinal = 1): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { kind: "read", target: null, source: { nodeId: id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: `src/${id}.ts`, displayPath: `src/${id}.ts`, title: null,
        lineCount: 1, byteLength: bytes.length, outcome: "hit" }] },
  };
}

function messageOf(
  role: MessageNode["role"], id: string, text: string,
  fields: {
    readonly turnOrdinal?: number;
    readonly stepOrdinal?: number;
    readonly toolCallIds?: readonly string[];
    readonly provenance?: MessageProvenance;
  } = {},
): MessageNode {
  const bytes = encoder.encode(text);
  return {
    kind: "message", id, role, bytes, sha256: sha256Sync(bytes), byteLength: bytes.length,
    turnOrdinal: fields.turnOrdinal ?? 1, stepOrdinal: fields.stepOrdinal ?? 0,
    toolCallIds: fields.toolCallIds ?? [],
    ...fields.provenance === undefined ? {} : { provenance: fields.provenance },
  };
}

function recordOf(id: string, text: string, stepOrdinal = 1): RacoonsRecordNode {
  const bytes = encoder.encode(text);
  return {
    kind: "racoons-record", id, recordId: id, bytes, sha256: sha256Sync(bytes),
    byteLength: bytes.length, turnOrdinal: 1, stepOrdinal,
  };
}

function scoped(nodes: readonly TranscriptNode[]): SessionSnapshot {
  // `checkTranscript` requires every result to follow a declared call id, so a
  // hand-built transcript carries one assistant message that declares them.
  const calls = nodes.flatMap(node => node.kind === "tool-result" ? [node.callId] : []);
  const prelude = calls.length === 0 ? []
    : [messageOf("assistant", "assistant-calls", "Requested the calls.",
      { toolCallIds: calls })];
  const ordered = [...prelude, ...nodes].sort((a, b) =>
    a.turnOrdinal - b.turnOrdinal || a.stepOrdinal - b.stepOrdinal);
  return {
    sessionId: SESSION, revision: "revision-scope", currentTurnOrdinal: 2,
    completedThroughTurnOrdinal: 1, currentStepOrdinal: 3, nodes: ordered,
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
}

/**
 * The unit id a message or record *would* get if it were segmented. `unitIdFor`
 * is typed for a tool result because only a tool result is a candidate; the
 * point of these tests is that the id is computable and still names no unit, so
 * a hand-built verdict, prune row or proof cannot smuggle one in.
 */
function nonCandidateUnitId(node: MessageNode | RacoonsRecordNode): UnitId {
  return unitIdFor(SESSION, node as unknown as ToolResultNode, {
    byteRange: { startByte: 0, endByteExclusive: node.bytes.length },
    lineRange: { startLine: 1, endLineInclusive: 1 },
  });
}

function guard(): Guard {
  return new Guard({ ledger: ledger(),
    initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

function codesOf(issues: readonly ValidationIssue[]): readonly ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

// --- the candidate set ------------------------------------------------------

/**
 * One row per node kind, each above the bar on its own. `candidate` is the rule:
 * a tool result mints, a message of any role and a RACOONS record do not.
 */
const CANDIDATE_ROWS: readonly {
  name: string;
  node: () => TranscriptNode;
  candidate: boolean;
  check?: (node: TranscriptNode) => void;
}[] = [
  { name: "a tool-result", candidate: true,
    node: () => toolResult("result-1", "read body ".repeat(4), 2) },
  { name: "a system message", candidate: false,
    node: () => messageOf("system", "system-1", "system prompt ".repeat(4)) },
  { name: "a developer message", candidate: false,
    node: () => messageOf("developer", "developer-1", "developer text ".repeat(4)) },
  { name: "a user message", candidate: false,
    node: () => messageOf("user", "user-1", "explain the build ".repeat(8)) },
  { name: "an assistant message", candidate: false,
    node: () => messageOf("assistant", "assistant-1", "assistant output ".repeat(4)) },
  { name: "a RACOONS record", candidate: false,
    node: () => recordOf("record-1", "RACOONS receipt ".repeat(4)) },
  // ISSUE-149: provenance is carried, it is not read from the bytes. Two messages
  // with identical bytes and different declared sources share a sha256 and differ
  // only in provenance — and neither becomes a candidate.
  { name: "a typed user message and a harness message differ only in provenance",
    candidate: false,
    node: () => messageOf("user", "declared-1", "identical declared bytes ".repeat(4),
      { provenance: { sourceKind: "user" } }),
    check: node => {
      const harness = messageOf("user", "declared-1", "identical declared bytes ".repeat(4),
        { provenance: { sourceKind: "harness" } });
      assert.equal(node.sha256, harness.sha256,
        "row: identical bytes — the sha256 is the same");
      assert.notDeepEqual(node.kind === "message" ? node.provenance : undefined,
        harness.kind === "message" ? harness.provenance : undefined,
        "row: identical bytes — the provenance is what differs");
    } },
  // Absence is meaningful: no key, no guess, and no unit either.
  { name: "a message with no provenance key",
    candidate: false,
    node: () => messageOf("user", "undeclared-1", "undeclared message ".repeat(4)),
    check: node => {
      assert.equal("provenance" in node, false,
        "row: undeclared — the key is absent, not `undefined`");
    } },
];

test("selection — a message and a RACOONS record mint no unit, at any bar", () => {
  // The one snapshot every row is judged in: the candidate set is its toolcall results.
  const s = scoped(CANDIDATE_ROWS.map(row => row.node()));
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: BAR });
  const live = liveUnits(s, SESSION, BAR);
  for (const row of CANDIDATE_ROWS) {
    const node = row.node();
    const expected = row.candidate ? 1 : 0;
    assert.equal(isCandidateNode(node), row.candidate, `row: ${row.name} — the candidate predicate`);
    assert.equal(tracker.unitsFor(node).length, expected, `row: ${row.name} — units for the node`);
    assert.equal(tracker.units(s).filter(unit => unit.nodeId === node.id).length, expected,
      `row: ${row.name} — units in the snapshot`);
    assert.equal(live.some(unit => unit.nodeId === node.id), row.candidate,
      `row: ${row.name} — units in the live set`);
    // The bar is not what keeps them out: at bar zero a message is still nothing.
    assert.equal(new UnitTracker({ sessionId: SESSION, barBytes: 0 }).unitsFor(node).length, expected,
      `row: ${row.name} — units at bar zero`);
    row.check?.(node);
    // No window can resolve a non-candidate, because no unit id exists for it.
    if (!row.candidate) {
      assert.deepEqual(unitsFromWindow(s, SESSION, BAR,
        [nonCandidateUnitId(node as MessageNode | RacoonsRecordNode)]), [],
      `row: ${row.name} — a window naming its would-be id resolves nothing`);
    }
  }
  assert.deepEqual(live.map(unit => unit.nodeId), ["result-1"],
    "row: the live set is its toolcall results");
  // A message and a tool result in the same position are treated alike: the two
  // node kinds differ only in candidate scope, and that is the whole rule.
  assert.deepEqual(new UnitTracker({ sessionId: SESSION, barBytes: 0 }).units(scoped([
    messageOf("system", "system-1", "system prompt ".repeat(4)),
    toolResult("result-1", "read body ".repeat(4)),
  ])).map(unit => unit.nodeId), ["result-1"], "row: the same position, unlike scope");
});

// --- the refusal, in every lane that could name one -------------------------

/** A plan whose proof names `node`'s would-be unit id, submitted as a rule. */
async function refusedAsRule(messageNode: MessageNode, row: string): Promise<void> {
  const f = await protocolFixture();
  const unitId = nonCandidateUnitId(messageNode);
  const rule: Rule = { id: "stale-read",
    plan: (context: RuleContext): RulePlan => ({
      ruleId: "stale-read", baseRevision: context.snapshot.revision,
      removals: [{ id: unitId, title: "agent output", sources: [{
        source: { nodeId: messageNode.id, sha256: messageNode.sha256,
          byteLength: messageNode.bytes.length },
        ranges: [{ startByte: 0, endByteExclusive: messageNode.bytes.length }],
      }] }],
      notes: [{ id: `receipt:${unitId}`, kind: "proof-receipt", proofKind: "stale-read",
        removalId: unitId, unitId, path: messageNode.id, ranges: [] }],
      operations: [{ kind: "proof", proofKind: "stale-read", removalId: unitId,
        unitId, noteId: `receipt:${unitId}` }],
    }) };
  const outcome = await (await RacoonsEngine.open({ ...f.options, rules: [rule] })).process(f.atRest);
  assert.equal(outcome.status, "rejected", `row: ${row} — the engine rejects the plan`);
  const validation = outcome.validation;
  if (validation === null || validation.ok) {
    assert.fail(`row: ${row} — the plan produced no refusal`);
    return;
  }
  const refusal = validation.issues.find(issue => issue.code === "proof-unproven");
  assert.ok(refusal !== undefined, `row: ${row} — expected proof-unproven, got ${
    JSON.stringify(validation.issues.map(i => i.code))}`);
  assert.ok(refusal.detail.includes("no unit the snapshot holds"), `row: ${row} — ${refusal.detail}`);
  assert.equal(f.port.requests.length, 0, `row: ${row} — the forged plan applied nothing`);
}

/** An entry decision whose incoming result is a message, handed over untyped. */
async function refusedAsEntryInput(role: MessageNode["role"], row: string): Promise<void> {
  const message = messageOf(role, `${role}-1`, "plain human text ".repeat(4));
  const v = entry();
  // The event shape is runtime data a JS host can hand over untyped: the guard
  // refuses it by name, exactly as `checkInput` documents.
  const validation = await guard().validate({ ...v,
    input: { kind: "entry", eventId: "entry-message",
      result: message as unknown as ToolResultNode } });
  assert.equal(validation.ok, false, `row: ${row} — the message is refused`);
  if (validation.ok) return;
  assert.ok(validation.issues.some(issue => issue.code === "invalid-plan"
    && issue.detail.includes("Entry input must be a tool-result node")),
  `row: ${row} — ${JSON.stringify(validation.issues)}`);
  // And the tracker mints nothing for it, so no rule or ask could pick it up
  // even if the shape check were skipped.
  assert.deepEqual(new UnitTracker({ sessionId: v.snapshot.sessionId, barBytes: 1 }).unitsFor(message),
    [], `row: ${row} — the tracker mints nothing`);
  // The declared type says the same thing: an entry decision carries a toolcall result.
  // @ts-expect-error a message is never an entry decision's incoming result
  const typed: EngineInput = { kind: "entry", eventId: "entry-message", result: message };
  assert.equal(typed.kind, "entry", `row: ${row} — the typed event still names the kind`);
}

/** A prune removal naming a message's would-be id, in a snapshot that does hold a unit. */
async function refusedAsPruneRemoval(role: MessageNode["role"], row: string): Promise<void> {
  const base = entry();
  const node = messageOf(role, `${role}-1`, "message body ".repeat(4));
  const s = scoped([node, toolResult("result-1", "read body ".repeat(4))]);
  // The bar is low, so the toolcall result in the same snapshot *is* a unit: the
  // refusal is about the message's id, not about an empty window.
  assert.equal(liveUnits(s, SESSION, BAR).length, 1, `row: ${row} — the snapshot holds one candidate`);
  const value: ValidationInput = {
    input: pruneEvent([{ unitId: nonCandidateUnitId(node), action: "forgetall",
      summary: "agent output", answeredInRound: 1 }]),
    snapshot: s, capabilities: base.capabilities,
    config: { ...base.config, protocol: { ...base.config.protocol, barBytes: BAR } },
    plans: [], sealedEpisodeIds: [], nowMs: 10,
  };
  const validation = await guard().validate(value);
  assert.equal(validation.ok, false, `row: ${row} — the removal is refused`);
  if (validation.ok) return;
  assert.deepEqual(codesOf(validation.issues), ["unknown-unit"],
    `row: ${row} — ${JSON.stringify(validation.issues)}`);
}

/** A prune pass naming a message and a record at once. */
async function refusedAsPrunePass(row: string): Promise<void> {
  const base = entry();
  const message = messageOf("assistant", "assistant-1", "agent output ".repeat(4));
  const record = recordOf("record-1", "RACOONS receipt ".repeat(4));
  const s = scoped([message, record, toolResult("result-1", "read body ".repeat(4))]);
  assert.equal(liveUnits(s, SESSION, BAR).length, 1, `row: ${row} — the snapshot holds one candidate`);
  const verdicts: PrunePassApplication = {
    removals: [message, record].map(node => ({
      unitId: nonCandidateUnitId(node), origin: "l2", action: "forgetall",
      summary: "junk", answeredInRound: 1,
    })),
    kept: [], refused: [], rejected: [],
  };
  const validation = await guard().validate({ ...base, snapshot: s,
    config: { ...base.config, protocol: { ...base.config.protocol, barBytes: BAR } },
    input: { kind: "prune", eventId: "prune-message", round: 1, verdicts, window: 1000 }, plans: [] });
  assert.equal(validation.ok, false, `row: ${row} — the pass is refused`);
  if (validation.ok) return;
  assert.deepEqual(codesOf(validation.issues), ["unknown-unit"],
    `row: ${row} — ${JSON.stringify(validation.issues)}`);
}

test("no lane can name a non-candidate — one refusal row per lane and role", async () => {
  for (const role of ["system", "developer", "user", "assistant"] as const) {
    const row = `prune removal naming a ${role} message`;
    await refusedAsPruneRemoval(role, row);
  }
  await refusedAsEntryInput("user", "entry input that is a user message");
  await refusedAsPrunePass("prune pass naming a message and a record");
  const f = await protocolFixture();
  const messageNode = f.snapshot.nodes.find(node => node.kind === "message");
  assert.ok(messageNode !== undefined && messageNode.kind === "message",
    "row: a synthetic rule naming a message node — the fixture holds a message");
  if (messageNode !== undefined && messageNode.kind === "message") {
    await refusedAsRule(messageNode, "a synthetic rule naming a message node");
  }
});

// --- no over-blocking: a toolcall unit stays nameable ----------------------

test("selection does not over-block — a toolcall unit is listed and applied", async () => {
  // In-flight toolcall content is ordinary candidate bytes: a prune pass lists
  // it exactly like any other unit, and nothing refuses its removal.
  assert.equal(liveUnits(scoped([toolResult("result-1", "read body ".repeat(4))]),
    SESSION, BAR).length, 1, "row: in-flight toolcall content is listed");

  const f = await fixture();
  assert.equal(f.units.length, 2, "row: both above-bar results are candidates");
  const removed = f.units[0];
  assert.ok(removed !== undefined, "row: the fixture's first unit is the prune target");
  if (removed === undefined) return;
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  const outcome = await engine.process(f.prune);
  assert.equal(outcome.status, "applied", "row: a prune of a toolcall unit applies");
  const validation = outcome.validation;
  assert.ok(validation !== null && validation.ok, "row: the application validates");
  if (validation === null || !validation.ok) return;
  assert.deepEqual(validation.application.revert?.unitIds, [removed.id],
    "row: the revert names the removed unit");
  assert.equal(f.port.live.nodes.some(node => node.id === f.first.id), false,
    "row: the removed toolcall result left the transcript");
});
