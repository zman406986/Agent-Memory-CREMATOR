import assert from "node:assert/strict";
import { test } from "node:test";
import { PRUNE_ANSWER_REFUSAL_CODES } from "../src/prune/ask-answer.js";
import { LEVEL1_RULES } from "../src/prune/level1.js";
import { applyPruneAnswers } from "../src/prune/pass-answers.js";
import { planPrunePass } from "../src/prune/pass.js";
import type { PrunePassPlan } from "../src/prune/pass.js";
import type { PrunePassApplication } from "../src/prune/pass-merge.js";
import { PRUNE_REMOVAL_ACTIONS, pruneRecordOf } from "../src/prune/record.js";
import type { PruneRecordedFields } from "../src/prune/record.js";
import type { PathEvidence, ToolEvidence, ToolResultNode } from "../src/types/transcript.js";
import type { TelemetryEvent } from "../src/types/telemetry.js";
import { sha256Sync } from "../src/util/hash.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";

const encoder = new TextEncoder();
const SESSION = "session-record";

function evidenceOf(target: string | null = null, paths: readonly PathEvidence[] = []): ToolEvidence {
  return {
    kind: "read",
    target: target === null ? null : { key: target, label: target },
    paths,
    source: { nodeId: "", sha256: "", byteLength: 0 },
    sourceRecallId: null,
  };
}

function hit(pathKey: string): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 1, byteLength: 4, outcome: "hit" };
}

function nodeOf(id: string, text: string, target: string): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id, turnOrdinal: 1, stepOrdinal: 1, bytes, sha256,
    byteLength: bytes.length, callId: `call-${id}`, embeddedRecords: [],
    evidence: { ...evidenceOf(target, [hit(target)]), source: { nodeId: id, sha256, byteLength: bytes.length } },
  };
}

const SAME = "export const a = 1;\n";

/** `r1` is the stale copy of `r2` (same target, same bytes); `b`..`d` are distinct. */
function nodes(): readonly ToolResultNode[] {
  return [
    nodeOf("r1", SAME, "src/a.ts"),
    nodeOf("r2", SAME, "src/a.ts"),
    nodeOf("b", "beta one\nbeta two\n", "src/b.ts"),
    nodeOf("c", "gamma line\n", "src/c.ts"),
    nodeOf("d", "delta line\n", "src/d.ts"),
  ];
}

function unitsOf(all: readonly ToolResultNode[]): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: 1 });
  return all.flatMap(node => tracker.unitsFor(node));
}

function planOf(all: readonly ToolResultNode[], dedupe = false): PrunePassPlan {
  return planPrunePass({ units: unitsOf(all), nodes: all, episodes: [], round: 3,
    // The count rows below pin the shipped three-way contract; the no-grammar
    // default is nokeepall and is covered by the dedicated tests in this file.
    grammar: "3option",
    classes: dedupe ? { supersededByReread: true } : {} });
}

function answerOf(plan: PrunePassPlan, texts: readonly string[]): PrunePassApplication {
  return applyPruneAnswers(plan, texts, {
    indices: plan.askRows.map(row => row.index),
    stamps: plan.stamps,
  });
}

/**
 * Two whole-file reads of `src/a.ts` whose bytes differ, plus one unrelated
 * result. L1 proves nothing (the bytes differ), so the superseded-read dedupe is
 * the only layer with a removal to count.
 */
function rereadNodes(): readonly ToolResultNode[] {
  return [
    nodeOf("o1", "export const a = 1;\n", "src/a.ts"),
    nodeOf("o2", "export const a = 2;\nexport const b = 3;\n", "src/a.ts"),
    nodeOf("b", "beta one\nbeta two\n", "src/b.ts"),
  ].map(node => ({ ...node, evidence: { ...node.evidence,
    paths: node.evidence.paths.map(path => ({ ...path, coverage: "full" as const })) } }));
}

/** Row-bound assertions: every failure names the case row that produced it. */
interface At {
  eq(actual: unknown, expected: unknown, detail: string): void;
  deep(actual: unknown, expected: unknown, detail: string): void;
}

function at(row: string): At {
  return {
    eq: (actual, expected, detail) => { assert.equal(actual, expected, `row: ${row} — ${detail}`); },
    deep: (actual, expected, detail) => { assert.deepEqual(actual, expected, `row: ${row} — ${detail}`); },
  };
}

interface RecordCase {
  readonly row: string;
  readonly plan: PrunePassPlan;
  readonly application: PrunePassApplication | null;
  readonly check: (a: At, record: PruneRecordedFields) => void;
}

const ZERO_L1 = { "stale-exact-reread": 0, "closed-episode": 0, "byte-identical-duplicates": 0 } as const;

