#!/usr/bin/env node
/**
 * In-run token watchdog (the G4 gap): a live arm is stopped DURING the run when
 * its billed prompt spend reaches a grant, not after it.
 *
 * Why it exists. The launcher's kill timer is a wall-clock box (`--kill-ms`); the
 * token stop rules (80 000 000 per arm; 40 000 000 with no forced loss) are
 * computed by `derive-run-b.mjs` from a FINISHED session log. Between a launch
 * and its 90-minute box there was nothing measuring spend, so an arm that
 * burned tokens fast ran to the box and the stop rule only explained it
 * afterwards. This module closes that: it tails the session log the child is
 * writing and, at or past `--token-grant`, the launcher kills the tree through
 * the same `taskkill /PID <pid> /T /F` path the kill timer uses.
 *
 * Three properties the design turns on:
 *
 *   - The main-prompt stream is the DERIVATION's (see `session-usage.mjs`):
 *     input + cacheRead + cacheWrite per `assistant/message`, which is the
 *     prompt the product's own reader hands the meter. The grant is compared
 *     against the TRUE total of six streams — that main prompt, main output,
 *     ask prompt, ask output, and the host's native compaction prompt and
 *     output (`computeTrueTotal`) — because the ask lane the session log never
 *     sees, the completion it does, and the compaction call it also carries are
 *     all billed. The arithmetic is shared with `token-alarm.mjs`, so the two
 *     meters cannot kill or warn on different numbers.
 *   - Reading is incremental. A session log reaches tens of megabytes, and a
 *     full re-parse every poll would take CPU from the arm being measured. Each
 *     file keeps a byte offset, a pending partial line, and running sums.
 *   - Nothing is assumed to exist: before the child creates its session dir the
 *     poll finds no file and reports 0, and a file that appears later is picked
 *     up on the next poll. A malformed line is counted and skipped, never
 *     thrown: a watchdog that dies stops measuring silently.
 *
 * The watchdog is inert without a grant: `createTokenWatchdog({grant: null})`
 * starts no interval and reads no file, and its state still states
 * `tokenGrant: null` so `result.json` says "no grant" instead of implying one.
 *
 * `stopOnCompaction` (ISSUE-182) is a second, independent stop condition: the
 * session's FIRST native compaction (`compaction/start`), not a budget. The
 * owner wants a live run that ends at the host's first forced loss to read the
 * prune behaviour up to that point without paying for the rest of the task.
 * The same incremental pass counts the row and the `step/start` rows that place
 * it, and `createTokenWatchdog` fires `onCompaction` once. A stop is a landmark,
 * not a failure — the caller labels it; this module only states the fact. The
 * flag is inert when off: nothing extra is counted, no state key is added, and
 * `watchdogRecord` emits the same object it always did.
 */
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { compactionUsageRow, usageGap, usageRow } from './session-usage.mjs';

/** The session file dsh appends each event to. */
export const SESSION_LOG_NAME = 'session.v4.jsonl';
/**
 * A host that names the log itself (`session-<id>.v4.jsonl`). `bench-run.mjs`
 * already reads both names back; the in-run watchdog must watch both, or a
 * host-named log holds the grant open for the whole run.
 */
export const SESSION_LOG_ID_PATTERN = /^session-.+\.v4\.jsonl$/u;
/**
 * The poll interval. A grant is a spend ceiling, not a deadline: 12 s of
 * overshoot at a few thousand billed tokens per step is far below the step
 * granularity of any rule stated in millions, and 4–5 polls a minute is cheap
 * against a run that lasts tens of minutes.
 */
export const TOKEN_POLL_MS = 12_000;
/** Bytes per read. One read per poll when the file is quiet, several when it grew. */
const READ_CHUNK = 1 << 20;

/**
 * Every session log under a sessions root, sorted so the sum is stable. Both
 * the canonical `session.v4.jsonl` and a host-named `session-<id>.v4.jsonl`
 * are watched: a host that names its own log must not escape the grant.
 */
