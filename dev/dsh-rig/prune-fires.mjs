/**
 * Which `prune-threshold` journal lines are FIRES, and which are readings.
 *
 * The mount writes one `prune-threshold` line per step boundary that evaluated
 * the bar (`packages/adapters/dsh/src/plugin.ts`), and carries `crossed` to say
 * whether that evaluation fired the half-window trigger. Before that change a
 * line existed only when the bar crossed, so readers counted lines as fires.
 * Counting every line now would turn a metric into an evaluation rate.
 *
 * Back-compatibility: an OLD journal file has no `crossed` field at all. Before
 * the change a line was written only when it fired, so a MISSING field is a
 * fire and must still count as one. Only an explicit `false` is a reading.
 *
 * A consumer that means "evaluations" or "readings" must NOT use this; it
 * counts every line of the kind (`byKind` in `bench-run.mjs` is that count).
 */

/** The kind this predicate reads. */
export const PRUNE_THRESHOLD_KIND = 'prune-threshold';

/**
 * True for a `prune-threshold` line that fired the trigger.
 * @param {object} line - one parsed journal record.
 * @returns {boolean}
 */
export function isPruneFire(line) {
  if (line?.kind !== PRUNE_THRESHOLD_KIND) return false;
  // Missing `crossed` = a pre-change line, and pre-change lines were fires.
  return line.crossed === undefined ? true : line.crossed === true;
}

/**
 * The fire count over a list of journal lines.
 * @param {object[]} lines - parsed journal records, in order.
 * @returns {number}
 */
export function countPruneFires(lines) {
  return (Array.isArray(lines) ? lines : []).filter((line) => isPruneFire(line)).length;
}
