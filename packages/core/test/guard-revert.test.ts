import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { applicationBytes, revertBytes } from "../src/guard/application.js";
import { buildCandidate } from "../src/guard/candidate.js";
import type { Candidate } from "../src/guard/candidate.js";
import { finalizeCandidate } from "../src/guard/finalize.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidatedApplication, ValidationCode, ValidationInput } from "../src/guard/types.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import type { RulePlan } from "../src/rules/types.js";
import type {
  CapabilityFlags, MessageNode, SessionSnapshot, ToolResultNode,
} from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { planVerdictApplication } from "../src/verdicts/plan.js";
import { VerdictTracker } from "../src/verdicts/tracker.js";
import { context, ledger, pruneEvent, result, seal } from "./guard-fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionId = "session";
const barBytes = 8;

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

function toolResult(index: number, text: string, step: number): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id: `result-${index}`, kind: "tool-result", turnOrdinal: 1, stepOrdinal: step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${index}`,
    evidence: {
      kind: "read", target: null,
      source: { nodeId: `result-${index}`, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: `src/file-${index}.ts`, displayPath: `src/file-${index}.ts`,
        title: null, lineCount: 1, byteLength: bytes.length, outcome: "hit" }],
    },
    embeddedRecords: [],
  };
}

function assistant(count: number): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: Array.from({ length: count }, (_, index) => `call-${index}`),
  };
}

/**
 * Transcript order: assistant (index 0), three above-bar results (1..3) and one
 * tiny node (4). Unit `u` therefore sits at node index `u + 1`. The tiny node
 * survives every cut, so a plan always has a non-empty survivor list — the
 * matrix the ledger's revert payload accepts.
 */
function transcript(options: {
  readonly watermark?: number;
  readonly cacheUnknown?: boolean;
  readonly bodies?: readonly string[];
} = {}): SessionSnapshot {
  const bodies = options.bodies ?? ["result 0 body\n", "result 1 body\n", "result 2 body\n"];
  const results = bodies.map((body, index) => toolResult(index, body, index + 1));
  return {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 4, nodes: [assistant(10), ...results, toolResult(9, "tiny\n", 4)],
    cache: options.cacheUnknown ? { kind: "unknown" }
      : { kind: "warm", watermarkNodeIndex: options.watermark ?? 0 }, retentionEvidence: [],
  };
}

function capabilities(revertHistory = true): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
    log: true, appendRecords: true, rehydrateOnResume: false, revertHistory,
  };
}

interface Scene {
  readonly snapshot: SessionSnapshot;
  readonly units: readonly ProcessingUnit[];
  readonly plans: readonly RulePlan[];
  readonly input: ValidationInput;
}

function guard(): Guard {
  return new Guard({ ledger: ledger(), initialState: { consecutiveValidationFailures: 0, disabled: false } });
}

async function accept(value: ValidationInput): Promise<ValidatedApplication> {
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  return validation.application;
}

/**
 * One settled window over every above-bar unit: kept except `forgotten` (unit
 * indices). The plan is the real planner's output, so the guard meets exactly
 * what the engine hands it.
 */
function scene(options: {
  readonly forgotten?: readonly number[];
  readonly watermark?: number;
  readonly cacheUnknown?: boolean;
  readonly bodies?: readonly string[];
  readonly label?: string | null;
  readonly revertHistory?: boolean;
} = {}): Scene {
  const forgotten = options.forgotten ?? [];
  const label = options.label === undefined ? "auth retry" : options.label;
  const snapshot = transcript({ ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
    ...(options.cacheUnknown === true ? { cacheUnknown: true } : {}),
    ...(options.bodies === undefined ? {} : { bodies: options.bodies }) });
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  assert.equal(units.length, 3, "fixture must produce exactly three units");
  const tracker = new VerdictTracker({ units, round: 1 });
  for (const [index, unit] of units.entries()) {
    const forget = forgotten.includes(index);
    tracker.judge(forget
      ? { unitId: unit.id, action: "forgetall", summary: label, answeredInRound: 1 }
      : { unitId: unit.id, action: "keepall", answeredInRound: 1 });
  }
  const state = tracker.state();
  const plan = planVerdictApplication({ state, baseRevision: snapshot.revision, nodes: snapshot.nodes });
  const input: ValidationInput = {
    input: pruneEvent(state.verdicts, 1),
    snapshot, capabilities: capabilities(options.revertHistory ?? true), config,
    plans: plan === null ? [] : [plan], sealedEpisodeIds: [], nowMs: 10,
  };
  return { snapshot, units, plans: input.plans, input };
}

function codes(issues: readonly { readonly code: ValidationCode }[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

function candidateOf(scene: Scene): Promise<Candidate> {
  return buildCandidate(context(scene.input));
}

/**
 * Finalizes a forged candidate exactly as `Guard#validate` does after rendering.
 * The unmutated candidate must pass first, or a refusal would prove nothing.
 */
