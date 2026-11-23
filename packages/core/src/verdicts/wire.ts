import type { UnitId } from "../types/identity.js";
import { normalizeActionKey } from "./action-keys.js";
import { descriptorIssue, RECEIPT_DESCRIPTOR_WORD_LIMIT } from "./labels.js";
import { normalizeKeptSpans } from "./plan.js";
import type { KeptLineSpan, Verdict } from "./types.js";

/**
 * The v4.1 answer notation (owner ruling 6, 2026-10-23; `forgetlines` added by
 * ISSUE-061 chunk F-1a, ADR-0026). The wire carries the action as the object's
 * only key and nothing else: no unit id, no `action` field, no free-text slot
 * beside the payload. Identity and round are stamped by the caller, never read
 * from the answer, so a judge cannot answer for another unit or another round.
 *
 * ```
 * {"keepall":true}
 * {"keeplines":[[start,end],...,"summary of the dropped lines, <= 25 words"]}
 * {"forgetlines":[[start,end],...,"summary of the dropped lines, <= 25 words"]}
 * {"forgetall":"summary, <= 25 words"}
 * ```
 *
 * `keeplines` names the lines that STAY; `forgetlines` names the lines that
 * LEAVE and keeps the complement inside the unit. The two share one shape on
 * purpose: for the A/B they are one variable, the polarity of the ranges
 * (ADR-0026 §3, ADR-0027 §4). Whether a span runs past the unit is not decided
 * here — the unit's line count is not on the wire; the guard refuses that.
 */
const WIRE_ACTIONS: readonly string[] = ["keepall", "keeplines", "forgetall", "forgetlines"];

/** The identity the harness stamps on an answer: both fields are never on the wire. */
export interface WireStamp {
  readonly unitId: UnitId;
  /** Gate round ordinal, monotonic per session. */
  readonly answeredInRound: number;
}

/**
 * What one wire answer yields: the verdict the protocol acts on, plus the
 * `keeplines` or `forgetlines` trailer when the answer carried one. The trailer
 * is not on the verdict type; this slot is where the caller reads it, so the
 * summary the prompt commands is never dropped silently. Absent on `keepall`
 * and on `forgetall`, whose summary already lives inside its verdict.
 */
export interface WireAnswer {
  readonly verdict: Verdict;
  readonly keeplinesSummary?: string;
  /** The `forgetlines` trailer: the summary of the dropped lines (ADR-0026). */
  readonly forgetlinesSummary?: string;
}

export type WireVerdictErrorCode =
  | "invalid-stamp"
  | "not-an-object"
  | "mixed-keys"
  | "both-forgotten-and-summary"
  | "unknown-action"
  | "invalid-keepall"
  | "invalid-keeplines"
  | "invalid-forgetlines"
  | "invalid-span"
  | "empty-ranges"
  | "summary-missing"
  | "summary-too-long"
  | "invalid-forgetall";

/**
 * One refusal from the wire parser. The code names the defect and the message
 * is fixed per code, so a retry prompt and a test can both quote it verbatim.
 * The parser never repairs an answer: a shape it cannot read is refused whole,
 * and the caller re-asks. The one thing it does read in two spellings is a
 * whole-unit action written bare (ADR-0039) — that is the same answer in a
 * second notation, not a broken answer with a guess laid over it.
 */
export class WireVerdictError extends Error {
  readonly code: WireVerdictErrorCode;

  constructor(code: WireVerdictErrorCode, message: string) {
    super(message);
    this.name = "WireVerdictError";
    this.code = code;
  }
}

const MESSAGES: Readonly<Record<WireVerdictErrorCode, string>> = {
  "invalid-stamp": "The stamp carries a non-empty unit id and a safe integer round.",
  "not-an-object": "A wire verdict is a JSON object.",
  "mixed-keys": "A wire verdict carries exactly one action key, and a partial one may add one forgotten value.",
  "both-forgotten-and-summary": "A wire verdict carries forgotten or its legacy alias summary, never both.",
  "unknown-action": `The wire action is not one of ${WIRE_ACTIONS.join(", ")}.`,
  "invalid-keepall": "keepall carries the boolean true and nothing else.",
  "invalid-keeplines": "keeplines carries an array of [start,end] pairs and a trailing forgotten string.",
  "invalid-forgetlines": "forgetlines carries an array of [start,end] pairs and a trailing forgotten string.",
  "invalid-span": "Every span is a [start,end] pair of integers with 1 <= start <= end.",
  "empty-ranges": "keeplines names at least one [start,end] pair.",
  "summary-missing": "A partial verdict carries one forgotten value: a trailing string or a sibling forgotten key (legacy summary accepted).",
  "summary-too-long": `A forgotten value stays within ${String(RECEIPT_DESCRIPTOR_WORD_LIMIT)} words.`,
  "invalid-forgetall": "forgetall carries its forgotten string as the value.",
};

