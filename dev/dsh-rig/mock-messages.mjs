#!/usr/bin/env node
/**
 * Mock LLM for the dsh test rig — Anthropic Messages over SSE.
 *
 * Spec: `archive/2026-10-22-dsh-test-rig.md` §1 and §3. The `deepseek-official`
 * route posts to `{base}/v1/messages` and needs this frame order:
 *   message_start -> content_block_start -> (deltas) -> content_block_stop
 *     -> message_delta{stop_reason} -> message_stop
 * A stream that ends before `message_stop` is STREAM_CLOSED on the host side; a
 * stream with no blocks and `stop_reason: end_turn` is EMPTY_RESPONSE. Both are
 * deliberate reply shapes here, for the negative legs.
 *
 * Loopback only, node builtins only. Usage:
 *   node mock-messages.mjs --port 0 --port-file <file> --log <jsonl> --script <json>
 *
 * Script shape (JSON):
 *   {
 *     "title": "Rig session",                      // deterministic title reply
 *     "answers": { "entry": { "type": "text", "text": "..." } },  // optional
 *     "replies": [
 *       { "name": "first-turn",
 *         "match": { "tools_length": "present", "tool_results_count": 0,
 *                    "messages_length": 3, "body_text_contains": ["..."],
 *                    "last_user_text_matches": "^..." },
 *         "reply": { "type": "text", "text": "READY" } }
 *     ]
 *   }
 *
 * `answers.entry` is a reply object, or an ARRAY of them served one per entry
 * ask in order with the last entry repeating. A reply whose text carries
 * `{{shapeAnswer}}` must carry a `shape` value, which is expanded at load into
 * the text and validated as one of the three entry answers (see
 * `shapeAnswerText`); `keephead` is refused at load.
 *
 * Reply types: `text`, `tool_use`, `http_error`, `sse_error`, `truncated`.
 * A `text` reply may be the `{{tableAnswer}}` placeholder: it expands to one
 * keepall entry per row of the table ask being answered (see
 * `substituteTableAnswer`). A reply with no `match` is the fallback; with no
 * fallback an unmatched request is a loud 500 plus a `no-match` log record — a
 * vacuous default reply would make every rig gate green for the wrong reason.
 *
 * Entry asks (ISSUE-056 C9a) are classified by their END ANCHOR and route to
 * their own answer source, `answers.entry` — never to `replies`, because an
 * entry ask embeds the result's own bytes and a body-text matcher could route
 * it to a main row. An entry ask with no `answers.entry` is a loud 500
 * (`no-entry-answer-scripted`), never a silent "the result lands whole".
 *
 * Table asks — since ADR-0028 the bulk prune is the ONE asker — are classified
 * by the ask frame and answered from `replies` through `{{tableAnswer}}` /
 * `{{forgetallTableAnswer}}`. The removed judge pass had its own tool-less,
 * decision-line lane; that arm is gone, and a prune table of any row count is
 * the prune lane, never a second caller's.
 *
 * `tool_results_count` is an extension over the spec's matcher list: the turn
 * number in a tool-using conversation is exactly the count of `tool_result`
 * blocks the host has sent back, and `messages_length` shifts with injected
 * context messages.
 */
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

/** The dummy `x-api-key` the driver sets. The mock refuses anything else. */
export const DEFAULT_API_KEY = 'mock-key-not-real';
/** First line of the shipped title system prompt; answered before the script. */
export const TITLE_SYSTEM_MARKER = 'Create a concise title';
/**
 * The opening of the frame every table ask starts with (`ASK_FRAME` in
 * `packages/adapters/dsh/src/judge-tables.ts`). Since ADR-0028 the bulk prune is
 * the ONE table asker, and its ask is a fork of main's request, so it KEEPS the
 * tools array; a tool-count test cannot name it and this frame does. Copied, not
 * imported: this mock is a plain-Node harness and cannot import the workspace's
 * TypeScript. (A string that must never drift is READ from the core source
 * instead — see `PRUNE_ASK_FINAL_LINE` below.)
 */
export const TABLE_ASK_MARKER = "The messages above are main's production conversation";
/**
 * The table ask's closing line. Read from its one owner,
 * `packages/core/src/prune/ask-message.ts`, rather than copied (ISSUE-118): a
 * copy drifts silently, and ISSUE-110 already reworded the shipped line once.
 *
 * Read, not imported, because this mock is a plain-Node harness: it cannot
 * import the TypeScript source, and it is spawned without the test lane's
 * resolve hook and with no built `@cremator/core` to import from. The read is an
 * evaluated one, like `compositionRulesOf` in
 * `dev/bench/fixtures/sim/build-fixture.mjs`: the declaration is a concatenation
 * of two literals, so a regex scrape of the strings would not reproduce it.
 *
 * A missing or reshaped declaration throws at load. That is deliberate: a
 * harness that cannot read the line must refuse loudly, never fall back to a
 * stale copy and misroute a table ask.
 */
const PRUNE_ASK_SOURCE = fileURLToPath(
  new URL('../../packages/core/src/prune/ask-message.ts', import.meta.url),
);

