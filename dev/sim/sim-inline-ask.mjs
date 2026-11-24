#!/usr/bin/env node
/**
 * Inline ask: append the keep/forget question to a fresh tool result, read the
 * model's tagged JSON verdict out of the next assistant turn, and rebuild the
 * surface once at depth (inline-ask experiment, 2026-11-08; SIM ONLY).
 *
 * This is the prototype the plan (`docs/plans/2026-11-08-inline-ask/plan.md`)
 * describes. It is not a product path and nothing outside `dev/sim` reads it.
 *
 * THE ONE MARKER. A block is opened and closed by the same line, exactly:
 *
 *     [[racoons-inline-ask]]
 *
 * Two occurrences, and the block is always a SUFFIX of the result's text. The
 * block starts with the one newline that separates it from the result's own last
 * byte, so `surface = original + block`. A result whose own text already contains
 * the marker is never eligible (`marker-present`), so the marker can then only
 * be ours.
 *
 * THE REGISTRY. Appending a block returns `{text, block, registryEntry}`; the
 * caller keeps the `{seq, index, block}` records. The rebuild strips ONLY a
 * registered block that is the message's exact suffix (one trailing newline is
 * tolerated). It never scans for the marker: a result that carries the marker in
 * its own bytes is therefore untouched, byte for byte.
 *
 * THE BLOCK. One mini row from the existing table grammar
 * (`renderPruneAskRows`, the same renderer `jsonl-20` asks through), one line
 * naming the result's index and line count, one prompt line, and one share line
 * written for a SINGLE result: keep at most 40 percent of this result's lines.
 * The block quotes only clean lines: a line carrying the marker, a share-phrase
 * line, or "forget everything"/"keep everything" is never quoted.
 *
 * THE ANSWER TAG. An answer is one line that STARTS with
 * `[[inline-answer:<index>]]` and carries exactly one JSON object whose only key
 * is that same index: `{"N":{"forgetall":true,"summary":"..."}}` or
 * `{"N":{"keeplines":[[s,e],...],"summary":"..."}}`. The block's instructive
 * example uses the literal tag `[[inline-answer:example]]` and the key
 * `"example"`, which is never a result index, so an echoed example can never be
 * read as an answer. `keepall` is refused by name (`action-not-in-grammar`) and
 * keeps; a summary that is the placeholder `"..."` is refused
 * (`placeholder-summary`); a tag whose object names another index is
 * `wrong-index`; an object with no tag is `untagged-answer`.
 *
 * THE ARTIFACT SPAN. One answer artifact is the tagged line (tag plus its JSON
 * object) and ONE adjacent separator: the whole run of newlines after it when
 * there is text after it, else the one newline before it. Removing it therefore
 * leaves the assistant turn's surrounding PROSE in place, at its original
 * spacing. The rebuild removes every tagged artifact it has a decision for, and
 * counts any artifact it has no decision for as `answersRemaining`.
 *
 * THE REBUILD. `rebuildSurface(messages, decisions, blocks)` strips every
 * registered block (restoring the result's own bytes), strips every decided
 * answer artifact (restoring the assistant's own prose), then applies the
 * recorded choices through CORE's `renderShapeTurn` and the port's
 * `composeEntryShapeTurn` — the product's own shaped turn, its marker and its
 * recall id. A result that already carries a shaped turn is left alone, so a
 * second rebuild over its own output changes nothing. A decision whose
 * (seq,start,end) was already seen is refused `duplicate-decision` rather than
 * applied twice. Each applied removal names its byte spans and keeps the
 * original bytes under its recall id; `restoreFromRecall` returns them.
 *
 * Pure and deterministic: no I/O, no clock, no randomness, nothing mutated.
 * A caller bug throws a `RangeError`; transcript data becomes a named refusal.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  ENTRY_ASK_MIN_QUOTE_LINES, JSONL_20_REFUSAL_CODES, anchorsAt, byteRangeForLines,
  jsonl20MessageOf, quoteCountOf, readJsonl20Answer, renderPruneAskRows, renderShapeTurn,
  splitLineOffsets,
} from "@cremator/core";
import { composeEntryShapeTurn } from "cremator-dsh";
import {
  GRAMMAR_GATE_CODE, gateMessageOf, keepsWholeOf,
} from "./sim-batch-grammar.mjs";

/** The result floor: the same 512 bytes the batch lane's population uses. */
export const INLINE_FLOOR_BYTES = 512;
/** The one depth at which the surface is rebuilt, in tokens. */
export const INLINE_REBUILD_TOKENS = 200_000;
/** A sim run's only cap: the token budget (10,000,000 for a sim run). */
export const SIM_TOKEN_BUDGET = 10_000_000;
/** The one block marker; it opens and closes every block. */
export const INLINE_MARKER = "[[racoons-inline-ask]]";
/** The prefix every answer line starts with; `<index>` is the result index. */
export const INLINE_ANSWER_PREFIX = "[[inline-answer:";
/** The tag one answer line must start with, for one result index. */
export const answerTagOf = (index) => `${INLINE_ANSWER_PREFIX}${String(index)}]]`;
/** The two actions an inline answer may carry; `keepall` is a named refusal. */
export const INLINE_ACTIONS = Object.freeze(["forgetall", "keeplines"]);
/** The share line the inline block states: ONE result, later-fire 40 percent. */
export const INLINE_SHARE_LINE =
  "Prune aggressively: drop anything the immediate task does not need; it can be restored anyway. "
  + "For this result, keep at most 40 percent of this result's lines, and keep some parts whole "
  + "and forget others whole if that meets it.";
/** The refusal names that live in this module, beside CORE's wire codes. */
export const INLINE_LOCAL_CODES = Object.freeze([
  "already-shaped", "duplicate-decision", "placeholder-summary",
  "result-absent", "untagged-answer", "wrong-index",
]);
/** The refusal vocabulary: CORE's own list, plus this module's named codes. */
export { JSONL_20_REFUSAL_CODES as INLINE_REFUSAL_CODES };

