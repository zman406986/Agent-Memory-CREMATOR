#!/usr/bin/env node
/**
 * ISSUE-059 T-5 — the stage-1 mint's own gate: the exact three-key set, the floor
 * refusal, a truncated transcript censored WITH its depth, a breaker-latched
 * transcript refused by name with nothing minted, and the run-B self-reproduction
 * check (green on the fixture, red by name on one moved byte).
 *
 * Run: `node --test dev/sim/mint-stage1.test.mjs`
 *
 * The oracle is the committed synthetic fixture (`dev/bench/fixtures/sim/`, T-2)
 * converted by `live-convert.mjs` into a temporary directory. Nothing here reads
 * `scratchpad/`, opens a socket, reads a clock or exports a key.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CENSORING_CLASSES, KEY_SET, MANIFEST_NAME, MintCheckFailed, MintRefusal, SET_NAME,
  askPromptsOf, depthOf, endingOf, latchOf, ledgerLatchOf, mintRows, mintStage1, parseArgs,
  readTranscriptTolerant, refuseFloor, setReproductionOf, summaryOf, truncationOf,
} from "./mint-stage1.mjs";
import { indexTranscript, readTranscript, textOf } from "./gate3-live-chain.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "mint-stage1.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const MANIFEST = path.join(FIXTURE, "manifest.json");
const TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");

/** One fixture conversion, shared by every in-process test. */
let fixture = null;

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const freshDir = () => mkdtempSync(path.join(tmpdir(), "racoons-mint-stage1-test-"));
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const readSet = dir => readFileSync(path.join(dir, SET_NAME), "utf8")
  .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse);
const rmTree = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

/** The converter over a manifest into a fresh directory under one root. */
function convert(manifest = MANIFEST) {
  const root = freshDir();
  const out = path.join(root, "out");
  const converted = spawnSync(process.execPath,
    [CONVERTER, "--manifest", manifest, "--out", out], { encoding: "utf8" });
  assert.equal(converted.status, 0, converted.stderr);
  return { root, out };
}

before(() => {
  fixture = convert();
});
after(() => {
  if (fixture !== null) rmTree(fixture.root);
});

/** One fixture conversion into a directory the caller removes. */
function convertInto(root, name = "out", manifest = MANIFEST) {
  const out = path.join(root, name);
  const converted = spawnSync(process.execPath,
    [CONVERTER, "--manifest", manifest, "--out", out], { encoding: "utf8" });
  assert.equal(converted.status, 0, converted.stderr);
  return out;
}

const fixtureRows = () => readTranscript(TRANSCRIPT);
const writeRows = (file, rows) => writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

/** A transcript copy cut after the row with `seq`: a complete-prefix truncation. */
function cutAt(root, seq, { partialLast = false, name = "cut" } = {}) {
  const rows = fixtureRows().filter(row => row.seq <= seq);
  const file = path.join(root, `${name}.session.v4.jsonl`);
  writeRows(file, rows);
  if (partialLast) {
    // The mid-write shape: the last row loses its closing bytes and the newline.
    const text = readFileSync(file, "utf8").trimEnd();
    const at = text.lastIndexOf("\n");
    writeFileSync(file, `${text.slice(0, at + 1)}${text.slice(at + 1, at + 24)}`);
  }
  const manifest = path.join(root, `${name}.manifest.json`);
  writeFileSync(manifest, `${JSON.stringify({
    schema: "racoons-live-fixture/1",
    arms: { racoons: { transcript: file, armRoot: "C:\\sim\\arm",
      sessionId: "session-sim-5f1c0a2e", rows: rows.length, sha256: "unpinned" } },
  }, null, 2)}\n`);
  return { transcript: file, manifest };
}

/** A record directory whose units file holds only its first `count` rows. */
function cutRecord(out, count) {
  const dir = path.join(path.dirname(out), `cut-${count}`);
  mkdirSync(dir, { recursive: true });
  const units = readFileSync(path.join(out, "live-units.jsonl"), "utf8")
    .split("\n").filter(line => line.trim().length > 0);
  writeFileSync(path.join(dir, "live-units.jsonl"), `${units.slice(0, count).join("\n")}\n`);
  for (const name of ["live-census.json", "live-join.json"]) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(out, name)));
  }
  return dir;
}

/** The latch row the engine writes: one `user/message` record with its record id. */
function latchRow(sessionId = "session-sim-5f1c0a2e", seq = 999, { withRecordId = true } = {}) {
  const text = "RACOONS disabled after two validation failures. Recall remains available.";
  return {
    type: "user/message", seq, time: 1760000900000,
    data: {
      content: [{ type: "text", text }],
      role: "user", id: "latch-row",
      ...withRecordId
        ? { source: { kind: "racoons", recordId: `racoons:breaker-disabled:${sessionId}` } }
        : {},
    },
    surfaceOp: "append",
  };
}

/** A ledger holding just the two tables the mint reads. An event may carry
 * `raw` (a literal payload_json value, including null) to plant a corrupt row. */
