/**
 * The entry seam's batched ask (ISSUE-117 chunk B2; ADR-0035 §4–§5).
 *
 * One result, one ask is today's cadence. A batch asks N results in ONE message:
 * one contract, one index-keyed row per result, one closing line — so the model
 * answers N results under one turn, and each row's answer still applies as its
 * own removal on the entry seam. This module owns that message's bytes and the
 * reading of its answer, and nothing else: the trigger is `./batch-trigger.ts`,
 * the fork and the applies are the mount's.
 *
 * Both halves are the table ask's own, reused rather than restated:
 *
 * - the rows are `renderPruneAskRows` (`../prune/ask-message.js`), so a batched
 *   row reads exactly as a prune table's row: `index. [call] (call #n) — quotes`;
 * - the answer is `parsePruneAnswer` (`../prune/ask-answer.js`), which already
 *   refuses a missing, duplicated, unknown or malformed row per index and means
 *   KEEP for every one of them. One small adapter below maps its `WireAnswer`
 *   back onto the entry lane's `EntryAnswer`. Nothing under `prune/` is edited.
 *
 * The copy is ISSUE-110's owner-approved table text, unchanged (ADR-0035 §4: a
 * copy change is that ticket's, not this one's). The message ends on
 * `ENTRY_ASK_CLOSING_LINE`, not the table's final line, so the rig's end anchor
 * still classifies it as an entry ask.
 *
 * A batch of ONE is not a table: it is `entryAskMessage`'s bytes, byte for byte
 * (ADR-0035 §Consequences — the default-off gate). At `entryAskBatchSize` absent
 * or 1 every fire is a one-row batch, so the ask stream cannot move unless this
 * equality holds; the one-row path therefore delegates instead of re-deriving.
 *
 * ISSUE-129 adds the grammar. `3option` (the original contract, still selectable)
 * is everything above, byte for byte. `two-option` ships the other contract — no
 * line-level option — and reads answers under it: a row that names lines is
 * refused `action-not-in-grammar` and keeps. No range can be wrong on that
 * grammar, so the arithmetic refusal (and its one correction turn) is
 * unreachable; the one-row delegation is `3option`'s alone, because `jsonl-20`
 * is the default and every other grammar's one-row message is the table-row
 * shape (`sim-batch-grammar.mjs:190-208`).
 *
 * ISSUE-183 adds `jsonl-20` (ADR-0040): one JSON object per row per line, and
 * the owner ruling of 2026-11-05 makes it the default grammar. Its ask is the
 * sim's three-piece layout — the pre-table prompt, the rendered table with each
 * row's `[N line(s)]` count, then the post-table repeat — and its reading is
 * `./jsonl-20-answer.ts`. The count suffix is this grammar's alone; the splice
 * is a function replacement so a table carrying `$&` or `` $` `` lands literally
 * (ISSUE-172).
 *
 * ISSUE-508 makes this message the BULK table's too: the dsh depth table sends
 * `entryBatchAskMessage(rows, "jsonl-20-nokeepall", firstTrigger)` byte for byte
 * (`packages/adapters/dsh/src/judge-tables.ts`). Its row therefore accepts the
 * prune renderer's two extra facts — the call's `path` and a refused anchor's
 * `refusal` — so the bulk row reads exactly as a prune row always did.
 *
 * Pure and deterministic: same rows, same bytes, no I/O, nothing mutated. Only
 * invalid options throw, because those are caller bugs, not answer data.
 */

import type { PruneAnchorRefusal, PruneAnchorResult } from "../prune/anchor.js";
import { renderPruneAskRows } from "../prune/ask-message.js";
import type { PruneAskRow } from "../prune/ask-message.js";
import { parsePruneAnswer } from "../prune/ask-answer.js";
import type { PruneAnswerRefusalCode } from "../prune/ask-answer.js";
import { normalizeTwoVerdictAnswer } from "../prune/two-verdict.js";
import {
  ENTRY_ASK_CLOSING_LINE, entryAskMessage, PRUNE_ASK_JSONL_20_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_JSONL_20_REPEAT,
  PRUNE_ASK_JSONL_20_SLOT, PRUNE_ASK_JSONL_20_SYSTEM_PROMPT,
  PRUNE_ASK_SYSTEM_PROMPT, PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT,
} from "../rules/assets.js";
import { readJsonl20Answer, readJsonl20NoKeepallAnswer } from "./jsonl-20-answer.js";
import type { Jsonl20RowRefusalCode } from "./jsonl-20-answer.js";
import type { EntryAskGrammar } from "../config.js";
import type { EntryAnswer } from "../verdicts/entry-wire.js";
import type { WireAnswer, WireStamp, WireVerdictErrorCode } from "../verdicts/wire.js";
import type { ProcessingUnit } from "../units/types.js";

