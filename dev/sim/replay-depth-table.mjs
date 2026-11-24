#!/usr/bin/env node
/**
 * Replay the dsh depth table's ask moments under the corrected prompt (ISSUE-510).
 *
 * THE MOMENTS. Fifteen `prune-threshold` -> `prune-plan` pairs, located by line
 * number in three final-shape live runs under
 * `scratchpad/launch/2026-11-18-leak-safe-110/`. Line numbers are 1-based lines
 * of each run's `evidence/racoons/cremator-events.jsonl`.
 *
 * THE OFFLINE GATE (default). Read the journal, the session log and the ledger
 * and prove the rebuild against what the run recorded:
 *
 *   1. the surface is the seq fold of `surfaceOp` appends and in-place
 *      `replace` spans; a compaction summary's `shadowedSeqs` are dropped at the
 *      checkpoint replace that names its `compactionId`, never at an unrelated
 *      replace;
 *   2. the seed wire (main's last dispatched request, text-projected exactly as
 *      `captureMainRequest` projects it) hashes to `prune-seed.seedHash`, and its
 *      message/tool/dropped-block counts equal the journal's;
 *   3. `UnitTracker` (512-byte floor) + `planPrunePass` reproduce the journal's
 *      `units`, `askRows`, `tables` and `askTableTokens`.
 *
 * THE BASELINE. The same read yields what the recorded run removed: the round's
 * `prune-verdict` count from the journal and the removed bytes from the ledger's
 * `application_removals` + `removed_spans` rows for that round (read-only,
 * `node:sqlite`). The report states that baseline beside the corrected table's
 * units and bytes at stake, with the delta. The ledger supplies the baseline
 * only; it never enters the seed or plan rebuild.
 *
 * THE FAILED BASELINES. Three recorded moments are FAILED RECORDINGS, not real
 * zeros: `racoons-n1-correct` r23, `racoons-n2-correct` r12 and
 * `racoons-n3-correct-3` r17. Every table attempt refused every row
 * `answer-unreadable`, every `l2RemovalCount` is zero and the apply was skipped
 * `no-removals`. Their raw 0/0 is kept for display, marked `recordedFailed:
 * true` / `recordedComparable: false`, and they are excluded from the
 * `COMPARABLE-n` aggregate; the ALL aggregate keeps them. The classification
 * lives in `classifyRecordedBaseline` and is gated on every moment, so a failed
 * baseline can never pass silently as a real zero. `--live <file[,file]>`
 * folds recorded send-lane evidence into a display-only live aggregate printed
 * beside the offline one; it opens no socket and enters no gate.
 *
 * A failing gate is a REFUSAL: no request may follow it. The offline mode exits
 * 0 only when every gate of every moment passes; 1 otherwise.
 *
 * THE ASKS. `legacyBulkAsk` is the pre-ISSUE-508 bulk table ask (fork frame +
 * `nokeepall` contract + table + closing line). It is the bytes the runs sent:
 * verified byte-equal to the frozen rig build's `tableAsk` for the first moment
 * while this file was written. `correctedAsk` is `entryBatchAskMessage(rows,
 * "jsonl-20-nokeepall", firstTrigger)` — 70 percent for a session's first table
 * ask (round 1 here), 40 percent for every later one.
 *
 * THE SEND LANE (`--transport stub|deepseek`, `--i-am-the-owner`). ONE request
 * per moment (ISSUE-510): seed messages + the run's 18 tools + the corrected
 * ask. A refused row is a recorded result, never re-asked. `stub` answers from a
 * fixed rule so this path is testable with no socket; `deepseek` reads
 * `DEEPSEEK_API_KEY` in-process from `~/.dsh/.credentials.yaml` (C:\Users\TZhen\
 * or C:\Users\TZ\), never prints or exports it, and requires `--token-grant` and
 * `--kill-ms`. The kill timer arms before any input is read; the send lane
 * re-checks EVERY offline gate first and refuses to send when any fails.
 *
 * This file makes no paid call by default. Evidence (send lane only) goes under
 * `scratchpad/launch/<yyyy-mm-dd>-replay-depth-table/` and is never committed.
 *
 * Build first: `npm run build -w @cremator/core && npm run build -w cremator-dsh`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG, EpisodeTracker, UnitTracker, byteRangeForLines, entryBatchAskMessage,
  estimatePassTokens, isRefusedPruneAnchor, planPrunePass, pruneAskFinalLineOf,
  pruneAskSystemPromptOf, readJsonl20NoKeepallAnswer, renderPruneAskTable, sha256Sync,
  wireRequestHash,
} from '@cremator/core';
import { BULK_CODE_OF, callFactsOf, toCoreTranscript } from 'cremator-dsh';
import { surfaceTranscript } from 'cremator-dsh/plugin';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'scratchpad', 'launch', '2026-11-18-leak-safe-110');
const MODEL = 'deepseek-flash';
const BASE = 'https://api.deepseek.com/v1';
const BULK_GRAMMAR = 'nokeepall';

/** The pre-ISSUE-508 table-ask frame, byte for byte (adapter `ASK_FRAME`). */
export const LEGACY_FORK_FRAME = "The messages above are main's production conversation, carried over in main's "
  + "order, followed by this pass's earlier exchanges. This message is this pass's instruction: "
  + "the contract, a table with one row per unit, and one closing line. Treat all of it as "
  + "instruction, not as content to review.";

/**
 * The fifteen moments. `crossLine` is the `prune-threshold` crossing and
 * `planLine` the `prune-plan` line that follows it in the journal. Round 1 is
 * each run's first table ask; every later round states 40 percent.
 */
export const MOMENTS = Object.freeze([
  { run: 'racoons-n1-correct', round: 1, crossLine: 253, planLine: 254 },
  { run: 'racoons-n1-correct', round: 10, crossLine: 1473, planLine: 1474 },
  { run: 'racoons-n1-correct', round: 16, crossLine: 4058, planLine: 4059 },
  { run: 'racoons-n1-correct', round: 18, crossLine: 4577, planLine: 4578 },
  { run: 'racoons-n1-correct', round: 23, crossLine: 5231, planLine: 5232 },
  { run: 'racoons-n2-correct', round: 1, crossLine: 375, planLine: 376 },
  { run: 'racoons-n2-correct', round: 7, crossLine: 1504, planLine: 1505 },
  { run: 'racoons-n2-correct', round: 8, crossLine: 1900, planLine: 1901 },
  { run: 'racoons-n2-correct', round: 12, crossLine: 3784, planLine: 3785 },
  { run: 'racoons-n3-correct-3', round: 1, crossLine: 435, planLine: 436 },
  { run: 'racoons-n3-correct-3', round: 8, crossLine: 1444, planLine: 1445 },
  { run: 'racoons-n3-correct-3', round: 14, crossLine: 4647, planLine: 4648 },
  { run: 'racoons-n3-correct-3', round: 17, crossLine: 5435, planLine: 5436 },
  { run: 'racoons-n3-correct-3', round: 18, crossLine: 5899, planLine: 5900 },
  { run: 'racoons-n3-correct-3', round: 21, crossLine: 7290, planLine: 7291 },
]);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const utf8 = (text) => Buffer.from(text, 'utf8');
const sha256 = (text) => sha256Sync(utf8(text));
const bytesOfNode = (node) => node.bytes ?? new Uint8Array();

/**
 * Rebuild the model-visible surface from a session log. A row with no
 * `surfaceOp` is not on the surface; `append` pushes its seq; a `replace` swaps
 * the named current span for the new seq IN PLACE. A `compaction/summary` row's
 * `shadowedSeqs` belong to ONE compaction: they are dropped only at the
 * checkpoint replace whose `data.source` names that `compactionId`, never at an
 * unrelated replace. A summary whose checkpoint never arrives leaves its seqs
 * alone and is counted in `unappliedShadows` (a gate names it).
 */
export function foldSurface(sessionRows, cut = Number.POSITIVE_INFINITY) {
  const surface = [];
  const pending = new Map();
  let gaps = 0;
  for (const row of sessionRows) {
    if (row.seq === undefined || row.seq > cut) continue;
    const op = row.surfaceOp;
    if (op === undefined) {
      if (row.type === 'compaction/summary' && Array.isArray(row.data?.shadowedSeqs)) {
        pending.set(String(row.data?.compactionId ?? ''), row.data.shadowedSeqs);
      }
      continue;
    }
    if (op === 'append') { surface.push(row.seq); continue; }
    if (isRecord(op) && op.op === 'replace') {
      const at = surface.indexOf(op.startSeq);
      const end = surface.indexOf(op.endSeq);
      if (at < 0 || end < at) { gaps += 1; continue; }
      surface.splice(at, end - at + 1, row.seq);
      const source = row.data?.source;
      const owner = isRecord(source) && source.kind === 'compact-checkpoint'
        ? String(source.compactionId ?? '') : null;
      if (owner !== null && pending.has(owner)) {
        const drop = new Set(pending.get(owner));
        for (let i = surface.length - 1; i >= 0; i -= 1) {
          if (drop.has(surface[i])) surface.splice(i, 1);
        }
        pending.delete(owner);
      }
    }
  }
  const unappliedShadows = [...pending.values()].reduce((sum, seqs) => sum + seqs.length, 0);
  return { surface, gaps, unappliedShadows };
}

