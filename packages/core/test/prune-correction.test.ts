/**
 * The big prune's one correction turn's bytes (ISSUE-113).
 *
 * The owner approved the message on 2026-10-29 with its variable parts marked,
 * so this file pins two things at once: the fixed text is the approved text byte
 * for byte, and every marked part is filled from real data — the graded answer's
 * counts and codes, the pass's own rows, one real composite example, and the
 * table ask's own closing line.
 *
 * The row block is the shipped renderer's (`renderPruneAskRows`), not a second
 * format: a re-asked row carries the index it already had and the same anchor
 * bytes, so the model never meets a second address scheme.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PruneAskRow } from "../src/prune/ask.js";
import { PRUNE_CORRECTION_COMPOSITE, pruneCorrectionMessage } from "../src/prune/correction-message.js";
import { parsePruneAnswer } from "../src/prune/ask-answer.js";
import type { WireStamp } from "../src/verdicts/wire.js";
import { PRUNE_ASK_FINAL_LINE, PRUNE_ASK_NOKEEPALL_FINAL_LINE, renderPruneAskRows } from "../src/prune/ask-message.js";
import type { PruneAnchorResult } from "../src/prune/anchor.js";
import type { ProcessingUnit } from "../src/units/types.js";

/** A row with a real anchor line, built the way a pass builds one. */
function rowOf(index: number, anchorText: string | null, path = "server.ts"): PruneAskRow {
  const anchor: PruneAnchorResult = {
    kind: "Edit", path, callOrdinal: 1,
    // No quotable line is the renderer's "the row ends at the call" case.
    anchors: anchorText === null ? [] : [anchorText],
  };
  const unit: ProcessingUnit = {
    id: `unit:${String(index)}`,
    nodeId: `dsh:s1:result:c${String(index)}`,
    source: { nodeId: `dsh:s1:result:c${String(index)}`, sha256: "sha", byteLength: 10 },
    path,
    span: { byteRange: { startByte: 0, endByteExclusive: 10 },
      lineRange: { startLine: 1, endLineInclusive: 2 } },
    byteLength: 10,
  };
  return { index, unit, anchor };
}

/** One refused row and a second one, at the indices the approved text used. */
const ROW_3 = rowOf(3, 'line 88 of 140 ends with "return null; // TODO"');
const ROW_5 = rowOf(5, null, "config.ts");

type DetailCode = Parameters<typeof pruneCorrectionMessage>[0]["reasons"][number]["code"];

/**
 * The approved text with only its marked slots filled: ten lines kept, five
 * marked parts filled. Comparing whole lines (not a substring) is what makes a
 * reworded fixed sentence fail.
 */
const APPROVED = [
  "Your previous answer could not be applied for 2 of 5 rows: index 3 appeared twice; "
    + "index 5 had no verdict. Those units are kept so far. This turn asks those rows only; "
    + "the rows you answered are accepted — do not answer them again.",
  "",
  // The refused rows, through the shipped renderer: same indices, same format.
  '3. [Edit] server.ts (call #1) — line 88 of 140 ends with "return null; // TODO"',
  "5. [Edit] config.ts (call #1)",
  "",
  "Answer again, once, with exactly one JSON object, one key per row above, same indices:",
  "",
  // ISSUE-326: the refused rows here ARE the static example's indices (3 and
  // 5), so the example ships re-keyed past the table's last index (5): a
  // verbatim echo earns out-of-range rejections, never verdicts for real rows.
  '{"6":{"keeplines":[[88,95],"the TODO block superseded by the later edit"]},'
    + '"7":{"forgetall":"a stale config grep"}}',
  "",
  "keeplines keeps the named ranges (1-based, counted on that unit's own lines); the rest is "
    + "replaced by a required summary, a few words, aim under 15, never over 25. forgetall "
    + "replaces the whole unit with its summary. A missing, unknown or repeated key refuses "
    + "that unit, and a refused unit keeps.",
  "",
  `Answer with one JSON object for the rows above and nothing else. ${PRUNE_ASK_FINAL_LINE}`,
].join("\n");

/** The first line of a correction built from one refused row at one code. */
const firstLine = (code: DetailCode): string =>
  pruneCorrectionMessage({ refused: [ROW_3], totalRows: 3,
    reasons: [{ index: 3, code }] }).split("\n")[0] ?? "";

/**
 * One row per reason code. The parser's messages are the vocabulary: a reason
 * the model cannot map to what it wrote is no better than no reason, so each
 * code's own clause is pinned here by the code that names it.
 */
