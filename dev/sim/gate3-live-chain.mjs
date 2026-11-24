#!/usr/bin/env node
/**
 * ISSUE-059 T-4 — gate 3 on the live lane: the record adapter → the lane render
 * → the five terms → the prefix-hash chain, proven offline on the sim fixture.
 *
 * Usage:
 *   node dev/sim/gate3-live-chain.mjs [--units <dir> --transcript <file>]
 *        [--arm <name>] [--node-id auto|dsh|sim-result] [--out <dir>]
 *        [--flip kept|summary|early|late] [--json] [--quiet]
 *   node dev/sim/gate3-live-chain.mjs --check-repro --units <dir>
 *        --transcript <file> [--arm <name>] [--node-id ...] [--json]
 *
 * Default input: the committed synthetic fixture (`dev/bench/fixtures/sim/`,
 * T-2), converted by `live-convert.mjs` into a fresh temporary directory. With
 * `--units` the gate reads a record that already exists, and then `--transcript`
 * is required: a chain always needs the arm's own transcript for the landed
 * bodies, the answers and the proof burn's step.
 *
 * ## The chain, in four stages
 *
 *   1. RECORD      `sim-record.mjs` reads a live-convert output directory into
 *                  moments. The gate supplies the three caller fields a
 *                  byte-level re-render needs and the adapter cannot carry:
 *                  `original.text` (the landed body, from the transcript),
 *                  `source.nodeId` (the archive source the marker's recall id is
 *                  minted over) and `record.atRest.step` (the at-rest burn's
 *                  step). `original.sha256` still cross-checks the bytes.
 *
 *                  An answer row states its step before ISSUE-074 and states
 *                  none after it (scheme A: the answer is a `user/message`).
 *                  A step-less answer's step is DERIVED (`answerStepOf`): the
 *                  next `step/start` after the row, or, when none follows, the
 *                  step its own result landed at plus one. Both derivations
 *                  absent is `gate3-answer-step-absent`, the same name a stated
 *                  but malformed step gets. `answerStepsDerived` counts them.
 *                  Which RESULT an answer decides is answered by the next
 *                  section, never by "the last result that landed".
 *   2. RENDER      `sim-render.mjs` renders lane K (the record's own decisions)
 *                  and the pristine lane OFF (the same record with no decision;
 *                  the machinery burn stays, because it is no decision).
 *   3. TERMS       every shaped row's five terms are re-verified: the identity
 *                  closes, the record's own numbers agree, the kept bytes are
 *                  recomputed from the landed body, and the dropped count is
 *                  read back out of the marker line.
 *   4. CHAIN       every observed step's prefix is recomputed by the gate from
 *                  the rows and hashed; the chain extends byte-wise or a swap
 *                  happened in the window, the lanes agree until the first
 *                  decision takes effect, and a decision at step S is invisible
 *                  at S and visible at S+1.
 *
 * ## The named checks, each with a red path reachable offline
 *
 *   landed-body       each row's `before` is the transcript's landed append.
 *   self-reproduction pristine plus lane K's decisions equals the transcript's
 *                     shaped bodies and the at-rest receipt, byte for byte, and
 *                     every shaped body the RECORD declares is accounted for.
 *   summary-prefix    every shaped body opens with its answer's note and the
 *                     mount's blank line.
 *   five-terms        the identity closes on every shaped row, the record's own
 *                     terms agree, kept is recomputed and dropped is re-read.
 *   marker-line       a marker owns its whole line: every line carrying
 *                     `[racoons]` is one marker, no kept text shares it.
 *   recall-id         the marker names the record's recall id; the receipt names
 *                     the burn's.
 *   censored-receipt  an at-rest burn swaps from a stated step, never from a
 *                     step the caller left null.
 *   epoch-plan        the shipped `epochsFor`/`appliedSetAt` reproduce the plan,
 *                     and the applied set at every observed step is exactly the
 *                     set of shaped bodies that step's prefix carries.
 *   lane-equality     OFF and K are byte-identical until the first decision
 *                     takes effect, and differ after it.
 *   step-visibility   a decision at its recorded step S is invisible at S and
 *                     visible at S+1; a keepall changes no byte.
 *   prefix-chain      each recorded step hash equals the gate's own recompute,
 *                     consecutive steps extend or rewrite, and the chain is
 *                     total over the observed steps.
 *   node-id-form      `--node-id auto` resolves the archive-source form against
 *                     the transcript's own bodies and says which form it used.
 *   non-vacuity       a `--flip` that reddens nothing is itself red.
 *
 * `--flip <name>` mutates one thing and must redden a named check:
 *
 *   kept      one kept byte of the first shaped body moves (same length).
 *   summary   one byte of the first shaped body's note moves (same length).
 *   early     the first shaped decision moves one step earlier.
 *   late      the first shaped decision moves one step later.
 *
 * ## `--check-repro`
 *
 * The mode T-5 hands run B's self-reproduction to: given a converted record dir
 * and its transcript, re-render every shaped body (and the at-rest receipt) and
 * compare it to the transcript's own row, byte for byte. The pass walks the
 * RECORD's bodies, so a shaped unit the lane never re-rendered (an answer the
 * attribution could not place) is a named red `repro-body` rather than a row
 * that quietly is not there. A body that does not reproduce is a named red
 * `repro-body` with its seq and first differing byte; a record with no shaped
 * body at all is a named red `repro-empty` (an absent oracle is never a pass).
 *
 * Every body is MATCHED, CENSORED BY NAME or REFUSED BY NAME, and the three
 * counts print. Green requires `matched = total − censored`; a body that is
 * none of the three cannot exist by construction, and the pass refuses
 * (`gate3-coverage-unclosed`) rather than print a set that does not close. It
 * exits 0 only on a green whose counts close.
 *
 * ## Which result an answer decides
 *
 * See `indexTranscript`: the ask's own facts (`This result has N lines, so
 * keeplines ranges sit in [1,N]. Quotes to help you locate them:` plus
 * its anchors, from `entryAskFacts`) or a forget's shaped turn name the result;
 * the record's per-unit ask anchor breaks a tie. "The last result that landed"
 * is not used anywhere. An answer no stated rule can place is
 * `gate3-answer-unattributable`, refused by name; the two censoring kinds (an
 * at-rest burn, a unit the record censors) are counted with their prompt seqs,
 * and a unit the record says was asked with no answer is `mint-answer-absent`
 * at the mint, never minted mute.
 *
 * ## Node-id forms, and why `auto` is a resolution and not a guess
 *
 * The marker embeds the recall id, which is minted over the archive source's
 * node id. A live run's identity is the mount's own (`dsh:<session>:result:
 * <callId>`, `packages/adapters/dsh/src/mount-revert.ts:38`); the synthetic
 * fixture's builder names it `sim-result-<file>`. `--node-id auto` renders under
 * each form in that order and keeps the first that reproduces EVERY shaped body
 * — the transcript's own bytes are the oracle, and the form is printed and
 * recorded. When no form reproduces, the best one is still read so every
 * mismatched body prints its own seq and byte: `self-reproduction` in chain
 * mode, `repro-body` in `--check-repro`.
 *
 * ## Offline only
 *
 * No clock, no socket, no key, no randomness in any output. A live mode does
 * not exist here: `--live-asks` is refused by name and `CREMATOR_SIM_REAL=1` in
 * the environment is refused at exit 2 (`gate3-offline-only`). Live asks are
 * T-9's `sim-live.mjs`.
 *
 * Exit: 0 = green, 1 = a named check failed, 2 = usage or input error.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY_ASK_END_ANCHOR, appliedSetAt, complementLineSpans, epochsFor, parseEntryAnswer,
  renderHistory, splitLineOffsets,
} from "@cremator/core";
import { entryAskFacts } from "cremator-dsh";
import { loadRecord, momentsOf } from "./sim-record.mjs";
import { prefixTextAt, renderLane } from "./sim-render.mjs";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: gate3-live-chain.mjs [--units <dir> --transcript <file>] [--arm <name>]",
  "                           [--node-id auto|dsh|sim-result] [--out <dir>]",
  "                           [--flip kept|summary|early|late] [--json] [--quiet]",
  "       gate3-live-chain.mjs --check-repro --units <dir> --transcript <file>",
  "                           [--arm <name>] [--node-id auto|dsh|sim-result]",
  "       --units       a live-convert.mjs output directory (required with",
  "                     --transcript, or --check-repro); absent: the sim fixture",
  "                     is converted into a fresh temporary directory",
  "       --transcript  the arm's session.v4.jsonl: landed bodies, answers,",
  "                     proof-burn steps",
  "       --arm         the lane to render (default racoons)",
  "       --node-id     the archive-source form; auto (default) resolves it",
  "                     against the transcript's own shaped bodies",
  "       --out         write lane-off.json, lane-k.json and gate3-report.json",
  "                     (<name>.tmp then rename)",
  "       --flip        mutate one thing; the run must go red by name",
  "       --check-repro re-render every shaped body and compare it to the",
  "                     transcript's own row, byte for byte",
  "       --json        print the report as JSON",
  "       --quiet       print only the FAIL lines and the verdict",
].join("\n");

/** The four perturbations a run accepts. */
export const FLIP_NAMES = ["kept", "summary", "early", "late"];

/** The node-id forms, in resolution order: the mount's own, then the fixture's. */
export const NODE_ID_FORMS = ["dsh", "sim-result"];

/** The named checks, in report order. */
export const CHECK_NAMES = [
  "landed-body", "answer-attribution", "self-reproduction", "summary-prefix", "five-terms",
  "marker-line", "recall-id", "censored-receipt", "epoch-plan", "lane-equality",
  "step-visibility", "prefix-chain", "node-id-form", "non-vacuity",
];

const DEFAULT_ARM = "racoons";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONVERTER = path.join(REPO_ROOT, "dev", "bench", "multiturn", "live-convert.mjs");
const FIXTURE = path.join(REPO_ROOT, "dev", "bench", "fixtures", "sim");
const FIXTURE_MANIFEST = path.join(FIXTURE, "manifest.json");
const FIXTURE_TRANSCRIPT = path.join(FIXTURE, "sim.session.v4.jsonl");

