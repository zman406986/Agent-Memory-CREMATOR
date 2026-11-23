/**
 * The `jsonl-20` entry grammar (ISSUE-143; shipped by ISSUE-183; ADR-0040).
 *
 * Three claims, each where it can fail:
 *
 *   1. the shipped prompt, slot and repeat are the SIMULATOR'S version-2 bytes,
 *      not a paraphrase — the last check imports the sim module itself and
 *      compares the assembled asks, so a reflow on either side is red;
 *   2. the batch ask is the three-piece layout — pre-table prompt, the table with
 *      each row's `[N line(s)]`, then the repeat — and the table lands literally
 *      even when it carries `$&` or `` $` `` (ISSUE-172);
 *   3. the reader answers the prompt's own four-row example and refuses every
 *      bad shape under its own code, one row at a time.
 *
 * The unchanged-grammar group pins `3option` and `two-option` to their shipped
 * bytes and behaviour, so the default flip cannot move either by accident.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  entryAskMessage, ENTRY_ASK_END_ANCHOR, PRUNE_ASK_JSONL_20_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_REPEAT,
  PRUNE_ASK_JSONL_20_SLOT, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT,
  PRUNE_ASK_SYSTEM_PROMPT, PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT,
} from "../src/rules/assets.js";
import {
  ENTRY_ASK_GRAMMAR_REFUSAL_CODE, entryBatchAskMessage, parseEntryBatchAnswer,
} from "../src/entry/batch-ask.js";
import type { EntryBatchRow } from "../src/entry/batch-ask.js";
import {
  JSONL_20_REFUSAL_CODES, JSONL_20_SUMMARY_WORDS, jsonl20RejectionsOf, readJsonl20Answer,
  readJsonl20NoKeepallAnswer,
} from "../src/entry/jsonl-20-answer.js";
import type { Jsonl20RowResult } from "../src/entry/jsonl-20-answer.js";

/**
 * The first trigger's share line, verbatim; it appears once before the table and
 * once after, in these same bytes (ISSUE-194).
 */
const FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/** The later trigger's share line, verbatim; every fire after the first (ISSUE-194). */
const LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/**
 * The sim's pre-table prompt, copied line for line from
 * `dev/sim/sim-batch-grammar.mjs`. This is an independent expectation: the
 * production asset must equal it, never be re-derived from it.
 */
const PINNED_PRE_TABLE = [
  "Memory management: decide which tool results below stay in your memory. Forgotten ones are "
    + "purged, but can be restored later with a memory tool. Answer for every result in the table: "
    + "each row starts with the index you answer with, then the call that produced it, then quotes "
    + "from its own lines.",
  "",
  "Answer with one JSON object per row, one per line, and nothing else: no array, no commas "
    + "between lines, no markdown, no commentary. The key is that row's index as a string; the "
    + "value is that row's verdict, an object with exactly one action key.",
  "",
  "Rules:",
  "1. One object per line. One row per object. Nothing else on the line.",
  "2. Exactly one action key per row: keepall, forgetall, or keeplines.",
  "3. keepall carries nothing else. forgetall and keeplines must also carry forgotten: what is "
    + "being dropped and why.",
  "4. forgetall forgets the whole row. keeplines keeps the listed lines and forgets every line "
    + "not listed.",
  "5. keeplines is an ascending array of non-overlapping [start,end] pairs, integers, inside 1..L, "
    + "where L is that row's line count shown in the table.",
  "6. forgotten is one line of plain text, less than 20 words. It names what is being dropped and "
    + "why, so it can be recalled. It never describes the lines you keep. Use no raw newline. "
    + "Escape a double quote as \\\".",
  "7. Every row in the table appears exactly once. Add no other rows, keys, or text.",
  "8. Before sending, check each line: one object, one action key, forgotten present when "
    + "forgetting, ranges ascending and inside the row, and each line parses as JSON on its own.",
  "",
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  FIRST_TARGET,
  "",
  "<rows: the table, one line per unit, each beginning with its index>",
].join("\n");

/** The sim's post-table repeat for the first trigger, copied line for line. */
const PINNED_REPEAT = [
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  FIRST_TARGET,
  "",
  ENTRY_ASK_END_ANCHOR,
].join("\n");

/** The first-trigger pre-table prompt with the table slot replaced by a table. */
function preTableWith(target: string, table: string): string {
  return PINNED_PRE_TABLE.replace(FIRST_TARGET, target).replace(
    "<rows: the table, one line per unit, each beginning with its index>", table);
}

/** One batch row; the shape the mount hands the core. */
function row(index: number, call: string, anchorLines: readonly string[],
  lineCount: number): EntryBatchRow {
  return { index, call, anchorLines, lineCount };
}

const FOUR_ROWS: readonly EntryBatchRow[] = [
  row(1, "Read a.ts", [], 1),
  row(2, "Read b.ts", [], 24),
  row(3, "Read a.ts", [], 1),
  row(4, "Bash npm test", [], 12),
];

/** The sim module's shape, as this test reads it. */
interface SimGrammarModule {
  readonly ASK_GRAMMAR_PROMPTS: Readonly<Record<string, string>>;
  readonly JSONL_20_SLOT: string;
  readonly JSONL_20_VARIANTS: Readonly<Record<"first" | "later",
    { readonly prompt: string; readonly repeat: string }>>;
  readonly askMessageForRows: (rows: readonly EntryBatchRow[], grammar?: string,
    order?: string, firstTrigger?: boolean) => string;
  readonly jsonl20RowsOf: (
    text: string,
    indices: readonly number[],
    lineCounts?: ReadonlyMap<number, number>,
  ) => readonly {
    readonly index: number;
    readonly status: "answered" | "refused";
    readonly code?: string;
  }[];
  readonly jsonl20RejectionsOf: (
    text: string,
    indices: readonly number[],
    lineCounts?: ReadonlyMap<number, number>,
  ) => readonly { readonly key: string; readonly index: number | null; readonly code: string }[];
}

