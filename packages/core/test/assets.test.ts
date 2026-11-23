import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR, ENTRY_ASK_SYSTEM_PROMPT, entryAskFactsBlock, entryAskMessage, KEEP_WHOLE_RULE, KEEP_WHOLE_SUMMARY, MODEL_FACING_STRINGS, negativeFact, PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET, PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT, PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_SYSTEM_PROMPT, receiptLine, shapeMarker, ENTRY_ASK_FRAME, ENTRY_ASK_RESULT_CLOSE, ENTRY_ASK_RESULT_OPEN, RECALL_TOOL_DESCRIPTION, spanMarker } from '../src/rules/assets.js';
// The lane F variant is deliberately not on `rules/assets.js` yet (T-8 wires the
// caller), so this test is the only importer of it.
import { ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT, ENTRY_ASK_TWOFORM_SYSTEM_PROMPT } from '../src/rules/assets-templates.js';
import { EntryAnswerError, isKeepEverythingAnswer, parseEntryAnswer } from '../src/verdicts/entry-wire.js';
import { parseWireVerdict, WireVerdictError } from '../src/verdicts/wire.js';
import type { WireStamp } from '../src/verdicts/wire.js';
// ISSUE-110's examples guard reads the table prompt through the table ask's OWN
// parser, so a prompt line a model copies is proven readable by the code that
// will read its replies.
import { parsePruneAnswer } from '../src/prune/ask-answer.js';
import { toBytes } from '../src/util/bytes.js';
import { sha256Sync } from '../src/util/hash.js';
// T-8, appended without touching T-7's import above: the same template read
// through `rules/assets.js`, so this line is the re-export's compile pin.
import {
  ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT as ENTRY_ASK_FORGETLINES_VIA_ASSETS,
} from '../src/rules/assets.js';
import { readJsonl20Answer, readJsonl20NoKeepallAnswer } from '../src/entry/jsonl-20-answer.js';
import { pathEvidence } from "./rules-fixtures.js";

const noneMatched = "No match in these files for this target. Do not re-read them.";

/**
 * Every `negativeFact` shape this asset renders, one row per case. Each row's
 * `name` is carried into the assertion message so a failure names the case, not
 * the loop index.
 */
const NEGATIVE_FACT_ROWS: readonly {
  name: string;
  input: Parameters<typeof negativeFact>[0];
  expect: string;
}[] = [
  {
    name: "two misses keep entry order",
    input: {
      target: "missingSymbol",
      entries: [
        pathEvidence({ title: "Example", lineCount: 30, byteLength: 2048 }),
        pathEvidence({ displayPath: "src/other.ts", title: "Other", lineCount: 8, byteLength: 80 }),
      ],
      noneMatched,
    },
    expect:
      "[search: missingSymbol] not found in: src/example.ts · Example · 30 lines · 2048 bytes, src/other.ts · Other · 8 lines · 80 bytes\nNo match in these files for this target. Do not re-read them.",
  },
  {
    name: "unknown metadata segments are omitted separately",
    input: {
      target: "needle",
      entries: [
        pathEvidence(),
        pathEvidence({ displayPath: "lines.ts", lineCount: 4 }),
        pathEvidence({ displayPath: "bytes.ts", byteLength: 10 }),
        pathEvidence({ displayPath: "title.ts", title: "Heading" }),
      ],
    },
    expect:
      "[search: needle] not found in: src/example.ts, lines.ts · 4 lines, bytes.ts · 10 bytes, title.ts · Heading\nNo match in these files for this target. Do not re-read them.",
  },
  {
    name: "known zero counts are retained without fabricating metadata",
    input: { target: "needle", entries: [pathEvidence({ lineCount: 0, byteLength: 0 })] },
    expect:
      "[search: needle] not found in: src/example.ts · 0 lines · 0 bytes\nNo match in these files for this target. Do not re-read them.",
  },
  {
    name: "empty entries produce only the target and the noneMatched sentence",
    input: { target: "needle", entries: [], noneMatched },
    expect: "[search: needle] No match in these files for this target. Do not re-read them.",
  },
  {
    name: "hit and unknown paths are never listed as misses",
    input: {
      target: "needle",
      entries: [
        pathEvidence({ displayPath: "hit.ts", outcome: "hit" }),
        pathEvidence({ displayPath: "unknown.ts", outcome: "unknown" }),
        pathEvidence({ displayPath: "miss.ts" }),
      ],
    },
    expect: "[search: needle] not found in: miss.ts\nNo match in these files for this target. Do not re-read them.",
  },
  {
    name: "metadata line breaks cannot add extra model-facing lines",
    input: {
      target: "missing\nsymbol",
      entries: [pathEvidence({ displayPath: "src/\r\nexample.ts", title: "First\nheading" })],
    },
    expect:
      "[search: missing symbol] not found in: src/ example.ts · First heading\nNo match in these files for this target. Do not re-read them.",
  },
];

test("negative facts — one pinned byte literal per row", () => {
  for (const row of NEGATIVE_FACT_ROWS) {
    assert.deepEqual(toBytes(negativeFact(row.input)), toBytes(row.expect), `row: ${row.name}`);
  }
});

/**
 * Every receipt shape this asset renders. A forgetall ships its descriptor; a
 * keeplines ships the removed ranges and no descriptor, which is exactly the
 * floor shape. All of them are one line.
 */
const RECEIPT_ROWS: readonly {
  name: string;
  input: Parameters<typeof receiptLine>[0];
  expect: string;
}[] = [
  {
    name: "topic label",
    input: {
      path: "src/example.ts",
      ranges: [{ startLine: 12, endLineInclusive: 40 }],
      label: "auth retry",
      recallId: "recall:example",
    },
    expect: "[not retained] src/example.ts lines 12–40 — about: auth retry · necromancy recall:example",
  },
  {
    name: "forgetall ships its descriptor",
    input: {
      path: "src/example.ts",
      ranges: [],
      label: "doc header and comments on sandboxing",
      recallId: "r1",
    },
    expect: "[not retained] src/example.ts — about: doc header and comments on sandboxing · necromancy r1",
  },
  {
    name: "keeplines ships the removed ranges and no descriptor",
    input: { path: "src/example.ts", ranges: [{ startLine: 2, endLineInclusive: 3 }], label: null, recallId: "r1" },
    expect: "[not retained] src/example.ts lines 2–3 · necromancy r1",
  },
  {
    name: "disjoint ranges are joined",
    input: {
      path: "src/example.ts",
      ranges: [{ startLine: 1, endLineInclusive: 3 }, { startLine: 9, endLineInclusive: 12 }],
      label: "config defaults",
      recallId: "r1",
    },
    expect: "[not retained] src/example.ts lines 1–3, 9–12 — about: config defaults · necromancy r1",
  },
  {
    name: "a whole node omits the range segment",
    input: { path: "src/example.ts", ranges: [], label: null, recallId: "r1" },
    expect: "[not retained] src/example.ts · necromancy r1",
  },
];

