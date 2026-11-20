import assert from "node:assert/strict";
import { test } from "node:test";
import { CoverageMeter } from "../src/meter/coverage.js";
import type { PathEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";

function path(
  pathKey: string, byteLength: number | null = null, outcome: PathEvidence["outcome"] = "hit",
  displayPath = `${pathKey}:display`,
): PathEvidence {
  return { pathKey, displayPath, title: null, lineCount: null, byteLength, outcome };
}

function result(
  id: string, body: string, paths: readonly PathEvidence[],
  kind: ToolResultNode["evidence"]["kind"] = "read",
): ToolResultNode {
  const bytes = new TextEncoder().encode(body);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal: 1, bytes, sha256,
    byteLength: bytes.byteLength, callId: `call-${id}`, embeddedRecords: [],
    evidence: {
      kind, target: null, paths,
      source: { nodeId: id, sha256, byteLength: bytes.byteLength }, sourceRecallId: null,
    },
  };
}

/** One path's tally as the meter answers it, or a failed assert naming the path. */
function tallyOf(meter: CoverageMeter, pathKey: string) {
  const found = meter.bytesByPath().find(entry => entry.pathKey === pathKey);
  assert.ok(found !== undefined, `no coverage entry for ${pathKey}`);
  return found;
}

interface AttributionRow {
  readonly name: string;
  /** Results recorded in order: id, body, the paths it names, and its kind. */
  readonly records: readonly {
    readonly id: string;
    readonly body: string;
    readonly paths: readonly PathEvidence[];
    readonly kind?: ToolResultNode["evidence"]["kind"];
  }[];
  /** The expected tally per path key, in answer order. */
  readonly paths: readonly {
    readonly pathKey: string;
    readonly bytes: number;
    readonly hitBytes: number;
    readonly missBytes: number;
    readonly unknownBytes: number;
    readonly observations: number;
  }[];
  readonly total: number;
  readonly unattributed: number;
}

/**
 * PRD §6.6's byte facts: a hit and a miss split one path, a multi-path result
 * attributes nothing by guess, a non-read result still counts, an unknown
 * outcome is flagged rather than pooled, and a reported length beats the body.
 */
const ATTRIBUTION_ROWS: readonly AttributionRow[] = [
  { name: "a hit and a miss of one path split the bytes",
    records: [
      { id: "miss", body: "1234", paths: [path("src/a.ts", null, "miss")] },
      { id: "hit", body: "123456", paths: [path("src/a.ts", null, "hit")] },
    ],
    paths: [{ pathKey: "src/a.ts", bytes: 10, hitBytes: 6, missBytes: 4, unknownBytes: 0,
      observations: 2 }],
    total: 10, unattributed: 0 },
  { name: "a multi-path result names every path and guesses no share",
    records: [{ id: "grep", body: "1234567890", kind: "search",
      paths: [path("src/a.ts"), path("src/b.ts")] }],
    paths: [
      { pathKey: "src/a.ts", bytes: 0, hitBytes: 0, missBytes: 0, unknownBytes: 0,
        observations: 1 },
      { pathKey: "src/b.ts", bytes: 0, hitBytes: 0, missBytes: 0, unknownBytes: 0,
        observations: 1 },
    ],
    total: 0, unattributed: 10 },
  { name: "a non-read result counts by path like a read",
    records: [{ id: "shell", body: "0123456789", paths: [path("src/a.ts")], kind: "other" }],
    paths: [{ pathKey: "src/a.ts", bytes: 10, hitBytes: 10, missBytes: 0, unknownBytes: 0,
      observations: 1 }],
    total: 10, unattributed: 0 },
  { name: "an unknown outcome is counted but pooled into neither side",
    records: [
      { id: "unknown", body: "12345678", paths: [path("src/a.ts", null, "unknown")] },
      { id: "hit", body: "1234", paths: [path("src/b.ts")] },
    ],
    paths: [
      { pathKey: "src/a.ts", bytes: 8, hitBytes: 0, missBytes: 0, unknownBytes: 8,
        observations: 1 },
      { pathKey: "src/b.ts", bytes: 4, hitBytes: 4, missBytes: 0, unknownBytes: 0,
        observations: 1 },
    ],
    total: 12, unattributed: 0 },
  { name: "a reported path length wins over the result's own length",
    records: [{ id: "truncated", body: "x".repeat(40),
      paths: [path("src/big.ts", 900, "hit")] }],
    paths: [{ pathKey: "src/big.ts", bytes: 900, hitBytes: 900, missBytes: 0, unknownBytes: 0,
      observations: 1 }],
    total: 900, unattributed: 0 },
];

test("coverage attribution — one row per result shape", () => {
  for (const row of ATTRIBUTION_ROWS) {
    const meter = new CoverageMeter();
    for (const record of row.records) meter.record(result(record.id, record.body, record.paths, record.kind));
    assert.deepEqual(meter.bytesByPath().map(entry => entry.pathKey),
      row.paths.map(entry => entry.pathKey), `row: ${row.name} — the answered paths`);
    for (const expected of row.paths) {
      assert.deepEqual(tallyOf(meter, expected.pathKey), expected,
        `row: ${row.name} — the tally for ${expected.pathKey}`);
    }
    assert.equal(meter.total(), row.total, `row: ${row.name} — the attributed total`);
    assert.equal(meter.unattributedBytes(), row.unattributed,
      `row: ${row.name} — the unattributed bytes`);
  }
});

