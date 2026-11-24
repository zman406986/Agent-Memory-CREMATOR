#!/usr/bin/env node
/**
 * Chunk 10's gate: determinism (design §7 chunk 10, §8).
 *
 * The design's broken state: "Snapshot, not the live store — two runs read
 * different stores and a moving count passes as stability; detected by chunk 10."
 * The verify clause is exact: *same digest, same seed, two directories;
 * `summary.json` sha256 equal; the second run reused no cache. A difference is a
 * red gate, not noise.*
 *
 * So this file checks three things, and each one has a way to go red:
 *
 *   1. **Byte equality.** Two `score.mjs` invocations over one record, into two
 *      fresh directories, write byte-identical `summary.json`. Broken state: any
 *      iteration order, timestamp or set-iteration leak into the summary.
 *   2. **The comparison is not vacuous.** The same two runs over a record whose
 *      input token differs write DIFFERENT summaries. Without this, a comparison
 *      of two empty strings would pass.
 *   3. **No cache was reused.** A stale, different `summary.json` placed in the
 *      second directory is overwritten. Broken state: a run that returns a stored
 *      summary instead of re-deriving one.
 *
 * The tolerance path is covered too (design §7 chunk 10 binds `tolerance.mjs`'s
 * output as well as `score.mjs`'s): two invocations over the same calibrations
 * print byte-identical text, and a recalibration of one session does move it.
 *
 * `SUMMARY.md` is NOT byte-compared across different output directories: it
 * prints the output path by design, so it differs in exactly that line. That is
 * asserted rather than assumed — a difference anywhere else fails the gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCORE = new URL('./score.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TOLERANCE = new URL('./tolerance.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REPO_ROOT = resolve(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..', '..',
);

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

function textNode(id, bytes = 50) {
  return {
    id, kind: 'text', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool: null, callId: null, status: null, filePath: null,
  };
}

function toolNode(id, bytes, filePath) {
  return {
    id, kind: 'tool', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool: 'Read', callId: `call_${id}`, status: 'completed', filePath,
  };
}

/**
 * A four-turn record with one observed fill. `bump` perturbs ONE request's input
 * token, which is the record's input and nothing else — so a comparison of two
 * runs that both used it must differ, while a comparison of two runs that used
 * the unperturbed record must not.
 */
function writeRecord(root, { name = 'rec', bump = 0 } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const depths = [
    [10000, 20000, 30000],
    [40000, 50000, 60000],
    [70000, 80000, 20000],
    [23000, 24000, 25000],
  ];
  let at = 1000;
  const plan = depths.map((row, ordinal) => {
    const requests = row.map((depth, index) => {
      at += 10;
      const inputTokens = ordinal === 3 && index === 2 ? depth + bump : depth;
      return {
        id: `r${ordinal}_${index}`, logicalRequestId: `r${ordinal}_${index}`,
        querySource: 'main_turn', modelId: 'deepseek-v4.1-flash', status: 'completed',
        startedAt: at, inputTokens, cacheReadInputTokens: Math.round(depth * 0.9),
        depth: inputTokens,
      };
    });
    const written = toolNode(`w${ordinal}`, 9000, `src/file-${ordinal}.ts`);
    const nodes = [textNode(`m${ordinal}`), written];
    return {
      turnOrdinal: ordinal,
      turnId: `turn_${ordinal}`,
      status: 'completed',
      inFlight: false,
      startedAt: requests[0].startedAt,
      completedAt: requests[requests.length - 1].startedAt + 5,
      promptMessageId: null,
      promptOrigin: 'real_user',
      promptVisibility: 'visible',
      nodes,
      nodeCount: nodes.length,
      nodeBytes: nodes.reduce((total, node) => total + node.bytes, 0),
      requests,
      requestCount: requests.length,
      declaredModelRequestCount: requests.length,
      declaredInputTokens: requests.reduce((total, request) => total + request.depth, 0),
      declaredCacheReadInputTokens: 0,
      declaredToolCallCount: 1,
      fills: ordinal === 1
        ? [{
          boundaryId: 'compact_8', preCompactTokenCount: 80000, truePostCompactTokenCount: 20000,
          autoCompactThreshold: 80000, auto: true, timelineStatus: 'completed',
          completedAt: requests[1].startedAt + 1,
        }]
        : [],
      progress: { writesTotal: ordinal + 1, writesThisTurn: 1 },
    };
  });
  writeFileSync(join(dir, 'turns.jsonl'), `${plan.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({
    schema: 'racoons-multiturn-record/1',
    snapshot: { digest: 'b'.repeat(64) },
    session: { id: 'sess_fixture' },
    selected: { turns: plan.length, prompts: plan.length },
    pinned: {
      threshold: 80000, thresholdSource: 'observed-fill', W: 100000,
      branch: 'fixture', byteQuotient: 4, seed: 0, prefixTokens: 100,
    },
  }, null, 2)}\n`);
  return dir;
}