test("receipt lines — one pinned byte literal per row, and every row is one line", () => {
  for (const row of RECEIPT_ROWS) {
    const actual = receiptLine(row.input);
    assert.deepEqual(toBytes(actual), toBytes(row.expect), `row: ${row.name}`);
    assert.equal(actual.includes("\n"), false, `row: ${row.name} — the receipt is one line`);
  }
  const floor = "[not retained] src/example.ts lines 12–40 · necromancy recall:example";
  for (const label of [null, "", "   "]) {
    const actual = receiptLine({
      path: "src/example.ts",
      ranges: [{ startLine: 12, endLineInclusive: 40 }],
      label,
      recallId: "recall:example",
    });
    assert.deepEqual(toBytes(actual), toBytes(floor), `floor label: ${JSON.stringify(label)}`);
  }
});

// --- the entry-shaping marker (ISSUE-056 C2) --------------------------------

/**
 * The marker is a whole LINE (ISSUE-063): its terminator is part of the
 * rendered marker, not the renderer's private business, so a marker spliced
 * before a kept line can never glue its recall id onto that line.
 */
const SHAPE_MARKER_ROWS: readonly {
  name: string;
  input: Parameters<typeof shapeMarker>[0];
  expect: string;
}[] = [
  {
    name: "one kept range",
    input: {
      keptLines: [{ startLine: 1, endLineInclusive: 3 }],
      totalLines: 12,
      droppedBytes: 1234,
      recallId: "recall:sha256:example",
    },
    expect: "[racoons] kept lines 1–3 of 12 · 1234 bytes dropped · necromancy recall:sha256:example\n",
  },
  {
    name: "disjoint kept ranges in the order given",
    input: {
      keptLines: [
        { startLine: 1, endLineInclusive: 3 },
        { startLine: 9, endLineInclusive: 12 },
      ],
      totalLines: 40,
      droppedBytes: 98,
      recallId: "r1",
    },
    expect: "[racoons] kept lines 1–3, 9–12 of 40 · 98 bytes dropped · necromancy r1\n",
  },
  {
    name: "forgetall floor line ships no byte segment",
    input: { keptLines: [], totalLines: 7, droppedBytes: 4096, recallId: "r1" },
    expect: "[racoons] kept 0 of 7 lines · necromancy r1\n",
  },
];

test("shape markers — one pinned byte literal per row, terminator included", () => {
  for (const row of SHAPE_MARKER_ROWS) {
    assert.equal(shapeMarker(row.input), row.expect, `row: ${row.name}`);
  }
});

// --- the shipped big-prune ask prompt (ISSUE-022 chunk 3; ISSUE-110) --------

/**
 * The batch ask's bytes, written out independently of the source constant. This
 * is the pin: the product ships this text verbatim, so any edit to the asset
 * must be an edit to this literal too.
 *
 * ISSUE-110 replaced the shipped text with the owner's approved reshape. It is
 * the entry ask's proven voice (ISSUE-106): one sentence for the row shape,
 * three real single-verdict lines, the chained per-index form assembled by
 * index, the summary rule in words, and "Prune aggressively" with the recall
 * net. The two paragraphs the reshape deleted — the anchor-unavailable
 * "keep it when in doubt" bias and the ~120-word row-format walk — must not
 * come back, which the test below pins by name.
 */
const PRUNE_ASK_PROMPT_PIN = [
  "Memory management: decide what tool results above stay in your memory. Answer about every result listed in the table below. Each row starts with the index you answer with, then the call that made it and quotes from that unit's own lines.",
  "",
  "Answer with exactly one JSON object and no other text. Each key is a row's index; its value is that unit's verdict:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "Assembled by row index:",
  "",
  '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"},"3":{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}',
  "",
  "keeplines keeps the named ranges (1-based, counted on that unit's own lines); the rest is replaced by a required summary, a few words, aim under 15, never over 25. forgetall replaces the whole unit with its summary. Answer every index exactly once; a missing, unknown or repeated key refuses that unit, and a refused unit keeps.",
  "",
  "Prune aggressively: drop anything the immediate task does not need; if you drop too much, the necromancy tool restores the exact bytes.",
].join("\n");

function pinsPruneAskPrompt(text: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(text)) === PRUNE_ASK_PROMPT_PIN;
}

test("the shipped big-prune ask prompt matches its pinned bytes exactly", () => {
  assert.equal(pinsPruneAskPrompt(PRUNE_ASK_SYSTEM_PROMPT), true,
    "the prune ask prompt is a shipped asset; edit PRUNE_ASK_PROMPT_PIN with it");
  assert.deepEqual(new TextEncoder().encode(PRUNE_ASK_SYSTEM_PROMPT),
    new TextEncoder().encode(PRUNE_ASK_PROMPT_PIN));
  // Fifteen lines, pinned independently of the pin above: a reflow that happens
  // to stay readable still moves this count (the shipped prompt was 40 lines).
  assert.equal(PRUNE_ASK_SYSTEM_PROMPT.split("\n").length, 15);
});

// --- the table prompt's examples, through the table's own parser (ISSUE-110) --

/** One assigned index and its unit, in the shape `parsePruneAnswer` stamps. */
function pruneStamps(indices: readonly number[]): ReadonlyMap<number, WireStamp> {
  return new Map(indices.map(index => [index, { unitId: `unit:${String(index)}`,
    answeredInRound: 1 }] as const));
}

/**
 * Every `{"` line the table prompt ships. The prompt shows two kinds: three
 * bare verdicts, each the value of ONE index, and one whole chained answer
 * keyed by indices 1–3.
 */
function pruneExampleLines(): readonly string[] {
  return PRUNE_ASK_SYSTEM_PROMPT.split("\n").filter(line => line.startsWith('{"'));
}

