import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RacoonsConfig } from "../src/config.js";
import { RacoonsEngine } from "../src/engine/engine.js";
import type { Rule } from "../src/rules/types.js";
import type {
  PathCoverageFact, PathEvidence, SessionSnapshot, ToolEvidence, ToolResultNode, TranscriptNode,
} from "../src/types/transcript.js";
import { computeInvalidation, withoutStaleCoverage, samePath } from '../src/units/invalidation.js';
import { UnitTracker } from "../src/units/tracker.js";
import { pathWrites, writePathSpellings } from "../src/units/writes.js";
import { sha256Sync } from "../src/util/hash.js";
import { protocolFixture } from "./engine-fixtures.js";

/**
 * Write invalidation (PRD §6.7 "a write to a path invalidates that path's units
 * and stale maps"; ISSUE-045 chunk C6).
 *
 * Every assertion here is a byte-observable fact about transcript order and
 * recorded path evidence: which unit sits before which write, and which
 * spellings the host used for one path. Nothing scores or judges a unit, so the
 * chunk adds no bar (ADR-0006).
 *
 * Every row below is one case of one rule; a check that stopped reading its
 * input would let its row through, and the failure names that row.
 */

const encoder = new TextEncoder();
const sessionId = "session-c6";
const barBytes = 8;
const READ_PATH = "src/app.ts";
const BODY = "alpha line\nbeta line\ngamma line\n";

function config(): RacoonsConfig {
  return { ...DEFAULT_CONFIG, protocol: { ...DEFAULT_CONFIG.protocol, barBytes } };
}

function path(pathKey: string, displayPath = pathKey,
  outcome: PathEvidence["outcome"] = "hit"): PathEvidence {
  return { pathKey, displayPath, title: null, lineCount: 4, byteLength: BODY.length, outcome };
}

function node(id: string, stepOrdinal: number, evidence: Omit<ToolEvidence, "source">,
  text = BODY): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id, kind: "tool-result", turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidence, source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

function read(id: string, step: number, options: {
  readonly pathKey?: string;
  readonly displayPath?: string;
  readonly outcome?: PathEvidence["outcome"];
} = {}): ToolResultNode {
  return node(id, step, {
    kind: "read", target: null, sourceRecallId: null,
    paths: [path(options.pathKey ?? READ_PATH, options.displayPath, options.outcome ?? "hit")],
  });
}

function write(id: string, step: number, options: {
  readonly pathKey?: string;
  readonly displayPath?: string;
  readonly targetKey?: string | null;
  readonly failed?: boolean;
} = {}): ToolResultNode {
  const pathKey = options.pathKey ?? READ_PATH;
  const targetKey = options.targetKey === undefined ? pathKey : options.targetKey;
  return node(id, step, {
    kind: "write",
    target: targetKey === null ? null : { key: targetKey, label: targetKey },
    sourceRecallId: null,
    // A write proves a path changed and nothing else (E0): its outcome is unknown.
    paths: [path(pathKey, options.displayPath ?? pathKey, "unknown")],
    ...(options.failed === true ? { failed: true } : {}),
  }, "written bytes\n");
}

/** The assistant turn declaring every call a result answers, or pairing fails. */
function assistant(nodes: readonly ToolResultNode[]): TranscriptNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes, sha256: sha256Sync(bytes),
    byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: nodes.map(entry => entry.callId),
  };
}

function snapshotOf(nodes: readonly TranscriptNode[],
  pathCoverage?: readonly PathCoverageFact[]): SessionSnapshot {
  return {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: nodes.length, nodes,
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [],
    ...(pathCoverage === undefined ? {} : { pathCoverage }),
  };
}

function unitsOf(snapshot: SessionSnapshot) {
  return new UnitTracker({ sessionId, barBytes }).units(snapshot);
}

function coverage(pathKey: string, bytes: number): PathCoverageFact {
  return { pathKey, bytes, hitBytes: bytes, missBytes: 0, unknownBytes: 0, observations: 1 };
}

type Case = readonly [name: string, run: (name: string) => void | Promise<void>];

