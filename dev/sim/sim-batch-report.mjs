#!/usr/bin/env node
/**
 * The multi-lane plan report (batch-trigger simulation, chunk 2). No socket, no
 * clock, no randomness. Run `node dev/sim/sim-batch-report.mjs [--lanes
 * 8,16,32] [--policy keepall|forgetall] [--transcript f] [--usage f]
 * [--floor 512] [--json]`.
 *
 * It plans each lane twice: `keepall` (the stub every chunk-1 table used) and
 * `forgetall` (the cheap upper bound on what a policy can free). Depth is the
 * units module's own arithmetic; this module adds only two readings —
 * `billedProxy` (Σ depth over every usage row, in prompt tokens: a depth-sum
 * estimate whose ruler `depth ruler` names, never a bill any provider charged)
 * and `rereads`.
 *
 * Rereads: a unit the policy removed whose path a LATER read call names. The
 * witness is live-convert.mjs's exported `findRereadWitness`, so this module
 * re-derives nothing but the arm it needs (calls, results, a root). `keepall`
 * removes nothing and therefore reads 0; a policy that forgot a unit read again
 * is charged one reread per such unit.
 *
 * `--summary` reads completed live run JSON files and prints the campaign
 * table: sends add up as `answered + timed-out + refused-send`, whole-answer
 * refusals are a send-level cause, row-level and send-level refusal counts are
 * labelled apart (design §6), and `forget answers` and `applied forgets` are
 * separate columns — an answer on a row the host had ALREADY removed at the fire
 * bought no surface (a later-pruned row is shaped and credited for its window).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRereadWitness, readTranscript } from "../bench/multiturn/live-convert.mjs";
import { keptLineCountOf } from "./sim-batch-grammar.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";
import {
  DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER, DEFAULT_THRESHOLD_UNITS, DEFAULT_THRESHOLDS,
  DEFAULT_TRANSCRIPT, DEFAULT_USAGE, FLOOR_BYTES, HOST_DEPTH_SOURCE,
  MEASURED_BYTES_PER_TOKEN, SURFACE_DEPTH_SOURCE,
  assertOrderForGrammar, assertReasoningCarried, assertSegmentPins,
  assertZeroPruneGate, depthsInSegment, eligibleOf, fileSha256Of, inputPinsOf, planLane,
  promptForFire,
  readTimeline, readUsage, refuse, simulateSurface, surfacePinsOf, thresholdLane,
  thresholdLaneName,
} from "./sim-batch-units.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** `scratchpad/` is disposable and gitignored: the table is never committed. */
export const REPORT_DIR = path.resolve(HERE, "../../scratchpad/sim-batch-2026-10-30");
export const REPORT_MARKDOWN = path.join(REPORT_DIR, "plan-batch-lanes.md");
export const REPORT_JSON = path.join(REPORT_DIR, "plan-batch-lanes.json");
/** Gate A's offline evidence (design §7.5), gitignored and never committed. */
export const GATE_A_DIR = path.resolve(HERE, "../../scratchpad/sim-retest-2026-10-30/plan");
export const GATE_A_MARKDOWN = path.join(GATE_A_DIR, "plan.md");
export const GATE_A_JSON = path.join(GATE_A_DIR, "plan.json");
export const DEFAULT_LANES = [8, 16, 32];
export const GATE_A_LANES = [8, 16, 32];
export const GATE_A_THRESHOLDS = [30_000, 60_000];
/** The landed-bytes probe lane: its own unit, so its own list. */
export const GATE_A_BYTES_THRESHOLDS = [240_000];
export const POLICIES = Object.freeze(["keepall", "forgetall"]);
const USAGE = [
  "usage: sim-batch-report.mjs [--transcript <session.v4.jsonl>] [--usage <result.json>]",
  "                             [--floor 512] [--segment <lastStep>]",
  "                             [--lanes 8,16,32] [--thresholds 30000,60000]",
  "                             [--policy keepall|forgetall] [--gate-a|--plan] [--json]",
  "                             [--ask-grammar 3option|two-option|forgetlines|keeplines-60|jsonl-20|jsonl-20-nokeepall]",
  "                             [--ignore-host-prunes] [--reconstruction]",
  "                             [--allow-zero-reasoning]",
  "                             [--summary <live.json[,live.json]> [--planned-fires 30,15]]",
  "       --lanes      batch sizes, comma separated; default 8,16,32",
  "       --thresholds also plan these threshold lanes, in tokens",
  "       --segment    last owning step, inclusive; drops later rows from the plan",
  "       --gate-a     the offline Gate A pass (alias --plan): batch 8/16/32 +",
  "                    threshold 30k/60k + bytes-240k, keepall, pins asserted,",
  "                    evidence under scratchpad/sim-retest-2026-10-30/plan/ (gitignored)",
  "       --policy     print only this synthetic policy's row; default prints both per lane",
  "       --summary    read these completed live run JSON files (comma separated) and",
  "                    print the corrected campaign table: sends add up as answered +",
  "                    timed-out + refused-send, whole-answer refusals are a send-level",
  "                    cause, row-level and send-level counts are labelled apart, and",
  "                    forget answers and applied forgets are separate columns. No",
  "                    socket, no transcript, no file written",
  "       --planned-fires  planned fire counts for --summary, comma separated (30,15)",
  "       --json       also print the row objects; the markdown and JSON land in scratchpad",
  "       --ask-grammar  the ask grammar whose bytes the peak-prompt gauges measure; the",
  "                    cadence, pins and fires are grammar-independent by construction",
  "       --ask-order  first (default), after or both: the instruction position whose",
  "                    bytes the gauges measure; the pins are order-independent, and",
  "                    a slot grammar (jsonl-20, jsonl-20-nokeepall) accepts only first",
  "       --ignore-host-prunes",
  "                    replay as if the host's own tool-result trim never ran: no",
  "                    compaction/prune removal, no replacement row from one, and",
  "                    the originals stay whole; the default treats them as fixed",
  "       --reconstruction",
  "                    declare a pruner-off replay of a recording that carries",
  "                    compaction/prune events as a RECONSTRUCTION, not a product",
  "                    measurement; required by the zero-prune gate and recorded",
  "       --allow-zero-reasoning",
  "                    record a transcript that declares 0 reasoning blocks as a VOID",
  "                    comparison (ADR-0045); without it the run refuses by name",
].join("\n");