/** The declaration's right-hand side, evaluated. */
function readShippedFinalLine() {
  let source;
  try {
    source = readFileSync(PRUNE_ASK_SOURCE, 'utf8');
  } catch (error) {
    throw new Error(`mock-messages: cannot read ${PRUNE_ASK_SOURCE}: ${error?.message ?? error}`);
  }
  const declaration = /export const PRUNE_ASK_FINAL_LINE =([^;]+);/u.exec(source);
  if (declaration === null) {
    throw new Error(`mock-messages: ${PRUNE_ASK_SOURCE} no longer declares PRUNE_ASK_FINAL_LINE`
      + '; the table lane cannot be routed without the shipped line');
  }
  // Parenthesized: the declaration's right-hand side starts on the next line, and a
  // bare `return` followed by a newline would end the statement (ASI) and yield
  // `undefined`.
  const value = new Function(`return (${declaration[1]});`)();
  if (typeof value !== 'string' || value === '') {
    throw new Error(`mock-messages: PRUNE_ASK_FINAL_LINE in ${PRUNE_ASK_SOURCE} is not a non-empty string`);
  }
  return value;
}

/** A prune ask is the only request that offers no tools and ends with this line. */
export const PRUNE_ASK_FINAL_LINE = readShippedFinalLine();
/**
 * First sentence of `compaction-basic`'s summarization directive
 * (`COMPACTION_INSTRUCTION`). The ask is an ordinary request that keeps the
 * conversation's tools, so it is neither tool-less like a table ask nor a main
 * turn: it is named by this prefix. Copied, not imported, for the same reason
 * as the two lines above.
 */
export const COMPACTION_ASK_PREFIX = 'You are now acting as a compaction engine';
/**
 * The end anchor that closes every entry ask — the LAST text of the ask's one
 * appended user message (`ENTRY_ASK_END_ANCHOR` in
 * `packages/core/src/rules/assets-templates.ts`, ISSUE-056 C9a). Copied, not
 * imported, for the same reason as the lines above; the copy is pinned to the
 * template by `mock-messages.test.mjs`, so a drift on either side is red, never
 * a silent lane change.
 *
 * The entry ask is a fork of main's request (ADR-0010) and therefore CARRIES
 * main's tools while embedding the incoming result's own bytes, which may
 * legitimately contain `TABLE_ASK_MARKER`. So the lane is named by the
 * END ANCHOR and nothing else: the ask's own body is untrusted for routing.
 */
export const ENTRY_ASK_END_ANCHOR = '[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]';
/**
 * The loud default for an entry ask with no scripted answer. An entry ask is
 * answered by `answers.entry`; when the script names none, the mock refuses
 * instead of serving some other lane's row or a vacuous reply — an unscripted
 * entry ask must fail visibly, never read as "the result landed whole".
 */
export const ENTRY_ANSWER_MISSING = 'no-entry-answer-scripted';
/**
 * The placeholder a scripted entry answer uses to name its answer's shape. An
 * entry answer is one of three JSON forms (ADR-0022 §9), and a scenario wants
 * to spell the shape once and reuse the reply text around it. The reply carries
 * the object under `shape`; the placeholder is replaced at load time and the
 * value is validated there, so a script that names `keephead` or a malformed
 * object is refused by the rig, never sent to the product as a legal answer.
 */
export const SHAPE_ANSWER_PLACEHOLDER = '{{shapeAnswer}}';
/**
 * The three entry answers, in the corrected grammar (ADR-0022 §9; ISSUE-058
 * C1). `keephead` is deliberately absent: it is not an entry answer any more,
 * and the rig must refuse it rather than let a stale scenario script it.
 */
export const ENTRY_SHAPE_ACTIONS = ['keepall', 'forgetall', 'keeplines'];
/**
 * The entry matcher: the escaped end anchor, then optional whitespace, then the
 * end of the message (`$`, not multiline). Escaping is required — the anchor
 * carries `[[`, `:`, `]]` — and the end anchoring is the whole guarantee: the
 * same anchor inside the copied result body must never classify the ask.
 */
const ENTRY_ASK_END_PATTERN = new RegExp(`${ENTRY_ASK_END_ANCHOR.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`, 'u');
/**
 * The tag `compaction-basic` wraps a landed checkpoint in. A request whose
 * history carries it is past a host compaction: its tool-result count no longer
 * follows the recording, so it is its own lane and never a main turn.
 */
export const CHECKPOINT_TAG = '<compacted-summary>';
/** Deterministic title reply when the script does not name one. */
export const DEFAULT_TITLE = 'Rig session';
/**
 * The placeholder a scripted reply uses to name the recall id the model can
 * read in its own transcript. A marker's id does not exist when the script is
 * written — it is minted by the run that caps the result — so a restart
 * scenario substitutes it from the request the mock is answering. A reply that
 * still carries the placeholder is refused (500 + a log record), never sent
 * with a literal token or an empty id; a vacuous substitution must fail loudly.
 */
export const RECALL_ID_PLACEHOLDER = '{{recallId}}';
/**
 * The placeholder a scripted reply uses to answer a TABLE ask. The
 * ask assigns its own indices at run time (1..12 per table, pass-wide across
 * tables), so a fixed JSON object cannot answer it. The mock expands this to
 * one `{"<index>":{"keepall":true}}` entry per row the request's own table
 * carries. A reply that still carries the placeholder without a table is
 * refused (500 + a log record), never sent with a literal token.
 */
export const TABLE_ANSWER_PLACEHOLDER = '{{tableAnswer}}';
/**
 * The placeholder a scripted reply uses to answer a TABLE ask with `forgetall`
 * for every row the ask carries. `{{tableAnswer}}` is the keepall arm; the
 * delay-ratio bench needs the other arm of the same contract, because a prune
 * pass that forgets nothing removes nothing and measures no delay. The reason
 * string is fixed so two runs produce byte-equal answers. A reply that still
 * carries the placeholder without a table is refused (500 + a log record),
 * never sent with a literal token.
 */
