import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPruneAskTable } from "../src/prune/ask.js";
import { estimatePassTokens, planPrunePass } from "../src/prune/pass.js";
import { applyPruneAnswers } from "../src/prune/pass-answers.js";
import { applicationFromVerdicts } from "../src/prune/pass-merge.js";
import type { PrunePassPlan } from "../src/prune/pass.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import type { KeptLineSpan } from "../src/verdicts/types.js";
import type { WireAnswer } from "../src/verdicts/wire.js";

const encoder = new TextEncoder();
const SESSION = "session-1";

/**
 * One merged test's cases. Each body receives its row name and puts it on every
 * assertion, so a red run names the branch that broke; the wrapper re-names a
 * body that throws before its own message does.
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

function hit(pathKey: string): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 3, byteLength: 8, outcome: "hit" };
}

/** A read the host declared as covering the whole file (ADR-0037 class 2). */
function hitFull(pathKey: string): PathEvidence {
  return { ...hit(pathKey), coverage: "full" };
}

function nodeOf(
  id: string, text: string, evidence: ToolEvidence, stepOrdinal: number,
): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidence, source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

/** The units the tracker builds for these nodes, in transcript order. */
function unitsOf(nodes: readonly ToolResultNode[]): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  return nodes.flatMap(node => tracker.unitsFor(node));
}

const SAME = "export const a = 1;\n";

/**
 * The standard fixture, in transcript order: `r1` is the stale copy of `r2`,
 * `b`..`f` are distinct content L1 can prove nothing about.
 */
function fixture(): readonly ToolResultNode[] {
  return [
    nodeOf("r1", SAME, evidenceOf("read", "src/a.ts", [hit("src/a.ts")]), 1),
    nodeOf("r2", SAME, evidenceOf("read", "src/a.ts", [hit("src/a.ts")]), 3),
    nodeOf("b", "beta body one\nbeta body two\n", evidenceOf("read", "src/b.ts", [hit("src/b.ts")]), 4),
    nodeOf("c", "gamma line\n", evidenceOf("read", "src/c.ts", [hit("src/c.ts")]), 5),
    nodeOf("d", "delta line\n", evidenceOf("read", "src/d.ts", [hit("src/d.ts")]), 6),
    nodeOf("e", "epsilon line\n", evidenceOf("read", "src/e.ts", [hit("src/e.ts")]), 7),
    nodeOf("f", "zeta line\n", evidenceOf("read", "src/f.ts", [hit("src/f.ts")]), 8),
  ];
}

/**
 * Two whole-file reads of one path whose bytes differ, plus two unrelated
 * results. L1 proves nothing here (no episode, no identical re-read, no
 * duplicate), so this is the fixture the superseded-read dedupe exists for.
 */
function rereadFixture(): readonly ToolResultNode[] {
  return [
    nodeOf("o1", "export const a = 1;\n",
      evidenceOf("read", "src/a.ts", [hitFull("src/a.ts")]), 1),
    nodeOf("o2", "export const a = 2;\nexport const b = 3;\n",
      evidenceOf("read", "src/a.ts", [hitFull("src/a.ts")]), 3),
    nodeOf("b", "beta body one\nbeta body two\n",
      evidenceOf("read", "src/b.ts", [hit("src/b.ts")]), 4),
    nodeOf("c", "gamma line\n",
      evidenceOf("read", "src/c.ts", [hit("src/c.ts")]), 5),
  ];
}

/** The fixture's ids in the order the ask lists them: L1 keeps `r2`, drops `r1`. */
const ASKED_IDS = ["r2", "b", "c", "d", "e", "f"] as const;

function unitIdOf(nodes: readonly ToolResultNode[], nodeId: string): string {
  const node = nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  const unit = unitsOf([node])[0];
  assert.ok(unit, `missing unit for ${nodeId}`);
  return unit.id;
}

function idsOf(nodes: readonly ToolResultNode[], names: readonly string[]): readonly string[] {
  return names.map(id => unitIdOf(nodes, id));
}

function planOf(
  nodes: readonly ToolResultNode[],
  options: { readonly round?: number; readonly grammar?: "3option" | "nokeepall" } = {},
): PrunePassPlan {
  return planPrunePass({
    units: unitsOf(nodes), nodes, episodes: [], classes: {},
    round: options.round ?? 1,
    // These cases are the shipped three-way contract unless they name the
    // grammar; the no-grammar default has its own test below.
    grammar: options.grammar ?? "3option",
  });
}

function indicesOf(plan: PrunePassPlan): readonly number[] {
  return plan.askRows.map(row => row.index);
}

function answerOf(plan: PrunePassPlan, texts: readonly string[]) {
  return applyPruneAnswers(plan, texts, { indices: indicesOf(plan), stamps: plan.stamps });
}

// --- planning: L1 first, then the ask ---------------------------------------

