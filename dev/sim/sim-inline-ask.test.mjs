#!/usr/bin/env node
/**
 * The inline-ask prototype (2026-11-08; branch `alt/inline-ask`).
 *
 * Run: `node --test dev/sim/sim-inline-ask.test.mjs`
 *
 * Twenty-three cases: the block's exact bytes and its clean quotes; the two accepted
 * actions and the named refusals; the registry-driven rebuild; both removal
 * shapes; the turn count; the 40 percent rebuild prompt; the report's one-cap
 * statement; one case per audit round 1 finding (marker in an original, an
 * echoed example, every tagged artifact, duplicate decisions and idempotence,
 * the answer artifact's separator, dirty quotes, result-absent plus recall, and
 * the final-surface ledger); one case per round-2 finding (the budget
 * record and its non-negative turn count, the over-grant stop, the under-grant
 * run, the answer-tag quote filter, and the mini row's call ordinal); and one
 * case per round-3 finding (the pre-call projected stop versus the after-call
 * stop, and the final surface's ok aligned with the replay's reconciliation.ok).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  ENTRY_ASK_MIN_QUOTE_LINES, byteRangeForLines, complementByteRanges,
} from "@cremator/core";
import {
  GRAMMAR_GATE_CODE, JSONL_20_FIRST_TARGET,
} from "./sim-batch-grammar.mjs";
import {
  INLINE_FLOOR_BYTES, INLINE_MARKER, INLINE_REBUILD_TOKENS, SIM_TOKEN_BUDGET,
  answerTagOf, appendInlineBlockOf, inlineAskReport, inlineBlockOf, inlineEligibilityOf,
  linesOf, parseInlineAnswer, rebuildSurface, restoreFromRecall,
} from "./sim-inline-ask.mjs";
import {
  bigTableAskOf, pilotReportOf, runInlineArm, runInlineAsk, runTableOnlyArm, turnCountsOf,
} from "./sim-inline-ask-run.mjs";

/** One deterministic body of `count` lines, comfortably above the floor. */
function bodyOf(count = 20) {
  return Array.from({ length: count },
    (_, at) => `Result row ${String(at + 1)} carries alpha beta gamma delta epsilon zeta eta `
      + `theta iota kappa lambda mu nu xi omicron pi rho sigma tau token-${String(at + 1)}`)
    .join("\n");
}

/** One surface message carrying a result and (optionally) its block. */
function surfaceOf(originalText, index = 1, seq = index * 2) {
  const pinned = appendInlineBlockOf({ role: "user", seq, text: originalText }, index);
  return { message: pinned.message, block: pinned.block, registryEntry: pinned.registryEntry };
}

/** One rebuild decision: the parsed record plus the assistant message it came from. */
function decisionOf(parsed, index, resultSeq, assistantSeq) {
  return {
    index, seq: resultSeq, ...parsed,
    answer: parsed.span === null ? null : {
      seq: assistantSeq,
      start: parsed.span.start, end: parsed.span.end,
      text: parsed.text, spans: parsed.spans,
    },
  };
}

/** One tagged answer line for one index. */
function answerLine(index, object) {
  return `${answerTagOf(index)}${JSON.stringify({ [String(index)]: object })}`;
}

/** No block marker and no tagged answer object is left anywhere. */
function assertCleanSurface(messages) {
  for (const message of messages) {
    assert.ok(!message.text.includes(INLINE_MARKER),
      `seq ${String(message.seq)} carries no block marker`);
    assert.ok(!/^\[\[inline-answer:[1-9][0-9]*\]\]/mu.test(message.text),
      `seq ${String(message.seq)} carries no tagged answer object`);
  }
}

/** Deterministic 7-line fixture for the exact block bytes. */
const PINNED_TEXT = Array.from({ length: 7 },
  (_, at) => `result line ${String(at + 1)} carries alpha beta gamma delta epsilon zeta eta `
    + `theta iota kappa lambda token-${String(at + 1)}`).join("\n");

/** The exact appended block for `PINNED_TEXT`, index 4. */
const PINNED_BLOCK = [
  "",
  "[[racoons-inline-ask]]",
  '4. [tool result] — line 1 ends with "eta theta iota kappa lambda token-1"'
    + ' · line 2 ends with "eta theta iota kappa lambda token-2" [7 lines]',
  "Answer now for result 4: write one line that starts with [[inline-answer:4]] and carries"
    + ' exactly one JSON object keyed by 4, then continue the task. The shape:'
    + ' [[inline-answer:example]]{"example":{"forgetall":true,"summary":"stale build log"}} or'
    + ' {"example":{"keeplines":[[1,2]],"summary":"the config keys"}}; the summary is one line,'
    + ' under 20 words, never "..."; a keeplines over [1,7] keeps the whole result.',
  "Prune aggressively: drop anything the immediate task does not need; it can be restored anyway."
    + " For this result, keep at most 40 percent of this result's lines, and keep some parts whole"
    + " and forget others whole if that meets it.",
  "[[racoons-inline-ask]]",
].join("\n");

test("the block's exact bytes", () => {
  assert.equal(inlineBlockOf({ text: PINNED_TEXT }, 4, { lineCount: 7 }), PINNED_BLOCK);
  const surface = PINNED_TEXT + PINNED_BLOCK;
  assert.ok(surface.endsWith(PINNED_BLOCK), "the block is the appended suffix");
  assert.equal(surface.slice(0, -PINNED_BLOCK.length), PINNED_TEXT,
    "cutting the block restores the original bytes exactly");
});

