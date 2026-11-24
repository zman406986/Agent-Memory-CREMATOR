#!/usr/bin/env node
/**
 * Offline gates for `dsh-checkpoints.mjs`.
 *
 * Every fixture below is synthetic JSONL in the shape dsh writes, checked
 * against `scratchpad/launch/2026-11-07-dsh-live/`:
 *   - `step/start` with `data.turn` / `data.step`;
 *   - `assistant/message` with `data.usage = {inputTokens, cacheReadTokens,
 *     outputTokens, totalTokens}` (the deepseek adapter writes no cacheWrite
 *     bucket; result.usage states it as 0);
 *   - `tool/call` with `data.name`, `data.callId` and JSON `arguments`, and
 *     `tool/result` with `data.message.isError`;
 *   - `compaction/start` / `compaction/end`, read as the host's native
 *     compaction bracket.
 *
 * What is held:
 *   (a) checkpoint k, billed prompt, running total, peak, fill and compaction
 *       count/timing on a known step timeline;
 *   (b) the session total and result.usage.billedPromptTokens must match;
 *   (c) a missing prompt field fails the read — it is never billed as 0;
 *   (d) writes arriving out of list order keep the step timeline;
 *   (e) a run with no deliverables reports zero created, not an error;
 *   (f) a heap of result-reported compactions with no session rows is stated
 *       as a count but its position stays null;
 *   (g) the journal's prune thresholds and first crossing are read, and a
 *       malformed journal line is recorded by number;
 *   (h) the ledger is read read-only from sqlite, and an absent ledger is
 *       unknown, not zero;
 *   (i) the CLI exits 0 on a good run and 1 on a token-less one, with the
 *       reason on stderr;
 *   (j) a shell write is a write: pwsh `Set-Content`, `Out-File` and a
 *       redirection, shell `tee` and `cp`, while a read-only shell command is
 *       not;
 *   (k) the mention fallback marks k only when the final arm holds the file,
 *       and a write tool beats it;
 *   (l) the 2026-11-07 racoons3 evidence — eleven deliverables created by a
 *       pwsh heredoc — reports 13/13, labeled by method (skipped when the
 *       local evidence tree is absent);
 *   (m) one trailing `step/start` with no `assistant/message` is a killed run
 *       stated as `tailStepIncomplete`, while an empty step before the tail
 *       still fails;
 *   (n) a longer brief's final explicit path list (or `result.checkpoints.paths`)
 *       drives the table's row count and order for any count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_DELIVERABLES,
  analyzeRun,
  analyzeText,
  deliverablesFromBrief,
  formatReport,
  matchDeliverable,
  parseDeliverables,
  parseJournal,
  parseSession,
  readLedger,
} from './dsh-checkpoints.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const TOOL = join(BENCH_DIR, 'dsh-checkpoints.mjs');
const DELIVERABLE_DIR = 'docs/plans/2026-10-27-extended-audit';
const WORLD = 'C:\\tmp\\world';

function deliverable(name) {
  return `${DELIVERABLE_DIR}/${name}`;
}

function stepStart(seq, step) {
  return { type: 'step/start', seq, time: seq, data: { turn: 1, step } };
}

function assistant(seq, step, { input, cacheRead, cacheWrite }) {
  const usage = { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: 5, totalTokens: 0 };
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  usage.totalTokens = usage.inputTokens + usage.cacheReadTokens
    + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
  return { type: 'assistant/message', seq, time: seq, data: { turn: 1, step, usage } };
}

function toolCall(seq, step, name, args, callId) {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, step, callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(seq, callId, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      toolCallId: callId,
      isError,
      message: { role: 'tool', isError, source: { kind: 'tool', callId } },
    },
  };
}

function compactionStart(seq) {
  return { type: 'compaction/start', seq, time: seq, data: { turn: 1, compactionId: 'c1' } };
}

function compactionEnd(seq) {
  return { type: 'compaction/end', seq, time: seq, data: { turn: 1, compactionId: 'c1' } };
}

function ndjson(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

/**
 * A result.json whose usage totals are summed from the same step depths the
 * session log carries, so the cross-check holds by construction.
 */
function makeResult(depths, {
  compaction = null,
  journal = null,
  sessionPath = 'C:\\tmp\\session.v4.jsonl',
} = {}) {
  const inputTokens = depths.reduce((sum, depth) => sum + depth.input, 0);
  const cacheReadTokens = depths.reduce((sum, depth) => sum + depth.cacheRead, 0);
  const cacheWriteTokens = depths.reduce((sum, depth) => sum + (depth.cacheWrite ?? 0), 0);
  const billedPromptTokens = depths.reduce((sum, depth) => sum + depth.billed, 0);
  return {
    schema: 'racoons-bench-run/1',
    arm: { name: 'racoons', dir: WORLD },
    work: { mode: 'arm', dir: WORLD },
    provider: 'deepseek-official',
    usage: {
      rows: [],
      usageRows: depths.length,
      assistantTurns: depths.length,
      inputTokens,
      outputTokens: 5 * depths.length,
      totalTokens: billedPromptTokens + 5 * depths.length,
      billedPromptTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    context: {
      unit: 'billed-prompt-tokens',
      series: depths.map((depth) => depth.billed),
      peak: Math.max(...depths.map((depth) => depth.billed)),
      final: depths.at(-1).billed,
      turns: depths.length,
    },
    compaction: compaction ?? {
      count: 0, atRequests: [], atSeqs: [], pruneEvents: 0, ends: 0, compacted: false,
    },
    session: {
      files: [sessionPath],
      events: 0,
      malformed: [],
      benchDone: { found: true, seq: 1, line: 'BENCH-DONE' },
    },
    journal: journal ?? {
      verdict: 'absent',
      emitted: false,
      file: null,
      bytes: null,
      lines: 0,
      byKind: {},
      entryAsks: 0,
      pruneThresholds: 0,
      pruneThresholdEvaluations: 0,
      mounted: null,
      ledger: {
        present: false,
        readable: false,
        file: null,
        events: {},
        applications: {},
        recallIds: [],
        appliedRemovals: null,
      },
      unparsable: [],
    },
    exit: { code: 0, durationMs: 1 },
    passed: true,
  };
}

function analyze(rows, result, extra = {}) {
  return analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    resultPath: '<result>',
    sessionPath: '<session>',
    ...extra,
  });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-checkpoints-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Steps 1..5. Checkpoints 1 (step 2), 2 (step 3) and 3 (step 4). A native
 * compaction starts before step 3, so checkpoint 1 sees 0 and checkpoints 2-3
 * see 1. Billed depths: 1000, 1300, 1600, 1800, 2000 (total 7700).
 */
