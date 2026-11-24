/**
 * The platform timer ceiling for `dev/` (ISSUE-580).
 *
 * `setTimeout` and `setInterval` take a delay as a signed 32-bit integer; a
 * larger value overflows to 1 ms. Every dev launcher validated its delay as
 * "a number, not too small" and never the ceiling, so the "no limit" an
 * operator typed (`--kill-ms 3000000000`) ended a live run before its first
 * turn, and an oversized poll interval polled about a thousand times a second.
 *
 * The helper returns the refusal text rather than throwing: the six sites
 * refuse through four different channels (`{ ok, message }`, `TypeError`,
 * `refuse(message)`, `refuse(code, detail)`), and each keeps its own.
 */

/** The largest delay `setTimeout`/`setInterval` represent, in ms (2^31-1). */
export const MAX_PLATFORM_TIMER_MS = 2_147_483_647;

/**
 * The refusal text for a delay or interval above the platform maximum, naming
 * the argument and the ceiling; `null` when the value is representable.
 *
 * @param {number} ms - the already-parsed value (a non-safe integer is above
 *   the ceiling too, so this alone catches `1e300`).
 * @param {string} flag - the user-facing argument, e.g. `--kill-ms`.
 * @returns {string|null}
 */
export function timerDelayRefusal(ms, flag) {
  if (!(ms > MAX_PLATFORM_TIMER_MS)) return null;
  return `${flag} must be at most ${MAX_PLATFORM_TIMER_MS} ms (2^31-1, the`
    + ` largest timer delay a platform can represent); a larger delay fires at 1 ms`;
}