test("every table-prompt example is read verbatim by its own parser, with no slot and no bias", () => {
  // ISSUE-110's mandatory guard, the table counterpart of ISSUE-106's entry
  // guard. A line a model will copy is only honest if `parsePruneAnswer` — the
  // parser this ask's replies go through — reads it back as a verdict, and the
  // expected list below is the approved text's own example set: three bare
  // verdicts and the chained composite. The bug class is measured: the entry
  // prompt shipped `[[X,Y],[A,B],"<summary …>"]` on 2026-10-28, which is not
  // JSON, and it cost 149 refusals in 347 answers.
  const examples = pruneExampleLines();
  assert.deepEqual(examples, [
    '{"keepall":true}',
    '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
    '{"forgetall":"a stale build log from the old host"}',
    '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"},'
      + '"3":{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}',
  ], "the prompt ships exactly the three bare verdicts and the chained composite");
  // The three bare verdicts: each is one index's value, so wrap it the way a
  // model assembles an answer and read it as index 1 of a one-row table.
  for (const example of examples.slice(0, 3)) {
    const parsed = parsePruneAnswer(`{"1":${example}}`,
      { indices: [1], stamps: pruneStamps([1]) });
    assert.equal(parsed.rejected.length, 0, example);
    assert.equal(parsed.rows.length, 1, example);
    assert.equal(parsed.rows[0]?.status, "answered",
      `${example} must parse; got ${JSON.stringify(parsed.rows[0])}`);
  }
  // The chained composite: three keys, in index order, one verdict each — the
  // shape the prompt calls "assembled by row index".
  const chained = examples[3] ?? "";
  const parsed = parsePruneAnswer(chained, { indices: [1, 2, 3], stamps: pruneStamps([1, 2, 3]) });
  assert.equal(parsed.rejected.length, 0);
  assert.deepEqual(parsed.rows.map(row => (row.status === "answered"
    ? row.answer.verdict.action : row.code)), ["keepall", "forgetall", "keeplines"]);
  for (const row of parsed.rows) assert.equal(row.status, "answered", chained);
  // The summaries the prompt teaches are the ones the parser returns, never a
  // slot: a prompt that teaches a summary the parser refuses is a trap, and the
  // parser caps a summary at 25 words and requires it LAST in a keeplines array.
  const keeplinesLine = examples.find(line => line.startsWith('{"keeplines"'));
  assert.ok(keeplinesLine !== undefined);
  const keeplinesParsed = parsePruneAnswer(`{"1":${keeplinesLine}}`,
    { indices: [1], stamps: pruneStamps([1]) });
  const row = keeplinesParsed.rows[0];
  assert.ok(row?.status === "answered");
  const verdict = row.answer.verdict;
  assert.equal(verdict.action, "keeplines");
  assert.ok(verdict.action === "keeplines");
  assert.deepEqual(verdict.ranges, [{ from: 2, to: 3 }],
    "the ranges are the prompt's own, read back as a keep span");
  assert.equal(row.answer.keeplinesSummary,
    "stale run notes: the superseded TODO and the old deploy host");
  // Trailer-only: the table prompt does not teach the sibling `"summary"` key
  // (that is the entry wire's second spelling, ADR-0033). A table answer in the
  // sibling shape is refused, so the prompt must not show one.
  assert.equal(PRUNE_ASK_SYSTEM_PROMPT.includes('"summary":"'), false,
    "the table prompt teaches the trailer only");
  // ISSUE-110's two deliberate deletions, pinned so they cannot creep back:
  // (a) the anchor-unavailable "keep it when in doubt" paragraph — the recall
  // net replaces the doubt clause by the owner's call; (b) the ~120-word
  // row-format walk, replaced by one sentence in the opener.
  assert.equal(PRUNE_ASK_SYSTEM_PROMPT.includes("keep it when in doubt"), false,
    "the keep-when-in-doubt bias is back");
  assert.equal(PRUNE_ASK_SYSTEM_PROMPT.includes("A row begins with the index you answer with"), false,
    "the row-format walk is back");
  // And the reshape's own promises, so a later edit cannot quietly drop them.
  for (const promise of ["Prune aggressively", "the necromancy tool restores the exact bytes",
    "aim under 15, never over 25", "a refused unit keeps"]) {
    assert.equal(PRUNE_ASK_SYSTEM_PROMPT.includes(promise), true, `prompt lost: ${promise}`);
  }
  // No substitute slot survived the reshape.
  for (const token of ["[X,Y]", "[A,B]", "<summary", "<N>", "<id>", "<start", "<end"]) {
    assert.equal(PRUNE_ASK_SYSTEM_PROMPT.includes(token), false, `"${token}" is back`);
  }
});

// --- the entry ask (ISSUE-056 chunk C2, adapted by ISSUE-058 chunk P2) -------

/**
 * The contract's bytes, written out independently of the source constant. This
 * is the pin: the ask ships this text verbatim inside every entry ask, so any
 * edit to the asset must be an edit to this literal too.
 *
 * The ISSUE-106 repair: every example is a whole, valid answer with real
 * numbers and a real short summary, both legal summary spellings are shown, the
 * length limit is stated as words and the "never both" rule is stated rather
 * than implied. The fail-open rule stays in code and is not restated, and the
 * per-result lines are appended by `entryAskMessage`, not part of this constant.
 */
const ENTRY_ASK_PROMPT_PIN = [
  "Memory management: decide what part of the tool result above stays in your memory. Answer about that result only.",
  "",
  "Answer with exactly one JSON object and no other text. One of three keys:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[1,5],[9,12],"stale build log lines"]}',
  '{"keeplines":[[1,5],[9,12]],"summary":"stale build log lines"}',
  '{"forgetall":"one-line summary of the whole result"}',
  "",
  "keeplines keeps the named ranges (1-based, inclusive); the rest is replaced by a required summary that goes last in the array or in a sibling \"summary\" key, never both. A few words, aim under 15, never over 25. forgetall purges everything but the summary; keepall keeps every line.",
  "",
  "Prune aggressively: drop anything the immediate task does not need. If you drop too much, the necromancy tool restores the exact bytes.",
].join("\n");

function pinsEntryAskPrompt(text: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(text)) === ENTRY_ASK_PROMPT_PIN;
}

test("the entry ask contract matches its pinned bytes exactly", () => {
  assert.equal(pinsEntryAskPrompt(ENTRY_ASK_SYSTEM_PROMPT), true,
    "the entry ask contract is a shipped asset; edit ENTRY_ASK_PROMPT_PIN with it");
  assert.deepEqual(new TextEncoder().encode(ENTRY_ASK_SYSTEM_PROMPT),
    new TextEncoder().encode(ENTRY_ASK_PROMPT_PIN));
  assert.equal(ENTRY_ASK_SYSTEM_PROMPT.split("\n").length, ENTRY_ASK_PROMPT_PIN.split("\n").length);
});