// A store that does not exist keeps P2 out of the comparison without touching the
// record: the run prints `p2=absent` by name and scores P1.
function score(record, out) {
  return run(SCORE, ['--record', record, '--db', join(resolve(record, '..'), 'absent.sqlite'),
    '--out', out]);
}

test('two runs over one record write byte-identical summary.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-determinism-'));
  try {
    const record = writeRecord(root);
    const first = join(root, 'run-a');
    const second = join(root, 'run-b');
    const a = score(record, first);
    assert.equal(a.status, 0, a.stderr);
    const b = score(record, second);
    assert.equal(b.status, 0, b.stderr);
    const left = readFileSync(join(first, 'summary.json'), 'utf8');
    const right = readFileSync(join(second, 'summary.json'), 'utf8');
    assert.equal(sha256(right), sha256(left),
      'summary.json differs between two runs over the same record: the pipeline is nondeterministic');
    // Same digest and same seed is the design's precondition, and it is readable.
    const summary = JSON.parse(left);
    assert.equal(summary.sessions[0].digest, 'b'.repeat(64));
    // SUMMARY.md differs only in the printed output path — checked, not assumed.
    const mdA = readFileSync(join(first, 'SUMMARY.md'), 'utf8').split('\n');
    const mdB = readFileSync(join(second, 'SUMMARY.md'), 'utf8').split('\n');
    assert.equal(mdA.length, mdB.length, 'SUMMARY.md changed shape between runs');
    const differing = mdA.map((line, i) => (line === mdB[i] ? null : i)).filter(i => i !== null);
    assert.equal(differing.length, 1, 'SUMMARY.md differs in more than the printed output path');
    assert.match(mdA[differing[0]], /^\s+summary\s+.*summary\.json$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the comparison is not vacuous: a perturbed record writes a different summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-determinism-nonvac-'));
  try {
    const plain = writeRecord(root, { name: 'plain' });
    const perturbed = writeRecord(root, { name: 'perturbed', bump: 1 });
    const first = join(root, 'out-plain');
    const second = join(root, 'out-perturbed');
    assert.equal(score(plain, first).status, 0);
    assert.equal(score(perturbed, second).status, 0);
    const left = readFileSync(join(first, 'summary.json'), 'utf8');
    const right = readFileSync(join(second, 'summary.json'), 'utf8');
    assert.notEqual(sha256(right), sha256(left),
      'one changed input token left summary.json identical: the equality above compares nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the second run re-derives: a stale summary.json in its directory is overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-determinism-cache-'));
  try {
    // The two directories spell the same record two ways, so a run that cached by
    // content would be free to reuse the first run's file. It must not: the
    // output directory is the run, and it is rewritten every time.
    const record = writeRecord(root);
    const first = join(root, 'run-a');
    const second = join(root, 'run-b');
    assert.equal(score(record, first).status, 0);
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'summary.json'),
      `${JSON.stringify({ schema: 'racoons-multiturn-score/1', stale: true })}\n`);
    assert.equal(score(record, second).status, 0);
    const fresh = readFileSync(join(second, 'summary.json'), 'utf8');
    assert.doesNotMatch(fresh, /"stale": true/, 'the run reused a stored summary instead of deriving one');
    assert.equal(sha256(fresh), sha256(readFileSync(join(first, 'summary.json'), 'utf8')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the tolerance path prints identical text twice, and moves when a calibration moves', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-determinism-tolerance-'));
  try {
    const calibration = residuals => {
      const path = join(root, `cal-${residuals.join('-').replace(/\./g, '_').slice(0, 40)}.json`);
      writeFileSync(path, `${JSON.stringify({
        schema: 'racoons-multiturn-calibration/1',
        residuals: residuals.map((value, i) => ({ requestId: `r${i}`, residual: value })),
      }, null, 2)}\n`);
      return path;
    };
    const stable = calibration([0.1, -0.2, 0.05, 0.3]);
    const first = run(TOLERANCE, ['--from', stable]);
    const second = run(TOLERANCE, ['--from', stable]);
    // The record's own numbers are frozen, so an unknown calibration is a drift
    // (exit 1) — determinism is about the printed text, not about the verdict.
    assert.equal(first.status, second.status);
    assert.equal(sha256(second.stdout), sha256(first.stdout),
      'tolerance.mjs printed different text twice over the same calibration');
    assert.equal(second.stderr, first.stderr);
    // A calibration the frozen record does not hold drifts, and the drift is
    // printed to stderr by name. stdout alone prints the frozen record, so the
    // discriminator is the whole output: a comparison of stdout only would pass
    // for the wrong reason.
    const moved = calibration([0.9, -0.9, 0.8]);
    const third = run(TOLERANCE, ['--from', moved]);
    assert.notEqual(sha256(`${third.stdout}\n${third.stderr}`), sha256(`${first.stdout}\n${first.stderr}`),
      'a different calibration printed the same text: the comparison is vacuous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

