#!/usr/bin/env node
/**
 * The batched-ask trigger, replayed offline for PLAN mode (chunk 1). No socket,
 * no clock, no randomness. Run `node dev/sim/sim-batch-units.mjs
 * [--transcript f] [--usage f] [--floor 512] [--lanes 8[,16]] [--producer
 * stub] [--plan] [--json]`.
 *
 * Timeline: every `tool/result` row is one unit (body via the adapter's own
 * `textOf`): 641 in the 2026-10-29 full-rerun vanilla world (session fab6632e),
 * 552 over the product's 512 floor and not errors. That world is the default
 * because it carries the agent's reasoning (ADR-0045: 86 reasoning turns and
 * 155,545 reasoning bytes in segment 139); the 2026-10-30 pair-2 world carries
 * none and its numbers are void. `compaction/prune` rows are FIXED removals
 * whose shadowed seqs the policy is never credited for again.
 * `compaction/start` is a boundary only; the batch carries across it (ADR-0003
 * §5: never flush). The replay never reaches native compaction, so `--segment`
 * is required on any log that carries a `compaction/start` row.
 *
 * Depth: answers go through `renderLane`, so freed bytes are its own terms NET
 * of the summary, the marker lines and the framing the shaped turn still
 * occupies (`netDroppedOf`); the gross `terms.dropped` is recorded beside it. A
 * shaped unit whose seq is host-pruned contributes nothing (the union subtracts
 * a unit once). `depth_k = measured_k − τ(Σ bytes removed at a step < k)`, τ
 * once on the sum, never per term; a net-negative trim ADDS depth. A pruner-off lane never
 * uses that measured series (the host trim shaped it): its depth, triggers and
 * cadence come from the reconstructed surface's own bytes. The plan records no
 * `rereads` field: a literal 0 that measured nothing was deleted, and the report
 * module adds the witness's own count (`planWithRereads`).
 *
 * Two trigger modes. `batch` (default) fires a full lane of `--lanes` eligible
 * results, size-driven, exactly as core's `batchVerdict` decides. `threshold`
 * fires one ask for the whole pending eligible stream each time the lane's
 * chosen unit has moved `--thresholds` since the last fire. `--threshold-units
 * depth-tokens` (the default) measures CURRENT depth: growth by `--thresholds`
 * tokens since the last fire. The FIRST baseline is the first measured step's
 * depth (the first request after the first user message), so the system prompt's
 * constant opening bytes are excluded by construction. `--threshold-semantics
 * incremental` (the depth default, owner ruling 2026-10-31) moves the baseline to
 * the POST-removal depth after every fire — `depth − τ(that fire's own dropped
 * bytes)` — so the next fire needs the whole threshold of fresh growth. `growth`
 * (ruling 2026-10-30) keeps the pre-removal depth, so a fire's own shave R
 * stretches the interval to `threshold + R`; `absolute` also never resets at a
 * host compaction. Incremental and growth BOTH reset the base to the first
 * measured depth at or after the compaction step: the compacted window's depth
 * is the new floor, never a delta against the pre-compaction high-water mark.
 * `--first-fire-depth` (owner ruling 2026-10-31) replaces the first fire's delta
 * test with an absolute depth floor: the first ask waits for `depth >= the
 * value`, then the usual baseline reset and the lane threshold govern every
 * later fire. Unset is today's cadence.
 * `--threshold-units
 * landed-bytes` instead sums the eligible bytes that have LANDED since the last
 * fire: an accumulator, never a depth, so no removal or host prune can lower it
 * and the depth base/reset never applies (a no-op in-segment). Both units fire
 * only with work pending; a crossing over an empty pending stream holds, and
 * the checkpoint only moves on a real fire, so no ask is ever sent with no
 * rows.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_CONFIG, ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR, ENTRY_ASK_MIN_QUOTE_LINES,
  anchorsFor, batchVerdict, floorForModel, landedBytesVerdict as coreLandedBytesVerdict,
  quoteCountOf,
} from "@cremator/core";
import { targetFromInput } from "cremator-dsh/plugin";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";
import { reasoningOf, textOf } from "./gate3-live-chain.mjs";
import {
  ASK_GRAMMARS, ASK_ORDERS, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER, SLOT_GRAMMARS,
  askMessageForRows,
} from "./sim-batch-grammar.mjs";
import { renderLane, renderMoment } from "./sim-render.mjs";

/** The grammar ids and the default, re-exported so one import site names them. */
export { ASK_GRAMMARS, ASK_ORDERS, DEFAULT_ASK_GRAMMAR, DEFAULT_ASK_ORDER };

const HERE = fileURLToPath(new URL(".", import.meta.url));
/**
 * The built core entry this module actually imported, hashed ONCE at module
 * load. `@cremator/core` resolved to this file before this module's body ran, so
 * a present hash is the code that produced every number below; hashing it lazily
 * per call let a concurrent rebuild's delete-and-write window look like an
 * absent build and refuse a run that had loaded it. A tree that never built
 * cannot reach here (the import itself fails), so `null` is only reachable in a
 * unit test that mocks the module — and `buildIdentityOf` refuses it by name.
 */
const CORE_DIST_SHA256 = (() => {
  const file = path.resolve(HERE, "../../packages/core/dist/index.js");
  return existsSync(file) ? fileSha256Of(file) : null;
})();
/** The environment variable that names the default world's root on any device. */
export const EVIDENCE_ROOT_ENV = "CREMATOR_SIM_EVIDENCE";
/**
 * The default world's root: `$CREMATOR_SIM_EVIDENCE` when it is set, otherwise
 * the 2026-10-29 full-rerun vanilla world. The session directory inside it is
 * named after the workspace path the host recorded (`--C-Users-AAAAA-…` on one
 * device, `--C-Users-AA-…` on the other), so the file is FOUND by scanning the
 * evidence tree, never by rebuilding that label.
 */
export const WORLD = process.env[EVIDENCE_ROOT_ENV] !== undefined
  && process.env[EVIDENCE_ROOT_ENV] !== ""
  ? path.resolve(process.env[EVIDENCE_ROOT_ENV])
  : path.resolve(HERE, "../../scratchpad/launch/2026-10-29-full-rerun/worlds/vanilla");

/**
 * The one `session.v4.jsonl` an evidence world carries, found without assuming
 * the host's workspace label. A world with zero or several sessions returns
 * `null`: a default that guesses between recordings is not a pin.
 */
export function sessionFileIn(worldRoot = WORLD) {
  const sessions = path.join(worldRoot, "evidence", "sessions");
  if (!existsSync(sessions)) return null;
  const found = [];
  for (const arm of readdirSync(sessions).sort()) {
    const armDir = path.join(sessions, arm);
    let recordings = [];
    try { recordings = readdirSync(armDir).sort(); } catch { continue; }
    for (const recording of recordings) {
      const file = path.join(armDir, recording, "session.v4.jsonl");
      if (existsSync(file)) found.push(file);
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * The 2026-10-29 full-rerun vanilla world's evidence, the default plan input.
 * It is the a6 session fab6632e: the same task and the same tool header as the
 * pair-2 world, and it carries the agent's reasoning (ADR-0045, ISSUE-195). The
 * path is derived from the world root (`CREMATOR_SIM_EVIDENCE` or the default),
 * so neither device's home (`C:\Users\TZhen\`, `C:\Users\TZ\`) needs an edit; a
 * world with no session file yields the named absence below, and a test that
 * claims the pinned world SKIPS on it through `requirePinnedWorld`, naming the
 * missing paths, instead of failing.
 */
export const DEFAULT_TRANSCRIPT = sessionFileIn(WORLD)
  ?? path.join(WORLD, "evidence", "sessions", "ABSENT-session.v4.jsonl");
export const DEFAULT_USAGE = path.join(WORLD, "evidence", "result.json");
/** The model the sim routes to; `FLOOR_BYTES` and `ROUTE` both read it. */
export const FLOOR_MODEL = "deepseek-flash";
/**
 * The eligibility floor, in bytes: the product's own `floorForModel` answer for
 * the sim's route model, CALLED here rather than copied. `deepseek-flash` is not
 * in the per-model table, so core's default applies (512 today); a table that
 * gains the model changes this number with the product instead of leaving the
 * sim behind. It is not 1280: that is the recorded system prompt's
 * `deepseek-v4.1-flash-1017` row, and the sim's route is `deepseek-flash`.
 */
export const FLOOR_BYTES = floorForModel(FLOOR_MODEL);
/**
 * The batch size the PRODUCT is configured with (`DEFAULT_CONFIG`'s
 * `entryAskBatchSize`, 1 = today's per-result cadence). A sim batch lane at any
 * other size measures a cadence the product does not ship, so it carries a
 * `batch-lane:<n>` reason.
 */
export const PRODUCT_BATCH_SIZE = DEFAULT_CONFIG.entryAskBatchSize;
export const DEFAULT_LANES = 8;
/** The threshold mode's default lanes, in tokens. */
export const DEFAULT_THRESHOLDS = [30_000, 60_000, 120_000];
export const TRIGGER_MODES = ["batch", "threshold"];
/**
 * The measured surface ratio, in bytes per token (design §2.4). Every token
 * number this module records is `ceil(bytes / 3.04)`, never `ceil(bytes / 4)`:
 * /4 understates the provider's count enough to matter at a 400k guard. The
 * pre-send guard divides by 3 instead: 3 B/token is a STRICTER bytes-per-token
 * assumption than the measured 3.04, so the guard's token count is the LARGER
 * (conservative) one. The recorded estimate keeps 3.04.
 */
export const MEASURED_BYTES_PER_TOKEN = 3.04;
/** `ceil(bytes / 3.04)`: the measured-ratio token estimate, recorder only. */
export function measuredTokensOf(bytes) {
  if (!Number.isSafeInteger(bytes)) {
    refuse("sim-batch-bytes-invalid", `a byte count is a safe integer, got ${String(bytes)}`);
  }
  return Math.ceil(bytes / MEASURED_BYTES_PER_TOKEN);
}
/**
 * The fab6632e segment-139 pins (design §1, §2.1). A count that differs refuses
 * the run by name; nothing proceeds on a drifted transcript. The reasoning pins
 * are ADR-0045's check: a replay that loses the agent's reasoning turns (or
 * their bytes) is not evidence, and it fails here by name on every transcript
 * that declares reasoning.
 *
 * The INPUT pins (`transcriptSha256`, `usageSha256`) name the exact two files
 * the numbers came from. A pinned-world claim on any other input refuses: a
 * transcript edited consistently with its counts (a same-length substitution
 * inside the recording) moves both its prompt and its ruler, so only the file
 * hash can tell. These hashes name the FULL private recording, not the
 * sanitized prefix fixtures under `dev/bench/fixtures/sim/`: those stop at
 * steps 80 and 83, before segment 139, so sanitizing them cannot move these
 * pins and they must not be pointed at a prefix.
 *
 * The reasoning fields are counted, never substring-matched:
 * - `reasoningBlocks` / `reasoningBytes`: resendable turns and their raw bytes.
 * - `reasoningTurns`: assistant turns carrying a NON-BLANK `type:"reasoning"`
 *   content part. Equal to `reasoningBlocks` after the unresendable gate.
 * - `reasoningParts`: `type:"reasoning"` CONTENT parts (93, 7 of them blank).
 * - `reasoningStreamBlocks`: `blockType:"reasoning"` STREAM entries (93). The
 *   older 372 was a substring count over `JSON.stringify(row)`: each part
 *   occurs FOUR times in a serialized row (the content part, the replay-state
 *   block, the stream block-start's nested block, and the stream entry's nested
 *   replayState block), so 372 = 4 × 93.
 * - `fileReasoningParts` / `fileReasoningStreamBlocks`: the same two structural
 *   counts over the WHOLE FILE, not the segment cut (271 / 271). They are
 *   pinned too: the README claims the whole-file pair gates, and a count that
 *   exists only in prose is not a gate.
 */
export const SEGMENT_PINS = Object.freeze({
  segment: 139, eligible: 268, appends: 201, replacements: 67,
  prunedOriginals: 67, neverPruned: 134, pruneJournals: 67, shadowedSeqs: 67,
  peakDepth: 315_197, peakStep: 139, headerTools: 19, headerToolBytes: 13_290,
  reasoningBlocks: 86, reasoningBytes: 155_545, reasoningTurns: 86,
  reasoningParts: 93, reasoningStreamBlocks: 93,
  fileReasoningParts: 271, fileReasoningStreamBlocks: 271,
  transcriptSha256: "9fb0584e1bd45ef1526c7942400fbaf82e5a9ca012af4621de170ef85ab8ff0c",
  usageSha256: "bbd79b8087b7aeff7e3e0a3b71d88d2915032e264dbd33f25944c5f969f6cfdb",
});
/**
 * The same segment with the host's prunes ignored. The 67 host trim outputs
 * leave the unit stream, so the 67 replacement rows and their originals' pruned
 * status go with them: only the 201 landing appends remain. The reasoning counts
 * are the transcript's own and do not move. `peakDepth`/`peakStep` are the HOST
 * series, which a pruner-off lane records as contaminated and never triggers on;
 * `surfacePeakDepth`/`surfacePeakStep` are the reconstructed surface's own
 * high-water mark, built from the fire-0 surface with no answer applied. That
 * peak is policy-free: it is the unfiltered surface's size, not a run's peak.
 */
export const IGNORED_SEGMENT_PINS = Object.freeze({
  segment: 139, eligible: 201, appends: 201, replacements: 0,
  prunedOriginals: 0, neverPruned: 201, pruneJournals: 0, shadowedSeqs: 0,
  peakDepth: 315_197, peakStep: 139, headerTools: 19, headerToolBytes: 13_290,
  reasoningBlocks: 86, reasoningBytes: 155_545, reasoningTurns: 86,
  reasoningParts: 93, reasoningStreamBlocks: 93,
  fileReasoningParts: 271, fileReasoningStreamBlocks: 271,
  transcriptSha256: SEGMENT_PINS.transcriptSha256,
  usageSha256: SEGMENT_PINS.usageSha256,
  surfacePeakDepth: 565_538, surfacePeakStep: 138,
});
/**
 * The pre-send guard budget: `ceil(bytes/3)` must stay strictly under this.
 * The measured surface tokenizes at ~3.04 B/token (design §2.4). The guard's
 * 3 B/token is the stricter BYTES-PER-TOKEN assumption (3 < 3.04) and its token
 * count is therefore the larger, looser-in-tokens estimate; that is the bound
 * used before a send, while the recorded estimate uses 3.04
 * (`measuredTokensOf`).
 */
export const PROMPT_TOKEN_LIMIT = 400_000;
/** The conservative pre-send byte divisor (design §2.4). */
export const PROMPT_GUARD_FACTOR = 3;

/**
 * How much of the assistant-turn population must still carry reasoning: a
 * DECLARED floor, not a label. `reasoningTurns / assistantTurns` below it
 * refuses the transcript (`sim-batch-reasoning-coverage`), because a source that
 * lost the field on half its turns is a partial transcript, not a smaller
 * conversation — and every other ADR-0045 count stays equal when the loss is
 * symmetric (parts, blocks and echoes all disappear together).
 *
 * The value: the pinned fab6632e segment-139 world reads 86 / 139 = 0.6187
 * (some assistant turns legitimately carry no reasoning), so 0.55 sits under it
 * and above one-half. A source stripped from half its turns reads 0.5 and
 * refuses.
 */
export const REASONING_TURN_COVERAGE_FLOOR = 0.55;

/** `ceil(bytes / 3)`: the pre-send bound, never the provider's count. */
export function guardTokensOf(bytes) {
  return Math.ceil(bytes / PROMPT_GUARD_FACTOR);
}
/** How a threshold lane measures the distance to the next fire. */
export const THRESHOLD_SEMANTICS = ["incremental", "growth", "absolute"];
/** Owner ruling 2026-10-31: a fire's own removals reset the next baseline. */
export const DEFAULT_THRESHOLD_SEMANTICS = "incremental";
/**
 * What a threshold lane counts between fires. `depth-tokens` is the measured
 * context depth (the 30k/60k lanes); `landed-bytes` is the SUM of eligible
 * units' landed bytes since the last fire — an accumulator that never decreases,
 * so host prunes and the lane's own removals cannot move it. The two units have
 * different failure modes: depth can be held down by an earlier prune, landed
 * bytes cannot.
 */
export const THRESHOLD_UNITS = ["depth-tokens", "landed-bytes"];
export const DEFAULT_THRESHOLD_UNITS = "depth-tokens";
/** The landing-byte probe's threshold (a chosen value, not an optimum). */
export const DEFAULT_BYTE_THRESHOLDS = [240_000];
/** `threshold-60000` for depth, `bytes-240k` for landed bytes. */
export function thresholdLaneName(threshold, thresholdUnits = DEFAULT_THRESHOLD_UNITS) {
  if (thresholdUnits === "landed-bytes") {
    return threshold % 1000 === 0
      ? `bytes-${String(threshold / 1000)}k` : `bytes-${String(threshold)}`;
  }
  return `threshold-${String(threshold)}`;
}
const USAGE = [
  "usage: sim-batch-units.mjs [--transcript <session.v4.jsonl>] [--usage <result.json>]",
  "                           [--segment <lastStep>]",
  "                           [--floor 512] [--lanes 8[,16,...]] [--mode batch|threshold]",
  "                           [--thresholds 30000,60000,120000]",
  "                           [--threshold-units depth-tokens|landed-bytes]",
  "                           [--threshold-semantics incremental|growth|absolute]",
  "                           [--first-fire-depth <tokens>] [--producer stub]",
  "                           [--ask-grammar 3option|two-option|forgetlines|keeplines-60|jsonl-20]",
  "                           [--ask-order first|after|both]",
  "                           [--ignore-host-prunes] [--reconstruction]",
  "                           [--allow-zero-reasoning] [--plan] [--json]",
  "       --transcript  the arm's session.v4.jsonl; its `tool/result` rows are the units",
  "       --usage       a result.json (usage.rows) or a bare {rows}; the measured depth",
  "       --floor       eligibility floor in bytes; default 512, the product's",
  "                     floorForModel answer for the sim's deepseek-flash route,",
  "                     called at load (never a copied constant)",
  "       --segment     last owning step, inclusive; later rows leave the stream and the",
  "                     surface, a compaction-crossing segment refuses by name, and a",
  "                     log carrying compaction/start is REFUSED without a segment",
  "       --lanes       batch size per lane, comma separated; default 8 (batch mode only)",
  "       --mode        batch (a full lane per fire) or threshold (a unit per fire)",
  "       --thresholds  per threshold lane, comma separated; tokens (default",
  "                     30000,60000,120000) for depth-tokens, bytes (default 240000)",
  "                     for landed-bytes; each lane is one threshold, --lanes is unused",
  "       --threshold-units",
  "                     depth-tokens (default) grows the measured depth; landed-bytes",
  "                     sums eligible bytes landed since the last fire (never decreases)",
  "       --threshold-semantics",
  "                     incremental (default) makes a fire's own removals the new",
  "                     baseline, so the next fire needs threshold more growth;",
  "                     growth keeps the pre-removal depth (threshold + R);",
  "                     absolute additionally never resets at a host compaction;",
  "                     depth-tokens only",
  "       --first-fire-depth",
  "                     threshold mode only: the FIRST fire also requires this",
  "                     absolute depth, instead of the lane threshold; later fires",
  "                     use the lane threshold and the normal baseline reset",
  "       --producer    stub (keepall every row) or a module exporting decide({unit})",
  "       --ask-grammar jsonl-20 (shipped, the product default), 3option or two-option",
  "                     (shipped), or a sim variant (forgetlines, keeplines-60);",
  "                     plan mode only records it — it opens no socket",
  "       --ask-order   first (default), after or both: where the teaching block sits",
  "                     relative to the rows; jsonl-20 renders its own table slot and",
  "                     accepts only first; plan mode only records it",
  "       --ignore-host-prunes",
  "                     replay as if the host's own tool-result trim never ran:",
  "                     compaction/prune rows become no removals, their replacement",
  "                     rows leave the unit stream and the surface, and the originals",
  "                     stay whole; the default path treats them as fixed removals",
  "       --reconstruction",
  "                     declare that a pruner-off replay of a recording that itself",
  "                     carries compaction/prune events is a RECONSTRUCTION, not a",
  "                     product measurement; required by the zero-prune gate and",
  "                     recorded on every plan",
  "       --allow-zero-reasoning",
  "                     record a transcript that declares 0 reasoning blocks as a VOID",
  "                     comparison (ADR-0045); without it the run refuses by name, and",
  "                     a transcript with reasoning parts but no resendable block always",
  "                     refuses",
  "       --plan        the only mode this chunk runs; prints the plan, opens no socket",
].join("\n");

export class SimBatchUnitsRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimBatchUnitsRefusal"; this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimBatchUnitsRefusal(code, detail);
}

/** The stub: every row kept, so the plan separates cadence from savings. */
export const STUB_PRODUCER = Object.freeze({
  name: "stub",
  decide: ({ unit }) => ({ momentId: unit.id, action: "keepall" }),
});

/** `stub`, or a module path exporting `decide({unit, index, batchIndex, batch})`. */
export async function loadProducer(spec = "stub") {
  if (spec === null || spec === undefined || spec === "stub") return STUB_PRODUCER;
  const mod = await import(pathToFileURL(path.resolve(spec)).href);
  if (typeof mod.decide !== "function") refuse("sim-batch-producer-invalid", `${spec} exports no decide()`);
  return { name: path.basename(spec), decide: mod.decide };
}

/** One `tool/result` row as a unit the trigger and the renderer both read. */
function unitOf(row, entryStep) {
  // The body is the transcript's DECODED text (`textOf`): the adapter's own
  // `item.bytes` is `TextEncoder().encode(textOf(message.content))`
  // (`plugin.ts:1111`), a re-encoding of text the host already decoded. The
  // substitution is recorded beside every plan and run as `TEXT_SOURCE`, and
  // the two readings differ exactly where a content part is not text.
  const text = textOf(row);
  const stated = Number.isSafeInteger(row.data?.step) ? row.data.step : null;
  const replace = typeof row.surfaceOp === "object" && row.surfaceOp !== null;
  const entry = Number.isSafeInteger(entryStep) ? entryStep : null;
  // The landing step decides cadence. A replacement copies its original's
  // `data.step`, which names the original's step, not when the copy entered:
  // its cadence step is its OWN entry step, so no fire is ever asked about a
  // row that is not in the context and its removal books at entry + 1.
  const cadenceStep = replace ? (entry ?? stated) : (stated ?? entry);
  // P7: `textOf` reads content PARTS. A row that declares its content as a
  // STRING ("the whole body") reads as "" and would become a 0 B row counted
  // `belowFloor` — a result with content looking like no result at all. The
  // declared bytes are recorded so `eligibilityOf` counts the row under its own
  // name instead of the floor's.
  const declared = row.data?.message?.content ?? row.data?.content;
  const declaredBytes = text.length === 0 && typeof declared === "string"
    ? Buffer.byteLength(declared, "utf8") : 0;
  // P7 (thirteenth audit item 3): a body declared as content PARTS with no text
  // at all (an image-only result, say) also reads as 0 B. It has content, so it
  // is not a small body: `eligibilityOf` counts it under `nonTextContent`, and
  // `droppedRowGapsOf` counts the whole-row omission. A part with a `text`
  // string is a text part (`textOf` reads it, even when the string is empty).
  const declaredParts = Array.isArray(declared) ? declared : null;
  const nonTextContent = text.length === 0 && declaredParts !== null
    && declaredParts.some(part => part !== null && typeof part === "object"
      && typeof part.text !== "string");
  // The failure flag is read from WHICHEVER shape carried the content: a row
  // whose parts sit at `data.content` states its `isError` beside them, and
  // reading only `data.message.isError` made a failed result eligible.
  const failed = row.data?.message?.isError ?? row.data?.isError;
  return {
    id: `result:${row.seq}`, seq: row.seq,
    step: cadenceStep, entryStep: entry,
    bytes: Buffer.byteLength(text, "utf8"),
    declaredContentBytes: declaredBytes,
    nonTextContent,
    // "0 errors" is over the eligible stream: the transcript's one error is sub-floor.
    isError: failed === true,
    surfaceOp: replace ? "replace" : "append",
    startSeq: replace ? (row.surfaceOp.startSeq ?? null) : null, text,
  };
}

/**
 * The table row's bracket label, exactly as the product writes it
 * (`plugin.ts` `callLabelOf`, ISSUE-117 chunk B3): the host's tool name and the
 * target it named (`read config.ts`), the name alone when it names no target,
 * and `tool result` when even the name is absent. The target is read by the
 * product's own `targetFromInput`: `grep`/`glob` name `pattern`, every other
 * tool `file_path`/`filePath`/`path`. Nothing here reads the result's text.
 */
export function callLabelOf(name, argumentsInput) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  let input = argumentsInput;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  const record = input !== null && typeof input === "object" && !Array.isArray(input) ? input : null;
  const target = record === null ? null : targetFromInput(trimmed, record)?.key ?? null;
  if (trimmed === "") return target === null ? "tool result" : `tool result ${target}`;
  return target === null || target === "" ? trimmed : `${trimmed} ${target}`;
}

/** `callId → tool name/target`, so a row's `[kind]` slot names the call that made it. */
export function callNamesOf(rows) {
  const byCall = new Map();
  for (const row of rows) {
    if (row?.type === "tool/call" && typeof row.data?.name === "string") {
      byCall.set(row.data.callId ?? row.data.id, {
        name: row.data.name, arguments: row.data.arguments,
      });
    }
  }
  const names = new Map();
  for (const row of rows) {
    if (row?.type !== "tool/result") continue;
    const callId = row.data?.message?.toolCallId ?? row.data?.message?.source?.callId
      ?? row.data?.toolCallId;
    const call = byCall.get(callId);
    names.set(row.seq, callLabelOf(call?.name, call?.arguments));
  }
  return names;
}

/**
 * The transcript's reasoning counts, read STRUCTURALLY from the rows (never by
 * substring over a serialized row):
 *
 * - `parts`: every `type:"reasoning"` CONTENT part, blank ones included;
 * - `turns`: assistant turns carrying at least one NON-BLANK one — the count
 *   `reasoningBlocks` must equal once the unresendable rows are excluded;
 * - `partTurns`: assistant turns carrying ANY reasoning part, blank included.
 *   This is the count the structural echoes below are compared to;
 * - `markedTurns`: assistant turns whose own REPLAY STATE (`replayState.blocks`)
 *   or STREAM (`data.stream`) names a reasoning block, whether or not a content
 *   part survived. A turn that lost its parts whole leaves no `type:"reasoning"`
 *   part and no `reasoningBlocks` entry, but it keeps this echo (P4);
 * - `assistantTurns`: every `assistant/message` row in scope — the population
 *   the reasoning turns live in, recorded so a reader can see the coverage;
 * - `streamBlocks`: every `blockType:"reasoning"` STREAM entry.
 *
 * A substring count over `JSON.stringify(row)` counted each part FOUR times
 * (the content part, the replay-state block, the stream block-start's nested
 * block, and the stream entry's nested replayState block: 372 = 4 × 93 on
 * fab6632e) and counted a body that merely contained the literal. These counts
 * cannot double-count either way.
 */
export function reasoningCountsOf(rows) {
  let parts = 0;
  let turns = 0;
  let partTurns = 0;
  let markedTurns = 0;
  let assistantTurns = 0;
  let streamBlocks = 0;
  for (const row of rows ?? []) {
    const content = Array.isArray(row?.data?.message?.content) ? row.data.message.content
      : Array.isArray(row?.data?.content) ? row.data.content : [];
    const reasoning = content.filter(part => part?.type === "reasoning");
    parts += reasoning.length;
    if (row?.type === "assistant/message") {
      assistantTurns += 1;
      if (reasoning.length > 0) partTurns += 1;
      const replay = row?.data?.message?.source?.replayState?.blocks;
      const stream = Array.isArray(row?.data?.stream) ? row.data.stream : [];
      const marked = (Array.isArray(replay) && replay.some(block => block?.type === "reasoning"))
        || stream.some(entry => entry?.blockType === "reasoning"
          || entry?.chunk?.blockType === "reasoning");
      if (marked) markedTurns += 1;
      if (reasoning.some(part => typeof part.text === "string" && part.text.trim() !== "")) {
        turns += 1;
      }
    }
    for (const entry of Array.isArray(row?.data?.stream) ? row.data.stream : []) {
      if (entry?.blockType === "reasoning" || entry?.chunk?.blockType === "reasoning") {
        streamBlocks += 1;
      }
    }
  }
  return { parts, turns, partTurns, markedTurns, assistantTurns, streamBlocks };
}

/** One file's sha256, hex: the input pin (`SEGMENT_PINS.transcriptSha256`). */
export function fileSha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The two hashes a pinned-world claim names, and the file the usage hash is the
 * hash of. `assertSegmentPins` recomputes `usageFile`'s hash on EVERY segment
 * (P2): a stated usage hash with no file to hash refuses, so a copied string
 * cannot stand in for bytes. The transcript's hash is bound to the bytes the
 * timeline replayed, which is why no transcript path rides here.
 */
export function inputPinsOf({ transcript = DEFAULT_TRANSCRIPT, usage = DEFAULT_USAGE } = {}) {
  return { transcriptSha256: fileSha256Of(transcript), usageSha256: fileSha256Of(usage),
    usageFile: usage };
}

/**
 * WHERE a unit's body comes from, recorded beside every plan and run. Both
 * readings are of the same DECODED text: the adapter builds a result's bytes as
 * `new TextEncoder().encode(textOf(message['content']))` (`plugin.ts:1111`), a
 * re-encoding of text the host's JSON already carried decoded. So the product
 * does NOT read raw capture bytes at this seam and cannot drop a partial UTF-8
 * tail here; a mid-codepoint cut is impossible in a `.v4.jsonl` recording,
 * whose bytes are UTF-8 by construction. What the two readings really differ
 * on is CONTENT PARTS: `textOf` joins the `type:"text"` parts and drops every
 * other part (image, file, tool-call), and a malformed part is dropped rather
 * than read. The substitution is recorded, never hidden: for a body made only
 * of text parts the two readings are the same bytes.
 */
export const TEXT_SOURCE = Object.freeze({
  simulator: "transcript JSON text (textOf: the type:\"text\" parts, joined)",
  product: "TextEncoder().encode(textOf(content)): the same decoded text re-encoded,"
    + " so no partial UTF-8 tail can be dropped at this seam",
  differsWhen: "a content part is not text (image, file, tool-call) or is malformed:"
    + " such a part is dropped here, so the product's line count and quotes can differ"
    + " from this module's only where the body is not made of text parts alone",
});

/**
 * The build that produced a number: the two package versions, the built core
 * entry's hash, and the hash of every sim module this run reached. A run's
 * record then names the code, not only the input.
 *
 * Every field is REFUSED when it cannot be read, never recorded as `null`: a
 * null hash reads like a build stamp while proving nothing. The three modules
 * beside this one are hashed by default (`grammar`, `render`, `gate3`), because
 * a run's ask bytes, render path and transcript reader are as much "the code"
 * as this file; `extraModules` names the live module on the live path.
 */
export function buildIdentityOf(extraModules = {}) {
  const root = path.resolve(HERE, "../..");
  const moduleHash = (name, file) => {
    if (!existsSync(file)) {
      refuse("sim-batch-build-invalid",
        `the build identity names module ${String(name)} at ${file}, which is absent; a`
        + " run may not record a null hash for the code that produced its numbers");
    }
    return fileSha256Of(file);
  };
  const versionOf = relative => {
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      refuse("sim-batch-build-invalid",
        `the build identity cannot read ${relative}: the file is absent`);
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
      refuse("sim-batch-build-invalid",
        `the build identity cannot parse ${relative}: ${String(error?.message ?? error)}`);
    }
    if (typeof parsed?.version !== "string" || parsed.version === "") {
      refuse("sim-batch-build-invalid",
        `the build identity cannot name a version in ${relative}; the field is empty`);
    }
    return parsed.version;
  };
  if (CORE_DIST_SHA256 === null) {
    refuse("sim-batch-build-invalid",
      `the core dist at ${path.join(root, "packages/core/dist/index.js")} was absent when this`
      + " module loaded; a run may not record a null hash for the code that produced its"
      + " numbers. Build it with `npm run build -w @cremator/core`");
  }
  const modules = {
    units: moduleHash("units", fileURLToPath(import.meta.url)),
    grammar: moduleHash("grammar", path.join(HERE, "sim-batch-grammar.mjs")),
    render: moduleHash("render", path.join(HERE, "sim-render.mjs")),
    gate3: moduleHash("gate3", path.join(HERE, "gate3-live-chain.mjs")),
  };
  for (const [name, file] of Object.entries(extraModules)) {
    modules[name] = moduleHash(name, file);
  }
  return {
    node: process.version,
    core: versionOf("packages/core/package.json"),
    adapter: versionOf("packages/adapters/dsh/package.json"),
    coreDistSha256: CORE_DIST_SHA256,
    modules,
  };
}

