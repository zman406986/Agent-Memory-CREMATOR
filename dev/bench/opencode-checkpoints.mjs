#!/usr/bin/env node
/**
 * opencode checkpoint / token accounting — a separate reader, not part of the
 * live launcher (`opencode-run.mjs`).
 *
 * What it reads, from a FINISHED run:
 *   - `stdout.ndjson`: opencode's JSONL stream. The rows this reader uses are
 *     `step_start`, `tool_use` and `step_finish`. A `step_finish` row carries
 *     `part.tokens = { input, output, reasoning, cache: { read, write } }`;
 *     a `tool_use` row carries `part.tool` and `part.state.input.path`.
 *     2.2.5 writes no compaction row in this stream (checked across every
 *     opencode-shaped log under `scratchpad/`), but a row whose type, part type
 *     or part reason names compaction is counted when a future host writes one.
 *   - `result.json`: used only for cross-checks and totals the stdout stream
 *     does not carry (`spend.billedPromptTokens`, `compaction.compactionRequests`,
 *     `compaction.atMainRequests`, the workspace base path). It is optional on
 *     the command line; when absent those facts are reported as unknown, never
 *     as zero.
 *
 * Billed prompt tokens are the provider's own step counters:
 *
 *     billedPrompt = tokens.input + tokens.cache.read + tokens.cache.write
 *
 * `bodyBytes / 3` is never used and never accepted as a fallback. A step row
 * without a complete token object fails the whole read: a missing field is not
 * billed as 0, because a 0 that no guard can see is the fabrication this tool
 * exists to avoid.
 *
 * Checkpoints. The deliverable list is positional and names **exact** paths:
 * checkpoint `k` is the k-th entry of the run's resolved list — the list the
 * launcher resolved from its brief and wrote to
 * `result.task.deliverables.required` — or, when the result carries none, the
 * default list resolved from `dev/bench/bench-brief-extended.md`:
 * `docs/plans/2026-10-27-extended-audit/00-index.md` then `01-orientation.md`
 * … `12-corpus-zh.md`. Checkpoint k is the FIRST step whose
 * `write`/`edit`/`create` tool call names deliverable k. An override entry
 * ending in `-` is still read as a filename prefix; the default list uses none,
 * so a write to a differently-named `01-…` file is not checkpoint 2.
 *
 * Shell rows are not read as writes: the extended brief does not require a
 * shell, and the benchmark config denies it (`WORKSPACE_SHELL_POLICY` in
 * `opencode-run.mjs`). A `shell`/`bash`/`execute` row is counted in
 * `shellCalls` and reported, never guessed into a deliverable. 2.4.0 exposes
 * the tool as `shell`; a host that remaps `bash`/`execute` to that name is
 * still counted, as is a call left under an alias. If a future run leaves the
 * shell enabled, this reader would undercount shell redirection writes; that
 * limit is named here and in the report's notes rather than hidden.
 *
 * Per checkpoint this reports the step index, that step's `billedPrompt`, the
 * `runningTotal` through that step, `peak` (the highest single-step prompt seen
 * through that step) and `compactionSoFar`. Writes may arrive out of order; the
 * running totals still follow the step timeline, not the list order.
 *
 * Auxiliary requests. A title request, a tool-less chat request and a
 * compaction request carry no `step_finish` row in the captured streams. On a
 * `host-step-tokens` basis `result.json`'s `spend.billedPromptTokens` is the
 * sum of the same `step_finish` rows this reader sums, so the two totals cannot
 * differ on a runner-produced result. This report does not claim a
 * title/tool-less/compaction token split; it reports their request counts and
 * keeps the subtraction only as a consistency check:
 * `overall.stepTotalDifferenceTokens = result.billedPromptTokens -
 * stepBilledPrompt`. Zero is expected; a nonzero value means the two readers
 * disagree (the artifacts do not belong together, or a parser changed), and it
 * is reported as a mismatch, never as auxiliary tokens. The step total is never
 * amended.
 *
 * Under any other basis (`capture-estimate` as this bench's runner writes it,
 * any other non-host value, or a missing `meterBasis`, read defensively as
 * not-host-step) `result.spend.billedPromptTokens` is a bytes/3 capture
 * estimate: subtracting the step total from it measures estimator error, not a
 * bill. The report states the number as `captureEstimate` and leaves
 * `stepTotalDifferenceTokens` null.
 *
 * Compaction position. `result.json.compaction` carries two different indexes:
 * `atMainRequests` is the primary request position (main and compaction rows
 * only; ask, title and other rows are not counted) and is the one to compare
 * across arms; `atRequests` is the capture log's own sequence, every captured
 * row included. The report labels the position by `atMainRequests` and keeps
 * `atRequests` under its own name (`compactionPosition`). Neither is a step
 * index: per-checkpoint `compactionSoFar` can be placed in time only when the
 * stdout stream carries compaction rows. When it does not and result.json
 * reports a positive count, the per-checkpoint value is `null` — the total is
 * stated, its step-timeline position is not invented, and the host's
 * main-request position is stated separately.
 *
 * Usage:
 *
 *   node dev/bench/opencode-checkpoints.mjs <stdout.ndjson> [<result.json>] \
 *     [--deliverables <json-or-newline-file>] [--json]
 *
 * The deliverable override is either a JSON array of strings / `{"path": "…"}`
 * objects (or an object with a `deliverables` array) or a newline file with one
 * entry per line, blank lines and `#` comments ignored.
 *
 * Exit codes: 0 measured, 1 the log cannot be measured (malformed JSON, missing
 * token fields, unfinished step), 2 bad command line.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/**
 * The brief resolver both benches share. The default list is read from the
 * brief itself, so this reader and the launcher cannot name different files
 * (ISSUE-247).
 */