async function finalized(scene: Scene, mutate: (candidate: Candidate) => Candidate) {
  const candidate = await candidateOf(scene);
  const clean = finalizeCandidate(context(scene.input), candidate);
  assert.equal(clean.ok, true, `the unmutated candidate must pass: ${JSON.stringify(
    clean.ok ? [] : clean.issues)}`);
  return finalizeCandidate(context(scene.input), mutate(candidate));
}

type RevertPlanOf = NonNullable<Candidate["revert"]>["plan"];
function reforge(candidate: Candidate, mutate: (plan: RevertPlanOf) => RevertPlanOf): Candidate {
  const revert = candidate.revert;
  if (revert === null) throw new Error("Forge needs a revert candidate");
  return { ...candidate, revert: { ...revert, plan: mutate(revert.plan) } };
}

/** One form of a forged revert plan; the guard must refuse it with `code`. */
interface ForgedRow {
  readonly name: string;
  readonly code: ValidationCode;
  readonly mutate: (candidate: Candidate) => Candidate;
  /** The scene the row forges; defaults to the shared two-forgotten scene. */
  readonly scene?: Scene;
  /** A clause the refusal text must carry, so the row is not another claim's. */
  readonly detail?: string;
  /** A precondition proving the row's premise holds before the forgery. */
  readonly armed?: (scene: Scene) => void;
}

async function assertForged(rows: readonly ForgedRow[], fallback: Scene): Promise<void> {
  for (const row of rows) {
    const scene = row.scene ?? fallback;
    row.armed?.(scene);
    const result = await finalized(scene, row.mutate);
    assert.equal(result.ok, false, `row: ${row.name} — the forgery was accepted`);
    if (result.ok) continue;
    assert.ok(codes(result.issues).includes(row.code),
      `row: ${row.name} — expected ${row.code}, got ${JSON.stringify(result.issues)}`);
    if (row.detail !== undefined) {
      assert.ok(result.issues.some(issue => issue.detail.includes(row.detail!)),
        `row: ${row.name} — ${JSON.stringify(result.issues.map(issue => issue.detail))}`);
    }
  }
}

// --- the cut fence ----------------------------------------------------------

/** One watermark against one cut. A null `cutIndex` means the cut must apply. */
interface FenceRow {
  readonly name: string;
  readonly forgotten: readonly number[];
  readonly watermark?: number;
  readonly cacheUnknown?: boolean;
  /** The cut an accepted plan must carry; `null` when the row must refuse. */
  readonly cutIndex: number | null;
}

const FENCE_ROWS: readonly FenceRow[] = [
  // Unit 1 is node index 2. Watermark 2 lets the cut land exactly at the fence.
  { name: "a cut at the watermark", forgotten: [1], watermark: 2, cutIndex: 2 },
  // The same plan one node deeper into the cached prefix: the cut is refused.
  { name: "the same cut below the watermark", forgotten: [1], watermark: 3, cutIndex: null },
  // Even the deepest unit's cut is below a watermark past every unit.
  { name: "a watermark past every unit", forgotten: [2], watermark: 4, cutIndex: null },
  // The host supplied no watermark: there is nothing for the cut to violate,
  // and the bank makes the removal restorable (ADR-0012). The warm fence above
  // is the separate guard.
  { name: "no watermark at all", forgotten: [1], cacheUnknown: true, cutIndex: 2 },
];

