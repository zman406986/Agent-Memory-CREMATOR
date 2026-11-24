#!/usr/bin/env node
/**
 * The in-run token watchdog (`--token-grant`).
 *
 * The defect it closes: the launcher's only in-run stopper was the wall-clock
 * box (`--kill-ms`, 90 minutes), while the token stop rules (80 000 000 per arm;
 * 40 000 000 with no forced loss) were computed by `derive-run-b.mjs` from a
 * FINISHED session log. A runaway arm therefore burned for the whole box and the
 * spend was explained afterwards, never bounded. The launcher now polls the
 * session log it is already collecting and kills at the grant.
 *
 * What these gates hold:
 *
 *   (a) at or past the grant the watchdog fires exactly once and calls the kill;
 *   (b) below the grant it never fires;
 *   (c) no flag means no grant, no polling and no file reads, and
 *       `watchdog.tokenGrant` is null so "no ceiling" cannot read as "held";
 *   (d) the kill-timer fields (`command`, `timeoutMs`, `fired`) are untouched by
 *       the new ones — either stopper may fire and each states its own fact;
 *   (e) the counter agrees with `derive-run-b.mjs`'s billed-prompt total on a
 *       fixed fixture, so a live kill can never be argued with by the derivation;
 *   (f) the reader is incremental and tolerant: a file that does not exist yet,
 *       a half-written last line, and one growing file all read correctly.
 *
 * Everything runs offline on temp files: no dsh, no provider, no mock. Time is
 * a short interval or an injected clock, never a 90-minute wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SessionUsageWatch, TOKEN_POLL_MS, UsageTail, computeTrueTotal, createTokenWatchdog,
  findSessionLogs, watchdogRecord,
} from './token-watchdog.mjs';
import { AskSource, UsageSource, createAlarm } from './token-alarm.mjs';
import { compactionUsageRow, messageUsage, usageRow, usageRows, usageTotals } from './session-usage.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const DERIVE = join(BENCH_DIR, 'derive-run-b.mjs');

/**
 * A fixed session fixture. The numbers are chosen so the billed total (5 500) can
 * only come from input + cacheRead on usage rows: no other combination of the
 * fields in the file yields it, so a parser that dropped cacheRead or counted
 * output would disagree with it.
 *
 * Rows deliberately include the shapes a real log carries:
 *   - a `session` header (no usage),
 *   - a `tool/call` (no usage),
 *   - an `assistant/message` WITH usage,
 *   - a `compaction/start` (no usage) between two usage rows,
 *   - an `assistant/message` with NO usage (still a step; contributes 0),
 *   - usage written as strings in one row (the host is JSON, but a numeric
 *     string must not turn the sum into concatenation).
 */
const FIXTURE_ROWS = [
  { type: 'session', id: 'session-fixture', createdAt: 1_700_000_000_000 },
  { type: 'step/start', seq: 1, turn: 1, step: 1 },
  {
    type: 'assistant/message',
    seq: 2,
    time: 1_700_000_001_000,
    data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 900 } },
  },
  { type: 'tool/call', seq: 3, data: { name: 'read', callId: 'call_1', arguments: '{}' } },
  {
    type: 'assistant/message',
    seq: 4,
    time: 1_700_000_002_000,
    data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 1220, cacheReadTokens: 1000 } },
  },
  { type: 'compaction/start', seq: 5, data: { turn: 1 } },
  { type: 'compaction/end', seq: 6, data: { turn: 1 } },
  { type: 'assistant/message', seq: 7, data: { turn: 1, step: 3 } },
  {
    type: 'assistant/message',
    seq: 8,
    time: 1_700_000_003_000,
    data: { turn: 1, step: 4, usage: { inputTokens: '300', outputTokens: 30, totalTokens: 1330, cacheReadTokens: '3000' } },
  },
];
/** 100+900 + 200+1000 + 0 + 300+3000 = 5 500. Stated once, here. */
const FIXTURE_BILLED = 5_500;

/** Write one JSONL file from rows, returning its path. */
function writeLog(file, rows = FIXTURE_ROWS) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

