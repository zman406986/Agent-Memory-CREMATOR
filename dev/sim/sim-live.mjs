#!/usr/bin/env node
/**
 * LEGACY LANE — NOT the sim test, and NOT evidence.
 *
 * This is ISSUE-061 T-9's old lane-F harness. It rebuilds every ask from the
 * pristine recording (`prefixAt` over the raw transcript), so its first
 * historical failure is still live: it does not model the product's surface,
 * its shaped bodies or its carry set. The current offline sim test is
 * `sim-batch-live.mjs` (see `dev/sim/README.md`); nothing in this repo cites
 * this file as evidence.
 *
 * It is kept only because its kill-box and cost arithmetic are referenced by
 * older research notes. Any invocation must pass `--legacy-lane`, which
 * acknowledges that the run is not a sim measurement; without it, `main`
 * refuses by name (`sim-live-legacy-lane`).
 *
 * ISSUE-061 T-9 — lane F's live-pass harness: the plan it can print offline, the
 * gated launch it can run, and the kill box that stops it.
 *
 * Usage:
 *   node dev/sim/sim-live.mjs --legacy-lane --units <live-convert out dir>
 *        --transcript <session.v4.jsonl>
 *        [--arm racoons] [--kill-ms 7200000] [--token-grant <n>] [--ask-ceiling <n>]
 *        [--plan | --live] [--i-am-the-owner] [--producer <module>] [--out <file>] [--json]
 *
 * ## Two modes, one of which cannot reach a socket
 *
 * `--plan` is the default. It prints every moment (its id, its bytes, its line
 * count), the prefix-hash chain the asks are built over, and the cost as TWO
 * numbers — main + asks, never summed silently (plan §2 launch discipline; §3.7).
 * It exits 0 and opens no socket: the live path is not imported, not called, and
 * the test proves it with a loopback listener that must receive zero connections.
 *
 * `--live` is owner-gated. It refuses at exit 2 unless BOTH hold:
 *   - the environment carries `SIM_LIVE_ARMED=1`;
 *   - the command line carries `--i-am-the-owner`.
 * A live pass also refuses without `--token-grant` (the main-wire ceiling the
 * launch command states) and `--ask-ceiling` (plan §7(b)'s own number, because
 * `--token-grant` meters main traffic only and cannot see asks) and `--out` (the
 * partial evidence file).
 *
 * ## The cost, two numbers
 *
 *   askInstruction(N) = 300 + 12·⌊N/100⌋          (plan §3.7, one ask per moment)
 *   τ(x)              = ceil(x/4)                 (plan §3, once per sum, never per term)
 *
 *   main  = Σ τ(prefix bytes)     the fork prompts; this is `--token-grant`
 *   asks  = 300·n + 12·Σ⌊N/100⌋   the instruction/anchor term; this is §7(b)'s ceiling
 *
 * A prefix is every moment turn landed at or before the moment's own step, in
 * the body it held then, joined by the product's `renderHistory` — the bytes the
 * ask rides on. One ask is one request, so τ divides each request's prefix once
 * and the totals are summed after; dividing a total instead would price the asks
 * as though they were one prompt. The record holds tool results, not assistant
 * prose or the ask exchange, so both numbers are a LOWER BOUND over the recorded
 * prefix and print as PROJECTED: the transcript carries no ask usage row.
 *
 * ## The arming names
 *
 * Plan §5 names four tokens (`CREMATOR_SIM_REAL=1`, `--live-asks`,
 * `--owner-authorized`, `--kill-timer-s`); T-9's ticket leaves the exact spelling
 * to the implementer. The landed names are `SIM_LIVE_ARMED=1`, `--live`,
 * `--i-am-the-owner` and `--kill-ms`, and they are the only ones: one pair to arm
 * (env + flag), one mode flag, one box option. An env value alone arms nothing,
 * and a flag alone arms nothing.
 *
 * ## The kill box
 *
 * `--kill-ms` arms a timer BEFORE the first ask. When it fires the harness
 * aborts the in-flight ask, appends a `stop` line to the partial file and exits
 * 124. The partial file is JSONL: one `start` line, one `answer` line per
 * completed moment, one `stop` line. A killed pass is a timeout, never a result.
 * Exit 1 means a ceiling stopped it: §7(b)'s ask ceiling was reached (the
 * remaining moments are recorded as `lane-f-unjudged` and nothing more is asked),
 * or the measured bill reached it, or the `--token-grant` was spent on this
 * lane's prefix projection. The `stop` line names which, and prints both the
 * projected and the billed sum.
 *
 * Every ask also carries its own deadline (`ASK_TIMEOUT_MS`), combined with the
 * box's signal: a stalled stream fails one ask, it does not eat the box.
 *
 * ## The provider, built and not executed here
 *
 * Live mode drives the `a6` / `deepseek-v4.1-flash-1017` route with lane F's
 * `forgetlines` contract (`entryAskMessage({variant:'forgetlines'})`). The request
 * body is built by `buildAskRequest`, and each answer line carries its sha256;
 * the tests assert its shape and never send it. `--producer <module>` is the
 * offline seam: a module exporting `ask({moment, request, row, index, signal})`,
 * used by the kill and ceiling tests so they run with no network at all.
 *
 * Deterministic in plan mode: no clock, no network, no randomness.
 *
 * Exit: 0 = planned or completed; 1 = a spend ceiling stopped it (ask ceiling,
 * billed ceiling or token grant — the `stop` line names which); 2 = a usage
 * error or a named refusal; 3 = every ask refused (a dead pass, not a result);
 * 124 = the kill timer fired.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { entryAskMessage, parseEntryAnswer, splitLineOffsets } from "@cremator/core";
import { entryAskFacts } from "cremator-dsh";
import { indexTranscript, readTranscript } from "./gate3-live-chain.mjs";
import { prefixAt, prefixAtSeq, renderLane } from "./sim-render.mjs";
import { loadRecord, momentsOf } from "./sim-record.mjs";
import { readAppends } from "./sim-stages.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";
import { timerDelayRefusal } from "../shared/timer-ms.mjs";

const USAGE = [
  "usage: sim-live.mjs --units <live-convert out dir> --transcript <session.v4.jsonl>",
  "                    [--arm racoons] [--record-name <name>] [--kill-ms 7200000]",
  "                    [--token-grant <n>] [--ask-ceiling <n>] [--plan | --live]",
  "                    [--i-am-the-owner] [--producer <module>] [--out <file>] [--json]",
  "                    [--variant n|two|f] [--stages <stages.json>] --legacy-lane",
  "       --legacy-lane   REQUIRED acknowledgement: this harness is a LEGACY lane,",
  "                       not the sim test and not evidence; without it, exit 2",
  "       --plan          print the moments, the prefix chain and the two numbers;",
  "                       exit 0, open no socket (default)",
  "       --live          one lane's pass; owner-gated — needs SIM_LIVE_ARMED=1 in",
  "                       the environment AND --i-am-the-owner, plus --token-grant,",
  "                       --ask-ceiling and --out; otherwise exit 2",
  "       --variant       the lane: n (shipped default), two (two-form), f (forgetlines,",
  "                       the default); anything else exits 2",
  "       --stages        a stages.json from the stage scheduler: ask only its moments,",
  "                       in its order",
  "       --kill-ms       the kill box in ms, armed before the first ask; firing it",
  "                       exits 124 and keeps the partial file",
  "       --token-grant   the main-wire ceiling the launch command carries",
  "       --ask-ceiling   §7(b)'s ask ceiling: its own number, outside the grant",
  "       --producer      an offline test seam: a module exporting ask({moment, index})",
  "       --out           the partial evidence file (live only): one start line, one",
  "                       answer line per completed moment, one stop line",
].join("\n");

/** The a6-real route (plan §2 safety law 5; dev/bench/bench-run.mjs:237-238). */
export const PROVIDER = "a6";
export const MODEL = "deepseek-v4.1-flash-1017";
/** Lane F's one partial class (ADR-0027 §4; ISSUE-061 T-8): the default lane. */
export const VARIANT = "forgetlines";
/**
 * The `--variant` names: lane N (the shipped contract), lane 2 (the two-form
 * contract of ADR-0031), lane F (the default, `forgetlines`). Exactly three, and
 * the mapped value is what `entryAskMessage` receives.
 */