/** The sim's own module, loaded for the byte-equality check at the bottom. */
async function simGrammar(): Promise<SimGrammarModule> {
  const url = new URL("../../../dev/sim/sim-batch-grammar.mjs", import.meta.url).href;
  return await import(url) as SimGrammarModule;
}

test("jsonl-20 ships the sim's first-trigger prompt, slot and repeat byte for byte", async () => {
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT, PINNED_PRE_TABLE,
    "the pre-table prompt is the pinned text");
  assert.equal(PRUNE_ASK_JSONL_20_REPEAT, PINNED_REPEAT,
    "the post-table repeat is the pinned text");
  assert.equal(PRUNE_ASK_JSONL_20_SLOT,
    "<rows: the table, one line per unit, each beginning with its index>",
    "the slot is the literal the table replaces");
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.endsWith(`\n\n${FIRST_TARGET}\n\n${PRUNE_ASK_JSONL_20_SLOT}`),
    true, "the first trigger's share line is the last line before the slot");
  assert.equal(PRUNE_ASK_JSONL_20_REPEAT.endsWith(
    `\n\n${FIRST_TARGET}\n\n${ENTRY_ASK_END_ANCHOR}`),
  true, "the repeat ends on the share line and the closing anchor");
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.includes("less than 20 words"), true,
    "the pre-table prompt asks for under 20 words");
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.split(PRUNE_ASK_JSONL_20_SLOT).length - 1, 1,
    "exactly one table slot");
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.includes("Answer format:"), true,
    "the pre-table prompt teaches the answer format too");
  assert.equal(PRUNE_ASK_JSONL_20_REPEAT.includes(ENTRY_ASK_END_ANCHOR), true,
    "the repeat carries the entry anchor inline");
  // The sim itself, not a second copy of its source: the prompt's bytes and the
  // assembled ask (prompt + table + repeat) must both be equal.
  const sim = await simGrammar();
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT, sim.ASK_GRAMMAR_PROMPTS["jsonl-20"],
    "the product prompt equals the sim's own assembled prompt");
  assert.equal(PRUNE_ASK_JSONL_20_SLOT, sim.JSONL_20_SLOT,
    "the product slot equals the sim's slot");
  const comparison: readonly EntryBatchRow[] = [
    row(1, "Read a.ts", ['line 2 of 4 ends with "retry once"'], 4),
  ];
  assert.equal(entryBatchAskMessage(comparison, "jsonl-20"),
    sim.askMessageForRows(comparison, "jsonl-20"),
    "the product's full ask equals the sim's full ask, row, table and repeat included");
});

test("jsonl-20 ships the sim's later-trigger prompt and repeat byte for byte", async () => {
  assert.equal(PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, preTableWith(LATER_TARGET,
    "<rows: the table, one line per unit, each beginning with its index>"),
  "the later pre-table prompt is the first trigger's, with only the share line replaced");
  assert.equal(PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT.endsWith(
    `\n\n${LATER_TARGET}\n\n${PRUNE_ASK_JSONL_20_SLOT}`),
  true, "the 40 percent line is the last line before the slot");
  assert.equal(PRUNE_ASK_JSONL_20_LATER_REPEAT.endsWith(
    `\n\n${LATER_TARGET}\n\n${ENTRY_ASK_END_ANCHOR}`),
  true, "the later repeat ends on the 40 percent line and the anchor");
  // One line differs, in both halves: the two prompts are otherwise identical.
  assert.equal(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.replace(FIRST_TARGET, LATER_TARGET),
    PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, "the pre-table halves differ only in the share line");
  assert.equal(PRUNE_ASK_JSONL_20_REPEAT.replace(FIRST_TARGET, LATER_TARGET),
    PRUNE_ASK_JSONL_20_LATER_REPEAT, "the repeats differ only in the share line");
  assert.notEqual(FIRST_TARGET, LATER_TARGET, "the two share lines are not the same bytes");
  assert.equal(PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT.includes(FIRST_TARGET), false,
    "a later-trigger prompt never carries the first trigger's line");
  const sim = await simGrammar();
  assert.equal(PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, sim.JSONL_20_VARIANTS.later.prompt,
    "the product later prompt equals the sim's own");
  assert.equal(PRUNE_ASK_JSONL_20_LATER_REPEAT, sim.JSONL_20_VARIANTS.later.repeat,
    "the product later repeat equals the sim's own");
  const comparison: readonly EntryBatchRow[] = [
    row(1, "Read a.ts", ['line 2 of 4 ends with "retry once"'], 4),
    row(2, "Bash npm test", [], 12),
  ];
  assert.equal(entryBatchAskMessage(comparison, "jsonl-20", false),
    sim.askMessageForRows(comparison, "jsonl-20", "first", false),
    "the product's later-trigger ask equals the sim's, row, table and repeat included");
  assert.equal(entryBatchAskMessage(comparison, "jsonl-20", true),
    sim.askMessageForRows(comparison, "jsonl-20", "first", true),
    "the product's first-trigger ask equals the sim's, row, table and repeat included");
  assert.notEqual(entryBatchAskMessage(comparison, "jsonl-20", true),
    entryBatchAskMessage(comparison, "jsonl-20", false),
    "the flag moves the ask's bytes");
});

