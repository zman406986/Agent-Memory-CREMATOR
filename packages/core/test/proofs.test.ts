import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RacoonsConfig } from "../src/config.js";
import { checkProofs } from "../src/guard/checks-proofs.js";
import { Guard } from "../src/guard/guard.js";
import { context, ledger } from "./guard-fixtures.js";
import type { ValidationCode, ValidationInput } from "../src/guard/types.js";
import { isPlan } from "../src/guard/checks-shape.js";
import { StaleReadRule } from "../src/rules/stale.js";
import { SupersededReadRule } from "../src/rules/superseded.js";
import type { Rule, RuleContext, RulePlan } from "../src/rules/types.js";
import type {
       CapabilityFlags, MessageNode, PathEvidence, ToolEvidence, ToolResultNode,
       TranscriptNode,
} from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { ruleContext } from "./rules-fixtures.js";

/**
 * The two proof rules (PRD §6.6; ADR-0018; ISSUE-045 chunk C3).
 *
 * Each rule claims one byte fact and emits the one shape the guard re-derives:
 * one unit, one `proof` op, one `proof-receipt` note over the unit's own span,
 * under a rule id equal to the proof kind. These tests pin three things:
 *
 *   1. the shape — the plan a rule emits is the plan C4's guard accepts;
 *   2. the proof — write-after-read burns, write-before-read does not; an exact
 *      later re-read makes the earlier copy redundant, different bytes do not;
 *   3. the floor — protected bytes are never burnt, an unknown observation
 *      proves nothing, and absent the revert seam nothing is planned.
 */

const encoder = new TextEncoder();
const sessionId = "session-c3";
const barBytes = 8;
const READ_PATH = "src/app.ts";
const READ_BYTES = "export const answer = 42;\n";

function config(): RacoonsConfig {
  return { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, barBytes } };
}

function path(pathKey: string, outcome: PathEvidence["outcome"] = "hit"): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 1,
    byteLength: READ_BYTES.length, outcome };
}

function node(
  id: string,
  stepOrdinal: number,
  evidence: Omit<ToolEvidence, "source">,
  text = READ_BYTES,
): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id, kind: "tool-result", turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: {
      ...evidence,
      source: { nodeId: id, sha256, byteLength: bytes.length },
    },
  };
}

function read(id: string, step: number, options: {
  readonly pathKey?: string;
  readonly targetKey?: string | null;
  readonly text?: string;
  readonly outcome?: PathEvidence["outcome"];
} = {}): ToolResultNode {
  const pathKey = options.pathKey ?? READ_PATH;
  const targetKey = options.targetKey === undefined ? pathKey : options.targetKey;
  return node(id, step, {
    kind: "read",
    target: targetKey === null ? null : { key: targetKey, label: targetKey },
    paths: [path(pathKey, options.outcome ?? "hit")],
    sourceRecallId: null,
  }, options.text ?? READ_BYTES);
}

function write(id: string, step: number, options: {
  readonly pathKey?: string;
  readonly targetKey?: string | null;
  readonly failed?: boolean;
} = {}): ToolResultNode {
  const pathKey = options.pathKey ?? READ_PATH;
  const targetKey = options.targetKey === undefined ? pathKey : options.targetKey;
  return node(id, step, {
    kind: "write",
    target: targetKey === null ? null : { key: targetKey, label: targetKey },
    // A write proves a path changed and nothing else: its outcome is unknown (E0).
    paths: [path(pathKey, "unknown")],
    sourceRecallId: null,
    ...(options.failed === true ? { failed: true } : {}),
  }, "written bytes\n");
}

function other(id: string, step: number, pathKey = READ_PATH): ToolResultNode {
  return node(id, step, { kind: "other", target: null, paths: [path(pathKey, "unknown")],
    sourceRecallId: null }, "some other output\n");
}

function search(id: string, step: number, pathKey = READ_PATH): ToolResultNode {
  return node(id, step, { kind: "search",
    target: { key: "needle", label: "needle" }, paths: [path(pathKey, "hit")],
    sourceRecallId: null }, READ_BYTES);
}

