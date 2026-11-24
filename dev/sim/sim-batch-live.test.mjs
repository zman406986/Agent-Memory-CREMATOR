#!/usr/bin/env node
/**
 * The live-ask runner's gate (batch-trigger simulation, chunk 4).
 *
 * Run: `node --test dev/sim/sim-batch-live.test.mjs`
 *
 * Nothing here opens a socket: the transport is the stub, and the one
 * end-to-end case runs the script with `--transport stub`. The real-transcript
 * cases SKIP when their world is absent, naming both missing paths
 * (`scratchpad/` is disposable by law): the default is the 2026-10-29 fab6632e
 * world, which carries the agent's reasoning (ADR-0045), and the older pair-2
 * shapes are named explicitly. With the world present every case runs, and no
 * pinned check is deleted. Every
 * spawn states the host pruner with `--ignore-host-prunes` or
 * `--allow-host-pruner` (ADR-0041); a lane that states neither refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_ASK_CLOSING_LINE, entryAskFactsBlock, parseEntryBatchAnswer } from "@cremator/core";
import {
  DEFAULT_TRANSCRIPT, DEFAULT_USAGE, PRODUCT_BATCH_SIZE, SEGMENT_PINS, SimBatchUnitsRefusal,
  CHECK_CLASSES,
  askRowsOf, assertAskScope, assertReasoningCarried, applyFireToSurface, contextStandInOf,
  depthsInSegment,
  droppedRowGapsOf, measuredTokensOf, netDroppedOf, readTimeline, readUsage, sessionFileIn,
  simulateSurface, surfaceAt, surfaceDepthAt, surfaceDigestOf, thresholdLane,
} from "./sim-batch-units.mjs";
import {
  BAND_DRIFT_RATIO, CALL_TIMEOUT_MS, CITABLE_REASONS, CONTENT_STORE_LIMIT_BYTES,
  DEFAULT_ASK_CEILING, DEFAULT_KILL_MS,
  FORBIDDEN_FIELDS, GROSS_BAND_RATIO, ROUTE,
  RULER_BYTES_PER_TOKEN_MAX, RULER_BYTES_PER_TOKEN_MIN,
  anchorDepthOf, arithmeticRefusalOf,
  armKillTimer, assertBatchInPrompt, assertCarriedOverrides, assertCarrySetMatches,
  assertReasonsAllowed, assertRequestShape, assertSurfaceAdvanced, batchCorrectionMessageOf,
  checkOutcomesOf, citableReasonsOf, classifyStream, contentFieldsOf, contextTurnsOf,
  correctionCodesOf, deepseekKey, distributionOf, factsOf, firstSendRulerOf, inputDeviationsOf,
  partialResultOf, predictPromptTokensOf, promptOf, providerBandOf, readStreamFrames,
  reconstructedSurfaceOf, recordingHostPrunerState, requestBodyOf, refusedAnswerOf,
  runLane as runLaneRaw,
  INLINE_TABLE_GRAMMAR, inlineAnswerMixOf, inlineAppendOf, inlineArmHeadlineOf,
  inlineCanonicalMessages, inlineCommonStopOf, inlineCompareOf, inlineHostAfter,
  inlineLedgerOf, inlineShapedTurnDeltaOf, runInlineArms, runInlineAskArm,
  runTableOnlyArm,
  stubInlineAnswerOf,
  stubAnswerOf, stubTransport, summaryLineOf, tokenDepthOf, tokenRulerRecordOf,
  twoPointRulerOf, wireDetailsOf, withReasoningBoundary, writeResultArtifact,
} from "./sim-batch-live.mjs";
import {
  INLINE_FLOOR_BYTES, INLINE_MARKER, INLINE_REBUILD_TOKENS, parseInlineAnswer,
} from "./sim-inline-ask.mjs";
import { answerRowsOf, jsonl20RowsOf } from "./sim-batch-grammar.mjs";
import { renderMoment } from "./sim-render.mjs";

const SCRIPT = fileURLToPath(new URL("./sim-batch-live.mjs", import.meta.url));
/** The committed fixture the inline lane runs on; no scratchpad world needed. */
const INLINE_FIXTURE = fileURLToPath(new URL(
  "../bench/fixtures/sim/sim.reasoning.session.v4.jsonl", import.meta.url));
const INLINE_USAGE = fileURLToPath(new URL(
  "../bench/fixtures/sim/sim.reasoning.result.json", import.meta.url));
/** The second committed cut: a pruner-on recording replayed as a reconstruction. */
const INLINE_PRUNES_FIXTURE = fileURLToPath(new URL(
  "../bench/fixtures/sim/sim.prunes.session.v4.jsonl", import.meta.url));
const HAVE_EVIDENCE = existsSync(DEFAULT_TRANSCRIPT) && existsSync(DEFAULT_USAGE);

/**
 * A synthetic transcript declares no `step/start` boundary — its rows carry
 * `data.step` — so a depth series over it has no step to pin to and
 * `assertUsageStepsPinned` refuses it (P3). A real recording declares one
 * `step/start` per request, so this adds one per depth step the synthetic rows
 * do not already declare, at a seq AFTER every real row: `stepAtSeq` only walks
 * forward, so no row's owning step moves, and each depth reading is pinned to a
 * declared step exactly as the recording's own series is.
 */
const withStepStarts = (rows, depths) => {
  if (!Array.isArray(rows) || !Array.isArray(depths) || depths.length === 0) return rows;
  const declared = new Set(rows.filter(row => row?.type === "step/start")
    .map(row => row.data?.step));
  const missing = [...new Set(depths.map(entry => entry.step))]
    .filter(step => !declared.has(step));
  if (missing.length === 0) return rows;
  let seq = rows.reduce((max, row) =>
    (Number.isSafeInteger(row?.seq) ? Math.max(max, row.seq) : max), 0);
  return [...rows, ...missing.map(step =>
    ({ type: "step/start", seq: (seq += 1), data: { step } }))];
};

/** `runLane` with the synthetic step declarations every row-array call needs. */
const runLane = options => (options !== null && typeof options === "object"
  && Array.isArray(options.transcript)
  ? runLaneRaw({ ...options, transcript: withStepStarts(options.transcript, options.depths) })
  : runLaneRaw(options));

/**
 * A test that CLAIMS the pinned world SKIPS when its evidence is missing, with
 * a reason that names both missing paths. A clean checkout cannot reproduce the
 * pinned values (`scratchpad/` is disposable by law), so it skips loudly
 * instead of passing by doing nothing. With the world present every check runs
 * normally. Returns false when it skipped.
 */
const requirePinnedWorld = t => {
  if (HAVE_EVIDENCE) return true;
  t.skip("the pinned fab6632e world is absent ("
    + `${DEFAULT_TRANSCRIPT} / ${DEFAULT_USAGE}); set CREMATOR_SIM_EVIDENCE to the`
    + " world's root and re-run — a clean checkout skips this pinned check; it cannot"
    + " reproduce the pinned values from the repo");
  return false;
};

/**
 * The 2026-10-30 pair-2 vanilla world, named explicitly. It carries no reasoning
 * (ADR-0045 voids its numbers as evidence); the cases below keep it only where
 * they pin its host-trim shapes (segment 146, 266 eligible, peak depth 320,637).
 * `--allow-host-pruner` is ADR-0041's stated choice for that vanilla arm. Its
 * session file is FOUND under the world root, so the host's workspace label
 * (`C-Users-AAAAA-…` / `C-Users-AA-…`) is never rebuilt here.
 */
const PAIR2_WORLD = fileURLToPath(new URL(
  "../../scratchpad/bench/2026-10-30-repeat-pairs/pair-2/worlds/vanilla", import.meta.url));
const PAIR2_TRANSCRIPT = sessionFileIn(PAIR2_WORLD)
  ?? path.join(PAIR2_WORLD, "evidence", "sessions", "ABSENT-session.v4.jsonl");
const PAIR2_USAGE = path.join(PAIR2_WORLD, "evidence", "result.json");
const HAVE_PAIR2 = existsSync(PAIR2_TRANSCRIPT) && existsSync(PAIR2_USAGE);
/** The arguments every pair-2 spawn states: its input, and the pruner it replayed. */
// The pair-2 session declares 0 reasoning; ADR-0045 makes every run on it a
// VOID comparison, so the spawns must declare that explicitly (the run then
// records `citable: false` and the zero-reasoning reason).
const PAIR2_ARGS = ["--transcript", PAIR2_TRANSCRIPT, "--usage", PAIR2_USAGE,
  "--allow-host-pruner", "--allow-zero-reasoning", "--segment", "146"];

test("the key is read in-process from the refs block, and only 'found' is reported", () => {
  const home = mkdtempSync(path.join(tmpdir(), "sim-live-key-"));
  try {
    const dir = path.join(home, ".dsh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".credentials.yaml"),
      "version: 1\nrecords:\n  other:\n    secret: nope\nrefs:\n  DEEPSEEK_API_KEY: sk-test-value\n");
    const found = deepseekKey(home);
    assert.equal(found.key, "sk-test-value");
    assert.equal(found.source, path.join(dir, ".credentials.yaml"));
    assert.equal(deepseekKey(path.join(home, "absent")).key, null);
    const noKey = path.join(home, "nokey", ".dsh");
    mkdirSync(noKey, { recursive: true });
    writeFileSync(path.join(noKey, ".credentials.yaml"), "refs:\n  A6_API_KEY: other\n");
    assert.deepEqual(deepseekKey(path.dirname(noKey)), { key: null, source: "missing-in-file" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prompt packing sends EVERY turn: nothing is trimmed", () => {
  const turn = (text) => ({ role: "user", text });
  const turns = [turn("a".repeat(4000)), turn("b".repeat(4000)), turn("c".repeat(400))];
  const packed = promptOf({ system: "sys", ask: "ask", turns });
  assert.equal(packed.contextTurns, 3, "all three turns stay, oldest included");
  assert.equal(packed.messages[1].content, "a".repeat(4000));
  assert.equal(packed.messages[packed.messages.length - 1].content, "ask");
  assert.equal(packed.estimatedTokens, packed.fixedTokens + packed.contextTokens,
    "the estimate counts every turn");
});

test("the stub's answer parses: keep, forget, and one missing key refuses", () => {
  const indices = [1, 2, 3, 4];
  const parsed = parseEntryBatchAnswer(stubAnswerOf(indices, 0, "3option"), indices, "3option");
  const distribution = distributionOf(parsed, indices.map(index => ({ id: `result:${index}` })));
  assert.equal(distribution.keep + distribution.forget + distribution.refused, 4);
  assert.ok(distribution.forget > 0);
  const withMissing = parseEntryBatchAnswer(stubAnswerOf(indices, 1, "3option"), indices,
    "3option");
  const refused = distributionOf(withMissing, indices.map(index => ({ id: `result:${index}` })));
  assert.equal(refused.refused, 1, "the omitted last index is refused, not invented");
  assert.equal(refused.rows[refused.rows.length - 1].code !== undefined, true);
});

test("the jsonl-20 stub answers one object per row, keyed by the row's own index", () => {
  // A sparse, non-1..N index list: a hardcoded guess would answer the wrong rows.
  const indices = [3, 17, 42, 51, 64];
  const text = stubAnswerOf(indices, 0, "jsonl-20");
  const lines = text.split("\n");
  assert.equal(lines.length, indices.length, "one line per row");
  assert.equal(new Set(lines).size, lines.length, "every row is answered exactly once");
  assert.deepEqual(lines.map(line => Object.keys(JSON.parse(line))),
    indices.map(index => [String(index)]), "each line is a single-key object with that row's index");
  assert.deepEqual(JSON.parse(lines[0])["3"], { keepall: true },
    "a keepall line carries nothing else");
  assert.deepEqual(JSON.parse(lines[1])["17"],
    { forgetall: true, summary: "stub forgotten result 17" },
    "a forgetall line carries the flag and a short summary, as the prompt teaches");
  const rows = jsonl20RowsOf(text, indices);
  assert.equal(rows.filter(row => row.status !== "answered").length, 0, "zero refusals");
  assert.deepEqual(rows.map(row => row.index), indices, "the ask's own order comes back");
  assert.deepEqual(rows.map(row => row.answer.action),
    ["keepall", "forgetall", "forgetall", "forgetall", "keepall"], "every fourth row keeps");
  assert.deepEqual(JSON.parse(lines[4])["64"], { keepall: true },
    "the fifth row keeps: the pattern follows table position, not the index value");
  // The grammar name is the only switch: the default call is still the 3option object.
  assert.notEqual(text, stubAnswerOf(indices, 0, "3option"));
});

test("the jsonl-20 reader refuses one stray-key row, not the 25-row answer (ISSUE-187)", () => {
  // The live r2 shape: 25 lines back, one carrying a stray second top-level key.
  // The reader is per row, so 24 verdicts still apply and only that row keeps.
  const indices = Array.from({ length: 25 }, (_, at) => at + 1);
  const text = indices.map(index => (index === 2
    ? '{"2":{"forgetall":true,"summary":"stale build log"},"keepall":false}'
    : `{"${index}":{"keepall":true}}`)).join("\n");
  const rows = jsonl20RowsOf(text, indices);
  assert.equal(rows.filter(row => row.status === "answered").length, 24,
    "the 24 well-formed lines still apply");
  assert.deepEqual(rows[1], { index: 2, status: "refused", code: "mixed-keys" },
    "the stray-key row is refused and kept, never applied beside its extra key");
  // A line that does not parse still names its own row through its leading key.
  const unclosed = jsonl20RowsOf('{"1":{"keepall":true}}\n{"2":{"keepall":true}\n'
    + '{"3":{"keepall":true}}', [1, 2, 3]);
  assert.deepEqual(unclosed.map(row => [row.status, row.code ?? null]),
    [["answered", null], ["refused", "answer-unreadable"], ["answered", null]]);
});

test("the 3option and two-option stub output is the pre-change bytes, byte for byte", () => {
  // These strings were captured from stubAnswerOf BEFORE the jsonl-20 branch
  // existed; the default call and every assembled-object grammar must still match.
  const cases = [
    { indices: [1, 2, 3, 4], ask: 0,
      text: '{"1":{"keepall":true},"2":{"forgetall":"stub forgotten result 2"},'
        + '"3":{"forgetall":"stub forgotten result 3"},"4":{"forgetall":"stub forgotten result 4"}}' },
    { indices: [3, 17, 42], ask: 1,
      text: '{"3":{"keepall":true},"17":{"forgetall":"stub forgotten result 17"}}' },
    { indices: [1], ask: 0, text: '{"1":{"keepall":true}}' },
    { indices: [1], ask: 1, text: "{}" },
    { indices: [2, 5, 9, 12, 13], ask: 2,
      text: '{"2":{"keepall":true},"5":{"forgetall":"stub forgotten result 5"},'
        + '"9":{"forgetall":"stub forgotten result 9"},"12":{"forgetall":"stub forgotten result 12"},'
        + '"13":{"keepall":true}}' },
  ];
  for (const { indices, ask, text } of cases) {
    assert.equal(stubAnswerOf(indices, ask, "3option"), text, "the explicit id is the old bytes");
    assert.equal(stubAnswerOf(indices, ask, "two-option"), text,
      "two-option still receives the shipped assembled object");
    assert.equal(stubAnswerOf(indices, ask, "forgetlines"), text);
    assert.equal(stubAnswerOf(indices, ask, "keeplines-60"), text);
  }
  const indices = [1, 2, 3, 4];
  const twoOption = answerRowsOf(stubAnswerOf(indices, 0, "two-option"), indices, "two-option");
  assert.equal(twoOption.filter(row => row.status !== "answered").length, 0,
    "two-option reads the unchanged bytes with zero refusals");
});

test("a jsonl-20 stub lane answers every row: zero refusals, forgets applied", async () => {
  const transcript = [{ type: "session", id: "session-jsonl-20-stub" },
    lineRow(1, 1), lineRow(2, 3)];
  const depths = [[1, 1000], [2, 1500], [3, 2000]]
    .map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 2, mode: "batch", floor: 100,
    allowZeroReasoning: true,
    grammar: "jsonl-20", transport: stubTransport(), askCeiling: 1,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 1, "one fire");
  const record = records[0];
  assert.equal(record.batchSize, 2);
  assert.deepEqual(record.rows.map(row => row.status), ["answered", "answered"]);
  assert.deepEqual(record.rows.map(row => row.action), ["keepall", "forgetall"]);
  assert.equal(record.firstPass.refused, 0, "the stub speaks jsonl-20");
  assert.equal(record.distribution.refused, 0);
  assert.equal(record.correction, null, "jsonl-20 answers no arithmetic, so no correction");
  assert.equal(record.appliedForgets, 1, "the forgetall line shapes one row");
  assert.ok(summary.bytesFreedByPolicy > 0, "the forgetall line frees real bytes");
});

test("every send records the whole answer: text, sha256, 400-byte head and tail", () => {
  const text = `{"1":{"forgetall":"x"}}${"y".repeat(2000)}`;
  const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
  const fields = contentFieldsOf(text);
  assert.equal(fields.contentBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(fields.contentText, text, "the WHOLE answer is stored, not a slice");
  assert.equal(fields.contentSha256, sha256(text), "the hash is over the whole answer");
  assert.equal(fields.answerTruncated, false);
  assert.equal(Buffer.byteLength(fields.contentHead, "utf8"), 400, "the head is exactly 400 bytes");
  assert.equal(Buffer.byteLength(fields.contentTail, "utf8"), 400, "the tail is exactly 400 bytes");
  assert.equal(fields.contentHead, text.slice(0, 400));
  assert.equal(fields.contentTail, text.slice(-400));
  const small = contentFieldsOf('{"1":{"keepall":true}}');
  assert.equal(small.contentBytes, 22);
  assert.equal(small.contentText, '{"1":{"keepall":true}}');
  assert.equal(small.contentHead, small.contentTail, "a short answer is its own head and tail");
  const empty = contentFieldsOf(undefined);
  assert.equal(empty.contentBytes, 0);
  assert.equal(empty.contentText, "", "a timeout records empty text, not a guess");
  assert.equal(empty.contentSha256, sha256(""));
  assert.equal(empty.answerTruncated, false);
  assert.equal(empty.contentHead, "");
  assert.equal(empty.contentTail, "");
  // Fourteenth audit item 1: a LONG answer keeps its full text up to 256 KiB,
  // says it was cut, keeps both ends, and its hash still commits to every byte
  // of the answer — not merely to the stored prefix.
  const long = "z".repeat(CONTENT_STORE_LIMIT_BYTES + 1234);
  const capped = contentFieldsOf(long);
  assert.equal(capped.answerTruncated, true);
  assert.equal(capped.contentBytes, long.length);
  assert.equal(Buffer.byteLength(capped.contentText, "utf8"), CONTENT_STORE_LIMIT_BYTES,
    "the stored text is cut at exactly 256 KiB");
  assert.equal(capped.contentText, long.slice(0, CONTENT_STORE_LIMIT_BYTES));
  assert.equal(capped.contentSha256, sha256(long),
    "the hash names the whole answer, including the bytes the record did not keep");
  assert.equal(capped.contentHead, long.slice(0, 400));
  assert.equal(capped.contentTail, long.slice(-400), "a capped answer keeps its tail");
  const atCap = contentFieldsOf("z".repeat(CONTENT_STORE_LIMIT_BYTES));
  assert.equal(atCap.answerTruncated, false, "exactly the cap is not truncated");
  assert.equal(atCap.contentText.length, CONTENT_STORE_LIMIT_BYTES);
  // A 3-byte character can be split by the 400-byte cut; the slice is on BYTES.
  const wide = "€".repeat(300);
  const cut = contentFieldsOf(wide);
  assert.equal(cut.contentBytes, 900);
  assert.equal(cut.contentText, wide);
  assert.ok(wide.startsWith(cut.contentHead.replace(/\uFFFD$/, "")), "the head is a prefix");
  assert.ok(wide.endsWith(cut.contentTail.replace(/^\uFFFD/, "")), "the tail is a suffix");
});

test("a send record carries the answer text a reader can re-read", async () => {
  // Fourteenth audit item 1: the parsed rows and freed bytes derive from the
  // answer, so the record hands back the answer itself (and its hash), not only
  // a 400-byte head. This transport's answer is longer than head + tail.
  const big = Array.from({ length: 24 }, () => "z".repeat(33)).join(" ");
  const answer = JSON.stringify({
    1: { forgetall: big },
    2: { keepall: true },
  });
  assert.ok(answer.length > 800, "the fixture is longer than head + tail");
  const transport = { name: "whole-answer", live: false,
    ask: async () => ({ ok: true, httpStatus: null, latencyMs: 0, content: answer,
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) };
  const records = [];
  await runLane({ transcript: [{ type: "session", id: "s-whole-answer" },
    lineRow(1, 1), lineRow(2, 2)], depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }],
  lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
  transport, askCeiling: 1, grammar: "3option",
  deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  const record = records[0];
  assert.equal(record.contentText, answer, "the record hands back the whole answer");
  assert.equal(record.contentSha256,
    createHash("sha256").update(answer, "utf8").digest("hex"));
  assert.equal(record.answerTruncated, false);
  assert.equal(record.contentBytes, Buffer.byteLength(answer, "utf8"));
});

test("the [summary] line prints all five exclusion counts, non-text included", async () => {
  // Fourteenth audit item 2: the README said five counts, the console printed
  // four — `nonTextContent` never reached the line. An image-only tool result
  // makes the count non-zero, so the test names a real exclusion, not a zero.
  const imageRow = { type: "tool/result", seq: 2,
    data: { step: 2, content: [{ type: "image", source: { type: "base64", data: "" } }] } };
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ transcript: [{ type: "session", id: "s-summary-line" },
    systemRow(), lineRow(1, 1), imageRow],
  depths: [{ step: 1, tokens: 100 }, { step: 2, tokens: 200 }],
  lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
  transport, askCeiling: 2, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.eligibility.excluded.nonTextContent, 1,
    "the image-only result is the non-text exclusion");
  const line = summaryLineOf(summary,
    { askCeiling: 2, semantics: "incremental", firstFireDepth: null });
  assert.match(line, /\[summary\]/);
  assert.match(line,
    /excluded 0 unreadable-content, 1 non-text-content, 0 below-floor, 0 error-result/,
    "the line prints the non-text count between unreadable-content and below-floor");
  assert.ok(line.includes(` ${String(summary.eligibility.excluded.noTwoQuotes)} no-two-quotes`),
    "and the fifth count is still there");
});

test("a refused row keeps the wire code the batch mapping drops", () => {
  const malformed = '{"1":{"keeplines":[[0,5],"s"]}}';
  const parsed = parseEntryBatchAnswer(malformed, [1], "3option");
  const row = distributionOf(parsed, [{ id: "result:1" }],
    wireDetailsOf(malformed, [1], "3option")).rows[0];
  assert.equal(row.code, "malformed-row", "the coarse code batch-ask keeps");
  assert.equal(row.wireCode, "invalid-span", "the wire code batch-ask drops is recovered");
  assert.match(row.message, /span is a \[start,end\] pair/);
  const unreadable = distributionOf(
    parseEntryBatchAnswer("not json", [1], "3option"), [{ id: "result:1" }],
    wireDetailsOf("not json", [1], "3option")).rows[0];
  assert.equal(unreadable.code, "answer-unreadable");
  assert.equal(unreadable.wireCode, null, "a whole-text parse failure has no wire code");
  const plain = distributionOf(parseEntryBatchAnswer("{}", [1], "3option"), [{ id: "result:1" }]).rows[0];
  assert.equal(plain.code, "missing-index");
  assert.equal(plain.wireCode, null, "no detail map still records the field, never a guess");
});

test("facts and context turns follow the transcript's own rows", () => {
  const facts = factsOf("one\ntwo\nthree\n");
  assert.equal(facts.lineCount, 3);
  const rows = [
    { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "hi" }] } },
    { type: "tool/result", seq: 2, data: { message: { content: [{ type: "text", text: "body" }] } } },
    { type: "assistant/message", seq: 3, data: { message: { content: [{ type: "text", text: "ok" }] } } },
    { type: "user/message", seq: 9, data: { content: [{ type: "text", text: "later" }] } },
  ];
  const turns = contextTurnsOf(rows, 3);
  assert.deepEqual(turns.map(turn => turn.role), ["user", "user", "assistant"]);
  assert.match(turns[1].text, /^Tool result:\nbody$/);
  assert.equal(contextTurnsOf(rows, 9).length, 4, "the seq filter is inclusive");
});

