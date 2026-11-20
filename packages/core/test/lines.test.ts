import assert from "node:assert/strict";
import { test } from "node:test";
import type { ByteRange, LineRange } from "../src/types/identity.js";
import { concatBytes, sliceBytes, toBytes } from "../src/util/bytes.js";
import {
  byteRangeForLines, complementByteRanges, lineCount, splitLineOffsets,
} from "../src/util/lines.js";

function selectedBytes(bytes: Uint8Array, ranges: readonly ByteRange[]): Uint8Array {
  return concatBytes(...ranges.map(({ startByte, endByteExclusive }) =>
    sliceBytes(bytes, startByte, endByteExclusive)));
}

type Thrown = Exclude<Parameters<typeof assert.throws>[1], undefined>;

/** Row-bound assertions: every failure names the case row that produced it. */
interface At {
  eq(actual: unknown, expected: unknown, detail?: string): void;
  deep(actual: unknown, expected: unknown, detail?: string): void;
  throws(run: () => unknown, expected: Thrown, detail?: string): void;
}

function at(row: string): At {
  const tag = (detail?: string): string =>
    detail === undefined ? `row: ${row}` : `row: ${row} — ${detail}`;
  return {
    eq: (actual, expected, detail) => { assert.equal(actual, expected, tag(detail)); },
    deep: (actual, expected, detail) => { assert.deepEqual(actual, expected, tag(detail)); },
    throws: (run, expected, detail) => { assert.throws(run, expected, tag(detail)); },
  };
}

interface Selection {
  readonly lines: readonly LineRange[];
  readonly bytes: Uint8Array;
  /** Asserted only where the merged byte ranges are themselves the claim. */
  readonly ranges?: readonly ByteRange[];
}

interface Complement {
  readonly keep: readonly ByteRange[];
  readonly ranges: readonly ByteRange[];
  readonly bytes: Uint8Array;
  /** When set, kept plus omitted must reassemble the whole input. */
  readonly covers?: boolean;
}

interface ShapeCase {
  readonly row: string;
  readonly bytes: Uint8Array;
  /** The line count, pinned literally: never derived from the offsets under test. */
  readonly lines: number;
  readonly offsets: readonly ByteRange[];
  readonly selections: readonly Selection[];
  readonly complements: readonly Complement[];
}

const BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * The shapes line arithmetic has to get right. Every expected value is a
 * literal from outside the implementation, so each row fails on its own row
 * name when the offset, merge or complement logic drifts.
 */
