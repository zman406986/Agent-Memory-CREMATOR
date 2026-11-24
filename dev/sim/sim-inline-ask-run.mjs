#!/usr/bin/env node
/**
 * The inline-ask synthetic pilot, A/B: inline arm vs table-only arm
 * (branch `alt/inline-ask`, 2026-11-08; SIM ONLY).
 *
 * THE CLAIM. This is a synthetic pilot, not the real experiment. There is no
 * provider (`provider: "none"`), no socket, no key and no clock. Every model
 * turn is a deterministic stub: the verdict text is appended to a prewritten
 * assistant turn, and the table answers are composed by `stubTableAnswerOf`.
 * The report says so (`billable: false`, `citable: false`,
 * `syntheticSurface: true`) and `tokenAccounting` names the depth estimate.
 *
 * THE TWO ARMS. Both run the same synthetic world (a system turn, then one
 * result turn and one assistant turn per result; every fifth result is below
 * the 512-byte floor). Only the mechanism differs:
 *
 * - inline: each eligible result gets the block at landing; the stub's next
 *   assistant turn carries the tagged verdict. At the first surface at or above
 *   the rebuild bar the surface is rebuilt (blocks and answers stripped, the
 *   recorded choices applied), then one table pass runs for the units the
 *   inline answers left undecided.
 * - table-only: no block. At the same bar one table pass runs over every
 *   eligible result landed so far, with the same 40 percent prompt, and its
 *   answers are applied through the same shape/plan path.
 *
 * Both arms then run to the end of the synthetic world. The measured run is
 * NOT stopped at the trigger: the tail after the trigger is reported
 * (`blocksRemaining`, `answersRemaining`, `rebuildStillAbove`, `finalDepth`),
 * and `rebuildPolicy` states the one policy in words.
 *
 * Run:
 *
 *     node dev/sim/sim-inline-ask-run.mjs [--results 72]
 *       [--inline-rebuild-tokens 200000] [--token-budget 10000000]
 *       [--table-only] [--json] [--out <file>]
 *
 * No timer and no ask ceiling are armed. The token budget is the only cap and
 * it is reported, not implied.
 */
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";
import { anchorsFor } from "@cremator/core";
import {
  DEFAULT_ASK_ORDER, answerRowsOf, askMessageForRows, keepsWholeOf,
} from "./sim-batch-grammar.mjs";
import {
  INLINE_FLOOR_BYTES, INLINE_MARKER, INLINE_REBUILD_TOKENS, SIM_TOKEN_BUDGET,
  answerTagOf, appendInlineBlockOf, estimatedTokensOf, linesOf, parseInlineAnswer,
  rebuildSurface, restoreFromRecall,
} from "./sim-inline-ask.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = path.join(HERE, "sim-inline-ask-run.mjs");
const USAGE = `usage: node ${SCRIPT} [--results 72] [--inline-rebuild-tokens 200000]`
  + " [--token-budget 10000000] [--table-only] [--json] [--out <file>]";

/** The report schema id; a reader can tell a pilot JSON from any other sim JSON. */
export const PILOT_SCHEMA = "racoons-sim-inline-ask-pilot/1";
/** The one table grammar the pilot uses, in both arms (ISSUE-221). */
export const TABLE_GRAMMAR = "jsonl-20-nokeepall";
/** The share line the table pass must use: the later fire's 40 percent line. */
export const TABLE_SHARE_LINE = "later (40 percent)";
/** The stub's provider label: no provider was called. */
export const STUB_PROVIDER = "none";
/** The one token accounting sentence every report carries. */
export const TOKEN_ACCOUNTING =
  "stub-estimate 3.04 B/token (ceil(bytes / 3.04)); no provider; not billable";
/** The one rebuild policy, stated in the JSON. */
export const REBUILD_POLICY =
  "single-trigger-at-first-crossing: the first surface at or above the bar is"
  + " rebuilt once (inline arm) or gets its one table pass (table-only arm);"
  + " the run then continues to the end of the world, no second trigger is"
  + " allowed, and rebuildStillAbove/finalDepth plus blocksRemaining and"
  + " answersRemaining report the tail after the trigger.";

/** The inline stub's deterministic profile, one kind per `index % 6`. */
export const INLINE_STUB_PROFILE = Object.freeze({
  rule: "index % 6",
  kinds: Object.freeze([
    "0 forgetall", "1 keeplines [[2,min(3,L)]]",
    "2 keepall (refused: action-not-in-grammar)", "3 malformed forgetall string",
    "4 no answer at all", "5 keeplines over [1,L] (accepted full-range keep)",
  ]),
});
/** The table stub's deterministic profile, one kind per `index % 4`. */
export const TABLE_STUB_PROFILE = Object.freeze({
  rule: "index % 4",
  kinds: Object.freeze([
    "0 forgetall", "1 keeplines [[1,min(2,L)]]",
    "2 keeplines over [1,L] (accepted full-range keep)",
    "3 keeplines [[1,max(1,floor(L/4))]]",
  ]),
});

/**
 * One deterministic synthetic world: a system turn, then one result turn and
 * one assistant turn per result. Every fifth result is tiny (below the floor);
 * the others are ~11 KiB of 26 lines, so the plain world itself crosses
 * 200,000 tokens and the table-only arm fires at the same bar as the inline one.
 */
export function syntheticSurfaceOf({ resultCount = 72 } = {}) {
  if (!Number.isSafeInteger(resultCount) || resultCount < 1) {
    throw new RangeError(`--results takes a positive integer, got ${String(resultCount)}`);
  }
  const messages = [{ role: "system", seq: 0, text: "You are a coding agent." }];
  const results = [];
  for (let index = 1; index <= resultCount; index += 1) {
    const lines = index % 5 === 0 ? 1 : 26;
    const text = syntheticResultOf(index, lines);
    const seq = index * 2;
    const assistantSeq = seq + 1;
    messages.push({ role: "user", seq, kind: "tool-result", text });
    messages.push({ role: "assistant", seq: assistantSeq, text: continuationOf(index) });
    results.push({ index, seq, assistantSeq, text, lineCount: lines });
  }
  return { messages, results };
}

/** The same world without any block or answer: the turn-count baseline. */
export function plainSurfaceOf(world) {
  const messages = [{ ...world.messages[0] }];
  for (const result of world.results) {
    messages.push({ role: "user", seq: result.seq, kind: "tool-result", text: result.text });
    messages.push({ role: "assistant", seq: result.assistantSeq, text: continuationOf(result.index) });
  }
  return messages;
}

/** The table pass's 40 percent ask for the given rows (never the 70 percent one). */
export function bigTableAskOf(rows) {
  return askMessageForRows(rows, TABLE_GRAMMAR, DEFAULT_ASK_ORDER, false);
}

/** The turn counts by role. */
export function turnCountsOf(messages) {
  const counts = { total: messages.length, system: 0, user: 0, assistant: 0 };
  for (const message of messages) {
    const role = message?.role;
    if (role === "system" || role === "user" || role === "assistant") counts[role] += 1;
  }
  return counts;
}

/**
 * One inline pass. Returns the run record the report reads, plus the JSON-ready
 * `report`. The run continues after the one rebuild; the tail is measured and
 * reported, never hidden.
 */
