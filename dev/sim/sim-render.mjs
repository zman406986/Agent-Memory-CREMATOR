#!/usr/bin/env node
/**
 * ISSUE-059 T-3 — the lane re-render: a record in, one lane's transcript and the
 * five render terms out, with a prefix hash per step.
 *
 * Usage:
 *   node dev/sim/sim-render.mjs --record <record.json> [--out <file>] [--json]
 *
 * ## The record, and the fields it adds
 *
 * One object, three keys:
 *
 *   { "lane": "racoons", "moments": [ ... ], "decisions": [ ... ] }
 *
 * `moments` is `sim-record.mjs`'s own output, consumed as written: `id`, `lane`,
 * `seq`, `step`, `session`, `bytes`, `original.sha256`, `kept`, `dropped`,
 * `marker`, `summaryBytes`, `framingBytes`, `recallId`, `provenance`, `record`.
 * Nothing is re-parsed from a transcript here.
 *
 * Three fields are the CALLER's, because a byte-level re-render needs them and
 * no converter output carries them:
 *   original.text    the landed body, as the host landed it. A moment without
 *                    it (or `original.bytes`) is refused by name.
 *   source.nodeId    the archive source the shaped turn's recall id was minted
 *                    over: `renderShapeTurn` hashes it into the marker's id.
 *                    Absent, the moment's own `id` stands in and the marker
 *                    names a different recall id; the `recallIdMatchesRecord`
 *                    column says so, per row.
 *   moment.record.atRest.step
 *                    the step the engine's at-rest proof burn landed at. The
 *                    adapter carries the burn's `seq`, `recallId` and `target`
 *                    but not its step; stating it lets the row render the
 *                    receipt from that step on. Absent, the row keeps the landed
 *                    body and says so (`swapStep: null`) — a censored row is
 *                    never rendered as if nothing had replaced it, and never
 *                    swaps at a step nobody named.
 *
 * `decisions` is the parsed answer with its step, one per moment: `answer` is
 * the product's own `EntryAnswer` (`keepall` | `keeplines` | `forgetlines` |
 * `forgetall`, `ranges` as `{from,to}`), or the same shape with `{startLine,
 * endLineInclusive}` spans. `step` is the step the answer arrived at, and it may
 * not precede the result it decides. A decision may state NO step (ISSUE-074
 * scheme A: the answer is stored as a `user/message`, which has no step
 * relationship); its step is then derived as the moment's own step plus one —
 * the first step whose request is built after the answer exists — and the row's
 * `decisionStep` carries that derived step. Only a decision that states no step
 * AND names no moment the record holds is refused, by name. A decision on the
 * engine's at-rest proof burn is refused: that removal has no answer behind it,
 * and `record.atRest.step` is how its own step is stated instead.
 *
 * ## The five terms
 *
 *   kept          the retained byte ranges of the original, summed
 *   markerBytes   one marker line, trailing newline included
 *   summary       the answer's note as the mount writes it: `summary` + "\n\n"
 *   framing       the residual: body − kept − gaps·markerBytes − summary
 *   dropped       `original.length − kept`
 *
 *   identity      body = kept + gaps·markerBytes + summary + framing
 *   original      = kept + dropped
 *
 * The renderer is the product's. `renderShapeTurn` decides the kept byte ranges,
 * the gaps, the marker and the recall id; `entryShapePrefix` and
 * `composeEntryShapeTurn` wrap the note above it; `renderHistory` joins the
 * turns. Nothing here re-implements a marker, a splice, an id or a separator.
 *
 * A row with no rewrite carries `terms` in the shape the record itself uses for
 * such a row — `kept: null`, `markerBytes: 0`, `summary: 0`, `framing: null`,
 * `dropped: 0` — and `termsBasis: "whole-body"`. A shaped row carries five
 * numbers and `termsBasis: "shaped"`. A `keepall` moves the answer's step and
 * rewrites nothing, so it keeps the whole-body shape; so does a `keeplines` whose
 * spans cover every line, which is keep-whole and plans no shaped turn
 * (ISSUE-141).
 *
 * ## The prefix, and when a decision shows
 *
 * The lane's transcript is its moments in `seq` order, one `tool` turn each. The
 * prefix at step `k` is every turn whose result landed before `k`
 * (`landedStep < k`), joined by `renderHistory` — the bytes that request carried.
 * It is the lane's own moment turns, not the host's whole wire: the record holds
 * tool results, so assistant prose and the ask exchange are outside it.
 *
 * A decision swaps ONE turn's body and does so from the step AFTER the answer
 * arrived: at step `S` the request had already gone out before the answer
 * existed, so it carried the original; from `S+1` every request carries the
 * shaped body. So a decision at `S` is invisible at `S` — the prefix hash equals
 * the no-decision render's — and visible at `S+1`, and one flipped byte of the
 * decision moves every prefix hash after `S`.
 *
 * `steps` lists the observed steps, each with `prefixBytes` and
 * `prefixSha256`; `final` is the last of them; `prefixAt` answers for any step,
 * observed or not, so a test can name the exact step it means.
 *
 * `prefixTextToSeq` cuts on the trigger's own `seq` instead: two results can
 * land in the same step, so a `landedStep` cut cannot say which of them the
 * trigger's request could have carried. `prefixAtSeq` is its hash and byte
 * count. The `landedStep` cut stays as it was.
 *
 * ## What this module does not do
 *
 * No depth, no tokens, no crossing, no scoring: §3's metrics are T-6's. It does
 * not judge an answer and does not decide a class; the record's own fields stay
 * the record's. The at-rest proof burn is carried as its own receipt row and
 * never as a decision — `action` stays null and its `terms` stay the whole-body
 * shape, so nothing here can score it.
 *
 * Deterministic and offline: no clock, no network, no randomness.
 *
 * Exit: 0 = rendered; 2 = a usage error or a named refusal (`<code>: <detail>`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  byteRangeForLines, complementLineSpans, normalizeKeptSpans, receiptLine, renderHistory,
  renderShapeTurn, splitLineOffsets,
} from "@cremator/core";
import { composeEntryShapeTurn, entryShapePrefix } from "cremator-dsh";
import { optionsOf, parseDevArgs } from "../shared/args.mjs";

const USAGE = [
  "usage: sim-render.mjs --record <record.json> [--out <file>] [--json]",
  "       --record  a {lane, moments, decisions} object: the record adapter's",
  "                 moments, each carrying its `original.text` and",
  "                 `source.nodeId`, and the parsed answers with their steps",
  "       --out     write the render as JSON (<name>.tmp then rename)",
  "       --json    print the render as JSON instead of the summary",
].join("\n");

/** The four answers this module accepts, in the entry parser's own words. */
export const DECISION_ACTIONS = ["keepall", "keeplines", "forgetlines", "forgetall"];
/** The five terms, in this order, on every row. */
export const TERM_NAMES = ["kept", "markerBytes", "summary", "framing", "dropped"];

