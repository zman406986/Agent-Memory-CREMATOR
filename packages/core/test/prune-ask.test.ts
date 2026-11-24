import assert from "node:assert/strict";
import { test } from "node:test";
import type { WireStamp } from "../src/verdicts/wire.js";
import { buildPruneAskRows, renderPruneAskTable, PRUNE_ASK_FINAL_LINE, PRUNE_ASK_TABLE_HEADING, nextTable } from "../src/prune/ask.js";
import type { PruneAskRow } from "../src/prune/ask.js";
import { PRUNE_ASK_NOKEEPALL_FINAL_LINE, pruneAskFinalLineOf, pruneAskSystemPromptOf, renderPruneAskRows } from "../src/prune/ask-message.js";
import { parsePruneAnswer } from "../src/prune/ask-answer.js";
import type { PruneAnswerRow } from "../src/prune/ask-answer.js";
import { normalizeTwoVerdictAnswer, normalizeWireTwoVerdictAnswer, SPANS_OUTSIDE_RESULT_CODE, TWO_VERDICT_GATE_CODE } from "../src/prune/two-verdict.js";
import { KEEP_WHOLE_SUMMARY, PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_SYSTEM_PROMPT } from "../src/rules/assets.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import { planCarryOver } from "../src/prune/ask-carry.js";

const encoder = new TextEncoder();
const SESSION = "session-1";

function evidenceOf(
  kind: ToolEvidence["kind"],
  target: string | null = "config.ts",
  paths: readonly PathEvidence[] = [],
): ToolEvidence {
  return {
    kind,
    target: target === null ? null : { key: target, label: target },
    paths,
    source: { nodeId: "", sha256: "", byteLength: 0 },
    sourceRecallId: null,
  };
}

function nodeOf(
  id: string, text: string, evidence = evidenceOf("read"), stepOrdinal = 1,
): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidence, source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

function rowsOf(nodes: readonly ToolResultNode[]): readonly PruneAskRow[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  return buildPruneAskRows(nodes.map(node => ({
    node,
    unit: tracker.unitsFor(node)[0]!,
  })));
}

function stampsFor(rows: readonly PruneAskRow[], round = 1): ReadonlyMap<number, WireStamp> {
  return new Map(rows.map(row => [row.index, { unitId: row.unit.id, answeredInRound: round }]));
}

/** An answer row's outcome as one string, so a table of expected outcomes stays readable. */
function statusOf(row: PruneAnswerRow): string {
  return row.status === "answered" ? "answered" : row.code;
}

/**
 * One merged test's cases: each body receives its row name and puts it on every
 * assertion, so a red run names the case that broke rather than the test.
 */
type RowCase = readonly [name: string, run: (row: string) => void];

function eachRow(cases: readonly RowCase[]): void {
  for (const [name, run] of cases) {
    try {
      run(name);
    } catch (error) {
      throw new Error(`row: ${name} failed`, { cause: error });
    }
  }
}

// --- the table bytes ---------------------------------------------------------
//
// The ask's composition moved to the adapter's fork loop (ISSUE-027): the
// contract, the table and the final line are one appended user turn over main's
// untouched system slot. What stays here is every byte that turn carries, and
// the one-line promise every row makes.