/**
 * The transcript as a timeline: units, fixed host removals, boundary, session.
 * With `segment`, every row whose owning step (the last `step/start` at or
 * before its seq) exceeds it is dropped from the timeline and the surface; a
 * segment that would include a `compaction/start` or `compaction/end` row is
 * refused by name. The first excluded step is reported, never trimmed silently.
 * A log that carries a `compaction/start` row REFUSES an absent segment by
 * name: the replay never reaches native compaction, so replaying past it is not
 * a world the product ever ran.
 *
 * With `ignoreHostPrunes`, the host's own tool-result trim is taken out of the
 * world: `hostPrunes`, `hostRemoved` and `hostTokens` are empty, and the rows
 * that trim produced — a replacement whose `startSeq` an ignored prune shadows —
 * leave the unit stream and the surface, because with the trim off they never
 * existed and their originals stay whole. The ignored journals' own rows leave
 * the surface too; the counts ride the timeline as `hostPrunesIgnored`,
 * `hostTokensIgnored` and `hostReplacementsIgnored` so a report can state what it
 * skipped. The default path is unchanged.
 *
 * With `reconstruction`, the timeline says that a pruner-off replay of a
 * recording that itself carries prune events is a RECONSTRUCTION of that
 * recording, never a product measurement. `replayedPrunes` is the replayed
 * world's own prune count taken BEFORE `--ignore-host-prunes` removed the rows;
 * that source count and the label are what `assertZeroPruneGate` reads
 * (ADR-0041 Decisions 6 and 7). `inputPruneEvents` is the WHOLE recording's
 * count, kept as provenance for a prune row the segment cut off.
 *
 * ENTRY-ASK EXCHANGE (the host's own ask and its answer). The plugin appends
 * both turns as `user/message` rows whose `source.kind` is
 * `<recordName>/entry-ask` (`plugin.ts` `appendAskTurns`), and the product
 * rewinds that exchange off the surface before the next model turn. Those rows
 * are therefore never on the simulated surface: they are collected into
 * `entryAskSeqs`. A row that carries the ask's own closing anchor but NOT the
 * marker is a recording this module cannot classify; the transcript is refused
 * by name rather than replaying an ask table as if it were conversation.
 *
 * STEP OWNERSHIP. Every host removal and every replacement must be placeable in
 * time, so both refuse by name when no `step/start` owns their row:
 *
 * - a `compaction/prune` row with no owning step used to get `step: null` and
 *   never shadow anything, so the host's removal silently did not apply;
 * - a replacement row with no owning step used to fall back to the original's
 *   stale `data.step`, so the copy could be tabled before it entered.
 */
/**
 * The rows of the ONE text `readTimeline` already read, so the hash and the
 * rows always describe the same bytes. A blank line is skipped; a malformed
 * line refuses by name with its line number, never a partial timeline.
 */
function transcriptRowsOf(text, label) {
  const rows = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      refuse("sim-batch-transcript-invalid",
        `${label} line ${String(index + 1)}: ${error.message}`);
    }
  }
  return rows;
}

export function readTimeline(transcript, { segment = null, ignoreHostPrunes = false,
  reconstruction = false, readBytes = readFileSync } = {}) {
  const fromFile = typeof transcript === "string";
  // ONE read of the file: the bytes are hashed and then decoded/parsed, so the
  // pinned sha256 is the hash of exactly the bytes whose rows this timeline
  // carries. The old path read the file once for rows and again for the hash;
  // a second read could observe a different file and pin one it never replayed
  // (twelfth audit item 7). `readBytes` is the test seam: a test hands back a
  // different buffer on a SECOND call, and the one-call assertion proves the
  // timeline never makes that second read.
  let rows;
  let transcriptSha256 = null;
  if (fromFile) {
    if (typeof readBytes !== "function") {
      refuse("sim-batch-transcript-invalid",
        `readBytes must be a function, got ${String(readBytes)}`);
    }
    const bytes = readBytes(transcript);
    transcriptSha256 = createHash("sha256").update(bytes).digest("hex");
    rows = transcriptRowsOf(bytes.toString("utf8"), transcript);
  } else {
    rows = transcript;
  }
  // The input's own hash rides the timeline only when the caller named a file:
  // it is computed from the bytes this call replayed, so a pinned-world claim
  // compares the hash of the SAME bytes to `SEGMENT_PINS` (`assertSegmentPins`).
  // A row array cannot be named; its timeline carries `null`, and a pinned claim
  // on one REFUSES by name instead of falling back to a caller-supplied hash
  // (`sim-batch-pins-rows-unpinned`). Rows from one file plus the hash of another
  // therefore cannot pass.
  if (!Array.isArray(rows)) refuse("sim-batch-transcript-invalid", "a path or the rows of one");
  if (segment !== null && (!Number.isSafeInteger(segment) || segment < 1)) {
    refuse("sim-batch-segment-invalid", `--segment takes a positive step, got ${String(segment)}`);
  }
  if (typeof ignoreHostPrunes !== "boolean") {
    refuse("sim-batch-ignore-host-prunes-invalid",
      `ignoreHostPrunes is a boolean, got ${String(ignoreHostPrunes)}`);
  }
  if (typeof reconstruction !== "boolean") {
    refuse("sim-batch-reconstruction-invalid",
      `reconstruction is a boolean, got ${String(reconstruction)}`);
  }
  // ADR-0003 §5 and the README's own rule: the replay never reaches native
  // compaction. A log that opened one cannot be cut by "the last step" alone.
  if (segment === null && rows.some(row => row?.type === "compaction/start")) {
    refuse("sim-batch-segment-required",
      "the transcript carries a compaction/start row; --segment <lastStep> is mandatory"
      + " because the replay never reaches native compaction");
  }
  const starts = rows.filter(row => row?.type === "step/start" && Number.isSafeInteger(row.data?.step))
    .map(row => ({ seq: row.seq, step: row.data.step })).sort((left, right) => left.seq - right.seq);
  const stepAtSeq = seq => {
    let step = null;
    for (const entry of starts) { if (entry.seq > seq) break; step = entry.step; }
    return step;
  };
  let scoped = rows;
  let firstExcludedStep = null;
  /** Rows the segment cut removed, counted so the run can name the cut. */
  let excludedRows = 0;
  const owningOf = row => (Number.isSafeInteger(row?.seq) ? stepAtSeq(row.seq) : null);
  if (segment !== null) {
    scoped = [];
    const excluded = [];
    for (const row of rows) {
      const owning = owningOf(row);
      const stated = Number.isSafeInteger(row.data?.step) ? row.data.step : null;
      const at = owning ?? stated;
      if (at === null || at <= segment) scoped.push(row);
      else excluded.push(at);
    }
    // "First excluded step" is the smallest step the segment cut removes, not
    // the first row in file order: the session row carries no seq and sits last.
    firstExcludedStep = excluded.length === 0 ? null : Math.min(...excluded);
    excludedRows = excluded.length;
    const crossing = scoped.find(row =>
      row?.type === "compaction/start" || row?.type === "compaction/end");
    if (crossing !== undefined) {
      refuse("sim-batch-segment-compaction",
        `segment ${String(segment)} includes the ${crossing.type} at seq ${String(crossing.seq)};`
        + " the replay never reaches native compaction");
    }
  }
  // Thirteenth audit item 4: a seq is a row's identity. Two rows with one seq
  // share a surface key (`result:<seq>`), a `callNames` entry and an
  // `entrySteps` slot; the rebuild keeps the last one, so a run could be green
  // over a merged unit. Refuse the transcript by name instead.
  const seqOwners = new Map();
  for (const row of scoped) {
    if (!Number.isSafeInteger(row?.seq)) continue;
    const prior = seqOwners.get(row.seq);
    if (prior !== undefined) {
      refuse("sim-batch-transcript-duplicate-seq",
        `seq ${String(row.seq)} appears on a ${String(prior.type)} row and again on a`
        + ` ${String(row.type)} row; each seq names one row, and a merged unit would`
        + " share one surface key with the last row silently winning");
    }
    seqOwners.set(row.seq, row);
  }
  const entrySteps = new Map();
  const units = [];
  // Journaled at compaction time: the row's position, not the shadowed unit's.
  const journaled = scoped.filter(row => row?.type === "compaction/prune").map(row => {
    // A prune's own seq is its position, not a step: only the last `step/start`
    // at or before it can place when the host removed what it names. Without
    // one, `step: null` never shadowed and the removal silently did not apply.
    const step = stepAtSeq(row.seq);
    if (!Number.isSafeInteger(step)) {
      refuse("sim-batch-prune-step-absent",
        `the compaction/prune at seq ${String(row.seq)} has no owning step/start; the host's`
        + " removal cannot be placed in time, and a null step would never shadow the seqs it"
        + " names");
    }
    // Fourteenth audit item 4: a seq is an integer row identity. A string entry
    // (`"7"`) is not a Map key match for seq 7, so it would shadow NOTHING while
    // the prune journal still counted as one — the removal would silently not
    // apply. A present non-array has the same effect. Both refuse by name.
    const declaredShadowed = row.data?.shadowedSeqs;
    if (declaredShadowed !== undefined && declaredShadowed !== null
      && !Array.isArray(declaredShadowed)) {
      refuse("sim-batch-shadowed-seq-invalid",
        `the compaction/prune at seq ${String(row.seq)} carries shadowedSeqs as`
        + ` ${typeof declaredShadowed}, not an array; it names no row and the removal`
        + " would silently not apply");
    }
    const seqs = declaredShadowed ?? [];
    const invalidAt = seqs.findIndex(seq => !Number.isSafeInteger(seq));
    if (invalidAt !== -1) {
      refuse("sim-batch-shadowed-seq-invalid",
        `the compaction/prune at seq ${String(row.seq)} names shadowed seq`
        + ` ${JSON.stringify(seqs[invalidAt])} (${typeof seqs[invalidAt]}) at entry`
        + ` ${String(invalidAt)}; every entry is a row's integer seq, and a non-integer`
        + " entry shadows nothing while the journal still counts as a prune");
    }
    return {
      id: `prune:${row.seq}`, seq: row.seq, step,
      seqs: [...seqs],
      tokens: Number.isSafeInteger(row.data?.shadowedTokenCount) ? row.data.shadowedTokenCount : 0,
    };
  }).sort((left, right) => left.seq - right.seq);
  const ignoredSeqs = new Set(journaled.flatMap(prune => prune.seqs));
  let hostReplacementsIgnored = 0;
  if (ignoreHostPrunes) {
    // A replacement row whose original an ignored prune shadows is that prune's
    // own output: with the trim off it never appeared. Its original stays.
    scoped = scoped.filter(row => {
      if (row?.type === "compaction/prune") return false;
      if (row?.type !== "tool/result" || typeof row.surfaceOp !== "object" || row.surfaceOp === null) {
        return true;
      }
      const hostTrimmed = Number.isSafeInteger(row.surfaceOp.startSeq)
        && ignoredSeqs.has(row.surfaceOp.startSeq);
      if (hostTrimmed) hostReplacementsIgnored += 1;
      return !hostTrimmed;
    });
  }
  for (const row of scoped) {
    if (!Number.isSafeInteger(row?.seq)) continue;
    const owning = owningOf(row);
    // A row before the first `step/start` uses its own stated `data.step` when
    // it has one (synthetic lanes record no boundary); with neither it landed
    // before step 1, and step 0 says "already there when the first request was
    // built", which is what the surface and the depth series need.
    entrySteps.set(row.seq, owning
      ?? (Number.isSafeInteger(row.data?.step) ? row.data.step : 0));
    if (row.type === "tool/result") {
      // A REPLACEMENT exists only from the step its own row entered. Its
      // `data.step` is the ORIGINAL's stale step, so falling back to it would
      // table the copy at a step before it entered the context.
      const replace = typeof row.surfaceOp === "object" && row.surfaceOp !== null;
      if (replace && !Number.isSafeInteger(owning)) {
        refuse("sim-batch-replacement-step-absent",
          `the replacement at seq ${String(row.seq)} has no owning step/start; its`
          + " `data.step` names the original's stale step, so a fallback would place the"
          + " copy before it entered the context");
      }
      units.push(unitOf(row, owning));
    }
  }
  units.sort((left, right) => left.seq - right.seq);
  // ADR-0045's two counts: the assistant turns whose reasoning is RESENDABLE
  // (a signature the wire names) and the raw byte length of that text. They ride
  // the timeline so `surfacePinsOf` can pin them beside the unit counts; a
  // session that lost its reasoning shows 0 and 0 and fails by name.
  let reasoningBlocks = 0;
  let reasoningBytes = 0;
  // ISSUE-195's partial-loss count: assistant turns that STORE reasoning text
  // but whose replay state is misaligned or names a signature the wire cannot
  // resend. `reasoningOf` contributes nothing for them, so without this count a
  // transcript that lost half its reasoning still passes on the half it kept.
  let reasoningUnresendableRows = 0;
  // ISSUE-195's own two counts, over the same scoped rows: every
  // `type:"reasoning"` CONTENT part and every `blockType:"reasoning"` STREAM
  // entry, whether or not the block is resendable. They are the record's
  // provenance, never the surface's count. Both are read STRUCTURALLY: a
  // substring count counted each part FOUR times (the content part, the
  // replay-state block, the stream block-start's nested block, and the stream
  // entry's nested replayState block) and a body that merely contained the
  // literal.
  const { parts: reasoningParts, turns: reasoningTurns, partTurns: reasoningPartTurns,
    markedTurns: reasoningMarkedTurns, assistantTurns,
    streamBlocks: reasoningStreamBlocks } = reasoningCountsOf(scoped);
  // The WHOLE FILE's two structural counts, taken before any segment cut. The
  // README states 271 content parts / 271 stream entries for the file and the
  // segment's 93 / 93; both pairs are pinned, so neither claim is prose only.
  const fileReasoning = reasoningCountsOf(rows);
  // The host's own ask exchange: marked by the plugin, never replayed.
  const entryAskSeqs = new Set();
  const unlabeledAsks = [];
  for (const row of scoped) {
    if (row?.type === "user/message") {
      const kind = row.data?.source?.kind;
      const marked = typeof kind === "string" && kind.endsWith("/entry-ask");
      const text = textOf(row);
      const shaped = text.includes(ENTRY_ASK_CLOSING_LINE) || text.includes(ENTRY_ASK_END_ANCHOR);
      if (marked) entryAskSeqs.add(row.seq);
      else if (shaped) unlabeledAsks.push(row.seq);
    }
    if (row?.type !== "assistant/message") continue;
    const reasoning = reasoningOf(row);
    if (reasoning.text.length === 0) continue;
    if (!reasoning.resendable) {
      // A turn that said something the replay cannot put back is a LOST turn,
      // never a smaller transcript (ISSUE-195, ADR-0045).
      reasoningUnresendableRows += 1;
      continue;
    }
    reasoningBlocks += 1;
    reasoningBytes += Buffer.byteLength(reasoning.text, "utf8");
  }
  if (unlabeledAsks.length > 0) {
    refuse("sim-batch-entry-ask-unlabeled",
      `user/message seq ${unlabeledAsks.slice(0, 4).join(", ")} carries the entry ask's closing`
      + " anchor without the plugin's source.kind marker (`<recordName>/entry-ask`); the"
      + " transcript cannot say whether that exchange was rewound, so it is refused rather"
      + " than replayed as conversation");
  }
  const hostPrunes = ignoreHostPrunes ? [] : journaled;
  // The prune rows the SOURCE world carries, taken BEFORE `--ignore-host-prunes`
  // filtered them out. After that filter the replayed world carries none by
  // construction (the same predicate removed them), so a gate that counts the
  // filtered rows is structurally zero and can never fail. This count is the
  // one ADR-0041 Decision 6 reads: a pruner-off replay of a world that carries
  // prunes is a reconstruction of it, never a product measurement.
  const replayedPrunes = journaled.length;
  const compactionRow = scoped.find(row => row?.type === "compaction/start") ?? null;
  const sessionRow = scoped.find(row => row?.type === "session") ?? null;
  // P2: the tools come from the FIRST `request/header` in scope, and the seq is
  // recorded. `find` returning nothing used to give `tools = []` with no field
  // and no reason, so a run whose recording carried no header measured a prompt
  // with no tool schema and said nothing about it. The absence is now stated
  // (`toolsHeaderSeq: null`) and named by `citableReasonsOf` (`tools-absent`).
  const headerRow = scoped.find(row => row?.type === "request/header") ?? null;
  const rawTools = Array.isArray(headerRow?.data?.header?.tools) ? headerRow.data.header.tools : [];
  const tools = rawTools.map(tool => ({ type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const systemRow = scoped.find(row => row?.type === "system/message");
  // Twelfth audit item 4: a missing or unreadable system row used to become an
  // empty system slot with NO reason, and `droppedRowGapsOf` never looked at
  // `system/message`. Both are named on the timeline, so `citableReasonsOf`
  // cannot let a run read clean while its first message is empty.
  const systemText = systemRow === undefined ? "" : textOf(systemRow);
  const systemAbsent = systemRow === undefined;
  const systemUnreadable = systemRow !== undefined && systemText.length === 0;
  return {
    units, hostPrunes, rows: scoped, segment, firstExcludedStep, excludedRows, entrySteps,
    // The file's own row count, before the segment cut, so a reader reports the
    // input's size without a second read of the file.
    fileRows: rows.length,
    // The recording's own step boundaries, BEFORE any segment cut: the ruler a
    // usage series is pinned to (`assertUsageStepsPinned`).
    stepStarts: starts.map(entry => entry.step),
    callNames: callNamesOf(scoped),
    system: systemText,
    systemAbsent, systemUnreadable,
    tools, headerTools: tools.length,
    headerToolBytes: Buffer.byteLength(JSON.stringify(rawTools), "utf8"),
    // P2: which `request/header` the tools came from, or `null` when the scoped
    // recording carries none. A reader can tell an empty schema from an absent
    // header without re-reading the recording.
    toolsHeaderSeq: headerRow === null ? null
      : (Number.isSafeInteger(headerRow.seq) ? headerRow.seq : null),
    hostRemoved: new Set(hostPrunes.flatMap(prune => prune.seqs)),
    hostTokens: hostPrunes.reduce((sum, prune) => sum + prune.tokens, 0),
    ignoreHostPrunes,
    hostPrunesIgnored: ignoreHostPrunes ? journaled.length : 0,
    hostTokensIgnored: ignoreHostPrunes
      ? journaled.reduce((sum, prune) => sum + prune.tokens, 0) : 0,
    hostReplacementsIgnored,
    compaction: compactionRow === null ? null
      : { seq: compactionRow.seq, step: stepAtSeq(compactionRow.seq) },
    session: sessionRow?.id ?? null,
    reasoningBlocks, reasoningBytes, reasoningParts, reasoningStreamBlocks,
    reasoningTurns, reasoningPartTurns, reasoningMarkedTurns, assistantTurns,
    fileReasoningParts: fileReasoning.parts,
    fileReasoningStreamBlocks: fileReasoning.streamBlocks,
    reasoningUnresendableRows,
    transcriptSha256,
    entryAskSeqs, entryAskRows: entryAskSeqs.size,
    // ADR-0041 D6's gate reads BOTH: the replay must carry zero events, and the
    // RAW recording's count is kept here BEFORE any filtering, so a pruner-off
    // replay of a recording that carries prunes is refused as a product
    // measurement unless `reconstruction` says so (a pruner-on recording
    // reconstructed, never a product measure).
    inputPruneEvents: rows.filter(row => row?.type === "compaction/prune").length,
    replayedPrunes,
    reconstruction: reconstruction === true,
  };
}

/**
 * The units the batch trigger sees: a readable body, at or over the floor, not
 * an error, and tableable — a row the product will actually show. ADR-0042
 * Decision 5 gates admission on `factsShowTwoQuotes`: a body whose anchors
 * cannot fill two quote lines is never asked, so it is never a removal
 * candidate either. It stays on the surface whole, which is what the product
 * does with it.
 *
 * The product's own admission has TWO gates before `entryAskable` ever runs:
 * `plugin.ts`'s `observe` drops a failed result (fed by `toolResultItem`, which
 * reads `isError` at `:1090-1094,1114`; `observe` journals `skip` with reason
 * `failed-result` and returns null at `:1766,1831`) before it reaches the entry
 * seam, and
 * `entryAskable` then reads the floor, the already-judged set and the quote rule.
 * The sim's `!unit.isError` is therefore the SAME population rule, not a sim-only
 * exclusion (P9): its count is recorded beside the floor by `eligibilityOf` so a
 * run's eligible population can be reproduced, and it is not a citation reason.
 *
 * P7: a row that DECLARES content but reads as no text (`textOf` reads content
 * parts, not a string body) is excluded under its own name, never counted as a
 * sub-floor row: its 0 B length is a reading failure, not a small body. That
 * covers both a STRING body (`unreadableContent`) and a PARTS body with no text
 * part at all (`nonTextContent`, thirteenth audit item 3).
 */
export const ELIGIBILITY_RULE = "readable text && bytes >= floor && !isError"
  + " && !nonTextContent && factsShowTwoQuotes";
export function eligibleOf(timeline, floor = FLOOR_BYTES) {
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid", `a floor is a non-negative integer, got ${String(floor)}`);
  }
  return timeline.units.filter(unit => (unit.declaredContentBytes ?? 0) === 0
    && unit.nonTextContent !== true
    && unit.bytes >= floor && !unit.isError
    && factsShowTwoQuotes(factsOf(unit.text)));
}

/**
 * The eligible population AND the rule that produced it, in the shape every
 * send record and summary carries: the floor, the rule, and the rows each
 * failing test excluded. A unit is counted under its FIRST failing reason
 * (`unreadableContent`, then `nonTextContent`, then `belowFloor`, then
 * `errorResult`, then `noTwoQuotes`), so the five counts plus `eligible`
 * partition the timeline's units exactly once. `errorResult` is the SAME rule
 * the product applies before the entry seam (`plugin.ts`'s `observe` skips a
 * failed result with a `failed-result` journal, fed by `toolResultItem`'s
 * `isError`), so it is a population split, never a citation reason (P9).
 * `unreadableContent` is P7's named bucket: the row declared a non-empty STRING
 * content, which `textOf` does not read, so its body is unknown rather than
 * empty. `nonTextContent` is the parts-body case: an image-only result declares
 * content but no text part, so its 0 B is a lost body, not a small one.
 */
export function eligibilityOf(timeline, floor = FLOOR_BYTES) {
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid", `a floor is a non-negative integer, got ${String(floor)}`);
  }
  const excluded = { unreadableContent: 0, nonTextContent: 0, belowFloor: 0,
    errorResult: 0, noTwoQuotes: 0 };
  let eligible = 0;
  for (const unit of timeline.units ?? []) {
    if ((unit.declaredContentBytes ?? 0) > 0) { excluded.unreadableContent += 1; continue; }
    if (unit.nonTextContent === true) { excluded.nonTextContent += 1; continue; }
    if (unit.bytes < floor) { excluded.belowFloor += 1; continue; }
    if (unit.isError) { excluded.errorResult += 1; continue; }
    if (!factsShowTwoQuotes(factsOf(unit.text))) { excluded.noTwoQuotes += 1; continue; }
    eligible += 1;
  }
  return { floor, rule: ELIGIBILITY_RULE, eligible, excluded };
}

/**
 * The units a FIRE can table: eligible, and on the surface AT THAT FIRE. A host
 * prune is a permanent removal but it takes effect at the prune journal's own
 * step: a unit the host removes at step 100 WAS on the surface at a fire at
 * step 10 and is tabled there. Only a unit the host removed STRICTLY BEFORE its
 * own landing step is never askable: `hostRemovedAt` compares with `<`, because
 * the fire on a prune's own step runs before that prune. A unit pruned ON its
 * landing step is therefore askable there. `hostRemoved` (every seq any prune
 * names) is a population fact, never the ask filter.
 */
export function askableOf(timeline, floor = FLOOR_BYTES) {
  return eligibleOf(timeline, floor)
    .filter(unit => !hostRemovedAt(timeline, unit.step).has(unit.seq))
    .sort((left, right) => (left.step - right.step) || (left.seq - right.seq));
}

/** The units on the surface at one fire: the candidate stream minus the seqs a
 * host prune had removed by `fireStep`. */
export function askableAt(timeline, units, fireStep) {
  const removed = hostRemovedAt(timeline, fireStep);
  return (units ?? []).filter(unit => !removed.has(unit.seq));
}

/** The step at which the host first removed `seq`, or null when it never did. */
export function hostPruneStepOf(timeline, seq) {
  let at = null;
  for (const prune of timeline?.hostPrunes ?? []) {
    if (!Array.isArray(prune.seqs) || !prune.seqs.includes(seq)) continue;
    if (prune.step === null) continue;
    if (at === null || prune.step < at) at = prune.step;
  }
  return at;
}

/**
 * The ask-stream counts a record carries beside `hostPrunedEligible`:
 * - `hostPrunedEligible`: eligible units ANY host prune names in the segment;
 * - `hostPrunedBeforeLanding`: of those, the ones the host removed STRICTLY
 *   before their own landing step (never on the surface; a prune on the landing
 *   step itself takes effect after that step's fire, so the row is askable);
 * - `askableBeforePrune`: of those, the ones that WERE on the surface before the
 *   prune, so an early fire may table them and a shape applied before the prune
 *   is the policy's own removal.
 */
export function askableCountsOf(timeline, eligibleUnits, askableUnits) {
  const askable = new Set((askableUnits ?? []).map(unit => unit.seq));
  let hostPrunedEligible = 0;
  let askableBeforePrune = 0;
  for (const unit of eligibleUnits ?? []) {
    if (hostPruneStepOf(timeline, unit.seq) === null) continue;
    hostPrunedEligible += 1;
    if (askable.has(unit.seq)) askableBeforePrune += 1;
  }
  return { hostPrunedEligible, askableBeforePrune,
    hostPrunedBeforeLanding: hostPrunedEligible - askableBeforePrune };
}

/**
 * An eligible count SPLIT so its parts are never added twice: the appends (the
 * originals that landed) are one group, the replacements (the host's copies of
 * pruned originals) another. `prunedOriginals` is a SUBSET of `appends`, so
 * `appends + prunedOriginals` double-counts; `appends + replacements` is the
 * total, and `neverPruned + prunedOriginals` is the append group. Print and
 * record this object, never a bare total.
 */
export function eligibleSplitOf(timeline, units) {
  const appends = units.filter(unit => unit.surfaceOp === "append");
  const replacements = units.filter(unit => unit.surfaceOp === "replace");
  const shadowed = timeline.hostRemoved ?? new Set();
  const prunedOriginals = appends.filter(unit => shadowed.has(unit.seq)).length;
  return { total: units.length, appends: appends.length, replacements: replacements.length,
    prunedOriginals, neverPruned: appends.length - prunedOriginals };
}

/** A `tool/call` as the assistant projection the surface states (design §2.2). */
export function projectionOf(row) {
  const name = typeof row.data?.name === "string" ? row.data.name : "tool";
  let args = row.data?.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* the raw string is the target */ }
  }
  const target = args !== null && typeof args === "object"
    ? (typeof args.path === "string" ? args.path
      : typeof args.command === "string" ? args.command : JSON.stringify(args))
    : String(args ?? "");
  return `Tool call: ${name}\n${target}`;
}

