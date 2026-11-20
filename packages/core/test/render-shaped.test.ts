import assert from "node:assert/strict";
import { test } from "node:test";
import { ShapeRenderError, renderShaped } from "../src/guard/render.js";
import type { ShapeRenderReason } from "../src/guard/render.js";
import { headCut } from "../src/rules/head-cut.js";
import type { ByteRange } from "../src/types/identity.js";
import { sha256Sync } from "../src/util/hash.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const sourceOf = (bytes: Uint8Array) => ({
  nodeId: "result-1", bytes, byteLength: bytes.length, sha256: sha256Sync(bytes),
});
const bytesIn = (bytes: Uint8Array, ranges: readonly ByteRange[]): number[] =>
  ranges.flatMap(({ startByte, endByteExclusive }) => [...bytes.subarray(startByte, endByteExclusive)]);
const width = (ranges: readonly ByteRange[]): number =>
  ranges.reduce((sum, r) => sum + r.endByteExclusive - r.startByte, 0);

// A shaped render is a splice of kept source ranges and one generated marker
// block; it never rewrites a kept byte. A marker block is one whole LINE: the
// shipped marker is terminated, so it can never share a line with the kept
// bytes after its gap (ISSUE-063, the live R-3 defect). Every expectation below
// is pinned from the row, never read back off the render under test.

interface ShapeRow {
  readonly row: string;
  /** The source text. Its bytes are copied, never decoded, so BOM and CRLF survive. */
  readonly text: string;
  readonly keep: (bytes: Uint8Array) => readonly ByteRange[];
  readonly marker: string;
  /** The whole output, pinned literally. */
  readonly output: string;
  readonly generated: readonly ByteRange[];
}

const SHAPES: readonly ShapeRow[] = [
  {
    row: "BOM + CRLF + multibyte UTF-8 + a missing final newline",
    text: "\uFEFFé\r\nretained\nend",
    keep: () => [{ startByte: 0, endByteExclusive: 7 }, { startByte: 11, endByteExclusive: 19 }],
    marker: "[racoons] kept lines 1–1 of 2\n",
    output: "\uFEFFé\r\n[racoons] kept lines 1–1 of 2\nined\nend",
    generated: [{ startByte: 7, endByteExclusive: 39 }],
  },
  {
    row: "two kept ranges and two dropped gaps",
    text: "abcdefghi",
    keep: () => [{ startByte: 0, endByteExclusive: 2 }, { startByte: 4, endByteExclusive: 6 }],
    marker: "[]\n",
    output: "ab[]\nef[]\n",
    generated: [{ startByte: 2, endByteExclusive: 5 }, { startByte: 7, endByteExclusive: 10 }],
  },
  {
    row: "a whole-line head cut that drops the tail",
    text: "head\nbody one\nbody two\ntail\n",
    keep: (bytes) => headCut(bytes, 1).kept,
    marker: "[racoons] kept lines 1–1 of 4\n",
    output: "head\n[racoons] kept lines 1–1 of 4\n",
    generated: [{ startByte: 5, endByteExclusive: 37 }],
  },
];

test("kept bytes survive byte-for-byte and the retained copies plus markers partition the output", () => {
  for (const row of SHAPES) {
    const bytes = encode(row.text);
    const marker = encode(row.marker);
    const out = renderShaped(sourceOf(bytes), row.keep(bytes), marker);
    assert.deepEqual(out.bytes, encode(row.output), `row: ${row.row} — the output bytes drifted`);
    assert.deepEqual(out.generatedRanges, row.generated, `row: ${row.row} — the generated ranges drifted`);
    assert.deepEqual(bytesIn(out.bytes, out.generatedRanges),
      Array.from({ length: row.generated.length }, () => [...marker]).flat(),
      `row: ${row.row} — a gap is not exactly one whole marker block`);    for (const copy of out.retainedCopies) {
      assert.deepEqual(
        out.bytes.subarray(copy.outputRange.startByte, copy.outputRange.endByteExclusive),
        bytes.subarray(copy.sourceRange.startByte, copy.sourceRange.endByteExclusive),
        `row: ${row.row} — kept bytes ${copy.sourceRange.startByte}..${copy.sourceRange.endByteExclusive} were rewritten`,
      );
      assert.equal(copy.outputRange.endByteExclusive - copy.outputRange.startByte,
        copy.sourceRange.endByteExclusive - copy.sourceRange.startByte,
        `row: ${row.row} — copy length changed for source ${copy.sourceRange.startByte}..${copy.sourceRange.endByteExclusive}`);
    }
    const spans = [
      ...out.retainedCopies.map((copy) => copy.outputRange),
      ...out.generatedRanges,
    ].sort((a, b) => a.startByte - b.startByte);
    let cursor = 0;
    for (const span of spans) {
      assert.equal(span.startByte, cursor, `row: ${row.row} — the ranges leave a gap or overlap at ${cursor}`);
      cursor = span.endByteExclusive;
    }
    assert.equal(cursor, out.bytes.length, `row: ${row.row} — the ranges stop short of the output end`);
    const dropped = bytes.length - width(out.retainedCopies.map((copy) => copy.sourceRange));
    assert.ok(dropped > 0, `row: ${row.row} — a shaping row must drop at least one byte`);
    assert.equal(width(out.retainedCopies.map((copy) => copy.outputRange)), bytes.length - dropped,
      `row: ${row.row} — the kept bytes were not copied one for one`);
    assert.equal(width(out.retainedCopies.map((copy) => copy.outputRange))
      + width(out.generatedRanges), out.bytes.length,
      `row: ${row.row} — kept bytes plus markers do not rebuild the output`);
    assert.equal(out.sha256, sha256Sync(encode(row.output)),
      `row: ${row.row} — the digest is not over the pinned output`);
    assert.notEqual(out.sha256, sha256Sync(bytes),
      `row: ${row.row} — the digest is the source's, so the drop never reached it`);
  }
});

