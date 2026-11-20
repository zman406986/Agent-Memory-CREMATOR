import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { buildCandidate } from "../src/guard/candidate.js";
import { checkInput } from "../src/guard/checks-input.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkOutput } from "../src/guard/checks-output.js";
import { checkProofs } from "../src/guard/checks-proofs.js";
import { checkSources, checkTranscript } from "../src/guard/checks-sources.js";
import { checkVerdicts } from "../src/guard/checks-verdicts.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationInput, ValidationIssue } from "../src/guard/types.js";
import type { ProofKind, RulePlan } from "../src/rules/types.js";
import type {
  CapabilityFlags, MessageNode, PathEvidence, ToolResultNode, TranscriptNode,
} from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { context, ledger } from "./guard-fixtures.js";

/**
 * The proof lane's guard (ADR-0018; PRD §6.6; ISSUE-045 chunk C4).
 *
 * A `proof` op is the one removal the guard can re-derive from bytes alone, and
 * that is exactly what these tests pin: the guard never trusts the plan's claim
 * that a read is stale or superseded. It recomputes the claim from the
 * snapshot's own nodes and refuses a forged one as `proof-unproven`. Nothing is
 * repaired, because a repaired removal would be a removal no byte proves.
 */

const encoder = new TextEncoder();
const sessionId = "session";
const barBytes = 8;
const path = "src/app.ts";
const body = "alpha line\nbeta line\n";

const config: RacoonsConfig = {
  thresholds: {
    capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
  },
  freshZone: { maxNodes: null, maxBytes: null },
  sealMode: "append",
  validationFailureLimit: 2,
  protocol: {
    barBytes, minCutFreedBytes: 4096,
  },
};

/** One tool result with the given evidence kind and body, at the given step. */
function toolResult(options: {
  readonly id: string;
  readonly step: number;
  readonly text?: string;
  readonly kind: ToolResultNode["evidence"]["kind"];
  readonly pathKey?: string;
  readonly targetKey?: string | null;
  /** The host's scope declaration on the read's own observation (ADR-0037). */
  readonly coverage?: PathEvidence["coverage"];
  readonly outcome?: PathEvidence["outcome"];
  /** The request's declared argument payload (class 1; ISSUE-151). */
  readonly callArguments?: string;
  /** The host's own report that the call failed (ISSUE-328). */
  readonly failed?: boolean;
}): ToolResultNode {
  const bytes = encoder.encode(options.text ?? body);
  const sha256 = sha256Sync(bytes);
  const pathKey = options.pathKey ?? path;
  const targetKey = options.targetKey === undefined ? pathKey : options.targetKey;
  return {
    id: options.id, kind: "tool-result", turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    ...(options.callArguments === undefined
      ? {} : { callArguments: encoder.encode(options.callArguments) }),
    evidence: {
      kind: options.kind,
      target: targetKey === null ? null : { key: targetKey, label: targetKey },
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      ...(options.failed === true ? { failed: true } : {}),
      // A write proves a path changed and nothing else, so its outcome is
      // always unknown (E0); a read here is a hit so the unit carries a path.
      paths: [{ pathKey, displayPath: pathKey, title: null, lineCount: 2,
        byteLength: bytes.length,
        outcome: options.outcome ?? (options.kind === "write" ? "unknown" : "hit"),
        ...(options.coverage === undefined ? {} : { coverage: options.coverage }) }],
    },
    embeddedRecords: [],
  };
}

function assistant(resultIds: readonly string[]): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: resultIds.map(id => `call-${id}`),
  };
}

function capabilities(revertHistory = true): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
    log: true, appendRecords: true, rehydrateOnResume: false, revertHistory,
  };
}