const REASON_ROWS: readonly (readonly [string, DetailCode, string])[] = [
  ["missing-index", "missing-index", "index 3 had no verdict"],
  ["duplicate-index", "duplicate-index", "index 3 appeared twice"],
  ["malformed-row", "malformed-row", "index 3 is not a readable verdict"],
  ["answer-unreadable", "answer-unreadable", "the answer was not readable JSON"],
  ["answer-not-an-object", "answer-not-an-object", "the answer was not one JSON object"],
];

test("a verbatim echo of the correction example never answers a refused row (ISSUE-326)", () => {
  // The canonical ISSUE-113 case: the refused rows ARE the static example's
  // indices (3 and 5). A model echoing the example verbatim must not hand real
  // rows real verdicts — every refused unit keeps.
  const message = pruneCorrectionMessage({
    refused: [ROW_3, ROW_5], totalRows: 5,
    reasons: [{ index: 3, code: "duplicate-index" }, { index: 5, code: "missing-index" }],
  });
  const example = message.split("\n").find(line => line.startsWith('{"'));
  assert.equal(typeof example, "string", "the correction ships one composite example line");
  const stamps = new Map<number, WireStamp>([
    [3, { unitId: "unit:3", answeredInRound: 1 }],
    [5, { unitId: "unit:5", answeredInRound: 1 }],
  ]);
  const parsed = parsePruneAnswer(example, { indices: [3, 5], stamps });
  assert.deepEqual(parsed.rows.map(row => row.status), ["refused", "refused"],
    "the echo answers no refused row; both units keep");
  // Without a collision the approved static bytes still ship unchanged.
  const noCollision = pruneCorrectionMessage({
    refused: [rowOf(2, null), rowOf(4, null)], totalRows: 5,
    reasons: [{ index: 2, code: "missing-index" }, { index: 4, code: "missing-index" }],
  });
  assert.equal(noCollision.split("\n").includes(PRUNE_CORRECTION_COMPOSITE), true,
    "the static example ships when no refused row carries its indices");
});

test("the nokeepall correction speaks the table's line-per-row grammar (ISSUE-508 F3)", () => {
  const message = pruneCorrectionMessage({
    refused: [ROW_3, ROW_5], totalRows: 5,
    reasons: [{ index: 3, code: "missing-index" }, { index: 5, code: "duplicate-index" }],
    grammar: "nokeepall",
  });
  const rowLines = message.split("\n").filter(line => /^\d+\. /u.test(line));
  assert.deepEqual(rowLines.map(line => / \[2 lines\]$/u.test(line)),
    [true, true], "each re-rendered row carries its own L");
  // One grammar per pass: the answer shapes are the jsonl-20 ones, not the
  // shipped index-keyed composite.
  assert.equal(message.includes('{"N":{"forgetall":true,"summary":"<summary>"}}'), true,
    "the one-object-per-line forgetall shape is stated");
  assert.equal(message.includes('{"N":{"keeplines":[[start,end], ...],"summary":"<summary>"}}'), true,
    "the one-object-per-line keeplines shape is stated");
  assert.equal(message.includes(PRUNE_CORRECTION_COMPOSITE), false,
    "the index-keyed composite example is not sent under this grammar");
  // No share line: a correction re-asks rows already refused.
  assert.equal(message.includes("keep at most"), false, "no keep-share target is restated");
  // And no 3option bytes anywhere.
  assert.equal(message.includes(PRUNE_ASK_FINAL_LINE), false);
  assert.equal(message.includes(PRUNE_ASK_NOKEEPALL_FINAL_LINE), false);
});

test("the finer line codes reach the correction's reason clause (ISSUE-508 F4)", () => {
  const message = pruneCorrectionMessage({
    refused: [ROW_3], totalRows: 5,
    reasons: [{ index: 3, code: "malformed-row", detail: "summary-too-long" }],
    grammar: "nokeepall",
  });
  const first = message.split("\n")[0] ?? "";
  assert.equal(first.includes("index 3 carried a summary past 30 words"), true,
    `the finer defect is named, got ${first}`);
  assert.equal(first.includes("is not a readable verdict"), false,
    "the collapsed code's generic clause is not used when the detail is known");
});

