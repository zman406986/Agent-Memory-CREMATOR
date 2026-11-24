#!/usr/bin/env node
/**
 * Tests for `segment-audit.mjs` (ISSUE-289 segmented campaign).
 *
 * Two lanes:
 *   - synthetic evidence on disk: the loop detector (>=3 identical calls in a
 *     row), the item-span detector, and the 3x-median stuck rule;
 *   - the REAL 2026-11-16 run-05 evidence (read-only): the digest the operator
 *     will run after a live segment must come out with GATES GREEN, spend rows,
 *     pacing rows and the product journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditEvidence, findLoops, loadDeliverables } from './segment-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'segment-audit.mjs');
const REAL = join(HERE, '..', '..', 'scratchpad', 'launch', '2026-11-16-uncapped-campaign',
  'run-05-racoons-swe-rebench', 'evidence');

const ndjson = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const call = (seq, time, tool, args) => ({
  type: 'tool/call', seq, time, data: { turn: 1, step: seq, callId: `call_${String(seq)}`, name: tool, arguments: args },
});

function syntheticEvidence() {
  const dir = mkdtempSync(join(tmpdir(), 'segment-audit-'));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({
    schema: 'racoons-bench-run/1',
    arm: { name: 'racoons' },
    citableAs: 'measurement (synthetic)',
    passed: true,
    watchdog: {
      tokenGrant: 100000000, tokenFired: false, fired: false, timeoutMs: 1000,
      mainPromptTokens: 10, mainOutputTokens: 2, askInputTokens: 0, askOutputTokens: 0,
      trueTotalTokens: 12,
    },
    usage: {
      usageRows: 2, assistantTurns: 2, coverage: { reconciled: true },
      inputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 0,
      billedPromptTokens: 10, outputTokens: 2,
    },
    context: { peak: 9, peakRequest: 1 },
    compaction: { count: 0, atRequests: [], atSeqs: [] },
    hostPruner: { state: 'disabled' },
    readBoundary: { violations: [] },
    checkpoints: {
      expected: 3, created: 3,
      paths: ['swe-results/a.md', 'swe-results/b.md', 'swe-results/c.md'],
    },
    removals: { applied: 4 },
  }, null, 2));
  const calls = [
    call(1, 1000, 'read', '{"file_path":"swe/a/x.py"}'),
    call(2, 2000, 'write', '{"file_path":"swe-results/a.md","content":"# a"}'),
    call(3, 3000, 'pwsh', '{"command":"cd swe/b"}'),
    call(4, 3500, 'pwsh', '{"command":"pytest swe/b"}'),
    call(5, 4000, 'read', '{"file_path":"swe/c/x.py"}'),
    call(6, 14000, 'pwsh', '{"command":"pytest swe/c"}'),
    call(7, 15000, 'pwsh', '{"command":"pytest same"}'),
    call(8, 15500, 'pwsh', '{"command":"pytest same"}'),
    call(9, 16000, 'pwsh', '{"command":"pytest same"}'),
  ];
  const sessionDir = join(dir, 'sessions', 'project', 'session-synthetic');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.v4.jsonl'), ndjson(calls));
  writeFileSync(join(dir, 'stdout.ndjson'), ndjson(calls.map((row) => ({
    type: 'tool_call', callId: row.data.callId, tool: row.data.name,
    input: JSON.parse(row.data.arguments),
  }))));
  mkdirSync(join(dir, 'racoons'), { recursive: true });
  writeFileSync(join(dir, 'racoons', 'cremator-events.jsonl'), ndjson([
    { kind: 'prune-apply', removals: 4, status: 'applied' },
    { kind: 'publish', archives: [], appendRecords: [] },
    { kind: 'telemetry' },
  ]));
  mkdirSync(join(dir, 'swe-score'), { recursive: true });
  writeFileSync(join(dir, 'swe-score', 'swe-score.json'), JSON.stringify({
    summary: { tasks: 1, passed: 1, failed: 0, tampered: 0, errored: 0 },
    results: [{ instance_id: 'synthetic__task-1', verdict: 'pass', seconds: 0.1 }],
  }));
  return dir;
}

test('loop detector: 3 identical calls in a row are one candidate, 2 are not', () => {
  const identical = { tool: 'read', args: '{"file_path":"same.txt"}', seq: 1, time: 1 };
  const different = { tool: 'read', args: '{"file_path":"other.txt"}', seq: 9, time: 9 };
  assert.equal(findLoops([identical, identical]).length, 0);
  const runs = findLoops([identical, { ...identical, seq: 2 }, { ...identical, seq: 3 }]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].count, 3);
  assert.equal(findLoops([identical, identical, different, identical]).length, 0);
});

test('deliverables parser: array, object with deliverables, newline file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'segment-audit-list-'));
  try {
    writeFileSync(join(dir, 'array.json'), JSON.stringify(['swe-results/a.md']));
    writeFileSync(join(dir, 'object.json'), JSON.stringify({ deliverables: ['swe-results/b.md'] }));
    writeFileSync(join(dir, 'lines.txt'), 'swe-results/c.md\n\nswe-results/d.md\n');
    assert.deepEqual(loadDeliverables(join(dir, 'array.json')), ['swe-results/a.md']);
    assert.deepEqual(loadDeliverables(join(dir, 'object.json')), ['swe-results/b.md']);
    assert.deepEqual(loadDeliverables(join(dir, 'lines.txt')), ['swe-results/c.md', 'swe-results/d.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic evidence: item spans, 3x-median stuck item, loop candidate', () => {
  const dir = syntheticEvidence();
  try {
    const digest = auditEvidence(dir, ['swe-results/a.md', 'swe-results/b.md', 'swe-results/c.md']);
    assert.equal(digest.gates.verdict, 'GREEN');
    const byName = Object.fromEntries(digest.pacing.items.map((item) => [item.name, item]));
    assert.equal(byName.a.wallMs, 1000);
    assert.equal(byName.b.wallMs, 500);
    assert.equal(byName.c.wallMs, 10000);
    assert.equal(digest.pacing.stats.medianMs, 1000);
    assert.equal(digest.pacing.stats.maxMs, 10000);
    assert.equal(digest.pacing.stats.p95Ms, 10000);
    assert.deepEqual(digest.pacing.stuck.map((row) => row.path), ['swe-results/c.md']);
    assert.equal(digest.pacing.loops.length, 1);
    assert.equal(digest.pacing.loops[0].count, 3);
    assert.equal(digest.spend.trueTotalTokens, 12);
    assert.equal(digest.journal.appliedRemovals, 4);
    assert.equal(digest.journal.recallPublishes, 1);
    assert.equal(digest.journal.capArchives, 0);
    assert.equal(digest.scoring.tasks[0].verdict, 'pass');
    assert.equal(digest.pacing.derivable.itemWall, true);
    assert.equal(digest.pacing.derivable.loops, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real run-05 evidence: GATES GREEN, spend, pacing and journal rows', {
  skip: !existsSync(REAL),
}, () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--evidence', REAL, '--json'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const digest = JSON.parse(run.stdout);
  assert.equal(digest.gates.verdict, 'GREEN', JSON.stringify(digest.gates.failed));
  assert.equal(digest.spend.trueTotalTokens, 4126217);
  assert.equal(digest.spend.billedPromptTokens, 3817324);
  assert.equal(digest.spend.billedCompletionTokens, 34912);
  assert.equal(digest.spend.peakContext, 61335);
  assert.equal(digest.journal.present, true);
  assert.equal(digest.journal.capArchives, 0);
  assert.equal(digest.pacing.items.length, 5);
  assert.ok(digest.pacing.stats.derived >= 4);
  assert.equal(digest.pacing.derivable.itemWall, true);
  assert.equal(digest.pacing.loops.length, 0);
  assert.equal(digest.scoring.present, true);
  assert.equal(digest.scoring.summary.tasks, 4);

  const outFile = join(tmpdir(), `segment-audit-out-${String(process.pid)}.json`);
  const withOut = spawnSync(process.execPath, [SCRIPT, '--evidence', REAL, '--out', outFile], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(withOut.status, 0, withOut.stderr);
  assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).gates.verdict, 'GREEN');
  rmSync(outFile, { force: true });
});
