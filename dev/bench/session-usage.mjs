#!/usr/bin/env node
/**
 * Session-log usage reading — one implementation, two callers.
 *
 * `derive-run-b.mjs` reads a FINISHED log to state an arm's totals; the bench
 * launcher's in-run token watchdog (`token-watchdog.mjs`) reads the same file
 * while the child is still writing it. Both must agree on what "billed prompt
 * tokens" means, or a live run would be killed at a number its own derivation
 * never reproduces. So the row shape and the sum live here, and neither caller
 * carries a private copy.
 *
 * A row is one `assistant/message` event carrying `data.usage` — or, for the
 * host's native compaction call, one `compaction/summary` event carrying the
 * same fields (`compactionUsageRow`, ISSUE-237):
 *
 *   billedTokens = inputTokens + cacheReadTokens + cacheWriteTokens
 *
 * That sum is the prompt the provider bills for that step — the quantity the
 * per-arm stop rules (80 000 000 / 40 000 000) are stated in. Output tokens
 * are carried beside it and never folded into `billedPromptTokens`, so the
 * prompt series stays prompt-only. They ARE folded in where the grant is
 * concerned: `token-watchdog.mjs` `computeTrueTotal` adds this prompt, the main
 * output, and the mount journal's ask prompt and ask output into the TRUE total
 * that `--token-grant` compares.
 *
 * **Why the third term (ISSUE-173).** The host reports three DISJOINT buckets —
 * uncached input, cache read, cache write — and the product's own reader sums
 * all three into the one prompt it hands the meter
 * (`packages/adapters/dsh/src/usage.ts` `readAssistantUsage`: `input +
 * cacheTotal`). A bench that counted only two of them would be measuring a
 * different quantity under the same name, and on a route that writes cache its
 * `--token-grant` would be looser than the number the product bills by. The
 * agreement is what the third term buys, not a new reading of today's numbers.
 *
 * `count()` keeps the reading total for an OPTIONAL field the host omitted:
 * `Number(undefined)` is NaN, and a NaN in the sum would poison every comparison
 * instead of reading as an unknown zero.
 *
 * **A row must be recognizable (fourteenth audit item 2).** Zero-filling every
 * absent field meant a renamed usage field (say `prompt_tokens` for
 * `inputTokens`) still counted as a row and billed 0, so the token grant never
 * fired. A row is billable only when at least one PROMPT-side field
 * (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`) is a finite number or a
 * numeric string; the two cache buckets may be absent,
 * but a usage object with no prompt-side field at all is refused, not summed as
 * 0. `usageGap` names the refusal for the callers that must fail closed.
 */

/** The fields that state prompt spend. At least one must be readable. */
export const PROMPT_TOKEN_FIELDS = Object.freeze(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']);

/** One finite count, or 0 when the host wrote nothing usable. */
function count(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Is this value a finite number, or a numeric string (the host writes JSON)? */
function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value));
  return false;
}

/**
 * Whether a usage object carries a readable prompt-side token field. `present`
 * says the object exists at all; `recognized` says at least one prompt field is
 * numeric. A row with only `outputTokens`/`totalTokens` is NOT recognized: the
 * billed sum it would produce is 0, and a 0 the grant cannot see is the failure
 * this gate exists to refuse.
 * @param {unknown} usage
 * @returns {{present: boolean, recognized: boolean, promptFields: string[],
 *   missingFields: string[]}}
 */
export function usageShape(usage) {
  const present = usage !== null && typeof usage === 'object' && !Array.isArray(usage);
  const promptFields = present
    ? PROMPT_TOKEN_FIELDS.filter((field) => numeric(usage[field])) : [];
  return {
    present,
    recognized: promptFields.length > 0,
    promptFields,
    missingFields: PROMPT_TOKEN_FIELDS.filter((field) => !promptFields.includes(field)),
  };
}

/**
 * Why one assistant turn carries no billable row, or null when it does:
 * `'absent'` when the event has no `data.usage`, `'unrecognized'` when it has
 * one but no prompt-side token field. The caller fails closed on either.
 * @param {object} event - one parsed `session.v4.jsonl` line.
 * @returns {'absent'|'unrecognized'|null}
 */
export function usageGap(event) {
  if (event?.type !== 'assistant/message') return null;
  const usage = event.data?.usage;
  if (usage === undefined || usage === null || typeof usage !== 'object') return 'absent';
  return usageShape(usage).recognized ? null : 'unrecognized';
}

