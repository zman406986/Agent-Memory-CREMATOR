#!/usr/bin/env node
/**
 * Mock model for the opencode bench — OpenAI-compatible chat completions over SSE.
 *
 * The dsh rig's mock (`dev/dsh-rig/mock-messages.mjs`) speaks Anthropic Messages;
 * opencode 2.4.0's `openai-compatible` provider posts `{baseURL}/chat/completions`
 * and reads `chat.completion.chunk` frames, so it needs its own loopback server.
 * The frame shape below is the one a probe against `opencode --standalone run`
 * accepted: role delta, content delta, a finish chunk, then one full
 * `chat.completion` frame carrying the message and usage, then `[DONE]`.
 *
 * Loopback only, node builtins only. Usage:
 *   node opencode-mock-model.mjs --port 0 --port-file <file> --log <jsonl> --script <json>
 *
 * Script shape (JSON):
 *   {
 *     "model": "mock-model",
 *     "title": "offline bench",                    // the title request's reply
 *     "replies": [
 *       { "name": "failed-read",
 *         "match": { "tool_results_count": 0 },
 *         "reply": { "type": "tool_use", "reasoning": "…thinking…", "text": "…",
 *                    "calls": [{ "id": "call_1", "name": "read",
 *                                "input": { "path": "missing.txt" } }] } },
 *       { "name": "done",
 *         "match": { "tool_results_count": 2 },
 *         "reply": { "type": "text", "text": "DONE" } }
 *     ]
 *   }
 *
 * A `match` may state `tool_results_count` (exact count of `role: "tool"`
 * messages), `tools_include` / `tools_absent` (a tool name the request's own
 * table must carry or not carry), `tools_present` (boolean), and `main_turn`
 * (0-based index of the main requests already answered — the only matcher a
 * replayed session can use, because a replay's tool-result count is the seeded
 * history's, not the script's). The FIRST matching reply wins; a reply with no
 * `match` is the fallback. No match is a loud 500 plus a `matched_reply: null`
 * log row — a vacuous default would make every gate green for the wrong reason.
 *
 * A reply may carry `reasoning` (ADR-0045). It is streamed as a
 * `reasoning_content` delta BEFORE the content delta — the field
 * `@opencode/ai` reads back (`reasoning_content` / `reasoning` / `reasoning_text`
 * are all accepted; `reasoning_content` is the one it replays). Each request row
 * records the reasoning its ASSISTANT messages carried (`reasoning_messages`,
 * `reasoning_bytes`, `reasoning_fields`) and the reasoning this server emitted
 * (`reply_reasoning_frames`, `reply_reasoning_bytes`), so a lane can assert that
 * the request following a reasoning turn carries that reasoning back. Only
 * `role: "assistant"` messages are counted: a reasoning field on any other role
 * is not the agent's thinking and would make the pin pass for the wrong reason.
 *
 * Requests are classified by their own body. The bench-only entry ask is named
 * first: a request whose LAST message carries the `jsonl-20-nokeepall`
 * pre-table contract, a table, the post-table repeat and the end anchor is
 * `ask` (it keeps the session's tools, so a tool count would call it `main`),
 * and it gets a dedicated reply built from its own table.
 * A request carrying the host's compaction prompt is `compaction` whatever its
 * tool table says, and is refused with a 500, never answered from the script.
 * Otherwise a request with a non-empty `tools` array is `main`; a tool-less
 * request is `title` only when its own text carries the host's title prompt
 * ("Reply with only the title." — the fixed string embedded in the installed
 * 2.4.0 binary, in both the first-message and conversation-so-far forms); any
 * other tool-less chat request is `compaction` and is refused. A title request
 * never consumes a scripted reply, and an ask request never advances
 * `mainTurn`.
 *
 * **Bodies are evidence.** Each row carries the request's own `messages` array,
 * so `dev/bench/removal-bodies.mjs` can check what the model was actually sent
 * instead of counting receipt lines. `tool_call_ids` and
 * `tool_result_call_ids` are the ids the request carried; `receipt_recall_ids`
 * are the recall ids its receipt lines named. `tool_less_chat` is true only for
 * a POST chat completion with no tool table — the shape of both a title request
 * and a compaction request, which the runner counts separately.
 *
 * The bearer must be the dummy key. Any other credential gets 401 and a log row,
 * so a real key reaching this server is visible instead of silently served. The
 * log never stores the header: each row carries `{present, lengthClass, dummy}`,
 * so the evidence cannot leak a credential the runner's post-hoc redaction
 * would have missed.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isReceiptMessage, receiptRecallIds } from './receipt-line.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

export { isReceiptMessage };

/** The only credential this server accepts; the launcher writes the same value. */
export const DUMMY_KEY = 'mock-key-not-real';
/**
 * The provider usage this mock emits is not a measurement of the request. The
 * host may use `prompt_tokens` for its context accounting (ADR-0043's ceiling is
 * a token count), so a fabricated small value could suppress a compaction the
 * real context would have triggered. The value is recorded on every request row
 * and in the result as this constant; a reader is told the "no compaction
 * request" observation can be influenced by it.
 */