/**
 * The sim surface's own identity. A run holds ONE surface across its fires, so
 * the Map carries the fire it is built for and the number of shaped turns it has
 * applied. `simulateSurface()` stamps a surface at fire 0; `applyFireToSurface`
 * advances it after each fire. `surfaceAt` refuses a surface presented for the
 * wrong fire (a fresh `new Map()` at fire > 0, or an index that regresses), so an
 * empty map at every fire can no longer reproduce the historic failure with
 * every gate green. A test that deliberately builds a raw or out-of-order
 * surface passes `simulateSurface({ testOnly: true })`: the documented
 * test-only constructor.
 */
const SURFACE_FIRE = Symbol("racoons.sim.surface.fire");
/**
 * How many shaped turns this surface has EVER applied, cumulative. It is not a
 * size: a restore lowers the surface's current size without lowering this
 * count. `surfaceSizeOf` is the current-size accessor; the two are never
 * compared to each other or used under one name.
 */
const SURFACE_SHAPES_EVER_APPLIED = Symbol("racoons.sim.surface.shapesEverApplied");
const SURFACE_TEST_ONLY = Symbol("racoons.sim.surface.testOnly");

/** A surface stamped for one fire: the live path's own constructor. */
export function simulateSurface({ fireIndex = 0, testOnly = false } = {}) {
  if (!Number.isSafeInteger(fireIndex) || fireIndex < 0) {
    refuse("sim-batch-surface-invalid",
      `a surface's fire index is a non-negative integer, got ${String(fireIndex)}`);
  }
  const surface = new Map();
  Object.defineProperties(surface, {
    [SURFACE_FIRE]: { value: fireIndex, writable: true, enumerable: false, configurable: false },
    [SURFACE_SHAPES_EVER_APPLIED]: { value: 0, writable: true, enumerable: false,
      configurable: false },
    [SURFACE_TEST_ONLY]: { value: testOnly === true, writable: false, enumerable: false,
      configurable: false },
  });
  return surface;
}

/** The fire a stamped surface is built for, or null for a plain `Map`. */
export function surfaceFireOf(surface) {
  return typeof surface?.[SURFACE_FIRE] === "number" ? surface[SURFACE_FIRE] : null;
}

/**
 * Advance a stamped surface one fire without re-rendering anything. The plan
 * path applies shaped rows in decision-step order, so each step that shaped at
 * least one row is one fire of its own reconstruction.
 */
function advanceSurfaceFire(surface) {
  if (typeof surface?.[SURFACE_FIRE] === "number") surface[SURFACE_FIRE] += 1;
}

/**
 * How many shaped turns that surface has EVER applied (0 for a plain Map).
 * Cumulative by definition: a restore lowers `surfaceSizeOf` but never this.
 */
export function surfaceShapesEverAppliedOf(surface) {
  return Number.isSafeInteger(surface?.[SURFACE_SHAPES_EVER_APPLIED])
    ? surface[SURFACE_SHAPES_EVER_APPLIED] : 0;
}

/** How many shaped turns the surface CURRENTLY holds (its map size). */
export function surfaceSizeOf(surface) {
  if (!(surface instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `a simulated surface is a Map of unit seq to text, got ${String(surface)}`);
  }
  return surface.size;
}

/**
 * The CONTENT identity of a surface: every `(seq, text)` pair in seq order,
 * hashed once. A shaped COUNT alone cannot tell two different surfaces apart —
 * `simulateSurface({fireIndex: n})` with the same number of different bodies
 * passed the count check — so the live gate compares this digest beside the
 * count. Only the map's own entries are read; the stamp symbols are not part of
 * what a prompt carries.
 */
export function surfaceDigestOf(surface) {
  if (!(surface instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `a simulated surface is a Map of unit seq to text, got ${String(surface)}`);
  }
  const entries = [...surface.entries()]
    .filter(([seq, text]) => Number.isSafeInteger(seq) && typeof text === "string")
    .sort((left, right) => left[0] - right[0]);
  return sha256OfText(JSON.stringify(entries));
}

/**
 * Refuse a surface that does not belong to the fire being built. The fire index
 * is REQUIRED on every path that reads a surface: a caller that states no fire
 * could read a later fire's surface as fire 0 and the identity check would never
 * run. A plain Map is legal only at fire 0 (a run with no earlier fire and no
 * removals); a stamped surface must name exactly this fire. `testOnly` bypasses
 * the identity check and is the documented way to build a deliberately raw or
 * out-of-order surface.
 */
function assertSurfaceIdentity({ surface, fireIndex }) {
  if (!Number.isSafeInteger(fireIndex) || fireIndex < 0) {
    refuse("sim-batch-fire-invalid",
      `a fire index is a non-negative integer, got ${String(fireIndex)}; every surface`
      + " read names the fire it is read for");
  }
  if (surface[SURFACE_TEST_ONLY] === true) return;
  const stamped = surfaceFireOf(surface);
  if (stamped === null) {
    if (fireIndex > 0) {
      refuse("sim-batch-surface-identity",
        `a fresh unstamped surface cannot build fire ${String(fireIndex)}; a run holds one`
        + " surface across its fires (pass simulateSurface() at fire 0), so an empty map"
        + " cannot silently drop the removals earlier fires applied");
    }
    return;
  }
  if (stamped !== fireIndex) {
    refuse("sim-batch-surface-identity",
      stamped > fireIndex
        ? `the surface is stamped for fire ${String(stamped)} but this is fire`
          + ` ${String(fireIndex)}: an index regression is refused`
        : `the surface is stamped for fire ${String(stamped)} but this is fire`
          + ` ${String(fireIndex)}: the surface was not advanced by the earlier fires`);
  }
}

/**
 * The seqs the HOST had removed by a fire: every `compaction/prune` whose own
 * owning step is STRICTLY BEFORE `fireStep`, over the seqs it names. One
 * definition for the surface (`surfaceAt`) and for the live carry set, so a
 * unit that becomes host-removed at a fire cannot stay on the policy's carried
 * list.
 *
 * The comparison is strict because the product's order inside one step is
 * fixed: the entry ask runs AFTER every queued result has landed and BEFORE the
 * at-rest pass and the prune see the step (`plugin.ts:2144-2145`). A fire
 * landing on a prune's own step is therefore composed while the row is still on
 * the surface — it is tabled there and dropped from the next prompt. Treating
 * `pruneStep === fireStep` as already applied skipped a row the host would
 * still have tabled.
 *
 * A prune with no owning step was refused by `readTimeline`; `null` here would
 * mean "never", which is the silent-removal defect that check removed.
 */
export function hostRemovedAt(timeline, fireStep) {
  if (!Number.isSafeInteger(fireStep)) {
    refuse("sim-batch-fire-invalid", `a fire step is an integer, got ${String(fireStep)}`);
  }
  const removed = new Set();
  for (const prune of timeline?.hostPrunes ?? []) {
    if (prune.step !== null && prune.step < fireStep) {
      for (const seq of prune.seqs) removed.add(seq);
    }
  }
  return removed;
}

/**
 * The time-aware surface at one fire (design §2.1). A row is on the surface when
 * its owning step is at or before the fire. A `tool/result` — append OR
 * replacement — leaves when a prune journal whose own owning step is at or
 * before the fire names its OWN seq; a replacement row enters at its own owning
 * step. Both halves of that rule matter: an append shadowed by a later prune
 * left, and a replacement the host pruned in turn left too (its own seq is in a
 * later journal). Nothing is trimmed.
 *
 * `surface` is REQUIRED (ISSUE-194): a `Map` from a unit's seq to the text its
 * tool turn holds now, as `applyFireToSurface` leaves it. A seq in the map
 * replaces that result's own text inside the same `call:` turn, so a forgotten
 * unit's original body is not in the prompt; a seq absent from the map is the
 * transcript's landed text. A run with no answers yet passes
 * `simulateSurface()` (fire 0); a missing or non-Map surface refuses by name, so
 * no path can silently mean "the raw recording". `fireIndex` is REQUIRED too:
 * the surface must be stamped for exactly that fire, a fresh `new Map()` at
 * fire > 0 and an index regression both refuse, and an absent index refuses by
 * name rather than skipping the check.
 *
 * The host's own entry-ask exchange is never on the surface: the product
 * rewinds it before the next model turn (`plugin.ts` `rewindAskExchange`), and
 * `readTimeline` collected the rows the plugin marked with
 * `source.kind = "<recordName>/entry-ask"` into `entryAskSeqs`. A transcript
 * that carries an ask-shaped row without that marker was already refused.
 *
 * An `assistant/message` carries its reasoning (ADR-0045) beside its text: the
 * turn is on the surface when EITHER has bytes, and its `reasoning` field holds
 * the resendable text (`reasoningOf`). Only the `tool/result` branch reads
 * `surface` — a result's rewrite can never touch the assistant turn that called
 * it, so its reasoning stays byte-identical across every fire.
 */
export function surfaceAt({ timeline, fireStep, surface, fireIndex }) {
  if (!Number.isSafeInteger(fireStep)) {
    refuse("sim-batch-fire-invalid", `a fire step is an integer, got ${String(fireStep)}`);
  }
  if (surface === undefined || surface === null) {
    refuse("sim-batch-surface-required",
      "a simulated surface is required: pass simulateSurface() when the run has no answers"
      + " yet; an absent surface would silently mean the raw recording");
  }
  if (!(surface instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `a simulated surface is a Map of unit seq to text, got ${String(surface)}`);
  }
  assertSurfaceIdentity({ surface, fireIndex });
  const shadowed = hostRemovedAt(timeline, fireStep);
  const entryAskSeqs = timeline.entryAskSeqs ?? new Set();
  const rows = [];
  for (const row of timeline.rows ?? []) {
    // A row's owning step is the last `step/start` at or before it; a row that
    // states its own `data.step` (every tool call and result does) supplies it
    // when the recording has no step boundary, as the synthetic lanes do.
    const entry = timeline.entrySteps?.get(row.seq)
      ?? (Number.isSafeInteger(row.data?.step) ? row.data.step : null);
    if (entry === null) {
      // P8: a text-bearing message with no owning step cannot be placed at any
      // fire. It used to be skipped silently, and `droppedRowGapsOf` did not
      // count it because it carries text — so a user or assistant turn simply
      // vanished from every prompt. A row that declares content but reads as no
      // text and no reasoning is a row-gap (`droppedRowGapsOf`), not this case.
      const reasoning = row.type === "assistant/message" ? reasoningOf(row) : null;
      const carriesText = (row.type === "user/message" || row.type === "assistant/message")
        && (textOf(row).length > 0 || (reasoning !== null && reasoning.text.length > 0));
      if (carriesText) {
        refuse("sim-batch-row-unplaced",
          `the ${row.type} at seq ${String(row.seq)} carries ${String(
            Buffer.byteLength(textOf(row), "utf8"))} B of text but no owning step/start and no`
          + " `data.step`; the surface cannot place it at a fire, and dropping it would let a"
          + " whole turn vanish from every prompt without a reason");
      }
      continue;
    }
    if (entry > fireStep) continue;
    if (entryAskSeqs.has(row.seq)) continue;
    if (row.type === "user/message" || row.type === "assistant/message") {
      const text = textOf(row);
      const reasoning = row.type === "assistant/message" ? reasoningOf(row) : null;
      const reasoningText = reasoning?.resendable === true ? reasoning.text : "";
      if (text.length === 0 && (reasoning === null || reasoning.text.length === 0)) continue;
      rows.push({ seq: row.seq, kind: row.type, role: row.type === "user/message" ? "user" : "assistant",
        text, reasoning: reasoningText });
    } else if (row.type === "tool/call") {
      rows.push({ seq: row.seq, kind: "tool/call", role: "assistant", text: projectionOf(row),
        reasoning: "" });
    } else if (row.type === "tool/result") {
      // The row's OWN seq decides whether it survived the host's trim: a prune
      // that names an append removes that append, and a later prune that names a
      // replacement removes the replacement. Keeping a shadowed replacement was
      // the time-aware surface rendering a row the host had already removed.
      if (shadowed.has(row.seq)) continue;
      const held = surface.get(row.seq);
      const text = held ?? textOf(row);
      const call = timeline.callNames?.get(row.seq) ?? "tool result";
      rows.push({ seq: row.seq, kind: "tool/result", role: "user",
        text: `${call}:\n${text}`, call, reasoning: "" });
    }
  }
  return { rows, shadowed: [...shadowed].sort((left, right) => left - right) };
}

/**
 * The prompt's exact bytes, hashed (the send record's `promptSha256`): the
 * message array and the tools array as the request carries them. Two fires
 * with the same hash sent the same prompt; one changed unit moves it.
 */
export function promptSha256Of(messages, tools = []) {
  return createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex");
}

/** The `sha256` of one UTF-8 string, hex. */
export function sha256OfText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The ordered per-turn hashes, hashed once: one value for the whole sequence. */
export function reasoningHashOf(texts) {
  if (!Array.isArray(texts) || texts.some(text => typeof text !== "string")) {
    refuse("sim-batch-reasoning-mismatch", "reasoning texts are an array of strings");
  }
  return sha256OfText(JSON.stringify(texts.map(sha256OfText)));
}

/**
 * The ruler's own hash: the ordered `(turnSeq, sha256(text))` PAIRS hashed once.
 * A list of texts alone cannot say which turn a replay block belonged to, so a
 * swap of turn A's reasoning onto turn B passed it; the pair binds the text to
 * the turn that carried it.
 */
export function reasoningPairsHashOf(pairs) {
  if (!Array.isArray(pairs) || pairs.some(pair => !Number.isSafeInteger(pair?.turnSeq)
    || typeof pair?.sha256 !== "string")) {
    refuse("sim-batch-reasoning-mismatch",
      "the reasoning ruler is an array of {turnSeq, sha256} pairs");
  }
  return sha256OfText(JSON.stringify(pairs.map(pair => [pair.turnSeq, pair.sha256])));
}

/** The `reasoning_content` values a prompt's messages carry, in message order. */
export function reasoningTextsOf(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => typeof message?.reasoning_content === "string"
      && message.reasoning_content.length > 0)
    .map(message => message.reasoning_content);
}

/**
 * The prompt's own ruler: `(turnSeq, sha256(reasoning_content))` for every
 * message that carries reasoning. `turnSeqs` is the parallel array `buildPrompt`
 * returns, one entry per message (`null` for a message with no turn of its own,
 * such as the ask), so the pair names the turn the reasoning was attached to —
 * not merely the text.
 */
export function reasoningPairsOf(messages, turnSeqs) {
  const list = Array.isArray(messages) ? messages : [];
  const seqs = Array.isArray(turnSeqs) ? turnSeqs : [];
  const pairs = [];
  for (const [at, message] of list.entries()) {
    if (typeof message?.reasoning_content !== "string" || message.reasoning_content.length === 0) {
      continue;
    }
    const turnSeq = seqs[at];
    if (!Number.isSafeInteger(turnSeq)) {
      refuse("sim-batch-reasoning-mismatch",
        `message ${String(at)} carries reasoning_content but no turnSeq; the prompt cannot`
        + " say which turn that reasoning belonged to, so a swap between turns would pass");
    }
    pairs.push({ turnSeq, sha256: sha256OfText(message.reasoning_content) });
  }
  return pairs;
}

/**
 * `reasoningWireBytes`: the field VALUE as the wire escapes it, without its two
 * quotes or the key (see `buildPrompt`'s record notes).
 */
export function reasoningWireBytesOf(texts) {
  return texts.reduce((sum, text) =>
    sum + Buffer.byteLength(JSON.stringify(text), "utf8") - 2, 0);
}

/**
 * The reasoning a fire's context MUST carry, computed from the TIMELINE alone:
 * every assistant turn whose owning step is at or before `fireStep` and whose
 * replay state names a resendable signature, plus the sum of their text's
 * UTF-8 bytes and the ordered list of `(turnSeq, sha256(text))` pairs. This is
 * the independent ruler `buildPrompt` compares the packed message array against.
 * It never reads `surfaceAt`'s rows, so a builder that loses a turn between the
 * timeline and the wire cannot agree with itself.
 *
 * The PAIR list is the gate's real ruler: a same-length substitution, a
 * normalisation or a re-encoding leaves the count and the byte sum unchanged
 * and moves every hash, and a text list alone would accept turn A's reasoning
 * attached to turn B (the order is the same). `sha256` is the hash of the JSON
 * list of pairs, so the whole ruler is compared as one value.
 */
export function expectedReasoningAt({ timeline, fireStep }) {
  if (!Number.isSafeInteger(fireStep)) {
    refuse("sim-batch-fire-invalid", `a fire step is an integer, got ${String(fireStep)}`);
  }
  const entryAskSeqs = timeline.entryAskSeqs ?? new Set();
  const pairs = [];
  let bytes = 0;
  for (const row of timeline.rows ?? []) {
    if (row?.type !== "assistant/message") continue;
    if (entryAskSeqs.has(row.seq)) continue;
    const entry = timeline.entrySteps?.get(row.seq)
      ?? (Number.isSafeInteger(row.data?.step) ? row.data.step : null);
    if (entry === null || entry > fireStep) continue;
    const reasoning = reasoningOf(row);
    if (!reasoning.resendable || reasoning.text.length === 0) continue;
    pairs.push({ turnSeq: row.seq, sha256: sha256OfText(reasoning.text) });
    bytes += Buffer.byteLength(reasoning.text, "utf8");
  }
  return { messages: pairs.length, bytes, sha256: reasoningPairsHashOf(pairs), pairs };
}

/**
 * The gate `buildPrompt` runs: the packed prompt's reasoning must be the SAME
 * TURNS, in the same order, as the TIMELINE places at or before the fire.
 * Comparing a count and a byte sum is not enough — a same-length substitution
 * passes both — so the ordered `(turnSeq, sha256)` pair list is the ruler, with
 * the first differing turn named. A prompt whose reasoning for turn A rides
 * turn B's message is a different pair list and refuses too. Exported so a test
 * can hand it a prompt that substituted one character or swapped two turns and
 * watch the gate refuse; `buildPrompt` is the production caller.
 */