const LINE_FEED = 0x0a;

/** A refusal with the code a gate asserts on. */
export class SimRenderRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "SimRenderRefusal";
    this.code = code;
  }
}

export function refuse(code, detail) {
  throw new SimRenderRefusal(code, detail);
}

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8 = text => Buffer.from(text, "utf8");

/**
 * The landed body a moment re-renders from. `original.text` is the record's own
 * field; `original.bytes` is accepted so a caller holding bytes need not
 * round-trip them through UTF-8.
 */
export function bodyOfMoment(moment) {
  const original = moment?.original ?? null;
  if (typeof original?.text === "string") return utf8(original.text);
  if (original?.bytes instanceof Uint8Array) return Buffer.from(original.bytes);
  return refuse("sim-render-body-absent",
    `moment ${String(moment?.id ?? moment?.seq)} carries no original.text or original.bytes;`
    + " a re-render reads the landed bytes, never a transcript");
}

/**
 * One answer, in this module's one shape. Both the product's `EntryAnswer`
 * (`{action, ranges: [{from,to}], summary}`) and a flat
 * `{action, ranges: [{startLine,endLineInclusive}], summary}` are accepted, so a
 * caller need not re-spell the parser's output.
 *
 * A decision STATES its step, or states none (ISSUE-074's scheme A: an answer
 * row written as a `user/message` has no step relationship). When it states
 * none, `fallbackStep` — the derivation the caller read from the record — is
 * used; a stated step that is malformed is refused by name, as before, and a
 * step-less decision with no derivation is refused by the same name. This
 * module never sees a transcript, so the caller's fallback is the result row's
 * step plus one; `gate3-live-chain.mjs` prefers the next `step/start`.
 */