/** The assistant turn declaring the call every result answers, or pairing fails. */
function assistant(nodes: readonly ToolResultNode[]): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: nodes.map(entry => entry.callId),
  };
}

function capabilities(revertHistory: boolean): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true,
    liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false,
    revertHistory,
  };
}

/** The same flags with `revertHistory` absent, never `false`: no seam declared. */
function withoutSeam(): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true,
    liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false,
  };
}

/** A rule context over one transcript, with the assistant turn as node 0. */
function contextOf(nodes: readonly ToolResultNode[], overrides: {
  readonly capabilities?: CapabilityFlags;
  readonly input?: RuleContext["input"];
  readonly cache?: RuleContext["snapshot"]["cache"];
  readonly freshZone?: RuleContext["freshZone"];
  readonly config?: RacoonsConfig;
} = {}): RuleContext {
  const transcript: TranscriptNode[] = [assistant(nodes), ...nodes];
  return ruleContext({
    config: overrides.config ?? config(),
    capabilities: overrides.capabilities ?? capabilities(true),
    input: overrides.input ?? { kind: "at-rest", eventId: "at-rest-1", reason: "step" },
    snapshot: {
      // Unit identity covers the session, so the fixture's session must be the
      // one the tracker below is built with or every id would differ.
      sessionId,
      nodes: transcript,
      cache: overrides.cache ?? { kind: "warm", watermarkNodeIndex: 0 },
    },
    freshZone: overrides.freshZone ?? { startNodeIndex: 0, endNodeIndexExclusive: transcript.length },
  });
}

function unitOf(context: RuleContext, nodeId: string): ProcessingUnit {
  const unit = new UnitTracker({ sessionId, barBytes }).units(context.snapshot)
    .find(candidate => candidate.nodeId === nodeId);
  if (unit === undefined) throw new Error(`no unit for ${nodeId}`);
  return unit;
}

/** The plan's only removal, or a failure: every proof plan here has exactly one. */
function only<const T>(items: readonly T[], what: string): T {
  assert.equal(items.length, 1, `expected exactly one ${what}`);
  const item = items[0];
  if (item === undefined) throw new Error(`missing ${what}`);
  return item;
}

function codes(issues: readonly { readonly code: ValidationCode }[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

function validationOf(ruleCtx: RuleContext, plan: RulePlan): ValidationInput {
  return {
    input: ruleCtx.input, snapshot: ruleCtx.snapshot, capabilities: ruleCtx.capabilities,
    config: ruleCtx.config, plans: [plan], sealedEpisodeIds: [], nowMs: 10,
  };
}

// --- the shape: what a rule emits is what the guard accepts ------------------

test("a read followed by a write to its path plans exactly the read's unit as a stale proof", () => {
  const readNode = read("result-1", 1);
  const plan = new StaleReadRule().plan(contextOf([readNode, write("result-2", 2)]));
  assert.ok(plan !== null);
  assert.equal(plan.ruleId, "stale-read");
  assert.equal(plan.baseRevision, "revision-1");
  const removal = only(plan.removals, "removal");
  const op = only(plan.operations, "operation");
  const note = only(plan.notes, "note");
  assert.deepEqual(op, { kind: "proof", proofKind: "stale-read", removalId: removal.id,
    unitId: removal.id, noteId: note.id });
  assert.deepEqual(removal.sources, [{
    source: { nodeId: readNode.id, sha256: readNode.sha256, byteLength: readNode.bytes.length },
    ranges: [{ startByte: 0, endByteExclusive: readNode.bytes.length }],
  }]);
  // The whole node went, so the receipt names no range: the recall id alone
  // identifies it. There is no descriptor slot at all (ADR-0018).
  assert.deepEqual(note, { id: "proof:" + removal.id, kind: "proof-receipt",
    proofKind: "stale-read", removalId: removal.id, unitId: removal.id,
    path: READ_PATH, ranges: [] });
  assert.equal(isPlan(plan), true, "the emitted plan passes the guard's closed shape check");
});

test("an exact later re-read of one target burns only the earlier copy", () => {
  const first = read("result-1", 1);
  const second = read("result-2", 2);
  const context = contextOf([first, second]);
  const plan = new SupersededReadRule().plan(context);
  assert.ok(plan !== null);
  assert.equal(plan.ruleId, "superseded-read");
  const removal = only(plan.removals, "removal");
  const note = only(plan.notes, "note");
  assert.equal(removal.id, unitOf(context, "result-1").id, "the earlier copy is the one burnt");
  assert.deepEqual(removal.sources[0]?.ranges, [{ startByte: 0,
    endByteExclusive: first.bytes.length }]);
  assert.equal(note.kind === "proof-receipt" ? note.proofKind : null, "superseded-read");
  assert.equal(note.kind === "proof-receipt" ? note.path : null, READ_PATH);
  assert.equal(isPlan(plan), true);
});

/** One fixture per rule, both reaching the guard as the same claim. */
const GUARD_ROWS: readonly { readonly name: string; readonly rule: Rule;
  readonly nodes: readonly ToolResultNode[] }[] = [
  { name: "stale-read", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), write("result-2", 2)] },
  { name: "superseded-read", rule: new SupersededReadRule(),
    nodes: [read("result-1", 1), read("result-2", 2)] },
];