export function assertReasoningInPrompt({ timeline, fireStep, messages, turnSeqs }) {
  const expected = expectedReasoningAt({ timeline, fireStep });
  const texts = reasoningTextsOf(messages);
  const pairs = reasoningPairsOf(messages, turnSeqs);
  const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  const at = pairs.findIndex((pair, index) => pair.turnSeq !== expected.pairs[index]?.turnSeq
    || pair.sha256 !== expected.pairs[index]?.sha256);
  const sameTurns = pairs.length === expected.pairs.length && at === -1;
  if (!sameTurns) {
    const where = at === -1
      ? `the prompt carries ${String(pairs.length)} turn(s) but the timeline places`
        + ` ${String(expected.messages)}`
      : `turn ${String(at + 1)} differs (seq ${String(pairs[at].turnSeq)} carrying a text whose`
        + " sha256 is not that turn's), which a same-length substitution, a normalisation,"
        + " a re-encoding or a swap of two turns all produce";
    refuse("sim-batch-reasoning-mismatch",
      `the packed prompt's reasoning is not the timeline's at or before step`
      + ` ${String(fireStep)}: ${where} (prompt ${String(pairs.length)} turn(s),`
      + ` ${String(bytes)} B, hash ${reasoningPairsHashOf(pairs)}; timeline`
      + ` ${String(expected.messages)} turn(s), ${String(expected.bytes)} B, hash`
      + ` ${expected.sha256}); the surface lost or altered the agent's reasoning`);
  }
  return expected;
}

/**
 * What the simulated prompt is, stated beside every send. The host's wire and
 * this stand-in are not the same object, and a run record that does not say so
 * lets a reader take a sim number for a host number. Each field names one
 * difference:
 *
 * - `roleOf` / `rolesUsed`: the roles the stand-in sends (a tool result is a
 *   `user` turn, a tool call an `assistant` turn).
 * - `droppedRowTypes`: row types in the scoped recording that reach no message,
 *   plus one entry per whole-row omission (`<type> (declared content, no text)`,
 *   `<type> (string content)`) so a row `surfaceAt` skipped is visible here.
 * - `droppedRows`: the whole-row omissions' own count and per-kind split.
 * - `droppedParts`: the per-prompt count of content parts the stand-in drops,
 *   with every dropped part's `type` (its kind) counted beside the total.
 * - `projectedRows` / `projectedParts`: content the stand-in re-projects rather
 *   than loses — an assistant turn whose only parts are tool calls, and each
 *   `tool-call` part on a carried message (it becomes a `Tool call:` turn).
 *   These are not content loss and never enter `dropped-content`.
 * - `inventedPrefix`: the `"<label>:\n"` line this module writes before a
 *   result's body; the host's item bytes carry no such line.
 * - `toolCallProjection`: the `Tool call: <name>\n<target>` assistant turn the
 *   stand-in writes per `tool/call` row.
 * - `placement`: a shaped turn stays at its own result's position; the product
 *   rewinds the ask exchange and lets the shaped body BE the result turn.
 * - `recallIdSource`: the node id the marker's recall id is minted over here
 *   (`result:<seq>`) versus the host's (`dsh:<session>:result:<callId>`).
 */
export const CONTEXT_STAND_IN = Object.freeze({
  kind: "sim-chat-stand-in",
  roleOf: Object.freeze({ "system/message": "system", "user/message": "user",
    "assistant/message": "assistant", "tool/call": "assistant", "tool/result": "user" }),
  droppedPartsRule: "every content part on a message the prompt carries that textOf does"
    + " not read as text and the stand-in does not re-project (image, file and any"
    + " other non-text part); a `type:\"reasoning\"` part is resent as"
    + " `reasoning_content`, and a `type:\"tool-call\"` part is re-projected as a"
    + " `Tool call:` turn, so neither is dropped",
  inventedPrefix: "`<label>:\\n` before every tool result's body, where <label> is"
    + " callLabelOf(name, input); the host's item bytes carry no such line",
  toolCallProjection: "`Tool call: <name>\\n<target>` as an assistant turn, one per"
    + " tool/call row; the host sends the call as a structured tool_call part",
  placement: "in place: a shaped turn stays where its own result row sits. The product"
    + " rewinds the ask exchange and replaces the result turn; this stand-in has no"
    + " exchange to rewind",
  systemSlot: "only the FIRST `system/message` row; every later one and every"
    + " `developer/message` is dropped",
  recallIdSource: "the sim mints each shaped marker's recall id over its own momentId"
    + " (`result:<seq>`); the host mints `dsh:<session>:result:<callId>` (plugin.ts"
    + " `resultNodeId`). Every sim id names a sim node, so no marker id here can match"
    + " a host archive id",
});

/**
 * The stand-in block one prompt carries: the static description above plus the
 * run's own facts (which roles this prompt used, which row types never reached a
 * message, and which content parts THIS prompt dropped, counted by kind).
 * `turnSeqs` is `buildPrompt`'s parallel message list, so the count is the
 * prompt's own, not the whole recording's. Fresh per call, so a record can hold
 * it without sharing state.
 */
/**
 * The user/assistant/tool-result rows `surfaceAt` skips WHOLE: they declare
 * content, but `textOf` reads no text from them, and an assistant turn among
 * them carries no resendable reasoning either (`surfaceAt`'s own skip
 * condition). A string content body is the same gap under its own name
 * (`textOf` reads content ARRAYS only). Counting these is P6's fix: the
 * per-turn `droppedParts` loop visits only the seqs the prompt already carries,
 * so a row the surface skipped whole was invisible.
 *
 * Thirteenth audit item 3: a `tool/result` whose parts are all non-text
 * (image-only, say) is the same whole-row omission; its unit reads 0 B and
 * would otherwise look like a sub-floor result.
 *
 * Thirteenth audit item 7: an assistant turn whose only parts are tool calls
 * (plus blank reasoning) loses nothing — its calls are re-projected as
 * `Tool call:` turns from the separate `tool/call` rows. It is counted as a
 * PROJECTED row (`projectedCount`) and never as dropped content; a part that is
 * neither text, reasoning nor tool-call (an image, a file) keeps the row in the
 * gap count.
 */