/** The stub for one policy: `keepall` keeps, `forgetall` frees the whole body. */
export function policyProducer(policy) {
  if (!POLICIES.includes(policy)) {
    refuse("sim-batch-policy-invalid", `--policy takes ${POLICIES.join("|")}, got ${String(policy)}`);
  }
  return policy === "keepall"
    ? Object.freeze({ name: "keepall", decide: ({ unit }) => ({ momentId: unit.id, action: "keepall" }) })
    : Object.freeze({ name: "forgetall",
      decide: ({ unit }) => ({ momentId: unit.id, action: "forgetall", summary: "forgotten" }) });
}

/** The first `<path>` a landed body carries, or null (live-convert's own slot). */
function pathOf(text) {
  const match = /<path>([^<]+)<\/path>/.exec(text);
  return match !== null && match[1].trim().length > 0 ? match[1].trim() : null;
}

function callIdOf(row) {
  return row?.data?.message?.toolCallId ?? row?.data?.message?.source?.callId ?? null;
}

/**
 * The arm `findRereadWitness` reads: its calls by id, its result rows, and the
 * root both paths are normalized against. Built from the same transcript.
 */
export function armOf(rows, armRoot = null) {
  const calls = new Map();
  for (const row of rows) {
    if (row?.type === "tool/call" && row.data?.callId !== undefined) {
      calls.set(row.data.callId, { ...row.data, seq: row.seq });
    }
  }
  return { meta: { armRoot }, calls, results: rows.filter(row => row?.type === "tool/result") };
}

/** The removed units a later read names again: one witness per unit. */
export function rereadsOf({ removed, arm }) {
  const hits = [];
  for (const unit of removed) {
    if (typeof unit.path !== "string" || unit.path.length === 0) continue;
    const witness = findRereadWitness(arm, { path: unit.path, seq: unit.seq });
    if (witness !== null) hits.push({ seq: unit.seq, witness });
  }
  return hits;
}

/**
 * `planLane`, with the policy's removals recorded so the witness can be wired.
 * The producer seam is wrapped at the call site (the units module is imported,
 * never edited). Every decision the plan actually asked is a removal the policy
 * made; a unit the host pruned LATER does not erase the window the shape stood
 * in, and a unit the host had removed before the fire was never in the table.
 * So the recorded list needs no static host-prune filter — the time-aware plan
 * never asks a row that was already gone.
 */
export function planWithRereads({ timeline, depths, lane, floor = FLOOR_BYTES, producer, arm }) {
  const removed = [];
  const recording = {
    name: producer.name,
    decide: (args) => {
      const decision = producer.decide(args) ?? {};
      if ((decision.action ?? "keepall") !== "keepall") {
        removed.push({ id: args.unit.id, seq: args.unit.seq, path: pathOf(String(args.unit.text ?? "")) });
      }
      return decision;
    },
  };
  const plan = planLane({ timeline, depths, lane, floor, producer: recording });
  const policyRemovals = removed;
  const hits = rereadsOf({ removed: policyRemovals, arm });
  return { ...plan, rereads: hits.length, removedUnits: policyRemovals.length, rereadHits: hits };
}

/**
 * The ruler `billedProxy` was summed with, named. `reconstructed-surface`
 * depths are `ceil(bytes / 3.04)` estimates; `host-result.json` depths are the
 * recording's measured prompt depth. Nothing here is a bill: a depth is one
 * prompt's size, not a provider charge.
 */
function depthRulerOf(source) {
  if (source === SURFACE_DEPTH_SOURCE) {
    return `reconstructed-surface @ ${String(MEASURED_BYTES_PER_TOKEN)} B/token (estimate)`;
  }
  if (source === HOST_DEPTH_SOURCE) return "host-result.json (measured prompt depth)";
  return source ?? null;
}

/** One table row: the plan's columns, plus the depth-sum estimate and its ruler. */
export function rowOf({ lane, policy, plan }) {
  const series = Array.isArray(plan.series) ? plan.series : [];
  const depth = plan.depthSeries ?? null;
  return {
    lane, policy, triggers: plan.triggers, asks: plan.asks, eligible: plan.eligibleResults,
    // The split travels beside the total: 201 appends (67 of them host-pruned
    // originals) and 67 replacements are NEVER added as "201 + 67".
    eligibleSplit: plan.eligibleSplit ?? null,
    // Net is the policy's real saving; gross is recorded beside it so the two
    // are never read as one number.
    bytesFreedByPolicy: plan.bytesFreedByPolicy,
    bytesFreedGross: plan.bytesFreedGross ?? plan.bytesFreedByPolicy,
    depthFirst: depth === null ? null : depth.first,
    depthPeak: depth === null ? null : depth.peak,
    depthLast: depth === null ? null : depth.last,
    // The field name is historical: this is Σ depth in prompt tokens, an
    // estimate (`depthRuler` names the ruler), never a bill.
    billedProxy: series.reduce((sum, point) => sum + point.depth, 0),
    depthRuler: depthRulerOf(plan.depthSource),
    rereads: plan.rereads, carried: plan.carried, hostTokens: plan.hostTokens,
    hostPrunes: plan.hostPrunes, ignoreHostPrunes: plan.ignoreHostPrunes === true,
    hostPrunesIgnored: plan.hostPrunesIgnored ?? 0,
    hostTokensIgnored: plan.hostTokensIgnored ?? 0,
    hostReplacementsIgnored: plan.hostReplacementsIgnored ?? 0,
  };
}

/** The table's cell renderer: null prints as `-`. */
const cell = value => (value === null || value === undefined ? "-" : String(value));

/**
 * The send-level classes (design §6). A send is one provider request: a fire's
 * first send plus its correction send when one ran. Every send lands in exactly
 * one class, so `answered + timed-out + refused-send` must equal the send total.
 */
export const SEND_CLASSES = Object.freeze(["answered", "timed-out", "refused-send"]);

