#!/usr/bin/env node
/**
 * The batched-ask plan's gate (batch-trigger simulation, chunks 1 and 3).
 *
 * Run: `node --test dev/sim/sim-batch-units.test.mjs`
 *
 * The pinned-world cases SKIP when the world is absent (`requirePinnedWorld`),
 * and the skip message names the missing paths: `scratchpad/` is disposable by
 * law, so a clean checkout cannot reproduce the pinned values and must say so
 * instead of passing by doing nothing. With the world present every one of
 * those checks runs normally; no pinned check is deleted or weakened. The named
 * PAIR-2 cases SKIP for the same reason. Every other case is synthetic, so the
 * arithmetic is checked without any world.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENTRY_ASK_GRAMMAR, ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR,
  PRUNE_ASK_JSONL_20_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_REPEAT,
  PRUNE_ASK_JSONL_20_SYSTEM_PROMPT, PRUNE_ASK_SYSTEM_PROMPT, entryBatchAskMessage,
  jsonl20RejectionsOf as coreJsonl20RejectionsOf,
  landedBytesVerdict as coreLandedBytesVerdict,
  parseEntryBatchAnswer,
} from "@cremator/core";
import {
  DEFAULT_THRESHOLD_SEMANTICS, DEFAULT_TRANSCRIPT, DEFAULT_USAGE, FLOOR_BYTES, HOST_DEPTH_SOURCE,
  IGNORED_SEGMENT_PINS, MEASURED_BYTES_PER_TOKEN, SEGMENT_PINS, SURFACE_DEPTH_SOURCE,
  SimBatchUnitsRefusal, askMessageFor, askRowsOf,
  ASK_GRAMMARS, ASK_ORDERS, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER,
  ASK_SCOPES, DEFAULT_ASK_SCOPE, applyFireToSurface, assertAskScope, assertDepthSource,
  assertOrderForGrammar, assertReasoningCarried, assertReasoningInPrompt, assertZeroPruneGate,
  callLabelOf, callNamesOf, contextStandInOf, eligibleSplitOf, expectedReasoningAt, hostRemovedAt,  netDroppedOf, simulateSurface, surfaceFireOf, surfaceShapesEverAppliedOf, surfaceSizeOf,
  surfaceDigestOf, tableUnitsOf,
  assertFirstFireDepth, assertSegmentPins, assertUsageStepsPinned, buildIdentityOf, buildPrompt,
  clampDecisionStep,
  depthsInSegment,
  eligibleOf, eligibilityOf, factsOf, factsShowTwoQuotes, fileSha256Of, inputPinsOf,
  landedBytesVerdict,
  main,
  measuredTokensOf,
  nextBaselineDepth, planLane, promptForFire, readTimeline,
  readUsage, reasoningPairsHashOf, sha256OfText, sessionFileIn, summaryOf, surfaceAt, surfaceDepthAt, surfaceDepthBefore,
  surfaceDepthSeries, surfacePinsOf,
  thresholdLane, thresholdLaneName, thresholdVerdict,
} from "./sim-batch-units.mjs";
import {
  ASK_GRAMMAR_PROMPTS, GRAMMAR_GATE_CODE, JSONL_20_REFUSAL_CODES, JSONL_20_SLOT,
  JSONL_20_VARIANTS, SLOT_GRAMMARS,
  JSONL_20_SUMMARY_WORDS, KEEPLINES_60_SUMMARY_WORDS, SUMMARY_TOO_LONG_CODE,
  answerDetailsOf, answerRowsOf, arithmeticCodeOf, instructionOf, jsonl20RejectionsOf,
  keptLineCountOf, keepsWholeOf,
} from "./sim-batch-grammar.mjs";
import { readTranscript } from "./gate3-live-chain.mjs";
import { promptPeakOf } from "./sim-batch-report.mjs";

const SCRIPT = fileURLToPath(new URL("./sim-batch-units.mjs", import.meta.url));

const HAVE_EVIDENCE = existsSync(DEFAULT_TRANSCRIPT) && existsSync(DEFAULT_USAGE);

/**
 * A test that CLAIMS the pinned world SKIPS when its evidence is missing, with
 * a reason that names both missing paths. A clean checkout cannot reproduce the
 * pinned values from the repo (`scratchpad/` is disposable by law), so passing
 * by doing nothing is refused; a red suite for a missing input is not a
 * finding about the code either. The skip is loud and counted by the runner,
 * and with the world present every check runs normally. Returns false when it
 * skipped, so the caller returns before asserting against absent evidence.
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
 * The 2026-10-30 pair-2 vanilla world, named explicitly. It is the zero-reasoning
 * session ADR-0045 voids as evidence: it is kept here only because the host-trim
 * shape (90 journals, 90 replacements, segment 146) is the regression fixture for
 * `--ignore-host-prunes`, and the default is now the reasoning-carrying world.
 * Its session file is FOUND under the world root, so the host's workspace label
 * (`C-Users-AAAAA-…` / `C-Users-AA-…`) is never rebuilt here.
 */
const PAIR2_WORLD = fileURLToPath(new URL(
  "../../scratchpad/bench/2026-10-30-repeat-pairs/pair-2/worlds/vanilla", import.meta.url));
const PAIR2_TRANSCRIPT = sessionFileIn(PAIR2_WORLD)
  ?? path.join(PAIR2_WORLD, "evidence", "sessions", "ABSENT-session.v4.jsonl");
const PAIR2_USAGE = path.join(PAIR2_WORLD, "evidence", "result.json");
const HAVE_PAIR2 = existsSync(PAIR2_TRANSCRIPT) && existsSync(PAIR2_USAGE);

/**
 * One unit with an ASCII body whose byte count is exactly `bytes`. The body is
 * TWO lines: the product tables a row only when its facts can show two quotes
 * (ADR-0042 Decision 5), so a one-line body is never eligible and would make
 * every trigger test vacuous.
 */
const unitOf = (seq, { bytes = 2000, step = seq, isError = false } = {}) => {
  const head = Math.floor(bytes / 2);
  return {
    id: `result:${seq}`, seq, step, bytes, isError, surfaceOp: "append",
    text: `${"a".repeat(head)}
${"b".repeat(bytes - head - 1)}`,
  };
};

const timelineOf = (units, { hostPrunes = [], session = "session-sim" } = {}) => ({
  units,
  hostPrunes,
  hostRemoved: new Set(hostPrunes.flatMap(prune => prune.seqs)),
  hostTokens: hostPrunes.reduce((sum, prune) => sum + prune.tokens, 0),
  compaction: null,
  session,
});

const depthsOf = (steps, tokens) => steps.map(step => ({ step, tokens }));
/** `[[step, tokens], ...]` as the measured schedule. */
const depthsFrom = pairs => pairs.map(([step, tokens]) => ({ step, tokens }));

const FORGETALL = {
  name: "forgetall",
  decide: ({ unit }) => ({ momentId: unit.id, action: "forgetall", summary: "gone" }),
};

test("both pin sets name the same segment and the same reasoning", () => {
  // `assertSegmentPins` gates on `SEGMENT_PINS.segment` and then picks the set by
  // the ignore flag; two different segments would silently skip the ignored pins.
  assert.equal(IGNORED_SEGMENT_PINS.segment, SEGMENT_PINS.segment);
  assert.equal(IGNORED_SEGMENT_PINS.reasoningBlocks, SEGMENT_PINS.reasoningBlocks);
  assert.equal(IGNORED_SEGMENT_PINS.reasoningBytes, SEGMENT_PINS.reasoningBytes);
  assert.equal(IGNORED_SEGMENT_PINS.reasoningTurns, SEGMENT_PINS.reasoningTurns);
  assert.equal(IGNORED_SEGMENT_PINS.reasoningParts, SEGMENT_PINS.reasoningParts);
  assert.equal(IGNORED_SEGMENT_PINS.reasoningStreamBlocks, SEGMENT_PINS.reasoningStreamBlocks);
  // The input pins name the two files those numbers came from.
  assert.match(SEGMENT_PINS.transcriptSha256, /^[0-9a-f]{64}$/u);
  assert.match(SEGMENT_PINS.usageSha256, /^[0-9a-f]{64}$/u);
  assert.equal(IGNORED_SEGMENT_PINS.transcriptSha256, SEGMENT_PINS.transcriptSha256);
  assert.equal(IGNORED_SEGMENT_PINS.usageSha256, SEGMENT_PINS.usageSha256);
});

test("the real transcript's timeline: 641 results, 132 host prunes, 268 eligible at 139", t => {
  if (!requirePinnedWorld(t)) return;
  // The whole session cannot be a timeline: it carries two `compaction/start`
  // rows and the replay refuses to cross either. The raw log still supplies the
  // whole-session counts; the segment supplies the plan's own.
  const rows = readTranscript(DEFAULT_TRANSCRIPT);
  assert.equal(rows.filter(row => row.type === "tool/result").length, 641,
    "641 tool/result rows, appends and replaces alike");
  const prunes = rows.filter(row => row.type === "compaction/prune");
  assert.equal(prunes.length, 132, "132 compaction/prune rows");
  assert.equal(prunes.reduce((sum, row) => sum + row.data.shadowedTokenCount, 0), 484_155,
    "their shadowed token count sums to 484,155");
  assert.equal(new Set(prunes.flatMap(row => row.data.shadowedSeqs)).size, 132,
    "one shadowed seq per prune, all distinct");
  // A log that opened a compaction REFUSES an absent segment by name.
  assert.throws(() => readTimeline(rows), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-segment-required");
  const timeline = readTimeline(rows, { segment: 139 });
  assert.equal(FLOOR_BYTES, 512, "ADR-0051: the sim's default floor is 512 B");
  assert.equal(timeline.units.length, 299, "299 in-segment tool/result rows");
  const eligible = eligibleOf(timeline, 512);
  assert.equal(eligible.length, 268, "over the product's 512 floor and not an error");
  assert.equal(eligible.filter(unit => unit.isError).length, 0,
    "the eligible stream carries no error");
  assert.equal(timeline.hostPrunes.length, 67, "67 in-segment prune rows");
  assert.equal(timeline.compaction, null, "the first compaction boundary is outside the cut");
  // Every host-pruned unit is in the eligible stream: the union has real work.
  const eligibleSeqs = new Set(eligible.map(unit => unit.seq));
  assert.equal([...timeline.hostRemoved].filter(seq => eligibleSeqs.has(seq)).length, 67);
  // ADR-0045's check on the segment: the reasoning is there.
  assert.equal(timeline.reasoningBlocks, 86, "86 sendable reasoning turns");
  assert.equal(timeline.reasoningBytes, 155_545, "their joined text");
});

/** A tiny transcript: two appends, one host prune of the first, its replacement. */
const hostTrimRows = () => [
  { type: "step/start", seq: 1, data: { step: 1 } },
  { type: "system/message", seq: 2,
    data: { message: { content: [{ type: "text", text: "sys" }] } } },
  { type: "tool/result", seq: 3, surfaceOp: "append",
    data: { step: 1, message: { content: [{ type: "text",
      text: `${"a".repeat(2000)}\n${"a".repeat(1999)}` }] } } },
  { type: "tool/result", seq: 4, surfaceOp: "append",
    data: { step: 1, message: { content: [{ type: "text",
      text: `${"b".repeat(1000)}\n${"b".repeat(999)}` }] } } },
  { type: "step/start", seq: 5, data: { step: 2 } },
  { type: "compaction/prune", seq: 6, data: { shadowedSeqs: [3], shadowedTokenCount: 1000 } },
  { type: "tool/result", seq: 7, surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
    data: { step: 1, message: { content: [{ type: "text",
      text: `${"t".repeat(750)}
${"t".repeat(749)}` }] } } },
  { type: "session", seq: 8, id: "session-sim" },
];

test("ignoreHostPrunes: the host's trim leaves the world, the original stays whole", () => {
  const on = readTimeline(hostTrimRows());
  const off = readTimeline(hostTrimRows(), { ignoreHostPrunes: true });
  // The default path is today's: one fixed removal, its replacement a unit.
  assert.equal(on.hostPrunes.length, 1);
  assert.equal(on.hostTokens, 1000);
  assert.deepEqual([...on.hostRemoved], [3]);
  assert.deepEqual(on.units.map(unit => unit.seq), [3, 4, 7]);
  assert.equal(on.ignoreHostPrunes, false);
  assert.equal(on.hostPrunesIgnored, 0);
  // The ignored path: no removal, and the trim's own replacement row is gone.
  assert.deepEqual(off.hostPrunes, []);
  assert.deepEqual([...off.hostRemoved], []);
  assert.equal(off.hostTokens, 0);
  assert.deepEqual(off.units.map(unit => unit.seq), [3, 4]);
  assert.deepEqual(off.units.map(unit => unit.bytes), [4000, 2000]);
  assert.equal(off.ignoreHostPrunes, true);
  assert.equal(off.hostPrunesIgnored, 1);
  assert.equal(off.hostTokensIgnored, 1000);
  assert.equal(off.hostReplacementsIgnored, 1);
  assert.equal(off.segment, on.segment, "the cut did not move");
  assert.throws(() => readTimeline(hostTrimRows(), { ignoreHostPrunes: "yes" }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-ignore-host-prunes-invalid");
});

test("ignoreHostPrunes: the original is on the surface where the prune shadowed it", () => {
  const on = readTimeline(hostTrimRows());
  const off = readTimeline(hostTrimRows(), { ignoreHostPrunes: true });
  const seqAt = (surface, seq) => surface.rows.some(row => row.seq === seq);
  for (const timeline of [on, off]) {
    const before = surfaceAt({ timeline, fireStep: 1, surface: new Map(), fireIndex: 0 });
    assert.equal(seqAt(before, 3), true, "the original is billed before the prune");
    assert.equal(seqAt(before, 7), false, "the replacement has not entered yet");
  }
  // P6 (eleventh audit): the prune owned by step 2 is applied AFTER that step's
  // ask, so at fire 2 the original is still on the surface and the replacement
  // (which enters at its own step) is beside it. From step 3 the original is
  // gone.
  const onAtTwo = surfaceAt({ timeline: on, fireStep: 2, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(onAtTwo, 3), true, "a prune at the fire's own step is not applied yet");
  assert.equal(seqAt(onAtTwo, 7), true, "the host's copy enters at its own step");
  assert.equal(onAtTwo.shadowed.length, 0);
  const onAfter = surfaceAt({ timeline: on, fireStep: 3, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(onAfter, 3), false, "the default shadows the original from the next step");
  assert.equal(seqAt(onAfter, 7), true, "and shows the host's copy");
  assert.equal(onAfter.shadowed.length, 1);
  const offAfter = surfaceAt({ timeline: off, fireStep: 2, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(offAfter, 3), true, "without the trim the original never leaves");
  assert.equal(seqAt(offAfter, 7), false, "the copy never existed");
  assert.equal(offAfter.shadowed.length, 0);
});

test("ignoreHostPrunes: the policy is credited for the original the host had removed", () => {
  const depths = depthsOf([1, 2, 3], 10_000);
  const on = planLane({ timeline: readTimeline(hostTrimRows()), depths, lane: 1,
    producer: FORGETALL });
  const off = planLane({ timeline: readTimeline(hostTrimRows(), { ignoreHostPrunes: true }),
    depths, lane: 1, producer: FORGETALL });
  assert.equal(on.hostPrunes, 1);
  assert.equal(on.hostTokens, 1000);
  // NET: 2,000 + 1,500 gross minus each shaped turn's summary and marker line.
  assert.equal(on.bytesFreedByPolicy, 1873 + 1373, "seq 3 earns nothing, seq 4 and 7 shape");
  assert.equal(on.bytesFreedGross, 2000 + 1500, "gross is recorded beside net");
  assert.equal(off.hostPrunes, 0);
  assert.equal(off.hostTokens, 0);
  assert.equal(off.hostPrunesIgnored, 1);
  assert.equal(off.bytesFreedByPolicy, 3873 + 1873, "the originals are the product's work now");
  assert.equal(off.bytesFreedGross, 4000 + 2000);
  assert.match(summaryOf(off), /host-prunes ignored 1 \(1000 tok, 1 replacement rows\)/);
  assert.doesNotMatch(summaryOf(on), /host-prunes ignored/);
});

test("lane 8 over 370 eligible units fires exactly 46 times and carries 2", () => {
  const units = Array.from({ length: 370 }, (_, index) => unitOf(index + 1));
  const plan = planLane({
    timeline: timelineOf(units), depths: depthsOf([1], 1000), lane: 8,
  });
  assert.equal(plan.eligibleResults, 370);
  assert.equal(plan.triggers, 46, "floor(370 / 8)");
  assert.equal(plan.asks, 46, "one ask per fired batch");
  assert.equal(plan.carried, 2, "the tail is carried, never flushed");
  assert.equal(plan.bytesFreedByPolicy, 0, "the stub keeps every row");
  assert.match(summaryOf(plan), /lane 8 triggers 46 asks 46 eligible 370/);
});

test("depth arithmetic: τ once per summed byte delta, applied strictly before the step", () => {
  // 400 B removed at step 2 (400 -> 132 τ at 3.04 B/token), 800 B at step 3.
  const units = [unitOf(1, { bytes: 400, step: 1 }), unitOf(2, { bytes: 800, step: 2 })];
  const plan = planLane({
    timeline: timelineOf(units),
    depths: depthsOf([1, 2, 3, 4, 5], 1000),
    lane: 1,
    floor: 100,
    producer: FORGETALL,
  });
  // NET removals: 400 B gross → 273 B, 800 B gross → 673 B (summary + marker).
  assert.equal(plan.bytesFreedByPolicy, 273 + 673);
  assert.equal(plan.bytesFreedGross, 1200);
  const byStep = new Map(plan.series.map(point => [point.step, point]));
  assert.equal(byStep.get(1).depth, 1000, "nothing removed before step 1");
  assert.equal(byStep.get(2).depth, 1000, "the step-2 removal is not before step 2");
  assert.equal(byStep.get(3).depth, 910, "step 3 sees the 273 B net removal: 1000 - ceil(273/3.04)");
  assert.equal(byStep.get(4).depth, 688, "step 4 sees both: 1000 - ceil(946/3.04)");
  assert.equal(byStep.get(5).depth, 688);
  assert.deepEqual(plan.depthSeries, { first: 1000, peak: 1000, last: 688 });
});

test("the union of host and ask removals subtracts a unit once", () => {
  // Unit 1 is host-pruned AND shaped; unit 2 is shaped only.
  const units = [unitOf(1, { bytes: 400, step: 1 }), unitOf(2, { bytes: 800, step: 2 })];
  const plan = planLane({
    timeline: timelineOf(units, { hostPrunes: [{ seq: 99, step: 1, seqs: [1], tokens: 400 }] }),
    depths: depthsOf([1, 2, 3, 4], 1000),
    lane: 1,
    floor: 100,
    producer: FORGETALL,
  });
  assert.equal(plan.bytesFreedByPolicy, 673, "the host-pruned unit earns the policy nothing");
  assert.equal(plan.hostTokens, 400);
  const byStep = new Map(plan.series.map(point => [point.step, point]));
  assert.equal(byStep.get(4).depth, 778,
    "only unit 2's 673 B net is τ'd, once: 1000 - ceil(673/3.04)");
});

test("a replacement's cadence step is its entry step, and its removal books at entry + 1", () => {
  // The host's trim wrote its copy at step 4, but the row carries the original's
  // stale `data.step: 1`. The trigger must read the ENTRY step: a fire before 4
  // must never table the copy, and the copy's removal books at 5, not at 2.
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text",
        text: `${"a".repeat(1000)}\n${"a".repeat(999)}` }] } } },
    { type: "step/start", seq: 3, data: { step: 2 } },
    { type: "compaction/prune", seq: 4, data: { shadowedSeqs: [2], shadowedTokenCount: 600 } },
    { type: "step/start", seq: 5, data: { step: 4 } },
    { type: "tool/result", seq: 6, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
      data: { step: 1, message: { content: [{ type: "text",
        text: `${"t".repeat(750)}\n${"t".repeat(749)}` }] } } },
    { type: "session", seq: 7, id: "session-replacement-step" },
  ];
  const timeline = readTimeline(rows);
  const replacement = timeline.units.find(unit => unit.seq === 6);
  assert.equal(replacement.entryStep, 4);
  assert.equal(replacement.step, 4, "the cadence step is the entry step, never the stale 1");
  assert.equal(timeline.units.find(unit => unit.seq === 2).step, 1, "the append is unchanged");

  // Batch lane 1: the append is askable at its OWN step (the host prune lands at
  // step 2, so the surface held it at step 1), then the copy is askable at its
  // entry step 4. The TIME-AWARE stream asks both; before the fix the append was
  // dropped for the whole segment.
  const plan = planLane({ timeline, depths: depthsOf([1, 2, 3, 4, 5, 6], 1000), lane: 1,
    floor: 100, producer: FORGETALL });
  assert.deepEqual(plan.fireSteps, [1, 4], "the append's own step, then the copy's entry");
  assert.deepEqual(plan.fireBatches, [["result:2"], ["result:6"]]);
  assert.equal(plan.eligibleResults, 2, "the eligible population still counts both rows");
  assert.equal(plan.askableResults, 2, "both rows were on the surface at their own steps");
  assert.equal(plan.hostPrunedEligible, 1, "one eligible unit is named by a prune");
  assert.equal(plan.askableBeforePrune, 1, "and it was askable before the prune");
  assert.equal(plan.hostPrunedBeforeLanding, 0, "no unit is removed before it lands");
  const byStep = new Map(plan.series.map(point => [point.step, point]));
  assert.equal(byStep.get(2).removed, 0,
    "the append's shape is booked at step 2, not visible at 2");
  assert.equal(byStep.get(4).removed, 0,
    "the host prune at step 2 owns the append's bytes from step 2 on, so the policy's"
    + " earlier delta is not subtracted again");
  assert.equal(byStep.get(5).removed, 0, "a removal booked at 5 is visible only from 6");
  assert.equal(byStep.get(6).removed, 1373, "the copy's net removal is booked at 4 + 1");

  // Threshold lane: the append is dropped at the prune's step before any
  // crossing, so only the copy is asked — at step 5, the first crossing after
  // its entry.
  const threshold = thresholdLane({ timeline,
    depths: depthsFrom([[1, 1000], [2, 1000], [3, 4000], [4, 4000], [5, 4000]]),
    threshold: 2000, floor: 100 });
  assert.deepEqual(threshold.fireSteps, [5]);
  assert.deepEqual(threshold.fireBatches, [["result:6"]],
    "the only still-askable row is the copy, at its own entry step");
  assert.equal(threshold.prunedBeforeAsk, 1,
    "the append was askable at step 1 but the prune at step 2 beat every fire");
  assert.equal(threshold.carried, 1, "never asked, so carried; the copy was asked");
});

test("a missing or unreadable system message is a NAMED state, never an empty slot", () => {
  // Twelfth audit item 4. Both shapes made `buildPrompt` send an empty first
  // message and said nothing: the system row is not a "row gap" the user/
  // assistant reader counts. The timeline now states which one happened, and
  // `citableReasonsOf` turns it into a reason.
  const result = { type: "tool/result", seq: 3,
    data: { message: { content: [{ type: "text", text: "a\nb" }] } } };
  const base = [{ type: "step/start", seq: 1, data: { step: 1 } }, result,
    { type: "session", seq: 9, id: "session-system" }];
  const absent = readTimeline(base);
  assert.equal(absent.systemAbsent, true, "no system/message row is ABSENT, not empty-by-accident");
  assert.equal(absent.systemUnreadable, false);
  assert.equal(absent.system, "", "the slot is still empty; the state says why");
  const stringRow = { type: "system/message", seq: 2,
    data: { message: { content: "a plain string the reader does not split" } } };
  const unreadable = readTimeline([stringRow, ...base]);
  assert.equal(unreadable.systemAbsent, false, "the row is there");
  assert.equal(unreadable.systemUnreadable, true,
    "a string-content system message reads as no text and is UNREADABLE");
  assert.equal(unreadable.system, "");
  const readable = readTimeline([{ type: "system/message", seq: 2,
    data: { message: { content: [{ type: "text", text: "sys" }] } } }, ...base]);
  assert.equal(readable.systemAbsent, false);
  assert.equal(readable.systemUnreadable, false);
  assert.equal(readable.system, "sys");
  // The stand-in's dropped-row list names both states, so the prompt's own
  // content statement cannot read as a complete surface.
  assert.ok(contextStandInOf(absent, [], []).droppedRowTypes
    .includes("system/message (absent)"));
  assert.ok(contextStandInOf(unreadable, [], []).droppedRowTypes
    .includes("system/message (unreadable content)"));
});

test("readTimeline reads the transcript ONCE and hashes the bytes it parsed", () => {
  // Twelfth audit item 7: rows were read first and the file hashed afterwards,
  // so a changed second read could pin bytes the timeline never replayed.
  const text = `${JSON.stringify({ type: "step/start", seq: 1, data: { step: 1 } })}\n`
    + `${JSON.stringify({ type: "session", seq: 2, id: "session-one-read" })}\n`;
  const calls = [];
  const timeline = readTimeline("virtual-transcript.jsonl", { readBytes: path => {
    calls.push(path);
    // A DIFFERENT buffer on any second call: if the reader made one, either the
    // rows or the hash below would come from `CHANGED`.
    return Buffer.from(calls.length === 1 ? text : "CHANGED", "utf8");
  } });
  assert.deepEqual(calls, ["virtual-transcript.jsonl"], "exactly one read, of this path");
  assert.equal(timeline.transcriptSha256, sha256OfText(text),
    "the pinned hash is the hash of the bytes the rows were parsed from");
  assert.equal(timeline.fileRows, 2, "the rows are the first read's own rows");
});