function mainRows() {
  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1000, cacheRead: 300, billed: 1300 },
    { input: 1200, cacheRead: 400, billed: 1600 },
    { input: 1300, cacheRead: 500, billed: 1800 },
    { input: 1400, cacheRead: 600, billed: 2000 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'read', { path: `${WORLD}\\notes.md` }, 'call-1'),
    toolResult(4, 'call-1'),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'write', { file_path: deliverable('00-index.md') }, 'call-2'),
    toolResult(8, 'call-2'),
    // The host compacts after the prior step ends and BEFORE the next
    // `step/start`: `atRequest` is the step the compaction precedes.
    compactionStart(9),
    stepStart(10, 3),
    assistant(11, 3, depths[2]),
    toolCall(12, 3, 'write', { file_path: `${WORLD}\\docs\\plans\\2026-10-27-extended-audit\\01-orientation.md` },
      'call-3'),
    toolResult(13, 'call-3'),
    stepStart(14, 4),
    assistant(15, 4, depths[3]),
    toolCall(16, 4, 'write', { file_path: deliverable('02-entry-currency.md') }, 'call-4'),
    toolResult(17, 'call-4'),
    compactionEnd(18),
    stepStart(19, 5),
    assistant(20, 5, depths[4]),
    toolCall(21, 5, 'read', { path: `${WORLD}\\other.md` }, 'call-5'),
    toolResult(22, 'call-5'),
  ];
  return { rows, depths };
}

/**
 * One `pwsh` call whose command is a Python heredoc that writes each name
 * through `OUT+'/'+name`. The full deliverable path never appears in the
 * command text, so no write construct and no exact-path mention attributes it:
 * only the final arm's files can say the deliverables exist.
 */
function pythonHeredocRows(names, depths) {
  const script = [
    "python - <<'PY'",
    `OUT='${DELIVERABLE_DIR}'`,
    ...names.map((name) => `open(OUT+'/${name}', 'w').write('x')`),
    'PY',
  ].join('\n');
  return [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'pwsh', { command: script }, 'py-1'),
    toolResult(4, 'py-1'),
  ];
}

function writeDeliverables(dir, names) {
  for (const name of names) {
    const path = deliverable(name);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `written by python: ${name}\n`);
  }
}

test('checkpoints, billed prompt, running total, peak, fill and compaction timing', () => {
  const { rows, depths } = mainRows();
  const report = analyze(rows, makeResult(depths));

  assert.equal(report.checkpoints.length, 13);
  assert.equal(DEFAULT_DELIVERABLES.length, 13);

  const first = report.checkpoints[0];
  assert.equal(first.k, 1);
  assert.equal(first.path, deliverable('00-index.md'));
  assert.equal(first.created, true);
  assert.equal(first.step, 2);
  assert.equal(first.billedPrompt, 1300);
  assert.equal(first.runningTotal, 2300);
  assert.equal(first.peak, 1300);
  assert.equal(first.fillStep, 1300);
  assert.equal(first.fillPeak, 1300);
  assert.equal(first.compactionCount, 0);
  assert.equal(first.lastCompactionStep, null);
  assert.equal(first.deliverablesDone, 1);
  assert.equal(first.matchedVia, 'suffix', 'a relative write matches by its path suffix');

  const second = report.checkpoints[1];
  assert.equal(second.k, 2);
  assert.equal(second.step, 3);
  assert.equal(second.billedPrompt, 1600);
  assert.equal(second.runningTotal, 3900);
  assert.equal(second.peak, 1600);
  assert.equal(second.compactionCount, 1);
  assert.equal(second.lastCompactionStep, 3);
  assert.equal(second.matchedVia, 'workspace-relative', 'an absolute write strips the workspace base');

  const third = report.checkpoints[2];
  assert.equal(third.step, 4);
  assert.equal(third.billedPrompt, 1800);
  assert.equal(third.runningTotal, 5700);
  assert.equal(third.peak, 1800);
  assert.equal(third.compactionCount, 1);
  assert.equal(third.deliverablesDone, 3);

  assert.equal(report.checkpoints[3].created, false);
  assert.equal(report.checkpoints[3].step, null);
  assert.equal(report.checkpoints[3].billedPrompt, null);
  assert.equal(report.checkpoints[3].compactionCount, null);

  assert.equal(report.compaction.sessionCount, 1);
  assert.equal(report.compaction.sessionEnds, 1);
  assert.equal(report.compaction.atRequests[0], 3);
  assert.equal(report.compaction.timingRecorded, true);
  assert.equal(report.overall.steps, 5);
  assert.equal(report.overall.totalBilledPrompt, 7700);
  assert.equal(report.overall.totalInput, 5800);
  assert.equal(report.overall.totalCacheRead, 1900);
  assert.equal(report.overall.totalCacheWrite, 0);
  assert.equal(report.overall.peakFill, 2000);
  assert.equal(report.overall.finalFill, 2000);
  assert.equal(report.overall.deliverablesCreated, 3);
  assert.equal(report.overall.deliverablesMissing, 10);
  assert.equal(report.overall.writeCalls, 3);
  assert.equal(report.overall.completedWriteCalls, 3);
  assert.equal(report.overall.readCalls, 2);
  assert.equal(report.overall.billedTotalsMatch, true);
  assert.deepEqual(report.overall.shellTools, []);
});

