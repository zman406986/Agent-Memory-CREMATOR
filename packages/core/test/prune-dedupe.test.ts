import assert from "node:assert/strict";
import { test } from "node:test";
import { planDedupe } from "../src/prune/dedupe/index.js";
import { writtenBetween } from "../src/prune/dedupe/superseded-by-reread.js";
import type { DedupeClasses, DedupePlan } from "../src/prune/dedupe/types.js";
import { planLevel1Prune } from "../src/prune/level1.js";
import { planPrunePass } from "../src/prune/pass.js";
import type {
  MessageNode, PathEvidence, ToolEvidence, ToolResultNode, TranscriptNode,
} from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";

/**
 * The dedupe planner: class 2 (ADR-0037; ISSUE-145) and class 1's exact-echo
 * subset (ADR-0037 decision 2, class 1; ISSUE-151, narrowed 2026-11-06).
 *
 * Class 2: a later WHOLE-FILE read of the same `pathKey` with no write to that
 * path in between makes the earlier read an older snapshot. Class 1: a tool
 * result whose payload restates its own call's declared argument payload and
 * adds nothing is a whole-result removal; a result that carries unique previous
 * state is refused by name, never edited. Every clause is pinned as a reason NOT
 * to plan, because the failure this guard exists to prevent is removing bytes
 * the agent never held whole.
 *
 * Pure: the same input twice yields a deep-equal plan, and neither the units nor
 * the nodes are mutated.
 */

const encoder = new TextEncoder();
const SESSION = "session-dedupe";
const ON: DedupeClasses = { supersededByReread: true };
const ECHO_ON: DedupeClasses = { callEcho: true };
const OFF: DedupeClasses = {};

/**
 * One merged test's cases. Each body receives its row name and puts it on every
 * assertion, so a red run names the clause that broke; the wrapper adds the row
 * name again if a body ever throws before its own message does.
 */
type RowCase = readonly [name: string, run: (row: string) => void];

function eachRow(cases: readonly RowCase[]): void {
  for (const [name, run] of cases) {
    try {
      run(name);
    } catch (error) {
      throw new Error(`row: ${name} failed`, { cause: error });
    }
  }
}

function evidenceOf(
  kind: ToolEvidence["kind"], target: string | null, paths: readonly PathEvidence[],
): ToolEvidence {
  return {
    kind,
    target: target === null ? null : { key: target, label: target },
    paths,
    source: { nodeId: "", sha256: "", byteLength: 0 },
    sourceRecallId: null,
  };
}

/**
 * One read's path observation. `coverage` is the host's declaration of scope; an
 * absent `coverage` is an unannotated read, which is never a witness.
 */
function observed(pathKey: string, options: {
  readonly outcome?: PathEvidence["outcome"];
  readonly coverage?: "full" | "partial";
} = {}): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 3,
    byteLength: 8, outcome: options.outcome ?? "hit",
    ...(options.coverage === undefined ? {} : { coverage: options.coverage }) };
}

function readNode(options: {
  readonly id: string;
  readonly step: number;
  readonly path: string;
  readonly text?: string;
  readonly outcome?: PathEvidence["outcome"];
  readonly coverage?: "full" | "partial";
}): ToolResultNode {
  const bytes = encoder.encode(options.text ?? `${options.path} body\n`);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id: options.id, turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    embeddedRecords: [],
    evidence: {
      ...evidenceOf("read", options.path, [observed(options.path, options)]),
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
    },
  };
}

function writeNode(options: {
  readonly id: string;
  readonly step: number;
  readonly path: string;
  readonly failed?: boolean;
}): ToolResultNode {
  const bytes = encoder.encode(`wrote ${options.path}\n`);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id: options.id, turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    embeddedRecords: [],
    evidence: {
      ...evidenceOf("write", options.path,
        [observed(options.path, { outcome: "unknown" })]),
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      ...(options.failed === true ? { failed: true } : {}),
    },
  };
}

