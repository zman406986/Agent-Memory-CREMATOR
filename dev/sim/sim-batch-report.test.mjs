#!/usr/bin/env node
/**
 * The multi-lane report's gate (batch-trigger simulation, chunk 2).
 *
 * Run: `node --test dev/sim/sim-batch-report.test.mjs`
 *
 * The table is assembled from plain `planLane` results, so it is checked
 * without the report's own planning path. The reread case is synthetic on
 * purpose: a producer forgets a unit whose path a later `read` call names, and
 * the witness must charge exactly one reread. The real-transcript cases SKIP
 * when their world is absent, naming the missing paths: the pinned fab6632e
 * cases and the pair-2 cases (`scratchpad/` is disposable by law). The pinned
 * cases run normally when the world is present; no check is deleted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASK_GRAMMARS, ASK_ORDERS, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER, DEFAULT_TRANSCRIPT,
  DEFAULT_USAGE, depthsInSegment, planLane, readTimeline, readUsage, sessionFileIn,
  surfacePinsOf, thresholdLane,
} from "./sim-batch-units.mjs";
import {
  ROW_REFUSAL_CLASSES, SEND_CLASSES, SEND_REFUSAL_CAUSES, armOf, campaignMarkdownOf,
  campaignRowOf, gateAMarkdownOf, gateARowOf, laneNameOf, markdownOf, planWithRereads,
  policyFreePeak, policyProducer,
  promptPeakOf, reportOf, rereadsOf, rowOf,
} from "./sim-batch-report.mjs";

const SCRIPT = fileURLToPath(new URL("./sim-batch-report.mjs", import.meta.url));
const HAVE_EVIDENCE = existsSync(DEFAULT_TRANSCRIPT) && existsSync(DEFAULT_USAGE);

/**
 * A test that CLAIMS the pinned world SKIPS when its evidence is missing, with
 * a reason that names both missing paths: a clean checkout cannot reproduce the
 * pinned values (`scratchpad/` is disposable by law). With the world present
 * the check runs normally. Returns false when it skipped.
 */
const requirePinnedWorld = t => {
  if (HAVE_EVIDENCE) return true;
  t.skip("the pinned fab6632e world is absent ("
    + `${DEFAULT_TRANSCRIPT} / ${DEFAULT_USAGE}); set CREMATOR_SIM_EVIDENCE to the`
    + " world's root and re-run — a clean checkout skips this pinned check; it cannot"
    + " reproduce the pinned values from the repo");
  return false;
};

/**
 * Gate A was measured on the 2026-10-30 pair-2 vanilla world (segment 146). That
 * session carries no reasoning and its numbers are void as evidence (ADR-0045);
 * the fixture is kept by name only so the host-trim path and the Gate A shape
 * stay pinned. The default input is now the reasoning-carrying fab6632e world.
 * The session file is FOUND under the world root, not rebuilt from a label.
 */
const PAIR2_WORLD = fileURLToPath(new URL(
  "../../scratchpad/bench/2026-10-30-repeat-pairs/pair-2/worlds/vanilla", import.meta.url));
const PAIR2_TRANSCRIPT = sessionFileIn(PAIR2_WORLD)
  ?? path.join(PAIR2_WORLD, "evidence", "sessions", "ABSENT-session.v4.jsonl");
const PAIR2_USAGE = path.join(PAIR2_WORLD, "evidence", "result.json");
const HAVE_PAIR2 = existsSync(PAIR2_TRANSCRIPT) && existsSync(PAIR2_USAGE);

/**
 * One unit whose body carries a path receipt, so `pathOf` has an answer. Two
 * lines, because the product tables a row only when its facts show two quotes
 * (ADR-0042 Decision 5) and `eligibleOf` applies that gate.
 */
const unitOf = (seq, { step = seq, path = null, padding = 200 } = {}) => {
  const head = path === null ? "" : `<path>${path}</path>
`;
  const text = `${head}${"a".repeat(padding)}
${"b".repeat(padding)}`;
  return { id: `result:${seq}`, seq, step, bytes: Buffer.byteLength(text, "utf8"),
    isError: false, surfaceOp: "append", text };
};

const timelineOf = (units) => ({
  units, hostPrunes: [], hostRemoved: new Set(), hostTokens: 0, compaction: null, session: "session-sim",
});

const depthsOf = (steps, tokens) => steps.map(step => ({ step, tokens }));

test("the table: two stub planLane results become two lines, header and sum intact", () => {
  const units = [1, 2, 3, 4].map(seq => unitOf(seq));
  const timeline = timelineOf(units);
  const depths = depthsOf([1, 2, 3], 1000);
  const keep = planLane({ timeline, depths, lane: 2, floor: 100, producer: policyProducer("keepall") });
  const all = planLane({ timeline, depths, lane: 2, floor: 100, producer: policyProducer("forgetall") });
  const { rows, markdown } = reportOf([
    { lane: 2, policy: "keepall", plan: keep },
    { lane: 2, policy: "forgetall", plan: all },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.policy), ["keepall", "forgetall"]);
  assert.equal(rows[0].triggers, 2, "2 units fire a lane-2 batch, 0 carried");
  assert.equal(rows[0].eligible, 4);
  assert.equal(rows[0].bytesFreedByPolicy, 0, "keepall frees nothing");
  assert.equal(rows[0].billedProxy, 3000, "Σ depth over the three usage rows");
  assert.deepEqual([rows[0].depthFirst, rows[0].depthPeak, rows[0].depthLast], [1000, 1000, 1000]);
  assert.match(markdown, /^\| lane \| policy \| triggers \|/);
  assert.equal(markdown.split("\n").length, 2 + 2, "header, rule, one line per plan");
  assert.match(markdown, /\n\| 2 \| forgetall \|/);
});