export const FORGETALL_TABLE_ANSWER_PLACEHOLDER = '{{forgetallTableAnswer}}';
/** The one reason string every `{{forgetallTableAnswer}}` row carries. */
export const FORGETALL_REASON = 'bench replay: prune row forgetall';
/**
 * The placeholder a scripted reply uses to answer a TABLE ask PARTIALLY: one
 * `keepall` entry for every assigned index EXCEPT the highest, which is
 * omitted. The parser reads an omitted index as a refusal (`missing-index`), so
 * the row is carried to the pass's one re-ask and then corrected — the path
 * ISSUE-120 exists to drive. Like the other two placeholders it must be the
 * whole reply text, and a request with no table rows is refused (500 + a log
 * record) rather than answered with a literal token.
 */
export const TABLE_PARTIAL_PLACEHOLDER = '{{partialTableAnswer}}';
/**
 * The first sentence of the table's heading (`PRUNE_ASK_TABLE_HEADING` in
 * `packages/core/src/prune/ask-message.ts`). It separates the ask's own rows
 * from the worked row inside the shipped system prompt, which also starts with
 * an index and a bracket.
 */
export const PRUNE_ASK_TABLE_HEADING = 'Units still in memory, by assigned index.';
/** One row's address as the table renders it: `2. [Read] ...`. */
const TABLE_ROW_PATTERN = /^(\d+)\. \[/gmu;
/** The one id spelling a cap marker prints (`capMarker` in the core). */
const RECALL_ID_PATTERN = /recall:sha256:[0-9a-f]{64}/gu;
/** Only these host spellings may bind. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Encode one SSE frame. The host parser compares `event:` with `data.type`
 * and rejects a mismatch (MALFORMED_RESPONSE), so both always carry the same
 * string here.
 * @param {string} event - SSE event name.
 * @param {object} data - JSON payload; `data.type` equals `event`.
 * @returns {string} one framed event.
 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The word cap every entry summary shares with the shipped parser. */
export const SUMMARY_WORD_LIMIT = 25;

/**
 * The number of words in one summary, counted the shipped way: whitespace
 * runs, after trimming. Blank is zero words and legal.
 * @param {string} text
 * @returns {number}
 */
function summaryWordCount(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Validate one `shape` value and render it as the entry answer text. The value
 * must be exactly one of the three entry answers (ADR-0022 §9; ISSUE-058 C1),
 * one top-level key, the payload that key's form requires. `keephead` is
 * refused with its own message: it is no longer an entry answer, and a stale
 * scenario must fail at load rather than script a shape the product refuses.
 *
 * @param {unknown} shape - the scripted answer object.
 * @param {string} label - where the shape came from, for the error text.
 * @returns {string} the compact JSON text the reply serves.
 */
export function shapeAnswerText(shape, label = 'answers.entry') {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new Error(`rig script: ${label} shape must be a JSON object`);
  }
  const keys = Object.keys(shape);
  if (keys.length !== 1) {
    throw new Error(`rig script: ${label} shape must carry exactly one top-level key, saw ${keys.length}${keys.length === 0 ? '' : ` (${keys.join(', ')})`}`);
  }
  const action = keys[0];
  if (action === 'keephead') {
    throw new Error(`rig script: ${label} scripts keephead; the entry answers are exactly keepall, forgetall and keeplines (ADR-0022 §9, ISSUE-058 C1)`);
  }
  if (!ENTRY_SHAPE_ACTIONS.includes(action)) {
    throw new Error(`rig script: ${label} shape action ${JSON.stringify(action)} is not one of ${ENTRY_SHAPE_ACTIONS.join(', ')}`);
  }
  const payload = shape[action];
  if (action === 'keepall') {
    if (payload !== true) throw new Error(`rig script: ${label} keepall carries the boolean true and nothing else`);
    return '{"keepall":true}';
  }
  if (action === 'forgetall') {
    if (typeof payload !== 'string') throw new Error(`rig script: ${label} forgetall carries its summary as the value`);
    const words = summaryWordCount(payload);
    if (words > SUMMARY_WORD_LIMIT) {
      throw new Error(`rig script: ${label} forgetall summary is ${words} words; the cap is ${SUMMARY_WORD_LIMIT}`);
    }
    return JSON.stringify({ forgetall: payload });
  }
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error(`rig script: ${label} keeplines carries at least one [start,end] pair and a trailing summary string`);
  }
  const summary = payload[payload.length - 1];
  if (typeof summary !== 'string') {
    throw new Error(`rig script: ${label} keeplines ends with one summary string`);
  }
  const words = summaryWordCount(summary);
  if (words > SUMMARY_WORD_LIMIT) {
    throw new Error(`rig script: ${label} keeplines summary is ${words} words; the cap is ${SUMMARY_WORD_LIMIT}`);
  }
  for (const pair of payload.slice(0, -1)) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`rig script: ${label} keeplines carries an element that is not a [start,end] pair`);
    }
    const [from, to] = pair;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw new Error(`rig script: ${label} keeplines has a pair that is not two integers with 1 <= start <= end`);
    }
  }
  return JSON.stringify({ keeplines: payload });
}

