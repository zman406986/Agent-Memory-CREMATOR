/**
 * The big prune's ONE correction turn, driven from the pass (ISSUE-113).
 *
 * The table loop already gives a refused row one more ask: the carry scheduler
 * (`planCarryOver`, ADR-0009's second amendment) puts it at the front of the
 * next table and a second failure is final. What no turn ever did is say WHY
 * the previous answer could not be applied: the catch-up table repeats the
 * plain contract and the row, with no statement of the refusal. This module
 * spends the pass's one remaining ask on exactly the rows whose LAST attempt
 * refused, as the owner-approved correction turn (ISSUE-113, 2026-10-29).
 *
 * It appends that turn to the SAME fork and sends once. Re-asked rows keep
 * their indices — `pruneCorrectionMessage` re-renders the same rows through
 * `renderPruneAskRows` — so no second address scheme exists. A row that
 * answers here moves from `refused` to `kept`; a row that refuses again keeps
 * the correction's own code and its unit stays kept, the fail-safe unchanged.
 *
 * ISSUE-508 (F3): the correction speaks the pass's ONE grammar. Under
 * `nokeepall` its message is the line-per-row shape (`[L line(s)]` rows, one
 * object per row per line with a sibling summary, no share line) and its reply
 * is read by the same `readJsonl20NoKeepallAnswer` reader the table used; under
 * `3option` the bytes and the index-keyed reading are unchanged.
 *
 * Nothing here runs when the loop halted: a pass with no readable answer has
 * nothing to correct, and a "your previous answer" turn after a dead socket
 * would be a false claim about what the model said. A pass whose first answer
 * was clean never reaches this module either, so its bytes are exactly today's.
 *
 * Fail-open throughout: a refused append, a refused send and a dead stream are
 * journaled by name and every refused row stays refused (kept). Answer data
 * never throws.
 */
import {
  ForkError, appendAsk, appendVerdict, pruneCorrectionMessage, summarizeTableAttempt,
} from '@cremator/core';
import type {
  PruneAnswerRejection, PrunePlanGrammar, PruneAskRow, PruneCorrectionReason, PruneTableAttempt,
  WireFork,
} from '@cremator/core';
import { parseTableReply } from './judge-tables.js';
import type { AnsweredRow, RowRefusal, TableLoopOutcome } from './judge-tables.js';
import type { MountJournal } from './journal-kinds.js';
import { askWire } from './llm-ask.js';
import type { JudgeRoute } from './route.js';
import type { DshLlmService } from './plugin.js';

