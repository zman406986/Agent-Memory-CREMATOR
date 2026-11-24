#!/usr/bin/env node
/**
 * ISSUE-093 — the three-lane comparison reader. Three partial JSONLs in, one
 * table out, scored by the experiment's pre-registered metric: **applied
 * post-guard bytes dropped per answered ask** (`docs/plans/2026-10-29-prompt-
 * forget-lanes/plan.md` §4).
 *
 * Usage:
 *   node dev/sim/sim-compare.mjs --lane-n <partial.jsonl> --lane-2 <partial.jsonl>
 *        --lane-f <partial.jsonl> [--ceiling <n>] [--json]
 *   node dev/sim/sim-compare.mjs --dir <evidence dir> [--ceiling <n>] [--json]
 *
 * ## The one metric, and what it is read off
 *
 * Every answer row is re-planned by `planEntryShape`, the entry checkpoint's own
 * planner, over the trigger result's original body. The plan is the post-guard
 * reading:
 *
 *   dropped = answered && plan.action === 'shape'
 *             ? originalBytes.length - sum(plan.keptRanges) : 0
 *
 * A `keepall` answer, and a `keeplines` that covers every line with the note
 * `None` (R1), both plan `keepall`: 0 dropped, one denominator entry each. A
 * plain parser reading is never scored here.
 *
 * ## The four classes, one per row
 *
 * - `answered` — an action the lane's contract offers, planned as `keepall` or
 *   `shape`; in the denominator.
 * - `guard-refusal` — an in-contract answer the planner refused (a span past the
 *   body, every line named by `forgetlines`); in the denominator at 0 dropped,
 *   exactly as plan §4's table says.
 * - `out-of-contract` — a form this lane does not offer (lane F's `keeplines`,
 *   lane 2's `keepall`, a subset `keeplines` on lane 2); counted, excluded from
 *   every total.
 * - `null` — no parseable action; counted, not in the denominator.
 *
 * Denominator = `answered` + `guard-refusal`; both are reported so the reading
 * is never guessed. The lane contracts are plan §3's table.
 *
 * ## Never a zero for missing data
 *
 * A lane whose partial file is absent, unreadable, empty or carries a malformed
 * line is `censored (<reason>)` on every number and in the table. So is a lane
 * whose rows do not carry the original body: this module does not invent one.
 * The prune row is `blocked (ISSUE-092)` while that issue is open, never 0.
 *
 * ## Row fields read
 *
 * `answer` (or `text`) — the reply text; `original` (string, or `{text}`),
 * `body` — the trigger result's original body; `momentId` / `stage` / `id` and
 * `step` — labels only; `status` — a transport-refused row is `null`;
 * `billedTokens` or `usage.total_tokens` (else `prompt_tokens +
 * completion_tokens`) — billed spend, the only spend this module prints.
 * `kind: "start"` and `kind: "stop"` lines are metadata, not stage rows.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY_ANSWER_ACTIONS, isKeepEverythingAnswer, parseEntryAnswer, planEntryShape,
  splitLineOffsets,
} from "@cremator/core";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

export const CEILING = 2_250_000;
export const PRUNE_ROW = "blocked (ISSUE-092)";

/** Plan §3's three contracts, one difference per lane and nothing else. */
export const LANE_CONTRACTS = Object.freeze({
  N: { offers: ["keepall", "keeplines", "forgetall"], partialClass: "keeplines" },
  "2": { offers: ["keeplines", "forgetall"], partialClass: null, wholeResultOnly: true },
  F: { offers: ["keepall", "forgetlines", "forgetall"], partialClass: "forgetlines" },
});

const LANE_ALIASES = { n: "N", "2": "2", two: "2", twoform: "2", f: "F" };

/** The minimum `planEntryShape` reads: a session id and a revision. */
const SNAPSHOT = Object.freeze({ sessionId: "sim-compare", revision: "0" });