/**
 * Expand `{{shapeAnswer}}` in one validated entry reply. The shape lives under
 * the reply's own `shape` key and is replaced at load time, so the served reply
 * carries the final text and the wire log can record exactly what the model
 * saw. Like the table placeholders, the placeholder must be the whole text
 * (surrounding whitespace is allowed): an entry answer is one JSON object, and
 * a reply that embeds it in prose can only be a scripting mistake.
 *
 * @param {object} reply - a reply that passed `validateReply`.
 * @param {string} label - where the reply came from, for the error text.
 * @returns {object} the reply with the placeholder expanded, `shape` removed.
 */
export function expandShapeAnswer(reply, label) {
  const hasShape = Object.hasOwn(reply, 'shape');
  const text = typeof reply.text === 'string' ? reply.text : '';
  const carries = text.includes(SHAPE_ANSWER_PLACEHOLDER);
  if (!hasShape && !carries) return reply;
  if (!carries) {
    throw new Error(`rig script: ${label} has a shape but its text carries no ${SHAPE_ANSWER_PLACEHOLDER}`);
  }
  if (!hasShape) {
    throw new Error(`rig script: ${label} carries ${SHAPE_ANSWER_PLACEHOLDER} but no shape value`);
  }
  if (text.trim() !== SHAPE_ANSWER_PLACEHOLDER) {
    throw new Error(`rig script: ${label} must carry ${SHAPE_ANSWER_PLACEHOLDER} as its whole text`);
  }
  const { shape, ...rest } = reply;
  return { ...rest, text: shapeAnswerText(shape, label) };
}

/**
 * Validate and normalise a script document.
 *
 * `answers.entry` is one reply object served to every entry ask, or an array
 * of them served one per ask in order with the last repeating (ISSUE-058
 * RIG-1). The array is what lets one run script different answers per result.
 *
 * @param {unknown} raw - parsed script JSON.
 * @returns {{title: string, entryAnswers: object[], replies: Array<{name: string, match: object|null, reply: object}>}}
 */
export function normalizeScript(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('rig script: top level must be a JSON object');
  }
  const title = raw.title ?? DEFAULT_TITLE;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('rig script: `title` must be a non-empty string');
  }
  const replies = raw.replies ?? [];
  if (!Array.isArray(replies)) throw new Error('rig script: `replies` must be an array');
  const answers = raw.answers ?? {};
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('rig script: `answers` must be an object');
  }
  // The entry lane is its own answer source (ISSUE-056 C9a): an entry ask
  // embeds the result's own bytes and must never consume a main row, so its
  // answer cannot live in `replies` where a body-text matcher could pick it.
  let entryAnswers = [];
  if ('entry' in answers) {
    const scripted = answers.entry;
    const list = Array.isArray(scripted) ? scripted : [scripted];
    if (list.length === 0) throw new Error('rig script: `answers.entry` must name at least one reply');
    entryAnswers = list.map((reply, index) => {
      const label = Array.isArray(scripted) ? `answers.entry[${index}]` : 'answers.entry';
      if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
        throw new Error(`rig script: \`${label}\` must be a reply object`);
      }
      validateReply(reply, label);
      return expandShapeAnswer(reply, label);
    });
  }
  return {
    title,
    entryAnswers,
    replies: replies.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') throw new Error(`rig script: reply ${index} is not an object`);
      const reply = entry.reply;
      if (reply === null || typeof reply !== 'object') throw new Error(`rig script: reply ${index} has no reply object`);
      validateReply(reply, `reply ${index}`);
      // `shape` is the entry lane's own scripting key; a main row that carries
      // one would be silently ignored, so it is refused by name.
      if (Object.hasOwn(reply, 'shape') || (typeof reply.text === 'string' && reply.text.includes(SHAPE_ANSWER_PLACEHOLDER))) {
        throw new Error(`rig script: reply ${index} scripts ${SHAPE_ANSWER_PLACEHOLDER}; the shape placeholder belongs to \`answers.entry\``);
      }
      const match = entry.match ?? null;
      if (match !== null && (typeof match !== 'object' || Array.isArray(match))) {
        throw new Error(`rig script: reply ${index} match must be an object`);
      }
      return { name: typeof entry.name === 'string' ? entry.name : `reply-${index}`, match, reply };
    }),
  };
}

const REPLY_TYPES = new Set(['text', 'tool_use', 'http_error', 'sse_error', 'truncated']);

/**
 * Validate one reply object in place.
 * @param {object} reply - candidate reply.
 * @param {string} label - where the reply came from, for the error text.
 */
function validateReply(reply, label) {
  if (!REPLY_TYPES.has(reply.type)) {
    throw new Error(`rig script: ${label} has unknown type ${JSON.stringify(reply.type)}`);
  }
  if ((reply.type === 'text' || reply.type === 'truncated') && typeof reply.text !== 'string') {
    throw new Error(`rig script: ${reply.type} ${label} needs a string text`);
  }
  if (reply.type === 'tool_use') {
    if (!Array.isArray(reply.calls) || reply.calls.length === 0) {
      throw new Error(`rig script: tool_use ${label} needs a non-empty calls array`);
    }
    for (const call of reply.calls) {
      if (typeof call.id !== 'string' || call.id === '') throw new Error(`rig script: tool_use ${label} has a call without id`);
      if (typeof call.name !== 'string' || call.name === '') throw new Error(`rig script: tool_use ${label} has a call without name`);
    }
  }
  if ((reply.type === 'http_error' || reply.type === 'sse_error') && (reply.error === null || typeof reply.error !== 'object')) {
    throw new Error(`rig script: ${reply.type} ${label} needs an error object`);
  }
}

