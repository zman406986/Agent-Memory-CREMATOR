#!/usr/bin/env node
/**
 * Tier-2 replay: a zcode `transcript.jsonl` becomes a `mock-messages.mjs` script.
 *
 * Spec: `archive/2026-10-22-dsh-test-rig.md` §5. One zcode `model_request`
 * becomes one scripted turn; the following `model_complete` supplies the
 * assistant text and the `tool_call_scheduled` entries between it and the next
 * request supply the tool calls. The matcher key is the pair §5 names:
 * `(tool_results_count, last_assistant_tool_names)`.
 *
 * Usage:
 *   node replay.mjs --in <transcript.jsonl> --out <script.json>
 *                   [--text-cap 4000] [--max-replies 24] [--title "..."]
 *                   [--task-regex "<regex>"] [--stats <stats.json>] [--check]
 *
 * `--check` scans the written script for any unredacted secret, home path,
 * project name or transcript id and exits 3 when one survives. Every write is
 * redacted unconditionally; the scan proves the redaction, it does not enable it.
 *
 * Two things are deliberately NOT reproduced:
 *  - the source prompt text (turn 0's matcher keys on the tool-result count
 *    only; `--task-regex` is the opt-in way to key it on a sanitized task), and
 *  - any tool result body. dsh executes the scripted calls itself and feeds
 *    its own results back, which is the seam the rig exists to exercise.
 *
 * Scheduling and background tools with no dsh twin (`TodoWrite`, `TaskOutput`,
 * `TaskStop`) map to a NO-OP dsh call instead of ending the prefix: the scripted
 * turn still emits a tool call, the host still produces a real result for it,
 * and `tool_results_count` advances exactly as the record says it did. Their
 * recorded arguments — todo prose included — never enter the script; see
 * `TOOL_MAP` and `noopInput`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

/** Bump when the mapping changes; a fixture records the version that built it. */
export const CONVERTER_VERSION = 2;

// ── Redaction ───────────────────────────────────────────────────────────────
// Rules adapted from scratchpad/spike-008/extract.mjs. Ordered: secrets, then
// project names (so the token survives the home-path pass), then home paths.

/**
 * Every rule is `[pattern, replacement, counterBucket]`. Buckets are the three
 * fields of the stats' `redaction` record.
 * @type {Array<[RegExp, string, 'secrets'|'project_names'|'home_paths']>}
 */