/** The write fact itself: one PathWrite per spelling, and nothing for a non-write. */
const WRITE_FACT_CASES: readonly Case[] = [
  ["a write result — one PathWrite per spelling, never a hit or miss claim", name => {
    const written = write("result-1", 2, { pathKey: READ_PATH, displayPath: "app.ts" });
    assert.deepEqual(writePathSpellings(written), [READ_PATH, "app.ts"],
      `row: ${name} — both recorded spellings become write facts, key first`);
    // A read is not a write, so it contributes no write fact even when it names paths.
    assert.deepEqual(writePathSpellings(read("result-0", 1)), [],
      `row: ${name} — a read contributes no write fact`);
    const writes = pathWrites(snapshotOf([assistant([written]), written]));
    assert.deepEqual(writes.map(row => [row.pathKey, row.atIndex, row.atStep]),
      [[READ_PATH, 1, 2], ["app.ts", 1, 2]],
      `row: ${name} — both facts sit at the write's node index and step`);
  }],
  ["a write naming no path — it proves nothing and yields no rows", name => {
    const anonymous = node("result-1", 2, { kind: "write", target: null,
      sourceRecallId: null, paths: [] }, "written bytes\n");
    assert.deepEqual(writePathSpellings(anonymous), [],
      `row: ${name} — a pathless write has no spelling to blame`);
    assert.deepEqual(pathWrites(snapshotOf([assistant([anonymous]), anonymous])), [],
      `row: ${name} — it contributes no write fact to the snapshot`);
  }],
  ["a failed write — the host says nothing changed, so it yields no write fact", name => {
    // ISSUE-328: the failure flag is the host's own fact. A failed write proves
    // no path changed, so it contributes no spelling and no snapshot row.
    const failed = write("result-1", 2, { failed: true });
    assert.deepEqual(writePathSpellings(failed), [],
      `row: ${name} — a failed write has no spelling to blame`);
    assert.deepEqual(pathWrites(snapshotOf([assistant([failed]), failed])), [],
      `row: ${name} — it contributes no write fact to the snapshot`);
    // The control: the same write without the flag yields its spellings.
    assert.deepEqual(writePathSpellings(write("result-1", 2)), [READ_PATH],
      `row: ${name} — the successful control still proves its path`);
  }],
];