/**
 * One message's seed text, block by block, counting what the fork cannot carry
 * (`captureMainRequest`'s rule, restated here because it is a projection, not a
 * shipped function).
 */
export function messageTextOf(content) {
  if (!Array.isArray(content)) return { text: '', dropped: 0 };
  const parts = [];
  let dropped = 0;
  for (const block of content) {
    if (!isRecord(block)) { dropped += 1; continue; }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const raw = block.arguments;
      let args;
      if (typeof raw === 'string') args = raw;
      else if (raw === undefined) args = '';
      else { try { args = JSON.stringify(raw); } catch { args = undefined; } }
      if (args === undefined) { dropped += 1; continue; }
      parts.push(`[tool call ${name} ${args}]`);
      continue;
    }
    dropped += 1;
  }
  return { text: parts.join(''), dropped };
}

const SEED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Main's seed wire from a surface: `{system: '', tools, messages}`. */
export function seedWireOf(sessionRows, surface, tools) {
  const bySeq = new Map(sessionRows.filter((r) => r.seq !== undefined).map((r) => [r.seq, r]));
  const messages = [];
  let droppedMessages = 0;
  let droppedBlocks = 0;
  for (const seq of surface) {
    const row = bySeq.get(seq);
    if (row === undefined) { droppedMessages += 1; continue; }
    if (row.type === 'tool/result') {
      const read = messageTextOf(row.data?.message?.content);
      droppedBlocks += read.dropped;
      messages.push({ role: 'tool', text: read.text });
      continue;
    }
    const role = row.type === 'user/message' ? 'user'
      : row.type === 'system/message' ? 'system'
        : row.type === 'assistant/message' ? 'assistant' : null;
    if (role === null || !SEED_ROLES.has(role)) { droppedMessages += 1; continue; }
    const data = isRecord(row.data) ? row.data : {};
    const message = role === 'user' ? data : isRecord(data.message) ? data.message : {};
    const read = messageTextOf(message.content);
    droppedBlocks += read.dropped;
    messages.push({ role, text: read.text });
  }
  return { system: '', tools, messages, droppedMessages, droppedBlocks };
}

/** A row's own positive line count, or null (adapter `lineCountOf`, restated). */
export function lineCountOf(unit) {
  const range = unit?.span?.lineRange;
  if (range === null || range === undefined) return null;
  const count = range.endLineInclusive - range.startLine + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** The plan's rows in the entry message's row shape (adapter `entryRowsOf`). */
export function entryRowsOfPlan(rows) {
  return rows.map((row) => {
    const anchor = row.anchor;
    return {
      index: row.index,
      call: anchor.kind,
      ...(anchor.path === undefined ? {} : { path: anchor.path }),
      // The pass's own ordinal, so the message reads exactly as the bulk lane's
      // carried rows do (EntryBatchRow.callOrdinal).
      callOrdinal: anchor.callOrdinal,
      ...(isRefusedPruneAnchor(anchor)
        ? { anchorLines: [], anchorRefusal: anchor.refusal }
        : { anchorLines: anchor.anchors }),
      lineCount: lineCountOf(row.unit) ?? 0,
    };
  });
}

/** The bytes these runs sent: fork frame + contract + table + closing line. */
export function legacyBulkAsk(rows, grammar = BULK_GRAMMAR) {
  return `${LEGACY_FORK_FRAME}\n\n${pruneAskSystemPromptOf(grammar)}\n\n`
    + `${renderPruneAskTable(rows, undefined, { grammar })}`
    + `\n\n${pruneAskFinalLineOf(grammar)}`;
}

/** The corrected ask: the shipped three-piece `jsonl-20-nokeepall` message. */
export function correctedAsk(rows, firstTrigger) {
  return entryBatchAskMessage(entryRowsOfPlan(rows), 'jsonl-20-nokeepall', firstTrigger);
}

/** Freed bytes of a partial keep over the unit's own line-addressed slice. */
/** The byte size of the named lines, or null when they name no valid span. */
function namedLineBytes(unit, nodeBytes, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const span = unit.span?.byteRange;
  if (!isRecord(span)) return null;
  // The reader's `KeptLineSpan` is `{from, to}`; the tuple spelling is the
  // wire's, accepted here so a hand-written probe cannot read as zero bytes.
  const lines = ranges.map((range) => Array.isArray(range)
    ? { startLine: range[0], endLineInclusive: range[1] }
    : { startLine: range?.from ?? range?.startLine, endLineInclusive: range?.to ?? range?.endLineInclusive });
  const slice = nodeBytes.slice(span.startByte, span.endByteExclusive);
  try { return byteRangeForLines(slice, lines).reduce((sum, r) => sum + (r.endByteExclusive - r.startByte), 0); }
  catch { return null; }
}

/** Freed bytes of a `keeplines`: the unit minus the lines it keeps. */
export function partialFreedBytes(unit, nodeBytes, ranges) {
  const named = namedLineBytes(unit, nodeBytes, ranges);
  if (named === null) return 0;
  return Math.max(0, unit.byteLength - named);
}

/** Freed bytes of a `forgetlines`: exactly the lines it names. */
export function forgetLinesFreedBytes(unit, nodeBytes, ranges) {
  return namedLineBytes(unit, nodeBytes, ranges) ?? 0;
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function refuse(message) {
  console.error(`replay-depth-table: REFUSED — ${message}`);
  process.exit(2);
}

function walkFiles(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, name, out);
    else if (entry.name === name) out.push(full);
  }
  return out;
}

function hashFile(file) {
  return sha256Sync(fs.readFileSync(file));
}

