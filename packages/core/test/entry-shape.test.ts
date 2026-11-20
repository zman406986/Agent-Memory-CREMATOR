import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { buildCandidate } from "../src/guard/candidate.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkSources } from "../src/guard/checks-sources.js";
import { finalizeCandidate } from "../src/guard/finalize.js";
import type { ValidationInput } from "../src/guard/types.js";
import { planEntryShape, planApplication } from '../src/engine/planning.js';
import type { EntryShapePlan, LandedEntryShapeInput } from "../src/engine/planning.js";
import type { RulePlan, ShapeOp, Rule, RuleContext } from '../src/rules/types.js';
import type { ToolResultNode } from "../src/types/transcript.js";
import type { EntryAnswer } from "../src/verdicts/entry-wire.js";
import { parseEntryAnswer } from "../src/verdicts/entry-wire.js";
import { sha256Sync } from "../src/util/hash.js";
import { splitLineOffsets } from "../src/util/lines.js";
import { UnitTracker } from "../src/units/tracker.js";
import { context, encode } from "./guard-fixtures.js";
import type { EngineOptions } from "../src/engine/types.js";

/**
 * Entry shaping against the LANDED node (ISSUE-058 chunk P3b; ADR-0022
 * §11–§13).
 *
 * The protocol under test: a tool result lands first, in its own turn; a
 * separate turn asks; the answer applies by rewind-and-append. So the planner
 * takes the landed unit's id IN, the original bytes the port holds, and the
 * three-arm answer — and it answers with one of three things:
 *
 * - `keepall` plans nothing at all (the mount rewinds the ask exchange away);
 * - `shape` is one replacement turn: `keptLineRanges`, the same selection as
 *   byte ranges, the rendered `replacementBytes`, and the ORIGINAL body the
 *   archive covers (`bankOver`), so recall is byte-exact;
 * - `refuse` names a line the body cannot hold, or an answer that gives up
 *   nothing (fail-open: the result stays landed whole).
 *
 * The three pinned facts: the plan is the answer's own arithmetic over the
 * landed body (never a size rule's), the builder banks the original and lands
 * the shaped turn, and `keephead` exists nowhere in the vocabulary.
 */

const body = "alpha line\nbeta line\ngamma line\n";
const bytes = encode(body);
const fourLine = encode("one\ntwo\nthree\nfour\n");

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

/** The same node over a different body, for the multi-line fixtures. */
function nodeOf(bodyBytes: Uint8Array): ToolResultNode {
  return { ...result(), bytes: bodyBytes, sha256: sha256Sync(bodyBytes),
    byteLength: bodyBytes.length };
}

const config: RacoonsConfig = {
  thresholds: { capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1 },
  freshZone: { maxNodes: null, maxBytes: null }, sealMode: "append",
  validationFailureLimit: 2,
  protocol: { barBytes: 8, minCutFreedBytes: 4096 },
};

const callBytes = encode("read src/app.ts");
function snapshotOf() {
  return { sessionId: "session", revision: "revision-1", currentTurnOrdinal: 1,
    completedThroughTurnOrdinal: 0, currentStepOrdinal: 3,
    nodes: [{ kind: "message" as const, id: "assistant-1", role: "assistant" as const,
      toolCallIds: ["call-1"], turnOrdinal: 1, stepOrdinal: 0, bytes: callBytes,
      sha256: sha256Sync(callBytes), byteLength: callBytes.length }],
    cache: { kind: "warm" as const, watermarkNodeIndex: 0 }, retentionEvidence: [], };
}

/** The landed unit id, exactly what the mount stamps on the entry event. */
function landedUnitId(node = result()): string {
  const unit = new UnitTracker({ sessionId: "session", barBytes: 0 }).unitsFor(node)[0];
  if (unit === undefined) throw new Error("Fixture landed node yields no unit");
  return unit.id;
}

function landedInput(answer: EntryAnswer, node = result()): LandedEntryShapeInput {
  return { unitId: landedUnitId(node), nodeId: node.id, originalBytes: node.bytes, answer };
}

function planFor(answer: EntryAnswer, node = result()): EntryShapePlan {
  return planEntryShape(landedInput(answer, node), snapshotOf());
}

