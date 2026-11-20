import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolResultNode } from "../src/types/transcript.js";
import type { Note, RulePlan, VerdictOp } from "../src/rules/types.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit, UnitSegmenter, UnitSpan } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import {
  descriptorIssue, descriptorWordCount, RECEIPT_DESCRIPTOR_WORD_LIMIT,
} from "../src/verdicts/labels.js";
import { deriveVerdictRemoval, planVerdictApplication, VERDICT_RULE_ID, normalizeKeptSpans } from "../src/verdicts/plan.js";
import { VerdictTracker } from "../src/verdicts/tracker.js";
import type { Verdict, VerdictState } from "../src/verdicts/types.js";

const encoder = new TextEncoder();

function nodeOf(index: number, text: string): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id: `result-${index}`, kind: "tool-result", turnOrdinal: index, stepOrdinal: index,
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

/** Ten nodes above a one-byte bar: ten whole-result units, in transcript order. */
function tenUnits(): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: "session-1", barBytes: 1 });
  return Array.from({ length: 10 }, (_, index) => nodeOf(index, `body ${index}\n`))
    .flatMap(node => tracker.unitsFor(node));
}

/** Six two-character lines, 18 bytes: line 3 starts at byte 6 and line 5 at 12. */
const SIX_LINES = "l1\nl2\nl3\nl4\nl5\nl6\n";

interface SingleUnit {
  readonly node: ToolResultNode;
  readonly unit: ProcessingUnit;
}

/** One whole-result unit over six lines, so line spans have somewhere to land. */
function sixLineUnit(index = 0): SingleUnit {
  const node = nodeOf(index, SIX_LINES);
  const unit = new UnitTracker({ sessionId: "session-1", barBytes: 1 }).unitsFor(node)[0];
  assert.ok(unit !== undefined, "fixture must produce one unit");
  return { node, unit };
}

function keepAll(unit: ProcessingUnit, overrides: Partial<Verdict> = {}): Verdict {
  return { unitId: unit.id, action: "keepall", answeredInRound: 0, ...overrides } as Verdict;
}

function keepLines(
  unit: ProcessingUnit,
  ranges: readonly { readonly from: number; readonly to: number }[],
  overrides: Partial<Verdict> = {},
): Verdict {
  return { unitId: unit.id, action: "keeplines", ranges, answeredInRound: 0, ...overrides } as Verdict;
}

function forgetAll(unit: ProcessingUnit, summary: string | null = "a topic", overrides: Partial<Verdict> = {}): Verdict {
  return { unitId: unit.id, action: "forgetall", summary, answeredInRound: 0, ...overrides } as Verdict;
}

function forgetLines(
  unit: ProcessingUnit,
  ranges: readonly { readonly from: number; readonly to: number }[],
  overrides: Partial<Verdict> = {},
): Verdict {
  return { unitId: unit.id, action: "forgetlines", ranges, answeredInRound: 0, ...overrides } as Verdict;
}

function mustPlan(state: VerdictState, nodes: readonly ToolResultNode[], baseRevision = "revision-1"): RulePlan {
  const plan = planVerdictApplication({ state, nodes, baseRevision });
  assert.ok(plan !== null, "expected a plan");
  return plan;
}

function verdictOps(plan: RulePlan): readonly VerdictOp[] {
  return plan.operations.filter((op): op is VerdictOp => op.kind === "verdict");
}

type ReceiptNote = Extract<Note, { kind: "receipt" }>;

function receiptNotes(plan: RulePlan): readonly ReceiptNote[] {
  return plan.notes.filter((note): note is ReceiptNote => note.kind === "receipt");
}

/** Splits every node into two disjoint halves at the first line boundary past the middle. */
class HalvesSegmenter implements UnitSegmenter {
  split(node: ToolResultNode, barBytes: number): readonly UnitSpan[] {
    if (node.bytes.length < barBytes) return [];
    const half = Math.ceil(node.bytes.length / 2);
    return [
      { byteRange: { startByte: 0, endByteExclusive: half },
        lineRange: { startLine: 1, endLineInclusive: 1 } },
      { byteRange: { startByte: half, endByteExclusive: node.bytes.length },
        lineRange: { startLine: 2, endLineInclusive: 2 } },
    ];
  }
}