test("a row is one line of text: pinned bytes, collapsed control characters, anchors, and a refused anchor", () => {
  eachRow([
    ["a 100-line row is pinned byte for byte", row => {
      // The 0.3 and 0.7 byte shares land on lines 31 and 71, and both anchors
      // are one short line each — the row is ONE line of text.
      const text = Array.from({ length: 100 }, (_, i) => `row ${String(i + 1)} alpha beta`).join("\n") + "\n";
      const rows = rowsOf([nodeOf("a", text, evidenceOf("read", "config.ts"))]);
      const table = renderPruneAskTable(rows);
      assert.equal(table, [
        PRUNE_ASK_TABLE_HEADING,
        "",
        '1. [read] config.ts (call #1) — line 31 of 100 ends with "row 31 alpha beta"'
          + ' · line 71 of 100 ends with "row 71 alpha beta"',
      ].join("\n"), `row: ${row} — the table bytes`);
      assert.equal(rows.length, 1, `row: ${row} — one row`);
      // The row begins with the assigned index.
      assert.equal(table.split("\n").filter(line => /^\d+\. \[/u.test(line)).length, 1,
        `row: ${row} — one row-like line`);
    }],
    ["kind and path are collapsed to one line, so a row can never be forged", row => {
      const node = nodeOf("a", "content one\ncontent two\n", evidenceOf("glob", "src\r\netc"));
      const rows = buildPruneAskRows([{
        node,
        unit: new UnitTracker({ sessionId: SESSION, barBytes: 1 }).unitsFor(node)[0]!,
      }]);
      const table = renderPruneAskTable(rows);
      assert.ok(table.includes("1. [glob] src etc (call #1) — "), `row: ${row} — ${table}`);
      // Every line that starts with a row-like prefix is one we wrote.
      const forged = table.split("\n").filter(line => /^\d+\. /u.test(line));
      assert.deepEqual(forged.map(line => line.slice(0, 2)), ["1."], `row: ${row} — no forged row`);
    }],
    ["the anchors reach the row, and a row never spans a second line", row => {
      const node = nodeOf("a", "first content line\nsecond content line\n");
      const rows = rowsOf([node]);
      const table = renderPruneAskTable(rows);
      const anchor = rows[0]!.anchor;
      assert.ok("anchors" in anchor, `row: ${row} — the anchor resolved`);
      if (!("anchors" in anchor)) return;
      for (const line of anchor.anchors) assert.ok(table.includes(line), `row: ${row} — ${line}`);
      // Both shares resolve to the only two lines, so the row is one line of text.
      assert.equal(table.split("\n").filter(line => /^\d+\. \[/u.test(line)).length, 1,
        `row: ${row} — one row-like line`);
    }],
    ["a refused anchor is still asked, and says why instead of quoting", row => {
      const node = nodeOf("a", "content\n");
      const unit = new UnitTracker({ sessionId: SESSION, barBytes: 1 }).unitsFor(node)[0]!;
      // No node: the anchor refuses with no bytes read, and the row says so.
      const rows = buildPruneAskRows([{ unit }]);
      assert.ok(rows[0] !== undefined, `row: ${row} — the refused unit is still asked`);
      const table = renderPruneAskTable(rows);
      assert.ok(table.includes("1. [other] (call #1) — anchor unavailable: missing-node"),
        `row: ${row} — ${table}`);
      assert.equal(table.includes('ends with ""'), false, `row: ${row} — a refused row quotes nothing`);
    }],
  ]);
});

test("nokeepall rows carry [L line(s)]; 3option renders the shipped bytes unchanged", () => {
  const text = Array.from({ length: 100 }, (_, i) => `row ${String(i + 1)} alpha beta`).join("\n") + "\n";
  const rows = rowsOf([nodeOf("a", text, evidenceOf("read", "config.ts"))]);
  const shipped = renderPruneAskTable(rows);
  assert.equal(renderPruneAskTable(rows, PRUNE_ASK_TABLE_HEADING, { grammar: "3option" }), shipped,
    "naming 3option explicitly is the shipped path");
  const nokeepall = renderPruneAskTable(rows, PRUNE_ASK_TABLE_HEADING, { grammar: "nokeepall" });
  assert.equal(nokeepall, `${shipped} [100 lines]`,
    "the nokeepall table appends the row's own L and changes nothing else");
  assert.equal(renderPruneAskRows(rows, { grammar: "nokeepall" }),
    `${renderPruneAskRows(rows)} [100 lines]`, "the row renderer carries the option too");
  // A one-line row says "1 line", exactly as the jsonl-20 entry table does.
  const one = rowsOf([nodeOf("b", "only line\n")]);
  assert.match(renderPruneAskRows(one, { grammar: "nokeepall" }), / \[1 line\]$/u);
  // The shown L is the count the answer may name: a whole-range keeplines on
  // this 100-line row parses and normalizes to a clean keep.
  const shown = /\[(\d+) lines?\]/u.exec(nokeepall)?.[1];
  assert.equal(shown, "100", "the row shows its own L");
  const answer = parsePruneAnswer('{"1":{"keeplines":[[1,100],"None"]}}',
    { indices: [1], stamps: stampsFor(rows) }).rows[0];
  assert.ok(answer?.status === "answered");
  assert.ok(answer.answer.verdict.action === "keeplines");
  assert.deepEqual(normalizeTwoVerdictAnswer({
    action: "keeplines",
    ranges: answer.answer.verdict.ranges,
    summary: answer.answer.keeplinesSummary ?? "",
  }, 100), { status: "answered", answer: { action: "keepall" } },
  "the answer names the row's shown L, so it is a keep-whole");
  // A zero-line unit has no line range, so it states its own count as [0 lines]:
  // the opener promises every row ends with its L, and no count is invented.
  const base = rows[0]!;
  const noCount = [{
    ...base,
    unit: { ...base.unit, span: { ...base.unit.span, lineRange: null } },
  }];
  assert.equal(renderPruneAskRows(noCount, { grammar: "nokeepall" }),
    `${renderPruneAskRows(noCount)} [0 lines]`,
    "a zero-line unit ends with its own [0 lines] and changes nothing else");
  assert.match(renderPruneAskRows(noCount, { grammar: "nokeepall" }), / \[0 lines\]$/u,
    "the zero-line row still states a count");
  assert.equal(renderPruneAskRows(noCount, { grammar: "nokeepall" }).split("\n").length, 1,
    "the suffix keeps the row one line per unit");
  // The grammar selectors are the core helpers the table, correction and
  // estimate paths read, so the nokeepall final line is never the shipped one.
  assert.equal(pruneAskFinalLineOf("nokeepall"), PRUNE_ASK_NOKEEPALL_FINAL_LINE);
  assert.equal(pruneAskFinalLineOf("3option"), PRUNE_ASK_FINAL_LINE);
  assert.equal(pruneAskFinalLineOf(), PRUNE_ASK_NOKEEPALL_FINAL_LINE,
    "the absent grammar is the nokeepall closing line");
  assert.equal(pruneAskSystemPromptOf("nokeepall"), PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT);
  assert.equal(pruneAskSystemPromptOf("3option"), PRUNE_ASK_SYSTEM_PROMPT);
  assert.equal(pruneAskSystemPromptOf(), PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT,
    "the absent grammar is the shipped nokeepall prompt");
  assert.throws(() => renderPruneAskRows(rows, { grammar: "nope" as never }),
    /"3option", "nokeepall" or "jsonl-20-nokeepall"/u,
    "an unknown grammar is refused by name");
});

test("an inverted lineRange is fail-open under nokeepall: [0 lines] and the row keeps (ISSUE-334)", () => {
  const rows = rowsOf([nodeOf("a", "one\ntwo\nthree\n")]);
  const base = rows[0]!;
  const inverted = [{
    ...base,
    unit: { ...base.unit, span: { ...base.unit.span,
      lineRange: { startLine: 3, endLineInclusive: 1 } } },
  }];
  // Before the fix this threw a RangeError and killed the whole pass. The
  // corrupt range is fail-open like a corrupt byteRange: the row rides with
  // [0 lines], the count the gate reads as L=0.
  const rendered = renderPruneAskRows(inverted, { grammar: "nokeepall" });
  assert.equal(rendered, `${renderPruneAskRows(inverted)} [0 lines]`,
    "the inverted-range row states [0 lines] and changes nothing else");
  // The pass's own gate reads an inverted range as no count (L=0): every
  // keeplines on the row is refused spans-outside-result, so the unit keeps.
  const answer = parsePruneAnswer('{"1":{"keeplines":[[1,1],"the first line"]}}',
    { indices: [1], stamps: stampsFor(inverted) }).rows[0];
  assert.ok(answer?.status === "answered", "the wire reads the answer");
  if (answer?.status !== "answered") return;
  const gated = normalizeWireTwoVerdictAnswer(answer.answer, null);
  assert.equal(gated.status, "refused", "the gate refuses the span, never applies it");
  assert.equal(gated.status === "refused" ? gated.code : null, SPANS_OUTSIDE_RESULT_CODE,
    "the refusal names the span defect, and the unit keeps");
});

test("the nokeepall final line states its two verdicts and never names keepall", () => {
  assert.equal(PRUNE_ASK_NOKEEPALL_FINAL_LINE.includes("keepall"), false);
  assert.ok(PRUNE_ASK_NOKEEPALL_FINAL_LINE.includes('{"1":{"forgetall":"…"}'));
  assert.ok(PRUNE_ASK_NOKEEPALL_FINAL_LINE.includes('{"keeplines":[[1,3],"None"]}'));
  assert.equal(PRUNE_ASK_NOKEEPALL_FINAL_LINE.includes(KEEP_WHOLE_SUMMARY), true);
});

test("the two-verdict gate refuses a literal keepall and normalizes a whole-range keeplines", () => {
  const keepall = normalizeTwoVerdictAnswer({ action: "keepall" }, 10);
  assert.equal(keepall.status, "refused");
  assert.ok(keepall.status === "refused");
  assert.equal(keepall.code, TWO_VERDICT_GATE_CODE);
  assert.equal(keepall.code, "action-not-in-grammar");
  assert.ok(keepall.message.length > 0);
  // A full range, a touching pair list and an over-covering list all merge to
  // the whole row: each is a clean keep, never a both-ends plan left for apply.
  for (const ranges of [
    [{ from: 1, to: 10 }],
    [{ from: 1, to: 4 }, { from: 5, to: 10 }],
    [{ from: 5, to: 10 }, { from: 1, to: 4 }],
  ]) {
    assert.deepEqual(
      normalizeTwoVerdictAnswer({ action: "keeplines", ranges, summary: KEEP_WHOLE_SUMMARY }, 10),
      { status: "answered", answer: { action: "keepall" } },
      JSON.stringify(ranges));
  }
  // The note does not decide the plan: a full range removes nothing whatever
  // the model called it.
  assert.deepEqual(normalizeTwoVerdictAnswer({
    action: "keeplines", ranges: [{ from: 1, to: 10 }], summary: "nothing dropped",
  }, 10), { status: "answered", answer: { action: "keepall" } });
  // Everything else is left exactly as parsed.
  const partial = { action: "keeplines", ranges: [{ from: 1, to: 9 }], summary: "x" } as const;
  assert.deepEqual(normalizeTwoVerdictAnswer(partial, 10),
    { status: "answered", answer: partial });
  const gapped = {
    action: "keeplines", ranges: [{ from: 1, to: 4 }, { from: 6, to: 10 }], summary: "x",
  } as const;
  assert.deepEqual(normalizeTwoVerdictAnswer(gapped, 10), { status: "answered", answer: gapped });
  const forgetall = { action: "forgetall", summary: "old log" } as const;
  assert.deepEqual(normalizeTwoVerdictAnswer(forgetall, 10),
    { status: "answered", answer: forgetall });
  // L is the row's own count: the same ranges on a longer row are a partial keep.
  assert.deepEqual(normalizeTwoVerdictAnswer({
    action: "keeplines", ranges: [{ from: 1, to: 10 }], summary: KEEP_WHOLE_SUMMARY,
  }, 11), { status: "answered", answer: {
    action: "keeplines", ranges: [{ from: 1, to: 10 }], summary: KEEP_WHOLE_SUMMARY,
  } });
  for (const lineCount of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => normalizeTwoVerdictAnswer({ action: "keepall" }, lineCount), RangeError);
  }
});

test("the contract and the final line state the expected JSON shape", () => {
  // The closing line keeps the two-key shape as a shape (its `…` is a slot in
  // an instruction, not a shipped example); the contract itself gives a whole
  // chain with real values, which the examples guard in `assets.test.ts` parses
  // verbatim. ISSUE-110 moved the chained form out of the closing line's
  // placeholder style and into the prompt.
  assert.ok(PRUNE_ASK_FINAL_LINE.includes('{"1":{"keepall":true},"2":{"forgetall":"…"}}'));
  assert.ok(PRUNE_ASK_SYSTEM_PROMPT.includes(
    '{"1":{"keepall":true},"2":{"forgetall":"a stale build log from the old host"},'
      + '"3":{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}}'));
});

test("indices follow transcript order and identical calls get ordinals", () => {
  const nodes = [
    nodeOf("a", "same\n", evidenceOf("read", "src/a.ts"), 1),
    nodeOf("b", "other\n", evidenceOf("read", "src/b.ts"), 2),
    nodeOf("c", "same again\n", evidenceOf("read", "src/a.ts"), 3),
  ];
  const rows = rowsOf(nodes);
  assert.deepEqual(rows.map(row => row.index), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.anchor.callOrdinal), [1, 1, 2]);
  for (const row of rows) assert.ok("anchors" in row.anchor);
});