test("jsonl-20's product reader and the sim's reader classify the same malformed answers identically", async () => {
  // Every row is classified by both readers, and the classifications must be
  // equal: the sim is the study's measuring instrument, so a disagreement here
  // means the sim no longer measures what ships. ISSUE-187 moved both to the
  // per-row rule; this test is what keeps them from drifting apart again.
  const sim = await simGrammar();
  const indices25 = Array.from({ length: 25 }, (_, at) => at + 1);
  const cases: readonly {
    readonly name: string;
    readonly text: string;
    readonly indices: readonly number[];
    readonly lineCounts?: ReadonlyMap<number, number>;
  }[] = [
    {
      name: "the live 25-row answer with one stray-key line",
      text: indices25.map(index => (index === 2
        ? '{"2":{"forgetall":true,"summary":"stale build log"},"keepall":false}'
        : `{"${String(index)}":{"keepall":true}}`)).join("\n"),
      indices: indices25,
    },
    {
      name: "a non-JSON line that names no row",
      text: '{"1":{"keepall":true}}\nnot json\n{"2":{"keepall":true}}',
      indices: [1, 2],
    },
    {
      name: "a non-JSON line that still spells the row it was meant for",
      text: '{"1":{"keepall":true}}\n{"2":{"keepall":true}\n{"3":{"keepall":true}}',
      indices: [1, 2, 3],
    },
    {
      name: "one line naming two rows",
      text: '{"1":{"keepall":true},"2":{"keepall":true}}',
      indices: [1, 2],
    },
    {
      name: "one line naming one assigned row and one stranger",
      text: '{"1":{"keepall":true},"9":{"keepall":true}}',
      indices: [1],
    },
    {
      name: "a repeated verdict",
      text: '{"1":{"keepall":true}}\n{"1":{"forgetall":true,"summary":"again"}}',
      indices: [1],
    },
    {
      name: "a repeated index whose second mention is a broken line",
      text: '{"1":{"keepall":true}}\n{"1":{"keepall":true}',
      indices: [1],
    },
    {
      name: "a repeated index whose second mention carries an extra key",
      text: '{"1":{"keepall":true}}\n{"1":{"keepall":true},"2":{"keepall":true}}',
      indices: [1, 2],
    },
    {
      name: "a JSON scalar and an empty object beside a verdict",
      text: '42\n{}\n{"1":{"keepall":true}}',
      indices: [1],
    },
    {
      name: "an unknown key beside a verdict",
      text: '{"9":{"keepall":true}}\n{"1":{"keepall":true}}',
      indices: [1],
    },
    {
      name: "a keeplines pair past the row's own line count",
      text: '{"1":{"keeplines":[[1,11]],"summary":"s"}}',
      indices: [1],
      lineCounts: new Map([[1, 10]]),
    },
    { name: "blank text", text: "   \n\t\n", indices: [1, 2] },
    { name: "prose", text: "I kept everything.", indices: [1, 2] },
    { name: "a lone anchor", text: ENTRY_ASK_END_ANCHOR, indices: [1, 2] },
  ];
  for (const testCase of cases) {
    const lineCounts = testCase.lineCounts ?? new Map<number, number>();
    const product = readJsonl20Answer(testCase.text, testCase.indices, lineCounts);
    assert.deepEqual(
      sim.jsonl20RowsOf(testCase.text, testCase.indices, lineCounts)
        .map(entry => [entry.index, entry.status,
          entry.status === "refused" ? entry.code : null]),
      product.rows.map(entry => [entry.index, entry.status,
        entry.status === "refused" ? entry.code : null]),
      `rows: ${testCase.name}`);
    assert.deepEqual(
      sim.jsonl20RejectionsOf(testCase.text, testCase.indices, lineCounts)
        .map(entry => [entry.key, entry.index, entry.code]),
      product.rejected.map(entry => [entry.key, entry.index, entry.code]),
      `rejections: ${testCase.name}`);
  }
});