export const REDACTION_RULES = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/gu, 'sk-...', 'secrets'],
  [/\bsk-[A-Za-z0-9_-]{12,}/gu, 'sk-...', 'secrets'],
  [/\b(?:gh[pousr])_[A-Za-z0-9]{20,}/gu, 'gh*_...', 'secrets'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/gu, 'xox?-...', 'secrets'],
  [/\bAKIA[0-9A-Z]{16}\b/gu, 'AKIA...', 'secrets'],
  [/\b(Bearer)\s+[A-Za-z0-9._-]{16,}/giu, '$1 ...', 'secrets'],
  [
    /(\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*)(["'])[^"'\n]{12,}\2/giu,
    '$1$2...$2',
    'secrets',
  ],
  // Project names before home paths: the token must survive the path pass.
  [/Interastral[\s-]+Peace[\s-]+Casino/giu, '<proj-b>', 'project_names'],
  [/Genshin[\s-]+IPC/giu, '<proj-c>', 'project_names'],
  [/Genshin[\s-]+Impact/giu, '<proj-c>', 'project_names'],
  [/Miliastra/giu, '<proj-c>', 'project_names'],
  [/Spreadsheets\s+in\s+space/giu, '<proj-a>', 'project_names'],
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gu, '<home>', 'home_paths'],
  [/\/[A-Za-z]\/Users\/[^/\s"']+/gu, '<home>', 'home_paths'],
  [/\bUsers[\\/][^\\/\s"']+/gu, '<home>', 'home_paths'],
];

/** Secret rules alone, for the leak scan's labels. */
const SECRET_PATTERNS = REDACTION_RULES.filter((rule) => rule[2] === 'secrets');
const PROJECT_PATTERNS = REDACTION_RULES.filter((rule) => rule[2] === 'project_names');
const HOME_PATTERNS = REDACTION_RULES.filter((rule) => rule[2] === 'home_paths');

/**
 * Redact one string. Non-strings pass through unchanged.
 * @param {string} text
 * @param {{secrets: number, project_names: number, home_paths: number}|null} [counters]
 * @returns {string}
 */
export function redact(text, counters = null) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement, bucket] of REDACTION_RULES) {
    // A fresh regex per rule keeps `lastIndex` from leaking across calls.
    const fresh = new RegExp(pattern.source, pattern.flags);
    out = out.replace(fresh, (...args) => {
      if (counters !== null) counters[bucket] += 1;
      // `$1`/`$2` in the replacement string are backreferences: expand them.
      return replacement.replace(/\$(\d)/gu, (_, index) => String(args[Number(index)] ?? ''));
    });
  }
  return out;
}

/** Patterns that mean "redaction failed" if they still match a converted script. */
const LEAK_PATTERNS = [
  ...SECRET_PATTERNS.map(([pattern, , bucket]) => [pattern, `${bucket}:secret`]),
  ...PROJECT_PATTERNS.map(([pattern, , bucket]) => [pattern, `${bucket}:project`]),
  ...HOME_PATTERNS.map(([pattern, , bucket]) => [pattern, `${bucket}:path`]),
  [/\bAAAAA\b/gu, 'user:AAAAA'],
  [/\bsess_[0-9a-f]{8,}/gu, 'transcript-id'],
  [/\b(?:turn|call|msg)_[0-9a-f]{8,}/gu, 'transcript-id'],
];

/**
 * Scan text for anything redaction should have removed.
 * @param {string} text
 * @returns {Array<{kind: string, sample: string}>}
 */
export function leakScan(text) {
  const hits = [];
  for (const [pattern, kind] of LEAK_PATTERNS) {
    const fresh = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(fresh)) {
      hits.push({ kind, sample: match[0].slice(0, 40) });
      if (hits.length >= 50) return hits;
    }
  }
  return hits;
}

// ── Tool mapping ────────────────────────────────────────────────────────────

/**
 * zcode tool name -> dsh tool name. `null` = no dsh equivalent.
 *
 * The three no-op family entries are what let a long zcode record replay at
 * all: `TodoWrite`, `TaskOutput` and `TaskStop` are scheduling/background-tool
 * calls with no dsh twin, and the first one used to end the prefix. Each maps
 * to a dsh tool that exists in every arm, succeeds, and answers with its own
 * small result, so the recorded call still advances `tool_results_count` — the
 * matcher key every later turn is built on — without importing any recorded
 * prose. `TOOL_NOOP_INPUT` says what arguments become.
 */
const TOOL_MAP = new Map([
  ['Read', 'read'], ['read', 'read'],
  ['Bash', 'pwsh'], ['bash', 'pwsh'], ['pwsh', 'pwsh'],
  ['Grep', 'grep'], ['Glob', 'glob'],
  ['Edit', 'edit'], ['Write', 'write'],
  ['TodoWrite', 'todo_write'], ['TaskOutput', 'job_list'], ['TaskStop', 'job_list'],
]);

/**
 * A mapped tool whose recorded arguments cannot be replayed, and the arguments
 * the script carries instead. `todo_write` keeps the CALL SHAPE (a whole-list
 * write of N items, statuses preserved) but never the items' prose; `job_list`
 * is a read-only no-op that takes no arguments.
 */
export const NOOP_TOOLS = new Set(['todo_write', 'job_list']);

/** The three item statuses `todo_write` accepts; anything else becomes pending. */
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * A recorded shell command is executed only when it is a single read-only
 * pipeline-free command. Anything else is withheld: a foreign session's
 * commands are not trusted with this machine, and replay does not need them.
 */
