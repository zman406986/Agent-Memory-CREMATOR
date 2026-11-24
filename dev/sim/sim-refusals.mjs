#!/usr/bin/env node
/**
 * ISSUE-104 / ISSUE-106 Gate B — the bounded refusal replay: re-ask the 149 entry
 * asks that run C refused, at depth 0, and measure how many the current prompt
 * (or the pre-rewrite one) still refuses.
 *
 * Usage (dry: nothing armed, no socket opened):
 *   node dev/sim/sim-refusals.mjs [--codes <a,b>] [--limit <n>] [--per-code <n>]
 *        [--depth 0] [--prompt old] [--json]
 *
 * Usage (live: owner-gated, real route, kill timer armed):
 *   SIM_LIVE_ARMED=1 node dev/sim/sim-refusals.mjs --live --i-am-the-owner \
 *     --producer dev/sim/producer-a6-inprocess.mjs --kill-ms 7200000 \
 *     --token-grant 178203 --ask-ceiling 223311 \
 *     --out scratchpad/launch/<yyyy-mm-dd>-<slug>/refusals.jsonl
 *
 * `--out` names the replay file; the harness's own partial pass is written beside
 * it as `<stem>.partial.jsonl`. Both stay under `scratchpad/` and are never
 * committed. The `--token-grant` and `--ask-ceiling` numbers above are the full
 * 149-ask projection this tool prints in dry mode; a filtered run prints its own.
 *
 * Hard checks (docs/guides/law-live-testing.md): the kill timer is armed by
 * `runLive` before the first ask; the key is read in-process by
 * `producer-a6-inprocess.mjs` and never exported; the model is always a6
 * `deepseek-v4.1-flash-1017`; evidence lands under `scratchpad/` and is never
 * committed.
 *
 * ## The join, which is the whole correctness argument
 *
 * The refusal rows are `kind === "entry-ask-refused"` in run C's event journal;
 * each carries a top-level `callId`. The bodies live in the session transcript on
 * rows with `surfaceOp === "append"` and `type === "tool/result"`, where the key
 * is `data.message.toolCallId` — NOT top level. The join is that pair and it
 * must resolve 149/149; a short join refuses by name before any request is built.
 * `unitId` is not the join key: it is not `sha256(body)`.
 *
 * ## Depth, and why the render is per row
 *
 * Depth 0 means one ask carries exactly one turn: its own body. `runLive`'s
 * `renderFor` hook (2 lines in `sim-live.mjs`) supplies that per-row render; a
 * shared render would attach every body to every ask at depth 0. Depth `d > 0`
 * prepends the `d` tool results that immediately precede the unit in the
 * transcript, and the cost is printed before anything is sent.
 *
 * ## The prompt
 *
 * By default the ask is built by `buildAskRequest`, so it reads the prompt from
 * the built `@cremator/core` dist: once ISSUE-106's rewrite lands and `npm run
 * build` runs, this tool asks with the fixed prompt with no edit here.
 * `--prompt old` composes the ask from the pre-rewrite asset
 * (`git show f81d9a4^:packages/core/src/rules/assets-templates.ts`, the
 * ENTRY_ASK_PROMPT_LINES array joined with "\n" exactly as `assets.ts` joins it)
 * and swaps it into the request body at the producer seam. The parser that
 * extracts that array is pinned first: over the CURRENT source file it must
 * reproduce the constant the built dist exports, or the run refuses by name.
 * That commit declares no TWOForm prompt array, so `--variant two --prompt old`
 * refuses; the default and forgetlines arrays both exist there.
 * (Run C's own asks carried the same prompt but a shorter summary sentence than
 * today's: its facts block and closing line are byte-identical to this tool's,
 * only the contract paragraph differs. `--prompt old` is the cell that removes
 * that difference.)
 *
 * ## The post-pass
 *
 * Every answer goes through `parseEntryAnswer` and, for a partial answer, the
 * adapter's own range arithmetic (`spans-outside-result`, `keeps-every-line`), so
 * `replayCode` is the code run C's journal would carry. Refusals keep their
 * original code beside the replay's outcome.
 *
 * ## The band (ISSUE-104; do not move it)
 *
 *   70–87 remaining refusals of 149   the three fixes worked as designed
 *   ≤ 69                              something outside them moved — investigate
 *   ≥ 88                              the fixes did not reach design — revise
 * The band only reads for the full 149; a filtered run prints its own counts and
 * says the verdict does not apply.
 *
 * Exit: 0 = completed; 1 = a spend ceiling stopped it; 2 = usage or a named
 * refusal; 3 = every ask refused; 124 = the kill timer fired.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_SYSTEM_PROMPT, EntryAnswerError, entryAskFactsBlock,
  entryAskMessage, parseEntryAnswer,
} from "@cremator/core";
import { entryAskFacts } from "cremator-dsh";
import { readTranscript, textOf } from "./gate3-live-chain.mjs";
import { prefixAtSeq, renderLane } from "./sim-render.mjs";
import {
  DEFAULT_ARM, DEFAULT_KILL_MS, LANES, LIVE_ENV, OWNER_FLAG, VARIANTS, askInstruction,
  buildAskRequest, gateLive, loadProducer, preflight, refuse, runLive, tau,
} from "./sim-live.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Run C's two files, relative to the repo root (evidence, never committed). */
export const DEFAULT_EVENTS = "scratchpad/launch/2026-10-29-full-rerun/worlds/racoons"
  + "/evidence/racoons/cremator-events.jsonl";