test("L1 runs first and the ask is exactly its kept list, numbered once, deterministically", () => {
  eachRow([
    ["L1 runs first: its stale copy is a removal and never an ask row", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      assert.deepEqual(plan.l1.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — L1 removes the stale copy`);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), idsOf(nodes, ASKED_IDS),
        `row: ${row} — the ask lists every kept unit`);
    }],
    ["the ask covers exactly L1's kept list, numbered in transcript order", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), plan.l1.kept,
        `row: ${row} — the ask is L1's kept list`);
      assert.deepEqual(indicesOf(plan), [1, 2, 3, 4, 5, 6],
        `row: ${row} — indices ascend from one`);
      // Deterministic: a second plan is byte-identical and inputs are untouched.
      const before = structuredClone(nodes);
      assert.deepEqual(planOf(nodes), plan, `row: ${row} — a second plan is deep-equal`);
      assert.deepEqual(nodes, before, `row: ${row} — the inputs are untouched`);
    }],
    ["Ruling 8: a kept unit with no reference anywhere is still asked", row => {
      // A tool result nothing cites, no episode names, no later read repeats: use
      // is unobservable, so L1 must keep it and the ask must offer it.
      const orphan = nodeOf("orphan", "unreferenced body\n", evidenceOf("other", null), 9);
      const nodes = [...fixture(), orphan];
      const plan = planOf(nodes);
      const unitId = unitIdOf(nodes, "orphan");
      assert.equal(plan.l1.removals.some(removal => removal.unitId === unitId), false,
        `row: ${row} — nothing removes the orphan`);
      assert.equal(plan.l1.kept.includes(unitId), true, `row: ${row} — L1 keeps the orphan`);
      assert.equal(plan.askRows.some(entry => entry.unit.id === unitId), true,
        `row: ${row} — the ask offers the orphan`);
    }],
    ["every L1-kept unit appears in exactly one table, and the tables are the ask", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      const split = planPrunePass({
        units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1,
        grammar: "3option",
      });
      for (const chosen of [plan, split]) {
        const flat = chosen.tables.flatMap(table => table.rows);
        assert.deepEqual(flat, chosen.askRows, `row: ${row} — the tables are the ask`);
        for (const entry of chosen.askRows) {
          assert.equal(flat.filter(candidate => candidate.index === entry.index).length, 1,
            `row: ${row} — index ${String(entry.index)} appears once`);
        }
      }
      assert.equal(split.tables.length, 1,
        `row: ${row} — no row cap: the whole ask is one table`);
      // Indices are pass-wide: a split never renumbers.
      assert.deepEqual(split.tables.flatMap(table => table.rows.map(entry => entry.index)),
        indicesOf(split), `row: ${row} — a split renumbers nothing`);
      assert.deepEqual(indicesOf(split), indicesOf(plan), `row: ${row} — the split keeps the indices`);
    }],
    ["stamps carry the round and the row's own unit; duplicates are planned once", row => {
      const nodes = fixture();
      const plan = planOf(nodes, { round: 7 });
      assert.equal(plan.round, 7, `row: ${row} — the round rides the plan`);
      for (const entry of plan.askRows) {
        assert.deepEqual(plan.stamps.get(entry.index), { unitId: entry.unit.id, answeredInRound: 7 },
          `row: ${row} — index ${String(entry.index)} is stamped with its own unit`);
      }
      const doubled = planPrunePass({
        units: [...unitsOf(nodes), ...unitsOf(nodes)], nodes, episodes: [], classes: {},
        round: 1,
      });
      assert.deepEqual(doubled.askRows.map(entry => entry.unit.id),
        plan.askRows.map(entry => entry.unit.id), `row: ${row} — a duplicate unit is asked once`);
      assert.deepEqual(doubled.units.map(unit => unit.id), plan.units.map(unit => unit.id),
        `row: ${row} — a duplicate unit is counted once`);
    }],
  ]);
});

// --- the settled set (ISSUE-073) --------------------------------------------