import { deliverablesFromBrief } from './dsh-checkpoints.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

export const TOOL_NAME = 'opencode-checkpoints';

/**
 * The thirteen files the extended brief tells the agent to write, in order,
 * each an exact workspace-relative path. They are read from the brief's own
 * "Write <name>" lines (`dev/bench/bench-brief-extended.md`), not from either
 * arm's transcript: `00-index.md` is checkpoint 1 and `01-` … `12-` are
 * checkpoints 2 … 13. The old list named the `01-` … `12-` filename prefixes,
 * so a write to a differently-named `01-*` file counted as the same checkpoint;
 * a checkpoint now names one deliverable.
 */
export const DELIVERABLE_DIR = 'docs/plans/2026-10-27-extended-audit';

/**
 * The thirteen-record brief the default list comes from, and the same thirteen
 * exact paths as a literal. The list is resolved from the brief's own task text
 * with the shared `deliverablesFromBrief`, so the reader and the launcher read
 * one source; the literal is used only when the brief file is not beside this
 * module (a standalone copy of the reader). A run with its own list carries it
 * in `result.task.deliverables.required`, which `analyzeText` prefers over this
 * default (ISSUE-247).
 */
const DEFAULT_BRIEF_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bench-brief-extended.md');

const DEFAULT_DELIVERABLES_FALLBACK = Object.freeze([
  `${DELIVERABLE_DIR}/00-index.md`,
  `${DELIVERABLE_DIR}/01-orientation.md`,
  `${DELIVERABLE_DIR}/02-entry-currency.md`,
  `${DELIVERABLE_DIR}/03-core-charter.md`,
  `${DELIVERABLE_DIR}/04-core-tests.md`,
  `${DELIVERABLE_DIR}/05-shell-quarantine.md`,
  `${DELIVERABLE_DIR}/06-gate-coverage.md`,
  `${DELIVERABLE_DIR}/07-plan-traceability.md`,
  `${DELIVERABLE_DIR}/08-distillation-audit.md`,
  `${DELIVERABLE_DIR}/09-open-triage.md`,
  `${DELIVERABLE_DIR}/10-plans-disposition.md`,
  `${DELIVERABLE_DIR}/11-corpus-en.md`,
  `${DELIVERABLE_DIR}/12-corpus-zh.md`,
]);

function defaultDeliverables() {
  try {
    const brief = readFileSync(DEFAULT_BRIEF_PATH, 'utf8');
    const resolved = deliverablesFromBrief(brief, brief);
    if (Array.isArray(resolved) && resolved.length > 0) {
      return Object.freeze([...resolved]);
    }
  } catch {
    // A missing or unreadable brief is not a measurement; the literal list is
    // the same thirteen exact paths.
  }
  return DEFAULT_DELIVERABLES_FALLBACK;
}

export const DEFAULT_DELIVERABLES = defaultDeliverables();

export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'create']);
export const READ_TOOLS = Object.freeze(['read']);
/**
 * The shell names the benchmark denies. A row under one of these names is
 * counted and reported, never read as a deliverable write: the brief needs no
 * shell and the launcher denies it (`WORKSPACE_SHELL_POLICY`). `shell` is the
 * name installed 2.4.0 exposes; `bash` and `execute` are the alias spellings a
 * captured call may still carry.
 */
export const SHELL_TOOLS = Object.freeze(['bash', 'execute', 'shell']);

const PREFIX = `${TOOL_NAME}:`;

/** A JSON object (not null, not an array). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(object, keys) {
  if (!isRecord(object)) return null;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** Normalize a host path to forward slashes, without a trailing slash. */