/**
 * One pass per row, its counters pinned literally. Each row answers a different
 * question about what a record may count — an ask, no ask, a proof, a dedupe —
 * so a counter that stops reading its own layer fails on its own row name.
 */
function recordCases(): readonly RecordCase[] {
  const askedPlan = planOf(nodes());
  // Indices 1..4 are the ask rows (r2, b, c, d); r1 is an L1 removal. d is
  // answered by nobody, so it is a `missing-index` refusal — every unit is a
  // row now (ADR-0020), and no exclusion layer can hide one.
  const messy = ['{"1":{"forgetall":"a stale copy"},'
    + '"2":{"keeplines":[[1,1],"dropped the second line"]},'
    + '"3":{"forgetall":"x"},"3":{"keepall":true},"9":{"forgetall":"nowhere"}}'];
  const dedupePlan = planOf(rereadNodes(), true);
  return [
    {
      row: "an asked pass counts L1 by rule, L2 by action, refusals by code and rejections",
      plan: askedPlan,
      application: answerOf(askedPlan, messy),
      check: (a, record) => {
        a.deep(record, {
          round: 3,
          // ISSUE-174: index 1 forgets `r2`, the only live copy of `r1`'s bytes,
          // so L1's stale-exact-reread proof for `r1` is cancelled rather than
          // applied. The agent's verdict wins (ADR-0006) and `r1` stays, which
          // is the conservative side: no content class is emptied. The pass
          // still removes the two units the answers give up.
          l1RemovalCount: {
            "stale-exact-reread": 0, "closed-episode": 0, "byte-identical-duplicates": 0,
          },
          // ADR-0037: one count per dedupe class, every class present.
          dedupeCount: {
            "superseded-by-reread": 0, "call-echo": 0, "launch-receipt": 0, "harness-copy": 0,
          },
          l2RemovalCount: { keeplines: 1, forgetall: 1, forgetlines: 0 },
          refusedCount: {
            "missing-index": 1, "duplicate-index": 1, "malformed-row": 0,
            "answer-not-an-object": 0, "answer-unreadable": 0,
            "action-not-in-grammar": 0, "spans-outside-result": 0,
          },
          rejectedCount: 1,
          // Pinned literals: the estimate for this fixture, not a re-run of it.
          // `l1RemovalsBytes` is 0 because the one L1 removal was cancelled.
          estTokens: { l1RemovalsBytes: 0, dedupeRemovalsBytes: 0, askTableTokens: 115, total: 115 },
          tableAttempts: [],
          passAttempts: { tables: 0, carried: 0, reasked: 0, finalRefusals: 0, deferred: 0 },
        }, "the whole record");
        // The record names no unit, no receipt and no recall id (ADR-0008). The
        // check names the ARTIFACTS, not their vocabulary: ADR-0037 added a dedupe
        // class called `launch-receipt`, and a class name is a count's key.
        const text = JSON.stringify(record);
        for (const unitId of askedPlan.units.map(unit => unit.id)) {
          a.eq(text.includes(unitId), false, `the record names no unit (${unitId})`);
        }
        a.eq(/recall:sha256:|intent:sha256:/.test(text), false, "no recall or intent hash appears");
        a.eq(/"recallId"|"recall"|"receipt"|"intentId"|"intent"/.test(text), false,
          "no receipt or intent vocabulary appears");
      },
    },
    {
      row: "an unasked pass counts only what the plan proved, and refuses nothing",
      plan: askedPlan,
      application: null,
      check: (a, record) => {
        // The unasked plan still proves `r1` stale against `r2`; with no verdicts
        // to merge nothing contradicts it, so the proof stands and is counted
        // (ISSUE-174: the gate cancels only a contradiction, never a plan).
        a.eq(askedPlan.l1.removals.length, 1, "an L1 proof exists and is counted (ADR-0020)");
        a.deep(record.l1RemovalCount,
          { "stale-exact-reread": 1, "closed-episode": 0, "byte-identical-duplicates": 0 },
          "the L1 count");
        a.deep(record.l2RemovalCount, { keeplines: 0, forgetall: 0, forgetlines: 0 },
          "nothing was asked, so no action was counted");
        a.deep(record.refusedCount,
          Object.fromEntries(PRUNE_ANSWER_REFUSAL_CODES.map(code => [code, 0])),
          "nothing was asked, so nothing was refused");
        a.eq(record.rejectedCount, 0, "nothing was asked, so nothing was rejected");
      },
    },
    {
      row: "an unasked dedupe pass counts its class and leaves the L1 keys alone",
      plan: dedupePlan,
      application: null,
      check: (a, unasked) => {
        a.eq(dedupePlan.dedupe.removals.length, 1, "the earlier read of src/a.ts");
        a.deep(unasked.dedupeCount, {
          "superseded-by-reread": 1, "call-echo": 0, "launch-receipt": 0, "harness-copy": 0,
        }, "the dedupe count carries its class");
        // The L1 counter's key set is untouched by the new one (ADR-0037).
        a.deep(Object.keys(unasked.l1RemovalCount), [...LEVEL1_RULES], "the L1 key set");
        a.deep(unasked.l1RemovalCount, ZERO_L1, "the L1 count is a measured zero");
        // ISSUE-338: the estimate carries the burn the count names. `o1` is
        // "export const a = 1;\n" — 20 bytes, 5 tokens at bytes/4 — so a
        // dedupe-only pass is never near-zero while its count is non-zero.
        a.eq(unasked.estTokens.l1RemovalsBytes, 0, "no L1 removal is priced");
        a.eq(unasked.estTokens.dedupeRemovalsBytes, 20, "the dedupe burn is priced in bytes");
        a.eq(unasked.estTokens.total, unasked.estTokens.askTableTokens + 5,
          "the recorded total carries the dedupe burn");
      },
    },
    {
      row: "an asked dedupe pass counts the merged removal once and never as judged",
      plan: dedupePlan,
      application: answerOf(dedupePlan, ['{"1":{"keepall":true},"2":{"keepall":true}}']),
      check: a => {
        const applied = answerOf(dedupePlan, ['{"1":{"keepall":true},"2":{"keepall":true}}']);
        a.deep(applied.removals.map(removal => removal.origin), ["dedupe"],
          "the document's one removal is the dedupe's");
        const asked = pruneRecordOf(dedupePlan, applied);
        const unasked = pruneRecordOf(dedupePlan, null);
        a.deep(asked.dedupeCount, unasked.dedupeCount, "the dedupe count is unchanged by the ask");
        a.deep(asked.l1RemovalCount, unasked.l1RemovalCount, "the L1 count is unchanged by the ask");
        a.deep(asked.l2RemovalCount, { keeplines: 0, forgetall: 0, forgetlines: 0 },
          "a dedupe removal never lands in the judged counts");
        a.eq(asked.refusedCount["missing-index"], 0, "both ask rows were answered");
      },
    },
  ];
}

