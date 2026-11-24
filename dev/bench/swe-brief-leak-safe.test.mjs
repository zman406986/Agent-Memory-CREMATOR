#!/usr/bin/env node
/**
 * `swe-brief-leak-safe.mjs` on synthetic entries only: the fenced seg1 brief
 * and the raw `--task-file` followup files, checked against the REAL launcher
 * readers — `deliverablesFromBrief` (dev/bench/dsh-checkpoints.mjs) and
 * `taskSha256` (dev/bench/manifest-gate.mjs) — plus the leak rules: exactly
 * one fence, no P2P id list, no test_patch, and no arm/token/clock/window
 * name outside the fence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyQuarantine, buildFollowupTaskFile, buildSegmentBrief, carriesFence, fenceSafe,
  normalizeQuarantine, protocolBlock, quarantineNote, segmentDeliverables, taskBlock,
} from './swe-brief-leak-safe.mjs';
import { deliverablesFromBrief } from './dsh-checkpoints.mjs';
import { taskSha256 } from './manifest-gate.mjs';

const P2P_IDS = [
  'tests/test_a.py::test_one',
  'tests/test_a.py::test_two',
  'tests/test_b.py::TestC::test_three',
];

function entry(overrides = {}) {
  return {
    instance_id: 'synthetic__repo-1',
    order: 1,
    repo: 'synthetic/repo',
    repoPath: 'swe/synthetic__repo-1',
    problemStatement: 'the bug is in the lexer\nsee the trace below\n',
    issueTextSourceSha256: 'e'.repeat(64),
    f2p: ['tests/test_lexer.py::test_new_case'],
    pytestTargets: ['tests/test_lexer.py::test_new_case'],
    truncatedF2P: 0,
    p2pCount: 3,
    venvPython: 'C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/synthetic__repo-1/venv/Scripts/python.exe',
    pythonPath: '.',
    ...overrides,
  };
}

function readBriefBlock(brief) {
  const at = brief.search(/^## Task text[ \t]*$/mu);
  assert.ok(at >= 0, 'the brief must carry a "## Task text" heading');
  const fence = brief.slice(at).match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/u);
  assert.ok(fence !== null, 'the heading must be followed by one fenced block');
  return { task: fence[1].trim(), outsideBefore: brief.slice(0, at), outsideAfter: brief.slice(at + fence[0].length) };
}

test('combined fenced brief: exactly one fence, BENCH-DONE last in the block', () => {
  const entries = [entry(), entry({ instance_id: 'synthetic__repo-2', order: 2, repoPath: 'swe/synthetic__repo-2' })];
  const { brief, body } = buildSegmentBrief(entries, { first: true, last: true, start: 1, end: 2, total: 2 });
  assert.equal(carriesFence(body), false);
  assert.equal((brief.match(/^```/gmu) ?? []).length, 2, 'exactly one ```text ... ``` pair in the file');
  const { task } = readBriefBlock(brief);
  assert.equal(task.split('\n').at(-1), 'BENCH-DONE');
  assert.ok(task.startsWith('You are a senior engineer working offline in this workspace.'));
  assert.ok(task.includes('Task 1 of 2 - synthetic__repo-1'));
  assert.ok(task.includes('Task 2 of 2 - synthetic__repo-2'));
});

test('the launcher derives exactly N reports + summary from the combined brief', () => {
  const entries = [entry(), entry({ instance_id: 'synthetic__repo-2', order: 2, repoPath: 'swe/synthetic__repo-2' })];
  const { brief } = buildSegmentBrief(entries, { first: true, last: true, start: 1, end: 2, total: 2 });
  const { task } = readBriefBlock(brief);
  assert.deepEqual(deliverablesFromBrief(task, brief), [
    'swe-results/synthetic__repo-1.md',
    'swe-results/synthetic__repo-2.md',
    'swe-results/summary.md',
  ]);
  assert.equal(taskSha256(task).length, 64);
});

test('the fenced brief never carries P2P ids, test patches or gold text', () => {
  const entries = [entry({
    problemStatement: 'real problem text\n',
    f2p: ['tests/test_lexer.py::test_new_case'],
  })];
  const { brief } = buildSegmentBrief(entries, { first: true, last: true, start: 1, end: 1, total: 110 });
  for (const id of P2P_IDS) assert.equal(brief.includes(id), false, `a P2P id leaked: ${id}`);
  assert.ok(brief.includes('P2P tests: 3 named in the pack (do not chase them; do not weaken them)'));
  assert.ok(brief.includes('FAIL_TO_PASS test ids that must pass after your fix: tests/test_lexer.py::test_new_case'));
  assert.equal(brief.includes('diff --git'), false, 'no patch text in a brief');
  assert.equal(brief.includes('GOLD-MARKER'), false);
});

test('problem_statement fences are re-indented so the block stays one fence', () => {
  const entries = [entry({ problemStatement: 'text\n```python\ncode()\n```\nmore\n' })];
  const { brief } = buildSegmentBrief(entries, { first: true, last: true, start: 1, end: 1, total: 1 });
  const { task } = readBriefBlock(brief);
  assert.equal(carriesFence(task), false, 'no re-indented line may open or close a fence');
  assert.ok(task.includes('    ```python'));
  assert.ok(task.includes('    ```'));
  assert.ok(task.includes('\ncode()\n'), 'content between the old fences stays verbatim');
});

test('nothing outside the seg1 fence names an arm, grant, clock, window or repo', () => {
  const entries = [entry()];
  const { brief } = buildSegmentBrief(entries, { first: true, last: true, start: 1, end: 1, total: 110 });
  const at = brief.search(/^## Task text[ \t]*$/mu);
  const fence = brief.slice(at).match(/```[a-z]*\r?\n[\s\S]*?\r?\n```/u);
  const outside = brief.slice(0, at) + brief.slice(at + fence[0].length);
  assert.equal(/racoons|vanilla|token|grant|clock|window|checkpoint/iu.test(outside), false, outside);
});

test('seg1-style fenced brief: not last, no summary instruction, only its reports', () => {
  const entries = [entry(), entry({ instance_id: 'synthetic__repo-2', order: 2, repoPath: 'swe/synthetic__repo-2' })];
  const { brief } = buildSegmentBrief(entries, { first: true, last: false, start: 1, end: 2, total: 110 });
  const { task } = readBriefBlock(brief);
  assert.equal(task.split('\n').at(-1), 'BENCH-DONE');
  assert.equal(task.includes('swe-results/summary.md'), false, 'only the last segment writes the summary');
  assert.deepEqual(deliverablesFromBrief(task, brief),
    ['swe-results/synthetic__repo-1.md', 'swe-results/synthetic__repo-2.md']);
  assert.ok(task.includes('Task 1 of 110 - synthetic__repo-1'), 'numbering is global (N is the full total)');
});

test('followup task file: raw, no fence, ends with the explicit deliverable list', () => {
  const entries = [
    entry({ order: 21, repoPath: 'swe/synthetic__repo-1' }),
    entry({ order: 22, instance_id: 'synthetic__repo-2', repoPath: 'swe/synthetic__repo-2' }),
  ];
  const { text } = buildFollowupTaskFile(entries, {
    segmentNumber: 2, segmentCount: 6, last: false, start: 21, end: 22, total: 110,
  });
  assert.equal(carriesFence(text), false, 'a --task-file carries no fenced block');
  assert.equal(text.includes('## Task text'), false);
  assert.ok(text.includes('Task 21 of 110 - synthetic__repo-1'), 'global numbering in the raw file');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.at(-1), 'swe-results/synthetic__repo-2.md', 'nothing after the list');
  assert.ok(lines.includes('The deliverables are, by exact path:'));
  assert.deepEqual(deliverablesFromBrief(text, text), [
    'swe-results/synthetic__repo-1.md',
    'swe-results/synthetic__repo-2.md',
  ]);
});

test('final followup file adds the summary instruction and closes with 11 paths', () => {
  const entries = [
    entry({ order: 101, repoPath: 'swe/synthetic__repo-1' }),
    entry({ order: 102, instance_id: 'synthetic__repo-2', repoPath: 'swe/synthetic__repo-2' }),
  ];
  const { text } = buildFollowupTaskFile(entries, {
    segmentNumber: 6, segmentCount: 6, last: true, start: 101, end: 102, total: 110,
  });
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.at(-1), 'swe-results/summary.md');
  assert.ok(text.includes('Then write swe-results/summary.md: all 110 tasks'));
  const listAt = lines.indexOf('The deliverables are, by exact path:');
  assert.equal(lines.length - listAt - 1, 3, 'two reports + summary, nothing after');
  assert.ok(lines.indexOf('BENCH-DONE') < listAt, 'the BENCH-DONE instruction sits before the list');
  assert.deepEqual(deliverablesFromBrief(text, text), [
    'swe-results/synthetic__repo-1.md',
    'swe-results/synthetic__repo-2.md',
    'swe-results/summary.md',
  ]);
});

test('taskBlock: both shell forms name the F2P ids and the venv interpreter', () => {
  const block = taskBlock(entry({ pytestTargets: ['tests/test_lexer.py::test_new_case'] }), 110);
  assert.ok(block.includes('Task 1 of 110 - synthetic__repo-1'));
  assert.ok(block.includes('Repo path: swe/synthetic__repo-1/'));
  const bash = block.split('\n').find((line) => line.includes('cd swe/synthetic__repo-1 && PYTHONPATH=.'));
  const ps = block.split('\n').find((line) => line.includes('Set-Location swe/synthetic__repo-1'));
  assert.ok(bash && bash.includes('-m pytest tests/test_lexer.py::test_new_case -q --no-header -p no:cacheprovider'));
  assert.ok(ps && ps.includes('& "C:/Users/TZhen/Desktop/racoons-bench/_swe-venvs/synthetic__repo-1/venv/Scripts/python.exe"'));
  assert.ok(block.includes('Write the one report for this task, swe-results/synthetic__repo-1.md'));
});

test('taskBlock: a src/ layout names PYTHONPATH=src in both shells', () => {
  const block = taskBlock(entry({ pythonPath: 'src' }), 110);
  assert.ok(block.includes('cd swe/synthetic__repo-1 && PYTHONPATH=src "'));
  assert.ok(block.includes("$env:PYTHONPATH='src'"));
});

test('segmentDeliverables: reports plus the summary on the last segment only', () => {
  const entries = [entry()];
  assert.deepEqual(segmentDeliverables(entries, false), ['swe-results/synthetic__repo-1.md']);
  assert.deepEqual(segmentDeliverables(entries, true),
    ['swe-results/synthetic__repo-1.md', 'swe-results/summary.md']);
});

test('fenceSafe matches the staging step\'s rewrite', () => {
  assert.equal(fenceSafe('a\n```\nb'), 'a\n    ```\nb');
  assert.equal(carriesFence(fenceSafe('x\n  ```y')), false);
});

test('the PROTOCOL block sits at the top of the seg1 fence, before Task 1', () => {
  const entries = [entry(), entry({ instance_id: 'synthetic__repo-2', order: 2, repoPath: 'swe/synthetic__repo-2' })];
  const { brief } = buildSegmentBrief(entries, { first: true, last: false, start: 1, end: 2, total: 110 });
  const { task } = readBriefBlock(brief);
  const protocolAt = task.indexOf('PROTOCOL for every task below:');
  const firstTaskAt = task.indexOf('Task 1 of 110 - synthetic__repo-1');
  assert.ok(protocolAt >= 0, 'the protocol is in the fence');
  assert.ok(firstTaskAt > protocolAt, 'the protocol precedes Task 1');
  for (const binding of [
    'Work strictly in the order given',
    'One task at a time',
    'a task is complete only when its report file',
    'swe-results/<instance_id>.md EXISTS',
    'status BLOCKED',
    'Never leave a task without its report',
    'run that',
  ]) {
    assert.ok(task.includes(binding), `missing binding element: ${binding}`);
  }
  assert.equal(task.includes('swe-results/summary.md'), false, 'non-last files keep the summary out');
  assert.ok(task.includes('The final part of this session writes the summary report and ends with BENCH-DONE'),
    'the non-last finish clause points at the session end');
  // The protocol must not disturb the deliverable derivation.
  assert.deepEqual(deliverablesFromBrief(task, brief),
    ['swe-results/synthetic__repo-1.md', 'swe-results/synthetic__repo-2.md']);
});

test('the PROTOCOL block opens every raw seg2-6 task file before the first task', () => {
  const entries = [
    entry({ order: 21, repoPath: 'swe/synthetic__repo-1' }),
    entry({ order: 22, instance_id: 'synthetic__repo-2', repoPath: 'swe/synthetic__repo-2' }),
  ];
  const { text } = buildFollowupTaskFile(entries, {
    segmentNumber: 2, segmentCount: 6, last: false, start: 21, end: 22, total: 110,
  });
  const protocolAt = text.indexOf('PROTOCOL for every task below:');
  const firstTaskAt = text.indexOf('Task 21 of 110 - synthetic__repo-1');
  assert.ok(protocolAt >= 0, 'the protocol is in the raw task file');
  assert.ok(firstTaskAt > protocolAt, 'the protocol precedes the first task');
  assert.ok(text.includes('Never leave a task without its report'));
  assert.equal(text.includes('write swe-results/summary.md'), false, 'non-last raw files keep the summary out');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.at(-1), 'swe-results/synthetic__repo-2.md', 'the file still ends with the deliverables list');
  assert.deepEqual(deliverablesFromBrief(text, text), [
    'swe-results/synthetic__repo-1.md',
    'swe-results/synthetic__repo-2.md',
  ]);
});

test('the last segment\'s protocol names the summary and BENCH-DONE', () => {
  const entries = [entry({ order: 101, repoPath: 'swe/synthetic__repo-1' })];
  const { text } = buildFollowupTaskFile(entries, {
    segmentNumber: 6, segmentCount: 6, last: true, start: 101, end: 101, total: 110,
  });
  assert.ok(text.includes('After the last task, write swe-results/summary.md and end your final message with BENCH-DONE'));
  const protocol = protocolBlock(true);
  assert.match(protocol, /write swe-results\/summary\.md and end your final message with BENCH-DONE\.$/mu);
  assert.doesNotMatch(protocolBlock(false), /write swe-results\/summary\.md/u);
});

test('normalizeQuarantine reads the bare array and the preflight.json shape', () => {
  assert.deepEqual(normalizeQuarantine(['a-1', 'b-2']), ['a-1', 'b-2']);
  assert.deepEqual(normalizeQuarantine({ summary: {}, tasks: [], quarantine: ['a-1', 'b-2'] }), ['a-1', 'b-2']);
  assert.deepEqual(normalizeQuarantine([{ instance_id: 'a-1' }, 'b-2', { instance_id: 'a-1' }]), ['a-1', 'b-2']);
  assert.throws(() => normalizeQuarantine({ tasks: [] }), /neither an id array nor a preflight\.json shape/u);
});

test('applyQuarantine drops named tasks and renumbers globally', () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ instance_id: `repo-${String(n)}`, order: n }));
  const { remaining, dropped, excludedCount } = applyQuarantine(entries, ['repo-2', 'repo-4', 'not-in-pack']);
  assert.equal(excludedCount, 2, 'an id absent from the pack is ignored');
  assert.deepEqual(dropped.map((entry) => entry.instance_id), ['repo-2', 'repo-4']);
  assert.deepEqual(remaining.map((entry) => entry.instance_id), ['repo-1', 'repo-3', 'repo-5']);
  assert.deepEqual(remaining.map((entry) => entry.order), [1, 2, 3], 'renumbered 1..M over the remainder');
});

test('quarantineNote: one line with the counts; null when nothing was excluded', () => {
  const note = quarantineNote(2, 3);
  assert.match(note, /^<!-- leak-safe quarantine: 2 task\(s\) excluded from the pack before slicing; task numbering renumbered over the remaining 3 -->$/u);
  assert.equal(quarantineNote(0, 3), null);
});

test('the quarantine comment sits OUTSIDE the fence in seg1 and never in the block', () => {
  const entries = [entry(), entry({ instance_id: 'synthetic__repo-2', order: 2, repoPath: 'swe/synthetic__repo-2' })];
  const note = quarantineNote(1, 2);
  const { brief, body } = buildSegmentBrief(entries, {
    first: true, last: true, start: 1, end: 2, total: 2, quarantineNote: note,
  });
  assert.equal(body.includes('leak-safe quarantine'), false, 'never inside the task fence');
  assert.equal(brief.split(note).length - 1, 1, 'exactly once in the file');
  const fenceAt = brief.search(/^## Task text[ \t]*$/mu);
  assert.ok(brief.indexOf(note) < fenceAt, 'the comment sits before the fence heading');
});

test('the quarantine comment is one line at the top of a raw followup file', () => {
  const entries = [
    entry({ order: 21, repoPath: 'swe/synthetic__repo-1' }),
    entry({ order: 22, instance_id: 'synthetic__repo-2', repoPath: 'swe/synthetic__repo-2' }),
  ];
  const note = quarantineNote(3, 108);
  const { text } = buildFollowupTaskFile(entries, {
    segmentNumber: 2, segmentCount: 6, last: false, start: 21, end: 22, total: 108, quarantineNote: note,
  });
  const lines = text.split('\n');
  assert.equal(lines[1], note, 'the comment is the second line, one line, no prose around it');
  assert.equal(text.split(note).length - 1, 1);
  const listAt = lines.indexOf('The deliverables are, by exact path:');
  assert.ok(lines.indexOf(note) < listAt);
  assert.deepEqual(deliverablesFromBrief(text, text), [
    'swe-results/synthetic__repo-1.md',
    'swe-results/synthetic__repo-2.md',
  ], 'the comment does not disturb the deliverable derivation');
});

test('quarantined slicing end to end: 5 tasks, 2 excluded, 20/20/20/20/20/rest split holds', () => {
  const entries = Array.from({ length: 5 }, (_, n) => entry({
    instance_id: `repo-${String(n + 1)}`,
    order: n + 1,
    repoPath: `swe/repo-${String(n + 1)}`,
  }));
  const { remaining } = applyQuarantine(entries, ['repo-4', 'repo-5']);
  assert.equal(remaining.length, 3);
  const { brief } = buildSegmentBrief(remaining, {
    first: true, last: true, start: 1, end: 3, total: 3, quarantineNote: quarantineNote(2, 3),
  });
  assert.ok(brief.includes('Task 1 of 3 - repo-1'), 'N is the remaining count');
  assert.ok(brief.includes('Task 3 of 3 - repo-3'));
  assert.equal(brief.includes('repo-4') || brief.includes('repo-5'), false, 'excluded ids appear nowhere');
  const { task } = readBriefBlock(brief);
  assert.deepEqual(deliverablesFromBrief(task, brief), [
    'swe-results/repo-1.md', 'swe-results/repo-2.md', 'swe-results/repo-3.md', 'swe-results/summary.md',
  ]);
});