/**
 * Replace every `{{recallId}}` in a reply with the recall id the request's own
 * transcript carries. A cap marker prints exactly one id; the model reads that
 * marker, so the mock must answer with an id it was shown, never with one the
 * scenario file guessed. More than one distinct id in the body is ambiguous and
 * is refused rather than picked.
 *
 * @param {object} reply - a validated reply.
 * @param {string} serialized - the raw request body.
 * @returns {{reply: object|null, error: string|null}}
 */
export function substituteRecallIds(reply, serialized) {
  const text = JSON.stringify(reply);
  if (!text.includes(RECALL_ID_PLACEHOLDER)) return { reply, error: null };
  const ids = [...new Set(serialized.match(RECALL_ID_PATTERN) ?? [])];
  if (ids.length === 0) {
    return { reply: null, error: 'the scripted reply asks for {{recallId}} but the request carries no cap marker' };
  }
  if (ids.length > 1) {
    return { reply: null, error: `the request carries ${ids.length} distinct recall ids; refusing to guess` };
  }
  return { reply: JSON.parse(text.split(RECALL_ID_PLACEHOLDER).join(ids[0])), error: null };
}

/**
 * Expand `{{tableAnswer}}` to the keepall answer, `{{forgetallTableAnswer}}`
 * to the forgetall answer, or `{{partialTableAnswer}}` to keepall for every
 * index but the highest, for the table the request carries. The indices are
 * read from the request's LAST user message, after the table heading, so the
 * worked row inside the shipped system prompt is never mistaken for an assigned
 * index. Extra keys are harmless — the parser rejects an index the ask did not
 * assign and no unit is affected — while a missing index keeps its unit (a
 * PARTIAL answer is how a row refuses on purpose); keepall changes nothing.
 *
 * @param {object} reply - a validated reply.
 * @param {string} serialized - the raw request body.
 * @returns {{reply: object|null, error: string|null}}
 */