export const VARIANTS = { n: "default", two: "twoform", f: "forgetlines" };
/** The reverse map: the variant a plan echoes, the flag letter a launch echoes. */
const LANE_FLAGS = { default: "n", twoform: "two", forgetlines: "f" };
/**
 * The three lanes, keyed by variant: the lane letter the evidence names, the
 * asset the ask actually carries, and the marker that asset leaves in the ask
 * text. The pre-flight reads the last two and refuses a mixed pass.
 */
export const LANES = {
  default: { lane: "n", assetName: "ENTRY_ASK_SYSTEM_PROMPT", marker: "keepall" },
  twoform: { lane: "2", assetName: "ENTRY_ASK_TWOFORM_SYSTEM_PROMPT", marker: '"None"' },
  forgetlines: { lane: "f", assetName: "ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT", marker: "forgetlines" },
};
/**
 * The two arming names: the env flag's value must be exactly `1`, and the owner
 * flag must be on the command line. Both, or the pass refuses at exit 2.
 */
export const LIVE_ENV = "SIM_LIVE_ARMED";
export const OWNER_FLAG = "--i-am-the-owner";
export const DEFAULT_ARM = "racoons";
/** The plan's proposed box (phase-r §6: 7 200 000 ms), until the leader rules. */
export const DEFAULT_KILL_MS = 7_200_000;
/**
 * One ask's own deadline. The box bounds the whole pass; this bounds one stalled
 * stream, so a route that accepts the request and then sends nothing cannot eat
 * the box in a handful of asks. A live ask over a ~250k-token prefix is quick to
 * read and slow to stream, and the measured passes finish in seconds; 180 000 ms
 * (3 min) is well inside the "well inside 5 minutes" a single ask is expected to
 * take, and fifteen stalls at 3 min each is 45 min, still inside the 90-min box.
 */
export const ASK_TIMEOUT_MS = 180_000;

/** A refusal with the code a gate asserts on. */
export class SimLiveRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimLiveRefusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimLiveRefusal(code, detail);
}

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = text => Buffer.from(text, "utf8");

/** τ(x) = ceil(x/4): once per sum, never per term (plan §3). */
export function tau(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    refuse("sim-live-bytes-invalid", `a byte count is a non-negative integer, got ${String(bytes)}`);
  }
  return Math.ceil(bytes / 4);
}