function toPosix(value) {
  return String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

/** Windows-style paths (drive letter or backslash) compare case-insensitively. */
function windowsish(value) {
  return value.includes('\\') || /^[A-Za-z]:\//.test(value);
}

function pathEquals(a, b, caseInsensitive) {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The path a write names, expressed relative to the run workspace when the base
 * is known. `null` when the write sits outside the base (then callers fall back
 * to suffix matching).
 */
function stripBase(writePath, base) {
  if (!base) return null;
  const path = toPosix(writePath);
  const root = toPosix(base);
  if (root === '') return null;
  const caseInsensitive = windowsish(path) || windowsish(root);
  const head = path.slice(0, root.length);
  const tail = path.slice(root.length);
  if (pathEquals(head, root, caseInsensitive) && (tail === '' || tail[0] === '/')) {
    return tail.replace(/^\/+/, '');
  }
  return null;
}

/**
 * One deliverable entry. A trailing `-` marks a filename prefix; every other
 * entry is an exact path.
 * @param {string} raw
 * @param {number} k 1-based position in the list
 */
function makeDeliverable(raw, k) {
  const clean = toPosix(String(raw).trim()).replace(/^\.\//, '');
  if (clean === '') throw new Error(`${PREFIX} deliverable ${k} is empty`);
  const prefix = clean.endsWith('-');
  const withoutTrailing = clean;
  const slash = withoutTrailing.lastIndexOf('/');
  const dir = slash >= 0 ? withoutTrailing.slice(0, slash) : '';
  const name = slash >= 0 ? withoutTrailing.slice(slash + 1) : withoutTrailing;
  if (name === '') throw new Error(`${PREFIX} deliverable ${k} has no filename: ${raw}`);
  return {
    k,
    raw: clean,
    dir,
    name,
    prefix,
    exact: prefix ? null : clean,
    display: prefix ? `${dir === '' ? '' : `${dir}/`}${name}*` : clean,
    full: prefix ? null : `${dir === '' ? '' : `${dir}/`}${name}`,
  };
}

/**
 * Parse a deliverable list from JSON or newline text.
 * @param {string} text
 * @param {string} source label used in errors
 */
export function parseDeliverables(text, source = '<deliverables>') {
  const cleanText = String(text ?? '').replace(/^\uFEFF/, '');
  if (cleanText.trim() === '') throw new Error(`${PREFIX} deliverable list ${source} is empty`);
  const trimmed = cleanText.trim();
  let rawEntries;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${PREFIX} deliverable list ${source} is not valid JSON: ${error.message}`);
    }
    const items = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.deliverables) ? data.deliverables : null;
    if (items === null) {
      throw new Error(`${PREFIX} deliverable list ${source} must be an array or an object with a deliverables array`);
    }
    rawEntries = items.map((item, index) => {
      if (typeof item === 'string') return item;
      if (isRecord(item) && typeof item.path === 'string') return item.path;
      throw new Error(`${PREFIX} deliverable list ${source} entry ${index + 1} is not a string or {"path": "…"}`);
    });
  } else {
    rawEntries = cleanText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  }
  if (rawEntries.length === 0) throw new Error(`${PREFIX} deliverable list ${source} is empty`);
  return rawEntries.map((raw, index) => makeDeliverable(raw, index + 1));
}

/**
 * Whether one write path creates one deliverable. Exact entries match the
 * workspace-relative path, or its suffix when no workspace base is known.
 * Prefix entries match on the filename prefix inside their directory.
 * @returns {{matched: boolean, candidate: string, via: 'workspace-relative'|'suffix'}}
 */
export function matchDeliverable(writePath, deliverable, base = null) {
  const path = toPosix(writePath);
  const relative = stripBase(path, base);
  const candidate = relative !== null ? relative : path.replace(/^\/+/, '');
  const via = relative !== null ? 'workspace-relative' : 'suffix';
  // Stripping a Windows base leaves a relative path with no `\` or drive
  // letter, so `windowsish` alone loses the case-insensitivity the host
  // filesystem still applies. Fold case for the workspace-relative comparison
  // on win32, exactly as `dsh-checkpoints.mjs` does (ISSUE-391/ISSUE-582).
  const caseInsensitive = windowsish(candidate)
    || (via === 'workspace-relative' && process.platform === 'win32');
  if (deliverable.prefix) {
    const slash = candidate.lastIndexOf('/');
    const parent = slash >= 0 ? candidate.slice(0, slash) : '';
    const name = slash >= 0 ? candidate.slice(slash + 1) : candidate;
    const comparableParent = caseInsensitive ? parent.toLowerCase() : parent;
    const comparableDir = caseInsensitive ? deliverable.dir.toLowerCase() : deliverable.dir;
    const sameDir = deliverable.dir === ''
      || comparableParent === comparableDir
      || comparableParent.endsWith(`/${comparableDir}`);
    const samePrefix = caseInsensitive
      ? name.toLowerCase().startsWith(deliverable.name.toLowerCase())
      : name.startsWith(deliverable.name);
    return { matched: sameDir && samePrefix, candidate, via };
  }
  if (pathEquals(candidate, deliverable.full, caseInsensitive)) {
    return { matched: true, candidate, via };
  }
  if (via === 'suffix') {
    const full = deliverable.full;
    const suffixMatch = caseInsensitive
      ? candidate.toLowerCase().endsWith(`/${full.toLowerCase()}`)
      : candidate.endsWith(`/${full}`);
    return { matched: suffixMatch, candidate, via };
  }
  return { matched: false, candidate, via };
}

/** A finite, non-negative count or throw naming the exact field. */
function requiredCount(object, key, label) {
  const value = object?.[key];
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${PREFIX} ${label} is ${value === undefined ? 'missing' : JSON.stringify(value)}; `
      + 'the host recorded a step row without a complete token field, and it is not billed as 0');
  }
  return parsed;
}

/** A count array that may be absent, but every present entry must be a count. */
function optionalCountArray(object, key, label) {
  const value = object?.[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${PREFIX} ${label} is ${JSON.stringify(value)}, which is not an array of counts`);
  }
  return value.map((entry, index) => {
    const parsed = typeof entry === 'number'
      ? entry
      : typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${PREFIX} ${label}[${index}] is ${JSON.stringify(entry)}, which is not a count`);
    }
    return parsed;
  });
}