/** The assistant turn that declared the calls a result answers. */
function requestNode(options: {
  readonly id?: string;
  readonly step?: number;
  readonly callIds: readonly string[];
}): MessageNode {
  const bytes = encoder.encode("assistant request");
  return {
    kind: "message", id: options.id ?? "request", role: "assistant",
    turnOrdinal: 1, stepOrdinal: options.step ?? 0, bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length,
    toolCallIds: [...options.callIds],
  };
}

/**
 * One tool result whose evidence is `other` — the todo tool's shape. The
 * `callArguments` field is the request side the class compares against; absent
 * means the host declared no argument payload.
 */
function callNode(options: {
  readonly id: string;
  readonly step: number;
  readonly callId?: string;
  readonly callArguments?: string;
  readonly text?: string;
}): ToolResultNode {
  const bytes = encoder.encode(options.text ?? "{}");
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id: options.id, turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: options.callId ?? `call-${options.id}`,
    ...(options.callArguments === undefined
      ? {} : { callArguments: encoder.encode(options.callArguments) }),
    embeddedRecords: [],
    evidence: {
      kind: "other", target: null, paths: [],
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
    },
  };
}

/** A todo echo pair: the request declaration and the result that repeats it. */
function echoPair(options: {
  readonly todos?: readonly Record<string, unknown>[];
  readonly result?: Readonly<Record<string, unknown>>;
} = {}): readonly TranscriptNode[] {
  const todos = options.todos ?? [{ content: "one", status: "pending" }];
  return [
    requestNode({ callIds: ["call-todo"] }),
    callNode({
      id: "todo", step: 1, callId: "call-todo",
      callArguments: JSON.stringify({ todos }),
      text: JSON.stringify(options.result ?? { todos }),
    }),
  ];
}

function unitsOf(nodes: readonly TranscriptNode[], barBytes = 1): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes });
  return nodes.flatMap(node => tracker.unitsFor(node));
}

function unitIdOf(nodes: readonly TranscriptNode[], nodeId: string): string {
  const node = nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  const unit = unitsOf([node])[0];
  assert.ok(unit, `missing unit for ${nodeId}`);
  return unit.id;
}

function planOf(
  nodes: readonly TranscriptNode[], classes: DedupeClasses = ON,
  units: readonly ProcessingUnit[] = unitsOf(nodes),
): DedupePlan {
  return planDedupe({ units, nodes, classes });
}

/** Two whole-file reads of one path whose bytes differ: the class-2 subject. */
function reread(): readonly ToolResultNode[] {
  return [
    readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
    readNode({ id: "r2", step: 2, path: "src/a.ts", text: "beta\n", coverage: "full" }),
  ];
}

const ZERO_COUNTS = {
  "superseded-by-reread": 0, "call-echo": 0, "launch-receipt": 0, "harness-copy": 0,
} as const;

// --- the copy that leaves and the witness that keeps it ---------------------

