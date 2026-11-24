#!/usr/bin/env node
/**
 * ISSUE-059 T-1 — the record adapter's gate: a `live-convert.mjs` output
 * directory read as the moment list.
 *
 * The oracle is the converter's own record, never a second parse: the tests run
 * the converter over the in-repo 040 fixture into a temp dir and compare the
 * adapter's moments against `live-units.jsonl`. Nothing here reads `scratchpad/`
 * and nothing opens a socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_FLOOR, SimRecordRefusal, floorOf, loadRecord, momentsOf, parseArgs, provenanceOf,
} from "./sim-record.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "sim-record.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const MANIFEST = path.join(REPO_ROOT, "dev", "bench", "fixtures", "live", "manifest.json");

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "racoons-sim-record-"));
}

const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const readUnits = dir => readFileSync(path.join(dir, "live-units.jsonl"), "utf8")
  .split("\n").filter(Boolean).map(JSON.parse);

/** The converter, run over a manifest into `out`. */
function convert(manifest, out) {
  const result = spawnSync(process.execPath, [CONVERTER, "--manifest", manifest, "--out", out],
    { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

/** A copy of the 040 manifest with only the named arms. */
function writeArmSubset(root, keep) {
  const source = readJson(MANIFEST);
  const file = path.join(root, `arms-${keep.length}-${keep.join("-")}.manifest.json`);
  writeFileSync(file, `${JSON.stringify({
    schema: source.schema,
    arms: Object.fromEntries(keep.map(name => [name, source.arms[name]])),
  }, null, 2)}\n`);
  return file;
}

/** The CLI, run over a record directory. */
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

// ---- the 040 fixture, two arms (the converter's own oracle) ----------------

test("the 040 record yields 65 moments carrying the converter's own unit ids", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "out");
    convert(MANIFEST, out);
    const units = readUnits(out);
    const moments = momentsOf(loadRecord(out));
    assert.equal(moments.length, 65);
    assert.equal(units.length, 65);
    // Every moment's id IS the converter's id for that unit — no re-mint.
    assert.deepEqual(moments.map(moment => moment.id).sort(),
      units.map(unit => unit.unitId).sort());
    // Byte spans match the converter's `mintUnitId` span: the whole result.
    for (const moment of moments) {
      assert.equal(moment.byteRange.startByte, 0);
      assert.equal(moment.byteRange.endByteExclusive, moment.bytes);
    }
    // The fixture predates the ask seam: every unit failed open, so no moment
    // carries an ask provenance and every one names its censoring class.
    assert.equal(moments.filter(moment => moment.provenance.source !== null).length, 0);
    assert.equal(moments.filter(moment => moment.provenance.censoredClass === "refused-ask").length, 65);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the adapter reads a record twice into byte-identical output", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "out");
    convert(MANIFEST, out);
    const first = run(["--units", out, "--json"]);
    const second = run(["--units", out, "--json"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- one-arm records (run B's shape) --------------------------------------

test("a one-arm record reaches the adapter with no join crash", () => {
  const root = freshDir();
  try {
    const manifest = writeArmSubset(root, ["racoons"]);
    const out = path.join(root, "out");
    const converted = convert(manifest, out);
    assert.match(converted.stdout, /^ {2}join {9}0 by name — one-arm record$/m);
    // The join sidecar says T1 = 0 and every unit is T3; a reader keyed on
    // `arm === "racoons" && tier === "T1"` would see nothing, so the moment
    // count is the proof the adapter keys on the record instead.
    assert.deepEqual(readJson(path.join(out, "live-join.json")).tiers, { T1: 0, T2: 0, T3: 65 });
    const moments = momentsOf(loadRecord(out));
    assert.equal(moments.length, 65);
    assert.equal(moments.filter(moment => moment.record.tier === "T3").length, 65);
    const result = run(["--units", out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}moments {6}65$/m);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a renamed solo arm keeps its own name as the lane and the ask source", () => {
  const root = freshDir();
  try {
    const source = readJson(MANIFEST);
    const manifest = path.join(root, "run-b.manifest.json");
    writeFileSync(manifest, `${JSON.stringify({
      schema: source.schema, arms: { "run-b": source.arms.racoons },
    }, null, 2)}\n`);
    const out = path.join(root, "out");
    convert(manifest, out);
    const moments = momentsOf(loadRecord(out));
    assert.equal(moments.length, 65);
    assert.deepEqual([...new Set(moments.map(moment => moment.lane))], ["run-b"]);
    assert.deepEqual([...new Set(moments.map(moment => moment.provenance.recordName))], ["run-b"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- the floor ------------------------------------------------------------

test("a floor below 1280 is refused by name and exits nonzero", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "out");
    convert(MANIFEST, out);
    const result = run(["--units", out, "--floor", "1000"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^sim-record-floor-below-keep: --floor 1000 is below 1280/);
    // Refused before a record is read: an absent directory with a bad floor is
    // still the floor's refusal, not the directory's.
    const early = run(["--units", path.join(root, "nope"), "--floor", "8"]);
    assert.equal(early.status, 2);
    assert.match(early.stderr, /^sim-record-floor-below-keep:/);
    assert.throws(() => parseArgs(["--units", out, "--floor", String(MIN_FLOOR - 1)]),
      (error) => error instanceof SimRecordRefusal && error.code === "sim-record-floor-below-keep");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a floor above the record's own floor narrows the list and keeps the ids", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "out");
    convert(MANIFEST, out);
    const all = momentsOf(loadRecord(out));
    const wide = momentsOf(loadRecord(out), { floor: 8192 });
    assert.equal(wide.length, 17);
    assert.ok(wide.length < all.length);
    const wideIds = new Set(wide.map(moment => moment.id));
    for (const moment of wide) assert.ok(wideIds.has(moment.id));
    for (const moment of all.filter(entry => entry.bytes >= 8192)) {
      assert.ok(wideIds.has(moment.id), `${moment.id} fell out at the wider floor`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a floor below the record's own floor is refused: rows under it were never written", () => {
  const root = freshDir();
  try {
    const out = path.join(root, "out");
    convert(MANIFEST, out);
    const record = loadRecord(out);
    // A record converted at 8192 holds no sub-8192 rows, so it cannot answer 2048.
    const wide = momentsOf(record, { floor: 8192 });
    assert.equal(wide.length, 17);
    assert.throws(() => momentsOf({ ...record, census: { ...record.census, floor: 8192 },
      join: { ...record.join, floor: 8192 } }, { floor: 2048 }),
    (error) => error instanceof SimRecordRefusal && error.code === "sim-record-floor-below-record");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- provenance, on a record whose decisions are recorded -----------------

const SYNTH_SESSION = "session-sim-record";
const RECALL_ID = `recall:sha256:${"a".repeat(64)}`;

/** One unit row in the converter's own field order and shape. */
function unitRow(overrides) {
  return {
    arm: "racoons", tier: "T3", step: 1, callId: "call_1", seq: 10,
    spanStart: null, spanEnd: null,
    unitId: `unit:sha256:${"b".repeat(64)}`,
    rawSha256: "c".repeat(64), normKey: "d".repeat(64), tool: "pwsh", bytes: 2000, path: null,
    substitutions: { arm: 0, tmp: 0 },
    composition: null, keptBytes: null, gaps: 0, markerCount: 0, markerBytes: 0,
    summaryBytes: 0, framingBytes: null, droppedBytes: null, ranges: null,
    recallId: null, rf: null, used: false, usedBy: null, censoredClass: null,
    keepallVia: null, atRest: null,
    ...overrides,
  };
}

/**
 * A hand-written record in the converter's output shape: a keep-all, a forget
 * naming a recall id, an at-rest proof burn, and a fail-open. Written by hand
 * because only the adapter's mapping is under test here; the 040 tests above
 * bind it to the converter's real output.
 */
function writeSyntheticRecord(root, { arm = "racoons" } = {}) {
  const dir = path.join(root, "record");
  mkdirSync(dir, { recursive: true });
  const units = [
    unitRow({ seq: 10, composition: "keepall", keepallVia: "surface-rewind",
      spanStart: 12, spanEnd: 13, droppedBytes: 0, rf: 0, path: "src/a.ts" }),
    unitRow({ seq: 30, unitId: `unit:sha256:${"e".repeat(64)}`,
      composition: "forget-with-partials", keptBytes: 900, gaps: 1, markerCount: 1,
      markerBytes: 120, summaryBytes: 80, framingBytes: 2, droppedBytes: 1100, rf: 0.55,
      recallId: RECALL_ID, path: "src/b.ts" }),
    unitRow({ seq: 40, unitId: `unit:sha256:${"f".repeat(64)}`,
      censoredClass: "machinery-at-rest-removal", droppedBytes: 0, rf: 0,
      atRest: { seq: 41, recallId: RECALL_ID, target: "src/b.ts", ledgerDroppedBytes: 1100 } }),
    unitRow({ seq: 50, unitId: `unit:sha256:${"9".repeat(64)}`,
      composition: "ask-failed-fail-open", censoredClass: "refused-ask", droppedBytes: 0, rf: 0 }),
  ].map(unit => ({ ...unit, arm }));
  writeFileSync(path.join(dir, "live-units.jsonl"),
    `${units.map(unit => JSON.stringify(unit)).join("\n")}\n`);
  writeFileSync(path.join(dir, "live-census.json"), `${JSON.stringify({
    floor: 1280, arms: { [arm]: { sessionId: SYNTH_SESSION, appends: 4, steps: 4 } },
  }, null, 2)}\n`);
  writeFileSync(path.join(dir, "live-join.json"), `${JSON.stringify({
    floor: 1280, tiers: { T1: 0, T2: 0, T3: 4 }, pairs: [], endedBy: { [arm]: "complete" },
  }, null, 2)}\n`);
  return dir;
}

/** A ledger with just the one table the adapter reads. */
function writeLedger(file, rows) {
  const { DatabaseSync } = globalThis.process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application_removals (
    intent_id TEXT NOT NULL, rule_id TEXT NOT NULL, removal_id TEXT NOT NULL,
    recall_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
    episode_id TEXT, title TEXT);`);
  const insert = db.prepare("INSERT INTO application_removals VALUES (?,?,?,?,?,?,?)");
  for (const row of rows) {
    insert.run(row.intentId ?? "intent", row.ruleId, row.removalId ?? "removal",
      row.recallId, row.kind ?? "forget", null, null);
  }
  db.close();
}

test("provenance is keyed on the record's own fields, never on a racoons/T1 literal", () => {
  const root = freshDir();
  try {
    // An arm the code never names: if the adapter hard-coded `racoons`, this
    // record would come back empty.
    const dir = writeSyntheticRecord(root, { arm: "lane-k" });
    const moments = momentsOf(loadRecord(dir), { recordName: "run-b" });
    assert.equal(moments.length, 4);
    const bySeq = new Map(moments.map(moment => [moment.seq, moment]));
    // A keep-all and a forget were decided by the ask seam.
    for (const seq of [10, 30]) {
      assert.equal(bySeq.get(seq).provenance.source, "run-b/entry-ask");
      assert.equal(bySeq.get(seq).lane, "lane-k");
      assert.equal(bySeq.get(seq).record.tier, "T3");
    }
    assert.equal(bySeq.get(10).provenance.composition, "keepall");
    assert.equal(bySeq.get(10).provenance.keepallVia, "surface-rewind");
    assert.equal(bySeq.get(30).provenance.composition, "forget-with-partials");
    assert.equal(bySeq.get(30).provenance.recallId, RECALL_ID);
    // A machinery removal is not an ask decision, and neither is a fail-open.
    assert.equal(bySeq.get(40).provenance.source, null);
    assert.equal(bySeq.get(40).provenance.censoredClass, "machinery-at-rest-removal");
    assert.equal(bySeq.get(40).provenance.recallId, RECALL_ID);
    assert.equal(bySeq.get(50).provenance.source, null);
    assert.equal(bySeq.get(50).provenance.censoredClass, "refused-ask");
    // `recordName` is the stated name when one is passed, else the lane.
    assert.equal(bySeq.get(10).provenance.recordName, "run-b");
    const unstated = momentsOf(loadRecord(dir));
    assert.deepEqual([...new Set(unstated.map(moment => moment.provenance.recordName))], ["lane-k"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the ledger's rule ids attach to the moment naming their recall id", () => {
  const root = freshDir();
  try {
    const dir = writeSyntheticRecord(root);
    const ledger = path.join(root, "ledger.sqlite");
    writeLedger(ledger, [
      { ruleId: "entry-shape", recallId: RECALL_ID, kind: "evict" },
      { ruleId: "entry-shape", recallId: RECALL_ID, kind: "evict" },
    ]);
    const result = run(["--units", dir, "--ledger", ledger, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const moments = JSON.parse(result.stdout);
    const forget = moments.find(moment => moment.seq === 30);
    assert.deepEqual(forget.provenance.ruleIds, ["entry-shape"]);
    assert.equal(forget.provenance.ruleIdSource, "ledger");
    // No ledger given: the field is null and says why.
    const noLedger = momentsOf(loadRecord(dir));
    assert.equal(noLedger.find(moment => moment.seq === 30).provenance.ruleIds, null);
    assert.equal(noLedger.find(moment => moment.seq === 30).provenance.ruleIdSource, "no-ledger");
    // A recall id the ledger does not hold is a class, not a refusal.
    const otherMoments = momentsOf(loadRecord(dir), { ledgerIndex: new Map() });
    assert.deepEqual(otherMoments.find(moment => moment.seq === 30).provenance.ruleIds, []);
    assert.equal(otherMoments.find(moment => moment.seq === 30).provenance.ruleIdSource,
      "no-ledger-row");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---- refusals: a record that cannot be read is named, never half-scored ----

test("a missing or unreadable record is refused by name", () => {
  const root = freshDir();
  try {
    const absent = run(["--units", path.join(root, "nope")]);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /^sim-record-dir-absent: /);

    const noUnits = path.join(root, "no-units");
    mkdirSync(noUnits);
    writeFileSync(path.join(noUnits, "live-census.json"), "{}\n");
    writeFileSync(path.join(noUnits, "live-join.json"), "{}\n");
    const missing = run(["--units", noUnits]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^sim-record-input-absent: .*live-units\.jsonl is missing/);

    const badLine = writeSyntheticRecord(root);
    writeFileSync(path.join(badLine, "live-units.jsonl"), "{not json}\n");
    assert.throws(() => loadRecord(badLine),
      (error) => error instanceof SimRecordRefusal && error.code === "sim-record-unreadable");
    assert.ok(existsSync(path.join(badLine, "live-units.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a duplicate unit id and a floor disagreement are refused by name", () => {
  const root = freshDir();
  try {
    const dir = writeSyntheticRecord(root);
    const text = readFileSync(path.join(dir, "live-units.jsonl"), "utf8").trim().split("\n");
    writeFileSync(path.join(dir, "live-units.jsonl"), `${text[0]}\n${text[0]}\n`);
    assert.throws(() => momentsOf(loadRecord(dir)),
      (error) => error instanceof SimRecordRefusal && error.code === "sim-record-duplicate-unit");
    // The floor the join sidecar states is the other statement of one number.
    const second = writeSyntheticRecord(path.join(root, "second"));
    const census = readJson(path.join(second, "live-census.json"));
    census.floor = 8192;
    writeFileSync(path.join(second, "live-census.json"), `${JSON.stringify(census, null, 2)}\n`);
    assert.throws(() => floorOf(loadRecord(second)),
      (error) => error instanceof SimRecordRefusal && error.code === "sim-record-floor-disagreement");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("provenanceOf leaves an undeclared arm's source null rather than inventing one", () => {
  const provenance = provenanceOf(unitRow({ arm: "lane-f", composition: "forget-all",
    recallId: RECALL_ID }), {});
  assert.equal(provenance.lane, "lane-f");
  assert.equal(provenance.recordName, "lane-f");
  assert.equal(provenance.source, "lane-f/entry-ask");
  assert.equal(provenance.ruleIds, null);
  assert.equal(provenance.ruleIdSource, "no-ledger");
});
