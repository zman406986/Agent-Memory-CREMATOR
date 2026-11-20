import assert from "node:assert/strict";
import { test } from "node:test";
import { ANCHOR_LINES_PER_ANCHOR, ANCHOR_NO_SPACE_TAIL_CODE_POINTS, ANCHOR_QUOTE_MAX_CODE_POINTS, ANCHOR_QUOTE_MAX_WORDS, ANCHOR_QUOTE_MIN_CODE_POINTS, ENTRY_ASK_MIN_QUOTE_LINES, anchorsAt, anchorsFor, blankBandNotice, quoteCountOf, quoteLineTail, entryPositions } from '../src/rules/anchors.js';

/**
 * The anchor subsystem (ISSUE-058 chunk AN-2; ADR-0022 §5–§8; the binding
 * design at `docs/plans/2026-10-26-anchor/design.md`).
 *
 * A test that cannot fail is not evidence: every expected string below is
 * written out literally from the design's own tables, never recomputed from
 * the implementation. The fixtures are realistic file-content lines, because
 * the quoting rules were chosen against real tool output.
 */

/** A content line the way a worker log renders it; distinct per line number. */
function contentLine(lineNumber: number): string {
  return `2026-10-26T04:12:07Z INFO worker: step ${String(lineNumber)} done`;
}

/** `count` lines, with the named 1-based lines replaced. */
function fill(count: number, overrides: ReadonlyMap<number, string> = new Map()): string[] {
  const lines: string[] = [];
  for (let lineNumber = 1; lineNumber <= count; lineNumber += 1) {
    lines.push(overrides.get(lineNumber) ?? contentLine(lineNumber));
  }
  return lines;
}

const codePoints = (value: string): string[] => Array.from(value);

test("the design's five numbers are pinned as data", () => {
  assert.equal(ANCHOR_QUOTE_MAX_WORDS, 6);
  assert.equal(ANCHOR_QUOTE_MAX_CODE_POINTS, 40);
  assert.equal(ANCHOR_NO_SPACE_TAIL_CODE_POINTS, 30);
  assert.equal(ANCHOR_QUOTE_MIN_CODE_POINTS, 3);
  assert.equal(ANCHOR_LINES_PER_ANCHOR, 100);
  assert.equal(ENTRY_ASK_MIN_QUOTE_LINES, 2, "a tabled row shows two quotes (ADR-0042)");
});

/**
 * Every `quoteLineTail` case, one row per rule. `expect` is written out
 * literally from the design's tables; the row's `name` reaches the assertion
 * message, so a failure names the rule that broke.
 */