test("a later whole-file read supersedes the earlier read, and the proof names the surviving read", () => {
  eachRow([
    ["one earlier read leaves, and its proof is the fact the guard re-derives", row => {
      const nodes = reread();
      const units = unitsOf(nodes);
      const plan = planOf(nodes);
      assert.equal(plan.removals.length, 1, `row: ${row} — exactly one removal`);
      const removal = plan.removals[0];
      assert.ok(removal !== undefined, `row: ${row} — the removal exists`);
      if (removal === undefined) return;
      // The unit that leaves is the earlier read's, and nothing else.
      assert.equal(removal.unitId, unitIdOf(nodes, "r1"), `row: ${row} — the earlier read leaves`);
      assert.equal(removal.rule, "superseded-by-reread", `row: ${row} — the class-2 rule`);
      // The proof the planner ships must be a fact the guard can re-derive: the
      // rule, the path key, the witness node and its unit, and the fact itself.
      // guard-proofs owns the re-derivation; this row pins that the plan CARRIES it.
      assert.equal(removal.proof.rule, "superseded-by-reread", `row: ${row} — the proof names its rule`);
      assert.equal(removal.proof.identityKey, "src/a.ts", `row: ${row} — identity is the path key`);
      assert.equal(removal.proof.witnessNodeId, "r2", `row: ${row} — the witness is the later read`);
      assert.equal(removal.proof.witnessUnitId, unitIdOf(nodes, "r2"),
        `row: ${row} — the witness unit is the later read's unit`);
      assert.deepEqual(removal.proof.fact, { kind: "superseded-by-reread", pathKey: "src/a.ts", witnessIndex: 1 },
        `row: ${row} — the fact is the path and where the newer read is`);
      assert.deepEqual(plan.counts, { ...ZERO_COUNTS, "superseded-by-reread": 1 },
        `row: ${row} — one count in class 2 and zero elsewhere`);
      // The later read is the witness and is never removed.
      assert.equal(plan.removals.some(candidate => candidate.unitId === unitIdOf(nodes, "r2")), false,
        `row: ${row} — the witness survives`);
      // Both units existed; only the earlier one was planned.
      assert.equal(units.length, 2, `row: ${row} — both units were minted`);
    }],
    ["three reads leave the earlier two, and both proofs name the surviving read", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "one\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "two\n", coverage: "full" }),
        readNode({ id: "r3", step: 3, path: "src/a.ts", text: "three\n", coverage: "full" }),
      ];
      const plan = planOf(nodes);
      assert.deepEqual(plan.removals.map(removal => removal.unitId),
        [unitIdOf(nodes, "r1"), unitIdOf(nodes, "r2")],
        `row: ${row} — transcript order, one per unit`);
      for (const removal of plan.removals) {
        assert.equal(removal.proof.witnessNodeId, "r3", `row: ${row} — the surviving full read`);
        assert.equal(removal.proof.witnessUnitId, unitIdOf(nodes, "r3"),
          `row: ${row} — both proofs name the surviving read unit`);
      }
      assert.deepEqual(plan.removals.map(removal => removal.proof.fact), [
        { kind: "superseded-by-reread", pathKey: "src/a.ts", witnessIndex: 2 },
        { kind: "superseded-by-reread", pathKey: "src/a.ts", witnessIndex: 2 },
      ], `row: ${row} — both facts name the surviving read's index`);
    }],
    ["a below-floor later read is still a witness, and names no witness unit", row => {
      // The earlier read is above the bar (a unit exists); the later read is below
      // it, so no unit was ever minted for it — but the node is in the snapshot,
      // and a node is what the witness rule reads.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "x".repeat(200), coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "y".repeat(4), coverage: "full" }),
      ];
      const units = unitsOf(nodes, 100);
      assert.deepEqual(units.map(unit => unit.nodeId), ["r1"], `row: ${row} — the witness has no unit`);
      const plan = planOf(nodes, ON, units);
      assert.equal(plan.removals.length, 1, `row: ${row} — the earlier read still leaves`);
      assert.equal(plan.removals[0]?.unitId, unitIdOf(nodes, "r1"), `row: ${row} — the above-bar read leaves`);
      assert.equal(plan.removals[0]?.proof.witnessNodeId, "r2", `row: ${row} — the node is still a witness`);
      assert.equal(plan.removals[0]?.proof.witnessUnitId, null,
        `row: ${row} — no unit exists for the witness`);
    }],
  ]);
});

// --- every clause is a reason not to plan ----------------------------------