/**
 * The three entry-ask lanes and the summary their partial examples carry.
 * ISSUE-106's guard is built on this list: every `{"` line each prompt ships is
 * a promise to the model, and the promise is only kept if `parseEntryAnswer`
 * reads it back byte for byte.
 */
const ENTRY_ASK_EXAMPLES = [
  { lane: "default", prompt: ENTRY_ASK_SYSTEM_PROMPT, partialSummary: "stale build log lines" },
  { lane: "forgetlines", prompt: ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT,
    partialSummary: "stale build log lines" },
  { lane: "twoform", prompt: ENTRY_ASK_TWOFORM_SYSTEM_PROMPT, partialSummary: "None" },
] as const;

/** Every example line a prompt ships: one JSON object per line, by construction. */
function exampleLines(prompt: string): string[] {
  return prompt.split("\n").filter(line => line.startsWith('{"'));
}

// --- lane F's contract (T-7; ADR-0027 §4) and the two-form lane --------------

test("the three lanes keep their arm pairing, their enumerated edits and their inert default", () => {
  // ADR-0027 §4: one partial class per arm, and the shipped prompt is lane K's.
  assert.equal(ENTRY_ASK_SYSTEM_PROMPT.includes("keeplines"), true, "the default lists keeplines");
  assert.equal(ENTRY_ASK_SYSTEM_PROMPT.includes("forgetlines"), false, "the default never lists forgetlines");
  assert.equal(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.includes("forgetlines"), true);
  assert.equal(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.includes("keeplines"), false,
    "lane F lists no keeplines token");
  assert.notEqual(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT, ENTRY_ASK_SYSTEM_PROMPT);
  // One partial class per arm is single-variable only if the framing is
  // otherwise the same text (ADR-0026 §3). Every line the variant changes is a
  // line naming the partial class — the two worked forms and the policy line;
  // the rest, whole-unit classes included, is the default's own bytes.
  const shipped = ENTRY_ASK_SYSTEM_PROMPT.split("\n");
  const variant = ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.split("\n");
  assert.equal(variant.length, shipped.length, "same line count as the default");
  const changed = shipped
    .map((line, index) => (line === variant[index] ? null : index))
    .filter((index): index is number => index !== null);
  assert.deepEqual(changed, [5, 6, 9],
    `expected the two worked forms and the policy line, got ${changed.join(",")}`);
  for (const index of changed) {
    assert.equal(variant[index]?.includes("forgetlines"), true, `line ${String(index)} names the class`);
    assert.equal(shipped[index]?.includes("keeplines"), true, `line ${String(index)} named the other class`);
  }
  // The whole-unit classes stay in both arms (ADR-0027 §2).
  for (const form of ['{"keepall":true}', '{"forgetall":"one-line summary of the whole result"}']) {
    assert.equal(variant.includes(form), true, form);
  }
  // ADR-0026 §2: the same wire shape as keeplines, opposite polarity. The
  // variant's worked rows are the shapes the parser reads, summary last and
  // summary sibling (ADR-0033).
  for (const example of [
    '{"forgetlines":[[1,5],[9,12],"stale build log lines"]}',
    '{"forgetlines":[[1,5],[9,12]],"summary":"stale build log lines"}',
  ]) {
    assert.equal(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.includes(example), true, example);
  }
  assert.equal(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.includes("One of three keys:"), true,
    "three keys on the arm's own contract: keepall, its partial class, forgetall");
  assert.equal(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.includes("the rest stays"), true,
    "forgetlines is the opposite polarity: the named ranges go, the rest stays");
  // Size-rule vocabulary stays out of the variant too. "summary" is the
  // parser's own field name and is allowed by owner ruling.
  const fPrompt = ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT.toLowerCase();
  for (const word of ["cap", "capped", "truncat", "keephead", "first n"]) {
    assert.equal(fPrompt.includes(word), false, `${word} in the F variant`);
  }
  // Inertness: until a caller selects the variant, the message every entry ask
  // ships is built from the shipped contract alone.
  const defaultAsk = entryAskMessage({ lineCount: 12, anchorLines: [] });
  assert.equal(defaultAsk.includes("forgetlines"), false);
  assert.equal(defaultAsk.includes(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT), false);
  assert.equal(defaultAsk.includes(ENTRY_ASK_SYSTEM_PROMPT), true);
  // The experiment's contract: three example lines, one per legal spelling of
  // its two keys. It is the default with an enumerated edit — nothing else may
  // move — so this diff breaks loudly if the shipped copy changes underneath
  // the variant.
  // The anchors the edit depends on, asserted before they are used.
  assert.equal(shipped[0]?.includes("your memory. Answer about that result only."), true,
    "line 0 is the default's own opening");
  assert.equal(shipped[2], "Answer with exactly one JSON object and no other text. One of three keys:",
    "index 2 names three keys; the edit says two");
  assert.equal(shipped[4], '{"keepall":true}', "index 4 is the keepall example, deleted by the edit");
  assert.equal(shipped[5], '{"keeplines":[[1,5],[9,12],"stale build log lines"]}',
    "index 5 is the keeplines trailer example, replaced by the edit");
  assert.equal(shipped[6], '{"keeplines":[[1,5],[9,12]],"summary":"stale build log lines"}',
    "index 6 is the keeplines sibling example, replaced by the edit");
  assert.equal(shipped[9]?.includes(" forgetall purges everything but the summary; keepall"),
    true, "the policy line carries the keepall clause the edit strips");
  const gloss = "`None` says nothing was dropped: either keeplines line covers every line, "
    + "so the whole result stays.";
  const expected = [
    shipped[0],
    shipped[1],
    shipped[2]?.replace("One of three keys:", "One of two keys:"),
    shipped[3],
    '{"keeplines":[[1,201],"None"]}',
    '{"keeplines":[[1,201]],"summary":"None"}',
    shipped[7],
    gloss,
    shipped[8],
    shipped[9]?.replace("; keepall keeps every line.", "."),
    shipped[10],
    shipped[11],
  ].join("\n");
  assert.deepEqual(toBytes(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT), toBytes(expected),
    "the two-form block is the default with exactly the enumerated edits");
  // (a) Neither key of another arm leaks in: no keepall, no forgetlines.
  assert.equal(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.includes("keepall"), false);
  assert.equal(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.includes("forgetlines"), false);
  // (b) and (c) The two-key statement, both full-range examples, the gloss.
  assert.equal(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.includes("One of two keys"), true);
  for (const example of ['{"keeplines":[[1,201],"None"]}', '{"keeplines":[[1,201]],"summary":"None"}']) {
    assert.equal(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.includes(example), true, example);
  }
  assert.equal(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.includes(gloss), true);
  // Three example lines and one gloss line, in the given order.
  const lines = ENTRY_ASK_TWOFORM_SYSTEM_PROMPT.split("\n");
  assert.equal(lines.filter(line => line.startsWith('{"')).length, 3, "three example lines");
  assert.equal(lines.indexOf('{"keeplines":[[1,201],"None"]}') + 1,
    lines.indexOf('{"keeplines":[[1,201]],"summary":"None"}'));
  assert.equal(lines.indexOf('{"keeplines":[[1,201]],"summary":"None"}') + 1,
    lines.indexOf('{"forgetall":"one-line summary of the whole result"}'));
  assert.equal(lines.indexOf(gloss), lines.indexOf(
    '{"forgetall":"one-line summary of the whole result"}') + 1);
  // A prompt that teaches a trap is worse than a terse one: if the sibling
  // `"summary":"None"` spelling were read as a partial plan, the lane would ask
  // for keep-everything and then drop content on the model's own instruction.
  // Both spellings must decode to the same keep-everything answer.
  const twoformExamples = exampleLines(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT)
    .filter(example => example.startsWith('{"keeplines"'));
  assert.equal(twoformExamples.length, 2, "both spellings are shown");
  for (const example of twoformExamples) {
    const answer = parseEntryAnswer(example);
    assert.deepEqual(answer, {
      action: "keeplines",
      ranges: [{ from: 1, to: 201 }],
      summary: "None",
    }, example);
    assert.equal(isKeepEverythingAnswer(answer, 201), true,
      `${example} must be keep-everything, not a partial plan`);
  }
  // The two-form ask's own message keeps the same promises.
  const twoformMessage = entryAskMessage({ lineCount: 201, anchorLines: [], variant: "twoform" });
  assert.equal(twoformMessage.includes(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT), true);
  assert.equal(twoformMessage.includes("None"), true);
  assert.equal(twoformMessage.includes("keepall"), false);
  assert.equal(twoformMessage.includes("forgetlines"), false);
  assert.equal(entryAskFactsBlock({ lineCount: 201, anchorLines: [], variant: "twoform" }),
    "This result has 201 lines, so keeplines ranges sit in [1,201]. "
      + "Quotes to help you locate them:");
});