// --- reading the answer ------------------------------------------------------

test("every refused row keeps its unit: absent, malformed, unreadable and empty answers", () => {
  eachRow([
    ["an absent index keeps that unit and leaves its neighbours answered", row => {
      const rows = rowsOf([nodeOf("a", "one\n"), nodeOf("b", "two\n"), nodeOf("c", "three\n")]);
      const parsed = parsePruneAnswer('{"1":{"keepall":true},"3":{"keepall":true}}', {
        indices: [1, 2, 3], stamps: stampsFor(rows),
      });
      assert.deepEqual(parsed.rows.map(statusOf), ["answered", "missing-index", "answered"],
        `row: ${row} — statuses`);
      const middle = parsed.rows[1];
      assert.ok(middle?.status === "refused", `row: ${row} — the middle row is refused`);
      if (middle?.status !== "refused") return;
      assert.equal(middle.unitId, rows[1]!.unit.id, `row: ${row} — the refused row keeps its own unit`);
      assert.equal(parsed.rejected.length, 0, `row: ${row} — no stray key was reported`);
    }],
    ["a malformed row keeps its unit and carries the wire parser's code", row => {
      const rows = rowsOf([nodeOf("a", "one\n"), nodeOf("b", "two\n")]);
      const parsed = parsePruneAnswer(
        '{"1":{"keepall":false},"2":{"keeplines":[[3,2],"backwards"]}}',
        { indices: [1, 2], stamps: stampsFor(rows) },
      );
      const [first, second] = parsed.rows;
      assert.ok(first?.status === "refused" && second?.status === "refused",
        `row: ${row} — both rows are refused`);
      if (first?.status !== "refused" || second?.status !== "refused") return;
      assert.equal(first.code, "malformed-row", `row: ${row} — the first row keeps`);
      assert.equal(first.wireCode, "invalid-keepall", `row: ${row} — the wire code for keepall:false`);
      assert.equal(second.wireCode, "invalid-span", `row: ${row} — the wire code for a reversed span`);
      assert.ok(first.message.length > 0 && second.message.length > 0,
        `row: ${row} — every refusal carries a message`);
    }],
    ["an unreadable answer keeps every unit", row => {
      const rows = rowsOf([nodeOf("a", "one\n"), nodeOf("b", "two\n")]);
      for (const answer of ["{", "{\"1\":}", "not json at all", ""]) {
        const parsed = parsePruneAnswer(answer, { indices: [1, 2], stamps: stampsFor(rows) });
        assert.deepEqual(parsed.rows.map(statusOf), ["answer-unreadable", "answer-unreadable"],
          `row: ${row} — answer ${JSON.stringify(answer)}`);
      }
    }],
    ["an empty object keeps every unit, one missing row each", row => {
      const rows = rowsOf([nodeOf("a", "one\n"), nodeOf("b", "two\n")]);
      const parsed = parsePruneAnswer("{}", { indices: [1, 2], stamps: stampsFor(rows) });
      assert.deepEqual(parsed.rows.map(statusOf), ["missing-index", "missing-index"],
        `row: ${row} — both rows are missing`);
    }],
  ]);
});

