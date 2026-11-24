#!/usr/bin/env node
/**
 * Standalone spend alarm for a paid live run: state MAIN, ASK, output and the
 * TRUE total at every poll, and say the number early.
 *
 * Why it exists. `--token-grant` is a kill. At the grant the launcher kills the
 * tree and the arm's evidence is void, so the only thing a run reports about its
 * spend is the number that ended it. Between "spending normally" and "the kill
 * fired" nothing states a number.
 *
 * **The hole this file closes.** `--token-grant`, the in-run watchdog and the
 * first version of this alarm all read one artifact: `assistant/message` rows in
 * `session.v4.jsonl`. That file carries ONLY main-wire traffic. The mount's ask
 * forks — the entry checkpoint's ask and the bulk prune's table ask — never
 * touch it, so a main-only meter under-reads the real spend. On the 2026-10-29
 * racoons arm main read 63 960 657 while asks added 57 803 506, a prompt-only
 * total of 121 764 163 (that reading's completion tokens were never recorded,
 * so it is not the TRUE total this file now computes): a 100 000 000 cap read
 * 64 M and never fired.
 *
 * **Where ask usage actually lands, and that it is live.** The ask's `ApiUsage`
 * (ISSUE-056 C6a) is journaled by the mount the moment the ask's stream returns.
 * The entry checkpoint writes it as the `usage` field of an `entry-ask`
 * (answered) or `entry-ask-refused` (refused) record; the bulk prune writes one
 * `prune-ask` record per table send and one per correction turn (ISSUE-178),
 * answered or refused. The rig wrapper's sink (`dev/dsh-rig/rig-plugin.mjs`,
 * `evidenceSink`) is `appendFileSync` per record — one line on disk per ask, not
 * a buffer flushed at exit. So BOTH ask lanes are readable during the run,
 * through `AskTail` below, with the same byte-offset discipline the watchdog's
 * `UsageTail` uses for the session log.
 *
 * **What a `prune-ask` line means.** `inputTokens` is the whole billed prompt of
 * that one send (the host's input + cacheRead + cacheWrite, through
 * `readAssistantUsage`), exactly the quantity MAIN and the entry lane name, so
 * all three add. A prune table that wrote no `prune-ask` line — an older
 * journal, or a host that reported no usage chunk — stays in the counted
 * remainder the line prints as `[N prune table(s) unmeasured]`.
 *
 * Read-only by construction. The filesystem calls are `readdirSync`,
 * `openSync(…, 'r')`, `readSync` and `statSync`. Nothing in the session log, the
 * journal or the evidence dir is written, renamed, truncated or created;
 * `--selftest` writes only inside a fresh `os.tmpdir()` directory it makes
 * itself.
 *
 * Advisory. It kills nothing. Its exit 3 is advice to the operator.
 */
import {
  appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeTrueTotal, findSessionLogs, TOKEN_POLL_MS, UsageTail } from './token-watchdog.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

/** The owner's alarm point: learn at 80 000 000 TRUE total, before the 100 000 000 kill. */
export const DEFAULT_WARN = 80_000_000;
/** The grant the operator passes to `--token-grant`; the alarm only recommends it. */
export const DEFAULT_STOP = 100_000_000;
/**
 * The stop level's exit code. Distinct from the bench's set — 0 green, 1
 * assertion or kill, 2 bad arguments, 4 read boundary, 130 SIGINT — so an
 * operator, a shell `$?` or a wrapper can never read "the alarm says stop" as
 * one of the run's own outcomes.
 */
export const EXIT_STOPPED = 3;
/** Bad arguments, or a target this script cannot read. Same meaning as in the bench. */
export const EXIT_USAGE = 2;

/** The mount's journal file name, under the evidence dir's `racoons/` subdir. */
export const ASK_JOURNAL = 'cremator-events.jsonl';
/** The evidence dir's fixed name for the mount's own output (`bench-run.mjs`). */
export const CREMATOR_EVIDENCE_DIR = 'racoons';
/**
 * The journal kinds that carry an ask's cost. `entry-ask` and
 * `entry-ask-refused` are the mount's entry checkpoint; `prune-ask` is the bulk
 * prune's table ask (ISSUE-178), answered or refused, plus its one correction
 * turn. All three carry the host's `usage` under the same field names, so one
 * arithmetic sums the whole ask lane.
 */
export const ASK_KINDS = Object.freeze(['entry-ask', 'entry-ask-refused', 'prune-ask']);

/**
 * The ask/main ratio measured on the 2026-10-29 arm (run C): 57 803 506 ask
 * prompt tokens over 63 960 657 main. One run, and the basis for the two
 * main-only numbers below. Two other recorded racoons runs on the same task
 * state 0.780 (2026-10-29 redo) and 0.595 (2026-10-28 extended), so 0.903 is the
 * MAXIMUM observed, never a proven ceiling.
 */
export const MEASURED_ASK_RATIO = 0.903;
/**
 * The bulk prune's share, which the 0.903 reading does NOT include (ISSUE-178).
 *
 * That run's journal holds no `prune-ask` row: the ask was paid for but never
 * written down, so its cost is UNKNOWN, not zero. It is bounded from above: a
 * prune send carries the fork of main's own wire state at the fire, and the
 * fires that ran recorded 200 173 and 202 277 billed prompt tokens, so one send
 * is about 206 000 with the table appended. The 2026-10-29 pass asked 24 rows =
 * 2 tables plus at most one correction turn, so a pass is about 619 000 tokens;
 * four passes are still under 0.05 of main.
 *
 * The reserve below is the conservative stand-in until a run measures the lane:
 * 0.05 added to the ratio, so `TRUE <= MAIN × 1.95` rather than `× 1.903`. It is
 * a held budget, not a measurement, and a measured run should replace it.
 */
export const PRUNE_LANE_RESERVE_RATIO = 0.05;
/**
 * The main-only levels recorded when `--token-grant` still metered main prompt
 * alone: at the measured ratio plus the prune reserve (1 + 0.903 + 0.05 =
 * 1.953) they kept TRUE under the two caps, rounded DOWN so the rounding never
 * spent budget.
 *
 *   40 900 000 × 1.953 = 79 877 700 <= 80 000 000
 *   51 200 000 × 1.953 = 99 993 600 <= 100 000 000
 *
 * They are HISTORY, not grant values. `--token-grant` now meters the same TRUE
 * total as this alarm, so the operator passes the cap itself (80 000 000 /
 * 100 000 000); a grant of 40 900 000 would be read as TRUE and kill at half
 * the intended spend. Kept only because the selftest still checks the
 * conversion arithmetic.
 */
export const MAIN_WARN_FOR_80M = 40_900_000;
export const MAIN_STOP_FOR_100M = 51_200_000;

const NUM = new Intl.NumberFormat('en-US');
const n = (value) => NUM.format(value);
/** Bytes per read for the ask journal; one read per poll when the file is quiet. */
const READ_CHUNK = 1 << 20;