test("reread wiring: a forgotten unit whose path is read again counts one reread", () => {
  const path = "C:\\world\\a.ts";
  const units = [unitOf(1, { path })];
  const arm = armOf([
    { type: "tool/call", seq: 5, data: { callId: "c1", name: "read",
      arguments: JSON.stringify({ file_path: path }) } },
    { type: "tool/result", seq: 6, data: { message: { toolCallId: "c1" } } },
  ], "C:\\world");
  const plan = planWithRereads({ timeline: timelineOf(units), depths: depthsOf([1, 2], 1000),
    lane: 1, floor: 100, producer: policyProducer("forgetall"), arm });
  assert.equal(plan.removedUnits, 1, "the forgetall producer removed the one unit");
  assert.equal(plan.rereads, 1, "the later read of that path is the witness");
  assert.deepEqual(plan.rereadHits, [{ seq: 1, witness: "seq6" }]);
  const keep = planWithRereads({ timeline: timelineOf(units), depths: depthsOf([1, 2], 1000),
    lane: 1, floor: 100, producer: policyProducer("keepall"), arm });
  assert.equal(keep.rereads, 0, "keepall removes nothing, so it is never charged");
  assert.equal(rereadsOf({ removed: [{ seq: 1, path: null }], arm }).length, 0, "no path, no witness");
});

test("policy contrast: forgetall frees bytes where keepall frees none, same cadence", () => {
  const units = [1, 2, 3].map(seq => unitOf(seq, { step: seq }));
  const timeline = timelineOf(units);
  const depths = depthsOf([1, 2, 3, 4], 1000);
  const plan = policy => planWithRereads({ timeline, depths, lane: 2, floor: 100,
    producer: policyProducer(policy), arm: armOf([]) });
  const keep = plan("keepall");
  const all = plan("forgetall");
  assert.equal(keep.bytesFreedByPolicy, 0);
  assert.ok(all.bytesFreedByPolicy > 0, "forgetall frees the whole body minus the marker/summary");
  assert.equal(all.triggers, keep.triggers, "same cadence: the trigger is policy-blind");
  assert.equal(all.asks, 1, "3 units over lane 2 fire once; the tail is carried");
  assert.ok(rowOf({ lane: 2, policy: "forgetall", plan: all }).billedProxy
    < rowOf({ lane: 2, policy: "keepall", plan: keep }).billedProxy, "the bill follows the depth");
  assert.throws(() => policyProducer("forgetsome"), error => error.code === "sim-batch-policy-invalid");
});

test("the depth sum is an estimate with its ruler named, never a bill (thirteenth audit 2)", () => {
  const plan = depthSource => ({
    triggers: 1, asks: 1, eligibleResults: 1, bytesFreedByPolicy: 0, bytesFreedGross: 0,
    series: [{ step: 1, depth: 250 }],
    depthSeries: { first: 250, peak: 250, last: 250 }, depthSource,
    rereads: 0, carried: 0, hostTokens: 0, hostPrunes: 0,
  });
  const host = rowOf({ lane: 8, policy: "keepall", plan: plan("host-result.json") });
  const reconstructed = rowOf({ lane: 8, policy: "keepall",
    plan: plan("reconstructed-surface") });
  assert.equal(host.billedProxy, 250);
  assert.equal(reconstructed.billedProxy, 250);
  assert.equal(host.depthRuler, "host-result.json (measured prompt depth)");
  assert.equal(reconstructed.depthRuler,
    "reconstructed-surface @ 3.04 B/token (estimate)");
  const markdown = markdownOf([host, reconstructed]);
  const header = markdown.split("\n")[0];
  assert.match(header, /\| Σ depth \(est\. prompt tokens; not a bill\) \| depth ruler \|/,
    "the header names the column an estimate and gives the ruler its own column");
  assert.doesNotMatch(markdown, /billed proxy/i,
    "no cell calls the depth sum a bill");
  assert.match(markdown, /reconstructed-surface @ 3\.04 B\/token \(estimate\)/,
    "the reconstructed row names the 3.04 B/token ruler");
});

test("real plan mode: keepall charges no rereads on lanes 8/16/32", t => {
  if (!requirePinnedWorld(t)) return;
  const timeline = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  const arm = armOf([]);
  for (const lane of [8, 16, 32]) {
    const plan = planWithRereads({ timeline, depths, lane, producer: policyProducer("keepall"), arm });
    assert.equal(plan.eligibleResults, 268);
    assert.equal(plan.rereads, 0, `lane ${lane} keeps every unit, so no path is removed`);
    assert.equal(plan.bytesFreedByPolicy, 0);
  }
});

/** One live send record as `sim-batch-live.mjs` writes it. */
const sendRecord = ({ ok = true, failureClass = null, batchSize = 2, tabledRows = null,
  rows = [], correction = null }) => ({
  ok, failureClass, batchSize, ...(tabledRows === null ? {} : { tabledRows }), rows, correction });
/**
 * The correction send's OWN record. `runLane` appends it beside the fire's main
 * record and both land in `records`; it carries no `rows` and no `distribution`.
 */
