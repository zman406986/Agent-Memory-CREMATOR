import assert from "node:assert/strict";
import { test } from "node:test";
import { planApplication, planEntryShape } from "../src/engine/planning.js";
import type { EntryShapePlan } from "../src/engine/planning.js";
import type { EngineOptions } from "../src/engine/types.js";
import { buildCandidate } from "../src/guard/candidate.js";
import type { Candidate } from "../src/guard/candidate.js";
import { checkInput } from "../src/guard/checks-input.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkSources } from "../src/guard/checks-sources.js";
import { checkOutput } from "../src/guard/checks-output.js";
import type { ValidationCode, ValidationInput } from "../src/guard/types.js";
import type { Rule, RulePlan, ShapeOp } from "../src/rules/types.js";
import type { RacoonsConfig } from "../src/config.js";
import type { SessionSnapshot, ToolResultNode } from "../src/types/transcript.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import { UnitTracker } from "../src/units/tracker.js";
import { sha256Sync } from "../src/util/hash.js";
import { splitLineOffsets } from "../src/util/lines.js";
import { context as fixtureContext, encode } from "./guard-fixtures.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkShapeReplacement } from "../src/guard/checks-entry-shape.js";
import { finalizeCandidate } from "../src/guard/finalize.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { shapeMarker } from "../src/rules/assets.js";

/**
 * The guard's entry-shape enforcement against the LANDED node (ISSUE-058 chunk
 * P3b; ADR-0022 §12–§14).
 *
 * A `shape` plan is admitted only under the `entry-shape` rule id, and every
 * claim it makes is re-derived from the landed result's own bytes — never from
 * the planner's arithmetic:
 *
 * - (a) the removal names the landed result, and `originalBytes` IS that body;
 * - (b) kept ranges are whole-line spans of it and the removal is their exact
 *   complement; (c) `op.unitId` is the landed unit, re-derived here;
 * - (d) `replacementBytes` re-renders byte-exact (one marker per gap, the
 *   dropped-bytes slot, the archive's own recall id);
 * - (e) the archive covers the ORIGINAL body under exactly the dropped ranges.
 *
 * A shape that keeps every line is refused by name: it gives up nothing, and
 * the answer for that case is `keepall` (which plans no operation at all).
 * `keephead` is not in the vocabulary and is never accepted.
 *
 * Every refusal below is one perturbation of a plan that otherwise validates, so
 * a check that stopped reading the bytes would let it through.
 */

const body = "alpha line\nbeta line\ngamma line\n";
const bytes = encode(body);

const config: RacoonsConfig = {
  thresholds: { capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1 },
  freshZone: { maxNodes: null, maxBytes: null }, sealMode: "append",
  validationFailureLimit: 2,
  // The entry lane mints at the floor, never the ask's bar; these fixtures are
  // small bodies, so the floor is explicit and below every body under test.
  floorBytes: 8,
  protocol: { barBytes: 8, minCutFreedBytes: 4096 },
};

function result(): ToolResultNode {
  return {
    kind: "tool-result", id: "result-1", turnOrdinal: 1, stepOrdinal: 3,
    bytes, sha256: sha256Sync(bytes), byteLength: bytes.length, callId: "call-1",
    embeddedRecords: [], evidence: {
      kind: "read", target: { key: "src/app.ts", label: "src/app.ts" },
      source: { nodeId: "result-1", sha256: sha256Sync(bytes), byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: "src/app.ts", displayPath: "src/app.ts", title: null,
        lineCount: 3, byteLength: bytes.length, outcome: "hit" }],
    },
  };
}

const callBytes = encode("read src/app.ts");
function snapshotOf(): SessionSnapshot {
  return { sessionId: "session", revision: "revision-1", currentTurnOrdinal: 1,
    completedThroughTurnOrdinal: 0, currentStepOrdinal: 3,
    nodes: [{ kind: "message", id: "assistant-1", role: "assistant",
      toolCallIds: ["call-1"], turnOrdinal: 1, stepOrdinal: 0, bytes: callBytes,
      sha256: sha256Sync(callBytes), byteLength: callBytes.length }],
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [], };
}

function landedUnitId(node = result()): string {
  const unit = new UnitTracker({ sessionId: "session", barBytes: 0 }).unitsFor(node)[0];
  if (unit === undefined) throw new Error("Fixture landed node yields no unit");
  return unit.id;
}