test('the session total and result.usage.billedPromptTokens must agree', () => {
  const { rows, depths } = mainRows();
  const result = makeResult(depths);
  result.usage.billedPromptTokens += 1;
  assert.throws(
    () => analyze(rows, result),
    /session rows bill 7700 prompt token\(s\) but result\.usage bills 7701/,
  );
});

test('a missing prompt field fails loudly instead of billing 0', () => {
  const noInput = mainRows();
  delete noInput.rows[1].data.usage.inputTokens;
  assert.throws(
    () => analyze(noInput.rows, makeResult(noInput.depths)),
    /step 1 usage\.inputTokens is missing.*not billed as 0/,
  );

  const noCacheRead = mainRows();
  delete noCacheRead.rows[1].data.usage.cacheReadTokens;
  assert.throws(
    () => analyze(noCacheRead.rows, makeResult(noCacheRead.depths)),
    /step 1 usage\.cacheReadTokens is missing/,
  );

  const noUsage = mainRows();
  delete noUsage.rows[1].data.usage;
  assert.throws(
    () => analyze(noUsage.rows, makeResult(noUsage.depths)),
    /assistant\/message has no data\.usage/,
  );

  const missingResultTotal = mainRows();
  const result = makeResult(missingResultTotal.depths);
  delete result.usage.billedPromptTokens;
  assert.throws(
    () => analyze(missingResultTotal.rows, result),
    /result usage\.billedPromptTokens is missing/,
  );

  const positiveCacheWrite = mainRows();
  const cacheResult = makeResult(positiveCacheWrite.depths);
  cacheResult.usage.cacheWriteTokens = 10;
  assert.throws(
    () => analyze(positiveCacheWrite.rows, cacheResult),
    /bills 10 cache-write token\(s\).*omit usage\.cacheWriteTokens/,
  );
});

test('out-of-order writes keep the step timeline, not the list order', () => {
  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1800, cacheRead: 200, billed: 2000 },
    { input: 2700, cacheRead: 300, billed: 3000 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'write', { path: deliverable('02-entry-currency.md') }, 'call-1'),
    toolResult(4, 'call-1'),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'write', { path: deliverable('00-index.md') }, 'call-2'),
    toolResult(8, 'call-2'),
    stepStart(9, 3),
    assistant(10, 3, depths[2]),
    toolCall(11, 3, 'write', { path: deliverable('01-orientation.md') }, 'call-3'),
    toolResult(12, 'call-3'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.step), [2, 3, 1]);
  assert.deepEqual(
    report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.runningTotal),
    [3000, 6000, 1000],
  );
  assert.deepEqual(
    report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.peak),
    [2000, 3000, 1000],
  );
  assert.deepEqual(
    report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.deliverablesDone),
    [2, 3, 1],
  );
  assert.equal(report.overall.totalBilledPrompt, 6000);
});

test('a failed write does not create the checkpoint; a later completed write does', () => {
  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1800, cacheRead: 200, billed: 2000 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'write', { path: deliverable('00-index.md') }, 'call-1'),
    toolResult(4, 'call-1', true),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'write', { path: deliverable('00-index.md') }, 'call-2'),
    toolResult(8, 'call-2'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.equal(report.checkpoints[0].created, true);
  assert.equal(report.checkpoints[0].step, 2);
  assert.equal(report.overall.writeCalls, 2);
  assert.equal(report.overall.completedWriteCalls, 1);
  assert.match(report.notes.join('\n'), /1 write\/edit\/create row\(s\) did not complete/);
});

test('a differently-named 01- file is not checkpoint 2', () => {
  const depths = [{ input: 900, cacheRead: 100, billed: 1000 }];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'write', { path: deliverable('01-notes.md') }, 'call-1'),
    toolResult(4, 'call-1'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.equal(report.checkpoints[0].created, false);
  assert.equal(report.checkpoints[1].created, false, 'the default list names exact paths');
  assert.equal(report.overall.deliverablesCreated, 0);
});

test('pwsh Set-Content, Out-File and a redirection create checkpoints (shell-write)', () => {
  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1000, cacheRead: 300, billed: 1300 },
    { input: 1200, cacheRead: 400, billed: 1600 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'pwsh', {
      command: `Set-Content -LiteralPath '${deliverable('00-index.md')}' -Value 'x'`,
    }, 'sh-1'),
    toolResult(4, 'sh-1'),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'pwsh', {
      command: `'x' | Out-File -FilePath '${deliverable('01-orientation.md')}'`,
    }, 'sh-2'),
    toolResult(8, 'sh-2'),
    stepStart(9, 3),
    assistant(10, 3, depths[2]),
    toolCall(11, 3, 'pwsh', {
      command: `'x' > '${deliverable('02-entry-currency.md')}'`,
    }, 'sh-3'),
    toolResult(12, 'sh-3'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.created), [true, true, true]);
  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.method),
    ['shell-write', 'shell-write', 'shell-write']);
  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.step), [1, 2, 3]);
  assert.equal(report.overall.deliverablesCreated, 3);
  assert.equal(report.overall.shellWriteCalls, 3);
  assert.equal(report.overall.methodCounts['shell-write'], 3);
  assert.match(report.notes.join('\n'), /3 checkpoint\(s\) marked by shell-write/);
});