test("a cut is refused exactly when it falls below the declared watermark", async () => {
  for (const row of FENCE_ROWS) {
    const validation = await guard().validate(scene({ forgotten: row.forgotten,
      ...(row.watermark === undefined ? {} : { watermark: row.watermark }),
      ...(row.cacheUnknown === true ? { cacheUnknown: true } : {}) }).input);
    if (row.cutIndex === null) {
      assert.equal(validation.ok, false, `row: ${row.name} — the cut must be refused`);
      if (validation.ok) continue;
      assert.deepEqual(codes(validation.issues), ["cut-below-watermark"],
        `row: ${row.name} — only the fence speaks`);
      assert.equal("application" in validation, false, `row: ${row.name} — a refused batch ships nothing`);
      continue;
    }
    if (!validation.ok) assert.fail(`row: ${row.name} — ${JSON.stringify(validation.issues)}`);
    assert.equal(validation.application.revert?.cutIndex, row.cutIndex,
      `row: ${row.name} — the applied cut`);
  }
  // The unknown-cache row must still bank the forgotten unit for recall.
  const banked = await accept(scene({ forgotten: [1], cacheUnknown: true }).input);
  assert.equal(banked.archives.length, 1,
    "row: no watermark at all — the forgotten unit is banked for recall");
});

// --- receipts land at their anchors ----------------------------------------

test("receipts land at their anchors and name their archive, and an approved plan is sealed whole", async () => {
  // Forgetting units 1 and 2 cuts at node 2. No survivor sits between them, so
  // both receipts anchor at the prefix tail (result-0) and keep their order.
  const withForget = scene({ forgotten: [1, 2] });
  const application = await accept(withForget.input);
  const revert = application.revert;
  assert.ok(revert !== undefined, "a forget application must carry its revert plan");
  assert.equal(revert.cutIndex, 2, "row: two forgotten — cut index");
  assert.deepEqual(revert.survivors, ["result-9"], "row: two forgotten — survivors");
  assert.deepEqual(revert.appends.map(append => append.afterNodeId), ["result-0", "result-0"],
    "row: two forgotten — both receipts anchor at the prefix tail");
  assert.deepEqual(revert.unitIds, [withForget.units[1]?.id, withForget.units[2]?.id],
    "row: two forgotten — forgotten units in transcript order");

  // Each append names a rendered record the application ships, and that record
  // names the same archive the ledger will store — the removal id is the unit id.
  const records = new Map(application.appendRecords.map(record => [record.recordId, record]));
  const archives = new Map(application.archives.map(archive => [archive.removalId, archive]));
  for (const [index, append] of revert.appends.entries()) {
    const row = `append ${index}`;
    const unit = withForget.units[index + 1];
    assert.ok(unit !== undefined);
    const record = records.get(append.noteId);
    const archive = archives.get(unit.id);
    assert.ok(record !== undefined, `row: ${row} — names a shipped record`);
    assert.ok(archive !== undefined, `row: ${row} — the application archives the forgotten unit's removal`);
    const text = decoder.decode(record.bytes);
    assert.match(text,
      /^\[not retained\] src\/file-[12]\.ts — about: auth retry · necromancy recall:sha256:[0-9a-f]{64}$/u,
      `row: ${row} — the receipt line`);
    assert.ok(text.includes(unit.path ?? ""), `row: ${row} — the receipt names its own unit's path`);
    assert.ok(text.includes(archive.recall.id), `row: ${row} — the receipt names its archive's recall id`);
  }
  assert.equal(application.appendRecords.length, 2, "row: two forgotten — no other generated record ships");
  assert.equal(application.replacements.length, 0,
    "row: two forgotten — a verdict removal is never rewritten in place");

  // The per-node fallback shape: own node, own receipt, in transcript order.
  assert.deepEqual(revert.perNode.map(entry => entry.nodeId), ["result-1", "result-2"],
    "row: per-node — one replacement per forgotten node, in transcript order");
  assert.deepEqual(revert.perNode.map(entry => entry.noteId),
    revert.appends.map(append => append.noteId),
    "row: per-node — each per-node replacement carries that node's own receipt");
  const shipped = new Set(application.appendRecords.map(record => record.recordId));
  for (const entry of revert.perNode) {
    assert.ok(shipped.has(entry.noteId), `row: per-node — ${entry.nodeId} names a shipped record`);
  }
  // The plan digest covers the per-node shape, so a host substitution is caught.
  const { planSha256, ...approved } = revert;
  assert.equal(planSha256, sha256Sync(revertBytes(approved)),
    "row: per-node — the plan digest covers the approved plan");
  assert.notEqual(planSha256, sha256Sync(revertBytes({ ...approved,
    perNode: approved.perNode.slice(1) })),
  "row: per-node — dropping an entry changes the digest");
});