/** Which units a write invalidates: order, spelling, and what holds a file copy. */
const UNIT_CASES: readonly Case[] = [
  ["units before a write are invalidated, units after it are not", name => {
    const before = read("result-0", 1);
    const written = write("result-1", 2);
    const after = read("result-2", 3);
    const snapshot = snapshotOf([assistant([before, written, after]), before, written, after]);
    const units = unitsOf(snapshot);
    assert.equal(units.length, 3, `row: ${name} — three above-bar results make three units`);
    const invalidation = computeInvalidation({ snapshot, units });
    // The read before the write holds bytes the write replaced; the one after it
    // holds the written file, so it is current by construction.
    assert.deepEqual(invalidation.units.map(row => row.unit.nodeId), ["result-0"],
      `row: ${name} — only the read before the write is invalidated`);
    assert.equal(invalidation.units[0]?.write.nodeId, "result-1",
      `row: ${name} — the write that replaced the bytes is blamed`);
    assert.equal(invalidation.units[0]?.write.atStep, 2,
      `row: ${name} — and it is blamed at its own step`);
    assert.deepEqual([...invalidation.invalidatedNodeIds], ["result-0"],
      `row: ${name} — the node id set names the same one unit`);
    // The write's own unit is never its own invalidated unit.
    assert.equal(invalidation.byUnit.has(units[1]!.id), false,
      `row: ${name} — the write's own unit is not invalidated by itself`);
    assert.equal(invalidation.byUnit.has(units[2]!.id), false,
      `row: ${name} — the read after the write is not invalidated`);
  }],
  ["a write before the read — the read holds the newer bytes, so nothing invalidates", name => {
    const written = write("result-0", 1);
    const later = read("result-1", 2);
    const snapshot = snapshotOf([assistant([written, later]), written, later]);
    assert.deepEqual(computeInvalidation({ snapshot, units: unitsOf(snapshot) }).units, [],
      `row: ${name} — a write at or before the unit's node proves nothing`);
  }],
  ["a path-equal write with a different display form — it still invalidates", name => {
    // The host keys the path one way and displays it another; both spellings were
    // recorded, so the two calls name one path without any normalization guess.
    const before = read("result-0", 1, { pathKey: READ_PATH, displayPath: "app.ts" });
    const written = write("result-1", 2, { pathKey: READ_PATH, displayPath: "app.ts" });
    const snapshot = snapshotOf([assistant([before, written]), before, written]);
    const units = unitsOf(snapshot);
    const invalidation = computeInvalidation({ snapshot, units });
    assert.deepEqual(invalidation.units.map(row => row.unit.nodeId), ["result-0"],
      `row: ${name} — a shared display form is enough to invalidate`);
    // The spellings agree through either side: key vs display, display vs key.
    assert.equal(samePath(["src/app.ts"], ["app.ts"]), false,
      `row: ${name} — the key alone does not equal the display alone`);
    assert.equal(samePath(["src/app.ts"], ["src/app.ts"]), true,
      `row: ${name} — an identical spelling is the same path`);
  }],
  ["a write whose display form matches the read key — invalidation across the pair", name => {
    // Read keyed `src/app.ts`, displayed `app.ts`; the write is keyed `app.ts`.
    // Only a spelling intersection finds this, and that is the recorded fact.
    const before = read("result-0", 1, { pathKey: READ_PATH, displayPath: "app.ts" });
    const written = write("result-1", 2, { pathKey: "app.ts" });
    const snapshot = snapshotOf([assistant([before, written]), before, written]);
    assert.deepEqual(computeInvalidation({ snapshot, units: unitsOf(snapshot) })
      .units.map(row => row.unit.nodeId), ["result-0"],
    `row: ${name} — the write's key meets the read's display form`);
  }],
  ["a failed write invalidates nothing — the read's bytes are still the file", name => {
    // ISSUE-328: a failed write changed nothing, so the earlier read is not a
    // stale copy and the path's coverage row is still a current measurement.
    const before = read("result-0", 1);
    const failed = write("result-1", 2, { failed: true });
    const snapshot = snapshotOf([assistant([before, failed]), before, failed],
      [coverage(READ_PATH, BODY.length)]);
    const invalidation = computeInvalidation({ snapshot, units: unitsOf(snapshot) });
    assert.deepEqual(invalidation.units, [],
      `row: ${name} — the read before the failed write is not invalidated`);
    assert.deepEqual(invalidation.staleMaps, [],
      `row: ${name} — no stale map: no path is proven written`);
    assert.deepEqual(invalidation.staleCoverage, [],
      `row: ${name} — the coverage row stays a current measurement`);
    assert.deepEqual(withoutStaleCoverage(snapshot, invalidation).pathCoverage,
      snapshot.pathCoverage, `row: ${name} — the planning snapshot keeps the row`);
    // The control: the same write without the flag invalidates the read.
    const succeeded = write("result-1", 2);
    const control = snapshotOf([assistant([before, succeeded]), before, succeeded]);
    assert.deepEqual(computeInvalidation({ snapshot: control, units: unitsOf(control) })
      .units.map(row => row.unit.nodeId), ["result-0"],
    `row: ${name} — the successful control still invalidates`);
  }],
  ["a miss, a search hit and an other-kind result — none holds a file copy", name => {
    const miss = read("result-0", 1, { outcome: "miss" });
    const search = node("result-1", 2, { kind: "search",
      target: { key: "needle", label: "needle" }, sourceRecallId: null,
      paths: [path(READ_PATH, READ_PATH, "hit")] }, BODY);
    const other = node("result-2", 3, { kind: "other", target: null, sourceRecallId: null,
      paths: [path(READ_PATH, READ_PATH, "unknown")] }, BODY);
    const written = write("result-3", 4);
    const nodes = [assistant([miss, search, other, written]), miss, search, other, written];
    const snapshot = snapshotOf(nodes);
    const invalidation = computeInvalidation({ snapshot, units: unitsOf(snapshot) });
    // None of the three returned the file: a miss returned an error, a search hit
    // is output, and `other` claims neither. A write cannot make any of them stale.
    assert.deepEqual(invalidation.units, [],
      `row: ${name} — a miss, a search hit and an other-kind result all survive the write`);
  }],
];

