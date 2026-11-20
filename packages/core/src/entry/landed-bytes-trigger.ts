/**
 * The entry seam's landed-bytes trigger (ISSUE-128 slices 1–2).
 *
 * Today's cadence counts eligible results (`batchVerdict`, `./batch-trigger.ts`).
 * This one counts BYTES: the sum of the eligible results' own byte lengths that
 * have landed since the last fire. Both halves of the rule come from the sim that
 * measured the live configuration (`dev/sim/sim-batch-units.mjs`):
 *
 * - the accumulator grows by a unit's OWN bytes as it lands, never by the
 *   rendered drop and never by the measured depth (`:704-709`);
 * - only a fire zeroes it (`:740-741`), so a host prune or the ask lane's own
 *   removal can never lower it and cannot delay the next crossing;
 * - the verdict fires only with work pending (`:639-650`):
 *   `pending > 0 && landedBytes >= threshold`.
 *
 * The `pending > 0` guard cannot bind on a landing — every landing appends to
 * pending — so a crossing over an empty pending stream is impossible by
 * construction, as it is in the sim, where the accumulator is also fed only by
 * units as they become pending. The guard stays written: it is the rule, not an
 * inference from this caller.
 *
 * The mount owns eligibility (the `floorForModel` floor, not an error) and hands
 * the result's byte length across; this module holds no captures, renders no
 * bytes and sends nothing. Pure: no clock, no I/O, no mutation of the input.
 */

/** The carried bytes: eligible ids that have landed and not yet fired. */
export interface EntryLandedBytesState {
  /** In arrival order; each is one row of the next batch ask. */
  readonly pending: readonly string[];
  /** The sum of the pending results' own byte lengths since the last fire. */
  readonly landedBytes: number;
}

/** The held case: the accumulator moved, no ask is owed yet. */
export interface EntryLandedBytesHold {
  readonly kind: "hold";
  readonly state: EntryLandedBytesState;
}

/** The firing case: the whole pending stream is one ask's rows, and the accumulator resets. */
export interface EntryLandedBytesFire {
  readonly kind: "fire";
  /** The whole pending stream in arrival order, this landing included. */
  readonly batch: readonly string[];
  readonly state: EntryLandedBytesState;
}

/** One eligible result as it lands: its id and its own byte length. */
export interface EntryLandedBytesUnit {
  readonly id: string;
  /** `bytes.length` of the result, never the rendered drop (`:704-709`). */
  readonly bytes: number;
}

/** The rule's inputs, named as the sim's verdict names them (`:639`). */
export interface LandedBytesReading {
  /** The accumulator: eligible bytes landed since the last fire. */
  readonly landedBytes: number;
  /** Landed bytes that fire one ask; the live run's value is 240,000. */
  readonly threshold: number;
  /** How many eligible results are pending; `0` always holds. */
  readonly pending: number;
}

/** The pure verdict: it fires or it holds, and it moves no accumulator itself. */
export interface LandedBytesVerdictResult {
  readonly kind: "hold" | "fire";
  /** The reading's own accumulator, unchanged: a hold moves no checkpoint. */
  readonly landedBytes: number;
}

/**
 * The sim's exact predicate (`sim-batch-units.mjs:639-650`), beside the stream
 * entry below and equally pure. `pending > 0` is required because an ask with no
 * rows is paid for and buys nothing; the accumulator is monotone, so a caller
 * that crossed with nothing pending keeps its bytes and fires on the next
 * landing instead of waiting for a second crossing.
 */
export function landedBytesVerdict(reading: LandedBytesReading): LandedBytesVerdictResult {
  if (!Number.isSafeInteger(reading.threshold) || reading.threshold < 1) {
    throw new RangeError(
      `A landed-bytes threshold is a positive safe integer, got ${String(reading.threshold)}.`,
    );
  }
  if (!Number.isSafeInteger(reading.landedBytes) || reading.landedBytes < 0) {
    throw new RangeError(
      `Landed bytes is a non-negative safe integer, got ${String(reading.landedBytes)}.`,
    );
  }
  const fires = reading.pending > 0 && reading.landedBytes >= reading.threshold;
  return { kind: fires ? "fire" : "hold", landedBytes: reading.landedBytes };
}

/**
 * Feeds one newly eligible result to the accumulator and says what the mount
 * owes. `hold` means journal the id and its bytes and ask nothing; `fire` means
 * send one batched ask covering the WHOLE pending stream and then ask about
 * nothing until the accumulator crosses again. The threshold is the config's
 * `entryAskTrigger.bytes`; a bad one throws here rather than never firing.
 */
export function landedBytesTriggerVerdict(
  state: EntryLandedBytesState,
  threshold: number,
  unit: EntryLandedBytesUnit,
): EntryLandedBytesHold | EntryLandedBytesFire {
  const pending = [...state.pending, unit.id];
  const landedBytes = state.landedBytes + unit.bytes;
  const verdict = landedBytesVerdict({ landedBytes, threshold, pending: pending.length });
  if (verdict.kind === "hold") return { kind: "hold", state: { pending, landedBytes } };
  // The batch is the whole pending stream, and only this fire zeroes the bytes.
  return { kind: "fire", batch: pending, state: { pending: [], landedBytes: 0 } };
}