/** The literal example tag and key the block teaches; never a result index. */
const EXAMPLE_TAG = answerTagOf("example");
const EXAMPLE_ANSWER = `${EXAMPLE_TAG}{"example":{"forgetall":true,"summary":"stale build log"}}`
  + ` or {"example":{"keeplines":[[1,2]],"summary":"the config keys"}}`;
/**
 * Words a block quote never copies: the answer tag, the marker, both share
 * phrases, and the two instruction-shaped phrases a result line could carry. A
 * result line that ends in a tagged verdict is dirty even when its object is a
 * near-complete answer, so the tag prefix is forbidden like the marker. The
 * first-fire share line appears in this module only as a token in this list; it
 * is never emitted.
 */
const FORBIDDEN_QUOTE_TOKENS = Object.freeze([
  INLINE_ANSWER_PREFIX, "40 percent", "70 percent", "forget everything",
  "keep everything",
]);
/** One result already carrying the product's shaped marker is never shaped again. */
const SHAPED_TURN = /(?:^|\n)\[racoons\] kept /u;
/** One sentence per code that lives outside CORE's reader's list. */
const LOCAL_MESSAGES = Object.freeze({
  "already-shaped": "That result already carries a shaped turn; nothing was removed.",
  "duplicate-decision": "The same answer span was recorded twice; only the first is used.",
  "placeholder-summary": "The summary is the prompt's placeholder; the result is kept.",
  "result-absent": "That result is not in the surface; nothing was removed.",
  "untagged-answer": "The answer did not start with its answer tag; the result is kept.",
  "wrong-index": "The tagged answer names a different index than its tag; the result is kept.",
});

/**
 * The exact bytes the model reads per eligible result, appended as a suffix, or
 * `null` when the result is ineligible. `opts` is
 * `{isError, lineCount, callOrdinal?}`: the error check lives here, so every
 * caller gets the same refusal; `callOrdinal` is shown only when the caller
 * knows the result's real ordinal.
 */
export function inlineBlockOf(result, index, options = {}) {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`an inline block needs a positive result index, got ${String(index)}`);
  }
  const opts = options ?? {};
  const text = typeof result === "string" ? result : result?.text;
  if (typeof text !== "string") {
    throw new RangeError("an inline block needs a result carrying `text`");
  }
  const isError = opts.isError === undefined ? result?.isError === true : opts.isError === true;
  const eligibility = inlineEligibilityOf({ text, lineCount: opts.lineCount, isError });
  if (!eligibility.eligible) return null;
  const count = String(eligibility.lineCount);
  const row = miniRowOf(index, eligibility, opts.callOrdinal);
  const prompt = `Answer now for result ${String(index)}: write one line that starts with `
    + `${answerTagOf(index)} and carries exactly one JSON object keyed by ${String(index)}, then `
    + `continue the task. The shape: ${EXAMPLE_ANSWER}; the summary is one line, under 20 words, `
    + `never "..."; a keeplines over [1,${count}] keeps the whole result.`;
  // The leading newline is the ONE separator: `original + block` is the surface.
  // The last marker has no trailing newline, so the block's end is unambiguous.
  return `\n${INLINE_MARKER}\n${row} [${count} line${count === "1" ? "" : "s"}]\n`
    + `${prompt}\n${INLINE_SHARE_LINE}\n${INLINE_MARKER}`;
}

/**
 * Whether one result earns a block: not an error, at or above the 512-byte
 * floor, free of the marker, and able to show two CLEAN quote lines. A quote
 * line is clean when it avoids the marker, a share phrase and the words
 * "forget everything"/"keep everything"; a clean line that cannot be found means
 * no quotes, hence no block. Nothing dirty is ever copied.
 */
export function inlineEligibilityOf({ text, lineCount, isError } = {}) {
  const body = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.byteLength(body, "utf8");
  const lines = linesOf(body);
  const derived = lines.length;
  const stated = lineCount === undefined || lineCount === null ? derived : lineCount;
  if (!Number.isSafeInteger(stated) || stated !== derived) {
    return Object.freeze({
      eligible: false, reason: "line-count-mismatch", bytes, lineCount: derived,
    });
  }
  if (isError === true) {
    return Object.freeze({ eligible: false, reason: "error-result", bytes, lineCount: derived });
  }
  if (bytes < INLINE_FLOOR_BYTES) {
    return Object.freeze({ eligible: false, reason: "below-floor", bytes, lineCount: derived });
  }
  if (body.includes(INLINE_MARKER)) {
    return Object.freeze({ eligible: false, reason: "marker-present", bytes, lineCount: derived });
  }
  const quotes = cleanQuotesOf(lines);
  if (quotes.length < ENTRY_ASK_MIN_QUOTE_LINES) {
    return Object.freeze({ eligible: false, reason: "no-two-quotes", bytes, lineCount: derived });
  }
  return Object.freeze({ eligible: true, reason: null, bytes, lineCount: derived, quotes });
}

/**
 * Append the block to one result when it is eligible: `{text, block,
 * registryEntry}`. `registryEntry` is the `{seq, index, block}` record the lane
 * keeps for the rebuild; it is `null` when nothing was appended. The unchanged
 * `message` and `eligibility` ride along for callers that read them.
 */