/**
 * Five two-line nodes split in halves: ten units, each a strict part of its
 * node (6 of 13 bytes), so a span assertion cannot pass by covering the node.
 */
function tenHalfUnits(): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({
    sessionId: "session-1", barBytes: 1, segmenter: new HalvesSegmenter(),
  });
  return Array.from({ length: 5 }, (_, index) => nodeOf(index, "first\nsecond\n"))
    .flatMap(node => tracker.unitsFor(node));
}

const TEN_HALF_NODES = Array.from({ length: 5 }, (_, index) => nodeOf(index, "first\nsecond\n"));

// --- incremental completion -------------------------------------------------

test("judging 9 of 10 units leaves exactly 1 pending, and every accepted verdict is kept", () => {
  const units = tenUnits();
  assert.equal(units.length, 10);
  const tracker = new VerdictTracker({ units, round: 3 });
  for (const unit of units.slice(0, 9)) {
    assert.deepEqual(tracker.judge(keepAll(unit, { answeredInRound: 3 })), { status: "accepted" });
  }
  // The non-vacuity seed: a tracker that dropped judged units would report
  // zero pending (and complete) here instead of the tenth unit.
  assert.deepEqual(tracker.pending().map(unit => unit.id), [units[9]?.id]);
  assert.equal(tracker.state().units.length, 10, "the window keeps every unit");
  assert.equal(tracker.state().verdicts.length, 9);
  assert.equal(tracker.isComplete(), false);

  assert.deepEqual(tracker.judge(forgetAll(units[9]!, "a topic", { answeredInRound: 3 })),
    { status: "accepted" });
  assert.deepEqual(tracker.pending(), []);
  assert.equal(tracker.isComplete(), true);

  // The tracker records every accepted verdict, so a dropped unit would change
  // the plan: all ten forgotten, ten ops, in window order, each over its span.
  const allForgotten = new VerdictTracker({ units });
  for (const unit of units) allForgotten.judge(forgetAll(unit));
  assert.equal(allForgotten.isComplete(), true);
  assert.equal(allForgotten.state().verdicts.length, 10);
  const plan = mustPlan(allForgotten.state(), []);
  assert.equal(plan.operations.length, 10);
  assert.deepEqual(verdictOps(plan).map(op => op.unitId), units.map(unit => unit.id));
  const spans = plan.removals.flatMap(removal => removal.sources.flatMap(source => source.ranges));
  assert.deepEqual(spans, units.map(unit => unit.span.byteRange));

  // A keep-only window plans nothing, and unanswered units are never burned.
  const keepOnly = new VerdictTracker({ units });
  for (const unit of units.slice(0, 4)) keepOnly.judge(keepAll(unit));
  // Keep-only: no revert applies, so the planner yields no plan at all.
  assert.equal(planVerdictApplication({ state: keepOnly.state(), nodes: [],
    baseRevision: "revision-1" }), null, "a keep-only window plans nothing");
  // One forgetall beside keeps and unanswered units: exactly the forgotten one
  // applies.
  keepOnly.judge(forgetAll(units[5]!));
  const ops = verdictOps(mustPlan(keepOnly.state(), []));
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.unitId, units[5]?.id);
  assert.equal(keepOnly.pending().length, 5, "four keeps and one forget leave five unanswered");
});