test("every example line in every lane parses verbatim, and each lane ships the examples its key count promises", () => {
  // ISSUE-106's mandatory guard, and the exact bug it exists for: the prompt
  // that shipped on 2026-10-28 carried `[[X,Y],[A,B],"<summary …>"]`, which is
  // not JSON. The live cost was 149 refusals in 347 answers. So no lane may
  // print a line a model would copy that the parser cannot read: every line
  // starting `{"` goes through `parseEntryAnswer` unchanged, and a partial one
  // must decode with its lane's own summary.
  for (const { lane, prompt, partialSummary } of ENTRY_ASK_EXAMPLES) {
    const examples = exampleLines(prompt);
    assert.ok(examples.length >= 2, `${lane}: the prompt carries its example lines`);
    for (const example of examples) {
      const answer = parseEntryAnswer(example);
      if (answer.action === "keeplines" || answer.action === "forgetlines") {
        assert.equal(answer.summary, partialSummary, `${lane}: ${example}`);
      }
      if (answer.action === "forgetall") {
        assert.equal(answer.summary, "one-line summary of the whole result", `${lane}: ${example}`);
      }
    }
  }
  // The shape half of the guard: lane N and lane F show all three keys (keepall,
  // their partial class twice — trailer and sibling — and forgetall); the
  // two-form lane drops keepall and shows its two keys in both spellings.
  const defaultLines = exampleLines(ENTRY_ASK_SYSTEM_PROMPT);
  assert.deepEqual(defaultLines, [
    '{"keepall":true}',
    '{"keeplines":[[1,5],[9,12],"stale build log lines"]}',
    '{"keeplines":[[1,5],[9,12]],"summary":"stale build log lines"}',
    '{"forgetall":"one-line summary of the whole result"}',
  ]);
  const fLines = exampleLines(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT);
  assert.deepEqual(fLines, [
    '{"keepall":true}',
    '{"forgetlines":[[1,5],[9,12],"stale build log lines"]}',
    '{"forgetlines":[[1,5],[9,12]],"summary":"stale build log lines"}',
    '{"forgetall":"one-line summary of the whole result"}',
  ]);
  assert.deepEqual(exampleLines(ENTRY_ASK_TWOFORM_SYSTEM_PROMPT), [
    '{"keeplines":[[1,201],"None"]}',
    '{"keeplines":[[1,201]],"summary":"None"}',
    '{"forgetall":"one-line summary of the whole result"}',
  ]);
  // No lane prints a substitution slot a model would have to fill: `X`, `Y`,
  // `A`, `B` and `<...>` were the placeholder's tokens, and they are gone.
  for (const { lane, prompt } of ENTRY_ASK_EXAMPLES) {
    for (const token of ["[X,Y]", "[A,B]", "<summary", "<N>", "<id>"]) {
      assert.equal(prompt.includes(token), false, `${lane}: "${token}" is back`);
    }
  }
  // The sentence-coverage half of ISSUE-106's guard. Both rules the rewrite
  // moved into implication are stated again, on the line that carries the
  // policy, on every lane: where the summary goes ("never both") and how long
  // it may be ("aim under 15, never over 25"). A prompt that implies them is
  // what shipped 57 malformed-json and 22 summary-missing refusals.
  for (const { lane, prompt } of ENTRY_ASK_EXAMPLES) {
    const lines = prompt.split("\n");
    assert.equal(lines.length, 12, `${lane}: twelve lines`);
    const policy = lines.filter(line => line.includes("(1-based, inclusive)"));
    assert.equal(policy.length, 1, `${lane}: one policy line names the range notation`);
    const sentence = policy[0] ?? "";
    assert.equal(sentence.includes("never both"), true, `${lane}: summary placement is stated`);
    assert.equal(sentence.includes("aim under 15, never over 25"), true,
      `${lane}: the length limit is stated in words`);
    assert.equal(sentence.includes('sibling "summary" key'), true,
      `${lane}: the sibling spelling is named`);
  }
});