export function appendInlineBlockOf(result, index, options = {}) {
  if (result === null || typeof result !== "object" || typeof result.text !== "string") {
    throw new RangeError("appendInlineBlockOf needs a result carrying `text`");
  }
  const opts = options ?? {};
  const isError = opts.isError === undefined ? result.isError === true : opts.isError === true;
  const eligibility = inlineEligibilityOf({
    text: result.text, lineCount: opts.lineCount, isError,
  });
  if (!eligibility.eligible) {
    return Object.freeze({
      text: result.text, block: null, registryEntry: null, message: result, eligibility,
    });
  }
  const block = inlineBlockOf(result, index, { ...opts, lineCount: eligibility.lineCount });
  return Object.freeze({
    text: result.text + block,
    block,
    registryEntry: Object.freeze({ seq: result.seq ?? null, index, block }),
    message: { ...result, text: result.text + block },
    eligibility,
  });
}

/**
 * Read the one tagged answer for `options.index`, or the named refusal that
 * keeps the result. Only a line that STARTS with `answerTagOf(index)` and whose
 * single object key equals that index can answer; text before the tag is not an
 * answer, and the block's literal `example` tag is inert.
 *
 * The return:
 *
 * - `status` — `"answered"` or `"refused"`;
 * - `action`, `summary`, `ranges` — the verdict, for an answer;
 * - `spans` — EVERY canonical tagged artifact for this index, as `[start,end]`
 *   pairs, so the rebuild can remove all of them (a wrong-index line and a
 *   duplicate line do not stay in the surface);
 * - `span` — the artifact that carried the reading (or the first candidate);
 * - `lineCount` — the stated count, or `null`; `keepAll` is true only when the
 *   ranges cover that stated count (the rebuild re-checks the real one).
 */
export function parseInlineAnswer(text, options = {}) {
  const body = typeof text === "string" ? text : "";
  const opts = options ?? {};
  const expected = Number.isSafeInteger(opts.index) && opts.index >= 1 ? opts.index : null;
  const statedCount = Number.isSafeInteger(opts.lineCount) && opts.lineCount >= 1
    ? opts.lineCount : null;
  const tagged = taggedAnswersIn(body);
  if (tagged.length === 0) {
    const names = jsonObjectsIn(body).some(object => expected !== null
      ? Object.prototype.hasOwnProperty.call(object.value, String(expected))
      : Object.keys(object.value).some(key => canonicalIndexKey(key) !== null));
    return refusedAnswer(expected, names ? "untagged-answer" : "answer-unreadable", null);
  }
  let index = expected;
  if (index === null) {
    const indices = [...new Set(tagged.map(entry => entry.index))];
    if (indices.length !== 1) return refusedAnswer(null, "mixed-keys", tagged[0]);
    index = indices[0];
  }
  const mine = tagged.filter(entry => entry.index === index);
  if (mine.length === 0) return refusedAnswer(index, "missing-index", null);
  const spans = mine.map(entry => [entry.span.start, entry.span.end]);
  const readings = mine.map(entry => readingOfTagged(entry, index, statedCount));
  const answers = readings.filter(reading => reading.answer !== undefined);
  if (answers.length > 1) {
    return refusedWithSpans(index, "duplicate-index", answers[0].entry, spans);
  }
  if (answers.length === 0) {
    const reading = readings[0];
    return refusedWithSpans(index, reading.code, reading.entry, spans, reading.message);
  }
  const chosen = answers[0];
  const answer = chosen.answer;
  return Object.freeze({
    status: "answered",
    index,
    action: answer.action,
    summary: answer.summary,
    ranges: Object.freeze(answer.action === "keeplines" && Array.isArray(answer.ranges)
      ? answer.ranges.map(range => Object.freeze({ from: range.from, to: range.to }))
      : []),
    spans: Object.freeze(spans.map(span => Object.freeze([span[0], span[1]]))),
    span: Object.freeze({ start: chosen.entry.span.start, end: chosen.entry.span.end }),
    text: chosen.entry.objectText,
    lineCount: statedCount,
    keepAll: answer.action === "keeplines" && statedCount !== null
      && keepsWholeOf(answer, statedCount),
    message: null,
  });
}

/**
 * Rebuild the surface once. `messages` are `{role, seq, text}`; `decisions` are
 * the parsed records (`{index, seq, status, action?, summary?, ranges?,
 * keepAll?, answer?: {seq, start, end, spans?}}`, or the same record spread with
 * its own top-level `span`/`spans`); `blocks` is the registry of `{seq, block}`
 * records `appendInlineBlockOf` returned. `blocks` is optional and may be omitted
 * entirely, in which case no block is stripped (nothing scans for the marker).
 *
 * A `keeplines` decision whose `ranges` field does not hold line ranges (a
 * caller that put character spans there) is re-read from its artifact's exact
 * bytes, which are the source of truth.
 *
 * A message carries a block only when it ends with that registered block string
 * (one trailing newline tolerated). An answer artifact is removed for every
 * decision that names its index at that seq, so a wrong-index or duplicate line
 * leaves no JSON behind. Leftover artifacts in assistant turns (no decision) are
 * counted, never guessed at.
 *
 * Returns the rebuilt surface plus the two ledgers (`blocksRemoved +
 * blocksRemaining === blocksAppended`, `answersRemoved` and `answersRemaining`),
 * the byte accounting (`bytesRemovedGross`, `bytesAddedByBlocks`,
 * `netBytesRemoved`), the plan, the recall entries, the receipts, the applied
 * removals and the named refusals.
 */
