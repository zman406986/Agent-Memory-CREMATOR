import assert from "node:assert/strict";
import { test } from "node:test";
import { EpisodeTracker } from "../src/episodes/tracker.js";
import type { Episode, EpisodeDetectionInput } from "../src/episodes/types.js";
import { LEVEL1_RULES, planLevel1Prune } from "../src/prune/level1.js";
import type { Level1PruneInput, Level1PrunePlan, Level1Rule } from "../src/prune/types.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import type { UnitId } from "../src/types/identity.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";

const encoder = new TextEncoder();
const SESSION = "session-1";

function evidenceOf(
  kind: ToolEvidence["kind"],
  target: string | null = null,
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

function path(pathKey: string, outcome: PathEvidence["outcome"] = "miss"): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 3, byteLength: 8, outcome };
}

function nodeOf(
  id: string, text: string, evidence: ToolEvidence, stepOrdinal: number, turnOrdinal = 1,
): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: {
      ...evidence,
      source: { nodeId: id, sha256, byteLength: bytes.length },
    },
  };
}

/** The units the tracker would build, in transcript order. */
function unitsOf(nodes: readonly ToolResultNode[]): readonly ProcessingUnit[] {
  return nodes.flatMap(node => new UnitTracker({ sessionId: SESSION, barBytes: 1 }).unitsFor(node));
}

function detect(
  results: readonly ToolResultNode[], completedThroughTurnOrdinal = 0,
): readonly Episode[] {
  const current = results.reduce((max, node) => Math.max(max, node.stepOrdinal), 0);
  const input: EpisodeDetectionInput = {
    sessionId: SESSION, results, currentStepOrdinal: current, completedThroughTurnOrdinal,
  };
  return new EpisodeTracker({ noNewPathSteps: null }).detect(input);
}

function plan(
  nodes: readonly ToolResultNode[], episodes: readonly Episode[] = [],
): Level1PrunePlan {
  const input: Level1PruneInput = { units: unitsOf(nodes), nodes, episodes };
  return planLevel1Prune(input);
}

function removalFor(result: Level1PrunePlan, unitId: UnitId) {
  const removal = result.removals.find(entry => entry.unitId === unitId);
  assert.ok(removal, `expected a removal for ${unitId}`);
  return removal;
}

function unitIdOf(nodes: readonly ToolResultNode[], nodeId: string): UnitId {
  const node = nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  const unit = unitsOf([node])[0];
  assert.ok(unit, `missing unit for ${nodeId}`);
  return unit.id;
}

// --- the three families -----------------------------------------------------

interface Fixture {
  readonly nodes: readonly ToolResultNode[];
  readonly episodes: readonly Episode[];
}

/** One transcript and the plan it must produce, with the proof pinned whole. */
interface FamilyRow {
  readonly name: string;
  readonly build: () => Fixture;
  /** Node ids the plan removes, in transcript order. */
  readonly removed: readonly string[];
  /** Node ids the plan keeps, in transcript order. */
  readonly kept: readonly string[];
  /** The row's own proof shape, pinned whole for its first removal. */
  readonly check: (
    result: Level1PrunePlan, nodes: readonly ToolResultNode[], episodes: readonly Episode[], row: string,
  ) => void;
}