export const DEFAULT_SESSION = "scratchpad/launch/2026-10-29-full-rerun/worlds/racoons"
  + "/evidence/sessions/--C-Users-AAAAA-Desktop-racoons-scratchpad-launch-2026-10-29-full-rerun"
  + "-worlds-racoons-arm--/session-c94f0c1a-3058-41bc-aef6-907acbb744d4/session.v4.jsonl";

/** The refusal count ISSUE-104 names. A different count is a different run C. */
export const EXPECTED_REFUSALS = 149;
/** The 198 asks run C answered, which stay answered and are never re-asked. */
export const ANSWERED_IN_RUN_C = 198;
/** ISSUE-104's band, in remaining refusals over `EXPECTED_REFUSALS`. */
export const BAND = Object.freeze({ passLow: 70, passHigh: 87 });
/** The refusal codes run C journals, with the count each carried there. */
export const RUN_C_CODES = Object.freeze({
  "malformed-json": 57, "mixed-keys": 39, "summary-missing": 22, "summary-too-long": 18,
  timeout: 8, "stream-error": 3, "empty-text": 1, "spans-outside-result": 1,
});
/** The lane the replay asks on: run C used the shipped default (`keeplines`). */
export const DEFAULT_VARIANT_FLAG = "n";
/** The asset array each variant's prompt is joined from (`assets-templates.ts`). */
const PROMPT_ARRAYS = {
  default: "ENTRY_ASK_PROMPT_LINES",
  forgetlines: "ENTRY_ASK_FORGETLINES_PROMPT_LINES",
  twoform: "ENTRY_ASK_TWOFORM_PROMPT_LINES",
};
/** The one pre-rewrite prompt this flag reaches: commit f81d9a4 rewrote them. */
export const OLD_PROMPT_REV = "f81d9a4^:packages/core/src/rules/assets-templates.ts";

const USAGE = [
  "usage: sim-refusals.mjs [--codes <a,b>] [--limit <n>] [--per-code <n>] [--depth 0]",
  "                       [--prompt old] [--variant n|two|f] [--events <file>]",
  "                       [--session <file>] [--live --i-am-the-owner]",
  "                       [--producer <module>] [--kill-ms <n>] [--token-grant <n>]",
  "                       [--ask-ceiling <n>] [--out <file>] [--json]",
  "  (no --live)   dry: print the join, the per-code counts, the cost and the first",
  "                composed ask; arms nothing and opens no socket",
  "  --codes       only refusals whose run-C code is in this comma list",
  "  --per-code    cap the selected rows per code, in journal order",
  "  --limit       cap the selected rows after the code and per-code cuts",
  "  --depth       prefix turns per ask: 0 = the unit's own body only (default)",
  "  --prompt old  compose the pre-rewrite prompt instead of the built dist's",
  "  --variant     the lane: n (shipped default, run C's), two, f",
].join("\n");

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = text => Buffer.from(text, "utf8");

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--codes", "string"],
  ["--limit", "string"],
  ["--per-code", "string", "perCode"],
  ["--depth", "string"],
  ["--events", "string"],
  ["--session", "string"],
  ["--producer", "string"],
  ["--kill-ms", "string", "killMs"],
  ["--token-grant", "string", "tokenGrant"],
  ["--ask-ceiling", "string", "askCeiling"],
  ["--out", "string"],
  ["--variant", "string"],
  ["--prompt", "string"],
  ["--live", "boolean"],
  [OWNER_FLAG, "boolean", "owner"],
  ["--json", "boolean"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    codes: values.codes ?? null,
    limit: values.limit ?? null,
    perCode: values.perCode ?? null,
    depth: values.depth ?? 0,
    prompt: values.prompt ?? "new",
    events: values.events ?? DEFAULT_EVENTS,
    session: values.session ?? DEFAULT_SESSION,
    variant: values.variant ?? DEFAULT_VARIANT_FLAG,
    arm: DEFAULT_ARM,
    producer: values.producer ?? null,
    killMs: values.killMs ?? DEFAULT_KILL_MS,
    tokenGrant: values.tokenGrant ?? null,
    askCeiling: values.askCeiling ?? null,
    out: values.out ?? null,
    live: values.live ?? false,
    owner: values.owner ?? false,
    json: values.json ?? false,
  };
  if (opts.prompt !== "old" && opts.prompt !== "new") refuse("usage", "--prompt takes old or new");
  // The lane token is sim-live's (`n|two|f`) and is stored mapped, exactly as
  // `sim-live.parseArgs` stores it: the mapped value is the contract.
  const mapped = VARIANTS[opts.variant];
  if (mapped === undefined) refuse("usage", `--variant takes one of n, two, f (got ${String(opts.variant)})`);
  opts.variant = mapped;
  for (const [flag, key] of [["--limit", "limit"], ["--per-code", "perCode"]]) {
    if (opts[key] === null) continue;
    const value = Number(opts[key]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse("usage", `${flag} takes a positive integer, got ${String(opts[key])}`);
    }
    opts[key] = value;
  }
  opts.depth = Number(opts.depth);
  if (!Number.isSafeInteger(opts.depth) || opts.depth < 0) {
    refuse("usage", `--depth takes a non-negative integer, got ${String(opts.depth)}`);
  }
  if (opts.codes !== null) {
    const codes = opts.codes.split(",").map(code => code.trim()).filter(code => code.length > 0);
    for (const code of codes) {
      if (RUN_C_CODES[code] === undefined) {
        refuse("usage", `--codes names ${code}; run C's codes are ${Object.keys(RUN_C_CODES).join(", ")}`);
      }
    }
    if (codes.length === 0) refuse("usage", "--codes names no code");
    opts.codes = codes;
  }
  for (const [flag, key] of [["--kill-ms", "killMs"], ["--token-grant", "tokenGrant"],
    ["--ask-ceiling", "askCeiling"]]) {
    if (opts[key] === null) continue;
    const value = Number(opts[key]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse("usage", `${flag} takes a positive integer, got ${String(opts[key])}`);
    }
    opts[key] = value;
  }
  if (opts.out !== null && (opts.out.endsWith("/") || opts.out.endsWith("\\"))) {
    refuse("usage", "--out names the replay file, not a directory");
  }
  return opts;
}

