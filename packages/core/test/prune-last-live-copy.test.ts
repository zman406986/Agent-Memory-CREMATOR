import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCandidate } from "../src/guard/candidate.js";
import { checkInput } from "../src/guard/checks-input.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkProofs } from "../src/guard/checks-proofs.js";
import { checkSources, checkTranscript } from "../src/guard/checks-sources.js";
import { checkVerdicts } from "../src/guard/checks-verdicts.js";
import type { CheckContext } from "../src/guard/context.js";
import type { ValidationCode, ValidationInput, ValidationIssue } from "../src/guard/types.js";
import { applyPruneAnswers } from "../src/prune/pass-answers.js";
import { planPrunePass } from "../src/prune/pass.js";
import type { PrunePassPlan } from "../src/prune/pass.js";
import type { PruneRemoval } from "../src/prune/pass-merge.js";
import type { RulePlan } from "../src/rules/types.js";
import type { MessageNode, PathEvidence, ToolResultNode } from "../src/types/transcript.js";
import { UnitTracker } from "../src/units/tracker.js";
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";

/**
 * The last-live-copy defect (ISSUE-174).
 *
 * The prune engine is allowed to be conservative and miss a removal. It is never
 * allowed to remove the last live copy of a content value. Every row here builds
 * the transcript that makes one lane's proof true and the next lane's act remove
 * the survivor, then asserts ONE LIVE COPY SURVIVES — before the fix these rows
 * are red, and each names the lane that took the last copy.
 *
 * Rows are grouped per bug so a red run names the defect, not just the fixture.
 */

const encoder = new TextEncoder();
const SESSION = "session-last-copy";
const BAR = 1;

/**
 * One merged test's cases. Each body receives its row name and puts it on every
 * assertion, so a red run names the branch that broke.
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

function hit(pathKey: string, options: { readonly full?: boolean } = {}): PathEvidence {
  return { pathKey, displayPath: pathKey, title: null, lineCount: 1, byteLength: 4,
    outcome: "hit", ...(options.full === true ? { coverage: "full" as const } : {}) };
}

function readNode(options: {
  readonly id: string; readonly step: number; readonly path: string;
  readonly text: string; readonly full?: boolean;
}): ToolResultNode {
  const bytes = encoder.encode(options.text);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id: options.id, turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    embeddedRecords: [],
    evidence: {
      kind: "read",
      target: { key: options.path, label: options.path },
      paths: [hit(options.path, options.full === true ? { full: true } : {})],
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
    },
  };
}

function writeNode(options: {
  readonly id: string; readonly step: number; readonly path: string;
}): ToolResultNode {
  const bytes = encoder.encode(`wrote ${options.path}\n`);
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result", id: options.id, turnOrdinal: 1, stepOrdinal: options.step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${options.id}`,
    embeddedRecords: [],
    evidence: {
      kind: "write",
      target: { key: options.path, label: options.path },
      paths: [{ pathKey: options.path, displayPath: options.path, title: null,
        lineCount: 1, byteLength: bytes.length, outcome: "unknown" }],
      source: { nodeId: options.id, sha256, byteLength: bytes.length },
      sourceRecallId: null,
    },
  };
}

function unitsOf(nodes: readonly ToolResultNode[]): readonly ProcessingUnit[] {
  const tracker = new UnitTracker({ sessionId: SESSION, barBytes: BAR });
  return nodes.flatMap(node => tracker.unitsFor(node));
}

/** The unit id of one node, resolved through the tracker the pass itself uses. */
function unitIdOf(nodes: readonly ToolResultNode[], nodeId: string): string {
  const node = nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  const unit = unitsOf([node])[0];
  assert.ok(unit, `missing unit for ${nodeId}`);
  return unit.id;
}

/** Every node id whose content value still has a unit the plan does not remove. */
function liveHolders(
  nodes: readonly ToolResultNode[], plan: PrunePassPlan, text: string,
): readonly string[] {
  const gone = new Set<UnitId>(removedUnitIds(plan));
  return nodes
    .filter(node => new TextDecoder().decode(node.bytes) === text)
    .filter(node => !gone.has(unitIdOf(nodes, node.id)))
    .map(node => node.id);
}

