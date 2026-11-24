/**
 * The bytes and the slicing of one L2 table ask: its rows, its display table,
 * the unit-sized table builder and its two renderers (ISSUE-022 chunk 1;
 * ADR-0009).
 *
 * One ask addresses every unit still in memory, by an index we assign. Here are
 * the row and table renderers and the builder that hands a pass its next
 * contiguous slice of rows. The ask's own composition lives in the adapter
 * (ISSUE-027): a prune ask is a fork of main's sent wire state, so the contract
 * rides inside an appended user turn and the system slot is never replaced.
 * `PRUNE_ASK_SYSTEM_PROMPT`, `PRUNE_ASK_FINAL_LINE` and `renderPruneAskTable`
 * are the bytes that turn carries. The pass's indexing — assigning those indices
 * and building each row's anchor — is `./ask.ts`, which re-exports every name
 * here, so `prune/ask.js` remains the one import site. Reading the answer is
 * `./ask-answer.ts`.
 *
 * A table is sized in UNITS, never bytes or tokens, and there is no row cap
 * (the 12-row cap of ADR-0009 §Amendment 2026-10-24 was removed by the
 * 2026-11-16 owner ruling recorded in ADR-0060 §Amendment). `nextTable` returns
 * the whole queue — carried re-asks first — and never cuts or omits a row, so a
 * huge row rides in its table.
 *
 * Pure and deterministic: same input, same bytes, no I/O, nothing mutated. Only
 * invalid options throw, because those are caller bugs, not transcript data.
 */

import type { PrunePlanGrammar } from "../config.js";
import {
  KEEP_WHOLE_SUMMARY, oneLine, PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT,
  PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT, PRUNE_ASK_SYSTEM_PROMPT,
} from "../rules/assets.js";
import type { ProcessingUnit } from "../units/types.js";
import type { PruneCarryEntry } from "./ask-carry.js";
import { isRefusedPruneAnchor } from "./anchor.js";
import type { PruneAnchorResult } from "./anchor.js";

/** The line that opens the table inside the user message. */
export const PRUNE_ASK_TABLE_HEADING =
  "Units still in memory, by assigned index. Each row begins with the index you answer with and "
  + "names two lines of that unit's content by number.";

/**
 * The instruction that ends every ask's user message, as one line. It states the
 * exact expected JSON shape verbatim, in the same bytes the system prompt uses,
 * so a test can pin one string for the whole batch contract.
 */
export const PRUNE_ASK_FINAL_LINE =
  "Answer with one JSON object that maps every index above to its verdict, one entry per index: "
  + '{"1":{"keepall":true},"2":{"forgetall":"…"}}';

/**
 * The final line of the `nokeepall` table ask: the same instruction, with the
 * two verdicts that grammar offers and a full-range `keeplines` as the
 * keep-whole shape. `keepall` is absent from these bytes.
 */
export const PRUNE_ASK_NOKEEPALL_FINAL_LINE =
  "Answer with one JSON object that maps every index above to its verdict, one entry per index: "
  + `{"1":{"forgetall":"…"},"2":{"keeplines":[[1,3],"${KEEP_WHOLE_SUMMARY}"]}}`;

/** One indexed row of a pass: the address, the unit and its anchor. */
export interface PruneAskRow {
  /** 1-based, assigned over the pass's L1-kept list in transcript order. */
  readonly index: number;
  readonly unit: ProcessingUnit;
  readonly anchor: PruneAnchorResult;
}

/** Options for `nextTable`; production passes none. */
export interface NextTableOptions {
  /** Rows the carry scheduler settled: they lead the table. */
  readonly carried?: readonly PruneCarryEntry[];
}

/** One ask table: the rows it addresses, carried re-asks first. */
export interface PruneAskTable {
  readonly rows: readonly PruneAskRow[];
  /** Leading rows that are carried re-asks; `rows.length - carried` are fresh. */
  readonly carried: number;
}