export function findSessionLogs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent root: the child has not written its session dir yet
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()
        && (entry.name === SESSION_LOG_NAME || SESSION_LOG_ID_PATTERN.test(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

const EMPTY = Object.freeze({
  billedPromptTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  outputTokens: 0, totalTokens: 0,
  rows: 0, unparsed: 0,
  // The native compaction call's own billed usage (ISSUE-237), kept apart from
  // the assistant-turn totals: the same six field names under `compaction*` so
  // a reader cannot confuse the compaction call with a main prompt step.
  compactionPromptTokens: 0, compactionOutputTokens: 0, compactionUsageRows: 0,
  // Usage rows whose object carried no recognizable prompt-side token field
  // (fourteenth audit item 2). They are never summed; the count is what makes
  // the watchdog refuse instead of reporting a 0 it did not read.
  unrecognized: 0,
});

/**
 * A tail over one growing file: byte offset, pending partial line, running sums.
 *
 * A partial last line is held, never parsed: a poll can land in the middle of a
 * JSON object the child is still writing, and counting a truncated line as
 * unparsed would make the "unparsed" count describe a timing accident.
 *
 * The same pass also keeps the session's FIRST native compaction (ISSUE-182):
 * `compaction/start` rows and the `step/start` rows that place them. The row
 * carries no step of its own — `compaction-basic` fires in `agent/pre-step`, so
 * it belongs to the step it precedes, and `step` below is that step (the last
 * `step/start` seen plus one, never the compaction's own `seq`, which would
 * name an event rather than a step). The counters ride on the tail, not on
 * `snapshot()`, so a caller that only wants usage sees exactly what it saw
 * before this existed.
 */
export class UsageTail {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.totals = { ...EMPTY };
    /** How many `compaction/start` rows this file has carried. */
    this.compactions = 0;
    /** The first one, or null: `{file, seq, turn, step, stepsStarted, billedPromptTokens}`. */
    this.firstCompaction = null;
    /** `step/start` rows accounted, and the last one's `(turn, step)`. */
    this.stepsStarted = 0;
    this.lastStep = null;
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
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.totals.unparsed += 1;
      return;
    }
    // The first native compaction, counted BEFORE the usage-row filter below:
    // `compaction/start` and `step/start` carry no `data.usage`, so a counter
    // placed after the early return would never see them.
    //
    // `step` is "how many `step/start` rows came before this one, plus one" —
    // the SAME derivation `compactionEvents` uses for its `atRequests`
    // (`bench-run.mjs`), so the live stop and the post-run reader cannot state
    // different step numbers for one event. It is not the compaction's own
    // `seq`: that names an event, not a step. On the recorded session this reads
    // seq 1429 as step 175, which is how
    // `docs/plans/2026-10-29-prompt-forget-lanes/plan.md:22` reads it too.
    if (event.type === 'step/start') {
      this.stepsStarted += 1;
      this.lastStep = { turn: event.data?.turn ?? null, step: event.data?.step ?? null };
      return;
    }
    if (event.type === 'compaction/start') {
      this.compactions += 1;
      if (this.firstCompaction === null) {
        this.firstCompaction = {
          file: this.file,
          seq: typeof event.seq === 'number' ? event.seq : null,
          turn: event.data?.turn ?? this.lastStep?.turn ?? null,
          step: this.stepsStarted + 1,
          stepsStarted: this.stepsStarted,
          // The billed total AS OF this row: the sum of the usage rows read
          // before it in this same pass. Reading it from the poll's end total
          // instead would state a spend the compaction never saw — with a 12 s
          // poll and a growing file, that difference is the whole tail of the
          // poll, and it would make "spend up to the stop" mean "spend up to
          // whenever the poll happened to finish".
          billedPromptTokens: this.totals.billedPromptTokens,
        };
      }
      return;
    }
    // The compaction call is billed like a provider step (ISSUE-237). It is
    // summed into its own pair of streams, never into the assistant-turn rows:
    // `compactionUsageRows` is also the count the grant's completeness check
    // compares against `compaction/start`. A summary whose usage is absent or
    // unrecognized adds no row, so the check fails closed instead of billing 0.
    if (event.type === 'compaction/summary') {
      const row = compactionUsageRow(event);
      if (row !== null) {
        this.totals.compactionUsageRows += 1;
        this.totals.compactionPromptTokens += row.billedTokens;
        this.totals.compactionOutputTokens += row.outputTokens;
      }
      return;
    }
    // The row shape and the sum belong to `session-usage.mjs`; this class only
    // decides WHEN a row is complete enough to read.
    const row = usageRow(event);
    if (row === null) {
      // A usage object with no recognizable prompt-side field is a refusal, not
      // a zero: counting it as 0 would let a renamed field hold the grant below
      // its ceiling forever (fourteenth audit item 2).
      if (usageGap(event) === 'unrecognized') this.totals.unrecognized += 1;
      return;
    }
    this.totals.rows += 1;
    this.totals.inputTokens += row.inputTokens;
    this.totals.cacheReadTokens += row.cacheReadTokens;
    this.totals.cacheWriteTokens += row.cacheWriteTokens;
    this.totals.billedPromptTokens += row.billedTokens;
    this.totals.outputTokens += row.outputTokens;
    this.totals.totalTokens += row.totalTokens;
  }

  /**
   * Read what the child has appended since the last poll. Absent file: zeros.
   *
   * `final` is the last read of a finished child: the session log's last line
   * may carry no trailing newline (a writer that never flushed one), and the
   * pending-buffer rule would hold it forever. On a final poll the pending bytes
   * are accounted, so a complete last row is not lost to a missing newline. A
   * poll that is not final keeps holding it: the child may still be writing.
   * @param {boolean} [final] - account the trailing line with no newline.
   */
  poll(final = false) {
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
    if (final) this.#consumeTail();
    return this.snapshot();
  }

  /**
   * Account the held trailing line, if any, and clear it. A malformed trailing
   * fragment is counted as unparsed by `#account`, never thrown.
   */
  #consumeTail() {
    if (this.pending.length === 0) return;
    const line = this.pending.toString('utf8').trim();
    this.pending = Buffer.alloc(0);
    if (line !== '') this.#account(line);
  }

  snapshot() {
    // `unrecognized` is stated only when a row was refused, so a healthy tail
    // keeps the key list it always had (ISSUE-182's inertness convention). The
    // counter still rides on `this.totals`, so `SessionUsageWatch` sums it.
    const { unrecognized, ...rest } = this.totals;
    return { file: this.file, ...rest, ...(unrecognized > 0 ? { unrecognized } : {}) };
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
 * The watch over a sessions ROOT: one tail per session file, summed.
 *
 * Summing every file (not "the newest") is deliberate: the launcher's post-run
 * totals also flatten every session log, so if dsh ever writes a second one the
 * watchdog and the derivation still agree. `files` names what was summed.
 *
 * `firstCompaction` is the FIRST `compaction/start` across the files, in the
 * same sorted file order the sum uses, so a second session log cannot move the
 * landmark an already-fired stop was decided on. The step it names is that
 * file's own step counter — steps are numbered per session, and a stop is
 * always decided inside one session.
 */
export class SessionUsageWatch {
  constructor(sessionsDir) {
    this.sessionsDir = sessionsDir;
    this.tails = new Map();
    this.totals = { billedPromptTokens: 0, outputTokens: 0, rows: 0, unparsed: 0,
      compactionPromptTokens: 0, compactionOutputTokens: 0, compactionUsageRows: 0, files: [] };
    /** The first `compaction/start` seen across every tail, or null. */
    this.firstCompaction = null;
    /** `compaction/start` rows summed over every tail. */
    this.compactions = 0;
  }

  /**
   * One poll: discover session files, read what each appended, sum.
   * @param {boolean} [final] - a finished child's last read: a trailing line
   *   with no newline is accounted instead of held (see `UsageTail.poll`).
   */
  poll(final = false) {
    const files = findSessionLogs(this.sessionsDir);
    let billed = 0;
    let output = 0;
    let rows = 0;
    let unparsed = 0;
    let unrecognized = 0;
    let compactions = 0;
    let compactionPrompt = 0;
    let compactionOutput = 0;
    let compactionUsageRows = 0;
    for (const file of files) {
      let tail = this.tails.get(file);
      if (tail === undefined) {
        tail = new UsageTail(file);
        this.tails.set(file, tail);
      }
      const snapshot = tail.poll(final);
      billed += snapshot.billedPromptTokens;
      output += snapshot.outputTokens;
      rows += snapshot.rows;
      unparsed += snapshot.unparsed;
      unrecognized += snapshot.unrecognized ?? 0;
      compactionPrompt += snapshot.compactionPromptTokens ?? 0;
      compactionOutput += snapshot.compactionOutputTokens ?? 0;
      compactionUsageRows += snapshot.compactionUsageRows ?? 0;
      compactions += tail.compactions;
      // Sorted order, first wins: a later file can add to the COUNT and never
      // replace the landmark.
      if (this.firstCompaction === null && tail.firstCompaction !== null) {
        this.firstCompaction = tail.firstCompaction;
      }
    }
    this.compactions = compactions;
    this.totals = { billedPromptTokens: billed, outputTokens: output, rows, unparsed,
      compactionPromptTokens: compactionPrompt, compactionOutputTokens: compactionOutput,
      compactionUsageRows, files, ...(unrecognized > 0 ? { unrecognized } : {}) };
    return this.totals;
  }

  close() {
    for (const tail of this.tails.values()) tail.close();
    this.tails.clear();
  }
}

/**
 * The fully typed trailing line of a finished child, or null. The launcher uses
 * it for the last read; a caller that only wants incrementality uses `poll()`.
 */
export function finalSessionPoll(watch) {
  return typeof watch?.poll === 'function' ? watch.poll(true) : null;
}

/**
 * A token count, with anything that is not a finite number read as 0. A usage
 * field the host omitted must not turn the sum into `NaN`, which compares false
 * against every grant and would hold a ceiling open forever.
 */
const countOr0 = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * The TRUE spend of a run: the six streams that are billed, summed once.
 *
 * The grant used to compare `billedPromptTokens` from `assistant/message` rows,
 * which is main prompt only. Asks never enter the session log
 * (`packages/adapters/dsh/src/llm-ask.ts` writes their usage to the mount
 * journal), completion tokens are summed but were never compared, and the
 * host's native compaction call (ISSUE-237) was outside every stream. A 50M
 * main-only grant therefore permitted a true spend of roughly 66–73M on the
 * measured 0.32/0.47 ask/main ratios. This is the one arithmetic both the
 * in-run watchdog and the standalone alarm call, so the two can never disagree
 * about a number an operator is watching.
 *
 * `streams` is the six inputs after the count coercion, so a caller can record
 * the components beside the total without re-deriving them. The compaction
 * prompt is its billed prompt (input + cacheRead + cacheWrite), never
 * `totalTokens`, and never `shadowedTokenCount` — that field measures what the
 * compaction removed, not what the call cost.
 * @param {object} input
 * @param {number} [input.mainPromptTokens] - billed prompt over `assistant/message`.
 * @param {number} [input.mainOutputTokens] - completion over `assistant/message`.
 * @param {number} [input.askInputTokens] - billed ask prompt (mount journal).
 * @param {number} [input.askOutputTokens] - ask completion (mount journal).
 * @param {number} [input.compactionPromptTokens] - billed prompt of `compaction/summary`.
 * @param {number} [input.compactionOutputTokens] - completion of `compaction/summary`.
 * @returns {{trueTotalTokens: number, streams: {mainPromptTokens: number,
 *   mainOutputTokens: number, askInputTokens: number, askOutputTokens: number,
 *   compactionPromptTokens: number, compactionOutputTokens: number}}}
 */
export function computeTrueTotal({
  mainPromptTokens = 0, mainOutputTokens = 0, askInputTokens = 0, askOutputTokens = 0,
  compactionPromptTokens = 0, compactionOutputTokens = 0,
} = {}) {
  const streams = {
    mainPromptTokens: countOr0(mainPromptTokens),
    mainOutputTokens: countOr0(mainOutputTokens),
    askInputTokens: countOr0(askInputTokens),
    askOutputTokens: countOr0(askOutputTokens),
    compactionPromptTokens: countOr0(compactionPromptTokens),
    compactionOutputTokens: countOr0(compactionOutputTokens),
  };
  return {
    trueTotalTokens: streams.mainPromptTokens + streams.mainOutputTokens
      + streams.askInputTokens + streams.askOutputTokens
      + streams.compactionPromptTokens + streams.compactionOutputTokens,
    streams,
  };
}

/**
 * The controller: poll on an interval, and when the running billed total is at
 * or past the grant, fire ONCE and hand the kill to the caller.
 *
 * Both processes record their own facts. The launcher's kill timer keeps
 * `watchdog.fired`; this keeps `tokenFired`/`observedPromptTokens`/`firedAt`.
 * Either may fire, and the launcher's failure path is shared: a grant reached
 * is a timeout of the budget, exactly like a box reached is a timeout of the
 * clock, so both end at the same exit code.
 *
 * `stopOnCompaction` is the landmark stopper (ISSUE-182): at the session's FIRST
 * `compaction/start` the watchdog fires once and hands the kill to
 * `onCompaction`, and the launcher labels the run as stopped rather than
 * failed. It is a separate stop condition with its own state, so the grant's
 * fields keep meaning exactly what they meant, and a run that names no flag
 * counts nothing and fires nothing.
 *
 * Both stops are one-way: `fired` guards every branch, so a row that repeats
 * (a resumed session, a re-read file) cannot fire a second time, and the two
 * can never both fire — whoever reaches the poll first wins and the interval is
 * cleared.
 *
 * @param {object} input
 * @param {number|null} input.grant - TRUE token ceiling, or null (inert).
 * @param {boolean} [input.stopOnCompaction] - stop at the first native compaction.
 * @param {{poll: () => {billedPromptTokens: number, outputTokens?: number}}} input.watch
 *   - the main source; with `stopOnCompaction` it must also expose
 *   `firstCompaction`.
 * @param {{poll: () => {askTokens: number, askOutputTokens?: number, known?: boolean}}|null}
 *   [input.askSource] - the mount journal's ask lane (`token-alarm.mjs`'s
 *   `AskSource`). Absent means no ask lane is measured: the true total is main
 *   prompt + main output, a lower bound. The watchdog never imports that class
 *   (the alarm imports this module), so the shape is structural.
 * @param {number} [input.pollMs] - interval; tests pass a short one.
 * @param {(event: {observedPromptTokens: number, firedAt: string}) => void} [input.onGrant]
 *   - the kill. Called exactly once, after the state records the fire.
 * @param {(event: {seq: number|null, step: number, turn: number|null,
 *   observedPromptTokens: number, compactions: number, firedAt: string}) => void} [input.onCompaction]
 *   - the kill, at the first compaction. Called exactly once.
 * @param {() => number} [input.now] - clock for `firedAt`.
 * @returns {{state: object, start: () => void, stop: () => void,
 *   pollOnce: (options?: {final?: boolean}) => object, finalPoll: () => object}}
 */
export function createTokenWatchdog({
  grant, stopOnCompaction = false, watch, askSource = null, pollMs = TOKEN_POLL_MS,
  onGrant = () => {}, onCompaction = () => {}, now = () => Date.now(),
}) {
  const state = {
    tokenGrant: grant === undefined ? null : grant,
    tokenFired: false,
    observedPromptTokens: grant === undefined || grant === null ? null : 0,
    // The true spend the grant is compared against, and its six streams. The
    // grant used to read `observedPromptTokens` alone (main prompt); an ask the
    // session log never sees, a completion the sum never compared, and the
    // host's native compaction call (ISSUE-237) could all sit outside the
    // ceiling. `observedPromptTokens` stays the main-prompt reading for every
    // existing caller.
    trueTotalTokens: 0,
    mainPromptTokens: 0,
    mainOutputTokens: 0,
    askInputTokens: 0,
    askOutputTokens: 0,
    askKnown: false,
    // The compaction call's own streams and row count. `compactionUsageComplete`
    // is false when the log started more compactions than it stated a billable
    // summary for, so the grant is a lower bound on that call and must fail
    // closed. A zero-compaction run states 0 / true.
    compactionPromptTokens: 0,
    compactionOutputTokens: 0,
    compactionUsageRows: 0,
    compactionUsageComplete: true,
    firedAt: null,
    polls: 0,
    error: null,
    // A usage row whose object carried no recognizable prompt-side token field.
    // It is never summed; `refused` says the running total is not a reading of
    // this session's spend, so a grant check on it fails closed (fourteenth
    // audit item 2). Both keys are always present: an absent field would let a
    // caller mistake "not read" for "0 bad rows".
    usageUnrecognized: 0,
    refused: false,
    // The compaction stopper's own facts. Written only when the stop was asked
    // for, so an existing run's `watchdog` object gains no keys.
    ...(stopOnCompaction
      ? { stopOnCompaction: true, compactionFired: false, compactionStoppedAt: null }
      : {}),
  };
  let timer = null;
  // One guard for both stops: the run is being killed, so a second fire would
  // only send a second `taskkill` at a pid the first one is already reaping.
  let killed = false;

  /**
   * One poll. Never throws: a watchdog that dies stops measuring silently.
   * @param {{final?: boolean}} [options] - `final` is the last read of a
   *   finished child: a trailing line with no newline is accounted.
   */
  const pollOnce = ({ final = false } = {}) => {
    let totals;
    try {
      totals = final ? watch.poll(true) : watch.poll();
    } catch (error) {
      state.error = error?.message ?? String(error);
      return state;
    }
    state.polls += 1;
    state.observedPromptTokens = totals.billedPromptTokens;
    // The ask lane lives in the mount's journal, never in the session log
    // (`llm-ask.ts` writes it there). A read that fails keeps the last known
    // reading and records the error: the grant is then a lower bound, and
    // `tokenGrantGates` fails the run closed on that error.
    if (askSource !== null) {
      try {
        const ask = askSource.poll();
        state.askInputTokens = countOr0(ask?.askTokens);
        state.askOutputTokens = countOr0(ask?.askOutputTokens);
        state.askKnown = ask?.known === true;
      } catch (error) {
        state.error = error?.message ?? String(error);
      }
    }
    // One arithmetic, shared with `token-alarm.mjs`'s TRUE total: main prompt +
    // main completion + ask prompt + ask completion + the compaction call's
    // prompt and completion. A fake or older `watch` that states no output reads
    // as 0, never `NaN`. The compaction streams are read from the same poll, so
    // the in-run number and a finished-log re-read agree by construction.
    const compactionRows = countOr0(totals.compactionUsageRows);
    const trueTotal = computeTrueTotal({
      mainPromptTokens: totals.billedPromptTokens,
      mainOutputTokens: totals.outputTokens,
      askInputTokens: state.askInputTokens,
      askOutputTokens: state.askOutputTokens,
      compactionPromptTokens: totals.compactionPromptTokens,
      compactionOutputTokens: totals.compactionOutputTokens,
    });
    state.mainPromptTokens = trueTotal.streams.mainPromptTokens;
    state.mainOutputTokens = trueTotal.streams.mainOutputTokens;
    state.compactionPromptTokens = trueTotal.streams.compactionPromptTokens;
    state.compactionOutputTokens = trueTotal.streams.compactionOutputTokens;
    state.compactionUsageRows = compactionRows;
    // `compaction/start` rows the watch counted; a fake watch that exposes none
    // reads as 0, so a total with no compaction rows is complete.
    state.compactionUsageComplete = countOr0(watch.compactions) <= state.compactionUsageRows;
    state.trueTotalTokens = trueTotal.trueTotalTokens;
    state.usageUnrecognized = totals.unrecognized ?? 0;
    if (state.usageUnrecognized > 0) {
      // Refuse the reading, do not sum past it: a renamed usage field reads 0,
      // and a 0 the grant compares against would never fire. The caller turns
      // this state into a failed row; the watchdog does not silently stop.
      state.refused = true;
      state.error = `${String(state.usageUnrecognized)} usage row(s) carried no recognizable prompt token field; `
        + 'the billed total is not a reading of this run\'s spend';
    }
    if (killed) return state;
    if (state.tokenGrant !== null && state.trueTotalTokens >= state.tokenGrant) {
      killed = true;
      state.tokenFired = true;
      state.firedAt = new Date(now()).toISOString();
      // Stop first, then kill: the kill makes the child exit, and another poll
      // would only move the reading past the number the fire was decided on.
      stop();
      try {
        onGrant({ observedPromptTokens: state.observedPromptTokens, firedAt: state.firedAt });
      } catch (error) {
        state.error = error?.message ?? String(error);
      }
      return state;
    }
    // The same ceiling, read from the other side: a compaction seen in the same
    // poll the grant would have fired on is still a compaction stop, but the
    // grant is checked first so a spend ceiling is never softened by a landmark.
    const found = stopOnCompaction ? watch.firstCompaction ?? null : null;
    if (found !== null) {
      killed = true;
      state.compactionFired = true;
      state.compactionStoppedAt = {
        seq: found.seq ?? null,
        step: found.step ?? null,
        turn: found.turn ?? null,
        // The tail's own total AT that row, not the poll's end total: a poll can
        // read rows written after the compaction, and "spend up to the stop" is
        // the number the stop was decided on. `observedPromptTokens` stays the
        // grant's field and keeps its own meaning.
        billedPromptTokens: found.billedPromptTokens ?? totals.billedPromptTokens,
        // How many `compaction/start` rows the log held at the poll that fired.
        // The stop is decided on the FIRST (`seq` names it) and a run is killed
        // at once, so a number past 1 means the child wrote several between two
        // polls — a fact worth seeing, never a second stop.
        compactions: watch.compactions ?? null,
        firedAt: new Date(now()).toISOString(),
      };
      stop();
      try {
        onCompaction({ ...state.compactionStoppedAt });
      } catch (error) {
        state.error = error?.message ?? String(error);
      }
    }
    return state;
  };

  const start = () => {
    // Inert means inert: no grant and no compaction stop is nothing to measure,
    // so no file is read at all.
    if ((state.tokenGrant === null && !stopOnCompaction) || timer !== null || killed) return;
    pollOnce();
    if (killed) return;
    timer = setInterval(pollOnce, pollMs);
    // Never keep the launcher (or a test) alive on the watchdog's account.
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  /**
   * The last read, after the child exited: flush the trailing line a writer
   * left without a newline, then take the same reading the interval takes. The
   * launcher calls this before it stops the watchdog, so a session log whose
   * final usage row has no newline still states its spend.
   */
  const finalPoll = () => pollOnce({ final: true });

  return { state, start, stop, pollOnce, finalPoll };
}

/**
 * The `watchdog` object `result.json` carries, the kill timer's keys first.
 *
 * The compaction stopper's keys appear ONLY when `stopOnCompaction` was asked
 * for, so a run that never named the flag writes the same object it always did
 * (ISSUE-182's inertness requirement, held at the record, not just at the poll).
 *
 * The true-total fields are the accounting the grant is compared against. They
 * are stated as null when no reading was taken (no grant and no poll), never as
 * 0, which would read as a spend. `observedPromptTokens` is kept as the main
 * prompt reading every existing reader already uses.
 */
export function watchdogRecord({
  command, timeoutMs, fired, tokenGrant, tokenFired, observedPromptTokens, firedAt, pollMs,
  stopOnCompaction, compactionFired, compactionStoppedAt, compactions,
  usageUnrecognized, refused, error, polls,
  trueTotalTokens, mainPromptTokens, mainOutputTokens, askInputTokens, askOutputTokens, askKnown,
  compactionPromptTokens = 0, compactionOutputTokens = 0, compactionUsageRows = 0,
  compactionUsageComplete = true,
}) {
  // A reading exists when a grant armed the watchdog (it polls on start) or a
  // poll is recorded. Without one, the accounting fields are null like
  // `observedPromptTokens`, never a 0 that reads as a spend.
  const read = (tokenGrant !== undefined && tokenGrant !== null) || Number(polls ?? 0) > 0;
  const counted = (value) => (read && Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    command,
    timeoutMs,
    fired,
    // Added for the in-run token watchdog. An absent grant is stated as null so
    // a reader cannot mistake "no ceiling was set" for "the ceiling held".
    tokenGrant: tokenGrant === undefined ? null : tokenGrant,
    tokenFired: tokenFired === true,
    // The main-prompt reading the grant historically compared. Kept for
    // compatibility; `mainPromptTokens` below is the same number under the
    // true-total naming.
    observedPromptTokens: tokenGrant === undefined || tokenGrant === null ? null : observedPromptTokens,
    firedAt: tokenFired === true ? firedAt : null,
    pollMs: tokenGrant === undefined || tokenGrant === null ? null : pollMs,
    // The watchdog's own liveness, always stated. `polls` is how many successful
    // reads the grant was checked on — 0 says the ceiling was never read — and
    // `error` is the poll's refusal (unreadable file, a refused usage field), so
    // a zero it could not read is never mistaken for a spend of zero (fifteenth
    // audit item 3).
    polls: typeof polls === 'number' ? polls : 0,
    error: typeof error === 'string' && error !== '' ? error : null,
    // The TRUE spend the grant is compared against: main prompt + main output +
    // ask prompt + ask output + the compaction call's prompt and output.
    // `askKnown` says whether a journal was found; false means the total is a
    // lower bound over the ask lane. The compaction fields are 0 on a run that
    // never compacted, and `compactionUsageComplete` is false when a
    // `compaction/start` had no billable summary, which makes the grant a lower
    // bound on that call.
    trueTotalTokens: counted(trueTotalTokens),
    mainPromptTokens: counted(mainPromptTokens),
    mainOutputTokens: counted(mainOutputTokens),
    askInputTokens: counted(askInputTokens),
    askOutputTokens: counted(askOutputTokens),
    askKnown: read ? askKnown === true : null,
    // The compaction call's billed streams, always stated as a number so a
    // zero-compaction run reads 0 and `true`, never null: the absence of a
    // compaction is a fact this record can state without a grant.
    compactionPromptTokens: Number.isFinite(Number(compactionPromptTokens)) ? Number(compactionPromptTokens) : 0,
    compactionOutputTokens: Number.isFinite(Number(compactionOutputTokens)) ? Number(compactionOutputTokens) : 0,
    compactionUsageRows: Number.isFinite(Number(compactionUsageRows)) ? Number(compactionUsageRows) : 0,
    compactionUsageComplete: compactionUsageComplete !== false,
    // Fourteenth audit item 2: a usage row with no recognizable prompt-side
    // field is stated, never summed into a 0 that reads as a real total. The
    // pair appears ONLY when the watchdog refused, so a healthy run writes the
    // same `watchdog` object it always did; when it appears,
    // `usageReadingRefused` is true and the grant was never checked against a 0.
    ...(Number(usageUnrecognized ?? 0) > 0 || refused === true
      ? { usageUnrecognized: Number(usageUnrecognized ?? 0), usageReadingRefused: refused === true }
      : {}),
    ...(stopOnCompaction === true
      ? {
        // The landmark stopper. `compactionFired` is what a reader keys on;
        // `compactionStoppedAt` is the crossing itself, or null when the stop
        // was armed and the run ended before any compaction.
        stopOnCompaction: true,
        compactionFired: compactionFired === true,
        compactionStoppedAt: compactionFired === true ? compactionStoppedAt ?? null : null,
        compactions: typeof compactions === 'number' ? compactions : null,
      }
      : {}),
  };
}