type UnitId = string;

/** Every unit the plan removes, from every lane it has. */
function removedUnitIds(plan: PrunePassPlan): readonly UnitId[] {
  return [...plan.l1.removals.map(removal => removal.unitId),
    ...plan.dedupe.removals.map(removal => removal.unitId)];
}

function planOf(
  nodes: readonly ToolResultNode[],
  classes: PrunePassPlan["dedupe"] extends never ? never : { readonly supersededByReread?: boolean } = {},
): PrunePassPlan {
  return planPrunePass({ units: unitsOf(nodes), nodes, episodes: [], classes, round: 1 });
}

/** Every unit the merged document removes, dedupe and L1 and L2 together. */
function mergedRemoved(removals: readonly PruneRemoval[]): readonly UnitId[] {
  return removals.map(removal => removal.unitId);
}

/**
 * BUG 1 — `level1-families.ts:121-135` and `:164-179`.
 *
 * Family 2 names `rA2` as the survivor of `rA1`; family 3 then makes `rB1` the
 * keeper and plans `rA2` as a duplicate. Both removals are individually proven
 * against the pre-family snapshot, and together they leave no copy of `SHARED`.
 */
test("bug 1: a later family never removes the survivor an earlier family named", () => {
  eachRow([
    ["family 2's named survivor is removed by family 3, and the plan says so", row => {
      // The proof chain, not a surviving copy: `rA1`'s own proof names `rA2` as
      // the copy that survives, and the same plan removes `rA2` under another
      // rule. This is the defect in its smallest form — two proofs, each true
      // against the snapshot it was computed on, false about the plan they
      // jointly produce.
      const nodes = [
        readNode({ id: "rA1", step: 1, path: "src/a.ts", text: "SHARED\n" }),
        readNode({ id: "rB1", step: 2, path: "src/b.ts", text: "SHARED\n" }),
        readNode({ id: "rA2", step: 3, path: "src/a.ts", text: "SHARED\n" }),
      ];
      const plan = planOf(nodes);
      const gone = new Set(removedUnitIds(plan));
      for (const removal of plan.l1.removals) {
        const survivor = removal.rule === "stale-exact-reread" ? removal.proof.survivorUnitId
          : removal.rule === "byte-identical-duplicates" ? removal.proof.keptUnitId
            : removal.unitId;
        assert.equal(gone.has(survivor), false,
          `row: ${row} — ${removal.unitId} names ${survivor} as its survivor, and this plan removes it`);
      }
    }],
    ["the same shape across two lanes keeps one live copy of the content", row => {
      // The full chain that erased a value: L1 takes the earlier same-path copy
      // and a duplicate, and the dedupe then takes the survivor because a later
      // read of its path exists. Four proofs, and before the gate zero live
      // copies. The gate is conservative: it may cancel more than strictly
      // needed, so the assertion is "never zero", not "exactly one".
      const nodes = [
        readNode({ id: "rA1", step: 1, path: "src/a.ts", text: "SHARED\n" }),
        readNode({ id: "rB1", step: 2, path: "src/b.ts", text: "SHARED\n" }),
        readNode({ id: "rA2", step: 3, path: "src/a.ts", text: "SHARED\n" }),
        readNode({ id: "rB2", step: 5, path: "src/b.ts", text: "CHANGED\n" }),
      ];
      const plan = planOf(nodes, { supersededByReread: true });
      const live = liveHolders(nodes, plan, "SHARED\n");
      assert.ok(live.length >= 1,
        `row: ${row} — a live copy of SHARED survives, saw ${JSON.stringify(live)}`);
    }],
  ]);
});

/**
 * BUG 2 — `pass.ts:124-129` plus `dedupe/superseded-by-reread.ts:46`.
 *
 * The dedupe receives L1's kept units as subjects but reads its witness from
 * every node. Here L1 removes the witness `rX`; the dedupe still plans `rO`
 * citing it, so the burn's survivor is removed by the same application.
 */