test("a block is appended only to an eligible result, and its two quotes are the result's",
  () => {
    const text = bodyOf(20);
    assert.ok(Buffer.byteLength(text, "utf8") >= INLINE_FLOOR_BYTES, "the fixture is eligible");
    const block = inlineBlockOf({ text }, 7, { lineCount: 20 });

    assert.ok(block.startsWith(`\n${INLINE_MARKER}\n`), "the block owns its separator line");
    assert.ok(block.endsWith(`\n${INLINE_MARKER}`), "the same marker closes it");
    assert.equal(block.split(INLINE_MARKER).length - 1, 2, "exactly one marker pair");
    assert.ok(block.includes("7. [tool result]"), "the mini row names the index");
    assert.ok(block.includes("[20 lines]"), "the mini row states the line count");
    assert.ok(!block.includes("(call #"), "no call ordinal is invented");
    assert.ok(inlineBlockOf({ text }, 7, { lineCount: 20, callOrdinal: 3 }).includes("(call #3)"),
      "a known call ordinal is shown");
    assert.ok(block.includes("keep at most 40 percent of this result's lines"),
      "the share line is written for one result");
    assert.ok(!block.includes("total lines"), "no aggregate share line");
    assert.ok(!block.includes("70 percent"), "the later-fire variant only");
    assert.ok(block.includes("[[inline-answer:7]]"), "the tag names this result");
    assert.ok(block.includes(answerTagOf("example")), "the example uses the literal tag");
    assert.ok(block.includes('{"example":{"forgetall"'), "and the literal key");
    assert.ok(!block.includes('{"7":{"forgetall"'), "no numeric-index example to echo");

    const quotes = [...block.matchAll(/line (\d+) ends with "([^"]*)"/gu)];
    assert.equal(quotes.length, ENTRY_ASK_MIN_QUOTE_LINES, "two quote lines");
    const lines = linesOf(text);
    for (const [, number, quote] of quotes) {
      assert.ok(lines[Number(number) - 1].includes(quote),
        `line ${number}'s quote comes from that line of the result`);
    }

    // A sub-floor result is untouched, by the helper and by the lane.
    const tiny = "a tiny result";
    const tinyReading = inlineEligibilityOf({ text: tiny });
    assert.equal(tinyReading.eligible, false);
    assert.equal(tinyReading.reason, "below-floor");
    const untouched = appendInlineBlockOf({ role: "user", seq: 1, text: tiny }, 1);
    assert.equal(untouched.block, null);
    assert.equal(untouched.registryEntry, null);
    assert.equal(untouched.text, tiny);
    assert.equal(inlineBlockOf({ text: tiny }, 1, { lineCount: 1 }), null);

    // An error result is not eligible, whatever its size: the check is inside.
    assert.equal(inlineEligibilityOf({ text, isError: true }).reason, "error-result");
    assert.equal(inlineBlockOf({ text, isError: true }, 1), null);
    assert.equal(inlineBlockOf({ text }, 1, { isError: true }), null);
    // A result that already carries the marker is never ours to mark again.
    assert.equal(inlineEligibilityOf({ text: `${text}\n${INLINE_MARKER}` }).reason,
      "marker-present");
    // One long line cannot show two quote lines.
    assert.equal(inlineEligibilityOf({ text: "x".repeat(INLINE_FLOOR_BYTES) }).reason,
      "no-two-quotes");
    // A count that is not the result's own is a caller bug, named by the reading.
    assert.equal(inlineEligibilityOf({ text, lineCount: 19 }).reason, "line-count-mismatch");
    // A bad index or a text-less result is a caller bug, not a refusal.
    assert.throws(() => inlineBlockOf({ text }, 0), /positive result index/u);
    assert.throws(() => inlineBlockOf({}, 1), /carrying `text`/u);
  });

test("forgetall and keeplines parse; keepall and malformed lines are refused by name", () => {
  const forget = parseInlineAnswer(
    `Working.\n${answerLine(3, { forgetall: true, summary: "stale build log" })}\nContinuing.`,
    { index: 3, lineCount: 20 });
  assert.equal(forget.status, "answered");
  assert.equal(forget.action, "forgetall");
  assert.equal(forget.summary, "stale build log");
  assert.equal(forget.text, '{"3":{"forgetall":true,"summary":"stale build log"}}',
    "the exact object rides back for removal");
  assert.equal(forget.keepAll, false);
  assert.equal(forget.lineCount, 20, "the stated count rides back");
  assert.equal(forget.spans.length, 1, "one candidate artifact");

  const keep = parseInlineAnswer(
    answerLine(3, { keeplines: [[1, 3], [7, 9]], summary: "the config keys" }),
    { index: 3, lineCount: 20 });
  assert.equal(keep.status, "answered");
  assert.equal(keep.action, "keeplines");
  assert.deepEqual(keep.ranges, [{ from: 1, to: 3 }, { from: 7, to: 9 }]);
  assert.equal(keep.keepAll, false);

  const whole = parseInlineAnswer(
    answerLine(3, { keeplines: [[1, 20]], summary: "all kept" }), { index: 3, lineCount: 20 });
  assert.equal(whole.status, "answered");
  assert.equal(whole.keepAll, true, "a full-range keeplines is an accepted keep-all");

  const keepall = parseInlineAnswer(
    answerLine(3, { keepall: true }), { index: 3, lineCount: 20 });
  assert.equal(keepall.status, "refused");
  assert.equal(keepall.code, GRAMMAR_GATE_CODE, "keepall is the named grammar refusal");
  assert.ok(keepall.message.includes("keeps"), "the refusal says the result keeps");

  const malformed = [
    [answerLine(3, { forgetall: "yes", summary: "x" }), "malformed-row"],
    [answerLine(3, { keeplines: [[5, 2]], summary: "x" }), "bad-range"],
    [answerLine(3, { keeplines: [[21, 22]], summary: "x" }), "spans-outside-result"],
    [answerLine(3, { keeplines: [[1, 2]] }), "summary-missing"],
    [answerLine(3, { forgetall: true, keeplines: [[1, 2]], summary: "x" }), "mixed-keys"],
    [`${answerTagOf(3)}`, "answer-unreadable"],
    [`${answerTagOf(3)}not json`, "answer-unreadable"],
    ["I will answer later.", "answer-unreadable"],
    [JSON.stringify({ 3: { forgetall: true, summary: "x" } }), "untagged-answer"],
    [answerLine(4, { forgetall: true, summary: "x" }), "missing-index"],
    [`${answerLine(3, { forgetall: true, summary: "a" })}\n`
      + answerLine(3, { forgetall: true, summary: "b" }), "duplicate-index"],
    [`${answerTagOf(3)}{"4":{"forgetall":true,"summary":"x"}}`, "wrong-index"],
    [answerLine(3, { forgetall: true, summary: "..." }), "placeholder-summary"],
    [`[${answerLine(3, { forgetall: true, summary: "x" })}]`, "untagged-answer"],
  ];
  for (const [text, code] of malformed) {
    const refused = parseInlineAnswer(text, { index: 3, lineCount: 20 });
    assert.equal(refused.status, "refused", `${code}: not answered`);
    assert.equal(refused.code, code, `${code}: named`);
    assert.equal(refused.action ?? null, null, `${code}: applies nothing`);
    assert.equal(typeof refused.message, "string", `${code}: carries a sentence`);
  }

  // Without a stated index the single tag's index is the index; without a line
  // count a keeplines bound is accepted here and checked at the rebuild.
  const inferred = parseInlineAnswer(answerLine(8, { forgetall: true, summary: "x" }));
  assert.equal(inferred.index, 8);
  const deferred = parseInlineAnswer(answerLine(8, { keeplines: [[1, 900]], summary: "x" }));
  assert.equal(deferred.status, "answered");
  assert.equal(deferred.lineCount, null);
});