/** The shipped grammar: an absent config value resolves to this one (owner ruling
 * 2026-11-05). `3option` and `two-option` stay selectable by name. */
export const DEFAULT_ENTRY_ASK_GRAMMAR: EntryAskGrammar = "jsonl-20";

/**
 * The refusal a row earns when it answers an action the selected grammar does
 * not offer (ISSUE-129). It sits above the table reader's parse codes, which
 * stay exactly as they are; like every refusal, it means KEEP for that row.
 */
export const ENTRY_ASK_GRAMMAR_REFUSAL_CODE = "action-not-in-grammar";

/** Why one assigned index produced no verdict on this grammar. Every one keeps. */
export type EntryBatchRefusalCode =
  | PruneAnswerRefusalCode
  | typeof ENTRY_ASK_GRAMMAR_REFUSAL_CODE
  | Jsonl20RowRefusalCode;

/** One row of a batch ask: the address, the call that made it, its quotes. */
export interface EntryBatchRow {
  /** 1-based, assigned by the mount over the batch's rows; the answer's key. */
  readonly index: number;
  /**
   * The call that made this result, as the mount names it — the host's tool name
   * and its target, e.g. `Read config.ts`. It rides the row's `[kind]` slot, so
   * it is collapsed to one line by the renderer exactly as a table row's is.
   */
  readonly call: string;
  /**
   * The call's target, when the caller knows one. The bulk table's rows carry
   * their target here, so a row the prune pass asks reads exactly as the prune
   * renderer writes it (`[Read] config.ts`). Absent leaves the row pathless, the
   * entry lane's own shape.
   */
  readonly path?: string;
  /** The quotes from the unit's own lines, rendered by the anchor subsystem. */
  readonly anchorLines: readonly string[];
  /**
   * Why the row has no quotes (a refused prune anchor). When present the row
   * renders the refusal note instead of an anchor list, never an empty one that
   * would read as "no anchor needed".
   */
  readonly anchorRefusal?: PruneAnchorRefusal;
  /**
   * The occurrence ordinal of this row's whole call (same kind and path), when
   * the caller already computed one. The bulk table's rows carry the pass's own
   * `anchor.callOrdinal`, so a row reads the same ordinal in every message of a
   * pass — including a carried re-ask. Absent numbers the row by its own
   * `call`/`path` within this message, the entry lane's convention.
   */
  readonly callOrdinal?: number;
  /**
   * The result's line count `N`. Required when this row's message states it:
   * the batch's ONLY row under `3option` (today's `entryAskMessage` names `N`),
   * and EVERY row under `jsonl-20` and `jsonl-20-nokeepall` (the table shows
   * each row's `L`, and the reader checks a `keeplines` bound against it). The
   * other table grammars do not read it.
   */
  readonly lineCount?: number;
}

/** One row's reading: the entry answer to apply, or the refusal that keeps it. */
export type EntryBatchRowResult =
  | { readonly index: number; readonly status: "answered"; readonly answer: EntryAnswer }
  | {
    readonly index: number;
    readonly status: "refused";
    readonly code: EntryBatchRefusalCode;
    /**
     * The wire parser's own code when this row was malformed, else null. It is
     * the coarse `malformed-row` code's inner defect, carried out of
     * `parsePruneAnswer` so a journal row can name it (ISSUE-179).
     */
    readonly wireCode?: WireVerdictErrorCode | null;
  };

/**
 * The one user message a batch ask appends: the contract its grammar states, the
 * rows in index order, then the entry seam's closing line. `jsonl-20` (the
 * default) is its own three-piece layout and every row line carries its line
 * count. Under `3option`, one row is today's single ask verbatim, so a batch
 * size of 1 ships the bytes it shipped before; under `two-option` a one-row
 * batch is the table shape, because the prose shape is `3option`'s alone.
 *
 * `firstTrigger` selects the `jsonl-20` share line (ISSUE-194): `true` — the
 * default, and the session's first entry ask — states the 70 percent keep
 * target; `false` states 40 percent for every later ask. The same variant
 * appears in the pre-table prompt and the post-table repeat of that one
 * message. No other grammar reads it: their contracts have no per-fire line,
 * so their bytes are unchanged whichever way the flag is passed.
 */
