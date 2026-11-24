#!/usr/bin/env node
/**
 * dsh checkpoint / token accounting — a separate reader for a FINISHED dsh run,
 * not part of the launcher (`bench-run.mjs`).
 *
 * What it reads:
 *   - `result.json` (required): the run's own projection. `usage` carries
 *     `inputTokens`, `cacheReadTokens`, `cacheWriteTokens` and
 *     `billedPromptTokens`; `context` carries the per-turn billed series;
 *     `compaction` carries the host's count and request positions; `session`
 *     names the session log; `journal.ledger` carries the host's own summary of
 *     the per-session ledger.
 *   - `session.v4.jsonl` (required): the host's own event log. A step opens at
 *     `step/start`; `assistant/message` carries `data.usage` for that step;
 *     `tool/call` carries the tool name and its JSON `arguments`; `tool/result`
 *     says whether the call failed. Native compactions are bracketed by
 *     `compaction/start` and `compaction/end`, and the mount's own tool-result
 *     trims are the separate `compaction/prune` rows.
 *   - the racoons journal (`cremator-events.jsonl`, optional): the product arm
 *     emits it; the vanilla arm does not. It supplies `prune-threshold`,
 *     `prune-ask`, `entry-ask` and the other lanes' counts.
 *   - the ledger (`ledger.sqlite`, optional): opened READ-ONLY with
 *     `node:sqlite`, so an evidence database is inspected without being
 *     mutated. The ledger is the recall store: one row per applied removal's
 *     recall id. Absence is reported as unknown, never as zero.
 *
 * Billed prompt tokens are the host's own step counters:
 *
 *     billedPrompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
 *
 * `inputTokens` and `cacheReadTokens` are REQUIRED on every assistant step; a
 * step row without either fails the whole read, because a 0 no guard can see is
 * the fabrication this tool exists to avoid. `cacheWriteTokens` is optional on
 * this host: the deepseek adapter writes no separate cache-write bucket, so the
 * field is absent from every real step row while result.usage states the bucket
 * as 0. An omitted bucket reads as 0 only when result.usage.cacheWriteTokens is
 * 0; if the host's own total is positive, the session/result total check fails
 * instead of inventing the missing part. `outputTokens` is reported when the
 * host wrote it and is never part of the billed prompt.
 *
 * Checkpoints. The expected list is positional and names EXACT paths. The
 * default (`DEFAULT_DELIVERABLES`) is the 2026-10-27 extended brief:
 * `docs/plans/2026-10-27-extended-audit/00-index.md` then `01-orientation.md`
 * … `12-corpus-zh.md`. A longer brief's list is taken from the run's own
 * `result.checkpoints.paths` (written by `bench-run.mjs` from the brief) or
 * from `--deliverables`, so the table follows that brief's order and count.
 *
 * `created`/`filesPresent` mean the deliverable FILE exists in the final arm.
 * The task's deliverable is the file, so a Python heredoc that writes
 * `OUT+'/00-index.md'` counts even when no write construct is parsed. The
 * write-call reading is SEPARATE (`overall.writeCalls`/`shellWriteCalls` and
 * each row's `method`): it attributes the step at which a call created the
 * file, and may be 0 while every file is present. `method` is found by one of
 * three attribution rules, tried in this order:
 *
 *   - `write-tool`: a completed `write`/`edit`/`create` call names the path;
 *   - `shell-write`: a completed `pwsh`/`powershell`/`bash`/`shell`/`execute`
 *     command writes the path in its own text — a redirection (`>`, `>>`),
 *     `Set-Content`, `Out-File`, `New-Item`, `tee`, `cp`, `mv`, an inline
 *     writer such as `write_text`/`WriteAllText`, or a similar construct;
 *   - `mention-fallback`: only when neither above matched, the exact path is
 *     mentioned by a completed non-write call (a non-shell call's path
 *     argument; a shell call's command text or result) AND the file exists in
 *     the final arm. It is the honest floor for a write this reader cannot
 *     parse; its step is an upper bound on creation and it never overrides a
 *     write. Write-tool content is not read, because an index deliverable lists
 *     every path and would mark every deliverable at its step.
 *
 * A file present with no parsed write is `created: true` with `method: null`
 * and a null step: the file is counted, the attribution is not invented. A
 * write that failed (`isError: true` in its `tool/result`) does not create the
 * checkpoint; a later completed write does. When the final arm directory is
 * absent the file question is unknown and the write attribution is the only
 * evidence. Writes may arrive out of list order: each checkpoint keeps the step
 * timeline, so a checkpoint created earlier can have a lower running total than
 * a lower-numbered checkpoint created later.
 *
 * Per checkpoint this reports:
 *   - `created` / `filesPresent`: the deliverable file exists in the final arm
 *     (null for `filesPresent` when the arm was not read);
 *   - `step`: the 1-based main-loop step a parsed write attributes the file to,
 *     or null when the file exists without a parsed write (attribution is never
 *     invented);
 *   - `billedPrompt`: that step's depth, `input + cache read + cache write`;
 *   - `runningTotal`: the running billed total through that step;
 *   - `peak`: the highest single-step prompt seen through that step;
 *   - `fillStep` / `fillPeak`: the plan's fill reading (the step's depth and
 *     the peak), stated separately so the table can carry both columns;
 *   - `compactionCount` / `lastCompactionStep`: native compactions seen by that
 *     step, placed by the step the compaction precedes;
 *   - `deliverablesDone`: how many of the expected deliverables exist by that
 *     step.
 *
 * Compaction timing. `compaction/start` fires in the host's pre-step hook, so
 * `atRequest` is 1 + the number of `step/start` rows before it: the compaction
 * belongs to the step it precedes. When the session log carries no
 * `compaction/start` row but `result.json` reports a positive count, the count
 * is stated and its position is `null` — never invented. When both report
 * zero, the per-checkpoint count is 0.
 *
 * Cross-check. The session rows are the main loop; `result.usage` is the
 * host's own sum of the same rows. They must agree exactly. A mismatch fails
 * the read instead of letting a reader pick a side. Output tokens are never
 * folded into the billed prompt.
 *
 * Censored partial. A run stopped by `--stop-at-checkpoint` (or a compaction
 * limit) carries a `stop` block in `result.json`. The overall block repeats it
 * as `stop`/`stoppedBy`/`censoredPartial: true`; the checkpoints it did not
 * reach stay `created: false` with null readings, and no full-task claim is
 * made. The claim gate is `stop.benchDone.found`, never `passed` (which is false
 * by construction on every stop). The full step series remains in the session
 * log and `result.context.series`, so any k can be recomputed.
 *
 * Usage:
 *
 *   node dev/bench/dsh-checkpoints.mjs <evidence-dir|result.json> \
 *     [--session <file>] [--journal <file>] [--ledger <file>] \
 *     [--deliverables <json-or-newline-file>] [--json]
 *
 * The evidence dir form uses `<dir>/result.json` and resolves the session,
 * journal and ledger paths from it. An explicit flag always wins. When no
 * deliverable override is given, `result.checkpoints.paths` (the list the
 * launcher derived from its brief) is used; an older result without that block
 * falls back to `DEFAULT_DELIVERABLES`. The deliverable override accepts a
 * JSON array of strings / `{"path": "…"}` objects (or an object with a
 * `deliverables` array) or a newline file with one entry per line, blank lines
 * and `#` comments ignored.
 *
 * Exit codes: 0 measured, 1 the run cannot be measured (malformed JSON, missing
 * prompt token field, missing session log, session/result total mismatch), 2
 * bad command line.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

export const TOOL_NAME = 'dsh-checkpoints';

/**
 * The default deliverable list: the thirteen files the 2026-10-27 extended
 * brief tells the agent to write, in order, each an exact workspace-relative
 * path. They are read from the brief's own "Write <name>" lines
 * (`dev/bench/bench-brief-extended.md`), not from either arm's transcript:
 * `00-index.md` is checkpoint 1 and `01-` … `12-` are checkpoints 2 … 13.
 * This list is the fallback when neither `result.checkpoints.paths` nor
 * `--deliverables` names the run's expected list.
 */
export const DELIVERABLE_DIR = 'docs/plans/2026-10-27-extended-audit';

export const DEFAULT_DELIVERABLES = Object.freeze([
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

/** Tool names that CREATE or CHANGE a file. Everything else is not a write. */
export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'create']);
/** Tool names that read a file; counted for the run's shape, not for k. */
export const READ_TOOLS = Object.freeze(['read']);
/**
 * The shell names the dsh host offers. A shell row is a write when its command
 * text writes a path (see `shellWriteTargets`); a shell row that only searches,
 * lists or reads is counted and reported, never read as a deliverable write.
 */
export const SHELL_TOOLS = Object.freeze(['pwsh', 'powershell', 'bash', 'shell', 'execute']);

/** One prompt-side token field is required; the sum is the billed prompt. */
export const PROMPT_FIELDS = Object.freeze(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']);

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

/** A finite, non-negative number, or throw naming the exact field. */
function requiredNumber(object, key, label) {
  const value = isRecord(object) ? object[key] : undefined;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${PREFIX} ${label} is ${value === undefined ? 'missing' : JSON.stringify(value)}; `
      + 'the host recorded no readable prompt token field, and a missing field is not billed as 0');
  }
  return parsed;
}

/** A finite number when present, else null; a malformed value still throws. */
function optionalNumber(object, key, label) {
  const value = isRecord(object) ? object[key] : undefined;
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${PREFIX} ${label} is ${JSON.stringify(value)}, which is not a count`);
  }
  return parsed;
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
 * A path expressed relative to the run workspace when the base is known.
 * `null` when the path sits outside the base (the caller then falls back to
 * suffix matching, which is how a relative path or a copied arm is read).
 */
function stripBase(writePath, base) {
  if (base === null || base === undefined) return null;
  const path = toPosix(writePath);
  const root = toPosix(base);
  if (root === '') return null;
  const caseInsensitive = windowsish(path) || windowsish(root);
  if (pathEquals(path.slice(0, root.length), root, caseInsensitive)
    && (path.length === root.length || path[root.length] === '/')) {
    return path.slice(root.length).replace(/^\/+/, '');
  }
  return null;
}