/** Plan §3.7's per-ask instruction term: `A(N) = 300 + 12·⌊N/100⌋`. */
export function askInstruction(N) {
  if (!Number.isSafeInteger(N) || N < 0) {
    refuse("sim-live-lines-invalid", `a line count is a non-negative integer, got ${String(N)}`);
  }
  return 300 + 12 * Math.floor(N / 100);
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--units", "string"],
  ["--transcript", "string"],
  ["--arm", "string"],
  ["--record-name", "string", "recordName"],
  ["--kill-ms", "string", "killMs"],
  ["--token-grant", "string", "tokenGrant"],
  ["--ask-ceiling", "string", "askCeiling"],
  ["--producer", "string"],
  ["--out", "string"],
  ["--variant", "string"],
  ["--stages", "string"],
  ["--plan", "boolean"],
  ["--live", "boolean"],
  [OWNER_FLAG, "boolean", "owner"],
  ["--legacy-lane", "boolean", "legacyLane"],
  ["--json", "boolean"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    units: values.units ?? null,
    transcript: values.transcript ?? null,
    arm: values.arm ?? DEFAULT_ARM,
    recordName: values.recordName ?? null,
    killMs: values.killMs ?? DEFAULT_KILL_MS,
    tokenGrant: values.tokenGrant ?? null,
    askCeiling: values.askCeiling ?? null,
    producer: values.producer ?? null,
    out: values.out ?? null,
    variant: values.variant ?? null,
    stages: values.stages ?? null,
    plan: values.plan ?? false,
    live: values.live ?? false,
    owner: values.owner ?? false,
    legacyLane: values.legacyLane ?? false,
    json: values.json ?? false,
  };
  // `--variant` takes exactly the three lane names and is stored mapped: the
  // value `entryAskMessage` and the plan echo are the contract, not the letter.
  if (opts.variant === null) {
    opts.variant = VARIANT;
  } else {
    const mapped = VARIANTS[opts.variant];
    if (mapped === undefined) {
      refuse("usage", `--variant takes one of n, two, f (got ${String(opts.variant)})`);
    }
    opts.variant = mapped;
  }
  if (opts.plan && opts.live) refuse("usage", "--plan and --live are two modes; name one");
  if (opts.units === null) refuse("usage", "--units is required");
  if (opts.transcript === null) refuse("usage", "--transcript is required");
  // `--kill-ms` always has a value (its default); the other two are optional in
  // plan mode and required in live mode, which `gateLive` states.
  for (const [flag, key] of [["--kill-ms", "killMs"], ["--token-grant", "tokenGrant"],
    ["--ask-ceiling", "askCeiling"]]) {
    if (opts[key] === null) continue;
    const value = Number(opts[key]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse("usage", `${flag} takes a positive integer, got ${String(opts[key])}`);
    }
    if (flag === "--kill-ms") {
      const tooLong = timerDelayRefusal(value, flag);
      if (tooLong !== null) refuse("usage", tooLong);
    }
    opts[key] = value;
  }
  return opts;
}

/**
 * The gate. Both arms are named in the refusal, so an operator who read one line
 * of the plan knows what is missing. Runs before any file is read.
 */
export function gateLive(opts, env = process.env) {
  const armed = env[LIVE_ENV] === "1";
  if (!armed || !opts.owner) {
    const missing = [
      armed ? null : `${LIVE_ENV}=1 in the environment`,
      opts.owner ? null : `${OWNER_FLAG} on the command line`,
    ].filter(Boolean).join(" and ");
    refuse("sim-live-owner-gated",
      `--live is owner-gated: live is armed only with ${LIVE_ENV}=1 and ${OWNER_FLAG};`
      + ` missing ${missing}`);
  }
  if (opts.tokenGrant === null) {
    refuse("sim-live-grant-absent",
      "--live needs --token-grant: the main-wire ceiling the launch command carries");
  }
  if (opts.askCeiling === null) {
    refuse("sim-live-ceiling-absent",
      "--live needs --ask-ceiling: §7(b)'s own number, which --token-grant cannot see");
  }
  if (opts.out === null) {
    refuse("sim-live-out-absent", "--live needs --out: a killed pass keeps its partial file");
  }
}

/**
 * The stage table `--stages` names: another module's `stages.json`, read whole
 * and hashed so the three lanes can prove they shared one list. The shape is
 * `{ stages: [{ step, seq }, …] }` or a bare array; a row names `seq` when it
 * has one and `step` otherwise. An unreadable table is refused by name before
 * any request leaves.
 */
function readStages(file) {
  const raw = readFileSync(path.resolve(process.cwd(), file));
  const stagesSha256 = sha256Hex(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    refuse("sim-live-stages-invalid", `${file}: not JSON (${error.message})`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.stages;
  if (!Array.isArray(rows) || rows.length === 0) {
    refuse("sim-live-stages-invalid", `${file}: no stage rows (expected [{step, seq}, …])`);
  }
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.seq) && !Number.isSafeInteger(row?.step)) {
      refuse("sim-live-stages-invalid", `${file}: a stage row names neither a seq nor a step`);
    }
  }
  return { rows, stagesSha256 };
}

/**
 * The pre-flight (plan §5 B1). Called before `loadProducer`, so a mixed pass
 * never reaches a socket. Three refusals, each by name:
 *   - `sim-live-variant-shared`: two lanes' `sha256(askText)` are not pairwise
 *     distinct, so the pass would compare one prompt against itself;
 *   - `sim-live-asset-mismatch`: a lane's plan does not echo its asset name or
 *     its `askText` does not carry that asset's marker;
 *   - `sim-live-stages-drift`: the lanes were handed different stage tables.
 * A plan is one lane's: its `askTextSha256` hashes the whole ask stream, so a
 * stale or accidentally-shared asset reddens (a) before any socket opens.
 */
