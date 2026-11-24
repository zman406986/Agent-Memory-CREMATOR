#!/usr/bin/env node
/**
 * Replay ten opencode ask moments under the corrected table prompt (ISSUE-510).
 *
 * THE MOMENTS. Ten `ask` records in the two opencode final-shape lanes
 * (`run-1`, `run-3`) under `scratchpad/launch/2026-11-19-opencode-v2/`. Each
 * moment names one 1-based line of that segment's `test/journal.jsonl` and the
 * 1-based line of the `test/capture.jsonl` generate request that carried the
 * ask. These are ledger rows 32 and 34. All ten used the host-honest
 * keepall/forgetall prompt (`OPENCODE_ASK_FRAME` + the two-option contract +
 * `renderPruneAskTable` + `PRUNE_ASK_FINAL_LINE`), the ISSUE-509 defect.
 *
 * THE OFFLINE GATE (default). Per moment, read the journal, the captured
 * request and the session ledger (read-only), then prove:
 *
 *   1. the journal line is an `ask`; the capture line is not truncated and its
 *      recorded body is complete;
 *   2. the captured request's LAST message hashes to the journal's
 *      `promptSha256` and is `promptChars` characters;
 *   3. the prompt is the two-option keepall/forgetall message, not the shipped
 *      three-piece one;
 *   4. the table has exactly the journal's `rowCount` rows, indices equal the
 *      journal's `indices`;
 *   5. EVERY row's line count is computed from the captured unit's decoded
 *      result text — the byte space the fixed product geometry addresses
 *      (`packages/adapters/opencode/src/snapshot.ts`: `unitBytes` is the decoded
 *      result text and the line ranges are over it). A row is matched to its
 *      captured tool result BY IDENTITY, never by walk order: the journal's
 *      `unitIds[i]` names the unit of the row at position `i`, the ledger
 *      archive of that unit is the pre-ISSUE-511 `{input,name,result}` envelope,
 *      and its DECODED result text is the identity key (`opencodeUnitText`'s
 *      mapping, mirrored in `envelopeResultText`). A row whose unit was never
 *      archived falls back to the row's anchor quote: the quote must identify
 *      exactly one captured unit's decoded text, and a quote that fits two
 *      different bodies STOPS the moment. The row's `callOrdinal` must also
 *      agree: within one call (kind and target) the table's ordinals strictly
 *      increase, and the matched unit's captured ordinal is never below the
 *      row's. A row that matches no unit, an anchor that names two bodies, or an
 *      ordinal that contradicts the anchor STOPS the moment and names the row.
 *      The pre-ISSUE-511 anchors all say `line 1 of 1` because that geometry was
 *      the envelope; the anchor is a quote, never `L`;
 *   6. every computed count is a positive integer, and the capture's multi-line
 *      units require at least one multi-line row;
 *   7. every table row's `[L line(s)]` equals that row's computed count;
 *   8. for every `forgetall` row the ledger source blob holds no newline (this
 *      lane archived the envelope, whose escaped newlines made each blob one
 *      physical line), it resolves to an `ask-apply` record for that unit (any
 *      round: a unit's source length cannot change) and to exactly one
 *      `recall_parts` row whose `source_byte_length` equals the blob's size —
 *      the old whole-unit removal.
 *
 * Old removals are computed from the journal's parsed verdicts: `forgetall`
 * removes the whole unit, a literal `keepall` keeps. The corrected ask is
 * `entryBatchAskMessage(rows, "jsonl-20-nokeepall", firstTrigger)` with the
 * 70 percent line on round 1 and 40 percent on every later ask. A partial
 * `keeplines` is addressable on a multi-line unit, is accepted, and is PRICED:
 * a dropped line frees its own text plus the newline that ended it, the
 * product's range convention (ADR-0044 amendment; `partialKeepFreedBytes`).
 *
 * Deltas. `oldUnits`/`oldBytes` are what the run removed. `newUnits`/`newBytes`
 * are what the corrected prompt's recorded answers remove: `forgetall` still
 * removes, and the literal `keepall` the corrected grammar does not offer
 * becomes a terminal refusal that keeps, so this replay's delta is zero. The
 * paid lane's `newUnits`/`newBytes` come from the fresh draw instead.
 *
 * THE SEND LANE (`--transport stub|deepseek`, `--i-am-the-owner`). The rebuilt
 * body is the captured one: the same `model` and `tools`, the captured
 * `messages` minus the old ask, then the corrected ask as the last user turn.
 * ONE request per moment and no re-ask: a terminal `action-not-in-grammar`
 * refusal keeps its row and is never retried. `stub` answers from a fixed rule
 * with no socket. `deepseek` reads `DEEPSEEK_API_KEY` in-process from the
 * `refs:` block of `~/.dsh/.credentials.yaml` (C:\Users\TZhen\ or C:\Users\TZ\,
 * plus the running home), never prints or exports it, and requires
 * `--token-grant` and `--kill-ms`. Every offline gate is re-checked before the
 * key is read or a socket opened; any failure refuses the whole lane. The kill
 * timer is armed before the first read, and records are written after every
 * moment. A stub-only `--stub-fail length-trip|transport-error` seam exercises
 * both failure charge branches — a billed truncated draw and a failure that
 * states no usage — with no socket.
 *
 * This file makes no paid call by default. Evidence goes under
 * `scratchpad/launch/<yyyy-mm-dd>-replay-opencode-asks/` and is never committed.
 *
 * THE RECOMPUTE LANE (`--live <file[,file]>`). Display only. It reads a stored
 * send-lane evidence file, rebuilds every row and unit from the moments'
 * journals and captures exactly as the offline lane does, re-reads each
 * record's stored `firstContent` through the shipped product reader, prices the
 * partial keeps with the same rule the send lane uses, and prints the corrected
 * aggregate — with no socket, no key and no send. The stored evidence is never
 * modified; the corrected report is written beside it as
 * `<name>-recomputed.json`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  byteRangeForLines, buildPruneAnchors, entryBatchAskMessage, lineCount,
  readJsonl20NoKeepallAnswer, sha256Sync, toBytes,
} from '@cremator/core';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'scratchpad', 'launch', '2026-11-19-opencode-v2');
const MODEL = 'deepseek-flash';
const BASE = 'https://api.deepseek.com/v1';
const CORRECTED_GRAMMAR = 'jsonl-20-nokeepall';

/**
 * The ten moments. `run` is the lane directory, `seg` the segment directory,
 * `journalLine` the 1-based `ask` line, `captureLine` the 1-based captured
 * request. All ten are ledger rows 32/34.
 */
export const MOMENTS = Object.freeze([
  { run: 'run-1', seg: 'opencode-seg1-t', journalLine: 166, captureLine: 23 },
  { run: 'run-1', seg: 'opencode-seg11-t', journalLine: 21566, captureLine: 70 },
  { run: 'run-1', seg: 'opencode-seg2-t', journalLine: 7557, captureLine: 76 },
  { run: 'run-1', seg: 'opencode-seg10-t', journalLine: 192, captureLine: 2 },
  { run: 'run-3', seg: 'opencode-seg1-t', journalLine: 139, captureLine: 19 },
  { run: 'run-3', seg: 'opencode-seg4-t', journalLine: 17780, captureLine: 80 },
  { run: 'run-3', seg: 'opencode-seg5-t', journalLine: 254, captureLine: 2 },
  { run: 'run-3', seg: 'opencode-seg8-t', journalLine: 481, captureLine: 2 },
  { run: 'run-3', seg: 'opencode-seg9-t', journalLine: 4845, captureLine: 58 },
  { run: 'run-3', seg: 'opencode-seg10-t', journalLine: 8598, captureLine: 56 },
]);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (text) => sha256Sync(Buffer.from(text, 'utf8'));
const rowLabelOf = (moment) => `${moment.run}/${moment.seg} j${String(moment.journalLine)}`;

/** One table row: `N. [kind] path (call #k) — anchor`, path optional. */
const ROW_LINE = /^(\d+)\. \[([^\]]+)\](?: (.+?))? \(call #(\d+)\)(?: — (.*))?$/;
const ROW_START = /^\d+\. \[/;
const TWO_OPTION_MARKS = ['There is no line-level option', 'keepall keeps the whole result',
  '{"keepall":true}'];

/**
 * The captured old table's rows in the corrected builder's row shape. The
 * anchor is kept as the row's quote, and the occurrence ordinal is kept so a
 * repeated call on one target stays distinguishable; the anchor's `line X of N`
 * is NOT read as `L` (the recorded prompts carry the pre-ISSUE-511 envelope
 * geometry, where every unit was one physical line).
 */
export function parseAskRows(prompt) {
  const rows = [];
  for (const line of prompt.split('\n')) {
    const match = ROW_LINE.exec(line);
    if (match === null) continue;
    const anchor = match[5];
    rows.push({
      index: Number(match[1]),
      call: match[2],
      callOrdinal: Number(match[4]),
      ...(match[3] === undefined ? {} : { path: match[3] }),
      anchorLines: anchor === undefined ? [] : [anchor],
    });
  }
  return rows;
}

/** A path compared across the table's slash spelling and the wire's. */
const normalizePath = (value) => String(value).split('\\').join('/');

/** The call's declared target, in the precedence the product's own facts use. */
function unitTargetOf(input) {
  for (const key of ['path', 'filePath', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return normalizePath(value);
  }
  return '';
}

/**
 * Every tool result the captured request carries, in message order, with the
 * unit text the fixed geometry addresses: the wire's decoded tool message
 * content is the result text (`opencodeUnitText`'s decoded body), and the line
 * count is `lineCount` over exactly that text — never a JSON envelope's escaped
 * newlines.
 *
 * Each unit also carries its captured occurrence ordinal: the 1-based count of
 * captured units of the same call (kind and target) up to it. That is the
 * captured side of the row's `(call #k)`, and `assignRowLineCounts` reads it.
 */
export function capturedUnits(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const calls = new Map();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (isRecord(call) && typeof call.id === 'string' && isRecord(call.function)) {
        calls.set(call.id, call.function);
      }
    }
  }
  const units = [];
  const ordinals = new Map();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    const fn = calls.get(message.tool_call_id);
    if (!isRecord(fn) || typeof fn.name !== 'string') continue;
    let input = {};
    if (typeof fn.arguments === 'string') {
      try { const parsed = JSON.parse(fn.arguments); if (isRecord(parsed)) input = parsed; } catch { /* no target */ }
    }
    const text = typeof message.content === 'string'
      ? message.content : (JSON.stringify(message.content) ?? '');
    const call = fn.name.toLowerCase();
    const target = unitTargetOf(input);
    const key = `${call}\u0000${target}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    units.push({
      index: units.length,
      callId: message.tool_call_id,
      call,
      path: target,
      ordinal,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      lineCount: lineCount(toBytes(text)),
    });
  }
  return units;
}

/** The quoted tail an old anchor carries, or `null` when it carries no quote. */
export function anchorQuoteOf(anchor) {
  if (typeof anchor !== 'string') return null;
  const match = /^line \d+ of \d+ ends with "([\s\S]*)"$/u.exec(anchor);
  return match === null ? null : match[1];
}

const anchorWords = (value) => value.split(/\s+/u).filter((word) => word !== '');
/** The envelope's closing JSON punctuation, which rides the last quoted word. */
const stripEnvelopeClosers = (word) => word.replace(/[}\]]+$/u, '').replace(/"$/u, '');

/**
 * Whether an old anchor's quote names a unit's text. The recorded prompts carry
 * the pre-ISSUE-511 geometry: the unit's bytes were the `{input,name,result}`
 * envelope, one physical line, so the anchor's quote is the last whole words of
 * `JSON.stringify(<result text>)` followed by the envelope's closing braces.
 * The quote is compared as a WORD TAIL of that escaped text, its leading
 * envelope closers stripped, because the anchor joins words with one space.
 *
 * This is a verification, never a source of `L`: `line 1 of 1` is envelope
 * geometry and says nothing about the decoded body's line count.
 */
export function anchorMatchesText(anchor, text) {
  const quote = anchorQuoteOf(anchor);
  if (quote === null) return false;
  const needle = anchorWords(quote);
  if (needle.length === 0) return false;
  const haystack = anchorWords(`${JSON.stringify(text)}}`);
  if (needle.length > haystack.length) return false;
  const at = haystack.length - needle.length;
  for (let i = 0; i < needle.length - 1; i += 1) {
    if (!haystack[at + i].endsWith(needle[i])) return false;
  }
  const last = haystack[haystack.length - 1];
  const tail = needle[needle.length - 1];
  return last.endsWith(tail) || stripEnvelopeClosers(last).endsWith(stripEnvelopeClosers(tail));
}

/**
 * The decoded result text inside an archived pre-ISSUE-511 envelope, mirroring
 * `opencodeUnitText` tag for tag (`packages/adapters/opencode/src/snapshot.ts`).
 * The archive is used ONLY as an identity key: `L` comes from the captured unit's
 * decoded text, never from the envelope's one physical line.
 */
export function envelopeResultText(envelope) {
  const result = isRecord(envelope) ? envelope.result : undefined;
  if (!isRecord(result)) return null;
  const value = result.value;
  if (result.type === 'text') {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  }
  if (result.type === 'json') return JSON.stringify(value) ?? '';
  if (result.type === 'error') {
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') return JSON.stringify(value) ?? '';
    return String(value);
  }
  if (result.type === 'content' && Array.isArray(value)) {
    const texts = [];
    for (const entry of value) {
      if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string' && entry.text !== '') {
        texts.push(entry.text);
      }
    }
    return texts.join('\n');
  }
  return JSON.stringify(value) ?? '';
}

/**
 * The anchors a corrected row carries: the product's OWN prune anchors over the
 * unit's decoded text (`buildPruneAnchors`, the 30 and 70 percent byte shares),
 * so the quote a row shows is a real content line of the unit the row names and
 * agrees with its `[L line(s)]`. The recorded prompt's quote was a tail of the
 * pre-ISSUE-511 envelope, so leaving it in place put `line 1 of 1` beside
 * `[86 lines]` in the same row — a visible contradiction. This function replaces
 * that quote; the old one is kept on the row as `oldAnchorLines`, used only to
 * verify the identity match.
 *
 * `[]` for a unit with no lines: there is no content to quote.
 */
export function contentAnchorLines(text) {
  const built = buildPruneAnchors(toBytes(text));
  if ('anchors' in built) return [...built.anchors];
  return [];
}

/**
 * Assign every row the captured unit it NAMES, by identity.
 *
 * A row is identified by its call (kind and target), its `callOrdinal`, and its
 * anchor quote. `archivedTexts` maps a row's assigned index to the decoded text
 * of that row's own unit, read from the ledger archive the journal's
 * `unitIds[i]` names — the exact body, so the match is content equality and not
 * a walk. A row with no archive (its unit was never removed) is matched by the
 * anchor quote instead, which must name exactly one body; two different bodies
 * behind one quote is `ambiguous`, never a guess.
 *
 * The ordinal is a check, not a cursor: within one call the table's ordinals
 * must strictly increase, and the matched unit's captured ordinal must be at
 * least the row's, so a table whose numbering contradicts its anchors is
 * `disagree` rather than silently accepted.
 */
export function assignRowLineCounts(rows, units, archivedTexts = new Map()) {
  const missing = [];
  const ambiguous = [];
  const disagree = [];
  const matches = [];
  const lastOrdinal = new Map();
  const assigned = rows.map((row) => {
    const wantPath = row.path === undefined ? null : normalizePath(row.path);
    const key = `${row.call.toLowerCase()}\u0000${wantPath ?? ''}`;
    const previousOrdinal = lastOrdinal.get(key);
    lastOrdinal.set(key, row.callOrdinal);
    if (previousOrdinal !== undefined && row.callOrdinal <= previousOrdinal) {
      disagree.push({ index: row.index,
        why: `call #${String(row.callOrdinal)} follows #${String(previousOrdinal)}` });
    }
    const sameCall = (unit) => unit.call === row.call.toLowerCase()
      && (wantPath === null || unit.path === wantPath);
    const archived = archivedTexts.get(row.index);
    const byArchive = typeof archived === 'string' && archived !== '';
    const candidates = byArchive
      ? units.filter((unit) => sameCall(unit) && unit.text === archived)
      : units.filter((unit) => sameCall(unit) && anchorMatchesText(row.anchorLines[0], unit.text));
    if (!byArchive && candidates.length > 0) {
      const bodies = new Set(candidates.map((unit) => unit.text));
      if (bodies.size > 1) {
        ambiguous.push(row.index);
        matches.push(-1);
        return { ...row };
      }
    }
    if (candidates.length === 0) {
      missing.push(row.index);
      matches.push(-1);
      return { ...row };
    }
    // Among byte-identical copies the row's own ordinal names the occurrence; the
    // content is the same either way, so this only keeps the bookkeeping exact.
    const unit = candidates.find((candidate) => candidate.ordinal >= row.callOrdinal)
      ?? candidates[0];
    if (unit.ordinal < row.callOrdinal) {
      disagree.push({ index: row.index,
        why: `call #${String(row.callOrdinal)} names captured #${String(unit.ordinal)}` });
    }
    const anchorVerified = anchorMatchesText(row.anchorLines[0], unit.text);
    if (!anchorVerified) {
      disagree.push({ index: row.index, why: 'the anchor quote is not in the matched unit' });
    }
    matches.push(unit.index);
    // The row now quotes its own unit's content, so the quote and `[L line(s)]`
    // cannot contradict each other.
    const oldAnchorLines = row.anchorLines;
    return { ...row, oldAnchorLines, anchorLines: contentAnchorLines(unit.text),
      lineCount: unit.lineCount, decodedBytes: unit.bytes,
      unitText: unit.text, unitCallId: unit.callId, unitOrdinal: unit.ordinal,
      matchedBy: byArchive ? 'archive' : 'anchor', contentCopies: candidates.length,
      anchorVerified };
  });
  return { rows: assigned, missing, ambiguous, disagree, matches };
}