export function runInlineArm({
  resultCount = 72, rebuildTokens = INLINE_REBUILD_TOKENS,
  tokenBudget = SIM_TOKEN_BUDGET, sessionId = "racoons-inline-ask-harness",
} = {}) {
  assertSettings({ resultCount, rebuildTokens, tokenBudget });
  const world = syntheticSurfaceOf({ resultCount });
  const baselineMessages = plainSurfaceOf(world);
  let messages = [{ ...world.messages[0] }];
  const blocks = [];
  const blockRecords = [];
  const untouched = [];
  const decisions = [];
  let rebuild = null;
  let tablePass = null;
  let blocksAtRebuild = null;
  let decisionsAtRebuild = null;
  let depthBefore = null;
  let depthAfterRebuild = null;
  let depthAfter = null;
  let rebuildAtResult = null;
  let rebuildCount = 0;
  let estimatedTokensSpent = 0;
  let stoppedAtBudget = false;
  let budgetProjectedNextCallTokens = null;
  let landedResults = 0;

  for (const result of world.results) {
    // The result LANDS: its block (when eligible) is appended at landing,
    // before any model work. The harness does not know the result's real call
    // ordinal, so it does not pass one and the row shows none.
    const base = { role: "user", seq: result.seq, kind: "tool-result", text: result.text };
    const appended = appendInlineBlockOf(base, result.index, {
      isError: false, lineCount: result.lineCount,
    });
    const landedText = appendedTextOf(appended, result.text);
    messages.push({ ...base, text: landedText });
    if (appended.block === null || appended.block === undefined) {
      untouched.push({ index: result.index, reason: untouchedReasonOf(result.text) });
    } else {
      blocks.push(appended.registryEntry ?? { seq: result.seq, block: appended.block });
      blockRecords.push({
        index: result.index, seq: result.seq,
        bytes: Buffer.byteLength(appended.block, "utf8"), text: appended.block,
      });
    }
    // The model's next assistant turn lands. It is the turn it would take
    // anyway; the inline answer rides it and adds no message.
    const assistant = {
      role: "assistant", seq: result.assistantSeq, text: continuationOf(result.index),
    };
    messages.push(assistant);
    const assistantAt = messages.length - 1;
    landedResults += 1;
    const depthAtTurn = estimatedTokensOf(totalBytesOf(messages));
    // The budget is checked BEFORE the turn's model work. When the check trips
    // below the grant, the stop is a PROJECTED one: the next call's cost was
    // estimated and would cross the grant, but this run's own spend did not.
    if (estimatedTokensSpent + depthAtTurn >= tokenBudget) {
      stoppedAtBudget = true;
      budgetProjectedNextCallTokens = depthAtTurn;
      break;
    }
    const verdict = appended.block === null || appended.block === undefined
      ? null : stubVerdictOf(result.index, result.lineCount);
    const assistantText = verdict === null
      ? assistant.text : `${assistant.text}\n${verdict}`;
    messages[assistantAt] = { ...assistant, text: assistantText };
    // A blocked result always earns a decision, even when the stub wrote no
    // verdict: the parser's `answer-unreadable` refusal is the undecided row the
    // table pass later asks about. A blocked result with no verdict must not
    // silently vanish from the decision log.
    if (appended.block !== null && appended.block !== undefined) {
      const parsed = parseInlineAnswer(assistantText, {
        index: result.index, lineCount: result.lineCount,
      });
      decisions.push(decisionOf(parsed, {
        index: result.index, seq: result.seq, answerSeq: result.assistantSeq,
        assistantText, answerLineText: verdict, lineCount: result.lineCount,
      }));
    }
    estimatedTokensSpent += depthAtTurn
      + estimatedTokensOf(Buffer.byteLength(assistantText, "utf8"));
    // The one trigger: at the configured depth, strip the artifacts, apply the
    // decisions, then run the table pass for the units still undecided.
    if (rebuildCount === 0 && estimatedTokensOf(totalBytesOf(messages)) >= rebuildTokens) {
      depthBefore = estimatedTokensOf(totalBytesOf(messages));
      rebuildCount = 1;
      rebuildAtResult = result.index;
      blocksAtRebuild = blocks.slice();
      decisionsAtRebuild = decisions.slice();
      rebuild = rebuildSurface(
        messages.map(message => ({ ...message })), decisionsAtRebuild,
        { blocks: blocksAtRebuild, sessionId });
      messages = messagesOf(rebuild);
      depthAfterRebuild = estimatedTokensOf(totalBytesOf(messages));
      tablePass = applyTablePass({
        messages,
        rows: rowsOfRefused(decisionsAtRebuild, messages),
        estimatedTokensSpent, tokenBudget, sessionId, label: "inline-rebuild",
      });
      messages = tablePass.messages;
      estimatedTokensSpent = tablePass.estimatedTokensSpent;
      depthAfter = estimatedTokensOf(totalBytesOf(messages));
      if (tablePass.skippedForBudget === true) {
        stoppedAtBudget = true;
        budgetProjectedNextCallTokens = tablePass.projectedNextCallTokens ?? null;
      }
    }
  }

  const finalDepth = estimatedTokensOf(totalBytesOf(messages));
  const finalSurface = finalSurfaceCheckOf({ messages, blocks, decisions });
  const counts = decisionCountsOf(decisions);
  const budget = budgetRecordOf({
    estimatedTokensSpent, tokenBudget, stoppedAtBudget, budgetProjectedNextCallTokens,
  });
  const { endedBy } = budget;
  const turns = turnsOf({
    messages, baselineMessages, tablePass, decisions, landedResults,
    endedBy, budgetReached: budget.budgetReached,
  });
  const bytes = byteStatsOf({
    blocks, blockRecords, decisions, rebuild, tablePass, blocksAtRebuild, decisionsAtRebuild,
  });
  const receipts = receiptsOf([rebuild, tablePass?.apply]);
  const recall = recallOf([rebuild, tablePass?.apply]);
  const restore = restoreCheckOf({ recallEntries: recallEntriesOf([rebuild, tablePass?.apply]), world });
  const report = armReportOf({
    arm: "inline", world, messages, baselineMessages, blocks, decisions, untouched,
    rebuild, tablePass, depthBefore, depthAfterRebuild, depthAfter, finalDepth,
    counts, turns, bytes, receipts, recall, restore, finalSurface, endedBy,
    budgetEnforced: budget.budgetEnforced, budgetReached: budget.budgetReached,
    budgetExceeded: budget.budgetExceeded,
    budgetOvershootTokens: budget.budgetOvershootTokens,
    budgetStopKind: budget.budgetStopKind,
    budgetProjectedNextCallTokens: budget.budgetProjectedNextCallTokens,
    estimatedTokensSpent, tokenBudget, rebuildAtResult,
    settings: { resultCount, rebuildTokens, tokenBudget, sessionId },
  });
  return Object.freeze({
    arm: "inline", messages, baselineMessages, blocks, untouched, decisions,
    rebuild, tablePass, depthBefore, depthAfterRebuild, depthAfter, finalDepth,
    turns, finalSurface, tokenBudget, estimatedTokensSpent, stoppedAtBudget,
    ...budget, landedResults,
    rebuildCount, rebuildAtResult, settings: report.settings, report,
  });
}

/** Backwards-compatible name: the inline arm is the harness's original run. */
export function runInlineAsk(options = {}) {
  return runInlineArm(options);
}

/**
 * The table-only arm: the same world, no blocks, one table pass at the bar over
 * every eligible result landed so far, then the run continues to the end.
 */
export function runTableOnlyArm({
  resultCount = 72, rebuildTokens = INLINE_REBUILD_TOKENS,
  tokenBudget = SIM_TOKEN_BUDGET, sessionId = "racoons-inline-ask-harness",
} = {}) {
  assertSettings({ resultCount, rebuildTokens, tokenBudget });
  const world = syntheticSurfaceOf({ resultCount });
  const baselineMessages = plainSurfaceOf(world);
  let messages = [{ ...world.messages[0] }];
  const untouched = [];
  const eligibleIndexes = new Set();
  for (const candidate of world.results) {
    const probe = appendInlineBlockOf({
      role: "user", seq: candidate.seq, kind: "tool-result", text: candidate.text,
    }, candidate.index, {
      isError: false, lineCount: candidate.lineCount,
    });
    if (probe.block === null || probe.block === undefined) {
      untouched.push({ index: candidate.index, reason: untouchedReasonOf(candidate.text) });
    } else {
      eligibleIndexes.add(candidate.index);
    }
  }
  let tablePass = null;
  let depthBefore = null;
  let depthAfter = null;
  let tableAtResult = null;
  let estimatedTokensSpent = 0;
  let stoppedAtBudget = false;
  let budgetProjectedNextCallTokens = null;
  let landedResults = 0;

  for (const result of world.results) {
    messages.push({ role: "user", seq: result.seq, kind: "tool-result", text: result.text });
    messages.push({
      role: "assistant", seq: result.assistantSeq, text: continuationOf(result.index),
    });
    landedResults += 1;
    const depthAtTurn = estimatedTokensOf(totalBytesOf(messages));
    if (estimatedTokensSpent + depthAtTurn >= tokenBudget) {
      stoppedAtBudget = true;
      budgetProjectedNextCallTokens = depthAtTurn;
      break;
    }
    estimatedTokensSpent += depthAtTurn
      + estimatedTokensOf(Buffer.byteLength(continuationOf(result.index), "utf8"));
    if (tablePass === null && estimatedTokensOf(totalBytesOf(messages)) >= rebuildTokens) {
      depthBefore = estimatedTokensOf(totalBytesOf(messages));
      tableAtResult = result.index;
      const rows = [];
      for (const earlier of world.results) {
        if (earlier.seq > result.seq) break;
        if (!eligibleIndexes.has(earlier.index)) continue;
        const lines = linesOf(earlier.text);
        rows.push({
          index: earlier.index, seq: earlier.seq, call: "tool result",
          lineCount: lines.length, anchorLines: anchorsFor(lines),
        });
      }
      tablePass = applyTablePass({
        messages, rows, estimatedTokensSpent, tokenBudget, sessionId, label: "table-only",
      });
      messages = tablePass.messages;
      estimatedTokensSpent = tablePass.estimatedTokensSpent;
      depthAfter = estimatedTokensOf(totalBytesOf(messages));
      if (tablePass.skippedForBudget === true) {
        stoppedAtBudget = true;
        budgetProjectedNextCallTokens = tablePass.projectedNextCallTokens ?? null;
      }
    }
  }

  const finalDepth = estimatedTokensOf(totalBytesOf(messages));
  const tableDecisions = tablePass?.parsedDecisions ?? [];
  const finalSurface = finalSurfaceCheckOf({ messages, blocks: [], decisions: [] });
  const counts = decisionCountsOf(tableDecisions);
  const budget = budgetRecordOf({
    estimatedTokensSpent, tokenBudget, stoppedAtBudget, budgetProjectedNextCallTokens,
  });
  const { endedBy } = budget;
  const turns = turnsOf({
    messages, baselineMessages, tablePass, decisions: [], landedResults,
    endedBy, budgetReached: budget.budgetReached,
  });
  const bytes = byteStatsOf({ blocks: [], blockRecords: [], decisions: [], rebuild: null, tablePass });
  const receipts = receiptsOf([tablePass?.apply]);
  const recall = recallOf([tablePass?.apply]);
  const restore = restoreCheckOf({ recallEntries: recallEntriesOf([tablePass?.apply]), world });
  const report = armReportOf({
    arm: "table-only", world, messages, baselineMessages, blocks: [], decisions: tableDecisions,
    untouched, rebuild: null, tablePass, depthBefore, depthAfterRebuild: null, depthAfter,
    finalDepth, counts, turns, bytes, receipts, recall, restore, finalSurface, endedBy,
    budgetEnforced: budget.budgetEnforced, budgetReached: budget.budgetReached,
    budgetExceeded: budget.budgetExceeded,
    budgetOvershootTokens: budget.budgetOvershootTokens,
    budgetStopKind: budget.budgetStopKind,
    budgetProjectedNextCallTokens: budget.budgetProjectedNextCallTokens,
    estimatedTokensSpent, tokenBudget, rebuildAtResult: tableAtResult,
    settings: { resultCount, rebuildTokens, tokenBudget, sessionId },
  });
  return Object.freeze({
    arm: "table-only", messages, baselineMessages, blocks: [], untouched, decisions: tableDecisions,
    rebuild: null, tablePass, depthBefore, depthAfterRebuild: null, depthAfter, finalDepth,
    turns, finalSurface, tokenBudget, estimatedTokensSpent, stoppedAtBudget,
    ...budget, landedResults,
    rebuildCount: 0, rebuildAtResult: tableAtResult, settings: report.settings, report,
  });
}

/**
 * One table pass: the 40 percent `jsonl-20-nokeepall` ask over `rows`, a
 * deterministic stub answer, the grammar's own reader, and the same
 * `rebuildSurface` shape/plan path the rebuild uses. The ask and answer
 * messages are not persisted in the surface (the product's rewind), but the
 * turn is counted: `turns: 1`, `requests: 1`.
 */