export function normalizeDecision(raw, fallbackStep = null) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    refuse("sim-render-decision-invalid", "a decision is one object");
  }
  const answer = raw.answer ?? raw;
  const action = answer.action;
  if (!DECISION_ACTIONS.includes(action)) {
    refuse("sim-render-decision-invalid",
      `the answer action ${String(action)} is not one of ${DECISION_ACTIONS.join(", ")}`);
  }
  const momentId = raw.momentId ?? raw.id ?? null;
  if (typeof momentId !== "string" || momentId.length === 0) {
    refuse("sim-render-decision-invalid", "a decision names its moment by `momentId`");
  }
  const stated = raw.step ?? null;
  let step = stated;
  if (step === null) {
    if (!Number.isSafeInteger(fallbackStep) || fallbackStep < 1) {
      refuse("sim-render-decision-invalid",
        `the decision for ${momentId} states no step, and no result step is available to`
        + " derive one from");
    }
    step = fallbackStep;
  } else if (!Number.isSafeInteger(step) || step < 1) {
    refuse("sim-render-decision-invalid",
      `the decision for ${momentId} carries step ${String(step)}; an answer lands at a`
      + " positive step");
  }
  const ranges = (Array.isArray(answer.ranges) ? answer.ranges : []).map(span => ({
    from: span?.from ?? span?.startLine,
    to: span?.to ?? span?.endLineInclusive,
  }));
  const summary = typeof answer.summary === "string" ? answer.summary : "";
  if (action !== "keepall" && summary.trim().length === 0) {
    refuse("sim-render-decision-invalid",
      `${action} for ${momentId} carries no summary; the shaped turn opens with it`);
  }
  return Object.freeze({
    momentId, step, action, summary,
    ranges: Object.freeze(ranges.map(range => Object.freeze({ ...range }))),
  });
}

/**
 * The kept line spans an answer leaves inside a body of `totalLines` lines, or
 * `null` for `keepall` (which rewrites nothing).
 *
 * The two partial polarities are the product's own: `keeplines` names what
 * stays, `forgetlines` names what leaves and keeps the complement, `forgetall`
 * keeps nothing. `normalizeKeptSpans` and `complementLineSpans` are the shipped
 * arithmetic — this function only chooses which side of it the answer is on.
 */
export function keptSpansOf(decision, totalLines) {
  if (decision.action === "keepall") return null;
  if (decision.action === "forgetall") return [];
  if (decision.ranges.length === 0) {
    return refuse("sim-render-span-invalid", `${decision.action} names no line`);
  }
  const spans = normalizeKeptSpans(decision.ranges);
  if (spans === null) {
    return refuse("sim-render-span-invalid",
      `${decision.action} carries a span that is not [start,end] with 1 <= start <= end`);
  }
  for (const span of spans) {
    if (span.to > totalLines) {
      refuse("sim-render-span-outside-result",
        `${decision.action} names lines ${span.from}–${span.to} but the result holds`
        + ` ${totalLines}`);
    }
  }
  // Phase 3's `forgetlines` arm is rendered HERE, sim-side: the named ranges are
  // the dropped bytes and the complement (plus the answer's summary) is what
  // stays. The product's batch path never sends a `forgetlines` ask, so no
  // product renderer grows this branch for the experiment.
  const kept = decision.action === "keeplines" ? spans : complementLineSpans(spans, totalLines);
  if (kept.length === 0) {
    refuse("sim-render-keeps-nothing",
      `${decision.action} names every line; forgetting the whole unit is forgetall`);
  }
  return kept;
}