/** The stale maps a write drops, and the engine feeding the fact into planning. */
const STALE_MAP_CASES: readonly Case[] = [
  ["a written path's coverage row — stale, and dropped from the planning snapshot", name => {
    const before = read("result-0", 1);
    const written = write("result-1", 2, { pathKey: READ_PATH, displayPath: "app.ts" });
    const snapshot = snapshotOf([assistant([before, written]), before, written],
      [coverage(READ_PATH, BODY.length), coverage("src/other.ts", 12)]);
    const invalidation = computeInvalidation({ snapshot, units: unitsOf(snapshot) });
    // One map per spelling the write named; the earliest write is the one blamed.
    assert.deepEqual(invalidation.staleMaps.map(row => row.pathKey), [READ_PATH, "app.ts"],
      `row: ${name} — one stale map per spelling the write named`);
    // Only the written path's row drops: the other path was never written.
    assert.deepEqual(invalidation.staleCoverage.map(row => row.pathKey), [READ_PATH],
      `row: ${name} — only the written path's coverage row is stale`);
    const planning = withoutStaleCoverage(snapshot, invalidation);
    assert.deepEqual(planning.pathCoverage?.map(row => row.pathKey), ["src/other.ts"],
      `row: ${name} — the planning snapshot keeps the unwritten path's row`);
    // Everything else is untouched: the write is a fact about the nodes, not a change.
    assert.equal(planning.revision, snapshot.revision,
      `row: ${name} — the revision is unchanged, so no plan's base moves`);
    assert.deepEqual(planning.nodes, snapshot.nodes,
      `row: ${name} — the transcript nodes are untouched`);
  }],
  ["the engine — it plans against the stale-map-free snapshot and reports the fact", async name => {
    const f = await protocolFixture();
    const written = write("result-9", 3, { pathKey: "src/file-1.ts", displayPath: "src/file-1.ts" });
    // Pair the write's call so the transcript is well formed for any later pass.
    f.port.live = {
      ...f.port.live,
      nodes: [...f.port.live.nodes.map(node => node.kind === "message"
        ? { ...node, toolCallIds: [...node.toolCallIds, written.callId] } : node), written],
      pathCoverage: [coverage("src/file-1.ts", 100), coverage("src/file-2.ts", 100)],
    };
    const seen: { pathCoverage?: readonly PathCoverageFact[] }[] = [];
    const capture: Rule = { id: "capture", plan: context => {
      seen.push({ ...(context.snapshot.pathCoverage === undefined
        ? {} : { pathCoverage: context.snapshot.pathCoverage }) });
      return null;
    } };
    const engine = await RacoonsEngine.open({ ...f.options, rules: [capture] });
    const outcome = await engine.process({ kind: "at-rest", eventId: "at-rest-c6", reason: "step" });
    assert.equal(outcome.status, "unchanged",
      `row: ${name} — the capturing rule plans nothing`);
    const firstRead = f.units.find(unit => unit.nodeId === "result-1");
    assert.ok(firstRead !== undefined, `row: ${name} — the fixture holds the read's unit`);
    assert.deepEqual(outcome.invalidation?.unitIds, [firstRead.id],
      `row: ${name} — the read of src/file-1.ts precedes the write and is invalidated`);
    assert.deepEqual(outcome.invalidation?.stalePathKeys, ["src/file-1.ts"],
      `row: ${name} — the outcome names the written path`);
    // The rule saw the planning snapshot: the written path's row is gone, the
    // unwritten path's row still stands.
    assert.equal(seen.length, 1, `row: ${name} — the rule ran exactly once`);
    assert.deepEqual(seen[0]?.pathCoverage?.map(row => row.pathKey), ["src/file-2.ts"],
      `row: ${name} — planning saw the stale-map-free snapshot`);
  }],
];

async function runCases(cases: readonly Case[]): Promise<void> {
  for (const [name, run] of cases) await run(name);
}

test("a write yields one path fact per spelling, and a pathless write yields none", async () => {
  await runCases(WRITE_FACT_CASES);
});

test("only a read holding the file's bytes, before a write naming its path, is invalidated", async () => {
  await runCases(UNIT_CASES);
});

test("a write's stale maps leave the planning snapshot, and the engine reports the fact", async () => {
  await runCases(STALE_MAP_CASES);
});