export function rebuildSurface(messages, decisions = [], blocks = []) {
  if (!Array.isArray(messages)) throw new RangeError("rebuildSurface needs a messages array");
  if (!Array.isArray(decisions)) throw new RangeError("rebuildSurface needs a decisions array");
  const options = blocks !== null && typeof blocks === "object" && !Array.isArray(blocks)
    ? blocks : null;
  const registry = Array.isArray(blocks) ? blocks
    : Array.isArray(options?.blocks) ? options.blocks : [];
  const sessionId = typeof options?.sessionId === "string" && options.sessionId.length > 0
    ? options.sessionId : "racoons-inline-ask-sim";
  // 1. Strip the registered blocks. Exact-suffix matching only; the marker is
  // never searched for, so an original result's own bytes are never cut.
  const records = registry.map(entry => ({
    seq: entry?.seq ?? null,
    block: typeof entry?.block === "string" ? entry.block
      : typeof entry?.text === "string" ? entry.text : null,
    removed: false,
  }));
  const recordsBySeq = new Map();
  records.forEach((record, at) => {
    const list = recordsBySeq.get(record.seq) ?? [];
    list.push(at);
    recordsBySeq.set(record.seq, list);
  });
  let bytesAddedByBlocks = 0;
  for (const record of records) {
    if (typeof record.block === "string") {
      bytesAddedByBlocks += Buffer.byteLength(record.block, "utf8");
    }
  }
  let blocksRemoved = 0;
  let blockBytesRemoved = 0;
  const stripped = messages.map(message => {
    if (typeof message?.text !== "string") {
      throw new RangeError("every surface message carries a string `text`");
    }
    const list = recordsBySeq.get(message.seq);
    if (list === undefined) return { ...message };
    let text = message.text;
    for (let at = list.length - 1; at >= 0; at -= 1) {
      const record = records[list[at]];
      if (record.removed || typeof record.block !== "string") continue;
      if (text.endsWith(record.block)) {
        text = text.slice(0, text.length - record.block.length);
        record.removed = true;
        blocksRemoved += 1;
        blockBytesRemoved += Buffer.byteLength(record.block, "utf8");
      } else if (text.endsWith(`${record.block}\n`)) {
        text = text.slice(0, text.length - record.block.length - 1);
        record.removed = true;
        blocksRemoved += 1;
        blockBytesRemoved += Buffer.byteLength(record.block, "utf8") + 1;
      }
    }
    return { ...message, text };
  });
  const blocksRemaining = records.filter(record => !record.removed).length;
  // 2. Strip the answer artifacts. The seen-set runs BEFORE any span is
  // collected, so a duplicate decision is refused once and removed once.
  const seenSpanKeys = new Set();
  const skippedDecisions = new Set();
  const removalBySeq = new Map();
  const refusals = [];
  for (let at = 0; at < decisions.length; at += 1) {
    const decision = decisions[at];
    const reference = answerRefOf(decision);
    if (reference === null) continue;
    const { seq, spans } = reference;
    const index = Number.isSafeInteger(decision?.index) ? decision.index : null;
    const primary = spans[0];
    const key = `${String(seq)}:${String(primary.start)}:${String(primary.end)}`;
    if (seenSpanKeys.has(key)) {
      skippedDecisions.add(at);
      refusals.push(planRefusal(index, decision?.seq ?? seq, "duplicate-decision"));
      continue;
    }
    seenSpanKeys.add(key);
    const entry = removalBySeq.get(seq) ?? { indices: new Set(), spans: [] };
    if (index !== null) entry.indices.add(index);
    for (const span of spans) entry.spans.push(span);
    removalBySeq.set(seq, entry);
  }
  let answersRemoved = 0;
  let answerBytesRemoved = 0;
  let answerSpansSkipped = 0;
  const assistant = stripped.map(message => {
    const entry = removalBySeq.get(message.seq);
    if (entry === undefined) return message;
    const artifacts = answerArtifactsIn(message.text).filter(artifact =>
      entry.indices.has(artifact.index)
      || entry.spans.some(span =>
        span.start === artifact.span.start && span.end === artifact.span.end));
    if (artifacts.length === 0) {
      answerSpansSkipped += entry.spans.length;
      return message;
    }
    // Two adjacent artifacts can share the one separator newline they both
    // consumed; the union removes it once and leaves the prose's own spacing.
    const spans = mergedSpansOf(artifacts.map(artifact => artifact.span));
    let text = message.text;
    for (const span of [...spans].sort((left, right) => right.start - left.start)) {
      answerBytesRemoved += Buffer.byteLength(text.slice(span.start, span.end), "utf8");
      text = `${text.slice(0, span.start)}${text.slice(span.end)}`;
    }
    answersRemoved += artifacts.length;
    return { ...message, text };
  });
  let answersRemaining = 0;
  for (const message of assistant) {
    if (message.role !== "assistant") continue;
    answersRemaining += answerArtifactsIn(message.text).length;
  }
  // 3. Apply the choices, in decision order, to the restored surface.
  const bySeq = new Map();
  assistant.forEach((message, at) => {
    if (!bySeq.has(message.seq)) bySeq.set(message.seq, at);
  });
  const applied = assistant.map(message => ({ ...message }));
  const forgets = [];
  const keeplines = [];
  const keeps = [];
  const recall = [];
  const receipts = [];
  const removals = [];
  const seenResults = new Set();
  for (let at = 0; at < decisions.length; at += 1) {
    if (skippedDecisions.has(at)) continue;
    const decision = decisions[at];
    const index = Number.isSafeInteger(decision?.index) ? decision.index : null;
    const seq = decision?.seq;
    const target = bySeq.get(seq);
    if (target === undefined) {
      refusals.push(planRefusal(index, seq, "result-absent"));
      continue;
    }
    if (seenResults.has(seq)) {
      refusals.push(planRefusal(index, seq, "duplicate-index"));
      continue;
    }
    seenResults.add(seq);
    if (decision.status !== "answered") {
      // A parse refusal is CARRIED through the rebuild, not counted again: the
      // row keeps and its refusal already sits in the run's decisions.
      refusals.push(planRefusal(index, seq,
        typeof decision.code === "string" ? decision.code : "answer-unreadable", true));
      continue;
    }
    if (decision.action === "keepall"
      || (decision.action === "keeplines" && decision.keepAll === true)) {
      keeps.push(keepEntry(index, seq, decision.action, "the answer kept every line"));
      continue;
    }
    const originalText = assistant[target].text;
    const originalBytes = Buffer.from(originalText, "utf8");
    const lineCount = splitLineOffsets(originalBytes).length;
    if (SHAPED_TURN.test(originalText)) {
      refusals.push(planRefusal(index, seq, "already-shaped"));
      continue;
    }
    let lineRanges = [];
    if (decision.action === "keeplines") {
      const ranges = keeplinesRangesOf(decision, lineCount);
      if (ranges === null) {
        refusals.push(planRefusal(index, seq, "spans-outside-result"));
        continue;
      }
      lineRanges = ranges.map(range => ({ startLine: range.from, endLineInclusive: range.to }));
    } else if (decision.action !== "forgetall") {
      refusals.push(planRefusal(index, seq, "action-not-in-grammar"));
      continue;
    }
    let keptRanges;
    try {
      keptRanges = lineRanges.length === 0 ? [] : byteRangeForLines(originalBytes, lineRanges);
    } catch {
      refusals.push(planRefusal(index, seq, "spans-outside-result"));
      continue;
    }
    const source = {
      nodeId: String(seq), sha256: sha256Of(originalBytes), byteLength: originalBytes.length,
    };
    const turn = renderShapeTurn({ source, original: originalBytes, keptRanges, sessionId });
    if (turn === null) {
      keeps.push(keepEntry(index, seq, decision.action, "the answer kept every line"));
      continue;
    }
    const shapedText = Buffer.from(
      composeEntryShapeTurn(String(decision.summary ?? ""), turn.bytes)).toString("utf8");
    const entry = Object.freeze({
      index, seq, status: "applied", action: decision.action,
      summary: String(decision.summary ?? ""),
      bytesRemoved: turn.droppedBytes,
      removedByteSpans: Object.freeze(turn.gaps.map(range => Object.freeze({ ...range }))),
      removedLineSpans: Object.freeze(removedLineSpansOf(lineRanges, lineCount)),
      keptLines: Object.freeze(turn.keptLines.map(range => Object.freeze({ ...range }))),
      keptBytes: originalBytes.length - turn.droppedBytes,
      lineCount,
      recallId: turn.recallId,
      receipt: turn.marker,
      originalBytes,
      originalText,
      originalSha256: source.sha256,
      shapedText,
      shapedSha256: sha256Of(Buffer.from(shapedText, "utf8")),
    });
    if (decision.action === "forgetall") forgets.push(entry);
    else keeplines.push(entry);
    recall.push(Object.freeze({
      recallId: turn.recallId, index, seq,
      bytes: originalBytes.length, sha256: source.sha256,
      originalBytes, originalText,
    }));
    receipts.push(Object.freeze({
      index, seq, action: decision.action, recallId: turn.recallId,
      marker: turn.marker, bytesRemoved: turn.droppedBytes,
    }));
    removals.push(Object.freeze({
      index, seq, status: "applied", action: decision.action,
      bytesRemoved: turn.droppedBytes, recallId: turn.recallId,
    }));
    applied[target] = { ...applied[target], text: shapedText };
  }
  let resultBytesRemoved = 0;
  for (const entry of [...forgets, ...keeplines]) resultBytesRemoved += entry.bytesRemoved;
  const bytesRemovedGross = blockBytesRemoved + answerBytesRemoved + resultBytesRemoved;
  const plan = Object.freeze({
    forgets: Object.freeze(forgets),
    keeplines: Object.freeze(keeplines),
    keeps: Object.freeze(keeps),
    refusals: Object.freeze(refusals),
    recall: Object.freeze(recall),
  });
  return Object.freeze({
    messages: Object.freeze(applied.map(message => Object.freeze(message))),
    restoredMessages: Object.freeze(assistant.map(message => Object.freeze(message))),
    blocksAppended: records.length,
    blocksRemoved,
    blocksRemaining,
    answersRemoved,
    answersRemaining,
    answerSpansSkipped,
    bytesAddedByBlocks,
    bytesRemovedGross,
    bytesRemovedByBlocks: blockBytesRemoved,
    bytesRemovedByAnswers: answerBytesRemoved,
    bytesRemovedByResults: resultBytesRemoved,
    netBytesRemoved: bytesRemovedGross - bytesAddedByBlocks,
    plan,
    recall: plan.recall,
    receipts: Object.freeze(receipts),
    applied: Object.freeze(removals),
    refusals: plan.refusals,
    stats: Object.freeze({
      blocksRemoved,
      blocksRemaining,
      blockBytesRemoved,
      answersRemoved,
      answersRemaining,
      answerBytesRemoved,
      resultBytesRemoved,
      bytesRemoved: bytesRemovedGross,
      netBytesRemoved: bytesRemovedGross - bytesAddedByBlocks,
      messages: messages.length,
    }),
  });
}

