import assert from "node:assert/strict";
import { test } from "node:test";
import type { RacoonsConfig } from "../src/config.js";
import { checkInput } from "../src/guard/checks-input.js";
import { checkOperations } from "../src/guard/checks-operations.js";
import { checkSources, checkTranscript } from "../src/guard/checks-sources.js";
import { checkVerdicts, readVerdict } from "../src/guard/checks-verdicts.js";
import { Guard } from "../src/guard/guard.js";
import type { ValidationCode, ValidationInput, ValidationIssue } from "../src/guard/types.js";
import { salvageShare } from "../src/engine/telemetry.js";
import type { RulePlan } from "../src/rules/types.js";
import type { CapabilityFlags, MessageNode, SessionSnapshot, ToolResultNode } from "../src/types/transcript.js";
import { UnitTracker, unitIdFor } from '../src/units/tracker.js';
import type { ProcessingUnit } from "../src/units/types.js";
import { sha256Sync } from "../src/util/hash.js";
import { planVerdictApplication } from "../src/verdicts/plan.js";
import { VerdictTracker } from "../src/verdicts/tracker.js";
import type { Verdict, VerdictBatch, KeptLineSpan } from "../src/verdicts/types.js";
import { context, ledger, pruneEvent } from "./guard-fixtures.js";

const encoder = new TextEncoder();
const sessionId = "session";
const barBytes = 8;

const config: RacoonsConfig = {
  thresholds: {
    capBytes: 8, capHeadBytes: null, episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
  },
  freshZone: { maxNodes: null, maxBytes: null },
  sealMode: "append",
  validationFailureLimit: 2,
  protocol: {
    barBytes, minCutFreedBytes: 4096,
  },
};

function toolResult(index: number, text: string, step: number): ToolResultNode {
  const bytes = encoder.encode(text);
  const sha256 = sha256Sync(bytes);
  return {
    id: `result-${index}`, kind: "tool-result", turnOrdinal: 1, stepOrdinal: step,
    bytes, sha256, byteLength: bytes.length, callId: `call-${index}`,
    evidence: {
      kind: "read", target: null,
      source: { nodeId: `result-${index}`, sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: `src/file-${index}.ts`, displayPath: `src/file-${index}.ts`,
        title: null, lineCount: 1, byteLength: bytes.length, outcome: "hit" }],
    },
    embeddedRecords: [],
  };
}

function assistant(count: number): MessageNode {
  const bytes = encoder.encode("assistant bytes");
  return {
    id: "assistant", kind: "message", role: "assistant", bytes,
    sha256: sha256Sync(bytes), byteLength: bytes.length, turnOrdinal: 1, stepOrdinal: 0,
    toolCallIds: Array.from({ length: count }, (_, index) => `call-${index}`),
  };
}

/**
 * Three above-bar results and one deliberately tiny node, in transcript order.
 * The bar is 8 bytes, so the tiny node is present but yields no unit: a verdict
 * for it must be refused even though its id is computable.
 */