test("bug 2: the dedupe never plans a removal whose witness L1 removes", () => {
  eachRow([
    ["a witness L1 removed is not a witness the dedupe may cite", row => {
      const nodes = [
        readNode({ id: "rN1", step: 1, path: "src/a.ts", text: "NEWER\n", full: true }),
        readNode({ id: "rD", step: 2, path: "src/c.ts", text: "NEWER\n", full: true }),
        readNode({ id: "rO", step: 3, path: "src/a.ts", text: "OLDER\n", full: true }),
        readNode({ id: "rX", step: 5, path: "src/a.ts", text: "NEWER\n", full: true }),
      ];
      const plan = planOf(nodes, { supersededByReread: true });
      const gone = new Set(removedUnitIds(plan));
      // The invariant, stated the way the guard states it: every dedupe burn
      // names a witness that this plan leaves standing.
      for (const removal of plan.dedupe.removals) {
        const witness = removal.proof.witnessUnitId;
        assert.notEqual(witness, null, `row: ${row} — a burn's witness has a unit here`);
        if (witness === null) continue;
        assert.equal(gone.has(witness), false,
          `row: ${row} — ${removal.unitId} cites witness ${witness}, which this plan removes`);
      }
      // And the older read still has its newer copy live: rO is removable only
      // if a whole-file read of src/a.ts survives, which rD is not (it is src/c.ts).
      assert.equal(liveHolders(nodes, plan, "NEWER\n").length >= 1, true,
        `row: ${row} — NEWER survives at least once`);
    }],
    ["no dedupe removal is planned against a snapshot it can no longer see", row => {
      // Two whole-file reads where the later one is itself a byte duplicate of an
      // unrelated node: L1 can remove the witness, so the dedupe must not use it.
      const nodes = [
        readNode({ id: "o1", step: 1, path: "src/a.ts", text: "ALPHA\n", full: true }),
        readNode({ id: "o2", step: 2, path: "src/a.ts", text: "BETA\n", full: true }),
        readNode({ id: "o3", step: 3, path: "src/b.ts", text: "BETA\n", full: true }),
      ];
      const plan = planOf(nodes, { supersededByReread: true });
      const gone = new Set(removedUnitIds(plan));
      for (const removal of plan.dedupe.removals) {
        const witness = removal.proof.witnessUnitId;
        if (witness === null) continue;
        assert.equal(gone.has(witness), false,
          `row: ${row} — ${removal.unitId} cites a removed witness ${witness}`);
      }
    }],
  ]);
});

/**
 * BUG 3 — `level1-families.ts:146-181`.
 *
 * Family 3 keeps the earliest unit, which is always the oldest copy in the
 * transcript. That keeper is an ask row; a `forgetall` verdict on it takes the
 * class's last live copy and every lane reports success.
 */
