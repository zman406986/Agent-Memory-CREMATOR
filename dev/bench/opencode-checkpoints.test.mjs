#!/usr/bin/env node
/**
 * Offline gates for `opencode-checkpoints.mjs`.
 *
 * Every fixture below is synthetic JSONL in the shape opencode 2.4.0 actually
 * writes (checked against `scratchpad/launch/2026-11-08-opencode-workspace/`):
 * `step_start`, `tool_use` with `part.state.input.path`, and `step_finish` with
 * `part.tokens = { input, output, reasoning, cache: { read, write } }`.
 *
 * What is held:
 *   (a) checkpoint k, billed prompt, running total, peak and compaction count
 *       on a known step timeline (including a compaction row inside a step);
 *   (b) a missing token field fails the read — it is never billed as 0;
 *   (c) writes arriving out of list order still report the step timeline;
 *   (d) a run with no deliverables reports zero created, not an error;
 *   (e) the deliverable override accepts both newline and JSON files, a
 *       prefix entry matches by filename prefix, and the default list uses
 *       exact paths (a differently-named `01-…` file is not checkpoint 2);
 *   (f) result.json's compaction total is stated but is not invented into a
 *       per-checkpoint count when the stdout stream has no compaction rows;
 *   (g) on a host-step-tokens basis the host total and the step sum come from
 *       the same rows, so a difference is reported as a reader mismatch, not
 *       auxiliary tokens; under a capture basis (or a missing meterBasis) the
 *       capture estimate is reported separately and nothing is subtracted;
 *   (h) the compaction position is labelled by atMainRequests (primary-request
 *       index) and atRequests stays visible as the capture sequence;
 *   (i) shell/bash/execute rows are counted and reported, never read as writes;
 *   (j) the CLI exits 0 on a good log and 1 on a token-less one, with the
 *       reason on stderr.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeText, DEFAULT_DELIVERABLES, formatReport } from './opencode-checkpoints.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const TOOL = join(BENCH_DIR, 'opencode-checkpoints.mjs');
const DELIVERABLE_DIR = 'docs/plans/2026-10-27-extended-audit';
const WORLD = 'C:\\tmp\\world';

/** A deliverable path as the host would write it inside `WORLD`. */
function deliverable(name) {
  return `${WORLD}\\${DELIVERABLE_DIR.replaceAll('/', '\\')}\\${name}`;
}

function stepStart(timestamp) {
  return { type: 'step_start', timestamp, sessionID: 'ses_fixture', part: { type: 'step-start' } };
}

function toolUse(tool, path, timestamp) {
  return {
    type: 'tool_use',
    timestamp,
    sessionID: 'ses_fixture',
    part: { type: 'tool', tool, state: { status: 'completed', input: { path } } },
  };
}

function stepFinish(input, {
  cacheRead = 0, cacheWrite = 0, output = 5, reasoning = 0, reason = 'tool-calls', timestamp = 0,
} = {}) {
  return {
    type: 'step_finish',
    timestamp,
    sessionID: 'ses_fixture',
    part: {
      type: 'step-finish',
      reason,
      cost: 0,
      tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    },
  };
}

function compactionRow(timestamp) {
  return { type: 'compaction', timestamp, sessionID: 'ses_fixture', part: { type: 'compaction' } };
}