const QUOTE_ROWS: readonly { name: string; line: string; expect: string }[] = [
  // A CRLF line is quoted after its trailing CR is trimmed; the CR is
  // whitespace even when it is the whole line.
  { name: "CRLF: trailing CR trimmed",
    line: "    at Object.<anonymous> (/srv/app/test/deploy.test.js:41:9)\r",
    expect: "(/srv/app/test/deploy.test.js:41:9)" },
  { name: "CRLF: a lone CR is empty", line: "\r", expect: "" },
  { name: "CRLF: a bare CRLF is empty", line: "\r\n", expect: "" },
  // An emoji line is cut on code points, never splitting a surrogate pair.
  { name: "emoji: thirty code points", line: "😀".repeat(35), expect: "😀".repeat(30) },
  // A leading BOM survives, and it is a separator rather than content.
  { name: "BOM: stripped from the head", line: "\uFEFFfirst line content", expect: "first line content" },
  { name: "BOM: alone is empty", line: "\uFEFF", expect: "" },
  // Trailing spaces and tabs are trimmed before quoting. NBSP and U+FEFF are in
  // the whitespace set; a C0 control is whitespace too — a trailing NUL trims,
  // an inner one separates.
  { name: "whitespace: trailing spaces and tabs trimmed",
    line: "total 148 rows written\t   ", expect: "total 148 rows written" },
  { name: "whitespace: spaces and tabs alone are empty", line: "   \t  ", expect: "" },
  { name: "whitespace: NBSP and U+FEFF trim", line: "alpha beta\u00a0\uFEFF", expect: "alpha beta" },
  { name: "whitespace: a trailing NUL trims", line: "panel\u0000", expect: "panel" },
  { name: "whitespace: an inner control separates", line: "a\u0007b", expect: "a b" },
  // The quote is the last six whole words joined by single spaces.
  { name: "words: last six whole words",
    line: "2026-10-26T04:12:07Z INFO worker: job 41 finished in 1.8s",
    expect: "worker: job 41 finished in 1.8s" },
  { name: "words: mixed spacing collapses to one space",
    line: "a  b   c\td\r\nwords with  mixed   spacing at the end",
    expect: "with mixed spacing at the end" },
  { name: "words: tabs and spaces split the same way",
    line: "2026-10-26T04:12:07Z\tINFO\tworker\tjob 41\tfinished",
    expect: "INFO worker job 41 finished" },
  { name: "words: the line's own spacing is not reproduced",
    line: "PASS  src/engine/planning.ts   41 tests   ok",
    expect: "PASS src/engine/planning.ts 41 tests ok" },
  // A quote over forty code points drops leading words and keeps the last.
  { name: "cap: forty-code-point ceiling drops the leading words",
    line: "Error: connect ECONNREFUSED 127.0.0.1:5432 after 3000ms timeout",
    expect: "127.0.0.1:5432 after 3000ms timeout" },
  { name: "cap: the design's own table entry",
    line: "2026-10-26T04:12:07Z INFO worker job 41 finished",
    expect: "INFO worker job 41 finished" },
  // A no-space minified line quotes its last thirty code points.
  { name: "no-space: last thirty code points",
    line: '{"id":41,"path":"/var/log/app/ingest.jsonl","bytes":148000,"status":"ok"}',
    expect: ',"bytes":148000,"status":"ok"}' },
  // A lone over-long word is answered by the no-space rule, and a prefix word
  // never rides along with a last word that alone exceeds forty.
  { name: "no-space: a lone digest tail",
    line: `sha256:${"0123456789abcdef".repeat(4)}`,
    expect: "0123456789abcdef".repeat(4).slice(-30) },
  { name: "no-space: no prefix rides along with an over-long word",
    line: `id ${"x".repeat(50)}`, expect: "x".repeat(30) },
  // A blank line and a sub-three-code-point line have no quote; exactly three
  // code points still anchors.
  { name: "floor: an empty line", line: "", expect: "" },
  { name: "floor: one brace", line: "}", expect: "" },
  { name: "floor: one digit", line: "1", expect: "" },
  { name: "floor: two ASCII code points", line: "ab", expect: "" },
  { name: "floor: two CJK code points", line: "中文", expect: "" },
  { name: "floor: exactly three code points anchors", line: "});", expect: "});" },
];

/** The rows that test trimming and code-point cutting, split off so a failure names its class. */
const QUOTE_TRIM_ROWS = QUOTE_ROWS.filter(row =>
  /^(CRLF|emoji|BOM|whitespace):/u.test(row.name));

/** The rows that test the word, cap, no-space and floor rules. */
const QUOTE_WORD_ROWS = QUOTE_ROWS.filter(row => !QUOTE_TRIM_ROWS.includes(row));

test("the quoted tail trims whitespace and cuts on code points — one rule per row", () => {
  assert.ok(QUOTE_TRIM_ROWS.length >= 10, "the trim class is populated");
  for (const row of QUOTE_TRIM_ROWS) {
    assert.equal(quoteLineTail(row.line), row.expect, `row: ${row.name}`);
  }
  // The emoji quote's length is part of the code-point rule, not an accident.
  const emojiQuote = quoteLineTail("😀".repeat(35));
  assert.equal(codePoints(emojiQuote).length, 30, "row: emoji — thirty code points");
  assert.equal(emojiQuote.length, 60, "row: emoji — thirty surrogate pairs, sixty UTF-16 units");
  assert.doesNotMatch(emojiQuote, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    "row: emoji — no lone surrogate survives");
});