const SAFE_COMMAND = /^\s*(?:Get-Content|Get-ChildItem|Select-String|Write-Output|echo|ls|dir|cat|head|tail|wc)\b[^;&>|`$]*$/iu;

/** The dsh-side stand-in for a withheld command. */
export const WITHHELD_COMMAND = "Write-Output 'replay: recorded shell command withheld'";

const PATH_INPUT_TOOLS = new Set(['read', 'write', 'edit']);

/**
 * The no-op arguments for one recorded call. The call SHAPE is kept where dsh
 * validates it (`todo_write` takes a whole list of items with statuses) and
 * every recorded string is replaced by a deterministic stand-in, so no recorded
 * todo prose reaches a script, a fixture or a committed map.
 * @param {string} name - the mapped dsh tool name.
 * @param {object} input - the recorded arguments.
 * @returns {object} the script's arguments.
 */
function noopInput(name, input) {
  if (name === 'job_list') return {};
  const recorded = Array.isArray(input.todos) ? input.todos : [];
  // Zero items is legal for `todo_write` (it clears the list) and the recorded
  // call may name a count no replay can know; both keep the call's width.
  return {
    todos: recorded.map((item, index) => ({
      content: `replay todo ${index + 1}`,
      status: TODO_STATUSES.has(item?.status) ? item.status : 'pending',
    })),
  };
}

/**
 * Turn one recorded tool call into a dsh-executable one.
 * @param {{toolName: string, input: object}} call
 * @param {{seq: number, rewrittenPaths: Map<string, string>, placeholder?: boolean}} state
 * @returns {{call: {id: string, name: string, input: object}|null, notes: string[]}}
 */
export function mapToolCall(call, state) {
  const name = TOOL_MAP.get(call.toolName);
  if (name === undefined || name === null) return { call: null, notes: ['unsupported-tool'] };
  const notes = [];
  const placeholder = state.placeholder === true;
  const input = call.input !== null && typeof call.input === 'object' ? { ...call.input } : {};
  if (NOOP_TOOLS.has(name)) {
    // A no-op tool's RECORDED result is what a real replay serves; the script
    // only has to make the host produce a successful result of the right shape.
    // The recorded arguments are dropped wholesale, prose included.
    notes.push('noop');
    return { call: { id: call.toolCallId, name, input: noopInput(name, input) }, notes };
  }
  if (PATH_INPUT_TOOLS.has(name)) {
    const raw = input.file_path;
    if (typeof raw === 'string' && raw !== '') {
      let target = state.rewrittenPaths.get(raw);
      if (target === undefined) {
        if (placeholder) {
          // Structural only: a stable ordinal plus the extension, no source
          // file name reaches a committed fixture.
          const extension = /\.[A-Za-z0-9]{1,8}$/u.exec(raw)?.[0] ?? '';
          target = `replay/file-${state.rewrittenPaths.size + 1}${extension}`;
        } else {
          target = `replay/${basename(raw.replace(/\\/gu, '/'))}`;
        }
        state.rewrittenPaths.set(raw, target);
      }
      input.file_path = target;
      notes.push('path-rewritten');
    }
  }
  if (name === 'pwsh') {
    const command = input.command;
    // Second gate: a command that survives `SAFE_COMMAND` is still withheld
    // when its own text trips the leak scan (a home path or project name in an
    // argument). The converter never rewrites a command's words, and a script
    // that carries a real path is not a script this repo commits.
    if (typeof command !== 'string' || !SAFE_COMMAND.test(command) || leakScan(command).length > 0) {
      input.command = WITHHELD_COMMAND;
      notes.push('command-withheld');
    }
  }
  if (placeholder) {
    // Free-text tool arguments are the remaining prose channel; drop them.
    for (const key of ['description', 'justification']) {
      if (typeof input[key] === 'string') input[key] = `replay ${name} call`;
    }
  }
  return { call: { id: call.toolCallId, name, input }, notes };
}

// ── Transcript parsing ──────────────────────────────────────────────────────

/**
 * @param {string} text - raw transcript bytes as utf8.
 * @returns {{events: object[], malformedLines: number, lines: number}}
 */
export function parseTranscript(text) {
  const events = [];
  let malformedLines = 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    lines += 1;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }
  return { events, malformedLines, lines };
}

/**
 * Group events into turns: each `model_request` opens one, and the
 * `tool_call_scheduled` events that follow belong to it.
 * @param {object[]} events
 * @returns {Array<{request: object, completion: object|null, calls: object[]}>}
 */
export function groupTurns(events) {
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event?.type === 'model_request') {
      if (current !== null) turns.push(current);
      current = { request: event, completion: null, calls: [] };
      continue;
    }
    if (current === null) continue;
    if (event?.type === 'model_complete') {
      if (current.completion === null) current.completion = event;
    } else if (event?.type === 'tool_call_scheduled') {
      current.calls.push(event.payload ?? {});
    }
  }
  if (current !== null) turns.push(current);
  return turns;
}

/** Count `role: 'tool'` messages in a zcode request: the turn number. */
export function countToolResults(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.role === 'tool').length;
}

/** Names of the tool calls in the last assistant message, in order. */
export function lastAssistantToolNames(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role !== 'assistant') continue;
    const calls = Array.isArray(list[i].toolCalls) ? list[i].toolCalls : [];
    return calls.map((call) => String(call?.name ?? '')).filter((name) => name !== '');
  }
  return [];
}

/** The newest message a request carries: role and character count, no text. */
export function promptTail(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (last === undefined) return { role: 'none', chars: 0 };
  const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
  return { role: String(last.role ?? 'unknown'), chars: content.length };
}

/**
 * Cap a string for the script, marking the cut so nobody mistakes it for the
 * full recording.
 * @param {string} text
 * @param {number} cap
 * @returns {string}
 */
export function capText(text, cap) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\u2026[truncated]`;
}

