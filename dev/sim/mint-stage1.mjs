#!/usr/bin/env node
/**
 * ISSUE-059 T-5 — the stage-1 mint: a `live-convert.mjs` record plus its
 * transcript, read into the one file stage 2 scores.
 *
 * Usage:
 *   node dev/sim/mint-stage1.mjs --units <live-convert out dir> --transcript <file>
 *        --out <dir> [--floor 1280] [--arm <name>] [--record-name <name>]
 *        [--run <name>] [--ledger <ledger copy>] [--json]
 *
 * ## The set: three keys, and the decision is the label
 *
 * One JSON line per landed over-floor moment, in `seq` order, with EXACTLY the
 * keys `{source, original, decisions}` (the plan's §1 rule, carried from R-4):
 *
 *   source     the run, the arm, the moment's own id/seq/step/path/session, and
 *              the archive-source `nodeId` the marker's recall id is minted over
 *   original   the landed bytes: sha256, byte count, the `<path>` and the text
 *   decisions  the parsed answer (`action`, `ranges`, `summary`) with the step it
 *              takes effect at, or null when no ask decided the moment
 *
 * The key set is ELIGIBILITY-ONLY. There is no `used`, no `rf` and no
 * `censoredClass` in a row: stage 2 is the only writer of those, and a file
 * written by stage 2 is never read back here. The label is not absent from the
 * file — `decisions` IS the system's own recorded decision — but stage 1 adds no
 * label and reads none. The manifest states that policy under `labels`.
 *
 * A `keepall` rewrites nothing, so its row is `{action: "keepall", step}` and it
 * carries no summary. A fail-open (over-floor, no ask) and the engine's at-rest
 * proof receipt both mint `decisions: null`; the receipt is a machinery removal,
 * never an answer, and its moment id is listed under `labels.rowsWithoutDecision`.
 *
 * ## The admissibility gates, in order (plan §1)
 *
 *   1. FLOOR       a floor below 1280 B — the per-model floor for
 *                  `deepseek-v4.1-flash-1017` (`packages/core/src/config.ts:80`) —
 *                  is refused by name before any file is opened (`--floor 1000`
 *                  exits 2). A floor below the record's own floor is refused by
 *                  the adapter: rows under it were never written.
 *   2. LATCH       a breaker latch refuses the run by name and MINTS NOTHING
 *                  (§1(i), §7(c)). Two shapes, both real: the transcript's
 *                  `racoons:breaker-disabled:<session>` record (the engine's
 *                  `announceBreaker` → `publishAppend` row, whose text is
 *                  `RACOONS disabled after two validation failures…`), and, with
 *                  `--ledger`, a `breaker-disabled` event or a `validation`
 *                  carrying `adjacency-changed` (ISSUE-064).
 *   3. REPRODUCTION  the check handed over from T-4, run twice over the set:
 *                  (a) `gate3-live-chain.mjs`'s `reproRun` re-renders every shaped
 *                  body and the at-rest receipt of the MINTED UNITS and compares
 *                  each to the transcript's own row, byte for byte; (b) every
 *                  minted ROW that carries a shaping decision is re-rendered from
 *                  its own three keys alone and compared to the transcript's
 *                  shaped body (`set-reproduction`). Green is the licence to
 *                  write; red is a NAMED CHECK (`repro-body`, `repro-empty`,
 *                  `set-reproduction`) that prints and exits 1 and writes no
 *                  file — §7(a)'s trigger, never a crash.
 *
 * ## A truncated run is censored, not dropped (plan §4)
 *
 * A transcript that ends before a clean turn end — or whose last line was cut
 * mid-write, the `truncatedFinalLine` shape `live-convert.mjs` names — is
 * censored, never silently shorter: the manifest carries `run.truncated`,
 * `run.endedBy`, the DEPTH (the highest step the transcript reached) and
 * `censoring["censored-at-end"] = {count, depth, truncated, endedBy, lastSeq}`.
 * The complete rows are still minted and the census prints n and |J| beside it.
 *
 * ## What it writes under `--out`
 *
 *   minted-set.jsonl   the rows, one JSON object per line
 *   mint-manifest.json the key set, the label policy, the run's ending and
 *                      depth, the census (landed, over-floor, path-bearing, ask
 *                      prompts, ledger recall ids, decisions with and without an
 *                      answer), the §4 censoring counts, n and |J|, the inputs'
 *                      sha256, and the reproduction report
 *
 * Both files are `.tmp` then renamed. The manifest holds no absolute path and no
 * clock: the same inputs mint byte-identical files into any two directories.
 *
 * Nothing is re-parsed: the record comes from `sim-record.mjs`, the transcript
 * index, the answer steps, the node-id form and the reproduction come from
 * `gate3-live-chain.mjs`; the render is theirs.
 *
 * Exit: 0 = minted; 1 = a named reproduction check failed (nothing written);
 * 2 = a usage error or a named refusal (`<code>: <detail>`).
 */
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_ASK_END_ANCHOR } from "@cremator/core";
import { MIN_FLOOR, floorOf, loadRecord, momentsOf, readLedgerIndex } from "./sim-record.mjs";
import {
  buildRecord, firstByteDifference, indexTranscript, readTranscript, reproRun, textOf,
} from "./gate3-live-chain.mjs";
import { renderMoment } from "./sim-render.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: mint-stage1.mjs --units <live-convert out dir> --transcript <file> --out <dir>",
  "                      [--floor 1280] [--arm <name>] [--record-name <name>]",
  "                      [--run <name>] [--ledger <ledger copy>] [--json]",
  "       --units        a live-convert.mjs output directory (run B: one arm)",
  "       --transcript   the arm's session.v4.jsonl",
  "       --out          the minted-set directory (minted-set.jsonl,",
  "                      mint-manifest.json)",
  "       --floor        the moment floor in landed bytes; default: the record's own;",
  "                      anything below 1280 is refused",
  "       --arm          the lane to mint; default: the record's only lane",
  "       --record-name  the plugin recordName the ask source is named by;",
  "                      default: the record's own arm name",
  "       --run          the run's name in every row; default: the record dir's name",
  "       --ledger       a copied ledger.sqlite; its breaker events are scanned and",
  "                      its recall ids are counted",
  "       --json         print the manifest instead of the summary",
].join("\n");