test("the rebuild restores the original result and assistant bytes and removes every artifact",
  () => {
    for (const original of [`${bodyOf(20)}\n`, bodyOf(20)]) {
      const surface = surfaceOf(original, 5, 10);
      const answerText = "Prose before.\n"
        + `${answerLine(5, { keeplines: [[2, 3]], summary: "two rows" })}\nProse after.`;
      const messages = [
        { role: "system", seq: 0, text: "system" },
        surface.message,
        { role: "assistant", seq: 11, text: answerText },
      ];
      const parsed = parseInlineAnswer(answerText, { index: 5, lineCount: 20 });
      const decision = decisionOf(parsed, 5, 10, 11);
      const before = JSON.parse(JSON.stringify(messages));
      const rebuilt = rebuildSurface(messages, [decision], [surface.registryEntry]);
      assert.equal(rebuilt.restoredMessages[1].text, original,
        "the result's original bytes are restored exactly");
      assert.equal(rebuilt.restoredMessages[2].text, "Prose before.\nProse after.",
        "the assistant's own prose is restored exactly");
      assertCleanSurface(rebuilt.messages);
      assert.equal(rebuilt.blocksRemoved, 1);
      assert.equal(rebuilt.answersRemoved, 1);
      assert.equal(rebuilt.answersRemaining, 0);
      assert.deepEqual(messages, before, "the input is never mutated");
    }

    // The registry is optional: with no registry entry the block stays, and
    // NOTHING scans for the marker. With the entry and no decision, the block is
    // stripped and the result is the original bytes again.
    const original = bodyOf(20);
    const surface = surfaceOf(original, 3, 6);
    const kept = rebuildSurface([surface.message], [], []);
    assert.equal(kept.restoredMessages[0].text, original + surface.block);
    assert.equal(kept.blocksRemoved, 0);
    assert.equal(kept.blocksRemaining, 0);
    const stripped = rebuildSurface([surface.message], [], [surface.registryEntry]);
    assert.equal(stripped.restoredMessages[0].text, original);
    assert.equal(stripped.blocksRemoved, 1);
    assert.equal(stripped.answersRemoved, 0);

    // A block with no decision is still stripped; a refusal keeps its result.
    const refusedText = "Done.\n" + answerLine(3, { keepall: true });
    const refused = parseInlineAnswer(refusedText, { index: 3, lineCount: 20 });
    const rebuilt = rebuildSurface([
      surface.message,
      { role: "assistant", seq: 7, text: refusedText },
    ], [decisionOf(refused, 3, 6, 7)], [surface.registryEntry]);
    assert.equal(rebuilt.restoredMessages[0].text, original);
    assert.equal(rebuilt.messages[0].text, original, "a refused answer keeps the result");
    assert.equal(rebuilt.restoredMessages[1].text, "Done.");
    assert.equal(rebuilt.plan.refusals.length, 1);
    assert.equal(rebuilt.plan.refusals[0].carried, true, "the parse refusal is carried, not new");
  });

test("a whole-result forget and a keeplines complement name the right removed spans", () => {
  const original = bodyOf(20);
  const originalBytes = Buffer.from(original, "utf8");
  const forgetSurface = surfaceOf(original, 1, 2);
  const forgetAnswer = answerLine(1, { forgetall: true, summary: "the whole stale log" });
  const forgetText = `Done.\n${forgetAnswer}`;
  const forgetParsed = parseInlineAnswer(forgetText, { index: 1, lineCount: 20 });
  const forgot = rebuildSurface([
    { role: "user", seq: 2, text: original + forgetSurface.block },
    { role: "assistant", seq: 3, text: forgetText },
  ], [decisionOf(forgetParsed, 1, 2, 3)], [forgetSurface.registryEntry]);
  const forgetPlan = forgot.plan.forgets[0];
  assert.equal(forgot.plan.forgets.length, 1);
  assert.equal(forgetPlan.status, "applied");
  assert.equal(forgetPlan.bytesRemoved, originalBytes.length,
    "a whole-result forget removes every original byte");
  assert.deepEqual(forgetPlan.removedByteSpans,
    [{ startByte: 0, endByteExclusive: originalBytes.length }]);
  assert.deepEqual(forgetPlan.removedLineSpans, [{ from: 1, to: 20 }]);
  assert.equal(forgetPlan.keptLines.length, 0);
  assert.ok(forgetPlan.recallId.startsWith("recall:sha256:"), "a recall id is minted");
  assert.deepEqual(Buffer.from(forgetPlan.originalBytes), originalBytes,
    "the original bytes are kept for recall");
  assert.ok(forgetPlan.shapedText.includes("[racoons] kept 0 of 20 lines"),
    "the shaped turn carries the product's own marker");
  assert.deepEqual(forgot.plan.recall.map(entry => entry.recallId), [forgetPlan.recallId]);
  assert.equal(forgot.receipts.length, 1);
  assert.equal(forgot.receipts[0].recallId, forgetPlan.recallId);
  assert.equal(forgot.applied[0].action, "forgetall");

  // The complement: keep 2-3 and 5, remove 1, 4, and 6-20.
  const keepSurface = surfaceOf(original, 2, 6);
  const keepAnswer = answerLine(2, { keeplines: [[2, 3], [5, 5]], summary: "the config rows" });
  const keepText = `Done.\n${keepAnswer}`;
  const keepParsed = parseInlineAnswer(keepText, { index: 2, lineCount: 20 });
  const kept = rebuildSurface([
    { role: "user", seq: 6, text: original + keepSurface.block },
    { role: "assistant", seq: 7, text: keepText },
  ], [decisionOf(keepParsed, 2, 6, 7)], [keepSurface.registryEntry]);
  const keepPlan = kept.plan.keeplines[0];
  const expectedBytes = complementByteRanges(originalBytes.length,
    byteRangeForLines(originalBytes, [
      { startLine: 2, endLineInclusive: 3 }, { startLine: 5, endLineInclusive: 5 },
    ]));
  assert.deepEqual(keepPlan.removedByteSpans, expectedBytes,
    "the removed bytes are the byte complement of the kept lines");
  assert.deepEqual(keepPlan.removedLineSpans, [{ from: 1, to: 1 }, { from: 4, to: 4 },
    { from: 6, to: 20 }]);
  assert.equal(keepPlan.bytesRemoved,
    expectedBytes.reduce((sum, span) => sum + span.endByteExclusive - span.startByte, 0));
  assert.deepEqual(keepPlan.keptLines, [{ startLine: 2, endLineInclusive: 3 },
    { startLine: 5, endLineInclusive: 5 }]);
  const shaped = kept.messages[0].text;
  assert.ok(shaped.includes(linesOf(original)[1]), "kept line 2 stays");
  assert.ok(shaped.includes(linesOf(original)[4]), "kept line 5 stays");
  assert.ok(!shaped.includes(linesOf(original)[3]), "dropped line 4 is gone");
  assert.ok(shaped.includes("necromancy"), "the receipt names the recall id");

  // A full-range keeplines applies nothing and mints no recall id.
  const allText = "Done.\n" + answerLine(3, { keeplines: [[1, 20]], summary: "all kept" });
  const allParsed = parseInlineAnswer(allText, { index: 3, lineCount: 20 });
  const all = rebuildSurface([
    { role: "user", seq: 9, text: original + surfaceOf(original, 3, 9).block },
    { role: "assistant", seq: 10, text: allText },
  ], [decisionOf(allParsed, 3, 9, 10)], [surfaceOf(original, 3, 9).registryEntry]);
  assert.equal(all.plan.keeplines.length, 0, "no partial removal");
  assert.equal(all.plan.keeps.length, 1, "counted as a keep-all");
  assert.equal(all.plan.keeps[0].bytesRemoved, 0);
  assert.equal(all.messages[0].text, original, "the result is untouched");
});