/**
 * Why a refused send produced no answer. `whole-answer-parse` is a send the
 * provider answered whose EVERY row was parse-refused: it is a send-level
 * refusal, so a "parse send-level 0" can no longer hide it.
 */
export const SEND_REFUSAL_CAUSES = Object.freeze(
  ["length-trip", "parse", "whole-answer-parse", "transport"]);

/** The row-level (kept-row) classes, labelled apart from the send classes. */
export const ROW_REFUSAL_CLASSES = Object.freeze(
  ["length-trip", "parse", "arithmetic", "timeout"]);

const countMap = names => Object.fromEntries(names.map(name => [name, 0]));
const bump = (map, name) => { map[name] = (map[name] ?? 0) + 1; };

/**
 * The verdicts a row reader counts as kept (ISSUE-175). `forgetAnswers` counts
 * every other answered row, so a `keeplines` row can never land in it.
 */
const KEEP_VERDICTS = new Set(["keepall", "keeplines"]);

/**
 * The lane's label. A live summary carries the numeric lane/threshold inside
 * its spread record, so the name is rebuilt exactly as the runner names it.
 */
export function laneNameOf(live) {
  const lane = live?.lane;
  if (typeof lane === "string") return lane;
  if (live?.mode === "threshold") {
    return thresholdLaneName(live.threshold, live.thresholdUnits ?? DEFAULT_THRESHOLD_UNITS);
  }
  return lane === null || lane === undefined ? null : `batch-${String(lane)}`;
}

/** One send's class from its `ok` flag and failure class. */
function sendClassOf(failed, failureClass) {
  if (!failed) return "answered";
  return failureClass === "timeout" ? "timed-out" : "refused-send";
}

/** A refused send's cause: the stream class, never `timeout` (which is its own
 * class) and never a whole-answer refusal (which is measured, not reported). */
function sendCauseOf(failureClass) {
  return failureClass === "length-trip" || failureClass === "parse"
    ? failureClass : "transport";
}

/**
 * One campaign row from a live run JSON (`sim-batch-live.mjs`'s output). The
 * sends breakdown is `total = answered + timed-out + refused-send`, where
 * `answered` means the send produced at least one answered row: a send the
 * provider replied to whose every row was parse-refused is a `refused-send`
 * with cause `whole-answer-parse`, so the causes sum to the refused total. A
 * failed send's rows are charged to the row-level class of the same name.
 * Refused rows carry `code` (coarse) and, on future runs, `wireCode`.
 *
 * `forgetAnswers` and `appliedForgets` are separate on purpose: an answer can
 * name a row the host had already pruned, so the answer was paid for and
 * bought no surface. `appliedForgets` is the runner's own count; older records
 * that predate the field print `-`, never a guessed number.
 *
 * `keeplinesAnswers` is the run's answered `keeplines` rows (JSON only, no table
 * column). A `keeplines` row is a KEEP and is never part of `forgetAnswers`:
 * the run's `distribution.keep`/`forget` grew from a per-row partition on
 * 2026-11-04 (ISSUE-175), and the row-only fallback below applies the same rule
 * so a record that predates the fixed counter reads the same as a fresh one.
 *
 * Every SEND is counted exactly once. `sim-batch-live.mjs` writes a correction
 * twice on disk: the fire's main record carries a `correction` block AND the
 * correction is appended as its own `kind: "correction"` record. The separate
 * record is skipped and the block is the one counter, so a run of N first sends
 * and K corrections reads N + K sends.
 *
 * ROW REFUSALS ARE FINAL REFUSALS ONLY, and `refusedRows` is their total. A
 * failed send charges the rows it actually tabled (`tabledRows`); a record that
 * names no `tabledRows` charges 0, because `batchSize` is the batch the fire
 * planned, not the table the wire saw (a send can fail before the table is
 * built). A correction's codes name rows the first pass answered and the
 * correction re-asked: a correction that ANSWERED healed them and charges
 * nothing; only a FAILED correction's codes are final refusals, charged to
 * `arithmetic`. A code already counted as a first-pass parse refusal is never
 * charged twice. `refusedCodes`/`wireCodes` classify the same final-refusal set,
 * so the causes and `refusedRows` can never disagree.
 *
 * Completeness and citability are the RUN's own readings, never inferred here:
 * `complete`, `citable`, `incompleteReasons`, and `measurement.reasons` travel
 * from the live JSON. An older record that predates them reads `null`, never
 * `true`. A live run JSON with no `records` refuses by name: a campaign table
 * over zero sends is not a measurement.
 *
 * `keptFraction` is the runner's own line fraction: `keptLines / totalLines`
 * labelled "lines not forgotten (refusals included)" because a refused row is
 * charged its whole body (`keptLineCountOf(null, total)`). `keptFractionAnswered`
 * is the same fraction over ANSWERED rows only; a record that carries no
 * per-row `lineCount` and did refuse rows cannot supply it, and the field is
 * then `null` with `keptFractionAnsweredMissing` naming how many records could
 * not contribute — never a guessed number.
 */