export function substituteTableAnswer(reply, serialized) {
  if (reply === null || typeof reply !== 'object') return { reply, error: null };
  if (typeof reply.text !== 'string') return { reply, error: null };
  const partial = reply.text.includes(TABLE_PARTIAL_PLACEHOLDER);
  const forgetall = !partial && reply.text.includes(FORGETALL_TABLE_ANSWER_PLACEHOLDER);
  const keepall = !partial && !forgetall && reply.text.includes(TABLE_ANSWER_PLACEHOLDER);
  if (!partial && !forgetall && !keepall) return { reply, error: null };
  const placeholder = partial ? TABLE_PARTIAL_PLACEHOLDER
    : forgetall ? FORGETALL_TABLE_ANSWER_PLACEHOLDER : TABLE_ANSWER_PLACEHOLDER;
  if (reply.text !== placeholder) {
    return { reply: null, error: `the scripted ${placeholder} must be the whole reply text` };
  }
  let body;
  try {
    body = JSON.parse(serialized);
  } catch (error) {
    return { reply: null, error: `the request body is not JSON: ${error.message}` };
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  const text = Array.isArray(lastUser?.content)
    ? lastUser.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : typeof lastUser?.content === 'string' ? lastUser.content : '';
  const at = text.indexOf(PRUNE_ASK_TABLE_HEADING);
  const table = at < 0 ? text : text.slice(at);
  const indices = [...new Set([...table.matchAll(TABLE_ROW_PATTERN)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  if (indices.length === 0) {
    return { reply: null, error: `the scripted ${placeholder} but the request carries no table rows` };
  }
  const answering = partial ? indices.slice(0, -1) : indices;
  const answer = Object.fromEntries(answering.map((index) => [String(index),
    forgetall ? { forgetall: FORGETALL_REASON } : { keepall: true }]));
  return { reply: { ...reply, text: JSON.stringify(answer) }, error: null };
}

/**
 * True when the last user message's text ends with the entry ask's end anchor.
 * END-ANCHORED ONLY: the anchor is also written inside some entry asks' copied
 * result body, and the body is the very content the ask exists to show, so a
 * `body_text_contains` reading would classify by the payload. Exported so a
 * test can pin the predicate without rebuilding a request body.
 * @param {string} lastUserText - the last user message's joined text blocks.
 * @returns {boolean}
 */
export function isEntryAsk(lastUserText) {
  return typeof lastUserText === 'string' && ENTRY_ASK_END_PATTERN.test(lastUserText);
}

/**
 * Classify one decoded request body: title call, entry ask, table (prune) ask,
 * compaction ask, post-compaction turn, or a scripted main turn.
 *
 * The prune, compaction and entry lanes are facts about the request, not about
 * the script: each ask names itself in the text it appends to the conversation
 * (an end anchor or a final line for the asks, an instruction prefix for
 * compaction), and the post-compaction lane is named by the checkpoint tag the
 * host leaves in the history. Classifying them here keeps the driver's tool
 * assertions honest — an ask or a post-compaction turn is not a main turn gone
 * wrong — and lets `expect.mock.*Requests` count each lane from the wire side.
 *
 * The entry arm runs FIRST (ISSUE-056 C9a): an entry ask is a fork that keeps
 * main's tools and embeds the result's own bytes, which may carry either the
 * table marker or the compaction prefix. Its end anchor is the only fact the
 * ask's payload cannot forge, and testing it before every other arm is what
 * keeps `mainRequests` meaning "turns the agent loop sent".
 *
 * A table ask is the bulk prune and nothing else (ADR-0028): the judge pass's
 * tool-less decision-line arm is deleted with the pass, so a 1-row table — the
 * normal tail of a pass — is the prune lane exactly as a 12-row one is.
 * @param {object} body - decoded JSON request body.
 * @returns {{kind: 'title'|'entry'|'prune'|'compaction'|'post-compaction'|'main', tools: unknown[], toolResults: number, lastUserText: string, lastAssistantToolNames: string[]}}
 */
export function classifyRequest(body) {
  const system = typeof body?.system === 'string' ? body.system : '';
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolResults = messages
    .filter((message) => message?.role === 'user' && Array.isArray(message.content))
    .flatMap((message) => message.content)
    .filter((block) => block?.type === 'tool_result').length;
  const userMessages = messages.filter((message) => message?.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserText = Array.isArray(lastUser?.content)
    ? lastUser.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : typeof lastUser?.content === 'string' ? lastUser.content : '';
  // The table and compaction arms are decided before the post-compaction arm:
  // both ask for text and neither of them is a main turn, but a table ask ends
  // with the prune final line, while compaction starts with its instruction. An
  // ask that carries the instruction is a compaction ask whatever else is in it.
  const asksCompaction = lastUserText.includes(COMPACTION_ASK_PREFIX);
  const asksTable = lastUserText.includes(TABLE_ASK_MARKER)
    || messages.some((message) => Array.isArray(message?.content)
      && message.content.some((block) => block?.type === 'text'
        && typeof block.text === 'string' && block.text.includes(TABLE_ASK_MARKER)));
  // The entry arm comes before the table arm: the ask frame is the only thing
  // that names a table, but an entry ask's embedded body can carry the frame
  // string too, and only the entry ask ends with its anchor.
  const kind = isEntryAsk(lastUserText) ? 'entry'
    // The table arm comes next: a fork seeded from the title call carries the
    // title system prompt, and the ask frame is the only thing that names it.
    : asksTable ? 'prune'
    : system.includes(TITLE_SYSTEM_MARKER) ? 'title'
      : tools.length === 0 && lastUserText.trimEnd().endsWith(PRUNE_ASK_FINAL_LINE) ? 'prune'
        : asksCompaction ? 'compaction'
          // Lanes below are only reachable after the host rewrote the history;
          // a request that still looks like the record stays `main`.
          : messages.some((message) => Array.isArray(message?.content)
            && message.content.some((block) => block?.type === 'text' && block.text.includes(CHECKPOINT_TAG))) ? 'post-compaction'
            : 'main';
  return {
    kind,
    tools,
    toolResults,
    lastUserText,
    lastAssistantToolNames: lastAssistantToolNames(body),
  };
}

/**
 * Names of the `tool_use` blocks in the newest assistant message, in order.
 * This is the second half of the replay matcher key (`tool_results_count` is
 * the first): a replayed conversation is identified by how far the tool-result
 * count has advanced and which tools the host ran to get there.
 * @param {object} body
 * @returns {string[]}
 */
export function lastAssistantToolNames(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.filter((block) => block?.type === 'tool_use').map((block) => String(block.name));
  }
  return [];
}

/**
 * The compiled `last_user_text_matches` pattern for one matcher, cached on the
 * matcher object so a request does not recompile it. A pattern that will not
 * compile is null here; `main` refuses such a script at load, so a served
 * request never meets one (ISSUE-581).
 * @param {object} match
 * @returns {RegExp|null}
 */
const matcherRegexes = new WeakMap();
function matcherRegex(match) {
  if (matcherRegexes.has(match)) return matcherRegexes.get(match);
  let re = null;
  try {
    re = new RegExp(match.last_user_text_matches, 'u');
  } catch {
    re = null;
  }
  matcherRegexes.set(match, re);
  return re;
}

/**
 * Test one matcher against a request. Every present field must hold (AND).
 * @param {object} match - matcher from the script.
 * @param {{body: object, serialized: string, tools: unknown[], toolResults: number, lastUserText: string, lastAssistantToolNames?: string[]}} ctx
 * @returns {boolean}
 */
export function matches(match, ctx) {
  if (match === null || match === undefined) return true;
  if ('tools_length' in match) {
    const want = match.tools_length;
    const have = ctx.tools.length;
    if (want === 'present' ? have === 0 : want === 'absent' ? have !== 0 : have !== want) return false;
  }
  if ('messages_length' in match && (ctx.body.messages?.length ?? 0) !== match.messages_length) return false;
  if ('tool_results_count' in match && ctx.toolResults !== match.tool_results_count) return false;
  if ('last_assistant_tool_names' in match) {
    const want = match.last_assistant_tool_names;
    const have = ctx.lastAssistantToolNames ?? [];
    const wanted = Array.isArray(want) ? want : [want];
    if (have.length !== wanted.length || have.some((name, index) => name !== wanted[index])) return false;
  }
  if ('body_text_contains' in match) {
    const needles = Array.isArray(match.body_text_contains) ? match.body_text_contains : [match.body_text_contains];
    for (const needle of needles) {
      if (typeof needle !== 'string' || !ctx.serialized.includes(needle)) return false;
    }
  }
  if ('last_user_text_matches' in match) {
    const re = matcherRegex(match);
    if (re === null || !re.test(ctx.lastUserText)) return false;
  }
  return true;
}

/**
 * Pick the first reply whose matcher holds.
 * @returns {{entry: object|null}}
 */
export function pickReply(script, ctx) {
  for (const entry of script.replies) {
    if (matches(entry.match, ctx)) return { entry };
  }
  return { entry: null };
}

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * The text one served reply carries, for the wire log. Non-text replies (a
 * tool_use, an error shape) carry no answer text and log `null`; the entry lane
 * serves text only, so this is the exact string the model was handed.
 * @param {object} reply
 * @returns {string|null}
 */
function answerText(reply) {
  return typeof reply?.text === 'string' ? reply.text : null;
}

function textBlock(text) {
  return { kind: 'text', text };
}

function toolBlock(call) {
  return { kind: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} };
}

function startMessage(res, inputTokens, blocks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(sseFrame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_rig',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }));
  let chars = 0;
  blocks.forEach((block, index) => {
    if (block.kind === 'text') {
      res.write(sseFrame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      if (block.text.length > 0) {
        res.write(sseFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
      }
      chars += block.text.length;
    } else {
      const json = JSON.stringify(block.input);
      res.write(sseFrame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      }));
      res.write(sseFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }));
      chars += json.length;
    }
    res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
  });
  return chars;
}

function endMessage(res, stopReason, chars) {
  res.write(sseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: estimateTokens(chars) },
  }));
  res.write(sseFrame('message_stop', { type: 'message_stop' }));
  res.end();
}

