import assert from "node:assert/strict";
import { test } from "node:test";
import { PRUNE_ANCHOR_POSITION_A, PRUNE_ANCHOR_POSITION_B, buildPruneAnchor, isRefusedPruneAnchor, assignCallOrdinals } from "../src/prune/anchor.js";
import type { PruneAnchor } from "../src/prune/anchor.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { buildPruneAnchors, pruneAnchorPositions } from "../src/prune/anchor-positions.js";

/**
 * The bulk prune's row anchor (ISSUE-022; ADR-0022 §7). The format, the
 * quoting and the fallbacks are the entry ask's, shared through
 * `rules/anchors.ts`; the placement is this seam's own — ADR-0009's shipped
 * 0.3 / 0.7 byte shares, mapped to the line holding each byte.
 */

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
  id: string,
  text: string,
  evidence = evidenceOf("read"),
  stepOrdinal = 1,
): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidence, source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

function unitOf(node: ToolResultNode): ProcessingUnit {
  const unit = new UnitTracker({ sessionId: SESSION, barBytes: 1 }).unitsFor(node)[0];
  assert.ok(unit, `expected a unit for ${node.id}`);
  return unit;
}

function anchorOf(node: ToolResultNode, patch: Partial<ProcessingUnit> = {}): PruneAnchor {
  const result = buildPruneAnchor(unitWith(unitOf(node), patch), node);
  assert.ok(!isRefusedPruneAnchor(result), `unexpected refusal: ${JSON.stringify(result)}`);
  return result;
}

/** `count` numbered lines, each four words, so a byte share maps to a known line. */
function numberedLines(count: number, overrides: ReadonlyMap<number, string> = new Map()): string {
  return Array.from({ length: count },
    (_, index) => overrides.get(index + 1) ?? `row ${index + 1} alpha beta`).join("\n") + "\n";
}

/** A blank line of the fixture's own width, so the byte shares do not move. */
const BLANK_LINE = " ".repeat("row 31 alpha beta".length);

function unitWith(unit: ProcessingUnit, patch: Partial<ProcessingUnit>): ProcessingUnit {
  return { ...unit, ...patch };
}

const codePoints = (value: string): string[] => Array.from(value);

/** A hand-built node + unit pair, for a body the tracker never produces. */
function handBuilt(body: Uint8Array, id: string): { node: ToolResultNode; unit: ProcessingUnit } {
  const sha256 = sha256Sync(body);
  const node: ToolResultNode = {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal: 1, bytes: body, sha256,
    byteLength: body.byteLength, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidenceOf("read"), source: { nodeId: id, sha256, byteLength: body.byteLength } },
  };
  const unit: ProcessingUnit = {
    id: `unit:${id}`,
    nodeId: node.id,
    source: { nodeId: node.id, sha256, byteLength: body.byteLength },
    path: null,
    span: { byteRange: { startByte: 0, endByteExclusive: body.byteLength }, lineRange: null },
    byteLength: body.byteLength,
  };
  return { node, unit };
}

test("the row carries the shared anchor format at the 0.3 and 0.7 byte shares", () => {
  // Uniform lines, 1792 bytes over 100 lines: the 30% byte falls inside line 31
  // and the 70% byte inside line 71. Stated as lines, never recomputed from the
  // module, so a moved share fails this test by name.
  assert.equal(PRUNE_ANCHOR_POSITION_A, 0.3);
  assert.equal(PRUNE_ANCHOR_POSITION_B, 0.7);
  const node = nodeOf("n", numberedLines(100));
  assert.equal(node.byteLength, 1792);
  assert.deepEqual(anchorOf(node).anchors, [
    'line 31 of 100 ends with "row 31 alpha beta"',
    'line 71 of 100 ends with "row 71 alpha beta"',
  ]);

  // The fallback class is the entry ask's, not a second rule: a lone blank line
  // falls back to the nearest earlier content line and shows THAT line's number.
  // The blank is padded to the fixture's width, so the shares still land on 31.
  assert.deepEqual(
    anchorOf(nodeOf("lone", numberedLines(100, new Map([[31, BLANK_LINE]])))).anchors,
    [
      'line 30 of 100 ends with "row 30 alpha beta"',
      'line 71 of 100 ends with "row 71 alpha beta"',
    ],
    "row: a lone blank line falls back to the nearest earlier content line",
  );

  // A run of two or more blank lines is stated plainly instead.
  const band = new Map([[31, BLANK_LINE], [32, BLANK_LINE], [33, BLANK_LINE]]);
  assert.deepEqual(anchorOf(nodeOf("band", numberedLines(100, band))).anchors, [
    "lines 31–33 are blank",
    'line 71 of 100 ends with "row 71 alpha beta"',
  ], "row: a blank band is stated plainly");

  // A moved share moves the anchor: the placement is the shares, not a fixed pair.
  const moved = buildPruneAnchor(unitOf(node), node, { positionA: 0.05, positionB: 0.95 });
  assert.ok(!isRefusedPruneAnchor(moved));
  assert.deepEqual(moved.anchors, [
    'line 6 of 100 ends with "row 6 alpha beta"',
    'line 96 of 100 ends with "row 96 alpha beta"',
  ], "row: a moved share moves the anchor");

  // A CRLF unit is quoted after its trailing CR is trimmed.
  const crlf = Array.from({ length: 100 }, (_, i) => `row ${i + 1} alpha beta\r`).join("\n") + "\n";
  const crlfAnchors = anchorOf(nodeOf("crlf", crlf)).anchors;
  assert.deepEqual(crlfAnchors, [
    'line 31 of 100 ends with "row 31 alpha beta"',
    'line 71 of 100 ends with "row 71 alpha beta"',
  ], "row: a CRLF unit quotes after the CR is trimmed");
  assert.equal(crlfAnchors.some(anchor => anchor.includes("\r")), false,
    "row: a CRLF unit — no CR survives into the row");

  // A huge unit's anchor is two short lines, never a span of its bytes.
  const hugeLine = `${"word ".repeat(12).trim()}\n`;
  const huge = nodeOf("huge", hugeLine.repeat(2000));
  const hugeAnchors = anchorOf(huge).anchors;
  assert.equal(hugeAnchors.length, 2, "row: a huge unit ships two anchors");
  for (const anchor of hugeAnchors) {
    assert.match(anchor, /^line \d+ of 2000 ends with "word word word word word word"$/u,
      `row: a huge unit — got ${anchor}`);
    assert.ok(anchor.length < 80, `row: a huge unit — an anchor is short: ${anchor}`);
  }
  const hugePositions = pruneAnchorPositions(huge.bytes);
  assert.equal(hugePositions.length, 2);
  assert.ok((hugePositions[1] ?? 0) - (hugePositions[0] ?? 0) > 500,
    "row: a huge unit — the two shares are far apart");
});

