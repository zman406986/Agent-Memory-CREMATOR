/**
 * The byte-level outcome of one scripted `edit`, decided from text alone.
 *
 * Why this file exists. `bench-run.mjs` replays a recorded script to predict
 * which tool calls MUST fail, then compares that prediction with what the host
 * actually reported (`fidelity: tool failures are exactly the scripted
 * constant`). The prediction is built by applying each scripted edit to the
 * arm's copy and then running the next edit against the result, so a single
 * mis-written byte changes every later answer that matches on it.
 *
 * The defect it closes (ISSUE-173, ISSUE-172's class). The edit was applied
 * with `String.prototype.replace(old, new)` — a STRING replacement, which runs
 * `GetSubstitution` over `new`. A recorded `new_string` is model output, i.e.
 * arbitrary bytes: `$$`, `$&`, `` $` ``, `$'` and `$n` inside it are expanded
 * instead of inserted, so the simulated file diverged from the host's and the
 * predicted failure multiset drifted from the observed one. The fix is a
 * function replacement; escaping the `$` signs was never an option, because
 * that writes bytes the host did not write.
 *
 * The launcher runs `main()` only when invoked directly (`invokedDirectly`);
 * the decision lives here, pure and importable, and the launcher keeps only
 * the observation bookkeeping around it.
 */

/**
 * Replace the FIRST occurrence of `find` in `text` with `replacement`, verbatim.
 *
 * Equivalent to `text.replace(find, () => replacement)` and to a two-slice
 * splice, and to neither `text.replace(find, replacement)` nor a `/$/` escape:
 * the replacement goes in as the bytes it already is. An absent `find` leaves
 * `text` untouched; an empty `find` inserts at the front, which is what the
 * host's own first-occurrence rule would do.
 * @param {string} text
 * @param {string} find
 * @param {string} replacement
 * @returns {string}
 */
export function spliceFirstOccurrence(text, find, replacement) {
  const at = text.indexOf(find);
  if (at === -1) return text;
  return `${text.slice(0, at)}${replacement}${text.slice(at + find.length)}`;
}

/**
 * One scripted `edit` decided from the bytes, before any observation policy.
 *
 * `FS_EDIT_NOT_FOUND` when the recorded `old_string` is not in the file the arm
 * holds — a replayed edit carries prose from another repository, so this is an
 * expected, counted outcome, not a defect. `text: null` when the call carries
 * no `old_string`: the bench has never simulated such an edit (it has no find
 * to apply), and returning null keeps the caller from writing a file it would
 * not have touched.
 *
 * `FS_NOT_FOUND` (the target does not exist) and `FS_NOT_OBSERVED` (the session
 * never read the target) are the caller's: they depend on the session's
 * observation map, not on bytes.
 * @param {string|null} before - the file's current text, or null when absent.
 * @param {string|null} oldText - the call's `old_string`, or null when absent.
 * @param {unknown} newString - the call's `new_string`; non-strings count as ''.
 * @returns {{code: string} | {text: string|null}}
 */
export function applyScriptedEdit(before, oldText, newString) {
  if (before === null) return { code: 'FS_NOT_FOUND' };
  if (oldText === null) return { text: null };
  if (!before.includes(oldText)) return { code: 'FS_EDIT_NOT_FOUND' };
  return { text: spliceFirstOccurrence(before, oldText, typeof newString === 'string' ? newString : '') };
}