test("the parsed object form works, rows ascend regardless of answer order, and the parse is pure", () => {
  const rows = rowsOf([nodeOf("a", "one\n"), nodeOf("b", "two\n")]);
  const answer = { "2": { forgetall: "two" }, "1": { keepall: true }, "7": { keepall: true } };
  const before = structuredClone(answer);
  const parsed = parsePruneAnswer(answer, { indices: [1, 2], stamps: stampsFor(rows) });
  assert.deepEqual(parsed.rows.map(row => row.index), [1, 2], "row: answer order — ascending indices");
  const [first, second] = parsed.rows;
  assert.ok(first?.status === "answered" && second?.status === "answered", "row: answer order — both answered");
  assert.equal(first.answer.verdict.action, "keepall", "row: answer order — index 1 keeps all");
  assert.equal(second.answer.verdict.action, "forgetall", "row: answer order — index 2 forgets all");
  // Same answer twice is the same parse, and the answer object is never touched.
  const again = parsePruneAnswer(answer, { indices: [1, 2], stamps: stampsFor(rows) });
  assert.deepEqual(again, parsed, "row: answer order — a second parse is deep-equal");
  assert.deepEqual(answer, before, "row: answer order — the answer is not mutated");
});

// --- the table builder -------------------------------------------------------

/** A node with many lines, so a unit spans enough of them to place two anchors. */
function bigNode(index: number): ToolResultNode {
  const line = Array.from({ length: 120 }, (_, i) => `n${String(index)}w${String(i)}`).join(" ");
  const text = Array.from({ length: 8 }, (_, i) => `${line} block ${String(i)}`).join("\n") + "\n";
  return nodeOf(`big${String(index)}`, text, evidenceOf("read", `src/file${String(index)}.ts`));
}