export const MOCK_USAGE_SOURCE = 'mock-fabricated';
/** The fabricated usage one reply carries, as the mock's only formula. */
export function fabricatedUsage(toolResults) {
  const promptTokens = 1_000 + (Number(toolResults ?? 0) * 100);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: 5,
    total_tokens: promptTokens + 5,
  };
}
/** Dedicated loopback bind; a mock must never be reachable off-box. */
const BIND_HOST = '127.0.0.1';

function refuse(message) {
  process.stderr.write(`opencode-mock-model.mjs: ${message}\n`);
  process.exit(2);
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const MOCK_MODEL_OPTIONS = optionsOf([
  ['--port', 'string'], ['--port-file', 'string'], ['--log', 'string'], ['--script', 'string'],
]);

export function parseArgs(argv) {
  const opts = { port: 0, portFile: null, log: null, script: null };
  const { values } = parseDevArgs(argv, {
    options: MOCK_MODEL_OPTIONS,
    refuse,
    // This script's own unknown-argument wording; kept exactly.
    unknown: (rawName) => `unknown argument ${JSON.stringify(rawName)}`,
  });
  if (values.port !== undefined) opts.port = Number(values.port);
  if (values.portFile !== undefined) opts.portFile = values.portFile;
  if (values.log !== undefined) opts.log = values.log;
  if (values.script !== undefined) opts.script = values.script;
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    refuse('--port must be 0..65535');
  }
  if (opts.portFile === null) refuse('--port-file is required');
  if (opts.log === null) refuse('--log is required');
  if (opts.script === null) refuse('--script is required');
  return opts;
}

