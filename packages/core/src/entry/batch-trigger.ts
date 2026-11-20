/**
 * The entry seam's batch trigger (ISSUE-117 chunk B1; ADR-0035 §1–§3, §6).
 *
 * The checkpoint asks one result at a time today. Batched asks hold the eligible
 * results instead and send exactly one ask when the count of NEW eligible
 * results since the last ask reaches `entryAskBatchSize`. This module owns that
 * arithmetic and nothing else: it holds no captures, renders no bytes and sends
 * nothing, so the mount can journal a hold without paying for a fork.
 *
 * Rules, verbatim from the ADR:
 * - `batchSize <= 1` is today's cadence: every eligible result fires its own
 *   one-row batch, and no state is held between calls.
 * - Otherwise the id appends to `pending`; the verdict `fire`s exactly when the
 *   pending length reaches the knob, carrying the whole batch in arrival order,
 *   and the returned state's `pending` is empty again.
 * - A partial batch at session end is carried, never flushed. There is no
 *   `flush` on purpose: an ask after the session's last useful turn costs a full
 *   context send and buys no later request anything, so the tail is simply never
 *   asked and its units keep. The state is in-memory session state — it dies
 *   with the session, so a resumed session starts a fresh batch.
 *
 * Pure: no clock, no I/O, no mutation of the input state.
 */

/** The carried partial batch: eligible ids that have held and not yet fired. */
export interface EntryBatchState {
  /** In arrival order; each is one row of the next batch ask. */
  readonly pending: readonly string[];
}

/** The held case: the new id is pending, no ask is owed yet. */
export interface EntryBatchHold {
  readonly kind: "hold";
  readonly state: EntryBatchState;
}

/** The firing case: these ids are one ask's rows, and the accumulator resets. */
export interface EntryBatchFire {
  readonly kind: "fire";
  /** The batch in arrival order; its length is the knob's value, or 1 at size <= 1. */
  readonly batch: readonly string[];
  readonly state: EntryBatchState;
}

/**
 * Feeds one newly eligible result id to the accumulator and says what the mount
 * owes. `hold` means journal the id and ask nothing; `fire` means send one batched
 * ask covering `batch` and then ask about nothing until the count fills again.
 */
export function batchVerdict(
  state: EntryBatchState,
  batchSize: number,
  eligibleId: string,
): EntryBatchHold | EntryBatchFire {
  // Today's cadence, and the shipped default: one ask per result, no state held.
  if (batchSize <= 1) {
    return { kind: "fire", batch: [eligibleId], state: { pending: [] } };
  }
  const pending = [...state.pending, eligibleId];
  // `>=`, not `===`: for a validated count the two are the same, but a state that
  // somehow holds more than the knob (a lowered value mid-session) must fire now
  // rather than wait for an exact match that may never come.
  if (pending.length < batchSize) {
    return { kind: "hold", state: { pending } };
  }
  return { kind: "fire", batch: pending, state: { pending: [] } };
}