export function applyTablePass({
  messages, rows, estimatedTokensSpent = 0, tokenBudget = SIM_TOKEN_BUDGET,
  sessionId = "racoons-inline-ask-harness", label = "table",
}) {
  if (!Array.isArray(rows)) throw new RangeError("a table pass needs an array of rows");
  if (rows.length === 0) {
    return Object.freeze({
      label, fired: false, reason: "no-rows", messages, estimatedTokensSpent,
      turns: 0, requests: 0, rows: 0, decisions: Object.freeze([]),
      parsedDecisions: Object.freeze([]),
    });
  }
  const prompt = bigTableAskOf(rows);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const answerText = stubTableAnswerOf(rows);
  const answerBytes = Buffer.byteLength(answerText, "utf8");
  const depthBefore = estimatedTokensOf(totalBytesOf(messages));
  const estimate = depthBefore + estimatedTokensOf(promptBytes) + estimatedTokensOf(answerBytes);
  if (estimatedTokensSpent + estimate >= tokenBudget) {
    return Object.freeze({
      label, fired: false, reason: "token-budget", skippedForBudget: true, messages,
      estimatedTokensSpent, projectedNextCallTokens: estimate,
      turns: 0, requests: 0, rows: rows.length,
      decisions: Object.freeze([]), parsedDecisions: Object.freeze([]),
    });
  }
  const lineCounts = new Map(rows.map(row => [row.index, row.lineCount]));
  const byIndex = new Map(rows.map(row => [row.index, row]));
  const parsed = answerRowsOf(answerText, rows.map(row => row.index), TABLE_GRAMMAR, {
    lineCounts,
  });
  const parsedDecisions = parsed.map(row => Object.freeze({
    index: row.index,
    seq: byIndex.get(row.index)?.seq ?? null,
    status: row.status,
    action: row.status === "answered" ? row.answer.action : null,
    summary: row.status === "answered" ? row.answer.summary : null,
    ranges: row.status === "answered" ? row.answer.ranges : null,
    keepAll: row.status === "answered"
      && keepsWholeOf(row.answer, lineCounts.get(row.index)),
    code: row.status === "refused" ? row.code : null,
    source: "table",
  }));
  const decisions = parsedDecisions.filter(row => row.status === "answered")
    .map(row => tableDecisionOf(row, byIndex.get(row.index), lineCounts.get(row.index)));
  const apply = decisions.length === 0
    ? null : rebuildSurface(messages, decisions, { blocks: [], sessionId });
  const afterMessages = apply === null ? messages : messagesOf(apply);
  const depthAfter = estimatedTokensOf(totalBytesOf(afterMessages));
  const fortyPercent = prompt.includes("keep at most 40 percent");
  const seventyPercent = prompt.includes("keep at most 70 percent");
  return Object.freeze({
    label, fired: true, skippedForBudget: false,
    grammar: TABLE_GRAMMAR,
    variant: "later",
    shareLine: TABLE_SHARE_LINE,
    fortyPercent,
    seventyPercent,
    turns: 1,
    requests: 1,
    rows: rows.length,
    promptBytes,
    answerBytes,
    prompt,
    answerText,
    parsed,
    parsedDecisions: Object.freeze(parsedDecisions),
    decisions: Object.freeze(decisions),
    apply,
    messages: afterMessages,
    depthBefore,
    depthAfter,
    estimatedTokensSpent: estimatedTokensSpent + estimate,
    applied: (apply?.plan?.forgets?.length ?? 0) + (apply?.plan?.keeplines?.length ?? 0),
    kept: apply?.plan?.keeps?.length ?? 0,
    refusals: parsedDecisions.filter(row => row.status === "refused").length
      + nonCarriedRefusalsOf(apply).length,
  });
}

/** The rows the inline rebuild leaves undecided: every refused decision. */
function rowsOfRefused(decisions, messages) {
  const bySeq = new Map(messages.map(message => [message.seq, message]));
  const rows = [];
  for (const decision of decisions) {
    if (decision.status !== "refused" || decision.seq === null) continue;
    const text = bySeq.get(decision.seq)?.text ?? "";
    const lines = linesOf(text);
    if (lines.length === 0) continue;
    rows.push({
      index: decision.index, seq: decision.seq, call: "tool result",
      lineCount: lines.length, anchorLines: anchorsFor(lines),
    });
  }
  return rows;
}

/** One parsed inline record, with the address, the artifact spans, and the answer line. */
function decisionOf(parsed, { index, seq, answerSeq, assistantText, answerLineText, lineCount }) {
  const span = parsed.span ?? null;
  const artifactPairs = Array.isArray(parsed.spans) ? parsed.spans : [];
  const artifactSpans = artifactPairs.map(pair => Array.isArray(pair)
    ? [pair[0], pair[1]] : [pair?.start, pair?.end])
    .filter(pair => Number.isSafeInteger(pair[0]) && Number.isSafeInteger(pair[1]));
  const ranges = rangesOf(parsed);
  const action = parsed.action ?? null;
  // The rebuild reads `decision.answer` for the artifact spans (the tagged line
  // and its separator); `seq` there is the ASSISTANT message, not the result.
  const answer = artifactSpans.length === 0 && span === null ? null : {
    seq: answerSeq,
    ...(span === null ? {} : { start: span.start, end: span.end }),
    text: parsed.text ?? null,
    spans: artifactSpans,
  };
  return Object.freeze({
    index,
    seq,
    answerSeq,
    status: parsed.status,
    action,
    summary: parsed.summary ?? null,
    ranges,
    keepAll: parsed.keepAll === true
      || (parsed.status === "answered" && action !== null
        && keepsWholeOf({ action, ranges }, lineCount)),
    code: parsed.code ?? null,
    message: parsed.message ?? null,
    span: span === null ? null : {
      seq: answerSeq, start: span.start, end: span.end,
      text: typeof span.text === "string" ? span.text : null,
    },
    answer,
    answerText: span === null
      ? null : assistantText.slice(span.start, span.end),
    answerLineText: answerLineText ?? null,
    answerLineBytes: answerLineText === null ? 0 : Buffer.byteLength(answerLineText, "utf8"),
    source: "inline",
  });
}

/** One table answer as a decision the rebuild's shape/plan path reads. */
function tableDecisionOf(row, unit, lineCount) {
  const ranges = Array.isArray(row.ranges) ? row.ranges : [];
  return Object.freeze({
    index: row.index,
    seq: unit?.seq ?? row.seq ?? null,
    answerSeq: null,
    status: "answered",
    action: row.action,
    summary: row.summary,
    ranges,
    keepAll: keepsWholeOf({ action: row.action, ranges }, lineCount),
    code: null,
    message: null,
    span: null,
    answer: null,
    answerText: null,
    answerLineText: null,
    answerLineBytes: 0,
    source: "table",
  });
}

/** The stub's next-turn answer line, deterministic by index; null means none. */
function stubVerdictOf(index, lineCount) {
  const tag = answerTagOf(index);
  const kind = index % 6;
  if (kind === 0) {
    return `${tag}{"${String(index)}":{"forgetall":true,`
      + `"summary":"stale build log ${String(index)}"}}`;
  }
  if (kind === 1) {
    const end = Math.min(3, lineCount);
    return `${tag}{"${String(index)}":{"keeplines":[[2,${String(end)}]],`
      + `"summary":"the config keys ${String(index)}"}}`;
  }
  if (kind === 2) return `${tag}{"${String(index)}":{"keepall":true}}`;
  if (kind === 3) {
    return `${tag}{"${String(index)}":{"forgetall":"not true",`
      + `"summary":"broken ${String(index)}"}}`;
  }
  if (kind === 4) return null;
  return `${tag}{"${String(index)}":{"keeplines":[[1,${String(lineCount)}]],`
    + `"summary":"all kept ${String(index)}"}}`;
}

/** The table stub's one-line-per-row answer; every row is answered validly. */
function stubTableAnswerOf(rows) {
  return rows.map(row => {
    const kind = row.index % 4;
    if (kind === 0) {
      return `{"${String(row.index)}":{"forgetall":true,`
        + `"summary":"table forget ${String(row.index)}"}}`;
    }
    if (kind === 1) {
      return `{"${String(row.index)}":{"keeplines":[[1,${String(Math.min(2, row.lineCount))}]],`
        + `"summary":"table keep two ${String(row.index)}"}}`;
    }
    if (kind === 2) {
      return `{"${String(row.index)}":{"keeplines":[[1,${String(row.lineCount)}]],`
        + `"summary":"all kept ${String(row.index)}"}}`;
    }
    const end = Math.max(1, Math.floor(row.lineCount / 4));
    return `{"${String(row.index)}":{"keeplines":[[1,${String(end)}]],`
      + `"summary":"table keep a quarter ${String(row.index)}"}}`;
  }).join("\n");
}

/** The synthetic body: `lines` lines of about 400 bytes each, index-labelled. */
function syntheticResultOf(index, lines) {
  return Array.from({ length: lines }, (_, at) =>
    `result ${String(index)} line ${String(at + 1)}: `
    + `alpha-${String(index)}-${String(at + 1)} `
    + "the build, the test and the deploy stay in this transcript line; ".repeat(6)).join("\n");
}

/** The prewritten assistant turn the inline verdict rides. */
function continuationOf(index) {
  return `Continuing after result ${String(index)}.`;
}

/** The append helper's new-contract text, or a named failure. */
function appendedTextOf(appended, original) {
  if (typeof appended?.text === "string") return appended.text;
  if (typeof appended?.message?.text === "string") return appended.message.text;
  throw new Error("appendInlineBlockOf did not return the {text, block, registryEntry} contract");
}

/** The rebuild helper's new-contract messages. */
function messagesOf(rebuild) {
  if (rebuild === null || rebuild === undefined) return null;
  if (!Array.isArray(rebuild.messages)) {
    throw new Error("rebuildSurface did not return the {messages, ...} contract");
  }
  return rebuild.messages.map(message => ({ ...message }));
}

/** Why an untouched result was untouched, for the record. */
function untouchedReasonOf(text) {
  return Buffer.byteLength(String(text), "utf8") < INLINE_FLOOR_BYTES
    ? "below-floor" : "ineligible";
}

