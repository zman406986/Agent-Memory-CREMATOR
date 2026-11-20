import assert from "node:assert/strict";
import { test } from "node:test";
import {
  entryAskMessage, ENTRY_ASK_CLOSING_LINE, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_SLOT,
  PRUNE_ASK_SYSTEM_PROMPT, PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT,
} from "../src/rules/assets.js";
import { PRUNE_ASK_FINAL_LINE } from "../src/prune/ask.js";
import {
  ENTRY_ASK_GRAMMAR_REFUSAL_CODE, entryBatchAskMessage, parseEntryBatchAnswer,
} from "../src/entry/batch-ask.js";
import type { EntryBatchRow } from "../src/entry/batch-ask.js";

/**
 * The entry seam's batched ask (ISSUE-117 chunk B2; ADR-0035 §4–§5).
 *
 * One message covers every row of a batch, index-keyed, under ISSUE-110's
 * approved table copy; one index-keyed answer comes back and is read per index,
 * one result per assigned row, and a refused or missing row keeps its unit while
 * its neighbours apply. The row renderer and the answer reader are the table
 * ask's own (`renderPruneAskRows`, `parsePruneAnswer`) — reused, not restated —
 * and the message ends on the entry seam's closing line so a rig's end anchor
 * still classifies it as an entry ask.
 *
 * A batch of ONE is today's bytes, byte for byte (ADR-0035 §Consequences, the
 * default-off gate): with `entryAskBatchSize` absent or 1 every fire is a
 * one-row batch, so the ask stream cannot move without this holding.
 *
 * Every row below is one case of one rule; a check that stopped reading its
 * input would let its row through, and the failure names that row.
 */

function row(index: number, call: string, anchorLines: readonly string[],
  lineCount?: number): EntryBatchRow {
  return lineCount === undefined ? { index, call, anchorLines } : { index, call, anchorLines, lineCount };
}

const THREE_ROWS: readonly EntryBatchRow[] = [
  row(1, "Read config.ts", ['line 31 of 100 ends with "retries: 3"'], 100),
  row(2, "Grep stale-deploy", ['line 7 of 40 ends with "old host"'], 40),
  row(3, "Bash npm test", [], 12),
];

/** Pinned literal, not a re-derivation: the bytes a lone row must ship. */
const PINNED = "Memory management: decide what part of the tool result above stays in your "
  + "memory. Answer about that result only.\n\nAnswer with exactly one JSON object and no other "
  + "text. One of three keys:\n\n{\"keepall\":true}\n{\"keeplines\":[[1,5],[9,12],\"stale build "
  + "log lines\"]}\n{\"keeplines\":[[1,5],[9,12]],\"summary\":\"stale build log lines\"}\n"
  + "{\"forgetall\":\"one-line summary of the whole result\"}\n\nkeeplines keeps the named ranges "
  + "(1-based, inclusive); the rest is replaced by a required summary that goes last in the array "
  + "or in a sibling \"summary\" key, never both. A few words, aim under 15, never over 25. "
  + "forgetall purges everything but the summary; keepall keeps every line.\n\nPrune "
  + "aggressively: drop anything the immediate task does not need. If you drop too much, the "
  + "necromancy tool restores the exact bytes.\n\nThis result has 3 lines, so keeplines ranges sit "
  + "in [1,3]. Quotes to help you locate them:\n\nAnswer with one JSON object for the result "
  + "above and nothing else. [[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]";

type Case = readonly [name: string, run: (name: string) => void];