/** The minted set's top-level key set, in write order. Exactly these three. */
export const KEY_SET = Object.freeze(["source", "original", "decisions"]);

/** The two files one mint writes, in write order. */
export const SET_NAME = "minted-set.jsonl";
export const MANIFEST_NAME = "mint-manifest.json";

/** The §4 censoring classes, in the plan's own order. */
export const CENSORING_CLASSES = Object.freeze([
  "below-floor", "machinery-censored", "ask-failed-fail-open", "unlabelable",
  "failed-join", "censored-at-end", "lane-f-unjudged", "censored-at-cap",
  "no-legal-answer",
]);

/** The row types a transcript can end on without being censored. */
const CLEAN_ENDINGS = Object.freeze(["turn/end", "turn/error", "session/end"]);

/** The record id the engine appends when it disables the breaker (notice.ts). */
const BREAKER_RECORD_PREFIX = "racoons:breaker-disabled:";
/** The notice's own text, for a transcript that dropped the record id. */
const BREAKER_NOTICE = "RACOONS disabled after two validation failures";

/** A refusal with the code a caller asserts on. */
export class MintRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "MintRefusal";
    this.code = code;
  }
}

/** A red reproduction check: not a refusal, the report §7(a) reads. */
export class MintCheckFailed extends Error {
  constructor(report) {
    super(`mint-stage1: RED — ${failureSummary(report.failures)}`);
    this.name = "MintCheckFailed";
    this.report = report;
  }
}

export function refuse(code, detail) {
  throw new MintRefusal(code, detail);
}

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

/** One input file's sha256; an unreadable input is a named refusal. */
function shaOf(file) {
  try {
    return sha256Hex(readFileSync(file));
  } catch (error) {
    return refuse("mint-input-unreadable", `${file}: ${error.message}`);
  }
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--units", "string"],
  ["--transcript", "string"],
  ["--out", "string"],
  ["--floor", "string"],
  ["--arm", "string"],
  ["--record-name", "string", "recordName"],
  ["--run", "string"],
  ["--ledger", "string"],
  ["--json", "boolean"],
]);

/**
 * The arguments, validated. A floor below `MIN_FLOOR` is refused HERE, before any
 * file is opened, so a bad floor can never read a record or a transcript.
 */
export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    units: values.units ?? null,
    transcript: values.transcript ?? null,
    out: values.out ?? null,
    floor: values.floor ?? null,
    arm: values.arm ?? null,
    recordName: values.recordName ?? null,
    run: values.run ?? null,
    ledger: values.ledger ?? null,
    json: values.json ?? false,
  };
  for (const required of ["units", "transcript", "out"]) {
    if (opts[required] === null) refuse("usage", `--${required} is required`);
  }
  if (opts.floor !== null) {
    const floor = Number(opts.floor);
    if (!Number.isSafeInteger(floor) || floor <= 0) {
      refuse("usage", `--floor needs a positive integer, got ${opts.floor}`);
    }
    opts.floor = floor;
  }
  refuseFloor(opts.floor);
  return opts;
}

/** The floor gate, one name, before any record is read. */
export function refuseFloor(floor) {
  if (floor !== null && floor < MIN_FLOOR) {
    refuse("mint-floor-below-keep",
      `--floor ${floor} is below ${MIN_FLOOR}; that is this model's shipped floor, and the`
      + " fixture keeps sub-floor bodies as trimmed copies, so a lower floor would invent"
      + " a reading");
  }
}

/**
 * The transcript as rows, tolerating the one truncation a live run leaves: a
 * final line cut mid-write (the shape `live-convert.mjs` counts as
 * `truncatedFinalLine`). The rows are always the gate's own parse; a corrupt line
 * anywhere else still refuses with the gate's own name.
 */