test("no extra turn is created per result", () => {
  const run = runInlineAsk({ resultCount: 30, rebuildTokens: 1_000_000 });
  assert.equal(run.turns.inline.total, run.turns.baseline.total,
    "the inline pass has the same turn count as the baseline");
  assert.equal(run.turns.extraTurns, 0);
  assert.equal(run.turns.inline.user, run.turns.baseline.user);
  assert.equal(run.turns.inline.assistant, run.turns.baseline.assistant);
  assert.equal(run.messages.length, run.baselineMessages.length);
  assert.equal(run.turns.inline.assistant, 30, "one assistant turn per result, no more");
  assert.equal(run.turns.rebuildTurns, 0, "no rebuild ran, so no rebuild turn");
  assert.equal(run.blocks.length, 24, "30 results, six below the floor");
  assert.ok(run.decisions.length > 0, "the answered results carry a verdict");
  assert.ok(run.decisions.length <= run.blocks.length,
    "only a blocked result can carry an answer");
  assert.ok(run.decisions.every(decision =>
    run.blocks.some(block => block.seq === decision.seq)),
    "every decision addresses a blocked result's seq");
  assert.ok(run.untouched.every(entry => entry.reason === "below-floor"),
    "the untouched results are the sub-floor ones and nothing else");
  assert.equal(turnCountsOf(run.messages).total, turnCountsOf(run.baselineMessages).total);
});

test("the 200k rebuild selects the 40 percent prompt", () => {
  assert.equal(INLINE_REBUILD_TOKENS, 200_000, "the rebuild depth is 200,000 tokens");
  const lines = linesOf(bodyOf(10));
  const rows = [
    { index: 1, call: "tool result", lineCount: lines.length, anchorLines: lines },
    { index: 2, call: "tool result", lineCount: lines.length, anchorLines: lines },
  ];
  const prompt = bigTableAskOf(rows);
  assert.ok(prompt.includes("keep at most 40 percent"), "the 40 percent share line is in the prompt");
  assert.ok(!prompt.includes("keep at most 70 percent"), "the first-fire line is absent");
  assert.ok(!prompt.includes(JSONL_20_FIRST_TARGET), "the first-fire variant is absent");

  // The harness fires its one rebuild at the configured depth, with the block
  // registry in hand; the module-level rebuild proof is the fixtures above and
  // below.
  const run = runInlineAsk();
  assert.ok(run.rebuild !== null, "the default surface crosses the rebuild depth");
  assert.ok(run.depthBefore >= INLINE_REBUILD_TOKENS,
    `the rebuild fires at ${String(run.depthBefore)} tokens`);
  assert.equal(run.rebuild.blocksRemoved + run.rebuild.blocksRemaining,
    run.rebuild.blocksAppended, "the harness's registry is balanced");
  assert.equal(run.report.depthBefore, run.depthBefore);
  assert.equal(run.turns.rebuildTurns, 1, "the one rebuild turn runs");
  assert.ok(run.rebuild.stats.messages > 0, "the rebuild saw the surface");
});

test("the report names the token budget and that no timer or ask ceiling was armed", () => {
  const original = bodyOf(20);
  const block = surfaceOf(original, 1).block;
  const answerText = answerLine(1, { forgetall: true, summary: "stale log" });
  const parsed = parseInlineAnswer(answerText, { index: 1, lineCount: 20 });
  const decision = decisionOf(parsed, 1, 2, 3);
  const report = inlineAskReport({
    blocks: [block], decisions: [decision], depthBefore: 1_000, depthAfter: 500,
  });
  assert.equal(report.blocksAppended, 1);
  assert.equal(report.bytesAddedByBlocks, Buffer.byteLength(block, "utf8"));
  assert.equal(report.bytesAddedByAnswers, Buffer.byteLength(parsed.text, "utf8"));
  assert.equal(report.answersParsed, 1);
  assert.equal(report.refusals, 0);
  assert.equal(report.decisionsByAction.forgetall, 1);
  assert.equal(report.tokenBudget, SIM_TOKEN_BUDGET);
  assert.equal(report.tokenBudget, 10_000_000, "a sim run's budget is 10,000,000 tokens");
  assert.equal(report.timerMs, 0);
  assert.equal(report.askCeiling, 0);
  assert.equal(report.caps.onlyCap, "token budget");
  assert.equal(report.caps.timer, "none");
  assert.equal(report.caps.ceiling, "none");
  assert.ok(report.caps.note.includes("only cap"), "the note says the budget is the only cap");
  assert.equal(report.depthBefore, 1_000);
  assert.equal(report.depthAfter, 500);
  assert.equal(report.depthDelta, -500);

  const run = runInlineAsk({ resultCount: 12 });
  assert.equal(run.report.tokenBudget, SIM_TOKEN_BUDGET);
  assert.equal(run.report.timerMs, 0);
  assert.equal(run.report.askCeiling, 0);
  assert.equal(run.settings.floor, INLINE_FLOOR_BYTES);
});