/** A count that may be absent, but must be numeric when present. */
function optionalCount(object, key, label) {
  const value = object?.[key];
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${PREFIX} ${label} is ${JSON.stringify(value)}, which is not a count`);
  }
  return parsed;
}

/** The token fields of one step, or a loud refusal. `reasoning` is optional. */
function readTokens(part, stepIndex) {
  const tokens = part?.tokens;
  if (!isRecord(tokens)) {
    throw new Error(`${PREFIX} step ${stepIndex} has no tokens object; `
      + 'the log records a step row without token fields, so no prompt can be billed');
  }
  const input = requiredCount(tokens, 'input', `step ${stepIndex} tokens.input`);
  const output = requiredCount(tokens, 'output', `step ${stepIndex} tokens.output`);
  if (!isRecord(tokens.cache)) {
    throw new Error(`${PREFIX} step ${stepIndex} tokens.cache is missing; `
      + 'cache read and cache write are part of the billed prompt and are not billed as 0');
  }
  const cacheRead = requiredCount(tokens.cache, 'read', `step ${stepIndex} tokens.cache.read`);
  const cacheWrite = requiredCount(tokens.cache, 'write', `step ${stepIndex} tokens.cache.write`);
  const reasoning = optionalCount(tokens, 'reasoning', `step ${stepIndex} tokens.reasoning`);
  return { input, cacheRead, cacheWrite, output, reasoning };
}

/** Does this row name a compaction event? End/finish rows are not the event. */
function isCompactionRow(row) {
  const labels = [row?.type, row?.part?.type, row?.part?.reason]
    .filter((value) => typeof value === 'string');
  return labels.some((label) => /compact/i.test(label) && !/(end|finish|complete)/i.test(label));
}

/**
 * Parse `stdout.ndjson`.
 *
 * A step opens at `step_start`, collects the `tool_use` rows that follow, and
 * closes at `step_finish` with its tokens. A fixture may omit `step_start`;
 * the step then opens implicitly at its first tool row or at `step_finish`.
 * A step that opens and never finishes, or finishes without tokens, fails the
 * read. The stream is scanned in file order, so a tool row belongs to the step
 * that surrounds it.
 */
export function parseStdout(text, source = '<stdout>') {
  const lines = String(text).split(/\r?\n/);
  const steps = [];
  const rowTypes = new Map();
  let current = null;
  let compactionEvents = 0;
  let compactionRows = 0;

  const openStep = (implicit) => ({
    index: steps.length + 1,
    implicit,
    startedAt: null,
    tools: [],
  });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${PREFIX} ${source}:${i + 1} is not JSON: ${error.message}`);
    }
    if (!isRecord(row)) throw new Error(`${PREFIX} ${source}:${i + 1} is not a JSON object`);
    const type = typeof row.type === 'string' ? row.type : '';
    rowTypes.set(type, (rowTypes.get(type) ?? 0) + 1);
    if (isCompactionRow(row)) {
      compactionRows += 1;
      compactionEvents += 1;
    }

    if (type === 'step_start') {
      if (current !== null) {
        throw new Error(`${PREFIX} ${source}:${i + 1}: step_start while step ${current.index} is `
          + 'still open; the step rows cannot be paired, so no token can be attributed');
      }
      current = openStep(false);
      current.startedAt = typeof row.timestamp === 'number' ? row.timestamp : null;
      continue;
    }

    if (type === 'tool_use') {
      if (current === null) current = openStep(true);
      const part = isRecord(row.part) ? row.part : {};
      const state = isRecord(part.state) ? part.state : {};
      const input = isRecord(state.input) ? state.input : (isRecord(part.input) ? part.input : null);
      current.tools.push({
        tool: typeof part.tool === 'string' ? part.tool.toLowerCase() : '',
        path: firstString(input, ['path', 'filePath', 'file_path', 'filepath']),
        status: typeof state.status === 'string' ? state.status : null,
      });
      continue;
    }

    if (type === 'step_finish') {
      if (current === null) current = openStep(true);
      const part = isRecord(row.part) ? row.part : {};
      const tokens = readTokens(part, current.index);
      steps.push({
        index: current.index,
        implicit: current.implicit,
        startedAt: current.startedAt,
        finishedAt: typeof row.timestamp === 'number' ? row.timestamp : null,
        reason: typeof part.reason === 'string' ? part.reason : null,
        cost: typeof part.cost === 'number' ? part.cost : null,
        tools: current.tools,
        compactionSoFar: compactionEvents,
        ...tokens,
      });
      current = null;
      continue;
    }
  }

  if (current !== null) {
    throw new Error(`${PREFIX} step ${current.index} started but never finished with a step_finish; `
      + 'its tokens are missing, so nothing can be billed for it');
  }
  if (steps.length === 0) {
    throw new Error(`${PREFIX} ${source} has no step_finish rows; no token fields were recorded`);
  }

  let runningTotal = 0;
  let peak = 0;
  for (const step of steps) {
    step.billedPrompt = step.input + step.cacheRead + step.cacheWrite;
    runningTotal += step.billedPrompt;
    step.runningTotal = runningTotal;
    peak = Math.max(peak, step.billedPrompt);
    step.peak = peak;
  }

  return {
    steps,
    rowTypes: [...rowTypes.entries()].map(([type, count]) => ({ type, count })),
    compactionEvents,
    compactionRows,
  };
}