/** A file's JSONL rows; a bad line is named with its number. */
function readJsonl(file) {
  let text;
  try {
    text = readFileSync(path.resolve(REPO_ROOT, file), "utf8");
  } catch (error) {
    return refuse("sim-refusals-unreadable", `${file}: ${error.message}`);
  }
  return text.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      return refuse("sim-refusals-unreadable", `${file} line ${index + 1}: ${error.message}`);
    }
  });
}

/** The journal's `entry-ask-refused` rows, in the order they were recorded. */
export function readRefusals(rows) {
  return rows.filter(row => row?.kind === "entry-ask-refused")
    .map(row => ({
      callId: row.callId, unitId: row.unitId ?? null, code: row.code,
      usage: row.usage ?? null, reason: row.reason ?? null,
    }));
}

/**
 * The refusal `callId` -> result row index over the session transcript. The key
 * is `data.message.toolCallId`, never the top level: the transcript's own
 * `tool/result` appends are the only rows that carry a result body.
 */
export function bodyIndex(rows) {
  const byCall = new Map();
  for (const row of rows) {
    if (row?.type !== "tool/result" || row.surfaceOp !== "append") continue;
    const callId = row.data?.message?.toolCallId;
    if (typeof callId !== "string" || callId.length === 0) continue;
    if (byCall.has(callId)) {
      refuse("sim-refusals-duplicate-call", `${callId} appears on two tool/result appends`);
    }
    const text = textOf(row);
    byCall.set(callId, {
      callId,
      seq: row.seq,
      step: row.data?.step,
      text,
      bytes: utf8(text).length,
    });
  }
  return byCall;
}

/**
 * The 149 refusals joined to their bodies: the assertion the whole run rests on.
 * A short join refuses before any request is built; a body whose step or seq is
 * missing refuses by name, because an ask has to state both.
 */
export function joinRefusals({ events, session }) {
  const refusals = readRefusals(events);
  const bodies = bodyIndex(session);
  const joined = refusals.map(refusal => {
    const body = bodies.get(refusal.callId);
    return body === undefined ? { ...refusal, body: null } : { ...refusal, body };
  });
  const missing = joined.filter(entry => entry.body === null).map(entry => entry.callId);
  if (missing.length > 0) {
    refuse("sim-refusals-join-incomplete",
      `${String(missing.length)} of ${String(refusals.length)} refused callIds have no`
      + ` tool/result append in the session (first: ${missing[0]})`);
  }
  if (refusals.length !== EXPECTED_REFUSALS) {
    refuse("sim-refusals-join-incomplete",
      `the journal holds ${String(refusals.length)} entry-ask-refused rows; ISSUE-104 names`
      + ` ${String(EXPECTED_REFUSALS)}`);
  }
  for (const entry of joined) {
    if (!Number.isSafeInteger(entry.body.seq) || !Number.isSafeInteger(entry.body.step)) {
      refuse("sim-refusals-body-invalid",
        `${entry.callId} lands at seq ${String(entry.body.seq)} / step ${String(entry.body.step)}`);
    }
  }
  return joined;
}