export function droppedRowGapsOf(rows) {
  const byKind = new Map();
  const projectedByKind = new Map();
  let count = 0;
  let projectedCount = 0;
  for (const row of rows ?? []) {
    if (row?.type !== "user/message" && row?.type !== "assistant/message"
      && row?.type !== "tool/result") continue;
    const declared = row.data?.message?.content ?? row.data?.content;
    const parts = Array.isArray(declared) ? declared : null;
    const nonEmpty = (parts !== null && parts.length > 0)
      || (typeof declared === "string" && declared.length > 0);
    if (!nonEmpty) continue;
    if (textOf(row).length > 0) continue;
    if (row.type === "assistant/message") {
      const reasoning = reasoningOf(row);
      if (reasoning !== null && reasoning.text.length > 0) continue;
    }
    // A string-content TOOL RESULT is named by `eligibilityOf`'s
    // `unreadableContent` bucket (`declaredContentBytes`), never by this gap
    // count: it is a reading failure of a declared body, not a lost row.
    if (row.type === "tool/result" && parts === null) continue;
    const onlyProjectedParts = parts !== null && parts.length > 0
      && parts.every(part => part !== null && typeof part === "object"
        && (part.type === "tool-call" || part.type === "reasoning"
          || (part.type === "text" && part.text === "")));
    if (row.type === "assistant/message" && onlyProjectedParts) {
      projectedCount += 1;
      const kind = `${row.type} (tool-call parts, projected)`;
      projectedByKind.set(kind, (projectedByKind.get(kind) ?? 0) + 1);
      continue;
    }
    count += 1;
    const kind = parts === null
      ? `${row.type} (string content)`
      : `${row.type} (declared content, no text)`;
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  return { count, labels: [...byKind.keys()].sort(),
    byKind: Object.fromEntries([...byKind.entries()].sort(([left], [right]) =>
      left.localeCompare(right))),
    projectedCount,
    projectedLabels: [...projectedByKind.keys()].sort(),
    projectedByKind: Object.fromEntries([...projectedByKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) };
}

export function contextStandInOf(timeline, messages, turnSeqs = null) {
  const readTypes = new Set(["user/message", "assistant/message", "tool/call", "tool/result"]);
  const counts = new Map();
  for (const row of timeline?.rows ?? []) {
    const type = row?.type;
    if (typeof type !== "string") continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const droppedRowTypes = [...counts.entries()]
    .filter(([type]) => type !== "system/message" && !readTypes.has(type))
    .map(([type]) => type).sort();
  if ((counts.get("system/message") ?? 0) > 1) {
    droppedRowTypes.push("system/message (every one after the first)");
  }
  // A missing or unreadable system slot is a dropped turn too (twelfth audit
  // item 4): the prompt's first message is empty, and no row gap named it.
  if (timeline?.systemAbsent === true) droppedRowTypes.push("system/message (absent)");
  if (timeline?.systemUnreadable === true) {
    droppedRowTypes.push("system/message (unreadable content)");
  }
  // Whole-row omissions, each under its own `droppedRowTypes` entry, plus the
  // run's count for the `dropped-rows` citation reason. Projected rows are
  // listed too, but under their own label and count: they are not content loss.
  const rowGaps = droppedRowGapsOf(timeline?.rows ?? []);
  droppedRowTypes.push(...rowGaps.labels);
  droppedRowTypes.push(...rowGaps.projectedLabels);
  // The per-prompt dropped parts: only the turns this prompt carries. A part
  // counts when `textOf` would not read it as text and it is not reasoning
  // (which is resent as `reasoning_content`). A `tool-call` part is not lost:
  // it is re-projected as a `Tool call:` turn, so it is counted as a projected
  // part instead (thirteenth audit item 7).
  const rowBySeq = new Map((timeline?.rows ?? [])
    .filter(row => Number.isSafeInteger(row?.seq)).map(row => [row.seq, row]));
  const byKind = new Map();
  const projectedByKind = new Map();
  let droppedPartCount = 0;
  let projectedPartCount = 0;
  for (const seq of Array.isArray(turnSeqs) ? turnSeqs : []) {
    if (!Number.isSafeInteger(seq)) continue;
    const row = rowBySeq.get(seq);
    if (row === undefined) continue;
    const content = Array.isArray(row.data?.message?.content) ? row.data.message.content
      : Array.isArray(row.data?.content) ? row.data.content : [];
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      if (part.type === "reasoning") continue;
      if (typeof part.text === "string") continue;
      const kind = typeof part.type === "string" ? part.type : "unknown";
      if (part.type === "tool-call") {
        projectedPartCount += 1;
        projectedByKind.set(kind, (projectedByKind.get(kind) ?? 0) + 1);
        continue;
      }
      droppedPartCount += 1;
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
  }
  return {
    ...CONTEXT_STAND_IN,
    roleOf: { ...CONTEXT_STAND_IN.roleOf },
    rolesUsed: [...new Set((Array.isArray(messages) ? messages : [])
      .map(message => message?.role).filter(role => typeof role === "string"))],
    droppedRowTypes,
    droppedRows: { count: rowGaps.count, byKind: rowGaps.byKind },
    projectedRows: { count: rowGaps.projectedCount, byKind: rowGaps.projectedByKind },
    droppedParts: { count: droppedPartCount,
      byKind: Object.fromEntries([...byKind.entries()].sort(([left], [right]) =>
        left.localeCompare(right))) },
    projectedParts: { count: projectedPartCount,
      byKind: Object.fromEntries([...projectedByKind.entries()]
        .sort(([left], [right]) => left.localeCompare(right))) },
    // P2: the tool schema this prompt carries, and the `request/header` row it
    // came from. `source: "none"` is a recording with no header; `count: 0` under
    // a real header is a recording whose header names no tools. Both are named
    // outside this block by the `tools-absent` reason.
    tools: {
      source: Number.isSafeInteger(timeline?.toolsHeaderSeq) ? "request/header" : "none",
      seq: Number.isSafeInteger(timeline?.toolsHeaderSeq) ? timeline.toolsHeaderSeq : null,
      count: Array.isArray(timeline?.tools) ? timeline.tools.length : 0,
    },
    entryAskRowsDropped: timeline?.entryAskRows ?? 0,
  };
}

/**
 * The prompt the fire sends, built from the measured surface: system, the turns
 * at or before `fireStep`, then `ask`. `surface` and `fireIndex` are REQUIRED
 * (`surfaceAt`'s rule): a caller with no answers yet passes `simulateSurface()`
 * and fire 0, and passing nothing refuses by name.
 *
 * The TOOLS array is part of the request and part of its byte count. The live
 * path sends `timeline.tools` (19 definitions, 13,879 B in the 2026-10-29
 * vanilla world; `headerToolBytes` records the 13,290 B raw header form) in
 * every body, and a provider counts their tokens. So `toolsBytes` is added to
 * `bytes`, and `guardTokens` / `estimatedTokens` read the whole request, never
 * the messages alone.
 *
 * An assistant turn's reasoning goes back beside its text as
 * `reasoning_content` (ADR-0045), and its bytes count into `bytes` with the
 * text's, so the pre-send guard sees the whole context. Three numbers are
 * recorded, never conflated:
 *
 * - `reasoningBytes` — the raw UTF-8 text. This is the pin (fab6632e@139:
 *   155,545 B) and the number counted into `bytes`.
 * - `reasoningWireBytes` — `JSON.stringify(text).length - 2` summed: the field
 *   VALUE as the wire escapes it, without its two quotes or the key. The
 *   difference `reasoningWireDeltaBytes` is therefore the escaping alone
 *   (`\n` → `\\n`, a non-ASCII character → `\uXXXX`).
 * - `reasoningShare` — `reasoningBytes / bytes` for THIS prompt, so the share of
 *   each send that is the agent's reasoning is stated, not inferred.
 *
 * - the fixed per-message key (`"reasoning_content":` plus the comma) is NOT in
 *   either number; it is about 21 B per message and is not counted, per the
 *   brief's "count `JSON.stringify(text).length - 2` for that field" option.
 *
 * `bytes` is a CONTENT-ONLY count: the message content strings plus the tools
 * JSON. It is neither a lower bound nor an upper bound on the wire: it includes
 * text this stand-in invents (`"<label>:\n"` lines, `Tool call:` projections)
 * and omits JSON framing, role keys, escaping and the `reasoning_content` keys.
 * `promptWireBytes` is `JSON.stringify({ messages, tools })` in UTF-8 — the
 * payload the request carries — and `payloadWireDeltaBytes` is the difference.
 * (The live send record's `bodyWireDeltaBytes` is the same subtraction against
 * the FULL request body, envelope included: two named deltas, never one word
 * for both.)
 * The live send record states the full request body's size under the same name
 * (`requestBodyOf` adds only the fixed `model`/`stream`/`stream_options`
 * envelope).
 *
 * `guardTokens` is applied to the LARGER of the two sizes: `ceil(bytes/3)` and
 * `ceil(promptWireBytes/3)`, whichever is larger. The guard must see the bytes
 * the request really carries, so a content-only count can never let an
 * oversized wire through. The two components are recorded beside the maximum.
 *
 * 0 reasoning on both sides is the byte-identical pair-2 prompt: no field is
 * added, `bytes` is the same sum of the same strings (ISSUE-195).
 */
export function buildPrompt({ timeline, fireStep, ask, surface, fireIndex,
  checkGuard = true }) {
  const shown = surfaceAt({ timeline, fireStep, surface, fireIndex });
  const messages = [{ role: "system", content: timeline.system ?? "" },
    ...shown.rows.map(row => ({ role: row.role, content: row.text,
      ...(row.reasoning ? { reasoning_content: row.reasoning } : {}) })),
    { role: "user", content: ask }];
  // One entry per message: the turn's own seq, or null for the system slot and
  // the ask. The reasoning ruler binds each `reasoning_content` to its turn.
  const turnSeqs = [null, ...shown.rows.map(row => row.seq), null];
  const tools = timeline.tools ?? [];
  const toolsBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  let bytes = toolsBytes;
  let reasoningBytes = 0;
  let reasoningMessages = 0;
  const reasoningTexts = [];
  for (const message of messages) {
    bytes += Buffer.byteLength(message.content, "utf8");
    if (typeof message.reasoning_content !== "string") continue;
    const raw = Buffer.byteLength(message.reasoning_content, "utf8");
    reasoningBytes += raw;
    reasoningMessages += 1;
    reasoningTexts.push(message.reasoning_content);
    bytes += raw;
  }
  const reasoningWireBytes = reasoningWireBytesOf(reasoningTexts);
  const reasoningPairs = reasoningPairsOf(messages, turnSeqs);
  // The record's reasoning must be the resendable assistant turns the TIMELINE
  // places at or before this fire, per turn: a lost OR altered OR re-attached
  // turn is a refused run, never a smaller or equal-sized number (ADR-0045,
  // ISSUE-195). The expected turns are computed from `timeline` alone; comparing
  // them to the same `shown.rows` would be a check that cannot fail.
  assertReasoningInPrompt({ timeline, fireStep, messages, turnSeqs });
  // The WIRE size of the same payload: JSON framing, escaping, role keys and the
  // `reasoning_content` key included. `bytes` counts content strings plus the
  // tools JSON only, so the two are different measurements, and the guard applies
  // to the larger one.
  const promptWireBytes = Buffer.byteLength(JSON.stringify({ messages, tools }), "utf8");
  const guardTokensContent = guardTokensOf(bytes);
  const guardTokensPayloadWire = guardTokensOf(promptWireBytes);
  const guardTokens = Math.max(guardTokensContent, guardTokensPayloadWire);
  const estimatedTokens = measuredTokensOf(bytes);
  if (checkGuard && guardTokens >= PROMPT_TOKEN_LIMIT) {
    refuse("sim-batch-prompt-overflow",
      `ceil(${String(bytes)} content B / ${String(PROMPT_GUARD_FACTOR)}) =`
      + ` ${String(guardTokensContent)} and ceil(${String(promptWireBytes)} wire B /`
      + ` ${String(PROMPT_GUARD_FACTOR)}) = ${String(guardTokensPayloadWire)}, so the guard's`
      + ` ${String(guardTokens)} >= ${String(PROMPT_TOKEN_LIMIT)} before a send; the guard`
      + " reads the larger of the two sizes, and nothing is trimmed");
  }
  // `overriddenSeqs` is the surface map's keys: recorded as provenance, never
  // trusted as proof that the prompt rendered them. The carried-override gate
  // (`assertCarriedOverrides` in sim-batch-live.mjs) reads the messages above.
  return { messages, turnSeqs, toolsBytes, bytes, promptWireBytes,
    payloadWireDeltaBytes: promptWireBytes - bytes,
    guardTokens, guardTokensContent, guardTokensPayloadWire,
    estimatedTokens, surfaceRows: shown.rows.length, contextRows: shown.rows.length,
    shadowed: shown.shadowed.length,
    reasoningBytes, reasoningWireBytes, reasoningWireDeltaBytes: reasoningWireBytes - reasoningBytes,
    reasoningMessages, reasoningShare: bytes === 0 ? 0 : reasoningBytes / bytes,
    reasoningSha256: reasoningPairsHashOf(reasoningPairs),
    reasoningPairs,
    contextStandIn: contextStandInOf(timeline, messages, turnSeqs),
    overriddenSeqs: [...surface.keys()].sort((left, right) => left - right) };
}

/**
 * The reconstructed surface's OWN depth at one step: the request that step
 * would send, built from the simulated surface and the timeline's system slot
 * and tools, with no ask bytes. `bytes` and `tokens` (`ceil(bytes/3.04)`) are
 * the reading a pruner-off lane triggers on; the send guard is not applied,
 * because a measurement is not a send (the guard fires where a prompt is built
 * for the wire).
 *
 * `surface` and `fireIndex` are REQUIRED (ISSUE-195): the surface names how many
 * fires it has absorbed, so a caller cannot read a raw recording's depth and
 * call it the reconstructed surface. A plain `new Map()` is refused at fire > 0
 * by `surfaceAt`'s identity check.
 */
export function surfaceDepthAt({ timeline, fireStep, surface, fireIndex }) {
  const packed = buildPrompt({ timeline, fireStep, ask: "", surface, fireIndex,
    checkGuard: false });
  return { step: fireStep, bytes: packed.bytes, tokens: packed.estimatedTokens };
}

/**
 * The depth the request at `step` carried: the surface with every row that
 * landed BEFORE the step (`entry < step`), which is the same cut the threshold
 * loop applies to its pending stream. `surfaceDepthAt` is the fire/anchor
 * reading, where the row that triggered the fire is present.
 */
export function surfaceDepthBefore({ timeline, step, surface, fireIndex }) {
  return surfaceDepthAt({ timeline, fireStep: step - 1, surface, fireIndex });
}

/**
 * `surfaceDepthBefore` over a step schedule, in order (analysis only, no
 * policy). Both the surface and its fire index are REQUIRED: a missing surface
 * used to default to `new Map()`, which silently read the raw recording.
 */
export function surfaceDepthSeries({ timeline, steps, surface, fireIndex }) {
  if (!(surface instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `a simulated surface is a Map of unit seq to text, got ${String(surface)}`);
  }
  if (!Number.isSafeInteger(fireIndex) || fireIndex < 0) {
    refuse("sim-batch-fire-invalid",
      `a fire index is a non-negative integer, got ${String(fireIndex)}`);
  }
  return steps.map(step => surfaceDepthBefore({ timeline, step, surface, fireIndex }));
}

/** The two depth sources a lane may name, and the one a pruner-off lane takes. */
export const DEPTH_SOURCES = ["host-result.json", "reconstructed-surface"];
export const SURFACE_DEPTH_SOURCE = "reconstructed-surface";
export const HOST_DEPTH_SOURCE = "host-result.json";

/**
 * Refuse a contaminated depth source (auditor §5; ADR-0041). `result.json`'s
 * series was measured while the host's own tool-result pruner was active: the
 * depths carry the host's trims, so a pruner-off lane that triggers on them is
 * reading a world it is not replaying. A pruner-off lane triggers on the
 * reconstructed surface's bytes; the host series is recorded beside it, labeled
 * `contaminated: true`.
 */
export function assertDepthSource(depthSource, ignoreHostPrunes) {
  if (!DEPTH_SOURCES.includes(depthSource)) {
    refuse("sim-batch-depth-source-invalid",
      `depthSource takes ${DEPTH_SOURCES.join(" or ")}, got ${String(depthSource)}`);
  }
  if (ignoreHostPrunes === true && depthSource === HOST_DEPTH_SOURCE) {
    refuse("sim-batch-depth-contaminated",
      "a pruner-off lane refuses result.json's depth series: the host trim was active"
      + " when it was measured, so it cannot trigger the reconstructed world");
  }
  return depthSource;
}

/** The source a lane takes when nobody names one. */
export function defaultDepthSource(ignoreHostPrunes) {
  return ignoreHostPrunes === true ? SURFACE_DEPTH_SOURCE : HOST_DEPTH_SOURCE;
}

/**
 * ADR-0041 Decision 6's gate, as a replay can state it. When the run states the
 * host pruner is OFF, the world it replays must not be one the pruner shaped.
 * `replayedPrunes` is that world's own `compaction/prune` count, taken from the
 * recording BEFORE `--ignore-host-prunes` removed the rows: after the filter the
 * world carries none by construction, so a gate over the filtered rows could
 * never fail and is not kept. A world that carries the events is a
 * RECONSTRUCTION of a pruner-on recording, never a product-alone measurement
 * (ADR-0041 Decision 7): it REFUSES by name unless it declares
 * `--reconstruction`, and the declaration is recorded in the run.
 * `inputPruneEvents` is the WHOLE recording's count, kept beside it as
 * provenance (a prune row outside the segment never entered the replay).
 */
export function assertZeroPruneGate(timeline) {
  const required = timeline.ignoreHostPrunes === true;
  const inputPruneEvents = timeline.inputPruneEvents ?? 0;
  const hostPrunes = timeline.hostPrunes?.length ?? 0;
  const replayedPrunes = Number.isSafeInteger(timeline.replayedPrunes)
    ? timeline.replayedPrunes : hostPrunes;
  if (!required) {
    return { required: false, events: hostPrunes, replayedPrunes, inputPruneEvents,
      reconstruction: timeline.reconstruction === true, status: "not-required" };
  }
  // The one branch that can fail: the source world carries prune events. The
  // replayed world itself is empty after the filter, so nothing here counts it.
  if (replayedPrunes > 0 && timeline.reconstruction !== true) {
    refuse("sim-batch-zero-prune-gate",
      `the run states the host pruner is off but the recording it replays carries`
      + ` ${String(replayedPrunes)} compaction/prune event(s) in the segment`
      + ` (${String(inputPruneEvents)} in the whole recording); a pruner-off replay of it`
      + " is a reconstruction, not a product measurement. Pass --reconstruction to"
      + " declare that explicitly (it is recorded in the run); ADR-0041 Decision 6");
  }
  return { required: true, events: hostPrunes, replayedPrunes, inputPruneEvents,
    reconstruction: timeline.reconstruction === true,
    status: replayedPrunes > 0 ? "reconstruction" : "pass" };
}
/** A unit's facts: `N` over its decoded lines and core's own anchors. */
export function factsOf(text) {
  // The product's `entryAskFacts` runs these over `visibleTextOf(bytes)`; this
  // reads the decoded text. See `TEXT_SOURCE` (recorded on every plan and run).
  const lines = String(text).split("\n");
  if (String(text).endsWith("\n")) lines.pop();
  return { lineCount: lines.length, anchorLines: anchorsFor(lines) };
}

/**
 * Whether these facts can fill a table row's two quote lines (ADR-0042
 * Decision 2 and Decision 5): core's own `quoteCountOf` over core's own
 * `anchorsFor` output, the same reading `entry-ask.ts` `factsShowTwoQuotes`
 * performs. A body that fails it is never tabled by the product, so the sim
 * never asks it and never removes it.
 */
export function factsShowTwoQuotes(facts) {
  return quoteCountOf(facts.anchorLines) >= ENTRY_ASK_MIN_QUOTE_LINES;
}

/** The fire's rows in index order, exactly as `entryBatchAskMessage` reads them. */
export function askRowsOf(units, callNames = new Map()) {
  return units.map((unit, at) => ({
    index: at + 1,
    call: callNames.get(unit.seq) ?? "tool result",
    ...factsOf(unit.text),
  }));
}

/**
 * The `kept` scope's table for one fire: every still-kept unit in the order it
 * was first asked, then that fire's newly eligible units. One row per unitId;
 * a row keeps its unit's current body, so its byte size and line count are read
 * from the unit, never carried from an earlier table. The kept map's insertion
 * order is first-asked order, and re-setting an existing key never moves it.
 */
export function tableUnitsOf({ kept, pending }) {
  const units = [];
  const seen = new Set();
  for (const unit of [...kept.values(), ...pending]) {
    if (typeof unit?.id !== "string" || seen.has(unit.id)) continue;
    seen.add(unit.id);
    units.push(unit);
  }
  return units;
}

/**
 * What a fire's ask table contains. `new` (the default) is today's table: only
 * the units that landed since the last fire. `kept` re-tables every unit whose
 * latest verdict kept it — `keepall`, `keeplines`, or a refusal that fails open
 * — beside the newly eligible units. A whole-unit forget deletes the row from
 * the kept map, so that unit is never asked again and its removal stands: a
 * later fire cannot bring the body back. A refused re-ask of a row that is
 * still kept changes nothing — its earlier shape (and its earlier removal)
 * stays exactly as it was, and only an explicit `keepall` restores a body.
 * Threshold mode only: a batch fire's table is a fixed lane, so a kept row
 * there would be asked twice in one lane.
 */
export const ASK_SCOPES = ["new", "kept"];
/** Today's table: newly landed units only. */
export const DEFAULT_ASK_SCOPE = "new";

/** The ask scope a flag names, or a refusal by name. */
export function assertAskScope(scope = DEFAULT_ASK_SCOPE) {
  if (typeof scope !== "string" || !ASK_SCOPES.includes(scope)) {
    refuse("sim-batch-ask-scope-invalid",
      `--ask-scope takes ${ASK_SCOPES.join(" or ")}, got ${String(scope)}`);
  }
  return scope;
}

/** The ask grammar a flag names, or a refusal by name. */
export function assertAskGrammar(grammar = DEFAULT_ASK_GRAMMAR) {
  if (typeof grammar !== "string" || !ASK_GRAMMARS.includes(grammar)) {
    refuse("sim-batch-grammar-invalid",
      `--ask-grammar takes ${ASK_GRAMMARS.join(" or ")}, got ${String(grammar)}`);
  }
  return grammar;
}

/** The instruction order a flag names, or a refusal by name. */
export function assertAskOrder(order = DEFAULT_ASK_ORDER) {
  if (typeof order !== "string" || !ASK_ORDERS.includes(order)) {
    refuse("sim-batch-order-invalid",
      `--ask-order takes ${ASK_ORDERS.join(" or ")}, got ${String(order)}`);
  }
  return order;
}

/**
 * The grammar and order together. A slot grammar (`jsonl-20` and its
 * `nokeepall` variant) embeds its table as a slot in the prompt, so there is no
 * separate teaching block to move: a non-`first` order refuses by name rather
 * than being silently ignored in the record.
 */
export function assertOrderForGrammar(grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER) {
  const checkedGrammar = assertAskGrammar(grammar);
  const checkedOrder = assertAskOrder(order);
  if (SLOT_GRAMMARS.has(checkedGrammar) && checkedOrder !== DEFAULT_ASK_ORDER) {
    refuse("sim-batch-order-grammar",
      `--ask-order ${checkedOrder} does not apply to ${checkedGrammar}: its prompt renders its`
      + " own table slot, so only first applies");
  }
  return { grammar: checkedGrammar, order: checkedOrder };
}

/**
 * The first fire's absolute depth floor, or null for today's cadence. Threshold
 * mode only, and a depth gate: a landed-bytes lane has no depth to compare, so
 * the combination refuses rather than silently ignoring the flag.
 */
export function assertFirstFireDepth(value = null, { mode = "threshold",
  thresholdUnits = DEFAULT_THRESHOLD_UNITS } = {}) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse("sim-batch-first-fire-depth-invalid",
      `--first-fire-depth takes a positive integer, got ${String(value)}`);
  }
  if (mode !== "threshold") {
    refuse("sim-batch-first-fire-depth-batch",
      `--first-fire-depth is threshold mode only; --mode ${mode} refuses it`);
  }
  if (thresholdUnits === "landed-bytes") {
    refuse("sim-batch-first-fire-depth-units",
      "--first-fire-depth is a depth gate; --threshold-units landed-bytes refuses it");
  }
  return value;
}

/**
 * The batch ask message for one fire, under one grammar, one instruction order
 * and one trigger variant (ISSUE-194: `firstTrigger` true is the session's first
 * fire, false every later one — `jsonl-20`'s share line is the only bytes it
 * moves). The default is `jsonl-20`, the product's own default ask, with the
 * instruction first; a variant swaps only the instruction block (phase 3
 * A1/A2) and `after`/`both` move that same block (phase 4).
 */
export function askMessageFor(units, callNames = new Map(), grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER, firstTrigger = true) {
  const checked = assertOrderForGrammar(grammar, order);
  return askMessageForRows(askRowsOf(units, callNames), checked.grammar, checked.order,
    firstTrigger);
}

/**
 * The prompt a fire would send, with the real ask bytes and no socket. The ask's
 * share line follows `firstTrigger` and the conversation behind it is `surface`
 * — REQUIRED, the run's simulated surface (`new Map()` when no answer exists
 * yet), never the raw transcript implied by an absent value.
 */
export function promptForFire({ timeline, fireStep, units, grammar = DEFAULT_ASK_GRAMMAR,
  order = DEFAULT_ASK_ORDER, firstTrigger = true, surface, fireIndex, checkGuard = true }) {
  const ask = askMessageFor(units, timeline.callNames ?? new Map(), grammar, order, firstTrigger);
  return { ask, askBytes: Buffer.byteLength(ask, "utf8"),
    ...buildPrompt({ timeline, fireStep, ask, surface, fireIndex, checkGuard }) };
}

/**
 * Fold one fire's answers into the run's simulated surface (ISSUE-194). The
 * product rewinds its exchange and replaces a forgotten result with the shaped
 * turn; the sim keeps the same surface by replacing that unit's text with the
 * body `renderMoment` produces — the product's own renderer, reached through
 * `sim-render.mjs`, never a second renderer:
 *
 * - `keepall`, a refusal (the parser's fail-open keep), or a `keeplines` that
 *   covers every line: the unit stays whole, so its override is removed;
 * - `forgetall`: the unit's tool result becomes the answer's summary, one blank
 *   line, and the empty-form marker (`kept 0 of N lines · necromancy <id>`);
 * - `keeplines`: the tool result becomes the summary plus the kept lines with
 *   one marker standing in each dropped gap.
 *
 * A REFUSED row is not an answer: it changes nothing. The failed-open keep is
 * the product's "nothing was applied", not a restore, so a row that an earlier
 * fire shaped keeps that shape and its removal stands. Only an answered
 * `keepall` (or an all-lines `keeplines`) restores a body.
 *
 * `surface` is a `Map` from the unit's seq to that text, created once per run
 * (`new Map()`), mutated in place and returned. `rows` is one reading per unit,
 * in the same order as `units` (the shape `answerRowsOf` returns): a row that
 * answered carries `answer`; a refused row changes nothing. The model's
 * asks and answers never enter this map — only the tool results do, which is the
 * product's rewind: the exchange is gone and the result turn carries the shaped
 * body.
 *
 * `applied`, when passed, is filled with the shapes THIS fire applied
 * (`seq → shaped body`) and emptied of the seqs it restored. It is an optional
 * transcription of the writer's own output; the live surface gate does NOT use
 * it — that gate rebuilds its expected bodies from the decision log
 * (`reconstructedSurfaceOf` in `sim-batch-live.mjs`), so a writer that puts the
 * same wrong body in both places still fails.
 *
 * `fireStep` is the fire's own step. A unit the host removed STRICTLY BEFORE
 * THIS step is skipped (no prompt carries it); a unit removed by a LATER prune
 * is shaped here, because it stood on the surface for this window.
 */
export function applyFireToSurface({ surface, timeline, units, rows, lane = 0,
  fireStep = null, applied = null }) {
  if (!(surface instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `a simulated surface is a Map of unit seq to text, got ${String(surface)}`);
  }
  if (!Array.isArray(units) || !Array.isArray(rows) || units.length !== rows.length) {
    refuse("sim-batch-surface-invalid",
      `applyFireToSurface needs one reading per unit, got ${String(units?.length)} and`
      + ` ${String(rows?.length)}`);
  }
  if (applied !== null && !(applied instanceof Map)) {
    refuse("sim-batch-surface-invalid",
      `applyFireToSurface's applied map is a Map or null, got ${String(applied)}`);
  }
  if (fireStep !== null && !Number.isSafeInteger(fireStep)) {
    refuse("sim-batch-fire-invalid",
      `applyFireToSurface's fireStep is an integer or null, got ${String(fireStep)}`);
  }
  // The seqs the host had removed BY THIS FIRE. A unit pruned LATER was on the
  // surface here, so its shape is applied and stands until the prune; only a
  // unit already gone at this step is skipped (no prompt renders it).
  const removedNow = fireStep === null ? (timeline?.hostRemoved ?? new Set())
    : hostRemovedAt(timeline, fireStep);
  let shaped = 0;
  for (const [at, row] of rows.entries()) {
    const unit = units[at];
    if (unit === undefined) continue;
    // A refusal applied nothing: the surface is exactly as it was.
    if (row.status !== "answered") continue;
    // A unit the host had already removed is not on this surface: `surfaceAt`
    // drops it, so a shape applied to it would be an entry no prompt renders.
    // Skipping it keeps the surface's CUMULATIVE shaped count equal to the run's
    // applied count (the current size is `surfaceSizeOf`, a separate reading).
    // A unit removed by a LATER prune is applied here and credited to the
    // policy for the window it stood.
    if (removedNow.has(unit.seq)) continue;
    const decision = { momentId: unit.id, step: unit.step, ...row.answer };
    const rendered = renderMoment(momentOf(unit, timeline, lane), decision);
    // A keepall or an all-lines keeplines renders unshaped: the unit is whole,
    // so an earlier override is dropped by the answer that said so.
    if (rendered === null || !rendered.shaped) {
      surface.delete(unit.seq);
      applied?.delete(unit.seq);
    } else {
      surface.set(unit.seq, rendered.after);
      applied?.set(unit.seq, rendered.after);
      shaped += 1;
    }
  }
  // A stamped surface advances exactly one fire: the next prompt is built with
  // its new index, and a surface presented at any other fire is refused.
  if (typeof surface[SURFACE_FIRE] === "number") {
    surface[SURFACE_FIRE] += 1;
    surface[SURFACE_SHAPES_EVER_APPLIED] += shaped;
  }
  return surface;
}

/**
 * The surface a DECISION LOG describes, rebuilt independently of the WRITER'S
 * BOOKKEEPING (P7, P10). Independence is at that layer only: the rebuild and
 * the writer share `renderMoment`, the product's renderer, so a renderer bug
 * moves both sides together. What the rebuild does NOT read is the writer's
 * `surface` or `applyFireToSurface`'s `applied` map: it re-derives which unit
 * each answered decision names, at which fire, and which body that unit held,
 * from the log. Each decision is rendered from the body the rebuilt surface
 * holds at that point — the landed text for a first ask, the rebuilt shaped
 * body for a re-asked row under `kept` — in log order. A unit the host had
 * removed at the decision's own `fireStep` is skipped, because no prompt for
 * that fire carried it.
 *
 * A writer that puts its wrong body into BOTH the surface and its applied map
 * therefore fails the digest comparison: the expected digest comes from the
 * log's bookkeeping, not from the writer's own output. It lives HERE, not in
 * the live module, so the plan lane and the live lane run the same rebuild
 * (P10) — a plan surface and a live surface are checked against one function.
 */
export function reconstructedSurfaceOf({ timeline, units, decisions, lane = 0 }) {
  const byId = new Map((units ?? []).map(unit => [unit.id, unit]));
  const expected = new Map();
  for (const decision of decisions ?? []) {
    const unit = byId.get(decision?.momentId);
    if (unit === undefined) continue;
    if (Number.isSafeInteger(decision.fireStep)
      && hostRemovedAt(timeline, decision.fireStep).has(unit.seq)) {
      continue;
    }
    const held = expected.get(unit.seq);
    const body = typeof held === "string" ? { ...unit, text: held } : unit;
    const rendered = renderMoment(momentOf(body, timeline, lane), decision);
    if (rendered === null || !rendered.shaped) expected.delete(unit.seq);
    else expected.set(unit.seq, rendered.after);
  }
  return expected;
}

/**
 * The STANDING removal each unit's decision log describes, rebuilt from the
 * bodies the fires APPLIED (P2), never from the landed text. `renderLane` over
 * `units.map(momentOf)` re-renders every decision from the landed body, so under
 * `--ask-scope kept` a re-asked row's `keeplines` was sized against the original
 * text while the fire sized it against the SHAPED body the prompt carried. This
 * rebuild reads the body the rebuilt surface holds at each decision, exactly as
 * `reconstructedSurfaceOf` does, and keeps the LAST row per unit (one standing
 * removal per unit; a later verdict supersedes an earlier one).
 *
 * A unit the host had removed at the decision's own `fireStep` is skipped: no
 * prompt for that fire carried it. It never reads `applyFireToSurface`'s own
 * output map — the same independence rule `reconstructedSurfaceOf` follows.
 */
export function reconstructedRemovalsOf({ timeline, units, decisions, lane = 0 }) {
  const byId = new Map((units ?? []).map(unit => [unit.id, unit]));
  const bodies = new Map();
  const standing = new Map();
  for (const decision of decisions ?? []) {
    const unit = byId.get(decision?.momentId);
    if (unit === undefined) continue;
    if (Number.isSafeInteger(decision.fireStep)
      && hostRemovedAt(timeline, decision.fireStep).has(unit.seq)) {
      continue;
    }
    const held = bodies.get(unit.seq);
    const body = typeof held === "string" ? { ...unit, text: held } : unit;
    const rendered = renderMoment(momentOf(body, timeline, lane), decision);
    if (rendered === null || !rendered.shaped) {
      bodies.delete(unit.seq);
      standing.delete(unit.id);
    } else {
      // The fire loop books a removal at `clampDecisionStep(rendered.decisionStep,
      // fire.step)`; the rebuild must use the same step, or a decision whose own
      // fallback lands at the host's prune step reads as "after the prune" and is
      // filtered out of the freed figure while its booking stands (P2).
      const step = Number.isSafeInteger(decision.fireStep)
        ? clampDecisionStep(rendered.decisionStep, decision.fireStep) : rendered.decisionStep;
      bodies.set(unit.seq, rendered.after);
      standing.set(unit.id, { ...rendered, decisionStep: step, unitId: unit.id,
        seq: unit.seq });
    }
  }
  return standing;
}

/**
 * The segment decomposition and depth pins (design §1, §2.1), computed from the
 * timeline. `eligible = appends + replacements` is a DEFINITION, not a check
 * (`assertSegmentPins` no longer prints it); `appends = neverPruned +
 * prunedOriginals` is the append group's own split. The three counts are
 * reported separately so the task's
 * "201 + 67" phrasing is never printed as if it summed to 268.
 */
export function surfacePinsOf(timeline, depths = []) {
  const eligible = eligibleOf(timeline, FLOOR_BYTES);
  const appends = eligible.filter(unit => unit.surfaceOp === "append");
  const replacements = eligible.filter(unit => unit.surfaceOp === "replace");
  const shadowed = new Set(timeline.hostPrunes.flatMap(prune => prune.seqs));
  const prunedOriginals = appends.filter(unit => shadowed.has(unit.seq));
  // A replacement is the host's output when its original is a shadowed seq. A
  // mounting arm also records its own replacement rows; those are not journals.
  const hostReplacements = replacements.filter(unit => shadowed.has(unit.startSeq));
  let peak = { step: null, depth: 0 };
  for (const entry of depths) {
    if (timeline.segment !== null && entry.step > timeline.segment) continue;
    if (entry.tokens > peak.depth) peak = { step: entry.step, depth: entry.tokens };
  }
  return {
    segment: timeline.segment, firstExcludedStep: timeline.firstExcludedStep ?? null,
    excludedRows: timeline.excludedRows ?? 0,
    eligible: eligible.length, appends: appends.length, replacements: replacements.length,
    hostReplacements: hostReplacements.length,
    otherReplacements: replacements.length - hostReplacements.length,
    prunedOriginals: prunedOriginals.length, neverPruned: appends.length - prunedOriginals.length,
    pruneJournals: timeline.hostPrunes.length, shadowedSeqs: shadowed.size,
    ignoreHostPrunes: timeline.ignoreHostPrunes === true,
    hostReplacementsIgnored: timeline.hostReplacementsIgnored ?? 0,
    peakDepth: peak.depth, peakStep: peak.step,
    headerTools: timeline.headerTools, headerToolBytes: timeline.headerToolBytes,
    reasoningBlocks: timeline.reasoningBlocks ?? 0,
    reasoningBytes: timeline.reasoningBytes ?? 0,
    reasoningParts: timeline.reasoningParts ?? 0,
    reasoningStreamBlocks: timeline.reasoningStreamBlocks ?? 0,
    fileReasoningParts: timeline.fileReasoningParts ?? 0,
    fileReasoningStreamBlocks: timeline.fileReasoningStreamBlocks ?? 0,
    reasoningTurns: timeline.reasoningTurns ?? 0,
    reasoningUnresendableRows: timeline.reasoningUnresendableRows ?? 0,
    transcriptSha256: timeline.transcriptSha256 ?? null,
    entryAskRows: timeline.entryAskRows ?? 0,
    inputPruneEvents: timeline.inputPruneEvents ?? 0,
    replayedPrunes: timeline.replayedPrunes ?? 0,
  };
}

/**
 * The last step any scoped row is owned by: the surface's own end, used by the
 * reasoning-carried check when no measured steps are at hand.
 */
export function lastStepOf(timeline) {
  let last = 0;
  for (const step of (timeline.entrySteps ?? new Map()).values()) {
    if (Number.isSafeInteger(step) && step > last) last = step;
  }
  return last;
}

/**
 * ADR-0045's carried check, independent of the segment. Three states:
 *
 * - reasoning is STORED but none of it is resendable (`reasoningParts > 0`,
 *   `reasoningBlocks === 0`): the replay cannot put back what the agent had.
 *   The run refuses by name; `--allow-zero-reasoning` cannot excuse it,
 *   because this is not a zero-reasoning session — it is a lost one.
 * - the transcript DECLARES zero reasoning: a void comparison, not a
 *   measurement. The run refuses by name unless `allowZeroReasoning` is
 *   explicitly passed, and the caller records that flag as a void comparison
 *   (ADR-0045 Decision 2). A transcript with no reasoning at all is not
 *   evidence, and the gate can no longer be vacuous at zero.
 * - reasoning is declared: every turn must be back on the surface with the
 *   same bytes, or the run refuses.
 *
 * A transcript that STORES reasoning on some turns and can resend others refuses
 * first: `reasoningUnresendableRows` counts the turns `reasoningOf` drops (a
 * misaligned replay state or an unknown signature). Before this count existed,
 * a half-lost transcript passed on its half.
 *
 * A turn that lost its reasoning PARTS whole leaves no trace in
 * `reasoningTurns` or `reasoningBlocks` — both read the parts — so the two stay
 * equal and the loss is invisible. Its STRUCTURAL echoes do survive: the
 * turn's replay-state block and its stream block. The scoped rows count every
 * assistant turn (`assistantTurns`) and every turn with such an echo
 * (`reasoningMarkedTurns`), so a turn that reasoned and no longer carries a
 * part refuses by name (`sim-batch-reasoning-parts-lost`) at ANY segment. The
 * assistant-turn count is recorded so the coverage is visible even where no
 * echo survives; only the segment-139 pins can catch that last case.
 *
 * Run on any segment, so a replay that drops the field fails by name instead
 * of being measured as a smaller conversation.
 */
export function assertReasoningCarried(timeline, { allowZeroReasoning = false } = {}) {
  if (typeof allowZeroReasoning !== "boolean") {
    refuse("sim-batch-allow-zero-reasoning-invalid",
      `allowZeroReasoning is a boolean, got ${String(allowZeroReasoning)}`);
  }
  const unresendableRows = timeline.reasoningUnresendableRows ?? 0;
  if (unresendableRows > 0) {
    refuse("sim-batch-reasoning-unresendable-rows",
      `the transcript stores reasoning text on ${String(unresendableRows)} assistant`
      + " turn(s) whose replay state is misaligned or whose thinkingSignature is not one"
      + " of the resendable three; the replay cannot put that reasoning back, so the run"
      + " is a partial-loss transcript, not evidence (ADR-0045, ISSUE-195)");
  }
  const declaredBlocks = timeline.reasoningBlocks ?? 0;
  if (declaredBlocks === 0) {
    const parts = timeline.reasoningParts ?? 0;
    const streamBlocks = timeline.reasoningStreamBlocks ?? 0;
    if (parts > 0 || streamBlocks > 0) {
      refuse("sim-batch-reasoning-unresendable",
        `the transcript stores ${String(parts)} reasoning part(s) and ${String(streamBlocks)}`
        + " reasoning stream block(s) but carries 0 resendable blocks (no"
        + " reasoning_content signature); the replay cannot put the agent's reasoning"
        + " back (ADR-0045)");
    }
    if (allowZeroReasoning !== true) {
      refuse("sim-batch-reasoning-absent",
        "the transcript declares 0 reasoning blocks; a run on it is a void comparison,"
        + " never evidence (ADR-0045 Decision 2). Pass --allow-zero-reasoning to record"
        + " that explicitly");
    }
    return { blocks: 0, bytes: 0, zeroDeclared: true, voidComparison: true };
  }
  // ADR-0045 names TWO counts, and both gate: the `type:"reasoning"` content
  // parts and the `blockType:"reasoning"` stream entries. A record that keeps
  // one and loses the other is a partial transcript, not a smaller run.
  const streamBlocks = timeline.reasoningStreamBlocks ?? 0;
  if (streamBlocks === 0) {
    refuse("sim-batch-reasoning-stream-absent",
      `the transcript declares ${String(declaredBlocks)} resendable reasoning block(s) but`
      + " carries 0 `blockType:\"reasoning\"` stream entries; ADR-0045's two counts are"
      + " both evidence, and one of them is gone");
  }
  // Every assistant turn that carries a NON-BLANK reasoning part over the WHOLE
  // scoped recording must be one of the resendable blocks. The unresendable
  // rows already refused above, so this equality is the recount that catches a
  // turn the block count skipped — at every segment, not only at the pin.
  // CLASSIFICATION (item 12): once the unresendable rows refused, every
  // remaining reasoning turn IS one resendable block, so this equality is
  // `definitional`; it is kept as a recount, never reported as a passing
  // measurement (`CHECK_CLASSES`).
  const turns = timeline.reasoningTurns ?? declaredBlocks;
  if (turns !== declaredBlocks) {
    refuse("sim-batch-reasoning-turns",
      `the scoped recording carries ${String(turns)} assistant turn(s) with a reasoning`
      + ` part but only ${String(declaredBlocks)} resendable block(s); a turn the replay`
      + " cannot put back was counted as if it were gone (ADR-0045, ISSUE-195)");
  }
  // P4: a turn that lost its reasoning PARTS whole leaves no trace in either
  // count above — `reasoningTurns` counts turns that still carry a part and
  // `reasoningBlocks` is read off the same parts — so the two stay equal and the
  // loss is invisible. The turn's own STRUCTURAL echoes survive it: its
  // replay-state block and its stream block name a reasoning block the content
  // no longer carries. The scoped recording's assistant turns are counted beside
  // them (`assistantTurns`), so this gate compares the echo count to the part
  // count on ANY segment; at segment 139 the exact pins catch the same loss.
  const partTurns = timeline.reasoningPartTurns ?? declaredBlocks;
  const markedTurns = timeline.reasoningMarkedTurns ?? partTurns;
  if (markedTurns > partTurns) {
    refuse("sim-batch-reasoning-parts-lost",
      `the scoped recording echoes a reasoning block on ${String(markedTurns)} of its`
      + ` ${String(timeline.assistantTurns ?? 0)} assistant turn(s) (a replay-state or`
      + ` stream block) but only ${String(partTurns)} still carry a type:"reasoning"`
      + " content part; a turn whose part was dropped whole leaves the part and block"
      + " counts equal, so only this echo count sees it (ADR-0045)");
  }
  // P3: the COVERAGE is a gate, not a label. A source that lost reasoning on
  // half its turns symmetrically drops the part, the block and the echo
  // together, so every count above stays equal and the loss is invisible. The
  // ratio to the assistant-turn population only moves when turns are LOST.
  const assistantTurns = timeline.assistantTurns ?? 0;
  const coverageTurns = timeline.reasoningTurns ?? declaredBlocks;
  if (assistantTurns > 0) {
    const coverage = coverageTurns / assistantTurns;
    if (coverage < REASONING_TURN_COVERAGE_FLOOR) {
      refuse("sim-batch-reasoning-coverage",
        `the scoped recording carries reasoning on ${String(coverageTurns)} of ${String(assistantTurns)}`
        + ` assistant turn(s) (coverage ${coverage.toFixed(4)}), below the declared floor`
        + ` ${String(REASONING_TURN_COVERAGE_FLOOR)}; reasoning lost from a turn takes its`
        + " part, its block and its echo together, so every other ADR-0045 count stays"
        + " equal and only this ratio sees it (ADR-0045)");
    }
  }
  // The raw-recording reading is fire 0's: no answer has been applied, so the
  // unstamped `new Map()` is legal exactly there.
  const shown = surfaceAt({ timeline, fireStep: lastStepOf(timeline), surface: new Map(),
    fireIndex: 0 });
  const carried = shown.rows.filter(row =>
    row.kind === "assistant/message" && row.reasoning.length > 0);
  const bytes = carried.reduce((sum, row) => sum + Buffer.byteLength(row.reasoning, "utf8"), 0);
  if (carried.length !== declaredBlocks || bytes !== (timeline.reasoningBytes ?? 0)) {
    refuse("sim-batch-reasoning-pin",
      `the surface carries ${String(carried.length)} reasoning turns (${String(bytes)} B) but the`
      + ` transcript declares ${String(declaredBlocks)} (${String(timeline.reasoningBytes ?? 0)} B);`
      + " the replay lost the agent's reasoning (ADR-0045)");
  }
  return { blocks: carried.length, bytes, zeroDeclared: false, voidComparison: false };
}

/**
 * Refuse by name when the segment's measured decomposition drifts from the
 * pinned one. Called in plan mode before any send (and before any table prints).
 * The two paths carry their own pins: the default expects the host's 67 journals
 * and 67 replacements; the ignored path expects neither, and only the 201
 * landing appends. A count that differs refuses either run by name.
 *
 * The reasoning check runs on EVERY transcript, whatever its segment: declared
 * reasoning must be carried with the same turns and bytes, stored reasoning
 * with no resendable block refuses, and zero reasoning refuses unless
 * `allowZeroReasoning` records a void comparison (`assertReasoningCarried`).
 * The pinned world also carries the exact counts. The ISSUE-195 counts
 * (`type:"reasoning"` parts and `blockType:"reasoning"` stream entries) are
 * pinned for the pinned world too.
 *
 * The peak depth is a host figure. It is checked only on the host-pruner path,
 * whose world measured it. A pruner-off lane's depths come from the
 * reconstructed surface (`surfaceDepthAt`), so its peak is computed from those
 * bytes and pinned separately; the host series is recorded as contaminated.
 * Either peak is a REQUIRED pin: a pinned-world claim with an empty depth
 * series refuses (`sim-batch-pins-depth-absent`) instead of skipping the peak.
 *
 * A segment-139 claim is a claim about TWO NAMED FILES. The transcript hash is
 * the one `readTimeline` computed from the bytes it replayed; a timeline built
 * from a row array has none and REFUSES (`sim-batch-pins-rows-unpinned`), so a
 * caller cannot pass edited rows with the hash of the file it did not read.
 * `input.usageSha256` states the usage file's hash, and a claim that omits it
 * refuses. A stated transcript hash that differs from the bytes replayed
 * refuses. Without this a transcript edited consistently with its counts — a
 * same-length substitution inside the recording — sits in both the prompt and
 * the ruler and nothing sees it.
 */
/**
 * The two input hashes a run states, bound to the bytes they name (P2).
 *
 * The pins USED to be checked only inside the segment-139 block, so a run at
 * any other segment stated its input hashes and verified none of them. The
 * binding runs here, on EVERY segment:
 *
 * - a stated `transcriptSha256` must be the hash `readTimeline` computed from
 *   the path it replayed. A timeline built from a ROW ARRAY carries none and
 *   REFUSES (`sim-batch-pins-rows-unpinned`), so a caller cannot pass edited
 *   rows plus the hash of the file it did not read;
 * - a stated `usageSha256` must name the `usageFile` it is the hash of, and the
 *   file's own hash is recomputed. A hash with no file to hash refuses
 *   (`sim-batch-pins-usage-unpinned`); a hash that is not the file's own
 *   refuses (`sim-batch-pins-input-mismatch`), so an edited depth row cannot
 *   sit in both the prompt and the ruler.
 *
 * The segment-139 block then compares the same two hashes to `SEGMENT_PINS`,
 * which is a claim about one named pair of files, and still refuses a claim
 * that states no usage hash at all (`sim-batch-pins-input-absent`).
 */
function assertInputPins(timeline, input) {
  const statedTranscript = input?.transcriptSha256;
  if (statedTranscript !== undefined) {
    if (typeof timeline?.transcriptSha256 !== "string") {
      refuse("sim-batch-pins-rows-unpinned",
        "a stated transcript hash is a claim about the bytes replayed, but this timeline"
        + " was built from a row array, which carries no file hash. Pass the transcript PATH"
        + " to readTimeline/runLane so the hash is computed from the bytes the run reads;"
        + " a row array plus a stated hash could be rows from one file and the hash of another");
    }
    if (statedTranscript !== timeline.transcriptSha256) {
      refuse("sim-batch-pins-input-mismatch",
        `the stated transcriptSha256 ${String(statedTranscript)} is not the hash of the`
        + ` file that was read (${timeline.transcriptSha256}); a stated input hash names the`
        + " bytes it replayed");
    }
  }
  const statedUsage = input?.usageSha256;
  if (statedUsage !== undefined) {
    const usageFile = input?.usageFile;
    if (typeof usageFile !== "string" || usageFile === "") {
      refuse("sim-batch-pins-usage-unpinned",
        "a stated usageSha256 is a claim about a file, and this call names no usageFile to"
        + " hash. Pass { input: inputPinsOf({ transcript, usage }) } so the hash is"
        + " recomputed from the file it names, never trusted as a copied string");
    }
    if (!existsSync(usageFile)) {
      refuse("sim-batch-pins-input-absent",
        `the stated usageFile ${usageFile} is absent; a hash of a file that cannot be read`
        + " proves nothing");
    }
    const usageHash = fileSha256Of(usageFile);
    if (usageHash !== statedUsage) {
      refuse("sim-batch-pins-input-mismatch",
        `the stated usageSha256 ${String(statedUsage)} is not the hash of ${usageFile}`
        + ` (${usageHash}); a stated hash must be the file's own`);
    }
  }
}

/**
 * The checks that LOOK like pass/fail readings but cannot fail, recorded by
 * class so no reader counts them as evidence (twelfth audit item 12):
 *
 * - `asks-equal-triggers` (`sim-batch-live.mjs` `assertAskTotals`): both
 *   counters move in the same `fireOf` call path and a failed send still counts
 *   as an ask, so equality is a constructor property (`definitional`, never a
 *   measured comparison). Keeping the branch is a drift GUARD, not a pass.
 * - `reasoning-turns-equal-resendable-blocks` (`assertReasoningCarried`): every
 *   turn whose reasoning is not resendable has already refused, so each
 *   remaining reasoning turn is exactly one resendable block by construction.
 * - `pruner-off-prune-journals-zero` (`assertSegmentPins`): with the host trim
 *   off, the reader FILTERED every `compaction/prune` row out of the scoped
 *   rows, so the zero is structural; the world's own prune count is
 *   `replayedPrunes`, read before the filter.
 * - `surface-advanced-empty-decision-log` (`assertSurfaceAdvanced`): a fire with
 *   no answered decision rebuilds an EMPTY surface, so the size and digest
 *   comparisons read 0 against 0 and measure no body.
 * - `reasoning-in-prompt-zero-declared` (`assertReasoningInPrompt`): a
 *   zero-reasoning transcript has an empty expected pair list and an empty
 *   prompt list, so the ordered comparison confirms nothing.
 * - `carried-overrides-no-carries` (`assertCarriedOverrides`): a fire that
 *   carries no shaped seq has no carried body to compare byte for byte.
 *
 * `not-applicable` means the comparison has no counterexample in this code;
 * `definitional` means its two sides are the same set (or the same path)
 * counted twice.
 *
 * This catalog is DOCUMENTATION of the class only. The per-run field is
 * `measurement.checks` (`checkOutcomesOf` in `sim-batch-live.mjs`): one
 * `{name, class, outcome, count, countName}` per entry, where `outcome` is
 * `measured` when THIS run compared a non-empty population, `definitional` when
 * its two sides agree by construction over a non-empty population, and
 * `not-applicable` when it compared an empty set with itself; `count` is the
 * reading that decided it (fourteenth audit item 5).
 */
export const CHECK_CLASSES = Object.freeze([
  Object.freeze({ id: "asks-equal-triggers", class: "definitional",
    why: "asks and triggers move in the same fireOf path; equality is a guard" }),
  Object.freeze({ id: "reasoning-turns-equal-resendable-blocks", class: "definitional",
    why: "an unresendable reasoning turn refuses before the count is read" }),
  Object.freeze({ id: "pruner-off-prune-journals-zero", class: "not-applicable",
    why: "the pruner-off reader filtered the prune rows it then counts" }),
  Object.freeze({ id: "surface-advanced-empty-decision-log", class: "not-applicable",
    why: "no answered decision rebuilds an empty surface, so 0 is compared to 0" }),
  Object.freeze({ id: "reasoning-in-prompt-zero-declared", class: "not-applicable",
    why: "a zero-reasoning transcript has two empty pair lists to compare" }),
  Object.freeze({ id: "carried-overrides-no-carries", class: "not-applicable",
    why: "a fire that carries no shaped seq has no carried body to compare" }),
]);

export function assertSegmentPins(timeline, depths = [], { allowZeroReasoning = false,
  input = null } = {}) {
  const pins = surfacePinsOf(timeline, depths);
  const check = (name, got, want) => {
    if (got !== want) {
      refuse("sim-batch-pin", `${name} is ${String(got)}, pinned ${String(want)}; the run refuses`);
    }
  };
  // P2: a stated input hash is verified on every segment, not only at 139.
  assertInputPins(timeline, input);
  // P9: the two arithmetic IDENTITIES (`eligible = appends + replacements` and
  // `appends = neverPruned + prunedOriginals`) are definitions of
  // `eligibleSplitOf` over one array, so they cannot fail and are not printed as
  // checks. The checks below compare independent counts (pinned vs measured).
  const generic = [];
  if (pins.ignoreHostPrunes) {
    // No journal can name a replacement: the host trim did not run. A mounting
    // arm's own replacement rows still count, so no pairing is asserted.
    // CLASSIFICATION (item 12): both zeros below are `not-applicable`, because
    // this reader already FILTERED the prune rows out of `scoped`; the source
    // world's own count is `replayedPrunes` (read before the filter). See
    // `CHECK_CLASSES`.
    generic.push(["prune journals = 0", pins.pruneJournals, 0]);
    generic.push(["shadowed seqs = 0", pins.shadowedSeqs, 0]);
  } else {
    generic.push(["host replacements = prune journals", pins.pruneJournals, pins.hostReplacements]);
    generic.push(["shadowed seqs = prune journals", pins.shadowedSeqs, pins.pruneJournals]);
  }
  for (const [name, left, right] of generic) check(name, left, right);
  // ADR-0045 on EVERY transcript, whatever its segment: declared reasoning must
  // be carried, stored-but-unresendable reasoning refuses, and zero reasoning
  // refuses unless the run explicitly declares a void comparison.
  assertReasoningCarried(timeline, { allowZeroReasoning });
  if (timeline.segment === SEGMENT_PINS.segment) {
    const wanted = pins.ignoreHostPrunes ? IGNORED_SEGMENT_PINS : SEGMENT_PINS;
    // Everything below is a statement about these two files. The general
    // binding above already proved each stated hash is the hash it names; here
    // both are compared to the pinned pair.
    const transcriptSha256 = timeline.transcriptSha256;
    if (typeof transcriptSha256 !== "string") {
      refuse("sim-batch-pins-rows-unpinned",
        `a segment-${String(SEGMENT_PINS.segment)} claim is a claim about the bytes replayed,`
        + " but this timeline was built from a row array, which carries no file hash. Pass"
        + " the transcript PATH to readTimeline/runLane so the hash is computed from the"
        + " bytes the run reads");
    }
    const usageSha256 = input?.usageSha256 ?? null;
    if (usageSha256 === null) {
      refuse("sim-batch-pins-input-absent",
        `a segment-${String(SEGMENT_PINS.segment)} claim names the usage file too, and this`
        + " call names none. Pass { input: inputPinsOf({ transcript, usage }) } (or at"
        + " least { input: { usageSha256, usageFile } }) so an edited depth row is refused");
    }
    check("transcript sha256", transcriptSha256, wanted.transcriptSha256);
    check("usage sha256", usageSha256, wanted.usageSha256);
    // A pinned-world claim pins its PEAK. An empty depth series made the peak
    // checks below conditional, so a batch plan with an empty usage file passed
    // as a pinned claim while measuring no peak at all. Refuse it by name.
    if (!Array.isArray(depths) || depths.length === 0) {
      refuse("sim-batch-pins-depth-absent",
        `a segment-${String(SEGMENT_PINS.segment)} claim pins the peak depth, but this run`
        + " passed an empty depth series; a pinned claim without its ruler is not a claim."
        + " Pass the measured steps (readUsage of the usage file) or drop the segment pin");
    }
    check("eligible units", pins.eligible, wanted.eligible);
    check("append rows", pins.appends, wanted.appends);
    check("replacement rows", pins.replacements, wanted.replacements);
    check("pruned originals", pins.prunedOriginals, wanted.prunedOriginals);
    check("never-pruned appends", pins.neverPruned, wanted.neverPruned);
    check("prune journals", pins.pruneJournals, wanted.pruneJournals);
    check("header tools", pins.headerTools, wanted.headerTools);
    check("header tool bytes", pins.headerToolBytes, wanted.headerToolBytes);
    // ADR-0045 + ISSUE-195: the exact counts of the pinned world.
    check("reasoning blocks", pins.reasoningBlocks, wanted.reasoningBlocks);
    check("reasoning bytes", pins.reasoningBytes, wanted.reasoningBytes);
    check("reasoning turns", pins.reasoningTurns, wanted.reasoningTurns);
    check("reasoning parts", pins.reasoningParts, wanted.reasoningParts);
    check("reasoning stream blocks", pins.reasoningStreamBlocks, wanted.reasoningStreamBlocks);
    // The README's whole-FILE pair (271 / 271), pinned beside the segment's
    // 93 / 93 so the claim gates instead of sitting in prose (P8).
    check("whole-file reasoning parts", pins.fileReasoningParts, wanted.fileReasoningParts);
    check("whole-file reasoning stream blocks", pins.fileReasoningStreamBlocks,
      wanted.fileReasoningStreamBlocks);
    check("reasoning unresendable rows", pins.reasoningUnresendableRows, 0);
    if (!pins.ignoreHostPrunes) {
      check("segment peak depth", pins.peakDepth, wanted.peakDepth);
      check("segment peak step", pins.peakStep, wanted.peakStep);
    }
    if (pins.ignoreHostPrunes) {
      // The reconstructed world's own peak: every step built from the STAMPED
      // fire-0 surface (no product answer applied, so the pin is policy-free).
      // A bare `new Map()` would be the raw recording in disguise; the fire
      // index is stated so `surfaceAt` can refuse an unstamped map at all.
      const surfacePeaks = surfaceDepthSeries({ timeline, steps: depths.map(entry => entry.step),
        surface: simulateSurface(), fireIndex: 0 });
      const peak = surfacePeaks.reduce((best, entry) =>
        entry.tokens > best.tokens ? entry : best, { step: null, tokens: 0 });
      check("reconstructed surface peak depth", peak.tokens, wanted.surfacePeakDepth);
      check("reconstructed surface peak step", peak.step, wanted.surfacePeakStep);
    }
  }
  return pins;
}

/**
 * `result.json`'s `usage.rows` (or a bare `{rows}`): one depth per step.
 *
 * FIELD MEANINGS, read off the real default `result.json`
 * (`scratchpad/launch/2026-10-29-full-rerun/worlds/vanilla/evidence/result.json`,
 * session fab6632e). Its step-2 row (seq 24) is
 * `{inputTokens: 502, cacheReadTokens: 9088, outputTokens: 121, totalTokens: 9711}`:
 * 502 + 9,088 + 121 = 9,711, so `inputTokens` is the UNCACHED input and
 * `cacheReadTokens` is a separate, additive count. The depth is therefore
 * `inputTokens + cacheReadTokens` (9,590 at that step).
 *
 * A row that reports `cacheReadTokens > 0` must SAY how the cache relates to
 * `inputTokens`; the total arithmetic alone is not a statement, and inferring
 * the shape from it let a row whose `inputTokens` already contained the cache
 * report `totalTokens = inputTokens + cacheReadTokens + outputTokens` and
 * inflate the depth by exactly the cache count. The shape is read from a field:
 *
 * - `inputTokensIncludeCache: true` states the FOLDED shape: the cache sits
 *   inside `inputTokens`, so the depth is `inputTokens` alone. A total that
 *   contradicts it refuses (`sim-batch-usage-total-mismatch`).
 * - `inputTokensIncludeCache: false` states the ADDITIVE shape: the depth is
 *   `inputTokens + cacheReadTokens`.
 * - a provider prompt count on the row — `promptTokens`, `prompt_tokens` or the
 *   harness's `billedTokens` — states the same thing by number: equal to
 *   `inputTokens + cacheReadTokens` is additive, equal to `inputTokens` is
 *   folded, anything else refuses (`sim-batch-usage-prompt-mismatch`). The
 *   default world's rows carry `billedTokens` and pass this way.
 * - no statement at all refuses (`sim-batch-usage-cache-shape-unstated`), even
 *   when the totals look additive: a total that matches one convention cannot
 *   tell which convention the input count follows.
 *
 * A row with `cacheReadTokens: 0` still validates a stated prompt count: with
 * no cache the two shapes coincide, so the count must equal `inputTokens`
 * (`sim-batch-usage-prompt-mismatch`). That branch used to be skipped entirely
 * because it sat inside `if (cacheRead > 0)` (P5).
 *
 * The remaining total guards still run, now over the STATED shape: a total equal
 * to `inputTokens + outputTokens` for a row that states the additive shape
 * refuses (`sim-batch-usage-cache-included`), and a total that is neither shape
 * refuses (`sim-batch-usage-total-unexplained`). A `totalTokens` count is NOT
 * mandatory on every row: a row with `cacheReadTokens: 0` may state none, and a
 * folded-shape row may state none (`sim-batch-usage-total-absent` fires only for
 * a cache-bearing, non-folded row). A PRESENT `outputTokens`/`totalTokens` is a
 * non-negative integer, and every row names a REAL step (P3): `step >= 1` and
 * `inputTokens >= 0`, so a zero or negative step, which names no request,
 * refuses (`sim-batch-usage-invalid`) instead of becoming an anchor.
 *
 * A duplicate step refuses too: the depth series holds one reading per step,
 * never a silent last-wins overwrite.
 *
 * `readUsageOf` returns the parsed rows BESIDE the sha256 of the bytes they
 * were parsed from, so a launcher hashes one read (thirteenth audit item 5).
 * `readText` is the test seam; `readUsage` is the rows alone, the shape every
 * existing caller uses.
 */
export function readUsageOf(usage, { readText = readFileSync } = {}) {
  if (typeof readText !== "function") {
    refuse("sim-batch-usage-invalid", `readText must be a function, got ${String(readText)}`);
  }
  const bytes = typeof usage === "string" ? readText(usage, "utf8") : null;
  const text = bytes === null ? null
    : Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const raw = text === null ? usage : JSON.parse(text);
  const usageSha256 = text === null ? null
    : createHash("sha256").update(text, "utf8").digest("hex");
  const rows = Array.isArray(raw?.usage?.rows) ? raw.usage.rows
    : Array.isArray(raw?.rows) ? raw.rows : null;
  if (rows === null) refuse("sim-batch-usage-invalid", "usage is a result.json or a bare {rows: [...]}");
  const byStep = new Map();
  for (const row of rows) {
    const cacheRead = row?.cacheReadTokens ?? 0;
    if (!Number.isSafeInteger(row?.step) || !Number.isSafeInteger(row?.inputTokens)
      || !Number.isSafeInteger(cacheRead) || cacheRead < 0) {
      refuse("sim-batch-usage-invalid", `a usage row needs step, inputTokens, cacheRead: ${JSON.stringify(row)}`);
    }
    // P3: a reading exists at a STEP, so the step is a positive integer and the
    // counts cannot be negative. `Number.isSafeInteger` alone accepted step 0,
    // step -3 and a negative input count, and the series then compared a
    // provider count to an anchor no request ever had.
    if (row.step < 1) {
      refuse("sim-batch-usage-invalid",
        `step ${String(row.step)} is not a step: a measured reading sits at step >= 1, and`
        + " a zero or negative step names no request");
    }
    if (row.inputTokens < 0) {
      refuse("sim-batch-usage-invalid",
        `step ${String(row.step)} reports inputTokens ${String(row.inputTokens)}; a token`
        + " count is never negative");
    }
    for (const [name, value] of [["outputTokens", row?.outputTokens],
      ["totalTokens", row?.totalTokens]]) {
      if (value !== undefined && value !== null
        && (!Number.isSafeInteger(value) || value < 0)) {
        refuse("sim-batch-usage-invalid",
          `step ${String(row.step)} reports ${name} ${String(value)}; an absent count stays`
          + " absent and a present one is a non-negative integer");
      }
    }
    if (byStep.has(row.step)) {
      refuse("sim-batch-usage-duplicate",
        `step ${String(row.step)} appears twice in usage.rows; the depth series holds one`
        + " reading per step, so a duplicate is refused rather than overwritten");
    }
    const outputTokens = row?.outputTokens;
    const totalTokens = row?.totalTokens;
    const totalPresent = Number.isSafeInteger(totalTokens);
    const outputPresent = Number.isSafeInteger(outputTokens);
    const declaredFolded = row?.inputTokensIncludeCache === true;
    const declaredAdditive = row?.inputTokensIncludeCache === false;
    // The row's own prompt count, under any of the names a provider (or the
    // harness) writes it: `promptTokens`, the wire's `prompt_tokens`, or the
    // real result.json's `billedTokens` (= inputTokens + cacheReadTokens).
    // Twelfth audit item 8: a PRESENT but invalid count used to fall through to
    // `null` and read as absent, so a negative or string `promptTokens` passed.
    // A present count is a non-negative safe integer, or the row refuses.
    for (const [name, value] of [["promptTokens", row?.promptTokens],
      ["prompt_tokens", row?.prompt_tokens], ["billedTokens", row?.billedTokens]]) {
      if (value !== undefined && value !== null
        && (!Number.isSafeInteger(value) || value < 0)) {
        refuse("sim-batch-usage-invalid",
          `step ${String(row.step)} reports ${name} ${JSON.stringify(value)}; a present`
          + " prompt count is a non-negative safe integer, and an invalid one is never"
          + " read as absent");
      }
    }
    const promptTokens = Number.isSafeInteger(row?.promptTokens) ? row.promptTokens
      : Number.isSafeInteger(row?.prompt_tokens) ? row.prompt_tokens
      : Number.isSafeInteger(row?.billedTokens) ? row.billedTokens : null;
    // P5: a row with NO cache still states what its prompt count means. Before
    // this check the whole stated-shape block sat inside `cacheRead > 0`, so
    // `{inputTokens: 502, prompt_tokens: 9_590, cacheReadTokens: 0}` passed with
    // depth 502 while its own provider count said 9,590. With no cache the
    // additive and folded shapes are the same number, so a prompt count must
    // equal `inputTokens`.
    if (cacheRead === 0 && promptTokens !== null && promptTokens !== row.inputTokens) {
      refuse("sim-batch-usage-prompt-mismatch",
        `step ${String(row.step)} reports no cache (cacheReadTokens 0), so its prompt count`
        + ` ${String(promptTokens)} must equal inputTokens ${String(row.inputTokens)};`
        + " the row contradicts itself about the depth it measured");
    }
    const foldedTotal = row.inputTokens + (outputPresent ? outputTokens : 0);
    const additiveTotal = foldedTotal + cacheRead;
    // The shape the ROW STATES, never one inferred from the totals (P8).
    let folded = cacheRead > 0 && declaredFolded;
    // P5: WHAT corroborates the shape, recorded per reading. A row whose shape
    // rests on its own `inputTokensIncludeCache` statement and no independent
    // reading is not refused — the statement is a statement — but its step is
    // named in the run's reason list (`usage-shape-unverified:<n>`), so the
    // depth can never read as corroborated when it is not.
    let shapeBasis = cacheRead === 0 ? "no-cache" : "statement";
    if (cacheRead > 0) {
      if (promptTokens !== null) {
        if (declaredFolded && promptTokens !== row.inputTokens) {
          refuse("sim-batch-usage-prompt-mismatch",
            `step ${String(row.step)} states inputTokensIncludeCache: true, so its prompt`
            + ` count ${String(promptTokens)} must equal inputTokens ${String(row.inputTokens)};`
            + " the row contradicts itself about what its input count contains");
        }
        if (declaredAdditive && promptTokens !== row.inputTokens + cacheRead) {
          refuse("sim-batch-usage-prompt-mismatch",
            `step ${String(row.step)} states inputTokensIncludeCache: false, so its prompt`
            + ` count ${String(promptTokens)} must equal inputTokens + cacheReadTokens`
            + ` (${String(row.inputTokens + cacheRead)}); the row contradicts itself`);
        }
        if (!declaredFolded && !declaredAdditive) {
          if (promptTokens === row.inputTokens) folded = true;
          else if (promptTokens !== row.inputTokens + cacheRead) {
            refuse("sim-batch-usage-prompt-mismatch",
              `step ${String(row.step)} reports promptTokens/billedTokens`
              + ` ${String(promptTokens)}, which is neither inputTokens`
              + ` ${String(row.inputTokens)} (folded) nor inputTokens + cacheReadTokens`
              + ` (${String(row.inputTokens + cacheRead)}, additive); the row states no`
              + " cache shape that its own prompt count agrees with");
          }
        }
        shapeBasis = "prompt-count";
      }
      if (!folded && !declaredAdditive && promptTokens === null) {
        refuse("sim-batch-usage-cache-shape-unstated",
          `step ${String(row.step)} reports cacheReadTokens ${String(cacheRead)} but no`
          + " field says whether inputTokens already contains it:"
          + " `inputTokensIncludeCache: true|false` or a prompt count"
          + " (`promptTokens`/`prompt_tokens`/`billedTokens`) is required. Total arithmetic"
          + " alone cannot tell the additive row from a folded row whose total happens to"
          + " add the cache a second time, which would inflate the depth by the cache count");
      }
      if (!totalPresent && !folded) {
        refuse("sim-batch-usage-total-absent",
          `step ${String(row.step)} reports cacheReadTokens ${String(cacheRead)} but no`
          + " totalTokens; without it the row cannot be checked against its own shape."
          + " Add totalTokens, or state `inputTokensIncludeCache: true`");
      }
      if (!outputPresent && !folded) {
        refuse("sim-batch-usage-output-absent",
          `step ${String(row.step)} reports cacheReadTokens ${String(cacheRead)} and`
          + ` totalTokens ${String(totalTokens)} but no outputTokens; without it the row`
          + " cannot be checked against either total shape. Add outputTokens, or"
          + " state `inputTokensIncludeCache: true`");
      }
    }
    // P4: the total guards below run on EVERY row, cache-bearing or not. They
    // used to sit inside `cacheRead > 0`, so `{inputTokens: 502,
    // cacheReadTokens: 0, totalTokens: 9999}` passed with depth 502 while its
    // own total explained neither shape. With no cache the folded and additive
    // totals are the same number, and that is the only number a total may be.
    if (outputPresent) {
      if (cacheRead > 0 && totalPresent && folded && totalTokens !== foldedTotal) {
        refuse("sim-batch-usage-total-mismatch",
          `step ${String(row.step)} states the folded cache shape, so totalTokens`
          + ` ${String(totalTokens)} must equal inputTokens + outputTokens`
          + ` (${String(foldedTotal)}); the row contradicts itself about what its input`
          + " count contains");
      }
      if (cacheRead > 0 && totalPresent && !folded
        && totalTokens === row.inputTokens + outputTokens) {
        refuse("sim-batch-usage-cache-included",
          `step ${String(row.step)}: totalTokens ${String(totalTokens)} = inputTokens`
          + ` ${String(row.inputTokens)} + outputTokens ${String(outputTokens)} while`
          + ` cacheReadTokens is ${String(cacheRead)}; inputTokens already contains the cached`
          + " tokens, so inputTokens + cacheReadTokens would double-count the depth");
      }
      // A total that is neither the folded shape nor the additive shape
      // explains neither count. It used to be read as additive, which
      // invented a depth no field in the row states.
      if (totalPresent && !folded && totalTokens !== foldedTotal
        && totalTokens !== additiveTotal) {
        refuse("sim-batch-usage-total-unexplained",
          `step ${String(row.step)}: totalTokens ${String(totalTokens)} is neither`
          + ` inputTokens + outputTokens (${String(foldedTotal)}) nor inputTokens +`
          + ` cacheReadTokens + outputTokens (${String(additiveTotal)}); the row does not`
          + " say where the cache sits, and neither total can be inferred");
      }
      // A prompt count is the stronger reading: it states the depth directly.
      // The totals stand in only when the row states no prompt count.
      if (totalPresent && cacheRead > 0 && shapeBasis === "statement") shapeBasis = "totals";
    } else if (totalPresent && folded && totalTokens !== row.inputTokens) {
      // The folded shape with no outputTokens: the total can only be the
      // input count, because there is no output count to add.
      refuse("sim-batch-usage-total-mismatch",
        `step ${String(row.step)} states inputTokensIncludeCache: true and reports no`
        + ` outputTokens, so totalTokens ${String(totalTokens)} must equal inputTokens`
        + ` ${String(row.inputTokens)}; the row contradicts itself about what its input`
        + " count contains");
    } else if (totalPresent && !folded && totalTokens !== row.inputTokens) {
      // P4: a cache-free row with a total and no output count. `folded` is false
      // and both shapes are `inputTokens`, so any other total explains nothing.
      refuse("sim-batch-usage-total-unexplained",
        `step ${String(row.step)}: totalTokens ${String(totalTokens)} is neither`
        + ` inputTokens + outputTokens (${String(foldedTotal)}) nor inputTokens +`
        + ` cacheReadTokens + outputTokens (${String(additiveTotal)}); with no cache both`
        + " shapes are the same number, and this total is not it");
    }
    byStep.set(row.step, { tokens: folded && cacheRead > 0
      ? row.inputTokens : row.inputTokens + cacheRead, shapeBasis });
  }
  return { usageSha256,
    depths: [...byStep.entries()].map(([step, reading]) => ({ step, tokens: reading.tokens,
      shapeBasis: reading.shapeBasis }))
      .sort((left, right) => left.step - right.step) };
}

/** The measured depths alone: the shape every existing caller reads. */
export function readUsage(usage) {
  return readUsageOf(usage).depths;
}

/** The measured steps the segment keeps; no later depth moves a lane's series. */
export function depthsInSegment(depths, segment) {
  if (segment === null || segment === undefined) return depths;
  return depths.filter(entry => entry.step <= segment);
}

/**
 * P3: every depth reading must be a step the TRANSCRIPT declares, and every step
 * the transcript declares IN SCOPE must have a reading. `readUsage` proves each
 * row is a positive step with non-negative counts, but not that the step ever
 * existed. The ruler is the recording's own `step/start` steps
 * (`readTimeline`'s `stepStarts`).
 *
 * P5: the second half was missing. A series that SKIPPED a declared step passed,
 * because only the series' own steps were checked against the ruler; a trigger
 * then ran on a depth series with a hole in it. The declared steps in scope
 * (`step <= timeline.segment` for a cut run, every step otherwise) must all
 * have a reading, and a missing one refuses by name. A series that simply stops
 * early is the same hole, named by its first missing step.
 *
 * The returned record also names the steps whose depth rests on the row's own
 * cache-shape statement with no independent reading (`statedOnlySteps`), so the
 * run can carry `usage-shape-unverified:<n>` instead of trusting it silently.
 *
 * A transcript that declares NO step boundary at all (`stepStarts` empty) has no
 * ruler to pin against, so a non-empty depth series over it refuses by name
 * rather than checking nothing. A synthetic row array declares its steps with
 * `step/start` rows exactly as a real recording does; the tests that build one
 * add them (`withStepStarts` in the test file).
 */
export function assertUsageStepsPinned(timeline, depths) {
  const declared = new Set(timeline?.stepStarts ?? []);
  const series = Array.isArray(depths) ? depths : [];
  const statedOnlySteps = series.filter(entry => entry?.shapeBasis === "statement")
    .map(entry => entry.step);
  if (series.length === 0) {
    return { declared: declared.size, checked: 0, pinned: false, statedOnlySteps: [] };
  }
  if (declared.size === 0) {
    refuse("sim-batch-usage-step-unpinned",
      `the depth series carries ${String(series.length)} reading(s) but the transcript`
      + " declares no step/start, so no reading can be pinned to a request; a ruler with"
      + " no step in the recording is not the run's ruler");
  }
  const missing = [...new Set(series.map(entry => entry.step)
    .filter(step => !declared.has(step)))];
  if (missing.length > 0) {
    refuse("sim-batch-usage-step-unpinned",
      `the depth series reads step ${missing.slice(0, 8).join(", ")}`
      + `${missing.length > 8 ? ", ..." : ""}, which the transcript's own step/start rows`
      + " never declare; a reading at a step no request reached is not a measured depth");
  }
  // P5: the declared steps IN SCOPE, and the series must cover all of them. A
  // segment cut is a stated cut: steps after it are out of scope by definition.
  const segment = Number.isSafeInteger(timeline?.segment) ? timeline.segment : null;
  const inScope = [...declared].filter(step => segment === null || step <= segment)
    .sort((left, right) => left - right);
  const read = new Set(series.map(entry => entry.step));
  const holes = inScope.filter(step => !read.has(step));
  if (holes.length > 0) {
    refuse("sim-batch-usage-step-hole",
      `the depth series reads ${String(series.length)} of the ${String(inScope.length)} step(s)`
      + ` the recording declares${segment === null ? "" : ` up to step ${String(segment)}`};`
      + ` step ${holes.slice(0, 8).join(", ")}${holes.length > 8 ? ", ..." : ""} has no`
      + " reading, so the series the trigger runs on has a hole");
  }
  return { declared: declared.size, checked: series.length, pinned: true,
    statedOnlySteps };
}

/** One unit as the renderer's moment; the lane reads no bit of it. */
function momentOf(unit, timeline, lane) {
  return {
    id: unit.id, lane, seq: unit.seq, step: unit.step,
    session: timeline.session, original: { text: unit.text },
  };
}

/** The lane's moments in `eligibleOf` order, as the renderer reads them. */
function momentsOf(units, timeline, lane) {
  return units.map(unit => momentOf(unit, timeline, lane));
}

/**
 * One ask's rows, each answered by the producer in arrival order. Every decision
 * STATES its landing step, computed by the SAME rule the live lane applies:
 * `clampDecisionStep(unit.step + 1, fireStep)`. A batch answer never removes
 * bytes before the fire that asked it, and a unit that landed before the fire
 * books there; a unit that landed after the fire's own step (impossible in a
 * lane, but stated) keeps its own next step. Both paths therefore book one step.
 */
function decisionsOf(batches, byId, producer) {
  const decisions = [];
  batches.forEach((batch, batchIndex) => batch.ids.forEach((id, index) => {
    const unit = byId.get(id);
    const raw = producer.decide({ unit, index, batchIndex, batch }) ?? {};
    // `fireStep` is the decision's own fire: the independent surface rebuild
    // (P7, P10) replays the log in order and must know which host prunes were
    // in force when this answer landed.
    decisions.push({ step: clampDecisionStep(unit.step + 1, batch.step), ...raw,
      momentId: id, fireStep: batch.step });
  }));
  return decisions;
}

/**
 * The bytes a shaped turn actually removes from the context: its gross drop
 * (`original − kept`) MINUS the summary, the marker lines (`gaps × markerBytes`)
 * and the framing the shaped turn still occupies. A trim that adds a summary can
 * be net larger than the body it replaced; the net figure is negative then, and
 * `bytesFreedByPolicy`, the host depth subtraction and the baseline all use it.
 * `bytesFreedGross` is recorded beside it so the two are never conflated.
 */
export function netDroppedOf(row) {
  if (row?.shaped !== true) return 0;
  const terms = row.terms ?? {};
  const markers = (terms.markerBytes ?? 0) * (row.gaps ?? 0);
  return (terms.dropped ?? 0) - (terms.summary ?? 0) - markers - (terms.framing ?? 0);
}

/** `ceil(|bytes|/3.04)` with the sign kept: a net-negative delta ADDS depth. */
export function signedMeasuredTokensOf(bytes) {
  if (!Number.isSafeInteger(bytes)) {
    refuse("sim-batch-bytes-invalid", `a byte count is a safe integer, got ${String(bytes)}`);
  }
  return bytes < 0 ? -measuredTokensOf(-bytes) : measuredTokensOf(bytes);
}

/**
 * The plan both trigger modes report: cadence counts, the answers' removal
 * union, and the depth series with `τ` applied once per summed byte delta.
 *
 * `depthSource` is the lane's stated source. On the host path the series is
 * `result.json`'s measured depth minus the policy's own removals. On the
 * reconstructed-surface path the series is built from the SIMULATED surface at
 * every step (`surfaceDepthAt`): the shaped turns are already in those bytes,
 * so no separate subtraction runs, and the host series rides beside it labelled
 * `contaminated: true` (the host trim shaped it).
 */
function renderPlanOf({ timeline, depths, lane, units, decisions, mode, threshold,
  thresholdUnits = null, triggers, fireSteps, fireBatches, carried, semantics = null,
  depthSource = HOST_DEPTH_SOURCE, eligibleResults = null, askableResults = null,
  hostPrunedEligible = null, hostPrunedBeforeLanding = 0, askableBeforePrune = 0,
  prunedBeforeAsk = 0, eligibleSplit = null, askableSplit = null }) {
  const rendered = renderLane({ lane, decisions, moments: momentsOf(units, timeline, lane) });
  // The union: a shape is the policy's removal for the window it stood. A unit
  // the host removes LATER than the shape was booked is credited; a unit the
  // host had already removed when the answer landed is not.
  const policyRows = rendered.rows.filter(row => {
    if (!row.shaped) return false;
    if (!Number.isSafeInteger(row.seq)) return true;
    const pruneStep = hostPruneStepOf(timeline, row.seq);
    return pruneStep === null
      || (row.decisionStep !== null && row.decisionStep < pruneStep);
  });
  // Net is the authority: gross `dropped` ignores the summary, the marker lines
  // and the framing the shaped turn still occupies, so a trim that adds a
  // summary can be net larger and still look like a saving.
  const bytesFreedByPolicy = policyRows.reduce((sum, row) => sum + netDroppedOf(row), 0);
  const bytesFreedGross = policyRows.reduce((sum, row) => sum + row.terms.dropped, 0);
  const removals = policyRows.map(row => ({
    step: row.decisionStep, bytes: netDroppedOf(row),
    pruneStep: Number.isSafeInteger(row.seq) ? hostPruneStepOf(timeline, row.seq) : null,
  }));
  // A credited removal is visible in the measured series only until the host's
  // own prune removes the body anyway: after that the host series already lost
  // those bytes, so subtracting the policy's window again would double-count.
  const inWindow = (removal, step) => removal.step < step
    && (removal.pruneStep === null || step < removal.pruneStep);
  let depthOverflow = false;
  let series;
  if (depthSource === SURFACE_DEPTH_SOURCE) {
    const shaped = policyRows
      .filter(row => Number.isSafeInteger(row.seq) && row.decisionStep !== null)
      .sort((left, right) => left.decisionStep - right.decisionStep);
    // A REAL reconstructed surface: the stamped constructor, advanced once per
    // step that applied shaped turns. A bare Map let a caller read the raw
    // recording and call it the reconstructed surface.
    const surface = simulateSurface();
    let fireIndex = 0;
    let at = 0;
    series = depths.map(entry => {
      let applied = false;
      while (at < shaped.length && shaped[at].decisionStep < entry.step) {
        surface.set(shaped[at].seq, shaped[at].after);
        at += 1;
        applied = true;
      }
      if (applied) {
        fireIndex += 1;
        advanceSurfaceFire(surface);
      }
      const reading = surfaceDepthBefore({ timeline, step: entry.step, surface, fireIndex });
      // `removed` is the net bytes this surface still credits at this step: the
      // shape stops counting once the host's own prune has removed the body.
      const removed = shaped.reduce((sum, row) => {
        if (row.decisionStep >= entry.step) return sum;
        const pruneStep = hostPruneStepOf(timeline, row.seq);
        return pruneStep !== null && entry.step >= pruneStep ? sum : sum + netDroppedOf(row);
      }, 0);
      // The depth is net BY CONSTRUCTION, so nothing subtracts `removed` again:
      // recording it beside the depth (instead of 0) stops the series from
      // reading as "the policy removed nothing" while `bytesFreedByPolicy` is
      // large.
      return { step: entry.step, measured: reading.tokens, removed, depth: reading.tokens,
        removedInDepth: true };
    });
    // P10: the plan's own depth series is written into a FRESH surface by a
    // second writer, so it gets the live lane's gate too. The expected map is
    // rebuilt from the decision log alone, restricted to the decisions this
    // series has applied (a shape shows from the step AFTER its answer, so a
    // decision at the last measured step is not in the final surface). Digest
    // and CURRENT size are compared; a wrong body or a dropped turn moves one.
    if (depths.length > 0) {
      const lastStep = depths[depths.length - 1].step;
      const applied = (decisions ?? []).filter(decision =>
        Number.isSafeInteger(decision?.step) && decision.step < lastStep);
      const rebuilt = reconstructedSurfaceOf({ timeline, units, decisions: applied, lane });
      const got = surfaceDigestOf(surface);
      const want = surfaceDigestOf(rebuilt);
      if (got !== want) {
        refuse("sim-batch-surface-digest",
          `the plan's depth surface (lens up to step ${String(lastStep)}) hashes to ${got}`
          + ` but the decision log's rebuilt surface hashes to ${want}; the plan writes its`
          + " depths from a second writer, so without this check a wrong shaped body would"
          + " pass a count and move every later depth");
      }
      if (surfaceSizeOf(surface) !== rebuilt.size) {
        refuse("sim-batch-surface-removals",
          `the plan's depth surface currently holds ${String(surfaceSizeOf(surface))} shaped turn(s) but its`
          + ` decision log rebuilds ${String(rebuilt.size)}; the depth series and the log`
          + " describe different surfaces");
      }
    }
  } else {
    // A policy can out-free the measured depth (a stale depth row); the series is
    // clamped at zero and the overflow is flagged rather than showing a negative
    // window, which no real context ever has.
    series = depths.map(entry => {
      let removed = 0;
      for (const removal of removals) if (inWindow(removal, entry.step)) removed += removal.bytes;
      const raw = entry.tokens - signedMeasuredTokensOf(removed);
      if (raw < 0) depthOverflow = true;
      return { step: entry.step, measured: entry.tokens, removed, depth: Math.max(raw, 0) };
    });
  }
  const contaminated = depthSource === SURFACE_DEPTH_SOURCE;
  return {
    mode, threshold,
    // Only a threshold lane has a unit; a batch plan keeps today's exact shape.
    ...(thresholdUnits === null ? {} : { thresholdUnits }),
    semantics, depthOverflow, lane, triggers, asks: triggers,
    // The ELIGIBLE population (a pin's number) and the ASKABLE stream the
    // fires ran over: every eligible unit that was on the surface at its own
    // landing step. A unit a host prune removed LATER was askable then.
    eligibleResults: eligibleResults ?? units.length,
    askableResults: askableResults ?? units.length,
    hostPrunedEligible: hostPrunedEligible ?? 0,
    hostPrunedBeforeLanding,
    askableBeforePrune,
    // Of the askable units, the ones the host pruned before any fire tabled
    // them. They are part of `carried` (never asked) and named here so the hole
    // names its causes. No `asked` field exists: `asks` counts fires, and a
    // difference of counts here would be a claim nobody computes.
    prunedBeforeAsk,
    // The population's own split (a total is never printed without its parts)
    // and the ask stream's, which drops only units removed before they landed.
    eligibleSplit: eligibleSplit ?? eligibleSplitOf(timeline, units),
    askableSplit: askableSplit ?? eligibleSplitOf(timeline, units),
    carried, hostPrunes: timeline.hostPrunes.length, hostTokens: timeline.hostTokens,
    // The ignored path's provenance: what the world would have carried, and did
    // not. All three are 0 on the default path.
    ignoreHostPrunes: timeline.ignoreHostPrunes === true,
    hostPrunesIgnored: timeline.hostPrunesIgnored ?? 0,
    hostTokensIgnored: timeline.hostTokensIgnored ?? 0,
    hostReplacementsIgnored: timeline.hostReplacementsIgnored ?? 0,
    reconstruction: timeline.reconstruction === true,
    bytesFreedByPolicy, bytesFreedGross,
    compactionStep: timeline.compaction === null ? null : timeline.compaction.step,
    fireSteps, fireBatches,
    depthSource,
    // The host's own series, kept as provenance. A pruner-off lane never
    // triggers on it; `contaminated` says why.
    hostDepths: { source: HOST_DEPTH_SOURCE, contaminated,
      ...(contaminated ? { reason: "measured while the host tool-result pruner was active" } : {}),
      rows: depths },
    depthSeries: series.length === 0 ? null : {
      first: series[0].depth, peak: Math.max(...series.map(point => point.depth)),
      last: series[series.length - 1].depth,
    },
    series,
  };
}

/** One lane's plan: batch cadence, answers, the removal union, adjusted depths. */
export function planLane({ timeline, depths, lane, floor = FLOOR_BYTES, producer = STUB_PRODUCER,
  depthSource = null }) {
  if (!Number.isSafeInteger(lane) || lane < 1) {
    refuse("sim-batch-lane-invalid", `a lane is a positive integer, got ${String(lane)}`);
  }
  // P11: a plan with no measured step has no ruler. It used to print
  // `freed N B net ... depth -` from the renderer alone, a removal figure no
  // depth ever measured; the threshold plan has refused this all along. A batch
  // plan that only needs its fire schedule still states the steps it read (a
  // one-step series is enough), so the refusal costs nothing real.
  if (!Array.isArray(depths) || depths.length === 0) {
    refuse("sim-batch-depth-absent",
      "a batch plan needs at least one measured step; a plan with no ruler cannot print a"
      + " freed number");
  }
  const source = assertDepthSource(depthSource ?? defaultDepthSource(timeline.ignoreHostPrunes),
    timeline.ignoreHostPrunes === true);
  const eligible = eligibleOf(timeline, floor);
  // The ask stream is TIME-AWARE: a host prune removes a unit from the surface
  // for fires AFTER the prune's own step, so a unit pruned later is askable at
  // an earlier fire. Only a unit removed STRICTLY BEFORE its own landing step
  // is never askable (it never reached the surface); a prune on the landing
  // step itself runs after that step's fire, so the row is tabled there.
  const units = askableOf(timeline, floor);
  // A lane over zero units measures nothing: the plan path refuses by name
  // instead of letting the renderer's no-moments refusal stand in for it.
  if (units.length === 0) {
    refuse("sim-batch-eligible-empty",
      `no eligible unit at floor ${String(floor)} B; a plan over nothing is not a measurement`);
  }
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const seqById = new Map(units.map(unit => [unit.id, unit.seq]));
  let state = { pending: [] };
  const batches = [];
  /** Units that were askable but a host prune removed before any fire tabled
   * them: never asked, so they belong to `carried`. */
  let prunedBeforeAsk = 0;
  // A pending id whose seq the host had removed by this unit's step can never
  // be tabled again: drop it before the cadence counts the next batch.
  const dropRemoved = step => {
    const removed = hostRemovedAt(timeline, step);
    const held = state.pending.filter(id => !removed.has(seqById.get(id)));
    prunedBeforeAsk += state.pending.length - held.length;
    if (held.length !== state.pending.length) state = { pending: held };
  };
  for (const unit of units) {
    dropRemoved(unit.step);
    const verdict = batchVerdict(state, lane, unit.id);
    state = verdict.state;
    if (verdict.kind === "fire") batches.push({ ids: [...verdict.batch], step: unit.step });
  }
  dropRemoved(timeline.segment ?? (units[units.length - 1]?.step ?? 0));
  const counts = askableCountsOf(timeline, eligible, units);
  return {
    ...renderPlanOf({ timeline, depths, lane, units,
      decisions: decisionsOf(batches, byId, producer), mode: "batch", threshold: null,
      triggers: batches.length, fireSteps: batches.map(batch => batch.step),
      fireBatches: batches.map(batch => batch.ids),
      carried: state.pending.length + prunedBeforeAsk,
      depthSource: source, eligibleResults: eligible.length, askableResults: units.length,
      hostPrunedEligible: counts.hostPrunedEligible,
      hostPrunedBeforeLanding: counts.hostPrunedBeforeLanding,
      askableBeforePrune: counts.askableBeforePrune,
      prunedBeforeAsk,
      eligibleSplit: eligibleSplitOf(timeline, eligible),
      askableSplit: eligibleSplitOf(timeline, units) }),
    baselineDepth: null,
    eligibility: eligibilityOf(timeline, floor),
  };
}

/**
 * The threshold trigger's verdict, beside core's `batchVerdict` and equally
 * pure: fire once the CURRENT depth has grown by `threshold` tokens since the
 * last fire, and only when there is work to ask about. A crossing over an empty
 * pending stream holds and moves no checkpoint, so no ask is ever sent with no
 * rows, and the work that arrives later fires at once instead of waiting for a
 * second growth of `threshold`.
 */
/**
 * When a live ask's answer applies. `renderMoment`'s fallback books a removal
 * at the unit's own step plus one, which is right for an inline ask but WRONG
 * for a batch: a unit from step 30 answered in a fire at step 50 was removed
 * when the answer landed, at 50, not at 31. A fire never books earlier than
 * itself; an answer that already lands after the fire keeps its step.
 */
export function clampDecisionStep(decisionStep, fireStep) {
  if (!Number.isSafeInteger(decisionStep) || !Number.isSafeInteger(fireStep)) {
    refuse("sim-batch-step-invalid",
      `steps are safe integers, got ${String(decisionStep)} and ${String(fireStep)}`);
  }
  return Math.max(decisionStep, fireStep);
}

export function thresholdVerdict({ depth, lastFireDepth, threshold, pending = 0,
  firstFireDepth = null }) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    refuse("sim-batch-threshold-invalid",
      `a threshold is a positive integer, got ${String(threshold)}`);
  }
  if (firstFireDepth !== null && (!Number.isSafeInteger(firstFireDepth) || firstFireDepth < 1)) {
    refuse("sim-batch-first-fire-depth-invalid",
      `a first fire depth is a positive integer, got ${String(firstFireDepth)}`);
  }
  const delta = depth - lastFireDepth;
  // The first fire can demand an absolute depth floor instead of a delta. The
  // caller passes `firstFireDepth` only while the first fire is still pending;
  // after that fire it passes null and the lane threshold governs.
  const fires = firstFireDepth === null ? delta >= threshold : depth >= firstFireDepth;
  return pending > 0 && fires
    ? { kind: "fire", delta } : { kind: "hold", delta };
}