/** The same plan, or an assertion naming the arm that was expected. */
function shapePlan(answer: EntryAnswer, node = result()): Extract<EntryShapePlan, { action: "shape" }> {
  const plan = planFor(answer, node);
  if (plan.action !== "shape") assert.fail(`expected a shape, got ${plan.action}`);
  return plan;
}

function shapeOpOf(plan: Extract<EntryShapePlan, { action: "shape" }>): ShapeOp {
  const op = plan.plan.operations[0];
  if (op?.kind !== "shape") throw new Error("a shape plan carries one shape operation");
  return op;
}

const lineEnd = (index: number, bodyBytes = bytes): number =>
  splitLineOffsets(bodyBytes)[index - 1]?.endByteExclusive ?? -1;

// --- keepall: no op, no ranges, nothing banked ------------------------------

test("keepall plans no operation at all, by every route the ask can spell it", () => {
  // The arms the old pre-landing contract put here are gone: no replacement, no
  // ranges, no archive. A keep-all leaves no trace on the wire (ADR-0022 §11).
  const plan = planFor({ action: "keepall" });
  assert.deepEqual(plan, { action: "keepall" }, "row: the bare keepall answer");
  assert.equal("plan" in plan, false);
  assert.equal("replacementBytes" in plan, false);

  // A full-range keeplines noted None is the ask's keep-all form, not a refusal.
  assert.deepEqual(planFor({ action: "keeplines", ranges: [{ from: 1, to: 3 }],
    summary: "None" }), { action: "keepall" }, "row: a full-range keeplines noted None");

  // A multi-span keeplines noted None merges to the whole body and plans keep-all.
  assert.deepEqual(planFor({ action: "keeplines",
    ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }, { from: 3, to: 3 }], summary: "None" }),
  { action: "keepall" }, "row: a multi-span keeplines noted None covering the body");

  // The note is the taught spelling, not a condition: a full range keeps the
  // body whole whatever the model called it, and never becomes a both-ends plan.
  assert.deepEqual(planFor({ action: "keeplines", ranges: [{ from: 1, to: 3 }],
    summary: "keeps it all" }), { action: "keepall" },
  "row: a full-range keeplines with a different summary");
});

// --- forgetall: empty kept selection, marker-only turn ---------------------

test("forgetall keeps no line and lands a marker-only turn over the original body", () => {
  const plan = shapePlan({ action: "forgetall", summary: "a stale build log" });
  assert.deepEqual(plan.keptLineRanges, []);
  assert.deepEqual(plan.keptRanges, []);
  const op = shapeOpOf(plan);
  assert.deepEqual(op.keptRanges, []);
  // The removal is the whole original: every byte is banked.
  assert.deepEqual(plan.plan.removals[0]?.sources[0]?.ranges,
    [{ startByte: 0, endByteExclusive: bytes.length }]);
  // The turn is the empty-form marker and nothing else: one whole line,
  // terminator included (ISSUE-063).
  const turn = new TextDecoder().decode(plan.replacementBytes);
  assert.match(turn, /^\[racoons\] kept 0 of 3 lines · necromancy recall:sha256:[0-9a-f]{64}\n$/);
  assert.deepEqual(plan.replacementBytes, op.replacementBytes);
  // The archive body is the ORIGINAL, never the shaped turn.
  assert.deepEqual(plan.bankOver, bytes);
  assert.ok(turn.includes(plan.recallId), turn);

  // `forgetall` keeps nothing, so the empty-form marker states no byte count and
  // the whole original is what left. The turn's size is the marker's own size,
  // which is the arithmetic the run record reads back (`d(u) = b(u)`).
  assert.equal(turn.includes("bytes dropped"), false,
    "row: the empty form states no byte count");
  assert.equal(plan.keptRanges.length, 0, "row: the empty form keeps no range");

  // The op carries the landed node's own identity, hashed from its original
  // bytes — never a re-derived sha.
  assert.deepEqual(plan.plan.removals[0]?.sources[0]?.source,
    { nodeId: "result-1", sha256: sha256Sync(bytes), byteLength: bytes.length });
  assert.deepEqual(shapeOpOf(plan).originalBytes, bytes);
});

// --- keeplines: named whole lines, one marker per gap ----------------------

