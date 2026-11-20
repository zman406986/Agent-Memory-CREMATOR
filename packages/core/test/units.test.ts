import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleConfig } from "./rules-fixtures.js";
import { checkSources } from "../src/guard/checks-sources.js";
import { context } from "./guard-fixtures.js";
import type { ValidationInput } from "../src/guard/types.js";
import type { UnitId } from "../src/types/identity.js";
import type { MessageNode, SessionSnapshot, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { labelIssue, normalizeLabel } from "../src/verdicts/labels.js";
import { WholeResultSegmenter } from "../src/units/segmenter.js";
import { UnitTracker, unitRemoval, unitIdFor } from "../src/units/tracker.js";
import type { UnitSpan } from "../src/units/types.js";

const encoder = new TextEncoder();

function nodeOf(text: string, overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id: "result-1", kind: "tool-result", turnOrdinal: 2, stepOrdinal: 3,
    bytes, sha256, byteLength: bytes.length, callId: "call-1",
    evidence: {
      kind: "read", target: null, source: { nodeId: "result-1", sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: "src/example.ts", displayPath: "src/example.ts", title: null,
        lineCount: 3, byteLength: bytes.length, outcome: "hit" }],
    },
    embeddedRecords: [],
    ...overrides,
  };
}

function messageNode(): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return { id: "assistant-1", kind: "message", role: "assistant", turnOrdinal: 1,
    stepOrdinal: 1, bytes, sha256: sha256Sync(bytes), byteLength: bytes.length, toolCallIds: [] };
}

function snapshotOf(nodes: readonly ToolResultNode[]): SessionSnapshot {
  return {
    sessionId: "session-1", revision: "revision-1", currentTurnOrdinal: 2,
    completedThroughTurnOrdinal: 1, currentStepOrdinal: 3,
    nodes: [messageNode(), ...nodes],
    cache: { kind: "warm", watermarkNodeIndex: 0 },
    retentionEvidence: [],
  };
}

// --- segmentation edges -----------------------------------------------------

/**
 * The bar's edges: below, exactly at, above, and the four values the segmenter
 * must refuse as a bar. One row per case, so a split that stopped comparing
 * bytes — or stopped validating the bar — fails on the row that names it.
 */
const BAR_ROWS: readonly {
  name: string;
  text: string;
  bar: number;
  spans: readonly UnitSpan[];
}[] = [
  { name: "a node below the bar", text: "0123456789", bar: 11, spans: [] },
  { name: "a node exactly at the bar", text: "0123456789", bar: 10, spans: [{
    byteRange: { startByte: 0, endByteExclusive: 10 },
    lineRange: { startLine: 1, endLineInclusive: 1 },
  }] },
  { name: "a node above the bar", text: "one\ntwo\nthree\n", bar: 1, spans: [{
    byteRange: { startByte: 0, endByteExclusive: 14 },
    lineRange: { startLine: 1, endLineInclusive: 3 },
  }] },
  ...[-1, 1.5, NaN, Infinity].map(bar => ({
    name: `an invalid bar ${String(bar)}`, text: "0123456789", bar,
    spans: [] as readonly UnitSpan[],
  })),
];

test("the byte bar — one row per edge, and the tracker agrees", () => {
  for (const row of BAR_ROWS) {
    const node = nodeOf(row.text);
    const spans = new WholeResultSegmenter().split(node, row.bar);
    assert.deepEqual(spans, row.spans, `row: ${row.name} — the segmenter's spans`);
    const tracked = new UnitTracker({ sessionId: "session-1", barBytes: row.bar }).unitsFor(node);
    assert.equal(tracked.length, row.spans.length, `row: ${row.name} — the tracker's unit count`);
  }
});

// --- identity, source and the removal round-trip ----------------------------

const SPAN: UnitSpan = {
  byteRange: { startByte: 0, endByteExclusive: 4 },
  lineRange: { startLine: 1, endLineInclusive: 1 },
};

/** The four inputs of `unitIdFor`: change one and the id must move; leave all and it must not. */
const IDENTITY_ROWS: readonly {
  name: string;
  same: boolean;
  ids: () => readonly [UnitId, UnitId];
}[] = [
  { name: "two snapshots of the same content", same: true, ids: () => {
    const first = new UnitTracker({ sessionId: "session-1", barBytes: 1 })
      .units(snapshotOf([nodeOf("alpha\nbeta\n")]));
    const second = new UnitTracker({ sessionId: "session-1", barBytes: 1 })
      .units(snapshotOf([nodeOf("alpha\nbeta\n")]));
    assert.equal(first.length, 1, "row: two snapshots of the same content — one unit in the first");
    assert.equal(second.length, 1, "row: two snapshots of the same content — one unit in the second");
    return [first[0]!.id, second[0]!.id];
  } },
  { name: "a changed node sha256", same: false, ids: () => [
    unitIdFor("session-1", nodeOf("abcd"), SPAN),
    unitIdFor("session-1",
      { ...nodeOf("abcd"), sha256: sha256Sync(encoder.encode("different")) }, SPAN),
  ] },
  { name: "a changed session", same: false, ids: () => [
    unitIdFor("session-1", nodeOf("abcd"), SPAN),
    unitIdFor("session-2", nodeOf("abcd"), SPAN),
  ] },
  { name: "a changed span", same: false, ids: () => [
    unitIdFor("session-1", nodeOf("abcd"), SPAN),
    unitIdFor("session-1", nodeOf("abcd"), {
      byteRange: { startByte: 0, endByteExclusive: 3 },
      lineRange: { startLine: 1, endLineInclusive: 1 },
    }),
  ] },
];