test("finding 1: an original result that carries the marker is never truncated", () => {
  // The audit's repro: marker text in an original message must survive rebuild.
  const marked = `prefix\n${INLINE_MARKER}\nline2\n${INLINE_MARKER}`;
  const rebuilt = rebuildSurface([{ role: "user", seq: 2, text: marked }], []);
  assert.equal(rebuilt.messages[0].text, marked, "the original bytes are untouched");
  assert.equal(rebuilt.restoredMessages[0].text, marked);
  assert.equal(rebuilt.blocksRemoved, 0);
  assert.equal(rebuilt.blocksRemaining, 0);
  assert.equal(rebuilt.blocksAppended, 0);

  // A marker at the END of an otherwise eligible result: never asked, never cut.
  const eligible = bodyOf(20);
  const tail = `${eligible}\n${INLINE_MARKER}`;
  assert.equal(inlineEligibilityOf({ text: tail }).reason, "marker-present");
  assert.equal(inlineBlockOf({ text: tail }, 1), null);
  assert.equal(appendInlineBlockOf({ role: "user", seq: 4, text: tail }, 1).block, null);
  const kept = rebuildSurface([{ role: "user", seq: 4, text: tail }], []);
  assert.equal(kept.messages[0].text, tail);
  assert.equal(kept.blocksRemoved, 0);

  // A registered block that is not the exact suffix is left in place, not cut.
  const block = inlineBlockOf({ text: eligible }, 1, { lineCount: 20 });
  const foreign = rebuildSurface([{ role: "user", seq: 6, text: eligible }], [],
    [{ seq: 6, block }]);
  assert.equal(foreign.messages[0].text, eligible);
  assert.equal(foreign.blocksRemoved, 0);
  assert.equal(foreign.blocksRemaining, 1);
  // One trailing newline on the surface is tolerated.
  const trailing = rebuildSurface([{ role: "user", seq: 6, text: eligible + block + "\n" }], [],
    [{ seq: 6, block }]);
  assert.equal(trailing.messages[0].text, eligible);
  assert.equal(trailing.blocksRemoved, 1);
});

test("finding 2: an echoed example is not an answer", () => {
  const block = inlineBlockOf({ text: bodyOf(20) }, 4, { lineCount: 20 });
  const echoLine = block.split("\n").find(line => line.includes(answerTagOf("example")));
  assert.ok(echoLine !== undefined, "the block teaches an example");
  const echoed = parseInlineAnswer(`Continuing.\n${echoLine}`, { index: 4, lineCount: 20 });
  assert.equal(echoed.status, "refused", "the prompt line is not an answer");
  assert.equal(echoed.action ?? null, null);
  assert.notEqual(echoed.action, "forgetall");

  // Even the example's own tag and key are inert: not an answer, not an artifact.
  const only = `${answerTagOf("example")}{"example":{"forgetall":true,"summary":"stale"}}`;
  const bare = parseInlineAnswer(only, { index: 4, lineCount: 20 });
  assert.equal(bare.status, "refused");
  assert.equal(bare.spans.length, 0, "the literal example tag is never an artifact");

  // The echo does not poison a real answer on the next line.
  const real = answerLine(4, { forgetall: true, summary: "a real answer" });
  const mixed = parseInlineAnswer(`${echoLine}\n${real}`, { index: 4, lineCount: 20 });
  assert.equal(mixed.status, "answered");
  assert.equal(mixed.action, "forgetall");
  assert.equal(mixed.summary, "a real answer");
});

test("finding 9: every tagged artifact is removed and a full-range keep is a keep", () => {
  const original = bodyOf(20);
  const surface = surfaceOf(original, 4, 2);
  const wrong = `${answerTagOf(4)}{"5":{"forgetall":true,"summary":"wrong"}}`;
  const right = answerLine(4, { forgetall: true, summary: "right" });
  const text = `Prose.\n${wrong}\n${right}\nAfter.`;
  const parsed = parseInlineAnswer(text, { index: 4, lineCount: 20 });
  assert.equal(parsed.status, "answered", "the valid tagged object answers");
  assert.equal(parsed.spans.length, 2, "both candidate artifacts ride back");
  const rebuilt = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text },
  ], [decisionOf(parsed, 4, 2, 3)], [surface.registryEntry]);
  assert.equal(rebuilt.restoredMessages[1].text, "Prose.\nAfter.",
    "no JSON is left in the surface");
  assert.equal(rebuilt.answersRemoved, 2);
  assert.equal(rebuilt.answersRemaining, 0);

  // A duplicate pair refuses the answer and still removes every artifact.
  const duplicated = `Prose.\n${right}\n${right}\nAfter.`;
  const duplicate = parseInlineAnswer(duplicated, { index: 4, lineCount: 20 });
  assert.equal(duplicate.code, "duplicate-index");
  assert.equal(duplicate.spans.length, 2);
  const deduped = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text: duplicated },
  ], [decisionOf(duplicate, 4, 2, 3)], [surface.registryEntry]);
  assert.equal(deduped.restoredMessages[1].text, "Prose.\nAfter.");
  assert.equal(deduped.messages[0].text, original, "a refused duplicate keeps its result");
  assert.equal(deduped.answersRemaining, 0);

  // A full-range keeplines with NO stated count is a keep at the rebuild, and
  // it stays the keeplines action (it is not rewritten to keepall).
  const keepText = answerLine(4, { keeplines: [[1, 20]], summary: "all kept" });
  const keepParsed = parseInlineAnswer(keepText, { index: 4 });
  assert.equal(keepParsed.status, "answered");
  assert.equal(keepParsed.lineCount, null, "no count was stated");
  assert.equal(keepParsed.keepAll, false, "so the parse cannot claim it");
  const kept = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text: keepText },
  ], [decisionOf(keepParsed, 4, 2, 3)], [surface.registryEntry]);
  assert.equal(kept.plan.keeplines.length, 0);
  assert.equal(kept.plan.keeps.length, 1);
  assert.equal(kept.plan.keeps[0].keepAll, true, "the real line count decides");
  assert.equal(kept.plan.keeps[0].action, "keeplines", "a keep, not a keepall action");
  assert.equal(kept.messages[0].text, original, "the result is untouched");

  // An artifact with no decision is counted, never guessed at.
  const leftover = rebuildSurface([
    { role: "user", seq: 2, text: original },
    { role: "assistant", seq: 3, text: `Prose.\n${right}` },
  ], []);
  assert.equal(leftover.answersRemoved, 0);
  assert.equal(leftover.answersRemaining, 1);
});

test("finding 10: a duplicate decision is refused by name and the rebuild is idempotent", () => {
  const original = bodyOf(20);
  const surface = surfaceOf(original, 2, 4);
  const text = `Continuing.\n${answerLine(2, { forgetall: true, summary: "stale" })}\nmore`;
  const parsed = parseInlineAnswer(text, { index: 2, lineCount: 20 });
  const decision = decisionOf(parsed, 2, 4, 5);
  const messages = [
    { role: "user", seq: 4, text: surface.message.text },
    { role: "assistant", seq: 5, text },
  ];
  const once = rebuildSurface(messages, [decision, decision], [surface.registryEntry]);
  assert.ok(once.refusals.some(refusal => refusal.code === "duplicate-decision"),
    "the second decision is refused by name");
  assert.equal(once.answersRemoved, 1, "the artifact is removed once");
  assert.equal(once.plan.forgets.length, 1, "the removal is applied once");
  assert.equal(once.restoredMessages[1].text, "Continuing.\nmore");

  // A second rebuild over its own output changes nothing and never throws.
  const again = rebuildSurface(once.messages, [decision], [surface.registryEntry]);
  assert.deepEqual(again.messages.map(message => message.text),
    once.messages.map(message => message.text), "the surface is unchanged");
  assert.equal(again.blocksRemoved, 0);
  assert.equal(again.blocksRemaining, 1, "the block is already gone");
  assert.equal(again.answersRemoved, 0);
  assert.equal(again.answersRemaining, 0);
  assert.ok(again.refusals.some(refusal => refusal.code === "already-shaped"),
    "the applied removal is not applied twice");
});