const FAMILY_ROWS: readonly FamilyRow[] = [
  {
    name: "stale: an exact later re-read supersedes the earlier copy",
    build: () => {
      const read = (id: string, step: number): ToolResultNode => nodeOf(id,
        "export const answer = 42;\n", evidenceOf("read", "src/a.ts", [path("src/a.ts", "hit")]), step);
      return { nodes: [read("r1", 1), read("r2", 3)], episodes: [] };
    },
    removed: ["r1"],
    kept: ["r2"],
    check: (result, nodes, _episodes, row) => {
      const stale = removalFor(result, unitIdOf(nodes, "r1"));
      assert.equal(stale.rule, "stale-exact-reread", `row: ${row} — rule`);
      assert.deepEqual(stale.proof, {
        rule: "stale-exact-reread",
        targetKey: "src/a.ts",
        contentSha256: nodes[0]!.sha256,
        byteLength: nodes[0]!.byteLength,
        survivorUnitId: unitIdOf(nodes, "r2"),
        survivorNodeId: "r2",
      }, `row: ${row} — proof names the later copy that survives`);
    },
  },
  {
    name: "stale: three reads of one target keep only the newest copy",
    build: () => {
      const read = (id: string, step: number, text: string): ToolResultNode =>
        nodeOf(id, text, evidenceOf("read", "src/a.ts", [path("src/a.ts", "hit")]), step);
      return { nodes: [read("r1", 1, "same\n"), read("r2", 3, "changed\n"),
        read("r3", 5, "same\n")], episodes: [] };
    },
    removed: ["r1"],
    kept: ["r2", "r3"],
    check: (result, nodes, _episodes, row) => {
      const stale = removalFor(result, unitIdOf(nodes, "r1"));
      assert.equal(stale.rule, "stale-exact-reread", `row: ${row} — rule`);
      if (stale.rule !== "stale-exact-reread") throw new Error(`row: ${row} — unreachable`);
      assert.equal(stale.proof.survivorNodeId, "r3",
        `row: ${row} — the survivor is the newest read, not the changed middle one`);
    },
  },
  {
    name: "closed-episode: a closed failed search removes its miss bodies and nothing else",
    build: () => {
      const nodes = [
        nodeOf("m1", "not found in a.ts\n", evidenceOf("search", "needle", [path("src/a.ts")]), 1),
        nodeOf("m2", "not found in b.ts\n", evidenceOf("search", "needle", [path("src/b.ts")]), 2),
        nodeOf("u1", "unknown outcome\n", evidenceOf("search", "needle", [path("src/c.ts", "unknown")]), 3),
      ];
      return { nodes, episodes: detect(nodes, 1) };
    },
    removed: ["m1", "m2"],
    kept: ["u1"],
    check: (result, nodes, episodes, row) => {
      assert.equal(episodes.length, 1, `row: ${row} — one closed episode`);
      const proof = removalFor(result, unitIdOf(nodes, "m1")).proof;
      assert.deepEqual(proof, {
        rule: "closed-episode",
        episodeId: episodes[0]!.id,
        targetKey: "needle",
        closeReason: "turn-end",
        closedAtStep: 3,
        missNodeIds: ["m1", "m2"],
        nodeId: "m1",
      }, `row: ${row} — proof names the episode's own miss bodies`);
    },
  },
  {
    name: "duplicates: byte-identical copies keep the earliest by transcript order",
    build: () => {
      const read = (id: string, step: number, target: string): ToolResultNode =>
        nodeOf(id, "same bytes\n", evidenceOf("read", target, [path(target, "hit")]), step);
      return { nodes: [read("d1", 1, "src/a.ts"), read("d2", 2, "src/b.ts"),
        read("d3", 3, "src/c.ts")], episodes: [] };
    },
    removed: ["d2", "d3"],
    kept: ["d1"],
    check: (result, nodes, _episodes, row) => {
      const kept = unitIdOf(nodes, "d1");
      assert.deepEqual(removalFor(result, unitIdOf(nodes, "d2")).proof, {
        rule: "byte-identical-duplicates",
        contentSha256: sha256Sync(encoder.encode("same bytes\n")),
        byteLength: encoder.encode("same bytes\n").length,
        keptUnitId: kept,
        removedUnitIds: [unitIdOf(nodes, "d2"), unitIdOf(nodes, "d3")],
      }, `row: ${row} — proof names the kept copy and every surplus one`);
    },
  },
  {
    name: "duplicates: interleaved classes each keep their own earliest head (ISSUE-383)",
    build: () => {
      const read = (id: string, step: number, target: string, text: string): ToolResultNode =>
        nodeOf(id, text, evidenceOf("read", target, [path(target, "hit")]), step);
      return { nodes: [read("a1", 1, "src/a.ts", "alpha\n"), read("b1", 2, "src/b.ts", "beta\n"),
        read("a2", 3, "src/c.ts", "alpha\n"), read("b2", 4, "src/d.ts", "beta\n"),
        read("a3", 5, "src/e.ts", "alpha\n")], episodes: [] };
    },
    removed: ["a2", "b2", "a3"],
    kept: ["a1", "b1"],
    check: (result, nodes, _episodes, row) => {
      assert.deepEqual(removalFor(result, unitIdOf(nodes, "a2")).proof, {
        rule: "byte-identical-duplicates",
        contentSha256: sha256Sync(encoder.encode("alpha\n")),
        byteLength: encoder.encode("alpha\n").length,
        keptUnitId: unitIdOf(nodes, "a1"),
        removedUnitIds: [unitIdOf(nodes, "a2"), unitIdOf(nodes, "a3")],
      }, `row: ${row} — class alpha keeps its earliest head, surplus in transcript order`);
      assert.deepEqual(removalFor(result, unitIdOf(nodes, "b2")).proof, {
        rule: "byte-identical-duplicates",
        contentSha256: sha256Sync(encoder.encode("beta\n")),
        byteLength: encoder.encode("beta\n").length,
        keptUnitId: unitIdOf(nodes, "b1"),
        removedUnitIds: [unitIdOf(nodes, "b2")],
      }, `row: ${row} — class beta keeps its own earliest head, not alpha's`);
    },
  },
  {
    name: "two families on one transcript: each removal is filed under the rule that proves it",
    build: () => {
      const read = (id: string, step: number, target: string): ToolResultNode =>
        nodeOf(id, "same bytes\n", evidenceOf("read", target, [path(target, "hit")]), step);
      return { nodes: [read("a", 1, "src/a.ts"), read("b", 2, "src/a.ts"),
        read("c", 3, "src/b.ts")], episodes: [] };
    },
    removed: ["a", "c"],
    kept: ["b"],
    check: (result, _nodes, _episodes, row) => {
      assert.deepEqual(result.removals.map(entry => entry.rule),
        ["stale-exact-reread", "byte-identical-duplicates"],
        `row: ${row} — the same target is stale; a different target holding the same bytes is a duplicate`);
      // All three hold the same bytes and `b` stays, so no copy is lost and the
      // gate has nothing to refuse (ISSUE-174). A non-empty list here would mean
      // the gate was cancelling a safe plan.
      assert.deepEqual(result.cancellations, [],
        `row: ${row} — a plan that keeps a copy of every class cancels nothing`);
    },
  },
];

