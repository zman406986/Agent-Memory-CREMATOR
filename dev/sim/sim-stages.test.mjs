#!/usr/bin/env node
/**
 * ISSUE-093 item 3 — the stage scheduler's gate: the fifteen rows, the sub-floor
 * trap, the separator arithmetic and the three named refusals.
 *
 * Run: `node --test dev/sim/sim-stages.test.mjs`
 *
 * The fixture is GENERATED here, never read from `scratchpad/` (disposable by
 * law). It carries the reference record's own shape: one over-floor append at
 * each of the fifteen stage steps, its trigger `seq` exactly the plan's, and
 * enough sub-floor appends between them that the turn count at every trigger is
 * the record's. Fed bytes and trigger seqs are the plan's
 * (`docs/plans/2026-10-29-prompt-forget-lanes/plan.md` §2), so a rule that
 * filters at the floor, reads billed size, or cuts by `landedStep` produces a
 * different table and fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEILING, DENSE_TARGETS, FLOOR_BYTES, GRID_TARGETS, SCHEMA, SimStagesRefusal, compactionSeqOf,
  fedOf, readAppends, stageTable, triggerOf,
} from "./sim-stages.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = path.join(HERE, "sim-stages.mjs");

/** The plan's table, column by column: step, trigger seq, fed bytes. */
const PLAN = [
  { step: 3, triggerSeq: 38, fedBytes: 101130 },
  { step: 6, triggerSeq: 59, fedBytes: 168724 },
  { step: 14, triggerSeq: 128, fedBytes: 267604 },
  { step: 16, triggerSeq: 150, fedBytes: 325321 },
  { step: 19, triggerSeq: 179, fedBytes: 431583 },
  { step: 21, triggerSeq: 201, fedBytes: 516899 },
  { step: 23, triggerSeq: 219, fedBytes: 571413 },
  { step: 26, triggerSeq: 250, fedBytes: 655740 },
  { step: 27, triggerSeq: 259, fedBytes: 678835 },
  { step: 28, triggerSeq: 266, fedBytes: 699312 },
  { step: 29, triggerSeq: 275, fedBytes: 721557 },
  { step: 30, triggerSeq: 284, fedBytes: 742863 },
  { step: 34, triggerSeq: 314, fedBytes: 816338 },
  { step: 43, triggerSeq: 377, fedBytes: 896480 },
  { step: 56, triggerSeq: 461, fedBytes: 973803 },
];

/** The grid targets, and the plan's step each one lands on. */
const PLAN_GRID = [
  { target: 20000, step: 3 }, { target: 40000, step: 6 }, { target: 60000, step: 14 },
  { target: 80000, step: 16 }, { target: 100000, step: 19 }, { target: 120000, step: 21 },
  { target: 140000, step: 23 }, { target: 160000, step: 26 }, { target: 180000, step: 29 },
  { target: 200000, step: 34 }, { target: 220000, step: 43 }, { target: 240000, step: 56 },
];

/** The record's own turn count at each stage's trigger (`landed` appends fed). */
const PLAN_TURNS = [5, 9, 29, 37, 47, 55, 61, 72, 75, 77, 80, 83, 89, 98, 113];

/** The plan's own separator-free projection, in tokens. */
const PLAN_PROJECTION_RAW = 2141905;
/** The measured projection once the joined prefix's separators are counted. */
const PLAN_PROJECTION = 2142363;

/** The first stage's sub-floor budget: 101 130 − 99 926, the brief's trap. */
const STAGE1_SUBFLOOR = 1204;

/** One `tool/result` append row, its body exactly `bytes` UTF-8 bytes. */
function appendRow(seq, step, bytes) {
  return {
    type: "tool/result",
    seq,
    data: {
      step,
      message: { role: "tool", content: [{ type: "text", text: "x".repeat(bytes) }] },
    },
    surfaceOp: "append",
  };
}

