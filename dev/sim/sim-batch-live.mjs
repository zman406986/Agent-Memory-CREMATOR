#!/usr/bin/env node
/**
 * The batched-ask trigger, replayed with REAL answers (batch-trigger simulation,
 * chunk 4). The chunk-1 timeline supplies the fires; this module asks the real
 * model at each one and folds its answers back through the same renderer.
 *
 * Run `node dev/sim/sim-batch-live.mjs --i-am-the-owner --lanes 8
 * --token-grant 10000000 [--mode batch|threshold] [--thresholds 30000]
 * [--transport deepseek|stub]`.
 *
 * One ask = ONE chat completion to the locked route (deepseek-official /
 * `deepseek-flash` / https://api.deepseek.com/v1). Its user message is core's
 * REAL `entryBatchAskMessage` over the fire's pending units; the assistant's
 * reply is read by core's REAL `parseEntryBatchAnswer`. The request also carries
 * the transcript's own system message and its 19 header tools (13,290 B in the
 * 2026-10-29 vanilla world; 13,879 B as the request's tools array), and the
 * conversation before the ask is the run's SIMULATED SURFACE (ISSUE-194): the
 * transcript's own text rows up to the fire, with each unit this run already
 * forgot or trimmed replaced by the
 * product's shaped turn — summary, kept lines, marker — so the model never reads
 * a forgotten unit's body again. The model's own asks and answers are never in
 * that history (the product rewinds the exchange; the host's marked entry-ask
 * rows are dropped by `readTimeline`). The surface is a REQUIRED argument:
 * a run with no answers yet passes `new Map()`, and nothing silently means
 * "the raw recording". Nothing is trimmed by the harness, but an oversized
 * prompt refuses IN-PROCESS before any socket: `buildPrompt` trips at
 * `ceil(bytes/3) >= 400_000`, so the failure is a named refusal, never a
 * provider error.
 *
 * RULER. One bytes/token ratio is a MIX: the tool schema JSON sent on every
 * request and the text (system, framed turns, ask, envelope) tokenize at
 * different densities, and a removal lowers the text share, so the mix — and
 * the single ratio — drifts (+2.95%, +3.38%, +4.83%, +7.17%, +10.74% across the
 * 2026-11-07 pilot's asks 1-5). The band therefore runs in three stages. Ask 0
 * has no band: its total bytes/token ratio must land in 2.0-6.0 or the run
 * refuses `sim-batch-provider-ruler`, and inside it records the single ratio
 * `bytesPerToken = sentPromptBytes / providerPromptTokens` over the FULL
 * request body. Ask 1 is banded ±25% against `anchorBytes / bytesPerToken`.
 * Asks 2+ are banded ±25% against the two-density prediction
 * `toolBytes/rTool + textBytes/rText` solved from asks 0 and 1, where
 * `textBytes = sentPromptBytes - toolBytes`. A degenerate solve (no tool bytes,
 * no text, or dependent points) falls back to the single ratio and says so
 * (`rulerFallback: true`). The band is a GROSS-ERROR GUARD for a missing or
 * doubled context: a send more than 25% off refuses
 * `sim-batch-provider-band-gross`; a send 10-25% off records
 * `tokenRuler.drift: "within-gross-band"` and continues; `deltaPercent` is
 * recorded on every send as reporting, never as a threshold. Exact content
 * identity is established by the prompt bytes sent and the body hash checked
 * before send, not by the provider's tokenizer. Every send record carries
 * `tokenRuler` (rTool, rText, solvedFrom, predictedTokens, providerPromptTokens,
 * deltaPercent, and `drift` inside the 10-25% region) and both stale estimates
 * beside it (`anchorDepth304`, `anchorDepthCalibrated`). A synthetic reading
 * (`usageRuler: "synthetic"`) never calibrates, so the stub path is unchanged.
 *
 * DEPTH. A pruner-off lane (`--ignore-host-prunes`) never triggers on
 * `result.json`'s depths: the host's trim shaped them, so they are recorded
 * beside the run as contaminated. Every trigger, cadence and depth figure comes
 * from the reconstructed surface's own bytes (`surfaceDepthAt`,
 * `ceil(bytes/3.04)`). The host-pruner-on lane keeps the measured series.
 *
 * SHARE LINE. The `jsonl-20` ask states the session's first fire with the 70
 * percent keep target and every later fire with 40 percent (ISSUE-194); the fire
 * index is the variant, so the same run always speaks one variant per fire.
 *
 * GRAMMAR. `--ask-grammar` picks the ask/answer pair from `sim-batch-grammar.mjs`
 * and is recorded on every send record and the run summary. `jsonl-20` (default)
 * is the product's default ask and the shipped reading, byte for byte;
 * `3option` and `two-option` SHIP
 * too (`config.ts` accepts them; `entry-ask.ts` reads them) and swap only the
 * instruction block. `forgetlines` and `keeplines-60` are the sim-only arms:
 * they swap the instruction block (and, where the grammar defines one, the
 * row-level admission rule its own parser reads). `keeplines-60` is arm B: the
 * same two
 * actions with a 250-word summary cap, keep-whole accepted, and `keepall`
 * refused (`action-not-in-grammar`) — its reader is the sim's own, never the
 * product's. `jsonl-20-nokeepall` (ISSUE-221) is the sim-only A/B arm: the same
 * per-row wire with `keepall` removed, so a `keepall` row is
 * `action-not-in-grammar` and a whole-range `keeplines` is the keep-everything
 * shape. The ADMITTED rows are the same under every grammar — a row is
 * eligible by the floor, the error filter and the product's two-quote rule,
 * none of which reads the grammar — so a grammar change moves the ask bytes and
 * the verdict shapes, never the sample. Rows, closing anchor, trigger, scoring
 * and booking are the same under all six.
 *
 * ORDER. `--ask-order` places the SAME teaching block around the row table and
 * is recorded on every send record and the run summary: `first` (default) is
 * today's instruction-table-closing layout, `after` puts the table first and the
 * block after it, `both` repeats the block before and after the table. The
 * closing anchor is last in all three, the grammar and order compose freely, and
 * request shape, trigger, scoring and booking do not read the order at all.
 *
 * SCOPE. `--ask-scope new` (default) is today's table: the units that landed
 * since the last fire and nobody else. `--ask-scope kept` adds every row whose
 * latest verdict kept it — `keepall`, `keeplines`, or a refusal that fails open
 * — to the same table, so a fire re-asks what is still on the surface beside the
 * newly eligible units. One row per unitId; a forgotten row never returns unless
 * the segment lands it again. The kept row is re-tabled from the body the
 * SURFACE holds (the shaped turn), which is what the product re-reads; the
 * record states `tableSource: "shaped-surface"` (`"landed"` under `new`), and
 * the row's line count and ranges are the shaped body's. Threshold mode only; a
 * batch fire asks a fixed lane, so `--mode batch` with `kept` refuses by name.
 *
 * FIRST FIRE. `--first-fire-depth <int>` is threshold mode only and a depth
 * gate: the FIRST fire waits until the measured depth is at least the value,
 * instead of the lane threshold. After that fire the normal incremental
 * baseline reset runs and the lane threshold governs every later fire. Unset is
 * today's cadence; the value rides the run summary and every ask record as
 * `firstFireDepth` (null when unset).
 *
 * Stated limits. The context turns are a STAND-IN, not the host's wire: a tool
 * result is a `user` turn carrying an invented `"<label>:\n"` prefix, a tool
 * call is a `Tool call: <name>\n<target>` assistant turn, every non-text part
 * other than a re-projected tool call is dropped, only the first
 * `system/message` is kept (`developer/message` is
 * dropped whole), and a shaped turn stays at its own result's position rather
 * than being appended. Every send record and the run summary therefore carry a
 * `contextStandIn` block that states each of those differences, and every run is
 * non-citable: `stand-in-context` (this is not the host's wire) and
 * `text-source` (both readings are the same decoded text; the product re-encodes
 * it at `plugin.ts:1111`, and the two differ on content parts) are on EVERY run,
 * so `citable` is ALWAYS false.
 * `citableForStandIn` subtracts ONLY `stand-in-context`; it RETAINS
 * `text-source` and the two dropped-content reasons, so that state NEVER reaches
 * zero and is not a citation, only the same list with the wire's stand-in
 * statement removed. The model's answer is the only thing this chunk measures;
 * under the default grammar the ask bytes, the parser and the render path are
 * the shipped ones. The CADENCE can be the sim's own: `depth-tokens` is not a
 * product trigger and `--ask-scope kept` re-asks rows the product settles, so
 * those modes are named reasons (`sim-only-trigger:depth-tokens`,
 * `sim-only-ask-scope:kept`), never silently measured as product shapes. The
 * eligible POPULATION does not read the grammar.
 *
 * RECORDED. Every send record keeps the answer text itself: `contentText` (the
 * whole joined answer, capped at `CONTENT_STORE_LIMIT_BYTES` = 256 KiB),
 * `contentSha256` (the sha256 of the WHOLE answer, truncation included),
 * `answerTruncated`, `contentBytes` (total), and `contentHead` / `contentTail`
 * (first and last 400 bytes), so a refused reply stays readable and the parsed
 * rows and freed bytes can be re-read from the record. The MODEL's reasoning text is never
 * recorded: the fields come from the joined content only. The PROMPT's reasoning
 * is: every send record carries `reasoningBytes` / `reasoningMessages` (and the
 * wire-escaped `reasoningWireBytes` beside them), because ADR-0045 makes the
 * agent's reasoning blocks part of the measured context. A refused row keeps its
 * coarse `code` plus the `wireCode`/`message` that `batch-ask.ts:96-98` drops.
 * The summary's `refusalClasses` is the SEND-level map (`failureClass`); row
 * refusals are counted apart, by the reader's own code, in the summary's
 * `rowRefusalClasses` and in every record that carries `rows` (a failed send
 * carries `{}`: it read no row). The two maps are never mixed (ISSUE-184).
 * Every send record also carries `inputDeviations`: the DETECTED deviations of
 * this input, each a citation reason. The recording's own two are
 * detected (an extra `agent-instructions` splice; a system prompt naming a model
 * the route is not). The stand-in's two facts (the invented `"<label>:\n"`
 * line, and the call projection that can read a call differently from its table
 * label) are recorded in `contextStandIn` and folded into the single
 * `stand-in-context` reason, so they are not separate citation reasons.
 *
 * HOST PRUNER. `--ignore-host-prunes` (off, the product/test arm) or
 * `--allow-host-pruner` (on, the vanilla arm; ADR-0041's opt-out) is REQUIRED.
 * Two states are named, and they are read from different places:
 *
 * - `inputHostPruner` is the INPUT RECORDING's state, read from the recording
 *   itself (`compaction/prune` journals present, whole-file or in the segment).
 *   A recording made with the pruner on is `"on"` even when this replay models
 *   it off, and `host-pruner-on` is a citation reason for such a run — including
 *   a reconstruction (P1).
 * - `modeledHostPruner` is the state this replay MODELS (`"off"` under
 *   `--ignore-host-prunes`, `"on"` under `--allow-host-pruner`).
 *
 * `runHostPruner: "none"` rides beside both, because this replay mounts no host
 * mechanism (ADR-0041's `hostPruner` names a mount). With the trim off the prune
 * journals and the replacement rows they produced leave the world, and the
 * originals stay whole. A lane that states neither flag refuses by name.
 *
 * LAWS. `--i-am-the-owner` is required before anything is read or sent.
 * `--token-grant` is REQUIRED and is the only run cap: 10,000,000 tokens for a
 * sim run, 100,000,000 for a live dsh run. A run whose spend reaches the grant
 * stops with `stoppedAtBudget` and `TRUNCATED` at the START of its first
 * `[summary]` line. There is no wall-clock timer and no ask-count ceiling by
 * default: `--kill-ms 0` and `--ask-ceiling 0` both mean off, and a positive
 * value arms that optional cap. A lane stopped by either cap prints `TRUNCATED`
 * at the START of its first `[summary]` line, so a capped run never reads as a
 * complete sample (P11).
 * COMPLETENESS is its own field and is never `stoppedAtCeiling` alone:
 * `complete` is true only when `carried === 0 && refusedSends === 0 &&
 * segmentExcludedRows === 0`, and `incompleteReasons` names every way the run
 * falls short (the ceiling, the token budget, a failed send, a carried tail, a
 * segment cut). The old `truncated` flag was set from the ceiling only, so a
 * failed send or a cut segment read as a complete sample (P11).
 * DEEPSEEK_API_KEY is read IN-PROCESS from `~/.dsh/.credentials.yaml`
 * (C:\Users\TZhen\.dsh\ or C:\Users\TZ\.dsh\) and is never printed, logged,
 * exported, or put in evidence: the record says `found` only. Evidence lands in
 * the gitignored `scratchpad/sim-retest-2026-10-30/lanes/` and is never committed.
 * One attempt per ask, no retries. A TRANSPORT failure (a non-2xx status, a
 * stream that never reached `[DONE]`, a deadline) stops the batch lane at once:
 * that is not a model answer. A reply the transport ANSWERED whose text is empty
 * or tool-call-only is NOT a failed call. The product refuses every tabled row
 * with `no-text` (`llm-ask.ts:314`), maps each to its own KEEP
 * (`batch-ask.ts:197`) and forms the next batch; the batch lane does the same:
 * every row keeps, nothing is applied, the fire is counted `unanswered` beside
 * `parseRefusedFires`/`parseRefusedRows`, and the lane continues. A refused
 * row's unit stays whole on the surface, is never re-tabled in the run and is
 * not carried (it was asked). Its rows still count as `refused-rows:<n>`, so the
 * run cannot read `complete`.
 *
 * Exit codes: 0 lane finished (or stopped at the ceiling), 2 refused, 124 killed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { batchVerdict } from "@cremator/core";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";
import { timerDelayRefusal } from "../shared/timer-ms.mjs";
import { reasoningOf, textOf } from "./gate3-live-chain.mjs";
import {
  ASK_GRAMMARS, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER,
  answerDetailsOf, answerRowsOf, askMessageForRows, arithmeticCodeOf, correctionMessageForRows,
  keptLineCountOf, keepsWholeOf,
} from "./sim-batch-grammar.mjs";
import {
  INLINE_FLOOR_BYTES, INLINE_REBUILD_TOKENS,
  appendInlineBlockOf, inlineAskReport, linesOf, parseInlineAnswer, rebuildSurface,
} from "./sim-inline-ask.mjs";
import { renderMoment } from "./sim-render.mjs";
import {
  DEFAULT_ASK_SCOPE, DEFAULT_BYTE_THRESHOLDS, DEFAULT_THRESHOLD_SEMANTICS, DEFAULT_THRESHOLD_UNITS,
  DEFAULT_TRANSCRIPT, DEFAULT_USAGE, FLOOR_BYTES, FLOOR_MODEL, HOST_DEPTH_SOURCE,
  PRODUCT_BATCH_SIZE,
  SEGMENT_PINS,
  PROMPT_TOKEN_LIMIT, REASONING_TURN_COVERAGE_FLOOR,
  SimBatchUnitsRefusal,
  SURFACE_DEPTH_SOURCE, TEXT_SOURCE, THRESHOLD_SEMANTICS, THRESHOLD_UNITS,
  askRowsOf, assertAskScope, assertDepthSource, assertFirstFireDepth, assertUsageStepsPinned,
  assertZeroPruneGate,
  CHECK_CLASSES,
  assertOrderForGrammar, assertSegmentPins, buildIdentityOf, callNamesOf,
  clampDecisionStep, contextStandInOf, defaultDepthSource,
  depthsInSegment, droppedRowGapsOf, eligibilityOf, eligibleOf, eligibleSplitOf,
  expectedReasoningAt, factsOf, factsShowTwoQuotes,
  guardTokensOf, landedBytesVerdict, measuredTokensOf, netDroppedOf,
  nextBaselineDepth, projectionOf, promptForFire, promptSha256Of, reasoningPairsHashOf, reasoningPairsOf,
  reasoningTextsOf, reasoningWireBytesOf, signedMeasuredTokensOf,
  applyFireToSurface, simulateSurface, surfaceDigestOf, surfaceFireOf, surfaceSizeOf,
  hostPruneStepOf, hostRemovedAt, askableAt, askableOf, askableCountsOf,
  readTimeline, readUsage, reconstructedRemovalsOf, reconstructedSurfaceOf, refuse,
  sha256OfText,
  surfaceDepthAt, surfaceDepthBefore,
  tableUnitsOf,
  thresholdLaneName, thresholdVerdict,
} from "./sim-batch-units.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** `scratchpad/` is disposable and gitignored: evidence never leaves it. */
export const LIVE_DIR = path.resolve(HERE, "../../scratchpad/sim-retest-2026-10-30/lanes");
/** The locked route: no flag changes it. Base exactly as pi-ai maps it. */
export const ROUTE = Object.freeze({
  provider: "deepseek-official", model: FLOOR_MODEL,
  base: "https://api.deepseek.com",
});
/** The fields the real body never carries for this model (design §3). */
export const FORBIDDEN_FIELDS = Object.freeze([
  "temperature", "max_tokens", "tool_choice", "top_p", "top_k",
  "frequency_penalty", "presence_penalty", "response_format", "store",
]);
/** 0 = OFF. The owner's 2026-11-08 ruling makes the token budget the only run
 * cap: no ask-count ceiling and no wall-clock timer by default. */
export const DEFAULT_ASK_CEILING = 0;
export const DEFAULT_KILL_MS = 0;
/** The verdicts a row reader counts as kept (ISSUE-175). Everything else an
 * answered row can answer is a forget; `forgetlines` names the lines that
 * leave, `forgetall` the whole unit, and `keeplines` keeps. */
export const VERDICT_KEPT = Object.freeze(new Set(["keepall", "keeplines"]));
/** `llm-ask.ts:23`: the one deadline both ask shapes share (120 s, ISSUE-126). */
export const CALL_TIMEOUT_MS = 120_000;
const CRED = path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", ".credentials.yaml");
const USAGE = [
  "usage: sim-batch-live.mjs --i-am-the-owner [--transcript <session.v4.jsonl>]",
  "                           [--usage <result.json>] [--floor 512] [--segment <lastStep>]",
  "                           [--mode batch|threshold] [--lanes 8] [--thresholds 30000]",
  "                           [--threshold-units depth-tokens|landed-bytes]",
  "                           [--threshold-semantics incremental|growth|absolute]",
  "                           [--first-fire-depth <tokens>] [--token-grant <n>]",
  "                           [--ask-ceiling <n>] [--kill-ms <n>]",
  "                           [--transport deepseek|stub]",
  "                           [--ask-grammar 3option|two-option|forgetlines|keeplines-60|jsonl-20|jsonl-20-nokeepall]",
  "                           [--ask-order first|after|both] [--ask-scope new|kept]",
  "                           [--ignore-host-prunes | --allow-host-pruner]",
  "                           [--reconstruction] [--allow-zero-reasoning]",
  "                           [--out <dir>] [--json]",
  "       --i-am-the-owner  required; without it nothing is read or sent",
  "       --lanes           the ONE batch lane this chunk runs; default 8",
  "       --thresholds      the ONE threshold lane, in tokens (depth-tokens) or bytes",
  "                         (landed-bytes); default 30000 tokens, or 240000 bytes",
  "       --threshold-units depth-tokens (depth growth) or landed-bytes (eligible bytes",
  "                         landed since the last fire); default depth-tokens",
  "       --first-fire-depth",
  "                         threshold mode only: the FIRST fire waits for this",
  "                         absolute depth instead of the lane threshold; later",
  "                         fires use the lane threshold and the normal baseline",
  "       --token-grant     REQUIRED run budget in tokens: 10000000 for a sim run",
  "                         (100000000 for a live dsh run); the only run cap",
  "       --ask-ceiling     optional ask cap; default 0 (off; the token budget is the",
  "                         only cap)",
  "       --kill-ms         optional wall-clock cap, armed before the first request;",
  "                         default 0 (off; the token budget is the only cap)",
  "       --transport       deepseek (real, locked route) or stub (no socket)",
  "       --ask-grammar     jsonl-20 (shipped, the product default), 3option,",
  "                         two-option (both shipped), or a sim-only variant",
  "                         (forgetlines, keeplines-60, jsonl-20-nokeepall);",
  "                         recorded on every send record",
  "       --ask-order       first (default), after or both: where the teaching block sits",
  "                         relative to the row table; closing anchor stays last; a slot",
  "                         grammar (jsonl-20, jsonl-20-nokeepall) accepts only first",
  "       --ask-scope       new (default) tables only the newly eligible units; kept adds",
  "                         every still-kept row from earlier fires to each threshold fire's",
  "                         table (threshold mode only; --mode batch refuses it)",
  "       --ignore-host-prunes",
  "                         state the host pruner is OFF (the product/test arm): its prune",
  "                         journals and the replacement rows they produced leave the world;",
  "                         a pruner-off lane reads depth from the reconstructed surface,",
  "                         never from result.json (which is recorded as contaminated), and",
  "                         ADR-0041 Decision 6 requires zero replay prune events",
  "       --allow-host-pruner",
  "                         state the host pruner is ON (the vanilla arm, ADR-0041's one",
  "                         opt-out); such a run is a host-vs-product comparison, never a",
  "                         product measurement. State exactly one of the two or the run",
  "                         refuses by name. `--transport deepseek` refuses this flag: a live",
  "                         paid run never measures with the competing mechanism mounted",
  "       --reconstruction",
  "                         declare a pruner-off replay of a recording that itself carries",
  "                         compaction/prune events as a RECONSTRUCTION, not a product",
  "                         measurement; required by the zero-prune gate and recorded",
  "       --allow-zero-reasoning",
  "                         record a transcript that declares 0 reasoning blocks as a VOID",
  "                         comparison (ADR-0045) and mark the run non-citable; without",
  "                         it the run refuses by name",
  "       --inline-ask      run the inline-ask arm: a block per eligible result, one labelled",
  "                         replay-extra-call per block, one rebuild at --inline-rebuild-tokens",
  "                         (200000) with the 40 percent jsonl-20-nokeepall table pass",
  "       --table-only      run the table-only arm on the same input: no blocks, one table",
  "                         pass at the bar, applied; give both flags for both records and",
  "                         the comparison JSON",
  "       --inline-rebuild-tokens",
  "                         the one rebuild depth in tokens; default 200000",
  "       --max-steps       stop both arms at this step; when both arms are selected and",
  "                         this is absent, the table-only arm is capped at the inline arm's",
  "                         own stop step (commonStop), so one window is compared",
  "       --grammar         the inline lane's alias for --ask-grammar, fixed to",
  "                         jsonl-20-nokeepall; the lane sets it itself, so it is optional",
  "       --out             evidence directory; default scratchpad/sim-retest-2026-10-30/lanes",
].join("\n");

/** One named refusal, the units module's own error class. */
export { SimBatchUnitsRefusal };

/**
 * DEEPSEEK_API_KEY from the `refs:` block, in-process only. The return value is
 * the only place the secret exists; every caller passes it straight to a fetch
 * header and records `found`, never the value.
 */
export function deepseekKey(home = process.env.USERPROFILE || process.env.HOME || "") {
  const file = path.join(home, ".dsh", ".credentials.yaml");
  if (!existsSync(file)) return { key: null, source: "missing-file" };
  const text = readFileSync(file, "utf8");
  let inRefs = false;
  for (const line of text.split("\n")) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/.exec(line);
    if (match !== null) return { key: match[1], source: file };
  }
  return { key: null, source: "missing-in-file" };
}

// `callNamesOf`, `factsOf` and `askRowsOf` live in the units module (one copy);
// they are re-exported here because the chunk's tests read them from this module.
export { callNamesOf, factsOf, askRowsOf, reconstructedSurfaceOf };

/**
 * The transcript's own conversation as chat turns up to a seq: user and
 * assistant text as themselves, a tool result as a `user` turn. Kept for the
 * probe tests; the live path now builds its prompt from the measured surface
 * (`promptForFire`, design §2).
 */
export function contextTurnsOf(rows, untilSeq) {
  const turns = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.seq) || row.seq > untilSeq) continue;
    const text = textOf(row);
    if (text.length === 0) continue;
    if (row.type === "user/message") turns.push({ role: "user", text });
    else if (row.type === "assistant/message") turns.push({ role: "assistant", text });
    else if (row.type === "tool/result") turns.push({ role: "user", text: `Tool result:\n${text}` });
  }
  return turns;
}

/**
 * The one request body the real ask shape sends (design §3). No field beyond
 * these five keys; the before-send check asserts it.
 */
export function requestBodyOf({ messages, tools = [] }) {
  return { model: ROUTE.model, stream: true, stream_options: { include_usage: true }, tools, messages };
}

/**
 * The before-send self-check. Every violation is a refusal (exit 2), never a
 * warning: a role other than `system`, a present forbidden field (including
 * `store`), a base URL other than the pinned one, a non-stream body, or a
 * deadline other than `llm-ask.ts`'s 120,000 ms.
 */
export function assertRequestShape({ body, base = ROUTE.base, deadlineMs = CALL_TIMEOUT_MS }) {
  const fail = reason => refuse("sim-batch-request-shape", `${reason}; the run refuses`);
  if (base !== "https://api.deepseek.com") fail(`base URL is ${String(base)}`);
  if (deadlineMs !== 120_000) fail(`deadline is ${String(deadlineMs)} ms, not 120000`);
  if (body === null || typeof body !== "object") fail("no request body");
  if (body.stream !== true) fail("stream is not true");
  if (body.stream_options?.include_usage !== true) fail("stream_options.include_usage is not true");
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) fail(`forbidden field ${field} is present`);
  }
  if (!Array.isArray(body.tools)) fail("tools is not an array");
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages === null || messages.length === 0) fail("messages is empty");
  if (messages[0]?.role !== "system") fail(`first message role is ${String(messages[0]?.role)}`);
  return body;
}

/**
 * The reply-text fields EVERY send records: the joined content itself (capped at
 * 256 KiB), its sha256 over the WHOLE answer, the truncation flag, the byte
 * length, and the first/last 400 bytes. The string is the assistant's answer
 * only — the stream reader appends `delta.content` and typed `text-delta`, never
 * `reasoning_content` — so no reasoning byte can land here.
 *
 * The cap is on the STORED text, never on the hash: `contentSha256` commits to
 * every answer byte, so a capped record still names the answer it holds a prefix
 * of. `contentBytes` is the full length, so a reader can see what was cut. When
 * `answerTruncated` is false, re-hashing `contentText` reproduces
 * `contentSha256`; a capped answer keeps its head and tail beside the prefix.
 */
export const CONTENT_SLICE_BYTES = 400;
/** The most answer text one record stores: 256 KiB. */
export const CONTENT_STORE_LIMIT_BYTES = 256 * 1024;

/** The answer text, hash, truncation flag and head/tail for one joined answer. */
export function contentFieldsOf(content) {
  const text = typeof content === "string" ? content : "";
  const bytes = Buffer.from(text, "utf8");
  const answerTruncated = bytes.length > CONTENT_STORE_LIMIT_BYTES;
  return {
    contentBytes: bytes.length,
    contentSha256: sha256OfText(text),
    contentText: answerTruncated
      ? bytes.subarray(0, CONTENT_STORE_LIMIT_BYTES).toString("utf8")
      : text,
    answerTruncated,
    contentHead: bytes.subarray(0, CONTENT_SLICE_BYTES).toString("utf8"),
    contentTail: bytes.subarray(Math.max(0, bytes.length - CONTENT_SLICE_BYTES)).toString("utf8"),
  };
}

/**
 * The input deviations a run carries, as facts read from the timeline: only the
 * two the pinned recording adds. The stand-in's own two properties (the invented
 * `"<label>:\n"` line and the dual-reading call projection) are FACTS of the
 * universal `stand-in-context` reason and are stated in `contextStandIn`; they
 * are not separate citation reasons. `citableForStandIn` drops only
 * `stand-in-context`, so `text-source` stays and that state never reaches zero
 * (P10).
 *
 * The recording's own two are DETECTED, never assumed: a synthetic lane that has
 * neither does not claim them.
 *
 * - `agent-instructions-splice`: the recording carries an extra
 *   `Additional instructions from:` user turn (8,323 B at step 128 in the
 *   pinned world) that the restored host's own system prompt would not have.
 * - `system-model-name`: the recorded system prompt names a model the sim's
 *   route is not (`deepseek-v4.1-flash-1017` vs `deepseek-flash`).
 */
export function inputDeviationsOf(timeline, { route = ROUTE } = {}) {
  const deviations = [];
  const entrySteps = timeline?.entrySteps ?? new Map();
  for (const row of timeline?.rows ?? []) {
    if (row?.type !== "user/message") continue;
    const text = textOf(row);
    if (!text.startsWith("<system-reminder>") || !text.includes("Additional instructions from:")) {
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const step = entrySteps.get(row.seq) ?? row.data?.step ?? null;
    deviations.push({
      id: "agent-instructions-splice",
      scope: "input",
      citationReason: "input-deviation:agent-instructions-splice",
      step, seq: row.seq, bytes,
      detail: `the recording carries an extra \`agent-instructions\` splice (${String(bytes)} B)`
        + ` at step ${String(step)}; the restored host would not have that assistant-instruction`
        + " block inside the pinned cut",
    });
    break;
  }
  const recordedModel = "deepseek-v4.1-flash-1017";
  if (String(timeline?.system ?? "").includes(recordedModel)
    && route?.model !== recordedModel) {
    deviations.push({
      id: "system-model-name",
      scope: "input",
      citationReason: "input-deviation:system-model-name",
      recorded: recordedModel, route: route?.model ?? null,
      detail: `the recording's system prompt names \`${recordedModel}\` while the sim route is`
        + ` \`${String(route?.model ?? "")}\`; the prompt the model reads names a different model`,
    });
  }
  return deviations;
}

/**
 * The INPUT RECORDING's own host-pruner state, read from the recording — never
 * from the flag that selects what this replay models (P1). A recording that
 * carries `compaction/prune` rows was made with the host's tool-result pruner ON,
 * whether the replay keeps those rows (`--allow-host-pruner`) or deletes them
 * (`--ignore-host-prunes`). `inputPruneEvents` counts the whole file;
 * `replayedPrunes` counts the segment before the filter, so a segment that cut
 * every journal still reads as `on`.
 */
export function recordingHostPrunerState(timeline) {
  const whole = Number.isSafeInteger(timeline?.inputPruneEvents) ? timeline.inputPruneEvents : 0;
  const segment = Number.isSafeInteger(timeline?.replayedPrunes) ? timeline.replayedPrunes : 0;
  return whole > 0 || segment > 0 ? "on" : "off";
}

/**
 * The refusal detail `parseEntryBatchAnswer` cannot carry. `batch-ask.ts:96-98`
 * maps each row to `{index, status, code}`; it drops the parser's own `message`
 * and `wireCode`, so a `malformed-row` reads only as that one word. Re-reading
 * the same text with the same indices through the grammar module recovers both
 * under the run's grammar: the parser's detail for a parse refusal, and the
 * gate's sentence for a shape the grammar does not offer. The DECISION still
 * comes from the grammar's own reading; both read the same bytes.
 */
export function wireDetailsOf(text, indices, grammar = DEFAULT_ASK_GRAMMAR, options = {}) {
  return answerDetailsOf(text, indices, grammar, options);
}

/**
 * The one correction code an ANSWERED row earns (design §4), under the run's
 * grammar. Only an answered line-range row can earn one: a parse refusal is
 * `status:"refused"` and never reaches here. `two-option` has no ranges, so it
 * never earns one at all — only its parse refusals remain, and they keep.
 */
export function arithmeticRefusalOf(answer, total, grammar = DEFAULT_ASK_GRAMMAR) {
  return arithmeticCodeOf(answer, total, grammar);
}

/** `index → code` for the answered rows a correction may name, and nobody else. */
export function correctionCodesOf(rows, lineCounts, grammar = DEFAULT_ASK_GRAMMAR) {
  const codes = new Map();
  for (const row of rows) {
    if (row.status !== "answered") continue;
    const total = lineCounts.get(row.index);
    if (total === undefined) continue;
    const code = arithmeticCodeOf(row.answer, total, grammar);
    if (code !== null) codes.set(row.index, code);
  }
  return codes;
}

/**
 * The batch's ONE correction turn: the refused-by-arithmetic rows restated with
 * their own `N` over the SAME indices (`entry-ask.ts:682-700`). A row that
 * answered is not re-asked, and a parse refusal is not named here at all. The
 * option list is the run grammar's own, so a correction never teaches a shape
 * that grammar's parser would refuse.
 */
export function batchCorrectionMessageOf(units, codes, callNames = new Map(),
  grammar = DEFAULT_ASK_GRAMMAR) {
  const rows = askRowsOf(units, callNames);
  return correctionMessageForRows(rows, codes, grammar);
}

/**
 * The SSE reader, the same semantics as the shipped stream loop
 * (`llm-ask.ts:264-300`): join `text-delta`, take `usage` before `finish`, and
 * read the OpenAI wire shape pi-ai maps onto those chunks. A non-JSON keepalive
 * frame is counted, never answer text.
 */
export function readStreamFrames(raw) {
  let text = "";
  let usage = null;
  let finishReason = null;
  let toolCalls = 0;
  let done = false;
  let frames = 0;
  let badFrames = 0;
  for (const line of String(raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") { done = true; continue; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { badFrames += 1; continue; }
    frames += 1;
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") { text += chunk.text; continue; }
    if (chunk?.type === "usage" && chunk.usage !== undefined) { usage = chunk.usage; continue; }
    if (chunk?.type === "finish") { finishReason = chunk.reason ?? finishReason; continue; }
    const choice = chunk?.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === "string") text += piece;
    if (Array.isArray(choice?.delta?.tool_calls)) toolCalls += choice.delta.tool_calls.length;
    if (choice?.delta?.function_call !== undefined) toolCalls += 1;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (chunk?.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
  }
  return { text, usage, finishReason, toolCalls, done, frames, badFrames };
}

/**
 * The §4 class a completed stream lands in, or null for an answer: a length or
 * truncation trip, a cut-off stream, a tool-call-only or empty reply (both parse
 * failures), and an abort or deadline (both `timeout`).
 *
 * `done !== true` is `stream-truncated`, the class the product maps from
 * `entry-ask.ts`'s `StreamFailureReason` family (`stream-truncated` →
 * `stream-error`). A stream that ended without `[DONE]` is a cut-off reply even
 * when it carried text and a `finish_reason`: the reader saw the frames that were
 * present, not a complete answer. Before this check a stream with neither
 * `[DONE]` nor `finish_reason` passed as an answer.
 */
export function classifyStream(stream, { aborted = false, deadline = false } = {}) {
  if (deadline || aborted) return "timeout";
  if (stream.finishReason === "length" || stream.finishReason === "max-tokens") return "length-trip";
  if (stream.done !== true) return "stream-truncated";
  if (stream.toolCalls > 0) return "parse";
  if (String(stream.text).trim() === "") return "parse";
  return null;
}

/**
 * True when a send was ANSWERED at the transport level (`http 2xx`, stream
 * done) and its reply still carried no readable text: `classifyStream`'s
 * `parse` class on an answered send. That is a MODEL answer, not a failed send.
 * The product maps it from `llm-ask.ts:314`'s `no-text` to the rows' own KEEP
 * (`entry-ask.ts` renames it `empty-text`; `batch-ask.ts:197` refuses each row)
 * and forms the next batch at the next landing; a paid run does not end because
 * one reply was reasoning-only.
 *
 * A transport failure — a non-2xx status, a stream that never saw `[DONE]`, a
 * deadline — is NOT a model answer: the transport states `answered: false` for
 * those, so a batch lane still stops. A transport that omits `answered` (a test
 * double written before this rule) keeps the old stop-the-lane behaviour: the
 * claim has to be made by the transport, never inferred for it.
 */
export function refusedAnswerOf(response) {
  return response?.failure === "parse" && response?.answered === true;
}

/**
 * The GROSS-ERROR band: a live send more than 25% off its prediction is
 * refused, because 25% is the scale of a missing or doubled context, not of a
 * tokenizer's residual. The band's role is a gross-error guard; exact content
 * identity is established by the prompt bytes sent and the body hash checked
 * before send, not by the provider's tokenizer.
 */
export const GROSS_BAND_RATIO = 0.25;
/** The drift notice line: 10-25% off is recorded (`within-gross-band`), never refused. */
export const BAND_DRIFT_RATIO = 0.1;

/**
 * The provider-token band (design §2.5). `bandRatio` is how far the provider's
 * `prompt_tokens` may sit from the anchor, as a fraction. The LIVE band is
 * `GROSS_BAND_RATIO` (25%): it refuses only a body at the scale of a missing or
 * doubled context, because one bytes/token ratio and a two-density prediction
 * both drift as composition changes (the pilot's correct sends read +2.95% to
 * +10.74% and rising). Inside the band, a send 10-25% off records
 * `drift: "within-gross-band"` and continues; `deltaPercent` is reporting only.
 * The non-live probe path passes 10%, the band it was measured under.
 *
 * Absent provider usage is NEVER a pass: the reading has no ruler, so this
 * returns `ok:false, reason:"usage-absent"` and the caller refuses the send.
 *
 * `ruler` says where the token count came from. `provider` is the real reading.
 * `synthetic` is the stub's own estimate fed back to it: the band then compares
 * the estimate to itself, so `ok` is `null` and NEVER a pass. A band miss is a
 * refusal on a live transport and a recorded warning on the stub.
 *
 * `anchorDepth` is a TOKEN count. On a live run it is the route's calibrated
 * reading — ask 1's `bytes / bytesPerToken`, ask 2+'s two-density prediction
 * (`tokenDepthOf`); before the first accepted live send there is no band at
 * all, because the only available ruler (3.04 B/token) was measured on a
 * different route.
 */
export function providerBandOf({ promptTokens, anchorDepth, ruler = "provider",
  bandRatio = GROSS_BAND_RATIO }) {
  const known = Number.isSafeInteger(promptTokens) && Number.isSafeInteger(anchorDepth)
    && anchorDepth > 0;
  if (!known) {
    return { ok: false, ruler, reason: "usage-absent", promptTokens: promptTokens ?? null,
      anchorDepth: anchorDepth ?? null, delta: null, deltaRatio: null,
      deltaPercent: null, drift: null, bandRatio };
  }
  const delta = Math.abs(promptTokens - anchorDepth);
  const deltaRatio = delta / anchorDepth;
  const signedDelta = promptTokens - anchorDepth;
  // Inside the gross band but past the drift line: recorded, never refused.
  const drift = deltaRatio > BAND_DRIFT_RATIO && deltaRatio <= bandRatio
    ? "within-gross-band" : null;
  if (ruler === "synthetic") {
    return { ok: null, ruler, reason: "synthetic-ruler", promptTokens, anchorDepth, delta,
      deltaRatio, deltaPercent: signedDelta / anchorDepth * 100, drift: null, bandRatio };
  }
  const ok = deltaRatio <= bandRatio;
  return { ok, ruler, reason: ok ? null : "outside-band", promptTokens, anchorDepth, delta,
    deltaRatio, deltaPercent: signedDelta / anchorDepth * 100, drift, bandRatio };
}

/**
 * The plausible bytes-per-token window for a FIRST live send. A text request's
 * body (system, tools, framed turns, the ask) tokenizes inside this window on
 * every route this sim has measured; a ratio outside it names a body that is
 * not the prompt the anchor describes (a dropped tabled unit, a missing tool
 * schema, a mis-sized request). The first send has no earlier ruler to band
 * against, so this range is its whole guard.
 */
export const RULER_BYTES_PER_TOKEN_MIN = 2.0;
export const RULER_BYTES_PER_TOKEN_MAX = 6.0;

/**
 * The route's measured ruler from the first accepted live send: the bytes
 * actually sent (the FULL request body, tools included) over the provider's own
 * `prompt_tokens`. Ask 0 cannot have a band — the 3.04 B/token anchor was
 * measured on a different route — so its ratio is checked against the plausible
 * range instead and, inside it, becomes the ruler every later send of the run is
 * banded against. Outside it the caller refuses `sim-batch-provider-ruler` and
 * names both numbers.
 *
 * A synthetic reading never reaches this function: `gradeFidelity` branches on
 * `usage.ruler` first. The stub's `prompt_tokens` is the sim's own estimate fed
 * back, so a ruler derived from it would be the sim grading itself.
 */
export function firstSendRulerOf({ promptBytes, providerPromptTokens }) {
  const known = Number.isSafeInteger(promptBytes) && promptBytes > 0
    && Number.isSafeInteger(providerPromptTokens) && providerPromptTokens > 0;
  if (!known) {
    return { ok: false, reason: "usage-absent", bytesPerToken: null,
      promptBytes: promptBytes ?? null, providerPromptTokens: providerPromptTokens ?? null };
  }
  const bytesPerToken = promptBytes / providerPromptTokens;
  const ok = bytesPerToken >= RULER_BYTES_PER_TOKEN_MIN
    && bytesPerToken <= RULER_BYTES_PER_TOKEN_MAX;
  return { ok, reason: ok ? null : "outside-plausible-range", bytesPerToken,
    promptBytes, providerPromptTokens };
}

/**
 * The two-density token model behind the live band.
 *
 * ONE bytes/token ratio is a MIX of two densities: the tool schema JSON sent on
 * every request, and the text (system slot, framed turns, ask, envelope).
 * `textBytes = sentBytes - toolBytes` puts the framing and the envelope on the
 * text side; they are not the tool schema. A removal drops text and leaves the
 * schema untouched, so the mix moves and one ratio drifts: the 2026-11-07
 * pilot read 4.00 B/token at ask 0 and was +10.74% off its own anchor by ask 5,
 * purely because the text share fell.
 *
 *     promptTokens = toolBytes / rTool + textBytes / rText
 *
 * Two accepted live sends (ask 0 and ask 1) solve the two unknowns; every later
 * send is predicted from its OWN tool/text split. This is a linear system
 * (u = 1/rTool, v = 1/rText), so the degenerate cases are the ones with no
 * useful second equation: no tool bytes, no text bytes, or points that lie on
 * one line through the origin. Note that IDENTICAL toolBytes alone is NOT
 * degenerate — it is the pilot's case (the schema is constant); the text
 * difference between the two points isolates rText, and rTool follows.
 */
export function twoPointRulerOf({ first, second }) {
  const valid = point => point !== null && typeof point === "object"
    && Number.isSafeInteger(point.toolBytes) && point.toolBytes >= 0
    && Number.isSafeInteger(point.textBytes) && point.textBytes >= 0
    && Number.isSafeInteger(point.providerPromptTokens) && point.providerPromptTokens > 0;
  const unsolved = reason => ({ ok: false, reason, rTool: null, rText: null,
    solvedFrom: null });
  if (!valid(first) || !valid(second)) return unsolved("usage-absent");
  if (first.toolBytes === 0 || second.toolBytes === 0) return unsolved("no-tool-bytes");
  if (first.textBytes === 0 || second.textBytes === 0) return unsolved("no-text-bytes");
  const t0 = first.toolBytes, x0 = first.textBytes, n0 = first.providerPromptTokens;
  const t1 = second.toolBytes, x1 = second.textBytes, n1 = second.providerPromptTokens;
  const det = t0 * x1 - t1 * x0;
  if (det === 0) return unsolved("dependent-points");
  const rTool = det / (n0 * x1 - n1 * x0);
  const rText = det / (t0 * n1 - t1 * n0);
  if (!Number.isFinite(rTool) || !Number.isFinite(rText) || rTool <= 0 || rText <= 0) {
    return unsolved("non-positive-ruler");
  }
  const askOf = (point, fallback) => (Number.isSafeInteger(point.askIndex)
    ? point.askIndex : fallback);
  return { ok: true, reason: null, rTool, rText,
    solvedFrom: [askOf(first, 0), askOf(second, 1)] };
}

/** `toolBytes/rTool + textBytes/rText`; null when a term has no ruler. */
export function predictPromptTokensOf({ toolBytes, textBytes, rTool, rText }) {
  const known = Number.isSafeInteger(toolBytes) && toolBytes >= 0
    && Number.isSafeInteger(textBytes) && textBytes >= 0
    && Number.isFinite(rTool) && rTool > 0 && Number.isFinite(rText) && rText > 0;
  return known ? toolBytes / rTool + textBytes / rText : null;
}

/**
 * The calibrated token reading for one send's byte component. `tokenBase` is 0
 * on the SURFACE path (the whole body is the component); on the HOST path it is
 * the measured provider depth at the fire's step, and `bodyBytes` is only the
 * ask plus the step's units — all text, so `toolBytes` is 0 there.
 *
 * The two-density prediction is used when ask 0 and ask 1 solved it; otherwise
 * the single ratio from ask 0 applies and `rulerFallback` states why (a
 * degenerate solve, or a run that has not reached ask 2 yet).
 */
export function tokenDepthOf({ tokenRuler, tokenBase = 0, toolBytes = 0, bodyBytes,
  useTwoDensity = true }) {
  const known = tokenRuler !== null && tokenRuler !== undefined
    && Number.isSafeInteger(tokenBase) && tokenBase >= 0
    && Number.isSafeInteger(toolBytes) && toolBytes >= 0
    && Number.isSafeInteger(bodyBytes) && bodyBytes >= 0;
  const textBytes = known ? bodyBytes - toolBytes : null;
  if (!known || textBytes < 0) {
    return { tokens: null, rulerModel: null, predictedTokens: null, rTool: null,
      rText: null, solvedFrom: null, rulerFallback: false, toolBytes, textBytes };
  }
  // Ask 1 (and its correction) stays on the single ratio by rule; only ask 2
  // and later use the solved two-density model.
  const solved = useTwoDensity ? (tokenRuler.solved ?? null) : null;
  if (solved !== null) {
    const predicted = predictPromptTokensOf({ toolBytes, textBytes,
      rTool: solved.rTool, rText: solved.rText });
    if (predicted !== null) {
      const tokens = Math.round(tokenBase + predicted);
      return { tokens, predictedTokens: tokens, rulerModel: "two-density",
        rTool: solved.rTool, rText: solved.rText, solvedFrom: solved.solvedFrom,
        rulerFallback: false, toolBytes, textBytes };
    }
  }
  const tokens = Math.round(tokenBase + bodyBytes / tokenRuler.bytesPerToken);
  return { tokens, predictedTokens: tokens, rulerModel: "single", rTool: null, rText: null,
    solvedFrom: null, rulerFallback: tokenRuler.rulerFallback === true, toolBytes, textBytes };
}

/**
 * The `tokenRuler` verdict carried by EVERY send record: the two densities the
 * band used (null until ask 1 has solved them), the prediction it banded
 * against, the provider's own count, and the signed percent between them.
 * `rulerModel` says which model produced `predictedTokens`; `rulerFallback`
 * says the two-point solve was degenerate and the single ratio stood in.
 */
export function tokenRulerRecordOf({ run = null, used = null, toolBytes = null,
  textBytes = null, predictedTokens = null, providerPromptTokens = null,
  deltaPercent = null, drift = null, rulerFallback = false }) {
  return {
    rTool: used?.rTool ?? null,
    rText: used?.rText ?? null,
    solvedFrom: used?.solvedFrom ?? null,
    predictedTokens: predictedTokens ?? null,
    providerPromptTokens: providerPromptTokens ?? null,
    deltaPercent: deltaPercent ?? null,
    drift: drift ?? null,
    bytesPerToken: run?.bytesPerToken ?? null,
    fromAsk: run?.fromAsk ?? null,
    source: run?.source ?? null,
    toolBytes: Number.isSafeInteger(toolBytes) ? toolBytes : null,
    textBytes: Number.isSafeInteger(textBytes) ? textBytes : null,
    rulerModel: used !== null ? "two-density" : (run !== null ? "single" : "none"),
    ...(rulerFallback ? { rulerFallback: true } : {}),
  };
}

/**
 * The request's messages: the real system slot, the given turns, and the real
 * ask. Kept for the probe tests; the live path uses `promptForFire`, which
 * builds from the measured surface. No turn is trimmed.
 */
export function promptOf({ system, ask, turns }) {
  const fixed = Buffer.byteLength(system, "utf8") + Buffer.byteLength(ask, "utf8");
  const fixedTokens = measuredTokensOf(fixed);
  let contextTokens = 0;
  for (const turn of turns) contextTokens += measuredTokensOf(Buffer.byteLength(turn.text, "utf8"));
  return {
    messages: [
      { role: "system", content: system },
      ...turns.map(turn => ({ role: turn.role, content: turn.text })),
      { role: "user", content: ask },
    ],
    contextTurns: turns.length,
    fixedTokens,
    contextTokens,
    estimatedTokens: fixedTokens + contextTokens,
  };
}

/**
 * The stub's answer: valid wire JSON over every index, deterministic so the
 * offline end-to-end exercises real parsing. Every fourth row keeps; the rest
 * forget; ask 1 omits its last index so one row refuses without breaking the
 * object (a missing key), which is a shape the parser must keep.
 *
 * `jsonl-20` speaks its own wire and nothing else changes: ONE single-key
 * object per row per line, keyed by that row's own index and carrying that
 * grammar's verdict shape — `{"1":{"keepall":true}}` or
 * `{"2":{"forgetall":true,"summary":"..."}}`. It answers every row, because the
 * missing-index shape above belongs to the assembled object and this grammar
 * has its own row-level codes. `jsonl-20-nokeepall` speaks the same wire with
 * `keepall` replaced by a line-1 `keeplines`, the one keep shape its grammar
 * admits; every keep row there therefore frees the rest of its body. Every
 * other grammar (`3option`, `two-option`, `forgetlines`, `keeplines-60`)
 * returns the shipped assembled object byte for byte, so no existing lane's
 * bytes move.
 */
export function stubAnswerOf(indices, askIndex = 0, grammar = DEFAULT_ASK_GRAMMAR) {
  if (grammar === "jsonl-20" || grammar === "jsonl-20-nokeepall") {
    const noKeepall = grammar === "jsonl-20-nokeepall";
    const lines = [];
    for (const [at, index] of indices.entries()) {
      const verdict = at % 4 !== 0
        ? { forgetall: true, summary: `stub forgotten result ${String(index)}` }
        : noKeepall
          ? { keeplines: [[1, 1]], summary: `stub kept result ${String(index)}` }
          : { keepall: true };
      lines.push(JSON.stringify({ [index]: verdict }));
    }
    return lines.join("\n");
  }
  const body = {};
  for (const [at, index] of indices.entries()) {
    if (askIndex === 1 && at === indices.length - 1) continue;
    body[index] = at % 4 === 0
      ? { keepall: true }
      : { forgetall: `stub forgotten result ${String(index)}` };
  }
  return JSON.stringify(body);
}

/**
 * `answered`/`refused` rows as counts plus the per-row detail the log keeps. A
 * refused row carries its coarse `code` AND the detail `batch-ask.ts:96-98`
 * drops (`wireCode`, `message`) when the caller passes `wireDetailsOf`'s map.
 *
 * `keep` and `forget` partition the ANSWERED rows by verdict, the same way the
 * row reader does (`tools/analyze-incremental.mjs` and the campaign scripts):
 * `keepall` and `keeplines` are kept, `forgetall` and `forgetlines` are
 * forgotten. `keeplines` is a tag on top of that partition, never a second
 * verdict, so `keep + forget + refused === rows.length` always holds. A
 * keep-whole `keeplines` is a `keeplines` row and is therefore already a keep;
 * whether it removed bytes is `appliedForgets`' business, not this count's.
 *
 * ISSUE-175: `forget` used to be `rows.length - keep - refused`, which swept
 * every `keeplines` row into `forget` and inflated the published forget-answer
 * figures. `options.grammar` and `options.lineCounts` are no longer read here;
 * the fourth argument stays in the signature so existing call sites read the
 * same, and passing them changes nothing.
 */
export function distributionOf(parsed, units, details = new Map(), _options = {}) {
  const rows = parsed.map((row, at) => {
    const unit = units[at];
    if (row.status !== "answered") {
      const detail = details.get(row.index);
      return { index: row.index, unitId: unit?.id ?? null, status: "refused",
        action: null, code: row.code,
        wireCode: detail?.wireCode ?? null, message: detail?.message ?? null };
    }
    const answer = row.answer;
    return { index: row.index, unitId: unit?.id ?? null, status: "answered",
      action: answer.action, ...(answer.summary === undefined ? {} : { summary: answer.summary }),
      ...(answer.ranges === undefined ? {} : { ranges: answer.ranges }) };
  });
  const refused = rows.filter(row => row.status === "refused").length;
  // The partition is classified per row, never by subtraction: a `keeplines`
  // row is a keep, so `keep + forget + refused === rows.length` by construction.
  const keep = rows.filter(row => row.status === "answered"
    && VERDICT_KEPT.has(row.action)).length;
  const keeplines = rows.filter(row =>
    row.status === "answered" && row.action === "keeplines").length;
  const forget = rows.filter(row => row.status === "answered"
    && !VERDICT_KEPT.has(row.action)).length;
  return { keep, forget, refused, keeplines, rows };
}

/**
 * Row refusals keyed by the reader's OWN code: `spans-outside-result`,
 * `answer-unreadable`, `action-not-in-grammar`, `missing-index`, ... The
 * ROW-level twin of `refusalClasses`, which books refused SENDS under their
 * `failureClass` and never reads a row. The two maps are kept apart on purpose
 * (ISSUE-184): a row the parser refused is not a failed send, and a send that
 * never read a row (a non-2xx, a cut stream, a deadline) has no row class. The
 * counts sum to `distribution.refused` over the same rows, so a run's `refused`
 * and its `rowRefusalClasses` agree by construction.
 */
export function rowRefusalClassesOf(rows) {
  const classes = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== "object" || row.status !== "refused") continue;
    const code = typeof row.code === "string" && row.code.length > 0 ? row.code : "unknown";
    classes[code] = (classes[code] ?? 0) + 1;
  }
  return classes;
}

/** Add one send's row classes into the run summary's own map. */
function foldRowRefusalClasses(summary, classes) {
  for (const [code, count] of Object.entries(classes)) {
    summary.rowRefusalClasses[code] = (summary.rowRefusalClasses[code] ?? 0) + count;
  }
}

/**
 * The measured depth reading at or before the fire's OWN step: the BASE of a
 * host-path anchor, never the whole anchor. The provider's `prompt_tokens`
 * includes the ask the recording never carried, and it does not include any
 * result that landed at that step (that step's reading is the request that
 * PRODUCED those results), so `askAndApply` adds the ask bytes on both host
 * paths and EVERY unit that landed at the fire's step (P7); `anchorBasis` names
 * the additions and `anchorAddedUnits`/`anchorAddedUnitTokens` count them. The
 * old reader took the first step AFTER the fire, which is the request the NEXT
 * fire would send.
 */
export function anchorDepthOf(depths, fireStep) {
  let chosen = null;
  for (const entry of depths) {
    if (entry.step > fireStep) break;
    chosen = entry;
  }
  return chosen === null ? { step: null, tokens: null } : chosen;
}

/**
 * After a fire applied at least one forget, the NEXT fire's prompt must still
 * carry that unit shaped. The check reads the PROMPT'S OWN MESSAGES at the
 * position each unit's turn occupies (`turnSeqs`, `buildPrompt`'s parallel
 * array), never the surface map's keys and never a marker line on its own: a
 * marker check passed a prompt whose summary, kept lines or framing had changed
 * while one `[racoons] ` line survived.
 *
 * The expected content is EXACT:
 *
 * - a carried seq's message must equal `"<label>:\n" + surface.get(seq)`;
 * - every non-carried unit turn must equal `"<label>:\n" + unit.text`, so a
 *   shaped body smuggled into a unit the run did not carry refuses too.
 *
 * `<label>` is the surface's own label map (`callNames`, `callLabelOf`'s
 * answer), never a second spelling. A missing shaped body refuses
 * `sim-batch-carry-missing`; a seq with no message refuses
 * `sim-batch-carry-unrendered`; a body that differs by one byte refuses
 * `sim-batch-carry-body-mismatch` and names the first differing byte.
 */
export function assertCarriedOverrides({ requiredSeqs = [], surface = null, messages = [],
  turnSeqs = [], units = [], callNames = new Map(), fireStep }) {
  if (!Array.isArray(requiredSeqs) || !Array.isArray(messages)) {
    refuse("sim-batch-carry-invalid", "carry lists are arrays of unit seqs and messages");
  }
  if (!(surface instanceof Map)) {
    refuse("sim-batch-carry-invalid",
      `the carry check reads the surface Map the prompt was built from, got ${String(surface)}`);
  }
  // The exact check needs the position each turn occupies. A caller that passes
  // messages without `buildPrompt`'s turnSeqs cannot bind a body to a turn, and
  // a substring check is the defect this guard exists to remove.
  if (!Array.isArray(turnSeqs) || turnSeqs.length !== messages.length) {
    refuse("sim-batch-carry-invalid",
      `the carry check needs buildPrompt's turnSeqs (one entry per message), got`
      + ` ${String(turnSeqs?.length)} entries for ${String(messages.length)} message(s)`);
  }
  const unitBySeq = new Map((Array.isArray(units) ? units : [])
    .filter(unit => Number.isSafeInteger(unit?.seq) && typeof unit?.text === "string")
    .map(unit => [unit.seq, unit]));
  const carried = new Set(requiredSeqs);
  const missing = new Set();
  const unrendered = new Set();
  const mismatched = [];
  let overridden = 0;
  // A carried seq the prompt has no turn for at ALL is the same defect as one
  // whose position holds no message: the surface holds the override and the
  // wire does not show it. Checked before the positions so an absent turn cannot
  // fall out of the loop unexamined.
  const presentSeqs = new Set(turnSeqs.filter(seq => Number.isSafeInteger(seq)));
  for (const seq of requiredSeqs) {
    const held = surface.get(seq);
    if (typeof held !== "string" || held.length === 0) missing.add(seq);
    else if (!presentSeqs.has(seq)) unrendered.add(seq);
  }
  const firstDifference = (expected, actual) => {
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(actual, "utf8");
    const at = Math.min(left.length, right.length);
    let offset = 0;
    while (offset < at && left[offset] === right[offset]) offset += 1;
    return { offset, expectedBytes: left.length, actualBytes: right.length };
  };
  for (const [at, seq] of turnSeqs.entries()) {
    if (!Number.isSafeInteger(seq)) continue;
    const unit = unitBySeq.get(seq);
    const isCarried = carried.has(seq);
    // A seq that is neither carried nor one of the timeline's units is not a
    // tool-result turn this check can speak about (the seqs are unique, so this
    // is the system slot, the ask, or a row type with no unit).
    if (!isCarried && unit === undefined) continue;
    const message = messages[at];
    if (message === undefined) { unrendered.add(seq); continue; }
    let body;
    if (isCarried) {
      const held = surface.get(seq);
      if (typeof held !== "string" || held.length === 0) { missing.add(seq); continue; }
      body = held;
      overridden += 1;
    } else {
      body = unit.text;
    }
    const label = callNames.get(seq) ?? "tool result";
    const expected = `${label}:\n${body}`;
    const actual = typeof message?.content === "string" ? message.content : "";
    if (actual !== expected) {
      const diff = firstDifference(expected, actual);
      mismatched.push(`${String(seq)} at message ${String(at)} (first difference at byte`
        + ` ${String(diff.offset)}; expected ${String(diff.expectedBytes)} B, got`
        + ` ${String(diff.actualBytes)} B: ${JSON.stringify(actual.slice(0, 80))})`);
    }
  }
  if (missing.size > 0) {
    refuse("sim-batch-carry-missing",
      `fire at step ${String(fireStep)} must carry unit seq ${[...missing].join(", ")} shaped,`
      + " but the surface holds no shaped body for it; an earlier fire booked a removal this"
      + " run can no longer render");
  }
  if (unrendered.size > 0) {
    refuse("sim-batch-carry-unrendered",
      `fire at step ${String(fireStep)} must carry unit seq ${[...unrendered].join(", ")}, but`
      + " the prompt's own messages carry no turn at that position; the surface holds the"
      + " override and the wire does not show it, so the carried count was a map key");
  }
  if (mismatched.length > 0) {
    refuse("sim-batch-carry-body-mismatch",
      `fire at step ${String(fireStep)} does not carry the exact body the surface holds for`
      + ` ${mismatched.join("; ")}; a marker line alone is not the carried override, and the`
      + " prompt must carry the shaped body byte for byte");
  }
  return { required: requiredSeqs.length, overridden };
}

/**
 * Every unit the fire TABLED must appear in the messages it built. `built` is
 * `buildPrompt`'s own `turnSeqs` (one entry per message: the turn's seq, or
 * null for the system slot and the ask), so a tabled row that `surfaceAt`
 * filtered out — shadowed, owned by a later step, rewound as the ask exchange —
 * is a named refusal here instead of a batch size that overstates the prompt.
 */
export function assertBatchInPrompt({ units = [], turnSeqs = [], fireStep }) {
  if (!Array.isArray(units) || !Array.isArray(turnSeqs)) {
    refuse("sim-batch-batch-unrendered", "the batch check reads unit and turn lists");
  }
  const present = new Set(turnSeqs.filter(seq => Number.isSafeInteger(seq)));
  const missing = units.filter(unit => !present.has(unit.seq)).map(unit => unit.seq);
  if (missing.length > 0) {
    refuse("sim-batch-batch-unrendered",
      `fire at step ${String(fireStep)} tabled ${String(units.length)} unit(s) but the built`
      + ` messages carry no turn for seq ${missing.join(", ")}; a tabled row was absent`
      + " from the prompt (a shadowed, later-step or replayed row is not a batch row)");
  }
  return { tabled: units.length, rendered: units.length - missing.length };
}

/**
 * The surface a DECISION LOG describes (`reconstructedSurfaceOf` lives in the
 * units module, beside `renderMoment` and `applyFireToSurface`, so the plan
 * lane and the live lane share ONE rebuild). Each answered decision is rendered
 * from the body the rebuilt surface holds at that point — the landed text for a
 * first ask, the rebuilt shaped body for a re-asked row under `kept` — in log
 * order. A unit the host had removed at the decision's own `fireStep` is
 * skipped, because no prompt for that fire carried it.
 *
 * The rebuild reads `decisions`, `units` and `timeline`; it never reads the
 * run's `surface` or `applyFireToSurface`'s `applied` map. A writer that puts
 * its wrong body into BOTH the surface and its applied map therefore fails the
 * digest comparison: the expected digest comes from the log, not from the
 * writer's own output.
 */

/**
 * After a fire, the surface must be the SAME surface, advanced exactly one fire
 * and holding exactly the shaped turns the decision log describes. The fire
 * stamp alone proves nothing: `simulateSurface({ fireIndex: n })` built fresh at
 * fire n matches it while holding no removals.
 *
 * The size check compares the surface's CURRENT size (`surfaceSizeOf`) to
 * `expectedSize`, the size of the surface the DECISION LOG rebuilds
 * (`reconstructedSurfaceOf`). It used to compare
 * `surfaceShapesEverAppliedOf` to the run's own `appliedForgets`: two counters
 * incremented under the same predicate, so the comparison could only fail if
 * the surface object itself were swapped. The current size against a rebuild
 * from the decision log (independent of the writer's BOOKKEEPING, though it
 * shares `renderMoment`) is a check that can fail on its own.
 *
 * The content DIGEST is the third: two surfaces with the same count but
 * different bodies (a swapped summary, one changed byte) pass the size and fail
 * the digest. `expectedDigest` is the digest of that same rebuild, never the
 * digest of the surface being checked.
 */
export function assertSurfaceAdvanced({ surface, fire, shaped, expectedSize = null,
  expectedDigest = null }) {
  const stamped = surfaceFireOf(surface);
  if (stamped !== fire) {
    refuse("sim-batch-surface-identity",
      `after fire ${String(fire)} the surface is stamped for fire ${String(stamped)}; the`
      + " run holds ONE surface, advanced once per fire");
  }
  if (Number.isSafeInteger(expectedSize) && surfaceSizeOf(surface) !== expectedSize) {
    refuse("sim-batch-surface-removals",
      `after fire ${String(fire)} the surface currently holds ${String(surfaceSizeOf(surface))}`
      + ` shaped turn(s) but the decision log rebuilds ${String(expectedSize)}; a fresh`
      + ` simulateSurface({fireIndex: ${String(fire)}}) passes the fire stamp and drops`
      + " every earlier removal");
  }
  const digest = surfaceDigestOf(surface);
  if (expectedDigest !== null && digest !== expectedDigest) {
    refuse("sim-batch-surface-digest",
      `after fire ${String(fire)} the surface's content digest is ${digest} but the decision`
      + ` log's rebuilt surface hashes to ${String(expectedDigest)}; the shaped count agrees and`
      + " the bodies do not, so a surface with the same number of different overrides would pass"
      + " a count-only check");
  }
  return { fire, shaped, digest };
}

/**
 * The run's carried seqs must be EXACTLY the decision log's shaped set, minus
 * the seqs the host had removed by this fire (P7). `carrySet` is maintained from
 * the fire's applied/restored lists; the shaped set is rebuilt from the decision
 * log. A divergence means one of the two records is lying about the surface the
 * next prompt will carry.
 */
export function assertCarrySetMatches({ carrySeqs = [], shapedNow = [], fire }) {
  const carried = [...carrySeqs].map(Number).sort((left, right) => left - right);
  const shaped = [...shapedNow].map(Number).sort((left, right) => left - right);
  if (carried.join(",") !== shaped.join(",")) {
    refuse("sim-batch-carry-set-mismatch",
      `after fire ${String(fire)} the carry set is [${carried.join(", ")}] but the decision`
      + ` log's shaped set is [${shaped.join(", ")}]; the next prompt would carry a`
      + " different surface than the answers describe");
  }
  return { fire, carried: carried.length };
}

/**
 * Every reason a run is NOT citable, in one canonical order. A run with any
 * reason is not evidence; `measurement.reasons` carries the full list and the
 * README states what each one means. The list is deliberately broad: a run that
 * took the stub transport, replayed a host-pruned input, rebuilt a recording,
 * lost an ask, refused answer rows, overflowed the depth series, used a sim-only
 * arm, or carries the input's known deviations is recorded, never silently
 * promoted.
 *
 * `stand-in-context` is on EVERY sim run: the prompt this module sends is a chat
 * stand-in, not the host's wire. `text-source` is on EVERY sim run too: both
 * readings are of the SAME decoded text — the product's body is
 * `TextEncoder().encode(textOf(content))` (`plugin.ts:1111`), a re-encoding of
 * text the host's JSON already carried decoded, so no partial UTF-8 tail is
 * dropped at that seam and a mid-codepoint cut is impossible in a `.v4.jsonl`
 * recording. What the two readings differ on is CONTENT PARTS and malformed
 * parts, which can move line counts, quotes and eligibility (P1).
 * `dropped-parts:<n>` and `dropped-rows:<n>` name the CONTENT LOSSES inside the
 * stand-in itself: parts a prompt dropped (image/file/other non-text) and rows
 * `surfaceAt` skipped whole. `dropped-parts:<n>` is a SUM over the run's
 * prompts, not a count of unique parts: a part on a resent turn counts once per
 * prompt that carried it. Tool-call parts are NOT in either count: the stand-in
 * re-projects them as `Tool call:` turns (`projectedParts`/`projectedRows`,
 * thirteenth audit item 7).
 * They are separate reasons, never folded into `stand-in-context`, so a prompt
 * that lost content cannot read clean after that reason is subtracted (P1).
 * `citable` is therefore ALWAYS false for a sim run, and the summary also
 * records `citableForStandIn`, the reasons MINUS ONLY `stand-in-context`; it
 * retains `text-source` and the two dropped-content reasons, so the state is
 * never empty and never hides a content loss. The stand-in's own two deviations
 * (the invented `"<label>:\n"` line and the dual-reading call projection) are
 * FACTS of `stand-in-context`, stated in `contextStandIn`, not separate reasons.
 *
 * `batch-lane:<n>` and `segment-cut:<n>` state the run's SHAPE: a batch size
 * other than the product's configured `entryAskBatchSize` (1), and a segment
 * cut that dropped `n` later rows before the units were built. A cut run used
 * to report that every unit was asked; now the cut itself is a reason.
 *
 * There is no `sim-only-eligibility:error-result`: the product also drops a
 * failed result before the entry seam (`plugin.ts` `observe` journals
 * `skip`/`failed-result` and returns null, at `:1766,1831`, fed by
 * `toolResultItem` at `:1090-1094,1114`), so the sim's `!isError` filter is the
 * SAME population rule, not a narrower sample. The count stays as
 * `eligibility.excluded.errorResult`, a population split (P9).
 *
 * The counted reasons carry their numbers (`refused-rows:<n>`,
 * `carried-units:<n>`, `dropped-parts:<n>`, `dropped-rows:<n>`,
 * `batch-lane:<n>`, `segment-cut:<n>`, `non-default-floor:<n>`) and the fixed
 * suffixed reasons their one spelling (`sim-only-trigger:depth-tokens`,
 * `sim-only-ask-scope:kept`) so a list is never a bare word.
 * `input-deviation:<id>` is one reason per DETECTED deviation of the input
 * (`inputDeviations` on every send record); the stand-in's own deviations are
 * folded into `stand-in-context`.
 *
 * `reasoning-never-sent` is P3's guard: `runLane` REFUSES such a run by name, so
 * the reason is only reachable from a caller that builds its own reason list.
 * A run that declared reasoning and never put one on the wire is not a reasoning
 * run (ADR-0045).
 *
 * `no-answered-rows` is reachable only when every send FAILED: a run whose rows
 * were all tabled and all REFUSED refuses by name (`sim-batch-no-decided-row`)
 * before a summary is built, so it never carries this reason.
 *
 * `asks < triggers` is NOT a reason: `asks` and `triggers` move in the same call
 * path, so the `assertAskTotals` branch that refuses them is a guard against
 * future drift, not a class any current run can enter.
 */
export const CITABLE_REASONS = Object.freeze([
  "stopped-at-ceiling",
  "stopped-at-budget",
  "zero-reasoning-void-comparison",
  "host-pruner-on",
  "reconstruction",
  "stub-transport",
  "stand-in-context",
  "dropped-parts",
  "dropped-rows",
  "system-absent",
  "system-unreadable",
  "text-source",
  "tools-absent",
  "usage-shape-unverified",
  "synthetic-ruler",
  "sim-only-arm",
  "non-default-grammar",
  "sim-only-trigger",
  "sim-only-ask-scope",
  "first-fire-depth",
  "batch-lane",
  "segment-cut",
  "non-default-floor",
  "no-ask",
  "refused-sends",
  "no-answered-rows",
  "refused-rows",
  "depth-overflow",
  "carried-units",
  "reasoning-never-sent",
  "input-deviation",
]);

/**
 * The reasons whose suffix is a COUNT: a non-negative integer and nothing else.
 * `assertReasonsAllowed` reads its base here, so `batch-lane:anything` and
 * `carried-units:-3` refuse instead of passing a prefix match (P6).
 */
export const COUNTED_REASONS = Object.freeze(new Set([
  "dropped-parts", "dropped-rows", "batch-lane", "segment-cut", "non-default-floor",
  "refused-rows", "carried-units", "usage-shape-unverified",
]));

/**
 * The reasons whose suffix is a fixed WORD, not a count: only the spellings the
 * run actually emits. `sim-only-trigger:bogus` refuses (P6).
 */
export const WORD_SUFFIX_REASONS = Object.freeze(new Map([
  ["sim-only-trigger", Object.freeze(new Set(["depth-tokens"]))],
  ["sim-only-ask-scope", Object.freeze(new Set(["kept"]))],
  // A shipped grammar that is not the product default measures a selectable
  // arm, never the shape a default product run sends.
  ["non-default-grammar", Object.freeze(new Set(
    ASK_GRAMMARS.filter(grammar => grammar !== DEFAULT_ASK_GRAMMAR)))],
  ["input-deviation", Object.freeze(new Set(["agent-instructions-splice",
    "system-model-name"]))],
]));

/**
 * The reason that the run's WIRE is a chat stand-in rather than the host's own.
 * `citableForStandIn` subtracts ONLY this, so every CONTENT dimension the
 * stand-in lost stays in the list: `text-source`, `dropped-parts:<n>` and
 * `dropped-rows:<n>` are retained (P1). The state is therefore never empty, and
 * no content loss is hidden by subtracting the stand-in reason.
 */
export const UNIVERSAL_SIM_REASONS = Object.freeze(["stand-in-context"]);

/** The grammars that exist only in this sim; `3option`, `two-option` and
 * `jsonl-20` all ship (`config.ts` accepts each id; `entry-ask.ts` reads all
 * three). `forgetlines`, `keeplines-60` and `jsonl-20-nokeepall` are the sim's
 * own arms. */
export const SIM_ONLY_GRAMMARS = Object.freeze(new Set([
  "forgetlines", "keeplines-60", "jsonl-20-nokeepall",
]));

export function citableReasonsOf({ stoppedAtCeiling = false, stoppedAtBudget = false,
  voidComparison = false,
  inputHostPruner = "off", reconstruction = false, live = false, grammar = DEFAULT_ASK_GRAMMAR,
  order = "first", syntheticRuler = false, floor = FLOOR_BYTES, asks = 0, triggers = 0,
  refusedSends = 0, answeredRows = null, refusedRows = 0, depthOverflow = false,
  carried = 0, inputDeviations = [], mode = "batch",
  thresholdUnits = DEFAULT_THRESHOLD_UNITS, askScope = DEFAULT_ASK_SCOPE,
  firstFireDepth = null, reasoningSent = null,
  lane = null, productBatchSize = PRODUCT_BATCH_SIZE, segment = null,
  excludedRows = 0, droppedParts = 0, droppedRows = 0, tools = null,
  systemAbsent = false, systemUnreadable = false,
  unverifiedShapeSteps = 0 } = {}) {
  const reasons = [];
  if (stoppedAtCeiling === true) reasons.push("stopped-at-ceiling");
  if (stoppedAtBudget === true) reasons.push("stopped-at-budget");
  if (voidComparison === true) reasons.push("zero-reasoning-void-comparison");
  if (inputHostPruner === "on") reasons.push("host-pruner-on");
  if (reconstruction === true) reasons.push("reconstruction");
  if (live !== true) reasons.push("stub-transport");
  // Unconditional: every prompt this runner sends is the chat stand-in
  // `CONTEXT_STAND_IN` describes, never the host's own wire.
  reasons.push("stand-in-context");
  // P1: the content the stand-in itself lost, one counted reason each. They are
  // NOT folded into `stand-in-context`, so subtracting that reason (the
  // `citableForStandIn` view) cannot make a prompt that dropped an image/file
  // part or a whole row read clean.
  if (!Number.isSafeInteger(droppedParts) || droppedParts < 0) {
    refuse("sim-batch-dropped-parts-invalid",
      `a dropped-parts count is a non-negative integer, got ${String(droppedParts)}`);
  }
  if (!Number.isSafeInteger(droppedRows) || droppedRows < 0) {
    refuse("sim-batch-dropped-rows-invalid",
      `a dropped-rows count is a non-negative integer, got ${String(droppedRows)}`);
  }
  if (droppedParts > 0) reasons.push(`dropped-parts:${String(droppedParts)}`);
  if (droppedRows > 0) reasons.push(`dropped-rows:${String(droppedRows)}`);
  // The prompt's FIRST message is the recording's system prompt. A missing or
  // unreadable one used to be an empty slot with no reason; both are named, so
  // a run whose system slot is empty can never read clean.
  if (systemAbsent === true) reasons.push("system-absent");
  if (systemUnreadable === true) reasons.push("system-unreadable");
  // P2: the tool schema. `tools` is the run's own reading of the recording
  // (`contextStandIn.tools`), passed by `runLane`; `null` means the caller did
  // not read it, and a caller that states it with no header (or an empty array)
  // gets a named reason instead of a silent `tools: []`.
  if (tools !== null) {
    const count = Number.isSafeInteger(tools?.count) ? tools.count : 0;
    if (!Number.isSafeInteger(tools?.seq) || count === 0) reasons.push("tools-absent");
  }
  // P5: a depth reading whose cache shape rests on its own statement alone. The
  // step count is a reason, never a silent trust of the statement.
  if (!Number.isSafeInteger(unverifiedShapeSteps) || unverifiedShapeSteps < 0) {
    refuse("sim-batch-unverified-shape-invalid",
      `an unverified-shape step count is a non-negative integer, got`
      + ` ${String(unverifiedShapeSteps)}`);
  }
  if (unverifiedShapeSteps > 0) {
    reasons.push(`usage-shape-unverified:${String(unverifiedShapeSteps)}`);
  }
  // Unconditional too: both readings are of the SAME decoded JSON text. The
  // product's body is `TextEncoder().encode(textOf(content))`
  // (`plugin.ts:1111`), a re-encoding of text the host already decoded, so no
  // partial UTF-8 tail can be dropped at this seam and a mid-codepoint cut is
  // impossible in a `.v4.jsonl` recording. The two readings differ on CONTENT
  // PARTS and malformed parts (line counts, quotes, eligibility), so no run of
  // this runner is a clean bill for the product's reading (P1). Retained in
  // `citableForStandIn`: the decoded-text reading is a content dimension, not
  // part of the wire.
  reasons.push("text-source");
  // A transport DECLARED live whose bands were graded by the sim's own estimate
  // has no provider grader, whatever its `live` flag says.
  if (live === true && syntheticRuler === true) reasons.push("synthetic-ruler");
  // A sim-only grammar (or any order but `first`) measures an ask the product
  // does not ship; the arm itself is a reason, even on a live transport.
  if (SIM_ONLY_GRAMMARS.has(grammar) || order !== "first") reasons.push("sim-only-arm");
  // A SHIPPED grammar that is not the product default (`jsonl-20`) is selectable
  // but measures a non-default shape; the arm is named, never silently counted
  // as a default run.
  if (!ASK_GRAMMARS.includes(grammar)) {
    refuse("sim-batch-grammar-invalid",
      `a grammar is one of ${ASK_GRAMMARS.join(", ")}, got ${String(grammar)}`);
  }
  if (grammar !== DEFAULT_ASK_GRAMMAR) reasons.push(`non-default-grammar:${grammar}`);
  // The product's trigger takes `count` and `landed-bytes` only (plugin.ts
  // `entryTriggerFor`). `depth-tokens` is this sim's own ruler, so a depth lane
  // measures a cadence the product does not have.
  if (mode === "threshold" && thresholdUnits === "depth-tokens") {
    reasons.push("sim-only-trigger:depth-tokens");
  }
  // The product settles a result after one answer (`entryJudged`) and never
  // re-tables it; `--ask-scope kept` re-asks settled rows, so its sample is the
  // sim's.
  if (askScope === "kept") reasons.push("sim-only-ask-scope:kept");
  // A first fire held for an absolute depth the product does not gate.
  if (firstFireDepth !== null && firstFireDepth !== undefined) reasons.push("first-fire-depth");
  // P2: a batch lane at a size the product is not configured for measures a
  // cadence the product does not ship. The product's configured value is
  // `DEFAULT_CONFIG.entryAskBatchSize` (1); anything else is named.
  if (!Number.isSafeInteger(productBatchSize) || productBatchSize < 1) {
    refuse("sim-batch-product-batch-invalid",
      `the product's configured batch size is a positive integer, got`
      + ` ${String(productBatchSize)}`);
  }
  // `lane: null` is a caller that states no lane (the reason-list tests); a real
  // batch run always names one, and `runLane` refuses an invalid size.
  if (mode === "batch" && lane !== null && lane !== undefined) {
    if (!Number.isSafeInteger(lane) || lane < 1) {
      refuse("sim-batch-lane-invalid",
        `a batch lane needs its own positive integer size, got ${String(lane)}`);
    }
    if (lane !== productBatchSize) reasons.push(`batch-lane:${String(lane)}`);
  }
  // P3: a segment cut dropped the recording's later rows before any unit was
  // built, so the run's population is the cut's, never the recording's. The
  // count is the number of rows the cut removed, and a cut that removed ZERO
  // rows is not a reason: `segment-cut:0` named a cut that cut nothing
  // (thirteenth audit item 8).
  if (segment !== null && segment !== undefined) {
    if (!Number.isSafeInteger(excludedRows) || excludedRows < 0) {
      refuse("sim-batch-segment-cut-invalid",
        `a segment cut's excluded-row count is a non-negative integer, got`
        + ` ${String(excludedRows)}`);
    }
    if (excludedRows > 0) reasons.push(`segment-cut:${String(excludedRows)}`);
  }
  // Any floor but the product's own answer changes the sample.
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid",
      `a floor is a non-negative integer, got ${String(floor)}`);
  }
  if (floor !== FLOOR_BYTES) reasons.push(`non-default-floor:${String(floor)}`);
  if (!Number.isSafeInteger(asks) || asks <= 0) reasons.push("no-ask");
  if (refusedSends > 0) reasons.push("refused-sends");
  if (answeredRows === 0) reasons.push("no-answered-rows");
  if (!Number.isSafeInteger(refusedRows) || refusedRows < 0) {
    refuse("sim-batch-refused-rows-invalid",
      `a refused-row count is a non-negative integer, got ${String(refusedRows)}`);
  }
  if (refusedRows > 0) reasons.push(`refused-rows:${String(refusedRows)}`);
  if (depthOverflow === true) reasons.push("depth-overflow");
  if (!Number.isSafeInteger(carried) || carried < 0) {
    refuse("sim-batch-carry-invalid", `a carried count is a non-negative integer, got ${String(carried)}`);
  }
  if (carried > 0) reasons.push(`carried-units:${String(carried)}`);
  // P3's belt and braces: `runLane` REFUSES this run by name before a summary is
  // written, so this branch is a guard for a caller that builds a reason list
  // from its own records. A `null` means the caller did not read the sends.
  if (reasoningSent === false) reasons.push("reasoning-never-sent");
  // The known input/stand-in deviations, one reason each. A deviation without
  // its own reason string still gets its id, never a silent pass.
  for (const deviation of Array.isArray(inputDeviations) ? inputDeviations : []) {
    const id = typeof deviation?.id === "string" && deviation.id !== "" ? deviation.id : null;
    if (id === null) {
      refuse("sim-batch-input-deviation-invalid",
        "an input deviation needs a non-empty id; a reason that cannot name it is not a reason");
    }
    reasons.push(typeof deviation.citationReason === "string" && deviation.citationReason !== ""
      ? deviation.citationReason : `input-deviation:${id}`);
  }
  return reasons;
}

/**
 * P9/P6: every reason a run EMITS must be one the allow-list names, in the exact
 * spelling the allow-list uses. The list is compared here, at the end of
 * `runLane`, against the reasons the run actually produced — not only against
 * its own literal in a test.
 *
 * A suffixed reason is checked by its KIND, never by a prefix:
 *
 * - a COUNTED reason (`dropped-parts:<n>`, `dropped-rows:<n>`, `batch-lane:<n>`,
 *   `segment-cut:<n>`, `non-default-floor:<n>`, `refused-rows:<n>`,
 *   `carried-units:<n>`) takes a non-negative integer and nothing else, so
 *   `batch-lane:anything` and `carried-units:-3` refuse;
 * - a WORD-SUFFIX reason (`sim-only-trigger:depth-tokens`,
 *   `sim-only-ask-scope:kept`, `input-deviation:<id>`) takes only the spellings
 *   the run can emit, so `sim-only-trigger:bogus` refuses.
 *
 * Before this rule a base-prefix match accepted any suffix, so a bogus reason
 * passed the allow-list whenever its base was declared (P6).
 */
export function assertReasonsAllowed(reasons) {
  if (!Array.isArray(reasons)) {
    refuse("sim-batch-reason-invalid", "a reason list is an array of strings");
  }
  const exact = new Set(CITABLE_REASONS);
  for (const reason of reasons) {
    if (typeof reason !== "string" || reason === "") {
      refuse("sim-batch-reason-invalid",
        `a reason is a non-empty string, got ${String(reason)}`);
    }
    if (exact.has(reason)) continue;
    const at = reason.indexOf(":");
    if (at === -1) {
      refuse("sim-batch-reason-unknown",
        `the run emitted the reason "${reason}", which is not in CITABLE_REASONS;`
        + " an undeclared reason is a citation state nobody reviewed");
    }
    const base = reason.slice(0, at);
    const suffix = reason.slice(at + 1);
    if (!exact.has(base)) {
      refuse("sim-batch-reason-unknown",
        `the run emitted the reason "${reason}", whose base "${base}" is not in`
        + " CITABLE_REASONS; an undeclared reason is a citation state nobody reviewed");
    }
    if (COUNTED_REASONS.has(base)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
        refuse("sim-batch-reason-unknown",
          `the run emitted the reason "${reason}", but "${base}" takes a non-negative`
          + ` integer count and "${suffix}" is not one`);
      }
      continue;
    }
    const allowed = WORD_SUFFIX_REASONS.get(base);
    if (allowed !== undefined && allowed.has(suffix)) continue;
    refuse("sim-batch-reason-unknown",
      `the run emitted the reason "${reason}", which is not a declared spelling of`
      + ` "${base}"; the allow-list names`
      + ` ${allowed === undefined ? "no such suffixed reason" : [...allowed].join(", ")}`);
  }
  return reasons;
}

/**
 * The run's ask totals. A run that asked nothing is refused by name
 * (`sim-batch-no-ask`); a trigger that produced no ask is refused too, because
 * the lane's own counts would otherwise describe a fire nobody asked.
 *
 * The `asks !== triggers` branch CANNOT fire today: `summary.triggers` and
 * `summary.asks` move in the same `fireOf` call path, and a failed send still
 * counts as an ask, so the two are equal by construction. The branch is kept as
 * a guard against a future path that increments one count without the other; the
 * README says it is a guard, never a reachable class, and `CHECK_CLASSES`
 * (`sim-batch-units.mjs`) records the check as `not-applicable`.
 * `assertAskTotals` runs at
 * EVERY fire (right after `askAndApply` returns) and once at the end, so such a
 * drift would fail at the fire that introduced it, not only in the summary.
 */
export function assertAskTotals({ asks, triggers }) {
  if (!Number.isSafeInteger(asks) || !Number.isSafeInteger(triggers)) {
    refuse("sim-batch-ask-totals", `ask totals are integers, got ${String(asks)} and ${String(triggers)}`);
  }
  if (asks <= 0) {
    refuse("sim-batch-no-ask",
      "the lane asked nothing; a summary over zero asks is not a measurement");
  }
  if (asks !== triggers) {
    refuse("sim-batch-ask-totals",
      `the lane reports ${String(asks)} ask(s) for ${String(triggers)} trigger(s); a trigger`
      + " that produced no ask is a lost fire, never a smaller run");
  }
  return { asks, triggers };
}

/**
 * The run's OWN outcome for every check `CHECK_CLASSES` catalogues. The catalog
 * says why a class cannot fail; this field says what THIS run did with it:
 *
 * - `measured` means the comparison ran over a non-empty population (the count
 *   below is that population's size), so its agreement is a reading of real
 *   inputs — still never a passing measurement of the product, because the
 *   catalog says the two sides cannot disagree.
 * - `definitional` means the comparison ran over a non-empty population but its
 *   two sides are the same set (or the same path) counted twice, so its
 *   agreement is a construction property, not a reading; the count below is the
 *   population that made it non-empty.
 * - `not-applicable` means the run compared an empty set with itself (0 to 0):
 *   the check was vacuous here, and the count that made it so is `count`.
 *
 * `asks-equal-triggers` and `reasoning-turns-equal-resendable-blocks` are
 * `definitional` whenever their population is non-empty — they agree by
 * construction, matching their catalog entries — and `not-applicable` on an
 * empty population. Neither is ever `measured`.
 *
 * `count` is always the reading that decided the outcome, and `countName` names
 * it so a reader never guesses what N counts. The catalog stays the
 * documentation; this list is the run's, so two runs with different populations
 * carry different outcomes (fourteenth audit item 5).
 */
export function checkOutcomesOf({ asks = 0, reasoningTurns = 0, replayedPrunes = 0,
  ignoreHostPrunes = null, decidedRows = 0, reasoningMessages = 0,
  carriedOverrides = 0 } = {}) {
  const rules = new Map([
    // The guard compares two counters that move in one path: with at least one
    // ask the equality is definitional, not a reading of two independent sides.
    ["asks-equal-triggers", { outcome: asks > 0 ? "definitional" : "not-applicable",
      count: asks, countName: "asks" }],
    // Definitional equality read off the same reasoning parts: with any turn it
    // is the catalog's `definitional` class, never a measured comparison.
    ["reasoning-turns-equal-resendable-blocks", {
      outcome: reasoningTurns > 0 ? "definitional" : "not-applicable",
      count: reasoningTurns, countName: "reasoningTurns" }],
    // The zero this check prints is structural; the run's own reading of it is
    // the SOURCE count before the filter. A pruner-on run never runs the zero
    // check, and a source with no prune event filtered nothing.
    ["pruner-off-prune-journals-zero", {
      outcome: ignoreHostPrunes === true && replayedPrunes > 0
        ? "measured" : "not-applicable",
      count: replayedPrunes, countName: "replayedPrunes" }],
    // The surface gate compares bodies only when the decision log answered one.
    ["surface-advanced-empty-decision-log", {
      outcome: decidedRows > 0 ? "measured" : "not-applicable",
      count: decidedRows, countName: "decidedRows" }],
    // The ordered reasoning-pair comparison had a pair to compare only when a
    // send carried a reasoning turn.
    ["reasoning-in-prompt-zero-declared", {
      outcome: reasoningMessages > 0 ? "measured" : "not-applicable",
      count: reasoningMessages, countName: "reasoningMessages" }],
    // A fire that carries no shaped seq compares no carried body byte for byte.
    ["carried-overrides-no-carries", {
      outcome: carriedOverrides > 0 ? "measured" : "not-applicable",
      count: carriedOverrides, countName: "carriedOverrides" }],
  ]);
  return CHECK_CLASSES.map(entry => {
    const rule = rules.get(entry.id);
    if (rule === undefined) {
      // A catalog entry with no per-run rule would silently fall back to the
      // static class, which is the defect this field removes.
      refuse("sim-batch-check-unknown",
        `the check catalog names ${entry.id}, which has no per-run outcome rule; add one`
        + " so the run states whether the check measured anything");
    }
    return {
      name: entry.id, class: entry.class, outcome: rule.outcome,
      count: rule.count, countName: rule.countName,
    };
  });
}

/** One unit as the renderer's moment (`sim-batch-units`' own shape). */
function momentOf(unit, timeline, lane) {
  return {
    id: unit.id, lane, seq: unit.seq, step: unit.step,
    session: timeline.session, original: { text: unit.text },
  };
}

/**
 * The transport-boundary reasoning check (ADR-0045): the request a transport
 * receives must carry exactly the resendable turns the TIMELINE places at that
 * fire's step, per turn. The ruler comes from `expectedReasoningAt`, never from
 * `request.reasoningMessages` (which the same builder wrote): comparing the
 * builder's number to messages the builder produced is a check that cannot
 * fail. Three checks run before the transport sees a byte:
 *
 * - the builder's own count agrees with the timeline (a lost turn by name);
 * - the ordered `(turnSeq, sha256(reasoning_content))` PAIR list equals the
 *   timeline's (a same-length substitution or a normalisation moves a hash and
 *   leaves count and byte sum untouched; a swap of turn A's reasoning onto turn
 *   B moves the pair's turnSeq);
 * - the record's `reasoningWireBytes` is the wire form of the messages that are
 *   actually being sent, recomputed here — never trusted as a copied field.
 *
 * A zero-reasoning run has nothing to carry and is not wrapped.
 */
export function withReasoningBoundary(transport, timeline) {
  const required = (timeline?.reasoningBlocks ?? 0) > 0;
  if (!required) return transport;
  return {
    ...transport,
    async ask(request) {
      const messages = Array.isArray(request?.messages) ? request.messages : [];
      const texts = reasoningTextsOf(messages);
      const wireBytes = reasoningWireBytesOf(texts);
      const fireStep = request?.fireStep;
      // The timeline is the ruler. Without the fire's step the wrapper cannot
      // count what the prompt owes, and the builder's own number is not a
      // second opinion: the send refuses instead of agreeing with itself.
      if (!Number.isSafeInteger(fireStep)) {
        refuse("sim-batch-reasoning-boundary",
          "the request carries no fireStep; a wrapped transport needs the timeline's own"
          + " step to count the reasoning the prompt must carry (ADR-0045)");
      }
      const expected = expectedReasoningAt({ timeline, fireStep });
      if (request?.reasoningMessages !== expected.messages) {
        refuse("sim-batch-reasoning-boundary",
          `the builder states ${String(request?.reasoningMessages)} reasoning turn(s) but`
          + ` the timeline places ${String(expected.messages)} at or before step`
          + ` ${String(fireStep)}; the builder lost the agent's reasoning (ADR-0045)`);
      }
      // The pairs need the turn each message belongs to; without them a swap of
      // two turns' reasoning is invisible to the text list.
      if (!Array.isArray(request?.turnSeqs)) {
        refuse("sim-batch-reasoning-boundary",
          "the request carries no turnSeqs; the boundary cannot bind a reasoning text to"
          + " its turn, so a swap between two turns would pass (ADR-0045)");
      }
      const pairs = reasoningPairsOf(messages, request.turnSeqs);
      const gotHash = reasoningPairsHashOf(pairs);
      if (gotHash !== expected.sha256) {
        refuse("sim-batch-reasoning-boundary",
          `the transport received reasoning hash ${gotHash} but the timeline places`
          + ` ${expected.sha256} at or before step ${String(fireStep)}: the wire lost,`
          + " altered or re-attached one of the agent's reasoning turns (a same-length"
          + " substitution passes a count and a byte sum; it does not pass this pair list)");
      }
      if (request?.reasoningWireBytes !== wireBytes) {
        refuse("sim-batch-reasoning-boundary",
          `the record states reasoningWireBytes ${String(request?.reasoningWireBytes)} but the`
          + ` messages being sent wire to ${String(wireBytes)}; the recorded field is not`
          + " the wire form of this request (ADR-0045)");
      }
      return transport.ask(request);
    },
  };
}

/** The real route; the body is the §3 shape and is self-checked before it leaves. */
export function deepseekTransport(key, { deadline, log = () => {} }) {
  return {
    name: "deepseek", live: true,
    async ask({ messages, tools = [] }) {
      const remain = deadline - Date.now();
      if (remain < 5000) {
        return { ok: false, answered: false, failure: "timeout",
          error: `kill-timer budget too low (${remain} ms)` };
      }
      const timeout = Math.min(CALL_TIMEOUT_MS, remain);
      // Refuse (exit 2) before a byte leaves if the shape is not the real one.
      const body = assertRequestShape({ body: requestBodyOf({ messages, tools }) });
      const started = Date.now();
      let response;
      let raw = "";
      try {
        response = await fetch(`${ROUTE.base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        raw = await response.text();
      } catch (error) {
        const deadlineHit = error?.name === "TimeoutError" || error?.name === "AbortError";
        return { ok: false, answered: false, failure: deadlineHit ? "timeout" : null,
          error: deadlineHit ? `TIMEOUT after ${timeout} ms (aborted)` : String(error?.message ?? error),
          latencyMs: Date.now() - started };
      }
      const latencyMs = Date.now() - started;
      // The shipped reader's semantics (`llm-ask.ts:264-300`), over the SSE wire.
      const stream = readStreamFrames(raw);
      const failure = response.ok ? classifyStream(stream) : null;
      // Whether the TRANSPORT answered this send: a 2xx whose stream reached
      // `[DONE]`. A parse-class failure on such a reply is a MODEL answer the
      // product turns into a row-level KEEP (`llm-ask.ts:314` -> `no-text` ->
      // `batch-ask.ts:197`), never a failed send; a non-2xx, a cut stream and a
      // deadline are not answers and keep `answered: false`.
      const answered = response.ok && stream.done === true;
      const diagnostics = {
        finishReason: stream.finishReason, toolCalls: stream.toolCalls,
        frames: stream.frames, badFrames: stream.badFrames, done: stream.done,
        rawHead: raw.slice(0, 600),
      };
      log(`[ask] http=${response.status} ${latencyMs} ms prompt=${stream.usage?.prompt_tokens ?? "n/a"}`
        + ` total=${stream.usage?.total_tokens ?? "n/a"} content=${stream.text.length} chars`
        + ` finish=${stream.finishReason ?? "n/a"} toolCalls=${stream.toolCalls}`
        + `${failure === null ? "" : ` class=${failure}`}`);
      return {
        ok: response.ok && failure === null, answered, httpStatus: response.status, latencyMs,
        content: stream.text, usage: stream.usage, diagnostics, failure,
        error: response.ok
          ? (failure === null ? null : `stream class ${failure}`)
          : `http ${response.status}: ${raw.slice(0, 300)}`,
      };
    },
  };
}

/**
 * The no-socket transport: the stub's wire JSON, sized usage, zero spend. Its
 * usage is SYNTHETIC — `prompt_tokens` is this sim's own `ceil(bytes/3.04)`
 * estimate fed back — so `ruler:"synthetic"` rides it and the fidelity band
 * never treats it as a grading ruler.
 */
export function stubTransport() {
  return {
    name: "stub", live: false,
    async ask({ ask, indices, estimatedTokens, grammar = DEFAULT_ASK_GRAMMAR }) {
      const content = stubAnswerOf(indices, ask, grammar);
      const completion = measuredTokensOf(Buffer.byteLength(content, "utf8"));
      return { ok: true, httpStatus: null, latencyMs: 0, content,
        usage: { ruler: "synthetic", prompt_tokens: estimatedTokens, completion_tokens: completion,
          total_tokens: estimatedTokens + completion } };
    },
  };
}

function writeJsonl(file, record) {
  const line = `${JSON.stringify(record)}\n`;
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(`${file}.tmp`, previous + line);
  renameSync(`${file}.tmp`, file);
}

/**
 * The partial result artifact a REFUSED run writes: every field the run already
 * knows (the head), the records written so far, the live summary at the refusal
 * when the refusal happened inside `runLane`, and the refusal verbatim. A guard
 * that stops a paid run must leave an artifact on disk, or the run's only
 * evidence is a line on a terminal.
 *
 * `refused` / `refusedAtAsk` / `refusal` are placed AFTER the head, and
 * `records` last, so no prior field can overwrite the refusal.
 */
export function partialResultOf({ head = {}, records = [], refusal, refusedAtAsk = null,
  summary = null, finishedAt = new Date().toISOString() }) {
  return {
    ...head,
    refused: true,
    refusedAtAsk,
    refusal,
    finishedAt,
    citable: false,
    summary,
    records,
  };
}

/** Write one result artifact atomically (`.tmp` then rename). */
export function writeResultArtifact({ target, output, writeFile = writeFileSync,
  rename = renameSync }) {
  writeFile(`${target}.tmp`, `${JSON.stringify(output, null, 2)}\n`);
  rename(`${target}.tmp`, target);
  return target;
}

/**
 * Grade one send's usage against its anchor and record the count it belongs to.
 * A provider reading outside the GROSS band (±25%) refuses a live send and is a
 * recorded warning on the stub. Inside it, a reading 10-25% off is recorded as
 * `tokenRuler.drift: "within-gross-band"` and the run continues: the band is a
 * gross-error guard for a missing or doubled context, and `deltaPercent` is
 * reporting only. A SYNTHETIC reading (the stub's own estimate) is counted as
 * `fidelitySynthetic` and never as a pass: `ok` is null, so no caller can read a
 * zero `fidelityWarnings` as a provider agreement. Absent usage has no ruler and
 * refuses (`usage-absent`).
 *
 * A live provider reading is graded in three stages. Ask 0 has no band (the
 * 3.04 B/token estimate was measured on another route), so its own total
 * bytes/token ratio must land in 2.0-6.0 (`firstSendRulerOf`) and is recorded
 * as `summary.tokenRuler`'s single ratio. Ask 1 is banded ±25% against that
 * single ratio, then becomes the second calibration point. Ask 2 and later are
 * banded ±25% against the TWO-DENSITY prediction `toolBytes/rTool +
 * textBytes/rText` solved from asks 0 and 1 (`twoPointRulerOf`); a degenerate
 * solve falls back to the single ratio and says so (`rulerFallback: true`). A
 * stub send (or any transport reporting `usage.ruler: "synthetic"`) never
 * calibrates; a non-live provider-labelled transport (a test/probe) keeps the
 * pre-pilot ±10% band, recorded as a warning only.
 *
 * `contributesRuler` is false for a correction send: it re-sends the same ask's
 * context and must not become a third calibration point.
 */
function gradeFidelity({ usage, anchor, transport, summary, label, askIndex,
  sentPromptBytes, toolBytes = 0, contributesRuler = true }) {
  const ruler = usage?.ruler === "synthetic" ? "synthetic" : "provider";
  const promptTokens = Number.isSafeInteger(usage?.prompt_tokens)
    ? usage.prompt_tokens : null;
  const knownBytes = Number.isSafeInteger(sentPromptBytes) && sentPromptBytes >= toolBytes;
  const textBytes = knownBytes ? sentPromptBytes - toolBytes : null;
  const used = anchor.rulerModel === "two-density" && anchor.rTool !== null
    ? { rTool: anchor.rTool, rText: anchor.rText, solvedFrom: anchor.solvedFrom }
    : null;
  const record = (predictedTokens = anchor.tokensCalibrated, drift = null) => tokenRulerRecordOf({
    run: summary.tokenRuler, used, toolBytes, textBytes, predictedTokens,
    providerPromptTokens: promptTokens,
    deltaPercent: Number.isSafeInteger(promptTokens) && Number.isSafeInteger(predictedTokens)
      && predictedTokens > 0
      ? (promptTokens - predictedTokens) / predictedTokens * 100 : null,
    drift,
    rulerFallback: used === null && summary.tokenRuler?.rulerFallback === true,
  });
  if (ruler === "synthetic") {
    summary.fidelitySynthetic += 1;
    return { ...providerBandOf({ promptTokens, anchorDepth: anchor.tokens, ruler,
      bandRatio: BAND_DRIFT_RATIO }),
      anchorDepth304: anchor.tokens304, anchorDepthCalibrated: null,
      tokenRuler: record(anchor.tokens) };
  }
  if (promptTokens === null) {
    refuse("sim-batch-provider-usage-absent",
      `the transport reported no prompt_tokens for ${label}; the fidelity band has no`
      + " ruler and the send is not evidence");
  }
  // A non-live provider-labelled reading belongs to a test or probe transport,
  // never to a paid route: keep the pre-pilot ±10% band and never calibrate a
  // run from it. The stub itself is synthetic and returned above.
  if (transport.live !== true) {
    summary.fidelityProvider += 1;
    const fidelity = providerBandOf({ promptTokens, anchorDepth: anchor.tokens,
      ruler: "provider", bandRatio: BAND_DRIFT_RATIO });
    if (fidelity.reason === "usage-absent") {
      refuse("sim-batch-provider-usage-absent",
        `the anchor for ${label} is ${String(anchor.tokens)}; the band has no ruler to`
        + " grade this provider reading against");
    }
    if (!fidelity.ok) summary.fidelityWarnings += 1;
    return { ...fidelity, anchorDepth304: anchor.tokens304,
      anchorDepthCalibrated: null, tokenRuler: record(anchor.tokens) };
  }
  if (summary.tokenRuler === null) {
    // The first accepted live send: no band exists, only the plausible range.
    const measured = firstSendRulerOf({ promptBytes: sentPromptBytes,
      providerPromptTokens: promptTokens });
    if (measured.ok !== true) {
      refuse("sim-batch-provider-ruler",
        `the first live send's prompt is ${String(measured.promptBytes)} B for`
        + ` ${String(measured.providerPromptTokens)} provider prompt_tokens =`
        + ` ${measured.bytesPerToken === null ? "an unreadable ratio"
          : `${measured.bytesPerToken.toFixed(2)} B/token`}, outside the plausible`
        + ` ${RULER_BYTES_PER_TOKEN_MIN.toFixed(1)}-${RULER_BYTES_PER_TOKEN_MAX.toFixed(1)}`
        + " B/token range; a body that far from any measured route is not the measured"
        + " context, so no ruler is calibrated from it");
    }
    summary.tokenRuler = { bytesPerToken: measured.bytesPerToken, fromAsk: askIndex ?? null,
      providerPromptTokens: promptTokens, promptBytes: sentPromptBytes,
      toolBytes, textBytes, source: "first-send",
      // The two calibration points; ask 1 adds the second and solves.
      points: [{ askIndex: askIndex ?? 0, toolBytes, textBytes,
        providerPromptTokens: promptTokens }],
      solved: null };
    summary.fidelityProvider += 1;
    return { ok: true, ruler: "provider", reason: null, promptTokens,
      anchorDepth: anchor.tokens, anchorDepth304: anchor.tokens304,
      anchorDepthCalibrated: null, delta: null, deltaRatio: null,
      calibrated: true, bytesPerToken: measured.bytesPerToken,
      tokenRuler: record() };
  }
  // Every later live send is graded against the calibrated reading: ask 1 on
  // the single ratio, ask 2+ on the two-density prediction when it solved.
  summary.fidelityProvider += 1;
  const fidelity = providerBandOf({ promptTokens,
    anchorDepth: anchor.tokensCalibrated, ruler: "provider" });
  if (fidelity.reason === "usage-absent") {
    refuse("sim-batch-provider-usage-absent",
      `the calibrated anchor for ${label} is ${String(anchor.tokensCalibrated)}; a live`
      + " send has no band without a token count on both sides");
  }
  if (!fidelity.ok) {
    const percent = (fidelity.deltaRatio * 100).toFixed(2);
    const direction = fidelity.deltaPercent >= 0 ? "above" : "below";
    const signedDelta = `${fidelity.deltaPercent >= 0 ? "+" : "-"}${String(fidelity.delta)}`;
    refuse("sim-batch-provider-band-gross", anchor.rulerModel === "two-density"
      ? `provider prompt_tokens ${String(fidelity.promptTokens)} is ${percent}% ${direction}`
        + ` the ${String(fidelity.anchorDepth)} two-density prediction for ${label} (delta`
        + ` ${signedDelta} tokens); the band is a gross-error guard: it refuses only a`
        + ` missing or doubled context (±${String(GROSS_BAND_RATIO * 100)}%), never the`
        + ` model's residual drift; the prediction is ${String(anchor.toolBytes)} B of tool`
        + ` schema at ${anchor.rTool.toFixed(2)} B/token plus ${String(anchor.textBytes)} B of`
        + ` text at ${anchor.rText.toFixed(2)} B/token (solved from asks`
        + ` ${String(anchor.solvedFrom.join(" and "))}), and a live send that far off is`
        + " not the measured context"
      : `provider prompt_tokens ${String(fidelity.promptTokens)} is ${percent}% ${direction}`
        + ` the ${String(fidelity.anchorDepth)} anchor for ${label} (delta`
        + ` ${signedDelta} tokens)`
        + (summary.tokenRuler.rulerFallback === true
          ? `; the two-point solve is degenerate (${String(summary.tokenRuler.fallbackReason)})`
            + `, so the band fell back to the ${summary.tokenRuler.bytesPerToken.toFixed(2)}`
            + " B/token single ratio"
          : `; the anchor is the request's ${String(anchor.bytes)} B under the route's`
            + ` measured ${summary.tokenRuler.bytesPerToken.toFixed(2)} B/token (calibrated`
            + ` on ask ${String(summary.tokenRuler.fromAsk)})`)
        + `; the band is a gross-error guard (±${String(GROSS_BAND_RATIO * 100)}%): it refuses`
        + " only a missing or doubled context, never the model's residual drift, and a live"
        + " send that far off is not the measured context");
  }
  // Ask 1's accepted reading is the second calibration point. The solve runs
  // AFTER its own band passed, and a correction send never contributes.
  if (contributesRuler && Number.isSafeInteger(askIndex) && askIndex === 1
    && summary.tokenRuler.points.length === 1) {
    summary.tokenRuler.points.push({ askIndex, toolBytes, textBytes,
      providerPromptTokens: promptTokens });
    const two = twoPointRulerOf({ first: summary.tokenRuler.points[0],
      second: summary.tokenRuler.points[1] });
    if (two.ok) {
      summary.tokenRuler.solved = { rTool: two.rTool, rText: two.rText,
        solvedFrom: two.solvedFrom };
    } else {
      summary.tokenRuler.rulerFallback = true;
      summary.tokenRuler.fallbackReason = two.reason;
    }
  }
  return { ...fidelity, anchorDepth304: anchor.tokens304,
    anchorDepthCalibrated: anchor.tokensCalibrated,
    tokenRuler: record(anchor.tokensCalibrated, fidelity.drift) };
}

/**
 * One ask: build the surface prompt, send, parse, and fold the answers into the
 * lane's state. Only an answered arithmetic refusal earns the single correction
 * turn (§4); a parse refusal or a length/timeout send never does.
 *
 * The prompt's conversation is the run's SIMULATED SURFACE (ISSUE-194), handed
 * in as `surface` (REQUIRED) and updated after this fire's answers: a unit an
 * earlier fire forgot or trimmed is no longer in the context in its landed form.
 * The ask's share line follows `askIndex` — fire 0 is the first trigger, every
 * later fire a later trigger.
 *
 * The anchor depth is the request the provider ANSWERED. On the SURFACE path it
 * is the FULL REQUEST BODY's estimate for this fire's prompt:
 * `measuredTokensOf(promptWireBytes)`, with framing, role keys, escaping, the
 * tools array, the envelope and the ask all included (`anchorBasis:
 * "surface-request-body"`, P4). It used to be the content-only surface depth
 * plus the ask, which omitted the framing while calling itself the request. On
 * the HOST path it is `result.json`'s measured series at the fire's step NET of
 * the removals the lane's earlier fires booked, PLUS the ask bytes, PLUS every
 * unit that landed at the fire's own step (that step's depth is the request that
 * produced those results, so it contains none of them; P7). A threshold fire's
 * step already carries every EARLIER pending unit, and any unit that lands at
 * the very step asked about is added the same way. `anchorSource` names the ruler
 * (`reconstructed-surface` or `host-result-json`), `anchorBasis` names the
 * additions, and `anchorAddedUnits`/`anchorAddedUnitTokens` record the addend, so
 * the field says exactly what the band compared. A stub
 * band is SYNTHETIC (`usage.ruler`): the stub's `prompt_tokens` is this sim's
 * own estimate fed back, so its band never grades anything and is counted as
 * `fidelitySynthetic`, never as a pass.
 */
async function askAndApply({ batch, timeline, depths, lane, mode,
  threshold, semantics, transport, deadline, decisions, removals, fire,
  askIndex, summary, grammar = DEFAULT_ASK_GRAMMAR, order = DEFAULT_ASK_ORDER,
  askScope = DEFAULT_ASK_SCOPE, kept = null, firstFireDepth = null, surface,
  carrySeqs = [], depthSource = HOST_DEPTH_SOURCE, inputDeviations = [] }) {
  const units = batch.units;
  const callNames = timeline.callNames ?? new Map();
  // P9: the product re-reads the SHAPED node at the fire, so a `kept` table is
  // built from the body the surface holds, not the landed one. Under `new` a
  // kept row is never re-tabled, so its landed text is the honest source; both
  // paths state which source they used in `tableSource`.
  const shapedCandidates = askScope === "kept"
    ? units.map(unit => {
      const held = surface.get(unit.seq);
      return typeof held === "string" ? { ...unit, text: held } : unit;
    })
    : units;
  // P4: the product re-runs `factsShowTwoQuotes` over the live node before it
  // tables a row (`plugin.ts` `entry-ask-off`/`no-quotes`) and drops a row that
  // can no longer show two quotes. The sim tables the shaped body, so it applies
  // the same test to that body: a shaped row whose kept lines quote fewer than
  // two lines leaves the table, its earlier removal standing. Under `new` the
  // row was admitted by the same test at landing, so nothing is filtered.
  const tableable = shapedCandidates.map(unit => factsShowTwoQuotes(factsOf(unit.text)));
  const keptNoQuote = askScope === "kept"
    ? shapedCandidates.filter((unit, at) => !tableable[at]) : [];
  const tableUnits = askScope === "kept"
    ? shapedCandidates.filter((unit, at) => tableable[at]) : shapedCandidates;
  const tableSource = askScope === "kept" ? "shaped-surface" : "landed";
  if (tableUnits.length === 0) {
    refuse("sim-batch-kept-table-empty",
      `fire at step ${String(fire.step)} has no tableable kept row: every candidate's shaped`
      + " body shows fewer than two quotes. A fire that would ask nothing is not an ask");
  }
  const packed = promptForFire({ timeline, fireStep: fire.step, units: tableUnits, grammar,
    order, firstTrigger: askIndex === 0, surface, fireIndex: askIndex });
  // The carry gate: the prior fire's applied forgets must still be on THIS
  // fire's prompt, byte for byte. It reads the prompt's own messages at each
  // turn's position, never the surface map's keys and never a marker line alone.
  // `carrySeqs` is the CUMULATIVE applied list (a fire's restores removed), not
  // the last fire's. A unit the host removed at or before THIS step is no longer
  // the policy's to carry: `surfaceAt` drops it, so demanding it would refuse a
  // run whose removal the host took over.
  const removedNow = hostRemovedAt(timeline, fire.step);
  const carryNow = carrySeqs.filter(seq => !removedNow.has(seq));
  const carryCheck = assertCarriedOverrides({ requiredSeqs: carryNow, surface,
    messages: packed.messages, turnSeqs: packed.turnSeqs, units: timeline.units, callNames,
    fireStep: fire.step });
  // Fourteenth audit item 5: the carried seqs this fire COMPARED, so the run's
  // per-run check outcome says whether the byte-for-byte gate had bodies at all.
  summary.carriedOverridesCompared += carryCheck.required;
  // Every tabled row must be in the messages the fire sends: a row the surface
  // filtered out is a batch size that overstates the prompt.
  assertBatchInPrompt({ units: tableUnits, turnSeqs: packed.turnSeqs, fireStep: fire.step });
  /** Record one send's prompt gauges against the run's peaks (correction too). */
  const notePeak = prompt => {
    summary.promptPeakBytes = Math.max(summary.promptPeakBytes, prompt.bytes);
    summary.promptPeakWireBytes = Math.max(summary.promptPeakWireBytes, prompt.promptWireBytes);
    summary.promptPeakGuardTokens = Math.max(summary.promptPeakGuardTokens, prompt.guardTokens);
    summary.promptPeakEstimateTokens = Math.max(summary.promptPeakEstimateTokens,
      prompt.estimatedTokens);
    summary.promptPeakToolsBytes = Math.max(summary.promptPeakToolsBytes, prompt.toolsBytes);
  };
  const tools = timeline.tools ?? [];
  const requestBody = requestBodyOf({ messages: packed.messages, tools });
  const promptWireBytes = Buffer.byteLength(JSON.stringify(requestBody), "utf8");
  // The anchor is the request the provider answered, not the trigger's ruler.
  //
  // On the SURFACE path it is the FULL REQUEST BODY's estimate: framing, keys,
  // escaping, the tools array, the `model`/`stream`/`stream_options` envelope
  // and the ask, all included. `surfaceDepthAt` is content-only and is the
  // trigger's ruler, never this anchor (P4). On the host path the ruler is the
  // measured depth at the fire's step, so the anchor adds what that reading
  // cannot contain: the ask bytes, and every unit that landed at that step (the
  // depth at the step is the request that PRODUCED those results). A threshold
  // fire's step is later than every earlier pending unit's landing step, so its
  // depth already carries them; a unit landing at the very step asked about is
  // added like a batch fire's (P7).
  let hostBase = null;
  let hostBasis = null;
  // P7: every unit that landed at the fire's OWN step is on this prompt but not
  // in the measured reading at that step — that reading is the request which
  // PRODUCED those results. The old anchor added only the firing unit, so a step
  // with two results (a parallel tool batch) under-counted the prompt by the
  // others. `addedUnits` is the addend, recorded beside the anchor.
  const addedUnits = depthSource === SURFACE_DEPTH_SOURCE ? []
    : (timeline.units ?? []).filter(unit => unit.step === fire.step
      && !removedNow.has(unit.seq));
  // ONE ceiling over the SUMMED bytes. Summing per-unit ceilings overstated the
  // addend by up to one token per unit (two 1,001 B units are 659 tokens, not
  // 330 + 330).
  const addedUnitBytes = addedUnits.reduce((sum, unit) => sum + unit.bytes, 0);
  const addedUnitTokens = addedUnits.length === 0 ? 0
    : measuredTokensOf(addedUnitBytes);
  // The anchor is recorded under BOTH rulers: the 3.04 B/token estimate the
  // old routes were measured at (`anchorDepth304`, always recorded) and the
  // route's own calibrated ruler when the first accepted live send produced one
  // (`anchorDepthCalibrated`; null on every synthetic/non-live run). `tokens` is
  // the one the band uses, so a live send after calibration compares provider
  // `prompt_tokens` to `bytes / bytesPerToken`, never to the stale estimate.
  // On the SURFACE path the byte component is the FULL request body (framing,
  // tools, envelope and ask included). On the HOST path the measured depth is
  // already provider tokens, so only the ask and the step's units are bytes.
  const anchorBytes = depthSource === SURFACE_DEPTH_SOURCE
    ? promptWireBytes : packed.askBytes + addedUnitBytes;
  if (depthSource === SURFACE_DEPTH_SOURCE) {
    hostBase = 0;
    hostBasis = "surface-request-body";
  } else {
    hostBase = Number.isSafeInteger(fire.depth) ? fire.depth : anchorDepthOf(depths, fire.step).tokens;
    // The basis NAMES the additions, and the addend counts sit beside it:
    // `anchorAddedUnits` / `anchorAddedUnitTokens` say how many units that step
    // carried and what they were counted as.
    hostBasis = "host-result-json-at-fire+ask+step-units";
  }
  // The HOST base is already provider tokens; the surface base is 0 and all of
  // its anchor is the request's bytes.
  const tokenBase = depthSource === SURFACE_DEPTH_SOURCE ? 0 : hostBase;
  const anchorTokens304 = Number.isSafeInteger(hostBase)
    ? (depthSource === SURFACE_DEPTH_SOURCE
      ? measuredTokensOf(promptWireBytes)
      : hostBase + measuredTokensOf(packed.askBytes) + addedUnitTokens)
    : null;
  // The calibrated reading is the two-density prediction once asks 0 and 1
  // solved it, and the single ratio before that (or when the solve is
  // degenerate). On the SURFACE path the byte component is the whole body, so
  // the tool schema is split out; on the HOST path the base is already provider
  // tokens and the addend is all text.
  const anchorDepth = tokenDepthOf({ tokenRuler: summary.tokenRuler, tokenBase,
    toolBytes: depthSource === SURFACE_DEPTH_SOURCE ? packed.toolsBytes : 0,
    bodyBytes: anchorBytes, useTwoDensity: (askIndex ?? 0) >= 2 });
  const anchorTokensCalibrated = Number.isSafeInteger(tokenBase)
    ? anchorDepth.tokens : null;
  const anchor = {
    step: fire.step,
    tokenBase,
    bytes: anchorBytes,
    tokens: anchorTokensCalibrated ?? anchorTokens304,
    tokens304: anchorTokens304,
    tokensCalibrated: anchorTokensCalibrated,
    // Which model produced `tokensCalibrated`, and the terms it used, so a
    // record states exactly what the band compared.
    rulerModel: anchorDepth.rulerModel,
    rTool: anchorDepth.rTool, rText: anchorDepth.rText,
    solvedFrom: anchorDepth.solvedFrom,
    rulerFallback: anchorDepth.rulerFallback,
    toolBytes: anchorDepth.toolBytes, textBytes: anchorDepth.textBytes,
    source: depthSource === SURFACE_DEPTH_SOURCE ? SURFACE_DEPTH_SOURCE : HOST_DEPTH_SOURCE,
    basis: hostBasis,
  };
  // The pre-send guard is applied to the LARGER of the content-only count and a
  // wire-derived one, and the wire here is the FULL request body (envelope
  // included), not only the messages payload `buildPrompt` sees. A prompt that
  // fits one size and not the other refuses here, before any socket.
  const bodyGuardTokens = guardTokensOf(promptWireBytes);
  const promptGuardTokens = Math.max(packed.guardTokens, bodyGuardTokens);
  if (promptGuardTokens >= PROMPT_TOKEN_LIMIT) {
    refuse("sim-batch-prompt-overflow",
      `the request body is ${String(promptWireBytes)} B, so guard tokens`
      + ` ${String(promptGuardTokens)} >= ${String(PROMPT_TOKEN_LIMIT)} (content-only`
      + ` ${String(packed.guardTokensContent)}, payload-wire`
      + ` ${String(packed.guardTokensPayloadWire)}); nothing is trimmed`);
  }
  notePeak({ bytes: packed.bytes, promptWireBytes, guardTokens: promptGuardTokens,
    estimatedTokens: packed.estimatedTokens, toolsBytes: packed.toolsBytes });
  // The shape is asserted before EVERY send, whatever transport is in use.
  assertRequestShape({ body: requestBody });
  const rows = askRowsOf(tableUnits, callNames);
  const indices = rows.map(row => row.index);
  const lineCounts = new Map(rows.map(row => [row.index, row.lineCount]));
  const base = {
    lane, mode, threshold, semantics, askGrammar: grammar, askOrder: order, askScope,
    tableSource,
    firstFireDepth,
    ignoreHostPrunes: timeline.ignoreHostPrunes === true,
    // P1: two readings, never one. `inputHostPruner` is the RECORDING's state,
    // derived from its own prune journals; `modeledHostPruner` is the state this
    // replay models (the flag). A `--ignore-host-prunes` run over a recording
    // made with the pruner on reads `inputHostPruner: "on"`, and its reason list
    // carries `host-pruner-on`. This runner mounts no host mechanism, so
    // `runHostPruner: "none"` rides beside both.
    inputHostPruner: recordingHostPrunerState(timeline),
    modeledHostPruner: timeline.ignoreHostPrunes === true ? "off" : "on",
    runHostPruner: "none",
    // The two DETECTED input deviations this input carries (ISSUE-207); each is
    // a citation reason. The stand-in's own two facts live in `contextStandIn`
    // and are folded into the universal `stand-in-context` reason.
    inputDeviations,
    askIndex, fireStep: fire.step,
    // The depth the verdict FIRED on, as the lane computed it: the trigger's
    // own ruler (`surfaceDepthBefore` on the surface path). The anchor beside it
    // is the request's reading (the row that triggered the fire, plus the ask).
    triggerDepth: fire.depth ?? null,
    anchorStep: anchor.step, anchorDepth: anchor.tokens, anchorSource: anchor.source,
    anchorBasis: anchor.basis,
    // Both rulers, so one record states what the band compared and what the
    // stale 3.04 estimate would have compared: `anchorDepth304` is ALWAYS the
    // estimate; `anchorDepthCalibrated` is the route's calibrated reading —
    // the single `bytes / bytesPerToken` at ask 1, the two-density prediction
    // at ask 2+ (null before calibration); `anchorDepth` is the one the band
    // used. `anchorRuler` names which model that was.
    anchorDepth304: anchor.tokens304,
    anchorDepthCalibrated: anchor.tokensCalibrated,
    anchorRuler: anchor.tokensCalibrated === null ? "estimate-3.04"
      : (anchor.rulerModel === "two-density" ? "two-point" : "first-send"),
    // The route ruler this run calibrated (null on a stub/non-live run), and
    // the byte component the calibrated anchor divides. The per-send
    // `tokenRuler` states the model that produced this record's prediction; a
    // successful send replaces it with the graded copy (provider reading and
    // signed delta included).
    anchorBytes: anchor.bytes,
    tokenRuler: tokenRulerRecordOf({ run: summary.tokenRuler,
      used: anchor.rulerModel === "two-density"
        ? { rTool: anchor.rTool, rText: anchor.rText, solvedFrom: anchor.solvedFrom } : null,
      toolBytes: anchor.toolBytes, textBytes: anchor.textBytes,
      predictedTokens: anchor.tokensCalibrated,
      rulerFallback: anchor.rulerModel === "single"
        && summary.tokenRuler?.rulerFallback === true }),
    // P7: the additive part of a host anchor, named and counted: the units that
    // landed at the fire's own step and could not be in the measured reading.
    anchorAddedUnits: addedUnits.length,
    anchorAddedUnitTokens: addedUnitTokens,
    depthSource,
    batchSize: units.length,
    // P4: the rows the ask ACTUALLY carried, and the kept rows the quote re-read
    // dropped. Under `new` the two numbers are the batch's own; under `kept` the
    // table re-asks kept rows, and a shaped row that no longer shows two quotes
    // is dropped instead of tabled bare (the product's `entry-ask-off`).
    tabledRows: tableUnits.length,
    keptNoQuoteDrops: keptNoQuote.length,
    keptNoQuoteUnitIds: keptNoQuote.map(unit => unit.id),
    // The eligible population's own rule and floor, so a record reproduces the
    // sample it measured. `errorResult` is the sim-only exclusion the product
    // does not have; its count says how many rows that filter removed.
    eligibility: summary.eligibility,
    askBytes: packed.askBytes, promptBytes: packed.bytes, toolsBytes: packed.toolsBytes,
    // The request's real JSON size (framing, role keys, escaping and the
    // `reasoning_content` key included) beside the content-only `promptBytes`.
    // Neither bounds the other: `promptBytes` includes invented stand-in text and
    // omits framing. `promptJsonBytes` is the same payload without the fixed
    // request envelope (`model`, `stream`, `stream_options`), which is what
    // `buildPrompt` reports; the difference to `promptWireBytes` is that envelope.
    promptWireBytes, bodyWireDeltaBytes: promptWireBytes - packed.bytes,
    promptJsonBytes: packed.promptWireBytes,
    promptSha256: promptSha256Of(packed.messages, tools),
    overriddenSeqs: packed.overriddenSeqs,
    promptGuardTokens,
    promptGuardTokensContent: packed.guardTokensContent,
    // The two wire bounds have distinct names: the payload is buildPrompt's
    // own `JSON.stringify({messages, tools})`; the body is the FULL request
    // body's JSON (envelope included). `promptGuardTokens` is their maximum
    // with the content-only count, which is what the guard applies.
    promptGuardTokensPayloadWire: packed.guardTokensPayloadWire,
    promptGuardTokensBodyWire: bodyGuardTokens,
    promptWireTokens: measuredTokensOf(promptWireBytes),
    promptTokensEstimate: packed.estimatedTokens,
    reasoningBytes: packed.reasoningBytes, reasoningMessages: packed.reasoningMessages,
    reasoningWireBytes: packed.reasoningWireBytes,
    reasoningWireDeltaBytes: packed.reasoningWireDeltaBytes,
    reasoningSha256: packed.reasoningSha256,
    reasoningShare: packed.reasoningShare,
    // The stand-in statement: which roles, which row types never reached a
    // message, the invented prefix, the tool-call projection, the placement.
    contextStandIn: packed.contextStandIn,
    textSource: TEXT_SOURCE,
    surfaceRows: packed.surfaceRows,
    shadowedRows: packed.shadowed, contextTurns: packed.contextRows,
    transport: transport.name,
  };
  // P1: the run's dropped-part total, summed over the prompts it built. A send
  // record's block counts ITS prompt; the run-level reason needs the whole run,
  // so the content loss cannot vanish because the first fire happened to drop
  // none.
  summary.droppedPartsTotal += base.contextStandIn.droppedParts.count;
  summary.projectedPartsTotal += base.contextStandIn.projectedParts.count;
  // P4: the kept rows the product's own quote re-read would drop from the table.
  summary.keptNoQuoteRows += keptNoQuote.length;
  const response = await transport.ask({ messages: packed.messages, tools,
    turnSeqs: packed.turnSeqs,
    ask: askIndex, indices, estimatedTokens: packed.estimatedTokens, deadline, grammar,
    fireStep: fire.step, reasoningMessages: packed.reasoningMessages,
    reasoningWireBytes: packed.reasoningWireBytes });
  summary.sends += 1;
  // A fire ATTEMPTED is an ask, whether or not the transport answered it. The
  // ask totals must stay complete; an unanswered fire is marked by
  // `unansweredFires`, never by a missing ask.
  summary.asks += 1;
  // A reply the TRANSPORT answered (http 2xx, stream done) that carried no
  // readable text is a MODEL answer, never a failed send. The product refuses
  // every tabled row (`no-text` -> `empty-text` -> the row's own KEEP,
  // `batch-ask.ts:197`) and forms the next batch at the next landing. In batch
  // mode this lane does the same: every tabled row is refused by the REAL
  // reader (so the record names the grammar's own code), nothing is applied,
  // the fire is counted unanswered, and the loop CONTINUES. A transport
  // failure (non-2xx, a cut stream, a deadline) is not a model answer and still
  // stops the lane below.
  if (mode === "batch" && refusedAnswerOf(response)) {
    const refusedParsed = answerRowsOf(response.content ?? "", indices, grammar, { lineCounts });
    const refusedDetails = wireDetailsOf(response.content ?? "", indices, grammar, { lineCounts });
    const refusedDistribution = distributionOf(refusedParsed, tableUnits, refusedDetails,
      { grammar, lineCounts });
    // The send was paid and its request is the measured body, so it grades like
    // any other accepted send WHEN the provider reported a reading. A reply that
    // carried no usage has no ruler; that is recorded as a null band, never a
    // refusal, because the model's answer is what this branch is about.
    const refusedFidelity = response.usage === undefined || response.usage === null
      ? null
      : gradeFidelity({ usage: response.usage, anchor, transport, summary,
        label: `ask ${String(askIndex)}`, askIndex, sentPromptBytes: promptWireBytes,
        toolBytes: packed.toolsBytes });
    addUsage(summary, response.usage);
    // A refusal applies nothing: the surface advances one fire and its bodies do
    // not move, so the refused rows stay WHOLE and every later prompt carries
    // them byte for byte. The batch already consumed them, so they are never
    // re-tabled in this run and they are not carried: they were asked.
    applyFireToSurface({ surface, timeline, units: tableUnits, rows: refusedParsed,
      lane, fireStep: fire.step });
    summary.unansweredFires += 1;
    summary.parseRefusedFires += 1;
    summary.parseRefusedRows += refusedDistribution.refused;
    summary.refused += refusedDistribution.refused;
    summary.firstPassRefusals += refusedDistribution.refused;
    const refusedRowClasses = rowRefusalClassesOf(refusedDistribution.rows);
    foldRowRefusalClasses(summary, refusedRowClasses);
    const refusedRecord = {
      ...base,
      ok: false,
      // ANSWERED and refused, not failed: no `refused-sends`, no dropped batch,
      // and the units it tabled are neither applied nor carried.
      parseRefused: true,
      failureClass: "parse",
      httpStatus: response.httpStatus ?? null,
      latencyMs: response.latencyMs ?? 0,
      error: response.error ?? "the answer carried no readable text",
      fidelity: refusedFidelity,
      tokenRuler: refusedFidelity?.tokenRuler ?? base.tokenRuler,
      usageRuler: response.usage?.ruler === "synthetic" ? "synthetic" : "provider",
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      answerBytes: Buffer.byteLength(response.content ?? "", "utf8"),
      ...contentFieldsOf(response.content),
      diagnostics: response.diagnostics ?? null,
      firstPass: { keep: 0, forget: 0, refused: refusedDistribution.refused },
      correction: null,
      correctionFailed: false,
      unappliedRows: tableUnits.length,
      refusedRows: refusedDistribution.refused,
      appliedForgets: 0, keptLines: 0, totalLines: 0, keptFraction: null,
      distribution: { keep: 0, forget: 0, refused: refusedDistribution.refused,
        keeplines: 0 },
      rows: refusedDistribution.rows,
      rowRefusalClasses: refusedRowClasses,
    };
    return { record: refusedRecord, extraRecords: [], stop: false, removalDelta: 0,
      droppedUnits: 0, droppedUnitIds: [], appliedSeqs: [], restoredSeqs: [] };
  }
  if (!response.ok) {
    // A TRANSPORT failure — a non-2xx status, a cut stream, a deadline, a
    // length trip — is not a model answer: it drops the whole fire. NOTHING it
    // asked about was answered, so nothing is re-asked and nothing is applied.
    // Both failures stop the lane the same way (one attempt per ask, no
    // retries); the dropped batch is recorded and counted as carried, so a
    // stopped lane never reports `carried: 0` as if nothing were left. The
    // ANSWERED-but-empty reply is handled above in batch mode. Usage the
    // failed send still reported is recorded, never dropped.
    const failureClass = response.failure ?? "transport";
    addUsage(summary, response.usage);
    summary.refusedSends += 1;
    summary.unansweredFires += 1;
    // A dropped fire drops the rows it TABLED (never a kept row the quote
    // re-read already removed from the table).
    summary.droppedBatchUnits += tableUnits.length;
    summary.refusalClasses[failureClass] = (summary.refusalClasses[failureClass] ?? 0) + 1;
    const failedProvider = Number.isSafeInteger(response.usage?.prompt_tokens)
      ? response.usage.prompt_tokens : null;
    const failedPredicted = base.tokenRuler.predictedTokens;
    const record = { ...base, ok: false, failureClass, error: response.error ?? "unknown",
      tokenRuler: { ...base.tokenRuler, providerPromptTokens: failedProvider,
        deltaPercent: failedProvider !== null && Number.isSafeInteger(failedPredicted)
          && failedPredicted > 0
          ? (failedProvider - failedPredicted) / failedPredicted * 100 : null },
      usageRuler: response.usage?.ruler === "synthetic" ? "synthetic" : "provider",
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      droppedUnits: tableUnits.length, droppedUnitIds: tableUnits.map(unit => unit.id),
      appliedForgets: 0, ...contentFieldsOf(response.content),
      // The send read no row at all, so its ROW map is empty; the refusal is a
      // SEND class (`failureClass` above), never a row code (ISSUE-184).
      rowRefusalClasses: {} };
    summary.failures.push(record);
    return { record, extraRecords: [], stop: true, removalDelta: 0,
      droppedUnits: tableUnits.length,
      droppedUnitIds: tableUnits.map(unit => unit.id),
      appliedSeqs: [], restoredSeqs: [] };
  }
  // Provider usage is the ruler (design §2.5). Ask 0 calibrates the route's
  // single ratio (its ratio must be plausible, and no band exists yet); ask 1
  // is banded on it and solves the two densities; ask 2+ are banded on the
  // two-density prediction. The stub's synthetic usage grades nothing and never
  // calibrates.
  const fidelity = gradeFidelity({ usage: response.usage, anchor, transport, summary,
    label: `ask ${String(askIndex)}`, askIndex, sentPromptBytes: promptWireBytes,
    toolBytes: packed.toolsBytes });
  const firstPassParsed = answerRowsOf(response.content ?? "", indices, grammar, { lineCounts });
  let details = wireDetailsOf(response.content ?? "", indices, grammar, { lineCounts });
  const firstPass = distributionOf(firstPassParsed, units, details, { grammar, lineCounts });
  const codes = correctionCodesOf(firstPassParsed, lineCounts, grammar);
  let parsed = firstPassParsed;
  let correction = null;
  /** The correction send's own record: a paid send is never absent from the run. */
  let correctionRecord = null;
  /**
   * A failed correction makes the whole fire unanswered: no row is applied, so
   * an arithmetic-invalid row the first pass carried can never reach the surface.
   */
  let correctionFailed = false;
  if (codes.size > 0) {
    // Exactly one correction turn, never a loop. Parse refusals are absent here
    // by construction: the grammar's reader marks them `status:"refused"`. The
    // indices are the TABLE's (P4): under `kept` the ask's rows are `tableUnits`,
    // so the correction must name the same rows the first send tabled.
    const correctionText = batchCorrectionMessageOf(tableUnits, codes, callNames, grammar);
    const grown = [...packed.messages,
      { role: "assistant", content: response.content ?? "" },
      { role: "user", content: correctionText }];
    const grownTurnSeqs = [...packed.turnSeqs, null, null];
    const grownRequest = requestBodyOf({ messages: grown, tools });
    assertRequestShape({ body: grownRequest });
    // The correction prompt's own sizes, counted the same way as the first send:
    // content-only, payload, and the full body. It peaks beside them.
    const grownBytes = Buffer.byteLength(JSON.stringify(tools), "utf8")
      + grown.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8")
        + (typeof message.reasoning_content === "string"
          ? Buffer.byteLength(message.reasoning_content, "utf8") : 0), 0);
    const grownPayloadBytes = Buffer.byteLength(JSON.stringify({ messages: grown, tools }), "utf8");
    const grownBodyBytes = Buffer.byteLength(JSON.stringify(grownRequest), "utf8");
    const grownGuard = Math.max(guardTokensOf(grownBytes), guardTokensOf(grownPayloadBytes));
    const grownBodyGuard = Math.max(grownGuard, guardTokensOf(grownBodyBytes));
    if (grownBodyGuard >= PROMPT_TOKEN_LIMIT) {
      refuse("sim-batch-prompt-overflow",
        `the correction request body is ${String(grownBodyBytes)} B, so guard tokens`
        + ` ${String(grownBodyGuard)} >= ${String(PROMPT_TOKEN_LIMIT)}; nothing is trimmed`);
    }
    const grownEstimate = measuredTokensOf(grownBytes);
    notePeak({ bytes: grownBytes, promptWireBytes: grownBodyBytes, guardTokens: grownBodyGuard,
      estimatedTokens: grownEstimate, toolsBytes: packed.toolsBytes });
    // The correction answered the SAME context plus the reply and the correction
    // text, so its anchor is the first send's anchor plus those added bytes. The
    // delta is measured on the SAME basis as the anchor: the full request body.
    // It used to add a content-only delta to a body-based anchor, so the two
    // terms of one sum described different payloads. A missing first anchor
    // stays missing: `null + n` would invent a ruler.
    const anchorDeltaBytes = grownBodyBytes - promptWireBytes;
    const anchorDeltaTokens = measuredTokensOf(anchorDeltaBytes);
    // The correction adds the reply and the correction text to the SAME byte
    // component, so the calibrated reading advances by that delta: the single
    // ratio at ask 1, the two-density prediction at ask 2+ (and the stale 3.04
    // estimate beside both).
    const correctionBytes = anchor.bytes + anchorDeltaBytes;
    const grownAnchor304 = anchor.tokens304 === null ? null
      : anchor.tokens304 + anchorDeltaTokens;
    const grownDepth = tokenDepthOf({ tokenRuler: summary.tokenRuler,
      tokenBase: anchor.tokenBase,
      toolBytes: depthSource === SURFACE_DEPTH_SOURCE ? packed.toolsBytes : 0,
      bodyBytes: correctionBytes, useTwoDensity: (askIndex ?? 0) >= 2 });
    const grownAnchorCalibrated = Number.isSafeInteger(anchor.tokenBase)
      ? grownDepth.tokens : null;
    const grownAnchor = grownAnchorCalibrated ?? grownAnchor304;
    const correctionAnchor = {
      step: fire.step, tokenBase: anchor.tokenBase, bytes: correctionBytes,
      tokens: grownAnchor, tokens304: grownAnchor304,
      tokensCalibrated: grownAnchorCalibrated,
      rulerModel: grownDepth.rulerModel, rTool: grownDepth.rTool, rText: grownDepth.rText,
      solvedFrom: grownDepth.solvedFrom, rulerFallback: grownDepth.rulerFallback,
      toolBytes: grownDepth.toolBytes, textBytes: grownDepth.textBytes,
      source: anchor.source, basis: "first-send-anchor+correction-delta",
    };
    const second = await transport.ask({ messages: grown, tools, turnSeqs: grownTurnSeqs,
      ask: askIndex, indices, estimatedTokens: grownEstimate, deadline, grammar,
      fireStep: fire.step, reasoningMessages: packed.reasoningMessages,
      reasoningWireBytes: packed.reasoningWireBytes });
    summary.sends += 1;
    // A correction that ANSWERED is a paid send and is graded exactly like the
    // first one (its own anchor, its own band, its own count). A failed
    // correction has no answer to grade; its usage is still recorded.
    const secondFidelity = second.ok
      ? gradeFidelity({ usage: second.usage, anchor: correctionAnchor, transport, summary,
        label: `correction for ask ${String(askIndex)}`, askIndex,
        sentPromptBytes: grownBodyBytes, toolBytes: packed.toolsBytes,
        contributesRuler: false })
      : null;
    if (second.ok) {
      const healed = new Map(answerRowsOf(second.content ?? "", indices, grammar, { lineCounts })
        .map(row => [row.index, row]));
      parsed = firstPassParsed.map(row =>
        (codes.has(row.index) ? healed.get(row.index) ?? row : row));
      // The correction send's own refusals carry the truer wire detail.
      details = new Map([...details,
        ...wireDetailsOf(second.content ?? "", indices, grammar, { lineCounts })]);
      correction = { ok: true, codes: [...codes.keys()],
        askBytes: Buffer.byteLength(correctionText, "utf8"),
        ...contentFieldsOf(second.content) };
      addUsage(summary, second.usage);
    } else {
      // The correction failed: NOTHING this fire answered is applied. The first
      // pass still holds an arithmetic-invalid row (the very row the correction
      // was sent for), so applying it would shape a body the reader rejected.
      // The whole fire is unanswered instead: the surface does not move, the
      // decision log gains nothing, and the refusal is counted here (a named
      // fire count and a row count) beside the send-failure class.
      const failureClass = second.failure ?? "transport";
      addUsage(summary, second.usage);
      summary.refusedSends += 1;
      summary.unansweredFires += 1;
      summary.correctionFailedFires += 1;
      summary.correctionFailedRows += parsed.length;
      correctionFailed = true;
      summary.refusalClasses[failureClass] = (summary.refusalClasses[failureClass] ?? 0) + 1;
      correction = { ok: false, codes: [...codes.keys()], failureClass,
        ...contentFieldsOf(second.content) };
    }
    correctionRecord = {
      ...base, kind: "correction", ok: second.ok, correctionOf: askIndex,
      failureClass: second.ok ? null : (second.failure ?? "transport"),
      error: second.ok ? null : (second.error ?? "unknown"),
      usageRuler: second.usage?.ruler === "synthetic" ? "synthetic" : "provider",
      promptBytes: grownBytes, promptWireBytes: grownBodyBytes,
      bodyWireDeltaBytes: grownBodyBytes - grownBytes,
      promptJsonBytes: grownPayloadBytes,
      promptGuardTokens: grownBodyGuard,
      promptGuardTokensContent: guardTokensOf(grownBytes),
      promptGuardTokensPayloadWire: guardTokensOf(grownPayloadBytes),
      promptGuardTokensBodyWire: guardTokensOf(grownBodyBytes),
      promptWireTokens: measuredTokensOf(grownBodyBytes),
      promptTokensEstimate: grownEstimate,
      promptSha256: promptSha256Of(grown, tools),
      anchorDepth: grownAnchor,
      anchorDepth304: grownAnchor304,
      anchorDepthCalibrated: grownAnchorCalibrated,
      anchorRuler: grownAnchorCalibrated === null ? "estimate-3.04"
        : (grownDepth.rulerModel === "two-density" ? "two-point" : "first-send"),
      anchorBytes: correctionBytes,
      tokenRuler: secondFidelity?.tokenRuler ?? tokenRulerRecordOf({
        run: summary.tokenRuler,
        used: grownDepth.rulerModel === "two-density"
          ? { rTool: grownDepth.rTool, rText: grownDepth.rText,
            solvedFrom: grownDepth.solvedFrom } : null,
        toolBytes: grownDepth.toolBytes, textBytes: grownDepth.textBytes,
        predictedTokens: grownAnchorCalibrated,
        providerPromptTokens: Number.isSafeInteger(second.usage?.prompt_tokens)
          ? second.usage.prompt_tokens : null,
        rulerFallback: grownDepth.rulerModel === "single"
          && summary.tokenRuler?.rulerFallback === true }),
      // P7: the correction's anchor is ADDITIVE — the first send's anchor plus
      // the grown bytes — so it cannot inherit the first send's basis word. The
      // basis names the delta and the delta's own byte/token counts ride beside
      // it, so the field says how the number was built.
      anchorBasis: "first-send-anchor+correction-delta",
      anchorDeltaBytes,
      anchorDeltaTokens: measuredTokensOf(anchorDeltaBytes),
      fidelity: secondFidelity,
      correctionAskBytes: Buffer.byteLength(correctionText, "utf8"),
      correctionCodes: [...codes.keys()],
      promptTokens: second.usage?.prompt_tokens ?? null,
      completionTokens: second.usage?.completion_tokens ?? null,
      totalTokens: second.usage?.total_tokens ?? null,
      appliedForgets: 0, ...contentFieldsOf(second.content),
    };
    if (!second.ok) summary.failures.push(correctionRecord);
  }
  const distribution = distributionOf(parsed, tableUnits, details, { grammar, lineCounts });
  // A forget ANSWER that bought surface: the row was not host-pruned and the
  // renderer shaped it. The gap to `distribution.forget` is the answers spent on
  // rows the host had already removed — the n=1 table's hidden column.
  let appliedForgets = 0;
  /** The units THIS fire left shaped: the next fire must still carry them. */
  const appliedSeqs = [];
  /**
   * The units THIS fire answered keep-whole (or rendered unshaped): their
   * earlier override is gone, so the cumulative carry list drops them. Without
   * this a restored unit would be demanded of every later fire, and the restore
   * the product performs would read as a lost removal.
   */
  const restoredSeqs = [];
  // Thirteenth audit item 1: the kept map holds the LANDED unit, never the
  // pre-answer shaped copy this fire tabled. The next kept-scope table reads the
  // CURRENT surface body when one exists and the landed body when a keepall
  // deleted it — exactly the body `reconstructedSurfaceOf` renders. Storing the
  // pre-answer copy made a later forget re-render a stale shape, so the digest
  // gate refused a valid shape → keepall → forget sequence.
  const landedById = new Map((timeline.units ?? []).map(unit => [unit.id, unit]));
  let keptLines = 0;
  let totalLines = 0;
  // This fire's NET removal change, in bytes. A re-asked row's ANSWERED verdict
  // supersedes its earlier one: a `keeplines` answer replaces that row's drop,
  // and a `keepall` restores it. A REFUSED row applied nothing, so it restores
  // nothing and its earlier removal stands. A freshly asked row starts at 0, so
  // `new` scope sums exactly the drops it always did.
  let removalDelta = 0;
  // A failed correction leaves NO decision to apply: the whole loop is skipped,
  // so an arithmetic-invalid row the first pass carried can never shape the
  // surface, the kept map does not move, and no booking is written. The fire is
  // counted unanswered above; its surface stamp still advances one fire below.
  for (const [at, row] of (correctionFailed ? [] : parsed.entries())) {
    // P4: the table is the ask's own list. Under `kept` a row whose shaped body
    // lost its two quotes was never tabled, so it has no parsed row and keeps
    // the removal an earlier fire booked.
    const tableUnit = tableUnits[at];
    if (tableUnit === undefined) continue;
    const unit = tableUnit;
    // The row was TABLED from the shaped body under `kept`; the renderer must
    // read that same body, or a re-asked row would be shaped from the landed
    // text the prompt no longer holds.
    // The kept-scope carry-over: only a whole-unit forget leaves the table.
    if (kept !== null) {
      if (row.status === "answered" && row.answer.action === "forgetall") kept.delete(unit.id);
      else kept.set(unit.id, landedById.get(unit.id) ?? unit);
    }
    // The aggregate kept fraction the arm records: a refused row keeps in full.
    const total = lineCounts.get(row.index) ?? 0;
    totalLines += total;
    keptLines += keptLineCountOf(row.status === "answered" ? row.answer : null, total);
    // A refusal is not a decision: no verdict is recorded, the surface does not
    // move, and the removal booked earlier stays booked.
    if (row.status !== "answered") continue;
    // `fireStep` is the decision's own fire: the independent surface rebuild
    // (P7) replays the log in order and must know which host prunes were in
    // force when this answer landed.
    const decision = { ...row.answer, momentId: unit.id, fireStep: fire.step };
    decisions.push(decision);
    // P7 (eleventh audit): there is no branch here for "a unit the host had
    // already removed". Every tabled row was filtered by `hostRemovedAt` before
    // the table was built (the batch cadence's `dropRemoved`, the threshold
    // stream's own filter, `askableAt` under `kept`), so a row reaching this
    // loop is on the surface at this fire by construction. The branch that used
    // to sit here could not run, and prose that claimed it was behaviour is gone.
    const previous = removals.get(unit.id)?.bytes ?? 0;
    // Keep-whole: under `keeplines-60`, `jsonl-20` or `jsonl-20-nokeepall` a
    // `keeplines` naming every line removes nothing, so it is no shaped turn and
    // no marker — the unit stays as landed.
    const keepWhole = decision.action === "keepall"
      || ((grammar === "keeplines-60" || grammar === "jsonl-20"
        || grammar === "jsonl-20-nokeepall")
        && keepsWholeOf(row.answer, total));
    let entry = null;
    if (!keepWhole) {
      const rendered = renderMoment(momentOf(tableUnit, timeline, lane), decision);
      if (rendered.shaped) {
        appliedForgets += 1;
        appliedSeqs.push(unit.seq);
        const step = clampDecisionStep(rendered.decisionStep, fire.step);
        // NET: the shaped turn still occupies its summary, markers and framing.
        // `pruneStep` is when the host's own prune removes this body anyway; the
        // depth series stops subtracting the policy's delta at that step.
        entry = { step, bytes: netDroppedOf(rendered),
          pruneStep: hostPruneStepOf(timeline, unit.seq) };
      } else {
        // A keep decision renders unshaped: the unit is whole again.
        restoredSeqs.push(unit.seq);
      }
    } else {
      restoredSeqs.push(unit.seq);
    }
    const after = entry === null ? 0 : entry.bytes;
    // P2: a shape the host's own prune removes at the same step the shape lands
    // on frees no window at all, so it is credited nothing, booked nothing, and
    // stored as no standing removal. This branch is REACHABLE: a unit landing at
    // step S is answered at S + 1, and a host prune owned by S + 1 leaves the
    // shaped turn no step to stand for (the eleventh audit called it dead; the
    // ordering test in `sim-batch-live.test.mjs` proves it is not).
    // `bytesFreedByPolicy` reads the same rule, and the named assertion at the
    // end of `runLane` compares the two lists.
    const preempted = entry !== null && entry.pruneStep !== null && entry.step >= entry.pruneStep;
    const credited = preempted ? 0 : after;
    // P7: a booking is a CHANGE, never a re-statement. A re-ask under
    // `--ask-scope kept` that lands on the same body books nothing, and a
    // changed or restored row replaces/removes its earlier booking. One booking
    // per unit therefore stands, and their sum is the summary's final
    // `bytesFreedByPolicy`.
    if (credited === previous) continue;
    removalDelta += credited - previous;
    if (credited === 0) removals.delete(unit.id);
    else removals.set(unit.id, entry);
    summary.removalBookings = summary.removalBookings
      .filter(booking => booking.unitId !== unit.id);
    if (credited !== 0) {
      summary.removalBookings.push({ unitId: unit.id, step: entry.step, bytes: credited });
    }
  }
  // The next fire reads THIS fire's surface, not the recorded transcript: a
  // forgotten unit keeps only its summary and marker, a trimmed one only its
  // kept lines. The product's own renderer fills the map (ISSUE-194). The
  // surface gate rebuilds its expected bodies from the DECISION LOG
  // (`reconstructedSurfaceOf`), never from this writer's own output.
  //
  // A failed correction applies NOTHING: every row is handed over as a refusal,
  // so the surface's bodies and shape count do not move. The stamp still
  // advances one fire (the ask happened), which the surface gate requires.
  applyFireToSurface({ surface, timeline, units: tableUnits,
    rows: correctionFailed
      ? parsed.map(row => ({ index: row.index, status: "refused", code: "correction-failed" }))
      : parsed,
    lane, fireStep: fire.step });
  // A failed correction produced no decision: its rows count under
  // `correctionFailedRows`, never as an arm's keep/forget split.
  summary.keep += correctionFailed ? 0 : distribution.keep;
  summary.forget += correctionFailed ? 0 : distribution.forget;
  summary.keeplines += correctionFailed ? 0 : distribution.keeplines;
  summary.keptLines += keptLines;
  summary.totalLines += totalLines;
  summary.appliedForgets += appliedForgets;
  summary.refused += distribution.refused;
  summary.firstPassRefusals += firstPass.refused;
  // Row refusals by their own code, folded beside the send-level
  // `refusalClasses` and never into it (ISSUE-184). The map's counts sum to the
  // `refused` this fire books, so the summary answers "what refusals did this
  // run have?" without re-reading `records[]`.
  const rowRefusalClasses = rowRefusalClassesOf(distribution.rows);
  foldRowRefusalClasses(summary, rowRefusalClasses);
  // A fire whose every tabled row was refused produced no answer, and the
  // product keeps every row and forms the next batch; count the fire unanswered
  // beside the honest refusal count. The parse-class branch above does the same
  // for an empty/tool-call-only reply; this covers a reply with text whose
  // every row the parser refused.
  if (!correctionFailed && distribution.keep + distribution.forget === 0) {
    summary.unansweredFires += 1;
  }
  addUsage(summary, response.usage);
  const record = {
    ...base, ok: true, httpStatus: response.httpStatus ?? null, latencyMs: response.latencyMs ?? 0,
    fidelity,
    // The ruler this send was graded under: the two densities ask 0 and ask 1
    // solved (or the single ratio before that, or a recorded fallback), the
    // prediction it banded against, and the signed delta to the provider count.
    tokenRuler: fidelity.tokenRuler,
    // Where the prompt_tokens reading came from: a provider count, or the stub's
    // own estimate fed back (`synthetic`, never a grading ruler).
    usageRuler: response.usage?.ruler === "synthetic" ? "synthetic" : "provider",
    promptTokens: response.usage?.prompt_tokens ?? null,
    completionTokens: response.usage?.completion_tokens ?? null,
    totalTokens: response.usage?.total_tokens ?? null,
    answerBytes: Buffer.byteLength(response.content ?? "", "utf8"),
    ...contentFieldsOf(response.content),
    diagnostics: response.diagnostics ?? null,
    firstPass: { keep: firstPass.keep, forget: firstPass.forget, refused: firstPass.refused },
    correction,
    // A failed correction answers nothing: every tabled row was left unapplied,
    // and the fire is counted unanswered on the summary.
    correctionFailed,
    unappliedRows: correctionFailed ? tableUnits.length : 0,
    appliedForgets,
    keptLines,
    totalLines,
    keptFraction: totalLines === 0 ? null : keptLines / totalLines,
    distribution: { keep: distribution.keep, forget: distribution.forget,
      refused: distribution.refused, keeplines: distribution.keeplines },
    rows: distribution.rows,
    // The rows THIS send parsed, by the reader's own refusal code. Kept apart
    // from the send-level class map `refusalClasses` (ISSUE-184).
    rowRefusalClasses,
  };
  return { record, extraRecords: correctionRecord === null ? [] : [correctionRecord],
    stop: false, removalDelta, appliedSeqs, restoredSeqs };
}

/**
 * `prompt_tokens + completion_tokens + total_tokens` summed, each under its own
 * RULER. A provider reading goes to `promptTokens`/`completionTokens`/
 * `totalTokens`; the stub's synthetic reading goes to `estimatedTokens` and
 * never into the provider totals. `usageRuler` names the one ruler the run used
 * (`provider`, `synthetic`, or `mixed` if a caller ever mixes them), so a
 * summary can never present a synthetic number as a billed one (twelfth audit
 * item 9). Absent stays absent.
 */
function addUsage(summary, usage) {
  if (usage === null || usage === undefined) return;
  const ruler = usage.ruler === "synthetic" ? "synthetic" : "provider";
  if (summary.usageRuler === null) summary.usageRuler = ruler;
  else if (summary.usageRuler !== ruler) summary.usageRuler = "mixed";
  const bucket = ruler === "synthetic" ? summary.estimatedTokens : summary;
  bucket.promptTokens += usage.prompt_tokens ?? 0;
  bucket.completionTokens += usage.completion_tokens ?? 0;
  bucket.totalTokens += usage.total_tokens ?? 0;
}

/**
 * One lane, walked at its fires. Batch mode uses core's `batchVerdict` cadence;
 * threshold mode uses `thresholdVerdict` (depth growth, base moved by
 * `nextBaselineDepth` after each fire and reset at a host compaction) or
 * `landedBytesVerdict` (eligible bytes landed since the last fire, immune to
 * removals and prunes). Answers land at their fire step, never before it
 * (`clampDecisionStep`); threshold depth then moves for later steps.
 *
 * `askScope` is `new` (today's fire tables: this fire's pending units only) or
 * `kept` (threshold mode only: the still-kept rows from earlier fires plus this
 * fire's pending units). Under `kept` a row's latest verdict decides whether it
 * is carried to the next table; a whole-unit forget removes it for good.
 *
 * The ask STREAM is time-aware: every eligible unit that was on the surface at
 * its own landing step is a candidate, and each fire tables only the ones the
 * host had not removed by that fire (`hostRemovedAt(timeline, fire.step)`). A
 * unit pruned later is askable earlier; a unit pruned before any fire tabled it
 * is carried (`prunedBeforeAsk`) and named. A shape applied before a later host
 * prune is credited for the window it stood.
 *
 * `ignoreHostPrunes` is REQUIRED (ADR-0041, ADR-0045): `true` takes the host's
 * own tool-result trim out of the world (the product/test arm), `false` replays
 * it as shipped (the vanilla arm, which is a host-vs-product comparison and not
 * a product measurement). A lane that does not state it refuses by name, because
 * a number measured without knowing which mechanisms ran is not evidence.
 *
 * `depthSource` is derived from that choice and may also be stated. A
 * pruner-off lane takes `reconstructed-surface` (the surface's own bytes; the
 * host's `result.json` series is recorded beside it as contaminated), and it
 * REFUSES `host-result.json` by name. ADR-0041 Decision 6's zero-prune gate runs
 * here too: a pruner-off world with a `compaction/prune` event refuses, and a
 * pruner-off replay of a recording that itself carries prune events refuses as
 * a product measurement unless `reconstruction` declares it (recorded).
 *
 * `assertSegmentPins` runs HERE, not only in `main`, so a test that calls
 * `runLane` directly gets the same segment, reasoning and peak gates. A
 * transcript that declares zero reasoning refuses unless `allowZeroReasoning`
 * is passed; that flag is recorded as a void comparison (ADR-0045).
 */
export async function runLane({ transcript, depths, lane, mode = "batch", threshold = null,
  thresholdUnits = DEFAULT_THRESHOLD_UNITS, floor = FLOOR_BYTES, segment = null,
  semantics = DEFAULT_THRESHOLD_SEMANTICS, transport, grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER, askScope = DEFAULT_ASK_SCOPE, firstFireDepth = null,
  askCeiling, tokenGrant = null, deadline, ignoreHostPrunes, hostPrunerFlag = null,
  depthSource = null,
  reconstruction = false, allowZeroReasoning = false, input = null,
  log = () => {}, onRecord = () => {}, onRefusal = () => {} }) {
  assertAskScope(askScope);
  assertFirstFireDepth(firstFireDepth, { mode, thresholdUnits });
  if (typeof ignoreHostPrunes !== "boolean") {
    refuse("sim-batch-host-pruner-unstated",
      "ignoreHostPrunes must be stated as true (host pruner off, the product/test arm)"
      + " or false (on, the vanilla arm); a lane that does not state it refuses");
  }
  if (typeof allowZeroReasoning !== "boolean") {
    refuse("sim-batch-allow-zero-reasoning-invalid",
      `allowZeroReasoning is a boolean, got ${String(allowZeroReasoning)}`);
  }
  // Twelfth audit item 6: `--reconstruction` says a pruner-OFF replay of a
  // pruner-on recording was rebuilt without the host trim. Beside the host
  // pruner ON it states two opposite worlds at once (`reconstruction: true`
  // with `modeledHostPruner: "on"`), so the combination refuses by name.
  if (reconstruction === true && ignoreHostPrunes !== true) {
    refuse("sim-batch-reconstruction-host-pruner",
      "--reconstruction is a pruner-off declaration (ADR-0041 Decision 7) and cannot run"
      + " with the host pruner ON; drop --reconstruction or take --ignore-host-prunes");
  }
  const source = assertDepthSource(depthSource ?? defaultDepthSource(ignoreHostPrunes),
    ignoreHostPrunes);
  if (mode !== "threshold" && askScope === "kept") {
    refuse("sim-batch-ask-scope-batch",
      `--ask-scope ${askScope} is threshold mode only; --mode ${mode} refuses it`);
  }
  if (!THRESHOLD_UNITS.includes(thresholdUnits)) {
    refuse("sim-batch-threshold-units-invalid",
      `threshold units take ${THRESHOLD_UNITS.join(" or ")}, got ${String(thresholdUnits)}`);
  }
  assertOrderForGrammar(grammar, order);
  // The two optional caps. `0` and an omitted ceiling both mean OFF: the token
  // budget is the only run cap (owner ruling 2026-11-08). A positive ask ceiling
  // still stops the lane; a positive kill timer is armed by `armKillTimer`.
  const askLimit = Number.isSafeInteger(askCeiling) && askCeiling > 0 ? askCeiling : Infinity;
  if (tokenGrant !== null && tokenGrant !== undefined
    && (!Number.isSafeInteger(tokenGrant) || tokenGrant < 1)) {
    refuse("sim-batch-token-grant-required",
      `--token-grant takes a positive integer token count, got ${String(tokenGrant)}`);
  }
  const budgetLimit = Number.isSafeInteger(tokenGrant) && tokenGrant > 0 ? tokenGrant : Infinity;
  const timeline = readTimeline(transcript, { segment, ignoreHostPrunes, reconstruction });
  // P3: every reading in the depth series must sit at a step the recording's own
  // `step/start` rows declare. `readUsage` validated each row's arithmetic; this
  // is the cross-check against the transcript, and it refuses by name rather than
  // letting a provider count be compared to a step no request reached.
  const usageSteps = assertUsageStepsPinned(timeline, depths);
  // The full pin gate on the API path, not only in `main`: segment counts,
  // ADR-0045's carried reasoning, and the pins of the pinned world. A STATED
  // input hash is verified against the bytes it names; the segment-139 claim
  // requires both hashes, and a caller that states none records what the
  // timeline itself could read (P12: this is a binding of stated hashes, never
  // a requirement that every run states them).
  const pruneGate = assertZeroPruneGate(timeline);
  const pins = assertSegmentPins(timeline, depths, { allowZeroReasoning, input });
  const wireTransport = withReasoningBoundary(transport, timeline);
  // The ask stream is TIME-AWARE (P3): eligible AND on the surface at the fire.
  // A unit the host prunes at step 100 was on the surface at a fire at step 10
  // and is tabled there; only a unit removed STRICTLY BEFORE its own landing
  // step is never askable (a prune on the landing step runs after that step's
  // fire). `eligible` keeps the full population for the record.
  const eligibleUnits = eligibleOf(timeline, floor);
  const units = askableOf(timeline, floor);
  // A lane over zero eligible units measures nothing: refuse before the loop
  // instead of writing a normal summary from an empty sample.
  if (units.length === 0) {
    refuse("sim-batch-eligible-empty",
      `no eligible unit at floor ${String(floor)} B; a lane over nothing is not a measurement`);
  }
  const decisions = [];
  /** unitId → its current removal; a re-asked row's answered verdict supersedes it. */
  const removals = new Map();
  /**
   * The run's simulated surface (ISSUE-194): unit seq → the text its tool turn
   * holds now. Created once, updated after every fire's answers, and read by the
   * next fire's prompt. The model's own asks/answers never enter it. The surface
   * is stamped at fire 0 and advanced by `applyFireToSurface`; a fresh empty map
   * at a later fire refuses by name.
   */
  const surface = simulateSurface();
  // The known deviations this input and this stand-in carry, computed once: two
  // are detected from the recording, two are the stand-in's own properties.
  const inputDeviations = inputDeviationsOf(timeline, { route: ROUTE });
  // P6: the rows `surfaceAt` skips whole, counted once from the scoped
  // recording. `contextStandInOf` computes the same block per prompt; this copy
  // is the run-level count the `dropped-rows` reason names.
  const droppedRowGaps = droppedRowGapsOf(timeline.rows);
  const summary = {
    lane, mode, threshold, thresholdUnits, semantics, grammar, askOrder: order, askScope,
    // The product re-reads the shaped node at a kept fire; a `new` table is the
    // landed text. Stated once here and on every send record.
    tableSource: askScope === "kept" ? "shaped-surface" : "landed",
    firstFireDepth,
    route: { ...ROUTE }, segment, transport: transport.name, live: transport.live === true,
    // The INPUT recording's pruner state, READ FROM THE RECORDING (P1), beside
    // the state this replay MODELS. The sim mounts no host mechanism, so
    // `runHostPruner` says so rather than reusing either word for a mechanism
    // this run never ran (ADR-0041's `hostPruner` names the mount).
    ignoreHostPrunes, inputHostPruner: recordingHostPrunerState(timeline),
    modeledHostPruner: ignoreHostPrunes ? "off" : "on",
    runHostPruner: "none", hostPrunerFlag,
    inputDeviations,
    // P2: the product's configured batch size, recorded beside the lane's own,
    // so a `batch-lane:<n>` reason is re-derivable from the summary.
    productBatchSize: PRODUCT_BATCH_SIZE,
    // P3: the segment cut and how many later rows it removed before units were
    // built. A cut run reports its own population, never a whole-file claim.
    segmentExcludedRows: timeline.excludedRows ?? 0,
    // P3: the ruler's own binding: how many measured steps the transcript
    // declared and how many the serie read, so a run states what its depths were
    // pinned to.
    usageSteps,
    // Small correctness (eleventh audit): the COUNT pins
    // (`assertSegmentPins`'s eligible/appends/replacements/reasoning block) run
    // only when the segment is the pinned one. A run on any other segment
    // carries no count pins, and says so here rather than letting a reader
    // assume the pinned counts were checked.
    countPins: {
      appliesAtSegment: SEGMENT_PINS.segment,
      active: segment === SEGMENT_PINS.segment,
      note: segment === SEGMENT_PINS.segment
        ? "the pinned world's count pins ran on this segment"
        : `segment ${String(segment)} carries no count pins: they apply to segment`
          + ` ${String(SEGMENT_PINS.segment)} only`,
    },
    // P1/P6: the whole-row omissions the stand-in skipped, counted once from the
    // scoped recording (the same source `contextStandIn.droppedRows` reads).
    droppedRows: droppedRowGaps,
    /** Summed over the run's prompts; each send record states its own block. */
    droppedPartsTotal: 0,
    /** Parts and rows the stand-in RE-PROJECTS (`Tool call:` turns), never lost:
     * summed over prompts / counted once from the recording (thirteenth audit 7). */
    projectedPartsTotal: 0,
    projectedRows: droppedRowGaps.projectedCount,
    /** P4: kept rows the quote re-read dropped from a table, summed over fires. */
    keptNoQuoteRows: 0,
    depthSource: source, pruneGate, reconstruction: timeline.reconstruction === true,
    allowZeroReasoning,
    reasoning: {
      resendableBlocks: timeline.reasoningBlocks ?? 0,
      resendableBytes: timeline.reasoningBytes ?? 0,
      reasoningParts: timeline.reasoningParts ?? 0,
      reasoningStreamBlocks: timeline.reasoningStreamBlocks ?? 0,
      // The WHOLE FILE's pair, distinct from the segment's 93 / 93 and pinned
      // beside it (P8).
      fileReasoningParts: timeline.fileReasoningParts ?? 0,
      fileReasoningStreamBlocks: timeline.fileReasoningStreamBlocks ?? 0,
      reasoningTurns: timeline.reasoningTurns ?? 0,
      // P4: the assistant turns the reasoning turns live in, the turns that
      // still carry a part, and the turns whose own replay-state/stream echo
      // names a reasoning block. P3 (eleventh audit): `turnCoverage` is a GATE
      // input, not a label — `assertReasoningCarried` refuses a transcript below
      // `coverageFloor` (`sim-batch-reasoning-coverage`), because a source that
      // lost reasoning on half its turns drops the part, the block and the echo
      // together and every other count stays equal.
      assistantTurns: timeline.assistantTurns ?? 0,
      partTurns: timeline.reasoningPartTurns ?? 0,
      markedTurns: timeline.reasoningMarkedTurns ?? 0,
      turnCoverage: (timeline.assistantTurns ?? 0) === 0
        ? null : (timeline.reasoningTurns ?? 0) / timeline.assistantTurns,
      coverageFloor: REASONING_TURN_COVERAGE_FLOOR,
      unresendableRows: timeline.reasoningUnresendableRows ?? 0,
      zeroDeclared: (timeline.reasoningBlocks ?? 0) === 0,
      allowZeroReasoning,
      voidComparison: (timeline.reasoningBlocks ?? 0) === 0 && allowZeroReasoning,
    },
    /** P3: at least one send carried a reasoning turn (set after the lanes run). */
    reasoningSent: null,
    /** Fourteenth audit item 5: the readings that decide each check's per-run
     * outcome. `reasoningMessagesSent` counts the MAIN send of each fire (a
     * correction repeats the same prompt's count, so it is never added twice);
     * `carriedOverridesCompared` counts the carried seqs `assertCarriedOverrides`
     * actually compared byte for byte. */
    reasoningMessagesSent: 0, carriedOverridesCompared: 0,
    // The host's own series, kept as provenance. It is the lane's ruler only on
    // the host-pruner path; a pruner-off lane records it and never triggers on it.
    hostDepths: { source: HOST_DEPTH_SOURCE,
      contaminated: source === SURFACE_DEPTH_SOURCE,
      ...(source === SURFACE_DEPTH_SOURCE
        ? { reason: "measured while the host tool-result pruner was active" } : {}),
      rows: depths },
    pins, eligible: eligibleUnits.length, askable: units.length,
    eligibleSplit: eligibleSplitOf(timeline, eligibleUnits),
    askableSplit: eligibleSplitOf(timeline, units),
    // The host-pruned population, split by whether the prune left a window in
    // which the unit was on the surface. `hostPrunedEligible` is every eligible
    // unit a prune names; `askableBeforePrune` was tabled at an earlier fire
    // (and a shape applied then is credited); `hostPrunedBeforeLanding` was
    // removed STRICTLY before its own landing step and never appeared.
    ...askableCountsOf(timeline, eligibleUnits, units),
    // The floor and every exclusion that produced `units`: the sample is
    // reproducible from the run's own record, not from a reader's guess.
    eligibility: eligibilityOf(timeline, floor),
    triggers: 0, asks: 0, sends: 0, carried: 0, unansweredFires: 0, droppedBatchUnits: 0,
    /** Askable units a host prune removed before any fire tabled them: never
     * asked, counted inside `carried`, and named here so the total decomposes. */
    prunedBeforeAsk: 0,
    /** Every fire's step, in fire order (the plan-vs-live equality test reads it). */
    fireSteps: [],
    /** One booking per unit whose removal CHANGED, at its latest booking step:
     * `{unitId, step, bytes}`. Their sum equals `bytesFreedByPolicy` on EVERY
     * run — the end of `runLane` asserts it (`sim-batch-booking-sum`) — and a
     * no-change re-ask books nothing, a host-pre-empted shape books nothing (P7/P2). */
    removalBookings: [],
    stoppedAtCeiling: false, stoppedAtBudget: false, tokenGrant,
    keep: 0, forget: 0, keeplines: 0, keptLines: 0, totalLines: 0,
    keptFraction: null, appliedForgets: 0, refused: 0,
    /** A batch lane's natural partial-batch carry (the product never flushes). */
    batchRemainder: 0,
    firstPassRefusals: 0, refusedSends: 0, promptPeakBytes: 0,
    /** SEND-level refusals keyed by a failed send's `failureClass` (timeout,
     * stream-truncated, ...). It never counts a row the parser refused; that is
     * `rowRefusalClasses` below, and the two are never mixed (ISSUE-184). */
    refusalClasses: {},
    /** ROW-level refusals keyed by the reader's own code (`spans-outside-result`,
     * `answer-unreadable`, `action-not-in-grammar`, ...), folded from every
     * fire's `distribution.rows`. Its counts sum to `refused` by construction,
     * so a reader never has to walk `records[]` to classify a refusal. */
    rowRefusalClasses: {},
    /** Fires whose one correction send failed: nothing they tabled was applied
     * and the whole fire is unanswered. The rows ride beside the fire count so
     * the loss is visible without reading the decision log (fourteenth audit 3). */
    correctionFailedFires: 0, correctionFailedRows: 0,
    /** Fires the TRANSPORT answered whose reply carried no readable text (a
     * reasoning-only reply, an empty answer, a tool-call-only answer). The
     * product refuses each tabled row and continues; this run does the same, so
     * the fire is counted unanswered (`unansweredFires`) beside its row count,
     * and it is NOT a failed send and NOT a carried batch. */
    parseRefusedFires: 0, parseRefusedRows: 0,
    promptPeakWireBytes: 0,
    promptPeakGuardTokens: 0, promptPeakEstimateTokens: 0, promptPeakToolsBytes: 0,
    // `fidelityWarnings` counts PROVIDER band misses only. `fidelitySynthetic`
    // counts the stub's own bands, which grade nothing: a run with eight of them
    // and zero warnings has no provider grader, and must not read as a pass.
    fidelityWarnings: 0, fidelitySynthetic: 0, fidelityProvider: 0,
    // The live path's own overflow flag: a policy that out-freed the measured
    // depth is clamped at 0 AND recorded, exactly as the plan records it.
    depthOverflow: false,
    /** The stand-in statement: the FIRST fire's block, labelled `promptScope:
     * "first-fire"`; every send record carries its own prompt's block. */
    contextStandIn: null,
    textSource: TEXT_SOURCE,
    build: buildIdentityOf({ live: fileURLToPath(import.meta.url) }),
    // The two input hashes this run's pinned claim names, and the usage file the
    // second is the hash of (the paths and their lengths also ride the run
    // output's own `input` block in `main`). `assertSegmentPins` recomputes the
    // usage hash from this file on EVERY segment (P2).
    inputPins: { transcriptSha256: input?.transcriptSha256 ?? timeline.transcriptSha256 ?? null,
      usageSha256: input?.usageSha256 ?? null,
      usageFile: input?.usageFile ?? null },
    promptTokens: 0, completionTokens: 0, totalTokens: 0, failures: [],
    // The ruler the run's token totals were counted under, and the synthetic
    // bucket the stub's own readings land in (never the provider totals).
    usageRuler: null,
    // The route's measured ruler, set once by the first ACCEPTED live send:
    // `{bytesPerToken, fromAsk, providerPromptTokens, promptBytes, toolBytes,
    // textBytes, source: "first-send", points: [ask 0], solved: null}`. Ask 1
    // appends its point and solves `{rTool, rText, solvedFrom: [0, 1]}`; a
    // degenerate solve sets `rulerFallback: true` and `fallbackReason` instead.
    // Null on a stub/non-live run and before any send. A synthetic reading never
    // calibrates it.
    tokenRuler: null,
    estimatedTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  /**
   * The eligible population's landed bytes, stated once. An A/B grammar lane
   * reads `freed` against it to report what each grammar left on the surface; it
   * is a property of the INPUT, so every grammar arm reads the same number.
   */
  summary.eligibleBytes = eligibleUnits.reduce((sum, unit) => sum + unit.bytes, 0);
  /**
   * Tokens spent so far under the run's own ruler. A run uses ONE ruler
   * (`usageRuler`): a provider reading accumulates in `promptTokens`/
   * `completionTokens`, the stub's synthetic reading in `estimatedTokens`. The
   * two buckets are exclusive, so the sum is one reading, never double count.
   */
  const spentTokensOf = () => summary.promptTokens + summary.completionTokens
    + summary.estimatedTokens.promptTokens + summary.estimatedTokens.completionTokens;
  /**
   * Every shaped unit still applied, cumulative over the run: each fire adds
   * its applied seqs and drops the ones it restored. The next fire must carry
   * ALL of them, not only the last fire's (audit 5, item 5).
   */
  const carrySet = new Set();
  let carrySeqs = [];
  /** P3: whether any send carried a reasoning turn; see `fireOf`. */
  let reasoningSent = false;
  const fireOf = async (batchUnits, fire, askIndex, kept = null) => {
    // The token budget is the run's one cap. Checked BEFORE the fire is counted
    // as a trigger or an ask, so a budget stop is a stopped lane, never a fire
    // that produced no answer: the caller's stop branch carries the unsent batch.
    if (spentTokensOf() >= budgetLimit) {
      summary.stoppedAtBudget = true;
      return { stop: true, droppedUnits: batchUnits.length,
        droppedUnitIds: batchUnits.map(unit => unit.id) };
    }
    summary.triggers += 1;
    summary.fireSteps.push(fire.step);
    const batch = { units: batchUnits, step: fire.step, maxSeq: Math.max(...batchUnits.map(u => u.seq)) };
    let sent;
    try {
      sent = await askAndApply({ batch, timeline, depths,
        lane, mode, threshold, semantics, transport: wireTransport, deadline, decisions, removals,
        fire, askIndex, summary, grammar, order, askScope, kept, firstFireDepth, surface,
        carrySeqs, depthSource: source, inputDeviations });
    } catch (error) {
      // A refusal inside one ask still has an ask index and a partial summary;
      // the caller writes both into the partial result artifact.
      onRefusal({ error, askIndex, summary });
      throw error;
    }
    // A trigger that produced no ask is a lost fire. This runs at EVERY fire so
    // a future path that skips the ask increment fails here, not only when the
    // final summary is written; the `asks !== triggers` branch is a drift
    // guard, not a class today's path can enter.
    assertAskTotals({ asks: summary.asks, triggers: summary.triggers });
    if (sent.stop !== true) {
      // A unit the HOST removed by this fire is no longer the policy's to carry:
      // its shaped body is dead on the surface, and demanding it of the next
      // prompt would refuse a run whose removal the host took over.
      for (const seq of hostRemovedAt(timeline, fire.step)) carrySet.delete(seq);
      for (const seq of sent.appliedSeqs ?? []) carrySet.add(seq);
      for (const seq of sent.restoredSeqs ?? []) carrySet.delete(seq);
      carrySeqs = [...carrySet].sort((left, right) => left - right);
      // The independent half of the surface gate: rebuild the expected map from
      // the DECISION LOG and the landed bodies, never from `applyFireToSurface`'s
      // `applied` map (a writer that put its wrong body into both would pass a
      // digest built from its own output). Then compare the carry set to the same
      // rebuild's shaped set, minus the seqs the host had removed by this fire.
      const rebuilt = reconstructedSurfaceOf({ timeline, units, decisions, lane });
      assertSurfaceAdvanced({ surface, fire: summary.asks, shaped: summary.appliedForgets,
        expectedSize: rebuilt.size, expectedDigest: surfaceDigestOf(rebuilt) });
      const removedNow = hostRemovedAt(timeline, fire.step);
      const shapedNow = [...rebuilt.keys()].filter(seq => !removedNow.has(seq))
        .sort((left, right) => left - right);
      assertCarrySetMatches({ carrySeqs, shapedNow, fire: summary.asks });
    }
    onRecord(sent.record);
    for (const extra of sent.extraRecords ?? []) onRecord(extra);
    // P3: did ANY request this run send carry a reasoning turn? A fire before
    // the first assistant turn legitimately carries zero, so the flag is
    // cumulative over every send (failures included: their record still states
    // what the request built).
    for (const sentRecord of [sent.record, ...(sent.extraRecords ?? [])]) {
      if ((sentRecord?.reasoningMessages ?? 0) > 0) reasoningSent = true;
    }
    // One count per FIRE, from the main send: the correction repeats the same
    // prompt's reasoning block, so adding both would double the reading.
    summary.reasoningMessagesSent += sent.record?.reasoningMessages ?? 0;
    // The stand-in block is PER PROMPT. The summary keeps the FIRST fire's copy,
    // labelled so no reader takes its `droppedParts` for a run total; every send
    // record carries its own prompt's block.
    if (summary.contextStandIn === null) {
      summary.contextStandIn = { ...sent.record.contextStandIn, promptScope: "first-fire" };
    }
    const record = sent.record;
    const line = record.parseRefused
      // The transport answered and the reply carried no readable row: every row
      // KEEPs and the lane continues. This is not the FAILED line: nothing was
      // dropped and nothing is carried.
      ? `[lane ${lane}] ask ${record.askIndex} step ${record.fireStep} NO TEXT`
        + ` (${String(record.refusedRows)} row(s) refused/KEEP, nothing applied;`
        + " the lane continues)"
      : record.ok
      ? `[lane ${lane}] ask ${record.askIndex} step ${record.fireStep} prompt `
        + `${record.promptTokens ?? "-"} tok est=${record.promptTokensEstimate}`
        + ` keep=${record.distribution.keep} forget=${record.distribution.forget}`
        + ` applied=${record.appliedForgets}`
        + ` refused=${record.distribution.refused}${record.correction === null ? "" : " corrected"}`
      : `[lane ${lane}] ask ${record.askIndex} FAILED ${record.error}`
        + ` (batch of ${String(record.droppedUnits ?? 0)} dropped, counted as carried)`;
    log(line);
    return sent;
  };

  if (mode === "batch") {
    let state = { pending: [] };
    let stopped = false;
    const seqById = new Map(units.map(unit => [unit.id, unit.seq]));
    // A pending id whose seq the host had removed by this fire can never be
    // tabled again: drop it before the cadence counts the next batch.
    const dropRemoved = step => {
      const removed = hostRemovedAt(timeline, step);
      const held = state.pending.filter(id => !removed.has(seqById.get(id)));
      summary.prunedBeforeAsk += state.pending.length - held.length;
      if (held.length !== state.pending.length) state = { pending: held };
    };
    for (const [at, unit] of units.entries()) {
      dropRemoved(unit.step);
      const verdict = batchVerdict(state, lane, unit.id);
      state = verdict.state;
      if (verdict.kind !== "fire") continue;
      const batchUnits = units.filter(candidate => verdict.batch.includes(candidate.id));
      // The ceiling counts ASKS, not sends: a correction send belongs to the
      // ask it corrects and never spends another slot. The batch this trigger
      // already formed is UNSENT, so it is carried beside the trigger's own
      // pending tail and the units after the trigger (`state.pending` is the
      // post-fire state, so it does not hold that batch).
      if (summary.asks >= askLimit) {
        summary.stoppedAtCeiling = true;
        summary.carried = state.pending.length + verdict.batch.length
          + (units.length - at - 1) + summary.prunedBeforeAsk;
        stopped = true;
        break;
      }
      // The fire's depth follows the lane's stated ruler, exactly as the
      // threshold loop reads it. A HOST-source lane reads the measured depth at
      // its own step NET of the removals earlier fires booked (without this the
      // batch anchor compared the provider's count to the un-reduced measured
      // depth while the prompt sent the reduced one). A pruner-off lane reads the
      // reconstructed surface: `depthSource` said `reconstructed-surface`, so the
      // host series must not appear as `triggerDepth` (it was measured with the
      // trim active and is recorded as contaminated).
      let depth = null;
      if (source === SURFACE_DEPTH_SOURCE) {
        depth = surfaceDepthAt({ timeline, fireStep: unit.step, surface,
          fireIndex: summary.asks }).tokens;
      } else {
        let removed = 0;
        for (const removal of removals.values()) {
          // The policy's removal is visible until the host's own prune takes
          // that body out of the measured series; after that, subtracting it
          // again would double-count the host's removal.
          if (removal.step < unit.step
            && (removal.pruneStep === null || unit.step < removal.pruneStep)) {
            removed += removal.bytes;
          }
        }
        const measured = anchorDepthOf(depths, unit.step);
        const rawDepth = Number.isSafeInteger(measured.tokens)
          ? measured.tokens - signedMeasuredTokensOf(removed) : null;
        if (rawDepth !== null && rawDepth < 0) summary.depthOverflow = true;
        depth = rawDepth === null ? null : Math.max(rawDepth, 0);
      }
      // The fire's own step and its trigger depth. The anchor's addend is every
      // unit that landed at this step, which `askAndApply` reads from the
      // timeline itself (P7), never a single `unitBytes` guess.
      const fire = { step: unit.step, ...(depth === null ? {} : { depth }) };
      const fired = await fireOf(batchUnits, fire, summary.asks);
      if (fired.stop) {
        // The fire's batch was DROPPED, not answered: it is carried, beside the
        // units that had not reached the trigger yet AND the askable units a
        // host prune removed before any fire tabled them. Every one of them is
        // in `carried`, the count of askable units the run never asked; a
        // stopped lane that omitted the last term understated the hole by
        // exactly those units (P5).
        summary.carried = state.pending.length + (units.length - at - 1)
          + (fired.droppedUnits ?? 0) + summary.prunedBeforeAsk;
        stopped = true;
        break;
      }
    }
    // The units the host prunes after the last unit's step are off the surface
    // too; they are not carried (nothing could ask them).
    if (!stopped) {
      dropRemoved(timeline.segment ?? (units[units.length - 1]?.step ?? 0));
      summary.carried = state.pending.length + summary.prunedBeforeAsk;
      // The PRODUCT's own tail: `batchVerdict` never flushes a partial batch
      // (`batch-trigger.ts`: a partial batch at session end is carried). This
      // is not a run shortfall, and the completeness list names it as
      // `batch-remainder:<n>` (twelfth audit item 11).
      summary.batchRemainder = state.pending.length;
    }
  } else {
    if (depths.length === 0) refuse("sim-batch-depth-absent", "threshold mode needs a measured step");
    const byUnits = thresholdUnits === "landed-bytes";
    let pending = [];
    /** unitId → the unit whose latest verdict kept it; `kept` scope's carry-over. */
    const kept = new Map();
    let index = 0;
    let lastFireDepth = null;
    let landedBytes = 0;
    const compactionStep = timeline.compaction === null ? null : timeline.compaction.step;
    let reset = false;
    let firstFire = true;
    let stopped = false;
    /**
     * One fire at `fireStep`: the current pending stream becomes the table. The
     * landed-bytes lane calls this once per LANDING, so a result landing on step
     * S fires on S — `entryTriggerFor` runs from the landing call in the product.
     * Returns true when the run must stop (ceiling or a dropped fire).
     */
    const firePendingAt = async (fireStep, depth) => {
      if (summary.asks >= askLimit) {
        summary.stoppedAtCeiling = true;
        summary.carried = pending.length + (units.length - index) + summary.prunedBeforeAsk;
        stopped = true;
        return true;
      }
      // The fire's table: under `kept`, every row the earlier fires kept, then
      // this fire's newly eligible units. One row per unitId; `new` is pending only.
      // Both are already filtered to the surface at THIS step.
      const tableUnits = askScope === "kept"
        ? askableAt(timeline, tableUnitsOf({ kept, pending }), fireStep) : pending;
      const fired = await fireOf(tableUnits, { step: fireStep, depth }, summary.asks,
        askScope === "kept" ? kept : null);
      firstFire = false;
      if (fired.stop) {
        // A dropped fire leaves its table unasked: those units and every unit
        // that never reached the trigger are carried. A SET, never a maximum:
        // under `kept` the table re-asks rows the earlier fires already asked,
        // and a failed re-ask does not make them never asked. Counting them
        // would inflate `carried`; a max over two disagreeing lists could also
        // hide a row both lists hold. The set is the union minus the re-asked
        // rows, so `carried-units` can neither understate nor overstate the
        // hole the stopped fire leaves.
        const carriedIds = new Set(pending.map(unit => unit.id));
        for (const unit of units.slice(index)) carriedIds.add(unit.id);
        const askedBefore = new Set(askScope === "kept" ? kept.keys() : []);
        for (const id of fired.droppedUnitIds ?? []) {
          if (!askedBefore.has(id)) carriedIds.add(id);
        }
        summary.carried = carriedIds.size + summary.prunedBeforeAsk;
        stopped = true;
        return true;
      }
      // `incremental` measures the next window from the post-removal depth. The
      // delta is NET and SIGNED: a restoring re-ask (negative delta) grants no
      // free credit, and a trim whose summary and markers cost more than the
      // body it removed ADDS depth, so the next window starts higher.
      const removalBytes = fired.removalDelta;
      pending = [];
      landedBytes = 0;
      // `incremental` (the default) measures the next window from the
      // post-removal depth; `growth`/`absolute` keep the pre-removal depth.
      if (!byUnits) lastFireDepth = nextBaselineDepth({ depth, removalBytes, semantics });
      return false;
    };
    for (const entry of depths) {
      // The depth lane lands every unit BEFORE the measured step; the
      // landed-bytes lane lands them one at a time below, at their own step.
      if (!byUnits) {
        while (index < units.length && units[index].step < entry.step) {
          pending.push(units[index++]);
        }
      }
      // A host prune takes a row off the surface at its own step: every pending
      // row it names can never be tabled again, and its bytes leave the byte
      // accumulator. `kept` rows go too. This is the time-aware stream (P3).
      const removedNow = hostRemovedAt(timeline, entry.step);
      if (pending.some(unit => removedNow.has(unit.seq))) {
        const before = pending.length;
        pending = pending.filter(unit => {
          if (!removedNow.has(unit.seq)) return true;
          if (byUnits) landedBytes -= unit.bytes;
          return false;
        });
        summary.prunedBeforeAsk += before - pending.length;
      }
      for (const [id, unit] of kept) if (removedNow.has(unit.seq)) kept.delete(id);
      let removed = 0;
      for (const removal of removals.values()) {
        if (removal.step < entry.step
          && (removal.pruneStep === null || entry.step < removal.pruneStep)) {
          removed += removal.bytes;
        }
      }
      // A pruner-off lane reads the reconstructed surface's own bytes; its own
      // shaped turns are already in those bytes. The host series never triggers
      // such a lane (its depths were measured with the host trim active). On
      // the host path a policy that out-freed the measured depth is clamped at
      // 0 AND flagged: a silent clamp would hide a series the removals emptied.
      const hostDepth = source === SURFACE_DEPTH_SOURCE ? null
        : entry.tokens - signedMeasuredTokensOf(removed);
      if (hostDepth !== null && hostDepth < 0) summary.depthOverflow = true;
      const depth = source === SURFACE_DEPTH_SOURCE
        ? surfaceDepthBefore({ timeline, step: entry.step, surface, fireIndex: summary.asks }).tokens
        : Math.max(hostDepth, 0);
      // The landed-bytes lane checks the trigger after EVERY landing, so a unit
      // landing on this step can fire on this step. A unit that landed on an
      // unmeasured step is landed here; one the host had already removed is
      // never askable and is carried.
      if (byUnits) {
        while (index < units.length && units[index].step <= entry.step) {
          const unit = units[index++];
          if (removedNow.has(unit.seq)) { summary.prunedBeforeAsk += 1; continue; }
          pending.push(unit);
          landedBytes += unit.bytes;
          if (landedBytesVerdict({ landedBytes, threshold, pending: pending.length }).kind
            !== "fire") continue;
          if (await firePendingAt(entry.step, depth)) break;
        }
        if (stopped) break;
        continue;
      }
      if (lastFireDepth === null) { lastFireDepth = depth; continue; }
      if (semantics !== "absolute" && !reset && compactionStep !== null
        && entry.step >= compactionStep) {
        reset = true;
        lastFireDepth = depth;
        continue;
      }
      const verdict = thresholdVerdict({ depth, lastFireDepth, threshold, pending: pending.length,
        firstFireDepth: firstFire ? firstFireDepth : null });
      if (verdict.kind !== "fire") continue;
      if (await firePendingAt(entry.step, depth)) break;
    }
    if (!stopped) {
      summary.carried = pending.length + (units.length - index) + summary.prunedBeforeAsk;
    }
  }

  // P3: the timeline declares reasoning, at least one ask ran, and NO request
  // carried a reasoning turn. Every fire landed before the first assistant
  // turn, so `expectedReasoningAt` legitimately returned 0 at each one and every
  // gate above passed: the run measured a context the agent's reasoning never
  // entered. ADR-0045's Law needs at least one measured request that carried it,
  // so the run refuses instead of being written as a reasoning run.
  if ((timeline.reasoningBlocks ?? 0) > 0 && summary.asks > 0 && !reasoningSent) {
    refuse("sim-batch-reasoning-never-sent",
      `the timeline declares ${String(timeline.reasoningBlocks)} resendable reasoning`
      + ` turn(s) (${String(timeline.reasoningBytes ?? 0)} B) but none of the`
      + ` ${String(summary.sends)} send(s) carried one: every fire landed at or before the`
      + ` first assistant turn, so expectedReasoningAt is 0 at each and this run measures a`
      + " context without the agent's reasoning (ADR-0045). A wire claim of reasoning needs"
      + " at least one measured request that carried it; move the fire past a reasoning"
      + " turn, or drop the claim");
  }
  summary.reasoningSent = reasoningSent;
  // A run that asked nothing, or a trigger that produced no ask, is refused
  // before any summary is built. A failed send still counts as an ASK (the fire
  // was attempted) and is marked unanswered beside it.
  assertAskTotals(summary);
  // A run whose every tabled row was refused measured no decision. The row
  // records are written, but a normal summary over them would book a result
  // nobody made, so the run refuses by name instead.
  if (summary.refused > 0 && summary.keep + summary.forget === 0) {
    refuse("sim-batch-no-decided-row",
      `every tabled row was refused (${String(summary.refused)} row(s) over`
      + ` ${String(summary.asks)} ask(s)); a run with no decision measures nothing`);
  }
  // A kept-scope run re-asks rows, so `decisions` can hold several verdicts for
  // one unit. The LAST verdict is the one that stands, and P2 makes the body
  // matter: the freed bytes are read from the bodies the FIRES applied
  // (`reconstructedRemovalsOf` follows each decision through the rebuilt
  // surface), never from a re-render over the landed text. Re-rendering a
  // `keeplines` verdict over the original body can report bytes the fire never
  // freed, because the fire sized the same verdict against the SHAPED body.
  const appliedRemovals = reconstructedRemovalsOf({ timeline, units, decisions, lane });
  // The union: a shape is the policy's removal for the window it stood. A unit
  // the host removes LATER than the shape was booked is credited; a unit the
  // host had already removed when the answer landed never earned a shape.
  const policyRows = [...appliedRemovals.values()].filter(row => {
    if (!Number.isSafeInteger(row.seq)) return true;
    const pruneStep = hostPruneStepOf(timeline, row.seq);
    return pruneStep === null
      || (row.decisionStep !== null && row.decisionStep < pruneStep);
  });
  // NET is the authority (the summary, markers and framing the shaped turn still
  // occupies are deducted); gross is recorded beside it.
  summary.bytesFreedByPolicy = policyRows.reduce((sum, row) => sum + netDroppedOf(row), 0);
  summary.bytesFreedGross = policyRows.reduce((sum, row) => sum + row.terms.dropped, 0);
  // P2: the bookings the FIRES wrote must sum to the same number the independent
  // rebuild reports. The fire loop books a change per unit; the rebuild re-reads
  // every decision through the body the surface held. A kept-scope re-ask sized
  // from the wrong body moves one and not the other, so this comparison is what
  // catches it — a summary figure alone would agree with itself.
  const bookingSum = summary.removalBookings
    .reduce((sum, booking) => sum + booking.bytes, 0);
  if (bookingSum !== summary.bytesFreedByPolicy) {
    refuse("sim-batch-booking-sum",
      `the fires booked ${String(bookingSum)} B of removals but the decision log's applied`
      + ` bodies free ${String(summary.bytesFreedByPolicy)} B; the bookings and the freed`
      + " figure describe different surfaces");
  }
  // Answered applications only: a refused row applied nothing, so it is not a
  // decision and its earlier shape stands.
  summary.decidedRows = decisions.length;
  // The arm's aggregate gauge: lines left over lines asked. Instruction-only —
  // the prompt names 60 percent and nothing refuses an answer that misses it.
  summary.keptFraction = summary.totalLines === 0
    ? null : summary.keptLines / summary.totalLines;
  // The system slot's own state: one dropped turn when absent or unreadable,
  // stated on the summary so the reason's cause is never inferred.
  summary.systemAbsent = timeline.systemAbsent === true;
  summary.systemUnreadable = timeline.systemUnreadable === true;
  summary.systemDroppedRows = summary.systemAbsent || summary.systemUnreadable ? 1 : 0;
  // A run is citable only with ZERO reasons. The list is explicit and every
  // reason is recorded: the ceiling, the void zero-reasoning comparison, the
  // input recording's host pruner, a reconstruction, an offline transport, the
  // stand-in context this runner always sends, the decoded-text reading it
  // always does, a sim-only grammar or order, a run that never asked, a refused
  // send, a run that answered no row, every refused ANSWER row, a depth
  // overflow, every eligible unit that was NEVER ASKED (`carried`, with its
  // count), a declared reasoning run whose sends never carried reasoning, and
  // every known input deviation. A run that left a quarter of its sample
  // unasked is short of its own population, not a smaller measurement.
  const reasons = citableReasonsOf({
    stoppedAtCeiling: summary.stoppedAtCeiling,
    stoppedAtBudget: summary.stoppedAtBudget,
    voidComparison: summary.reasoning?.voidComparison === true,
    inputHostPruner: summary.inputHostPruner,
    reconstruction: summary.reconstruction === true,
    live: transport.live === true,
    grammar,
    order,
    syntheticRuler: transport.live === true && summary.fidelitySynthetic > 0,
    floor,
    asks: summary.asks,
    triggers: summary.triggers,
    refusedSends: summary.refusedSends,
    answeredRows: summary.keep + summary.forget,
    refusedRows: summary.refused,
    depthOverflow: summary.depthOverflow === true,
    carried: summary.carried,
    inputDeviations,
    mode,
    thresholdUnits,
    askScope,
    firstFireDepth,
    // P3: the flag the refusal above reads; a run reaching here has sent one.
    // A transcript that declares NO reasoning passes `null`: sending none is
    // what it has, and `zero-reasoning-void-comparison` already names that void.
    reasoningSent: (timeline.reasoningBlocks ?? 0) > 0 ? reasoningSent : null,
    // P2: the lane's size against the product's configured batch size.
    lane,
    productBatchSize: PRODUCT_BATCH_SIZE,
    // P3: the segment cut, whenever a segment is set, with its excluded rows.
    segment,
    excludedRows: timeline.excludedRows ?? 0,
    // P1: the content the stand-in lost, retained past the stand-in reason.
    droppedParts: summary.droppedPartsTotal,
    droppedRows: droppedRowGaps.count,
    // The prompt's first message: a missing or unreadable system slot is named,
    // never a silent empty string (twelfth audit item 4).
    systemAbsent: timeline.systemAbsent === true,
    systemUnreadable: timeline.systemUnreadable === true,
    // P2: the tool schema the run's prompts carry, and the header it came from.
    // Read from the TIMELINE, not from the first fire's block: a run that never
    // asked still states that its recording carried no tools.
    tools: { seq: timeline.toolsHeaderSeq ?? null,
      count: Array.isArray(timeline.tools) ? timeline.tools.length : 0 },
    // P5: the depth readings whose cache shape rests on their own statement.
    unverifiedShapeSteps: usageSteps.statedOnlySteps?.length ?? 0,
  });
  // P9: every emitted reason must be declared. This runs on the list the run
  // actually produced, not on the allow-list compared to itself.
  assertReasonsAllowed(reasons);
  summary.reasons = reasons;
  summary.citable = reasons.length === 0;
  // P11: `truncated` was set from `stoppedAtCeiling` alone, so a failed send, a
  // segment cut or a carried tail read as a complete sample. Completeness is its
  // own reading, and every way a run falls short is named.
  const incompleteReasons = [];
  if (summary.stoppedAtCeiling === true) incompleteReasons.push("stopped-at-ceiling");
  if (summary.stoppedAtBudget === true) incompleteReasons.push("stopped-at-budget");
  if (summary.refusedSends > 0) incompleteReasons.push("refused-sends");
  if (summary.unansweredFires > 0) incompleteReasons.push("unanswered-fires");
  if (summary.carried > 0) {
    // A batch lane's natural tail is the product's own partial-batch carry, not
    // a run shortfall: `batchVerdict` never flushes. It is named as
    // `batch-remainder:<n>`; any OTHER carried unit (a host prune that beat
    // every fire) keeps the generic name, so the two never double-count.
    const remainder = Number.isSafeInteger(summary.batchRemainder)
      ? summary.batchRemainder : 0;
    const other = summary.carried - remainder;
    if (remainder > 0) incompleteReasons.push(`batch-remainder:${String(remainder)}`);
    if (other > 0) incompleteReasons.push(`carried-units:${String(other)}`);
  } else if (summary.batchRemainder > 0) {
    incompleteReasons.push(`batch-remainder:${String(summary.batchRemainder)}`);
  }
  // P1: a tabled row the PARSER refused is an answer the run did not get. It was
  // a citation reason but not an incompleteness: ten rows tabled, seven decided
  // and three refused still reported `complete: true` over 70% of the sample.
  if (summary.refused > 0) incompleteReasons.push(`refused-rows:${String(summary.refused)}`);
  // Twelfth audit item 5: `complete` could be true while a kept row the quote
  // re-read dropped left the table, and while the stand-in itself lost parts or
  // whole rows. Both are content the run did not measure, so they belong in the
  // completeness list, not only in the citation reasons.
  if (summary.keptNoQuoteRows > 0) {
    incompleteReasons.push(`kept-no-quote:${String(summary.keptNoQuoteRows)}`);
  }
  const droppedContent = summary.droppedPartsTotal + droppedRowGaps.count;
  if (droppedContent > 0) {
    incompleteReasons.push(`dropped-content:${String(droppedContent)}`);
  }
  if ((timeline.excludedRows ?? 0) > 0) {
    incompleteReasons.push(`segment-cut:${String(timeline.excludedRows)}`);
  }
  // Thirteenth audit item 2: a missing or unreadable system turn is content the
  // prompt does not carry, and an eligible unit the host removed before any fire
  // could table it is a hole in the sample. Both were citation reasons at most;
  // neither could make a run incomplete.
  if (summary.systemAbsent === true) incompleteReasons.push("system-absent:1");
  if (summary.systemUnreadable === true) incompleteReasons.push("system-unreadable:1");
  if ((summary.hostPrunedBeforeLanding ?? 0) > 0) {
    incompleteReasons.push(
      `host-pruned-before-landing:${String(summary.hostPrunedBeforeLanding)}`);
  }
  summary.complete = incompleteReasons.length === 0;
  summary.incompleteReasons = incompleteReasons;
  // The reasons MINUS ONLY the stand-in WIRE reason. `text-source` and the two
  // dropped-content reasons are retained: they are content dimensions of the
  // stand-in, and subtracting `stand-in-context` must not hide them (P10). The
  // list therefore NEVER reads empty: `text-source` is unconditional too.
  const citableForStandIn = reasons.filter(reason => !UNIVERSAL_SIM_REASONS.includes(reason));
  summary.citableForStandIn = citableForStandIn;
  summary.measurement = {
    citable: summary.citable,
    citableForStandIn,
    complete: summary.complete,
    incompleteReasons,
    reasons,
    // Fourteenth audit item 5: the checks' PER-RUN outcomes, not the static
    // catalog. `CHECK_CLASSES` stays the documentation of why each cannot fail;
    // this list says which of them measured a non-empty population on THIS run
    // and which was vacuous, with the count that decided it.
    checks: checkOutcomesOf({
      asks: summary.asks,
      reasoningTurns: timeline.reasoningTurns ?? 0,
      replayedPrunes: Number.isSafeInteger(timeline.replayedPrunes)
        ? timeline.replayedPrunes : 0,
      ignoreHostPrunes,
      decidedRows: summary.decidedRows,
      reasoningMessages: summary.reasoningMessagesSent,
      carriedOverrides: summary.carriedOverridesCompared,
    }),
  };
  return summary;
}

/** `taskkill /PID <pid> /T /F`: the law's whole-tree kill. */
function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * Arm the kill timer before the first request and stamp it into the evidence
 * directory. Returns the arm record; the timer is unref'd so a clean exit is not
 * held open.
 */
export function armKillTimer({ armedMs, outDir, writeStamp = writeFileSync }) {
  if (!Number.isSafeInteger(armedMs) || armedMs < 0) {
    refuse("sim-batch-kill-invalid",
      `a kill timer is a non-negative integer; 0 arms none, a positive value arms one,`
      + ` got ${String(armedMs)}`);
  }
  const tooLong = timerDelayRefusal(armedMs, "--kill-ms");
  if (tooLong !== null) refuse("sim-batch-kill-invalid", tooLong);
  mkdirSync(outDir, { recursive: true });
  const armedAt = new Date();
  // `0` is OFF (owner ruling 2026-11-08): no stamp, no timer, and the record
  // says so in one word. The token budget is the only run cap.
  if (armedMs === 0) {
    return { armedMs: 0, timer: "off", armedAt: armedAt.toISOString(), firesAt: null };
  }
  const firesAt = new Date(armedAt.getTime() + armedMs);
  writeStamp(path.join(outDir, "kill-timer-armed.txt"),
    `kill-timer-armed ${armedMs} ms at ${armedAt.toISOString()} fires ${firesAt.toISOString()}`
    + ` pid ${process.pid}\n`);
  const timer = setTimeout(() => {
    try {
      writeStamp(path.join(outDir, "kill-timer-fired.txt"),
        `kill-timer-fired at ${new Date().toISOString()} (${armedMs} ms, pid ${process.pid})\n`);
    } catch { /* best effort */ }
    killTree(process.pid);
    process.exit(124);
  }, armedMs);
  timer.unref?.();
  return { armedMs, timer: "armed", armedAt: armedAt.toISOString(),
    firesAt: firesAt.toISOString() };
}

function laneName(mode, lane, threshold, thresholdUnits = DEFAULT_THRESHOLD_UNITS) {
  return mode === "threshold"
    ? thresholdLaneName(threshold, thresholdUnits) : `batch-${String(lane)}`;
}

/**
 * The one-line `[summary]` a run prints. The eligibility block names ALL FIVE
 * exclusions the population split records — `unreadable-content`,
 * `non-text-content`, `below-floor`, `error-result`, `no-two-quotes` — so the
 * console never hides a count the JSON carries (fourteenth audit item 2). Its
 * first word says `TRUNCATED` at a cap — the ask ceiling or the token budget —
 * and `INCOMPLETE` for any other shortfall. A ceiling of 0 is OFF, so it can
 * never label a stop it did not cause.
 */
export function summaryLineOf(summary, { askCeiling, tokenGrant = null, semantics,
  firstFireDepth }) {
  const ceilingArmed = Number.isSafeInteger(askCeiling) && askCeiling > 0;
  const budget = tokenGrant ?? summary.tokenGrant ?? null;
  const spent = (summary.promptTokens ?? 0) + (summary.completionTokens ?? 0)
    + (summary.estimatedTokens?.promptTokens ?? 0)
    + (summary.estimatedTokens?.completionTokens ?? 0);
  const stopLabel = summary.stoppedAtBudget === true
    ? ` TRUNCATED: stopped at the token budget ${String(budget)} after`
      + ` ${String(spent)} token(s); ${String(summary.carried)} unit(s) carried;`
      + " the sample is incomplete"
    : summary.stoppedAtCeiling === true && ceilingArmed
      ? ` TRUNCATED: stopped at the ask ceiling ${String(askCeiling)} after`
        + ` ${String(summary.asks)} ask(s); ${String(summary.carried)} unit(s) carried;`
        + " the sample is incomplete"
      : summary.complete ? "" : ` INCOMPLETE: ${summary.incompleteReasons.join(", ")};`
        + " the sample is incomplete";
  return `[summary]${stopLabel} asks ${summary.asks}/${summary.triggers} fires`
    + `${summary.unansweredFires === 0 ? "" : ` (${String(summary.unansweredFires)} unanswered,`
      + ` ${String(summary.droppedBatchUnits)} batch rows dropped`
      + `${(summary.parseRefusedRows ?? 0) === 0 ? ""
        : `, ${String(summary.parseRefusedRows)} row(s) refused/KEEP on`
          + ` ${String(summary.parseRefusedFires)} answered-but-empty fire(s)`})`}`
    + ` semantics=${semantics} depth=${summary.depthSource}`
    + `${firstFireDepth === null ? "" : ` first-fire=${firstFireDepth}`}`
    + ` eligible ${summary.eligibleSplit.total} = ${summary.eligibleSplit.appends} appends`
    + ` + ${summary.eligibleSplit.replacements} replacements; appends`
    + ` ${summary.eligibleSplit.appends} = ${summary.eligibleSplit.neverPruned} never-pruned`
    + ` + ${summary.eligibleSplit.prunedOriginals} host-pruned originals`
    + ` keep=${summary.keep} forget=${summary.forget} applied=${summary.appliedForgets}`
    + ` refused=${summary.refused}`
    + ` fidelity provider ${summary.fidelityProvider} (warnings ${summary.fidelityWarnings}),`
    + ` synthetic ${summary.fidelitySynthetic}`
    + (summary.tokenRuler === null ? ""
      : ` ruler ${summary.tokenRuler.bytesPerToken.toFixed(2)} B/token (ask`
        + ` ${String(summary.tokenRuler.fromAsk)})`)
    + `${summary.depthOverflow ? " DEPTH-OVERFLOW" : ""}`
    + ` peak-wire ${summary.promptPeakWireBytes} B`
    + ` eligible-population floor ${summary.eligibility.floor}`
    + ` (excluded ${summary.eligibility.excluded.unreadableContent} unreadable-content,`
    + ` ${summary.eligibility.excluded.nonTextContent} non-text-content,`
    + ` ${summary.eligibility.excluded.belowFloor} below-floor,`
    + ` ${summary.eligibility.excluded.errorResult} error-result (the product drops these too),`
    + ` ${summary.eligibility.excluded.noTwoQuotes} no-two-quotes)`
    + ` freed ${summary.bytesFreedByPolicy} B net (${summary.bytesFreedGross} B gross)`
    + ` carried ${summary.carried}`
    + `${summary.citable ? " (citable)" : ` (non-citable: ${summary.measurement.reasons.join(", ")})`}`;
}

/* ------------------------------------------------------------------------- *
 * The inline-ask lane (inline-ask experiment, 2026-11-08; SIM ONLY)
 *
 * The plan (`docs/plans/2026-11-08-inline-ask/plan.md`) asks for a lane on the
 * EXISTING replay, not a synthetic surface. This lane reuses the recording's
 * rows exactly as `surfaceAt` reads them: the same transcript, the same floor,
 * the same shapes. The difference is WHERE the ask rides.
 *
 * THE HONEST LIMITATION. A recording was made without blocks, so its assistant
 * turns carry no tagged answer. The lane appends each eligible result's block at
 * landing (no extra ask turn), then runs ONE labelled `replay-extra-call` whose
 * reply is the model's next assistant turn, and splices that reply's JSON object
 * into the recording's own next assistant turn. The turn count does not move:
 * the extra call is a CALL, counted and labelled `replay-extra-call`, never a
 * turn. `replayCallsPerResult` states the rate, and every arm record says the
 * replies came from extra replay calls. Nothing is invented silently.
 *
 * THE BAR. At 200,000 tokens the surface is rebuilt once: every block and every
 * tagged answer is removed (the original result and assistant bytes restored,
 * asserted byte for byte), the recorded choices are applied through
 * `rebuildSurface` (receipts and recall ids), and the big table pass runs for the
 * units with no inline decision. That pass speaks `jsonl-20-nokeepall` and the
 * 40 percent line ONLY; the 70 percent line is never built in this lane.
 *
 * THE TABLE-ONLY ARM. The same input, no blocks and no extra calls: one table
 * pass when the surface first reaches the bar, one call, applied through the
 * same shape path. Both arms write their own record and a comparison JSON.
 *
 * THE COMMON STOP. The inline arm's budget can end it before the input does, so
 * the table-only arm is capped at the inline arm's stop step: the earlier of the
 * budget stop and input end. Both records and the comparison carry
 * `commonStop{step, by}`. The primary comparison reads that one window
 * (`commonPrefix`); `fullRun` is the secondary, clearly labelled view.
 * ------------------------------------------------------------------------- */

/** The one grammar the inline lane's table pass speaks (the no-keepall arm). */
export const INLINE_TABLE_GRAMMAR = "jsonl-20-nokeepall";
/** The 40 percent share line; the lane must never build the 70 percent one. */
export const INLINE_FORTY_PERCENT_LINE = "keep at most 40 percent";
export const INLINE_SEVENTY_PERCENT_LINE = "keep at most 70 percent";
/** The schema ids both arm artifacts and the comparison carry. */
export const INLINE_ARM_SCHEMA = "racoons-sim-inline-ask/1";
export const INLINE_COMPARE_SCHEMA = "racoons-sim-inline-ask-compare/1";

/**
 * The replay rows the inline lane reads, in the surface's own order: the same
 * selection `surfaceAt` performs (text-bearing user/assistant rows, the tool
 * call projection, tool results with the host's trim honoured), but with the
 * canonical RESULT BODY kept separate from the `"<call>:\n"` display prefix, so
 * `rebuildSurface` can cut a block without touching that prefix. `step` is the
 * row's owning step, the same `entrySteps` reading the fires use.
 */
export function inlineCanonicalMessages({ timeline } = {}) {
  if (timeline === null || typeof timeline !== "object") {
    throw new RangeError("inlineCanonicalMessages needs a timeline");
  }
  const messages = [];
  for (const row of timeline.rows ?? []) {
    if (!Number.isSafeInteger(row?.seq)) continue;
    const entry = timeline.entrySteps?.get(row.seq)
      ?? (Number.isSafeInteger(row.data?.step) ? row.data.step : null);
    if (entry === null) continue;
    if (timeline.entryAskSeqs?.has(row.seq)) continue;
    if (row.type === "user/message" || row.type === "assistant/message") {
      const text = textOf(row);
      const reasoning = row.type === "assistant/message" ? reasoningOf(row) : null;
      const reasoningText = reasoning?.resendable === true ? reasoning.text : "";
      if (text.length === 0 && reasoningText.length === 0) continue;
      messages.push({
        seq: row.seq, kind: row.type,
        role: row.type === "user/message" ? "user" : "assistant",
        text, call: null, reasoning: reasoningText, step: entry,
      });
    } else if (row.type === "tool/call") {
      messages.push({
        seq: row.seq, kind: "tool/call", role: "assistant",
        text: projectionOf(row), call: null, reasoning: "", step: entry,
      });
    } else if (row.type === "tool/result") {
      // The host's own trim is honoured exactly as `surfaceAt` honours it. The
      // inline arms state `--ignore-host-prunes`, so no row is shadowed here;
      // the check stays so a caller that mounts the pruner cannot read a row the
      // host had removed.
      if ((timeline.hostRemoved ?? new Set()).has(row.seq)) continue;
      messages.push({
        seq: row.seq, kind: "tool/result", role: "user",
        text: textOf(row), call: timeline.callNames?.get(row.seq) ?? "tool result",
        reasoning: "", step: entry,
      });
    }
  }
  return messages;
}

/** The 1-based ordinal of every tool result, in row order: the block's index. */
export function inlineResultOrdinalsOf(timeline) {
  const ordinals = new Map();
  let ordinal = 0;
  for (const unit of [...(timeline?.units ?? [])].sort((left, right) => left.seq - right.seq)) {
    ordinal += 1;
    ordinals.set(unit.seq, ordinal);
  }
  return ordinals;
}

/**
 * Append one unit's block through `appendInlineBlockOf`, tolerating either API
 * the prototype exports: the current `{message, block, eligibility}` shape and
 * the labelled `{text, block, registryEntry}` contract. The returned `text` is
 * the result's body with the block as its suffix; `block` is null for a result
 * the block function refused, and `reason` names why.
 */
export function inlineAppendOf(unit, { index, callOrdinal = 1 } = {}) {
  const message = {
    role: "user", seq: unit.seq, kind: "tool-result",
    text: unit.text, isError: unit.isError === true,
  };
  const lineCount = linesOf(unit.text).length;
  const appended = appendInlineBlockOf(message, index, {
    isError: unit.isError === true, lineCount, callOrdinal,
  });
  const block = appended?.block ?? null;
  const text = typeof appended?.text === "string" ? appended.text
    : (typeof appended?.message?.text === "string" ? appended.message.text : unit.text);
  return {
    text,
    block,
    registryEntry: appended?.registryEntry ?? null,
    reason: appended?.eligibility?.reason ?? appended?.reason ?? (block === null ? "ineligible" : null),
  };
}

/** The recorded next assistant turn after a result, or null when the replay has none. */
export function inlineHostAfter(messages, seq) {
  return (messages ?? []).find(message => message.seq > seq && message.role === "assistant")
    ?? null;
}

/**
 * The surface the model reads at `step`: every canonical row at or before the
 * step, with the `"<call>:\n"` display prefix on results, the resolved body
 * (block / answer / rebuilt shape) and the turn's reasoning. `ask` appends one
 * real ask turn (the rebuild/table pass); no other caller adds one.
 *
 * The guard is `buildPrompt`'s own: `ceil(bytes/3) >= 400_000` refuses before a
 * send. The estimate is `ceil(bytes/3.04)`, the sim's measured ruler.
 */
export function inlinePromptOf({ timeline, messages, step, resolve, ask = null,
  checkGuard = true }) {
  const rows = (messages ?? []).filter(message => message.step <= step).map(message => ({
    seq: message.seq,
    role: message.role,
    text: message.kind === "tool/result"
      ? `${message.call}:\n${resolve(message)}` : resolve(message),
    reasoning: message.reasoning,
  }));
  const list = [{ role: "system", content: timeline.system ?? "" },
    ...rows.map(row => ({ role: row.role, content: row.text,
      ...(row.reasoning ? { reasoning_content: row.reasoning } : {}) }))];
  const turnSeqs = [null, ...rows.map(row => row.seq)];
  if (ask !== null) {
    list.push({ role: "user", content: ask });
    turnSeqs.push(null);
  }
  const tools = timeline.tools ?? [];
  const toolsBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  let bytes = toolsBytes;
  let reasoningBytes = 0;
  let reasoningMessages = 0;
  const reasoningTexts = [];
  for (const message of list) {
    bytes += Buffer.byteLength(message.content, "utf8");
    if (typeof message.reasoning_content !== "string") continue;
    const raw = Buffer.byteLength(message.reasoning_content, "utf8");
    reasoningBytes += raw;
    reasoningMessages += 1;
    reasoningTexts.push(message.reasoning_content);
    bytes += raw;
  }
  const promptWireBytes = Buffer.byteLength(JSON.stringify({ messages: list, tools }), "utf8");
  const guardTokens = Math.max(guardTokensOf(bytes), guardTokensOf(promptWireBytes));
  if (checkGuard && guardTokens >= PROMPT_TOKEN_LIMIT) {
    refuse("sim-batch-inline-prompt-overflow",
      `the inline prompt at step ${String(step)} is ${String(guardTokens)} tokens by the`
      + ` guard (>= ${String(PROMPT_TOKEN_LIMIT)}); nothing is trimmed and no call is made`);
  }
  return {
    messages: list, turnSeqs, tools, toolsBytes, bytes, promptWireBytes, guardTokens,
    estimatedTokens: measuredTokensOf(bytes),
    reasoningBytes, reasoningMessages,
    reasoningWireBytes: reasoningWireBytesOf(reasoningTexts),
  };
}

/** The surface's own depth at one step: the prompt without an ask, /3.04. */
export function inlineDepthOf(options) {
  return inlinePromptOf({ ...options, ask: null, checkGuard: false }).estimatedTokens;
}

/**
 * The stub's inline verdict, deterministic by the result's index. It mirrors the
 * synthetic harness's mix so the refusal and malformed paths are exercised: an
 * answered forgetall/keeplines/keep-all, a `keepall` the no-keepall grammar
 * refuses, a malformed `forgetall`, and one reply with no JSON at all. The tag
 * and the JSON object sit on ONE line, which is the shape the block teaches.
 */
export function stubInlineAnswerOf(index, lineCount) {
  const tag = `[[inline-answer:${String(index)}]]`;
  const kind = index % 6;
  if (kind === 0) {
    return `${tag}{"${String(index)}":{"forgetall":true,"summary":"stub inline forget ${String(index)}"}}`;
  }
  if (kind === 1) {
    const end = Math.min(3, lineCount);
    return `${tag}{"${String(index)}":{"keeplines":[[2,${String(end)}]],`
      + `"summary":"stub inline keep ${String(index)}"}}`;
  }
  if (kind === 2) return `${tag}{"${String(index)}":{"keepall":true}}`;
  if (kind === 3) {
    return `${tag}{"${String(index)}":{"forgetall":"not true","summary":"stub broken ${String(index)}"}}`;
  }
  if (kind === 4) return `Continuing the task after result ${String(index)}.`;
  return `${tag}{"${String(index)}":{"keeplines":[[1,${String(lineCount)}]],`
    + `"summary":"stub inline all ${String(index)}"}}`;
}

/**
 * One inline reply: the stub's own plan (no socket) or the wrapped transport's
 * answer. The transport path passes the reasoning boundary's own readings, so a
 * live send cannot lose or re-attach the recording's reasoning.
 */
async function inlineAnswerSend({ transport, wire, prompt, index, lineCount, step, ordinal,
  deadline = Number.POSITIVE_INFINITY }) {
  if (transport.name === "stub" && transport.live !== true) {
    const content = stubInlineAnswerOf(index, lineCount);
    const completion = measuredTokensOf(Buffer.byteLength(content, "utf8"));
    return {
      ok: true, answered: true, content, latencyMs: 0,
      usage: { ruler: "synthetic", prompt_tokens: prompt.estimatedTokens,
        completion_tokens: completion,
        total_tokens: prompt.estimatedTokens + completion },
    };
  }
  return wire.ask({
    messages: prompt.messages, tools: prompt.tools, turnSeqs: prompt.turnSeqs,
    ask: ordinal, indices: [index], estimatedTokens: prompt.estimatedTokens,
    deadline, grammar: INLINE_TABLE_GRAMMAR, fireStep: step,
    reasoningMessages: prompt.reasoningMessages,
    reasoningWireBytes: prompt.reasoningWireBytes,
  });
}

/** The one table send; the ask is the final user turn and adds one turn. */
async function inlineTableSend({ transport, wire, prompt, indices, step, ordinal,
  deadline = Number.POSITIVE_INFINITY }) {
  if (transport.name === "stub" && transport.live !== true) {
    const content = await transport.ask({
      ask: ordinal, indices, estimatedTokens: prompt.estimatedTokens,
      grammar: INLINE_TABLE_GRAMMAR,
    }).then(response => response.content);
    const completion = measuredTokensOf(Buffer.byteLength(content, "utf8"));
    return {
      ok: true, answered: true, content, latencyMs: 0,
      usage: { ruler: "synthetic", prompt_tokens: prompt.estimatedTokens,
        completion_tokens: completion,
        total_tokens: prompt.estimatedTokens + completion },
    };
  }
  return wire.ask({
    messages: prompt.messages, tools: prompt.tools, turnSeqs: prompt.turnSeqs,
    ask: ordinal, indices, estimatedTokens: prompt.estimatedTokens,
    deadline, grammar: INLINE_TABLE_GRAMMAR, fireStep: step,
    reasoningMessages: prompt.reasoningMessages,
    reasoningWireBytes: prompt.reasoningWireBytes,
  });
}

/** One call record: the answer text, its hash, the accounting and the label. */
function inlineCallRecordOf({ kind, ordinal, provider, billable, prompt, response,
  unit = null, hostSeq = null, indices = null, parse = null, note = null }) {
  const usage = response?.usage ?? {};
  return Object.freeze({
    kind,
    source: kind,
    callOrdinal: ordinal,
    unitSeq: unit?.seq ?? null,
    unitIndex: unit === null ? null : (Number.isSafeInteger(unit.index) ? unit.index : null),
    unitStep: unit?.step ?? null,
    indices,
    hostSeq,
    provider,
    billable,
    ruler: usage.ruler === "synthetic" ? "synthetic" : "provider",
    promptBytes: prompt.promptWireBytes,
    promptContentBytes: prompt.bytes,
    promptEstimatedTokens: prompt.estimatedTokens,
    promptTokens: Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : null,
    latencyMs: Number.isSafeInteger(response?.latencyMs) ? response.latencyMs : 0,
    ok: response?.ok === true,
    answered: response?.answered !== false,
    failure: response?.failure ?? null,
    ...contentFieldsOf(response?.content ?? ""),
    parse,
    note,
  });
}

/** A plan's applied entries with their receipts and recall ids, JSON-safe. */
export function inlinePlanSummaryOf(plan) {
  const entry = applied => ({
    index: applied.index, seq: applied.seq, status: applied.status,
    action: applied.action, summary: applied.summary ?? null,
    bytesRemoved: applied.bytesRemoved,
    removedByteSpans: applied.removedByteSpans ?? null,
    removedLineSpans: applied.removedLineSpans ?? null,
    keptLines: applied.keptLines ?? null,
    keptBytes: applied.keptBytes ?? null,
    recallId: applied.recallId ?? null,
    receipt: applied.receipt ?? null,
    originalSha256: applied.originalSha256 ?? null,
    shapedSha256: applied.shapedSha256 ?? null,
  });
  return {
    forgets: (plan?.forgets ?? []).map(entry),
    keeplines: (plan?.keeplines ?? []).map(entry),
    keeps: (plan?.keeps ?? []).map(kept => ({
      index: kept.index, seq: kept.seq, status: kept.status, action: kept.action,
      bytesRemoved: kept.bytesRemoved, reason: kept.reason,
    })),
    refusals: (plan?.refusals ?? []).map(refusal => ({
      index: refusal.index, seq: refusal.seq, status: refusal.status,
      code: refusal.code, message: refusal.message, carried: refusal.carried === true,
    })),
    recall: (plan?.recall ?? []).map(item => ({
      recallId: item.recallId, index: item.index, seq: item.seq,
      bytes: item.bytes, sha256: item.sha256,
    })),
  };
}

/** The statistics a plan summary reports, without the raw byte arrays. */
function inlineStatsOf(rebuild) {
  return {
    blocksRemoved: rebuild?.stats?.blocksRemoved ?? 0,
    blocksRemaining: rebuild?.stats?.blocksRemaining ?? 0,
    blockBytesRemoved: rebuild?.stats?.blockBytesRemoved ?? 0,
    answersRemoved: rebuild?.stats?.answersRemoved ?? 0,
    answersRemaining: rebuild?.stats?.answersRemaining ?? 0,
    answerBytesRemoved: rebuild?.stats?.answerBytesRemoved ?? 0,
    answerSpansSkipped: rebuild?.answerSpansSkipped ?? 0,
    resultBytesRemoved: rebuild?.stats?.resultBytesRemoved ?? 0,
    bytesRemoved: rebuild?.stats?.bytesRemoved ?? 0,
    bytesAddedByBlocks: rebuild?.bytesAddedByBlocks
      ?? rebuild?.stats?.bytesAddedByBlocks ?? 0,
    netBytesRemoved: rebuild?.stats?.netBytesRemoved ?? 0,
    messages: rebuild?.stats?.messages ?? 0,
  };
}

/**
 * The answer mix one call path produced: how many rows answered, how many were
 * refused, and the refusal codes. `answered` rows carry no code; a refusal with
 * no code is counted under `answer-unreadable`, the reader's own fallback.
 */
export function inlineAnswerMixOf(decisions = []) {
  const byCode = {};
  let answered = 0;
  let refused = 0;
  for (const decision of decisions ?? []) {
    if (decision?.status === "answered") {
      answered += 1;
      continue;
    }
    refused += 1;
    const code = typeof decision?.code === "string" ? decision.code : "answer-unreadable";
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return Object.freeze({ answered, refused, byCode: Object.freeze(byCode) });
}

/** The mixes of an arm's call paths joined into the arm's one answer mix. */
export function inlineAnswerMixMergeOf(...mixes) {
  const byCode = {};
  let answered = 0;
  let refused = 0;
  for (const mix of mixes) {
    answered += Number.isSafeInteger(mix?.answered) ? mix.answered : 0;
    refused += Number.isSafeInteger(mix?.refused) ? mix.refused : 0;
    for (const [code, count] of Object.entries(mix?.byCode ?? {})) {
      byCode[code] = (byCode[code] ?? 0) + (Number.isSafeInteger(count) ? count : 0);
    }
  }
  return Object.freeze({ answered, refused, byCode: Object.freeze(byCode) });
}

/**
 * The bytes a shaped replacement ADDS back to the surface: the shaped turn's
 * bytes minus the original bytes it kept. `bytesRemoved` counts only the dropped
 * bytes, so a net figure that ignores this overhead overstates the removal.
 */
export function inlineShapedTurnDeltaOf(...plans) {
  let shapedTurnBytes = 0;
  let shapedTurnKeptBytes = 0;
  for (const plan of plans) {
    for (const entry of [...(plan?.forgets ?? []), ...(plan?.keeplines ?? [])]) {
      if (typeof entry?.shapedText !== "string") continue;
      shapedTurnBytes += Buffer.byteLength(entry.shapedText, "utf8");
      shapedTurnKeptBytes += Number.isSafeInteger(entry.keptBytes) ? entry.keptBytes : 0;
    }
  }
  return Object.freeze({
    shapedTurnBytes, shapedTurnKeptBytes,
    shapedTurnDelta: shapedTurnBytes - shapedTurnKeptBytes,
  });
}

/**
 * The final-surface ledger. `blocksRemaining` is what the surface STILL HOLDS at
 * the end: every appended block the rebuild did not strip (the rebuild strips
 * the ones on its surface; blocks appended after it stay). `answersRemaining`
 * is the same reading for answer artifacts: leftovers the rebuild counted plus
 * every artifact spliced after it. The rebuild-time readings are kept under
 * their own names. A structural count that disagrees with the arm's own
 * `afterRebuild` counter is a named `ledger-mismatch`, never a silent zero.
 */
export function inlineLedgerOf({ blocks = [], decisions = [], stats = {},
  afterRebuild = {} } = {}) {
  const blocksRemoved = Number.isSafeInteger(stats.blocksRemoved) ? stats.blocksRemoved : 0;
  const blocksRemainingAtRebuild = Number.isSafeInteger(stats.blocksRemaining)
    ? stats.blocksRemaining : 0;
  const answersRemainingAtRebuild = Number.isSafeInteger(stats.answersRemaining)
    ? stats.answersRemaining : 0;
  const blocksAfterRebuild = Number.isSafeInteger(afterRebuild.blocks)
    ? afterRebuild.blocks : 0;
  const answersAfterRebuild = Number.isSafeInteger(afterRebuild.answers)
    ? afterRebuild.answers : 0;
  // Structural: appended minus stripped. Independent of the arms' own counters.
  const blocksRemaining = blocks.length - blocksRemoved;
  const answersRemaining = answersRemainingAtRebuild + (decisions ?? [])
    .filter(decision => decision?.answer !== null && decision?.answer !== undefined
      && decision.appliedByRebuild === false)
    .reduce((sum, decision) => sum + Math.max(1, decision.answer.spans?.length ?? 1), 0);
  const expectedBlocks = blocksRemainingAtRebuild + blocksAfterRebuild;
  const expectedAnswers = answersRemainingAtRebuild + answersAfterRebuild;
  const problems = [];
  if (blocksRemaining !== expectedBlocks) {
    problems.push(`surface holds ${String(blocksRemaining)} block(s), the counters say`
      + ` ${String(expectedBlocks)} (${String(blocksRemainingAtRebuild)} at rebuild +`
      + ` ${String(blocksAfterRebuild)} after)`);
  }
  if (answersRemaining !== expectedAnswers) {
    problems.push(`surface holds ${String(answersRemaining)} answer artifact(s), the counters`
      + ` say ${String(expectedAnswers)} (${String(answersRemainingAtRebuild)} at rebuild +`
      + ` ${String(answersAfterRebuild)} after)`);
  }
  const mismatch = problems.length === 0 ? null : Object.freeze({
    code: "ledger-mismatch", message: problems.join("; "),
  });
  return Object.freeze({
    ok: blocksRemaining === 0 && answersRemaining === 0 && mismatch === null,
    blocksRemaining,
    answersRemaining,
    blocksRemainingAtRebuild,
    answersRemainingAtRebuild,
    blocksAfterRebuild,
    answersAfterRebuild,
    mismatch,
  });
}

/** The sorted union of spans: adjacent or overlapping spans become one. */
function mergedSpanBytesOf(text, spans) {
  const sorted = [...(spans ?? [])].sort((left, right) =>
    left.start - right.start || left.end - right.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged.reduce((sum, span) =>
    sum + Buffer.byteLength(text.slice(span.start, span.end), "utf8"), 0);
}

/**
 * Run the inline arm on a timeline. Every eligible result gets its block at
 * landing; every block gets one labelled `replay-extra-call` whose reply is
 * spliced into the recording's next assistant turn; one rebuild runs when the
 * surface reaches `rebuildTokens`, applies the recorded choices and runs the
 * 40 percent table pass for the units with no inline decision. The token budget
 * `tokenGrant` is the only cap; it is enforced BETWEEN calls (read at step
 * boundaries), so the last call runs whole and `spentTokens` may exceed the
 * grant. The record says so: `budgetEnforced: "between-calls"`,
 * `budgetExceeded`, `budgetOvershootTokens`, and `endedBy` is
 * `token-budget-after-call` when the stop came after an overshoot.
 */
export async function runInlineAskArm({ timeline, transport, floor = INLINE_FLOOR_BYTES,
  tokenGrant, rebuildTokens = INLINE_REBUILD_TOKENS, maxSteps = null,
  sessionId = "racoons-inline-ask-sim", log = () => {}, onRecord = () => {} }) {
  if (!Number.isSafeInteger(tokenGrant) || tokenGrant < 1) {
    refuse("sim-batch-inline-token-grant", `the token grant is a positive integer, got ${String(tokenGrant)}`);
  }
  if (!Number.isSafeInteger(rebuildTokens) || rebuildTokens < 1) {
    refuse("sim-batch-inline-rebuild-tokens",
      `the rebuild depth is a positive integer, got ${String(rebuildTokens)}`);
  }
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-inline-floor", `the floor is a non-negative integer, got ${String(floor)}`);
  }
  if (maxSteps !== null && (!Number.isSafeInteger(maxSteps) || maxSteps < 0)) {
    refuse("sim-batch-inline-max-steps",
      `the step cap is a non-negative integer, got ${String(maxSteps)}`);
  }
  if (timeline?.ignoreHostPrunes !== true) {
    refuse("sim-batch-inline-host-pruner",
      "the inline lane reads the reconstructed surface and needs a pruner-off timeline"
      + " (readTimeline with { ignoreHostPrunes: true })");
  }
  const canonical = inlineCanonicalMessages({ timeline });
  const bySeq = new Map(canonical.map(message => [message.seq, message]));
  const ordinals = inlineResultOrdinalsOf(timeline);
  const units = eligibleOf(timeline, floor)
    .slice().sort((left, right) => (left.step - right.step) || (left.seq - right.seq));
  const wire = withReasoningBoundary(transport, timeline);
  const bodyBySeq = new Map();
  const answerBySeq = new Map();
  const rebuiltBySeq = new Map();
  const blocks = [];
  const decisions = [];
  const records = [];
  let answersOnRebuild = 0;
  let blocksOnRebuild = 0;
  const ineligible = [];
  let rebuild = null;
  let tablePass = null;
  let rebuildStep = null;
  let depthBefore = null;
  let depthAfter = null;
  let lastStep = 0;
  let unitsSeen = 0;
  let cappedAtMaxSteps = false;
  let spentTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let stoppedAtBudget = false;
  let endedBy = "input-end";
  let failedSend = null;
  const afterRebuild = { units: 0, blocks: 0, calls: 0, answered: 0, refused: 0,
    answers: 0, bytesAdded: 0, applied: false };

  const resolve = message => {
    if (rebuiltBySeq.has(message.seq)) return rebuiltBySeq.get(message.seq);
    if (message.kind === "tool/result" && bodyBySeq.has(message.seq)) {
      return bodyBySeq.get(message.seq);
    }
    const answered = answerBySeq.get(message.seq);
    return answered === undefined ? message.text : answered.text;
  };
  const depthAt = step => inlineDepthOf({ timeline, messages: canonical, step, resolve });
  const noteUsage = response => {
    const usage = response?.usage ?? {};
    const prompt = Number.isSafeInteger(usage.prompt_tokens)
      ? usage.prompt_tokens : 0;
    const completion = Number.isSafeInteger(usage.completion_tokens)
      ? usage.completion_tokens : 0;
    promptTokens += prompt;
    completionTokens += completion;
    spentTokens = promptTokens + completionTokens;
  };
  const emit = record => {
    records.push(record);
    onRecord(record);
  };
  /**
   * Every answer artifact on a host text occupies a span the rebuild cuts; a
   * prepend shifts all of them, so the spans are re-read after each splice. The
   * merged byte length is what the rebuild removes (adjacent spans share one
   * separator newline, and it is counted once).
   */
  const mergedAnswerBytesOf = list => {
    const groups = new Map();
    for (const decision of list) {
      if (decision?.answer === null || decision?.answer === undefined) continue;
      const seq = decision.answer.seq;
      const group = groups.get(seq) ?? [];
      group.push(...decision.answer.spans);
      groups.set(seq, group);
    }
    let total = 0;
    for (const [seq, spans] of groups) {
      total += mergedSpanBytesOf(answerBySeq.get(seq)?.text ?? "", spans);
    }
    return total;
  };
  const refreshHostSpans = (hostSeq, postOnly = false) => {
    const hostText = answerBySeq.get(hostSeq)?.text;
    if (typeof hostText !== "string") return;
    for (const decision of decisions) {
      if (decision.hostSeq !== hostSeq || decision.answer === null) continue;
      if (postOnly && decision.appliedByRebuild !== false) continue;
      const reading = parseInlineAnswer(hostText, {
        index: decision.index, lineCount: decision.lineCount,
      });
      const spans = (reading.spans ?? []).map(([from, to]) => ({ start: from, end: to }));
      decision.answer = { ...decision.answer, spans,
        start: spans[0]?.start ?? null, end: spans[0]?.end ?? null,
        text: reading.text ?? decision.answer.text };
    }
  };

  /**
   * The one rebuild. It reads the surface as it stands (blocks and answers in
   * place), strips every artifact through `rebuildSurface` (which proves the
   * original bytes are restored), applies the recorded choices, then runs the
   * table pass for units with no answered inline decision and applies those
   * through the same shape path. Returns the merged surface and its plans.
   */
  const rebuildNow = async step => {
    const rebuildMessages = canonical.filter(message => message.step <= step)
      .map(message => ({ role: message.role, seq: message.seq, text: resolve(message) }));
    const decisionsNow = decisions.map(decision => ({ ...decision }));
    const result = rebuildSurface(rebuildMessages, decisionsNow,
      { blocks: blocks.slice(), sessionId });
    const restored = new Map(result.restoredMessages.map(message => [message.seq, message.text]));
    for (const message of rebuildMessages) {
      const original = bySeq.get(message.seq)?.text;
      if (restored.get(message.seq) !== original) {
        refuse("sim-batch-inline-restore-mismatch",
          `seq ${String(message.seq)} (${String(message.role)}) restored to`
          + ` ${JSON.stringify(restored.get(message.seq))} (${String(restored.get(message.seq)?.length)}`
          + ` characters), not the recording's ${JSON.stringify(original)}`
          + ` (${String(original?.length)}); the rebuild is not byte-exact`);
      }
    }
    // An answer whose host turn has NOT landed by the bar is not on the rebuilt
    // surface, but its result IS shaped now. The artifact must not appear on a
    // later prompt either: the recording's next turn is restored to its own
    // text, exactly as if the block had never been asked.
    let answersSuppressed = 0;
    for (const decision of decisions) {
      if (decision.answer === null || !Number.isSafeInteger(decision.hostStep)) continue;
      if (decision.hostStep <= step) continue;
      if (answerBySeq.has(decision.answer.seq)) {
        answerBySeq.delete(decision.answer.seq);
        decision.suppressedAtRebuild = true;
        answersSuppressed += 1;
      }
    }
    const decided = new Set(decisions
      .filter(decision => decision.status === "answered").map(decision => decision.seq));
    const tableUnits = units.filter(unit => unit.step <= step && !decided.has(unit.seq));
    const afterInline = new Map(result.messages.map(message => [message.seq, message.text]));
    const surfaceText = message => (afterInline.has(message.seq)
      ? afterInline.get(message.seq) : resolve(message));
    const tableUnitsNow = tableUnits.map(unit => ({
      ...unit, text: afterInline.get(unit.seq) ?? unit.text,
    }));
    const rows = askRowsOf(tableUnitsNow, timeline.callNames);
    const lineCounts = new Map(rows.map(row => [row.index, row.lineCount]));
    let tableResult = null;
    let tablePromptText = null;
    let tableCall = null;
    let parsedRows = [];
    if (rows.length > 0) {
      tablePromptText = askMessageForRows(rows, INLINE_TABLE_GRAMMAR, DEFAULT_ASK_ORDER, false);
      if (!tablePromptText.includes(INLINE_FORTY_PERCENT_LINE)
        || tablePromptText.includes(INLINE_SEVENTY_PERCENT_LINE)) {
        refuse("sim-batch-inline-table-prompt",
          "the table pass must carry the 40 percent line and never the 70 percent one");
      }
      const prompt = inlinePromptOf({ timeline, messages: canonical, step,
        resolve: surfaceText, ask: tablePromptText });
      const ordinal = records.length + 1;
      const response = await inlineTableSend({ transport, wire, prompt,
        indices: rows.map(row => row.index), step, ordinal });
      noteUsage(response);
      tableCall = inlineCallRecordOf({
        kind: "table-pass", ordinal, provider: transport.name,
        billable: transport.live === true, prompt: {
          ...prompt, bytes: prompt.bytes - Buffer.byteLength(tablePromptText, "utf8"),
        }, response, indices: rows.map(row => row.index),
        note: "the 40 percent table pass at the rebuild bar; one turn",
      });
      emit(tableCall);
      if (response.ok !== true || response.answered === false) {
        failedSend = response.error ?? response.failure ?? "unanswered";
        endedBy = "send-failed";
      } else {
        parsedRows = answerRowsOf(response.content ?? "", rows.map(row => row.index),
          INLINE_TABLE_GRAMMAR, { lineCounts });
        const tableDecisions = [];
        for (const [at, row] of parsedRows.entries()) {
          if (row.status !== "answered") continue;
          tableDecisions.push({
            index: row.index, seq: tableUnitsNow[at].seq, status: "answered",
            action: row.answer.action, summary: row.answer.summary ?? null,
            ranges: row.answer.ranges ?? null,
            keepAll: row.answer.action === "keeplines"
              && keepsWholeOf(row.answer, rows[at].lineCount),
          });
        }
        if (tableDecisions.length > 0) {
          tableResult = rebuildSurface(result.restoredMessages, tableDecisions,
            { blocks: [], sessionId });
        }
      }
    }
    const tableBySeq = new Map();
    for (const entry of [...(tableResult?.plan.forgets ?? []),
      ...(tableResult?.plan.keeplines ?? [])]) {
      tableBySeq.set(entry.seq, tableResult.messages.find(message => message.seq === entry.seq)?.text
        ?? entry.shapedText);
    }
    const merged = result.messages.map(message => (tableBySeq.has(message.seq)
      ? { ...message, text: tableBySeq.get(message.seq) } : { ...message }));
    for (const message of merged) rebuiltBySeq.set(message.seq, message.text);
    const tableStats = inlineStatsOf(tableResult);
    const tableAnswered = parsedRows.filter(row => row.status === "answered").length;
    const tableRefused = parsedRows.length - tableAnswered;
    tablePass = {
      units: rows.length,
      turns: rows.length === 0 ? 0 : 1,
      variant: "later",
      grammar: INLINE_TABLE_GRAMMAR,
      fortyPercent: tablePromptText === null ? null
        : tablePromptText.includes(INLINE_FORTY_PERCENT_LINE),
      seventyPercent: tablePromptText === null ? null
        : tablePromptText.includes(INLINE_SEVENTY_PERCENT_LINE),
      answered: tableAnswered,
      refused: tableRefused,
      mix: inlineAnswerMixOf(parsedRows),
      forgetall: parsedRows.filter(row => row.status === "answered"
        && row.answer.action === "forgetall").length,
      keeplines: parsedRows.filter(row => row.status === "answered"
        && row.answer.action === "keeplines").length,
      applied: (tableResult?.plan.forgets.length ?? 0)
        + (tableResult?.plan.keeplines.length ?? 0),
      keeps: tableResult?.plan.keeps.length ?? 0,
      plan: tableResult === null ? null : inlinePlanSummaryOf(tableResult.plan),
      stats: tableStats,
      call: tableCall,
    };
    return {
      messages: merged,
      restoredExact: true,
      answersSuppressed,
      inline: result,
      table: tableResult,
      tablePass,
      stats: inlineStatsOf(result),
    };
  };

  for (const unit of units) {
    const step = Number.isSafeInteger(unit.step) ? unit.step : 0;
    if (maxSteps !== null && step > maxSteps) {
      cappedAtMaxSteps = true;
      break;
    }
    // The budget is read at STEP boundaries, BETWEEN calls. A step's units are
    // one prefix, so the stop is a whole step the table-only arm can reproduce
    // exactly; the alternative (stopping mid-step) would leave one arm with
    // more units. The call that crossed the grant has already returned, so the
    // stop can only be reported after it: `endedBy` names that case below.
    if (step > lastStep && spentTokens >= tokenGrant) {
      stoppedAtBudget = true;
      break;
    }
    unitsSeen += 1;
    lastStep = Math.max(lastStep, step);
    const index = ordinals.get(unit.seq) ?? 0;
    const appended = inlineAppendOf(unit, { index, callOrdinal: index });
    if (appended.block === null) {
      ineligible.push({ seq: unit.seq, index, step, reason: appended.reason });
      continue;
    }
    if (appended.block.includes(INLINE_SEVENTY_PERCENT_LINE)) {
      refuse("sim-batch-inline-table-prompt",
        "the inline block carries the 70 percent line; this lane uses the 40 percent one only");
    }
    bodyBySeq.set(unit.seq, appended.text);
    blocks.push({
      seq: unit.seq, index, step, text: appended.block, block: appended.block,
      callOrdinal: index, bytes: Buffer.byteLength(appended.block, "utf8"),
    });
    if (rebuild === null) {
      const depthNow = depthAt(step);
      if (depthNow >= rebuildTokens) {
        blocksOnRebuild = blocks.reduce((sum, block) => sum + block.bytes, 0);
        answersOnRebuild = mergedAnswerBytesOf(decisions.filter(decision =>
          decision.answer !== null && Number.isSafeInteger(decision.hostStep)
          && decision.hostStep <= step));
        depthBefore = depthNow;
        rebuildStep = step;
        rebuild = await rebuildNow(step);
        depthAfter = inlineDepthOf({
          timeline, messages: canonical, step,
          resolve: message => (rebuiltBySeq.has(message.seq)
            ? rebuiltBySeq.get(message.seq) : message.text),
        });
        if (endedBy === "send-failed") break;
        continue;
      }
    }
    const host = inlineHostAfter(canonical, unit.seq);
    const prompt = inlinePromptOf({ timeline, messages: canonical, step, resolve });
    const lineCount = linesOf(unit.text).length;
    const ordinal = records.length + 1;
    const response = await inlineAnswerSend({
      transport, wire, prompt, index, lineCount, step, ordinal,
    });
    noteUsage(response);
    const reply = response.content ?? "";
    const first = parseInlineAnswer(reply, { index, lineCount });
    let parsed = first;
    let answer = null;
    let hostStep = null;
    if (host !== null && first.spans.length > 0) {
      // The answer is the tagged artifact itself, pasted onto the recording's
      // next assistant turn. The artifact block sits at the HEAD of the turn,
      // followed by a blank line and the turn's own text: the rebuild's spans
      // then start at the turn's first byte and consume the trailing separator,
      // so cutting them leaves the recording's text byte for byte.
      const artifacts = first.spans
        .map(([from, to]) => reply.slice(from, to).replace(/^\n+/u, "").replace(/\n+$/u, ""))
        .filter(text => text.length > 0);
      const hostText = `${artifacts.join("\n")}\n\n${resolve(host)}`;
      answerBySeq.set(host.seq, { text: hostText });
      // A prepend shifts every earlier artifact on this host: refresh the spans
      // of the decisions still on this surface before recording the new one.
      refreshHostSpans(host.seq, rebuild !== null);
      const reread = parseInlineAnswer(hostText, { index, lineCount });
      const spans = (reread.spans ?? []).map(([from, to]) => ({ start: from, end: to }));
      const primary = spans[0] ?? null;
      answer = {
        seq: host.seq, spans,
        start: primary?.start ?? null, end: primary?.end ?? null,
        text: reread.text ?? artifacts.join("\n"),
      };
      hostStep = bySeq.get(host.seq)?.step ?? step;
      parsed = reread;
    }
    const callRecord = inlineCallRecordOf({
      kind: "replay-extra-call", ordinal, provider: transport.name,
      billable: transport.live === true, prompt, response, unit,
      hostSeq: host?.seq ?? null,
      parse: { status: parsed.status, action: parsed.action ?? null,
        code: parsed.code ?? null },
      note: host === null
        ? "the replay has no next assistant turn; the verdict is recorded, its text is not on the surface"
        : "the reply is spliced into the recording's next assistant turn; it adds no turn",
    });
    emit(callRecord);
    if (response.ok !== true || response.answered === false) {
      failedSend = response.error ?? response.failure ?? "unanswered";
      endedBy = "send-failed";
      break;
    }
    const decision = {
      index, seq: unit.seq, step, status: parsed.status,
      action: parsed.action ?? null, summary: parsed.summary ?? null,
      ranges: parsed.ranges ?? null, keepAll: parsed.keepAll === true,
      code: parsed.code ?? null, message: parsed.message ?? null,
      lineCount, answer, source: "replay-extra-call", callOrdinal: ordinal,
      hostSeq: host?.seq ?? null, hostStep,
      appliedByRebuild: rebuild === null,
    };
    decisions.push(decision);
    if (rebuild !== null) {
      afterRebuild.units += 1;
      afterRebuild.blocks += 1;
      afterRebuild.calls += 1;
      if (answer !== null) afterRebuild.answers += Math.max(1, answer.spans?.length ?? 1);
      afterRebuild.bytesAdded += Buffer.byteLength(appended.block, "utf8")
        + (answer === null ? 0 : Buffer.byteLength(answer.text ?? "", "utf8"));
      if (parsed.status === "answered") afterRebuild.answered += 1;
      else afterRebuild.refused += 1;
    }
    log(`[inline] call ${String(ordinal)} result ${String(index)} step ${String(step)}`
      + ` ${parsed.status}${parsed.action === undefined ? "" : ` ${String(parsed.action)}`}`
      + ` prompt=${String(prompt.estimatedTokens)} tok`);
  }
  if (stoppedAtBudget) {
    // The stop is real either way; the name states whether the last call had
    // already carried the spend past the grant when the check ran.
    endedBy = spentTokens > tokenGrant ? "token-budget-after-call" : "token-budget";
  }
  if (cappedAtMaxSteps && !stoppedAtBudget) endedBy = "max-steps";

  const inlineStats = rebuild?.stats ?? inlineStatsOf(null);
  const tableStats = tablePass?.stats ?? inlineStatsOf(null);
  // The answer bytes are measured the way the rebuild measures them: the
  // host-relative artifact spans, merged per host, sliced from the host's own
  // text. The pre-rebuild figure is captured AT the rebuild (before any later
  // prepend shifts a span); the post-rebuild one is re-read after each splice.
  const answersOnSurface = rebuild === null
    ? mergedAnswerBytesOf(decisions.filter(decision => decision.answer !== null))
    : answersOnRebuild;
  const answersAfterRebuild = rebuild === null ? 0
    : mergedAnswerBytesOf(decisions.filter(decision =>
      decision.answer !== null && decision.appliedByRebuild === false));
  const answersAdded = answersOnSurface + answersAfterRebuild;
  const resultsRemoved = [...(rebuild?.inline.plan.forgets ?? []),
    ...(rebuild?.inline.plan.keeplines ?? []),
    ...(rebuild?.table?.plan.forgets ?? []),
    ...(rebuild?.table?.plan.keeplines ?? [])]
    .reduce((sum, applied) => sum + applied.bytesRemoved, 0);
  const totalRemoved = inlineStats.bytesRemoved + tableStats.bytesRemoved;
  const appliedEntries = [...(rebuild?.inline.plan.forgets ?? []),
    ...(rebuild?.inline.plan.keeplines ?? []),
    ...(rebuild?.table?.plan.forgets ?? []),
    ...(rebuild?.table?.plan.keeplines ?? [])];
  // Net is removal minus every byte the mechanism put BACK: appended blocks,
  // spliced answer artifacts, and the shaped form's overhead over the kept
  // original bytes. `stats.netBytesRemoved` subtracts only blocks, so it is
  // reported beside this figure, never as the headline.
  const addedByBlocks = blocks.reduce((sum, block) => sum + block.bytes, 0);
  const shaped = inlineShapedTurnDeltaOf(rebuild?.inline.plan, rebuild?.table?.plan);
  const netRemoved = totalRemoved - addedByBlocks - answersAdded - shaped.shapedTurnDelta;
  const problems = [];
  if (rebuild !== null && blocksOnRebuild !== inlineStats.bytesAddedByBlocks) {
    problems.push(`blocks added ${String(blocksOnRebuild)} B vs the rebuild's`
      + ` ${String(inlineStats.bytesAddedByBlocks)} B`);
  }
  if (rebuild !== null && blocksOnRebuild !== inlineStats.blockBytesRemoved) {
    problems.push(`blocks ${String(blocksOnRebuild)} B vs removed`
      + ` ${String(inlineStats.blockBytesRemoved)} B`);
  }
  if (rebuild !== null && inlineStats.blocksRemaining !== 0) {
    problems.push(`${String(inlineStats.blocksRemaining)} block(s) remained on the rebuilt surface`);
  }
  if (rebuild !== null && answersOnRebuild !== inlineStats.answerBytesRemoved) {
    problems.push(`answers ${String(answersOnRebuild)} B vs removed`
      + ` ${String(inlineStats.answerBytesRemoved)} B`);
  }
  if (rebuild !== null && inlineStats.answersRemaining !== 0) {
    problems.push(`${String(inlineStats.answersRemaining)} answer artifact(s) remained`);
  }
  if (rebuild !== null && inlineStats.answerSpansSkipped !== 0) {
    problems.push(`${String(inlineStats.answerSpansSkipped)} recorded answer span(s) did not`
      + " name an artifact on the surface");
  }
  if (rebuild !== null && resultsRemoved !== inlineStats.resultBytesRemoved
    + tableStats.resultBytesRemoved) {
    problems.push(`results ${String(resultsRemoved)} B vs removed`
      + ` ${String(inlineStats.resultBytesRemoved + tableStats.resultBytesRemoved)} B`);
  }
  if (appliedEntries.some(applied => typeof applied.recallId !== "string"
    || typeof applied.receipt !== "string")) {
    problems.push("an applied removal lacks a receipt or a recall id");
  }
  if (problems.length > 0) {
    refuse("sim-batch-inline-reconcile", problems.join("; "));
  }
  const finalResolve = message => (rebuiltBySeq.has(message.seq)
    ? rebuiltBySeq.get(message.seq) : resolve(message));
  const finalStep = rebuildStep === null ? lastStep : Math.max(lastStep, rebuildStep);
  const finalDepth = inlineDepthOf({ timeline, messages: canonical, step: finalStep,
    resolve: finalResolve });
  const baselineMessages = canonical.filter(message => message.step <= finalStep).length;
  const rebuildTurns = rebuild === null ? 0 : 1;
  const extraCalls = records.filter(record => record.kind === "replay-extra-call").length;
  const turns = {
    baseline: { total: baselineMessages },
    inline: { total: baselineMessages + rebuildTurns },
    extraTurns: rebuildTurns,
    rebuildTurns,
  };
  const report = inlineAskReport({
    blocks, decisions: decisions.map(decision => ({ ...decision,
      answer: decision.answer === null ? null : {
        seq: decision.answer.seq, start: decision.answer.start,
        end: decision.answer.end, text: decision.answer.text,
      } })),
    rebuild: rebuild === null ? null : {
      stats: inlineStats,
      plan: { refusals: (rebuild.inline.plan.refusals ?? []).map(refusal => ({
        code: refusal.code, carried: refusal.carried === true,
      })) },
    },
    depthBefore, depthAfter,
    tokenBudget: tokenGrant, turns, bigTable: tablePass,
  });
  // The final-surface ledger reads what is STILL on the surface at the arm's
  // end; the rebuild-time figures stay under their own names.
  const ledger = inlineLedgerOf({ blocks, decisions, stats: inlineStats, afterRebuild });
  const inlineMix = inlineAnswerMixOf(decisions);
  const tableMix = tablePass?.mix ?? inlineAnswerMixOf([]);
  const answerMix = Object.freeze({
    ...inlineAnswerMixMergeOf(inlineMix, tableMix),
    inline: inlineMix,
    table: tableMix,
  });
  return Object.freeze({
    schema: INLINE_ARM_SCHEMA,
    arm: "inline",
    provider: transport.name,
    billable: transport.live === true,
    tokensBillable: transport.live === true,
    floor,
    tokenGrant,
    rebuildTokens,
    maxSteps,
    tableGrammar: INLINE_TABLE_GRAMMAR,
    caps: { timerMs: 0, askCeiling: 0, onlyCap: "token budget" },
    units: units.length,
    unitsSeen,
    commonStop: null,
    eligibility: eligibilityOf(timeline, floor),
    blocks: Object.freeze(blocks),
    ineligible: Object.freeze(ineligible),
    decisions: Object.freeze(decisions),
    records: Object.freeze(records),
    calls: Object.freeze(records.filter(record => record.kind !== "table-pass")),
    tablePass,
    rebuild: rebuild === null ? null : {
      step: rebuildStep,
      depthBefore, depthAfter,
      plan: inlinePlanSummaryOf(rebuild.inline.plan),
      tablePlan: rebuild.table === null ? null : inlinePlanSummaryOf(rebuild.table.plan),
      stats: inlineStats,
      tableStats,
      restoredExact: true,
      answersSuppressed: rebuild.answersSuppressed,
    },
    // Every depth reading carries the step it was measured at: `before` and
    // `after` are the rebuild step's pair, `final` and `depthAtCommonStop` are
    // the common stop's one reading.
    depth: {
      before: depthBefore, after: depthAfter, final: finalDepth,
      beforeStep: rebuildStep, afterStep: rebuildStep, finalStep,
    },
    depthAtCommonStop: Object.freeze({ step: finalStep, tokens: finalDepth }),
    turns,
    replayCalls: extraCalls,
    replayCallsPerResult: blocks.length === 0 ? null : extraCalls / blocks.length,
    callsPerResult: blocks.length === 0 ? null : (extraCalls + (tablePass?.turns ?? 0))
      / blocks.length,
    answeredInline: decisions.filter(decision => decision.status === "answered"
      && decision.appliedByRebuild !== false).length,
    refusedInline: decisions.filter(decision => decision.status !== "answered"
      && decision.appliedByRebuild !== false).length,
    afterRebuild: Object.freeze(afterRebuild),
    answerMix,
    spentTokens, promptTokens, completionTokens,
    budgetEnforced: "between-calls",
    budgetReached: spentTokens >= tokenGrant,
    budgetExceeded: spentTokens > tokenGrant,
    budgetOvershootTokens: Math.max(0, spentTokens - tokenGrant),
    endedBy,
    endedAtStep: lastStep,
    eligibilityBytes: units.reduce((sum, unit) => sum + unit.bytes, 0),
    bytes: {
      addedByBlocks,
      addedByAnswers: answersAdded,
      addedAtRebuildByBlocks: inlineStats.bytesAddedByBlocks,
      removedBlocks: inlineStats.blockBytesRemoved,
      removedAnswers: inlineStats.answerBytesRemoved,
      removedResults: inlineStats.resultBytesRemoved + tableStats.resultBytesRemoved,
      removedByTable: tableStats.bytesRemoved,
      shapedTurnDelta: shaped.shapedTurnDelta,
      shapedTurnBytes: shaped.shapedTurnBytes,
      shapedTurnKeptBytes: shaped.shapedTurnKeptBytes,
      totalRemoved,
      netRemoved,
      net: netRemoved,
      // The identity the headline obeys:
      // net = totalRemoved - addedByBlocks - addedByAnswers - shapedTurnDelta.
      statsNetRemoved: inlineStats.netBytesRemoved + tableStats.netBytesRemoved,
    },
    reconciliation: {
      ...ledger,
      restoredExact: true,
      blocksBeforeRebuild: blocksOnRebuild,
      answersBeforeRebuild: answersOnRebuild,
      answerSpansSkipped: inlineStats.answerSpansSkipped,
      answerByteBasis: "artifact spans (tag and separator included);"
        + " report.bytesAddedByAnswers counts the JSON object text alone",
      reportAnswerBytes: report.bytesAddedByAnswers,
      appliedEntryCount: appliedEntries.length,
      receipts: appliedEntries.length,
      recallIds: new Set(appliedEntries.map(applied => applied.recallId)).size,
    },
    report,
    limitations: Object.freeze([
      "the recording's assistant turns carry no tagged answer, so every inline reply came"
      + " from a labelled replay-extra-call; the call is counted, the turn is not",
      "each replay-extra-call pays a FULL prompt; in a live run the verdict would ride a"
      + " turn the model was going to take, so the replay's token figure is a replay cost,"
      + " not the mechanism's live cost",
      "the token budget is a cap, not a target: this run spent what it spent and stopped"
      + ` at ${endedBy}; budgetReached and budgetExceeded state the spend against the grant`,
      "the budget is enforced between calls (at step boundaries): the last call's cost is"
      + " only known after it returns, so the cap cannot be enforced mid-call and the run"
      + " can end over the grant (budgetExceeded, budgetOvershootTokens)",
      "one rebuild runs at the bar; blocks and decisions recorded after it are measured"
      + " but not applied, and afterRebuild states them",
      "the lane replays a recording; it is not the live host's wire and makes no"
      + " product claim",
    ]),
  });
}

/**
 * The table-only arm: the same input with no blocks and no inline calls. When
 * the surface first reaches `rebuildTokens`, ONE table pass runs over every
 * eligible unit that has landed by that step, with the 40 percent no-keepall
 * prompt only, and its answers are applied through the shape path.
 */
export async function runTableOnlyArm({ timeline, transport, floor = INLINE_FLOOR_BYTES,
  tokenGrant, rebuildTokens = INLINE_REBUILD_TOKENS, maxSteps = null,
  sessionId = "racoons-inline-ask-sim", log = () => {}, onRecord = () => {} }) {
  if (!Number.isSafeInteger(tokenGrant) || tokenGrant < 1) {
    refuse("sim-batch-inline-token-grant", `the token grant is a positive integer, got ${String(tokenGrant)}`);
  }
  if (maxSteps !== null && (!Number.isSafeInteger(maxSteps) || maxSteps < 0)) {
    refuse("sim-batch-inline-max-steps",
      `the step cap is a non-negative integer, got ${String(maxSteps)}`);
  }
  if (timeline?.ignoreHostPrunes !== true) {
    refuse("sim-batch-inline-host-pruner",
      "the table-only arm reads the reconstructed surface and needs a pruner-off timeline"
      + " (readTimeline with { ignoreHostPrunes: true })");
  }
  const canonical = inlineCanonicalMessages({ timeline });
  const units = eligibleOf(timeline, floor)
    .slice().sort((left, right) => (left.step - right.step) || (left.seq - right.seq));
  const wire = withReasoningBoundary(transport, timeline);
  const records = [];
  let barStep = null;
  let depthBefore = null;
  let depthAfter = null;
  let lastStep = 0;
  let unitsSeen = 0;
  let cappedAtMaxSteps = false;
  for (const unit of units) {
    const step = Number.isSafeInteger(unit.step) ? unit.step : 0;
    if (maxSteps !== null && step > maxSteps) {
      cappedAtMaxSteps = true;
      break;
    }
    unitsSeen += 1;
    lastStep = Math.max(lastStep, step);
    if (barStep !== null) continue;
    const depth = inlineDepthOf({ timeline, messages: canonical, step,
      resolve: message => message.text });
    if (depth >= rebuildTokens) {
      barStep = step;
      depthBefore = depth;
    }
  }
  let tablePass = null;
  let rebuild = null;
  let spentTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let endedBy = barStep === null ? "input-end-before-bar" : "input-end";
  if (cappedAtMaxSteps) endedBy = "common-stop";
  const emit = record => { records.push(record); onRecord(record); };
  if (barStep !== null) {
    const promptUnits = units.filter(unit => unit.step <= barStep);
    const rows = askRowsOf(promptUnits, timeline.callNames);
    const lineCounts = new Map(rows.map(row => [row.index, row.lineCount]));
    const ask = askMessageForRows(rows, INLINE_TABLE_GRAMMAR, DEFAULT_ASK_ORDER, false);
    if (!ask.includes(INLINE_FORTY_PERCENT_LINE)
      || ask.includes(INLINE_SEVENTY_PERCENT_LINE)) {
      refuse("sim-batch-inline-table-prompt",
        "the table-only pass must carry the 40 percent line and never the 70 percent one");
    }
    const prompt = inlinePromptOf({ timeline, messages: canonical, step: barStep,
      resolve: message => message.text, ask });
    const response = await inlineTableSend({ transport, wire, prompt,
      indices: rows.map(row => row.index), step: barStep, ordinal: 1 });
    const usage = response?.usage ?? {};
    promptTokens = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    completionTokens = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : 0;
    spentTokens = promptTokens + completionTokens;
    emit(inlineCallRecordOf({ kind: "table-pass", ordinal: 1, provider: transport.name,
      billable: transport.live === true, prompt, response,
      indices: rows.map(row => row.index),
      note: "the one table pass at the bar; one turn" }));
    if (response.ok !== true || response.answered === false) {
      endedBy = "send-failed";
    } else {
      const parsedRows = answerRowsOf(response.content ?? "", rows.map(row => row.index),
        INLINE_TABLE_GRAMMAR, { lineCounts });
      const decisions = [];
      for (const [at, row] of parsedRows.entries()) {
        if (row.status !== "answered") continue;
        decisions.push({
          index: row.index, seq: promptUnits[at].seq, status: "answered",
          action: row.answer.action, summary: row.answer.summary ?? null,
          ranges: row.answer.ranges ?? null,
          keepAll: row.answer.action === "keeplines"
            && keepsWholeOf(row.answer, rows[at].lineCount),
        });
      }
      rebuild = decisions.length === 0 ? null : rebuildSurface(
        canonical.filter(message => message.step <= barStep)
          .map(message => ({ role: message.role, seq: message.seq, text: message.text })),
        decisions, { sessionId });
      const restored = new Map((rebuild?.restoredMessages ?? [])
        .map(message => [message.seq, message.text]));
      if (rebuild !== null) {
        for (const message of canonical.filter(row => row.step <= barStep)) {
          if (restored.get(message.seq) !== message.text) {
            refuse("sim-batch-inline-restore-mismatch",
              `the table-only arm's seq ${String(message.seq)} did not restore exactly`);
          }
        }
      }
      depthAfter = inlineDepthOf({
        timeline,
        messages: canonical.map(message => ({ ...message,
          text: rebuild === null ? message.text
            : (rebuild.messages.find(applied => applied.seq === message.seq)?.text
              ?? message.text) })),
        step: barStep, resolve: message => message.text,
      });
      const answered = parsedRows.filter(row => row.status === "answered").length;
      tablePass = {
        units: rows.length, turns: 1, variant: "later", grammar: INLINE_TABLE_GRAMMAR,
        fortyPercent: ask.includes(INLINE_FORTY_PERCENT_LINE),
        seventyPercent: ask.includes(INLINE_SEVENTY_PERCENT_LINE),
        answered, refused: parsedRows.length - answered,
        mix: inlineAnswerMixOf(parsedRows),
        forgetall: parsedRows.filter(row => row.status === "answered"
          && row.answer.action === "forgetall").length,
        keeplines: parsedRows.filter(row => row.status === "answered"
          && row.answer.action === "keeplines").length,
        applied: (rebuild?.plan.forgets.length ?? 0)
          + (rebuild?.plan.keeplines.length ?? 0),
        keeps: rebuild?.plan.keeps.length ?? 0,
        plan: rebuild === null ? null : inlinePlanSummaryOf(rebuild.plan),
        stats: inlineStatsOf(rebuild),
      };
    }
  }
  const stats = inlineStatsOf(rebuild);
  const baselineMessages = canonical.filter(message => message.step <= lastStep).length;
  // The table pass shaped only the rows that had landed at the bar. The depth at
  // the common stop reads the SAME row set as the inline arm's end: rows after
  // the bar are still raw here, so this is the arm's real final depth.
  const depthMessages = canonical.map(message => ({ ...message,
    text: rebuild === null ? message.text
      : (rebuild.messages.find(applied => applied.seq === message.seq)?.text
        ?? message.text) }));
  const finalDepth = inlineDepthOf({ timeline, messages: depthMessages, step: lastStep,
    resolve: message => message.text });
  const totalRemoved = stats.bytesRemoved;
  const shaped = inlineShapedTurnDeltaOf(rebuild?.plan);
  const netRemoved = totalRemoved - shaped.shapedTurnDelta;
  const ledger = inlineLedgerOf({ blocks: [], decisions: [], stats,
    afterRebuild: { blocks: 0, answers: 0 } });
  const tableMix = tablePass?.mix ?? inlineAnswerMixOf([]);
  const answerMix = Object.freeze({
    ...inlineAnswerMixMergeOf(tableMix),
    inline: inlineAnswerMixOf([]),
    table: tableMix,
  });
  return Object.freeze({
    schema: INLINE_ARM_SCHEMA,
    arm: "table-only",
    provider: transport.name,
    billable: transport.live === true,
    tokensBillable: transport.live === true,
    floor,
    tokenGrant,
    rebuildTokens,
    maxSteps,
    tableGrammar: INLINE_TABLE_GRAMMAR,
    caps: { timerMs: 0, askCeiling: 0, onlyCap: "token budget" },
    units: units.length,
    unitsSeen,
    commonStop: null,
    eligibility: eligibilityOf(timeline, floor),
    blocks: Object.freeze([]),
    ineligible: Object.freeze([]),
    decisions: Object.freeze([]),
    records: Object.freeze(records),
    calls: Object.freeze(records),
    tablePass,
    rebuild: rebuild === null ? null : {
      step: barStep, depthBefore, depthAfter,
      plan: inlinePlanSummaryOf(rebuild.plan), stats, restoredExact: true,
    },
    bar: { step: barStep, reached: barStep !== null },
    // `after` is the post-table depth at the bar; `final` and the common-stop
    // reading are at the arm's end step, over the same row set as the inline arm.
    depth: {
      before: depthBefore, after: depthAfter, final: finalDepth,
      beforeStep: barStep, afterStep: barStep, finalStep: lastStep,
    },
    depthAtCommonStop: Object.freeze({ step: lastStep, tokens: finalDepth }),
    turns: {
      baseline: { total: baselineMessages },
      inline: { total: baselineMessages + (barStep === null ? 0 : 1) },
      extraTurns: barStep === null ? 0 : 1,
      rebuildTurns: 0,
      tableTurns: barStep === null ? 0 : 1,
    },
    replayCalls: 0,
    replayCallsPerResult: 0,
    callsPerResult: 0,
    answeredInline: 0,
    refusedInline: 0,
    afterRebuild: Object.freeze({ units: 0, blocks: 0, calls: 0, answered: 0, refused: 0,
      answers: 0, bytesAdded: 0, applied: false }),
    answerMix,
    spentTokens, promptTokens, completionTokens,
    budgetEnforced: "between-calls",
    // This arm makes one call; budgetReached reads its OWN spend against the
    // grant. The shared stop that caps it is named in endedBy and commonStop.by.
    budgetReached: spentTokens >= tokenGrant,
    budgetExceeded: spentTokens > tokenGrant,
    budgetOvershootTokens: Math.max(0, spentTokens - tokenGrant),
    endedBy,
    endedAtStep: lastStep,
    failedSend: null,
    eligibilityBytes: units.reduce((sum, unit) => sum + unit.bytes, 0),
    bytes: {
      addedByBlocks: 0, addedByAnswers: 0,
      removedBlocks: 0, removedAnswers: 0,
      removedResults: stats.resultBytesRemoved,
      removedByTable: stats.bytesRemoved,
      shapedTurnDelta: shaped.shapedTurnDelta,
      shapedTurnBytes: shaped.shapedTurnBytes,
      shapedTurnKeptBytes: shaped.shapedTurnKeptBytes,
      totalRemoved,
      netRemoved,
      net: netRemoved,
      statsNetRemoved: stats.netBytesRemoved,
    },
    reconciliation: {
      ...ledger,
      appliedEntryCount: (rebuild?.plan.forgets.length ?? 0)
        + (rebuild?.plan.keeplines.length ?? 0),
      receipts: (rebuild?.plan.forgets.length ?? 0)
        + (rebuild?.plan.keeplines.length ?? 0),
      recallIds: new Set([...(rebuild?.plan.forgets ?? []),
        ...(rebuild?.plan.keeplines ?? [])].map(applied => applied.recallId)).size,
    },
    limitations: Object.freeze([
      "one table pass at the bar; units that land later are never asked in this arm",
      "the token budget is a cap, not a target; this arm spends one call's tokens, and"
      + " budgetReached reads this arm's own spend against the grant, not the shared stop",
      "the budget is enforced between calls (at step boundaries): the last call's cost is"
      + " only known after it returns, so the cap cannot be enforced mid-call and the arm"
      + " can end over the grant (budgetExceeded, budgetOvershootTokens)",
      "the lane replays a recording; it is not the live host's wire and makes no"
      + " product claim",
    ]),
  });
}

/** The headline one arm contributes to the comparison JSON. */
export function inlineArmHeadlineOf(arm) {
  if (arm === null || typeof arm !== "object") return null;
  const inlineAnswered = arm.decisions.filter(decision => decision.status === "answered").length;
  const inlineRefused = arm.decisions.filter(decision => decision.status !== "answered").length;
  const tableAnswered = arm.tablePass?.answered ?? 0;
  const tableRefused = arm.tablePass?.refused ?? 0;
  return {
    arm: arm.arm,
    provider: arm.provider,
    billable: arm.billable,
    tokens: { spent: arm.spentTokens, prompt: arm.promptTokens, completion: arm.completionTokens },
    depth: arm.depth,
    depthAtCommonStop: arm.depthAtCommonStop ?? null,
    answerMix: arm.answerMix ?? null,
    bytes: arm.bytes,
    calls: arm.calls.length,
    replayCalls: arm.replayCalls,
    replayCallsPerResult: arm.replayCallsPerResult,
    endedAtStep: arm.endedAtStep ?? null,
    turns: {
      baselineAtEnd: arm.turns.baseline.total,
      extraTurns: arm.turns.extraTurns,
      rebuildTurns: arm.turns.rebuildTurns ?? 0,
      total: arm.turns.inline.total,
    },
    decisions: {
      answered: inlineAnswered + tableAnswered,
      refused: inlineRefused + tableRefused,
      forgetall: arm.decisions.filter(decision => decision.action === "forgetall").length
        + (arm.tablePass?.forgetall ?? 0),
      keeplines: arm.decisions.filter(decision => decision.action === "keeplines").length
        + (arm.tablePass?.keeplines ?? 0),
      keepall: arm.decisions.filter(decision => decision.action === "keepall").length,
      inlineAnswered, inlineRefused, tableAnswered, tableRefused,
    },
    table: arm.tablePass === null ? null : {
      units: arm.tablePass.units, turns: arm.tablePass.turns,
      answered: arm.tablePass.answered, refused: arm.tablePass.refused,
      fortyPercent: arm.tablePass.fortyPercent,
      applied: arm.tablePass.applied,
    },
    rebuild: arm.rebuild === null ? null : {
      step: arm.rebuild.step,
      depthBefore: arm.rebuild.depthBefore,
      depthAfter: arm.rebuild.depthAfter,
      applied: (arm.rebuild.plan.forgets?.length ?? 0)
        + (arm.rebuild.plan.keeplines?.length ?? 0),
      removed: arm.rebuild.stats?.bytesRemoved ?? 0,
    },
    endedBy: arm.endedBy,
    budgetEnforced: arm.budgetEnforced,
    budgetReached: arm.budgetReached,
    budgetExceeded: arm.budgetExceeded,
    budgetOvershootTokens: arm.budgetOvershootTokens,
    reconciliation: arm.reconciliation,
  };
}

/**
 * The shared stop both arm records carry. The inline arm's own end is a whole
 * step (its budget is read at step boundaries), so that step is the cap for the
 * table-only arm. `by` names what bound: the inline arm's budget stop
 * (`token-budget`, or `token-budget-after-call` when the last call already
 * carried the spend past the grant), an explicit `--max-steps`, or input end.
 * When the table-only arm's input ends first, its shorter end wins and the
 * record says `input-end`; nothing is padded.
 */
export function inlineCommonStopOf({ inline, tableOnly = null, timeline,
  floor = INLINE_FLOOR_BYTES }) {
  const inputEndStep = eligibleOf(timeline, floor)
    .reduce((max, unit) =>
      Math.max(max, Number.isSafeInteger(unit.step) ? unit.step : 0), 0);
  const step = Number.isSafeInteger(inline?.endedAtStep) ? inline.endedAtStep : 0;
  const earlierThanInput = step < inputEndStep;
  const budgetStopped = inline?.endedBy === "token-budget"
    || inline?.endedBy === "token-budget-after-call";
  const by = earlierThanInput && budgetStopped ? inline.endedBy
    : (earlierThanInput && inline?.endedBy === "max-steps" ? "max-steps" : "input-end");
  if (tableOnly !== null && Number.isSafeInteger(tableOnly.endedAtStep)
    && tableOnly.endedAtStep < step) {
    return Object.freeze({ step: tableOnly.endedAtStep, by: "input-end" });
  }
  return Object.freeze({ step, by });
}

/** Attach the shared stop to a frozen arm record. */
function withCommonStopOf(arm, commonStop) {
  return Object.freeze({ ...arm, commonStop });
}

/**
 * The comparison the lane writes beside the two arm records. It states the
 * shared input, both headlines, the honest limitations and a numeric diff. Two
 * comparisons are reported: `commonPrefix` is PRIMARY and reads only the one
 * window both arms covered (same steps and same units seen); `fullRun` is the
 * SECONDARY view of each arm to its own end. When the stops differ, the primary
 * comparison refuses the delta by name (`notComparable`) rather than mixing
 * prefixes; it never claims a win from extra steps.
 */
export function inlineCompareOf({ inline, tableOnly, input = {}, settings = {},
  commonStop = null }) {
  if (inline === null || tableOnly === null) {
    refuse("sim-batch-inline-compare",
      "the comparison needs both arms; run --inline-ask and --table-only together");
  }
  for (const [label, value] of [["floor", settings.floor], ["bar", settings.rebuildTokens],
    ["grammar", settings.tableGrammar]]) {
    if (value === undefined) refuse("sim-batch-inline-compare", `the comparison needs ${label}`);
  }
  if (inline.floor !== tableOnly.floor) {
    refuse("sim-batch-inline-compare", "the two arms read different floors");
  }
  if (inline.rebuildTokens !== tableOnly.rebuildTokens) {
    refuse("sim-batch-inline-compare", "the two arms read different rebuild depths");
  }
  if (inline.tableGrammar !== tableOnly.tableGrammar) {
    refuse("sim-batch-inline-compare", "the two arms speak different table grammars");
  }
  const left = inlineArmHeadlineOf(inline);
  const right = inlineArmHeadlineOf(tableOnly);
  const stop = commonStop ?? inline.commonStop ?? tableOnly.commonStop
    ?? { step: Math.min(left.endedAtStep ?? 0, right.endedAtStep ?? 0), by: "input-end" };
  const steps = Object.freeze({
    inline: left.endedAtStep ?? null,
    tableOnly: right.endedAtStep ?? null,
  });
  const unitsSeen = Object.freeze({
    inline: Number.isSafeInteger(inline.unitsSeen) ? inline.unitsSeen : null,
    tableOnly: Number.isSafeInteger(tableOnly.unitsSeen) ? tableOnly.unitsSeen : null,
  });
  const baselineMessages = Object.freeze({
    inline: left.turns.baselineAtEnd,
    tableOnly: right.turns.baselineAtEnd,
  });
  // The depth delta is read at ONE step for BOTH arms: the common stop. The
  // per-arm `depth.before`/`depth.after` pairs sit at each arm's own rebuild
  // step and are never subtracted from each other.
  const depthSteps = Object.freeze({
    inline: left.depthAtCommonStop?.step ?? null,
    tableOnly: right.depthAtCommonStop?.step ?? null,
  });
  if (!Number.isSafeInteger(depthSteps.inline) || !Number.isSafeInteger(depthSteps.tableOnly)) {
    refuse("sim-batch-inline-compare-depth-step",
      "both arms must carry depthAtCommonStop with the step it was measured at;"
      + ` got inline ${String(depthSteps.inline)}, table-only ${String(depthSteps.tableOnly)}`);
  }
  if (depthSteps.inline !== depthSteps.tableOnly) {
    refuse("sim-batch-inline-compare-depth-step",
      `the depth delta needs one step for both arms: inline measured at`
      + ` ${String(depthSteps.inline)}, table-only at ${String(depthSteps.tableOnly)}`);
  }
  if (depthSteps.inline !== stop.step || depthSteps.tableOnly !== stop.step) {
    refuse("sim-batch-inline-compare-depth-step",
      `the depth delta must be measured at the common stop ${String(stop.step)}:`
      + ` inline @${String(depthSteps.inline)}, table-only @${String(depthSteps.tableOnly)}`);
  }
  const depthAtCommonStop = Object.freeze({
    step: depthSteps.inline,
    inline: left.depthAtCommonStop.tokens,
    tableOnly: right.depthAtCommonStop.tokens,
    delta: right.depthAtCommonStop.tokens - left.depthAtCommonStop.tokens,
  });
  const mixLineOf = mix => `${String(mix?.answered ?? 0)} answered /`
    + ` ${String(mix?.refused ?? 0)} refused`;
  const diffOf = ({ includeStep = false } = {}) => {
    const diff = {
      spentTokens: right.tokens.spent - left.tokens.spent,
      calls: right.calls - left.calls,
      replayCalls: right.replayCalls - left.replayCalls,
      extraTurns: right.turns.extraTurns - left.turns.extraTurns,
      baselineAtEnd: right.turns.baselineAtEnd - left.turns.baselineAtEnd,
      answered: right.decisions.answered - left.decisions.answered,
      refused: right.decisions.refused - left.decisions.refused,
      netRemoved: right.bytes.netRemoved - left.bytes.netRemoved,
      grossRemoved: right.bytes.totalRemoved - left.bytes.totalRemoved,
      bytesAdded: right.bytes.addedByBlocks + right.bytes.addedByAnswers
        - left.bytes.addedByBlocks - left.bytes.addedByAnswers,
      depthAtCommonStop: depthAtCommonStop.delta,
    };
    if (includeStep) diff.endedAtStep = (right.endedAtStep ?? 0) - (left.endedAtStep ?? 0);
    return diff;
  };
  let notComparable = null;
  if (steps.inline === null || steps.tableOnly === null) {
    notComparable = {
      code: "sim-batch-inline-compare-steps",
      message: "an arm records no end step; no common-prefix delta is reported",
    };
  } else if (steps.inline !== steps.tableOnly) {
    notComparable = {
      code: "sim-batch-inline-compare-steps",
      message: `the primary comparison needs one window: inline ended at step`
        + ` ${String(steps.inline)}, table-only at step ${String(steps.tableOnly)};`
        + " no common-prefix delta is reported",
    };
  } else if (unitsSeen.inline !== unitsSeen.tableOnly) {
    notComparable = {
      code: "sim-batch-inline-compare-units",
      message: `the arms saw different eligible units (${String(unitsSeen.inline)} vs`
        + ` ${String(unitsSeen.tableOnly)}) at step ${String(steps.inline)};`
        + " no common-prefix delta is reported",
    };
  } else if (baselineMessages.inline !== baselineMessages.tableOnly) {
    notComparable = {
      code: "sim-batch-inline-compare-rows",
      message: `the arms read different row counts (${String(baselineMessages.inline)} vs`
        + ` ${String(baselineMessages.tableOnly)}) at step ${String(steps.inline)};`
        + " no common-prefix delta is reported",
    };
  }
  return Object.freeze({
    schema: INLINE_COMPARE_SCHEMA,
    statement: "Both arms replay the same recording, floor 512, the same token budget, the"
      + " same 200k bar, and the jsonl-20-nokeepall table pass with the 40 percent line only."
      + " The inline arm appends a block per eligible result and harvests each answer from a"
      + " labelled replay-extra-call; the table-only arm appends no block and makes one table"
      + " call at the bar. Both stop at commonStop (the earlier of the inline arm's budget"
      + " stop and input end), so commonPrefix reads one window: the same steps and the same"
      + " units seen. fullRun is secondary and repeats each arm's own totals."
      + " Neither arm is a live-wire measurement.",
    commonStop: Object.freeze({ step: stop.step, by: stop.by }),
    commonPrefix: Object.freeze({
      primary: true,
      comparable: notComparable === null,
      steps,
      unitsSeen,
      baselineMessages,
      // The ONE depth window both arms share: same step, same row set.
      depthAtCommonStop,
      answerMix: Object.freeze({ inline: left.answerMix, tableOnly: right.answerMix }),
      diff: notComparable === null ? Object.freeze(diffOf()) : null,
      notComparable: notComparable === null ? null : Object.freeze(notComparable),
    }),
    fullRun: Object.freeze({
      primary: false,
      label: "each arm to its own end; with the shared stop both records cover one"
        + " window, and this block is context, not the primary comparison",
      steps,
      sameWindow: steps.inline === steps.tableOnly
        && unitsSeen.inline === unitsSeen.tableOnly,
      diff: Object.freeze(diffOf({ includeStep: true })),
    }),
    input,
    settings,
    // The budget is one cap with one enforcement point: between calls. The
    // arms' own records carry the same fields; this block repeats them beside
    // the grant so the comparison can be read without joining two artifacts.
    budget: Object.freeze({
      grant: inline.tokenGrant,
      enforced: "between-calls",
      note: "the budget is enforced between calls: the last call's cost is only known"
        + " after it returns, so the cap cannot be enforced mid-call",
      inline: Object.freeze({
        endedBy: left.endedBy,
        reached: left.budgetReached,
        exceeded: left.budgetExceeded,
        overshootTokens: left.budgetOvershootTokens,
      }),
      tableOnly: Object.freeze({
        endedBy: right.endedBy,
        reached: right.budgetReached,
        exceeded: right.budgetExceeded,
        overshootTokens: right.budgetOvershootTokens,
      }),
    }),
    provider: { name: inline.provider, billable: inline.billable },
    arms: { inline: left, tableOnly: right },
    // The two call paths do not draw from the same answer mix: the stub refuses
    // more on the inline path than in the table pass. The byte and depth deltas
    // are dominated by that profile, so the flag and the note travel with them.
    confounded: "stub-answer-mix",
    confoundedNote: `the stub's answer mix is inline`
      + ` ${mixLineOf(left.answerMix?.inline)}, table`
      + ` ${mixLineOf(right.answerMix?.table)}; the byte and depth deltas reflect that`
      + ` mix, not a mechanism effect`,
    reconciles: left.reconciliation.ok === true && right.reconciliation.ok === true,
    limitations: Object.freeze([
      "the inline arm's answers come from labelled replay-extra-call sends, not from the"
      + " recording's unfilled assistant turns; replayCallsPerResult states the rate",
      "each inline replay-extra-call pays a full prompt; the live mechanism would ride a"
      + " turn the model was going to take, so the token diff is a replay cost, not a live one",
      "the token budget is a cap: the inline arm stops at its budget or input end, and the"
      + " table-only arm is stopped at the same step; the budget is enforced between calls,"
      + " so the last call's cost is only known after it returns, the cap cannot be enforced"
      + " mid-call, and the inline arm may end over the grant; commonStop{step, by} states"
      + " which bound and budgetEnforced/budgetExceeded/budgetOvershootTokens state the"
      + " enforcement point and the spend past the grant",
      "fullRun is secondary: it repeats each arm's own totals and is not used when the steps"
      + " differ; the primary commonPrefix refuses a delta on unequal steps, units or rows,"
      + " and notComparable names why",
      "reconciles is both arms' reconciliation.ok; the inline arm's is false because its"
      + " post-rebuild blocks and answers stay on the final surface, and the ledger names"
      + " their counts (blocksRemaining, answersRemaining) with the mismatch field checked",
      "this is a sim experiment on a recording, not a product measurement",
    ]),
  });
}

/** Both arms on one timeline, for the CLI and the tests. */
export async function runInlineArms({ timeline, transport, floor = INLINE_FLOOR_BYTES,
  tokenGrant, rebuildTokens = INLINE_REBUILD_TOKENS, maxSteps = null,
  sessionId = "racoons-inline-ask-sim", log = () => {}, onInlineRecord = () => {},
  onTableRecord = () => {} }) {
  const inlineRaw = await runInlineAskArm({ timeline, transport, floor, tokenGrant,
    rebuildTokens, maxSteps, sessionId, log, onRecord: onInlineRecord });
  const firstStop = inlineCommonStopOf({ inline: inlineRaw, timeline, floor });
  const tableRaw = await runTableOnlyArm({ timeline, transport, floor, tokenGrant,
    rebuildTokens, maxSteps: firstStop.step, sessionId, log, onRecord: onTableRecord });
  const commonStop = inlineCommonStopOf({ inline: inlineRaw, tableOnly: tableRaw,
    timeline, floor });
  const inline = withCommonStopOf(inlineRaw, commonStop);
  const tableOnly = withCommonStopOf(tableRaw, commonStop);
  return {
    inline,
    tableOnly,
    commonStop,
    compare: inlineCompareOf({
      inline, tableOnly, commonStop,
      input: {
        transcript: timeline?.transcriptSha256 ?? null,
        transcriptRows: timeline?.fileRows ?? null,
      },
      settings: { floor, rebuildTokens, tokenGrant, tableGrammar: INLINE_TABLE_GRAMMAR,
        tokenBudget: tokenGrant, maxSteps, timerMs: 0, askCeiling: 0 },
    }),
  };
}

/**
 * The inline lane's CLI body: the same input readings, pins and key handling as
 * `main`, then one or both arms on the SAME timeline. `--inline-ask` alone runs
 * the inline arm; `--table-only` alone runs the table arm; both write both
 * records and the comparison. A positive `--kill-ms` or `--ask-ceiling` refuses:
 * the plan's one cap is the token budget.
 */
async function mainInline(values) {
  const transportName = values.transport ?? "deepseek";
  if (!["deepseek", "stub"].includes(transportName)) {
    refuse("sim-batch-transport-invalid",
      `--transport takes deepseek or stub, got ${String(transportName)}`);
  }
  const floor = values.floor === undefined ? FLOOR_BYTES : Number(values.floor);
  if (floor !== INLINE_FLOOR_BYTES) {
    refuse("sim-batch-inline-floor",
      `the inline lane's floor is ${String(INLINE_FLOOR_BYTES)} B, got ${String(values.floor)}`);
  }
  const tokenGrant = Number(values.tokenGrant);
  if (!Number.isSafeInteger(tokenGrant) || tokenGrant < 1) {
    refuse("sim-batch-token-grant-required",
      "--token-grant is required and takes a positive integer token count"
      + " (10000000 for a sim run); it is the only run cap");
  }
  const rebuildTokens = Number(values.inlineRebuildTokens ?? String(INLINE_REBUILD_TOKENS));
  if (!Number.isSafeInteger(rebuildTokens) || rebuildTokens < 1) {
    refuse("sim-batch-inline-rebuild-tokens",
      `--inline-rebuild-tokens takes a positive integer, got`
      + ` ${String(values.inlineRebuildTokens)}`);
  }
  const maxSteps = values.maxSteps === undefined ? null : Number(values.maxSteps);
  if (maxSteps !== null && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
    refuse("sim-batch-inline-max-steps",
      `--max-steps takes a positive integer, got ${String(values.maxSteps)}`);
  }
  const killMs = Number(values.killMs ?? String(DEFAULT_KILL_MS));
  const askCeiling = Number(values.askCeiling ?? String(DEFAULT_ASK_CEILING));
  if (killMs !== 0 || askCeiling !== 0) {
    refuse("sim-batch-inline-caps",
      "the inline lane arms no timer and no ask ceiling: --kill-ms and --ask-ceiling"
      + " both take 0; the token budget is the only cap");
  }
  const grammar = values.grammarAlias ?? values.askGrammar ?? INLINE_TABLE_GRAMMAR;
  if (values.askGrammar !== undefined && values.grammarAlias !== undefined
    && values.askGrammar !== values.grammarAlias) {
    refuse("sim-batch-inline-grammar",
      `--grammar and --ask-grammar disagree (${String(values.grammarAlias)} vs`
      + ` ${String(values.askGrammar)}); the lane speaks ${INLINE_TABLE_GRAMMAR} only`);
  }
  if (grammar !== INLINE_TABLE_GRAMMAR) {
    refuse("sim-batch-inline-grammar",
      `the inline lane sets --grammar ${INLINE_TABLE_GRAMMAR} itself;`
      + ` got ${String(grammar)}`);
  }
  const order = values.askOrder ?? DEFAULT_ASK_ORDER;
  assertOrderForGrammar(grammar, order);
  const askScope = values.askScope ?? DEFAULT_ASK_SCOPE;
  if (askScope !== "new") {
    refuse("sim-batch-inline-ask-scope",
      `the inline lane's rebuild pass is a new-unit table; --ask-scope takes new,`
      + ` got ${String(askScope)}`);
  }
  for (const [flag, value] of [
    ["--mode", values.mode], ["--first-fire-depth", values.firstFireDepth],
    ["--lanes", values.lanes], ["--thresholds", values.thresholds],
    ["--threshold-units", values.thresholdUnits],
    ["--threshold-semantics", values.thresholdSemantics],
  ]) {
    if (value !== undefined) {
      refuse("sim-batch-inline-flag",
        `${flag} is a batch/threshold lane's flag and does not apply to the inline lane;`
        + " drop it");
    }
  }
  // The inline surface is the reconstructed one: the host trim never runs.
  if (values.ignoreHostPrunes !== true) {
    refuse("sim-batch-inline-host-pruner",
      "the inline lane reads the reconstructed surface and requires --ignore-host-prunes"
      + " (the host pruner off); --allow-host-pruner is a different world");
  }
  const reconstruction = values.reconstruction === true;
  const allowZeroReasoning = values.allowZeroReasoning === true;
  const segment = values.segment === undefined ? null : Number(values.segment);
  if (segment !== null && (!Number.isSafeInteger(segment) || segment < 1)) {
    refuse("sim-batch-segment-invalid", `--segment takes a positive step, got ${values.segment}`);
  }
  const outDir = path.resolve(values.out ?? LIVE_DIR);
  const transcript = values.transcript ?? DEFAULT_TRANSCRIPT;
  const usage = values.usage ?? DEFAULT_USAGE;
  for (const [label, file] of [["transcript", transcript], ["usage", usage]]) {
    if (!existsSync(file)) {
      refuse("sim-batch-input-absent",
        `the ${label} file ${file} is absent; point CREMATOR_SIM_EVIDENCE at the world's`
        + ` root, or pass --transcript/--usage`);
    }
  }
  const usageBytes = readFileSync(usage);
  const usageSha256 = createHash("sha256").update(usageBytes).digest("hex");
  const depths = depthsInSegment(readUsage(JSON.parse(usageBytes.toString("utf8"))), segment);
  const timeline = readTimeline(transcript, { segment, ignoreHostPrunes: true, reconstruction });
  assertUsageStepsPinned(timeline, depths);
  const pins = assertSegmentPins(timeline, depths, { allowZeroReasoning,
    input: { transcriptSha256: timeline.transcriptSha256, usageSha256, usageFile: usage } });
  const pruneGate = assertZeroPruneGate(timeline);
  process.stdout.write(`[inline-ask] provider ${transportName}`
    + ` (${transportName === "stub" ? "synthetic tokens, not billable" : "live route, billable"})`
    + `; floor ${String(floor)}; bar ${String(rebuildTokens)}; budget ${String(tokenGrant)}`
    + `; timer off; ask ceiling off; grammar ${INLINE_TABLE_GRAMMAR}\n`);
  process.stdout.write(`[inline-ask] input rows ${String(timeline.fileRows)},`
    + ` eligible ${String(eligibilityOf(timeline, floor).eligible)},`
    + ` prune gate ${pruneGate.status}\n`);
  mkdirSync(outDir, { recursive: true });
  const kill = armKillTimer({ armedMs: 0, outDir });
  process.stdout.write("[kill-timer] off (no wall-clock cap; the token budget is the only cap)\n");
  let keyInfo = { key: null, found: false, source: "stub (no key read)" };
  let transport;
  if (transportName === "deepseek") {
    const loaded = deepseekKey();
    keyInfo = { key: loaded.key, found: loaded.key !== null, source: loaded.source };
    process.stdout.write(`[key] DEEPSEEK_API_KEY: ${keyInfo.found ? "found" : "not found"}`
      + ` in ${keyInfo.source}\n`);
    if (!keyInfo.found) refuse("sim-batch-key-absent", "DEEPSEEK_API_KEY not found; no call was made");
    transport = deepseekTransport(keyInfo.key, { deadline: Number.POSITIVE_INFINITY,
      log: line => process.stdout.write(`${line}\n`) });
  } else {
    transport = stubTransport();
  }
  const input = {
    transcript, transcriptSha256: timeline.transcriptSha256, usage, usageSha256,
    transcriptRows: timeline.fileRows, segmentExcludedRows: timeline.excludedRows ?? 0,
  };
  const settings = {
    floor, tokenGrant, rebuildTokens, maxSteps, tableGrammar: INLINE_TABLE_GRAMMAR,
    timerMs: 0, askCeiling: 0, onlyCap: "token budget",
  };
  const sessionId = `racoons-inline-ask-sim:${String(timeline.transcriptSha256 ?? "rows").slice(0, 12)}`;
  const log = line => process.stdout.write(`${line}\n`);
  const armOptions = { timeline, transport, floor, tokenGrant, rebuildTokens, maxSteps,
    sessionId, log };
  try {
    const inlineRaw = values.inlineAsk === true
      ? await runInlineAskArm({ ...armOptions,
        onRecord: record => writeJsonl(path.join(outDir, "inline-ask.jsonl"), record) })
      : null;
    // When both arms are selected the inline arm runs first and its own stop
    // step caps the table-only arm: the primary comparison reads one window.
    let commonStop = inlineRaw !== null && values.tableOnly === true
      ? inlineCommonStopOf({ inline: inlineRaw, timeline, floor }) : null;
    const tableRaw = values.tableOnly === true
      ? await runTableOnlyArm({ ...armOptions,
        maxSteps: commonStop === null ? maxSteps : commonStop.step,
        onRecord: record => writeJsonl(path.join(outDir, "table-only.jsonl"), record) })
      : null;
    if (commonStop !== null && tableRaw !== null) {
      commonStop = inlineCommonStopOf({ inline: inlineRaw, tableOnly: tableRaw,
        timeline, floor });
    }
    const inline = inlineRaw === null ? null : withCommonStopOf(inlineRaw, commonStop);
    const tableOnly = tableRaw === null ? null : withCommonStopOf(tableRaw, commonStop);
    const head = {
      provider: transportName, live: transportName === "deepseek",
      billable: transportName === "deepseek", tokensBillable: transportName === "deepseek",
      route: ROUTE, key: { found: keyInfo.found },
      killTimer: { armedMs: 0, timer: kill.timer }, input, settings,
      citable: false,
      reasons: ["stand-in-context", "sim-only-lane", "replay-extra-call"],
    };
    const targets = [];
    if (inline !== null) {
      const target = path.join(outDir, "inline-ask.json");
      writeResultArtifact({ target, output: { ...head, ...inline } });
      targets.push(target);
    }
    if (tableOnly !== null) {
      const target = path.join(outDir, "table-only.json");
      writeResultArtifact({ target, output: { ...head, ...tableOnly } });
      targets.push(target);
    }
    let compare = null;
    if (inline !== null && tableOnly !== null) {
      compare = inlineCompareOf({ inline, tableOnly, input, settings, commonStop });
      const target = path.join(outDir, "inline-ask.compare.json");
      writeResultArtifact({ target, output: compare });
      targets.push(target);
    }
    for (const arm of [inline, tableOnly]) {
      if (arm === null) continue;
      const headline = inlineArmHeadlineOf(arm);
      process.stdout.write(`[${arm.arm}] calls ${String(arm.calls.length)}`
        + ` (replay-extra ${String(arm.replayCalls)} @`
        + ` ${arm.replayCallsPerResult === null ? "n/a" : arm.replayCallsPerResult.toFixed(3)}/result)`
        + `; decisions answered ${String(headline.decisions.answered)}`
        + ` refused ${String(headline.decisions.refused)}`
        + ` (inline ${String(headline.decisions.inlineAnswered)}`
        + `/${String(headline.decisions.inlineRefused)}, table`
        + ` ${String(headline.decisions.tableAnswered)}`
        + `/${String(headline.decisions.tableRefused)})`
        + `; depth ${arm.depth.before === null ? "bar not reached"
          : `@${String(arm.depth.afterStep)} ${String(arm.depth.before)} -> ${String(arm.depth.after)}`}`
        + `; depth at common stop @${String(arm.depthAtCommonStop.step)}`
        + ` ${String(arm.depthAtCommonStop.tokens)}`
        + `; removed ${String(arm.bytes.totalRemoved)} B`
        + ` (blocks ${String(arm.bytes.removedBlocks)}, answers ${String(arm.bytes.removedAnswers)},`
        + ` results ${String(arm.bytes.removedResults)})`
        + `; net ${String(arm.bytes.netRemoved)} B (minus blocks ${String(arm.bytes.addedByBlocks)},`
        + ` answers ${String(arm.bytes.addedByAnswers)}, shaped ${String(arm.bytes.shapedTurnDelta)})`
        + `; table`
        + ` ${arm.tablePass === null ? "none" : `${String(arm.tablePass.units)} unit(s), 40%`
          + ` ${String(arm.tablePass.fortyPercent)}, 70% ${String(arm.tablePass.seventyPercent)}`}`
        + `; spent ${String(arm.spentTokens)}/${String(arm.tokenGrant)} tok`
        + ` (billable ${String(arm.tokensBillable)}); endedBy ${arm.endedBy}`
        + `; budget enforced ${arm.budgetEnforced}, reached`
        + ` ${String(arm.budgetReached)}, exceeded ${String(arm.budgetExceeded)},`
        + ` overshoot ${String(arm.budgetOvershootTokens)} tok\n`);
    }
    if (compare !== null) {
      const prefix = compare.commonPrefix;
      process.stdout.write(`[compare] common stop step ${String(compare.commonStop.step)}`
        + ` (${compare.commonStop.by}); primary common-prefix`
        + ` ${prefix.comparable
          ? `units ${String(prefix.unitsSeen.inline)}/${String(prefix.unitsSeen.tableOnly)},`
            + ` calls diff ${String(prefix.diff.calls)},`
            + ` net bytes removed diff ${String(prefix.diff.netRemoved)} B`
          : `not comparable (${prefix.notComparable.code})`}`
        + `; depth at common stop @${String(prefix.depthAtCommonStop.step)}:`
        + ` inline ${String(prefix.depthAtCommonStop.inline)} vs table-only`
        + ` ${String(prefix.depthAtCommonStop.tableOnly)}`
        + ` (delta ${String(prefix.depthAtCommonStop.delta)})`
        + `; ledger inline blocks remaining ${String(compare.arms.inline.reconciliation.blocksRemaining)},`
        + ` answers remaining ${String(compare.arms.inline.reconciliation.answersRemaining)},`
        + ` ok ${String(compare.arms.inline.reconciliation.ok)}`
        + `; full-run inline step ${String(compare.fullRun.steps.inline)},`
        + ` table-only step ${String(compare.fullRun.steps.tableOnly)},`
        + ` net diff ${String(compare.fullRun.diff.netRemoved)} B (secondary);`
        + ` reconciles ${String(compare.reconciles)};`
        + ` confounded ${String(compare.confounded)}\n`);
    }
    for (const target of targets) process.stdout.write(`wrote ${target}\n`);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({ inline, tableOnly, compare }, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof SimBatchUnitsRefusal)) throw error;
    const partial = partialResultOf({
      head: { arm: values.inlineAsk === true ? "inline" : "table-only", input, settings,
        provider: transportName, billable: transportName === "deepseek" },
      refusal: error.message,
    });
    const target = path.join(outDir, "inline-ask.refused.json");
    writeResultArtifact({ target, output: partial });
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`refused; wrote ${target}\n`);
    return 2;
  }
}

export async function main(argv) {
  const { values } = parseDevArgs(argv, {
    options: optionsOf([
      ["--i-am-the-owner", "boolean", "owner"],
      ["--transcript", "string"], ["--usage", "string"], ["--floor", "string"],
      ["--segment", "string"],
      ["--mode", "string"], ["--lanes", "string"], ["--thresholds", "string"],
      ["--threshold-units", "string", "thresholdUnits"],
      ["--threshold-semantics", "string", "thresholdSemantics"],
      ["--first-fire-depth", "string", "firstFireDepth"],
      ["--token-grant", "string", "tokenGrant"],
      ["--ask-ceiling", "string", "askCeiling"],
      ["--kill-ms", "string", "killMs"], ["--transport", "string"],
      ["--ask-grammar", "string", "askGrammar"],
      ["--ask-order", "string", "askOrder"],
      ["--ask-scope", "string", "askScope"],
      ["--ignore-host-prunes", "boolean", "ignoreHostPrunes"],
      ["--allow-host-pruner", "boolean", "allowHostPruner"],
      ["--reconstruction", "boolean"],
      ["--allow-zero-reasoning", "boolean", "allowZeroReasoning"],
      ["--inline-ask", "boolean", "inlineAsk"],
      ["--table-only", "boolean", "tableOnly"],
      ["--inline-rebuild-tokens", "string", "inlineRebuildTokens"],
      ["--max-steps", "string", "maxSteps"],
      ["--grammar", "string", "grammarAlias"],
      ["--out", "string"], ["--json", "boolean"],
    ]),
    refuse: message => refuse("sim-batch-live-args", message),
    usage: () => USAGE, help: USAGE, prefix: "sim-batch-live.mjs: ",
  });
  if (values.owner !== true) {
    refuse("sim-batch-live-owner-required",
      "--i-am-the-owner is required; nothing was read and no call was made");
  }
  // The inline-ask experiment is its own lane on the same replay: it reads no
  // batch/threshold cadence and sets its grammar and bar itself. Branching
  // before the batch validation keeps every existing path byte-identical.
  if (values.inlineAsk === true || values.tableOnly === true) {
    return mainInline(values);
  }
  if (values.grammarAlias !== undefined) {
    refuse("sim-batch-grammar-alias",
      "--grammar is the inline lane's alias for --ask-grammar; a batch/threshold lane"
      + " takes --ask-grammar");
  }
  const mode = values.mode ?? "batch";
  if (!["batch", "threshold"].includes(mode)) {
    refuse("sim-batch-mode-invalid", `--mode takes batch or threshold, got ${String(mode)}`);
  }
  const semantics = values.thresholdSemantics ?? DEFAULT_THRESHOLD_SEMANTICS;
  if (!THRESHOLD_SEMANTICS.includes(semantics)) {
    refuse("sim-batch-threshold-semantics-invalid",
      `--threshold-semantics takes ${THRESHOLD_SEMANTICS.join(" or ")}, got ${String(semantics)}`);
  }
  const thresholdUnits = values.thresholdUnits ?? DEFAULT_THRESHOLD_UNITS;
  if (!THRESHOLD_UNITS.includes(thresholdUnits)) {
    refuse("sim-batch-threshold-units-invalid",
      `--threshold-units takes ${THRESHOLD_UNITS.join(" or ")}, got ${String(thresholdUnits)}`);
  }
  const firstFireDepth = values.firstFireDepth === undefined
    ? null : Number(values.firstFireDepth);
  assertFirstFireDepth(firstFireDepth, { mode, thresholdUnits });
  const transportName = values.transport ?? "deepseek";
  if (!["deepseek", "stub"].includes(transportName)) {
    refuse("sim-batch-transport-invalid",
      `--transport takes deepseek or stub, got ${String(transportName)}`);
  }
  const { grammar, order } = assertOrderForGrammar(values.askGrammar ?? DEFAULT_ASK_GRAMMAR,
    values.askOrder ?? DEFAULT_ASK_ORDER);
  const askScope = assertAskScope(values.askScope ?? DEFAULT_ASK_SCOPE);
  if (mode !== "threshold" && askScope === "kept") {
    refuse("sim-batch-ask-scope-batch",
      `--ask-scope ${askScope} is threshold mode only; --mode ${mode} refuses it`);
  }
  // ADR-0041 + ADR-0045: the host pruner's state is stated, never defaulted.
  if ((values.ignoreHostPrunes === true) === (values.allowHostPruner === true)) {
    refuse("sim-batch-host-pruner-unstated",
      "state the host pruner: --ignore-host-prunes (off, the product/test arm) or"
      + " --allow-host-pruner (on, the vanilla arm); exactly one, and nothing was read");
  }
  const ignoreHostPrunes = values.ignoreHostPrunes === true;
  const hostPrunerFlag = ignoreHostPrunes ? "--ignore-host-prunes" : "--allow-host-pruner";
  // Twelfth audit item 6: the two flags state opposite worlds. Refuse BY NAME
  // before any input is read, so no summary can claim reconstruction AND a
  // modeled host pruner at once.
  if (values.reconstruction === true && !ignoreHostPrunes) {
    refuse("sim-batch-reconstruction-host-pruner",
      "--reconstruction cannot be taken with --allow-host-pruner: a reconstruction is a"
      + " pruner-OFF declaration (ADR-0041 Decision 7), and a pruner-ON replay is not one."
      + " Drop --reconstruction or take --ignore-host-prunes; nothing was read");
  }
  // ADR-0041 Decision 2 and the auditor's gate: a live, paid run never takes the
  // pruner-on opt-out. `--allow-host-pruner` belongs to the offline comparison.
  if (transportName === "deepseek" && !ignoreHostPrunes) {
    refuse("sim-batch-deepseek-host-pruner",
      "--transport deepseek refuses --allow-host-pruner: a live run measures with the"
      + " host pruner off (ADR-0041 Decision 1); the opt-out is the offline comparison's,"
      + " and a run that takes it is not a product measurement");
  }
  const lane = Number(values.lanes ?? "8");
  const threshold = Number(values.thresholds ?? (thresholdUnits === "landed-bytes"
    ? String(DEFAULT_BYTE_THRESHOLDS[0]) : "30000"));
  if (mode === "batch" && (!Number.isSafeInteger(lane) || lane < 1)) {
    refuse("sim-batch-lane-invalid", `--lanes takes one positive integer, got ${values.lanes}`);
  }
  if (mode === "threshold" && (!Number.isSafeInteger(threshold) || threshold < 1)) {
    refuse("sim-batch-threshold-invalid", `--thresholds takes one positive integer, got ${values.thresholds}`);
  }
  const tokenGrant = Number(values.tokenGrant);
  if (!Number.isSafeInteger(tokenGrant) || tokenGrant < 1) {
    refuse("sim-batch-token-grant-required",
      "--token-grant is required and takes a positive integer token count"
      + " (10000000 for a sim run; 100000000 for a live dsh run); it is the only run cap");
  }
  const askCeiling = Number(values.askCeiling ?? String(DEFAULT_ASK_CEILING));
  if (!Number.isSafeInteger(askCeiling) || askCeiling < 0) {
    refuse("sim-batch-ask-ceiling-invalid",
      `--ask-ceiling takes a non-negative integer; 0 (the default) means no ask ceiling,`
      + ` got ${values.askCeiling}`);
  }
  const killMs = Number(values.killMs ?? String(DEFAULT_KILL_MS));
  if (!Number.isSafeInteger(killMs) || killMs < 0) {
    refuse("sim-batch-kill-invalid",
      `--kill-ms takes a non-negative integer; 0 (the default) arms no timer,`
      + ` got ${values.killMs}`);
  }
  const tooLongKill = timerDelayRefusal(killMs, "--kill-ms");
  if (tooLongKill !== null) refuse("sim-batch-kill-invalid", tooLongKill);
  const outDir = path.resolve(values.out ?? LIVE_DIR);
  const transcript = values.transcript ?? DEFAULT_TRANSCRIPT;
  const usage = values.usage ?? DEFAULT_USAGE;
  const floor = values.floor === undefined ? FLOOR_BYTES : Number(values.floor);
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid", `--floor takes a non-negative integer, got ${values.floor}`);
  }
  const segment = values.segment === undefined ? null : Number(values.segment);
  if (segment !== null && (!Number.isSafeInteger(segment) || segment < 1)) {
    refuse("sim-batch-segment-invalid", `--segment takes a positive step, got ${values.segment}`);
  }

  // A missing input is a NAMED refusal, never a stack trace: a test or a run
  // that claims the pinned world on a machine without the evidence fails here,
  // and the message names the variable that points at the world.
  for (const [label, file] of [["transcript", transcript], ["usage", usage]]) {
    if (!existsSync(file)) {
      refuse("sim-batch-input-absent",
        `the ${label} file ${file} is absent; point CREMATOR_SIM_EVIDENCE at the world's`
        + " root, or pass --transcript/--usage");
    }
  }
  // Pins assert before ANY request; a drifted transcript refuses by name here.
  // The timeline is read from the PATH, not from rows read here: its
  // `transcriptSha256` is computed by the reader from the SAME bytes it parsed,
  // so the pin cannot name a file the timeline's rows did not come from. The
  // usage file is read once too: the bytes are hashed and the same text parsed,
  // so the depth series and its stated hash describe one read (twelfth audit
  // item 7).
  const usageBytes = readFileSync(usage);
  const usageSha256 = createHash("sha256").update(usageBytes).digest("hex");
  const depths = depthsInSegment(readUsage(JSON.parse(usageBytes.toString("utf8"))), segment);
  const allowZeroReasoning = values.allowZeroReasoning === true;
  const timeline = readTimeline(transcript, { segment, ignoreHostPrunes,
    reconstruction: values.reconstruction === true });
  // P3: the depth series must read the recording's own steps; a series that
  // names a step the transcript never reached refuses before any pin or send.
  assertUsageStepsPinned(timeline, depths);
  const pins = assertSegmentPins(timeline, depths, { allowZeroReasoning,
    input: { transcriptSha256: timeline.transcriptSha256, usageSha256, usageFile: usage } });
  const pruneGate = assertZeroPruneGate(timeline);
  if (segment !== null) {
    process.stdout.write(`[segment] last step ${String(segment)}`
      + `; first excluded step ${String(pins.firstExcludedStep)};`
      + ` ${String(pins.excludedRows)} row(s) excluded\n`);
    process.stdout.write(`[pins] eligible ${String(pins.eligible)} = appends ${String(pins.appends)}`
      + ` + replacements ${String(pins.replacements)}; appends ${String(pins.appends)} =`
      + ` ${String(pins.neverPruned)} never-pruned + ${String(pins.prunedOriginals)} pruned`
      + ` originals; prune journals ${String(pins.pruneJournals)}`
      + `; peak depth ${pins.ignoreHostPrunes ? "reconstructed" : "host"}`
      + `${pins.ignoreHostPrunes ? "" : ` ${String(pins.peakDepth)} at step ${String(pins.peakStep)}`}`
      + `; reasoning ${String(pins.reasoningBlocks)} turns, ${String(pins.reasoningBytes)} B`
      + `, unresendable rows ${String(pins.reasoningUnresendableRows)}`
      + `; ISSUE-195 parts ${String(pins.reasoningParts)}, stream blocks`
      + ` ${String(pins.reasoningStreamBlocks)}\n`);
  }
  process.stdout.write(`[host-pruner] input ${recordingHostPrunerState(timeline)}`
    + ` (read from the recording: ${String(timeline.inputPruneEvents)} prune row(s) in the file,`
    + ` ${String(timeline.replayedPrunes)} in the segment); modeled`
    + ` ${ignoreHostPrunes ? "off" : "on"} (${hostPrunerFlag}); this replay runs none;`
    + ` ${String(timeline.hostPrunes.length)} journals, ${String(timeline.hostTokens)} shadowed tokens`
    + `${ignoreHostPrunes ? `; ignored ${String(timeline.hostPrunesIgnored)} journals`
      + ` (${String(timeline.hostTokensIgnored)} shadowed tokens)` : ""}\n`);
  process.stdout.write(`[prune-gate] ${pruneGate.status}: ${String(pruneGate.replayedPrunes)}`
    + ` source-world prune event(s) before the filter (whole recording carried`
    + ` ${String(pruneGate.inputPruneEvents)}; reconstruction`
    + ` ${String(pruneGate.reconstruction === true)})\n`);
  process.stdout.write(`[depth] source ${String(defaultDepthSource(ignoreHostPrunes))}`
    + `${ignoreHostPrunes ? "; result.json series recorded as contaminated" : ""}\n`);

  // Arm first: nothing below this line may send a request before the stamp
  // exists. `--kill-ms 0` arms no timer and writes no stamp.
  const kill = armKillTimer({ armedMs: killMs, outDir });
  process.stdout.write(kill.timer === "off"
    ? "[kill-timer] off (no wall-clock cap; the token budget is the only cap)\n"
    : `[kill-timer] armed ${kill.armedMs} ms; fires ${kill.firesAt}\n`);

  let keyInfo = { key: null, found: false, source: "stub (no key read)" };
  // The artifact path is fixed before the key is read: a refusal from here on
  // (a missing key included) still writes the partial result to this target.
  const name = laneName(mode, lane, threshold, thresholdUnits);
  const jsonl = path.join(outDir, `${name}.jsonl`);
  const target = path.join(outDir, `${name}.json`);
  const records = [];
  /** The refusal an ask inside `runLane` raised, if any: its ask index and the live summary. */
  let refused = null;
  let summary;
  try {
    if (transportName === "deepseek") {
      const loaded = deepseekKey();
      keyInfo = { key: loaded.key, found: loaded.key !== null, source: loaded.source };
      process.stdout.write(`[key] DEEPSEEK_API_KEY: ${keyInfo.found ? "found" : "not found"}`
        + ` in ${keyInfo.source}\n`);
      if (!keyInfo.found) refuse("sim-batch-key-absent", "DEEPSEEK_API_KEY not found; no call was made");
    }
    // A zero wall-clock cap means no deadline at all: the per-call timeout
    // (CALL_TIMEOUT_MS) still bounds one request, and the token budget bounds
    // the run.
    const deadline = killMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + killMs;
    const transport = transportName === "stub" ? stubTransport()
      : deepseekTransport(keyInfo.key, { deadline, log: line => process.stdout.write(`${line}\n`) });
    summary = await runLane({
      transcript, depths, lane, mode, threshold: mode === "threshold" ? threshold : null,
      thresholdUnits, floor, segment, semantics, transport, grammar, order, askScope,
      firstFireDepth, askCeiling, tokenGrant, deadline, ignoreHostPrunes, hostPrunerFlag,
      reconstruction: values.reconstruction === true, allowZeroReasoning,
      input: { transcriptSha256: timeline.transcriptSha256, usageSha256, usageFile: usage },
      log: line => process.stdout.write(`${line}\n`),
      onRecord: record => { records.push(record); writeJsonl(jsonl, record); },
      onRefusal: event => { refused = event; },
    });
  } catch (error) {
    // Exit 2 still leaves an artifact: every field the run knows, the records
    // written so far, the refusal verbatim, and (when the refusal came from an
    // ask) the ask index and the live summary. A refused paid run must not be
    // a line on a terminal with nothing on disk.
    if (!(error instanceof SimBatchUnitsRefusal)) throw error;
    const output = partialResultOf({
      head: {
        mode, threshold: mode === "threshold" ? threshold : null, thresholdUnits,
        semantics, askGrammar: grammar, askOrder: order, askScope, firstFireDepth,
        ignoreHostPrunes, hostPrunerFlag,
        inputHostPruner: recordingHostPrunerState(timeline),
        modeledHostPruner: ignoreHostPrunes ? "off" : "on", runHostPruner: "none",
        reconstruction: values.reconstruction === true, allowZeroReasoning,
        depthSource: defaultDepthSource(ignoreHostPrunes),
        pruneGate,
        route: ROUTE, transport: transportName, live: transportName === "deepseek",
        key: { found: keyInfo.found },
        killTimer: { armedMs: kill.armedMs, timer: kill.timer, armedAt: kill.armedAt,
          firesAt: kill.firesAt },
        askCeiling, tokenGrant, startedAt: kill.armedAt,
        input: { transcript, transcriptSha256: timeline.transcriptSha256,
          usage, usageSha256, transcriptRows: timeline.fileRows },
      },
      records,
      refusal: error.message,
      refusedAtAsk: refused?.askIndex ?? null,
      summary: refused?.summary ?? null,
    });
    writeResultArtifact({ target, output });
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`refused; wrote ${target}\n`);
    return 2;
  }
  const output = {
    mode, threshold: summary.threshold, thresholdUnits, semantics, askGrammar: grammar,
    askOrder: order, askScope, tableSource: summary.tableSource, firstFireDepth,
    ignoreHostPrunes, inputHostPruner: summary.inputHostPruner,
    modeledHostPruner: summary.modeledHostPruner, runHostPruner: "none",
    hostPrunerFlag,
    inputDeviations: summary.inputDeviations,
    depthSource: summary.depthSource,
    hostDepthSeriesContaminated: summary.hostDepths.contaminated,
    reconstruction: summary.reconstruction === true,
    allowZeroReasoning,
    citable: summary.citable,
    measurement: summary.measurement,
    pruneGate,
    // The run's input provenance (the audit's evidence rule): the exact files
    // replayed, their hashes, and ISSUE-195's two reasoning counts beside
    // ADR-0045's resendable counts.
    input: {
      transcript, transcriptSha256: timeline.transcriptSha256,
      usage, usageSha256,
      transcriptRows: timeline.fileRows,
    },
    reasoning: {
      ...summary.reasoning,
      resendableBlocks: timeline.reasoningBlocks,
      resendableBytes: timeline.reasoningBytes,
      reasoningParts: timeline.reasoningParts,
      reasoningStreamBlocks: timeline.reasoningStreamBlocks,
      fileReasoningParts: timeline.fileReasoningParts,
      fileReasoningStreamBlocks: timeline.fileReasoningStreamBlocks,
      reasoningTurns: timeline.reasoningTurns,
    },
    route: ROUTE, transport: transportName, key: { found: keyInfo.found },
    killTimer: { armedMs: kill.armedMs, timer: kill.timer, armedAt: kill.armedAt,
      firesAt: kill.firesAt },
    askCeiling, tokenGrant,
    startedAt: kill.armedAt, finishedAt: new Date().toISOString(),
    // `lane` is the LANE'S NAME (`batch-8`, `threshold-60000`), placed after the
    // spread so the summary's numeric lane size can never overwrite it (P12);
    // the size rides as `laneSize`.
    ...summary, lane: name, laneSize: summary.lane, records,
  };
  writeResultArtifact({ target, output });
  process.stdout.write(`${summaryLineOf(summary, { askCeiling, tokenGrant, semantics,
    firstFireDepth })}\n`);
  process.stdout.write(`wrote ${jsonl}\nwrote ${target}\n`);
  if (values.json === true) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  });
}
