#!/usr/bin/env node
/**
 * ISSUE-059 T-4 — gate 3's own gate: the live chain green offline on the sim
 * fixture, four perturbations that each redden a named check, a dry pair run
 * that is byte-identical twice, and `--check-repro` on a record directory.
 *
 * Run: `node --test dev/sim/gate3-live-chain.test.mjs`
 *
 * The oracle is the committed synthetic fixture (`dev/bench/fixtures/sim/`,
 * T-2) converted by `live-convert.mjs` into a temporary directory. Nothing here
 * reads `scratchpad/`, opens a socket, reads a clock or exports a key.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntryAnswer } from "@cremator/core";
import {
  CHECK_NAMES, FLIP_NAMES, Gate3Refusal, answerStepOf, buildRecord, chainRun, convertFixture,
  coverageOf, firstByteDifference, indexTranscript, markerDroppedBytes, markerLinesOf, newChecker,
  readTranscript, reasoningOf, reproRun, resolveAttribution, resolveNodeId, runChecks, textOf,
} from "./gate3-live-chain.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "gate3-live-chain.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");

/** One fixture conversion, shared by every in-process test. */
let fixture = null;
before(() => {
  fixture = convertFixture();
});
after(() => {
  if (fixture !== null) {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const freshDir = () => mkdtempSync(path.join(tmpdir(), "racoons-gate3-test-"));

/** The chain over the shared fixture record, from the CLI's own path. */
const chain = flip => chainRun({
  recordDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons", nodeIdForm: "auto", flip,
});

const failingChecks = report => [...new Set(report.failures.map(failure => failure.check))].sort();

/** The fixture's own shaped bodies and at-rest receipt, keyed by landed seq. */
function transcriptBodies() {
  const shaped = new Map();
  const burns = new Map();
  for (const row of readTranscript(TRANSCRIPT)) {
    if (row.type !== "tool/result" || typeof row.surfaceOp !== "object") continue;
    if (row.surfaceOp.startSeq !== row.surfaceOp.endSeq) continue;
    const body = textOf(row);
    if (body.startsWith("[not retained]")) burns.set(row.surfaceOp.startSeq, body);
    else if (body.includes("[racoons] kept")) shaped.set(row.surfaceOp.startSeq, body);
  }
  return { shaped, burns };
}

/**
 * A transcript copy with ONE letter of a shaped body's kept text moved. The
 * marker, the note and the length stay, so the row still parses as a shaped row
 * and only its bytes differ: a re-render reddens `repro-body` on that seq.
 */
function tamperedTranscript(file) {
  const lines = readFileSync(TRANSCRIPT, "utf8").split("\n").filter(line => line.trim().length > 0);
  let moved = null;
  const text = lines.map(line => {
    const row = JSON.parse(line);
    if (moved !== null || row.type !== "tool/result"
      || typeof row.surfaceOp !== "object" || row.surfaceOp.startSeq !== row.surfaceOp.endSeq) {
      return line;
    }
    const body = textOf(row);
    if (!body.includes("[racoons] kept")) return line;
    // The first character of the first kept line: the byte after the marker's
    // own newline.
    const at = body.indexOf("\n", body.indexOf("[racoons] kept")) + 1;
    const next = `${body.slice(0, at)}${body[at] === "a" ? "b" : "a"}${body.slice(at + 1)}`;
    // The row's own seq is the replace's; the gate names the landed seq it
    // shadows, which is what `surfaceOp.startSeq` holds.
    moved = row.surfaceOp.startSeq;
    row.data.message.content = [{ type: "text", text: next }];
    return JSON.stringify(row);
  });
  assert.ok(moved !== null, "the fixture holds no shaped row to tamper with");
  writeFileSync(file, `${text.join("\n")}\n`);
  return moved;
}

/**
 * A hand-written record with no shaped row: one landed result, no decision and
 * no transcript shaped body. The `repro-empty` / `lane-equality` red paths.
 */
function emptyRecord(root) {
  const dir = path.join(root, "record");
  mkdirSync(dir, { recursive: true });
  const body = `<path>C:\\sim\\arm\\solo.txt</path>\n${"solo line ................................................\n"
    .repeat(30)}`;
  const transcript = path.join(root, "solo.session.v4.jsonl");
  const rows = [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "tool/result", seq: 2, time: 3, surfaceOp: "append",
      data: { turn: 1, step: 1, message: { role: "tool",
        source: { kind: "tool", callId: "call_solo" }, toolCallId: "call_solo",
        content: [{ type: "text", text: body }] } } },
    { type: "step/end", seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 4, time: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  const bytes = Buffer.byteLength(body);
  assert.ok(bytes >= 1280, `the synthetic body is ${bytes} bytes, under the floor`);
  const unit = {
    arm: "racoons", tier: "T3", step: 1, callId: "call_solo", seq: 2,
    spanStart: null, spanEnd: null, unitId: `unit:sha256:${"b".repeat(64)}`,
    rawSha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
    normKey: "d".repeat(64), tool: "read", bytes,
    path: "C:\\sim\\arm\\solo.txt", substitutions: { arm: 0, tmp: 0 },
    composition: "ask-failed-fail-open", keptBytes: null, gaps: 0, markerCount: 0,
    markerBytes: 0, summaryBytes: 0, framingBytes: null, droppedBytes: 0, ranges: null,
    recallId: null, rf: 0, used: false, usedBy: null, censoredClass: "refused-ask",
    keepallVia: null, atRest: null,
  };
  writeFileSync(path.join(dir, "live-units.jsonl"), `${JSON.stringify(unit)}\n`);
  writeFileSync(path.join(dir, "live-census.json"), `${JSON.stringify({
    floor: 1280, arms: { racoons: { sessionId: "session-solo", appends: 1, steps: 1 } },
  }, null, 2)}\n`);
  writeFileSync(path.join(dir, "live-join.json"), `${JSON.stringify({
    floor: 1280, tiers: { T1: 0, T2: 0, T3: 1 }, pairs: [], endedBy: { racoons: "complete" },
  }, null, 2)}\n`);
  return { dir, transcript };
}

// ---- the answer step: stated, derived, or refused by name -----------------

/** True for a message append the product's own grammar reads as an answer. */
function isAnswerRow(row) {
  if ((row.type !== "assistant/message" && row.type !== "user/message")
    || row.surfaceOp !== "append") return false;
  try {
    parseEntryAnswer(textOf(row));
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixture's rows in the shape ISSUE-074's scheme A writes them: every row
 * that parses as an answer is stored as a `user/message` with NO step and no
 * role/model source. Built here, in memory, so no second fixture is committed.
 * The product's own grammar decides which rows are answers — the same rule the
 * gate reads them by.
 */
function schemeARows(rows = readTranscript(TRANSCRIPT)) {
  return rows.map(row => (isAnswerRow(row)
    ? {
      ...row,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: textOf(row) }] },
    }
    : row));
}

/** The seqs of the answer rows a scheme-A transcript leaves step-less. */
const schemeAAnswerSeqs = rows => rows.filter(isAnswerRow).map(row => row.seq);

/** A scheme-A transcript written to a fresh file, plus its directory. */
function writeSchemeATranscript(root, rows, name = "scheme-a.session.v4.jsonl") {
  const file = path.join(root, name);
  writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

test("a scheme-A transcript derives every answer's step and runs to a green verdict", () => {
  const root = freshDir();
  try {
    const rows = schemeARows();
    const answerSeqs = schemeAAnswerSeqs(rows);
    assert.equal(answerSeqs.length, 5);
    const file = writeSchemeATranscript(root, rows);
    // No ANSWER row states a step: the row type is `user/message` and its data
    // carries no step at all. (The ask prompt rows keep the step they always
    // had; only the answer rows lost it.)
    for (const row of readTranscript(file)) {
      if (!answerSeqs.includes(row.seq)) continue;
      assert.equal(row.type, "user/message");
      assert.equal(
        Object.hasOwn(row.data, "step"), false,
        `seq ${row.seq} is a scheme-A answer and still states a step`);
    }
    const { report, lane } = chainRun({
      recordDir: fixture.out, transcriptFile: file, arm: "racoons", nodeIdForm: "auto",
    });
    assert.equal(report.verdict, "GREEN", JSON.stringify(report.failures, null, 2));
    assert.equal(report.answerStepsDerived, 5, "every one of the five answers was derived");
    assert.equal(report.counts.decisions, 5);
    // The derived steps obey the stated rule, answer by answer: the first
    // `step/start` after the answer row. (The fixture's answers sit inside the
    // step that opens before them, so this is the step after the one the
    // pre-ISSUE-074 fixture stated — the run is green either way, because the
    // gate recomputes every prefix and every epsilon from the steps it derived.)
    const fileRows = readTranscript(file);
    const expected = [];
    for (const [index, row] of fileRows.entries()) {
      if (!isAnswerRow(row)) continue;
      const next = fileRows.find((later, at) => at > index && later.type === "step/start");
      expected.push(next === undefined ? null : next.data.step);
    }
    assert.deepEqual(expected, [3, 5, 7, 9, null],
      "the fixture's answers are not followed by the expected step/start rows");
    const decisionSteps = lane.rows
      .filter(row => row.decisionStep !== null).map(row => row.decisionStep);
    assert.deepEqual(decisionSteps, [3, 5, 7, 9, 14]);
    // The shaped bodies are the same bytes as the run with stated steps: only
    // the swap step moved.
    const stated = chain(null);
    assert.deepEqual(
      lane.rows.map(row => row.afterSha256),
      stated.lane.rows.map(row => row.afterSha256),
      "a derived answer moved a body");
    assert.equal(report.counts.shaped, stated.report.counts.shaped);
    assert.equal(report.counts.reproduced, stated.report.counts.reproduced);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the derivation is deterministic: the next step/start after the answer, twice", () => {
  const root = freshDir();
  try {
    const file = writeSchemeATranscript(root, schemeARows());
    const rows = readTranscript(file);
    const first = indexTranscript(rows);
    const second = indexTranscript(readTranscript(file));
    const steps = index => index.exchanges
      .filter(exchange => exchange.answer !== null)
      .map(exchange => answerStepOf({
        step: rows[exchange.answer.rowIndex].data?.step ?? null,
        seq: exchange.answer.seq,
        rowIndex: exchange.answer.rowIndex,
        landedSeq: exchange.target,
      }, index));
    const derived = steps(first);
    assert.deepEqual(derived, steps(second), "the same rows derived different steps");
    // Rule 1 for every answer but the last: the first `step/start` after its
    // own row. The last answer has none after it, so rule 2 names it.
    const ordered = first.exchanges.filter(exchange => exchange.answer !== null)
      .sort((left, right) => left.answer.rowIndex - right.answer.rowIndex);
    for (const exchange of ordered) {
      const entry = {
        step: rows[exchange.answer.rowIndex].data?.step ?? null,
        seq: exchange.answer.seq,
        rowIndex: exchange.answer.rowIndex,
        landedSeq: exchange.target,
      };
      const next = rows.findIndex((row, index) =>
        index > exchange.answer.rowIndex && row.type === "step/start");
      if (next >= 0) {
        assert.equal(answerStepOf(entry, first), rows[next].data.step,
          `seq ${entry.seq}: not the next step/start's step`);
      } else {
        assert.equal(answerStepOf(entry, first), first.landedSteps.get(entry.landedSeq) + 1,
          `seq ${entry.seq}: no step/start follows it, so its result's step plus one must`);
      }
    }
    // A second chain run over the same file prints the same report.
    const runOnce = () => chainRun({
      recordDir: fixture.out, transcriptFile: file, arm: "racoons", nodeIdForm: "auto",
    }).report;
    assert.equal(JSON.stringify(runOnce()), JSON.stringify(runOnce()));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("with no step/start after the answer, the step is its result's step plus one", () => {
  const root = freshDir();
  try {
    // Cut the transcript after the LAST answer: no step/start follows it, so
    // only the fallback can name its step. The last answer decides seq 67,
    // which landed at step 13.
    const rows = schemeARows();
    const lastAnswer = rows.reduce((found, row, index) => (isAnswerRow(row) ? index : found), -1);
    assert.ok(lastAnswer > 0);
    const trimmed = rows.slice(0, lastAnswer + 1);
    const file = writeSchemeATranscript(root, trimmed);
    const index = indexTranscript(readTranscript(file));
    const last = index.exchanges[index.exchanges.length - 1];
    assert.equal(last.target, 67, "the last exchange did not join the result at seq 67");
    assert.equal(index.landedSteps.get(67), 13);
    assert.equal(answerStepOf({
      step: rows[last.answer.rowIndex].data?.step ?? null,
      seq: last.answer.seq,
      rowIndex: last.answer.rowIndex,
      landedSeq: 67,
    }, index), 14, "the fallback is not the result's step plus one");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("both derivations impossible refuses by name, never a crash", () => {
  const root = freshDir();
  try {
    // Strip the last landed result's own step AND stop the file at the answer:
    // no step/start follows it and the result states none.
    const rows = schemeARows();
    for (const row of rows) {
      if (row.type === "tool/result" && row.surfaceOp === "append" && row.seq === 67) {
        delete row.data.step;
      }
    }
    const file = writeSchemeATranscript(root, rows);
    const runTheChain = () => chainRun({
      recordDir: fixture.out, transcriptFile: file, arm: "racoons", nodeIdForm: "auto",
    });
    // The answer that cannot derive a step is the last one: seq 71, which
    // decides the result at seq 67.
    assert.throws(runTheChain, error => error instanceof Gate3Refusal
      && error.code === "gate3-answer-step-absent"
      && /seq 71/.test(error.message));
    const cli = run(["--units", fixture.out, "--transcript", file]);
    assert.equal(cli.status, 2, cli.stdout);
    assert.match(cli.stderr, /^gate3-answer-step-absent: seq 71: /);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a STATED but malformed step is still refused by the same name", () => {
  const rows = readTranscript(TRANSCRIPT);
  // The fixture's first answer (seq 9, step 2) states a non-integer step.
  const broken = rows.map(row => (row.seq === 9 ? { ...row, data: { ...row.data, step: 1.5 } } : row));
  const index = indexTranscript(broken);
  const exchange = index.exchanges.find(entry => entry.answer?.seq === 9);
  assert.ok(exchange !== undefined);
  assert.throws(() => answerStepOf({
    step: broken.find(row => row.seq === 9).data.step,
    seq: 9,
    rowIndex: exchange.answer.rowIndex,
    landedSeq: exchange.target,
  }, index),
  error => error instanceof Gate3Refusal
    && error.code === "gate3-answer-step-absent"
    && /states step 1\.5/.test(error.message));
});

// ---- green on the sim fixture, through the whole chain --------------------

test("the chain is green on the sim fixture, every named check exercised", () => {
  const { report } = chain(null);
  assert.equal(report.verdict, "GREEN", JSON.stringify(report.failures, null, 2));
  assert.deepEqual(report.failures, []);
  // The record stage fed the render stage: 7 moments, 5 decisions, 4 shaped.
  assert.deepEqual(report.counts, {
    moments: 7, decisions: 5, shaped: 4, machinery: 1, steps: 13, epochs: 4, reproduced: 5,
  });
  // Every check names itself and ran at least once; none is a silent pass.
  assert.deepEqual(report.checks.map(entry => entry.name), CHECK_NAMES.filter(name =>
    name !== "non-vacuity"), "a named check did not run");
  for (const entry of report.checks) {
    assert.ok(entry.checked > 0, `${entry.name} was never checked`);
    assert.equal(entry.failed, 0, `${entry.name} failed ${entry.failed} times`);
  }
  // The node-id form was RESOLVED against the transcript, not assumed: the
  // fixture's builder names its source `sim-result-<file>`.
  assert.equal(report.nodeIdForm, "sim-result");
  assert.equal(report.nodeIdResolved, true);
  // `dsh` reproduces at most the burn receipt (a receipt names no source id),
  // `sim-result` every body; the resolved form is the one printed.
  assert.deepEqual(report.nodeIdAttempts, [
    { form: "dsh", reproduced: 1, total: 5 },
    { form: "sim-result", reproduced: 5, total: 5 },
  ]);
  assert.ok(report.assertions >= 90, `only ${report.assertions} assertions ran`);
});

test("the CLI exits 0 green and prints one verdict line", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}moments {6}7: 4 shaped, 1 at-rest receipt, 5 decision\(s\)$/m);
  assert.match(result.stdout,
    /^ {2}coverage {5}4 matched, 1 censored by name, 0 refused by name of 5 body\(ies\)$/m);
  assert.match(result.stdout, /^gate3-live-chain: GREEN — 13 checks, \d+ assertions, 5 bodies/m);
  assert.doesNotMatch(result.stdout, /^FAIL /m);
});

test("every shaped body and the receipt reproduces the transcript byte for byte", () => {
  const { lane } = chain(null);
  const bodies = transcriptBodies();
  assert.equal(bodies.shaped.size, 4);
  assert.equal(bodies.burns.size, 1);
  for (const row of lane.rows) {
    if (row.shaped) {
      assert.equal(row.after, bodies.shaped.get(row.seq), `seq ${row.seq} does not reproduce`);
      assert.equal(row.recallIdMatchesRecord, true, `seq ${row.seq} names another recall id`);
    }
    if (row.machinery !== null) {
      assert.equal(row.after, bodies.burns.get(row.seq), "the receipt does not reproduce");
      assert.equal(row.swapStep, 10, "the receipt swaps at the burn's own step");
    }
  }
});

test("a marker owns its line, states its dropped bytes, and no kept text shares it", () => {
  const { lane } = chain(null);
  let markers = 0;
  for (const row of lane.rows.filter(entry => entry.shaped)) {
    const lines = markerLinesOf(row.after);
    assert.equal(lines.length, row.gaps, `seq ${row.seq}: marker count`);
    for (const line of lines) {
      assert.match(line, /^\[racoons\] kept .* necromancy recall:sha256:[0-9a-f]{64}$/);
      // A marker is one line: the kept text after it starts on the next line.
      assert.equal(Buffer.byteLength(`${line}\n`), row.terms.markerBytes);
      const dropped = markerDroppedBytes(line);
      if (dropped !== null) assert.equal(dropped, row.terms.dropped);
      markers += 1;
    }
  }
  assert.equal(markers, 6, "the fixture's four shaped rows carry six marker lines");
});

test("OFF and K are byte-equal until the first decision, and differ after it", () => {
  const { lane, off } = chain(null);
  const swaps = lane.rows.filter(row => row.swapStep !== null).map(row => row.swapStep);
  const first = Math.min(...swaps);
  assert.equal(first, 2, "the fixture's first swap is the lead-gap decision at step 2");
  assert.notEqual(lane.final.prefixSha256, off.final.prefixSha256);
  // OFF carries the landed bodies to the end; K carries the shaped ones. The
  // at-rest receipt is no decision, so it moves in both lanes.
  for (const row of off.rows.filter(entry => entry.machinery === null)) {
    assert.equal(row.after, row.before, `seq ${row.seq}`);
  }
});

// ---- the four flips, each reddening a named check -------------------------

const FLIP_EXPECTATIONS = {
  kept: ["landed-body", "self-reproduction", "recall-id"],
  summary: ["self-reproduction", "summary-prefix"],
  early: ["step-visibility"],
  late: ["step-visibility"],
};

for (const flip of FLIP_NAMES) {
  test(`--flip ${flip} reddens its named check and no other flip's`, () => {
    const { report } = chain(flip);
    assert.equal(report.verdict, "RED");
    assert.equal(report.flip.flip, flip);
    const named = failingChecks(report);
    for (const check of FLIP_EXPECTATIONS[flip]) {
      assert.ok(named.includes(check), `--flip ${flip} left ${check} green (red: ${named.join(", ")})`);
    }
    assert.equal(named.includes("non-vacuity"), false,
      `--flip ${flip} reddened nothing named: ${JSON.stringify(report.failures)}`);
    // Every failure prints its check and a detail, never a bare boolean.
    for (const failure of report.failures) {
      assert.equal(typeof failure.detail, "string");
      assert.ok(failure.detail.length > 0);
    }
  });
}

test("the CLI exits 1 with the named checks on a flipped run", () => {
  const result = run(["--flip", "early", "--quiet"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^gate3-live-chain: RED — step-visibility×1$/m);
  const kept = run(["--flip", "kept", "--quiet"]);
  assert.equal(kept.status, 1);
  assert.match(kept.stdout, /^gate3-live-chain: RED — .*self-reproduction×1/m);
});

// ---- determinism: a dry pair run twice into fresh dirs -------------------

test("a dry pair run written twice into fresh dirs is byte-identical", () => {
  const first = freshDir();
  const second = freshDir();
  try {
    // The same converted record and transcript read twice; each run writes the
    // whole pair and the report into its own fresh directory.
    const runInto = dir => run(["--units", fixture.out, "--transcript", TRANSCRIPT,
      "--out", dir, "--quiet"]);
    const one = runInto(first);
    const two = runInto(second);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(two.status, 0, two.stderr);
    assert.equal(one.stdout, two.stdout, "the two runs printed different verdicts");
    for (const name of ["lane-off.json", "lane-k.json", "gate3-report.json"]) {
      const left = readFileSync(path.join(first, name));
      const right = readFileSync(path.join(second, name));
      assert.deepEqual(left, right, `${name} differs between the two runs`);
      assert.equal(left.toString("utf8").includes("\r"), false, `${name} carries CRLF`);
    }
    // The written pair is the chain's own output, not a second renderer's.
    const { lane, off } = chain(null);
    assert.deepEqual(readJson(path.join(first, "lane-k.json")).final, lane.final);
    assert.deepEqual(readJson(path.join(first, "lane-off.json")).final, off.final);
    assert.deepEqual(readJson(path.join(first, "gate3-report.json")).final, lane.final);
  } finally {
    rmSync(first, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the same chain reads the same record twice into identical JSON", () => {
  assert.equal(JSON.stringify(chain(null).report), JSON.stringify(chain(null).report));
});

// ---- --check-repro: the mode run B lands on -------------------------------

test("--check-repro is green on the sim fixture: every shaped body reproduces", () => {
  const result = run(["--check-repro", "--units", fixture.out, "--transcript", TRANSCRIPT]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^gate3-live-chain: GREEN — 5 shaped body\(ies\) reproduced/m);
  const { report } = reproRun({ recordDir: fixture.out, transcriptFile: TRANSCRIPT });
  assert.equal(report.verdict, "GREEN");
  assert.equal(report.shaped, 5);
  assert.deepEqual(report.checks, [{ name: "repro-body", checked: 5, failed: 0 }]);
});

test("--check-repro reddens repro-body by name when one shaped byte differs", () => {
  const root = freshDir();
  try {
    const tampered = path.join(root, "tampered.session.v4.jsonl");
    const seq = tamperedTranscript(tampered);
    const result = run(["--check-repro", "--units", fixture.out, "--transcript", tampered]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^FAIL repro-body seq \d+: the re-rendered body is not the/m);
    assert.match(result.stdout, /^gate3-live-chain: RED — repro-body×1$/m);
    const { report } = reproRun({ recordDir: fixture.out, transcriptFile: tampered });
    assert.ok(failingChecks(report).includes("repro-body"));
    const bodyFailures = report.failures.filter(failure => failure.check === "repro-body");
    assert.equal(bodyFailures.length, 1);
    assert.match(bodyFailures[0].detail, new RegExp(`seq ${seq}:`));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("--check-repro refuses to call an absent oracle a pass", () => {
  const root = freshDir();
  try {
    const solo = emptyRecord(root);
    const result = run(["--check-repro", "--units", solo.dir, "--transcript", solo.transcript]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^FAIL repro-empty /m);
    assert.match(result.stdout, /^gate3-live-chain: RED — repro-empty×1$/m);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a record with no shaped decision is red by name, never green", () => {
  const root = freshDir();
  try {
    const solo = emptyRecord(root);
    const result = run(["--units", solo.dir, "--transcript", solo.transcript, "--quiet"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^gate3-live-chain: RED — lane-equality×1$/m);
    // And the chain still verified what it could: the record's own bytes.
    const { report } = chainRun({
      recordDir: solo.dir, transcriptFile: solo.transcript, arm: "racoons",
    });
    const ran = report.checks.map(entry => entry.name);
    assert.ok(ran.includes("landed-body"));
    assert.ok(ran.includes("prefix-chain"));
    assert.equal(report.counts.shaped, 0);
    assert.equal(report.counts.reproduced, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a stated node-id form that does not reproduce is red by name", () => {
  const { report } = chainRun({
    recordDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons", nodeIdForm: "dsh",
  });
  assert.equal(report.verdict, "RED");
  assert.equal(report.nodeIdForm, "dsh");
  assert.equal(report.nodeIdResolved, false);
  const named = failingChecks(report);
  assert.ok(named.includes("node-id-form"));
  assert.ok(named.includes("self-reproduction"));
  assert.ok(named.includes("recall-id"));
});

// ---- the interleaving: a sub-floor result between a result and its ask -----
//
// The defect this test exists for: the fixture's first result (seq 5, alpha)
// lands at step 1, its ask is at step 2. A real run lands a SUB-FLOOR result in
// between (the ask floor is the session's, lower than the mint floor), and the
// old "last landed row before the answer" heuristic attached alpha's answer to
// that sub-floor row: the unit re-rendered whole, which a pass over RENDERED
// rows silently skipped. Both halves are asserted here: the attribution and the
// coverage counts.

/** The sub-floor landed row inserted between alpha's result and its ask. */
function subFloorRow(step) {
  const body = `<path>C:\\sim\\arm\\golf-sibling.txt</path>\n${
    "golf sibling line .................................................\n".repeat(4)}`;
  assert.ok(Buffer.byteLength(body) < 1280, "the interleaved row is not under the floor");
  return {
    type: "tool/result", seq: null, time: 1_760_000_000_000, surfaceOp: "append",
    data: { turn: 1, step, message: {
      role: "tool", source: { kind: "tool", callId: "call_sim_golf_sibling" },
      toolCallId: "call_sim_golf_sibling", content: [{ type: "text", text: body }],
    } },
  };
}

/**
 * The fixture's rows with one sub-floor result inserted after seq 5 and every
 * later row's seq moved up one. The old→new map is returned so the record's own
 * seq fields move with the transcript: the two still describe one run.
 */
function interleavedRows(rows = readTranscript(TRANSCRIPT)) {
  const at = rows.findIndex(row => row.seq === 5);
  assert.ok(at > 0, "the fixture does not hold the alpha result at seq 5");
  const insertedSeq = 6;
  const remap = new Map();
  let next = 0;
  for (const row of rows) {
    if (next === insertedSeq) next += 1;
    remap.set(row.seq, next);
    next += 1;
  }
  const shifted = rows.map(row => ({
    ...row,
    seq: remap.get(row.seq),
    ...(typeof row.surfaceOp === "object" && row.surfaceOp !== null ? {
      surfaceOp: {
        ...row.surfaceOp,
        startSeq: remap.get(row.surfaceOp.startSeq),
        endSeq: remap.get(row.surfaceOp.endSeq),
      },
    } : {}),
  }));
  shifted.splice(at + 1, 0, { ...subFloorRow(rows[at].data.step), seq: insertedSeq });
  return { rows: shifted, remap, insertedSeq, alphaSeq: remap.get(5) };
}

/** A record dir whose units' seq fields follow the interleaved transcript. */
function interleavedRecord(root, remap) {
  const dir = path.join(root, "interleaved-record");
  mkdirSync(dir, { recursive: true });
  const units = readFileSync(path.join(fixture.out, "live-units.jsonl"), "utf8")
    .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
  const moved = units.map(unit => ({
    ...unit,
    seq: remap.get(unit.seq),
    spanStart: unit.spanStart === null ? null : remap.get(unit.spanStart),
    spanEnd: unit.spanEnd === null ? null : remap.get(unit.spanEnd),
  }));
  writeFileSync(path.join(dir, "live-units.jsonl"),
    `${moved.map(unit => JSON.stringify(unit)).join("\n")}\n`);
  for (const name of ["live-census.json", "live-join.json"]) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(fixture.out, name)));
  }
  return { dir, units: moved };
}

test("a sub-floor result between a result and its ask does not steal the answer", () => {
  const root = freshDir();
  try {
    const { rows, remap, insertedSeq, alphaSeq } = interleavedRows();
    const file = path.join(root, "interleaved.session.v4.jsonl");
    writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const record = interleavedRecord(root, remap);
    const alpha = record.units.find(unit => unit.seq === alphaSeq);
    assert.equal(alpha.composition, "forget-with-partials");
    // The sub-floor row is not a unit, and it is the last landed row before
    // alpha's ask: the exact row the old heuristic would have used.
    assert.equal(record.units.some(unit => unit.seq === insertedSeq), false,
      "the inserted row is a unit, so this case cannot reproduce the defect");
    // A row lands between alpha and its ask: the old heuristic would have used
    // it. The interleaved row is under the floor, so it is no unit.
    const index = indexTranscript(readTranscript(file));
    const between = [...index.landed.keys()].filter(seq => seq > alphaSeq && seq < 8);
    assert.deepEqual(between, [insertedSeq],
      "the interleaved row did not land between alpha and its ask");
    const alphaExchange = index.exchanges.find(entry => entry.target === alphaSeq);
    assert.ok(alphaExchange !== undefined,
      "no exchange was attributed to the over-floor result the ask names");
    // Attribution: the answer is alpha's, by the ask's own facts, never by
    // adjacency to the sub-floor row.
    const built = buildRecord({ recordDir: record.dir, rows: readTranscript(file), arm: "racoons",
      form: "sim-result" });
    assert.equal(built.record.decisions.length, 5);
    assert.ok(built.attribution.answers.has(alphaSeq));
    assert.equal(built.attribution.answers.has(insertedSeq), false,
      "the answer was attached to the sub-floor result");
    const alphaAnswer = built.attribution.answers.get(alphaSeq);
    assert.equal(["shape", "facts", "facts-step"].includes(alphaAnswer.by), true,
      `alpha's answer was placed by ${String(alphaAnswer.by)}`);
    // The chain is green, and the coverage counts close over the record's bodies:
    // three counts whose sum IS the body count, and green because
    // matched = total − censored. The sub-floor row is in none of them (it is
    // no unit) and the receipt is the censored one.
    const { report } = chainRun({
      recordDir: record.dir, transcriptFile: file, arm: "racoons", nodeIdForm: "auto",
    });
    assert.equal(report.verdict, "GREEN", JSON.stringify(report.failures, null, 2));
    assert.deepEqual(
      [report.coverage.matched, report.coverage.censored, report.coverage.refused],
      [4, 1, 0], "the three coverage counts on the interleaved case");
    assert.equal(report.coverage.total, 5);
    assert.equal(report.coverage.matched + report.coverage.censored + report.coverage.refused,
      report.coverage.total, "the three coverage counts do not sum to the body count");
    assert.equal(report.coverage.green, true);
    assert.equal(report.coverage.green, report.coverage.matched
      === report.coverage.total - report.coverage.censored);
    assert.equal(report.counts.decisions, 5);
    assert.equal(report.counts.reproduced, 5);
    // The burn still takes no answer (requirement 2), and nothing was suppressed.
    assert.equal(report.attribution.machineryCensored, 0);
    assert.equal(report.attribution.recordCensored, 0);
    assert.equal(report.attribution.unasked, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("an answer no stated rule can place is refused by name, never dropped", () => {
  const root = freshDir();
  try {
    const { rows, remap } = interleavedRows();
    // The KEEPALL's prompt — the one exchange whose target comes from the facts
    // alone, because a keepall leaves no shaped turn to name it. Rename its
    // facts: no landed row then carries them, and the answer names nothing.
    const before = indexTranscript(readTranscript(TRANSCRIPT));
    const keepallPromptSeq = before.exchanges.find(entry => entry.target === null
      && entry.answer !== null)?.promptSeq;
    assert.equal(typeof keepallPromptSeq, "number", "the fixture holds no facts-only exchange");
    const promptIndex = rows.findIndex(row => row.seq === remap.get(keepallPromptSeq));
    assert.ok(promptIndex > 0, "the keepall prompt moved off the interleaved transcript");
    const first = rows[promptIndex];
    const text = textOf(first).replace(/This result has \d+ lines[,.]?/, "This result has 9999 lines.");
    rows[promptIndex] = { ...first,
      data: { ...first.data, content: [{ type: "text", text }] } };
    const file = path.join(root, "unattributable.session.v4.jsonl");
    writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const record = interleavedRecord(root, remap);
    const build = () => buildRecord({
      recordDir: record.dir, rows: readTranscript(file), arm: "racoons", form: "sim-result",
    });
    assert.throws(build, error => error instanceof Gate3Refusal
      && error.code === "gate3-answer-unattributable"
      && /"lineCount":9999/.test(error.message));
    const cli = run(["--units", record.dir, "--transcript", file, "--quiet"]);
    assert.equal(cli.status, 2, cli.stdout);
    assert.match(cli.stderr, /^gate3-answer-unattributable: /);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a shaped body whose answer never arrived is refused, not skipped", () => {
  // The vacuous green: with the answer gone, the old pass walked RENDERED rows,
  // found four, and reported a green over 4 of the record's 5 bodies. The
  // record's own shaped unit must be named instead.
  const root = freshDir();
  try {
    const rows = readTranscript(TRANSCRIPT).map(row => (row.seq === 9
      ? { ...row, data: { ...row.data,
        message: { ...row.data.message, content: [{ type: "text", text: "Not an answer." }] } } }
      : row));
    const file = path.join(root, "unanswered.session.v4.jsonl");
    writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const { report } = reproRun({ recordDir: fixture.out, transcriptFile: file });
    assert.equal(report.verdict, "RED");
    assert.equal(report.coverage.total, 5);
    assert.equal(report.coverage.matched, 3);
    assert.equal(report.coverage.censored, 1);
    assert.equal(report.coverage.refused, 1);
    assert.equal(report.coverage.green, false);
    assert.equal(report.coverage.matched + report.coverage.censored + report.coverage.refused,
      report.coverage.total);
    const refusal = report.coverage.refusals[0];
    assert.match(refusal.detail, /the record declares a forget-with-partials body and the lane/);
    // And the body that never shaped is named in the red, not silently absent.
    const named = failingChecks(report);
    assert.ok(named.includes("repro-body"),
      `the refused body left repro-body green (red: ${named.join(", ")})`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the coverage counts close on the plain fixture, and are green", () => {
  const { report } = reproRun({ recordDir: fixture.out, transcriptFile: TRANSCRIPT });
  assert.deepEqual(report.coverage, {
    total: 5, matched: 4, censored: 1, refused: 0, green: true, refusals: [],
  });
  const built = buildRecord({
    recordDir: fixture.out, rows: readTranscript(TRANSCRIPT), arm: "racoons", form: "sim-result",
  });
  const coverage = coverageOf({ built, lane: chainRun({
    recordDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons",
  }).lane });
  assert.equal(coverage.matched + coverage.censored + coverage.refused, coverage.total);
});

// ---- every check has a red path; a check that cannot fail is void ---------

/** The chain's resolved record and lanes, once, for direct lane tampering. */
function resolved() {
  const rows = readTranscript(TRANSCRIPT);
  const found = resolveNodeId({ recordDir: fixture.out, rows, arm: "racoons", form: "auto" });
  assert.equal(found.resolved, true);
  return found;
}

/** `chainRun`'s check pass over one hand-broken lane. */
function checksOf(mutate) {
  const { built, lane } = resolved();
  const off = chain(null).off;
  const broken = JSON.parse(JSON.stringify(lane));
  mutate(broken, built, off);
  const checker = newChecker();
  runChecks({ checker, built, lane: broken, off });
  return [...new Set(checker.failures.map(failure => failure.check))].sort();
}

test("each check reddens when its own fact is broken", () => {
  const shaped = lane => lane.rows.find(row => row.shaped);
  const machinery = lane => lane.rows.find(row => row.machinery !== null);
  const cases = {
    "landed-body": lane => { shaped(lane).before = `${shaped(lane).before} `; },
    "self-reproduction": lane => { shaped(lane).after = `${shaped(lane).after}x`; },
    "summary-prefix": lane => {
      const row = shaped(lane);
      row.after = `not the note

${row.after}`;
    },
    "five-terms": lane => { shaped(lane).terms.kept += 1; },
    "marker-line": lane => {
      const row = shaped(lane);
      row.after = row.after.replace("[racoons] kept", "[racoons] kept extra text");
    },
    "recall-id": lane => {
      const row = shaped(lane);
      row.recallId = `recall:sha256:${"0".repeat(64)}`;
    },
    "censored-receipt": lane => { machinery(lane).swapStep = null; },
    "epoch-plan": lane => { shaped(lane).swapStep = 999; },
    "lane-equality": lane => { shaped(lane).before = `${shaped(lane).before} `; },
    "step-visibility": lane => { shaped(lane).decisionStep = 99; },
    "prefix-chain": lane => { lane.steps[0].prefixSha256 = "0".repeat(64); },
  };
  for (const [check, mutate] of Object.entries(cases)) {
    const named = checksOf(mutate);
    assert.ok(named.includes(check), `${check} did not redden (red: ${named.join(", ")})`);
  }
});

// ---- the CLI's refusals: named, before any work ---------------------------

test("usage refusals exit 2 by name", () => {
  const noTranscript = run(["--units", fixture.out]);
  assert.equal(noTranscript.status, 2);
  assert.match(noTranscript.stderr, /^gate3-transcript-required: --units needs --transcript/);

  const badFlip = run(["--flip", "sideways"]);
  assert.equal(badFlip.status, 2);
  assert.match(badFlip.stderr, /^usage: --flip must be one of kept, summary, early, late/);

  const flipRepro = run(["--check-repro", "--units", fixture.out,
    "--transcript", TRANSCRIPT, "--flip", "kept"]);
  assert.equal(flipRepro.status, 2);
  assert.match(flipRepro.stderr, /^usage: --flip applies to the chain, not to --check-repro/);

  const reproNoUnits = run(["--check-repro"]);
  assert.equal(reproNoUnits.status, 2);
  assert.match(reproNoUnits.stderr, /^usage: --check-repro needs --units and --transcript/);

  const absent = run(["--units", path.join(fixture.root, "nope"), "--transcript", TRANSCRIPT]);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /^sim-record-dir-absent: /);
});

test("a live flag is refused by name: this gate never opens a socket", () => {
  for (const flag of ["--live-asks", "--owner-authorized"]) {
    const result = run([flag, "--units", fixture.out, "--transcript", TRANSCRIPT]);
    assert.equal(result.status, 2, `${flag} exited ${result.status}`);
    assert.match(result.stderr, /^gate3-offline-only: /);
  }
});

test("a live environment is refused: this gate is offline only", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--quiet"],
    { encoding: "utf8", env: { ...process.env, CREMATOR_SIM_REAL: "1" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^gate3-offline-only: CREMATOR_SIM_REAL is set/);
});

// ---- the pieces the flips rest on -----------------------------------------

/** One assistant row with a reasoning part, a text part and a replay state. */
const reasoningRow = ({ content, blocks = null }) => ({
  type: "assistant/message", seq: 24,
  data: { message: { role: "assistant", content,
    ...(blocks === null ? {} : { source: { replayState: { blocks } } }) } },
});

test("reasoningOf reads the reasoning parts, drops blanks, and honours alignment", () => {
  const one = reasoningRow({ content: [
    { type: "reasoning", text: "think" }, { type: "text", text: "say" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }, { type: "text" }] });
  assert.deepEqual(reasoningOf(one),
    { text: "think", signature: "reasoning_content", resendable: true });
  // Two parts join with a newline; a blank part contributes nothing.
  const two = reasoningRow({ content: [
    { type: "reasoning", text: "one" }, { type: "reasoning", text: "  \n" },
    { type: "reasoning", text: "two" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning" },
    { type: "reasoning", thinkingSignature: "reasoning" },
    { type: "reasoning", thinkingSignature: "reasoning" }] });
  assert.equal(reasoningOf(two).text, "one\ntwo");
  assert.equal(reasoningOf(two).signature, "reasoning");
  assert.equal(reasoningOf(two).resendable, true);
  // P5: EVERY non-blank reasoning block must be resendable, not only the first.
  // One resendable block and one opaque block is a mixed turn: the joined text
  // would send the opaque block's bytes through `reasoning_content`.
  const mixed = reasoningRow({ content: [
    { type: "reasoning", text: "open" }, { type: "reasoning", text: "sealed" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" },
    { type: "reasoning", thinkingSignature: "encrypted" }] });
  assert.equal(reasoningOf(mixed).text, "open\nsealed", "the text still reads");
  assert.equal(reasoningOf(mixed).signature, null, "no single signature names the turn");
  assert.equal(reasoningOf(mixed).resendable, false,
    "the opaque block is not put back on the wire");
  // Two resendable but DIFFERENT wire fields are also one field too few.
  const split = reasoningRow({ content: [
    { type: "reasoning", text: "a" }, { type: "reasoning", text: "b" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning" },
    { type: "reasoning", thinkingSignature: "reasoning_text" }] });
  assert.equal(reasoningOf(split).signature, null);
  assert.equal(reasoningOf(split).resendable, false,
    "two named signatures cannot both ride one reasoning_content field");
  // A block that carries no signature at all fails the same rule, even beside a
  // resendable one.
  const unsigned = reasoningRow({ content: [
    { type: "reasoning", text: "a" }, { type: "reasoning", text: "b" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning" }, { type: "reasoning" }] });
  assert.equal(reasoningOf(unsigned).resendable, false);
  // A row with no reasoning part is empty and carries no signature.
  assert.deepEqual(reasoningOf(reasoningRow({ content: [{ type: "text", text: "say" }] })),
    { text: "", signature: null, resendable: false });
  // An unaligned replay state names no signature rather than guessing.
  const unaligned = reasoningRow({ content: [{ type: "reasoning", text: "think" }],
    blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }, { type: "text" }] });
  assert.equal(reasoningOf(unaligned).signature, null);
  assert.equal(reasoningOf(unaligned).resendable, false);
  // A type mismatch at any index is the same refusal to guess.
  const shifted = reasoningRow({ content: [{ type: "text", text: "say" },
    { type: "reasoning", text: "think" }],
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }, { type: "text" }] });
  assert.equal(reasoningOf(shifted).signature, null);
  // Only the three named signatures are resendable; an opaque one is stored, not sent.
  const opaque = reasoningRow({ content: [{ type: "reasoning", text: "sealed" }],
    blocks: [{ type: "reasoning", thinkingSignature: "encrypted" }] });
  assert.deepEqual(reasoningOf(opaque),
    { text: "sealed", signature: "encrypted", resendable: false });
  assert.equal(reasoningOf({ type: "tool/result", data: { message: { content: [] } } }).text, "");
  assert.equal(reasoningOf({ type: "assistant/message", data: {} }).text, "");
});

test("firstByteDifference names the byte, and only a difference", () => {
  assert.equal(firstByteDifference("abc", "abc"), null);
  assert.equal(firstByteDifference("abc", "abd"), "byte 2 (99 != 100)");
  assert.equal(firstByteDifference("ab", "abc"), "byte 2 (length 2 != 3)");
});

test("resolveNodeId reports what it tried and refuses an unknown form", () => {
  const rows = readTranscript(TRANSCRIPT);
  const resolved = resolveNodeId({ recordDir: fixture.out, rows, arm: "racoons", form: "auto" });
  assert.equal(resolved.form, "sim-result");
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.attempts.map(attempt => attempt.form), ["dsh", "sim-result"]);
  assert.throws(
    () => resolveNodeId({ recordDir: fixture.out, rows, arm: "racoons", form: "guess" }),
    error => error instanceof Gate3Refusal && error.code === "gate3-node-id-form-unknown");
  assert.throws(
    () => resolveNodeId({ recordDir: fixture.out, rows, arm: "lane-z", form: "auto" }),
    error => error instanceof Gate3Refusal && error.code === "gate3-arm-absent");
});

// ---- the eleventh audit: a malformed part injects nothing --------------

test("textOf drops a malformed text part instead of reading its value", () => {
  // The `data.content` branch already required a string `text`; the
  // `data.message.content` branch did not, so a `{type:"text", text: 42}` part
  // leaked "42" into the body, its line count and every byte figure taken from
  // it. (`{type:"text"}` with no text merely vanishes under `join`; the value
  // that is not a string is the one that injects.)
  const malformed = { data: { message: { content: [
    { type: "text", text: "alpha\n" },
    { type: "text", text: 42 },
    { type: "image", source: "x" },
    { type: "text", text: "beta" },
  ] } } };
  assert.equal(textOf(malformed), "alpha\nbeta",
    "the two well-formed parts join; the numeric one injects nothing");
  const other = { data: { content: [{ type: "text", text: 42 }, { type: "text", text: "kept" }] } };
  assert.equal(textOf(other), "kept", "the other branch keeps its own rule");
});