export function preflight(plans) {
  for (let left = 0; left < plans.length; left++) {
    for (let right = left + 1; right < plans.length; right++) {
      if (plans[left].askTextSha256 === plans[right].askTextSha256) {
        refuse("sim-live-variant-shared",
          `lanes ${String(plans[left].lane)} and ${String(plans[right].lane)} carry the same`
          + " askText sha256; the three lanes' hashes must be pairwise distinct");
      }
    }
  }
  for (const plan of plans) {
    const lane = LANES[plan.variant];
    if (lane === undefined || plan.assetName !== lane.assetName) {
      refuse("sim-live-asset-mismatch",
        `lane ${String(plan.lane)} echoes asset ${String(plan.assetName)}; variant`
        + ` ${String(plan.variant)} renders ${String(lane?.assetName)}`);
    }
    if (typeof plan.askText !== "string" || !plan.askText.includes(lane.marker)) {
      refuse("sim-live-asset-mismatch",
        `lane ${plan.lane}'s askText does not carry ${String(lane.marker)}, the marker of`
        + ` ${lane.assetName}; the asset behind the variant has drifted`);
    }
  }
  const stageShas = new Set(plans.map(plan => plan.stagesSha256));
  if (stageShas.size > 1) {
    refuse("sim-live-stages-drift",
      `the lanes carry ${String(stageShas.size)} different stages.json sha256 values;`
      + " one stage list, one file");
  }
}

/**
 * The lane's moments with their landed bodies, read from the transcript, and the
 * census's own `askRows` for that arm: plan §3.7's test of whether an ask total is
 * a measurement or a projection. It is 0 on every run so far; the harness prints
 * PROJECTED whenever it is 0 and never claims a measurement it lacks.
 *
 * `moments` is the ASK list: the units the product may prune, which is what an
 * ask is about. `fed` is the PREFIX population: every `tool/result` append in the
 * transcript, sub-floor results included. The floor decides what the product may
 * prune; it never removed anything from what the model saw, so a faithful replay
 * feeds every append, exactly as `sim-stages.mjs` measured the stage table.
 */
export function laneMoments({ units, transcript, arm = DEFAULT_ARM, recordName = null }) {
  const loaded = loadRecord(units);
  const lane = momentsOf(loaded, { recordName }).filter(moment => moment.lane === arm);
  if (lane.length === 0) {
    refuse("sim-live-arm-absent", `${units} carries no unit for arm ${arm}`);
  }
  const askRows = loaded.census?.arms?.[arm]?.askRows ?? null;
  const rows = readTranscript(transcript);
  const index = indexTranscript(rows);
  const moments = lane.map(moment => {
    const text = index.landed.get(moment.seq);
    if (typeof text !== "string") {
      refuse("sim-live-landed-absent",
        `${moment.id} lands at seq ${String(moment.seq)}, which the transcript holds no`
        + " landed append for");
    }
    return { ...moment, original: { ...moment.original, text } };
  });
  const fed = readAppends(rows).map(append => ({
    id: `append:${String(append.seq)}`,
    lane: arm,
    seq: append.seq,
    step: append.step,
    original: { text: append.text },
  }));
  if (fed.length === 0) {
    refuse("sim-live-fed-absent", `${transcript} holds no tool/result append to feed`);
  }
  return { moments, askRows, fed };
}

/**
 * The plan: the pristine prefix chain (no lane-F decision exists yet), one row
 * per moment, and the two cost numbers. Deterministic: same inputs, same bytes.
 * Returns the moments and the render beside the plan, so live mode reads each
 * body once and the plan a reader sees is the plan the pass runs.
 */