/**
 * The one table of a pass: carried rows first, then the WHOLE queue. There is no
 * unit limit (the 12-row cap of ADR-0009 §Amendment 2026-10-24 was removed by
 * the 2026-11-16 owner ruling recorded in ADR-0060 §Amendment). Nothing here
 * measures bytes or tokens, and no row is ever cut or singled out: an oversized
 * row rides in its table whole.
 *
 * The queue is left untouched; the caller drops exactly the fresh rows the table
 * took (`rows.length - carried`) and asks again. Same input, same table, always.
 */
export function nextTable(
  queue: readonly PruneAskRow[],
  options: NextTableOptions = {},
): PruneAskTable {
  const carried = options.carried ?? [];
  const rows = [
    ...carried.map(entry => entry.row),
    ...queue,
  ];
  // One address per row: a carried row still in the queue would give its unit
  // two places in one table, and an answer could then move the wrong bytes.
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.index)) {
      throw new RangeError(`A prune ask table names index ${String(row.index)} twice.`);
    }
    seen.add(row.index);
  }
  return { rows, carried: carried.length };
}

/**
 * Whether a plan label names a two-verdict grammar (`forgetall` or
 * `keeplines`, no `keepall`) (ISSUE-522). Every grammar but `3option` is
 * two-verdict today, and this predicate is the ONE place that is decided, so a
 * future grammar id cannot silently become two-verdict by failing an inequality:
 * adding one to `PrunePlanGrammar` leaves it `false` here until this function
 * names it.
 */
export function isTwoVerdictGrammar(grammar: PrunePlanGrammar | undefined): boolean {
  return grammar === "nokeepall" || grammar === "jsonl-20-nokeepall";
}

/** Options for the table renderers; production passes none. */
export interface PruneAskRenderOptions {
  /**
   * The answer grammar whose row shape this table states. Absent is `3option`,
   * byte for byte. A two-verdict grammar appends each row's ` [L line(s)]`
   * (including `[0 lines]` for a zero-line unit), because its whole-range answer
   * must name the row's own L.
   */
  readonly grammar?: PrunePlanGrammar;
}

/** The table block as it ships: the heading, a blank line, then one row per unit. */
export function renderPruneAskTable(
  rows: readonly PruneAskRow[],
  heading: string = PRUNE_ASK_TABLE_HEADING,
  options: PruneAskRenderOptions = {},
): string {
  return `${heading}\n\n${renderPruneAskRows(rows, options)}`;
}

/**
 * One line per row, no heading: the rows alone. The correction turn
 * (`./correction-message.ts`) re-renders the refused rows through this, so a
 * re-asked row is the same bytes — same index, same anchor — as the row the
 * first table asked, and the model needs no second address scheme.
 *
 * `grammar` selects the row shape only. Under `nokeepall` every row ends with
 * its own line count, exactly as the `jsonl-20` entry table does; every other
 * grammar keeps the shipped bytes.
 */
export function renderPruneAskRows(
  rows: readonly PruneAskRow[],
  options: PruneAskRenderOptions = {},
): string {
  const grammar = checkedGrammar(options.grammar ?? "3option");
  return rows.map(row => renderPruneAskRow(row, grammar)).join("\n");
}

/**
 * One row: the assigned index, the whole call, the occurrence ordinal and the
 * unit's anchors, joined by one middle dot. A refused anchor names its refusal
 * instead — never an empty anchor list, which would read as a unit that needs
 * no anchor. A unit with no quotable line names none: the row ends at the call.
 *
 * An anchor never carries a newline, so a row stays one line per unit; `oneLine`
 * on the call facts is what keeps harness metadata from forging a row that
 * starts with an index we never wrote.
 */
function renderPruneAskRow(row: PruneAskRow, grammar: PrunePlanGrammar): string {
  const rendered = renderPruneAskRowCore(row);
  // Every two-verdict spelling states the row's own line count; `3option` alone
  // keeps the shipped bytes (ISSUE-522).
  return isTwoVerdictGrammar(grammar) ? `${rendered}${lineCountLabelOf(row.unit)}` : rendered;
}