const USAGE = [
  "usage: sim-compare.mjs --lane-n <partial.jsonl> --lane-2 <partial.jsonl>",
  "                       --lane-f <partial.jsonl> [--ceiling <n>] [--json]",
  "       sim-compare.mjs --dir <evidence dir> [--ceiling <n>] [--json]",
  "       --dir        the pass directory; a lane resolves from",
  "                    <dir>/lane-<key>/partial.jsonl, <dir>/lane-<key>.jsonl or",
  "                    <dir>/partial-<key>.jsonl (key = n, 2, f); a missing",
  "                    lane renders censored, never zero",
  "       --ceiling    the per-lane billed ceiling; default 2,250,000",
].join("\n");

export class SimCompareRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimCompareRefusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimCompareRefusal(code, detail);
}

// ---- load -------------------------------------------------------------------

/**
 * One partial JSONL. Every line is parsed; `start`/`stop` lines are metadata and
 * every other line is a stage row. A file that cannot be read is CENSORED here,
 * never an empty lane: the reason travels with the rows so scoring cannot turn
 * an absent pass into a zero.
 */
export function load(partialPath) {
  let text;
  try {
    text = readFileSync(partialPath, "utf8");
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "partial-missing" : "partial-unreadable";
    return { path: partialPath, rows: [], meta: {}, censored: reason };
  }
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { path: partialPath, rows: [], meta: {}, censored: `partial-malformed-line: ${index + 1}` };
    }
  }
  const meta = {};
  const rows = [];
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return { path: partialPath, rows: [], meta, censored: "partial-malformed-line: not-an-object" };
    }
    if (record.kind === "start") meta.start = record;
    else if (record.kind === "stop") meta.stop = record;
    else rows.push(record);
  }
  return { path: partialPath, rows, meta, censored: rows.length === 0 ? "partial-empty" : null };
}

// ---- score ------------------------------------------------------------------

/**
 * One lane's rows scored by the pre-registered metric. `loaded` is `load()`'s
 * result or a bare row array (a test's hand-written fixture). A censored input
 * returns nulls, never zeros.
 */