/** The corrected ask: core's shipped three-piece `jsonl-20-nokeepall` message. */
export function correctedAsk(rows, firstTrigger) {
  return entryBatchAskMessage(rows, CORRECTED_GRAMMAR, firstTrigger);
}

/**
 * The `corrected-ask` gate's verdict and detail. The pass detail states the
 * bytes, row lines, the one share line and the sha. The failure detail names
 * what actually failed — the expected share line missing, the other share line
 * still present, a row line whose `[L line(s)]` is not that row's computed
 * count (or missing), a row with no computed count, no trailer, or an ask that
 * equals the recorded prompt — instead of printing `NN% only` whatever
 * happened.
 */
export function correctedAskGate(rows, text, firstTrigger, prompt = null) {
  const share = firstTrigger ? 'keep at most 70 percent' : 'keep at most 40 percent';
  const otherShare = firstTrigger ? 'keep at most 40 percent' : 'keep at most 70 percent';
  const tableLines = text.split('\n').filter((line) => ROW_START.test(line));
  const byIndex = new Map(rows.map((row) => [row.index, row]));
  const failures = [];
  if (prompt !== null && text === prompt) failures.push('the corrected ask equals the recorded prompt');
  if (!text.includes(share)) failures.push(`expected share line absent: "${share}"`);
  if (text.includes(otherShare)) failures.push(`other share line present: "${otherShare}"`);
  if (tableLines.length !== rows.length) {
    failures.push(`row line(s) ${String(tableLines.length)} / rows ${String(rows.length)}`);
  }
  const labelFailures = [];
  for (const line of tableLines) {
    const at = /^(\d+)\. /.exec(line);
    if (at === null) continue;
    const row = byIndex.get(Number(at[1]));
    if (row === undefined || !Number.isSafeInteger(row.lineCount) || row.lineCount < 1) {
      labelFailures.push(`row ${at[1]} has no computed line count`);
      continue;
    }
    const label = ` [${String(row.lineCount)} line${row.lineCount === 1 ? '' : 's'}]`;
    if (!line.endsWith(label)) labelFailures.push(`row ${at[1]} does not end with "${label.trim()}"`);
  }
  if (labelFailures.length > 0) {
    failures.push(labelFailures.slice(0, 3).join('; ')
      + (labelFailures.length > 3 ? ` (+${String(labelFailures.length - 3)} more)` : ''));
  }
  if (!text.includes('[[entry-ask-end:')) failures.push('no entry-ask-end trailer');
  const bytes = Buffer.byteLength(text);
  const sha256 = sha(text);
  const ok = failures.length === 0 && bytes > 0;
  return {
    ok,
    detail: ok
      ? `${String(bytes)} B, ${String(tableLines.length)} row(s), ${firstTrigger ? '70' : '40'}%`
        + ` only, sha ${sha256.slice(0, 12)}…`
      : failures.join('; '),
    bytes,
    sha256,
    tableLines: tableLines.length,
  };
}

/** Deterministic canned answer for `--transport stub`; no model is called. */
export function stubAnswerText(rows) {
  const lines = [];
  for (const row of rows) {
    const slot = row.index % 5;
    if (slot === 0) {
      lines.push(JSON.stringify({ [String(row.index)]: { keepall: true } }));
    } else if (slot === 1) {
      lines.push(JSON.stringify({ [String(row.index)]: {
        keeplines: [[1, 1]], summary: 'None' } }));
    } else if (slot === 4) {
      lines.push(JSON.stringify({ [String(row.index)]: {
        keeplines: [[1, 2]], summary: 'stub out of range' } }));
    } else {
      lines.push(JSON.stringify({ [String(row.index)]: {
        forgetall: true, summary: `stub forgot result ${row.index}` } }));
    }
  }
  lines.push('[[entry-ask-end:stub]]');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function refuse(message) {
  console.error(`replay-opencode-asks: REFUSED — ${message}`);
  process.exit(2);
}

/** One 1-based line of a JSONL file, streamed so a 75 MB capture is not held. */
async function jsonLineAt(file, lineNumber, label) {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) throw new Error(`${label}: bad line ${lineNumber}`);
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let at = 0;
  try {
    for await (const line of rl) {
      at += 1;
      if (at !== lineNumber) continue;
      rl.close();
      stream.destroy();
      if (line.trim() === '') throw new Error(`${label}: line ${lineNumber} is blank`);
      try { return JSON.parse(line); } catch { throw new Error(`${label}: line ${lineNumber} is not JSON`); }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  throw new Error(`${label}: file has ${at} line(s), wanted ${lineNumber}`);
}

/** Every `ask-apply` unit id that names one of `wanted`, across a run's journals. */
function unitRecallIndex(runDir, wanted) {
  const index = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'journal.jsonl') scanJournal(full);
    }
  };
  const scanJournal = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('"kind":"ask-apply"')) continue;
      const unit = /"unitId":"([^"]+)"/.exec(line);
      if (unit === null || !wanted.has(unit[1]) || index.has(unit[1])) continue;
      const recall = /"recallId":"([^"]+)"/.exec(line);
      if (recall !== null) index.set(unit[1], recall[1]);
    }
  };
  walk(runDir);
  return index;
}

/** The mount's recorded storage root, re-rooted when the copy moved devices. */
function storageRootOf(mounted, root) {
  const recorded = typeof mounted?.storageRoot === 'string' ? mounted.storageRoot : '';
  if (recorded !== '' && fs.existsSync(recorded)) return recorded;
  const normalized = recorded.replace(/\\/g, '/');
  const at = normalized.indexOf('/scratchpad/launch/');
  if (at >= 0) {
    const mapped = path.join(REPO_ROOT, normalized.slice(at + 1));
    if (fs.existsSync(mapped)) return mapped;
  }
  // Fall back to the lane/segment copy, the shape every segment writes.
  return null;
}

function recallLengthsFor(db, recallIds) {
  const lengths = new Map();
  const statement = db.prepare('SELECT rp.source_sha256, rp.source_byte_length,'
    + ' (SELECT COUNT(*) FROM recall_parts p WHERE p.recall_id = rp.recall_id) AS parts'
    + ' FROM recall_parts rp WHERE rp.recall_id = ?');
  for (const id of recallIds) {
    const row = statement.get(id);
    if (row === undefined) continue;
    lengths.set(id, {
      sha256: String(row.source_sha256), bytes: Number(row.source_byte_length),
      parts: Number(row.parts),
    });
  }
  return lengths;
}

const blobPathOf = (sessionsRoot, sha256) =>
  path.join(sessionsRoot, 'blobs', 'sha256', sha256.slice(0, 2), sha256.slice(2));

/** One blob's text, read at most once per moment (`cache` is that moment's map). */
function blobTextOf(sessionsRoot, part, cache) {
  const file = blobPathOf(sessionsRoot, part.sha256);
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
  cache.set(file, text);
  return text;
}

/**
 * The decoded result text of the unit whose archive the journal names. This is
 * the identity key for a row whose unit was removed at some round: content
 * equality against the captured result, never a walk over captured order.
 */
function archivedTextOf(sessionsRoot, part, cache) {
  if (sessionsRoot === null || part === undefined) return null;
  const text = blobTextOf(sessionsRoot, part, cache);
  if (text === null) return null;
  try { return envelopeResultText(JSON.parse(text)); } catch { return null; }
}

function blobCheck(sessionsRoot, part, cache) {
  const file = blobPathOf(sessionsRoot, part.sha256);
  const text = cache === undefined ? null : blobTextOf(sessionsRoot, part, cache);
  if (text === null) {
    if (!fs.existsSync(file)) return { oneLine: false, sizeOk: false, detail: `blob absent: ${file}` };
    return { oneLine: false, sizeOk: false, detail: 'blob unreadable' };
  }
  const size = Buffer.byteLength(text, 'utf8');
  const newlines = (text.match(/\n/g) ?? []).length;
  return {
    oneLine: newlines === 0,
    sizeOk: size === part.bytes,
    detail: `${String(size)} B on disk, ${String(part.bytes)} B in the ledger,`
      + ` ${String(newlines)} newline(s), ${String(part.parts)} part(s)`,
  };
}