export function campaignRowOf(live, { plannedFires = null } = {}) {
  const records = live?.records;
  if (!Array.isArray(records) || records.length === 0) {
    refuse("sim-batch-summary-records-empty",
      `lane ${String(laneNameOf(live))}: a live run JSON needs a non-empty \`records\` array;`
      + " a summary over zero sends is not a measurement");
  }
  const sends = { ...countMap(SEND_CLASSES), total: 0 };
  const sendCauses = countMap(SEND_REFUSAL_CAUSES);
  const rowRefusals = countMap(ROW_REFUSAL_CLASSES);
  const refusedCodes = {};
  const wireCodes = {};
  let wholeAnswerSends = 0;
  let corrections = 0;
  let refusedRows = 0;
  let forgetAnswers = 0;
  let keeplinesAnswers = 0;
  let appliedForgets = null;
  let keptLines = 0;
  let totalLines = 0;
  let lineRecords = 0;
  let answeredKeptLines = 0;
  let answeredTotalLines = 0;
  let answeredRecords = 0;
  let answeredMissing = 0;
  for (const record of records) {
    // One send per provider request: the correction record and the fire's
    // `correction` block describe the SAME send. Count the block, skip the
    // record, or a run of N first sends and K corrections reports N + 2K.
    if (record?.kind === "correction") continue;
    sends.total += 1;
    if (Number.isSafeInteger(record.keptLines) && Number.isSafeInteger(record.totalLines)) {
      keptLines += record.keptLines;
      totalLines += record.totalLines;
      lineRecords += 1;
      const answered = answeredLinesOf(record);
      if (answered === null) {
        answeredMissing += 1;
      } else {
        answeredKeptLines += answered.kept;
        answeredTotalLines += answered.total;
        answeredRecords += 1;
      }
    }
    const recordForget = Number.isSafeInteger(record.distribution?.forget)
      ? record.distribution.forget
      : (Array.isArray(record.rows)
        ? record.rows.filter(row => row.status === "answered"
          && !KEEP_VERDICTS.has(row.action)).length
        : 0);
    forgetAnswers += recordForget;
    if (Number.isSafeInteger(record.distribution?.keeplines)) {
      keeplinesAnswers += record.distribution.keeplines;
    }
    if (Number.isSafeInteger(record.appliedForgets)) {
      appliedForgets = (appliedForgets ?? 0) + record.appliedForgets;
    }
    // A whole-answer refusal is an ANSWER, not a failed send: the writer stamps
    // `parseRefused` on a record whose every tabled row was refused because the
    // stream carried no readable text, and it still writes `ok: false` (ISSUE-602).
    // Such a record is charged by the answered path below, which keeps its row
    // codes and the `whole-answer-parse` cause; the send-level failure branch
    // would take it first and relabel it a plain `parse` refusal.
    if (record.ok !== true && record.parseRefused !== true) {
      const failureClass = record.failureClass ?? "transport";
      sends[sendClassOf(true, failureClass)] += 1;
      if (failureClass !== "timeout") bump(sendCauses, sendCauseOf(failureClass));
      const rowClass = failureClass === "timeout" ? "timeout"
        : (failureClass === "length-trip" ? "length-trip" : "parse");
      // Only the rows the send actually TABLED are final refusals. A record
      // that names no `tabledRows` tabled nothing this report can name: a send
      // can fail before the table is built, so `batchSize` is the batch the fire
      // planned, never the table the wire saw, and it charges 0.
      const tabledRows = Number.isSafeInteger(record.tabledRows) && record.tabledRows >= 0
        ? record.tabledRows : 0;
      rowRefusals[rowClass] += tabledRows;
      refusedRows += tabledRows;
      continue;
    }
    const recordRows = Array.isArray(record.rows) ? record.rows : [];
    const firstPassRefused = recordRows.filter(row => row.status !== "answered");
    // A correction that ANSWERED healed every row its codes name. Those rows are
    // not final refusals, so they leave the refused set (and the code maps).
    const healed = record.correction?.ok === true && Array.isArray(record.correction.codes)
      ? new Set(record.correction.codes) : null;
    const finalRefused = healed === null
      ? firstPassRefused
      : firstPassRefused.filter(row => !healed.has(row.index));
    for (const row of finalRefused) {
      bump(refusedCodes, row.code ?? "unknown");
      bump(wireCodes, row.wireCode ?? "none");
    }
    refusedRows += finalRefused.length;
    rowRefusals.parse += finalRefused.length;
    const asked = recordRows.length > 0 ? recordRows.length
      : (record.tabledRows ?? record.batchSize ?? 0);
    // The send class is the FIRST pass's reading: a send that refused every row
    // is a whole-answer refusal even when a later correction healed them. A
    // `parseRefused` record is one by construction, even if it tabled no row.
    const wholeAnswer = record.parseRefused === true
      || (firstPassRefused.length > 0 && firstPassRefused.length === asked);
    if (wholeAnswer) {
      wholeAnswerSends += 1;
      sends["refused-send"] += 1;
      bump(sendCauses, "whole-answer-parse");
    } else {
      sends.answered += 1;
    }
    if (record.correction) {
      corrections += 1;
      sends.total += 1;
      // A correction's codes name rows the first pass answered and the
      // correction re-asked. Only a FAILED correction leaves them unhealed, so
      // only then are they final refusals; a code already in the first pass's
      // refused set is charged there, never twice. A healing correction charges
      // no row class at all.
      if (record.correction.ok !== true) {
        const alreadyRefused = new Set(finalRefused.map(row => row.index));
        const codes = Array.isArray(record.correction.codes) ? record.correction.codes : [];
        const arithmeticRows = codes.filter(code => !alreadyRefused.has(code)).length;
        rowRefusals.arithmetic += arithmeticRows;
        refusedRows += arithmeticRows;
      }
      sends[sendClassOf(record.correction.ok !== true, record.correction.failureClass)] += 1;
      if (record.correction.ok !== true && record.correction.failureClass !== "timeout") {
        bump(sendCauses, sendCauseOf(record.correction.failureClass));
      }
    }
  }
  const addUp = sends.answered + sends["timed-out"] + sends["refused-send"] === sends.total;
  if (!addUp) {
    refuse("sim-batch-summary-sends-mismatch",
      `lane ${String(laneNameOf(live))}: sends do not add up (${JSON.stringify(sends)})`);
  }
  const measurement = live?.measurement ?? null;
  const complete = typeof live?.complete === "boolean" ? live.complete
    : (typeof measurement?.complete === "boolean" ? measurement.complete : null);
  const citable = typeof live?.citable === "boolean" ? live.citable
    : (typeof measurement?.citable === "boolean" ? measurement.citable : null);
  const incompleteReasons = Array.isArray(live?.incompleteReasons)
    ? [...live.incompleteReasons]
    : (Array.isArray(measurement?.incompleteReasons) ? [...measurement.incompleteReasons] : null);
  const measurementReasons = Array.isArray(measurement?.reasons)
    ? [...measurement.reasons] : null;
  // The producer's own platform labels. `usageIsEstimated` and the model/source
  // are carried verbatim so a citable row cannot hide that its token rows were
  // fabricated by a scripted model (a mock-replay `citableAs: "measurement
  // (reasoning measured)"` is the case). An absent field is `null`, never a
  // guessed `false`.
  const citableAs = typeof live?.citableAs === "string" ? live.citableAs
    : (typeof measurement?.citableAs === "string" ? measurement.citableAs : null);
  const usageIsEstimated = typeof live?.usageIsEstimated === "boolean"
    ? live.usageIsEstimated
    : (typeof measurement?.usageIsEstimated === "boolean" ? measurement.usageIsEstimated : null);
  const model = typeof live?.route?.model === "string" ? live.route.model
    : (typeof live?.model === "string" ? live.model : null);
  // The TRANSPORT wins when a run names one: it is what actually served the
  // numbers (`stub`, `deepseek`), and a stub must never read as the route it
  // imitates. A record with no transport falls back to the provider's own label.
  const source = typeof live?.transport === "string" ? live.transport
    : (typeof live?.route?.provider === "string" ? live.route.provider
      : (typeof live?.provider === "string" ? live.provider
        : (typeof live?.source === "string" ? live.source : null)));
  const keptFraction = lineRecords === 0 || totalLines === 0 ? null : keptLines / totalLines;
  // A partial answered-only figure is not a sample fraction: one record that
  // cannot separate its refusals makes the whole lane's number `null`.
  const answeredDerivable = answeredMissing === 0 && answeredTotalLines > 0;
  return {
    lane: laneNameOf(live), fires: live?.triggers ?? 0, plannedFires,
    eligibleSplit: live?.eligibleSplit ?? null,
    // The depth window's rule travels with the lane: a threshold run names
    // `incremental`, `growth` or `absolute`; a batch run and a record that
    // predates the field print `-`.
    semantics: live?.semantics ?? null,
    // The run's own completeness and citation readings; `null` for a record
    // that predates them, never a guessed `true`. `measurement.reasons` travels
    // under its live JSON path as well, beside the flat `measurementReasons`.
    complete, citable, citableAs, usageIsEstimated, model, source,
    incompleteReasons, measurementReasons,
    measurement: measurementReasons === null ? null : { reasons: measurementReasons },
    // `keptFraction` is the runner's line gauge, labelled in the table
    // "lines not forgotten (refusals included)": every refused row is charged
    // its whole body. The answered-only reading drops refused rows from both
    // terms.
    keptLines: lineRecords === 0 ? null : keptLines,
    totalLines: lineRecords === 0 ? null : totalLines,
    keptFraction,
    keptLinesAnswered: answeredDerivable ? answeredKeptLines : null,
    totalLinesAnswered: answeredDerivable ? answeredTotalLines : null,
    keptFractionAnswered: answeredDerivable ? answeredKeptLines / answeredTotalLines : null,
    keptFractionAnsweredRecords: answeredRecords,
    keptFractionAnsweredMissing: answeredMissing,
    sends, sendCauses, wholeAnswerSends, corrections,
    forgetAnswers, keeplinesAnswers, appliedForgets,
    rowRefusals, refusedRows, refusedCodes, wireCodes,
    recordedSends: live?.sends ?? null,
    sendsAddUp: addUp,
  };
}