/** The per-code counts, in the journal's own order, then any extra codes. */
export function countsByCode(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  return counts;
}

/** The selected rows: the code cut, then the per-code cap, then the limit. */
export function selectRows(entries, { codes = null, perCode = null, limit = null } = {}) {
  const filtered = codes === null ? entries : entries.filter(entry => codes.includes(entry.code));
  let selected = filtered;
  if (perCode !== null) {
    const taken = new Map();
    selected = filtered.filter(entry => {
      const used = taken.get(entry.code) ?? 0;
      if (used >= perCode) return false;
      taken.set(entry.code, used + 1);
      return true;
    });
  }
  return limit === null ? selected : selected.slice(0, limit);
}

/**
 * The string-array literal `name` declares, or `null` when the source declares
 * none. A scanner, not a regex: the array holds `[[2,3],…]` inside its strings,
 * so a bracket-counting regex reads the wrong bracket.
 */
export function readPromptLinesFrom(source, name) {
  // The source declares `const NAME: readonly string[] = [`, the built JS
  // `const NAME = [`: the type annotation is optional here so one scanner reads
  // both, which is what lets the current dist's constant pin the extractor.
  const decl = new RegExp(`const\\s+${name}\\s*(?::[^=]*)?=\\s*\\[`);
  const match = decl.exec(source);
  if (match === null) return null;
  const lines = [];
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const [value, next] = readStringLiteral(source, i);
      if (depth === 1) lines.push(value);
      i = next;
      continue;
    }
    if (ch === "[") { depth += 1; i += 1; continue; }
    if (ch === "]") { depth -= 1; i += 1; if (depth === 0) return lines; continue; }
    i += 1;
  }
  return null;
}

/** One JS string literal, its escapes decoded; the index just past its quote. */
function readStringLiteral(source, start) {
  const quote = source[start];
  let out = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return [out, i + 1];
    if (ch !== "\\") { out += ch; i += 1; continue; }
    const next = source[i + 1];
    if (next === "n") { out += "\n"; i += 2; continue; }
    if (next === "t") { out += "\t"; i += 2; continue; }
    if (next === "r") { out += "\r"; i += 2; continue; }
    if (next === "u") {
      out += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
      i += 6;
      continue;
    }
    out += next;
    i += 2;
  }
  return refuse("sim-refusals-prompt-unterminated", `a prompt line at ${String(start)} is unterminated`);
}

/**
 * The pre-rewrite prompt for one lane, and the proof the extractor is right: the
 * same extractor over the CURRENT source file must reproduce the constant the
 * built dist exports. A mismatch means the parser is reading the wrong bracket,
 * so `--prompt old` refuses rather than asking a half-quoted array.
 */
export function loadOldPrompt(variant, { root = REPO_ROOT } = {}) {
  const name = PROMPT_ARRAYS[variant];
  if (name === undefined) refuse("sim-refusals-prompt-unknown", `no prompt array for ${variant}`);
  const current = readFileSync(path.join(root, "packages/core/src/rules/assets-templates.ts"), "utf8");
  const parsed = readPromptLinesFrom(current, name);
  if (parsed === null) {
    refuse("sim-refusals-prompt-parser", `the current source declares no ${name}`);
  }
  if (variant === "default" && parsed.join("\n") !== ENTRY_ASK_SYSTEM_PROMPT) {
    refuse("sim-refusals-prompt-parser",
      `${name} parses to ${String(parsed.join("\n").length)} bytes but the dist exports`
      + ` ${String(ENTRY_ASK_SYSTEM_PROMPT.length)}; the extractor is misreading the array`);
  }
  const source = execFileSync("git", ["show", OLD_PROMPT_REV], { cwd: root, encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024 });
  const lines = readPromptLinesFrom(source, name);
  if (lines === null || lines.length === 0) {
    refuse("sim-refusals-prompt-absent", `${OLD_PROMPT_REV} declares no ${name}`);
  }
  return lines.join("\n");
}

/**
 * The ask `entryAskMessage` would render, from a caller-supplied prompt. Byte
 * identical to the shipped renderer when the prompt is the lane's own: the same
 * facts block and the same closing line, in the same order.
 */
export function composeAskText(promptText, facts, variant) {
  return `${promptText}\n\n${entryAskFactsBlock({ ...facts, variant })}\n\n${ENTRY_ASK_CLOSING_LINE}`;
}

