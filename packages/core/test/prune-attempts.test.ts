/**
 * Attempt-aware merge and attempt telemetry (ISSUE-022 chunk 6; ADR-0009's
 * second amendment — carry-over re-ask; its 12-row table cap was removed by the
 * 2026-11-16 owner ruling recorded in ADR-0060 §Amendment).
 *
 * Three families, each pinned where it can fail:
 *
 *   1. FINAL-ANSWER precedence, one row per branch: one valid answer always
 *      wins over refusals; two answers for one index are ambiguous and keep; a
 *      pass whose every attempt refused reports the LAST attempt's code and
 *      message, not the first.
 *   2. the record's attempt fields, populated from `summarizeTableAttempt` /
 *      `summarizePassAttempts`: a two-table pass with one carry and its re-ask
 *      reads as `{tables: 2, carried: 1, reasked: 1, finalRefusals: 0}`, and
 *      the per-table counters name the re-ask ordinal, not the table's.
 *   3. the zero shape: a pass with no table loop records an EMPTY table list and
 *      all-zero totals — never a fabricated table, never a null.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planCarryOver } from "../src/prune/ask-carry.js";
import type { PruneCarryOverPlan } from "../src/prune/ask-carry.js";
import { parsePruneAnswer } from "../src/prune/ask-answer.js";
import type { PruneAnswerRefusalCode, PruneAnswerRow } from "../src/prune/ask-answer.js";
import { summarizePassAttempts, summarizeTableAttempt } from "../src/prune/attempts.js";
import { applyPruneAnswers } from "../src/prune/pass-answers.js";
import { planPrunePass } from "../src/prune/pass.js";
import type { PrunePassPlan } from "../src/prune/pass.js";
import { pruneRecordOf } from "../src/prune/record.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";

const encoder = new TextEncoder();
const SESSION = "session-attempts";

function evidenceOf(target: string, paths: readonly PathEvidence[]): ToolEvidence {
  return {
    kind: "read", target: { key: target, label: target }, paths,
    source: { nodeId: "", sha256: "", byteLength: 0 }, sourceRecallId: null,
  };
}

function hit(pathKey: string): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 2, byteLength: 8, outcome: "hit" };
}

function nodeOf(id: string, text: string, stepOrdinal: number): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidenceOf(`src/${id}.ts`, [hit(`src/${id}.ts`)]),
      source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

/** Four distinct bodies above the bar: L1 proves nothing, so four ask rows. */
function nodes(): readonly ToolResultNode[] {
  return [
    nodeOf("a", "alpha one\nalpha two\n", 1),
    nodeOf("b", "beta one\nbeta two\n", 2),
    nodeOf("c", "gamma one\ngamma two\n", 3),
    nodeOf("d", "delta one\ndelta two\n", 4),
  ];
}

function unitsOf(all: readonly ToolResultNode[]): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  return all.flatMap(node => tracker.unitsFor(node));
}

function planOf(all: readonly ToolResultNode[]): PrunePassPlan {
  return planPrunePass({
    units: unitsOf(all), nodes: all, episodes: [], classes: {}, round: 1,
    // These rows pin the shipped three-way contract; the no-grammar default is
    // nokeepall and has its own tests in `prune-pass.test.ts`.
    grammar: "3option",
  });
}

function unitIdOf(all: readonly ToolResultNode[], nodeId: string): string {
  return unitsOf([all.find(node => node.id === nodeId)!])[0]!.id;
}

function answerOf(plan: PrunePassPlan, texts: readonly string[]) {
  return applyPruneAnswers(plan, texts, {
    indices: plan.askRows.map(row => row.index), stamps: plan.stamps,
  });
}

/** The parser's own reading of one answer text, as a table loop reads it. */
function outcomesOf(plan: PrunePassPlan, text: string): readonly PruneAnswerRow[] {
  return parsePruneAnswer(text, {
    indices: plan.askRows.map(row => row.index), stamps: plan.stamps,
  }).rows;
}

/** The fixture node id behind a unit id, so a failure names the node, not the hash. */
function nodeNameOf(all: readonly ToolResultNode[], unitId: string): string {
  const found = all.find(node => unitIdOf(all, node.id) === unitId);
  assert.ok(found !== undefined, `no fixture node owns unit ${unitId}`);
  return found.id;
}

// --- 1. final-answer precedence ---------------------------------------------

/**
 * One pass, the texts its tables sent in attempt order, and what the merge made
 * of them: which units move, and every refusal with the code and the text that
 * produced it. The four rows are the four precedence branches.
 */