/**
 * Whether normalised kept spans keep the whole body: they start at line 1, cover
 * every line and end at the last. The same rule the live runner's fire loop reads
 * from `keepsWholeOf` (ISSUE-141): such an answer removes nothing, so it plans no
 * shaped turn.
 */
function keepsEveryLine(spans, totalLines) {
  if (spans.length === 0) return false;
  const covered = spans.reduce((sum, span) => sum + (span.to - span.from + 1), 0);
  return covered >= totalLines && spans[0].from === 1
    && spans[spans.length - 1].to === totalLines;
}

/**
 * The record's own five-term reading of a shaped row, compared name by name.
 * `null` when the record states no shaped terms (`kept` is null), so an
 * absent comparison is never printed as a pass.
 */
export function termsAgainstRecord(terms, gaps, moment) {
  const recordKept = moment?.kept ?? null;
  if (recordKept === null) return null;
  const expected = {
    kept: recordKept,
    markerBytes: moment?.marker?.bytes ?? 0,
    summary: moment?.summaryBytes ?? 0,
    framing: moment?.framingBytes ?? null,
    dropped: moment?.dropped ?? 0,
  };
  const mismatched = TERM_NAMES.filter(name => expected[name] !== terms[name]);
  if ((moment?.marker?.gaps ?? 0) !== gaps) mismatched.push("gaps");
  return { match: mismatched.length === 0, mismatched, expected };
}

/** The terms a row with no rewrite carries: the record's own whole-body shape. */
function wholeBodyTerms() {
  return { kept: null, markerBytes: 0, summary: 0, framing: null, dropped: 0 };
}

/**
 * The at-rest proof burn's own facts: the archive it names and — when the caller
 * states it — the step it landed at. The adapter carries the burn's `seq`, not
 * its step; `record.atRest.step` is the caller's field, and `step: null` is
 * printed rather than guessed.
 */
function atRestOf(moment) {
  const atRest = moment.record?.atRest ?? null;
  if (atRest === null || typeof atRest.recallId !== "string") {
    return refuse("sim-render-censored-receipt-absent",
      `${moment.id} is the engine's at-rest proof burn, and the record carries neither`
      + " its recall id nor its target");
  }
  const step = atRest.step ?? null;
  if (step !== null && (!Number.isSafeInteger(step) || step < moment.step)) {
    refuse("sim-render-moment-invalid",
      `${moment.id} states the at-rest burn's step as ${String(step)}; it cannot precede the`
      + ` result's own step ${moment.step}`);
  }
  return { step, recallId: atRest.recallId, target: atRest.target ?? moment.path ?? null };
}

/**
 * One moment re-rendered, with or without its decision.
 *
 * The row carries the body the turn holds BEFORE any swap (`before`, its hash
 * and its byte count), the body it holds after one (`after`), the step the swap
 * takes effect from (`swapStep`, null when the row never swaps, so the prefix
 * shows `after` from `swapStep + 1` on), and — for a shaped row — the five
 * `terms`.
 */