test('a shell tee and cp create checkpoints; a read-only shell command does not', () => {
  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1000, cacheRead: 300, billed: 1300 },
    { input: 1200, cacheRead: 400, billed: 1600 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'bash', { command: `printf x | tee '${deliverable('03-core-charter.md')}'` }, 'sh-1'),
    toolResult(4, 'sh-1'),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'shell', { command: `cp 'template.md' '${deliverable('04-core-tests.md')}'` }, 'sh-2'),
    toolResult(8, 'sh-2'),
    stepStart(9, 3),
    assistant(10, 3, depths[2]),
    toolCall(11, 3, 'bash', { command: `cat '${deliverable('05-shell-quarantine.md')}'` }, 'sh-3'),
    toolResult(12, 'sh-3'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.equal(report.checkpoints[3].method, 'shell-write');
  assert.equal(report.checkpoints[3].step, 1);
  assert.equal(report.checkpoints[4].method, 'shell-write');
  assert.equal(report.checkpoints[4].step, 2);
  assert.equal(report.checkpoints[5].created, false, 'a read-only cat is not a write');
  assert.equal(report.overall.shellWriteCalls, 2);
});

test('mention fallback marks a checkpoint only when the file exists in the arm', (t) => {
  const dir = tempDir(t);
  const first = deliverable('00-index.md');
  const second = deliverable('01-orientation.md');
  const third = deliverable('02-entry-currency.md');
  mkdirSync(dirname(join(dir, first)), { recursive: true });
  writeFileSync(join(dir, first), 'created by an opaque shell writer\n');
  writeFileSync(join(dir, second), 'created by the write tool\n');
  writeFileSync(join(dir, third), 'created by a writer the reader cannot see\n');

  const depths = [
    { input: 900, cacheRead: 100, billed: 1000 },
    { input: 1000, cacheRead: 300, billed: 1300 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    // No parsed write construct: only the exact path mention is available.
    toolCall(3, 1, 'pwsh', { command: `./opaque-writer.ps1 -Target '${first}'` }, 'm-1'),
    toolResult(4, 'm-1'),
    toolCall(5, 1, 'read', { path: third }, 'm-r'),
    toolResult(6, 'm-r'),
    stepStart(7, 2),
    assistant(8, 2, depths[1]),
    toolCall(9, 2, 'pwsh', { command: `./opaque-writer.ps1 -Target '${second}'` }, 'm-2'),
    toolResult(10, 'm-2'),
    toolCall(11, 2, 'write', { file_path: second }, 'w-1'),
    toolResult(12, 'w-1'),
  ];
  const result = makeResult(depths);
  const report = analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    armDir: dir,
    resultPath: '<result>',
    sessionPath: '<session>',
  });

  assert.equal(report.checkpoints[0].created, true);
  assert.equal(report.checkpoints[0].method, 'mention-fallback');
  assert.equal(report.checkpoints[0].step, 1);
  assert.equal(report.checkpoints[1].created, true);
  assert.equal(report.checkpoints[1].method, 'write-tool',
    'a write tool beats the mention fallback for the same deliverable');
  assert.equal(report.checkpoints[2].created, true);
  assert.equal(report.checkpoints[2].method, 'mention-fallback',
    'a read call naming the exact path can carry the fallback');
  assert.equal(report.checkpoints[2].step, 1);
  assert.equal(report.overall.deliverablesCreated, 3);
  assert.equal(report.overall.methodCounts['mention-fallback'], 2);
  assert.deepEqual(report.overall.mentionFallbackPaths, [first, third]);
  assert.match(report.notes.join('\n'), /2 checkpoint\(s\) marked by mention-fallback/);

  const missing = analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    armDir: join(dir, 'no-such-arm'),
    resultPath: '<result>',
    sessionPath: '<session>',
  });
  assert.equal(missing.checkpoints[0].created, false,
    'the mention is not enough when the file is absent from the final arm');
  assert.equal(missing.checkpoints[0].method, null);
});

test('a Python heredoc counts the files even when write attribution is 0', (t) => {
  const dir = tempDir(t);
  const names = ['00-index.md', '01-orientation.md', '02-entry-currency.md', '03-core-charter.md'];
  writeDeliverables(dir, names);
  const depths = [{ input: 900, cacheRead: 100, billed: 1000 }];
  const rows = pythonHeredocRows(names, depths);
  const result = makeResult(depths);
  result.checkpoints = { expected: 4, source: 'brief', paths: names.map(deliverable) };
  const report = analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    armDir: dir,
    resultPath: '<result>',
    sessionPath: '<session>',
  });

  // The command writes through OUT+'/'+name, so the reader parses no write
  // target and no exact-path mention. The files are still the deliverable.
  assert.equal(report.overall.writeCalls, 0);
  assert.equal(report.overall.shellWriteCalls, 0);
  assert.equal(report.overall.attributedCreated, 0);
  assert.equal(report.overall.deliverableCount, 4);
  assert.equal(report.overall.deliverablesCreated, 4);
  assert.equal(report.overall.filesPresent, 4);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.created), [true, true, true, true]);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.filesPresent), [true, true, true, true]);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.method), [null, null, null, null]);
  assert.match(report.notes.join('\n'),
    /4 deliverable file\(s\) are present in the final arm, so created counts the files/);
});

test('the resumed 36-record shape (four new records) reports 4/4', (t) => {
  // A continued 36-record session carries 32 already-written records and asks
  // for four new ones; the round's result carries those four paths.
  const dir = tempDir(t);
  const names = ['32-adr-summaries.md', '33-spec-summaries-a.md',
    '34-spec-summaries-b.md', '35-pelican-bicycle.html'];
  writeDeliverables(dir, names);
  const depths = [{ input: 900, cacheRead: 100, billed: 1000 }];
  const rows = pythonHeredocRows(names, depths);
  const result = makeResult(depths);
  result.checkpoints = { expected: 4, source: 'brief', paths: names.map(deliverable) };
  const report = analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    armDir: dir,
    resultPath: '<result>',
    sessionPath: '<session>',
  });

  assert.equal(report.overall.deliverableCount, 4);
  assert.equal(report.overall.deliverablesCreated, 4);
  assert.equal(report.overall.filesPresent, 4);
  assert.equal(report.overall.attributedCreated, 0);
  assert.equal(report.overall.writeCalls, 0);
  assert.equal(report.overall.shellWriteCalls, 0);
  const text = formatReport(report);
  assert.match(text, /created \(files present\): 4\/4/u,
    'a resumed round keeps reporting four of four files');
  assert.match(text, /write attribution: 0 write\/edit\/create call\(s\), 0 shell write call\(s\)/u);
});

