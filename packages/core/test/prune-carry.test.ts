import assert from "node:assert/strict";
import { test } from "node:test";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import type { WireStamp } from "../src/verdicts/wire.js";
import { buildPruneAskRows } from "../src/prune/ask.js";
import type { PruneAskRow } from "../src/prune/ask.js";
import { parsePruneAnswer, PRUNE_ANSWER_REFUSAL_CODES } from "../src/prune/ask-answer.js";
import type { PruneAnswerRow } from "../src/prune/ask-answer.js";
import { planCarryOver } from "../src/prune/ask-carry.js";
import type { PruneCarryEntry, PruneCarryOverPlan } from "../src/prune/ask-carry.js";
import { summarizePassAttempts, summarizeTableAttempt } from "../src/prune/attempts.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";

const encoder = new TextEncoder();
const SESSION = "session-carry";

function evidenceOf(target: string): ToolEvidence {
  return {
    kind: "read",
    target: { key: target, label: target },
    paths: [] as readonly PathEvidence[],
    source: { nodeId: "", sha256: "", byteLength: 0 },
    sourceRecallId: null,
  };
}

function nodeOf(id: string, target: string, stepOrdinal = 1): ToolResultNode {
  const bytes = encoder.encode(`${id} line one\n${id} line two\n`);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidenceOf(target), source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

/** A pass's rows, 1..n in transcript order, built the way production builds them. */
function rowsOf(count: number): readonly PruneAskRow[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  const nodes = Array.from(
    { length: count },
    (_, i) => nodeOf(`n${String(i + 1)}`, `src/f${String(i + 1)}.ts`, i + 1),
  );
  return buildPruneAskRows(nodes.map(node => ({ node, unit: tracker.unitsFor(node)[0]! })));
}

function stampsOf(rows: readonly PruneAskRow[]): ReadonlyMap<number, WireStamp> {
  return new Map(rows.map(row => [row.index, { unitId: row.unit.id, answeredInRound: 1 }]));
}

/** The parser's own reading of one answer, so carry tests speak the real vocabulary. */
function outcomesOf(rows: readonly PruneAskRow[], answer: string): readonly PruneAnswerRow[] {
  return parsePruneAnswer(answer, {
    indices: rows.map(row => row.index), stamps: stampsOf(rows),
  }).rows;
}

function indexesOf(entries: readonly { readonly index: number }[]): readonly number[] {
  return entries.map(entry => entry.index);
}

// --- which rows are carried -------------------------------------------------

/**
 * One table per row, answered differently: a refusal, an absent index, an
 * outcome list missing an index, and a table where every row answers. The carry
 * list and its codes are the whole rule, so each row pins both.
 */
const CARRY_ROWS: readonly {
  name: string;
  count: number;
  answer: string;
  /** Parsed outcomes to keep; all of them when omitted. */
  keep?: readonly number[];
  carry: readonly number[];
  codes: readonly string[];
  settled: readonly number[];
}[] = [
  { name: "a malformed row is carried beside an absent index", count: 3,
    answer: '{"1":{"keepall":true},"3":{"keeplines":[[2,1],"backwards"]}}',
    carry: [2, 3], codes: ["missing-index", "malformed-row"], settled: [1] },
  { name: "an unanswered index is carried as missing-index", count: 4,
    answer: '{"1":{"keepall":true},"4":{"keepall":true}}',
    carry: [2, 3], codes: ["missing-index", "missing-index"], settled: [1, 4] },
  { name: "an outcome list that omits an index reads the same way", count: 4,
    answer: '{"1":{"keepall":true}}', keep: [1],
    carry: [2, 3, 4], codes: ["missing-index", "missing-index", "missing-index"], settled: [1] },
  { name: "an answered row of every action is settled", count: 3,
    answer: '{"1":{"keepall":true},"2":{"forgetall":"old log"},'
      + '"3":{"keeplines":[[1,2],"kept the header"]}}',
    carry: [], codes: [], settled: [1, 2, 3] },
];

test("carry selection — one row per answer shape", () => {
  for (const row of CARRY_ROWS) {
    const rows = rowsOf(row.count);
    const parsed = outcomesOf(rows, row.answer);
    const outcomes = row.keep === undefined ? parsed
      : parsed.filter(outcome => row.keep!.includes(outcome.index));
    const plan = planCarryOver(rows, outcomes);
    assert.deepEqual(indexesOf(plan.carry), row.carry, `row: ${row.name} — the carried indexes`);
    assert.deepEqual(plan.carry.map(entry => entry.code), row.codes, `row: ${row.name} — the codes`);
    assert.deepEqual(plan.carry.map(entry => entry.unitId),
      row.carry.map(index => rows[index - 1]!.unit.id), `row: ${row.name} — the units`);
    assert.deepEqual(plan.final, [], `row: ${row.name} — a first table finalizes nothing`);
    assert.deepEqual(plan.table, rows, `row: ${row.name} — the table is unchanged`);
    for (const index of row.settled) {
      assert.equal(plan.carry.some(entry => entry.index === index), false,
        `row: ${row.name} — a settled row ${String(index)} is never carried`);
    }
  }
});

// --- the re-ask budget ------------------------------------------------------

/**
 * One re-ask, decided by the second table: a failure that becomes final with
 * attempt 2's own code, a row that answers on the re-ask, and an explicit
 * `roundsLeft` that models one extra round.
 */
const REASK_ROWS: readonly {
  name: string;
  count: number;
  firstAnswer: string;
  firstCarry: readonly number[];
  second: (rows: readonly PruneAskRow[]) => readonly PruneAnswerRow[];
  options: { readonly attempt: number; readonly roundsLeft?: number };
  secondCarry: readonly number[];
  secondFinal: readonly number[];
  secondCodes: readonly string[];
  /** The two-table pass totals this row produces. */
  totals: { readonly tables: number; readonly carried: number;
    readonly reasked: number; readonly finalRefusals: number; readonly deferred: number };
}[] = [
  { name: "a second failure is final with attempt 2's own code", count: 3,
    firstAnswer: '{"1":{"keepall":true}}', firstCarry: [2, 3],
    second: rows => [
      { index: 2, unitId: rows[1]!.unit.id, status: "refused", code: "malformed-row",
        message: "bad row", wireCode: "invalid-keepall" },
      { index: 3, unitId: rows[2]!.unit.id, status: "refused", code: "answer-not-an-object",
        message: "not an object", wireCode: null },
    ],
    options: { attempt: 2 },
    secondCarry: [], secondFinal: [2, 3],
    secondCodes: ["malformed-row", "answer-not-an-object"],
    totals: { tables: 2, carried: 2, reasked: 2, finalRefusals: 2, deferred: 0 } },
  { name: "a row that answers on the re-ask is settled", count: 2,
    firstAnswer: "{}", firstCarry: [1, 2],
    second: rows => outcomesOf(rows, '{"1":{"forgetall":"stale"},"2":{"keepall":true}}'),
    options: { attempt: 2 },
    secondCarry: [], secondFinal: [], secondCodes: [],
    totals: { tables: 2, carried: 2, reasked: 2, finalRefusals: 0, deferred: 0 } },
  { name: "an explicit roundsLeft models one extra round", count: 3,
    firstAnswer: '{"1":{"keepall":true}}', firstCarry: [2, 3],
    second: rows => outcomesOf(rows, '{"2":{"keepall":true}}'),
    options: { attempt: 2, roundsLeft: 1 },
    secondCarry: [3], secondFinal: [], secondCodes: [],
    totals: { tables: 2, carried: 3, reasked: 2, finalRefusals: 0, deferred: 0 } },
];

test("the re-ask budget — one row per second-table outcome", () => {
  for (const row of REASK_ROWS) {
    const rows = rowsOf(row.count);
    const first = planCarryOver(rows, outcomesOf(rows, row.firstAnswer));
    assert.deepEqual(indexesOf(first.carry), row.firstCarry, `row: ${row.name} — the first table`);

    const second = planCarryOver(first.carry.map(entry => entry.row), row.second(rows), row.options);
    assert.deepEqual(indexesOf(second.carry), row.secondCarry,
      `row: ${row.name} — the second table's carry`);
    assert.deepEqual(indexesOf(second.final), row.secondFinal,
      `row: ${row.name} — the second table's final rows`);
    assert.deepEqual(second.final.map(entry => entry.code), row.secondCodes,
      `row: ${row.name} — the last attempt's code is what gets recorded`);
    for (const entry of second.final) {
      assert.equal(entry.attempt, 2, `row: ${row.name} — a final row names attempt 2`);
    }
    assert.deepEqual(summarizePassAttempts([first, second], row.totals.tables), row.totals,
      `row: ${row.name} — the pass totals for these two tables`);
  }
});

// --- the table summary ------------------------------------------------------

test("the table attempt counts units, answers and refusals by code", () => {
  const rows = rowsOf(4);
  const outcomes = outcomesOf(rows, '{"1":{"keepall":true},"2":{"forgetall":"x"},'
    + '"3":{"keepall":"yes"}}');
  const summary = summarizeTableAttempt(rows, outcomes, 2);
  assert.deepEqual(summary, {
    tableUnits: 4,
    attempt: 2,
    answered: 2,
    refusedByCode: {
      "missing-index": 1, "duplicate-index": 0, "malformed-row": 1,
      "answer-not-an-object": 0, "answer-unreadable": 0,
      "action-not-in-grammar": 0, "spans-outside-result": 0,
    },
  }, "row: four units, two answers, one missing and one malformed");
  assert.deepEqual(Object.keys(summary.refusedByCode).sort(),
    [...PRUNE_ANSWER_REFUSAL_CODES].sort(), "row: every refusal code is counted, none invented");
  // An outcome naming an index this table never asked cannot inflate the counts.
  const stray = summarizeTableAttempt(rows, [
    ...outcomes,
    { index: 99, unitId: "other", status: "refused", code: "malformed-row",
      message: "stray", wireCode: null },
  ], 2);
  assert.deepEqual(stray, summary, "row: a stray index cannot inflate the counts");
});

// --- the pass totals --------------------------------------------------------

/**
 * One pass per row. The tables count is the loop's, not the settled plans': a
 * table that mixes a carried re-ask with fresh rows is still ONE table, and a
 * pass cut short still counts the table it sent.
 */
const PASS_ROWS: readonly {
  name: string;
  plans: () => readonly PruneCarryOverPlan[];
  tables: number;
  expect: { readonly tables: number; readonly carried: number;
    readonly reasked: number; readonly finalRefusals: number; readonly deferred: number };
}[] = (() => {
  const first = (): PruneCarryOverPlan => {
    const rows = rowsOf(3);
    return planCarryOver(rows, outcomesOf(rows, '{"1":{"keepall":true}}'));
  };
  const second = (): PruneCarryOverPlan => {
    const rows = rowsOf(3);
    const opening = planCarryOver(rows, outcomesOf(rows, '{"1":{"keepall":true}}'));
    return planCarryOver(opening.carry.map(entry => entry.row),
      outcomesOf(rows, '{"2":{"keepall":true}}'), { attempt: 2 });
  };
  return [
    { name: "two tables, both fails final", plans: () => [first(), second()], tables: 2,
      expect: { tables: 2, carried: 2, reasked: 2, finalRefusals: 1, deferred: 0 } },
    { name: "no table loop", plans: () => [], tables: 0,
      expect: { tables: 0, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 } },
    { name: "a pass cut short still counts the table it sent", plans: () => [first()], tables: 1,
      expect: { tables: 1, carried: 2, reasked: 0, finalRefusals: 0, deferred: 0 } },
    { name: "a mixed table with fresh rows is still one table", plans: () => {
      // CRITIC-022 P2 #4: one table settles one plan per attempt group. Counting
      // plans reported 2 here and inflated every mixed pass's tuning number.
      const rows = rowsOf(3);
      const mixed = planCarryOver([{ ...rows[0]!, index: 1 }, { ...rows[1]!, index: 2 }],
        outcomesOf(rows, '{"1":{"keepall":true},"2":{"keepall":true}}'), { attempt: 2 });
      const fresh = planCarryOver([{ ...rows[2]!, index: 3 }],
        outcomesOf(rows, '{"3":{"keepall":true}}'), { attempt: 1 });
      return [mixed, fresh];
    }, tables: 2, expect: { tables: 2, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 } },
  ];
})();

test("the pass totals — one row per table loop", () => {
  for (const row of PASS_ROWS) {
    assert.deepEqual(summarizePassAttempts(row.plans(), row.tables), row.expect,
      `row: ${row.name}`);
  }
  // A table count that is not a non-negative safe integer is a caller bug.
  for (const bad of [-1, 1.5]) {
    assert.throws(() => summarizePassAttempts([], bad), RangeError, `tables: ${String(bad)}`);
  }
});

// --- a halted table ---------------------------------------------------------

/**
 * ISSUE-177. A halt means no answer came back at all, so there is no refusal
 * to name: every row is DEFERRED. The old reading put them in `final` under the
 * parser's `answer-unreadable`, which every count reads as "decided".
 */
const HALTED_ROWS: readonly {
  name: string;
  count: number;
  options: { readonly attempt: number } | undefined;
  deferred: readonly number[];
}[] = [
  { name: "a halt at attempt 1 defers the whole table", count: 3,
    options: undefined, deferred: [1, 2, 3] },
  { name: "a halt at attempt 2 defers too, never finalizes", count: 2,
    options: { attempt: 2 }, deferred: [1, 2] },
];

test("a halted table defers its rows and finalizes none", () => {
  for (const row of HALTED_ROWS) {
    const rows = rowsOf(row.count);
    const plan = planCarryOver(rows, [], { halted: true, ...row.options });
    assert.deepEqual(indexesOf(plan.deferred ?? []), row.deferred,
      `row: ${row.name} — every row of the halted table is deferred`);
    assert.deepEqual(plan.final, [],
      `row: ${row.name} — nothing is final: no answer was read, so nothing was decided`);
    assert.deepEqual(plan.carry, [],
      `row: ${row.name} — a halt carries nothing; the next table never comes`);
    for (const entry of plan.deferred) {
      assert.equal('code' in entry, false,
        `row: ${row.name} — a deferral invents no refusal code`);
      assert.equal(entry.attempt, (row.options?.attempt ?? 1) + 1,
        `row: ${row.name} — a deferral names the attempt it would have taken`);
    }
  }
  // The pass totals keep the two apart: a deferred row is not a final refusal.
  const rows = rowsOf(3);
  const plan = planCarryOver(rows, [], { halted: true });
  assert.deepEqual(summarizePassAttempts([plan], 1),
    { tables: 1, carried: 0, reasked: 0, finalRefusals: 0, deferred: 3 },
    "the pass totals count the deferral and no final refusal");
});

// --- where and at what cost they land ---------------------------------------

/**
 * A carried row goes to the FRONT of the next table, in table order, and costs
 * one of its twelve unit slots. Two table sizes, so the slot arithmetic is not
 * pinned to one number.
 */
const PLACEMENT_ROWS: readonly {
  name: string;
  count: number;
  answer: string;
  carry: readonly number[];
}[] = [
  { name: "five rows with two answered", count: 5,
    answer: '{"2":{"keepall":true},"4":{"keepall":true}}', carry: [1, 3, 5] },
  { name: "ten rows with eight answered", count: 10,
    answer: '{"1":{"keepall":true},"2":{"keepall":true},"3":{"keepall":true},'
      + '"4":{"keepall":true},"5":{"keepall":true},"6":{"keepall":true},'
      + '"7":{"keepall":true},"8":{"keepall":true}}', carry: [9, 10] },
];

test("carried rows keep table order and lead the next table", () => {
  for (const row of PLACEMENT_ROWS) {
    const rows = rowsOf(row.count);
    const plan = planCarryOver(rows, outcomesOf(rows, row.answer));
    assert.deepEqual(indexesOf(plan.carry), row.carry, `row: ${row.name} — table order is kept`);
    const entries: readonly PruneCarryEntry[] = plan.carry;
    for (const entry of entries) {
      assert.equal(entry.placement, "front", `row: ${row.name} — placement`);
      assert.equal(entry.attempt, 2, `row: ${row.name} — the entry names the next attempt`);
    }
    // Front placement is a prefix of the next table: carrying changes no order.
    const nextTable = [...entries.map(entry => entry.row), ...rowsOf(2)];
    assert.deepEqual(nextTable.slice(0, entries.length).map(entry => entry.index), row.carry,
      `row: ${row.name} — the carried rows are the next table's prefix`);
  }
});

test("action-not-in-grammar is final on the first pass: a terminal keep spends no re-ask", () => {
  const rows = rowsOf(1);
  const row = rows[0]!;
  const outcome: PruneAnswerRow = {
    index: row.index, unitId: row.unit.id, status: "refused",
    code: "action-not-in-grammar", message: "the grammar does not offer that action",
    wireCode: null,
  };
  const plan = planCarryOver(rows, [outcome], { roundsLeft: 1 });
  assert.deepEqual(plan.carry, [], "a terminal refusal is never carried");
  assert.deepEqual(plan.final.map(entry => [entry.index, entry.code]),
    [[row.index, "action-not-in-grammar"]], "it is final on the first attempt");
});
