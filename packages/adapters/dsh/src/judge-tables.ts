/**
 * The bulk prune's table loop: the ONE table send engine left (ADR-0028).
 *
 * ADR-0028 removed the judge pass, so this file has a single caller — the
 * record-only prune pass in `./prune.ts` — and its journal lines are the
 * literal `prune-*` spellings. Everything the loop does is unchanged from
 * ADR-0009's contract; only the second caller and its `stage`/`gate` arms are
 * gone.
 *
 * This file owns the SENDING, not the scheduling. Core's `planCarryOver` is the
 * one carry scheduler: it decides what the next table carries (front of the
 * table) and what is final. Here a pass grows its fork one table
 * at a time: append the ask, send the fork's whole wire state (`askWire`), append
 * the reply as the next `assistant` turn, and read that reply as one index-keyed
 * object (`parsePruneAnswer`, the core's own reader). A carried row rides the
 * front of the next table because the loop keeps sending while rows are pending;
 * no separate catch-up flag exists. A table has no row cap (the twelve-unit cap
 * of ADR-0009 §Amendment 2026-10-24 was removed by the 2026-11-16 owner ruling
 * recorded in ADR-0060 §Amendment): the first table asks every pending row, and
 * a later table exists only when a reply leaves rows carried.
 * `summarizeTableAttempt` is journaled once per attempt GROUP of a table, so
 * `attempt` is the per-index re-ask ordinal (1, then 2) and never the table's
 * ordinal.
 *
 * The loop stops the moment it cannot continue honestly:
 *
 * - the fork refuses its own append (a drifted byte; two user turns are legal), or
 * - `askWire` refuses the send because the fork's system/tool hashes drifted, or
 * - the ask produced no text (a tool-call reply, an empty or capped stream, a
 *   dead socket).
 *
 * A reply that carries text but is not one JSON object is NOT a stop: the parser
 * reads it as refusals, and those rows take the pass's one re-ask like any other
 * refused row. Every stop is fail-open, and it DEFERS rather than decides: every
 * row still pending keeps its unit and is reported in `deferred`, never in
 * `refused` (ISSUE-177). A halt produces no answer, so there is no refusal to
 * name — reporting one would make a deferral read as a decision in every count
 * that sums refusal codes. The pass still settles its round.
 */
import {
  ForkError, normalizeWireTwoVerdictAnswer,
  appendAsk, appendVerdict, parsePruneAnswer, planCarryOver, pruneAskFinalLineOf,
  pruneAskSystemPromptOf, renderPruneAskTable, summarizePassAttempts, summarizeTableAttempt,
} from '@cremator/core';
import type {
  PruneAnswerRefusalCode, PruneAnswerRejection, PruneAnswerRow, PruneAskGrammar,
  PruneAskRow, PruneCarryDeferred, PruneCarryOverPlan, PrunePassAttemptTotals,
  PruneTableAttempt, ProcessingUnit, WireFork, WireVerdictErrorCode,
} from '@cremator/core';
import type { MountJournal } from './journal-kinds.js';
import { askWire } from './llm-ask.js';
import type { StreamOutcome } from './llm-ask.js';
import type { JudgeRoute } from './route.js';
import type { DshLlmService } from './plugin.js';

/**
 * The bulk ask grammars this loop can render (core's closed `PruneAskGrammar`).
 * The list is closed so a typo'd config name is refused as `invalid-grammar`
 * before core's grammar-gated renderer can throw into the pass (ISSUE-346).
 */
const PRUNE_ASK_GRAMMARS = ['3option', 'nokeepall'] as const;

/**
 * The line that frames the contract for a fork ask. The shipped contract says
 * "the user message is the production conversation"; in a fork the conversation
 * is the message prefix, so this line states the frame without rewording the
 * asset. It does NOT claim byte-identity with the provider wire: the prefix is
 * main's captured request, text-projected (a tool turn rides as `user`, a
 * tool-call block as one bracketed line), and the adapter serializes at send.
 */
const ASK_FRAME = "The messages above are main's production conversation, carried over in main's "
  + "order, followed by this pass's earlier exchanges. This message is this pass's instruction: "
  + "the contract, a table with one row per unit, and one closing line. Treat all of it as "
  + "instruction, not as content to review.";

/** One table's rows, as `renderPruneAskTable` takes them. */
type TableRow = PruneAskRow;

/** One parsed answer row that carried a verdict. */
export type AnsweredRow = Extract<
  ReturnType<typeof parsePruneAnswer>['rows'][number], { status: 'answered' }>;