// ---------------------------------------------------------------------------
// One moment
// ---------------------------------------------------------------------------

/**
 * Every row's byte length, from the two sources this lane has: the ledger's
 * archived part (`recall_parts.source_byte_length`) when the run removed the
 * unit, else the captured unit's decoded result text — the fixed product's
 * `unitBytes` geometry. A row with neither keeps `unitBytes: null`, so it stays
 * visibly unknown instead of being priced at 0 B.
 */
export function sizeRows(rows, unitIds, archived) {
  return rows.map((row, at) => {
    const part = archived.get(unitIds[at]);
    if (part !== undefined) return { ...row, unitBytes: part.bytes, unitBytesSource: 'ledger' };
    if (Number.isSafeInteger(row.decodedBytes)) {
      return { ...row, unitBytes: row.decodedBytes, unitBytesSource: 'capture' };
    }
    return { ...row, unitBytes: null, unitBytesSource: null };
  });
}

export async function analyzeMoment(context, moment) {
  const gates = [];
  const gate = (name, ok, detail) => { gates.push({ name, ok: ok === true, detail }); };
  const fail = (message) => ({ moment, ok: false, gates, error: message });

  const { journalPath, capturePath, root } = context;
  let ask; let capture;
  try {
    ask = await jsonLineAt(journalPath, moment.journalLine, `${rowLabelOf(moment)} journal`);
    capture = await jsonLineAt(capturePath, moment.captureLine, `${rowLabelOf(moment)} capture`);
  } catch (error) {
    return fail(String(error?.message ?? error));
  }

  gate('journal-ask', ask.kind === 'ask', `kind ${String(ask.kind)}`);
  gate('capture-shape', capture.seq === moment.captureLine && capture.truncated === false
    && capture.bodyReadable !== false && capture.bodyBytes === capture.bodyRecordedBytes,
  `seq ${String(capture.seq)} truncated ${String(capture.truncated)}`
    + ` bytes ${String(capture.bodyRecordedBytes)}/${String(capture.bodyBytes)}`);
  gate('capture-session', capture.sessionID === ask.sessionId, `${String(capture.sessionID)}`);

  let body; let prompt;
  try { body = JSON.parse(capture.body); } catch (error) { return fail(`capture body: ${String(error?.message ?? error)}`); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  prompt = typeof last?.content === 'string' ? last.content
    : isRecord(last) ? JSON.stringify(last.content) : '';
  gate('capture-last-user', isRecord(last) && last.role === 'user', `role ${String(last?.role)}`);
  gate('prompt-sha256', sha(prompt) === ask.promptSha256, `${sha(prompt)} / journal ${String(ask.promptSha256)}`);
  gate('prompt-chars', prompt.length === ask.promptChars, `${String(prompt.length)} / journal ${String(ask.promptChars)}`);

  const missingMarks = TWO_OPTION_MARKS.filter((mark) => !prompt.includes(mark));
  gate('old-prompt-two-option', missingMarks.length === 0 && !prompt.includes('[[entry-ask-end:'),
    missingMarks.length === 0 ? 'keepall/forgetall contract' : `missing ${missingMarks.join(', ')}`);

  const parsedRows = parseAskRows(prompt);
  const tableLines = prompt.split('\n').filter((line) => ROW_START.test(line));
  const indices = parsedRows.map((row) => row.index);
  gate('row-count', parsedRows.length === ask.rowCount && parsedRows.length === ask.indices.length,
    `${String(parsedRows.length)} parsed / journal ${String(ask.rowCount)} / indices ${String(ask.indices.length)}`);
  gate('row-indices', indices.join(',') === ask.indices.join(',')
    && tableLines.length === parsedRows.length,
  `${indices.length} row line(s), ${tableLines.length} line(s) start like a row`);

  // The ledger comes first: the journal's `unitIds[i]` names the unit of the row
  // at position `i`, and that unit's archived envelope carries its decoded result
  // text — the identity key the match uses. Reading it first is what makes the
  // match an identity and not a walk over captured order.
  const unitIds = ask.unitIds;
  gate('unit-ids', Array.isArray(unitIds) && unitIds.length === ask.indices.length,
    `${String(unitIds?.length)} unit id(s)`);
  const recallIndex = context.recallIndexOf(ask.sessionId);
  const ledgerPath = context.ledgerPathOf(ask.sessionId);
  gate('ledger', ledgerPath !== null && fs.existsSync(ledgerPath), String(ledgerPath));
  const unitLength = new Map();
  const blobText = new Map();
  const archivedTexts = new Map();
  if (ledgerPath !== null && fs.existsSync(ledgerPath) && Array.isArray(unitIds)) {
    const wanted = new Map();
    for (let i = 0; i < ask.indices.length; i += 1) {
      const recallId = recallIndex.get(unitIds[i]);
      if (recallId !== undefined) wanted.set(unitIds[i], recallId);
    }
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const parts = recallLengthsFor(db, new Set(wanted.values()));
      for (const [unitId, recallId] of wanted) {
        const part = parts.get(recallId);
        if (part !== undefined) unitLength.set(unitId, { ...part, recallId });
      }
    } finally { db.close(); }
    const sessionsRoot = path.dirname(ledgerPath);
    for (let i = 0; i < ask.indices.length; i += 1) {
      const part = unitLength.get(unitIds[i]);
      const text = archivedTextOf(sessionsRoot, part, blobText);
      if (text !== null) archivedTexts.set(ask.indices[i], text);
    }
  }

  // The line count is the captured unit's decoded result text, the byte space
  // the fixed product geometry addresses. The match is by identity: the journal's
  // unit id -> its archived envelope -> its decoded text, verified by the row's
  // anchor quote and its call ordinal. A row that matches nothing, an anchor that
  // fits two different bodies, or an ordinal that contradicts the anchor stops
  // the moment instead of producing a count.
  const units = capturedUnits(body);
  const sized = assignRowLineCounts(parsedRows, units, archivedTexts);
  const rows = sized.rows;
  const unmatched = [...sized.missing, ...sized.ambiguous];
  const disagreeRows = sized.disagree.map((entry) => `${String(entry.index)}: ${entry.why}`);
  const archiveMatched = rows.filter((row) => row.matchedBy === 'archive').length;
  const anchorMatched = rows.filter((row) => row.matchedBy === 'anchor').length;
  const anchorVerified = rows.filter((row) => row.anchorVerified === true).length;
  const copies = rows.filter((row) => (row.contentCopies ?? 0) > 1).length;
  const identityOk = unmatched.length === 0 && sized.disagree.length === 0;
  gate('row-unit-match', identityOk,
    identityOk
      ? `${String(rows.length)} row(s) matched by identity: ${String(archiveMatched)} by the archived unit,`
        + ` ${String(anchorMatched)} by the anchor; ${String(anchorVerified)} anchor quote(s) verified;`
        + ` ${String(copies)} row(s) name one of several byte-identical copies`
      : `failed: ${[...sized.missing.map((row) => `${String(row)}: no unit`),
        ...sized.ambiguous.map((row) => `${String(row)}: the anchor fits two different bodies`),
        ...disagreeRows].join('; ')}`);
  if (!identityOk) {
    return fail(`the row to unit identity is not provable for`
      + ` ${[...unmatched.map((row) => String(row)), ...disagreeRows].join(', ')};`
      + ' L cannot be computed and is not faked');
  }
  gate('row-line-counts', rows.every((row) => Number.isSafeInteger(row.lineCount) && row.lineCount >= 1),
    `${rows.length} row(s): ${[...new Set(rows.map((row) => String(row.lineCount)))].join('/')} line(s)`);
  // Re-read each row's unit by an INDEPENDENT key — the matched unit's call id,
  // looked up in the capture again — and recompute its line count and its anchors
  // from that unit's own decoded text. A row whose count or quote came from
  // anything but its unit reddens this gate. The OLD recorded anchor is verified
  // too: it must still name the unit, which is what the identity match used.
  const unitByCallId = new Map(units.map((unit) => [unit.callId, unit]));
  const reread = [];
  for (const row of rows) {
    const unit = unitByCallId.get(row.unitCallId);
    if (unit === undefined) { reread.push(`${row.index}: call id not in the capture`); continue; }
    if (unit.lineCount !== row.lineCount) {
      reread.push(`${row.index}: ${String(unit.lineCount)} ≠ ${String(row.lineCount)}`);
    } else if (Buffer.byteLength(unit.text, 'utf8') !== row.decodedBytes) {
      reread.push(`${row.index}: byte length differs`);
    } else if (!anchorMatchesText(row.oldAnchorLines?.[0], unit.text)) {
      reread.push(`${row.index}: the recorded anchor does not name this unit`);
    } else {
      const expected = contentAnchorLines(unit.text);
      if (expected.length !== row.anchorLines.length
        || expected.some((anchor, at) => anchor !== row.anchorLines[at])) {
        reread.push(`${row.index}: the content anchor is not this unit's`);
      }
    }
  }
  const multiLineRows = rows.filter((row) => row.lineCount > 1).length;
  const matchedUnits = sized.matches.filter((at) => at >= 0).map((at) => units[at]);
  const multiLineUnits = matchedUnits.filter((unit) => unit.lineCount > 1).length;
  const anchorOverridden = rows.filter((row) => {
    const stated = /line \d+ of (\d+)/.exec(row.oldAnchorLines?.[0] ?? '');
    return stated !== null && Number(stated[1]) !== row.lineCount;
  }).length;
  gate('line-counts-from-unit', reread.length === 0,
    `${String(anchorOverridden)} of ${String(rows.length)} row(s) differ from the old anchor's`
      + ` stated count; every row quotes its own unit${reread.length === 0
        ? '' : `; wrong: ${reread.slice(0, 4).join(', ')}`}`);
  gate('row-multi-line', multiLineUnits === 0 || multiLineRows > 0,
    `${String(multiLineRows)} of ${String(rows.length)} row(s) multi-line;`
      + ` ${String(multiLineUnits)} matched unit(s) are multi-line`);

  const parsed = Array.isArray(ask.parsed) ? ask.parsed : [];
  gate('journal-parsed', parsed.length === ask.indices.length
    && parsed.every((row) => row.status === 'answered' || row.status === 'refused'),
  `${String(parsed.length)} parsed / ${String(ask.answered)} answered / ${String(ask.refused)} refused`);

  const verdicts = { forgetall: 0, keepall: 0, keeplines: 0, forgetlines: 0 };
  const byIndex = new Map(parsed.map((row) => [row.index, row]));
  for (const index of ask.indices) {
    const verdict = byIndex.get(index);
    if (verdict?.status === 'answered') verdicts[verdict.action] = (verdicts[verdict.action] ?? 0) + 1;
  }

  // Every forgetall unit must resolve to an archived part (already loaded).
  const forgetall = [];
  const unresolved = [];
  for (let i = 0; i < ask.indices.length; i += 1) {
    const verdict = byIndex.get(ask.indices[i]);
    if (verdict?.status === 'answered' && verdict.action === 'forgetall') {
      if (unitLength.has(unitIds[i])) forgetall.push({ index: ask.indices[i], unitId: unitIds[i] });
      else unresolved.push(ask.indices[i]);
    }
  }
  gate('old-removals-resolve', unresolved.length === 0
    && forgetall.length === verdicts.forgetall,
  `${String(forgetall.length)} forgetall / ${String(verdicts.forgetall)}; unresolved ${unresolved.join(',') || 'none'}`);

  const sessionsRoot = ledgerPath === null ? null : path.dirname(ledgerPath);
  let blobOk = true;
  let partOk = true;
  const blobBad = [];
  const partBad = [];
  if (sessionsRoot !== null) {
    for (const row of forgetall) {
      const check = blobCheck(sessionsRoot, unitLength.get(row.unitId), blobText);
      if (!check.oneLine) { blobOk = false; blobBad.push(`${row.index}: ${check.detail}`); }
      if (!check.sizeOk || unitLength.get(row.unitId).parts !== 1) {
        partOk = false;
        partBad.push(`${row.index}: ${check.detail}`);
      }
    }
  }
  gate('unit-blob-one-line', blobOk, blobBad.length === 0
    ? `${String(forgetall.length)} archived unit blob(s), no newline` : blobBad.join('; '));
  gate('unit-whole-part', partOk, partBad.length === 0
    ? `${String(forgetall.length)} recall(s), one part each, blob size equals the ledger`
    : partBad.join('; '));

  // A unit's byte length is the ledger's archived part when the run archived it
  // (every forgetall row). A unit the run KEPT has no archive row, so it is
  // sized from its captured decoded result text — the same `unitBytes` geometry
  // the line count reads. Only a row with neither source stays unknown.
  const sizedRows = sizeRows(rows, unitIds, unitLength);
  const unsized = sizedRows.filter((row) => row.unitBytes === null).map((row) => row.index);
  gate('unit-bytes-sourced', unsized.length === 0,
    `${String(sizedRows.filter((row) => row.unitBytesSource === 'ledger').length)} ledger`
      + ` / ${String(sizedRows.filter((row) => row.unitBytesSource === 'capture').length)} captured`
      + ` / ${String(unsized.length)} unsized${unsized.length === 0 ? '' : ` (${unsized.join(',')})`}`);

  const knownBytes = sizedRows.reduce((sum, row) => sum + (row.unitBytes ?? 0), 0);
  const oldBytes = forgetall.reduce((sum, row) => sum + unitLength.get(row.unitId).bytes, 0);
  // The same removed units in the OTHER byte space. `oldBytes` is the recorded
  // baseline: the ledger's archived envelope sizes. `wholeUnitBytesDecoded` is
  // the captured decoded result text of the same units — the space the fixed
  // geometry and every `keeplines` range address. Both are stated so a
  // comparison never silently mixes them.
  const forgetallIndexes = new Set(forgetall.map((row) => row.index));
  const wholeUnitBytesDecoded = sizedRows
    .filter((row) => forgetallIndexes.has(row.index) && Number.isSafeInteger(row.decodedBytes))
    .reduce((sum, row) => sum + row.decodedBytes, 0);
  const knownRows = sizedRows.filter((row) => row.unitBytes !== null);
  const unknownRows = sizedRows.length - knownRows.length;
  const unknownAllKeeps = sizedRows.every((row) => row.unitBytes !== null
    || byIndex.get(row.index)?.status !== 'answered' || byIndex.get(row.index).action === 'keepall');
  // The recorded answers under the corrected grammar: forgetall still removes,
  // a literal keepall is not offered and becomes a terminal keep. A partial keep
  // removes lines and counts as a removal unit, the dsh sibling's definition
  // (`forgetall + keeplines + forgetlines`); these recorded answers carry no
  // keeplines, so the count here is the same as before.
  const removalActions = new Set(['forgetall', 'keeplines', 'forgetlines']);
  const newUnits = knownRows.filter((row) => {
    const verdict = byIndex.get(row.index);
    return verdict?.status === 'answered' && removalActions.has(verdict.action);
  }).length;
  const newBytes = oldBytes;
  const deltaUnits = newUnits - forgetall.length;
  const deltaBytes = newBytes - oldBytes;
  // An identity, not a predictive check: this lane replays the RECORDED answers
  // under the corrected grammar, so it cannot predict an answer and the zero is
  // true by construction. The paid lane's draw is the predictive reading.
  gate('delta-identity', deltaUnits === 0 && deltaBytes === 0 && newBytes === oldBytes,
    `delta ${String(deltaUnits)} unit(s) / ${String(deltaBytes)} B by construction`
      + ' (identity, not a predictive check: the recorded answers are replayed)');

  const firstTrigger = ask.round === 1;
  const oldAsk = { bytes: Buffer.byteLength(prompt), sha256: sha(prompt) };
  let newAsk;
  try {
    newAsk = { text: correctedAsk(rows, firstTrigger) };
  } catch (error) {
    gate('corrected-ask', false, String(error?.message ?? error));
    return fail('corrected ask');
  }
  const corrected = correctedAskGate(rows, newAsk.text, firstTrigger, prompt);
  newAsk.bytes = corrected.bytes;
  newAsk.sha256 = corrected.sha256;
  gate('corrected-ask', corrected.ok, corrected.detail);

  const ok = gates.every((item) => item.ok);
  const rowState = sizedRows.map((row, at) => ({
    ...row,
    unitId: unitIds[at],
    verdict: byIndex.get(row.index)?.status === 'answered' ? byIndex.get(row.index).action : 'refused',
  }));
  return {
    moment, ok, gates, error: ok ? null : 'gates',
    round: ask.round, share: firstTrigger ? '70' : '40', firstTrigger,
    sessionId: ask.sessionId,
    rows: rows.length,
    multiLineRows,
    verdicts,
    oldUnits: forgetall.length,
    oldBytes,
    wholeUnitBytesDecoded,
    newUnits,
    newBytes,
    deltaUnits,
    deltaBytes,
    knownBytes,
    unknownUnits: unknownRows,
    unknownAllKeeps,
    oldAsk, newAsk,
    state: {
      sessionId: ask.sessionId,
      bodyBase: (() => { const base = { ...body }; delete base.messages; delete base.stream_options; return base; })(),
      seedMessages: messages.slice(0, -1),
      rows: rowState,
      corrected: newAsk.text,
      ledgerPath,
      root,
      journalPath,
      capturePath,
    },
  };
}