test("a settled entry keep shrinks only the ask, and an absent or foreign settled set excludes nothing", () => {
  eachRow([
    ["a settled entry keep is never re-listed by a later pass", row => {
      const nodes = fixture();
      const settled = new Set([unitIdOf(nodes, "c"), unitIdOf(nodes, "e")]);
      const plan = planPrunePass({ units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1, settled });
      // Only the ask shrinks: L1's proof over `r1` is untouched, and the units the
      // caller did not settle are still numbered, in transcript order.
      assert.deepEqual(plan.l1.removals.map(removal => removal.unitId), [unitIdOf(nodes, "r1")],
        `row: ${row} — L1's proof is untouched`);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), idsOf(nodes, ["r2", "b", "d", "f"]),
        `row: ${row} — the settled units are not listed`);
      assert.deepEqual(indicesOf(plan), [1, 2, 3, 4], `row: ${row} — the ask renumbers from one`);
      assert.deepEqual(plan.settledWithheld, [unitIdOf(nodes, "c"), unitIdOf(nodes, "e")],
        `row: ${row} — the withheld units are named`);
      // Nothing is invented: the withheld units are still in the plan's own list.
      assert.deepEqual(plan.units.map(unit => unit.id), unitsOf(nodes).map(unit => unit.id),
        `row: ${row} — the plan still holds every unit`);
      // A settled id that names no unit this pass holds excludes nothing.
      const foreign = planPrunePass({ units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1,
        settled: new Set(["unit:sha256:not-here"]) });
      assert.deepEqual(foreign.askRows.map(entry => entry.unit.id),
        planOf(nodes).askRows.map(entry => entry.unit.id),
        `row: ${row} — a foreign settled id excludes nothing`);
      assert.deepEqual(foreign.settledWithheld, [], `row: ${row} — nothing was withheld`);
    }],
    ["no settled set excludes nothing: a pass without one lists every kept unit", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      assert.deepEqual(plan.settledWithheld, [], `row: ${row} — no settled set withholds nothing`);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), plan.l1.kept,
        `row: ${row} — every kept unit is listed`);
      // An empty set is the same thing, not a different reading.
      const empty = planPrunePass({ units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1,
        settled: new Set<string>() });
      assert.deepEqual(empty.askRows.map(entry => entry.unit.id),
        plan.askRows.map(entry => entry.unit.id), `row: ${row} — an empty set is the same reading`);
    }],
  ]);
});

// --- merging the answers -----------------------------------------------------

test("a mixed answer merges its actions and every refusal keeps; a split answer set merges the same", () => {
  eachRow([
    ["a mixed answer merges keepall/keeplines/forgetall, and every refusal keeps", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      // Index 4 is duplicated in the text (which JSON.parse would hide) and index 9
      // was never assigned; index 5 is answered, 6 is missing. Index 2's span is
      // inside that row's own two lines; an out-of-range span now refuses instead.
      const text = '{"1":{"keepall":true},'
        + '"2":{"keeplines":[[1,1],"dropped the trailing line"]},'
        + '"3":{"forgetall":"an old build log"},'
        + '"4":{"forgetall":"first claim"},"4":{"keepall":true},'
        + '"5":{"keepall":true},"9":{"forgetall":"nowhere"}}';
      const applied = answerOf(plan, [text]);
      // A dedupe removal carries a class instead of an action (ADR-0037); this plan
      // has every switch off, so every removal here is an L1 proof or an L2 answer.
      assert.deepEqual(applied.removals.map(removal =>
        [removal.unitId, removal.origin, removal.origin === "dedupe" ? removal.rule : removal.action]), [
        [unitIdOf(nodes, "r1"), "l1", "forgetall"],
        [unitIdOf(nodes, "b"), "l2", "keeplines"],
        [unitIdOf(nodes, "c"), "l2", "forgetall"],
      ], `row: ${row} — the merged removal list`);
      // keeplinesSummary is surfaced verbatim, with the normalised spans.
      const keeplines = applied.removals[1];
      assert.ok(keeplines?.origin === "l2" && keeplines.action === "keeplines",
        `row: ${row} — index 2 is a keeplines removal`);
      if (!(keeplines?.origin === "l2" && keeplines.action === "keeplines")) return;
      assert.deepEqual(keeplines.ranges, [{ from: 1, to: 1 }], `row: ${row} — the spans are normalised`);
      assert.equal(keeplines.keeplinesSummary, "dropped the trailing line",
        `row: ${row} — the summary travels verbatim`);
      assert.equal(keeplines.answeredInRound, 1, `row: ${row} — the round is recorded`);
      // The forgetall descriptor travels as the wire parser read it.
      const forgetall = applied.removals[2];
      assert.ok(forgetall?.origin === "l2" && forgetall.action === "forgetall",
        `row: ${row} — index 3 is a forgetall removal`);
      if (forgetall?.origin === "l2" && forgetall.action === "forgetall") {
        assert.equal(forgetall.summary, "an old build log", `row: ${row} — the descriptor travels`);
      }
      // Refused units are kept: the duplicated index, the missing index. The
      // answered keepall (index 1) is kept too; the two removals are not.
      assert.deepEqual(applied.kept, idsOf(nodes, ["r2", "d", "e", "f"]),
        `row: ${row} — refused and kept units stay`);
      assert.deepEqual(applied.refused.map(entry => [entry.unitId, entry.index, entry.code]), [
        [unitIdOf(nodes, "d"), 4, "duplicate-index"],
        [unitIdOf(nodes, "f"), 6, "missing-index"],
      ], `row: ${row} — the refusals and their codes`);
      // The unknown index names no unit and is only reported.
      assert.deepEqual(applied.rejected.map(entry => [entry.key, entry.code, entry.answerIndex]),
        [["9", "out-of-range", 0]], `row: ${row} — a stray index names no unit`);
    }],
    ["an empty or unreadable answer keeps every asked unit", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      const none = answerOf(plan, []);
      assert.deepEqual(none.removals.map(removal => removal.origin), ["l1"],
        `row: ${row} — no answer still leaves L1's removal`);
      assert.deepEqual(none.refused.map(entry => entry.code),
        Array.from({ length: 6 }, () => "missing-index"), `row: ${row} — no answer is a missing index`);
      assert.deepEqual(none.kept, idsOf(nodes, ASKED_IDS), `row: ${row} — every asked unit is kept`);
      const garbage = answerOf(plan, ["not json"]);
      assert.deepEqual(garbage.refused.map(entry => entry.code),
        Array.from({ length: 6 }, () => "answer-unreadable"), `row: ${row} — garbage is unreadable`);
      assert.deepEqual(garbage.kept, none.kept, `row: ${row} — garbage keeps the same units`);
    }],
    ["a split answer set merges exactly like one answer, and duplicates keep", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      const whole = '{"1":{"keepall":true},"2":{"forgetall":"two"},"3":{"keeplines":[[1,1],"cut"]},'
        + '"4":{"keepall":true},"5":{"forgetall":"five"},"6":{"keepall":true}}';
      const first = '{"1":{"keepall":true},"2":{"forgetall":"two"},"3":{"keeplines":[[1,1],"cut"]}}';
      const second = '{"4":{"keepall":true},"5":{"forgetall":"five"},"6":{"keepall":true}}';
      assert.deepEqual(answerOf(plan, [first, second]), answerOf(plan, [whole]),
        `row: ${row} — a split merges like one answer`);
      // The split shares ONE index space: the round is the same on every removal.
      const split = answerOf(plan, [first, second]);
      for (const removal of split.removals) {
        if (removal.origin === "l2") {
          assert.equal(removal.answeredInRound, 1, `row: ${row} — one shared index space, one round`);
        }
      }
      // The same index answered by two texts is ambiguous, so the unit is kept; the
      // other indices were covered by neither text and are kept as missing.
      const both = answerOf(plan, ['{"1":{"forgetall":"one"}}', '{"1":{"forgetall":"again"}}']);
      assert.equal(both.removals.some(removal => removal.unitId === unitIdOf(nodes, "r2")), false,
        `row: ${row} — an ambiguous index removes nothing`);
      assert.deepEqual(both.refused[0]?.code, "duplicate-index",
        `row: ${row} — an ambiguous index is a duplicate`);
      assert.equal(both.refused[0]?.unitId, unitIdOf(nodes, "r2"),
        `row: ${row} — the refusal names the shadowed unit`);
    }],
  ]);
});