/** A refusal with the code the gate asserts on. */
export class Gate3Refusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "Gate3Refusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new Gate3Refusal(code, detail);
}

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = text => Buffer.from(text, "utf8");
const byteLength = text => utf8(text).length;

/** The text one transcript row carries; a row's content parts, joined. */
export function textOf(row) {
  const content = row.data?.message?.content;
  if (Array.isArray(content)) {
    // The type check is the OTHER branch's rule. Without it a malformed part
    // leaked whatever `part.text` held into the body: `{type:"text", text: 42}`
    // contributed `"42"` to the text, its line count and every byte figure read
    // from it (`{type:"text"}` with no `text` merely vanished under `join`).
    return content.filter(part => part?.type === "text" && typeof part?.text === "string")
      .map(part => part.text).join("");
  }
  const parts = row.data?.content;
  if (!Array.isArray(parts)) return "";
  return parts.filter(part => typeof part?.text === "string").map(part => part.text).join("");
}

/**
 * The thinking signatures a transcript may name for a reasoning block. Only
 * these three say WHICH wire field the text came from, so only these three may
 * be resent as `reasoning_content`; any other signature is stored but opaque,
 * and its text is not put back on the wire (ADR-0045).
 */
export const RESENDABLE_REASONING_SIGNATURES = Object.freeze([
  "reasoning", "reasoning_content", "reasoning_text",
]);

/**
 * The reasoning one transcript row carries (ADR-0045), read off the same
 * `data.message.content` array `textOf` reads: every `type:"reasoning"` part
 * whose text is not blank, joined with a newline. Blank parts are dropped so an
 * empty block never makes a turn look like it said something.
 *
 * `signature` is the replay state's `thinkingSignature` for every block that
 * carries text, honoured only when `replayState.blocks` aligns with the content
 * one-to-one — same length, same `type` at every index. An unaligned replay
 * state names no signature rather than guessing which block it belonged to.
 *
 * `resendable` is true only when EVERY non-blank reasoning part on the turn has
 * a signature from `RESENDABLE_REASONING_SIGNATURES` AND all of them name the
 * same signature. Reading only the FIRST block let a turn with one resendable
 * and one opaque block pass, and its joined text — the opaque block's included —
 * was sent as `reasoning_content` (P5). A turn whose blocks name different wire
 * fields cannot be put back through one `reasoning_content` field, so it is not
 * resendable either. `signature` reports the shared signature when every block
 * agrees and `null` otherwise; a turn with no non-blank reasoning part has no
 * signature at all.
 */
export function reasoningOf(row) {
  const content = row.data?.message?.content;
  if (!Array.isArray(content)) return { text: "", signature: null, resendable: false };
  const blocks = row.data?.message?.source?.replayState?.blocks;
  const aligned = Array.isArray(blocks) && blocks.length === content.length
    && blocks.every((block, at) => block?.type === content[at]?.type);
  const carried = [];
  for (const [at, part] of content.entries()) {
    if (part?.type !== "reasoning") continue;
    if (typeof part.text !== "string" || part.text.trim() === "") continue;
    carried.push({ text: part.text,
      signature: aligned ? blocks[at]?.thinkingSignature ?? null : null });
  }
  const text = carried.map(part => part.text).join("\n");
  const signatures = carried.map(part => part.signature);
  const shared = signatures.length > 0 && signatures.every(signature => signature === signatures[0])
    ? signatures[0] : null;
  const resendable = signatures.length > 0
    && signatures.every(signature => signature !== null
      && RESENDABLE_REASONING_SIGNATURES.includes(signature))
    && shared !== null;
  return { text, signature: shared, resendable };
}

/** The transcript as rows; a bad line is named with its number. */
export function readTranscript(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse("gate3-transcript-unreadable", `${file}: ${error.message}`);
  }
  const rows = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      refuse("gate3-transcript-unreadable", `${file} line ${index + 1}: ${error.message}`);
    }
  }
  return rows;
}

/**
 * The row types a message can be written in. The answer row is an
 * `assistant/message` before ISSUE-074 and a `user/message` after it (scheme A),
 * and a rewind is published in the shadowed span's FIRST node type, so all three
 * are read.
 */
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "system/message"]);

const isMessageAppend = row => MESSAGE_TYPES.has(row?.type) && row?.surfaceOp === "append";

const isMessageReplace = row => MESSAGE_TYPES.has(row?.type)
  && typeof row?.surfaceOp === "object" && row?.surfaceOp !== null
  && row.surfaceOp.op === "replace";

const isReplace = row => typeof row?.surfaceOp === "object" && row?.surfaceOp !== null
  && row.surfaceOp.op === "replace";

/** The one line the ask's facts block states its line count on. */
const ASK_COUNT_LINE = /^This result has (\d+) lines\b/;
/** The anchor lines the facts block renders: a quoted line, or a blank band. */
const ASK_ANCHOR_LINE = /^(?:line \d+(?: of \d+)? ends with ".*"|lines \d+–\d+ are blank)$/;

// Old-format records state `line X of Y ends with …`; today's entry ask never
// does (`anchorsFor` passes `withTotal: false`), so drop the clause to key
// both against the same facts — an old record must still pair.
const canonicalAnchor = anchor => anchor.replace(/^(line \d+) of \d+ (ends with .*)$/, "$1 $2");

/**
 * The facts block an ask prompt states: `This result has N lines, so keeplines
 * ranges sit in [1,N]. Quotes to help you locate them:`, then the anchor lines,
 * then a blank line. The LAST count line wins, because a retry turn restates the
 * same facts after a correction paragraph.
 *
 * This is the ask's own declaration of which landed result it is about, and it
 * is what the attribution joins on: `entryAskFacts` over a landed body gives the
 * same two facts. No prose is searched beyond the block, so a body that quotes
 * the prompt cannot spoof it.
 */
export function askFactsOf(text) {
  const lines = text.split("\n");
  let at = -1;
  let lineCount = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = ASK_COUNT_LINE.exec(lines[index]);
    if (match === null) continue;
    at = index;
    lineCount = Number(match[1]);
  }
  if (at < 0) return null;
  const anchorLines = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    if (!ASK_ANCHOR_LINE.test(lines[index])) break;
    anchorLines.push(canonicalAnchor(lines[index]));
  }
  return { lineCount, anchorLines };
}

/** The facts key two facts sets must share to be the same result. */
export function factsKeyOf(facts) {
  return facts === null ? null : JSON.stringify([facts.lineCount, facts.anchorLines]);
}

/** The facts a landed body states, by the product's own arithmetic. */
export function bodyFactsKey(body) {
  return factsKeyOf(entryAskFacts(utf8(body)));
}

/**
 * The transcript read once: the landed append bodies, the same-seq shaped rows,
 * the at-rest proof burns, and the ask exchanges with their answers.
 *
 * ## Why an answer is not keyed to "the last result that landed"
 *
 * A real step lands SEVERAL results, then asks about each in turn, and a
 * sub-floor result often lands BETWEEN an over-floor result and its ask (the ask
 * floor is the session's; the mint floor is higher). "The last landed row before
 * the answer" therefore attaches an answer to whatever happened to land last,
 * not to the result the ask named. Run B measured 38 of 69 answers mis-attributed
 * that way, two of them on at-rest burns. It is gone.
 *
 * ## The attribution, and each rule's evidence
 *
 * An ask EXCHANGE is one contiguous block of message appends — the prompt, any
 * retry prompt, and the answer rows — closed by the rewind (`replace`) that
 * publishes over `[prompt.seq … lastAnswer.seq]`. The block is the transcript's
 * own shape, not an inference: the mount writes both ask turns as appends and
 * then one rewind (`plugin.ts`'s `appendAskTurns`, `rewindAskExchange`).
 *
 * Which RESULT an exchange decides, in the order the rules are applied:
 *
 *   1. SHAPE   A forget's shaped turn lands immediately after its exchange's
 *              rewind, and its `surfaceOp.startSeq` IS the result it reshaped.
 *              That row names its target outright — no join, no guess.
 *   2. FACTS   The ask ships facts, not the body: `This result has N lines, so
 *              keeplines ranges sit in [1,N]. Quotes to help you locate them:`
 *              plus the anchor lines, rendered by the product's own
 *              `entryAskFacts`/`entryAskMessage` over the landed bytes. So the
 *              prompt DECLARES the result it is about, and the join is over
 *              `(N, anchor lines)` against the landed bodies. The landed rows of
 *              the ask's own step are tried first; a unique match is the target.
 *   3. RECORD  Two landed rows in one step can state identical facts (two
 *              listings of the same line count produce the same `N` and no
 *              anchors below 100 lines). The record's per-unit
 *              `unitSpan.startSeq` names the ask prompt the converter paired that
 *              unit with, so it BREAKS A TIE among facts-equal candidates. It
 *              never overrides a facts match: the converter pairs a keep-all by
 *              position, and run B's units 36 and 82 point at prompts asking
 *              about other rows.
 *
 * There is no fourth rule. The brief forbids the adjacency heuristic and this
 * module has none: the prompt's own facts or the record's own anchor, nothing
 * else. Whatever neither rule places is `resolveAttribution`'s to refuse or to
 * account by name — never dropped, and never placed here.
 *
 * This function places NO answer: an answer needs the record to break a facts
 * tie, so `resolveAttribution` is the one place an answer becomes a decision.
 *
 * An ANSWER row is decoded by the product's own grammar, never a second one;
 * prose that does not parse is skipped, a malformed fixture answer throws.
 *
 * The answer entry carries the answer row's own `seq` and its index in the file,
 * and the step/start rows that follow it: an answer row written after ISSUE-074
 * (scheme A) states no step, so its step is derived (see `answerStepOf`).
 */