export function renderMoment(moment, decision = null) {
  if (moment === null || typeof moment !== "object") {
    refuse("sim-render-moment-invalid", "a moment is one object");
  }
  const momentId = moment.id;
  if (typeof momentId !== "string" || momentId.length === 0) {
    refuse("sim-render-moment-invalid", "a moment carries its record `id`");
  }
  const landedStep = moment.step;
  if (!Number.isSafeInteger(landedStep)) {
    refuse("sim-render-moment-invalid", `${momentId} carries step ${String(landedStep)}`);
  }
  const original = bodyOfMoment(moment);
  const originalSha256 = sha256Hex(original);
  const declared = moment.original?.sha256 ?? null;
  if (declared !== null && declared !== originalSha256) {
    refuse("sim-render-original-sha-mismatch",
      `${momentId} declares ${String(declared)} but its bytes hash to ${originalSha256}`);
  }
  // A decision that states no step is derived from its own result: the answer
  // follows the result, so the first step that can see it is this one plus one
  // (ISSUE-074 scheme A; the gate prefers the next `step/start` when it has the
  // transcript, and passes the derived step down).
  const chosen = decision === null ? null : normalizeDecision(decision, landedStep + 1);
  const machinery = moment.provenance?.censoredClass === "machinery-at-rest-removal"
    ? atRestOf(moment) : null;
  const row = {
    momentId,
    lane: moment.lane ?? null,
    seq: moment.seq ?? null,
    landedStep,
    decisionStep: chosen?.step ?? null,
    action: chosen?.action ?? null,
    shaped: false,
    termsBasis: "whole-body",
    terms: wholeBodyTerms(),
    gaps: 0,
    keptLines: null,
    censored: moment.provenance?.censoredClass ?? null,
    machinery: null,
    // The step this row's own body takes effect from, or null when the row never
    // swaps. A decision swaps at its answer's step; the at-rest burn at its own.
    swapStep: chosen?.step ?? null,
    recallId: null,
    recallIdMatchesRecord: null,
    recordCheck: null,
    before: moment.original?.text ?? original.toString("utf8"),
    beforeBytes: original.length,
    beforeSha256: originalSha256,
    after: moment.original?.text ?? original.toString("utf8"),
    afterSha256: originalSha256,
  };
  if (machinery !== null) {
    if (chosen !== null) {
      refuse("sim-render-censored-decision",
        `${momentId} is the engine's at-rest proof burn; it takes no answer`);
    }
    // The engine's at-rest proof burn: the whole body became one receipt line.
    // It is not a decision (`action` stays null) and it carries no terms; what
    // moves is the body, from the burn's own step on. A burn whose step the
    // caller did not state keeps the landed body and says so (`swapStep: null`),
    // so the prefix never shows a receipt at a step nobody can name.
    const receipt = receiptLine({
      path: machinery.target ?? moment.path ?? "",
      ranges: [],
      label: null,
      recallId: machinery.recallId,
    });
    if (machinery.step === null) {
      return {
        ...row,
        machinery: { ...machinery, row: receipt },
        swapStep: null,
        recallId: machinery.recallId,
      };
    }
    return {
      ...row,
      machinery: { ...machinery, row: receipt },
      swapStep: machinery.step,
      recallId: machinery.recallId,
      after: receipt,
      afterSha256: sha256Hex(utf8(receipt)),
    };
  }
  if (chosen === null || chosen.action === "keepall") {
    // A keepall moves the answer's step and rewrites nothing, so it is no swap.
    return { ...row, swapStep: null };
  }
  const sessionId = moment.session;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    refuse("sim-render-session-absent",
      `${momentId} carries no session; the recall id is minted per session`);
  }
  const totalLines = splitLineOffsets(original).length;
  const kept = keptSpansOf(chosen, totalLines);
  // Keep-whole (ISSUE-141): a `keeplines` that names every line removes nothing,
  // so it plans no shaped turn and the row stays exactly as landed. The fire loop
  // reads it as a keep (`keepsWholeOf`) and skips the render; without this branch
  // the lane's final re-render would refuse `sim-render-nothing-dropped` and lose
  // the whole run. Like a `keepall`, it moves the answer's step and no bytes.
  if (chosen.action === "keeplines" && keepsEveryLine(kept, totalLines)) {
    return { ...row, swapStep: null };
  }
  const keptRanges = byteRangeForLines(original, kept.map(span => ({
    startLine: span.from, endLineInclusive: span.to,
  })));
  // The source ref the archive was filed under: the product hashes it into the
  // marker's recall id, so a record that does not carry it names another id.
  const source = {
    nodeId: moment.source?.nodeId ?? momentId,
    sha256: originalSha256,
    byteLength: original.length,
  };
  const turn = renderShapeTurn({
    source, original: new Uint8Array(original), keptRanges, sessionId,
  });
  if (turn === null) {
    refuse("sim-render-nothing-dropped",
      `${chosen.action} for ${momentId} keeps every line, so it plans no shaped turn`);
  }
  // A marker block owns its line (ISSUE-063): a marker glued to the kept bytes
  // after it would put the recall id into that line's text.
  for (const range of turn.generatedRanges) {
    if (turn.bytes[range.endByteExclusive - 1] !== LINE_FEED) {
      refuse("sim-render-marker-glued",
        `${momentId}: a marker block does not end on its own line`);
    }
  }
  const summaryBytes = utf8(entryShapePrefix(chosen.summary)).length;
  const body = Buffer.from(composeEntryShapeTurn(chosen.summary, turn.bytes));
  const markerBytes = utf8(turn.marker).length;
  const gaps = turn.gaps.length;
  const keptBytes = turn.retainedCopies.reduce((sum, copy) =>
    sum + (copy.outputRange.endByteExclusive - copy.outputRange.startByte), 0);
  const dropped = turn.droppedBytes;
  if (keptBytes + dropped !== original.length) {
    refuse("sim-render-arithmetic",
      `${momentId}: kept ${keptBytes} + dropped ${dropped} is not the ${original.length}-byte`
      + " original");
  }
  const framing = body.length - keptBytes - gaps * markerBytes - summaryBytes;
  if (framing < 0) {
    refuse("sim-render-framing-negative",
      `${momentId}: kept ${keptBytes} + ${gaps}×${markerBytes} marker + summary`
      + ` ${summaryBytes} already exceed the ${body.length}-byte turn by ${-framing}`);
  }
  const terms = { kept: keptBytes, markerBytes, summary: summaryBytes, framing, dropped };
  return {
    ...row,
    shaped: true,
    termsBasis: "shaped",
    terms,
    gaps,
    keptLines: turn.keptLines.map(range => ({ ...range })),
    swapStep: chosen.step,
    recallId: turn.recallId,
    recallIdMatchesRecord: typeof moment.recallId === "string"
      ? moment.recallId === turn.recallId : null,
    recordCheck: termsAgainstRecord(terms, gaps, moment),
    after: body.toString("utf8"),
    afterSha256: sha256Hex(body),
  };
}