export function score(loaded, lane) {
  const key = laneKey(lane);
  const source = normalizeLoaded(loaded);
  if (source.censored !== null) return censoredScore(key, source, source.censored);

  const stages = [];
  const formMix = zeroForms();
  const refusalReasons = {};
  let answeredCount = 0;
  let guardRefusals = 0;
  let outOfContract = 0;
  let unreadable = 0;
  let keepEverything = 0;
  let dropped = 0;
  let floorHundreds = 0;
  let billed = null;

  for (const [index, row] of source.rows.entries()) {
    const id = stageIdOf(row, index);
    const body = originalTextOf(row);
    if (body === null) {
      // No body means no post-guard reading; the lane is censored rather than
      // scored against a plan this module would have to invent.
      return censoredScore(key, source, `original-body-absent: ${id}`);
    }
    const original = utf8(body);
    const lineCount = splitLineOffsets(original).length;
    floorHundreds += Math.floor(lineCount / 100);
    const stage = {
      stage: id, step: Number.isSafeInteger(row.step) ? row.step : null,
      cls: "null", form: null, dropped: null, note: null,
    };
    stages.push(stage);

    const text = answerTextOf(row);
    if (row.status === "refused") {
      unreadable += 1;
      stage.note = row.reason ?? "transport-refused";
      continue;
    }
    let answer;
    if (text === null) {
      unreadable += 1;
      stage.note = "no-answer-text";
      continue;
    }
    try {
      answer = parseEntryAnswer(text);
    } catch (error) {
      unreadable += 1;
      stage.note = error?.code ?? "unreadable";
      continue;
    }
    stage.form = answer.action;
    if (!offered(key, answer, lineCount)) {
      outOfContract += 1;
      stage.cls = "out-of-contract";
      stage.note = "form-not-offered";
      continue;
    }
    formMix[answer.action] += 1;
    if (isKeepEverythingAnswer(answer, lineCount)) keepEverything += 1;
    const plan = planEntryShape(
      { unitId: id, nodeId: id, originalBytes: original, answer }, SNAPSHOT);
    if (plan.action === "shape") {
      answeredCount += 1;
      const kept = plan.keptRanges.reduce(
        (sum, range) => sum + (range.endByteExclusive - range.startByte), 0);
      const stageDropped = original.length - kept;
      dropped += stageDropped;
      stage.cls = "answered";
      stage.dropped = stageDropped;
    } else if (plan.action === "keepall") {
      answeredCount += 1;
      stage.cls = "answered";
      stage.dropped = 0;
    } else {
      // In contract, refused by the planner: answered at 0 dropped (plan §4).
      guardRefusals += 1;
      refusalReasons[plan.code] = (refusalReasons[plan.code] ?? 0) + 1;
      stage.cls = "guard-refusal";
      stage.dropped = 0;
      stage.note = plan.code;
    }
    const billedHere = billedTokensOf(row);
    if (billedHere !== null) billed = (billed ?? 0) + billedHere;
  }

  const answered = answeredCount + guardRefusals;
  const stop = source.meta?.stop;
  return {
    lane: key,
    partial: source.path,
    answered,
    dropped,
    bytesPerAsk: answered === 0 ? null : dropped / answered,
    keepEverythingRate: answered === 0 ? null : keepEverything / answered,
    formMix,
    refusals: guardRefusals,
    refusalReasons,
    outOfContract,
    unreadable,
    keepEverything,
    censored: null,
    stopped: stop === undefined || stop.reason === "complete"
      ? null : { reason: stop.reason ?? "unknown", completed: stop.completed ?? null },
    spend: {
      billed,
      ceiling: CEILING,
      instruction: 300 * source.rows.length + 12 * floorHundreds,
      instructionArithmetic: { n: source.rows.length, floorHundreds },
    },
    stages,
  };
}

function censoredScore(lane, source, reason) {
  return {
    lane, partial: source.path, answered: null, dropped: null, bytesPerAsk: null,
    keepEverythingRate: null, formMix: zeroForms(), refusals: null, refusalReasons: {},
    outOfContract: null, unreadable: null, keepEverything: null, censored: reason,
    stopped: null,
    spend: { billed: null, ceiling: CEILING, instruction: null, instructionArithmetic: null },
    stages: [],
  };
}

/** Whether this lane's contract offers the answer; lane 2 offers one spelling. */
function offered(lane, answer, lineCount) {
  const contract = LANE_CONTRACTS[lane];
  if (!contract.offers.includes(answer.action)) return false;
  if (contract.wholeResultOnly === true && answer.action === "keeplines") {
    return isKeepEverythingAnswer(answer, lineCount);
  }
  return true;
}

// ---- compare ----------------------------------------------------------------

/** Load and score three lanes. `lanes` is `[{ lane, partial }]`, in print order. */
export function compareLanes({ lanes, ceiling = CEILING } = {}) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    refuse("sim-compare-lanes-absent", "compareLanes needs at least one { lane, partial }");
  }
  return {
    ceiling,
    prune: PRUNE_ROW,
    lanes: lanes.map(entry => score(load(entry.partial), entry.lane)),
  };
}

// ---- format -----------------------------------------------------------------