function transcript(): { readonly snapshot: SessionSnapshot; readonly small: ToolResultNode } {
  const results = Array.from({ length: 3 }, (_, index) => toolResult(index, `result ${index} body\n`, index + 1));
  const small = toolResult(9, "tiny\n", 4);
  const snapshot: SessionSnapshot = {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 4, nodes: [assistant(10), ...results, small],
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
  return { snapshot, small };
}

function capabilities(revertHistory?: boolean): CapabilityFlags {
  return {
    mutateResult: true, rewriteHistory: false, atRest: true, liveTokens: false,
    log: true, appendRecords: true, rehydrateOnResume: false,
    ...(revertHistory === undefined ? {} : { revertHistory }),
  };
}

interface Scene {
  readonly snapshot: SessionSnapshot;
  readonly units: readonly ProcessingUnit[];
  readonly plans: readonly RulePlan[];
  readonly batch: VerdictBatch;
}

/**
 * A settled window over every above-bar unit: all kept except index
 * `forgotten`. The plan comes from the real planner, so the guard is tested
 * against the output the engine would hand it, not a hand-built shape.
 */
function scene(fields: { readonly forgotten?: number; readonly label?: string | null } = {}): Scene {
  const { snapshot } = transcript();
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  assert.equal(units.length, 3, "fixture must produce exactly three units");
  const tracker = new VerdictTracker({ units, round: 1 });
  for (const [index, unit] of units.entries()) {
    const forget = index === fields.forgotten;
    tracker.judge(forget
      ? { unitId: unit.id, action: "forgetall",
        summary: fields.label === undefined ? "auth retry" : fields.label,
        answeredInRound: 1 }
      : { unitId: unit.id, action: "keepall", answeredInRound: 1 });
  }
  const state = tracker.state();
  const plan = planVerdictApplication({ state, baseRevision: snapshot.revision, nodes: snapshot.nodes });
  return { snapshot, units, plans: plan === null ? [] : [plan], batch: {
    round: 1, verdicts: state.verdicts,
  } };
}

/**
 * Four-line results above the bar, so a unit can lose its middle lines. The
 * second node is the one a `keeplines` answer trims; the others are kept whole.
 */
function lineTranscript(): SessionSnapshot {
  const body = (index: number): string => `head ${index}\nbanner ${index}\nvalue ${index}\nfooter ${index}\n`;
  const results = Array.from({ length: 3 }, (_, index) => toolResult(index, body(index), index + 1));
  return {
    sessionId, revision: "revision-1", currentTurnOrdinal: 2, completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 4, nodes: [assistant(10), ...results, toolResult(9, "tiny\n", 4)],
    cache: { kind: "warm", watermarkNodeIndex: 0 }, retentionEvidence: [],
  };
}

/**
 * A settled window where unit `trimmed` answers one partial class with `ranges`
 * and every other unit is `keepall`. The plan is the real planner's, so the
 * guard meets exactly what the engine would hand it.
 */
function trimmedScene(
  ranges: readonly KeptLineSpan[], trimmed = 1,
  action: "keeplines" | "forgetlines" = "keeplines",
): Scene {
  const snapshot = lineTranscript();
  const units = new UnitTracker({ sessionId, barBytes }).units(snapshot);
  assert.equal(units.length, 3, "fixture must produce exactly three units");
  const tracker = new VerdictTracker({ units, round: 1 });
  for (const [index, unit] of units.entries()) {
    tracker.judge(index === trimmed
      ? { unitId: unit.id, action, ranges, answeredInRound: 1 }
      : { unitId: unit.id, action: "keepall", answeredInRound: 1 });
  }
  const state = tracker.state();
  const plan = planVerdictApplication({ state, baseRevision: snapshot.revision, nodes: snapshot.nodes });
  return { snapshot, units, plans: plan === null ? [] : [plan], batch: {
    round: 1, verdicts: state.verdicts,
  } };
}

function verdictInput(scene: Scene, overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    input: pruneEvent(scene.batch.verdicts, scene.batch.round),
    snapshot: scene.snapshot,
    capabilities: capabilities(true),
    config,
    plans: scene.plans,
    sealedEpisodeIds: [],
    nowMs: 10,
    ...overrides,
  };
}

/**
 * Runs the guard's checks in the order `Guard#validate` runs them and stops
 * where rendering begins (candidate rendering is slice 3's receipt branch).
 */
function runChecks(value: ValidationInput): readonly ValidationIssue[] {
  const c = context(value);
  const report = (code: ValidationCode, detail: string): void => {
    c.issues.push({ code, detail, nodeId: null, ruleId: null, operationIndex: null });
  };
  checkInput(value, report);
  checkTranscript(c);
  checkVerdicts(c, value.plans);
  checkSources(c, value.plans);
  checkOperations(c, value.plans);
  return c.issues;
}

function codes(issues: readonly ValidationIssue[]): ValidationCode[] {
  return [...new Set(issues.map(issue => issue.code))];
}