test("finding 11: the answer artifact takes one separator and the prose stays", () => {
  const original = bodyOf(20);
  const surface = surfaceOf(original, 1, 2);
  const answer = answerLine(1, { forgetall: true, summary: "stale" });
  const prose = `Prose before.\n${answer}\nProse after.`;
  const parsed = parseInlineAnswer(prose, { index: 1, lineCount: 20 });
  const rebuilt = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text: prose },
  ], [decisionOf(parsed, 1, 2, 3)], [surface.registryEntry]);
  assert.equal(rebuilt.restoredMessages[1].text, "Prose before.\nProse after.",
    "the remaining text is exactly the prose");

  // The audit's whitespace repro: blank lines around the answer never triple.
  const spaced = `Continuing.\n\n${answer}\n\nmore`;
  const spacedParsed = parseInlineAnswer(spaced, { index: 1, lineCount: 20 });
  const spacedRebuilt = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text: spaced },
  ], [decisionOf(spacedParsed, 1, 2, 3)], [surface.registryEntry]);
  assert.equal(spacedRebuilt.restoredMessages[1].text, "Continuing.\n\nmore");
  assert.ok(!spacedRebuilt.restoredMessages[1].text.includes("\n\n\n"),
    "no triple newline is left");
});

test("finding 13: a quote never copies a share line or an instruction", () => {
  const dirty = [
    `line 1 keep at most 70 percent of the total lines ${"pad ".repeat(10)}`,
    `line 2 forget everything about the old host ${"pad ".repeat(10)}`,
    ...Array.from({ length: 10 },
      (_, at) => `clean line ${String(at + 3)} carries alpha beta gamma delta epsilon zeta `
        + `eta theta iota kappa lambda ${"pad ".repeat(8)}`),
  ];
  const text = dirty.join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") >= INLINE_FLOOR_BYTES, "the fixture is eligible");
  const block = inlineBlockOf({ text }, 1, { lineCount: dirty.length });
  assert.ok(block !== null, "clean lines still earn a block");
  assert.ok(!block.includes("70 percent"), "the share phrase is not copied");
  assert.ok(!block.includes("total lines"), "no aggregate share phrase is copied");
  assert.ok(!block.toLowerCase().includes("forget everything"), "no instruction is copied");
  const quotes = [...block.matchAll(/line (\d+) ends with /gu)];
  assert.equal(quotes.length, ENTRY_ASK_MIN_QUOTE_LINES);
  for (const [, number] of quotes) {
    assert.ok(Number(number) > 2, `line ${number} is a clean line`);
  }

  // No clean line exists: the quote is omitted, never copied.
  const allDirty = Array.from({ length: 20 },
    (_, at) => `line ${String(at + 1)} forget everything ${"pad ".repeat(12)}`).join("\n");
  assert.ok(Buffer.byteLength(allDirty, "utf8") >= INLINE_FLOOR_BYTES);
  assert.equal(inlineEligibilityOf({ text: allDirty }).reason, "no-two-quotes");
  assert.equal(inlineBlockOf({ text: allDirty }, 1, { lineCount: 20 }), null);
  assert.equal(appendInlineBlockOf({ role: "user", seq: 2, text: allDirty }, 1).block, null);
});

test("finding 15: result-absent names its own refusal and recall restores the bytes", () => {
  const absent = rebuildSurface([{ role: "assistant", seq: 3, text: "plain" }], [{
    index: 9, seq: 99, status: "answered", action: "forgetall", summary: "x",
  }], []);
  const refusal = absent.plan.refusals.find(entry => entry.code === "result-absent");
  assert.ok(refusal !== undefined, "the code is result-absent");
  assert.ok(refusal.message.includes("not in the surface"), "its own sentence");
  assert.ok(!refusal.message.includes("JSON object"), "not the answer-unreadable sentence");

  const original = bodyOf(20);
  const originalBytes = Buffer.from(original, "utf8");
  const surface = surfaceOf(original, 1, 2);
  const text = answerLine(1, { forgetall: true, summary: "stale" });
  const parsed = parseInlineAnswer(text, { index: 1, lineCount: 20 });
  const rebuilt = rebuildSurface([
    { role: "user", seq: 2, text: surface.message.text },
    { role: "assistant", seq: 3, text },
  ], [decisionOf(parsed, 1, 2, 3)], [surface.registryEntry]);
  assert.equal(rebuilt.recall.length, 1, "the recall entry rides the return");
  assert.equal(rebuilt.recall[0].recallId, rebuilt.plan.recall[0].recallId);
  const restored = restoreFromRecall(rebuilt.recall[0]);
  assert.deepEqual(Buffer.from(restored), originalBytes, "the exact original bytes return");
  restored[0] = 0x21;
  assert.notEqual(Buffer.from(rebuilt.recall[0].originalBytes)[0], 0x21,
    "the recall entry is not exposed to the caller's writes");
  assert.throws(() => restoreFromRecall({ ...rebuilt.recall[0], sha256: "0".repeat(64) }),
    /sim-inline-recall-hash-mismatch/u);
  assert.throws(() => restoreFromRecall({ recallId: "recall:none" }),
    /sim-inline-recall-unreadable/u);
});