test("each family removes only what its proof proves, filed under that rule", () => {
  for (const row of FAMILY_ROWS) {
    const { nodes, episodes } = row.build();
    const result = plan(nodes, episodes);
    assert.deepEqual(result.removals.map(entry => entry.unitId),
      row.removed.map(id => unitIdOf(nodes, id)), `row: ${row.name} — removals`);
    assert.deepEqual(result.kept, row.kept.map(id => unitIdOf(nodes, id)),
      `row: ${row.name} — kept`);
    for (const removal of result.removals) {
      assert.equal(removal.proof.rule, removal.rule,
        `row: ${row.name} — the proof is filed under its own rule`);
      assert.ok((LEVEL1_RULES as readonly string[]).includes(removal.rule),
        `row: ${row.name} — ${removal.rule} is a declared L1 rule`);
    }
    // A unit is in exactly one of the two lists, and every input unit is in one.
    const listed = [...result.removals.map(entry => entry.unitId), ...result.kept];
    assert.equal(new Set(listed).size, listed.length,
      `row: ${row.name} — no unit is listed twice`);
    assert.equal(listed.length, unitsOf(nodes).length,
      `row: ${row.name} — every input unit is listed once`);
    row.check(result, nodes, episodes, row.name);
  }
});

// --- refusals about unprovable units ---------------------------------------

interface RefusalRow {
  readonly name: string;
  readonly build: () => Fixture;
  /** The rule each removal carries; empty means nothing is removed. */
  readonly rules: readonly Level1Rule[];
  /** A precondition the refusal depends on, asserted by name first. */
  readonly precondition?: (episodes: readonly Episode[], row: string) => void;
}