function loadRun(root, run) {
  const journalPath = path.join(root, run, 'evidence', 'racoons', 'cremator-events.jsonl');
  if (!fs.existsSync(journalPath)) throw new Error(`journal absent: ${journalPath}`);
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map((line, at) => {
    try { return JSON.parse(line); } catch { throw new Error(`journal line ${at + 1} is not JSON`); }
  });
  const sessions = walkFiles(path.join(root, run, 'evidence', 'sessions'), 'session.v4.jsonl');
  if (sessions.length !== 1) throw new Error(`${run}: expected one session.v4.jsonl, found ${sessions.length}`);
  const sessionRows = fs.readFileSync(sessions[0], 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  for (let i = 1; i < sessionRows.length; i += 1) {
    if ((sessionRows[i].seq ?? -1) < (sessionRows[i - 1].seq ?? -1)) {
      throw new Error(`${run}: session rows are not in seq order at line ${i + 1}`);
    }
  }
  const ledgers = walkFiles(path.join(root, run, 'evidence', 'racoons', 'storage'), 'ledger.sqlite');
  if (ledgers.length !== 1) throw new Error(`${run}: expected one ledger.sqlite, found ${ledgers.length}`);
  return {
    run,
    journal,
    journalPath,
    sessionPath: sessions[0],
    sessionRows,
    ledgerPath: ledgers[0],
    ledgerSha256: hashFile(ledgers[0]),
    journalSha256: hashFile(journalPath),
    sessionSha256: hashFile(sessions[0]),
  };
}

function planCutOf(sessionRows, atMs) {
  let cut = -1;
  for (const row of sessionRows) {
    if (row.seq !== undefined && typeof row.time === 'number' && row.time <= atMs) {
      cut = Math.max(cut, row.seq);
    }
  }
  return cut;
}

function findRecordAfter(journal, from, kind, round) {
  for (let i = from; i < journal.length; i += 1) {
    const rec = journal[i];
    if (rec.kind === kind && rec.round === round) return { rec, line: i + 1 };
  }
  return null;
}

/**
 * A recorded baseline is a FAILED RECORDING, not a real zero, when the round's
 * journal says the table never landed: every attempt refused every row
 * `answer-unreadable`, every `l2RemovalCount` entry is zero, no `prune-verdict`
 * row was written and the apply step was skipped for `no-removals`. Three
 * recorded rounds are exactly that (`racoons-n1-correct` r23,
 * `racoons-n2-correct` r12, `racoons-n3-correct-3` r17): their 0/0 is the
 * answer failing to parse, never a table that chose to remove nothing.
 *
 * A REAL ZERO is different: the table was answered on every attempt and every
 * row kept its unit, so `answered > 0`, `answer-unreadable` is 0 and the same
 * `l2RemovalCount` zeros follow from the verdicts. That one is comparable.
 *
 * `failed` is `null` when the signals do not agree: the round is then neither a
 * comparable zero nor a proven failed recording, and the `recorded-baseline`
 * gate names it instead of guessing.
 */
export function classifyRecordedBaseline(journal, round) {
  const record = journal.find((row) => row.kind === 'prune-recorded' && row.round === round) ?? null;
  const skipped = journal.find((row) => row.kind === 'prune-apply-skipped' && row.round === round) ?? null;
  const verdicts = journal.filter((row) => row.kind === 'prune-verdict' && row.round === round).length;
  const attempts = Array.isArray(record?.tableAttempts) ? record.tableAttempts : [];
  const l2 = isRecord(record?.l2RemovalCount) ? record.l2RemovalCount : null;
  const l2AllZero = l2 !== null && Object.values(l2).every((value) => Number(value) === 0);
  const l2Sum = l2 === null ? null : Object.values(l2).reduce((sum, value) => sum + Number(value), 0);
  const everyAttemptUnreadable = attempts.length > 0 && attempts.every((attempt) => {
    const units = Number(attempt?.tableUnits ?? 0);
    return units > 0
      && Number(attempt?.answered ?? 0) === 0
      && Number(attempt?.refusedByCode?.['answer-unreadable'] ?? 0) === units;
  });
  const skippedNoRemovals = skipped?.reason === 'no-removals';
  const signals = {
    attempts: attempts.length,
    tableUnits: Number(attempts[attempts.length - 1]?.tableUnits ?? 0),
    everyAttemptUnreadable,
    l2AllZero,
    skippedNoRemovals,
    verdicts,
  };
  const out = (comparable, failed, reason) => ({ comparable, failed, reason, signals });
  if (attempts.length === 0) {
    return out(false, null, 'the round wrote no prune-recorded table attempts');
  }
  if (everyAttemptUnreadable && l2AllZero && skippedNoRemovals && verdicts === 0) {
    return out(false, true, `answer-unreadable on every row of all ${attempts.length}`
      + ` attempt(s) (${signals.tableUnits} row(s) each), l2RemovalCount all zero,`
      + ' prune-apply-skipped no-removals');
  }
  if (!everyAttemptUnreadable && l2Sum !== null && verdicts === l2Sum) {
    return out(true, false, verdicts === 0
      ? 'table answered, every row kept (real zero)'
      : `table answered, ${verdicts} removal verdict(s) applied`);
  }
  return out(false, null, 'mixed signals: ' + [
    everyAttemptUnreadable ? 'every attempt wholly answer-unreadable' : null,
    l2AllZero ? 'l2RemovalCount all zero' : null,
    skippedNoRemovals ? 'prune-apply-skipped no-removals' : null,
    `${verdicts} prune-verdict row(s) vs l2 sum ${String(l2Sum)}`,
  ].filter((part) => part !== null).join(', '));
}

/**
 * The recorded run's removals for one round: the journal's `prune-verdict`
 * count and the bytes freed, read from the ledger's archive spans. The ledger
 * is opened read-only and only these counts reach the report; no byte of it
 * enters the seed or the plan. The classification travels with the counts so a
 * failed recording keeps its raw zeros for display but is never read as a real
 * zero.
 */
export function recordedOf(runData, round) {
  const journalUnits = runData.journal.filter(
    (row) => row.kind === 'prune-verdict' && row.round === round).length;
  const baseline = classifyRecordedBaseline(runData.journal, round);
  const out = {
    units: journalUnits,
    journalUnits,
    ledgerUnits: null,
    bytesFreed: null,
    comparable: baseline.comparable,
    failed: baseline.failed,
    failReason: baseline.failed === false ? null : baseline.reason,
    signals: baseline.signals,
  };
  let db;
  try {
    db = new DatabaseSync(runData.ledgerPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT r.removal_id AS id,
              COALESCE(SUM(s.end_byte_exclusive - s.start_byte), 0) AS bytes
         FROM applications a
         JOIN application_removals r ON r.intent_id = a.intent_id
         LEFT JOIN removed_spans s ON s.recall_id = r.recall_id
        WHERE a.event_id LIKE ?
        GROUP BY r.removal_id`).all(`%:prune:${String(round)}:%`);
    out.ledgerUnits = rows.length;
    out.bytesFreed = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
  } catch (error) {
    out.error = String(error?.message ?? error);
  } finally {
    try { db?.close(); } catch { /* the handle is read-only */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One moment
// ---------------------------------------------------------------------------

export function analyzeMoment(runData, moment) {
  const gates = [];
  const gate = (name, ok, detail) => { gates.push({ name, ok: ok === true, detail }); };
  const fail = (message) => ({ moment, ok: false, gates, error: message, depth: null });

  const cross = runData.journal[moment.crossLine - 1];
  const planRecord = runData.journal[moment.planLine - 1];
  const shaped = isRecord(cross) && isRecord(planRecord)
    && cross.kind === 'prune-threshold' && cross.crossed === true
    && planRecord.kind === 'prune-plan' && planRecord.round === moment.round;
  gate('moment-shape', shaped, shaped ? 'crossing then plan at the round' : 'the journal lines are not a crossing + plan at this round');
  if (!shaped) return fail('moment shape');

  const foundSeed = findRecordAfter(runData.journal, moment.planLine, 'prune-seed', moment.round);
  const foundRecord = findRecordAfter(runData.journal, moment.planLine, 'prune-recorded', moment.round);
  gate('seed-record', foundSeed !== null, foundSeed ? `line ${foundSeed.line}` : 'no prune-seed for this round after the plan');
  gate('plan-record', foundRecord !== null, foundRecord ? `line ${foundRecord.line}` : 'no prune-recorded for this round after the plan');
  if (foundSeed === null || foundRecord === null) return fail('journal record absent');
  const seedRecord = foundSeed.rec;
  const record = foundRecord.rec;

  const planAtMs = planRecord.atMs;
  const planCut = planCutOf(runData.sessionRows, planAtMs);
  gate('session-cut', planCut >= 0, `surface cut at seq ${planCut}`);
  if (planCut < 0) return fail('no session row at or before the plan');

  const atPlan = foldSurface(runData.sessionRows, planCut);
  gate('plan-fold-gaps', atPlan.gaps === 0, `${atPlan.gaps} replace span(s) named no current surface node`);
  gate('plan-shadow-unapplied', atPlan.unappliedShadows === 0,
    `${atPlan.unappliedShadows} shadowed seq(s) have no checkpoint replace`);

  const sessionId = planRecord.sessionId;
  gate('session-id', cross.sessionId === sessionId && seedRecord.sessionId === sessionId,
    `journal session ${sessionId}`);

  const bySeq = new Map(runData.sessionRows.filter((r) => r.seq !== undefined).map((r) => [r.seq, r]));
  const host = {
    id: sessionId,
    seq: planCut + 1,
    eventAt: (seq) => bySeq.get(seq),
    surface: { nodes: atPlan.surface },
  };
  let sync;
  try { sync = surfaceTranscript(host, { sessionId }); }
  catch (e) { gate('plan-computed', false, String(e?.message ?? e)); return fail('surface projection threw'); }

  const nodes = toCoreTranscript(sync.items).map((envelope) => envelope.node);
  const toolNodes = nodes.filter((n) => n.kind === 'tool-result');
  const snapshot = {
    sessionId, revision: 'replay', nodes,
    currentTurnOrdinal: sync.currentTurnOrdinal,
    currentStepOrdinal: sync.currentStepOrdinal,
    completedThroughTurnOrdinal: sync.completedThroughTurnOrdinal,
  };
  const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes }).units(snapshot);
  gate('units', units.length === planRecord.units, `${units.length} / journal ${planRecord.units}`);

  const episodes = new EpisodeTracker({ noNewPathSteps: null }).detect({
    sessionId, results: toolNodes,
    currentStepOrdinal: sync.currentStepOrdinal,
    completedThroughTurnOrdinal: sync.completedThroughTurnOrdinal,
  });
  const plan = planPrunePass({
    units, nodes: toolNodes, episodes, transcriptNodes: nodes,
    callFacts: callFactsOf(sync.items), round: moment.round,
    classes: {}, grammar: BULK_GRAMMAR,
  });
  gate('ask-rows', plan.askRows.length === planRecord.askRows,
    `${plan.askRows.length} / journal ${planRecord.askRows}`);
  gate('tables', plan.tables.length === planRecord.tables,
    `${plan.tables.length} / journal ${planRecord.tables}`);
  const est = estimatePassTokens(plan);
  const journalTokens = record.estTokens?.askTableTokens;
  gate('ask-table-tokens', est.askTableTokens === journalTokens,
    `${est.askTableTokens} / journal ${String(journalTokens)}`);

  // The seed is main's last dispatched request: the surface immediately BEFORE
  // the last assistant turn at or before the plan. Results that landed after it
  // were produced BY that request and cannot be inside it.
  let lastAssistant = -1;
  for (const row of runData.sessionRows) {
    if (row.type === 'assistant/message' && row.seq !== undefined && row.seq <= planCut
      && typeof row.time === 'number' && row.time <= planAtMs) {
      lastAssistant = Math.max(lastAssistant, row.seq);
    }
  }
  gate('seed-anchor', lastAssistant >= 0, `last assistant turn at seq ${lastAssistant}`);
  if (lastAssistant < 0) return fail('no assistant turn before the plan');
  const atSeed = foldSurface(runData.sessionRows, lastAssistant - 1);
  gate('seed-fold-gaps', atSeed.gaps === 0, `${atSeed.gaps} replace span(s) named no current surface node`);
  gate('seed-shadow-unapplied', atSeed.unappliedShadows === 0,
    `${atSeed.unappliedShadows} shadowed seq(s) have no checkpoint replace`);

  const header = [...runData.sessionRows]
    .filter((r) => r.type === 'request/header' && r.seq !== undefined && r.seq < lastAssistant)
    .sort((a, b) => b.seq - a.seq)[0];
  const tools = Array.isArray(header?.data?.header?.tools) ? header.data.header.tools : [];
  gate('seed-tools-source', tools.length > 0, `${tools.length} tool(s) from the last request header`);

  const wire = seedWireOf(runData.sessionRows, atSeed.surface, tools);
  const seedHash = wireRequestHash(wire);
  gate('seed-hash', seedHash === seedRecord.seedHash,
    `${seedHash} / journal ${seedRecord.seedHash}`);
  gate('seed-messages', wire.messages.length === seedRecord.messages,
    `${wire.messages.length} / journal ${seedRecord.messages}`);
  gate('seed-tools', wire.tools.length === seedRecord.tools,
    `${wire.tools.length} / journal ${seedRecord.tools}`);
  gate('seed-dropped-blocks', wire.droppedBlocks === seedRecord.droppedBlocks,
    `${wire.droppedBlocks} / journal ${seedRecord.droppedBlocks}`);
  gate('seed-dropped-messages', wire.droppedMessages === seedRecord.droppedMessages,
    `${wire.droppedMessages} / journal ${seedRecord.droppedMessages}`);

  const firstTrigger = planRecord.round === 1;
  const oldAsk = legacyBulkAsk(plan.askRows);
  const newAsk = correctedAsk(plan.askRows, firstTrigger);
  gate('ask-bytes', oldAsk.length > 0 && newAsk.length > 0 && oldAsk !== newAsk,
    `${Buffer.byteLength(oldAsk)}B legacy / ${Buffer.byteLength(newAsk)}B corrected`);

  const recorded = recordedOf(runData, moment.round);
  const recordedComparable = recorded.comparable === true;
  gate('ledger-read', recorded.error === undefined && recorded.bytesFreed !== null,
    recorded.error ?? `${String(recorded.ledgerUnits)} removal row(s) in the ledger`);
  // The classification gate: a failed recording is LABELLED, never a silent
  // 0 == 0. `0 journal verdict(s) / 0 ledger removal(s)` is true for both a real
  // zero and a table that never parsed, so the round's own signals decide which
  // one this is and the detail says it.
  gate('recorded-baseline', recorded.failed !== null,
    recorded.failed === true
      ? `FAILED RECORDING (${recorded.failReason}); its 0/0 is raw, not a zero baseline,`
        + ' and it is excluded from the comparable aggregate'
      : recorded.failed === false
        ? `comparable baseline: ${recorded.units} unit(s), ${String(recorded.bytesFreed)} B freed`
        : `ambiguous baseline: ${recorded.failReason}`);
  gate('recorded-units', recorded.journalUnits === recorded.ledgerUnits,
    recorded.journalUnits === recorded.ledgerUnits
      ? `${recorded.journalUnits} journal verdict(s) / ${String(recorded.ledgerUnits)} ledger removal(s)`
        + (recorded.failed === true ? ' — a failed recording, not a measured zero' : '')
      : `${recorded.journalUnits} journal verdict(s) / ${String(recorded.ledgerUnits)} ledger removal(s)`);

  const tableUnits = plan.askRows.length;
  const tableBytesAtStake = plan.askRows.reduce((sum, row) => sum + row.unit.byteLength, 0);
  const ok = gates.every((g) => g.ok);
  const nodeBytes = new Map(toolNodes.map((node) => [node.id, bytesOfNode(node)]));
  return {
    moment,
    ok,
    gates,
    depth: cross.billedPromptTokens ?? null,
    depthContent: cross.contentTokens ?? null,
    threshold: cross.threshold ?? null,
    journal: { line: moment.planLine, seedLine: foundSeed.line, recordLine: foundRecord.line },
    units: units.length,
    rows: plan.askRows.length,
    tables: plan.tables.length,
    askTableTokens: est.askTableTokens,
    firstTrigger,
    share: firstTrigger ? '70' : '40',
    legacy: { bytes: Buffer.byteLength(oldAsk), sha256: sha256(oldAsk) },
    corrected: { bytes: Buffer.byteLength(newAsk), sha256: sha256(newAsk) },
    // The recorded baseline and the corrected table's candidate units/bytes.
    // A failed recording keeps its raw counts but yields no delta: a difference
    // against a table that never parsed would describe nothing.
    recorded,
    recordedFailed: recorded.failed === true,
    recordedComparable,
    recordedFailReason: recorded.failed === false ? null : recorded.failReason,
    tableUnits,
    tableBytesAtStake,
    deltaTableUnits: recordedComparable ? tableUnits - recorded.units : null,
    deltaTableBytes: recordedComparable && recorded.bytesFreed !== null
      ? tableBytesAtStake - recorded.bytesFreed : null,
    // Retained for the send lane only; the offline report omits it.
    state: { sessionId, wire, tools, askRows: plan.askRows, nodeBytes, correctedAsk: newAsk, recorded },
  };
}

const momentLabelOf = (moment) => `${moment.run} r${moment.round}`;

/**
 * Sum one list of readings. `recordedBytesFreed` and `deltaBytes` are null when
 * any reading's ledger bytes are unknown, so a partial read cannot pose as a
 * total.
 */
export function totalsOf(readings) {
  const known = readings.every((r) => typeof r.recorded?.bytesFreed === 'number');
  const totals = {
    moments: readings.length,
    recordedUnits: readings.reduce((sum, r) => sum + (r.recorded?.units ?? 0), 0),
    recordedBytesFreed: known ? readings.reduce((sum, r) => sum + (r.recorded?.bytesFreed ?? 0), 0) : null,
    newUnits: readings.reduce((sum, r) => sum + (r.newUnits ?? 0), 0),
    newBytesFreed: readings.reduce((sum, r) => sum + (r.newBytesFreed ?? 0), 0),
  };
  totals.deltaUnits = totals.newUnits - totals.recordedUnits;
  totals.deltaBytes = totals.recordedBytesFreed === null
    ? null : totals.newBytesFreed - totals.recordedBytesFreed;
  return totals;
}

/**
 * ALL moments beside the comparable subset. A failed recorded baseline is
 * excluded from the comparable totals (its raw zeros would inflate every
 * removal the corrected table makes) and is named in `excluded` so a reader can
 * see exactly which moments are missing and why.
 */
export function splitComparable(readings, isComparable = (r) => r.recordedComparable !== false) {
  const label = (r) => (typeof r.moment === 'string' ? r.moment : momentLabelOf(r.moment));
  const comparable = readings.filter((r) => isComparable(r));
  const excluded = readings.filter((r) => !isComparable(r)).map(label);
  const totals = totalsOf(comparable);
  return {
    label: `COMPARABLE-${comparable.length}`,
    ...totals,
    excluded,
    excludedCount: excluded.length,
  };
}

export function computeOffline(root = DEFAULT_ROOT, moments = MOMENTS) {
  const runs = new Map();
  const results = [];
  for (const moment of moments) {
    try {
      if (!runs.has(moment.run)) runs.set(moment.run, loadRun(root, moment.run));
    } catch (e) {
      results.push({ moment, ok: false, gates: [{ name: 'inputs', ok: false, detail: String(e?.message ?? e) }],
        depth: null, error: String(e?.message ?? e) });
      continue;
    }
    try {
      results.push(analyzeMoment(runs.get(moment.run), moment));
    } catch (e) {
      results.push({ moment, ok: false, gates: [{ name: 'computed', ok: false, detail: String(e?.message ?? e) }],
        depth: null, error: String(e?.message ?? e) });
    }
  }
  return { root, results, ok: results.every((r) => r.ok), runs };
}

// ---------------------------------------------------------------------------
// The send lane
// ---------------------------------------------------------------------------

/** Deterministic canned answer for `--transport stub`; no model is called. */
export function stubAnswerText(rows) {
  const lines = [];
  for (const row of rows) {
    const count = lineCountOf(row.unit) ?? 0;
    const slot = row.index % 4;
    if (slot === 1 && count >= 2) {
      lines.push(JSON.stringify({ [String(row.index)]: {
        keeplines: [[1, Math.floor(count / 2)]], summary: 'stub partial keep' } }));
    } else if (slot === 3) {
      lines.push(JSON.stringify({ [String(row.index)]: { keepall: true } }));
    } else {
      lines.push(JSON.stringify({ [String(row.index)]: {
        forgetall: true, summary: `stub forgotten result ${row.unit.id}` } }));
    }
  }
  lines.push('[[entry-ask-end:stub]]');
  return lines.join('\n');
}

/**
 * Read one reply. A zero-line unit is read with the product's sentinel `L = 1`
 * (so a `keeplines` answer cannot throw), then any `keeplines` on it is refused
 * `spans-outside-result` — no span lies inside `1..0` (judge-tables.ts does
 * exactly this).
 */
export function readAnswerFor(rows, text) {
  const counts = new Map();
  const zeroLine = new Set();
  for (const row of rows) {
    const count = lineCountOf(row.unit);
    if (count === null) { zeroLine.add(row.index); counts.set(row.index, 1); } else counts.set(row.index, count);
  }
  const reading = readJsonl20NoKeepallAnswer(text, rows.map((r) => r.index), counts);
  return {
    rows: reading.rows.map((row) => {
      let read = row;
      if (row.status === 'answered' && zeroLine.has(row.index)
        && (row.answer.action === 'keeplines' || row.answer.action === 'keepall')) {
        // A zero-line row's `1..0` holds no span, and the reader has already
        // normalized a whole-range `keeplines` (`[[1,1]]`) to `keepall`; both
        // spellings are refused, as judge-tables.ts refuses them.
        read = { index: row.index, status: 'refused', code: 'spans-outside-result',
          message: "The answer named a line outside that row's own 1..0; the row is kept." };
      }
      if (read.status !== 'refused') {
        // Under `jsonl-20-nokeepall` the grammar refuses a literal `keepall`
        // (`action-not-in-grammar`), so an answered `keepall` can only be the
        // reader's normalization of a whole-range `keeplines`. Mark it: it is a
        // whole keep the reader produced, not a literal keepall the run chose.
        return read.answer?.action === 'keepall'
          ? { ...read, keepallSource: 'normalized-keeplines' } : read;
      }
      // dsh reports its closed vocabulary; the finer jsonl-20 code rides as
      // `detail` (judge-tables.ts BULK_CODE_OF).
      return { ...read, code: PRODUCT_REFUSAL_CODE[read.code] ?? read.code, detail: read.code };
    }),
    rejected: reading.rejected,
  };
}

/**
 * The product's closed row-refusal vocabulary for the bulk `nokeepall` reader:
 * the line-level defects collapse into `malformed-row` and ride `detail`. It IS
 * the adapter's own `BULK_CODE_OF` (ISSUE-508), imported rather than copied, so
 * the replay cannot drift from the pass it predicts.
 */
export const PRODUCT_REFUSAL_CODE = BULK_CODE_OF;

function openAiTools(tools) {
  return tools.map((tool) => isRecord(tool) && tool.type === 'function'
    ? tool
    : { type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters } });
}

function bodyOf(state, messages) {
  return {
    model: MODEL,
    messages,
    ...(state.tools.length === 0 ? {} : { tools: openAiTools(state.tools) }),
    stream: false,
  };
}

function messagesFor(state, askText) {
  const seed = state.wire.messages.map((m) => ({
    role: m.role === 'tool' ? 'user' : m.role, content: m.text,
  }));
  return [
    ...(state.wire.system === '' ? [] : [{ role: 'system', content: state.wire.system }]),
    ...seed,
    { role: 'user', content: askText },
  ];
}

/** `DEEPSEEK_API_KEY` from the `refs:` block only, in-process. */
export function loadKey(home = os.homedir()) {
  const cred = path.join(home, '.dsh', '.credentials.yaml');
  if (!fs.existsSync(cred)) return { key: null, source: cred };
  const text = fs.readFileSync(cred, 'utf8');
  let inRefs = false;
  for (const line of text.split('\n')) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/.exec(line);
    if (match !== null) return { key: match[1], source: cred };
  }
  return { key: null, source: cred };
}

async function deepseekAnswer(body, key, deadlineMs) {
  const remain = deadlineMs - Date.now();
  if (remain < 5000) return { ok: false, error: `kill-timer budget too low (${remain} ms)` };
  const started = Date.now();
  let response;
  let rawBody = '';
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      // The abort follows the granted timer budget: a fixed 120000 ms cap here
      // shortened a larger --kill-ms with no ruling behind it (ISSUE-597).
      signal: AbortSignal.timeout(remain),
    });
    rawBody = await response.text();
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' ? 'transport deadline' : String(e?.message ?? e) };
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

function verdictBytes(rows, reading, nodeBytes) {
  const byIndex = new Map(reading.rows.map((r) => [r.index, r]));
  const verdicts = { forgetall: 0, keeplines: 0, keepall: 0, forgetlines: 0 };
  const refusals = {};
  const refusalDetail = {};
  let wholeUnitBytesFreed = 0;
  let partialLineBytesFreed = 0;
  let keptBytes = 0;
  let decided = 0;
  let wholeKeeps = 0;
  for (const row of rows) {
    const read = byIndex.get(row.index);
    const nodeBytesOfUnit = nodeBytes.get(row.unit.nodeId) ?? new Uint8Array();
    if (read === undefined || read.status !== 'answered') {
      const code = read?.code ?? 'missing-index';
      const detail = read?.detail ?? code;
      refusals[code] = (refusals[code] ?? 0) + 1;
      refusalDetail[detail] = (refusalDetail[detail] ?? 0) + 1;
      keptBytes += row.unit.byteLength;
      continue;
    }
    decided += 1;
    const answer = read.answer;
    verdicts[answer.action] = (verdicts[answer.action] ?? 0) + 1;
    if (answer.action === 'forgetall') {
      wholeUnitBytesFreed += row.unit.byteLength;
    } else if (answer.action === 'keepall') {
      // Every accepted keepall came from a normalized whole-range keeplines.
      if (read.keepallSource === 'normalized-keeplines') wholeKeeps += 1;
      keptBytes += row.unit.byteLength;
    } else if (answer.action === 'keeplines') {
      const freed = partialFreedBytes(row.unit, nodeBytesOfUnit, answer.ranges);
      partialLineBytesFreed += freed;
      keptBytes += row.unit.byteLength - freed;
    } else if (answer.action === 'forgetlines') {
      // Unreachable under `jsonl-20-nokeepall` (the gate refuses it), but the
      // arithmetic is signed the same way the product reads the answer.
      const freed = forgetLinesFreedBytes(row.unit, nodeBytesOfUnit, answer.ranges);
      partialLineBytesFreed += freed;
      keptBytes += row.unit.byteLength - freed;
    }
  }
  return { verdicts, refusals, refusalDetail, decided, rows: rows.length,
    wholeUnitBytesFreed, partialLineBytesFreed, keptBytes, wholeKeeps };
}

/** Refuse the whole send lane when any offline gate failed. */
export function assertAllGated(results) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.map((r) => `${r.moment.run} r${r.moment.round}`).join(', ');
}

function usageTotalOf(usage) {
  return usage?.total_tokens
    ?? ((usage?.promptTokens ?? usage?.prompt_tokens ?? 0)
      + (usage?.completionTokens ?? usage?.completion_tokens ?? 0));
}

async function sendLane(corpus, options) {
  const blocked = assertAllGated(corpus.results);
  if (blocked !== null) {
    refuse(`offline gates failed for ${blocked}; nothing was sent`);
  }
  const transport = options.transport;
  let key = null;
  if (transport === 'deepseek') {
    const loaded = loadKey();
    console.log(`[key] DEEPSEEK_API_KEY: ${loaded.key ? 'found' : 'not found'} in ${loaded.source}`);
    if (!loaded.key) refuse(`DEEPSEEK_API_KEY not found in ${loaded.source}; nothing was sent`);
    key = loaded.key;
  }
  const deadline = options.deadline;
  const records = [];
  let providerTokens = 0;
  let syntheticTokens = 0;
  let estimatedTokens = 0;
  let stoppedAtBudget = false;
  const spent = () => providerTokens + syntheticTokens + estimatedTokens;

  for (const result of corpus.results) {
    if (stoppedAtBudget) break;
    const state = result.state;
    const momentLabel = `${result.moment.run} r${result.moment.round}`;
    const body = bodyOf(state, messagesFor(state, state.correctedAsk));
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    // The grant is the run's only cap, and it holds for BOTH transports: a
    // request whose prompt estimate would cross it is never sent.
    const promptEstimate = Math.ceil(bodyBytes / 3.04);
    if (spent() + promptEstimate > options.tokenGrant) { stoppedAtBudget = true; break; }
    let answer;
    if (transport === 'stub' && options.stubFail === 'length-trip') {
      // A billed, truncated draw: the usage is real and must charge the grant.
      answer = { ok: false, sent: true, error: 'length-trip', text: '{"1":{"forget',
        usage: { promptTokens: 1000, completionTokens: 1, ruler: 'synthetic' } };
    } else if (transport === 'stub' && options.stubFail === 'transport-error') {
      answer = { ok: false, sent: true, error: 'non-2xx' };
    } else if (transport === 'stub') {
      const text = stubAnswerText(state.askRows);
      answer = { ok: true, text, usage: {
        promptTokens: Math.ceil(bodyBytes / 3.04),
        completionTokens: Math.ceil(Buffer.byteLength(text) / 3.04),
        ruler: 'synthetic',
      } };
    } else {
      answer = await deepseekAnswer(body, key, deadline);
    }
    // The grant is charged for every reading, success or failure. A provider
    // answer that states no usage — absent, or an empty object — is charged the
    // 3.04 B/token estimate and marked `estimated`, so a silent usage field
    // cannot run the cap open. A length-trip carries billed usage; charging it
    // here keeps a truncated send inside the grant.
    const charge = (candidate, text) => {
      const countable = candidate !== null && candidate !== undefined
        && [candidate.total_tokens, candidate.prompt_tokens, candidate.promptTokens,
          candidate.completion_tokens, candidate.completionTokens].some((value) => Number.isFinite(value));
      if (!countable) {
        const estimated = { promptTokens: Math.ceil(bodyBytes / 3.04),
          completionTokens: Math.ceil(Buffer.byteLength(text) / 3.04), ruler: 'estimated' };
        const tokens = estimated.promptTokens + estimated.completionTokens;
        estimatedTokens += tokens;
        return { usage: estimated, ruler: 'estimated', tokens };
      }
      if (candidate.ruler === 'synthetic') {
        const tokens = (candidate.promptTokens ?? 0) + (candidate.completionTokens ?? 0);
        syntheticTokens += tokens;
        return { usage: candidate, ruler: 'synthetic', tokens };
      }
      const tokens = usageTotalOf(candidate);
      providerTokens += tokens;
      return { usage: candidate, ruler: 'provider', tokens };
    };

    if (!answer.ok) {
      const charged = answer.usage === undefined ? null : charge(answer.usage, answer.text ?? '');
      console.error(`[send] ${momentLabel} transport refused: ${answer.error}; no retry`);
      records.push({ moment: momentLabel, round: result.moment.round, sends: 1,
        ok: false, error: answer.error, rows: state.askRows.length,
        usage: charged === null ? null
          : { ruler: charged.ruler, totalTokens: charged.tokens, readings: [charged.usage] },
        chargedTokens: charged?.tokens ?? 0 });
      continue;
    }

    const charged = charge(answer.usage, answer.text);
    const usage = charged.usage;
    const ruler = charged.ruler;

    const reading = readAnswerFor(state.askRows, answer.text);
    const accounting = verdictBytes(state.askRows, reading, state.nodeBytes);
    const bytesAtStake = state.askRows.reduce((sum, row) => sum + row.unit.byteLength, 0);
    const newUnits = accounting.verdicts.forgetall + accounting.verdicts.keeplines
      + accounting.verdicts.forgetlines;
    const newBytesFreed = accounting.wholeUnitBytesFreed + accounting.partialLineBytesFreed;
    const recordedUnits = state.recorded.units;
    const recordedBytes = state.recorded.bytesFreed;
    const recordedComparable = state.recorded.failed === false;
    const recordedFailed = state.recorded.failed === true;
    const usageTotal = charged.tokens;
    const record = {
      moment: momentLabel,
      round: result.moment.round,
      sends: 1,
      ok: true,
      verdicts: accounting.verdicts,
      refusals: accounting.refusals,
      refusalDetail: accounting.refusalDetail,
      decided: accounting.decided,
      rows: accounting.rows,
      bytesAtStake,
      wholeUnitBytesFreed: accounting.wholeUnitBytesFreed,
      partialLineBytesFreed: accounting.partialLineBytesFreed,
      keptBytes: accounting.keptBytes,
      // A `keepall` here is always the reader's normalization of a whole-range
      // `keeplines`: the grammar refuses a literal `keepall`. The count and the
      // source marker keep the two apart.
      wholeKeeps: accounting.wholeKeeps,
      keepallSource: 'normalized-keeplines',
      recorded: { units: recordedUnits, bytesFreed: recordedBytes,
        comparable: recordedComparable, failed: recordedFailed,
        failReason: state.recorded.failed === false ? null : state.recorded.failReason },
      recordedComparable,
      recordedFailed,
      recordedFailReason: state.recorded.failed === false ? null : state.recorded.failReason,
      newUnits,
      newBytesFreed,
      // No delta against a table that never parsed.
      deltaUnits: recordedComparable ? newUnits - recordedUnits : null,
      deltaBytes: recordedComparable && recordedBytes !== null ? newBytesFreed - recordedBytes : null,
      usage: { ruler, totalTokens: usageTotal, readings: [usage] },
      firstContentSha256: sha256(answer.text),
      firstContent: answer.text.slice(0, 256 * 1024),
    };
    records.push(record);
    const refusalCodes = Object.entries(record.refusals).map(([code, count]) => `${code}:${count}`).join(',');
    const detailCodes = Object.entries(record.refusalDetail).map(([code, count]) => `${code}:${count}`).join(',');
    console.log(`[send] ${momentLabel} sends=1 decided=${record.decided}/${record.rows}`
      + ` forgetall=${record.verdicts.forgetall} keeplines=${record.verdicts.keeplines}`
      + ` keepall=${record.verdicts.keepall} forgetlines=${record.verdicts.forgetlines}`
      + ` wholeKeeps=${record.wholeKeeps}`
      + ` refused=${Object.values(record.refusals).reduce((a, b) => a + b, 0)}`
      + `${refusalCodes === '' ? '' : ` [${refusalCodes}]`}`
      + `${detailCodes === '' ? '' : ` detail [${detailCodes}]`}`
      + ` newUnits=${newUnits} newBytesFreed=${newBytesFreed}B (whole ${record.wholeUnitBytesFreed}`
      + ` + partial ${record.partialLineBytesFreed}) kept=${record.keptBytes}B`
      + ` recordedUnits=${recordedUnits} recordedBytesFreed=${String(recordedBytes)}`
      + ` recorded=${recordedFailed ? `FAILED-RECORDING(${record.recordedFailReason})`
        : recordedComparable ? 'comparable' : 'AMBIGUOUS'}`
      + ` deltaUnits=${String(record.deltaUnits)} deltaBytesFreed=${String(record.deltaBytes)}`
      + ` tokens=${usageTotal} (${ruler})`);
  }

  const failures = records.filter((r) => r.ok === false).length;
  const coverageReasons = [
    ...(failures > 0 ? ['transport-failures'] : []),
    ...(stoppedAtBudget ? ['token-budget'] : []),
  ];
  // Two aggregates, side by side. `all15` keeps every moment, failed recorded
  // baselines included at their raw zeros. `COMPARABLE-n` drops them: a delta
  // against a table that never parsed describes nothing, and their zeros would
  // otherwise credit the corrected table with removals it did not win.
  const all15 = totalsOf(records);
  const comparable = splitComparable(records);
  const aggregate = {
    moments: records.length,
    momentsOk: records.length - failures,
    failures,
    // The unit and byte sums below cover the moments that produced a reading.
    // A failed transport makes them success-only; a budget stop makes them
    // cover only the attempted moments, which is a coverage limit too.
    successOnly: failures > 0,
    coverageLimited: coverageReasons.length > 0,
    coverageReasons,
    sends: records.reduce((sum, r) => sum + (r.sends ?? 0), 0),
    verdicts: records.reduce((acc, r) => {
      for (const [action, count] of Object.entries(r.verdicts ?? {})) acc[action] = (acc[action] ?? 0) + count;
      return acc;
    }, {}),
    refusals: records.reduce((acc, r) => {
      for (const [code, count] of Object.entries(r.refusals ?? {})) acc[code] = (acc[code] ?? 0) + count;
      return acc;
    }, {}),
    refusalDetail: records.reduce((acc, r) => {
      for (const [code, count] of Object.entries(r.refusalDetail ?? {})) acc[code] = (acc[code] ?? 0) + count;
      return acc;
    }, {}),
    bytesAtStake: records.reduce((sum, r) => sum + (r.bytesAtStake ?? 0), 0),
    wholeUnitBytesFreed: records.reduce((sum, r) => sum + (r.wholeUnitBytesFreed ?? 0), 0),
    partialLineBytesFreed: records.reduce((sum, r) => sum + (r.partialLineBytesFreed ?? 0), 0),
    keptBytes: records.reduce((sum, r) => sum + (r.keptBytes ?? 0), 0),
    // A `keepall` verdict is the reader's normalization of a whole-range
    // `keeplines`; the grammar refuses a literal `keepall`.
    wholeKeeps: records.reduce((sum, r) => sum + (r.wholeKeeps ?? 0), 0),
    keepallSource: 'normalized-keeplines',
    recordedUnits: all15.recordedUnits,
    recordedBytesFreed: all15.recordedBytesFreed,
    newUnits: all15.newUnits,
    newBytesFreed: all15.newBytesFreed,
    deltaUnits: all15.deltaUnits,
    deltaBytes: all15.deltaBytes,
    all15,
    comparable,
    providerTokens,
    syntheticTokens,
    estimatedTokens,
    stoppedAtBudget,
  };

  const outDir = options.out;
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `replay-depth-table-${transport}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    issue: 'ISSUE-510',
    caveat: 'one draw per moment is a counterfactual, not an expected value; the aggregate is descriptive'
      + (failures > 0 ? ' Unit and byte aggregates cover successful moments only (successOnly: true).' : '')
      + (stoppedAtBudget ? ' The run stopped at the token budget; the aggregate covers only the attempted moments (coverageLimited: true).' : ''),
    transport,
    model: transport === 'stub' ? null : MODEL,
    base: transport === 'stub' ? null : BASE,
    corpus: { root: corpus.root, moments: corpus.results.length },
    gates: corpus.results.map((r) => ({ moment: `${r.moment.run} r${r.moment.round}`, ok: r.ok,
      gates: r.gates })),
    records,
    aggregate,
  }, null, 2));
  console.log(`[aggregate] moments=${aggregate.moments} momentsOk=${aggregate.momentsOk}`
    + ` failures=${aggregate.failures}`
    + `${aggregate.coverageLimited ? ` AGGREGATES-COVERAGE-LIMITED (${aggregate.coverageReasons.join('+')})` : ''}`
    + ` sends=${aggregate.sends}`
    + ` refusals=[${Object.entries(aggregate.refusals).map(([code, count]) => `${code}:${count}`).join(',')}]`
    + ` refusalDetail=[${Object.entries(aggregate.refusalDetail).map(([code, count]) => `${code}:${count}`).join(',')}]`
    + ` whole=${aggregate.wholeUnitBytesFreed}B partial=${aggregate.partialLineBytesFreed}B`
    + ` kept=${aggregate.keptBytes}B wholeKeeps=${aggregate.wholeKeeps}`
    + ` keepallSource=${aggregate.keepallSource}`
    + ` providerTokens=${providerTokens}`
    + ` syntheticTokens=${syntheticTokens} estimatedTokens=${estimatedTokens}`
    + `${stoppedAtBudget ? ' STOPPED-AT-BUDGET' : ''}`);
  // ALL moments, then the comparable subset. Both are printed: ALL-15 answers
  // "what did the replay remove"; COMPARABLE-n answers "how does it compare",
  // and the failed recorded baselines are named on that line.
  console.log(`[aggregate] ALL-${aggregate.moments} recordedUnits=${aggregate.all15.recordedUnits}`
    + ` recordedBytesFreed=${String(aggregate.all15.recordedBytesFreed)}`
    + ` newUnits=${aggregate.all15.newUnits} newBytesFreed=${aggregate.all15.newBytesFreed}`
    + ` deltaUnits=${String(aggregate.all15.deltaUnits)} deltaBytesFreed=${String(aggregate.all15.deltaBytes)}`);
  console.log(`[aggregate] ${aggregate.comparable.label} moments=${aggregate.comparable.moments}`
    + ` recordedUnits=${aggregate.comparable.recordedUnits}`
    + ` recordedBytesFreed=${String(aggregate.comparable.recordedBytesFreed)}`
    + ` newUnits=${aggregate.comparable.newUnits} newBytesFreed=${aggregate.comparable.newBytesFreed}`
    + ` deltaUnits=${String(aggregate.comparable.deltaUnits)}`
    + ` deltaBytesFreed=${String(aggregate.comparable.deltaBytes)}`
    + ` excludedFailingBaselines=[${aggregate.comparable.excluded.join(', ')}]`);
  console.log(`[evidence] ${outFile}`);
  return { records, aggregate, outFile };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SEND_OPTIONS = optionsOf([
  ['--root', 'string'],
  ['--only', 'string'],
  ['--transport', 'string'],
  ['--i-am-the-owner', 'boolean', 'iAmTheOwner'],
  ['--token-grant', 'string', 'tokenGrant'],
  ['--kill-ms', 'string', 'killMs'],
  ['--stub-fail', 'string', 'stubFail'],
  ['--live', 'string'],
  ['--out', 'string'],
]);

/** `scratchpad/launch/<yyyy-mm-dd>-replay-depth-table/`, the README's location. */
export function defaultOutDir() {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(REPO_ROOT, 'scratchpad', 'launch', `${day}-replay-depth-table`);
}

/**
 * The offline baseline in both shapes: ALL moments (raw recorded zeros kept)
 * and the comparable subset (failed recorded baselines dropped and named).
 * Offline `new` is the corrected table's units and bytes AT STAKE, not freed:
 * no model is called here.
 */
export function offlineBaselineOf(results) {
  const readings = results.map((r) => ({
    moment: r.moment,
    recorded: r.recorded,
    newUnits: r.tableUnits,
    newBytesFreed: r.tableBytesAtStake,
    recordedComparable: r.recordedComparable === true,
  }));
  const shape = (totals) => ({
    moments: totals.moments,
    recordedUnits: totals.recordedUnits,
    recordedBytesFreed: totals.recordedBytesFreed,
    tableUnits: totals.newUnits,
    tableBytesAtStake: totals.newBytesFreed,
    deltaUnits: totals.deltaUnits,
    deltaBytesAtStake: totals.deltaBytes,
  });
  const comparable = splitComparable(readings);
  const all15 = shape(totalsOf(readings));
  return {
    ...all15,
    all15,
    comparable: {
      ...shape(comparable),
      label: comparable.label,
      excluded: comparable.excluded,
      excludedCount: comparable.excludedCount,
    },
  };
}

/**
 * Fold recorded send-lane evidence for display only. Offline gates answer "is
 * the rebuild sound"; the live replay answers "what did the model remove". The
 * two are kept apart: the recorded baseline and its classification come from
 * the corpus (this run's journals), the new units and bytes from the records.
 * A later file's record for a moment wins; a moment no file covers is left out.
 */
export function mergeLiveEvidence(files, results) {
  const byMoment = new Map();
  for (const result of results) {
    byMoment.set(momentLabelOf(result.moment), {
      moment: result.moment,
      recorded: result.recorded,
      recordedComparable: result.recordedComparable === true,
      newUnits: null,
      newBytesFreed: null,
    });
  }
  const filesRead = [];
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const records = Array.isArray(report.records) ? report.records : [];
    filesRead.push({ path: file, transport: report.transport ?? null, records: records.length });
    for (const record of records) {
      const cell = byMoment.get(record.moment);
      if (cell === undefined) continue;
      cell.newUnits = record.newUnits ?? 0;
      cell.newBytesFreed = record.newBytesFreed ?? 0;
    }
  }
  const readings = [...byMoment.values()].filter((r) => r.newUnits !== null);
  return { files: filesRead, readings, all15: totalsOf(readings), comparable: splitComparable(readings) };
}