export function readTranscriptTolerant(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse("mint-transcript-unreadable", `${file}: ${error.message}`);
  }
  try {
    return { rows: readTranscript(file), truncatedFinalLine: false, headText: null };
  } catch (error) {
    if (error?.code !== "gate3-transcript-unreadable") throw error;
    const cut = text.lastIndexOf("\n");
    const headText = cut < 0 ? "" : text.slice(0, cut + 1);
    if (headText.trim().length === 0) throw error;
    // Re-read the head with the gate's own reader, so the rows are one parse.
    return { rows: withTempFile(headText, readTranscript), truncatedFinalLine: true, headText };
  }
}

/** `fn` over a temporary file holding `text`; the directory is removed after. */
function withTempFile(text, fn) {
  const root = mkdtempSync(path.join(tmpdir(), "racoons-mint-stage1-"));
  try {
    const file = path.join(root, "head.session.v4.jsonl");
    writeFileSync(file, text);
    return fn(file);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** The record id a row's own envelope states, in either message shape. */
function recordIdOf(row) {
  const data = row?.data ?? null;
  if (typeof data?.recordId === "string") return data.recordId;
  if (typeof data?.source?.recordId === "string") return data.source.recordId;
  if (typeof data?.message?.source?.recordId === "string") return data.message.source.recordId;
  return null;
}

/**
 * The transcript's breaker latch, or null. The engine appends the notice as one
 * `user/message` record (`announceBreaker` → `publishAppend`) whose
 * `source.recordId` is `racoons:breaker-disabled:<session>`; the notice text is
 * the fallback for a transcript that dropped the envelope.
 */
export function latchOf(rows) {
  for (const [rowIndex, row] of rows.entries()) {
    const recordId = recordIdOf(row);
    const latched = (recordId !== null && recordId.startsWith(BREAKER_RECORD_PREFIX))
      || textOf(row).includes(BREAKER_NOTICE);
    if (latched) return { rowIndex, seq: row?.seq ?? null, type: row?.type ?? null, recordId };
  }
  return null;
}

/**
 * The ledger's breaker latch, or null: a `breaker-disabled` event, or a
 * validation whose issues carry `adjacency-changed` (ISSUE-064), or a validation
 * whose own breaker reading is disabled. An unreadable DB or a corrupt
 * validation payload is a named refusal, never a silent null. Read-only.
 */
export function ledgerLatchOf(file) {
  if (!existsSync(file)) refuse("mint-ledger-absent", `${file} does not exist`);
  let rows;
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      rows = db.prepare("SELECT sequence, kind, payload_json AS payload FROM ledger_events"
        + " ORDER BY sequence").all();
    } finally {
      db.close();
    }
  } catch (error) {
    return refuse("mint-ledger-unreadable", `${file}: ${error.message}`);
  }
  for (const row of rows) {
    if (row.kind === "breaker-disabled") {
      return { kind: "breaker-disabled", sequence: row.sequence, issue: null };
    }
    if (row.kind !== "validation") continue;
    let payload;
    try {
      payload = JSON.parse(String(row.payload));
    } catch (error) {
      // A corrupt row must not read as "no latch" — that would hide a breaker
      // trip (ISSUE-390). Named refusal, distinct from an absent latch.
      return refuse("mint-ledger-corrupt",
        `${file}: validation seq ${row.sequence} payload is not JSON: ${error.message}`);
    }
    if (payload === null) {
      return refuse("mint-ledger-corrupt",
        `${file}: validation seq ${row.sequence} payload is null`);
    }
    const issues = Array.isArray(payload?.issues) ? payload.issues : [];
    if (issues.some(issue => issue?.code === "adjacency-changed")) {
      return { kind: "validation", sequence: row.sequence, issue: "adjacency-changed" };
    }
    if (payload?.breaker?.disabled === true) {
      return { kind: "validation", sequence: row.sequence, issue: "breaker-disabled" };
    }
  }
  return null;
}

/** How many ask prompts the transcript carries — the census's own figure. */
export function askPromptsOf(rows) {
  return rows.filter(row => row?.type === "user/message" && row.surfaceOp === "append"
    && textOf(row).includes(ENTRY_ASK_END_ANCHOR)).length;
}

/** The step the transcript reached: the highest step any row states. */
export function depthOf(rows) {
  let depth = null;
  for (const row of rows) {
    const step = row?.data?.step;
    if (!Number.isSafeInteger(step)) continue;
    if (depth === null || step > depth) depth = step;
  }
  return depth;
}

/** How the transcript ended, and whether that ending is a clean one. */
export function endingOf(rows, truncatedFinalLine) {
  const last = rows[rows.length - 1] ?? null;
  const endedBy = truncatedFinalLine ? "partial-line" : last?.type ?? "empty";
  const complete = !truncatedFinalLine && CLEAN_ENDINGS.includes(last?.type);
  return { endedBy, complete, lastSeq: last?.seq ?? null };
}