export function indexTranscript(rows) {
  const landed = new Map();
  const landedSteps = new Map();
  const shaped = new Map();
  const burns = new Map();
  const stepStarts = [];
  const stepEnds = [];
  for (const [index, row] of rows.entries()) {
    if (row.type === "step/start" && Number.isSafeInteger(row.data?.step)) {
      stepStarts.push({ index, step: row.data.step });
    }
    if (row.type === "step/end" && Number.isSafeInteger(row.data?.step)) {
      stepEnds.push({ index, step: row.data.step });
    }
    if (row.type === "tool/result" && row.surfaceOp === "append") {
      landed.set(row.seq, textOf(row));
      // The result row's own step, kept for the answer-step derivation: a
      // scheme-A answer row states none, so this is its fallback.
      landedSteps.set(row.seq, Number.isSafeInteger(row.data?.step) ? row.data.step : null);
      continue;
    }
    if (row.type === "tool/result" && typeof row.surfaceOp === "object"
      && row.surfaceOp.startSeq === row.surfaceOp.endSeq) {
      const body = textOf(row);
      if (body.startsWith("[not retained]")) {
        burns.set(row.surfaceOp.startSeq, { body, step: row.data?.step ?? null, seq: row.seq });
      } else if (body.includes("[racoons] kept")) {
        shaped.set(row.surfaceOp.startSeq, { body, step: row.data?.step ?? null, seq: row.seq });
      }
      continue;
    }
  }
  const landedOrder = [...landed.keys()].sort((left, right) => left - right);
  const factsKeys = new Map();
  const factsKeyAt = seq => {
    if (!factsKeys.has(seq)) factsKeys.set(seq, bodyFactsKey(landed.get(seq) ?? ""));
    return factsKeys.get(seq);
  };

  const exchanges = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!isMessageAppend(rows[index]) || !textOf(rows[index]).includes(ENTRY_ASK_END_ANCHOR)) {
      continue;
    }
    const promptSeq = rows[index].seq;
    const promptFacts = askFactsOf(textOf(rows[index]));
    const promptKey = factsKeyOf(promptFacts);
    // The exchange's block: every message append that follows the prompt, up to
    // the rewind that closes it. A RETRY prompt restates the same facts, so it is
    // part of the block; a prompt stating other facts begins the next exchange.
    let end = index;
    while (end + 1 < rows.length && isMessageAppend(rows[end + 1])) {
      const next = rows[end + 1];
      if (isMessageAppend(next) && textOf(next).includes(ENTRY_ASK_END_ANCHOR)
        && factsKeyOf(askFactsOf(textOf(next))) !== promptKey) break;
      end += 1;
    }
    let rewind = null;
    let blockEnd = end;
    for (let at = end; at >= index; at -= 1) {
      const next = rows[at + 1];
      if (isMessageReplace(next) && next.surfaceOp.startSeq === promptSeq
        && next.surfaceOp.endSeq === rows[at].seq) {
        rewind = { row: next, index: at + 1 };
        blockEnd = at;
        break;
      }
    }
    const answers = [];
    for (let at = index + 1; at <= end; at += 1) {
      if (!isMessageAppend(rows[at])) continue;
      let answer;
      try {
        answer = parseEntryAnswer(textOf(rows[at]));
      } catch {
        continue;
      }
      answers.push({ rowIndex: at, seq: rows[at].seq, answer });
    }
    const stated = rows[index].data?.step;
    const boundary = Number.isSafeInteger(stated) ? stated
      : ([...stepEnds].reverse().find(entry => entry.index < index)
        ?? [...stepStarts].reverse().find(entry => entry.index < index))?.step ?? null;
    const application = rewind === null ? undefined : rows[rewind.index + 1];
    const shapedTarget = application !== undefined && application.type === "tool/result"
      && isReplace(application) && application.surfaceOp.startSeq === application.surfaceOp.endSeq
      ? application.surfaceOp.startSeq : null;
    const facts = askFactsOf(textOf(rows[index]));
    const exchange = {
      promptSeq,
      promptIndex: index,
      blockStep: boundary,
      answer: answers[answers.length - 1] ?? null,
      answerSeqs: answers.map(entry => entry.seq),
      // Only an applied answer decided anything: a rewind is the host write that
      // applies it. No rewind is the fail-open shape, and it stays undecided.
      applied: rewind !== null,
      rewindSeq: rewind === null ? null : rewind.row.seq,
      shapedTarget,
      facts,
      factsKey: factsKeyOf(facts),
      target: shapedTarget,
      by: shapedTarget === null ? null : "shape",
      candidates: [],
      candidateBasis: null,
    };
    if (exchange.target === null && exchange.answer !== null) {
      // The facts name a result whether or not the host applied the answer, so
      // the candidates are read for every answered exchange. `applied` still
      // decides whether that answer became a decision.
      const earlier = landedOrder.filter(seq => seq < promptSeq);
      const matching = exchange.factsKey === null ? []
        : earlier.filter(seq => factsKeyAt(seq) === exchange.factsKey);
      const sameStep = boundary === null ? []
        : matching.filter(seq => landedSteps.get(seq) === boundary);
      const pool = sameStep.length > 0 ? sameStep : matching;
      exchange.candidates = pool;
      exchange.candidateBasis = sameStep.length > 0 ? "facts-step" : "facts";
      if (pool.length === 1) {
        exchange.target = pool[0];
        exchange.by = exchange.candidateBasis;
      }
    }
    exchanges.push(exchange);
    index = blockEnd;
  }
  // No answer map is returned. An answer that a tie keeps from a unique target
  // needs the RECORD to place it, so the one authority is `resolveAttribution`.
  // A partial map here would be exactly the silent drop this fix removes.
  return { landed, landedSteps, stepStarts, stepEnds, shaped, burns, exchanges };
}

/** The recorded answer for one landed seq, from one exchange. */
function answerEntryOf(exchange, target, by, rows) {
  return {
    step: rows[exchange.answer.rowIndex].data?.step ?? null,
    answer: exchange.answer.answer,
    seq: exchange.answer.seq,
    rowIndex: exchange.answer.rowIndex,
    landedSeq: target,
    by,
    promptSeq: exchange.promptSeq,
  };
}

/**
 * The answers the record can carry, and every answer it cannot, each by name.
 *
 * Three fields decide an exchange on the record side:
 *
 *   target     the seq the shaped turn or the ask's own facts already named
 *   candidates the landed rows those facts fit, when more than one did
 *   applied    the rewind that closed the exchange — the host write that applied
 *              the answer. No rewind is the fail-open shape: nothing was applied.
 *
 * The record's own `unitSpan.startSeq` (the ask prompt the converter paired the
 * unit with) breaks a tie among candidates. A tie that names a UNIT and cannot be
 * broken is `gate3-answer-unattributable`, by name, never a silent drop. A tie
 * among rows that are not units decides no unit either way, so it is counted
 * (`offUnit`) and cannot move the set.
 *
 * ## Two censoring rules, both the record's
 *
 *   machinery     the engine's at-rest proof burn takes no answer, and the
 *                 renderer refuses one on it (`sim-render-censored-decision`).
 *                 An answer the facts attach to a burn is suppressed and named.
 *   refused-ask   the record censors the unit as `refused-ask`: its own field
 *                 says no ask decided it. An answer the facts still attach to it
 *                 is suppressed and named, so the record's censoring and the
 *                 transcript's ask are both reported and neither is overwritten.
 *
 * Both are counts with their prompt seqs, never silence. A unit the record names
 * an ask for (`provenance.source !== null`) and no exchange answers is returned
 * as `unasked`, so the caller refuses it by name instead of minting a row with a
 * decision the transcript cannot support.
 */
export function resolveAttribution({ index, moments, rows }) {
  const bySeq = new Map(moments.map(moment => [moment.seq, moment]));
  const answers = new Map();
  const placed = [];
  const offUnitTies = [];
  const censored = { machinery: [], "refused-ask": [] };
  const unapplied = [];
  const unanswered = [];
  const claimed = new Set();
  const claim = (exchange, target, by) => {
    if (claimed.has(target)) {
      const earlier = placed.find(entry => entry.target === target);
      const duplicate = earlier?.exchange.answer.seq;
      refuse("gate3-answer-duplicate",
        `seq ${String(exchange.answer.seq)}${duplicate === undefined ? ""
          : ` and seq ${String(duplicate)}`} both decide the result at seq ${String(target)}`);
    }
    claimed.add(target);
    placed.push({ exchange, target, by });
  };
  const deciding = [];
  for (const exchange of index.exchanges) {
    if (exchange.answer === null) { unanswered.push(exchange); continue; }
    if (!exchange.applied) { unapplied.push(exchange); continue; }
    deciding.push(exchange);
  }
  // Pass 1: what the shaped turn and a unique facts match already name. Those
  // rows are spoken for, so a later tie cannot steal them.
  for (const exchange of deciding) {
    if (exchange.target === null) continue;
    const moment = bySeq.get(exchange.target);
    const censoredClass = moment?.provenance?.censoredClass ?? null;
    if (censoredClass === "machinery-at-rest-removal") {
      censored.machinery.push({ exchange, moment });
      continue;
    }
    if (censoredClass !== null) {
      censored["refused-ask"].push({ exchange, moment });
      continue;
    }
    claim(exchange, exchange.target, exchange.by);
  }
  // Pass 2: the ties. The record's own ask anchor is the only tie-breaker; a
  // tie among the record's units that it cannot break is refused by name.
  for (const exchange of deciding) {
    if (exchange.target !== null) continue;
    const free = exchange.candidates.filter(seq => !claimed.has(seq));
    if (free.length === 0) {
      // An answer exists and the ask's own facts name no result still free to
      // carry it. That is the mis-attribution symptom, and it is refused by
      // name: never dropped, never landed on the nearest row.
      refuse("gate3-answer-unattributable",
        `seq ${String(exchange.answer.seq)} answers the ask at seq`
        + ` ${String(exchange.promptSeq)}, which states ${JSON.stringify(exchange.facts)};`
        + (exchange.candidates.length === 0
          ? " no landed row before that prompt carries those facts, so the answer names no"
            + " result and a decision is never attached by position"
          : ` every row those facts fit (${JSON.stringify(exchange.candidates)}) already`
            + " carries another answer"));
    }
    const named = free.filter(seq => bySeq.get(seq)?.unitSpan?.startSeq === exchange.promptSeq);
    if (named.length === 1) { claim(exchange, named[0], "record-span"); continue; }
    const units = free.filter(seq => bySeq.has(seq));
    if (units.length > 0) {
      refuse("gate3-answer-unattributable",
        `seq ${String(exchange.answer.seq)} answers the ask at seq`
        + ` ${String(exchange.promptSeq)}, which states ${JSON.stringify(exchange.facts)};`
        + ` the landed rows ${JSON.stringify(units)} all still share those facts and the record`
        + " pairs no unit with that prompt, so no stated rule names one of them");
    }
    // Every free candidate is under the floor: whichever row the answer meant it
    // decides no unit, so it cannot move the set. Counted, with its prompt.
    offUnitTies.push({ promptSeq: exchange.promptSeq, answerSeq: exchange.answer.seq,
      candidates: free });
  }
  for (const entry of placed) {
    answers.set(entry.target, answerEntryOf(entry.exchange, entry.target, entry.by, rows));
  }
  const onUnit = placed.filter(entry => bySeq.has(entry.target));
  const offUnit = placed.filter(entry => !bySeq.has(entry.target))
    .map(entry => ({ promptSeq: entry.exchange.promptSeq, target: entry.target, by: entry.by }));
  const asked = moments.filter(moment =>
    typeof moment.provenance?.source === "string"
    && moment.provenance?.censoredClass === null);
  const unasked = asked.filter(moment => !answers.has(moment.seq));
  return {
    answers,
    placed,
    offUnit,
    offUnitTies,
    censored,
    unapplied,
    unanswered,
    unasked,
    counts: {
      exchanges: index.exchanges.length,
      placed: placed.length,
      onUnit: onUnit.length,
      offUnit: offUnit.length,
      offUnitTies: offUnitTies.length,
      machineryCensored: censored.machinery.length,
      recordCensored: censored["refused-ask"].length,
      unapplied: unapplied.length,
      unanswered: unanswered.length,
      unasked: unasked.length,
    },
  };
}