test("bug 3: a forget verdict never removes a content class's last live copy", () => {
  eachRow([
    ["the duplicate keeper is not removed by a verdict when it is the last copy", row => {
      const nodes = [
        readNode({ id: "r1", step: 1, path: "src/a.ts", text: "SAME\n" }),
        readNode({ id: "r2", step: 2, path: "src/a.ts", text: "SAME\n" }),
      ];
      const plan = planOf(nodes);
      // The keeper is offered as an ask row; answer forgetall on every row.
      assert.equal(plan.askRows.length, 1, `row: ${row} — one ask row holds the class`);
      const answer = JSON.stringify(Object.fromEntries(
        plan.askRows.map(entry => [String(entry.index), { forgetall: "the duplicated result" }]),
      ));
      const applied = applyPruneAnswers(plan, [answer], {
        indices: plan.askRows.map(entry => entry.index), stamps: plan.stamps,
      });
      const gone = new Set(mergedRemoved(applied.removals));
      const live = nodes
        .filter(node => !gone.has(unitIdOf(nodes, node.id)))
        .map(node => node.id);
      assert.ok(live.length >= 1,
        `row: ${row} — a live copy of SAME survives the verdict, saw ${JSON.stringify(live)}`);
      // The refusal is evidence: named, counted, and pointing at the rule. The
      // gate gives way with the byte proof rather than the agent's verdict
      // (ADR-0006), so the reason names the proof whose survivor left — and if
      // no proof covers the class, content survival is the backstop.
      const refused = applied.cancellations ?? [];
      assert.equal(refused.length, 1, `row: ${row} — one cancellation is recorded`);
      assert.equal(
        ["survivor-removed", "last-live-copy"].includes(refused[0]?.reason ?? ""), true,
        `row: ${row} — the reason names the rule: ${refused[0]?.reason ?? "none"}`);
    }],
    ["the keeper is never a class's only live copy once the verdicts land", row => {
      // Three identical copies at three steps. Family 3 keeps one and removes the
      // other two; the keeper is an ask row. A `forgetall` on it must NOT be
      // applied, because the class would then hold nothing — this is bug 3
      // stated as the property the gate enforces, not as a keeper-choice rule.
      const nodes = [
        readNode({ id: "k1", step: 1, path: "src/a.ts", text: "TRIPLE\n" }),
        readNode({ id: "k2", step: 2, path: "src/b.ts", text: "TRIPLE\n" }),
        readNode({ id: "k3", step: 3, path: "src/b.ts", text: "TRIPLE\n" }),
      ];
      const plan = planOf(nodes);
      assert.ok(liveHolders(nodes, plan, "TRIPLE\n").length >= 1,
        `row: ${row} — the plan leaves a copy the verdicts can be refused against`);
      // A forgetall on every ask row must still leave a copy: the class survives.
      const answer = JSON.stringify(Object.fromEntries(
        plan.askRows.map(entry => [String(entry.index), { forgetall: "duplicate" }]),
      ));
      const applied = applyPruneAnswers(plan, [answer], {
        indices: plan.askRows.map(entry => entry.index), stamps: plan.stamps,
      });
      const gone = new Set(mergedRemoved(applied.removals));
      const after = nodes.filter(node => !gone.has(unitIdOf(nodes, node.id)));
      assert.ok(after.length >= 1,
        `row: ${row} — the verdict leaves a copy: ${JSON.stringify(after.map(node => node.id))}`);
      assert.equal(
        applied.cancellations?.some(entry =>
          entry.reason === "last-live-copy" || entry.reason === "survivor-removed") ?? false,
        true, `row: ${row} — the refusal is recorded, never silent`);
    }],
  ]);
});

/**
 * ISSUE-333 — the gate's located-member count and the merge's admission
 * disagree. A located twin and an unlocated twin (its node's bytes changed
 * after segmentation, so the declared source hash no longer matches) both get
 * `forgetall`; rule 1 sees a class of ONE located member and skips it, so the
 * merge erases the class. Only the apply-time source check backstops the
 * unlocated unit — the located copy is already gone.
 */