function guard(): Guard {
  return new Guard({
    ledger: ledger(),
    initialState: { consecutiveValidationFailures: 0, disabled: false },
  });
}

function planOf(scene: Scene): RulePlan {
  const plan = scene.plans[0];
  assert.ok(plan !== undefined, "fixture must produce a plan");
  return plan;
}

function withBatch(value: ValidationInput, verdicts: readonly Verdict[]): ValidationInput {
  return { ...value, input: pruneEvent(verdicts, 1) };
}

// --- pass completeness ------------------------------------------------------

test("a plan that forgets a unit the pass only kept is incomplete-verdicts", () => {
  // The plan removes unit 1's bytes; the document lists the unit as KEPT, so it
  // is in the pass's window and claims no removal. The refusal is
  // `incomplete-verdicts` (the plan forgot what the pass kept), not `unknown-unit`.
  const withForget = scene({ forgotten: 1 });
  const forgotten = withForget.units[1];
  assert.ok(forgotten !== undefined);
  const keptNotForgotten: Verdict = { unitId: forgotten.id, action: "keepall", answeredInRound: 1 };
  const value = withBatch(verdictInput(withForget), withForget.batch.verdicts.map(verdict =>
    verdict.unitId === forgotten.id ? keptNotForgotten : verdict));
  assert.deepEqual(codes(runChecks(value)), ["incomplete-verdicts"]);
});

// --- window membership, round ordinals and plan shape, one row each --------

test("window membership and round ordinals — one refusal row per case", () => {
  // A verdict naming a unit outside the window is unknown-unit.
  const allKeep = scene();
  const stranger: Verdict = { unitId: "unit:sha256:stranger", action: "forgetall",
    summary: "no such unit", answeredInRound: 1 };
  assert.deepEqual(codes(runChecks(withBatch(verdictInput(allKeep),
    [...allKeep.batch.verdicts, stranger]))), ["unknown-unit"], "row: a stranger unit");

  // A node below the bar is outside the window even when its id is computable.
  const { small } = transcript();
  const belowBar = unitIdFor(sessionId, small, {
    byteRange: { startByte: 0, endByteExclusive: small.byteLength },
    lineRange: { startLine: 1, endLineInclusive: 1 },
  });
  const belowBarVerdict: Verdict = { unitId: belowBar, action: "forgetall", summary: "tiny",
    answeredInRound: 1 };
  assert.deepEqual(codes(runChecks(withBatch(verdictInput(scene()),
    [...scene().batch.verdicts, belowBarVerdict]))), ["unknown-unit"], "row: a node below the bar");

  const withForget = scene({ forgotten: 1 });
  const forgotten = withForget.batch.verdicts.find(verdict => verdict.action === "forgetall");
  assert.ok(forgotten !== undefined);
  const base = verdictInput(withForget);
  const restamp = (round: number): ValidationInput => withBatch(base,
    withForget.batch.verdicts.map(verdict => verdict.unitId === forgotten.unitId
      ? { ...verdict, answeredInRound: round } : verdict));
  // Round 2 was never assigned: the pass is round 1.
  assert.deepEqual(codes(runChecks(restamp(2))), ["unknown-unit"], "row: round 2, never assigned");
  // Round 0 names no pass at all: pass rounds start at one.
  assert.deepEqual(codes(runChecks(restamp(0))), ["unknown-unit"], "row: round 0");
  // A fractional ordinal is not a round: the reader refuses the removal row, and
  // the plan's removal is then left with no answer behind it.
  assert.deepEqual(codes(runChecks(restamp(1.5))), ["invalid-plan", "incomplete-verdicts"],
    "row: a fractional round");

  // A pass naming round zero cannot be checked and is refused.
  assert.ok(codes(runChecks({ ...base, input: pruneEvent([], 0) })).includes("invalid-plan"),
    "row: a pass at round zero");

  // One unit carrying two removal rows is conflicting-operations.
  const doubled: Verdict = { ...forgotten, summary: null };
  assert.deepEqual(codes(runChecks(withBatch(verdictInput(scene({ forgotten: 1 })),
    [...scene({ forgotten: 1 }).batch.verdicts, doubled]))), ["conflicting-operations"],
  "row: two removal rows for one unit");

  // A verdict event carries verdict plans only.
  const capLike: RulePlan = { ruleId: "cap", baseRevision: withForget.snapshot.revision,
    removals: [], notes: [], operations: [] };
  assert.ok(codes(runChecks(verdictInput({ ...withForget,
    plans: [...withForget.plans, capLike] }))).includes("wrong-rule"),
  "row: a cap plan in a verdict event");

  // A removal archiving another node's bytes is refused, and the detail names
  // the rule it broke.
  const plan = planOf(withForget);
  const other = withForget.units[0];
  assert.ok(other !== undefined);
  const widened: RulePlan = { ...plan, removals: plan.removals.map(removal => ({ ...removal,
    sources: [{ source: { ...other.source }, ranges: [{ ...other.span.byteRange }] }] })) };
  const widenedIssues = runChecks(verdictInput({ ...withForget, plans: [widened] }));
  assert.deepEqual(codes(widenedIssues), ["invalid-plan"], "row: a removal over another node's bytes");
  assert.ok(widenedIssues.some(issue => issue.detail.includes("exactly the ranges its answer gives up")),
    JSON.stringify(widenedIssues));
});