test("keeplines keeps exactly the named lines and marks every dropped gap", () => {
  const plan = shapePlan({ action: "keeplines", ranges: [{ from: 2, to: 2 }],
    summary: "stale run notes" });
  assert.deepEqual(plan.keptLineRanges, [{ startLine: 2, endLineInclusive: 2 }]);
  assert.deepEqual(plan.keptRanges, [{ startByte: lineEnd(1), endByteExclusive: lineEnd(2) }]);
  assert.deepEqual(plan.plan.removals[0]?.sources[0]?.ranges,
    [{ startByte: 0, endByteExclusive: lineEnd(1) },
      { startByte: lineEnd(2), endByteExclusive: bytes.length }]);
  // Two gaps, so the marker stands twice; the kept line appears exactly once.
  const turn = new TextDecoder().decode(plan.replacementBytes);
  const markers = turn.match(/\[racoons\] kept lines 2–2 of 3 · \d+ bytes dropped · necromancy recall:sha256:[0-9a-f]{64}/g);
  assert.equal(markers?.length, 2, turn);
  assert.equal(turn.split("beta line\n").length, 2, "the kept line lands exactly once");
  assert.deepEqual(plan.bankOver, bytes);

  // The marker's dropped-bytes slot is the true dropped byte count, not a
  // re-used number. The planner and the guard share `renderShapeTurn`, so a
  // renderer that miscounted would produce plans and re-renders that AGREE on
  // the wrong number and the guard could not see it. This pin reads the marker
  // back and compares it with the dropped byte total computed here,
  // independently.
  const kept = plan.keptRanges.reduce((sum, range) => sum + range.endByteExclusive - range.startByte, 0);
  const trueDropped = bytes.length - kept;
  const stated = [...turn.matchAll(/· (\d+) bytes dropped ·/gu)].map(match => Number(match[1]));
  assert.equal(stated.length, 2, "one marker per dropped gap");
  assert.deepEqual(stated, [trueDropped, trueDropped],
    `every marker must state the ${String(trueDropped)} bytes that actually left`);

  // Several kept spans each stay verbatim and each gap carries its own marker.
  const spans = shapePlan({ action: "keeplines",
    ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }], summary: "keep the edges" },
  nodeOf(fourLine));
  assert.deepEqual(spans.keptLineRanges,
    [{ startLine: 1, endLineInclusive: 1 }, { startLine: 3, endLineInclusive: 3 }],
    "row: two kept spans, both whole lines");
  assert.deepEqual(spans.keptRanges, [
    { startByte: 0, endByteExclusive: lineEnd(1, fourLine) },
    { startByte: lineEnd(2, fourLine), endByteExclusive: lineEnd(3, fourLine) },
  ], "row: two kept spans, as byte ranges");
  const spansTurn = new TextDecoder().decode(spans.replacementBytes);
  assert.equal(spansTurn.split("one\n").length, 2, "row: line 1 lands once");
  assert.equal(spansTurn.split("three\n").length, 2, "row: line 3 lands once");
  assert.equal(spansTurn.split("\ntwo\n").length, 1, "row: line 2 never lands");
  assert.equal((spansTurn.match(/\[racoons\] kept lines/g) ?? []).length, 2,
    "row: one marker per gap between the kept spans");
});

// --- forgetlines: the mirror partial class (ADR-0026) ---------------------