function ndjson(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

/**
 * Three deliverables created on steps 2, 3 and 4; step 1 and step 5 only read.
 * Billed prompts: 1100, 1300, 1600, 1800, 2000 (total 7800).
 */
function mainRows() {
  return [
    stepStart(1),
    toolUse('read', `${WORLD}\\a.txt`, 2),
    stepFinish(1000, { cacheRead: 100, output: 7, reasoning: 3, timestamp: 3 }),
    stepStart(4),
    toolUse('write', `${WORLD}/docs/plans/2026-10-27-extended-audit/00-index.md`, 5),
    stepFinish(1300, { output: 5, timestamp: 6 }),
    stepStart(7),
    compactionRow(8),
    toolUse('write', deliverable('01-orientation.md'), 9),
    stepFinish(1400, { cacheRead: 200, output: 6, timestamp: 10 }),
    stepStart(11),
    toolUse('write', deliverable('02-entry-currency.md'), 12),
    stepFinish(1500, { cacheRead: 300, output: 5, timestamp: 13 }),
    stepStart(14),
    toolUse('read', `${WORLD}\\small-notes.txt`, 15),
    stepFinish(1600, { cacheRead: 400, output: 5, reason: 'stop', timestamp: 16 }),
  ];
}

const MAIN_RESULT = {
  arm: 'test',
  runId: 'run-fixture',
  workspace: { path: WORLD },
  spend: { billedPromptTokens: 7800, billedCompletionTokens: 20, meterBasis: 'host-step-tokens' },
  compaction: { compactionRequests: 0, journalEvents: 0, keyWritten: false },
  task: { finalText: 'DONE' },
};

function analyze(rows, result = null, extra = {}) {
  return analyzeText({
    stdoutText: ndjson(rows),
    resultText: result === null ? null : JSON.stringify(result),
    stdoutPath: '<fixture>',
    resultPath: result === null ? null : '<result>',
    ...extra,
  });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-checkpoints-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('checkpoints, billed prompt, running total, peak and compaction on a known timeline', () => {
  const report = analyze(mainRows(), MAIN_RESULT);

  assert.equal(report.checkpoints.length, DEFAULT_DELIVERABLES.length);
  assert.equal(DEFAULT_DELIVERABLES.length, 13);

  const first = report.checkpoints[0];
  assert.equal(first.k, 1);
  assert.equal(first.path, `${DELIVERABLE_DIR}/00-index.md`);
  assert.equal(first.created, true);
  assert.equal(first.step, 2);
  assert.equal(first.billedPrompt, 1300);
  assert.equal(first.runningTotal, 2400);
  assert.equal(first.peak, 1300);
  assert.equal(first.compactionSoFar, 0);

  const second = report.checkpoints[1];
  assert.equal(second.k, 2);
  assert.equal(second.path, `${DELIVERABLE_DIR}/01-orientation.md`);
  assert.equal(second.spec, `${DELIVERABLE_DIR}/01-orientation.md`);
  assert.equal(second.prefix, false, 'the default list names exact paths, not prefixes');
  assert.equal(second.step, 3);
  assert.equal(second.billedPrompt, 1600);
  assert.equal(second.runningTotal, 4000);
  assert.equal(second.peak, 1600);
  assert.equal(second.compactionSoFar, 1);

  const third = report.checkpoints[2];
  assert.equal(third.step, 4);
  assert.equal(third.billedPrompt, 1800);
  assert.equal(third.runningTotal, 5800);
  assert.equal(third.peak, 1800);
  assert.equal(third.compactionSoFar, 1);

  assert.equal(report.checkpoints[3].created, false);
  assert.equal(report.checkpoints[3].step, null);
  assert.equal(report.checkpoints[3].compactionSoFar, null);

  assert.equal(report.steps.length, 5);
  assert.equal(report.steps[0].input, 1000);
  assert.equal(report.steps[0].cacheRead, 100);
  assert.equal(report.steps[0].cacheWrite, 0);
  assert.equal(report.steps[0].output, 7);
  assert.equal(report.steps[0].reasoning, 3);
  assert.equal(report.steps[4].peak, 2000);

  assert.equal(report.overall.totalBilledPrompt, 7800);
  assert.equal(report.overall.peakFill, 2000);
  assert.equal(report.overall.finalFill, 2000);
  assert.equal(report.overall.stdoutCompactionEvents, 1);
  assert.equal(report.overall.hostCompactionRequests, 0);
  assert.equal(report.overall.deliverablesCreated, 3);
  assert.equal(report.overall.deliverablesMissing, 10);
  assert.equal(report.overall.writeCalls, 3);
  assert.equal(report.overall.completedWriteCalls, 3);
  assert.equal(report.overall.readCalls, 2);
  assert.equal(report.overall.resultBilledPromptTokens, 7800);
  assert.equal(report.overall.resultBilledPromptMatches, true);
  assert.equal(report.workspaceBase, WORLD);
  assert.equal(report.overhead, undefined,
    'the overhead row is gone: on a runner result it was structurally zero');
  assert.equal(report.overall.stepTotalDifferenceTokens, 0,
    'the runner sums the same host step_finish rows, so 0 is the expected agreement');
  assert.equal(report.overall.auxiliaryRequestCount, null,
    'a missing title/tool-less count is unknown, not 0');
  assert.equal(report.overall.hostCompactionAtRequests, null);
  assert.equal(report.overall.hostCompactionAtMainRequests, null);
  assert.equal(report.compactionPosition.atMainRequests, null);
  assert.equal(report.compactionPosition.captureSequence.atRequests, null);
});

test('the compaction position is labelled by atMainRequests; atRequests stays the capture sequence', () => {
  const report = analyze(mainRows(), {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 7800, meterBasis: 'host-step-tokens' },
    compaction: {
      compactionRequests: 2, atRequests: [5, 7], atMainRequests: [3, 5],
      journalEvents: 0, keyWritten: false,
    },
  });
  assert.deepEqual(report.compactionPosition.atMainRequests, [3, 5]);
  assert.deepEqual(report.compactionPosition.captureSequence.atRequests, [5, 7]);
  assert.match(report.compactionPosition.label, /primary \(main and compaction\) request index/);
  assert.match(report.compactionPosition.captureSequence.label, /ask and title included/);
  assert.deepEqual(report.overall.hostCompactionAtMainRequests, [3, 5]);
  assert.deepEqual(report.overall.hostCompactionAtRequests, [5, 7]);
  const notes = report.notes.join('\n');
  assert.match(notes, /main request \[3, 5\] \(primary-request index: main and\s+compaction rows only\)/);
  assert.match(notes, /capture sequence is \[5, 7\] \(every captured row, ask and title\s+included\)/);
  const text = formatReport(report);
  assert.match(text, /host compaction position: main request \[3, 5\] \(primary-request index\)/);
  assert.match(text, /capture seq \[5, 7\] \(capture sequence; ask and title rows included\)/);

  // A malformed position is not silently dropped.
  assert.throws(
    () => analyze(mainRows(), {
      workspace: { path: WORLD },
      compaction: { compactionRequests: 1, atMainRequests: [0, 'x'] },
    }),
    /compaction\.atMainRequests\[1\] is "x", which is not a count/,
  );
});

test('the default list names exact deliverables, not prefixes', () => {
  assert.equal(DEFAULT_DELIVERABLES.length, 13);
  assert.deepEqual(DEFAULT_DELIVERABLES.slice(0, 3), [
    `${DELIVERABLE_DIR}/00-index.md`,
    `${DELIVERABLE_DIR}/01-orientation.md`,
    `${DELIVERABLE_DIR}/02-entry-currency.md`,
  ]);
  assert.equal(DEFAULT_DELIVERABLES.some((path) => path.endsWith('-')), false);
  // A write to a different `01-…` file is not checkpoint 2.
  const rows = [
    stepStart(1),
    toolUse('write', deliverable('01-some-other-name.md'), 2),
    stepFinish(1000, { timestamp: 3 }),
    stepStart(4),
    toolUse('write', deliverable('01-orientation.md'), 5),
    stepFinish(2000, { timestamp: 6 }),
  ];
  const report = analyze(rows);
  assert.equal(report.checkpoints[1].k, 2);
  assert.equal(report.checkpoints[1].step, 2, 'only the exact deliverable reaches checkpoint 2');
  assert.equal(report.overall.deliverablesCreated, 1);
  assert.equal(report.overall.nonDeliverableWrites, 1);
});

test('a host-basis total that differs from the step sum is a reader mismatch, not auxiliary tokens', () => {
  const report = analyze(mainRows(), {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 8000, billedCompletionTokens: 20, meterBasis: 'host-step-tokens' },
    compaction: { compactionRequests: 2, journalEvents: 0, keyWritten: false,
      titleRequests: 1, toolLessChatRequests: 0 },
  });
  assert.equal(report.overall.totalBilledPrompt, 7800, 'the step total is what the reader sums');
  assert.equal(report.overall.resultBilledPromptTokens, 8000);
  assert.equal(report.overall.stepTotalDifferenceTokens, 200);
  assert.equal(report.overall.resultBilledPromptMatches, false);
  assert.equal(report.overhead, undefined,
    'no token row: a runner-produced host-basis result cannot carry this difference');
  assert.equal(report.overall.hostTitleRequests, 1);
  assert.equal(report.overall.hostToolLessChatRequests, 0);
  assert.equal(report.overall.hostCompactionRequests, 2);
  assert.equal(report.overall.auxiliaryRequestCount, 3);
  assert.match(report.notes.join('\n'), /the two readers disagree/);
  assert.match(report.notes.join('\n'), /not a title\/tool-less\/compaction token reading/);
  assert.doesNotMatch(report.notes.join('\n'), /auxiliary overhead/);
  const text = formatReport(report);
  assert.match(text, /step reconciliation: MISMATCH/);
  assert.match(text, /not auxiliary token overhead/);

  // A negative difference is reported, never clamped to zero.
  const under = analyze(mainRows(), {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 7700, meterBasis: 'host-step-tokens' },
    compaction: { compactionRequests: 0 },
  });
  assert.equal(under.overall.stepTotalDifferenceTokens, -100);
  assert.equal(under.overall.resultBilledPromptMatches, false);
  assert.match(under.notes.join('\n'), /negative.*not clamped to zero/);
});