test("a late stale-round verdict is refused after a re-ask or restart (ISSUE-332)", () => {
  const { unit } = sixLineUnit();
  const tracker = new VerdictTracker({ units: [unit], round: 1 });
  // The re-ask opens round 2; a late answer still stamped round 1 arrives.
  assert.equal(tracker.nextRound(), 2);
  const late = keepAll(unit, { answeredInRound: 1 });
  assert.deepEqual(tracker.judge(late), { status: "stale-round" },
    "the stale-round answer is refused, not applied");
  assert.deepEqual(tracker.pending().map(candidate => candidate.id), [unit.id],
    "the unit is not burned by the stale answer");
  // A restart opens a fresh window at the new round: the old round's late
  // answer is refused there too, and the current round's answer still lands.
  const restarted = new VerdictTracker({ units: [unit], round: 2 });
  assert.deepEqual(restarted.judge(late), { status: "stale-round" });
  assert.deepEqual(restarted.pending().map(candidate => candidate.id), [unit.id]);
  assert.deepEqual(restarted.judge(keepAll(unit, { answeredInRound: 2 })),
    { status: "accepted" });
  assert.equal(restarted.isComplete(), true);
});

test("a forgetall yields one VerdictOp over its own span, whether whole or partial", () => {
  // Ten half-node units, so the unit span is provably not "the whole node":
  // a planner that widened a range to the node boundary fails here.
  const units = tenHalfUnits();
  assert.equal(units.length, 10);
  const tracker = new VerdictTracker({ units });
  const forgotten = units[3]!;
  tracker.judge(forgetAll(forgotten, "auth retry"));
  for (const unit of units.filter(candidate => candidate.id !== forgotten.id)) {
    tracker.judge(keepAll(unit));
  }

  const plan = mustPlan(tracker.state(), TEN_HALF_NODES, "revision-7");
  assert.equal(plan.ruleId, VERDICT_RULE_ID);
  assert.equal(plan.ruleId, "verdict");
  assert.equal(plan.baseRevision, "revision-7");
  const ops = verdictOps(plan);
  assert.equal(plan.operations.length, 1);
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.equal(op.unitId, forgotten.id);
  assert.equal(plan.removals.length, 1);
  const removal = plan.removals[0]!;
  assert.equal(op.removalId, removal.id);
  assert.equal(removal.id, forgotten.id);
  assert.deepEqual(removal.sources, [{
    source: { ...forgotten.source },
    ranges: [{ startByte: 7, endByteExclusive: 13 }],
  }]);
  assert.deepEqual(removal.sources[0]?.ranges, [forgotten.span.byteRange]);
  const notes = receiptNotes(plan);
  assert.equal(notes.length, 1);
  const note = notes[0]!;
  assert.equal(note.id, op.noteId);
  assert.equal(note.removalId, removal.id);
  assert.equal(note.unitId, forgotten.id);
  assert.equal(note.path, "src/file-1.ts");
  // A partial unit names its lines; the receipt can never claim the whole node.
  assert.deepEqual(note.ranges, [forgotten.span.lineRange]);
  assert.deepEqual(note.ranges, [{ startLine: 2, endLineInclusive: 2 }]);
  assert.equal(note.label, "auth retry");

  // A second, hand-buildable shape: a forgetall inside a partial unit names that
  // unit's line range on the receipt, and the removal is that half's bytes.
  const halfNode = nodeOf(0, "first\nsecond\n");
  const halfUnit = new UnitTracker({ sessionId: "session-1", barBytes: 1,
    segmenter: new HalvesSegmenter() }).unitsFor(halfNode)[1];
  assert.ok(halfUnit !== undefined);
  const halfTracker = new VerdictTracker({ units: [halfUnit] });
  halfTracker.judge(forgetAll(halfUnit));
  const halfPlan = mustPlan(halfTracker.state(), [halfNode]);
  assert.deepEqual(receiptNotes(halfPlan)[0]!.ranges, [{ startLine: 2, endLineInclusive: 2 }],
    "row: a partial unit's receipt names its own line range");
  assert.deepEqual(halfPlan.removals[0]?.sources[0]?.ranges,
    [{ startByte: 7, endByteExclusive: 13 }], "row: a partial unit's removal is its own bytes");

  // A unit with no hit path still names a non-empty receipt path, and a
  // forgetall with no summary ships the floor line.
  const bare = nodeOf(1, "head\n");
  const pathlessNode = { ...bare, evidence: { ...bare.evidence, paths: [] } };
  const pathless = new UnitTracker({ sessionId: "session-1", barBytes: 1 })
    .unitsFor(pathlessNode)[0];
  assert.ok(pathless !== undefined);
  assert.equal(pathless.path, null);
  const pathlessTracker = new VerdictTracker({ units: [pathless] });
  pathlessTracker.judge(forgetAll(pathless, null));
  const pathlessNote = receiptNotes(mustPlan(pathlessTracker.state(), [pathlessNode]))[0]!;
  assert.equal(pathlessNote.path, pathless.nodeId, "row: no hit path still names the node id");
  assert.equal(pathlessNote.label, null, "row: no hit path ships no descriptor");

  // A repeated verdict inside a hand-built state cannot double-plan a unit.
  const units10 = tenUnits();
  const verdict = forgetAll(units10[0]!);
  const repeated = mustPlan({ round: 0, units: units10, verdicts: [verdict, { ...verdict }] }, []);
  assert.equal(repeated.operations.length, 1, "row: a repeated verdict plans one op");
  assert.equal(repeated.removals.length, 1, "row: a repeated verdict plans one removal");
  assert.equal(repeated.notes.length, 1, "row: a repeated verdict plans one note");
});