type EntryInput = Extract<ValidationInput["input"], { readonly kind: "entry" }>;

function entryEvent(answer: EntryAnswer, node = result()): EntryInput {
  return { kind: "entry", eventId: "entry-1", result: node, answer,
    stamp: { unitId: landedUnitId(node), answeredInRound: 0 } };
}

function entryValue(
  plan: RulePlan, answer: EntryAnswer, input?: EntryInput, cfg: RacoonsConfig = config,
): ValidationInput {
  return { input: input ?? entryEvent(answer),
    snapshot: snapshotOf(), capabilities: { mutateResult: true, rewriteHistory: false,
      atRest: true, liveTokens: false, log: true, appendRecords: true,
      rehydrateOnResume: false },
    config: cfg, plans: [plan], sealedEpisodeIds: [], nowMs: 10 };
}

const lineEnd = (index: number): number => splitLineOffsets(bytes)[index - 1]?.endByteExclusive ?? -1;

/** The landed whole-result unit of any fixture node. */
function unitIdOf(node: ToolResultNode): string {
  const unit = new UnitTracker({ sessionId: "session", barBytes: 0 }).unitsFor(node)[0];
  if (unit === undefined) throw new Error("Fixture landed node yields no unit");
  return unit.id;
}

/** The real planner's plan for one answer: the guard is tested against what the engine hands it. */
function shapeFor(answer: EntryAnswer): Extract<EntryShapePlan, { action: "shape" }> {
  return shapeForNode(answer, result(), snapshotOf());
}

/** The same plan over an arbitrary landed node and snapshot. */
function shapeForNode(
  answer: EntryAnswer, node: ToolResultNode, snapshot: SessionSnapshot,
): Extract<EntryShapePlan, { action: "shape" }> {
  const plan = planEntryShape({ unitId: unitIdOf(node), nodeId: node.id,
    originalBytes: node.bytes, answer }, snapshot);
  if (plan.action !== "shape") throw new Error(`Fixture answer must plan a shape, got ${plan.action}`);
  return plan;
}

function shapeOpOf(plan: RulePlan): ShapeOp {
  const op = plan.operations[0];
  if (op?.kind !== "shape") throw new Error("fixture plan must carry a shape op");
  return op;
}

function replaceOp(plan: RulePlan, op: ShapeOp): RulePlan {
  return { ...plan, operations: [op] };
}

function replaceRemovalRanges(plan: RulePlan, ranges: readonly { startByte: number; endByteExclusive: number }[]): RulePlan {
  const removal = plan.removals[0];
  const source = removal?.sources[0];
  if (removal === undefined || source === undefined) throw new Error("fixture plan must carry a removal");
  return { ...plan, removals: [{ ...removal, sources: [{ ...source, ranges }] }] };
}

const FORGETALL: EntryAnswer = { action: "forgetall", summary: "a stale build log" };
const KEEPLINE2: EntryAnswer = { action: "keeplines", ranges: [{ from: 2, to: 2 }],
  summary: "stale run notes" };
const FORGETLINE2: EntryAnswer = { action: "forgetlines", ranges: [{ from: 2, to: 2 }],
  summary: "stale run notes" };

/** The guard's own plan-level checks, over one hand-corrupted plan. */
function planCodes(value: ValidationInput): readonly ValidationCode[] {
  const c = fixtureContext(value);
  const issues: { code: ValidationCode }[] = [];
  checkInput(value, (code, detail, nodeId = null) => issues.push({ code, detail, nodeId } as never));
  checkOperations(c, value.plans);
  return [...issues.map(issue => issue.code), ...c.issues.map(issue => issue.code)];
}

async function outputCodes(answer: EntryAnswer, corrupt: (candidate: Candidate) => Candidate) {
  const value = entryValue(shapeFor(answer).plan, answer);
  const c = fixtureContext(value);
  const candidate = corrupt(await buildCandidate(c));
  checkOutput(c, candidate);
  return c.issues.map(issue => issue.code);
}