/** A directory is walked for `session.v4.jsonl`; anything else is one file. */
function looksLikeDir(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    // Absent. A log path ends in `.jsonl`; an evidence dir does not, and an
    // evidence dir that does not exist yet is the normal state before a launch.
    return !target.toLowerCase().endsWith('.jsonl');
  }
}

/** The file's size, or null when it is absent (neither is an error here). */
function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * A read-only view over ONE path — a session log, or a sessions/evidence root.
 *
 * Both modes share one `UsageTail` per file (`token-watchdog.mjs`), so a missing
 * file, a file being appended while it is read, and a partial last line behave
 * exactly as they do for the in-run watchdog. What this class adds is only the
 * file SET: `SessionUsageWatch` is the model, re-discovering the root on every
 * poll, plus two drop rules and one field.
 *
 * The drop rules exist because the launcher WIPES the evidence dir at start
 * (`bench-run.mjs:2250`). An alarm started a moment too early would otherwise
 * hold a tail over the deleted file and, after the new run re-created the same
 * path, count the previous run's bytes for the rest of this one. So a tail is
 * dropped when its file is gone after having counted something, and when its
 * file is now shorter than the bytes already counted. Both read as "the file
 * this tail was over no longer exists"; a fresh tail then counts the new file
 * from byte 0, which is what the operator is watching.
 *
 * The added field is `outputTokens`, which `SessionUsageWatch` leaves out: the
 * alarm's whole point is to state prompt+output, the run's real spend, beside
 * the prompt-only number the grant meters.
 */
export class UsageSource {
  /**
   * @param {string} target - a session log file, or a directory to walk.
   * @param {{dir?: boolean}} [options] - force file or dir mode; absent, derived
   *   from the path (exists → its kind, absent → `.jsonl` means file).
   */
  constructor(target, { dir } = {}) {
    this.target = resolve(target);
    this.dir = dir ?? looksLikeDir(this.target);
    this.tails = new Map();
  }

  /** One poll: discover the files, drop dead tails, read what each appended. */
  poll() {
    const files = this.dir ? findSessionLogs(this.target) : [this.target];
    const seen = new Set(files);
    for (const [file, tail] of this.tails) {
      const size = sizeOf(file);
      const counted = tail.offset > 0;
      const dead = !seen.has(file) || (size === null ? counted : size < tail.offset);
      if (!dead) continue;
      tail.close();
      this.tails.delete(file);
    }
    const totals = { billedPromptTokens: 0, outputTokens: 0, rows: 0, unparsed: 0, files: 0,
      compactionPromptTokens: 0, compactionOutputTokens: 0, compactionUsageRows: 0 };
    for (const file of files) {
      let tail = this.tails.get(file);
      if (tail === undefined) {
        tail = new UsageTail(file);
        this.tails.set(file, tail);
      }
      const snapshot = tail.poll();
      totals.billedPromptTokens += snapshot.billedPromptTokens;
      totals.outputTokens += snapshot.outputTokens;
      totals.rows += snapshot.rows;
      totals.unparsed += snapshot.unparsed;
      // The host's native compaction call (ISSUE-237): billed usage on
      // `compaction/summary`, carried into the SAME TRUE total the watchdog
      // reads so the alarm cannot disagree with the in-run kill.
      totals.compactionPromptTokens += snapshot.compactionPromptTokens ?? 0;
      totals.compactionOutputTokens += snapshot.compactionOutputTokens ?? 0;
      totals.compactionUsageRows += snapshot.compactionUsageRows ?? 0;
      totals.files += 1;
    }
    return totals;
  }

  close() {
    for (const tail of this.tails.values()) tail.close();
    this.tails.clear();
  }
}

/**
 * One bulk-prune send's identity (ISSUE-178): session, round, the table ordinal
 * the mount journaled, and whether the send was the pass's correction turn.
 *
 * A `prune-table` line and its `prune-ask` line carry the same three fields, so
 * this key is what pairs a SENT table with its measured cost. Two `prune-table`
 * lines from one send (a table settling two attempt groups) share it on purpose:
 * they are one send and one payment.
 * @param {object} record - a parsed journal line.
 * @returns {string|null} the key, or null when the line carries no ordinal.
 */
export function pruneKeyOf(record) {
  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
  const round = Number(record?.round);
  const tables = Number(record?.tables);
  if (!Number.isSafeInteger(round) || !Number.isSafeInteger(tables)) return null;
  const retried = record?.retried === true ? 'c' : 't';
  return `${sessionId}|${round}|${tables}|${retried}`;
}

/**
 * The ask lane's tail over one journal file.
 *
 * Same discipline as `UsageTail` — byte offset, held partial line, absent file is
 * zeros — because the two files are written by different processes at different
 * rates and a poll can land mid-line in either. It cannot reuse `UsageTail`: that
 * class reads `assistant/message` rows through `session-usage.mjs`, and a journal
 * line is not a session event.
 *
 * **One ask is counted once.** A batched entry ask journals ONE `entry-ask` row
 * per result in the batch (`plugin.ts:2251`), every one carrying the whole
 * batch's `usage`, so a naive sum over-counts by the batch size. Three identity
 * rules, in the order the journal allows:
 *
 *   1. `askNodeId` — the appended answer turn every row of one answered batch
 *      names. Exact, and the reason an answered batch is counted once.
 *   2. A `prune-ask` row is ONE send (ISSUE-178): the bulk prune writes one per
 *      table and one per correction turn, so its own identity is the exact key —
 *      never the consecutive-value rule, which would merge two identical-sized
 *      tables into one reading.
 *   3. A refused ask appends no exchange, so no `askNodeId` exists. Its batch
 *      writes its rows consecutively with an identical usage value, so a
 *      consecutive run of identical readings collapses to one. A later identical
 *      reading is a different ask.
 *
 * The counted quantity is `usage.inputTokens`, which the mount writes through
 * `readAssistantUsage` as the host's input + cacheRead + cacheWrite — the same
 * billed prompt the main lane's sum names, so the two numbers add. Its
 * `usage.outputTokens` is counted on the same deduplicated row, because the TRUE
 * total includes completion: a 50M main-prompt grant that ignored ask completion
 * still permitted a larger true spend.
 */
