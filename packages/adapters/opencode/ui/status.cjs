/**
 * CREMATOR's status helper for the OpenCode parts (ISSUE-551, ADR-0073).
 *
 * One implementation turns the host's own message shapes into the three facts
 * the status surfaces show: how full the context is, how large the last applied
 * pass was, and the label both the desktop composer pill and the terminal
 * `/cremate` command display. Plain CommonJS, so the terminal part (ESM) can
 * default-import it. The desktop GUI bundle inlines a copy: its loader shares no
 * local module (ISSUE-604).
 *
 * Context fill follows the host's own rule: the newest assistant step that
 * carries token usage, after the last compaction that COMPLETED, and before the
 * revert boundary when one is given. A compaction that failed or is still
 * running does not reset the count.
 *
 * The byte figure a pass reports is the sum of whole-unit lengths, so a removal
 * that drops only part of a unit overstates the bytes it freed. The label
 * therefore prints the byte figure as approximate (`~`), never exact.
 */

'use strict';

/** Usage fields summed by `usedTokens`, matching the host's `TokenUsage` shape. */
const TOKEN_FIELDS = Object.freeze(['input', 'output', 'reasoning']);
const CACHE_FIELDS = Object.freeze(['read', 'write']);

const KB = 1024;
const MB = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The tokens one step billed: input, cache read, cache write, output, reasoning.
 * `null` when the message carries no `tokens` object at all; a present object
 * with absent fields sums to 0.
 */
function usedTokens(message) {
  if (!isObject(message)) return null;
  const tokens = message.tokens;
  if (!isObject(tokens)) return null;
  let total = 0;
  for (const field of TOKEN_FIELDS) total += count(tokens[field]);
  const cache = tokens.cache;
  for (const field of CACHE_FIELDS) total += count(isObject(cache) ? cache[field] : 0);
  return total;
}

/**
 * The newest assistant message carrying `tokens`, after the last compaction
 * whose `status` is `completed`, and before `boundaryMessageID` when given.
 *
 * `boundaryMessageID` is the message the user reverted to; anything at or after
 * it is not part of the live prompt. An unknown boundary is ignored, so a
 * caller that reads a stale id still gets the current step instead of nothing.
 */
function lastAssistantWithUsage(messages, boundaryMessageID) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isObject(message) && message.type === 'compaction' && message.status === 'completed') {
      start = index + 1;
      break;
    }
  }

  let end = messages.length;
  if (typeof boundaryMessageID === 'string' && boundaryMessageID !== '') {
    const boundary = messages.findIndex((message) => isObject(message) && message.id === boundaryMessageID);
    if (boundary >= 0) end = boundary;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (!isObject(message)) continue;
    if (message.type !== 'assistant') continue;
    if (!isObject(message.tokens)) continue;
    return message;
  }
  return null;
}

/**
 * `{ used, limit, percent }` for one session, or all nulls when the host has
 * not reported a usage-bearing assistant step or a positive model limit yet.
 * `percent` is rounded and clamped to 0..100.
 */
function contextStatus(input) {
  const source = isObject(input) ? input : {};
  const used = usedTokens(lastAssistantWithUsage(source.messages, source.boundary));
  const limit = source.limit;
  if (used === null || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return { used: null, limit: null, percent: null };
  }
  const percent = Math.round((used / limit) * 100);
  return { used, limit, percent: percent < 0 ? 0 : percent > 100 ? 100 : percent };
}

/** One decimal place, dropping a trailing `.0`; used for KB and MB. */
function oneDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** `512 B`, `1.5 KB`, `2 MB`. Non-finite and negative input formats as `0 B`. */
function formatBytes(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value >= MB) return `${oneDecimal(value / MB)} MB`;
  if (value >= KB) return `${oneDecimal(value / KB)} KB`;
  return `${Math.round(value)} B`;
}

/**
 * `1 unit · ~1.5 KB` — the units a pass removed and its approximate byte size.
 * The tilde is deliberate: the reported bytes sum whole-unit lengths, so a
 * partial removal overstates what actually left the prompt.
 */
function passLabel(pass) {
  const source = isObject(pass) ? pass : {};
  const removals = typeof source.removals === 'number' && Number.isFinite(source.removals) && source.removals > 0
    ? Math.floor(source.removals)
    : 0;
  const bytes = typeof source.bytes === 'number' && Number.isFinite(source.bytes) && source.bytes > 0
    ? source.bytes
    : 0;
  return `${removals} ${removals === 1 ? 'unit' : 'units'} · ~${formatBytes(bytes)}`;
}

/**
 * Plain text for a refusal reason. A refusal is not a failure: "no rows" means
 * the pass ran and found nothing to table, so the surfaces show it as a normal
 * notice instead of an error. An unknown reason names itself.
 */
const REFUSAL_TEXT = Object.freeze({
  'no-rows': 'Nothing to cremate.',
  'no-session': 'No chat request to cremate yet.',
  'no-array': 'No chat request to cremate yet.',
  'ask-off': 'Cremation is off for this install.',
  'ask-in-flight': 'A cremation is already running.',
  'ask-standdown': 'Cremation skipped: the ledger is not healthy.',
  'claimed-unit': 'Nothing new to cremate.',
  'claimed-revision': 'This request was already cremated.',
  'request-unreadable': 'The saved request could not be read.',
  'closing': 'Cremation is shutting down.',
  'no-fire': 'Nothing was removed.',
});

function refusalText(reason) {
  const named = typeof reason === 'string' && reason !== '' ? reason : 'no reason given';
  return REFUSAL_TEXT[named] ?? `Cremation: ${named}.`;
}

module.exports = {
  usedTokens,
  lastAssistantWithUsage,
  contextStatus,
  formatBytes,
  passLabel,
  refusalText,
};