test("a positive kill timer stamps the armed record before any request", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-kill-"));
  try {
    const stamp = path.join(out, "kill-timer-armed.txt");
    const armed = armKillTimer({ armedMs: 600_000, outDir: out });
    const text = readFileSync(stamp, "utf8");
    assert.match(text, /^kill-timer-armed 600000 ms at .* fires .* pid \d+\n$/);
    assert.equal(armed.armedMs, 600_000);
    assert.equal(armed.timer, "armed");
    assert.ok(Date.parse(armed.firesAt) > Date.parse(armed.armedAt));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("kill timer 0 is OFF: no stamp, no timer, and the record says so", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-kill-off-"));
  try {
    const armed = armKillTimer({ armedMs: 0, outDir: out });
    assert.equal(armed.armedMs, 0);
    assert.equal(armed.timer, "off");
    assert.equal(armed.firesAt, null);
    assert.equal(existsSync(path.join(out, "kill-timer-armed.txt")), false,
      "an off timer must not claim it was armed");
    assert.equal(existsSync(path.join(out, "kill-timer-fired.txt")), false);
    for (const bad of [-1, 1.5]) {
      assert.throws(() => armKillTimer({ armedMs: bad, outDir: out }), error =>
        error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-kill-invalid");
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the runner's default caps are OFF: ask ceiling 0 and kill timer 0", () => {
  // Owner ruling 2026-11-08: the token budget is the only run cap.
  assert.equal(DEFAULT_ASK_CEILING, 0);
  assert.equal(DEFAULT_KILL_MS, 0);
});

test("without --i-am-the-owner nothing is read or sent", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--transport", "stub"],
    { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-live-owner-required/);
});

test("a lane that does not state the host pruner refuses by name", async () => {
  // ADR-0041: the pruner's state is a stated choice, never a silent default.
  const transcript = [{ type: "session", id: "session-pruner-stated" }, lineRow(1, 1)];
  const depths = [[1, 1000], [2, 2000]].map(([step, tokens]) => ({ step, tokens }));
  await assert.rejects(runLane({ transcript, depths, lane: 1, mode: "batch", floor: 100,
    transport: stubTransport(), askCeiling: 1, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-host-pruner-unstated");
  const unstated = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--transport", "stub", "--ask-ceiling", "1"], { encoding: "utf8" });
  assert.equal(unstated.status, 2);
  assert.match(unstated.stderr, /sim-batch-host-pruner-unstated/);
  const both = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--transport", "stub", "--ignore-host-prunes", "--allow-host-pruner"], { encoding: "utf8" });
  assert.equal(both.status, 2);
  assert.match(both.stderr, /sim-batch-host-pruner-unstated/);
});

test("a reconstruction cannot run with the host pruner on", async () => {
  // Twelfth audit item 6: the two declarations state opposite worlds; the run
  // used to record `reconstruction: true` beside `modeledHostPruner: "on"`.
  const transcript = [{ type: "session", id: "session-reconstruction-on" }, lineRow(1, 1)];
  const depths = [[1, 1000], [2, 2000]].map(([step, tokens]) => ({ step, tokens }));
  await assert.rejects(runLane({ transcript, depths, lane: 1, mode: "batch", floor: 100,
    ignoreHostPrunes: false, reconstruction: true, transport: stubTransport(), askCeiling: 1,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-reconstruction-host-pruner");
  const cli = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
    "--allow-host-pruner", "--reconstruction"], { encoding: "utf8" });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /sim-batch-reconstruction-host-pruner/);
  // The legal pairing still passes the gate: pruner off + reconstruction.
  const legal = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
    "--ignore-host-prunes", "--reconstruction"], { encoding: "utf8" });
  assert.equal(legal.status, 2);
  assert.doesNotMatch(legal.stderr, /sim-batch-reconstruction-host-pruner/,
    "the legal pairing is never refused for the combination");
});

test("stub end-to-end on the reasoning world: the prompt carries reasoning bytes", t => {
  if (!requirePinnedWorld(t)) return;
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-reasoning-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      "--segment", "139", "--lanes", "8", "--ask-ceiling", "1", "--token-grant", "10000000",
      "--allow-host-pruner",
      "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[segment\] last step 139; first excluded step 140/);
    assert.match(result.stdout, /\[pins\] eligible 268/);
    assert.match(result.stdout, /reasoning 86 turns, 155545 B/);
    assert.match(result.stdout,
      /\[host-pruner\] input on \(read from the recording: \d+ prune row\(s\) in the file,/);
    assert.match(result.stdout, /modeled on \(--allow-host-pruner\); this replay runs none/);
    const record = JSON.parse(readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim());
    assert.equal(record.inputHostPruner, "on", "the fire record states the INPUT's pruner");
    assert.equal(record.runHostPruner, "none",
      "a replay mounts no host pruner; the run's own state is stated, never borrowed"
      + " from the input");
    assert.deepEqual(record.inputDeviations.map(deviation => deviation.id),
      ["agent-instructions-splice", "system-model-name"],
      "the two DETECTED input deviations ride every send record; the stand-in's own"
      + " facts are in contextStandIn under the universal stand-in-context reason");
    assert.equal(record.inputDeviations[0].bytes, 8_323,
      "the splice's own byte count is recorded, not a constant");
    assert.equal(record.ignoreHostPrunes, false);
    assert.ok(record.reasoningMessages > 0, "the assembled prompt carries the agent's turns");
    assert.ok(record.reasoningBytes > 0, "and their bytes");
    assert.ok(record.reasoningWireBytes >= record.reasoningBytes,
      "the wire form is never smaller than the raw text");
    assert.ok(record.promptBytes > record.reasoningBytes,
      "the reasoning is counted into the prompt's own byte total");
    assert.equal(record.promptGuardTokens,
      Math.max(Math.ceil(record.promptBytes / 3), Math.ceil(record.promptWireBytes / 3)),
      "the guard is the LARGER of the content-only and the wire-derived token counts");
    assert.equal(record.promptGuardTokensContent, Math.ceil(record.promptBytes / 3));
    assert.ok(record.promptGuardTokensBodyWire >= record.promptGuardTokensContent,
      "the FULL request body's JSON is larger than the content-only sum");
    assert.ok(record.promptGuardTokensPayloadWire >= record.promptGuardTokensContent,
      "the messages+tools payload is larger than the content-only sum");
    assert.ok(record.promptGuardTokensBodyWire >= record.promptGuardTokensPayloadWire,
      "the body carries the payload plus the fixed request envelope");
    assert.equal(record.promptTokensEstimate, Math.ceil(record.promptBytes / 3.04),
      "the token estimate uses the measured 3.04 B/token ratio");
    assert.match(record.promptSha256, /^[0-9a-f]{64}$/u, "every send names its prompt hash");
    assert.deepEqual(record.overriddenSeqs, [], "fire 1 has no overrides");
    assert.equal(record.toolsBytes, 13_879, "the tools array is counted, not assumed");
    assert.ok(record.promptBytes > record.toolsBytes);
    assert.ok(record.reasoningShare > 0 && record.reasoningShare < 1,
      "the record states the share of its prompt bytes that is the agent's reasoning");
    assert.equal(record.contextStandIn.kind, "sim-chat-stand-in",
      "the record names the stand-in it sent");
    assert.deepEqual(record.contextStandIn.rolesUsed, ["system", "user", "assistant"]);
    for (const type of ["session", "step/start", "request/header"]) {
      assert.ok(record.contextStandIn.droppedRowTypes.includes(type),
        `the dropped row types list this recording's \`${type}\` rows`);
    }
    assert.ok(record.contextStandIn.inventedPrefix.includes("<label>:\\n"));
    assert.ok(record.contextStandIn.toolCallProjection.includes("Tool call:"));
    // The wire figures: `promptBytes` is a CONTENT-ONLY count (it includes this
    // stand-in's invented prefix lines and omits JSON framing), so it is neither
    // a lower nor an upper bound on the wire.
    assert.ok(record.promptJsonBytes > record.promptBytes,
      "the JSON payload's framing and keys are not in the content-only sum");
    assert.equal(record.bodyWireDeltaBytes, record.promptWireBytes - record.promptBytes,
      "the send record's delta is full request body minus content");
    assert.ok(record.promptWireBytes >= record.promptJsonBytes);
    assert.ok(record.promptWireBytes - record.promptJsonBytes < 200,
      "the request envelope is the fixed model/stream/stream_options block");
    assert.equal(record.eligibility.floor, 512, "the record states its eligibility floor");
    assert.deepEqual(record.eligibility.excluded,
      { unreadableContent: 0, nonTextContent: 0, belowFloor: 31, errorResult: 0,
        noTwoQuotes: 0 },
      "the exclusion counts are recorded, non-text and unreadable content included");
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.pins.reasoningBlocks, 86);
    assert.equal(summary.pins.reasoningBytes, 155_545);
    assert.equal(summary.inputHostPruner, "on");
    assert.equal(summary.runHostPruner, "none", "the replay states it ran no host mechanism");
    assert.deepEqual(summary.inputDeviations.map(deviation => deviation.id),
      ["agent-instructions-splice", "system-model-name"],
      "the summary lists the two DETECTED deviations, not only its records");
    assert.equal(summary.depthSource, "host-result.json");
    // Every run record names its input and its ISSUE-195 counts (auditor §7).
    assert.equal(summary.input.transcript, DEFAULT_TRANSCRIPT);
    assert.match(summary.input.transcriptSha256, /^[0-9a-f]{64}$/u);
    assert.equal(summary.input.usage, DEFAULT_USAGE);
    assert.match(summary.input.usageSha256, /^[0-9a-f]{64}$/u);
    assert.equal(summary.reasoning.resendableBlocks, 86);
    assert.equal(summary.reasoning.resendableBytes, 155_545);
    assert.equal(summary.reasoning.reasoningParts, 93,
      "`type:\"reasoning\"` CONTENT parts, counted structurally (not 372: that was"
      + " a substring count that counted each reasoning part four times: the content"
      + " part, the replay-state block, the stream block-start block and the stream"
      + " replayState block; 4 × 93 = 372)");
    assert.equal(summary.reasoning.reasoningStreamBlocks, 93,
      "`blockType:\"reasoning\"` stream entries");
    assert.equal(summary.reasoning.reasoningTurns, 86,
      "every assistant turn carrying reasoning is one of the resendable blocks");
    // The run names its two input hashes, which are also the pins.
    assert.equal(summary.inputPins.transcriptSha256, SEGMENT_PINS.transcriptSha256);
    assert.equal(summary.inputPins.usageSha256, SEGMENT_PINS.usageSha256);
    // The build that produced the numbers is named, not assumed: every hash is
    // a real one (a null would have been refused before the run started), and
    // the grammar, render and gate3 modules are named beside units and live.
    assert.match(summary.build.core, /\S/u);
    assert.match(summary.build.adapter, /\S/u);
    assert.match(summary.build.coreDistSha256, /^[0-9a-f]{64}$/u);
    for (const name of ["units", "live", "grammar", "render", "gate3"]) {
      assert.match(summary.build.modules[name], /^[0-9a-f]{64}$/u,
        `the build identity names the ${name} module`);
    }
    assert.deepEqual(summary.contextStandIn.rolesUsed, ["system", "user", "assistant"]);
    assert.equal(summary.contextStandIn.promptScope, "first-fire",
      "the summary's block is fire 0's copy, labelled; it is not a run-level total");
    assert.deepEqual(summary.pruneGate,
      { required: false, events: 67, replayedPrunes: 67, inputPruneEvents: 132,
        reconstruction: false, status: "not-required" });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("stub end-to-end on lane 8: three asks, parsed and applied, no socket", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-e2e-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--lanes", "8", "--ask-ceiling", "3", "--token-grant", "10000000",
      "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(out, "kill-timer-armed.txt")), false,
      "the default run arms no wall-clock timer");
    const lines = readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3, "one line per ask");
    const records = lines.map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.askIndex), [0, 1, 2]);
    assert.ok(records.every(record => record.ok && record.batchSize === 8));
    assert.ok(records.every(record => record.promptTokensEstimate > 0));
    assert.ok(records.every(record => record.promptBytes > 0 && record.promptGuardTokens > 0
      && record.promptGuardTokens < 400_000), "the per-fire gauges are recorded");
    assert.ok(records.every(record => record.fidelity !== null
      && record.fidelity.anchorDepth === record.anchorDepth), "the band records its anchor");
    assert.equal(records[1].distribution.refused, 0,
      "the default grammar is jsonl-20: the stub answers every row, so no row refuses");
    assert.ok(records.every(record => record.askGrammar === "jsonl-20"),
      "a run that names no grammar records the product default");
    assert.ok(records.every(record => record.contentBytes === record.answerBytes
      && record.contentBytes > 0), "every send records the reply text's bytes");
    assert.ok(records.every(record => record.contentHead.startsWith("{")
      && record.contentTail.endsWith("}")), "the stub's whole answer is inside head+tail");
    assert.equal(records[0].contextStandIn.kind, "sim-chat-stand-in",
      "the record states the stand-in context it sent");
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.asks, 3);
    assert.equal(summary.stoppedAtCeiling, true);
    // A run stopped at the ceiling is an INCOMPLETE sample: its aggregates are
    // recorded but not citable as a measurement. Pair-2 adds its void
    // zero-reasoning reason, its input-host-pruner reason, the stub transport,
    // one refused answer row, the carried tail and the segment cut. Its system
    // prompt names `deepseek-flash`, so neither detected input deviation is
    // present, and the stand-in's own two facts ride `stand-in-context`, not
    // separate reasons. P1 adds the decoded-text reading (`text-source`) to
    // every sim run. P11: completeness is its own reading, never the ceiling.
    assert.equal(summary.complete, false);
    assert.equal(summary.stoppedAtCeiling, true);
    assert.deepEqual(summary.incompleteReasons,
      ["stopped-at-ceiling", "carried-units:242", "segment-cut:761"],
      "every way the run falls short is named: the ceiling, the carried tail and"
      + " the cut segment; its tool calls are re-projected, not dropped");
    assert.equal(summary.droppedPartsTotal, 0,
      "tool-call parts are re-projected as `Tool call:` turns, never dropped parts");
    assert.ok(summary.projectedPartsTotal > 0, "the projection is counted under its own name");
    assert.equal(summary.droppedRows.count, 0,
      "a tool-call-only assistant turn is a projected row, never a lost row");
    assert.ok(summary.projectedRows > 0);
    assert.equal(summary.citable, false, "stand-in-context makes a sim run never citable");
    assert.deepEqual(summary.measurement.reasons,
      ["stopped-at-ceiling", "zero-reasoning-void-comparison", "host-pruner-on",
        "stub-transport", "stand-in-context",
        "text-source", "batch-lane:8", "segment-cut:761",
        "carried-units:242"],
      "P1/P2/P3: the non-product batch lane and the segment cut are named on the"
      + " reason list; projected tool calls are not content loss");
    assert.deepEqual(summary.measurement.citableForStandIn,
      ["stopped-at-ceiling", "zero-reasoning-void-comparison", "host-pruner-on",
        "stub-transport", "text-source",
        "batch-lane:8", "segment-cut:761", "carried-units:242"],
      "citableForStandIn subtracts ONLY the stand-in WIRE reason; the decoded-text"
      + " reading and the run's shape stay");
    assert.equal(summary.productBatchSize, PRODUCT_BATCH_SIZE,
      "P2: the product's configured batch size rides the summary");
    assert.equal(summary.segmentExcludedRows, 761,
      "P3: the segment cut's excluded-row count rides the summary");
    assert.equal(summary.key.found, false, "the stub reads no key");
    assert.equal(summary.route.model, "deepseek-flash");
    assert.ok(summary.bytesFreedByPolicy > 0, "forgetall answers free real bytes");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the request body is the real shape: role system, no store, no forbidden field", () => {
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
  const body = requestBodyOf({ messages, tools: [{ type: "function", function: { name: "t" } }] });
  assert.deepEqual(Object.keys(body).sort(),
    ["messages", "model", "stream", "stream_options", "tools"]);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(ROUTE.base, "https://api.deepseek.com", "the base is exactly pi-ai's");
  assert.equal(CALL_TIMEOUT_MS, 120_000);
  assert.equal(assertRequestShape({ body }), body);
  const bad = [
    [{ ...body, temperature: 0 }, "temperature"],
    [{ ...body, store: false }, "store"],
    [{ ...body, max_tokens: 1 }, "max_tokens"],
    [{ ...body, tool_choice: "none" }, "tool_choice"],
    [{ ...body, stream: false }, "stream"],
    [{ ...body, stream_options: {} }, "stream_options"],
  ];
  for (const [mutated] of bad) {
    assert.throws(() => assertRequestShape({ body: mutated }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-request-shape");
  }
  assert.throws(() => assertRequestShape({
    body: { ...body, messages: [{ role: "developer", content: "sys" }] } }), error =>
    error.code === "sim-batch-request-shape");
  assert.throws(() => assertRequestShape({ body, base: "https://api.deepseek.com/v1" }), error =>
    error.code === "sim-batch-request-shape");
  assert.throws(() => assertRequestShape({ body, deadlineMs: 30_000 }), error =>
    error.code === "sim-batch-request-shape");
  assert.ok(FORBIDDEN_FIELDS.includes("store"));
});

test("the stream reader takes usage before finish and maps the §4 classes", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"{\\"keepall\\":true}"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}',
    "data: [DONE]",
  ].join("\n");
  const stream = readStreamFrames(raw);
  assert.equal(stream.text, '{"keepall":true}');
  assert.equal(stream.finishReason, "stop");
  assert.equal(stream.usage.total_tokens, 13, "the usage frame is kept");
  assert.equal(stream.done, true);
  assert.equal(classifyStream(stream), null, "an answer has no failure class");
  assert.equal(classifyStream({ ...stream, finishReason: "length" }), "length-trip");
  // A stream is an answer only when it reached [DONE]. A PARTIAL SSE response —
  // text and a finish_reason, then the socket ends — is cut off, not answered;
  // before this check it passed.
  const partial = readStreamFrames([
    'data: {"choices":[{"delta":{"content":"{\\"keepall\\":true}"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  ].join("\n"));
  assert.equal(partial.done, false);
  assert.equal(classifyStream(partial), "stream-truncated",
    "no [DONE] means the reply was cut off, whatever finish_reason says");
  assert.equal(classifyStream({ ...partial, finishReason: null }), "stream-truncated",
    "no [DONE] and no finish_reason is the same cut-off class");
  // Empty and tool-call replies keep their own classes once the stream is whole.
  assert.equal(classifyStream({ text: "", toolCalls: 0, done: true }), "parse",
    "empty text is a parse failure");
  assert.equal(classifyStream({ text: "x", toolCalls: 1, done: true }), "parse",
    "a tool call is a parse failure");
  assert.equal(classifyStream(stream, { aborted: true }), "timeout");
  assert.equal(classifyStream(stream, { deadline: true }), "timeout");
  const typed = readStreamFrames([
    'data: {"type":"text-delta","text":"ab"}', 'data: {"type":"usage","usage":{"total_tokens":2}}',
    'data: {"type":"finish","reason":"stop"}',
  ].join("\n"));
  assert.equal(typed.text, "ab");
  assert.equal(typed.usage.total_tokens, 2);
});

test("only an answered arithmetic refusal earns the correction; invalid-span never does", () => {
  const units = [{ id: "result:1", seq: 1, step: 1, text: "a\nb\nc" }];
  const outOfRange = parseEntryBatchAnswer('{"1":{"keeplines":[[1,5],"s"]}}', [1], "3option");
  assert.equal(outOfRange[0].status, "answered");
  assert.equal(arithmeticRefusalOf(outOfRange[0].answer, 3, "3option"), "spans-outside-result");
  const codes = correctionCodesOf(outOfRange, new Map([[1, 3]]), "3option");
  assert.deepEqual([...codes.keys()], [1]);
  const message = batchCorrectionMessageOf(units, codes);
  assert.match(message, /could not be applied for row\(s\) 1: spans-outside-result/);
  assert.match(message, /Row 1:/);
  assert.match(message, /\[\[entry-ask-end:/);
  // A parse-level refusal is `refused`, so it can never be corrected.
  const invalid = parseEntryBatchAnswer('{"1":{"keeplines":[[0,5],"s"]}}', [1], "3option");
  assert.equal(invalid[0].status, "refused");
  assert.equal(correctionCodesOf(invalid, new Map([[1, 3]]), "3option").size, 0);
  // keeps-every-line is the other answered arithmetic code.
  const everyLine = parseEntryBatchAnswer('{"1":{"keeplines":[[1,3],"s"]}}', [1], "3option");
  assert.equal(arithmeticRefusalOf(everyLine[0].answer, 3, "3option"), "keeps-every-line");
});

test("the band is a gross-error guard: 25% refuses, 10-25% records drift", () => {
  // Tonight's smoke: 44,440 provider tokens vs the 44,401 anchor is 0.09% apart.
  const measured = providerBandOf({ promptTokens: 44_440, anchorDepth: 44_401 });
  assert.equal(measured.ok, true);
  assert.equal(measured.delta, 39);
  assert.ok(measured.deltaRatio < 0.001);
  assert.equal(measured.drift, null);
  assert.ok(Math.abs(measured.deltaPercent - 39 / 44_401 * 100) < 1e-9,
    "deltaPercent is signed and recorded on the band's own reading");
  assert.equal(GROSS_BAND_RATIO, 0.25);
  assert.equal(BAND_DRIFT_RATIO, 0.1);
  // 9.5% is inside the drift line: pass, no marker.
  assert.equal(providerBandOf({ promptTokens: 104, anchorDepth: 95 }).ok, true,
    "9.5% passes silently");
  // 21.05% is past the drift line and inside the gross band: pass, marked.
  const drift = providerBandOf({ promptTokens: 115, anchorDepth: 95 });
  assert.equal(drift.ok, true, "21% continues: the band is not an exact-identity check");
  assert.equal(drift.drift, "within-gross-band");
  assert.ok(Math.abs(drift.deltaPercent - 20 / 95 * 100) < 1e-9);
  // 26.3% is the scale of a missing or doubled context: refuse.
  const gross = providerBandOf({ promptTokens: 120, anchorDepth: 95 });
  assert.equal(gross.ok, false);
  assert.equal(gross.drift, null);
  // The non-live probe band is explicit at 10%: 10.5% still warns there.
  assert.equal(providerBandOf({ promptTokens: 105, anchorDepth: 95,
    bandRatio: BAND_DRIFT_RATIO }).ok, false, "the probe band keeps its 10% line");
  // A bytes estimate is NOT the ruler: 23.94% is recorded, never refused, by
  // the gross band — the exact body is established by the bytes sent and the
  // body hash, not by this number.
  const bytesEstimate = providerBandOf({ promptTokens: 33_771, anchorDepth: 44_401 });
  assert.equal(bytesEstimate.ok, true);
  assert.equal(bytesEstimate.drift, "within-gross-band");
  const absent = providerBandOf({ promptTokens: null, anchorDepth: 44_401 });
  assert.equal(absent.ok, false, "absent usage is never a pass: the band has no ruler");
  assert.equal(absent.reason, "usage-absent");
  assert.equal(absent.delta, null);
  assert.equal(providerBandOf({ promptTokens: 100, anchorDepth: 0 }).reason, "usage-absent",
    "an absent anchor is the same failure");
});

test("stub end-to-end with --segment 146: pins print, prompts stay under 400k", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-segment-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--segment", "146", "--lanes", "8", "--ask-ceiling", "1", "--token-grant", "10000000",
      "--out", out],
    { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[segment\] last step 146; first excluded step 147/);
    assert.match(result.stdout, /\[pins\] eligible 266/);
    const lines = readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.ok(record.promptTokensEstimate > 0 && record.promptTokensEstimate < 400_000);
    assert.equal(record.promptGuardTokens,
      Math.max(Math.ceil(record.promptBytes / 3), Math.ceil(record.promptWireBytes / 3)),
      "the guard is the larger of the content-only and wire-derived token counts");
    assert.ok(record.promptGuardTokens < 400_000);
    assert.equal(record.firstPass.refused, 0);
    assert.equal(record.correction, null, "the stub answers arithmetic, so no correction");
    assert.equal(record.surfaceRows > 0, true);
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.segment, 146);
    assert.equal(summary.sends, 1);
    assert.equal(summary.pins.eligible, 266);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- phase 3 grammars: the default correction is byte-identical ------------

test("the default correction turn is the pre-experiment bytes, exactly", () => {
  const units = [{ id: "result:1", seq: 1, step: 1, text: "a\nb\nc" }];
  const codes = new Map([[1, "spans-outside-result"]]);
  const facts = askRowsOf(units)[0];
  const expected = "Your previous answer could not be applied for row(s) "
    + "1: spans-outside-result. This turn corrects answers that could not be applied; it does not "
    + "put the keep-or-forget question again.\n"
    + `Row 1: ${entryAskFactsBlock(facts)}\n`
    + "Answer again, once, with exactly one JSON object keyed by the same indices, "
    + 'each row one of {"keepall":true}, {"forgetall":"one-line summary"}, or '
    + '{"keeplines":[[start,end],"one-line summary"]}. Ranges are 1-based and inclusive, inside each '
    + `row's own line count.\n${ENTRY_ASK_CLOSING_LINE}`;
  assert.equal(batchCorrectionMessageOf(units, codes, new Map(), "3option"), expected);
  // The DEFAULT correction is the product default grammar's (jsonl-20), never
  // the 3option bytes: a no-grammar call follows `DEFAULT_ASK_GRAMMAR`.
  const byDefault = batchCorrectionMessageOf(units, codes);
  assert.equal(byDefault, batchCorrectionMessageOf(units, codes, new Map(), "jsonl-20"));
  assert.notEqual(byDefault, expected, "the default is not the 3option correction");
});

test("each grammar's correction teaches only its own options", () => {
  const units = [{ id: "result:1", seq: 1, step: 1, text: "a\nb\nc" }];
  const codes = new Map([[1, "spans-outside-result"]]);
  const two = batchCorrectionMessageOf(units, codes, new Map(), "two-option");
  assert.ok(!two.includes("keeplines") && !two.includes("forgetlines"));
  assert.match(two, /There is no line-level option/);
  assert.ok(two.endsWith(ENTRY_ASK_CLOSING_LINE));
  const forget = batchCorrectionMessageOf(units, codes, new Map(), "forgetlines");
  assert.ok(forget.includes('{"forgetlines":[[start,end],"one-line summary"]}'));
  assert.ok(!forget.includes("keeplines"));
  assert.match(forget, /The named lines are removed/);
  assert.ok(forget.endsWith(ENTRY_ASK_CLOSING_LINE));
});

test("two-option has no arithmetic refusal; forgetlines keys its own", () => {
  const everyLine = parseEntryBatchAnswer('{"1":{"forgetall":"x"}}', [1], "3option");
  assert.equal(arithmeticRefusalOf(everyLine[0].answer, 3, "two-option"), null,
    "no range exists, so no correction can ever be earned");
  const forget = parseEntryBatchAnswer('{"1":{"forgetlines":[[1,5],"x"]}}', [1], "3option");
  assert.equal(forget[0].status, "answered");
  assert.equal(arithmeticRefusalOf(forget[0].answer, 3), null,
    "the shipped arithmetic ignores forgetlines");
  assert.equal(arithmeticRefusalOf(forget[0].answer, 3, "forgetlines"), "spans-outside-result");
  const full = parseEntryBatchAnswer('{"1":{"forgetlines":[[1,3],"x"]}}', [1], "3option");
  assert.equal(arithmeticRefusalOf(full[0].answer, 3, "forgetlines"), "forgets-all-lines");
  assert.deepEqual([...correctionCodesOf(forget, new Map([[1, 3]]), "forgetlines").keys()], [1]);
  assert.equal(correctionCodesOf(forget, new Map([[1, 3]])).size, 0);
});

test("forgetlines shaping: the named lines drop, the complement and summary stay", () => {
  const text = "alpha\nbeta\ngamma\ndelta\n";
  const moment = { id: "result:1", lane: 0, seq: 1, step: 1, session: "s", original: { text } };
  const row = renderMoment(moment, { momentId: "result:1", step: 2,
    answer: { action: "forgetlines", ranges: [{ from: 2, to: 3 }], summary: "old notes" } });
  assert.equal(row.shaped, true);
  assert.equal(row.terms.dropped, Buffer.byteLength("beta\ngamma\n"),
    "the dropped bytes are exactly the marked ranges");
  assert.ok(!row.after.includes("beta") && !row.after.includes("gamma"));
  assert.ok(row.after.includes("alpha") && row.after.includes("delta"), "the complement stays");
  assert.ok(row.after.includes("old notes"), "the marker carries the one-line summary");
  // The same ranges under keeplines keep what forgetlines dropped: the polarity flips.
  const kept = renderMoment(moment, { momentId: "result:1", step: 2,
    answer: { action: "keeplines", ranges: [{ from: 2, to: 3 }], summary: "kept notes" } });
  assert.equal(kept.terms.dropped, Buffer.byteLength("alpha\ndelta\n"));
  assert.equal(row.terms.dropped + kept.terms.dropped, Buffer.byteLength(text));
});

test("stub end-to-end under --ask-grammar forgetlines records the grammar", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-grammar-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--segment", "146", "--lanes", "8", "--ask-ceiling", "1", "--ask-grammar", "forgetlines",
      "--token-grant", "10000000", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim());
    assert.equal(record.askGrammar, "forgetlines", "the flag rides every send record");
    assert.equal(record.ok, true);
    assert.equal(record.correction, null, "the stub answers arithmetic, so no correction");
    assert.ok(record.askBytes > 0 && record.promptGuardTokens < 400_000);
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.askGrammar, "forgetlines");
    assert.ok(summary.bytesFreedByPolicy > 0, "the stub's forgetall answers still shape rows");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("stub end-to-end under --ask-grammar keeplines-60 records the grammar", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-keeplines60-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--segment", "146", "--lanes", "8", "--ask-ceiling", "1", "--ask-grammar", "keeplines-60",
      "--token-grant", "10000000", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const records = readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line));
    assert.equal(records[0].askGrammar, "keeplines-60", "the flag rides every send record");
    assert.equal(records[0].ok, true);
    assert.ok(records[0].askBytes > 0 && records[0].promptGuardTokens < 400_000);
    assert.ok(records[0].askBytes > 0, "the arm B instruction is what was sent");
    // The stub answers keepall on every fourth row: arm B refuses that action.
    const gated = records[0].rows.filter(row => row.code === "action-not-in-grammar");
    assert.ok(gated.length > 0, "keepall rows are refused and keep");
    assert.deepEqual(gated.map(row => row.action), gated.map(() => null),
      "a refused row carries no action: it is not a keep, the parser's fail-open is separate");
    assert.ok(Number.isSafeInteger(records[0].distribution.keeplines),
      "the distribution carries the keeplines count");
    assert.ok(records[0].keptFraction !== null && records[0].keptFraction >= 0
      && records[0].keptFraction <= 1, "the send records its own kept fraction");
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.askGrammar, "keeplines-60");
    assert.equal(summary.pins.eligible, 266, "the grammar moves no pin");
    assert.ok(summary.keptLines > 0 && summary.keptLines <= summary.totalLines);
    assert.ok(summary.keptFraction > 0 && summary.keptFraction <= 1,
      "the run records the aggregate kept fraction and nothing enforces it");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a keeplines row is a keep under every grammar, never a second verdict", () => {
  const indices = [1, 2];
  const units = [{ id: "result:1" }, { id: "result:2" }];
  const lineCounts = new Map([[1, 3], [2, 3]]);
  const parsed = [
    { index: 1, status: "answered", answer: {
      action: "keeplines", ranges: [{ from: 1, to: 3 }], summary: "all of it" } },
    { index: 2, status: "answered", answer: {
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "most of it" } },
  ];
  // A keep-whole row and a partial one are both keeps: the partition counts the
  // verdict, and `keeplines` tags the rows on top of it (ISSUE-175).
  const distribution = distributionOf(parsed, units, new Map(), { grammar: "keeplines-60",
    lineCounts });
  assert.equal(distribution.keep, 2, "both keeplines rows are keeps");
  assert.equal(distribution.keeplines, 2, "both rows answered keeplines");
  assert.equal(distribution.forget, 0, "no keeplines row is charged as a forget");
  assert.equal(distribution.refused, 0);
  // A missing line count no longer changes the verdict, only what removed.
  const unknown = distributionOf(parsed, units, new Map(), { grammar: "keeplines-60" });
  assert.equal(unknown.keep, 2);
  assert.equal(unknown.forget, 0);
  // The shipped grammar reads `keeplines` the same way. This line was the bug:
  // it used to expect a 3option keeplines row to land in `forget`.
  const shipped = distributionOf(parsed, units, new Map(),
    { grammar: "3option", lineCounts });
  assert.equal(shipped.keep, 2);
  assert.equal(shipped.forget, 0);
});

// ---- ISSUE-175: a keeplines row must never be charged as a forget -----------

test("regression: a mixed 3option batch partitions into keep + forget + refused", () => {
  // The reported shape: a 3option batch that answers one keepall, one
  // keeplines and one forgetall. The old counter returned keep 1 / forget 2 and
  // swept the keeplines row into `forget`; the rows are three, not four.
  const units = [{ id: "result:1" }, { id: "result:2" }, { id: "result:3" }];
  const lineCounts = new Map([[1, 3], [2, 3], [3, 3]]);
  const parsed = [
    { index: 1, status: "answered", answer: { action: "keepall" } },
    { index: 2, status: "answered", answer: {
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "kept two" } },
    { index: 3, status: "answered", answer: { action: "forgetall", summary: "stale" } },
  ];
  const distribution = distributionOf(parsed, units, new Map(),
    { grammar: "3option", lineCounts });
  assert.equal(distribution.keep, 2, "keepall and keeplines are both kept");
  assert.equal(distribution.forget, 1, "only the forgetall row is forgotten");
  assert.equal(distribution.keeplines, 1, "keeplines is a tag, not a verdict");
  assert.equal(distribution.keep + distribution.forget + distribution.refused, 3,
    "the partition equals the row count, not the row count plus the tag");
  assert.equal(distribution.keep + distribution.forget + distribution.refused
    + distribution.keeplines, 4, "the old arithmetic over-counted by exactly the tag");
});

test("regression: the run summary's keep and forget agree with its own rows", async () => {
  // One fire over two units, answering keepall and keeplines. This is the
  // reported shape: the old counter returned keep 1 / forget 1 over two rows
  // and swept the keeplines row into `forget`. The summary must match the row
  // records it ships beside, and the partition must equal the row count
  // (ISSUE-175).
  const transport = scriptedTransport((ask, indices) => verdictsFor(indices,
    index => (index === 1 ? { keepall: true } : { keeplines: [[1, 5], "kept five lines"] })));
  const transcript = [{ type: "session", id: "session-issue-175" },
    lineRow(1, 1), lineRow(2, 3)];
  const depths = [[1, 1000], [2, 1500], [3, 2000], [4, 2500]]
    .map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 2, mode: "batch", floor: 100,
    allowZeroReasoning: true,
    grammar: "3option", transport, askCeiling: 1,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 1, "the ceiling stops the lane after one fire");
  const record = records[0];
  const answered = record.rows.filter(row => row.status === "answered");
  assert.equal(answered.length, 2, "two answered rows");
  assert.deepEqual(answered.map(row => row.action), ["keepall", "keeplines"]);
  const rowKeep = answered.filter(row => row.action === "keepall"
    || row.action === "keeplines").length;
  const rowForget = answered.filter(row => row.action === "forgetall"
    || row.action === "forgetlines").length;
  assert.equal(summary.keep, rowKeep, "the run's keep equals its row records");
  assert.equal(summary.forget, rowForget, "the run's forget equals its row records");
  assert.equal(record.distribution.keep, rowKeep);
  assert.equal(record.distribution.forget, rowForget);
  assert.equal(summary.keep + summary.forget, summary.decidedRows,
    "both rows answered: keep + forget is the decided-row count");
  assert.equal(record.distribution.keeplines, 1, "the tag survives the fix");
});

test("stub end-to-end under --ask-grammar jsonl-20 answers every row", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-jsonl20-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--segment", "146", "--lanes", "8", "--ask-ceiling", "1", "--ask-grammar", "jsonl-20",
      "--token-grant", "10000000", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim());
    assert.equal(record.askGrammar, "jsonl-20", "the flag rides every send record");
    assert.equal(record.ok, true);
    assert.equal(record.correction, null, "jsonl-20 answers no arithmetic, so no correction");
    // The stub emits one single-key object per row, so jsonl-20 reads every row.
    assert.equal(record.distribution.refused, 0, "no row refuses answer-unreadable");
    assert.equal(record.firstPass.refused, 0);
    assert.ok(record.rows.every(row => row.status === "answered"));
    assert.ok(record.rows.some(row => row.action === "keepall"));
    assert.ok(record.rows.some(row => row.action === "forgetall"));
    assert.ok(record.appliedForgets > 0, "the stub's forgetall lines shape real rows");
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.askGrammar, "jsonl-20");
    assert.equal(summary.pins.eligible, 266, "the grammar moves no pin");
    assert.ok(summary.bytesFreedByPolicy > 0);
    // Twelfth audit item 9: a stub run's token totals are the stub's own
    // estimate. The summary names that ruler and files the numbers under
    // `estimatedTokens`, never under the provider totals.
    assert.equal(summary.usageRuler, "synthetic", "the stub's ruler is named on the summary");
    assert.equal(summary.promptTokens, 0, "no synthetic reading is a provider total");
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.estimatedTokens.promptTokens, record.promptTokens,
      "one send: the estimated bucket equals that send's own estimate");
    assert.ok(summary.estimatedTokens.totalTokens > 0,
      "the synthetic total is recorded, just not as a billed one");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("live lane: a jsonl-20 whole-range keeplines is normalized to keepall and plans no shaped turn", async () => {
  const transport = {
    name: "jsonl-20-scripted",
    ask: async ({ indices }) => ({
      ok: true, httpStatus: 200, latencyMs: 0, diagnostics: null,
      content: indices.map(index =>
        `{"${index}":{"keeplines":[[1,10]],"summary":"every line"}}`).join("\n"),
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }),
  };
  // A second unit lands at step 2 purely so the reconstructed surface grows:
  // a pruner-off lane triggers on its own bytes, and one unit alone never grows.
  const transcript = [{ type: "session", id: "session-jsonl-keep-whole" },
    lineRow(1, 1, 10), lineRow(2, 2, 10)];
  const depths = [[1, 1000], [2, 2000]].map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 0, mode: "threshold",
    allowZeroReasoning: true,
    threshold: 500, floor: 100, grammar: "jsonl-20", transport, askCeiling: 4,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 1, "one fire");
  assert.equal(records[0].rows[0].action, "keepall", "the product normalizes a whole-range keep");
  assert.equal(records[0].distribution.keep, 1, "the keep-whole row counts as a keep");
  assert.equal(records[0].distribution.forget, 0, "nothing under jsonl-20 is charged as a forget");
  assert.equal(records[0].appliedForgets, 0, "no shaped turn, no removal");
  assert.equal(records[0].keptLines, 10, "all ten lines stayed");
  assert.equal(records[0].keptFraction, 1);
  assert.equal(summary.bytesFreedByPolicy, 0, "the lane frees nothing");
  assert.equal(summary.decidedRows, 1);
});