export interface CorrectionTurnOptions {
  readonly sessionId: string;
  readonly round: number;
  /** Every row the pass asked, in table order: the correction's order source. */
  readonly rows: readonly PruneAskRow[];
  /** The loop's outcome: its fork, its banked answers and its refusals. */
  readonly loop: TableLoopOutcome;
  readonly stamps: ReadonlyMap<number, { readonly unitId: string;
    readonly answeredInRound: number }>;
  readonly llm: DshLlmService;
  readonly route: JudgeRoute | null;
  readonly journal: MountJournal;
  /**
   * The pass's bulk ask grammar (ISSUE-221). The mount always passes its
   * resolved value (the shipped default is `nokeepall`, ADR-0056); a direct
   * caller that omits it gets `3option`, the original contract byte for byte.
   * `nokeepall` renders the correction in that grammar's line-per-row shape
   * (rows with their `[L line(s)]`, then the one-object-per-row answer shapes,
   * no closing line), and a row refused `action-not-in-grammar` is never
   * re-asked.
   */
  readonly grammar?: PrunePlanGrammar;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one correction turn of a pass, folded back into the loop's outcome. It
 * returns the outcome UNCHANGED when no row is refused or the loop halted: the
 * clean path allocates no message, makes no call and journals nothing.
 */
export async function retryRefusedRows(options: CorrectionTurnOptions): Promise<TableLoopOutcome> {
  const { sessionId, round, journal, loop } = options;
  const grammar = options.grammar ?? '3option';
  if (loop.halted || loop.refused.size === 0) return loop;
  // ISSUE-221: `action-not-in-grammar` is the two-verdict gate's terminal
  // refusal — the answer named an action this grammar does not offer, so a
  // second ask cannot change the reading. The row keeps its unit and spends no
  // correction turn.
  const rows = options.rows.filter(row => {
    const refusal = loop.refused.get(row.index);
    return refusal !== undefined && refusal.code !== 'action-not-in-grammar';
  });
  if (rows.length === 0) return loop;
  const reasons: PruneCorrectionReason[] = rows.map(row => {
    // The map's key set is `rows`' own, so the fallback never fires; it is the
    // refusal rule itself rather than a silent `keepall` if that ever changes.
    const refusal = loop.refused.get(row.index);
    return {
      index: row.index,
      code: refusal?.code ?? 'missing-index',
      // The line reader's finer code rides beside its collapsed `malformed-row`,
      // so the re-ask names the defect the model actually made (F4).
      ...(refusal?.detail === undefined ? {} : { detail: refusal.detail }),
    };
  });
  let correction: string;
  try {
    correction = pruneCorrectionMessage({
      refused: rows, totalRows: options.rows.length, reasons, grammar });
  } catch (error) {
    // Core's correction renderer is grammar-gated and throws RangeError on an
    // unknown name (a JS caller's typo'd config). Contain it as a named refusal:
    // the loop's answered verdicts survive and nothing escapes into the pass
    // (ISSUE-346). The refused rows keep their units, exactly as a halt drain.
    journal('prune-skip', { sessionId, round, reason: 'invalid-grammar',
      code: 'invalid-grammar', message: messageOf(error),
      indices: rows.map(row => row.index), retried: true });
    return loop;
  }

  let fork: WireFork;
  try {
    fork = appendAsk(loop.fork, correction);
  } catch (error) {
    journal('prune-seed-refused', { sessionId, round, retried: true,
      code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
    return loop;
  }
  const indices = rows.map(row => row.index);
  let reply;
  try {
    reply = await askWire(options.llm,
      { system: fork.system, tools: fork.tools, messages: fork.messages,
        expected: { systemHash: fork.systemHash, toolsHash: fork.toolsHash } },
      { provider: options.route?.provider ?? '', model: options.route?.model ?? '',
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    journal('prune-send-refused', { sessionId, round, retried: true,
      code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
    return loop;
  }
  if (reply.status === 'refused') {
    journal('prune-skip', { sessionId, round, reason: reply.reason,
      code: reply.code, message: reply.message, indices, retried: true });
    // ISSUE-178: the correction turn is a paid send whose answer never arrived.
    // Its reading rides the same `prune-ask` kind as a table's, marked
    // `retried`, so the meter sums both under one lane.
    if (reply.usage !== undefined) {
      journal('prune-ask', { sessionId, round, tables: loop.tables + 1, usage: reply.usage,
        status: 'refused', retried: true, reason: reply.reason, code: reply.code });
    }
    return loop;
  }

  // The correction answered: its cost is journaled beside the table's, and the
  // table ordinal names the send this reading belongs to (ISSUE-178).
  if (reply.usage !== undefined) {
    journal('prune-ask', { sessionId, round, tables: loop.tables + 1, usage: reply.usage,
      status: 'answered', retried: true });
  }

  const correctionFork = appendVerdict(fork, reply.text);
  // ISSUE-508 (F3): the correction reply is read in the SAME grammar the turn
  // asked in. `nokeepall` is the one-object-per-line reader; `3option` is the
  // shipped batch parser. No second normalization is applied: the line reader's
  // own gate already decides the two-verdict set.
  const correctionReading = parseTableReply(reply.text, indices, options.stamps, rows, grammar);
  const correctedRows = correctionReading.rows;
  const kept = new Map<number, AnsweredRow>(loop.kept);
  const refused = new Map<number, RowRefusal>(loop.refused);
  for (const row of correctedRows) {
    if (row.status !== 'answered') continue;
    kept.set(row.index, row);
    refused.delete(row.index);
  }
  const table = loop.tables + 1;
  for (const index of indices) {
    if (kept.has(index)) continue;
    // Still refused: the correction's own reading is the reported one, so the
    // record names what FINALLY happened rather than the earlier attempt.
    const row = correctedRows.find(entry => entry.index === index);
    refused.set(index, row?.status === 'refused'
      ? { code: row.code, message: row.message, wireCode: row.wireCode, table,
        ...(row.detail === undefined ? {} : { detail: row.detail }) }
      : { code: 'missing-index', wireCode: null, table,
        message: `Index ${String(index)} was not answered; that unit is kept.` });
  }
  const rejected: (PruneAnswerRejection & { readonly table: number })[] = [
    ...loop.rejected, ...correctionReading.rejected.map(entry => ({ ...entry, table })),
  ];
  const attempt = correctionAttemptOf(loop);
  const reading = summarizeTableAttempt(rows, correctedRows, attempt);
  journal('prune-table', { sessionId, round, tables: table, carried: 0,
    retried: true, turns: 2, ...reading });
  const corrected = correctedRows.filter(row => row.status === 'answered').length;
  journal('prune-correction', { sessionId, round, tables: table, attempt,
    refusedRows: rows.length, ofRows: options.rows.length,
    corrected, stillRefused: indices.length - corrected,
    reasons: reasons.map(reason =>
      `${String(reason.index)}:${reason.detail ?? reason.code}`) });
  return {
    fork: correctionFork,
    // A correction is not a halt: whatever it answered stands, and whatever it
    // did not is a kept refusal, exactly as the loop reports its own.
    halted: false,
    kept,
    refused,
    // The loop's deferrals ride through unchanged (ISSUE-177): the correction
    // only runs when the loop did NOT halt, and a deferred row is one the pass
    // never decided either way — it is not re-asked here.
    deferred: loop.deferred,
    rejected,
    tables: table,
    answeredTables: loop.answeredTables + 1,
    attempts: [...loop.attempts, reading],
    attemptTotals: {
      tables: loop.attemptTotals.tables + 1,
      carried: loop.attemptTotals.carried,
      // The correction asks exactly its own rows, so it re-asks that many.
      reasked: loop.attemptTotals.reasked + rows.length,
      finalRefusals: refused.size,
      deferred: loop.attemptTotals.deferred,
    },
  };
}

/**
 * The correction's per-index attempt ordinal: one past the highest the loop
 * journaled. Derived, never a constant, so a one-table pass reports the
 * correction as attempt 2 and a carried pass reports it as attempt 3.
 */
function correctionAttemptOf(loop: TableLoopOutcome): number {
  let highest = 1;
  for (const entry of loop.attempts as readonly PruneTableAttempt[]) {
    if (entry.attempt > highest) highest = entry.attempt;
  }
  return highest + 1;
}