// --- the three-action format: keeplines, and its forgetlines mirror --------

test("a keeplines and a forgetlines answer both pass the guard and remove the same spans", async () => {
  // A keeplines answer passes the guard and removes the complement of its kept
  // spans.
  const trimmed = trimmedScene([{ from: 1, to: 1 }, { from: 4, to: 4 }]);
  assert.deepEqual(runChecks(verdictInput(trimmed)), [], "a legal partial keep passes every check");
  const plan = planOf(trimmed);
  assert.equal(plan.removals.length, 1);
  // Unit 1's body is four lines: "head 1" is 7 bytes with its break, "banner 1"
  // is 9 and "value 1" is 8. Lines 2–3 therefore run from byte 7 to byte 24.
  assert.deepEqual(plan.removals[0]?.sources[0]?.ranges, [{ startByte: 7, endByteExclusive: 24 }]);
  const note = plan.notes[0];
  assert.equal(note?.kind, "receipt");
  if (note?.kind !== "receipt") assert.fail("expected a receipt");
  assert.deepEqual(note.ranges, [{ startLine: 2, endLineInclusive: 3 }]);
  assert.equal(note.label, null, "a keeplines receipt names ranges, not a descriptor");

  const validation = await guard().validate(verdictInput(trimmed));
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.mode, "revert");
  assert.equal(validation.application.appendRecords.length, 1);
  // The receipt names the removed lines, never the kept ones.
  assert.match(new TextDecoder().decode(validation.application.appendRecords[0]?.bytes),
    /lines 2–3 · necromancy recall:sha256:/u);

  // Naming 2–3 as the DROP is the mirror of keeping 1–1 and 4–4; the plan must
  // be the same removal, so the guard sees one arithmetic for both classes.
  const mirrored = trimmedScene([{ from: 2, to: 3 }], 1, "forgetlines");
  assert.deepEqual(runChecks(verdictInput(mirrored)), [], "a legal partial drop passes every check");
  assert.deepEqual(planOf(mirrored).removals, planOf(trimmed).removals,
    "the two classes tile the unit identically");
  const mirrorNote = planOf(mirrored).notes[0];
  if (mirrorNote?.kind !== "receipt") assert.fail("expected a receipt");
  assert.deepEqual(mirrorNote.ranges, [{ startLine: 2, endLineInclusive: 3 }]);
  assert.equal(mirrorNote.label, null, "a forgetlines receipt names ranges, not a descriptor");
  const mirrorValidation = await guard().validate(verdictInput(mirrored));
  if (!mirrorValidation.ok) assert.fail(JSON.stringify(mirrorValidation.issues));
  assert.equal(mirrorValidation.application.mode, "revert");
  assert.match(new TextDecoder().decode(mirrorValidation.application.appendRecords[0]?.bytes),
    /lines 2–3 · necromancy recall:sha256:/u);
});