test("ISSUE-333: a forgetall on a located and an unlocated twin never erases the class", () => {
  eachRow([
    ["the located twin keeps when its unlocated twin also forgets", row => {
      const planned = [
        readNode({ id: "t1", step: 1, path: "src/a.ts", text: "TWIN\n" }),
        readNode({ id: "t2", step: 2, path: "src/b.ts", text: "TWIN\n" }),
      ];
      const units = unitsOf(planned);
      // t2's node bytes changed AFTER segmentation: the unit's declared source
      // hash still names "TWIN\n", but the node no longer matches it, so
      // locateContents skips t2. The gate sees one located member while the
      // merge admits forgetall on both twins.
      const changedBytes = encoder.encode("GONE\n");
      const nodes: readonly ToolResultNode[] = [
        planned[0]!,
        { ...planned[1]!, bytes: changedBytes, sha256: sha256Sync(changedBytes),
          byteLength: changedBytes.length },
      ];
      const plan = planPrunePass({ units, nodes, episodes: [], classes: {}, round: 1 });
      assert.equal(plan.askRows.length, 2, `row: ${row} — both twins are ask rows`);
      const answer = JSON.stringify(Object.fromEntries(
        plan.askRows.map(entry => [String(entry.index), { forgetall: "the twin result" }]),
      ));
      const applied = applyPruneAnswers(plan, [answer], {
        indices: plan.askRows.map(entry => entry.index), stamps: plan.stamps,
      });
      const gone = new Set(mergedRemoved(applied.removals));
      const live = units.filter(unit => !gone.has(unit.id));
      assert.ok(live.length >= 1,
        `row: ${row} — a live copy of TWIN survives the merge, saw ${JSON.stringify(live.map(unit => unit.nodeId))}`);
      // The survivor is the LOCATED twin: its node still holds the provable
      // bytes, where the unlocated twin's node holds other bytes by construction.
      assert.deepEqual(live.map(unit => unit.nodeId), ["t1"],
        `row: ${row} — the provable copy is the one that stays`);
      assert.equal(new TextDecoder().decode(nodes[0]!.bytes), "TWIN\n",
        `row: ${row} — the surviving node still holds the class content`);
      const cancelled = applied.cancellations ?? [];
      assert.equal(cancelled.length, 1, `row: ${row} — one cancellation is recorded`);
      assert.equal(cancelled[0]?.reason, "last-live-copy",
        `row: ${row} — the reason names content survival`);
      assert.equal(cancelled[0]?.unitId, units[0]!.id,
        `row: ${row} — the cancellation names the located twin's verdict`);
    }],
    ["a kept unlocated twin is no provable copy either", row => {
      // The unlocated twin stays, but its node holds other bytes: the class
      // still survives only through the located twin, so the located forgetall
      // is cancelled the same way. Uncertain answers keep content.
      const planned = [
        readNode({ id: "s1", step: 1, path: "src/a.ts", text: "TWIN\n" }),
        readNode({ id: "s2", step: 2, path: "src/b.ts", text: "TWIN\n" }),
      ];
      const units = unitsOf(planned);
      const changedBytes = encoder.encode("GONE\n");
      const nodes: readonly ToolResultNode[] = [
        planned[0]!,
        { ...planned[1]!, bytes: changedBytes, sha256: sha256Sync(changedBytes),
          byteLength: changedBytes.length },
      ];
      const plan = planPrunePass({ units, nodes, episodes: [], classes: {}, round: 1 });
      const byUnit = new Map(plan.askRows.map(entry => [entry.unit.id, entry.index] as const));
      const answer = JSON.stringify({
        [String(byUnit.get(units[0]!.id))]: { forgetall: "the located twin" },
        [String(byUnit.get(units[1]!.id))]: { keepall: true },
      });
      const applied = applyPruneAnswers(plan, [answer], {
        indices: plan.askRows.map(entry => entry.index), stamps: plan.stamps,
      });
      const gone = new Set(mergedRemoved(applied.removals));
      assert.equal(gone.has(units[0]!.id), false,
        `row: ${row} — the located twin's forgetall is cancelled`);
      assert.equal(applied.cancellations?.[0]?.reason, "last-live-copy",
        `row: ${row} — content survival names the cancel`);
    }],
    ["an unlocated twin left alone is no reason to cancel a unique removal", row => {
      // Non-vacuity control: with no unlocated twin, a lone forgetall on a
      // unique value still applies — the fix adds cancellations, never blocks
      // the class-of-one rule the gate already ships.
      const nodes = [readNode({ id: "u1", step: 1, path: "src/a.ts", text: "UNIQUE\n" })];
      const plan = planOf(nodes);
      assert.equal(plan.askRows.length, 1, `row: ${row} — one ask row`);
      const answer = JSON.stringify(Object.fromEntries(
        plan.askRows.map(entry => [String(entry.index), { forgetall: "unique value" }]),
      ));
      const applied = applyPruneAnswers(plan, [answer], {
        indices: plan.askRows.map(entry => entry.index), stamps: plan.stamps,
      });
      assert.deepEqual(mergedRemoved(applied.removals), [unitIdOf(nodes, "u1")],
        `row: ${row} — the unique value's forgetall still applies`);
      assert.deepEqual(applied.cancellations ?? [], [],
        `row: ${row} — nothing is cancelled`);
    }],
  ]);
});

/**
 * BUG 4 — three lanes, three identity keys.
 *
 * `d1` and `d2` are `CONTENT-X` at the SAME path, so family 2 supersedes `d1`
 * (same target, same bytes) and family 3 proves `d2` a duplicate. The dedupe
 * then wants `d2` too, because `w1` is a later whole-file read of `src/a.ts`:
 * three lanes each right on its own terms, and the content class erased. The
 * three keys are byte identity within one target, `pathKey`, and content bytes
 * across targets, so a "duplicate" in one lane is unique in another.
 */