test("finding 17: the block and answer ledgers balance and the final surface is clean", () => {
  const messages = [{ role: "system", seq: 0, text: "system" }];
  const registry = [];
  const decisions = [];
  for (const [index, answer] of [
    [1, { forgetall: true, summary: "stale one" }],
    [2, { keeplines: [[2, 4]], summary: "the config rows" }],
    [3, null],
  ]) {
    const seq = index * 2;
    const assistantSeq = seq + 1;
    const pinned = appendInlineBlockOf({ role: "user", seq, text: bodyOf(20) }, index);
    messages.push(pinned.message);
    if (pinned.registryEntry !== null) registry.push(pinned.registryEntry);
    if (answer === null) {
      messages.push({ role: "assistant", seq: assistantSeq, text: `Continuing ${String(index)}.` });
      continue;
    }
    const text = `Continuing ${String(index)}.\n${answerLine(index, answer)}\nDone.`;
    messages.push({ role: "assistant", seq: assistantSeq, text });
    const parsed = parseInlineAnswer(text, { index, lineCount: 20 });
    decisions.push(decisionOf(parsed, index, seq, assistantSeq));
  }
  const rebuilt = rebuildSurface(messages, decisions, registry);
  assert.equal(rebuilt.blocksAppended, registry.length);
  assert.equal(rebuilt.blocksRemoved + rebuilt.blocksRemaining, rebuilt.blocksAppended,
    "every appended block is either removed or counted as remaining");
  assert.equal(rebuilt.blocksRemoved, 3);
  assert.equal(rebuilt.blocksRemaining, 0);
  assert.equal(rebuilt.answersRemaining, 0, "no answer artifact is left");
  assertCleanSurface(rebuilt.messages);
  assert.equal(rebuilt.bytesRemovedGross, rebuilt.bytesRemovedByBlocks
    + rebuilt.bytesRemovedByAnswers + rebuilt.bytesRemovedByResults);
  assert.equal(rebuilt.netBytesRemoved, rebuilt.bytesRemovedGross - rebuilt.bytesAddedByBlocks);
  assert.ok(rebuilt.netBytesRemoved > 0, "the rebuild pays for the blocks it added");
});

test("finding N4: a budget stop reports 0 per-result extra turns, never a negative count", () => {
  const inline = runInlineArm({ tokenBudget: 100_000 });
  const tableOnly = runTableOnlyArm({ tokenBudget: 100_000 });
  for (const run of [inline, tableOnly]) {
    assert.equal(run.turns.baseline.total, 145, "the full world baseline is stated");
    assert.equal(run.turns.surface.total, 17, "eight results landed before the stop");
    assert.equal(run.turns.baselineForRun, 17,
      "the baseline for this run counts only the messages it appended");
    assert.equal(run.turns.perResultExtraTurns, 0, "never negative");
    assert.equal(run.turns.totalExtraTurns, 0);
    assert.equal(run.report.turns.perResultExtraTurns, 0);
    assert.ok(run.estimatedTokensSpent < run.tokenBudget,
      "this stop happened below the grant");
    assert.equal(run.report.endedBy, "token-budget-projected",
      "a pre-call stop is named projected, not a post-call token-budget stop");
    assert.equal(run.report.budgetStopKind, "pre-call");
    assert.equal(run.report.budgetEnforced, "between-calls");
    assert.equal(run.report.budgetReached, false, "spend is below the grant");
    assert.equal(run.report.budgetExceeded, false);
    assert.equal(run.report.budgetOvershootTokens, 0);
    // The projection is deterministic in this stub world and is what would
    // have crossed the grant; the run's own spend did not.
    assert.equal(run.report.budgetProjectedNextCallTokens,
      run.arm === "inline" ? 27_345 : 25_315,
      "the next call's projected cost is stated");
    assert.ok(run.estimatedTokensSpent
      + run.report.budgetProjectedNextCallTokens >= run.tokenBudget,
      "the projection is what would have crossed the grant");
    assert.equal(run.report.budgetStopKind === "pre-call"
      && run.report.budgetReached === false, true,
      "a projected stop never claims the grant was reached");
    assert.ok(run.turns.note.includes("endedBy token-budget-projected"),
      "the note states the stop");
    assert.ok(!run.turns.note.includes("0 by construction"), "no construction claim");
    assert.ok(run.turns.note.includes("stub estimate"), "the tokens are named a stub");
    assert.ok(run.turns.note.includes("no provider"), "and no provider");
  }
});

test("finding N4: a spend that crosses the grant ends the run after the call", () => {
  const probe = runInlineArm({ tokenBudget: 100_000 });
  const run = runInlineArm({ tokenBudget: probe.estimatedTokensSpent - 1 });
  assert.ok(run.estimatedTokensSpent > run.tokenBudget, "the arm's own spend crossed the grant");
  assert.equal(run.report.budgetExceeded, true);
  assert.equal(run.report.budgetReached, true);
  assert.equal(run.report.budgetOvershootTokens, run.estimatedTokensSpent - run.tokenBudget);
  assert.equal(run.report.endedBy, "token-budget-after-call");
  assert.equal(run.report.budgetStopKind, "after-call");
  assert.equal(run.report.budgetProjectedNextCallTokens, null,
    "no pre-call projection: the spend had already crossed the grant");
  assert.equal(run.report.budgetEnforced, "between-calls");
  assert.equal(run.turns.perResultExtraTurns, 0);
  assert.equal(run.turns.totalExtraTurns, 0);
  assert.ok(run.turns.note.includes("endedBy token-budget-after-call"));
});

test("finding N4: the default run stays under its grant and ends by result count", () => {
  const run = runInlineArm();
  assert.ok(run.estimatedTokensSpent < run.tokenBudget);
  assert.equal(run.report.endedBy, "result-count");
  assert.equal(run.report.budgetStopKind, null, "no budget stop happened");
  assert.equal(run.report.budgetProjectedNextCallTokens, null);
  assert.equal(run.report.budgetEnforced, "between-calls");
  assert.equal(run.report.budgetReached, false);
  assert.equal(run.report.budgetExceeded, false);
  assert.equal(run.report.budgetOvershootTokens, 0);
  assert.equal(run.turns.perResultExtraTurns, 0);
  assert.equal(run.turns.totalExtraTurns, 1, "only the one rebuild turn");
  assert.ok(run.turns.note.includes("endedBy result-count"));
});

test("round 3: the projected stop and the after-call stop carry honest labels", () => {
  // Case 1: the stop is decided BEFORE a call because that call was projected
  // to cross the grant. The run's own spend stays under the grant, so the
  // record must not claim the grant was reached.
  const projectedRun = runInlineArm({ tokenBudget: 100_000 });
  assert.equal(projectedRun.report.endedBy, "token-budget-projected");
  assert.equal(projectedRun.report.budgetStopKind, "pre-call");
  assert.equal(projectedRun.report.budgetReached, false);
  assert.equal(projectedRun.report.budgetExceeded, false);
  assert.equal(projectedRun.report.budgetOvershootTokens, 0);
  assert.equal(projectedRun.report.budgetProjectedNextCallTokens, 27_345,
    "the next call's projected cost is the stated value");
  assert.ok(projectedRun.estimatedTokensSpent < projectedRun.tokenBudget,
    "the projected stop's own spend is under the grant");
  assert.ok(projectedRun.estimatedTokensSpent
    + projectedRun.report.budgetProjectedNextCallTokens >= projectedRun.tokenBudget,
    "the projection is what would have crossed the grant");

  // Case 2: a call already carried the spend past the grant; the next check
  // reports the stop after that call.
  const probe = runInlineArm({ tokenBudget: 100_000 });
  const afterCall = runInlineArm({ tokenBudget: probe.estimatedTokensSpent - 1 });
  assert.equal(afterCall.report.endedBy, "token-budget-after-call");
  assert.equal(afterCall.report.budgetStopKind, "after-call");
  assert.equal(afterCall.report.budgetReached, true);
  assert.equal(afterCall.report.budgetExceeded, true);
  assert.equal(afterCall.report.budgetProjectedNextCallTokens, null);
  assert.equal(afterCall.report.budgetOvershootTokens,
    afterCall.estimatedTokensSpent - afterCall.tokenBudget);

  // The pilot's top level repeats the primary arm's label and projection.
  const tableOnly = runTableOnlyArm({ tokenBudget: 100_000 });
  const payload = pilotReportOf({
    inline: projectedRun, tableOnly, resultCount: 72,
    rebuildTokens: INLINE_REBUILD_TOKENS, tokenBudget: 100_000,
  });
  assert.equal(payload.endedBy, "token-budget-projected");
  assert.equal(payload.budgetStopKind, "pre-call");
  assert.equal(payload.budgetProjectedNextCallTokens, 27_345);
  assert.equal(payload.budgetReached, false);
});

