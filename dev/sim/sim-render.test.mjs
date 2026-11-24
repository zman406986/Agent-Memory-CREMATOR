#!/usr/bin/env node
/**
 * ISSUE-059 T-3 — the lane re-render's gate: the sim fixture's five terms, the
 * one-byte flip, and the step a decision shows at.
 *
 * Run: `node --test dev/sim/sim-render.test.mjs`
 *
 * The oracle is the committed synthetic fixture (`dev/bench/fixtures/sim/`,
 * T-2): `expected-composition.json` pins every shaped row's five terms and its
 * shaped body's sha256, and the transcript holds the shaped rows themselves.
 * The record is the adapter's (`sim-record.mjs`, T-1) over the converter's own
 * output; nothing here re-parses a transcript, and nothing opens a socket or
 * reads a clock.
 *
 * The two facts the record does not carry — each moment's landed body and each
 * answer's parsed text — are supplied here, as the module's own contract says a
 * caller must. The answer is decoded by the PRODUCT's `parseEntryAnswer`, so
 * the fixture is read by the shipped grammar and not by a second one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntryAnswer, splitLineOffsets } from "@cremator/core";
import { loadRecord, momentsOf } from "./sim-record.mjs";
import {
  SimRenderRefusal, TERM_NAMES, prefixAt, prefixTextAt, renderLane, renderMoment, summaryOf,
} from "./sim-render.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");
const EXPORTED = path.join(FIXTURE, "expected-composition.json");

const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const sha256Hex = text => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** The message text one transcript row carries; a row's content parts, joined. */
function textOf(row) {
  const content = row.data?.message?.content;
  if (Array.isArray(content)) {
    return content.filter(part => part.type === "text").map(part => part.text).join("");
  }
  const parts = row.data?.content;
  if (!Array.isArray(parts)) return "";
  return parts.filter(part => typeof part.text === "string").map(part => part.text).join("");
}

/**
 * The record: the adapter's moments, plus the caller fields a byte-level
 * re-render needs, plus the decisions the transcript's answers state.
 */
function buildRecord(recordDir, transcriptRows) {
  const landed = new Map();
  for (const row of transcriptRows) {
    if (row.type === "tool/result" && row.surfaceOp === "append") landed.set(row.seq, textOf(row));
  }
  // The answers: a message turn that decodes with the product's own grammar
  // and follows a landed result. The turn is an `assistant/message` in
  // transcripts written before ISSUE-074 and a `user/message` after it (scheme
  // A: dsh refuses a stored assistant turn outside an open step), so the row
  // type is never the key — the grammar is; the step is whatever the row
  // states, null when it states none. Prose does not parse and is skipped; a
  // malformed answer would throw, which is what a fixture change must do.
  const answers = new Map();
  let lastLanded = null;
  for (const row of transcriptRows) {
    if (row.type === "tool/result" && row.surfaceOp === "append") lastLanded = row.seq;
    if ((row.type !== "assistant/message" && row.type !== "user/message")
      || row.surfaceOp !== "append") continue;
    let answer;
    try {
      answer = parseEntryAnswer(textOf(row));
    } catch {
      continue;
    }
    if (lastLanded !== null) answers.set(lastLanded, { step: row.data?.step ?? null, answer });
  }
  // The proof burns, by the landed seq their same-seq replace covers. The
  // adapter carries the burn's `seq`, `recallId` and `target` but not its step;
  // the step is the replace row's own, and it is the caller's to state.
  const burns = new Map();
  for (const row of transcriptRows) {
    if (row.type !== "tool/result" || typeof row.surfaceOp !== "object") continue;
    if (row.surfaceOp.startSeq !== row.surfaceOp.endSeq) continue;
    if (!textOf(row).startsWith("[not retained]")) continue;
    burns.set(row.surfaceOp.startSeq, row.data.step);
  }
  const moments = momentsOf(loadRecord(recordDir));
  return {
    lane: "racoons",
    moments: moments.map(moment => ({
      ...moment,
      original: { ...moment.original, text: landed.get(moment.seq) },
      // The archive source the shaped turn's recall id is minted over. The
      // fixture's builder names it after the file; a live lane names it after
      // the result's node.
      source: { nodeId: `sim-result-${path.basename(moment.path)}` },
      ...(moment.record?.atRest === null || moment.record?.atRest === undefined ? {}
        : { record: { ...moment.record,
          atRest: { ...moment.record.atRest, step: burns.get(moment.seq) ?? null } } }),
    })),
    decisions: moments
      .filter(moment => answers.has(moment.seq))
      .map(moment => ({
        momentId: moment.id,
        step: answers.get(moment.seq).step,
        answer: answers.get(moment.seq).answer,
      })),
  };
}