/** The mount record a journal opens with names the storage root it used. */
function mountedOf(journalPath) {
  try {
    const first = fs.readFileSync(journalPath, 'utf8').split('\n')[0];
    const record = JSON.parse(first);
    return record.kind === 'mounted' ? record : null;
  } catch { return null; }
}

/** Build the per-run lookup tables once: ask-apply recalls and the ledger file. */
async function runContext(root, run, moments) {
  const asks = [];
  for (const moment of moments) {
    const dir = path.join(root, run, moment.seg, 'test');
    asks.push({
      moment,
      journalPath: path.join(dir, 'journal.jsonl'),
      capturePath: path.join(dir, 'capture.jsonl'),
    });
  }
  const present = asks.filter((item) => fs.existsSync(item.journalPath) && fs.existsSync(item.capturePath));
  if (present.length === 0) throw new Error(`${run}: no journal/capture under ${path.join(root, run)}`);
  const wanted = new Set();
  const items = [];
  for (const item of present) {
    try {
      const ask = await jsonLineAt(item.journalPath, item.moment.journalLine, `${rowLabelOf(item.moment)} journal`);
      if (Array.isArray(ask.unitIds)) for (const id of ask.unitIds) wanted.add(id);
      if (typeof ask.sessionId === 'string') item.sessionId = ask.sessionId;
    } catch { /* analyzeMoment reports it */ }
    items.push(item);
  }
  const recallIndex = unitRecallIndex(path.join(root, run), wanted);
  const ledgerBySession = new Map();
  const sessionIds = new Set(items.map((item) => item.sessionId).filter((id) => typeof id === 'string'));
  for (const sessionId of sessionIds) {
    const withSession = items.find((item) => item.sessionId === sessionId);
    const storageRoot = storageRootOf(mountedOf(withSession.journalPath), root);
    const ledger = storageRoot === null ? null : path.join(storageRoot, 'sessions', sessionId, 'ledger.sqlite');
    ledgerBySession.set(sessionId, ledger !== null && fs.existsSync(ledger) ? ledger : null);
  }
  return {
    run,
    recallIndexOf: () => recallIndex,
    ledgerPathOf: (sessionId) => ledgerBySession.get(sessionId) ?? null,
    items,
  };
}

export async function computeOffline(root = DEFAULT_ROOT, moments = MOMENTS) {
  const results = [];
  const byRun = new Map();
  for (const moment of moments) {
    if (!byRun.has(moment.run)) byRun.set(moment.run, []);
    byRun.get(moment.run).push(moment);
  }
  const contexts = new Map();
  for (const [run, runMoments] of byRun) {
    try {
      contexts.set(run, await runContext(root, run, runMoments));
    } catch (error) {
      for (const moment of runMoments) {
        results.push({ moment, ok: false, gates: [{ name: 'inputs', ok: false, detail: String(error?.message ?? error) }],
          error: String(error?.message ?? error) });
      }
    }
  }
  for (const moment of moments) {
    const context = contexts.get(moment.run);
    if (context === undefined) continue;
    const item = context.items.find((candidate) => candidate.moment === moment);
    if (item === undefined) {
      results.push({ moment, ok: false, gates: [{ name: 'inputs', ok: false, detail: 'moment not in context' }],
        error: 'moment not in context' });
      continue;
    }
    try {
      results.push(await analyzeMoment({
        ...context, journalPath: item.journalPath, capturePath: item.capturePath,
      }, moment));
    } catch (error) {
      results.push({ moment, ok: false, gates: [{ name: 'computed', ok: false, detail: String(error?.message ?? error) }],
        error: String(error?.message ?? error) });
    }
  }
  return { root, results, ok: results.every((result) => result.ok) };
}

/**
 * The tokens one reply's usage is charged against the grant. `total_tokens` is
 * authoritative when present. Otherwise the sum of input and output (plus
 * reasoning when the row names it separately), because a length-trip reply can
 * carry a usage row without a total; charging 0 there would let the grant slip.
 */
const finiteCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function chargedTokensOf(usage) {
  if (!isRecord(usage)) return 0;
  if (finiteCount(usage.total_tokens)) return usage.total_tokens;
  // A camelCase key that is present but is not a count falls back to its snake
  // key. A legitimate 0 is a reading, so it is returned instead of falling
  // through to the alternate pair: `||` read 0 as absent and then booked a
  // second field's count.
  const pick = (...keys) => {
    for (const key of keys) if (finiteCount(usage[key])) return usage[key];
    return null;
  };
  const input = pick('promptTokens', 'prompt_tokens') ?? pick('inputTokens', 'input_tokens') ?? 0;
  const output = pick('completionTokens', 'completion_tokens') ?? pick('outputTokens', 'output_tokens') ?? 0;
  const reasoning = pick('reasoningTokens', 'reasoning_tokens') ?? 0;
  return input + output + reasoning;
}

/**
 * Charges one reply against the grant books. A reply that states no countable
 * usage — absent, or an empty object — is charged the 3.04 B/token estimate of
 * the request and answer and labelled `estimated`, mirroring the dsh lane, so a
 * silent usage field cannot let the grant run open. A `synthetic` reading books
 * to the synthetic total, anything else to the provider total.
 */
export function chargeOf(usage, text, bodyBytes, books) {
  const countable = isRecord(usage)
    && [usage.total_tokens, usage.prompt_tokens, usage.promptTokens,
      usage.completion_tokens, usage.completionTokens].some(finiteCount);
  if (!countable) {
    const estimated = {
      promptTokens: Math.ceil(bodyBytes / 3.04),
      completionTokens: Math.ceil(Buffer.byteLength(text) / 3.04),
      ruler: 'estimated',
    };
    const tokens = estimated.promptTokens + estimated.completionTokens;
    books.estimatedTokens += tokens;
    return { usage: estimated, ruler: 'estimated', tokens };
  }
  const tokens = chargedTokensOf(usage);
  const ruler = usage.ruler === 'synthetic' ? 'synthetic' : 'provider';
  if (ruler === 'synthetic') books.syntheticTokens += tokens;
  else books.providerTokens += tokens;
  return { usage, ruler, tokens };
}

// ---------------------------------------------------------------------------
// The send lane
// ---------------------------------------------------------------------------

export function assertAllGated(results) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return null;
  return failed.map((result) => rowLabelOf(result.moment)).join(', ');
}

function lineCountsOf(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.lineCount) || row.lineCount < 1) {
      throw new RangeError(`row ${String(row.index)} has no computed line count`);
    }
    counts.set(row.index, row.lineCount);
  }
  return counts;
}

function bodyOf(state, messages) {
  return { ...state.bodyBase, messages, stream: false };
}

function messagesOf(state, askText) {
  return [...state.seedMessages, { role: 'user', content: askText }];
}

/**
 * The dsh sibling's pre-send bound: the grant must cover everything already
 * booked PLUS the next prompt's own 3.04 B/token estimate, or the send is
 * stopped before it is made. Without it the last send can overrun the grant by
 * the whole prompt (the 2026-11-23 live draw ended 113,581 tokens over a
 * 3,000,000 grant).
 */
export function grantBlocksSend(spentTokens, bodyBytes, tokenGrant) {
  return spentTokens + Math.ceil(bodyBytes / 3.04) > tokenGrant;
}

/**
 * The bytes a partial `keeplines` drops, in the product's own range convention
 * (ADR-0044 amendment 2026-11-23; `packages/core/src/util/lines.ts`):
 *
 * - a unit's bytes are its DECODED RESULT TEXT — the same text `lineCount`
 *   reads, never a `{name,input,result}` envelope and never the ledger blob the
 *   pre-fix lane archived;
 * - `splitLineOffsets` gives every line the bytes up to and including its
 *   terminating `\n` (the last line has no trailing newline);
 * - `byteRangeForLines` maps a kept span to the contiguous slice of its lines,
 *   so the kept bytes are the kept lines' text PLUS their newlines;
 * - freed = the text's byte length minus the kept slices. Every dropped line
 *   therefore frees its own text and the newline that ended it, and no summary
 *   or framing byte is counted.
 *
 * A missing text or an unusable span frees nothing (the caller states why); the
 * product refuses such a span before this point, so this never hides a removal.
 */
export function partialKeepFreedBytes(unitText, keptSpans) {
  if (typeof unitText !== 'string' || !Array.isArray(keptSpans) || keptSpans.length === 0) return 0;
  const bytes = toBytes(unitText);
  let kept;
  try {
    kept = byteRangeForLines(bytes, keptSpans.map((span) => ({
      startLine: span.from, endLineInclusive: span.to })));
  } catch { return 0; }
  const keptBytes = kept.reduce((sum, range) => sum + (range.endByteExclusive - range.startByte), 0);
  return Math.max(0, bytes.byteLength - keptBytes);
}