/**
 * The coverage of the record's own bodies, counted where the renderer can be
 * checked: every shaped turn the record declares (`forget-with-partials`,
 * `forget-all`) and every at-rest receipt must be MATCHED (reproduced byte for
 * byte), CENSORED BY NAME (the record censors it — a receipt), or REFUSED BY
 * NAME (a named failure). The three counts must sum to the body count, and green
 * is `matched === total - censored`: a green over a subset is not a green.
 *
 * This is what closes the vacuous-green hole. A unit the record says was shaped,
 * whose answer never reached it, used to re-render as a whole body and be
 * skipped by a pass that walked RENDERED rows; walking the RECORD's bodies makes
 * that a named refusal instead.
 */
export function coverageOf({ built, lane }) {
  const rowsById = new Map(lane.rows.map(row => [row.momentId, row]));
  const shapedKinds = new Set(["forget-with-partials", "forget-all"]);
  const bodies = [];
  for (const moment of built.record.moments) {
    const composition = moment.provenance?.composition ?? null;
    const censoredClass = moment.provenance?.censoredClass ?? null;
    const kind = shapedKinds.has(composition) ? "shaped"
      : censoredClass === "machinery-at-rest-removal" ? "receipt" : null;
    if (kind === null) continue;
    const row = rowsById.get(moment.id);
    const oracle = kind === "receipt" ? built.index.burns.get(moment.seq)
      : built.index.shaped.get(moment.seq);
    const body = { momentId: moment.id, seq: moment.seq, kind, composition, censoredClass };
    if (row === undefined) {
      bodies.push({ ...body, status: "refused",
        detail: `${moment.id} declares a ${kind} body and the lane holds no row for it` });
      continue;
    }
    if (kind === "shaped" && !row.shaped) {
      bodies.push({ ...body, status: "refused",
        detail: `seq ${String(moment.seq)}: the record declares a ${String(composition)} body and`
          + " the lane re-renders none — the unit's answer was never attributed to it" });
      continue;
    }
    if (oracle === undefined) {
      bodies.push({ ...body, status: "refused",
        detail: `seq ${String(moment.seq)}: the transcript holds no ${kind === "receipt"
          ? "at-rest receipt" : "shaped"} row` });
      continue;
    }
    if (row.after !== oracle.body) {
      bodies.push({ ...body, status: "refused",
        detail: `seq ${String(moment.seq)}: the re-rendered body is not the transcript's`
          + ` (${firstByteDifference(row.after, oracle.body)})` });
      continue;
    }
    bodies.push({ ...body, status: kind === "receipt" ? "censored" : "matched" });
  }
  const count = status => bodies.filter(body => body.status === status).length;
  return {
    total: bodies.length,
    matched: count("matched"),
    censored: count("censored"),
    refused: count("refused"),
    bodies,
  };
}

/** The coverage counts a report or a summary prints, and the refusals by name. */
export function coverageReport(coverage) {
  return {
    total: coverage.total,
    matched: coverage.matched,
    censored: coverage.censored,
    refused: coverage.refused,
    // Green needs matched === total − censored: every body is either reproduced
    // or censored by name, and a body neither is a refusal, never a skip.
    green: coverage.total > 0 && coverage.matched === coverage.total - coverage.censored,
    refusals: coverage.bodies
      .filter(body => body.status === "refused")
      .map(body => ({ momentId: body.momentId, seq: body.seq, detail: body.detail })),
  };
}

/** What the attribution placed, and where; counters only, no ratio. */
export function attributionSummary(attribution) {
  if (attribution === undefined || attribution === null) return null;
  return {
    ...attribution.counts,
    by: attribution.placed.reduce((totals, entry) => {
      totals[entry.by] = (totals[entry.by] ?? 0) + 1;
      return totals;
    }, {}),
    offUnitTies: attribution.offUnitTies.map(entry => ({
      promptSeq: entry.promptSeq, answerSeq: entry.answerSeq, candidates: entry.candidates,
    })),
    censoredPrompts: {
      machinery: attribution.censored.machinery.map(entry => entry.exchange.promptSeq),
      "refused-ask": attribution.censored["refused-ask"].map(entry => entry.exchange.promptSeq),
    },
    unaskedMoments: attribution.unasked.map(moment => ({
      momentId: moment.id, seq: moment.seq, composition: moment.provenance?.composition ?? null,
      askSeq: moment.unitSpan?.startSeq ?? null,
    })),
  };
}

/**
 * The step an answer takes effect at. A row that STATES a step is used as
 * stated — a stated value that is not an integer is refused by name, as before.
 * A scheme-A row states none (a `user/message` has no step relationship), so
 * the step is DERIVED, never guessed:
 *
 *   1. the next `step/start` after the answer row — the step whose request is
 *      built once the answer exists;
 *   2. failing that, the step the answer's own result landed at, plus one —
 *      the first step after that result.
 *
 * Only when BOTH derivations are absent is the answer refused, by the same name
 * the malformed case uses. Deterministic: the first usable step/start in file
 * order wins, and nothing reads a clock or a path.
 */
export function answerStepOf(answer, index) {
  if (answer.step !== null) {
    if (!Number.isSafeInteger(answer.step)) {
      refuse("gate3-answer-step-absent",
        `seq ${String(answer.seq)}: its answer states step ${String(answer.step)}, which is not`
        + " an integer step");
    }
    return answer.step;
  }
  const next = index.stepStarts.find(entry => entry.index > answer.rowIndex);
  if (next !== undefined) return next.step;
  const landed = index.landedSteps.get(answer.landedSeq);
  if (Number.isSafeInteger(landed)) return landed + 1;
  refuse("gate3-answer-step-absent",
    `seq ${String(answer.seq)}: its answer states no step, no step/start follows it, and the`
    + ` result it decides (seq ${String(answer.landedSeq)}) states no step either`);
}

/** The archive-source node id a form states for one moment, or null. */
export function nodeIdFor(moment, form) {
  if (form === "sim-result") {
    const name = typeof moment.path === "string" ? path.basename(moment.path) : "";
    return name.length === 0 ? null : `sim-result-${name}`;
  }
  if (form === "dsh") {
    if (typeof moment.session !== "string" || moment.callId === null) return null;
    return `dsh:${moment.session}:result:${moment.callId}`;
  }
  return refuse("gate3-node-id-form-unknown",
    `${String(form)} is not one of ${NODE_ID_FORMS.join(", ")}`);
}

/** A record adapter's refusal, re-stated with its own code and detail. */
function recordRefusal(error) {
  const detail = error.message.replace(/^[^:]+: /, "");
  refuse(error.code, detail);
}

/**
 * The record one arm's moments plus its answers, with the caller fields the
 * renderer needs. `form` is a stated node-id form, never a guess.
 *
 * The answers come from `resolveAttribution`, which joins the transcript's ask
 * exchanges to the record's moments by the ask's own facts and the record's own
 * per-moment ask anchor. An at-rest burn never receives one. `attribution` is
 * returned so a caller can print what it placed, what it refused and why.
 */