export function prepare(opts) {
  const variant = opts.variant ?? VARIANT;
  const { moments, askRows, fed } = laneMoments({
    units: opts.units, transcript: opts.transcript, arm: opts.arm, recordName: opts.recordName,
  });
  // The render is the FED prefix: every append, sub-floor included, because that
  // is the context the model was given. The asks below still ride on `moments`,
  // the prunable units; only the population the prefix is drawn from is wider.
  const rendered = renderLane({ lane: opts.arm, moments: fed, decisions: [] });
  // The stage table, when `--stages` names one: its rows choose and order the
  // asks, and its own sha256 rides on every lane so a drifting list is refused.
  const stages = opts.stages === null || opts.stages === undefined ? null : readStages(opts.stages);
  // Each stage names the trigger's own `seq`; resolving the stage to its moment
  // here means the request it builds already carries that seq. A plain moment
  // (no `--stages`) has none, and the step cut is the fallback.
  const stageRows = stages === null ? null : (() => {
    const bySeq = new Map(moments.map(moment => [moment.seq, moment]));
    const byStep = new Map(moments.map(moment => [moment.step, moment]));
    return stages.rows.map(stage => {
      const moment = Number.isSafeInteger(stage?.seq) ? bySeq.get(stage.seq) : byStep.get(stage.step);
      if (moment === undefined) {
        refuse("sim-live-stages-absent",
          `a stage names seq ${String(stage?.seq)} / step ${String(stage?.step)}, which this lane`
          + " carries no moment for");
      }
      // `triggerSeq` is the scheduler's own field; a plain `{step, seq}` row's
      // `seq` is the trigger seq (`readStages`'s shape), so it stands in.
      const triggerSeq = Number.isSafeInteger(stage?.triggerSeq) ? stage.triggerSeq
        : Number.isSafeInteger(stage?.seq) ? stage.seq : null;
      // The table's own precomputed prefix hash, when it carries one. Plan §5:
      // "a differing prefix hash is refused" — a stage was scheduled over one
      // prefix and this lane renders another, so the ask would be a different one.
      const prefixSha256 = typeof stage?.prefixSha256 === "string" ? stage.prefixSha256 : null;
      return { moment, triggerSeq, prefixSha256 };
    });
  })();
  const triggerSeqOf = new Map((stageRows ?? []).map(({ moment, triggerSeq }) => [moment.id, triggerSeq]));
  const stageOf = new Map((stageRows ?? []).map(row => [row.moment.id, row]));
  const rows = moments.map(moment => {
    const triggerSeq = triggerSeqOf.get(moment.id) ?? null;
    const step = moment.step + 1;
    // The seq cut is the protocol's form: a result whose `seq` is after the
    // trigger's `seq` was not in the trigger's request, even when it landed in
    // the trigger's step. The step cut is the fallback for a moment with no
    // trigger seq.
    const prefix = triggerSeq === null
      ? prefixAt(rendered, step)
      : prefixAtSeq(rendered, triggerSeq, step);
    const text = moment.original.text;
    const lines = splitLineOffsets(utf8(text)).length;
    const request = buildAskRequest(moment, rendered, variant, triggerSeq);
    // Plan §5: the table's precomputed prefix hash must match the one this lane
    // recomputes, or the stage was scheduled over a different prefix and the ask
    // would ride on one the table never chose.
    const staged = stageOf.get(moment.id)?.prefixSha256 ?? null;
    if (staged !== null && staged !== prefix.prefixSha256) {
      refuse("sim-live-prefix-drift",
        `stage ${moment.id} (step ${String(moment.step)}) carries prefix sha256 ${staged},`
        + ` but this lane recomputes ${prefix.prefixSha256}`);
    }
    return {
      id: moment.id,
      seq: moment.seq,
      step: moment.step,
      triggerSeq,
      bytes: moment.bytes,
      lines,
      askText: request.askText,
      askInstruction: askInstruction(lines),
      askBytes: request.askBytes,
      requestSha256: request.requestSha256,
      prefixBytes: prefix.prefixBytes,
      prefixTokens: tau(prefix.prefixBytes),
      prefixSha256: prefix.prefixSha256,
    };
  });
  // The stage order: ask only the stages' moments, in the order the table names.
  const rowById = new Map(rows.map(row => [row.id, row]));
  const ordered = stageRows === null ? rows : stageRows.map(({ moment }) => rowById.get(moment.id));
  const main = ordered.reduce((total, row) => total + row.prefixTokens, 0);
  const floorHundreds = ordered.reduce((total, row) => total + Math.floor(row.lines / 100), 0);
  const asks = 300 * ordered.length + 12 * floorHundreds;
  // The lane's whole ask stream, one moment's message per row in ask order: its
  // sha256 is what the pre-flight compares, so a stale asset cannot pass.
  const askText = ordered.map(row => row.askText).join("\n");
  const lane = LANES[variant];
  const plan = {
    schema: "racoons-sim-live-plan/1",
    lane: lane.lane,
    variant,
    assetName: lane.assetName,
    askText,
    askTextSha256: sha256Hex(utf8(askText)),
    stagesSha256: stages === null ? null : stages.stagesSha256,
    stages: stages === null ? null : stages.rows.length,
    arm: opts.arm,
    units: opts.units,
    transcript: opts.transcript,
    moments: ordered,
    chain: rendered.steps,
    final: rendered.final,
    cost: {
      main,
      asks,
      arithmetic: { n: ordered.length, floorHundreds, base: 300, anchor: 12 },
      grant: opts.tokenGrant ?? main,
      ceiling: opts.askCeiling ?? asks,
      askRows,
      // Plan §3.7: with `askRows = 0` there is no ask usage row to read, so the
      // ask total is a PROJECTION and says so. A census that carried rows here
      // would upgrade the same cell and nothing else.
      projected: askRows === 0 || askRows === null,
      projectedBecause: askRows === 0 || askRows === null
        ? `askRows=${String(askRows)}: the transcript carries no ask usage row, so the ask`
          + " total is a projection"
        : null,
    },
    killMs: opts.killMs,
    stagesFile: opts.stages ?? null,
  };
  return { moments, rendered, plan };
}

/** The plan alone, for a caller that only prints it. */
export function planOf(opts) {
  return prepare(opts).plan;
}