export class AskTail {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.tokens = 0;
    this.outputTokens = 0;
    this.records = 0;
    this.exchanges = 0;
    /** Table keys the mount SAID it sent: `sessionId|round|tables|t|c`. */
    this.pruneSent = new Set();
    /** Table keys that carry a `prune-ask` reading, so no longer unmeasured. */
    this.pruneMeasured = new Set();
    this.unparsed = 0;
    this.seen = new Set();
    this.runKey = null;
  }

  /** Open once; an absent file is a normal state, not an error. */
  #open() {
    if (this.fd !== null) return true;
    try {
      this.fd = openSync(this.file, 'r');
      return true;
    } catch {
      return false;
    }
  }

  /** Account for every complete line the pending buffer now holds. */
  #consume() {
    let start = 0;
    let newline = this.pending.indexOf(0x0a, start);
    while (newline !== -1) {
      const line = this.pending.toString('utf8', start, newline).trim();
      start = newline + 1;
      if (line !== '') this.#account(line);
      newline = this.pending.indexOf(0x0a, start);
    }
    if (start > 0) this.pending = Buffer.from(this.pending.subarray(start));
  }

  #account(line) {
    // The run key collapses a CONSECUTIVE run only, so it is cleared on every
    // line and re-set by the line that is counted.
    const priorRun = this.runKey;
    this.runKey = null;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      this.unparsed += 1;
      return;
    }
    if (!ASK_KINDS.includes(record?.kind)) {
      // A `prune-table` line is the mount SAYING a bulk prune sent a table. When
      // that send also wrote a `prune-ask` reading (ISSUE-178) it is measured;
      // when it did not — an older journal, or a host that reported no usage —
      // the table stays in the remainder TRUE omits, never assumed small.
      if (record?.kind === 'prune-table') {
        const key = pruneKeyOf(record);
        if (key !== null) this.pruneSent.add(key);
      }
      return;
    }
    const usage = record.usage;
    if (usage === null || typeof usage !== 'object') return;
    const inputTokens = Number(usage.inputTokens);
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return;
    // Completion is counted on the same deduplicated row as its prompt, so a
    // batched ask's output is never multiplied by the batch size either.
    const outputTokens = Number(usage.outputTokens ?? 0);
    const output = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
    this.records += 1;
    if (record.kind === 'prune-ask') {
      // One line per bulk-prune send (ISSUE-178): a table, or the correction
      // turn. Its own ordinal is the exact identity, so the consecutive-value
      // rule never applies — two tables that happen to cost the same are two
      // paid sends, not one.
      const key = pruneKeyOf(record);
      if (key !== null) {
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.pruneMeasured.add(key);
      }
      this.tokens += inputTokens;
      this.outputTokens += output;
      this.exchanges += 1;
      return;
    }
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const nodeId = typeof record.askNodeId === 'string' && record.askNodeId !== ''
      ? record.askNodeId : null;
    if (nodeId !== null) {
      const key = `${sessionId}|${nodeId}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    } else {
      const runKey = [sessionId, inputTokens, Number(usage.outputTokens ?? 0),
        String(usage.cachedInputTokens ?? ''), String(record.code ?? '')].join('|');
      this.runKey = runKey;
      if (runKey === priorRun) return;
    }
    this.tokens += inputTokens;
    this.outputTokens += output;
    this.exchanges += 1;
  }

  /** Read what the mount has appended since the last poll. Absent file: zeros. */
  poll() {
    if (!this.#open()) return this.snapshot();
    for (;;) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      let bytes;
      try {
        bytes = readSync(this.fd, buffer, 0, buffer.length, this.offset);
      } catch {
        break; // file replaced or removed mid-run: keep what was counted
      }
      if (bytes <= 0) break;
      this.offset += bytes;
      const chunk = buffer.subarray(0, bytes);
      this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
      this.#consume();
    }
    return this.snapshot();
  }

  snapshot() {
    // The remainder is SENT tables no `prune-ask` reading covers: an old
    // journal, or a host that reported no usage. A table that did carry a
    // reading is measured and must never also be reported as unmeasured.
    let unmeasured = 0;
    for (const key of this.pruneSent) {
      if (!this.pruneMeasured.has(key)) unmeasured += 1;
    }
    return { file: this.file, askTokens: this.tokens, askOutputTokens: this.outputTokens,
      records: this.records, exchanges: this.exchanges, pruneTables: unmeasured,
      unparsed: this.unparsed };
  }

  close() {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed.
      }
      this.fd = null;
    }
  }
}

/**
 * Where the journal may be, for a target the operator named.
 *
 * The launcher's layout is `<world>/evidence/sessions/.../session.v4.jsonl` beside
 * `<world>/evidence/racoons/cremator-events.jsonl`, so an evidence dir resolves in
 * one step and a session-log path walks up to its evidence root. Five levels is
 * enough for the shallowest form the rig writes and stops a walk at the drive
 * root.
 * @param {string} target - the alarm's target, already resolved.
 * @param {boolean} dir - whether the target is a directory.
 * @returns {string[]} candidate journal paths, nearest first.
 */
export function askJournalsFor(target, dir) {
  if (!dir) {
    if (basename(target) === ASK_JOURNAL) return [target];
    const candidates = [];
    let at = dirname(target);
    for (let depth = 0; depth < 5; depth += 1) {
      candidates.push(join(at, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL));
      candidates.push(join(at, ASK_JOURNAL));
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
    return candidates;
  }
  return [join(target, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL), join(target, ASK_JOURNAL)];
}

/**
 * The byte length of every journal that exists for a target, keyed by its
 * resolved path. A RESUME round takes this snapshot before it spawns the child:
 * the journal already holds the adopted session's earlier legs, and the grant
 * is a ceiling for THIS launch, so the ask lane must start where the previous
 * leg ended. A path this map does not name starts at byte 0, which is the right
 * boundary for a normal (wiped) round and for a journal the resumed round
 * creates.
 *
 * This is a recorded byte boundary, not a timestamp or seq: `bench-run.mjs`
 * states it in `result.json` under `resumedFrom.askJournals`, so a reader can
 * re-read the journal from the same offset.
 * @param {string} target - an evidence dir (or a journal path).
 * @param {{dir?: boolean}} [options] - same file/dir switch as `AskSource`.
 * @returns {Map<string, number>} resolved path -> bytes at the snapshot.
 */
export function askJournalOffsets(target, { dir } = {}) {
  const at = resolve(target);
  const offsets = new Map();
  for (const file of askJournalsFor(at, dir ?? looksLikeDir(at))) {
    const size = sizeOf(file);
    if (size !== null) offsets.set(file, size);
  }
  return offsets;
}

/**
 * The ask lane over an evidence dir or a journal path: one `AskTail` per file
 * that exists, summed, with `UsageSource`'s drop rules.
 *
 * `known` is the field that keeps the total honest. An absent journal is not a
 * spend of zero: it means this run has no ask lane measured, so the caller
 * prints `ask n/a` and the total as a lower bound.
 *
 * `startOffsets` is the resume boundary: a `Map` from resolved journal path to
 * the byte length it had when the round launched (see `askJournalOffsets`).
 * Each tail starts at its own entry, so a resumed round's ask sums count only
 * the rows the new leg appended. A file the map does not name starts at 0.
 */
export class AskSource {
  /**
   * @param {string} target - an evidence dir or a journal path.
   * @param {{dir?: boolean, startOffsets?: Map<string, number>|null}} [options]
   */
  constructor(target, { dir, startOffsets = null } = {}) {
    this.target = resolve(target);
    this.dir = dir ?? looksLikeDir(this.target);
    this.candidates = askJournalsFor(this.target, this.dir);
    this.startOffsets = startOffsets;
    this.tails = new Map();
    this.everSeen = false;
  }

  poll() {
    const files = this.candidates.filter((file) => sizeOf(file) !== null);
    if (files.length > 0) this.everSeen = true;
    const seen = new Set(files);
    for (const [file, tail] of this.tails) {
      const size = sizeOf(file);
      const counted = tail.offset > 0;
      const dead = !seen.has(file) || (size === null ? counted : size < tail.offset);
      if (!dead) continue;
      tail.close();
      this.tails.delete(file);
    }
    const totals = { askTokens: 0, askOutputTokens: 0, records: 0, exchanges: 0, pruneAsks: 0,
      unparsed: 0, files: 0, known: this.everSeen || files.length > 0 };
    for (const file of files) {
      let tail = this.tails.get(file);
      if (tail === undefined) {
        tail = new AskTail(file);
        const start = this.startOffsets instanceof Map ? this.startOffsets.get(file) : null;
        const size = sizeOf(file);
        // A boundary past the file's current length means the file was
        // replaced, so it reads from 0 exactly as a dropped tail would.
        tail.offset = Number.isFinite(start) && start >= 0 && size !== null && start <= size
          ? start : 0;
        this.tails.set(file, tail);
      }
      const snapshot = tail.poll();
      totals.askTokens += snapshot.askTokens;
      totals.askOutputTokens += snapshot.askOutputTokens;
      totals.records += snapshot.records;
      totals.exchanges += snapshot.exchanges;
      totals.pruneAsks += snapshot.pruneTables;
      totals.unparsed += snapshot.unparsed;
      totals.files += 1;
    }
    return totals;
  }

  close() {
    for (const tail of this.tails.values()) tail.close();
    this.tails.clear();
  }
}

/**
 * One line, whatever the level: MAIN, ASK and TRUE total, in that order.
 *
 * `ask n/a` is not zero. It says no journal was found, so the total is a LOWER
 * BOUND and the line spells `>=` — the operator must not read a silent ask lane
 * as a spend of nothing.
 */
export function statusLine(level, when, state, { warn, stop }) {
  const main = state.billedPromptTokens;
  const ask = state.askTokens;
  const known = state.askKnown;
  const total = state.trueTotalTokens;
  // TRUE is main prompt + main output + ask prompt + ask output + the native
  // compaction call's prompt and output. The line names the output it counts so
  // its arithmetic stays true; an unknown ask lane contributes no output and
  // the line still says `ask n/a`. The compaction term appears only when the
  // call was billed (ISSUE-237).
  const output = state.outputTokens + (known ? state.askOutputTokens ?? 0 : 0);
  const compaction = (state.compactionPromptTokens ?? 0) + (state.compactionOutputTokens ?? 0);
  const compactionPart = compaction > 0 ? ` + compaction ${n(compaction)}` : '';
  const askPart = known
    ? `ask ${n(ask)}${state.askExchanges > 0 ? ` in ${n(state.askExchanges)} asks` : ''}`
    : 'ask n/a (no journal)';
  const head = `${level} ${when} main ${n(main)} + ${askPart}${compactionPart} + output ${n(output)} = `
    + `${known ? 'TRUE' : 'TRUE >='} ${n(total)}`;
  const remainder = state.pruneAsks > 0
    ? ` [${n(state.pruneAsks)} prune table(s) unmeasured]` : '';
  if (level === 'STOP') {
    return `${head} | reached stop ${n(stop)} (+${n(total - stop)})${remainder}; `
      + 'this alarm kills nothing';
  }
  if (level === 'WARN') {
    return `${head} | past warn ${n(warn)} (+${n(total - warn)}) | stop ${n(stop)}, `
      + `${n(Math.max(0, stop - total))} away${remainder}`;
  }
  return `${head} | warn ${n(warn)}, ${n(Math.max(0, warn - total))} away | `
    + `stop ${n(stop)}${remainder}`;
}

/**
 * The decider: poll both lanes and turn the TRUE total into lines and an exit code.
 *
 * Like the watchdog it shadows, a poll never throws: an alarm that dies stops
 * reporting silently, which is worse than one that reports a stale total.
 *
 * A reading below warn still prints. The request was three numbers at every
 * poll; a run whose TRUE creeps is read before it becomes a shock, which is the
 * whole point of a meter that is not only a tripwire.
 *
 * @param {object} input
 * @param {{poll: () => object, close: () => void}} input.source - `UsageSource` (MAIN).
 * @param {{poll: () => object, close: () => void}|null} [input.askSource] - `AskSource`.
 * @param {number} input.warn - TRUE total for the WARN line.
 * @param {number} input.stop - TRUE total for the STOP line and exit 3.
 * @param {(line: string) => void} [input.out] - one line, already built.
 * @param {() => Date} [input.now] - clock for the line's timestamp.
 * @returns {{state: object, pollOnce: () => object}}
 */
export function createAlarm({ source, askSource = null, warn, stop,
  out = (line) => process.stdout.write(`${line}\n`), now = () => new Date() }) {
  const state = {
    polls: 0,
    billedPromptTokens: 0,
    outputTokens: 0,
    rows: 0,
    unparsed: 0,
    files: 0,
    compactionPromptTokens: 0,
    compactionOutputTokens: 0,
    compactionUsageRows: 0,
    askTokens: 0,
    askOutputTokens: 0,
    askRecords: 0,
    askExchanges: 0,
    askUnparsed: 0,
    askFiles: 0,
    askKnown: false,
    pruneAsks: 0,
    trueTotalTokens: 0,
    lines: 0,
    warned: false,
    warnings: 0,
    warnedAt: null,
    stopReached: false,
    exitCode: 0,
    error: null,
  };

  const pollOnce = () => {
    let totals;
    try {
      totals = source.poll();
    } catch (error) {
      state.error = error?.message ?? String(error);
      return state;
    }
    state.polls += 1;
    state.billedPromptTokens = totals.billedPromptTokens;
    state.outputTokens = totals.outputTokens;
    state.rows = totals.rows;
    state.unparsed = totals.unparsed;
    state.files = totals.files;
    state.compactionPromptTokens = totals.compactionPromptTokens ?? 0;
    state.compactionOutputTokens = totals.compactionOutputTokens ?? 0;
    state.compactionUsageRows = totals.compactionUsageRows ?? 0;
    if (askSource !== null) {
      try {
        const ask = askSource.poll();
        state.askTokens = ask.askTokens;
        state.askOutputTokens = ask.askOutputTokens ?? 0;
        state.askRecords = ask.records;
        state.askExchanges = ask.exchanges;
        state.askUnparsed = ask.unparsed;
        state.askFiles = ask.files;
        state.askKnown = ask.known;
        state.pruneAsks = ask.pruneAsks ?? 0;
      } catch (error) {
        // The main lane still reports; the ask lane keeps its last reading and
        // the total stays a lower bound.
        state.error = error?.message ?? String(error);
      }
    }
    // One arithmetic with the in-run watchdog (`computeTrueTotal`): main prompt
    // + main completion + ask prompt + ask completion + the native compaction
    // call's prompt and completion (ISSUE-237). An unknown ask lane adds nothing
    // and the line prints TRUE as a lower bound, never a silent zero.
    state.trueTotalTokens = computeTrueTotal({
      mainPromptTokens: state.billedPromptTokens,
      mainOutputTokens: state.outputTokens,
      askInputTokens: state.askKnown ? state.askTokens : 0,
      askOutputTokens: state.askKnown ? state.askOutputTokens : 0,
      compactionPromptTokens: state.compactionPromptTokens,
      compactionOutputTokens: state.compactionOutputTokens,
    }).trueTotalTokens;
    // A stopped alarm stays stopped: a later poll would only move the reading
    // past the number the STOP line was decided on.
    if (state.stopReached) return state;
    const when = now().toISOString();
    if (state.trueTotalTokens >= stop) {
      state.stopReached = true;
      state.exitCode = EXIT_STOPPED;
      state.warned = true;
      state.warnedAt ??= when;
      out(statusLine('STOP', when, state, { warn, stop }));
      state.lines += 1;
      return state;
    }
    if (state.trueTotalTokens >= warn) {
      // Every poll past the warn level prints, at the poll interval: the point is
      // an operator who keeps seeing the number, not one line they might miss.
      state.warned = true;
      state.warnings += 1;
      state.warnedAt ??= when;
      out(statusLine('WARN', when, state, { warn, stop }));
      state.lines += 1;
      return state;
    }
    out(statusLine('READ', when, state, { warn, stop }));
    state.lines += 1;
    return state;
  };

  return { state, pollOnce };
}

const HELP = 'usage: token-alarm.mjs <session-log | evidence-dir | journal> [--warn <n>] [--stop <n>]\n'
  + '                       [--interval-ms <n>] [--once] [--ask-journal <path>]\n'
  + '       token-alarm.mjs --selftest\n'
  + '\n'
  + 'Reads TWO lanes and prints three numbers per poll:\n'
  + '  MAIN   billed prompt (inputTokens + cacheReadTokens + cacheWriteTokens) over the\n'
  + '         assistant/message rows of every session.v4.jsonl under the target;\n'
  + '  ASK    usage.inputTokens over the entry-ask / entry-ask-refused / prune-ask rows\n'
  + '         of <evidence>/racoons/cremator-events.jsonl, one per ask (batches deduped,\n'
  + '         bulk-prune tables counted one send each);\n'
  + '  TRUE   MAIN prompt + MAIN output + ASK prompt + ASK output + the native\n'
  + '         compaction call\'s prompt and output (compaction/summary). A missing journal\n'
  + '         prints "ask n/a" and TRUE becomes a lower bound. A prune table with no\n'
  + '         prune-ask row is stated as unmeasured and stays out of ASK, so TRUE is\n'
  + '         never read as complete when it is not.\n'
  + '\n'
  + 'Exits 3 when TRUE is at or past --stop, 0 otherwise, 2 on bad arguments.\n'
  + '\n'
  + '  --warn <n>          first WARN line at or past this TRUE total (default 80000000)\n'
  + '  --stop <n>          exit 3 at or past this TRUE total (default 100000000)\n'
  + '  --interval-ms <n>   poll interval (default 12000, the watchdog\'s own)\n'
  + '  --once              poll once, print the reading, exit\n'
  + '  --log <path>        the target, when you would rather not pass it as an argument\n'
  + '  --ask-journal <path> the journal, when it is not where the evidence layout puts it\n'
  + '  --selftest          fabricate both lanes in a temp dir and drive them past both levels\n'
  + '\n'
  + '--token-grant takes the same TRUE total as --warn/--stop (main prompt + main\n'
  + 'output + ask prompt + ask output). Pass the cap itself: 80 000 000 for the\n'
  + 'warn rule, 100 000 000 for the stop rule. There is no main-only conversion\n'
  + 'any more; the old main-only equivalents are not grant values and would be\n'
  + 'read as TRUE, killing at half the intended spend.\n'
  + '\n'
  + 'ADVISORY ONLY: this script kills nothing. The kill is bench-run.mjs --token-grant.\n';

/** A count argument: a safe integer, or a refused launch with exit 2. */
function countArg(raw, flag) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} takes an integer, got ${raw}`);
  return value;
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const TOKEN_ALARM_OPTIONS = optionsOf([
  ['--selftest', 'boolean'],
  ['--help', 'boolean', 'help', { short: 'h' }],
  ['--once', 'boolean'],
  ['--log', 'string'],
  ['--ask-journal', 'string'],
  ['--warn', 'string'],
  ['--stop', 'string'],
  ['--interval-ms', 'string'],
]);