function options(rules: readonly Rule[] = []): EngineOptions {
  return { sessionId: "session", capabilities: { mutateResult: true, rewriteHistory: false,
    atRest: true, liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
  config, rules, clock: { nowMs: () => 10 },
  meter: { estimate: (content: Uint8Array) => content.length,
    reconcile: () => { throw new Error("unused"); }, latest: () => null } as never,
  ledger: { prepare: async () => { throw new Error("unused"); },
    append: async () => { throw new Error("unused"); },
    events: async function* (): AsyncIterable<never> {},
    recall: async () => { throw new Error("unused"); }, close: async () => undefined },
  port: { snapshot: async () => snapshotOf(), apply: async () => ({ status: "unknown" }),
    lookupReceipt: async () => ({ status: "unknown" }) } };
}

// --- the valid path -----------------------------------------------------

test("the planner's plans are admitted, keepall plans nothing, and the op names the landed unit", () => {
  for (const answer of [FORGETALL, KEEPLINE2, FORGETLINE2]) {
    assert.deepEqual(planCodes(entryValue(shapeFor(answer).plan, answer)), [],
      `the valid ${answer.action} plan is admitted under entry-shape`);
  }
  // A keepall gives up nothing, so it plans no operation and the guard is never
  // asked about it.
  assert.deepEqual(planApplication(options(),
    entryEvent({ action: "keepall" }), snapshotOf(), [], [], 10), []);
  // The unit id the planner writes is the landed unit's own (claim c).
  const expected = new UnitTracker({ sessionId: "session", barBytes: 0 }).unitsFor(result())[0]?.id;
  assert.ok(expected !== undefined);
  assert.equal(shapeOpOf(shapeFor(KEEPLINE2).plan).unitId, expected);
});

test("the mirror holds at the guard: the forgetlines plan IS the keeplines complement plan", () => {
  // ADR-0026 §4, enforced from the guard's side. Dropping line 2 must produce
  // the same accepted plan as keeping lines 1 and 3, byte for byte, and both
  // must re-render the same turn — so the guard sees one arithmetic, not two.
  // Each arm's own meaning is pinned absolutely first: an equality alone would
  // survive a planner that flipped both polarities together.
  const dropped = shapeFor(FORGETLINE2);
  assert.deepEqual(dropped.keptLineRanges,
    [{ startLine: 1, endLineInclusive: 1 }, { startLine: 3, endLineInclusive: 3 }],
    "the named line is the one dropped");
  const named = shapeFor(KEEPLINE2);
  assert.deepEqual(named.keptLineRanges, [{ startLine: 2, endLineInclusive: 2 }],
    "keeplines keeps the named line");
  const keptComplement = shapeFor({ action: "keeplines",
    ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }], summary: "stale run notes" });
  assert.deepEqual(shapeOpOf(dropped.plan).keptRanges, shapeOpOf(keptComplement.plan).keptRanges);
  assert.deepEqual(dropped.replacementBytes, keptComplement.replacementBytes);
  assert.equal(dropped.recallId, keptComplement.recallId);
  assert.deepEqual(planCodes(entryValue(dropped.plan, FORGETLINE2)), []);
});

// --- (a), (b), (b′), complement exactness, (d): one perturbation per row ---

/**
 * Every plan-level refusal this lane owns, one row per perturbation. Each row
 * starts from a plan that validates and breaks exactly one claim, so a check
 * that stopped reading the bytes would let the row through. `expect: null`
 * means the row must be admitted — the seed proof that keeps the file honest.
 */