/**
 * A lane re-rendered: every moment's row, the observed steps with their prefix
 * hashes, and the final prefix. A decision that cannot apply is refused by name
 * before any row is written, so a half-applied lane can never print.
 */
export function renderLane(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    refuse("sim-render-record-invalid", "a record is one object: {lane, moments, decisions}");
  }
  const moments = record.moments;
  if (!Array.isArray(moments)) {
    refuse("sim-render-record-invalid", "record.moments must be an array");
  }
  if (moments.length === 0) {
    refuse("sim-render-no-moments",
      "the record holds no moment; an empty lane is censored, never rendered green");
  }
  const decisions = record.decisions ?? [];
  if (!Array.isArray(decisions)) {
    refuse("sim-render-record-invalid", "record.decisions must be an array");
  }
  const byId = new Map();
  for (const moment of moments) {
    if (typeof moment?.id !== "string" || moment.id.length === 0) {
      refuse("sim-render-moment-invalid", "every moment carries its record `id`");
    }
    if (byId.has(moment.id)) refuse("sim-render-duplicate-moment", `${moment.id} appears twice`);
    if (!Number.isSafeInteger(moment.step)) {
      refuse("sim-render-moment-invalid", `${moment.id} carries step ${String(moment.step)}`);
    }
    byId.set(moment.id, moment);
  }
  const byMoment = new Map();
  for (const raw of decisions) {
    // The moment is resolved before the step, because a decision that states
    // none derives it from the result it decides (ISSUE-074 scheme A). A
    // step-less decision naming a moment the record does not hold has nothing
    // to derive from, so it keeps the moment's own refusal name; a decision that
    // STATES a step keeps every refusal it had, in the order it had them.
    const named = raw !== null && typeof raw === "object" ? (raw.momentId ?? raw.id ?? null) : null;
    const target = typeof named === "string" ? byId.get(named) : undefined;
    if (target === undefined && typeof named === "string" && (raw.step ?? null) === null) {
      refuse("sim-render-moment-unknown",
        `a decision names ${named}, which the record does not hold, so no result step is`
        + " available to derive its step from");
    }
    const decision = normalizeDecision(raw, target === undefined ? null : target.step + 1);
    const moment = byId.get(decision.momentId);
    if (moment === undefined) {
      refuse("sim-render-moment-unknown",
        `a decision names ${decision.momentId}, which the record does not hold`);
    }
    if (byMoment.has(decision.momentId)) {
      refuse("sim-render-duplicate-decision", `${decision.momentId} carries two decisions`);
    }
    if (decision.step < moment.step) {
      refuse("sim-render-step-before-moment",
        `a decision at step ${decision.step} precedes ${decision.momentId}'s own step`
        + ` ${moment.step}`);
    }
    byMoment.set(decision.momentId, decision);
  }
  const rows = moments
    .map(moment => renderMoment(moment, byMoment.get(moment.id) ?? null))
    .sort((left, right) => (left.seq - right.seq) || left.momentId.localeCompare(right.momentId));
  const observed = new Set();
  for (const row of rows) {
    observed.add(row.landedStep);
    if (row.decisionStep !== null) observed.add(row.decisionStep);
  }
  observed.add(Math.max(...observed) + 1);
  const rendered = {
    lane: record.lane ?? null,
    moments: moments.length,
    decisions: rows.filter(row => row.decisionStep !== null).length,
    shaped: rows.filter(row => row.shaped).length,
    rows,
    steps: [],
    final: null,
  };
  rendered.steps = [...observed].sort((left, right) => left - right)
    .map(step => prefixAt(rendered, step));
  rendered.final = rendered.steps[rendered.steps.length - 1];
  rendered.recallIdDrift = rows.filter(row => row.recallIdMatchesRecord === false).length;
  rendered.recordMismatches = rows.filter(row => row.recordCheck?.match === false).length;
  return rendered;
}