test("a verdict application is mode revert at the at-rest phase with a sealed full plan", async () => {
  const withForget = scene({ forgotten: [1] });
  const application = await accept(withForget.input);
  assert.equal(application.phase, "at-rest", "a verdict event has no entry phase");
  assert.equal(application.mode, "revert", "row: mode");
  const revert = application.revert;
  assert.ok(revert !== undefined);
  // The ledger hashes the payload verbatim, so the guard ships the whole type.
  assert.deepEqual(Object.keys(revert).sort(),
    ["appends", "baseRevision", "cost", "cutIndex", "perNode", "planSha256", "survivors", "unitIds"],
    "row: one forgotten — the revert payload carries every field and no other");
  assert.deepEqual(revert.unitIds, [withForget.units[1]?.id], "row: one forgotten — unit ids");
  assert.equal(revert.baseRevision, withForget.snapshot.revision, "row: one forgotten — base revision");
  const { planSha256, ...approved } = revert;
  assert.equal(planSha256, sha256Sync(revertBytes(approved)),
    "row: one forgotten — the plan digest covers the approved plan");
  // The salvage arithmetic is the §2 identity on the plan's own cut.
  assert.equal(revert.cost.netFreedBytes,
    revert.cost.freedBytes - revert.cost.keptBytes - revert.cost.receiptBytes,
    "row: one forgotten — the net identity holds");
  assert.equal(revert.cost.cutIndex, revert.cutIndex, "row: one forgotten — the cost names the plan's cut");
  assert.equal(revert.cost.freedBytes, withForget.units[1]?.byteLength,
    "row: one forgotten — freed bytes are the forgotten unit's own span");
  // The application digest covers the plan: a changed cut changes the application.
  const { applicationSha256, ...body } = application;
  assert.equal(applicationSha256, sha256Sync(applicationBytes(body)),
    "row: one forgotten — the application digest covers the body");
  assert.notEqual(applicationSha256,
    sha256Sync(applicationBytes({ ...body, revert: { ...revert, cutIndex: revert.cutIndex + 1 } })),
  "row: one forgotten — a changed cut changes the application digest");
});