const correctionSendOf = ({ ok = true, failureClass = null, codes = [], batchSize = 2,
  tabledRows = null } = {}) => ({
  kind: "correction", ok, failureClass, correctionCodes: codes, batchSize,
  ...(tabledRows === null ? {} : { tabledRows }),
});
const answeredRow = index => ({ index, status: "answered", action: "keepall" });
const refusedRow = (index, code = "malformed-row", wireCode = "invalid-span") =>
  ({ index, status: "refused", code, wireCode, message: "the wire refused this row" });
/** A run's records and the sends its runner counted (a correction record is a send, not a fire). */
const liveOf = (lane, records) => ({
  lane,
  triggers: records.filter(record => record.kind !== "correction").length,
  sends: records.filter(record => record.kind !== "correction").reduce(
    (sum, record) => sum + 1 + (record.correction ? 1 : 0), 0),
  records,
});

test("the sends breakdown adds up: answered + timed-out + refused = total", () => {
  const live = liveOf("batch-8", [
    sendRecord({ rows: [answeredRow(1), answeredRow(2)] }),
    sendRecord({ ok: false, failureClass: "timeout" }),
    sendRecord({ rows: [refusedRow(1), refusedRow(2)] }),
    sendRecord({ rows: [answeredRow(1), refusedRow(2)],
      correction: { ok: false, codes: [1], failureClass: "parse" } }),
    correctionSendOf({ ok: false, failureClass: "parse", codes: [1], tabledRows: 2 }),
    sendRecord({ ok: false, failureClass: "length-trip" }),
  ]);
  const row = campaignRowOf(live);
  assert.equal(row.sends.total, 6, "five first sends plus one correction send");
  assert.equal(row.sends.total, row.recordedSends, "the records account for every send counted");
  assert.equal(row.sends.answered, 2);
  assert.equal(row.sends["timed-out"], 1);
  assert.equal(row.sends["refused-send"], 3);
  assert.equal(row.sends.answered + row.sends["timed-out"] + row.sends["refused-send"],
    row.sends.total);
  assert.equal(row.sendsAddUp, true);
  assert.equal(row.sendCauses["whole-answer-parse"]
    + row.sendCauses["length-trip"] + row.sendCauses.parse + row.sendCauses.transport,
  row.sends["refused-send"], "the send causes sum to the refused sends");
  assert.deepEqual(SEND_CLASSES, ["answered", "timed-out", "refused-send"]);
  assert.ok(SEND_REFUSAL_CAUSES.includes("whole-answer-parse"));
  assert.deepEqual(ROW_REFUSAL_CLASSES, ["length-trip", "parse", "arithmetic", "timeout"]);
  assert.equal(row.rowRefusals.parse, 3, "the two whole rows plus the one partial row");
  assert.equal(row.rowRefusals["length-trip"], 0,
    "the failed send names no tabledRows, so it charges 0, never batchSize");
  assert.equal(row.rowRefusals.timeout, 0, "the timeout send names no tabledRows either");
  assert.equal(row.rowRefusals.arithmetic, 1,
    "only the FAILED correction's code is a final refusal");
  assert.equal(row.refusedRows, 4, "three parse refusals plus the failed correction's one row");
  assert.equal(ROW_REFUSAL_CLASSES.reduce((sum, name) => sum + row.rowRefusals[name], 0),
    row.refusedRows, "the causes sum to the refused-rows column");
  assert.deepEqual(row.refusedCodes, { "malformed-row": 3 });
  assert.deepEqual(row.wireCodes, { "invalid-span": 3 }, "the wire code rides the record");
});

test("a correction that heals a row is not a row refusal (thirteenth audit 1)", () => {
  const live = liveOf("batch-8", [
    sendRecord({ rows: [answeredRow(1), answeredRow(2)], tabledRows: 2,
      correction: { ok: true, codes: [2], failureClass: null } }),
    correctionSendOf({ codes: [2], tabledRows: 2 }),
  ]);
  const row = campaignRowOf(live);
  assert.equal(row.refusedRows, 0, "the healed row is not a final refusal");
  assert.equal(row.rowRefusals.arithmetic, 0,
    "a correction that healed its row charges no row class");
  assert.equal(row.rowRefusals.parse, 0);
  assert.equal(ROW_REFUSAL_CLASSES.reduce((sum, name) => sum + row.rowRefusals[name], 0),
    row.refusedRows, "the cause column sums to the refused-rows column");
});

test("a send that fails before tabling charges no row (thirteenth audit 1)", () => {
  const row = campaignRowOf(liveOf("batch-8", [
    sendRecord({ ok: false, failureClass: "timeout", batchSize: 12 }),
  ]));
  assert.equal(row.rowRefusals.timeout, 0, "no tabledRows means no row reached the wire");
  assert.equal(row.refusedRows, 0, "the refused-rows column agrees");
  assert.equal(row.sends["timed-out"], 1);
});

test("a whole-answer refusal is a send-level class, never hidden inside 'answered'", () => {
  const only = campaignRowOf(liveOf("batch-8", [
    sendRecord({ rows: [refusedRow(1), refusedRow(2)] }),
  ]));
  assert.equal(only.sends.total, 1);
  assert.equal(only.sends.answered, 0, "no row answered, so the send is not an answered send");
  assert.equal(only.sends["refused-send"], 1);
  assert.equal(only.wholeAnswerSends, 1);
  assert.equal(only.sendCauses["whole-answer-parse"], 1);
  assert.throws(() => campaignRowOf(liveOf("batch-9", [])), error =>
    error.code === "sim-batch-summary-records-empty",
  "a summary over zero records is a refused input, never a zero-send table");
});

