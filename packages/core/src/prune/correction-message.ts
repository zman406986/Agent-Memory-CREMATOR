/**
 * The big prune's ONE correction turn (ISSUE-113; ADR-0009's table ask).
 *
 * A table answer that refused some rows is re-asked once, in a reduced table of
 * those rows only, as a new turn appended to the same fork. This module owns
 * that turn's bytes, and nothing else: the scheduling is the adapter's table
 * loop (`packages/adapters/dsh/src/judge-tables.ts`), the per-index reading is
 * `./ask-answer.ts`, and the row renderer is `./ask-message.ts`.
 *
 * The message is the owner-approved text (ISSUE-113, 2026-10-29), with only its
 * marked slots filled:
 *
 *   - the counts and the per-index reasons come from the graded answer;
 *   - the refused rows are re-rendered by the SAME anchor renderer the first
 *     table used, so a row reads identically in both turns and its index — the
 *     address — never changes;
 *   - the composite example is the approved STATIC one whenever no refused row
 *     carries its indices. A model that echoes its indices onto other rows
 *     earns `unknown key`, which refuses and keeps the unit. When a refused row
 *     IS one of the example's indices, a verbatim echo would parse as genuine
 *     verdicts for real rows (ISSUE-326), so the example is re-keyed past the
 *     table's last index: an echo then earns `out-of-range` rejections and
 *     every refused unit keeps.
 *   - the closing line is the table ask's own `PRUNE_ASK_FINAL_LINE`, reused as
 *     is: no new anchor token exists, and a rig that matches the table ask's
 *     end still recognises this turn. Under `nokeepall` (ISSUE-508, F3) the
 *     whole turn is that grammar instead — rows with their `[L line(s)]` and
 *     the one-object-per-row answer shapes, no share line — so one pass never
 *     speaks two grammars.
 *
 * Pure and deterministic: same input, same bytes, no I/O, nothing mutated. Only
 * invalid options throw, because those are caller bugs, not answer data.
 */

import type { PrunePlanGrammar } from "../config.js";
import type { PruneAnswerRefusalCode } from "./ask-answer.js";
import type { PruneAskRow } from "./ask-message.js";
import { isTwoVerdictGrammar, pruneAskFinalLineOf, renderPruneAskRows } from "./ask-message.js";

/**
 * The approved composite example: one real `keeplines` answer and one real
 * `forgetall` answer, keyed by the indices the approved text used. Static by
 * the owner's allowance; a copy onto other rows refuses as an unknown key and
 * the unit keeps. When a refused row carries one of these indices the example
 * is re-keyed by `compositeFor` (ISSUE-326), never shipped verbatim.
 */
export const PRUNE_CORRECTION_COMPOSITE =
  '{"3":{"keeplines":[[88,95],"the TODO block superseded by the later edit"]},'
  + '"5":{"forgetall":"a stale config grep"}}';

/**
 * The composite example for one correction turn (ISSUE-326). The approved
 * static bytes ship whenever no refused row carries the example's indices.
 * When one does, a verbatim echo would parse as genuine verdicts for real
 * rows, so the same two demo bodies are re-keyed past the table's last index:
 * the correction turn assigns only refused rows, so an echo's keys address no
 * unit and every refused unit keeps.
 */
function compositeFor(refused: readonly PruneAskRow[], totalRows: number): string {
  const example = JSON.parse(PRUNE_CORRECTION_COMPOSITE) as Record<string, unknown>;
  const keys = Object.keys(example);
  const refusedKeys = new Set(refused.map(row => String(row.index)));
  if (!keys.some(key => refusedKeys.has(key))) return PRUNE_CORRECTION_COMPOSITE;
  const rekeyed: Record<string, unknown> = {};
  for (const [at, key] of keys.entries()) {
    rekeyed[String(totalRows + 1 + at)] = example[key];
  }
  return JSON.stringify(rekeyed);
}

/**
 * The two policy sentences the correction restates, byte for byte the table
 * prompt's own opener (ISSUE-110) so the two turns cannot teach different
 * rules. Only the closing clause differs: the correction says "a missing,
 * unknown or repeated key refuses that unit" where the prompt adds "Answer
 * every index exactly once;" in front, because this turn answers a subset.
 */
const POLICY_LINE =
  "keeplines keeps the named ranges (1-based, counted on that unit's own lines); the rest is "
  + "replaced by a required summary, a few words, aim under 15, never over 25. forgetall replaces "
  + "the whole unit with its summary. A missing, unknown or repeated key refuses that unit, and a "
  + "refused unit keeps.";

/** One refused row as the message states it: its index and the parser's own code. */
export interface PruneCorrectionReason {
  readonly index: number;
  readonly code: PruneAnswerRefusalCode;
  /**
   * A finer code for the same refusal, when the reading lane has one. The
   * `jsonl-20` line reader names `mixed-keys`, `summary-missing`,
   * `summary-too-long`, `bad-range` and `ranges-unordered` where this closed
   * list says `malformed-row`; the clause states the finer defect so the model
   * is told what to fix (ISSUE-508, F4).
   */
  readonly detail?: string;
}

/** What the correction turn needs: the rows, the table it answers, and why. */
export interface PruneCorrectionInput {
  /** The rows being re-asked, in table order. Never empty. */
  readonly refused: readonly PruneAskRow[];
  /** The unit count of the table whose answer this turn corrects. */
  readonly totalRows: number;
  /** One entry per refused row; a missing entry is a caller bug. */
  readonly reasons: readonly PruneCorrectionReason[];
  /**
   * The grammar this correction restates. Absent is `3option`. A two-verdict
   * grammar re-renders each row with its `[L line(s)]` and states the
   * one-object-per-row answer shapes, so the correction speaks exactly the
   * grammar the table asked in (ISSUE-508).
   */
  readonly grammar?: PrunePlanGrammar;
}

