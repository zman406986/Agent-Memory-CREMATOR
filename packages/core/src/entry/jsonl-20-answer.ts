/**
 * Reading the `jsonl-20` batch answer (ISSUE-143; shipped by ISSUE-183;
 * ADR-0040; the per-row reading restored by ISSUE-187).
 *
 * One answer is one JSON object per line, one row per object: the key is that
 * row's index as a decimal string, the value is that row's verdict, an object
 * with exactly one action key (`keepall`, `forgetall`, `keeplines`) and a
 * sibling `summary` when the row forgets. This module turns that text into
 * exactly one result per assigned index, so a bad line costs its own row and
 * nothing else.
 *
 * EVERY line is read on its own, and a line's defect refuses its own row only:
 *
 * - a line that does not parse but still spells its leading `"<index>":` key
 *   refuses THAT row `answer-unreadable`; a line that does not parse and names
 *   no assigned row moves no unit, so the row it would have answered falls to
 *   `missing-index` (which keeps it too);
 * - one object carrying two or more top-level keys names more than one row on
 *   one line, so every assigned index it names is refused `mixed-keys` — the
 *   index-keyed verdict is never applied beside an extra key (the prompt's
 *   rule 7: "Add no other rows, keys, or text");
 * - a repeated index still supersedes its earlier reading and refuses that row
 *   `duplicate-index`. `JSON.parse` collapses two equal top-level keys to the
 *   last value, so the raw line is scanned as well: a line that spells the same
 *   assigned index twice is refused `duplicate-index`, never read last-wins.
 *
 * The ONLY whole-answer refusal left is an answer that carries no verdict at
 * all: no line parses as a JSON object and no line names a row of this ask —
 * empty, blank or whitespace-only text, prose, or only the trailing anchor.
 * Blank lines beside a real verdict are ignored, and ONE trailing line that
 * starts with `[[entry-ask-end:` is ignored; every other line is read on its
 * own.
 *
 * `lineCounts` is the per-row `L` the ask's table showed. It is required for a
 * `keeplines` row: its bounds are checked against that row's own count, and a
 * missing count is a caller bug (a `RangeError`), never a silently unchecked
 * range. A count that is present but unprovable — the zero, negative or
 * non-integer the ask already tables as `[0 lines]` — is not missing: that row
 * refuses `spans-outside-result` and keeps, so one such row never ends the whole
 * answer (ISSUE-562). The reader tolerates a summary up to 30 words while the
 * prompt asks for under 20; the tolerance is wider than the ask on purpose.
 *
 * The action KEY is read case- and plural-insensitively (ISSUE-515):
 * `KEEPLINES`, `keepline`, `KEEPline` and `keepLines` are one action, through
 * `normalizeActionKey`. The prompt still teaches the canonical spelling, and a
 * true misspelling (`kleplines`) stays out. Two action keys that normalize to
 * one action are still two keys and still refused `mixed-keys`.
 *
 * The behaviour is the simulator's `jsonl20RowsOf`
 * (`dev/sim/sim-batch-grammar.mjs:506-680`) ported without a wording change to
 * the refusal rules. Pure and deterministic: same text, same indices, same
 * counts, same reading; nothing is mutated and nothing is added.
 */

import { normalizeTwoVerdictAnswer } from "../prune/two-verdict.js";
import { normalizeActionKey } from "../verdicts/action-keys.js";
import { descriptorWordCount } from "../verdicts/labels.js";
import type { EntryAnswer } from "../verdicts/entry-wire.js";

/**
 * The `jsonl-20` summary tolerance, in words. The prompt asks for under 20; the
 * reader accepts up to and including 30 and refuses above.
 */
export const JSONL_20_SUMMARY_WORDS = 30;

/** The prefix of the one trailing anchor line a `jsonl-20` answer may carry. */
export const JSONL_20_CLOSING_PREFIX = "[[entry-ask-end:";

/** The three actions a `jsonl-20` verdict may carry. */
const JSONL_20_ACTIONS: readonly string[] = Object.freeze(["keepall", "forgetall", "keeplines"]);