test("the quoted tail is cut on code points, never inside a character", () => {
  // Both shares resolve to the only line, so the pair collapses to one anchor.
  const oneLine = encoder.encode("one short line here\n");
  assert.deepEqual(pruneAnchorPositions(oneLine), [1], "row: a one-line unit places both shares on line 1");
  assert.deepEqual(anchorOf(nodeOf("n", "one short line here\n")).anchors,
    ['line 1 of 1 ends with "one short line here"'],
    "row: a one-line unit ships one anchor, once");

  // A line with no spaces quotes its last thirty code points; inner double
  // quotes are kept verbatim and never escaped.
  const json = '{"id":41,"path":"/var/log/app/ingest.jsonl","bytes":148000,"status":"ok"}\n';
  assert.deepEqual(anchorOf(nodeOf("n", json)).anchors,
    ['line 1 of 1 ends with ","bytes":148000,"status":"ok"}"'],
    "row: a no-space line quotes its last thirty code points");

  // A CJK line and an emoji line are cut on code points, never inside a character.
  const cases: readonly { name: string; text: string; expect: string }[] = [
    { name: "CJK", text: `${"漢".repeat(300)}\n`, expect: "漢".repeat(30) },
    { name: "emoji", text: `${"🙂".repeat(199)}1\n`, expect: `${"🙂".repeat(29)}1` },
  ];
  for (const row of cases) {
    const anchor = anchorOf(nodeOf(row.name, row.text)).anchors[0];
    assert.ok(anchor !== undefined, `row: ${row.name} — expected an anchor`);
    const quote = /"(.*)"$/u.exec(anchor)?.[1] ?? "";
    assert.equal(codePoints(quote).length, 30, `row: ${row.name} — thirty code points`);
    assert.equal(quote, row.expect, `row: ${row.name} — the cut keeps whole characters`);
    assert.ok(!anchor.includes("\uFFFD"), `row: ${row.name} — no replacement character`);
  }
});