/**
 * A list of rows as the request fed them: each in the body it held at `step`
 * (`before` until the row's swap, `after` from `swapStep + 1` on), joined by
 * the product's `renderHistory`. The caller chooses which rows are fed; this
 * only renders and joins them.
 */
function joinPrefixRows(rows, step) {
  return renderHistory(rows.map(row => ({
    role: "tool",
    text: row.swapStep !== null && step > row.swapStep ? row.after : row.before,
  })));
}

/**
 * The lane's prefix at one step: every turn landed before it, in `seq` order,
 * each in the body it held at that step, joined by the product's
 * `renderHistory`. Total over steps — a step no row lands on repeats the prefix
 * before it.
 */
export function prefixTextAt(rendered, step) {
  if (!Number.isSafeInteger(step) || step < 0) {
    refuse("sim-render-step-invalid",
      `a prefix step is a non-negative integer, got ${String(step)}`);
  }
  if (rendered === null || typeof rendered !== "object" || !Array.isArray(rendered.rows)) {
    refuse("sim-render-record-invalid", "prefixTextAt needs a rendered lane");
  }
  return joinPrefixRows(rendered.rows.filter(row => row.landedStep < step), step);
}

/** `prefixTextAt` as the hash and the byte count a chain check compares. */
export function prefixAt(rendered, step) {
  const text = prefixTextAt(rendered, step);
  return {
    step,
    turns: rendered.rows.filter(row => row.landedStep < step).length,
    swapped: rendered.rows.filter(row => row.swapStep !== null && step > row.swapStep).length,
    prefixBytes: utf8(text).length,
    prefixSha256: sha256Hex(utf8(text)),
  };
}