function writeLedger(file, events) {
  const { DatabaseSync } = globalThis.process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    intent_id TEXT,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    payload_json TEXT);`);
  db.exec(`CREATE TABLE application_removals (
    intent_id TEXT NOT NULL, rule_id TEXT NOT NULL, removal_id TEXT NOT NULL,
    recall_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
    episode_id TEXT, title TEXT);`);
  const insert = db.prepare("INSERT INTO ledger_events VALUES (?,?,?,?,?,?,?)");
  for (const [index, event] of events.entries()) {
    insert.run(index + 1, `key:${index + 1}`, "session-sim-5f1c0a2e", null,
      event.kind, 1760000000000,
      event.raw !== undefined ? event.raw : JSON.stringify(event.payload ?? {}));
  }
  db.close();
  return file;
}

// ---- the key set: exactly {source, original, decisions} -------------------

test("the minted set's key set is exactly {source, original, decisions}", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  assert.deepEqual(KEY_SET, ["source", "original", "decisions"]);
  assert.deepEqual(Object.keys(minted.manifest), Object.keys(minted.manifest));
  assert.deepEqual(minted.manifest.keySet, ["source", "original", "decisions"]);
  assert.equal(minted.rows.length, 7);
  for (const row of minted.rows) {
    assert.deepEqual(Object.keys(row), ["source", "original", "decisions"]);
    // The eligibility-only rule: no stage-2 field reaches a row.
    for (const banned of ["used", "rf", "censoredClass", "usedBy", "composition"]) {
      assert.equal(Object.hasOwn(row, banned), false, `a row carries ${banned}`);
      assert.equal(Object.hasOwn(row.source, banned), false, `source carries ${banned}`);
      assert.equal(Object.hasOwn(row.original, banned), false, `original carries ${banned}`);
    }
    assert.equal(typeof row.original.text, "string");
    assert.equal(typeof row.source.momentId, "string");
    assert.equal(typeof row.source.nodeId, "string");
  }
  // The decision IS the label, and the manifest says so in words.
  assert.equal(minted.manifest.labels.decisionIsLabel, true);
  assert.match(minted.manifest.labels.statement, /IS the\s+label/);
  // Five asked moments carry an answer with its step; the fail-open and the
  // engine's at-rest receipt carry none and are named.
  const answered = minted.rows.filter(row => row.decisions !== null);
  assert.equal(answered.length, 5);
  assert.deepEqual(answered.map(row => [row.decisions.action, row.decisions.step]), [
    ["forgetlines", 2], ["forgetlines", 4], ["forgetall", 6], ["keepall", 8], ["forgetlines", 14],
  ]);
  const mute = minted.rows.filter(row => row.decisions === null);
  assert.equal(mute.length, 2);
  assert.deepEqual(minted.manifest.labels.rowsWithoutDecision,
    mute.map(row => row.source.momentId));
  // A keepall carries no summary: it rewrites nothing.
  assert.deepEqual(Object.keys(answered[3].decisions).sort(), ["action", "step"]);
});

test("the set is written under --out as the set plus its manifest, and twice identically", () => {
  const root = freshDir();
  try {
    const first = path.join(root, "mint-a");
    const second = path.join(root, "mint-b");
    for (const out of [first, second]) {
      const result = run(["--units", fixture.out, "--transcript", TRANSCRIPT,
        "--out", out, "--arm", "racoons", "--run", "sim"]);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const name of [SET_NAME, MANIFEST_NAME]) {
      const left = readFileSync(path.join(first, name));
      const right = readFileSync(path.join(second, name));
      assert.deepEqual(left, right, `${name} differs between the two runs`);
      assert.equal(left.toString("utf8").includes("\r"), false, `${name} carries CRLF`);
    }
    const manifest = readJson(path.join(first, MANIFEST_NAME));
    // The manifest's fields: the key set, the census, the censoring, n, |J|.
    assert.equal(manifest.schema, "racoons-sim-mint-stage1/1");
    assert.equal(manifest.stage, 1);
    assert.deepEqual(manifest.keySet, [...KEY_SET]);
    assert.deepEqual(manifest.census, {
      landed: 8, overFloor: 7, pathBearing: 7, n: 7, j: 7, askPrompts: 5,
      ledgerRecallIds: null, decisions: 5, withoutAnswer: 2, shaped: 5, unlabelable: 0,
    });
    assert.deepEqual(Object.keys(manifest.censoring), [...CENSORING_CLASSES]);
    assert.equal(manifest.censoring["below-floor"], 1);
    assert.equal(manifest.censoring["machinery-censored"], 1);
    assert.equal(manifest.censoring["ask-failed-fail-open"], 1);
    assert.equal(manifest.censoring["censored-at-end"].count, 0);
    assert.equal(manifest.censoring["no-legal-answer"], 0);
    assert.equal(manifest.run.arm, "racoons");
    assert.equal(manifest.run.truncated, false);
    assert.deepEqual(manifest.run.truncatedReasons, []);
    assert.equal(manifest.run.depth, 14);
    // The inputs are pinned, and the record dir is named, never an absolute path.
    assert.match(manifest.inputs.transcriptSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.inputs.unitsSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.run.recordDir, "out");
    assert.equal(JSON.stringify(manifest).includes(REPO_ROOT.replaceAll("\\", "\\\\")), false);
    // The rows on disk are the rows the manifest counts.
    assert.equal(readSet(first).length, manifest.rows);
    assert.equal(manifest.rows, manifest.census.j);
  } finally {
    rmTree(root);
  }
});

test("the summary prints the counts, n with |J|, and the verdict — never a ratio", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  const summary = summaryOf(minted.manifest);
  assert.match(summary, /^ {2}n {12}7 of \|J\| 7$/m);
  assert.match(summary, /^ {2}censoring .*censored-at-end=0\(depth 14\)/m);
  assert.match(summary, /^mint-stage1: GREEN — 7 row\(s\), n 7 of \|J\| 7, 5 shaped/m);
  assert.match(summary, /^ {2}keys {9}source, original, decisions /m);
  assert.doesNotMatch(summary, /\d+(\.\d+)? ?(×|x) (tokens|bytes)? ?saved/i);
});

// ---- the floor: below 1280 refuses by name, before any read ---------------

test("a floor below 1280 is refused by name and exits 2, minting nothing", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "mint");
    const result = run(["--units", fixture.out, "--transcript", TRANSCRIPT,
      "--out", out, "--floor", "1000"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^mint-floor-below-keep: --floor 1000 is below 1280/);
    assert.equal(existsSync(out), false, "a refused floor still wrote a directory");
    // Refused before a record is read: an absent directory with a bad floor is
    // still the floor's refusal.
    const early = run(["--units", path.join(root, "nope"), "--transcript",
      path.join(root, "nope.jsonl"), "--out", out, "--floor", "8"]);
    assert.equal(early.status, 2);
    assert.match(early.stderr, /^mint-floor-below-keep:/);
    assert.throws(() => parseArgs(["--units", "x", "--transcript", "y", "--out", "z",
      "--floor", "1279"]), error => error instanceof MintRefusal
      && error.code === "mint-floor-below-keep");
    assert.throws(() => refuseFloor(0), error => error.code === "mint-floor-below-keep");
    assert.doesNotThrow(() => refuseFloor(1280));
    // 1280 itself is allowed and mints the same seven rows.
    const atFloor = mintStage1({
      unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons", floor: 1280,
    });
    assert.equal(atFloor.rows.length, 7);
    // A floor ABOVE the record's own narrows the set and still reproduces.
    const wide = mintStage1({
      unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons", floor: 1500,
    });
    assert.equal(wide.rows.length, 5);
    assert.equal(wide.manifest.reproduction.verdict, "GREEN");
  } finally {
    rmTree(root);
  }
});

// ---- truncation: censored-at-end WITH its depth ---------------------------

test("a truncated transcript yields censored-at-end with its depth, not a shorter n", () => {
  const root = freshDir();
  try {
    // Cut the transcript after step 6's step/end: three results have landed and
    // the pass never reaches the composed window. The record is converted from
    // the SAME cut, so the two inputs are one run — and the record's own census
    // still states what the full run held.
    const cut = cutAt(root, 34, { name: "cut" });
    const convertedOut = convertInto(root, "cut-out", cut.manifest);
    const minted = mintStage1({
      unitsDir: convertedOut, transcriptFile: cut.transcript, arm: "racoons", run: "cut",
    });
    const end = minted.manifest.censoring["censored-at-end"];
    assert.equal(end.count, 1, "a truncated pass is censored, not silently dropped");
    assert.equal(end.truncated, true);
    assert.deepEqual(end.reasons, ["unfinished-turn"]);
    // The depth is the step the transcript REACHED, named, not inferred.
    assert.equal(end.depth, 6);
    assert.equal(end.endedBy, "step/end");
    assert.equal(minted.manifest.run.depth, 6);
    assert.equal(minted.manifest.run.truncated, true);
    // The rows that are complete are still minted, and n prints beside |J|.
    assert.equal(minted.rows.length, 3);
    assert.equal(minted.manifest.census.n, 3);
    assert.equal(minted.manifest.census.j, 3);
    // The shortened n is on the record: the full fixture landed 8 and its
    // cut states 3, so the manifest never implies a longer pass.
    assert.equal(minted.manifest.census.landed, 3);
    assert.equal(minted.manifest.reproduction.verdict, "GREEN");
    const summary = summaryOf(minted.manifest);
    assert.match(summary, /^ {2}censoring .*censored-at-end=1\(depth 6\)/m);
    assert.match(summary, /^ {2}depth {8}6 \(ended step\/end, truncated\)$/m);
    assert.match(summary, /^ {2}n {12}3 of \|J\| 3$/m);
  } finally {
    rmTree(root);
  }
});

test("a mid-write last line is censored too, and its complete head still mints", () => {
  const root = freshDir();
  try {
    const cut = cutAt(root, 34, { partialLast: true, name: "partial" });
    const convertedOut = convertInto(root, "partial-out", cut.manifest);
    const minted = mintStage1({
      unitsDir: convertedOut, transcriptFile: cut.transcript, arm: "racoons",
    });
    const end = minted.manifest.censoring["censored-at-end"];
    assert.equal(end.count, 1);
    assert.deepEqual(end.reasons, ["partial-line"]);
    assert.equal(end.endedBy, "partial-line");
    assert.equal(minted.manifest.run.truncatedFinalLine, true);
    assert.equal(minted.manifest.reproduction.verdict, "GREEN");
    assert.ok(minted.rows.length >= 2, `only ${minted.rows.length} row(s) minted`);
  } finally {
    rmTree(root);
  }
});

test("a record sliced mid-stream is censored at the last step it holds", () => {
  const root = freshDir();
  try {
    const recut = cutRecord(fixture.out, 3);
    const minted = mintStage1({
      unitsDir: recut, transcriptFile: TRANSCRIPT, arm: "racoons", run: "recut",
    });
    const end = minted.manifest.censoring["censored-at-end"];
    assert.equal(end.count, 1);
    assert.deepEqual(end.reasons, ["record-cut"]);
    assert.deepEqual(minted.manifest.run.truncatedReasons, ["record-cut"]);
    // The depth is the last step the minted rows reached — step 5, the third
    // landed result's own step — not the transcript's 14.
    assert.equal(end.depth, 5);
    assert.equal(minted.rows.length, 3);
    assert.equal(minted.manifest.reproduction.verdict, "GREEN");
  } finally {
    rmTree(root);
  }
});

test("a clean transcript reports no censoring and the whole depth", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  assert.deepEqual(minted.manifest.run.truncatedReasons, []);
  assert.equal(minted.manifest.run.truncated, false);
  assert.equal(minted.manifest.censoring["censored-at-end"].count, 0);
  assert.equal(minted.manifest.censoring["censored-at-end"].depth, 14);
  const rows = fixtureRows();
  assert.equal(depthOf(rows), 14);
  assert.deepEqual(endingOf(rows, false), { endedBy: "turn/end", complete: true, lastSeq: 75 });
  const head = rows.filter(row => row.seq <= 34);
  assert.deepEqual(endingOf(head, false), { endedBy: "step/end", complete: false, lastSeq: 34 });
  assert.deepEqual(endingOf([], false), { endedBy: "empty", complete: false, lastSeq: null });
});

// ---- the breaker latch: refused by name, nothing minted ------------------

test("a breaker-latched transcript refuses by name and mints nothing", () => {
  const root = freshDir();
  try {
    const rows = [...fixtureRows(), latchRow(undefined, 999)];
    const file = path.join(root, "latched.session.v4.jsonl");
    writeRows(file, rows);
    const out = path.join(root, "mint");
    const result = run(["--units", fixture.out, "--transcript", file, "--out", out,
      "--arm", "racoons"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr,
      /^mint-breaker-latched: the transcript carries the breaker latch at seq 999/);
    assert.match(result.stderr, /racoons:breaker-disabled:session-sim-5f1c0a2e/);
    assert.equal(existsSync(out), false, "a latched transcript still wrote a set");
    assert.throws(() => mintStage1({ unitsDir: fixture.out, transcriptFile: file, arm: "racoons" }),
      error => error instanceof MintRefusal && error.code === "mint-breaker-latched");
  } finally {
    rmTree(root);
  }
});

test("the latch is read from the record id, and from the notice text alone", () => {
  const rows = fixtureRows();
  assert.equal(latchOf(rows), null);
  const withId = latchOf([...rows, latchRow()]);
  assert.equal(withId.seq, 999);
  assert.equal(withId.recordId, "racoons:breaker-disabled:session-sim-5f1c0a2e");
  const textOnly = latchOf([...rows, latchRow(undefined, 998, { withRecordId: false })]);
  assert.equal(textOnly.seq, 998);
  assert.equal(textOnly.recordId, null);
  // The notice's own record id is the prefix the engine writes; a lookalike is not.
  assert.equal(latchOf([{ type: "user/message", seq: 1,
    data: { source: { recordId: "racoons:breaker-announced:session-1" } } }]), null);
});

test("a latched LEDGER refuses too: breaker-disabled, or adjacency-changed", () => {
  const root = freshDir();
  try {
    const clean = writeLedger(path.join(root, "clean.sqlite"), [
      { kind: "validation", payload: { ok: true, breaker: { consecutiveValidationFailures: 0,
        disabled: false } } },
    ]);
    assert.equal(ledgerLatchOf(clean), null);
    const disabled = writeLedger(path.join(root, "disabled.sqlite"), [
      { kind: "breaker-disabled", payload: { reason: "two-validation-failures" } },
    ]);
    assert.deepEqual(ledgerLatchOf(disabled), {
      kind: "breaker-disabled", sequence: 1, issue: null,
    });
    const adjacency = writeLedger(path.join(root, "adjacency.sqlite"), [
      { kind: "validation", payload: { ok: false, issues: [{ code: "adjacency-changed" }],
        breaker: { consecutiveValidationFailures: 2, disabled: true } } },
    ]);
    assert.deepEqual(ledgerLatchOf(adjacency),
      { kind: "validation", sequence: 1, issue: "adjacency-changed" });
    const out = path.join(root, "mint");
    const result = run(["--units", fixture.out, "--transcript", TRANSCRIPT,
      "--out", out, "--arm", "racoons", "--ledger", disabled]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^mint-breaker-latched: the ledger carries breaker-disabled/);
    assert.equal(existsSync(out), false);
    // A clean ledger is read, not refused, and its recall ids are counted.
    const minted = mintStage1({
      unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons", ledgerFile: clean,
    });
    assert.equal(minted.manifest.census.ledgerRecallIds, 0);
    assert.equal(minted.manifest.reproduction.verdict, "GREEN");
  } finally {
    rmTree(root);
  }
});

test("a corrupt validation payload refuses by name, not no-latch (ISSUE-390)", () => {
  const root = freshDir();
  try {
    const unparseable = writeLedger(path.join(root, "unparseable.sqlite"), [
      { kind: "validation", raw: "{not json" },
    ]);
    assert.throws(() => ledgerLatchOf(unparseable),
      error => error instanceof MintRefusal && error.code === "mint-ledger-corrupt");
    const nullPayload = writeLedger(path.join(root, "null.sqlite"), [
      { kind: "validation", raw: null },
    ]);
    assert.throws(() => ledgerLatchOf(nullPayload),
      error => error instanceof MintRefusal && error.code === "mint-ledger-corrupt");
    // A genuinely absent latch is still no-latch, not a refusal.
    const clean = writeLedger(path.join(root, "clean.sqlite"), [
      { kind: "validation", payload: { ok: true, breaker: { disabled: false } } },
    ]);
    assert.equal(ledgerLatchOf(clean), null);
  } finally {
    rmTree(root);
  }
});

// ---- the run-B self-reproduction check (handed over from T-4) -------------

test("the reproduction is green on the fixture: every shaped body reproduces", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  assert.equal(minted.manifest.reproduction.verdict, "GREEN");
  assert.equal(minted.manifest.reproduction.mode, "check-repro");
  assert.equal(minted.manifest.reproduction.shaped, 5);
  assert.deepEqual(minted.manifest.reproduction.failures, []);
  assert.deepEqual(minted.manifest.reproduction.checks, [
    { name: "repro-body", checked: 5, failed: 0 },
    { name: "set-reproduction", checked: 7, failed: 0 },
  ]);
  assert.equal(minted.manifest.reproduction.setReproduction.compared, 4);
  // The set's own pass: the four shaping rows re-render from three keys alone.
  const setRepro = setReproductionOf({
    rows: minted.rows, moments: minted.moments, index: minted.index,
  });
  assert.deepEqual(setRepro.failures, []);
  assert.equal(setRepro.compared, 4);
});

test("one moved byte reddens a NAMED check, exits 1, and writes no file", () => {
  const root = freshDir();
  try {
    // The same tamper T-4's gate uses: one kept letter of one shaped body moves.
    const rows = fixtureRows();
    let moved = null;
    const tampered = rows.map(row => {
      if (moved !== null || row.type !== "tool/result" || typeof row.surfaceOp !== "object"
        || row.surfaceOp.startSeq !== row.surfaceOp.endSeq) return row;
      const body = textOf(row);
      if (!body.includes("[racoons] kept")) return row;
      const at = body.indexOf("\n", body.indexOf("[racoons] kept")) + 1;
      const next = `${body.slice(0, at)}${body[at] === "a" ? "b" : "a"}${body.slice(at + 1)}`;
      moved = row.surfaceOp.startSeq;
      return { ...row, data: { ...row.data,
        message: { ...row.data.message, content: [{ type: "text", text: next }] } } };
    });
    assert.ok(moved !== null);
    const file = path.join(root, "tampered.session.v4.jsonl");
    writeRows(file, tampered);
    const out = path.join(root, "mint");
    const result = run(["--units", fixture.out, "--transcript", file, "--out", out,
      "--arm", "racoons"]);
    assert.equal(result.status, 1, `expected a red check, got ${result.status}`);
    assert.match(result.stdout, /^FAIL repro-body seq \d+: the re-rendered body is not the/m);
    assert.match(result.stdout, /^mint-stage1: RED — repro-body×\d+$/m);
    assert.equal(existsSync(out), false, "a red reproduction still wrote a set");
    // The same run in process throws the named report, never a crash.
    assert.throws(() => mintStage1({ unitsDir: fixture.out, transcriptFile: file, arm: "racoons" }),
      error => error instanceof MintCheckFailed
        && error.report.failures.every(failure => failure.check === "repro-body"));
  } finally {
    rmTree(root);
  }
});

test("a set that cannot reproduce from its own three keys is RED by name", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  // Move one kept letter of one row's `original.text`, and re-state the row's own
  // sha256 over it: the record is untouched, so only the set-level pass can see
  // it. This is a set whose three keys describe bytes run B never held.
  const row = minted.rows.find(entry => entry.decisions?.action === "forgetlines");
  const body = row.original.text;
  const at = body.indexOf("\n", body.indexOf("[racoons] kept")) + 1;
  const broken = `${body.slice(0, at)}${body[at] === "a" ? "b" : "a"}${body.slice(at + 1)}`;
  const tampered = minted.rows.map(entry => (entry === row
    ? { ...entry, original: { ...entry.original, text: broken,
      sha256: createHash("sha256").update(Buffer.from(broken, "utf8")).digest("hex") } }
    : entry));
  const setRepro = setReproductionOf({
    rows: tampered, moments: minted.moments, index: minted.index,
  });
  assert.equal(setRepro.failures.length, 1);
  assert.equal(setRepro.failures[0].check, "set-reproduction");
  assert.match(setRepro.failures[0].detail, /re-render to other bytes/);
  assert.match(setRepro.failures[0].detail, new RegExp(`seq ${row.source.seq}`));
});

test("a set whose row states a sha256 its bytes do not hash to is red, not a crash", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  const row = minted.rows.find(entry => entry.decisions?.action === "forgetall");
  const tampered = minted.rows.map(entry => (entry === row
    ? { ...entry, original: { ...entry.original,
      text: `${entry.original.text}extra\n` } } : entry));
  const setRepro = setReproductionOf({
    rows: tampered, moments: minted.moments, index: minted.index,
  });
  assert.equal(setRepro.failures.length, 1);
  assert.equal(setRepro.failures[0].check, "set-reproduction");
  assert.match(setRepro.failures[0].detail, /do not render \(sim-render-original-sha-mismatch/);
});

test("a set with no shaping decision at all is never green", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  const mute = minted.rows.map(row => ({ ...row, decisions: null }));
  const setRepro = setReproductionOf({ rows: mute, moments: minted.moments, index: minted.index });
  assert.equal(setRepro.compared, 0);
  assert.deepEqual(setRepro.failures, []);
  // The record-level pass is what refuses near an empty oracle: it reports
  // `repro-empty` when the set holds no shaped unit. Prove the empty case on a
  // record whose only unit fails open.
  const root = freshDir();
  try {
    const dir = path.join(root, "solo");
    mkdirSync(dir, { recursive: true });
    const body = `<path>C:\\sim\\arm\\solo.txt</path>\n${
      "solo line ................................................\n".repeat(30)}`;
    const transcript = path.join(root, "solo.session.v4.jsonl");
    writeRows(transcript, [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: "tool/result", seq: 2, time: 3, surfaceOp: "append",
        data: { turn: 1, step: 1, message: { role: "tool",
          source: { kind: "tool", callId: "call_solo" }, toolCallId: "call_solo",
          content: [{ type: "text", text: body }] } } },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes >= 1280);
    writeFileSync(path.join(dir, "live-units.jsonl"), `${JSON.stringify({
      arm: "racoons", tier: "T3", step: 1, callId: "call_solo", seq: 2,
      spanStart: null, spanEnd: null, unitId: `unit:sha256:${"b".repeat(64)}`,
      rawSha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
      normKey: "d".repeat(64), tool: "read", bytes,
      path: "C:\\sim\\arm\\solo.txt", substitutions: { arm: 0, tmp: 0 },
      composition: "ask-failed-fail-open", keptBytes: null, gaps: 0, markerCount: 0,
      markerBytes: 0, summaryBytes: 0, framingBytes: null, droppedBytes: 0, ranges: null,
      recallId: null, rf: 0, used: false, usedBy: null, censoredClass: "refused-ask",
      keepallVia: null, atRest: null,
    })}\n`);
    writeFileSync(path.join(dir, "live-census.json"), `${JSON.stringify({
      floor: 1280, arms: { racoons: { sessionId: "session-solo", appends: 1, steps: 1,
        landedAtFloor: 1 } },
    }, null, 2)}\n`);
    writeFileSync(path.join(dir, "live-join.json"), `${JSON.stringify({
      floor: 1280, tiers: { T1: 0, T2: 0, T3: 1 }, pairs: [], endedBy: { racoons: "complete" },
    }, null, 2)}\n`);
    const out = path.join(root, "mint");
    const result = run(["--units", dir, "--transcript", transcript, "--out", out,
      "--arm", "racoons"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^FAIL repro-empty /m);
    assert.match(result.stdout, /^mint-stage1: RED — repro-empty×1$/m);
    assert.equal(existsSync(out), false);
  } finally {
    rmTree(root);
  }
});

// ---- the census and the refusals -----------------------------------------

test("the census counts landed, over-floor, path-bearing, asks and decisions", () => {
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  const census = minted.manifest.census;
  // The converter's own `units` line and the fixture's pinned composition: 8
  // landed, 7 over the floor (one below-floor row), all seven path-bearing.
  assert.equal(census.landed, 8);
  assert.equal(census.overFloor, 7);
  assert.equal(census.pathBearing, 7);
  assert.equal(census.n, census.pathBearing);
  assert.equal(census.j, 7);
  // Five ask prompts, and five answers whose steps the gate derived or read.
  assert.equal(census.askPrompts, 5);
  assert.equal(askPromptsOf(fixtureRows()), 5);
  assert.equal(census.decisions + census.withoutAnswer, census.j);
  // Five shaped rows, the receipt and the fail-open whole-result.
  assert.equal(census.shaped, 5);
  assert.equal(census.unlabelable, 0);
  // Every row's own path agrees with the census.
  assert.equal(minted.rows.filter(row => typeof row.source.path === "string"
    && row.source.path.length > 0).length, census.pathBearing);
  // The index is the gate's, and every ask prompt it reads is one exchange.
  const index = indexTranscript(fixtureRows());
  assert.equal(index.exchanges.length, 5);
  // The coverage counts close over the record's bodies: four shaped units plus
  // the at-rest receipt, all matched or censored by name.
  assert.equal(minted.manifest.reproduction.coverage.total, 5);
  assert.equal(minted.manifest.reproduction.coverage.matched, 4);
  assert.equal(minted.manifest.reproduction.coverage.censored, 1);
  assert.equal(minted.manifest.reproduction.coverage.refused, 0);
  assert.equal(minted.manifest.reproduction.coverage.green, true);
});

test("a record naming two lanes needs --arm, and an unknown arm is refused by name", () => {
  const root = freshDir();
  try {
    // The converter writes units for the SCORED arm only, so a two-arm manifest
    // still yields one lane of moments. Two lanes in the UNITS file is the only
    // shape that needs --arm, and a hand-written record states it directly.
    const dir = path.join(root, "two-lane");
    mkdirSync(dir, { recursive: true });
    const units = readFileSync(path.join(fixture.out, "live-units.jsonl"), "utf8")
      .split("\n").filter(line => line.trim().length > 0).slice(0, 2)
      .map(line => JSON.parse(line));
    const cloned = units.map(unit => ({ ...unit, arm: "lane-k",
      unitId: `unit:sha256:${"1".repeat(64)}`.slice(0, 16) + unit.unitId.slice(16) }));
    writeFileSync(path.join(dir, "live-units.jsonl"),
      `${[...units, ...cloned].map(unit => JSON.stringify(unit)).join("\n")}\n`);
    const census = readJson(path.join(fixture.out, "live-census.json"));
    census.arms["lane-k"] = { ...census.arms.racoons };
    writeFileSync(path.join(dir, "live-census.json"), `${JSON.stringify(census, null, 2)}\n`);
    writeFileSync(path.join(dir, "live-join.json"),
      readFileSync(path.join(fixture.out, "live-join.json")));
    assert.throws(() => mintStage1({ unitsDir: dir, transcriptFile: TRANSCRIPT }),
      error => error instanceof MintRefusal && error.code === "mint-arm-required");
    assert.throws(() => mintStage1({
      unitsDir: dir, transcriptFile: TRANSCRIPT, arm: "lane-z",
    }), error => error instanceof MintRefusal && error.code === "mint-arm-absent");
    // A control arm that landed a result but no ask: its set holds no shaped body,
    // so the record-level pass refuses `repro-empty` by name rather than passing
    // on an absent oracle.
    const control = path.join(root, "control");
    mkdirSync(control, { recursive: true });
    const controlRows = readTranscript(path.join(FIXTURE, "sim-control.session.v4.jsonl"));
    const controlFile = path.join(root, "control.session.v4.jsonl");
    writeRows(controlFile, controlRows);
    const landedAppend = controlRows.find(row => row.type === "tool/result"
      && row.surfaceOp === "append");
    const controlBody = textOf(landedAppend);
    writeFileSync(path.join(control, "live-units.jsonl"), `${JSON.stringify({
      arm: "vanilla", tier: "T3", step: landedAppend.data.step,
      callId: landedAppend.data.message.toolCallId, seq: landedAppend.seq,
      spanStart: null, spanEnd: null, unitId: `unit:sha256:${"e".repeat(64)}`,
      rawSha256: createHash("sha256").update(Buffer.from(controlBody, "utf8")).digest("hex"),
      normKey: "f".repeat(64), tool: "read", bytes: Buffer.byteLength(controlBody),
      path: "C:\\sim\\arm\\alpha.txt", substitutions: { arm: 0, tmp: 0 },
      composition: "ask-failed-fail-open", keptBytes: null, gaps: 0, markerCount: 0,
      markerBytes: 0, summaryBytes: 0, framingBytes: null, droppedBytes: 0, ranges: null,
      recallId: null, rf: 0, used: false, usedBy: null, censoredClass: "refused-ask",
      keepallVia: null, atRest: null,
    })}\n`);
    writeFileSync(path.join(control, "live-census.json"), `${JSON.stringify({
      floor: 1280, arms: { vanilla: { sessionId: "session-sim-5f1c0a2e", appends: 8, steps: 8,
        landedAtFloor: 7 } }, censoring: { "no-legal-answer": 0 },
    }, null, 2)}\n`);
    writeFileSync(path.join(control, "live-join.json"), `${JSON.stringify({
      floor: 1280, tiers: { T1: 0, T2: 0, T3: 1 }, pairs: [],
      endedBy: { vanilla: "complete" },
    }, null, 2)}\n`);
    assert.throws(() => mintStage1({
      unitsDir: control, transcriptFile: controlFile, arm: "vanilla",
    }), error => error instanceof MintCheckFailed
      && error.report.failures.some(failure => failure.check === "repro-empty"));
  } finally {
    rmTree(root);
  }
});

test("usage refusals exit 2, and a corrupt line is the gate's own refusal", () => {
  const root = freshDir();
  try {
    const missing = run(["--units", fixture.out]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^usage: --transcript is required/);
    const unknown = run(["--units", fixture.out, "--transcript", TRANSCRIPT,
      "--out", path.join(root, "m"), "--sideways", "1"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^usage: unknown argument --sideways/);
    // A bad line that is NOT the last one is not a truncation: it refuses.
    const rows = fixtureRows();
    const file = path.join(root, "corrupt.session.v4.jsonl");
    const lines = rows.map(row => JSON.stringify(row));
    lines[5] = "{not json}";
    writeFileSync(file, `${lines.join("\n")}\n`);
    assert.throws(() => readTranscriptTolerant(file),
      error => error.code === "gate3-transcript-unreadable");
    const absent = run(["--units", fixture.out, "--transcript", path.join(root, "nope.jsonl"),
      "--out", path.join(root, "m")]);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /^mint-transcript-unreadable: /);
    // An empty transcript is refused: an absent oracle is never a pass.
    const empty = path.join(root, "empty.jsonl");
    writeFileSync(empty, "");
    assert.throws(() => mintStage1({ unitsDir: fixture.out, transcriptFile: empty }),
      error => error.code === "mint-transcript-empty");
  } finally {
    rmTree(root);
  }
});

test("an answer the record names but the transcript lacks refuses by name", () => {
  // The record's moment names an ask, and the decision list holds none for it.
  assert.throws(() => mintRows({
    moments: [{
      id: "unit:sha256:aa", lane: "racoons", seq: 5, step: 1, path: "a.txt", bytes: 2000,
      original: { sha256: "b".repeat(64), text: "x" },
      provenance: { source: "racoons/entry-ask", composition: "forgetlines",
        censoredClass: null, recordName: "racoons" },
      source: { nodeId: "sim-result-a.txt" },
    }],
    decisions: [],
    run: "sim",
    arm: "racoons",
  }), error => error instanceof MintRefusal && error.code === "mint-answer-absent");
  // And the other direction: an answer for a moment the record names no ask for
  // (a receipt or a fail-open) is a decision with no ask behind it.
  assert.throws(() => mintRows({
    moments: [{
      id: "unit:sha256:bb", lane: "racoons", seq: 48, step: 9, path: "b.txt", bytes: 2000,
      original: { sha256: "c".repeat(64), text: "x" },
      provenance: { source: null, composition: null,
        censoredClass: "machinery-at-rest-removal", recordName: "racoons" },
      source: { nodeId: "sim-result-b.txt" },
    }],
    decisions: [{ momentId: "unit:sha256:bb", step: 10, answer: { action: "forgetall",
      summary: "note" } }],
    run: "sim",
    arm: "racoons",
  }), error => error instanceof MintRefusal && error.code === "mint-decision-without-ask");
});

test("a unit the record pairs with an ask about another result is named, not minted mute", () => {
  // Run B's shape: the converter paired unit 721 (a keepall) with the prompt at
  // seq 747, and that prompt's own facts describe a different landed row. The
  // unit therefore has no answer by any stated rule, and the mint says so with
  // the record's own pairing, instead of writing a row with `decisions: null`
  // over a body the record says was decided.
  const moment = (seq, spanStart) => ({
    id: `unit:sha256:${String(seq).padStart(2, "0")}`, lane: "racoons", seq, step: 64,
    path: null, bytes: 4313, unitSpan: { startSeq: spanStart, endSeq: spanStart + 1 },
    original: { sha256: "b".repeat(64), text: "x" },
    provenance: { source: "racoons/entry-ask", composition: "keepall",
      censoredClass: null, recordName: "racoons" },
    source: { nodeId: "dsh:session:result:call_x" },
  });
  const attribution = {
    placed: [{ by: "record-span", target: 747, exchange: { promptSeq: 747 } }],
  };
  assert.throws(() => mintRows({
    moments: [moment(721, 747), { ...moment(745, null), unitSpan: null,
      provenance: { source: null, composition: "ask-failed-fail-open",
        censoredClass: "refused-ask", recordName: "racoons" } }],
    decisions: [],
    run: "runb",
    arm: "racoons",
    attribution,
  }), error => error instanceof MintRefusal
    && error.code === "mint-answer-absent"
    && /pairs it with the ask at seq 747/.test(error.message)
    && /answers that ask about seq 747/.test(error.message));
});

test("the manifest's censoring covers every §4 class, in the plan's order", () => {
  assert.deepEqual([...CENSORING_CLASSES], [
    "below-floor", "machinery-censored", "ask-failed-fail-open", "unlabelable",
    "failed-join", "censored-at-end", "lane-f-unjudged", "censored-at-cap",
    "no-legal-answer",
  ]);
  const minted = mintStage1({ unitsDir: fixture.out, transcriptFile: TRANSCRIPT, arm: "racoons" });
  assert.deepEqual(Object.keys(minted.manifest.censoring), [...CENSORING_CLASSES]);
  // `no-legal-answer` must be 0: any occurrence is a defect.
  assert.equal(minted.manifest.censoring["no-legal-answer"], 0);
  // The record's own censoring block is carried, never recomputed here.
  assert.equal(minted.manifest.recordCensoring["no-legal-answer"], 0);
});

test("truncationOf names each reason and keeps the depth it can prove", () => {
  const rows = fixtureRows();
  const clean = truncationOf({
    ending: endingOf(rows, false), transcriptDepth: 14, moments: [], censusArm: null, unitsForArm: 0,
  });
  assert.equal(clean.truncated, false);
  assert.deepEqual(clean.reasons, []);
  const cut = truncationOf({
    ending: endingOf(rows.slice(0, 34), false), transcriptDepth: depthOf(rows.slice(0, 34)),
    moments: [{ step: 1 }, { step: 3 }, { step: 5 }], censusArm: { landedAtFloor: 7 },
    unitsForArm: 3,
  });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.reasons, ["unfinished-turn", "record-cut"]);
  // Two reasons: the transcript's own depth wins, and both are named.
  assert.equal(cut.depth, 6);
});