/**
 * Both rules reach the guard as the same claim, and the guard accepts what the
 * rule emitted: `checkProofs` re-derives the byte fact from the snapshot alone.
 */
test("both rules' plans pass the guard's proof check and apply as one revert", async () => {
  for (const row of GUARD_ROWS) {
    const ruleCtx = contextOf(row.nodes);
    const plan = row.rule.plan(ruleCtx);
    assert.ok(plan !== null, `row: ${row.name} — expected a plan`);
    const checkContext = context(validationOf(ruleCtx, plan));
    checkProofs(checkContext, [plan]);
    assert.deepEqual(codes(checkContext.issues), [],
      `row: ${row.name} — the guard re-derived it with issues: ${JSON.stringify(checkContext.issues)}`);
  }
  // The same stale-read plan goes through the real gate: one revert, one archive
  // naming the proof, one receipt line with path + recall id and no descriptor.
  const staleCtx = contextOf([read("result-1", 1), write("result-2", 2)]);
  const stalePlan = new StaleReadRule().plan(staleCtx);
  if (stalePlan === null) assert.fail("expected a stale plan");
  const unit = unitOf(staleCtx, "result-1");
  const validation = await new Guard({ ledger: ledger(),
    initialState: { consecutiveValidationFailures: 0, disabled: false } })
    .validate(validationOf(staleCtx, stalePlan));
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.mode, "revert");
  assert.deepEqual(validation.application.revert?.unitIds, [unit.id]);
  assert.equal(validation.application.archives[0]?.operationKind, "proof");
  assert.equal(validation.application.archives[0]?.ruleId, "stale-read");
  const receipt = only(validation.application.appendRecords, "appended receipt");
  const text = new TextDecoder().decode(receipt.bytes);
  assert.match(text, /\[not retained\] src\/app\.ts/u);
  assert.match(text, /necromancy recall:sha256:[0-9a-f]{64}/u);
});

// --- the floor: every clause that must keep a read alive --------------------

/**
 * Each negative clause, one row per claim. A row is a transcript the rule must
 * refuse to prove; the `control` is the same rule on the smallest transcript it
 * DOES prove, so a rule that returned `null` unconditionally fails its own row.
 */
