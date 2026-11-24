#!/usr/bin/env node
/**
 * ISSUE-093 item 3 — the stage scheduler: a recorded transcript in, the fifteen
 * (target, step, trigger seq, fed bytes, prefix hash) rows out.
 *
 * Usage:
 *   node dev/sim/sim-stages.mjs --transcript <session.v4.jsonl> [--arm <name>]
 *        [--out <file>]
 *
 * ## The stage rule, which is the measured one and not the obvious one
 *
 * A target picks the FIRST step whose tau(fed at its trigger) >= target, where:
 *
 *   trigger(step)  the newest over-floor `tool/result` append at or before that
 *                  step: max seq with append.step <= step and append.bytes >=
 *                  FLOOR_BYTES (512, the sim route's floor: ADR-0051).
 *   fed(seq)       every `tool/result` append with seq <= trigger, summed —
 *                  sub-floor results INCLUDED. They were fed; only the trigger
 *                  skips them. Filtering fed at the floor is the wrong table:
 *                  99 926 B at stage 1 instead of the measured 101 130 B.
 *   tau(x)         ceil(x / 4), `sim-score.mjs`'s `tokenizeBytes`.
 *
 * "billed >= target" is a different rule and yields the plan's wrong table.
 *
 * Targets: 20 000 ... 240 000 on a 20 000 grid, plus three dense samples
 * bracketing the record's billed 200 000 crossing. Fifteen stages. On the
 * reference record this reproduces
 * `docs/plans/2026-10-29-prompt-forget-lanes/plan.md` §2 exactly, the 240 000
 * target landing at step 56.
 *
 * ## The prefix
 *
 * Every append is one `tool` moment, rendered by the shipped `renderLane` with
 * no decisions; a stage's prefix is the append rows with seq <= its trigger,
 * joined by the product's separator (a blank line). `prefixBytes` is therefore
 * `fedBytes + 2 * (turns - 1)`: the plan's byte figures exclude the separators,
 * so its projection 2 141 905 becomes 2 142 363 here — still under the ceiling.
 *
 * ## Refusals, each by name and with its own exit code
 *
 *   stage-no-trigger        no step's tau(fed) reaches the target            3
 *   stage-after-compaction  a trigger seq is past `compaction/start`         4
 *   stages-over-ceiling     sum of tau(prefix) > 2 250 000                   5
 *   usage or input error                                                     2
 *
 * Deterministic and offline: no clock, no network, no randomness.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { floorForModel, renderHistory } from "@cremator/core";
import { readTranscript, textOf } from "./gate3-live-chain.mjs";
import { renderLane } from "./sim-render.mjs";
import { tokenizeBytes } from "./sim-score.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: sim-stages.mjs --transcript <session.v4.jsonl> [--arm <name>] [--out <file>]",
  "       --transcript  the arm's session.v4.jsonl: the tool/result appends and the",
  "                     record's own `compaction/start` seam",
  "       --arm         the lane label the stage render carries (default racoons)",
  "       --out         write the stage table as JSON (<name>.tmp then rename)",
].join("\n");

/** The model whose floor defines an over-floor append: the sim's own route
 * model. It is not in core's per-model table, so the product default (512 bytes,
 * ADR-0051) applies. */
export const MODEL = "deepseek-flash";

/** The floor, in landed bytes: this model's shipped value (the core default). */
export const FLOOR_BYTES = floorForModel(MODEL);

/** The 20 000-token grid, 20 000 through 240 000. */
export const GRID_TARGETS = Object.freeze([
  20000, 40000, 60000, 80000, 100000, 120000,
  140000, 160000, 180000, 200000, 220000, 240000,
]);

/**
 * The three dense samples, in tokens, bracketing the record's billed 200 000
 * crossing. The plan and ISSUE-093 name the dense STAGES by step — 27, 28, 30 —
 * so each target is a round thousand inside that step's band on the reference
 * record (tau(fed): 163 935 at step 26, 169 709 at 27, 174 828 at 28, 180 390
 * at 29, 185 716 at 30). 165 000 resolves to step 27, 170 000 to step 28, and
 * 185 000 to step 30. A target that lands on a step the grid already took is
 * deduped, never doubled.
 */
export const DENSE_TARGETS = Object.freeze([165000, 170000, 185000]);

/** The per-lane cost ceiling, in tokens. */
export const CEILING = 2250000;

/** The output schema this module writes. */
export const SCHEMA = "racoons-sim-stages/1";