/**
 * The rows whose own answer said `keeplines` over their whole `1..L`. The
 * shipped reader normalizes that shape to a clean `keepall` before it reports a
 * verdict, so without this marker a normalized whole-range keep is
 * indistinguishable from a model that answered `keepall` — an action this
 * grammar does not offer. Reporting only: it never changes a verdict, a count or
 * a byte, and a line it cannot read simply carries no marker.
 */
export function normalizedWholeRangeIndexes(answerText, counts) {
  const marked = new Set();
  if (typeof answerText !== 'string') return marked;
  for (const line of answerText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (!isRecord(parsed)) continue;
    for (const [key, value] of Object.entries(parsed)) {
      const index = Number(key);
      const lineCount = counts.get(index);
      if (!Number.isSafeInteger(index) || lineCount === undefined || !isRecord(value)) continue;
      for (const [action, payload] of Object.entries(value)) {
        if (action.toLowerCase().replace(/s$/u, '') !== 'keepline') continue;
        if (!Array.isArray(payload)) continue;
        const covered = new Set();
        for (const span of payload) {
          if (!Array.isArray(span) || span.length !== 2) continue;
          const [from, to] = span;
          if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
          for (let at = from; at <= to && at <= lineCount; at += 1) covered.add(at);
        }
        let whole = covered.size === lineCount;
        for (let at = 1; at <= lineCount && whole; at += 1) if (!covered.has(at)) whole = false;
        if (whole) marked.add(index);
      }
    }
  }
  return marked;
}

/**
 * The verdict and byte books for one reading.
 *
 * `newUnits` counts what the corrected answer REMOVES, and a partial
 * `keeplines` removes lines, so it is a removal unit: the count is
 * `forgetall + keeplines + forgetlines`, mirroring the dsh sibling
 * (`replay-depth-table.mjs`, `newUnits`). `newBytesFreed` is
 * `wholeUnitBytesFreed + partialLineBytesFreed`.
 *
 * TWO accounting readings, deliberately named apart:
 *
 * - `accountedOk` is an IDENTITY: `whole + partial + kept` is accumulated from
 *   the same per-row basis bytes as `knownBytes`, so it can only fail if the
 *   two accumulations disagree. It is printed as an identity, never as a gate.
 * - `pricedOk` is a CROSS-CHECK: every row is re-closed on its own
 *   (`basis = freed + kept`, in a `pricing[]` record built in the same pass),
 *   the per-row bases are summed INDEPENDENTLY of `knownBytes`, and both sums
 *   must equal the totals and each other. A row whose removal was counted but
 *   never priced reddens it.
 *
 * `partialLineOk` is true when every answered partial keep was priced (or none
 * was answered, which carries a reason) AND no priced partial freed 0 bytes
 * while the row's text was known — a zero there is a dropped line nobody
 * accounted for, so `partialZeroRows` is exposed beside it and false is the
 * verdict.
 */
export function verdictBytes(rows, reading) {
  const byIndex = new Map(reading.rows.map((row) => [row.index, row]));
  const verdicts = { forgetall: 0, keeplines: 0, keepall: 0, forgetlines: 0 };
  const refusals = {};
  let wholeUnitBytesFreed = 0;
  let partialLineBytesFreed = 0;
  let keptBytes = 0;
  let knownBytes = 0;
  let unknownLengthRows = 0;
  let decided = 0;
  let partialUnpricedRows = 0;
  let partialZeroRows = 0;
  const pricing = [];
  const unpriced = [];
  for (const row of rows) {
    const read = byIndex.get(row.index);
    const answered = read !== undefined && read.status === 'answered' ? read.answer.action : null;
    // A partial keep addresses the captured decoded text — the same bytes its
    // line count reads — so that row is accounted in THAT byte space, even when
    // the ledger holds an older archive of the pre-amendment envelope. Every
    // other row keeps its `unitBytes` (the ledger part for a recorded whole-unit
    // removal, else the captured decoded length).
    const basisBytes = answered === 'keeplines' && typeof row.unitText === 'string'
      ? Buffer.byteLength(row.unitText, 'utf8')
      : row.unitBytes;
    if (basisBytes === null) unknownLengthRows += 1; else knownBytes += basisBytes;
    let rowFreed = 0;
    let rowKept = 0;
    let rowKind = 'keep';
    if (basisBytes === null && answered !== null && answered !== 'keepall') {
      // An answered removal with no basis byte is not priced at all: it must not
      // disappear into a closed sum.
      unpriced.push(row.index);
    }
    if (answered === null) {
      const code = read?.code ?? 'missing-index';
      refusals[code] = (refusals[code] ?? 0) + 1;
      if (basisBytes !== null) rowKept = basisBytes;
    } else {
      decided += 1;
      const action = answered;
      verdicts[action] = (verdicts[action] ?? 0) + 1;
      if (basisBytes !== null) {
        if (action === 'forgetall') {
          rowFreed = basisBytes;
          rowKind = 'whole';
        } else if (action === 'keeplines') {
          // Priced only from the captured decoded text. A row without one keeps
          // the unit whole and is stated, never silently priced 0.
          if (typeof row.unitText !== 'string') {
            partialUnpricedRows += 1;
            rowKept = basisBytes;
          } else {
            const freed = partialKeepFreedBytes(row.unitText, read.answer.ranges);
            if (freed === 0) partialZeroRows += 1;
            rowFreed = freed;
            rowKept = basisBytes - freed;
            rowKind = 'partial';
          }
        } else {
          // `forgetlines` is unreachable here: the shipped reader refuses it
          // `action-not-in-grammar` before a verdict exists. Every other answered
          // action is a clean keep (`keepall`, or a normalized whole-range keep).
          rowKept = basisBytes;
        }
      }
    }
    if (basisBytes !== null) {
      if (rowKind === 'whole') wholeUnitBytesFreed += rowFreed;
      if (rowKind === 'partial') partialLineBytesFreed += rowFreed;
      keptBytes += rowKept;
      pricing.push({ index: row.index, basis: basisBytes, freed: rowFreed, kept: rowKept,
        closes: rowFreed + rowKept === basisBytes });
    }
  }
  const accountedBytes = wholeUnitBytesFreed + partialLineBytesFreed + keptBytes;
  const allUnitsOneLine = rows.every((row) => row.lineCount === 1);
  const multiLineUnits = rows.filter((row) => row.lineCount > 1).length;
  const zeroRowsClose = pricing.filter((entry) => entry.closes === false).map((entry) => entry.index);
  const pricedBasis = pricing.reduce((sum, entry) => sum + entry.basis, 0);
  const pricedFreed = pricing.reduce((sum, entry) => sum + entry.freed, 0);
  const pricedKept = pricing.reduce((sum, entry) => sum + entry.kept, 0);
  const unpricedRows = [...new Set([...unpriced, ...zeroRowsClose])].sort((a, b) => a - b);
  const pricedOk = unpricedRows.length === 0
    && pricedBasis === knownBytes
    && pricedFreed === wholeUnitBytesFreed + partialLineBytesFreed
    && pricedKept === keptBytes;
  const partialLineOk = verdicts.keeplines === 0
    || (partialUnpricedRows === 0 && partialZeroRows === 0);
  const partialLineZeroReason = verdicts.keeplines === 0
    ? (allUnitsOneLine
      ? 'no partial range was answered: every unit is one line, so a 1..1 keeplines is a clean keep'
        + ' and no other range fits'
      : verdicts.keepall > 0
        ? 'no partial range was answered: every keeplines was a whole-range keep normalized to keepall'
        : 'no partial range was answered: no keeplines verdict passed the reader'
          + ' (refused, missing or not offered)')
    : partialUnpricedRows > 0
      ? `${String(partialUnpricedRows)} answered partial keep(s) had no captured decoded text to price`
        + ' and are kept whole'
      : partialZeroRows > 0
        ? `${String(partialZeroRows)} answered partial keep(s) freed 0 B with their text known`
          + ' and are kept whole'
        : null;
  return { verdicts, refusals, decided, rows: rows.length, wholeUnitBytesFreed,
    partialLineBytesFreed, partialLineRows: verdicts.keeplines, partialLineOk,
    partialLineZeroReason, partialZeroRows, partialUnpricedRows, keptBytes, knownBytes,
    accountedBytes, accountedOk: accountedBytes === knownBytes,
    pricedOk, pricedBasis, pricedFreed, pricedKept, unpricedRows,
    unknownLengthRows, allUnitsOneLine, multiLineUnits,
    allRefused: decided === 0 && rows.length > 0 };
}

/**
 * The `DEEPSEEK_API_KEY` value inside the credentials file's `refs:` block. A
 * key-shaped line outside that block is a decoy and is ignored, and so is one
 * nested deeper than the block's own entries: only immediate children count.
 * Quoted values are unquoted; comments and blank lines are skipped.
 */
export function keyFromCredentials(text) {
  let inRefs = false;
  let refsIndent = -1;
  let childIndent = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/u)[0].length;
    const refs = raw.match(/^(\s*)refs:\s*$/u);
    if (refs !== null) { inRefs = true; refsIndent = refs[1].length; childIndent = null; continue; }
    if (!inRefs) continue;
    if (indent <= refsIndent) { inRefs = false; continue; }
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = raw.match(/^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/u);
    if (match === null) continue;
    const value = match[1].replace(/^["'](.*)["']$/u, '$1').trim();
    return value === '' ? null : value;
  }
  return null;
}

/**
 * Loads `DEEPSEEK_API_KEY` in-process. Never returns the file's other content and
 * never prints or exports the key. With an explicit `home` only that home is
 * read, so a decoy test can prove the selection; the default checks the running
 * home and both device homes.
 */
export function loadKey(home = null) {
  const candidates = home === null
    ? [path.join(os.homedir(), '.dsh', '.credentials.yaml'),
      'C:\\Users\\TZhen\\.dsh\\.credentials.yaml', 'C:\\Users\\TZ\\.dsh\\.credentials.yaml']
    : [path.join(home, '.dsh', '.credentials.yaml')];
  const seen = new Set();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!fs.existsSync(file)) continue;
    const key = keyFromCredentials(fs.readFileSync(file, 'utf8'));
    if (key !== null) return { key, source: file };
  }
  return { key: null, source: candidates[0] };
}

async function deepseekAnswer(body, key, deadlineMs) {
  const remain = deadlineMs - Date.now();
  if (remain < 5000) return { ok: false, error: `kill-timer budget too low (${String(remain)} ms)` };
  const started = Date.now();
  let response; let rawBody = '';
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(120000, remain)),
    });
    rawBody = await response.text();
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' ? 'transport deadline'
      : String(error?.message ?? error) };
  }
  const latencyMs = Date.now() - started;
  let json = null;
  try { json = JSON.parse(rawBody); } catch { /* kept verbatim below */ }
  if (!response.ok) return { ok: false, httpStatus: response.status, error: 'non-2xx', rawBody, latencyMs };
  const choice = json?.choices?.[0];
  const finish = choice?.finish_reason ?? null;
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const usage = isRecord(json?.usage) ? json.usage : null;
  if (finish === 'length' || finish === 'max-tokens') {
    return { ok: false, httpStatus: response.status, error: 'length-trip', usage, latencyMs, text };
  }
  return { ok: true, httpStatus: response.status, text, usage, latencyMs, finish };
}

function evidenceDir(options) {
  if (options.out !== undefined) return options.out;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(REPO_ROOT, 'scratchpad', 'launch', `${day}-replay-opencode-asks`);
}

function writeEvidence(options, name, payload) {
  const dir = evidenceDir(options);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  // Temp + rename: a kill mid-write leaves the previous record intact instead
  // of an empty evidence file (ISSUE-581).
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
  fs.renameSync(temp, file);
  return file;
}

/**
 * The aggregate over the records written so far, for the incremental file.
 *
 * A moment whose every row was refused produced no READING: its send succeeded,
 * but it removed nothing because nothing was decided, so summing it as a real
 * zero drags every total toward it. Such a record is `failedReading` and is kept
 * out of the scored sums (`scoredMoments`), named in `allRefusedMoments` and in
 * the caveat; its deltas are null, never 0.
 */