test("bug 4: a keeper in one lane is never a removal subject in another", () => {
  eachRow([
    ["content-identity keeper survives a path-identity removal", row => {
      const nodes = [
        readNode({ id: "d1", step: 1, path: "src/a.ts", text: "CONTENT-X\n", full: true }),
        readNode({ id: "d2", step: 2, path: "src/a.ts", text: "CONTENT-X\n", full: true }),
        readNode({ id: "w1", step: 4, path: "src/a.ts", text: "CONTENT-Y\n", full: true }),
      ];
      const plan = planOf(nodes, { supersededByReread: true });
      const live = liveHolders(nodes, plan, "CONTENT-X\n");
      assert.equal(live.length, 1,
        `row: ${row} — one copy of CONTENT-X survives across all three lanes: ${JSON.stringify(live)}`);
    }],
    ["every cancellation is named, never silent", row => {
      const nodes = [
        readNode({ id: "d1", step: 1, path: "src/a.ts", text: "CONTENT-X\n", full: true }),
        readNode({ id: "d2", step: 2, path: "src/a.ts", text: "CONTENT-X\n", full: true }),
        readNode({ id: "w1", step: 4, path: "src/a.ts", text: "CONTENT-Y\n", full: true }),
      ];
      const plan = planOf(nodes, { supersededByReread: true });
      assert.equal(plan.cancellations.length, 1,
        `row: ${row} — one removal was cancelled and recorded, saw ${
          JSON.stringify(plan.cancellations.map(entry => entry.reason))}`);
      const [cancelled] = plan.cancellations;
      assert.ok(cancelled !== undefined, `row: ${row} — the cancellation exists`);
      if (cancelled === undefined) return;
      assert.equal(
        ["survivor-removed", "last-live-copy"].includes(cancelled.reason), true,
        `row: ${row} — the reason names the rule: ${cancelled.reason}`);
      // The content is kept by a lane that planned it; which lane loses the race
      // is an implementation detail, but the cancellation must name it.
      assert.ok(cancelled.origin === "l1" || cancelled.origin === "dedupe",
        `row: ${row} — the lane that planned it is named: ${cancelled.origin}`);
      assert.equal(["d1", "d2"].includes(
        nodes.find(node => unitIdOf(nodes, node.id) === cancelled.unitId)?.id ?? ""), true,
        `row: ${row} — the cancelled removal is one of the CONTENT-X copies`);
    }],
  ]);
});

/**
 * BUG 6 — `guard/checks-proofs.ts:190-202`.
 *
 * `fullReadLater` re-derives the witness from the snapshot and never asks
 * whether a second plan in the same batch removes that witness. The guard
 * therefore approves a batch that deletes the only newer copy.
 */
test("bug 6: the guard refuses a proof whose witness another plan in the batch removes", () => {
  eachRow([
    ["a batch that removes the witness leaves nothing, so the guard refuses", row => {
      // Both plans are valid judged alone: `pO` has a later whole-file read, and
      // `pW` has a later write, so `stale-read` holds. Only the BATCH is unsafe:
      // plan B deletes the very read plan A cites as its newer copy.
      const older = readNode({ id: "pO", step: 1, path: "src/a.ts", text: "OLD\n", full: true });
      const witness = readNode({ id: "pW", step: 2, path: "src/a.ts", text: "NEW\n", full: true });
      const written = writeNode({ id: "pWw", step: 3, path: "src/a.ts" });
      const nodes: TranscriptNode[] = [assistant(["pO", "pW", "pWw"]), older, witness, written];
      const value = validationFor(nodes);
      const units = unitsOf([older, witness]);
      const olderUnit = units.find(unit => unit.nodeId === "pO");
      const witnessUnit = units.find(unit => unit.nodeId === "pW");
      assert.ok(olderUnit !== undefined && witnessUnit !== undefined, `row: ${row} — both units exist`);
      if (olderUnit === undefined || witnessUnit === undefined) return;
      // Each plan alone passes: the row is only about the union.
      assert.deepEqual(codes(runChecks({ ...value, plans: [proofPlan(olderUnit, "superseded-by-reread")] })),
        [], `row: ${row} — plan A alone is proven`);
      assert.deepEqual(codes(runChecks({ ...value, plans: [proofPlan(witnessUnit, "stale-read")] })),
        [], `row: ${row} — plan B alone is proven`);
      const plans: readonly RulePlan[] = [
        proofPlan(olderUnit, "superseded-by-reread"),
        proofPlan(witnessUnit, "stale-read"),
      ];
      const issues = runChecks({ ...value, plans });
      assert.ok(issues.some(issue => issue.code === "proof-unproven"),
        `row: ${row} — the batch is refused as proof-unproven, saw ${JSON.stringify(issues.map(i => i.code))}`);
      assert.equal(issues.some(issue => issue.nodeId === "pO"), true,
        `row: ${row} — the refusal names the read whose witness is gone`);
    }],
  ]);
});