test("a keep-only window plans nothing, and unanswered units are never burned", () => {
  const units = tenUnits();
  const tracker = new VerdictTracker({ units });
  for (const unit of units.slice(0, 4)) tracker.judge(keepAll(unit));
  // Keep-only: no revert applies, so the planner yields no plan at all.
  assert.equal(planVerdictApplication({ state: tracker.state(), nodes: [], baseRevision: "revision-1" }), null);

  // One forgetall beside keeps and unanswered units: exactly the forgotten one applies.
  tracker.judge(forgetAll(units[5]!));
  const ops = verdictOps(mustPlan(tracker.state(), []));
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.unitId, units[5]?.id);
  assert.equal(tracker.pending().length, 5, "four keeps and one forget leave five unanswered");
});

test("a keeplines removes the complement inside the unit and names it on the receipt", () => {
  const { node, unit } = sixLineUnit();
  const derived = deriveVerdictRemoval(unit, keepLines(unit, [{ from: 1, to: 2 }, { from: 5, to: 6 }]), node.bytes);
  assert.ok(derived !== null);
  // Lines 3–4 are bytes 6..12 of an 18-byte node; lines 1–2 and 5–6 are kept.
  assert.deepEqual(derived.byteRanges, [{ startByte: 6, endByteExclusive: 12 }]);
  assert.deepEqual(derived.receiptRanges, [{ startLine: 3, endLineInclusive: 4 }]);

  const tracker = new VerdictTracker({ units: [unit] });
  tracker.judge(keepLines(unit, [{ from: 1, to: 2 }, { from: 5, to: 6 }]));
  const plan = mustPlan(tracker.state(), [node]);
  assert.equal(plan.removals.length, 1);
  assert.deepEqual(plan.removals[0]?.sources[0]?.ranges, [{ startByte: 6, endByteExclusive: 12 }]);
  const note = receiptNotes(plan)[0]!;
  assert.deepEqual(note.ranges, [{ startLine: 3, endLineInclusive: 4 }]);
  // A keeplines receipt carries no descriptor: the ranges say what left.
  assert.equal(note.label, null);

  // Dropping one kept span changes the planned removal, so a lost span cannot
  // pass: two kept spans give one removal range; dropping the second kept span
  // merges the removal into the tail, and the two plans differ.
  const both = deriveVerdictRemoval(unit, keepLines(unit, [{ from: 1, to: 1 }, { from: 6, to: 6 }]), node.bytes);
  const dropped = deriveVerdictRemoval(unit, keepLines(unit, [{ from: 1, to: 1 }]), node.bytes);
  assert.ok(both !== null && dropped !== null);
  assert.deepEqual(both.byteRanges, [{ startByte: 3, endByteExclusive: 15 }],
    "row: the second kept span shortens the removal");
  assert.deepEqual(dropped.byteRanges, [{ startByte: 3, endByteExclusive: 18 }],
    "row: without it the removal runs to the tail");
  assert.notDeepEqual(both.byteRanges, dropped.byteRanges,
    "row: a lost kept span would change the plan");
});