test("jsonl-20 renders the pre-table prompt, its counted table, then the repeat", () => {
  const message = entryBatchAskMessage(FOUR_ROWS, "jsonl-20");
  const prefix = PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.slice(
    0, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
  assert.equal(message.startsWith(prefix), true, "every byte before the slot is unchanged");
  assert.equal(message.includes(PRUNE_ASK_JSONL_20_SLOT), false, "the slot is replaced");
  assert.equal(message.endsWith(`\n\n${PRUNE_ASK_JSONL_20_REPEAT}`), true,
    "the repeat follows the table, byte for byte");
  const table = message.slice(prefix.length, message.length
    - `\n\n${PRUNE_ASK_JSONL_20_REPEAT}`.length);
  const lines = table.split("\n");
  assert.equal(lines.length, FOUR_ROWS.length, "one table line per row");
  assert.deepEqual(lines.map(line => line.slice(0, 2)), ["1.", "2.", "3.", "4."],
    "the rows ascend by index");
  assert.match(lines[0] ?? "", / \[1 line\]$/u, "a one-line row says 1 line");
  assert.match(lines[1] ?? "", / \[24 lines\]$/u, "a multi-line row names its count");
  assert.match(lines[3] ?? "", / \[12 lines\]$/u);
  assert.equal(message.split(FIRST_TARGET).length - 1, 2,
    "the first trigger's share line appears twice: before and after the table");
  assert.equal(message.split(ENTRY_ASK_END_ANCHOR).length - 1, 1, "one closing anchor");
  assert.equal(message.includes("This result has"), false,
    "the one-row prose range sentence is never sent under jsonl-20");
});

test("jsonl-20's slot takes a $ -bearing table literally (ISSUE-172)", () => {
  const call = "$& $' $$ $1 $HOME `$`";
  const message = entryBatchAskMessage([row(1, call, [], 9)], "jsonl-20");
  assert.equal(message.includes(`1. [${call}] (call #1) [9 lines]`), true,
    "every dollar token survives verbatim");
  const prefix = PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.slice(
    0, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
  const expected = `${prefix}1. [${call}] (call #1) [9 lines]\n\n${PRUNE_ASK_JSONL_20_REPEAT}`;
  assert.equal(message, expected, "the ask is the literal splice, not an expansion");
});

test("jsonl-20 renders no line-count suffix under any other grammar", () => {
  for (const grammar of ["3option", "two-option"] as const) {
    const message = entryBatchAskMessage(FOUR_ROWS, grammar);
    assert.equal(/ \[\d+ lines?\]$/mu.test(message), false,
      `${grammar}'s table carries no line-count suffix`);
  }
  assert.match(entryBatchAskMessage(FOUR_ROWS), / \[\d+ lines?\]$/mu,
    "the default grammar is jsonl-20, whose rows carry the suffix");
});

test("jsonl-20 answers the prompt's own four-row worked example", () => {
  const examples = PRUNE_ASK_JSONL_20_REPEAT.split("\n")
    .filter(line => line.startsWith('{"') && !line.startsWith('{"N"'));
  assert.equal(examples.length, 4, "the repeat carries the four filled example lines");
  for (const line of examples) JSON.parse(line);
  const text = examples.join("\n");
  const lineCounts = new Map([[3, 40], [4, 40]]);
  const rows = parseEntryBatchAnswer(text, [1, 2, 3, 4], "jsonl-20", lineCounts);
  assert.deepEqual(rows.map(entry => entry.status),
    ["answered", "answered", "answered", "answered"], "every row answers");
  assert.deepEqual(rows.map(entry =>
    entry.status === "answered" ? entry.answer.action : null),
  ["keepall", "forgetall", "keeplines", "keeplines"]);
  assert.deepEqual(rows[1]?.status === "answered" ? rows[1].answer : null,
    { action: "forgetall", summary: "stale build log from the old host" });
  assert.deepEqual(rows[2]?.status === "answered" ? rows[2].answer : null, {
    action: "keeplines",
    ranges: [{ from: 1, to: 3 }, { from: 11, to: 18 }, { from: 37, to: 40 }],
    summary: "the stale build log and the old host block",
  });
  assert.deepEqual(rows[3]?.status === "answered" ? rows[3].answer : null, {
    action: "keeplines",
    ranges: [{ from: 5, to: 12 }],
    summary: "the imports and the stale fixture setup",
  });
});

/** One refusal case: the answer, its indices, its counts and the rows it produces. */
interface RefusalCase {
  readonly name: string;
  readonly text: string;
  readonly indices: readonly number[];
  readonly lineCounts?: ReadonlyMap<number, number>;
  /** One entry per assigned index: status and code (the code is null when answered). */
  readonly expected: readonly (readonly [number, "answered" | "refused", string | null])[];
}

const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    name: "a missing index keeps its own row and answers the others",
    text: '{"1":{"keepall":true}}\n{"3":{"forgetall":true,"summary":"old log"}}',
    indices: [1, 2, 3],
    expected: [[1, "answered", null], [2, "refused", "missing-index"], [3, "answered", null]],
  },
  {
    name: "a repeated index refuses that row and never touches a neighbour",
    text: '{"1":{"keepall":true}}\n{"1":{"forgetall":true,"summary":"s"}}\n'
      + '{"2":{"keepall":true}}',
    indices: [1, 2],
    expected: [[1, "refused", "duplicate-index"], [2, "answered", null]],
  },
  {
    // One line spelling the same top-level index twice: JSON.parse collapses it
    // to the last value, so only the raw line can refuse the last-wins read.
    name: "a duplicate top-level index inside one line is duplicate-index",
    text: '{"1":{"keepall":true},"1":{"forgetall":true,"summary":"last wins"}}\n'
      + '{"2":{"keepall":true}}',
    indices: [1, 2],
    expected: [[1, "refused", "duplicate-index"], [2, "answered", null]],
  },
  {
    // ISSUE-325: the duplicate refusal must not suppress the mixed-keys refusal
    // for the OTHER assigned keys the same line names.
    name: "a repeated index on a multi-key line still refuses the other keys mixed-keys",
    text: '{"2":{"keepall":true},"2":{"forgetall":true,"summary":"s"},"5":{"keepall":true}}',
    indices: [2, 5],
    expected: [[2, "refused", "duplicate-index"], [5, "refused", "mixed-keys"]],
  },
  {
    name: "an unknown key is a rejection, not a row refusal",
    text: '{"9":{"keepall":true}}\n{"1":{"keepall":true}}',
    indices: [1],
    expected: [[1, "answered", null]],
  },
  {
    name: "a zero, reversed or non-integer pair is bad-range",
    text: '{"1":{"keeplines":[[0,2]],"summary":"s"}}',
    indices: [1], lineCounts: new Map([[1, 10]]),
    expected: [[1, "refused", "bad-range"]],
  },
  {
    name: "a pair past the row's own line count is spans-outside-result",
    text: '{"1":{"keeplines":[[1,11]],"summary":"s"}}',
    indices: [1], lineCounts: new Map([[1, 10]]),
    expected: [[1, "refused", "spans-outside-result"]],
  },
  {
    name: "unsorted or overlapping pairs are ranges-unordered",
    text: '{"1":{"keeplines":[[3,4],[1,2]],"summary":"s"}}',
    indices: [1], lineCounts: new Map([[1, 10]]),
    expected: [[1, "refused", "ranges-unordered"]],
  },
  {
    name: "a forgetall without its summary is summary-missing",
    text: '{"1":{"forgetall":true}}\n{"2":{"keepall":true}}',
    indices: [1, 2],
    expected: [[1, "refused", "summary-missing"], [2, "answered", null]],
  },
  {
    name: "a keepall with an extra key is mixed-keys; a false keepall is the grammar gate",
    text: '{"1":{"keepall":true,"summary":"x"}}\n{"2":{"keepall":false}}',
    indices: [1, 2],
    expected: [
      [1, "refused", "mixed-keys"],
      [2, "refused", ENTRY_ASK_GRAMMAR_REFUSAL_CODE],
    ],
  },
  {
    name: "a forgetall that is not exactly true is malformed-row",
    text: '{"1":{"forgetall":"old wire summary"}}',
    indices: [1],
    expected: [[1, "refused", "malformed-row"]],
  },
  {
    name: "a summary past 30 words is summary-too-long",
    text: JSON.stringify({ 1: { forgetall: true,
      summary: Array.from({ length: 31 }, (_, at) => `w${String(at)}`).join(" ") } }),
    indices: [1],
    expected: [[1, "refused", "summary-too-long"]],
  },
  {
    name: "a line that is not JSON and names no row moves no unit",
    text: '{"1":{"keepall":true}}\nnot json\n{"2":{"keepall":true}}',
    indices: [1, 2],
    expected: [[1, "answered", null], [2, "answered", null]],
  },
  {
    name: "a line that is not JSON but spells its index refuses only that row",
    text: '{"1":{"keepall":true}}\n{"2":{"keepall":true}\n{"3":{"keepall":true}}',
    indices: [1, 2, 3],
    expected: [[1, "answered", null], [2, "refused", "answer-unreadable"],
      [3, "answered", null]],
  },
  {
    name: "a multi-key object refuses every row it names and applies none of them",
    text: '{"1":{"keepall":true},"2":{"keepall":true}}',
    indices: [1, 2],
    expected: [[1, "refused", "mixed-keys"], [2, "refused", "mixed-keys"]],
  },
  {
    name: "a stray second top-level key beside a whole verdict refuses that row",
    text: '{"1":{"keepall":true}}\n'
      + '{"2":{"forgetall":true,"summary":"old log"},"keepall":false}\n'
      + '{"3":{"keepall":true}}',
    indices: [1, 2, 3],
    expected: [[1, "answered", null], [2, "refused", "mixed-keys"], [3, "answered", null]],
  },
  {
    name: "an answer of blank lines alone carries no verdict",
    text: "   \n\t\n",
    indices: [1, 2],
    expected: [[1, "refused", "answer-unreadable"], [2, "refused", "answer-unreadable"]],
  },
];