/**
 * Every refusal a `jsonl-20` row or answer can earn. `action-not-in-grammar`,
 * `summary-too-long` and `malformed-row` are the product's own names (the last
 * for a `forgetall` that is not exactly `true`); the rest are this grammar's
 * line-oriented codes. Each keeps the row it names.
 *
 * `unknown-index` is listed for the vocabulary's completeness but is a
 * REJECTION, not a row refusal: it names no assigned row, so it moves no unit.
 */
export const JSONL_20_REFUSAL_CODES = Object.freeze([
  "answer-unreadable", "unknown-index", "duplicate-index", "missing-index",
  "action-not-in-grammar", "malformed-row", "mixed-keys",
  "both-forgotten-and-summary", "summary-missing",
  "summary-too-long", "bad-range", "ranges-unordered", "spans-outside-result",
] as const);

/** Every code the `jsonl-20` reader can name, on a row or on a key. */
export type Jsonl20RefusalCode = (typeof JSONL_20_REFUSAL_CODES)[number];

/** The codes a refused ROW can carry; `unknown-index` addresses no row. */
export type Jsonl20RowRefusalCode = Exclude<Jsonl20RefusalCode, "unknown-index">;

/** One row's reading: the entry answer to apply, or the refusal that keeps it. */
export type Jsonl20RowResult =
  | { readonly index: number; readonly status: "answered"; readonly answer: EntryAnswer }
  | {
    readonly index: number;
    readonly status: "refused";
    readonly code: Jsonl20RowRefusalCode;
    /** The fixed sentence for this code, for a journal's detail slot. */
    readonly message: string;
  };

/** A key the answer carried that names no row of this ask; no row is affected. */
export interface Jsonl20Rejection {
  readonly key: string;
  /** The key read as an index, or null when it is not a canonical integer. */
  readonly index: number | null;
  readonly code: "unknown-index";
  readonly message: string;
}

/** One reading: one row per assigned index in the ask's order, plus stray keys. */
export interface Jsonl20Reading {
  readonly rows: readonly Jsonl20RowResult[];
  readonly rejected: readonly Jsonl20Rejection[];
}

/**
 * Reads one `jsonl-20` answer into one result per assigned index.
 *
 * The returned rows follow `indices`' own order, never the answer's line order,
 * and every assigned index appears exactly once: an unanswered row is
 * `missing-index`, and a repeated key supersedes its earlier reading and refuses
 * that row `duplicate-index`. Every line is read on its own, so one bad line
 * moves its own row and no other (ISSUE-187); only an answer that carries no
 * verdict at all — no readable object, no line naming a row — refuses as a whole.
 */