/** The snapshot: a warm cache at the transcript head, nothing in flight. */
function snapshotOf(nodes: readonly TranscriptNode[]) {
  return {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: nodes.length, nodes,
    cache: { kind: "warm" as const, watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
}

/** Prints one source's only byte range, or fails: every proof removal has one. */
function known<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

interface Scene {
  readonly nodes: readonly TranscriptNode[];
  readonly units: readonly ProcessingUnit[];
}

/**
 * A read of `path`, optionally followed by a write to it (stale-read) or an
 * exact later re-read of it (superseded-read). The read is node index 1.
 */
function scene(kind: "stale" | "superseded" | "none", options: {
  readonly laterBytes?: string;
} = {}): Scene {
  const read = toolResult({ id: "result-0", step: 1, kind: "read" });
  const later: TranscriptNode[] = [];
  if (kind === "stale") later.push(toolResult({ id: "result-1", step: 2, kind: "write" }));
  if (kind === "superseded") later.push(toolResult({ id: "result-1", step: 2, kind: "read",
    ...(options.laterBytes === undefined ? {} : { text: options.laterBytes }) }));
  // The assistant turn declares every call the results answer, or the pairing
  // check speaks before the proof check and every refusal would be ambiguous.
  const nodes: TranscriptNode[] = [assistant(["result-0", "result-1"]), read, ...later];
  const snapshot = snapshotOf(nodes);
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  return { nodes, units };
}

/**
 * The plan the stale-read and superseded-read rules emit (chunk C3): one
 * removal over exactly the unit's own span, one proof receipt, one op. Built
 * here by hand so C4 is tested against the contract, not against C3's runtime.
 */
function proofPlan(unit: ProcessingUnit, proofKind: ProofKind,
  overrides: Partial<RulePlan> = {}): RulePlan {
  return {
    ruleId: proofKind,
    baseRevision: "revision-1",
    removals: [{ id: unit.id, title: `stale ${path}`, sources: [{
      source: { ...unit.source }, ranges: [{ ...unit.span.byteRange }],
    }] }],
    notes: [{ id: `receipt:${unit.id}`, kind: "proof-receipt", proofKind,
      removalId: unit.id, unitId: unit.id, path: unit.path ?? unit.nodeId, ranges: [] }],
    operations: [{ kind: "proof", proofKind, removalId: unit.id, unitId: unit.id,
      noteId: `receipt:${unit.id}` }],
    ...overrides,
  };
}

function inputFor(scene: Scene, plans: readonly RulePlan[], overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    input: { kind: "at-rest", eventId: "at-rest-event", reason: "step" },
    snapshot: snapshotOf(scene.nodes),
    capabilities: capabilities(),
    config,
    plans: plans.length === 0 ? [] : [...plans],
    sealedEpisodeIds: [],
    nowMs: 10,
    ...overrides,
  };
}

/** The guard's own check order, up to where rendering begins. */
function runChecks(value: ValidationInput): readonly ValidationIssue[] {
  const c = context(value);
  const report = (code: ValidationCode, detail: string): void => {
    c.issues.push({ code, detail, nodeId: null, ruleId: null, operationIndex: null });
  };
  checkInput(value, report);
  checkTranscript(c);
  checkVerdicts(c, value.plans);
  checkSources(c, value.plans);
  checkOperations(c, value.plans);
  checkProofs(c, value.plans);
  return [...c.issues];
}

function codes(issues: readonly ValidationIssue[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

function guard(): Guard {
  return new Guard({ ledger: ledger(), initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

// --- the proof that proves --------------------------------------------------

test("a proved read applies as one checkpoint-revert, its shape taken from the fact", async () => {
  const stale = scene("stale");
  const staleUnit = known(stale.units[0], "unit");
  const value = inputFor(stale, [proofPlan(staleUnit, "stale-read")]);
  assert.deepEqual(runChecks(value), [], "row: stale-read — a proven stale read passes every check");
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.mode, "revert", "row: stale-read — a proof burns by checkpoint-revert");
  const revert = known(validation.application.revert, "revert plan");
  assert.equal(revert.cutIndex, 1, "row: stale-read — the burn's node index is its cut");
  assert.deepEqual(revert.unitIds, [staleUnit.id], "row: stale-read — the burned unit");
  assert.equal(validation.application.archives.length, 1, "row: stale-read — one archive");
  assert.equal(validation.application.archives[0]?.operationKind, "proof", "row: stale-read — op kind");
  assert.equal(validation.application.archives[0]?.ruleId, "stale-read", "row: stale-read — rule id");

  const superseded = scene("superseded");
  const supersededUnit = known(superseded.units[0], "unit");
  const second = inputFor(superseded, [proofPlan(supersededUnit, "superseded-read")]);
  assert.deepEqual(runChecks(second), [], "row: superseded-read — passes every check");
  const applied = await guard().validate(second);
  if (!applied.ok) assert.fail(JSON.stringify(applied.issues));
  assert.equal(applied.application.archives[0]?.operationKind, "proof", "row: superseded-read — op kind");
  assert.equal(applied.application.archives[0]?.ruleId, "superseded-read", "row: superseded-read — rule id");
});

/**
 * The call echo's two sides (ADR-0037 decision 2, class 1; ISSUE-151): the
 * guard re-derives the exact-equality fact from the snapshot, so a plan that
 * claims an echo the bytes do not show is refused, and a result that carries
 * previous state is never edited into an echo.
 */
test("a call echo applies only when the result restates its request and adds nothing", async () => {
  const todos = [{ content: "one", status: "pending" }];
  const echo = toolResult({
    id: "result-0", step: 1, kind: "other",
    text: JSON.stringify({ todos }),
    callArguments: JSON.stringify({ todos }),
  });
  const nodes: TranscriptNode[] = [assistant(["result-0"]), echo];
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshotOf(nodes));
  const unit = known(units[0], "unit");

  const value = inputFor({ nodes, units }, [proofPlan(unit, "call-echo")]);
  assert.deepEqual(runChecks(value), [], "row: exact echo — passes every check");
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.mode, "revert", "row: exact echo — one checkpoint-revert");
  assert.equal(validation.application.archives[0]?.operationKind, "proof",
    "row: exact echo — a proof burn");
  assert.equal(validation.application.archives[0]?.ruleId, "call-echo",
    "row: exact echo — the class rule is the rule id");

  // The same result plus a previous-state field the request never held is not
  // an echo: the whole result is the only copy, so the proof is refused and
  // nothing is removed.
  const withState = toolResult({
    id: "result-0", step: 1, kind: "other",
    text: JSON.stringify({ todos, oldTodos: [{ content: "yesterday" }] }),
    callArguments: JSON.stringify({ todos }),
  });
  const stateNodes: TranscriptNode[] = [assistant(["result-0"]), withState];
  const stateUnits = new UnitTracker({ sessionId, barBytes }).units(snapshotOf(stateNodes));
  const stateUnit = known(stateUnits[0], "unit");
  const issues = runChecks(inputFor({ nodes: stateNodes, units: stateUnits },
    [proofPlan(stateUnit, "call-echo")]));
  assert.deepEqual(codes(issues), ["proof-unproven"],
    "row: previous state — the only issue is the unproven proof");
  assert.ok(issues.some(issue => issue.detail.includes("argument echo")),
    "row: previous state — the refusal names the missing echo");

  // A result item the request never declared is not an echo either.
  const extra = toolResult({
    id: "result-0", step: 1, kind: "other",
    text: JSON.stringify({ todos: [...todos, { content: "two" }] }),
    callArguments: JSON.stringify({ todos }),
  });
  const extraNodes: TranscriptNode[] = [assistant(["result-0"]), extra];
  const extraUnits = new UnitTracker({ sessionId, barBytes }).units(snapshotOf(extraNodes));
  const extraIssues = runChecks(inputFor({ nodes: extraNodes, units: extraUnits },
    [proofPlan(known(extraUnits[0], "unit"), "call-echo")]));
  assert.deepEqual(codes(extraIssues), ["proof-unproven"],
    "row: added item — a different list does not prove the echo");
});

// --- the proof that does not prove -----------------------------------------

/**
 * A read of `path` at node index 1, followed by a later read of the same path
 * whose bytes differ. `coverage` is the LATER read's scope declaration and
 * `outcome` its observed result; `kind` lets a test make the REMOVED node
 * something other than a read.
 */
function samePathScene(options: {
  readonly coverage?: PathEvidence["coverage"];
  readonly outcome?: PathEvidence["outcome"];
  readonly kind?: ToolResultNode["evidence"]["kind"];
  readonly between?: readonly TranscriptNode[];
} = {}): Scene {
  const first = toolResult({ id: "result-0", step: 1, kind: options.kind ?? "read" });
  const later = toolResult({ id: "result-1", step: 3, kind: "read",
    text: "alpha line\nbeta line changed\n",
    ...(options.coverage === undefined ? {} : { coverage: options.coverage }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }) });
  const nodes: TranscriptNode[] = [assistant(["result-0", "result-1", "result-2"]), first,
    ...(options.between ?? []), later];
  const snapshot = snapshotOf(nodes);
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  return { nodes, units };
}

/** A verbatim proof receipt: the plan a forged row starts from. */
function receiptFor(unit: ProcessingUnit, proofKind: ProofKind): RulePlan {
  return proofPlan(unit, proofKind);
}

/**
 * One way a proof plan can be refused. `armed` asserts the scene really does
 * carry the claim the row is about, so a pass is never another clause's doing.
 */
interface UnprovenRow {
  readonly name: string;
  readonly kind: ProofKind;
  /** The clause the refusal must name; `null` where the rule has no witness text. */
  readonly detail: string | null;
  readonly build: () => Scene;
  /** Which node the refusal names as the proof's subject. */
  readonly subject: string;
  readonly armed?: (settled: Scene) => void;
}

const UNPROVEN_ROWS: readonly UnprovenRow[] = [
  {
    name: "stale-read with no later write at all",
    kind: "stale-read",
    detail: "No later write",
    build: () => scene("none"),
    subject: "result-0",
    armed: settled => assert.equal(settled.nodes.length, 2,
      "row: no later write — the snapshot holds only the read, so no write can witness it"),
  },
  {
    name: "stale-read whose only later write failed",
    kind: "stale-read",
    detail: "No later write",
    build: () => {
      const read = toolResult({ id: "result-0", step: 1, kind: "read" });
      const failedWrite = toolResult({ id: "result-1", step: 2, kind: "write", failed: true });
      const nodes: TranscriptNode[] = [assistant(["result-0", "result-1"]), read, failedWrite];
      const snapshot = snapshotOf(nodes);
      return { nodes, units: new UnitTracker({ sessionId, barBytes }).units(snapshot) };
    },
    subject: "result-0",
    armed: settled => {
      // A later write-kind node naming the read's path exists; only its failure
      // flag can refuse the claim (ISSUE-328).
      const later = settled.nodes[2];
      assert.equal(later?.kind === "tool-result" && later.evidence.kind, "write",
        "row: failed write — the later node is a write");
      assert.equal(later?.kind === "tool-result" && later.evidence.failed, true,
        "row: failed write — the host declared the failure");
    },
  },
  {
    name: "stale-read over a miss read, which holds no file bytes",
    kind: "stale-read",
    detail: "No later write",
    build: () => {
      const missRead = toolResult({ id: "result-0", step: 1, kind: "read", outcome: "miss" });
      const laterWrite = toolResult({ id: "result-1", step: 2, kind: "write" });
      const nodes: TranscriptNode[] = [assistant(["result-0", "result-1"]), missRead, laterWrite];
      const snapshot = snapshotOf(nodes);
      return { nodes, units: new UnitTracker({ sessionId, barBytes }).units(snapshot) };
    },
    subject: "result-0",
    armed: settled => {
      // A later write naming the read's own pathKey exists; only the read's
      // miss outcome can refuse the claim (ISSUE-339: hit-only, like the
      // invalidation lane).
      const read = settled.nodes[1];
      const later = settled.nodes[2];
      assert.equal(read?.kind === "tool-result" && read.evidence.paths[0]?.outcome, "miss",
        "row: miss read — the read declared a miss");
      assert.equal(later?.kind === "tool-result" && later.evidence.paths[0]?.pathKey, path,
        "row: miss read — the write names the read's own pathKey");
    },
  },
  {
    name: "stale-read over a write, which is never a proof subject",
    kind: "stale-read",
    detail: null,
    build: () => {
      const read = toolResult({ id: "result-1", step: 2, kind: "read" });
      const nodes: TranscriptNode[] = [assistant(["result-0", read.id]),
        toolResult({ id: "result-0", step: 1, kind: "write" }), read];
      const snapshot = snapshotOf(nodes);
      return { nodes, units: new UnitTracker({ sessionId, barBytes }).units(snapshot) };
    },
    subject: "result-1",
  },
  {
    name: "superseded-read with a later read of different bytes",
    kind: "superseded-read",
    detail: "No later read",
    build: () => scene("superseded", { laterBytes: "alpha line\nbeta lines\n" }),
    subject: "result-0",
    armed: settled => assert.equal(settled.nodes.length, 3,
      "row: different bytes — a later same-target read exists, so only the byte comparison refuses it"),
  },
  {
    name: "superseded-by-reread whose later read declares partial coverage",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => samePathScene({ coverage: "partial" }),
    subject: "result-0",
  },
  {
    name: "superseded-by-reread whose later read failed",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => samePathScene({ coverage: "full", outcome: "miss" }),
    subject: "result-0",
  },
  {
    name: "superseded-by-reread whose later read declares no coverage at all",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => samePathScene({}),
    subject: "result-0",
  },
  {
    name: "superseded-by-reread whose later read covers the whole file but a write sits between",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => samePathScene({ coverage: "full",
      between: [toolResult({ id: "result-2", step: 2, kind: "write" })] }),
    subject: "result-0",
    armed: settled => {
      // The witness is whole-file; only the intervening write can refuse it.
      assert.equal(settled.nodes.length, 4, "row: intervening write — the write node is in the snapshot");
      const later = settled.nodes[3];
      assert.equal(later?.kind === "tool-result" && later.evidence.kind, "read",
        "row: intervening write — the last node is still the whole-file read");
    },
  },
  {
    name: "superseded-by-reread whose window holds a shell result of unknown effect",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => samePathScene({ coverage: "full",
      between: [toolResult({ id: "result-2", step: 2, kind: "other" })] }),
    subject: "result-0",
    armed: settled => {
      // The witness is whole-file and no write-kind node sits between; only the
      // unattributable shell result can refuse the claim (ISSUE-330).
      const between = settled.nodes[2];
      assert.equal(between?.kind === "tool-result" && between.evidence.kind, "other",
        "row: shell between — the window node is kind other");
    },
  },
  {
    name: "superseded-by-reread whose window holds a call with no result node",
    kind: "superseded-by-reread",
    detail: "No later whole-file read",
    build: () => {
      const aborted: MessageNode = {
        id: "assistant-abort", kind: "message", role: "assistant",
        bytes: encoder.encode("aborted request"), sha256: sha256Sync(encoder.encode("aborted request")),
        byteLength: encoder.encode("aborted request").length, turnOrdinal: 1, stepOrdinal: 2,
        toolCallIds: ["call-aborted"],
      };
      return samePathScene({ coverage: "full", between: [aborted] });
    },
    subject: "result-0",
    armed: settled => {
      // The declaration is in the window and no result node anywhere answers it.
      const between = settled.nodes[2];
      assert.equal(between?.kind === "message" && between.toolCallIds.includes("call-aborted"), true,
        "row: aborted call — the window declares the call");
      assert.equal(settled.nodes.some(node => node.kind === "tool-result"
        && node.callId === "call-aborted"), false,
      "row: aborted call — no result node answers it");
    },
  },
  {
    name: "superseded-by-reread over a write, which is never an older snapshot",
    kind: "superseded-by-reread",
    detail: null,
    build: () => samePathScene({ coverage: "full", kind: "write" }),
    subject: "result-0",
    armed: settled => {
      // A whole-file later read with no write between exists; only the removed
      // node's own kind can refuse this row.
      const witness = settled.nodes[2];
      assert.equal(witness?.kind === "tool-result" && witness.evidence.kind, "read",
        "row: write subject — the later node is a read");
      const observation = witness?.kind === "tool-result"
        ? witness.evidence.paths.find(entry => entry.pathKey === path) : undefined;
      assert.equal(observation?.outcome, "hit", "row: write subject — the witness read succeeded");
      assert.equal(observation.coverage, "full", "row: write subject — the witness read is whole-file");
    },
  },
];

test("a claim the snapshot does not prove is refused as proof-unproven, one clause per row", async () => {
  for (const row of UNPROVEN_ROWS) {
    const settled = row.build();
    row.armed?.(settled);
    const unit = known(settled.units.find(candidate => candidate.nodeId === row.subject)
      ?? settled.units[0], "unit");
    const issues = runChecks(inputFor(settled, [proofPlan(unit, row.kind)]));
    assert.deepEqual(codes(issues), ["proof-unproven"], `row: ${row.name} — only the proof gate speaks`);
    if (row.detail !== null) {
      assert.ok(issues.some(issue => issue.detail.includes(row.detail!)), `row: ${row.name} — ${
        JSON.stringify(issues.map(issue => issue.detail))}`);
    }
    // The read's own bytes are the proof's subject; the refusal names them.
    assert.equal(issues[0]?.nodeId, row.subject, `row: ${row.name} — the refusal names the read`);
  }
  // A partial witness must also leave the breaker armed and remove nothing.
  const partial = samePathScene({ coverage: "partial" });
  const unit = known(partial.units[0], "unit");
  const validation = await guard().validate(inputFor(partial, [proofPlan(unit, "superseded-by-reread")]));
  assert.equal(validation.ok, false, "row: partial witness — the application is refused");
  assert.equal(validation.breaker.consecutiveValidationFailures, 1,
    "row: partial witness — the refusal counts on the breaker");
  assert.equal("application" in validation, false,
    "row: partial witness — a refused proof removes nothing");
});

test("a proof whose plan does not match the fact is refused, one clause per row", () => {
  const settled = scene("stale");
  const unit = known(settled.units[0], "unit");
  const cases: readonly (readonly [string, RulePlan, string])[] = [
    ["the removal is one byte short of the unit's span", proofPlan(unit, "stale-read", {
      removals: [{ id: unit.id, title: "stale", sources: [{ source: { ...unit.source },
        ranges: [{ startByte: 1, endByteExclusive: unit.span.byteRange.endByteExclusive }] }] }],
    }), "exactly the unit's own span"],
    ["the op names no unit the snapshot holds", proofPlan(unit, "stale-read", {
      operations: [{ kind: "proof", proofKind: "stale-read", removalId: unit.id,
        unitId: "unit:sha256:absent", noteId: `receipt:${unit.id}` }],
      notes: [{ id: `receipt:${unit.id}`, kind: "proof-receipt", proofKind: "stale-read",
        removalId: unit.id, unitId: "unit:sha256:absent", path: unit.path ?? unit.nodeId, ranges: [] }],
    }), "names no unit the snapshot holds"],
  ];
  for (const [name, plan, detail] of cases) {
    const issues = runChecks(inputFor(settled, [plan]));
    assert.deepEqual(codes(issues), ["proof-unproven"], `row: ${name} — only the proof gate speaks`);
    assert.ok(issues.some(issue => issue.detail.includes(detail)), `row: ${name} — ${
      JSON.stringify(issues.map(issue => issue.detail))}`);
  }
});

// --- the rule and the op must name one byte fact ---------------------------

test("a proof op under a rule that names another fact is wrong-rule", () => {
  const settled = scene("stale");
  const unit = known(settled.units[0], "unit");
  const cases: readonly (readonly [string, RulePlan])[] = [
    ["a proof rule naming another byte fact", proofPlan(unit, "stale-read", { ruleId: "superseded-read" })],
    ["a rule that is not a proof rule at all", proofPlan(unit, "stale-read", { ruleId: "seal" })],
  ];
  for (const [name, plan] of cases) {
    assert.deepEqual(codes(runChecks(inputFor(settled, [plan]))), ["wrong-rule"],
      `row: ${name} — the op and the rule disagree`);
  }
});

// --- the entry fence (ISSUE-307) --------------------------------------------

/**
 * A proof burn applies by checkpoint-revert, and an entry application is mode
 * "entry" — the one mode that may not carry a revert payload (guard/types.ts).
 * The source fence already refuses an entry removal naming older history, so
 * the reachable hole is a proof naming the LANDED entry result itself: here a
 * call-echo over the incoming result. The guard must refuse the plan, never
 * hand the ledger an entry application with a sealed revert (hash-mismatch).
 */
test("a proof plan on an entry event is refused, never an entry application carrying a revert", async () => {
  const todos = [{ content: "one", status: "pending" }];
  const echo = toolResult({
    id: "result-0", step: 1, kind: "other",
    text: JSON.stringify({ todos }),
    callArguments: JSON.stringify({ todos }),
  });
  const nodes: TranscriptNode[] = [assistant(["result-0"]), echo];
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshotOf(nodes));
  const unit = known(units[0], "unit");
  const value = inputFor({ nodes, units }, [proofPlan(unit, "call-echo")], {
    input: { kind: "entry", eventId: "entry-event", result: echo },
  });
  const validation = await guard().validate(value);
  assert.equal(validation.ok, false,
    `a proof plan on an entry event must be refused: ${JSON.stringify(validation.ok
      ? { mode: validation.application.mode, hasRevert: validation.application.revert !== undefined }
      : validation.issues)}`);
  if (!validation.ok) {
    assert.ok(validation.issues.some(issue => issue.code === "invalid-plan"
      && issue.detail.includes("non-entry")), JSON.stringify(validation.issues));
  }
});

// --- class 2: superseded-by-reread (ADR-0037; ISSUE-145) ---------------------

test("a later whole-file read of the same path proves an older snapshot, and two burns on one node are refused", async () => {
  const settled = samePathScene({ coverage: "full" });
  const unit = known(settled.units[0], "unit");
  const value = inputFor(settled, [proofPlan(unit, "superseded-by-reread")]);
  assert.deepEqual(runChecks(value), [], "row: full read — a whole-file later read proves the burn");
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  const application = validation.application;
  assert.equal(application.mode, "revert", "row: full read — mode");
  // One receipt, one archive row: the proof lane's ordinary shape, no descriptor.
  assert.equal(application.appendRecords.length, 1, "row: full read — one receipt");
  assert.equal(application.archives.length, 1, "row: full read — one archive");
  assert.equal(application.archives[0]?.operationKind, "proof", "row: full read — op kind");
  assert.equal(application.archives[0]?.ruleId, "superseded-by-reread", "row: full read — rule id");
  const recallId = known(application.archives[0], "archive").recall.id;
  const line = new TextDecoder().decode(known(application.appendRecords[0], "record").bytes);
  assert.ok(line.includes(recallId), `row: full read — the receipt names its recall id: ${line}`);
  assert.ok(line.includes(path), `row: full read — the receipt names the path: ${line}`);
  // The burn is a checkpoint-revert at the removed read's own index.
  const revert = known(application.revert, "revert plan");
  assert.equal(revert.cutIndex, 1, "row: full read — cut index");
  assert.deepEqual(revert.unitIds, [unit.id], "row: full read — the burned unit");

  // A second plan over the SAME node: two reverted removals cannot share it.
  const first = receiptFor(unit, "superseded-by-reread");
  const second = proofPlan(unit, "superseded-by-reread", {
    removals: [{ id: `${unit.id}:again`, title: `again ${path}`, sources: [{
      source: { ...unit.source }, ranges: [{ ...unit.span.byteRange }] }] }],
    notes: [{ id: `receipt:again:${unit.id}`, kind: "proof-receipt",
      proofKind: "superseded-by-reread", removalId: `${unit.id}:again`, unitId: unit.id,
      path: unit.path ?? unit.nodeId, ranges: [] }],
    operations: [{ kind: "proof", proofKind: "superseded-by-reread",
      removalId: `${unit.id}:again`, unitId: unit.id, noteId: `receipt:again:${unit.id}` }],
  });
  const doubled = inputFor(settled, [first, second]);
  // The guard's checks report the contradiction; the candidate builder is the
  // last lock and refuses to materialize two receipts for one node.
  assert.equal(codes(runChecks(doubled)).includes("conflicting-operations"), true,
    "row: two burns on one node — the checks report the contradiction");
  await assert.rejects(() => buildCandidate(context(doubled)),
    /Two reverted removals share one node/u,
    "row: two burns on one node — materialization refuses");
});

test("a failed write between the reads no longer withholds the superseded-by-reread proof", async () => {
  // ISSUE-330 via ISSUE-328: the shared writtenBetween reads writePathSpellings,
  // and a failed write yields none — the file is unchanged, so the burn stands.
  const settled = samePathScene({ coverage: "full",
    between: [toolResult({ id: "result-2", step: 2, kind: "write", failed: true })] });
  const unit = known(settled.units[0], "unit");
  const value = inputFor(settled, [proofPlan(unit, "superseded-by-reread")]);
  assert.deepEqual(runChecks(value), [], "a failed write between blocks no proof");
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.archives[0]?.ruleId, "superseded-by-reread");
});