test("the mirror proof: forgetlines [[a,b]] plans the same turn as keeplines' complement", () => {
  // ADR-0026 §4–§5 on one fixture. Dropping line 2 is the same shape as keeping
  // lines 1 and 3: same kept line ranges, same kept byte ranges, same removal
  // tiling, same rendered bytes, same recall id. Only the answer's notation
  // differs, which is what makes the K-versus-F comparison single-variable.
  //
  // The ABSOLUTE halves come first on purpose: a planner that swapped the two
  // polarities would still satisfy the equality below (both arms would flip
  // together), so each arm's own meaning is pinned by its own answer.
  const keptNamed = shapePlan({ action: "keeplines", ranges: [{ from: 2, to: 2 }],
    summary: "same shape" });
  assert.deepEqual(keptNamed.keptLineRanges, [{ startLine: 2, endLineInclusive: 2 }],
    "keeplines keeps what its ranges name");
  const droppedNamed = shapePlan({ action: "forgetlines", ranges: [{ from: 2, to: 2 }],
    summary: "same shape" });
  // The NAMED line leaves; lines 1 and 3 stay, each in its own kept range.
  assert.deepEqual(droppedNamed.keptLineRanges,
    [{ startLine: 1, endLineInclusive: 1 }, { startLine: 3, endLineInclusive: 3 }],
    "forgetlines keeps the complement of what its ranges name");
  const droppedTurn = new TextDecoder().decode(droppedNamed.replacementBytes);
  assert.equal(droppedTurn.split("beta line\n").length, 1, "the named line never lands");
  assert.equal(droppedTurn.split("alpha line\n").length, 2, "the kept head lands once");
  assert.equal(droppedTurn.split("gamma line\n").length, 2, "the kept tail lands once");
  assert.equal((droppedTurn.match(/\[racoons\] kept lines/g) ?? []).length, 1, droppedTurn);

  const kept = shapePlan({ action: "keeplines",
    ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }], summary: "same shape" });
  assert.deepEqual(droppedNamed.keptLineRanges, kept.keptLineRanges);
  assert.deepEqual(droppedNamed.keptRanges, kept.keptRanges);
  assert.deepEqual(droppedNamed.plan.removals[0]?.sources[0]?.ranges,
    kept.plan.removals[0]?.sources[0]?.ranges);
  assert.deepEqual(droppedNamed.replacementBytes, kept.replacementBytes);
  assert.equal(droppedNamed.recallId, kept.recallId,
    "the same dropped spans must mint the same archive id");
  assert.deepEqual(droppedNamed.bankOver, kept.bankOver);

  // And the mirror on a two-gap case: dropping the head and the tail keeps the
  // middle, which is exactly the keeplines answer naming the middle.
  const four = nodeOf(fourLine);
  const dropEnds = planEntryShape(landedInput({ action: "forgetlines",
    ranges: [{ from: 1, to: 1 }, { from: 3, to: 4 }], summary: "drop the ends" }, four),
  snapshotOf());
  const keepMiddle = planEntryShape(landedInput({ action: "keeplines",
    ranges: [{ from: 2, to: 2 }], summary: "drop the ends" }, four), snapshotOf());
  if (dropEnds.action !== "shape" || keepMiddle.action !== "shape") assert.fail("fixtures shape");
  assert.deepEqual(dropEnds.keptLineRanges, keepMiddle.keptLineRanges);
  assert.deepEqual(dropEnds.replacementBytes, keepMiddle.replacementBytes);
  assert.equal(dropEnds.recallId, keepMiddle.recallId);

  // forgetlines renders one marker in each DROPPED (named) gap, not in the kept
  // lines. Four lines, naming 1 and 3 as the drops: two markers, and the kept
  // lines 2 and 4 land verbatim between them. The marker count is the named gap
  // count, so a renderer that marked the complement would show one marker.
  const namedGaps = shapePlan({ action: "forgetlines",
    ranges: [{ from: 1, to: 1 }, { from: 3, to: 3 }], summary: "drop the odds" }, four);
  const namedTurn = new TextDecoder().decode(namedGaps.replacementBytes);
  assert.equal((namedTurn.match(/\[racoons\] kept lines/g) ?? []).length, 2, namedTurn);
  assert.equal(namedTurn.split("one\n").length, 1, "the named line 1 never lands");
  assert.equal(namedTurn.split("three\n").length, 1, "the named line 3 never lands");
  assert.equal(namedTurn.split("two\n").length, 2, "the kept line 2 lands once");
  assert.equal(namedTurn.split("four\n").length, 2, "the kept line 4 lands once");
  // The removal is the two named spans, byte for byte.
  assert.deepEqual(namedGaps.plan.removals[0]?.sources[0]?.ranges, [
    { startByte: 0, endByteExclusive: lineEnd(1, fourLine) },
    { startByte: lineEnd(2, fourLine), endByteExclusive: lineEnd(3, fourLine) },
  ]);

  // A hand-built forgetlines answer with unordered spans plans the same turn as
  // the ordered one. The parser normalises, but a direct caller need not have;
  // the planner's complement reads source order, so the mirror must normalise
  // before it tiles.
  const messy = planEntryShape(landedInput({ action: "forgetlines",
    ranges: [{ from: 3, to: 3 }, { from: 1, to: 1 }], summary: "x" }, four), snapshotOf());
  if (messy.action !== "shape") assert.fail("both must shape");
  assert.deepEqual(messy.keptLineRanges, namedGaps.keptLineRanges,
    "row: unordered spans normalise before tiling");
  assert.deepEqual(messy.replacementBytes, namedGaps.replacementBytes);
  assert.equal(messy.recallId, namedGaps.recallId);
});