interface OrderRow {
  readonly name: string;
  /** The paths recorded once each, in this order: id, body, path key. */
  readonly records: readonly {
    readonly id: string;
    readonly body: string;
    readonly pathKey: string;
  }[];
  /** Extra writes of the FIRST recorded node, to prove a re-delivery adds nothing. */
  readonly repeats: number;
  /** The path keys the answer must carry, in order. */
  readonly order: readonly string[];
  readonly total: number;
  readonly unattributed: number;
}

/** The order rule and the two facts that keep a re-read from inflating it. */
const ORDER_ROWS: readonly OrderRow[] = [
  { name: "the answer is ordered by key, not by arrival",
    records: [
      { id: "one", body: "123", pathKey: "z.ts" },
      { id: "two", body: "123", pathKey: "a.ts" },
      { id: "three", body: "123", pathKey: "m.ts" },
    ], repeats: 0, order: ["a.ts", "m.ts", "z.ts"], total: 9, unattributed: 0 },
  { name: "a re-delivered node id is one observation",
    records: [{ id: "one", body: "123", pathKey: "src/a.ts" }],
    repeats: 2, order: ["src/a.ts"], total: 3, unattributed: 0 },
  { name: "a blank path key is not a path",
    records: [{ id: "blank", body: "123", pathKey: "   " }],
    repeats: 0, order: [], total: 0, unattributed: 3 },
];

test("a duplicate pathKey keeps the first claim whole, never cross-billing bytes (ISSUE-364)", () => {
  // Single distinct key: the first observation declared no length, a later
  // duplicate of the same key reported 900. The first claim must fall back to the
  // result's own 10 bytes, not borrow the duplicate's 900.
  const single = new CoverageMeter();
  single.record(result("dup", "1234567890",
    [path("src/a.ts", null, "hit"), path("src/a.ts", 900, "hit")]));
  assert.deepEqual(tallyOf(single, "src/a.ts"), {
    pathKey: "src/a.ts", bytes: 10, hitBytes: 10, missBytes: 0, unknownBytes: 0, observations: 1,
  }, "the first claim's null length falls back to the result's own bytes, not the duplicate's 900");
  assert.equal(single.total(), 10, "the attributed total is the result's own bytes");
  assert.equal(single.unattributedBytes(), 0, "nothing is unattributed for a single key");

  // Multi-path: a(null), b(null), a(900). No single-key share exists, so the first
  // a claim attributes 0 and the result's 10 bytes stay unattributed — the
  // duplicate's 900 must not be billed to a.
  const multi = new CoverageMeter();
  multi.record(result("dup-multi", "1234567890",
    [path("src/a.ts", null, "hit"), path("src/b.ts", null, "hit"), path("src/a.ts", 900, "hit")]));
  assert.deepEqual(tallyOf(multi, "src/a.ts"), {
    pathKey: "src/a.ts", bytes: 0, hitBytes: 0, missBytes: 0, unknownBytes: 0, observations: 1,
  }, "a multi-path first claim with no length attributes nothing");
  assert.deepEqual(tallyOf(multi, "src/b.ts"), {
    pathKey: "src/b.ts", bytes: 0, hitBytes: 0, missBytes: 0, unknownBytes: 0, observations: 1,
  }, "the other path is untouched by the duplicate");
  assert.equal(multi.total(), 0, "no bytes are attributed across two keys");
  assert.equal(multi.unattributedBytes(), 10, "the result's bytes stay unattributed");

  // Control: a first claim that DID report a length keeps it; the later duplicate
  // adds nothing. This holds before and after the fix (the check never over-rejects).
  const control = new CoverageMeter();
  control.record(result("dup-first-reported", "1234567890",
    [path("src/a.ts", 50, "hit"), path("src/a.ts", 900, "hit")]));
  assert.deepEqual(tallyOf(control, "src/a.ts"), {
    pathKey: "src/a.ts", bytes: 50, hitBytes: 50, missBytes: 0, unknownBytes: 0, observations: 1,
  }, "the first reported length wins over the duplicate's");
  assert.equal(control.total(), 50, "the first claim's reported length is the total");
});

test("coverage order and re-delivery — one row per rule", () => {
  for (const row of ORDER_ROWS) {
    const meter = new CoverageMeter();
    const nodes = row.records.map(record =>
      result(record.id, record.body, [path(record.pathKey)]));
    for (const node of nodes) {
      assert.equal(meter.record(node), true, `row: ${row.name} — a new node is accepted`);
    }
    for (let repeat = 0; repeat < row.repeats; repeat += 1) {
      assert.equal(meter.record(structuredClone(nodes[0]!)), false,
        `row: ${row.name} — a re-delivered node is refused`);
    }
    assert.deepEqual(meter.bytesByPath().map(entry => entry.pathKey), row.order,
      `row: ${row.name} — the answer order`);
    for (const pathKey of row.order) {
      assert.equal(tallyOf(meter, pathKey).observations, 1,
        `row: ${row.name} — ${pathKey} is observed once, however often it is re-delivered`);
    }
    assert.equal(meter.total(), row.total, `row: ${row.name} — the recorded total`);
    assert.equal(meter.unattributedBytes(), row.unattributed,
      `row: ${row.name} — the unattributed bytes`);
  }
});