/**
 * Where the next window measures from, after a fire. `incremental` (the default,
 * owner ruling 2026-10-31) backs the baseline off by the fire's OWN applied
 * removals — τ once on their summed bytes — so the next fire needs `threshold`
 * more growth measured from the post-removal depth. `growth` and `absolute` keep
 * the pre-removal depth, so every shave R stretches the interval to
 * `threshold + R`: the depth lane's self-extinguish flaw. τ of 0 is 0, so a fire
 * that removed nothing leaves both semantics identical.
 */
export function nextBaselineDepth({ depth, removalBytes = 0,
  semantics = DEFAULT_THRESHOLD_SEMANTICS }) {
  if (!Number.isSafeInteger(depth)) {
    refuse("sim-batch-step-invalid", `a depth is a safe integer, got ${String(depth)}`);
  }
  // Signed: a trim that saves nothing (a summary and markers cost more than the
  // body) ADDS bytes, so the next window measures from a higher depth. The
  // magnitude is τ once on the net sum, never per term.
  if (!Number.isSafeInteger(removalBytes)) {
    refuse("sim-batch-step-invalid",
      `removal bytes is a safe integer (net may be negative), got ${String(removalBytes)}`);
  }
  if (!THRESHOLD_SEMANTICS.includes(semantics)) {
    refuse("sim-batch-threshold-semantics-invalid",
      `semantics takes ${THRESHOLD_SEMANTICS.join(" or ")}, got ${String(semantics)}`);
  }
  return semantics === "incremental" ? depth - signedMeasuredTokensOf(removalBytes) : depth;
}