// --- every refusal this planner owns, one code per row ---------------------

test("planner refusals — one code per row, and keephead is not an answer class", () => {
  const single = encode("only line\n");
  const rows: readonly {
    name: string;
    answer: EntryAnswer;
    node?: ToolResultNode;
    code: string;
  }[] = [
    // A forgetlines span past the last line is refused by name, never clamped.
    { name: "forgetlines span past the last line", code: "spans-outside-result",
      answer: { action: "forgetlines", ranges: [{ from: 2, to: 9 }], summary: "runs past the end" } },
    // A forgetlines naming every line is a forgetall without a descriptor.
    { name: "forgetlines naming every line, one span", code: "drops-every-line",
      answer: { action: "forgetlines", ranges: [{ from: 1, to: 3 }], summary: "drops it all" } },
    { name: "forgetlines naming every line, two spans", code: "drops-every-line",
      answer: { action: "forgetlines", ranges: [{ from: 1, to: 2 }, { from: 3, to: 3 }],
        summary: "drops it all" } },
    // forgetlines on a one-line body: both ends would coincide.
    { name: "forgetlines on a one-line body", code: "drops-every-line",
      answer: { action: "forgetlines", ranges: [{ from: 1, to: 1 }], summary: "the only line" },
      node: nodeOf(single) },
  ];
  for (const row of rows) {
    const plan = planFor(row.answer, row.node);
    assert.equal(plan.action, "refuse", `row: ${row.name} — expected a refusal`);
    if (plan.action !== "refuse") continue;
    assert.equal(plan.code, row.code, `row: ${row.name}`);
  }
  // The refusal detail names the offending span, so the operator can act.
  const pastEnd = planFor(rows[0]!.answer);
  if (pastEnd.action !== "refuse") assert.fail("row: forgetlines span past the last line");
  assert.match(pastEnd.detail, /lines 2–9/u, "row: forgetlines span past the last line — detail");

  // keephead is not an answer class: the parser refuses it as an unknown action,
  // and no plan arm names it — a keep-first-N answer has no path into the planner.
  assert.throws(() => parseEntryAnswer('{"keephead":2}'), (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code: string }).code === "unknown-action",
  "row: keephead at the parser");
  assert.equal(planFor.toString().includes("keephead"), false, "row: keephead in the planner");
  assert.equal(landedInput.toString().includes("keephead"), false, "row: keephead in the input builder");
});

// --- the landed unit comes IN, and the rule pass never sees an entry -----

function options(rules: readonly Rule[] = []): EngineOptions {
  return {
    sessionId: "session", capabilities: { mutateResult: true, rewriteHistory: false,
      atRest: true, liveTokens: false, log: true, appendRecords: true,
      rehydrateOnResume: false }, config, rules,
    clock: { nowMs: () => 10 },
    meter: { estimate: (content: Uint8Array) => content.length,
      reconcile: () => { throw new Error("unused"); }, latest: () => null } as never,
    ledger: { prepare: async () => { throw new Error("unused"); },
      append: async () => { throw new Error("unused"); },
      events: async function* (): AsyncIterable<never> {},
      recall: async () => { throw new Error("unused"); },
      close: async () => undefined },
    port: { snapshot: async () => snapshotOf(), apply: async () => ({ status: "unknown" }),
      lookupReceipt: async () => ({ status: "unknown" }) },
  };
}

function entryEvent(answer: EntryAnswer | undefined, node = result()) {
  return { kind: "entry" as const, eventId: "entry-1", result: node,
    ...(answer === undefined ? {} : { answer }),
    stamp: { unitId: landedUnitId(node), answeredInRound: 0 as const } };
}

