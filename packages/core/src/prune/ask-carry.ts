/**
 * The carry-over scheduler of the L2 ask (ISSUE-022 chunk 2; ADR-0009
 * §Amendment 2026-10-24, carry-over re-ask; the 12-row table cap it also set was
 * removed by the 2026-11-16 owner ruling recorded in ADR-0060 §Amendment).
 *
 * Owner's rule: a valid JSON answer is accepted as-is, and an index whose answer
 * is invalid or that was not answered is re-asked in the NEXT table of the same
 * pass. This module settles ONE table; the caller builds and sends the tables. A
 * carried row goes to the FRONT of the next table, in table order — asked again,
 * never dropped.
 *
 * Fail-open: a row that will not be read again is final and its unit is kept.
 * `PRUNE_ASK_REASK_ROUNDS` is 1, so the next table is the one re-ask and a second
 * failure is FINAL, recording attempt 2's code. There is no catch-up flag: the
 * caller keeps building tables while any row is pending, so a carried row rides
 * the front of the next one by this plan alone. A reply with no text is a halt,
 * not silent answers: nothing is carried and every row is DEFERRED — not final,
 * and not refused. A halt produces no answer, so there is no refusal to name:
 * recording one would report a decision the pass never made (ISSUE-177). The
 * unit is kept either way; the difference is that a deferred row is counted as
 * deferred, never as decided, and spending the last round on the same empty
 * output buys nothing.
 *
 * The attempt counters (`summarizeTableAttempt`, `summarizePassAttempts`) and the
 * answer-reading primitives live in `./attempts.ts`, split out when this file hit
 * the 250-line cap: the amendment's tune-by-wrong-answer-rate needs them, and the
 * dsh judge table loop journals them per table attempt group.
 */

import type { UnitId } from "../types/identity.js";
import type { PruneAnswerRefusalCode, PruneAnswerRow } from "./ask-answer.js";
import { checkedAttempt, checkedTable, codeOf, outcomeMap } from "./attempts.js";
import type { PruneAskRow } from "./ask-message.js";

/**
 * Re-ask rounds a failed row is granted within one pass. One: the next table of
 * the same pass asks it again; a second failure is final and the unit is kept.
 */
export const PRUNE_ASK_REASK_ROUNDS = 1;

/** One row the next table must carry: re-asked at the front, never dropped. */
export interface PruneCarryEntry {
  /** The row as it was asked; its index and anchor travel unchanged. */
  readonly row: PruneAskRow;
  readonly index: number;
  readonly unitId: UnitId;
  /** Why this attempt produced no verdict; an absent outcome reads as missing. */
  readonly code: PruneAnswerRefusalCode;
  readonly attempt: number;
  /** Where the next table places it. */
  readonly placement: "front";
}

/** One row the pass stops asking; its unit is kept (fail-open). */
export interface PruneCarryFinal {
  readonly row: PruneAskRow;
  readonly index: number;
  readonly unitId: UnitId;
  /** The code of the LAST attempt, and the attempt that produced it. */
  readonly code: PruneAnswerRefusalCode;
  readonly attempt: number;
  /** The last attempt's own refusal message, or the halt/absent wording. */
  readonly message: string;
}

/** One table's settlement: what moves to the next table and what is finished. */
export interface PruneCarryOverPlan {
  /** This table's attempt ordinal, 1-based; a re-ask table is 2 or more. */
  readonly attempt: number;
  /** The rows this table asked, in table order, unchanged. */
  readonly table: readonly PruneAskRow[];
  /** Rows the next table carries, in table order, to its front. */
  readonly carry: readonly PruneCarryEntry[];
  /** Rows not asked again; each names its unit's last refusal code. */
  readonly final: readonly PruneCarryFinal[];
  /**
   * Rows this table could not decide because the pass HALTED: asked, but no
   * answer was readable, so there is nothing to report as refused.
   *
   * A deferred row's unit is kept, exactly like a final one, and it appears
   * here INSTEAD of `final`: the pass is not claiming it was tried and refused,
   * only that no answer arrived. Always present; empty unless the pass halted.
   * There is no `code` — a halt names no refusal, and inventing one would make
   * a deferral readable as a decision in every count that sums refusal codes.
   */
  readonly deferred: readonly PruneCarryDeferred[];
}