/**
 * How assistant text enters a script.
 * `redact` keeps the source prose with secrets, names and paths replaced: right
 * for a scratchpad script. `placeholder` keeps only a length marker: right for
 * anything committed, because no amount of pattern matching proves prose is
 * harmless. Replay semantics (one text per turn, stop reason) are identical.
 */
export const TEXT_MODES = new Set(['redact', 'placeholder']);

/**
 * @param {string} text - source assistant text.
 * @param {'redact'|'placeholder'} mode
 * @param {number} cap
 * @param {{secrets: number, project_names: number, home_paths: number}|null} counters
 * @param {string} label
 * @returns {string}
 */
function scriptText(text, mode, cap, counters, label) {
  if (mode === 'placeholder') {
    // The length is kept because a cap/timeout scenario may care; the prose is not.
    return text === '' ? '' : `<replay ${label}: ${text.length} chars>`;
  }
  return capText(redact(text, counters), cap);
}

// ── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert a parsed transcript into a mock script plus a statistics record.
 * @param {string} transcriptText
 * @param {{textCap?: number, maxReplies?: number, title?: string, taskRegex?: string|null, sourceName?: string}} [options]
 * @returns {{script: object, stats: object}}
 */
export function convertTranscript(transcriptText, options = {}) {
  const textCap = Number.isInteger(options.textCap) ? options.textCap : 4000;
  const maxReplies = Number.isInteger(options.maxReplies) ? options.maxReplies : 24;
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title : 'Replay session';
  const taskRegex = typeof options.taskRegex === 'string' && options.taskRegex !== '' ? options.taskRegex : null;
  const textMode = TEXT_MODES.has(options.textMode) ? options.textMode : 'redact';
  const counters = { secrets: 0, project_names: 0, home_paths: 0 };
  const { events, malformedLines, lines } = parseTranscript(transcriptText);
  const turns = groupTurns(events);
  const stats = {
    converter_version: CONVERTER_VERSION,
    source: {
      name: typeof options.sourceName === 'string' ? options.sourceName : null,
      bytes: Buffer.byteLength(transcriptText, 'utf8'),
      lines,
      malformed_lines: malformedLines,
      sha256: createHash('sha256').update(transcriptText, 'utf8').digest('hex'),
    },
    events: events.length,
    turns: {
      model_requests: turns.length,
      completions: turns.filter((turn) => turn.completion !== null).length,
      mapped: 0,
      // Everything after the first blocker is dropped, not mined for a suffix:
      // a replayed conversation is only meaningful as a prefix of the original.
      dropped_after_blocker: 0,
      truncated_by_max_replies: 0,
      blocker: null,
      skipped: { no_completion: 0, bad_completion: 0, empty_reply: 0, duplicate_key: 0, unmappable_tools: 0 },
    },
    tool_calls: { seen: 0, mapped: 0, unsupported: 0, command_withheld: 0, path_rewritten: 0, noop: 0 },
    redaction: counters,
    text_mode: textMode,
    leaks: [],
    caps: { text_chars: textCap, max_replies: maxReplies },
  };

  const replies = [];
  const seenKeys = new Set();
  const pathState = { rewrittenPaths: new Map(), placeholder: textMode === 'placeholder' };
  const perTurn = [];
  let executedCalls = 0;
  let previousNames = [];
  let blocked = false;

  for (const [index, turn] of turns.entries()) {
    if (blocked) {
      stats.turns.dropped_after_blocker += 1;
      continue;
    }
    if (replies.length >= maxReplies) {
      stats.turns.truncated_by_max_replies += 1;
      blocked = true;
      continue;
    }
    if (turn.completion === null) {
      stats.turns.skipped.no_completion += 1;
      blocked = true;
      stats.turns.blocker = 'no_completion';
      continue;
    }
    const completion = turn.completion.payload ?? {};
    if (typeof completion.content !== 'string') {
      stats.turns.skipped.bad_completion += 1;
      blocked = true;
      stats.turns.blocker = 'bad_completion';
      continue;
    }
    const messages = turn.request.payload?.messages;
    const text = scriptText(completion.content, textMode, textCap, counters, `turn ${index + 1}`);

    stats.tool_calls.seen += turn.calls.length;
    const calls = [];
    let unmappable = null;
    for (const rawCall of turn.calls) {
      const { call, notes } = mapToolCall(rawCall, pathState);
      if (call === null) {
        stats.tool_calls.unsupported += 1;
        unmappable = String(rawCall.toolName ?? 'unknown');
        continue;
      }
      if (notes.includes('command-withheld')) stats.tool_calls.command_withheld += 1;
      if (notes.includes('path-rewritten')) stats.tool_calls.path_rewritten += 1;
      if (notes.includes('noop')) stats.tool_calls.noop += 1;
      calls.push(call);
      stats.tool_calls.mapped += 1;
    }
    if (unmappable !== null) {
      // Dropping one call would make every later key wrong; stop the prefix here.
      stats.turns.skipped.unmappable_tools += 1;
      blocked = true;
      stats.turns.blocker = `unmappable_tool:${unmappable}`;
      continue;
    }
    if (text === '' && calls.length === 0) {
      stats.turns.skipped.empty_reply += 1;
      blocked = true;
      stats.turns.blocker = 'empty_reply';
      continue;
    }

    // Call ids are opaque to the host and must not carry transcript ids.
    calls.forEach((call, position) => { call.id = `rig_${index}_${position}`; });

    // The mock sees dsh's own history, so the key names the *mapped* tools of
    // the previous turn and the running count of executed calls.
    const names = calls.map((call) => call.name);
    const key = `${executedCalls}|${previousNames.join(',')}`;
    if (seenKeys.has(key)) {
      stats.turns.skipped.duplicate_key += 1;
      blocked = true;
      stats.turns.blocker = 'duplicate_key';
      continue;
    }
    seenKeys.add(key);

    const match = { tools_length: 'present', tool_results_count: executedCalls };
    if (previousNames.length > 0) match.last_assistant_tool_names = previousNames;
    if (replies.length === 0 && taskRegex !== null) {
      // Opt-in: the reciter's own task text, sanitized. Never source prose.
      match.last_user_text_matches = redact(taskRegex);
    }

    const reply = { type: calls.length > 0 ? 'tool_use' : 'text', text };
    if (calls.length > 0) reply.calls = calls;
    reply.stop_reason = calls.length > 0 ? 'tool_use' : 'end_turn';

    const number = String(replies.length + 1).padStart(2, '0');
    replies.push({
      name: `turn-${number}-tr${executedCalls}`,
      match,
      reply,
      meta: {
        source_iteration: Number.isInteger(turn.request.payload?.iteration) ? turn.request.payload.iteration : null,
        prompt_tail: promptTail(messages),
        source_stop_reason: typeof completion.stopReason === 'string' ? completion.stopReason : null,
        // Not the prompt text: the shape of the prompt's tail. `role` plus its
        // byte length is what a cap scenario would look at.
      },
    });
    stats.turns.mapped += 1;
    perTurn.push({ turn: number, tool_results: executedCalls, tool_names: previousNames, calls: calls.length, reply: reply.type });
    executedCalls += calls.length;
    previousNames = names;
  }

  const script = {
    title,
    replies,
    meta: {
      converter: 'dev/dsh-rig/replay.mjs',
      converter_version: CONVERTER_VERSION,
      source: {
        name: stats.source.name,
        bytes: stats.source.bytes,
        lines: stats.source.lines,
        sha256: stats.source.sha256,
      },
      caps: stats.caps,
      text_mode: textMode,
      turns: perTurn,
      skipped: stats.turns.skipped,
    },
  };
  stats.leaks = leakScan(JSON.stringify(script));
  return { script, stats };
}