test('a resumed adopted log with prior-leg rows bills only the new leg (ISSUE-491)', (t) => {
  // The REAL adopted-log shape: the prior leg's assistant rows stay in the
  // session log while result.usage is bounded to the new leg — the launcher
  // sums only rows with seq > resumedFrom.priorSeq (ISSUE-270).
  const dir = tempDir(t);
  const names = ['32-adr-summaries.md', '33-spec-summaries-a.md',
    '34-spec-summaries-b.md', '35-pelican-bicycle.html'];
  writeDeliverables(dir, names);
  const prior = { input: 4000, cacheRead: 1000, billed: 5000 };
  const fresh = { input: 900, cacheRead: 100, billed: 1000 };
  const script = [
    "python - <<'PY'",
    `OUT='${DELIVERABLE_DIR}'`,
    ...names.map((name) => `open(OUT+'/${name}', 'w').write('x')`),
    'PY',
  ].join('\n');
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, prior),
    toolCall(3, 1, 'read', { path: `${WORLD}\\notes.md` }, 'prior-1'),
    toolResult(4, 'prior-1'),
    stepStart(5, 2),
    assistant(6, 2, prior),
    stepStart(7, 3),
    assistant(8, 3, fresh),
    toolCall(9, 3, 'pwsh', { command: script }, 'new-1'),
    toolResult(10, 'new-1'),
  ];
  const resumedFrom = {
    sessionId: 'session-1', priorSeq: 6, file: 'C:\\tmp\\session.v4.jsonl', askJournals: [],
  };
  const result = makeResult([fresh]);
  result.round = 2;
  result.resumedFrom = resumedFrom;
  result.checkpoints = { expected: 4, source: 'brief', paths: names.map(deliverable) };
  const input = {
    sessionText: ndjson(rows),
    armDir: dir,
    resultPath: '<result>',
    sessionPath: '<session>',
  };
  const report = analyzeText({ ...input, resultText: JSON.stringify(result) });

  assert.equal(report.overall.billedTotalsMatch, true);
  assert.equal(report.overall.totalBilledPrompt, 1000, 'the billed total is the new leg, not the whole log');
  assert.equal(report.overall.resultBilledPromptTokens, 1000);
  assert.equal(report.overall.deliverablesCreated, 4);
  assert.equal(report.overall.steps, 3, 'the step timeline keeps the prior leg');
  assert.equal(report.steps.at(-1).runningTotal, 11000);
  assert.match(report.notes.join('\n'), /seq > 6/u);

  // A genuine disagreement on the bounded population still fails closed.
  const wrong = makeResult([fresh]);
  wrong.resumedFrom = resumedFrom;
  wrong.usage.billedPromptTokens += 1;
  assert.throws(
    () => analyzeText({ ...input, resultText: JSON.stringify(wrong) }),
    /session rows bill 1000 prompt token\(s\) but result\.usage bills 1001/u,
  );
});

test('a resumed round bounds the cache-write omission check at priorSeq too (ISSUE-491)', () => {
  // The prior leg omits usage.cacheWriteTokens; the new leg bills the bucket.
  // result.usage describes the new leg, so the prior omission is not its gap.
  const prior = { input: 4000, cacheRead: 1000, billed: 5000 };
  const fresh = { input: 900, cacheRead: 100, cacheWrite: 50, billed: 1050 };
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, prior),
    stepStart(3, 2),
    assistant(4, 2, fresh),
  ];
  const result = makeResult([fresh]);
  result.resumedFrom = {
    sessionId: 'session-1', priorSeq: 2, file: 'C:\\tmp\\session.v4.jsonl', askJournals: [],
  };
  const report = analyze(rows, result);
  assert.equal(report.overall.billedTotalsMatch, true);
  assert.equal(report.overall.totalBilledPrompt, 1050);

  // A resumedFrom with no readable priorSeq cannot bound the leg: named refusal.
  const noSeq = makeResult([fresh]);
  noSeq.resumedFrom = { sessionId: 'session-1' };
  assert.throws(() => analyze(rows, noSeq), /resumedFrom carries no readable priorSeq/u);
});

test('the 2026-11-07 racoons3 evidence reports 13/13, most by shell-write', {
  skip: !existsSync(join(BENCH_DIR, '..', '..', 'scratchpad', 'launch',
    '2026-11-07-dsh-live', 'racoons3', 'evidence', 'result.json')),
}, () => {
  const evidenceDir = join(BENCH_DIR, '..', '..', 'scratchpad', 'launch',
    '2026-11-07-dsh-live', 'racoons3', 'evidence');
  const report = analyzeRun({ evidenceDir });

  assert.equal(report.overall.deliverablesCreated, 13);
  assert.equal(report.overall.deliverablesMissing, 0);
  assert.equal(report.overall.methodCounts['write-tool'], 2);
  assert.equal(report.overall.methodCounts['shell-write'], 11);
  assert.equal(report.overall.methodCounts['mention-fallback'], 0);
  assert.equal(report.checkpoints[2].method, 'shell-write');
  assert.ok(report.checkpoints[2].step < report.checkpoints[12].step,
    'the shell-write checkpoints keep their own step timeline');
});