/**
 * One row a halted table leaves undecided. It carries the attempt it WOULD have
 * been asked at, so a reader can see the deferral was not a completed attempt.
 */
export interface PruneCarryDeferred {
  readonly row: PruneAskRow;
  readonly index: number;
  readonly unitId: UnitId;
  /** The attempt ordinal this row would have taken; the halt spent no round. */
  readonly attempt: number;
}

/** Options for `planCarryOver`; production passes none. */
export interface PlanCarryOverOptions {
  /**
   * Re-ask rounds still granted to a failed row. Defaults to the pass's budget
   * minus the attempts spent — `PRUNE_ASK_REASK_ROUNDS - (attempt - 1)`, floored
   * at 0 — so a one-round pass makes the second failure final by itself.
   */
  readonly roundsLeft?: number;
  /** This table's attempt ordinal, 1-based. Default 1. */
  readonly attempt?: number;
  /** True when the model sent no text at all; nothing is carried. Default false. */
  readonly halted?: boolean;
}

/**
 * Settles one table. A row is CARRIED iff its outcome is `refused` (any code) or
 * the index is ABSENT from the reply; an answered row is done. A carried row is
 * re-asked only while `roundsLeft` is at least 1; at 0 this attempt's code is
 * final and the unit is kept.
 *
 * A halted reply ignores `outcomes` on purpose: there was no answer to read, so
 * every row is DEFERRED — no carry, no final, no refusal code (ISSUE-177). A
 * halt is not a refusal: nothing was tried and nothing was read.
 * A repeated outcome for one index keeps the LAST, so the latest attempt decides;
 * a duplicated or invalid table index is a caller bug and throws.
 */
export function planCarryOver(
  table: readonly PruneAskRow[],
  outcomes: readonly PruneAnswerRow[],
  options: PlanCarryOverOptions = {},
): PruneCarryOverPlan {
  checkedTable(table);
  const attempt = checkedAttempt(options.attempt ?? 1);
  const roundsLeft = options.roundsLeft ?? Math.max(0, PRUNE_ASK_REASK_ROUNDS - (attempt - 1));
  if (!Number.isSafeInteger(roundsLeft) || roundsLeft < 0) {
    throw new RangeError("roundsLeft must be a non-negative safe integer.");
  }
  const byIndex = outcomeMap(outcomes);
  const carry: PruneCarryEntry[] = [];
  const final: PruneCarryFinal[] = [];
  const deferred: PruneCarryDeferred[] = [];
  const halted = options.halted ?? false;
  for (const row of table) {
    if (halted) {
      // ISSUE-177: a halt produced no answer, so nothing about this row is
      // decided. It is deferred with no code — the unit keeps, and no count that
      // sums refusal codes can read it as a verdict the pass gave.
      deferred.push({ row, index: row.index, unitId: row.unit.id, attempt: attempt + 1 });
      continue;
    }
    const outcome = byIndex.get(row.index);
    if (outcome?.status === "answered") continue;
    const code = codeOf(outcome);
    // The grammar gate is terminal: the answer named an action this grammar
    // does not offer, so a second ask cannot change the reading. The unit keeps
    // and the row spends no re-ask round (ISSUE-221).
    if (code === "action-not-in-grammar" || roundsLeft < 1) {
      final.push({ row, index: row.index, unitId: row.unit.id, code, attempt,
        message: finalMessage(row.index, outcome) });
      continue;
    }
    carry.push({
      row, index: row.index, unitId: row.unit.id, code, attempt: attempt + 1,
      placement: "front",
    });
  }
  return { attempt, table, carry, final, deferred };
}

/** A final row's message: the last attempt's own, or the absent wording. */
function finalMessage(index: number, outcome: PruneAnswerRow | undefined): string {
  return outcome?.status === "refused" ? outcome.message
    : `Index ${String(index)} was not answered; that unit is kept.`;
}