/**
 * One deliverable entry. A trailing `-` marks a filename prefix; every other
 * entry is an exact path. The default list uses none.
 */
function makeDeliverable(raw, k) {
  const clean = toPosix(String(raw).trim()).replace(/^\.\//, '');
  if (clean === '') throw new Error(`${PREFIX} deliverable ${k} is empty`);
  const prefix = clean.endsWith('-');
  const slash = clean.lastIndexOf('/');
  const dir = slash >= 0 ? clean.slice(0, slash) : '';
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  if (name === '') throw new Error(`${PREFIX} deliverable ${k} has no filename: ${raw}`);
  return {
    k,
    raw: clean,
    dir,
    name,
    prefix,
    full: prefix ? null : clean,
    display: prefix ? `${dir === '' ? '' : `${dir}/`}${name}*` : clean,
  };
}

/** Parse a deliverable list from JSON or newline text. */
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

/** One line of an explicit deliverable list: a bullet/backtick-wrapped entry. */
function listLineEntry(raw) {
  let line = String(raw).trim();
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/u, '');
  line = line.replace(/^`+/u, '').replace(/`+$/u, '').trim();
  line = line.replace(/[.,;:]+$/u, '');
  const pathMatch = line.match(/^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)$/u);
  const nameMatch = pathMatch === null ? line.match(/^([A-Za-z0-9._-]+)$/u) : null;
  const entry = pathMatch === null ? nameMatch?.[1] : pathMatch[1];
  if (entry === undefined) return null;
  const segments = entry.split('/');
  const name = segments.at(-1);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (name === undefined || !name.includes('.') || name.startsWith('.') || name.endsWith('.')) {
    return null;
  }
  return pathMatch === null
    ? { name, path: null }
    : { name, path: entry.replace(/\/{2,}/gu, '/') };
}

/**
 * The directory a bare-name list belongs to. The extended brief names its
 * directory (`docs/plans/2026-10-27-extended-audit/`) and then lists bare
 * names; a different brief that lists bare names must name a trailing-slash
 * directory somewhere, and the last one wins.
 * @param {string} text
 * @returns {string|null}
 */
