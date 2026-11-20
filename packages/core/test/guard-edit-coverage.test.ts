import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RacoonsConfig } from "../src/config.js";
import type { ForgetRequest } from "../src/engine/types.js";
import { planForget } from "../src/engine/forget.js";
import { planEntryShape } from "../src/engine/planning.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import { checkForget } from "../src/guard/checks-forget.js";
import { checkInput } from "../src/guard/checks-input.js";
import { checkInvalidation } from "../src/guard/checks-invalidation.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkProofs } from "../src/guard/checks-proofs.js";
import { checkSources, checkTranscript } from "../src/guard/checks-sources.js";
import { checkVerdicts } from "../src/guard/checks-verdicts.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationInput, ValidationIssue } from "../src/guard/types.js";
import type { RulePlan } from "../src/rules/types.js";
import type {
  CapabilityFlags, MessageNode, PathEvidence, SessionSnapshot, ToolEvidence, ToolResultNode,
  TranscriptNode,
} from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { planVerdictApplication } from "../src/verdicts/plan.js";
import type { KeptLineSpan, Verdict, VerdictBatch } from "../src/verdicts/types.js";
import { VerdictTracker } from "../src/verdicts/tracker.js";
import { context, ledger, pruneEvent } from "./guard-fixtures.js";

/**
 * Edit coverage at the guard (PRD §6.7 "an edit may land only into ranges the
 * agent actually holds as kept; a write to a path invalidates that path's
 * units"; ISSUE-045 chunk C6).
 *
 * The scene is always the same shape: a read of a path, a write to that path
 * after it, and a second read after the write. The first read is invalidated by
 * the write; the second holds the written file. The guard must refuse a partial
 * removal that keeps lines of the invalidated copy, name the write in the
 * refusal, and still admit the removals that give the whole copy up.
 */

const encoder = new TextEncoder();
const sessionId = "session-c6-guard";
const barBytes = 8;
const path = "src/app.ts";
const BODY = "head line\nbanner line\nvalue line\nfooter line\n";

const config: RacoonsConfig = {
  ...DEFAULT_CONFIG,
  thresholds: { ...DEFAULT_CONFIG.thresholds, capBytes: 8, capHeadBytes: null },
  protocol: { ...DEFAULT_CONFIG.protocol, barBytes },
};

function pathEvidence(key: string, outcome: PathEvidence["outcome"]): PathEvidence {
  return { pathKey: key, displayPath: key, title: null, lineCount: 4,
    byteLength: BODY.length, outcome };
}

function toolResult(id: string, step: number, kind: ToolEvidence["kind"],
  outcome: PathEvidence["outcome"], key = path, failed = false): ToolResultNode {
  const bytes = encoder.encode(BODY);
  const sha256 = sha256Sync(bytes);
  return {
    id, kind: "tool-result", turnOrdinal: 1, stepOrdinal: step, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: {
      kind,
      target: kind === "read" || kind === "write" ? { key, label: key } : null,
      source: { nodeId: id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [pathEvidence(key, outcome)],
      ...(failed ? { failed: true } : {}),
    },
  };
}

function assistant(nodes: readonly ToolResultNode[]): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes, sha256: sha256Sync(bytes),
    byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: nodes.map(node => node.callId),
  };
}

function capabilities(revertHistory = true): CapabilityFlags {
  return { mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
    log: true, appendRecords: true, rehydrateOnResume: false, revertHistory };
}

interface Scene {
  readonly snapshot: SessionSnapshot;
  readonly units: readonly ProcessingUnit[];
  /** The read the later write invalidated. */
  readonly stale: ProcessingUnit;
  /** The read that lands after the write: current file bytes. */
  readonly current: ProcessingUnit;
}