const SHAPE_CASES: readonly ShapeCase[] = [
  {
    row: "CRLF belongs to its line and all offsets count bytes",
    bytes: toBytes("A\r\né\r\nlast\r\n"),
    lines: 3,
    offsets: [
      { startByte: 0, endByteExclusive: 3 },
      { startByte: 3, endByteExclusive: 7 },
      { startByte: 7, endByteExclusive: 13 },
    ],
    selections: [
      { lines: [{ startLine: 1, endLineInclusive: 1 }], bytes: Uint8Array.of(0x41, 0x0d, 0x0a) },
      { lines: [{ startLine: 2, endLineInclusive: 2 }], bytes: Uint8Array.of(0xc3, 0xa9, 0x0d, 0x0a) },
      { lines: [{ startLine: 3, endLineInclusive: 3 }], bytes: toBytes("last\r\n") },
    ],
    complements: [],
  },
  {
    row: "BOM stays within the first line and multibyte offsets remain exact",
    bytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad, 0x0a, 0x42),
    lines: 2,
    offsets: [
      { startByte: 0, endByteExclusive: 7 },
      { startByte: 7, endByteExclusive: 8 },
    ],
    selections: [
      {
        lines: [{ startLine: 1, endLineInclusive: 1 }],
        bytes: Uint8Array.of(...BOM, 0xe4, 0xb8, 0xad, 0x0a),
      },
      { lines: [{ startLine: 2, endLineInclusive: 2 }], bytes: Uint8Array.of(0x42) },
    ],
    complements: [],
  },
  {
    row: "a BOM-only file is one line",
    bytes: Uint8Array.of(...BOM),
    lines: 1,
    offsets: [{ startByte: 0, endByteExclusive: 3 }],
    selections: [{ lines: [{ startLine: 1, endLineInclusive: 1 }], bytes: Uint8Array.of(...BOM) }],
    complements: [],
  },
  {
    row: "LF and a missing final newline retain exact original bytes",
    bytes: toBytes("one\n二"),
    lines: 2,
    offsets: [
      { startByte: 0, endByteExclusive: 4 },
      { startByte: 4, endByteExclusive: 7 },
    ],
    selections: [
      { lines: [{ startLine: 1, endLineInclusive: 1 }], bytes: Uint8Array.of(0x6f, 0x6e, 0x65, 0x0a) },
      { lines: [{ startLine: 2, endLineInclusive: 2 }], bytes: Uint8Array.of(0xe4, 0xba, 0x8c) },
    ],
    complements: [],
  },
  {
    row: "a lone CR is not a line break",
    bytes: toBytes("a\rb"),
    lines: 1,
    offsets: [{ startByte: 0, endByteExclusive: 3 }],
    selections: [
      { lines: [{ startLine: 1, endLineInclusive: 1 }], bytes: Uint8Array.of(0x61, 0x0d, 0x62) },
    ],
    complements: [],
  },
  {
    row: "keeping the head leaves exactly the tail bytes",
    bytes: toBytes("\uFEFFhead\r\n二\ntail"),
    lines: 3,
    offsets: [
      { startByte: 0, endByteExclusive: 9 },
      { startByte: 9, endByteExclusive: 13 },
      { startByte: 13, endByteExclusive: 17 },
    ],
    selections: [{
      lines: [{ startLine: 1, endLineInclusive: 1 }],
      ranges: [{ startByte: 0, endByteExclusive: 9 }],
      bytes: Uint8Array.of(...BOM, 0x68, 0x65, 0x61, 0x64, 0x0d, 0x0a),
    }],
    complements: [{
      keep: [{ startByte: 0, endByteExclusive: 9 }],
      ranges: [{ startByte: 9, endByteExclusive: 17 }],
      bytes: Uint8Array.of(0xe4, 0xba, 0x8c, 0x0a, 0x74, 0x61, 0x69, 0x6c),
      covers: true,
    }],
  },
  {
    row: "adjacent kept ranges merge and disjoint selections preserve byte order",
    bytes: toBytes("a\nb\nc\nd"),
    lines: 4,
    offsets: [
      { startByte: 0, endByteExclusive: 2 },
      { startByte: 2, endByteExclusive: 4 },
      { startByte: 4, endByteExclusive: 6 },
      { startByte: 6, endByteExclusive: 7 },
    ],
    selections: [{
      lines: [
        { startLine: 1, endLineInclusive: 1 },
        { startLine: 2, endLineInclusive: 2 },
        { startLine: 4, endLineInclusive: 4 },
      ],
      ranges: [{ startByte: 0, endByteExclusive: 4 }, { startByte: 6, endByteExclusive: 7 }],
      bytes: toBytes("a\nb\nd"),
    }],
    complements: [
      {
        keep: [{ startByte: 0, endByteExclusive: 4 }, { startByte: 6, endByteExclusive: 7 }],
        ranges: [{ startByte: 4, endByteExclusive: 6 }],
        bytes: toBytes("c\n"),
      },
      {
        keep: [{ startByte: 2, endByteExclusive: 4 }, { startByte: 4, endByteExclusive: 6 }],
        ranges: [{ startByte: 0, endByteExclusive: 2 }, { startByte: 6, endByteExclusive: 7 }],
        bytes: toBytes("a\nd"),
      },
      {
        keep: [],
        ranges: [{ startByte: 0, endByteExclusive: 7 }],
        bytes: toBytes("a\nb\nc\nd"),
      },
      { keep: [{ startByte: 0, endByteExclusive: 7 }], ranges: [], bytes: new Uint8Array() },
    ],
  },
];