test("a forgetlines removes the NAMED spans, normalised, and names them on the receipt", () => {
  const { node, unit } = sixLineUnit();
  // Lines are 3 bytes each: dropping line 2 removes bytes 3–6, and dropping
  // lines 5–6 removes 12–18. The kept side is only used to derive the bytes.
  const derived = deriveVerdictRemoval(unit, forgetLines(unit, [{ from: 2, to: 2 }]), node.bytes);
  assert.ok(derived !== null);
  assert.deepEqual(derived.byteRanges, [{ startByte: 3, endByteExclusive: 6 }],
    "row: one named line removes its own bytes");
  assert.deepEqual(derived.receiptRanges, [{ startLine: 2, endLineInclusive: 2 }],
    "row: one named line names its own line");
  // Two named spans are two disjoint removals, in source order.
  const two = deriveVerdictRemoval(unit, forgetLines(unit,
    [{ from: 5, to: 6 }, { from: 2, to: 2 }]), node.bytes);
  assert.ok(two !== null);
  assert.deepEqual(two.byteRanges, [
    { startByte: 3, endByteExclusive: 6 },
    { startByte: 12, endByteExclusive: 18 },
  ], "row: two unsorted named spans are ordered");
  assert.deepEqual(two.receiptRanges, [
    { startLine: 2, endLineInclusive: 2 },
    { startLine: 5, endLineInclusive: 6 },
  ], "row: two unsorted named spans name both lines");

  // Unsorted and overlapping named spans normalise before deriving.
  const ordered = deriveVerdictRemoval(unit, forgetLines(unit, [{ from: 1, to: 2 }, { from: 5, to: 5 }]), node.bytes);
  const messy = deriveVerdictRemoval(unit, forgetLines(unit,
    [{ from: 5, to: 5 }, { from: 1, to: 1 }, { from: 2, to: 2 }]), node.bytes);
  assert.ok(ordered !== null && messy !== null);
  assert.deepEqual(messy, ordered, "row: the normaliser is the contract");

  // Unsorted and overlapping KEPT spans normalise before the complement.
  assert.deepEqual(normalizeKeptSpans([{ from: 5, to: 6 }, { from: 1, to: 2 }]),
    [{ from: 1, to: 2 }, { from: 5, to: 6 }], "row: kept spans sort");
  // Overlap and adjacency both collapse: the complement is the same either way.
  assert.deepEqual(normalizeKeptSpans([{ from: 1, to: 4 }, { from: 3, to: 6 }]),
    [{ from: 1, to: 6 }], "row: overlapping kept spans collapse");
  assert.deepEqual(normalizeKeptSpans([{ from: 1, to: 2 }, { from: 3, to: 4 }]),
    [{ from: 1, to: 4 }], "row: adjacent kept spans collapse");
  const messyKept = deriveVerdictRemoval(unit, keepLines(unit, [
    { from: 5, to: 6 }, { from: 1, to: 2 }, { from: 2, to: 2 },
  ]), node.bytes);
  assert.ok(messyKept !== null);
  assert.deepEqual(messyKept.byteRanges, [{ startByte: 6, endByteExclusive: 12 }],
    "row: a messy kept answer derives the ordered removal");
  assert.deepEqual(messyKept.receiptRanges, [{ startLine: 3, endLineInclusive: 4 }]);
});