test("the shape op binds the caller's unit id, a foreign id is refused, and the rule pass never runs", () => {
  const plan = planEntryShape({ unitId: "unit:sha256:from-the-mount", nodeId: "result-1",
    originalBytes: bytes, answer: { action: "forgetall", summary: "x" } }, snapshotOf());
  if (plan.action !== "shape") assert.fail(`expected a shape, got ${plan.action}`);
  assert.equal(shapeOpOf(plan).unitId, "unit:sha256:from-the-mount");
  // A foreign id is the guard's refusal (it re-derives the landed unit), never a
  // silent repair in the planner.
  const c = context(valueFor(plan.plan, { action: "forgetall", summary: "x" }));
  checkSources(c, [plan.plan]);
  checkOperations(c, [plan.plan]);
  assert.ok(c.issues.some(issue => issue.code === "unknown-unit"), JSON.stringify(c.issues));

  // And the rule set never sees an answered entry: it is an application, not a
  // rule pass, so a spy rule records no context at all.
  const seen: RuleContext[] = [];
  const spy: Rule = { id: "spy", plan: context => { seen.push(context); return null; } };
  const plans = planApplication(options([spy]), entryEvent({ action: "forgetall", summary: "x" }),
    snapshotOf(), [], [], 10);
  assert.deepEqual(plans.map(entry => entry.ruleId), ["entry-shape"]);
  assert.deepEqual(seen, [], "an answered entry is an application, not a rule pass");
});

// --- the builder ----------------------------------------------------------

function valueFor(plan: RulePlan, answer: EntryAnswer, node = result()): ValidationInput {
  return { input: { kind: "entry", eventId: "entry-1", result: node, answer,
    stamp: { unitId: landedUnitId(node), answeredInRound: 0 } }, snapshot: snapshotOf(),
  capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
    liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
  config, plans: [plan], sealedEpisodeIds: [], nowMs: 10 };
}

async function candidateFor(answer: EntryAnswer, node = result()) {
  const plan = shapePlan(answer, node);
  const value = valueFor(plan.plan, answer, node);
  return { candidate: await buildCandidate(context(value)), plan };
}

test("the builder banks the ORIGINAL body and lands the shaped turn, for every answer form", async () => {
  const { candidate, plan } = await candidateFor({ action: "forgetall", summary: "x" });
  assert.equal(candidate.replacements.length, 1);
  assert.equal(candidate.archives.length, 1);
  assert.equal(candidate.appendRecords.length, 0, "the marker is the turn, not an appended record");
  const replacement = candidate.replacements[0];
  assert.ok(replacement !== undefined);
  assert.deepEqual(replacement.bytes, plan.replacementBytes);
  assert.equal(replacement.evidenceRecallId, plan.recallId);
  // The archive restores the ORIGINAL body byte-exact, under every dropped range.
  const archive = candidate.archives[0];
  assert.ok(archive !== undefined);
  assert.equal(archive.recall.id, plan.recallId);
  assert.deepEqual(archive.recall.parts[0]?.bytes, bytes);
  assert.deepEqual(archive.recall.parts[0]?.removedRanges.map(span => span.range),
    [{ startByte: 0, endByteExclusive: bytes.length }]);
  // The durable row keeps the schema's kind; its rule id names the lane.
  assert.deepEqual([archive.ruleId, archive.operationKind], ["entry-shape", "verdict"]);

  // The shaped candidate passes the guard's output checks for every answer form.
  const forms: readonly EntryAnswer[] = [
    { action: "keeplines", ranges: [{ from: 2, to: 2 }], summary: "stale run notes" },
    { action: "forgetall", summary: "a stale build log" },
  ];
  for (const answer of forms) {
    const shaped = shapePlan(answer);
    const c = context(valueFor(shaped.plan, answer));
    const finalized = finalizeCandidate(c, await buildCandidate(c));
    if (!finalized.ok) assert.fail(`row: ${answer.action} — ${JSON.stringify(finalized.issues)}`);
    assert.equal(finalized.application.mode, "entry", `row: ${answer.action} — mode`);
    assert.equal(finalized.application.phase, "entry", `row: ${answer.action} — phase`);
    assert.equal(finalized.application.replacements.length, 1, `row: ${answer.action} — one turn`);
    assert.equal(finalized.application.archives.length, 1, `row: ${answer.action} — one archive`);
    assert.deepEqual(finalized.application.appendRecords, [], `row: ${answer.action} — no record`);
  }
});

// --- the rule pass never sees an answered entry ---------------------------