// --- the superseded-read dedupe (ADR-0037; ISSUE-145) ---------------------------

test("a deduped unit is in no ask row, table or stamp; with every switch off the pass is today's", () => {
  eachRow([
    ["a deduped unit appears in no ask row, no table and no stamp", row => {
      const nodes = rereadFixture();
      const plan = planPrunePass({
        units: unitsOf(nodes), nodes, episodes: [], classes: { supersededByReread: true }, round: 1,
      });
      const deduped = unitIdOf(nodes, "o1");
      assert.deepEqual(plan.l1.removals, [], `row: ${row} — L1 proves nothing in this fixture`);
      assert.deepEqual(plan.dedupe.removals.map(removal => removal.unitId), [deduped],
        `row: ${row} — the dedupe removes the earlier read`);
      // The unit is removed by the proof lane, so nothing asks about it.
      assert.equal(plan.askRows.some(entry => entry.unit.id === deduped), false,
        `row: ${row} — no ask row addresses it`);
      assert.equal(plan.tables.flatMap(table => table.rows).some(entry => entry.unit.id === deduped), false,
        `row: ${row} — no table carries it`);
      assert.equal([...plan.stamps.values()].some(stamp => stamp.unitId === deduped), false,
        `row: ${row} — no stamp names it`);
      // The index space closes over the unit: the remaining rows keep 1..3.
      assert.deepEqual(plan.askRows.map(entry => entry.index), [1, 2, 3],
        `row: ${row} — the index space closes over the unit`);
      assert.deepEqual(plan.askRows.map(entry => entry.unit.id), idsOf(nodes, ["o2", "b", "c"]),
        `row: ${row} — the witness and the rest are asked`);
      // The merged document files it as a dedupe removal, never as a refusal.
      const applied = answerOf(plan, []);
      assert.deepEqual(applied.removals.map(removal => [removal.unitId, removal.origin]),
        [[deduped, "dedupe"]], `row: ${row} — the document files it as a dedupe removal`);
      assert.equal(applied.refused.some(entry => entry.unitId === deduped), false,
        `row: ${row} — it is never a refusal`);
    }],
    ["with every switch off the pass plans exactly today's pass", row => {
      const nodes = rereadFixture();
      const all = unitsOf(nodes);
      const off = planPrunePass({ units: all, nodes, episodes: [], classes: {}, round: 1 });
      // The new field is the only addition, and it is empty: a zero in every class.
      assert.deepEqual(off.dedupe, {
        removals: [],
        counts: { "superseded-by-reread": 0, "call-echo": 0, "launch-receipt": 0, "harness-copy": 0 },
        refusals: [],
      }, `row: ${row} — a zero in every class`);
      // Today's invariants hold unchanged: the ask is exactly L1's kept list, in
      // transcript order, numbered from one, every index stamped with its unit.
      assert.deepEqual(off.askRows.map(entry => entry.unit.id), off.l1.kept,
        `row: ${row} — the ask is L1's kept list`);
      assert.deepEqual(off.askRows.map(entry => entry.index), [1, 2, 3, 4],
        `row: ${row} — numbered from one`);
      for (const entry of off.askRows) {
        assert.deepEqual(off.stamps.get(entry.index), { unitId: entry.unit.id, answeredInRound: 1 },
          `row: ${row} — every index is stamped with its unit`);
      }
      // Naming every switch false is the same statement as omitting them.
      const named = planPrunePass({ units: all, nodes, episodes: [], round: 1,
        classes: { supersededByReread: false, callEcho: false, launchReceipt: false, harnessCopy: false } });
      assert.deepEqual(named, off, `row: ${row} — an explicit false is the same statement`);
      // And a merged document carries judged answers only: no dedupe row exists.
      const applied = answerOf(off, ['{"1":{"forgetall":"one"},"2":{"keepall":true},'
        + '"3":{"keepall":true},"4":{"keepall":true}}']);
      assert.deepEqual(applied.removals.map(removal => removal.origin), ["l2"],
        `row: ${row} — the judged answer is the only removal`);
      // The standard fixture's own L1 proof is still the only thing it removes.
      const l1Only = answerOf(planOf(fixture()), ['{"1":{"keepall":true},"2":{"keepall":true},'
        + '"3":{"keepall":true},"4":{"keepall":true},"5":{"keepall":true},"6":{"keepall":true}}']);
      assert.deepEqual(l1Only.removals.map(removal => removal.origin), ["l1"],
        `row: ${row} — only L1 removes in the standard fixture`);
      assert.deepEqual(l1Only.removals.map(removal => removal.unitId), [unitIdOf(fixture(), "r1")],
        `row: ${row} — the L1 removal is r1`);
    }],
  ]);
});