/**
 * The landed-bytes trigger is CORE's function, not a local copy (P6):
 * `@cremator/core` exports `landedBytesVerdict` from
 * `packages/core/src/entry/landed-bytes-trigger.ts`, and this module calls it.
 * The wrapper maps the two argument errors onto this sim's named refusals; the
 * PREDICATE (`pending > 0 && landedBytes >= threshold`) is never re-implemented
 * here, so a change to the shipped rule reaches every plan and lane at once.
 * `sim-batch-units.test.mjs` also compares this export to core's over a shared
 * case grid, so the two can never drift apart silently.
 */
export function landedBytesVerdict({ landedBytes, threshold, pending = 0 } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    refuse("sim-batch-threshold-invalid",
      `a threshold is a positive integer, got ${String(threshold)}`);
  }
  if (!Number.isSafeInteger(landedBytes) || landedBytes < 0) {
    refuse("sim-batch-threshold-invalid",
      `landed bytes is a non-negative integer, got ${String(landedBytes)}`);
  }
  return coreLandedBytesVerdict({ landedBytes, threshold, pending });
}

/**
 * One threshold lane's plan. The measured steps are walked in order; the
 * pending stream is every eligible unit whose result landed strictly before the
 * step being asked about (the request at `k` carried those) AND that the host
 * had not removed by that step. The ONE exception is `landed-bytes`, which the
 * product evaluates per LANDING: there a unit landing on step S is pending at S
 * and can fire at S, exactly as `entryTriggerFor` fires from the landing call.
 * A fire's answers
 * land at that FIRE's step, never earlier (`clampDecisionStep(unit.step + 1,
 * fireStep)`, the live lane's own rule), so a fire that asks older pending units
 * removes nothing before itself and its removals move the depth from the step
 * after it on. Nothing flushes at the compaction boundary: the boundary is
 * metadata, and the pending stream survives it (ADR-0035: never flush).
 *
 * `thresholdUnits` picks what is compared to `threshold`:
 * - `depth-tokens` (default): the measured depth, unchanged. After every fire
 *   `lastFireDepth` moves to `nextBaselineDepth` — under `"incremental"` (the
 *   default) that is the POST-removal depth, `depth − τ(this fire's dropped
 *   bytes)`. `"incremental"` and `"growth"` both reset the base to the first
 *   measured depth at or after the compaction step; `"absolute"` never resets.
 *   `firstFireDepth`, when set, replaces the first fire's delta test with
 *   `depth >= firstFireDepth`; after that fire the usual baseline reset and
 *   threshold apply, so only the first fire waits for the absolute floor.
 * - `landed-bytes`: the sum of every eligible unit's own `bytes` that landed
 *   since the last fire AND is still on the surface. The accumulator is zeroed
 *   by a fire; the lane's own removals never subtract from it, because it never
 *   reads the rendered or measured depth. A HOST prune does subtract a pending
 *   unit's bytes, because that unit can never be tabled: counting bytes no fire
 *   can ask would move the trigger on a sample the surface no longer holds.
 *   `semantics` is therefore not consulted — the reset is a no-op in-segment for
 *   this unit.
 */