/** What a unit carries onto the removal: exact node source, first-hit path, own byte length. */
const SOURCE_ROWS: readonly {
  name: string;
  text: string;
  outcome: "hit" | "miss";
  path: string | null;
}[] = [
  { name: "a hit path", text: "alpha\nbeta\n", outcome: "hit", path: "src/example.ts" },
  { name: "no hit path", text: "alpha", outcome: "miss", path: null },
];

test("unit identity, source and removal — one row per input", () => {
  for (const row of IDENTITY_ROWS) {
    const [first, second] = row.ids();
    assert.match(first, /^unit:sha256:[0-9a-f]{64}$/u, `row: ${row.name} — the first id's shape`);
    assert.match(second, /^unit:sha256:[0-9a-f]{64}$/u, `row: ${row.name} — the second id's shape`);
    if (row.same) assert.equal(first, second, `row: ${row.name} — the id must not move`);
    else assert.notEqual(first, second, `row: ${row.name} — the id must move`);
  }

  for (const row of SOURCE_ROWS) {
    const plain = nodeOf(row.text);
    const node = nodeOf(row.text, { evidence: { ...plain.evidence,
      paths: [{ ...plain.evidence.paths[0]!, outcome: row.outcome }] } });
    const snapshot = snapshotOf([node]);
    const unit = new UnitTracker({ sessionId: snapshot.sessionId, barBytes: 1 }).unitsFor(node)[0];
    assert.ok(unit !== undefined, `row: ${row.name} — the node yields one unit`);
    if (unit === undefined) continue;
    assert.deepEqual(unit.source, {
      nodeId: node.id, sha256: node.sha256, byteLength: node.bytes.length,
    }, `row: ${row.name} — the unit carries the exact node source`);
    assert.equal(unit.byteLength, node.bytes.length, `row: ${row.name} — the unit's own byte length`);
    assert.equal(unit.path, row.path, `row: ${row.name} — the unit's path`);

    const removal = unitRemoval(unit);
    assert.equal(removal.id, unit.id, `row: ${row.name} — the removal keeps the unit id`);
    assert.equal(removal.title,
      row.path === null ? "not retained" : `not retained ${row.path}`,
      `row: ${row.name} — the removal title`);
    assert.deepEqual(removal.sources, [{
      source: { nodeId: node.id, sha256: node.sha256, byteLength: node.bytes.length },
      ranges: [{ startByte: 0, endByteExclusive: node.bytes.length }],
    }], `row: ${row.name} — the removal names the whole node`);
    assert.equal(removal.title.length > 0, true, `row: ${row.name} — the title is never empty`);

    const before = structuredClone(removal);
    const value: ValidationInput = {
      input: { kind: "at-rest", eventId: "event-1", reason: "revisit" },
      snapshot,
      capabilities: { mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
        log: true, appendRecords: true, rehydrateOnResume: false },
      config: ruleConfig(),
      plans: [{ ruleId: "verdict", baseRevision: snapshot.revision,
        removals: [removal], notes: [], operations: [] }],
      sealedEpisodeIds: [],
      nowMs: 10,
    };
    const c = context(value);
    checkSources(c, value.plans);
    assert.deepEqual(c.issues, [], `row: ${row.name} — checkSources accepts the removal`);
    assert.deepEqual(removal, before, `row: ${row.name} — checkSources leaves the removal unchanged`);
  }
});

// --- the label cap ----------------------------------------------------------

/**
 * The label gate: the enforced cap is 50 for the advertised 40, and the length
 * is measured AFTER normalisation — a trailing break is trimmed, an internal
 * one becomes a space and counts. `label-too-long` is the guard's only refusal
 * for this rule, so this table is its cover.
 */
const LABEL_ROWS: readonly {
  name: string;
  label: string;
  expect: "label-too-long" | null;
  normalizedLength: number;
}[] = [
  { name: "50 characters pass", label: "a".repeat(50), expect: null, normalizedLength: 50 },
  { name: "51 characters are refused", label: "a".repeat(51), expect: "label-too-long",
    normalizedLength: 51 },
  { name: "a trailing line break is trimmed and does not count", label: `${"a".repeat(50)}\n`,
    expect: null, normalizedLength: 50 },
  { name: "an internal line break becomes a space and counts",
    label: `${"a".repeat(50)}\n b`, expect: "label-too-long", normalizedLength: 53 },
];

test("the label cap — one row per length and line-break case", () => {
  for (const row of LABEL_ROWS) {
    assert.equal(normalizeLabel(row.label).length, row.normalizedLength,
      `row: ${row.name} — the normalised length`);
    assert.equal(labelIssue(row.label, 40), row.expect, `row: ${row.name} — the length verdict`);
  }
});