/**
 * Whether the run ended early, and why — three independent signals, each named:
 *
 *   partial-line       the transcript's last line was cut mid-write
 *   unfinished-turn    the last row is neither a turn end nor a session end
 *   record-cut         the record holds fewer over-floor units for the arm than
 *                      its own census says landed at the floor (a record sliced
 *                      mid-stream: the census keeps the full count, the units do
 *                      not)
 *
 * The DEPTH is the highest step the minted rows reached when the record is what
 * was cut, and the transcript's own highest step when the transcript is. A short
 * n is therefore always reported with the step it stopped at.
 */
export function truncationOf({ ending, transcriptDepth, moments, censusArm, unitsForArm }) {
  const reasons = [];
  if (ending.endedBy === "partial-line") reasons.push("partial-line");
  if (!ending.complete && ending.endedBy !== "partial-line") reasons.push("unfinished-turn");
  const landedAtFloor = censusArm?.landedAtFloor;
  if (Number.isSafeInteger(landedAtFloor) && unitsForArm < landedAtFloor) {
    reasons.push("record-cut");
  }
  const rowDepth = moments.reduce((depth, moment) =>
    (Number.isSafeInteger(moment.step) && (depth === null || moment.step > depth)
      ? moment.step : depth), null);
  const recordCut = reasons.includes("record-cut");
  return {
    truncated: reasons.length > 0,
    reasons,
    depth: recordCut && reasons.length === 1 ? rowDepth : transcriptDepth,
    transcriptDepth,
    rowDepth,
    unitsForArm,
    landedAtFloor: Number.isSafeInteger(landedAtFloor) ? landedAtFloor : null,
  };
}

/** The lane to mint: the stated one, or the record's only lane. */
export function resolveArm(moments, stated) {
  const lanes = [...new Set(moments.map(moment => moment.lane))];
  const wanted = stated ?? null;
  if (wanted !== null) {
    if (!lanes.includes(wanted)) {
      refuse("mint-arm-absent",
        `--arm ${wanted} names no moment; the record holds ${lanes.join(", ") || "no lane"}`);
    }
    return wanted;
  }
  if (lanes.length === 1) return lanes[0];
  refuse("mint-arm-required",
    `the record holds ${lanes.length} lanes (${lanes.join(", ")}); --arm names the one to mint`);
}

/** A record adapter refusal, re-stated with its own code and detail. */
function guarded(fn) {
  try {
    return fn();
  } catch (error) {
    if (error?.name !== "SimRecordRefusal") throw error;
    refuse(error.code, error.message.replace(/^[^:]+: /, ""));
  }
}

/**
 * The set's rows: `{source, original, decisions}`, nothing else, in moment order.
 * A moment the record names an ask for must carry its answer; a moment with an
 * answer but no ask is refused — a decision is never attached to a receipt or a
 * fail-open.
 *
 * `attribution` is the gate's reading, passed so a refusal can say WHY the
 * answer is missing: the record's own `unitSpan` names the prompt seq it paired
 * the unit with, and the transcript's ask at that seq states other facts, so
 * nobody ever asked about this result. That is a record/transcript disagreement,
 * named, never a row minted mute.
 */
export function mintRows({ moments, decisions, run, arm, attribution = null }) {
  const byMoment = new Map(decisions.map(decision => [decision.momentId, decision]));
  const placedOn = new Map();
  if (attribution !== null) {
    for (const entry of attribution.placed) placedOn.set(entry.target, entry);
  }
  return moments.map(moment => {
    const decision = byMoment.get(moment.id) ?? null;
    const asked = typeof moment.provenance?.source === "string";
    if (asked && decision === null) {
      const span = moment.unitSpan ?? null;
      // What the record's own pairing says: which prompt seq it paired this unit
      // with, and whether the transcript answered THAT prompt about another row.
      const elsewhere = attribution === null || span === null ? null
        : attribution.placed.find(entry => entry.exchange.promptSeq === span.startSeq
          && entry.target !== moment.seq) ?? null;
      const absent = span === null ? "the record names no ask span for it"
        : `the record pairs it with the ask at seq ${String(span.startSeq)}, and`
          + (elsewhere === null
            ? " the transcript holds no answer to that ask"
            : ` the transcript answers that ask about seq ${String(elsewhere.target)} — another`
              + " result's facts, so this unit was never asked");
      refuse("mint-answer-absent",
        `${moment.id} carries a ${String(moment.provenance.composition)} decision and the`
        + ` transcript holds no answer for it: ${absent}`);
    }
    if (!asked && decision !== null) {
      refuse("mint-decision-without-ask",
        `${moment.id} carries an answer but the record names no ask`
        + ` (${String(moment.provenance?.censoredClass ?? "no class")})`);
    }
    const row = {
      source: {
        run,
        arm,
        recordName: moment.provenance?.recordName ?? null,
        momentId: moment.id,
        lane: moment.lane ?? null,
        session: moment.session ?? null,
        seq: moment.seq ?? null,
        step: moment.step ?? null,
        path: moment.path ?? null,
        nodeId: moment.source?.nodeId ?? null,
      },
      original: {
        sha256: moment.original?.sha256 ?? null,
        bytes: moment.bytes ?? null,
        path: moment.path ?? null,
        text: moment.original?.text ?? null,
      },
      decisions: decision === null ? null : { ...decision.answer, step: decision.step },
    };
    const keys = Object.keys(row);
    if (keys.length !== KEY_SET.length || keys.some((key, at) => key !== KEY_SET[at])) {
      refuse("mint-key-set",
        `a row's keys are ${keys.join(", ")}; the set is ${KEY_SET.join(", ")}`);
    }
    return row;
  });
}