/** Read the result.json facts this tool cross-checks; never invents a value. */
export function parseResult(text, source = '<result>') {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (error) {
    throw new Error(`${PREFIX} ${source} is not JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new Error(`${PREFIX} ${source} is not a JSON object`);
  const workspace = isRecord(data.workspace) ? data.workspace : null;
  const spend = isRecord(data.spend) ? data.spend : null;
  const compaction = isRecord(data.compaction) ? data.compaction : null;
  const task = isRecord(data.task) ? data.task : null;
  const deliverables = isRecord(task?.deliverables) ? task.deliverables : null;
  return {
    base: firstString(workspace, ['path', 'cwd']) ?? firstString(data, ['workspacePath', 'cwd']),
    /**
     * The launcher's resolved deliverable list. It is `null` on an older or
     * externally assembled result, whose reader falls back to the brief's
     * default list (ISSUE-247).
     */
    checkpointPaths: Array.isArray(deliverables?.required)
      ? deliverables.required.filter((path) => typeof path === 'string' && path.length > 0)
      : null,
    billedPromptTokens: optionalCount(spend, 'billedPromptTokens', 'result spend.billedPromptTokens'),
    billedCompletionTokens: optionalCount(spend, 'billedCompletionTokens', 'result spend.billedCompletionTokens'),
    meterBasis: typeof spend?.meterBasis === 'string' ? spend.meterBasis : null,
    compactionRequests: optionalCount(compaction, 'compactionRequests', 'result compaction.compactionRequests'),
    compactionAtRequests: optionalCountArray(compaction, 'atRequests', 'result compaction.atRequests'),
    compactionAtMainRequests: optionalCountArray(compaction, 'atMainRequests', 'result compaction.atMainRequests'),
    compactionJournalEvents: optionalCount(compaction, 'journalEvents', 'result compaction.journalEvents'),
    titleRequests: optionalCount(compaction, 'titleRequests', 'result compaction.titleRequests'),
    toolLessChatRequests: optionalCount(compaction, 'toolLessChatRequests', 'result compaction.toolLessChatRequests'),
    compactionKeyWritten: typeof compaction?.keyWritten === 'boolean' ? compaction.keyWritten : null,
    arm: typeof data.arm === 'string' ? data.arm : null,
    runId: typeof data.runId === 'string' ? data.runId : null,
    finalText: task && typeof task.finalText === 'string' ? task.finalText : null,
  };
}

function resolveDeliverables({ deliverables, deliverablesText, deliverablesSource, resultPaths }) {
  if (Array.isArray(deliverables)) {
    return parseDeliverables(JSON.stringify(deliverables), '<deliverables array>');
  }
  if (deliverablesText !== undefined && deliverablesText !== null) {
    return parseDeliverables(deliverablesText, deliverablesSource);
  }
  /**
   * The run's own resolved list wins over this reader's default: a 32-record
   * run names thirty-two checkpoints in its result, and reading the thirteen
   * defaults would silently report nineteen records as missing (ISSUE-247).
   */
  if (Array.isArray(resultPaths) && resultPaths.length > 0) {
    return parseDeliverables(JSON.stringify(resultPaths), '<result task.deliverables.required>');
  }
  return parseDeliverables(DEFAULT_DELIVERABLES.join('\n'), '<default>');
}

/** A tool row with no status is treated as completed; any other status is not. */
function toolSucceeded(tool) {
  return tool.status === null || tool.status === 'completed';
}

function stepTools(step) {
  return step.tools.map((tool) => ({
    tool: tool.tool,
    path: tool.path,
    status: tool.status,
  }));
}

/**
 * Analyze one finished run. Pure: it takes text and returns a report object.
 *
 * @param {{stdoutText: string, resultText?: string|null, deliverables?: string[]|null,
 *   deliverablesText?: string|null, deliverablesSource?: string,
 *   stdoutPath?: string, resultPath?: string|null}} input
 */
export function analyzeText({
  stdoutText,
  resultText = null,
  deliverables = null,
  deliverablesText = null,
  deliverablesSource = '<deliverables>',
  stdoutPath = '<stdout>',
  resultPath = null,
}) {
  if (typeof stdoutText !== 'string') throw new Error(`${PREFIX} stdout text is required`);
  const parsed = parseStdout(stdoutText, stdoutPath);
  const result = resultText === null || resultText === undefined
    ? null
    : parseResult(resultText, resultPath ?? '<result>');
  const list = resolveDeliverables({
    deliverables,
    deliverablesText,
    deliverablesSource,
    resultPaths: result?.checkpointPaths ?? null,
  });
  const base = result?.base ?? null;

  const writeCalls = [];
  const readCalls = [];
  const shellCalls = [];
  for (const step of parsed.steps) {
    for (const tool of step.tools) {
      if (WRITE_TOOLS.includes(tool.tool)) writeCalls.push({ step: step.index, ...tool });
      if (READ_TOOLS.includes(tool.tool)) readCalls.push({ step: step.index, ...tool });
      if (SHELL_TOOLS.includes(tool.tool)) {
        shellCalls.push({ step: step.index, tool: tool.tool, path: tool.path });
      }
    }
  }
  const completedWrites = writeCalls.filter((write) => toolSucceeded(write));

  const hasCompactionRows = parsed.compactionRows > 0;
  const checkpoints = list.map((deliverable) => {
    let found = null;
    let matchedVia = null;
    for (const step of parsed.steps) {
      for (const tool of step.tools) {
        if (!WRITE_TOOLS.includes(tool.tool) || !tool.path || !toolSucceeded(tool)) continue;
        const match = matchDeliverable(tool.path, deliverable, base);
        if (match.matched) {
          found = step;
          matchedVia = match.via;
          break;
        }
      }
      if (found !== null) break;
    }
    let compactionSoFar = null;
    if (found !== null) {
      if (hasCompactionRows) compactionSoFar = found.compactionSoFar;
      else if (result?.compactionRequests === 0) compactionSoFar = 0;
    }
    return {
      k: deliverable.k,
      path: deliverable.display,
      spec: deliverable.raw,
      prefix: deliverable.prefix,
      created: found !== null,
      step: found ? found.index : null,
      stepReason: found ? found.reason : null,
      billedPrompt: found ? found.billedPrompt : null,
      runningTotal: found ? found.runningTotal : null,
      peak: found ? found.peak : null,
      compactionSoFar,
      matchedVia,
    };
  });

  const totalBilledPrompt = parsed.steps.at(-1).runningTotal;
  const peakFill = parsed.steps.reduce((max, step) => Math.max(max, step.billedPrompt), 0);
  const finalFill = parsed.steps.at(-1).billedPrompt;
  const created = checkpoints.filter((checkpoint) => checkpoint.created);
  const missing = checkpoints.filter((checkpoint) => !checkpoint.created);
  const nonDeliverableWrites = completedWrites.filter((write) => !write.path
    || !list.some((deliverable) => matchDeliverable(write.path, deliverable, base).matched));
  const distinctNonDeliverable = [...new Set(nonDeliverableWrites.map((write) => write.path ?? '<no path>'))];
  const implicitSteps = parsed.steps.filter((step) => step.implicit);
  const rowTypes = parsed.rowTypes;
  const knownRowTypes = new Set(['step_start', 'tool_use', 'step_finish']);
  const unknownRows = rowTypes.filter((entry) => !knownRowTypes.has(entry.type)
    && !/compact/i.test(entry.type) && entry.type !== 'text');

  const resultBilledPromptMatches = result?.billedPromptTokens === null
    || result?.billedPromptTokens === undefined
    ? null
    : result.billedPromptTokens === totalBilledPrompt;
  /**
   * The host total against the step sum. On a `host-step-tokens` basis the
   * runner computes `result.spend.billedPromptTokens` from the same
   * `step_finish` rows this reader sums, so the difference is structurally 0:
   * a nonzero value means the two readers disagree (the artifacts do not belong
   * together, or a parser changed), never that title/tool-less/compaction
   * requests were metered. The subtraction is kept only as that mismatch
   * check; no token split is invented. Under any other basis the host total is
   * a capture estimate, stated as `captureEstimate` and never subtracted.
   */
  const resultBilledPromptTokens = result?.billedPromptTokens ?? null;
  const meterBasis = result?.meterBasis ?? null;
  const hostStepBasis = meterBasis === 'host-step-tokens';
  const stepTotalDifferenceTokens = !hostStepBasis || resultBilledPromptTokens === null
    ? null : resultBilledPromptTokens - totalBilledPrompt;
  const auxiliaryCounts = result === null
    ? null
    : [result.titleRequests, result.toolLessChatRequests, result.compactionRequests];
  /** The sum only when every component is known; a missing count is not 0. */
  const auxiliaryRequestCount = auxiliaryCounts === null
    || auxiliaryCounts.some((count) => count === null)
    ? null
    : auxiliaryCounts.reduce((sum, count) => sum + count, 0);
  /**
   * Under a non-host basis the host total is a capture estimate (bytes / 3 over
   * the captured request bodies). It is reported here under its own name, never
   * as billed spend.
   */
  const captureEstimate = hostStepBasis || result === null || resultBilledPromptTokens === null
    ? null
    : {
      label: 'captured-body prompt estimate (bytes / 3); not a host meter and not billed spend',
      meterBasis,
      tokens: resultBilledPromptTokens,
      note: meterBasis === null
        ? 'result.spend.meterBasis is missing, so the total is not proven to be host step tokens '
          + 'and is treated as a capture estimate'
        : `result.spend.meterBasis is ${JSON.stringify(meterBasis)}, so the total is a capture `
          + 'estimate, not a host step-token count',
    };

  const notes = [];
  notes.push(`${parsed.steps.length} metered step(s); every step carried `
    + 'tokens.input, tokens.cache.read, tokens.cache.write and tokens.output '
    + '(tokens.reasoning is optional). Billed prompt = input + cache read + cache write.');
  if (result === null) {
    notes.push('result.json was not supplied: the compaction total and the billed-prompt cross-check are unknown, not zero.');
  }
  if (result !== null && !hostStepBasis) {
    notes.push(`result.spend.meterBasis is ${meterBasis === null ? 'missing' : JSON.stringify(meterBasis)}, `
      + 'not host-step-tokens: result.spend.billedPromptTokens is a capture estimate '
      + `(${String(resultBilledPromptTokens ?? 'unknown')}) and is reported as captureEstimate; `
      + 'it is not subtracted from the step total.');
  }
  if (result !== null && resultBilledPromptMatches === false) {
    if (hostStepBasis) {
      notes.push(`this reader sums ${totalBilledPrompt} billed prompt token(s) from stdout `
        + `step_finish rows; result.json spend.billedPromptTokens is ${result.billedPromptTokens} `
        + `(difference ${String(stepTotalDifferenceTokens)}). The runner computes that total from `
        + 'the same rows, so a nonzero difference means the two readers disagree (the artifacts do '
        + 'not belong together, or a parser changed); it is not a title/tool-less/compaction token '
        + 'reading.');
    } else {
      notes.push(`computed step billed prompt ${totalBilledPrompt} != result.json `
        + `spend.billedPromptTokens ${result.billedPromptTokens}; the difference is not overhead, `
        + 'because the host total is a capture estimate; both numbers are shown and neither is amended.');
    }
  }
  if (result !== null && auxiliaryCounts.some((count) => (count ?? 0) > 0)) {
    notes.push(`result.json records ${formatNumber(result.titleRequests)} title request(s), `
      + `${formatNumber(result.toolLessChatRequests)} tool-less chat request(s) and `
      + `${formatNumber(result.compactionRequests)} compaction request(s); those are request counts, `
      + 'not a token split, and the step total carries no prompt tokens for them.');
  }
  if (result !== null && resultBilledPromptMatches === true) {
    notes.push(`computed billed prompt ${totalBilledPrompt} matches result.json spend.billedPromptTokens `
      + '(the same host step_finish rows; expected).');
  }
  if (stepTotalDifferenceTokens !== null && stepTotalDifferenceTokens < 0) {
    notes.push(`the difference is negative: the step rows prove ${Math.abs(stepTotalDifferenceTokens)} `
      + 'more billed prompt token(s) than result.json spend.billedPromptTokens; it is reported as a '
      + 'reader mismatch, not clamped to zero.');
  }
  if (shellCalls.length > 0) {
    notes.push(`${shellCalls.length} shell/bash/execute row(s) are reported and not read as `
      + 'writes; the extended brief needs no shell and the benchmark config denies it.');
  }
  if (result !== null && Array.isArray(result.compactionAtMainRequests)
    && result.compactionAtMainRequests.length > 0) {
    notes.push(`result.json records the host compaction position at main request `
      + `[${result.compactionAtMainRequests.join(', ')}] (primary-request index: main and `
      + `compaction rows only); the capture sequence is `
      + `[${(result.compactionAtRequests ?? []).join(', ')}] (every captured row, ask and title `
      + 'included). Neither index is a step index, so neither places a compaction on the '
      + 'per-checkpoint step timeline.');
  }
  if (!hasCompactionRows && (result?.compactionRequests ?? 0) > 0) {
    notes.push(`the stdout stream carries no compaction rows while result.json reports `
      + `${result.compactionRequests} compaction request(s); per-checkpoint compaction counts are null, `
      + 'not 0 — the total exists, its position in the step timeline does not.');
  } else if (!hasCompactionRows && result?.compactionRequests === 0) {
    notes.push('the stdout stream carries no compaction rows and result.json reports 0 compaction requests.');
  }
  if (hasCompactionRows) {
    notes.push(`stdout carries ${parsed.compactionRows} compaction row(s), counted as events `
      + '(rows whose type/part type/reason names compaction; end/finish rows are excluded).');
    if (result?.compactionRequests !== null && result?.compactionRequests !== undefined
      && result.compactionRequests !== parsed.compactionRows) {
      notes.push(`stdout compaction rows (${parsed.compactionRows}) != result.json compactionRequests `
        + `(${result.compactionRequests}); the two measure different things and both are shown.`);
    }
  }
  if (nonDeliverableWrites.length > 0) {
    notes.push(`${nonDeliverableWrites.length} write/edit/create call(s) name no deliverable `
      + `(${distinctNonDeliverable.slice(0, 5).join(', ')}${distinctNonDeliverable.length > 5 ? ', …' : ''}).`);
  }
  if (writeCalls.length === 0) {
    notes.push('no write/edit/create tool rows: no deliverable was created.');
  } else if (completedWrites.length < writeCalls.length) {
    notes.push(`${writeCalls.length - completedWrites.length} write/edit/create row(s) did not complete `
      + 'and are not counted as creation.');
  }
  if (implicitSteps.length > 0) {
    notes.push(`${implicitSteps.length} step(s) had no step_start row and were opened implicitly `
      + 'at their first tool row or step_finish.');
  }
  if (unknownRows.length > 0) {
    notes.push(`unrecognized row type(s), ignored: ${unknownRows.map((entry) => `${entry.type}×${entry.count}`).join(', ')}.`);
  }

  const stdoutBytes = Buffer.byteLength(stdoutText, 'utf8');
  return {
    tool: TOOL_NAME,
    version: 2,
    source: {
      stdout: {
        path: stdoutPath,
        bytes: stdoutBytes,
        sha256: createHash('sha256').update(stdoutText, 'utf8').digest('hex'),
        rows: rowTypes.reduce((sum, entry) => sum + entry.count, 0),
      },
      result: result === null ? null : {
        path: resultPath ?? '<result>',
        bytes: Buffer.byteLength(resultText, 'utf8'),
        sha256: createHash('sha256').update(resultText, 'utf8').digest('hex'),
      },
    },
    workspaceBase: base,
    rowTypes,
    steps: parsed.steps.map((step) => ({
      index: step.index,
      reason: step.reason,
      input: step.input,
      cacheRead: step.cacheRead,
      cacheWrite: step.cacheWrite,
      output: step.output,
      reasoning: step.reasoning,
      billedPrompt: step.billedPrompt,
      runningTotal: step.runningTotal,
      peak: step.peak,
      compactionSoFar: step.compactionSoFar,
      tools: stepTools(step),
    })),
    checkpoints,
    /**
     * Where the host placed each compaction. `atMainRequests` is the primary
     * request index (main and compaction rows only; ask, title and other rows
     * are excluded) and is the position to compare across arms; `atRequests` is
     * the capture log's own sequence, every captured row included, kept under
     * its own name so the two are not read as one index. Null when no
     * result.json was supplied; each array is null when the result lacks it.
     */
    compactionPosition: result === null ? null : {
      label: 'host compaction position: primary (main and compaction) request index',
      atMainRequests: result.compactionAtMainRequests,
      captureSequence: {
        label: 'capture sequence (every captured row, ask and title included); '
          + 'not the primary-request position',
        atRequests: result.compactionAtRequests,
      },
    },
    /** The non-host reading: result.spend.billedPromptTokens as a bytes/3 estimate, or null. */
    captureEstimate,
    overall: {
      steps: parsed.steps.length,
      totalBilledPrompt,
      peakFill,
      finalFill,
      /**
       * result.spend.billedPromptTokens minus the step sum, on a host-step basis
       * only. The runner sums the same stdout rows, so 0 is expected; a nonzero
       * value is a reader disagreement, not an auxiliary-request token reading.
       */
      stepTotalDifferenceTokens,
      auxiliaryRequestCount,
      stdoutCompactionEvents: parsed.compactionEvents,
      hostCompactionRequests: result?.compactionRequests ?? null,
      /** The capture log's sequence positions, every captured row included; kept under its own name. */
      hostCompactionAtRequests: result?.compactionAtRequests ?? null,
      /** The primary (main and compaction) request positions: the comparable compaction timing. */
      hostCompactionAtMainRequests: result?.compactionAtMainRequests ?? null,
      hostCompactionJournalEvents: result?.compactionJournalEvents ?? null,
      hostTitleRequests: result?.titleRequests ?? null,
      hostToolLessChatRequests: result?.toolLessChatRequests ?? null,
      compactionKeyWritten: result?.compactionKeyWritten ?? null,
      deliverableCount: list.length,
      deliverablesCreated: created.length,
      deliverablesMissing: missing.length,
      createdPaths: created.map((checkpoint) => checkpoint.path),
      missingPaths: missing.map((checkpoint) => checkpoint.path),
      writeCalls: writeCalls.length,
      completedWriteCalls: completedWrites.length,
      readCalls: readCalls.length,
      shellCalls: shellCalls.length,
      shellTools: [...new Set(shellCalls.map((call) => call.tool))].sort(),
      writeTools: [...new Set(writeCalls.map((write) => write.tool))].sort(),
      nonDeliverableWrites: nonDeliverableWrites.length,
      resultBilledPromptTokens: result?.billedPromptTokens ?? null,
      resultBilledPromptMatches,
      arm: result?.arm ?? null,
      runId: result?.runId ?? null,
      finalText: result?.finalText ?? null,
    },
    notes,
  };
}

/** Read both files and analyze them. */
export function analyzeRun({ stdoutPath, resultPath = null, deliverablesPath = null }) {
  const stdoutText = readFileSync(resolve(stdoutPath), 'utf8');
  const resultText = resultPath === null ? null : readFileSync(resolve(resultPath), 'utf8');
  const deliverablesText = deliverablesPath === null ? null : readFileSync(resolve(deliverablesPath), 'utf8');
  return analyzeText({
    stdoutText,
    resultText,
    deliverablesText,
    deliverablesSource: deliverablesPath ?? '<deliverables>',
    stdoutPath,
    resultPath,
  });
}

function formatNumber(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function formatList(values) {
  return Array.isArray(values) ? `[${values.join(', ')}]` : '—';
}

/** A compact human report. `--json` emits the object instead. */
export function formatReport(report) {
  const lines = [];
  lines.push(`${TOOL_NAME}: ${report.source.stdout.path}`);
  lines.push(`result.json: ${report.source.result?.path ?? '(not supplied)'}`);
  lines.push(`steps: ${report.overall.steps}   `
    + `totalBilledPrompt: ${report.overall.totalBilledPrompt}   `
    + `peakFill: ${report.overall.peakFill}   finalFill: ${report.overall.finalFill}`);
  if (report.compactionPosition !== null
    && Array.isArray(report.compactionPosition.atMainRequests)
    && report.compactionPosition.atMainRequests.length > 0) {
    lines.push(`host compaction position: main request `
      + `${formatList(report.compactionPosition.atMainRequests)} (primary-request index)   `
      + `capture seq ${formatList(report.compactionPosition.captureSequence.atRequests)} `
      + '(capture sequence; ask and title rows included)');
  }
  if (report.captureEstimate !== null) {
    lines.push(`captureEstimate: ${formatNumber(report.captureEstimate.tokens)} prompt token(s) `
      + `(result.spend.meterBasis: ${formatNumber(report.captureEstimate.meterBasis)}); `
      + 'not host billed spend');
  }
  if (report.overall.stepTotalDifferenceTokens !== null
    && report.overall.stepTotalDifferenceTokens !== 0) {
    lines.push(`step reconciliation: MISMATCH — this reader sums `
      + `${report.overall.totalBilledPrompt} from stdout step_finish rows; result.json `
      + `spend.billedPromptTokens is ${formatNumber(report.overall.resultBilledPromptTokens)} `
      + `(difference ${formatNumber(report.overall.stepTotalDifferenceTokens)}); the two readers sum `
      + 'the same rows, so a nonzero difference is a disagreement, not auxiliary token overhead');
  }
  lines.push(`writes: ${report.overall.writeCalls}   reads: ${report.overall.readCalls}   `
    + `shell: ${report.overall.shellCalls}   `
    + `deliverables created: ${report.overall.deliverablesCreated}/${report.overall.deliverableCount}`);
  lines.push('');
  const header = ['k', 'deliverable', 'step', 'billedPrompt', 'runningTotal', 'peak', 'compaction'];
  const rows = report.checkpoints.map((checkpoint) => [
    String(checkpoint.k),
    checkpoint.path,
    formatNumber(checkpoint.step),
    formatNumber(checkpoint.billedPrompt),
    formatNumber(checkpoint.runningTotal),
    formatNumber(checkpoint.peak),
    formatNumber(checkpoint.compactionSoFar),
  ]);
  const widths = header.map((cell, column) => Math.max(
    cell.length,
    ...rows.map((row) => row[column].length),
  ));
  const render = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  lines.push(render(header));
  for (const row of rows) lines.push(render(row));
  if (report.overall.missingPaths.length > 0) {
    lines.push('');
    lines.push(`not created: ${report.overall.missingPaths.join(', ')}`);
  }
  lines.push('');
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join('\n');
}

function usage() {
  return `usage: node dev/bench/opencode-checkpoints.mjs <stdout.ndjson> [<result.json>] `
    + '[--deliverables <json-or-newline-file>] [--json]';
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const CHECKPOINT_OPTIONS = optionsOf([
  ['--json', 'boolean'],
  ['--deliverables', 'string', 'deliverablesPath', { short: 'd' }],
  ['--help', 'boolean', 'help', { short: 'h' }],
]);

export function parseArgs(argv) {
  const { values, positionals } = parseDevArgs(argv, {
    options: CHECKPOINT_OPTIONS,
    allowPositionals: true,
    // This script's own unknown-option wording; kept exactly.
    unknown: (rawName) => `unknown option ${rawName}`,
  });
  if (values.help === true) return { help: true };
  if (positionals.length === 0) throw new Error('a stdout.ndjson path is required');
  if (positionals.length > 2) throw new Error(`unexpected extra argument ${positionals[2]}`);
  const [stdoutPath, resultPath] = positionals;
  return {
    help: false,
    stdoutPath,
    resultPath: resultPath ?? null,
    deliverablesPath: values.deliverablesPath ?? null,
    json: values.json === true,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = analyzeRun({
      stdoutPath: options.stdoutPath,
      resultPath: options.resultPath,
      deliverablesPath: options.deliverablesPath,
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (error) {
    const message = String(error?.message ?? error);
    console.error(message.startsWith(PREFIX) ? message : `${PREFIX} ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