const PLAN_ROWS: readonly {
  name: string;
  seed: EntryAnswer;
  answer: EntryAnswer;
  break: (plan: RulePlan) => RulePlan;
  expect: ValidationCode | null;
}[] = [
  {
    // (a) the original body is the landed body.
    name: "original bytes are not the landed body",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceOp(plan, { ...shapeOpOf(plan),
      originalBytes: encode("someone else's bytes\n") }),
    expect: "source-hash-mismatch",
  },
  {
    // (b) a kept range that ends inside a line is not a whole-line span.
    name: "a kept range that ends inside a line",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceOp(plan, { ...shapeOpOf(plan),
      keptRanges: [{ startByte: lineEnd(1), endByteExclusive: lineEnd(2) - 1 }] }),
    expect: "invalid-line-span",
  },
  {
    name: "a kept range that starts mid-line",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceOp(plan, { ...shapeOpOf(plan),
      keptRanges: [{ startByte: lineEnd(1) + 1, endByteExclusive: lineEnd(2) }] }),
    expect: "invalid-line-span",
  },
  {
    name: "a kept range reaching past the landed body",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceOp(plan, { ...shapeOpOf(plan),
      keptRanges: [{ startByte: 0, endByteExclusive: bytes.length + 1 }] }),
    expect: "invalid-line-span",
  },
  {
    // Giving up nothing: a shape that keeps every line is not a shape.
    name: "a shape plan that keeps every line",
    seed: FORGETALL,
    answer: FORGETALL,
    break: plan => {
      const op = shapeOpOf(plan);
      return replaceOp(plan, { ...op,
        keptRanges: [{ startByte: 0, endByteExclusive: bytes.length }],
        replacementBytes: new Uint8Array([...bytes, ...op.replacementBytes]) });
    },
    expect: "invalid-line-span",
  },
  {
    // The honest complement must validate, or the next row proves nothing.
    name: "the honest complement (admitted)",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceRemovalRanges(plan,
      [{ startByte: 0, endByteExclusive: lineEnd(1) },
        { startByte: lineEnd(2), endByteExclusive: bytes.length }]),
    expect: null,
  },
  {
    name: "a complement with one byte left unclaimed",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => replaceRemovalRanges(plan,
      [{ startByte: 0, endByteExclusive: lineEnd(1) },
        { startByte: lineEnd(2), endByteExclusive: bytes.length - 1 }]),
    expect: "unaccounted-removal",
  },
  {
    // (d) a marker owns its line: the live R-3 defect (ISSUE-063). A marker
    // spliced with no terminator put the recall id onto the next kept line and
    // 9 of 10 shaped turns stopped parsing. The renderer now terminates every
    // marker block; a plan that claims the glued body anyway must be refused
    // here, so a mis-render cannot land as if it were the plan it was approved
    // under.
    name: "a marker glued onto the kept line",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => {
      const op = shapeOpOf(plan);
      assert.deepEqual(planCodes(entryValue(plan, KEEPLINE2)), [],
        "the honest plan must validate, or the perturbation proves nothing");
      const shaped = new TextDecoder().decode(op.replacementBytes);
      const glued = encode(shaped.replace(/\n(?=beta line\n)/u, ""));
      assert.notEqual(glued.length, op.replacementBytes.length,
        "the fixture must actually remove a marker terminator");
      assert.ok(new TextDecoder().decode(glued).split("\n")
        .some(line => line.startsWith("[racoons]") && line.includes("beta line")),
      "the perturbed body must carry a marker sharing a line with kept bytes");
      return replaceOp(plan, { ...op, replacementBytes: glued });
    },
    expect: "invalid-generated-record",
  },
  {
    // The plan's own turn bytes are honest; this one carries a marker built with
    // a false dropped-byte count, so the re-derivation disagrees with the claim.
    name: "a marker whose dropped-bytes slot is wrong",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: plan => {
      const shape = shapeFor(KEEPLINE2);
      const forged = encode(shapeMarker({
        keptLines: [{ startLine: 2, endLineInclusive: 2 }], totalLines: 3,
        droppedBytes: 1, recallId: shape.recallId,
      }));
      return replaceOp(plan, { ...shapeOpOf(plan), replacementBytes: forged });
    },
    expect: "invalid-generated-record",
  },
  {
    // (b′) The attempt-2 hazard ADR-0026 §4 records: a complement computed
    // somewhere and then trusted. Here the answer names line 2 as the drop, but
    // the plan keeps line 1 and drops lines 2–3 — its own kept ranges still
    // tile, so only the named-range check can see the disagreement.
    name: "forgetlines kept ranges that are not the named ranges' complement",
    seed: FORGETLINE2,
    answer: FORGETLINE2,
    break: plan => replaceRemovalRanges(
      replaceOp(plan, { ...shapeOpOf(plan),
        keptRanges: [{ startByte: 0, endByteExclusive: lineEnd(1) }] }),
      [{ startByte: lineEnd(1), endByteExclusive: bytes.length }]),
    expect: "unaccounted-removal",
  },
  {
    // The answer, not the plan, is the claim on this class: the named span is
    // checked against the body's own line offsets, so a span the body does not
    // hold is refused by name even when the plan's kept ranges happen to tile.
    name: "a forgetlines answer naming a line past the landed body",
    seed: FORGETLINE2,
    answer: { action: "forgetlines", ranges: [{ from: 3, to: 9 }], summary: "past the end" },
    break: plan => plan,
    expect: "invalid-line-span",
  },
  {
    // (b′) The keepall arm: a shape op claims the answer gave something up, and
    // `keepall` gave up nothing, so the pairing is a forged plan.
    name: "a keepall answer riding a shape plan",
    seed: KEEPLINE2,
    answer: { action: "keepall" },
    break: plan => plan,
    expect: "invalid-plan",
  },
  {
    // (b′) The keeplines arm: the plan is internally valid for a different keep
    // set, so only the comparison with the answer's named ranges sees the forgery.
    name: "a keeplines plan that keeps a range the answer never named",
    seed: KEEPLINE2,
    answer: KEEPLINE2,
    break: () => shapeFor({ action: "keeplines", ranges: [{ from: 1, to: 1 }],
      summary: "the first line stays" }).plan,
    expect: "unaccounted-removal",
  },
  {
    // (b′) The forgetall arm: the answer keeps no line, so a plan that keeps one
    // is a forged plan even when its own removal and turn tile.
    name: "a forgetall answer riding a plan that keeps a line",
    seed: FORGETALL,
    answer: FORGETALL,
    break: () => shapeFor(KEEPLINE2).plan,
    expect: "unaccounted-removal",
  },
];