/** The §4 censoring counts, each named; a count that cannot be read is null. */
export function censoringOf({ moments, censusArm, truncation, askPrompts }) {
  const count = predicate => moments.filter(predicate).length;
  const belowFloor = Number.isSafeInteger(censusArm?.appends)
    && Number.isSafeInteger(censusArm?.landedAtFloor)
    ? censusArm.appends - censusArm.landedAtFloor : null;
  return {
    "below-floor": belowFloor,
    "machinery-censored": count(moment =>
      moment.provenance?.censoredClass === "machinery-at-rest-removal"),
    "ask-failed-fail-open": count(moment =>
      moment.provenance?.composition === "ask-failed-fail-open"),
    unlabelable: count(moment => typeof moment.path !== "string" || moment.path.length === 0),
    "failed-join": 0,
    // The run ended before it finished: censored, and it keeps its depth.
    "censored-at-end": {
      count: truncation.truncated ? 1 : 0,
      depth: truncation.depth,
      truncated: truncation.truncated,
      reasons: truncation.reasons,
      endedBy: truncation.endedBy,
      lastSeq: truncation.lastSeq,
    },
    "lane-f-unjudged": 0,
    "censored-at-cap": 0,
    "no-legal-answer": 0,
  };
}

/** The manifest: what was read, what was minted, and the check that licensed it. */
export function manifestOf({
  run, arm, unitsDir, floor, recordFloor, loaded, moments, rows, decisions,
  censusArm, truncation, ending, truncatedFinalLine, repro, ledgerIndex, inputs, setRepro,
  askPrompts,
}) {
  const pathBearing = moments.filter(moment => typeof moment.path === "string"
    && moment.path.length > 0).length;
  const withAnswer = rows.filter(row => row.decisions !== null).length;
  return {
    schema: "racoons-sim-mint-stage1/1",
    stage: 1,
    keySet: [...KEY_SET],
    labels: {
      decisionIsLabel: true,
      statement: "`decisions` is the system's own recorded answer for the moment and IS the"
        + " label; stage 1 adds no label and reads none. `used`, `rf` and `censoredClass`"
        + " belong to stage 2 and appear in no row of this set.",
      rowsWithoutDecision: rows.filter(row => row.decisions === null)
        .map(row => row.source.momentId),
    },
    run: {
      name: run,
      arm,
      recordDir: path.basename(path.resolve(unitsDir)),
      floor,
      recordFloor,
      endedBy: truncation.truncated && truncation.reasons.includes("partial-line")
        ? "partial-line" : ending.endedBy,
      truncated: truncation.truncated,
      truncatedReasons: truncation.reasons,
      truncatedFinalLine,
      depth: truncation.depth,
      lastSeq: ending.lastSeq,
    },
    inputs,
    census: {
      landed: Number.isSafeInteger(censusArm?.appends) ? censusArm.appends : null,
      overFloor: moments.length,
      pathBearing,
      n: pathBearing,
      j: moments.length,
      askPrompts,
      ledgerRecallIds: ledgerIndex === null ? null : moments.filter(moment =>
        typeof moment.provenance?.recallId === "string"
        && ledgerIndex.has(moment.provenance.recallId)).length,
      decisions: withAnswer,
      withoutAnswer: rows.length - withAnswer,
      shaped: moments.filter(moment => moment.unitSpan !== null).length,
      unlabelable: moments.length - pathBearing,
    },
    censoring: censoringOf({ moments, censusArm, truncation, askPrompts }),
    recordCensoring: loaded.census?.censoring ?? null,
    reproduction: {
      mode: repro.mode,
      verdict: repro.verdict,
      shaped: repro.shaped,
      coverage: repro.coverage ?? null,
      nodeIdForm: repro.nodeIdForm,
      nodeIdResolved: repro.nodeIdResolved,
      checks: [...repro.checks, setRepro.check],
      failures: [...repro.failures, ...setRepro.failures],
      setReproduction: setRepro,
    },
    decisionsMinted: decisions.length,
    rows: rows.length,
  };
}

/** The red verdict: the check names, counted. */
export function failureSummary(failures) {
  const named = {};
  for (const failure of failures) named[failure.check] = (named[failure.check] ?? 0) + 1;
  return Object.entries(named).map(([name, count]) => `${name}×${count}`).join(" ");
}