test("a verdict removal archives a recall that restores the exact original bytes", async () => {
  // Bytes chosen to fail any normalising or text-re-encoding restore path.
  const body = "\uFEFFé\r\nresult 1 body\r\nend";
  const withForget = scene({ forgotten: [1], bodies: ["result 0 body\n", body, "result 2 body\n"] });
  const application = await accept(withForget.input);
  assert.equal(application.archives.length, 1, "row: exact bytes — one archive per forgotten unit");
  const archive = application.archives[0];
  assert.ok(archive !== undefined);
  assert.equal(archive.operationKind, "verdict", "row: exact bytes — op kind");
  assert.equal(archive.ruleId, "verdict", "row: exact bytes — rule id");
  assert.equal(archive.removalId, withForget.units[1]?.id, "row: exact bytes — removal id is the unit id");
  const original = withForget.snapshot.nodes.find(node => node.id === "result-1");
  assert.ok(original !== undefined);
  assert.deepEqual(archive.recall.parts[0]?.bytes, original.bytes,
    "row: exact bytes — the payload is the exact body");

  // Round-trip through the restore primitive that exists: the SQLite ledger.
  const storeLedger = await SqliteLedger.open({ databasePath: ":memory:",
    blobStore: new MemoryBlobStore(), clock: { nowMs: () => 100 } });
  try {
    // The ledger reproduces the guard's application digest from the same envelope.
    await storeLedger.prepare(structuredClone(application));
    const restored = await storeLedger.recall(archive.recall.id);
    assert.deepEqual(restored.parts[0]?.bytes, original.bytes,
      "row: exact bytes — restored bytes are byte-identical");
    assert.deepEqual(restored, structuredClone(archive.recall),
      "row: exact bytes — the whole manifest round-trips");
  } finally { await storeLedger.close(); }
});

// --- checks-revert refusals -------------------------------------------------

/**
 * Every way a forged revert plan is refused. The first block forges a plan the
 * planner would never emit; the second forges the anchors and the cut's own
 * accounting on a scene where unit 1 survives between units 0 and 2.
 */
function forgedRows(): readonly ForgedRow[] {
  const moved = scene({ forgotten: [0, 2] });
  return [
    { name: "a per-node replacement is dropped", code: "invalid-plan",
      detail: "one per-node replacement per forgotten node",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, perNode: plan.perNode.slice(1) })) },
    { name: "per-node replacements are reordered", code: "invalid-plan",
      detail: "Per-node replacements differ from the forgotten nodes",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, perNode: [...plan.perNode].reverse() })) },
    { name: "a per-node replacement names a survivor's node", code: "invalid-plan",
      detail: "Per-node replacements differ from the forgotten nodes",
      mutate: candidate => reforge(candidate, plan => ({ ...plan,
        perNode: plan.perNode.map((entry, index) =>
          index === 0 ? { ...entry, nodeId: "result-9" } : entry) })) },
    { name: "a per-node replacement carries another node's receipt", code: "invalid-note",
      detail: "does not carry its own node's receipt",
      mutate: candidate => reforge(candidate, plan => ({ ...plan,
        perNode: plan.perNode.map((entry, index) => index === 0
          ? { ...entry, noteId: plan.perNode[1]?.noteId ?? entry.noteId } : entry) })) },
    { name: "survivors differ from the cut suffix", code: "invalid-plan",
      detail: "Survivors differ from the nodes after the cut",
      mutate: candidate => reforge(candidate, plan => ({
        ...plan, survivors: [...plan.survivors, "result-0"] })) },
    { name: "the cut lands on a kept node", code: "invalid-plan",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, cutIndex: plan.cutIndex + 1 })) },
    { name: "a receipt append is dropped", code: "invalid-note",
      detail: "exactly one receipt per forgotten node",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, appends: plan.appends.slice(1) })) },
    { name: "freed bytes go negative", code: "invalid-plan",
      detail: "must not carry a negative freedBytes",
      mutate: candidate => reforge(candidate, plan => ({
        ...plan, cost: { ...plan.cost, freedBytes: -1 } })) },
    { name: "the net identity breaks", code: "invalid-plan",
      detail: "differs from the byte arithmetic for its cut",
      mutate: candidate => reforge(candidate, plan => ({
        ...plan, cost: { ...plan.cost, netFreedBytes: plan.cost.netFreedBytes + 1 } })) },
    { name: "the cost describes another cut", code: "invalid-plan",
      detail: "must describe the plan",
      mutate: candidate => reforge(candidate, plan => ({
        ...plan, cost: { ...plan.cost, cutIndex: plan.cutIndex + 1 } })) },
    { name: "approved units are missing", code: "invalid-plan",
      detail: "Approved unit ids differ from the forgotten units",
      mutate: candidate => ({ ...candidate, revert: candidate.revert === null ? null
        : { ...candidate.revert, unitIds: candidate.revert.unitIds.slice(1) } }) },
    { name: "the plan is stale", code: "stale-revision",
      detail: "differs from snapshot revision-1",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, baseRevision: "revision-0" })) },
    { name: "the application carries no revert plan at all", code: "invalid-plan",
      detail: "carries no revert plan",
      mutate: candidate => ({ ...candidate, revert: null }) },
    // Unit 1 survives between units 0 and 2, so the second receipt must anchor
    // at result-1. Pointing it at the last survivor keeps the append count
    // right and still puts a receipt in the wrong place.
    { name: "a receipt anchored away from its survivor", code: "adjacency-changed", scene: moved,
      detail: "Receipt anchors differ from the survivors",
      mutate: candidate => reforge(candidate, plan => ({ ...plan,
        appends: plan.appends.map((append, index) =>
          index === 1 ? { ...append, afterNodeId: "result-9" } : append) })),
      armed: settled => assert.equal(settled.plans[0]?.operations.length, 2,
        "row: moved anchor — two verdict removals, so two receipts to reanchor") },
    // Cutting at unit 2's own node drops unit 0's receipt: a declared removal
    // the cut would not apply.
    { name: "a removal left before the cut", code: "unaccounted-removal", scene: moved,
      detail: "lies before the cut and would not be applied",
      mutate: candidate => reforge(candidate, plan => ({ ...plan, cutIndex: plan.cutIndex + 2,
        // Keep the forged plan internally consistent so only the missing removal fires.
        survivors: plan.survivors.filter(id => id !== "result-1") })),
      armed: settled => assert.deepEqual(
        settled.plans[0]?.removals.map(removal => removal.sources[0]?.source.nodeId),
        ["result-0", "result-2"],
        "row: before the cut — units 0 and 2 are result-0 and result-2, with unit 1 between") },
  ];
}