test("the approved text — one row per reason code, plus the whole-message pin", () => {
  const actual = pruneCorrectionMessage({
    refused: [ROW_3, ROW_5],
    totalRows: 5,
    reasons: [{ index: 3, code: "duplicate-index" }, { index: 5, code: "missing-index" }],
  });
  assert.deepEqual(actual.split("\n"), APPROVED.split("\n"),
    "row: the approved text — the message is the approved lines with every marked slot filled");
  for (const [name, code, clause] of REASON_ROWS) {
    assert.equal(firstLine(code).includes(clause), true,
      `row: reason ${name} — the first line names the code with the parser's own wording, got ${firstLine(code)}`);
  }
  // The two whole-answer codes name the answer, not a row, and appear ONCE
  // even when every row of the table refused for that one reason.
  const whole = pruneCorrectionMessage({
    refused: [ROW_3, ROW_5], totalRows: 2,
    reasons: [{ index: 3, code: "answer-unreadable" }, { index: 5, code: "answer-unreadable" }],
  }).split("\n")[0] ?? "";
  assert.equal(whole.includes("2 of 2 rows: the answer was not readable JSON."), true,
    `row: reason answer-unreadable — the whole-answer reason counts rows, got ${whole}`);
  assert.equal(whole.split("the answer was not readable JSON").length - 1, 1,
    "row: reason answer-unreadable — the whole-answer reason is stated once, not once per row");
});

/**
 * One row per structural rule the message owes: which rows it carries, in what
 * order, and which caller mistakes it refuses. The composite example and the
 * caller-bug guards live in this table because all three are about the message's
 * SHAPE, not its fixed text — the text pin above would stay green through a
 * wrong row order or an accepted empty refusal.
 */
const SHAPE_ROWS: readonly (readonly [string, () => void])[] = [
  ["the refused rows only, in table order, and no other row", () => {
    const name = "the refused rows only, in table order, and no other row";
    // Order is the pass's own, never the refusal map's: the model reads the same
    // order it will answer in.
    const message = pruneCorrectionMessage({
      refused: [ROW_5, ROW_3], totalRows: 7,
      reasons: [{ index: 5, code: "missing-index" }, { index: 3, code: "malformed-row" }],
    });
    assert.equal(message.includes(renderPruneAskRows([ROW_5, ROW_3])), true,
      `row: ${name} — the rows are the shipped renderer's own bytes`);
    const rowLines = message.split("\n").filter(line => /^\d+\. /u.test(line));
    assert.deepEqual(rowLines, ["5. [Edit] config.ts (call #1)",
      '3. [Edit] server.ts (call #1) — line 88 of 140 ends with "return null; // TODO"'],
      `row: ${name} — the rows appear in the caller's order, one line each`);
    // It restates no history and no accepted row: the only lines beginning with
    // an index are the refused rows' own.
    assert.equal(message.includes("1. ["), false,
      `row: ${name} — no accepted row is restated`);
  }],
  ["the composite example is the approved static one and a real parseable pair", () => {
    const name = "the composite example is the approved static one and a real parseable pair";
    // Static by the owner's allowance; a model copying these indices onto other
    // rows earns `unknown key`, which refuses and keeps. Its two answers are
    // whole verdicts in the shapes the shipped table prompt teaches.
    assert.equal(PRUNE_CORRECTION_COMPOSITE,
      '{"3":{"keeplines":[[88,95],"the TODO block superseded by the later edit"]},'
        + '"5":{"forgetall":"a stale config grep"}}',
      `row: ${name} — the example's bytes are the approved ones`);
    const parsed = JSON.parse(PRUNE_CORRECTION_COMPOSITE) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["3", "5"],
      `row: ${name} — the example keys are the indices the approved text used`);
    assert.deepEqual(Object.keys(parsed["3"] as object), ["keeplines"],
      `row: ${name} — index 3 shows the keeplines shape`);
    assert.deepEqual(Object.keys(parsed["5"] as object), ["forgetall"],
      `row: ${name} — index 5 shows the forgetall shape`);
  }],
  ["no refused row is a caller bug", () => {
    assert.throws(() => pruneCorrectionMessage({
      refused: [], totalRows: 3, reasons: [],
    }), /at least one refused row/u,
    "row: no refused row is a caller bug — an empty correction is refused by name");
  }],
  ["a refused row with no reason is a caller bug", () => {
    assert.throws(() => pruneCorrectionMessage({
      refused: [ROW_3], totalRows: 1, reasons: [],
    }), /No refusal reason for refused index 3/u,
    "row: a refused row with no reason is a caller bug — the missing reason is named");
  }],
  ["a table size that is not a safe integer is a caller bug", () => {
    assert.throws(() => pruneCorrectionMessage({
      refused: [ROW_3], totalRows: 0, reasons: [{ index: 3, code: "missing-index" }],
    }), /totalRows must be a safe integer/u,
    "row: a table size that is not a safe integer is a caller bug — the size is named");
  }],
];

test("the correction's shape — one row per structural rule", () => {
  for (const [name, run] of SHAPE_ROWS) {
    try { run(); } catch (error) {
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error });
    }
  }
});