const DEFAULT_ARM = "racoons";

/** The exit code each named refusal leaves with. */
const EXIT_CODES = new Map([
  ["stage-no-trigger", 3],
  ["stage-after-compaction", 4],
  ["stages-over-ceiling", 5],
]);

/** A refusal with the code and the exit code the CLI asserts on. */
export class SimStagesRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimStagesRefusal";
    this.code = code;
    this.exitCode = EXIT_CODES.get(code) ?? 2;
  }
}

export function refuse(code, detail) {
  throw new SimStagesRefusal(code, detail);
}

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = text => Buffer.from(text, "utf8");

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--transcript", "string"],
  ["--arm", "string"],
  ["--out", "string"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    transcript: values.transcript ?? null,
    arm: values.arm ?? DEFAULT_ARM,
    out: values.out ?? null,
  };
  if (opts.transcript === null) refuse("usage", "--transcript is required");
  if (opts.arm.length === 0) refuse("usage", "--arm needs a name");
  return opts;
}

/**
 * The transcript's `tool/result` appends, in seq order: the landed body, its
 * step and its byte count. `readTranscript` and `textOf` are the record
 * adapter's own reader, not a second parser. A path is read; rows are taken as
 * given, so a caller that already parsed the file need not re-read it.
 */
export function readAppends(transcript) {
  const rows = typeof transcript === "string" ? readTranscript(transcript) : transcript;
  if (!Array.isArray(rows)) {
    refuse("usage", "readAppends takes a transcript path or the rows read from one");
  }
  const appends = [];
  for (const row of rows) {
    if (row?.type !== "tool/result" || row.surfaceOp !== "append") continue;
    if (!Number.isSafeInteger(row.seq)) {
      refuse("usage", `a tool/result append carries seq ${String(row.seq)}`);
    }
    const step = row.data?.step;
    if (!Number.isSafeInteger(step)) {
      refuse("usage", `the append at seq ${row.seq} carries step ${String(step)}`);
    }
    const text = textOf(row);
    appends.push({ seq: row.seq, step, bytes: utf8(text).length, text });
  }
  appends.sort((left, right) => left.seq - right.seq);
  return appends;
}

/**
 * The newest over-floor append at or before `step`: max seq with that step and
 * at least the floor in bytes. `null` when no over-floor result has landed yet,
 * which is zero fed bytes, never a guess.
 */
export function triggerOf(appends, step) {
  if (!Number.isSafeInteger(step)) {
    refuse("usage", `a stage step is an integer, got ${String(step)}`);
  }
  let trigger = null;
  for (const append of appends) {
    if (append.step <= step && append.bytes >= FLOOR_BYTES) trigger = append.seq;
  }
  return trigger;
}

/**
 * The fed bytes at one trigger: every append with seq <= it, sub-floor results
 * included. A `null` trigger is zero.
 */
export function fedOf(appends, seq) {
  if (seq === null) return 0;
  let bytes = 0;
  for (const append of appends) {
    if (append.seq <= seq) bytes += append.bytes;
  }
  return bytes;
}

/** Every append as one tool moment the shipped renderer accepts. */
function appendsAsMoments(appends, lane) {
  return appends.map(append => ({
    id: `append:${append.seq}`,
    lane,
    seq: append.seq,
    step: append.step,
    original: { text: append.text },
  }));
}

/**
 * The rendered lane's joined prefix at one trigger: bytes and hash. The cut is
 * the trigger's own seq, never `landedStep <= step`; the join is the product's
 * `renderHistory`, so a separator byte count is never re-derived here.
 */
function prefixAt(rendered, triggerSeq) {
  const turns = rendered.rows
    .filter(row => Number.isSafeInteger(row.seq) && row.seq <= triggerSeq)
    .map(row => ({ role: "tool", text: row.before }));
  const text = renderHistory(turns);
  return {
    prefixBytes: utf8(text).length,
    prefixSha256: sha256Hex(utf8(text)),
    turns: turns.length,
  };
}

/**
 * The stage table. Each target walks the candidate steps — the steps an
 * over-floor append lands on, ascending — and keeps the first whose
 * `tau(fed)` reaches it; a target no step reaches is `stage-no-trigger`. Two
 * targets that land on one step are one stage (the smaller target labels it).
 *
 * `cutSeq` is the record's `compaction/start` seq: a trigger past it would feed
 * a summarised surface into the ramp, so that stage is
 * `stage-after-compaction`. `ceiling` defaults to the plan's per-lane 2 250 000;
 * the sum of `tau(prefix)` over every stage is the projection, and over the
 * ceiling refuses the whole table (`stages-over-ceiling`).
 */