test("a partial keep prices its dropped ranges as freed and its kept lines as kept (ISSUE-509)", async () => {
  const trimmed = trimmedScene([{ from: 1, to: 1 }, { from: 4, to: 4 }]);
  const validation = await guard().validate(verdictInput(trimmed));
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  const revert = validation.application.revert;
  assert.ok(revert !== undefined, "a partial keep is applied by checkpoint-revert");
  const receiptBytes = validation.application.appendRecords[0]?.bytes.length ?? 0;
  assert.ok(receiptBytes > 0, "the receipt is a rendered record");
  // Unit 1's body is 33 bytes ("head 1\nbanner 1\nvalue 1\nfooter 1\n"). Lines 2–3
  // are the dropped 7..24 span: 17 freed bytes. The kept lines 1 and 4 (16 bytes)
  // stay in the request, beside the suffix after the cut: result-2's 33 bytes and
  // the tiny node's 5.
  assert.deepEqual(revert.cost, {
    cutIndex: 2, freedBytes: 17, keptBytes: 54, receiptBytes,
    netFreedBytes: 17 - 54 - receiptBytes,
  }, "row: partial keep — only the dropped ranges are freed");
  assert.equal(salvageShare(revert.cost.keptBytes, revert.cost.freedBytes), 54 / 71,
    "row: the journal's salvage share is priced on the corrected numbers");
});

test("a receipt names the removed ranges, and unsorted spans normalise to the same plan", () => {
  // Two excerpts, the owner's case: keep 1–1 and 4–4, remove the middle 2–3.
  const trimmed = trimmedScene([{ from: 1, to: 1 }, { from: 4, to: 4 }]);
  const note = planOf(trimmed).notes[0];
  if (note?.kind !== "receipt") assert.fail("expected a receipt");
  assert.deepEqual(note.ranges, [{ startLine: 2, endLineInclusive: 3 }],
    "row: keep the head and the tail");
  // And the mirror: keep the middle, remove both ends.
  const middle = trimmedScene([{ from: 2, to: 3 }]);
  const middleNote = planOf(middle).notes[0];
  if (middleNote?.kind !== "receipt") assert.fail("expected a receipt");
  assert.deepEqual(middleNote.ranges,
    [{ startLine: 1, endLineInclusive: 1 }, { startLine: 4, endLineInclusive: 4 }],
    "row: keep the middle");

  // The normaliser is the contract: 3–4 then 1–1 overlaps nothing but is out of
  // order, and the plan must equal the ordered answer's plan.
  const mess = trimmedScene([{ from: 4, to: 4 }, { from: 1, to: 1 }, { from: 1, to: 1 }]);
  assert.deepEqual(runChecks(verdictInput(mess)), [], "row: unsorted spans are accepted");
  assert.deepEqual(planOf(mess).removals, planOf(trimmed).removals,
    "row: unsorted spans plan the same removal as the ordered answer");

  // A receipt naming the kept spans instead of the removed ones is invalid-note.
  const plan = planOf(trimmed);
  const forged: RulePlan = { ...plan, notes: plan.notes.map(entry => entry.kind === "receipt"
    ? { ...entry, ranges: [{ startLine: 1, endLineInclusive: 1 }, { startLine: 4, endLineInclusive: 4 }] }
    : entry) };
  const forgedIssues = runChecks(verdictInput({ ...trimmed, plans: [forged] }));
  assert.deepEqual(codes(forgedIssues), ["invalid-note"], "row: a receipt naming the kept spans");
  assert.ok(forgedIssues.some(issue => issue.detail.includes("ranges other than")),
    JSON.stringify(forgedIssues));
});