function bigRows(count: number): readonly PruneAskRow[] {
  const nodes = Array.from({ length: count }, (_, i) => bigNode(i));
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  return buildPruneAskRows(nodes.map(node => ({ node, unit: tracker.unitsFor(node)[0]! })));
}

/** Small rows, 1..count, built the way the pass builds them. */
function smallRows(count: number): readonly PruneAskRow[] {
  const nodes = Array.from({ length: count },
    (_, i) => nodeOf(`s${String(i)}`, `body ${String(i)}\n`,
      evidenceOf("read", `src/f${String(i)}.ts`), i + 1));
  return rowsOf(nodes);
}

test("the builder asks the whole queue: past twelve rows in one table, a huge row whole, an empty queue has no table", () => {
  eachRow([
    ["thirteen rows are one table with every row — no row cap", row => {
      const rows = bigRows(13);
      const table = nextTable(rows);
      assert.equal(table.rows.length, 13, `row: ${row} — every row is tabled`);
      assert.equal(table.carried, 0, `row: ${row} — nothing is carried`);
      assert.deepEqual(table.rows, rows, `row: ${row} — the table is the whole queue, in order`);
      assert.deepEqual(table.rows.map(entry => entry.index),
        rows.map((_, i) => i + 1), `row: ${row} — indices stay stable`);
    }],
    ["a huge row rides whole: no cap counts bytes or cuts a row", row => {
      // Two rows whose rendered table is far past any byte ceiling a split
      // could use: the builder never looks at their bytes and never cuts.
      const rows = bigRows(2);
      const table = nextTable(rows);
      assert.deepEqual(table.rows, rows, `row: ${row} — both rows ride the one table`);
      for (const [position, entry] of table.rows.entries()) {
        assert.equal(entry.anchor, rows[position]!.anchor,
          `row: ${row} — the huge row is intact at position ${String(position)}`);
      }
    }],
    ["the builder is deterministic, mutates nothing and an empty queue has no table", row => {
      const rows = bigRows(13);
      const before = structuredClone(rows);
      assert.deepEqual(nextTable(rows), nextTable(rows), `row: ${row} — same input, same table`);
      assert.deepEqual(rows, before, `row: ${row} — the queue is left untouched`);
      assert.deepEqual(nextTable([]), { rows: [], carried: 0 }, `row: ${row} — an empty queue has no table`);
    }],
  ]);
});