export function entryBatchAskMessage(
  rows: readonly EntryBatchRow[],
  grammar: EntryAskGrammar = DEFAULT_ENTRY_ASK_GRAMMAR,
  firstTrigger = true,
): string {
  const checked = checkedRows(rows);
  const checkedGrammar = checkedGrammarOf(grammar);
  if (checkedGrammar === "jsonl-20" || checkedGrammar === "jsonl-20-nokeepall") {
    return jsonl20Message(checked, firstTrigger, checkedGrammar);
  }
  const only = checked[0];
  if (checkedGrammar === "3option" && checked.length === 1 && only !== undefined) {
    return singleRowMessage(only);
  }
  const contract = checkedGrammar === "3option"
    ? PRUNE_ASK_SYSTEM_PROMPT : PRUNE_ASK_TWO_OPTION_SYSTEM_PROMPT;
  return `${contract}\n\n${renderPruneAskRows(rendererRows(checked))}`
    + `\n\n${ENTRY_ASK_CLOSING_LINE}`;
}

/**
 * The `jsonl-20` ask: the pre-table prompt with its slot replaced by the rows,
 * then the post-table repeat (ADR-0040). Every row line ends with that row's
 * ` [N line(s)]`, because the prompt's rule 5 makes a `keeplines` bound refer
 * to "L ... shown in the table". The replacement is a FUNCTION, never a string:
 * the table is transcript text, and a string replacement would expand `$&`,
 * `` $` ``, `$'` and `$$` in it (ISSUE-172).
 *
 * `jsonl-20-nokeepall` is the same three-piece layout with that grammar's two
 * halves: no `keepall` in the format or the example, and the whole row taught
 * as a full-range `keeplines` with summary `None`. The table renderer and its
 * per-row count are identical, so one reader can classify both.
 *
 * The share line follows the fire (ISSUE-194): both halves come from the same
 * variant, so one message never states the 70 percent target beside the 40
 * percent one.
 */
function jsonl20Message(
  rows: readonly EntryBatchRow[], firstTrigger: boolean, grammar: EntryAskGrammar,
): string {
  const noKeepall = grammar === "jsonl-20-nokeepall";
  const prompt = noKeepall
    ? (firstTrigger
      ? PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT
      : PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_SYSTEM_PROMPT)
    : (firstTrigger ? PRUNE_ASK_JSONL_20_SYSTEM_PROMPT : PRUNE_ASK_JSONL_20_LATER_SYSTEM_PROMPT);
  const repeat = noKeepall
    ? (firstTrigger
      ? PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT : PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT)
    : (firstTrigger ? PRUNE_ASK_JSONL_20_REPEAT : PRUNE_ASK_JSONL_20_LATER_REPEAT);
  if (!prompt.includes(PRUNE_ASK_JSONL_20_SLOT)) {
    throw new RangeError("the jsonl-20 prompt lost its table slot");
  }
  const rendered = renderPruneAskRows(rendererRows(rows)).split("\n");
  const table = rendered.map((line, at) => `${line}${lineCountLabelOf(rows[at])}`).join("\n");
  return `${prompt.replace(PRUNE_ASK_JSONL_20_SLOT, () => table)}`
    + `\n\n${repeat}`;
}

/**
 * The `[N line(s)]` suffix one `jsonl-20` row line carries. A missing count is a
 * caller bug, never a blank suffix: the prompt promises every row shows its L.
 * A present but unprovable count — the inverted-lineRange arithmetic (`< 1`), a
 * zero, or a non-integer — is fail-open like the prune renderer's uncountable
 * range (ISSUE-334, ISSUE-369): the row states `[0 lines]` and the batch builds
 * instead of one bad row aborting every row's ask.
 */
function lineCountLabelOf(row: EntryBatchRow | undefined): string {
  const count = row?.lineCount;
  if (count === undefined) {
    throw new RangeError(
      `the jsonl-20 table needs index ${String(row?.index)}'s line count`,
    );
  }
  if (!Number.isSafeInteger(count) || count < 1) return " [0 lines]";
  return ` [${String(count)} line${count === 1 ? "" : "s"}]`;
}