/**
 * The synthetic transcript: fifteen stage appends at the plan's trigger seqs,
 * sub-floor appends filling the record's own turn counts, and a
 * `compaction/start` past the last trigger.
 *
 * The sub-floor bytes are subtracted from the stage append that follows them,
 * so every trigger feeds exactly the plan's figure — which is the point: a
 * reader that filters fed at the floor loses them.
 */
function syntheticTranscript({ compactionSeq = 463 } = {}) {
  const rows = [{ type: "session", version: 4, id: "session-sim-stages" }];
  let seq = 0;
  let fed = 0;
  let turns = 0;
  const push = row => { rows.push(row); seq = row.seq; };
  const fillTo = (target, step) => {
    while (seq < target) {
      seq += 1;
      rows.push({ type: "step/start", seq, data: { step } });
    }
  };
  for (const [index, stage] of PLAN.entries()) {
    const want = PLAN_TURNS[index] - turns;
    assert.ok(want >= 1, `stage ${stage.step}: the plan's turn count must grow`);
    const subCount = want - 1;
    // The first stage reproduces the brief's exact trap (1 204 B of sub-floor
    // results before the trigger, so a floor filter reads 99 926 B).
    const subTotal = subCount === 0 ? 0 : Math.min(subCount * 400,
      index === 0 ? STAGE1_SUBFLOOR : Number.MAX_SAFE_INTEGER);
    const subSizes = [];
    if (subCount > 0) {
      for (let at = 0; at < subCount; at += 1) subSizes.push(Math.floor(subTotal / subCount));
      subSizes[0] += subTotal - subSizes.reduce((sum, size) => sum + size, 0);
    }
    assert.equal(subSizes.length, subCount);
    fillTo(stage.triggerSeq - want, stage.step);
    for (const size of subSizes) {
      seq += 1;
      rows.push(appendRow(seq, stage.step, size));
    }
    const overFloor = stage.fedBytes - fed - subTotal;
    assert.ok(overFloor >= FLOOR_BYTES, `stage ${stage.step}: its over-floor result is ${overFloor}`);
    seq += 1;
    rows.push(appendRow(seq, stage.step, overFloor));
    assert.equal(seq, stage.triggerSeq, `stage ${stage.step}: the trigger seq`);
    fed = stage.fedBytes;
    turns = PLAN_TURNS[index];
  }
  fillTo(compactionSeq - 1, PLAN[PLAN.length - 1].step);
  seq += 1;
  rows.push({ type: "compaction/start", seq, data: { compactionId: "c1", turn: 1 } });
  assert.equal(seq, compactionSeq);
  return rows;
}

const bytes = text => Buffer.byteLength(text, "utf8");
const joined = (fedBytes, turns) => fedBytes + 2 * (turns - 1);

/** A temp file holding one transcript; the caller removes the directory. */
function writeTranscript(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "racoons-stages-"));
  const file = path.join(dir, "session.v4.jsonl");
  writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  return { dir, file };
}

const isRefusal = code => error =>
  error instanceof SimStagesRefusal && error.code === code;

test("readAppends reads tool/result appends in seq order and keeps sub-floor rows", () => {
  const rows = syntheticTranscript();
  const appends = readAppends(rows);
  assert.equal(appends.length, PLAN_TURNS[PLAN_TURNS.length - 1]);
  assert.deepEqual(appends.map(append => append.seq),
    [...appends.map(append => append.seq)].sort((left, right) => left - right),
    "seq order");
  assert.equal(appends[appends.length - 1].seq, 461);
  assert.equal(appends.reduce((sum, append) => sum + append.bytes, 0), 973803);
  assert.equal(FLOOR_BYTES, 512, "ADR-0051: the sim's default floor is 512 B");
  assert.ok(appends.some(append => append.bytes < FLOOR_BYTES), "sub-floor rows are kept");
  assert.equal(appends.filter(append => append.bytes >= FLOOR_BYTES).length, PLAN.length);
});

