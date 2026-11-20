import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadCutError, headCut, lineOffsets } from '../src/rules/head-cut.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
// The boundary is a count of LINES, never bytes (design G3): line one ends after
// its newline, so k=1 keeps exactly the first line even when that line is huge.


const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

type Case = readonly [name: string, run: (name: string) => void];

// "first\nsecond\nthird\n": 3 lines, 19 bytes, line one is [0, 6).
const THREE_LINES = encode("first\nsecond\nthird\n");

/** k below the line count: the head is the whole-line prefix, the rest drops. */
const PARTIAL_CASES: readonly Case[] = [
  ["k=1 — exactly the first line stays, the rest drops", name => {
    const cut = headCut(THREE_LINES, 1);
    assert.deepEqual(cut.kept, [{ startByte: 0, endByteExclusive: 6 }],
      `row: ${name} — the head is line one, newline included`);
    assert.deepEqual(cut.dropped, [{ startByte: 6, endByteExclusive: 19 }],
      `row: ${name} — the drop is the exact complement`);
    assert.equal(cut.headEndByte, 6, `row: ${name} — the boundary is after line one`);
    assert.equal(cut.totalLines, 3, `row: ${name} — the body holds three lines`);
    assert.equal(cut.keptLineCount, 1, `row: ${name} — one line was kept`);
    assert.equal(cut.whole, false, `row: ${name} — a partial cut is not a whole keep`);
    assert.equal(new TextDecoder().decode(THREE_LINES.subarray(0, cut.headEndByte)), "first\n",
      `row: ${name} — the kept bytes decode as exactly line one`);
  }],
  ["CRLF and BOM — both stay inside line one, and the head never splits CRLF", name => {
    const body = encode("\uFEFFab\r\nrest\r\n");
    assert.deepEqual([...body.subarray(0, 7)], [239, 187, 191, 97, 98, 13, 10],
      `row: ${name} — the fixture's first seven bytes are BOM, 'ab', CRLF`);
    const cut = headCut(body, 1);
    assert.equal(cut.headEndByte, 7, `row: ${name} — the boundary is after the CRLF`);
    assert.deepEqual(cut.kept, [{ startByte: 0, endByteExclusive: 7 }],
      `row: ${name} — the BOM rides inside the kept head`);
    assert.deepEqual(cut.dropped, [{ startByte: 7, endByteExclusive: 13 }],
      `row: ${name} — the second line drops whole`);
    assert.deepEqual([...body.subarray(0, cut.headEndByte)], [239, 187, 191, 97, 98, 13, 10],
      `row: ${name} — the head ends after LF, never between CR and LF`);
    const whole = headCut(body, 2);
    assert.equal(whole.whole, true, `row: ${name} — k equal to the line count keeps everything`);
    assert.equal(whole.headEndByte, 13, `row: ${name} — the whole keep ends at the body`);
  }],
  ["a boundary inside a UTF-8 character still lands after the whole line", name => {
    const body = encode("猫猫\ntail\n");
    const cut = headCut(body, 1);
    assert.equal(cut.headEndByte, 7, `row: ${name} — the boundary is after the newline, not mid-glyph`);
    assert.deepEqual([...body.subarray(0, 7)], [231, 140, 171, 231, 140, 171, 10],
      `row: ${name} — both three-byte glyphs and the LF are kept intact`);
    assert.deepEqual(cut.dropped, [{ startByte: 7, endByteExclusive: 12 }],
      `row: ${name} — the tail drops as one range`);
  }],
  ["a final line without a newline is counted and kept", name => {
    const body = encode("ab\nfinal line");
    assert.equal(body.length, 13, `row: ${name} — the fixture is thirteen bytes`);
    const first = headCut(body, 1);
    assert.equal(first.totalLines, 2, `row: ${name} — an unterminated last line still counts`);
    assert.deepEqual(first.kept, [{ startByte: 0, endByteExclusive: 3 }],
      `row: ${name} — line one is kept with its newline`);
    assert.deepEqual(first.dropped, [{ startByte: 3, endByteExclusive: 13 }],
      `row: ${name} — the unterminated line drops whole`);
    assert.equal(headCut(body, 2).whole, true,
      `row: ${name} — k at the line count keeps the unterminated line`);
    assert.equal(headCut(body, 100).whole, true,
      `row: ${name} — a k past the line count keeps it too`);
  }],
];