test("stub end-to-end under --ask-order both records the order", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-order-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--segment", "146", "--lanes", "8", "--ask-ceiling", "1", "--ask-grammar", "two-option",
      "--ask-order", "both", "--token-grant", "10000000", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(path.join(out, "batch-8.jsonl"), "utf8").trim());
    assert.equal(record.askOrder, "both", "the flag rides every send record");
    assert.equal(record.askGrammar, "two-option", "grammar and order compose");
    assert.equal(record.ok, true);
    assert.ok(record.askBytes > 0 && record.promptGuardTokens < 400_000);
    const summary = JSON.parse(readFileSync(path.join(out, "batch-8.json"), "utf8"));
    assert.equal(summary.askOrder, "both", "the run summary carries it too");
    assert.equal(summary.pins.eligible, 266, "the order moves no pin");
    assert.equal(summary.sends, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- threshold semantics: the live loop resets to the post-removal depth ---

/** A transport that forgets every row it is asked about, and bills a flat usage. */
const forgetAllTransport = (bytes = "gone") => ({
  name: "forgetall-stub",
  ask: async ({ indices }) => ({
    ok: true, httpStatus: 200, latencyMs: 0, diagnostics: null,
    content: JSON.stringify(Object.fromEntries(indices.map(index => [index, { forgetall: bytes }]))),
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }),
});

/** One `tool/result` row: `bytes` of ASCII body (two quotable lines) at `step`. */
const resultRow = (seq, step, bytes) => {
  const head = Math.floor(bytes / 2);
  return {
    type: "tool/result", seq, data: { step, content: [{ type: "text",
      text: `${"a".repeat(head)}
${"b".repeat(bytes - head - 1)}` }] },
  };
};

/** The body `lineRow` carries: `lines` distinct lines, each about 190 B. */
const lineBodyOf = (lines = 10) =>
  Array.from({ length: lines }, (_, at) => `line ${String(at)} ${"x".repeat(180)}`).join("\n");

/** One `tool/result` row with `lines` distinct lines, each about 190 B. */
const lineRow = (seq, step, lines = 10) => ({
  type: "tool/result", seq,
  data: { step, content: [{ type: "text", text: lineBodyOf(lines) }] },
});

/** A readable first message, so a synthetic run has no `system-absent` hole. */
const systemRow = (seq = 0) => ({
  type: "system/message", seq,
  data: { content: [{ type: "text", text: "system prompt" }] },
});

/** A `request/header` whose one tool carries `descriptionBytes` of schema text. */
const headerRow = (seq = 0, descriptionBytes = 1_000) => ({
  type: "request/header", seq,
  data: { header: { tools: [{ name: "read", description: "d".repeat(descriptionBytes),
    parameters: {} }] } },
});

/** `[[step, tokens], ...]` as the measured depth schedule. */
const depthsFrom = pairs => pairs.map(([step, tokens]) => ({ step, tokens }));

/** A transport that answers from a script over the ask index and row indices. */
const scriptedTransport = answerOf => {
  const seen = [];
  return {
    name: "scripted", seen,
    ask: async ({ messages, ask, indices }) => {
      seen.push({ ask, indices, askText: messages[messages.length - 1].content });
      return { ok: true, httpStatus: 200, latencyMs: 0, diagnostics: null,
        content: JSON.stringify(answerOf(ask, indices)),
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    },
  };
};

/** `index → verdict` for every row, from one chooser. */
const verdictsFor = (indices, choose) =>
  Object.fromEntries(indices.map(index => [index, choose(index)]));

/** One kept-scope lane over three units landing at steps 1, 3 and 5. */
async function keptLaneRun({ transport, threshold = 500, askCeiling = 8 }) {
  const transcript = [{ type: "session", id: "session-kept-scope" },
    lineRow(1, 1), lineRow(2, 3), lineRow(3, 5)];
  const depths = [[1, 1000], [2, 1500], [3, 1500], [4, 2000], [5, 2000], [6, 2500]]
    .map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 0, mode: "threshold",
    allowZeroReasoning: true, grammar: "3option",
    threshold, floor: 100, askScope: "kept", transport, askCeiling,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  return { summary, records };
}

test("ask-scope kept: a kept row is tabled again at the next fire, and the one after", async () => {
  const transport = scriptedTransport((ask, indices) => verdictsFor(indices,
    index => (index === 1 ? { keepall: true } : { forgetall: "gone" })));
  const { summary, records } = await keptLaneRun({ transport });
  assert.equal(summary.askScope, "kept", "the run summary records the scope");
  assert.ok(records.every(record => record.askScope === "kept"), "every ask record carries it");
  assert.deepEqual(records.map(record => record.fireStep), [2, 4, 6]);
  assert.deepEqual(records.map(record => record.batchSize), [1, 2, 2],
    "the kept row joins the next fire's new row");
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:1", "result:2"]);
  assert.deepEqual(records[2].rows.map(row => row.unitId), ["result:1", "result:3"],
    "the same row is tabled at the fire after that too");
});

test("ask-scope kept: a forgotten row is not tabled again", async () => {
  const transport = scriptedTransport((ask, indices) => verdictsFor(indices,
    index => (ask === 0 ? { keepall: true } : { forgetall: "gone" })));
  const { records } = await keptLaneRun({ transport });
  assert.deepEqual(records.map(record => record.batchSize), [1, 2, 1]);
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:1", "result:2"]);
  assert.deepEqual(records[2].rows.map(row => row.unitId), ["result:3"],
    "the row forgotten at fire 2 never returns");
});

test("ask-scope kept: a refused row (fail-open keep) is tabled again", async () => {
  const transport = scriptedTransport((ask, indices) => (ask === 0
    ? {}
    : verdictsFor(indices, () => ({ keepall: true }))));
  const { records } = await keptLaneRun({ transport });
  assert.equal(records[0].distribution.refused, 1, "the empty answer refuses its only row");
  assert.deepEqual(records[0].rows.map(row => row.status), ["refused"]);
  assert.deepEqual(records.map(record => record.batchSize), [1, 2, 3]);
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:1", "result:2"]);
  assert.deepEqual(records[2].rows.map(row => row.unitId), ["result:1", "result:2", "result:3"],
    "the refused row keeps and reappears");
});

test("ask-scope kept: a keeplines row is re-tabled from its SHAPED body", async () => {
  // Fire 1 keeps lines 1-2 of unit 1's ten lines. The shaped body is the
  // summary, a blank line, the two kept lines and the marker: FIVE lines, not
  // ten. Fire 2 tables that shaped body (the product re-reads the shaped node),
  // so keeping lines 3-4 of the table is in range and keeping lines 9-10 is not.
  const transport = scriptedTransport((ask, indices) => {
    if (ask === 0) return { 1: { keeplines: [[1, 2], "keep the first two lines"] } };
    if (ask === 1) {
      return verdictsFor(indices, index => (index === 1
        ? { keeplines: [[3, 4], "keep the shaped lines"] }
        : { keepall: true }));
    }
    return verdictsFor(indices, () => ({ keepall: true }));
  });
  const { records } = await keptLaneRun({ transport });
  assert.equal(records[0].rows[0].action, "keeplines", "a partial keep stays partial");
  assert.ok(records.every(record => record.tableSource === "shaped-surface"),
    "every kept-scope fire names the source it read: the shaped surface");
  assert.deepEqual(records.map(record => record.batchSize), [1, 2],
    "two fires: the second re-tables the kept row beside the new one");
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:1", "result:2"]);
  assert.equal(records[1].tableSource, "shaped-surface",
    "a kept-scope fire tables the body the prompt carries");
  // The ask's OWN bytes prove which body was tabled: the shaped summary and
  // marker are there, and the landed lines the first fire dropped are not.
  const secondAsk = transport.seen[1].askText;
  assert.match(secondAsk, /keep the first two lines/,
    "the re-asked table carries the shaped body's summary");
  assert.equal(records[1].totalLines, 15,
    "the table's line total is the shaped row's FIVE lines plus the landed"
    + " row's ten, not two landed ten-line rows");
  assert.equal(records[1].keptLines, 12,
    "two lines of the shaped row plus all ten of the untouched row");
  assert.equal(records[1].rows[0].action, "keeplines", "the shaped row answered again");
  assert.deepEqual(records[1].rows[0].ranges, [{ from: 3, to: 4 }],
    "the range is checked against the shaped body and is inside it");
  assert.equal(records[1].correction, null, "no spans-outside-result correction");
  // The re-answer keeps the row in the kept map (only a forgetall leaves it);
  // its own shaped turn moves the baseline, so whether a third fire follows is
  // the threshold's business, not this table check's.
  assert.equal(records[1].distribution.keep, 2,
    "both re-tabled rows answered keep: the shaped row is still kept");
});

test("ask-scope kept: removal bookings reconcile with bytesFreedByPolicy (P7)", async () => {
  // Fire 0 shapes unit 1 with keeplines and books it. Fire 1 re-tables it and
  // answers keepall (a restore) beside a new unit 2 it forgets. A restore must
  // REMOVE the unit's booking, not leave a stale one, so the booking list's sum
  // is the summary's final figure. A no-change re-ask books nothing.
  const transport = scriptedTransport((ask, indices) => {
    if (ask === 0) return { 1: { keeplines: [[1, 2], "keep the first two"] } };
    if (ask === 1) {
      return verdictsFor(indices, index => (index === 1
        ? { keepall: true }
        : { forgetall: "gone" }));
    }
    return verdictsFor(indices, () => ({ keepall: true }));
  });
  const { summary, records } = await keptLaneRun({ transport });
  assert.ok(records.length >= 2, "the fixture fires at least twice");
  assert.ok(records[0].rows[0].action === "keeplines");
  assert.equal(records[1].rows[0].action, "keepall", "the shaped row is restored");
  const booked = summary.removalBookings.reduce((sum, booking) => sum + booking.bytes, 0);
  assert.equal(booked, summary.bytesFreedByPolicy,
    "P7: the bookings' sum is the summary's final freed figure");
  assert.ok(summary.removalBookings.every(booking => booking.unitId !== "result:1"),
    "the restored unit's booking is gone, never a stale positive entry");
  assert.ok(summary.removalBookings.some(booking => booking.unitId === "result:2"),
    "the forgotten unit's booking stands");
});

// ---- P2: freed bytes come from the body the fire APPLIED ----------------

test("P2: a kept-scope re-ask frees bytes from the SHAPED body, never the landed one", async () => {
  // Fire 1 keeps lines 1-2 of a ten-line row, so the shaped body is the summary,
  // a blank line, the two kept lines and the marker. Fire 2 re-tables THAT body
  // and answers keeplines 1-2 again: the fire sizes the second decision against
  // the shaped body. The old summary re-rendered the last decision over the
  // LANDED ten-line text, so it reported a removal of 1,342 B where the fire
  // freed 365 B — a number no fire ever applied.
  const transport = scriptedTransport((ask, indices) => {
    if (ask === 0) return { 1: { keeplines: [[1, 2], "keep the first two lines"] } };
    if (ask === 1) {
      return verdictsFor(indices, index => (index === 1
        ? { keeplines: [[1, 2], "keep the shaped head"] }
        : { keepall: true }));
    }
    return verdictsFor(indices, () => ({ keepall: true }));
  });
  const { summary, records } = await keptLaneRun({ transport });
  assert.equal(summary.asks, 2, "two fires: the first ask and its re-ask");
  const landed = lineBodyOf(10);
  const moment = { id: "result:1", lane: 0, seq: 1, step: 1,
    session: "session-kept-scope", original: { text: landed } };
  const first = renderMoment(moment,
    { momentId: "result:1", action: "keeplines", ranges: [{ from: 1, to: 2 }],
      summary: "keep the first two lines" });
  const shapedBody = first.after;
  const shapedLines = shapedBody.split("\n").length;
  assert.ok(shapedLines > 2 && shapedLines < 10,
    "the shaped body is neither the landed body nor a single line");
  const applied = netDroppedOf(renderMoment({ ...moment, original: { text: shapedBody } },
    { momentId: "result:1", action: "keeplines", ranges: [{ from: 1, to: 2 }],
      summary: "keep the shaped head" }));
  const rerenderedFromLanded = netDroppedOf(renderMoment(moment,
    { momentId: "result:1", action: "keeplines", ranges: [{ from: 1, to: 2 }],
      summary: "keep the shaped head" }));
  assert.notEqual(applied, rerenderedFromLanded,
    "the fixture is only useful if the two bodies give different numbers");
  assert.equal(summary.bytesFreedByPolicy, applied,
    "the summary frees exactly what the LAST decision freed from the body the"
    + " fire applied");
  assert.notEqual(summary.bytesFreedByPolicy, rerenderedFromLanded,
    "re-rendering the last decision over the landed text reports bytes no fire freed");
  // The named assertion's own numbers, quoted: the fires' bookings sum to the
  // summary's freed figure, and the run refused if they had not.
  const booked = summary.removalBookings.reduce((sum, booking) => sum + booking.bytes, 0);
  assert.equal(booked, summary.bytesFreedByPolicy,
    `bookings ${booked} === freed ${summary.bytesFreedByPolicy} (sim-batch-booking-sum)`);
  assert.equal(records.length, 2);
});

test("ask-scope kept: a shape, a keepall, then a forget re-renders from the LANDED unit", async () => {
  // Thirteenth audit item 1: the kept map stored the PRE-answer unit. After a
  // keepall the surface entry is deleted, so a later forget re-asked the stale
  // shaped body while `reconstructedSurfaceOf` re-rendered from the landed unit;
  // the digest gate refused `sim-batch-surface-digest` and a valid sequence
  // produced no evidence.
  const transport = scriptedTransport((ask, indices) => {
    if (ask === 0) return { 1: { keeplines: [[1, 2], "keep the first two lines"] } };
    if (ask === 1) return verdictsFor(indices, () => ({ keepall: true }));
    return verdictsFor(indices, index => (index === 1
      ? { forgetall: "gone" } : { keepall: true }));
  });
  const { summary, records } = await keptLaneRun({ transport });
  assert.deepEqual(records.map(record => record.rows[0]?.action),
    ["keeplines", "keepall", "forgetall"],
    "the fixture walks one unit through a shape, a restore and a forget");
  const booked = summary.removalBookings.reduce((sum, booking) => sum + booking.bytes, 0);
  assert.equal(booked, summary.bytesFreedByPolicy,
    "the valid sequence completes: its bookings still sum to the freed figure");
  assert.ok(summary.removalBookings.some(booking => booking.unitId === "result:1"),
    "the final forget's booking stands");
});


test("live lane: a keep-whole keeplines last answer completes and keeps the row", async () => {
  // The observed failure: the fire loop kept this row, then the final lane render
  // refused `sim-render-nothing-dropped` and the run wrote no JSON.
  const transport = scriptedTransport((ask, indices) => verdictsFor(indices,
    () => ({ keeplines: [[1, 10], "every line of the row"] })));
  const transcript = [{ type: "session", id: "session-keep-whole" },
    lineRow(1, 1, 10), lineRow(2, 2, 10)];
  const depths = [[1, 1000], [2, 2000]].map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 0, mode: "threshold",
    allowZeroReasoning: true,
    threshold: 500, floor: 100, grammar: "keeplines-60", transport, askCeiling: 4,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 1, "one fire");
  assert.equal(records[0].distribution.keep, 1, "the keep-whole row is a keep");
  assert.equal(records[0].distribution.forget, 0);
  assert.equal(records[0].appliedForgets, 0, "no shaped turn, no removal");
  assert.equal(summary.keep, 1);
  assert.equal(summary.forget, 0);
  assert.equal(summary.appliedForgets, 0);
  assert.equal(summary.bytesFreedByPolicy, 0, "the lane frees nothing");
  assert.equal(summary.decidedRows, 1);
  assert.equal(summary.keptLines, 10, "all ten lines stayed");
});

test("ask-scope new reproduces the 60k stub shapes exactly", t => {
  if (!HAVE_PAIR2) return t.skip("pair-2 vanilla evidence is absent (scratchpad is disposable)");
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-scope-new-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      ...PAIR2_ARGS,
      "--mode", "threshold", "--thresholds", "60000", "--threshold-semantics", "incremental",
      "--ask-grammar", "3option", "--segment", "146", "--ask-ceiling", "20",
      "--token-grant", "10000000", "--out", out],
    { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[pins\] eligible 266/);
    assert.match(result.stdout, /peak depth host 320637 at step 123/);
    const summary = JSON.parse(readFileSync(path.join(out, "threshold-60000.json"), "utf8"));
    assert.equal(summary.askScope, "new", "no flag is the new scope, recorded");
    assert.equal(summary.triggers, 5, "the five recorded fires");
    // P6 (eleventh audit): `hostRemovedAt` is strict, so a fire landing on a
    // prune's own step still tables the rows that prune names. The last fire
    // therefore tables 21 rows, not 15, and one more unit is never asked.
    assert.equal(summary.carried, 159,
      "101 asked of 260 askable: the tail, the pending rows and the 41 the host"
      + " pruned before any fire tabled them");
    assert.equal(summary.prunedBeforeAsk, 41,
      "the 41 units the host pruned before any fire tabled them, named inside carried");
    assert.deepEqual(summary.records.map(record => record.batchSize), [23, 27, 22, 14, 21],
      "the per-fire pending shapes (a replacement enters at its own step; a"
      + " later-pruned original is askable until the step AFTER its prune)");
    // ISSUE-194: each fire is built from the run's simulated surface, so a unit
    // forgotten at an earlier fire leaves the context instead of being rebuilt
    // from the transcript. These are the same five fires' bytes after that change.
    assert.equal(summary.promptPeakBytes, 784_795, "the peak content-only bytes (tools counted)");
    assert.equal(summary.promptPeakWireBytes, 819_811, "the peak request body");
    assert.equal(summary.promptPeakGuardTokens, 273_271,
      "ceil(peak wire B / 3): the guard reads the larger size");
    assert.equal(summary.promptPeakEstimateTokens, 258_157,
      "ceil(peak content B / 3.04)");
    // The pair-2 input declares zero reasoning; the run is a VOID comparison and
    // says so, so no aggregate from it can be cited as a measurement.
    assert.equal(summary.citable, false);
    assert.equal(summary.reasoning.voidComparison, true);
    assert.deepEqual(summary.measurement.reasons,
      ["zero-reasoning-void-comparison", "host-pruner-on", "stub-transport",
        "stand-in-context", "text-source",
        "non-default-grammar:3option", "sim-only-trigger:depth-tokens", "segment-cut:761",
        "refused-rows:1", "carried-units:159"]);
    assert.equal(summary.droppedPartsTotal, 0,
      "the pair-2 tool calls are re-projected, never dropped content");
    assert.ok(summary.projectedPartsTotal > 0);
    assert.ok(summary.records.every(record => record.askScope === "new"));
    assert.equal(summary.firstFireDepth, null, "no flag leaves the field null");
    assert.ok(summary.records.every(record => record.firstFireDepth === null),
      "every ask record carries the unset field too");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("ask-scope refuses an unknown value and a batch-mode combination", () => {
  const invalid = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "threshold", "--ask-scope", "all"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /sim-batch-ask-scope-invalid/);
  assert.throws(() => assertAskScope("all"), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-ask-scope-invalid");
  const batch = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "batch", "--ask-scope", "kept"], { encoding: "utf8" });
  assert.equal(batch.status, 2);
  assert.match(batch.stderr, /sim-batch-ask-scope-batch/);
  assert.match(batch.stderr, /threshold mode only/);
});


test("live threshold: incremental resets to the post-removal depth, growth does not", async () => {
  // The owner's example as the live loop sees it: 60k threshold, the step-2 fire
  // drops 240,000 B = τ 60,000 tokens, so the next window starts at 45,000.
  const transcript = [{ type: "session", id: "session-live-incr" },
    resultRow(1, 1, 240_000), resultRow(2, 3, 4000)];
  const depths = [[1, 45_000], [2, 105_000], [3, 135_000], [4, 165_000]]
    .map(([step, tokens]) => ({ step, tokens }));
  // This lane measures the host-semantics threshold arithmetic on the HOST
  // depth schedule, so it states the host pruner on (there are no journals in
  // this synthetic world). A pruner-off lane would read the surface bytes.
  const run = async semantics => {
    const records = [];
    const summary = await runLane({ ignoreHostPrunes: false, transcript, depths, lane: 0, mode: "threshold",
    allowZeroReasoning: true,
      threshold: 60_000, semantics, transport: forgetAllTransport(), askCeiling: 8,
      grammar: "3option",
      deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
    return { ...summary, records };
  };
  const incremental = await run(undefined);
  assert.equal(incremental.semantics, "incremental", "the default the live summary records");
  assert.deepEqual(incremental.records.map(record => record.fireStep), [2, 4],
    "the shave is not free credit: 75,000 holds, 105,000 fires");
  // NET: 240,000 B + 4,000 B gross, less each shaped turn's summary and marker.
  assert.equal(incremental.bytesFreedByPolicy, 239_873 + 3_873);
  assert.equal(incremental.bytesFreedGross, 244_000);
  const growth = await run("growth");
  assert.equal(growth.semantics, "growth");
  assert.deepEqual(growth.records.map(record => record.fireStep), [2],
    "growth keeps the pre-removal depth and never re-crosses inside the window");
  assert.equal(growth.carried, 1, "the step-3 unit waits, never flushed");
});

test("live first-fire depth: no fire below 40k, the crossing fires, then 20k windows", async () => {
  // Same 20k lane as the units test, through the real live loop: step 2 would
  // fire on the 21,000 delta, but the first-fire floor is 40,000.
  const transcript = [{ type: "session", id: "session-first-fire" },
    resultRow(1, 1, 2000), resultRow(2, 2, 2000), resultRow(3, 4, 2000)];
  const depths = [[1, 10_000], [2, 31_000], [3, 40_000], [4, 50_000], [5, 60_000]]
    .map(([step, tokens]) => ({ step, tokens }));
  const keepAll = () => scriptedTransport((ask, indices) => verdictsFor(indices,
    () => ({ keepall: true })));
  const run = async firstFireDepth => {
    const records = [];
    const transport = keepAll();
    // Host depth schedule, host pruner stated on: this tests the first-fire
    // gate arithmetic, not the reconstructed surface.
    const summary = await runLane({ ignoreHostPrunes: false, transcript, depths, lane: 0, mode: "threshold",
    allowZeroReasoning: true,
      threshold: 20_000, firstFireDepth, transport, askCeiling: 8,
      deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
    return { ...summary, records };
  };
  const gated = await run(40_000);
  assert.equal(gated.firstFireDepth, 40_000, "the run summary records the floor");
  assert.deepEqual(gated.records.map(record => record.fireStep), [3, 5],
    "no fire before 40k; step 4 is inside the 20k window; step 5 re-crosses it");
  assert.ok(gated.records.every(record => record.firstFireDepth === 40_000),
    "every ask record carries the floor");
  assert.equal(gated.records[0].anchorDepth,
    40_000 + measuredTokensOf(gated.records[0].askBytes),
    "the first fire is at the crossing, plus the ask bytes the request carries");
  assert.deepEqual(gated.records.map(record => record.batchSize), [2, 1]);
  // The anchors carry different asks (two rows vs one), so the interval is
  // measured on the TRIGGER's ruler, which is what the lane compares.
  assert.equal(gated.records[1].triggerDepth - gated.records[0].triggerDepth, 20_000,
    "the later interval is the lane threshold, not the floor");
  const unset = await run(null);
  assert.equal(unset.firstFireDepth, null);
  assert.deepEqual(unset.records.map(record => record.fireStep), [2, 5],
    "without the flag the step-2 delta fires as today");
  assert.ok(unset.records.every(record => record.firstFireDepth === null));
});

test("live first-fire depth refuses batch mode and non-positive values by name", () => {
  const batch = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "batch", "--first-fire-depth", "40000"], { encoding: "utf8" });
  assert.equal(batch.status, 2);
  assert.match(batch.stderr, /sim-batch-first-fire-depth-batch/);
  assert.match(batch.stderr, /threshold mode only/);
  const invalid = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "threshold", "--first-fire-depth", "0"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /sim-batch-first-fire-depth-invalid/);
  const fraction = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "threshold", "--first-fire-depth", "40000.5"], { encoding: "utf8" });
  assert.equal(fraction.status, 2);
  assert.match(fraction.stderr, /sim-batch-first-fire-depth-invalid/);
  const bytes = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--mode", "threshold", "--threshold-units", "landed-bytes",
    "--first-fire-depth", "40000"], { encoding: "utf8" });
  assert.equal(bytes.status, 2);
  assert.match(bytes.stderr, /sim-batch-first-fire-depth-units/);
});

// ---- the auditor's run-level gates -----------------------------------------

/** A body with four lines, each carrying one token no other body shares. */
const tokenedBody = name => Array.from({ length: 4 },
  (_, at) => `${name} line ${String(at + 1)}: TOKEN-${name}-${String(at + 1)}`).join("\n");

test("runLane: fire 2's built messages never carry a unit fire 1 forgot", async () => {
  const seen = [];
  const transcript = [
    { type: "session", id: "session-fire-2" },
    { type: "tool/call", seq: 2,
      data: { step: 1, callId: "call-alpha", name: "read",
        arguments: '{"file_path":"alpha.ts"}' } },
    { type: "tool/result", seq: 3, data: { step: 1, message: { toolCallId: "call-alpha",
      content: [{ type: "text", text: tokenedBody("ALPHA") }] } } },
    { type: "tool/call", seq: 4,
      data: { step: 2, callId: "call-beta", name: "read",
        arguments: '{"file_path":"beta.ts"}' } },
    { type: "tool/result", seq: 5, data: { step: 2, message: { toolCallId: "call-beta",
      content: [{ type: "text", text: tokenedBody("BETA") }] } } },
  ];
  const transport = {
    name: "capture", live: false,
    ask: async ({ messages, ask, indices }) => {
      seen.push({ messages, ask, indices });
      const content = ask === 0
        ? JSON.stringify({ 1: { forgetall: "alpha is gone" } })
        : JSON.stringify({ 1: { keepall: true } });
      return { ok: true, httpStatus: null, latencyMs: 0, content,
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    },
  };
  const records = [];
  // A table-shaped grammar, so the one-row fire renders a bracket label; the
  // default `3option` one-row ask is the prose shape and carries no table.
  const summary = await runLane({ transcript,
    allowZeroReasoning: true,
    depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }], lane: 1, mode: "batch",
    floor: 1, ignoreHostPrunes: true, grammar: "two-option", transport, askCeiling: 4,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 2, "two fires, one unit each");
  const joined = at => seen[at].messages.map(message => message.content).join("\n");
  // Fire 1 carried ALPHA whole; fire 2 must not.
  assert.ok(joined(0).includes("TOKEN-ALPHA-1"), "fire 1 read the landed body");
  for (let line = 1; line <= 4; line += 1) {
    assert.ok(!joined(1).includes(`TOKEN-ALPHA-${String(line)}`),
      `fire 2's messages carry no ALPHA line ${String(line)}`);
  }
  assert.ok(joined(1).includes("alpha is gone"), "the shaped turn's summary is there instead");
  assert.ok(joined(1).includes("TOKEN-BETA-1"), "the new unit is whole");
  // The evidence fields (auditor §7).
  assert.deepEqual(records[0].overriddenSeqs, [], "fire 1 replaced nothing");
  assert.deepEqual(records[1].overriddenSeqs, [3], "fire 2 carries unit seq 3 shaped");
  // The row label is the product's own string, read from the transcript's
  // tool/call arguments (`plugin.ts` `callLabelOf`): name and target.
  assert.ok(seen[0].messages.at(-1).content.includes("[read alpha.ts]"),
    "the live ask table carries the product's '<name> <target>' label");
  assert.ok(seen[0].messages.some(message => message.content.startsWith("read alpha.ts:")),
    "and the surface turn carries it too");
  assert.ok(seen[1].messages.at(-1).content.includes("[read beta.ts]"),
    "the next fire labels its own row the same way");
  assert.match(records[0].promptSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(records[0].promptSha256, records[1].promptSha256,
    "a different prompt is a different hash");
  assert.equal(records[0].promptSha256.length, 64);
  assert.equal(summary.pruneGate.required, true);
  assert.equal(summary.pruneGate.events, 0);
  assert.equal(summary.depthSource, "reconstructed-surface");
  assert.equal(summary.hostDepths.contaminated, true, "the host series is labelled");
});

test("runLane: fire 2's messages carry none of the recording's earlier ask table", async () => {
  // The product rewinds its ask exchange; a replay that kept it would put the
  // first fire's table and answer above every later question. The row below is
  // marked exactly as `plugin.ts` `appendAskTurns` marks it.
  const tableToken = "HISTORIC-TABLE-ROW-TOKEN";
  const transcript = [
    { type: "session", id: "session-ask-history" },
    { type: "user/message", seq: 1, surfaceOp: "append",
      data: { content: [{ type: "text",
        text: `Memory management: decide which results stay.\n\n${tableToken}\n\n`
          + `${ENTRY_ASK_CLOSING_LINE}` }],
      source: { kind: "racoons/negation/entry-ask" } } },
    { type: "user/message", seq: 2, surfaceOp: "append",
      data: { content: [{ type: "text", text: '{"1":{"keepall":true}}' }],
        source: { kind: "racoons/negation/entry-ask" } } },
    { type: "tool/result", seq: 3, data: { step: 1,
      content: [{ type: "text", text: tokenedBody("ONE") }] } },
    { type: "tool/result", seq: 4, data: { step: 2,
      content: [{ type: "text", text: tokenedBody("TWO") }] } },
  ];
  const seen = [];
  const transport = { name: "capture", live: false,
    ask: async ({ messages, ask }) => {
      seen.push({ messages, ask });
      return { ok: true, httpStatus: null, latencyMs: 0,
        content: JSON.stringify({ 1: { keepall: true } }),
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    } };
  await runLane({ transcript, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }],
    allowZeroReasoning: true,
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, grammar: "two-option",
    transport, askCeiling: 4, deadline: Date.now() + 60_000 });
  assert.equal(seen.length, 2, "two fires");
  for (const [at, fire] of seen.entries()) {
    const joined = fire.messages.map(message => message.content).join("\n");
    assert.ok(!joined.includes(tableToken),
      `fire ${String(at + 1)}'s messages carry none of the recorded ask table's rows`);
  }
});

test("runLane: reasoningMessages is the resendable assistant rows on the fire's surface", async () => {
  const reasoningRow = (seq, step, text) => ({
    type: "assistant/message", seq,
    data: { step,
      // ADR-0045 names TWO counts and both gate: the content parts AND the
      // stream entries. The fixture carries both, so the run is not a
      // half-lost transcript.
      stream: [{ index: 0, blockType: "reasoning",
        chunk: { blockType: "reasoning", text: `why ${text}` } }],
      message: { content: [{ type: "text", text }, { type: "reasoning", text: `why ${text}` }],
        source: { replayState: { blocks: [{ type: "text" }, { type: "reasoning",
          thinkingSignature: "reasoning_content" }] } } } },
  });
  const transcript = [{ type: "session", id: "session-reasoning-run" },
    reasoningRow(1, 1, "first"), reasoningRow(2, 2, "second"),
    { type: "tool/result", seq: 3, data: { step: 1,
      content: [{ type: "text", text: tokenedBody("GAMMA") }] } }];
  const records = [];
  const seen = [];
  const transport = { name: "capture", live: false,
    ask: async ({ messages, indices }) => {
      seen.push(messages);
      return { ok: true, httpStatus: null, latencyMs: 0,
        content: JSON.stringify(Object.fromEntries(indices.map(index => [index, { keepall: true }]))),
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    } };
  await runLane({ transcript, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }],
    allowZeroReasoning: true,
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, transport, askCeiling: 2,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  // The TRANSPORT sees the field, not just the builder: the boundary wrapper
  // refuses a live request whose messages lost every reasoning_content string.
  assert.ok(seen[0].some(message => typeof message.reasoning_content === "string"
    && message.reasoning_content.length > 0), "the capture transport received reasoning_content");
  await assert.rejects(withReasoningBoundary(transport, { reasoningBlocks: 1 }).ask(
    { messages: [{ role: "user", content: "no reasoning here" }], indices: [] }),
  error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-boundary");
  assert.equal(records.length, 1);
  assert.equal(records[0].reasoningMessages, 1, "the step-1 assistant row is on the surface");
  assert.ok(records[0].reasoningBytes > 0);
  const withReasoning = records[0].rows.filter(row => row.status === "answered").length;
  assert.equal(withReasoning, 1, "one answered row");
});

test("runLane refuses absent provider usage and an implausible first-send ruler", async () => {
  const transcript = [{ type: "session", id: "session-band" },
    { type: "tool/result", seq: 1, data: { step: 1,
      content: [{ type: "text", text: tokenedBody("DELTA") }] } }];
  const depths = [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }];
  const noUsage = { name: "no-usage", live: false,
    ask: async () => ({ ok: true, httpStatus: 200, latencyMs: 0, content: "{}" }) };
  await assert.rejects(runLane({ transcript, depths, lane: 1, mode: "batch", floor: 1,
    ignoreHostPrunes: true, allowZeroReasoning: true, transport: noUsage, askCeiling: 1,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-provider-usage-absent");
  // Ask 0 has no band: its own ratio must be plausible, and 1 token for a
  // 3.4 kB prompt is not (`sim-batch-provider-ruler`, never a calibrated band).
  const offBand = { name: "deepseek", live: true,
    ask: async () => ({ ok: true, httpStatus: 200, latencyMs: 0, content: "{}",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) };
  await assert.rejects(runLane({ transcript, depths, lane: 1, mode: "batch", floor: 1,
    ignoreHostPrunes: true, allowZeroReasoning: true, transport: offBand, askCeiling: 1,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-provider-ruler");
});

// ---- the calibrated route ruler (paid pilot aborted 2026-11-07) -----------

/** The full request body's bytes, exactly as `askAndApply` measures them. */
const fullBodyBytes = ({ messages, tools = [] }) =>
  Buffer.byteLength(JSON.stringify(requestBodyOf({ messages, tools })), "utf8");

/**
 * A LIVE transport that reports provider `prompt_tokens` as the body's own bytes
 * over `bytesPerToken`. `mutate` lets a case send a body other than the one the
 * anchor describes (the dropped-tabled-unit case); `onSend` records both sizes.
 */
const rulerTransport = ({ bytesPerToken = 4, answerOf, mutate = null, onSend = null }) => ({
  name: "deepseek", live: true,
  ask: async ({ messages, tools = [], ask, indices }) => {
    const sent = mutate === null ? messages : mutate({ messages, ask, indices });
    const fullBytes = fullBodyBytes({ messages, tools });
    const sentBytes = fullBodyBytes({ messages: sent, tools });
    if (onSend !== null) onSend({ ask, fullBytes, sentBytes });
    const promptTokens = Math.round(sentBytes / bytesPerToken);
    return { ok: true, httpStatus: 200, latencyMs: 0, diagnostics: null,
      content: JSON.stringify(answerOf(ask, indices)),
      usage: { prompt_tokens: promptTokens, completion_tokens: 10,
        total_tokens: promptTokens + 10 } };
  },
});

/**
 * A LIVE transport whose provider count is the TWO-DENSITY model
 * `toolBytes/rTool + textBytes/rText` over the body it actually sent. `mutate`
 * lets a case send fewer rows than the anchor describes (the missing-table
 * case); `count` lets a case report a chosen count (the fallback cases).
 */
const twoDensityTransport = ({ rTool = 5, rText = 3.75, answerOf, mutate = null,
  count = null, onSend = null }) => ({
  name: "deepseek", live: true,
  ask: async ({ messages, tools = [], ask, indices }) => {
    const sent = mutate === null ? messages : mutate({ messages, ask, indices });
    const toolBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    const fullBytes = fullBodyBytes({ messages, tools });
    const sentBytes = fullBodyBytes({ messages: sent, tools });
    const promptTokens = count !== null
      ? count({ ask, fullBytes, sentBytes, toolBytes })
      : Math.round(toolBytes / rTool + (sentBytes - toolBytes) / rText);
    if (onSend !== null) onSend({ ask, fullBytes, sentBytes, toolBytes, promptTokens });
    return { ok: true, httpStatus: 200, latencyMs: 0, diagnostics: null,
      content: JSON.stringify(answerOf(ask, indices)),
      usage: { prompt_tokens: promptTokens, completion_tokens: 10,
        total_tokens: promptTokens + 10 } };
  },
});

test("the first-send ruler is bytes/token, and the plausible range is 2.0-6.0", () => {
  // The pilot's own numbers: 56,416 B over 14,110 tokens is 4.00 B/token and
  // passes; the old 3.04 anchor was the stale ruler, not a bad body.
  const pilot = firstSendRulerOf({ promptBytes: 56_416, providerPromptTokens: 14_110 });
  assert.equal(pilot.ok, true);
  assert.ok(Math.abs(pilot.bytesPerToken - 4.0) < 0.01);
  assert.equal(pilot.reason, null);
  assert.equal(RULER_BYTES_PER_TOKEN_MIN, 2.0);
  assert.equal(RULER_BYTES_PER_TOKEN_MAX, 6.0);
  assert.equal(firstSendRulerOf({ promptBytes: 5_000, providerPromptTokens: 2_000 }).ok, true,
    "2.5 B/token is inside the range");
  const short = firstSendRulerOf({ promptBytes: 3_000, providerPromptTokens: 2_000 });
  assert.equal(short.ok, false, "1.5 B/token is outside the range");
  assert.equal(short.reason, "outside-plausible-range");
  assert.ok(Math.abs(short.bytesPerToken - 1.5) < 1e-9);
  assert.equal(firstSendRulerOf({ promptBytes: 0, providerPromptTokens: 1 }).reason,
    "usage-absent", "an absent body has no ratio at all");
});

test("the first live send calibrates the route ruler at 4.0 B/token", async () => {
  const transcript = [{ type: "session", id: "session-ruler-calibrate" }, lineRow(1, 1)];
  const records = [];
  const summary = await runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: rulerTransport({ bytesPerToken: 4,
      answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })) }),
    askCeiling: 1, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(Math.abs(summary.tokenRuler.bytesPerToken - 4.0) < 0.01,
    "the ruler is the body's bytes over the provider's own count");
  assert.equal(summary.tokenRuler.fromAsk, 0);
  assert.equal(summary.tokenRuler.source, "first-send");
  assert.equal(summary.tokenRuler.promptBytes, record.promptWireBytes,
    "the recorded bytes are the FULL request body actually sent, tools included");
  assert.equal(summary.tokenRuler.providerPromptTokens, record.promptTokens);
  assert.equal(summary.tokenRuler.toolBytes, record.toolsBytes);
  assert.equal(summary.tokenRuler.textBytes, record.promptWireBytes - record.toolsBytes);
  assert.equal(summary.tokenRuler.solved, null,
    "one point cannot solve two densities; the single ratio is the whole ruler");
  assert.deepEqual(summary.tokenRuler.points,
    [{ askIndex: 0, toolBytes: record.toolsBytes,
      textBytes: record.promptWireBytes - record.toolsBytes,
      providerPromptTokens: record.promptTokens }], "ask 0 is the first point");
  assert.equal(record.tokenRuler.bytesPerToken, summary.tokenRuler.bytesPerToken);
  assert.equal(record.tokenRuler.source, "first-send");
  assert.equal(record.tokenRuler.rulerModel, "single");
  assert.equal(record.tokenRuler.predictedTokens, null, "ask 0 has no prediction to band");
  assert.equal(record.tokenRuler.providerPromptTokens, record.promptTokens);
  assert.equal(record.tokenRuler.deltaPercent, null);
  assert.equal(record.tokenRuler.rTool, null);
  assert.equal(record.tokenRuler.rText, null);
  assert.equal(summary.fidelityProvider, 1);
  assert.equal(summary.fidelitySynthetic, 0);
  assert.equal(summary.fidelityWarnings, 0);
  assert.equal(record.fidelity.ok, true);
  assert.equal(record.fidelity.calibrated, true, "ask 0's reading calibrates; it is not a band");
  assert.equal(record.anchorDepth, record.anchorDepth304,
    "ask 0 has no calibrated anchor; it records the 3.04 estimate");
  assert.equal(record.anchorDepthCalibrated, null);
  assert.equal(record.anchorRuler, "estimate-3.04");
});

test("ask 0 is graded by the plausible range, not the stale 3.04 band", async () => {
  const transcript = [{ type: "session", id: "session-ruler-range" }, lineRow(1, 1)];
  const runWith = ratio => runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: rulerTransport({ bytesPerToken: ratio,
      answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })) }),
    askCeiling: 1, deadline: Date.now() + 60_000 });
  // 2.5 B/token is plausible: the send passes and the ruler records 2.5.
  const passing = await runWith(2.5);
  assert.ok(Math.abs(passing.tokenRuler.bytesPerToken - 2.5) < 0.01);
  assert.equal(passing.fidelityWarnings, 0);
  // 1.5 B/token is not a text request the route can have tokenized: refuse and
  // name BOTH numbers, so an operator can tell a stale ruler from a short body.
  await assert.rejects(runWith(1.5), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-provider-ruler"
    && /B for \d+ provider prompt_tokens = 1\.50 B\/token/.test(error.message)
    && /2\.0-6\.0 B\/token range/.test(error.message));
});