interface MergeRow {
  readonly name: string;
  readonly texts: readonly string[];
  /** Units the pass removes, by fixture node id. */
  readonly removals: readonly string[];
  /** Every refusal, by fixture node id: its code and the text that produced it. */
  readonly refusals: readonly {
    readonly node: string;
    readonly code: PruneAnswerRefusalCode;
    readonly answerIndex: number | null;
  }[];
}

const MERGE_ROWS: readonly MergeRow[] = [
  // Indices a text never names are reported by the LAST text, so every row
  // below lists all four units: the one it is about, and the three it left out.
  { name: "one valid answer outranks a later unreadable text",
    texts: ['{"1":{"forgetall":"a stale log"}}', "not json"],
    removals: ["a"],
    refusals: ["b", "c", "d"].map(node =>
      ({ node, code: "answer-unreadable", answerIndex: 1 })) },
  { name: "two valid answers for one index are ambiguous, so the unit is kept",
    texts: ['{"1":{"forgetall":"first attempt"}}', '{"1":{"forgetall":"second attempt"}}'],
    removals: [],
    refusals: [{ node: "a", code: "duplicate-index", answerIndex: null },
      ...["b", "c", "d"].map(node =>
        ({ node, code: "missing-index" as const, answerIndex: 1 }))] },
  { name: "all attempts refused: the LAST attempt's code is reported",
    texts: ["not json", '{"1":{"keeplines":[[9,1],"out of range"]}}'],
    removals: [],
    refusals: [{ node: "a", code: "malformed-row", answerIndex: 1 },
      ...["b", "c", "d"].map(node =>
        ({ node, code: "missing-index" as const, answerIndex: 1 }))] },
  { name: "a malformed later row never undoes an earlier valid answer",
    texts: ['{"2":{"forgetall":"the second half"}}', '{"2":{"forgetall":42}}'],
    removals: ["b"],
    refusals: ["a", "c", "d"].map(node =>
      ({ node, code: "missing-index" as const, answerIndex: 1 })) },
  { name: "an index no text ever names keeps as missing-index, not as a stale answer",
    texts: ['{"1":{"keepall":true},"2":{"keepall":true}}', '{"1":{"forgetall":42}}'],
    removals: [],
    refusals: [
      { node: "c", code: "missing-index", answerIndex: 1 },
      { node: "d", code: "missing-index", answerIndex: 1 },
    ] },
];

test("answer merge — one row per precedence rule", () => {
  const all = nodes();
  const plan = planOf(all);
  for (const row of MERGE_ROWS) {
    const application = answerOf(plan, row.texts);
    assert.deepEqual(application.removals.map(removal => nodeNameOf(all, removal.unitId)),
      row.removals, `row: ${row.name} — the removed units`);
    assert.deepEqual(application.refused.map(refusal => ({
      node: nodeNameOf(all, refusal.unitId),
      code: refusal.code,
      answerIndex: refusal.answerIndex,
    })), row.refusals, `row: ${row.name} — the refusals and the text that produced them`);
    // A decided index is never refused by another text, whichever way it was
    // decided: the two lists name disjoint units.
    const removed = new Set(application.removals.map(removal => removal.unitId));
    for (const refusal of application.refused) {
      assert.equal(removed.has(refusal.unitId), false,
        `row: ${row.name} — a removed unit carries no refusal`);
    }
  }
});

// --- 2. the record's attempt telemetry --------------------------------------

/** A two-table pass over the fixture: rows 1..4, row 1 carried, then re-asked. */
function twoTablePass(plan: PrunePassPlan) {
  const first = planCarryOver(plan.askRows,
    outcomesOf(plan, '{"2":{"keepall":true},"3":{"forgetall":"the third"},"4":{"keepall":true}}'),
    { attempt: 1 });
  // Table 2 asks the carried row 1 at its front, and it answers this time.
  const second = planCarryOver(first.carry.map(entry => entry.row),
    outcomesOf(plan, '{"1":{"forgetall":"the first"}}'), { attempt: 2 });
  return { first, second };
}

/**
 * One record shape per row: a two-table pass that carries and re-asks, and a
 * pass with no table loop at all. The second is the zero shape, asserted beside
 * the omitted argument and a zero-unit pass so a fabricated table would show.
 */
interface RecordRow {
  readonly name: string;
  readonly loop: boolean;
}

const RECORD_ROWS: readonly RecordRow[] = [
  { name: "a two-table pass with one carry and its re-ask", loop: true },
  { name: "a pass with no table loop records the zero shape", loop: false },
];