/** The offline report is evidence too: bytes and gates, never a model answer. */
function writeOfflineEvidence(corpus, outDir, live = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'replay-depth-table-offline.json');
  const inputs = [...corpus.runs.values()].map((run) => ({
    run: run.run,
    journal: { path: run.journalPath, sha256: run.journalSha256 },
    session: { path: run.sessionPath, sha256: run.sessionSha256 },
    ledger: { path: run.ledgerPath, sha256: run.ledgerSha256 },
  }));
  const baseline = offlineBaselineOf(corpus.results);
  fs.writeFileSync(file, JSON.stringify({
    issue: 'ISSUE-510',
    mode: 'offline',
    caveat: 'no model was called; the corrected ask is bytes only and its bytes are at stake, not freed'
      + ' A failed recorded baseline keeps its raw 0/0 for display and is excluded from the comparable aggregate.',
    root: corpus.root,
    inputs,
    moments: corpus.results.map((r) => ({
      moment: `${r.moment.run} r${r.moment.round}`,
      run: r.moment.run,
      round: r.moment.round,
      ok: r.ok,
      gates: r.gates,
      depth: r.depth,
      firstTrigger: r.firstTrigger,
      share: r.share,
      units: r.units,
      rows: r.rows,
      tables: r.tables,
      askTableTokens: r.askTableTokens,
      legacy: r.legacy,
      corrected: r.corrected,
      recorded: r.recorded,
      recordedComparable: r.recordedComparable,
      recordedFailed: r.recordedFailed,
      recordedFailReason: r.recordedFailReason,
      tableUnits: r.tableUnits,
      tableBytesAtStake: r.tableBytesAtStake,
      deltaTableUnits: r.deltaTableUnits,
      deltaTableBytesAtStake: r.deltaTableBytes,
    })),
    baseline,
    ...(live === null ? {} : { liveReplay: live }),
  }, null, 2));
  console.log(`[evidence] ${file}`);
}