test('a capture basis reports the capture estimate separately and subtracts nothing', () => {
  const report = analyze(mainRows(), {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 2128493, billedCompletionTokens: 20, meterBasis: 'captured-bodies' },
    compaction: { compactionRequests: 2, journalEvents: 0, keyWritten: false,
      titleRequests: 1, toolLessChatRequests: 0 },
  });

  assert.equal(report.overhead, undefined, 'no overhead row exists to state a capture estimate');
  assert.equal(report.overall.totalBilledPrompt, 7800, 'the step total is the main loop only');
  assert.equal(report.overall.resultBilledPromptTokens, 2128493);
  assert.equal(report.overall.stepTotalDifferenceTokens, null,
    'a capture total is never subtracted from the step sum');
  assert.equal(report.overall.auxiliaryRequestCount, 3);

  assert.equal(report.captureEstimate.meterBasis, 'captured-bodies');
  assert.equal(report.captureEstimate.tokens, 2128493);
  assert.match(report.captureEstimate.label, /not a host meter and not billed spend/);
  assert.match(report.notes.join('\n'), /reported as captureEstimate; it is not subtracted/);
  assert.match(report.notes.join('\n'), /the difference is not overhead/);
  assert.doesNotMatch(report.notes.join('\n'), /auxiliary overhead/);

  const text = formatReport(report);
  assert.doesNotMatch(text, /^overhead:/m);
  assert.doesNotMatch(text, /step reconciliation: MISMATCH/);
  assert.match(text, /captureEstimate: 2128493 prompt token\(s\)/);
});