/** The flags, validated. Throws with a plain message; `main` prints it and exits 2. */
export function parseArgs(argv) {
  const opts = {
    mode: 'watch',
    target: null,
    askJournal: null,
    warn: DEFAULT_WARN,
    stop: DEFAULT_STOP,
    intervalMs: TOKEN_POLL_MS,
    once: false,
  };
  const { values, positionals, order } = parseDevArgs(argv, {
    options: TOKEN_ALARM_OPTIONS,
    allowPositionals: true,
    // This script's own unknown-flag wording; kept exactly.
    unknown: (rawName) => `unknown flag ${rawName}`,
  });
  // --selftest/--help pick the mode; the last one given wins, as the old
  // left-to-right scan did.
  for (const name of order) {
    if (name === 'selftest' || name === 'help') opts.mode = name;
  }
  if (values.once === true) opts.once = true;
  if (values.log !== undefined) opts.target = values.log;
  if (values.askJournal !== undefined) opts.askJournal = values.askJournal;
  if (values.warn !== undefined) opts.warn = countArg(values.warn, '--warn');
  if (values.stop !== undefined) opts.stop = countArg(values.stop, '--stop');
  if (values.intervalMs !== undefined) opts.intervalMs = countArg(values.intervalMs, '--interval-ms');
  if (opts.mode !== 'watch') {
    if (positionals.length > 0 || opts.target !== null) throw new Error(`${opts.mode} takes no target`);
    return opts;
  }
  if (opts.target !== null && positionals.length > 0) {
    throw new Error('name the target once: as an argument or with --log, not both');
  }
  opts.target ??= positionals.pop() ?? null;
  if (positionals.length > 0) throw new Error('one target, not several');
  if (opts.target === null) throw new Error('no target: give a session.v4.jsonl path or an evidence dir');
  if (opts.warn < 0) throw new Error('--warn takes 0 or more');
  if (opts.stop < 1) throw new Error('--stop takes 1 or more');
  // A warn at or past the stop is never seen before the stop prints, so it is a
  // typo — the same judgement `--token-grant 0` gets in the launcher.
  if (opts.warn >= opts.stop) throw new Error('--warn must be below --stop, or it can never be seen first');
  if (opts.intervalMs < 1) throw new Error('--interval-ms takes 1 or more');
  const tooLongInterval = timerDelayRefusal(opts.intervalMs, '--interval-ms');
  if (tooLongInterval !== null) throw new Error(tooLongInterval);
  return opts;
}