function printOffline(corpus, live = null) {
  console.log('replay-depth-table: OFFLINE — no socket, no key');
  console.log(`[root] ${corpus.root}`);
  for (const [run, data] of corpus.runs) {
    console.log(`[input] ${run} journal=${path.relative(REPO_ROOT, data.journalPath)} sha256=${data.journalSha256}`);
    console.log(`[input] ${run} session=${path.relative(REPO_ROOT, data.sessionPath)} sha256=${data.sessionSha256}`);
    console.log(`[input] ${run} ledger=${path.relative(REPO_ROOT, data.ledgerPath)} sha256=${data.ledgerSha256}`);
  }
  for (const result of corpus.results) {
    const label = `${result.moment.run} r${result.moment.round}`;
    const failed = result.gates.filter((g) => !g.ok).length;
    console.log(`[moment] ${label} depth=${String(result.depth)} units=${String(result.units)} rows=${String(result.rows)}`
      + ` share=${result.share}% legacyAsk=${result.legacy?.bytes}B/${result.legacy?.sha256}`
      + ` correctedAsk=${result.corrected?.bytes}B/${result.corrected?.sha256}`
      + ` recordedUnits=${String(result.recorded?.units)}`
      + ` recordedBytesFreed=${String(result.recorded?.bytesFreed)}`
      + ` recorded=${result.recordedFailed ? 'FAILED-RECORDING'
        : result.recordedComparable ? 'comparable' : 'AMBIGUOUS'}`
      + `${result.recordedFailed ? `(raw 0/0, reason: ${result.recordedFailReason})` : ''}`
      + ` tableUnits=${String(result.tableUnits)} tableBytesAtStake=${String(result.tableBytesAtStake)}`
      + ` deltaTableUnits=${String(result.deltaTableUnits)}`
      + ` deltaTableBytesAtStake=${String(result.deltaTableBytes)}`);
    console.log(`[gates] ${label} ${result.gates.map((g) => `${g.name}=${g.ok ? 'PASS' : 'FAIL'}`).join(' ')}`);
    if (failed > 0) {
      for (const g of result.gates.filter((x) => !x.ok)) {
        console.log(`[gate-detail] ${label} ${g.name}: ${g.detail}`);
      }
    }
  }
  console.log('');
  console.log('| run | round | depth | units | rows | old ask B | old sha256 | new ask B | new sha256 | gates |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |');
  for (const r of corpus.results) {
    const failed = r.gates.filter((g) => !g.ok).length;
    console.log(`| ${r.moment.run} | ${r.moment.round} | ${String(r.depth)} | ${String(r.units)} | ${String(r.rows)}`
      + ` | ${String(r.legacy?.bytes)} | ${r.legacy?.sha256 ?? '-'} | ${String(r.corrected?.bytes)}`
      + ` | ${r.corrected?.sha256 ?? '-'} | ${failed === 0 ? 'PASS' : `FAIL(${failed})`} |`);
  }
  console.log('');
  console.log('recorded run vs the corrected table (table bytes are AT STAKE, not freed):');
  console.log('| run | round | recorded units | recorded freed B | table units | table B at stake | delta units | delta B at stake | baseline |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const r of corpus.results) {
    console.log(`| ${r.moment.run} | ${r.moment.round} | ${String(r.recorded?.units)}`
      + ` | ${String(r.recorded?.bytesFreed)} | ${String(r.tableUnits)} | ${String(r.tableBytesAtStake)}`
      + ` | ${String(r.deltaTableUnits)} | ${String(r.deltaTableBytes)}`
      + ` | ${r.recordedFailed ? 'FAILED-RECORDING' : r.recordedComparable ? 'comparable' : 'AMBIGUOUS'} |`);
  }
  const baseline = offlineBaselineOf(corpus.results);
  console.log('');
  console.log(`[baseline] ALL-${baseline.all15.moments} recordedUnits=${baseline.all15.recordedUnits}`
    + ` recordedBytesFreed=${String(baseline.all15.recordedBytesFreed)}`
    + ` tableUnits=${baseline.all15.tableUnits} tableBytesAtStake=${baseline.all15.tableBytesAtStake}`
    + ` deltaUnits=${String(baseline.all15.deltaUnits)}`
    + ` deltaBytesAtStake=${String(baseline.all15.deltaBytesAtStake)}`);
  console.log(`[baseline] ${baseline.comparable.label} moments=${baseline.comparable.moments}`
    + ` recordedUnits=${baseline.comparable.recordedUnits}`
    + ` recordedBytesFreed=${String(baseline.comparable.recordedBytesFreed)}`
    + ` tableUnits=${baseline.comparable.tableUnits}`
    + ` tableBytesAtStake=${baseline.comparable.tableBytesAtStake}`
    + ` deltaUnits=${String(baseline.comparable.deltaUnits)}`
    + ` deltaBytesAtStake=${String(baseline.comparable.deltaBytesAtStake)}`
    + ` excludedFailingBaselines=[${baseline.comparable.excluded.join(', ')}]`);
  if (live !== null) {
    console.log('');
    for (const file of live.files) {
      console.log(`[live] ${path.relative(REPO_ROOT, file.path)} transport=${String(file.transport)}`
        + ` records=${file.records}`);
    }
    console.log(`[live-aggregate] ALL-${live.all15.moments}`
      + ` recordedUnits=${live.all15.recordedUnits}`
      + ` recordedBytesFreed=${String(live.all15.recordedBytesFreed)}`
      + ` newUnits=${live.all15.newUnits} newBytesFreed=${live.all15.newBytesFreed}`
      + ` deltaUnits=${String(live.all15.deltaUnits)}`
      + ` deltaBytesFreed=${String(live.all15.deltaBytes)}`);
    console.log(`[live-aggregate] ${live.comparable.label} moments=${live.comparable.moments}`
      + ` recordedUnits=${live.comparable.recordedUnits}`
      + ` recordedBytesFreed=${String(live.comparable.recordedBytesFreed)}`
      + ` newUnits=${live.comparable.newUnits} newBytesFreed=${live.comparable.newBytesFreed}`
      + ` deltaUnits=${String(live.comparable.deltaUnits)}`
      + ` deltaBytesFreed=${String(live.comparable.deltaBytes)}`
      + ` excludedFailingBaselines=[${live.comparable.excluded.join(', ')}]`);
  }
  console.log('');
  console.log(corpus.ok
    ? `replay-depth-table: PASS — ${corpus.results.length} moments, every gate green`
    : `replay-depth-table: FAIL — ${corpus.results.filter((r) => !r.ok).length} moment(s) have a failed gate; no send is allowed`);
}