// --- the estimate, the empty pass, and the caller-bug refusals ---------------

test("the estimate prices L1 in bytes and the ask per rendered table; an empty pass is zero", () => {
  eachRow([
    ["the estimate uses bytes/4 for L1 and the rendered tables for the ask", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      const staleBytes = unitsOf(nodes).find(unit => unit.id === unitIdOf(nodes, "r1"))!.byteLength;
      const tableTokens = Math.ceil(encoder.encode(renderPruneAskTable(plan.askRows)).length / 4);
      const estimate = estimatePassTokens(plan);
      assert.equal(estimate.l1RemovalsBytes, staleBytes, `row: ${row} — L1 is priced in bytes`);
      assert.equal(estimate.askTableTokens, tableTokens, `row: ${row} — the ask is priced by its table`);
      assert.equal(estimate.total, Math.ceil(staleBytes / 4) + tableTokens, `row: ${row} — the total`);
      // The estimate is the sum of each table's own rendered bytes, never one
      // render of a different split. There is no row cap, so the pass plans ONE
      // table and the sum is that table's own render.
      const split = planPrunePass({
        units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1,
        grammar: "3option",
      });
      const splitTokens = split.tables.reduce((sum, table) =>
        sum + Math.ceil(encoder.encode(renderPruneAskTable(table.rows)).length / 4), 0);
      assert.equal(split.tables.length, 1, `row: ${row} — the whole ask is one table`);
      assert.equal(estimatePassTokens(split).askTableTokens, splitTokens,
        `row: ${row} — the estimate is the sum of its tables`);
      assert.equal(splitTokens, tableTokens, `row: ${row} — one table renders once`);
    }],
    ["an empty pass estimates zero", row => {
      const empty = planPrunePass({
        units: [], nodes: [], episodes: [], classes: {}, round: 1,
      });
      assert.deepEqual(estimatePassTokens(empty),
        { l1RemovalsBytes: 0, dedupeRemovalsBytes: 0, askTableTokens: 0, total: 0 },
        `row: ${row} — an empty pass estimates zero`);
      assert.deepEqual(empty.askRows, [], `row: ${row} — an empty pass asks nothing`);
      assert.deepEqual(empty.tables, [], `row: ${row} — an empty pass has no table`);
    }],
    ["an invalid round is a caller bug and a node-less unit is still asked", row => {
      for (const round of [-1, 1.5, Number.NaN]) {
        assert.throws(() => planPrunePass({
          units: [], nodes: [], episodes: [], classes: {}, round,
        }), RangeError, `row: ${row} — round ${String(round)} must be a RangeError`);
      }
      const node = fixture()[2]!;
      const unit = unitsOf([node])[0]!;
      const plan = planPrunePass({
        units: [unit], nodes: [], episodes: [], classes: {}, round: 0,
      });
      // No node means no bytes; the unit is unprovable, so L1 keeps it and the ask
      // still offers it with a refused anchor.
      assert.deepEqual(plan.l1.removals, [], `row: ${row} — a node-less unit is unprovable`);
      assert.deepEqual(plan.askRows.map(entry => entry.index), [1], `row: ${row} — the ask still offers it`);
      assert.equal("refusal" in plan.askRows[0]!.anchor, true, `row: ${row} — the anchor refuses`);
    }],
  ]);
});