export function readJsonl20Answer(
  text: string,
  indices: readonly number[],
  lineCounts: ReadonlyMap<number, number> = new Map(),
): Jsonl20Reading {
  const assigned = new Set(indices);
  const answered = new Map<number, EntryAnswer>();
  const refusals = new Map<number, Jsonl20RowRefusalCode>();
  const rejected: Jsonl20Rejection[] = [];
  const unreadable = (): Jsonl20Reading => ({
    rows: indices.map(index => refused(index, "answer-unreadable")),
    rejected,
  });
  if (typeof text !== "string") return unreadable();
  const lines = text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  // The runner's closing anchor is the ask's last line; a reply may echo it.
  if (lines.length > 0 && lines[lines.length - 1]?.startsWith(JSONL_20_CLOSING_PREFIX)) lines.pop();
  // Nothing left to read: an empty answer is not "every row missing", it is an
  // answer that carries no verdict at all.
  if (lines.length === 0) return unreadable();

  /**
   * A repeated index supersedes its earlier reading and refuses the row: the
   * same rule whether the second mention is a verdict, a broken line, or an
   * extra top-level key.
   */
  const claim = (index: number, code: Jsonl20RowRefusalCode): void => {
    answered.delete(index);
    refusals.set(index, code);
  };
  const claimed = (index: number): boolean => answered.has(index) || refusals.has(index);
  /** A row refusal, or `duplicate-index` when that index was already named. */
  const refuseRow = (index: number, code: Jsonl20RowRefusalCode): void => {
    claim(index, claimed(index) ? "duplicate-index" : code);
  };
  // At least one line said something about a row: only an answer with none at
  // all is a whole-answer refusal.
  let readAnything = false;

  for (const line of lines) {
    let parsed: unknown;
    let readable = true;
    try {
      parsed = JSON.parse(line);
    } catch {
      readable = false;
    }
    if (!readable) {
      // The line is not JSON. Its leading `"<index>":` key, when it still
      // spells one, is the row it was meant for; otherwise it names no row and
      // moves no unit.
      const key = leadingKeyOf(line);
      const index = key === null ? null : decimalIndexOf(key);
      if (index !== null && assigned.has(index)) {
        readAnything = true;
        refuseRow(index, "answer-unreadable");
      }
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) continue;
    readAnything = true;
    // A line that spells the same top-level key twice is collapsed by
    // `JSON.parse` before `keys` is read, so only the raw text still carries the
    // duplicate. A repeated assigned index is refused as `duplicate-index`; its
    // last value is never applied.
    const repeated = repeatedAssignedIndexes(line, assigned);
    if (repeated.length > 0) {
      for (const index of repeated) refuseRow(index, "duplicate-index");
      // A multi-key line still refuses its OTHER assigned keys `mixed-keys`
      // (ISSUE-325); the repeated index stays claimed, so `refuseRow` below
      // keeps its `duplicate-index`. A single-key duplicate line is done here.
      if (keys.length === 1) continue;
    }
    if (keys.length > 1) {
      // One object naming more than one row: the prompt allows one row per
      // line, so every row it names is refused and kept, and no verdict beside
      // the extra key is applied (ISSUE-187; prompt rule 7).
      for (const key of keys) {
        const index = decimalIndexOf(key);
        if (index === null || !assigned.has(index)) continue;
        refuseRow(index, "mixed-keys");
      }
      continue;
    }
    const key = keys[0];
    if (key === undefined) continue;
    const index = decimalIndexOf(key);
    if (index === null || !assigned.has(index)) {
      rejected.push({
        key, index, code: "unknown-index",
        message: `Index ${JSON.stringify(key)} was not assigned by this ask;`
          + " no row is affected.",
      });
      continue;
    }
    if (claimed(index)) {
      refuseRow(index, "duplicate-index");
      continue;
    }
    const reading = readingOfValue(record[key], lineCounts, index);
    if ("answer" in reading) answered.set(index, reading.answer);
    else refusals.set(index, reading.code);
  }
  // No line carried a verdict: prose, an empty answer, or only the anchor.
  if (!readAnything) return unreadable();
  const rows = indices.map((index): Jsonl20RowResult => {
    const answer = answered.get(index);
    if (answer !== undefined) return { index, status: "answered", answer };
    return refused(index, refusals.get(index) ?? "missing-index");
  });
  return { rows, rejected };
}

/** The keys a `jsonl-20` answer carried that named no row of this ask. */
export function jsonl20RejectionsOf(
  text: string,
  indices: readonly number[],
  lineCounts: ReadonlyMap<number, number> = new Map(),
): readonly Jsonl20Rejection[] {
  return readJsonl20Answer(text, indices, lineCounts).rejected;
}

/**
 * Reads one `jsonl-20-nokeepall` answer. It is the shipped reading first, then
 * the one action this grammar removes: a `keepall` row is answered by the
 * reader (the wire knows it), so it becomes `action-not-in-grammar` and the unit
 * keeps. A whole-range `keeplines` — whatever its summary says — is normalized
 * to a clean `keepall` before it leaves the reader, so the apply path never sees
 * a both-ends keep. Every other shape is the shipped reading, including every
 * partial `keeplines` and every `forgetall`.
 *
 * `lineCounts` is required exactly where `readJsonl20Answer` requires it: for a
 * `keeplines` row, whose bounds are checked against that row's own L. The
 * grammar gate itself needs no count.
 */