function renderPruneAskRowCore(row: PruneAskRow): string {
  const anchor = row.anchor;
  const path = anchor.path === undefined ? "" : ` ${oneLine(anchor.path)}`;
  const head = `${String(row.index)}. [${oneLine(anchor.kind)}]${path} `
    + `(call #${String(anchor.callOrdinal)})`;
  if (isRefusedPruneAnchor(anchor)) return `${head} — anchor unavailable: ${anchor.refusal}`;
  if (anchor.anchors.length === 0) return head;
  return `${head} — ${anchor.anchors.join(" · ")}`;
}

/**
 * The `[L line(s)]` suffix one `nokeepall` row carries. A zero-line unit has no
 * line range, so it states its own count as `[0 line(s)]`: the opener promises
 * every row ends with one, and naming zero is the count the row actually holds.
 * A `keeplines` answer on it names no line inside `1..0`, so the gate refuses
 * it and the row keeps. An inverted or otherwise uncountable non-null range is
 * fail-open the same way (ISSUE-334), like a corrupt byteRange: the row states
 * `[0 lines]`, the pass's gate reads the count as 0, every `keeplines` on it is
 * refused `spans-outside-result`, and the unit keeps.
 */
function lineCountLabelOf(unit: ProcessingUnit): string {
  const range = unit.span.lineRange;
  if (range === null) return " [0 lines]";
  const count = range.endLineInclusive - range.startLine + 1;
  if (!Number.isSafeInteger(count) || count < 1) return " [0 lines]";
  return ` [${String(count)} line${count === 1 ? "" : "s"}]`;
}

/**
 * The contract a bulk prune ask states for one grammar: the two-verdict
 * `nokeepall` prompt by default (ADR-0056), the shipped three-way prompt when
 * `3option` is selected by name. `jsonl-20-nokeepall` names the ADR-0053 entry
 * asset — that label says the plan's prompt IS the entry message — never the
 * bulk `nokeepall` message (ISSUE-522). Exported so the table path selects its
 * prompt from the same grammar id its rows and its correction turn use, instead
 * of hard-coding the shipped bytes.
 */
export function pruneAskSystemPromptOf(grammar: PrunePlanGrammar = "nokeepall"): string {
  const checked = checkedGrammar(grammar);
  if (checked === "jsonl-20-nokeepall") return PRUNE_ASK_JSONL_20_NOKEEPALL_SYSTEM_PROMPT;
  return isTwoVerdictGrammar(checked) ? PRUNE_ASK_NOKEEPALL_SYSTEM_PROMPT : PRUNE_ASK_SYSTEM_PROMPT;
}

/**
 * The closing instruction a bulk prune ask (or its correction turn) states for
 * one grammar. Under a two-verdict grammar it names the two verdicts that
 * grammar offers; `3option` keeps the shipped line byte for byte. Absent is
 * `nokeepall`, the same default `pruneAskSystemPromptOf` and the pass state
 * (ADR-0056).
 */
export function pruneAskFinalLineOf(grammar: PrunePlanGrammar = "nokeepall"): string {
  return isTwoVerdictGrammar(checkedGrammar(grammar))
    ? PRUNE_ASK_NOKEEPALL_FINAL_LINE : PRUNE_ASK_FINAL_LINE;
}

/** The grammar's canonical id, or a `RangeError` for a JS caller's typo. */
function checkedGrammar(grammar: string): PrunePlanGrammar {
  if (grammar !== "3option" && grammar !== "nokeepall"
    && grammar !== "jsonl-20-nokeepall") {
    throw new RangeError(
      'A prune ask grammar is "3option", "nokeepall" or "jsonl-20-nokeepall", '
      + `got ${String(grammar)}.`,
    );
  }
  return grammar;
}