/** Stable serialization for a determinism comparison. */
export function canonicalScript(script) {
  return JSON.stringify(script, null, 2);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const REPLAY_CLI_OPTIONS = optionsOf([
  ['--in', 'string', 'input'],
  ['--out', 'string', 'output'],
  ['--text-cap', 'string', 'textCap'],
  ['--max-replies', 'string', 'maxReplies'],
  ['--title', 'string'],
  ['--task-regex', 'string', 'taskRegex'],
  ['--text-mode', 'string', 'textMode'],
  ['--stats', 'string', 'statsPath'],
  ['--check', 'boolean'],
]);

const REPLAY_CLI_HELP = 'usage: replay.mjs --in <transcript.jsonl> --out <script.json> [--text-cap n]'
  + ' [--max-replies n] [--text-mode redact|placeholder] [--task-regex re] [--stats <file>] [--check]\n';

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: REPLAY_CLI_OPTIONS,
    prefix: 'replay.mjs: ',
    help: REPLAY_CLI_HELP,
  });
  const opts = {
    input: values.input ?? null,
    output: values.output ?? null,
    textCap: values.textCap === undefined ? 4000 : Number(values.textCap),
    maxReplies: values.maxReplies === undefined ? 24 : Number(values.maxReplies),
    title: values.title ?? 'Replay session',
    taskRegex: values.taskRegex ?? null,
    statsPath: values.statsPath ?? null,
    textMode: values.textMode ?? 'redact',
    check: values.check ?? false,
  };
  if (opts.input === null) throw new Error('replay.mjs: --in is required');
  if (opts.output === null) throw new Error('replay.mjs: --out is required');
  if (!Number.isInteger(opts.textCap) || opts.textCap < 0) throw new Error('replay.mjs: --text-cap must be a non-negative integer');
  if (!Number.isInteger(opts.maxReplies) || opts.maxReplies < 1) throw new Error('replay.mjs: --max-replies must be a positive integer');
  if (!TEXT_MODES.has(opts.textMode)) throw new Error(`replay.mjs: --text-mode must be one of ${[...TEXT_MODES].join('|')}`);
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
  const inputPath = resolve(opts.input);
  let text;
  try {
    text = readFileSync(inputPath, 'utf8');
  } catch (error) {
    process.stderr.write(`replay.mjs: cannot read ${inputPath}: ${error.message}\n`);
    process.exit(2);
  }
  const { script, stats } = convertTranscript(text, {
    textCap: opts.textCap,
    maxReplies: opts.maxReplies,
    title: opts.title,
    taskRegex: opts.taskRegex,
    textMode: opts.textMode,
    sourceName: basename(inputPath),
  });
  if (script.replies.length === 0) {
    process.stderr.write('replay.mjs: no replayable turn in the transcript\n');
    process.exit(1);
  }
  const serialized = `${canonicalScript(script)}\n`;
  writeFileSync(opts.output, serialized);
  const outputLeaks = leakScan(serialized);
  stats.leaks = outputLeaks;
  if (opts.statsPath !== null) writeFileSync(opts.statsPath, `${JSON.stringify({ ...stats, source: { ...stats.source, path: inputPath } }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'converted', out: opts.output, ...stats.turns, redaction: stats.redaction, leaks: outputLeaks.length })}\n`);
  if (opts.check && outputLeaks.length > 0) {
    for (const hit of outputLeaks) process.stderr.write(`LEAK ${hit.kind}: ${hit.sample}\n`);
    process.exit(3);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