export function readJsonl20NoKeepallAnswer(
  text: string,
  indices: readonly number[],
  lineCounts: ReadonlyMap<number, number> = new Map(),
): Jsonl20Reading {
  const reading = readJsonl20Answer(text, indices, lineCounts);
  return {
    rejected: reading.rejected,
    rows: reading.rows.map(row => noKeepallRow(row, lineCounts)),
  };
}

/** One shipped reading under the no-keepall grammar, row by row. */
function noKeepallRow(
  row: Jsonl20RowResult,
  lineCounts: ReadonlyMap<number, number>,
): Jsonl20RowResult {
  if (row.status !== "answered") return row;
  if (row.answer.action === "keepall") {
    return refused(row.index, "action-not-in-grammar");
  }
  if (row.answer.action !== "keeplines") return row;
  // `readJsonl20Answer` already demanded this count for a keeplines row, so a
  // missing one here is the same caller bug, named the same way.
  const total = lineCounts.get(row.index);
  if (total === undefined) {
    throw new RangeError(`the jsonl-20 reader needs index ${String(row.index)}'s line count`);
  }
  const normalized = normalizeTwoVerdictAnswer(row.answer, total);
  return normalized.status === "answered"
    ? { index: row.index, status: "answered", answer: normalized.answer }
    : refused(row.index, normalized.code);
}

/** One refusal row, carrying the fixed sentence for its code. */
function refused(index: number, code: Jsonl20RowRefusalCode): Jsonl20RowResult {
  return { index, status: "refused", code, message: jsonl20MessageOf(code) };
}

/** One refusal's sentence, for the run record's detail slot. */
export function jsonl20MessageOf(code: Jsonl20RefusalCode): string {
  if (code === "answer-unreadable") {
    // One sentence for both uses: a single line that would not read as one JSON
    // object (ISSUE-187), and the whole-answer case, where every row says it.
    return "A line is not one JSON object; the row is kept.";
  }
  if (code === "unknown-index") return "That index was not assigned by this ask; no row is affected.";
  if (code === "duplicate-index") return "That index appears more than once; the row is kept.";
  if (code === "missing-index") return "No verdict was given for that index; the row is kept.";
  if (code === "malformed-row") {
    return "The forgetall flag is not exactly true; the row is kept.";
  }
  if (code === "mixed-keys") {
    return "The verdict carried more than one action key or an extra key; the row is kept.";
  }
  if (code === "both-forgotten-and-summary") {
    return "The verdict carried both forgotten and summary; the row is kept.";
  }
  if (code === "summary-missing") {
    return "The verdict forgot without a forgotten value (legacy summary is accepted); the row is kept.";
  }
  if (code === "summary-too-long") {
    return `The forgotten value runs past ${String(JSONL_20_SUMMARY_WORDS)} words; the row is kept.`;
  }
  if (code === "bad-range") {
    return "keeplines is not an array of positive [start,end] integer pairs; the row is kept.";
  }
  if (code === "ranges-unordered") {
    return "keeplines ranges are not strictly ascending and non-overlapping; the row is kept.";
  }
  if (code === "spans-outside-result") {
    return "keeplines names a line past that row's own line count; the row is kept.";
  }
  return "The verdict used an action this grammar does not offer; the row is kept.";
}

/** A canonical row index: a positive decimal string, never "01" or "1.5". */
function decimalIndexOf(key: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * The first top-level key a line that does not parse still spells, e.g.
 * `{"2":{"keepall":true}` reads `"2"`. Only an unescaped simple key can be a
 * canonical index, so the match needs no unescaping; every other shape returns
 * null and the line names no row.
 */
function leadingKeyOf(line: string): string | null {
  const match = /^\{\s*"([^"\\]*)"/u.exec(line);
  return match?.[1] ?? null;
}

/**
 * The assigned row indices this line's top-level keys repeat. `JSON.parse` keeps
 * only the last value of a repeated key, so the raw text is the only witness.
 * The line already parsed as one JSON object; `null` from the scanner means its
 * member structure could not be followed, and then no duplicate is claimed (the
 * parsed object stays authoritative). Keys are decoded with `JSON.parse`, so an
 * escaped spelling and its literal are one key.
 */