/** A temp sessions root holding one session dir, like the child lays out. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'racoons-token-watchdog-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessions = join(base, 'sessions');
  const sessionDir = join(sessions, '--C-Users-AAAAA-arm--', 'session-0001');
  mkdirSync(sessionDir, { recursive: true });
  return { base, sessions, sessionDir, log: join(sessionDir, 'session.v4.jsonl') };
}

/** Run derive-run-b.mjs over a log and return its parsed JSON document. */
function derive(file) {
  const run = spawnSync(process.execPath, [DERIVE, '--session', file, '--json'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(run.status, 0, `derive-run-b exited ${String(run.status)}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// ── (e) One parser, two callers ───────────────────────────────────────────────

test('watchdog (e) the shared parser sums billed prompt tokens as input + cacheRead', () => {
  const totals = usageTotals(usageRows(FIXTURE_ROWS));
  assert.equal(totals.rows.length, 3, 'only the usage-carrying assistant/message rows');
  assert.equal(totals.inputTokens, 600);
  assert.equal(totals.cacheReadTokens, 4_900);
  assert.equal(totals.billedPromptTokens, FIXTURE_BILLED);
  // Output is carried but never billed into the prompt total.
  assert.equal(totals.outputTokens, 60);
  assert.notEqual(totals.billedPromptTokens, totals.billedPromptTokens + totals.outputTokens);
});

test('watchdog (e) the live counter matches derive-run-b\'s billed total on one fixture', (t) => {
  const f = fixture(t);
  writeLog(f.log);
  const tail = new UsageTail(f.log);
  t.after(() => tail.close());
  const live = tail.poll();
  const derived = derive(f.log);
  assert.equal(live.billedPromptTokens, derived.arms[0].totals.billedPromptTokens);
  assert.equal(live.billedPromptTokens, FIXTURE_BILLED);
  assert.equal(live.inputTokens, derived.arms[0].totals.inputTokens);
  assert.equal(live.cacheReadTokens, derived.arms[0].totals.cacheReadTokens);
});

test('watchdog (e) derive-run-b keeps a usage-less step in its message series', () => {
  // The derivation counts every assistant/message as a prompt step (seq 7 above
  // carries no usage); the watchdog only sums rows that can be billed. Both are
  // right, and the shared row builder is what keeps them from drifting apart.
  const rows = FIXTURE_ROWS.map((row) => messageUsage(row)).filter((row) => row !== null);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.billedTokens > 0).length, 3);
  assert.equal(usageRow(FIXTURE_ROWS[6]), null, 'a usage-less step is not a usage row');
});

// ── (e2) Cache writes are billed input (ISSUE-173 B) ─────────────────────────

/**
 * The shapes a cache-writing route produces. The host reports three DISJOINT
 * buckets and the product sums all three into the prompt it hands the meter
 * (`packages/adapters/dsh/src/usage.ts` `readAssistantUsage`), so the bench must
 * read the same three. `cacheWriteTokens: 0` is present as a zero in the
 * projcache files, absent entirely in every `session.v4.jsonl` recorded so
 * far — and it must keep the total where it was.
 */
const WRITE_ROWS = [
  { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 } } },
  { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 950 } } },
  { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } } },
  { type: 'assistant/message', seq: 4, data: { usage: { inputTokens: 10, cacheReadTokens: 10 } } },
];

test('watchdog (e2) a cache write is billed prompt, not ignored', () => {
  const rows = usageRows(WRITE_ROWS);
  assert.equal(rows.length, 4);
  // 1000 + 1000 + 10 + 20. The two-term sum would give 900 + 50 + 10 + 20 = 980.
  assert.equal(rows.reduce((sum, row) => sum + row.billedTokens, 0), 2_030,
    'the billed total must include the cache-write bucket');
  assert.equal(rows[0].billedTokens, 1_000);
  assert.equal(rows[1].billedTokens, 1_000, 'a row that is all cache write still bills');
  assert.equal(rows[3].billedTokens, 20, 'an absent cacheWriteTokens field reads as 0');
  assert.equal(rows[3].cacheWriteTokens, 0);
});

test('watchdog (e2) usageTotals sums the third bucket and states it', () => {
  const totals = usageTotals(usageRows(WRITE_ROWS));
  assert.equal(totals.inputTokens, 167);
  assert.equal(totals.cacheReadTokens, 813);
  assert.equal(totals.cacheWriteTokens, 1_050);
  assert.equal(totals.billedPromptTokens, 2_030);
  assert.equal(totals.billedPromptTokens,
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    'the totals must close on the three buckets');
  assert.notEqual(totals.billedPromptTokens, totals.inputTokens + totals.cacheReadTokens,
    'the old two-term sum is still reachable, so this assertion is not vacuous');
});

test('watchdog (e2) derive-run-b bills the three buckets and keeps the hit rate on read+fresh', (t) => {
  const f = fixture(t);
  writeFileSync(f.log, `${WRITE_ROWS.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const tail = new UsageTail(f.log);
  t.after(() => tail.close());
  const live = tail.poll();
  const derived = derive(f.log);
  assert.equal(live.billedPromptTokens, derived.arms[0].totals.billedPromptTokens,
    'the live counter and the derivation disagree on billed prompt');
  assert.equal(live.billedPromptTokens, 2_030);
  assert.equal(live.cacheWriteTokens, 1_050);
  assert.equal(derived.arms[0].totals.cacheWriteTokens, 1_050);
  // 813 read ÷ (167 input + 813 read) — the two write-heavy rows are misses and
  // sit in neither half. A rate over `billed` would read 813/2030 = 0.40.
  assert.equal(derived.arms[0].cacheHitRate, 813 / 980);
  assert.equal(derived.arms[0].peakPrompt.billedTokens, 1_000);
});

test('watchdog (e2) the watchdog fires at a grant the old sum would have cleared', (t) => {
  // The landmine, driven: a grant set at the true billed spend. Under the
  // two-term sum the counter reads 980 and the run is NOT killed; it is the
  // third bucket that reaches 2 030.
  const f = fixture(t);
  writeFileSync(f.log, `${WRITE_ROWS.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  const wd = createTokenWatchdog({ grant: 2_030, watch, onGrant: (event) => kills.push(event) });
  const state = wd.pollOnce();
  assert.equal(state.observedPromptTokens, 2_030);
  assert.equal(state.tokenFired, true, 'the grant is the billed spend, so it must fire');
  assert.equal(kills.length, 1);
});

// ── (f) The reader: absent, partial, incremental ──────────────────────────────

test('watchdog (f) an absent session file reads as zero and starts no error', (t) => {
  const f = fixture(t);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  assert.deepEqual(watch.poll(), {
    billedPromptTokens: 0, outputTokens: 0, rows: 0, unparsed: 0,
    compactionPromptTokens: 0, compactionOutputTokens: 0, compactionUsageRows: 0, files: [],
  });
});

test('watchdog (f) a file that appears later is picked up on the next poll', (t) => {
  const f = fixture(t);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  assert.equal(watch.poll().billedPromptTokens, 0);
  writeLog(f.log);
  const second = watch.poll();
  assert.equal(second.billedPromptTokens, FIXTURE_BILLED);
  assert.deepEqual(second.files, [f.log]);
});

test('watchdog (f) a half-written last line is held until it is complete', (t) => {
  const f = fixture(t);
  const first = `{"type":"assistant/message","seq":1,"data":{"usage":{"inputTokens":10,"cacheReadTokens":10}}}\n`;
  const secondRow = { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 20, cacheReadTokens: 20 } } };
  const second = `${JSON.stringify(secondRow)}\n`;
  writeFileSync(f.log, first + second.slice(0, 12));
  const tail = new UsageTail(f.log);
  t.after(() => tail.close());

  const partial = tail.poll();
  assert.equal(partial.billedPromptTokens, 20, 'the complete line only');
  assert.equal(partial.unparsed, 0, 'a partial line is not an unparsed line');

  appendFileSync(f.log, second.slice(12));
  const complete = tail.poll();
  assert.equal(complete.billedPromptTokens, 60);
  assert.equal(complete.rows, 2);
  assert.equal(complete.unparsed, 0);
});

test('watchdog (f) growth is read incrementally and a malformed line is counted, not thrown', (t) => {
  const f = fixture(t);
  const row = (seq, input, cache) => `${JSON.stringify({
    type: 'assistant/message', seq, data: { usage: { inputTokens: input, cacheReadTokens: cache } },
  })}\n`;
  writeFileSync(f.log, row(1, 100, 400));
  const tail = new UsageTail(f.log);
  t.after(() => tail.close());
  assert.equal(tail.poll().billedPromptTokens, 500);
  appendFileSync(f.log, 'not json at all\n');
  appendFileSync(f.log, row(2, 200, 300));
  const grown = tail.poll();
  assert.equal(grown.billedPromptTokens, 1_000, 'the earlier row is not re-counted');
  assert.equal(grown.rows, 2);
  assert.equal(grown.unparsed, 1);
});

test('watchdog (f) two session logs are summed, the way the post-run totals are', (t) => {
  const f = fixture(t);
  writeLog(f.log);
  const other = join(f.sessions, '--other--', 'session-0002');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'session.v4.jsonl'), `${JSON.stringify({
    type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 1, cacheReadTokens: 1 } },
  })}\n`);
  assert.deepEqual(findSessionLogs(f.sessions).length, 2);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  assert.equal(watch.poll().billedPromptTokens, FIXTURE_BILLED + 2);
});

test('watchdog (f) a host-named session-<id>.v4.jsonl is discovered and watched', (t) => {
  // ISSUE-270: the post-run reader already accepted this name; the in-run
  // watchdog did not, so a host that named its own log held the grant open.
  const f = fixture(t);
  const hostLog = join(f.sessionDir, 'session-host-abc.v4.jsonl');
  writeLog(hostLog);
  assert.deepEqual(findSessionLogs(f.sessions), [hostLog]);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  const wd = createTokenWatchdog({
    grant: FIXTURE_BILLED,
    watch,
    pollMs: 1_000_000,
    onGrant: (event) => kills.push(event),
  });
  wd.start();
  assert.equal(wd.state.tokenFired, true, 'the host-named log must reach the grant');
  assert.equal(wd.state.trueTotalTokens >= FIXTURE_BILLED, true);
  assert.equal(kills.length, 1);
});

// ── (a) fires at/after grant, exactly once ────────────────────────────────────

test('watchdog (a) absent flag: null grant, no polling, no file read', (t) => {
  const f = fixture(t);
  writeLog(f.log);
  let reads = 0;
  const watch = { poll: () => { reads += 1; return { billedPromptTokens: FIXTURE_BILLED }; } };
  const kills = [];
  const wd = createTokenWatchdog({ grant: null, watch, onGrant: (event) => kills.push(event) });
  wd.start();
  assert.equal(wd.state.tokenGrant, null);
  assert.equal(wd.state.tokenFired, false);
  assert.equal(wd.state.observedPromptTokens, null, 'no grant means no reading to report');
  assert.equal(reads, 0, 'nothing is polled without a grant');
  assert.equal(kills.length, 0);
  const record = watchdogRecord({
    command: 'taskkill /PID 1 /T /F', timeoutMs: 5_400_000, fired: false, tokenGrant: null,
  });
  assert.equal(record.tokenGrant, null);
  assert.equal(record.tokenFired, false);
  assert.equal(record.observedPromptTokens, null);
  assert.equal(record.pollMs, null);
});

test('watchdog (a) at the grant the watchdog fires once and calls the kill', (t) => {
  const f = fixture(t);
  writeLog(f.log);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  let now = 1_700_000_100_000;
  const wd = createTokenWatchdog({
    grant: FIXTURE_BILLED, watch, onGrant: (event) => kills.push(event), now: () => now,
  });
  const state = wd.pollOnce();
  assert.equal(state.tokenFired, true, '>= grant fires; the grant is a ceiling, not a target to pass');
  assert.equal(state.observedPromptTokens, FIXTURE_BILLED);
  assert.equal(state.firedAt, new Date(now).toISOString());
  assert.equal(kills.length, 1);
  assert.deepEqual(kills[0], { observedPromptTokens: FIXTURE_BILLED, firedAt: state.firedAt });

  now += 60_000;
  wd.pollOnce();
  assert.equal(kills.length, 1, 'a second poll must not kill twice');
  assert.equal(state.firedAt, new Date(1_700_000_100_000).toISOString());
});

test('watchdog (a) below the grant it does not fire', (t) => {
  const f = fixture(t);
  writeLog(f.log, FIXTURE_ROWS.slice(0, 3)); // one usage row: 1 000 billed
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  // 1 000 main prompt + 10 completion = 1 010 true; the grant is 1 011.
  const wd = createTokenWatchdog({ grant: 1_011, watch, onGrant: (event) => kills.push(event) });
  const state = wd.pollOnce();
  assert.equal(state.observedPromptTokens, 1_000);
  assert.equal(state.trueTotalTokens, 1_010);
  assert.equal(state.tokenFired, false);
  assert.equal(state.firedAt, null);
  assert.equal(kills.length, 0);
});

test('watchdog (a) it fires on the poll AFTER the file grows past the grant', async (t) => {
  const f = fixture(t);
  writeFileSync(f.log, `${JSON.stringify({
    type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 10 } },
  })}\n`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  const wd = createTokenWatchdog({ grant: 50, watch, pollMs: 10, onGrant: (event) => kills.push(event) });
  t.after(() => wd.stop());
  wd.start();
  assert.equal(wd.state.tokenFired, false, 'the first poll sees 20, below the 50 grant');
  appendFileSync(f.log, `${JSON.stringify({
    type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 30, cacheReadTokens: 20 } },
  })}\n`);
  // Poll until the interval notices, bounded by wall clock so a stuck watcher
  // fails this test instead of hanging the run.
  const deadline = Date.now() + 2_000;
  while (!wd.state.tokenFired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wd.state.tokenFired, true);
  assert.equal(wd.state.observedPromptTokens, 70);
  assert.equal(kills.length, 1);
});

// ── (d) the kill timer's fields are untouched ─────────────────────────────────

test('watchdog (d) the kill-timer fields are unchanged and both stoppers state their own', () => {
  const quiet = watchdogRecord({ command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: false });
  assert.equal(quiet.command, 'taskkill /PID 7 /T /F');
  assert.equal(quiet.timeoutMs, 5_400_000);
  assert.equal(quiet.fired, false);
  assert.equal(quiet.tokenGrant, null);

  const boxed = watchdogRecord({
    command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: true, tokenGrant: 1_000, observedPromptTokens: 10,
  });
  assert.equal(boxed.fired, true, 'the box fired and says so');
  assert.equal(boxed.tokenFired, false, 'the grant did not, and that is a separate fact');

  const granted = watchdogRecord({
    command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: false, tokenGrant: 1_000,
    tokenFired: true, observedPromptTokens: 1_010, firedAt: '2026-10-25T00:00:00.000Z', pollMs: TOKEN_POLL_MS,
  });
  assert.equal(granted.fired, false);
  assert.equal(granted.tokenFired, true);
  assert.equal(granted.observedPromptTokens, 1_010);
  assert.equal(granted.firedAt, '2026-10-25T00:00:00.000Z');

  const both = watchdogRecord({
    command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: true, tokenGrant: 1_000,
    tokenFired: true, observedPromptTokens: 1_010, firedAt: '2026-10-25T00:00:00.000Z', pollMs: TOKEN_POLL_MS,
  });
  assert.equal(both.fired, true, 'both may fire; neither erases the other');
  assert.equal(both.tokenFired, true);
});

test('watchdog (d) the launcher\'s exit path is the kill box\'s, not a new code', async () => {
  // The launcher routes a fired grant through the same `watchdogFired` input the
  // box uses, so the documented code is 1. Asserted on the pure function the
  // launcher calls, not on a re-implementation of it.
  const { EXIT_CODES, exitCodeFor } = await import('./launch-outcome.mjs');
  assert.equal(exitCodeFor({
    watchdogFired: true, failures: 0, violations: 0, denySkipped: false, verdict: 'pass', realApi: true,
  }), EXIT_CODES.armFailed);
});

// ── The reader's own contract ────────────────────────────────────────────────

test('watchdog (f) an unreadable poll never throws; the error is recorded', () => {
  const wd = createTokenWatchdog({
    grant: 1,
    watch: { poll: () => { throw new Error('EIO: disk went away'); } },
    onGrant: () => assert.fail('a failing read must not fire the kill'),
  });
  const state = wd.pollOnce();
  assert.equal(state.tokenFired, false);
  assert.match(state.error, /EIO/u);
  // Fifteenth audit item 3: the failed read is a stated fact in the record, and
  // the poll count says the ceiling was never checked on a reading.
  assert.equal(state.polls, 0);
  const record = watchdogRecord({
    command: 'taskkill /PID 1 /T /F', timeoutMs: 1_000, fired: false, tokenGrant: 1,
    tokenFired: state.tokenFired, observedPromptTokens: state.observedPromptTokens,
    error: state.error, polls: state.polls,
  });
  assert.equal(record.polls, 0);
  assert.match(record.error, /EIO/u);
});

test('watchdog (fifteenth audit item 3) the final poll accounts a last line with no newline', (t) => {
  // A writer that never flushed a trailing newline left a complete row in the
  // pending buffer; the interval holds it because the child may still be
  // writing. The final poll knows the child is done and must count it, or a
  // live run under-reports its spend by its last step.
  const f = fixture(t);
  const first = JSON.stringify({
    type: 'assistant/message', seq: 1,
    data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 2 } },
  });
  const last = JSON.stringify({
    type: 'assistant/message', seq: 2,
    data: { turn: 1, step: 2, usage: { inputTokens: 300, outputTokens: 3 } },
  });
  writeFileSync(f.log, `${first}\n${last}`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  assert.equal(watch.poll().billedPromptTokens, 100, 'the interval holds the unterminated line');
  const wd = createTokenWatchdog({ grant: 10_000, watch });
  const state = wd.finalPoll();
  assert.equal(state.observedPromptTokens, 400, 'the final poll counts the trailing line');
  assert.equal(state.polls, 1);
  assert.equal(state.error, null);
  assert.equal(wd.finalPoll().observedPromptTokens, 400, 'a flushed line is never counted twice');
});

test('watchdog (f) a grant the child already exceeded fires on the FIRST poll', (t) => {
  // The launcher polls once immediately at start, then on the interval. A child
  // that inherits a session log already over the grant is killed at once, not
  // after one interval of extra spend.
  const f = fixture(t);
  writeLog(f.log);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const kills = [];
  const wd = createTokenWatchdog({ grant: 1, watch, pollMs: 10, onGrant: (event) => kills.push(event) });
  t.after(() => wd.stop());
  wd.start();
  assert.equal(wd.state.tokenFired, true);
  assert.equal(kills.length, 1);
});

test('watchdog (f) the poll interval is modest, not a busy loop', () => {
  assert.ok(TOKEN_POLL_MS >= 5_000, `an interval of ${String(TOKEN_POLL_MS)} ms is too tight for a live run`);
  assert.ok(TOKEN_POLL_MS <= 30_000, `an interval of ${String(TOKEN_POLL_MS)} ms overshoots a grant`);
});

// ── (g) The compaction stopper: `--stop-on-compaction` (ISSUE-182) ───────────
//
// A different kind of stopper from the box and the grant: those are budgets,
// this is a LANDMARK. What these gates hold:
//
//   (g1) the first `compaction/start` fires `onCompaction` exactly once, and the
//        payload names the seq, the step and the billed total at the crossing;
//   (g2) the flag off means the row is not counted and nothing fires — the
//        grant path is untouched;
//   (g3) a row that appears twice fires once (a resumed session, a re-read file);
//   (g4) `watchdogRecord` adds no key when the stop was not asked for, so an
//        existing `result.json.watchdog` object is byte-identical;
//   (g5) the stop's step is the step the compaction opens before, derived from
//        `step/start` rows, never the compaction's own `seq`.
//
// Fixtures are the fixed FIXTURE_ROWS above plus a `step/start` row, and every
// case runs offline on temp files.

/**
 * The fixture with the `step/start` rows a compaction needs to be placed, and
 * the fixture's own `compaction/start`/`compaction/end` pair dropped: those two
 * rows exist to prove the usage sum ignores them, and keeping them here would
 * put a second compaction in every case and make the counts ambiguous.
 */
function compactionRows({ extraCompaction = 0 } = {}) {
  const rows = [
    ...FIXTURE_ROWS.slice(0, 3), // session header, step 1, the first usage row
    { type: 'step/start', seq: 2.5, turn: 1, step: 2 },
    { type: 'compaction/start', seq: 3.5, data: { compactionId: 'c1', turn: 1 } },
    { type: 'compaction/summary', seq: 3.6, data: { compactionId: 'c1' } },
    { type: 'compaction/end', seq: 3.7, data: { compactionId: 'c1', turn: 1 } },
    ...FIXTURE_ROWS.slice(3).filter((row) => row.type !== 'compaction/start' && row.type !== 'compaction/end'),
  ];
  for (let k = 0; k < extraCompaction; k += 1) {
    rows.push({ type: 'compaction/start', seq: 100 + k, data: { compactionId: `c${String(k + 2)}`, turn: 1 } });
  }
  return rows;
}

test('watchdog (g1) the first compaction fires onCompaction once, with its seq, step and spend', (t) => {
  const f = fixture(t);
  writeLog(f.log, compactionRows());
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const stops = [];
  const now = 1_700_000_200_000;
  const wd = createTokenWatchdog({
    grant: null, stopOnCompaction: true, watch, onCompaction: (event) => stops.push(event), now: () => now,
  });
  // Two `step/start` rows precede the compaction, so it opens step 3 — the step
  // the host is about to run, not the seq of its own row.
  const state = wd.pollOnce();
  assert.equal(state.compactionFired, true);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].seq, 3.5);
  assert.equal(stops[0].step, 3);
  assert.equal(stops[0].turn, 1);
  // The billed total is the fixture's own: two usage rows are counted before
  // the compaction, so the crossing states what the run had spent by then.
  assert.equal(stops[0].billedPromptTokens, 1_000);
  assert.equal(stops[0].firedAt, new Date(now).toISOString());
  assert.equal(state.compactionStoppedAt.seq, 3.5);
  assert.deepEqual(state.compactionStoppedAt, stops[0]);
});

test('watchdog (g1) a compaction the child writes after the first poll fires on the next one', async (t) => {
  const f = fixture(t);
  writeFileSync(f.log, `${FIXTURE_ROWS.slice(0, 3).map((row) => JSON.stringify(row)).join('\n')}\n`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const stops = [];
  const wd = createTokenWatchdog({
    grant: null, stopOnCompaction: true, watch, pollMs: 10, onCompaction: (event) => stops.push(event),
  });
  t.after(() => wd.stop());
  wd.start();
  assert.equal(wd.state.compactionFired, false, 'no compaction in the first poll');
  appendFileSync(f.log, `${JSON.stringify({ type: 'step/start', seq: 3, data: { turn: 1, step: 2 } })}\n`
    + `${JSON.stringify({ type: 'compaction/start', seq: 4, data: { turn: 1 } })}\n`);
  const deadline = Date.now() + 2_000;
  while (!wd.state.compactionFired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wd.state.compactionFired, true);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].seq, 4);
  // The first three fixture rows carry one `step/start`, this one adds a
  // second, so the compaction opens step 3 (the step it precedes).
  assert.equal(stops[0].step, 3);
});

test('watchdog (g2) the flag off counts nothing and never fires', (t) => {
  const f = fixture(t);
  writeLog(f.log, compactionRows());
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const stops = [];
  // No grant and no flag: the watchdog reads no file at all.
  const wd = createTokenWatchdog({ grant: null, watch, onCompaction: (event) => stops.push(event) });
  wd.start();
  assert.equal(wd.state.polls, 0, 'nothing is polled when neither stopper is armed');
  assert.equal(Object.hasOwn(wd.state, 'compactionFired'), false, 'the state gains no key');
  assert.equal(stops.length, 0);
  // With a grant, the file IS read — and the compaction still does not stop it.
  const granted = createTokenWatchdog({
    grant: FIXTURE_BILLED + 61, watch, onCompaction: (event) => stops.push(event),
  });
  const state = granted.pollOnce();
  assert.equal(state.tokenFired, false, 'the grant is above the spend, so it does not fire');
  assert.equal(stops.length, 0, 'a compaction never stops a run that did not ask for it');
  assert.equal(Object.hasOwn(state, 'compactionFired'), false);
});

test('watchdog (g3) a compaction row that appears twice stops the run once', (t) => {
  const f = fixture(t);
  writeLog(f.log, compactionRows({ extraCompaction: 2 }));
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const stops = [];
  const wd = createTokenWatchdog({
    grant: null, stopOnCompaction: true, watch, onCompaction: (event) => stops.push(event),
  });
  wd.pollOnce();
  assert.equal(stops.length, 1, 'the first row fires');
  assert.equal(wd.state.compactionStoppedAt.seq, 3.5, 'and the landmark does not move to a later row');
  // The file's count of rows grows; the stop does not fire again.
  assert.deepEqual(watch.compactions, 3, 'all three rows are counted');
  wd.pollOnce();
  assert.equal(stops.length, 1, 'a second poll must not stop twice');
});

test('watchdog (g3) two session logs: the first in sorted order names the stop', (t) => {
  const f = fixture(t);
  writeLog(f.log, compactionRows());
  const later = join(f.sessions, 'zz-later', 'session-0002');
  mkdirSync(later, { recursive: true });
  writeFileSync(join(later, 'session.v4.jsonl'), `${JSON.stringify({
    type: 'compaction/start', seq: 9, data: { turn: 1 },
  })}\n`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const stops = [];
  const wd = createTokenWatchdog({
    grant: null, stopOnCompaction: true, watch, onCompaction: (event) => stops.push(event),
  });
  wd.pollOnce();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].seq, 3.5, 'the first file in sorted order owns the landmark');
  assert.equal(watch.compactions, 2, 'both rows are still counted');
});

test('watchdog (g4) watchdogRecord states the poll liveness on every run', () => {
  const base = { command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: false,
    tokenGrant: 1_000, tokenFired: false, observedPromptTokens: 10, firedAt: null, pollMs: TOKEN_POLL_MS };
  const quiet = watchdogRecord(base);
  assert.deepEqual(Object.keys(quiet), ['command', 'timeoutMs', 'fired', 'tokenGrant', 'tokenFired',
    'observedPromptTokens', 'firedAt', 'pollMs', 'polls', 'error', 'trueTotalTokens',
    'mainPromptTokens', 'mainOutputTokens', 'askInputTokens', 'askOutputTokens', 'askKnown',
    'compactionPromptTokens', 'compactionOutputTokens', 'compactionUsageRows',
    'compactionUsageComplete'],
  'a run without the stop flag writes the same key list plus the poll liveness, the true total and '
    + 'the compaction usage fields');
  assert.equal(Object.hasOwn(quiet, 'stopOnCompaction'), false);
  assert.equal(quiet.polls, 0);
  assert.equal(quiet.error, null);
  assert.equal(quiet.compactionPromptTokens, 0, 'zero-compaction runs write 0');
  assert.equal(quiet.compactionUsageComplete, true);
  // Fifteenth audit item 3: a failed poll and its count are stated, not dropped.
  const failed = watchdogRecord({ ...base, error: 'EIO: disk went away', polls: 2 });
  assert.equal(failed.polls, 2);
  assert.equal(failed.error, 'EIO: disk went away');

  const armed = watchdogRecord({ ...base, stopOnCompaction: true, compactionFired: false,
    compactionStoppedAt: null, compactions: 0 });
  assert.equal(armed.stopOnCompaction, true);
  assert.equal(armed.compactionFired, false);
  assert.equal(armed.compactionStoppedAt, null, 'armed and never reached is stated as null');

  const stopped = watchdogRecord({ ...base, stopOnCompaction: true, compactionFired: true,
    compactionStoppedAt: { seq: 12, step: 7, turn: 1, billedPromptTokens: 5_500, compactions: 1,
      firedAt: '2026-11-05T00:00:00.000Z' }, compactions: 1 });
  assert.equal(stopped.compactionFired, true);
  assert.equal(stopped.compactionStoppedAt.step, 7);
  assert.equal(stopped.compactionStoppedAt.billedPromptTokens, 5_500);
  assert.equal(stopped.compactions, 1);
  // The grant's fields are untouched by the new ones.
  assert.equal(stopped.tokenFired, false);
  assert.equal(stopped.fired, false);
});

test('watchdog (g5) the step is the one the compaction opens before, read from step/start', (t) => {
  // The real shape, from a recorded session: `compaction/start` carries no step,
  // and the last `step/start` before it is the step that just ENDED. It opens
  // the next one (docs/plans/2026-10-29-prompt-forget-lanes/plan.md:22 reads
  // seq 1429 as step 175 after 174 started).
  const f = fixture(t);
  writeLog(f.log, [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 2 } },
    { type: 'step/start', seq: 3, data: { turn: 1, step: 3 } },
    { type: 'compaction/start', seq: 40, data: { compactionId: 'c1', turn: 1 } },
  ]);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  let stop = null;
  createTokenWatchdog({
    grant: null, stopOnCompaction: true, watch, onCompaction: (event) => { stop = event; },
  }).pollOnce();
  assert.equal(stop.seq, 40, 'the seq is the event own');
  assert.equal(stop.step, 4, 'three steps started, so the compaction opens step 4');
  assert.notEqual(stop.step, stop.seq, 'the step is never a copy of the seq on this fixture');
  assert.equal(stop.billedPromptTokens, 0, 'no usage row in this log, so the spend is a stated 0');
});

test('watchdog (g5) the existing usage counters are unchanged by the compaction rows', (t) => {
  // The counter and the derivation must still agree: the compaction rows carry
  // no usage, so adding them to the fixture cannot move the billed total.
  const f = fixture(t);
  writeLog(f.log, compactionRows());
  const tail = new UsageTail(f.log);
  t.after(() => tail.close());
  const live = tail.poll();
  assert.equal(live.billedPromptTokens, FIXTURE_BILLED);
  assert.equal(live.rows, 3);
  assert.deepEqual(Object.keys(live), ['file', 'billedPromptTokens', 'inputTokens', 'cacheReadTokens',
    'cacheWriteTokens', 'outputTokens', 'totalTokens', 'rows', 'unparsed',
    'compactionPromptTokens', 'compactionOutputTokens', 'compactionUsageRows'],
  'snapshot() states its own keys, the compaction streams among them');
  assert.equal(tail.compactions, 1, 'the row is counted beside the sum, not inside it');
  assert.equal(live.compactionUsageRows, 0, 'a summary with no usage is not a paid row');
});

// ── True total: the grant reads all four streams ─────────────────────────────

test('watchdog (true total) the six streams sum, and a missing or bad count is 0', () => {
  const full = computeTrueTotal({
    mainPromptTokens: 100, mainOutputTokens: 30, askInputTokens: 700, askOutputTokens: 20,
    compactionPromptTokens: 40, compactionOutputTokens: 2,
  });
  assert.equal(full.trueTotalTokens, 892);
  assert.deepEqual(full.streams, {
    mainPromptTokens: 100, mainOutputTokens: 30, askInputTokens: 700, askOutputTokens: 20,
    compactionPromptTokens: 40, compactionOutputTokens: 2,
  });
  // An omitted field must not turn the sum into NaN, which is false against
  // every grant and would hold the ceiling open forever.
  assert.deepEqual(computeTrueTotal({ mainPromptTokens: 5 }), {
    trueTotalTokens: 5,
    streams: {
      mainPromptTokens: 5, mainOutputTokens: 0, askInputTokens: 0, askOutputTokens: 0,
      compactionPromptTokens: 0, compactionOutputTokens: 0,
    },
  });
  assert.equal(computeTrueTotal({ mainPromptTokens: Number.NaN, askInputTokens: -4 }).trueTotalTokens, 0);
  assert.equal(computeTrueTotal().trueTotalTokens, 0);
});

test('watchdog (true total) the session watch sums main completion, not only prompt', (t) => {
  const f = fixture(t);
  writeLog(f.log);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const totals = watch.poll();
  assert.equal(totals.billedPromptTokens, FIXTURE_BILLED);
  assert.equal(totals.outputTokens, 60, 'three usage rows x 20/10/30 completion tokens');
});

test('watchdog (true total) the grant fires on ask + completion even when main prompt is below it', () => {
  // The defect: a 50M main-prompt grant read only the first stream. Here main
  // prompt is 100, the ask lane adds 200 + 7 and completion adds 5, so the true
  // total is 312 and a 300 grant must fire.
  const kills = [];
  const watch = { poll: () => ({ billedPromptTokens: 100, outputTokens: 5 }) };
  const askSource = { poll: () => ({ askTokens: 200, askOutputTokens: 7, known: true }) };
  const wd = createTokenWatchdog({
    grant: 300, watch, askSource, onGrant: (event) => kills.push(event),
  });
  const state = wd.pollOnce();
  assert.equal(state.tokenFired, true);
  assert.equal(kills.length, 1);
  assert.equal(state.observedPromptTokens, 100, 'the old field keeps its main-prompt meaning');
  assert.equal(state.mainPromptTokens, 100);
  assert.equal(state.mainOutputTokens, 5);
  assert.equal(state.askInputTokens, 200);
  assert.equal(state.askOutputTokens, 7);
  assert.equal(state.askKnown, true);
  assert.equal(state.trueTotalTokens, 312);
});

test('watchdog (true total) an unknown ask lane leaves TRUE a main-prompt + main-output lower bound', () => {
  const watch = { poll: () => ({ billedPromptTokens: 100, outputTokens: 5 }) };
  const wd = createTokenWatchdog({
    grant: 10_000, watch, askSource: { poll: () => ({ askTokens: 0, askOutputTokens: 0, known: false }) },
  });
  const state = wd.pollOnce();
  assert.equal(state.tokenFired, false);
  assert.equal(state.askKnown, false);
  assert.equal(state.trueTotalTokens, 105);
});

test('watchdog (true total) watchdogRecord states the streams beside the existing reading', () => {
  const record = watchdogRecord({
    command: 'taskkill /PID 7 /T /F', timeoutMs: 5_400_000, fired: false, tokenGrant: 300,
    tokenFired: true, observedPromptTokens: 100, trueTotalTokens: 312,
    mainPromptTokens: 100, mainOutputTokens: 5, askInputTokens: 200, askOutputTokens: 7,
    askKnown: true, polls: 1, firedAt: '2026-11-09T00:00:00.000Z', pollMs: TOKEN_POLL_MS,
  });
  assert.equal(record.tokenFired, true);
  assert.equal(record.observedPromptTokens, 100, 'the existing field is kept');
  assert.equal(record.mainPromptTokens, 100);
  assert.equal(record.mainOutputTokens, 5);
  assert.equal(record.askInputTokens, 200);
  assert.equal(record.askOutputTokens, 7);
  assert.equal(record.askKnown, true);
  assert.equal(record.trueTotalTokens, 312);
  // No grant and no poll is no reading: the fields are null, never a spend of 0.
  const none = watchdogRecord({ command: null, timeoutMs: 0, fired: false, tokenGrant: null });
  assert.equal(none.trueTotalTokens, null);
  assert.equal(none.mainPromptTokens, null);
  assert.equal(none.askKnown, null);
});

// ── ISSUE-237: the native compaction call is billed ──────────────────────────

/**
 * One ordinary turn plus one native compaction. The compaction's shape is the
 * recorded 2026-11-09 vanilla one: `data.usage` carries the call's own API
 * spend, and `shadowedTokenCount` measures what it removed (195 172 there).
 * The expected prompt is input + cacheRead + cacheWrite, never `totalTokens`
 * and never `shadowedTokenCount`.
 */
const COMPACTION_TURN_ROWS = [
  { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  {
    type: 'assistant/message', seq: 2,
    data: { turn: 1, step: 1, usage: { inputTokens: 1_000, cacheReadTokens: 234, outputTokens: 56 } },
  },
  { type: 'compaction/start', seq: 3, data: { turn: 1 } },
  {
    type: 'compaction/summary', seq: 4,
    data: {
      turn: 1,
      usage: { inputTokens: 217_269, cacheReadTokens: 5_888, outputTokens: 3_154, totalTokens: 226_311 },
      shadowedTokenCount: 195_172,
    },
  },
  { type: 'compaction/end', seq: 5, data: { turn: 1 } },
];
/** Turn 1 234 prompt + 56 output; compaction 223 157 prompt + 3 154 output. */
const COMPACTION_TRUE_TOTAL = 1_234 + 56 + 223_157 + 3_154;

test('ISSUE-237 a compaction/summary row is a billable usage row', () => {
  const row = compactionUsageRow(COMPACTION_TURN_ROWS[3]);
  assert.notEqual(row, null);
  assert.equal(row.billedTokens, 223_157, 'input + cacheRead + cacheWrite, not totalTokens');
  assert.equal(row.outputTokens, 3_154);
  assert.equal(row.totalTokens, 226_311, 'the host field is carried, never added');
  assert.equal(compactionUsageRow(COMPACTION_TURN_ROWS[1]), null,
    'an assistant turn is not a compaction row');
  assert.equal(compactionUsageRow({ type: 'compaction/summary', seq: 9, data: {} }), null,
    'a summary with no usage is refused, the same way usageRow refuses');
});

test('ISSUE-237 one turn and one compaction/summary: the true total counts both', (t) => {
  const f = fixture(t);
  writeLog(f.log, COMPACTION_TURN_ROWS);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const totals = watch.poll();
  assert.equal(totals.billedPromptTokens, 1_234, 'the turn keeps its own stream');
  assert.equal(totals.outputTokens, 56);
  assert.equal(totals.rows, 1);
  assert.equal(totals.compactionPromptTokens, 223_157);
  assert.equal(totals.compactionOutputTokens, 3_154);
  assert.equal(totals.compactionUsageRows, 1);
  assert.equal(watch.compactions, 1);

  const wd = createTokenWatchdog({ grant: 10_000_000, watch });
  const state = wd.pollOnce();
  assert.equal(state.trueTotalTokens, COMPACTION_TRUE_TOTAL, 'the compaction call is in the total');
  assert.notEqual(state.trueTotalTokens, COMPACTION_TRUE_TOTAL + 226_311,
    'totalTokens is never added beside the prompt buckets');
  assert.notEqual(state.trueTotalTokens, COMPACTION_TRUE_TOTAL + 195_172,
    'shadowedTokenCount is not usage');
  assert.equal(state.compactionUsageComplete, true);

  const record = watchdogRecord({
    command: null, timeoutMs: 0, fired: false, tokenGrant: 10_000_000,
    trueTotalTokens: state.trueTotalTokens, observedPromptTokens: state.observedPromptTokens,
    compactionPromptTokens: state.compactionPromptTokens,
    compactionOutputTokens: state.compactionOutputTokens,
    compactionUsageRows: state.compactionUsageRows,
    compactionUsageComplete: state.compactionUsageComplete,
    polls: state.polls,
  });
  assert.equal(record.compactionPromptTokens, 223_157);
  assert.equal(record.compactionOutputTokens, 3_154);
  assert.equal(record.compactionUsageRows, 1);
  assert.equal(record.compactionUsageComplete, true);
});

test('ISSUE-237 the same log with the summary removed counts only the turn', (t) => {
  const f = fixture(t);
  writeLog(f.log, COMPACTION_TURN_ROWS.filter((row) => row.type !== 'compaction/summary'));
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const totals = watch.poll();
  assert.equal(totals.billedPromptTokens, 1_234);
  assert.equal(totals.outputTokens, 56);
  assert.equal(totals.compactionPromptTokens, 0);
  assert.equal(totals.compactionOutputTokens, 0);
  assert.equal(totals.compactionUsageRows, 0);

  const wd = createTokenWatchdog({ grant: 10_000_000, watch });
  const state = wd.pollOnce();
  assert.equal(state.trueTotalTokens, 1_290, 'the turn alone');
});

test('ISSUE-237 a compaction/start with no summary marks the reading incomplete', (t) => {
  const f = fixture(t);
  writeLog(f.log, [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2,
      data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 10 } },
    },
    { type: 'compaction/start', seq: 3, data: { turn: 1 } },
  ]);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const wd = createTokenWatchdog({ grant: 10_000_000, watch });
  const state = wd.pollOnce();
  assert.equal(state.compactionUsageRows, 0);
  assert.equal(state.compactionUsageComplete, false,
    'one compaction/start and no billable summary is a lower bound');
  assert.equal(state.trueTotalTokens, 510, 'the part that was read is still stated');
  const record = watchdogRecord({
    command: null, timeoutMs: 0, fired: false, tokenGrant: 10_000_000,
    trueTotalTokens: state.trueTotalTokens, observedPromptTokens: state.observedPromptTokens,
    compactionUsageRows: state.compactionUsageRows,
    compactionUsageComplete: state.compactionUsageComplete, polls: state.polls,
  });
  assert.equal(record.compactionUsageComplete, false);
  assert.equal(record.compactionUsageRows, 0);
});

test('ISSUE-237 a zero-compaction run writes 0 and complete true', (t) => {
  const f = fixture(t);
  writeFileSync(f.log, `${JSON.stringify({
    type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 60, outputTokens: 4 } },
  })}\n`);
  const watch = new SessionUsageWatch(f.sessions);
  t.after(() => watch.close());
  const wd = createTokenWatchdog({ grant: 10_000_000, watch });
  const state = wd.pollOnce();
  assert.equal(state.compactionPromptTokens, 0);
  assert.equal(state.compactionOutputTokens, 0);
  assert.equal(state.compactionUsageRows, 0);
  assert.equal(state.compactionUsageComplete, true);
  assert.equal(state.trueTotalTokens, 64);
});

test('alarm (true total) ask completion is recorded and TRUE calls the shared arithmetic', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-alarm-true-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessions = join(base, 'sessions', 's1');
  const log = join(sessions, 'session.v4.jsonl');
  const journal = join(base, 'racoons', 'cremator-events.jsonl');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(base, 'racoons'), { recursive: true });
  writeFileSync(log, `${JSON.stringify({
    type: 'assistant/message', seq: 1,
    data: { usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 10 } },
  })}\n`);
  writeFileSync(journal, `${JSON.stringify({ kind: 'entry-ask', atMs: 1, sessionId: 's1',
    askNodeId: 'n1', usage: { inputTokens: 200, outputTokens: 5 } })}\n`);
  const source = new UsageSource(log);
  const askSource = new AskSource(base);
  t.after(() => { source.close(); askSource.close(); });
  const alarm = createAlarm({
    source, askSource, warn: 10_000, stop: 20_000, out: () => {},
  });
  const state = alarm.pollOnce();
  assert.equal(state.billedPromptTokens, 100, 'main prompt is kept for compatibility');
  assert.equal(state.outputTokens, 10);
  assert.equal(state.askTokens, 200);
  assert.equal(state.askOutputTokens, 5);
  assert.equal(state.trueTotalTokens, 315);
  assert.equal(state.trueTotalTokens, computeTrueTotal({
    mainPromptTokens: state.billedPromptTokens,
    mainOutputTokens: state.outputTokens,
    askInputTokens: state.askTokens,
    askOutputTokens: state.askOutputTokens,
  }).trueTotalTokens, 'the alarm and the watchdog share one arithmetic');
});

test('ISSUE-237 the alarm reads the same compaction streams as the watchdog', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'racoons-alarm-compaction-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessions = join(base, 'sessions', 's1');
  const log = join(sessions, 'session.v4.jsonl');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(log, `${COMPACTION_TURN_ROWS.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const source = new UsageSource(log);
  t.after(() => source.close());
  const alarm = createAlarm({ source, warn: 10_000_000, stop: 20_000_000, out: () => {} });
  const state = alarm.pollOnce();
  assert.equal(state.compactionPromptTokens, 223_157);
  assert.equal(state.compactionOutputTokens, 3_154);
  assert.equal(state.compactionUsageRows, 1);
  assert.equal(state.trueTotalTokens, COMPACTION_TRUE_TOTAL,
    'the alarm and the watchdog cannot disagree about the compaction call');
});