test("ask 1 is banded against the calibrated anchor and records both rulers", async () => {
  const transcript = [{ type: "session", id: "session-ruler-band" },
    lineRow(1, 1), lineRow(2, 2)];
  const records = [];
  const summary = await runLane({ transcript,
    depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: rulerTransport({ bytesPerToken: 4,
      answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })) }),
    askCeiling: 4, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(records.length, 2, "one unit per fire");
  const [first, second] = records;
  assert.equal(first.anchorDepth304, measuredTokensOf(first.promptWireBytes));
  assert.equal(first.anchorDepthCalibrated, null);
  assert.equal(second.anchorDepth304, measuredTokensOf(second.promptWireBytes),
    "the 3.04 estimate is recorded beside the calibrated one");
  assert.equal(second.anchorDepthCalibrated,
    Math.round(second.promptWireBytes / summary.tokenRuler.bytesPerToken),
    "the calibrated anchor is the request's bytes over the measured ruler");
  assert.equal(second.anchorDepth, second.anchorDepthCalibrated,
    "the band compares against the calibrated anchor");
  assert.equal(second.anchorRuler, "first-send");
  assert.ok(second.anchorDepth < second.anchorDepth304,
    "4.0 B/token is denser than the stale 3.04, so the anchor is fewer tokens");
  assert.equal(second.fidelity.ok, true, "the transport reports the same bytes it was sent");
  assert.equal(second.fidelity.anchorDepth, second.anchorDepth);
  assert.equal(second.fidelity.anchorDepth304, second.anchorDepth304);
  assert.equal(second.tokenRuler.source, "first-send");
});

test("a live ask whose sent body is 30% short (a tabled unit missing) refuses the gross band",
  async () => {
  // The fixed surface is ~9 kB and the step-2 unit ~4.1 kB, so dropping that
  // turn leaves a body more than 30% shorter than the anchor's request. This is
  // the defect the gross band exists for: not a stale ruler, a body at the
  // scale of a missing context.
  const transcript = [{ type: "session", id: "session-ruler-short" },
    { type: "system/message", seq: 0,
      data: { content: [{ type: "text", text: "s".repeat(4_000) }] } },
    lineRow(1, 1), lineRow(2, 2, 22)];
  const sizes = [];
  const transport = rulerTransport({ bytesPerToken: 4,
    answerOf: (ask, indices) => verdictsFor(indices,
      () => (ask === 0 ? { forgetall: "gone" } : { keepall: true })),
    mutate: ({ messages, ask }) => (ask === 1
      ? messages.slice(0, -2).concat(messages.slice(-1)) : messages),
    onSend: event => sizes.push(event) });
  let caught = null;
  await runLane({ transcript,
    depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 4, deadline: Date.now() + 60_000 })
    .then(() => null, error => { caught = error; });
  assert.ok(caught instanceof SimBatchUnitsRefusal
    && caught.code === "sim-batch-provider-band-gross", String(caught?.message));
  assert.match(caught.message,
    /^sim-batch-provider-band-gross: provider prompt_tokens \d+ is [\d.]+% (above|below) the \d+ anchor for ask 1 \(delta [+-]\d+ tokens\)/,
    "the refusal names the delta and both numbers");
  const second = sizes.find(event => event.ask === 1);
  assert.ok(Number.isSafeInteger(second?.sentBytes));
  assert.ok(second.sentBytes <= second.fullBytes * 0.7,
    `the sent body is at least 30% shorter than the anchored request`
    + ` (${String(second.sentBytes)} / ${String(second.fullBytes)} B)`);
});

test("a stub send never calibrates a route ruler", async () => {
  const transcript = [{ type: "session", id: "session-ruler-stub" }, lineRow(1, 1)];
  const records = [];
  const summary = await runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: stubTransport(), askCeiling: 1, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.tokenRuler, null, "a synthetic first send names no route ruler");
  assert.equal(summary.fidelitySynthetic, 1);
  assert.equal(summary.fidelityProvider, 0);
  assert.equal(summary.usageRuler, "synthetic");
  assert.equal(records[0].fidelity.ok, null, "a synthetic band is never a pass");
  assert.equal(records[0].fidelity.reason, "synthetic-ruler");
  // The transport's NAME does not decide: a live transport whose usage says
  // `synthetic` is still the sim grading itself, so it never calibrates either.
  const liveSynthetic = { name: "deepseek", live: true,
    ask: async ({ indices }) => ({ ok: true, httpStatus: 200, latencyMs: 0,
      content: JSON.stringify(Object.fromEntries(
        indices.map(index => [index, { keepall: true }]))),
      usage: { ruler: "synthetic", prompt_tokens: 100, completion_tokens: 10,
        total_tokens: 110 } }) };
  const live = await runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: liveSynthetic, askCeiling: 1, deadline: Date.now() + 60_000 });
  assert.equal(live.tokenRuler, null, "a synthetic reading never calibrates");
  assert.equal(live.fidelitySynthetic, 1);
});

// ---- the two-density ruler (second aborted pilot, 2026-11-07) --------------

/**
 * The pilot's six sends, exactly as the route answered them: the body bytes the
 * runner measured, and the provider's `prompt_tokens`. Ask 5's body is the byte
 * count that reproduces the recorded 23,697 single-ratio anchor (its record was
 * never written: the guard refused before the record); asks 0-4 are the bytes
 * the five surviving send records carry.
 */
const PILOT_TOOL_BYTES = 13_879;
const PILOT_SIX = [
  { askIndex: 0, promptBytes: 56_415, providerPromptTokens: 14_110 },
  { askIndex: 1, promptBytes: 100_543, providerPromptTokens: 25_888 },
  { askIndex: 2, promptBytes: 77_172, providerPromptTokens: 19_954 },
  { askIndex: 3, promptBytes: 77_912, providerPromptTokens: 20_428 },
  { askIndex: 4, promptBytes: 82_866, providerPromptTokens: 22_212 },
  { askIndex: 5, promptBytes: 94_746, providerPromptTokens: 26_241 },
];
const pilotPoint = row => ({ askIndex: row.askIndex, toolBytes: PILOT_TOOL_BYTES,
  textBytes: row.promptBytes - PILOT_TOOL_BYTES,
  providerPromptTokens: row.providerPromptTokens });

test("the pilot's six sends: one ratio drifts past 10%, two densities stay inside it", () => {
  // 56,415 B / 14,110 = 3.998 B/token. The single ratio is the ruler ask 0
  // records, and ask 1's own +2.95% is inside the drift line and the gross band.
  const single = firstSendRulerOf({ promptBytes: PILOT_SIX[0].promptBytes,
    providerPromptTokens: PILOT_SIX[0].providerPromptTokens });
  assert.equal(single.ok, true);
  assert.ok(Math.abs(single.bytesPerToken - 3.998) < 0.001);
  const ask1Anchor = Math.round(PILOT_SIX[1].promptBytes / single.bytesPerToken);
  assert.equal(ask1Anchor, 25_147);
  assert.ok(Math.abs(PILOT_SIX[1].providerPromptTokens - ask1Anchor) / ask1Anchor <= 0.1);
  // Two accepted sends solve the two densities: the tool schema at ~5.03
  // B/token, the text at ~3.75 B/token. The text is DENSER, and every removal
  // lowers the text share, so the single ratio under-counts more each ask.
  const solved = twoPointRulerOf({ first: pilotPoint(PILOT_SIX[0]),
    second: pilotPoint(PILOT_SIX[1]) });
  assert.equal(solved.ok, true);
  assert.deepEqual(solved.solvedFrom, [0, 1]);
  assert.ok(Math.abs(solved.rTool - 5.034) < 0.01, `rTool ${String(solved.rTool)}`);
  assert.ok(Math.abs(solved.rText - 3.747) < 0.01, `rText ${String(solved.rText)}`);
  // The observed six-point sequence continues through all six under the gross
  // band: ask 1's single-ratio reading is +2.95%, and asks 2-5 are each inside
  // ±10% of their OWN tool/text prediction.
  const ask1Band = providerBandOf({ promptTokens: PILOT_SIX[1].providerPromptTokens,
    anchorDepth: ask1Anchor });
  assert.equal(ask1Band.ok, true);
  assert.ok(Math.abs(ask1Band.deltaPercent - 2.95) < 0.01,
    `ask 1 delta ${String(ask1Band.deltaPercent)}`);
  assert.equal(ask1Band.drift, null, "2.95% is inside the drift line");
  const bands = [ask1Band];
  const deltas = [];
  for (const row of PILOT_SIX.slice(2)) {
    const predicted = predictPromptTokensOf({ toolBytes: PILOT_TOOL_BYTES,
      textBytes: row.promptBytes - PILOT_TOOL_BYTES,
      rTool: solved.rTool, rText: solved.rText });
    const delta = Math.abs(row.providerPromptTokens - predicted) / predicted;
    deltas.push(Number((delta * 100).toFixed(2)));
    assert.ok(delta <= 0.1,
      `ask ${String(row.askIndex)} is ${(delta * 100).toFixed(2)}% from the prediction`);
    const band = providerBandOf({ promptTokens: row.providerPromptTokens,
      anchorDepth: Math.round(predicted) });
    assert.equal(band.ok, true);
    assert.equal(band.drift, null, "10% or less records no drift marker");
    bands.push(band);
  }
  assert.deepEqual(deltas, [1.55, 2.92, 4.92, 7.81]);
  assert.equal(bands.length, 5, "asks 1-5 all continue: six sends, no refusal");
  // The single ratio at ask 5 is 23,697 tokens for the same 26,241 reading:
  // +10.74%, the refusal the second pilot hit under the OLD ±10% band. The
  // gross band records the same reading as drift and lets the run continue.
  const ask5Single = Math.round(PILOT_SIX[5].promptBytes / single.bytesPerToken);
  assert.equal(ask5Single, 23_697);
  assert.equal(providerBandOf({ promptTokens: PILOT_SIX[5].providerPromptTokens,
    anchorDepth: ask5Single, bandRatio: BAND_DRIFT_RATIO }).ok, false,
  "the old 10% band refuses this send");
  const ask5Gross = providerBandOf({ promptTokens: PILOT_SIX[5].providerPromptTokens,
    anchorDepth: ask5Single });
  assert.equal(ask5Gross.ok, true, "the gross band continues the same send");
  assert.equal(ask5Gross.drift, "within-gross-band",
    "10.74% is inside the gross band and past the drift line");
  const ask5Predicted = Math.round(predictPromptTokensOf({
    toolBytes: PILOT_TOOL_BYTES, textBytes: PILOT_SIX[5].promptBytes - PILOT_TOOL_BYTES,
    rTool: solved.rTool, rText: solved.rText }));
  const ask5Two = providerBandOf({ promptTokens: PILOT_SIX[5].providerPromptTokens,
    anchorDepth: ask5Predicted });
  assert.equal(ask5Two.ok, true, "two densities pass the same send");
  assert.equal(ask5Two.drift, null, "7.81% records no drift marker");
});

test("tokenDepthOf picks the two-density model only from ask 2, and records a fallback", () => {
  const run = { bytesPerToken: 4,
    solved: { rTool: 5, rText: 3.75, solvedFrom: [0, 1] } };
  const two = tokenDepthOf({ tokenRuler: run, toolBytes: 1_000, bodyBytes: 11_200 });
  assert.equal(two.rulerModel, "two-density");
  assert.equal(two.tokens, Math.round(1_000 / 5 + 10_200 / 3.75));
  const single = tokenDepthOf({ tokenRuler: run, toolBytes: 1_000, bodyBytes: 11_200,
    useTwoDensity: false });
  assert.equal(single.rulerModel, "single");
  assert.equal(single.tokens, Math.round(11_200 / 4));
  const fallbackRun = { bytesPerToken: 4, solved: null, rulerFallback: true,
    fallbackReason: "dependent-points" };
  const fallback = tokenDepthOf({ tokenRuler: fallbackRun, toolBytes: 1_000,
    bodyBytes: 11_200 });
  assert.equal(fallback.rulerModel, "single");
  assert.equal(fallback.rulerFallback, true);
  assert.equal(tokenDepthOf({ tokenRuler: null, toolBytes: 0, bodyBytes: 100 }).tokens, null,
    "no ruler, no reading");
});

test("a degenerate two-point system has no ruler and falls back", () => {
  const noText = twoPointRulerOf({
    first: { askIndex: 0, toolBytes: 13_879, textBytes: 0, providerPromptTokens: 100 },
    second: { askIndex: 1, toolBytes: 13_879, textBytes: 0, providerPromptTokens: 200 } });
  assert.equal(noText.ok, false);
  assert.equal(noText.reason, "no-text-bytes");
  const noTool = twoPointRulerOf({
    first: { askIndex: 0, toolBytes: 0, textBytes: 1_000, providerPromptTokens: 100 },
    second: { askIndex: 1, toolBytes: 0, textBytes: 2_000, providerPromptTokens: 200 } });
  assert.equal(noTool.ok, false);
  assert.equal(noTool.reason, "no-tool-bytes");
  const dependent = twoPointRulerOf({
    first: { askIndex: 0, toolBytes: 1_000, textBytes: 2_000, providerPromptTokens: 100 },
    second: { askIndex: 1, toolBytes: 2_000, textBytes: 4_000, providerPromptTokens: 200 } });
  assert.equal(dependent.ok, false);
  assert.equal(dependent.reason, "dependent-points");
  const negative = twoPointRulerOf({
    first: { askIndex: 0, toolBytes: 1_000, textBytes: 2_000, providerPromptTokens: 1_000 },
    second: { askIndex: 1, toolBytes: 1_000, textBytes: 4_000, providerPromptTokens: 2_050 } });
  assert.equal(negative.ok, false);
  assert.equal(negative.reason, "non-positive-ruler");
});

test("a live run continues through six asks on the two-density prediction", async () => {
  const rows = [{ type: "session", id: "session-two-density" }, headerRow(0), systemRow(1),
    lineRow(2, 1), lineRow(3, 2), lineRow(4, 3), lineRow(5, 4), lineRow(6, 5), lineRow(7, 6)];
  const records = [];
  const summary = await runLane({ transcript: rows,
    depths: [[1, 1_000], [2, 2_000], [3, 3_000], [4, 4_000], [5, 5_000], [6, 6_000]]
      .map(([step, tokens]) => ({ step, tokens })),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: twoDensityTransport({ rTool: 5, rText: 3.75,
      answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })) }),
    askCeiling: 8, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.asks, 6, "the run is not stopped by the band");
  assert.equal(records.length, 6);
  assert.equal(summary.stoppedAtCeiling, false);
  assert.ok(summary.tokenRuler.solved !== null, "ask 0 + ask 1 solved the two densities");
  assert.deepEqual(summary.tokenRuler.solved.solvedFrom, [0, 1]);
  assert.ok(Math.abs(summary.tokenRuler.solved.rTool - 4.93) < 0.01,
    `rTool ${String(summary.tokenRuler.solved.rTool)}`);
  assert.ok(Math.abs(summary.tokenRuler.solved.rText - 3.75) < 0.01);
  assert.equal(records[0].tokenRuler.predictedTokens, null);
  assert.equal(records[0].tokenRuler.rulerModel, "single");
  assert.equal(records[0].tokenRuler.deltaPercent, null,
    "ask 0 has no prediction; it calibrates instead");
  assert.equal(records[1].tokenRuler.rulerModel, "single",
    "ask 1 is banded on the single ratio, not on a solve that does not exist yet");
  assert.equal(records[1].tokenRuler.solvedFrom, null);
  assert.ok(Number.isFinite(records[1].tokenRuler.deltaPercent),
    "ask 1 records its delta as reporting");
  for (const record of records.slice(1)) {
    assert.ok(Number.isFinite(record.tokenRuler.deltaPercent),
      `ask ${String(record.askIndex)} records deltaPercent on every send`);
    assert.equal(record.tokenRuler.drift, null,
      `ask ${String(record.askIndex)} is inside the drift line, so no marker`);
  }
  for (const record of records.slice(2)) {
    assert.equal(record.tokenRuler.rulerModel, "two-density");
    assert.deepEqual(record.tokenRuler.solvedFrom, [0, 1]);
    assert.ok(Math.abs(record.tokenRuler.rTool - 4.93) < 0.01);
    assert.ok(Math.abs(record.tokenRuler.deltaPercent) <= 10,
      `ask ${String(record.askIndex)} stays inside the drift line`);
  }
});

test("a 1-row table missing at ask 3 (10-25% short) records within-gross-band and continues",
  async () => {
  // Each unit is ~2.8 kB; dropping the most recent tool turn takes ~2.8 kB of
  // text, which the solved 3.75 B/token text ruler counts as ~760 tokens — more
  // than 10% of the prediction and less than the 25% gross band. The band
  // records the drift and the run continues: the exact body is established by
  // the prompt bytes sent and the body hash, not by the tokenizer's residual.
  const rows = [{ type: "session", id: "session-two-density-short" }, headerRow(0),
    systemRow(1), lineRow(2, 1, 15), lineRow(3, 2, 15), lineRow(4, 3, 15), lineRow(5, 4, 15)];
  const events = [];
  const records = [];
  const summary = await runLane({ transcript: rows,
    depths: [{ step: 1, tokens: 1_000 }, { step: 2, tokens: 2_000 },
      { step: 3, tokens: 3_000 }, { step: 4, tokens: 4_000 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: twoDensityTransport({ rTool: 5, rText: 3.75,
      answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })),
      mutate: ({ messages, ask }) => (ask === 3
        ? messages.slice(0, -2).concat(messages.slice(-1)) : messages),
      onSend: event => events.push(event) }),
    askCeiling: 8, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.asks, 4, "the 21%-short send does not stop the run");
  assert.equal(summary.refusedSends, 0);
  const solved = summary.tokenRuler.solved;
  assert.notEqual(solved, null);
  const sent = events.find(event => event.ask === 3);
  assert.ok(Number.isSafeInteger(sent?.fullBytes));
  const predicted = predictPromptTokensOf({ toolBytes: sent.toolBytes,
    textBytes: sent.fullBytes - sent.toolBytes, rTool: solved.rTool, rText: solved.rText });
  const shortfall = predicted - sent.promptTokens;
  assert.ok(Math.abs(shortfall - 760) <= 100,
    `the missing row is ~760 tokens (${shortfall.toFixed(0)})`);
  assert.ok(shortfall / predicted > 0.1,
    "and it is more than 10% of the prediction");
  assert.ok(shortfall / predicted <= 0.25,
    "and inside the 25% gross band, so the send continues");
  const third = records.find(record => record.askIndex === 3);
  assert.ok(third !== undefined);
  assert.equal(third.tokenRuler.drift, "within-gross-band",
    "the 10-25% region is recorded, never refused");
  assert.ok(Math.abs(third.tokenRuler.deltaPercent) > 10
    && Math.abs(third.tokenRuler.deltaPercent) <= 25,
  `ask 3 delta ${String(third.tokenRuler.deltaPercent)}`);
});

test("a run whose two-point solve is degenerate records rulerFallback and keeps the single ratio",
  async () => {
    const rows = [{ type: "session", id: "session-two-density-fallback" }, headerRow(0),
      systemRow(1), lineRow(2, 1), lineRow(3, 2), lineRow(4, 3)];
    let ratio = null;
    let firstSend = null;
    const records = [];
    const summary = await runLane({ transcript: rows,
      depths: [{ step: 1, tokens: 1_000 }, { step: 2, tokens: 2_000 },
        { step: 3, tokens: 3_000 }],
      lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
      transport: twoDensityTransport({
        answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })),
        count: ({ ask, sentBytes, toolBytes }) => {
          if (ask === 0) {
            ratio = sentBytes / 1_500;
            firstSend = { sentBytes, toolBytes };
            return 1_500;
          }
          // 2% above the TEXT growth ratio: the single-ratio band still accepts
          // it (about +7%), but n1/n0 now exceeds x1/x0, so rTool solves
          // non-positive and the two-point system has no ruler.
          if (ask === 1) {
            const x0 = firstSend.sentBytes - firstSend.toolBytes;
            const x1 = sentBytes - toolBytes;
            return Math.round(1_500 * (x1 / x0) * 1.02);
          }
          return Math.round(sentBytes / ratio);
        } }),
      askCeiling: 8, deadline: Date.now() + 60_000,
      onRecord: record => records.push(record) });
    assert.equal(summary.asks, 3, "the fallback never stops the run");
    assert.equal(summary.tokenRuler.solved, null);
    assert.equal(summary.tokenRuler.rulerFallback, true);
    assert.equal(summary.tokenRuler.fallbackReason, "non-positive-ruler");
    const third = records[2];
    assert.equal(third.anchorRuler, "first-send", "the single ratio is the ruler");
    assert.equal(third.tokenRuler.rulerModel, "single");
    assert.equal(third.tokenRuler.rulerFallback, true);
    assert.equal(third.tokenRuler.rTool, null);
    assert.equal(third.tokenRuler.predictedTokens,
      Math.round(third.promptWireBytes / summary.tokenRuler.bytesPerToken));
  });