test("the campaign table labels row-level and send-level refusals apart", () => {
  const row = campaignRowOf(liveOf("batch-8", [
    sendRecord({ rows: [refusedRow(1), refusedRow(2)] }),
    sendRecord({ ok: false, failureClass: "timeout", tabledRows: 2 }),
  ]), { plannedFires: 30 });
  const markdown = campaignMarkdownOf([row]);
  const header = markdown.split("\n")[0];
  assert.match(header, /\| sends = answered \+ timed-out \+ refused \|/);
  assert.match(header, /\| whole-answer refusals \(sends\) \|/);
  assert.match(header, /\| send refusals by cause \|/);
  assert.match(header, /\| row refusals by cause \|/, "row-level is labelled apart");
  assert.match(markdown, /\| 30\/2 \| 2 = 0 \+ 1 \+ 1 \| 1 \|/,
    "the sends cell is the equation, and the planned/done fires are printed");
  assert.match(markdown, /whole-answer-parse 1/);
  assert.match(markdown, /timeout 2/);
  assert.match(markdown, /malformed-row 2/);
  assert.match(markdown, /invalid-span 2/);
  assert.equal(row.lane, "batch-8", "a string lane label passes through");
  assert.equal(laneNameOf({ lane: 8 }), "batch-8");
  assert.equal(laneNameOf({ lane: 9, mode: "threshold", threshold: 30_000 }),
    "threshold-30000", "the live record carries the numeric lane, so the name is rebuilt");
  assert.equal(laneNameOf({ lane: null, mode: "threshold", threshold: 240_000,
    thresholdUnits: "landed-bytes" }), "bytes-240k", "the unit decides the lane's name");
});

test("the campaign table prints forget answers and applied forgets apart", () => {
  const forgottenRow = index => ({ index, status: "answered", action: "forgetall" });
  const live = liveOf("batch-8", [
    // One forget answer lands on a host-pruned row: paid for, no surface bought.
    { ...sendRecord({ rows: [answeredRow(1), forgottenRow(2)] }),
      distribution: { keep: 1, forget: 1, refused: 0 }, appliedForgets: 0 },
    // Both forget answers shape the surface.
    { ...sendRecord({ rows: [forgottenRow(1), forgottenRow(2)] }),
      distribution: { keep: 0, forget: 2, refused: 0 }, appliedForgets: 2 },
    // An older record: rows only, no distribution and no appliedForgets field.
    sendRecord({ rows: [answeredRow(1), forgottenRow(2)] }),
  ]);
  const row = campaignRowOf(live);
  assert.equal(row.forgetAnswers, 4, "every forget answer, landed or not");
  assert.equal(row.appliedForgets, 2, "only the answered-and-shaped forgets");
  const markdown = campaignMarkdownOf([row]);
  const header = markdown.split("\n")[0];
  assert.match(header, /\| forget answers \| applied forgets \|/);
  assert.match(markdown, /\| batch-8 \| 3 \| 3 = 3 \+ 0 \+ 0 \| 0 \| 4 \| 2 \|/,
    "the two columns are distinct cells");
  const older = campaignRowOf(liveOf("batch-9", [
    sendRecord({ rows: [forgottenRow(1)] }),
  ]));
  assert.equal(older.forgetAnswers, 1);
  assert.equal(older.appliedForgets, null, "no field, no guessed number");
  assert.match(campaignMarkdownOf([older]), /\| batch-9 \| 1 \| 1 = 1 \+ 0 \+ 0 \| 0 \| 1 \| - \|/);
});

test("a keeplines row is never a forget answer, with or without a distribution", () => {
  // ISSUE-175: the row-only fallback used to count `action !== "keepall"`, which
  // swept a keeplines row into `forgetAnswers` on every record that predates the
  // `distribution` field. Both paths must agree that a keeplines row is a keep.
  const kept = index => ({ index, status: "answered", action: "keeplines",
    ranges: [{ from: 1, to: 2 }], summary: "kept two lines" });
  const forgotten = index => ({ index, status: "answered", action: "forgetall" });
  const withDistribution = campaignRowOf(liveOf("batch-8", [
    // Rows carry the keeplines row AND the fixed distribution agrees.
    { ...sendRecord({ rows: [answeredRow(1), kept(2), forgotten(3)] }),
      distribution: { keep: 2, forget: 1, refused: 0, keeplines: 1 }, appliedForgets: 1 },
  ]));
  assert.equal(withDistribution.forgetAnswers, 1, "only the forgetall row counts");
  assert.equal(withDistribution.keeplinesAnswers, 1);
  // The same rows with no distribution at all: the fallback must match.
  const rowsOnly = campaignRowOf(liveOf("batch-9", [
    sendRecord({ rows: [answeredRow(1), kept(2), forgotten(3)] }),
  ]));
  assert.equal(rowsOnly.forgetAnswers, 1, "the fallback counts the forgetall row only");
  assert.equal(rowsOnly.forgetAnswers, withDistribution.forgetAnswers,
    "both paths read the same rows the same way");
  assert.equal(rowsOnly.keeplinesAnswers, 0,
    "no distribution field means no guessed keeplines count");
});