/**
 * The answer's code as run C's journal would carry it: the parser's own code,
 * then the adapter's range arithmetic for a partial answer. `null` means the
 * product would have applied it.
 */
export function replayCodeOf(text, totalLines) {
  let answer;
  try {
    answer = parseEntryAnswer(text);
  } catch (error) {
    if (error instanceof EntryAnswerError) return error.code;
    return refuse("sim-refusals-parser-error", `parseEntryAnswer threw ${String(error?.message ?? error)}`);
  }
  if (answer.action !== "keeplines") return null;
  for (const range of answer.ranges) {
    if (range.to > totalLines) return "spans-outside-result";
  }
  const only = answer.ranges[0];
  if (answer.ranges.length === 1 && only !== undefined && only.from === 1 && only.to === totalLines) {
    return "keeps-every-line";
  }
  return null;
}

/**
 * The replay's moments, per-row renders and plan. `appends` is every
 * `tool/result` append in the session, seq-ascending: the depth-`d` prefix is the
 * `d` of them that precede the unit. Each row carries its own `render`, so
 * `runLive`'s `renderFor` never shares one body across asks.
 */
export function buildReplay(entries, { arm = DEFAULT_ARM, variant, depth = 0,
  promptText = null } = {}) {
  if (entries.length === 0) refuse("usage", "no refusal row survived the filters");
  const lane = LANES[variant];
  if (lane === undefined) refuse("usage", `no lane for variant ${String(variant)}`);
  const momentsById = new Map();
  const renders = new Map();
  const rows = [];
  for (const entry of entries) {
    const { body } = entry;
    const moment = {
      id: `refusal:${entry.callId}`,
      lane: arm,
      seq: body.seq,
      step: body.step,
      original: { text: body.text },
    };
    if (momentsById.has(moment.id)) {
      refuse("sim-refusals-duplicate-call", `${entry.callId} is selected twice`);
    }
    momentsById.set(moment.id, moment);
    const context = entry.context ?? [];
    const rendered = renderLane({
      lane: arm,
      moments: [...context.map(item => ({ ...item })), moment],
      decisions: [],
    });
    renders.set(moment.id, rendered);
    const request = buildAskRequest(moment, rendered, variant, moment.seq);
    const facts = entryAskFacts(new Uint8Array(utf8(body.text)));
    const askText = promptText === null ? request.askText : composeAskText(promptText, facts, variant);
    // The body's line count is the product's own (`facts.lineCount`), the number
    // `entryAskMessage` states and the adapter's range arithmetic checks against.
    const lines = facts.lineCount;
    const prefix = prefixAtSeq(rendered, moment.seq, moment.step);
    // The request sha the row carries is the one the bytes describe, including
    // the swapped-in prompt when `--prompt old` overrides the dist's.
    const body_ = { ...request.body,
      messages: [...request.body.messages.slice(0, -1), { role: "user", content: askText }] };
    rows.push({
      id: moment.id,
      seq: moment.seq,
      step: moment.step,
      triggerSeq: moment.seq,
      bytes: body.bytes,
      lines,
      totalLines: facts.lineCount,
      askText,
      askTextOverride: promptText === null ? null : askText,
      askBytes: utf8(askText).length,
      askInstruction: askInstruction(lines),
      requestSha256: sha256Hex(utf8(JSON.stringify(body_))),
      prefixBytes: prefix.prefixBytes,
      prefixTokens: tau(prefix.prefixBytes),
      prefixSha256: prefix.prefixSha256,
      callId: entry.callId,
      unitId: entry.unitId,
      originalCode: entry.code,
      originalUsage: entry.usage,
      contextTurns: context.length,
    });
  }
  const main = rows.reduce((total, row) => total + row.prefixTokens, 0);
  const floorHundreds = rows.reduce((total, row) => total + Math.floor(row.lines / 100), 0);
  const asks = 300 * rows.length + 12 * floorHundreds;
  const askText = rows.map(row => row.askText).join("\n");
  const plan = {
    schema: "racoons-sim-refusals-plan/1",
    lane: lane.lane,
    variant,
    assetName: lane.assetName,
    askText,
    askTextSha256: sha256Hex(utf8(askText)),
    stagesSha256: null,
    stages: null,
    arm,
    units: null,
    transcript: null,
    depth,
    moments: rows,
    chain: [],
    final: null,
    cost: { main, asks, arithmetic: { n: rows.length, floorHundreds, base: 300, anchor: 12 } },
    killMs: null,
    stagesFile: null,
  };
  return { plan, momentsById, renders, rows };
}