/**
 * The lines an ANSWERED-only reading keeps for one record, or `null` when the
 * record does not carry enough to separate them. A record whose rows all
 * answered needs no separation; one whose refused rows exist needs each row's
 * own `lineCount` (a refused row is excluded, never charged its whole body).
 * The aggregate `keptLines`/`totalLines` cannot be split without those counts,
 * so this function returns `null` rather than inventing a share.
 */
function answeredLinesOf(record) {
  const rows = Array.isArray(record.rows) ? record.rows : null;
  const refused = rows === null
    ? (Number.isSafeInteger(record.distribution?.refused) ? record.distribution.refused : null)
    : rows.filter(row => row.status !== "answered").length;
  if (refused === null) return null;
  if (refused === 0) return { kept: record.keptLines, total: record.totalLines };
  if (rows === null
    || !rows.every(row => Number.isSafeInteger(row.lineCount) && row.lineCount >= 0)) {
    return null;
  }
  let kept = 0;
  let total = 0;
  for (const row of rows) {
    if (row.status !== "answered") continue;
    total += row.lineCount;
    kept += keptLineCountOf({ action: row.action, ranges: row.ranges }, row.lineCount);
  }
  return { kept, total };
}

/** The campaign table, one line per live run. */
export function campaignMarkdownOf(rows) {
  const header = ["lane", "fires", "sends = answered + timed-out + refused",
    "whole-answer refusals (sends)", "forget answers", "applied forgets",
    "send refusals by cause", "row refusals by cause",
    "refused rows", "refused rows by code", "wire codes", "threshold semantics",
    "lines not forgotten (refusals included)", "lines not forgotten, answered only",
    "completeness / citability", "usageIsEstimated", "model / source"];
  const rule = header.map(() => "---");
  const counts = (map, names) => {
    const parts = names.filter(name => (map?.[name] ?? 0) !== 0)
      .map(name => `${name} ${String(map[name])}`);
    return parts.length === 0 ? "-" : parts.join(", ");
  };
  const fraction = value => (typeof value === "number" ? value.toFixed(3) : "-");
  // A model and its source in one cell: `scripted-model (mock-replay)`. Either
  // half alone still prints; neither prints `-`.
  const modelSource = row => {
    const model = row.model ?? null;
    const source = row.source ?? null;
    if (model !== null && source !== null) return `${model} (${source})`;
    return model ?? source ?? "-";
  };
  // The run's own verdicts, named in the cell. An absent field reads `-`, never
  // "complete": a record that predates the reading was never checked. The
  // producer's own claim (`citableAs`) rides beside the boolean, and the
  // model/source columns beside it, so a mock-replay claim can never read as a
  // product measurement.
  const verdict = row => {
    const parts = [];
    if (row.complete === true && row.citable === true) parts.push("complete");
    if (row.complete === false) {
      const reasons = row.incompleteReasons?.length > 0
        ? row.incompleteReasons.join(", ") : "reasons not recorded";
      parts.push(`INCOMPLETE: ${reasons}`);
    }
    if (row.citable === false) {
      const reasons = row.measurementReasons?.length > 0
        ? row.measurementReasons.join(", ") : "reasons not recorded";
      parts.push(`NON-CITABLE: ${reasons}`);
    }
    if (row.citableAs !== null && row.citableAs !== undefined) {
      parts.push(`claim: ${row.citableAs}`);
    }
    return parts.length === 0 ? "-" : parts.join("; ");
  };
  const body = rows.map(row => {
    const sends = `${String(row.sends.total)} = ${String(row.sends.answered)}`
      + ` + ${String(row.sends["timed-out"])} + ${String(row.sends["refused-send"])}`;
    const fires = row.plannedFires === null || row.plannedFires === undefined
      ? String(row.fires) : `${String(row.plannedFires)}/${String(row.fires)}`;
    return [row.lane, fires, sends, row.wholeAnswerSends, row.forgetAnswers,
      row.appliedForgets,
      counts(row.sendCauses, SEND_REFUSAL_CAUSES),
      counts(row.rowRefusals, ROW_REFUSAL_CLASSES),
      row.refusedRows, counts(row.refusedCodes, Object.keys(row.refusedCodes ?? {}).sort()),
      counts(row.wireCodes, Object.keys(row.wireCodes ?? {}).sort()),
      row.semantics, fraction(row.keptFraction), fraction(row.keptFractionAnswered),
      verdict(row), row.usageIsEstimated, modelSource(row)].map(cell);
  });
  return [header, rule, ...body].map(cells => `| ${cells.join(" | ")} |`).join("\n");
}