test("line offsets, line-to-byte ranges and complements — one row per shape", () => {
  for (const shape of SHAPE_CASES) {
    const a = at(shape.row);
    a.deep(splitLineOffsets(shape.bytes), shape.offsets, "split offsets");
    a.eq(lineCount(shape.bytes), shape.lines, "line count");
    a.deep(selectedBytes(shape.bytes, shape.offsets), shape.bytes,
      "every offset together covers the whole input");
    for (const selection of shape.selections) {
      const ranges = byteRangeForLines(shape.bytes, selection.lines);
      if (selection.ranges !== undefined) {
        a.deep(ranges, selection.ranges, `byte ranges for ${JSON.stringify(selection.lines)}`);
      }
      a.deep(selectedBytes(shape.bytes, ranges), selection.bytes,
        `selected bytes for ${JSON.stringify(selection.lines)}`);
    }
    for (const complement of shape.complements) {
      const ranges = complementByteRanges(shape.bytes.byteLength, complement.keep);
      const what = JSON.stringify(complement.keep);
      a.deep(ranges, complement.ranges, `complement of ${what}`);
      a.deep(selectedBytes(shape.bytes, ranges), complement.bytes, `omitted bytes of ${what}`);
      if (complement.covers === true) {
        a.deep(concatBytes(selectedBytes(shape.bytes, complement.keep), selectedBytes(shape.bytes, ranges)),
          shape.bytes, `kept plus omitted for ${what}`);
      }
    }
  }
});

test("invalid line, keep and total bounds are refused by name", () => {
  const bytes = toBytes("a\nb\nc");
  const lines = (ranges: readonly LineRange[]): (() => unknown) =>
    () => byteRangeForLines(bytes, ranges);
  const keep = (ranges: readonly ByteRange[]): (() => unknown) =>
    () => complementByteRanges(bytes.byteLength, ranges);
  const total = (value: number): (() => unknown) => () => complementByteRanges(value, []);
  const cases: readonly [string, () => unknown, Thrown][] = [
    ["line range starting at line 0", lines([{ startLine: 0, endLineInclusive: 1 }]), RangeError],
    ["line range past the last line", lines([{ startLine: 1, endLineInclusive: 4 }]), RangeError],
    ["inverted line range", lines([{ startLine: 2, endLineInclusive: 1 }]), RangeError],
    ["fractional line number", lines([{ startLine: 1.5, endLineInclusive: 2 }]), RangeError],
    ["overlapping line ranges", lines(
      [{ startLine: 1, endLineInclusive: 2 }, { startLine: 2, endLineInclusive: 3 }]), RangeError],
    ["unordered line ranges", lines(
      [{ startLine: 3, endLineInclusive: 3 }, { startLine: 1, endLineInclusive: 1 }]), RangeError],
    ["kept range starting before the file", keep([{ startByte: -1, endByteExclusive: 1 }]), RangeError],
    ["kept range past the file", keep([{ startByte: 0, endByteExclusive: 6 }]), RangeError],
    ["empty kept range", keep([{ startByte: 1, endByteExclusive: 1 }]), RangeError],
    ["fractional kept bound", keep([{ startByte: 0.5, endByteExclusive: 1 }]), RangeError],
    ["overlapping kept ranges", keep(
      [{ startByte: 0, endByteExclusive: 3 }, { startByte: 2, endByteExclusive: 4 }]), RangeError],
    ["unordered kept ranges", keep(
      [{ startByte: 3, endByteExclusive: 4 }, { startByte: 0, endByteExclusive: 1 }]), RangeError],
    ["negative total bytes", total(-1), RangeError],
    ["fractional total bytes", total(1.5), RangeError],
    ["NaN total bytes", total(Number.NaN), RangeError],
    ["infinite total bytes", total(Number.POSITIVE_INFINITY), RangeError],
  ];
  for (const [row, run, expected] of cases) at(row).throws(run, expected);
});