/** The message shape under the shipped `3option` grammar: table vs. today's bytes. */
const MESSAGE_CASES: readonly Case[] = [
  ["three rows — one index-keyed row each, ascending, closed by the entry line", name => {
    const message = entryBatchAskMessage(THREE_ROWS, "3option");
    assert.ok(message.startsWith(`${PRUNE_ASK_SYSTEM_PROMPT}\n\n`),
      `row: ${name} — the approved copy opens it`);
    const rows = message.split("\n").filter(line => /^\d+\. \[/u.test(line));
    assert.equal(rows.length, 3, `row: ${name} — one row per result, no row rendered twice`);
    assert.deepEqual(rows.map(line => line.slice(0, 2)), ["1.", "2.", "3."],
      `row: ${name} — the rows ascend by index`);
    assert.ok(rows[0]?.includes("Read config.ts"), `row: ${name} — the row names its call`);
    assert.ok(rows[1]?.includes('line 7 of 40 ends with "old host"'),
      `row: ${name} — the row carries its quotes`);
    assert.ok(message.endsWith(`\n\n${ENTRY_ASK_CLOSING_LINE}`),
      `row: ${name} — the shipped closing line ends it`);
    assert.equal(message.includes(PRUNE_ASK_FINAL_LINE), false,
      `row: ${name} — the table's own final line is not sent: this lane's closing line is the entry one`);
    assert.equal(message.includes("10."), false,
      `row: ${name} — the message renders nothing the caller did not hand it`);
  }],
  ["one row — today's entryAskMessage bytes, byte for byte", name => {
    // Today's single-result path still ships those bytes…
    assert.equal(entryAskMessage({ lineCount: 3, anchorLines: [] }), PINNED,
      `row: ${name} — the pinned bytes are the single-result path's`);
    // …and a one-row batch ships the same ones, so the knob at 1 moves nothing.
    const message = entryBatchAskMessage([row(1, "Read config.ts", [], 3)], "3option");
    assert.equal(message, PINNED, `row: ${name} — the one-row batch is the pinned bytes`);
    assert.equal(message, entryAskMessage({ lineCount: 3, anchorLines: [] }),
      `row: ${name} — the one-row batch delegates, it does not re-derive`);
  }],
];

/** Caller bugs: only invalid input throws, and it throws by name. */
const REFUSAL_CASES: readonly Case[] = [
  ["a one-row batch without its line count", name => {
    const rowWithoutCount: EntryBatchRow = { index: 1, call: "Read config.ts", anchorLines: [] };
    assert.throws(() => entryBatchAskMessage([rowWithoutCount], "3option"), /lineCount/u,
      `row: ${name} — a missing N is refused by name, never guessed`);
  }],
  ["an empty batch", name => {
    assert.throws(() => entryBatchAskMessage([]), /at least one row/u,
      `row: ${name} — a batch renders at least one row`);
  }],
  ["an unknown grammar on the message", name => {
    assert.throws(() => entryBatchAskMessage(THREE_ROWS, "2option" as never), /3option.*two-option/u,
      `row: ${name} — another grammar id is refused, never a silent default`);
  }],
  ["an unknown grammar on the reader", name => {
    assert.throws(() => parseEntryBatchAnswer('{"1":{"keepall":true}}', [1], "nope" as never),
      /3option.*two-option/u,
      `row: ${name} — the reader refuses another grammar id by name too`);
  }],
  ["no assigned index", name => {
    assert.throws(() => parseEntryBatchAnswer('{"1":{"keepall":true}}', []), /at least one/u,
      `row: ${name} — an empty index list is refused`);
  }],
];

/** Reading one `3option` answer: one result per assigned index, refusals keep. */
const READ_CASES: readonly Case[] = [
  ["a missing index — that row is refused and keeps", name => {
    const results = parseEntryBatchAnswer('{"1":{"keepall":true},"3":{"forgetall":"stale log"}}',
      [1, 2, 3], "3option");
    assert.deepEqual(results.map(result => [result.index, result.status]),
      [[1, "answered"], [2, "refused"], [3, "answered"]],
      `row: ${name} — one result per assigned index, in index order`);
    assert.deepEqual(results[0]?.status === "answered" ? results[0].answer : null,
      { action: "keepall" }, `row: ${name} — the answered row maps its wire back`);
    const refused = results[1];
    assert.ok(refused?.status === "refused" && refused.code === "missing-index",
      `row: ${name} — the missing row is refused by its own code`);
  }],
  ["a malformed row — its unit keeps while its neighbours apply", name => {
    const text = '{"1":{"keepall":true},"2":{"nonsense":true},'
      + '"3":{"forgetall":"a stale build log from the old host"},'
      + '"4":{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}';
    const results = parseEntryBatchAnswer(text, [1, 2, 3, 4], "3option");
    assert.deepEqual(results.map(result => [result.index, result.status]),
      [[1, "answered"], [2, "refused"], [3, "answered"], [4, "answered"]],
      `row: ${name} — only the malformed row is refused`);
    const malformed = results[1];
    assert.ok(malformed?.status === "refused", `row: ${name} — the malformed row keeps`);
    assert.equal(malformed.code, "malformed-row",
      `row: ${name} — the wire parser's refusal is that row's keep`);
    assert.deepEqual(results[2]?.status === "answered" ? results[2].answer : null,
      { action: "forgetall", summary: "a stale build log from the old host" },
      `row: ${name} — the forgetall neighbour maps back with its summary`);
    assert.deepEqual(results[3]?.status === "answered" ? results[3].answer : null, {
      action: "keeplines",
      ranges: [{ from: 2, to: 3 }],
      summary: "stale run notes: the superseded TODO and the old deploy host",
    }, `row: ${name} — the keeplines neighbour maps back with its ranges and summary`);
  }],
  ["an unreadable answer — every assigned row is refused", name => {
    const all = parseEntryBatchAnswer("not json", [1, 2], "3option");
    assert.deepEqual(all.map(result => result.status), ["refused", "refused"],
      `row: ${name} — no row is answered`);
    assert.deepEqual(all.map(result => result.status === "refused" ? result.code : null),
      ["answer-unreadable", "answer-unreadable"],
      `row: ${name} — every refusal names the unreadable answer`);
  }],
  ["a key no row carries — it addresses nothing", name => {
    const stray = parseEntryBatchAnswer('{"1":{"keepall":true},"9":{"keepall":true}}', [1], "3option");
    assert.deepEqual(stray.map(result => [result.index, result.status]), [[1, "answered"]],
      `row: ${name} — the assigned rows still answer, and no result is minted for key 9`);
  }],
];

/** Grammar selection: `jsonl-20` is the default; `two-option` and `3option` are selectable by name. */
const GRAMMAR_CASES: readonly Case[] = [
  ["two-option — its own contract, no line-level option, entry closing anchor", name => {
    const message = entryBatchAskMessage(THREE_ROWS, "two-option");
    assert.ok(message.startsWith(`${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}\n\n`),
      `row: ${name} — the two-option contract opens it`);
    assert.ok(message.endsWith(`\n\n${ENTRY_ASK_CLOSING_LINE}`),
      `row: ${name} — the shipped closing line ends it`);
    assert.equal(message.includes("keeplines"), false,
      `row: ${name} — no keeplines example or teaching`);
    assert.equal(message.includes("forgetlines"), false,
      `row: ${name} — no forgetlines teaching either`);
    assert.equal(message.includes("There is no line-level option"), true,
      `row: ${name} — the contract says plainly that no partial answer exists`);
    const shipped = PRUNE_ASK_SYSTEM_PROMPT.split("\n");
    const variant = PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT.split("\n");
    assert.equal(variant[0], shipped[0],
      `row: ${name} — the opener is the shipped prompt's own bytes`);
    assert.equal(variant[variant.length - 1], shipped[shipped.length - 1],
      `row: ${name} — the final 'Prune aggressively' line is the shipped prompt's own bytes`);
    assert.equal(message.split("\n").filter(line => /^\d+\. \[/u.test(line)).length, 3,
      `row: ${name} — the rows are the shared table shape, untouched by the grammar`);
  }],
  ["two-option, one row — the table shape, never the prose ask", name => {
    const message = entryBatchAskMessage([row(1, "Read config.ts", [], 3)], "two-option");
    assert.ok(message.startsWith(`${PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT}\n\n`),
      `row: ${name} — the two-option contract opens it, not today's entry prompt`);
    assert.equal(message.includes("This result has 3 lines"), false,
      `row: ${name} — the prose range sentence is not sent under two-option`);
    assert.equal(message.split("\n").filter(line => /^\d+\. \[/u.test(line)).length, 1,
      `row: ${name} — the lone row renders as a table row`);
  }],
  ["3option — selectable by name, its own bytes and reading", name => {
    assert.ok(entryBatchAskMessage(THREE_ROWS, "3option")
      .startsWith(`${PRUNE_ASK_SYSTEM_PROMPT}\n\n`),
    `row: ${name} — the original contract opens it`);
    assert.equal(
      entryBatchAskMessage([row(1, "Read config.ts", [], 3)], "3option"),
      entryAskMessage({ lineCount: 3, anchorLines: [] }),
      `row: ${name} — the one-row prose path is 3option's, byte for byte`,
    );
    assert.notEqual(entryBatchAskMessage(THREE_ROWS, "3option"),
      entryBatchAskMessage(THREE_ROWS),
      `row: ${name} — jsonl-20, not 3option, is the absent-value default`);
    const read = parseEntryBatchAnswer('{"1":{"keeplines":[[1,2],"s"]}}', [1], "3option");
    assert.equal(read[0]?.status, "answered", `row: ${name} — 3option still reads keeplines`);
  }],
  ["two-option — a lined row is refused as action-not-in-grammar, neighbours apply", name => {
    const text = '{"1":{"keepall":true},'
      + '"2":{"keeplines":[[2,3],"stale run notes"]},'
      + '"3":{"forgetall":"a stale build log from the old host"}}';
    const results = parseEntryBatchAnswer(text, [1, 2, 3], "two-option");
    assert.deepEqual(results.map(result => [result.index, result.status]),
      [[1, "answered"], [2, "refused"], [3, "answered"]],
      `row: ${name} — the lined row keeps, its neighbours apply`);
    const lined = results[1];
    assert.ok(lined?.status === "refused", `row: ${name} — the lined row is refused`);
    assert.equal(lined.code, ENTRY_ASK_GRAMMAR_REFUSAL_CODE,
      `row: ${name} — a lined row is refused by the grammar, which means KEEP`);
    const forgetlines = parseEntryBatchAnswer('{"1":{"forgetlines":[[2,3],"x"]}}', [1], "two-option");
    assert.equal(forgetlines[0]?.status === "refused" ? forgetlines[0].code : null,
      ENTRY_ASK_GRAMMAR_REFUSAL_CODE, `row: ${name} — forgetlines is not in the grammar either`);
    const malformed = parseEntryBatchAnswer('{"1":{"nonsense":true}}', [1], "two-option");
    assert.equal(malformed[0]?.status === "refused" ? malformed[0].code : null, "malformed-row",
      `row: ${name} — the parser's own refusals keep their codes: the gate sits above them`);
  }],
];

test("jsonl-20-nokeepall renders its own two verdicts and reads to a clean keep-whole", () => {
  const message = entryBatchAskMessage(THREE_ROWS, "jsonl-20-nokeepall");
  const prefix = PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT.slice(
    0, PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
  assert.ok(message.startsWith(prefix), "the nokeepall pre-table bytes open it");
  assert.ok(message.endsWith(`\n\n${PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT}`),
    "the nokeepall repeat closes it");
  assert.equal(message.includes("keepall"), false, "keepall never appears in its bytes");
  const rows = message.split("\n").filter(line => /^\d+\. \[/u.test(line));
  assert.equal(rows.length, THREE_ROWS.length, "one row per result, ascending");
  for (const [at, row] of THREE_ROWS.entries()) {
    assert.match(rows[at] ?? "", new RegExp(` \\[${String(row.lineCount)} lines?\\]$`, "u"),
      `row ${String(row.index)} carries its own L`);
  }
  const later = entryBatchAskMessage(THREE_ROWS, "jsonl-20-nokeepall", false);
  const laterPrefix = PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT.slice(
    0, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT.indexOf(PRUNE_ASK_JSONL_20_SLOT));
  assert.ok(later.startsWith(laterPrefix), "the later trigger's pre-table bytes");
  assert.ok(later.endsWith(`\n\n${PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT}`),
    "the later trigger's repeat");

  // A whole-range keeplines with a summary other than the taught `None` is
  // still a clean keepall; a partial keeplines and a forgetall cross unchanged.
  const text = '{"1":{"keeplines":[[1,100]],"summary":"a different note"}}\n'
    + '{"2":{"forgetall":true,"summary":"old host"}}\n'
    + '{"3":{"keeplines":[[1,6]],"summary":"None"}}';
  const read = parseEntryBatchAnswer(text, [1, 2, 3], "jsonl-20-nokeepall",
    new Map([[1, 100], [3, 12]]));
  assert.deepEqual(read[0]?.status === "answered" ? read[0].answer : null,
    { action: "keepall" }, "a whole range is keepall whatever its summary");
  assert.deepEqual(read[1]?.status === "answered" ? read[1].answer : null,
    { action: "forgetall", summary: "old host" }, "forgetall crosses unchanged");
  assert.deepEqual(read[2]?.status === "answered" ? read[2].answer : null,
    { action: "keeplines", ranges: [{ from: 1, to: 6 }], summary: "None" },
    "a partial keeplines crosses unchanged");

  // The grammar's own gate: keepall and forgetlines are refused, keep the row,
  // and carry no retry (the batch result is a terminal keep).
  for (const line of ['{"1":{"keepall":true}}',
    '{"1":{"forgetlines":[[2,3],"old lines"]}}']) {
    const refusedRow = parseEntryBatchAnswer(line, [1], "jsonl-20-nokeepall")[0];
    assert.equal(refusedRow?.status === "refused" ? refusedRow.code : null,
      ENTRY_ASK_GRAMMAR_REFUSAL_CODE, `${line} is refused by the grammar`);
    assert.equal(refusedRow?.status === "refused" ? refusedRow.wireCode : "not-refused", null,
      `${line} carries no inner wire defect`);
  }

  // L is the row's own: 50 lines answers 1..50 and refuses 1..120.
  const fifty = parseEntryBatchAnswer('{"1":{"keeplines":[[1,50]],"summary":"x"}}',
    [1], "jsonl-20-nokeepall", new Map([[1, 50]]));
  assert.deepEqual(fifty[0]?.status === "answered" ? fifty[0].answer : null,
    { action: "keepall" }, "a 50-line whole range is keepall");
  const past = parseEntryBatchAnswer('{"1":{"keeplines":[[1,120]],"summary":"None"}}',
    [1], "jsonl-20-nokeepall", new Map([[1, 50]]));
  assert.equal(past[0]?.status === "refused" ? past[0].code : null, "spans-outside-result",
    "120 is not a universal L");
});

function runCases(cases: readonly Case[]): void {
  for (const [name, run] of cases) run(name);
}

/**
 * ADR-0039 on this lane: a real run's rows arrived as one flat object whose every
 * value was a bare string. The two whole-unit spellings read; a bare partial
 * action does not, and its row keeps.
 */
const BARE_STRING_CASES: readonly Case[] = [
  ["a bare keepall value normalises and its row answers", name => {
    const results = parseEntryBatchAnswer('{"1":"keepall","2":{"keepall":true}}', [1, 2], "3option");
    assert.deepEqual(results.map(result => result.status),
      ["answered", "answered"], `row: ${name} — the bare form is the object form`);
    assert.deepEqual(results[0]?.status === "answered" ? results[0].answer : null,
      { action: "keepall" }, `row: ${name} — it reads as the whole-unit keep`);
  }],
  ["a bare forgetall value normalises to the whole-unit drop with no summary", name => {
    const results = parseEntryBatchAnswer('{"1":"forgetall"}', [1], "3option");
    assert.deepEqual(results[0]?.status === "answered" ? results[0].answer : null,
      { action: "forgetall", summary: "" },
      `row: ${name} — the string carries no descriptor, so the answer carries none`);
  }],
  ["a bare keeplines value is STILL refused: it names spans it does not carry", name => {
    const results = parseEntryBatchAnswer('{"1":"keeplines"}', [1], "3option");
    assert.equal(results[0]?.status, "refused", `row: ${name} — never guessed`);
    assert.equal(results[0]?.status === "refused" ? results[0].code : null, "malformed-row",
      `row: ${name} — the row keeps under its own code`);
    assert.equal(results[0]?.status === "refused" ? results[0].wireCode : null, "not-an-object",
      `row: ${name} — the inner defect is named`);
  }],
  ["an unknown bare string is still refused", name => {
    const results = parseEntryBatchAnswer('{"1":"keephead","2":"KEEPALL"}', [1, 2], "3option");
    assert.deepEqual(results.map(result => result.status), ["refused", "refused"],
      `row: ${name} — a string outside the two whole-unit actions reads as nothing`);
    assert.deepEqual(results.map(result =>
      result.status === "refused" ? result.wireCode : null),
    ["not-an-object", "not-an-object"], `row: ${name} — refused by the object rule, unchanged`);
  }],
  ["a live-dialect reply parses whole: every row is a bare whole-unit action", name => {
    // The 2026-10-31 shape, verbatim in miniature: one flat object, string values.
    const text = '{"1":"keepall","2":"forgetall","3":"keepall"}';
    const results = parseEntryBatchAnswer(text, [1, 2, 3], "3option");
    assert.deepEqual(results.map(result => result.status),
      ["answered", "answered", "answered"], `row: ${name} — no row is refused`);
    assert.deepEqual(results.map(result =>
      result.status === "answered" ? result.answer.action : null),
    ["keepall", "forgetall", "keepall"], `row: ${name} — each row keeps its own decision`);
  }],
];

test("a bare whole-unit action reads as its object form; a bare partial action does not", () => {
  runCases(BARE_STRING_CASES);
});

test("the batched ask renders one index-keyed row per result under 3option", () => {
  runCases(MESSAGE_CASES);
});

test("only invalid options throw, and they throw by name", () => {
  runCases(REFUSAL_CASES);
});

test("a 3option answer is read per index, and every refusal keeps its own row", () => {
  runCases(READ_CASES);
});

test("the grammar selects the contract and the actions it admits", () => {
  runCases(GRAMMAR_CASES);
});

test("an unprovable line count is fail-open: [0 lines] and the batch builds (ISSUE-369)", () => {
  // The count an inverted lineRange produces: endLineInclusive 1 - startLine 3 + 1.
  const inverted = 1 - 3 + 1;
  const rows: readonly EntryBatchRow[] = [
    row(1, "Read config.ts", ['line 31 of 100 ends with "retries: 3"'], 100),
    row(2, "Grep stale-deploy", [], inverted),
    row(3, "Bash npm test", [], 0),
    row(4, "Read notes.md", [], 2.5),
  ];
  for (const grammar of ["jsonl-20", "jsonl-20-nokeepall"] as const) {
    const message = entryBatchAskMessage(rows, grammar);
    const lines = message.split("\n").filter(line => /^\d+\. \[/u.test(line));
    assert.equal(lines.length, rows.length, `${grammar}: one row per result, none aborted`);
    assert.ok(lines[0]?.endsWith(" [100 lines]"),
      `${grammar}: the healthy neighbour keeps its own L`);
    assert.ok(lines[1]?.endsWith(" [0 lines]"),
      `${grammar}: the inverted-range row states [0 lines]`);
    assert.ok(lines[2]?.endsWith(" [0 lines]"),
      `${grammar}: the zero-count row states [0 lines]`);
    assert.ok(lines[3]?.endsWith(" [0 lines]"),
      `${grammar}: the non-integer count states [0 lines]`);
  }
  // The pass continues: a count-free verdict on the fail-open row still reads,
  // and its neighbours keep their own refusals.
  const read = parseEntryBatchAnswer('{"2":{"forgetall":true,"summary":"old host"}}',
    [1, 2, 3, 4], "jsonl-20-nokeepall", new Map([[1, 100]]));
  assert.deepEqual(read.map(result => [result.index, result.status]),
    [[1, "refused"], [2, "answered"], [3, "refused"], [4, "refused"]],
    "the fail-open row reads its forgetall; the silent rows keep");
  assert.deepEqual(read[1]?.status === "answered" ? read[1].answer : null,
    { action: "forgetall", summary: "old host" }, "the fail-open row's verdict crosses unchanged");
});