test("plan-level shape refusals — one code per perturbation row", () => {
  for (const row of PLAN_ROWS) {
    const codes = planCodes(entryValue(row.break(shapeFor(row.seed).plan), row.answer));
    if (row.expect === null) {
      assert.deepEqual(codes, [], `row: ${row.name} — must be admitted`);
      continue;
    }
    assert.ok(codes.includes(row.expect),
      `row: ${row.name} — expected ${row.expect}, got ${JSON.stringify(codes)}`);
  }
});

// --- (a′) the entry subject: a one-row answer's newest, a batch row's own --

/** Three landed rows in transcript order, and the snapshot that holds them. */
function batchFixture(): {
  readonly snapshot: SessionSnapshot;
  readonly rows: readonly ToolResultNode[];
} {
  const rows: readonly ToolResultNode[] = [result(),
    { ...result(), id: "result-2", callId: "call-2", stepOrdinal: 4 },
    { ...result(), id: "result-3", callId: "call-3", turnOrdinal: 2, stepOrdinal: 1 }];
  const base = snapshotOf();
  return { rows, snapshot: { ...base, currentTurnOrdinal: 2, currentStepOrdinal: 4,
    nodes: [...base.nodes, ...rows] } };
}

/**
 * A multi-row batch keys each answered row under `<answer-node>#<row>`
 * (`batchRowOrderOf`). Row 2 may be older than row 3 and still shape: the one
 * answer named row 2, not the snapshot's tail. Every row lands its own write.
 */
test("a three-row batch's rows each shape their own result, older rows included", () => {
  const { snapshot, rows } = batchFixture();
  for (const [position, node] of rows.entries()) {
    const plan = shapeForNode(FORGETALL, node, snapshot).plan;
    const value: ValidationInput = {
      input: { kind: "entry", eventId: `entry-batch#${String(position + 1)}`,
        result: node, answer: FORGETALL,
        stamp: { unitId: unitIdOf(node), answeredInRound: 0 } },
      snapshot,
      capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
        liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
      config, plans: [plan], sealedEpisodeIds: [], nowMs: 10,
    };
    const c = fixtureContext(value);
    checkSources(c, [plan]);
    assert.deepEqual(c.issues, [], `row ${String(position + 1)} must shape its own result`);
  }
});

test("a batch row naming a result before its position is refused as older history", () => {
  // Row 3 cannot name the first result: the answer covered three rows, so the
  // first result is history this row's answer never saw.
  const { snapshot, rows } = batchFixture();
  const first = rows[0];
  if (first === undefined) throw new Error("batch fixture must hold a first row");
  const plan = shapeForNode(FORGETALL, first, snapshot).plan;
  const value: ValidationInput = {
    input: { kind: "entry", eventId: "entry-batch#3", result: first,
      answer: FORGETALL, stamp: { unitId: unitIdOf(first), answeredInRound: 0 } },
    snapshot,
    capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
      liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
    config, plans: [plan], sealedEpisodeIds: [], nowMs: 10,
  };
  const c = fixtureContext(value);
  checkSources(c, [plan]);
  const refusal = c.issues.find(issue => issue.code === "outside-fresh-zone");
  assert.ok(refusal !== undefined, `row 3 naming result 1 must be refused: ${JSON.stringify(c.issues)}`);
  assert.equal(refusal.nodeId, first.id, "the refusal names the early result");
});