test("the campaign table names the threshold semantics a run was measured under", () => {
  const live = { lane: "threshold-60000", mode: "threshold", threshold: 60_000,
    semantics: "incremental", triggers: 1, sends: 1,
    records: [sendRecord({ rows: [answeredRow(1)] })] };
  const row = campaignRowOf(live);
  assert.equal(row.semantics, "incremental", "the depth window's rule rides the row");
  const markdown = campaignMarkdownOf([row]);
  assert.match(markdown.split("\n")[0],
    /\| threshold semantics \| lines not forgotten \(refusals included\) \| lines not forgotten, answered only \| completeness \/ citability \| usageIsEstimated \| model \/ source \|$/);
  assert.match(markdown.split("\n")[2], /\| threshold-60000 \| 1 \| 1 = 1 \+ 0 \+ 0 \| .*\| incremental \|/);
  const older = campaignRowOf({ ...live, semantics: undefined });
  assert.equal(older.semantics, null, "a run that predates the field is not guessed");
  assert.match(campaignMarkdownOf([older]).split("\n")[2], /\| - \| - \| - \| - \| - \| - \|$/);
});

test("Gate A row: fires, carried, ceiling 2F+2, peak prompt and segment depth", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  const plan = planLane({ timeline, depths, lane: 8 });
  const row = gateARowOf({ name: "batch-8", mode: "batch", size: 8, plan, timeline });
  // P6 (eleventh audit): the prune predicate is strict, so a fire landing on a
  // prune's own step tables the rows it names. All 266 eligible units reach the
  // surface, the lane fires 33 times and the peak is the fire at step 84.
  assert.equal(row.fires, 33,
    "266 askable units over lane 8 (a later-pruned original is askable until the step after its prune)");
  assert.equal(row.carried, 2, "33 x 8 asks 264 of the 266 askable rows; 2 were never asked");
  assert.equal(row.askCeiling, 68, "2*33 + 2");
  assert.equal(row.eligible, 266, "the eligible population, host-pruned originals included");
  assert.equal(row.segmentPeakDepth, 320_637);
  // The planned peak now crosses the pre-send guard: a measurement reports it
  // (the guard is a send-time rule), and the table row states the number.
  assert.ok(row.peakPromptTokens > 400_000,
    `peak prompt τ ${row.peakPromptTokens}`);
  assert.ok(row.peakPromptGuardTokens > 400_000,
    "the planned peak is over the 400k guard; the row says so instead of refusing");
  assert.equal(row.peakPromptGuardTokens,
    Math.max(Math.ceil(row.peakPromptBytes / 3), Math.ceil(row.peakPromptWireBytes / 3)),
    "the guard is the LARGER of the content-only and wire-derived token counts");
  assert.equal(row.peakPromptTokens, Math.ceil(row.peakPromptBytes / 3.04),
    "the token estimate is the measured 3.04 B/token ratio");
  assert.equal(row.peakPromptStep, 84, "the peak is the fire that carries the most context");
  const pins = surfacePinsOf(timeline, depths);
  const markdown = gateAMarkdownOf([row], pins);
  assert.match(markdown, /^pins: eligible 266 = appends 176/);
  assert.match(markdown, /\| batch-8 \| batch \| 8 \| - \| 33 \| 2 \| 68 \| 266 \|/);
  // A plan with no fires has no prompt peak and a finite 2·0+2 ceiling.
  const empty = gateARowOf({ name: "batch-999", mode: "batch", size: 999,
    plan: { triggers: 0, carried: 0, eligibleResults: 0, fireBatches: [], fireSteps: [],
      depthSeries: null }, timeline });
  assert.equal(empty.peakPromptTokens, 0);
  assert.equal(empty.askCeiling, 2);
  assert.equal(promptPeakOf({ fireBatches: [], fireSteps: [] }, timeline).peakPromptTokens, 0);
  // The landed-bytes lane rides the same table, naming its unit.
  const bytes = thresholdLane({ timeline, depths, threshold: 240_000,
    thresholdUnits: "landed-bytes" });
  const bytesRow = gateARowOf({ name: "bytes-240k", mode: "threshold", size: 240_000,
    unit: "landed-bytes", plan: bytes, timeline });
  assert.equal(bytesRow.unit, "landed-bytes");
  // A replacement enters at its own step and a later-pruned original is askable
  // until the step AFTER its prune (P6), so the accumulator counts 266 units:
  // eight fires, 48 carried.
  assert.equal(bytesRow.fires, 8);
  assert.equal(bytesRow.carried, 48);
  assert.equal(bytesRow.askCeiling, 18, "2*8 + 2");
  assert.match(gateAMarkdownOf([bytesRow]), /\| bytes-240k \| threshold \| 240000 \| landed-bytes \| 8 \|/);
});

test("Gate A: fires, pins and peak step do not move with the ask grammar", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  const plan = thresholdLane({ timeline, depths, threshold: 240_000,
    thresholdUnits: "landed-bytes" });
  const rows = ASK_GRAMMARS.map(grammar => gateARowOf({ name: "bytes-240k", mode: "threshold",
    size: 240_000, unit: "landed-bytes", plan, timeline, grammar }));
  assert.deepEqual(plan.fireSteps, [26, 38, 50, 84, 87, 100, 103, 122],
    "the pinned eight fires, whatever the grammar");
  for (const row of rows) {
    assert.equal(row.fires, 8);
    assert.equal(row.carried, 48);
    assert.equal(row.askCeiling, 18, "2*8 + 2 is grammar-independent");
    assert.deepEqual(row.pendingSizes, [33, 30, 23, 37, 38, 16, 18, 23]);
    assert.equal(row.peakPromptStep, 84, "the same fire is the peak under every grammar");
    assert.equal(row.segmentPeakDepth, 320_637);
  }
  assert.deepEqual(rows.map(row => row.grammar), ASK_GRAMMARS);
  assert.equal(new Set(rows.map(row => row.peakPromptBytes)).size, ASK_GRAMMARS.length,
    "only the ask bytes differ: one peak prompt per grammar");
});