function repeatedAssignedIndexes(line: string, assigned: ReadonlySet<number>): readonly number[] {
  const keys = topLevelKeysOf(line);
  if (keys === null) return [];
  const seen = new Set<string>();
  const repeated = new Set<number>();
  for (const key of keys) {
    if (seen.has(key)) {
      const index = decimalIndexOf(key);
      if (index !== null && assigned.has(index)) repeated.add(index);
    } else {
      seen.add(key);
    }
  }
  return [...repeated];
}

/**
 * The top-level keys a JSON object line spells, in source order including
 * repeats. Values are skipped structurally (strings, escapes and nested
 * brackets), so a key inside a value is never read as a member. `null` means the
 * text is not one object whose members could all be followed.
 */
function topLevelKeysOf(line: string): readonly string[] | null {
  let at = skipSpace(line, 0);
  if (line[at] !== "{") return null;
  at = skipSpace(line, at + 1);
  const keys: string[] = [];
  if (line[at] === "}") return skipSpace(line, at + 1) === line.length ? keys : null;
  while (at < line.length) {
    if (line[at] !== '"') return null;
    const end = stringEnd(line, at);
    if (end < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(line.slice(at, end));
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    keys.push(key);
    at = skipSpace(line, end);
    if (line[at] !== ":") return null;
    at = skipValue(line, skipSpace(line, at + 1));
    if (at < 0) return null;
    at = skipSpace(line, at);
    if (line[at] === ",") {
      at = skipSpace(line, at + 1);
      continue;
    }
    if (line[at] !== "}") return null;
    return skipSpace(line, at + 1) === line.length ? keys : null;
  }
  return null;
}

/** The index after whitespace from `at`. */
function skipSpace(text: string, at: number): number {
  let cursor = at;
  while (cursor < text.length && /\s/u.test(text[cursor] as string)) cursor += 1;
  return cursor;
}

/** The index just past the JSON string starting at `at`, or -1 when unterminated. */
function stringEnd(text: string, at: number): number {
  let cursor = at + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === '"') return cursor + 1;
    cursor += 1;
  }
  return -1;
}

/** The index just past the JSON value starting at `at`, or -1. */
function skipValue(text: string, at: number): number {
  const head = text[at];
  if (head === '"') return stringEnd(text, at);
  if (head === "{" || head === "[") {
    let depth = 0;
    let cursor = at;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === '"') {
        const end = stringEnd(text, cursor);
        if (end < 0) return -1;
        cursor = end;
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
    return -1;
  }
  let cursor = at;
  while (cursor < text.length && text[cursor] !== "," && text[cursor] !== "}"
    && text[cursor] !== "]") cursor += 1;
  return cursor;
}

/**
 * One line's verdict. `mixed-keys` is any second action key or any key other
 * than the action and `forgotten` (legacy alias `summary`); `action-not-in-grammar`
 * is no action key at
 * all, an action this grammar does not offer, or a `keepall` that is not
 * exactly `true`; `malformed-row` is a `forgetall` that is not exactly `true`.
 * Keys are matched through `normalizeActionKey`, and the payload is read from
 * the key's own raw spelling.
 */