/** The parsed answer's LINE ranges, as `{from, to}` objects (not artifact spans). */
function rangesOf(parsed) {
  const raw = parsed?.ranges;
  if (!Array.isArray(raw)) return [];
  const ranges = [];
  for (const range of raw) {
    const from = Array.isArray(range) ? range[0] : range?.from;
    const to = Array.isArray(range) ? range[1] : range?.to;
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to)) {
      ranges.push({ from, to });
    }
  }
  return ranges;
}

/** The decision counts, the keepall breakdown and the refusal code map. */
function decisionCountsOf(decisions) {
  const counts = { forgetall: 0, keeplines: 0, keepall: 0, refused: 0 };
  const keepallBreakdown = { fullRangeKeeplines: 0, literalKeepallRefused: 0 };
  const refusalsByCode = {};
  for (const decision of decisions) {
    if (decision.status === "refused") {
      counts.refused += 1;
      const code = typeof decision.code === "string" ? decision.code : "unknown";
      refusalsByCode[code] = (refusalsByCode[code] ?? 0) + 1;
      if (typeof decision.answerLineText === "string"
        && decision.answerLineText.includes('"keepall":true')) {
        keepallBreakdown.literalKeepallRefused += 1;
      }
    } else if (decision.action === "keeplines" && decision.keepAll === true) {
      counts.keepall += 1;
      keepallBreakdown.fullRangeKeeplines += 1;
    } else if (decision.action === "keeplines") {
      counts.keeplines += 1;
    } else if (decision.action === "forgetall") {
      counts.forgetall += 1;
    } else {
      counts.refused += 1;
    }
  }
  return { counts, keepallBreakdown, refusalsByCode };
}

/**
 * The budget record, with the replay lane's semantics: one grant, enforced
 * between calls, so the arm's own spend may cross it. `budgetReached` is true
 * only when the spend reached the grant, `budgetExceeded` only when it crossed
 * it. A stop decided BEFORE a call because that call was projected to cross the
 * grant is `token-budget-projected` with `budgetStopKind:"pre-call"` and the
 * projection in `budgetProjectedNextCallTokens`; its own spend stays under the
 * grant, so `budgetReached`/`budgetExceeded` stay false. A stop decided after a
 * call already crossed the grant is `token-budget-after-call` with
 * `budgetStopKind:"after-call"`; that is the only stop the replay lane can
 * reach, where a token-budget stop implies spend >= grant.
 */
function budgetRecordOf({
  estimatedTokensSpent, tokenBudget, stoppedAtBudget = false,
  budgetProjectedNextCallTokens = null,
}) {
  const budgetReached = estimatedTokensSpent >= tokenBudget;
  const budgetExceeded = estimatedTokensSpent > tokenBudget;
  const budgetStopKind = stoppedAtBudget
    ? (budgetReached ? "after-call" : "pre-call") : null;
  const endedBy = budgetStopKind === null
    ? "result-count"
    : (budgetStopKind === "after-call" ? "token-budget-after-call" : "token-budget-projected");
  return Object.freeze({
    budgetEnforced: "between-calls",
    budgetReached,
    budgetExceeded,
    budgetOvershootTokens: Math.max(0, estimatedTokensSpent - tokenBudget),
    budgetStopKind,
    budgetProjectedNextCallTokens: budgetStopKind === "pre-call"
      ? budgetProjectedNextCallTokens : null,
    endedBy,
  });
}

/** The turns object: per-result and rebuild turns are separate, never merged. */
function turnsOf({
  messages, baselineMessages, tablePass, decisions, landedResults = null,
  endedBy = "result-count", budgetReached = null,
}) {
  const inlineTurns = turnCountsOf(messages);
  const baseline = turnCountsOf(baselineMessages);
  // The baseline for THIS run: the system turn plus one result and one
  // assistant turn per result that actually landed. A budget stop leaves the
  // later results unlanded, so the full-world baseline would go negative.
  const baselineForRun = landedResults === null
    ? baselineMessages.length : 1 + 2 * landedResults;
  const perResultExtraTurns = Math.max(0, messages.length - baselineForRun);
  const rebuildExtraTurns = tablePass?.fired === true ? 1 : 0;
  const totalExtraTurns = perResultExtraTurns + rebuildExtraTurns;
  return Object.freeze({
    baseline,
    baselineForRun,
    surface: inlineTurns,
    inline: inlineTurns,
    tableOnly: null,
    perResultExtraTurns,
    rebuildExtraTurns,
    rebuildExtraMessages: tablePass?.fired === true ? 2 : 0,
    tableRequests: tablePass?.fired === true ? 1 : 0,
    totalExtraTurns,
    extraTurns: totalExtraTurns,
    rebuildTurns: tablePass?.fired === true ? 1 : 0,
    extraTurnsVsTableOnly: null,
    stubVerdictLines: decisions.filter(decision =>
      typeof decision.answerLineText === "string").length,
    note: `perResultExtraTurns is ${String(perResultExtraTurns)}: the messages this run`
      + ` appended (the system turn plus one result and one assistant turn per landed`
      + ` result) equal ${String(baselineForRun)}, and the stub adds no turn of its own.`
      + ` endedBy ${endedBy}; budgetReached ${String(budgetReached)}.`
      + " The tokens are a stub estimate (ceil(bytes / 3.04)); no provider was called.",
  });
}

/** The byte accounting: gross removed, gross added, net, and the components. */
function byteStatsOf({
  blocks, blockRecords, decisions, rebuild, tablePass, blocksAtRebuild, decisionsAtRebuild,
}) {
  const bytesAddedByBlocks = blockRecords.reduce((sum, block) => sum + block.bytes, 0);
  const answerLines = decisions.filter(decision =>
    typeof decision.answerLineText === "string");
  const bytesAddedByAnswersText = answerLines.reduce((sum, decision) =>
    sum + Buffer.byteLength(decision.answerLineText, "utf8"), 0);
  const answerSeparatorBytes = answerLines.length;
  const bytesAddedByAnswers = bytesAddedByAnswersText + answerSeparatorBytes;
  const shapedInline = shapedBytesOf(rebuild);
  const shapedTable = shapedBytesOf(tablePass?.apply);
  const bytesAddedByShapedTurns = shapedInline + shapedTable;
  const bytesAddedGross = bytesAddedByBlocks + bytesAddedByAnswers + bytesAddedByShapedTurns;
  const rebuildComponents = removedComponentsOf(rebuild);
  const tableComponents = removedComponentsOf(tablePass?.apply);
  const components = Object.freeze({
    blocks: (rebuildComponents?.blocks ?? 0) + (tableComponents?.blocks ?? 0),
    answers: (rebuildComponents?.answers ?? 0) + (tableComponents?.answers ?? 0),
    results: (rebuildComponents?.results ?? 0) + (tableComponents?.results ?? 0),
    total: (rebuildComponents?.total ?? 0) + (tableComponents?.total ?? 0),
    shapedAdded: bytesAddedByShapedTurns,
    reported: rebuildComponents !== null || tableComponents !== null,
  });
  const bytesRemovedGrossAtRebuild = numberOrNull(rebuild?.bytesRemovedGross);
  const bytesRemovedGrossAtTablePass = numberOrNull(tablePass?.apply?.bytesRemovedGross);
  const bytesRemovedGross = (bytesRemovedGrossAtRebuild ?? 0)
    + (bytesRemovedGrossAtTablePass ?? 0);
  const netBytesRemoved = bytesRemovedGross - bytesAddedGross;
  const reportedNet = numberOrNull(rebuild?.netBytesRemoved) === null
    ? numberOrNull(tablePass?.apply?.netBytesRemoved)
    : (rebuild?.netBytesRemoved ?? 0) + (tablePass?.apply?.netBytesRemoved ?? 0);
  const expected = expectedRemovedBytesOf({
    rebuild, tablePass, blockRecords, blocksAtRebuild, decisionsAtRebuild,
  });
  return Object.freeze({
    blocksAppended: blocks.length,
    bytesAddedByBlocks,
    bytesAddedByAnswers,
    bytesAddedByAnswersText,
    bytesAddedByAnswerSeparators: answerSeparatorBytes,
    bytesAddedByShapedTurns,
    bytesAddedGross,
    bytesRemovedGrossAtRebuild,
    bytesRemovedGrossAtTablePass,
    bytesRemovedGross,
    netBytesRemoved,
    reportedNetBytesRemoved: reportedNet,
    rebuildBytesAddedByBlocks: numberOrNull(rebuild?.bytesAddedByBlocks),
    components,
    componentsReconcile: components.reported === true
      ? components.blocks + components.answers + components.results === components.total
      : null,
    expectedRemovedBytes: expected === null ? null : expected.total,
    expectedComponents: expected,
    blockResidual: expected === null ? null : components.blocks - expected.blocks,
    answerSeparatorResidual: expected === null ? null : components.answers - expected.answers,
    resultsResidual: expected === null ? null : components.results - expected.results,
    grossComponentResidual: components.reported === true
      ? components.total - (components.blocks + components.answers + components.results)
      : null,
    equation: "netBytesRemoved = bytesRemovedGross - bytesAddedGross",
    note: "answers count their leading separator newline; a block carries its own"
      + " separator newline. A tail after the one trigger keeps its blocks and answers,"
      + " so bytesAddedGross includes bytes the rebuild did not remove. The components"
      + " cover only the bytes present at the trigger.",
  });
}

/** The removed-byte components lane A's rebuild returns, or null when absent. */
function removedComponentsOf(rebuild) {
  if (rebuild === null || rebuild === undefined) return null;
  const blocks = numberOrNull(rebuild.bytesRemovedByBlocks);
  const answers = numberOrNull(rebuild.bytesRemovedByAnswers);
  const results = numberOrNull(rebuild.bytesRemovedByResults);
  const total = numberOrNull(rebuild.bytesRemovedGross);
  if (blocks === null && answers === null && results === null && total === null) return null;
  return Object.freeze({
    blocks: blocks ?? 0, answers: answers ?? 0, results: results ?? 0, total: total ?? 0,
  });
}