const REFUSAL_ROWS: readonly RefusalRow[] = [
  {
    name: "a same target with different bytes is not a superseded read",
    build: () => {
      const read = (id: string, step: number, text: string): ToolResultNode =>
        nodeOf(id, text, evidenceOf("read", "src/a.ts", [path("src/a.ts", "hit")]), step);
      return { nodes: [read("r1", 1, "alpha\n"), read("r2", 3, "beta\n")], episodes: [] };
    },
    rules: [],
  },
  {
    name: "identical bytes behind a search are duplicates, never a superseded read",
    build: () => {
      const search = (id: string, step: number): ToolResultNode =>
        nodeOf(id, "no matches\n", evidenceOf("search", "needle", [path("src/a.ts")]), step);
      return { nodes: [search("s1", 1), search("s2", 3)], episodes: [] };
    },
    rules: ["byte-identical-duplicates"],
  },
  {
    name: "a read with no target is never a superseded read",
    build: () => {
      const read = (id: string, step: number, text: string): ToolResultNode =>
        nodeOf(id, text, evidenceOf("read", null, [path("src/a.ts", "hit")]), step);
      return { nodes: [read("r1", 1, "alpha\n"), read("r2", 3, "beta\n")], episodes: [] };
    },
    rules: [],
  },
  {
    name: "near-identical bytes are not duplicates",
    build: () => {
      const read = (id: string, step: number, target: string, text: string): ToolResultNode =>
        nodeOf(id, text, evidenceOf("read", target, [path(target, "hit")]), step);
      return { nodes: [read("n1", 1, "src/a.ts", "alpha beta\n"),
        read("n2", 2, "src/b.ts", "alpha betA\n")], episodes: [] };
    },
    rules: [],
  },
  {
    name: "an open episode is not a closed-episode removal",
    build: () => {
      const nodes = [
        nodeOf("m1", "not found in a.ts\n", evidenceOf("search", "needle", [path("src/a.ts")]), 1),
      ];
      return { nodes, episodes: detect(nodes) };
    },
    rules: [],
    precondition: (episodes, row) => assert.equal(episodes[0]?.status, "open",
      `row: ${row} — the episode must still be open, or the refusal proves nothing`),
  },
  {
    name: "an episode that hit anything is never closed-episode",
    build: () => {
      const nodes = [
        nodeOf("m1", "not found in a.ts\n", evidenceOf("search", "needle", [path("src/a.ts")]), 1),
        nodeOf("h1", "found here\n", evidenceOf("search", "needle", [path("src/b.ts", "hit")]), 2),
      ];
      return { nodes, episodes: detect(nodes, 1) };
    },
    rules: [],
    precondition: (episodes, row) => assert.equal(episodes[0]?.status, "closed",
      `row: ${row} — the episode must be closed, so only the hit can refuse it`),
  },
];

test("no family removes on a claim its own evidence does not prove", () => {
  for (const row of REFUSAL_ROWS) {
    const { nodes, episodes } = row.build();
    row.precondition?.(episodes, row.name);
    assert.deepEqual(plan(nodes, episodes).removals.map(entry => entry.rule), row.rules,
      `row: ${row.name} — rules removed`);
  }
});

test("Ruling 8 property: a unit with no observable use is never removed by L1", () => {
  // Property, not an example: sweep sizes, positions and turn numbers. Every
  // unit has distinct bytes and its own target, no episode names it, and nothing
  // in the transcript cites it. L1 must remove none of them, at any size.
  for (const count of [1, 2, 5, 12]) {
    for (const turnOfLast of [1, 7, 40]) {
      const row = `count=${count} turnOfLast=${turnOfLast}`;
      const nodes = Array.from({ length: count }, (_, index) =>
        nodeOf(
          `u${index}`,
          `unit ${index} ${"x".repeat(64 * (index + 1))}\n`,
          evidenceOf("read", `src/u${index}.ts`, [path(`src/u${index}.ts`, "hit")]),
          index + 1,
          index === count - 1 ? turnOfLast : 1,
        ));
      const result = plan(nodes, []);
      assert.deepEqual(result.removals, [], `row: ${row} — an unreferenced unit is not provable`);
      assert.deepEqual(result.kept, unitsOf(nodes).map(unit => unit.id),
        `row: ${row} — every unit is kept`);
    }
  }
  // And the rule set itself is closed: no "unreferenced" family exists to add.
  assert.deepEqual([...LEVEL1_RULES], [
    "stale-exact-reread", "closed-episode", "byte-identical-duplicates",
  ], "the L1 rule set admits no fourth family");
});

test("a unit whose span falls outside its node is kept, never removed", () => {
  const nodes = [
    nodeOf("r1", "abcdef\n", evidenceOf("read", "src/a.ts", [path("src/a.ts", "hit")]), 1),
    nodeOf("r2", "abcdef\n", evidenceOf("read", "src/a.ts", [path("src/a.ts", "hit")]), 2),
  ];
  const whole = unitsOf(nodes)[0];
  assert.ok(whole !== undefined);
  const rogue: ProcessingUnit = {
    ...whole,
    id: "unit:rogue",
    span: { ...whole.span, byteRange: { startByte: 0, endByteExclusive: 99 } },
  };
  const result = planLevel1Prune({ units: [rogue], nodes, episodes: [] });
  assert.deepEqual(result.removals, [], "row: out-of-bounds span — an unlocatable unit is unprovable");
  assert.deepEqual(result.kept, ["unit:rogue"], "row: out-of-bounds span — it is kept, not dropped");
});