test("an entry may shape only the newest landed result; an older node is refused by name", () => {
  const older = result();
  const newer: ToolResultNode = { ...result(), id: "result-2", callId: "call-2", stepOrdinal: 4 };
  const answer = FORGETALL;
  const plan = shapeFor(answer).plan;
  const base = snapshotOf();
  const snapshot: SessionSnapshot = { ...base, currentStepOrdinal: 4,
    nodes: [...base.nodes, older, newer] };
  const value: ValidationInput = {
    input: { kind: "entry", eventId: "entry-1", result: older, answer,
      stamp: { unitId: landedUnitId(older), answeredInRound: 0 } },
    snapshot,
    capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
      liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
    config, plans: [plan], sealedEpisodeIds: [], nowMs: 10,
  };
  const c = fixtureContext(value);
  checkSources(c, [plan]);
  const refusal = c.issues.find(issue => issue.code === "outside-fresh-zone");
  assert.ok(refusal !== undefined, `the older result must be refused: ${JSON.stringify(c.issues)}`);
  assert.equal(refusal.nodeId, older.id, "the refusal names the older result");
  assert.ok(refusal.detail.includes(newer.id), "the refusal names the newest landed result");
});

// --- (c′) the eligibility floor, never the ask's bar -----------------------

test("the entry lane mints at floorBytes: between the bar and the floor makes no unit", () => {
  const answer = KEEPLINE2;
  const plan = shapeFor(answer).plan;
  // The fixture bar is the smaller number here: the result is above it and
  // below the floor, so the old barBytes:0 mint admitted it and this floor does not.
  const belowFloor: RacoonsConfig = { ...config, floorBytes: bytes.length + 1,
    protocol: { ...config.protocol, barBytes: 1 } };
  const codes = planCodes(entryValue(plan, answer, undefined, belowFloor));
  assert.ok(codes.includes("unknown-unit"),
    `a below-floor result mints no unit: ${JSON.stringify(codes)}`);
  // The bar belongs to the ask, not the shape gate: above the floor and below
  // the bar the landed unit still exists and the honest plan is admitted.
  const aboveFloorBelowBar: RacoonsConfig = { ...config, floorBytes: 8,
    protocol: { ...config.protocol, barBytes: bytes.length + 1 } };
  assert.deepEqual(planCodes(entryValue(plan, answer, undefined, aboveFloorBelowBar)), []);
});

// --- the rule-id exemption ---------------------------------------------

test("entry-shape is exempt from wrong-rule; a shape under any other rule is refused", () => {
  const plan = shapeFor(KEEPLINE2).plan;
  assert.deepEqual(planCodes(entryValue(plan, KEEPLINE2)), []);
  for (const ruleId of ["verdict", "cap", "seal", "shape"] as const) {
    assert.ok(planCodes(entryValue({ ...plan, ruleId }, KEEPLINE2)).includes("wrong-rule"),
      `a shape under ${ruleId} must be wrong-rule`);
  }
});

// --- keephead never accepted -------------------------------------------

test("keephead is not an answer class: a plan claiming one is refused before any byte check", () => {
  // A hand-built event may hold any text. The planner reads no `.lines` member
  // and folds no unknown arm into a keep, so nothing reaches the guard as a
  // shape plan; the refusal is the parser's `unknown-action` on the real path.
  const raw = { action: "keephead", lines: 1 } as unknown as EntryAnswer;
  const plan = planEntryShape({ unitId: landedUnitId(), nodeId: "result-1",
    originalBytes: bytes, answer: raw }, snapshotOf());
  assert.notEqual(plan.action, "shape", "keephead must never plan a shape");
  assert.equal(plan.action, "refuse");
  if (plan.action !== "refuse") return;
  assert.equal(plan.code, "unknown-answer");
});

// --- the output side ---------------------------------------------------