export function sendAggregate(records, providerTokens, syntheticTokens, stopReason, estimatedTokens = 0) {
  const failedReadings = records.filter((record) => record.failedReading === true);
  const scored = records.filter((record) => record.ok === true && record.failedReading !== true);
  const total = (list, field) => list.reduce((sum, record) => sum + (record[field] ?? 0), 0);
  const newUnits = total(scored, 'newUnits');
  const newBytes = total(scored, 'newBytes');
  const oldUnits = total(scored, 'oldUnits');
  const oldBytes = total(scored, 'oldBytes');
  const oldBytesDecoded = total(scored, 'oldBytesDecoded');
  const whole = total(scored, 'wholeUnitBytesFreed');
  const partial = total(scored, 'partialLineBytesFreed');
  const kept = total(scored, 'keptBytes');
  const failures = records.filter((record) => record.ok !== true).length;
  // A record names a zero-partial reason only when it had nothing partial to
  // price (or a partial freed 0 B); a fully priced record names none and adds
  // none here, so the aggregate never claims the lane skips partials.
  const reasons = [...new Set(scored
    .map((record) => record.partialLineZeroReason)
    .filter((reason) => typeof reason === 'string' && reason !== ''))];
  const coverageReasons = [
    ...(failures > 0 ? ['transport-failures'] : []),
    ...(failedReadings.length > 0 ? ['failed-readings'] : []),
    ...(stopReason !== null ? [`stopped-${stopReason}`] : []),
  ];
  const keepallSources = [...new Set(scored
    .map((record) => record.keepallSource)
    .filter((source) => typeof source === 'string' && source !== ''))];
  return {
    moments: records.length,
    sends: total(records, 'sends'),
    failures,
    failedReadings: failedReadings.length,
    allRefusedMoments: failedReadings.map((record) => record.moment),
    scored: scored.length,
    // The unit and byte sums cover the moments that produced a reading. A
    // failed transport or an all-refused moment makes them success-only; a stop
    // makes them cover only the attempted moments, which is a coverage limit too.
    successOnly: failures > 0 || failedReadings.length > 0,
    coverageLimited: coverageReasons.length > 0,
    coverageReasons,
    verdicts: scored.reduce((acc, record) => {
      for (const [action, count] of Object.entries(record.verdicts ?? {})) acc[action] = (acc[action] ?? 0) + count;
      return acc;
    }, {}),
    refusals: scored.reduce((acc, record) => {
      for (const [code, count] of Object.entries(record.refusals ?? {})) acc[code] = (acc[code] ?? 0) + count;
      return acc;
    }, {}),
    oldUnits, oldBytes, oldBytesDecoded, newUnits, newBytes,
    deltaUnits: newUnits - oldUnits,
    deltaBytes: newBytes - oldBytes,
    wholeUnitBytesFreed: whole,
    partialLineBytesFreed: partial,
    partialLineRows: total(scored, 'partialLineRows'),
    // With zero scored records the predicate is vacuously true, so it is null
    // (explicitly vacuous), never a pass: no moment produced a reading.
    partialLineOk: scored.length === 0 ? null : scored.every((record) => record.partialLineOk !== false),
    partialLineZeroReason: reasons.length === 0 ? null : reasons.join('; '),
    partialZeroRows: total(scored, 'partialZeroRows'),
    keptBytes: kept,
    knownBytes: total(scored, 'knownBytes'),
    accountedBytes: whole + partial + kept,
    accountedOk: whole + partial + kept === total(scored, 'knownBytes'),
    pricedOk: scored.every((record) => record.pricedOk === true),
    unpricedRows: scored.flatMap((record) => (record.unpricedRows ?? []).map((row) => `${record.moment} ${String(row)}`)),
    wholeKeeps: total(scored, 'wholeKeeps'),
    normalizedWholeKeeps: total(scored, 'normalizedWholeKeeps'),
    keepallSource: keepallSources.length === 0 ? null : keepallSources.join('+'),
    unknownLengthRows: total(scored, 'unknownLengthRows'),
    usageMissing: records.some((record) => record.usageMissing === true),
    providerTokens, syntheticTokens, estimatedTokens, stopReason,
  };
}

function sendPayload(corpus, transport, records, aggregate) {
  const stub = transport === 'stub';
  const base = stub
    ? 'a fixed synthetic answer lane: not a draw and not a counterfactual; it proves the send, read and accounting path only'
    : 'one draw per moment is a counterfactual, not an expected value; the aggregate is descriptive';
  return {
    issue: 'ISSUE-510',
    laneKind: stub ? 'stub' : 'draw',
    synthetic: stub,
    caveat: base
      + (aggregate.successOnly
        ? ' Unit and byte aggregates cover successful moments only (successOnly: true).' : '')
      + (aggregate.coverageLimited && !aggregate.successOnly
        ? ' The aggregate covers only attempted moments (coverageLimited: true).' : ''),
    transport,
    model: stub ? null : MODEL,
    base: stub ? null : BASE,
    root: corpus.root,
    note: 'each row\'s L is computed from its captured unit\'s decoded result text, never from the'
      + ' pre-ISSUE-511 old anchor, and the row is matched to that unit by identity (the journal\'s'
      + ' unit id -> its archive -> its decoded text), verified by the anchor quote; a partial'
      + ' keeplines is priced from the same decoded text: a dropped line frees its text plus its'
      + ' terminating newline, so newBytes = whole + partial. `oldBytes` is the recorded'
      + ' ledger-envelope baseline; `oldBytesDecoded` is the same units in the decoded-text space.'
      + ' A moment whose every row was refused is `failedReading` and is excluded from the scored sums.'
      + ' `accountedOk` is an identity; `pricedOk` is the per-row cross-check.',
    gates: corpus.results.map((result) => ({ moment: rowLabelOf(result.moment), ok: result.ok, gates: result.gates })),
    records, aggregate,
  };
}

async function sendLane(corpus, options) {
  const blocked = assertAllGated(corpus.results);
  if (blocked !== null) refuse(`offline gates failed for ${blocked}; nothing was sent`);
  const transport = options.transport;
  let key = null;
  if (transport === 'deepseek') {
    const loaded = loadKey();
    console.log(`[key] DEEPSEEK_API_KEY: ${loaded.key ? 'found' : 'not found'} in ${loaded.source}`);
    if (!loaded.key) refuse(`DEEPSEEK_API_KEY not found in ${loaded.source}; nothing was sent`);
    key = loaded.key;
  }

  const records = [];
  const books = { providerTokens: 0, syntheticTokens: 0, estimatedTokens: 0 };
  let stopReason = null;
  const evidenceName = `replay-opencode-asks-${transport}.json`;
  let file = null;
  const flush = () => {
    const aggregate = sendAggregate(records, books.providerTokens, books.syntheticTokens,
      stopReason, books.estimatedTokens);
    file = writeEvidence(options, evidenceName, sendPayload(corpus, transport, records, aggregate));
    return aggregate;
  };
  flush(); // the gate proof exists before the first send

  for (const result of corpus.results) {
    if (stopReason !== null) break;
    const state = result.state;
    const label = rowLabelOf(result.moment);
    const counts = lineCountsOf(state.rows);
    const indicesOf = (rows) => rows.map((row) => row.index);
    const body = bodyOf(state, messagesOf(state, state.corrected));
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));

    const askOnce = async () => {
      // The stub-only failure seam: a billed, truncated draw and a transport
      // failure, so both charge branches are reachable with no socket.
      if (transport === 'stub' && options.stubFail === 'length-trip') {
        return { ok: false, error: 'length-trip', text: '{"1":{"forget',
          usage: { promptTokens: 1000, completionTokens: 1, ruler: 'synthetic' } };
      }
      if (transport === 'stub' && options.stubFail === 'transport-error') {
        return { ok: false, error: 'non-2xx' };
      }
      if (transport === 'stub') {
        const text = stubAnswerText(state.rows);
        const synthetic = {
          promptTokens: Math.ceil(bodyBytes / 3.04),
          completionTokens: Math.ceil(Buffer.byteLength(text) / 3.04),
          ruler: 'synthetic',
        };
        return { ok: true, text, usage: synthetic };
      }
      if (grantBlocksSend(books.providerTokens + books.syntheticTokens + books.estimatedTokens,
        bodyBytes, options.tokenGrant)) {
        stopReason = 'grant';
        return { ok: false, stopped: true, error: 'token grant would be crossed by the next prompt' };
      }
      const answer = await deepseekAnswer(body, key, options.deadline);
      return answer;
    };

    const first = await askOnce();
    if (first.stopped === true) break;
    if (!first.ok) {
      // A failure keeps whatever usage the transport reported (a length-trip is
      // billed, so it charges the grant), but it is not a product result: its
      // deltas stay null. A failure that stated no usage charges nothing.
      const charged = first.usage === undefined || first.usage === null
        ? null : chargeOf(first.usage, first.text ?? '', bodyBytes, books);
      console.error(`[send] ${label} transport refused: ${first.error}; no retry`);
      records.push({
        moment: label, round: result.round, share: result.share, sends: 1, rows: state.rows.length,
        ok: false, failed: true, error: first.error,
        httpStatus: first.httpStatus ?? null, latencyMs: first.latencyMs ?? null,
        rawBody: typeof first.rawBody === 'string' ? first.rawBody.slice(0, 64 * 1024) : null,
        usage: first.usage ?? null,
        chargedTokens: charged?.tokens ?? 0,
        oldUnits: result.oldUnits, oldBytes: result.oldBytes,
        newUnits: null, newBytes: null, deltaUnits: null, deltaBytes: null,
      });
      flush();
      continue;
    }

    // A reply that states no countable usage — absent, or an empty object — is
    // charged the 3.04 B/token estimate and labelled `estimated`, so the grant
    // moves instead of standing still on a silent usage field.
    const charged = chargeOf(first.usage, first.text ?? '', bodyBytes, books);
    if (charged.ruler === 'estimated') {
      console.error(`[usage] ${label} reply states no countable usage; charged`
        + ` ${String(charged.tokens)} estimated token(s) at 3.04 B/token`);
    }

    const reading = readJsonl20NoKeepallAnswer(first.text, indicesOf(state.rows), counts);
    const final = verdictBytes(state.rows, reading);
    // A moment whose every row was refused is NOT a reading that removed nothing:
    // nothing was decided, so its 0 units / 0 B is an absent reading, not a null
    // result. It is labelled and kept out of every scored sum.
    const failedReading = final.allRefused === true;
    // A partial keep removes lines, so it is a removal unit and its dropped-line
    // bytes are freed bytes: `newUnits = forgetall + keeplines + forgetlines`
    // (the dsh sibling's count) and `newBytes = whole + partial`.
    const newUnits = failedReading
      ? null : final.verdicts.forgetall + final.verdicts.keeplines + final.verdicts.forgetlines;
    const newBytes = failedReading
      ? null : final.wholeUnitBytesFreed + final.partialLineBytesFreed;
    const normalizedWhole = normalizedWholeRangeIndexes(first.text, counts);
    const keepallRows = reading.rows.filter((row) => row.status === 'answered'
      && row.answer.action === 'keepall');
    const normalizedWholeKeeps = keepallRows.filter((row) => normalizedWhole.has(row.index)).length;
    const usageTotal = charged.tokens;
    const record = {
      moment: label, round: result.round, share: result.share, sends: 1, ok: true,
      failedReading,
      ...(failedReading
        ? { allRefused: true, failedReadingReason: 'every row was refused: nothing was decided' }
        : {}),
      verdicts: final.verdicts, refusals: final.refusals,
      decided: final.decided, rows: final.rows,
      oldUnits: result.oldUnits, oldBytes: result.oldBytes,
      oldBytesDecoded: result.wholeUnitBytesDecoded,
      newUnits, newBytes,
      deltaUnits: failedReading ? null : newUnits - result.oldUnits,
      deltaBytes: failedReading ? null : newBytes - result.oldBytes,
      wholeUnitBytesFreed: final.wholeUnitBytesFreed,
      partialLineBytesFreed: final.partialLineBytesFreed,
      partialLineRows: final.partialLineRows,
      partialLineOk: final.partialLineOk,
      partialLineZeroReason: final.partialLineZeroReason,
      partialZeroRows: final.partialZeroRows,
      keptBytes: final.keptBytes, knownBytes: final.knownBytes,
      accountedBytes: final.accountedBytes, accountedOk: final.accountedOk,
      pricedOk: final.pricedOk, unpricedRows: final.unpricedRows,
      wholeKeeps: keepallRows.length,
      normalizedWholeKeeps,
      keepallSource: keepallRows.length === 0
        ? null : (normalizedWholeKeeps === keepallRows.length ? 'normalized-keeplines' : 'mixed'),
      unknownLengthRows: final.unknownLengthRows,
      allUnitsOneLine: final.allUnitsOneLine, multiLineUnits: final.multiLineUnits,
      usageMissing: charged.ruler === 'estimated',
      usage: { ruler: charged.ruler, totalTokens: usageTotal, readings: [charged.usage] },
      firstContentSha256: sha(first.text),
      firstContent: first.text.slice(0, 256 * 1024),
    };
    records.push(record);
    flush();
    const codes = Object.entries(record.refusals).map(([code, count]) => `${code}:${String(count)}`).join(',');
    console.log(`[send] ${label} sends=1 decided=${String(record.decided)}/${String(record.rows)}`
      + ` forgetall=${String(record.verdicts.forgetall)} keeplines=${String(record.verdicts.keeplines)}`
      + ` keepall=${String(record.verdicts.keepall)}`
      + `${record.keepallSource === null ? '' : ` (${record.keepallSource})`}`
      + ` refused=${String(Object.values(record.refusals).reduce((a, b) => a + b, 0))}`
      + `${codes === '' ? '' : ` [${codes}]`}`
      + ` whole=${String(record.wholeUnitBytesFreed)}B partial=${String(record.partialLineBytesFreed)}B`
      + ` (${String(record.partialLineRows)} row(s), zero=${String(record.partialZeroRows)})`
      + ` kept=${String(record.keptBytes)}B`
      + ` unknownLen=${String(record.unknownLengthRows)}`
      + ` priced=${record.pricedOk ? 'OK' : 'MISMATCH'}`
      + (failedReading
        ? ' ALL-REFUSED (failedReading: excluded from the scored sums)'
        : ` delta=${String(record.deltaUnits)}u/${String(record.deltaBytes)}B`)
      + ` tokens=${String(usageTotal)} (${record.usage.ruler})`);
  }

  const aggregate = flush();
  console.log(`[aggregate] moments=${String(aggregate.moments)} scored=${String(aggregate.scored)}`
    + ` failures=${String(aggregate.failures)}`
    + ` failedReadings=${String(aggregate.failedReadings)}${aggregate.allRefusedMoments.length === 0
      ? '' : ` (${aggregate.allRefusedMoments.join(',')})`}`
    + ` sends=${String(aggregate.sends)}`
    + ` successOnly=${String(aggregate.successOnly)}`
    + `${aggregate.coverageLimited ? ` AGGREGATES-COVERAGE-LIMITED (${aggregate.coverageReasons.join('+')})` : ''}`
    + ` old=${String(aggregate.oldUnits)}u/${String(aggregate.oldBytes)}B ledger-envelope`
    + `/${String(aggregate.oldBytesDecoded)}B decoded`
    + ` new=${String(aggregate.newUnits)}u/${String(aggregate.newBytes)}B`
    + ` delta=${String(aggregate.deltaUnits)}u/${String(aggregate.deltaBytes)}B`
    + ` whole=${String(aggregate.wholeUnitBytesFreed)}B partial=${String(aggregate.partialLineBytesFreed)}B`
    + ` (${String(aggregate.partialLineRows)} row(s), zero=${String(aggregate.partialZeroRows)})`
    + ` partialOk=${aggregate.partialLineOk === null ? 'VACUOUS' : String(aggregate.partialLineOk)}`
    + ` keeps=${String(aggregate.wholeKeeps)} (${aggregate.keepallSource ?? 'none'},`
    + ` ${String(aggregate.normalizedWholeKeeps)} normalized)`
    + ` kept=${String(aggregate.keptBytes)}B unknownLen=${String(aggregate.unknownLengthRows)}`
    + ` accounted=${aggregate.accountedOk ? 'OK' : 'MISMATCH'} (identity)`
    + ` priced=${aggregate.pricedOk ? 'OK' : `MISMATCH(${aggregate.unpricedRows.join(',')})`}`
    + ` providerTokens=${String(books.providerTokens)} syntheticTokens=${String(books.syntheticTokens)}`
    + ` estimatedTokens=${String(books.estimatedTokens)}`
    + `${aggregate.stopReason === null ? '' : ` STOPPED-${aggregate.stopReason.toUpperCase()}`}`);
  console.log(`[evidence] ${file}`);
  return { records, aggregate, file };
}
// ---------------------------------------------------------------------------
// The recompute lane (--live): display only, over stored send-lane evidence
// ---------------------------------------------------------------------------