test("Gate A: fires, pins and peak step do not move with the ask order", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  const plan = thresholdLane({ timeline, depths, threshold: 240_000,
    thresholdUnits: "landed-bytes" });
  const rows = ASK_ORDERS.map(order => gateARowOf({ name: "bytes-240k", mode: "threshold",
    size: 240_000, unit: "landed-bytes", plan, timeline, grammar: "two-option", order }));
  assert.deepEqual(plan.fireSteps, [26, 38, 50, 84, 87, 100, 103, 122],
    "the pinned eight fires, whatever the order");
  for (const row of rows) {
    assert.equal(row.fires, 8);
    assert.equal(row.carried, 48);
    assert.equal(row.askCeiling, 18, "2*8 + 2 is order-independent");
    assert.deepEqual(row.pendingSizes, [33, 30, 23, 37, 38, 16, 18, 23]);
    assert.equal(row.peakPromptStep, 84, "the same fire is the peak under every order");
    assert.equal(row.segmentPeakDepth, 320_637);
    assert.equal(row.grammar, "two-option", "the phase-3 winner composes with every order");
  }
  assert.deepEqual(rows.map(row => row.order), ASK_ORDERS);
  const bytes = rows.map(row => row.peakPromptBytes);
  assert.equal(bytes[1], bytes[0], "after moves the block and adds no byte");
  assert.ok(bytes[2] > bytes[1], "both adds one more copy of the block");
});

test("Gate A runs offline under --ask-grammar keeplines-60 with the pins unchanged", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const result = spawnSync(process.execPath,
    [SCRIPT, "--gate-a", "--ask-grammar", "keeplines-60", "--segment", "146",
      "--transcript", PAIR2_TRANSCRIPT, "--usage", PAIR2_USAGE,
      "--allow-zero-reasoning", "--json"],
    { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[grammar\] keeplines-60/);
  const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{\n  \"pins\"")));
  assert.equal(printed.pins.eligible, 266, "the pins are grammar-independent");
  assert.equal(printed.pins.peakDepth, 320_637);
  for (const row of printed.rows) {
    assert.equal(row.grammar, "keeplines-60");
    assert.ok(row.peakPromptBytes > 0);
  }
  const bytes = printed.rows.find(row => row.lane === "bytes-240k");
  assert.ok(bytes !== undefined, "the landed-bytes lane is planned under the flag");
  assert.equal(bytes.fires, 8, "the arm B bytes move no fire");
  assert.equal(bytes.peakPromptStep, 84);
  assert.deepEqual(bytes.pendingSizes, [33, 30, 23, 37, 38, 16, 18, 23]);
});

test("--ignore-host-prunes: the report row carries the ignored host totals", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const on = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const off = readTimeline(PAIR2_TRANSCRIPT, { segment: 146, ignoreHostPrunes: true });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  const rowFor = timeline => rowOf({ lane: 8, policy: "keepall",
    plan: planLane({ timeline, depths, lane: 8, producer: policyProducer("keepall") }) });
  const offRow = rowFor(off);
  assert.equal(offRow.eligible, 176, "the host's copies are not units in this world");
  assert.equal(offRow.hostPrunes, 0);
  assert.equal(offRow.hostTokens, 0);
  assert.equal(offRow.ignoreHostPrunes, true);
  assert.equal(offRow.hostPrunesIgnored, 90);
  assert.equal(offRow.hostTokensIgnored, 409_482);
  assert.equal(offRow.hostReplacementsIgnored, 90);
  const onRow = rowFor(on);
  assert.equal(onRow.eligible, 266);
  assert.equal(onRow.hostPrunes, 90);
  assert.equal(onRow.hostTokens, 409_482);
  assert.equal(onRow.ignoreHostPrunes, false);
  assert.equal(onRow.hostPrunesIgnored, 0);
  // The table's last column reads the world's own host tokens, so the ignored
  // row prints 0 where the default row prints the in-segment shadow sum.
  const table = markdownOf([onRow, offRow]);
  const lines = table.split("\n");
  const header = lines[0].split("|").map(part => part.trim());
  const at = header.indexOf("host-prune tokens");
  assert.ok(at > 0, "the table names the host-prune column");
  const cells = lines.slice(2).map(line => line.split("|").map(part => part.trim()));
  assert.equal(cells[0][at], "409482");
  assert.equal(cells[1][at], "0");
});