test('a missing meterBasis is treated as not host-step: no subtraction', () => {
  const report = analyze(mainRows(), {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 8000 },
    compaction: { compactionRequests: 2 },
  });

  assert.equal(report.overhead, undefined, 'no overhead row: an unproven basis is never host step tokens');
  assert.equal(report.overall.stepTotalDifferenceTokens, null);
  assert.equal(report.captureEstimate.meterBasis, null);
  assert.equal(report.captureEstimate.tokens, 8000);
  assert.match(report.captureEstimate.note, /meterBasis is missing/);
  assert.match(report.notes.join('\n'), /result\.spend\.meterBasis is missing, not host-step-tokens/);
  assert.doesNotMatch(report.notes.join('\n'), /auxiliary overhead/);
});

test('shell/bash/execute rows are counted and reported, never read as writes', () => {
  const rows = [
    stepStart(1),
    toolUse('shell', null, 2),
    toolUse('bash', null, 3),
    toolUse('write', deliverable('00-index.md'), 4),
    stepFinish(1000, { timestamp: 5 }),
  ];
  const report = analyze(rows);
  assert.equal(report.overall.shellCalls, 2);
  assert.deepEqual(report.overall.shellTools, ['bash', 'shell']);
  assert.equal(report.overall.writeCalls, 1, 'the shell rows are not writes');
  assert.equal(report.overall.deliverablesCreated, 1);
  assert.match(report.notes.join('\n'),
    /2 shell\/bash\/execute row\(s\) are reported and not read as writes/);
});