/** Each selected entry's own moment plus the `depth` appends immediately before it. */
export function withContext(entries, appends, depth) {
  if (depth === 0) return entries.map(entry => ({ ...entry, context: [] }));
  const ordered = [...appends].sort((left, right) => left.seq - right.seq);
  return entries.map(entry => {
    const before = ordered.filter(append => append.seq < entry.body.seq);
    const window = before.slice(Math.max(0, before.length - depth));
    return {
      ...entry,
      context: window.map(append => ({
        id: `context:${String(append.seq)}`,
        lane: DEFAULT_ARM,
        seq: append.seq,
        step: append.step,
        original: { text: append.text },
      })),
    };
  });
}

/** `SIM_LIVE_ARMED=1 node dev/sim/sim-refusals.mjs --live --i-am-the-owner …`. */
export function launchLine(opts, plan) {
  return `${LIVE_ENV}=1 node dev/sim/sim-refusals.mjs --live ${OWNER_FLAG}`
    + ` --producer ${opts.producer ?? "dev/sim/producer-a6-inprocess.mjs"}`
    + ` --kill-ms ${String(opts.killMs)} --token-grant ${String(plan.cost.main)}`
    + ` --ask-ceiling ${String(plan.cost.main + plan.cost.asks)} --out ${String(opts.out ?? "<out.jsonl>")}`;
}

/** The dry report: the join, the counts, the cost, the first ask, the launch line. */
export function formatDry({ opts, all, selected, plan, found, refusals }) {
  const counts = countsByCode(all);
  const picked = countsByCode(selected);
  const pairs = map => [...map]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([code, count]) => `${code} ${String(count)}`).join(", ");
  const first = plan.moments[0];
  const bandLine = selected.length === EXPECTED_REFUSALS
    ? "the band reads: 70–87 pass, ≤69 investigate, ≥88 revise"
    : `a filtered run (${String(selected.length)} of ${String(EXPECTED_REFUSALS)}): the band does not apply`;
  return [
    "sim-refusals — dry (no --live: nothing armed, no socket opened)",
    `  events       ${opts.events}`,
    `  session      ${opts.session}`,
    `  join         ${String(found)}/${String(refusals)} refusals joined by callId ->`
      + " data.message.toolCallId (surfaceOp append, type tool/result)",
    `  refusals     ${String(refusals)}: ${pairs(counts)}`,
    `  selected     ${String(selected.length)}: ${pairs(picked)}`,
    `  depth        ${String(opts.depth)} (each ask carries ${String(opts.depth + 1)} turn(s))`,
    `  variant      ${plan.variant} (lane ${plan.lane}; asset ${plan.assetName})`,
    `  prompt       ${opts.prompt === "old" ? `pre-rewrite, ${OLD_PROMPT_REV}`
      : "the built @cremator/core dist (rebuild after the ISSUE-106 fix to ask with it)"}`,
    `  first ask carries "Memory management": ${String(first.askText.includes("Memory management"))};`
      + ` "Prune aggressively": ${String(first.askText.includes("Prune aggressively"))}`,
    "  cost (two numbers, never summed)",
    `   bodies  ${String(plan.cost.main)}  Σ τ(prefix bytes), never per-term division`,
    `   asks    ${String(plan.cost.asks)}  300·${String(plan.cost.arithmetic.n)} + 12·`
      + `${String(plan.cost.arithmetic.floorHundreds)}; the ask ceiling's own number`,
    `   total   ${String(plan.cost.main + plan.cost.asks)}  what this pass bills if every ask is one request`,
    `   measured reference, 2026-10-29: these 149 asks cost ≈221k tokens (bodies 175.6k +`
      + ` instructions 45.1k). This estimate is ${String(plan.cost.main + plan.cost.asks)}`
      + " because τ divides each row's BYTES; the 175.6k reference divided chars",
    `  band         ${bandLine}`,
    `  first ask (${first.callId}, original code ${first.originalCode},`
      + ` ${String(first.bytes)} B body, ${String(first.lines)} lines)`,
    "  ---8<---",
    first.askText,
    "  --->8---",
    "  launch (armed only; refuses at exit 2 otherwise)",
    `   ${launchLine(opts, plan)}`,
  ].join("\n");
}

/**
 * A transport-level failure's code, in run C's own vocabulary: the adapter
 * journals `timeout` for a stalled stream, `empty-text` for a reply with no
 * text, and `stream-error` for anything else the route or the socket raised.
 */
function transportCodeOf(entry) {
  if (entry?.timedOut === true) return "timeout";
  const reason = String(entry?.reason ?? "");
  return /empty/i.test(reason) ? "empty-text" : "stream-error";
}

/**
 * The replay's own evidence: one row per selected ask, then one summary line.
 * A row carries the original code beside the replay's own reading, so a filtered
 * or killed pass can still be read row by row.
 *
 * `sent` says whether the ask left; `accepted` is true only for a sent ask whose
 * answer the product would have applied; `replayCode` is that answer's refusal
 * code (`null` when accepted). An unsent row is `unasked` — a ceiling, the kill
 * box or a crash stopped the pass before it. A transport failure was sent and
 * gets its own code, never `unasked`.
 */