/** The removed-byte components one trigger should add up to, from the plan. */
function expectedRemovedBytesOf({
  rebuild, tablePass, blockRecords, blocksAtRebuild, decisionsAtRebuild,
}) {
  if (rebuild === null && (tablePass?.apply === null || tablePass?.apply === undefined)) {
    return null;
  }
  const rebuiltSeqs = new Set((blocksAtRebuild ?? []).map(block => block.seq));
  const blockBytes = rebuild === null ? 0 : blockRecords
    .filter(block => rebuiltSeqs.has(block.seq))
    .reduce((sum, block) => sum + block.bytes, 0);
  const answerBytes = (decisionsAtRebuild ?? [])
    .filter(decision => decision.answer !== null
      && typeof decision.answerLineText === "string")
    .reduce((sum, decision) => sum + decision.answerLineBytes + 1, 0);
  const inlineResults = shapedEntriesOf(rebuild)
    .reduce((sum, entry) => sum + (entry.bytesRemoved ?? 0), 0);
  const tableResults = shapedEntriesOf(tablePass?.apply)
    .reduce((sum, entry) => sum + (entry.bytesRemoved ?? 0), 0);
  return Object.freeze({
    blocks: blockBytes,
    answers: answerBytes,
    results: inlineResults + tableResults,
    shapedAdded: shapedBytesOf(rebuild) + shapedBytesOf(tablePass?.apply),
    total: blockBytes + answerBytes + inlineResults + tableResults,
  });
}

/** The shaped-turn byte count: the product's rendered body, not the removed text. */
function shapedBytesOf(rebuild) {
  if (rebuild === null || rebuild === undefined) return 0;
  const entries = shapedEntriesOf(rebuild);
  let total = 0;
  for (const entry of entries) {
    const text = entry?.shapedText ?? entry?.text ?? entry?.shaped;
    if (typeof text === "string") total += Buffer.byteLength(text, "utf8");
    else if (text instanceof Uint8Array) total += text.length;
  }
  return total;
}

/** The applied plan entries (forgets and keeplines) of one rebuild. */
function shapedEntriesOf(rebuild) {
  if (rebuild === null || rebuild === undefined) return [];
  const plan = rebuild.plan ?? {};
  return [...(plan.forgets ?? []), ...(plan.keeplines ?? [])];
}

/** The receipts one rebuild minted. */
function receiptsOf(rebuilds) {
  const receipts = [];
  for (const rebuild of rebuilds) {
    if (rebuild === null || rebuild === undefined) continue;
    if (Array.isArray(rebuild.receipts)) receipts.push(...rebuild.receipts);
    else {
      for (const entry of shapedEntriesOf(rebuild)) {
        if (entry.receipt !== undefined) receipts.push(entry.receipt);
      }
    }
  }
  return Object.freeze({
    count: receipts.length,
    receipts: Object.freeze(receipts.map(receipt => typeof receipt === "string"
      ? receipt : JSON.parse(JSON.stringify(receipt)))),
  });
}

/** The recall entries one rebuild minted, without their original bytes. */
function recallOf(rebuilds) {
  const entries = recallEntriesOf(rebuilds);
  return Object.freeze({
    count: entries.length,
    entries: Object.freeze(entries.map(entry => Object.freeze({
      recallId: entry.recallId, index: entry.index ?? null, seq: entry.seq ?? null,
      bytes: entry.bytes ?? null, sha256: entry.sha256 ?? null,
    }))),
  });
}

/** The raw recall entries (they may carry the original bytes). */
function recallEntriesOf(rebuilds) {
  const entries = [];
  for (const rebuild of rebuilds) {
    if (rebuild === null || rebuild === undefined) continue;
    if (Array.isArray(rebuild.recall)) entries.push(...rebuild.recall);
    else if (Array.isArray(rebuild.plan?.recall)) entries.push(...rebuild.plan.recall);
  }
  return entries;
}

/** Restore the first recall entry and compare it with the original bytes. */
function restoreCheckOf({ recallEntries, world }) {
  if (recallEntries.length === 0) return Object.freeze({ checked: 0, ok: null });
  const entry = recallEntries[0];
  const textBySeq = new Map(world.results.map(result => [result.seq, result.text]));
  const expectedText = entry.originalText ?? textBySeq.get(entry.seq) ?? "";
  const expected = Buffer.from(String(expectedText), "utf8");
  try {
    const restored = restoreFromRecall(entry);
    const bytes = restoredBytesOf(restored);
    if (bytes === null) {
      return Object.freeze({
        checked: 1, ok: false, recallId: entry.recallId,
        error: "restoreFromRecall returned an unreadable value",
      });
    }
    return Object.freeze({
      checked: 1, ok: Buffer.compare(bytes, expected) === 0,
      recallId: entry.recallId, restoredBytes: bytes.length, expectedBytes: expected.length,
    });
  } catch (error) {
    return Object.freeze({
      checked: 1, ok: false, recallId: entry.recallId,
      error: error?.message ?? String(error),
    });
  }
}

/** A restored value's bytes: Buffer, Uint8Array, string, or a `{bytes|text}` object. */
function restoredBytesOf(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value !== null && typeof value === "object") {
    for (const key of ["bytes", "originalBytes", "data"]) {
      if (value[key] instanceof Uint8Array) return Buffer.from(value[key]);
    }
    for (const key of ["text", "originalText"]) {
      if (typeof value[key] === "string") return Buffer.from(value[key], "utf8");
    }
  }
  return null;
}

/**
 * The final-surface check: count the blocks and answers still on the surface
 * after the run, reconcile them with the trigger's removals, and name any
 * orphan answer tag. The tail after the one trigger is reported, never hidden.
 */
function finalSurfaceCheckOf({ messages, blocks, decisions }) {
  const bySeq = new Map(messages.map(message => [message.seq, message]));
  const remainingBlockSeqs = [];
  for (const entry of blocks) {
    const message = bySeq.get(entry.seq);
    if (message !== undefined && typeof message.text === "string"
      && message.text.endsWith(entry.block)) {
      remainingBlockSeqs.push(entry.seq);
    }
  }
  const answerLines = decisions.filter(decision =>
    typeof decision.answerLineText === "string");
  const remainingAnswerIndexes = [];
  for (const decision of answerLines) {
    const assistant = bySeq.get(decision.answerSeq);
    if (assistant !== undefined && typeof assistant.text === "string"
      && assistant.text.includes(decision.answerLineText)) {
      remainingAnswerIndexes.push(decision.index);
    }
  }
  const tagPattern = /\[\[inline-answer:([^\]\n]+)\]\]/gu;
  const answerTagsSeen = [];
  const orphanAnswerTags = [];
  const decisionByIndex = new Map(decisions.map(decision => [decision.index, decision]));
  for (const message of messages) {
    if (message?.role !== "assistant" || typeof message.text !== "string") continue;
    for (const match of message.text.matchAll(tagPattern)) {
      const key = match[1];
      if (key === "example") continue;
      answerTagsSeen.push(key);
      const decision = decisionByIndex.get(Number(key));
      if (decision === undefined || decision.answerSeq !== message.seq) {
        orphanAnswerTags.push({ seq: message.seq, tag: key });
      }
    }
  }
  const blocksRemaining = remainingBlockSeqs.length;
  const answersRemaining = remainingAnswerIndexes.length;
  const blocksRemoved = blocks.length - blocksRemaining;
  const answersRemoved = answerLines.length - answersRemaining;
  const answerTagCountMatches = answerTagsSeen.length === answersRemaining;
  const blocksReconciled = blocksRemoved + blocksRemaining === blocks.length;
  const answersReconciled = answersRemoved + answersRemaining === answerLines.length;
  const ledgerReconciles = blocksReconciled && answersReconciled
    && answerTagCountMatches && orphanAnswerTags.length === 0;
  const cleanSurface = blocksRemaining === 0 && answersRemaining === 0;
  const surfacesMatchPolicyReason = cleanSurface && ledgerReconciles
    ? "clean" : (cleanSurface ? "ledger-mismatch" : "tail-unpruned-by-single-trigger");
  return Object.freeze({
    blocksRemaining,
    answersRemaining,
    blocksRemovedBySurface: blocksRemoved,
    answersRemovedBySurface: answersRemoved,
    blocksReconciled,
    answersReconciled,
    answerTagCountMatches,
    ledgerReconciles,
    cleanSurface,
    // Aligned with the replay lane's `reconciliation.ok`: a surface that still
    // holds any block or answer is not ok, even when every count reconciles.
    ok: cleanSurface && ledgerReconciles,
    surfacesMatchPolicy: surfacesMatchPolicyReason === "clean",
    surfacesMatchPolicyReason,
    policyNote: "ok is false whenever any block or answer remains on the surface."
      + " The post-rebuild tail is unpruned by the single-trigger policy: one"
      + " rebuild is allowed and a second is not, so blocks and answers that"
      + " landed after the trigger stay. Their counts are blocksRemaining and"
      + " answersRemaining; the ledger still reconciles them.",
    answerTagsSeen: Object.freeze(answerTagsSeen),
    blockMarkerOccurrences: countOf(
      messages.map(message => message?.text ?? "").join("\n"), INLINE_MARKER),
    orphanAnswerTags: Object.freeze(orphanAnswerTags),
    remainingBlockSeqs: Object.freeze(remainingBlockSeqs),
    remainingAnswerIndexes: Object.freeze(remainingAnswerIndexes),
  });
}