test("a refusal writes a partial result with the verbatim reason and the records so far",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sim-live-partial-"));
    try {
      const rows = [{ type: "session", id: "session-partial-result" }, headerRow(0),
        systemRow(1), lineRow(2, 1), lineRow(3, 2), lineRow(4, 3)];
      const records = [];
      let refused = null;
      const error = await runLane({ transcript: rows,
        depths: [{ step: 1, tokens: 1_000 }, { step: 2, tokens: 2_000 },
          { step: 3, tokens: 3_000 }],
        lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
        transport: twoDensityTransport({
          answerOf: (ask, indices) => verdictsFor(indices, () => ({ keepall: true })),
          count: ({ ask, sentBytes, toolBytes }) => {
            const predicted = toolBytes / 5 + (sentBytes - toolBytes) / 3.75;
            return Math.round(ask === 2 ? predicted * 3 : predicted);
          } }),
        askCeiling: 8, deadline: Date.now() + 60_000,
        onRecord: record => records.push(record),
        onRefusal: event => { refused = event; } }).then(() => null, caught => caught);
      assert.ok(error instanceof SimBatchUnitsRefusal
        && error.code === "sim-batch-provider-band-gross");
      assert.equal(refused?.askIndex, 2);
      assert.equal(records.length, 2, "asks 0 and 1 wrote records; ask 2 refused");
      const partial = partialResultOf({
        head: { mode: "batch", route: ROUTE, transport: "deepseek", live: true },
        records, refusal: error.message, refusedAtAsk: refused.askIndex,
        summary: refused.summary,
      });
      const target = path.join(dir, "batch-1.json");
      writeResultArtifact({ target, output: partial });
      assert.equal(existsSync(target), true, "the artifact exists even on exit 2");
      const read = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(read.refused, true);
      assert.equal(read.refusedAtAsk, 2);
      assert.equal(read.refusal, error.message,
        "the reason is verbatim, code and numbers included");
      assert.match(read.refusal,
        /^sim-batch-provider-band-gross: provider prompt_tokens \d+ is [\d.]+% above the \d+ two-density prediction for ask 2 \(delta \+\d+ tokens\)/);
      assert.equal(read.records.length, 2, "the records written so far are in the artifact");
      assert.equal(read.summary.asks, 3, "the live summary at the refusal rides beside them");
      assert.equal(read.citable, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("the CLI writes an artifact on exit 2, before any send", () => {
  // A lane over zero eligible units refuses inside `runLane`, after the kill
  // timer and the evidence directory exist. Exit 2 must still leave the partial
  // result on disk, not just a line on stderr.
  const dir = mkdtempSync(path.join(tmpdir(), "sim-live-partial-cli-"));
  try {
    const transcript = path.join(dir, "t.jsonl");
    const usage = path.join(dir, "u.json");
    writeFileSync(transcript, [
      { type: "session", id: "session-partial-cli" },
      { type: "step/start", seq: 1, data: { step: 1 } },
      { type: "tool/result", seq: 2, data: { step: 1,
        content: [{ type: "text", text: "short" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(usage, JSON.stringify({ rows: [{ step: 1, inputTokens: 1_000,
      cacheReadTokens: 0, outputTokens: 10, totalTokens: 1_010 }] }));
    const out = path.join(dir, "out");
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
      "--transport", "stub", "--ignore-host-prunes", "--allow-zero-reasoning",
      "--floor", "100", "--lanes", "1", "--ask-ceiling", "2", "--token-grant", "10000000",
      "--transcript", transcript, "--usage", usage, "--out", out],
    { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 2, result.stderr);
    const target = path.join(out, "batch-1.json");
    assert.equal(existsSync(target), true, "the partial result exists even on exit 2");
    const read = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(read.refused, true);
    assert.equal(read.refusedAtAsk, null, "no ask had been attempted");
    assert.match(read.refusal, /^sim-batch-eligible-empty: /);
    assert.deepEqual(read.records, []);
    assert.equal(read.summary, null);
    assert.equal(read.killTimer.armedMs, 0);
    assert.equal(read.killTimer.timer, "off", "the default run arms no wall-clock timer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLane batch mode fires the append at its step and the replacement at its entry", async () => {
  // The replacement carries the original's stale `data.step: 1` but enters at 4.
  // The fire that tables it must be at 4; an earlier fire would ask about a row
  // that is not in the context.
  // Bodies over the 512 B floor, so the segment pins' host-replacement pairing
  // sees both units (two quotable lines each).
  const bodyOf = name => Array.from({ length: 3 },
    (_, at) => `${name} line ${String(at + 1)} ${"x".repeat(200)}`).join("\n");
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "tool/result", seq: 2, surfaceOp: "append",
      data: { step: 1, message: { content: [{ type: "text",
        text: bodyOf("ORIGINAL") }] } } },
    { type: "step/start", seq: 3, data: { step: 2 } },
    { type: "compaction/prune", seq: 4, data: { shadowedSeqs: [2], shadowedTokenCount: 20 } },
    { type: "step/start", seq: 5, data: { step: 4 } },
    { type: "tool/result", seq: 6, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
      data: { step: 1, message: { content: [{ type: "text",
        text: bodyOf("REPLACEMENT") }] } } },
    { type: "session", seq: 7, id: "session-live-replacement" },
  ];
  const records = [];
  await runLane({ transcript: rows, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 },
    { step: 3, tokens: 30 }, { step: 4, tokens: 40 }, { step: 5, tokens: 50 }],
  lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: false, allowZeroReasoning: true,
  transport: forgetAllTransport(), askCeiling: 2, grammar: "3option",
  deadline: Date.now() + 60_000,
  onRecord: record => records.push(record) });
  assert.equal(records.length, 2, "one fire for the append, one for the replacement");
  assert.deepEqual(records.map(record => record.fireStep), [1, 4],
    "the append at its own step, the replacement at its entry step, never the stale 1");
  // The TIME-AWARE stream tables the append at step 1 (the host prune lands at
  // step 2, so the surface held it), then the replacement at its entry. The
  // second prompt does not carry the append: the host had removed it.
  assert.deepEqual(records[0].rows.map(row => row.unitId), ["result:2"]);
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:6"]);
  assert.equal(records[1].batchSize, 1);
});

test("runLane refuses an undeclared reconstruction of a real prune-carrying recording", t => {
  if (!requirePinnedWorld(t)) return;
  // The auditor's case at the run level: the pruner-off world has zero events,
  // but the source world inside the segment carries 67 (132 in the recording);
  // without --reconstruction it is refused as a product measurement before any send.
  return assert.rejects(runLane({ transcript: DEFAULT_TRANSCRIPT,
    depths: depthsInSegment(readUsage(DEFAULT_USAGE), 139), lane: 8, mode: "batch",
    segment: 139, ignoreHostPrunes: true, transport: stubTransport(), askCeiling: 1,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-zero-prune-gate"
    && /carries 67 compaction\/prune event/.test(error.message));
});

test("runLane applies the segment pins, not only main", async () => {
  // The auditor's point: a test that calls runLane directly used to skip
  // assertSegmentPins. A one-row world claiming segment 139 must fail the pin
  // gate by name before any send.
  const rows = [{ type: "session", id: "session-pins-in-runlane" },
    { type: "step/start", seq: 0, data: { step: 1 } }, lineRow(1, 1)];
  const base = { transcript: rows, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, segment: 139, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport: stubTransport(), askCeiling: 1,
    deadline: Date.now() + 60_000 };
  // A ROW ARRAY carries no file hash, so a pinned claim on one refuses before
  // any count or stated pair is read.
  await assert.rejects(runLane(base), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-rows-unpinned");
  const dir = mkdtempSync(path.join(tmpdir(), "sim-live-pins-"));
  try {
    const file = path.join(dir, "session.v4.jsonl");
    writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    // A file timeline with no input names no usage file.
    await assert.rejects(runLane({ ...base, transcript: file }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-absent");
    // A stated transcript hash that is not the file's own refuses, even when the
    // usage half is stated: the rows and the hash must come from the same bytes.
    await assert.rejects(runLane({ ...base, transcript: file,
      input: { transcriptSha256: "0".repeat(64), usageSha256: "0".repeat(64) } }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-pins-input-mismatch"
      && /is not the hash of the file that was read/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLane refuses a run with zero eligible units before the loop", async () => {
  const transcript = [{ type: "session", id: "session-empty-eligible" }, lineRow(1, 1)];
  await assert.rejects(runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1_000_000, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport: stubTransport(), askCeiling: 1,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-eligible-empty"
    && /no eligible unit at floor/.test(error.message));
});

test("runLane refuses a run whose every tabled row was refused", async () => {
  const transcript = [{ type: "session", id: "session-all-refused" }, lineRow(1, 1)];
  const refuses = { name: "refuses", live: false,
    ask: async () => ({ ok: true, httpStatus: null, latencyMs: 0, content: "{}",
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) };
  await assert.rejects(runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: refuses, askCeiling: 1, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-no-decided-row"
    && /every tabled row was refused/.test(error.message));
});

test("--ask-ceiling counts asks, not sends: a correction never spends a slot", async () => {
  // Two one-row fires. The first ask's first pass names a span past the row's
  // end, so it earns the ONE correction send; the correction heals. With a
  // ceiling of 2 the second fire must still run: asks 2, sends 3.
  let calls = 0;
  const transport = { name: "correcting", live: false,
    ask: async ({ ask, indices }) => {
      calls += 1;
      const content = ask === 0 && calls === 1
        ? JSON.stringify({ 1: { keeplines: [[1, 99], "past the end"] } })
        : JSON.stringify(Object.fromEntries(indices.map(index => [index, { keepall: true }])));
      return { ok: true, httpStatus: null, latencyMs: 0, content,
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    } };
  const transcript = [{ type: "session", id: "session-ceiling-asks" },
    lineRow(1, 1), lineRow(2, 3)];
  const records = [];
  const summary = await runLane({ transcript, depths: [{ step: 1, tokens: 10 },
    { step: 2, tokens: 20 }, { step: 3, tokens: 30 }], lane: 1, mode: "batch", floor: 1,
    ignoreHostPrunes: true, allowZeroReasoning: true, transport, askCeiling: 2, grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(summary.asks, 2, "two fires ran");
  assert.equal(summary.sends, 3, "the first fire spent two sends (answer + correction)");
  assert.equal(summary.stoppedAtCeiling, false, "the correction did not spend the second slot");
  // The correction send is PAID, so it is its own record, its own band and in
  // the peaks (audit 5, item 4): it can never be absent from the run.
  assert.equal(records.length, 3, "two fire records plus the correction's own");
  const correctionRecord = records.find(record => record.kind === "correction");
  assert.ok(correctionRecord !== undefined, "the correction send has a record");
  assert.equal(correctionRecord.correctionOf, 0);
  assert.equal(correctionRecord.ok, true);
  assert.ok(correctionRecord.promptBytes > records[0].promptBytes,
    "the correction carries the reply and the correction text on top of the prompt");
  assert.ok(correctionRecord.promptBytes <= summary.promptPeakBytes,
    "the correction's size is in the run's peak");
  assert.ok(correctionRecord.promptWireBytes <= summary.promptPeakWireBytes);
  assert.equal(correctionRecord.fidelity.ruler, "provider");
  assert.equal(summary.fidelityProvider, 3, "every send's band is graded and counted");
  assert.equal(summary.promptTokens, 300, "all three sends' usage is summed, correction included");
  assert.equal(summary.usageRuler, "provider",
    "a transport that reports no synthetic ruler is a provider reading");
  assert.deepEqual(summary.estimatedTokens,
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    "nothing synthetic lands in the provider run's estimated bucket");
});

test("--ask-ceiling 0 (the default) runs the lane to its natural end", async () => {
  // Owner ruling 2026-11-08: 0 means no ask-count ceiling. Five units with a
  // one-row batch lane are five fires, and an omitted ceiling must not stop
  // before the last one.
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const transcript = [{ type: "session", id: "session-no-ceiling" },
    lineRow(1, 1), lineRow(2, 2), lineRow(3, 3), lineRow(4, 4), lineRow(5, 5)];
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400], [5, 500]]),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 5, "all five fires ran");
  assert.equal(summary.triggers, 5);
  assert.equal(summary.stoppedAtCeiling, false, "0 is no ceiling");
  assert.equal(summary.stoppedAtBudget, false, "no grant was set on this direct call");
  const line = summaryLineOf(summary,
    { askCeiling: 0, tokenGrant: null, semantics: "incremental", firstFireDepth: null });
  assert.doesNotMatch(line, /TRUNCATED/, "a run with no cap is never labelled capped");
});

test("a positive --ask-ceiling still stops the lane and labels TRUNCATED", async () => {
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const transcript = [{ type: "session", id: "session-positive-ceiling" },
    lineRow(1, 1), lineRow(2, 2), lineRow(3, 3)];
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300]]),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 1, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 1, "the ceiling stopped the lane after one ask");
  assert.equal(summary.stoppedAtCeiling, true);
  assert.equal(summary.stoppedAtBudget, false);
  const line = summaryLineOf(summary,
    { askCeiling: 1, tokenGrant: null, semantics: "incremental", firstFireDepth: null });
  assert.match(line, /^\[summary\] TRUNCATED: stopped at the ask ceiling 1 after 1 ask\(s\)/u);
});

test("the token grant stops the lane when the spend reaches it", async () => {
  // One scripted send bills 110 tokens; a 50-token grant is exhausted by the
  // first fire, so the second fire is stopped BEFORE it is counted as an ask and
  // the unsent units are carried.
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const transcript = [{ type: "session", id: "session-budget-stop" },
    lineRow(1, 1), lineRow(2, 2), lineRow(3, 3)];
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300]]),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, tokenGrant: 50, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 1, "the first fire ran; the budget stopped the second");
  assert.equal(summary.triggers, 1, "a budget stop is not a trigger");
  assert.equal(summary.stoppedAtBudget, true);
  assert.equal(summary.stoppedAtCeiling, false);
  assert.equal(summary.carried, 2, "the two unsent units are carried");
  assert.ok(summary.incompleteReasons.includes("stopped-at-budget"));
  assert.ok(summary.measurement.reasons.includes("stopped-at-budget"));
  const line = summaryLineOf(summary,
    { askCeiling: 0, tokenGrant: 50, semantics: "incremental", firstFireDepth: null });
  assert.match(line, /^\[summary\] TRUNCATED: stopped at the token budget 50 after 110 token\(s\)/u);
});

test("a run without --token-grant is refused: the budget is not optional", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
    "--ignore-host-prunes"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sim-batch-token-grant-required/);
  assert.match(result.stderr, /10000000 for a sim run/);
});

test("a failed correction applies no row and marks the fire unanswered", async () => {
  // Fourteenth audit item 3: the first pass carries an ARITHMETIC-invalid row
  // (a span past its line count), so the one correction send is earned; that
  // send fails. The old code left `parsed` as the first pass and applied BOTH
  // rows — shaping a body the arithmetic reader had rejected. Now the whole
  // fire is unanswered: nothing is applied, the surface does not move (the
  // digest gate would refuse a shaped surface), and the refusal is counted.
  let calls = 0;
  const transport = { name: "correction-fails", live: false,
    ask: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, httpStatus: null, latencyMs: 0,
          content: JSON.stringify({
            1: { keeplines: [[1, 99], "past the end"] },
            2: { forgetall: "drop the second body" },
          }),
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
      }
      return { ok: false, failure: "transport", error: "no socket",
        usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 } };
    } };
  const records = [];
  const summary = await runLane({
    transcript: [{ type: "session", id: "session-correction-fails" },
      lineRow(1, 1), lineRow(2, 2)],
    depths: depthsFrom([[1, 100], [2, 200]]),
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 1, grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(summary.asks, 1, "one fire");
  assert.equal(summary.sends, 2, "the answer plus its one correction");
  assert.equal(summary.unansweredFires, 1, "the fire is counted unanswered");
  assert.equal(summary.refusedSends, 1, "the failed correction is a refused send");
  assert.equal(summary.correctionFailedFires, 1, "the refusal has its own count");
  assert.equal(summary.correctionFailedRows, 2, "and a row count that made it so");
  assert.equal(summary.keep + summary.forget + summary.keeplines, 0,
    "no answered row was banked as an arm's decision");
  assert.equal(summary.decidedRows, 0, "the decision log gained nothing");
  assert.equal(summary.appliedForgets, 0, "no forget reached the surface");
  assert.equal(summary.bytesFreedByPolicy, 0, "and nothing was booked");
  const record = records.find(entry => entry.kind !== "correction");
  assert.equal(record.ok, true, "the first send did answer");
  assert.equal(record.correction.ok, false, "the correction did not");
  assert.equal(record.correctionFailed, true);
  assert.equal(record.unappliedRows, 2, "both tabled rows were left unapplied");
  assert.equal(record.appliedForgets, 0);
  assert.equal(record.distribution.forget, 1,
    "the record still states what the answer SAID, beside what was applied");
  assert.ok(summary.incompleteReasons.includes("unanswered-fires"));
  assert.ok(summary.incompleteReasons.includes("refused-sends"));
  assert.equal(summary.complete, false, "an unanswered fire is never a complete sample");
});

test("the live path records depthOverflow where it clamps at zero", async () => {
  // A fire at step 2 removes an 8,000 B body (τ → 2,590 tokens). The step-3
  // measured window is only 1,000 tokens, so the reduced depth is negative: the
  // live lane clamps at 0 AND flags it, exactly as the plan does. Before the fix
  // the live path clamped silently and only the plan carried the flag.
  const transcript = [{ type: "session", id: "session-overflow" },
    resultRow(1, 1, 8000), lineRow(2, 2)];
  const depths = [{ step: 1, tokens: 1000 }, { step: 2, tokens: 5000 },
    { step: 3, tokens: 1000 }, { step: 4, tokens: 1000 }, { step: 5, tokens: 1000 }];
  const summary = await runLane({ transcript, depths, lane: 0, mode: "threshold",
    threshold: 3000, floor: 100, ignoreHostPrunes: false,
    hostPrunerFlag: "--allow-host-pruner", allowZeroReasoning: true,
    transport: forgetAllTransport(), askCeiling: 4, grammar: "3option",
    deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 1, "one fire, then the clamped window holds");
  assert.equal(summary.depthOverflow, true, "the clamp is recorded, not silent");
});

test("the live CLI refuses a paid run with the host pruner on, and a log without --segment", t => {
  // The second spawn reads the DEFAULT world before it can reach the segment
  // refusal, so this case is pinned-world-dependent and skips with the others.
  if (!requirePinnedWorld(t)) return;
  const paid = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "deepseek",
    "--allow-host-pruner"], { encoding: "utf8" });
  assert.equal(paid.status, 2);
  assert.match(paid.stderr, /sim-batch-deepseek-host-pruner/);
  const noSegment = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
    "--ignore-host-prunes", "--token-grant", "10000000"], { encoding: "utf8" });
  assert.equal(noSegment.status, 2);
  assert.match(noSegment.stderr, /sim-batch-segment-required/);
});

// ---- the surface identity is a stamp AND the removals (audit 5, item 5) ----

test("the surface identity needs the shaped count, not only the fire stamp", () => {
  // An empty surface at fire 0 is legal and has no removals.
  const empty = assertSurfaceAdvanced({ surface: simulateSurface(), fire: 0, shaped: 0 });
  assert.deepEqual({ fire: empty.fire, shaped: empty.shaped }, { fire: 0, shaped: 0 });
  assert.match(empty.digest, /^[0-9a-f]{64}$/u, "the check returns a content digest too");
  // The auditor's case: `simulateSurface({fireIndex: n})` built fresh at fire n
  // matches the stamp and holds no removals. The size check against the
  // decision log's rebuild refuses it (eleventh audit: the check reads the
  // CURRENT size, not a second counter the writer increments).
  assert.throws(() => assertSurfaceAdvanced({ surface: simulateSurface({ fireIndex: 2 }),
    fire: 2, shaped: 3, expectedSize: 3 }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-surface-removals"
    && /fresh simulateSurface\(\{fireIndex: 2\}\) passes the fire stamp/.test(error.message));
  // The stamp is still checked: a surface from another fire refuses first.
  assert.throws(() => assertSurfaceAdvanced({ surface: simulateSurface({ fireIndex: 1 }),
    fire: 2, shaped: 0 }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-surface-identity");
  // The COUNT agrees and the BODIES do not: a count-only check passed two
  // different surfaces. The digest compares a surface REBUILT from the decision
  // log to the surface's own, never a map the same writer filled.
  const surface = simulateSurface();
  surface.set(3, "summary B\n[racoons] kept 0 of 10 lines · necromancy id-b");
  const expected = new Map([[3, "summary A\n[racoons] kept 0 of 10 lines · necromancy id-a"]]);
  // The shaped COUNT agrees (the surface's own removal count is 0 and the run
  // applied 0 here); the bodies differ, so the digest refuses.
  assert.throws(() => assertSurfaceAdvanced({ surface, fire: 0, shaped: 0,
    expectedDigest: surfaceDigestOf(expected) }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-digest"
    && /the shaped count agrees and the bodies do not/.test(error.message));
  // The same bodies in the same order pass.
  assert.doesNotThrow(() => assertSurfaceAdvanced({ surface, fire: 0, shaped: 0,
    expectedDigest: surfaceDigestOf(new Map([[3,
      "summary B\n[racoons] kept 0 of 10 lines · necromancy id-b"]])) }));
});

test("the independent digest refuses a shaped body altered on ONE side only", () => {
  const transcript = [{ type: "session", id: "session-independent-digest" },
    { type: "tool/result", seq: 3, data: { step: 1, message: { content: [{ type: "text",
      text: "alpha one\nbeta two\ngamma three" }] } } }];
  const timeline = readTimeline(transcript);
  const units = timeline.units;
  const decision = { momentId: "result:3", fireStep: 1,
    action: "forgetall", summary: "gone" };
  const rebuilt = reconstructedSurfaceOf({ timeline, units, decisions: [decision] });
  assert.equal(rebuilt.size, 1, "the decision log describes one shaped turn");
  const surface = simulateSurface();
  applyFireToSurface({ surface, timeline, units,
    rows: [{ status: "answered", answer: decision }], fireStep: 1 });
  // Both sides agree first.
  assert.doesNotThrow(() => assertSurfaceAdvanced({ surface, fire: 1, shaped: 1,
    expectedDigest: surfaceDigestOf(rebuilt) }));
  // The surface's body changes; the decision log does not. A digest taken from
  // the writer's own applied map would have moved with it and passed.
  surface.set(3, `${String(surface.get(3))}!`);
  assert.throws(() => assertSurfaceAdvanced({ surface, fire: 1, shaped: 1,
    expectedDigest: surfaceDigestOf(rebuilt) }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-digest"
    && /the shaped count agrees and the bodies do not/.test(error.message),
  "one changed byte on the surface only refuses by digest");
});

test("the carry set must equal the decision log's shaped set after every fire", () => {
  assert.doesNotThrow(() => assertCarrySetMatches({ carrySeqs: [3, 5], shapedNow: [3, 5],
    fire: 2 }));
  assert.throws(() => assertCarrySetMatches({ carrySeqs: [3, 5], shapedNow: [3],
    fire: 2 }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-carry-set-mismatch"
    && /the carry set is \[3, 5\] but the decision log's shaped set is \[3\]/.test(error.message));
});

// ---- every tabled row is in the prompt (audit 5, item 5) -------------------

test("a tabled row absent from the built messages refuses by name", () => {
  assert.deepEqual(assertBatchInPrompt({ units: [{ seq: 4 }, { seq: 5 }],
    turnSeqs: [null, 4, 5, null], fireStep: 9 }), { tabled: 2, rendered: 2 });
  assert.throws(() => assertBatchInPrompt({ units: [{ seq: 4 }, { seq: 7 }],
    turnSeqs: [null, 4, null], fireStep: 9 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-batch-unrendered"
    && /carry no turn for seq 7/.test(error.message));
});

// ---- citable is an explicit reason list (audit 3, item 1) -------------------

test("citable is a reason list: every reason, in one canonical order", () => {
  assert.deepEqual(CITABLE_REASONS, ["stopped-at-ceiling", "stopped-at-budget",
    "zero-reasoning-void-comparison",
    "host-pruner-on", "reconstruction", "stub-transport", "stand-in-context",
    "dropped-parts", "dropped-rows", "system-absent", "system-unreadable", "text-source",
    // The eleventh audit's two additions: a recording whose tools vanished (P2)
    // and a depth reading whose cache shape rests on its own statement (P5).
    "tools-absent", "usage-shape-unverified",
    "synthetic-ruler", "sim-only-arm", "non-default-grammar", "sim-only-trigger",
    "sim-only-ask-scope",
    "first-fire-depth", "batch-lane", "segment-cut",
    "non-default-floor", "no-ask", "refused-sends", "no-answered-rows",
    "refused-rows", "depth-overflow", "carried-units", "reasoning-never-sent",
    "input-deviation"]);
  // NO sim run is ever citable outright: the context it sends is a stand-in, not
  // the host's wire, and the body it reads is decoded JSON text, not the
  // capture's bytes (P1). A clean arithmetic run still carries both.
  assert.deepEqual(citableReasonsOf({ live: true, asks: 2, triggers: 2, answeredRows: 3 }),
    ["stand-in-context", "text-source"]);
  // P1: `citableForStandIn` subtracts ONLY the stand-in WIRE reason. The
  // decoded-text reading is retained, so the state is never empty.
  assert.deepEqual(citableReasonsOf({ live: true, asks: 2, triggers: 2, answeredRows: 3 })
    .filter(reason => reason !== "stand-in-context"), ["text-source"],
  "the decoded-text reading is a content dimension, retained past the stand-in reason");
  // The P1 image case in miniature: a carried row that lost parts keeps its
  // reason after the stand-in reason is subtracted.
  assert.deepEqual(citableReasonsOf({ live: true, asks: 1, triggers: 1, answeredRows: 1,
    droppedParts: 2 }).filter(reason => reason !== "stand-in-context"),
  ["dropped-parts:2", "text-source"],
  "a dropped image/file part cannot read clean under citableForStandIn");
  assert.deepEqual(citableReasonsOf({ live: true, asks: 1, triggers: 1, answeredRows: 1,
    droppedRows: 3 }).filter(reason => reason !== "stand-in-context"),
  ["dropped-rows:3", "text-source"],
  "a row surfaceAt skipped whole cannot read clean under citableForStandIn");
  // A missing or unreadable system slot is a dropped turn of its own name.
  assert.deepEqual(citableReasonsOf({ live: true, asks: 1, triggers: 1, answeredRows: 1,
    systemAbsent: true }).filter(reason => reason !== "stand-in-context"),
  ["system-absent", "text-source"],
  "an absent system prompt is named, never a silent empty first message");
  assert.deepEqual(citableReasonsOf({ live: true, asks: 1, triggers: 1, answeredRows: 1,
    systemUnreadable: true }).filter(reason => reason !== "stand-in-context"),
  ["system-unreadable", "text-source"],
  "a string-content system message is named `system-unreadable`");
  const cases = [
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, stoppedAtCeiling: true },
      ["stopped-at-ceiling", "stand-in-context", "text-source"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, voidComparison: true },
      ["zero-reasoning-void-comparison", "stand-in-context", "text-source"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, inputHostPruner: "on" },
      ["host-pruner-on", "stand-in-context", "text-source"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, reconstruction: true },
      ["reconstruction", "stand-in-context", "text-source"]],
    [{ live: false, asks: 1, triggers: 1, answeredRows: 1 },
      ["stub-transport", "stand-in-context", "text-source"]],
    [{ live: true, asks: 0, triggers: 0, answeredRows: 0 },
      ["stand-in-context", "text-source", "no-ask", "no-answered-rows"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, refusedSends: 1 },
      ["stand-in-context", "text-source", "refused-sends"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 0 },
      ["stand-in-context", "text-source", "no-answered-rows"]],
    // The sim-only grammars are `forgetlines` and `keeplines-60`; every
    // non-`first` order is sim-only too. `two-option` SHIPS, so it is not a
    // sim-only arm (config.ts accepts it; entry-ask.ts reads it) — but it is
    // NOT the product default, so it is named as a non-default grammar.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, grammar: "two-option" },
      ["stand-in-context", "text-source", "non-default-grammar:two-option"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, grammar: "forgetlines" },
      ["stand-in-context", "text-source", "sim-only-arm", "non-default-grammar:forgetlines"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, grammar: "keeplines-60" },
      ["stand-in-context", "text-source", "sim-only-arm",
        "non-default-grammar:keeplines-60"]],
    // `3option` SHIPS but is not the default: named, never silently default.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, grammar: "3option" },
      ["stand-in-context", "text-source", "non-default-grammar:3option"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, order: "after" },
      ["stand-in-context", "text-source", "sim-only-arm"]],
    // A cadence or scope the product does not have is a reason of its own.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, mode: "threshold",
      thresholdUnits: "depth-tokens" },
      ["stand-in-context", "text-source", "sim-only-trigger:depth-tokens"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, mode: "threshold",
      thresholdUnits: "landed-bytes" },
      ["stand-in-context", "text-source"],
      "landed-bytes is a shipped trigger (core's landedBytesVerdict, P6)"],
    // P9: the product drops failed results before the entry seam too
    // (`plugin.ts` `observe` journals `failed-result`, fed by `toolResultItem`),
    // so an `errorResult` count is a population split and NEVER a reason. The
    // old `sim-only-eligibility:error-result` was a false blocker.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1 }, ["stand-in-context", "text-source"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, askScope: "kept" },
      ["stand-in-context", "text-source", "sim-only-ask-scope:kept"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, firstFireDepth: 40_000 },
      ["stand-in-context", "text-source", "first-fire-depth"]],
    // The shipped asks are not sim-only arms.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, grammar: "jsonl-20", order: "first" },
      ["stand-in-context", "text-source"]],
    // A transport DECLARED live whose bands are synthetic has no provider grader.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, syntheticRuler: true },
      ["stand-in-context", "text-source", "synthetic-ruler"]],
    // Any floor but the product's 512 changes the sample.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, floor: 1280 },
      ["stand-in-context", "text-source", "non-default-floor:1280"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, floor: 512 },
      ["stand-in-context", "text-source"]],
    // Refused ANSWER rows (a parser refusal, not a failed send) and a clamped
    // depth series are reasons with their own names.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, refusedRows: 4 },
      ["stand-in-context", "text-source", "refused-rows:4"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, depthOverflow: true },
      ["stand-in-context", "text-source", "depth-overflow"]],
    // The eligible rows the run never asked, with the count: an incomplete
    // sample is a reason, not a smaller measurement.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, carried: 7 },
      ["stand-in-context", "text-source", "carried-units:7"]],
    // P3: a declared-reasoning run whose sends never carried one is a reason of
    // its own (runLane refuses it by name first).
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, reasoningSent: false },
      ["stand-in-context", "text-source", "reasoning-never-sent"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, reasoningSent: true },
      ["stand-in-context", "text-source"]],
    // Every known input deviation is a reason of its own.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1,
      inputDeviations: [{ id: "x", citationReason: "input-deviation:x" }, { id: "y" }] },
      ["stand-in-context", "text-source", "input-deviation:x", "input-deviation:y"]],
    // P2: the sim's 8-lane default is not the product's configured size (1).
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, mode: "batch", lane: 8 },
      ["stand-in-context", "text-source", "batch-lane:8"]],
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, mode: "batch", lane: 1 },
      ["stand-in-context", "text-source"],
      "the product's own configured size is not a reason"],
    // P3: a segment cut names how many later rows it removed.
    [{ live: true, asks: 1, triggers: 1, answeredRows: 1, segment: 139, excludedRows: 1484 },
      ["stand-in-context", "text-source", "segment-cut:1484"]],
  ];
  for (const [input, reasons] of cases) {
    assert.deepEqual(citableReasonsOf(input), reasons);
  }
  // Every reason a THRESHOLD run can carry, at once, in order: no reason is
  // dropped and no reason is invented. `batch-lane` is batch-only and has its
  // own case above. The counted/derived reasons carry their values.
  assert.deepEqual(citableReasonsOf({ stoppedAtCeiling: true, voidComparison: true,
    inputHostPruner: "on", reconstruction: true, live: true, grammar: "forgetlines",
    syntheticRuler: true, floor: 1, asks: 0, triggers: 2, refusedSends: 1, answeredRows: 0,
    refusedRows: 3, depthOverflow: true, carried: 1,
    inputDeviations: [{ id: "system-model-name" }],
    mode: "threshold", thresholdUnits: "depth-tokens", askScope: "kept",
    firstFireDepth: 40_000, reasoningSent: false,
    lane: 8, segment: 139, excludedRows: 1484, droppedParts: 2, droppedRows: 3 }),
  ["stopped-at-ceiling", "zero-reasoning-void-comparison", "host-pruner-on", "reconstruction",
    "stand-in-context", "dropped-parts:2", "dropped-rows:3", "text-source",
    "synthetic-ruler", "sim-only-arm", "non-default-grammar:forgetlines",
    "sim-only-trigger:depth-tokens",
    "sim-only-ask-scope:kept", "first-fire-depth",
    "segment-cut:1484", "non-default-floor:1", "no-ask",
    "refused-sends", "no-answered-rows", "refused-rows:3", "depth-overflow",
    "carried-units:1", "reasoning-never-sent", "input-deviation:system-model-name"]);
  // `citable` is always false for the sim: `stand-in-context` is unconditional,
  // and `text-source` is retained in `citableForStandIn` (P1), so the state
  // `citable` names is never empty.
  const reasons = citableReasonsOf({ live: false, asks: 1, triggers: 1, answeredRows: 1 });
  assert.deepEqual(reasons.filter(reason => reason !== "stand-in-context"),
    ["stub-transport", "text-source"],
    "citableForStandIn for a stub run is its blockers plus the retained reading");
  // `asks < triggers` is NOT a reason: the counts move together, so the
  // `assertAskTotals` branch is a guard against future drift, never a reachable
  // class today (see the README and the function's docstring).
  assert.deepEqual(citableReasonsOf({ live: true, asks: 1, triggers: 2, answeredRows: 1 }),
    ["stand-in-context", "text-source"]);
  // A deviation with no id is a refusal, not a silently unnamed pass.
  assert.throws(() => citableReasonsOf({ live: true, asks: 1, triggers: 1, answeredRows: 1,
    inputDeviations: [{ detail: "no id" }] }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-input-deviation-invalid");
});

// ---- emitted reasons are validated against the allow-list (P9) --------------

test("an emitted reason not in the allow-list refuses by name", () => {
  assert.deepEqual(assertReasonsAllowed(["stand-in-context", "carried-units:24",
    "batch-lane:8", "segment-cut:1484", "input-deviation:agent-instructions-splice"]),
  ["stand-in-context", "carried-units:24", "batch-lane:8", "segment-cut:1484",
    "input-deviation:agent-instructions-splice"],
  "counted reasons and the one declared deviation id pass");
  assert.throws(() => assertReasonsAllowed(["stand-in-context", "a-new-reason"]), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reason-unknown"
    && /"a-new-reason"/.test(error.message)
    && /not in CITABLE_REASONS/.test(error.message));
  // P6: a base-prefix match used to accept any suffix. The suffix is now
  // validated: counts are non-negative integers, word suffixes are the exact
  // spellings the run emits.
  for (const bogus of ["sim-only-trigger:bogus", "sim-only-ask-scope:new",
    "batch-lane:anything", "carried-units:-3", "carried-units:1.5",
    "dropped-parts:three", "input-deviation:something-else"]) {
    assert.throws(() => assertReasonsAllowed([bogus]), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reason-unknown",
    `"${bogus}" must refuse instead of passing on its base name`);
  }
  // The valid spellings still pass, including a zero count.
  assert.deepEqual(assertReasonsAllowed(["batch-lane:8", "carried-units:0",
    "segment-cut:1484", "dropped-rows:51", "refused-rows:1", "non-default-floor:1",
    "sim-only-trigger:depth-tokens", "sim-only-ask-scope:kept"]),
  ["batch-lane:8", "carried-units:0", "segment-cut:1484", "dropped-rows:51",
    "refused-rows:1", "non-default-floor:1", "sim-only-trigger:depth-tokens",
    "sim-only-ask-scope:kept"]);
  assert.throws(() => assertReasonsAllowed([""]), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reason-invalid");
});

test("a stub run is never citable, whatever its arithmetic says", () => {
  const summary = citableReasonsOf({ live: false, asks: 1, triggers: 1, answeredRows: 1 });
  assert.deepEqual(summary, ["stub-transport", "stand-in-context", "text-source"]);
});

// ---- a failed send and a timeout record the same way (audit 3, item 6) -----

test("a transport failure and a timeout stop, record and carry the same batch", async () => {
  const transcript = [{ type: "session", id: "session-dropped-batch" },
    lineRow(1, 1), lineRow(2, 2), lineRow(3, 3)];
  const run = async failure => {
    const records = [];
    const transport = { name: "fails", live: false,
      ask: async () => ({ ok: false, failure, error: `${String(failure)} on purpose`,
        latencyMs: 1, content: undefined,
        // A failed send can still report usage; it is recorded, never dropped.
        usage: { prompt_tokens: 55, completion_tokens: 0, total_tokens: 55 } }) };
    let error = null;
    let summary = null;
    try {
      summary = await runLane({ transcript, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 20 },
        { step: 3, tokens: 30 }], lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true,
        allowZeroReasoning: true, transport, askCeiling: 5, deadline: Date.now() + 60_000,
        onRecord: record => records.push(record) });
    } catch (thrown) { error = thrown; }
    return { summary, records, error };
  };
  const transportFailure = await run(null);
  const timeout = await run("timeout");
  for (const [label, out] of [["transport", transportFailure], ["timeout", timeout]]) {
    assert.equal(out.error, null, `${label} failure writes a summary, never throws`);
    assert.equal(out.records.length, 1, `${label}: one fire recorded`);
    assert.equal(out.records[0].ok, false);
    assert.equal(out.records[0].droppedUnits, 1, `${label}: the batch size is recorded`);
    assert.equal(out.summary.triggers, 1);
    assert.equal(out.summary.asks, 1, `${label}: the fire was asked, not lost from the count`);
    assert.equal(out.summary.unansweredFires, 1, `${label}: counted as unanswered`);
    assert.equal(out.summary.droppedBatchUnits, 1);
    assert.equal(out.summary.carried, 3, `${label}: the dropped batch is carried, never 0`);
    // A failed send's usage is not thrown away: it is billed and must be recorded.
    assert.equal(out.records[0].promptTokens, 55, `${label}: the failed send's usage is recorded`);
    assert.equal(out.summary.promptTokens, 55, `${label}: and summed into the run`);
    assert.equal(out.summary.citable, false);
    assert.ok(out.summary.measurement.reasons.includes("refused-sends"));
    assert.ok(out.summary.measurement.reasons.includes("no-answered-rows"));
  }
  // The two paths are recorded the same way: same counts, different class.
  assert.deepEqual(
    { ...transportFailure.summary, refusedSends: 0, refusalClasses: {}, failures: [] },
    { ...timeout.summary, refusedSends: 0, refusalClasses: {}, failures: [] });
});

test("a run that asks nothing refuses by name, before any summary", async () => {
  const transcript = [{ type: "session", id: "session-no-ask" }, lineRow(1, 1)];
  await assert.rejects(runLane({ transcript, depths: [{ step: 1, tokens: 10 }],
    lane: 4, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport: stubTransport(), askCeiling: 4, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-no-ask"
    && /asked nothing/.test(error.message));
});

// ---- an ANSWERED reply with no text is a row-level KEEP, never a stop ------

/** The four rows of the no-text lane: distinct bodies, so each is identifiable. */
const NO_TEXT_ROWS = () => [lineRow(1, 1, 10), lineRow(2, 2, 12),
  lineRow(3, 3, 8), lineRow(4, 4, 14)];

/**
 * Four rows at lane 2: two fires. The FIRST reply is the paid pilot's ask 16 —
 * http 200, stream done, ZERO content (a reasoning-only answer, 73 completion
 * tokens); the second answers `keepall` over its rows. The product refuses
 * every tabled row `no-text` -> KEEP (`llm-ask.ts:314`, `batch-ask.ts:197`) and
 * forms the next batch; the lane must do the same instead of stopping.
 */
async function emptyFirstReplyLane() {
  const transcript = [{ type: "session", id: "session-empty-answer" }, systemRow(),
    ...NO_TEXT_ROWS()];
  const seen = [];
  const transport = {
    name: "empty-first", live: false,
    ask: async ({ messages, ask, indices }) => {
      seen.push({ ask, indices, messages });
      if (ask === 0) {
        return { ok: false, answered: true, failure: "parse", httpStatus: 200, latencyMs: 3,
          content: "", error: "stream class parse",
          diagnostics: { done: true, frames: 3, finishReason: "stop", toolCalls: 0 },
          usage: { ruler: "synthetic", prompt_tokens: 1_000, completion_tokens: 73,
            total_tokens: 1_073 } };
      }
      return { ok: true, answered: true, httpStatus: 200, latencyMs: 2, diagnostics: null,
        content: JSON.stringify(verdictsFor(indices, () => ({ keepall: true }))),
        usage: { ruler: "synthetic", prompt_tokens: 1_000, completion_tokens: 10,
          total_tokens: 1_010 } };
    },
  };
  const records = [];
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400]]),
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 4, grammar: "3option", deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  return { summary, records, seen };
}

test("an answered reply with no text refuses its rows and the batch lane continues", async () => {
  const { summary, records } = await emptyFirstReplyLane();
  assert.equal(summary.asks, 2, "the lane reached the second batch instead of stopping");
  assert.equal(summary.sends, 2, "one send per fire, no retries");
  assert.equal(summary.stoppedAtCeiling, false, "the lane exhausted its units, not the ceiling");
  assert.equal(summary.refusedSends, 0, "an ANSWERED reply is not a failed send");
  assert.equal(summary.droppedBatchUnits, 0, "nothing was dropped");
  assert.equal(summary.unansweredFires, 1, "the no-text fire is counted unanswered");
  assert.equal(summary.parseRefusedFires, 1);
  assert.equal(summary.parseRefusedRows, 2, "both tabled rows were refused");
  assert.equal(summary.refused, 2);
  assert.deepEqual(summary.incompleteReasons, ["unanswered-fires", "refused-rows:2"],
    "the run names the unanswered fire and the refused rows");
  assert.equal(summary.complete, false, "a refused row keeps the sample incomplete");
  assert.equal(summary.carried, 0, "a refused row was ASKED: it is not carried");
  assert.equal(summary.decidedRows, 2, "only the second fire's rows are decisions");
  assert.deepEqual(summary.removalBookings, [], "a refusal books no removal");
  assert.equal(summary.fidelitySynthetic, 2, "both fake-stub sends are graded synthetically");
  assert.equal(summary.estimatedTokens.completionTokens, 83,
    "the no-text send's paid usage is recorded and summed, never dropped");
  assert.equal(records.length, 2, "two fires, two records");
  const refused = records[0];
  assert.equal(refused.parseRefused, true, "the record names the class");
  assert.equal(refused.ok, false, "it did not decide its rows");
  assert.equal(refused.failureClass, "parse");
  assert.equal(refused.refusedRows, 2);
  assert.equal(refused.unappliedRows, 2);
  assert.equal(refused.distribution.refused, 2);
  assert.equal(refused.appliedForgets, 0);
  assert.equal(refused.contentBytes, 0, "the empty answer is stored as empty");
  assert.equal(refused.completionTokens, 73, "the paid send's usage rides its record");
  assert.equal(records[1].parseRefused, undefined, "the second fire answered normally");
  assert.equal(records[1].ok, true);
});

test("a refused row's surface is unchanged byte for byte at the next fire", async () => {
  const { seen } = await emptyFirstReplyLane();
  assert.equal(seen.length, 2, "two requests");
  for (const lines of [10, 12]) {
    const expected = `tool result:\n${lineBodyOf(lines)}`;
    const before = seen[0].messages.filter(message => message.content === expected).length;
    const after = seen[1].messages.filter(message => message.content === expected).length;
    assert.equal(before, 1, `the first prompt carries the landed ${String(lines)}-line body`);
    assert.equal(after, 1,
      `the no-text fire changed nothing: the next prompt carries the SAME`
      + ` ${String(lines)}-line body byte for byte (a shaped turn would differ, a`
      + " marker-only keep would not equal the landed text)");
  }
  assert.ok(seen[1].messages.every(message => !String(message.content).includes("[racoons]")),
    "nothing was shaped by a refusal: no render marker reaches the next prompt");
});

test("only an ANSWERED reply with no text is a refused answer", () => {
  assert.equal(refusedAnswerOf({ failure: "parse", answered: true }), true);
  assert.equal(refusedAnswerOf({ failure: "parse", answered: false }), false,
    "a parse class with no answered claim is not a model answer");
  assert.equal(refusedAnswerOf({ failure: "parse" }), false,
    "a transport that states nothing is never believed");
  assert.equal(refusedAnswerOf({ failure: null, answered: true }), false);
  assert.equal(refusedAnswerOf({ failure: "stream-truncated", answered: false }), false);
  assert.equal(refusedAnswerOf({ failure: "timeout", answered: false }), false);
  assert.equal(refusedAnswerOf({ failure: "length-trip", answered: true }), false,
    "a token-cap trip is its own class, not a no-text answer");
});

test("a non-2xx answer still stops the batch lane", async () => {
  const transcript = [{ type: "session", id: "session-http-500" }, systemRow(),
    ...NO_TEXT_ROWS()];
  const transport = { name: "http-500", live: false,
    ask: async () => ({ ok: false, answered: false, failure: null, httpStatus: 500,
      latencyMs: 4, content: "", error: "http 500: upstream",
      usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 } }) };
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400]]),
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 4, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 1, "a transport failure stops the lane at its first fire");
  assert.equal(summary.refusedSends, 1);
  assert.equal(summary.unansweredFires, 1);
  assert.equal(summary.parseRefusedFires, 0, "it is not an answered no-text reply");
  assert.equal(summary.droppedBatchUnits, 2, "its tabled batch is dropped");
  assert.equal(summary.carried, 4, "the dropped batch, its tail and every later unit");
  assert.ok(summary.measurement.reasons.includes("refused-sends"));
  assert.ok(!summary.incompleteReasons.includes("refused-rows:2"));
});