/** The one moment a stored record's label names, or null. */
function momentOfLabel(label) {
  return MOMENTS.find((moment) => rowLabelOf(moment) === label) ?? null;
}

/**
 * One stored record re-read and re-priced. `firstContent` is the model's own
 * answer, so nothing is re-drawn: the shipped reader sees the same text again
 * and `verdictBytes` prices the partial keeps the first send booked at 0 B.
 * A record whose stored text no longer hashes to its recorded sha256 is
 * refused: a truncated or edited file cannot be re-read honestly, and the
 * 256 KB record cap alone would make the reading silently partial.
 */
export function recomputeRecord(record, result) {
  const moment = String(record.moment);
  const stored = {
    ok: record.ok ?? null,
    newUnits: record.newUnits ?? null,
    newBytes: record.newBytes ?? null,
    wholeUnitBytesFreed: record.wholeUnitBytesFreed ?? null,
    partialLineBytesFreed: record.partialLineBytesFreed ?? null,
    partialLineRows: record.partialLineRows ?? null,
    partialLineOk: record.partialLineOk ?? null,
    keptBytes: record.keptBytes ?? null,
  };
  const base = { moment, round: record.round ?? null, share: record.share ?? null, sends: 0,
    ok: false, recomputed: true, stored };
  if (result === undefined || result.ok !== true) {
    return { ...base, error: 'the moment did not replay green offline; there is no row set to re-read' };
  }
  if (typeof record.firstContent !== 'string' || record.firstContent === '') {
    return { ...base, error: 'the stored record carries no firstContent' };
  }
  if (typeof record.firstContentSha256 === 'string'
    && sha(record.firstContent) !== record.firstContentSha256) {
    return { ...base, error: 'the stored firstContent does not hash to its recorded sha256'
      + ' (truncated or altered); not re-read' };
  }
  const rows = result.state.rows;
  const counts = lineCountsOf(rows);
  const reading = readJsonl20NoKeepallAnswer(record.firstContent,
    rows.map((row) => row.index), counts);
  const final = verdictBytes(rows, reading);
  const failedReading = final.allRefused === true;
  const newUnits = failedReading
    ? null : final.verdicts.forgetall + final.verdicts.keeplines + final.verdicts.forgetlines;
  const newBytes = failedReading
    ? null : final.wholeUnitBytesFreed + final.partialLineBytesFreed;
  const normalizedWhole = normalizedWholeRangeIndexes(record.firstContent, counts);
  const keepallRows = reading.rows.filter((row) => row.status === 'answered'
    && row.answer.action === 'keepall');
  const normalizedWholeKeeps = keepallRows.filter((row) => normalizedWhole.has(row.index)).length;
  return {
    ...base, ok: true,
    failedReading,
    ...(failedReading ? { allRefused: true,
      failedReadingReason: 'every row was refused: nothing was decided' } : {}),
    verdicts: final.verdicts, refusals: final.refusals, decided: final.decided, rows: final.rows,
    oldUnits: result.oldUnits, oldBytes: result.oldBytes,
    oldBytesDecoded: result.wholeUnitBytesDecoded,
    newUnits, newBytes,
    deltaUnits: failedReading ? null : newUnits - result.oldUnits,
    deltaBytes: failedReading ? null : newBytes - result.oldBytes,
    wholeUnitBytesFreed: final.wholeUnitBytesFreed,
    partialLineBytesFreed: final.partialLineBytesFreed,
    partialLineRows: final.partialLineRows,
    partialLineOk: final.partialLineOk,
    partialLineZeroReason: final.partialLineZeroReason,
    partialZeroRows: final.partialZeroRows,
    keptBytes: final.keptBytes, knownBytes: final.knownBytes,
    accountedBytes: final.accountedBytes, accountedOk: final.accountedOk,
    pricedOk: final.pricedOk, unpricedRows: final.unpricedRows,
    wholeKeeps: keepallRows.length,
    normalizedWholeKeeps,
    keepallSource: keepallRows.length === 0
      ? null : (normalizedWholeKeeps === keepallRows.length ? 'normalized-keeplines' : 'mixed'),
    unknownLengthRows: final.unknownLengthRows,
    allUnitsOneLine: final.allUnitsOneLine, multiLineUnits: final.multiLineUnits,
  };
}

/**
 * Recompute one stored evidence file. The moments' rows and units are rebuilt
 * offline (the same journal/capture proof the default lane runs), each stored
 * answer is read again by the shipped reader, and the pricing is redone.
 * Nothing is sent, no key is read, and the source file is not modified.
 */
export async function recomputeEvidence(root, file) {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(stored.records)) throw new Error(`${file}: no records array`);
  const moments = [];
  const seen = new Set();
  for (const record of stored.records) {
    const moment = momentOfLabel(String(record.moment));
    if (moment === null) {
      throw new Error(`${file}: record ${String(record.moment)} is not one of the ten moments`);
    }
    if (seen.has(moment)) continue;
    seen.add(moment);
    moments.push(moment);
  }
  const corpus = moments.length === 0 ? { results: [] } : await computeOffline(root, moments);
  const byLabel = new Map(corpus.results.map((result) => [rowLabelOf(result.moment), result]));
  const records = stored.records.map((record) => recomputeRecord(record,
    byLabel.get(String(record.moment))));
  const aggregate = sendAggregate(records, stored.aggregate?.providerTokens ?? 0,
    stored.aggregate?.syntheticTokens ?? 0, stored.aggregate?.stopReason ?? null,
    stored.aggregate?.estimatedTokens ?? 0);
  return { root, stored, records, aggregate };
}

/** The recomputed report written beside the evidence file. */
export function recomputePayload(file, recompute) {
  const { stored, records, aggregate } = recompute;
  return {
    issue: 'ISSUE-510',
    mode: 'live-recompute',
    laneKind: 'recompute',
    synthetic: false,
    source: file,
    root: recompute.root,
    caveat: 'display-only recompute over stored send-lane evidence: the answers were re-read,'
      + ' not re-drawn; no socket, no key, no send; the stored file is unchanged.'
      + ' A row set the stored answer refused entirely is a failedReading and is'
      + ' excluded from the aggregate (allRefusedMoments names it).',
    pricing: "a partial keeplines frees the dropped lines' decoded text plus the newline that ended"
      + ' each line (ADR-0044 amendment); newBytes = whole + partial and keptBytes is the kept span',
    storedAggregate: stored.aggregate ?? null,
    records, aggregate,
    differences: records.map((record) => ({
      moment: record.moment,
      recomputed: record.ok === true,
      failedReading: record.failedReading === true,
      storedUnits: record.stored.newUnits,
      storedBytes: record.stored.newBytes,
      newUnits: record.newUnits ?? null,
      newBytes: record.newBytes ?? null,
      partialLineBytesFreed: record.partialLineBytesFreed ?? null,
      changedUnits: record.ok === true && record.failedReading !== true
        && record.newUnits !== record.stored.newUnits,
      changedBytes: record.ok === true && record.failedReading !== true
        && record.newBytes !== record.stored.newBytes,
      error: record.error ?? null,
    })),
  };
}