interface MarkerRow {
  readonly row: string;
  readonly marker: string;
  readonly output: string;
}

const MARKERS: readonly MarkerRow[] = [
  { row: "a bare marker line", marker: "MARK", output: "MARK\nkeep-A\nkeep-B\n" },
  { row: "an already-terminated marker", marker: "MARK\n", output: "MARK\nkeep-A\nkeep-B\n" },
];

test("a marker owns its line whether or not it arrives terminated, and the render copies it", () => {
  const bytes = encode("drop\nkeep-A\nkeep-B\n");
  const keep = [{ startByte: 5, endByteExclusive: bytes.length }];
  for (const row of MARKERS) {
    const marker = encode(row.marker);
    const out = renderShaped(sourceOf(bytes), keep, marker);
    assert.equal(new TextDecoder().decode(out.bytes), row.output,
      `row: ${row.row} — the marker did not land on a line of its own`);
    assert.deepEqual(bytesIn(out.bytes, out.generatedRanges), [...encode("MARK\n")],
      `row: ${row.row} — the generated block is not exactly one terminated marker`);
  }
  // Copied, not aliased: a later write to the caller's arrays cannot reach it.
  const copyBytes = encode("keep\ndrop\n");
  const copyMarker = encode("M\n");
  const copied = renderShaped(sourceOf(copyBytes), headCut(copyBytes, 1).kept, copyMarker);
  const saved = copied.bytes.slice();
  copyMarker.fill(0);
  copyBytes.fill(0);
  assert.deepEqual(copied.bytes, saved,
    "row: the marker and source are copied — a later mutation of either corrupted the output");
});

type RefusalRow = {
  readonly row: string;
  readonly reason: ShapeRenderReason;
  readonly run: () => unknown;
};

type RangeRefusalRow = {
  readonly row: string;
  readonly detail: RegExp;
  readonly run: () => unknown;
};

const WHOLE = "whole\nbody\n";
const wholeRange = (): ByteRange[] => {
  const bytes = encode(WHOLE);
  return [{ startByte: 0, endByteExclusive: bytes.length }];
};
const range = (startByte: number, endByteExclusive: number): ByteRange => ({
  startByte, endByteExclusive,
});

const REASON_REFUSALS: readonly RefusalRow[] = [
  {
    row: "a full keep with no marker",
    reason: "nothing-dropped",
    run: () => renderShaped(sourceOf(encode(WHOLE)), wholeRange(), new Uint8Array()),
  },
  {
    row: "a full keep with a marker",
    reason: "nothing-dropped",
    run: () => renderShaped(sourceOf(encode(WHOLE)), wholeRange(), encode("marker\n")),
  },
  {
    row: "a head cut that keeps every line",
    reason: "nothing-dropped",
    run: () => {
      const bytes = encode(WHOLE);
      const wholeKeep = headCut(bytes, 2);
      assert.equal(wholeKeep.whole, true, "row: a head cut that keeps every line — the fixture drops a line");
      return renderShaped(sourceOf(bytes), wholeKeep.kept, encode("marker\n"));
    },
  },
  {
    row: "a dropped head with no marker",
    reason: "dropped-bytes-need-marker",
    run: () => {
      const bytes = encode("head\ntail\n");
      return renderShaped(sourceOf(bytes), headCut(bytes, 1).kept, new Uint8Array());
    },
  },
];

const RANGE_REFUSALS: readonly RangeRefusalRow[] = [
  {
    row: "kept ranges out of order and overlapping",
    detail: /Unordered or invalid ranges/,
    run: () => renderShaped(sourceOf(encode("abcdef")), [range(2, 5), range(1, 3)], encode("m")),
  },
  {
    row: "a kept range past the body",
    detail: /Unordered or invalid ranges/,
    run: () => renderShaped(sourceOf(encode("abcdef")), [range(0, 99)], encode("m")),
  },
  {
    row: "a negative kept range",
    detail: /Unordered or invalid ranges/,
    run: () => renderShaped(sourceOf(encode("abcdef")), [range(-1, 2)], encode("m")),
  },
];

test("an impossible render is refused by name before any output is built", () => {
  for (const row of REASON_REFUSALS) {
    assert.throws(row.run, (error: unknown) =>
      error instanceof ShapeRenderError && error.reason === row.reason,
    `row: ${row.row} — expected the reason ${row.reason}`);
  }
  for (const row of RANGE_REFUSALS) {
    assert.throws(row.run, (error: unknown) =>
      error instanceof Error && row.detail.test(error.message),
    `row: ${row.row} — expected a refusal matching ${String(row.detail)}`);
  }
});
