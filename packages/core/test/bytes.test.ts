import assert from "node:assert/strict";
import { test } from "node:test";
import {
  byteLengthOf, canonicalManifestBytes, concatBytes, equalBytes, fromBytes, sliceBytes, toBytes,
} from '../src/util/bytes.js';
import { sha256, sha256Sync } from "../src/util/hash.js";

/** The canonical encoder's claims: one expected string, one distinct pair, one refusal. */
type CanonicalCase =
  | { readonly kind: "encode"; readonly name: string; readonly inputs: readonly unknown[];
      readonly expected: string }
  | { readonly kind: "distinct"; readonly name: string; readonly left: unknown;
      readonly right: unknown }
  | { readonly kind: "refuse"; readonly name: string; readonly input: unknown };

/** Integer-like keys sort as strings, so "10" precedes "2". */
const SORTED_KEYS = '{"10":"ten","2":"two","a":[{"c":3,"d":4},null],"z":{"a":"一","b":2}}';
const SHARED = { id: "same" };
const CYCLE: Record<string, unknown> = {};
CYCLE["self"] = CYCLE;
const ACCESSOR = Object.defineProperty({}, "id", {
  enumerable: true,
  get() { throw new Error("Accessor must not execute."); },
});

const CANONICAL_CASES: readonly CanonicalCase[] = [
  { kind: "encode", name: "nested insertion order does not reach the bytes",
    inputs: [
      { z: { b: 2, a: "一" }, a: [{ d: 4, c: 3 }, null], "2": "two", "10": "ten" },
      { "10": "ten", "2": "two", a: [{ c: 3, d: 4 }, null], z: { a: "一", b: 2 } },
    ], expected: SORTED_KEYS },
  { kind: "encode", name: "array order is kept and a repeated object encodes twice",
    inputs: [[SHARED, SHARED]], expected: '[{"id":"same"},{"id":"same"}]' },
  { kind: "distinct", name: "the session id is part of the bytes",
    left: { sessionId: "s1", parts: ["a", "b"] }, right: { sessionId: "s2", parts: ["a", "b"] } },
  { kind: "distinct", name: "the parts order is part of the bytes",
    left: { sessionId: "s1", parts: ["a", "b"] }, right: { sessionId: "s1", parts: ["b", "a"] } },
  { kind: "refuse", name: "undefined is not a JSON value", input: undefined },
  { kind: "refuse", name: "a property holding undefined would silently vanish",
    input: { id: undefined } },
  { kind: "refuse", name: "NaN has no JSON spelling", input: NaN },
  { kind: "refuse", name: "Infinity has no JSON spelling", input: Infinity },
  { kind: "refuse", name: "a BigInt has no JSON spelling", input: 1n },
  { kind: "refuse", name: "a Date is not plain JSON data", input: new Date(0) },
  { kind: "refuse", name: "a cycle would encode forever", input: CYCLE },
  { kind: "refuse", name: "a sparse array would encode holes as null", input: new Array<unknown>(1) },
  { kind: "refuse", name: "an accessor would need to execute to be read", input: ACCESSOR },
];

test("canonical encoding — key order, identity data, and the refusals", () => {
  for (const row of CANONICAL_CASES) {
    switch (row.kind) {
      case "encode":
        for (const input of row.inputs) {
          assert.deepEqual(canonicalManifestBytes(input), toBytes(row.expected),
            `row: ${row.name} — the canonical bytes`);
        }
        break;
      case "distinct":
        assert.equal(equalBytes(canonicalManifestBytes(row.left), canonicalManifestBytes(row.right)),
          false, `row: ${row.name} — the two inputs must not encode alike`);
        break;
      case "refuse":
        assert.throws(() => canonicalManifestBytes(row.input), TypeError,
          `row: ${row.name} — the encoder must refuse`);
        break;
    }
  }
});

/** The byte primitives: one digest vector, one UTF-8 body, one join or slice. */
type ByteCase =
  | { readonly kind: "digest"; readonly name: string; readonly text: string;
      readonly sha256: string }
  | { readonly kind: "digest-distinct"; readonly name: string; readonly left: string;
      readonly right: string }
  | { readonly kind: "utf8"; readonly name: string; readonly text: string;
      readonly bytes: readonly number[] }
  | { readonly kind: "utf8-refuse"; readonly name: string; readonly bytes: readonly number[] }
  | { readonly kind: "concat"; readonly name: string;
      readonly parts: readonly (readonly number[])[]; readonly expected: readonly number[] }
  | { readonly kind: "slice"; readonly name: string; readonly source: readonly number[];
      readonly start: number; readonly end: number | null; readonly expected: readonly number[];
      readonly sourceKind?: "buffer" }
  | { readonly kind: "slice-refuse"; readonly name: string; readonly source: readonly number[];
      readonly start: number; readonly end: number | null }
  | { readonly kind: "copy"; readonly name: string;
      readonly parts: readonly (readonly number[])[]; readonly joined: readonly number[];
      readonly start: number; readonly sliced: readonly number[] };

const BOM_AND_MULTIBYTE = [0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa9, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0xa6, 0x9d, 0x0d, 0x0a];
const BOM = [0xef, 0xbb, 0xbf];