/**
 * Write one scripted reply.
 * @param {import('node:http').ServerResponse} res
 * @param {object} reply - validated reply.
 * @param {number} inputTokens - input token estimate from the request body size.
 */
export function sendReply(res, reply, inputTokens) {
  if (reply.type === 'http_error') {
    const status = Number.isInteger(reply.status) ? reply.status : 400;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: reply.error }));
    return;
  }
  if (reply.type === 'sse_error') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(sseFrame('error', { type: 'error', error: reply.error }));
    res.end();
    return;
  }
  if (reply.type === 'truncated') {
    // startMessage sets the headers. Deliberately no message_delta /
    // message_stop: the host must report STREAM_CLOSED and must not treat the
    // turn as a cappable result.
    startMessage(res, inputTokens, [textBlock(reply.text)]);
    res.end();
    return;
  }
  const blocks = [];
  if (typeof reply.text === 'string' && reply.text.length > 0) blocks.push(textBlock(reply.text));
  if (reply.type === 'tool_use') for (const call of reply.calls) blocks.push(toolBlock(call));
  const chars = startMessage(res, inputTokens, blocks);
  endMessage(res, reply.stop_reason ?? (reply.type === 'tool_use' ? 'tool_use' : 'end_turn'), chars);
}

function replyTitle(res, script, inputTokens) {
  sendReply(res, { type: 'text', text: script.title, stop_reason: 'end_turn' }, inputTokens);
}

const RETENTION_HEADERS = ['user-agent', 'anthropic-version', 'content-type', 'accept', 'anthropic-beta'];
const HARNESS_HEADER_PREFIX = 'x-deepseek-harness-';

function redactHeaders(headers, expectedKey) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (RETENTION_HEADERS.includes(lower) || lower.startsWith(HARNESS_HEADER_PREFIX)) kept[lower] = value;
  }
  const presented = headers['x-api-key'];
  const authOk = presented === expectedKey;
  if (presented !== undefined) kept['x-api-key'] = authOk ? '<dummy>' : '<mismatch>';
  return { kept, authOk, presented: presented !== undefined };
}