/** k at or beyond the line count: a silent whole keep, no refusal. */
const WHOLE_CASES: readonly Case[] = [
  ["k equal to the line count — the whole body, nothing dropped", name => {
    const cut = headCut(THREE_LINES, 3);
    assert.equal(cut.whole, true, `row: ${name} — the cut claims a whole keep`);
    assert.equal(cut.keptLineCount, 3, `row: ${name} — three lines were kept`);
    assert.deepEqual(cut.kept, [{ startByte: 0, endByteExclusive: 19 }],
      `row: ${name} — the head is the entire body`);
    assert.deepEqual(cut.dropped, [], `row: ${name} — nothing drops`);
    assert.equal(cut.headEndByte, 19, `row: ${name} — the boundary is the body's end`);
  }],
  ["k beyond the line count — a silent whole keep, never a refusal", name => {
    const atLimit = headCut(THREE_LINES, 3);
    for (const k of [4, 100, Number.MAX_SAFE_INTEGER]) {
      const cut = headCut(THREE_LINES, k);
      assert.equal(cut.whole, true, `row: ${name} — k=${k} is a whole keep`);
      assert.deepEqual(cut.kept, atLimit.kept, `row: ${name} — k=${k} keeps the same bytes as k=3`);
      assert.deepEqual(cut.dropped, [], `row: ${name} — k=${k} drops nothing`);
      assert.equal(cut.headEndByte, THREE_LINES.length, `row: ${name} — k=${k} ends at the body`);
      assert.equal(cut.keptLineCount, atLimit.totalLines,
        `row: ${name} — k=${k} reports the clamped line count`);
    }
  }],
  ["an empty body — zero lines, nothing kept, nothing dropped", name => {
    const cut = headCut(new Uint8Array(), 1);
    assert.equal(cut.totalLines, 0, `row: ${name} — an empty body holds no lines`);
    assert.equal(cut.whole, true, `row: ${name} — keeping nothing is a whole keep`);
    assert.deepEqual(cut.kept, [], `row: ${name} — no range is kept`);
    assert.deepEqual(cut.dropped, [], `row: ${name} — no range is dropped`);
    assert.equal(cut.headEndByte, 0, `row: ${name} — the boundary is zero`);
  }],
];

/** Every k: the cut partitions the body at a line boundary. */
const SWEEP_CASES: readonly Case[] = [
  ["every k from 1 to the line count — boundary, partition, complement", name => {
    const body = encode("alpha\nbeta\r\ngamma\n");
    const offsets = lineOffsets(body);
    assert.equal(offsets.length, 3, `row: ${name} — the sweep fixture has three lines`);
    for (let k = 1; k <= offsets.length; k += 1) {
      const cut = headCut(body, k);
      const head = body.subarray(0, cut.headEndByte);
      const tail = body.subarray(cut.headEndByte);
      assert.deepEqual(concat([head, tail]), body, `row: ${name} — k=${k} partitions the body`);
      assert.deepEqual(cut.kept, [{ startByte: 0, endByteExclusive: cut.headEndByte }],
        `row: ${name} — k=${k} keeps one prefix range`);
      assert.deepEqual(cut.dropped, tail.length === 0 ? []
        : [{ startByte: cut.headEndByte, endByteExclusive: body.length }],
      `row: ${name} — k=${k} drops exactly the complement`);
      const newlines = head.filter((byte) => byte === 0x0a).length;
      assert.equal(newlines, k, `row: ${name} — k=${k} keeps ${k} complete lines`);
      // Every boundary is after an LF: a head never ends between CR and LF.
      assert.equal(head[head.length - 1], 0x0a,
        `row: ${name} — k=${k} ends after a newline`);
    }
  }],
];

/** Caller bugs: a keep-line count below one is refused with its own reason. */
const REFUSAL_CASES: readonly Case[] = [
  ["k below one, fractional, NaN or infinite — refused by reason", name => {
    for (const k of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => headCut(encode("a\n"), k), (error: unknown) =>
        error instanceof HeadCutError && error.reason === "keep-lines-below-one",
      `row: ${name} — k=${String(k)} is refused with its own reason`);
    }
  }],
];

function runCases(cases: readonly Case[]): void {
  for (const [name, run] of cases) run(name);
}

test("the cut keeps a whole-line head and drops its exact complement", () => {
  runCases(PARTIAL_CASES);
});

test("k at or past the line count is a silent whole keep", () => {
  runCases(WHOLE_CASES);
});

test("every k lands on a line boundary, and a k below one is refused", () => {
  runCases(SWEEP_CASES);
  runCases(REFUSAL_CASES);
});