test("the quoted tail caps words, code points and the no-space tail — one rule per row", () => {
  assert.ok(QUOTE_WORD_ROWS.length >= 10, "the word class is populated");
  for (const row of QUOTE_WORD_ROWS) {
    assert.equal(quoteLineTail(row.line), row.expect, `row: ${row.name}`);
  }
  // The forty-code-point cap is measured, not assumed, on the rows above.
  assert.equal(codePoints("127.0.0.1:5432 after 3000ms timeout").length, 35,
    "row: cap — the kept quote is 35 code points");
  assert.equal(codePoints("ECONNREFUSED 127.0.0.1:5432 after 3000ms timeout").length, 48,
    "row: cap — six words would exceed forty here");
  const minified = '{"id":41,"path":"/var/log/app/ingest.jsonl","bytes":148000,"status":"ok"}';
  assert.equal(codePoints(quoteLineTail(minified)).length, 30,
    "row: no-space — exactly thirty code points");
});

test("N = 201 anchors lines 67 and 134 with their quoted tails", () => {
  const lines = fill(201, new Map([
    [67, "wrote 148 rows to /var/log/app/ingest.jsonl"],
    [134, "    at Object.<anonymous> (/srv/app/test/deploy.test.js:41:9)"],
  ]));
  // The entry seam states N once, in the ask's range sentence, so its anchors
  // carry a bare line number. `anchorsAt` unset still appends ` of N`.
  assert.deepEqual(anchorsFor(lines), [
    'line 67 ends with "148 rows to /var/log/app/ingest.jsonl"',
    'line 134 ends with "(/srv/app/test/deploy.test.js:41:9)"',
  ]);
  assert.deepEqual(anchorsAt(lines, [67, 134]), [
    'line 67 of 201 ends with "148 rows to /var/log/app/ingest.jsonl"',
    'line 134 of 201 ends with "(/srv/app/test/deploy.test.js:41:9)"',
  ], "the prune lane keeps the total on every row");
});

test("entry positions follow count = max(2, floor(N/100)) and m = max(1, floor(N/(count+1)))", () => {
  // ADR-0042 Decision 3's worked cases, written out literally: every body of
  // two or more lines names at least two positions, two- and three-line bodies
  // name two distinct ones, and every N >= 200 keeps its old count and places.
  const rows: readonly (readonly [number, readonly number[]])[] = [
    [0, []],
    [1, []],
    [2, [1, 2]],
    [3, [1, 2]],
    [25, [8, 16]],
    [60, [20, 40]],
    [99, [33, 66]],
    [100, [33, 66]],
    [150, [50, 100]],
    [199, [66, 132]],
    [200, [66, 132]],
    [201, [67, 134]],
    [250, [83, 166]],
    [300, [75, 150, 225]],
    [500, [83, 166, 249, 332, 415]],
  ];
  for (const [n, expect] of rows) {
    assert.deepEqual(entryPositions(n), expect, `row: N = ${String(n)}`);
  }
});

test("a short body now anchors: 25 lines gives two quotes, 100 gives two, 2 gives two distinct", () => {
  // The ISSUE-186 row was 25 lines and rendered bare. Under ADR-0042 it names
  // two lines from the body it has.
  const short = anchorsFor(fill(25));
  assert.deepEqual(short, [
    'line 8 ends with "INFO worker: step 8 done"',
    'line 16 ends with "INFO worker: step 16 done"',
  ], "row: N = 25 anchors lines 8 and 16");
  assert.equal(quoteCountOf(short), 2, "row: N = 25 carries two quotes");
  assert.deepEqual(anchorsFor(fill(100)), [
    'line 33 ends with "INFO worker: step 33 done"',
    'line 66 ends with "INFO worker: step 66 done"',
  ], "row: N = 100 anchors lines 33 and 66");
  const two = anchorsFor([contentLine(1), contentLine(2)]);
  assert.deepEqual(two, [
    'line 1 ends with "INFO worker: step 1 done"',
    'line 2 ends with "INFO worker: step 2 done"',
  ], "row: a two-line body names two distinct lines");
  assert.equal(quoteCountOf(two), 2);
  // A one-line body has one line to name, so it cannot supply the two quotes a
  // tabled row shows; it gets no position and no anchor.
  assert.deepEqual(entryPositions(1), [], "row: N = 1 has no position");
  assert.deepEqual(anchorsFor([contentLine(1)]), [], "row: N = 1 anchors nothing");
  assert.deepEqual(anchorsFor([]), [], "row: N = 0 anchors nothing");
});