/** The report one arm writes; every accounting field the plan requires is here. */
function armReportOf({
  arm, world, messages, blocks, decisions, untouched, rebuild,
  tablePass, depthBefore, depthAfterRebuild, depthAfter, finalDepth, counts, turns,
  bytes, receipts, recall, restore, finalSurface, endedBy, estimatedTokensSpent,
  budgetEnforced, budgetReached, budgetExceeded, budgetOvershootTokens,
  budgetStopKind, budgetProjectedNextCallTokens,
  tokenBudget, rebuildAtResult, settings,
}) {
  const answerLines = decisions.filter(decision =>
    typeof decision.answerLineText === "string");
  const rebuildRefusals = nonCarriedRefusalsOf(rebuild);
  const tableParsed = tablePass?.parsedDecisions ?? [];
  const tableParseRefusals = tableParsed.filter(row => row.status === "refused");
  const tablePlanRefusals = nonCarriedRefusalsOf(tablePass?.apply);
  // `counts` covers the INLINE decision log; for the table-only arm that log is
  // the table's parsed rows, whose refusals are counted once below. Never add
  // the same table refusal to both ledgers.
  const inlineParseRefusalCount = arm === "inline" ? counts.counts.refused : 0;
  const inlineParseRefusalCodes = arm === "inline" ? counts.refusalsByCode : {};
  const refusalsByCode = mergeCodeCounts(
    inlineParseRefusalCodes,
    codeCountsOf(rebuildRefusals),
    codeCountsOf(tableParseRefusals),
    codeCountsOf(tablePlanRefusals),
  );
  const rebuiltMessages = rebuild === null ? null : messagesOf(rebuild);
  const finalTurns = turns;
  return Object.freeze({
    schema: PILOT_SCHEMA,
    arm,
    provider: STUB_PROVIDER,
    billable: false,
    citable: false,
    syntheticSurface: true,
    tokenAccounting: TOKEN_ACCOUNTING,
    stubProfile: stubProfileOf({ arm, world, decisions, tablePass }),
    settings: Object.freeze({
      resultCount: settings.resultCount,
      rebuildTokens: settings.rebuildTokens,
      tokenBudget: settings.tokenBudget,
      sessionId: settings.sessionId,
      floor: INLINE_FLOOR_BYTES,
      marker: INLINE_MARKER,
      answerTag: "[[inline-answer:<index>]]",
      tableGrammar: TABLE_GRAMMAR,
      tableShareLine: TABLE_SHARE_LINE,
      timerMs: 0,
      askCeiling: 0,
    }),
    caps: Object.freeze({
      tokenBudget,
      timerMs: 0,
      askCeiling: 0,
      onlyCap: "token budget",
      timer: "none",
      timerLabel: "none (0 = not armed)",
      ceiling: "none",
      ceilingLabel: "none (0 = not armed)",
      note: "the token budget is the only cap; no wall-clock timer and no ask"
        + " ceiling were armed",
    }),
    endedBy,
    budgetEnforced,
    budgetReached,
    budgetExceeded,
    budgetOvershootTokens,
    budgetStopKind,
    budgetProjectedNextCallTokens,
    blocksAppended: blocks.length,
    blocksRemoved: rebuild?.blocksRemoved ?? 0,
    blocksRemaining: finalSurface.blocksRemaining,
    answersAppended: answerLines.length,
    answersRemoved: rebuild?.answersRemoved ?? 0,
    answersRemaining: finalSurface.answersRemaining,
    answersParsed: arm === "inline"
      ? decisions.filter(decision => decision.status === "answered").length : 0,
    tableAnswersParsed: tablePass?.decisions?.length ?? 0,
    refusals: inlineParseRefusalCount + rebuildRefusals.length
      + tableParseRefusals.length + tablePlanRefusals.length,
    parseRefusals: inlineParseRefusalCount,
    rebuildRefusals: rebuildRefusals.length,
    tableParseRefusals: tableParseRefusals.length,
    tablePlanRefusals: tablePlanRefusals.length,
    refusalsByCode: Object.freeze(refusalsByCode),
    refusalsBySource: Object.freeze({
      inlineParse: Object.freeze({ ...inlineParseRefusalCodes }),
      rebuild: Object.freeze(codeCountsOf(rebuildRefusals)),
      tableParse: Object.freeze(codeCountsOf(tableParseRefusals)),
      tablePlan: Object.freeze(codeCountsOf(tablePlanRefusals)),
    }),
    decisionsByAction: Object.freeze({ ...counts.counts }),
    keepallBreakdown: Object.freeze({
      fullRangeKeeplines: counts.keepallBreakdown.fullRangeKeeplines,
      literalKeepallRefused: counts.keepallBreakdown.literalKeepallRefused,
      label: "decisionsByAction.keepall counts full-range keeplines (accepted keep-all);"
        + " literal {\"keepall\":true} answers are refused and counted in"
        + " literalKeepallRefused and refusalsByCode",
    }),
    decisions: Object.freeze({
      total: decisions.length,
      answered: decisions.filter(decision => decision.status === "answered").length,
      refused: decisions.filter(decision => decision.status === "refused").length,
      noAnswerLines: decisions.filter(decision =>
        typeof decision.answerLineText !== "string").length,
      applied: (rebuild?.plan?.forgets?.length ?? 0)
        + (rebuild?.plan?.keeplines?.length ?? 0)
        + (tablePass?.apply?.plan?.forgets?.length ?? 0)
        + (tablePass?.apply?.plan?.keeplines?.length ?? 0),
      kept: (rebuild?.plan?.keeps?.length ?? 0)
        + (tablePass?.apply?.plan?.keeps?.length ?? 0),
      inlineApplied: (rebuild?.plan?.forgets?.length ?? 0)
        + (rebuild?.plan?.keeplines?.length ?? 0),
      inlineKept: rebuild?.plan?.keeps?.length ?? 0,
      tableApplied: (tablePass?.apply?.plan?.forgets?.length ?? 0)
        + (tablePass?.apply?.plan?.keeplines?.length ?? 0),
      tableKept: tablePass?.apply?.plan?.keeps?.length ?? 0,
      log: Object.freeze(decisions.map(decision => Object.freeze({
        index: decision.index, seq: decision.seq, status: decision.status,
        action: decision.action, code: decision.code,
        keepAll: decision.keepAll === true, source: decision.source,
      }))),
    }),
    tablePass: tablePass === null ? null : Object.freeze(tablePassReportOf(tablePass)),
    bytes: Object.freeze({ ...bytes }),
    bytesAddedByBlocks: bytes.bytesAddedByBlocks,
    bytesAddedByAnswers: bytes.bytesAddedByAnswers,
    bytesAddedByShapedTurns: bytes.bytesAddedByShapedTurns,
    bytesAddedGross: bytes.bytesAddedGross,
    bytesRemovedGrossAtRebuild: bytes.bytesRemovedGrossAtRebuild,
    bytesRemovedAtRebuild: bytes.bytesRemovedGrossAtRebuild,
    bytesRemovedGross: bytes.bytesRemovedGross,
    netBytesRemoved: bytes.netBytesRemoved,
    byteReconciliation: Object.freeze({
      equation: bytes.equation,
      netBytesRemoved: bytes.netBytesRemoved,
      bytesRemovedGross: bytes.bytesRemovedGross,
      bytesAddedGross: bytes.bytesAddedGross,
      ok: bytes.netBytesRemoved === bytes.bytesRemovedGross - bytes.bytesAddedGross,
      components: bytes.components,
      componentsReconcile: bytes.componentsReconcile,
      blockResidual: bytes.blockResidual,
      answerSeparatorResidual: bytes.answerSeparatorResidual,
      resultsResidual: bytes.resultsResidual,
      grossComponentResidual: bytes.grossComponentResidual,
      expectedComponents: bytes.expectedComponents,
      rebuildReportedNetBytesRemoved: bytes.reportedNetBytesRemoved,
      note: bytes.note,
    }),
    blocksReconciled: finalSurface.blocksReconciled,
    answersReconciled: finalSurface.answersReconciled,
    finalSurfaceOk: finalSurface.ok,
    surfacesMatchPolicy: finalSurface.surfacesMatchPolicy,
    surfacesMatchPolicyReason: finalSurface.surfacesMatchPolicyReason,
    depthBefore,
    depthAfterRebuild,
    depthAfter,
    depthDelta: depthBefore === null || depthAfter === null ? null : depthAfter - depthBefore,
    finalDepth,
    rebuildCount: rebuild === null ? 0 : 1,
    rebuildAtResult,
    rebuildLedger: Object.freeze({
      blocksAppended: rebuild?.blocksAppended ?? null,
      blocksRemoved: rebuild?.blocksRemoved ?? null,
      blocksRemaining: rebuild?.blocksRemaining ?? null,
      answersRemoved: rebuild?.answersRemoved ?? null,
      answersRemaining: rebuild?.answersRemaining ?? null,
      answerSpansSkipped: rebuild?.answerSpansSkipped ?? null,
      note: "the rebuild snapshot; blocksRemaining/answersRemaining at the top of this"
        + " report are the FINAL surface after the tail",
    }),
    rebuildStillAbove: rebuild === null && tablePass?.fired !== true
      ? null : finalDepth >= settings.rebuildTokens,
    tableStillAbove: tablePass?.fired === true ? finalDepth >= settings.rebuildTokens : null,
    rebuildPolicy: REBUILD_POLICY,
    turns: Object.freeze({
      ...finalTurns,
      tableOnly: null,
      extraTurnsVsTableOnly: null,
    }),
    calls: Object.freeze({
      provider: 0,
      stubVerdictLines: answerLines.length,
      tableRequests: tablePass?.fired === true ? 1 : 0,
      tableAnswers: tablePass?.fired === true ? (tablePass.decisions?.length ?? 0) : 0,
      modelTurns: finalTurns.totalExtraTurns,
      note: "no provider was called; stub verdict lines ride prewritten assistant turns",
    }),
    receipts: Object.freeze({ ...receipts }),
    recall: Object.freeze({ ...recall }),
    restoreCheck: Object.freeze({ ...restore }),
    finalSurface: Object.freeze({
      blocksRemaining: finalSurface.blocksRemaining,
      answersRemaining: finalSurface.answersRemaining,
      blockMarkerOccurrences: finalSurface.blockMarkerOccurrences,
      answerTagsSeen: finalSurface.answerTagsSeen,
      orphanAnswerTags: finalSurface.orphanAnswerTags,
      remainingBlockSeqs: finalSurface.remainingBlockSeqs,
      remainingAnswerIndexes: finalSurface.remainingAnswerIndexes,
      blocksReconciled: finalSurface.blocksReconciled,
      answersReconciled: finalSurface.answersReconciled,
      answerTagCountMatches: finalSurface.answerTagCountMatches,
      ledgerReconciles: finalSurface.ledgerReconciles,
      cleanSurface: finalSurface.cleanSurface,
      ok: finalSurface.ok,
      surfacesMatchPolicy: finalSurface.surfacesMatchPolicy,
      surfacesMatchPolicyReason: finalSurface.surfacesMatchPolicyReason,
      policyNote: finalSurface.policyNote,
      check: "blocksAppended = blocksRemoved + blocksRemaining;"
        + " answersAppended = answersRemoved + answersRemaining; ok is false when any"
        + " block or answer remains, matching the replay lane's reconciliation.ok,"
        + " because the single-trigger policy leaves the post-rebuild tail unpruned",
    }),
    estimatedTokensSpent,
    estimatedTokensSpentNote: "sum of per-turn ceil(bytes / 3.04) depth estimates"
      + " plus output estimates; no provider, not billable",
    tokenBudget,
    timerMs: 0,
    askCeiling: 0,
    untouched,
    untouchedByReason: Object.freeze(countReasons(untouched)),
    rebuiltMessagesDigest: rebuiltMessages === null ? null : digestOfMessages(rebuiltMessages),
    responseSurfaceDigest: digestOfMessages(messages),
    syntheticNote: "This is a synthetic pilot, not the real experiment. The provider is"
      + " none, the surface is synthetic, and the answers are a deterministic stub;"
      + " the run is not citable as a product result.",
  });
}