function readingOfValue(
  value: unknown,
  lineCounts: ReadonlyMap<number, number>,
  index: number,
): { readonly answer: EntryAnswer } | { readonly code: Jsonl20RowRefusalCode } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { code: "action-not-in-grammar" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  // A key that names an action in any case, singular or plural, is an action
  // key. `summary` is not one and is never normalized.
  const actionKeys = keys.filter(key => normalizeActionKey(key) !== null);
  if (actionKeys.length === 0) return { code: "action-not-in-grammar" };
  // Two action keys stay two keys even when they normalize to one action.
  if (actionKeys.length > 1) return { code: "mixed-keys" };
  const rawAction = actionKeys[0];
  if (rawAction === undefined) return { code: "action-not-in-grammar" };
  const action = normalizeActionKey(rawAction);
  if (action === null || !JSONL_20_ACTIONS.includes(action)) {
    return { code: "action-not-in-grammar" };
  }
  if (keys.some(key => key !== rawAction && key !== "forgotten" && key !== "summary")) {
    return { code: "mixed-keys" };
  }
  const descriptors = keys.filter(key => key === "forgotten" || key === "summary");
  if (descriptors.length > 1) return { code: "both-forgotten-and-summary" };
  const payload = record[rawAction];
  if (action === "keepall") {
    if (keys.length !== 1) return { code: "mixed-keys" };
    return payload === true
      ? { answer: { action: "keepall" } }
      : { code: "action-not-in-grammar" };
  }
  if (action === "forgetall" && payload !== true) return { code: "malformed-row" };
  // `forgotten` is the canonical wire key; `summary` is the legacy alias.
  const summary = record["forgotten"] ?? record["summary"];
  if (typeof summary !== "string") return { code: "summary-missing" };
  if (descriptorWordCount(summary) > JSONL_20_SUMMARY_WORDS) {
    return { code: "summary-too-long" };
  }
  if (action === "forgetall") return { answer: { action: "forgetall", summary } };
  return readingOfKeeps(payload, summary, lineCounts, index);
}

/**
 * `keeplines`' payload: pairs of positive integers, strictly ascending and
 * non-overlapping, each inside 1..L. Shape and type are `bad-range`, a bound
 * past L is `spans-outside-result`, and order or overlap is `ranges-unordered`.
 * An all-lines pair is legal: it keeps the whole row. A row whose count the ask
 * tabled as `[0 lines]` (a zero, a negative or a non-integer) has no span inside
 * `1..0`, so it is `spans-outside-result` and keeps (ISSUE-562).
 */
function readingOfKeeps(
  payload: unknown,
  summary: string,
  lineCounts: ReadonlyMap<number, number>,
  index: number,
): { readonly answer: EntryAnswer } | { readonly code: Jsonl20RowRefusalCode } {
  if (!Array.isArray(payload) || payload.length === 0) return { code: "bad-range" };
  const pairs: { readonly from: number; readonly to: number }[] = [];
  for (const pair of payload) {
    if (!Array.isArray(pair) || pair.length !== 2) return { code: "bad-range" };
    const from: unknown = pair[0];
    const to: unknown = pair[1];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return { code: "bad-range" };
    if ((from as number) < 1 || (to as number) < (from as number)) return { code: "bad-range" };
    pairs.push({ from: from as number, to: to as number });
  }
  const total = lineCountOf(lineCounts, index);
  // A count the ask tabled as `[0 lines]` proves no span: nothing lies inside
  // `1..0`, so this row refuses and keeps, never ends the whole answer
  // (ISSUE-562).
  if (!Number.isSafeInteger(total) || total < 1) return { code: "spans-outside-result" };
  for (const pair of pairs) {
    if (pair.from > total || pair.to > total) return { code: "spans-outside-result" };
  }
  for (let at = 1; at < pairs.length; at += 1) {
    const previous = pairs[at - 1];
    const current = pairs[at];
    if (previous !== undefined && current !== undefined && current.from <= previous.to) {
      return { code: "ranges-unordered" };
    }
  }
  return { answer: { action: "keeplines", ranges: pairs, summary } };
}

/**
 * One row's L, or a caller bug: a row with NO count at all throws, because the
 * reader never guesses a count. A count that is present but unprovable — a
 * zero, a negative from an inverted `lineRange`, or a non-integer — is NOT a
 * missing one: the ask tabled that row as `[0 lines]` (ISSUE-334, ISSUE-369), so
 * `readingOfKeeps` refuses the row instead of ending the whole answer
 * (ISSUE-562).
 */
function lineCountOf(lineCounts: ReadonlyMap<number, number>, index: number): number {
  const total = lineCounts.get(index);
  if (total === undefined) {
    throw new RangeError(`the jsonl-20 reader needs index ${String(index)}'s line count`);
  }
  return total;
}