/**
 * The exact original bytes a recall entry keeps, as a fresh `Buffer`; throws a
 * named `RangeError` when the entry carries no bytes or when its sha256 (or
 * stated length) does not match them. Never returns partial bytes.
 */
export function restoreFromRecall(entry) {
  const stored = entry?.originalBytes;
  const bytes = stored instanceof Uint8Array ? Buffer.from(stored)
    : typeof entry?.originalText === "string" ? Buffer.from(entry.originalText, "utf8")
      : null;
  if (bytes === null) {
    throw new RangeError(
      `sim-inline-recall-unreadable: ${String(entry?.recallId)} keeps no original bytes`);
  }
  const stated = entry?.sha256;
  if (typeof stated === "string" && sha256Of(bytes) !== stated) {
    throw new RangeError(
      `sim-inline-recall-hash-mismatch: ${String(entry?.recallId)} does not match its sha256`);
  }
  if (Number.isSafeInteger(entry?.bytes) && entry.bytes !== bytes.length) {
    throw new RangeError(
      `sim-inline-recall-hash-mismatch: ${String(entry?.recallId)} does not match its length`);
  }
  return bytes;
}

/**
 * The numbers the inline-ask lane reports. `blocks` is the block strings (or
 * `{text}` records) appended at landing; `decisions` is the parsed records; and
 * `rebuild` is `rebuildSurface`'s return when a rebuild ran. The report always
 * states the one cap — the token budget — and that no timer or ask ceiling was
 * armed, because the plan makes those facts part of the result.
 */