function refuse(code: WireVerdictErrorCode): never {
  throw new WireVerdictError(code, MESSAGES[code]);
}

/**
 * A bare whole-unit action read as the object it names (ADR-0039).
 *
 * `"keepall"` and `"forgetall"` are the two actions that take no argument beyond
 * themselves: the first is the boolean `true` under its own key and the second
 * is one optional summary, whose absence is already legal (zero words, the floor
 * receipt line). So the string spelling loses nothing and reads as the object.
 *
 * `"keeplines"` and `"forgetlines"` name line spans the string does not carry,
 * and the parser never sees the unit's line count. A bare one is returned
 * untouched and refused `not-an-object` exactly as before: the spans cannot be
 * guessed, and a guessed span would invent a removal the model never named.
 * Every other value — a non-string, an empty string, an unknown word — is also
 * returned untouched, so its refusal is byte-for-byte the one it earned before.
 */
function bareWholeUnit(value: unknown): unknown {
  if (value === "keepall") return { keepall: true };
  if (value === "forgetall") return { forgetall: "" };
  return value;
}

/**
 * One answer off the wire, as the internal verdict the protocol acts on. The
 * stamp supplies `unitId` and `answeredInRound`; the answer supplies the action
 * and its payload, and nothing else.
 *
 * Refused whole (a `WireVerdictError`, never a partial reading): a non-object,
 * zero or several top-level keys, an action outside the four, `keepall` whose
 * value is not `true`, a `keeplines` or `forgetlines` payload that is not a list
 * of pairs plus a trailing summary, an empty span list, a reversed or fractional
 * span, and a summary past the 25-word cap.
 *
 * Two spellings, one answer, and only for the whole-unit actions (ADR-0039): a
 * bare `"keepall"` reads as `{"keepall":true}` and a bare `"forgetall"` as
 * `{"forgetall":""}` — the whole-unit drop with no descriptor. Both are the
 * same decision the object form states, so nothing is invented. A bare
 * `"keeplines"` or `"forgetlines"` names spans it does not carry and stays
 * refused `not-an-object`; so does every other shape.
 *
 * Span order and overlap are normalised, not refused: `normalizeKeptSpans` is
 * the same function the guard and the planner use, so a judge's unsorted or
 * touching pairs mean exactly what the rest of the protocol means by them.
 * Whether a span runs past the unit is not decided here — the unit's line count
 * is not on the wire; the guard refuses that.
 *
 * The `keeplines` trailer is returned beside the verdict as `keeplinesSummary`
 * and a `forgetlines` trailer as `forgetlinesSummary`: the v4 internal verdicts
 * carry no summary slot and their receipts carry no descriptor by design, so the
 * caller — not this parser — decides where the string lands. A blank summary is
 * accepted (zero words) exactly as the receipt floor line accepts one for
 * `forgetall`.
 */
export function parseWireVerdict(value: unknown, stamp: WireStamp): WireAnswer {
  if (typeof stamp !== "object" || stamp === null
    || typeof stamp.unitId !== "string" || stamp.unitId.length === 0
    || !Number.isSafeInteger(stamp.answeredInRound)) refuse("invalid-stamp");
  const answer = bareWholeUnit(value);
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    refuse("not-an-object");
  }
  const record = answer as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 3) refuse("mixed-keys");
  const actionKeys = keys.filter(key => normalizeActionKey(key) !== null);
  if (actionKeys.length > 1) refuse("mixed-keys");
  // A lone key that names no action is `unknown-action`, as it always was; the
  // descriptor keys never stand alone.
  if (actionKeys.length === 0 && keys.length !== 1) refuse("mixed-keys");
  const rawAction = actionKeys[0] ?? keys[0];
  if (rawAction === undefined) refuse("mixed-keys");
  // The key is read case- and plural-insensitively (ISSUE-515); the payload is
  // still read from the key's own raw spelling. Everything else is unchanged.
  const action = normalizeActionKey(rawAction);
  if (action === null || !WIRE_ACTIONS.includes(action)) refuse("unknown-action");
  const extras = keys.filter(key => key !== rawAction);
  if (extras.some(key => key !== "forgotten" && key !== "summary")) refuse("mixed-keys");
  if (extras.length > 1) refuse("both-forgotten-and-summary");
  const partial = action === "keeplines" || action === "forgetlines";
  if (extras.length > 0 && !partial) refuse("mixed-keys");
  const flat = readFlatDescriptor(record);
  const payload = record[rawAction];
  const base = { unitId: stamp.unitId, answeredInRound: stamp.answeredInRound };
  switch (action) {
    case "keepall":
      if (payload !== true) refuse("invalid-keepall");
      return { verdict: { ...base, action: "keepall" } };
    case "keeplines": {
      const { ranges, summary } = readKeptLines(payload, flat);
      return { verdict: { ...base, action: "keeplines", ranges }, keeplinesSummary: summary };
    }
    case "forgetlines": {
      const { ranges, summary } = readForgottenLines(payload, flat);
      return { verdict: { ...base, action: "forgetlines", ranges }, forgetlinesSummary: summary };
    }
    case "forgetall":
      return {
        verdict: { ...base, action: "forgetall", summary: readSummary(payload, "invalid-forgetall") },
      };
    default:
      // Every wired action has its own case above; this arm covers an action
      // added to WIRE_ACTIONS before its case, so it refuses rather than parsing
      // as a whole-unit drop.
      return refuse("unknown-action");
  }
}