const NEGATIVE_ROWS: readonly { readonly name: string; readonly rule: Rule;
  readonly nodes: readonly ToolResultNode[]; readonly control: readonly ToolResultNode[];
  readonly config?: RacoonsConfig; readonly controlConfig?: RacoonsConfig }[] = [
  // A write before the read is already reflected in the read's bytes.
  { name: "a write before the read is not proof", rule: new StaleReadRule(),
    nodes: [write("result-1", 1), read("result-2", 2)],
    control: [read("result-1", 1), write("result-2", 2)] },
  // The clock is transcript order and the path is part of the fact.
  { name: "a write to a different path proves nothing about this read", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), write("result-2", 2, { pathKey: "src/other.ts" })],
    control: [read("result-1", 1), write("result-2", 2)] },
  // Only a `write` proves a path changed (E0): another kind of result does not.
  { name: "an unclassified result is not a write", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), other("result-2", 2)],
    control: [read("result-1", 1), write("result-2", 2)] },
  { name: "a search result is not a write", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), search("result-2", 2)],
    control: [read("result-1", 1), write("result-2", 2)] },
  // A failed write changed nothing: the host's own failure flag is the fact
  // (ISSUE-328), so the read's bytes are still what the file holds.
  { name: "a failed write is not proof the path changed", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), write("result-2", 2, { failed: true })],
    control: [read("result-1", 1), write("result-2", 2)] },
  // A read with no observed path has nothing to prove stale.
  { name: "a read with no observed path can never be proven stale", rule: new StaleReadRule(),
    nodes: [node("result-1", 1, { kind: "read", target: null, paths: [], sourceRecallId: null }),
      write("result-2", 2)],
    control: [read("result-1", 1), write("result-2", 2)] },
  // The bar is the tracker's, not an invention of the rule: below it no unit
  // exists, so there is nothing to prove.
  { name: "below the configured bar there is no unit to prove", rule: new StaleReadRule(),
    nodes: [read("result-1", 1), write("result-2", 2)],
    config: { ...config(), protocol: { ...config().protocol, barBytes: 1024 } },
    control: [read("result-1", 1), write("result-2", 2)],
    // The control runs at the unraised bar: the null above is the number, not the rule.
    controlConfig: config() },
  // A miss read returned an error, not the file's bytes: a later write cannot
  // make it a stale copy (ISSUE-339; the invalidation lane's hit-only rule).
  { name: "a miss read holds no file bytes a write could stale", rule: new StaleReadRule(),
    nodes: [read("result-1", 1, { outcome: "miss" }), write("result-2", 2)],
    control: [read("result-1", 1), write("result-2", 2)] },
  // A changed world is not a redundant copy: different bytes prove the file moved.
  { name: "a same-path re-read with different bytes leaves the first read alone",
    rule: new SupersededReadRule(),
    nodes: [read("result-1", 1), read("result-2", 2, { text: "export const answer = 43;\n" })],
    control: [read("result-1", 1), read("result-2", 2)] },
  // The target key is the grouping, not the path display: different keys are different sources.
  { name: "the same bytes behind a different target key are not a superseded read",
    rule: new SupersededReadRule(),
    nodes: [
      read("result-1", 1, { targetKey: "src/a.ts", pathKey: "src/a.ts" }),
      read("result-2", 2, { targetKey: "src/b.ts", pathKey: "src/b.ts" }),
    ],
    control: [read("result-1", 1), read("result-2", 2)] },
];

test("negative clauses — one row per claim, each with a control that does prove", () => {
  for (const row of NEGATIVE_ROWS) {
    const configs = row.config === undefined ? {} : { config: row.config };
    const controlConfigs = row.controlConfig === undefined ? configs
      : { config: row.controlConfig };
    assert.equal(row.rule.plan(contextOf(row.nodes, configs)), null, `row: ${row.name}`);
    assert.ok(row.rule.plan(contextOf(row.control, controlConfigs)) !== null,
      `row: ${row.name} — the control must prove, or the null above is the fixture`);
  }
});