export function buildRecord({ recordDir, rows, arm = DEFAULT_ARM, form = "dsh", index = null }) {
  const transcript = index ?? indexTranscript(rows);
  let loaded;
  try {
    loaded = loadRecord(recordDir);
  } catch (error) {
    if (error?.name !== "SimRecordRefusal") throw error;
    recordRefusal(error);
  }
  let all;
  try {
    all = momentsOf(loaded);
  } catch (error) {
    if (error?.name !== "SimRecordRefusal") throw error;
    recordRefusal(error);
  }
  const lane = all.filter(moment => moment.lane === arm);
  if (lane.length === 0) {
    refuse("gate3-arm-absent", `${recordDir} carries no unit for arm ${arm}`);
  }
  const moments = lane.map(moment => {
    const body = transcript.landed.get(moment.seq);
    if (typeof body !== "string") {
      refuse("gate3-landed-absent",
        `${moment.id} lands at seq ${String(moment.seq)}, which the transcript holds no`
        + " landed append for");
    }
    const nodeId = nodeIdFor(moment, form);
    if (nodeId === null) {
      refuse("gate3-node-id-absent",
        `${moment.id} cannot name a ${form} archive source`);
    }
    const atRest = moment.record?.atRest ?? null;
    return {
      ...moment,
      original: { ...moment.original, text: body },
      source: { nodeId },
      ...(atRest === null ? {} : {
        record: { ...moment.record,
          atRest: { ...atRest, step: transcript.burns.get(moment.seq)?.step ?? null } },
      }),
    };
  });
  const byId = new Map(moments.map(moment => [moment.id, moment]));
  const attribution = resolveAttribution({ index: transcript, moments, rows });
  const decisions = [];
  const recorded = new Map();
  let derivedAnswers = 0;
  for (const moment of moments) {
    const answer = attribution.answers.get(moment.seq);
    if (answer === undefined) continue;
    const derived = !Number.isSafeInteger(answer.step);
    const step = answerStepOf(answer, transcript);
    if (derived) derivedAnswers += 1;
    decisions.push({ momentId: moment.id, step, answer: answer.answer });
    recorded.set(moment.id, {
      step, answer: answer.answer, seq: moment.seq, derived,
      by: answer.by, promptSeq: answer.promptSeq,
    });
  }
  return {
    arm,
    form,
    record: { lane: arm, moments, decisions },
    byId,
    recorded,
    derivedAnswers,
    index: transcript,
    attribution,
  };
}

/**
 * How many of the record's own bodies the lane reproduces, counted over the
 * RECORD, never over the rendered rows: a shaped body the lane never rendered
 * counts against the form, so a form cannot be "resolved" over a subset.
 */
export function reproductionCount(built, lane) {
  const coverage = coverageOf({ built, lane });
  return {
    total: coverage.total,
    reproduced: coverage.matched + coverage.censored,
    refused: coverage.refused,
  };
}

/**
 * The node-id form resolved against the transcript's own bodies. `auto` keeps
 * the first form that reproduces EVERY shaped body; when none does, the best
 * form (most bodies reproduced) is returned unresolved, so the per-row report
 * names real bodies instead of a form that could never produce them. A stated
 * form is used as stated. Nothing is guessed: the form is returned and printed.
 */
export function resolveNodeId({ recordDir, rows, arm = DEFAULT_ARM, form = "auto" }) {
  if (form !== "auto" && !NODE_ID_FORMS.includes(form)) {
    refuse("gate3-node-id-form-unknown", `${form} is not one of auto, ${NODE_ID_FORMS.join(", ")}`);
  }
  const forms = form === "auto" ? NODE_ID_FORMS : [form];
  const attempts = [];
  let best = null;
  for (const candidate of forms) {
    let built;
    let lane;
    try {
      built = buildRecord({ recordDir, rows, arm, form: candidate });
      lane = renderLane(built.record);
    } catch (error) {
      // A form the record cannot carry for every moment is one attempt, not a
      // crash: the next form may name a source the record does carry. A record
      // refusal is not a form's failure and is rethrown.
      if (isFormAttemptError(error)) {
        attempts.push({ form: candidate, reproduced: 0, total: 0, reason: error.message });
        continue;
      }
      throw error;
    }
    const health = reproductionCount(built, lane);
    attempts.push({ form: candidate, ...health });
    const entry = { form: candidate, built, lane };
    if (health.total > 0 && health.reproduced === health.total) {
      return { ...entry, attempts, resolved: true };
    }
    if (best === null || health.reproduced > best.health.reproduced) {
      best = { ...entry, health };
    }
  }
  if (best !== null) return { ...best, attempts, resolved: false };
  const first = attempts[0];
  refuse("gate3-render-refused",
    first === undefined ? "no node-id form could render the record"
      : `${first.form}: ${first.reason}`);
}

/**
 * True for a refusal one node-id FORM produced. Narrow on purpose: a record
 * that cannot be read (`sim-record-*`) or does not hold the arm is the record's
 * refusal and exits 2; only a source form's own gap becomes another attempt.
 */
function isFormAttemptError(error) {
  return error?.name === "SimRenderRefusal"
    || (error?.name === "Gate3Refusal" && error.code === "gate3-node-id-absent");
}

/** The lane's prefix text at one step, recomputed from its rows by the gate. */
export function expectedPrefixAt(rendered, step) {
  return renderHistory(rendered.rows
    .filter(row => row.landedStep < step)
    .map(row => ({
      role: "tool",
      text: row.swapStep !== null && step > row.swapStep ? row.after : row.before,
    })));
}

/** The first byte two texts disagree on, or a length note; null when equal. */
export function firstByteDifference(left, right) {
  const a = utf8(left);
  const b = utf8(right);
  const shorter = Math.min(a.length, b.length);
  for (let index = 0; index < shorter; index += 1) {
    if (a[index] !== b[index]) return `byte ${index} (${a[index]} != ${b[index]})`;
  }
  return a.length === b.length ? null : `byte ${shorter} (length ${a.length} != ${b.length})`;
}

/**
 * One byte moved in `text` inside `[start, end)`: the first ASCII letter is
 * replaced by 'a' or 'b' (whichever it is not). The length never changes and
 * exactly one byte differs, so a shape still parses and only the bytes move.
 */
export function flipAsciiByte(text, start, end) {
  const bytes = utf8(text);
  for (let index = start; index < Math.min(end, bytes.length); index += 1) {
    const byte = bytes[index];
    const letter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    if (!letter) continue;
    bytes[index] = byte === 0x61 ? 0x62 : 0x61;
    const next = bytes.toString("utf8");
    if (byteLength(next) !== bytes.length) continue;
    return { text: next, index, from: byte, to: bytes[index] };
  }
  return refuse("gate3-flip-target-absent", `no ASCII letter in [${start}, ${end}) to flip`);
}

/**
 * `--flip` applied to the RECORD, before either lane renders: the mutation is
 * one the fixture can carry, so `without` comparisons and both lanes stay
 * coherent. Every mutation keeps the length, and each one has a named check
 * that must catch it.
 *
 *   kept     one letter inside the first kept line of the first shaped result
 *            moves. `landed-body` and `self-reproduction` say so.
 *   summary  one letter of the first shaped answer's note moves.
 *            `summary-prefix` and `self-reproduction` say so.
 *   early    the first shaped decision lands one step earlier than its answer.
 *            `step-visibility` says so.
 *   late     the first shaped decision lands one step later.
 *            `step-visibility` and `self-reproduction` say so.
 */
export function applyFlip({ built, lane, off, flip }) {
  if (flip === null) return { built, lane, off, detail: null };
  if (!FLIP_NAMES.includes(flip)) {
    refuse("gate3-flip-unknown", `${String(flip)} is not one of ${FLIP_NAMES.join(", ")}`);
  }
  const shapedDecisions = built.record.decisions
    .map(decision => ({ decision, row: lane.rows.find(row => row.momentId === decision.momentId) }))
    .filter(entry => entry.row?.shaped)
    .sort((left, right) => left.row.seq - right.row.seq);
  const firstShaped = shapedDecisions[0];
  if (firstShaped === undefined) {
    refuse("gate3-flip-target-absent", "the lane holds no shaped decision");
  }
  const momentIndex = built.record.moments.findIndex(
    moment => moment.id === firstShaped.decision.momentId);
  if (momentIndex < 0) refuse("gate3-flip-target-absent", "the shaped decision names no moment");
  const moment = built.record.moments[momentIndex];
  const withMoment = (next, extraDecisions = built.record.decisions, detail = {}) => {
    const record = {
      ...built.record,
      moments: built.record.moments.map((entry, index) => (index === momentIndex ? next : entry)),
      decisions: extraDecisions,
    };
    const nextBuilt = {
      ...built,
      record,
      byId: new Map(record.moments.map(entry => [entry.id, entry])),
    };
    return {
      built: nextBuilt,
      lane: renderLane(record),
      off: renderLane({ ...record, decisions: [] }),
      detail,
    };
  };

  if (flip === "early" || flip === "late") {
    const target = firstShaped.decision;
    const step = flip === "early" ? target.step - 1 : target.step + 1;
    if (step < moment.step) {
      refuse("gate3-flip-target-absent",
        `the first shaped decision is at step ${target.step} and its result lands at`
        + ` ${moment.step}; moving it earlier is no step`);
    }
    return withMoment(moment,
      built.record.decisions.map(decision =>
        (decision === target ? { ...decision, step } : decision)),
      { flip, momentId: target.momentId, seq: firstShaped.row.seq, from: target.step, to: step });
  }

  if (flip === "summary") {
    const summary = firstShaped.decision.answer.summary;
    if (typeof summary !== "string" || summary.length === 0) {
      refuse("gate3-flip-target-absent", "the first shaped answer carries no note to flip");
    }
    const moved = flipAsciiByte(summary, 0, summary.length);
    return withMoment(moment,
      built.record.decisions.map(decision => (decision === firstShaped.decision
        ? { ...decision, answer: { ...decision.answer, summary: moved.text } }
        : decision)),
      { flip, momentId: firstShaped.decision.momentId, seq: firstShaped.row.seq,
        byte: moved.index, region: "summary" });
  }

  // kept: one letter of the first kept line of the landed body moves.
  const row = firstShaped.row;
  const offsets = splitLineOffsets(utf8(moment.original.text));
  const span = row.keptLines?.[0];
  if (span === undefined) {
    refuse("gate3-flip-target-absent", `${row.momentId}: its shaped row keeps no line`);
  }
  const line = offsets[span.startLine - 1];
  if (line === undefined) {
    refuse("gate3-flip-target-absent", `${row.momentId}: its first kept line is out of bounds`);
  }
  const moved = flipAsciiByte(moment.original.text, line.startByte, line.endByteExclusive - 1);
  return withMoment({
    ...moment,
    original: { ...moment.original, text: moved.text, sha256: sha256Hex(utf8(moved.text)) },
  }, built.record.decisions,
  { flip, momentId: row.momentId, seq: row.seq, byte: moved.index, region: "kept" });
}