/** The plan as text: every moment, the chain, the two numbers, the launch line. */
export function formatPlan(plan) {
  const { cost } = plan;
  const lines = [
    `sim-live plan (lane ${plan.lane}, ${plan.variant}, asks only; no socket opened)`,
    `  units        ${plan.units}`,
    `  transcript   ${plan.transcript}`,
    `  arm          ${plan.arm}`,
    `  variant      ${plan.variant} (lane ${plan.lane}; the other two lanes ask their own text)`,
    `  asset        ${plan.assetName}`,
    `  askText      ${plan.askTextSha256}`,
    plan.stages === null
      ? "  stages       every moment"
      : `  stages       ${plan.stages} from ${plan.stagesFile} (sha256 ${plan.stagesSha256})`,
    `  moments      ${plan.moments.length}`,
    "  chain",
    ...plan.chain.map(step => `   step ${String(step.step).padStart(3)}  turns ${String(step.turns).padStart(3)}`
      + `  ${String(step.prefixBytes).padStart(7)} B  ${step.prefixSha256}`),
    "  moments (id, bytes, line count, ask prefix)",
    ...plan.moments.map(row => `   seq ${String(row.seq).padStart(4)}  step ${String(row.step).padStart(3)}`
      + `  ${String(row.bytes).padStart(6)} B  ${String(row.lines).padStart(4)} lines`
      + `  ask ${String(row.askInstruction).padStart(4)} tok/${String(row.askBytes).padStart(5)} B`
      + `  prefix ${String(row.prefixBytes).padStart(7)} B ${row.prefixSha256}`
      + `  req ${row.requestSha256.slice(0, 16)}  ${row.id}`),
    "  cost (two numbers, never summed)"
      + (cost.projected ? `   PROJECTED — ${cost.projectedBecause}` : ""),
    `   main   ${cost.main}   Σ τ(prefix bytes) = ceil(bytes/4) per moment; --token-grant meters this`,
    `   asks   ${cost.asks}   300·n + 12·Σ⌊N/100⌋ = 300·${cost.arithmetic.n}`
      + ` + 12·${cost.arithmetic.floorHundreds}; §7(b)'s ceiling, outside the grant`,
    "  launch (armed only; refuses at exit 2 otherwise)",
    `   ${LIVE_ENV}=1 node dev/sim/sim-live.mjs --live ${OWNER_FLAG} --units ${plan.units}`
      + ` --transcript ${plan.transcript} --kill-ms ${plan.killMs}`
      + ` --variant ${LANE_FLAGS[plan.variant]}`
      + ` --token-grant ${cost.grant} --ask-ceiling ${cost.ceiling} --out <partial.jsonl>`,
    "  gating",
    `   --live needs ${LIVE_ENV}=1 AND ${OWNER_FLAG}; a missing one exits 2`,
    `   kill timer ${plan.killMs} ms, armed before the first ask; firing it exits 124`,
    "   and keeps the partial file",
  ];
  return lines.join("\n");
}

/**
 * One ask's request, built for the a6-real route and never sent here. The prefix
 * is the moment turns landed at or before the moment's own step, each projected
 * as one `user` turn (the product's own tool→user projection, `llm-ask.ts`);
 * the ask is lane F's `forgetlines` message, appended last.
 *
 * With `triggerSeq`, the cut is the protocol's own: every turn whose result
 * `seq` is at or before the trigger's, even one that landed in the trigger's
 * step but later. Without it, the step cut is the fallback for a plain moment.
 */
export function buildAskRequest(moment, rendered, variant = VARIANT, triggerSeq = null) {
  if (typeof moment?.original?.text !== "string") {
    refuse("sim-live-body-absent", `${String(moment?.id)} carries no landed body`);
  }
  if (!Number.isSafeInteger(moment.step)) {
    refuse("sim-live-step-absent", `${String(moment.id)} carries step ${String(moment.step)}`);
  }
  if (triggerSeq !== null && (!Number.isSafeInteger(triggerSeq) || triggerSeq < 0)) {
    refuse("sim-live-trigger-invalid", `${String(moment.id)} carries trigger seq ${String(triggerSeq)}`);
  }
  const facts = entryAskFacts(new Uint8Array(utf8(moment.original.text)));
  const askText = entryAskMessage({ ...facts, variant });
  const fed = triggerSeq === null
    ? rendered.rows.filter(row => row.landedStep <= moment.step)
    : rendered.rows.filter(row => Number.isSafeInteger(row.seq) && row.seq <= triggerSeq);
  const turns = fed.map(row => ({ role: "user", content: row.before }));
  const body = {
    model: MODEL,
    stream: true,
    // Plan §2: billed spend is measured, not projected. The route appends a
    // final usage frame; a provider that ignores the option records `usage: null`.
    stream_options: { include_usage: true },
    messages: [...turns, { role: "user", content: askText }],
  };
  return {
    provider: PROVIDER,
    model: MODEL,
    momentId: moment.id,
    askText,
    askBytes: utf8(askText).length,
    body,
    requestSha256: sha256Hex(utf8(JSON.stringify(body))),
  };
}

/**
 * The action one reply text states, read by the product's own grammar. An
 * unreadable reply is `null`, never a guess, and the caller records it as data.
 * Lane F's permitted action is `forgetlines` alone (ADR-0027 §4): an answer
 * naming `keeplines` is the K contract and is recorded outside the arm, never
 * reclassified.
 */
export function actionOf(text) {
  try {
    return parseEntryAnswer(text).action;
  } catch {
    return null;
  }
}

/** The default producer: the real a6 route. Never reached by a test. */
async function a6Producer({ request, signal }) {
  const base = process.env.SIM_LIVE_BASE_URL ?? "https://api.a6api.com/v1";
  const key = process.env.A6_API_KEY;
  if (key === undefined || key === "") {
    refuse("sim-live-key-absent", "A6_API_KEY is not set; the key stays in-process only");
  }
  const response = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) refuse("sim-live-http", `the a6 route answered ${String(response.status)}`);
  const text = await response.text();
  let answer = "";
  let usage = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const chunk = JSON.parse(payload);
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (typeof piece === "string") answer += piece;
      // `stream_options.include_usage` makes the last frame carry the bill. A
      // route that omits it leaves `usage` null, never 0: absent is not zero.
      if (chunk?.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    } catch { /* a non-JSON keepalive frame is the route's own; not answer text */ }
  }
  if (answer === "") refuse("sim-live-empty", "the a6 route returned no text");
  return { text: answer, usage };
}