/** The table pass's report view (no prompt text; its bytes are counted). */
function tablePassReportOf(tablePass) {
  return {
    fired: tablePass.fired === true,
    skippedForBudget: tablePass.skippedForBudget === true,
    reason: tablePass.reason ?? null,
    grammar: tablePass.grammar ?? TABLE_GRAMMAR,
    variant: tablePass.variant ?? "later",
    shareLine: tablePass.shareLine ?? TABLE_SHARE_LINE,
    fortyPercent: tablePass.fortyPercent === true,
    seventyPercent: tablePass.seventyPercent === true,
    turns: tablePass.turns ?? 0,
    requests: tablePass.requests ?? 0,
    rows: tablePass.rows ?? 0,
    answered: (tablePass.decisions?.length ?? 0),
    refused: (tablePass.parsedDecisions ?? []).filter(row => row.status === "refused").length,
    applied: tablePass.applied ?? 0,
    kept: tablePass.kept ?? 0,
    parseOnly: false,
    promptBytes: tablePass.promptBytes ?? 0,
    answerBytes: tablePass.answerBytes ?? 0,
    depthBefore: tablePass.depthBefore ?? null,
    depthAfter: tablePass.depthAfter ?? null,
    bytesRemovedGross: tablePass.apply?.bytesRemovedGross ?? 0,
    netBytesRemoved: tablePass.apply?.netBytesRemoved ?? null,
    receipts: receiptsOf([tablePass.apply]).count,
    recall: recallOf([tablePass.apply]).count,
    decisions: Object.freeze((tablePass.parsedDecisions ?? []).map(row => Object.freeze({
      index: row.index, seq: row.seq, status: row.status,
      action: row.action, code: row.code, keepAll: row.keepAll === true,
    }))),
  };
}

/** The stub profile, per arm: the answer/refusal split is the stub's own. */
function stubProfileOf({ arm, world, decisions, tablePass }) {
  const inlineKinds = { forgetall: 0, keeplines: 0, keepall: 0, malformed: 0, noAnswer: 0, fullRange: 0 };
  if (arm === "inline") {
    for (const result of world.results) {
      if (result.index % 5 === 0) continue;
      const kind = result.index % 6;
      if (kind === 0) inlineKinds.forgetall += 1;
      else if (kind === 1) inlineKinds.keeplines += 1;
      else if (kind === 2) inlineKinds.keepall += 1;
      else if (kind === 3) inlineKinds.malformed += 1;
      else if (kind === 4) inlineKinds.noAnswer += 1;
      else inlineKinds.fullRange += 1;
    }
  }
  const tableKinds = { forgetall: 0, keeplines: 0, fullRange: 0, quarter: 0 };
  for (const row of tablePass?.parsedDecisions ?? []) {
    const kind = row.index % 4;
    if (kind === 0) tableKinds.forgetall += 1;
    else if (kind === 1) tableKinds.keeplines += 1;
    else if (kind === 2) tableKinds.fullRange += 1;
    else tableKinds.quarter += 1;
  }
  return Object.freeze({
    arm,
    inline: Object.freeze({ ...INLINE_STUB_PROFILE, counts: Object.freeze(inlineKinds) }),
    table: Object.freeze({ ...TABLE_STUB_PROFILE, counts: Object.freeze(tableKinds) }),
    note: "The answer/refusal split is the deterministic stub's own profile, not a"
      + " model's and not a parser failure. A real model's split is unknown until a"
      + " paid run.",
  });
}

/** The combined A/B payload: both arms, their depths, bytes, turns and decisions. */
export function pilotReportOf({ inline, tableOnly, resultCount, rebuildTokens, tokenBudget }) {
  const arms = {};
  if (inline !== null && inline !== undefined) arms.inline = inline.report;
  if (tableOnly !== null && tableOnly !== undefined) arms.tableOnly = tableOnly.report;
  const comparison = inline === null || tableOnly === null
    ? null : comparisonOf(inline.report, tableOnly.report);
  const primary = inline !== null && inline !== undefined ? inline.report : tableOnly.report;
  return Object.freeze({
    schema: PILOT_SCHEMA,
    experiment: "inline-ask synthetic pilot: inline arm vs table-only arm",
    claim: "NOT the real experiment: a synthetic stub with no provider; not citable",
    selectedArm: inline !== null && tableOnly !== null
      ? "both" : (tableOnly !== null ? "table-only" : "inline"),
    summaryArm: primary.arm,
    provider: STUB_PROVIDER,
    billable: false,
    citable: false,
    syntheticSurface: true,
    tokenAccounting: TOKEN_ACCOUNTING,
    rebuildPolicy: REBUILD_POLICY,
    // The primary arm's numbers sit at the top level too, so a reader that looks
    // only at the root still sees the budget, the spend, the end reason and the
    // final depth instead of inferring them from a nested arm.
    endedBy: primary.endedBy,
    budgetEnforced: primary.budgetEnforced,
    budgetReached: primary.budgetReached,
    budgetExceeded: primary.budgetExceeded,
    budgetOvershootTokens: primary.budgetOvershootTokens,
    budgetStopKind: primary.budgetStopKind,
    budgetProjectedNextCallTokens: primary.budgetProjectedNextCallTokens,
    blocksAppended: primary.blocksAppended,
    blocksRemoved: primary.blocksRemoved,
    blocksRemaining: primary.blocksRemaining,
    answersAppended: primary.answersAppended,
    answersRemoved: primary.answersRemoved,
    answersRemaining: primary.answersRemaining,
    refusalsByCode: primary.refusalsByCode,
    estimatedTokensSpent: primary.estimatedTokensSpent,
    finalDepth: primary.finalDepth,
    rebuildCount: primary.rebuildCount,
    rebuildStillAbove: primary.rebuildStillAbove,
    netBytesRemoved: primary.netBytesRemoved,
    bytesAddedGross: primary.bytesAddedGross,
    bytesRemovedGross: primary.bytesRemovedGross,
    tablePass: primary.tablePass === null ? null : Object.freeze({
      fired: primary.tablePass.fired,
      rows: primary.tablePass.rows,
      answered: primary.tablePass.answered,
      applied: primary.tablePass.applied,
      kept: primary.tablePass.kept,
      parseOnly: primary.tablePass.parseOnly,
      shareLine: primary.tablePass.shareLine,
      fortyPercent: primary.tablePass.fortyPercent,
      seventyPercent: primary.tablePass.seventyPercent,
      grammar: primary.tablePass.grammar,
    }),
    settings: Object.freeze({
      resultCount, rebuildTokens, tokenBudget,
      floor: INLINE_FLOOR_BYTES, tableGrammar: TABLE_GRAMMAR,
      tableShareLine: TABLE_SHARE_LINE, timerMs: 0, askCeiling: 0,
    }),
    caps: Object.freeze({
      tokenBudget, timerMs: 0, askCeiling: 0,
      onlyCap: "token budget",
      timer: "none",
      timerLabel: "none (0 = not armed)",
      ceiling: "none",
      ceilingLabel: "none (0 = not armed)",
    }),
    arms: Object.freeze(arms),
    comparison,
  });
}

/** The A/B comparison: the two arms side by side, without a product claim. */
function comparisonOf(inline, tableOnly) {
  return Object.freeze({
    statement: "Both arms run the same synthetic world. When a run reaches the trigger"
      + " bar it fires one table pass with the same 40 percent " + TABLE_GRAMMAR
      + " prompt. The inline arm appends a block to each eligible result; the table-only"
      + " arm appends none. This is a synthetic pilot, not the real experiment.",
    depth: Object.freeze({
      inline: Object.freeze({
        before: inline.depthBefore, after: inline.depthAfter,
        final: inline.finalDepth,
      }),
      tableOnly: Object.freeze({
        before: tableOnly.depthBefore, after: tableOnly.depthAfter,
        final: tableOnly.finalDepth,
      }),
      finalDelta: tableOnly.finalDepth - inline.finalDepth,
    }),
    bytes: Object.freeze({
      inline: Object.freeze({
        addedGross: inline.bytesAddedGross,
        removedGross: inline.bytesRemovedGross,
        netRemoved: inline.netBytesRemoved,
      }),
      tableOnly: Object.freeze({
        addedGross: tableOnly.bytesAddedGross,
        removedGross: tableOnly.bytesRemovedGross,
        netRemoved: tableOnly.netBytesRemoved,
      }),
      inlineOverhead: inline.bytesAddedGross - tableOnly.bytesAddedGross,
    }),
    turns: Object.freeze({
      inlineTotal: inline.turns.surface.total,
      tableOnlyTotal: tableOnly.turns.surface.total,
      extraTurnsVsTableOnly: inline.turns.surface.total - tableOnly.turns.surface.total,
      perResultExtraTurns: inline.turns.perResultExtraTurns,
      rebuildExtraTurns: inline.turns.rebuildExtraTurns,
      note: "when both arms reach the trigger they take the same one table pass;"
        + " a budget-stopped run may stop at a different result in each arm."
        + " per-result turns are measured against the messages each run appended (0 for"
        + " this stub); the one table request is counted in rebuildExtraTurns",
    }),
    calls: Object.freeze({
      inline: inline.calls, tableOnly: tableOnly.calls,
    }),
    decisions: Object.freeze({
      inline: Object.freeze({
        total: inline.decisions.total,
        byAction: inline.decisionsByAction,
        refusalsByCode: inline.refusalsByCode,
      }),
      tableOnly: Object.freeze({
        total: tableOnly.decisions.total,
        byAction: tableOnly.decisionsByAction,
        refusalsByCode: tableOnly.refusalsByCode,
      }),
    }),
    receipts: Object.freeze({
      inline: inline.receipts.count, tableOnly: tableOnly.receipts.count,
    }),
    blocksRemaining: Object.freeze({
      inline: inline.blocksRemaining, tableOnly: tableOnly.blocksRemaining,
    }),
    answersRemaining: Object.freeze({
      inline: inline.answersRemaining, tableOnly: tableOnly.answersRemaining,
    }),
    realExperiment: false,
    citable: false,
  });
}