test("readTimeline refuses a duplicate row seq instead of merging two units", () => {
  // Thirteenth audit item 4: two `tool/result` rows with one seq share a surface
  // key (`result:<seq>`), and the rebuild kept the last, so a run could be green
  // with a merged unit.
  const body = `${"a".repeat(2000)}\n${"b".repeat(1999)}`;
  const duplicate = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, data: { step: 1,
      content: [{ type: "text", text: body }] } },
    { type: "tool/result", seq: 2, data: { step: 1,
      content: [{ type: "text", text: body }] } },
  ];
  assert.throws(() => readTimeline(duplicate), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-transcript-duplicate-seq"
    && /seq 2/.test(error.message) && /tool\/result/.test(error.message),
  "a duplicate seq is refused, never silently merged");
  // The same seq on two different row types is the same defect.
  assert.throws(() => readTimeline([
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, data: { step: 1,
      content: [{ type: "text", text: body }] } },
    { type: "user/message", seq: 2, data: { content: [{ type: "text", text: "hello" }] } },
  ]), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-transcript-duplicate-seq");
});

test("the units launcher hashes the one read of each input, never a second", async () => {
  // Thirteenth audit item 5: `main` read the transcript and usage, then
  // `inputPinsOf` re-read both. Each input is now read once, and the pins are
  // the hashes of THOSE bytes.
  const dir = mkdtempSync(path.join(tmpdir(), "sim-units-launcher-"));
  try {
    const transcriptPath = path.join(dir, "session.v4.jsonl");
    const usagePath = path.join(dir, "result.json");
    const transcriptText = [
      { type: "step/start", seq: 1, data: { step: 1 } },
      { type: "system/message", seq: 2,
        data: { message: { content: [{ type: "text", text: "sys" }] } } },
      { type: "tool/result", seq: 3, data: { step: 1,
        content: [{ type: "text", text: `${"a".repeat(2000)}\n${"b".repeat(1999)}` }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    const usageText = JSON.stringify({ rows: [
      { step: 1, inputTokens: 100, cacheReadTokens: 0 }] });
    writeFileSync(transcriptPath, transcriptText);
    writeFileSync(usagePath, usageText);
    const reads = [];
    const readOf = (label, first) => filePath => {
      reads.push(`${label}:${path.basename(filePath)}`);
      return reads.filter(entry => entry.startsWith(`${label}:`)).length === 1
        ? Buffer.from(first, "utf8") : Buffer.from("CHANGED", "utf8");
    };
    const code = await main(["--transcript", transcriptPath, "--usage", usagePath,
      "--plan", "--lanes", "1", "--allow-zero-reasoning"], {
      readBytes: readOf("transcript", transcriptText),
      readText: readOf("usage", usageText),
      out: () => {},
    });
    assert.equal(code, 0,
      "a changed second read cannot enter the pins: each input is read once");
    assert.deepEqual(reads.sort(),
      ["transcript:session.v4.jsonl", "usage:result.json"],
      "exactly one read of each input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threshold cadence: fires at each crossing step, never below T", () => {
  // Depth grows 100, 300, ... from the 1000 baseline; T = 300.
  const units = [
    unitOf(1, { step: 1 }), unitOf(2, { step: 2 }), unitOf(3, { step: 4 }),
    unitOf(4, { step: 6 }), unitOf(5, { step: 8 }),
  ];
  const plan = thresholdLane({
    timeline: timelineOf(units),
    depths: depthsFrom([[1, 1000], [2, 1100], [3, 1300], [4, 1350], [5, 1600],
      [6, 1700], [7, 2100], [8, 2200], [9, 2600], [10, 2700]]),
    threshold: 300,
  });
  assert.equal(plan.baselineDepth, 1000, "the first measured step's depth is the baseline");
  assert.deepEqual(plan.fireSteps, [3, 5, 7, 9], "step 2 (+100) and step 4 (+50) never fire");
  assert.deepEqual(plan.fireBatches, [["result:1", "result:2"], ["result:3"], ["result:4"], ["result:5"]],
    "each fire asks about the whole pending eligible stream");
  assert.equal(plan.triggers, 4);
  assert.equal(plan.asks, 4);
  assert.equal(plan.carried, 0, "step 9 fires the last unit; step 10 grows only 100");
  assert.equal(plan.eligibleResults, 5);
  assert.equal(plan.bytesFreedByPolicy, 0, "the stub keeps every row");
  assert.match(summaryOf(plan), /threshold 300 triggers 4 asks 4 eligible 5/);
});

test("threshold: no crossing fires nothing, and a crossing over no work holds", () => {
  const below = thresholdLane({
    timeline: timelineOf([unitOf(1, { step: 1 })]),
    depths: depthsFrom([[1, 1000], [2, 1299]]),
    threshold: 300,
  });
  assert.deepEqual(below.fireSteps, [], "1299 − 1000 = 299 < 300");
  assert.equal(below.carried, 1, "the never-asked unit is carried, never flushed");
  assert.match(summaryOf(below), /threshold 300 triggers 0 asks 0/);

  // No unit has landed when the first crossing happens: no empty ask is sent,
  // and the crossing is not lost — the first later unit fires at its own step.
  const held = thresholdLane({
    timeline: timelineOf([unitOf(1, { step: 4 })]),
    depths: depthsFrom([[1, 1000], [2, 1400], [3, 1500], [4, 1600], [5, 1700]]),
    threshold: 300,
  });
  assert.deepEqual(held.fireSteps, [5], "steps 2–4 cross with an empty pending stream");
  assert.equal(held.carried, 0);
});

test("threshold: the pending stream carries across the compaction boundary", () => {
  const timeline = { ...timelineOf([unitOf(2, { step: 2 }), unitOf(6, { step: 6 })]),
    compaction: { seq: 900, step: 5 } };
  const plan = thresholdLane({
    timeline,
    depths: depthsFrom([[1, 1000], [2, 1100], [3, 1100], [4, 1100], [5, 1100],
      [6, 1100], [7, 1100], [8, 1300]]),
    threshold: 300,
    semantics: "absolute",
  });
  assert.equal(plan.compactionStep, 5);
  assert.deepEqual(plan.fireSteps, [8], "one fire, after the boundary");
  assert.deepEqual(plan.fireBatches, [["result:2", "result:6"]],
    "the pre-boundary unit is still pending: nothing flushes at compaction");
});

test("compaction semantics: incremental and growth both reset the base, absolute does not", () => {
  // Same schedule as the absolute case: the pre-compaction base is 1000 and the
  // window leaves step 5 at 1100. Measuring from 1100, step 8 (+200) does NOT
  // fire; it fires at step 9 once +300 more has grown.
  const timeline = { ...timelineOf([unitOf(2, { step: 2 }), unitOf(6, { step: 6 }),
    unitOf(9, { step: 9 })]), compaction: { seq: 900, step: 5 } };
  const depths = depthsFrom([[1, 1000], [2, 1100], [3, 1100], [4, 1100], [5, 1100],
    [6, 1100], [7, 1100], [8, 1300], [9, 1400]]);
  assert.equal(DEFAULT_THRESHOLD_SEMANTICS, "incremental", "the owner's ruling is the default");
  const growth = thresholdLane({ timeline, depths, threshold: 300, semantics: "growth" });
  assert.equal(growth.semantics, "growth");
  assert.deepEqual(growth.fireSteps, [9], "step 8 (+200 over the reset base) holds");
  assert.deepEqual(growth.fireBatches, [["result:2", "result:6"]],
    "the pending stream still crosses the boundary; only the base moved");
  const absolute = thresholdLane({ timeline, depths, threshold: 300, semantics: "absolute" });
  assert.deepEqual(absolute.fireSteps, [8], "without the reset the same bytes fire a step early");
  const incremental = thresholdLane({ timeline, depths, threshold: 300 });
  assert.equal(incremental.semantics, "incremental");
  assert.deepEqual(incremental.fireSteps, [9], "the stub removes nothing: same reset as growth");
});

test("incremental: the owner's example — a 60k shave resets the base to 45k, next fire at 105k", () => {
  // One fire at step 2: depth 105,000 = the 45,000 base + 60,000 growth, and its
  // own forget drops 182,400 B = τ 60,000 tokens at the measured 3.04 ratio. The
  // post-removal depth is 45,000, so the next fire must wait for 105,000 again —
  // never 165,000.
  assert.equal(nextBaselineDepth({ depth: 105_000, removalBytes: 182_400 }), 45_000,
    "incremental: depth at the fire minus that fire's own τ(dropped bytes)");
  assert.equal(nextBaselineDepth({ depth: 105_000, removalBytes: 182_400, semantics: "growth" }),
    105_000, "growth keeps the pre-removal depth: the interval stretches to threshold + R");
  const units = [unitOf(1, { bytes: 182_400, step: 1 }), unitOf(2, { bytes: 4000, step: 3 })];
  const depths = depthsFrom([[1, 45_000], [2, 105_000], [3, 135_000], [4, 165_000]]);
  const plan = thresholdLane({ timeline: timelineOf(units), depths, threshold: 60_000,
    producer: FORGETALL });
  assert.equal(plan.baselineDepth, 45_000, "the first measured step's depth is the first baseline");
  assert.equal(plan.bytesFreedByPolicy, 182_273 + 3_873,
    "NET: 182,400 B and 4,000 B gross minus summary + marker at each fire");
  assert.equal(plan.bytesFreedGross, 186_400);
  assert.deepEqual(plan.fireSteps, [2, 4],
    "the shave is not free credit: 75,000 at step 3 holds, 105,000 at step 4 fires");
  assert.deepEqual(plan.fireBatches, [["result:1"], ["result:2"]]);
  assert.match(summaryOf(plan), /semantics incremental/);
  // The same schedule under the old rule waits for 165,000 of measured depth.
  const growth = thresholdLane({ timeline: timelineOf(units), depths, threshold: 60_000,
    producer: FORGETALL, semantics: "growth" });
  assert.deepEqual(growth.fireSteps, [2], "growth never re-crosses: threshold + R = 120,000");
});

test("incremental without removals is exactly the growth lane", () => {
  const units = [1, 2, 3, 4, 5].map(seq => unitOf(seq, { step: seq * 2 }));
  const depths = depthsFrom([[1, 1000], [2, 1100], [3, 1300], [4, 1350], [5, 1600],
    [6, 1700], [7, 2100], [8, 2200], [9, 2600], [10, 2700]]);
  const incremental = thresholdLane({ timeline: timelineOf(units), depths, threshold: 300 });
  const growth = thresholdLane({ timeline: timelineOf(units), depths, threshold: 300,
    semantics: "growth" });
  assert.equal(incremental.bytesFreedByPolicy, 0, "the stub keeps every row");
  for (const key of ["fireSteps", "fireBatches", "carried", "triggers", "asks",
    "baselineDepth", "bytesFreedByPolicy"]) {
    assert.deepEqual(incremental[key], growth[key], `${key} is untouched when R = 0`);
  }
});

test("incremental: a crossing over an empty pending stream still holds", () => {
  const held = thresholdLane({
    timeline: timelineOf([unitOf(1, { step: 4 })]),
    depths: depthsFrom([[1, 1000], [2, 1400], [3, 1500], [4, 1600], [5, 1700]]),
    threshold: 300,
  });
  assert.deepEqual(held.fireSteps, [5], "steps 2–4 cross with an empty pending stream");
  assert.equal(held.carried, 0);
});

test("first-fire depth: no fire before the floor, the crossing fires, then the lane threshold", () => {
  // The 20k lane would fire at step 2 (+21,000 over the step-1 base) but the
  // first-fire floor is 40,000. Step 3 reaches 40,000 and fires. The stub keeps
  // every row, so the post-fire baseline is 40,000 and step 4 (+10,000) holds;
  // step 5 (+20,000) fires on the lane threshold, not on the floor again.
  const units = [unitOf(1, { step: 1 }), unitOf(2, { step: 2 }), unitOf(3, { step: 4 })];
  const depths = depthsFrom([[1, 10_000], [2, 31_000], [3, 40_000], [4, 50_000], [5, 60_000]]);
  const gated = thresholdLane({ timeline: timelineOf(units), depths, threshold: 20_000,
    firstFireDepth: 40_000 });
  assert.equal(gated.firstFireDepth, 40_000, "the plan records the floor");
  assert.deepEqual(gated.fireSteps, [3, 5],
    "step 2 is held below the floor; step 4 is held inside the 20k window");
  assert.deepEqual(gated.fireBatches, [["result:1", "result:2"], ["result:3"]],
    "the first fire still asks the whole pending stream");
  assert.equal(gated.baselineDepth, 10_000, "the first measured depth is still the base");
  assert.match(summaryOf(gated), /threshold 20000 triggers 2 asks 2 .* first-fire 40000/);

  // Unset (and an explicit null) is today's cadence, object for object.
  const unset = thresholdLane({ timeline: timelineOf(units), depths, threshold: 20_000 });
  const explicit = thresholdLane({ timeline: timelineOf(units), depths, threshold: 20_000,
    firstFireDepth: null });
  assert.deepEqual(explicit, unset, "no flag and a null flag are the same lane");
  assert.equal(unset.firstFireDepth, null);
  assert.deepEqual(unset.fireSteps, [2, 5], "without the floor step 2 fires");
  assert.ok(!summaryOf(unset).includes("first-fire"), "the summary line is unchanged when unset");

  // The verdict itself: the floor replaces the delta test while it is passed.
  assert.deepEqual(thresholdVerdict({ depth: 31_000, lastFireDepth: 10_000, threshold: 20_000,
    pending: 1, firstFireDepth: 40_000 }), { kind: "hold", delta: 21_000 });
  assert.deepEqual(thresholdVerdict({ depth: 40_000, lastFireDepth: 10_000, threshold: 20_000,
    pending: 1, firstFireDepth: 40_000 }), { kind: "fire", delta: 30_000 });
});

test("first-fire depth: a non-positive value, batch mode and a byte lane refuse by name", t => {
  if (!requirePinnedWorld(t)) return;
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => assertFirstFireDepth(bad), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-first-fire-depth-invalid");
  }
  assert.equal(assertFirstFireDepth(undefined), null, "unset stays unset");
  assert.equal(assertFirstFireDepth(40_000), 40_000);
  assert.throws(() => assertFirstFireDepth(40_000, { mode: "batch" }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-first-fire-depth-batch");
  assert.throws(() => assertFirstFireDepth(40_000, { thresholdUnits: "landed-bytes" }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-first-fire-depth-units");
  const timeline = timelineOf([unitOf(1, { step: 1 })]);
  assert.throws(() => thresholdLane({ timeline, depths: depthsFrom([[1, 10_000], [2, 60_000]]),
    threshold: 20_000, firstFireDepth: 0 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-first-fire-depth-invalid");
  const batch = spawnSync(process.execPath, [SCRIPT, "--mode", "batch", "--segment", "139",
    "--first-fire-depth", "40000"], { encoding: "utf8" });
  assert.equal(batch.status, 2);
  assert.match(batch.stderr, /sim-batch-first-fire-depth-batch/);
  const invalid = spawnSync(process.execPath, [SCRIPT, "--mode", "threshold", "--segment", "139",
    "--first-fire-depth", "0"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /sim-batch-first-fire-depth-invalid/);
});

test("landed-bytes: fires on accumulated landed bytes while the depth never grows", () => {
  // Every unit is 1,000 B; the measured depth is flat, so a depth lane fires 0.
  const units = [1, 2, 3, 4, 5].map(seq => unitOf(seq, { bytes: 1000, step: seq }));
  const plan = thresholdLane({
    timeline: timelineOf(units),
    depths: depthsOf([1, 2, 3, 4, 5, 6, 7], 1000),
    threshold: 2500,
    thresholdUnits: "landed-bytes",
    floor: 1000,
  });
  assert.equal(plan.thresholdUnits, "landed-bytes");
  // The product checks its trigger as each result LANDS (`entryTriggerFor`),
  // so unit 3's landing on step 3 fires on step 3 — not a step late.
  assert.deepEqual(plan.fireSteps, [3], "3,000 B lands ON step 3 and crosses 2,500 there");
  assert.deepEqual(plan.fireBatches, [["result:1", "result:2", "result:3"]]);
  assert.equal(plan.carried, 2, "the last two units never reach the threshold; carried");
  assert.equal(plan.triggers, 1);
  assert.match(summaryOf(plan), /threshold 2500 B landed triggers 1 asks 1/);
});

test("landed-bytes: a result landing on step S can fire at S, the product's landing cadence", () => {
  // Twelfth audit item 3. `entryTriggerFor` runs inside the step AFTER the
  // result lands, so a landing that crosses the threshold fires on its OWN
  // step. The plan used to add only units with `step < entry.step`, which made
  // every landed result invisible until the next measured step.
  const units = [unitOf(1, { bytes: 3000, step: 3 })];
  const plan = thresholdLane({ timeline: timelineOf(units),
    depths: depthsOf([1, 2, 3, 4], 1000), threshold: 3000, thresholdUnits: "landed-bytes" });
  assert.deepEqual(plan.fireSteps, [3],
    "the only unit lands on step 3 and the fire is step 3, never step 4");
  assert.deepEqual(plan.fireBatches, [["result:1"]]);
  assert.equal(plan.carried, 0);
  // The same unit one byte under the threshold holds, and is carried: the
  // trigger really is the bytes, not the landing alone.
  const under = thresholdLane({ timeline: timelineOf([unitOf(1, { bytes: 2999, step: 3 })]),
    depths: depthsOf([1, 2, 3, 4], 1000), threshold: 3000, thresholdUnits: "landed-bytes" });
  assert.deepEqual(under.fireSteps, []);
  assert.equal(under.carried, 1);
});

test("landed-bytes: below the threshold fires nothing; a crossing over no work holds", () => {
  const below = thresholdLane({
    timeline: timelineOf([unitOf(1, { step: 1 }), unitOf(2, { step: 2 })]),
    depths: depthsOf([1, 2, 3, 4], 1000),
    threshold: 5000,
    thresholdUnits: "landed-bytes",
  });
  assert.deepEqual(below.fireSteps, [], "2,000 B landed < 5,000");
  assert.equal(below.carried, 2);
  // The same hold rule as depth: no rows, no send, no checkpoint move.
  assert.deepEqual(landedBytesVerdict({ landedBytes: 300, threshold: 300, pending: 0 }),
    { kind: "hold", landedBytes: 300 });
  assert.deepEqual(landedBytesVerdict({ landedBytes: 300, threshold: 300, pending: 1 }),
    { kind: "fire", landedBytes: 300 });
  assert.throws(() => landedBytesVerdict({ landedBytes: -1, threshold: 300 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-threshold-invalid");
});

test("landed-bytes: a host-pruned unit leaves the ask stream, and the accumulator follows it", () => {
  // Big enough bodies that a forgetall producer or a host prune would move a
  // depth lane far; the byte lane must not notice the REMOVALS it books. A host
  // prune is different: the pruned original is not on the surface, so it is not
  // askable and its bytes never land in the accumulator. Its replacement's bytes
  // land at the replacement's own entry step instead.
  const units = [1, 2, 3, 4, 5].map(seq => unitOf(seq, { bytes: 2000, step: seq }));
  const depths = depthsFrom([[1, 10_000], [2, 10_000], [3, 10_000], [4, 10_000],
    [5, 10_000], [6, 10_000], [7, 10_000]]);
  const keep = thresholdLane({ timeline: timelineOf(units), depths, threshold: 8000,
    thresholdUnits: "landed-bytes" });
  const forget = thresholdLane({ timeline: timelineOf(units), depths, threshold: 8000,
    thresholdUnits: "landed-bytes", producer: FORGETALL });
  const prunedTimeline = timelineOf(units, {
    hostPrunes: [{ seq: 900, step: 2, seqs: [1], tokens: 250 }],
  });
  const pruned = thresholdLane({ timeline: prunedTimeline, depths, threshold: 8000,
    thresholdUnits: "landed-bytes", producer: FORGETALL });
  assert.deepEqual(forget.fireSteps, keep.fireSteps,
    "a policy's own removals never move the byte clock");
  assert.deepEqual(forget.fireBatches, keep.fireBatches);
  assert.equal(pruned.askableResults, 5,
    "every unit was on the surface at its own landing step, including the one pruned later");
  assert.equal(pruned.hostPrunedEligible, 1);
  assert.equal(pruned.askableBeforePrune, 1, "the pruned unit was askable before the prune");
  assert.equal(pruned.hostPrunedBeforeLanding, 0);
  assert.equal(pruned.prunedBeforeAsk, 1,
    "unit 1 leaves the pending stream before any fire tables it");
  assert.deepEqual(pruned.fireSteps, [5],
    "the pruned unit's bytes leave the accumulator, so the lane crosses one step later");
  assert.equal(keep.bytesFreedByPolicy, 0);
  assert.ok(forget.bytesFreedByPolicy > 0, "the answers do free bytes, just not the trigger");
  // The pruned unit is dropped at its prune's step, BEFORE the first fire (which
  // now sits at step 4, after the prune at 2), so the pruned lane never asks it —
  // the accumulator loses its 2,000 B and crosses one landing later. The bodies
  // are identical, so the TOTALS match; the unit IDs say which rows were asked,
  // and that is the fact under test.
  assert.deepEqual(pruned.removalBookings.map(row => row.unitId).sort(),
    ["result:2", "result:3", "result:4", "result:5"],
    "the pruned lane's fire asks units 2, 3, 4 and 5 in one batch");
  assert.ok(!pruned.removalBookings.some(row => row.unitId === "result:1"),
    "the unit the host pruned before the fire is never asked or credited");
  assert.ok(forget.removalBookings.some(row => row.unitId === "result:1"),
    "the un-pruned lane does ask it");
});

test("a shape that stood before a later host prune is credited, and its window ends at the prune", () => {
  const units = [unitOf(1, { step: 1 }), unitOf(2, { step: 10 })];
  const depths = depthsFrom([[1, 1000], [2, 1000], [3, 3000], [4, 3000], [5, 3000],
    [6, 3000], [7, 3000]]);
  const later = timelineOf(units,
    { hostPrunes: [{ seq: 90, step: 6, seqs: [1], tokens: 500 }] });
  const plan = thresholdLane({ timeline: later, depths, threshold: 1500, floor: 100,
    producer: FORGETALL });
  assert.deepEqual(plan.fireSteps, [3], "the fire at the crossing asks the unit");
  const shaped = plan.removalBookings.find(row => row.unitId === "result:1");
  assert.ok(shaped !== undefined && shaped.bytes > 0, "the policy shaped it");
  assert.equal(plan.bytesFreedByPolicy, shaped.bytes,
    "the shape booked at 3 stood until the host's prune at 6, so it is credited");
  const byStep = new Map(plan.series.map(point => [point.step, point]));
  assert.equal(byStep.get(3).removed, 0, "a removal booked at 3 is visible only from 4");
  assert.equal(byStep.get(4).removed, shaped.bytes, "inside the window the delta is subtracted");
  assert.equal(byStep.get(5).removed, shaped.bytes);
  assert.equal(byStep.get(6).removed, 0,
    "the host prune at 6 removes the body anyway, so the policy's delta stops counting");
  assert.equal(byStep.get(7).removed, 0);
  // P6 (eleventh audit): a prune owned by the fire's own step is applied AFTER
  // that step's ask, so the row IS tabled and answered at step 3 — and the
  // shape lands on the same step the prune owns, so its window is empty and it
  // is credited nothing. Before the strict predicate the row was dropped from
  // the table and the host's answer was never even asked for.
  const same = timelineOf(units,
    { hostPrunes: [{ seq: 91, step: 3, seqs: [1], tokens: 500 }] });
  const denied = thresholdLane({ timeline: same, depths, threshold: 1500, floor: 100,
    producer: FORGETALL });
  assert.equal(denied.triggers, 1, "the row is tabled at the prune's own step");
  assert.equal(denied.asks, 1);
  assert.deepEqual(denied.removalBookings, [],
    "the shaped turn stands for no step, so it is booked nothing");
  assert.equal(denied.bytesFreedByPolicy, 0, "and freed nothing");
});

test("landed-bytes is opt-in: the default depth lane is unchanged", () => {
  const units = [unitOf(1, { step: 1 }), unitOf(2, { step: 3 }), unitOf(3, { step: 5 })];
  const depths = depthsFrom([[1, 1000], [2, 1300], [3, 1400], [4, 1700], [5, 1800], [6, 1800]]);
  const implicit = thresholdLane({ timeline: timelineOf(units), depths, threshold: 300 });
  const explicit = thresholdLane({ timeline: timelineOf(units), depths, threshold: 300,
    thresholdUnits: "depth-tokens" });
  assert.deepEqual(implicit, explicit, "no flag is byte-for-byte today's lane");
  assert.equal(implicit.thresholdUnits, "depth-tokens");
  assert.deepEqual(implicit.fireSteps, [2, 4], "the pre-existing crossings");
  assert.equal(thresholdLaneName(60_000), "threshold-60000");
  assert.equal(thresholdLaneName(240_000, "landed-bytes"), "bytes-240k");
  assert.equal(thresholdLaneName(1500, "landed-bytes"), "bytes-1500");
  assert.throws(() => thresholdLane({ timeline: timelineOf(units), depths, threshold: 300,
    thresholdUnits: "bytes" }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-threshold-units-invalid");
});

test("landed-bytes on pair-2 segment 146: the bytes-240k Gate A pins", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  const plan = thresholdLane({ timeline, depths, threshold: 240_000,
    thresholdUnits: "landed-bytes" });
  // The replacement rows enter at their OWN step (a replacement's cadence step
  // is its entry, never its original's stale `data.step`), and the ask stream is
  // P6 (eleventh audit) made the predicate strict: a unit whose prune is owned
  // by its OWN landing step is tabled at that step (the ask runs before the
  // prune), so all 266 eligible units reach the surface and none is "never
  // askable". Twelfth audit item 3: the trigger now runs per LANDING, so each
  // fire is one step earlier than the old strict-before schedule and the batch
  // sizes move with it.
  assert.equal(plan.eligibleResults, 266, "the eligible population is unchanged");
  assert.equal(plan.askableResults, 266, "90 pruned, all of them askable before the prune");
  assert.equal(plan.hostPrunedEligible, 90);
  assert.equal(plan.askableBeforePrune, 90);
  assert.equal(plan.hostPrunedBeforeLanding, 0);
  assert.equal(plan.prunedBeforeAsk, 16,
    "16 askable units left the surface before any fire tabled them; they are carried");
  assert.equal(plan.triggers, 8, "eight fires over the pinned segment");
  assert.deepEqual(plan.fireSteps, [26, 38, 50, 84, 87, 100, 103, 122]);
  assert.deepEqual(plan.fireBatches.map(batch => batch.length),
    [33, 30, 23, 37, 38, 16, 18, 23], "the per-fire pending sizes");
  assert.equal(plan.carried, 48,
    "32 units land after the last fire + 16 pruned before any fire: all never asked");
});

test("Gate A pins are unchanged under incremental: the keepall stub removes nothing", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const depths = depthsInSegment(readUsage(PAIR2_USAGE), 146);
  // The Gate A depth lanes as the report plans them: keepall, floor 512. The
  // fire steps are unchanged; the ask stream is TIME-AWARE, so the tail counts
  // the units that reach the surface (a later-pruned original is askable before
  // its prune, and a replacement enters at its own step). P6 (eleventh audit):
  // a fire landing on a prune's own step now tables the rows that prune names,
  // so the tail shrank at 30,000 and grew at 60,000 by what those fires absorb.
  const pins = new Map([
    [30_000, { triggers: 9, fireSteps: [11, 25, 29, 34, 39, 45, 50, 55, 70], carried: 166 }],
    [60_000, { triggers: 5, fireSteps: [24, 33, 43, 51, 123], carried: 70 }],
  ]);
  for (const [threshold, pin] of pins) {
    const incremental = thresholdLane({ timeline, depths, threshold });
    assert.equal(incremental.semantics, "incremental");
    assert.equal(incremental.bytesFreedByPolicy, 0, "no removal, so no baseline moves");
    assert.equal(incremental.triggers, pin.triggers, `threshold ${threshold} fires`);
    assert.deepEqual(incremental.fireSteps, pin.fireSteps, `threshold ${threshold} fire steps`);
    assert.equal(incremental.carried, pin.carried, `threshold ${threshold} carried`);
    const growth = thresholdLane({ timeline, depths, threshold, semantics: "growth" });
    assert.deepEqual(incremental.fireBatches, growth.fireBatches, "R = 0: the lanes are identical");
  }
});

test("clampDecisionStep never books a live answer before its fire", () => {
  assert.equal(clampDecisionStep(31, 50), 50, "a unit from step 30 answered at 50 lands at 50");
  assert.equal(clampDecisionStep(51, 50), 51, "an answer already after the fire keeps its step");
  assert.throws(() => clampDecisionStep(Number.NaN, 50), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-step-invalid");
});

test("the depth series clamps at zero and flags an overflow", () => {
  // One 8,000 B removal (τ → 2,000 tokens) against a 1,000 token window.
  const plan = planLane({
    timeline: timelineOf([unitOf(1, { bytes: 8000, step: 1 })], {}),
    depths: depthsFrom([[1, 1000], [2, 1000], [3, 1000]]),
    lane: 1, floor: 100, producer: FORGETALL,
  });
  assert.equal(plan.bytesFreedByPolicy, 7873, "8,000 B gross minus summary + marker");
  assert.equal(plan.bytesFreedGross, 8000);
  assert.equal(plan.depthOverflow, true);
  assert.ok(plan.series.every(point => point.depth >= 0), "no negative window is reported");
  const byStep = new Map(plan.series.map(point => [point.step, point]));
  assert.equal(byStep.get(2).depth, 1000, "the fallback books the removal at step 2, not before");
  assert.equal(byStep.get(3).depth, 0, "1000 − τ(8000) clamps to 0");
});

test("a trim can be gross-positive and net-NEGATIVE: summary + marker cost more than the body", () => {
  // A 120-byte body with a 37-byte summary field and a 121-byte marker line: the
  // gross drop is 120, the shaped turn is 158 bytes, so the context GREW by 38
  // bytes. `bytesFreedByPolicy` must say so; `bytesFreedGross` stays positive.
  const unit = unitOf(1, { bytes: 120, step: 1 });
  const bigSummary = { name: "big-summary",
    decide: ({ unit: target }) => ({ momentId: target.id, action: "forgetall",
      summary: "a stale build log from the old host" }) };
  const plan = planLane({
    timeline: timelineOf([unit]),
    depths: depthsOf([1, 2, 3], 1000),
    lane: 1, floor: 1, producer: bigSummary,
  });
  assert.equal(plan.bytesFreedGross, 120, "gross is positive");
  assert.ok(plan.bytesFreedByPolicy < 0,
    `net is negative, got ${String(plan.bytesFreedByPolicy)} (summary + marker exceed the body)`);
  assert.equal(plan.bytesFreedGross - plan.bytesFreedByPolicy, 158,
    "gross − net is the shaped turn's own 158 B (37 summary + 121 marker)");
  assert.equal(-plan.bytesFreedByPolicy, 38,
    "the context grew by 38 B: the shaped turn is 158 B against a 120 B body");
  const point = plan.series.find(entry => entry.step === 3);
  assert.equal(point.removed, plan.bytesFreedByPolicy, "the depth series subtracts NET");
  assert.ok(point.depth > 1000, "a net-negative trim ADDS depth, so the window starts higher");
});

test("a pruner-off plan records removal bytes BESIDE its netted depth", () => {
  const units = [unitOf(1, { step: 1 }), unitOf(2, { step: 3 })];
  const timeline = { ...timelineOf(units), ignoreHostPrunes: true };
  const plan = planLane({ timeline, depths: depthsOf([1, 2, 3, 4, 5], 1000), lane: 1, floor: 1,
    producer: FORGETALL, depthSource: SURFACE_DEPTH_SOURCE });
  assert.ok(plan.bytesFreedByPolicy > 0, "the policy freed bytes");
  const last = plan.series[plan.series.length - 1];
  assert.equal(last.removed, plan.bytesFreedByPolicy,
    "the baked-in removal bytes are recorded, never 0");
  assert.equal(last.removedInDepth, true,
    "the flag says the removal is already inside the netted depth");
  assert.ok(plan.series.every(point => point.depth === point.measured),
    "the surface depth is net by construction, so nothing subtracts `removed` twice");
  assert.ok(plan.series.some(point => point.removed === 0),
    "before the first shaped turn nothing has been baked in");
});

test("a bad threshold and a bad mode are refused by name", () => {
  const timeline = timelineOf([unitOf(1)]);
  assert.throws(() => thresholdLane({ timeline, depths: depthsOf([1], 1), threshold: 0 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-threshold-invalid");
  assert.throws(() => thresholdLane({ timeline, depths: [], threshold: 300 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-depth-absent");
  const result = spawnSync(process.execPath, [SCRIPT, "--mode", "nope"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-mode-invalid/);
});

test("--plan threshold lanes 30000,60000,120000 on the real transcript", t => {
  if (!requirePinnedWorld(t)) return;
  const result = spawnSync(process.execPath, [SCRIPT, "--plan", "--mode", "threshold",
    "--segment", "139", "--thresholds", "30000,60000,120000", "--producer", "stub",
    "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  const start = lines.findIndex(line => line === "[" || line.startsWith("[{") || line.startsWith("{"));
  assert.ok(start > 0, "three summaries print before the JSON");
  assert.equal(lines.slice(0, start).filter(line => line.startsWith("sim-batch-units")).length, 3,
    "one summary line per threshold lane");
  const plans = JSON.parse(lines.slice(start).join("\n"));
  assert.deepEqual(plans.map(plan => plan.threshold), [30_000, 60_000, 120_000]);
  assert.ok(plans.every(plan => plan.mode === "threshold" && plan.eligibleResults === 268));
  assert.ok(plans.every(plan => plan.bytesFreedByPolicy === 0));
  assert.deepEqual(plans.map(plan => plan.triggers), [9, 4, 2],
    "a larger threshold asks less often");
  assert.ok(plans[0].depthSeries.first === 9154, "the step-1 measured depth is the baseline");
});

test("a plan over zero eligible units refuses by name, never a normal summary", () => {
  const timeline = timelineOf([unitOf(1)]);
  const depths = depthsOf([1], 1000);
  for (const run of [
    () => planLane({ timeline, depths, lane: 1, floor: 5000 }),
    () => thresholdLane({ timeline, depths, threshold: 300, floor: 5000 }),
  ]) {
    assert.throws(run, error => error instanceof SimBatchUnitsRefusal
      && error.code === "sim-batch-eligible-empty" && /no eligible unit at floor/.test(error.message));
  }
});

test("a bad floor, lane and usage row are refused by name", () => {
  const timeline = timelineOf([unitOf(1)]);
  assert.throws(() => eligibleOf(timeline, -1), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-floor-invalid");
  assert.throws(() => planLane({ timeline, depths: depthsOf([1], 1), lane: 0 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-lane-invalid");
  assert.throws(() => readUsage({ rows: [{ step: 1 }] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-invalid");
  // A duplicate step would silently overwrite the depth; it refuses instead.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 10, cacheReadTokens: 0 },
    { step: 1, inputTokens: 20, cacheReadTokens: 0 },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-duplicate");
  // inputTokens ALREADY containing the cache count would double-count the depth.
  // The row STATES the additive shape so the total guard is what refuses it.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 100, cacheReadTokens: 900, outputTokens: 10, totalTokens: 110,
      inputTokensIncludeCache: false },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-cache-included");
  // A cache-bearing row with NO total cannot say which shape it is: it used to
  // be read as input + cache (14,000 for the row below) and is refused now.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10,
      inputTokensIncludeCache: false },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-total-absent"
    && /cannot be checked against its own shape/.test(error.message));
  // The explicit folded shape is accepted and does not double-count.
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10,
      totalTokens: 5010, inputTokensIncludeCache: true },
  ] }), [{ step: 1, tokens: 5000, shapeBasis: "totals" }]);
  // A folded row whose total contradicts it refuses too.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10,
      totalTokens: 14010, inputTokensIncludeCache: true },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-total-mismatch");
  // The field meanings are the real pair's: input is UNCACHED, cache is
  // additive. The row must STATE the shape (P8): `inputTokensIncludeCache:
  // false` or the provider's own prompt count; total arithmetic is not a
  // statement. The real result.json rows carry `billedTokens` = input + cache.
  assert.deepEqual(readUsage({ rows: [
    { step: 2, inputTokens: 502, cacheReadTokens: 9088, outputTokens: 121, totalTokens: 9711,
      billedTokens: 9590 },
  ] }), [{ step: 2, tokens: 9590, shapeBasis: "prompt-count" }]);
  // A cache-bearing row with NO outputTokens cannot prove the additive shape:
  // it used to be read as input + cache with no field saying the cache was not
  // already inside input. The folded shape must be STATED to be read folded.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, totalTokens: 14000,
      inputTokensIncludeCache: false },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-output-absent"
    && /cannot be checked against either total shape/.test(error.message));
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, totalTokens: 5000,
      inputTokensIncludeCache: true },
  ] }), [{ step: 1, tokens: 5000, shapeBasis: "statement" }],
  "a stated folded row with no outputTokens reads as its input count, and its"
  + " uncorroborated shape is recorded as such");
  // A total that is neither input + output nor input + cache + output states no
  // shape at all; it used to be read as additive anyway.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 12000,
      inputTokensIncludeCache: false },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-total-unexplained"
    && /is neither/.test(error.message));
  // P8: total arithmetic ALONE states no shape. A row whose total happens to be
  // additive is not proof that inputTokens excluded the cache — the same totals
  // fit a folded input with the cache added a second time, which inflated the
  // depth by exactly the cache count.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 14010 },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-cache-shape-unstated"
    && /inputTokensIncludeCache|prompt count/.test(error.message));
  // A stated prompt count that agrees with neither shape refuses by name.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 14010,
      promptTokens: 12000 },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-prompt-mismatch");
  // The provider's own prompt count STATES the shape: equal to input + cache is
  // additive, equal to input alone is folded, and each reads its own depth.
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 14010,
      prompt_tokens: 14000 },
  ] }), [{ step: 1, tokens: 14_000, shapeBasis: "prompt-count" }]);
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 5010,
      billedTokens: 5000 },
  ] }), [{ step: 1, tokens: 5000, shapeBasis: "prompt-count" }],
  "a folded row proved by its prompt count");
  // A flag that contradicts the row's own prompt count refuses.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 5000, cacheReadTokens: 9000, outputTokens: 10, totalTokens: 14010,
      inputTokensIncludeCache: false, billedTokens: 5000 },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-prompt-mismatch");
  // A zero-cache row needs no total: there is no cache to place.
  assert.deepEqual(readUsage({ rows: [{ step: 1, inputTokens: 100, cacheReadTokens: 0 }] }),
    [{ step: 1, tokens: 100, shapeBasis: "no-cache" }]);
  // P5: a zero-cache row WITH a prompt count is still validated. The whole
  // stated-shape block used to sit inside `if (cacheRead > 0)`, so this row
  // passed with depth 502 while its own prompt count said 9,590.
  assert.throws(() => readUsage({ rows: [
    { step: 1, inputTokens: 502, prompt_tokens: 9590, cacheReadTokens: 0 },
  ] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-usage-prompt-mismatch"
    && /reports no cache/.test(error.message)
    && /must equal inputTokens 502/.test(error.message));
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 502, prompt_tokens: 502, cacheReadTokens: 0 },
  ] }), [{ step: 1, tokens: 502, shapeBasis: "no-cache" }],
  "a zero-cache row whose prompt count agrees passes");
});

test("a PRESENT but invalid prompt count refuses; it is never read as absent", () => {
  // Twelfth audit item 8: a negative or string count fell through the
  // `Number.isSafeInteger` chain to `null`, so the row passed as if it had
  // stated nothing. Each name is checked on its own.
  for (const [name, value] of [["promptTokens", -3], ["prompt_tokens", "9_590"],
    ["billedTokens", 1.5], ["promptTokens", Number.MAX_SAFE_INTEGER + 2]]) {
    assert.throws(() => readUsage({ rows: [
      { step: 1, inputTokens: 100, cacheReadTokens: 0, [name]: value },
    ] }), error => error instanceof SimBatchUnitsRefusal
      && error.code === "sim-batch-usage-invalid"
      && error.message.includes(name),
    `${name} ${JSON.stringify(value)} is present and invalid`);
  }
  // Absent (or null) stays absent and is not refused on this rule; a valid zero
  // is a present count, not an absent one.
  assert.deepEqual(readUsage({ rows: [{ step: 1, inputTokens: 0, cacheReadTokens: 0 }] }),
    [{ step: 1, tokens: 0, shapeBasis: "no-cache" }]);
  assert.deepEqual(readUsage({ rows: [
    { step: 1, inputTokens: 0, cacheReadTokens: 0, promptTokens: 0 },
  ] }), [{ step: 1, tokens: 0, shapeBasis: "no-cache" }]);
});

test("usage: result.json's usage.rows and a bare {rows} read the same depth", t => {
  if (!requirePinnedWorld(t)) return;
  const depths = readUsage(DEFAULT_USAGE);
  assert.equal(depths.length, 332, "332 per-step rows");
  assert.equal(depths[0].step, 1);
  assert.equal(depths[depths.length - 1].step, 332);
  assert.ok(depths.every(entry => entry.tokens > 0));
  // The known pair: result.json's step-2 row is input 502 + cacheRead 9,088 =
  // 9,590 (output 121, total 9,711). If inputTokens included the cache, the
  // total would be 623, not 9,711, so input is UNCACHED and the sum is right.
  assert.equal(depths.find(entry => entry.step === 2).tokens, 9590);
});

test("--segment 139: the measured decomposition, the cut, and a compaction crossing", t => {
  if (!requirePinnedWorld(t)) return;
  const timeline = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
  assert.equal(timeline.segment, 139);
  assert.equal(timeline.firstExcludedStep, 140, "the compaction row's owning step is excluded");
  assert.equal(timeline.compaction, null, "no compaction boundary survives the cut");
  assert.equal(timeline.units.length, 299, "299 in-segment tool/results, append and replace");
  const eligible = eligibleOf(timeline, 512);
  assert.equal(eligible.length, 268, "the pinned eligible count at the 512 floor");
  assert.equal(eligible.filter(unit => unit.surfaceOp === "append").length, 201);
  assert.equal(eligible.filter(unit => unit.surfaceOp === "replace").length, 67);
  assert.equal(timeline.hostPrunes.length, 67, "67 in-segment prune journals");
  assert.equal(timeline.hostRemoved.size, 67, "67 distinct shadowed originals");
  // A segment that includes the compaction refuses by name.
  for (const crossing of [140, 141]) {
    assert.throws(() => readTimeline(DEFAULT_TRANSCRIPT, { segment: crossing }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-segment-compaction");
  }
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  const pins = assertSegmentPins(timeline, depths, { input: inputPinsOf() });
  assert.equal(pins.eligible, SEGMENT_PINS.eligible);
  assert.equal(pins.neverPruned, SEGMENT_PINS.neverPruned);
  assert.equal(pins.peakDepth, SEGMENT_PINS.peakDepth);
  assert.equal(pins.peakStep, SEGMENT_PINS.peakStep);
  assert.equal(pins.headerTools, 19);
  assert.equal(pins.headerToolBytes, 13_290);
  assert.equal(pins.reasoningBlocks, 86, "ADR-0045's turn pin");
  assert.equal(pins.reasoningBytes, 155_545, "ADR-0045's byte pin");
  assert.equal(pins.reasoningTurns, 86, "every turn that carries reasoning is resendable");
  assert.equal(pins.reasoningParts, 93, "type:reasoning CONTENT parts, counted structurally");
  assert.equal(pins.reasoningStreamBlocks, 93, "blockType:reasoning stream entries");
  assert.equal(pins.appends + pins.replacements, pins.eligible, "201 + 67 = 268");
  assert.equal(pins.neverPruned + pins.prunedOriginals, pins.appends, "134 + 67 = 201");
});

test("a pinned-world claim on an edited input refuses: both file hashes are pins", t => {
  if (!requirePinnedWorld(t)) return;
  const timeline = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  const pins = inputPinsOf();
  assert.equal(pins.transcriptSha256, SEGMENT_PINS.transcriptSha256);
  assert.equal(pins.usageSha256, SEGMENT_PINS.usageSha256);
  assert.doesNotThrow(() => assertSegmentPins(timeline, depths, { input: pins }));
  // An edited transcript of the same length moves its hash and nothing else the
  // run would check; the pin refuses it. When the timeline was read from a file,
  // a stated hash that is not that file's own refuses even earlier.
  assert.throws(() => assertSegmentPins(timeline, depths, { input: { ...pins,
    transcriptSha256: "0".repeat(64) } }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-mismatch"
    && /is not the hash of the file that was read/.test(error.message));
  // A ROW ARRAY carries no file hash, so a pinned claim on one refuses by name
  // even when the caller states the pinned pair: rows from one file plus the
  // hash of another would otherwise pass.
  const rows = readTranscript(DEFAULT_TRANSCRIPT);
  assert.throws(() => assertSegmentPins(readTimeline(rows, { segment: 139 }), depths,
    { input: pins }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-rows-unpinned"
    && /row array/.test(error.message) && /transcript PATH/.test(error.message));
  // The usage file is the other half: an edited depth file's hash is not the
  // stated one, and the stated one is not the file's own (P2, every segment).
  assert.throws(() => assertSegmentPins(timeline, depths, { input: { ...pins,
    usageSha256: "0".repeat(64) } }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-mismatch"
    && /is not the hash of/.test(error.message));
  // A stated usage hash with no file to hash is not a claim.
  assert.throws(() => assertSegmentPins(timeline, depths,
    { input: { transcriptSha256: pins.transcriptSha256,
      usageSha256: pins.usageSha256 } }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-usage-unpinned"
    && /usageFile/.test(error.message));
  // A claim that names no usage file at all refuses by name, not by a default.
  assert.throws(() => assertSegmentPins(timeline, depths), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-absent"
    && /names none/.test(error.message));
  // A pinned-world claim with an EMPTY depth series used to skip the peak pins
  // and pass; the peak is a pin, so no ruler refuses by name.
  assert.throws(() => assertSegmentPins(timeline, [], { input: pins }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-depth-absent"
    && /empty depth series/.test(error.message));
});

test("the transcript pin is the hash of the bytes replayed, never a stated pair", t => {
  if (!requirePinnedWorld(t)) return;
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  const pins = inputPinsOf();
  const rows = readTranscript(DEFAULT_TRANSCRIPT);
  // A file holding the SAME rows is still a different file when one byte moves;
  // its hash is what the pin names.
  const dir = mkdtempSync(path.join(tmpdir(), "sim-units-pin-"));
  try {
    const other = path.join(dir, "session.v4.jsonl");
    writeFileSync(other, `${JSON.stringify({ type: "session", id: "edited-copy" })}\n`
      + rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const otherHash = fileSha256Of(other);
    assert.notEqual(otherHash, pins.transcriptSha256, "the copy's hash is its own");
    // Rows read from the default file, the hash of the copy: a row array carries
    // no hash, so the claim refuses instead of trusting the stated pair.
    assert.throws(() => assertSegmentPins(readTimeline(rows, { segment: 139 }), depths,
      { input: { ...pins, transcriptSha256: otherHash } }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-rows-unpinned");
    // A ROW ARRAY timeline carries no hash at all; a PATH's timeline carries the
    // hash the reader computed from that file's bytes.
    assert.equal(readTimeline(rows, { segment: 139 }).transcriptSha256, null);
    const fromCopy = readTimeline(other, { segment: 139 });
    assert.equal(fromCopy.transcriptSha256, otherHash,
      "readTimeline hashed the path it read, not a caller's claim");
    // The same stated pair read from the copy refuses: the pin compares the
    // replay's own bytes to SEGMENT_PINS.
    assert.throws(() => assertSegmentPins(fromCopy, depths,
      { input: { ...pins, transcriptSha256: otherHash } }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pin"
      && new RegExp(`transcript sha256 is ${otherHash}`).test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reasoning gate refuses a 0-block transcript that still stores reasoning parts", t => {
  if (!requirePinnedWorld(t)) return;
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  // The same transcript with every reasoning part stripped: the unit counts do
  // not move, so only ADR-0045's pin can catch it. This is ISSUE-195's defect.
  const stripped = readTranscript(DEFAULT_TRANSCRIPT).map(row => {
    const content = row.data?.message?.content;
    if (row.type !== "assistant/message" || !Array.isArray(content)) return row;
    const kept = content.filter(part => part.type !== "reasoning");
    const blocks = row.data?.message?.source?.replayState?.blocks;
    return {
      ...row,
      data: { ...row.data, message: { ...row.data.message, content: kept,
        source: blocks === undefined ? row.data.message.source
          : { ...row.data.message.source, replayState: { ...row.data.message.source.replayState,
            blocks: Array.isArray(blocks) ? blocks.filter(block => block.type !== "reasoning") : blocks } } } },
    };
  });
  const timeline = readTimeline(stripped, { segment: 139 });
  assert.equal(timeline.reasoningBlocks, 0);
  assert.equal(timeline.reasoningBytes, 0);
  // The stored parts survive the strip only as the record's own stream entries
  // (the content parts are gone, the stream blocks are not): reasoning was
  // there, none of it is resendable, and `--allow-zero-reasoning` cannot excuse
  // a LOST transcript.
  assert.equal(timeline.reasoningParts, 0, "the content parts were stripped");
  assert.ok(timeline.reasoningStreamBlocks > 0, "the stream entries still carry it");
  for (const allowZeroReasoning of [false, true]) {
    assert.throws(() => assertSegmentPins(timeline, depths, { allowZeroReasoning }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-unresendable"
      && /stores \d+ reasoning part\(s\) and \d+ reasoning stream block\(s\)/.test(error.message));
  }
});

test("the reasoning gate refuses a zero-reasoning transcript unless it is declared void", () => {
  // A transcript with no reasoning at all is a VOID comparison, never evidence
  // (ADR-0045 Decision 2). The gate can no longer be vacuous at zero.
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text: "alpha\nbeta" }] } } },
    { type: "session", seq: 3, id: "session-zero-reasoning" },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.reasoningBlocks, 0);
  assert.equal(timeline.reasoningParts, 0);
  assert.throws(() => assertSegmentPins(timeline), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-absent");
  const voided = assertSegmentPins(timeline, [], { allowZeroReasoning: true });
  assert.equal(voided.reasoningBlocks, 0);
  const carried = assertReasoningCarried(timeline, { allowZeroReasoning: true });
  assert.deepEqual(carried, { blocks: 0, bytes: 0, zeroDeclared: true, voidComparison: true },
    "the flag is recorded as a void comparison, never a pass");
});

test("--ignore-host-prunes on segment 139: the ignored path's own pins hold", t => {
  if (!requirePinnedWorld(t)) return;
  const depths = depthsInSegment(readUsage(DEFAULT_USAGE), 139);
  const timeline = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139, ignoreHostPrunes: true });
  const pins = assertSegmentPins(timeline, depths, { input: inputPinsOf() });
  assert.equal(pins.eligible, IGNORED_SEGMENT_PINS.eligible, "201 landing appends");
  assert.equal(pins.appends, 201);
  assert.equal(pins.replacements, 0, "every replacement was the host's own copy");
  assert.equal(pins.hostReplacements, 0);
  assert.equal(pins.prunedOriginals, 0);
  assert.equal(pins.neverPruned, 201);
  assert.equal(pins.pruneJournals, 0);
  assert.equal(pins.shadowedSeqs, 0);
  assert.equal(pins.hostReplacementsIgnored, 67);
  assert.equal(pins.peakDepth, 315_197, "the HOST series, recorded and labelled contaminated");
  assert.equal(pins.peakStep, 139);
  assert.equal(pins.reasoningBlocks, 86, "reasoning is not a host-pruned unit");
  assert.equal(pins.reasoningBytes, 155_545);
  assert.equal(timeline.hostTokens, 0);
  assert.equal(timeline.hostPrunesIgnored, 67);
  assert.equal(timeline.hostTokensIgnored, 217_551, "the in-segment shadows, not the session's");
  assert.ok(timeline.units.every(unit => unit.surfaceOp === "append"));
  // The default path on the same depth rows is unchanged and still pinned.
  const defaults = assertSegmentPins(readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 }), depths,
    { input: inputPinsOf() });
  assert.equal(defaults.eligible, SEGMENT_PINS.eligible);
  assert.equal(defaults.hostReplacements, 67, "in the vanilla world every replacement is a trim");
  assert.equal(defaults.otherReplacements, 0);
});

test("--ignore-host-prunes CLI: both paths report their own host totals", t => {
  if (!requirePinnedWorld(t)) return;
  const run = extra => spawnSync(process.execPath,
    [SCRIPT, "--plan", "--segment", "139", "--json", ...extra], { encoding: "utf8" });
  const parse = result => {
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    const at = lines.findIndex(line => line.startsWith("{"));
    assert.ok(at > 0, "the summary prints before the JSON");
    return JSON.parse(lines.slice(at).join("\n"));
  };
  const on = parse(run([]));
  const off = parse(run(["--ignore-host-prunes", "--reconstruction"]));
  assert.equal(on.ignoreHostPrunes, false);
  assert.equal(on.reconstruction, false);
  assert.equal(on.eligibleResults, 268);
  assert.equal(on.hostPrunes, 67);
  assert.equal(on.hostTokens, 217_551);
  assert.equal(off.ignoreHostPrunes, true);
  assert.equal(off.reconstruction, true, "the declaration is recorded in the plan");
  assert.equal(off.eligibleResults, 201);
  assert.equal(off.hostPrunes, 0);
  assert.equal(off.hostTokens, 0);
  assert.equal(off.hostPrunesIgnored, 67);
  assert.equal(off.hostTokensIgnored, 217_551);
  assert.equal(off.hostReplacementsIgnored, 67);
  assert.equal(off.depthSource, "reconstructed-surface", "a pruner-off lane reads the surface");
  assert.equal(off.hostDepthSeriesContaminated, true, "the host series is provenance only");
  assert.deepEqual(on.eligibleSplit,
    { total: 268, appends: 201, replacements: 67, prunedOriginals: 67, neverPruned: 134 },
    "268 = 201 appends (134 never-pruned + 67 pruned originals) + 67 replacements");
  assert.deepEqual(off.eligibleSplit,
    { total: 201, appends: 201, replacements: 0, prunedOriginals: 0, neverPruned: 201 },
    "the ignored world has no replacement and no pruned original");
});

test("the fire surface is time-aware: originals before the prune, replacements after", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const seqAt = (surface, seq) => surface.rows.some(row => row.seq === seq);
  const before = surfaceAt({ timeline, fireStep: 83, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(before, 46), true, "the original is billed before step 84");
  assert.equal(seqAt(before, 629), false, "its replacement has not entered yet");
  // P6 (eleventh audit): the ask at step 84 is composed BEFORE step 84's prune,
  // so the original is still tabled at fire 84 and leaves from step 85.
  const at84 = surfaceAt({ timeline, fireStep: 84, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(at84, 46), true,
    "a prune owned by step 84 is applied after that step's ask, so the row is tabled there");
  assert.equal(seqAt(at84, 629), true, "the replacement enters at its own step");
  assert.equal(at84.shadowed.length, 0);
  const after = surfaceAt({ timeline, fireStep: 85, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(after, 46), false, "from step 85 the journal shadows the original");
  assert.equal(seqAt(after, 629), true, "the replacement stays");
  assert.equal(after.shadowed.length, 50, "the first prune band shadows 50 rows");
  assert.equal(before.shadowed.length, 0, "nothing is shadowed before the first journal");
  // A tool/call row contributes an assistant projection with its target.
  const call = after.rows.find(row => row.kind === "tool/call");
  assert.ok(call !== undefined && call.role === "assistant" && call.text.startsWith("Tool call: "));
  assert.ok(call.text.includes("C:\\") || call.text.length > 0);
});

test("--ignore-host-prunes: the host's copy never enters the surface", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146, ignoreHostPrunes: true });
  const seqAt = (surface, seq) => surface.rows.some(row => row.seq === seq);
  const before = surfaceAt({ timeline, fireStep: 83, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(before, 46), true, "the original is billed before step 84");
  assert.equal(seqAt(before, 629), false, "the host's copy is not a unit in this world");
  const after = surfaceAt({ timeline, fireStep: 84, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(after, 46), true, "no journal shadows it, so it stays");
  assert.equal(seqAt(after, 629), false, "the copy never existed");
  assert.equal(after.shadowed.length, 0, "nothing is host-shadowed");
});

// ---- surface edge cases (audit 6, item 8) ----------------------------------

test("a replacement whose own seq a later prune shadows leaves the surface", () => {
  const body = name => `${name} line one ${"x".repeat(300)}\n${name} line two ${"x".repeat(300)}`;
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text: body("ORIGINAL") }] } } },
    { type: "step/start", seq: 3, data: { step: 2 } },
    { type: "compaction/prune", seq: 4, data: { shadowedSeqs: [2], shadowedTokenCount: 10 } },
    { type: "tool/result", seq: 5, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
      data: { step: 1, message: { content: [{ type: "text", text: body("REPLACEMENT") }] } } },
    { type: "step/start", seq: 6, data: { step: 3 } },
    { type: "compaction/prune", seq: 7, data: { shadowedSeqs: [5], shadowedTokenCount: 10 } },
    { type: "session", seq: 8, id: "session-shadowed-replacement" },
  ];
  const timeline = readTimeline(rows);
  const seqAt = (surface, seq) => surface.rows.some(row => row.seq === seq);
  // P6: a prune owned by step 2 is applied after that step's ask, so at fire 2
  // the original is still there beside its replacement. From step 3 the
  // original is gone; the second prune (owned by step 3) takes the replacement
  // from step 4.
  const atTwo = surfaceAt({ timeline, fireStep: 2, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(atTwo, 2), true, "the prune at step 2 is not applied at step 2");
  assert.equal(seqAt(atTwo, 5), true, "the replacement entered at step 2");
  const atThree = surfaceAt({ timeline, fireStep: 3, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(atThree, 2), false, "the first prune is in force from step 3");
  assert.equal(seqAt(atThree, 5), true, "the second prune is owned by step 3: not applied yet");
  const atFour = surfaceAt({ timeline, fireStep: 4, surface: new Map(), fireIndex: 0 });
  assert.equal(seqAt(atFour, 5), false,
    "the second prune names the replacement's OWN seq, so it leaves from step 4");
  assert.deepEqual(hostRemovedAt(timeline, 2), new Set(),
    "a prune at the fire's own step has not been applied at that fire");
  assert.deepEqual(hostRemovedAt(timeline, 3), new Set([2]),
    "prune 4 enters at step 3; one step-aware definition feeds surface and carry");
  assert.deepEqual(hostRemovedAt(timeline, 4), new Set([2, 5]), "prune 7 joins it at step 4");
});

test("a prune with no owning step refuses, never shadowing nothing", () => {
  const rows = [
    { type: "tool/result", seq: 1, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text: "a\nb" }] } } },
    { type: "compaction/prune", seq: 2, data: { shadowedSeqs: [1], shadowedTokenCount: 5 } },
  ];
  assert.throws(() => readTimeline(rows), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-prune-step-absent"
    && /no owning step\/start/.test(error.message));
});

test("a non-integer shadowed seq refuses instead of shadowing nothing", () => {
  // Fourteenth audit item 4: `row.data.shadowedSeqs` was copied without a type
  // check, so `["2"]` is a string that matches no row: the journal counted as
  // one prune and the removal silently did not apply.
  const base = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text: "a\nb" }] } } },
  ];
  const prune = shadowedSeqs => [
    ...base,
    { type: "compaction/prune", seq: 3, data: { shadowedSeqs, shadowedTokenCount: 5 } },
  ];
  for (const bad of [["2"], [2.5], [null]]) {
    assert.throws(() => readTimeline(prune(bad)), error =>
      error instanceof SimBatchUnitsRefusal
      && error.code === "sim-batch-shadowed-seq-invalid"
      && /integer seq/.test(error.message),
    `shadowedSeqs ${JSON.stringify(bad)} is not a row's integer seq`);
  }
  // A present non-array has the same silent effect and refuses the same way.
  assert.throws(() => readTimeline(prune(2)), error =>
    error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-shadowed-seq-invalid"
    && /not an array/.test(error.message));
  // Integer entries still read, and they are the seqs the world removes.
  const timeline = readTimeline(prune([2]));
  assert.deepEqual(timeline.hostPrunes.map(entry => entry.seqs), [[2]]);
  assert.equal(hostRemovedAt(timeline, 2).has(2), true, "the prune is in force from step 2");
});