test("jsonl-20 refuses every bad shape under its own code, one row at a time", () => {
  for (const testCase of REFUSAL_CASES) {
    const reading = readJsonl20Answer(testCase.text, testCase.indices,
      testCase.lineCounts ?? new Map());
    assert.deepEqual(
      reading.rows.map(entry => [entry.index, entry.status,
        entry.status === "refused" ? entry.code : null]),
      testCase.expected, `row: ${testCase.name}`);
    for (const entry of reading.rows) {
      if (entry.status !== "refused") continue;
      assert.equal(typeof entry.message, "string", `row: ${testCase.name} — every refusal names itself`);
      assert.equal(entry.message.length > 0, true, `row: ${testCase.name}`);
    }
    // The batch ask's reader delegates to the same reading, so the mount sees
    // the same codes through `parseEntryBatchAnswer`.
    const viaBatch = parseEntryBatchAnswer(testCase.text, testCase.indices, "jsonl-20",
      testCase.lineCounts ?? new Map());
    assert.deepEqual(viaBatch.map(entry => [entry.index, entry.status,
      entry.status === "refused" ? entry.code : null]),
    testCase.expected, `row: ${testCase.name} — through the batch ask`);
  }
});

test("jsonl-20 reads line by line: a bad line refuses its own row and nothing else (ISSUE-187)", () => {
  // (a) the live shape: 24 good lines and one carrying a stray second top-level
  // key. The good rows apply; the stray-key row is refused and kept.
  const indices = Array.from({ length: 25 }, (_, at) => at + 1);
  const lineOf = (index: number): string => index === 2
    ? '{"2":{"forgetall":true,"summary":"stale build log"},"keepall":false}'
    : JSON.stringify({ [index]: { keepall: true } });
  const text = indices.map(lineOf).join("\n");
  const reading = readJsonl20Answer(text, indices);
  assert.equal(reading.rows.filter(row => row.status === "answered").length, 24,
    "24 good lines still apply");
  const stray = reading.rows[1];
  assert.equal(stray?.status === "refused" ? stray.code : null, "mixed-keys",
    "the stray-key row is refused, never applied beside its extra key");
  assert.equal(stray?.status === "refused" ? stray.message.length > 0 : false, true,
    "the refusal names itself");
  // The batch ask reads the same answer the same way.
  assert.equal(parseEntryBatchAnswer(text, indices, "jsonl-20")
    .filter(row => row.status === "answered").length, 24,
  "the mount's reading is this reading");

  // (b) a line missing its closing brace refuses only its own row.
  const unclosed = readJsonl20Answer('{"1":{"keepall":true}}\n'
    + '{"2":{"keepall":true}\n{"3":{"keepall":true}}', [1, 2, 3]).rows;
  assert.deepEqual(unclosed.map(row => [row.status,
    row.status === "refused" ? row.code : null]),
  [["answered", null], ["refused", "answer-unreadable"], ["answered", null]]);

  // (c) a repeated index refuses that row only.
  const repeated = readJsonl20Answer('{"1":{"keepall":true}}\n'
    + '{"2":{"keepall":true}}\n{"2":{"forgetall":true,"summary":"again"}}\n'
    + '{"3":{"keepall":true}}', [1, 2, 3]).rows;
  assert.deepEqual(repeated.map(row => [row.status,
    row.status === "refused" ? row.code : null]),
  [["answered", null], ["refused", "duplicate-index"], ["answered", null]]);

  // (d) an answer with no verdict at all still refuses as a whole.
  for (const none of ["I kept all of them; nothing looked stale.", "{}", "5",
    ENTRY_ASK_END_ANCHOR, ""]) {
    assert.deepEqual(readJsonl20Answer(none, [1, 2]).rows
      .map(row => (row.status === "refused" ? row.code : null)),
    ["answer-unreadable", "answer-unreadable"], `no verdict in ${JSON.stringify(none)}`);
  }
});