test('a missing token field fails loudly instead of billing 0', () => {
  const rows = [
    stepStart(1),
    toolUse('write', deliverable('00-index.md'), 2),
    stepFinish(1000, { timestamp: 3 }),
  ];
  delete rows[2].part.tokens.input;
  assert.throws(
    () => analyze(rows),
    /step 1 tokens\.input is missing.*not billed as 0/,
  );

  const noTokens = mainRows();
  delete noTokens[2].part.tokens;
  assert.throws(
    () => analyze(noTokens),
    /step 1 has no tokens object.*without token fields/,
  );

  const noCache = mainRows();
  delete noCache[5].part.tokens.cache;
  assert.throws(
    () => analyze(noCache),
    /step 2 tokens\.cache is missing/,
  );
});

test('out-of-order writes keep the step timeline, not the list order', () => {
  const rows = [
    stepStart(1),
    toolUse('write', deliverable('02-entry-currency.md'), 2),
    stepFinish(1000, { timestamp: 3 }),
    stepStart(4),
    toolUse('write', deliverable('00-index.md'), 5),
    stepFinish(2000, { timestamp: 6 }),
    stepStart(7),
    toolUse('write', deliverable('01-orientation.md'), 8),
    stepFinish(3000, { timestamp: 9 }),
  ];
  const report = analyze(rows);

  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.k), [1, 2, 3]);
  assert.deepEqual(report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.step), [2, 3, 1]);
  assert.deepEqual(
    report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.runningTotal),
    [3000, 6000, 1000],
  );
  assert.deepEqual(
    report.checkpoints.slice(0, 3).map((checkpoint) => checkpoint.peak),
    [2000, 3000, 1000],
  );
  assert.equal(report.overall.totalBilledPrompt, 6000);
  assert.equal(report.overall.deliverablesCreated, 3);
});

test('a failed write does not create the checkpoint; a later completed write does', () => {
  const failed = toolUse('write', deliverable('00-index.md'), 2);
  failed.part.state.status = 'error';
  const rows = [
    stepStart(1),
    failed,
    stepFinish(1000, { timestamp: 3 }),
    stepStart(4),
    toolUse('write', deliverable('00-index.md'), 5),
    stepFinish(2000, { timestamp: 6 }),
  ];
  const report = analyze(rows);

  assert.equal(report.checkpoints[0].step, 2);
  assert.equal(report.overall.writeCalls, 2);
  assert.equal(report.overall.completedWriteCalls, 1);
  assert.match(report.notes.join('\n'), /1 write\/edit\/create row\(s\) did not complete/);
});

test('no deliverables: zero created, tokens still accounted', () => {
  const rows = [
    stepStart(1),
    toolUse('read', `${WORLD}\\a.txt`, 2),
    stepFinish(500, { cacheRead: 20, timestamp: 3 }),
    stepStart(4),
    toolUse('read', `${WORLD}\\b.txt`, 5),
    stepFinish(700, { cacheRead: 30, timestamp: 6 }),
  ];
  const report = analyze(rows);

  assert.equal(report.checkpoints.length, 13);
  assert.equal(report.checkpoints.every((checkpoint) => checkpoint.created === false), true);
  assert.equal(report.overall.deliverablesCreated, 0);
  assert.equal(report.overall.deliverablesMissing, 13);
  assert.equal(report.overall.writeCalls, 0);
  assert.equal(report.overall.totalBilledPrompt, 1250);
  assert.equal(report.overall.peakFill, 730);
  assert.equal(report.overall.finalFill, 730);
});