test("a mixed answer is refused by name on both lanes, with the F grammar in play", () => {
  // The parsers are shared and already refuse a mixed answer; nothing here
  // changes them. Both classes parse, so the refusal is what keeps an arm to
  // one class (ADR-0027 §3–§4) — the prompt is the other half of that gate.
  const mixed = { keeplines: [[1, 1], "kept"], forgetlines: [[2, 3], "dropped"] };
  const stamp = { unitId: "unit:sha256:x", answeredInRound: 1 };
  try {
    parseWireVerdict(mixed, stamp);
    assert.fail("a mixed gate answer parsed");
  } catch (error) {
    assert.ok(error instanceof WireVerdictError, `expected WireVerdictError, got ${String(error)}`);
    assert.equal(error.code, "mixed-keys");
    assert.equal(error.message.includes("exactly one action key"), true);
  }
  try {
    parseEntryAnswer(JSON.stringify(mixed));
    assert.fail("a mixed entry answer parsed");
  } catch (error) {
    assert.ok(error instanceof EntryAnswerError, `expected EntryAnswerError, got ${String(error)}`);
    assert.equal(error.code, "mixed-keys");
    // ADR-0033: the entry message names one action key, since a partial answer
    // may now pair it with a sibling `summary`; the gate lane's is unchanged.
    assert.equal(error.message.includes("exactly one action key"), true);
  }
});

test("the entry ask is the contract, the range sentence, the quotes, the closing line — and no body byte", () => {
  const message = entryAskMessage({ lineCount: 201, anchorLines: [
    'line 67 ends with "the deploy host, then"',
    'line 134 ends with "the retry count holds"',
  ] });
  assert.equal(
    message,
    `${ENTRY_ASK_SYSTEM_PROMPT}\n\n`
      + "This result has 201 lines, so keeplines ranges sit in [1,201]. "
      + "Quotes to help you locate them:\n"
      + 'line 67 ends with "the deploy host, then"\n'
      + 'line 134 ends with "the retry count holds"\n\n'
      + ENTRY_ASK_CLOSING_LINE,
  );
  // The range sentence is the one place N is stated, so no quote restates it.
  assert.equal(message.split("This result has 201 lines").length - 1, 1, "N is stated once");
  assert.equal(message.includes(" of 201"), false, "no quote restates the total");
  // N <= 100 gives k = 0, so no quote line exists; the range sentence still
  // ships and the message gains no blank slot of its own.
  assert.equal(entryAskMessage({ lineCount: 99, anchorLines: [] }),
    `${ENTRY_ASK_SYSTEM_PROMPT}\n\n`
      + "This result has 99 lines, so keeplines ranges sit in [1,99]. "
      + `Quotes to help you locate them:\n\n${ENTRY_ASK_CLOSING_LINE}`);
  assert.equal(entryAskMessage({ lineCount: 99, anchorLines: [] }).includes("\n\n\n"), false,
    "no empty anchor slot");
  // ADR-0022 §Context: the shipped ask copied the body into the question,
  // which doubled it on the wire. The new signature has no body parameter at
  // all, so the only way a body could reach the ask is through the count. This
  // pin feeds a body the old renderer would have embedded and asserts not one
  // byte of it survives.
  const body = [
    "src/example.ts:12 — export function loadConfig(",
    "const staleDeployHost = 'rsync://old-host/deploy';",
    "----- the result ends above -----",
  ].join("\n");
  const bodyFree = entryAskMessage({ lineCount: 3, anchorLines: [] });
  for (const line of body.split("\n")) {
    assert.equal(bodyFree.includes(line), false, `the body line leaked: ${line}`);
  }
  assert.equal(bodyFree.includes("loadConfig"), false);
  assert.equal(bodyFree.includes("old-host"), false);
  // The whole message is the contract plus the range sentence plus the closing
  // line: no result bytes can hide in the gaps either.
  assert.equal(bodyFree.length,
    ENTRY_ASK_SYSTEM_PROMPT.length
      + "\n\nThis result has 3 lines, so keeplines ranges sit in [1,3]. Quotes to help you locate them:\n\n".length
      + ENTRY_ASK_CLOSING_LINE.length,
    "the ask's size is fixed by the contract and the facts, never by a body");
  // ISSUE-058 P2, ADR-0022 §9: a first-N prefix is not an answer class, so the
  // shipped contract may not mention it or hint at it in prose.
  const prompt = ENTRY_ASK_SYSTEM_PROMPT.toLowerCase();
  for (const word of ["keephead", "first n", "first twelve", "first 12", "prefix",
    "copied exactly", "copied verbatim", "fences", "the result itself",
    "cap", "capped", "truncat", "omitted", "tombstone"]) {
    assert.equal(prompt.includes(word), false, `${word} in the entry ask contract`);
  }
  assert.equal(ENTRY_ASK_SYSTEM_PROMPT.includes("unitId"), false);
  assert.equal(ENTRY_ASK_SYSTEM_PROMPT.includes('"action"'), false);
});

test("the closing line is the message's last line and carries the end anchor exactly once", () => {
  const message = entryAskMessage({ lineCount: 12, anchorLines: ['line 6 ends with "x"'] });
  assert.equal(message.endsWith(`\n${ENTRY_ASK_CLOSING_LINE}`), true);
  assert.equal(message.split("\n").at(-1), ENTRY_ASK_CLOSING_LINE);
  // The anchor occurs exactly once in the whole ask, and only inside the
  // closing line. A rig matcher anchors on this token at the end of the
  // message (`${escaped} $`), never on a body-contains test.
  assert.equal(message.split(ENTRY_ASK_END_ANCHOR).length - 1, 1);
  assert.equal(ENTRY_ASK_CLOSING_LINE.split(ENTRY_ASK_END_ANCHOR).length - 1, 1);
  for (const block of [...MODEL_FACING_STRINGS, ENTRY_ASK_SYSTEM_PROMPT]) {
    assert.equal(block.includes(ENTRY_ASK_END_ANCHOR), false, block);
  }
  // The literal is an end anchor a body is structurally unlikely to contain:
  // a fixed prefix, 24 random-looking hex characters, and a close.
  assert.match(ENTRY_ASK_END_ANCHOR, /^\[\[entry-ask-end:[0-9a-f]{24}\]\]$/u);
  assert.equal(ENTRY_ASK_END_ANCHOR.includes(" "), false);
  // ISSUE-058 P2 keeps these constants byte for byte: the rig and the bench
  // matchers key on the end anchor, and the fence literals are still exported
  // for a caller that brackets a body. Only the ask's composition changed.
  assert.equal(ENTRY_ASK_END_ANCHOR, "[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]");
  assert.equal(ENTRY_ASK_CLOSING_LINE,
    `Answer with one JSON object for the result above and nothing else. ${ENTRY_ASK_END_ANCHOR}`);
  assert.equal(ENTRY_ASK_FRAME,
    "The incoming tool result follows, copied verbatim between two fence lines.");
  assert.equal(ENTRY_ASK_RESULT_OPEN, "----- the result begins below, verbatim -----");
  assert.equal(ENTRY_ASK_RESULT_CLOSE, "----- the result ends above -----");
});