test("triggerOf picks the newest over-floor append at or before the step", () => {
  const appends = readAppends(syntheticTranscript());
  assert.equal(triggerOf(appends, 2), null, "nothing over-floor has landed");
  assert.equal(triggerOf(appends, 3), 38);
  assert.equal(triggerOf(appends, 5), 38, "a step with no new result repeats the trigger");
  assert.equal(triggerOf(appends, 6), 59);
  assert.equal(triggerOf(appends, 27), 259, "the sub-floor rows at step 27 are no trigger");
  assert.equal(triggerOf(appends, 56), 461);
});

test("fedOf counts the sub-floor results a floor filter drops", () => {
  const appends = readAppends(syntheticTranscript());
  const trigger = triggerOf(appends, 3);
  assert.equal(fedOf(appends, trigger), 101130, "the plan's stage-1 fed bytes");
  const floorFiltered = appends
    .filter(append => append.seq <= trigger && append.bytes >= FLOOR_BYTES)
    .reduce((sum, append) => sum + append.bytes, 0);
  assert.equal(floorFiltered, 99926, "the wrong reading the brief names");
  assert.equal(fedOf(appends, trigger - 1), STAGE1_SUBFLOOR, "the trigger result is excluded");
  assert.equal(fedOf(appends, 45), 101130,
    "fed is cut at the trigger's seq: a later step's sub-floor row is not fed");
  assert.equal(fedOf(appends, null), 0);
});

test("stageTable reproduces the plan's fifteen (step, triggerSeq, fedBytes) rows", () => {
  const table = stageTable({ appends: readAppends(syntheticTranscript()) });
  assert.equal(table.schema, SCHEMA);
  assert.equal(table.stages.length, 15);
  assert.deepEqual(
    table.stages.map(stage => [stage.step, stage.triggerSeq, stage.fedBytes]),
    PLAN.map(stage => [stage.step, stage.triggerSeq, stage.fedBytes]));
  assert.deepEqual(table.stages.map(stage => stage.target),
    [20000, 40000, 60000, 80000, 100000, 120000, 140000, 160000,
      165000, 170000, 180000, 185000, 200000, 220000, 240000]);
  assert.deepEqual(table.stages.map(stage => stage.step),
    PLAN.map(stage => stage.step), "steps ascend with their targets");
});

test("every grid target lands on the plan's step, and 240 000 lands on step 56", () => {
  const table = stageTable({ appends: readAppends(syntheticTranscript()) });
  for (const row of PLAN_GRID) {
    const stage = table.stages.find(entry => entry.target === row.target);
    assert.ok(stage !== undefined, `target ${row.target} produced no stage`);
    assert.equal(stage.step, row.step, `target ${row.target}`);
  }
  const last = table.stages.find(stage => stage.target === 240000);
  assert.deepEqual([last.step, last.triggerSeq, last.fedBytes], [56, 461, 973803]);
  assert.equal(Math.ceil(last.fedBytes / 4), 243451, "tau(fed) at step 56");
});