export function replayRecords({ plan, partial, promptLabel, exitCode }) {
  const sent = new Map();
  for (const row of partial) {
    if (row?.kind === "answer") sent.set(row.index, row);
  }
  const records = plan.moments.map((moment, index) => {
    const answer = sent.get(index) ?? null;
    const text = answer?.status === "answered" ? answer.answer : null;
    const code = answer === null ? null
      : text === null ? transportCodeOf(answer) : replayCodeOf(text, moment.totalLines);
    return {
      schema: "racoons-sim-refusals/1",
      kind: "replay",
      index,
      callId: moment.callId,
      unitId: moment.unitId,
      momentId: moment.id,
      seq: moment.seq,
      step: moment.step,
      originalCode: moment.originalCode,
      originalUsage: moment.originalUsage,
      sent: answer !== null,
      accepted: code === null && answer !== null,
      replayCode: code,
      reason: answer?.reason ?? null,
      usage: answer?.usage ?? null,
      answer: text,
      answerSha256: answer?.answerSha256 ?? null,
      askTokens: moment.askInstruction + moment.prefixTokens,
      requestSha256: moment.sentRequestSha256 ?? moment.requestSha256,
      prompt: promptLabel,
    };
  });
  const unasked = records.filter(record => !record.sent).length;
  const asked = records.length - unasked;
  const accepted = records.filter(record => record.accepted).length;
  const remaining = asked - accepted;
  const full = plan.moments.length === EXPECTED_REFUSALS && asked === plan.moments.length;
  const band = !full
    ? { applies: false, verdict: "not-applicable" }
    : remaining < BAND.passLow ? { applies: true, verdict: "investigate", reading: "≤69" }
      : remaining <= BAND.passHigh ? { applies: true, verdict: "pass", reading: "70–87" }
        : { applies: true, verdict: "revise", reading: "≥88" };
  const byOriginal = {};
  const byReplay = {};
  for (const record of records.filter(entry => entry.sent)) {
    byOriginal[record.originalCode] = (byOriginal[record.originalCode] ?? 0) + 1;
    const key = record.accepted ? "accepted" : String(record.replayCode);
    byReplay[key] = (byReplay[key] ?? 0) + 1;
  }
  const summary = {
    schema: "racoons-sim-refusals/1",
    kind: "summary",
    selected: plan.moments.length,
    asked,
    accepted,
    refusals: remaining,
    unasked,
    band,
    over347: {
      applies: full,
      refusals: remaining,
      total: EXPECTED_REFUSALS + ANSWERED_IN_RUN_C,
      note: "the 198 run C answered stay answered; only the 149 were re-asked",
    },
    byOriginalCode: byOriginal,
    byReplayCode: byReplay,
    projection: { main: plan.cost.main, asks: plan.cost.asks },
    prompt: promptLabel,
    exitCode,
  };
  return { records, summary };
}

/** The summary as the plain lines a reader scans. */
export function formatSummary(summary) {
  const pairs = map => Object.entries(map).map(([code, count]) => `${code} ${String(count)}`);
  const projected = summary.over347.applies
    ? `   projected over 347: ${(summary.over347.refusals / summary.over347.total * 100).toFixed(1)}%`
    : "   (a filtered or partial run: no projection over 347)";
  const bandLine = summary.band.applies
    ? `${summary.band.verdict} (${summary.band.reading})`
    : "not-applicable (the band reads only for the full 149)";
  return [
    `sim-refusals summary: ${String(summary.asked)} of ${String(summary.selected)} asked,`
      + ` ${String(summary.accepted)} accepted, ${String(summary.refusals)} refused`
      + ` (${String(summary.unasked)} unasked)`,
    `  remaining refusals   ${String(summary.refusals)} of ${String(EXPECTED_REFUSALS)} re-asked`,
    projected,
    `  band                 ${bandLine}`,
    `  by original code     ${pairs(summary.byOriginalCode).join(", ")}`,
    `  by replay code       ${pairs(summary.byReplayCode).join(", ")}`,
    `  prompt               ${summary.prompt}`,
    `  exit                 ${String(summary.exitCode)}`,
  ].join("\n");
}