/**
 * One usage row for an `assistant/message` event, zero-filled when the host
 * wrote no `data.usage`.
 *
 * `derive-run-b.mjs` reads EVERY assistant message this way: its `messages`
 * series is the prompt history, and a step whose usage the host omitted still
 * occupies a seq and can still be the last step before a crossing. The launcher
 * and the watchdog want the stricter question instead (`usageRow`: a row exists
 * only when usage does), so both shapes come from one row builder.
 * @param {object} event - one parsed `session.v4.jsonl` line.
 * @returns {object|null} null unless the event is an `assistant/message`.
 */
export function messageUsage(event) {
  if (event?.type !== 'assistant/message') return null;
  const usage = event.data?.usage;
  const present = usage !== undefined && usage !== null && typeof usage === 'object';
  const inputTokens = present ? count(usage.inputTokens) : 0;
  const cacheReadTokens = present ? count(usage.cacheReadTokens) : 0;
  const cacheWriteTokens = present ? count(usage.cacheWriteTokens) : 0;
  return {
    seq: event.seq,
    time: event.time,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: present ? count(usage.outputTokens) : 0,
    // The host's own field; never recomputed, so a row states what it wrote.
    totalTokens: present ? count(usage.totalTokens) : 0,
    billedTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/**
 * One usage row, or null when the event carries no `data.usage` or a usage
 * object with no recognizable prompt-side token field.
 *
 * Absent usage is null, not a zero row: callers use the row list as proof a
 * provider step was billed (`the arm reached the provider`), and a synthetic
 * zero row would make that check vacuous. An unrecognizable usage object is
 * null too (fourteenth audit item 2): a renamed field must refuse the run, not
 * silently bill 0. `usageGap` says which of the two it was.
 * @param {object} event - one parsed `session.v4.jsonl` line.
 * @returns {object|null}
 */
export function usageRow(event) {
  if (event?.type !== 'assistant/message') return null;
  const usage = event.data?.usage;
  if (usage === undefined || usage === null || typeof usage !== 'object') return null;
  if (!usageShape(usage).recognized) return null;
  return messageUsage(event);
}

/**
 * One usage row for a native compaction call, or null by the same rules
 * `usageRow` applies to an assistant turn (ISSUE-237).
 *
 * The host writes the compaction's own API usage on `compaction/summary` under
 * `data.usage`: `inputTokens`, `cacheReadTokens`, `outputTokens`, `totalTokens`.
 * The call is billed exactly like a provider step, so the true total must carry
 * it; `shadowedTokenCount` is NOT usage (it measures the prompt the compaction
 * removed) and `totalTokens` is never added beside the three prompt buckets, or
 * the call would be counted twice.
 *
 * Absent usage, or a usage object with no recognizable prompt-side field, is
 * null — the same refusal `usageRow` states, so a renamed field cannot read as
 * a paid call of 0.
 * @param {object} event - one parsed `session.v4.jsonl` line.
 * @returns {object|null}
 */
export function compactionUsageRow(event) {
  if (event?.type !== 'compaction/summary') return null;
  const usage = event.data?.usage;
  if (usage === undefined || usage === null || typeof usage !== 'object') return null;
  if (!usageShape(usage).recognized) return null;
  const inputTokens = count(usage.inputTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const cacheWriteTokens = count(usage.cacheWriteTokens);
  return {
    seq: event.seq,
    time: event.time,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage.outputTokens),
    // The host's own field; never recomputed, and never added to the total
    // beside the three prompt buckets.
    totalTokens: count(usage.totalTokens),
    billedTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** Every usage row in log order. */
export function usageRows(events) {
  const rows = [];
  for (const event of events) {
    const row = usageRow(event);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * The sums a reader compares: input, the two cache buckets separately, the
 * billed prompt total, and output. `rows` is the same list it summed, so a
 * caller that also reports per-step evidence never rebuilds the array.
 * @param {object[]} rows - as returned by `usageRow` / `usageRows`.
 * @returns {{rows: object[], inputTokens: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, billedPromptTokens: number, outputTokens: number,
 *   totalTokens: number}}
 */
export function usageTotals(rows) {
  const totals = {
    rows,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedPromptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  for (const row of rows) {
    totals.inputTokens += row.inputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    // The row's own billed sum, never a second expression of it: a caller that
    // re-added the parts here could drift from `messageUsage` one term at a time.
    totals.billedPromptTokens += row.billedTokens;
    totals.outputTokens += row.outputTokens;
    totals.totalTokens += row.totalTokens;
  }
  return totals;
}