test("malformed spans are refused by name, never clamped or repaired", () => {
  const { node, unit } = sixLineUnit();
  // A span whose `from` precedes `to` is malformed, not sortable.
  for (const span of [[{ from: 4, to: 2 }], [{ from: 0, to: 2 }], [{ from: 1.5, to: 2 }], [{}]]) {
    assert.equal(normalizeKeptSpans(span as never), null,
      `row: ${JSON.stringify(span)} is malformed, not sortable`);
  }
  // An out-of-bounds kept span is refused, never clamped.
  assert.equal(deriveVerdictRemoval(unit, keepLines(unit, [{ from: 1, to: 7 }]), node.bytes), null,
    "row: a kept span past the last line");
  assert.equal(deriveVerdictRemoval(unit, keepLines(unit, [{ from: 7, to: 7 }]), node.bytes), null,
    "row: a kept span starting past the last line");
  // A plan built from such an answer carries nothing: the guard then refuses the
  // batch as incomplete, so a misread span is re-asked, never silently repaired.
  const tracker = new VerdictTracker({ units: [unit] });
  tracker.judge(keepLines(unit, [{ from: 1, to: 7 }]));
  assert.equal(planVerdictApplication({ state: tracker.state(), nodes: [node], baseRevision: "r" }), null,
    "row: an out-of-bounds answer plans nothing");

  // keeplines line numbers are relative to the unit, not the node: the second
  // half of a two-line node is a one-line unit whose line 1 is the node's line
  // 2. A planner reading node lines would keep the wrong bytes — here keeping
  // the unit's only line keeps everything, which is a keepall in disguise.
  const halfNode = nodeOf(0, "first\nsecond\n");
  const halfUnit = new UnitTracker({ sessionId: "session-1", barBytes: 1,
    segmenter: new HalvesSegmenter() }).unitsFor(halfNode)[1];
  assert.ok(halfUnit !== undefined);
  assert.equal(deriveVerdictRemoval(halfUnit, keepLines(halfUnit, [{ from: 1, to: 1 }]),
    halfNode.bytes), null, "row: unit-relative line numbers");

  // A negative or fractional round is refused at the seam.
  assert.throws(() => new VerdictTracker({ units: [], round: -1 }), /round/u, "row: round -1");
  assert.throws(() => new VerdictTracker({ units: [], round: 1.5 }), /round/u, "row: round 1.5");
});

test("the tracker refuses a duplicate verdict and a stranger unit, never absorbing either", () => {
  const units = tenUnits();
  const tracker = new VerdictTracker({ units });
  // The first verdict stands; the second is a named duplicate carrying the first.
  const first = forgetAll(units[0]!, "first answer");
  assert.deepEqual(tracker.judge(first), { status: "accepted" });
  const outcome = tracker.judge(keepAll(units[0]!));
  assert.equal(outcome.status, "duplicate", "row: a second verdict for one unit");
  if (outcome.status !== "duplicate") assert.fail("expected a duplicate");
  assert.deepEqual(outcome.existing, first);
  assert.equal(tracker.state().verdicts.length, 1, "row: the first verdict still stands");
  assert.equal(tracker.state().verdicts[0]?.action, "forgetall");
  assert.deepEqual(tracker.pending().map(unit => unit.id), units.slice(1).map(unit => unit.id));

  // A verdict for a unit outside the window is rejected, never absorbed.
  const outside = new VerdictTracker({ units });
  const stranger = { ...units[0]!, id: "unit:sha256:outside" };
  assert.deepEqual(outside.judge(forgetAll(stranger)), { status: "unknown-unit" },
    "row: a unit outside the window");
  assert.equal(outside.state().verdicts.length, 0, "row: a stranger records no verdict");
  assert.equal(outside.pending().length, 10, "row: a stranger leaves the window untouched");

  // The descriptor cap is a word count, not a character count.
  assert.equal(descriptorWordCount("doc header and comments on sandboxing, irrelevant for this feature."), 10);
  assert.equal(descriptorWordCount("  \n\n  "), 0);
  assert.equal(descriptorWordCount("one\n\ntwo"), 2);
  assert.equal(descriptorIssue("w ".repeat(RECEIPT_DESCRIPTOR_WORD_LIMIT).trim()), null,
    "row: exactly at the 25-word cap");
  assert.equal(descriptorIssue("w ".repeat(RECEIPT_DESCRIPTOR_WORD_LIMIT + 1).trim()), "descriptor-too-long",
    "row: one word past the cap");
  // Characters do not decide: a 200-character single word is one word.
  assert.equal(descriptorIssue("x".repeat(200)), null, "row: a 200-character single word");
});