function snapshotOf(results: readonly ToolResultNode[]): SessionSnapshot {
  const nodes: TranscriptNode[] = [assistant(results), ...results];
  // The snapshot's step ordinal must be at least the last node's, or the
  // transcript check speaks before this chunk's check ever runs.
  const lastStep = results.reduce((max, node) => Math.max(max, node.stepOrdinal), 0);
  return {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: lastStep, nodes,
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
}

/** read (step 1), write (step 2), read (step 3): the write invalidates only the first read. */
function scene(): Scene {
  return sceneOf([
    toolResult("result-0", 1, "read", "hit"),
    toolResult("result-1", 2, "write", "unknown"),
    toolResult("result-2", 3, "read", "hit"),
  ]);
}

function sceneOf(results: readonly ToolResultNode[]): Scene {
  const snapshot = snapshotOf(results);
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  const stale = units.find(unit => unit.nodeId === "result-0");
  const current = units.find(unit => unit.nodeId === "result-2");
  assert.ok(stale !== undefined && current !== undefined, "fixture must yield both reads");
  return { snapshot, units, stale, current };
}

interface Answered {
  readonly batch: VerdictBatch;
  readonly plan: RulePlan | null;
}

/** One unit's answer, every other unit `keepall`; the plan is the real planner's. */
function answered(s: Scene, target: ProcessingUnit, action: "keepall" | "keeplines" | "forgetall",
  ranges: readonly KeptLineSpan[] = []): Answered {
  const tracker = new VerdictTracker({ units: s.units, round: 1 });
  for (const unit of s.units) {
    const verdict: Verdict = unit.id !== target.id || action === "keepall"
      ? { unitId: unit.id, action: "keepall", answeredInRound: 1 }
      : action === "keeplines"
        ? { unitId: unit.id, action: "keeplines", ranges, answeredInRound: 1 }
        : { unitId: unit.id, action: "forgetall", summary: null, answeredInRound: 1 };
    tracker.judge(verdict);
  }
  const state = tracker.state();
  return {
    batch: { round: 1, verdicts: state.verdicts },
    plan: planVerdictApplication({ state, baseRevision: s.snapshot.revision, nodes: s.snapshot.nodes }),
  };
}

function verdictInput(s: Scene, answer: Answered): ValidationInput {
  return {
    input: pruneEvent(answer.batch.verdicts, answer.batch.round),
    snapshot: s.snapshot, capabilities: capabilities(), config,
    plans: answer.plan === null ? [] : [answer.plan], sealedEpisodeIds: [], nowMs: 10,
  };
}

/** The guard's own check order, through invalidation and past the proof lane. */
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
  checkForget(c);
  checkInvalidation(c, value.plans);
  return c.issues;
}