test("a separate correction record is one send, counted once (twelfth audit 1)", () => {
  // The real shape: `runLane` emits the correction as its OWN record and keeps
  // the fire's `correction` block beside it. Feeding both must count one send
  // per provider request, so 2 first sends + 2 corrections = 4, never 6.
  const live = liveOf("batch-8", [
    sendRecord({ rows: [answeredRow(1), refusedRow(2)], tabledRows: 2,
      correction: { ok: true, codes: [1], failureClass: null } }),
    correctionSendOf({ codes: [1], tabledRows: 2 }),
    sendRecord({ rows: [answeredRow(1), refusedRow(2)], tabledRows: 2,
      correction: { ok: false, codes: [1], failureClass: "parse" } }),
    correctionSendOf({ ok: false, failureClass: "parse", codes: [1], tabledRows: 2 }),
  ]);
  const row = campaignRowOf(live);
  assert.equal(live.sends, 4, "two fires, each with one correction send");
  assert.equal(row.sends.total, live.sends, "the report total equals the runner's own count");
  assert.equal(row.corrections, 2, "both corrections are counted once");
  assert.equal(row.sends.answered, 3, "two first sends plus the answered correction");
  assert.equal(row.sends["refused-send"], 1, "the failed correction, once");
  assert.equal(row.rowRefusals.parse, 2, "one first-pass refusal per fire, never charged again");
  assert.equal(row.rowRefusals.arithmetic, 1,
    "only the failed correction's code is a final refusal; the healed one is not");
  assert.equal(row.refusedRows, 3, "two parse refusals plus the failed correction's one row");
  assert.equal(ROW_REFUSAL_CLASSES.reduce((sum, name) => sum + row.rowRefusals[name], 0),
    row.refusedRows, "the causes sum to the refused-rows column");
});

test("a failed send is charged the rows it tabled, and a correction its own codes (twelfth audit 3)", () => {
  // The fire tabled 7 rows (the kept-quote re-read dropped 3), so a failed send
  // is charged 7, not `batchSize` 10.
  const fire = campaignRowOf(liveOf("batch-8", [
    sendRecord({ ok: false, failureClass: "length-trip", batchSize: 10, tabledRows: 7 }),
  ]));
  assert.equal(fire.rowRefusals["length-trip"], 7, "the seven rows the send tabled");
  assert.notEqual(fire.rowRefusals["length-trip"], 10, "batchSize is not what reached the wire");
  assert.equal(fire.refusedRows, 7, "the refused-rows column counts the same seven");
  // A failed correction keeps its rows; the arithmetic charge is its own codes,
  // and the first pass's parse refusals are charged exactly once.
  const corrected = campaignRowOf(liveOf("batch-8", [
    sendRecord({ batchSize: 10, tabledRows: 3,
      rows: [answeredRow(1), refusedRow(2), refusedRow(3)],
      correction: { ok: false, codes: [1, 4], failureClass: "timeout" } }),
    correctionSendOf({ ok: false, failureClass: "timeout", codes: [1, 4],
      batchSize: 10, tabledRows: 3 }),
  ]));
  assert.equal(corrected.rowRefusals.arithmetic, 2, "the correction's own two codes");
  assert.equal(corrected.rowRefusals.parse, 2, "the first pass's two refused rows, once");
  assert.equal(corrected.rowRefusals.timeout, 0,
    "a correction timeout is a send class, not a whole-table row charge");
  assert.equal(corrected.refusedRows, 4, "two parse refusals plus the two unhealed codes");
});

test("a run's completeness and citability ride the campaign row (twelfth audit 2)", () => {
  const live = { ...liveOf("batch-8", [sendRecord({ rows: [answeredRow(1)] })]),
    complete: false,
    incompleteReasons: ["refused-sends"],
    measurement: { complete: false, citable: false,
      incompleteReasons: ["refused-sends"],
      reasons: ["stand-in-context", "offline-transport"] } };
  const row = campaignRowOf(live);
  assert.equal(row.complete, false, "the run's own completeness is carried, not inferred");
  assert.equal(row.citable, false, "the run's own citability is carried");
  assert.deepEqual(row.incompleteReasons, ["refused-sends"]);
  assert.deepEqual(row.measurementReasons, ["stand-in-context", "offline-transport"],
    "measurement.reasons is carried on the row");
  assert.deepEqual(row.measurement, { reasons: ["stand-in-context", "offline-transport"] },
    "the live JSON path is preserved, not just flattened");
  const markdown = campaignMarkdownOf([row]);
  assert.match(markdown, /INCOMPLETE: refused-sends/, "the table names the incompleteness");
  assert.match(markdown, /NON-CITABLE: stand-in-context, offline-transport/,
    "the table names every citation reason");
  // A record that predates the fields is not guessed.
  const older = campaignRowOf(liveOf("batch-9", [sendRecord({ rows: [answeredRow(1)] })]));
  assert.equal(older.complete, null);
  assert.equal(older.citable, null);
  assert.equal(older.incompleteReasons, null);
  assert.equal(older.measurementReasons, null);
  assert.equal(older.measurement, null);
  assert.doesNotMatch(campaignMarkdownOf([older]), /INCOMPLETE|NON-CITABLE/);
});

test("a citable row also prints its estimated usage and model/source (thirteenth audit 3)", () => {
  const live = {
    ...liveOf("batch-8", [sendRecord({ rows: [answeredRow(1)] })]),
    complete: true, citable: true,
    citableAs: "measurement (reasoning measured)",
    usageIsEstimated: true,
    route: { provider: "mock-replay", model: "scripted-model" },
  };
  const row = campaignRowOf(live);
  assert.equal(row.citable, true);
  assert.equal(row.citableAs, "measurement (reasoning measured)");
  assert.equal(row.usageIsEstimated, true);
  assert.equal(row.model, "scripted-model");
  assert.equal(row.source, "mock-replay");
  const stub = campaignRowOf({ ...live, transport: "stub" });
  assert.equal(stub.source, "stub",
    "a stub run names the transport that served it, never the route it imitates");
  const markdown = campaignMarkdownOf([row]);
  const header = markdown.split("\n")[0];
  assert.match(header, /\| usageIsEstimated \| model \/ source \|$/,
    "the row cannot print citable without these two labels");
  assert.match(markdown.split("\n")[2],
    /\| complete; claim: measurement \(reasoning measured\) \| true \| scripted-model \(mock-replay\) \|$/,
    "a mock-replay row names its estimated usage and its scripted model");
  const older = campaignRowOf(liveOf("batch-9", [sendRecord({ rows: [answeredRow(1)] })]));
  assert.equal(older.usageIsEstimated, null, "a record that predates the field is not guessed");
  assert.equal(older.citableAs, null);
  assert.equal(older.model, null);
  assert.equal(older.source, null);
  assert.match(campaignMarkdownOf([older]).split("\n")[2], /\| - \| - \| - \|$/,
    "an absent label prints -, never a guessed false");
});