// --- the descriptor cap in the guard ---------------------------------------

test("a descriptor past 25 words is descriptor-too-long and the batch is refused", async () => {
  const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
  // 25 words is the cap: exactly at it passes.
  assert.deepEqual(runChecks(verdictInput(scene({ forgotten: 1, label: words(25) }))), [],
    "row: 25 words is admitted");
  const over = codes(runChecks(verdictInput(scene({ forgotten: 1, label: words(26) }))));
  assert.deepEqual(over, ["descriptor-too-long"], "row: 26 words is refused");
  const validation = await guard().validate(verdictInput(scene({ forgotten: 1, label: words(26) })));
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.ok(validation.issues.some(issue => issue.code === "descriptor-too-long"),
    JSON.stringify(validation.issues));
  // The plan clamped the receipt anyway, so no paragraph reached a record.
  const note = planOf(scene({ forgotten: 1, label: words(26) })).notes[0];
  if (note?.kind !== "receipt") assert.fail("expected a receipt");
  assert.ok(note.label?.endsWith("…"));
  // A 50-character descriptor passes: the label cap is 40 advertised, 50
  // enforced; a descriptor is capped in words instead (25), so a 50-character
  // single word passes both.
  assert.deepEqual(runChecks(verdictInput(scene({ forgotten: 1, label: "a".repeat(50) }))), [],
    "row: a 50-character single-word descriptor is one word");
});

// --- the retired `reason` field (owner ruling 2026-10-23) --------------------

test("a verdict carrying a reason field is refused as an unknown field", () => {
  // The schema is closed: `keepall` and `keeplines` carry no free text, and
  // `forgetall` carries `summary` alone. A leftover `reason` is not ignored —
  // it makes the answer unreadable, so the answer is refused, never accepted
  // minus a field. A prune document is typed, so the closed-shape reader speaks
  // at its own boundary: `prune/ask-answer.ts` calls `readVerdict` per row.
  const clean = scene().units.map(unit => ({ unitId: unit.id, action: "keepall" as const,
    answeredInRound: 1 }));
  for (const raw of clean) assert.notEqual(readVerdict(raw), null, JSON.stringify(raw));
  const withReason = [
    { ...clean[0]!, reason: null },
    { ...clean[1]!, reason: "because the file is stale" },
    { ...clean[2]!, action: "forgetall" as const, summary: "header only", reason: null },
  ] as unknown[];
  // Every action is affected: the field is not legal anywhere, including on the
  // one action that keeps a free-text descriptor.
  for (const raw of withReason) assert.equal(readVerdict(raw), null, JSON.stringify(raw));

  // Type level, checked by `npm run typecheck`: the schema itself is the guard
  // against a producer that would otherwise reintroduce the field. The two
  // directives below are the assertion; a schema that accepted `reason` again
  // would make them unused and fail the typecheck.
  const typed = (verdict: Verdict): Verdict => verdict;
  // @ts-expect-error `reason` was dropped from every verdict variant.
  const keep = typed({ unitId: "unit:sha256:x", action: "keepall", answeredInRound: 1, reason: null });
  // @ts-expect-error `reason` was dropped from every verdict variant.
  const forget = typed({ unitId: "unit:sha256:x", action: "forgetall", summary: null, answeredInRound: 1, reason: "why" });
  assert.equal(readVerdict(keep), null);
  assert.equal(readVerdict(forget), null);
});