test('a newline deliverable file overrides the default list', () => {
  const rows = [
    stepStart(1),
    toolUse('write', `${WORLD}\\work\\a.md`, 2),
    stepFinish(1000, { timestamp: 3 }),
    stepStart(4),
    toolUse('write', `${WORLD}\\work\\02-report.md`, 5),
    stepFinish(2000, { timestamp: 6 }),
  ];
  const report = analyze(rows, null, {
    deliverablesText: '# custom list\n\nwork/a.md\nwork/02-\n',
    deliverablesSource: '<override>',
  });

  assert.equal(report.checkpoints.length, 2);
  assert.equal(report.checkpoints[0].path, 'work/a.md');
  assert.equal(report.checkpoints[0].step, 1);
  assert.equal(report.checkpoints[1].path, 'work/02-*');
  assert.equal(report.checkpoints[1].spec, 'work/02-');
  assert.equal(report.checkpoints[1].step, 2);
  assert.equal(report.overall.deliverablesCreated, 2);
});

test('a JSON deliverable file overrides the default list and matches absolute paths', () => {
  const rows = [
    stepStart(1),
    toolUse('write', 'C:\\runs\\r2\\reports\\b-draft.md', 2),
    stepFinish(1000, { timestamp: 3 }),
    stepStart(4),
    toolUse('write', 'C:/runs/r2/reports/a.md', 5),
    stepFinish(2000, { timestamp: 6 }),
  ];
  const report = analyze(rows, null, {
    deliverablesText: JSON.stringify([{ path: 'reports/a.md' }, { path: 'reports/b-' }]),
  });

  assert.equal(report.checkpoints.length, 2);
  assert.equal(report.checkpoints[0].step, 2);
  assert.equal(report.checkpoints[0].path, 'reports/a.md');
  assert.equal(report.checkpoints[1].step, 1);
  assert.equal(report.checkpoints[1].path, 'reports/b-*');
  assert.equal(report.checkpoints[1].matchedVia, 'suffix');
});

test('result.json compaction total is stated but not placed on the timeline when stdout has no rows', () => {
  const rows = [
    stepStart(1),
    toolUse('write', deliverable('00-index.md'), 2),
    stepFinish(1000, { timestamp: 3 }),
  ];
  const report = analyze(rows, {
    workspace: { path: WORLD },
    spend: { billedPromptTokens: 1000 },
    compaction: { compactionRequests: 2 },
  });

  assert.equal(report.checkpoints[0].created, true);
  assert.equal(report.checkpoints[0].compactionSoFar, null);
  assert.equal(report.overall.stdoutCompactionEvents, 0);
  assert.equal(report.overall.hostCompactionRequests, 2);
  assert.equal(report.overall.resultBilledPromptMatches, true);
  assert.match(report.notes.join('\n'), /per-checkpoint compaction counts are null/);
});

test('a malformed line fails with its line number', () => {
  const text = `${ndjson([stepStart(1), stepFinish(1000)])}not json\n`;
  assert.throws(
    () => analyzeText({ stdoutText: text, stdoutPath: '<broken>' }),
    /<broken>:3 is not JSON/,
  );
});

test('CLI: --json reports the run and a token-less log exits 1', (t) => {
  const dir = tempDir(t);
  const goodStdout = join(dir, 'stdout.ndjson');
  const goodResult = join(dir, 'result.json');
  writeFileSync(goodStdout, ndjson(mainRows()));
  writeFileSync(goodResult, JSON.stringify(MAIN_RESULT));

  const good = spawnSync(
    process.execPath,
    [TOOL, goodStdout, goodResult, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(good.status, 0, good.stderr);
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.overall.totalBilledPrompt, 7800);
  assert.equal(parsed.checkpoints[0].step, 2);

  const brokenRows = mainRows();
  delete brokenRows[2].part.tokens.input;
  const brokenStdout = join(dir, 'broken.ndjson');
  writeFileSync(brokenStdout, ndjson(brokenRows));
  const broken = spawnSync(process.execPath, [TOOL, brokenStdout], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /tokens\.input is missing/);
  assert.match(broken.stderr, /not billed as 0/);
});