export function thresholdLane({ timeline, depths, threshold, floor = FLOOR_BYTES,
  producer = STUB_PRODUCER, semantics = DEFAULT_THRESHOLD_SEMANTICS,
  thresholdUnits = DEFAULT_THRESHOLD_UNITS, firstFireDepth = null, depthSource = null }) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    refuse("sim-batch-threshold-invalid",
      `a threshold is a positive integer, got ${String(threshold)}`);
  }
  assertFirstFireDepth(firstFireDepth, { mode: "threshold", thresholdUnits });
  if (!THRESHOLD_SEMANTICS.includes(semantics)) {
    refuse("sim-batch-threshold-semantics-invalid",
      `semantics takes ${THRESHOLD_SEMANTICS.join(" or ")}, got ${String(semantics)}`);
  }
  if (!THRESHOLD_UNITS.includes(thresholdUnits)) {
    refuse("sim-batch-threshold-units-invalid",
      `threshold units take ${THRESHOLD_UNITS.join(" or ")}, got ${String(thresholdUnits)}`);
  }
  if (depths.length === 0) {
    refuse("sim-batch-depth-absent", "threshold mode needs at least one measured step");
  }
  const source = assertDepthSource(depthSource ?? defaultDepthSource(timeline.ignoreHostPrunes),
    timeline.ignoreHostPrunes === true);
  const surfaceSource = source === SURFACE_DEPTH_SOURCE;
  // The plan's reconstructed surface is stamped like the live lane's: it starts
  // at fire 0 and `applyFireToSurface` advances it after each fire, so every
  // depth read names the fire it is read for (the index is required).
  const surface = simulateSurface();
  const byUnits = thresholdUnits === "landed-bytes";
  const eligible = eligibleOf(timeline, floor);
  // TIME-AWARE stream: a unit the host prunes later was on the surface at an
  // earlier fire and is askable there. Only a unit removed STRICTLY BEFORE its
  // own landing step is never askable (a prune on the landing step runs after
  // that step's fire).
  const units = askableOf(timeline, floor);
  if (units.length === 0) {
    refuse("sim-batch-eligible-empty",
      `no eligible unit at floor ${String(floor)} B; a lane over nothing is not a measurement`);
  }
  const decisions = [];
  const removals = [];
  const batches = [];
  let pending = [];
  let index = 0;
  /** Units askable at their landing that a prune removed before a fire tabled
   * them: never asked, so they belong to `carried`. */
  let prunedBeforeAsk = 0;
  let lastFireDepth = null;
  let baselineDepth = null;
  /** True until the first fire: only then does the depth floor apply. */
  let firstFire = true;
  /** The landed-byte accumulator: only a fire zeroes it. */
  let landedBytes = 0;
  const compactionStep = timeline.compaction === null ? null : timeline.compaction.step;
  let resetAtCompaction = false;
  /**
   * One fire at `fireStep`: the pending stream becomes the batch, every row is
   * decided and applied, and the pending stream and byte accumulator reset.
   * Extracted so the landed-bytes lane can fire once per LANDING. The product
   * checks its trigger in `entryTriggerFor` as each result lands
   * (`plugin.ts:2119-2140,2172,2221`), not once per measured step, so a result
   * landing on step S fires on step S.
   */
  const fireAt = (fireStep, removedNow) => {
    firstFire = false;
    const batch = { ids: pending.map(unit => unit.id), step: fireStep };
    const batchIndex = batches.length;
    batches.push(batch);
    // The fire's OWN removals: the union rows this fire shaped and applied.
    let removalBytes = 0;
    const rows = [];
    for (const [at, unit] of pending.entries()) {
      const raw = producer.decide({ unit, index: at, batchIndex, batch }) ?? {};
      // The decision lands when the answer did, by the live lane's own rule: its
      // inline fallback (`unit.step + 1`) clamped to the fire. A unit that
      // landed at step 10 and is asked by the fire at step 50 was removed when
      // the answer landed, at 50 — never at 11.
      const decision = { step: clampDecisionStep(unit.step + 1, fireStep),
        ...raw, momentId: unit.id, fireStep };
      decisions.push(decision);
      rows.push({ index: at + 1, status: "answered", answer: decision });
      // The union: a unit the host had already removed at this fire frees
      // nothing. (A unit pruned LATER is credited for the window it stood.)
      if (removedNow.has(unit.seq)) continue;
      const row = renderMoment(momentOf(unit, timeline, 0), decision);
      if (!row.shaped) continue;
      const net = netDroppedOf(row);
      const pruneStep = hostPruneStepOf(timeline, unit.seq);
      // P2: a shape the host's own prune removes at or before the step it lands
      // on frees no window; it is neither a booking nor a depth subtraction, and
      // `renderPlanOf` credits the same union the live lane books.
      if (pruneStep !== null && row.decisionStep >= pruneStep) continue;
      removals.push({ unitId: unit.id, step: row.decisionStep, bytes: net, pruneStep });
      removalBytes += net;
    }
    if (surfaceSource) {
      applyFireToSurface({ surface, timeline, units: pending, rows, fireStep });
      // P10: the plan's surface gets the LIVE lane's gate. Rebuild the expected
      // map from the DECISION LOG alone (`reconstructedSurfaceOf`), never from
      // the writer's own output, and compare the whole content digest and the
      // shaped count. A writer that put a wrong body into `applyFireToSurface`
      // would move both.
      const rebuilt = reconstructedSurfaceOf({ timeline, units, decisions, lane: 0 });
      const expectedDigest = surfaceDigestOf(rebuilt);
      if (surfaceDigestOf(surface) !== expectedDigest) {
        refuse("sim-batch-surface-digest",
          `after the plan fire at step ${String(fireStep)} the plan surface's content`
          + ` digest is ${surfaceDigestOf(surface)} but the decision log's rebuilt surface`
          + ` hashes to ${expectedDigest}; the plan's depth series reads this surface, so a`
          + " wrong shaped body would move every later depth");
      }
      if (surfaceSizeOf(surface) !== rebuilt.size) {
        refuse("sim-batch-surface-removals",
          `after the plan fire at step ${String(fireStep)} the plan surface currently holds`
          + ` ${String(surfaceSizeOf(surface))} shaped turn(s) but the decision log`
          + ` rebuilds ${String(rebuilt.size)}; a current size that disagrees with its own`
          + " log is not the surface the depths measured");
      }
    }
    pending = [];
    landedBytes = 0;
    return removalBytes;
  };
  for (const entry of depths) {
    // The depth lane lands every unit BEFORE the measured step; the
    // landed-bytes lane lands them one at a time below, at their own step.
    if (!byUnits) {
      while (index < units.length && units[index].step < entry.step) {
        pending.push(units[index++]);
      }
    }
    // A host prune takes a row off the surface at its own step. Every pending
    // unit it removes can never be tabled again, so it leaves the stream (and
    // the byte accumulator) BEFORE the verdict sees this step.
    const removedNow = hostRemovedAt(timeline, entry.step);
    if (pending.some(unit => removedNow.has(unit.seq))) {
      const before = pending.length;
      pending = pending.filter(unit => {
        if (!removedNow.has(unit.seq)) return true;
        if (byUnits) landedBytes -= unit.bytes;
        return false;
      });
      prunedBeforeAsk += before - pending.length;
    }
    // The landed-bytes lane checks the trigger after EVERY landing, so a unit
    // landing on this step can fire on this step. A unit that landed on an
    // unmeasured step is landed here, and a unit the host had already removed
    // is never askable: it is carried, not counted into the accumulator.
    if (byUnits) {
      while (index < units.length && units[index].step <= entry.step) {
        const unit = units[index++];
        if (removedNow.has(unit.seq)) { prunedBeforeAsk += 1; continue; }
        pending.push(unit);
        // The unit's OWN landed bytes: not the rendered drop, not the depth.
        landedBytes += unit.bytes;
        if (landedBytesVerdict({ landedBytes, threshold, pending: pending.length }).kind
          !== "fire") continue;
        fireAt(entry.step, removedNow);
      }
      continue;
    }
    let removed = 0;
    for (const removal of removals) {
      // The policy's removal is visible until the host's own prune takes the
      // same body out of the measured series; after that, subtracting it again
      // would double-count the host's removal.
      if (removal.step < entry.step
        && (removal.pruneStep === null || entry.step < removal.pruneStep)) {
        removed += removal.bytes;
      }
    }
    // A pruner-off lane reads the reconstructed surface's own bytes; its shaped
    // turns are already in those bytes, so no subtraction runs. The host series
    // is only ever the host lane's ruler.
    const depth = surfaceSource
      ? surfaceDepthBefore({ timeline, step: entry.step, surface,
        fireIndex: surfaceFireOf(surface) }).tokens
      : entry.tokens - signedMeasuredTokensOf(removed);
    if (lastFireDepth === null) { lastFireDepth = depth; baselineDepth = depth; continue; }
    // The post-compaction window is the new base; the pre-compaction
    // high-water mark is not a distance the compacted context ever travels.
    if (semantics !== "absolute" && !resetAtCompaction && compactionStep !== null
      && entry.step >= compactionStep) {
      resetAtCompaction = true;
      lastFireDepth = depth;
      continue;
    }
    const verdict = thresholdVerdict({ depth, lastFireDepth, threshold, pending: pending.length,
      firstFireDepth: firstFire ? firstFireDepth : null });
    if (verdict.kind !== "fire") continue;
    const removalBytes = fireAt(entry.step, removedNow);
    // The next window measures from the post-removal depth under `incremental`.
    lastFireDepth = nextBaselineDepth({ depth, removalBytes, semantics });
  }
  const counts = askableCountsOf(timeline, eligible, units);
  return {
    ...renderPlanOf({ timeline, depths, lane: 0, units, decisions, mode: "threshold",
      threshold, thresholdUnits, semantics, triggers: batches.length,
      fireSteps: batches.map(batch => batch.step),
      fireBatches: batches.map(batch => batch.ids),
      // A unit that never fired is carried, not asked. Under `landed-bytes` a
      // unit landing on the last measured step IS pending (per-landing
      // evaluation), so this count is every landing that did not cross plus
      // every unit after the last measured step. A unit the host pruned before
      // any fire tabled it is carried too: the run never asked it, and
      // `prunedBeforeAsk` names why.
      carried: pending.length + (units.length - index) + prunedBeforeAsk,
      depthSource: source,
      eligibleResults: eligible.length, askableResults: units.length,
      hostPrunedEligible: counts.hostPrunedEligible,
      hostPrunedBeforeLanding: counts.hostPrunedBeforeLanding,
      askableBeforePrune: counts.askableBeforePrune,
      prunedBeforeAsk,
      eligibleSplit: eligibleSplitOf(timeline, eligible),
      askableSplit: eligibleSplitOf(timeline, units) }),
    // The INITIAL base (the first measured step's depth); later windows move it.
    baselineDepth,
    // The first fire's absolute depth floor, or null for today's cadence.
    firstFireDepth,
    // Every shaped removal this plan books, in booking order: the FIRE step,
    // exactly as the live lane books it. The plan-vs-live equality test reads
    // this list, not a re-derivation.
    removalBookings: removals.map(({ unitId, step, bytes }) => ({ unitId, step, bytes })),
    eligibility: eligibilityOf(timeline, floor),
  };
}

/**
 * The one-line plan summary. A batch lane's line is unchanged; a threshold lane
 * names the semantics its windows were measured under.
 */
export function summaryOf(plan) {
  const depth = plan.depthSeries;
  const head = plan.mode !== "threshold"
    ? `sim-batch-units lane ${plan.lane}`
    : plan.thresholdUnits === "landed-bytes"
      ? `sim-batch-units threshold ${plan.threshold} B landed`
      : `sim-batch-units threshold ${plan.threshold}`;
  return `${head} triggers ${plan.triggers} asks ${plan.asks}`
    + ` eligible ${plan.eligibleResults}`
    + `${plan.askableResults !== undefined && plan.askableResults !== plan.eligibleResults
      ? ` askable ${String(plan.askableResults)}` : ""}`
    + `${plan.hostPrunedEligible
      ? ` host-pruned ${String(plan.hostPrunedEligible)}`
        + ` (askable before prune ${String(plan.askableBeforePrune ?? 0)},`
        + ` pruned before landing ${String(plan.hostPrunedBeforeLanding ?? 0)})` : ""}`
    + (plan.eligibleSplit
      ? ` (eligible = ${plan.eligibleSplit.appends} appends +`
        + ` ${plan.eligibleSplit.replacements} replacements; appends =`
        + ` ${plan.eligibleSplit.neverPruned} never-pruned +`
        + ` ${plan.eligibleSplit.prunedOriginals} host-pruned originals)`
      : "")
    + ` freed ${plan.bytesFreedByPolicy} B net`
    + ` (${plan.bytesFreedGross ?? plan.bytesFreedByPolicy} B gross) depth`
    + ` ${depth === null ? "-" : `${depth.first}/${depth.peak}/${depth.last}`}`
    + `${plan.eligibility
      ? ` floor ${String(plan.eligibility.floor)} excluded`
        + ` ${String(plan.eligibility.excluded.unreadableContent ?? 0)} unreadable-content,`
        + ` ${String(plan.eligibility.excluded.nonTextContent ?? 0)} non-text-content,`
        + ` ${String(plan.eligibility.excluded.belowFloor)} below-floor,`
        + ` ${String(plan.eligibility.excluded.errorResult)} error-result,`
        + ` ${String(plan.eligibility.excluded.noTwoQuotes)} no-two-quotes` : ""}`
    + `${plan.mode === "threshold" && plan.semantics ? ` semantics ${plan.semantics}` : ""}`
    + `${plan.firstFireDepth ? ` first-fire ${plan.firstFireDepth}` : ""}`
    + `${plan.depthSource === SURFACE_DEPTH_SOURCE
      ? " depth reconstructed-surface (host series contaminated)" : ""}`
    + `${plan.ignoreHostPrunes
      ? ` host-prunes ignored ${plan.hostPrunesIgnored} (${plan.hostTokensIgnored} tok,`
        + ` ${plan.hostReplacementsIgnored} replacement rows)` : ""}`;
}

function lanesOf(text) {
  const lanes = String(text).split(",").map(part => Number(part.trim()));
  const bad = lanes.find(lane => !Number.isSafeInteger(lane) || lane < 1);
  if (bad !== undefined) refuse("sim-batch-lane-invalid", `--lanes takes positive integers, got ${text}`);
  return lanes;
}

function thresholdsOf(text) {
  const thresholds = String(text).split(",").map(part => Number(part.trim()));
  const bad = thresholds.find(value => !Number.isSafeInteger(value) || value < 1);
  if (bad !== undefined) {
    refuse("sim-batch-threshold-invalid", `--thresholds takes positive integers, got ${text}`);
  }
  return thresholds;
}

/**
 * The plan launcher. `io` is the test seam (and the only place the launcher
 * touches the outside world): `readBytes` reads the transcript, `readText` reads
 * the usage file, and `out` receives every line. Each input is read ONCE: the
 * transcript's hash is the one `readTimeline` computed from the bytes it
 * parsed, and the usage hash is the one `readUsageOf` computed from its own
 * read (thirteenth audit item 5).
 */
export async function main(argv, io = {}) {
  const readBytes = io.readBytes ?? readFileSync;
  const readText = io.readText ?? readFileSync;
  const out = io.out ?? (text => process.stdout.write(text));
  const { values } = parseDevArgs(argv, {
    options: optionsOf([
      ["--transcript", "string"], ["--usage", "string"], ["--floor", "string"],
      ["--segment", "string"],
      ["--lanes", "string"], ["--mode", "string"], ["--thresholds", "string"],
      ["--threshold-units", "string", "thresholdUnits"],
      ["--threshold-semantics", "string", "thresholdSemantics"],
      ["--first-fire-depth", "string", "firstFireDepth"],
      ["--producer", "string"],
      ["--ask-grammar", "string", "askGrammar"],
      ["--ask-order", "string", "askOrder"],
      ["--ignore-host-prunes", "boolean", "ignoreHostPrunes"],
      ["--reconstruction", "boolean"],
      ["--allow-zero-reasoning", "boolean", "allowZeroReasoning"],
      ["--plan", "boolean"], ["--json", "boolean"],
    ]),
    refuse: message => refuse("sim-batch-args", message),
    usage: () => USAGE, help: USAGE, prefix: "sim-batch-units.mjs: ",
  });
  // --plan is the only mode this chunk runs; plan mode is also the default.
  const mode = values.mode ?? "batch";
  if (!TRIGGER_MODES.includes(mode)) {
    refuse("sim-batch-mode-invalid", `--mode takes ${TRIGGER_MODES.join(" or ")}, got ${String(mode)}`);
  }
  const transcript = values.transcript ?? DEFAULT_TRANSCRIPT;
  const usage = values.usage ?? DEFAULT_USAGE;
  for (const [label, file] of [["transcript", transcript], ["usage", usage]]) {
    if (!existsSync(file)) {
      refuse("sim-batch-input-absent",
        `the ${label} file ${file} is absent; point CREMATOR_SIM_EVIDENCE at the world's`
        + " root, or pass --transcript/--usage");
    }
  }
  const floor = values.floor === undefined ? FLOOR_BYTES : Number(values.floor);
  if (!Number.isSafeInteger(floor) || floor < 0) {
    refuse("sim-batch-floor-invalid", `--floor takes a non-negative integer, got ${values.floor}`);
  }
  const producer = await loadProducer(values.producer ?? "stub");
  const { grammar, order } = assertOrderForGrammar(values.askGrammar ?? DEFAULT_ASK_GRAMMAR,
    values.askOrder ?? DEFAULT_ASK_ORDER);
  const segment = values.segment === undefined ? null : Number(values.segment);
  if (segment !== null && (!Number.isSafeInteger(segment) || segment < 1)) {
    refuse("sim-batch-segment-invalid", `--segment takes a positive step, got ${values.segment}`);
  }
  const timeline = readTimeline(transcript, {
    segment, ignoreHostPrunes: values.ignoreHostPrunes === true,
    reconstruction: values.reconstruction === true,
    readBytes,
  });
  // ONE read of each input: the transcript hash is the timeline's own (the bytes
  // it parsed), and the usage hash comes back from the same read whose rows the
  // lanes use. `inputPinsOf` would re-read BOTH files, so a changed second read
  // could pin bytes the run never replayed.
  const usageRead = readUsageOf(usage, { readText });
  const depths = depthsInSegment(usageRead.depths, segment);
  const input = { transcriptSha256: timeline.transcriptSha256,
    usageSha256: usageRead.usageSha256, usageFile: usage };
  const pins = assertSegmentPins(timeline, depths,
    { allowZeroReasoning: values.allowZeroReasoning === true, input });
  const pruneGate = assertZeroPruneGate(timeline);
  if (segment !== null) {
    out(`[segment] last step ${String(segment)}`
      + `; first excluded step ${String(pins.firstExcludedStep)};`
      + ` ${String(pins.excludedRows)} row(s) excluded\n`);
    out(`[pins] eligible ${String(pins.eligible)} = appends ${String(pins.appends)}`
      + ` + replacements ${String(pins.replacements)}`
      + `; appends ${String(pins.appends)} = never-pruned ${String(pins.neverPruned)}`
      + ` + pruned originals ${String(pins.prunedOriginals)}`
      + `; prune journals ${String(pins.pruneJournals)}`
      + `; peak depth ${pins.ignoreHostPrunes ? "reconstructed" : "host"}`
      + `${pins.ignoreHostPrunes ? "" : ` ${String(pins.peakDepth)} at step ${String(pins.peakStep)}`}`
      + `; header tools ${String(pins.headerTools)}, ${String(pins.headerToolBytes)} B`
      + `; reasoning ${String(pins.reasoningBlocks)} turns, ${String(pins.reasoningBytes)} B`
      + `, unresendable rows ${String(pins.reasoningUnresendableRows)}`
      + `; ISSUE-195 parts ${String(pins.reasoningParts)}, stream blocks`
      + ` ${String(pins.reasoningStreamBlocks)}\n`);
  }
  out(`[prune-gate] ${pruneGate.status}: ${String(pruneGate.replayedPrunes)}`
    + ` source-world prune event(s) before the filter (whole recording carried`
    + ` ${String(pruneGate.inputPruneEvents)}; reconstruction`
    + ` ${String(pruneGate.reconstruction === true)})\n`);
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
  const thresholds = values.thresholds
    ?? (thresholdUnits === "landed-bytes"
      ? DEFAULT_BYTE_THRESHOLDS.join(",") : DEFAULT_THRESHOLDS.join(","));
  const plans = mode === "threshold"
    ? thresholdsOf(thresholds).map(threshold =>
      thresholdLane({ timeline, depths, threshold, floor, producer, semantics, thresholdUnits,
        firstFireDepth }))
    : lanesOf(values.lanes ?? String(DEFAULT_LANES))
      .map(lane => planLane({ timeline, depths, lane, floor, producer }));
  for (const plan of plans) out(`${summaryOf(plan)}\n`);
  if (values.json === true) {
    const build = buildIdentityOf();
    const output = plans.map(({ mode: planMode, lane, threshold, thresholdUnits: planUnits,
      semantics: planSemantics, firstFireDepth: planFirstFireDepth, triggers, asks,
      eligibleResults, askableResults, askableSplit, hostPrunedEligible,
      bytesFreedByPolicy, bytesFreedGross, depthSeries, hostPrunes, hostTokens,
      ignoreHostPrunes, hostPrunesIgnored, hostTokensIgnored, hostReplacementsIgnored,
      reconstruction: planReconstruction, depthOverflow,
      depthSource: planDepthSource, hostDepths, eligibility, removalBookings }) =>
      ({ mode: planMode, lane, threshold, thresholdUnits: planUnits,
      semantics: planSemantics, firstFireDepth: planFirstFireDepth ?? null,
      askGrammar: grammar, askOrder: order, triggers, asks,
      eligibleResults, askableResults, hostPrunedEligible,
      eligibleSplit: eligibleSplitOf(timeline, eligibleOf(timeline, floor)),
      askableSplit: askableSplit ?? null,
      eligibility, removalBookings: removalBookings ?? null,
      bytesFreedByPolicy, bytesFreedGross,
      allowZeroReasoning: values.allowZeroReasoning === true,
      depthSeries, depthOverflow,
      input: { transcript, usage, ...input },
      build, textSource: TEXT_SOURCE,
      hostPrunes, hostTokens, ignoreHostPrunes, hostPrunesIgnored, hostTokensIgnored,
      hostReplacementsIgnored, reconstruction: planReconstruction === true,
      depthSource: planDepthSource,
      hostDepthSeriesContaminated: hostDepths?.contaminated === true }));
    out(`${JSON.stringify(plans.length === 1 ? output[0] : output, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  });
}