async function main(argv) {
  const opts = parseArgs(argv);
  const events = readJsonl(opts.events);
  const sessionRows = readTranscript(path.resolve(REPO_ROOT, opts.session));
  const joined = joinRefusals({ events, session: sessionRows });
  const selected = selectRows(joined, { codes: opts.codes, perCode: opts.perCode, limit: opts.limit });
  if (selected.length === 0) refuse("usage", "the filters select no refusal row");
  const appends = [...bodyIndex(sessionRows).values()];
  const withCtx = withContext(selected, appends, opts.depth);
  const promptText = opts.prompt === "old" ? loadOldPrompt(opts.variant) : null;
  if (promptText !== null) {
    // The composer must be the shipped renderer for the lane's own prompt, or
    // the old-prompt cell measures a different ask than the new-prompt cell.
    const probe = entryAskFacts(new Uint8Array(utf8(withCtx[0].body.text)));
    const expected = entryAskMessage({ ...probe, variant: opts.variant });
    if (opts.variant === "default" && composeAskText(ENTRY_ASK_SYSTEM_PROMPT, probe, opts.variant) !== expected) {
      refuse("sim-refusals-prompt-parser", "composeAskText does not reproduce entryAskMessage");
    }
  }
  const { plan, momentsById, renders } = buildReplay(withCtx,
    { arm: DEFAULT_ARM, variant: opts.variant, depth: opts.depth, promptText });
  const promptLabel = promptText === null ? "built-dist" : `old:${OLD_PROMPT_REV}`;
  if (!opts.live) {
    // The plan's per-row `askText` is 700 kB over the full 149; the JSON dry
    // report carries the rows without it and keeps one ask for inspection.
    const { askText: whole, moments, ...rest } = plan;
    const json = {
      joined: joined.length, selected: selected.length, prompt: promptLabel,
      plan: { ...rest, askTextSha256: plan.askTextSha256,
        moments: moments.map(({ askText, ...row }) => row) },
      firstAsk: moments[0].askText,
    };
    process.stdout.write(`${opts.json ? `${JSON.stringify(json, null, 2)}\n`
      : `${formatDry({ opts, all: joined, selected, plan, found: joined.length, refusals: EXPECTED_REFUSALS })}\n`}`);
    return 0;
  }
  gateLive(opts);
  preflight([plan]);
  // The estimate is printed BEFORE the first ask (ISSUE-104 §8): the measured
  // full-149 cost is ≈221k tokens, and this pass's own projection is stated so a
  // reader can tell a filtered run from the full one.
  process.stdout.write(`sim-refusals — live: ${String(plan.moments.length)} asks, depth`
    + ` ${String(opts.depth)}, variant ${plan.variant}, prompt ${promptLabel}\n`
    + `  estimate  ${String(plan.cost.main + plan.cost.asks)} tokens`
    + ` (bodies ${String(plan.cost.main)} + instructions ${String(plan.cost.asks)});`
    + " the measured full-149 pass cost ≈221k\n"
    + `  box       ${String(opts.killMs)} ms, armed before the first ask;\n`
    + `  ceilings  --token-grant ${String(opts.tokenGrant)}, --ask-ceiling`
    + ` ${String(opts.askCeiling)}\n`);
  const producer = await loadProducer(opts.producer);
  // `--prompt old` swaps the ask into the request body at the producer seam: the
  // harness builds the body from the dist, and the body sent is what the sha in
  // our own row describes.
  const wrapped = promptText === null ? producer : async call => {
    const text = call.row.askTextOverride;
    if (typeof text !== "string") return producer(call);
    const body = {
      ...call.request.body,
      messages: [...call.request.body.messages.slice(0, -1), { role: "user", content: text }],
    };
    const request = { ...call.request, askText: text, askBytes: utf8(text).length, body,
      requestSha256: sha256Hex(utf8(JSON.stringify(body))) };
    // The row is the plan's own object, so the sha the pass actually sent is
    // written beside the one `buildAskRequest` returned from the dist's prompt.
    call.row.sentRequestSha256 = request.requestSha256;
    return producer({ ...call, request });
  };
  // The harness's own partial pass lands beside the replay file: `<stem>.partial.jsonl`.
  const replayOut = path.resolve(REPO_ROOT, opts.out);
  const partialOut = `${replayOut.slice(0, replayOut.length - path.extname(replayOut).length)}.partial.jsonl`;
  mkdirSync(path.dirname(partialOut), { recursive: true });
  const result = await runLive({ ...opts, out: partialOut }, {
    producer: wrapped,
    rendered: null,
    momentsById,
    plan,
    renderFor: row => {
      const rendered = renders.get(row.id);
      if (rendered === undefined) {
        refuse("sim-refusals-render-absent", `${row.id} has no per-row render`);
      }
      return rendered;
    },
  });
  const partial = readJsonl(partialOut);
  const { records, summary } = replayRecords({
    plan, partial, promptLabel, exitCode: result.exitCode,
  });
  mkdirSync(path.dirname(replayOut), { recursive: true });
  writeFileSync(replayOut, `${[...records, summary].map(record => JSON.stringify(record)).join("\n")}\n`);
  process.stdout.write(`${formatSummary(summary)}\n  replay    ${replayOut}\n  partial   ${partialOut}\n`);
  return result.exitCode;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  });
}