test("readVerdict accepts the reason-free shapes it is documented to accept", () => {
  assert.deepEqual(readVerdict({ unitId: "unit:sha256:x", action: "keepall", answeredInRound: 1 }),
    { unitId: "unit:sha256:x", action: "keepall", answeredInRound: 1 });
  assert.deepEqual(readVerdict({ unitId: "unit:sha256:x", action: "keeplines",
    ranges: [{ from: 1, to: 2 }], answeredInRound: 1 }),
  { unitId: "unit:sha256:x", action: "keeplines", answeredInRound: 1, ranges: [{ from: 1, to: 2 }] });
  assert.deepEqual(readVerdict({ unitId: "unit:sha256:x", action: "forgetlines",
    ranges: [{ from: 1, to: 2 }], answeredInRound: 1 }),
  { unitId: "unit:sha256:x", action: "forgetlines", answeredInRound: 1, ranges: [{ from: 1, to: 2 }] });
  assert.deepEqual(readVerdict({ unitId: "unit:sha256:x", action: "forgetall",
    summary: "header only", answeredInRound: 1 }),
  { unitId: "unit:sha256:x", action: "forgetall", answeredInRound: 1, summary: "header only" });
  // A forgetall may omit its summary; the floor receipt line then ships.
  assert.deepEqual(readVerdict({ unitId: "unit:sha256:x", action: "forgetall", answeredInRound: 1 }),
    { unitId: "unit:sha256:x", action: "forgetall", answeredInRound: 1, summary: null });
  // And an unknown field is refused even when the rest is otherwise legal.
  assert.equal(readVerdict({ unitId: "unit:sha256:x", action: "keepall",
    answeredInRound: 1, note: "extra" }), null);
  // The mirror's field set is closed like its sibling's: `summary` is not a
  // legal slot on `forgetlines` and `ranges` is not one on `forgetall`.
  assert.equal(readVerdict({ unitId: "unit:sha256:x", action: "forgetlines",
    ranges: [{ from: 1, to: 2 }], summary: "s", answeredInRound: 1 }), null);
  assert.equal(readVerdict({ unitId: "unit:sha256:x", action: "forgetall",
    summary: "s", ranges: [{ from: 1, to: 2 }], answeredInRound: 1 }), null);
});

// --- a forget plan, end to end --------------------------------------------

test("a forget plan carries one op, one removal and one receipt through the full guard", async () => {
  const withForget = scene({ forgotten: 1 });
  const plan = planOf(withForget);
  assert.equal(plan.ruleId, "verdict");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.removals.length, 1);
  assert.equal(plan.notes.length, 1);
  const op = plan.operations[0];
  if (op?.kind !== "verdict") assert.fail("expected one verdict operation");
  assert.equal(plan.removals[0]?.sources[0]?.source.nodeId, withForget.units[1]?.nodeId);
  assert.deepEqual(plan.removals[0]?.sources[0]?.ranges, [withForget.units[1]?.span.byteRange]);
  assert.equal(plan.notes[0]?.kind, "receipt");
  assert.deepEqual(runChecks(verdictInput(withForget)), []);

  // Slice 2 stopped at the renderer seam; slice 3's receipt branch closes it.
  // The verdict is now applied end to end: mode "revert", one archive, one
  // receipt record, and a plan whose cut is the forgotten unit's node index.
  const settled = scene({ forgotten: 1, label: "a".repeat(50) });
  const value = verdictInput(settled);
  assert.deepEqual(runChecks(value), [], "every earlier check still passes");
  const validation = await guard().validate(value);
  if (!validation.ok) assert.fail(JSON.stringify(validation.issues));
  assert.equal(validation.application.mode, "revert");
  assert.equal(validation.application.phase, "at-rest");
  assert.equal(validation.application.archives.length, 1);
  assert.equal(validation.application.archives[0]?.operationKind, "verdict");
  assert.equal(validation.application.appendRecords.length, 1);
  const revert = validation.application.revert;
  assert.ok(revert !== undefined, "a revert application carries its approved plan");
  assert.equal(revert.cutIndex, 2, "the forgotten unit is node index 2");
  const unit = settled.units[1];
  assert.ok(unit !== undefined);
  assert.deepEqual(revert.unitIds, [unit.id]);
  assert.deepEqual(revert.appends.map(append => append.afterNodeId), ["result-0"],
    "the first receipt anchors at the prefix tail, not at the transcript head");
});
