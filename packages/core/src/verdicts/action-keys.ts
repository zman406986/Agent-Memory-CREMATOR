/**
 * One normalizer for a model-written action key (ISSUE-515).
 *
 * Every reader below this point used to compare the key byte for byte, so a
 * verdict that spelled the same action in another case or number was refused
 * even when it could mean only one thing: `KEEPLINES`, `keepline`, `KEEPline`,
 * `keepLines`, `ForgetAll`, `FORGETALL`. Case and a trailing `s` do not name a
 * different action, so one helper decides what a key means and every parse
 * point calls it. The prompt still teaches the canonical plural spelling; this
 * is reader leniency, not a second grammar.
 *
 * The rule is mechanical and narrow:
 *
 * 1. lowercase the key;
 * 2. drop at most ONE trailing `s`;
 * 3. map that singular to the canonical plural action.
 *
 * So `keepall`, `KEEPALL`, `keepAll` and `keepalls` all read `keepall`;
 * `keeplines`, `keepline`, `KEEPline` and `keepLines` all read `keeplines`, and
 * the same for `forgetall` and `forgetlines`. Anything else returns null and
 * stays unknown: `kleplines` is still a misspelling, `summary` is not an
 * action, and a key with a trailing space is not a spelling of anything.
 *
 * Normalization never merges keys. A row carrying two action keys that both
 * normalize to one action is still a row with two action keys, and the caller
 * refuses it as mixed; this helper only says what one key means.
 */

/** The four canonical action keys, in the wire's own order. */
export const CANONICAL_ACTION_KEYS = ["keepall", "keeplines", "forgetall", "forgetlines"] as const;

/** One action key in its canonical spelling. */
export type CanonicalActionKey = (typeof CANONICAL_ACTION_KEYS)[number];

/**
 * The canonical action a model-written key names, or null when it names none.
 * Case is folded and one trailing `s` is dropped before the lookup; no other
 * character is changed, removed or added.
 */
export function normalizeActionKey(raw: string): CanonicalActionKey | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase();
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  switch (singular) {
    case "keepall": return "keepall";
    case "keepline": return "keeplines";
    case "forgetall": return "forgetall";
    case "forgetline": return "forgetlines";
    default: return null;
  }
}