test("a truncated stream still stops the batch lane", async () => {
  const transcript = [{ type: "session", id: "session-truncated" }, systemRow(),
    ...NO_TEXT_ROWS()];
  // A 200 whose stream never reached `[DONE]`: the reader saw frames and no
  // finish, so the reply is a partial answer, never an answer.
  const transport = { name: "truncated", live: false,
    ask: async () => ({ ok: false, answered: false, failure: "stream-truncated",
      httpStatus: 200, latencyMs: 5, content: "partial",
      diagnostics: { done: false, frames: 2, finishReason: null, toolCalls: 0 },
      error: "stream class stream-truncated",
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } }) };
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400]]),
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 4, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 1, "a cut stream stops the lane");
  assert.equal(summary.refusedSends, 1);
  assert.equal(summary.refusalClasses["stream-truncated"], 1);
  assert.equal(summary.parseRefusedFires, 0);
  assert.equal(summary.carried, 4);
  assert.ok(!summary.incompleteReasons.includes("refused-rows:2"));
});

test("row refusals are classified by the reader's own code in rowRefusalClasses", async () => {
  const transcript = [{ type: "session", id: "session-row-refusal-classes" }, systemRow(),
    lineRow(1, 1, 10), lineRow(2, 2, 12), lineRow(3, 3, 10)];
  // Row 1 names a span past its own 10 lines (`spans-outside-result`, the
  // arithmetic the jsonl-20 reader checks); row 2's line does not parse but
  // still spells its index (`answer-unreadable`); row 3 keeps. Two refused
  // rows, two named codes, one decided row.
  const transport = { name: "row-classes", live: false,
    ask: async () => ({
      ok: true, answered: true, httpStatus: 200, latencyMs: 1, diagnostics: null,
      content: [
        '{"1":{"keeplines":[[1,99]],"summary":"keep the head"}}',
        '{"2":{"keepall":true}',
        '{"3":{"keepall":true}}',
      ].join("\n"),
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) };
  const records = [];
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300]]),
    lane: 3, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 1, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.refused, 2, "two rows the parser refused");
  assert.deepEqual(summary.rowRefusalClasses,
    { "spans-outside-result": 1, "answer-unreadable": 1 },
    "each refused row is booked under its own reader code");
  assert.deepEqual(summary.refusalClasses, {},
    "no send failed: the send-level map stays empty");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].rowRefusalClasses,
    { "spans-outside-result": 1, "answer-unreadable": 1 },
    "the send's record states its own row refusals");
  assert.deepEqual(records[0].rows.map(row => row.code),
    ["spans-outside-result", "answer-unreadable", undefined],
    "the row records carry the same codes the map counts");
});

test("a send refusal books the send class, never a row class", async () => {
  const transcript = [{ type: "session", id: "session-send-class-only" }, systemRow(),
    ...NO_TEXT_ROWS()];
  const records = [];
  const transport = { name: "timeout", live: false,
    ask: async () => ({ ok: false, answered: false, failure: "timeout", httpStatus: 200,
      latencyMs: 900, content: "", error: "the deadline passed",
      usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 } }) };
  const summary = await runLane({ transcript,
    depths: depthsFrom([[1, 100], [2, 200], [3, 300], [4, 400]]),
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 4, grammar: "3option", deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.refusedSends, 1);
  assert.deepEqual(summary.refusalClasses, { timeout: 1 },
    "the failed send is booked under its failureClass");
  assert.deepEqual(summary.rowRefusalClasses, {},
    "a send that read no row books no row class");
  assert.equal(summary.refused, 0, "no row was refused: the whole batch was dropped");
  assert.equal(records.length, 1);
  assert.equal(records[0].failureClass, "timeout");
  assert.deepEqual(records[0].rowRefusalClasses, {},
    "the failed send's record states an empty row map");
});

// ---- the four known input deviations (audit 6, item 6) ---------------------

test("inputDeviations lists only the two DETECTED input deviations", () => {
  const splice = "<system-reminder>\nAdditional instructions from: AGENTS.md\n";
  const timeline = {
    system: "You are powered by the deepseek-v4.1-flash-1017 model.",
    rows: [{ type: "user/message", seq: 5,
      data: { step: 128, content: [{ type: "text", text: splice }] } }],
    entrySteps: new Map([[5, 128]]),
  };
  const deviations = inputDeviationsOf(timeline);
  assert.deepEqual(deviations.map(deviation => deviation.id),
    ["agent-instructions-splice", "system-model-name"],
    "the pinned recording's two detected deviations and nothing else: the stand-in's"
    + " two facts are inside the universal stand-in-context reason, not separate here");
  assert.equal(deviations[0].bytes, Buffer.byteLength(splice, "utf8"),
    "the splice's own byte count, never a constant");
  assert.equal(deviations[0].step, 128);
  assert.equal(deviations[0].seq, 5);
  assert.match(deviations[1].detail, /deepseek-v4\.1-flash-1017/);
  // A synthetic input with neither property claims neither.
  const clean = inputDeviationsOf({ system: "plain", rows: [], entrySteps: new Map() });
  assert.deepEqual(clean, [], "a clean input claims no input deviation");
});

test("the stand-in block counts THIS prompt's dropped parts and names its recall-id source", async () => {
  const transcript = [{ type: "session", id: "session-stand-in" },
    { type: "user/message", seq: 1, data: { step: 1, content: [
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
      { type: "image", source: { type: "base64", data: "BBBB" } },
    ] } },
    { type: "tool/result", seq: 2, data: { step: 1, content: [{ type: "text",
      text: `${"a".repeat(1000)}\n${"b".repeat(999)}` }] } }];
  const records = [];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ transcript, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 2000 }],
    lane: 0, mode: "threshold", threshold: 100, floor: 1, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport, askCeiling: 1, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(records.length, 1);
  const standIn = records[0].contextStandIn;
  assert.deepEqual(standIn.droppedParts, { count: 2, byKind: { image: 2 } },
    "the prompt's own dropped parts, counted by KIND, never a fixed sentence");
  // P1: the carried row lost its image parts, so the state that subtracts the
  // stand-in WIRE reason is NOT empty: the dropped content is its own reason.
  assert.ok(summary.measurement.reasons.includes("dropped-parts:2"),
    "the run's reason list names the dropped parts");
  assert.deepEqual(summary.measurement.citableForStandIn,
    // `tools-absent` is here because this synthetic transcript declares no
    // `request/header` (P2), and `system-absent` because it carries no
    // `system/message` row: both are stated instead of silently sending an
    // empty schema and an empty first message.
    ["zero-reasoning-void-comparison", "stub-transport", "dropped-parts:2",
      "system-absent", "tools-absent",
      "text-source", "sim-only-trigger:depth-tokens", "non-default-floor:1"],
    "a prompt that dropped an image part cannot read clean under citableForStandIn");
  assert.match(standIn.droppedPartsRule, /textOf/);
  assert.match(standIn.recallIdSource, /result:<seq>/);
  assert.match(standIn.recallIdSource, /dsh:<session>:result:<callId>/,
    "the host's id source is stated beside the sim's, so no marker id is read as a host id");
});

// ---- whole-row omissions are counted (P6) -----------------------------------

test("a row surfaceAt skips whole and a string-content turn are droppedRowTypes entries", () => {
  const rows = [
    // Declared parts, no text: surfaceAt's user/assistant branch skips it.
    { type: "user/message", seq: 1, data: { content: [
      { type: "image", source: { type: "base64", data: "AAAA" } }] } },
    // A string body: textOf reads content ARRAYS only, so it reads no text.
    { type: "user/message", seq: 2, data: { content: "a whole string body" } },
    // Carried: real text.
    { type: "user/message", seq: 3, data: { content: [{ type: "text", text: "hello" }] } },
    // Carried for its reasoning even with no text: NOT a whole-row drop.
    { type: "assistant/message", seq: 4, data: { message: { content: [
      { type: "reasoning", text: "thinking" }] } } },
  ];
  const gaps = droppedRowGapsOf(rows);
  assert.equal(gaps.count, 2, "two rows reach no message: one parts-only, one string");
  assert.deepEqual(gaps.labels, [
    "user/message (declared content, no text)",
    "user/message (string content)",
  ]);
  const block = contextStandInOf({ rows, entryAskRows: 0 }, [], []);
  assert.ok(block.droppedRowTypes.includes("user/message (declared content, no text)"),
    "the parts-only row is named as its own droppedRowTypes entry");
  assert.ok(block.droppedRowTypes.includes("user/message (string content)"),
    "the string-content row is named under its own entry");
  assert.deepEqual(block.droppedRows, { count: 2, byKind: {
    "user/message (declared content, no text)": 1,
    "user/message (string content)": 1,
  } }, "the block carries the row-gap count, never only a type list");
});

// ---- the carry assertion (audit 3 item 8; audit 4 item 6) ------------------