/** The producer seam: the module's `ask`, or the real route. */
export async function loadProducer(spec) {
  if (spec === null) return ({ request, signal }) => a6Producer({ request, signal });
  const file = path.resolve(process.cwd(), spec);
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    return refuse("sim-live-producer-unreadable", `${file}: ${error.message}`);
  }
  const ask = module.ask ?? module.default;
  if (typeof ask !== "function") {
    refuse("sim-live-producer-invalid", `${file} exports no ask({moment, request, index, signal})`);
  }
  return ask;
}

/** One JSONL line, appended and flushed: a killed pass keeps every finished row. */
function appendLine(file, record) {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Where a lane's evidence lands (plan §7; ISSUE-093's per-lane layout). Given a
 * launch directory — a path with no extension, a trailing separator, or an
 * existing directory — the file is `lane-<n|2|f>.<suffix>`, so three lanes can
 * share one `scratchpad/launch/<date>-<slug>/` without colliding. Given a file
 * path, it is used as written, which keeps every existing invocation and test.
 */
function evidencePath(target, lane, suffix) {
  const resolved = path.resolve(process.cwd(), target);
  const asDirectory = target.endsWith("/") || target.endsWith("\\")
    || path.extname(resolved) === ""
    || (existsSync(resolved) && statSync(resolved).isDirectory());
  return asDirectory ? path.join(resolved, `lane-${lane}.${suffix}`) : resolved;
}

/**
 * The live pass. The kill timer is armed before the first ask; §7(b)'s ceiling is
 * checked before each one. Every completed moment is one `answer` line; the run
 * always ends with one `stop` line, so a reader never guesses why it ended.
 *
 * The request path is the a6 one (`buildAskRequest`): the producer it goes to is
 * the module's `ask` when `--producer` names one, the real route otherwise.
 */