export function inlineAskReport({
  blocks = [], decisions = [], rebuild = null, depthBefore = null, depthAfter = null,
  tokenBudget = SIM_TOKEN_BUDGET, timerMs = 0, askCeiling = 0, turns = null,
  bigTable = null,
} = {}) {
  if (!Array.isArray(blocks)) throw new RangeError("the report's blocks are an array");
  if (!Array.isArray(decisions)) throw new RangeError("the report's decisions are an array");
  const blockBytes = blocks.reduce((sum, block) => ify(sum, block), 0);
  const answerBytes = decisions.reduce((sum, decision) =>
    sum + Buffer.byteLength(typeof decision?.answer?.text === "string"
      ? decision.answer.text : "", "utf8"), 0);
  const counts = { forgetall: 0, keeplines: 0, keepall: 0, refused: 0 };
  for (const decision of decisions) {
    if (decision?.status === "refused") counts.refused += 1;
    else if (decision?.action === "keepall"
      || (decision?.action === "keeplines" && decision?.keepAll === true)) counts.keepall += 1;
    else if (decision?.action === "keeplines") counts.keeplines += 1;
    else if (decision?.action === "forgetall") counts.forgetall += 1;
    else counts.refused += 1;
  }
  const parseRefusals = counts.refused;
  const rebuildRefusals = (rebuild?.plan?.refusals ?? [])
    .filter(refusal => refusal.carried !== true).length;
  const stats = rebuild?.stats ?? {
    blocksRemoved: 0, blocksRemaining: 0, blockBytesRemoved: 0,
    answersRemoved: 0, answersRemaining: 0, answerBytesRemoved: 0,
    resultBytesRemoved: 0, bytesRemoved: 0,
  };
  const caps = timerMs === 0 && askCeiling === 0
    ? Object.freeze({
      tokenBudget, timerMs, askCeiling,
      onlyCap: "token budget",
      timer: "none",
      ceiling: "none",
      note: "the token budget is the only cap; no wall-clock timer and no ask ceiling were armed",
    })
    : Object.freeze({
      tokenBudget, timerMs, askCeiling,
      onlyCap: "token budget and another cap",
      timer: timerMs === 0 ? "none" : String(timerMs),
      ceiling: askCeiling === 0 ? "none" : String(askCeiling),
      note: "the token budget is not the only cap; a timer or an ask ceiling was stated",
    });
  return Object.freeze({
    blocksAppended: blocks.length,
    bytesAddedByBlocks: blockBytes,
    bytesAddedByAnswers: answerBytes,
    answersParsed: decisions.filter(decision => decision?.status === "answered").length,
    refusals: parseRefusals + rebuildRefusals,
    parseRefusals,
    rebuildRefusals,
    decisionsByAction: Object.freeze(counts),
    bytesRemovedAtRebuild: stats.bytesRemoved,
    rebuildBytes: Object.freeze({
      blocks: stats.blockBytesRemoved,
      answers: stats.answerBytesRemoved,
      results: stats.resultBytesRemoved,
      total: stats.bytesRemoved,
    }),
    depthBefore,
    depthAfter,
    depthDelta: depthBefore === null || depthAfter === null ? null : depthAfter - depthBefore,
    tokenBudget,
    timerMs,
    askCeiling,
    caps,
    turns,
    bigTable,
  });
}

/** A unitless token estimate for the harness's depth gauge (3.04 B/token). */
export function estimatedTokensOf(bytes) {
  return Math.ceil(Number(bytes) / 3.04);
}

/** The result's own lines, by the one convention every sim facts reader uses. */
export function linesOf(text) {
  const body = String(text);
  const lines = body.split("\n");
  if (body.endsWith("\n")) lines.pop();
  return lines;
}

/** The mini row: the table renderer's own shape, with the ordinal only when known. */
function miniRowOf(index, eligibility, callOrdinal) {
  const known = Number.isSafeInteger(callOrdinal) && callOrdinal >= 1;
  const ordinal = known ? callOrdinal : 1;
  const row = renderPruneAskRows([{
    index,
    unit: placeholderUnitOf(index),
    anchor: { kind: "tool result", callOrdinal: ordinal, anchors: eligibility.quotes },
  }]);
  // The renderer always prints `(call #N)`; when the caller does not know the
  // real ordinal the row must not invent one. The strip is anchored to the row
  // head, so identical text inside a quote is never touched.
  return known ? row : row.replace(/^([0-9]+\. \[[^\]\n]*\]) \(call #[0-9]+\)/u, "$1");
}

/** The two quotes a block may show: from clean lines only, never copied dirty. */
function cleanQuotesOf(lines) {
  const clean = lines.map(line => quoteForbiddenOf(line) ? "" : line);
  const anchors = anchorsAt(clean, clean.map((_, at) => at + 1), { withTotal: false });
  const quotes = [];
  for (const anchor of anchors) {
    if (quoteCountOf([anchor]) !== 1 || quotes.includes(anchor)) continue;
    quotes.push(anchor);
    if (quotes.length === ENTRY_ASK_MIN_QUOTE_LINES) break;
  }
  return quotes;
}

/** True when a line may not be quoted into a block: marker, share, instruction. */
function quoteForbiddenOf(line) {
  if (line.includes(INLINE_MARKER)) return true;
  const lower = line.toLowerCase();
  return FORBIDDEN_QUOTE_TOKENS.some(token => lower.includes(token));
}

/** Every canonical tagged answer artifact in the text, with its exact span. */
function taggedAnswersIn(text) {
  const entries = [];
  let at = 0;
  while (at <= text.length) {
    const newline = text.indexOf("\n", at);
    const lineEnd = newline < 0 ? text.length : newline;
    const match = /^\[\[inline-answer:([^\]\n]*)\]\]/u.exec(text.slice(at, lineEnd));
    if (match !== null) {
      const index = canonicalIndexKey(match[1]);
      // A non-numeric tag (the literal `example`) is inert: it is not an answer
      // and not an artifact, so an echoed example can never move a unit.
      if (index !== null) {
        const object = objectAt(text, at + match[0].length, lineEnd);
        const contentEnd = object === null ? at + match[0].length : object.end;
        entries.push({
          index, object, objectText: object === null ? null : object.text,
          span: artifactSpanOf(text, at, contentEnd),
        });
      }
    }
    if (newline < 0) break;
    at = newline + 1;
  }
  return entries;
}