function deliverableDirectory(text) {
  const source = String(text ?? '').replace(/\r\n?/gu, '\n');
  if (source.includes(DELIVERABLE_DIR)) return DELIVERABLE_DIR;
  const matches = [...source.matchAll(/(?:^|[\s(`'"])((?:[A-Za-z0-9._-]+\/)+)[\s`'").,;:]/gmu)];
  if (matches.length === 0) return null;
  return matches.at(-1)[1].replace(/\/+$/u, '');
}

/**
 * The contiguous list of exact paths that ends `text`, or null. The last
 * non-blank lines are paths (optionally bulleted, backticked, or under one
 * "Deliverables" heading), so an instruction that mentions one path earlier is
 * never mistaken for the list. A bare-name list is resolved against
 * `directory`; without one it is not a list.
 * @param {string} text
 * @param {string|null} [directory]
 * @returns {string[]|null}
 */
function deliverableBlockAtEnd(text, directory = null) {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const collected = [];
  let sawFence = false;
  let sawHeader = false;
  const header = /^(?:#{1,6}\s*)?(?:deliverables?|files?|paths?|outputs?)\b[^\n]*:?\s*$/iu;
  const fence = /^```[a-z]*$/iu;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    const entry = listLineEntry(lines[i]);
    if (entry !== null) {
      if (entry.path !== null) {
        collected.push(entry.path);
      } else if (directory !== null) {
        collected.push(`${directory}/${entry.name}`);
      } else {
        break;
      }
      continue;
    }
    if (fence.test(trimmed) && !sawFence) {
      sawFence = true;
      continue;
    }
    if (header.test(trimmed) && !sawHeader) {
      sawHeader = true;
      continue;
    }
    break;
  }
  if (collected.length < 2) return null;
  const ordered = [];
  for (const path of collected.reverse()) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  return ordered;
}

/**
 * The last contiguous list of at least two entries that an explicit line
 * introduces — the preceding non-blank line ends with `:` — or null. A
 * follow-up task file can put its list mid-text (the nineteen names, then the
 * finish instructions and a Done criteria section), so the end-of-text scan
 * alone would miss it. `deliverableBlockAtEnd` is tried first, so trailing
 * prose never overrides a list that ends the text. The header rule keeps a
 * wrapped sentence that happens to split two paths across lines (a line ending
 * in a comma, then one bare path per line) from reading as a list: that
 * sentence has no line of its own ending in `:`.
 * @param {string} text
 * @param {string|null} [directory]
 * @returns {string[]|null}
 */
function introducedDeliverableBlock(text, directory = null) {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  let run = [];
  let start = -1;
  let best = null;
  const flush = () => {
    if (run.length >= 2) {
      let at = start - 1;
      while (at >= 0 && lines[at].trim() === '') at -= 1;
      const header = at >= 0 ? lines[at].trim() : '';
      if (header.endsWith(':') && listLineEntry(header) === null) best = run.slice();
    }
    run = [];
    start = -1;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const entry = listLineEntry(lines[index]);
    if (entry !== null) {
      if (run.length === 0) start = index;
      run.push(entry);
      continue;
    }
    flush();
  }
  flush();
  if (best === null) return null;
  const paths = [];
  for (const entry of best) {
    if (entry.path !== null) paths.push(entry.path);
    else if (directory !== null) paths.push(`${directory}/${entry.name}`);
    else return null;
  }
  const ordered = [];
  for (const path of paths) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  return ordered;
}

/**
 * The explicit deliverable list `text` names, or null: the list that ends the
 * text, else the last list a line ending in `:` introduces anywhere in it.
 * @param {string} text
 * @param {string|null} [directory]
 * @returns {string[]|null}
 */
function finalDeliverableBlock(text, directory = null) {
  return deliverableBlockAtEnd(text, directory)
    ?? introducedDeliverableBlock(text, directory);
}

/**
 * The brief's expected deliverable list, or null when it names none.
 *
 * Two sources, in this order:
 *   1. the brief's final explicit list of exact paths. `text` is the task fence
 *      and `fallbackText` the whole brief, so a list that ends the task fence
 *      still wins over the prose after the fence. A list can also sit mid-text
 *      (the extended-32 follow-up puts its nineteen names there); the last list
 *      a line ending in `:` introduces is read in that case.
 *   2. the default brief's prose ("Write 00-index.md" … "Write 12-corpus-zh.md"
 *      under the extended-audit directory), which names every default file but
 *      no full path. That returns `DEFAULT_DELIVERABLES`.
 *
 * A brief that names neither gets null and no deliverable gate.
 * @param {string} text - the brief's task text
 * @param {string|null} [fallbackText] - the whole brief file
 * @returns {string[]|null}
 */
export function deliverablesFromBrief(text, fallbackText = null) {
  const explicit = finalDeliverableBlock(text, deliverableDirectory(text))
    ?? (fallbackText === null || fallbackText === undefined
      ? null : finalDeliverableBlock(fallbackText, deliverableDirectory(fallbackText)));
  if (explicit !== null) return explicit;
  const haystack = `${String(text ?? '')}\n${String(fallbackText ?? '')}`;
  if (haystack.includes(DELIVERABLE_DIR)
    && DEFAULT_DELIVERABLES.every((path) => haystack.includes(path.slice(path.lastIndexOf('/') + 1)))) {
    return [...DEFAULT_DELIVERABLES];
  }
  return null;
}

/**
 * Whether one write path names one deliverable. Exact entries match the
 * workspace-relative path, or its suffix when the base is unknown/outside.
 * @returns {{matched: boolean, candidate: string, via: 'workspace-relative'|'suffix'}}
 */
export function matchDeliverable(writePath, deliverable, base = null) {
  const path = toPosix(writePath);
  const relative = stripBase(path, base);
  const candidate = relative !== null ? relative : path.replace(/^\/+/, '');
  const via = relative !== null ? 'workspace-relative' : 'suffix';
  // Stripping a Windows base leaves a relative path with no `\` or drive letter,
  // so `windowsish` alone loses the case-insensitivity the host filesystem still
  // applies. Fold case for the workspace-relative comparison on win32 (ISSUE-391).
  const caseInsensitive = windowsish(candidate)
    || (via === 'workspace-relative' && process.platform === 'win32');
  if (deliverable.prefix) {
    const slash = candidate.lastIndexOf('/');
    const parent = slash >= 0 ? candidate.slice(0, slash) : '';
    const name = slash >= 0 ? candidate.slice(slash + 1) : candidate;
    const sameDir = deliverable.dir === ''
      || (caseInsensitive
        ? parent.toLowerCase().endsWith(`/${deliverable.dir.toLowerCase()}`)
        : parent.endsWith(`/${deliverable.dir}`));
    const samePrefix = caseInsensitive
      ? name.toLowerCase().startsWith(deliverable.name.toLowerCase())
      : name.startsWith(deliverable.name);
    return { matched: sameDir && samePrefix, candidate, via };
  }
  if (pathEquals(candidate, deliverable.full, caseInsensitive)) {
    return { matched: true, candidate, via };
  }
  if (via === 'suffix') {
    const suffix = `/${deliverable.full}`;
    return {
      matched: caseInsensitive
        ? candidate.toLowerCase().endsWith(suffix.toLowerCase())
        : candidate.endsWith(suffix),
      candidate,
      via,
    };
  }
  return { matched: false, candidate, via };
}

/** A path named in a tool call's arguments. */
function pathFromArgs(args) {
  return firstString(args, ['file_path', 'filePath', 'filepath', 'path']);
}

/** The command text a shell call carries, if any. */
function commandFromArgs(args) {
  return firstString(args, ['command', 'script', 'cmd', 'code', 'input']);
}

/** The whole argument text of a call, for the mention fallback. */
function argsText(args, raw) {
  if (typeof raw === 'string') return raw;
  if (typeof args === 'string') return args;
  if (args === null || args === undefined) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/** The text content of a `tool/result` event, or ''. */
function resultTextOf(data) {
  const content = data?.message?.content ?? data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part
      : typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

/** A value that is never a written file. */
function isNullTarget(value) {
  const text = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  return text === ''
    || ['/dev/null', 'nul', '$null', '&1', '&2', '1', '2'].includes(text.toLowerCase())
    || /^[&$]/.test(text);
}

/** Whether a token names a file rather than a flag, verb or value. */
function looksLikePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /[\\/]/.test(value)
    || /^[A-Za-z]:/.test(value)
    || /\.(?:md|txt|json|jsonl|ya?ml|lua|ts|mjs|cjs|js|css|html)$/i.test(value);
}

/** Quoted strings in a command, kept only when they look like paths. */
function quotedPaths(text) {
  const out = [];
  const quoted = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = quoted.exec(text)) !== null) {
    const value = match[1] ?? match[2];
    if (looksLikePath(value)) out.push(value);
  }
  return out;
}

/** Quoted and bare path-looking tokens in one command segment. */
function segmentPaths(text) {
  const out = quotedPaths(text);
  const bare = /(?:^|[\s|;(])((?:\.{0,2}[\\/])?[^\s"'=;|&()<>]+)/g;
  let match;
  while ((match = bare.exec(text)) !== null) {
    if (looksLikePath(match[1])) out.push(match[1]);
  }
  return out;
}

/**
 * The paths a shell command writes, as far as its own text says. This reads the
 * command, not the filesystem: a path is returned when a write construct names
 * it. It is deliberately conservative about where the target sits (a cmdlet's
 * `-Path`/`-FilePath` flag, the destination of `cp`/`mv`, the file after `tee`,
 * a redirection target) and attributes inline-writer scripts (`write_text`,
 * `writeFileSync`, `WriteAllText`) by their path literals.
 *
 * @returns {string[]} unique target paths, in command order
 */
export function shellWriteTargets(command) {
  const text = String(command ?? '');
  if (text === '') return [];
  const targets = [];
  const push = (value) => {
    if (!isNullTarget(value)) targets.push(value);
  };

  // Redirections: `> path`, `>> path`, `2> path`. `=>` and `2>&1` do not match.
  const redirect = /(?:^|[\s;|&(])(?:\d)?>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
  let match;
  while ((match = redirect.exec(text)) !== null) push(match[1] ?? match[2] ?? match[3]);

  for (const line of text.split(/\r?\n/)) {
    for (const segment of line.split(';')) {
      const word = /\b(Set-Content|Add-Content|Out-File|New-Item|Tee-Object|Copy-Item|Move-Item|Rename-Item|Set-Item|tee|cp|mv|install)\b/i.exec(segment);
      if (word === null) continue;
      const rest = segment.slice(word.index + word[0].length);
      const name = word[1].toLowerCase();
      const destination = ['copy-item', 'move-item', 'rename-item', 'tee', 'tee-object', 'cp', 'mv'].includes(name);
      const flag = (destination
        ? /-(?:Destination|Target|NewName)\s+("([^"]+)"|'([^']+)'|([^\s;|]+))/i
        : /-(?:LiteralPath|FilePath|Path)\s+("([^"]+)"|'([^']+)'|([^\s;|]+))/i).exec(rest);
      if (flag !== null) {
        push(flag[2] ?? flag[3] ?? flag[4]);
        continue;
      }
      const paths = segmentPaths(rest);
      if (paths.length === 0) continue;
      push(destination ? paths.at(-1) : paths[0]);
    }
  }

  // Inline writers: the path is a literal elsewhere in the same command, often
  // on another heredoc line (`pathlib.Path('…')` then `path.write_text(…)`).
  // Search raw path runs, not quote pairs: inside a PowerShell here-string the
  // opener's own quote misaligns a paired-quote scan.
  const inline = /\.write_text\s*\(|\.write_bytes\s*\(|\bwriteFileSync\s*\(|\bappendFileSync\s*\(|\bWriteAll(?:Text|Bytes|Lines)\b|\bopen\s*\([^)\n]*?['"]a?w/i.test(text);
  if (inline) {
    const runs = text.match(/(?:[A-Za-z]:)?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)+/g) ?? [];
    for (const value of runs) {
      const trimmed = value.trim();
      if (looksLikePath(trimmed)) push(trimmed);
    }
  }
  return [...new Set(targets)];
}

/** The exact deliverable path mentioned in text, forward or backslash form. */
function mentionsPath(text, full) {
  if (typeof text !== 'string' || text === '') return false;
  if (text.includes(full) || text.includes(full.replace(/\//g, '\\'))) return true;
  const lower = text.toLowerCase();
  return lower.includes(full.toLowerCase()) || lower.includes(full.replace(/\//g, '\\').toLowerCase());
}

/** One assistant usage row, or a loud refusal. */
function readPromptUsage(usage, stepIndex) {
  const input = requiredNumber(usage, 'inputTokens', `step ${stepIndex} usage.inputTokens`);
  const cacheRead = requiredNumber(usage, 'cacheReadTokens', `step ${stepIndex} usage.cacheReadTokens`);
  const cacheWrite = optionalNumber(usage, 'cacheWriteTokens', `step ${stepIndex} usage.cacheWriteTokens`) ?? 0;
  return {
    input,
    cacheRead,
    cacheWrite,
    cacheWritePresent: usage.cacheWriteTokens !== undefined && usage.cacheWriteTokens !== null,
    billedPrompt: input + cacheRead + cacheWrite,
    output: optionalNumber(usage, 'outputTokens', `step ${stepIndex} usage.outputTokens`),
    total: optionalNumber(usage, 'totalTokens', `step ${stepIndex} usage.totalTokens`),
  };
}

/**
 * Parse `result.json` into the facts a checkpoint read cross-checks. Missing
 * `usage` prompt totals fail: no total means no cross-check, and a fabricated
 * zero would make the cross-check vacuous. Compaction and journal blocks may
 * be absent (an older projection); they are reported as unknown, not zero.
 */
export function parseResult(text, source = '<result>') {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (error) {
    throw new Error(`${PREFIX} ${source} is not JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new Error(`${PREFIX} ${source} is not a JSON object`);
  const usage = isRecord(data.usage) ? data.usage : null;
  if (usage === null) {
    throw new Error(`${PREFIX} ${source} has no usage block; no billed prompt total can be read`);
  }
  const context = isRecord(data.context) ? data.context : null;
  const compaction = isRecord(data.compaction) ? data.compaction : null;
  const session = isRecord(data.session) ? data.session : null;
  const journal = isRecord(data.journal) ? data.journal : null;
  const work = isRecord(data.work) ? data.work : null;
  const arm = isRecord(data.arm) ? data.arm : null;
  const series = Array.isArray(context?.series)
    ? context.series.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : null;
  return {
    schema: typeof data.schema === 'string' ? data.schema : null,
    arm: {
      name: typeof arm?.name === 'string' ? arm.name : null,
      dir: typeof arm?.dir === 'string' ? arm.dir : null,
    },
    provider: typeof data.provider === 'string' ? data.provider : null,
    usage: {
      inputTokens: requiredNumber(usage, 'inputTokens', 'result usage.inputTokens'),
      cacheReadTokens: requiredNumber(usage, 'cacheReadTokens', 'result usage.cacheReadTokens'),
      cacheWriteTokens: requiredNumber(usage, 'cacheWriteTokens', 'result usage.cacheWriteTokens'),
      outputTokens: optionalNumber(usage, 'outputTokens', 'result usage.outputTokens'),
      billedPromptTokens: requiredNumber(usage, 'billedPromptTokens', 'result usage.billedPromptTokens'),
      usageRows: optionalNumber(usage, 'usageRows', 'result usage.usageRows'),
      assistantTurns: optionalNumber(usage, 'assistantTurns', 'result usage.assistantTurns'),
    },
    context: context === null ? null : {
      series,
      peak: optionalNumber(context, 'peak', 'result context.peak'),
      final: optionalNumber(context, 'final', 'result context.final'),
      turns: optionalNumber(context, 'turns', 'result context.turns'),
    },
    compaction: compaction === null ? null : {
      count: optionalNumber(compaction, 'count', 'result compaction.count'),
      ends: optionalNumber(compaction, 'ends', 'result compaction.ends'),
      atRequests: Array.isArray(compaction.atRequests)
        ? compaction.atRequests.filter((value) => Number.isFinite(value)) : [],
      atSeqs: Array.isArray(compaction.atSeqs)
        ? compaction.atSeqs.filter((value) => Number.isFinite(value)) : [],
      pruneEvents: optionalNumber(compaction, 'pruneEvents', 'result compaction.pruneEvents'),
      compacted: typeof compaction.compacted === 'boolean' ? compaction.compacted : null,
    },
    session: session === null ? null : {
      files: Array.isArray(session.files) ? session.files.filter((value) => typeof value === 'string') : [],
      events: optionalNumber(session, 'events', 'result session.events'),
      benchDone: isRecord(session.benchDone) ? {
        found: session.benchDone.found === true,
        seq: optionalNumber(session.benchDone, 'seq', 'result session.benchDone.seq'),
        line: typeof session.benchDone.line === 'string' ? session.benchDone.line : null,
      } : null,
    },
    journal: journal === null ? null : {
      verdict: typeof journal.verdict === 'string' ? journal.verdict : null,
      emitted: journal.emitted === true,
      file: typeof journal.file === 'string' ? journal.file : null,
      bytes: optionalNumber(journal, 'bytes', 'result journal.bytes'),
      lines: optionalNumber(journal, 'lines', 'result journal.lines'),
      byKind: isRecord(journal.byKind) ? journal.byKind : {},
      entryAsks: optionalNumber(journal, 'entryAsks', 'result journal.entryAsks'),
      pruneThresholds: optionalNumber(journal, 'pruneThresholds', 'result journal.pruneThresholds'),
      pruneThresholdEvaluations: optionalNumber(journal, 'pruneThresholdEvaluations',
        'result journal.pruneThresholdEvaluations'),
      ledger: isRecord(journal.ledger) ? journal.ledger : null,
    },
    // The expected list the runner derived from its brief. A longer brief's
    // table must follow its own paths and order; when this block is absent the
    // reader falls back to `DEFAULT_DELIVERABLES`.
    checkpoints: isRecord(data.checkpoints) ? {
      expected: optionalNumber(data.checkpoints, 'expected', 'result checkpoints.expected'),
      source: typeof data.checkpoints.source === 'string' ? data.checkpoints.source : null,
      paths: Array.isArray(data.checkpoints.paths)
        ? data.checkpoints.paths.filter((value) => typeof value === 'string' && value.trim() !== '')
        : null,
    } : null,
    work: work === null ? null : {
      dir: typeof work.dir === 'string' ? work.dir : null,
      mode: typeof work.mode === 'string' ? work.mode : null,
    },
    exit: isRecord(data.exit) ? {
      code: optionalNumber(data.exit, 'code', 'result exit.code'),
      durationMs: optionalNumber(data.exit, 'durationMs', 'result exit.durationMs'),
    } : null,
    // A resume round records the leg it continues. `priorSeq` is the last seq
    // the adopted log carried before that launch, so it is also the billed
    // population's boundary (ISSUE-270/ISSUE-491). The block is present only on
    // a resumed round; a malformed block is refused by the caller, never read as
    // a whole-log reading.
    resumedFrom: isRecord(data.resumedFrom) ? {
      sessionId: typeof data.resumedFrom.sessionId === 'string' ? data.resumedFrom.sessionId : null,
      priorSeq: optionalNumber(data.resumedFrom, 'priorSeq', 'result resumedFrom.priorSeq'),
      file: typeof data.resumedFrom.file === 'string' ? data.resumedFrom.file : null,
    } : null,
    // The 2026-11-08 stop record. Absent on a completed run; a stopped run
    // carries `censored: true` and the instrument that ended it, so a reader
    // gates claims on `benchDone.found` and never on `passed` (which is false
    // by construction on every stop).
    stoppedBy: typeof data.stoppedBy === 'string' ? data.stoppedBy : null,
    stop: isRecord(data.stop) ? {
      reason: typeof data.stop.reason === 'string' ? data.stop.reason : null,
      censored: data.stop.censored === true,
      exitName: typeof data.stop.exitName === 'string' ? data.stop.exitName : null,
      checkpoint: isRecord(data.stop.checkpoint) ? {
        path: typeof data.stop.checkpoint.path === 'string' ? data.stop.checkpoint.path : null,
        resolved: typeof data.stop.checkpoint.resolved === 'string' ? data.stop.checkpoint.resolved : null,
        billedPromptTokens: optionalNumber(data.stop.checkpoint, 'billedPromptTokens',
          'result stop.checkpoint.billedPromptTokens'),
        compactions: optionalNumber(data.stop.checkpoint, 'compactions', 'result stop.checkpoint.compactions'),
        killLanded: data.stop.checkpoint.killLanded === true,
      } : null,
      compactionLimit: isRecord(data.stop.compactionLimit) ? {
        limit: optionalNumber(data.stop.compactionLimit, 'limit', 'result stop.compactionLimit.limit'),
        observed: optionalNumber(data.stop.compactionLimit, 'observed', 'result stop.compactionLimit.observed'),
        nthRequest: optionalNumber(data.stop.compactionLimit, 'nthRequest',
          'result stop.compactionLimit.nthRequest'),
        nthSeq: optionalNumber(data.stop.compactionLimit, 'nthSeq', 'result stop.compactionLimit.nthSeq'),
      } : null,
      benchDone: isRecord(data.stop.benchDone) ? {
        found: data.stop.benchDone.found === true,
        seq: optionalNumber(data.stop.benchDone, 'seq', 'result stop.benchDone.seq'),
      } : null,
      deliverablesCreated: optionalNumber(data.stop, 'deliverablesCreated',
        'result stop.deliverablesCreated'),
      largestCheckpointReached: optionalNumber(data.stop, 'largestCheckpointReached',
        'result stop.largestCheckpointReached'),
      largestCommonK: optionalNumber(data.stop, 'largestCommonK', 'result stop.largestCommonK'),
    } : null,
    passed: typeof data.passed === 'boolean' ? data.passed : null,
  };
}

/**
 * Parse `session.v4.jsonl`. The file is scanned in order; a malformed line
 * fails with its number. Steps are built from `step/start` rows, so the step
 * index is the main request index the compaction positions also use.
 *
 * @returns {{steps: object[], events: number, malformed: [], compaction: object,
 *   assistantMessages: number, assistantRows: object[], omittedCacheWrite: number,
 *   toolCalls: object[], tailStepIncomplete: boolean, tailStepIndex: number|null}}
 */
export function parseSession(text, source = '<session>') {
  const lines = String(text).split(/\r?\n/);
  const steps = [];
  const stepByKey = new Map();
  // callId → call, built once as calls arrive so a result binds in O(1) instead
  // of scanning every step's calls (ISSUE-391). First call wins, matching the
  // old in-order `.find()`; a result only binds a call already seen.
  const callById = new Map();
  const stepStarts = [];
  const assistantMessages = [];
  const compactions = { starts: [], ends: 0, prunes: 0 };
  let omittedCacheWrite = 0;
  let eventCount = 0;

  const openStep = (event) => {
    const step = {
      index: steps.length + 1,
      turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
      step: typeof event.data?.step === 'number' ? event.data.step : null,
      seq: typeof event.seq === 'number' ? event.seq : null,
      depth: 0,
      messages: 0,
      output: 0,
      toolCalls: [],
    };
    steps.push(step);
    stepStarts.push({ seq: step.seq, index: step.index });
    if (step.turn !== null && step.step !== null) stepByKey.set(`${step.turn}/${step.step}`, step);
    return step;
  };

  /** The step an event belongs to: its named step, else the last opened one. */
  const stepFor = (event) => {
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (typeof turn === 'number' && typeof step === 'number') {
      const named = stepByKey.get(`${turn}/${step}`);
      if (named !== undefined) return named;
    }
    if (steps.length > 0) return steps.at(-1);
    throw new Error(`${PREFIX} ${source}:${String(event.seq ?? '?')} has no step/start before it`);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${PREFIX} ${source}:${i + 1} is not JSON: ${error.message}`);
    }
    if (!isRecord(event)) throw new Error(`${PREFIX} ${source}:${i + 1} is not a JSON object`);
    eventCount += 1;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'step/start') {
      openStep(event);
      continue;
    }
    if (type === 'assistant/message') {
      const step = stepFor(event);
      const usage = event.data?.usage;
      if (!isRecord(usage)) {
        throw new Error(`${PREFIX} ${source}:${i + 1} assistant/message has no data.usage; `
          + `step ${step.index} has no billable prompt and is not billed as 0`);
      }
      const row = readPromptUsage(usage, step.index);
      if (!row.cacheWritePresent) omittedCacheWrite += 1;
      step.depth += row.billedPrompt;
      step.output += row.output ?? 0;
      step.messages += 1;
      assistantMessages.push({
        step: step.index,
        seq: typeof event.seq === 'number' ? event.seq : null,
        ...row,
      });
      continue;
    }
    if (type === 'tool/call') {
      const step = stepFor(event);
      const name = typeof event.data?.name === 'string' ? event.data.name.toLowerCase() : '';
      const rawArgs = event.data?.arguments;
      let args = rawArgs;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }
      const call = {
        step: step.index,
        seq: typeof event.seq === 'number' ? event.seq : null,
        callId: typeof event.data?.callId === 'string' ? event.data.callId : null,
        name,
        path: pathFromArgs(args),
        command: SHELL_TOOLS.includes(name) ? commandFromArgs(args) : null,
        text: argsText(args, rawArgs),
        resultText: '',
        completed: false,
        isError: null,
      };
      step.toolCalls.push(call);
      if (call.callId !== null && !callById.has(call.callId)) callById.set(call.callId, call);
      continue;
    }
    if (type === 'tool/result') {
      const callId = typeof event.data?.toolCallId === 'string'
        ? event.data.toolCallId
        : typeof event.data?.message?.source?.callId === 'string'
          ? event.data.message.source.callId : null;
      if (callId === null) continue;
      const isError = event.data?.message?.isError === true || event.data?.isError === true;
      const resultText = resultTextOf(event.data);
      const call = callById.get(callId);
      if (call !== undefined) {
        call.completed = true;
        call.isError = isError;
        call.resultText = resultText;
      }
      continue;
    }
    if (type === 'compaction/start') {
      compactions.starts.push({
        seq: typeof event.seq === 'number' ? event.seq : null,
        turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
      });
      continue;
    }
    if (type === 'compaction/end') {
      compactions.ends += 1;
      continue;
    }
    if (type === 'compaction/prune') compactions.prunes += 1;
  }

  if (steps.length === 0) {
    throw new Error(`${PREFIX} ${source} has no step/start rows; no step timeline can be built`);
  }
  if (assistantMessages.length === 0) {
    throw new Error(`${PREFIX} ${source} has no assistant/message rows; no prompt can be billed`);
  }
  // A killed run lands mid-step: its last `step/start` has no
  // `assistant/message` after it. Exactly that one trailing step is allowed and
  // stated; an empty step anywhere before the tail is still missing, not a zero.
  const lastStep = steps.at(-1);
  const empty = steps.filter((step) => step.messages === 0);
  const nonTailEmpty = empty.filter((step) => step !== lastStep);
  if (nonTailEmpty.length > 0) {
    throw new Error(`${PREFIX} ${source} step ${nonTailEmpty[0].index} has no assistant/message usage; `
      + 'a step without prompt tokens is missing, not a zero');
  }
  const tailStepIncomplete = empty.length > 0;
  const tailStepIndex = tailStepIncomplete ? lastStep.index : null;

  let running = 0;
  let peak = 0;
  for (const step of steps) {
    running += step.depth;
    step.runningTotal = running;
    peak = Math.max(peak, step.depth);
    step.peak = peak;
  }

  const compactionAt = compactions.starts.map((start) => ({
    ...start,
    atRequest: stepStarts.filter((entry) => entry.seq !== null && start.seq !== null
      && entry.seq < start.seq).length + 1,
  }));

  return {
    steps,
    events: eventCount,
    assistantMessages: assistantMessages.length,
    // The rows themselves, with their seq and cache-write presence: a resume
    // round bounds the billed population by seq, and an omission outside the
    // leg is not the leg's gap (ISSUE-491).
    assistantRows: assistantMessages,
    omittedCacheWrite,
    tailStepIncomplete,
    tailStepIndex,
    toolCalls: steps.flatMap((step) => step.toolCalls),
    compaction: {
      starts: compactionAt,
      count: compactionAt.length,
      ends: compactions.ends,
      pruneEvents: compactions.prunes,
    },
  };
}

/**
 * Parse the racoons journal (`cremator-events.jsonl`). A malformed line is
 * recorded with its number and the rest is read; the host's own journal reader
 * records `unparsable` the same way. `prune-threshold` rows supply the first
 * crossing and the threshold values the run actually used.
 */
export function parseJournal(text, source = '<journal>') {
  const lines = String(text).split(/\r?\n/);
  const byKind = {};
  const malformed = [];
  const thresholds = new Set();
  const crossings = [];
  let rows = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      malformed.push({ line: i + 1, detail: error.message });
      continue;
    }
    if (!isRecord(row)) {
      malformed.push({ line: i + 1, detail: 'not a JSON object' });
      continue;
    }
    rows += 1;
    const kind = typeof row.kind === 'string' ? row.kind : '<no-kind>';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === 'prune-threshold') {
      if (typeof row.threshold === 'number') thresholds.add(row.threshold);
      if (row.crossed === true) {
        crossings.push({
          atMs: optionalNumber(row, 'atMs', 'journal prune-threshold atMs'),
          estimatedTokens: optionalNumber(row, 'estimatedTokens', 'journal prune-threshold estimatedTokens'),
          billedPromptTokens: optionalNumber(row, 'billedPromptTokens',
            'journal prune-threshold billedPromptTokens'),
          threshold: optionalNumber(row, 'threshold', 'journal prune-threshold threshold'),
        });
      }
    }
  }
  return {
    rows,
    byKind,
    malformed,
    thresholds: [...thresholds].sort((a, b) => a - b),
    crossings,
    firstCrossing: crossings[0] ?? null,
    entryAsks: byKind['entry-ask'] ?? 0,
    pruneAsks: byKind['prune-ask'] ?? 0,
  };
}

/**
 * Read the ledger read-only. The tables this reader needs are the recall store
 * and the append-only event log; a database without them is reported as
 * unreadable, never counted as zero removals.
 */
export function readLedger(databasePath) {
  if (databasePath === null || databasePath === undefined || !existsSync(databasePath)) {
    return { path: databasePath ?? null, present: false, readable: false, error: null };
  }
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const kindRows = db.prepare('SELECT kind, COUNT(*) AS count FROM ledger_events GROUP BY kind').all();
    const byKind = {};
    for (const row of kindRows) byKind[row.kind] = Number(row.count);
    const applications = Number(db.prepare('SELECT COUNT(*) AS count FROM applications').get().count);
    const recalls = Number(db.prepare('SELECT COUNT(*) AS count FROM recalls').get().count);
    const removals = Number(db.prepare('SELECT COUNT(*) AS count FROM application_removals').get().count);
    const recallIds = db.prepare('SELECT recall_id FROM recalls ORDER BY recall_id').all()
      .map((row) => row.recall_id);
    return {
      path: databasePath,
      present: true,
      readable: true,
      error: null,
      byKind,
      applied: byKind.applied ?? 0,
      prepared: byKind.prepared ?? 0,
      validation: byKind.validation ?? 0,
      applications,
      recalls,
      removals,
      recallIds,
    };
  } catch (error) {
    return { path: databasePath, present: true, readable: false, error: error.message };
  } finally {
    try {
      db?.close();
    } catch {
      // The read is already over; a close failure cannot change the report.
    }
  }
}

/** The ledger summary `result.json` already carries, or null. */
function resultLedger(parsed) {
  const ledger = parsed.journal?.ledger;
  if (!isRecord(ledger)) return null;
  const recallIds = Array.isArray(ledger.recallIds)
    ? ledger.recallIds.filter((value) => typeof value === 'string') : [];
  const events = isRecord(ledger.events) ? ledger.events : {};
  const applications = isRecord(ledger.applications) ? ledger.applications : {};
  // `appliedRemovals` is an object in the current projection
  // (`{total, byKind, recallIds}`); an older run may write a number.
  const removals = isRecord(ledger.appliedRemovals)
    ? optionalNumber(ledger.appliedRemovals, 'total', 'result journal.ledger.appliedRemovals.total')
    : optionalNumber(ledger, 'appliedRemovals', 'result journal.ledger.appliedRemovals');
  return {
    present: ledger.present === true,
    readable: ledger.readable === true,
    file: typeof ledger.file === 'string' ? ledger.file : null,
    bytes: optionalNumber(ledger, 'bytes', 'result journal.ledger.bytes'),
    via: typeof ledger.via === 'string' ? ledger.via : null,
    applied: optionalNumber(events, 'applied', 'result journal.ledger.events.applied'),
    prepared: optionalNumber(events, 'prepared', 'result journal.ledger.events.prepared'),
    validation: optionalNumber(events, 'validation', 'result journal.ledger.events.validation'),
    // `applications` is a by-kind object, not a row count; the sqlite read is
    // the only source that can state the row count. Keep the kinds beside it.
    applications: null,
    applicationKinds: applications,
    recalls: recallIds.length,
    recallIds,
    removals,
    appliedRemovals: removals,
    error: typeof ledger.error === 'string' ? ledger.error : null,
  };
}

/** Whether the final arm is a directory a file-existence check can read. */
function armDirectoryReadable(armDir) {
  if (typeof armDir !== 'string' || armDir.trim() === '') return false;
  try {
    return statSync(resolve(armDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the final arm holds one expected deliverable. `null` means the answer
 * is unknown (the arm directory is absent, or the entry is a `name*` prefix the
 * file check cannot resolve). The task's deliverable is the FILE, so this is
 * what `created` counts; a write call is attribution for the step, never the
 * definition of creation.
 */
function deliverableFilePresent(deliverable, armDir, exists, trustArmDir = false) {
  if (typeof armDir !== 'string' || armDir.trim() === '') return null;
  if (!trustArmDir && !armDirectoryReadable(armDir)) return null;
  if (deliverable.prefix) {
    try {
      const dir = join(resolve(armDir), ...(deliverable.dir === '' ? [] : deliverable.dir.split('/')));
      const name = deliverable.name.toLowerCase();
      return readdirSync(dir).some((entry) => entry.toLowerCase().startsWith(name));
    } catch {
      return null;
    }
  }
  const absolute = join(resolve(armDir), ...deliverable.full.split('/'));
  return exists(absolute);
}

/** The first completed write naming one deliverable, or null. */
function firstCompletedWrite(calls, deliverable, base) {
  for (const call of calls) {
    if (!WRITE_TOOLS.includes(call.name) || call.path === null || !call.completed || call.isError) continue;
    const match = matchDeliverable(call.path, deliverable, base);
    if (match.matched) return { call, matchedVia: match.via };
  }
  return null;
}

/** The first completed shell call whose command writes one deliverable, or null. */
function firstShellWrite(calls, deliverable, base) {
  for (const call of calls) {
    if (!SHELL_TOOLS.includes(call.name) || call.command === null || !call.completed || call.isError) continue;
    for (const target of shellWriteTargets(call.command)) {
      const match = matchDeliverable(target, deliverable, base);
      if (match.matched) return { call, matchedVia: match.via, target };
    }
  }
  return null;
}

/**
 * The first completed non-write call mentioning one deliverable, only when the
 * file exists in the final arm. The mention is an upper bound on creation: it
 * is used only when no write tool and no parsed shell write named the path. A
 * write tool's content is excluded — an index file lists every path, which
 * would otherwise mark all thirteen on the index's step; a non-shell call is
 * read by its own path argument, and only a shell call's command/result text is
 * read.
 */
function firstMention(calls, deliverable, armDir, exists) {
  if (deliverable.prefix || armDir === null || armDir === undefined) return null;
  const absolute = join(resolve(armDir), ...deliverable.full.split('/'));
  if (!exists(absolute)) return null;
  for (const call of calls) {
    if (!call.completed || call.isError || WRITE_TOOLS.includes(call.name)) continue;
    // A write tool's own content is not evidence that another file exists: an
    // index deliverable lists every path, and reading those mentions as
    // creation would place ten checkpoints on the index's step. Excluding write
    // tools also excludes it as the mention's source. A non-shell call is read
    // by its own path argument (a read result may quote an index); a shell call
    // is read by its command text and its result, because that is the
    // unparsed-write lane this fallback serves.
    const shell = SHELL_TOOLS.includes(call.name);
    if (mentionsPath(call.path, deliverable.full)
      || (shell && mentionsPath(call.text, deliverable.full))
      || (shell && mentionsPath(call.resultText, deliverable.full))) {
      return { call, matchedVia: 'mention' };
    }
  }
  return null;
}

/**
 * Analyze texts. It takes strings and returns a report object; the mention
 * fallback additionally asks whether the final arm holds the file
 * (`armDir`/`fileExists`), because existence is the only check that a mention
 * actually produced the deliverable.
 * @param {{resultText: string, sessionText: string, journalText?: string|null,
 *   ledgerPath?: string|null, deliverables?: string[]|null, deliverablesText?: string|null,
 *   deliverablesSource?: string, resultPath?: string, sessionPath?: string,
 *   journalPath?: string|null, armDir?: string|null,
 *   fileExists?: ((path: string) => boolean)|null}} input
 */
export function analyzeText({
  resultText,
  sessionText,
  journalText = null,
  ledgerPath = null,
  deliverables = null,
  deliverablesText = null,
  deliverablesSource = '<deliverables>',
  resultPath = '<result>',
  sessionPath = '<session>',
  journalPath = null,
  armDir = null,
  fileExists = null,
}) {
  if (typeof resultText !== 'string') throw new Error(`${PREFIX} result text is required`);
  if (typeof sessionText !== 'string') throw new Error(`${PREFIX} session text is required`);
  const result = parseResult(resultText, resultPath);
  const session = parseSession(sessionText, sessionPath);
  const resultPaths = result.checkpoints?.paths ?? null;
  const list = Array.isArray(deliverables)
    ? parseDeliverables(JSON.stringify(deliverables), '<deliverables array>')
    : deliverablesText !== null && deliverablesText !== undefined
      ? parseDeliverables(deliverablesText, deliverablesSource)
      : resultPaths !== null && resultPaths.length > 0
        ? parseDeliverables(resultPaths.join('\n'), '<result checkpoints.paths>')
        : parseDeliverables(DEFAULT_DELIVERABLES.join('\n'), '<default>');
  const deliverableSource = Array.isArray(deliverables)
    ? '<deliverables array>'
    : deliverablesText !== null && deliverablesText !== undefined
      ? deliverablesSource
      : resultPaths !== null && resultPaths.length > 0
        ? '<result checkpoints.paths>'
        : '<default>';

  const base = result.work?.dir ?? result.arm.dir ?? null;
  const finalArmDir = armDir ?? result.work?.dir ?? result.arm.dir ?? null;
  const fileExistsInjected = typeof fileExists === 'function';
  const exists = fileExistsInjected ? fileExists : (candidate) => existsSync(candidate);
  const calls = session.toolCalls;
  const writeCalls = calls.filter((call) => WRITE_TOOLS.includes(call.name));
  const completedWrites = writeCalls.filter((call) => call.completed && !call.isError);
  const readCalls = calls.filter((call) => READ_TOOLS.includes(call.name));
  const shellCalls = calls.filter((call) => SHELL_TOOLS.includes(call.name));

  // One resolution per deliverable, reused by the checkpoint rows and the
  // running "deliverables done" count so the two cannot disagree. `created` is
  // the FILE's existence, not a write call: a Python heredoc that writes
  // `OUT+'/00-index.md'` is a real deliverable even when no shell construct is
  // parsed. The write methods below are attribution for the step; they are
  // reported separately and may stay empty while the files exist.
  const resolutions = new Map();
  const shellWriteCallKeys = new Set();
  const resolveDeliverable = (deliverable) => {
    if (resolutions.has(deliverable.k)) return resolutions.get(deliverable.k);
    const filesPresent = deliverableFilePresent(deliverable, finalArmDir, exists, fileExistsInjected);
    const writeFound = firstCompletedWrite(calls, deliverable, base);
    let found = writeFound === null ? null : { ...writeFound, method: 'write-tool' };
    if (found === null) {
      const shellFound = firstShellWrite(calls, deliverable, base);
      if (shellFound !== null) found = { ...shellFound, method: 'shell-write' };
    }
    if (found === null) {
      const mentionFound = firstMention(calls, deliverable, finalArmDir, exists);
      if (mentionFound !== null) found = { ...mentionFound, method: 'mention-fallback' };
    }
    // Existence wins when it is known. When the final arm is absent, the file
    // question cannot be answered; the write attribution is then the only
    // evidence and keeps the old reading rather than claiming a file is absent.
    const created = filesPresent === null ? found !== null : filesPresent;
    const resolution = { found, filesPresent, created };
    resolutions.set(deliverable.k, resolution);
    return resolution;
  };

  // Shell calls that write any deliverable, counted once per call id.
  for (const call of shellCalls) {
    if (!call.completed || call.isError || call.command === null) continue;
    const writesDeliverable = shellWriteTargets(call.command).some((target) => list
      .some((deliverable) => matchDeliverable(target, deliverable, base).matched));
    if (writesDeliverable) shellWriteCallKeys.add(call.callId ?? call.seq ?? call.step);
  }

  const sessionTotal = session.steps.at(-1).runningTotal;
  const resultTotal = result.usage.billedPromptTokens;
  // A resume round's `result.usage` describes THE NEW LEG only: the launcher
  // sums the rows with `seq > resumedFrom.priorSeq` (ISSUE-270), while the
  // adopted log still carries every prior leg's assistant row. The comparison
  // below bounds the same population; without it the two readings describe
  // different legs and every resume with prior spend throws (ISSUE-491).
  const resumedFrom = result.resumedFrom;
  const priorSeq = resumedFrom === null ? null : resumedFrom.priorSeq;
  if (resumedFrom !== null && priorSeq === null) {
    throw new Error(`${PREFIX} result resumedFrom carries no readable priorSeq; the billed `
      + 'population cannot be bounded to the new leg and whole-log spend is not substituted');
  }
  if (priorSeq !== null) {
    const unplaced = session.assistantRows.filter((row) => row.seq === null);
    if (unplaced.length > 0) {
      throw new Error(`${PREFIX} ${unplaced.length} assistant row(s) carry no readable seq, so they `
        + `cannot be placed either side of resumedFrom.priorSeq ${priorSeq}; neither reading is guessed`);
    }
  }
  const legRows = priorSeq === null
    ? session.assistantRows
    : session.assistantRows.filter((row) => row.seq > priorSeq);
  const legTotal = legRows.reduce((sum, row) => sum + row.billedPrompt, 0);
  const legOmittedCacheWrite = legRows.filter((row) => !row.cacheWritePresent).length;
  if (result.usage.cacheWriteTokens > 0 && legOmittedCacheWrite > 0) {
    throw new Error(`${PREFIX} result.usage bills ${result.usage.cacheWriteTokens} cache-write token(s) `
      + `but ${legOmittedCacheWrite} assistant step(s) omit usage.cacheWriteTokens; `
      + 'the missing bucket is not billed as 0');
  }
  if (legTotal !== resultTotal) {
    throw new Error(`${PREFIX} session rows bill ${legTotal} prompt token(s) but result.usage `
      + `bills ${resultTotal}; the two readings disagree and neither is chosen silently`);
  }

  const checkpoints = list.map((deliverable) => {
    const resolution = resolveDeliverable(deliverable);
    const filesPresent = resolution.filesPresent;
    const baseRow = {
      k: deliverable.k,
      path: deliverable.display,
      spec: deliverable.raw,
      prefix: deliverable.prefix,
      created: resolution.created,
      filesPresent,
    };
    // A file that is absent (or a write with no file) is not a created
    // checkpoint, even when a write call named it.
    if (!resolution.created) {
      return {
        ...baseRow,
        method: null,
        step: null,
        billedPrompt: null,
        runningTotal: null,
        peak: null,
        fillStep: null,
        fillPeak: null,
        compactionCount: null,
        lastCompactionStep: null,
        deliverablesDone: null,
        matchedVia: null,
      };
    }
    // A present file with no parsed write is still created: count the file, and
    // leave the step/method null rather than inventing attribution.
    const found = resolution.found;
    if (found === null) {
      return {
        ...baseRow,
        method: null,
        step: null,
        billedPrompt: null,
        runningTotal: null,
        peak: null,
        fillStep: null,
        fillPeak: null,
        compactionCount: null,
        lastCompactionStep: null,
        deliverablesDone: null,
        matchedVia: null,
      };
    }
    const step = session.steps[found.call.step - 1];
    const compactions = session.compaction.starts
      .filter((start) => start.atRequest <= step.index);
    let compactionCount;
    let lastCompactionStep = null;
    if (session.compaction.count > 0) {
      compactionCount = compactions.length;
      lastCompactionStep = compactions.length > 0 ? compactions.at(-1).atRequest : null;
    } else if (result.compaction?.count !== null && result.compaction?.count !== undefined) {
      // The host states the count. With no session `compaction/start` row the
      // position is unknown: the count is stated, the position is null.
      compactionCount = result.compaction.count === 0 ? 0 : null;
    } else {
      compactionCount = null;
    }
    const done = list.filter((candidate) => {
      const candidateResolution = resolveDeliverable(candidate);
      return candidateResolution.created
        && candidateResolution.found !== null
        && candidateResolution.found.call.step <= step.index;
    }).length;
    return {
      ...baseRow,
      method: found.method,
      step: step.index,
      billedPrompt: step.depth,
      runningTotal: step.runningTotal,
      peak: step.peak,
      fillStep: step.depth,
      fillPeak: step.peak,
      compactionCount,
      lastCompactionStep,
      deliverablesDone: done,
      matchedVia: found.matchedVia,
    };
  });

  const created = checkpoints.filter((checkpoint) => checkpoint.created);
  const missing = checkpoints.filter((checkpoint) => !checkpoint.created);
  // `created` is the deliverable file's existence; `filesPresent` is the same
  // count, exposed under the name the task uses. When the final arm is absent
  // the file question is unknown (null), and `created` fell back to write
  // attribution above rather than claiming the files are missing.
  const filesPresent = checkpoints.every((checkpoint) => checkpoint.filesPresent !== null)
    ? checkpoints.filter((checkpoint) => checkpoint.filesPresent === true).length : null;
  const nonDeliverableWrites = completedWrites.filter((call) => call.path === null
    || !list.some((deliverable) => matchDeliverable(call.path, deliverable, base).matched));
  const distinctNonDeliverable = [...new Set(nonDeliverableWrites.map((call) => call.path ?? '<no path>'))];
  const journal = journalText === null || journalText === undefined
    ? null : parseJournal(journalText, journalPath ?? '<journal>');
  const ledgerFromResult = resultLedger(result);
  const ledger = ledgerPath === null || ledgerPath === undefined
    ? ledgerFromResult : { ...readLedger(ledgerPath), resultBlock: ledgerFromResult };
  const resultJournalByKind = result.journal?.byKind ?? null;
  const journalKindDeltas = [];
  if (journal !== null && resultJournalByKind !== null) {
    for (const kind of new Set([...Object.keys(journal.byKind), ...Object.keys(resultJournalByKind)])) {
      const computed = journal.byKind[kind] ?? 0;
      const host = Number(resultJournalByKind[kind] ?? 0);
      if (computed !== host) journalKindDeltas.push({ kind, computed, host });
    }
  }

  const notes = [];
  notes.push(`${session.steps.length} metered step(s); billed prompt = input + cache read + cache write.`);
  if (priorSeq === null) {
    notes.push(`session total ${sessionTotal} matches result.json usage.billedPromptTokens.`);
  } else {
    notes.push(`resumed round: result.resumedFrom.priorSeq ${priorSeq} bounds the billed population to the `
      + `${legRows.length} assistant row(s) with seq > ${priorSeq} (the new leg); `
      + `session rows bill ${legTotal} and result.json usage.billedPromptTokens is ${resultTotal}. `
      + `The step timeline keeps all ${session.steps.length} step(s) with whole-log running totals `
      + `(last step ${sessionTotal}).`);
  }
  if (legOmittedCacheWrite > 0) {
    notes.push(`${legOmittedCacheWrite} step(s) omit usage.cacheWriteTokens; `
      + 'result.usage.cacheWriteTokens is 0, so the absent bucket reads as 0, not a guess.');
  }
  if (result.context?.peak !== null && result.context?.peak !== undefined
    && result.context.peak !== session.steps.at(-1).peak) {
    notes.push(`result.context.peak ${result.context.peak} != the session's peak step depth `
      + `${session.steps.at(-1).peak}; the two read different series (result: per turn, session: per step).`);
  }
  if (result.compaction !== null && result.compaction.count !== null
    && result.compaction.count !== session.compaction.count) {
    notes.push(`result.compaction.count ${result.compaction.count} != session compaction/start rows `
      + `${session.compaction.count}; both are stated, neither is amended.`);
  }
  if (session.compaction.count > 0) {
    notes.push(`${session.compaction.count} native compaction(s) at request `
      + `${session.compaction.starts.map((start) => start.atRequest).join(', ')}; `
      + `${session.compaction.ends} end row(s), ${session.compaction.pruneEvents} prune row(s).`);
  } else if ((result.compaction?.count ?? 0) > 0) {
    notes.push(`the session log carries no compaction/start row while result.json reports `
      + `${result.compaction.count}; the per-checkpoint position is null, not invented.`);
  } else {
    notes.push('no native compaction fired: count 0 is the host\'s own reading.');
  }
  if (journal === null) {
    notes.push('no journal was supplied or named by result.json: the product lanes are unknown, not zero.');
  } else {
    notes.push(`journal: ${journal.rows} row(s), ${journal.malformed.length} malformed; `
      + `entry-ask ${journal.entryAsks}, prune-ask ${journal.pruneAsks}, `
      + `prune-threshold ${journal.byKind['prune-threshold'] ?? 0}.`);
    if (journal.malformed.length > 0) {
      notes.push(`journal malformed line(s): ${journal.malformed.map((row) => row.line).join(', ')}.`);
    }
    if (journal.thresholds.length > 0) {
      notes.push(`prune threshold value(s): ${journal.thresholds.join(', ')}.`);
    }
    if (journal.firstCrossing !== null) {
      notes.push(`first crossed at ${journal.firstCrossing.estimatedTokens ?? 'unknown'} `
        + `estimated token(s) against ${journal.firstCrossing.threshold ?? 'unknown'}.`);
    } else {
      notes.push('no prune-threshold row crossed in this journal.');
    }
    if (journalKindDeltas.length > 0) {
      notes.push(`journal counts differ from result.journal.byKind: `
        + `${journalKindDeltas.map((row) => `${row.kind} ${row.computed} != ${row.host}`).join(', ')}.`);
    }
  }
  if (ledger === null) {
    notes.push('no ledger was supplied: recall ids and applied removals are unknown, not zero.');
  } else if (ledger.present !== true) {
    notes.push('no ledger is present for this arm: recall ids and applied removals are unknown, not zero.');
  } else if (ledger.readable === false) {
    notes.push(`the ledger could not be read (${ledger.error ?? 'absent'}); `
      + 'recall ids and applied removals are unknown, not zero.');
  } else {
    const applications = ledger.applications === null || ledger.applications === undefined
      ? `${Object.keys(ledger.applicationKinds ?? {}).length} application kind(s)`
      : `${ledger.applications} application(s)`;
    notes.push(`ledger: ${ledger.applied} applied, ${applications}, `
      + `${ledger.recalls} recall id(s), ${ledger.removals} removal(s).`);
    if (ledger.resultBlock !== undefined && ledger.resultBlock !== null) {
      const pairs = [
        ['recall id(s)', ledger.recalls, ledger.resultBlock.recalls],
        ['applied event(s)', ledger.applied, ledger.resultBlock.applied],
        ['removal(s)', ledger.removals, ledger.resultBlock.removals],
      ].filter(([, computed, host]) => computed !== null && computed !== undefined && computed !== host);
      if (pairs.length > 0) {
        notes.push(`the ledger database and result.json disagree: `
          + `${pairs.map(([label, computed, host]) => `${label} ${String(computed)} != ${String(host)}`).join(', ')}; `
          + 'both are shown.');
      }
    }
  }
  if (nonDeliverableWrites.length > 0) {
    notes.push(`${nonDeliverableWrites.length} completed write/edit/create call(s) name no deliverable `
      + `(${distinctNonDeliverable.slice(0, 5).join(', ')}${distinctNonDeliverable.length > 5 ? ', …' : ''}).`);
  }
  if (writeCalls.length === 0 && shellWriteCallKeys.size === 0) {
    notes.push('no write/edit/create tool row and no parsed shell write names a deliverable; '
      + (filesPresent === null
        ? 'the final arm was not read, so file presence is unknown and created falls back to attribution.'
        : `${filesPresent} deliverable file(s) are present in the final arm, so created counts the files `
          + 'and write attribution is 0.'));
  } else if (completedWrites.length < writeCalls.length) {
    notes.push(`${writeCalls.length - completedWrites.length} write/edit/create row(s) did not complete `
      + 'and are not counted as creation.');
  }
  if (shellCalls.length > 0) {
    notes.push(`${shellCalls.length} shell row(s); ${shellWriteCallKeys.size} completed shell call(s) `
      + 'write a deliverable path.');
  }
  const methods = { 'write-tool': 0, 'shell-write': 0, 'mention-fallback': 0 };
  for (const checkpoint of created) {
    // A file present with no parsed write has `method: null`: it is created,
    // but it carries no write attribution.
    if (checkpoint.method !== null) methods[checkpoint.method] += 1;
  }
  const attributedCreated = Object.values(methods).reduce((sum, count) => sum + count, 0);
  if (created.length > attributedCreated) {
    notes.push(`${created.length - attributedCreated} checkpoint(s) are created by the file's presence `
      + 'with no parsed write attribution; `created` counts deliverable files, while '
      + '`writeCalls`/`shellWriteCalls` count write calls.');
  }
  if (methods['shell-write'] > 0) {
    notes.push(`${methods['shell-write']} checkpoint(s) marked by shell-write `
      + '(a completed shell command names the deliverable as its write target).');
  }
  if (methods['mention-fallback'] > 0) {
    const paths = created.filter((checkpoint) => checkpoint.method === 'mention-fallback')
      .map((checkpoint) => checkpoint.path);
    notes.push(`${methods['mention-fallback']} checkpoint(s) marked by mention-fallback `
      + `(${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}): the exact path is `
      + 'mentioned by a completed non-write call and exists in the final arm; no write tool or '
      + 'parsed shell write named it, so the step is an upper bound on creation.');
  }
  if (result.stop?.censored === true) {
    notes.push(`censored partial: stopped by ${result.stop.reason ?? 'an unnamed stop'}`
      + `${result.stop.checkpoint?.path === undefined || result.stop.checkpoint?.path === null
        ? '' : ` at ${result.stop.checkpoint.path}`}; `
      + `${filesPresent ?? created.length}/${list.length} deliverable(s) present, largest contiguous k=`
      + `${result.stop.largestCommonK ?? 'unknown'}, benchDone.found=`
      + `${result.stop.benchDone?.found === true}. Compare only at the largest k both arms share; `
      + 'gate claims on benchDone.found, never passed.');
  }

  return {
    tool: TOOL_NAME,
    // 3 adds the optional censored-stop block (`stoppedBy`/`stop`/
    // `censoredPartial`). A completed run's fields are unchanged.
    version: 3,
    source: {
      result: {
        path: resultPath,
        bytes: Buffer.byteLength(resultText, 'utf8'),
        sha256: createHash('sha256').update(resultText, 'utf8').digest('hex'),
      },
      session: {
        path: sessionPath,
        bytes: Buffer.byteLength(sessionText, 'utf8'),
        sha256: createHash('sha256').update(sessionText, 'utf8').digest('hex'),
        events: session.events,
      },
      journal: journal === null ? null : {
        path: journalPath ?? '<journal>',
        bytes: Buffer.byteLength(journalText, 'utf8'),
        sha256: createHash('sha256').update(journalText, 'utf8').digest('hex'),
      },
      ledger: ledger === null ? null : { path: ledger.path },
    },
    arm: result.arm,
    provider: result.provider,
    workspaceBase: base,
    checkpoints,
    steps: session.steps.map((step) => ({
      index: step.index,
      turn: step.turn,
      step: step.step,
      messages: step.messages,
      depth: step.depth,
      runningTotal: step.runningTotal,
      peak: step.peak,
      output: step.output,
      toolCalls: step.toolCalls.map((call) => ({
        name: call.name,
        path: call.path,
        completed: call.completed,
        isError: call.isError,
      })),
    })),
    compaction: {
      sessionCount: session.compaction.count,
      sessionEnds: session.compaction.ends,
      sessionPruneEvents: session.compaction.pruneEvents,
      hostCount: result.compaction?.count ?? null,
      hostEnds: result.compaction?.ends ?? null,
      atRequests: session.compaction.starts.map((start) => start.atRequest),
      atSeqs: session.compaction.starts.map((start) => start.seq),
      hostAtRequests: result.compaction?.atRequests ?? null,
      timingRecorded: session.compaction.count > 0,
    },
    journal,
    ledger,
    overall: {
      steps: session.steps.length,
      // A killed run's last `step/start` has no `assistant/message`; the
      // reading is stated here, not mistaken for a corrupt log.
      tailStepIncomplete: session.tailStepIncomplete,
      tailStepIndex: session.tailStepIndex,
      // The billed population, bounded at `resumedFrom.priorSeq` on a resume
      // round: it describes the same leg as `result.usage`, while `steps` keeps
      // the whole adopted log's timeline (ISSUE-491).
      totalBilledPrompt: legTotal,
      totalInput: result.usage.inputTokens,
      totalCacheRead: result.usage.cacheReadTokens,
      totalCacheWrite: result.usage.cacheWriteTokens,
      totalOutput: result.usage.outputTokens,
      resultBilledPromptTokens: resultTotal,
      billedTotalsMatch: legTotal === resultTotal,
      peakFill: session.steps.at(-1).peak,
      finalFill: session.steps.at(-1).depth,
      deliverableCount: list.length,
      deliverableSource,
      // The task deliverable is the file: `deliverablesCreated`/`filesPresent`
      // count files present in the final arm. `attributedCreated` and
      // `writeCalls`/`shellWriteCalls` are a SEPARATE write-call reading.
      deliverablesCreated: created.length,
      filesPresent,
      filesPresentKnown: filesPresent !== null,
      attributedCreated,
      deliverablesMissing: missing.length,
      createdPaths: created.map((checkpoint) => checkpoint.path),
      missingPaths: missing.map((checkpoint) => checkpoint.path),
      writeCalls: writeCalls.length,
      completedWriteCalls: completedWrites.length,
      readCalls: readCalls.length,
      shellCalls: shellCalls.length,
      shellWriteCalls: shellWriteCallKeys.size,
      shellTools: [...new Set(shellCalls.map((call) => call.name))].sort(),
      writeTools: [...new Set(writeCalls.map((call) => call.name))].sort(),
      methodCounts: methods,
      mentionFallbackPaths: created.filter((checkpoint) => checkpoint.method === 'mention-fallback')
        .map((checkpoint) => checkpoint.path),
      nonDeliverableWrites: nonDeliverableWrites.length,
      benchDone: result.session?.benchDone ?? null,
      exit: result.exit,
      passed: result.passed,
      // A stop is a censored partial, not a failure. The analysis names it on
      // the overall block so a stopped run is never read as a completed one;
      // `benchDone.found` is the claim gate, never `passed`.
      stoppedBy: result.stoppedBy,
      stop: result.stop,
      censoredPartial: result.stop?.censored === true,
    },
    notes,
  };
}

/**
 * Resolve the four inputs from a result path or an evidence dir, read them,
 * and analyze them. A missing session path is an error; a missing journal or
 * ledger is reported as unknown by the analysis.
 */
export function analyzeRun({
  resultPath = null,
  evidenceDir = null,
  sessionPath = null,
  journalPath = null,
  ledgerPath = null,
  deliverablesPath = null,
}) {
  if (resultPath === null && evidenceDir === null) {
    throw new Error(`${PREFIX} a result.json path or an evidence dir is required`);
  }
  const resolvedResult = resultPath === null
    ? join(resolve(evidenceDir), 'result.json')
    : resolve(resultPath);
  const resultText = readFileSync(resolvedResult, 'utf8');
  const parsed = parseResult(resultText, resolvedResult);
  const session = sessionPath ?? parsed.session?.files?.[0] ?? null;
  if (session === null) {
    throw new Error(`${PREFIX} result.json names no session log and --session was not given`);
  }
  const sessionText = readFileSync(resolve(session), 'utf8');
  const journal = journalPath ?? parsed.journal?.file ?? null;
  let journalText = null;
  if (journal !== null) {
    if (existsSync(journal)) journalText = readFileSync(resolve(journal), 'utf8');
    else if (parsed.journal?.emitted === true) {
      throw new Error(`${PREFIX} result.json names the journal at ${journal} but the file is absent; `
        + 'the product lanes cannot be read');
    }
  }
  const ledgerCandidate = ledgerPath ?? parsed.journal?.ledger?.file ?? null;
  const resolvedLedger = typeof ledgerCandidate === 'string' && !ledgerCandidate.includes('<sessionId>')
    && existsSync(ledgerCandidate) ? ledgerCandidate : null;
  const deliverablesText = deliverablesPath === null
    ? null : readFileSync(resolve(deliverablesPath), 'utf8');
  return analyzeText({
    resultText,
    sessionText,
    journalText,
    journalPath: journal,
    ledgerPath: resolvedLedger,
    deliverablesText,
    deliverablesSource: deliverablesPath ?? '<deliverables>',
    resultPath: resolvedResult,
    sessionPath: session,
    armDir: parsed.work?.dir ?? parsed.arm.dir ?? null,
  });
}

function formatNumber(value) {
  return value === null || value === undefined ? '-' : String(value);
}

/** A compact human report. `--json` emits the object instead. */
export function formatReport(report) {
  const lines = [];
  lines.push(`${TOOL_NAME}: ${report.source.result.path}`);
  lines.push(`session: ${report.source.session.path}`);
  lines.push(`journal: ${report.source.journal?.path ?? '(none)'}   `
    + `ledger: ${report.source.ledger?.path ?? '(none)'}`);
  lines.push(`steps: ${report.overall.steps}   `
    + `billedPrompt: ${report.overall.totalBilledPrompt}   `
    + `peakFill: ${report.overall.peakFill}   finalFill: ${report.overall.finalFill}   `
    + `input: ${report.overall.totalInput}   cacheRead: ${report.overall.totalCacheRead}   `
    + `cacheWrite: ${report.overall.totalCacheWrite}`);
  lines.push(`compaction: session ${report.compaction.sessionCount} `
    + `(ends ${report.compaction.sessionEnds}, prune ${report.compaction.sessionPruneEvents})   `
    + `host ${formatNumber(report.compaction.hostCount)}   `
    + `timing ${report.compaction.timingRecorded
      ? `[${report.compaction.atRequests.join(', ')}]` : 'null'}`);
  if (report.journal !== null) {
    lines.push(`journal: rows ${report.journal.rows} malformed ${report.journal.malformed.length}   `
      + `entry-ask ${report.journal.entryAsks}   prune-ask ${report.journal.pruneAsks}   `
      + `thresholds [${report.journal.thresholds.join(', ')}]   `
      + `first-crossed ${report.journal.firstCrossing === null ? 'none'
        : `${formatNumber(report.journal.firstCrossing.estimatedTokens)} >= `
          + `${formatNumber(report.journal.firstCrossing.threshold)}`}`);
  }
  if (report.ledger !== null && report.ledger.readable === true) {
    const applications = report.ledger.applications === null || report.ledger.applications === undefined
      ? `${Object.keys(report.ledger.applicationKinds ?? {}).length} kind(s)`
      : String(report.ledger.applications);
    lines.push(`ledger: applied ${report.ledger.applied}   applications ${applications}   `
      + `recalls ${report.ledger.recalls}   removals ${report.ledger.removals}`);
  }
  const filesPresent = report.overall.filesPresent ?? null;
  const presentLabel = filesPresent === null
    ? `created (write attribution, final arm not read): `
      + `${report.overall.deliverablesCreated}/${report.overall.deliverableCount}`
    : `created (files present): ${filesPresent}/${report.overall.deliverableCount}`;
  lines.push(`${presentLabel}   `
    + `write attribution: ${report.overall.writeCalls} write/edit/create call(s), `
    + `${report.overall.shellWriteCalls ?? 0} shell write call(s)   `
    + `reads: ${report.overall.readCalls}   shell: ${report.overall.shellCalls}`);
  lines.push('');
  const header = ['k', 'deliverable', 'method', 'step', 'billedPrompt', 'runningTotal', 'peak',
    'fillStep', 'fillPeak', 'compaction', 'lastCompactionStep', 'done'];
  const rows = report.checkpoints.map((checkpoint) => [
    String(checkpoint.k),
    checkpoint.path,
    formatNumber(checkpoint.method),
    formatNumber(checkpoint.step),
    formatNumber(checkpoint.billedPrompt),
    formatNumber(checkpoint.runningTotal),
    formatNumber(checkpoint.peak),
    formatNumber(checkpoint.fillStep),
    formatNumber(checkpoint.fillPeak),
    formatNumber(checkpoint.compactionCount),
    formatNumber(checkpoint.lastCompactionStep),
    formatNumber(checkpoint.deliverablesDone),
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
    lines.push(`not present: ${report.overall.missingPaths.join(', ')}`);
  }
  lines.push('');
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join('\n');
}

function usage() {
  return `usage: node dev/bench/dsh-checkpoints.mjs <evidence-dir|result.json> `
    + '[--session <file>] [--journal <file>] [--ledger <file>] '
    + '[--deliverables <json-or-newline-file>] [--json]';
}

/** The flags, in the order the usage line lists them (ISSUE-391). */
const CHECKPOINT_OPTIONS = optionsOf([
  ['--session', 'string'],
  ['--journal', 'string'],
  ['--ledger', 'string'],
  ['--deliverables', 'string', 'deliverablesPath', { short: 'd' }],
  ['--json', 'boolean'],
  ['--help', 'boolean', 'help', { short: 'h' }],
]);

function parseArgs(argv) {
  const { values, positionals } = parseDevArgs(argv, {
    options: CHECKPOINT_OPTIONS,
    refuse: (message) => { throw new Error(message); },
    allowPositionals: true,
    // This script's unknown-option text reads "unknown option <flag>".
    unknown: (rawName) => `unknown option ${rawName}`,
  });
  if (values.help === true) return { help: true };
  if (positionals.length === 0) throw new Error('an evidence dir or result.json path is required');
  if (positionals.length > 1) throw new Error(`unexpected extra argument ${positionals[1]}`);
  const target = resolve(positionals[0]);
  let evidenceDir = null;
  let resultPath = null;
  if (existsSync(target) && statSync(target).isDirectory()) evidenceDir = target;
  else resultPath = target;
  return {
    help: false,
    resultPath,
    evidenceDir,
    sessionPath: values.session ?? null,
    journalPath: values.journal ?? null,
    ledgerPath: values.ledger ?? null,
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
      resultPath: options.resultPath,
      evidenceDir: options.evidenceDir,
      sessionPath: options.sessionPath,
      journalPath: options.journalPath,
      ledgerPath: options.ledgerPath,
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