/**
 * The largest prompt a POLICY-FREE plan's fires would send, built with the real
 * ask and `buildPrompt`'s own surface, with no socket. This is not "exactly as
 * the live path builds it": the surface is the raw transcript at fire 0
 * (`simulateSurface()`), with no answer applied and `fireIndex: 0` for every
 * fire, so it is the peak only while the policy changes nothing. A plan that
 * removes anything refuses by name — its later fires read a shaped surface, and
 * reporting the raw surface's peak as that plan's peak would be a measurement
 * this function never took. Building such a surface needs the plan's answers,
 * which `planLane` does not expose; until it does, a removing plan is a live
 * lane's reading, not this one.
 */
export function policyFreePeak(plan, timeline, grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER, floor = FLOOR_BYTES) {
  const removed = (plan?.removedUnits ?? 0) !== 0
    || (plan?.bytesFreedByPolicy ?? 0) !== 0
    || (plan?.bytesFreedGross ?? 0) !== 0;
  if (removed) {
    refuse("sim-batch-policy-free-peak",
      `the plan removes ${String(plan.bytesFreedByPolicy ?? 0)} B net`
      + ` (${String(plan.bytesFreedGross ?? 0)} B gross,`
      + ` ${String(plan.removedUnits ?? 0)} unit(s)), so its later fires read a shaped`
      + " surface; this peak is the raw transcript at fire 0 and cannot report that plan."
      + " Measure the removing plan with the live lane");
  }
  const byId = new Map(eligibleOf(timeline, floor).map(unit => [unit.id, unit]));
  let peakBytes = 0;
  let peakWireBytes = 0;
  let guardTokens = 0;
  let estimatedTokens = 0;
  let at = null;
  const batches = plan.fireBatches ?? [];
  for (const [index, ids] of batches.entries()) {
    const units = ids.map(id => byId.get(id)).filter(unit => unit !== undefined);
    if (units.length === 0) continue;
    const prompt = promptForFire({ timeline, fireStep: plan.fireSteps[index], units, grammar, order,
      // Each fire's own share line (ISSUE-194); the conversation is the raw
      // transcript at fire 0. This is the policy-free surface, and the refusal
      // above is what keeps that word true.
      firstTrigger: index === 0, surface: simulateSurface(), fireIndex: 0,
      // A planned peak is a MEASUREMENT, not a send (the same rule
      // `surfaceDepthAt` states): the guard is a send-time rule, and a plan whose
      // peak crosses it must be able to REPORT that number instead of refusing
      // before the table is built.
      checkGuard: false });
    if (prompt.bytes > peakBytes) {
      peakBytes = prompt.bytes;
      peakWireBytes = prompt.promptWireBytes;
      guardTokens = prompt.guardTokens;
      estimatedTokens = prompt.estimatedTokens;
      at = plan.fireSteps[index];
    }
  }
  return { peakPromptBytes: peakBytes, peakPromptWireBytes: peakWireBytes,
    peakPromptGuardTokens: guardTokens,
    peakPromptTokens: estimatedTokens, peakPromptStep: at };
}

/**
 * The function's old name, kept as one binding so an existing importer keeps
 * working. It is the SAME function: same policy-free surface, same refusal.
 */
export const promptPeakOf = policyFreePeak;

/**
 * One Gate A pin row: fires, carried, the ask ceiling, per-fire pending sizes,
 * peak prompt gauges, segment peak depth. `unit` names what the lane's
 * threshold counts; a batch lane has none. The order rides the row for the same
 * reason the grammar does: the ask bytes move, the pins must not.
 */
export function gateARowOf({ name, mode, size, unit = null, plan, timeline,
  grammar = DEFAULT_ASK_GRAMMAR, order = DEFAULT_ASK_ORDER, floor = FLOOR_BYTES }) {
  const peak = policyFreePeak(plan, timeline, grammar, order, floor);
  return {
    lane: name, mode, size, unit, grammar, order, fires: plan.triggers, carried: plan.carried,
    askCeiling: 2 * plan.triggers + 2, eligible: plan.eligibleResults,
    eligibleSplit: plan.eligibleSplit ?? null,
    pendingSizes: (plan.fireBatches ?? []).map(batch => batch.length),
    ...peak,
    segmentPeakDepth: plan.depthSeries === null ? null : plan.depthSeries.peak,
  };
}

/** The split as one cell: a total is never printed without its parts. */
const splitCell = split => (split === null || split === undefined ? "-"
  : `${String(split.total)} = ${String(split.appends)} appends`
    + ` (${String(split.neverPruned)} never-pruned + ${String(split.prunedOriginals)}`
    + ` host-pruned originals) + ${String(split.replacements)} replacements`);

