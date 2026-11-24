/**
 * The one `median` for `dev/` (ISSUE-072).
 *
 * Three copies existed: `score.mjs` returned the unrounded midpoint of an
 * even-length sample, `select.mjs` and `lanes.mjs` wrapped the same midpoint in
 * `Math.round`. One record could therefore print two medians half a unit apart
 * depending on which copy produced it.
 *
 * This one does not round. Rounding is a presentation choice, and a statistic
 * that silently quantizes is wrong for the ratio call sites in `score.mjs`
 * (a median ratio of 1.5 must stay 1.5). The two call sites that want an
 * integer count keep their `Math.round` at the call site, which reproduces the
 * old arithmetic exactly — `Math.round` of an odd sample is a no-op, and of the
 * old even-case midpoint it is by definition the same value.
 */

/**
 * @param {number[]} values - any order; not mutated.
 * @returns {number|null} the middle value, the mean of the two middle values
 *          for an even count, or `null` for an empty sample.
 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