/** The report's needed settings, checked once. */
function assertSettings({ resultCount, rebuildTokens, tokenBudget }) {
  if (!Number.isSafeInteger(resultCount) || resultCount < 1) {
    throw new RangeError(`--results takes a positive integer, got ${String(resultCount)}`);
  }
  if (!Number.isSafeInteger(rebuildTokens) || rebuildTokens < 1) {
    throw new RangeError(
      `--inline-rebuild-tokens takes a positive integer, got ${String(rebuildTokens)}`);
  }
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
    throw new RangeError(`--token-budget takes a positive integer, got ${String(tokenBudget)}`);
  }
}

/** Non-carried refusals from a rebuild return (or its plan). */
function nonCarriedRefusalsOf(rebuild) {
  if (rebuild === null || rebuild === undefined) return [];
  const list = Array.isArray(rebuild.refusals)
    ? rebuild.refusals : (rebuild.plan?.refusals ?? []);
  return list.filter(refusal => refusal?.carried !== true);
}

/** One code→count map from refusal records. */
function codeCountsOf(records) {
  const counts = {};
  for (const record of records) {
    const code = typeof record?.code === "string" ? record.code : "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** Merge several code→count maps. */
function mergeCodeCounts(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [code, count] of Object.entries(map ?? {})) {
      merged[code] = (merged[code] ?? 0) + count;
    }
  }
  return merged;
}

/** Untouched results by reason. */
function countReasons(untouched) {
  const counts = {};
  for (const entry of untouched) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

/** Every message's text as UTF-8 bytes. */
function totalBytesOf(messages) {
  return messages.reduce((sum, message) =>
    sum + Buffer.byteLength(typeof message.text === "string" ? message.text : "", "utf8"), 0);
}

/** Non-overlapping occurrences of `needle` in `text`. */
function countOf(text, needle) {
  let count = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

/** A small deterministic digest of the surface, for a critic to compare runs. */
function digestOfMessages(messages) {
  let hash = 0x811c9dc5;
  for (const message of messages) {
    const text = `${message.role}:${message.seq}:${message.text}`;
    for (let at = 0; at < text.length; at += 1) {
      hash ^= text.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

/** A number or null, never a silent zero for an absent field. */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The CLI. Both arms run by default; `--table-only` runs only the table arm.
 * `--json` prints one JSON; `--out` writes the same JSON to a file.
 */
export async function main(argv) {
  const { values } = parseDevArgs(argv, {
    options: optionsOf([
      ["--results", "string"],
      ["--inline-rebuild-tokens", "string", "inlineRebuildTokens"],
      ["--token-budget", "string", "tokenBudget"],
      ["--table-only", "boolean", "tableOnly"],
      ["--json", "boolean"],
      ["--out", "string"],
    ]),
    refuse: message => {
      throw new Error(`sim-inline-ask-run.mjs: ${message}`);
    },
    usage: () => USAGE,
    help: USAGE,
    prefix: "sim-inline-ask-run.mjs: ",
  });
  const resultCount = Number(values.results ?? "72");
  const rebuildTokens = Number(values.inlineRebuildTokens ?? String(INLINE_REBUILD_TOKENS));
  const tokenBudget = Number(values.tokenBudget ?? String(SIM_TOKEN_BUDGET));
  for (const [label, value] of [
    ["--results", resultCount], ["--inline-rebuild-tokens", rebuildTokens],
    ["--token-budget", tokenBudget],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`sim-inline-ask-run.mjs: ${label} takes a positive integer,`
        + ` got ${String(value)}`);
    }
  }
  const tableOnlySelected = values.tableOnly === true;
  const inline = tableOnlySelected
    ? null : runInlineArm({ resultCount, rebuildTokens, tokenBudget });
  const tableOnly = runTableOnlyArm({ resultCount, rebuildTokens, tokenBudget });
  const payload = pilotReportOf({ inline, tableOnly, resultCount, rebuildTokens, tokenBudget });
  // `--json` keeps stdout machine-readable: the human lines go to stderr and the
  // one JSON report (both arms) goes to stdout. Without `--json`, the human
  // lines go to stdout as before.
  const write = values.json === true
    ? text => process.stderr.write(text)
    : text => process.stdout.write(text);
  if (inline !== null) printArm(inline.report, write);
  printArm(tableOnly.report, write);
  if (inline !== null) {
    write(`[inline-ask] comparison: final depth inline`
      + ` ${String(inline.report.finalDepth)} vs table-only`
      + ` ${String(tableOnly.report.finalDepth)}; net bytes removed inline`
      + ` ${String(inline.report.netBytesRemoved)} vs table-only`
      + ` ${String(tableOnly.report.netBytesRemoved)}; turns`
      + ` ${String(inline.report.turns.surface.total)} vs`
      + ` ${String(tableOnly.report.turns.surface.total)}; NOT the real experiment`
      + ` (synthetic stub, provider none)\n`);
  }
  write(`[inline-ask] provider none (0 calls); billable false;`
    + ` citable false; tokenAccounting "${TOKEN_ACCOUNTING}";`
    + ` timer none (0 = not armed); ask ceiling none (0 = not armed)\n`);
  const json = `${JSON.stringify(payload, jsonSafe, 2)}\n`;
  if (values.json === true) process.stdout.write(json);
  if (typeof values.out === "string" && values.out.length > 0) {
    writeFileSync(path.resolve(values.out), json, "utf8");
  }
  return 0;
}

/** One arm's stdout block: every audit number is printed, not implied. */
function printArm(report, write = text => process.stdout.write(text)) {
  write(`[inline-ask] arm ${report.arm}: blocks`
    + ` ${String(report.blocksAppended)} appended, ${String(report.blocksRemoved)} removed,`
    + ` ${String(report.blocksRemaining)} remaining; answers`
    + ` ${String(report.answersAppended)} emitted (${String(report.answersParsed)} parsed),`
    + ` ${String(report.answersRemoved)} removed,`
    + ` ${String(report.answersRemaining)} remaining; reconciled`
    + ` ${String(report.blocksReconciled && report.answersReconciled)}\n`);
  write(`[inline-ask] arm ${report.arm}: decisions`
    + ` forgetall=${String(report.decisionsByAction.forgetall)}`
    + ` keeplines=${String(report.decisionsByAction.keeplines)}`
    + ` keepall=${String(report.decisionsByAction.keepall)}`
    + ` (full-range keeplines=${String(report.keepallBreakdown.fullRangeKeeplines)},`
    + ` literal keepall refused=${String(report.keepallBreakdown.literalKeepallRefused)})`
    + ` refused=${String(report.decisionsByAction.refused)}; refusals by code`
    + ` ${JSON.stringify(report.refusalsByCode)}\n`);
  write(`[inline-ask] arm ${report.arm}: depth before/after`
    + ` ${String(report.depthBefore)}/${String(report.depthAfter)} tokens;`
    + ` finalDepth ${String(report.finalDepth)}; rebuildCount`
    + ` ${String(report.rebuildCount)}; rebuildStillAbove`
    + ` ${String(report.rebuildStillAbove)}; endedBy ${report.endedBy};`
    + ` budgetStopKind ${String(report.budgetStopKind)};`
    + ` budgetProjectedNextCallTokens`
    + ` ${String(report.budgetProjectedNextCallTokens)};`
    + ` budgetReached ${String(report.budgetReached)};`
    + ` estimatedTokensSpent ${String(report.estimatedTokensSpent)}`
    + ` of ${String(report.tokenBudget)}\n`);
  const table = report.tablePass;
  if (table === null) {
    write(`[inline-ask] arm ${report.arm}: no table pass ran\n`);
  } else {
    write(`[inline-ask] arm ${report.arm}: table pass`
      + ` ${String(table.rows)} unit(s), ${String(table.answered)} answered,`
      + ` ${table.grammar}, share line`
      + ` ${table.shareLine}, 40%=${String(table.fortyPercent)}`
      + ` 70%=${String(table.seventyPercent)}, applied`
      + ` ${String(table.applied)}, kept ${String(table.kept)}, receipts`
      + ` ${String(table.receipts)}, recall ${String(table.recall)},`
      + ` parseOnly ${String(table.parseOnly)}\n`);
  }
  write(`[inline-ask] arm ${report.arm}: turns baseline`
    + ` ${String(report.turns.baseline.total)}, surface`
    + ` ${String(report.turns.surface.total)}; per-result extra`
    + ` ${String(report.turns.perResultExtraTurns)}; rebuild extra`
    + ` ${String(report.turns.rebuildExtraTurns)}; total extra`
    + ` ${String(report.turns.totalExtraTurns)}; bytes added`
    + ` ${String(report.bytesAddedGross)} (blocks`
    + ` ${String(report.bytesAddedByBlocks)} + answers`
    + ` ${String(report.bytesAddedByAnswers)} + shaped`
    + ` ${String(report.bytesAddedByShapedTurns)}), removed`
    + ` ${String(report.bytesRemovedGross)}, net ${String(report.netBytesRemoved)}\n`);
}

/** Raw bytes cannot ride a JSON report: carry their length and base64 text. */
function jsonSafe(_key, value) {
  if (value instanceof Uint8Array) {
    return { bytes: value.length, base64: Buffer.from(value).toString("base64") };
  }
  return value;
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  });
}