test("round 3: finalSurface.ok is false while the single-trigger tail is unpruned", () => {
  // The same condition the replay lane reports as reconciliation.ok:false:
  // blocks and answers landed after the one rebuild and stay on the surface.
  const run = runInlineArm();
  assert.equal(run.report.blocksAppended, 58);
  assert.equal(run.report.blocksRemoved, 51);
  assert.equal(run.report.blocksRemaining, 7);
  assert.equal(run.report.answersAppended, 49);
  assert.equal(run.report.answersRemoved, 43);
  assert.equal(run.report.answersRemaining, 6);
  assert.equal(run.report.finalSurface.ok, false,
    "7 blocks and 6 answers remain, so the surface is not ok");
  assert.equal(run.report.finalSurfaceOk, false, "the top level repeats it");
  assert.equal(run.report.finalSurface.ledgerReconciles, true,
    "the counts still reconcile; only cleanliness is false");
  assert.equal(run.report.finalSurface.blocksReconciled, true);
  assert.equal(run.report.finalSurface.answersReconciled, true);
  assert.equal(run.report.finalSurface.cleanSurface, false);
  assert.equal(run.report.finalSurface.surfacesMatchPolicy, false);
  assert.equal(run.report.finalSurface.surfacesMatchPolicyReason,
    "tail-unpruned-by-single-trigger");
  assert.equal(run.report.surfacesMatchPolicyReason,
    "tail-unpruned-by-single-trigger");
  assert.ok(run.report.finalSurface.policyNote.includes("single-trigger"),
    "the note explains the unpruned tail");
  assert.ok(run.report.finalSurface.check.includes("reconciliation.ok"),
    "the check names the replay field it aligns with");

  // A clean surface is ok, so the field is not a constant.
  const tableOnly = runTableOnlyArm();
  assert.equal(tableOnly.report.blocksRemaining, 0);
  assert.equal(tableOnly.report.answersRemaining, 0);
  assert.equal(tableOnly.report.finalSurface.ok, true);
  assert.equal(tableOnly.report.finalSurface.cleanSurface, true);
  assert.equal(tableOnly.report.finalSurface.surfacesMatchPolicyReason, "clean");
});

test("finding N6: a result line carrying the answer tag is never quoted", () => {
  const dirty = [
    `result 1 line 1: alpha-1-1 ${"pad ".repeat(12)}`
      + ` [[inline-answer:1]]{"1":{"forgetall":true}}`,
    `result 2 line 1: alpha-2-1 ${"pad ".repeat(12)}`
      + ` [[inline-answer:2]]{"2":{"keeplines":[[1,2]],"summary":"x"}}`,
    ...Array.from({ length: 8 },
      (_, at) => `clean line ${String(at + 3)} carries alpha beta gamma delta epsilon zeta `
        + `eta theta iota kappa lambda token-${String(at + 3)} ${"pad ".repeat(8)}`),
  ];
  const text = dirty.join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") >= INLINE_FLOOR_BYTES, "the fixture is eligible");
  const block = inlineBlockOf({ text }, 7, { lineCount: dirty.length });
  assert.ok(block !== null, "clean lines still earn a block");
  assert.ok(!block.includes('{"1":{"forgetall":true}}'),
    "the near-complete answer is not copied");
  assert.ok(!block.includes('{"2":{"keeplines"'), "nor the second tagged verdict");
  const quotes = [...block.matchAll(/line (\d+) ends with "([^"]*)"/gu)];
  assert.equal(quotes.length, ENTRY_ASK_MIN_QUOTE_LINES);
  for (const [, number, quote] of quotes) {
    assert.ok(Number(number) > 2, `line ${number} is a clean line`);
    assert.ok(!quote.includes("[[inline-answer:"), "a quote never carries the answer tag");
  }
  assert.equal(inlineEligibilityOf({ text: dirty.slice(0, 2).join("\n") }).reason,
    "below-floor", "two short tagged lines never earn a block");
  const taggedOnly = Array.from({ length: 4 }, (_, at) =>
    `line ${String(at + 1)} ${"pad ".repeat(60)}`
      + ` [[inline-answer:${String(at + 1)}]]{"${String(at + 1)}":{"forgetall":true}}`)
    .join("\n");
  assert.ok(Buffer.byteLength(taggedOnly, "utf8") >= INLINE_FLOOR_BYTES);
  assert.equal(inlineEligibilityOf({ text: taggedOnly }).reason, "no-two-quotes",
    "tagged lines alone never earn a block");
});

test("finding: a mini row never claims a call ordinal it was not given", () => {
  const run = runInlineAsk({
    resultCount: 82, rebuildTokens: 1_000_000_000, tokenBudget: 100_000_000,
  });
  assert.ok(run.blocks.length > 0, "the harness blocked results");
  const block82 = run.blocks.find(block => block.index === 82);
  assert.ok(block82 !== undefined, "result 82 is in the registry");
  for (const block of run.blocks) {
    assert.ok(!block.block.includes("(call #"),
      `result ${String(block.index)} prints no caller-unknown ordinal`);
  }
  assert.ok(block82.block.includes("82. [tool result]"), "the row names the result");
  assert.ok(!block82.block.includes("(call #1)"), "a single row is not call 1");

  const direct = inlineBlockOf({ text: bodyOf(20) }, 82, { lineCount: 20 });
  assert.ok(!direct.includes("(call #"), "no ordinal is invented");
  const known = inlineBlockOf({ text: bodyOf(20) }, 82, { lineCount: 20, callOrdinal: 82 });
  assert.ok(known.includes("(call #82)"), "a known ordinal is shown");
});