test("the record counts what each layer proved — one row per pass", () => {
  for (const expected of recordCases()) {
    expected.check(at(expected.row), pruneRecordOf(expected.plan, expected.application));
  }
});

test("the record is a pure function of the plan and answers — deterministic, ordered, non-mutating", () => {
  const all = nodes();
  const plan = planOf(all);
  const text = '{"1":{"keepall":true},"2":{"forgetall":"b"},"3":{"keepall":true},'
    + '"4":{"keepall":true}}';
  const event: TelemetryEvent = {
    kind: "prune-recorded", sessionId: SESSION, atMs: 1234,
    ...pruneRecordOf(plan, answerOf(plan, [text])),
  };
  const once = JSON.stringify(event);
  const again = JSON.stringify({
    kind: "prune-recorded", sessionId: SESSION, atMs: 1234,
    ...pruneRecordOf(planOf(nodes()), answerOf(planOf(nodes()), [text])),
  });
  assert.equal(again, once, "row: determinism — two identical passes serialize byte for byte");

  // The nested counter objects keep their declared key order, so a journal diff
  // between two runs shows a value change and never a reordering.
  const parsed = JSON.parse(once) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed.l1RemovalCount as object), [...LEVEL1_RULES],
    "row: key order — the L1 counts follow LEVEL1_RULES");
  assert.deepEqual(Object.keys(parsed.l2RemovalCount as object), [...PRUNE_REMOVAL_ACTIONS],
    "row: key order — the L2 counts follow PRUNE_REMOVAL_ACTIONS");
  assert.deepEqual(Object.keys(parsed.refusedCount as object), [...PRUNE_ANSWER_REFUSAL_CODES],
    "row: key order — the refusals follow PRUNE_ANSWER_REFUSAL_CODES");
  assert.deepEqual(Object.keys(parsed.estTokens as object),
    ["l1RemovalsBytes", "dedupeRemovalsBytes", "askTableTokens", "total"],
    "row: key order — the estimate's fields");

  // A changed answer changes only the values it acts on: a keeplines replaces
  // the forgetall and an unassigned key adds a rejection.
  const other = JSON.stringify({
    kind: "prune-recorded", sessionId: SESSION, atMs: 1234,
    ...pruneRecordOf(plan, answerOf(plan, ['{"1":{"keeplines":[[1,1],"cut"]},"2":{"keepall":true},'
      + '"3":{"keepall":true},"4":{"keepall":true},"7":{"forgetall":"nowhere"}}'])),
  });
  assert.notEqual(other, once, "row: a changed answer changes the record");
  assert.deepEqual(Object.keys(JSON.parse(other) as object), Object.keys(parsed),
    "row: a changed answer adds no key");
  assert.deepEqual(JSON.parse(other).l2RemovalCount, { keeplines: 0, forgetall: 0, forgetlines: 0 },
    "row: the changed answer's L2 counts — the whole-range keeplines is a keep");
  assert.equal(JSON.parse(other).rejectedCount, 1, "row: the changed answer's rejection count");

  // Nothing here mutates the plan: the record is read-only input to the event.
  const before = structuredClone({ ...plan, stamps: [...plan.stamps] });
  pruneRecordOf(plan, answerOf(plan, ['{"1":{"keepall":true},"2":{"keepall":true},'
    + '"3":{"keepall":true},"4":{"keepall":true}}']));
  assert.deepEqual({ ...plan, stamps: [...plan.stamps] }, before,
    "row: immutability — the plan is unchanged after two records are built from it");
});