/** The marker lines one shaped body carries: whole lines, by the shipped prefix. */
export function markerLinesOf(text) {
  return text.split("\n").filter(line => line.includes("[racoons]"));
}

/** The `<B>` byte count a full-form marker states, or null for the floor form. */
export function markerDroppedBytes(marker) {
  const match = /· (\d+) bytes dropped ·/.exec(marker);
  return match === null ? null : Number(match[1]);
}

/** The removed line spans a decision states, in the epoch planner's shape. */
export function removedSpansOf(decision, moment) {
  const totalLines = splitLineOffsets(utf8(moment.original.text)).length;
  const answer = decision.answer;
  if (answer.action === "keepall") return [];
  if (answer.action === "forgetall") return [{ startLine: 1, endLineInclusive: totalLines }];
  if (answer.action === "forgetlines") {
    return answer.ranges.map(range => ({ startLine: range.from, endLineInclusive: range.to }));
  }
  const kept = answer.ranges.map(range => ({ from: range.from, to: range.to }));
  return complementLineSpans(kept, totalLines)
    .map(span => ({ startLine: span.from, endLineInclusive: span.to }));
}

/** A fresh checker: per-check counts and the failure list, in insertion order. */
export function newChecker() {
  const checks = new Map();
  const failures = [];
  const hit = name => {
    const entry = checks.get(name) ?? { name, checked: 0, failed: 0 };
    checks.set(name, entry);
    entry.checked += 1;
    return entry;
  };
  const fail = (name, detail) => {
    const entry = hit(name);
    entry.failed += 1;
    failures.push({ check: name, detail });
  };
  const pass = name => hit(name);
  return { checks, failures, fail, pass };
}

/**
 * The checks, over one resolved record and its two lanes. Exported so a test can
 * hand it a deliberately broken lane and prove each check has a red path: a
 * check that cannot fail is void (gate 2's non-vacuity rule, same here).
 */
export function runChecks({ checker, built, lane, off, coverage = null }) {
  const { fail, pass } = checker;
  const rows = lane.rows;
  const isShaped = row => row.shaped;
  const isMachinery = row => row.machinery !== null;

  // ---- landed-body --------------------------------------------------------
  for (const row of rows) {
    const body = built.index.landed.get(row.seq);
    if (typeof body !== "string") {
      fail("landed-body", `seq ${row.seq}: the transcript holds no landed append`);
    } else if (row.before !== body) {
      fail("landed-body", `seq ${row.seq}: the record's landed body is not the transcript's`
        + ` (${firstByteDifference(row.before, body)})`);
    } else {
      pass("landed-body");
    }
  }

  // ---- answer-attribution ------------------------------------------------
  // The record's own asks, each against the attribution that decided it. A unit
  // the record says was asked must carry an answer the stated rules placed; an
  // at-rest burn must carry none; a censored unit must carry none. Each failure
  // names the moment and the prompt, so an attribution bug can never read as a
  // thin set.
  if (built.attribution !== undefined && built.attribution !== null) {
    for (const moment of built.record.moments) {
      const censoredClass = moment.provenance?.censoredClass ?? null;
      const asked = typeof moment.provenance?.source === "string";
      const decision = built.record.decisions.find(entry => entry.momentId === moment.id);
      if (censoredClass === "machinery-at-rest-removal") {
        if (decision !== undefined) {
          fail("answer-attribution",
            `${moment.id} is the engine's at-rest proof burn and carries an answer at step`
            + ` ${String(decision.step)}; a machinery removal takes none`);
        } else {
          pass("answer-attribution");
        }
        continue;
      }
      if (censoredClass !== null) {
        if (decision !== undefined) {
          fail("answer-attribution",
            `${moment.id} is censored ${censoredClass} and carries an answer; the record says no`
            + " ask decided it");
        } else {
          pass("answer-attribution");
        }
        continue;
      }
      if (asked && decision === undefined) {
        const answer = built.attribution.answers.get(moment.seq);
        fail("answer-attribution",
          `${moment.id} carries a ${String(moment.provenance.composition)} decision and no answer`
          + ` was attributed to it${answer === undefined ? "" : " (an answer was attributed to a"
            + " different row)"}`);
      } else if (!asked && decision !== undefined) {
        fail("answer-attribution",
          `${moment.id} carries an answer but the record names no ask`
          + ` (${String(moment.provenance.censoredClass ?? "no class")})`);
      } else {
        pass("answer-attribution");
      }
    }
  }

  // ---- self-reproduction --------------------------------------------------
  // Counted over the RECORD's own bodies, not over the rendered rows: a shaped
  // body the lane never rendered (an unattributed answer) is a named failure
  // here, never a row that quietly is not there.
  const bodies = coverage ?? coverageOf({ built, lane });
  for (const body of bodies.bodies) {
    if (body.status === "refused") {
      fail("self-reproduction", body.detail);
    } else {
      pass("self-reproduction");
    }
  }
  // The three coverage counts must account for every body: a body neither
  // matched, censored nor refused would be exactly the silent skip this check
  // exists to forbid.
  if (bodies.matched + bodies.censored + bodies.refused !== bodies.total) {
    fail("self-reproduction",
      `${bodies.total} record bodies, ${bodies.matched} matched + ${bodies.censored}`
      + ` censored + ${bodies.refused} refused do not sum to the body count`);
  }

  // ---- summary-prefix -----------------------------------------------------
  for (const row of rows.filter(isShaped)) {
    const recorded = built.recorded.get(row.momentId);
    if (recorded === undefined) continue;
    const summary = typeof recorded.answer.summary === "string" ? recorded.answer.summary : "";
    if (!row.after.startsWith(`${summary}\n\n`)) {
      fail("summary-prefix",
        `seq ${row.seq}: the body does not open with its answer's note and the blank line`);
    } else {
      pass("summary-prefix");
    }
  }

  // ---- five-terms ---------------------------------------------------------
  for (const row of rows.filter(isShaped)) {
    const terms = row.terms;
    const bodyBytes = byteLength(row.after);
    if (terms.kept + row.gaps * terms.markerBytes + terms.summary + terms.framing !== bodyBytes) {
      fail("five-terms", `seq ${row.seq}: kept + gaps·marker + summary + framing is not the`
        + ` ${bodyBytes}-byte body`);
      continue;
    }
    if (terms.kept + terms.dropped !== row.beforeBytes) {
      fail("five-terms", `seq ${row.seq}: kept ${terms.kept} + dropped ${terms.dropped} is not`
        + ` the ${row.beforeBytes}-byte original`);
      continue;
    }
    if (row.recordCheck?.match !== true) {
      fail("five-terms", `seq ${row.seq}: the record's own terms disagree`
        + ` (${(row.recordCheck?.mismatched ?? ["no record reading"]).join(", ")})`);
      continue;
    }
    const moment = built.byId.get(row.momentId);
    const offsets = splitLineOffsets(utf8(moment.original.text));
    const recomputed = row.keptLines.reduce((sum, span) => {
      let kept = 0;
      for (let line = span.startLine; line <= span.endLineInclusive; line += 1) {
        const offset = offsets[line - 1];
        kept += offset === undefined ? 0 : offset.endByteExclusive - offset.startByte;
      }
      return sum + kept;
    }, 0);
    if (recomputed !== terms.kept) {
      fail("five-terms", `seq ${row.seq}: kept ${terms.kept} is not the ${recomputed} bytes`
        + " of the kept lines of the landed body");
      continue;
    }
    const markers = markerLinesOf(row.after);
    if (markers.length !== row.gaps) {
      // The dropped byte count lives in the marker, so a body whose marker count
      // disagrees cannot have its dropped term re-read: that is this check's red.
      fail("five-terms", `seq ${row.seq}: ${markers.length} marker line(s) for ${row.gaps} gap(s);`
        + " the dropped term cannot be re-read");
      continue;
    }
    const stated = markers.map(marker => markerDroppedBytes(marker));
    const dropped = stated.filter(value => value !== null);
    if (dropped.length === 0 && terms.dropped === row.beforeBytes) {
      pass("five-terms");
    } else if (dropped.length > 0 && dropped.every(value => value === terms.dropped)) {
      pass("five-terms");
    } else {
      fail("five-terms", `seq ${row.seq}: the marker states ${JSON.stringify(dropped)} dropped`
        + ` bytes, the row ${terms.dropped}`);
    }
  }

  // ---- marker-line --------------------------------------------------------
  for (const row of rows.filter(row => isShaped(row) || isMachinery(row))) {
    if (isMachinery(row)) {
      if (row.after.includes("\n") || !row.after.startsWith("[not retained] ")) {
        fail("marker-line",
          `seq ${row.seq}: the receipt is not one whole [not retained] line`);
      } else {
        pass("marker-line");
      }
      continue;
    }
    const markers = markerLinesOf(row.after);
    if (markers.length !== row.gaps) {
      fail("marker-line",
        `seq ${row.seq}: ${markers.length} marker line(s) for ${row.gaps} gap(s)`);
      continue;
    }
    const bad = markers.filter(marker =>
      !/^\[racoons\] kept .* necromancy recall:sha256:[0-9a-f]{64}$/.test(marker));
    if (bad.length > 0) {
      fail("marker-line", `seq ${row.seq}: a marker line carries other text`
        + ` (${JSON.stringify(bad[0].slice(0, 80))})`);
      continue;
    }
    const widths = markers.map(marker => byteLength(`${marker}\n`));
    if (!widths.every(width => width === row.terms.markerBytes)) {
      fail("marker-line", `seq ${row.seq}: a marker is ${JSON.stringify(widths)} bytes, the row`
        + ` states ${row.terms.markerBytes}`);
    } else {
      pass("marker-line");
    }
  }

  // ---- recall-id ----------------------------------------------------------
  for (const row of rows.filter(row => isShaped(row) || isMachinery(row))) {
    if (typeof row.recallId !== "string" || row.recallId.length === 0) {
      fail("recall-id", `seq ${row.seq}: the row names no recall id`);
      continue;
    }
    if (isShaped(row) && row.recallIdMatchesRecord !== true) {
      fail("recall-id", `seq ${row.seq}: the marker names ${row.recallId}, the record another`);
      continue;
    }
    if (!row.after.includes(`necromancy ${row.recallId}`)) {
      fail("recall-id", `seq ${row.seq}: the body states no necromancy ${row.recallId}`);
    } else {
      pass("recall-id");
    }
  }

  // ---- censored-receipt ---------------------------------------------------
  for (const row of rows.filter(isMachinery)) {
    if (row.swapStep === null) {
      fail("censored-receipt", `seq ${row.seq}: the at-rest burn has no stated step`);
    } else {
      pass("censored-receipt");
    }
  }

  // ---- epoch-plan ---------------------------------------------------------
  const decisions = built.record.decisions.map(decision => ({
    turn: decision.step,
    unitId: decision.momentId,
    ranges: removedSpansOf(decision, built.byId.get(decision.momentId)),
  }));
  const calls = built.record.moments
    .map(moment => ({ callId: moment.id, turnIndex: moment.step }))
    .sort((left, right) => left.turnIndex - right.turnIndex);
  let epochs = null;
  try {
    epochs = epochsFor(calls, decisions);
  } catch (error) {
    fail("epoch-plan", `the shipped epochsFor refused the lane: ${error.message}`);
  }
  if (epochs !== null) {
    for (const epoch of epochs) {
      const planned = JSON.stringify(appliedSetAt(decisions, epoch.firstTurnIndex));
      if (planned !== epoch.appliedRemovalSet) {
        fail("epoch-plan", `epoch ${epoch.epochIndex}: the shipped planner states`
          + ` ${epoch.appliedRemovalSet}, appliedSetAt states ${planned}`);
      } else {
        pass("epoch-plan");
      }
    }
    for (const step of lane.steps) {
      const applied = new Set(appliedSetAt(decisions, step.step).map(entry => entry.unitId));
      const carried = new Set(rows
        .filter(row => row.decisionStep !== null && row.swapStep !== null
          && step.step > row.swapStep)
        .map(row => row.momentId));
      const onlyApplied = [...applied].filter(id => !carried.has(id));
      const onlyCarried = [...carried].filter(id => !applied.has(id));
      if (onlyApplied.length > 0 || onlyCarried.length > 0) {
        fail("epoch-plan", `step ${step.step}: appliedSetAt says`
          + ` ${JSON.stringify([...applied].sort())} but the prefix carries`
          + ` ${JSON.stringify([...carried].sort())}`);
      } else {
        pass("epoch-plan");
      }
    }
  }

  // ---- lane-equality ------------------------------------------------------
  const decisionSwaps = rows
    .filter(row => row.decisionStep !== null && row.swapStep !== null)
    .map(row => row.swapStep);
  if (decisionSwaps.length === 0) {
    fail("lane-equality", "the record carries no shaped decision, so OFF and K can never split:"
      + " the check has nothing to verify");
  } else {
    const first = Math.min(...decisionSwaps);
    let split = false;
    for (const step of lane.steps) {
      const same = expectedPrefixAt(lane, step.step) === expectedPrefixAt(off, step.step);
      if (step.step <= first && !same) {
        fail("lane-equality", `step ${step.step}: a byte moved before the first decision`
          + ` (its swap is at ${first})`);
      } else {
        pass("lane-equality");
      }
      if (step.step > first && !same) split = true;
    }
    if (!split) {
      fail("lane-equality", `the lanes never split after the first swap at ${first}: the check`
        + " cannot fail");
    }
  }

  // ---- step-visibility ----------------------------------------------------
  for (const [momentId, recorded] of built.recorded) {
    const row = rows.find(entry => entry.momentId === momentId);
    if (row === undefined) {
      fail("step-visibility", `${momentId}: the record holds no row for its answer`);
      continue;
    }
    if (row.decisionStep !== recorded.step) {
      fail("step-visibility", `seq ${row.seq}: the decision is at step ${String(row.decisionStep)},`
        + ` the transcript's answer at ${recorded.step}`);
      continue;
    }
    const without = renderLane({
      ...built.record,
      decisions: built.record.decisions.filter(decision => decision.momentId !== momentId),
    });
    const atStep = expectedPrefixAt(lane, recorded.step);
    const bare = expectedPrefixAt(without, recorded.step);
    if (atStep !== bare) {
      fail("step-visibility", `seq ${row.seq}: the decision at step ${recorded.step} is already`
        + " visible at that step");
      continue;
    }
    if (row.swapStep === null) {
      // A keepall rewrites nothing, so no later step may differ either.
      const finalStep = lane.final.step;
      if (expectedPrefixAt(lane, finalStep) !== expectedPrefixAt(without, finalStep)) {
        fail("step-visibility", `seq ${row.seq}: a keepall moved the final prefix`);
      } else {
        pass("step-visibility");
      }
      continue;
    }
    const after = expectedPrefixAt(lane, recorded.step + 1);
    const afterBare = expectedPrefixAt(without, recorded.step + 1);
    if (after === afterBare) {
      fail("step-visibility", `seq ${row.seq}: the decision at step ${recorded.step} is not`
        + ` visible at ${recorded.step + 1}`);
    } else {
      pass("step-visibility");
    }
  }

  // ---- prefix-chain -------------------------------------------------------
  const recordedSteps = lane.steps;
  for (const step of recordedSteps) {
    const text = expectedPrefixAt(lane, step.step);
    if (step.prefixSha256 !== sha256Hex(utf8(text)) || step.prefixBytes !== byteLength(text)) {
      fail("prefix-chain", `step ${step.step}: the recorded hash is not the gate's recompute`);
    } else if (prefixTextAt(lane, step.step) !== text) {
      fail("prefix-chain", `step ${step.step}: sim-render's chain and the gate's disagree`);
    } else {
      pass("prefix-chain");
    }
  }
  for (let index = 1; index < recordedSteps.length; index += 1) {
    const before = recordedSteps[index - 1];
    const after = recordedSteps[index];
    const shorter = utf8(expectedPrefixAt(lane, before.step));
    const longer = utf8(expectedPrefixAt(lane, after.step));
    const extendsIt = shorter.length <= longer.length
      && longer.subarray(0, shorter.length).equals(shorter);
    const swapped = rows.some(row =>
      row.swapStep !== null && row.swapStep >= before.step && row.swapStep < after.step);
    if (!extendsIt && !swapped) {
      fail("prefix-chain", `steps ${before.step}→${after.step}: the prefix neither extends nor`
        + " rewrites");
    } else {
      pass("prefix-chain");
    }
  }
  const firstLanded = Math.min(...rows.map(row => row.landedStep));
  if (expectedPrefixAt(lane, firstLanded) !== "") {
    fail("prefix-chain", `the prefix at ${firstLanded} is not empty before the first result`);
  } else {
    pass("prefix-chain");
  }
  if (lane.final === null || lane.final.step !== recordedSteps[recordedSteps.length - 1].step) {
    fail("prefix-chain", "the final step is not the last observed step");
  } else {
    pass("prefix-chain");
  }

  return { epochs: epochs === null ? null : epochs.length };
}