test('no deliverables: zero created, tokens still accounted', () => {
  const depths = [
    { input: 480, cacheRead: 20, billed: 500 },
    { input: 670, cacheRead: 30, billed: 700 },
  ];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'read', { path: `${WORLD}\\a.txt` }, 'call-1'),
    toolResult(4, 'call-1'),
    stepStart(5, 2),
    assistant(6, 2, depths[1]),
    toolCall(7, 2, 'read', { path: `${WORLD}\\b.txt` }, 'call-2'),
    toolResult(8, 'call-2'),
  ];
  const report = analyze(rows, makeResult(depths));

  assert.equal(report.checkpoints.length, 13);
  assert.equal(report.checkpoints.every((checkpoint) => checkpoint.created === false), true);
  assert.equal(report.overall.deliverablesCreated, 0);
  assert.equal(report.overall.deliverablesMissing, 13);
  assert.equal(report.overall.writeCalls, 0);
  assert.equal(report.overall.totalBilledPrompt, 1200);
  assert.equal(report.overall.peakFill, 700);
  assert.equal(report.overall.finalFill, 700);
  assert.equal(report.journal, null);
});

test('a result-reported compaction count with no session rows keeps the position null', () => {
  const depths = [{ input: 900, cacheRead: 100, billed: 1000 }];
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, depths[0]),
    toolCall(3, 1, 'write', { path: deliverable('00-index.md') }, 'call-1'),
    toolResult(4, 'call-1'),
  ];
  const result = makeResult(depths, {
    compaction: { count: 2, atRequests: [], atSeqs: [], pruneEvents: 0, ends: 2, compacted: true },
  });
  const report = analyze(rows, result);

  assert.equal(report.checkpoints[0].created, true);
  assert.equal(report.checkpoints[0].compactionCount, null);
  assert.equal(report.checkpoints[0].lastCompactionStep, null);
  assert.equal(report.compaction.timingRecorded, false);
  assert.equal(report.compaction.hostCount, 2);
  assert.match(report.notes.join('\n'), /per-checkpoint position is null, not invented/);

  const zero = analyze(rows, makeResult(depths, {
    compaction: { count: 0, atRequests: [], atSeqs: [], pruneEvents: 0, ends: 0, compacted: false },
  }));
  assert.equal(zero.checkpoints[0].compactionCount, 0);
});

test('journal prune thresholds, first crossing and malformed rows are read', () => {
  const text = [
    JSON.stringify({ kind: 'entry-ask', atMs: 1 }),
    JSON.stringify({ kind: 'prune-threshold', threshold: 60000, estimatedTokens: 59000, crossed: false }),
    JSON.stringify({ kind: 'prune-threshold', threshold: 60000, estimatedTokens: 64304, crossed: true }),
    JSON.stringify({ kind: 'prune-ask', atMs: 3 }),
    JSON.stringify({ kind: 'prune-ask', atMs: 4 }),
    'not json',
    '',
  ].join('\n');
  const journal = parseJournal(text, '<journal>');

  assert.equal(journal.rows, 5);
  assert.equal(journal.byKind['prune-threshold'], 2);
  assert.equal(journal.byKind['prune-ask'], 2);
  assert.equal(journal.entryAsks, 1);
  assert.equal(journal.pruneAsks, 2);
  assert.deepEqual(journal.thresholds, [60000]);
  assert.equal(journal.firstCrossing.estimatedTokens, 64304);
  assert.equal(journal.firstCrossing.threshold, 60000);
  assert.equal(journal.malformed.length, 1);
  assert.equal(journal.malformed[0].line, 6);
});