// --- the guard lane's own plumbing (the shapes `guard-proofs.test.ts` uses) ---

type TranscriptNode = ToolResultNode | MessageNode;

function assistant(resultIds: readonly string[]): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: resultIds.map(id => `call-${id}`),
  };
}

function validationFor(
  nodes: readonly TranscriptNode[], plans: readonly RulePlan[] = [],
): ValidationInput {
  return {
    input: { kind: "at-rest", eventId: "at-rest-event", reason: "step" },
    snapshot: {
      sessionId: SESSION, revision: "revision-1", currentTurnOrdinal: 2,
      completedThroughTurnOrdinal: 1, currentStepOrdinal: nodes.length, nodes,
      cache: { kind: "warm" as const, watermarkNodeIndex: 0 }, retentionEvidence: [],
    },
    capabilities: {
      mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
      log: true, appendRecords: true, rehydrateOnResume: false, revertHistory: true,
    },
    config: {
      thresholds: { capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
        sealMaxLatencyTurns: 1 },
      freshZone: { maxNodes: null, maxBytes: null }, sealMode: "append",
      validationFailureLimit: 2,
      protocol: { barBytes: BAR, minCutFreedBytes: 4096 },
    },
    plans: [...plans],
    sealedEpisodeIds: [], nowMs: 10,
  };
}

/** The distinct issue codes, in first-report order. */
function codes(issues: readonly ValidationIssue[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

/** The proof plan shape `guard-proofs.test.ts` builds by hand. */
function proofPlan(unit: ProcessingUnit, proofKind: "stale-read" | "superseded-by-reread" | "superseded-read"): RulePlan {
  return {
    ruleId: proofKind,
    baseRevision: "revision-1",
    removals: [{ id: unit.id, title: `proof ${unit.nodeId}`, sources: [{
      source: { ...unit.source }, ranges: [{ ...unit.span.byteRange }],
    }] }],
    notes: [{ id: `receipt:${unit.id}`, kind: "proof-receipt", proofKind,
      removalId: unit.id, unitId: unit.id, path: unit.path ?? unit.nodeId, ranges: [] }],
    operations: [{ kind: "proof", proofKind, removalId: unit.id, unitId: unit.id,
      noteId: `receipt:${unit.id}` }],
  };
}

function runChecks(value: ValidationInput): readonly ValidationIssue[] {
  const c: CheckContext = {
    value,
    nodes: new Map(value.snapshot.nodes.map(node => [node.id, node])),
    episodes: [],
    freshStart: 0,
    issues: [],
  };
  const report = (code: ValidationCode, detail: string): void => {
    c.issues.push({ code, detail, nodeId: null, ruleId: null, operationIndex: null });
  };
  checkInput(value, report);
  checkTranscript(c);
  checkVerdicts(c, value.plans);
  checkSources(c, value.plans);
  checkOperations(c, value.plans);
  checkProofs(c, value.plans);
  return [...c.issues];
}

// Keep the imports used: `buildCandidate` is the materialization lock the guard
// test asserts on, and the type import keeps the `CheckContext` shape honest.
void buildCandidate;