test("a prior fire's applied forget must be in the next PROMPT, byte for byte", () => {
  const marker = "[racoons] kept 0 of 10 lines · necromancy abc123";
  const shaped = `the summary\n\nline one\nline two\n${marker}`;
  const surface = new Map([[3, shaped]]);
  const units = [{ id: "result:3", seq: 3, step: 1, text: "the whole landed body" },
    { id: "result:4", seq: 4, step: 2, text: "an untouched body" }];
  const names = new Map([[3, "read a.ts"], [4, "read b.ts"]]);
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: `read a.ts:\n${shaped}` },
    { role: "user", content: "read b.ts:\nan untouched body" },
    { role: "user", content: "ask" },
  ];
  const turnSeqs = [null, 3, 4, null];
  const base = { requiredSeqs: [3], surface, messages, turnSeqs, units, callNames: names,
    fireStep: 4 };
  assert.deepEqual(assertCarriedOverrides(base), { required: 1, overridden: 1 });
  // One byte of the SUMMARY changes and the marker line survives: a marker-only
  // check passed this, the exact-body check refuses it.
  const oneByte = messages.map((message, at) => at === 1
    ? { ...message, content: message.content.replace("the summary", "the summarY") }
    : message);
  assert.throws(() => assertCarriedOverrides({ ...base, messages: oneByte }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-carry-body-mismatch"
    && /for 3 at message 1/.test(error.message)
    && /first difference at byte 21/.test(error.message)
    && /does not carry the exact body/.test(error.message));
  // A non-carried unit's body must equal its landed text exactly: a shaped body
  // smuggled into unit 4 refuses too.
  const smuggled = messages.map((message, at) => at === 2
    ? { ...message, content: `read b.ts:\n${shaped}` }
    : message);
  assert.throws(() => assertCarriedOverrides({ ...base, messages: smuggled }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-carry-body-mismatch"
    && /4 at message 2/.test(error.message));
  // The key is on the map and the marker is NOT in the prompt: a map-key check
  // would pass, this one refuses (the whole message is the landed body).
  assert.throws(() => assertCarriedOverrides({ ...base,
    messages: messages.map((message, at) => at === 1
      ? { ...message, content: "read a.ts:\nthe whole landed body" } : message) }),
  error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-carry-body-mismatch");
  // A carried seq whose turn position holds no message refuses by name, and so
  // does a carried seq the prompt has no turn for at all.
  assert.throws(() => assertCarriedOverrides({ ...base, messages: [messages[0], undefined],
    turnSeqs: [null, 3] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-carry-unrendered");
  assert.throws(() => assertCarriedOverrides({ ...base, messages: [messages[0]],
    turnSeqs: [null] }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-carry-unrendered" && /seq 3/.test(error.message));
  // No shaped body on the surface at all is the other named refusal.
  assert.throws(() => assertCarriedOverrides({ ...base, surface: new Map() }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-carry-missing"
    && /seq 3 shaped/.test(error.message));
  // A caller that passes messages without buildPrompt's turnSeqs cannot bind a
  // body to a turn; the check refuses instead of falling back to a substring.
  assert.throws(() => assertCarriedOverrides({ requiredSeqs: [3], surface, messages, fireStep: 4 }),
    error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-carry-invalid"
    && /turnSeqs/.test(error.message));
});

// ---- the live boundary's ruler is the timeline, not the builder's own count -

test("the boundary refuses a prompt that lost or altered the timeline's reasoning", async () => {
  const assistant = { type: "assistant/message", seq: 1, data: { step: 1, message: {
    content: [{ type: "text", text: "look" }, { type: "reasoning", text: "why" }],
    source: { replayState: { blocks: [{ type: "text" }, { type: "reasoning",
      thinkingSignature: "reasoning_content" }] } } } } };
  const timeline = { reasoningBlocks: 1, rows: [assistant], entrySteps: new Map([[1, 1]]) };
  const base = { name: "capture", live: false, ask: async () => ({ ok: true }) };
  const wireBytes = text => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
  // The builder CLAIMS one turn, but the messages carry none: the timeline is
  // the ruler, so the boundary refuses even though the claim is self-consistent.
  await assert.rejects(withReasoningBoundary(base, timeline).ask({
    messages: [{ role: "user", content: "no reasoning here" }], turnSeqs: [null],
    reasoningMessages: 1, fireStep: 1 }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-reasoning-boundary"
    && /lost, altered or re-attached/.test(error.message));
  // A SAME-LENGTH substitution ("why" -> "wHy") keeps the count and the byte
  // sum; the pair hash is what refuses it.
  await assert.rejects(withReasoningBoundary(base, timeline).ask({
    messages: [{ role: "assistant", content: "look", reasoning_content: "wHy" }],
    turnSeqs: [1], reasoningMessages: 1, reasoningWireBytes: wireBytes("wHy"), fireStep: 1 }),
  error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-boundary"
    && /same-length substitution/.test(error.message));
  // The SAME text on a DIFFERENT turn: the text list is identical, the pair is
  // not, and the boundary refuses.
  await assert.rejects(withReasoningBoundary(base, timeline).ask({
    messages: [{ role: "assistant", content: "look", reasoning_content: "why" }],
    turnSeqs: [2], reasoningMessages: 1, reasoningWireBytes: wireBytes("why"), fireStep: 1 }),
  error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-boundary"
    && /re-attached/.test(error.message));
  // A request with no turn list cannot bind the text to a turn at all.
  await assert.rejects(withReasoningBoundary(base, timeline).ask({
    messages: [{ role: "assistant", content: "look", reasoning_content: "why" }],
    reasoningMessages: 1, reasoningWireBytes: wireBytes("why"), fireStep: 1 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-boundary"
    && /no turnSeqs/.test(error.message));
  // The recorded wire bytes must be the wire form of the messages being sent.
  await assert.rejects(withReasoningBoundary(base, timeline).ask({
    messages: [{ role: "assistant", content: "look", reasoning_content: "why" }],
    turnSeqs: [1], reasoningMessages: 1, reasoningWireBytes: wireBytes("why") - 1, fireStep: 1 }),
  error => error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-boundary"
    && /record states reasoningWireBytes/.test(error.message));
  // The matching prompt passes and reaches the transport.
  let asked = 0;
  const counting = { ...base, ask: async () => { asked += 1; return { ok: true }; } };
  await withReasoningBoundary(counting, timeline).ask({
    messages: [{ role: "assistant", content: "look", reasoning_content: "why" }],
    turnSeqs: [1], reasoningMessages: 1, reasoningWireBytes: wireBytes("why"), fireStep: 1 });
  assert.equal(asked, 1);
});

// ---- the standing lane is now correctly non-citable -----------------------

test("standing lane: stub + reconstruction is non-citable, for named reasons", t => {
  if (!requirePinnedWorld(t)) return;
  const out = mkdtempSync(path.join(tmpdir(), "sim-live-standing-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner", "--transport", "stub",
      "--segment", "139", "--ignore-host-prunes", "--reconstruction", "--mode", "threshold",
      "--thresholds", "60000", "--ask-grammar", "jsonl-20", "--ask-ceiling", "20",
      "--token-grant", "10000000", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(path.join(out, "threshold-60000.json"), "utf8"));
    assert.equal(summary.asks, 8);
    assert.equal(summary.triggers, 8);
    assert.equal(summary.unansweredFires, 0);
    assert.equal(summary.carried, 24);
    // P1: the recording was made with the host pruner ON (132 prune rows in the
    // file, 67 in the segment), so `inputHostPruner` is "on" even though this
    // replay MODELS it off. `modeledHostPruner` is the flag's own reading.
    assert.equal(summary.inputHostPruner, "on", "the INPUT recording's own pruner state");
    assert.equal(summary.modeledHostPruner, "off", "the state this replay models");
    assert.equal(summary.records[0].inputHostPruner, "on");
    assert.equal(summary.records[0].modeledHostPruner, "off");
    assert.equal(summary.runHostPruner, "none", "the replay itself mounted no pruner");
    assert.equal(summary.citable, false, "a stub replay of a recording is not evidence");
    assert.deepEqual(summary.measurement.reasons,
      ["host-pruner-on", "reconstruction", "stub-transport", "stand-in-context",
        "text-source", "sim-only-trigger:depth-tokens",
        "segment-cut:1484", "carried-units:24",
        "input-deviation:agent-instructions-splice",
        "input-deviation:system-model-name"],
      "the reasons that apply, and only those: the recording was made with the host"
      + " pruner on (P1), the run is a reconstruction, 24 eligible units were never"
      + " asked, the standing lane's depth cadence is sim-only, the stand-in's own two"
      + " facts are inside stand-in-context, its tool calls are re-projected (not"
      + " dropped), the decoded-text reading is text-source, and the segment cut"
      + " drops 1484 rows");
    assert.equal(summary.droppedPartsTotal, 0,
      "carried tool-call parts are projected, so no dropped-parts reason");
    assert.deepEqual(summary.measurement.citableForStandIn,
      ["host-pruner-on", "reconstruction", "stub-transport",
        "text-source", "sim-only-trigger:depth-tokens", "segment-cut:1484",
        "carried-units:24",
        "input-deviation:agent-instructions-splice",
        "input-deviation:system-model-name"],
      "citableForStandIn subtracts only the stand-in WIRE reason; the decoded-text"
      + " reading and the segment cut stand");
    assert.equal(summary.records[0].inputDeviations.length, 2,
      "every send record carries the two DETECTED input deviations");
    assert.equal(summary.records[0].runHostPruner, "none");
    assert.equal(summary.reasoningSent, true,
      "P3: at least one send carried the timeline's reasoning");
    assert.equal(summary.segmentExcludedRows, 1484,
      "P3: the cut removed 1484 later rows before units were built");
    assert.ok(summary.measurement.reasons.includes("segment-cut:1484"),
      "P3: the cut is a reason, not a claim that every row was asked");
    assert.equal(summary.productBatchSize, PRODUCT_BATCH_SIZE,
      "P2: the product's configured batch size is recorded");
    assert.equal(summary.reasoning.reasoningParts, 93,
      "the segment cut's reasoning parts");
    assert.equal(summary.reasoning.fileReasoningParts, 271,
      "P8: the whole FILE's 271 reasoning parts are pinned, not only the segment's 93");
    assert.equal(summary.reasoning.fileReasoningStreamBlocks, 271,
      "P8: the whole FILE's 271 stream entries are pinned beside the part count");
    assert.equal(summary.records[0].tableSource, "landed", "threshold new-scope tables landed");
    // The README's standing-lane figures, pinned here so they cannot drift: the
    // fire steps, the trigger depths, the peak prompt's three gauges, the
    // eligible population and the net/gross freed bytes.
    assert.deepEqual(summary.records.map(record => record.fireStep),
      [16, 22, 31, 47, 60, 84, 115, 129], "the README's eight fire steps");
    assert.deepEqual(summary.records.map(record => record.triggerDepth),
      [71_826, 97_164, 108_082, 127_664, 151_547, 177_542, 213_573, 244_025],
      "the README's reconstructed depth at each trigger");
    assert.equal(summary.promptPeakBytes, 755_326, "peak content-only prompt bytes");
    assert.equal(summary.promptPeakWireBytes, 789_277, "peak request body");
    assert.equal(summary.promptPeakGuardTokens, 263_093, "ceil(peak wire B / 3)");
    assert.equal(summary.promptPeakEstimateTokens, 248_463, "ceil(peak content B / 3.04)");
    assert.equal(summary.eligible, 201);
    assert.equal(summary.askable, 201, "no host prune: every eligible unit is askable");
    assert.equal(summary.eligibleSplit.replacements, 0);
    assert.equal(summary.bytesFreedByPolicy, 967_042, "the README's NET freed bytes");
    assert.equal(summary.bytesFreedGross, 986_437, "the README's GROSS freed bytes");
    // The stub's usage is its own estimate fed back: every band is SYNTHETIC and
    // none grades anything, so a zero warning count is not a provider agreement.
    assert.equal(summary.fidelityWarnings, 0);
    assert.equal(summary.fidelityProvider, 0);
    assert.equal(summary.fidelitySynthetic, 8,
      "every one of the eight stub sends records a synthetic ruler, never a pass");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- the anchor is the fire's own step, ask included (audit 3, item 7) ----

test("anchorDepthOf reads the fire's own step, never the step after it", () => {
  const depths = [{ step: 1, tokens: 10 }, { step: 3, tokens: 30 }, { step: 5, tokens: 50 }];
  assert.deepEqual(anchorDepthOf(depths, 3), { step: 3, tokens: 30 },
    "the exact reading at the fire");
  assert.deepEqual(anchorDepthOf(depths, 4), { step: 3, tokens: 30 },
    "a gap takes the last reading at or before the fire");
  assert.deepEqual(anchorDepthOf(depths, 0), { step: null, tokens: null });
});

test("the surface anchor is the full request body's estimate (P4)", async () => {
  const transcript = [{ type: "session", id: "session-anchor" },
    { type: "tool/result", seq: 1, data: { step: 1, content: [{ type: "text",
      text: `${"a".repeat(1000)}\n${"b".repeat(999)}` }] } }];
  const records = [];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  await runLane({ transcript, depths: [{ step: 1, tokens: 10 }, { step: 2, tokens: 2000 }],
    lane: 0, mode: "threshold", threshold: 100, floor: 1, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport, askCeiling: 2, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(records.length, 1, "one fire");
  const record = records[0];
  const timeline = readTimeline(transcript, { ignoreHostPrunes: true });
  const base = surfaceDepthAt({ timeline, fireStep: record.fireStep,
    surface: simulateSurface(), fireIndex: 0 });
  assert.equal(record.anchorSource, "reconstructed-surface");
  assert.equal(record.anchorStep, record.fireStep, "the anchor is the fire's own step");
  assert.equal(record.anchorBasis, "surface-request-body",
    "P4: the surface anchor names what it is, the full request body");
  assert.equal(record.anchorDepth, measuredTokensOf(record.promptWireBytes),
    "P4: the anchor is the full request body's estimate — framing, keys, escaping,"
    + " tools, envelope and the ask included — not the content-only surface depth");
  assert.ok(record.anchorDepth > base.tokens,
    "the full body is larger than the content-only surface reading");
  assert.ok(record.anchorDepth > record.promptTokensEstimate,
    "the full body is larger than the content-only prompt estimate it used to equal");
});

test("a batch anchor on the host series adds the ask and the step's units", async () => {
  const transcript = [{ type: "session", id: "session-batch-anchor" },
    lineRow(1, 1), lineRow(2, 2)];
  const depths = [{ step: 1, tokens: 1000 }, { step: 2, tokens: 2000 }];
  const records = [];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  await runLane({ transcript, depths, lane: 1, mode: "batch", floor: 1,
    ignoreHostPrunes: false, allowZeroReasoning: true, transport, askCeiling: 8,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 2, "lane 1 fires at each unit");
  const timeline = readTimeline(transcript);
  for (const record of records) {
    const unit = timeline.units.find(candidate => candidate.step === record.fireStep);
    const measured = anchorDepthOf(depths, record.fireStep);
    assert.equal(record.anchorSource, "host-result.json");
    assert.equal(record.anchorBasis, "host-result-json-at-fire+ask+step-units");
    assert.equal(record.anchorAddedUnits, 1,
      "the single unit that landed at the fire's step is the addend");
    assert.equal(record.anchorAddedUnitTokens, measuredTokensOf(unit.bytes));
    assert.equal(record.anchorDepth,
      measured.tokens + measuredTokensOf(record.askBytes) + measuredTokensOf(unit.bytes),
      "the measured depth PLUS the ask PLUS the unit it could not contain");
    assert.ok(record.anchorDepth > measured.tokens + measuredTokensOf(record.askBytes),
      "the step's unit is in the anchor, not missing from it");
  }
  assert.notEqual(records[0].anchorDepth, records[0].triggerDepth,
    "the anchor is the request, never the trigger's ruler");
});

// ---- `triggerDepth` agrees with the lane's `depthSource` (audit 6, item 5) --

test("a batch lane's triggerDepth is the source its depthSource names", async () => {
  const transcript = [{ type: "session", id: "session-trigger-source" },
    lineRow(1, 1), lineRow(2, 2)];
  // A wild host series: if a pruner-off lane read it, the values could not equal
  // the reconstructed surface's own bytes.
  const depths = [{ step: 1, tokens: 999_999 }, { step: 2, tokens: 1_999_999 }];
  const runBatch = async ignoreHostPrunes => {
    const records = [];
    const transport = scriptedTransport((ask, indices) =>
      verdictsFor(indices, () => ({ keepall: true })));
    const summary = await runLane({ transcript, depths, lane: 1, mode: "batch", floor: 1,
      ignoreHostPrunes, allowZeroReasoning: true, transport, askCeiling: 8,
      deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
    return { records, summary };
  };
  const off = await runBatch(true);
  assert.equal(off.summary.depthSource, "reconstructed-surface");
  assert.equal(off.records.length, 2, "lane 1 fires at each unit");
  const timeline = readTimeline(transcript, { ignoreHostPrunes: true });
  // Every answer kept its row, so the surface holds no shapes and index i's
  // surface is an empty stamped one.
  off.records.forEach((record, at) => {
    const expected = surfaceDepthAt({ timeline, fireStep: record.fireStep,
      surface: simulateSurface({ fireIndex: at }), fireIndex: at }).tokens;
    assert.equal(record.triggerDepth, expected,
      `fire ${String(at)}: triggerDepth is the reconstructed surface's own depth`);
    assert.notEqual(record.triggerDepth, depths[at].tokens,
      "never the contaminated host series");
  });
  const on = await runBatch(false);
  assert.equal(on.summary.depthSource, "host-result.json");
  on.records.forEach((record, at) => {
    assert.equal(record.triggerDepth, depths[at].tokens,
      `fire ${String(at)}: the host-source lane's triggerDepth is the measured depth`);
  });
});

// ---- the batch-mode anchor is net of the policy's own removals -------------

test("batch mode nets the host anchor by the removals earlier fires booked", async () => {
  // Lane 1 over units at steps 1, 2 and 3 with a FLAT host series: the only
  // thing that can move the anchor is the policy's own earlier removal. Fire 0
  // at step 1 forgets unit 1 and books it at step 2 (clamp(1 + 1, 1)); the fire
  // at step 2 still carries that unit whole; the fire at step 3 reads the depth
  // NET of the removal. Before the fix the batch anchor was the un-reduced
  // measured depth, so the prompt sent and the anchor compared were different
  // contexts (and the stub only counted the miss in `fidelityWarnings`).
  const transcript = [{ type: "session", id: "session-batch-anchor" },
    lineRow(1, 1), lineRow(2, 2), lineRow(3, 3)];
  const depths = [{ step: 1, tokens: 100_000 }, { step: 2, tokens: 100_000 },
    { step: 3, tokens: 100_000 }];
  const records = [];
  const transport = scriptedTransport((ask, indices) => (ask === 0
    ? verdictsFor(indices, () => ({ forgetall: "gone" }))
    : verdictsFor(indices, () => ({ keepall: true }))));
  const summary = await runLane({ transcript, depths, lane: 1, mode: "batch", floor: 100,
    ignoreHostPrunes: false, hostPrunerFlag: "--allow-host-pruner",
    allowZeroReasoning: true, transport, askCeiling: 4, grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(records.length, 3, "one fire per unit");
  assert.deepEqual(summary.fireSteps, [1, 2, 3]);
  const removal = summary.removalBookings[0];
  assert.equal(removal.step, 2, "the answer lands after the fire that asked it");
  const timeline = readTimeline(transcript);
  const unitAt = step => timeline.units.find(unit => unit.step === step);
  assert.equal(records[1].anchorDepth,
    100_000 + measuredTokensOf(records[1].askBytes) + measuredTokensOf(unitAt(2).bytes),
    "the fire at step 2 still carries the unit it is about to remove, and the"
    + " measured depth at its step did not yet contain that unit");
  assert.equal(records[2].anchorDepth,
    100_000 - measuredTokensOf(removal.bytes) + measuredTokensOf(records[2].askBytes)
      + measuredTokensOf(unitAt(3).bytes),
    "the step-3 anchor is net of the step-2 removal, plus the ask and its own unit");
  assert.ok(records[2].anchorDepth < 100_000 + measuredTokensOf(records[2].askBytes)
    + measuredTokensOf(unitAt(3).bytes), "the anchor is not the un-reduced depth");
});

// ---- the plan books a removal at the same step the live lane does ----------

test("the plan and the live lane book identical fire steps and removal steps", async () => {
  // Units land at 1, 2, 3, 6, 7, 10, 11 and 14; the threshold (1500 tokens) makes
  // a fire ask several OLDER pending units, which is the case where booking at
  // `unit.step + 1` used to remove bytes before the fire that decided them.
  const steps = [1, 2, 3, 6, 7, 10, 11, 14];
  const transcript = [{ type: "session", id: "session-plan-live" },
    ...steps.map((step, at) => lineRow(at + 1, step))];
  const depths = Array.from({ length: 15 }, (_, at) => ({
    step: at + 1, tokens: 1000 + (at + 1) * 100 }));
  const timeline = readTimeline(transcript, { ignoreHostPrunes: true });
  const producer = {
    name: "forget-most",
    decide: ({ index }) => (index === 0
      ? { action: "keepall" } : { action: "forgetall", summary: "gone" }),
  };
  const plan = thresholdLane({ timeline, depths, threshold: 1500, floor: 100, producer });
  const transport = scriptedTransport((ask, indices) => verdictsFor(indices,
    index => (index === indices[0] ? { keepall: true } : { forgetall: "gone" })));
  const summary = await runLane({ transcript, depths, lane: 0, mode: "threshold",
    threshold: 1500, floor: 100, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 8, grammar: "3option", deadline: Date.now() + 60_000 });
  assert.ok(plan.fireSteps.length >= 2, "the fixture fires more than once");
  assert.deepEqual(summary.fireSteps, plan.fireSteps, "identical fire steps");
  assert.deepEqual(summary.removalBookings, plan.removalBookings,
    "identical removal bookings (unit, step, bytes)");
  // The clamp is not vacuous: at least one removal is booked at a step later
  // than its unit's own step + 1, the step the old plan always used.
  const unitStep = new Map(timeline.units.map(unit => [unit.id, unit.step]));
  assert.ok(plan.removalBookings.some(booking =>
    booking.step > (unitStep.get(booking.unitId) ?? 0) + 1),
  "a fire asked an older pending unit, so the plan had to clamp to the fire step");
  assert.ok(plan.removalBookings.every(booking => plan.fireSteps.includes(booking.step)),
    "every removal books at one of the lane's own fire steps");
});

// ---- P3: a declared-reasoning run whose sends never carried one ------------

test("a run whose every fire precedes the first reasoning turn refuses (P3)", async () => {
  // The unit lands at step 1 and lane 1 fires there; the agent's reasoning turn
  // lands at step 2, AFTER every fire. `expectedReasoningAt` is legitimately 0 at
  // the fire, so every boundary check passes and the run would be written as a
  // reasoning run that carried none.
  const rows = [
    { type: "session", seq: 1, id: "session-p3" },
    { type: "step/start", seq: 2, data: { step: 1 } },
    lineRow(3, 1),
    { type: "step/start", seq: 4, data: { step: 2 } },
    { type: "assistant/message", seq: 5, data: { step: 2, message: {
      content: [{ type: "text", text: "I looked" }, { type: "reasoning", text: "because" }],
      source: { replayState: { blocks: [{ type: "text" },
        { type: "reasoning", thinkingSignature: "reasoning" }] } } },
      stream: [{ blockType: "text" }, { blockType: "reasoning" }] } },
  ];
  await assert.rejects(runLane({ transcript: rows,
    depths: [{ step: 1, tokens: 100 }, { step: 2, tokens: 200 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true,
    transport: stubTransport(), askCeiling: 5, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-never-sent"
    && /declares 1 resendable reasoning turn/.test(error.message)
    && /none of the 1 send\(s\) carried one/.test(error.message)
    && /expectedReasoningAt is 0/.test(error.message));
});

// ---- P5: `carried` on both failure paths ----------------------------------

test("a stopped batch fire carries prunedBeforeAsk too, never understating the hole (P5)", async () => {
  // A at step 1 is pending when the host prune at step 2 removes it; the lane
  // never asks it, so it belongs to `carried` (via `prunedBeforeAsk`). C and D
  // land at step 3 and form the lane-2 batch; the send fails and the fire is
  // dropped. The old failure path added the tail and the dropped batch and
  // FORGOT `prunedBeforeAsk`, so `carried` understated the hole by A.
  const rows = [
    { type: "session", seq: 1, id: "session-p5-batch" },
    { type: "step/start", seq: 2, data: { step: 1 } },
    lineRow(3, 1),
    { type: "step/start", seq: 4, data: { step: 2 } },
    { type: "compaction/prune", seq: 5,
      data: { shadowedSeqs: [3], shadowedTokenCount: 1900 } },
    { type: "step/start", seq: 6, data: { step: 3 } },
    lineRow(7, 3),
    lineRow(8, 3),
    { type: "tool/result", seq: 9, surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
      data: { step: 1, content: [{ type: "text",
        text: Array.from({ length: 10 }, (_, at) => `replacement ${String(at)} ${"y".repeat(180)}`)
          .join("\n") }] } },
  ];
  const transport = { name: "fails", live: false,
    ask: async () => ({ ok: false, failure: "transport", error: "no socket",
      usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } }) };
  const summary = await runLane({ transcript: rows,
    depths: [{ step: 1, tokens: 100 }, { step: 2, tokens: 200 }, { step: 3, tokens: 300 }],
    lane: 2, mode: "batch", floor: 1, ignoreHostPrunes: false, allowZeroReasoning: true,
    transport, askCeiling: 5, deadline: Date.now() + 60_000 });
  assert.equal(summary.prunedBeforeAsk, 1, "A was pruned before any fire tabled it");
  assert.equal(summary.droppedBatchUnits, 2, "C and D were the dropped fire's batch");
  assert.equal(summary.carried, 4, "A + C + D + the replacement R: the pruned unit is part of the hole");
  assert.ok(summary.measurement.reasons.includes("carried-units:4"));
  assert.ok(summary.measurement.reasons.includes("refused-sends"));
});

test("a stopped threshold fire carries a SET of unasked units, never re-asked rows (P5)", async () => {
  // Fire 1 asks A and keeps it; `--ask-scope kept` re-tables A beside the new B
  // at fire 2, whose send fails. A was ASKED at fire 1, so it is not carried;
  // the old `Math.max(pending.length, droppedUnits)` counted the re-asked A and
  // overstated `carried` by one.
  const rows = [
    { type: "session", seq: 1, id: "session-p5-threshold" },
    { type: "step/start", seq: 2, data: { step: 1 } },
    lineRow(3, 1),
    { type: "step/start", seq: 4, data: { step: 2 } },
    lineRow(5, 2),
  ];
  let calls = 0;
  const transport = { name: "fails-second", live: false,
    ask: async ({ indices }) => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, httpStatus: null, latencyMs: 0,
          content: JSON.stringify(Object.fromEntries(indices.map(index => [index, { keepall: true }]))),
          usage: { prompt_tokens: 300, completion_tokens: 10, total_tokens: 310 } };
      }
      return { ok: false, failure: "transport", error: "no socket",
        usage: { prompt_tokens: 400, completion_tokens: 0, total_tokens: 400 } };
    } };
  const summary = await runLane({ transcript: rows,
    depths: [{ step: 1, tokens: 100 }, { step: 2, tokens: 200 }, { step: 3, tokens: 300 }],
    lane: 0, mode: "threshold", threshold: 50, thresholdUnits: "depth-tokens",
    semantics: "absolute", askScope: "kept", floor: 1, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport, askCeiling: 5, deadline: Date.now() + 60_000 });
  assert.equal(summary.asks, 2, "fire 1 answered, fire 2 failed");
  assert.equal(summary.carried, 1, "only B was never asked; A was asked at fire 1");
  assert.ok(summary.measurement.reasons.includes("carried-units:1"),
    "the reason names the set's count, never the re-asked row");
});

// ---- the tenth audit: reading-derived labels, rulers, quotes and reasons ----

test("P1: the recording's pruner state comes from the recording, not the flag", () => {
  const pruned = [{ type: "session", id: "session-p1-pruned" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
    { type: "compaction/prune", seq: 3, data: { shadowedSeqs: [2], shadowedTokenCount: 20 } }];
  const clean = [{ type: "session", id: "session-p1-clean" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1)];
  assert.equal(recordingHostPrunerState(readTimeline(pruned)), "on",
    "a recording that carries a prune row was made with the pruner on");
  assert.equal(recordingHostPrunerState(readTimeline(clean)), "off",
    "a recording with no prune row was made with it off");
  assert.equal(recordingHostPrunerState(readTimeline(pruned,
    { ignoreHostPrunes: true })), "on",
    "the FILTERED world's empty hostPrunes does not move the reading: the recording"
    + " still carries the prune row it was made with");
});

test("P1: a pruner-off replay of a pruner-on recording names both states", async () => {
  // The standing lane's shape in miniature: the recording carries a prune row,
  // the replay models the pruner off. The old record derived `inputHostPruner`
  // from the flag, so it read "off" and pushed no `host-pruner-on` reason.
  const rows = [{ type: "session", id: "session-p1-modeled" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
    { type: "compaction/prune", seq: 3, data: { shadowedSeqs: [2], shadowedTokenCount: 20 } },
    { type: "step/start", seq: 4, data: { step: 2 } }, lineRow(5, 2)];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const records = [];
  const summary = await runLane({ transcript: rows, reconstruction: true,
    depths: [{ step: 1, tokens: 100 }, { step: 2, tokens: 200 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 3, deadline: Date.now() + 60_000,
    onRecord: record => records.push(record) });
  assert.equal(summary.inputHostPruner, "on", "read from the recording's prune rows");
  assert.equal(summary.modeledHostPruner, "off", "the flag says what the replay models");
  assert.equal(summary.runHostPruner, "none");
  assert.ok(summary.measurement.reasons.includes("host-pruner-on"),
    "a reconstruction over a pruner-on recording still names the host pruner");
  assert.equal(records[0].inputHostPruner, "on");
  assert.equal(records[0].modeledHostPruner, "off");
});

test("P3: a usage row names a step >= 1 and non-negative counts", () => {
  const bad = [
    [{ step: 0, inputTokens: 10 }, /not a step/],
    [{ step: -3, inputTokens: 10 }, /not a step/],
    [{ step: 1, inputTokens: -1 }, /never negative/],
    [{ step: 1, inputTokens: 10, outputTokens: -1 }, /outputTokens/],
    [{ step: 1, inputTokens: 10, totalTokens: -1 }, /totalTokens/],
  ];
  for (const [row, pattern] of bad) {
    assert.throws(() => readUsage({ rows: [row] }), error =>
      error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-invalid"
      && pattern.test(error.message), `${JSON.stringify(row)} must refuse`);
  }
  // A well-formed row still reads, and an absent optional count stays absent.
  assert.deepEqual(readUsage({ rows: [{ step: 3, inputTokens: 10 }] }),
    [{ step: 3, tokens: 10, shapeBasis: "no-cache" }]);
});

test("P3: a depth step the transcript never declares refuses by name", async () => {
  const rows = [{ type: "session", id: "session-p3-unpinned" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1)];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  // `runLane` is the wrapper that DECLARES missing steps for a synthetic row
  // array; `runLaneRaw` is the code under test, and the series names step 9,
  // which no `step/start` in this recording reaches.
  await assert.rejects(runLaneRaw({ transcript: rows,
    depths: [{ step: 1, tokens: 10 }, { step: 9, tokens: 90 }],
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
    transport, askCeiling: 2, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-step-unpinned"
    && /step 9/.test(error.message)
    && /never declare/.test(error.message));
  // A recording that declares no step boundary at all cannot pin any reading.
  await assert.rejects(runLaneRaw({ transcript: [{ type: "session", id: "no-steps" },
    lineRow(1, 1)], depths: [{ step: 1, tokens: 10 }],
  lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true,
  transport, askCeiling: 1, deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-usage-step-unpinned"
    && /declares no step\/start/.test(error.message));
});

test("P8: runLaneRaw over a transcript with no step/start refuses an unplaceable turn", async () => {
  // Fifteenth audit item 5: the `runLane` test seam (`withStepStarts`) appends
  // synthetic step/start rows, so this production path was unreachable through
  // it. `runLaneRaw` is the shipped code: no step/start anywhere, one tool
  // result that states its own `data.step`, and one user turn that states
  // neither — the surface cannot place it, and dropping it would hide a turn.
  // An EMPTY depth series keeps `assertUsageStepsPinned` from refusing first,
  // so the row-unplaced refusal is the one under test.
  const transcript = [{ type: "session", id: "session-raw-no-steps" },
    lineRow(1, 1),
    { type: "user/message", data: { message: { content: [{ type: "text",
      text: "a turn with no step and no seq" }] } } }];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  await assert.rejects(runLaneRaw({ transcript, depths: [], lane: 1, mode: "batch",
    floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true, transport, askCeiling: 2,
    deadline: Date.now() + 60_000 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-row-unplaced"
    && /no owning step\/start and no `data.step`/.test(error.message)
    && /cannot place it at a fire/.test(error.message));
});

test("P8: the no-step path orders rows by their own step, not by seq", async () => {
  // Fifteenth audit item 5, the other half: a transcript with no step/start is
  // a production shape (the rows state `data.step`), and `askableOf` orders the
  // stream by step then seq. Seq 1 lands at step 2 and seq 2 at step 1, so a
  // seq-only order would ask result:1 first; the step order asks result:2.
  const transcript = [{ type: "session", id: "session-raw-step-order" },
    lineRow(1, 2), lineRow(2, 1)];
  const records = [];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLaneRaw({ transcript, depths: [], lane: 1, mode: "batch",
    floor: 1, ignoreHostPrunes: true, allowZeroReasoning: true, transport, askCeiling: 4,
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(summary.asks, 2, "one fire per landing, both rows asked");
  assert.deepEqual(records.map(record => record.rows[0].unitId), ["result:2", "result:1"],
    "step 1's row is tabled before step 2's, whatever their seqs");
});

test("P4: a kept row whose shaped body loses its two quotes leaves the table", async () => {
  // Fire 1 forgets lines 1-9 of unit 1 with a one-character summary. The shaped
  // body is "x\n\n[racoons] ...\nline 10 ...": line 1 is too short to quote and
  // line 2 is blank, so the row can no longer show two quotes. The product
  // re-runs `factsShowTwoQuotes` over the live node and drops the row
  // (`entry-ask-off`, reason `no-quotes`); the sim used to table it bare. A
  // `forgetlines` keeps the row in the kept map; `forgetall` would settle it.
  const transport = scriptedTransport((ask, indices) => {
    if (ask === 0) return { 1: { forgetlines: [[1, 9], "x"] } };
    return verdictsFor(indices, () => ({ keepall: true }));
  });
  const transcript = [{ type: "session", id: "session-p4-noquotes" },
    lineRow(1, 1), lineRow(2, 3)];
  const depths = [[1, 1000], [2, 1500], [3, 1500], [4, 2000]]
    .map(([step, tokens]) => ({ step, tokens }));
  const records = [];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 0,
    mode: "threshold", allowZeroReasoning: true, threshold: 500, floor: 100,
    askScope: "kept", transport, askCeiling: 5, grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  assert.equal(summary.asks, 2, "the first fire and the one after it");
  assert.equal(summary.keptNoQuoteRows, 1, "the re-read dropped exactly one kept row");
  assert.deepEqual(records[0].keptNoQuoteUnitIds, [], "the first fire has no kept rows");
  assert.deepEqual(records[1].keptNoQuoteUnitIds, ["result:1"],
    "the record names the row the quote re-read dropped");
  assert.deepEqual(records[1].rows.map(row => row.unitId), ["result:2"],
    "the dropped row is not asked again; the new row is");
  assert.equal(records[1].tabledRows, 1, "the table carries one row, not two");
  // Twelfth audit item 5: a kept row the quote re-read dropped is content the
  // run did not table, so `complete` cannot be true beside it.
  assert.ok(summary.incompleteReasons.includes("kept-no-quote:1"),
    "the dropped kept row is a named incompleteness reason");
  assert.equal(summary.complete, false, "a run missing a kept row is not complete");
});

test("P7: the host anchor adds EVERY unit that landed at the fire's step", async () => {
  // Two results land at step 1 (a parallel tool batch). The measured depth at
  // step 1 is the request that produced BOTH, so neither is in it; the old
  // anchor added only the unit that fired and understated the prompt.
  const transcript = [{ type: "session", id: "session-p7-same-step" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1), lineRow(3, 1)];
  const depths = [{ step: 1, tokens: 1000 }];
  const records = [];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  await runLane({ transcript, depths, lane: 2, mode: "batch", floor: 1,
    ignoreHostPrunes: false, allowZeroReasoning: true, transport, askCeiling: 3,
    grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  const timeline = readTimeline(transcript);
  // ONE ceiling over the summed bytes (eleventh audit): per-unit ceilings
  // overstated the addend by up to a token per unit.
  const unitBytes = timeline.units.reduce((sum, unit) => sum + unit.bytes, 0);
  const unitTokens = measuredTokensOf(unitBytes);
  assert.equal(records.length, 1, "lane 2 fires once at step 1");
  const record = records[0];
  assert.equal(record.fireStep, 1);
  assert.equal(record.anchorBasis, "host-result-json-at-fire+ask+step-units");
  assert.equal(record.anchorAddedUnits, 2, "both same-step units are the addend");
  assert.equal(record.anchorAddedUnitTokens, unitTokens,
    "the addend is the ceiling of the summed bytes, never a sum of ceilings");
  assert.equal(record.anchorDepth,
    1000 + measuredTokensOf(record.askBytes) + unitTokens,
  "measured depth at the step + the ask + BOTH units that landed there");
  assert.ok(record.anchorDepth > 1000 + measuredTokensOf(record.askBytes)
    + measuredTokensOf(timeline.units[0].bytes),
  "the second same-step unit is in the anchor, not only the one that fired");
});

test("P7: the correction records an additive anchor basis, not the first send's", async () => {
  // A keeplines span past the row's end earns the one correction turn. Its
  // anchor is the first send's anchor PLUS the grown bytes, so it cannot claim
  // the first send's basis word.
  const transcript = [{ type: "session", id: "session-p7-correction" }, lineRow(1, 1)];
  const depths = [{ step: 1, tokens: 1000 }];
  const records = [];
  let calls = 0;
  const transport = scriptedTransport((ask, indices) => {
    calls += 1;
    return calls === 1
      ? { 1: { keeplines: [[11, 12], "past the end"] } }
      : verdictsFor(indices, () => ({ keepall: true }));
  });
  await runLane({ transcript, depths, lane: 1, mode: "batch", floor: 1,
    ignoreHostPrunes: true, allowZeroReasoning: true, transport, askCeiling: 2,
    grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  const correction = records.find(record => record.kind === "correction");
  assert.ok(correction !== undefined, "the correction send has its own record");
  assert.equal(correction.anchorBasis, "first-send-anchor+correction-delta");
  assert.equal(correction.anchorDepth,
    records[0].anchorDepth + correction.anchorDeltaTokens,
    "the correction's anchor is the first anchor plus its own delta");
});

test("P8: a text-bearing row with no owning step refuses instead of vanishing", () => {
  const rows = [{ type: "session", id: "session-p8-unplaced" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
    { type: "user/message", data: { message: { content: [{ type: "text",
      text: "a turn with no step and no seq" }] } } }];
  const timeline = readTimeline(rows);
  assert.throws(() => surfaceAt({ timeline, fireStep: 1, surface: simulateSurface(),
    fireIndex: 0 }), error => error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-row-unplaced"
    && /user\/message at seq undefined carries/.test(error.message)
    && /cannot place it at a fire/.test(error.message));
  // A user or assistant turn with NO text (and no reasoning) is not a loss: it
  // is skipped as before, and no refusal fires.
  const empty = readTimeline([{ type: "session", id: "session-p8-empty" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
    { type: "user/message", data: { message: { content: [{ type: "text", text: "" }] } } }]);
  assert.doesNotThrow(() => surfaceAt({ timeline: empty, fireStep: 1,
    surface: simulateSurface(), fireIndex: 0 }));
});

test("P9: an error result is the product's own exclusion, never a reason", async () => {
  const errorRow = (seq, step) => ({ type: "tool/result", seq,
    data: { step, message: { isError: true, content: [{ type: "text",
      text: lineBodyOf(10) }] } } });
  const transcript = [{ type: "session", id: "session-p9-error" },
    lineRow(1, 1), errorRow(2, 3)];
  const depths = [[1, 1000], [2, 1500], [3, 1500], [4, 2000]]
    .map(([step, tokens]) => ({ step, tokens }));
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 0,
    mode: "threshold", allowZeroReasoning: true, threshold: 500, floor: 100,
    askScope: "kept", transport, askCeiling: 3, deadline: Date.now() + 60_000 });
  assert.equal(summary.eligibility.excluded.errorResult, 1,
    "the failed result is counted as an exclusion");
  assert.ok(!summary.measurement.reasons.includes("sim-only-eligibility:error-result"),
    "the product drops failed results before the entry seam, so this is not sim-only");
  assert.ok(!summary.measurement.reasons.some(reason =>
    reason.startsWith("sim-only-eligibility")), "no such reason exists any more");
});

test("P11: completeness is its own reading, never the ceiling flag", async () => {
  // A failed send leaves units unasked with `stoppedAtCeiling: false`; the old
  // `truncated` field read that run as complete.
  const transcript = [{ type: "session", id: "session-p11-failed" }, systemRow(),
    lineRow(1, 1)];
  const depths = [{ step: 1, tokens: 1000 }];
  const failing = { name: "fails", live: false,
    ask: async () => ({ ok: false, failure: "transport", error: "no socket" }) };
  const failed = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 1,
    mode: "batch", floor: 1, allowZeroReasoning: true, transport: failing,
    askCeiling: 2, deadline: Date.now() + 60_000 });
  assert.equal(failed.stoppedAtCeiling, false);
  assert.equal(failed.complete, false, "a failed send is an incomplete sample");
  assert.ok(failed.incompleteReasons.includes("refused-sends"));
  assert.ok(failed.incompleteReasons.some(reason => reason.startsWith("carried-units:")));
  assert.equal(failed.truncated, undefined,
    "the misleading `truncated` field is gone; `stoppedAtCeiling` and `complete` say it");
  assert.equal(failed.measurement.complete, false);
  assert.deepEqual(failed.measurement.incompleteReasons, failed.incompleteReasons);
  // A complete run says so.
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const clean = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 1,
    mode: "batch", floor: 1, allowZeroReasoning: true, transport, askCeiling: 2,
    deadline: Date.now() + 60_000 });
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.incompleteReasons, []);
  // Twelfth audit item 12: the three comparisons that cannot fail are recorded
  // by CLASS on every summary, never as passing checks.
  const classes = new Map(CHECK_CLASSES.map(entry => [entry.id, entry.class]));
  assert.equal(classes.get("asks-equal-triggers"), "definitional",
    "two counters moved in one path: definitional, not measured");
  assert.equal(classes.get("reasoning-turns-equal-resendable-blocks"), "definitional");
  assert.equal(classes.get("pruner-off-prune-journals-zero"), "not-applicable");
  // Thirteenth audit item 6: three more comparisons can pass on an empty
  // population without measuring anything, and are named by class too.
  assert.equal(classes.get("surface-advanced-empty-decision-log"), "not-applicable");
  assert.equal(classes.get("reasoning-in-prompt-zero-declared"), "not-applicable");
  assert.equal(classes.get("carried-overrides-no-carries"), "not-applicable");
  // Fourteenth audit item 5: the run's field is the RUN's, never the catalog
  // repeated. Every entry keeps the catalog's name and class but states what
  // THIS run did — `measured` over a non-empty population, `definitional` when
  // the two sides agree by construction, or `not-applicable` because the
  // comparison was vacuous — with the count that decided it.
  assert.deepEqual(clean.measurement.checks.map(entry => [entry.name, entry.class]),
    CHECK_CLASSES.map(entry => [entry.id, entry.class]),
    "the run's checks keep the catalog's names and classes");
  assert.ok(clean.measurement.checks.every(entry =>
    ["measured", "definitional", "not-applicable"].includes(entry.outcome)
    && Number.isSafeInteger(entry.count) && typeof entry.countName === "string"),
  "each entry states this run's outcome, its count and what the count is");
  assert.equal(clean.measurement.checks.find(entry =>
    entry.name === "asks-equal-triggers").outcome, "definitional",
  "an ask stream is non-empty but asks and triggers move in one path");
  assert.equal(clean.measurement.checks.find(entry =>
    entry.name === "carried-overrides-no-carries").outcome, "not-applicable",
  "a run that never carried a shaped body compared no carried bytes");
  // Fifteenth audit item 3: the definitional pair, with and without a
  // population, and the reasoning check's population is its turn count.
  const definitional = new Map(checkOutcomesOf({ asks: 2, reasoningTurns: 3 })
    .map(entry => [entry.name, entry.outcome]));
  assert.equal(definitional.get("asks-equal-triggers"), "definitional");
  assert.equal(definitional.get("reasoning-turns-equal-resendable-blocks"), "definitional");
  const empty = new Map(checkOutcomesOf({ asks: 0, reasoningTurns: 0 })
    .map(entry => [entry.name, entry.outcome]));
  assert.equal(empty.get("asks-equal-triggers"), "not-applicable");
  assert.equal(empty.get("reasoning-turns-equal-resendable-blocks"), "not-applicable");
});

test("two runs record DIFFERENT per-run check outcomes", async () => {
  // Fourteenth audit item 5: `measurement.checks` was `CHECK_CLASSES`, the same
  // list on every run. Two runs with different populations must say different
  // things: run A replays a prune journal and carries a shaped body, so both
  // checks measured something; run B has neither, so both were vacuous there.
  const transport = () => scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const forgetting = () => scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ forgetall: "gone" })));
  const a = await runLane({
    transcript: [{ type: "session", id: "s-checks-a" },
      { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
      { type: "step/start", seq: 3, data: { step: 2 } }, lineRow(4, 2),
      { type: "step/start", seq: 5, data: { step: 3 } }, lineRow(6, 3),
      { type: "compaction/prune", seq: 7,
        data: { shadowedSeqs: [2], shadowedTokenCount: 20 } }],
    depths: depthsFrom([[1, 100], [2, 200], [3, 300]]),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true, reconstruction: true,
    allowZeroReasoning: true, transport: forgetting(), askCeiling: 5, grammar: "3option",
    deadline: Date.now() + 60_000 });
  const b = await runLane({
    transcript: [{ type: "session", id: "s-checks-b" },
      { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1),
      { type: "step/start", seq: 3, data: { step: 2 } }, lineRow(4, 2)],
    depths: depthsFrom([[1, 100], [2, 200]]),
    lane: 1, mode: "batch", floor: 1, ignoreHostPrunes: true,
    allowZeroReasoning: true, transport: transport(), askCeiling: 5, grammar: "3option",
    deadline: Date.now() + 60_000 });
  const byName = summary => new Map(summary.measurement.checks
    .map(entry => [entry.name, entry]));
  const aPrunes = byName(a).get("pruner-off-prune-journals-zero");
  const bPrunes = byName(b).get("pruner-off-prune-journals-zero");
  assert.equal(aPrunes.outcome, "measured",
    "a replay whose source carried a prune journal filtered one");
  assert.equal(aPrunes.count, 1);
  assert.equal(aPrunes.countName, "replayedPrunes");
  assert.equal(bPrunes.outcome, "not-applicable", "no journal was filtered");
  assert.equal(bPrunes.count, 0);
  const aCarry = byName(a).get("carried-overrides-no-carries");
  const bCarry = byName(b).get("carried-overrides-no-carries");
  assert.equal(aCarry.outcome, "measured", "the second fire carried a shaped body");
  assert.ok(aCarry.count > 0);
  assert.equal(aCarry.countName, "carriedOverrides");
  assert.equal(bCarry.outcome, "not-applicable", "every row stayed whole");
  assert.equal(bCarry.count, 0);
  // The two lists are the same LENGTH and the same catalog order; only the
  // run's reading differs.
  assert.deepEqual(a.measurement.checks.map(entry => entry.name),
    b.measurement.checks.map(entry => entry.name));
  assert.notDeepEqual(a.measurement.checks, b.measurement.checks);
});

test("a batch lane's short final batch is the PRODUCT's remainder, named", async () => {
  // Twelfth audit item 11: `batchVerdict` never flushes a partial batch, so a
  // lane that does not divide its population always leaves a tail. That is the
  // product's own shape, not a run shortfall: it is named `batch-remainder:<n>`
  // and never silently folds into a generic carried count.
  const rows = [1, 2, 3, 4, 5].map(seq => lineRow(seq, seq));
  const transport = () => scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const base = { ignoreHostPrunes: true, depths: [], lane: 2, mode: "batch", floor: 1,
    allowZeroReasoning: true, askCeiling: 5, grammar: "3option",
    deadline: Date.now() + 60_000 };
  const summary = await runLane({ ...base, transcript: [{ type: "session", id: "s-tail" },
    systemRow(), ...rows], transport: transport() });
  assert.equal(summary.triggers, 2, "two full batches of two");
  assert.equal(summary.batchRemainder, 1, "the fifth unit is the short final batch");
  assert.equal(summary.carried, 1);
  assert.deepEqual(summary.incompleteReasons, ["batch-remainder:1"],
    "the tail is named as the product's remainder, not a lost row");
  assert.equal(summary.complete, false);
  // A population that divides exactly has no remainder and is complete.
  const exact = await runLane({ ...base, transcript: [{ type: "session", id: "s-exact" },
    systemRow(), ...rows.slice(0, 4)], transport: transport() });
  assert.equal(exact.batchRemainder, 0);
  assert.deepEqual(exact.incompleteReasons, []);
  assert.equal(exact.complete, true);
});

test("completeness names an absent or unreadable system slot", async () => {
  // Thirteenth audit item 2: `systemDroppedRows` was 1 but `complete` was true,
  // so a run whose first message was an empty slot read as a full sample.
  const base = { ignoreHostPrunes: true, depths: [], lane: 1, mode: "batch", floor: 1,
    allowZeroReasoning: true, askCeiling: 2, deadline: Date.now() + 60_000 };
  const transport = () => scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const absent = await runLane({ ...base, transport: transport(),
    transcript: [{ type: "session", id: "s-system-absent" }, lineRow(1, 1)] });
  assert.equal(absent.systemDroppedRows, 1);
  assert.ok(absent.incompleteReasons.includes("system-absent:1"),
    "a missing system turn is named in the completeness list");
  assert.equal(absent.complete, false);
  const unreadable = await runLane({ ...base, transport: transport(),
    transcript: [{ type: "session", id: "s-system-unreadable" },
      { type: "system/message", seq: 0, data: { content: "a string body" } },
      lineRow(1, 1)] });
  assert.equal(unreadable.systemDroppedRows, 1);
  assert.ok(unreadable.incompleteReasons.includes("system-unreadable:1"),
    "an unreadable system turn is named too");
  assert.equal(unreadable.complete, false);
});

test("completeness names eligible units the host pruned before any fire", async () => {
  // Thirteenth audit item 2: an eligible unit the host removes STRICTLY BEFORE
  // its own landing step is never tabled and was absent from the completeness
  // list (a prune on the landing step itself would still be askable there).
  const transcript = [
    { type: "session", id: "s-never-askable" },
    systemRow(1),
    lineRow(2, 1), lineRow(3, 2), lineRow(4, 3),
    { type: "step/start", seq: 5, data: { step: 1 } },
    { type: "compaction/prune", seq: 6,
      data: { shadowedSeqs: [3], shadowedTokenCount: 100 } },
    // The host's own replacement of the pruned row: the pin requires one
    // replacement per prune journal, and it lands at its OWN entry step (1).
    { type: "tool/result", seq: 7, surfaceOp: { op: "replace", startSeq: 3 },
      data: { step: 1, content: [{ type: "text", text: lineBodyOf(10) }] } },
  ];
  const depths = depthsFrom([[1, 1000], [2, 1500], [3, 1500], [4, 2000]]);
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ ignoreHostPrunes: false, transcript, depths, lane: 1,
    mode: "batch", floor: 100, allowZeroReasoning: true, transport, askCeiling: 3,
    deadline: Date.now() + 60_000 });
  assert.equal(summary.eligibility.eligible, 4,
    "the pruned unit and its replacement are both eligible");
  assert.equal(summary.hostPrunedBeforeLanding, 1,
    "the original was removed strictly before its own landing step");
  assert.ok(summary.incompleteReasons.includes("host-pruned-before-landing:1"),
    "the sample hole is named in the completeness list");
  assert.equal(summary.complete, false);
});

test("an image-only tool result is dropped content, never a sub-floor body", async () => {
  // Thirteenth audit item 3: `unitOf` set `declaredContentBytes` only for a
  // STRING body, so an array of image parts read as 0 B, fell below the floor,
  // and no dropped counter saw it.
  const transcript = [{ type: "session", id: "s-image-only" }, systemRow(),
    lineRow(1, 1),
    { type: "tool/result", seq: 2, data: { step: 2, content: [
      { type: "image", source: { type: "base64", data: "AAAA" } }] } }];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths: [], lane: 1,
    mode: "batch", floor: 100, allowZeroReasoning: true, transport, askCeiling: 2,
    deadline: Date.now() + 60_000 });
  assert.equal(summary.eligibility.excluded.nonTextContent, 1,
    "the image-only row is excluded under its own name");
  assert.equal(summary.eligibility.excluded.belowFloor, 0,
    "its 0 B reading is not counted as a small body");
  assert.equal(summary.droppedRows.count, 1);
  assert.deepEqual(summary.droppedRows.byKind,
    { "tool/result (declared content, no text)": 1 },
    "the whole-row omission names the tool result");
  assert.ok(summary.measurement.reasons.includes("dropped-rows:1"),
    "the citation list names the lost row");
  assert.ok(summary.incompleteReasons.includes("dropped-content:1"));
  assert.equal(summary.complete, false);
});

test("a transcript whose only non-text content is a projected tool call is complete", async () => {
  // Thirteenth audit item 7: tool-call parts are re-projected as `Tool call:`
  // turns, not lost. Counting them as dropped content made `complete`
  // unreachable on every real transcript.
  const transcript = [{ type: "session", id: "s-projected" }, systemRow(1),
    { type: "assistant/message", seq: 2, data: { step: 1, content: [
      { type: "text", text: "I will read a file." },
      { type: "tool-call", id: "call_1", name: "read", arguments: "{}" }] } },
    { type: "tool/call", seq: 3,
      data: { step: 1, callId: "call_1", name: "read", arguments: "{}" } },
    // An assistant turn carrying ONLY a tool-call part reaches no message; its
    // call is projected from the separate tool/call row, so it is not lost.
    { type: "assistant/message", seq: 4, data: { step: 1, content: [
      { type: "tool-call", id: "call_2", name: "read", arguments: "{}" }] } },
    lineRow(5, 1)];
  const transport = scriptedTransport((ask, indices) =>
    verdictsFor(indices, () => ({ keepall: true })));
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths: [], lane: 1,
    mode: "batch", floor: 100, allowZeroReasoning: true, transport, askCeiling: 2,
    deadline: Date.now() + 60_000 });
  assert.equal(summary.droppedRows.count, 0,
    "a projected row reaches no message but loses no content");
  assert.equal(summary.projectedRows, 1, "the tool-call-only row is counted projected");
  assert.ok(summary.projectedPartsTotal > 0,
    "the carried assistant turn's tool-call part is counted projected");
  assert.ok(!summary.measurement.reasons.some(reason =>
    reason.startsWith("dropped-")), "no dropped-content reason is emitted");
  assert.deepEqual(summary.incompleteReasons, []);
  assert.equal(summary.complete, true);
});

test("segment-cut is a reason only when the cut removed rows", () => {
  // Thirteenth audit item 8: `segment-cut:0` was emitted for any non-null
  // segment, naming a cut that dropped nothing.
  const base = { live: true, asks: 1, triggers: 1, answeredRows: 1, segment: 139,
    excludedRows: 0 };
  assert.ok(!citableReasonsOf(base).some(reason => reason.startsWith("segment-cut")),
    "a segment that cut nothing is not a reason");
  assert.ok(citableReasonsOf({ ...base, excludedRows: 3 }).includes("segment-cut:3"),
    "a cut that removed rows keeps its count");
});





// ---- the eleventh audit: completeness, tools, coverage, ordering -----------

test("P1: a refused answer row makes the sample incomplete, never complete", async () => {
  // The reported shape: rows tabled, some answered and some refused by the
  // parser. `complete` read only the ceiling, failed sends and the segment cut,
  // so three refusals in ten rows still read as a complete sample.
  const transcript = [{ type: "session", id: "session-issue-212-p1" }, systemRow(),
    lineRow(1, 1), lineRow(2, 2)];
  const depths = depthsFrom([[1, 1000], [2, 2000], [3, 2000]]);
  const transport = scriptedTransport((ask, indices) => ({
    [indices[0]]: { keepall: true },
  }));
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 2,
    mode: "batch", floor: 100, allowZeroReasoning: true, grammar: "3option", transport,
    askCeiling: 4, deadline: Date.now() + 60_000 });
  assert.equal(summary.refused, 1, "the parser refused one tabled row");
  assert.equal(summary.carried, 0, "nothing was carried: this is not a tail");
  assert.equal(summary.refusedSends, 0, "no send failed: the row itself was refused");
  assert.deepEqual(summary.incompleteReasons, ["refused-rows:1"],
    "the refused row is named in the incompleteness list");
  assert.equal(summary.complete, false,
    "seven of ten decided is 70% of the sample, never a complete run");
  assert.equal(summary.measurement.complete, false);
});

test("P2: no request/header, or an empty tools array, is recorded and named", async () => {
  const run = async rows => runLane({ ignoreHostPrunes: true,
    transcript: rows, depths: depthsFrom([[1, 1000], [2, 2000]]), lane: 1, mode: "batch",
    floor: 100, allowZeroReasoning: true,
    transport: scriptedTransport((ask, indices) => verdictsFor(indices, () => ({ keepall: true }))),
    askCeiling: 2, deadline: Date.now() + 60_000 });
  const head = [{ type: "session", id: "session-issue-212-p2" },
    { type: "step/start", seq: 1, data: { step: 1 } }, lineRow(2, 1)];
  // (a) no header at all: the tools vanish, and the record says so.
  const absent = await run(head);
  assert.deepEqual(absent.contextStandIn.tools, { source: "none", seq: null, count: 0 },
    "the block names where the tools came from, and that they came from nowhere");
  assert.ok(absent.measurement.reasons.includes("tools-absent"),
    "a run with no tool schema is a named reason, never a silent empty array");
  // (b) a header whose tools array is empty: the same hole under its own seq.
  const empty = await run([...head,
    { type: "request/header", seq: 3, data: { header: { tools: [] } } }]);
  assert.deepEqual(empty.contextStandIn.tools, { source: "request/header", seq: 3, count: 0 });
  assert.ok(empty.measurement.reasons.includes("tools-absent"));
  // (c) a header with one tool: the seq is recorded and no reason is emitted.
  const full = await run([...head, { type: "request/header", seq: 3,
    data: { header: { tools: [{ name: "read", description: "read a file", parameters: {} }] } } }]);
  assert.deepEqual(full.contextStandIn.tools, { source: "request/header", seq: 3, count: 1 });
  assert.ok(!full.measurement.reasons.includes("tools-absent"),
    "a run that carries its tool schema is not named for a missing one");
});

test("P3: a source that lost reasoning on half its assistant turns refuses", () => {
  // Two assistant turns, one with a reasoning part AND its echoes, one stripped
  // of both. Every old count agreed (parts = blocks = turns = echoes = 1), so
  // the loss was invisible outside the segment-139 pins.
  const rows = [
    { type: "step/start", seq: 1, data: { step: 1 } },
    { type: "system/message", seq: 2, data: { message: { content: [{ type: "text", text: "sys" }] } } },
    { type: "assistant/message", seq: 3, data: { message: { role: "assistant", content: [
      { type: "reasoning", text: "kept reason" }, { type: "text", text: "one" }],
      source: { replayState: { blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" },
        { type: "text" }] } } }, stream: [{ blockType: "reasoning" },
          { blockType: "text" }] } },
    { type: "assistant/message", seq: 4, data: { message: { role: "assistant",
      content: [{ type: "text", text: "two" }] } } },
    { type: "session", seq: 5, id: "session-issue-212-p3" },
  ];
  const timeline = readTimeline(rows);
  assert.equal(timeline.assistantTurns, 2);
  assert.equal(timeline.reasoningTurns, 1, "half the assistant turns carry reasoning");
  assert.equal(timeline.reasoningMarkedTurns, 1, "the stripped turn echoes nothing either");
  assert.throws(() => assertReasoningCarried(timeline), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-reasoning-coverage"
    && /1 of 2/.test(error.message));
});

test("P7: a shape landing on the host prune's own step is credited nothing, and says so", async () => {
  // The audit called this branch unreachable. It is reachable: a unit landing at
  // step 2 is answered at step 3 (its decision step) and the host's prune names
  // it at step 3 too, so the shaped turn stands for no window at all. The run
  // books nothing, and the freed figure agrees with the bookings.
  const rows = [
    { type: "session", seq: 1, id: "session-issue-212-p7" },
    { type: "step/start", seq: 2, data: { step: 2 } },
    lineRow(3, 2),
    { type: "step/start", seq: 4, data: { step: 3 } },
    { type: "compaction/prune", seq: 5, data: { shadowedSeqs: [3], shadowedTokenCount: 1900 } },
    // A prune needs its replacement row (the pin compares the two counts), and
    // the row must clear the FIXED 512 B eligibility floor to be counted as a
    // host replacement (`surfacePinsOf` reads `FLOOR_BYTES`, not the run's). It
    // is a unit at step 3; the ceiling below stops before its fire.
    { type: "tool/result", seq: 6, surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
      data: { step: 3, content: [{ type: "text",
        text: `${"r".repeat(300)}\n${"s".repeat(300)}` }] } },
  ];
  const summary = await runLane({ transcript: rows,
    depths: depthsFrom([[2, 4000], [3, 4000], [4, 3000]]), lane: 1, mode: "batch",
    floor: 100, ignoreHostPrunes: false, allowZeroReasoning: true,
    // The sub-floor replacement row that keeps the prune/replacement pin happy
    // is also a unit at step 3; the ceiling stops before its fire, so this run
    // measures exactly the one fire that lands on the prune's own step.
    askCeiling: 1, grammar: "3option",
    transport: scriptedTransport((ask, indices) => verdictsFor(indices,
      () => ({ forgetall: "gone" }))), deadline: Date.now() + 60_000 });
  assert.equal(summary.appliedForgets, 1, "the surface DID receive the shaped turn");
  assert.deepEqual(summary.removalBookings, [],
    "a shape the host's own prune takes at the same step frees no window: nothing is booked");
  assert.equal(summary.bytesFreedByPolicy, 0, "and the freed figure agrees");
});

test("a correction's anchor delta is body-based, and the added units share one ceiling", async () => {
  // Two units land at the fire's own step, so the anchor adds both. Their token
  // addend is ONE ceiling over the summed bytes, not a sum of per-unit ceilings:
  // 1,001 B each is 330 tokens apiece (660) but 659 tokens together.
  const body = `${"a".repeat(500)}\n${"b".repeat(500)}`;
  const bodyRow = (seq, step) => ({ type: "tool/result", seq, surfaceOp: "append",
    data: { step, content: [{ type: "text", text: body }] } });
  let calls = 0;
  const transport = { name: "correcting", live: false,
    ask: async ({ ask, indices }) => {
      calls += 1;
      const content = ask === 0 && calls === 1
        // An answered arithmetic refusal earns the ONE correction send.
        ? JSON.stringify({ 1: { keeplines: [[1, 99], "past the end"] },
          2: { keepall: true } })
        : JSON.stringify(Object.fromEntries(indices.map(index => [index, { keepall: true }])));
      return { ok: true, httpStatus: null, latencyMs: 0, content,
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    } };
  const transcript = [{ type: "session", id: "session-issue-212-anchor" },
    bodyRow(1, 1), bodyRow(2, 1)];
  const depths = depthsFrom([[1, 4000], [2, 4000]]);
  const records = [];
  await runLane({ ignoreHostPrunes: false, transcript, depths, lane: 2,
    mode: "batch", floor: 100, allowZeroReasoning: true, transport, askCeiling: 4,
    grammar: "3option",
    deadline: Date.now() + 60_000, onRecord: record => records.push(record) });
  const main = records.find(record => record.kind !== "correction");
  const correction = records.find(record => record.kind === "correction");
  assert.ok(main !== undefined && correction !== undefined, "both sends carry a record");
  assert.equal(main.anchorAddedUnits, 2, "both units landed at the fire's own step");
  const unitBytes = readTimeline(withStepStarts(transcript, depths)).units
    .reduce((sum, unit) => sum + unit.bytes, 0);
  assert.equal(unitBytes, 2002, "each body is exactly 1,001 B");
  assert.equal(main.anchorAddedUnitTokens, measuredTokensOf(unitBytes),
    "ONE ceiling over the summed bytes (659), never a sum of per-unit ceilings (660)");
  // The correction's delta is measured on the SAME basis as its base, the full
  // request body: two added messages, both their bytes.
  assert.equal(correction.anchorDeltaBytes,
    correction.promptWireBytes - main.promptWireBytes,
    "the byte delta is the body's growth, not the content-only growth");
  assert.equal(correction.anchorDeltaTokens, measuredTokensOf(correction.anchorDeltaBytes));
  assert.equal(correction.anchorDepth, main.anchorDepth + correction.anchorDeltaTokens,
    "the anchor is additive on one basis");
});

test("P5: a depth reading that rests on its own cache statement is a named reason", async () => {
  // `inputTokensIncludeCache: true` with no prompt count, no output count and no
  // total: nothing independent says where the cache sits. The series records the
  // step, and the run names it, instead of trusting the statement silently.
  const depths = readUsage({ rows: [{ step: 1, inputTokens: 100, cacheReadTokens: 50,
    inputTokensIncludeCache: true }] });
  const transcript = [{ type: "session", id: "session-issue-212-p5" }, lineRow(1, 1)];
  const summary = await runLane({ ignoreHostPrunes: true, transcript, depths, lane: 1,
    mode: "batch", floor: 1, allowZeroReasoning: true,
    transport: scriptedTransport((ask, indices) => verdictsFor(indices, () => ({ keepall: true }))),
    askCeiling: 2, deadline: Date.now() + 60_000 });
  assert.deepEqual(summary.usageSteps.statedOnlySteps, [1],
    "the summary names the step whose depth rests on its own statement");
  assert.ok(summary.measurement.reasons.includes("usage-shape-unverified:1"),
    "and the reason list carries it, so the run can never read as corroborated");
});

test("the summary says other segments carry no count pins", async () => {
  const transcript = [{ type: "session", id: "session-issue-212-pins" }, lineRow(1, 1)];
  const summary = await runLane({ ignoreHostPrunes: true, transcript,
    depths: depthsFrom([[1, 1000], [2, 1000]]), lane: 1, mode: "batch", floor: 1,
    allowZeroReasoning: true,
    transport: scriptedTransport((ask, indices) => verdictsFor(indices, () => ({ keepall: true }))),
    askCeiling: 2, deadline: Date.now() + 60_000 });
  assert.deepEqual(summary.countPins,
    { appliesAtSegment: SEGMENT_PINS.segment, active: false, note: summary.countPins.note },
    "a segment other than 139 states that the count pins did not run");
  assert.match(summary.countPins.note, /no count pins/);
});

test("the surface gate compares the CURRENT size to the decision log, not two counters", () => {
  // The old gate compared `surfaceShapesEverAppliedOf` to the run's own applied
  // count: two counters incremented under one predicate. The real check is the
  // surface's current size against the surface the DECISION LOG rebuilds.
  const surface = simulateSurface({ fireIndex: 1 });
  assert.throws(() => assertSurfaceAdvanced({ surface, fire: 1, shaped: 0,
    expectedSize: 1 }), error =>
    error instanceof SimBatchUnitsRefusal && error.code === "sim-batch-surface-removals"
    && /currently holds 0 shaped turn/.test(error.message));
  // A surface holding the rebuilt set passes, whatever its cumulative count is.
  const full = simulateSurface({ fireIndex: 1 });
  full.set(7, "forgotten");
  assert.deepEqual(assertSurfaceAdvanced({ surface: full, fire: 1, shaped: 99,
    expectedSize: 1 }), { fire: 1, shaped: 99, digest: surfaceDigestOf(full) });
});

/* ------------------------------------------------------------------------- *
 * The inline-ask lane (inline-ask experiment, 2026-11-08).
 * ------------------------------------------------------------------------- */

/** One deterministic stub run of both arms; the inline-lane tests share it. */
let inlineArmsPromise = null;
const committedInlineArms = () => {
  if (inlineArmsPromise === null) {
    const timeline = readTimeline(INLINE_FIXTURE, { ignoreHostPrunes: true });
    inlineArmsPromise = runInlineArms({ timeline, transport: stubTransport(),
      floor: INLINE_FLOOR_BYTES, tokenGrant: 10_000_000,
      rebuildTokens: INLINE_REBUILD_TOKENS, log: () => {} });
  }
  return inlineArmsPromise;
};

test("inline lane: only an eligible result earns a block", () => {
  const body = `${"alpha line one ".repeat(40)}\n${"beta line two ".repeat(40)}`;
  const eligible = inlineAppendOf({ seq: 7, text: body }, { index: 1, callOrdinal: 1 });
  assert.notEqual(eligible.block, null);
  assert.ok(eligible.block.startsWith(`\n${INLINE_MARKER}`));
  assert.equal(eligible.text, body + eligible.block);
  const error = inlineAppendOf({ seq: 8, text: body, isError: true }, { index: 2 });
  assert.equal(error.block, null);
  assert.equal(error.reason, "error-result");
  const small = inlineAppendOf({ seq: 9, text: "tiny" }, { index: 3 });
  assert.equal(small.block, null);
  assert.equal(small.reason, "below-floor");
  const marked = inlineAppendOf({ seq: 10, text: `${INLINE_MARKER}\n${body}` }, { index: 4 });
  assert.equal(marked.block, null);
  assert.equal(marked.reason, "marker-present");
});

test("inline lane: both arms run the committed fixture with the stub", async () => {
  const arms = await committedInlineArms();
  const inline = arms.inline;
  assert.ok(inline.blocks.length > 0, "the eligible results earned blocks");
  assert.ok(inline.replayCalls > 0, "each block got a labelled extra call");
  assert.ok(inline.replayCallsPerResult > 0.9 && inline.replayCallsPerResult <= 1,
    "at most one extra call per block, and the rebuild-triggering block gets none");
  assert.equal(inline.replayCalls + 1, inline.blocks.length);
  assert.notEqual(inline.rebuild, null, "the 200k bar was crossed");
  assert.ok(inline.depth.before >= INLINE_REBUILD_TOKENS);
  assert.ok(inline.depth.after < inline.depth.before, "the rebuild lowered the depth");
  assert.equal(inline.tablePass.fortyPercent, true);
  assert.equal(inline.tablePass.seventyPercent, false);
  assert.equal(inline.tablePass.grammar, INLINE_TABLE_GRAMMAR);
  assert.ok(inline.tablePass.applied > 0, "the table answers were applied");
  assert.equal(inline.turns.extraTurns, 1, "only the one rebuild turn");
  assert.equal(inline.turns.rebuildTurns, 1);
  assert.equal(inline.turns.inline.total, inline.turns.baseline.total + 1);
  // The rebuild stripped its own surface, but 33 blocks landed AFTER it and
  // stay: the final ledger says so instead of reporting zero.
  assert.equal(inline.afterRebuild.blocks, 33,
    "the fixture's post-rebuild tail is 33 blocks");
  assert.equal(inline.reconciliation.blocksRemaining, inline.afterRebuild.blocks,
    "blocksRemaining is what the surface still holds, not what the rebuild saw");
  assert.equal(inline.reconciliation.blocksRemaining,
    inline.blocks.length - inline.rebuild.stats.blocksRemoved,
    "the structural count and the arm counter agree");
  assert.equal(inline.reconciliation.answersRemaining, inline.afterRebuild.answers,
    "answersRemaining counts the post-rebuild artifacts");
  assert.equal(inline.reconciliation.blocksRemainingAtRebuild, 0,
    "the rebuild-time reading is kept under its own name");
  assert.equal(inline.reconciliation.answersRemainingAtRebuild, 0);
  assert.equal(inline.reconciliation.mismatch, null,
    "the two readings agree; the ledger is consistent");
  assert.equal(inline.reconciliation.ok, false,
    "the final surface still holds blocks, so the ledger is not clean");
  assert.equal(inline.bytes.totalRemoved,
    inline.bytes.removedBlocks + inline.bytes.removedAnswers + inline.bytes.removedResults);
  assert.equal(inline.provider, "stub");
  assert.equal(inline.billable, false);
  assert.ok(["token-budget", "token-budget-after-call", "input-end"].includes(inline.endedBy));
  assert.equal(inline.budgetEnforced, "between-calls",
    "the record states where the cap is enforced");
  assert.equal(inline.budgetExceeded, inline.spentTokens > inline.tokenGrant,
    "budgetExceeded states whether the spend passed the grant");
  assert.equal(inline.budgetOvershootTokens,
    Math.max(0, inline.spentTokens - inline.tokenGrant),
    "the overshoot is the spend past the grant, never a negative");
  assert.equal(inline.budgetReached, inline.spentTokens >= inline.tokenGrant,
    "budgetReached reads this arm's own spend against the grant");
  const applied = [...inline.rebuild.plan.forgets, ...inline.rebuild.plan.keeplines,
    ...(inline.rebuild.tablePlan?.forgets ?? []), ...(inline.rebuild.tablePlan?.keeplines ?? [])];
  assert.ok(applied.length > 0);
  for (const entry of applied) {
    assert.equal(typeof entry.recallId, "string", "every applied removal has a recall id");
    assert.equal(typeof entry.receipt, "string", "every applied removal has a receipt");
  }
  assert.equal(inline.rebuild.plan.recall.length,
    inline.rebuild.plan.forgets.length + inline.rebuild.plan.keeplines.length,
    "each inline removal keeps its original bytes under its recall id");
  assert.equal((inline.rebuild.tablePlan?.recall?.length ?? 0),
    (inline.rebuild.tablePlan?.forgets?.length ?? 0)
    + (inline.rebuild.tablePlan?.keeplines?.length ?? 0),
    "each table removal keeps its original bytes under its recall id");

  const table = arms.tableOnly;
  assert.equal(table.blocks.length, 0);
  assert.equal(table.replayCalls, 0, "the table-only arm makes no inline calls");
  assert.equal(table.calls.length, 1, "one table call at the bar");
  assert.equal(table.calls[0].kind, "table-pass");
  assert.equal(table.tablePass.fortyPercent, true);
  assert.equal(table.tablePass.seventyPercent, false);
  assert.ok(table.tablePass.units > 0);
  assert.ok(table.tablePass.applied > 0);
  assert.equal(table.turns.extraTurns, 1, "the table pass is the one turn");
  assert.equal(table.reconciliation.ok, true);
  assert.equal(table.endedAtStep, inline.endedAtStep,
    "both arms stop at the common stop, not at their own input ends");
  assert.equal(table.unitsSeen, inline.unitsSeen,
    "both arms saw the same eligible units");
  assert.deepEqual(table.commonStop, inline.commonStop);
  assert.equal(inline.commonStop.step, inline.endedAtStep);
  assert.ok(["token-budget", "token-budget-after-call", "input-end", "max-steps"]
    .includes(inline.commonStop.by));
  assert.equal(table.turns.baseline.total, inline.turns.baseline.total,
    "the capped table-only arm reads the same rows as the inline prefix");
  assert.equal(table.budgetEnforced, "between-calls");
  assert.equal(table.budgetExceeded, table.spentTokens > table.tokenGrant);
  assert.equal(table.budgetOvershootTokens,
    Math.max(0, table.spentTokens - table.tokenGrant));
  assert.equal(table.budgetReached, table.spentTokens >= table.tokenGrant,
    "the table-only arm's budgetReached reads its own spend, not the shared stop");

  assert.equal(arms.compare.reconciles, false,
    "the inline arm's ledger is honestly not clean: 33 blocks remain after the rebuild");
  assert.equal(arms.compare.budget.enforced, "between-calls");
  assert.equal(arms.compare.budget.inline.endedBy, inline.endedBy);
  assert.equal(arms.compare.budget.inline.overshootTokens, inline.budgetOvershootTokens);
  assert.equal(arms.compare.budget.tableOnly.exceeded, table.budgetExceeded);
  assert.equal(arms.compare.budget.grant, inline.tokenGrant);
  assert.equal(arms.compare.commonPrefix.primary, true);
  assert.equal(arms.compare.commonPrefix.comparable, true);
  assert.equal(arms.compare.commonPrefix.steps.inline,
    arms.compare.commonPrefix.steps.tableOnly);
  assert.equal(arms.compare.commonPrefix.unitsSeen.inline,
    arms.compare.commonPrefix.unitsSeen.tableOnly);
  assert.equal(arms.compare.commonPrefix.diff.baselineAtEnd, 0,
    "the primary window holds the same rows on both arms");
  assert.notEqual(arms.compare.commonPrefix.diff.calls, 0,
    "the arms made different call counts within the same window");
  assert.notEqual(arms.compare.commonPrefix.diff.netRemoved, 0,
    "the arms removed different bytes within the same window");
  assert.equal(arms.compare.fullRun.primary, false, "fullRun is secondary");
});

test("inline lane: both arms' depth is measured at the common stop, one step", async () => {
  const arms = await committedInlineArms();
  const inline = arms.inline;
  const table = arms.tableOnly;
  assert.equal(inline.depthAtCommonStop.step, arms.commonStop.step);
  assert.equal(table.depthAtCommonStop.step, arms.commonStop.step);
  assert.equal(inline.depthAtCommonStop.step, table.depthAtCommonStop.step,
    "the depth delta reads one step for both arms");
  assert.equal(inline.depth.finalStep, inline.depthAtCommonStop.step);
  assert.equal(table.depth.finalStep, table.depthAtCommonStop.step);
  // The table arm's `after` is its post-bar reading; rows after the bar land
  // unshaped, so the common-stop depth is the larger, honest number.
  assert.equal(table.depth.afterStep, table.bar.step);
  assert.ok(table.depthAtCommonStop.tokens > table.depth.after,
    "the common-stop depth includes the rows after the bar");
  const prefix = arms.compare.commonPrefix;
  assert.equal(prefix.depthAtCommonStop.step, arms.commonStop.step);
  assert.equal(prefix.depthAtCommonStop.inline, inline.depthAtCommonStop.tokens);
  assert.equal(prefix.depthAtCommonStop.tableOnly, table.depthAtCommonStop.tokens);
  assert.equal(prefix.depthAtCommonStop.delta,
    table.depthAtCommonStop.tokens - inline.depthAtCommonStop.tokens);
  assert.equal(prefix.diff.depthAtCommonStop, prefix.depthAtCommonStop.delta);
  assert.equal("depthAfter" in prefix.diff, false,
    "no post-rebuild depth is subtracted from a post-table depth");
  const settings = { floor: INLINE_FLOOR_BYTES, rebuildTokens: INLINE_REBUILD_TOKENS,
    tableGrammar: INLINE_TABLE_GRAMMAR };
  // One arm at another step: refused by name, never compared.
  const shifted = Object.freeze({ ...table, depthAtCommonStop: Object.freeze({
    step: table.depthAtCommonStop.step - 1, tokens: table.depthAtCommonStop.tokens }) });
  assert.throws(() => inlineCompareOf({ inline, tableOnly: shifted, input: {},
    settings, commonStop: arms.commonStop }), error =>
    error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-inline-compare-depth-step");
  // Both arms agreed on a step that is not the common stop: refused too.
  const offInline = Object.freeze({ ...inline, depthAtCommonStop: Object.freeze({
    step: arms.commonStop.step - 1, tokens: inline.depthAtCommonStop.tokens }) });
  assert.throws(() => inlineCompareOf({ inline: offInline, tableOnly: shifted, input: {},
    settings, commonStop: arms.commonStop }), error =>
    error instanceof SimBatchUnitsRefusal
    && error.code === "sim-batch-inline-compare-depth-step");
});

test("inline lane: the final ledger counts what the surface still holds", async () => {
  const arms = await committedInlineArms();
  const inline = arms.inline;
  const table = arms.tableOnly;
  assert.equal(inline.afterRebuild.blocks, 33);
  assert.equal(inline.reconciliation.blocksRemaining, inline.afterRebuild.blocks,
    "blocksRemaining is the blocks still on the surface");
  assert.equal(inline.reconciliation.answersRemaining, inline.afterRebuild.answers,
    "answersRemaining is the artifacts still on the surface");
  assert.equal(inline.reconciliation.blocksRemainingAtRebuild, 0,
    "the rebuild stripped every block that was on its surface");
  assert.equal(inline.reconciliation.mismatch, null);
  assert.equal(inline.reconciliation.ok, false,
    "a surface that still holds 33 blocks is not a clean ledger");
  assert.equal(table.reconciliation.blocksRemaining, 0);
  assert.equal(table.reconciliation.answersRemaining, 0);
  assert.equal(table.reconciliation.mismatch, null);
  assert.equal(table.reconciliation.ok, true);
  // A counter that disagrees with the structural count is named, not zeroed.
  const tampered = inlineLedgerOf({ blocks: inline.blocks, decisions: inline.decisions,
    stats: inline.rebuild.stats,
    afterRebuild: { ...inline.afterRebuild, blocks: inline.afterRebuild.blocks + 1 } });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.mismatch.code, "ledger-mismatch");
  assert.match(tampered.mismatch.message, /block\(s\)/);
  const clean = inlineLedgerOf({ blocks: [], decisions: [], stats: {},
    afterRebuild: { blocks: 0, answers: 0 } });
  assert.equal(clean.ok, true);
  assert.equal(clean.mismatch, null);
});

test("inline lane: net removed obeys its components on both arms", async () => {
  const arms = await committedInlineArms();
  for (const arm of [arms.inline, arms.tableOnly]) {
    const bytes = arm.bytes;
    assert.equal(bytes.netRemoved,
      bytes.totalRemoved - bytes.addedByBlocks - bytes.addedByAnswers
      - bytes.shapedTurnDelta, `${arm.arm}: net = gross - every byte put back`);
    assert.ok(bytes.shapedTurnDelta > 0,
      `${arm.arm}: a shaped replacement adds bytes back`);
    assert.ok(bytes.netRemoved > 0);
    assert.ok(bytes.netRemoved < bytes.totalRemoved, `${arm.arm}: net is below gross`);
  }
  assert.notEqual(arms.inline.bytes.statsNetRemoved, arms.inline.bytes.netRemoved,
    "the stats-only figure (blocks only) is not the headline net");
  const synthetic = inlineShapedTurnDeltaOf({ forgets: [
    { shapedText: "abcd", keptBytes: 1 }] });
  assert.deepEqual(synthetic, { shapedTurnBytes: 4, shapedTurnKeptBytes: 1,
    shapedTurnDelta: 3 });
});

test("inline lane: the comparison labels the stub answer mix as a confound", async () => {
  const arms = await committedInlineArms();
  const inlineMix = arms.compare.arms.inline.answerMix;
  const tableMix = arms.compare.arms.tableOnly.answerMix;
  assert.equal(inlineMix.inline.answered, 44);
  assert.equal(inlineMix.inline.refused, 52);
  assert.equal(inlineMix.table.answered, 37);
  assert.equal(inlineMix.table.refused, 0);
  assert.equal(tableMix.table.answered, 72);
  assert.equal(tableMix.table.refused, 0);
  assert.equal(inlineMix.answered, 81);
  assert.equal(inlineMix.refused, 52);
  assert.equal(inlineMix.byCode["answer-unreadable"], 18);
  assert.equal(arms.compare.commonPrefix.answerMix.inline.inline.answered, 44);
  assert.equal(arms.compare.commonPrefix.answerMix.tableOnly.table.answered, 72);
  assert.equal(arms.compare.confounded, "stub-answer-mix");
  assert.match(arms.compare.confoundedNote, /44 answered \/ 52 refused/);
  assert.match(arms.compare.confoundedNote, /72 answered \/ 0 refused/);
  // The mix helper reports the same reading from a decision list.
  assert.deepEqual(inlineAnswerMixOf(arms.inline.decisions),
    { answered: 44, refused: 52, byCode: { "action-not-in-grammar": 18,
      "malformed-row": 16, "answer-unreadable": 18 } });
});

test("inline lane: the shared stop caps both arms at one step", async () => {
  const timeline = readTimeline(INLINE_FIXTURE, { ignoreHostPrunes: true });
  const arms = await runInlineArms({ timeline, transport: stubTransport(),
    floor: INLINE_FLOOR_BYTES, tokenGrant: 10_000_000,
    rebuildTokens: INLINE_REBUILD_TOKENS, maxSteps: 30, log: () => {} });
  assert.equal(arms.inline.endedAtStep, arms.tableOnly.endedAtStep);
  assert.ok(arms.inline.endedAtStep <= 30, "--max-steps caps the prefix");
  assert.equal(arms.inline.unitsSeen, arms.tableOnly.unitsSeen);
  assert.deepEqual(arms.inline.commonStop, arms.tableOnly.commonStop);
  assert.equal(arms.commonStop.step, arms.inline.endedAtStep);
  assert.equal(arms.commonStop.by, "max-steps");
  assert.equal(arms.inline.endedBy, "max-steps");
  assert.equal(arms.tableOnly.endedBy, "common-stop");
  assert.equal(arms.compare.commonPrefix.comparable, true);
  assert.equal(arms.compare.commonPrefix.steps.inline, arms.inline.endedAtStep);
  assert.equal(arms.compare.commonPrefix.unitsSeen.inline,
    arms.compare.commonPrefix.unitsSeen.tableOnly);
  // A shorter table-only end is never padded: input-end wins and is named.
  const shorter = inlineCommonStopOf({ inline: arms.inline,
    tableOnly: { endedAtStep: 10 }, timeline, floor: INLINE_FLOOR_BYTES });
  assert.deepEqual(shorter, { step: 10, by: "input-end" });
});

test("inline lane: a run past the grant names the stop and the overshoot", async () => {
  // The cap is checked between calls, so the call that crosses the grant has
  // already returned: the stop is named `token-budget-after-call` and the
  // record states the spend past the grant instead of reading as a precise cap.
  const timeline = readTimeline(INLINE_FIXTURE, { ignoreHostPrunes: true });
  const arm = await runInlineAskArm({ timeline, transport: stubTransport(),
    floor: INLINE_FLOOR_BYTES, tokenGrant: 500, log: () => {} });
  assert.ok(arm.spentTokens > arm.tokenGrant, "the first call already passed the grant");
  assert.equal(arm.endedBy, "token-budget-after-call");
  assert.equal(arm.budgetReached, true, "the arm's own spend passed the grant");
  assert.equal(arm.budgetExceeded, true);
  assert.equal(arm.budgetOvershootTokens, arm.spentTokens - arm.tokenGrant);
  assert.equal(arm.budgetEnforced, "between-calls");
  assert.ok(arm.limitations.some(line =>
    /last call's cost is only known after it returns/.test(line)),
  "the record states why an overshoot is possible");
  const stop = inlineCommonStopOf({ inline: arm, timeline, floor: INLINE_FLOOR_BYTES });
  assert.equal(stop.by, "token-budget-after-call",
    "the shared stop carries the precise budget label");
});

test("inline lane: an arm under the grant reports no overshoot", async () => {
  const timeline = readTimeline(INLINE_FIXTURE, { ignoreHostPrunes: true });
  const arm = await runInlineAskArm({ timeline, transport: stubTransport(),
    floor: INLINE_FLOOR_BYTES, tokenGrant: 100_000_000, maxSteps: 5, log: () => {} });
  assert.ok(arm.spentTokens > 0, "the arm made calls");
  assert.ok(arm.spentTokens < arm.tokenGrant);
  assert.equal(arm.endedBy, "max-steps", "the step cap ended it, not the budget");
  assert.equal(arm.budgetReached, false, "the arm stayed under its grant");
  assert.equal(arm.budgetExceeded, false);
  assert.equal(arm.budgetOvershootTokens, 0);
  assert.equal(arm.budgetEnforced, "between-calls");
});

test("inline lane: the primary comparison refuses a delta on unequal stops", async () => {
  const arms = await committedInlineArms();
  const shifted = Object.freeze({
    ...arms.tableOnly, endedAtStep: arms.tableOnly.endedAtStep - 1,
  });
  const compare = inlineCompareOf({ inline: arms.inline, tableOnly: shifted,
    input: {}, settings: { floor: INLINE_FLOOR_BYTES,
      rebuildTokens: INLINE_REBUILD_TOKENS, tableGrammar: INLINE_TABLE_GRAMMAR },
    commonStop: arms.commonStop });
  assert.equal(compare.commonPrefix.primary, true);
  assert.equal(compare.commonPrefix.comparable, false);
  assert.equal(compare.commonPrefix.diff, null,
    "no delta is reported over unequal windows");
  assert.equal(compare.commonPrefix.notComparable.code,
    "sim-batch-inline-compare-steps");
  assert.match(compare.commonPrefix.notComparable.message, /inline ended at step/);
  assert.equal(compare.fullRun.primary, false, "fullRun stays labelled secondary");
  assert.notEqual(compare.fullRun.diff.endedAtStep, 0,
    "fullRun states the unequal ends, not a common-prefix win");
});

test("inline lane: the CLI writes both arm records and the comparison", () => {
  const out = mkdtempSync(path.join(tmpdir(), "racoons-inline-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
      "--transport", "stub", "--ignore-host-prunes", "--inline-ask", "--table-only",
      "--grammar", "jsonl-20-nokeepall",
      "--floor", "512", "--token-grant", "10000000",
      "--transcript", INLINE_FIXTURE, "--usage", INLINE_USAGE, "--out", out],
    { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const inline = JSON.parse(readFileSync(path.join(out, "inline-ask.json"), "utf8"));
    const table = JSON.parse(readFileSync(path.join(out, "table-only.json"), "utf8"));
    const compare = JSON.parse(readFileSync(path.join(out, "inline-ask.compare.json"), "utf8"));
    assert.ok(inline.blocks.length > 0);
    assert.equal(table.blocks.length, 0);
    assert.ok(inline.records.some(record => record.kind === "replay-extra-call"));
    assert.equal(table.records.length, 1);
    assert.equal(table.records[0].kind, "table-pass");
    assert.equal(compare.schema, "racoons-sim-inline-ask-compare/1");
    assert.equal(compare.reconciles, false,
      "the inline arm still holds post-rebuild blocks; the ledger says so");
    assert.equal(compare.arms.inline.reconciliation.blocksRemaining, 33);
    assert.equal(compare.arms.inline.reconciliation.mismatch, null);
    assert.equal(compare.commonPrefix.depthAtCommonStop.step, compare.commonStop.step);
    assert.equal(compare.commonPrefix.depthAtCommonStop.inline,
      inline.depthAtCommonStop.tokens);
    assert.equal(compare.commonPrefix.depthAtCommonStop.tableOnly,
      table.depthAtCommonStop.tokens);
    assert.equal(compare.provider.name, "stub");
    assert.equal(compare.provider.billable, false);
    assert.deepEqual(inline.commonStop, table.commonStop,
      "both arm records carry the same common stop");
    assert.equal(compare.commonStop.step, inline.endedAtStep);
    assert.equal(compare.commonPrefix.comparable, true);
    assert.equal(compare.commonPrefix.steps.inline, compare.commonPrefix.steps.tableOnly);
    assert.ok(compare.limitations.some(line => /replay-extra-call/.test(line)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("inline lane: a timer, a foreign floor, a foreign grammar or the host pruner refuse by name", () => {
  const run = extra => spawnSync(process.execPath, [SCRIPT, "--i-am-the-owner",
    "--transport", "stub", "--inline-ask", "--token-grant", "10000000", ...extra],
  { encoding: "utf8", timeout: 60_000 });
  const cases = [
    [["--kill-ms", "1"], /sim-batch-inline-caps/],
    [["--floor", "100"], /sim-batch-inline-floor/],
    [["--ask-grammar", "jsonl-20"], /sim-batch-inline-grammar/],
    [["--allow-host-pruner"], /sim-batch-inline-host-pruner/],
  ];
  for (const [extra, pattern] of cases) {
    const result = run(extra);
    assert.equal(result.status, 2, `${extra.join(" ")} exits 2`);
    assert.match(result.stderr, pattern);
  }
});

test("inline lane: the prunes cut runs as a reconstruction", async () => {
  const timeline = readTimeline(INLINE_PRUNES_FIXTURE,
    { ignoreHostPrunes: true, reconstruction: true });
  const arm = await runTableOnlyArm({ timeline, transport: stubTransport(),
    floor: INLINE_FLOOR_BYTES, tokenGrant: 10_000_000,
    rebuildTokens: INLINE_REBUILD_TOKENS, log: () => {} });
  assert.equal(arm.bar.reached, true);
  assert.ok(arm.tablePass.units > 0);
  assert.equal(arm.tablePass.fortyPercent, true);
  assert.equal(arm.tablePass.seventyPercent, false);
  assert.ok(arm.tablePass.applied > 0);
  assert.equal(arm.reconciliation.ok, true);
  assert.ok(arm.bytes.netRemoved > 0);
});