/**
 * The lane's prefix as the request the trigger built carried it: every turn
 * whose result landed at or before the trigger's own `seq`, each in the body it
 * held at `step`, joined like `prefixTextAt`.
 *
 * `landedStep` is not a cut on its own. Two tool results can land in the SAME
 * step (`seq` orders them, `step` does not), and a result whose `seq` is after
 * the trigger's `seq` cannot have been in the trigger's request — even when its
 * `landedStep` equals the trigger's step. Cutting at `seq` says that exactly;
 * `landedStep < step` cannot.
 */
export function prefixTextToSeq(rendered, seq, step) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    refuse("sim-render-seq-invalid",
      `a prefix seq is a non-negative integer, got ${String(seq)}`);
  }
  if (!Number.isSafeInteger(step) || step < 0) {
    refuse("sim-render-step-invalid",
      `a prefix step is a non-negative integer, got ${String(step)}`);
  }
  if (rendered === null || typeof rendered !== "object" || !Array.isArray(rendered.rows)) {
    refuse("sim-render-record-invalid", "prefixTextToSeq needs a rendered lane");
  }
  return joinPrefixRows(rendered.rows.filter(row => row.seq !== null && row.seq <= seq), step);
}

/** `prefixTextToSeq` as the hash and the byte count a chain check compares. */
export function prefixAtSeq(rendered, seq, step) {
  const text = prefixTextToSeq(rendered, seq, step);
  return {
    seq,
    step,
    turns: rendered.rows.filter(row => row.seq !== null && row.seq <= seq).length,
    swapped: rendered.rows.filter(row =>
      row.seq !== null && row.seq <= seq && row.swapStep !== null && step > row.swapStep).length,
    prefixBytes: utf8(text).length,
    prefixSha256: sha256Hex(utf8(text)),
  };
}

/** The human summary: counts and the five terms, no ratio and no derived number. */
export function summaryOf(rendered) {
  const machinery = rendered.rows.filter(row => row.machinery !== null);
  return [
    "sim-render",
    `  lane         ${rendered.lane ?? "-"}`,
    `  moments      ${rendered.moments}`,
    `  decisions    ${rendered.decisions} carried, ${rendered.shaped} shaped`,
    `  machinery    ${machinery.length} at-rest receipt(s),`
      + ` ${machinery.filter(row => row.swapStep === null).length} without a stated step`,
    `  recall-id    ${rendered.recallIdDrift} row(s) whose marker names another id than the`
      + " record's",
    `  terms        ${rendered.recordMismatches} shaped row(s) disagree with the record's terms`,
    `  steps        ${rendered.steps.length} observed, last at ${rendered.final.step}`,
    `  prefix       ${rendered.final.prefixSha256} ${rendered.final.prefixBytes} B at step`
      + ` ${rendered.final.step}`,
    ...rendered.rows.filter(row => row.shaped).map(row => `  seq ${String(row.seq).padStart(4)}`
      + `  ${String(row.action).padEnd(11)} kept ${String(row.terms.kept).padStart(5)}`
      + ` marker ${row.gaps}×${row.terms.markerBytes}`
      + ` summary ${String(row.terms.summary).padStart(3)}`
      + ` framing ${String(row.terms.framing).padStart(2)}`
      + ` dropped ${String(row.terms.dropped).padStart(5)}`),
  ].join("\n");
}

/** The argument map: the flag as written, the option it sets. */
const FLAGS = optionsOf([
  ["--record", "string"],
  ["--out", "string"],
  ["--json", "boolean"],
]);

export function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: FLAGS,
    refuse: message => refuse("usage", message),
    help: `${USAGE}\n`,
  });
  const opts = {
    record: values.record ?? null,
    out: values.out ?? null,
    json: values.json ?? false,
  };
  if (opts.record === null) refuse("usage", "--record is required");
  return opts;
}

function readRecord(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return refuse("sim-render-record-unreadable", `${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse("sim-render-record-unreadable", `${file}: ${error.message}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const record = readRecord(path.resolve(process.cwd(), opts.record));
  const rendered = renderLane(record);
  if (opts.out !== null) {
    const target = path.resolve(process.cwd(), opts.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, `${JSON.stringify(rendered, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${summaryOf(rendered)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error?.code === "usage") process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
}