test("a replacement with no owning step refuses, never borrowing the original's", () => {
  const rows = [
    { type: "tool/result", seq: 2, surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      data: { step: 1, message: { content: [{ type: "text", text: "copy" }] } } },
  ];
  assert.throws(() => readTimeline(rows), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-replacement-step-absent"
    && /stale step/.test(error.message));
});

// ---- the build identity names all its modules (audit 6, item 10) -----------

test("the build identity names every sim module and refuses a missing one", () => {
  const build = buildIdentityOf();
  assert.match(build.coreDistSha256, /^[0-9a-f]{64}$/u, "the built core entry is hashed");
  for (const name of ["units", "grammar", "render", "gate3"]) {
    assert.match(build.modules[name], /^[0-9a-f]{64}$/u,
      `the build identity names the ${name} module by default`);
  }
  assert.throws(() => buildIdentityOf({ absent: path.join(tmpdir(), "racoons-absent-module.mjs") }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-build-invalid"
    && /may not record a null hash/.test(error.message));
});

test("the prompt is system + surface + ask, never trimmed, and refuses at the bytes/3 guard", () => {
  const text = "a".repeat(1_600_004);
  const timeline = {
    rows: [{ seq: 1, type: "tool/result", surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text }] } } }],
    entrySteps: new Map([[1, 1]]), hostPrunes: [], system: "system", callNames: new Map(), tools: [],
  };
  // An absent surface is a named refusal, never "the raw recording".
  assert.throws(() => buildPrompt({ timeline, fireStep: 1, ask: "q" }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-required");
  assert.throws(() => buildPrompt({ timeline, fireStep: 1, ask: "q", surface: null }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-required");
  assert.throws(() => buildPrompt({ timeline, fireStep: 1, ask: "q", surface: new Map(), fireIndex: 0 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-prompt-overflow");
});

test("the surface identity is guarded: a fresh map at fire > 0 refuses, and so does a regression", () => {
  const timeline = readTimeline(surfaceTranscript());
  const units = eligibleOf(timeline, 1);
  const fireTwo = units.filter(unit => unit.step === 2);
  // Fire 0 holds the one surface; fire 1 must be the SAME surface, advanced.
  const surface = simulateSurface();
  assert.equal(surfaceFireOf(surface), 0);
  assert.equal(surfaceShapesEverAppliedOf(surface), 0);
  assert.equal(surfaceSizeOf(surface), 0, "the current size starts empty");
  const fireZero = promptForFire({ timeline, fireStep: 1, units: units.filter(u => u.step === 1),
    surface, fireIndex: 0 });
  assert.ok(fireZero.bytes > 0);
  // A fresh map at fire 1 is the historic failure: every gate green, removals
  // silently dropped. It refuses by name.
  assert.throws(() => promptForFire({ timeline, fireStep: 2, units: fireTwo,
    surface: new Map(), fireIndex: 1 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-identity"
    && /fresh unstamped surface cannot build fire 1/.test(error.message));
  // An index regression (a surface from a later fire) refuses too.
  const ahead = simulateSurface({ fireIndex: 2 });
  for (const attempted of [1, 0]) {
    assert.throws(() => promptForFire({ timeline, fireStep: 2, units: fireTwo,
      surface: ahead, fireIndex: attempted }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-identity"
      && /index regression/.test(error.message));
  }
  // Advancing happens only through a fire's answered rows: after one fire the
  // surface is fire 1 and builds it; the removals are counted.
  applyFireToSurface({ surface, timeline, units: units.filter(u => u.step === 1), rows: [
    { index: 1, status: "answered", answer: { action: "forgetall", summary: "gone" } },
    { index: 2, status: "answered", answer: { action: "keepall" } },
    { index: 3, status: "answered", answer: { action: "keepall" } },
  ] });
  assert.equal(surfaceFireOf(surface), 1);
  assert.equal(surfaceShapesEverAppliedOf(surface), 1,
    "one shaped turn has ever been applied to this surface");
  assert.equal(surfaceSizeOf(surface), 1, "the current size is one shaped turn");
  assert.ok(promptForFire({ timeline, fireStep: 2, units: fireTwo, surface, fireIndex: 1 }).bytes > 0);
  // P10: a restore lowers the CURRENT size but never the cumulative count; the
  // two accessors are separate readings, never one number under two names.
  applyFireToSurface({ surface, timeline, units: units.filter(u => u.step === 1), rows: [
    { index: 1, status: "answered", answer: { action: "keepall" } },
    { index: 2, status: "answered", answer: { action: "keepall" } },
    { index: 3, status: "answered", answer: { action: "keepall" } },
  ] });
  assert.equal(surfaceSizeOf(surface), 0, "the restore removed the shaped turn");
  assert.equal(surfaceShapesEverAppliedOf(surface), 1,
    "the cumulative count does not fall with a restore");
  // The documented test-only constructor builds a deliberately raw or
  // out-of-order surface; it is the only bypass.
  const raw = simulateSurface({ testOnly: true });
  assert.ok(promptForFire({ timeline, fireStep: 2, units: fireTwo, surface: raw, fireIndex: 7 }).bytes > 0);
});

test("the pre-send guard reads the LARGER of ceil(content/3) and ceil(wire/3)", () => {
  const timelineWith = text => ({
    rows: [{ seq: 1, type: "tool/result", surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text }] } } }],
    entrySteps: new Map([[1, 1]]), hostPrunes: [], system: "s", callNames: new Map(), tools: [],
  });
  // 1,199,700 body + 13 "tool result:\n" + 1 system + 1 ask + 2 "[]" tools.
  const under = buildPrompt({ timeline: timelineWith("a".repeat(1_199_700)), fireStep: 1, ask: "q", surface: new Map(), fireIndex: 0 });
  assert.equal(under.bytes, 1_199_717);
  assert.equal(under.guardTokensContent, 399_906, "the content-only bound");
  assert.equal(under.guardTokensPayloadWire, 399_944,
    "the payload-wire bound, larger by the JSON framing");
  assert.equal(under.guardTokens, 399_944, "the guard is the LARGER of the two");
  assert.ok(under.guardTokens < 400_000);
  assert.ok(under.promptWireBytes > under.bytes,
    "the wire is larger than the content count, which is why it is the guard's size");
  assert.ok(under.estimatedTokens < under.guardTokens,
    "the 3.04 B/token estimate is the tighter number; the guard is the gate");
  // A prompt whose CONTENT fits 400k and whose WIRE does not is refused: the
  // wire is the size the request really carries.
  assert.throws(() => buildPrompt({
    timeline: timelineWith("a".repeat(1_199_917)), fireStep: 1, ask: "q", surface: new Map(),
    fireIndex: 0,
  }), error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-prompt-overflow"
    && /400016 >= 400000/.test(error.message));
});

/** One assistant turn (reasoning + text + tool call), its call row, and the result. */
const reasoningRows = () => [
  { type: "step/start", seq: 1, data: { step: 1 } },
  { type: "system/message", seq: 2, data: { message: { content: [{ type: "text", text: "sys" }] } } },
  { type: "assistant/message", seq: 3, data: { message: {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Reason line one.\nReason line two." },
      { type: "text", text: "I will read the file." },
      { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.ts"}' },
    ],
    source: { replayState: { blocks: [
      { type: "reasoning", thinkingSignature: "reasoning_content" },
      { type: "text" }, { type: "tool-call" },
    ] } },
  } } },
  { type: "tool/call", seq: 4, data: { callId: "c1", name: "read",
    arguments: JSON.stringify({ path: "a.ts" }) } },
  { type: "tool/result", seq: 5, surfaceOp: "append",
    data: { message: { toolCallId: "c1",
      content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\n" }] } } },
  { type: "session", seq: 6, id: "session-reasoning" },
];

test("a tool result's rewrite never touches the assistant turn's reasoning", () => {
  const timeline = readTimeline(reasoningRows());
  const units = eligibleOf(timeline, 1);
  assert.equal(units.length, 1, "the one in-scope tool result is the unit");
  const assistantOf = prompt => prompt.messages.find(message =>
    message.role === "assistant" && message.reasoning_content !== undefined);
  const before = buildPrompt({ timeline, fireStep: 1, ask: "q", surface: new Map(), fireIndex: 0 });
  assert.equal(assistantOf(before).content, "I will read the file.");
  assert.equal(assistantOf(before).reasoning_content, "Reason line one.\nReason line two.");
  assert.equal(before.reasoningMessages, 1);
  assert.equal(before.reasoningBytes, Buffer.byteLength("Reason line one.\nReason line two.", "utf8"));
  const surface = new Map();
  applyFireToSurface({ surface, timeline, units, lane: 0,
    rows: [{ status: "answered", answer: { action: "forgetall", summary: "gone" } }] });
  assert.equal(surface.has(3), false, "the assistant turn's own seq is never in the surface Map");
  assert.equal(surface.has(5), true, "only the tool result's seq is replaced");
  const after = buildPrompt({ timeline, fireStep: 1, ask: "q", surface, fireIndex: 0 });
  assert.equal(JSON.stringify(assistantOf(after)), JSON.stringify(assistantOf(before)),
    "the reasoning and its bytes are byte-identical across the rewrite");
  assert.notEqual(JSON.stringify(after.messages), JSON.stringify(before.messages),
    "the tool result itself did change");
  assert.equal(after.reasoningBytes, before.reasoningBytes);
  // The assistant branch never consults the Map: a forged entry at its seq is inert.
  const forged = new Map([[3, "FORGED"], [5, "one\ntwo\nthree\nfour\nfive\n"]]);
  const withForged = buildPrompt({ timeline, fireStep: 1, ask: "q", surface: forged, fireIndex: 0 });
  assert.equal(JSON.stringify(assistantOf(withForged)), JSON.stringify(assistantOf(before)),
    "even a forged entry at the assistant's seq changes no assistant byte");
});

test("the reasoning turns are read from the TIMELINE; a lost or altered turn refuses", () => {
  const timeline = readTimeline(reasoningRows());
  const text = "Reason line one.\nReason line two.";
  const bytes = Buffer.byteLength(text, "utf8");
  const pair = [{ turnSeq: 3, sha256: sha256OfText(text) }];
  const expected = expectedReasoningAt({ timeline, fireStep: 1 });
  assert.equal(expected.messages, 1, "the independent ruler counts the turn at its own step");
  assert.equal(expected.bytes, bytes);
  assert.deepEqual(expected.pairs, pair, "the ruler names the turn AND hashes its text");
  assert.equal(expected.sha256, reasoningPairsHashOf(pair), "the ruler hashes the pair list");
  assert.deepEqual(expectedReasoningAt({ timeline, fireStep: 0 }),
    { messages: 0, bytes: 0, sha256: reasoningPairsHashOf([]), pairs: [] },
    "a fire before the turn carries none of it");
  const packed = buildPrompt({ timeline, fireStep: 1, ask: "q", surface: new Map(), fireIndex: 0 });
  assert.equal(packed.reasoningMessages, 1);
  assert.equal(packed.reasoningBytes, bytes);
  assert.equal(packed.reasoningSha256, reasoningPairsHashOf(pair));
  assert.ok(packed.reasoningShare > 0 && packed.reasoningShare < 1,
    "the send states the share of its own bytes that is the agent's reasoning");
  // A prompt that LOST the assistant turn is refused by the timeline's own
  // turns, not by a count derived from the same rows the prompt was built from.
  assert.throws(() => assertReasoningInPrompt({ timeline, fireStep: 1,
    messages: [{ role: "user", content: "no reasoning here" }], turnSeqs: [null] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-mismatch"
    && /the prompt carries 0 turn\(s\) but the timeline places 1/.test(error.message));
  // A SAME-LENGTH substitution: "one" -> "0ne" is the same UTF-8 byte length,
  // so a count-and-byte-sum gate passes it. The per-turn hash must refuse.
  const swapped = text.replace("line one", "line 0ne");
  assert.equal(Buffer.byteLength(swapped, "utf8"), bytes, "the substitution keeps the byte sum");
  assert.equal(swapped.length, text.length, "and the character count");
  assert.throws(() => assertReasoningInPrompt({ timeline, fireStep: 1,
    messages: [{ role: "assistant", content: "I will read the file.",
      reasoning_content: swapped }], turnSeqs: [3] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-mismatch"
    && /turn 1 differs/.test(error.message) && /same-length substitution/.test(error.message),
  "a same-length substitution is refused by the per-turn hash");
  // The SAME text attached to a DIFFERENT turn is the pair list's own case: the
  // ordered text list is identical ([text]), and only the turnSeq differs.
  assert.throws(() => assertReasoningInPrompt({ timeline, fireStep: 1,
    messages: [{ role: "assistant", content: "I will read the file.",
      reasoning_content: text }], turnSeqs: [4] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-mismatch"
    && /turn 1 differs \(seq 4 carrying a text whose sha256 is not that turn's\)/.test(error.message),
  "turn 3's reasoning on turn 4's message is a different pair, not the same ruler");
  // A reasoning-bearing message with no turnSeq cannot be placed at all.
  assert.throws(() => assertReasoningInPrompt({ timeline, fireStep: 1,
    messages: [{ role: "assistant", content: "I will read the file.",
      reasoning_content: text }], turnSeqs: [null] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-mismatch"
    && /no turnSeq/.test(error.message));
});

test("partially lost reasoning is counted by name, never hidden by the resendable half", () => {
  const rows = reasoningRows();
  // A turn whose replay state is misaligned (two content parts, one block).
  rows.push({ type: "assistant/message", seq: 7, data: { message: {
    content: [{ type: "reasoning", text: "lost thought" }, { type: "text", text: "and text" }],
    source: { replayState: { blocks: [
      { type: "reasoning", thinkingSignature: "reasoning_content" }] } },
  } } });
  // A turn whose signature is not one of the resendable three.
  rows.push({ type: "assistant/message", seq: 8, data: { message: {
    content: [{ type: "reasoning", text: "opaque thought" }, { type: "text", text: "more" }],
    source: { replayState: { blocks: [
      { type: "reasoning", thinkingSignature: "opaque" }, { type: "text" }] } },
  } } });
  const timeline = readTimeline(rows);
  assert.equal(timeline.reasoningBlocks, 1, "the resendable turn still counts");
  assert.equal(timeline.reasoningUnresendableRows, 2,
    "both lost turns are counted, not silently dropped");
  assert.throws(() => assertReasoningCarried(timeline), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-unresendable-rows"
    && /2 assistant/.test(error.message));
  // A blank reasoning part says nothing, so it is not a lost turn.
  const blank = readTimeline([...reasoningRows(),
    { type: "assistant/message", seq: 9, data: { message: {
      content: [{ type: "reasoning", text: "   " }, { type: "text", text: "plain" }],
      source: { replayState: { blocks: [{ type: "text" }] } } } } }]);
  assert.equal(blank.reasoningUnresendableRows, 0, "a blank part carries no reasoning to lose");
});

test("surfaceDepthSeries requires the surface and its fire index", () => {
  const timeline = readTimeline(reasoningRows());
  assert.throws(() => surfaceDepthSeries({ timeline, steps: [1] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-invalid",
    "the default empty surface is gone");
  assert.throws(() => surfaceDepthSeries({ timeline, steps: [1], surface: simulateSurface() }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-fire-invalid",
    "the fire index is required");
  // Every reader of a surface names its fire: the index was a defaulted null and
  // the identity check returned early, so a raw recording read as fire 0 passed.
  assert.throws(() => surfaceDepthAt({ timeline, fireStep: 1, surface: simulateSurface() }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-fire-invalid"
      && /a fire index is a non-negative integer, got undefined/.test(error.message),
    "surfaceDepthAt refuses a missing fire index by name");
  assert.throws(() => surfaceDepthBefore({ timeline, step: 1, surface: simulateSurface() }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-fire-invalid");
  assert.throws(() => surfaceAt({ timeline, fireStep: 1, surface: new Map() }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-fire-invalid",
    "surfaceAt refuses it too (the buildPrompt path)");
  assert.throws(() => surfaceDepthSeries({ timeline, steps: [1], surface: new Map(), fireIndex: 1 }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-identity",
    "an unstamped Map cannot stand in for a later fire's surface");
  assert.throws(() => surfaceDepthBefore({ timeline, step: 1,
    surface: simulateSurface({ fireIndex: 2 }), fireIndex: 0 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-identity",
    "a surface from a later fire cannot be the fire-0 reconstruction");
  const series = surfaceDepthSeries({ timeline, steps: [1, 2],
    surface: simulateSurface(), fireIndex: 0 });
  assert.equal(series.length, 2);
  assert.ok(series[0].tokens > 0);
  assert.equal(series[1].step, 1, "the reading is labelled with the step BEFORE the cut");
});

test("the eligible split never lets the pruned originals be added twice", () => {
  const units = [unitOf(1), unitOf(2), unitOf(3)];
  const timeline = { ...timelineOf(units), hostRemoved: new Set([1]) };
  const split = eligibleSplitOf(timeline, units);
  assert.deepEqual(split,
    { total: 3, appends: 3, replacements: 0, prunedOriginals: 1, neverPruned: 2 });
  assert.equal(split.neverPruned + split.prunedOriginals, split.appends,
    "the originals group is appends, never appends + pruned originals");
});

test("ADR-0045: a zero-reasoning world's prompts are byte-identical to the pre-change build", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const timeline = readTimeline(PAIR2_TRANSCRIPT, { segment: 146 });
  const units = eligibleOf(timeline).slice(0, 8);
  for (const fireStep of [26, 83, 134]) {
    const packed = promptForFire({ timeline, fireStep, units, surface: new Map(), fireIndex: 0 });
    assert.equal(packed.reasoningMessages, 0, "pair-2 carries no reasoning (ISSUE-195)");
    assert.equal(packed.reasoningBytes, 0);
    assert.equal(packed.reasoningWireBytes, 0);
    assert.ok(packed.messages.every(message => !("reasoning_content" in message)),
      "no empty reasoning field is sent");
    // The pre-change message array, rebuilt here: system, each surface row's
    // role/content, then the ask. `deepEqual` is the byte-identity proof.
    const legacy = [{ role: "system", content: timeline.system ?? "" },
      ...surfaceAt({ timeline, fireStep, surface: new Map(), fireIndex: 0 }).rows.map(row => ({ role: row.role, content: row.text })),
      { role: "user", content: packed.ask }];
    assert.deepEqual(packed.messages, legacy);
    assert.equal(packed.bytes,
      legacy.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0)
        + packed.toolsBytes,
      "the byte total is the same sum of the same strings, plus the tools array");
  }
});

test("the segment prompt and ask build under the hard limit with every turn kept", t => {
  if (!requirePinnedWorld(t)) return;
  const timeline = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
  const units = eligibleOf(timeline).slice(0, 8);
  const fired = promptForFire({ timeline, fireStep: 20, units, surface: new Map(), fireIndex: 0 });
  assert.ok(fired.estimatedTokens > 0 && fired.estimatedTokens < 400_000);
  assert.ok(fired.contextRows > 0 && fired.surfaceRows === fired.contextRows,
    "every surface row is a message: no turn is trimmed");
  assert.equal(fired.turnSeqs.length, fired.messages.length,
    "one turn seq per message, so the batch check can prove a row is present");
  assert.equal(fired.messages[0].role, "system", "the first slot is role system");
  assert.equal(fired.messages[fired.messages.length - 1].content, fired.ask,
    "the ask is the last message");
  assert.ok(fired.ask.includes("[[entry-ask-end:"), "the shipped batch ask bytes");
  assert.ok(fired.reasoningBytes > 0, "the fire's context carries the agent's reasoning");
  assert.ok(fired.reasoningMessages > 0, "and names how many turns carried it");
  assert.ok(askMessageFor(units, timeline.callNames).length > 0);
  const pins = surfacePinsOf(timeline, depthsInSegment(readUsage(DEFAULT_USAGE), 139));
  assert.equal(pins.segment, 139);
  assert.equal(pins.excludedRows, 1484,
    "P3: the cut's excluded-row count is a pin-adjacent reading");
  // P8: the segment's 93/93 and the WHOLE FILE's 271/271 are both readings, and
  // the pins carry both pairs so `assertSegmentPins` gates the claimed number.
  assert.equal(pins.reasoningParts, 93);
  assert.equal(pins.reasoningStreamBlocks, 93);
  assert.equal(pins.fileReasoningParts, 271);
  assert.equal(pins.fileReasoningStreamBlocks, 271);
  assert.equal(SEGMENT_PINS.fileReasoningParts, 271);
  assert.equal(SEGMENT_PINS.fileReasoningStreamBlocks, 271);
});

// ---- phase 3 grammars: the default is byte-identical, the variants swap text --

test("3option is the shipped batch ask, byte for byte", () => {
  // The labels come from tool/call rows, read by the product's own
  // `targetFromInput` rule, never typed in by the test.
  const transcript = [];
  for (const [at, seq] of [2, 4, 6].entries()) {
    const callId = `c${String(at + 1)}`;
    transcript.push({ type: "tool/call", seq: seq - 1,
      data: { callId, name: "Read", arguments: '{"file_path":"a.ts"}' } },
    { type: "tool/result", seq, data: { message: { toolCallId: callId } } });
  }
  const names = callNamesOf(transcript);
  const units = [unitOf(2), unitOf(4), unitOf(6)];
  const shipped = entryBatchAskMessage(askRowsOf(units, names), "3option");
  assert.equal(askMessageFor(units, names, "3option"), shipped, "the id names the same bytes");
  // The DEFAULT is the product default (`jsonl-20`, owner ruling 2026-11-05),
  // never the 3option recipe: a run that names no grammar measures the shape a
  // default product run sends.
  assert.equal(DEFAULT_ASK_GRAMMAR, "jsonl-20");
  assert.equal(askMessageFor(units, names), askMessageFor(units, names, "jsonl-20"),
    "no flag is the product default's bytes");
  assert.notEqual(askMessageFor(units, names), shipped,
    "the default is NOT the 3option recipe");
  assert.ok(shipped.includes('{"keeplines":[[2,3]'), "the shipped keeplines example survives");
  assert.ok(shipped.includes("[Read a.ts]"), "the transcript's own label rides the table row");
  for (const grammar of ASK_GRAMMARS) {
    const ask = askMessageFor(units, names, grammar);
    assert.ok(ask.endsWith(ENTRY_ASK_END_ANCHOR), `${grammar} ends on the closing anchor`);
    if (SLOT_GRAMMARS.has(grammar)) {
      // A slot grammar is its own contract: the table sits in its prompt's slot
      // and the answer is one object per line, never one assembled object.
      assert.ok(!ask.includes("Assembled by row index:"), `${grammar} assembles nothing`);
      assert.ok(ask.includes("one JSON object per row"),
        `${grammar} teaches one object per row`);
    } else {
      assert.ok(ask.includes("Assembled by row index:"), `${grammar} answers by row index`);
      assert.ok(ask.includes("Prune aggressively:"), `${grammar} keeps the last line`);
    }
  }
});

test("two-option states there is no line option and refuses a range answer", () => {
  const units = [unitOf(1), unitOf(2)];
  const ask = askMessageFor(units, new Map(), "two-option");
  assert.ok(!ask.includes("keeplines") && !ask.includes("forgetlines"), "no range action is taught");
  assert.ok(ask.includes("There is no line-level option"));
  assert.ok(ask.endsWith(ENTRY_ASK_CLOSING_LINE));
  const fine = answerRowsOf(
    '{"1":{"keepall":true},"2":{"forgetall":"a stale build log"}}', [1, 2], "two-option");
  assert.deepEqual(fine.map(row => row.status), ["answered", "answered"]);
  assert.deepEqual(fine.map(row => row.answer.action), ["keepall", "forgetall"]);
  const gated = answerRowsOf('{"1":{"keeplines":[[1,1],"s"]},"2":{"keepall":true}}',
    [1, 2], "two-option");
  assert.equal(gated[0].status, "refused");
  assert.equal(gated[0].code, GRAMMAR_GATE_CODE, "a range answer is not in this grammar");
  assert.equal(gated[1].status, "answered", "the gate never touches a neighbour");
  const forget = answerRowsOf('{"1":{"forgetlines":[[1,1],"s"]}}', [1], "two-option");
  assert.equal(forget[0].code, GRAMMAR_GATE_CODE, "forgetlines is not in this grammar either");
  const details = answerDetailsOf('{"1":{"keeplines":[[1,1],"s"]}}', [1], "two-option");
  assert.equal(details.get(1).wireCode, null);
  assert.match(details.get(1).message, /no line-level option/);
  // No range exists, so the arithmetic correction degenerates: only parse refusals.
  assert.equal(arithmeticCodeOf({ action: "forgetall", summary: "x" }, 9, "two-option"), null);
  assert.equal(arithmeticCodeOf(
    { action: "keeplines", ranges: [{ from: 1, to: 99 }] }, 9, "two-option"), null);
});

test("forgetlines names what leaves, and ranges are checked against the row's N", () => {
  const units = [unitOf(1)];
  const ask = askMessageFor(units, new Map(), "forgetlines");
  assert.ok(ask.includes('{"forgetlines":[[2,3]'), "the example names the removed lines");
  assert.ok(!ask.includes("keeplines"), "the keep-direction action is not taught");
  assert.match(ask, /The named lines are what is REMOVED/);
  assert.ok(ask.endsWith(ENTRY_ASK_CLOSING_LINE));
  const ok = answerRowsOf('{"1":{"forgetlines":[[2,3],"stale notes"]}}', [1], "forgetlines");
  assert.equal(ok[0].status, "answered");
  assert.equal(ok[0].answer.action, "forgetlines");
  assert.equal(ok[0].answer.summary, "stale notes");
  const kept = answerRowsOf('{"1":{"keeplines":[[1,1],"s"]}}', [1], "forgetlines");
  assert.equal(kept[0].status, "refused");
  assert.equal(kept[0].code, GRAMMAR_GATE_CODE);
  assert.match(answerDetailsOf('{"1":{"keeplines":[[1,1],"s"]}}', [1], "forgetlines")
    .get(1).message, /names the lines to forget/);
  const span = ranges => ({ action: "forgetlines", ranges, summary: "s" });
  assert.equal(arithmeticCodeOf(span([{ from: 1, to: 4 }]), 3, "forgetlines"), "spans-outside-result");
  assert.equal(arithmeticCodeOf(span([{ from: 1, to: 3 }]), 3, "forgetlines"), "forgets-all-lines");
  assert.equal(arithmeticCodeOf(span([{ from: 1, to: 2 }, { from: 3, to: 3 }]), 3, "forgetlines"),
    "forgets-all-lines", "touching spans cover the body after normalisation");
  assert.equal(arithmeticCodeOf(span([{ from: 2, to: 2 }]), 3, "forgetlines"), null);
  // A reversed span is refused by the wire parser first: a parse refusal, no correction.
  const reversed = parseEntryBatchAnswer('{"1":{"forgetlines":[[3,2],"s"]}}', [1], "3option");
  assert.equal(reversed[0].status, "refused");
  assert.equal(reversed[0].code, "malformed-row");
});

// ---- arm B: keeplines-60 -------------------------------------------------

/** The owner-approved arm B prompt, byte for byte. */
const KEEPLINES_60_PROMPT = [
  "Memory management: decide what tool results above stay in your memory. Answer about every "
    + "result listed in the table below. Each row starts with the index you answer with, then the "
    + "call that made it and quotes from that unit's own lines.",
  "",
  "Answer with exactly one JSON object and no other text. Each key is a row's index; its value is "
    + "that unit's verdict:",
  "",
  '{"keeplines":[[2,3],[8,9],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "Assembled by row index:",
  "",
  '{"1":{"forgetall":"generated migration output from the old schema"},'
    + '"2":{"keeplines":[[1,2],[12,13],[27,28],"the two env vars and the deploy command"]}}',
  "",
  "Each row takes keeplines (keep the named ranges, 1-based, counted on that unit's own lines; the "
    + "rest is replaced by a required summary; the summary is the last element inside the array) or "
    + "forgetall (replace the whole result with its summary). A summary should be short: aim under "
    + "50 words, never over 200. Across all rows together, forget "
    + "at least 60 percent of the total lines: keep some units whole and forget others whole if that "
    + "meets it. Answer every index exactly once; a missing, unknown or repeated key refuses that "
    + "unit, and a refused unit keeps.",
  "",
  "Prune aggressively: drop anything the immediate task does not need; if you drop too much, the "
    + "necromancy tool restores the exact bytes.",
].join("\n");

test("keeplines-60 ships the approved prompt bytes, unchanged by grammar plumbing", () => {
  assert.equal(instructionOf("keeplines-60"), KEEPLINES_60_PROMPT);
  assert.equal(ASK_GRAMMAR_PROMPTS["keeplines-60"], KEEPLINES_60_PROMPT);
  assert.ok(KEEPLINES_60_PROMPT.startsWith(PRUNE_ASK_SYSTEM_PROMPT.split("\n")[0]),
    "the shipped opener is reused verbatim");
  assert.ok(!KEEPLINES_60_PROMPT.includes("keepall"), "keepall is not taught");
  const ask = askMessageFor([unitOf(1)], new Map(), "keeplines-60");
  assert.equal(ask, `${KEEPLINES_60_PROMPT}\n\n1. [tool result] (call #1) — line 1 ends with`
    + ` "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" · line 2 ends with "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"`
    + `\n\n${ENTRY_ASK_CLOSING_LINE}`, "the block, the row, the closing anchor");
});

test("every example in the keeplines-60 prompt parses, and each summary is last", () => {
  // A prompt example is only honest if a model can copy it and the reader accepts
  // it. The defect this guards: both `keeplines` examples once put the summary
  // AFTER the array, which is not JSON, and one bad row refused the whole batch.
  // The extraction is deliberately dumb — every line that opens a JSON object —
  // so a new example cannot be added without being read here.
  const examples = instructionOf("keeplines-60").split("\n")
    .filter(line => line.startsWith('{"'));
  assert.equal(examples.length, 3, "two bare verdicts and one assembled answer");

  // Each example is either one verdict (a row's value) or an assembled answer
  // whose values are row objects. Flatten both into `{ key, verdict }` entries.
  const rows = examples.flatMap((example, at) => {
    const parsed = JSON.parse(example);
    const values = Object.values(parsed);
    const assembled = values.every(value => value !== null && typeof value === "object"
      && !Array.isArray(value));
    if (!assembled) return [{ example, at, key: null, verdict: parsed }];
    return Object.entries(parsed).map(([key, verdict]) => ({ example, at, key, verdict }));
  });

  for (const { example, at, key, verdict } of rows) {
    assert.ok(verdict !== null && typeof verdict === "object" && !Array.isArray(verdict),
      `example ${String(at)} must hold a verdict object: ${example}`);
    const keys = Object.keys(verdict);
    assert.equal(keys.length, 1,
      `example ${String(at)}${key === null ? "" : ` row ${key}`} has exactly one key: `
      + example);
    const [action] = keys;
    assert.ok(action === "keeplines" || action === "forgetall",
      `example ${String(at)} teaches only the arm's two actions: ${example}`);
    if (action === "forgetall") {
      assert.equal(typeof verdict.forgetall, "string", `forgetall carries a string: ${example}`);
      continue;
    }
    const payload = verdict.keeplines;
    assert.ok(Array.isArray(payload), `keeplines is an array: ${example}`);
    assert.ok(payload.length >= 3, `keeplines names at least one range and a summary: ${example}`);
    assert.equal(typeof payload[payload.length - 1], "string",
      `the summary is the last element INSIDE the keeplines array: ${example}`);
    for (const range of payload.slice(0, -1)) {
      assert.ok(Array.isArray(range) && range.length === 2
        && range.every(n => Number.isInteger(n)) && range[0] <= range[1],
      `every element before the summary is an ascending integer pair: ${example}`);
    }
  }

  // The same bytes through the same reading the lane uses, not just JSON.parse:
  // a bare verdict is index 1's value; the assembled answer is indices 1 and 2.
  for (const example of examples.slice(0, 2)) {
    const parsed = JSON.parse(example);
    const answered = answerRowsOf(`{"1":${JSON.stringify(parsed)}}`, [1], "keeplines-60");
    assert.equal(answered[0].status, "answered", `${example} is answered, not refused`);
  }
  const assembled = answerRowsOf(examples[2] ?? "", [1, 2], "keeplines-60");
  assert.deepEqual(assembled.map(row => row.status), ["answered", "answered"],
    "the assembled example answers both rows");
  assert.deepEqual(assembled.map(row => row.answer.action), ["forgetall", "keeplines"]);
});

test("keeplines-60 accepts keeplines and forgetall and refuses keepall", () => {
  const rows = answerRowsOf('{"1":{"keeplines":[[1,2],"two lines"]},"2":{"keepall":true}}',
    [1, 2], "keeplines-60");
  assert.equal(rows[0].status, "answered");
  assert.deepEqual(rows[0].answer.ranges, [{ from: 1, to: 2 }]);
  assert.equal(rows[0].answer.summary, "two lines");
  assert.equal(rows[1].status, "refused");
  assert.equal(rows[1].code, GRAMMAR_GATE_CODE, "keepall is not in this grammar");
  const forget = answerRowsOf('{"1":{"forgetall":"old log"}}', [1], "keeplines-60");
  assert.equal(forget[0].status, "answered");
  assert.equal(forget[0].answer.action, "forgetall");
  const gated = answerRowsOf('{"1":{"forgetlines":[[1,1],"s"]}}', [1], "keeplines-60");
  assert.equal(gated[0].code, GRAMMAR_GATE_CODE, "forgetlines is not in this grammar either");
  assert.match(answerDetailsOf('{"1":{"keepall":true}}', [1], "keeplines-60").get(1).message,
    /takes keeplines or forgetall/);
});

test("keeplines-60 accepts a keeplines naming every line as keep-whole", () => {
  const rows = answerRowsOf('{"1":{"keeplines":[[1,4],"the whole unit"]}}', [1], "keeplines-60");
  assert.equal(rows[0].status, "answered", "the old keeps-every-line refusal is gone");
  assert.equal(arithmeticCodeOf(rows[0].answer, 4, "keeplines-60"), null);
  assert.equal(keepsWholeOf(rows[0].answer, 4), true, "it removes nothing");
  assert.equal(keptLineCountOf(rows[0].answer, 4), 4);
  const touching = answerRowsOf('{"1":{"keeplines":[[1,2],[3,4],"the whole unit"]}}', [1],
    "keeplines-60");
  assert.equal(keepsWholeOf(touching[0].answer, 4), true, "touching spans merge to the whole");
  // A span past the row is still an arithmetic refusal and still earns the correction.
  const past = answerRowsOf('{"1":{"keeplines":[[1,9],"too far"]}}', [1], "keeplines-60");
  assert.equal(arithmeticCodeOf(past[0].answer, 4, "keeplines-60"), "spans-outside-result");
  assert.equal(keepsWholeOf({ action: "keeplines", ranges: [{ from: 1, to: 3 }] }, 4), false);
});

test("keeplines-60 widens the summary cap to 250 words and refuses above", () => {
  assert.equal(KEEPLINES_60_SUMMARY_WORDS, 250, "the arm's cap is the wide one");
  const words = count => Array.from({ length: count }, (_, at) => `w${String(at)}`).join(" ");
  const at250 = answerRowsOf(JSON.stringify({ 1: { forgetall: words(250) } }), [1],
    "keeplines-60");
  assert.equal(at250[0].status, "answered", "the shipped 25-word cap does not apply here");
  assert.equal(at250[0].answer.summary, words(250));
  const at251 = answerRowsOf(JSON.stringify({ 1: { forgetall: words(251) } }), [1],
    "keeplines-60");
  assert.equal(at251[0].status, "refused", "the row keeps, at parse level");
  assert.equal(at251[0].code, SUMMARY_TOO_LONG_CODE);
  const detail = answerDetailsOf(JSON.stringify({ 1: { forgetall: words(251) } }), [1],
    "keeplines-60").get(1);
  assert.equal(detail.wireCode, "summary-too-long");
  assert.match(detail.message, /250 words/);
  // The keeplines trailer is read the same way, and partial shaping is unchanged.
  const longKeeps = answerRowsOf(JSON.stringify({ 1: { keeplines: [[2, 3], words(200)] } }), [1],
    "keeplines-60");
  assert.equal(longKeeps[0].status, "answered");
  assert.deepEqual(longKeeps[0].answer.ranges, [{ from: 2, to: 3 }]);
});

test("an unknown --ask-grammar refuses by name before anything is read", t => {
  if (!requirePinnedWorld(t)) return;
  const result = spawnSync(process.execPath, [SCRIPT, "--ask-grammar", "twooption"],
    { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-grammar-invalid/);
  assert.throws(() => askMessageFor([unitOf(1)], new Map(), "twooption"), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-grammar-invalid");
});

// ---- jsonl-20: one JSON object per row per line (ISSUE-143) ----------------

/** The first trigger's share line, verbatim; it appears once before the table
 * and once after it, in these same bytes (ISSUE-194). */
const JSONL_20_FIRST_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 70 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/** The later trigger's share line; every fire after the first (ISSUE-194). */
const JSONL_20_LATER_TARGET =
  "Prune aggressively: drop anything the immediate task does not need; they can be restored anyway. "
  + "Across all rows together, keep at most 40 percent of the total lines. You can keep some units "
  + "whole and forget others whole if that meets it.";

/** The approved `jsonl-20` first-trigger pre-table prompt, byte for byte (the slot line last). */
const JSONL_20_PROMPT = [
  "Memory management: decide which tool results below stay in your memory. Forgotten ones are "
    + "purged, but can be restored later with a memory tool. Answer for every result in the table: "
    + "each row starts with the index you answer with, then the call that produced it, then quotes "
    + "from its own lines.",
  "",
  "Answer with one JSON object per row, one per line, and nothing else: no array, no commas "
    + "between lines, no markdown, no commentary. The key is that row's index as a string; the "
    + "value is that row's verdict, an object with exactly one action key.",
  "",
  "Rules:",
  "1. One object per line. One row per object. Nothing else on the line.",
  "2. Exactly one action key per row: keepall, forgetall, or keeplines.",
  "3. keepall carries nothing else. forgetall and keeplines must also carry forgotten: what is "
    + "being dropped and why.",
  "4. forgetall forgets the whole row. keeplines keeps the listed lines and forgets every line "
    + "not listed.",
  "5. keeplines is an ascending array of non-overlapping [start,end] pairs, integers, inside 1..L, "
    + "where L is that row's line count shown in the table.",
  "6. forgotten is one line of plain text, less than 20 words. It names what is being dropped and "
    + "why, so it can be recalled. It never describes the lines you keep. Use no raw newline. "
    + "Escape a double quote as \\\".",
  "7. Every row in the table appears exactly once. Add no other rows, keys, or text.",
  "8. Before sending, check each line: one object, one action key, forgotten present when "
    + "forgetting, ranges ascending and inside the row, and each line parses as JSON on its own.",
  "",
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  JSONL_20_FIRST_TARGET,
  "",
  "<rows: the table, one line per unit, each beginning with its index>",
].join("\n");

/** The later trigger's pre-table prompt: the same bytes, one share line replaced. */
const JSONL_20_LATER_PROMPT =
  JSONL_20_PROMPT.replace(JSONL_20_FIRST_TARGET, JSONL_20_LATER_TARGET);

/** The approved `jsonl-20` post-table repeat, byte for byte (the anchor line last). */
const JSONL_20_REPEAT = [
  "Answer format:",
  '{"N":{"keepall":true}}',
  '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
  '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  "Answer Example:",
  '{"1":{"keepall":true}}',
  '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
  '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
  '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  "",
  JSONL_20_FIRST_TARGET,
  "",
  ENTRY_ASK_END_ANCHOR,
].join("\n");

/** The later trigger's post-table repeat: the same bytes, one share line replaced. */
const JSONL_20_LATER_REPEAT =
  JSONL_20_REPEAT.replace(JSONL_20_FIRST_TARGET, JSONL_20_LATER_TARGET);

/** One unit whose body is `lines` text lines, for the table's L suffix. */
const linesUnitOf = (seq, lines) => ({
  ...unitOf(seq), text: Array.from({ length: lines }, (_, at) => `line ${String(at + 1)}`).join("\n"),
});

const JSONL_UNITS = [unitOf(1), linesUnitOf(2, 24), unitOf(3)];
const JSONL_NAMES = new Map([[1, "Read a.ts"], [3, "Read a.ts"]]);

/** The table `JSONL_UNITS` renders, byte for byte (ADR-0042: two spread quotes). */
const JSONL_20_TABLE = [
  '1. [Read a.ts] (call #1) — line 1 ends with "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
    + ' · line 2 ends with "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" [2 lines]',
  '2. [tool result] (call #1) — line 8 ends with "line 8" · line 16 ends with "line 16" [24 lines]',
  '3. [Read a.ts] (call #2) — line 1 ends with "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
    + ' · line 2 ends with "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" [2 lines]',
].join("\n");

/**
 * The ask a literal splice builds: the pinned prompt's own bytes split at the
 * slot, the table, then the repeat. `split`/`join` never reads the table for
 * patterns, so this is an independent expectation, not a re-run of the composer.
 */
const jsonlAskOfTable = (table, prompt = JSONL_20_PROMPT, repeat = JSONL_20_REPEAT) =>
  `${prompt.split(JSONL_20_SLOT).join(table)}\n\n${repeat}`;

test("jsonl-20 ships the approved pre-table bytes, and its slot renders the table in place", () => {
  assert.equal(JSONL_20_SUMMARY_WORDS, 30, "the reader tolerates 30 words");
  const prompt = instructionOf("jsonl-20");
  assert.equal(prompt, JSONL_20_PROMPT);
  assert.equal(ASK_GRAMMAR_PROMPTS["jsonl-20"], JSONL_20_PROMPT);
  assert.equal(prompt.split(JSONL_20_SLOT).length - 1, 1, "exactly one table slot");
  assert.ok(prompt.endsWith(`\n\n${JSONL_20_FIRST_TARGET}\n\n${JSONL_20_SLOT}`),
    "the pre-table block puts the forgetting-share line right before the table slot");
  assert.ok(prompt.includes("Answer format:"), "the format block is pre-table text too");
  assert.ok(prompt.includes("less than 20 words"), "the prompt asks for under 20");
  assert.ok(!prompt.includes(ENTRY_ASK_CLOSING_LINE), "the batch closing line is not this prompt's");
  const ask = askMessageFor(JSONL_UNITS, JSONL_NAMES, "jsonl-20");
  assert.ok(ask.endsWith(ENTRY_ASK_END_ANCHOR), "the rendered ask ends on the closing anchor");
  const at = prompt.indexOf(JSONL_20_SLOT);
  const prefix = prompt.slice(0, at);
  assert.ok(ask.startsWith(prefix), "every line before the slot is unchanged");
  const tail = `\n\n${JSONL_20_REPEAT}`;
  assert.ok(ask.endsWith(tail), "the post-table repeat follows the table, byte for byte");
  const table = ask.slice(prefix.length, ask.length - tail.length);
  assert.equal(table.split("\n").length, JSONL_UNITS.length, "one table line per unit");
  assert.ok(table.startsWith("1. [Read a.ts]"), "the table starts at row 1");
  assert.ok(table.includes("3. [Read a.ts]"), "the last row is last");
  // The share line appears twice on purpose: before the table and after it, and
  // both copies are the first trigger's.
  assert.equal(ask.split(JSONL_20_FIRST_TARGET).length - 1, 2,
    "the first trigger's share line appears twice");
  assert.ok(ask.indexOf(JSONL_20_FIRST_TARGET) < ask.indexOf(table), "first copy is pre-table");
  assert.ok(ask.lastIndexOf(JSONL_20_FIRST_TARGET) > ask.indexOf(table),
    "second copy is post-table");
});

test("jsonl-20's share line follows the fire: 70 percent first, 40 percent later (ISSUE-194)", () => {
  const ask = (firstTrigger, grammar = "jsonl-20") =>
    askMessageFor(JSONL_UNITS, JSONL_NAMES, grammar, "first", firstTrigger);
  // The first fire: the 70 percent line, twice, and never the 40 percent one.
  const first = ask(true);
  assert.equal(first.split(JSONL_20_FIRST_TARGET).length - 1, 2, "the 70 percent line, twice");
  assert.ok(!first.includes(JSONL_20_LATER_TARGET), "no 40 percent line on a first fire");
  // A later fire: the 40 percent line, twice, and never the 70 percent one.
  const later = ask(false);
  assert.equal(later.split(JSONL_20_LATER_TARGET).length - 1, 2, "the 40 percent line, twice");
  assert.ok(!later.includes(JSONL_20_FIRST_TARGET), "no 70 percent line on a later fire");
  // Same layout, one line moved: the literal splice of the later pins.
  const prompt = JSONL_20_LATER_PROMPT;
  const prefix = prompt.slice(0, prompt.indexOf(JSONL_20_SLOT));
  const suffix = `\n\n${JSONL_20_LATER_REPEAT}`;
  const table = later.slice(prefix.length, later.length - suffix.length);
  assert.equal(later, jsonlAskOfTable(table, JSONL_20_LATER_PROMPT, JSONL_20_LATER_REPEAT),
    "the later ask is the prompt, the table, then the repeat");
  assert.equal(table, JSONL_20_TABLE, "the table's bytes are the same on a later fire");
  // The flag is the slot grammars' alone: no other grammar's bytes move.
  for (const grammar of ASK_GRAMMARS.filter(name => !SLOT_GRAMMARS.has(name))) {
    assert.equal(ask(true, grammar), ask(false, grammar),
      `${grammar} has no per-fire share line`);
  }
});

// ---- the simulated surface (ISSUE-194) -------------------------------------

/** One result body with a unique token on every line, for the absence checks. */
const tokenBody = (name, lines) => Array.from({ length: lines },
  (_, at) => `${name} line ${String(at + 1)}: ${name}-${String(at + 1)}-token`).join("\n");

/**
 * A synthetic session with three results at fire 1's step and one at fire 2's:
 * the first will be forgotten, the second trimmed to lines 2–3, the third kept
 * whole. Each line carries a token no other unit shares, so "the prompt does not
 * contain this unit's text" is one substring check.
 */
const surfaceTranscript = () => [
  { type: "step/start", seq: 1, data: { step: 1 } },
  { type: "system/message", seq: 2,
    data: { message: { content: [{ type: "text", text: "system prompt" }] } } },
  { type: "tool/result", seq: 3, surfaceOp: "append",
    data: { step: 1, message: { content: [{ type: "text", text: tokenBody("FORGOTTEN", 5) }] } } },
  { type: "tool/result", seq: 4, surfaceOp: "append",
    data: { step: 1, message: { content: [{ type: "text", text: tokenBody("TRIMMED", 6) }] } } },
  { type: "tool/result", seq: 5, surfaceOp: "append",
    data: { step: 1, message: { content: [{ type: "text", text: tokenBody("KEPT", 4) }] } } },
  { type: "step/start", seq: 6, data: { step: 2 } },
  { type: "tool/result", seq: 7, surfaceOp: "append",
    data: { step: 2, message: { content: [{ type: "text", text: tokenBody("SECOND", 4) }] } } },
  { type: "session", seq: 8, id: "session-sim-surface" },
];

const joinedContent = prompt => prompt.messages.map(message => message.content).join("\n");

test("the next fire's prompt follows the last prune, not the raw transcript (ISSUE-194)", () => {
  const timeline = readTimeline(surfaceTranscript());
  const units = eligibleOf(timeline, 1);
  const fireOne = units.filter(unit => unit.step === 1);
  const fireTwo = units.filter(unit => unit.step === 2);
  assert.deepEqual(fireOne.map(unit => unit.seq), [3, 4, 5], "fire 1 asks three units");
  assert.deepEqual(fireTwo.map(unit => unit.seq), [7], "fire 2 asks the one new unit");
  const surface = simulateSurface();
  applyFireToSurface({ surface, timeline, units: fireOne, rows: [
    { index: 1, status: "answered",
      answer: { action: "forgetall", summary: "a stale build log from the old host" } },
    { index: 2, status: "answered",
      answer: { action: "keeplines", ranges: [{ from: 2, to: 3 }],
        summary: "the retry block only" } },
    { index: 3, status: "answered", answer: { action: "keepall" } },
  ] });
  // The map holds exactly the two shaped units; a keepall leaves no override.
  assert.deepEqual([...surface.keys()], [3, 4]);
  assert.equal(surface.has(5), false, "a keepall leaves the unit whole");

  // Non-vacuity: an EXPLICIT EMPTY surface (a run whose fire 1 removed nothing)
  // still carries the landed bodies. This deliberately builds a raw surface at
  // fire 1, which the live path refuses, so it uses the documented test-only
  // constructor; the guard's own test is below.
  const raw = joinedContent(promptForFire({ timeline, fireStep: 2, units: fireTwo,
    grammar: "jsonl-20", firstTrigger: false,
    surface: simulateSurface({ testOnly: true }), fireIndex: 1 }));
  assert.ok(raw.includes("FORGOTTEN line 1: FORGOTTEN-1-token"),
    "with an empty surface, the forgotten body is still in the context (non-vacuity)");
  assert.ok(raw.includes("TRIMMED line 1: TRIMMED-1-token"),
    "with an empty surface, the trimmed unit is still whole");

  const prompt = promptForFire({ timeline, fireStep: 2, units: fireTwo, grammar: "jsonl-20",
    firstTrigger: false, surface, fireIndex: 1 });
  const text = joinedContent(prompt);
  // The forgotten unit: no line of its body survives; its summary and the
  // product's empty-form marker are what the turn holds now.
  for (let line = 1; line <= 5; line += 1) {
    assert.ok(!text.includes(`FORGOTTEN-${String(line)}-token`),
      `a forgotten unit's line ${String(line)} is not in the next prompt`);
  }
  assert.ok(text.includes("a stale build log from the old host"),
    "the forgotten unit's summary is in the context");
  assert.match(text, /\[racoons\] kept 0 of 5 lines · necromancy recall:sha256:[0-9a-f]{64}/u,
    "the product's empty-form marker stands where the body was");
  // The trimmed unit: only the kept lines and the summary, plus the kept-range
  // marker naming the two lines that survived.
  for (const line of [1, 4, 5, 6]) {
    assert.ok(!text.includes(`TRIMMED-${String(line)}-token`),
      `a keeplines unit's unkept line ${String(line)} is not in the next prompt`);
  }
  for (const line of [2, 3]) {
    assert.ok(text.includes(`TRIMMED line ${String(line)}: TRIMMED-${String(line)}-token`),
      `a keeplines unit's kept line ${String(line)} is in the next prompt`);
  }
  assert.ok(text.includes("the retry block only"), "the keeplines summary is in the context");
  assert.match(
    text, /\[racoons\] kept lines 2–3 of 6 · \d+ bytes dropped · necromancy recall:sha256:[0-9a-f]{64}/u,
    "the product's kept-range marker names the lines that stayed");
  // A kept unit and the new unit are whole, as landed.
  for (let line = 1; line <= 4; line += 1) {
    assert.ok(text.includes(`KEPT line ${String(line)}: KEPT-${String(line)}-token`),
      "a keepall unit is still whole");
    assert.ok(text.includes(`SECOND line ${String(line)}: SECOND-${String(line)}-token`),
      "the newly eligible unit is whole");
  }
  // The share line is the later trigger's, and the model's own exchange is
  // absent: the only ask in the messages is the last one.
  assert.ok(prompt.ask.includes(JSONL_20_LATER_TARGET), "fire 2 states the 40 percent line");
  assert.ok(!prompt.ask.includes(JSONL_20_FIRST_TARGET), "fire 2 never states the 70 percent line");
  const asks = prompt.messages.filter(message => message.content.startsWith("Memory management"));
  assert.equal(asks.length, 1, "only this fire's ask is in the history");
  assert.equal(prompt.messages[prompt.messages.length - 1].content, prompt.ask,
    "the ask is the last message");
  // A refused row changes NOTHING: unit 7 was never shaped, so it stays whole;
  // unit 3 was shaped at fire 1, so a fire-2 refusal leaves that shape standing.
  const shapedBefore = surface.get(3);
  applyFireToSurface({ surface, timeline, units: fireTwo,
    rows: [{ index: 1, status: "refused", code: "missing-index" }] });
  assert.equal(surface.has(7), false, "a refused row leaves a never-shaped unit whole");
  applyFireToSurface({ surface, timeline, units: [fireOne[0]],
    rows: [{ index: 1, status: "refused", code: "missing-index" }] });
  assert.equal(surface.get(3), shapedBefore, "a refusal does not restore an earlier removal");
  // Only an ANSWERED keepall restores a shaped body.
  applyFireToSurface({ surface, timeline, units: [fireOne[0]],
    rows: [{ index: 1, status: "answered", answer: { action: "keepall" } }] });
  assert.equal(surface.has(3), false, "a keepall drops an earlier shaped override");
});

test("jsonl-20 shows every row's line count; the other grammars' tables do not", () => {
  const ask = askMessageFor(JSONL_UNITS, JSONL_NAMES, "jsonl-20");
  const prompt = instructionOf("jsonl-20");
  const at = prompt.indexOf(JSONL_20_SLOT);
  const prefix = prompt.slice(0, at);
  const tail = `\n\n${JSONL_20_REPEAT}`;
  const table = ask.slice(prefix.length, ask.length - tail.length);
  const lines = table.split("\n");
  assert.equal(lines.length, JSONL_UNITS.length, "still one table line per unit");
  // (a) Every row shows its own line count.
  assert.ok(lines[1].endsWith(" [24 lines]"), "the 24-line row ends with its count");
  assert.ok(lines[1].startsWith("2. [tool result]"), "the row's own text still comes first");
  assert.match(lines[0], / \[2 lines\]$/u, "a two-line row says 2 lines");
  assert.match(lines[2], / \[2 lines\]$/u);
  // (b) No other grammar's table gains the suffix.
  for (const grammar of ASK_GRAMMARS.filter(name => !SLOT_GRAMMARS.has(name))) {
    const other = askMessageFor(JSONL_UNITS, JSONL_NAMES, grammar);
    assert.ok(!/ \[\d+ lines?\]$/mu.test(other), `${grammar}'s table carries no line-count suffix`);
  }
  // (c) The pinned prompt keeps its bytes; the slot's table and the repeat are the
  // only pieces the composition adds.
  assert.equal(prompt, JSONL_20_PROMPT, "the approved prompt bytes are unchanged");
  assert.equal(JSONL_20_TABLE.split("\n").length, JSONL_UNITS.length, "one line per row");
  assert.equal(ask, jsonlAskOfTable(JSONL_20_TABLE),
    "the rendered ask is the pre-table prompt, the table, then the repeat");
  assert.equal(table, JSONL_20_TABLE, "the table ships its own bytes, unaltered");
  const shipped = askMessageFor(JSONL_UNITS, JSONL_NAMES, "3option");
  const shippedTable = shipped.slice(instructionOf("3option").length + 2,
    shipped.length - ENTRY_ASK_CLOSING_LINE.length - 2);
  assert.deepEqual(lines.map(line => line.replace(/ \[\d+ lines?\]$/u, "")),
    shippedTable.split("\n"), "the suffix is the only byte the table adds");
});

/**
 * The `jsonl-20` slot takes the table literally (ISSUE-172). A string
 * replacement performs `GetSubstitution`, so `` $` `` pasted the whole 1,972-byte
 * prefix into the row and `$&` pasted the 67-byte slot token.
 *
 * Row 1 is the real pair-2 shape: `result:360`'s line 54 quotes a
 * backtick-dollar-backtick, which is the one live hit in the 490-unit session.
 * Row 2 is a plain second row of the same length, because the reported case is a
 * two-row table. Both are 108 lines, so ADR-0042's spread rule quotes lines 36
 * and 72; the `$` line sits at 36.
 */
const jsonlDollarUnitsOf = () => [
  {
    ...unitOf(360), text: Array.from({ length: 108 },
      (_, at) => (at === 35 ? "whether `$` is accepted* (A6, M3" : `line ${String(at + 1)}`))
      .join("\n"),
  },
  {
    ...unitOf(361), text: Array.from({ length: 108 },
      (_, at) => (at === 35 ? "retry block was retried once verbatim" : `line ${String(at + 1)}`))
      .join("\n"),
  },
];

/** Every `$` form in one line: the four that expand, two that do not. */
const JSONL_20_DOLLAR_LINE = "$& $' $$ $1 $HOME `$`";

/** The anchors `anchorsFor` renders from {@link JSONL_20_DOLLAR_LINE}'s row. */
const JSONL_20_DOLLAR_ANCHOR =
  `line 36 ends with "${JSONL_20_DOLLAR_LINE}" · line 72 ends with "line 72"`;

test("jsonl-20's slot takes a $ -bearing table literally (ISSUE-172)", () => {
  const ask = askMessageFor(jsonlDollarUnitsOf(), new Map(), "jsonl-20");
  const prompt = instructionOf("jsonl-20");
  const at = prompt.indexOf(JSONL_20_SLOT);
  const prefix = prompt.slice(0, at);
  const tail = `\n\n${JSONL_20_REPEAT}`;
  const table = ask.slice(prefix.length, ask.length - tail.length);
  // The table the composer built: 258 B, byte for byte (`$`` in row 1's anchor).
  assert.equal(Buffer.byteLength(table, "utf8"), 258, "the table is the reported 258 B shape");
  assert.equal(table, [
    '1. [tool result] (call #1) — line 36 ends with "whether `$` is accepted* (A6, M3" · line 72 ends with "line 72" [108 lines]',
    '2. [tool result] (call #2) — line 36 ends with "retry block was retried once verbatim" · line 72 ends with "line 72" [108 lines]',
  ].join("\n"), "every anchor lands byte for byte");
  // The whole ask is the literal splice of that table, not an expansion of it.
  assert.equal(ask, jsonlAskOfTable(table), "the ask is the literal splice");
  assert.ok(ask.startsWith(prefix), "the pre-table prompt is still a prefix");
  assert.ok(!ask.includes(JSONL_20_SLOT), "the slot token is gone");
  // The bug, measured: a string replacement puts 2,474 B in the slot, not 258.
  // The prompt ends at the slot, so the region past its prefix is the slot's.
  const expanded = prompt.replace(JSONL_20_SLOT, table).slice(at);
  assert.equal(Buffer.byteLength(expanded, "utf8"), 2_474,
    "the old string replacement placed 2,474 B, not 258");
  assert.equal(Buffer.byteLength(expanded, "utf8") - Buffer.byteLength(table, "utf8"), 2_216,
    "the inflation is the 2,218-byte prefix less the two bytes of $`");
});

test("jsonl-20 keeps $&, $', $$ and $` verbatim, and leaves $1 and $HOME alone", () => {
  const unit = {
    ...unitOf(360),
    text: Array.from({ length: 108 },
      (_, at) => (at === 35 ? JSONL_20_DOLLAR_LINE : `line ${String(at + 1)}`)).join("\n"),
  };
  const ask = askMessageFor([unit], new Map(), "jsonl-20");
  const prompt = instructionOf("jsonl-20");
  const prefix = prompt.slice(0, prompt.indexOf(JSONL_20_SLOT));
  const tail = `\n\n${JSONL_20_REPEAT}`;
  const table = ask.slice(prefix.length, ask.length - tail.length);
  assert.equal(table, `1. [tool result] (call #1) — ${JSONL_20_DOLLAR_ANCHOR} [108 lines]`,
    "the row ships its own bytes");
  for (const token of ["$&", "$'", "$$", "`$`", "$1", "$HOME"]) {
    assert.ok(table.includes(token), `${token} survives verbatim`);
  }
  assert.equal(ask, jsonlAskOfTable(table), "the ask is that table, spliced literally");
  assert.ok(ask.startsWith(prefix), "the pre-table prefix is intact");
});

test("every example line in the jsonl-20 ask parses as JSON (7 of 7)", () => {
  const lines = askMessageFor(JSONL_UNITS, JSONL_NAMES, "jsonl-20").split("\n");
  const templates = [
    '{"N":{"keepall":true}}',
    '{"N":{"forgetall":true,"forgotten":"<forgotten>"}}',
    '{"N":{"keeplines":[[start,end], ...],"forgotten":"<forgotten>"}}',
  ];
  const filled = [
    '{"1":{"keepall":true}}',
    '{"2":{"forgetall":true,"forgotten":"stale build log from the old host"}}',
    '{"3":{"keeplines":[[1,3],[11,18],[37,40]],"forgotten":"the stale build log and the old host block"}}',
    '{"4":{"keeplines":[[5,12]],"forgotten":"the imports and the stale fixture setup"}}',
  ];
  const taught = lines.filter(line => templates.includes(line));
  assert.deepEqual(taught, [...templates, ...templates],
    "the three template lines appear in order in both halves");
  for (const line of filled) assert.ok(lines.includes(line), `the prompt teaches ${line}`);
  // The first two templates are JSON as written. The third is a SHAPE: `start`,
  // `end` and `...` are placeholders, so substitute them before parsing.
  JSON.parse(templates[0]);
  JSON.parse(templates[1]);
  const shaped = templates[2].replace("start", "1").replace("end", "2").replace(", ...", "");
  const parsed = [templates[0], templates[1], shaped, ...filled].map(line => JSON.parse(line));
  assert.equal(parsed.length, 7, "7 of 7 example lines parse");
  // The four filled lines are one answer the reader accepts, not just JSON.
  const rows = answerRowsOf(filled.join("\n"), [1, 2, 3, 4], "jsonl-20",
    { lineCounts: new Map([[3, 40], [4, 40]]) });
  assert.deepEqual(rows.map(row => row.status),
    ["answered", "answered", "answered", "answered"]);
  assert.deepEqual(rows.map(row => row.answer.action),
    ["keepall", "forgetall", "keeplines", "keeplines"]);
});

test("jsonl-20 reads one object per line as one row each", () => {
  const text = [1, 2, 3, 4].map(index => `{"${index}":{"keepall":true}}`).join("\n");
  const rows = answerRowsOf(text, [1, 2, 3, 4], "jsonl-20", { lineCounts: new Map() });
  assert.deepEqual(rows.map(row => row.status),
    ["answered", "answered", "answered", "answered"]);
  assert.deepEqual(rows.map(row => row.answer.action),
    ["keepall", "keepall", "keepall", "keepall"]);
});

test("jsonl-20 accepts a 30-word summary and refuses 31; the prompt asks for under 20", () => {
  const words = count => Array.from({ length: count }, (_, at) => `w${String(at)}`).join(" ");
  const read = count => answerRowsOf(
    JSON.stringify({ 1: { forgetall: true, summary: words(count) } }), [1], "jsonl-20",
    { lineCounts: new Map() })[0];
  assert.equal(read(8).status, "answered", "a short summary is answered");
  assert.equal(read(30).status, "answered", "the reader tolerates up to 30");
  assert.equal(read(31).status, "refused");
  assert.equal(read(31).code, SUMMARY_TOO_LONG_CODE);
  const detail = answerDetailsOf(
    JSON.stringify({ 1: { forgetall: true, summary: words(31) } }), [1], "jsonl-20",
    { lineCounts: new Map() }).get(1);
  assert.equal(detail.wireCode, SUMMARY_TOO_LONG_CODE);
  assert.match(detail.message, /30 words/);
});

test("jsonl-20 keeplines covering every line is keep-whole; a partial range keeps its lines", () => {
  const lineCounts = new Map([[1, 4]]);
  const whole = answerRowsOf('{"1":{"keeplines":[[1,4]],"summary":"all four"}}', [1],
    "jsonl-20", { lineCounts })[0];
  assert.equal(whole.status, "answered", "an all-lines keep is legal here");
  assert.equal(keepsWholeOf(whole.answer, 4), true, "it removes nothing");
  assert.equal(keptLineCountOf(whole.answer, 4), 4);
  assert.equal(arithmeticCodeOf(whole.answer, 4, "jsonl-20"), null, "no correction is earned");
  const touching = answerRowsOf('{"1":{"keeplines":[[1,2],[3,4]],"summary":"all four"}}', [1],
    "jsonl-20", { lineCounts })[0];
  assert.equal(keepsWholeOf(touching.answer, 4), true, "touching spans cover the whole row");
  const partial = answerRowsOf('{"1":{"keeplines":[[2,3]],"summary":"the middle"}}', [1],
    "jsonl-20", { lineCounts })[0];
  assert.equal(partial.status, "answered");
  assert.equal(keepsWholeOf(partial.answer, 4), false);
  assert.equal(keptLineCountOf(partial.answer, 4), 2, "keptLines counts the named lines");
  assert.deepEqual(partial.answer.ranges, [{ from: 2, to: 3 }]);
});

test("jsonl-20 refuses a keepall with an extra key as mixed-keys and a false keepall", () => {
  const read = text => answerRowsOf(text, [1], "jsonl-20", { lineCounts: new Map() })[0];
  const extra = read('{"1":{"keepall":true,"summary":"x"}}');
  assert.equal(extra.status, "refused");
  assert.equal(extra.code, "mixed-keys");
  assert.equal(read('{"1":{"keepall":true,"forgetall":true}}').code, "mixed-keys");
  assert.equal(read('{"1":{"forgetall":true,"summary":"x","note":"y"}}').code, "mixed-keys");
  const off = read('{"1":{"keepall":false}}');
  assert.equal(off.status, "refused");
  assert.equal(off.code, GRAMMAR_GATE_CODE, "a keepall that is not true is not this grammar's");
  assert.equal(read('{"1":{"summary":"x"}}').code, GRAMMAR_GATE_CODE, "no action key");
});

test("jsonl-20 refuses a forgetall that is not exactly true as malformed-row", () => {
  const text = '{"1":{"forgetall":"old wire summary"}}\n{"2":{"keepall":true}}';
  const rows = answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() });
  assert.equal(rows[0].status, "refused");
  assert.equal(rows[0].code, "malformed-row", "a summary string in the flag's place refuses");
  assert.equal(rows[1].status, "answered", "the other row is untouched");
  const read = line => answerRowsOf(line, [1], "jsonl-20", { lineCounts: new Map() })[0];
  assert.equal(read('{"1":{"forgetall":false,"summary":"s"}}').code, "malformed-row");
  assert.equal(read('{"1":{"forgetall":1,"summary":"s"}}').code, "malformed-row");
  assert.equal(read('{"1":{"forgetall":"s","summary":"s"}}').code, "malformed-row");
  assert.equal(read('{"1":{"forgetall":true,"summary":"gone"}}').status, "answered");
  const detail = answerDetailsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() }).get(1);
  assert.equal(detail.wireCode, "malformed-row");
  assert.match(detail.message, /not exactly true/);
});

test("jsonl-20 refuses a forgetall without a summary and keeps the other rows", () => {
  const text = '{"1":{"forgetall":true}}\n{"2":{"keepall":true}}';
  const rows = answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() });
  assert.equal(rows[0].status, "refused");
  assert.equal(rows[0].code, "summary-missing");
  assert.equal(rows[1].status, "answered", "the missing summary costs that row only");
  const detail = answerDetailsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() }).get(1);
  assert.equal(detail.wireCode, "summary-missing");
  assert.match(detail.message, /without a forgotten value/);
});

test("jsonl-20 range violations carry bad-range, ranges-unordered and spans-outside-result", () => {
  const lineCounts = new Map([[1, 10]]);
  const row = text => answerRowsOf(text, [1], "jsonl-20", { lineCounts })[0];
  const keeps = ranges => `{"1":{"keeplines":${ranges},"summary":"s"}}`;
  assert.equal(row(keeps("[[3,4],[1,2]]")).code, "ranges-unordered", "unsorted");
  assert.equal(row(keeps("[[1,3],[3,4]]")).code, "ranges-unordered", "overlapping at a line");
  assert.equal(row(keeps("[[0,2]]")).code, "bad-range", "zero is not a line");
  assert.equal(row(keeps("[[4,2]]")).code, "bad-range", "a reversed pair is not a range");
  assert.equal(row(keeps('[[\"1\",2]]')).code, "bad-range", "a string is not an integer");
  assert.equal(row(keeps("[[1,11]]")).code, "spans-outside-result", "end past L");
  assert.equal(row(keeps("[[11,12]]")).code, "spans-outside-result", "start past L");
  assert.equal(row(keeps("[]")).code, "bad-range", "no ranges is not a keep");
  assert.equal(row(keeps("[[1,2],[3,4]]")).status, "answered", "touching in-bounds spans read");
});

test("jsonl-20 makes an answer of blank lines alone answer-unreadable", () => {
  for (const text of ["", "   \n\t\n  ", `${ENTRY_ASK_END_ANCHOR}\n`]) {
    const rows = answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() });
    assert.deepEqual(rows.map(row => row.code), ["answer-unreadable", "answer-unreadable"],
      `${JSON.stringify(text)} carries no verdict to read`);
  }
});

test("jsonl-20 names its refusal vocabulary once", () => {
  assert.deepEqual([...JSONL_20_REFUSAL_CODES], [
    "answer-unreadable", "unknown-index", "duplicate-index", "missing-index",
    "action-not-in-grammar", "malformed-row", "mixed-keys",
    "both-forgotten-and-summary", "summary-missing",
    "summary-too-long", "bad-range", "ranges-unordered", "spans-outside-result",
  ]);
});

test("jsonl-20 decisions ARE core's reader: every refusal code and action shape agrees", () => {
  // Twelfth audit item 1: the sim used to route `jsonl-20` through its own copy
  // of the reader, so no test compared the decisions to the shipped parser. The
  // copy is gone (`answerRowsOf` calls `readJsonl20Answer`), and this grid is the
  // parity gate: the two must agree on every status, code and action, or this
  // test is red.
  assert.equal(DEFAULT_ASK_GRAMMAR, DEFAULT_ENTRY_ASK_GRAMMAR,
    "a no-flag sim run measures the product's default grammar");
  const indices = [1, 2, 3];
  const lineCounts = new Map([[1, 10], [2, 4], [3, 1]]);
  const words = count => Array.from({ length: count }, (_, at) => `w${String(at)}`).join(" ");
  const cases = [
    // Every action shape, one answer.
    '{"1":{"keepall":true}}\n{"2":{"forgetall":true,"forgotten":"gone"}}'
      + '\n{"3":{"keeplines":[[1,1]],"forgotten":"head"}}',
    // both-forgotten-and-summary: the canonical key and its legacy alias together.
    '{"1":{"keeplines":[[1,1]],"forgotten":"f","summary":"s"}}\n{"2":{"keepall":true}}'
      + '\n{"3":{"keepall":true}}',
    // answer-unreadable: one broken line that still spells its row, and the
    // whole-answer refusal (prose, empty, anchor only).
    '{"1":{"keepall":true}}\n{"2":{"keepall":true}\n{"3":{"keepall":true}}',
    "not json at all",
    "",
    `${ENTRY_ASK_END_ANCHOR}\n`,
    // missing-index and a duplicate that supersedes its first reading.
    '{"1":{"keepall":true}}',
    '{"1":{"keepall":true}}\n{"1":{"forgetall":true,"summary":"second"}}'
      + '\n{"2":{"keepall":true}}\n{"3":{"keepall":true}}',
    // mixed-keys: two rows on one line, and one action key beside an extra key.
    '{"1":{"keepall":true},"2":{"keepall":true}}\n{"3":{"keepall":true}}',
    '{"1":{"keepall":true,"summary":"x"}}\n{"2":{"forgetall":true,"summary":"s","note":"n"}}'
      + '\n{"3":{"keeplines":[[1,1]],"summary":"s","keepall":true}}',
    // action-not-in-grammar: no action key, a false keepall, a non-object value.
    '{"1":{"summary":"x"}}\n{"2":{"keepall":false}}\n{"3":[]}',
    // malformed-row: the old wire shape (a string in forgetall's place).
    '{"1":{"forgetall":"old summary","summary":"s"}}\n{"2":{"forgetall":1,"summary":"s"}}'
      + '\n{"3":{"keepall":true}}',
    // summary-missing, a summary just inside and just past the 30-word tolerance.
    '{"1":{"forgetall":true}}\n{"2":{"forgetall":true,"summary":"' + words(30) + '"}}'
      + '\n{"3":{"forgetall":true,"summary":"' + words(31) + '"}}',
    // bad-range, ranges-unordered, spans-outside-result against each row's own L.
    '{"1":{"keeplines":[],"summary":"s"}}\n{"2":{"keeplines":[[3,4],[1,2]],"summary":"s"}}'
      + '\n{"3":{"keeplines":[[1,2]],"summary":"past L=1"}}',
    '{"1":{"keeplines":[["1",2]],"summary":"s"}}\n{"2":{"keeplines":[[4,2]],"summary":"s"}}'
      + '\n{"3":{"keeplines":[[1,1],[1,1]],"summary":"s"}}',
  ];
  const seen = new Set();
  for (const text of cases) {
    const sim = answerRowsOf(text, indices, "jsonl-20", { lineCounts })
      .map(row => row.status === "answered"
        ? { index: row.index, status: row.status, answer: row.answer }
        : { index: row.index, status: row.status, code: row.code });
    const core = parseEntryBatchAnswer(text, indices, "jsonl-20", lineCounts)
      .map(row => row.status === "answered"
        ? { index: row.index, status: row.status, answer: row.answer }
        : { index: row.index, status: row.status, code: row.code });
    assert.deepEqual(sim, core, `the sim and core disagree on ${JSON.stringify(text)}`);
    for (const row of core) if (row.status === "refused") seen.add(row.code);
  }
  // unknown-index is a REJECTION, never a row refusal: compare it on its own.
  const stray = '{"9":{"keepall":true}}\n{"1":{"keepall":true}}';
  assert.deepEqual(jsonl20RejectionsOf(stray, indices, lineCounts),
    coreJsonl20RejectionsOf(stray, indices, lineCounts),
    "a key that names no assigned row is the same rejection on both readers");
  const expected = new Set(JSONL_20_REFUSAL_CODES.filter(code => code !== "unknown-index"));
  assert.deepEqual([...seen].sort(), [...expected].sort(),
    "the grid reaches every row refusal code the vocabulary names");
});

test("jsonl-20 refuses a missing, duplicate or unknown row without touching the others", () => {
  const lineCounts = new Map([[1, 4], [2, 4]]);
  const missing = answerRowsOf('{"1":{"keepall":true}}', [1, 2], "jsonl-20", { lineCounts });
  assert.equal(missing[0].status, "answered");
  assert.equal(missing[1].status, "refused");
  assert.equal(missing[1].code, "missing-index");
  const duplicate = answerRowsOf(
    '{"1":{"keepall":true}}\n{"1":{"forgetall":true,"summary":"s"}}\n{"2":{"keepall":true}}',
    [1, 2], "jsonl-20", { lineCounts });
  assert.equal(duplicate[0].status, "refused");
  assert.equal(duplicate[0].code, "duplicate-index");
  assert.equal(duplicate[1].status, "answered", "the duplicate never touches row 2");
  const text = '{"9":{"keepall":true}}\n{"1":{"keepall":true}}\n{"2":{"keepall":true}}';
  const rows = answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts });
  assert.deepEqual(rows.map(row => row.status), ["answered", "answered"]);
  const rejected = jsonl20RejectionsOf(text, [1, 2], lineCounts);
  assert.deepEqual(rejected.map(entry => [entry.key, entry.index, entry.code]),
    [["9", 9, "unknown-index"]]);
});

test("jsonl-20 refuses a bad line's own row, never the whole answer (ISSUE-187)", () => {
  const rows = text => answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() });
  // A non-JSON line that names no row moves no unit.
  assert.deepEqual(rows('{"1":{"keepall":true}}\nnot json\n{"2":{"keepall":true}}')
    .map(row => row.status), ["answered", "answered"]);
  // A non-JSON line that still spells its leading index refuses that row only.
  const unclosed = answerRowsOf('{"1":{"keepall":true}}\n{"2":{"keepall":true}\n'
    + '{"3":{"keepall":true}}', [1, 2, 3], "jsonl-20", { lineCounts: new Map() });
  assert.deepEqual(unclosed.map(row => [row.status, row.code ?? null]),
    [["answered", null], ["refused", "answer-unreadable"], ["answered", null]]);
  // One line naming two rows refuses each of them `mixed-keys` and applies
  // neither verdict.
  const twoKeys = rows('{"1":{"keepall":true},"2":{"keepall":true}}');
  assert.deepEqual(twoKeys.map(row => row.code), ["mixed-keys", "mixed-keys"]);
  // A JSON scalar moves no unit; the row it would have answered is missing.
  const scalar = rows('{"1":{"keepall":true}}\n42');
  assert.equal(scalar[0].status, "answered");
  assert.equal(scalar[1].code, "missing-index");
  // A stray second top-level key on a row's own line refuses that row only.
  const stray = answerRowsOf('{"1":{"keepall":true}}\n'
    + '{"2":{"forgetall":true,"summary":"old log"},"keepall":false}\n'
    + '{"3":{"keepall":true}}', [1, 2, 3], "jsonl-20", { lineCounts: new Map() });
  assert.deepEqual(stray.map(row => [row.status, row.code ?? null]),
    [["answered", null], ["refused", "mixed-keys"], ["answered", null]]);
  // Only an answer carrying no verdict at all still refuses as a whole.
  for (const none of ["", "   \n\t\n  ", "no verdict here", "{}", "42"]) {
    assert.deepEqual(rows(none).map(row => row.code),
      ["answer-unreadable", "answer-unreadable"],
      `${JSON.stringify(none)} carries no verdict to read`);
  }
});

test("jsonl-20 ignores blank lines and one trailing entry-ask-end line", () => {
  const text = '\n{"1":{"keepall":true}}\n\n'
    + '{"2":{"forgetall":true,"summary":"old log"}}\n'
    + `${ENTRY_ASK_END_ANCHOR}\n\n`;
  const rows = answerRowsOf(text, [1, 2], "jsonl-20", { lineCounts: new Map() });
  assert.deepEqual(rows.map(row => row.status), ["answered", "answered"]);
  const middle = '{"1":{"keepall":true}}\n' + ENTRY_ASK_END_ANCHOR + '\n{"2":{"keepall":true}}';
  const rowsMiddle = answerRowsOf(middle, [1, 2], "jsonl-20", { lineCounts: new Map() });
  assert.deepEqual(rowsMiddle.map(row => row.status), ["answered", "answered"],
    "an anchor in the middle is not JSON, names no row, and moves no unit");
});

test("jsonl-20 refuses a non-first ask order by name", t => {
  if (!requirePinnedWorld(t)) return;
  assert.equal(assertOrderForGrammar("jsonl-20", "first").order, "first");
  assert.throws(() => assertOrderForGrammar("jsonl-20", "both"), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-order-grammar");
  assert.equal(assertOrderForGrammar("two-option", "both").order, "both",
    "the other grammars still compose with every order");
  const result = spawnSync(process.execPath, [SCRIPT, "--ask-grammar", "jsonl-20",
    "--ask-order", "after"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-order-grammar/);
});

// ---- phase 4 orders: one teaching block, three positions ------------------

const ORDER_UNITS = [unitOf(1), unitOf(2), unitOf(3)];
const ORDER_NAMES = new Map([[1, "Read a.ts"], [3, "Read a.ts"]]);

/** A `first`-layout ask split into its block, its table and its closing line. */
function piecesOf(ask, instruction) {
  const prefix = `${instruction}\n\n`;
  const suffix = `\n\n${ENTRY_ASK_CLOSING_LINE}`;
  assert.ok(ask.startsWith(prefix), "the block opens a first-layout ask");
  assert.ok(ask.endsWith(suffix), "the closing anchor is last");
  return { prefix, suffix, table: ask.slice(prefix.length, ask.length - suffix.length) };
}

test("order first is today's layout, byte for byte, under every grammar", () => {
  const shipped = entryBatchAskMessage(askRowsOf(ORDER_UNITS, ORDER_NAMES), "3option");
  assert.equal(askMessageFor(ORDER_UNITS, ORDER_NAMES, "3option", "first"), shipped);
  assert.equal(askMessageFor(ORDER_UNITS, ORDER_NAMES, "3option", DEFAULT_ASK_ORDER), shipped);
  assert.equal(askMessageFor(ORDER_UNITS, ORDER_NAMES),
    askMessageFor(ORDER_UNITS, ORDER_NAMES, DEFAULT_ASK_GRAMMAR),
    "no flags is the product default's exact bytes");
  assert.equal(askMessageFor(ORDER_UNITS, ORDER_NAMES),
    askMessageFor(ORDER_UNITS, ORDER_NAMES, "jsonl-20"),
    "the default grammar is the product's, jsonl-20");
  for (const grammar of ASK_GRAMMARS) {
    assert.equal(askMessageFor(ORDER_UNITS, ORDER_NAMES, grammar, "first"),
      askMessageFor(ORDER_UNITS, ORDER_NAMES, grammar), `${grammar} first is the no-order bytes`);
  }
  for (const grammar of ASK_GRAMMARS.filter(name => !SLOT_GRAMMARS.has(name))) {
    const pieces = piecesOf(askMessageFor(ORDER_UNITS, ORDER_NAMES, grammar, "first"),
      instructionOf(grammar));
    assert.equal(pieces.table.split("\n").length, ORDER_UNITS.length, "one table line per row");
  }
  // A slot grammar has no separate block to move: its table is a slot inside the
  // prompt, and only `first` applies.
  for (const grammar of SLOT_GRAMMARS) {
    const slot = askMessageFor(ORDER_UNITS, ORDER_NAMES, grammar);
    assert.ok(!slot.includes(JSONL_20_SLOT), `${grammar}: the slot is replaced`);
    assert.ok(slot.includes("1. [Read a.ts] (call #1)"), `${grammar}: the table is the rows`);
    assert.throws(() => askMessageFor(ORDER_UNITS, ORDER_NAMES, grammar, "after"), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-order-grammar");
  }
});

test("order after: the rows, then the same instruction, then the closing anchor", () => {
  const instruction = ASK_GRAMMAR_PROMPTS["two-option"];
  const first = askMessageFor(ORDER_UNITS, ORDER_NAMES, "two-option");
  const { prefix, suffix, table } = piecesOf(first, instruction);
  assert.equal(first, `${prefix}${table}${suffix}`, "first is the same pieces, block first");
  const after = askMessageFor(ORDER_UNITS, ORDER_NAMES, "two-option", "after");
  assert.equal(after, `${table}\n\n${instruction}${suffix}`, "rows, block, closing line");
  assert.ok(after.startsWith("1. [Read a.ts]"), "the table comes first");
  assert.ok(after.indexOf("There is no line-level option") > after.indexOf("[Read a.ts]"),
    "the block follows the rows");
  assert.ok(after.endsWith(ENTRY_ASK_CLOSING_LINE), "the closing anchor is last");
  assert.equal(after.split(ENTRY_ASK_CLOSING_LINE).length - 1, 1, "one closing anchor");
  assert.equal(Buffer.byteLength(after, "utf8"), Buffer.byteLength(first, "utf8"),
    "moving the block changes no byte count");
});

test("order both: the same instruction before and after the table, word for word", () => {
  const instruction = ASK_GRAMMAR_PROMPTS["two-option"];
  const first = askMessageFor(ORDER_UNITS, ORDER_NAMES, "two-option");
  const { prefix, suffix, table } = piecesOf(first, instruction);
  const both = askMessageFor(ORDER_UNITS, ORDER_NAMES, "two-option", "both");
  assert.equal(both, `${prefix}${table}\n\n${instruction}${suffix}`);
  assert.equal(both.split(instruction).length - 1, 2, "the block appears exactly twice");
  assert.ok(both.indexOf(instruction) < both.indexOf("[Read a.ts]"), "first copy before the rows");
  assert.ok(both.lastIndexOf(instruction) > both.lastIndexOf("[Read a.ts]"),
    "second copy after the rows");
  assert.ok(both.endsWith(ENTRY_ASK_CLOSING_LINE), "the closing anchor is last");
  assert.equal(both.split(ENTRY_ASK_CLOSING_LINE).length - 1, 1, "one closing anchor");
  assert.equal(Buffer.byteLength(both, "utf8"),
    Buffer.byteLength(first, "utf8") + Buffer.byteLength(instruction, "utf8") + 2,
    "both is first plus one more copy of the block and its blank line");
});

test("order and grammar compose: a moved two-option block still teaches only two options", () => {
  for (const order of ASK_ORDERS) {
    const ask = askMessageFor(ORDER_UNITS, ORDER_NAMES, "two-option", order);
    assert.ok(!ask.includes("keeplines") && !ask.includes("forgetlines"),
      `${order} teaches no range action`);
    assert.ok(ask.includes("There is no line-level option"), `${order} keeps A1's sentence`);
    assert.ok(ask.endsWith(`\n\n${ENTRY_ASK_CLOSING_LINE}`), `${order} ends on the anchor`);
    const rows = answerRowsOf('{"1":{"keepall":true},"2":{"forgetall":"stale"}}', [1, 2],
      "two-option");
    assert.deepEqual(rows.map(row => row.status), ["answered", "answered"],
      `${order} never reaches the parser, so the reading is the same`);
  }
  for (const order of ASK_ORDERS) {
    const ask = askMessageFor(ORDER_UNITS, ORDER_NAMES, "3option", order);
    assert.ok(ask.includes(instructionOf("3option")), `${order} ships the shipped block`);
    assert.ok(ask.includes("[Read a.ts]"), `${order} ships the same rows`);
    assert.ok(ask.endsWith(ENTRY_ASK_CLOSING_LINE), `${order} ends on the anchor`);
  }
  const timeline = timelineOf(ORDER_UNITS);
  const sizes = ASK_ORDERS.map(order => promptForFire({
    timeline, fireStep: 3, units: ORDER_UNITS, grammar: "two-option", order,
    surface: new Map(), fireIndex: 0 }).askBytes);
  assert.equal(sizes[1], sizes[0], "after is the same bytes, moved");
  assert.ok(sizes[2] > sizes[1], "both adds exactly one more block");
});

test("an unknown --ask-order refuses by name before anything is read", t => {
  if (!requirePinnedWorld(t)) return;
  const result = spawnSync(process.execPath, [SCRIPT, "--ask-order", "middle"],
    { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-order-invalid/);
  assert.throws(() => askMessageFor([unitOf(1)], new Map(), DEFAULT_ASK_GRAMMAR, "middle"), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-order-invalid");
});

// ---- ask scope: new is today's table, kept adds the still-kept rows --------

test("ask scope: new is the default, kept is the only other, and one row per unitId", () => {
  assert.deepEqual(ASK_SCOPES, ["new", "kept"]);
  assert.equal(DEFAULT_ASK_SCOPE, "new");
  assert.equal(assertAskScope(), "new", "no flag is today's table");
  assert.equal(assertAskScope("kept"), "kept");
  assert.throws(() => assertAskScope("all"), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-ask-scope-invalid");
  const kept = new Map([["result:2", unitOf(2)], ["result:1", unitOf(1)]]);
  const table = tableUnitsOf({ kept, pending: [unitOf(1), unitOf(3)] });
  assert.deepEqual(table.map(unit => unit.id), ["result:2", "result:1", "result:3"],
    "kept rows first in first-asked order, then new rows, never twice");
});

// ---- the auditor's gates: labels, quote gating, prompt bytes, deep gates ----

test("the row label is the product's own string: <name> <target>", t => {
  // The product reads the call's structured input with `targetFromInput`
  // (`plugin.ts` `callLabelOf`): `read`/`write`/`edit` name file_path, grep-like
  // tools name pattern, and a tool that names neither keeps its bare name.
  assert.equal(callLabelOf("read", '{"file_path":"config.ts"}'), "read config.ts");
  assert.equal(callLabelOf("grep", '{"pattern":"TODO"}'), "grep TODO");
  assert.equal(callLabelOf("pwsh", '{"command":"ls"}'), "pwsh");
  assert.equal(callLabelOf("read", "not json"), "read");
  assert.equal(callLabelOf("", null), "tool result");
  assert.equal(callLabelOf("", '{"file_path":"x"}'), "tool result x");
  // The transcript path uses the same rule: a tool/call row's arguments supply
  // the target, and the result row carries that call's label.
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/call", seq: 2,
      data: { callId: "c1", name: "read", arguments: '{"file_path":"docs/a.md"}' } },
    { type: "tool/result", seq: 3, surfaceOp: "append",
      data: { step: 1, message: { toolCallId: "c1",
        content: [{ type: "text", text: `${"a".repeat(600)}\n${"b".repeat(600)}` }] } } },
    { type: "tool/call", seq: 4,
      data: { callId: "c2", name: "grep", arguments: '{"pattern":"needle"}' } },
    { type: "tool/result", seq: 5, surfaceOp: "append",
      data: { step: 1, message: { toolCallId: "c2",
        content: [{ type: "text", text: `${"c".repeat(600)}\n${"d".repeat(600)}` }] } } },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.callNames.get(3), "read docs/a.md");
  assert.equal(timeline.callNames.get(5), "grep needle");
  const shown = surfaceAt({ timeline, fireStep: 1, surface: new Map(), fireIndex: 0 });
  assert.ok(shown.rows.some(row => row.seq === 3 && row.text.startsWith("read docs/a.md:\n")),
    "the live surface turn carries the product label");
  const ask = askMessageFor(eligibleOf(timeline, 1), timeline.callNames, "3option");
  assert.ok(ask.includes("[read docs/a.md]"), "the ask table carries it too");
  // The real transcript: the host's own lowercase tool names and targets. This
  // claims the pinned world, so a missing input SKIPS through `requirePinnedWorld`
  // (loudly, naming both paths) instead of failing.
  if (!requirePinnedWorld(t)) return;
  {
    const real = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
    const labels = [...real.callNames.values()];
    assert.ok(labels.includes("read AGENTS.md"), "a real read row names its file");
    assert.ok(labels.some(label => label.startsWith("grep ")), "a real grep row names its pattern");
    assert.ok(labels.every(label => !label.endsWith(" result")),
      "no row ships the old '<name> result' shorthand");
  }
});

test("a row that cannot show two quotes is never tabled (ADR-0042 Decision 5)", () => {
  const oneLine = unitOf(1, { bytes: 4000 });
  oneLine.text = "a".repeat(4000);
  const twoLines = unitOf(2, { bytes: 4000 });
  assert.equal(factsShowTwoQuotes(factsOf(oneLine.text)), false);
  assert.equal(factsShowTwoQuotes(factsOf(twoLines.text)), true);
  const timeline = timelineOf([oneLine, twoLines]);
  assert.deepEqual(eligibleOf(timeline, 512).map(unit => unit.seq), [2],
    "only the row with two quote lines is eligible");
  const pins = surfacePinsOf(timeline);
  assert.equal(pins.eligible, 1, "the pins read the same gated stream");
});

test("jsonl-20 derives its prompt bytes from the product, both share-line variants", () => {
  // The product's own constants (assets-templates.ts) vs this module's copy:
  // one byte of drift on either side is red for the 70 percent and the 40
  // percent variants, pre-table and post-table alike.
  assert.equal(ASK_GRAMMAR_PROMPTS["jsonl-20"], PRUNE_ASK_JSONL_20_SYSTEM_PROMPT,
    "the first-trigger pre-table prompt is the product's bytes");
  assert.equal(JSONL_20_VARIANTS.first.repeat, PRUNE_ASK_JSONL_20_REPEAT,
    "the first-trigger repeat is the product's bytes");
  assert.equal(JSONL_20_VARIANTS.later.prompt, PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT,
    "the later pre-table prompt is the product's bytes");
  assert.equal(JSONL_20_VARIANTS.later.repeat, PRUNE_ASK_JSONL_20_LATER_REPEAT,
    "the later repeat is the product's bytes");
  assert.notEqual(PRUNE_ASK_JSONL_20_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT,
    "the two variants are not the same bytes");
});

test("the sim's [N line(s)] suffix is the product's own jsonl-20 row, byte for byte", () => {
  // The suffix used to be the sim's own invention, checked against nothing: only
  // the prompt constants were compared. The product's `entryBatchAskMessage`
  // renders the same rows under `jsonl-20`, suffix included, so the whole
  // message is compared — a divergent suffix is red here.
  const rows = askRowsOf(ORDER_UNITS, ORDER_NAMES);
  for (const firstTrigger of [true, false]) {
    assert.equal(
      askMessageFor(ORDER_UNITS, ORDER_NAMES, "jsonl-20", "first", firstTrigger),
      entryBatchAskMessage(rows, "jsonl-20", firstTrigger),
      `${firstTrigger ? "first" : "later"} trigger: the sim's ask is the product's bytes`);
  }
  const sim = askMessageFor(ORDER_UNITS, ORDER_NAMES, "jsonl-20", "first", true);
  for (const row of rows) {
    assert.match(sim, new RegExp(` \\[${String(row.lineCount)} lines?\\]`, "u"),
      `row ${String(row.index)} states its own line count`);
  }
  // The shipped `3option` ask carries no such suffix: it belongs to jsonl-20.
  const shipped = entryBatchAskMessage(askRowsOf(ORDER_UNITS, ORDER_NAMES), "3option");
  assert.doesNotMatch(shipped, / \[\d+ lines?\]/u);
});

test("the host's marked entry-ask exchange never reaches the surface; unlabeled asks refuse", () => {
  const tableRow = '1. [read a.ts] (call #1) — line 1 ends with "alpha" · line 2 ends with "beta"';
  const askText = `Memory management: decide which tool results below stay in your memory.\n\n`
    + `${tableRow}\n\n${ENTRY_ASK_CLOSING_LINE}`;
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "user/message", seq: 2, surfaceOp: "append",
      data: { content: [{ type: "text", text: "the task" }], source: { kind: "user" } } },
    { type: "user/message", seq: 3, surfaceOp: "append",
      data: { content: [{ type: "text", text: askText }],
        source: { kind: "racoons/negation/entry-ask" } } },
    { type: "user/message", seq: 4, surfaceOp: "append",
      data: { content: [{ type: "text", text: '{"1":{"keepall":true}}' }],
        source: { kind: "racoons/negation/entry-ask" } } },
    { type: "session", seq: 5, id: "session-entry-ask" },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.entryAskRows, 2, "both marked exchange turns are collected");
  assert.deepEqual([...timeline.entryAskSeqs], [3, 4]);
  const shown = surfaceAt({ timeline, fireStep: 1, surface: new Map(), fireIndex: 0 });
  assert.deepEqual(shown.rows.map(row => row.seq), [2],
    "the product's rewind leaves only the task turn; the ask and answer are gone");
  assert.ok(!JSON.stringify(shown.rows).includes("1. [read a.ts]"),
    "none of the first fire's table rows survive into the next prompt");
  // A recording that carries the ask's own anchor but no marker cannot be
  // classified; it refuses by name rather than replaying the table.
  const unlabeled = rows.map(row => row.seq === 3
    ? { ...row, data: { ...row.data, source: { kind: "user" } } } : row);
  assert.throws(() => readTimeline(unlabeled), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-entry-ask-unlabeled");
});

test("a pruner-off lane refuses the host depth series and the zero-prune gate", () => {
  // The host series was measured with the trim active: it is never a pruner-off
  // trigger's ruler.
  assert.throws(() => assertDepthSource(HOST_DEPTH_SOURCE, true), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-depth-contaminated");
  assert.equal(assertDepthSource(HOST_DEPTH_SOURCE, false), HOST_DEPTH_SOURCE);
  assert.equal(assertDepthSource(SURFACE_DEPTH_SOURCE, true), SURFACE_DEPTH_SOURCE);
  // ADR-0041 Decision 6: a pruner-off run must not replay a world the host trim
  // shaped. `replayedPrunes` is that world's own count, taken BEFORE
  // `--ignore-host-prunes` removed the rows — the replayed world itself carries
  // none by construction, so the gate reads the source count and the label.
  const undeclared = readTimeline(hostTrimRows(), { ignoreHostPrunes: true });
  assert.equal(undeclared.inputPruneEvents, 1, "the raw count survives the filtering");
  assert.equal(undeclared.replayedPrunes, 1,
    "the SOURCE world's count is taken before the filter (not the filtered zero)");
  assert.throws(() => assertZeroPruneGate(undeclared), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-zero-prune-gate"
    && /carries 1 compaction\/prune event/.test(error.message));
  const clean = readTimeline(hostTrimRows(), { ignoreHostPrunes: true, reconstruction: true });
  assert.deepEqual(assertZeroPruneGate(clean),
    { required: true, events: 0, replayedPrunes: 1, inputPruneEvents: 1, reconstruction: true,
      status: "reconstruction" });
  // A world with no prune row needs no label: the branch that CAN fail has a
  // reachable pass, and the filtered world carries no event to count.
  const pristineRows = hostTrimRows().filter(row => row?.type !== "compaction/prune");
  const pristine = readTimeline(pristineRows, { ignoreHostPrunes: true });
  assert.equal(pristine.replayedPrunes, 0);
  assert.equal(assertZeroPruneGate(pristine).status, "pass");
  // The trigger reading is the surface's own bytes, cut strictly before the step.
  const timeline = readTimeline(hostTrimRows(), { ignoreHostPrunes: true });
  const atOne = surfaceDepthBefore({ timeline, step: 1, surface: new Map(), fireIndex: 0 });
  const atTwo = surfaceDepthBefore({ timeline, step: 2, surface: new Map(), fireIndex: 0 });
  assert.ok(atTwo.tokens > atOne.tokens, "the surface grew as the two units landed");
  assert.equal(atTwo.tokens, measuredTokensOf(atTwo.bytes), "the measured 3.04 ratio");
  assert.equal(MEASURED_BYTES_PER_TOKEN, 3.04);
});

test("the zero-prune gate refuses a REAL recording that carries prune events", t => {
  if (!requirePinnedWorld(t)) return;
  // The auditor's case: `readTimeline` deletes every compaction/prune row under
  // --ignore-host-prunes, so the gate must read the source world's count, not
  // the filtered world's zero. The fab6632e recording carries 132 in all, 67
  // inside segment 139.
  const undeclared = readTimeline(DEFAULT_TRANSCRIPT,
    { segment: 139, ignoreHostPrunes: true });
  assert.deepEqual(undeclared.hostPrunes, [], "the filtered world carries no events");
  assert.equal(undeclared.replayedPrunes, 67, "the segment's own count survives the filter");
  assert.equal(undeclared.inputPruneEvents, 132, "the recording's whole count is kept apart");
  assert.throws(() => assertZeroPruneGate(undeclared), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-zero-prune-gate"
    && /carries 67 compaction\/prune event/.test(error.message));
  const declared = readTimeline(DEFAULT_TRANSCRIPT,
    { segment: 139, ignoreHostPrunes: true, reconstruction: true });
  assert.deepEqual(assertZeroPruneGate(declared),
    { required: true, events: 0, replayedPrunes: 67, inputPruneEvents: 132, reconstruction: true,
      status: "reconstruction" });
  assert.equal(declared.replayedPrunes, 67, "the source world's count is kept");
  assert.equal(declared.inputPruneEvents, 132, "the recording's count is kept apart");
});

test("the batch-8 lane's planned prompt is pinned: BOTH arms cross the guard", t => {
  if (!requirePinnedWorld(t)) return;
  // The README's batch-8 sentence: at lane 8 the planned peak crosses 400k in
  // BOTH arms. A planned peak is a MEASUREMENT, so `promptPeakOf` reports the
  // number (the guard is a send-time rule); a SEND at that fire refuses.
  const off = readTimeline(DEFAULT_TRANSCRIPT,
    { segment: 139, ignoreHostPrunes: true, reconstruction: true });
  // P11: a plan with no measured step refuses (`sim-batch-depth-absent`), so the
  // prompt-shape probe states the one step it needs; nothing here reads a depth.
  const planOff = planLane({ timeline: off, depths: depthsOf([1], 1000), lane: 8,
    floor: FLOOR_BYTES });
  const offPeak = promptPeakOf(planOff, off);
  // The peak, not the first fire to cross: `promptPeakOf` used to REFUSE at the
  // first over-guard prompt, so the old 1,209,456 was that fire, not the peak.
  // The DEFAULT ask is the product's `jsonl-20` (owner ruling 2026-11-05), so
  // these pins are the bytes a default lane sends: re-pinned when the default
  // moved off `3option`.
  assert.equal(offPeak.peakPromptBytes, 1_734_566, "the pruner-off peak content bytes");
  assert.equal(offPeak.peakPromptWireBytes, 1_794_037, "the pruner-off peak request body");
  assert.equal(offPeak.peakPromptGuardTokens, 598_013, "ceil(wire B / 3): over the 400k guard");
  assert.equal(offPeak.peakPromptStep, 139, "the last fire of the pruner-off lane");
  const on = readTimeline(DEFAULT_TRANSCRIPT, { segment: 139 });
  const planOn = planLane({ timeline: on, depths: depthsOf([1], 1000), lane: 8,
    floor: FLOOR_BYTES });
  // P6 (eleventh audit): with the strict prune predicate a fire landing on a
  // prune's own step still tables the rows that prune names, so the pruner-on
  // lane's surface is larger than it was and its CONTENT count overflows too.
  // The wire count remains the larger of the two readings.
  const onPeak = promptPeakOf(planOn, on);
  assert.equal(onPeak.peakPromptBytes, 1_477_231, "the pruner-on peak content bytes");
  assert.equal(onPeak.peakPromptWireBytes, 1_524_798, "the pruner-on peak request body");
  assert.equal(onPeak.peakPromptGuardTokens, 508_266, "ceil(wire B / 3): the larger reading");
  assert.ok(offPeak.peakPromptGuardTokens > onPeak.peakPromptGuardTokens,
    "the pruner-off surface is the larger of the two peaks: the host trim it removes"
    + " is exactly the content the on-arm no longer carries");
  // The SEND at the pruner-on peak fire refuses by name, at the wire size. Two
  // batches can share a fire step, so the peak's batch is found by its bytes,
  // never by the first fire at that step.
  const buildAt = (index, checkGuard) => {
    const units = planOn.fireBatches[index].map(id => eligibleOf(on, FLOOR_BYTES)
      .find(unit => unit.id === id)).filter(unit => unit !== undefined);
    return promptForFire({ timeline: on, fireStep: planOn.fireSteps[index], units,
      firstTrigger: index === 0, surface: simulateSurface(), fireIndex: 0, checkGuard });
  };
  const sendIndex = planOn.fireBatches.findIndex((_, index) =>
    buildAt(index, false).promptWireBytes === onPeak.peakPromptWireBytes);
  assert.ok(sendIndex >= 0, "the peak's own batch is one of the lane's fires");
  assert.throws(() => buildAt(sendIndex, true), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-prompt-overflow"
    && /1524798 wire B/.test(error.message),
  "a send at the peak refuses before the socket, naming the wire size");
  // P11's own refusal: a plan with no ruler cannot print a freed number.
  assert.throws(() => planLane({ timeline: off, depths: [], lane: 8, floor: FLOOR_BYTES }),
    error => error instanceof SimBatchUnitsRefusal
      && error.code === "sim-batch-depth-absent"
      && /no ruler cannot print a freed number/.test(error.message));
});

// ---- P6: the shipped landed-bytes trigger is core's function, not a copy ---

test("the sim's landed-bytes verdict IS core's, over a shared case grid (P6)", () => {
  const cases = [];
  for (const threshold of [1, 100, 240_000]) {
    for (const landedBytes of [0, 99, 100, 239_999, 240_000, 240_001]) {
      for (const pending of [0, 1, 7]) cases.push({ landedBytes, threshold, pending });
    }
  }
  for (const reading of cases) {
    assert.deepEqual(landedBytesVerdict(reading), coreLandedBytesVerdict(reading),
      `the sim's verdict and core's disagree at ${JSON.stringify(reading)}`);
  }
  // The predicate's boundary is core's: pending 0 holds even over the threshold,
  // and a crossing fires only with work pending.
  assert.equal(landedBytesVerdict({ landedBytes: 240_000, threshold: 240_000, pending: 0 }).kind,
    "hold");
  assert.equal(landedBytesVerdict({ landedBytes: 240_000, threshold: 240_000, pending: 1 }).kind,
    "fire");
});

// ---- P2: the input hashes are verified on every segment --------------------

test("input hashes are verified at a segment other than 139 (P2)", () => {
  // A tiny synthetic world written to files, claimed at segment 2: the pins
  // used to skip the whole block here, so a stated hash proved nothing.
  const dir = mkdtempSync(path.join(tmpdir(), "sim-units-p2-"));
  try {
    const transcript = path.join(dir, "session.v4.jsonl");
    const usage = path.join(dir, "result.json");
    const rows = [
      { type: "session", seq: 1, id: "session-p2" },
      { type: "step/start", seq: 2, data: { step: 1 } },
      { type: "tool/result", seq: 3, surfaceOp: "append",
        data: { step: 1, message: { content: [{ type: "text", text: "alpha\nbeta" }] } } },
      { type: "step/start", seq: 4, data: { step: 2 } },
      { type: "tool/result", seq: 5, surfaceOp: "append",
        data: { step: 2, message: { content: [{ type: "text", text: "gamma\ndelta" }] } } },
    ];
    writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(usage, JSON.stringify({ rows: [
      { step: 1, inputTokens: 100, cacheReadTokens: 0 },
      { step: 2, inputTokens: 200, cacheReadTokens: 0 },
    ] }));
    const timeline = readTimeline(transcript, { segment: 2, ignoreHostPrunes: true });
    const depths = readUsage(usage);
    const pins = inputPinsOf({ transcript, usage });
    // The correct pair passes at a non-pinned segment, and the summary's own
    // hashes are the files'.
    assert.doesNotThrow(() => assertSegmentPins(timeline, depths,
      { allowZeroReasoning: true, input: pins }));
    // A stated transcript hash that is not the file's own refuses.
    assert.throws(() => assertSegmentPins(timeline, depths,
      { allowZeroReasoning: true, input: { ...pins, transcriptSha256: "0".repeat(64) } }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-mismatch"
      && /file that was read/.test(error.message));
    // A stated usage hash with no file to hash refuses: it is a copied string.
    assert.throws(() => assertSegmentPins(timeline, depths,
      { allowZeroReasoning: true,
        input: { transcriptSha256: pins.transcriptSha256, usageSha256: pins.usageSha256 } }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-usage-unpinned");
    // An edited usage file moves its hash and refuses, at segment 2.
    writeFileSync(usage, JSON.stringify({ rows: [{ step: 1, inputTokens: 101, cacheReadTokens: 0 },
      { step: 2, inputTokens: 200, cacheReadTokens: 0 }] }));
    assert.throws(() => assertSegmentPins(timeline, depths,
      { allowZeroReasoning: true, input: pins }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-mismatch"
      && /is not the hash of/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- P4: a reasoning turn that lost its parts leaves a trace ---------------

test("a reasoning turn whose parts were dropped whole refuses by name (P4)", () => {
  const reasoningRow = (seq, { withPart }) => ({
    type: "assistant/message", seq,
    data: {
      step: 1,
      message: {
        content: withPart
          ? [{ type: "text", text: "look" }, { type: "reasoning", text: "why" }]
          : [{ type: "text", text: "look" }],
        source: { replayState: { blocks: withPart
          ? [{ type: "text" }, { type: "reasoning", thinkingSignature: "reasoning" }]
          : [{ type: "text" }, { type: "reasoning", thinkingSignature: "reasoning" }] } },
      },
      stream: [{ blockType: "text" }, { blockType: "reasoning" }],
    },
  });
  // One intact turn and one whose content PART was dropped while its own
  // replay-state and stream echo survived: the part count and the block count
  // both fall to 1, and only the echo count (2) sees the loss.
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    reasoningRow(2, { withPart: true }),
    reasoningRow(3, { withPart: false }),
    { type: "session", seq: 4, id: "session-p4" },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.reasoningBlocks, 1, "one resendable block survives");
  assert.equal(timeline.reasoningTurns, 1, "one turn still carries a part");
  assert.equal(timeline.assistantTurns, 2, "the assistant-turn population is recorded");
  assert.equal(timeline.reasoningPartTurns, 1);
  assert.equal(timeline.reasoningMarkedTurns, 2, "both turns echo a reasoning block");
  assert.throws(() => assertReasoningCarried(timeline), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-parts-lost"
    && /only 1 still carry a type:"reasoning"/.test(error.message));
});

// ---- P7: a result with string content is counted, not silently 0 B ---------

test("a result whose declared content is a string is counted, never a 0 B row (P7)", () => {
  const body = `${"a".repeat(600)}\n${"b".repeat(600)}`;
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: body } } },
    { type: "tool/result", seq: 3, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text", text: `${"c".repeat(600)}\n${
        "d".repeat(600)}` }] } } },
    { type: "session", seq: 4, id: "session-p7" },
  ];
  const timeline = readTimeline(rows);
  const stringUnit = timeline.units.find(unit => unit.seq === 2);
  assert.equal(stringUnit.bytes, 0, "textOf reads parts; a string body reads as no text");
  assert.equal(stringUnit.declaredContentBytes, Buffer.byteLength(body, "utf8"),
    "the declared bytes are recorded");
  const eligibility = eligibilityOf(timeline, 512);
  assert.deepEqual(eligibility.excluded,
    { unreadableContent: 1, nonTextContent: 0, belowFloor: 0, errorResult: 0,
      noTwoQuotes: 0 },
    "the row is counted under its own name, not as a sub-floor row");
  assert.equal(eligibility.eligible, 1);
  assert.deepEqual(eligibleOf(timeline, 512).map(unit => unit.seq), [3],
    "the unreadable row is not eligible");
});

// ---- the eleventh audit: usage totals, usage holes, prune ordering ----------

test("P4: a cache-free row whose total explains neither shape refuses", () => {
  // The reported row: no cache, so both shapes are the same number, and a total
  // of 9,999 explains neither 502 (no output count) nor 502 + output. It passed
  // because every total guard sat inside `if (cacheRead > 0)`.
  assert.throws(() => readUsage({ rows: [{ step: 1, inputTokens: 502,
    cacheReadTokens: 0, totalTokens: 9999 }] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-total-unexplained"
    && /9999/.test(error.message));
  // The same row WITH its output count still explains nothing: 502 + 100 = 602.
  assert.throws(() => readUsage({ rows: [{ step: 1, inputTokens: 502,
    cacheReadTokens: 0, outputTokens: 100, totalTokens: 9999 }] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-total-unexplained");
  // The totals a cache-free row CAN state still read: folded and additive are
  // the same number when the cache is zero, so both spellings are accepted.
  assert.deepEqual(readUsage({ rows: [{ step: 1, inputTokens: 502, cacheReadTokens: 0,
    outputTokens: 100, totalTokens: 602 }] }),
  [{ step: 1, tokens: 502, shapeBasis: "no-cache" }]);
  assert.deepEqual(readUsage({ rows: [{ step: 1, inputTokens: 502, cacheReadTokens: 0,
    totalTokens: 502 }] }), [{ step: 1, tokens: 502, shapeBasis: "no-cache" }]);
});

test("P5: a depth series with a hole refuses instead of pinning the steps it has", () => {
  // The transcript declares steps 1-5; the series reads 1, 2, 3 and 5. Every
  // stated step exists, so the old check passed and the trigger ran on a ruler
  // that skipped step 4.
  const timeline = { stepStarts: [1, 2, 3, 4, 5], segment: null };
  assert.throws(() => assertUsageStepsPinned(timeline,
    depthsFrom([[1, 100], [2, 200], [3, 300], [5, 500]])), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-step-hole"
    && /step 4/.test(error.message));
  // A series that stops early is the same hole, named by the first step it
  // never read.
  assert.throws(() => assertUsageStepsPinned(timeline, depthsFrom([[1, 100], [2, 200]])),
    error => error instanceof SimBatchUnitsRefusal
      && error.code === "sim-batch-usage-step-hole" && /step 3/.test(error.message));
  // The full series pins.
  assert.deepEqual(assertUsageStepsPinned(timeline,
    depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400], [5, 500]])),
  { declared: 5, checked: 5, pinned: true, statedOnlySteps: [] });
  // A segment cut is a stated cut, not a hole: steps after the cut are out of
  // scope, and the series must reach the last step the cut keeps.
  assert.deepEqual(assertUsageStepsPinned({ stepStarts: [1, 2, 3, 4], segment: 2 },
    depthsFrom([[1, 100], [2, 200]])),
  { declared: 4, checked: 2, pinned: true, statedOnlySteps: [] });
});

test("P5: a stated cache shape is cross-checked, or its step is recorded", () => {
  // `inputTokensIncludeCache: true` with no prompt count, no output count and no
  // total: nothing independent says where the cache sits, so the row's depth is
  // its own statement. The reading is recorded, never silently trusted.
  const uncorroborated = readUsage({ rows: [{ step: 1, inputTokens: 100,
    cacheReadTokens: 50, inputTokensIncludeCache: true }] });
  assert.deepEqual(uncorroborated, [{ step: 1, tokens: 100, shapeBasis: "statement" }]);
  const pinned = assertUsageStepsPinned({ stepStarts: [1], segment: null }, uncorroborated);
  assert.deepEqual(pinned.statedOnlySteps, [1],
    "the step whose depth rests on its own statement is named");
  // A prompt count IS an independent reading, and it corroborates the shape.
  const corroborated = readUsage({ rows: [{ step: 1, inputTokens: 100,
    cacheReadTokens: 50, inputTokensIncludeCache: true, billedTokens: 100 }] });
  assert.deepEqual(corroborated, [{ step: 1, tokens: 100, shapeBasis: "prompt-count" }]);
  assert.deepEqual(assertUsageStepsPinned({ stepStarts: [1], segment: null },
    corroborated).statedOnlySteps, []);
  // A total that only the folded shape explains corroborates it too.
  const byTotal = readUsage({ rows: [{ step: 1, inputTokens: 100, cacheReadTokens: 50,
    outputTokens: 10, totalTokens: 110, inputTokensIncludeCache: true }] });
  assert.deepEqual(byTotal, [{ step: 1, tokens: 100, shapeBasis: "totals" }]);
});

test("P6: a prune at the fire's own step is not applied yet", () => {
  // The product runs a step's entry ask BEFORE that step's prune
  // (`plugin.ts:2144-2145`), so a fire landing on the prune's step still tables
  // the row. At the NEXT step it is gone.
  const timeline = { hostPrunes: [{ step: 5, seqs: [7, 8], tokens: 100 }] };
  assert.deepEqual([...hostRemovedAt(timeline, 4)], [], "before the prune: nothing removed");
  assert.deepEqual([...hostRemovedAt(timeline, 5)], [],
    "AT the prune's own step the ask has already been composed: still on the surface");
  assert.deepEqual([...hostRemovedAt(timeline, 6)].sort((l, r) => l - r), [7, 8],
    "from the next step on, the host's removal applies");
});

test("a failed result is read from either content shape, never only data.message (small)", () => {
  const body = `${"a".repeat(600)}\n${"b".repeat(600)}`;
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    // The content sits at `data.content`; the failure flag beside it, in the
    // same shape. Reading isError only from `data.message` made this row
    // eligible: a failed result the product never tables, tabled by the sim.
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, isError: true, content: [{ type: "text", text: body }] } },
    { type: "session", seq: 3, id: "session-small-iserror" },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.units[0].isError, true, "the flag is read where the content is");
  assert.deepEqual(eligibilityOf(timeline, 512).excluded,
    { unreadableContent: 0, nonTextContent: 0, belowFloor: 0, errorResult: 1,
      noTwoQuotes: 0 });
});

test("the plan line prints the two arithmetic identities, never the old juxtaposition", () => {
  const units = [unitOf(1), unitOf(2)];
  const plan = planLane({ timeline: timelineOf(units), depths: depthsOf([1], 1000), lane: 8 });
  const line = summaryOf(plan);
  assert.match(line, /eligible = 2 appends \+ 0 replacements; appends = 2 never-pruned \+ 0 host-pruned originals/);
  assert.doesNotMatch(line, /appends 2 \(never-pruned/,
    "`eligible = appends A (P + Q) + R` reads as a sum of overlapping terms and is gone");
});

test("the [pins] line prints the identities, and the plan line names unreadable content", t => {
  if (!requirePinnedWorld(t)) return;
  // The `[pins]` line is the other place the arithmetic is printed, and it kept
  // the `eligible = appends A (never-pruned P + pruned originals Q) + R`
  // juxtaposition after the `[summary]` line dropped it.
  const result = spawnSync(process.execPath, [SCRIPT, "--mode", "batch", "--segment", "139",
    "--lanes", "1"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  const pins = result.stdout.split("\n").find(line => line.startsWith("[pins]"));
  assert.ok(pins !== undefined, "the segment block prints a [pins] line");
  assert.match(pins, /eligible 268 = appends 201 \+ replacements 67/);
  assert.match(pins, /appends 201 = never-pruned 134 \+ pruned originals 67/);
  assert.doesNotMatch(pins, /appends 201 \(never-pruned/,
    "the two identities are printed as identities, never as one overlapping sum");
  // The plan summary line carries the `unreadableContent` and
  // `nonTextContent` counts the JSON has had all along; only the printed line
  // omitted them.
  const summary = result.stdout.split("\n").find(line => line.startsWith("sim-batch-units"));
  assert.ok(summary !== undefined);
  assert.match(summary, /excluded \d+ unreadable-content, \d+ non-text-content, \d+ below-floor, \d+ error-result, \d+ no-two-quotes/);
  assert.match(summary, /^sim-batch-units lane 1 triggers \d+ asks \d+ eligible 268 /);
});