test("carried rows lead the table, however many; a repeated index throws", () => {
  eachRow([
    ["carried rows lead the table and the queue's rest follows whole", row => {
      const rows = smallRows(15);
      const firstTwelve = rows.slice(0, 12);
      // Table 1 answers index 1 only, so indices 2..12 are carried to table 2.
      const settled = planCarryOver(firstTwelve, parsePruneAnswer('{"1":{"keepall":true}}', {
        indices: firstTwelve.map(entry => entry.index), stamps: stampsFor(firstTwelve),
      }).rows);
      assert.equal(settled.carry.length, 11, `row: ${row} — eleven rows are carried`);
      const table = nextTable(rows.slice(12), { carried: settled.carry });
      assert.equal(table.carried, 11, `row: ${row} — the table counts its carried rows`);
      // Carried rows are first, in their own table order, then the WHOLE queue.
      assert.deepEqual(table.rows,
        [...settled.carry.map(entry => entry.row), ...rows.slice(12)],
        `row: ${row} — carried rows lead, then the rest`);
      assert.deepEqual(table.rows.map(entry => entry.index),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        `row: ${row} — carry order then the queue, nothing left untabled`);
    }],
    ["a carried set larger than the old twelve rides whole too", row => {
      const carried = planCarryOver(smallRows(13), []).carry;
      assert.equal(carried.length, 13, `row: ${row} — thirteen rows carried`);
      // No cap: thirteen carried rows are thirteen tabled rows.
      const table = nextTable([], { carried });
      assert.equal(table.rows.length, 13, `row: ${row} — every carried row is tabled`);
      assert.equal(table.carried, 13, `row: ${row} — every row is carried`);
    }],
    ["a repeated index is a caller bug", row => {
      const rows = smallRows(3);
      // A carried row still in the queue would address its unit twice in one table.
      const carried = planCarryOver([rows[0]!], []).carry;
      assert.throws(() => nextTable([rows[0]!], { carried }), /twice/u,
        `row: ${row} — a carried row still queued`);
    }],
  ]);
});