test("the record — attempt telemetry, or the zero shape", () => {
  const all = nodes();
  const plan = planOf(all);
  for (const row of RECORD_ROWS) {
    if (!row.loop) {
      // `attempts: null` is the unasked path (no model seam): the record must
      // not invent a table, and its totals must be the four zeros.
      const record = pruneRecordOf(plan, null, null);
      assert.deepEqual(record.tableAttempts, [], `row: ${row.name} — no table is invented`);
      assert.deepEqual(record.passAttempts, { tables: 0, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 },
        `row: ${row.name} — the four zero totals`);
      assert.deepEqual(pruneRecordOf(plan, null).passAttempts, record.passAttempts,
        `row: ${row.name} — the omitted argument reads the same`);
      // And a zero-unit pass records the same zero shape rather than a NaN table.
      const empty = planPrunePass({ units: [], nodes: [], episodes: [], classes: {}, round: 0 });
      const emptyRecord = pruneRecordOf(empty, answerOf(empty, []));
      assert.deepEqual(emptyRecord.tableAttempts, [], `row: ${row.name} — a zero-unit pass asks no table`);
      assert.deepEqual(emptyRecord.passAttempts, record.passAttempts,
        `row: ${row.name} — and totals the same zeros`);
      continue;
    }
    const { first, second } = twoTablePass(plan);
    // The counters come from the SAME reading a table loop does: each table is
    // summarized against its own reply, and the plans fold into the pass totals.
    const tables = [
      summarizeTableAttempt(first.table,
        outcomesOf(plan, '{"2":{"keepall":true},"3":{"forgetall":"the third"},"4":{"keepall":true}}'),
        1),
      summarizeTableAttempt(second.table, outcomesOf(plan, '{"1":{"forgetall":"the first"}}'), 2),
    ];
    const pass = summarizePassAttempts([first as PruneCarryOverPlan, second as PruneCarryOverPlan], 2);
    const application = answerOf(plan, ['{"2":{"keepall":true},"3":{"forgetall":"the third"},'
      + '"4":{"keepall":true}}', '{"1":{"forgetall":"the first"}}']);
    const record = pruneRecordOf(plan, application, { tables, pass });

    assert.deepEqual(record.passAttempts,
      { tables: 2, carried: 1, reasked: 1, finalRefusals: 0, deferred: 0 },
      `row: ${row.name} — the four pass totals`);
    assert.deepEqual(record.tableAttempts.map(entry => [entry.tableUnits, entry.attempt]),
      [[4, 1], [1, 2]], `row: ${row.name} — table 2 carries ONE row at the re-ask ordinal`);
    assert.deepEqual(record.tableAttempts[0]?.refusedByCode,
      { "missing-index": 1, "duplicate-index": 0, "malformed-row": 0,
        "answer-not-an-object": 0, "answer-unreadable": 0,
        "action-not-in-grammar": 0, "spans-outside-result": 0 },
      `row: ${row.name} — table 1's refusal counts`);
    assert.equal(record.tableAttempts[0]?.answered, 3, `row: ${row.name} — table 1 answered three`);
    assert.equal(record.tableAttempts[1]?.answered, 1, `row: ${row.name} — the re-ask answered one`);
    // The judged counts are unchanged by the telemetry: index 1 and index 3 were
    // forgotten, and nothing was refused.
    assert.deepEqual(record.l2RemovalCount, { keeplines: 0, forgetall: 2, forgetlines: 0 },
      `row: ${row.name} — the judged removal counts`);
    assert.equal(record.refusedCount["missing-index"], 0,
      `row: ${row.name} — the re-ask was answered`);
    // And the record still names no unit, receipt or recall id (ADR-0008).
    const text = JSON.stringify(record);
    for (const unit of plan.units) {
      assert.equal(text.includes(unit.id), false,
        `row: ${row.name} — the record names no unit id`);
    }
  }
});

test("a stamp from another round is refused by name, never applied (ISSUE-332)", () => {
  const all = nodes();
  const plan = planOf(all);
  const indices = plan.askRows.map(row => row.index);
  const answer = JSON.stringify(Object.fromEntries(
    indices.map(index => [String(index), { keepall: true }])));
  // Positive control: the pass's own stamps read the answer cleanly.
  assert.doesNotThrow(() => answerOf(plan, [answer]),
    "the current round's stamps still admit the answer");
  // A re-ask or restart moved the round on; reading a late answer against the
  // old round's stamps is a caller bug, refused by name like a stamp naming
  // another unit — never applied to the new window.
  const stale = new Map([...plan.stamps].map(([index, stamp]) =>
    [index, { ...stamp, answeredInRound: stamp.answeredInRound + 1 }] as const));
  assert.throws(() => applyPruneAnswers(plan, [answer], { indices, stamps: stale }),
    /round/u, "the stale-round stamp is refused by name");
});