test("jsonl-20's per-row reading is scoped to jsonl-20", () => {
  // (e) The older grammars keep their whole-answer reading: this text is not the
  // assembled object either of them asks for, so every row is refused there.
  const text = '{"1":{"keepall":true}}\nnot json\n{"2":{"keepall":true}}';
  for (const grammar of ["3option", "two-option"] as const) {
    assert.deepEqual(parseEntryBatchAnswer(text, [1, 2], grammar)
      .map(row => (row.status === "refused" ? row.code : null)),
    ["answer-unreadable", "answer-unreadable"], `${grammar} is unchanged`);
  }
  assert.deepEqual(parseEntryBatchAnswer(text, [1, 2], "jsonl-20").map(row => row.status),
    ["answered", "answered"], "only jsonl-20 reads the lines one at a time");
});

test("jsonl-20's vocabulary is named once; 30 words answer and 31 refuse", () => {
  assert.deepEqual([...JSONL_20_REFUSAL_CODES], [
    "answer-unreadable", "unknown-index", "duplicate-index", "missing-index",
    "action-not-in-grammar", "malformed-row", "mixed-keys",
    "both-forgotten-and-summary", "summary-missing",
    "summary-too-long", "bad-range", "ranges-unordered", "spans-outside-result",
  ]);
  assert.equal(JSONL_20_SUMMARY_WORDS, 30);
  const words = (count: number): string =>
    Array.from({ length: count }, (_, at) => `w${String(at)}`).join(" ");
  const read = (count: number) => readJsonl20Answer(
    JSON.stringify({ 1: { forgetall: true, summary: words(count) } }), [1]).rows[0];
  assert.equal(read(30)?.status, "answered", "the reader tolerates 30 words");
  const tooLong = read(31);
  assert.equal(tooLong?.status === "refused" ? tooLong.code : null, "summary-too-long");
});

test("jsonl-20 keeps an all-lines keeplines whole and ignores blanks and one anchor", () => {
  const whole = readJsonl20Answer('{"1":{"keeplines":[[1,4]],"summary":"all four"}}',
    [1], new Map([[1, 4]])).rows[0];
  assert.equal(whole?.status, "answered", "an all-lines keep is legal here");
  assert.deepEqual(whole?.status === "answered" ? whole.answer : null,
    { action: "keeplines", ranges: [{ from: 1, to: 4 }], summary: "all four" });
  const text = '\n{"1":{"keepall":true}}\n\n'
    + '{"2":{"forgetall":true,"summary":"old log"}}\n'
    + `${ENTRY_ASK_END_ANCHOR}\n\n`;
  const rows = readJsonl20Answer(text, [1, 2]).rows;
  assert.deepEqual(rows.map(entry => entry.status), ["answered", "answered"],
    "blank lines and one trailing anchor are ignored");
  const middle = '{"1":{"keepall":true}}\n' + ENTRY_ASK_END_ANCHOR + '\n{"2":{"keepall":true}}';
  const middleRows = readJsonl20Answer(middle, [1, 2]).rows;
  assert.deepEqual(middleRows.map(entry => entry.status), ["answered", "answered"],
    "an anchor that is not the last line is not a marker: it names no row and moves no unit");
});

test("jsonl-20's caller bugs throw by name, never guess a count", () => {
  assert.throws(() => readJsonl20Answer('{"1":{"keeplines":[[1,2]],"summary":"s"}}', [1]),
    /line count/u, "a keeplines row needs its L");
  assert.throws(() => parseEntryBatchAnswer('{"1":{"keepall":true}}', [], "jsonl-20"),
    /at least one/u, "an empty index list is refused");
  assert.throws(() => entryBatchAskMessage([row(1, "Read a.ts", [], 3)], "nope" as never),
    /3option.*two-option.*jsonl-20/u, "an unknown grammar is refused by name");
  assert.throws(() => entryBatchAskMessage([{ index: 1, call: "Read a.ts", anchorLines: [] }],
    "jsonl-20"), /line count/u, "a jsonl-20 row without its count is refused");
});