/**
 * One chain run: resolve the record, apply the flip, render both lanes, run
 * every check, and return the report plus the two lanes. Deterministic: no
 * clock, no path in the report, no environment read.
 */
export function chainRun({
  recordDir, transcriptFile, arm = DEFAULT_ARM, nodeIdForm = "auto", flip = null,
}) {
  const rows = readTranscript(transcriptFile);
  const resolved = resolveNodeId({ recordDir, rows, arm, form: nodeIdForm });
  const off = renderLane({ ...resolved.built.record, decisions: [] });
  const flipped = applyFlip({ built: resolved.built, lane: resolved.lane, off, flip });
  const built = flipped.built;
  const lane = flipped.lane;
  const checker = newChecker();
  const failuresBefore = checker.failures.length;
  // A record with no shaped body at all has no form to resolve: the red there
  // is the empty oracle's own, never a form's.
  const shapedBodies = resolved.attempts.some(attempt => (attempt.total ?? 0) > 0);
  if (resolved.resolved) {
    checker.pass("node-id-form");
  } else if (shapedBodies) {
    const stated = resolved.attempts
      .map(attempt => `${attempt.form}=${attempt.reproduced}/${attempt.total}`)
      .join(" ");
    checker.fail("node-id-form", `no stated node-id form reproduces every shaped body (${stated})`);
  }
  const coverage = coverageOf({ built, lane });
  const { epochs } = runChecks({ checker, built, lane, off: flipped.off, coverage });
  if (flip !== null && checker.failures.length === failuresBefore) {
    checker.fail("non-vacuity", `--flip ${flip} reddened no check: the gate cannot fail`);
  }
  const checks = CHECK_NAMES
    .map(name => checker.checks.get(name))
    .filter(entry => entry !== undefined);
  const report = {
    schema: "racoons-sim-gate3-report/1",
    gate: "gate3-live-chain",
    mode: "chain",
    arm,
    nodeIdForm: resolved.form,
    nodeIdResolved: resolved.resolved,
    nodeIdAttempts: resolved.attempts.map(attempt => ({
      form: attempt.form, reproduced: attempt.reproduced, total: attempt.total,
    })),
    flip: flipped.detail,
    // How many answer rows stated no step, so the gate derived one. Zero on a
    // pre-ISSUE-074 transcript; the count would be the lane's answers on a
    // scheme-A one (a `user/message` answer has no step relationship).
    answerStepsDerived: built.derivedAnswers ?? 0,
    attribution: attributionSummary(built.attribution),
    counts: {
      moments: lane.moments,
      decisions: lane.decisions,
      shaped: lane.shaped,
      machinery: lane.rows.filter(row => row.machinery !== null).length,
      steps: lane.steps.length,
      epochs: epochs ?? null,
      reproduced: coverage.matched + coverage.censored,
    },
    coverage: coverageReport(coverage),
    final: lane.final,
    off: off.final,
    checks,
    failures: checker.failures,
    assertions: checks.reduce((total, entry) => total + entry.checked, 0),
    verdict: checker.failures.length === 0 ? "GREEN" : "RED",
  };
  return { report, lane, off: flipped.off };
}