/**
 * The Gate A markdown table. Each token column is named for the reading it
 * prints: `peak prompt B` is content-only bytes, `tokens @ 3.04` is
 * `ceil(bytes / 3.04)`, and `guard max(content/3, payload/3)` is the larger of
 * the content-only and PAYLOAD-ONLY wire counts `buildPrompt` computes — a max
 * of two readings, not `ceil(peak prompt B / 3)`.
 */
export function gateAMarkdownOf(rows, pins = null) {
  const header = ["lane", "mode", "size", "unit", "fires", "carried", "ask ceiling", "eligible",
    "peak prompt B", "guard max(content/3, payload/3)", "tokens @ 3.04",
    "peak prompt step", "segment peak depth",
    "per-fire pending sizes", "eligible split"];
  const note = "note: `peak prompt B` is content-only bytes; `tokens @ 3.04` is"
    + " ceil(content bytes / 3.04); `guard max(content/3, payload/3)` is the larger of"
    + " ceil(content bytes / 3) and ceil(payload-only wire bytes / 3), and is not"
    + " ceil(peak prompt B / 3).";
  const rule = header.map(() => "---");
  const body = rows.map(row => [row.lane, row.mode, row.size, row.unit, row.fires, row.carried,
    row.askCeiling, row.eligible, row.peakPromptBytes, row.peakPromptGuardTokens,
    row.peakPromptTokens, row.peakPromptStep, row.segmentPeakDepth,
    row.pendingSizes.length === 0 ? "-" : row.pendingSizes.join(","),
    splitCell(row.eligibleSplit)].map(cell));
  const lines = [];
  if (pins !== null) {
    lines.push(`pins: eligible ${pins.eligible} = appends ${pins.appends}`
      + ` (never-pruned ${pins.neverPruned} + pruned originals ${pins.prunedOriginals})`
      + ` + replacements ${pins.replacements}; prune journals ${pins.pruneJournals};`
      + ` peak depth ${pins.peakDepth} at step ${pins.peakStep};`
      + ` header tools ${pins.headerTools}, ${pins.headerToolBytes} B;`
      + ` reasoning ${pins.reasoningBlocks ?? 0} turns, ${pins.reasoningBytes ?? 0} B;`
      + ` segment ${pins.segment}; first excluded step ${pins.firstExcludedStep}`, "");
  }
  lines.push(note, "");
  lines.push([header, rule, ...body].map(cells => `| ${cells.join(" | ")} |`).join("\n"));
  return lines.join("\n");
}

/** The markdown table: one line per lane per policy, header first. */
export function markdownOf(rows) {
  const header = ["lane", "policy", "triggers", "asks", "eligible", "freed B net",
    "freed B gross", "depth first", "peak", "last",
    "Σ depth (est. prompt tokens; not a bill)", "depth ruler", "rereads", "carried",
    "host-prune tokens", "eligible split"];
  const rule = header.map(() => "---");
  const body = rows.map(row => [row.lane, row.policy, row.triggers, row.asks, row.eligible,
    row.bytesFreedByPolicy, row.bytesFreedGross,
    row.depthFirst, row.depthPeak, row.depthLast, row.billedProxy, row.depthRuler,
    row.rereads, row.carried, row.hostTokens, splitCell(row.eligibleSplit)].map(cell));
  return [header, rule, ...body].map(cells => `| ${cells.join(" | ")} |`).join("\n");
}

/** `[{lane, policy, plan}]` → `{rows, markdown}`, the table in both forms. */
export function reportOf(entries) {
  const rows = entries.map(rowOf);
  return { rows, markdown: markdownOf(rows) };
}

function lanesOf(text) {
  const lanes = String(text).split(",").map(part => Number(part.trim()));
  const bad = lanes.find(lane => !Number.isSafeInteger(lane) || lane < 1);
  if (bad !== undefined) refuse("sim-batch-lane-invalid", `--lanes takes positive integers, got ${text}`);
  return lanes;
}

function thresholdsOf(text) {
  const thresholds = String(text).split(",").map(part => Number(part.trim()));
  const bad = thresholds.find(value => !Number.isSafeInteger(value) || value < 1);
  if (bad !== undefined) {
    refuse("sim-batch-threshold-invalid", `--thresholds takes positive integers, got ${text}`);
  }
  return thresholds;
}

function writeReport(markdown, json, dir = REPORT_DIR, names = [REPORT_MARKDOWN, REPORT_JSON]) {
  mkdirSync(dir, { recursive: true });
  for (const [target, body] of [[names[0], `${markdown}\n`],
    [names[1], `${JSON.stringify(json, null, 2)}\n`]]) {
    writeFileSync(`${target}.tmp`, body);
    renameSync(`${target}.tmp`, target);
  }
}