test("jsonl-20 reports an unknown key without minting a row for it", () => {
  const text = '{"9":{"keepall":true}}\n{"1":{"keepall":true}}';
  const rejected = jsonl20RejectionsOf(text, [1]);
  assert.deepEqual(rejected.map(entry => [entry.key, entry.index, entry.code]),
    [["9", 9, "unknown-index"]]);
});

test("jsonl-20-nokeepall refuses keepall and reads a whole range as keepall", () => {
  // A literal keepall is the one action this grammar does not offer.
  const literal = readJsonl20NoKeepallAnswer('{"1":{"keepall":true}}', [1]).rows[0];
  assert.equal(literal?.status === "refused" ? literal.code : null,
    ENTRY_ASK_GRAMMAR_REFUSAL_CODE, "keepall is refused by this grammar");
  assert.equal(literal?.status === "refused" ? literal.message.length > 0 : false, true,
    "the refusal names itself");

  // A whole range with any summary is the clean keep-whole; a partial one is
  // the shipped reading; `forgetall` crosses unchanged.
  const whole = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,50]],"summary":"not the taught note"}}', [1], new Map([[1, 50]]))
    .rows[0];
  assert.deepEqual(whole?.status === "answered" ? whole.answer : null,
    { action: "keepall" }, "the range, not the note, decides the keep-whole");
  const partial = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,6]],"summary":"None"}}', [1], new Map([[1, 12]])).rows[0];
  assert.deepEqual(partial?.status === "answered" ? partial.answer : null,
    { action: "keeplines", ranges: [{ from: 1, to: 6 }], summary: "None" });
  const forgot = readJsonl20NoKeepallAnswer(
    '{"1":{"forgetall":true,"summary":"old log"}}', [1]).rows[0];
  assert.deepEqual(forgot?.status === "answered" ? forgot.answer : null,
    { action: "forgetall", summary: "old log" });

  // L is the row's own: a fixed 120 is past a 50-line row.
  const past = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,120]],"summary":"None"}}', [1], new Map([[1, 50]])).rows[0];
  assert.equal(past?.status === "refused" ? past.code : null, "spans-outside-result");
  assert.throws(() => readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,2]],"summary":"s"}}', [1]), /line count/u,
  "a keeplines row still needs its own L");
});

/**
 * The action-key acceptance matrix (ISSUE-515): one row per spelling a model
 * may write, naming the canonical action it means. Both shipped reader grammars
 * run every row, so case and one trailing `s` are checked where the key is
 * actually parsed. This table replaces the separate "wrong case" assertions the
 * older parser tests carried.
 */
const ACTION_KEY_ROWS = [
  ["keeplines", "keeplines"],
  ["KEEPLINES", "keeplines"],
  ["keepline", "keeplines"],
  ["KEEPline", "keeplines"],
  ["keepLines", "keeplines"],
  ["forgetall", "forgetall"],
  ["FORGETALL", "forgetall"],
  ["forgetAll", "forgetall"],
  ["FORGETLINE", "forgetlines"],
  ["forgetline", "forgetlines"],
  ["KEEPALL", "keepall"],
  ["keepall", "keepall"],
  ["keepAll", "keepall"],
  ["Keepall", "keepall"],
  ["keepalls", "keepall"],
] as const;

/** The one verdict line a matrix row writes under its own key spelling. */
function verdictOfKey(key: string, action: string): Record<string, unknown> {
  if (action === "keepall") return { [key]: true };
  if (action === "forgetall") return { [key]: true, summary: "s" };
  return { [key]: [[1, 2]], summary: "s" };
}

/** One matrix row read by the named grammar, against a ten-line row. */
function readActionKeyRow(
  text: string,
  grammar: "jsonl-20" | "jsonl-20-nokeepall",
): Jsonl20RowResult | undefined {
  const counts = new Map([[1, 10]]);
  return grammar === "jsonl-20"
    ? readJsonl20Answer(text, [1], counts).rows[0]
    : readJsonl20NoKeepallAnswer(text, [1], counts).rows[0];
}

test("jsonl-20 reads an action key in any case or number; a misspelling stays out", () => {
  for (const [key, action] of ACTION_KEY_ROWS) {
    const row = readActionKeyRow(JSON.stringify({ 1: verdictOfKey(key, action) }), "jsonl-20");
    // `forgetlines` is outside this grammar's three actions, whatever its key.
    if (action === "forgetlines") {
      assert.equal(row?.status === "refused" ? row.code : null, "action-not-in-grammar", key);
      continue;
    }
    assert.equal(row?.status, "answered", key);
    assert.equal(row?.status === "answered" ? row.answer.action : null, action, key);
  }
  for (const key of ["kleplines", "keep", "keeplinesx"]) {
    const row = readActionKeyRow(JSON.stringify({ 1: { [key]: true } }), "jsonl-20");
    assert.equal(row?.status === "refused" ? row.code : null, "action-not-in-grammar", key);
  }
  // `summary` is the only sibling key, and it is never normalized into an action.
  const summaryOnly = readActionKeyRow(JSON.stringify({ 1: { summary: "s" } }), "jsonl-20");
  assert.equal(summaryOnly?.status === "refused" ? summaryOnly.code : null,
    "action-not-in-grammar", "a summary alone names no action");
});