// --- the estimate prices the dedupe lane too (ISSUE-338) ---------------------

test("ISSUE-338: a dedupe-only pass estimates its burns, not near-zero", () => {
  const nodes = rereadFixture();
  const plan = planPrunePass({
    units: unitsOf(nodes), nodes, episodes: [], classes: { supersededByReread: true }, round: 1,
  });
  // The fixture is dedupe-only: L1 proves nothing, the burn is the earlier read.
  assert.deepEqual(plan.l1.removals, [], "L1 proves nothing in this fixture");
  assert.equal(plan.dedupe.removals.length, 1, "the dedupe burns the earlier read");
  // `o1` is "export const a = 1;\n" — 20 bytes, priced at bytes/4 like L1.
  const burnedBytes = unitsOf(nodes).find(unit => unit.id === unitIdOf(nodes, "o1"))!.byteLength;
  assert.equal(burnedBytes, 20, "the fixture's burn is 20 bytes");
  const tableTokens = plan.tables.reduce((sum, table) =>
    sum + Math.ceil(encoder.encode(renderPruneAskTable(
      table.rows, undefined, { grammar: plan.grammar })).length / 4), 0);
  const estimate = estimatePassTokens(plan);
  assert.equal(estimate.l1RemovalsBytes, 0, "no L1 removal is priced");
  assert.equal(estimate.dedupeRemovalsBytes, burnedBytes, "the dedupe burn is priced in bytes");
  assert.equal(estimate.total, Math.ceil(burnedBytes / 4) + tableTokens,
    "a dedupe-only pass is not near-zero: its total carries the burn");
  // A cancelled burn is not priced: the pass will not act on it (ISSUE-174).
  const cancelled = estimatePassTokens(plan, new Set([unitIdOf(nodes, "o1")]));
  assert.equal(cancelled.dedupeRemovalsBytes, 0, "a cancelled burn is not priced");
  assert.equal(cancelled.total, tableTokens, "the cancelled pass prices only its ask");
});

// --- the two-verdict grammar (ISSUE-221) ------------------------------------

test("an absent grammar plans nokeepall, the shipped bulk default", () => {
  const nodes = fixture();
  const plan = planPrunePass({ units: unitsOf(nodes), nodes, episodes: [], classes: {}, round: 1 });
  assert.equal(plan.grammar, "nokeepall",
    "the absent grammar is the shipped two-verdict default, never 3option");
  // The default reaches the cost estimate: it prices the nokeepall rows (each
  // with its [L line(s)]), so the plan a caller omits the grammar on is the one
  // the ask would actually send.
  const suffixTokens = plan.tables.reduce((sum, table) =>
    sum + Math.ceil(encoder.encode(renderPruneAskTable(
      table.rows, undefined, { grammar: "nokeepall" })).length / 4), 0);
  assert.equal(estimatePassTokens(plan).askTableTokens, suffixTokens,
    "the estimate renders the default grammar's table");
});