async function main(argv) {
  const { values } = parseDevArgs(argv, {
    options: optionsOf([
      ["--transcript", "string"], ["--usage", "string"], ["--floor", "string"],
      ["--segment", "string"], ["--lanes", "string"], ["--thresholds", "string"],
      ["--policy", "string"], ["--gate-a", "boolean", "gateA"],
      ["--plan", "boolean"], ["--json", "boolean"],
      ["--summary", "string"], ["--planned-fires", "string", "plannedFires"],
      ["--ask-grammar", "string", "askGrammar"],
      ["--ask-order", "string", "askOrder"],
      ["--ignore-host-prunes", "boolean", "ignoreHostPrunes"],
      ["--reconstruction", "boolean"],
      ["--allow-zero-reasoning", "boolean", "allowZeroReasoning"],
    ]),
    refuse: message => refuse("sim-batch-args", message),
    usage: () => USAGE, help: USAGE, prefix: "sim-batch-report.mjs: ",
  });
  const { grammar, order } = assertOrderForGrammar(values.askGrammar ?? DEFAULT_ASK_GRAMMAR,
    values.askOrder ?? DEFAULT_ASK_ORDER);
  if (values.summary !== undefined) {
    const files = String(values.summary).split(",").map(part => part.trim())
      .filter(part => part.length > 0);
    if (files.length === 0) {
      refuse("sim-batch-summary-empty", "--summary takes at least one live run JSON path");
    }
    const planned = values.plannedFires === undefined ? null
      : String(values.plannedFires).split(",").map(part => Number(part.trim()));
    if (planned !== null && (planned.length !== files.length
      || planned.some(value => !Number.isSafeInteger(value) || value < 0))) {
      refuse("sim-batch-summary-planned-invalid",
        `--planned-fires must name one non-negative integer per lane, got ${values.plannedFires}`);
    }
    const rows = files.map((file, at) => campaignRowOf(
      JSON.parse(readFileSync(path.resolve(file), "utf8")),
      { plannedFires: planned === null ? null : planned[at] },
    ));
    process.stdout.write(`${campaignMarkdownOf(rows)}\n`);
    if (values.json === true) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const transcript = values.transcript ?? DEFAULT_TRANSCRIPT;
  const usage = values.usage ?? DEFAULT_USAGE;
  const floor = values.floor === undefined ? FLOOR_BYTES : Number(values.floor);
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid", `--floor takes a non-negative integer, got ${values.floor}`);
  }
  const segment = values.segment === undefined ? null : Number(values.segment);
  if (segment !== null && (!Number.isSafeInteger(segment) || segment < 1)) {
    refuse("sim-batch-segment-invalid", `--segment takes a positive step, got ${values.segment}`);
  }
  const gateA = values.gateA === true || values.plan === true;
  const lanes = gateA ? [...GATE_A_LANES]
    : lanesOf(values.lanes ?? DEFAULT_LANES.join(","));
  const thresholds = gateA ? [...GATE_A_THRESHOLDS]
    : (values.thresholds === undefined ? [] : thresholdsOf(values.thresholds));
  const policies = gateA ? ["keepall"]
    : (values.policy === undefined ? [...POLICIES] : [values.policy]);
  const timeline = readTimeline(transcript, {
    segment, ignoreHostPrunes: values.ignoreHostPrunes === true,
    reconstruction: values.reconstruction === true,
  });
  const depths = depthsInSegment(readUsage(usage), segment);
  // Pins assert before ANY table or send; a drifted transcript refuses by name.
  // The reasoning check runs on every transcript, even when this launcher has
  // no segment to match against the segment pins: declared reasoning must be
  // carried, stored-but-unresendable reasoning refuses, and zero reasoning
  // refuses unless the run explicitly declares a void comparison.
  const allowZeroReasoning = values.allowZeroReasoning === true;
  assertReasoningCarried(timeline, { allowZeroReasoning });
  const pins = segment === null ? surfacePinsOf(timeline, depths)
    : assertSegmentPins(timeline, depths, { allowZeroReasoning,
      input: inputPinsOf({ transcript, usage }) });
  if (segment !== null) {
    process.stdout.write(`[segment] last step ${String(segment)}`
      + `; first excluded step ${String(pins.firstExcludedStep)}\n`);
  }
  // ADR-0041 Decision 6's gate runs on every launcher, not only the live one.
  const pruneGate = assertZeroPruneGate(timeline);
  process.stdout.write(`[prune-gate] ${pruneGate.status}:`
    + ` ${String(pruneGate.events)} event(s) in the filtered world;`
    + ` source world carried ${String(pruneGate.replayedPrunes)} before the filter`
    + ` (whole recording ${String(pruneGate.inputPruneEvents)};`
    + ` reconstruction ${String(pruneGate.reconstruction === true)})\n`);
  if (timeline.ignoreHostPrunes) {
    process.stdout.write(`[host-prunes] ignored ${String(timeline.hostPrunesIgnored)} journals`
      + ` (${String(timeline.hostTokensIgnored)} shadowed tokens);`
      + ` ${String(timeline.hostReplacementsIgnored)} replacement rows left the units\n`);
  }

  if (gateA) {
    const entries = [];
    for (const lane of lanes) {
      entries.push({ name: `batch-${String(lane)}`, mode: "batch", size: lane, unit: null,
        plan: planLane({ timeline, depths, lane, floor }) });
    }
    for (const threshold of thresholds) {
      entries.push({ name: thresholdLaneName(threshold, "depth-tokens"), mode: "threshold",
        size: threshold, unit: "depth-tokens",
        plan: thresholdLane({ timeline, depths, threshold, floor }) });
    }
    for (const threshold of GATE_A_BYTES_THRESHOLDS) {
      entries.push({ name: thresholdLaneName(threshold, "landed-bytes"), mode: "threshold",
        size: threshold, unit: "landed-bytes",
        plan: thresholdLane({ timeline, depths, threshold, floor, thresholdUnits: "landed-bytes" }) });
    }
    const rows = entries.map(entry => gateARowOf({ ...entry, timeline, grammar, order }));
    const markdown = gateAMarkdownOf(rows, pins);
    process.stdout.write(`[grammar] ${grammar}\n`);
    process.stdout.write(`[order] ${order}\n`);
    // The evidence names its void-comparison and reconstruction declarations:
    // a zero-reasoning input is not a measurement, whatever the numbers say.
    const evidence = { pins, rows, allowZeroReasoning,
      reconstruction: timeline.reconstruction === true,
      pruneGate };
    writeReport(markdown, evidence, GATE_A_DIR, [GATE_A_MARKDOWN, GATE_A_JSON]);
    process.stdout.write(`${markdown}\n`);
    process.stdout.write(`wrote ${GATE_A_MARKDOWN}\nwrote ${GATE_A_JSON}\n`);
    if (values.json === true) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  }

  const armRoot = path.dirname(transcript);
  const arm = armOf(readTranscript(transcript).rows, armRoot);
  const entries = [];
  for (const lane of lanes) for (const policy of policies) {
    entries.push({ lane, policy, plan: planWithRereads({
      timeline, depths, lane, floor, producer: policyProducer(policy), arm,
    }) });
  }
  const { rows, markdown } = reportOf(entries);
  writeReport(markdown, rows);
  process.stdout.write(`${markdown}\n`);
  process.stdout.write(`wrote ${REPORT_MARKDOWN}\nwrote ${REPORT_JSON}\n`);
  if (values.json === true) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  });
}