const MOCK_MESSAGES_OPTIONS = optionsOf([
  ['--port', 'string'],
  ['--host', 'string'],
  ['--log', 'string'],
  ['--script', 'string'],
  ['--port-file', 'string', 'portFile'],
  ['--expect-api-key', 'string', 'expectApiKey'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: MOCK_MESSAGES_OPTIONS,
    prefix: 'mock-messages: ',
    help: 'usage: mock-messages.mjs --port <n> --log <jsonl> --script <json> [--host 127.0.0.1]'
      + ' [--port-file <file>] [--expect-api-key <key>]\n',
  });
  const opts = {
    port: values.port === undefined ? 0 : Number(values.port),
    host: values.host ?? '127.0.0.1',
    log: values.log ?? null,
    script: values.script ?? null,
    portFile: values.portFile ?? null,
    expectApiKey: values.expectApiKey ?? DEFAULT_API_KEY,
  };
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('mock-messages: --port must be 0..65535');
  if (opts.log === null) throw new Error('mock-messages: --log is required');
  if (opts.script === null) throw new Error('mock-messages: --script is required');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    process.stderr.write(`mock-messages: refusing non-loopback host ${JSON.stringify(opts.host)}; loopback only (spec §3)\n`);
    process.exit(2);
  }
  let script;
  try {
    script = normalizeScript(JSON.parse(readFileSync(opts.script, 'utf8')));
    // Every pattern is compiled here, before the server starts serving: a bad
    // one refuses the script by name instead of killing the mock mid-run
    // (ISSUE-581).
    for (const entry of script.replies) {
      const pattern = entry?.match?.last_user_text_matches;
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'u');
      } catch (error) {
        throw new Error(`invalid last_user_text_matches regex ${JSON.stringify(pattern)}: ${error.message}`);
      }
    }
  } catch (error) {
    process.stderr.write(`mock-messages: ${error.message}\n`);
    process.exit(2);
  }

  let requests = 0;
  // How many entry asks this run served, for the `answers.entry` queue. It is
  // the ask ordinal, not the request number: main, title and prune requests
  // never advance it.
  let entryAsksServed = 0;
  const server = createServer((req, res) => {
    const started = Date.now();
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      const url = req.url ?? '/';
      const path = url.split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', requests }));
        return;
      }
      requests += 1;
      const n = requests;
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      let parseError = null;
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw);
      } catch (error) {
        parseError = error.message;
      }
      const { kept, authOk, presented } = redactHeaders(req.headers, opts.expectApiKey);

      if (req.method !== 'POST' || (path !== '/v1/messages' && path !== '/messages')) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body: parseError === null ? body : raw, matched: 'unrouted', kind: 'unrouted', latency_ms: Date.now() - started });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', message: `no route for ${req.method} ${path}` } }));
        return;
      }
      if (presented && !authOk) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'auth-mismatch', kind: 'auth', latency_ms: Date.now() - started, auth_ok: false });
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'x-api-key does not equal the rig dummy key' } }));
        return;
      }
      if (parseError !== null) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body: raw, matched: 'invalid-json', kind: 'invalid', latency_ms: Date.now() - started });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `request body is not JSON: ${parseError}` } }));
        return;
      }

      const classified = classifyRequest(body);
      const inputTokens = estimateTokens(raw.length);
      if (classified.kind === 'title') {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'title', kind: 'title', latency_ms: Date.now() - started });
        replyTitle(res, script, inputTokens);
        return;
      }
      const ctx = { body, serialized: raw, tools: classified.tools, toolResults: classified.toolResults, lastUserText: classified.lastUserText, lastAssistantToolNames: classified.lastAssistantToolNames };
      // The entry lane answers from `answers.entry` alone (ISSUE-056 C9a). It
      // never consults `replies`: an entry ask carries the result's own bytes,
      // and a body-text matcher could route it to a main or table row. With no
      // scripted answer the mock refuses loudly — a vacuous reply would read as
      // "the result landed whole" and hide a dead entry seam (design G7).
      if (classified.kind === 'entry') {
        // `answers.entry` is a queue: ask 1 gets entry 1, ask 2 entry 2, and the
        // last entry repeats for every later ask. A single reply object is the
        // one-entry queue, so the old behaviour is unchanged.
        if (script.entryAnswers.length === 0) {
          record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: ENTRY_ANSWER_MISSING, kind: 'entry', latency_ms: Date.now() - started });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'rig_no_entry_answer', message: `entry ask ${n} reached the rig, but the script names no answers.entry` } }));
          return;
        }
        // The slot is the ASK's ordinal: an ask consumes its entry even when the
        // answer is then refused, so a later ask cannot silently move up one.
        const answerIndex = Math.min(entryAsksServed, script.entryAnswers.length - 1);
        entryAsksServed += 1;
        const entryAnswer = script.entryAnswers[answerIndex];
        const resolved = substituteRecallIds(entryAnswer, raw);
        if (resolved.error !== null) {
          record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'recall-placeholder', kind: 'entry', latency_ms: Date.now() - started, answer_index: answerIndex, error: resolved.error });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'rig_recall_placeholder', message: resolved.error } }));
          return;
        }
        // The answer rides the record so an offline harvest can join ask to
        // answer without replaying the SSE stream: `answer` is the exact text
        // the model was served, and `answer_index` names its queue slot.
        record({
          n,
          method: req.method,
          url,
          headers_redacted: kept,
          body_bytes: bytes,
          body,
          matched: 'entry-answer',
          kind: 'entry',
          latency_ms: Date.now() - started,
          answer_index: answerIndex,
          answer: answerText(resolved.reply),
        });
        sendReply(res, resolved.reply, inputTokens);
        return;
      }
      const { entry } = pickReply(script, ctx);
      // The record's kind is the classified lane, not a constant: a table ask
      // that matched a row is still the prune lane on the wire, and the driver
      // counts each lane separately.
      if (entry === null) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'no-match', kind: classified.kind, latency_ms: Date.now() - started });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rig_no_match', message: `no scripted reply matched request ${n}` } }));
        return;
      }
      record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: entry.name, kind: classified.kind, latency_ms: Date.now() - started });
      // A placeholder-bearing row is resolved against this request's own body,
      // so a restart scenario can name a recall id the run minted. A refused
      // substitution is a loud 500, exactly like a missing row.
      const resolved = substituteRecallIds(entry.reply, raw);
      if (resolved.error !== null) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'recall-placeholder', kind: classified.kind, latency_ms: Date.now() - started, error: resolved.error });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rig_recall_placeholder', message: resolved.error } }));
        return;
      }
      // The table answer is expanded against this request's own ask, for the
      // same reason: the indices are the pass's, not the script's.
      const tabled = substituteTableAnswer(resolved.reply, raw);
      if (tabled.error !== null) {
        record({ n, method: req.method, url, headers_redacted: kept, body_bytes: bytes, body, matched: 'table-answer', kind: classified.kind, latency_ms: Date.now() - started, error: tabled.error });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rig_table_answer', message: tabled.error } }));
        return;
      }
      sendReply(res, tabled.reply, inputTokens);
    });
  });

  function record(entry) {
    appendFileSync(opts.log, `${JSON.stringify(entry)}\n`);
  }

  server.on('error', (error) => {
    process.stderr.write(`mock-messages: server error: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(opts.port, opts.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : opts.port;
    if (opts.portFile !== null) writeFileSync(opts.portFile, String(port));
    process.stdout.write(`${JSON.stringify({ event: 'listening', host: opts.host, port })}\n`);
  });

  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
    // A held socket must not keep the mock alive after the driver is done with it.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