/** The fixture converted once, its record memoized: every test reads one build. */
let cached = null;
function fixture() {
  if (cached !== null) return cached;
  const root = mkdtempSync(path.join(tmpdir(), "racoons-sim-render-"));
  try {
    const out = path.join(root, "out");
    const converted = spawnSync(process.execPath,
      [CONVERTER, "--manifest", path.join(FIXTURE, "manifest.json"), "--out", out],
      { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    const transcriptRows = readFileSync(TRANSCRIPT, "utf8")
      .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    cached = buildRecord(out, transcriptRows);
    return cached;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const expected = () => readJson(EXPORTED);
const shapedRows = rendered => rendered.rows.filter(row => row.shaped);
const isRefusal = code => error => error instanceof SimRenderRefusal && error.code === code;

/** The fixture's own shaped rows, keyed by seq, exactly as the transcript holds them. */
function transcriptShapedRows() {
  const rows = new Map();
  for (const row of readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean).map(JSON.parse)) {
    if (row.type !== "tool/result" || typeof row.surfaceOp !== "object") continue;
    if (row.surfaceOp.startSeq !== row.surfaceOp.endSeq) continue;
    const body = textOf(row);
    if (body.includes("[racoons] kept")) rows.set(row.surfaceOp.startSeq, body);
  }
  return rows;
}

// ---- the fixture's five terms --------------------------------------------

test("the record composes 7 moments and 5 decisions: four shaped and one keepall", () => {
  const record = fixture();
  assert.equal(record.moments.length, 7);
  assert.equal(record.decisions.length, 5);
  const byAction = record.decisions.reduce((counts, decision) => {
    counts[decision.answer.action] = (counts[decision.answer.action] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(byAction, { forgetlines: 3, forgetall: 1, keepall: 1 });
  const rendered = renderLane(record);
  assert.equal(rendered.shaped, 4);
  // The below-floor landed row is no moment, so it is not in the record at all.
  assert.equal(rendered.rows.filter(row => row.seq === 62).length, 0);
});

test("every shaped row's five terms equal the fixture's expected values", () => {
  const pins = expected();
  const rendered = renderLane(fixture());
  const shaped = shapedRows(rendered);
  const pinnedShaped = pins.moments.filter(moment =>
    moment.class === "forget-with-partials" || moment.class === "forget-all");
  assert.equal(shaped.length, pinnedShaped.length);
  for (const row of shaped) {
    const pin = pinnedShaped.find(moment => moment.seq === row.seq);
    assert.ok(pin !== undefined, `no pinned moment at seq ${row.seq}`);
    // The five terms, name by name, against the fixture's expected file.
    assert.equal(row.terms.kept, pin.keptBytes, `kept at seq ${row.seq}`);
    assert.equal(row.terms.markerBytes, pin.markerBytes, `markerBytes at seq ${row.seq}`);
    assert.equal(row.terms.summary, pin.summaryBytes, `summary at seq ${row.seq}`);
    assert.equal(row.terms.framing, pin.framingBytes, `framing at seq ${row.seq}`);
    assert.equal(row.terms.dropped, pin.droppedBytes, `dropped at seq ${row.seq}`);
    assert.equal(row.gaps, pin.gaps, `gaps at seq ${row.seq}`);
    // The identity closes in both directions, on the row's own numbers.
    assert.equal(row.terms.kept + row.gaps * row.terms.markerBytes + row.terms.summary
      + row.terms.framing, Buffer.byteLength(row.after, "utf8"),
      `the five-term identity does not close at seq ${row.seq}`);
    assert.equal(row.terms.kept + row.terms.dropped, row.beforeBytes,
      `kept + dropped is not the original at seq ${row.seq}`);
    // And the same five terms are the RECORD's own, read through the adapter.
    assert.equal(row.recordCheck?.match, true,
      `the record disagrees at seq ${row.seq}: ${JSON.stringify(row.recordCheck?.mismatched)}`);
    for (const term of TERM_NAMES) {
      assert.equal(row.terms[term], row.recordCheck.expected[term], `${term} vs record at ${row.seq}`);
    }
  }
});

test("the re-rendered shaped body is the transcript's own row, byte for byte", () => {
  const fromTranscript = transcriptShapedRows();
  const pins = expected();
  const rendered = renderLane(fixture());
  assert.equal(fromTranscript.size, shapedRows(rendered).length);
  for (const row of shapedRows(rendered)) {
    const body = fromTranscript.get(row.seq);
    assert.ok(body !== undefined, `the transcript holds no shaped row at seq ${row.seq}`);
    assert.equal(row.after, body, `the shaped body differs from the transcript at seq ${row.seq}`);
    const pin = pins.moments.find(moment => moment.seq === row.seq);
    assert.equal(row.afterSha256, pin.shapedSha256, `the shaped sha differs at seq ${row.seq}`);
    assert.equal(row.afterSha256, sha256Hex(body));
    // The marker the record names is the marker the renderer rendered.
    assert.equal(row.recallIdMatchesRecord, true,
      `the marker names another recall id at seq ${row.seq}: ${String(row.recallId)}`);
    assert.equal(row.recallId, pin.recallId);
  }
});

test("a keepall carries no shaped terms and rewrites nothing", () => {
  const rendered = renderLane(fixture());
  const row = rendered.rows.find(entry => entry.action === "keepall");
  assert.ok(row !== undefined, "the keepall moment is absent");
  assert.equal(row.shaped, false);
  assert.equal(row.termsBasis, "whole-body");
  assert.deepEqual(row.terms, { kept: null, markerBytes: 0, summary: 0, framing: null, dropped: 0 });
  assert.equal(row.after, row.before);
  assert.equal(row.afterSha256, row.beforeSha256);
  // A keepall moves the answer's step, never the bytes: no swap at all.
  assert.equal(row.decisionStep, 8);
  assert.equal(row.swapStep, null);
});

test("a keep-whole keeplines names every line, so it plans no shaped turn", () => {
  // ISSUE-141: the fire loop kept this row and the lane's final re-render refused
  // `sim-render-nothing-dropped`, so the run wrote no JSON.
  const body = Array.from({ length: 24 }, (_, at) => `row ${String(at + 1)}`).join("\n");
  const moment = { id: "result:101", lane: 8, seq: 1, step: 3, session: "session-141",
    original: { text: body } };
  const decision = { momentId: moment.id, step: 5,
    answer: { action: "keeplines", ranges: [{ from: 1, to: 24 }], summary: "all of it" } };

  const row = renderMoment(moment, decision);
  assert.equal(row.shaped, false, "a keep-whole row plans no shaped turn");
  assert.equal(row.termsBasis, "whole-body");
  assert.equal(row.action, "keeplines");
  assert.equal(row.decisionStep, 5, "the answer's own step is still recorded");
  assert.equal(row.swapStep, null, "it swaps no bytes");
  assert.equal(row.after, body, "the row stays exactly as landed");
  assert.equal(row.terms.dropped, 0, "it removes nothing");

  const lane = renderLane({ lane: 8, moments: [moment], decisions: [decision] });
  assert.equal(lane.shaped, 0, "no row is shaped");
  assert.equal(lane.decisions, 1, "the decision is carried, not dropped");
  assert.equal(lane.recallIdDrift, 0);

  // A partial keeplines is still a shaped turn, as before.
  const partial = renderMoment(moment, { ...decision,
    answer: { action: "keeplines", ranges: [{ from: 1, to: 23 }], summary: "most of it" } });
  assert.equal(partial.shaped, true);
  assert.ok(partial.terms.dropped > 0, "the one unnamed line is dropped");
});

test("the machinery row renders the receipt the transcript holds, from its own step", () => {
  const rendered = renderLane(fixture());
  const row = rendered.rows.find(entry => entry.machinery !== null);
  assert.ok(row !== undefined, "the machinery moment is absent");
  // Not a decision: no action, no shaped terms. It is censored, not scored.
  assert.equal(row.action, null);
  assert.equal(row.shaped, false);
  assert.equal(row.censored, "machinery-at-rest-removal");
  // The receipt is one line, and it is the transcript's own body for that seq.
  const burns = readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    .filter(entry => entry.type === "tool/result" && typeof entry.surfaceOp === "object"
      && entry.surfaceOp.startSeq === entry.surfaceOp.endSeq
      && textOf(entry).startsWith("[not retained]"));
  assert.equal(burns.length, 1);
  assert.equal(row.after, textOf(burns[0]));
  assert.equal(row.after.includes("\n"), false, "a proof receipt is one line");
  // It swaps at the burn's own step, never before, and the prefix carries it.
  assert.equal(row.swapStep, burns[0].data.step);
  assert.equal(prefixTextAt(rendered, row.swapStep).includes(row.after), false);
  assert.equal(prefixTextAt(rendered, row.swapStep + 1).includes(row.after), true);
  assert.equal(prefixTextAt(rendered, row.swapStep + 1).includes(row.before), false);
});

// ---- the prefix chain ----------------------------------------------------

test("a decision at step S is invisible at S and visible at S+1", () => {
  const record = fixture();
  const rendered = renderLane(record);
  // Each decision is compared with the SAME lane minus that one decision, so the
  // difference at S+1 is this decision's and not an earlier one's.
  const shapedDecisions = record.decisions.filter(decision =>
    rendered.rows.find(row => row.momentId === decision.momentId)?.shaped);
  assert.equal(shapedDecisions.length, 4);
  for (const decision of shapedDecisions) {
    const step = decision.step;
    const without = renderLane({
      ...record,
      decisions: record.decisions.filter(entry => entry !== decision),
    });
    assert.equal(prefixAt(rendered, step).prefixSha256, prefixAt(without, step).prefixSha256,
      `the decision at step ${step} is already visible at ${step}`);
    assert.notEqual(prefixAt(rendered, step + 1).prefixSha256,
      prefixAt(without, step + 1).prefixSha256,
      `the decision at step ${step} is not visible at ${step + 1}`);
    // Invisible means byte-equal, not merely hash-equal: the same prefix text.
    assert.equal(prefixTextAt(rendered, step), prefixTextAt(without, step));
  }
  // And for the FIRST decision, "the no-decision render" is literally the lane
  // with no decision at all: at its own step the two prefixes are the same.
  const first = shapedDecisions.reduce((earliest, decision) =>
    decision.step < earliest.step ? decision : earliest);
  assert.equal(prefixAt(rendered, first.step).prefixSha256,
    prefixAt(renderLane({ ...record, decisions: [] }), first.step).prefixSha256);
});

test("a decision's prefix at its own step is the no-decision prefix, byte for byte", () => {
  const record = fixture();
  const rendered = renderLane(record);
  const bare = renderLane({ ...record, decisions: [] });
  const firstStep = Math.min(...record.decisions.map(decision => decision.step));
  const atStep = prefixTextAt(rendered, firstStep);
  assert.equal(atStep, prefixTextAt(bare, firstStep));
  // And the shaped turn appears in the prefix the moment the next step opens.
  const swapped = rendered.rows.find(row => row.decisionStep === firstStep);
  assert.ok(swapped !== undefined);
  assert.ok(prefixTextAt(rendered, firstStep + 1).includes(swapped.after));
  assert.equal(prefixTextAt(rendered, firstStep + 1).includes(swapped.before), false);
});

test("the prefix at every step names its own hash and byte count", () => {
  const rendered = renderLane(fixture());
  assert.ok(rendered.steps.length >= 7, `only ${rendered.steps.length} observed steps`);
  for (const step of rendered.steps) {
    assert.equal(step.prefixSha256, sha256Hex(prefixTextAt(rendered, step.step)),
      `the step ${step.step} hash is not its prefix's`);
    assert.equal(step.prefixBytes, Buffer.byteLength(prefixTextAt(rendered, step.step), "utf8"));
  }
  assert.equal(rendered.final, rendered.steps[rendered.steps.length - 1]);
  // A step is total: before the first result the prefix is empty, and a step no
  // moment lands on is the prefix the step before it had.
  const firstLanded = Math.min(...rendered.rows.map(row => row.landedStep));
  assert.equal(prefixAt(rendered, firstLanded - 1).prefixSha256, sha256Hex(""),
    "the prefix before the first result is not empty");
  // A result landed AT a step is not yet in that step's prefix: the request
  // went out before the result existed.
  assert.equal(prefixAt(rendered, firstLanded).turns, 0);
  // One more than the last observed step repeats the final prefix.
  assert.equal(prefixAt(rendered, rendered.final.step + 1).prefixSha256,
    rendered.final.prefixSha256);
});

/**
 * One byte of one decision, changed: the last character of its summary. The
 * length is unchanged and exactly one byte differs, so the answer still parses
 * and still spans the same lines — only the note's bytes move.
 */
function flipOneSummaryByte(decision) {
  const clone = JSON.parse(JSON.stringify(decision));
  const summary = clone.answer.summary;
  assert.equal(typeof summary, "string");
  assert.ok(summary.length > 0, `the decision at step ${decision.step} carries no summary to flip`);
  const at = summary.length - 1;
  const replacement = summary[at] === "a" ? "b" : "a";
  clone.answer.summary = `${summary.slice(0, at)}${replacement}`;
  const before = Buffer.from(JSON.stringify(decision), "utf8");
  const after = Buffer.from(JSON.stringify(clone), "utf8");
  assert.equal(after.length, before.length, "the flip changed the decision's length");
  let differing = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) differing += 1;
  }
  assert.equal(differing, 1, `the flip changed ${differing} bytes, not one`);
  return clone;
}

test("flipping one byte of a decision moves every later prefix hash", () => {
  const record = fixture();
  const rendered = renderLane(record);
  const shapedDecisions = record.decisions.filter(decision =>
    rendered.rows.find(row => row.momentId === decision.momentId)?.shaped);
  assert.equal(shapedDecisions.length, 4);
  const lastStep = rendered.final.step;
  for (const decision of shapedDecisions) {
    const flipped = flipOneSummaryByte(decision);
    const after = renderLane({
      ...record,
      decisions: record.decisions.map(entry => (entry === decision ? flipped : entry)),
    });
    const step = decision.step;
    // Every prefix from S+1 on moves, out to the lane's last step.
    for (let at = step + 1; at <= lastStep; at += 1) {
      assert.notEqual(prefixAt(after, at).prefixSha256, prefixAt(rendered, at).prefixSha256,
        `the flipped decision at step ${step} left the prefix at ${at} unchanged`);
    }
    // Every prefix at or before S is untouched.
    for (let at = 0; at <= step; at += 1) {
      assert.equal(prefixAt(after, at).prefixSha256, prefixAt(rendered, at).prefixSha256,
        `the flipped decision at step ${step} moved the prefix at ${at}`);
    }
    // The rows the flip does not touch keep their bodies.
    for (const row of rendered.rows) {
      if (row.momentId === decision.momentId) {
        const changed = after.rows.find(entry => entry.momentId === row.momentId);
        assert.notEqual(changed.afterSha256, row.afterSha256,
          "the flipped decision produced the same body");
        continue;
      }
      assert.equal(after.rows.find(entry => entry.momentId === row.momentId).afterSha256,
        row.afterSha256, `the flip moved an unrelated body at seq ${row.seq}`);
    }
  }
});

test("a keepall moves no prefix hash at all", () => {
  const record = fixture();
  const keepall = record.decisions.find(decision => decision.answer.action === "keepall");
  assert.ok(keepall !== undefined, "the fixture carries no keepall decision");
  // The same lane with every OTHER decision and without the keepall: if the
  // keepall wrote bytes, one of these prefixes would move.
  const others = record.decisions.filter(decision => decision.answer.action !== "keepall");
  const withKeepall = renderLane({ ...record, decisions: [...others, keepall] });
  const without = renderLane({ ...record, decisions: others });
  const observed = [...new Set([...withKeepall.steps, ...without.steps]
    .map(step => step.step))].sort((left, right) => left - right);
  assert.ok(observed.length >= 7, `only ${observed.length} observed steps`);
  for (const step of observed) {
    assert.equal(prefixAt(withKeepall, step).prefixSha256, prefixAt(without, step).prefixSha256,
      `the keepall moved the prefix at step ${step}`);
  }
  // And its own row is the same body either way.
  const row = withKeepall.rows.find(entry => entry.momentId === keepall.momentId);
  assert.equal(row.after, row.before);
});

// ---- determinism and the CLI --------------------------------------------

test("the same record renders byte-identically twice", () => {
  const first = JSON.stringify(renderLane(fixture()));
  const second = JSON.stringify(renderLane(fixture()));
  assert.equal(first, second);
  assert.match(summaryOf(renderLane(fixture())), /^ {2}terms {8}0 shaped row\(s\) disagree/m);
});

test("the CLI renders the fixture's record and writes the same JSON to --out", () => {
  const record = fixture();
  const root = mkdtempSync(path.join(tmpdir(), "racoons-sim-render-cli-"));
  try {
    const file = path.join(root, "record.json");
    const out = path.join(root, "render.json");
    // Nothing reads or writes without --record, and a bad record is refused.
    const none = spawnSync(process.execPath, [path.join(HERE, "sim-render.mjs")], { encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /^usage: --record is required/);

    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const run = spawnSync(process.execPath,
      [path.join(HERE, "sim-render.mjs"), "--record", file, "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^ {2}moments {6}7$/m);
    assert.equal(readJson(out).final.prefixSha256, renderLane(record).final.prefixSha256);

    writeFileSync(file, "{not a record}\n");
    const bad = spawnSync(process.execPath,
      [path.join(HERE, "sim-render.mjs"), "--record", file], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /^sim-render-record-unreadable: /);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a decision that states no step derives it from its own result: step plus one", () => {
  const record = fixture();
  // ISSUE-074 scheme A: the answer row is a `user/message` and states no step.
  // The renderer derives the decision's step from the moment it decides — the
  // result's own step plus one — and derives the SAME step twice.
  const stripped = record.decisions.map(decision => {
    const { step, ...rest } = decision;
    assert.ok(Number.isSafeInteger(step));
    return rest;
  });
  const rendered = renderLane({ ...record, decisions: stripped });
  assert.equal(rendered.decisions, record.decisions.length);
  for (const decision of record.decisions) {
    const row = rendered.rows.find(entry => entry.momentId === decision.momentId);
    const moment = record.moments.find(entry => entry.id === decision.momentId);
    assert.equal(row.decisionStep, moment.step + 1,
      `${decision.momentId}: the derived step is not its result's step plus one`);
  }
  // Deriving is not re-deciding: every body and every shaped term is the same
  // as the render with stated steps.
  const stated = renderLane(record);
  assert.deepEqual(
    rendered.rows.map(row => [row.momentId, row.afterSha256, row.shaped]),
    stated.rows.map(row => [row.momentId, row.afterSha256, row.shaped]));
  // Deterministic: the same step-less record renders byte-identically twice.
  assert.equal(JSON.stringify(renderLane({ ...record, decisions: stripped })),
    JSON.stringify(rendered));
});

test("a step-less decision naming no moment is refused by name, never derived", () => {
  const record = fixture();
  const stripped = record.decisions.map(({ step, ...rest }) => rest);
  const [first] = stripped;
  assert.throws(
    () => renderLane({ ...record, decisions: [{ ...first, momentId: "unit:sha256:nope" }] }),
    isRefusal("sim-render-moment-unknown"));
  // A decision that STATES a step keeps the refusal it always had, whatever the
  // store shape.
  assert.throws(() => renderMoment(record.moments[0], { ...first, step: 0 }),
    isRefusal("sim-render-decision-invalid"));
  assert.throws(() => renderMoment(record.moments[0], { ...first, step: 1.5 }),
    isRefusal("sim-render-decision-invalid"));
  // A decision on a moment that stands at a later step still derives to that
  // moment's own step plus one, so a step-less decision can never precede its
  // own result; the earlier-step refusal stays a stated-step one.
  const later = record.moments.find(entry => entry.step > 1);
  assert.throws(() => renderLane({ ...record,
    decisions: [{ ...first, momentId: later.id, step: later.step - 1 }] }),
  isRefusal("sim-render-step-before-moment"));
  const derived = renderMoment(later, { ...first, momentId: later.id });
  assert.equal(derived.decisionStep, later.step + 1);
});

// ---- refusals: a decision that cannot apply is named, never half-applied --

test("a decision that cannot apply is refused by name", () => {
  const record = fixture();
  const shaped = record.decisions.find(decision => decision.answer.action === "forgetlines");
  // A moment whose own step is past 1, so "one step earlier" is still a step.
  const later = record.moments.find(entry => entry.step > 1);
  assert.ok(later !== undefined);
  const render = decisions => () => renderLane({ ...record, decisions });

  assert.throws(render([{ ...shaped, momentId: "unit:sha256:nope" }]),
    isRefusal("sim-render-moment-unknown"));
  assert.throws(render([shaped, shaped]), isRefusal("sim-render-duplicate-decision"));
  assert.throws(render([{ ...shaped, momentId: later.id, step: later.step - 1 }]),
    isRefusal("sim-render-step-before-moment"));
  assert.throws(render([{ ...shaped, answer: { action: "keephead", ranges: [] } }]),
    isRefusal("sim-render-decision-invalid"));
  assert.throws(render([{ ...shaped, answer: { action: "forgetlines", summary: "x" } }]),
    isRefusal("sim-render-span-invalid"));
  assert.throws(render([{ ...shaped, answer: { action: "forgetlines", ranges: [{ from: 1, to: 99999 }], summary: "x" } }]),
    isRefusal("sim-render-span-outside-result"));
  // Naming every line of a body is a forgetall, never a forgetlines: the
  // complement is empty and the planner would carry no marker.
  const bodyLines = splitLineOffsets(Buffer.from(
    record.moments.find(entry => entry.id === shaped.momentId).original.text, "utf8")).length;
  assert.throws(render([{
    ...shaped,
    answer: {
      action: "forgetlines",
      ranges: [{ from: 1, to: bodyLines }],
      summary: "every line",
    },
  }]), isRefusal("sim-render-keeps-nothing"));
  const machinery = record.moments.find(entry =>
    entry.provenance?.censoredClass === "machinery-at-rest-removal");
  assert.ok(machinery !== undefined);
  assert.throws(render([{ momentId: machinery.id, step: machinery.step + 1,
    answer: shaped.answer }]), isRefusal("sim-render-censored-decision"));
});

test("a machinery row without a stated step keeps the landed body and says so", () => {
  const record = fixture();
  const machinery = record.moments.find(entry =>
    entry.provenance?.censoredClass === "machinery-at-rest-removal");
  assert.ok(machinery !== undefined);
  const bare = renderMoment({ ...machinery,
    record: { ...machinery.record, atRest: { ...machinery.record.atRest, step: null } } });
  assert.equal(bare.swapStep, null, "a burn with no stated step claims one");
  assert.equal(bare.after, bare.before, "a burn with no stated step still swapped the body");
  assert.equal(bare.recallId, machinery.record.atRest.recallId);
  // And a burn whose stated step precedes its own result is refused.
  assert.throws(() => renderMoment({ ...machinery,
    record: { ...machinery.record,
      atRest: { ...machinery.record.atRest, step: machinery.step - 1 } } }),
  isRefusal("sim-render-moment-invalid"));
});

test("a decision on the at-rest proof burn is refused: that removal has no answer", () => {
  const record = fixture();
  const machinery = record.moments.find(entry =>
    entry.provenance?.censoredClass === "machinery-at-rest-removal");
  assert.throws(() => renderLane({ ...record, decisions: [{
    momentId: machinery.id,
    step: machinery.step + 1,
    answer: { action: "forgetall", summary: "a burn takes no answer" },
  }] }), isRefusal("sim-render-censored-decision"));
});

test("a moment whose bytes are absent or disagree are refused by name", () => {
  const record = fixture();
  const moment = record.moments[0];
  assert.throws(() => renderMoment({
    ...moment, original: { sha256: moment.original.sha256 },
  }), isRefusal("sim-render-body-absent"));
  assert.throws(() => renderMoment({
    ...moment, original: { ...moment.original, sha256: "0".repeat(64) },
  }), isRefusal("sim-render-original-sha-mismatch"));
  assert.throws(() => renderLane({ ...record, moments: [] }), isRefusal("sim-render-no-moments"));
  assert.throws(() => renderLane({ moments: [moment, moment], decisions: [] }),
    isRefusal("sim-render-duplicate-moment"));
  assert.throws(() => prefixAt({ rows: null }, 1), isRefusal("sim-render-record-invalid"));
  assert.throws(() => prefixAt(renderLane({ ...record, decisions: [] }), -1),
    isRefusal("sim-render-step-invalid"));
});