// --- the variant seam's core surface (T-8; appended after T-7 landed) -------

test("the F variant seam: one re-export, no moved byte, and an unknown variant refused by name", () => {
  // The aliased import above is the compile pin for the re-export from
  // `rules/assets.js`; this is the runtime pin that it is the same constant and
  // that naming a variant changed neither prompt's bytes (T-7 owns them).
  assert.equal(ENTRY_ASK_FORGETLINES_VIA_ASSETS, ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT,
    "rules/assets.js must re-export the one F variant, not a copy of it");
  assert.deepEqual(toBytes(ENTRY_ASK_SYSTEM_PROMPT), toBytes(ENTRY_ASK_PROMPT_PIN),
    "the shipped contract's bytes are the pin, untouched by the seam");
  assert.equal(sha256Sync(toBytes(ENTRY_ASK_SYSTEM_PROMPT)),
    "202bff909c7297454f4f73d0222e1dacb1950984a686ff8db73240e418ca7eb6",
    "the shipped contract's sha moved; T-7 owns those bytes");
  assert.equal(sha256Sync(toBytes(ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT)),
    "d5d318cec1c81846ed60c1140943dc38b3a8bfb53a97318bbd9074977a8ed24f",
    "the F variant's sha moved; T-7 owns those bytes");
  // The selector: unset and 'default' are one path, 'forgetlines' is the other,
  // and both swaps happen in the contract slot alone.
  const shipped = entryAskMessage({ lineCount: 3, anchorLines: [] });
  assert.equal(entryAskMessage({ lineCount: 3, anchorLines: [], variant: "default" }), shipped);
  assert.equal(sha256Sync(toBytes(shipped)),
    "0abb8f67feb2eb8a0fae188e48cc455297b17429ebfda1287a615360e97a3411",
    "the default ask path moved; the seam must be byte-identical when unset");
  const variant = entryAskMessage({ lineCount: 3, anchorLines: [], variant: "forgetlines" });
  assert.equal(variant,
    `${ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT}\n\n`
      + "This result has 3 lines, so forgetlines ranges sit in [1,3]. "
      + `Quotes to help you locate them:\n\n${ENTRY_ASK_CLOSING_LINE}`);
  assert.equal(sha256Sync(toBytes(variant)),
    "9daf24b4464ac804eb04e9e5351a6708cb7da6f4244be65f6db80e3c2dea7a3f");
  assert.equal(variant.endsWith(ENTRY_ASK_CLOSING_LINE), true,
    "the end anchor is shared: a rig matcher names both arms' asks");
  // Critic blocker B1. Typed callers cannot name a third variant; a JS caller,
  // a rig's JSON config and a bench can, and a typo'd arm must not silently
  // ship the default contract.
  assert.throws(
    () => entryAskMessage({ lineCount: 3, anchorLines: [], variant: "keeplines" as never }),
    (error: unknown) => error instanceof Error
      && error.message.includes('unknown variant "keeplines"')
      && error.message.includes("default, forgetlines"),
  );
  assert.throws(
    () => entryAskMessage({ lineCount: 3, anchorLines: [], variant: "" as never }),
    /unknown variant ""/u,
  );
  // The two known variants still render, and the unset path is the default's.
  assert.equal(entryAskMessage({ lineCount: 3, anchorLines: [], variant: "default" }),
    entryAskMessage({ lineCount: 3, anchorLines: [] }));
  assert.equal(entryAskMessage({ lineCount: 3, anchorLines: [], variant: "forgetlines" })
    .includes('{"forgetlines":[[1,5],[9,12],"stale build log lines"]}'), true);
});

// --- the two-verdict prompts (ISSUE-221) ------------------------------------

test("the bulk nokeepall prompt teaches only forgetall and keeplines, and every example parses", () => {
  const prompt = PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT;
  // The grammar's whole point: the literal is absent from every byte.
  assert.equal(prompt.includes("keepall"), false, "keepall is back in the nokeepall prompt");
  assert.equal(prompt.includes(KEEP_WHOLE_RULE), true, "the shared whole-result rule is missing");
  assert.equal(prompt.includes(KEEP_WHOLE_SUMMARY), true, "the shared None note is missing");
  assert.equal(prompt.includes("[L line(s)]"), true, "the opener names the row's line count");
  // The renderer appends the count LAST, so the opener says so: index, call,
  // quotes, then the count, never the other way round.
  assert.match(prompt.split("\n")[0] ?? "",
    /quotes from that unit's own lines, and ends with that unit's line count/u,
  "the opener states the byte order the renderer produces");
  const examples = prompt.split("\n").filter(line => line.startsWith('{"'));
  assert.deepEqual(examples, [
    '{"forgetall":"a stale build log from the old host"}',
    '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
    '{"keeplines":[[1,6],"None"]}',
    '{"1":{"forgetall":"a stale build log from the old host"},"2":{"keeplines":[[1,6],"None"]}}',
  ], "the prompt ships the three bare verdicts and the chained composite");
  // No fixed whole-range literal: the rule names the row's own L and the
  // examples use a small row, so a copied 120 cannot outlive its row.
  assert.equal(prompt.includes("[[1,120]]"), false, "a fixed whole-range literal is back");
  assert.match(KEEP_WHOLE_RULE, /that row's own L/u,
    "the rule names the row's own L, not a fixed number");
  for (const example of examples.slice(0, 3)) {
    const parsed = parsePruneAnswer(`{"1":${example}}`,
      { indices: [1], stamps: pruneStamps([1]) });
    assert.equal(parsed.rejected.length, 0, example);
    assert.equal(parsed.rows[0]?.status, "answered",
      `${example} must parse; got ${JSON.stringify(parsed.rows[0])}`);
  }
  const chained = examples[3] ?? "";
  const parsed = parsePruneAnswer(chained, { indices: [1, 2], stamps: pruneStamps([1, 2]) });
  assert.deepEqual(parsed.rows.map(row => (row.status === "answered"
    ? row.answer.verdict.action : row.code)), ["forgetall", "keeplines"], chained);
  // The whole-range example is the shared keep-whole shape, and its summary is
  // the shared note. Its range ends at the six-line example row's own L.
  const whole = parsed.rows[1];
  assert.ok(whole?.status === "answered");
  assert.ok(whole.answer.verdict.action === "keeplines");
  assert.deepEqual(whole.answer.verdict.ranges, [{ from: 1, to: 6 }]);
  assert.equal(whole.answer.keeplinesSummary, KEEP_WHOLE_SUMMARY);
  // The bulk reader is the wire parser, which takes the trailer only: the
  // sibling `"summary"` spelling belongs to the entry wire and must not appear.
  assert.equal(prompt.includes('"summary":"'), false, "the bulk prompt teaches the trailer only");
});