async function main() {
  const { values } = parseDevArgs(process.argv.slice(2), {
    options: SEND_OPTIONS,
    refuse: (message) => refuse(message),
    prefix: 'replay-depth-table: ',
  });
  const root = path.resolve(REPO_ROOT, String(values.root ?? DEFAULT_ROOT));
  const transport = values.transport === undefined ? null : String(values.transport);
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
  let moments = MOMENTS;
  if (values.only !== undefined) {
    const picked = [];
    for (const spec of String(values.only).split(',').map((s) => s.trim()).filter(Boolean)) {
      const match = /^([A-Za-z0-9._-]+):r?(\d+)$/.exec(spec);
      if (match === null) refuse(`--only wants run:round, got ${spec}`);
      const found = MOMENTS.find((m) => m.run === match[1] && m.round === Number(match[2]));
      if (found === undefined) refuse(`--only names no moment for ${spec}`);
      picked.push(found);
    }
    if (picked.length === 0) refuse('--only named no moment');
    moments = picked;
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
    // The kill timer arms before any input is read, any key is loaded or any
    // socket opens: the run's whole budget is the timer's.
    deadline = Date.now() + killMs;
    const killTimer = setTimeout(() => {
      console.error(`FATAL kill timer fired (${killMs} ms); exiting 124`);
      process.exit(124);
    }, killMs);
    killTimer.unref?.();
    console.log(`[kill-timer] armed ${killMs} ms; fires ${new Date(deadline).toISOString()}`);
  }

  // `--live` folds recorded send-lane evidence into a display-only aggregate.
  // It never opens a socket and never enters the gates.
  let liveFiles = [];
  if (values.live !== undefined) {
    if (transport !== null) refuse('--live is an offline display option; it cannot ride the send lane');
    liveFiles = String(values.live).split(',').map((s) => s.trim()).filter(Boolean)
      .map((p) => path.resolve(REPO_ROOT, p));
    if (liveFiles.length === 0) refuse('--live named no file');
    for (const file of liveFiles) {
      if (!fs.existsSync(file)) refuse(`--live file absent: ${file}`);
    }
  }

  const outDir = values.out === undefined
    ? defaultOutDir()
    : path.resolve(REPO_ROOT, String(values.out));
  const corpus = computeOffline(root, moments);
  const live = liveFiles.length === 0 ? null : mergeLiveEvidence(liveFiles, corpus.results);
  if (transport === null) {
    printOffline(corpus, live);
    writeOfflineEvidence(corpus, outDir, live);
    process.exit(corpus.ok ? 0 : 1);
  }
  if (!corpus.ok) {
    printOffline(corpus);
    refuse('offline gates failed; the send lane sent nothing');
  }
  const sent = await sendLane(corpus, {
    transport,
    tokenGrant: values.tokenGrantValue,
    deadline,
    stubFail,
    out: outDir,
  });
  process.exit(sent.aggregate.stoppedAtBudget || sent.aggregate.failures > 0 ? 1 : 0);
}

const invoked = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(`replay-depth-table: FAILED — ${error?.message ?? error}`);
    process.exit(1);
  });
}