/** The human summary: counts and the verdict; no ratio and no derived number. */
export function summaryOf(manifest, { outDir = null } = {}) {
  const censoring = Object.entries(manifest.censoring)
    .map(([name, value]) => (value !== null && typeof value === "object"
      ? `${name}=${value.count}(depth ${String(value.depth)})` : `${name}=${String(value)}`))
    .join(" ");
  const lines = [
    "mint-stage1",
    `  run          ${manifest.run.name} (arm ${manifest.run.arm})`,
    `  record       ${manifest.run.recordDir}, floor ${manifest.run.floor}`
      + ` (record ${manifest.run.recordFloor})`,
    `  depth        ${String(manifest.run.depth)} (ended ${manifest.run.endedBy}`
      + `${manifest.run.truncated ? ", truncated" : ""})`,
    `  census       landed ${String(manifest.census.landed)}, over-floor`
      + ` ${manifest.census.overFloor}, path-bearing ${manifest.census.pathBearing},`
      + ` ask prompts ${String(manifest.census.askPrompts)}, ledger recall ids`
      + ` ${manifest.census.ledgerRecallIds === null ? "n/a"
        : String(manifest.census.ledgerRecallIds)}`,
    `  decisions    ${manifest.census.decisions} with a parsed answer and step,`
      + ` ${manifest.census.withoutAnswer} without`,
    `  censoring    ${censoring}`,
    `  n            ${manifest.census.n} of |J| ${manifest.census.j}`,
    `  reproduction ${manifest.reproduction.verdict} — ${manifest.reproduction.shaped}`
      + ` shaped body(ies) reproduced byte for byte (node-id`
      + ` ${String(manifest.reproduction.nodeIdForm)})`,
    ...(manifest.reproduction.coverage === null ? []
      : [`  coverage     ${manifest.reproduction.coverage.matched} matched,`
        + ` ${manifest.reproduction.coverage.censored} censored by name,`
        + ` ${manifest.reproduction.coverage.refused} refused by name of`
        + ` ${manifest.reproduction.coverage.total} body(ies)`]),
    `  keys         ${manifest.keySet.join(", ")} (the decision IS the label;`
      + " stage 2 adds used/rf/censoredClass)",
  ];
  if (outDir !== null) {
    lines.push(`  wrote        ${SET_NAME} ${manifest.rows} row(s), ${MANIFEST_NAME}`);
    lines.push(`  out          ${outDir}`);
  }
  lines.push(`mint-stage1: ${manifest.reproduction.verdict} — ${manifest.rows} row(s),`
    + ` n ${manifest.census.n} of |J| ${manifest.census.j}, ${manifest.reproduction.shaped}`
    + " shaped body(ies) byte for byte");
  return lines.join("\n");
}

/**
 * A record directory holding exactly the minted units, so the reproduction runs
 * over the set that will be written — never over rows the mint drops. The census
 * and join sidecars are copied verbatim; the units file keeps their own JSON.
 */