/** One tagged answer's reading, or the named code that keeps the result. */
function readingOfTagged(entry, index, statedCount) {
  if (entry.object === null) return { entry, code: "answer-unreadable" };
  const keys = Object.keys(entry.object.value);
  if (keys.length !== 1 || canonicalIndexKey(keys[0]) !== index) {
    return { entry, code: "wrong-index" };
  }
  const total = statedCount ?? Number.MAX_SAFE_INTEGER;
  const reading = readJsonl20Answer(JSON.stringify(entry.object.value), [index],
    new Map([[index, total]]));
  const row = reading.rows[0];
  if (row?.status !== "answered") {
    return { entry, code: row?.code ?? "answer-unreadable", message: row?.message };
  }
  if (row.answer.action === "keepall") {
    return { entry, code: GRAMMAR_GATE_CODE, message: gateMessageOf("jsonl-20") };
  }
  if (typeof row.answer.summary === "string" && row.answer.summary.trim() === "...") {
    return { entry, code: "placeholder-summary" };
  }
  return { entry, answer: row.answer };
}

/**
 * The removed artifact: the tagged line through `contentEnd`, plus ONE adjacent
 * separator — the whole newline run after it when more text follows, else the
 * one newline before it. This is what keeps the surrounding prose's own spacing.
 */
function artifactSpanOf(text, lineStart, contentEnd) {
  const from = Math.min(Math.max(contentEnd, lineStart), text.length);
  const newline = text.indexOf("\n", from);
  const lineEnd = newline < 0 ? text.length : newline;
  let runEnd = lineEnd;
  while (runEnd < text.length && text[runEnd] === "\n") runEnd += 1;
  if (runEnd === text.length && lineStart > 0 && text[lineStart - 1] === "\n") {
    return { start: lineStart - 1, end: runEnd };
  }
  if (runEnd > lineEnd) return { start: lineStart, end: runEnd };
  if (lineStart > 0 && text[lineStart - 1] === "\n") {
    return { start: lineStart - 1, end: lineEnd };
  }
  return { start: lineStart, end: lineEnd };
}

/** Every canonical tagged artifact in the text (used by the rebuild's ledger). */
function answerArtifactsIn(text) {
  return taggedAnswersIn(text);
}

/** The sorted union of spans: adjacent or overlapping spans become one. */
function mergedSpansOf(spans) {
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** One JSON object inside `[from, limit)`, with its absolute span, or null. */
function objectAt(text, from, limit) {
  let at = from;
  while (at < limit && (text[at] === " " || text[at] === "\t")) at += 1;
  if (at >= limit || text[at] !== "{") return null;
  const end = objectEndOf(text, at);
  if (end < 0 || end >= limit) return null;
  const raw = text.slice(at, end + 1);
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { value, start: at, end: end + 1, text: raw };
}

/** One refusal record; `index` is the result the caller asked about, or null. */
function refusedAnswer(index, code, entry) {
  return refusedWithSpans(index, code, entry,
    entry === null || entry === undefined ? [] : [[entry.span.start, entry.span.end]]);
}

/** One refusal that also names every candidate artifact span it saw. */
function refusedWithSpans(index, code, entry, spans, message = null) {
  return Object.freeze({
    status: "refused",
    index: Number.isSafeInteger(index) ? index : null,
    code,
    message: typeof message === "string" && message.length > 0 ? message : inlineMessageOf(code),
    text: entry?.objectText ?? null,
    span: entry === null || entry === undefined
      ? null : Object.freeze({ start: entry.span.start, end: entry.span.end }),
    spans: Object.freeze((spans ?? []).map(span => Object.freeze([span[0], span[1]]))),
  });
}

/** The sentences this module owes for codes CORE's reader does not name. */
function inlineMessageOf(code) {
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(LOCAL_MESSAGES, code)) {
    return LOCAL_MESSAGES[code];
  }
  if (JSONL_20_REFUSAL_CODES.includes(code)) return jsonl20MessageOf(code);
  return jsonl20MessageOf("answer-unreadable");
}

/** One rebuild refusal that names no applied removal. */
function planRefusal(index, seq, code, carried = false) {
  return Object.freeze({
    index, seq, status: "refused", action: null, bytesRemoved: 0,
    code, carried,
    message: inlineMessageOf(code),
  });
}

/** One keep: an answered choice that removed no byte (a full-range keeplines). */
function keepEntry(index, seq, action, reason) {
  return Object.freeze({
    index, seq, status: "kept", action, keepAll: true, bytesRemoved: 0,
    reason, recallId: null,
  });
}

/** The removed line spans: the complement of the kept ranges over `1..total`. */
function removedLineSpansOf(keptRanges, total) {
  if (keptRanges.length === 0) return [{ from: 1, to: total }];
  const spans = [];
  let at = 1;
  for (const range of keptRanges) {
    if (at < range.startLine) spans.push({ from: at, to: range.startLine - 1 });
    at = Math.max(at, range.endLineInclusive + 1);
  }
  if (at <= total) spans.push({ from: at, to: total });
  return spans;
}