/** The table: one row per stage × lane, per-lane totals, the prune row. */
export function formatTable(compare) {
  if (compare === null || typeof compare !== "object" || !Array.isArray(compare.lanes)) {
    refuse("sim-compare-table-invalid", "formatTable needs compareLanes()'s result");
  }
  const ceiling = Number.isSafeInteger(compare.ceiling) ? compare.ceiling : CEILING;
  const lines = [
    "sim-compare - applied post-guard bytes dropped per answered ask",
    `ceiling ${withCommas(ceiling)} billed tokens per lane`,
  ];
  for (const lane of compare.lanes) {
    lines.push("");
    lines.push(`lane ${lane.lane}   partial ${lane.partial ?? "<in-memory>"}`);
    if (lane.censored !== null) {
      lines.push(`   censored (${lane.censored})`);
      lines.push(`   prune         ${PRUNE_ROW}`);
      continue;
    }
    lines.push(...indent(alignedRows(
      ["stage", "step", "class", "form", "dropped", "note"],
      lane.stages.map(stage => [
        stage.stage,
        stage.step === null ? "-" : String(stage.step),
        stage.cls,
        stage.form ?? "-",
        stage.dropped === null ? "-" : String(stage.dropped),
        stage.note ?? "",
      ]),
    )));
    const parts = [];
    parts.push(`answered ${lane.answered}`);
    parts.push(`guard-refused ${lane.refusals}`);
    parts.push(`bytes/ask ${ratio(lane.bytesPerAsk)}`);
    parts.push(`keep-everything ${rate(lane.keepEverythingRate)}`);
    lines.push(`   totals        ${parts.join("   ")}`);
    lines.push(`   forms         ${ENTRY_ANSWER_ACTIONS
      .map(action => `${action} ${lane.formMix[action]}`).join("  ")}`);
    const refusalDetail = Object.keys(lane.refusalReasons).length === 0
      ? "" : `  (${Object.entries(lane.refusalReasons)
        .map(([code, count]) => `${code} ${count}`).join(", ")})`;
    lines.push(`   refusals      guard ${lane.refusals}${refusalDetail}`
      + `   out-of-contract ${lane.outOfContract}   unreadable ${lane.unreadable}`);
    lines.push(`   spend         ${lane.spend.billed === null
      ? "censored (no-billed-usage)" : withCommas(lane.spend.billed)}`
      + ` / ${withCommas(lane.spend.ceiling)} ceiling`);
    lines.push(`   instruction   300·${lane.spend.instructionArithmetic.n}`
      + ` + 12·${lane.spend.instructionArithmetic.floorHundreds}`
      + ` = ${withCommas(lane.spend.instruction)}`);
    if (lane.stopped !== null) {
      lines.push(`   stopped       ${lane.stopped.reason}`
        + (lane.stopped.completed === null ? "" : ` after ${lane.stopped.completed} asks`)
        + "   (a truncated pass, not a zero)");
    }
    lines.push(`   prune         ${PRUNE_ROW}`);
  }
  return lines.join("\n");
}

// ---- helpers ----------------------------------------------------------------

const utf8 = text => new TextEncoder().encode(text);

function laneKey(lane) {
  const key = LANE_ALIASES[String(lane).toLowerCase()];
  if (key === undefined) {
    refuse("sim-compare-lane-unknown", `lane ${String(lane)} is not one of N, 2, F`);
  }
  return key;
}

function normalizeLoaded(loaded) {
  if (Array.isArray(loaded)) return { path: null, rows: loaded, meta: {}, censored: null };
  if (loaded !== null && typeof loaded === "object" && Array.isArray(loaded.rows)) {
    return {
      path: loaded.path ?? null,
      rows: loaded.rows,
      meta: loaded.meta ?? {},
      censored: loaded.censored ?? null,
    };
  }
  return refuse("sim-compare-rows-invalid", "score needs load()'s result or a row array");
}

function zeroForms() {
  return Object.fromEntries(ENTRY_ANSWER_ACTIONS.map(action => [action, 0]));
}

function stageIdOf(row, index) {
  for (const field of [row.momentId, row.stage, row.id]) {
    if (typeof field === "string" && field.length > 0) return field;
  }
  return `#${index}`;
}