export function stageTable({
  appends,
  targets = GRID_TARGETS,
  dense = DENSE_TARGETS,
  cutSeq = null,
  ceiling = CEILING,
  lane = null,
}) {
  if (!Array.isArray(appends)) {
    refuse("usage", "stageTable needs the transcript's appends");
  }
  const wanted = [...new Set([...targets, ...dense])].sort((left, right) => left - right);
  for (const target of wanted) {
    if (!Number.isSafeInteger(target) || target <= 0) {
      refuse("usage", `a stage target is a positive integer token count, got ${String(target)}`);
    }
  }
  if (appends.length === 0) {
    refuse("stage-no-trigger", "the transcript holds no tool/result append, so no stage has a"
      + " trigger and no target can be reached");
  }
  const steps = [...new Set(appends
    .filter(append => append.bytes >= FLOOR_BYTES)
    .map(append => append.step))].sort((left, right) => left - right);
  const rendered = renderLane({ lane, moments: appendsAsMoments(appends, lane), decisions: [] });
  const stages = [];
  const taken = new Set();
  for (const target of wanted) {
    let landed = null;
    let reached = 0;
    for (const step of steps) {
      const triggerSeq = triggerOf(appends, step);
      const fedBytes = fedOf(appends, triggerSeq);
      reached = tokenizeBytes(fedBytes);
      if (reached < target) continue;
      landed = { step, triggerSeq, fedBytes };
      break;
    }
    if (landed === null) {
      refuse("stage-no-trigger",
        `no step's tau(fed) reaches the ${target}-token target; the last step feeds`
        + ` ${reached} tokens`);
    }
    if (cutSeq !== null && landed.triggerSeq > cutSeq) {
      refuse("stage-after-compaction",
        `target ${target} lands at step ${landed.step}, trigger seq ${landed.triggerSeq}, past`
        + ` the compaction/start seq ${cutSeq}; only the first ramp is sampled`);
    }
    if (taken.has(landed.step)) continue;
    taken.add(landed.step);
    stages.push({ target, ...landed, ...prefixAt(rendered, landed.triggerSeq) });
  }
  const projection = stages.reduce((sum, stage) => sum + tokenizeBytes(stage.prefixBytes), 0);
  if (projection > ceiling) {
    refuse("stages-over-ceiling",
      `the ${stages.length} stages project ${projection} tokens, over the ${ceiling} ceiling`);
  }
  return {
    schema: SCHEMA,
    stages: stages.map(({ target, step, triggerSeq, fedBytes, prefixBytes, prefixSha256 }) => ({
      target, step, triggerSeq, fedBytes, prefixBytes, prefixSha256,
    })),
    projection,
    ceiling,
  };
}

/** The human table: one row per stage, the projection and the ceiling. */
export function tableOf(table) {
  const lines = [
    `racoons-sim-stages   ${table.stages.length} stages`
      + `   projection ${table.projection} / ceiling ${table.ceiling}`,
    "   target    step  trigger      fed B     tau(fed)   prefix B  sha256",
  ];
  for (const stage of table.stages) {
    lines.push(`  ${String(stage.target).padStart(6)}  ${String(stage.step).padStart(5)}`
      + `  ${String(stage.triggerSeq).padStart(7)}  ${String(stage.fedBytes).padStart(10)}`
      + `  ${String(tokenizeBytes(stage.fedBytes)).padStart(9)}  ${String(stage.prefixBytes).padStart(10)}`
      + `  ${stage.prefixSha256.slice(0, 16)}`);
  }
  return lines.join("\n");
}

/** The record's own first compaction seam, or `null` when it has none. */
export function compactionSeqOf(rows) {
  const start = rows.find(row => row?.type === "compaction/start" && Number.isSafeInteger(row.seq));
  return start === undefined ? null : start.seq;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = path.resolve(process.cwd(), opts.transcript);
  const rows = readTranscript(file);
  const table = stageTable({
    appends: readAppends(rows),
    cutSeq: compactionSeqOf(rows),
    lane: opts.arm,
  });
  if (opts.out !== null) {
    const target = path.resolve(process.cwd(), opts.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${JSON.stringify(table, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }
  process.stdout.write(`${tableOf(table)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(Number.isSafeInteger(error?.exitCode) ? error.exitCode : 2);
  }
}