/** Poll on an interval until the stop level or Ctrl-C. Resolves to the exit code. */
function watchUntilStopped(alarm, intervalMs) {
  return new Promise((resolveExit) => {
    // The interval is NOT unref'd, unlike the watchdog's: this process has no
    // other work, and an unref'd timer would let it exit on the first tick.
    const timer = setInterval(() => {
      const state = alarm.pollOnce();
      if (state.stopReached) {
        clearInterval(timer);
        resolveExit(state.exitCode);
      }
    }, intervalMs);
    process.once('SIGINT', () => {
      clearInterval(timer);
      process.stdout.write(`token-alarm stopped by operator at TRUE ${n(alarm.state.trueTotalTokens)} `
        + `(main ${n(alarm.state.billedPromptTokens)} + ask ${n(alarm.state.askTokens)})\n`);
      resolveExit(0);
    });
  });
}

/**
 * Fabricate both lanes in a fresh temp dir and drive them past both levels.
 *
 * Small thresholds, not the 80 000 000 defaults: the same code path crosses four
 * levels in a handful of appends, and proving it costs no tokens and no wall
 * clock. The defaults and the calibration constants are asserted separately, so
 * a drift in any of them fails here.
 *
 * The ask lane is proved by construction, not by claim: a fabricated `entry-ask`
 * record is written to the journal and must move the TRUE total past a
 * threshold that MAIN alone never reaches.
 *
 * Every step goes through `UsageSource`, `AskSource` and `createAlarm`, never a
 * copy of them, so what is proved is what an operator runs.
 * @returns {number} 0 when every check held, 1 otherwise.
 */
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'token-alarm-'));
  const sessions = join(root, 'sessions');
  const log = join(sessions, 's1', 'session.v4.jsonl');
  const journalDir = join(root, CREMATOR_EVIDENCE_DIR);
  const journal = join(journalDir, ASK_JOURNAL);
  const warn = 800;
  const stop = 1_200;
  const say = (line) => process.stdout.write(`${line}\n`);
  const failures = [];
  const check = (name, actual, expected) => {
    const ok = Object.is(actual, expected);
    if (!ok) failures.push(`${name}: expected ${expected}, got ${actual}`);
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${name} = ${actual}${ok ? '' : ` (expected ${expected})`}`);
  };
  // The alarm's own output is indented so it cannot be mistaken for a check.
  const out = (line) => say(`    > ${line}`);
  const row = (seq) => JSON.stringify({
    type: 'assistant/message',
    seq,
    data: { usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 10 } },
  });
  const askRow = (fields) => JSON.stringify({ kind: 'entry-ask', atMs: 1,
    sessionId: 's1', ...fields });
  const append = (line) => appendFileSync(log, `${line}\n`);
  const appendAsk = (line) => appendFileSync(journal, `${line}\n`);

  say('token-alarm selftest — fabricated MAIN and ASK lanes in a temp dir; no session, no network, no spend');
  say(`temp dir:    ${root}`);
  say(`main log:    ${log}`);
  say(`ask journal: ${journal}`);
  say(`thresholds:  warn ${n(warn)}, stop ${n(stop)} (defaults and calibration asserted below)`);
  say('');

  const defaults = parseArgs(['x']);
  check('default warn', defaults.warn, DEFAULT_WARN);
  check('default stop', defaults.stop, DEFAULT_STOP);
  check('measured ask/main ratio', MEASURED_ASK_RATIO, 0.903);
  check('the prune lane reserve is held, not assumed away', PRUNE_LANE_RESERVE_RATIO, 0.05);
  // The calibration must never spend past the rule it stands for: round down.
  const multiplier = 1 + MEASURED_ASK_RATIO + PRUNE_LANE_RESERVE_RATIO;
  check('multiplier is the ask ratio plus the prune reserve', multiplier, 1.953);
  check('main 40.9M at 1.953 stays under 80M true',
    MAIN_WARN_FOR_80M * multiplier <= 80_000_000, true);
  check('main 51.2M at 1.953 stays under 100M true',
    MAIN_STOP_FOR_100M * multiplier <= 100_000_000, true);
  // The levels the ticket replaces were only safe while the prune lane was
  // invisible. Stated so a future edit cannot restore them quietly.
  check('the old 42M warn level overspends at 1.953',
    42_000_000 * multiplier > 80_000_000, true);
  check('the old 52.5M grant overspends at 1.953',
    52_500_000 * multiplier > 100_000_000, true);

  const source = new UsageSource(log);
  const askSource = new AskSource(root);
  const alarm = createAlarm({ source, askSource, warn, stop, out });

  say('  step 1  neither file exists yet — a normal state, not an error');
  check('missing file main', alarm.pollOnce().billedPromptTokens, 0);
  check('missing journal is unknown, not zero', alarm.state.askKnown, false);
  check('unknown ask keeps TRUE at main', alarm.state.trueTotalTokens, 0);

  say('  step 2  two main rows appended');
  mkdirSync(dirname(log), { recursive: true });
  append(row(1));
  append(row(2));
  check('two rows main', alarm.pollOnce().billedPromptTokens, 200);
  check('two rows counted', alarm.state.rows, 2);
  check('no journal yet -> TRUE is main prompt + main output', alarm.state.trueTotalTokens, 220);
  check('no WARN yet', alarm.state.warnings, 0);

  say('  step 3  half a main line appended (a read landed mid-write)');
  const third = row(3);
  appendFileSync(log, third.slice(0, Math.floor(third.length / 2)));
  check('partial line held', alarm.pollOnce().billedPromptTokens, 200);
  check('partial line not a row', alarm.state.rows, 2);

  say('  step 4  the rest of that line arrives');
  appendFileSync(log, `${third.slice(Math.floor(third.length / 2))}\n`);
  check('completed line counted', alarm.pollOnce().billedPromptTokens, 300);
  check('completed line is a row', alarm.state.rows, 3);

  say('  step 5  one ASK record appears — the mount writes it mid-run');
  mkdirSync(journalDir, { recursive: true });
  appendAsk(askRow({ eventId: 'e1', unitId: 'u1', action: 'keepall',
    askNodeId: 'n1', answerNodeId: 'a1', batchIndex: 1, batchSize: 1,
    usage: { inputTokens: 200, outputTokens: 5, cachedInputTokens: 150 } }));
  const afterAsk = alarm.pollOnce();
  check('ask tokens read live', afterAsk.askTokens, 200);
  check('ask output tokens read live', afterAsk.askOutputTokens, 5);
  check('ask is one exchange', afterAsk.askExchanges, 1);
  check('TRUE = main prompt + main output + ask prompt + ask output', afterAsk.trueTotalTokens, 535);
  check('journal seen, so ASK is known', afterAsk.askKnown, true);
  check('still below warn', afterAsk.warnings, 0);

  say('  step 6  a batched ask writes ONE row per result; it must count once');
  for (const index of [1, 2, 3]) {
    appendAsk(askRow({ eventId: `b${index}`, unitId: `u${index}`, action: 'keepall',
      askNodeId: 'n2', answerNodeId: 'a2', batchIndex: index, batchSize: 3,
      usage: { inputTokens: 120, outputTokens: 5, cachedInputTokens: 100 } }));
  }
  check('batch counted once', alarm.pollOnce().askTokens, 320);
  check('batch output counted once', alarm.state.askOutputTokens, 10);
  check('batch is one exchange', alarm.state.askExchanges, 2);

  say('  step 7  a refused batch has no askNodeId; its consecutive identical rows count once');
  const refusedRow = (index) => JSON.stringify({ kind: 'entry-ask-refused', atMs: 2,
    sessionId: 's1', eventId: `r${index}`, unitId: `r${index}`, code: 'unreadable',
    retried: false, turns: 1,
    usage: { inputTokens: 90, outputTokens: 0, cachedInputTokens: 0 } });
  appendAsk(refusedRow(1));
  appendAsk(refusedRow(2));
  check('refused batch counted once', alarm.pollOnce().askTokens, 410);
  check('refused batch is one exchange', alarm.state.askExchanges, 3);

  say('  step 8  a fabricated ask crosses WARN while MAIN alone never does');
  appendAsk(askRow({ eventId: 'e3', unitId: 'u3', action: 'keepall',
    askNodeId: 'n3', answerNodeId: 'a3', batchIndex: 1, batchSize: 1,
    usage: { inputTokens: 240, outputTokens: 5, cachedInputTokens: 200 } }));
  const warned = alarm.pollOnce();
  check('main alone stays under warn', warned.billedPromptTokens < warn, true);
  check('TRUE crossed warn on the ask', warned.trueTotalTokens, 995);
  check('one WARN line printed', warned.warnings, 1);
  check('warn alone does not exit', warned.exitCode, 0);

  say('  step 9  a further ask crosses stop');
  appendAsk(askRow({ eventId: 'e4', unitId: 'u4', action: 'keepall',
    askNodeId: 'n4', answerNodeId: 'a4', batchIndex: 1, batchSize: 1,
    usage: { inputTokens: 300, outputTokens: 5, cachedInputTokens: 200 } }));
  const stopped = alarm.pollOnce();
  check('stop crossing TRUE', stopped.trueTotalTokens, 1_300);
  check('stop exit code', stopped.exitCode, EXIT_STOPPED);
  check('stop latched', stopped.stopReached, true);
  check('the streams sum to the total', stopped.billedPromptTokens + stopped.outputTokens
    + stopped.askTokens + stopped.askOutputTokens
    + stopped.compactionPromptTokens + stopped.compactionOutputTokens, 1_300);
  check('output tokens tracked on main', stopped.outputTokens, 30);
  check('output tokens tracked on the ask lane', stopped.askOutputTokens, 20);
  check('no main parse errors', stopped.unparsed, 0);
  check('no journal parse errors', stopped.askUnparsed, 0);
  source.close();
  askSource.close();

  say('  step 10 a directory target finds the mount\'s own journal path');
  const dirAsk = new AskSource(root);
  const dirTotals = dirAsk.poll();
  check('dir mode ask', dirTotals.askTokens, 950);
  check('dir mode ask output', dirTotals.askOutputTokens, 20);
  check('dir mode found one journal', dirTotals.files, 1);
  check('dir mode knows the ask lane', dirTotals.known, true);
  dirAsk.close();

  say('  step 11 a session-log target walks up to the same journal');
  check('walk finds the evidence journal', askJournalsFor(log, false).includes(journal), true);
  const walkedAsk = new AskSource(log, { dir: false });
  check('walked ask', walkedAsk.poll().askTokens, 950);
  walkedAsk.close();

  say('  step 12 a wiped evidence dir resets the ask lane, as the launcher does at start');
  const freshRoot = join(root, 'wiped');
  const freshJournal = join(freshRoot, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL);
  mkdirSync(dirname(freshJournal), { recursive: true });
  appendFileSync(freshJournal, `${askRow({ askNodeId: 'w1', usage: { inputTokens: 111 } })}\n`);
  const wipeSource = new AskSource(freshRoot);
  check('before wipe', wipeSource.poll().askTokens, 111);
  rmSync(freshRoot, { recursive: true, force: true });
  check('after wipe the old count is gone', wipeSource.poll().askTokens, 0);
  mkdirSync(dirname(freshJournal), { recursive: true });
  appendFileSync(freshJournal, `${askRow({ askNodeId: 'w2', usage: { inputTokens: 7 } })}\n`);
  check('the re-created journal counts from byte 0', wipeSource.poll().askTokens, 7);
  wipeSource.close();

  say('  step 12b a resume boundary starts the ask tail at the launch byte length');
  const resumeRoot = join(root, 'resumed');
  const resumeJournal = join(resumeRoot, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL);
  mkdirSync(dirname(resumeJournal), { recursive: true });
  appendFileSync(resumeJournal, `${askRow({ askNodeId: 'old-1', usage: { inputTokens: 400, outputTokens: 40 } })}\n`);
  // Snapshot BEFORE the new leg appends: this is what the launcher records.
  const resumeOffsets = askJournalOffsets(resumeRoot);
  check('the boundary is the journal byte length at launch',
    resumeOffsets.get(resumeJournal), statSync(resumeJournal).size);
  appendFileSync(resumeJournal, `${askRow({ askNodeId: 'new-1',
    usage: { inputTokens: 7, outputTokens: 3 } })}\n`);
  const resumedAsk = new AskSource(resumeRoot, { startOffsets: resumeOffsets });
  const resumedTotals = resumedAsk.poll();
  check('the prior leg ask is excluded', resumedTotals.askTokens, 7);
  check('the prior leg output is excluded', resumedTotals.askOutputTokens, 3);
  check('only the new leg is one exchange', resumedTotals.exchanges, 1);
  check('the resumed journal is still known', resumedTotals.known, true);
  resumedAsk.close();
  // A stale boundary (the file is shorter than the recorded offset) is a
  // replaced file, and counts from byte 0 rather than reading past its end.
  const staleAsk = new AskSource(resumeRoot, {
    startOffsets: new Map([[resumeJournal, statSync(resumeJournal).size + 1]]),
  });
  check('a boundary past the file counts from 0', staleAsk.poll().askTokens, 407);
  staleAsk.close();

  // Read-only, checked rather than claimed: a poll over a quiet file moves no byte.
  const logSizeBefore = statSync(log).size;
  const journalSizeBefore = statSync(journal).size;
  const quiet = new UsageSource(log);
  const quietAsk = new AskSource(root);
  const quietAlarm = createAlarm({ source: quiet, askSource: quietAsk, warn: 10_000, stop: 20_000, out });
  quietAlarm.pollOnce();
  check('poll left the session log byte-identical', statSync(log).size, logSizeBefore);
  check('poll left the journal byte-identical', statSync(journal).size, journalSizeBefore);
  quiet.close();
  quietAsk.close();

  say('  step 13 a bulk-prune send is counted from its own prune-ask record (ISSUE-178)');
  // A table's `prune-table` line says a send happened; its `prune-ask` line is
  // the only thing that states what it cost. Both are written for one send, so
  // the reading must land in ASK exactly once and the remainder must drop to 0.
  const pruneRoot = join(root, 'prune');
  const pruneJournal = join(pruneRoot, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL);
  mkdirSync(dirname(pruneJournal), { recursive: true });
  const pruneAsk = (fields) => JSON.stringify({ kind: 'prune-ask', atMs: 3,
    sessionId: 'p1', round: 1, ...fields });
  const pruneTable = JSON.stringify({ kind: 'prune-table', atMs: 3, sessionId: 'p1',
    round: 1, tables: 1, carried: 0, tableUnits: 8, attempt: 1, answered: 8 });
  appendFileSync(pruneJournal, `${askRow({ sessionId: 'p1', askNodeId: 'pn0',
    usage: { inputTokens: 50, outputTokens: 1 } })}\n`);
  // Two tables of the SAME size: the consecutive-value rule must not merge them.
  appendFileSync(pruneJournal, `${pruneTable}\n`);
  appendFileSync(pruneJournal, `${pruneAsk({ tables: 1, status: 'answered',
    usage: { inputTokens: 400, outputTokens: 20, cachedInputTokens: 350 } })}\n`);
  appendFileSync(pruneJournal, `${pruneAsk({ tables: 2, status: 'refused',
    usage: { inputTokens: 400, outputTokens: 0, cachedInputTokens: 350 } })}\n`);
  const pruneTail = new AskSource(root, { dir: false });
  pruneTail.candidates = [pruneJournal];
  const pruneTotals = pruneTail.poll();
  check('entry + two prune sends all counted', pruneTotals.askTokens, 850);
  check('entry + two prune sends output counted', pruneTotals.askOutputTokens, 21);
  check('three paid sends', pruneTotals.exchanges, 3);
  check('two tables with readings', pruneTotals.records, 3);
  check('no table left unmeasured', pruneTotals.pruneAsks, 0);
  // The same journal without the prune-ask lines is the older shape: its tables
  // are the remainder, and ASK must not read as complete.
  const oldRoot = join(root, 'old');
  const oldJournal = join(oldRoot, CREMATOR_EVIDENCE_DIR, ASK_JOURNAL);
  mkdirSync(dirname(oldJournal), { recursive: true });
  appendFileSync(oldJournal, `${pruneTable}\n`);
  const oldTail = new AskSource(root, { dir: false });
  oldTail.candidates = [oldJournal];
  const oldTotals = oldTail.poll();
  check('an unjournaled prune table adds no tokens', oldTotals.askTokens, 0);
  check('and is stated as unmeasured', oldTotals.pruneAsks, 1);
  pruneTail.close();
  oldTail.close();

  say('  step 14 a target with no journal prints ask n/a, never a zero');
  const bareRoot = join(root, 'bare');
  mkdirSync(join(bareRoot, 'sessions', 's1'), { recursive: true });
  appendFileSync(join(bareRoot, 'sessions', 's1', 'session.v4.jsonl'), `${row(9)}\n`);
  const bareMain = new UsageSource(bareRoot);
  const bareAsk = new AskSource(bareRoot);
  const bare = createAlarm({ source: bareMain, askSource: bareAsk, warn: 10_000, stop: 20_000, out });
  const bareState = bare.pollOnce();
  check('bare arm ask unknown', bareState.askKnown, false);
  check('bare arm TRUE is main prompt + main output', bareState.trueTotalTokens, 110);
  check('status line says n/a', /ask n\/a/u.test(statusLine('READ', 'now', bareState,
    { warn: 10_000, stop: 20_000 })), true);
  bareMain.close();
  bareAsk.close();

  if (failures.length === 0) {
    rmSync(root, { recursive: true, force: true });
    say('');
    say(`selftest: ok — MAIN and ASK both crossed, TRUE ${n(stop)} exited ${EXIT_STOPPED}, `
      + 'temp dir removed');
    return 0;
  }
  say('');
  for (const failure of failures) say(`selftest: FAILED — ${failure}`);
  say(`selftest: temp dir left for inspection: ${root}`);
  return 1;
}

/** Parse, run, and hand back an exit code. Never throws past the usage errors. */
export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`token-alarm.mjs: ${error.message}\n\n${HELP}`);
    return EXIT_USAGE;
  }
  if (opts.mode === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.mode === 'selftest') return selftest();

  const source = new UsageSource(opts.target);
  const askSource = new AskSource(opts.askJournal ?? opts.target);
  const alarm = createAlarm({ source, askSource, warn: opts.warn, stop: opts.stop });
  process.stdout.write(`token-alarm watching ${source.target} (${source.dir ? 'dir' : 'file'}) every `
    + `${n(opts.intervalMs)}ms: warn ${n(opts.warn)}, stop ${n(opts.stop)} on the TRUE total `
    + '(main prompt + main output + every ask: entry-ask and bulk-prune). The journal is read live; a prune table '
    + 'with no prune-ask record is named as unmeasured. Advisory — this kills nothing.\n');

  const first = alarm.pollOnce();
  if (first.error !== null) {
    process.stderr.write(`token-alarm.mjs: cannot read ${source.target}: ${first.error}\n`);
    source.close();
    askSource.close();
    return EXIT_USAGE;
  }
  if (!first.askKnown) {
    process.stderr.write('token-alarm.mjs: no cremator-events.jsonl beside the target yet; '
      + 'ASK reads n/a and TRUE is main prompt + main output + the native compaction call, if any. '
      + 'On a racoons arm the journal appears when the '
      + 'mount writes its first event — if it never does, this run has no ask lane measured.\n');
  }
  if (first.stopReached || opts.once) {
    // A poll that printed (READ/WARN/STOP) already stated the reading; only a
    // silent one needs the line spelled out here.
    if (first.lines === 0) {
      process.stdout.write(`${statusLine('READ', new Date().toISOString(), first, opts)}\n`);
    }
    source.close();
    askSource.close();
    return first.exitCode;
  }
  const code = await watchUntilStopped(alarm, opts.intervalMs);
  source.close();
  askSource.close();
  return code;
}

// Importable without running — the alarm's pieces are what `--selftest` drives.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // `process.exitCode`, not `process.exit`: a kill here can truncate a piped
  // stdout on Windows, and the operator's whole signal is these lines.
  process.exitCode = await main(process.argv.slice(2));
}