const BYTE_CASES: readonly ByteCase[] = [
  { kind: "digest", name: "the empty vector", text: "",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { kind: "digest", name: "the abc vector", text: "abc",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { kind: "digest-distinct", name: "a line ending changes the digest", left: "abc\n",
    right: "abc\r\n" },
  { kind: "digest-distinct", name: "a leading BOM changes the digest", left: "abc",
    right: "\uFEFFabc" },
  { kind: "utf8", name: "multibyte text round trips and the BOM survives",
    text: "\uFEFFAé中🦝\r\n", bytes: BOM_AND_MULTIBYTE },
  { kind: "utf8", name: "the empty string is zero bytes", text: "", bytes: [] },
  { kind: "utf8-refuse", name: "a lone continuation byte is not decodable", bytes: [0xc3] },
  { kind: "concat", name: "an empty part adds nothing and joins in order",
    parts: [BOM, [], [0x61, 0x0d, 0x0a]], expected: [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a] },
  { kind: "concat", name: "no parts is an empty array", parts: [], expected: [] },
  { kind: "slice", name: "a start offset keeps the tail", source: [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a],
    start: 3, end: null, expected: [0x61, 0x0d, 0x0a] },
  { kind: "slice", name: "an explicit end is exclusive", source: [1, 2, 3], start: 0, end: 2,
    expected: [1, 2] },
  { kind: "slice", name: "a Buffer view slices like any byte array", source: [1, 2, 3],
    start: 0, end: 2, expected: [1, 2], sourceKind: "buffer" },
  { kind: "slice-refuse", name: "a negative start is refused", source: [1, 2, 3], start: -1,
    end: null },
  { kind: "slice-refuse", name: "an end past the source is refused", source: [1, 2, 3], start: 0,
    end: 4 },
  { kind: "slice-refuse", name: "an end before the start is refused", source: [1, 2, 3], start: 2,
    end: 1 },
  { kind: "slice-refuse", name: "a fractional start is refused", source: [1, 2, 3], start: 0.5,
    end: null },
  { kind: "copy", name: "neither the parts nor the joined bytes alias the copies",
    parts: [BOM, [], [0x61, 0x0d, 0x0a]], joined: [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a],
    start: 3, sliced: [0x61, 0x0d, 0x0a] },
];

const arrayOf = (values: readonly number[]): Uint8Array => Uint8Array.from(values);

test("byte primitives — UTF-8, digests, concatenation and copying", async () => {
  for (const row of BYTE_CASES) {
    switch (row.kind) {
      case "digest":
        assert.equal(sha256Sync(toBytes(row.text)), row.sha256, `row: ${row.name} — sync digest`);
        assert.equal(await sha256(toBytes(row.text)), row.sha256, `row: ${row.name} — async digest`);
        assert.match(row.sha256, /^[0-9a-f]{64}$/u, `row: ${row.name} — the digest is hex`);
        break;
      case "digest-distinct":
        assert.notEqual(sha256Sync(toBytes(row.left)), sha256Sync(toBytes(row.right)),
          `row: ${row.name} — the two bodies must not share a digest`);
        break;
      case "utf8": {
        const expected = arrayOf(row.bytes);
        assert.deepEqual(toBytes(row.text), expected, `row: ${row.name} — encode`);
        assert.equal(fromBytes(expected), row.text, `row: ${row.name} — decode`);
        assert.equal(byteLengthOf(row.text), row.bytes.length, `row: ${row.name} — string length`);
        assert.equal(byteLengthOf(expected), row.bytes.length, `row: ${row.name} — byte length`);
        break;
      }
      case "utf8-refuse":
        assert.throws(() => fromBytes(arrayOf(row.bytes)), TypeError,
          `row: ${row.name} — a fatal decode must refuse`);
        break;
      case "concat":
        assert.deepEqual(concatBytes(...row.parts.map(arrayOf)), arrayOf(row.expected),
          `row: ${row.name} — the joined bytes`);
        break;
      case "slice": {
        const source = row.sourceKind === "buffer"
          ? Buffer.from([...row.source]) : arrayOf(row.source);
        const sliced = row.end === null ? sliceBytes(source, row.start)
          : sliceBytes(source, row.start, row.end);
        assert.deepEqual(sliced, arrayOf(row.expected), `row: ${row.name} — the slice`);
        break;
      }
      case "slice-refuse": {
        const source = arrayOf(row.source);
        assert.throws(() => (row.end === null ? sliceBytes(source, row.start)
          : sliceBytes(source, row.start, row.end)), RangeError,
        `row: ${row.name} — the slice must refuse`);
        break;
      }
      case "copy": {
        const parts = row.parts.map(part => arrayOf(part));
        const joined = concatBytes(...parts);
        const sliced = sliceBytes(joined, row.start);
        assert.deepEqual(joined, arrayOf(row.joined), `row: ${row.name} — the joined bytes`);
        assert.deepEqual(sliced, arrayOf(row.sliced), `row: ${row.name} — the slice`);
        for (const part of parts) part[0] = 0;
        assert.deepEqual(joined, arrayOf(row.joined),
          `row: ${row.name} — a mutated part must not reach the join`);
        joined[row.start] = 0;
        assert.deepEqual(sliced, arrayOf(row.sliced),
          `row: ${row.name} — a mutated join must not reach the slice`);
        break;
      }
    }
  }
});