const NO_KEEPALL_ENTRY_PROMPTS = [
  ["first prompt", PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT],
  ["later prompt", PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT],
  ["first repeat", PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT],
  ["later repeat", PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT],
] as const;

test("every jsonl-20-nokeepall example parses through the real reader, with no keepall and no placeholder", () => {
  for (const [lane, prompt] of NO_KEEPALL_ENTRY_PROMPTS) {
    assert.equal(prompt.includes("keepall"), false, `${lane}: keepall is back`);
    if (lane.endsWith("prompt")) {
      assert.equal(prompt.includes(KEEP_WHOLE_RULE), true, `${lane}: the shared rule is missing`);
    }
    assert.equal(prompt.includes('"forgotten":"None"'), true, `${lane}: the None spelling is missing`);
    assert.equal(prompt.includes("[[1,120]]"), false,
      `${lane}: a fixed whole-range literal is back`);
    const examples = exampleLines(prompt);
    assert.ok(examples.length >= 2, `${lane}: the prompt carries its examples`);
    for (const example of examples) {
      const record = JSON.parse(example) as Record<string, Record<string, unknown>>;
      const keys = Object.keys(record);
      assert.equal(keys.length, 1, `${lane}: one row per line — ${example}`);
      const key = keys[0] ?? "";
      const index = Number(key);
      const verdict = record[key] ?? {};
      // The row's own L is the shown count: the range's last line for a
      // keeplines example, and 1 for a forgetall row, which reads no range.
      const pairs = verdict["keeplines"] as readonly (readonly [number, number])[] | undefined;
      const lineCount = pairs === undefined ? 1 : Math.max(...pairs.map(pair => pair[1]));
      const reading = readJsonl20NoKeepallAnswer(example, [index], new Map([[index, lineCount]]));
      const row = reading.rows[0];
      assert.equal(row?.status, "answered",
        `${lane}: ${example} must parse; got ${JSON.stringify(row)}`);
      assert.ok(row?.status === "answered");
      const answer = row.answer;
      if (answer.action === "keepall") {
        // The reader already turned the shown-L full-range row into the clean
        // keep-whole the apply path expects; the summary did not decide it.
        assert.ok(pairs !== undefined, `${lane}: ${example} parsed as an unconditional keep`);
        assert.equal(pairs.length === 1 && pairs[0]?.[0] === 1 && pairs[0][1] === lineCount,
          true, `${lane}: ${example} is a whole-range keep`);
        continue;
      }
      assert.equal(answer.action === "forgetall" || answer.action === "keeplines", true,
        `${lane}: ${example} parsed as ${answer.action}`);
    }
  }
  // L is the row's own count: the same example on a 50-line row is a range past
  // it, and a 50-line whole range is the keep-whole.
  const long = readJsonl20NoKeepallAnswer('{"1":{"keeplines":[[1,120]],"summary":"None"}}',
    [1], new Map([[1, 50]]));
  assert.equal(long.rows[0]?.status === "refused" ? long.rows[0].code : null,
    "spans-outside-result", "120 is not a universal L");
  const fifty = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,50]],"summary":"a different note"}}', [1], new Map([[1, 50]]));
  assert.deepEqual(fifty.rows[0]?.status === "answered" ? fifty.rows[0].answer : null,
    { action: "keepall" }, "a whole-range keep is keepall whatever the summary says");
});

test("the two nokeepall trigger variants differ only in the share line, which drops the whole-unit sentence", () => {
  assert.equal(
    PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT.replace(
      PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET),
    PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT,
    "the pre-table halves differ only in the share line");
  assert.equal(
    PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT.replace(
      PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET),
    PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT,
    "the repeats differ only in the share line");
  for (const target of [PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET,
    PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET]) {
    assert.equal(target.includes("keep some units"), false,
      "the whole-unit share sentence is back");
    assert.equal(target.includes("percent"), true, "the aggregate target survives");
  }
  assert.match(PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET, /70 percent/u);
  assert.match(PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_TARGET, /40 percent/u);
  assert.equal(PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT.includes(
    PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET), false, "a later prompt never carries 70 percent");
  assert.equal(PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT.includes(
    PRUNE_ASK_JSONL_20_NOKEEPALL_FIRST_TARGET), false, "a later repeat never carries 70 percent");
});

test("span marker substitutes the recall id using the PRD punctuation", () => {
  assert.equal(
    spanMarker({
      shownLines: { startLine: 4, endLineInclusive: 9 },
      totalLines: 20,
      path: "src/example.ts",
      recallId: "r1",
    }),
    "[Showing lines 4–9 of 20 in src/example.ts. Full content restorable via necromancy r1.]",
  );
});

test("model-facing inventory includes all templates and the exact recall description", () => {
  assert.equal(RECALL_TOOL_DESCRIPTION, "Injects your memory with a toolcall result you choose to forget earlier. DO NOT use"
    + " unless you need that exact result AND the tool can no longer be re-run normally.");
  // The two shape markers are whole LINES, terminator included (ISSUE-063).
  for (const literal of [
    "[racoons] kept lines <ranges> of <N> · <B> bytes dropped · necromancy <id>\n",
    "[racoons] kept 0 of <N> lines · necromancy <id>\n",
    "[search: <target>] not found in: <path> · <title or first heading> · <lines> · <size>, …",
    "No match in these files for this target. Do not re-read them.",
    "[search: <target>] No match in these files for this target. Do not re-read them.",
    "[Showing lines X–Y of N in <path>. Full content restorable via necromancy id.]",
    "[not retained] <path> <ranges> — about: <label> · necromancy <id>",
    "[not retained] <path> <ranges> · necromancy <id>",
    "Injects your memory with a toolcall result you choose to forget earlier. DO NOT use"
    + " unless you need that exact result AND the tool can no longer be re-run normally.",
  ]) {
    assert.ok(MODEL_FACING_STRINGS.includes(literal), literal);
  }
});