test("a later read is a witness only when it is whole, hit and declared", () => {
  eachRow([
    ["a partial later read is not a witness: it names a slice, not the object", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "beta\n", coverage: "partial" }),
      ];
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — a partial witness plans nothing`);
    }],
    ["a later read with no coverage declaration is not a witness", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "beta\n" }),
      ];
      // Absence is never a guess: no declaration means no whole-file claim, even
      // when the bytes in the transcript happen to be the whole file.
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — an undeclared read plans nothing`);
    }],
    ["a failed later read is not a witness", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "beta\n",
          outcome: "miss", coverage: "full" }),
      ];
      // A miss returned no content, so it is not a newer copy of anything.
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — a miss plans nothing`);
    }],
  ]);
});

test("a write to the same path between the reads splits two states; another path's write does not", () => {
  eachRow([
    ["a write to the same path between the reads means two different states", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        writeNode({ id: "w1", step: 2, path: "src/a.ts" }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — a write between plans nothing`);
    }],
    ["a write to another path between the reads leaves the removal planned", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        writeNode({ id: "w1", step: 2, path: "src/other.ts" }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      const plan = planOf(nodes);
      assert.deepEqual(plan.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — another path's write blocks nothing`);
    }],
    ["a write before both reads does not sit between them", row => {
      const nodes = [
        writeNode({ id: "w1", step: 1, path: "src/a.ts" }),
        readNode({ id: "r1", step: 2, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      const plan = planOf(nodes);
      assert.deepEqual(plan.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — an earlier write sits outside the window`);
    }],
  ]);
});

test("invisible mutations between the reads withhold the burn (ISSUE-330)", () => {
  eachRow([
    ["a shell result between the reads may have changed the file: nothing is planned", row => {
      // Kind `other` carries no hit/miss claim and no path attribution: a
      // `sed -i` looks exactly like this. Absence of a write-kind node is not
      // proof that nothing changed, so the earlier copy stays.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        callNode({ id: "sh", step: 2 }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — a shell between plans nothing`);
    }],
    ["a call declared between the reads with no result node was aborted: nothing is planned", row => {
      // An aborted write never lands a result node. The declaration is the only
      // trace, and what the call changed before it died is unknown.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        requestNode({ id: "req-abort", step: 2, callIds: ["call-aborted"] }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — an aborted call plans nothing`);
    }],
    ["a failed write between the reads changed nothing: the removal is planned", row => {
      // ISSUE-328's flag flows through writePathSpellings: a failed write is no
      // mutation, so it no longer withholds the burn either.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        writeNode({ id: "w1", step: 2, path: "src/a.ts", failed: true }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      const plan = planOf(nodes);
      assert.deepEqual(plan.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — a failed write blocks nothing`);
    }],
    ["an answered call declared between the reads blocks nothing: the control", row => {
      // The later read's own declaration sits in the window and its result
      // landed: a message alone is not mutation evidence.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        requestNode({ id: "req-r2", step: 2, callIds: ["call-r2"] }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      const plan = planOf(nodes);
      assert.deepEqual(plan.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — an answered declaration blocks nothing`);
    }],
  ]);
});

test("identity is the path key, and only a unit the pass holds is a removal subject", () => {
  eachRow([
    ["two different path keys are two different objects", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "same text\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/b.ts", text: "same text\n", coverage: "full" }),
      ];
      // Same bytes, different paths: the identity rule never groups them, and L1's
      // byte families are not this pass's business.
      assert.deepEqual(planOf(nodes).removals, [], `row: ${row} — different paths never group`);
    }],
    ["a duplicated unit id plans one removal: first position wins", row => {
      const nodes = reread();
      const units = unitsOf(nodes);
      const plan = planDedupe({ units: [units[0]!, ...units], nodes, classes: ON });
      assert.equal(plan.removals.length, 1, `row: ${row} — one removal, not two`);
      assert.equal(plan.counts["superseded-by-reread"], 1, `row: ${row} — one count`);
    }],
    ["a node the units no longer carry is never a removal subject", row => {
      const nodes = reread();
      // A unit whose node left the snapshot has no index and no identity: it is
      // skipped rather than guessed at from its bytes.
      const plan = planDedupe({ units: [], nodes, classes: ON });
      assert.deepEqual(plan.removals, [], `row: ${row} — no unit, no removal`);
    }],
  ]);
});

// --- L1 first, one claim per unit ------------------------------------------