test("a superseded witness a sibling plan removes is not cited (ISSUE-331)", () => {
  // Default-order reachable: A has a non-empty target but EMPTY path
  // observations, so the stale rule cannot burn it; B shares the target and
  // bytes and carries the hit path; W writes that path after B. Stale runs
  // first (createDefaultRules) and burns B, so B is reserved when superseded
  // runs — citing it would emit a batch the ISSUE-174 guard refuses wholesale.
  const a = node("result-1", 1, { kind: "read",
    target: { key: READ_PATH, label: READ_PATH }, paths: [], sourceRecallId: null });
  const b = read("result-2", 2);
  const w = write("result-3", 3);
  const ruleCtx = contextOf([a, b, w]);
  const stalePlan = new StaleReadRule().plan(ruleCtx);
  assert.ok(stalePlan !== null, "the stale rule burns B");
  assert.deepEqual(stalePlan.removals.flatMap(removal => removal.sources.map(s => s.source.nodeId)),
    ["result-2"], "the stale burn's subject is B");
  // Mirror planApplication's reservation: prior plans' removal source nodeIds.
  const reservedNodeIds = stalePlan.removals.flatMap(removal => removal.sources.map(s => s.source.nodeId));
  const supersededPlan = new SupersededReadRule().plan({ ...ruleCtx, reservedNodeIds });
  assert.equal(supersededPlan, null,
    "the witness the sibling plan burns is not cited: the unsafe burn is cancelled");
  // The batch the planner emits is accepted, not refused wholesale.
  const checkContext = context(validationOf(ruleCtx, stalePlan));
  checkProofs(checkContext, [stalePlan]);
  assert.deepEqual(codes(checkContext.issues), [],
    `the emitted batch passes the guard: ${JSON.stringify(checkContext.issues)}`);
  // Control: with no sibling burn the same witness stands and A is burnt.
  const control = new SupersededReadRule().plan(contextOf([a, b]));
  assert.ok(control !== null, "without the sibling removal the witness is live");
  assert.deepEqual(control.removals.flatMap(removal => removal.sources.map(s => s.source.nodeId)),
    ["result-1"], "the control burns A citing the live B");
});

test("a write known only by its display spelling still proves the read stale (ISSUE-339)", () => {
  // The read keys the path one way and displays it another; the write carries
  // only the display spelling (no target). The writes lane expands displayPath
  // (units/writes.ts), so the stale rule and the guard must match it too.
  const readNode = node("result-1", 1, { kind: "read",
    target: { key: READ_PATH, label: READ_PATH },
    paths: [{ pathKey: READ_PATH, displayPath: "app.ts", title: null, lineCount: 1,
      byteLength: READ_BYTES.length, outcome: "hit" }],
    sourceRecallId: null });
  const writeNode = node("result-2", 2, { kind: "write", target: null,
    paths: [{ pathKey: "app.ts", displayPath: "app.ts", title: null, lineCount: 1,
      byteLength: READ_BYTES.length, outcome: "unknown" }],
    sourceRecallId: null }, "written bytes\n");
  const ruleCtx = contextOf([readNode, writeNode]);
  const plan = new StaleReadRule().plan(ruleCtx);
  assert.ok(plan !== null, "the display-spelling write proves the read stale");
  assert.deepEqual(plan.removals.flatMap(removal => removal.sources.map(s => s.source.nodeId)),
    ["result-1"], "the burn's subject is the read");
  // The guard re-derives the same spelling intersection and accepts the plan.
  const checkContext = context(validationOf(ruleCtx, plan));
  checkProofs(checkContext, [plan]);
  assert.deepEqual(codes(checkContext.issues), [],
    `the guard accepts the display-spelling proof: ${JSON.stringify(checkContext.issues)}`);
  // Control: a write whose every spelling differs is still no proof.
  const otherWrite = node("result-2", 2, { kind: "write", target: null,
    paths: [{ pathKey: "src/other.ts", displayPath: "other.ts", title: null, lineCount: 1,
      byteLength: READ_BYTES.length, outcome: "unknown" }],
    sourceRecallId: null }, "written bytes\n");
  assert.equal(new StaleReadRule().plan(contextOf([readNode, otherWrite])), null,
    "a write naming no spelling of the read's path proves nothing");
});

test("a proof plans nothing without the revert seam: the one flag ADR-0018 reads", () => {
  for (const row of GUARD_ROWS) {
    const flags: readonly { readonly name: string; readonly capabilities: CapabilityFlags }[] = [
      { name: "revertHistory false", capabilities: capabilities(false) },
      { name: "revertHistory absent", capabilities: withoutSeam() },
    ];
    for (const flag of flags) {
      const context = contextOf(row.nodes, { capabilities: flag.capabilities });
      assert.equal(row.rule.plan(context), null, `row: ${row.name} with ${flag.name}`);
    }
    // The same transcript with the seam declared does plan, so the null above
    // is the flag and not the fixture.
    assert.ok(row.rule.plan(contextOf(row.nodes, { capabilities: capabilities(true) })) !== null,
      `row: ${row.name} — the seam-declared control must plan`);
  }
});