test("the prefix is the joined fed prefix: every separator byte and its hash", () => {
  const table = stageTable({ appends: readAppends(syntheticTranscript()) });
  for (const [index, stage] of table.stages.entries()) {
    assert.equal(stage.prefixBytes, joined(stage.fedBytes, PLAN_TURNS[index]),
      `target ${stage.target}: fed plus one blank line per pair`);
    assert.match(stage.prefixSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(table.stages.map(stage => stage.prefixSha256)).size, 15,
    "distinct stages are distinct prefixes (non-vacuity)");
  assert.equal(table.projection, PLAN_PROJECTION);
  assert.ok(table.projection > PLAN_PROJECTION_RAW, "separators are counted");
  assert.equal(table.projection,
    table.stages.reduce((sum, stage) => sum + Math.ceil(stage.prefixBytes / 4), 0));
  assert.equal(table.ceiling, CEILING);
  assert.ok(table.projection <= CEILING, "the projection is under the ceiling");
});

test("two targets that land on one step are one stage, labelled by the smaller", () => {
  const appends = readAppends(syntheticTranscript());
  const table = stageTable({ appends, targets: [20000, 21000], dense: [] });
  assert.equal(table.stages.length, 1);
  assert.equal(table.stages[0].target, 20000);
  assert.equal(table.stages[0].step, 3);
});

test("the three refusals are named, distinct and carry their exit codes", () => {
  const appends = readAppends(syntheticTranscript());
  assert.throws(() => stageTable({ appends, targets: [999999], dense: [] }),
    isRefusal("stage-no-trigger"));
  assert.throws(() => stageTable({ appends, targets: [999999], dense: [] }),
    error => error.exitCode === 3);
  assert.throws(() => stageTable({ appends, cutSeq: 460 }),
    isRefusal("stage-after-compaction"));
  assert.throws(() => stageTable({ appends, cutSeq: 460 }),
    error => error.exitCode === 4 && /compaction\/start seq 460/.test(error.message));
  assert.throws(() => stageTable({ appends, ceiling: 1000 }),
    isRefusal("stages-over-ceiling"));
  assert.throws(() => stageTable({ appends, ceiling: 1000 }),
    error => error.exitCode === 5 && /over the 1000 ceiling/.test(error.message));
  assert.equal(CEILING, 2250000);
  assert.deepEqual([...GRID_TARGETS].length, 12);
  assert.deepEqual([...DENSE_TARGETS], [165000, 170000, 185000]);
});

test("the CLI writes the schema, and refuses the compaction seam at exit 4", () => {
  const good = writeTranscript(syntheticTranscript());
  const empty = writeTranscript([
    { type: "session", version: 4, id: "session-thin" },
    appendRow(5, 1, 4000),
  ]);
  try {
    const out = path.join(good.dir, "stages.json");
    const run = spawnSync(process.execPath,
      [CLI, "--transcript", good.file, "--arm", "racoons", "--out", out],
      { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /15 stages/);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.schema, SCHEMA);
    assert.equal(written.stages.length, 15);
    assert.deepEqual(Object.keys(written), ["schema", "stages", "projection", "ceiling"]);
    assert.deepEqual(Object.keys(written.stages[0]),
      ["target", "step", "triggerSeq", "fedBytes", "prefixBytes", "prefixSha256"]);
    assert.equal(written.projection, PLAN_PROJECTION);
    assert.equal(written.ceiling, 2250000);

    // The compaction seam: a `compaction/start` before every trigger.
    const cutRows = [
      { type: "session", version: 4, id: "session-cut" },
      { type: "compaction/start", seq: 1, data: { compactionId: "c1", turn: 1 } },
      appendRow(5, 1, 80000),
    ];
    assert.equal(compactionSeqOf(cutRows), 1);
    const cutFile = writeTranscript(cutRows);
    try {
      const refused = spawnSync(process.execPath,
        [CLI, "--transcript", cutFile.file], { encoding: "utf8" });
      assert.equal(refused.status, 4, refused.stderr);
      assert.match(refused.stderr, /^stage-after-compaction: /m);
    } finally {
      rmSync(cutFile.dir, { recursive: true, force: true });
    }

    // No trigger: a single small result can never feed 20 000 tokens.
    const thin = spawnSync(process.execPath, [CLI, "--transcript", empty.file],
      { encoding: "utf8" });
    assert.equal(thin.status, 3, thin.stderr);
    assert.match(thin.stderr, /^stage-no-trigger: /m);

    // A usage error is exit 2, and an unknown flag is refused by name.
    const usage = spawnSync(process.execPath, [CLI, "--probe", "x"], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown argument --probe/);
  } finally {
    rmSync(good.dir, { recursive: true, force: true });
    rmSync(empty.dir, { recursive: true, force: true });
  }
});