test("a live run with no records refuses by name (twelfth audit 2)", () => {
  assert.throws(() => campaignRowOf({ lane: "batch-8", records: [] }), error =>
    error.code === "sim-batch-summary-records-empty");
  assert.throws(() => campaignRowOf({ lane: "batch-8" }), error =>
    error.code === "sim-batch-summary-records-empty");
  assert.throws(() => campaignRowOf({ lane: "batch-8", records: "not-an-array" }), error =>
    error.code === "sim-batch-summary-records-empty");
});

test("the kept fraction labels refusals and the answered-only fraction drops them (twelfth audit 4)", () => {
  const lineRow = (index, status, action, lineCount = 10) =>
    ({ index, status, action, lineCount });
  const live = liveOf("batch-8", [
    { ...sendRecord({ batchSize: 3, tabledRows: 3,
      rows: [lineRow(1, "answered", "keepall"), lineRow(2, "answered", "forgetall"),
        lineRow(3, "refused", null)] }),
      keptLines: 20, totalLines: 30 },
  ]);
  const row = campaignRowOf(live);
  assert.equal(row.keptLines, 20);
  assert.equal(row.totalLines, 30);
  assert.equal(row.keptFraction, 20 / 30,
    "the runner counts the refused row's whole body as kept");
  assert.equal(row.keptFractionAnswered, 10 / 20,
    "answered rows only: the refused row's 10 lines leave both terms");
  assert.equal(row.keptFractionAnsweredMissing, 0);
  const markdown = campaignMarkdownOf([row]);
  const header = markdown.split("\n")[0];
  assert.match(header, /\| lines not forgotten \(refusals included\) \|/);
  assert.match(header, /\| lines not forgotten, answered only \|/);
  // No refusals: the whole record is the answered set, so the two agree.
  const clean = campaignRowOf(liveOf("batch-9", [
    { ...sendRecord({ rows: [answeredRow(1), answeredRow(2)] }), keptLines: 4, totalLines: 20 },
  ]));
  assert.equal(clean.keptFractionAnswered, 4 / 20);
  // A refusal with no per-row line count is not guessed.
  const missing = campaignRowOf(liveOf("batch-10", [
    { ...sendRecord({ rows: [answeredRow(1), refusedRow(2)] }),
      keptLines: 20, totalLines: 30 },
  ]));
  assert.equal(missing.keptFractionAnswered, null, "no per-row line counts, no guessed number");
  assert.equal(missing.keptFractionAnsweredMissing, 1);
});

test("Gate A columns name the token ruler each one computes (twelfth audit 5)", () => {
  const units = [unitOf(1, { padding: 300 }), unitOf(2, { padding: 300, step: 2 })];
  const timeline = timelineOf(units);
  const plan = planLane({ timeline, depths: depthsOf([1, 2], 1000), lane: 1, floor: 100 });
  const row = gateARowOf({ name: "batch-1", mode: "batch", size: 1, plan, timeline, floor: 100 });
  assert.ok(row.peakPromptBytes > 0, "the test plan fires and builds a prompt");
  const markdown = gateAMarkdownOf([row]);
  const header = markdown.split("\n").find(line => line.startsWith("| lane |"));
  assert.match(header, /\| guard max\(content\/3, payload\/3\) \| tokens @ 3\.04 \|/,
    "each column is named for the ruler it reads");
  assert.doesNotMatch(header, /ceil\(B\/3\)/, "the guard is not ceil(peak prompt B / 3)");
  assert.doesNotMatch(header, /τ\(B\/4\)/, "the estimate is not B/4");
  assert.match(markdown, /note: .*payload-only/,
    "the header note says the guard's payload term is payload-only");
  assert.match(markdown, /note: .*not ceil\(peak prompt B \/ 3\)/);
});

test("the planned peak is policy-free and refuses a plan that removes (twelfth audit 6)", () => {
  const units = [unitOf(1, { padding: 300 }), unitOf(2, { padding: 300, step: 2 })];
  const timeline = timelineOf(units);
  const depths = depthsOf([1, 2], 1000);
  const keep = planLane({ timeline, depths, lane: 1, floor: 100,
    producer: policyProducer("keepall") });
  const forget = planLane({ timeline, depths, lane: 1, floor: 100,
    producer: policyProducer("forgetall") });
  assert.ok(forget.bytesFreedGross > 0, "the forgetall plan removes bytes");
  assert.ok(promptPeakOf(keep, timeline, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER, 100)
    .peakPromptBytes > 0, "a keepall plan keeps the policy-free peak readable");
  assert.throws(() => promptPeakOf(forget, timeline, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER, 100),
    error => error.code === "sim-batch-policy-free-peak",
  "a removing plan's later fires read a shaped surface, so the policy-free peak refuses it");
  assert.equal(policyFreePeak, promptPeakOf,
    "the renamed export and the old name are the same function");
});