test('the ledger is read read-only from sqlite; absence is unknown, not zero', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'ledger.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ledger_events (kind TEXT NOT NULL);
    CREATE TABLE applications (intent_id TEXT PRIMARY KEY);
    CREATE TABLE recalls (recall_id TEXT PRIMARY KEY);
    CREATE TABLE application_removals (recall_id TEXT NOT NULL);
  `);
  db.exec(`
    INSERT INTO ledger_events (kind) VALUES ('prepared'), ('prepared'), ('applied'), ('validation');
    INSERT INTO applications (intent_id) VALUES ('i1'), ('i2');
    INSERT INTO recalls (recall_id) VALUES ('recall:sha256:aa'), ('recall:sha256:bb');
    INSERT INTO application_removals (recall_id) VALUES ('recall:sha256:aa'), ('recall:sha256:bb');
  `);
  db.close();

  const ledger = readLedger(path);
  assert.equal(ledger.present, true);
  assert.equal(ledger.readable, true);
  assert.equal(ledger.applied, 1);
  assert.equal(ledger.prepared, 2);
  assert.equal(ledger.validation, 1);
  assert.equal(ledger.applications, 2);
  assert.equal(ledger.recalls, 2);
  assert.equal(ledger.removals, 2);
  assert.deepEqual(ledger.recallIds, ['recall:sha256:aa', 'recall:sha256:bb']);

  const absent = readLedger(join(dir, 'nope.sqlite'));
  assert.equal(absent.present, false);
  assert.equal(absent.readable, false);
});

test('a malformed session line fails with its line number', () => {
  const { rows, depths } = mainRows();
  const text = `${ndjson(rows)}not json\n`;
  assert.throws(
    () => analyzeText({
      resultText: JSON.stringify(makeResult(depths)),
      sessionText: text,
      resultPath: '<result>',
      sessionPath: '<broken>',
    }),
    /<broken>:23 is not JSON/,
  );
});

test('a trailing step/start with no assistant/message is a killed run, not corruption', () => {
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, { input: 900, cacheRead: 100 }),
    stepStart(3, 2),
  ];
  const killed = parseSession(ndjson(rows), '<killed>');
  assert.equal(killed.steps.length, 2);
  assert.equal(killed.tailStepIncomplete, true);
  assert.equal(killed.tailStepIndex, 2);

  const complete = parseSession(ndjson(rows.slice(0, 2)), '<complete>');
  assert.equal(complete.tailStepIncomplete, false);
  assert.equal(complete.tailStepIndex, null);
});

test('a step/start with no assistant/message before the tail still fails', () => {
  const rows = [
    stepStart(1, 1),
    stepStart(2, 2),
    assistant(3, 2, { input: 900, cacheRead: 100 }),
  ];
  assert.throws(
    () => parseSession(ndjson(rows), '<broken>'),
    /<broken> step 1 has no assistant\/message usage; a step without prompt tokens is missing, not a zero/,
  );
});

test('the brief parser reads a final explicit path list, in its own order', () => {
  const task = [
    'Do the work.',
    '',
    'Deliverables, in order:',
    '`docs/plans/x/02-c.md`',
    '- docs/plans/x/00-a.md',
    '3. docs/plans/x/01-b.md.',
  ].join('\n');
  assert.deepEqual(deliverablesFromBrief(task), [
    'docs/plans/x/02-c.md',
    'docs/plans/x/00-a.md',
    'docs/plans/x/01-b.md',
  ]);
  // The task fence wins over a different list that ends the whole brief; when
  // the fence names no list, the whole brief's final list is the fallback.
  const whole = 'task above\n\nDeliverables:\nother/09-z.md\nother/08-y.md\n';
  assert.deepEqual(deliverablesFromBrief('do it', whole), ['other/09-z.md', 'other/08-y.md']);
  assert.deepEqual(deliverablesFromBrief('do it\n\nfiles:\none/01.md\ntwo/02.md', whole),
    ['one/01.md', 'two/02.md']);
});

test('the brief parser reads the last list a ":" line introduces, mid-text', () => {
  const task = [
    'Do the work.',
    '',
    'The three records are, by exact filename:',
    '00-a.md',
    '01-b.md',
    '02-c.md',
    '',
    'Write no other file under docs/plans/x/, then print BENCH-DONE.',
    '',
    '## Done criteria',
    '',
    '1. The three files exist.',
  ].join('\n');
  assert.deepEqual(deliverablesFromBrief(task), [
    'docs/plans/x/00-a.md',
    'docs/plans/x/01-b.md',
    'docs/plans/x/02-c.md',
  ]);
  // A wrapped sentence that splits paths across lines is not a list: the line
  // before the run ends in a comma, not a colon, so it introduces nothing.
  const wrapped = 'Check these index files: docs/project/index.md,\n'
    + '  docs/guides/index.md,\n  docs/adr/index.md,\nand fix them.';
  assert.equal(deliverablesFromBrief(wrapped), null);
});

test('the brief parser falls back to the default thirteen and never mines prose', () => {
  const extended = readFileSync(join(BENCH_DIR, 'bench-brief-extended.md'), 'utf8');
  assert.deepEqual(deliverablesFromBrief(extended), [...DEFAULT_DELIVERABLES],
    'the extended brief names all thirteen files but no full path');
  assert.equal(deliverablesFromBrief('A smoke task with no file list.\n\nWrite one note.'), null);
  assert.equal(deliverablesFromBrief('Read docs/project/index.md and fix it.'), null,
    'one path in prose is not a deliverable list');
});

test('the thirty-two-name brief derives its own list from the final names', {
  skip: !existsSync(join(BENCH_DIR, 'bench-brief-extended-32.md')),
}, () => {
  const brief = readFileSync(join(BENCH_DIR, 'bench-brief-extended-32.md'), 'utf8');
  const fence = brief.match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/u);
  assert.notEqual(fence, null, 'the brief has a task fence');
  const paths = deliverablesFromBrief(fence[1], brief);
  assert.equal(paths.length, 32);
  assert.equal(paths[0], deliverable('00-index.md'));
  assert.equal(paths[12], deliverable('12-corpus-zh.md'));
  assert.equal(paths[13], deliverable('13-adr-ledger.md'));
  assert.equal(paths[31], deliverable('31-other-games-ledger.md'));
});

test('result.checkpoints.paths drives the table: three rows, brief order, k follows', () => {
  const { rows, depths } = mainRows();
  const paths = [
    deliverable('02-entry-currency.md'),
    deliverable('00-index.md'),
    deliverable('01-orientation.md'),
  ];
  const result = makeResult(depths);
  result.checkpoints = { expected: 3, source: 'brief', paths };
  const report = analyze(rows, result);
  assert.equal(report.overall.deliverableCount, 3);
  assert.equal(report.overall.deliverableSource, '<result checkpoints.paths>');
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.path), paths);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.k), [1, 2, 3]);
  // The steps follow the list, not the list's original 00/01/02 order: 02 was
  // written at step 4, 00 at step 2 and 01 at step 3.
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.step), [4, 2, 3]);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.deliverablesDone), [3, 1, 2]);
  assert.equal(report.overall.deliverablesCreated, 3);
  assert.equal(report.overall.deliverablesMissing, 0);

  const text = formatReport(report);
  const table = text.split('\n').filter((line) => /^\d+\s+docs\/plans\//u.test(line));
  assert.equal(table.length, 3, 'one table row per expected deliverable');
  assert.deepEqual(table.map((line) => line.split(/\s+/u)[1]), paths);
});

test('an explicit deliverables override still wins over result.checkpoints.paths', () => {
  const { rows, depths } = mainRows();
  const result = makeResult(depths);
  result.checkpoints = { expected: 3, source: 'brief', paths: DEFAULT_DELIVERABLES.slice(0, 3) };
  const report = analyzeText({
    resultText: JSON.stringify(result),
    sessionText: ndjson(rows),
    deliverablesText: 'one/00.md\ntwo/01.md\n',
  });
  assert.equal(report.overall.deliverableCount, 2);
  assert.deepEqual(report.checkpoints.map((checkpoint) => checkpoint.path), ['one/00.md', 'two/01.md']);
});

test('CLI: --json reports the run and a token-less run exits 1', (t) => {
  const dir = tempDir(t);
  const sessionPath = join(dir, 'session.v4.jsonl');
  const resultPath = join(dir, 'result.json');
  const { rows, depths } = mainRows();
  writeFileSync(sessionPath, ndjson(rows));
  writeFileSync(resultPath, JSON.stringify(makeResult(depths, { sessionPath })));

  const good = spawnSync(process.execPath, [TOOL, dir, '--json'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.overall.totalBilledPrompt, 7700);
  assert.equal(parsed.checkpoints[0].step, 2);
  assert.equal(parsed.overall.deliverablesCreated, 3);

  const brokenRows = mainRows();
  delete brokenRows.rows[1].data.usage.inputTokens;
  writeFileSync(sessionPath, ndjson(brokenRows.rows));
  writeFileSync(resultPath, JSON.stringify(makeResult(brokenRows.depths, { sessionPath })));
  const broken = spawnSync(process.execPath, [TOOL, dir], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /usage\.inputTokens is missing/);
  assert.match(broken.stderr, /not billed as 0/);
});

// ---------------------------------------------------------------------------
// The 2026-11-08 censored stop. A run stopped at a work checkpoint carries a
// `stop` block; the reader repeats it and gates on benchDone.found, never
// `passed` (which is false by construction on every stop).
// ---------------------------------------------------------------------------

test('a censored checkpoint stop is stated with its work and benchDone, never read as passed', () => {
  const { rows, depths } = mainRows();
  const result = makeResult(depths);
  result.passed = false;
  result.stoppedBy = 'checkpoint';
  result.stop = {
    reason: 'checkpoint',
    censored: true,
    exitName: 'stopped-at-checkpoint',
    checkpoint: {
      path: deliverable('07-plan-traceability.md'),
      resolved: `${WORLD}\${deliverable('07-plan-traceability.md')}`,
      billedPromptTokens: 1800,
      compactions: 1,
      killLanded: true,
    },
    benchDone: { found: false, seq: null },
    deliverablesCreated: 3,
    largestCheckpointReached: 3,
    largestCommonK: 3,
  };
  const report = analyze(rows, result);
  assert.equal(report.overall.censoredPartial, true);
  assert.equal(report.overall.stoppedBy, 'checkpoint');
  assert.equal(report.overall.stop.reason, 'checkpoint');
  assert.equal(report.overall.stop.checkpoint.killLanded, true);
  assert.equal(report.overall.stop.checkpoint.billedPromptTokens, 1800);
  assert.equal(report.overall.stop.benchDone.found, false);
  assert.equal(report.overall.stop.largestCommonK, 3);
  assert.equal(report.overall.passed, false);
  assert.match(report.notes.join('\n'),
    /censored partial: stopped by checkpoint[\s\S]*benchDone\.found=false[\s\S]*never passed/u);
});

test('a completed run has no stop block and is not marked censored', () => {
  const { rows, depths } = mainRows();
  const report = analyze(rows, makeResult(depths));
  assert.equal(report.overall.censoredPartial, false);
  assert.equal(report.overall.stoppedBy, null);
  assert.equal(report.overall.stop, null);
});

// ---------------------------------------------------------------------------
// ISSUE-391 — parser mis-bind, win32 case parity, and result→call Map matching.
// ---------------------------------------------------------------------------

test('CLI: --session --json is a named refusal, not --json bound as the path (ISSUE-391)', (t) => {
  const dir = tempDir(t);
  const sessionPath = join(dir, 'session.v4.jsonl');
  const resultPath = join(dir, 'result.json');
  const { rows, depths } = mainRows();
  writeFileSync(sessionPath, ndjson(rows));
  writeFileSync(resultPath, JSON.stringify(makeResult(depths, { sessionPath })));
  // A valid run: the only thing wrong is `--session` with no value before
  // `--json`. The hand-rolled parser bound `--json` as the session path; the
  // shared parser refuses by name instead (exit 2).
  const result = spawnSync(process.execPath, [TOOL, dir, '--session', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /--session needs a value/);
});

test('win32: a workspace-relative write matches a deliverable case-insensitively (ISSUE-391)', () => {
  const [d] = parseDeliverables(`${DELIVERABLE_DIR}/00-index.md`);
  const base = 'C:\\Users\\TZhen\\ws';
  const write = 'C:\\Users\\TZhen\\ws\\DOCS\\PLANS\\2026-10-27-EXTENDED-AUDIT\\00-INDEX.MD';
  const m = matchDeliverable(write, d, base);
  assert.equal(m.via, 'workspace-relative');
  if (process.platform === 'win32') {
    assert.equal(m.matched, true, 'win32 folds case for the workspace-relative comparison');
  } else {
    assert.equal(m.matched, false, 'non-win32 keeps case-sensitive workspace-relative matching');
  }
});

test('tool results bind to their calls across steps and out of order (ISSUE-391 Map)', () => {
  const rows = [
    stepStart(1, 1),
    assistant(2, 1, { input: 100, cacheRead: 0 }),
    toolCall(3, 1, 'write', { file_path: 'a.md' }, 'call-a'),
    toolCall(4, 1, 'write', { file_path: 'b.md' }, 'call-b'),
    stepStart(5, 2),
    assistant(6, 2, { input: 100, cacheRead: 0 }),
    toolCall(7, 2, 'write', { file_path: 'c.md' }, 'call-c'),
    // Results arrive out of call order and across steps; each must still bind.
    toolResult(8, 'call-c', false),
    toolResult(9, 'call-a', true),
    toolResult(10, 'call-b', false),
  ];
  const session = parseSession(ndjson(rows));
  const byId = Object.fromEntries(session.toolCalls.map((c) => [c.callId, c]));
  assert.equal(byId['call-a'].completed, true);
  assert.equal(byId['call-a'].isError, true);
  assert.equal(byId['call-b'].completed, true);
  assert.equal(byId['call-b'].isError, false);
  assert.equal(byId['call-c'].completed, true);
  assert.equal(byId['call-c'].isError, false);
});