test("nokeepall: a whole-range answer is a clean keep, never counted or priced", () => {
  eachRow([
    ["a whole-range keeplines becomes keepall and is not an L2 removal", row => {
      const nodes = fixture();
      const plan = planOf(nodes, { grammar: "nokeepall" });
      assert.equal(plan.grammar, "nokeepall", `row: ${row} — the plan carries its grammar`);
      const r2 = unitIdOf(nodes, "r2");
      const b = unitIdOf(nodes, "b");
      const application = answerOf(plan, [
        '{"1":{"keeplines":[[1,1],"a different note"]},'
        + '"2":{"keeplines":[[1,1],"None"]},'
        + '"3":{"forgetall":"stale"},"4":{"forgetall":"stale"},'
        + '"5":{"forgetall":"stale"},"6":{"forgetall":"stale"}}',
      ]);
      // Index 1 is r2 (one line): a full range whatever its note says.
      assert.equal(application.removals.some(removal => removal.unitId === r2), false,
        `row: ${row} — the whole-range row is not removed`);
      assert.equal(application.kept.includes(r2), true,
        `row: ${row} — the whole-range row is kept`);
      // Index 2 is b (two lines): [[1,1]] is a real partial keep.
      assert.equal(application.removals.some(removal =>
        removal.unitId === b && removal.origin === "l2" && removal.action === "keeplines"), true,
      `row: ${row} — a partial keeplines still removes`);
      const l2 = application.removals.filter(removal => removal.origin === "l2");
      assert.equal(l2.filter(removal => removal.action === "keeplines").length, 1,
        `row: ${row} — exactly the partial keeplines is counted`);
      assert.equal(l2.filter(removal => removal.action === "forgetall").length, 4,
        `row: ${row} — the four forgetall rows are counted`);
      assert.deepEqual(application.refused, [],
        `row: ${row} — a whole range is a keep, not a refusal`);
    }],
    ["a literal keepall under nokeepall is a terminal refusal that keeps", row => {
      const nodes = fixture();
      const plan = planOf(nodes, { grammar: "nokeepall" });
      const r2 = unitIdOf(nodes, "r2");
      const application = answerOf(plan, [
        '{"1":{"keepall":true},"2":{"forgetall":"stale"},"3":{"forgetall":"stale"},'
        + '"4":{"forgetall":"stale"},"5":{"forgetall":"stale"},"6":{"forgetall":"stale"}}',
      ]);
      assert.equal(application.removals.some(removal => removal.unitId === r2), false,
        `row: ${row} — a refused keepall removes nothing`);
      assert.equal(application.kept.includes(r2), true, `row: ${row} — the unit is kept`);
      assert.deepEqual(application.refused.map(refusal => [refusal.unitId, refusal.code]),
        [[r2, "action-not-in-grammar"]],
        `row: ${row} — the gate refusal is named once, for its own unit`);
      assert.equal(application.refused[0]?.answerIndex, null,
        `row: ${row} — it names no reply to re-ask`);
    }],
    ["the same literal keepall under 3option is the shipped keep", row => {
      const nodes = fixture();
      const plan = planOf(nodes);
      const r2 = unitIdOf(nodes, "r2");
      const application = answerOf(plan, [
        '{"1":{"keepall":true},"2":{"keepall":true},"3":{"keepall":true},'
        + '"4":{"keepall":true},"5":{"keepall":true},"6":{"keepall":true}}',
      ]);
      assert.equal(application.removals.some(removal => removal.unitId === r2), false,
        `row: ${row} — keepall removes nothing`);
      assert.deepEqual(application.refused, [],
        `row: ${row} — 3option admits keepall`);
    }],
    ["the estimate prices the nokeepall table it would send", row => {
      const nodes = fixture();
      const shipped = planOf(nodes);
      const twoVerdict = planOf(nodes, { grammar: "nokeepall" });
      const suffixTokens = twoVerdict.tables.reduce((sum, table) =>
        sum + Math.ceil(encoder.encode(renderPruneAskTable(
          table.rows, undefined, { grammar: "nokeepall" })).length / 4), 0);
      assert.equal(estimatePassTokens(twoVerdict).askTableTokens, suffixTokens,
        `row: ${row} — the estimate renders the selected grammar`);
      assert.ok(estimatePassTokens(twoVerdict).askTableTokens
        > estimatePassTokens(shipped).askTableTokens,
      `row: ${row} — the [L line(s)] suffixes are priced`);
    }],
  ]);
});

// --- the ask's own apply document (ADR-0054) --------------------------------

/** One answer row before its unit is known; the helper stamps the unit and round. */
type AnswerSpec =
  | { readonly action: "forgetall"; readonly summary: string | null }
  | { readonly action: "keepall" }
  | { readonly action: "keeplines"; readonly ranges: readonly KeptLineSpan[] };

/**
 * The ask's readable rows, keyed by the unit the tracker assigns. A row is
 * named by its fixture node, so a test never re-derives a unit id.
 */
function answersOf(
  nodes: readonly ToolResultNode[],
  specs: readonly (readonly [string, AnswerSpec])[],
  round = 1,
): Map<string, WireAnswer> {
  const answers = new Map<string, WireAnswer>();
  for (const [id, spec] of specs) {
    const unitId = unitIdOf(nodes, id);
    if (spec.action === "forgetall") {
      answers.set(unitId, { verdict: {
        unitId, action: "forgetall", summary: spec.summary, answeredInRound: round,
      } });
    } else if (spec.action === "keepall") {
      answers.set(unitId, { verdict: { unitId, action: "keepall", answeredInRound: round } });
    } else {
      answers.set(unitId, {
        verdict: { unitId, action: "keeplines", ranges: spec.ranges, answeredInRound: round },
        keeplinesSummary: "kept the head",
      });
    }
  }
  return answers;
}

/** The ask's document over every unit the tracker builds for these nodes. */
function applicationOf(
  nodes: readonly ToolResultNode[], verdicts: ReadonlyMap<string, WireAnswer>,
) {
  return applicationFromVerdicts({ units: unitsOf(nodes), nodes, verdicts });
}