/**
 * The kept spans a `keeplines` payload names, normalised, plus its descriptor.
 * The payload is one array: zero or more `[start,end]` pairs and, last, the
 * forgotten string. A sibling `forgotten` key (legacy `summary`) may replace
 * the trailer; the array then holds pairs only.
 */
function readKeptLines(
  payload: unknown,
  flat: FlatDescriptor,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-keeplines");
  const last = payload[payload.length - 1];
  const trailer = typeof last === "string";
  if (trailer && flat.present) refuse("mixed-keys");
  if (!trailer && !flat.present) refuse("summary-missing");
  const pairs = trailer ? payload.slice(0, -1) : payload;
  if (pairs.length === 0) refuse("empty-ranges");
  const spans: KeptLineSpan[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) refuse("invalid-span");
    const [from, to] = pair as readonly unknown[];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) refuse("invalid-span");
    const span = { from: from as number, to: to as number };
    if (span.from < 1 || span.to < span.from) refuse("invalid-span");
    spans.push(span);
  }
  const normalized = normalizeKeptSpans(spans);
  if (normalized === null || normalized.length === 0) refuse("invalid-span");
  const summary = readSummary(trailer ? last : flat.value, "summary-missing");
  return { ranges: normalized, summary };
}

/**
 * The spans a `forgetlines` payload names — the lines that LEAVE the unit —
 * normalised, plus its descriptor. Same array shape and same rules as
 * `readKeptLines`, with the action's own refusal name and the opposite polar
 * meaning (ADR-0026 §2). The guard decides whether the spans land inside the
 * unit; this reader never sees the unit.
 */
function readForgottenLines(
  payload: unknown,
  flat: FlatDescriptor,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-forgetlines");
  const last = payload[payload.length - 1];
  const trailer = typeof last === "string";
  if (trailer && flat.present) refuse("mixed-keys");
  if (!trailer && !flat.present) refuse("summary-missing");
  const pairs = trailer ? payload.slice(0, -1) : payload;
  if (pairs.length === 0) refuse("empty-ranges");
  const spans: KeptLineSpan[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) refuse("invalid-span");
    const [from, to] = pair as readonly unknown[];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) refuse("invalid-span");
    const span = { from: from as number, to: to as number };
    if (span.from < 1 || span.to < span.from) refuse("invalid-span");
    spans.push(span);
  }
  const normalized = normalizeKeptSpans(spans);
  if (normalized === null || normalized.length === 0) refuse("invalid-span");
  const summary = readSummary(trailer ? last : flat.value, "summary-missing");
  return { ranges: normalized, summary };
}

/** A partial verdict's sibling descriptor: whether it exists, and what it holds. */
interface FlatDescriptor {
  readonly present: boolean;
  readonly value: unknown;
}

/**
 * The sibling descriptor's value: `forgotten` is canonical and `summary` the
 * legacy alias. A record carrying both is refused before this is read.
 */
function readFlatDescriptor(record: Record<string, unknown>): FlatDescriptor {
  const canonical = Object.hasOwn(record, "forgotten");
  const legacy = Object.hasOwn(record, "summary");
  return {
    present: canonical || legacy,
    value: canonical ? record.forgotten : record.summary,
  };
}

/** One summary string under the 25-word cap; returned so the caller decides its home. */
function readSummary(value: unknown, wrongType: WireVerdictErrorCode): string {
  if (typeof value !== "string") refuse(wrongType);
  if (descriptorIssue(value) !== null) refuse("summary-too-long");
  return value;
}