/** The trigger result's original body, in the shapes a partial may carry it. */
function originalTextOf(row) {
  if (typeof row.original === "string") return row.original;
  if (row.original !== null && typeof row.original === "object"
    && typeof row.original.text === "string") return row.original.text;
  if (typeof row.body === "string") return row.body;
  return null;
}

function answerTextOf(row) {
  if (typeof row.answer === "string") return row.answer;
  if (typeof row.text === "string") return row.text;
  return null;
}

/** Billed tokens, never a projection: `askTokens` is the ceiling's arithmetic. */
function billedTokensOf(row) {
  if (Number.isSafeInteger(row.billedTokens)) return row.billedTokens;
  const usage = row.usage;
  if (usage === null || typeof usage !== "object") return null;
  if (Number.isSafeInteger(usage.total_tokens)) return usage.total_tokens;
  const prompt = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const completion = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : null;
  return prompt === null || completion === null ? null : prompt + completion;
}

function ratio(value) {
  return value === null ? "n/a (no answered ask)" : value.toFixed(1);
}

function rate(value) {
  return value === null ? "n/a (no answered ask)" : `${(value * 100).toFixed(1)}%`;
}

function withCommas(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function alignedRows(header, rows) {
  const width = header.map((cell, column) => Math.max(
    cell.length, ...rows.map(row => String(row[column] ?? "").length)));
  return [header, ...rows].map(row => row
    .map((cell, column) => String(cell ?? "").padEnd(width[column]))
    .join("  ").trimEnd());
}

function indent(lines) {
  return lines.map(line => `   ${line}`);
}

// ---- CLI ---------------------------------------------------------------------

const FLAGS = optionsOf([
  ["--lane-n", "string", "laneN"],
  ["--lane-2", "string", "lane2"],
  ["--lane-f", "string", "laneF"],
  ["--dir", "string"],
  ["--ceiling", "string"],
  ["--json", "boolean"],
]);

/** The arguments, validated in sim-record's style: unknown flag is a refusal. */
export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    laneN: values.laneN ?? null,
    lane2: values.lane2 ?? null,
    laneF: values.laneF ?? null,
    dir: values.dir ?? null,
    ceiling: values.ceiling ?? CEILING,
    json: values.json ?? false,
  };
  if (opts.ceiling !== CEILING) {
    const ceiling = Number(opts.ceiling);
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      refuse("usage", `--ceiling needs a positive integer, got ${String(opts.ceiling)}`);
    }
    opts.ceiling = ceiling;
  }
  if (opts.dir === null) {
    for (const [flag, value] of [["--lane-n", opts.laneN], ["--lane-2", opts.lane2],
      ["--lane-f", opts.laneF]]) {
      if (value === null) refuse("usage", `${flag} is required unless --dir is given`);
    }
  }
  return opts;
}

/** The three lanes' partial paths: explicit flags, else `--dir`'s candidates. */
export function resolveLanes(opts) {
  const explicit = { N: opts.laneN, "2": opts.lane2, F: opts.laneF };
  if (opts.dir === null) {
    return ["N", "2", "F"].map(lane => ({ lane, partial: explicit[lane] }));
  }
  return ["N", "2", "F"].map(lane => {
    if (explicit[lane] !== null) return { lane, partial: explicit[lane] };
    const key = lane.toLowerCase();
    const candidates = [
      path.join(opts.dir, `lane-${key}`, "partial.jsonl"),
      path.join(opts.dir, `lane-${key}.jsonl`),
      path.join(opts.dir, `partial-${key}.jsonl`),
    ];
    // A lane whose candidates are all absent keeps the canonical path, so the
    // table names where the file was expected and scores `censored`.
    return { lane, partial: candidates.find(candidate => existsSync(candidate)) ?? candidates[0] };
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const compare = compareLanes({ lanes: resolveLanes(opts), ceiling: opts.ceiling });
  process.stdout.write(opts.json
    ? `${JSON.stringify(compare, null, 2)}\n` : `${formatTable(compare)}\n`);
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