function printRecompute(file, recompute, outFile) {
  const { stored, records, aggregate } = recompute;
  const before = stored.aggregate ?? {};
  console.log('replay-opencode-asks: LIVE RECOMPUTE — no socket, no key, no send');
  console.log(`[evidence] ${file}`);
  console.log(`[stored] old=${String(before.oldUnits)}u/${String(before.oldBytes)}B`
    + ` new=${String(before.newUnits)}u/${String(before.newBytes)}B`
    + ` whole=${String(before.wholeUnitBytesFreed)}B partial=${String(before.partialLineBytesFreed)}B`
    + ` kept=${String(before.keptBytes)}B partialOk=${String(before.partialLineOk)}`);
  for (const record of records) {
    if (record.ok !== true) {
      console.log(`[recomputed] ${record.moment} REFUSED — ${record.error}`);
      continue;
    }
    const changed = record.newUnits !== record.stored.newUnits
      || record.newBytes !== record.stored.newBytes;
    console.log(`[recomputed] ${record.moment} rows=${String(record.rows)}`
      + ` forgetall=${String(record.verdicts.forgetall)} keeplines=${String(record.verdicts.keeplines)}`
      + ` keepall=${String(record.verdicts.keepall)}`
      + ` refused=${String(Object.values(record.refusals).reduce((a, b) => a + b, 0))}`
      + ` whole=${String(record.wholeUnitBytesFreed)}B partial=${String(record.partialLineBytesFreed)}B`
      + ` (${String(record.partialLineRows)} row(s), zero=${String(record.partialZeroRows)})`
      + ` kept=${String(record.keptBytes)}B`
      + ` priced=${record.pricedOk ? 'OK' : 'MISMATCH'}`
      + (record.failedReading === true
        ? ' ALL-REFUSED (failedReading)'
        : ` new=${String(record.newUnits)}u/${String(record.newBytes)}B`
          + ` stored=${String(record.stored.newUnits)}u/${String(record.stored.newBytes)}B`
          + ` ${changed ? 'CHANGED' : 'same'}`));
  }
  console.log(`[live-aggregate] moments=${String(aggregate.moments)} scored=${String(aggregate.scored)}`
    + ` failedReadings=${String(aggregate.failedReadings)}`
    + `${aggregate.allRefusedMoments.length === 0 ? '' : ` (${aggregate.allRefusedMoments.join(',')})`}`
    + ` sends=0 old=${String(aggregate.oldUnits)}u/${String(aggregate.oldBytes)}B ledger-envelope`
    + `/${String(aggregate.oldBytesDecoded)}B decoded`
    + ` new=${String(aggregate.newUnits)}u/${String(aggregate.newBytes)}B`
    + ` delta=${String(aggregate.deltaUnits)}u/${String(aggregate.deltaBytes)}B`
    + ` whole=${String(aggregate.wholeUnitBytesFreed)}B partial=${String(aggregate.partialLineBytesFreed)}B`
    + ` (${String(aggregate.partialLineRows)} row(s), zero=${String(aggregate.partialZeroRows)})`
    + ` kept=${String(aggregate.keptBytes)}B known=${String(aggregate.knownBytes)}B`
    + ` partialOk=${aggregate.partialLineOk === null ? 'VACUOUS' : String(aggregate.partialLineOk)}`
    + ` accounted=${aggregate.accountedOk ? 'OK' : 'MISMATCH'} (identity)`
    + ` priced=${aggregate.pricedOk ? 'OK' : `MISMATCH(${aggregate.unpricedRows.join(',')})`}`
    + `${aggregate.failures > 0 ? ` failures=${String(aggregate.failures)}` : ''}`);
  console.log(`[recomputed-evidence] ${outFile}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SEND_OPTIONS = optionsOf([
  ['--root', 'string'],
  ['--transport', 'string'],
  ['--i-am-the-owner', 'boolean', 'iAmTheOwner'],
  ['--token-grant', 'string', 'tokenGrant'],
  ['--kill-ms', 'string', 'killMs'],
  ['--stub-fail', 'string', 'stubFail'],
  ['--out', 'string'],
  ['--live', 'string'],
]);

function offlinePayload(corpus) {
  const moments = corpus.results.map((result) => ({
    moment: rowLabelOf(result.moment),
    run: result.moment.run,
    seg: result.moment.seg,
    journalLine: result.moment.journalLine,
    captureLine: result.moment.captureLine,
    ok: result.ok,
    error: result.error ?? null,
    round: result.round, share: result.share,
    rows: result.rows, multiLineRows: result.multiLineRows,
    verdicts: result.verdicts,
    oldUnits: result.oldUnits, oldBytes: result.oldBytes,
    newUnits: result.newUnits, newBytes: result.newBytes,
    deltaUnits: result.deltaUnits, deltaBytes: result.deltaBytes,
    knownBytes: result.knownBytes,
    wholeUnitBytesDecoded: result.wholeUnitBytesDecoded,
    unknownUnits: result.unknownUnits, unknownAllKeeps: result.unknownAllKeeps,
    oldAsk: result.oldAsk, newAsk: result.newAsk,
    gates: result.gates,
  }));
  return {
    issue: 'ISSUE-510',
    mode: 'offline',
    laneKind: 'offline',
    synthetic: false,
    root: corpus.root,
    caveat: 'the corrected ask is a prompt change: the old prompt was the two-option keepall/forgetall message (ISSUE-509)',
    note: 'newUnits/newBytes replay the recorded answers under the corrected grammar; a literal keepall becomes a terminal keep, so the delta is zero',
    totals: {
      moments: moments.length,
      rows: moments.reduce((sum, m) => sum + (m.rows ?? 0), 0),
      multiLineRows: moments.reduce((sum, m) => sum + (m.multiLineRows ?? 0), 0),
      oldUnits: moments.reduce((sum, m) => sum + (m.oldUnits ?? 0), 0),
      oldBytes: moments.reduce((sum, m) => sum + (m.oldBytes ?? 0), 0),
      oldBytesDecoded: moments.reduce((sum, m) => sum + (m.wholeUnitBytesDecoded ?? 0), 0),
      newUnits: moments.reduce((sum, m) => sum + (m.newUnits ?? 0), 0),
      newBytes: moments.reduce((sum, m) => sum + (m.newBytes ?? 0), 0),
      deltaUnits: moments.reduce((sum, m) => sum + (m.deltaUnits ?? 0), 0),
      deltaBytes: moments.reduce((sum, m) => sum + (m.deltaBytes ?? 0), 0),
      unknownUnits: moments.reduce((sum, m) => sum + (m.unknownUnits ?? 0), 0),
      unknownAllKeeps: moments.every((m) => m.unknownAllKeeps !== false),
      newAskBytes: moments.reduce((sum, m) => sum + (m.newAsk?.bytes ?? 0), 0),
    },
    moments,
  };
}

function printOffline(corpus) {
  console.log('replay-opencode-asks: OFFLINE — no socket, no key');
  console.log(`[root] ${corpus.root}`);
  for (const result of corpus.results) {
    const label = rowLabelOf(result.moment);
    const failed = result.gates.filter((item) => !item.ok).length;
    console.log(`[moment] ${label} cap=${String(result.moment.captureLine)} round=${String(result.round)}`
      + ` share=${String(result.share)}% rows=${String(result.rows)}`
      + ` multi=${String(result.multiLineRows ?? '-')}`
      + ` oldUnits=${String(result.oldUnits)} oldBytes=${String(result.oldBytes)}`
      + ` oldAsk=${String(result.oldAsk?.bytes)}B/${String(result.oldAsk?.sha256?.slice(0, 12))}`
      + ` newAsk=${String(result.newAsk?.bytes)}B/${String(result.newAsk?.sha256?.slice(0, 12))}`);
    console.log(`[gates] ${label} ${result.gates.map((item) => `${item.name}=${item.ok ? 'PASS' : 'FAIL'}`).join(' ')}`);
    for (const item of result.gates.filter((entry) => !entry.ok)) {
      console.log(`[gate-detail] ${label} ${item.name}: ${item.detail}`);
    }
    if (failed === 0 && result.rows !== undefined) {
      const unknown = result.unknownUnits === 0 ? '' : ` (${String(result.unknownUnits)} keep row(s) have no archived length)`;
      console.log(`[account] ${label} old ${String(result.oldUnits)} unit(s) /`
        + ` ${String(result.oldBytes)} B ledger-envelope / ${String(result.wholeUnitBytesDecoded)} B decoded`
        + ` -> new ${String(result.newUnits)} / ${String(result.newBytes)} B`
        + ` (delta ${String(result.deltaUnits)} / ${String(result.deltaBytes)} B)${unknown}`);
    }
  }
  const payload = offlinePayload(corpus);
  console.log('');
  console.log('| run/seg | journal | capture | round | share | rows | forget | keep | old u | old B | new u | new B | delta u | delta B | old ask B | old sha | new ask B | new sha | gates |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |');
  for (const result of corpus.results) {
    const failed = result.gates.filter((item) => !item.ok).length;
    console.log(`| ${result.moment.run}/${result.moment.seg} | ${String(result.moment.journalLine)}`
      + ` | ${String(result.moment.captureLine)} | ${String(result.round)} | ${String(result.share)}%`
      + ` | ${String(result.rows)} | ${String(result.verdicts?.forgetall)} | ${String(result.verdicts?.keepall)}`
      + ` | ${String(result.oldUnits)} | ${String(result.oldBytes)}`
      + ` | ${String(result.newUnits)} | ${String(result.newBytes)}`
      + ` | ${String(result.deltaUnits)} | ${String(result.deltaBytes)}`
      + ` | ${String(result.oldAsk?.bytes)} | ${result.oldAsk?.sha256 ?? '-'}`
      + ` | ${String(result.newAsk?.bytes)} | ${result.newAsk?.sha256 ?? '-'}`
      + ` | ${failed === 0 ? 'PASS' : `FAIL(${String(failed)})`} |`);
  }
  console.log('');
  console.log(`[aggregate] ${String(payload.totals.moments)} moment(s), ${String(payload.totals.rows)} rows,`
    + ` ${String(payload.totals.multiLineRows)} multi-line row(s),`
    + ` old removals ${String(payload.totals.oldUnits)} unit(s) /`
    + ` ${String(payload.totals.oldBytes)} B ledger-envelope /`
    + ` ${String(payload.totals.oldBytesDecoded)} B decoded text,`
    + ` new ${String(payload.totals.newUnits)} / ${String(payload.totals.newBytes)} B,`
    + ` delta ${String(payload.totals.deltaUnits)} / ${String(payload.totals.deltaBytes)} B,`
    + ` unknownUnits ${String(payload.totals.unknownUnits)} (all keeps: ${String(payload.totals.unknownAllKeeps)}),`
    + ` corrected ask ${String(payload.totals.newAskBytes)} B total`);
  console.log('[space] oldBytes and the recorded baseline are ledger-envelope bytes;'
    + ' wholeUnitBytesDecoded, every row L, every keeplines range and the partial pricing are'
    + ' decoded-text bytes. A delta across the two spaces is stated, never mixed silently.');
  console.log(corpus.ok
    ? `replay-opencode-asks: PASS — ${String(corpus.results.length)} moments, every gate green`
    : `replay-opencode-asks: FAIL — ${String(corpus.results.filter((result) => !result.ok).length)} moment(s) have a failed gate; no send is allowed`);
}

async function main() {
  const { values } = parseDevArgs(process.argv.slice(2), {
    options: SEND_OPTIONS,
    refuse: (message) => refuse(message),
    prefix: 'replay-opencode-asks: ',
  });
  const root = path.resolve(REPO_ROOT, String(values.root ?? DEFAULT_ROOT));
  const transport = values.transport === undefined ? null : String(values.transport);
  const live = values.live === undefined ? null : String(values.live);
  if (live !== null) {
    if (transport !== null) refuse('--live reads stored evidence; it takes no --transport');
    if (values.iAmTheOwner === true || values.tokenGrant !== undefined || values.killMs !== undefined) {
      refuse('--live is display-only: no owner flag, token grant or kill timer applies');
    }
    const files = live.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (files.length === 0) refuse('--live needs at least one evidence file');
    let allOk = true;
    for (const item of files) {
      const file = path.resolve(REPO_ROOT, item);
      if (!fs.existsSync(file)) refuse(`--live: evidence file absent: ${file}`);
      const recompute = await recomputeEvidence(root, file);
      const outFile = path.join(path.dirname(file),
        `${path.basename(file).replace(/\.json$/u, '')}-recomputed.json`);
      if (path.resolve(outFile) === path.resolve(file)) {
        refuse(`--live: refusing to overwrite the evidence file ${file}`);
      }
      const payload = recomputePayload(file, recompute);
      fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
      printRecompute(file, recompute, outFile);
      if (recompute.records.some((record) => record.ok !== true)
        || recompute.aggregate.accountedOk !== true
        || recompute.aggregate.pricedOk !== true) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  }
  if (transport !== null && transport !== 'stub' && transport !== 'deepseek') {
    refuse(`--transport must be stub or deepseek; got ${transport}`);
  }
  if (transport !== null && values.iAmTheOwner !== true) {
    refuse('the send lane needs --i-am-the-owner; nothing was sent');
  }
  const stubFail = values.stubFail === undefined ? null : String(values.stubFail);
  if (stubFail !== null) {
    if (transport !== 'stub') refuse('--stub-fail is a stub-only test seam');
    if (stubFail !== 'length-trip' && stubFail !== 'transport-error') {
      refuse(`--stub-fail must be length-trip or transport-error; got ${stubFail}`);
    }
  }
  let deadline = null;
  if (transport !== null) {
    const grant = Number(values.tokenGrant);
    const killMs = Number(values.killMs);
    if (!Number.isSafeInteger(grant) || grant <= 0) refuse('the send lane needs a positive --token-grant');
    if (!Number.isSafeInteger(killMs) || killMs <= 0) refuse('the send lane needs a positive --kill-ms');
    const tooLongKill = timerDelayRefusal(killMs, '--kill-ms');
    if (tooLongKill !== null) refuse(tooLongKill);
    values.tokenGrantValue = grant;
    values.killMsValue = killMs;
    // Armed before the first read, so the whole offline proof and the send are
    // inside the same budget.
    deadline = Date.now() + killMs;
    const killTimer = setTimeout(() => {
      console.error(`FATAL kill timer fired (${String(killMs)} ms); exiting 124`);
      process.exit(124);
    }, killMs);
    killTimer.unref?.();
  }
  const out = values.out === undefined ? undefined : path.resolve(REPO_ROOT, String(values.out));

  const corpus = await computeOffline(root);
  if (transport === null) {
    printOffline(corpus);
    const file = writeEvidence({ out }, 'replay-opencode-asks-offline.json', offlinePayload(corpus));
    console.log(`[evidence] ${file}`);
    process.exit(corpus.ok ? 0 : 1);
  }
  if (!corpus.ok) {
    printOffline(corpus);
    refuse('offline gates failed; the send lane sent nothing');
  }
  const sent = await sendLane(corpus, {
    transport,
    tokenGrant: values.tokenGrantValue,
    killMs: values.killMsValue,
    stubFail,
    deadline,
    out,
  });
  process.exit(sent.aggregate.failures > 0 || sent.aggregate.stopReason !== null ? 1 : 0);
}

const invoked = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(`replay-opencode-asks: FAILED — ${error?.message ?? error}`);
    process.exit(1);
  });
}