test("output refusals — a wrong marker count and a turn byte that differs from the plan", async () => {
  // The builder's own expectation is perturbed to three markers where the plan
  // has two gaps. The output lane joins the candidate's generated ranges and
  // compares, so a count the plan never implies is refused on the real path.
  const plan = shapeFor(KEEPLINE2).plan;
  const c = fixtureContext(entryValue(plan, KEEPLINE2));
  const candidate = await buildCandidate(c);
  const archive = candidate.archives[0];
  const replacement = candidate.replacements[0];
  assert.ok(archive !== undefined && replacement !== undefined);
  assert.equal(replacement.generatedRanges.length, 2);
  const marker = encode(shapeMarker({
    keptLines: [{ startLine: 2, endLineInclusive: 2 }], totalLines: 3,
    droppedBytes: lineEnd(1) + (bytes.length - lineEnd(2)), recallId: archive.recall.id,
  }));
  const wrongCount = new Uint8Array(marker.length * 3);
  for (let index = 0; index < 3; index += 1) wrongCount.set(marker, index * marker.length);
  const forged: Candidate = { ...candidate,
    expectedGenerated: new Map([[replacement.source.nodeId, wrongCount]]) };
  checkOutput(c, forged);
  assert.ok(c.issues.some(issue => issue.code === "invalid-generated-record"),
    `row: a wrong marker count — got ${JSON.stringify(c.issues)}`);
  // A candidate whose turn bytes differ from the plan is refused too.
  const codes = await outputCodes(KEEPLINE2, corrupt => {
    const turn = corrupt.replacements[0];
    if (turn === undefined) throw new Error("fixture replacement missing");
    const longer = new Uint8Array([...turn.bytes, 0x20]);
    return { ...corrupt, replacements: [{ ...turn, bytes: longer, sha256: sha256Sync(longer) }] };
  });
  assert.ok(codes.includes("invalid-generated-record") || codes.includes("retained-bytes-changed"),
    `row: a turn byte that differs from the plan — got ${JSON.stringify(codes)}`);
});

// --- (e) the archive covers the ORIGINAL bytes -------------------------

test("archive refusals — the shaped turn, or a dropped range set that is not the complement", async () => {
  const plan = shapeFor(KEEPLINE2).plan;
  const c = fixtureContext(entryValue(plan, KEEPLINE2));
  const candidate = await buildCandidate(c);
  const archive = candidate.archives[0], replacement = candidate.replacements[0];
  assert.ok(archive !== undefined && replacement !== undefined);
  const part = archive.recall.parts[0];
  assert.ok(part !== undefined);
  const rows: readonly { name: string; forged: Candidate }[] = [
    {
      // A bank holding the LANDED (shaped) bytes cannot restore what left.
      name: "an archive over the shaped turn instead of the original",
      forged: { ...candidate, archives: [{ ...archive,
        recall: { ...archive.recall, parts: [{ ...part, bytes: replacement.bytes.slice() }] } }] },
    },
    {
      name: "an archive whose dropped ranges are not the complement",
      forged: { ...candidate, archives: [{ ...archive,
        recall: { ...archive.recall, parts: [{ ...part, removedRanges: [
          { range: { startByte: 0, endByteExclusive: bytes.length }, sha256: sha256Sync(bytes) }] }] } }] },
    },
  ];
  for (const row of rows) {
    const issues: { code: string }[] = [];
    checkShapeReplacement(c, plan, shapeOpOf(plan), plan.removals[0] ?? {
      id: "missing", title: "", sources: [] }, replacement, row.forged,
    (code, detail) => issues.push({ code, detail } as never));
    assert.ok(issues.some(issue => issue.code === "recall-manifest-mismatch"),
      `row: ${row.name} — got ${JSON.stringify(issues)}`);
  }
});

// --- the durable archive row -------------------------------------------

test("the entry-shape archive is durably the verdict row the CHECK admits", async () => {
  // LEADER RULING: no schema widening. `operationKind` stays "verdict" (the
  // CHECK's list has no shape kind) and the row's own `ruleId` names the lane.
  const plan = shapeFor(KEEPLINE2).plan;
  const c = fixtureContext(entryValue(plan, KEEPLINE2));
  const finalized = finalizeCandidate(c, await buildCandidate(c));
  if (!finalized.ok) assert.fail(JSON.stringify(finalized.issues));
  assert.equal(finalized.application.archives.length, 1);
  assert.deepEqual(finalized.application.archives.map(archive => [archive.ruleId, archive.operationKind]),
    [["entry-shape", "verdict"]]);
  const root = mkdtempSync(join(tmpdir(), "racoons-shape-row-"));
  const databasePath = join(root, "ledger.sqlite");
  try {
    const ledger = await SqliteLedger.open({ databasePath, blobStore: new MemoryBlobStore(),
      clock: { nowMs: () => 100 } });
    try { await ledger.prepare(structuredClone(finalized.application)); }
    finally { await ledger.close(); }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`SELECT rule_id AS ruleId, operation_kind AS kind
        FROM application_removals`).all().map(row => ({ ruleId: row["ruleId"], kind: row["kind"] })),
      [{ ruleId: "entry-shape", kind: "verdict" }]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