/**
 * Reads one batch answer into exactly one result per assigned index, ascending.
 *
 * Every refusal is that row's KEEP, and it never touches a neighbour: a missing
 * key, a duplicated key, a row the wire parser refuses and an unreadable answer
 * each refuse only the rows they reach. A key that addresses no assigned row is
 * dropped here — it can move no unit.
 *
 * Under `two-option` the reading adds one gate above the wire parser: a row that
 * answered `keeplines` or `forgetlines` names a shape this grammar does not
 * offer, so it becomes `action-not-in-grammar` and keeps. Nothing else moves.
 *
 * Under `jsonl-20` the reading is `readJsonl20Answer`, and `lineCounts` is the
 * per-row `L` its `keeplines` bounds are checked against. A missing count for a
 * `keeplines` row is a caller bug and throws; the other grammars ignore the map.
 *
 * `jsonl-20-nokeepall` reads through `readJsonl20NoKeepallAnswer`: a `keepall`
 * row is refused `action-not-in-grammar` and keeps, and a whole-range
 * `keeplines` comes back as a clean `keepall`. Under plain `jsonl-20` the same
 * whole-range normalization applies, so a row that names every line never
 * reaches the planner as a both-ends shape whatever summary it carried.
 */
export function parseEntryBatchAnswer(
  text: string,
  indices: readonly number[],
  grammar: EntryAskGrammar = DEFAULT_ENTRY_ASK_GRAMMAR,
  lineCounts: ReadonlyMap<number, number> = new Map(),
): readonly EntryBatchRowResult[] {
  const checkedGrammar = checkedGrammarOf(grammar);
  if (checkedGrammar === "jsonl-20" || checkedGrammar === "jsonl-20-nokeepall") {
    if (indices.length === 0) {
      throw new RangeError("A batch answer is read against at least one assigned index.");
    }
    const reading = checkedGrammar === "jsonl-20"
      ? readJsonl20Answer(text, indices, lineCounts)
      : readJsonl20NoKeepallAnswer(text, indices, lineCounts);
    return reading.rows.map((row): EntryBatchRowResult => row.status === "answered"
      ? { index: row.index, status: "answered",
        answer: jsonl20EntryAnswerOf(row.answer, checkedGrammar, row.index, lineCounts) }
      // The line reader named the defect at the top level, so there is no
      // separate wire code to carry.
      : { index: row.index, status: "refused", code: row.code, wireCode: null });
  }
  const parsed = parsePruneAnswer(text, { indices, stamps: stampsFor(indices) });
  const rows = parsed.rows.map((row): EntryBatchRowResult => row.status === "answered"
    ? { index: row.index, status: "answered", answer: entryAnswerOf(row.answer) }
    : { index: row.index, status: "refused", code: row.code, wireCode: row.wireCode });
  if (checkedGrammar === "3option") return rows;
  return rows.map((row): EntryBatchRowResult =>
    row.status === "answered" && !TWO_OPTION_ACTIONS.has(row.answer.action)
      // The wire parse succeeded and the grammar is what refuses this row, so
      // there is no inner defect to name.
      ? { index: row.index, status: "refused", code: ENTRY_ASK_GRAMMAR_REFUSAL_CODE,
        wireCode: null }
      : row);
}

/** The actions `two-option` admits: the whole result, or its summary. */
const TWO_OPTION_ACTIONS: ReadonlySet<EntryAnswer["action"]> = new Set([
  "keepall", "forgetall",
]);

/**
 * One `jsonl-20` row's answer with a whole-range keep spelled as `keepall`.
 * `normalizeTwoVerdictAnswer` is used only on the `keeplines` arm (its grammar
 * gate belongs to `jsonl-20-nokeepall`, whose reader already applied it), and a
 * `keeplines` row always carries its count because the line reader demanded it.
 * The note is not consulted: a whole-range keep is the whole range whatever the
 * model called it.
 */
function jsonl20EntryAnswerOf(
  answer: EntryAnswer,
  grammar: EntryAskGrammar,
  index: number,
  lineCounts: ReadonlyMap<number, number>,
): EntryAnswer {
  if (grammar !== "jsonl-20" || answer.action !== "keeplines") return answer;
  const total = lineCounts.get(index);
  if (total === undefined) {
    throw new RangeError(`the jsonl-20 reader needs index ${String(index)}'s line count`);
  }
  const normalized = normalizeTwoVerdictAnswer(answer, total);
  return normalized.status === "answered" ? normalized.answer : answer;
}

/**
 * The grammar's canonical id, or a `RangeError` when the caller names another.
 * The parameter is typed, so only a JS caller (a rig, a bench, a config file) can
 * reach this refusal; a typo is never a silent fallback to the shipped contract.
 */
function checkedGrammarOf(grammar: string): EntryAskGrammar {
  if (grammar !== "3option" && grammar !== "two-option" && grammar !== "jsonl-20"
    && grammar !== "jsonl-20-nokeepall") {
    throw new RangeError(
      `An entry ask grammar is "3option", "two-option", "jsonl-20" or "jsonl-20-nokeepall", got ${String(grammar)}.`,
    );
  }
  return grammar;
}