/** True when every range is an ascending, non-overlapping span inside `1..total`. */
function rangesInside(ranges, total) {
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range?.from) || !Number.isSafeInteger(range?.to)) return false;
    if (range.from < 1 || range.to < range.from || range.to > total) return false;
    if (range.from <= previousEnd) return false;
    previousEnd = range.to;
  }
  return true;
}

/** Every `{start,end}` span a decision's answer names, primary included. */
function answerSpansOf(answer) {
  const spans = [];
  const raw = Array.isArray(answer?.spans) ? answer.spans : [];
  for (const span of raw) {
    const pair = Array.isArray(span) ? span : [span?.start, span?.end];
    if (validSpanOf(pair[0], pair[1])) spans.push({ start: pair[0], end: pair[1] });
  }
  if (validSpanOf(answer?.start, answer?.end)
    && !spans.some(span => span.start === answer.start && span.end === answer.end)) {
    spans.push({ start: answer.start, end: answer.end });
  }
  return spans;
}

/**
 * Where a decision's answer artifact lives: its `answer` record when it carries
 * one, else the record's own top-level `span`/`spans` (which every decision that
 * spreads a parse result also has). The `seq` is the assistant message.
 */
function answerRefOf(decision) {
  const answer = decision?.answer;
  if (answer !== null && answer !== undefined) {
    const spans = answerSpansOf(answer);
    if (spans.length > 0) {
      return {
        seq: answer.seq ?? decision?.answerSeq ?? decision?.seq ?? null,
        spans,
      };
    }
  }
  const spans = [];
  const raw = Array.isArray(decision?.spans) ? decision.spans : [];
  for (const span of raw) {
    const pair = Array.isArray(span) ? span : [span?.start, span?.end];
    if (validSpanOf(pair[0], pair[1])) spans.push({ start: pair[0], end: pair[1] });
  }
  const single = decision?.span;
  if (validSpanOf(single?.start, single?.end)
    && !spans.some(span => span.start === single.start && span.end === single.end)) {
    spans.push({ start: single.start, end: single.end });
  }
  if (spans.length === 0) return null;
  return {
    seq: decision?.answerSeq ?? single?.seq ?? decision?.seq ?? null,
    spans,
  };
}

/**
 * The `keeplines` line ranges a decision names. A decision may carry them as
 * `ranges`; when that field holds character spans instead (a caller that spread
 * the parse record), the same ranges are re-read from the artifact's own bytes,
 * which are the source of truth. Returns `null` when no valid range is found.
 */
function keeplinesRangesOf(decision, lineCount) {
  const stated = Array.isArray(decision?.ranges) ? decision.ranges : [];
  if (stated.length > 0 && rangesInside(stated, lineCount)) {
    return stated.map(range => ({ from: range.from, to: range.to }));
  }
  for (const text of [decision?.answerLineText, decision?.span?.text,
    decision?.answer?.text, decision?.text]) {
    if (typeof text !== "string") continue;
    const value = objectInText(text);
    if (value === null) continue;
    const key = Number.isSafeInteger(decision?.index)
      ? String(decision.index) : Object.keys(value)[0];
    const row = value[key];
    if (row === null || typeof row !== "object") continue;
    const payload = row.keeplines;
    if (!Array.isArray(payload) || payload.length === 0) continue;
    const pairs = [];
    let readable = true;
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length !== 2
        || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1])) {
        readable = false;
        break;
      }
      pairs.push({ from: pair[0], to: pair[1] });
    }
    if (!readable || !rangesInside(pairs, lineCount)) continue;
    return pairs;
  }
  return null;
}

/** The first complete JSON object in the text, or null. */
function objectInText(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = objectEndOf(text, start);
  if (end < 0) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function validSpanOf(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 0 && end > start;
}

/** The placeholder unit `renderPruneAskRows` never reads; it only types the row. */
function placeholderUnitOf(index) {
  return {
    id: `inline-ask-row:${String(index)}`,
    nodeId: "",
    source: { nodeId: "", sha256: "", byteLength: 0 },
    path: null,
    span: { byteRange: { startByte: 0, endByteExclusive: 0 }, lineRange: null },
    byteLength: 0,
  };
}

/** Every complete top-level JSON object in the text, with its exact span. */
function jsonObjectsIn(text) {
  const objects = [];
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf("{", at);
    if (start < 0) break;
    const end = objectEndOf(text, start);
    if (end < 0) {
      at = start + 1;
      continue;
    }
    const raw = text.slice(start, end + 1);
    let value;
    try { value = JSON.parse(raw); } catch { at = start + 1; continue; }
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && !arrayElementOf(text, start)) {
      objects.push({ value, start, end: end + 1, text: raw });
    }
    at = end + 1;
  }
  return objects;
}

/** True when the `{` at `start` is a direct array element (`[{...}]` is not an answer). */
function arrayElementOf(text, start) {
  let at = start - 1;
  while (at >= 0 && /\s/u.test(text[at])) at -= 1;
  return at >= 0 && text[at] === "[";
}

/** The matching `}` of the object starting at `start`, or -1; strings are skipped. */
function objectEndOf(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const ch = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** A canonical row-index key: a positive decimal string, never "01" or "1.5". */
function canonicalIndexKey(key) {
  if (typeof key !== "string" || !/^[1-9][0-9]*$/u.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : null;
}

/** A block's UTF-8 byte length, from a string or a `{text}` record. */
function ify(sum, block) {
  const text = typeof block === "string" ? block : block?.text;
  return sum + Buffer.byteLength(typeof text === "string" ? text : "", "utf8");
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