test("a body whose sampled lines cannot yield two quotes is not tableable", () => {
  // Both positions (33 and 66 at N = 100) fall inside a blank band, so both
  // render a band notice; a notice is not a quote, and the row cannot show the
  // two quotes a tabled row must carry.
  const banded = fill(100);
  for (let lineNumber = 32; lineNumber <= 34; lineNumber += 1) banded[lineNumber - 1] = "";
  for (let lineNumber = 65; lineNumber <= 67; lineNumber += 1) banded[lineNumber - 1] = "";
  const notices = anchorsFor(banded);
  assert.deepEqual(notices, ["lines 32–34 are blank", "lines 65–67 are blank"],
    "both sampled positions land in a band, so both render a notice");
  assert.equal(quoteCountOf(notices), 0, "a notice is not a quote, so the row carries none");
  assert.ok(quoteCountOf(notices) < ENTRY_ASK_MIN_QUOTE_LINES);
  // Notices and quotes never count as the same thing: one notice beside one
  // quote is still one quote.
  const mixed = fill(100);
  for (let lineNumber = 32; lineNumber <= 34; lineNumber += 1) mixed[lineNumber - 1] = "";
  const mixedAnchors = anchorsFor(mixed);
  assert.deepEqual(mixedAnchors, [
    "lines 32–34 are blank",
    'line 66 ends with "INFO worker: step 66 done"',
  ], "row: one band notice beside one quote");
  assert.equal(quoteCountOf(mixedAnchors), 1, "a notice adds no quote to the count");
});

test("blank fallbacks and band notices — one case per row", () => {
  // An anchor inside a blank band becomes the band notice, shipped once. Both
  // positions 67 and 134 fall inside the same run; one notice ships, at the
  // first position, and the later one is omitted (F4).
  const banded = fill(201, new Map());
  for (let lineNumber = 66; lineNumber <= 135; lineNumber += 1) {
    banded[lineNumber - 1] = "";
  }
  assert.deepEqual(anchorsFor(banded), ["lines 66–135 are blank"], "row: a blank band ships one notice");
  assert.equal(blankBandNotice(64, 67), "lines 64–67 are blank", "row: the band notice format");

  // An anchor on a lone blank line falls back to the previous content line.
  // N = 100 samples lines 33 and 66, so the lone blank sits at 66 here.
  const loneBlank = fill(100, new Map([
    [65, "module.exports = { retries: 3, timeoutMs: 30000 };"],
    [66, ""],
  ]));
  assert.deepEqual(anchorsFor(loneBlank), [
    'line 33 ends with "INFO worker: step 33 done"',
    'line 65 ends with "{ retries: 3, timeoutMs: 30000 };"',
  ], "row: a lone blank line falls back to the previous content line");

  // The band threshold is two lines: a pair is a notice, a single line is not.
  const pair = fill(201, new Map([[66, "seed line here"], [67, ""], [68, ""]]));
  assert.deepEqual(anchorsAt(pair, [67]), ["lines 67–68 are blank"], "row: a pair is a notice");
  const single = fill(201, new Map([[66, "seed line here"], [67, ""], [68, "tail line here"]]));
  assert.deepEqual(anchorsAt(single, [67]), ['line 66 of 201 ends with "seed line here"'],
    "row: a single blank line is not a band");

  // The N = 201 lone-blank fallback names line 66 out of 201.
  const fallback = fill(201, new Map([
    [66, "2026-10-26T04:12:07Z INFO worker: step 66 done"],
    [67, ""],
  ]));
  assert.deepEqual(anchorsAt(fallback, [67]), ['line 66 of 201 ends with "INFO worker: step 66 done"'],
    "row: the fallback names line 66 out of 201");
});