export async function runLive(opts, { producer, rendered, momentsById, plan, renderFor = null }) {
  // The kill timer is armed below from `opts.killMs`; a delay above the
  // platform maximum would fire at 1 ms, so it is refused before any evidence
  // file is written (ISSUE-580).
  const tooLongKill = timerDelayRefusal(opts.killMs, "--kill-ms");
  if (tooLongKill !== null) refuse("sim-live-kill-ms-invalid", tooLongKill);
  const out = evidencePath(opts.out, plan.lane, "partial.jsonl");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    schema: "racoons-sim-live-partial/1", kind: "start", lane: plan.lane, variant: plan.variant,
    assetName: plan.assetName, askTextSha256: plan.askTextSha256,
    stagesSha256: plan.stagesSha256, stages: plan.stages,
    arm: opts.arm, moments: plan.moments.length, killMs: opts.killMs,
    tokenGrant: opts.tokenGrant, askCeiling: opts.askCeiling,
    armedAt: new Date().toISOString(),
  })}\n`);
  const controller = new AbortController();
  let settled = false;
  let killTimer = null;
  let completed = 0;
  // The projections, hoisted so EVERY `stop` line reports them: `spent` is
  // §7(b)'s ask number (instruction + prefix), `mainSpent` is the grant's own
  // main-wire term (Σ τ(prefix), never the instruction). Both are projections;
  // neither is the bill.
  let spent = 0;
  let mainSpent = 0;
  // The bill, measured: `prompt_tokens + completion_tokens` summed over the
  // answers that carried a usage frame. It rides BESIDE the ceiling and is never
  // merged into `spent`, which is the prefix projection. No frame at all leaves
  // it null — absent is not zero.
  let billedTotal = null;
  // A refused ask is a row with `status: "refused"`; a lane where every ask
  // refused asked nothing usable, which is not a completed pass.
  let refused = 0;
  // The `stop` line as written, so `main` echoes the same numbers the evidence
  // carries instead of re-deriving them.
  let stopped = null;
  const exitCode = await new Promise(resolve => {
    const finish = (code, stop) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      stopped = { kind: "stop", completed, refused, spent, mainSpent, billedTotal,
        tokenGrant: opts.tokenGrant, askCeiling: opts.askCeiling, triggered: "none", ...stop };
      appendLine(out, stopped);
      resolve(code);
    };
    // Armed BEFORE the first ask; the plan's own value is the default.
    killTimer = setTimeout(() => {
      controller.abort();
      finish(124, { reason: "kill-timer", killMs: opts.killMs });
    }, opts.killMs);
    (async () => {
      for (const [index, row] of plan.moments.entries()) {
        const cost = row.askInstruction + row.prefixTokens;
        if (spent + cost > opts.askCeiling) {
          const unjudged = plan.moments.slice(index).map(entry => entry.id);
          finish(1, { reason: "ask-ceiling", triggered: "ask-ceiling-projection", unjudged });
          return;
        }
        // The measured bill is checked too, because the projection is low on
        // tool-heavy prefixes and was the only gate: once the frames say the
        // spend has reached the ceiling, the next ask is not sent.
        if (billedTotal !== null && billedTotal >= opts.askCeiling) {
          const unjudged = plan.moments.slice(index).map(entry => entry.id);
          finish(1, { reason: "billed-ceiling", triggered: "billed-ceiling", unjudged });
          return;
        }
        // `--token-grant` is the main-wire ceiling. It is enforced over this
        // lane's own prefix projection, checked before the ask that would pass
        // it; a three-lane total is not available in one process, and the stop
        // line says so (`grantScope`) rather than implying it is.
        if (mainSpent + row.prefixTokens > opts.tokenGrant) {
          const unjudged = plan.moments.slice(index).map(entry => entry.id);
          finish(1, { reason: "token-grant", triggered: "token-grant", unjudged,
            grantScope: "this-lane-only" });
          return;
        }
        spent += cost;
        mainSpent += row.prefixTokens;
        const moment = momentsById.get(row.id);
        const request = buildAskRequest(moment, renderFor === null ? rendered : renderFor(row, moment), plan.variant, row.triggerSeq ?? null);
        // The kill box and a per-ask deadline, combined: the box bounds the whole
        // pass, the deadline bounds one stalled stream, and neither replaces the
        // other. Without the deadline undici's 300 s default is the only bound.
        const askSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]);
        let entry;
        try {
          const answer = await producer({ moment, request, row, index, signal: askSignal });
          const text = typeof answer === "string" ? answer : answer?.text ?? "";
          const usage = typeof answer === "string" ? null : answer?.usage ?? null;
          if (usage !== null) {
            billedTotal = (billedTotal ?? 0) + (usage.prompt_tokens ?? 0)
              + (usage.completion_tokens ?? 0);
          }
          entry = { kind: "answer", index, momentId: row.id, status: "answered",
            step: moment.step, original: moment.original.text,
            askTokens: cost, requestSha256: request.requestSha256, usage,
            action: actionOf(text), answerSha256: sha256Hex(utf8(text)), answer: text };
        } catch (error) {
          entry = { kind: "answer", index, momentId: row.id, status: "refused",
            step: moment.step, original: moment.original.text,
            timedOut: askSignal.aborted && !controller.signal.aborted,
            askTokens: cost, requestSha256: request.requestSha256, usage: null,
            reason: error?.message ?? String(error) };
        }
        if (settled) return;
        completed += 1;
        if (entry.status === "refused") refused += 1;
        appendLine(out, entry);
      }
      // Every ask refused: the lane produced no reading at all, so this is a
      // dead pass and says so instead of exiting 0 like a completed one.
      if (completed > 0 && refused === completed) {
        finish(3, { reason: "all-refused",
          detail: `${String(refused)} of ${String(completed)} asks were refused; no answer line`
            + " carries a reading" });
        return;
      }
      finish(0, { reason: "complete" });
    })().catch(error => finish(2, { reason: "error", detail: String(error?.message ?? error) }));
  });
  return { exitCode, out, billedTotal, stop: stopped };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // LEGACY LANE (twelfth audit item 10): this harness rebuilds asks from the
  // pristine recording and is not the sim test. An invocation must SAY it is
  // the legacy lane; a silent run would be read as a sim measurement.
  if (opts.legacyLane !== true) {
    refuse("sim-live-legacy-lane",
      "sim-live.mjs is a LEGACY lane, not the sim test and not evidence: it rebuilds every"
      + " ask from the pristine recording. Pass --legacy-lane to acknowledge that, or run"
      + " dev/sim/sim-batch-live.mjs for the current sim");
  }
  if (!opts.live) {
    const plan = planOf(opts);
    // A plan file, when `--out` names one, is `lane-<n|2|f>.plan.json` under the
    // launch directory. Plan mode writes no partial file: no request was sent.
    if (opts.out !== null) {
      const file = evidencePath(opts.out, plan.lane, "plan.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
    }
    process.stdout.write(`${opts.json ? `${JSON.stringify(plan, null, 2)}\n` : `${formatPlan(plan)}\n`}`);
    return;
  }
  gateLive(opts);
  // The pre-flight (plan §5 B1) reads all three lanes' plans BEFORE the producer
  // is loaded, so a mixed pass is refused with no socket opened. The requested
  // lane's plan is one of the three, read once.
  const byVariant = new Map(Object.values(VARIANTS)
    .map(variant => [variant, prepare({ ...opts, variant })]));
  preflight([...byVariant.values()].map(entry => entry.plan));
  const { plan, rendered, moments } = byVariant.get(opts.variant);
  const momentsById = new Map(moments.map(moment => [moment.id, moment]));
  const producer = await loadProducer(opts.producer);
  const { exitCode, out, billedTotal, stop } = await runLive(opts,
    { producer, plan, rendered, momentsById });
  // The projected sum and the billed sum are both printed, and the line says
  // which one stopped the pass. They are never summed: one is arithmetic over
  // known bytes, the other is what the route charged.
  const trigger = typeof stop?.triggered === "string" ? stop.triggered : "none";
  process.stdout.write(`sim-live ${exitCode === 0 ? "complete" : "stopped"}: exit ${exitCode},`
    + ` reason ${String(stop?.reason ?? "unknown")}, partial ${out}\n`
    + `  projected ${String(stop?.spent ?? "absent")} ask / ${String(stop?.mainSpent ?? "absent")}`
    + ` main   ceiling ${String(opts.askCeiling)}   grant ${String(opts.tokenGrant)}\n`
    + `  billed ${billedTotal === null ? "absent (no usage frame)" : String(billedTotal)}`
    + `   triggered ${trigger}\n`);
  process.exit(exitCode);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  });
}