test("checks-revert refuses a forged revert plan, one claim at a time", async () => {
  await assertForged(forgedRows(), scene({ forgotten: [1, 2] }));
});

// --- phase and capability edges --------------------------------------------

/** The fixtures the capability rows start from: a real plan, one seam withheld. */
function replaceSeal(input: ValidationInput): ValidationInput {
  const plan = input.plans[0];
  const op = plan?.operations[0];
  if (plan === undefined || op?.kind !== "seal") throw new Error("Fixture needs a seal plan");
  const node = result();
  return { ...input, plans: [{ ...plan,
    removals: [{ id: "body", title: "Body", sources: [{ source: { nodeId: node.id,
      sha256: node.sha256, byteLength: node.byteLength },
    ranges: [{ startByte: 0, endByteExclusive: node.byteLength }] }] }],
    operations: [{ ...op, mode: "replace", removalId: "body" }] }] };
}

interface CapabilityRow {
  readonly name: string;
  readonly seam: string;
  readonly build: () => ValidationInput;
}

const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  {
    name: "a verdict removal without the declared revert seam",
    seam: "A verdict removal requires the programmatic revert seam",
    build: () => scene({ forgotten: [1], revertHistory: false }).input,
  },
  {
    name: "a replace-mode seal, which no declared seam admits",
    seam: "A replace-mode seal requires the programmatic revert seam",
    build: () => replaceSeal(seal()),
  },
];

test("a removal whose seam the host did not declare is refused before rendering", async () => {
  for (const row of CAPABILITY_ROWS) {
    const refused = await guard().validate(row.build());
    assert.equal(refused.ok, false, `row: ${row.name} — refused`);
    if (refused.ok) continue;
    assert.deepEqual(codes(refused.issues), ["unsupported-capability"],
      `row: ${row.name} — only the capability speaks`);
    const refusal = refused.issues.find(issue => issue.code === "unsupported-capability");
    assert.equal(refusal?.detail, row.seam, `row: ${row.name} — the refusal names the missing seam`);
    assert.equal("application" in refused, false, `row: ${row.name} — a refused batch ships nothing`);
  }
});