/**
 * Why one index produced no verdict, in the approved phrasing. The per-index
 * codes name the index; the two whole-answer codes name the answer, because
 * every row of that table refused for the one reason. A `detail` the closed list
 * collapsed into `malformed-row` names the finer defect instead (F4).
 */
function reasonClause(code: PruneAnswerRefusalCode, index: number, detail?: string): string {
  const finer = detail === undefined ? null : detailClause(detail, index);
  if (finer !== null) return finer;
  switch (code) {
    case "missing-index":
      return `index ${String(index)} had no verdict`;
    case "duplicate-index":
      return `index ${String(index)} appeared twice`;
    case "malformed-row":
      return `index ${String(index)} is not a readable verdict`;
    case "answer-not-an-object":
      return "the answer was not one JSON object";
    case "answer-unreadable":
      return "the answer was not readable JSON";
    case "action-not-in-grammar":
      return `index ${String(index)} used an action this grammar does not offer`;
    case "spans-outside-result":
      return `index ${String(index)} named a line outside its own line count`;
    default:
      // Every code has a clause above; an added code refuses rather than
      // printing nothing, because a silent slot is a message with a hole in it.
      return `index ${String(index)} was not answered`;
  }
}

/** The `jsonl-20` line reader's finer codes, as correction clauses. */
function detailClause(detail: string, index: number): string | null {
  if (detail === "mixed-keys") {
    return `index ${String(index)} carried more than one action key or an extra key`;
  }
  if (detail === "summary-missing") {
    return `index ${String(index)} forgot without a summary`;
  }
  if (detail === "summary-too-long") {
    return `index ${String(index)} carried a summary past 30 words`;
  }
  if (detail === "bad-range") {
    return `index ${String(index)} carried malformed keeplines ranges`;
  }
  if (detail === "ranges-unordered") {
    return `index ${String(index)} carried keeplines ranges out of order`;
  }
  return null;
}

/**
 * The two answer shapes the line-per-row correction restates. They are the
 * table contract's own shapes (`jsonl-20`: one object per row on its own line,
 * one action key, sibling `summary`), keyed `N` because this turn accepts only
 * the rows above. The share line is the table ask's; a correction re-asks rows
 * already refused, so it states no target of its own.
 */
const JSONL_CORRECTION_ANSWER = [
  "Answer again, once, with one JSON object per row on its own line, same indices, nothing else:",
  "",
  '{"N":{"forgetall":true,"summary":"<summary>"}}',
  '{"N":{"keeplines":[[start,end], ...],"summary":"<summary>"}}',
].join("\n");

/**
 * The one correction turn. The counts, the reasons, the refused rows, the
 * composite and the closing line are the whole message: it never restates the
 * fork's history, never re-asks an accepted row, and never asks the keep-or-
 * forget question again for a unit that answered.
 *
 * One grammar per pass (ISSUE-508, F3): under `nokeepall` the turn is the SAME
 * line-per-row grammar the table asked in — the refused rows with their `[L
 * line(s)]`, then the one-object-per-row answer shapes — and its reply is read
 * by `readJsonl20NoKeepallAnswer`. The `3option` bytes are unchanged.
 */
export function pruneCorrectionMessage(input: PruneCorrectionInput): string {
  const { refused, totalRows, reasons } = input;
  const grammar = input.grammar ?? "3option";
  if (refused.length === 0) {
    throw new RangeError("A correction turn asks at least one refused row.");
  }
  if (!Number.isSafeInteger(totalRows) || totalRows < refused.length) {
    throw new RangeError("totalRows must be a safe integer at least the refused row count.");
  }
  const byIndex = new Map(reasons.map(reason => [reason.index, reason] as const));
  const clauses: string[] = [];
  for (const row of refused) {
    const reason = byIndex.get(row.index);
    if (reason === undefined) {
      throw new RangeError(`No refusal reason for refused index ${String(row.index)}.`);
    }
    const clause = reasonClause(reason.code, row.index, reason.detail);
    // A whole-answer code yields the same clause for every row of that table;
    // stating it once is the approved phrasing ("the answer was not one JSON
    // object"), not five repetitions of it.
    if (clauses[clauses.length - 1] !== clause) clauses.push(clause);
  }
  const opening = `Your previous answer could not be applied for ${String(refused.length)} of `
    + `${String(totalRows)} rows: ${clauses.join("; ")}. Those units are kept so far. This turn `
    + "asks those rows only; the rows you answered are accepted — do not answer them again.";
  if (isTwoVerdictGrammar(grammar)) {
    return [
      opening,
      "",
      renderPruneAskRows(refused, { grammar }),
      "",
      JSONL_CORRECTION_ANSWER,
    ].join("\n");
  }
  return [
    opening,
    "",
    renderPruneAskRows(refused, { grammar }),
    "",
    "Answer again, once, with exactly one JSON object, one key per row above, same indices:",
    "",
    compositeFor(refused, totalRows),
    "",
    POLICY_LINE,
    "",
    `Answer with one JSON object for the rows above and nothing else. ${pruneAskFinalLineOf(grammar)}`,
  ].join("\n");
}