function codes(issues: readonly ValidationIssue[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

function guard(): Guard {
  return new Guard({ ledger: ledger(),
    initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

/** Row-bound assertions: every failure names the case row that produced it. */
interface At {
  eq(actual: unknown, expected: unknown, detail: string): void;
  deep(actual: unknown, expected: unknown, detail: string): void;
  ok(value: unknown, detail: string): void;
  includes(haystack: string | undefined, needle: string, detail: string): void;
}

function at(row: string): At {
  const tag = (detail: string): string => `row: ${row} — ${detail}`;
  return {
    eq: (actual, expected, detail) => { assert.equal(actual, expected, tag(detail)); },
    deep: (actual, expected, detail) => { assert.deepEqual(actual, expected, tag(detail)); },
    ok: (value, detail) => { assert.ok(value, tag(detail)); },
    includes: (haystack, needle, detail) => {
      assert.ok(haystack?.includes(needle) === true, tag(`${detail}: ${String(haystack)}`));
    },
  };
}

// --- the refusal ------------------------------------------------------------

test("a partial removal that keeps lines of a written-over read is edit-outside-coverage", async () => {
  // The named live assertion: the refusal code, its detail and the real guard's
  // rejection are all pinned here, so this test fails by name if the check goes
  // silent or names the wrong node.
  const row = "a partial removal that keeps lines of a written-over read";
  const a = at(row);
  const s = scene();
  const answer = answered(s, s.stale, "keeplines", [{ from: 1, to: 1 }, { from: 4, to: 4 }]);
  a.ok(answer.plan !== null, "the planner must produce the partial removal");
  const value = verdictInput(s, answer);
  const issues = runChecks(value);
  a.deep(codes(issues), ["edit-outside-coverage"], "the only refusal is edit-outside-coverage");
  const refusal = issues[0];
  // The refusal names the write, so the agent can find it in its own transcript.
  a.includes(refusal?.detail, "result-1", "the detail names the write's node");
  a.includes(refusal?.detail, "step 2", "the detail names the write's step");
  a.includes(refusal?.detail, path, "the detail names the path");
  a.eq(refusal?.nodeId, "result-0", "the refusal names the invalidated unit's node");
  // And the real guard applies nothing: the whole batch is rejected.
  const validation = await guard().validate(value);
  a.eq(validation.ok, false, "the real guard rejects the batch");
  if (validation.ok) return;
  a.deep(codes(validation.issues), ["edit-outside-coverage"], "the guard's own refusal code");
});

// --- what still stands ------------------------------------------------------

interface StandsCase {
  readonly row: string;
  readonly build: () => ValidationInput;
  /** Row-specific claims the shared silence/live assertions cannot make. */
  readonly check?: (a: At, value: ValidationInput) => void;
}

/**
 * Every scene where the write is not evidence against the removal: a read that
 * already holds the written bytes, a removal that gives the whole copy up, and
 * the two lanes that re-derive the write themselves. Each row must pass both
 * the check sequence and the real guard, so a check that starts refusing these
 * fails on its own row name.
 */
const STANDS_CASES: readonly StandsCase[] = [
  {
    row: "a partial removal of a read that lands after the write passes",
    build: () => {
      const s = scene();
      // result-2 holds the written file, so lines kept from it are current.
      const answer = answered(s, s.current, "keeplines", [{ from: 1, to: 1 }, { from: 4, to: 4 }]);
      assert.ok(answer.plan !== null, "the planner must produce the partial removal");
      return verdictInput(s, answer);
    },
  },
  {
    row: "a whole-unit forgetall of the invalidated read still stands",
    build: () => {
      const s = scene();
      const answer = answered(s, s.stale, "forgetall");
      assert.ok(answer.plan !== null);
      // The removal gives up exactly the copy's own bytes and anchors no line of
      // the file, so the write fact is not evidence against it.
      return verdictInput(s, answer);
    },
  },
  {
    row: "a manual forget of the invalidated read still stands",
    build: () => {
      // One read only: a second read of the same lines would make the request
      // ambiguous, and this row is about the invalidation, not the resolution.
      const stale = toolResult("result-0", 1, "read", "hit");
      const written = toolResult("result-1", 2, "write", "unknown");
      const snapshot = snapshotOf([stale, written]);
      const request: ForgetRequest = { source: path, ranges: [], label: null };
      return {
        input: { kind: "forget", eventId: "forget-event", request },
        snapshot, capabilities: capabilities(), config,
        plans: planForget({ sessionId, config } as never, snapshot, request),
        sealedEpisodeIds: [], nowMs: 10,
      };
    },
    check: (a, value) => {
      // The manual lane resolved to exactly the invalidated unit: without this
      // the row would pass on an empty plan and prove nothing.
      const held = value.plans.flatMap(plan => plan.operations.flatMap(op =>
        op.kind === "verdict" ? [op.unitId] : []));
      const unit = new UnitTracker({ sessionId, barBytes }).units(value.snapshot)
        .find(candidate => candidate.nodeId === "result-0");
      a.ok(unit !== undefined, "the invalidated read is still a unit");
      a.deep(held, [unit?.id], "the forget resolved to the invalidated read alone");
    },
  },
  {
    row: "a stale-read proof burns the invalidated read, because the write is its proof",
    build: () => {
      const s = scene();
      const unit = s.stale;
      const plan: RulePlan = {
        ruleId: "stale-read", baseRevision: s.snapshot.revision,
        removals: [{ id: unit.id, title: `stale ${path}`, sources: [{
          source: { ...unit.source }, ranges: [{ ...unit.span.byteRange }],
        }] }],
        notes: [{ id: `receipt:${unit.id}`, kind: "proof-receipt", proofKind: "stale-read",
          removalId: unit.id, unitId: unit.id, path, ranges: [] }],
        operations: [{ kind: "proof", proofKind: "stale-read", removalId: unit.id,
          unitId: unit.id, noteId: `receipt:${unit.id}` }],
      };
      return {
        input: { kind: "at-rest", eventId: "at-rest-event", reason: "step" },
        snapshot: s.snapshot, capabilities: capabilities(), config,
        plans: [plan], sealedEpisodeIds: [], nowMs: 10,
      };
    },
    check: (a, value) => {
      // The proof lane re-derives the same write the invalidation blames.
      a.eq(value.plans.length, 1, "the proof plan reached the checks");
      a.eq(value.plans[0]?.operations[0]?.kind, "proof", "the plan's operation is the proof");
    },
  },
  {
    row: "a failed write never refuses a partial removal of the earlier read",
    build: () => {
      // ISSUE-328: the host declared the write failed, so the file is unchanged
      // and the first read's kept lines are still current file state.
      const s = sceneOf([
        toolResult("result-0", 1, "read", "hit"),
        toolResult("result-1", 2, "write", "unknown", path, true),
        toolResult("result-2", 3, "read", "hit"),
      ]);
      const answer = answered(s, s.stale, "keeplines", [{ from: 1, to: 1 }, { from: 4, to: 4 }]);
      assert.ok(answer.plan !== null, "the planner must produce the partial removal");
      return verdictInput(s, answer);
    },
    check: (a, value) => {
      const write = value.snapshot.nodes.find(node => node.id === "result-1");
      a.eq(write?.kind === "tool-result" && write.evidence.failed, true,
        "the write node carries the host's failure flag");
    },
  },
  {
    row: "a transcript with no write never refuses a partial removal",
    build: () => {
      const s = sceneOf([toolResult("result-0", 1, "read", "hit"),
        toolResult("result-2", 3, "read", "hit")]);
      const answer = answered(s, s.stale, "keeplines", [{ from: 1, to: 1 }, { from: 4, to: 4 }]);
      assert.ok(answer.plan !== null);
      return verdictInput(s, answer);
    },
  },
];

test("the invalidation stays silent where the write is not evidence — one row per scene", async () => {
  for (const expected of STANDS_CASES) {
    const a = at(expected.row);
    const value = expected.build();
    a.deep(runChecks(value), [], "the check sequence reports nothing");
    expected.check?.(a, value);
    const validation = await guard().validate(value);
    a.eq(validation.ok, true, `the real guard accepts: ${JSON.stringify(validation)}`);
  }
});

// --- the shape lane is covered too (ISSUE-311) ------------------------------

/**
 * A multi-row entry batch: row 1's read lands, then a write P lands before row
 * 1's answer is validated. The answer shapes the stale read (a partial keep),
 * and the batch-row event id (`#1`) exempts it from the newest-result fence in
 * `checkSources`. The write invalidated that read, so the shaped turn's kept
 * lines are not current file state — `edit-outside-coverage` must refuse the
 * shape op exactly as it refuses a verdict op (PRD §6.7).
 */
test("a shape op naming a write-invalidated unit is edit-outside-coverage", async () => {
  const row = "a shape op naming a write-invalidated unit";
  const a = at(row);
  const stale = toolResult("result-0", 1, "read", "hit");
  const write = toolResult("result-1", 2, "write", "unknown");
  const snapshot = snapshotOf([stale, write]);
  // The entry lane mints at the floor; set it to the bar so the shape op's unit
  // id is the same whole-result unit the invalidation map keys on.
  const shapeConfig: RacoonsConfig = { ...config, floorBytes: barBytes };
  const unit = new UnitTracker({ sessionId, barBytes }).unitsFor(stale)[0];
  a.ok(unit !== undefined, "the landed read mints a unit");
  const answer: EntryAnswer = { action: "keeplines",
    ranges: [{ from: 1, to: 1 }, { from: 4, to: 4 }], summary: "stale run notes" };
  const shaped = planEntryShape({ unitId: unit?.id ?? "", nodeId: stale.id,
    originalBytes: stale.bytes, answer }, snapshot);
  a.eq(shaped.action, "shape", "the answer plans a partial shape");
  if (shaped.action !== "shape") return;
  const value: ValidationInput = {
    input: { kind: "entry", eventId: "answer#1", result: stale, answer,
      stamp: { unitId: unit?.id ?? "", answeredInRound: 0 } },
    snapshot, capabilities: capabilities(), config: shapeConfig,
    plans: [shaped.plan], sealedEpisodeIds: [], nowMs: 10,
  };
  a.eq(value.plans[0]?.operations[0]?.kind, "shape", "the plan carries a shape op");
  const issues = runChecks(value);
  a.deep(codes(issues), ["edit-outside-coverage"], "the shape lane is covered like the verdict lane");
  const refusal = issues[0];
  a.includes(refusal?.detail, "result-1", "the detail names the write's node");
  a.eq(refusal?.nodeId, "result-0", "the refusal names the invalidated unit's node");
  const validation = await guard().validate(value);
  a.eq(validation.ok, false, "the real guard rejects the shaped stale turn");
  if (!validation.ok) a.deep(codes(validation.issues), ["edit-outside-coverage"], "the guard's own refusal code");
});