test("the ask's document applies a readable forgetall and keeps every other unit", () => {
  eachRow([
    ["one forgetall becomes one removal over only its own unit", row => {
      const nodes = fixture();
      const applied = applicationOf(nodes, answersOf(nodes, [
        ["c", { action: "forgetall", summary: "an old build log" }],
      ]));
      assert.equal(applied.removals.length, 1, `row: ${row} — one answer is one removal`);
      const removal = applied.removals[0];
      assert.ok(removal?.origin === "l2" && removal.action === "forgetall",
        `row: ${row} — the removal is the judged forget`);
      if (!(removal?.origin === "l2" && removal.action === "forgetall")) return;
      assert.equal(removal.unitId, unitIdOf(nodes, "c"), `row: ${row} — only the answered unit`);
      assert.equal(removal.summary, "an old build log", `row: ${row} — the descriptor travels`);
      assert.equal(removal.answeredInRound, 1, `row: ${row} — the row's own round is recorded`);
      assert.deepEqual(applied.kept, idsOf(nodes, ["r1", "r2", "b", "d", "e", "f"]),
        `row: ${row} — every other unit is kept, in transcript order`);
      assert.deepEqual(applied.cancellations, [],
        `row: ${row} — a unique unit's forget is never vetoed`);
      assert.deepEqual(applied.refused, [], `row: ${row} — only readable answers were given`);
      assert.deepEqual(applied.rejected, [], `row: ${row} — no stray key was given`);
    }],
    ["a keepall row removes nothing", row => {
      const nodes = fixture();
      const applied = applicationOf(nodes, answersOf(nodes, [["b", { action: "keepall" }]]));
      assert.deepEqual(applied.removals, [], `row: ${row} — keepall plans no removal`);
      assert.deepEqual(applied.kept, unitsOf(nodes).map(unit => unit.id),
        `row: ${row} — every unit stays`);
    }],
  ]);
});

test("a keeplines row is kept, not applied (ADR-0054 decision 2)", () => {
  eachRow([
    ["a partial keeplines leaves its unit whole", row => {
      const nodes = fixture();
      const applied = applicationOf(nodes, answersOf(nodes, [
        ["b", { action: "keeplines", ranges: [{ from: 1, to: 1 }] }],
      ]));
      assert.deepEqual(applied.removals, [],
        `row: ${row} — no keeplines removal is built, whatever the spans`);
      assert.deepEqual(applied.kept, unitsOf(nodes).map(unit => unit.id),
        `row: ${row} — the row's unit keeps and nothing else moved`);
    }],
  ]);
});

test("a row no readable answer names removes nothing", () => {
  eachRow([
    ["an uncertain or unreadable row keeps its unit", row => {
      const nodes = fixture();
      // The refused, duplicated and missing rows never enter the map the ask
      // stores; only an answered row does.
      const applied = applicationOf(nodes, new Map<string, WireAnswer>());
      assert.deepEqual(applied.removals, [], `row: ${row} — no readable row moves a unit`);
      assert.deepEqual(applied.kept, unitsOf(nodes).map(unit => unit.id),
        `row: ${row} — every unit is kept`);
      assert.deepEqual(applied.refused, [],
        `row: ${row} — the ask's own refusals are the adapter's record, not this document's`);
    }],
  ]);
});

test("the survivor gate vetoes a class-erasing forgetall and reports the cancellation", () => {
  eachRow([
    ["two identical copies answered forgetall leave exactly one removal", row => {
      const nodes = fixture();
      const r1 = unitIdOf(nodes, "r1");
      // `fixture` makes r1 and r2 one content class; forgetting both would erase
      // the value, so the gate keeps the newest member.
      const applied = applicationOf(nodes, answersOf(nodes, [
        ["r1", { action: "forgetall", summary: "stale duplicate" }],
        ["r2", { action: "forgetall", summary: "stale duplicate" }],
      ]));
      assert.deepEqual(applied.removals.map(removal => removal.unitId), [r1],
        `row: ${row} — one copy stays live`);
      assert.deepEqual(applied.kept, idsOf(nodes, ["r2", "b", "c", "d", "e", "f"]),
        `row: ${row} — the cancelled unit is kept, never dropped`);
    }],
    ["the cancellation names the class's own identity and reason", row => {
      const nodes = fixture();
      const bytes = encoder.encode(SAME);
      const applied = applicationOf(nodes, answersOf(nodes, [
        ["r1", { action: "forgetall", summary: "stale duplicate" }],
        ["r2", { action: "forgetall", summary: "stale duplicate" }],
      ]));
      assert.deepEqual(applied.cancellations, [{
        unitId: unitIdOf(nodes, "r2"), rule: "verdict", reason: "last-live-copy",
        origin: "l2", contentSha256: sha256Sync(bytes), byteLength: bytes.length,
        conflictsWithUnitId: null,
      }], `row: ${row} — the veto is named, with the evidence it refused on`);
    }],
  ]);
});