// --- the receipt expectation is independent (ISSUE-314) ---------------------

/**
 * The output check compares the rendered receipt bytes against an expectation
 * that must be derived independently of that render. When the expectation is
 * seeded from the rendered bytes themselves, a render defect self-approves:
 * the comparison can never catch it. Here a malformed receipt byte (with a
 * matching hash) is injected into the rendered record; the output check must
 * refuse it because the expected bytes are re-encoded from the receipt's own
 * inputs, mirroring the seal-append lane.
 */
test("a corrupted proof receipt render is caught by the output check, not self-approved", async () => {
  const settled = scene("stale");
  const unit = known(settled.units[0], "unit");
  const value = inputFor(settled, [proofPlan(unit, "stale-read")]);
  const candidate = await buildCandidate(context(value));
  const record = known(candidate.appendRecords[0], "receipt record");
  // Seed proof: the honest render passes the output check.
  const honest = context(value);
  checkOutput(honest, candidate);
  assert.deepEqual(honest.issues, [], "the honest proof receipt passes the output check");
  // Inject the render defect into the rendered buffer and re-hash it, as a
  // renderer emitting malformed bytes would. If the expectation IS this buffer
  // it corrupts identically and self-approves; an independent re-encoding of the
  // inputs stays correct and catches it.
  record.bytes[0] = (record.bytes[0] ?? 0) ^ 0xff;
  // Re-hash the malformed bytes as a renderer would. The record's sha256 is
  // readonly, so ship a fresh record over the SAME (now corrupted) buffer: when
  // the expectation is that buffer it corrupts identically and self-approves.
  candidate.appendRecords[0] = { ...record, sha256: sha256Sync(record.bytes) };
  const corrupted = context(value);
  checkOutput(corrupted, candidate);
  assert.ok(corrupted.issues.some(issue => issue.code === "invalid-generated-record"),
    `a corrupted receipt render must be caught: ${JSON.stringify(corrupted.issues)}`);
});