test("jsonl-20-nokeepall reads the same spellings and still refuses every keepall", () => {
  for (const [key, action] of ACTION_KEY_ROWS) {
    const row = readActionKeyRow(JSON.stringify({ 1: verdictOfKey(key, action) }),
      "jsonl-20-nokeepall");
    if (action === "keepall" || action === "forgetlines") {
      assert.equal(row?.status === "refused" ? row.code : null, "action-not-in-grammar", key);
      continue;
    }
    assert.equal(row?.status, "answered", key);
    assert.equal(row?.status === "answered" ? row.answer.action : null, action, key);
  }
  // A whole-range keep reads the same in any spelling: a clean whole keep.
  const whole = readActionKeyRow(
    JSON.stringify({ 1: { KEEPLINES: [[1, 10]], summary: "not the taught note" } }),
    "jsonl-20-nokeepall");
  assert.deepEqual(whole?.status === "answered" ? whole.answer : null, { action: "keepall" });
});

test("two action keys that normalize to one action stay two keys", () => {
  for (const grammar of ["jsonl-20", "jsonl-20-nokeepall"] as const) {
    for (const value of [
      { 1: { keeplines: [[1, 2]], KEEPLINES: [[1, 2]], summary: "s" } },
      { 1: { keeplines: [[1, 2]], forgetall: true, summary: "s" } },
      // `Summary` is not `summary`, so it is a stranger beside the action.
      { 1: { KEEPLINES: [[1, 2]], Summary: "s" } },
    ]) {
      const row = readActionKeyRow(JSON.stringify(value), grammar);
      assert.equal(row?.status === "refused" ? row.code : null, "mixed-keys",
        `${grammar}: ${JSON.stringify(value)}`);
    }
  }
});

/** `3option` and `two-option` keep their bytes and their reading, now selected by name. */
test("the older grammars are unchanged by jsonl-20 becoming the default", () => {
  // 3option: named explicitly, the shipped contract opens it and a one-row batch
  // is still `entryAskMessage`'s prose.
  assert.ok(entryBatchAskMessage(FOUR_ROWS, "3option")
    .startsWith(`${PRUNE_ASK_SYSTEM_PROMPT}\n\n`));
  assert.equal(entryBatchAskMessage([row(1, "Read config.ts", [], 3)], "3option"),
    entryAskMessage({ lineCount: 3, anchorLines: [] }));
  // The absent-value default is jsonl-20, not the assembled 3option object.
  assert.notEqual(entryBatchAskMessage(FOUR_ROWS), entryBatchAskMessage(FOUR_ROWS, "3option"));
  assert.ok(entryBatchAskMessage(FOUR_ROWS)
    .startsWith(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.slice(
      0, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT))));
  // two-option: its own contract opens it, the entry closing line ends it, and a
  // lined row is still refused by the grammar.
  const twoOption = entryBatchAskMessage(FOUR_ROWS, "two-option");
  assert.ok(twoOption.startsWith(`${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}\n\n`));
  assert.equal(twoOption.includes("keeplines"), false);
  const lined = parseEntryBatchAnswer(
    '{"1":{"keeplines":[[1,2],"s"]}}', [1], "two-option");
  assert.equal(lined[0]?.status === "refused" ? lined[0].code : null,
    ENTRY_ASK_GRAMMAR_REFUSAL_CODE);
  // The default reader reads one JSON object per line, not the assembled object.
  const defaultRead = parseEntryBatchAnswer(
    '{"1":{"keepall":true}}\n{"2":{"forgetall":true,"summary":"stale log"}}', [1, 2]);
  assert.deepEqual(defaultRead.map(entry => entry.status), ["answered", "answered"]);
});

test("both jsonl-20 grammars read forgotten canonically and summary as its alias (ISSUE-525)", () => {
  const counts = new Map([[1, 4]]);
  const shipped = readJsonl20Answer(
    '{"1":{"keeplines":[[1,2]],"forgotten":"the stale log lines"}}', [1], counts).rows[0];
  assert.deepEqual(shipped?.status === "answered" ? shipped.answer : null, {
    action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "the stale log lines",
  });
  assert.deepEqual(readJsonl20Answer(
    '{"1":{"keeplines":[[1,2]],"summary":"the stale log lines"}}', [1], counts).rows[0],
  shipped, "the legacy key reads as the same answer");
  const both = readJsonl20Answer(
    '{"1":{"keeplines":[[1,2]],"forgotten":"a","summary":"b"}}', [1], counts).rows[0];
  assert.equal(both?.status === "refused" ? both.code : null, "both-forgotten-and-summary");
  const noKeepall = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,4]],"forgotten":"None"}}', [1], counts).rows[0];
  assert.deepEqual(noKeepall?.status === "answered" ? noKeepall.answer : null,
    { action: "keepall" }, "a whole keep with forgotten None still normalizes");
  const partial = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[2,3]],"forgotten":"the stale log lines"}}', [1], counts).rows[0];
  assert.deepEqual(partial?.status === "answered" ? partial.answer : null, {
    action: "keeplines", ranges: [{ from: 2, to: 3 }], summary: "the stale log lines",
  });
  const aliasBoth = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[2,3]],"forgotten":"a","summary":"b"}}', [1], counts).rows[0];
  assert.equal(aliasBoth?.status === "refused" ? aliasBoth.code : null,
    "both-forgotten-and-summary");
});