test("L1 owns its unit first, and a settled keep never blocks a byte proof", () => {
  eachRow([
    ["a unit an L1 family already proved is never planned twice", row => {
      // Byte-identical re-reads: L1's `stale-exact-reread` owns the earlier copy.
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
      ];
      const units = unitsOf(nodes);
      const l1 = planLevel1Prune({ units, nodes, episodes: [] });
      assert.deepEqual(l1.removals.map(removal => removal.rule), ["stale-exact-reread"],
        `row: ${row} — L1 takes the earlier copy`);
      const kept = new Set(l1.kept);
      const plan = planOf(nodes, ON, units.filter(unit => kept.has(unit.id)));
      assert.deepEqual(plan.removals, [], `row: ${row} — the L1-claimed unit is not in the dedupe's input`);
      // The pass itself wires the same order: one claim on that unit, not two.
      const pass = planPrunePass({ units, nodes, episodes: [], round: 1, classes: ON });
      assert.deepEqual(pass.l1.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — the pass's L1 claims r1`);
      assert.deepEqual(pass.dedupe.removals, [], `row: ${row} — the pass's dedupe claims nothing`);
    }],
    ["a settled entry keep does not block a dedupe removal", row => {
      const nodes = reread();
      const units = unitsOf(nodes);
      const settled = new Set([unitIdOf(nodes, "r1")]);
      const plan = planPrunePass({ units, nodes, episodes: [], round: 1, classes: ON, settled });
      // A settled keep is a verdict about value; a duplicate is a byte fact about a
      // newer copy (ADR-0037 decision 7). The proof stands and the unit is removed,
      // so it is not withheld as settled either.
      assert.deepEqual(plan.dedupe.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — the byte proof removes a settled unit`);
      assert.deepEqual(plan.settledWithheld, [], `row: ${row} — it is not withheld as settled`);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), [unitIdOf(nodes, "r2")],
        `row: ${row} — only the witness is asked`);
    }],
  ]);
});

// --- class 1: the call echo's exact subset --------------------------------

test("class 1 plans a whole-result removal only for an exact echo of the request argument", () => {
  eachRow([
    ["an exact echo is removed as the whole result, and the request is the witness", row => {
      const nodes = echoPair();
      const plan = planOf(nodes, ECHO_ON);
      assert.equal(plan.removals.length, 1, `row: ${row} — one removal`);
      const removal = plan.removals[0];
      assert.ok(removal !== undefined, `row: ${row} — the removal exists`);
      if (removal === undefined) return;
      assert.equal(removal.unitId, unitIdOf(nodes, "todo"), `row: ${row} — the result's whole unit leaves`);
      assert.equal(removal.rule, "call-echo", `row: ${row} — the class-1 rule`);
      assert.equal(removal.proof.identityKey, "call-todo", `row: ${row} — identity is the call id`);
      assert.equal(removal.proof.witnessNodeId, "request", `row: ${row} — the request message is the witness`);
      assert.equal(removal.proof.witnessUnitId, null, `row: ${row} — a message has no unit`);
      assert.deepEqual(removal.proof.fact,
        { kind: "call-echo", callId: "call-todo", witnessIndex: 0 },
        `row: ${row} — the fact is the call and where its request sits`);
      assert.deepEqual(plan.counts, { ...ZERO_COUNTS, "call-echo": 1 },
        `row: ${row} — one count in class 1 and zero elsewhere`);
      assert.deepEqual(plan.refusals, [], `row: ${row} — an exact echo refuses nothing`);
    }],
    ["key order and whitespace do not decide the echo: the comparison is semantic JSON", row => {
      const todos = [{ content: "one", status: "pending" }];
      const nodes = [
        requestNode({ callIds: ["call-todo"] }),
        callNode({ id: "todo", step: 1, callId: "call-todo",
          callArguments: '{ "todos" : [ { "status" : "pending", "content" : "one" } ] }',
          text: JSON.stringify({ todos }) }),
      ];
      assert.equal(planOf(nodes, ECHO_ON).removals.length, 1,
        `row: ${row} — the same value in another spelling still echoes`);
    }],
    ["an empty oldTodos adds nothing, so the whole result still leaves", row => {
      const todos = [{ content: "one" }];
      assert.equal(planOf(echoPair({ todos, result: { todos, oldTodos: [] } }), ECHO_ON)
        .removals.length, 1, `row: ${row} — an empty previous-state array carries no state`);
    }],
    ["oldTodos that repeats the request's own list adds nothing either", row => {
      const todos = [{ content: "one" }];
      assert.equal(planOf(echoPair({ todos, result: { todos, oldTodos: todos } }), ECHO_ON)
        .removals.length, 1, `row: ${row} — a repeated list is not new state`);
    }],
    ["oldTodos with data the request never held refuses by name and removes nothing", row => {
      const nodes = echoPair({
        todos: [{ content: "one" }],
        result: { todos: [{ content: "one" }], oldTodos: [{ content: "yesterday" }] },
      });
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — prior state is never removed`);
      assert.deepEqual(plan.refusals, [{
        unitId: unitIdOf(nodes, "todo"), rule: "call-echo", reason: "call-echo-previous-state",
      }], `row: ${row} — the refusal names the previous-state clause`);
    }],
    ["a result item absent from the request refuses as a list difference", row => {
      const nodes = echoPair({
        todos: [{ content: "one" }],
        result: { todos: [{ content: "one" }, { content: "two" }] },
      });
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — no echo`);
      assert.equal(plan.refusals[0]?.reason, "call-echo-list-differs",
        `row: ${row} — the list is the difference`);
    }],
    ["a result that adds a field the request never declared refuses", row => {
      const todos = [{ content: "one" }];
      const nodes = echoPair({ todos, result: { todos, status: "ok" } });
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — the result adds state`);
      assert.equal(plan.refusals[0]?.reason, "call-echo-result-adds-state",
        `row: ${row} — the extra field is named`);
    }],
    ["an absent request argument refuses a todo result by name", row => {
      const todos = [{ content: "one" }];
      const nodes = [
        requestNode({ callIds: ["call-todo"] }),
        callNode({ id: "todo", step: 1, callId: "call-todo", text: JSON.stringify({ todos }) }),
      ];
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — the request side is unknown`);
      assert.equal(plan.refusals[0]?.reason, "call-echo-arguments-absent",
        `row: ${row} — the missing declaration is named`);
    }],
    ["no live request message refuses the echo", row => {
      const nodes = [callNode({ id: "todo", step: 1, callId: "call-todo",
        callArguments: JSON.stringify({ todos: [{ content: "one" }] }),
        text: JSON.stringify({ todos: [{ content: "one" }] }) })];
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — no request means no live copy`);
      assert.equal(plan.refusals[0]?.reason, "call-echo-request-not-live",
        `row: ${row} — the missing request is named`);
    }],
    ["a non-todo tool result is not a subject and is not refused", row => {
      const nodes = [
        requestNode({ callIds: ["call-other"] }),
        callNode({ id: "other", step: 1, callId: "call-other",
          callArguments: JSON.stringify({ path: "a.ts" }),
          text: JSON.stringify({ path: "a.ts" }) }),
      ];
      const plan = planOf(nodes, ECHO_ON);
      assert.deepEqual(plan.removals, [], `row: ${row} — no todo list, no class-1 subject`);
      assert.deepEqual(plan.refusals, [], `row: ${row} — silence is not a refusal for another tool`);
    }],
  ]);
});

test("a stale unit whose source no longer matches the node plans no call-echo removal (ISSUE-337)", () => {
  eachRow([
    ["a unit with a mismatched source sha256 is refused, never removed from wrong bytes", row => {
      const nodes = echoPair();
      const units = unitsOf(nodes).map(unit => unit.nodeId === "todo"
        ? { ...unit, source: { ...unit.source, sha256: "0".repeat(64) } }
        : unit);
      const plan = planOf(nodes, ECHO_ON, units);
      assert.deepEqual(plan.removals, [], `row: ${row} — a stale source plans no removal`);
      assert.deepEqual(plan.refusals, [{
        unitId: unitIdOf(nodes, "todo"), rule: "call-echo", reason: "call-echo-not-whole-result",
      }], `row: ${row} — the mismatched source is refused as not-the-whole-result`);
    }],
    ["a unit with a mismatched source byteLength is refused too", row => {
      const nodes = echoPair();
      const units = unitsOf(nodes).map(unit => unit.nodeId === "todo"
        ? { ...unit, source: { ...unit.source, byteLength: unit.source.byteLength + 1 } }
        : unit);
      const plan = planOf(nodes, ECHO_ON, units);
      assert.deepEqual(plan.removals, [], `row: ${row} — a stale length plans no removal`);
      assert.equal(plan.refusals[0]?.reason, "call-echo-not-whole-result",
        `row: ${row} — the mismatched length is named`);
    }],
    ["the control: a matching source still plans the whole-result echo", row => {
      const nodes = echoPair();
      const plan = planOf(nodes, ECHO_ON, unitsOf(nodes));
      assert.equal(plan.removals.length, 1, `row: ${row} — the check never over-rejects`);
      assert.deepEqual(plan.refusals, [], `row: ${row} — a matching source refuses nothing`);
    }],
  ]);
});

test("class 1 and class 2 both plan, and a deduped row never reaches the ask", () => {
  eachRow([
    ["both classes keep their own removals and counts", row => {
      const nodes = [...reread(), ...echoPair()];
      const plan = planOf(nodes, { supersededByReread: true, callEcho: true });
      assert.deepEqual(plan.removals.map(removal => removal.rule),
        ["superseded-by-reread", "call-echo"], `row: ${row} — transcript order, one per class`);
      assert.deepEqual(plan.counts, {
        ...ZERO_COUNTS, "superseded-by-reread": 1, "call-echo": 1,
      }, `row: ${row} — each class counts its own removal`);
    }],
    ["the pass asks about every kept unit except the echoed one", row => {
      const nodes = echoPair();
      const todo = nodes.find(node => node.id === "todo");
      assert.ok(todo?.kind === "tool-result", `row: ${row} — the todo result exists`);
      const pass = planPrunePass({
        units: unitsOf(nodes), nodes: [todo], transcriptNodes: nodes,
        episodes: [], round: 1, classes: ECHO_ON,
      });
      assert.deepEqual(pass.dedupe.removals.map(removal => removal.unitId),
        [unitIdOf(nodes, "todo")], `row: ${row} — the echo is planned`);
      assert.deepEqual(pass.askRows, [], `row: ${row} — a deduped row is skipped from the ask`);
    }],
  ]);
});

// --- determinism and the default-off switch --------------------------------

test("the planner is pure, and every switch off plans nothing with a zero count per class", () => {
  eachRow([
    ["the same input twice yields a deep-equal plan and mutates nothing", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "beta\n", coverage: "full" }),
        readNode({ id: "r3", step: 3, path: "src/b.ts", text: "gamma\n", coverage: "full" }),
      ];
      const units = unitsOf(nodes);
      const before = structuredClone({ nodes, units });
      const once = planOf(nodes);
      const again = planOf(nodes);
      assert.deepEqual(again, once, `row: ${row} — the plan is deterministic`);
      assert.deepEqual({ nodes, units }, before, `row: ${row} — the planner mutates neither input`);
    }],
    ["every switch off plans nothing, with a zero count in every class", row => {
      const nodes = reread();
      const empty = planOf(nodes, OFF);
      assert.deepEqual(empty, { removals: [], counts: ZERO_COUNTS, refusals: [] },
        `row: ${row} — an absent switch plans nothing`);
      // An explicit false is the same statement as an absent switch.
      assert.deepEqual(planOf(nodes, { supersededByReread: false }), empty,
        `row: ${row} — an explicit false is the same statement`);
      // Class 1 is off unless its own switch is on: the same input that echoes
      // when the switch is on plans nothing when it is absent or false.
      assert.deepEqual(planOf(echoPair(), OFF), empty,
        `row: ${row} — call-echo absent means off`);
      assert.deepEqual(planOf(echoPair(), { callEcho: false }), empty,
        `row: ${row} — an explicit false is off`);
      assert.equal(planOf(echoPair(), ECHO_ON).removals.length, 1,
        `row: ${row} — the switch is what turns the class on`);
      // Classes 3 and 4 are declared and unplannable in this phase: turning one
      // on plans nothing, so no class ships ahead of its probe (ADR-0037 decision 6).
      for (const classes of [
        { launchReceipt: true }, { harnessCopy: true },
        { launchReceipt: true, harnessCopy: true },
      ] satisfies readonly DedupeClasses[]) {
        assert.deepEqual(planOf(nodes, classes), empty,
          `row: ${row} — ${JSON.stringify(classes)} ships nothing`);
      }
    }],
  ]);
});

// --- the answered set is pass-scoped, never cached across calls (ISSUE-382) --

test("a multi-witness pass plans each older copy against its own surviving read", () => {
  const nodes = [
    readNode({ id: "a1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
    readNode({ id: "a2", step: 2, path: "src/a.ts", text: "beta\n", coverage: "full" }),
    readNode({ id: "b1", step: 3, path: "src/b.ts", text: "gamma\n", coverage: "full" }),
    requestNode({ id: "req-a3", step: 4, callIds: ["call-a3"] }),
    readNode({ id: "a3", step: 5, path: "src/a.ts", text: "delta\n", coverage: "full" }),
    readNode({ id: "b2", step: 6, path: "src/b.ts", text: "epsilon\n", coverage: "full" }),
  ];
  const once = planOf(nodes);
  assert.deepEqual(once.removals.map(removal => removal.unitId),
    [unitIdOf(nodes, "a1"), unitIdOf(nodes, "a2"), unitIdOf(nodes, "b1")],
    "both older a.ts copies and the older b.ts copy leave");
  assert.deepEqual(once.removals.map(removal => removal.proof.fact), [
    { kind: "superseded-by-reread", pathKey: "src/a.ts", witnessIndex: 4 },
    { kind: "superseded-by-reread", pathKey: "src/a.ts", witnessIndex: 4 },
    { kind: "superseded-by-reread", pathKey: "src/b.ts", witnessIndex: 5 },
  ], "each removal names its own path's surviving read");
  assert.deepEqual(planOf(nodes), once, "a second pass over the same nodes is deep-equal");
});

test("the answered set reads the array's current content, not a cached identity (ISSUE-382)", () => {
  eachRow([
    ["a result appended to the SAME array after a call answers the window's call", row => {
      const nodes: TranscriptNode[] = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        requestNode({ id: "req", step: 2, callIds: ["call-late"] }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      assert.equal(writtenBetween(nodes, 0, 2, "src/a.ts"), true,
        `row: ${row} — the declared call is unanswered at first`);
      assert.deepEqual(planOf(nodes).removals, [],
        `row: ${row} — an unanswered call withholds the burn`);
      // The host lands the result in the same array object between calls. Any
      // memo keyed on the array's identity alone would miss it (stale cache).
      nodes.push(callNode({ id: "late", step: 4, callId: "call-late" }));
      assert.equal(writtenBetween(nodes, 0, 2, "src/a.ts"), false,
        `row: ${row} — the landed answer is seen by the next call`);
      assert.deepEqual(planOf(nodes).removals.map(removal => removal.unitId),
        [unitIdOf(nodes, "r1")], `row: ${row} — the quiet window now plans the burn`);
    }],
    ["an in-place replacement at unchanged length is seen too", row => {
      const nodes: TranscriptNode[] = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "alpha\n", coverage: "full" }),
        requestNode({ id: "req", step: 2, callIds: ["call-late"] }),
        readNode({ id: "r2", step: 3, path: "src/a.ts", text: "beta\n", coverage: "full" }),
      ];
      assert.equal(writtenBetween(nodes, 0, 2, "src/a.ts"), true,
        `row: ${row} — the declared call is unanswered at first`);
      // Same array, same length: only the window node's content changes. A
      // length-guarded identity memo would still be stale here.
      nodes[1] = requestNode({ id: "req", step: 2, callIds: ["call-r2"] });
      assert.equal(writtenBetween(nodes, 0, 2, "src/a.ts"), false,
        `row: ${row} — the replacement declaration is answered by r2`);
    }],
  ]);
});