function readScript(file) {
  let script;
  try {
    script = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    refuse(`cannot read --script ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(script.replies)) refuse(`${file} has no replies array`);
  return {
    model: typeof script.model === 'string' && script.model.length > 0 ? script.model : 'mock-model',
    title: typeof script.title === 'string' && script.title.length > 0 ? script.title : 'offline bench',
    replies: script.replies,
  };
}

/** The request's model-visible tool names, from the body's own tool table. */
function toolNames(body) {
  return Array.isArray(body.tools)
    ? body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
    : [];
}

/** How many tool results the host has sent back; the conversation's turn number. */
function toolResultsCount(body) {
  return Array.isArray(body.messages)
    ? body.messages.filter((message) => message?.role === 'tool').length
    : 0;
}

/** The reasoning fields the OpenAI-compatible protocol accepts on a request. */
const REASONING_FIELDS = Object.freeze(['reasoning_content', 'reasoning', 'reasoning_text']);

/**
 * The reasoning a request's own assistant messages carry. A provider that
 * replays the agent's thinking puts one of `REASONING_FIELDS` on an assistant
 * message; counting messages, bytes and field names is what proves the host
 * sent it. **One field per message is counted.** The loop reads
 * `REASONING_FIELDS` in order and stops at the first non-empty one, so a message
 * that carries two reasoning fields counts once and its second field's bytes are
 * not added; `fields` is the set of field names seen, not a per-field count. Any
 * other role is skipped: a reasoning field on a user or tool message is not the
 * agent's thinking, and counting it would let the pin pass on a request that
 * carried none of the agent's own reasoning.
 * @param {unknown} messages
 * @returns {{messages: number, bytes: number, fields: string[]}}
 */
export function countReasoningInRequest(messages) {
  const fields = new Set();
  let messagesWithReasoning = 0;
  let bytes = 0;
  if (!Array.isArray(messages)) return { messages: 0, bytes: 0, fields: [] };
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    for (const field of REASONING_FIELDS) {
      const value = message[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      fields.add(field);
      messagesWithReasoning += 1;
      bytes += Buffer.byteLength(value, 'utf8');
      break;
    }
  }
  return { messages: messagesWithReasoning, bytes, fields: [...fields].sort() };
}

/**
 * The reasoning a request's own assistant messages carry, as strings. The
 * cumulative set check compares these, one-for-one, with the seeded texts plus
 * every prior reply's, so a duplicate of equal bytes cannot stand in for a
 * dropped turn.
 * @param {unknown} messages
 * @returns {string[]}
 */
export function reasoningTextsOfMessages(messages) {
  const texts = [];
  if (!Array.isArray(messages)) return texts;
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    for (const field of REASONING_FIELDS) {
      const value = message[field];
      if (typeof value === 'string' && value.length > 0) {
        texts.push(value);
        break;
      }
    }
  }
  return texts;
}

/**
 * What the request's `authorization` header is, without its value: presence and
 * a coarse length class. The log is evidence and is never redacted after the
 * fact, so a header must not be written verbatim in the first place.
 * @param {string|string[]|undefined} header
 */
export function authorizationRecord(header) {
  const value = Array.isArray(header) ? header.join(', ') : header;
  if (typeof value !== 'string' || value.length === 0) {
    return { present: false, lengthClass: 'absent', dummy: false };
  }
  const length = value.length;
  return {
    present: true,
    lengthClass: length < 16 ? 'short (1-15)'
      : length < 32 ? 'medium (16-31)'
        : length < 64 ? 'long (32-63)' : 'very-long (64+)',
    dummy: value === `Bearer ${DUMMY_KEY}`,
  };
}

/**
 * The fixed sentence in the host's session-title prompt. The 2.4.0 binary
 * embeds two forms — "Here is the first message of the conversation" and "Here
 * is the conversation so far" — and both end "Reply with only the title." A
 * tool-less chat request without this sentence is not a title request; it is a
 * compaction request and is refused below.
 */
export const TITLE_PROMPT_MARKER = 'Reply with only the title.';

/**
 * The fixed sentences in the host's compaction prompts. 2.4.0 embeds the
 * structured-summary request and the earlier-checkpoint rewrite; the retry
 * sentence names the same required template. They are the request's own shape,
 * so a compaction is recognised even when the host sends it with a tool table:
 * having no tools is a property a title and a compaction share, not the fact
 * that makes a request a compaction.
 */
export const COMPACTION_PROMPT_MARKERS = Object.freeze([
  'You MUST summarize the conversation above into a structured summary',
  'Update the existing checkpoint in the conversation above into one consolidated summary',
  'The previous response did not fill in the required summary template',
]);

/**
 * The `jsonl-20-nokeepall` ask's fixed bytes: the pre-table contract's first
 * sentence, the post-table repeat's own opening line, and the end anchor that
 * closes the message. Copied, not imported: this mock is a plain-Node harness
 * with no built `@cremator/core`, and a drift is pinned by
 * `dev/bench/opencode-run.test.mjs` against the core exports rather than left
 * to a comment.
 *
 * The ask is a `session.generate` request, so it carries the session's tool
 * table. A tool-count test cannot name it, and a body-text matcher over the
 * whole body could match a tool result that quotes this text. The classifier
 * reads the LAST message only: the host appends the ask prompt there.
 */
export const PRUNE_ASK_CONTRACT =
  'Memory management: decide which tool results below stay in your memory.';

/**
 * The post-table repeat's opening line. It is the same line the pre-table half
 * carries, so it is only a marker in its POSITION: `isPruneAskRequest` reads it
 * from the text after the table's last row. A prompt that lost its repeat has a
 * table followed by nothing, which this check refuses.
 */
export const PRUNE_ASK_POST_TABLE_REPEAT = 'Answer format:';

/** The anchor that closes the post-table repeat, byte for byte (`ENTRY_ASK_END_ANCHOR`). */
export const PRUNE_ASK_END_ANCHOR = '[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]';

/** The last message's text, wherever the host put it. */
function lastMessageText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messageText(messages[messages.length - 1]);
}

/**
 * The ask table's rows, each with the line count its own ` [L line(s)]` suffix
 * states and the offset just past its line. The real message states every row's
 * L (that is what a `keeplines` bound refers to), so a row line without the
 * suffix is not a row of this table.
 * @param {unknown} text
 * @returns {{index: number, lines: number, endOffset: number}[]}
 */
export function pruneAskTableOf(text) {
  if (typeof text !== 'string') return [];
  const rows = [];
  for (const match of text.matchAll(/^([1-9][0-9]*)\. \[.*? \[(\d+) lines?\]$/gmu)) {
    const index = Number(match[1]);
    const lines = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(lines)) continue;
    if (rows.some((row) => row.index === index)) continue;
    rows.push({ index, lines, endOffset: (match.index ?? 0) + match[0].length });
  }
  return rows;
}

/**
 * True when a request is the opencode prune table ask: the last message is a
 * user turn whose text opens on the pre-table contract, carries a table, then
 * the post-table repeat, and ends on the end anchor. Checked before the
 * tool-table main/compaction rules because `session.generate` keeps the
 * session's tools; checked before compaction because an ask must never be
 * refused with a 500 as a compaction.
 * @param {unknown} body
 * @returns {boolean}
 */
export function isPruneAskRequest(body) {
  if (body === null || typeof body !== 'object') return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object' || last.role !== 'user') return false;
  const text = lastMessageText(messages);
  if (typeof text !== 'string') return false;
  if (!text.trimEnd().endsWith(PRUNE_ASK_END_ANCHOR)) return false;
  if (!text.includes(PRUNE_ASK_CONTRACT)) return false;
  const rows = pruneAskTableOf(text);
  if (rows.length === 0) return false;
  const afterTable = text.slice(rows[rows.length - 1].endOffset);
  return afterTable.includes(PRUNE_ASK_POST_TABLE_REPEAT);
}

/**
 * The row indices the ask's table carries. The renderer writes one line per
 * row as `<index>. [<call>] ...`; a prompt that lost its table answers nothing.
 * @param {unknown} text
 * @returns {number[]}
 */
export function pruneAskRowsOf(text) {
  if (typeof text !== 'string') return [];
  const rows = [];
  for (const match of text.matchAll(/^([1-9][0-9]*)\. \[/gmu)) {
    const index = Number(match[1]);
    if (Number.isSafeInteger(index) && !rows.includes(index)) rows.push(index);
  }
  return rows;
}

/**
 * The ask's dedicated reply: one JSON object per line, one line per row the
 * prompt's own table names. The verdicts are chosen so one reply exercises the
 * reader's three answers:
 *
 *   - row 1 is `forgetall`, which removes the unit;
 *   - a one-line row is a whole-range `keeplines` with summary `None`, which
 *     `readJsonl20NoKeepallAnswer` normalizes to a clean keep;
 *   - any row with more than one line is a PARTIAL `keeplines` (the last line,
 *     or everything past the sixth, is forgotten), which removes bytes.
 *
 * A zero-line row is `forgetall`: there is no line inside `1..0` to keep.
 * @param {unknown[]} messages
 * @returns {{type: 'text', text: string, rows: number[], answers: object}}
 */
export function pruneAskReply(messages) {
  const rows = pruneAskTableOf(lastMessageText(messages));
  const answers = {};
  for (const row of rows) answers[String(row.index)] = pruneAskAnswerOf(row);
  const text = Object.entries(answers)
    .map(([index, answer]) => JSON.stringify({ [index]: answer })).join('\n');
  return { type: 'text', text, rows: rows.map((row) => row.index), answers };
}

/** One row's verdict, from the row's own index and line count. */
function pruneAskAnswerOf(row) {
  if (row.index === 1 || row.lines < 1) return { forgetall: true, summary: 'mock ask answer' };
  if (row.lines === 1) return { keeplines: [[1, 1]], summary: 'None' };
  // A partial keep: the last line is forgotten, or everything past the sixth.
  return { keeplines: [[1, Math.min(6, row.lines - 1)]],
    summary: 'mock ask keeps the leading lines' };
}

/** The request text the host's fixed prompts would occupy. */
function promptText(body) {
  if (body === null || typeof body !== 'object') return '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system === undefined ? null : body.system;
  return JSON.stringify({ messages, system });
}

/**
 * True when a request is the host's compaction request, by its own prompt.
 * Independent of the tool table: a compaction request that carries tools must
 * still be classified as one, or it would be answered from the script as a main
 * turn and the run would measure a conversation the host never had.
 * @param {unknown} body
 * @returns {boolean}
 */
export function isCompactionRequest(body) {
  const text = promptText(body);
  return COMPACTION_PROMPT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * True when a request is the host's title request. The request's messages and
 * system prompt are searched: 2.4.0 may place the prompt in a system or a user
 * message, and both are the host's own fixed text.
 * @param {unknown} body
 * @returns {boolean}
 */
export function isTitleRequest(body) {
  if (body === null || typeof body !== 'object') return false;
  return promptText(body).includes(TITLE_PROMPT_MARKER);
}

/**
 * Messages carrying a product-inserted record: the receipt line, a negative
 * fact, or the adapter's `racoonsRecordId` marker. The one definition lives in
 * `receipt-line.mjs`; this wrapper is what other bench code imports.
 * @param {unknown} messages
 * @returns {number}
 */
export function countReceiptMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter(isReceiptMessage).length;
}

/**
 * The recall ids a request's receipt lines name. The product's receipt ends
 * `· necromancy <recall id>` (`packages/core/src/rules/assets.ts`,
 * `receiptLine`); this is the only place the wire states which ledger record a
 * removal created. Sorted and unique, because a receipt is evidence of one
 * removal and a duplicate line is the same record twice.
 * @param {unknown} messages
 * @returns {string[]}
 */
export function countReceiptRecallIds(messages) {
  return receiptRecallIds(messages);
}

/**
 * The call ids a request carries, split by where they appear. An assistant
 * tool call names its id in `tool_calls[].id`; the matching tool message names
 * it again in `tool_call_id`. Either side surviving alone is a half-unit, which
 * is why the removal rule names the call id rather than the result bytes.
 * @param {unknown} messages
 * @returns {{calls: string[], results: string[]}}
 */
export function toolCallIds(messages) {
  const calls = new Set();
  const results = new Set();
  if (!Array.isArray(messages)) return { calls: [], results: [] };
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string' && call.id.length > 0) calls.add(call.id);
      }
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0) {
      results.add(message.tool_call_id);
    }
  }
  return { calls: [...calls].sort(), results: [...results].sort() };
}

/** The UTF-8 bytes the request's tool-result messages carry. */
export function toolResultsBytes(messages) {
  if (!Array.isArray(messages)) return 0;
  let bytes = 0;
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'tool') continue;
    const content = message.content;
    bytes += typeof content === 'string'
      ? Buffer.byteLength(content, 'utf8')
      : Buffer.byteLength(JSON.stringify(content ?? null), 'utf8');
  }
  return bytes;
}

/**
 * Pick the first reply whose matchers hold, or null. The match is a claim about
 * what the host actually sent, never about what the script hopes it sent.
 *
 * **A content key must hold.** Besides the structural keys (`main_turn`, the
 * tool table), a reply may declare `tool_results_added` (tool-result messages
 * added since this run's first main request), `tool_results_count` (absolute
 * count), `last_tool_result_contains` (strings the last tool-result body must
 * carry) and `last_user_contains` (strings the last user message must carry).
 * An entry whose structural keys match but whose content key does not is
 * skipped; when no entry is left, `why` names the content mismatch. The returned
 * `contentKeyHeld` records whether the served reply was tied to the request's
 * own bytes, so a `main_turn`-only script is served but its accounting is not
 * presented as fidelity evidence (ISSUE-214 P3).
 * @param {object[]} replies
 * @param {{tools: string[], toolResults: number, toolResultsAdded: number,
 *   mainTurn: number, messages: unknown[]}} view
 * @returns {{entry: object|null, contentKeyHeld: boolean, why: string|null}}
 */
function chooseReply(replies, view) {
  const lastToolResult = lastToolResultText(view.messages);
  const lastUser = lastUserText(view.messages);
  const holds = (match) => {
    if (match.tool_results_count !== undefined && match.tool_results_count !== view.toolResults) return false;
    if (match.tool_results_added !== undefined && match.tool_results_added !== view.toolResultsAdded) return false;
    if (match.main_turn !== undefined && match.main_turn !== view.mainTurn) return false;
    if (match.tools_present !== undefined && match.tools_present !== (view.tools.length > 0)) return false;
    if (Array.isArray(match.tools_include)
      && !match.tools_include.every((name) => view.tools.includes(name))) return false;
    if (Array.isArray(match.tools_absent)
      && match.tools_absent.some((name) => view.tools.includes(name))) return false;
    if (Array.isArray(match.last_tool_result_contains)
      && !match.last_tool_result_contains.every((needle) =>
        typeof needle === 'string' && needle.length > 0
        && lastToolResult !== null && lastToolResult.includes(needle))) return false;
    if (Array.isArray(match.last_user_contains)
      && !match.last_user_contains.every((needle) =>
        typeof needle === 'string' && needle.length > 0
        && lastUser !== null && lastUser.includes(needle))) return false;
    return true;
  };
  const hasContentKey = (match) => typeof match === 'object' && match !== null
    && (match.tool_results_added !== undefined || match.tool_results_count !== undefined
      || Array.isArray(match.last_tool_result_contains)
      || Array.isArray(match.last_user_contains));
  let structuralOnly = null;
  let structuralOnlyName = null;
  for (const entry of replies) {
    const match = entry?.match;
    if (match === undefined) {
      // A fallback reply declares no key at all. It is served (the script's
      // stated default), and `contentKeyHeld` is false so no caller reads it as
      // request-key fidelity.
      return { entry, contentKeyHeld: false, why: null };
    }
    if (!holds(match)) continue;
    if (hasContentKey(match)) return { entry, contentKeyHeld: true, why: null };
    if (structuralOnly === null) {
      structuralOnly = entry;
      structuralOnlyName = typeof entry?.name === 'string' ? entry.name : null;
    }
  }
  if (structuralOnly !== null) {
    return { entry: structuralOnly, contentKeyHeld: false, why: null };
  }
  return { entry: null, contentKeyHeld: false, why: 'content-key-mismatch' };
}

/** The text of the last tool-role message, or null when the body has none. */
function lastToolResultText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    const content = message.content;
    return typeof content === 'string'
      ? content
      : JSON.stringify(content ?? null);
  }
  return null;
}

/**
 * The joined text of the last user message, or null when the body has none.
 * A receipt is a user message the mount inserted, not the prompt: the last
 * non-receipt user message is the conversation's own text.
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || isReceiptMessage(message)) continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return null;
  }
  return null;
}

/**
 * Resolve `{{RECALL_ID:<token>}}` in a reply's call arguments from the request's
 * own receipt lines: the receipt whose text names `<token>` (the removed file's
 * name) supplies the recall id. The mock never invents an id; a placeholder with
 * no matching receipt makes the request refuse by name, and the run then fails
 * instead of restoring the wrong archive (ISSUE-214 P1).
 * @param {object} reply
 * @param {unknown[]} messages
 * @returns {{reply: object, missing: string[]}}
 */
function resolveRecallIds(reply, messages) {
  const missing = [];
  const receipts = (Array.isArray(messages) ? messages : [])
    .filter((message) => isReceiptMessage(message))
    .map((message) => ({ text: messageText(message), ids: receiptRecallIds([message]) }));
  const resolveToken = (token) => {
    const at = receipts.find((receipt) => receipt.text.includes(token) && receipt.ids.length > 0);
    return at === undefined ? null : at.ids[0];
  };
  const walk = (value) => {
    if (typeof value === 'string') {
      return value.replace(/\{\{RECALL_ID:([^}]+)\}\}/gu, (whole, token) => {
        const resolved = resolveToken(String(token));
        if (resolved === null) { missing.push(String(token)); return whole; }
        return resolved;
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      return out;
    }
    return value;
  };
  return { reply: walk(reply), missing };
}

/** One message's text, wherever the host put it. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * One SSE frame. The final frame is a full `chat.completion` object (probe
 * shape); `delta` frames are `chat.completion.chunk`.
 */
function frame(res, model, payload) {
  res.write(`data: ${JSON.stringify({ model, ...payload })}\n\n`);
}

/**
 * Stream one assistant reply. `reasoning` frames carry the agent's thinking
 * (ADR-0045) and go first: the protocol's reasoning channel stays open beside
 * text, and `reasoning_content` is the field it replays on the next request.
 * `content` frames carry text; `toolCalls` frames carry `tool_calls`, and the
 * finish reason is `tool_calls` for that shape. Usage is fabricated
 * (`MOCK_USAGE_SOURCE`) and small; the host's own `step-finish` row is what the
 * arm records, and its cost is zero because no price is configured.
 */
function streamReply(res, model, reply, view) {
  const id = `chatcmpl-mock-${view.seq}`;
  const created = 1_700_000_000 + view.seq;
  const toolCalls = reply.type === 'tool_use' && Array.isArray(reply.calls) ? reply.calls : [];
  const text = typeof reply.text === 'string' ? reply.text : '';
  const reasoning = typeof reply.reasoning === 'string' ? reply.reasoning : '';
  const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const usage = fabricatedUsage(view.toolResults);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Reasoning first, before any content or tool call, so the protocol opens its
  // reasoning block ahead of the text block the same reply carries.
  if (reasoning.length > 0) {
    frame(res, model, {
      id, object: 'chat.completion.chunk', created,
      choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
    });
  }
  frame(res, model, {
    id, object: 'chat.completion.chunk', created,
    choices: [{ index: 0, delta: { role: 'assistant', content: text.length > 0 ? text : undefined }, finish_reason: null }],
  });
  if (toolCalls.length > 0) {
    frame(res, model, {
      id, object: 'chat.completion.chunk', created,
      choices: [{
        index: 0,
        delta: {
          tool_calls: toolCalls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        },
        finish_reason: null,
      }],
    });
  }
  frame(res, model, {
    id, object: 'chat.completion.chunk', created,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  });
  // The probe's accepted terminal frame: a complete message plus usage.
  frame(res, model, {
    id, object: 'chat.completion', created,
    choices: [{
      index: 0,
      message: {
        ...(toolCalls.length > 0
          ? {
            role: 'assistant',
            content: text.length > 0 ? text : null,
            tool_calls: toolCalls.map((call) => ({
              id: call.id, type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
            })),
          }
          : { role: 'assistant', content: text }),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      },
      finish_reason: finish,
    }],
    usage,
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const script = readScript(opts.script);
  let seq = 0;
  /** Main requests already answered; `match.main_turn` reads this. */
  let mainTurn = 0;
  /**
   * The tool-result count of this run's first main request. A script cannot
   * know a replay's seeded history, so `tool_results_added` is this request's
   * count minus that baseline; on a fresh run the baseline is 0.
   */
  let firstMainToolResults = null;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seq += 1;
      let body = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'body is not JSON' } }));
        return;
      }
      const tools = toolNames(body);
      const toolResults = toolResultsCount(body);
      const reasoning = countReasoningInRequest(body.messages);
      const callIds = toolCallIds(body.messages);
      const isChat = req.method === 'POST' && req.url.includes('/chat/completions');
      const isModels = req.method === 'GET' && req.url.includes('/models');
      // The bench-only ask is named FIRST: `session.generate` keeps the
      // session's tool table, so a tool-count test would call it a main turn,
      // and its own body is untrusted for a whole-body text match (a tool
      // result may quote the prompt). The last message's opener + end anchor
      // is the classifier, and it is checked before compaction so an ask is
      // never refused with a 500.
      const askShape = isChat && isPruneAskRequest(body);
      // A compaction request is recognised by the host's compaction prompt, in
      // its own body, before the tool table is consulted: 2.4.0 may send it with
      // tools, and a tool-carrying compaction answered from the script would be
      // a main turn the run never had. A tool-less chat request that carries
      // neither prompt is still a compaction (an unknown tool-less shape is
      // never answered with the title), and only the host's title prompt makes
      // a request a title.
      const compactionShape = isChat && !askShape && isCompactionRequest(body);
      const kind = isChat
        ? (askShape
          ? 'ask'
          : (compactionShape
            ? 'compaction'
            : (tools.length > 0 ? 'main' : (isTitleRequest(body) ? 'title' : 'compaction'))))
        : 'other';
      const askPrompt = askShape ? lastMessageText(body.messages) : null;
      if (kind === 'main' && firstMainToolResults === null) firstMainToolResults = toolResults;
      const toolResultsAdded = kind === 'main' && firstMainToolResults !== null
        ? toolResults - firstMainToolResults : 0;
      const authorization = req.headers.authorization ?? null;
      const record = {
        seq,
        atMs: Date.now(),
        kind,
        main_turn: kind === 'main' ? mainTurn : null,
        method: req.method,
        url: req.url,
        route: isModels ? 'models' : (isChat ? 'chat' : 'other'),
        /** A tool-less chat request: the title shape and the compaction shape. */
        tool_less_chat: isChat && tools.length === 0,
        /** The host's compaction prompt appeared in the request's own text. */
        compaction_prompt: compactionShape,
        /**
         * The bench-only ask: `kind: "ask"`, never a main turn (`main_turn` is
         * null and `mainTurn` is not advanced). The prompt hash and row list
         * describe the last message's own bytes, so the runner can record the
         * ask lane without reading a main-lane field.
         */
        ask: askShape,
        ask_prompt_sha256: typeof askPrompt === 'string'
          ? createHash('sha256').update(askPrompt, 'utf8').digest('hex') : null,
        ask_prompt_chars: typeof askPrompt === 'string' ? askPrompt.length : null,
        ask_rows: askShape ? pruneAskRowsOf(askPrompt) : [],
        /** Presence and length class only; the header value is never written. */
        authorization: authorizationRecord(authorization),
        model: body.model ?? null,
        stream: body.stream === true,
        tools,
        tool_results_count: toolResults,
        /** Tool results this run added since its first main request. */
        tool_results_added: toolResultsAdded,
        message_roles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role) : [],
        message_count: Array.isArray(body.messages) ? body.messages.length : 0,
        /** The body the host posted, so the removal rule reads bytes, not receipts. */
        messages: Array.isArray(body.messages) ? body.messages : [],
        tool_call_ids: callIds.calls,
        tool_result_call_ids: callIds.results,
        tool_results_bytes: toolResultsBytes(body.messages),
        reasoning_messages: reasoning.messages,
        reasoning_bytes: reasoning.bytes,
        reasoning_fields: reasoning.fields,
        receipt_messages: countReceiptMessages(body.messages),
        receipt_recall_ids: countReceiptRecallIds(body.messages),
        body_bytes: Buffer.byteLength(raw, 'utf8'),
        body_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
        /**
         * The provider usage this reply will carry, and the fact that it is
         * fabricated. A host that accounts context from `prompt_tokens` reads a
         * number this bench chose, not the request's size.
         */
        usage_source: MOCK_USAGE_SOURCE,
        usage: fabricatedUsage(toolResults),
        matched_reply: null,
        /**
         * Whether the served reply's declared content key held against this
         * request's own bytes. False for a `main_turn`-only or fallback reply:
         * such a match is the mock's own counter, not request-key fidelity.
         */
        matched_content_key: null,
        reply_reasoning_frames: 0,
        reply_reasoning_bytes: 0,
        reply_reasoning_text: null,
      };

      if (authorizationRecord(authorization).dummy !== true) {
        record.matched_reply = null;
        record.refusal = 'non-dummy-bearer';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'the offline bench accepts only the dummy key' } }));
        return;
      }

      if (isModels) {
        appendFileSync(opts.log, `${JSON.stringify({ ...record, matched_reply: 'models-list' })}\n`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: script.model, object: 'model' }] }));
        return;
      }
      if (!isChat) {
        record.refusal = 'no-route';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
        return;
      }

      const view = {
        seq, tools, toolResults, toolResultsAdded, mainTurn,
        messages: Array.isArray(body.messages) ? body.messages : [],
      };
      if (kind === 'ask') {
        // The ask's own lane: a dedicated reply built from the table the prompt
        // carries. It is never served from `replies` (whose matchers describe
        // main turns), never consumes a main turn, and never reaches the
        // compaction refusal.
        const reply = pruneAskReply(body.messages);
        record.matched_reply = 'ask';
        record.matched_content_key = reply.rows.length > 0;
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        streamReply(res, script.model, reply, view);
        return;
      }
      if (kind === 'compaction') {
        // A compaction request is not a title. Answering it with the title would
        // let the host continue with a summary-shaped reply and let the run pass
        // as if a title had been posted; it fails here by name instead.
        record.matched_reply = null;
        record.refusal = 'compaction-request';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'compaction-request: this bench never answers a compaction with the title',
          },
        }));
        return;
      }
      if (kind === 'title') {
        record.matched_reply = 'title';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        streamReply(res, script.model, { type: 'text', text: script.title }, view);
        return;
      }
      const chosen = chooseReply(script.replies, view);
      if (chosen.entry === null) {
        mainTurn += 1;
        record.refusal = chosen.why === 'content-key-mismatch' ? 'content-key-mismatch' : 'no-match';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `${record.refusal}: turn ${toolResults}, added ${toolResultsAdded}, `
              + `main_turn ${record.main_turn}, tools [${tools.join(',')}]`,
          },
        }));
        return;
      }
      mainTurn += 1;
      const resolved = resolveRecallIds(chosen.entry.reply ?? { type: 'text', text: '' }, body.messages);
      if (resolved.missing.length > 0) {
        mainTurn -= 1;
        record.refusal = 'recall-id-missing';
        appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `recall-id-missing: no receipt in the request names `
              + `${JSON.stringify([...new Set(resolved.missing)])}`,
          },
        }));
        return;
      }
      const reply = resolved.reply;
      const replyReasoning = typeof reply.reasoning === 'string' ? reply.reasoning : '';
      record.matched_reply = typeof chosen.entry.name === 'string' ? chosen.entry.name : 'unnamed';
      record.matched_content_key = chosen.contentKeyHeld === true;
      record.reply_reasoning_frames = replyReasoning.length > 0 ? 1 : 0;
      record.reply_reasoning_bytes = Buffer.byteLength(replyReasoning, 'utf8');
      record.reply_reasoning_text = replyReasoning.length > 0 ? replyReasoning : null;
      appendFileSync(opts.log, `${JSON.stringify(record)}\n`);
      streamReply(res, script.model, reply, view);
    });
  });

  server.on('error', (error) => refuse(`server error: ${error.message}`));
  server.listen(opts.port, BIND_HOST, () => {
    const address = server.address();
    writeFileSync(opts.portFile, String(address.port));
    process.stdout.write(`opencode-mock-model listening on ${BIND_HOST}:${address.port}\n`);
  });
}

// A direct run serves; an import (a test of the pure counters) does not.
if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