/**
 * `--check-repro`: every shaped body (and the at-rest receipt) re-rendered and
 * compared to the transcript's own row, byte for byte. The mode run B lands on.
 *
 * The pass walks the RECORD's bodies, so its coverage is total by construction:
 * each shaped unit and each at-rest receipt is MATCHED, CENSORED BY NAME (the
 * record censors it) or REFUSED BY NAME, and the three counts are printed. Green
 * requires matched === total − censored; a green over a subset is not a green.
 */
export function reproRun({ recordDir, transcriptFile, arm = DEFAULT_ARM, nodeIdForm = "auto" }) {
  const rows = readTranscript(transcriptFile);
  const resolved = resolveNodeId({ recordDir, rows, arm, form: nodeIdForm });
  const checker = newChecker();
  // The form is resolved by best fit and PRINTED; the verdict here belongs to
  // the bodies. A record whose every form misses some body is exactly what §7(a)
  // stops on, and `repro-body` names the seq and the byte for each one. A record
  // with no shaped body is `repro-empty`'s red, never a form's.
  const coverage = coverageOf({ built: resolved.built, lane: resolved.lane });
  for (const body of coverage.bodies) {
    if (body.status === "refused") {
      checker.fail("repro-body", body.detail);
    } else {
      checker.pass("repro-body");
    }
  }
  if (coverage.total === 0) {
    checker.fail("repro-empty",
      "the record holds no shaped body: an absent oracle is never a pass");
  }
  // The three counts must close; a body that is none of the three would be the
  // silent skip this pass exists to forbid. It cannot happen by construction, so
  // it is an assertion about this module, not about the record.
  if (coverage.matched + coverage.censored + coverage.refused !== coverage.total) {
    refuse("gate3-coverage-unclosed",
      `${coverage.total} bodies but ${coverage.matched} matched + ${coverage.censored}`
      + ` censored + ${coverage.refused} refused`);
  }
  const checks = [...checker.checks.values()];
  const report = {
    schema: "racoons-sim-gate3-report/1",
    gate: "gate3-live-chain",
    mode: "check-repro",
    arm,
    nodeIdForm: resolved.form,
    nodeIdResolved: resolved.resolved,
    nodeIdAttempts: resolved.attempts.map(attempt => ({
      form: attempt.form, reproduced: attempt.reproduced, total: attempt.total,
    })),
    shaped: coverage.total,
    coverage: coverageReport(coverage),
    checks,
    failures: checker.failures,
    verdict: checker.failures.length === 0 ? "GREEN" : "RED",
  };
  return { report, lane: resolved.lane };
}

/** The human summary: counts and the verdict; no ratio and no derived number. */
export function summaryOf(report, { quiet = false } = {}) {
  if (quiet) return `${verdictLine(report)}`;
  const counts = report.counts ?? { shaped: report.shaped };
  const coverage = report.coverage ?? null;
  const coverageLine = coverage === null ? []
    : [`  coverage     ${coverage.matched} matched, ${coverage.censored} censored by name,`
      + ` ${coverage.refused} refused by name of ${coverage.total} body(ies)`];
  const lines = report.mode === "check-repro"
    ? [
      "gate3-live-chain",
      "  mode         check-repro",
      `  arm          ${report.arm}`,
      `  node-id      ${report.nodeIdForm}${report.nodeIdResolved ? "" : " (unresolved)"}`,
      `  shaped       ${report.shaped} body(ies) compared to the transcript`,
      ...coverageLine,
      `  checks       ${report.checks.map(entry => `${entry.name}:${entry.checked}`).join(" ")}`,
    ]
    : [
      "gate3-live-chain",
      "  mode         chain",
      `  arm          ${report.arm}`,
      `  node-id      ${report.nodeIdForm}${report.nodeIdResolved ? "" : " (unresolved)"}`,
      `  moments      ${counts.moments}: ${counts.shaped} shaped, ${counts.machinery} at-rest`
        + ` receipt, ${counts.decisions} decision(s)`,
      ...coverageLine,
      `  epochs       ${String(counts.epochs)} over ${counts.moments} calls`,
      `  steps        ${counts.steps} observed, final ${String(report.final?.prefixSha256)}`
        + ` at step ${String(report.final?.step)}`,
      `  checks       ${report.checks.map(entry => `${entry.name}:${entry.checked}`).join(" ")}`,
      `  flip         ${flipLine(report.flip)}`,
    ];
  lines.push(verdictLine(report));
  return lines.join("\n");
}

/** The flip line: what moved, and where. */
function flipLine(flip) {
  if (flip === null) return "none";
  if (flip.region !== undefined) {
    return `${flip.flip} (seq ${flip.seq}, ${flip.region} byte ${flip.byte})`;
  }
  return `${flip.flip} (seq ${flip.seq}, step ${flip.from}→${flip.to})`;
}

function verdictLine(report) {
  if (report.verdict === "RED") {
    const named = {};
    for (const failure of report.failures) named[failure.check] = (named[failure.check] ?? 0) + 1;
    return `gate3-live-chain: RED — ${Object.entries(named)
      .map(([name, count]) => `${name}×${count}`).join(" ")}`;
  }
  if (report.mode === "check-repro") {
    return `gate3-live-chain: GREEN — ${report.shaped} shaped body(ies) reproduced byte for byte`
      + ` (node-id ${report.nodeIdForm})`;
  }
  return `gate3-live-chain: GREEN — ${report.checks.length} checks, ${report.assertions}`
    + ` assertions, ${report.counts.reproduced} bodies reproduced, ${report.counts.steps} prefix`
    + ` steps chained, ${String(report.counts.epochs)} epochs`;
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--units", "string"],
  ["--transcript", "string"],
  ["--arm", "string"],
  ["--node-id", "string", "nodeId"],
  ["--out", "string"],
  ["--flip", "string"],
  ["--check-repro", "boolean", "checkRepro"],
  ["--json", "boolean"],
  ["--quiet", "boolean"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
    // These two flags belong to sim-live.mjs and are refused BY NAME here: this
    // gate never opens a socket, and a silent "unknown argument" would hide that.
    // The refusal is thrown, not returned, because its code is its own
    // (`gate3-offline-only`), not the usage code.
    unknown: (rawName) => {
      if (rawName === "--live-asks" || rawName === "--owner-authorized") {
        refuse("gate3-offline-only",
          `${rawName} belongs to T-9's sim-live.mjs; this gate never opens a socket`);
      }
      return null;
    },
  });
  const opts = {
    units: values.units ?? null,
    transcript: values.transcript ?? null,
    arm: values.arm ?? DEFAULT_ARM,
    nodeId: values.nodeId ?? "auto",
    out: values.out ?? null,
    flip: values.flip ?? null,
    checkRepro: values.checkRepro ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
  if (opts.flip !== null) {
    if (!FLIP_NAMES.includes(opts.flip)) {
      refuse("usage", `--flip must be one of ${FLIP_NAMES.join(", ")}, got ${opts.flip}`);
    }
    if (opts.checkRepro) refuse("usage", "--flip applies to the chain, not to --check-repro");
  }
  if (opts.units === null && opts.transcript !== null) {
    refuse("usage", "--transcript needs the --units record it belongs to");
  }
  if (opts.units !== null && opts.transcript === null) {
    refuse("gate3-transcript-required",
      "--units needs --transcript: a chain reads the arm's own session.v4.jsonl for the landed"
      + " bodies, the answers and the burn steps");
  }
  if (opts.checkRepro && opts.units === null) {
    refuse("usage", "--check-repro needs --units and --transcript");
  }
  return opts;
}

/** The fixture converted once into a fresh directory the caller removes. */
export function convertFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "racoons-gate3-"));
  const out = path.join(root, "out");
  const converted = spawnSync(process.execPath,
    [CONVERTER, "--manifest", FIXTURE_MANIFEST, "--out", out], { encoding: "utf8" });
  if (converted.status !== 0) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    refuse("gate3-convert-failed",
      `${CONVERTER} exited ${String(converted.status)}: ${(converted.stderr ?? "").trim()}`);
  }
  return { root, out };
}

function writeAtomic(dir, name, text) {
  const target = path.join(dir, name);
  writeFileSync(`${target}.tmp`, text);
  renameSync(`${target}.tmp`, target);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.CREMATOR_SIM_REAL === "1") {
    refuse("gate3-offline-only",
      "CREMATOR_SIM_REAL is set; this gate is offline only and live asks are sim-live.mjs's");
  }
  let recordDir = opts.units;
  let transcript = opts.transcript;
  let fixture = null;
  if (recordDir === null) {
    fixture = convertFixture();
    recordDir = fixture.out;
    transcript = FIXTURE_TRANSCRIPT;
  }
  let status;
  try {
    const run = opts.checkRepro
      ? reproRun({ recordDir, transcriptFile: transcript, arm: opts.arm, nodeIdForm: opts.nodeId })
      : chainRun({
        recordDir, transcriptFile: transcript, arm: opts.arm,
        nodeIdForm: opts.nodeId, flip: opts.flip,
      });
    if (opts.out !== null) {
      const out = path.resolve(process.cwd(), opts.out);
      mkdirSync(out, { recursive: true });
      if (!opts.checkRepro) {
        writeAtomic(out, "lane-off.json", `${JSON.stringify(run.off, null, 2)}\n`);
        writeAtomic(out, "lane-k.json", `${JSON.stringify(run.lane, null, 2)}\n`);
      }
      writeAtomic(out, "gate3-report.json", `${JSON.stringify(run.report, null, 2)}\n`);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
    } else {
      if (!opts.quiet) {
        for (const failure of run.report.failures) {
          process.stdout.write(`FAIL ${failure.check} ${failure.detail}\n`);
        }
      }
      process.stdout.write(`${summaryOf(run.report, { quiet: opts.quiet })}\n`);
    }
    status = run.report.verdict === "RED" ? 1 : 0;
  } finally {
    // The temporary conversion is this process's own and is removed before the
    // exit, so a red run leaves no directory behind.
    if (fixture !== null) {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
  process.exit(status);
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