test("degenerate bodies and refusals — one case per row", () => {
  // An unproven unit refuses in words, never with an empty anchor list. With no
  // node there is no evidence either: `other`, no path. Facts are never invented.
  const unproven = nodeOf("n", "content\n");
  const missingNode = buildPruneAnchor(unitOf(unproven), undefined);
  assert.deepEqual(missingNode, { kind: "other", callOrdinal: 1, refusal: "missing-node" });
  assert.ok(isRefusedPruneAnchor(missingNode));
  assert.ok(!("anchors" in missingNode), "a refusal carries no anchor list");

  // An empty unit has no positions and no anchors.
  const empty = nodeOf("e", "");
  const emptyUnit: ProcessingUnit = {
    id: "unit:empty",
    nodeId: empty.id,
    source: { nodeId: empty.id, sha256: empty.sha256, byteLength: 0 },
    path: null,
    span: { byteRange: { startByte: 0, endByteExclusive: 0 }, lineRange: null },
    byteLength: 0,
  };
  assert.deepEqual(pruneAnchorPositions(new Uint8Array()), [], "row: an empty unit has no positions");
  assert.deepEqual(buildPruneAnchors(new Uint8Array()), { anchors: [] }, "row: an empty unit has no anchors");
  assert.deepEqual(buildPruneAnchor(emptyUnit, empty), {
    kind: "read", path: "config.ts", callOrdinal: 1, anchors: [],
  }, "row: an empty unit still names its kind and path");

  // An all-blank unit ships the band notice once.
  assert.deepEqual(buildPruneAnchors(encoder.encode("\n\n\n")), { anchors: ["lines 1–3 are blank"] },
    "row: an all-blank unit ships the band notice once");

  // An undecodable unit refuses rather than quoting replacement characters: a
  // span edge inside a UTF-8 character — 0xE6 opens a three-byte sequence and
  // the LF cuts it short. The node and its unit are built by hand, because the
  // tracker never sees a body this shape.
  const bad = Uint8Array.from([0x61, 0x0a, 0xe6, 0x0a]);
  const handMade = handBuilt(bad, "bad");
  assert.deepEqual(buildPruneAnchors(bad), { refusal: "undecodable-unit" },
    "row: an undecodable unit refuses at the positional builder");
  assert.deepEqual(buildPruneAnchor(handMade.unit, handMade.node), {
    kind: "read", path: "config.ts", callOrdinal: 1, refusal: "undecodable-unit",
  }, "row: an undecodable unit refuses at the row builder");

  // An out-of-range share is a caller bug.
  for (const share of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => pruneAnchorPositions(encoder.encode("x\n"), { positionA: share }),
      RangeError, `row: share ${String(share)} must be a RangeError`);
  }
});

test("the kind and path come from the node's evidence, and callFacts only fill a blank", () => {
  // Without callFacts the anchor degrades to the node's own evidence.
  const searchNode = nodeOf("n", "anything\n", evidenceOf("search", "needle"));
  const searchAnchor = anchorOf(searchNode);
  assert.deepEqual(Object.keys(searchAnchor).sort(), ["anchors", "callOrdinal", "kind", "path"],
    "row: no callFacts — the row is exactly four keys");
  assert.equal(searchAnchor.kind, "search", "row: no callFacts — kind is the node's");
  assert.equal(searchAnchor.path, "needle", "row: no callFacts — path is the node's target");

  // A call with no target has no path key at all.
  const globAnchor = anchorOf(nodeOf("n", "anything\n", evidenceOf("glob", null)));
  assert.ok(!("path" in globAnchor), "row: no target — no path key");
  assert.deepEqual(globAnchor, {
    kind: "glob", callOrdinal: 1, anchors: ['line 1 of 1 ends with "anything"'],
  }, "row: no target — the row omits path entirely");

  // callFacts wins over the node evidence and never invents the missing half.
  const expected = ['line 1 of 1 ends with "anything"'];
  const node = nodeOf("n", "anything\n", evidenceOf("search", "needle"));
  assert.deepEqual(buildPruneAnchor(unitOf(node), node, { callFacts: { toolName: "Grep" } }), {
    kind: "Grep", path: "needle", callOrdinal: 1, anchors: expected,
  }, "row: callFacts toolName wins, the path stays the node's");
  assert.deepEqual(buildPruneAnchor(unitOf(node), node, { callFacts: { targetPath: "src/a.ts" } }), {
    kind: "search", path: "src/a.ts", callOrdinal: 1, anchors: expected,
  }, "row: callFacts targetPath wins, the kind stays the node's");
  // A blank fact is no fact: blank never becomes a path.
  const blankNode = nodeOf("b", "x\n", evidenceOf("glob", null));
  assert.ok(!("path" in buildPruneAnchor(unitOf(blankNode), blankNode,
    { callFacts: { toolName: "  ", targetPath: "" } })), "row: a blank fact never becomes a path");
});

test("the ordinal disambiguates two byte-identical calls in one ask", () => {
  const first = nodeOf("a", "same bytes\n", evidenceOf("read", "src/a.ts"), 1);
  const second = nodeOf("b", "same bytes\n", evidenceOf("read", "src/a.ts"), 2);
  const other = nodeOf("c", "other bytes\n", evidenceOf("read", "src/b.ts"), 3);
  const units = [first, second, other].map(unitOf);
  const ordinals = assignCallOrdinals(units, [first, second, other]);
  assert.equal(ordinals.get(units[0]!.id), 1);
  assert.equal(ordinals.get(units[1]!.id), 2);
  assert.equal(ordinals.get(units[2]!.id), 1);

  const rows = units.map((unit, index) => {
    const callOrdinal = ordinals.get(unit.id);
    assert.ok(callOrdinal !== undefined);
    return buildPruneAnchor(unit, [first, second, other][index], { callOrdinal });
  });
  assert.deepEqual(rows.map(row => row.callOrdinal), [1, 2, 1]);
  // Same kind and path, so the ordinal is the only thing telling them apart.
  assert.equal(rows[0]?.kind, rows[1]?.kind);
  assert.equal((rows[0] as PruneAnchor).path, (rows[1] as PruneAnchor).path);
  assert.notDeepEqual(rows[0], rows[1]);
});