// --- the two-verdict grammar's counts (ISSUE-221) ---------------------------

test("nokeepall: a whole-range keep is not counted as a keeplines or priced", () => {
  const all = nodes();
  const plan = planPrunePass({
    units: unitsOf(all), nodes: all, episodes: [], round: 3, classes: {},
    grammar: "nokeepall",
  });
  // Index 1 is r2 (one line), 2 is b (two lines), 3 is c, 4 is d.
  const answered = answerOf(plan, [
    '{"1":{"keeplines":[[1,1],"a different note"]},'
    + '"2":{"keeplines":[[1,1],"None"]},'
    + '"3":{"forgetall":"stale"},"4":{"forgetall":"stale"}}',
  ]);
  const record = pruneRecordOf(plan, answered);
  assert.equal(record.l2RemovalCount.keeplines, 1,
    "only the partial keeplines on the two-line row is counted");
  assert.deepEqual(record.refusedCount, Object.fromEntries(
    PRUNE_ANSWER_REFUSAL_CODES.map(code => [code, 0])),
  "a whole-range keep is not a refusal");
  // The same plan, with every row kept whole, has no L2 removal at all.
  const allWhole = pruneRecordOf(plan, answerOf(plan, [
    '{"1":{"keeplines":[[1,1],"None"]},'
    + '"2":{"keeplines":[[1,2],"None"]},'
    + '"3":{"keeplines":[[1,1],"None"]},'
    + '"4":{"keeplines":[[1,1],"None"]}}',
  ]));
  assert.deepEqual(allWhole.l2RemovalCount, { keeplines: 0, forgetall: 0, forgetlines: 0 },
    "a whole-range row is a keep, never a keeplines removal");
  // The estimate does not depend on which rows were kept: nothing that is kept
  // is priced, so both records price the same ask and the same L1 proof.
  assert.deepEqual(allWhole.estTokens, record.estTokens,
    "a clean keep changes no estimate");
});

test("nokeepall: a literal keepall is counted as action-not-in-grammar, once", () => {
  const all = nodes();
  const plan = planPrunePass({
    units: unitsOf(all), nodes: all, episodes: [], round: 3, classes: {},
    grammar: "nokeepall",
  });
  const record = pruneRecordOf(plan, answerOf(plan, [
    '{"1":{"keepall":true},"2":{"forgetall":"stale"},"3":{"forgetall":"stale"},'
    + '"4":{"forgetall":"stale"}}',
  ]));
  assert.equal(record.refusedCount["action-not-in-grammar"], 1,
    "the terminal gate refusal is counted under its own code");
  assert.equal(record.l2RemovalCount.keeplines, 0,
    "a refused keepall removes nothing");
  assert.equal(record.l2RemovalCount.forgetall, 3,
    "the three real forgetall rows are still counted");
});

test("a full-range keeplines is a keep on the shipped grammar too", () => {
  const all = nodes();
  const plan = planOf(all);
  const record = pruneRecordOf(plan, answerOf(plan, [
    '{"1":{"keeplines":[[1,1],"None"]},"2":{"keeplines":[[1,1],"cut one line"]},'
    + '"3":{"keepall":true},"4":{"keepall":true}}',
  ]));
  // Index 1 is r2 (one line): whole range. Index 2 is b (two lines): partial.
  assert.equal(record.l2RemovalCount.keeplines, 1,
    "only the partial keeplines is counted");
  assert.deepEqual(record.refusedCount, Object.fromEntries(
    PRUNE_ANSWER_REFUSAL_CODES.map(code => [code, 0])),
  "a whole range is a keep, not a refusal");
});