function mintedRecordDir(loaded, unitIds, fn) {
  const root = mkdtempSync(path.join(tmpdir(), "racoons-mint-set-"));
  try {
    const units = loaded.units.filter(unit => unitIds.has(unit.unitId));
    writeFileSync(path.join(root, "live-units.jsonl"),
      `${units.map(unit => JSON.stringify(unit)).join("\n")}\n`);
    for (const name of ["live-census.json", "live-join.json"]) {
      writeFileSync(path.join(root, name),
        readFileSync(path.join(loaded.dir, name)));
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * The set's own reproduction: every minted row that carries a shaping decision is
 * re-rendered from ITS THREE KEYS ALONE — `source.nodeId`, `original.text` and
 * `decisions` — and compared to the transcript's shaped body at that seq, byte
 * for byte. This is what proves the file stage 2 consumes reproduces run B, not
 * merely that the record it came from did: a row altered between record and set
 * reddens here and nowhere else.
 *
 * A row with no decision (a fail-open, the engine's at-rest receipt) rewrites
 * nothing and is counted, not compared. A shaping decision whose seq carries no
 * shaped body is red: the set claims a shape the transcript does not hold.
 */
export function setReproductionOf({ rows, moments, index }) {
  const byMoment = new Map(moments.map(moment => [moment.id, moment]));
  const failures = [];
  let checked = 0;
  let compared = 0;
  for (const row of rows) {
    checked += 1;
    const decision = row.decisions;
    if (decision === null || decision.action === "keepall") continue;
    const moment = byMoment.get(row.source.momentId);
    const oracle = moment === undefined ? undefined : index.shaped.get(moment.seq);
    if (oracle === undefined) {
      failures.push({
        check: "set-reproduction",
        detail: `seq ${String(row.source.seq)}: the set carries a ${decision.action} decision and`
          + " the transcript holds no shaped body at that seq",
      });
      continue;
    }
    // The row's OWN bytes and its OWN sha256, never the record's: the set is what
    // stage 2 consumes, so a row altered between record and set must redden here.
    const candidate = {
      ...moment,
      original: { ...moment.original, text: row.original.text, sha256: row.original.sha256 },
      source: { nodeId: row.source.nodeId },
    };
    let rendered;
    try {
      rendered = renderMoment(candidate,
        { momentId: row.source.momentId, step: decision.step, answer: decision });
    } catch (error) {
      failures.push({
        check: "set-reproduction",
        detail: `seq ${String(row.source.seq)}: the row's three keys do not render`
          + ` (${error?.message ?? String(error)})`,
      });
      continue;
    }
    compared += 1;
    if (rendered.after !== oracle.body) {
      failures.push({
        check: "set-reproduction",
        detail: `seq ${String(row.source.seq)}: the row's three keys re-render to other bytes`
          + ` (${firstByteDifference(rendered.after, oracle.body)})`,
      });
    }
  }
  return {
    check: { name: "set-reproduction", checked, failed: failures.length },
    compared,
    failures,
  };
}

/**
 * The mint, whole: read the transcript, gate it, reproduce the minted set, build
 * the rows and the manifest. Returns `{rows, manifest}`; writes nothing (the
 * caller does). A red reproduction throws `MintCheckFailed` with its report.
 */
export function mintStage1({
  unitsDir, transcriptFile, floor = null, arm = null, recordName = null,
  run = null, ledgerFile = null,
}) {
  refuseFloor(floor);
  const parsed = readTranscriptTolerant(transcriptFile);
  if (parsed.rows.length === 0) {
    refuse("mint-transcript-empty",
      `${transcriptFile} holds no row; an absent oracle is never a pass`);
  }
  const index = indexTranscript(parsed.rows);
  const latch = latchOf(parsed.rows);
  if (latch !== null) {
    refuse("mint-breaker-latched",
      `the transcript carries the breaker latch at seq ${String(latch.seq)}`
      + ` (${String(latch.type)}${latch.recordId === null ? "" : `, ${latch.recordId}`});`
      + " plan §1(i): no breaker-disabled, no adjacency-changed — a latch means no mint");
  }
  let ledgerIndex = null;
  if (ledgerFile !== null) {
    const fromLedger = ledgerLatchOf(ledgerFile);
    if (fromLedger !== null) {
      refuse("mint-breaker-latched",
        `the ledger carries ${fromLedger.kind} at sequence ${String(fromLedger.sequence)}`
        + `${fromLedger.issue === null ? "" : ` (${fromLedger.issue})`};`
        + " plan §1(i) — a latch means no mint");
    }
    ledgerIndex = guarded(() => readLedgerIndex(ledgerFile));
  }
  const loaded = guarded(() => loadRecord(unitsDir));
  const recordFloor = guarded(() => floorOf(loaded));
  const wantedFloor = floor ?? recordFloor;
  const moments = guarded(() => momentsOf(loaded, {
    floor: wantedFloor, recordName, ledgerIndex,
  }));
  if (moments.length === 0) {
    refuse("mint-no-moments",
      `${unitsDir} holds no moment at floor ${wantedFloor}; an empty set is censored,`
      + " never minted green");
  }
  const noLegal = loaded.census?.censoring?.["no-legal-answer"] ?? 0;
  if (noLegal !== 0) {
    refuse("mint-no-legal-answer",
      `the record counts ${String(noLegal)} no-legal-answer unit(s); any occurrence is a`
      + " defect, not a statistic");
  }
  const chosenArm = resolveArm(moments, arm);
  const lane = moments.filter(moment => moment.lane === chosenArm);
  if (lane.length === 0) {
    refuse("mint-arm-absent", `${unitsDir} carries no moment for arm ${chosenArm}`);
  }
  const runName = run ?? path.basename(path.resolve(unitsDir));
  const ending = endingOf(parsed.rows, parsed.truncatedFinalLine);
  const depth = depthOf(parsed.rows);
  const censusArm = loaded.census?.arms?.[chosenArm] ?? null;
  const unitIds = new Set(lane.map(moment => moment.id));

  // ---- the reproduction: green is the licence to write --------------------
  // An absent oracle is never a pass: a set with no shaped body and no at-rest
  // receipt has nothing a re-render could compare, and the gate would refuse it
  // as a render problem rather than name the empty set. Named here first.
  if (!lane.some(moment => moment.unitSpan !== null
    || moment.provenance?.censoredClass === "machinery-at-rest-removal")) {
    throw new MintCheckFailed({
      mode: "check-repro", shaped: 0, checks: [], failures: [{ check: "repro-empty",
        detail: `${lane.length} moment(s) and not one shaped body or at-rest receipt:`
          + " an absent oracle is never a pass" }],
    });
  }
  const reproduce = file => {
    try {
      return mintedRecordDir(loaded, unitIds, minted =>
        reproRun({
          recordDir: minted, transcriptFile: file, arm: chosenArm, nodeIdForm: "auto",
        }));
    } catch (error) {
      // A record whose bodies cannot even be re-rendered (a source id no form
      // names, an original whose bytes miss its stated sha256) is §7(a)'s case
      // too: a NAMED red check with the refusal's own detail, never a crash and
      // never a silent pass. Anything else is a real defect and is rethrown.
      if (error?.name !== "Gate3Refusal" && error?.name !== "SimRenderRefusal") throw error;
      throw new MintCheckFailed({
        mode: "check-repro", shaped: 0, checks: [], failures: [{ check: "repro-body",
          detail: `${error.code}: ${error.message.replace(/^[^:]+: /, "")}` }],
      });
    }
  };
  const repro = parsed.truncatedFinalLine
    ? withTempFile(parsed.headText, reproduce) : reproduce(transcriptFile);
  if (repro.report.verdict !== "GREEN") throw new MintCheckFailed(repro.report);

  // The node-id form is the one the green reproduction resolved, never a guess:
  // `buildRecord` re-reads the minted units under that form and hands back each
  // moment's landed text and archive-source id.
  const built = mintedRecordDir(loaded, unitIds, minted => buildRecord({
    recordDir: minted, rows: parsed.rows, arm: chosenArm, form: repro.report.nodeIdForm,
  }));
  const builtById = new Map(built.record.moments.map(moment => [moment.id, moment]));
  const merged = lane.map(moment => {
    const source = builtById.get(moment.id);
    if (source === undefined) {
      refuse("mint-moment-not-reproduced",
        `${moment.id} is in the minted set and the reproduction read no moment of that id`);
    }
    return {
      ...moment,
      original: { ...moment.original, text: source.original.text },
      source: { nodeId: source.source.nodeId },
    };
  });

  const rows = mintRows({
    moments: merged, decisions: built.record.decisions, run: runName, arm: chosenArm,
    attribution: built.attribution,
  });
  // The set reproduces: every row's three keys re-render to the transcript's own
  // shaped body. A red here is a named check, never a crash and never a partial
  // write — §7(a)'s trigger, fed the same way the record-level pass feeds it.
  const setRepro = setReproductionOf({ rows, moments: merged, index });
  if (setRepro.failures.length > 0) {
    throw new MintCheckFailed({
      ...repro.report, checks: [...repro.report.checks, setRepro.check],
      failures: [...repro.report.failures, ...setRepro.failures],
    });
  }
  const truncation = {
    ...truncationOf({
      ending,
      transcriptDepth: depth,
      moments: merged,
      censusArm,
      // The units file holds every over-floor row the record was written with;
      // a higher requested floor narrows `moments`, never `loaded.units`, so the
      // cut is measured against the record's own row count.
      unitsForArm: loaded.units.filter(unit => unit.arm === chosenArm).length,
    }),
    endedBy: ending.endedBy,
    lastSeq: ending.lastSeq,
  };
  const manifest = manifestOf({
    run: runName,
    arm: chosenArm,
    unitsDir,
    floor: wantedFloor,
    recordFloor,
    loaded,
    moments: merged,
    rows,
    decisions: built.record.decisions,
    censusArm,
    truncation,
    ending,
    truncatedFinalLine: parsed.truncatedFinalLine,
    repro: repro.report,
    ledgerIndex,
    setRepro,
    askPrompts: askPromptsOf(parsed.rows),
    inputs: {
      transcriptSha256: shaOf(transcriptFile),
      unitsSha256: shaOf(path.join(unitsDir, "live-units.jsonl")),
      censusSha256: shaOf(path.join(unitsDir, "live-census.json")),
      joinSha256: shaOf(path.join(unitsDir, "live-join.json")),
    },
  });
  // The manifest's own numbers must agree with the file it describes.
  if (manifest.rows !== rows.length || manifest.census.j !== rows.length) {
    refuse("mint-count-mismatch", `${rows.length} rows, manifest says ${manifest.rows}`);
  }
  return { rows, manifest, moments: merged, index };
}

/** Write the set and its manifest; both `.tmp` then renamed. */
export function writeMint(outDir, { rows, manifest }) {
  mkdirSync(outDir, { recursive: true });
  const write = (name, text) => {
    const target = path.join(outDir, name);
    writeFileSync(`${target}.tmp`, text);
    renameSync(`${target}.tmp`, target);
  };
  write(SET_NAME, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  write(MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), opts.out);
  const minted = mintStage1({
    unitsDir: path.resolve(process.cwd(), opts.units),
    transcriptFile: path.resolve(process.cwd(), opts.transcript),
    floor: opts.floor,
    arm: opts.arm,
    recordName: opts.recordName,
    run: opts.run,
    ledgerFile: opts.ledger === null ? null : path.resolve(process.cwd(), opts.ledger),
  });
  writeMint(outDir, minted);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(minted.manifest, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${summaryOf(minted.manifest, { outDir })}\n`);
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error?.name === "MintCheckFailed") {
      for (const failure of error.report.failures) {
        process.stdout.write(`FAIL ${failure.check} ${failure.detail}\n`);
      }
      process.stdout.write(`mint-stage1: RED — ${failureSummary(error.report.failures)}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