/** One row's refusal, by the parser's own code. */
export interface RowRefusal {
  readonly code: PruneAnswerRefusalCode;
  readonly message: string;
  /** The wire parser's own code when the row itself was malformed; else null. */
  readonly wireCode: WireVerdictErrorCode | null;
  /** The 1-based table whose reply produced this refusal; null when none did. */
  readonly table: number | null;
}

export interface TableLoopOptions {
  readonly sessionId: string;
  readonly round: number;
  readonly fork: WireFork;
  readonly rows: readonly TableRow[];
  /** The stamp per index: its unit id and the pass's round. */
  readonly stamps: ReadonlyMap<number, { readonly unitId: string;
    readonly answeredInRound: number }>;
  readonly llm: DshLlmService;
  readonly route: JudgeRoute | null;
  readonly journal: MountJournal;
  /**
   * The pass's bulk ask grammar (ISSUE-221). The mount always passes its
   * resolved value (the shipped default is `nokeepall`, ADR-0056); a direct
   * caller that omits it gets `3option`, the original contract byte for byte.
   * `nokeepall` selects that grammar's prompt, closing line, row shape and
   * answer gate.
   */
  readonly grammar?: PruneAskGrammar;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TableLoopOutcome {
  /** The fork after its last append; a refused append leaves it unchanged. */
  readonly fork: WireFork;
  /** True when the loop stopped on a refused append or a no-text reply. */
  readonly halted: boolean;
  /** Answered rows by assigned index. */
  readonly kept: ReadonlyMap<number, AnsweredRow>;
  /** Rows the pass decided not to answer, by index. */
  readonly refused: ReadonlyMap<number, RowRefusal>;
  /**
   * Rows a HALT left undecided, in table order (ISSUE-177). Every one keeps its
   * unit, and none is a refusal: no answer arrived, so there is nothing to
   * report as read and refused. Empty when the loop never halted.
   */
  readonly deferred: readonly PruneCarryDeferred[];
  /** Keys that addressed no row of their table, with that table's ordinal. */
  readonly rejected: readonly (PruneAnswerRejection & { readonly table: number })[];
  /** Tables sent, whether or not their reply came back. */
  readonly tables: number;
  /** Tables whose reply arrived as text: the pass's answered-ask count. */
  readonly answeredTables: number;
  /**
   * One entry per attempt GROUP of every table the pass settled, in table order
   * (`summarizeTableAttempt`): the 12-unit tuning data, populated from the loop's
   * own reading of each reply (ISSUE-022 chunk 6).
   */
  readonly attempts: readonly PruneTableAttempt[];
  /** The pass's four attempt counts, folded from the same plans. */
  readonly attemptTotals: PrunePassAttemptTotals;
}

/** One row still owed an ask, and the attempt ordinal it will be asked at. */
interface PendingRow {
  readonly row: TableRow;
  readonly attempt: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ask text of one table: frame, contract, table, instruction — one user turn. */
export function tableAsk(rows: readonly TableRow[], grammar: PruneAskGrammar = '3option'): string {
  return `${ASK_FRAME}\n\n${pruneAskSystemPromptOf(grammar)}\n\n`
    + `${renderPruneAskTable(rows, undefined, { grammar })}`
    + `\n\n${pruneAskFinalLineOf(grammar)}`;
}

/**
 * The two-verdict gate over one table's parsed rows (ISSUE-221). Under
 * `nokeepall` a `keeplines` covering the row's whole `1..L` becomes a clean
 * `keepall` — it removes nothing, so it is never a removal — and every action
 * the grammar does not offer (`keepall`, `forgetlines`) becomes a terminal
 * `action-not-in-grammar` refusal that keeps the unit. The shipped `3option`
 * path returns the rows untouched, so its bytes and counts cannot drift.
 */
export function grammarRowsOf(
  rows: readonly PruneAnswerRow[],
  table: readonly TableRow[],
  grammar: PruneAskGrammar,
): readonly PruneAnswerRow[] {
  if (grammar !== 'nokeepall') return rows;
  const units = new Map(table.map(row => [row.index, row.unit] as const));
  return rows.map(row => {
    if (row.status !== 'answered') return row;
    const outcome = normalizeWireTwoVerdictAnswer(row.answer, lineCountOf(units.get(row.index)));
    if (outcome.status === 'answered') {
      return { index: row.index, unitId: row.unitId, status: 'answered',
        answer: outcome.answer };
    }
    return { index: row.index, unitId: row.unitId, status: 'refused',
      code: outcome.code, message: outcome.message, wireCode: null };
  });
}

/** A row's own positive line count, or null for a zero-line unit. */
function lineCountOf(unit: ProcessingUnit | undefined): number | null {
  const range = unit?.span.lineRange;
  if (range === null || range === undefined) return null;
  const count = range.endLineInclusive - range.startLine + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** A reply that answered nothing readable: every index of the table refuses. */
function unreadableCode(rows: readonly PruneAnswerRow[]): string | null {
  if (rows.length === 0) return null;
  const allRefused = rows.every(row => row.status === 'refused'
    && (row.code === 'answer-unreadable' || row.code === 'answer-not-an-object'));
  if (!allRefused) return null;
  const first = rows[0];
  return first?.status === 'refused' ? first.code : 'answer-unreadable';
}

/**
 * Splits one table into runs of equal attempt ordinal. A table is built as
 * carried rows (attempt 2) at its front and fresh rows (attempt 1) after them,
 * so this is at most two runs; the core settles each run against its own
 * remaining re-ask budget.
 */
function attemptGroups(table: readonly PendingRow[]): readonly (readonly PendingRow[])[] {
  const groups: PendingRow[][] = [];
  for (const item of table) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]?.attempt === item.attempt) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/**
 * Grow the fork through as many tables as the pass needs (and can honestly
 * reach), then report what each assigned index got.
 */
export async function runTables(options: TableLoopOptions): Promise<TableLoopOutcome> {
  const { sessionId, round, journal, stamps } = options;
  const grammar = options.grammar ?? '3option';
  let fork = options.fork;
  const kept = new Map<number, AnsweredRow>();
  const refused = new Map<number, RowRefusal>();
  const rejected: (PruneAnswerRejection & { readonly table: number })[] = [];
  let pending: PendingRow[] = options.rows.map(row => ({ row, attempt: 1 }));
  let tables = 0;
  let answeredTables = 0;
  let halted = false;
  /** One plan per attempt GROUP settled: the carry decision and its counters. */
  const settled: PruneCarryOverPlan[] = [];
  const attempts: PruneTableAttempt[] = [];
  // Core's table renderer is grammar-gated and throws RangeError on an unknown
  // name (a JS caller's typo'd config). Refuse by name before composing or
  // sending anything: halt cleanly so the drain below DEFERS every pending row
  // (each unit keeps) rather than unwinding past the rows the pass was about to
  // ask (ISSUE-346).
  if (!(PRUNE_ASK_GRAMMARS as readonly string[]).includes(grammar)) {
    journal('prune-skip', { sessionId, round, reason: 'invalid-grammar',
      code: 'invalid-grammar',
      message: `the bulk prune has no grammar "${grammar}"; use one of ${PRUNE_ASK_GRAMMARS.join(', ')}`,
      indices: pending.map(item => item.row.index) });
    halted = true;
  }
  while (!halted && pending.length > 0) {
    // No row cap: the table is every pending row (2026-11-16 owner ruling,
    // ADR-0060 §Amendment). A later table carries only rows a reply left.
    const table = pending.splice(0);
    const tableRows = table.map(item => item.row);
    const indices = tableRows.map(row => row.index);
    try {
      fork = appendAsk(fork, tableAsk(tableRows, grammar));
    } catch (error) {
      // With consecutive user turns legal, this is a drifted byte, not a role
      // repeat: a seed whose last turn is the user's appends fine (CRITIC-026
      // P2#5). The journal keeps the fork's own code for the drift.
      journal('prune-seed-refused', { sessionId, round,
        code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
      halted = true;
      // The spliced table goes back so the halt drain reports every row.
      pending.unshift(...table);
      break;
    }
    tables += 1;
    let reply: StreamOutcome;
    try {
      reply = await askWire(options.llm,
        { system: fork.system, tools: fork.tools, messages: fork.messages,
          expected: { systemHash: fork.systemHash, toolsHash: fork.toolsHash } },
        { provider: options.route?.provider ?? '', model: options.route?.model ?? '',
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      // The send seam re-asserted the fork's system/tool hashes and refused the
      // send; nothing left this process. Fail open like every other refusal.
      journal('prune-send-refused', { sessionId, round,
        code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
      halted = true;
      pending.unshift(...table);
      break;
    }
    if (reply.status === 'refused') {
      journal('prune-skip', { sessionId, round, reason: reply.reason,
        code: reply.code, message: reply.message, indices });
      // The send was paid for even though it produced no text (ISSUE-178). The
      // stream seam keeps the host's reading on the refusal; recording it here
      // is what makes the bulk prune's spend visible to the alarm, which
      // otherwise read this lane as zero.
      if (reply.usage !== undefined) {
        journal('prune-ask', { sessionId, round, tables, usage: reply.usage,
          status: 'refused', reason: reply.reason, code: reply.code });
      }
      halted = true;
      pending.unshift(...table);
      break;
    }
    answeredTables += 1;
    // The answered table's cost (ISSUE-178), under the entry lane's field
    // names, so one meter reads both lanes. A host that reported no `usage`
    // chunk leaves the field off — an unmeasured ask, never a zero one.
    if (reply.usage !== undefined) {
      journal('prune-ask', { sessionId, round, tables, usage: reply.usage,
        status: 'answered' });
    }
    fork = appendVerdict(fork, reply.text);
    const parsed = parsePruneAnswer(reply.text, { indices, stamps });
    // ISSUE-221: the two-verdict gate runs after the ask read the row and
    // before the carry scheduler and the merge see it. Under `3option` the
    // rows cross untouched.
    const rows = grammarRowsOf(parsed.rows, tableRows, grammar);
    for (const entry of parsed.rejected) rejected.push({ ...entry, table: tables });
    // A reply that is not one JSON object answers nothing, but its rows are
    // readable refusals, not a halt: they take the pass's one re-ask like any
    // other refused row (ADR-0009's amendment). Only a reply with no text is a
    // halt, and that path broke out above.
    const unreadable = unreadableCode(rows);
    if (unreadable !== null) {
      journal('prune-skip', { sessionId, round, reason: 'no-verdict', code: unreadable,
        message: 'the reply was not one JSON object; its rows are carried to the next table.',
        indices });
    }
    for (const row of rows) {
      if (row.status === 'answered') kept.set(row.index, row);
    }
    const next: PendingRow[] = [];
    for (const group of attemptGroups(table)) {
      const groupRows = group.map(item => item.row);
      const attempt = group[0]?.attempt ?? 1;
      const plan = planCarryOver(groupRows, rows, { attempt });
      settled.push(plan);
      for (const entry of plan.final) {
        refused.set(entry.index, refusalOf(rows, entry.index, entry.code, tables));
      }
      for (const entry of plan.carry) next.push({ row: entry.row, attempt: entry.attempt });
      // One line per attempt group: `attempt` is the per-index re-ask ordinal,
      // never the table's ordinal, so a table that mixes carried re-asks with
      // fresh rows never blends the two in the tuning telemetry. The same
      // counters feed the pass record (ISSUE-022 chunk 6).
      const reading = summarizeTableAttempt(groupRows, rows, attempt);
      attempts.push(reading);
      journal('prune-table', { sessionId, round, tables,
        carried: plan.carry.length, ...reading });
    }
    pending.unshift(...next);
  }
  // Every row still pending was either asked in a table whose reply never came
  // back, or never reached a table: a halted pass has no readable answer for it,
  // so nothing about it is decided. Core's own scheduler settles them as
  // DEFERRED (ISSUE-177) — the unit keeps, and no refusal is reported for an
  // answer that never arrived. One plan per attempt group, like the answered
  // path, so a mixed carried/fresh table still settles at its own ordinals.
  //
  // These plans are NOT folded into `settled`: a pass cut short after a halt
  // carries rows it never re-asks, and `summarizePassAttempts` reports that gap
  // as `carried` without `reasked` on purpose. Only their deferral is counted.
  const deferred: PruneCarryDeferred[] = [];
  let deferredTotal = 0;
  for (const group of attemptGroups(pending)) {
    const groupRows = group.map(item => item.row);
    const attempt = group[0]?.attempt ?? 1;
    const plan = planCarryOver(groupRows, [], { attempt, halted: true });
    deferred.push(...plan.deferred);
    deferredTotal += plan.deferred.length;
  }
  const totals = summarizePassAttempts(settled, tables);
  return { fork, halted, kept, refused, deferred, rejected, tables, answeredTables, attempts,
    // The totals' table count is this loop's own SENT count, never the number of
    // settled plans: one table settles one plan per attempt group, so a table
    // mixing carried re-asks with fresh rows would inflate it (CRITIC-022 P2 #4).
    attemptTotals: { ...totals, deferred: deferredTotal } };
}

/** One row's refusal, read off the reply's own row when it carried one. */
function refusalOf(rows: readonly PruneAnswerRow[], index: number,
  code: PruneAnswerRefusalCode, table: number): RowRefusal {
  const row = rows.find(entry => entry.index === index);
  return row?.status === 'refused'
    ? { code, message: row.message, wireCode: row.wireCode, table }
    : { code, wireCode: null, table,
      message: `Index ${String(index)} was not answered; that unit is kept.` };
}