/**
 * The stamps the table reader demands. Identity on this seam is the index the
 * ask assigned — the answer never carries a unit id — so the stamp's unit id is
 * the index itself and the round is the constant one the reader requires; the
 * reader only checks that both exist, and neither survives into a result.
 */
const ENTRY_BATCH_ROUND = 1;

function stampsFor(indices: readonly number[]): ReadonlyMap<number, WireStamp> {
  return new Map(indices.map(index => [index,
    { unitId: `entry-batch-row:${String(index)}`, answeredInRound: ENTRY_BATCH_ROUND }]));
}

/** The wire answer's verdict as the entry lane's own answer, losslessly. */
function entryAnswerOf(answer: WireAnswer): EntryAnswer {
  const verdict = answer.verdict;
  switch (verdict.action) {
    case "keepall":
      return { action: "keepall" };
    case "keeplines":
      return {
        action: "keeplines",
        ranges: verdict.ranges,
        summary: answer.keeplinesSummary ?? "",
      };
    case "forgetlines":
      return {
        action: "forgetlines",
        ranges: verdict.ranges,
        summary: answer.forgetlinesSummary ?? "",
      };
    case "forgetall":
      return { action: "forgetall", summary: verdict.summary ?? "" };
  }
}

/**
 * The lone row's message: today's ask, unchanged. It states `N` and the quotes
 * and renders no row line, because the result already landed above the ask —
 * the table's row format is what a batch ADDS, and a batch of one must not.
 */
function singleRowMessage(row: EntryBatchRow): string {
  if (row.lineCount === undefined) {
    throw new RangeError("A one-row batch ask needs the row's lineCount: its message states N.");
  }
  return entryAskMessage({ lineCount: row.lineCount, anchorLines: row.anchorLines });
}

/** The rows in index order, one address per index; a caller bug otherwise. */
function checkedRows(rows: readonly EntryBatchRow[]): readonly EntryBatchRow[] {
  if (rows.length === 0) throw new RangeError("A batch ask renders at least one row.");
  const seen = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.index) || row.index < 1) {
      throw new RangeError("Every batch row's index must be a positive safe integer.");
    }
    if (seen.has(row.index)) {
      throw new RangeError(`A batch ask names index ${String(row.index)} twice.`);
    }
    seen.add(row.index);
  }
  return [...rows].sort((left, right) => left.index - right.index);
}

/**
 * The table renderer's own row shape, built from the batch's data. `call` rides
 * the `[kind]` slot so the row reads "1. [Read] config.ts (call #1) — …" and no
 * row grammar is restated here.
 *
 * The ordinal is the row's own `callOrdinal` when the caller computed one (the
 * bulk table passes the pass's `assignCallOrdinals` value), so one unit keeps
 * its number across every message of a pass, carried re-asks included. Absent,
 * this message numbers identical calls — same kind AND same target, the same
 * key `assignCallOrdinals` uses — 1, 2, 3… in row order.
 */
function rendererRows(rows: readonly EntryBatchRow[]): readonly PruneAskRow[] {
  const counts = new Map<string, number>();
  return rows.map(row => {
    const key = `${row.call}\u0000${row.path ?? ''}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return {
      index: row.index,
      // The renderer reads `anchor` alone; `unit` is the table's carry key and
      // never leaves this module, so the slot holds a placeholder of its shape.
      unit: placeholderUnit(row.index),
      anchor: anchorOf(row, row.callOrdinal ?? next),
    };
  });
}

/** The row's anchor, exactly as the prune renderer writes it (refusal included). */
function anchorOf(row: EntryBatchRow, ordinal: number): PruneAnchorResult {
  const head = row.path === undefined
    ? { kind: row.call, callOrdinal: ordinal }
    : { kind: row.call, path: row.path, callOrdinal: ordinal };
  return row.anchorRefusal === undefined
    ? { ...head, anchors: [...row.anchorLines] }
    : { ...head, refusal: row.anchorRefusal };
}

/** A unit-shaped hole for `renderPruneAskRows`, which never reads it. */
function placeholderUnit(index: number): ProcessingUnit {
  return {
    id: `entry-batch-row:${String(index)}`,
    nodeId: "",
    source: { nodeId: "", sha256: "", byteLength: 0 },
    path: null,
    span: { byteRange: { startByte: 0, endByteExclusive: 0 }, lineRange: null },
    byteLength: 0,
  };
}
