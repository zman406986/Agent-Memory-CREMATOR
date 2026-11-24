#!/usr/bin/env node
/**
 * `swe-preflight.mjs` tests. The retry/quarantine verdict logic runs on
 * synthetic tasks with an injected runner.
 *
 * Run: node --test dev/bench/swe-preflight.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attemptVerdict, classifyIds, main, parseCli, parseCollectedIds, pytestExecutedCount,
  runPreflight, verdictNotes, verdictReasons,
} from './swe-preflight.mjs';
import { parsePytestOutput } from './swe-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Green attempt: every id collected, two F2P failures, all P2P pass. */
function green() {
  return {
    collect: {
      ok: true,
      missingF2p: [],
      missingP2p: [],
      truncatedF2p: [],
      truncatedP2p: [],
    },
    f2pAtBase: { failed: 2, passed: 0, errored: 0 },
    p2pAtBase: { passed: 7, failed: 0, errored: 0 },
    noIds: false,
    error: null,
  };
}

function withF2p(overrides) {
  const attempt = green();
  Object.assign(attempt.f2pAtBase, overrides);
  return attempt;
}

function withP2p(overrides) {
  const attempt = green();
  Object.assign(attempt.p2pAtBase, overrides);
  return attempt;
}

function attempt(overrides) {
  return { ...green(), ...overrides };
}

function makePack(dir, ids) {
  mkdirSync(dir, { recursive: true });
  const tasks = ids.map((id) => ({
    instance_id: id,
    repo: `owner/${id}`,
    base_commit: 'deadbeef',
    test_patch: '',
    f2p: [`tests/test_${id}.py::test_new`],
    p2p: [`tests/test_${id}.py::test_old`],
  }));
  writeFileSync(join(dir, 'task-pack.json'), `${JSON.stringify(tasks, null, 2)}\n`);
  writeFileSync(join(dir, 'snapshot.json'),
    `${JSON.stringify(tasks.map((task) => ({ instance_id: task.instance_id, files: {} })), null, 2)}\n`);
  return dir;
}

function makeOpts(benchRoot, outDir, extra = {}) {
  return {
    benchRoot,
    stagingRoot: join(outDir, 'staging-not-read'),
    venvRoot: join(outDir, 'venvs-not-read'),
    outDir,
    jobs: 2,
    timeoutMs: 5_000,
    ...extra,
  };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'swe-preflight-test-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const result = fn(dir);
    if (result !== null && typeof result?.then === 'function') return result.finally(done);
    done();
    return result;
  } catch (error) {
    done();
    throw error;
  }
}

test('the gate quarantines only for no F2P failure, an F2P pass, or a harness error', () => {
  assert.deepEqual(verdictReasons(green()), []);
  assert.deepEqual(verdictNotes(green()), []);
  assert.equal(attemptVerdict(green()), 'ok');

  assert.deepEqual(verdictReasons(withF2p({ failed: 1, passed: 1 })), ['f2p-pre-passed']);
  assert.equal(attemptVerdict(withF2p({ failed: 0, passed: 0, errored: 3 })), 'quarantined');
  assert.equal(attemptVerdict(withF2p({ failed: 0, passed: 0, errored: 0 })), 'quarantined');

  // At least one F2P failure at base is the desired state; an errored sibling
  // (a notCollected id the scorer drops) does not quarantine.
  const mixed = withF2p({ failed: 1, passed: 0, errored: 2 });
  assert.deepEqual(verdictReasons(mixed), []);
  assert.equal(attemptVerdict(mixed), 'ok');
});

test('unresolved F2P ids are notes when at least one F2P failed at base', () => {
  const missing = green();
  missing.collect.missingF2p = ['tests/a.py::test_gone'];
  assert.deepEqual(verdictReasons(missing), []);
  assert.deepEqual(verdictNotes(missing), ['f2p-id-missing']);
  assert.equal(attemptVerdict(missing), 'ok-with-notes');

  const truncated = green();
  truncated.collect.truncatedF2p = ['tests/a.py::test cut'];
  assert.deepEqual(verdictNotes(truncated), ['f2p-truncated-id']);
  assert.equal(attemptVerdict(truncated), 'ok-with-notes');

  // Every F2P id missing lands at failed === 0: quarantined by the same rule.
  const allMissing = green();
  allMissing.collect.missingF2p = ['tests/a.py::test_gone', 'tests/a.py::test cut'];
  allMissing.f2pAtBase = { failed: 0, passed: 0, errored: 0 };
  assert.equal(attemptVerdict(allMissing), 'quarantined');
});

test('P2P outcomes are notes, never quarantine', () => {
  assert.deepEqual(verdictReasons(withP2p({ passed: 4, failed: 1, errored: 0 })), []);
  assert.deepEqual(verdictNotes(withP2p({ passed: 4, failed: 1, errored: 0 })), ['p2p-fails-at-base']);
  assert.equal(attemptVerdict(withP2p({ passed: 4, failed: 1, errored: 0 })), 'ok-with-notes');

  assert.deepEqual(verdictNotes(withP2p({ passed: 4, failed: 0, errored: 2 })), ['p2p-errors-at-base']);
  const p2pBroken = withP2p({ passed: 0, failed: 3, errored: 4 });
  p2pBroken.collect.missingP2p = ['tests/a.py::test_gone'];
  p2pBroken.collect.truncatedP2p = ['tests/a.py::test cut'];
  assert.deepEqual(verdictReasons(p2pBroken), []);
  assert.deepEqual(verdictNotes(p2pBroken),
    ['p2p-id-missing', 'p2p-truncated-id', 'p2p-fails-at-base', 'p2p-errors-at-base']);
  assert.equal(attemptVerdict(p2pBroken), 'ok-with-notes');
});

test('a no-id task and a harness failure quarantine', () => {
  const noIds = attempt({ noIds: true, f2pAtBase: { failed: 0, passed: 0, errored: 0 } });
  assert.deepEqual(verdictReasons(noIds), ['no-ids']);
  assert.equal(attemptVerdict(noIds), 'quarantined');

  assert.deepEqual(verdictReasons(attempt({ error: 'git apply failed' })), ['harness-error']);
  assert.equal(attemptVerdict(attempt({ error: 'git apply failed' })), 'quarantined');
  assert.deepEqual(
    verdictReasons(attempt({
      collect: {
        ok: false, missingF2p: [], missingP2p: [], truncatedF2p: [], truncatedP2p: [],
      },
      f2pAtBase: { failed: 1, passed: 0, errored: 0 },
      p2pAtBase: { passed: 0, failed: 0, errored: 0 },
      error: 'venv python missing',
    })),
    ['harness-error'],
  );
});

test('parseCollectedIds reads ids, never the error or summary lines', () => {
  const ids = parseCollectedIds([
    'tests/test_a.py::test_one',
    'tests/test_a.py::test_two[1-2]',
    'ERROR tests/test_b.py',
    'ERROR tests/test_b.py::test_broken',
    '1 error in 0.03s',
    '',
  ].join('\r\n'));
  assert.deepEqual([...ids].sort(), [
    'tests/test_a.py::test_one',
    'tests/test_a.py::test_two[1-2]',
  ]);
});

test('a truncated P2P run executes fewer ids than classifyIds reports passed', () => {
  const ids = [
    'tests/test_a.py::test_one',
    'tests/test_a.py::test_two',
    'tests/test_a.py::test_three',
    'tests/test_a.py::test_four',
    'tests/test_a.py::test_five',
  ];
  // One test ran and passed; the other four never appear in the report at all.
  const truncated = parsePytestOutput('.... [100%]\n1 passed in 0.10s\n');
  const split = classifyIds(ids, truncated, { exit: 0 });
  assert.equal(split.passed.length, 5,
    'classifyIds infers passed from the absence of a failure/error row');
  assert.equal(pytestExecutedCount(truncated), 1,
    'the executed count is the run evidence the passed set is not');
  // The hardened mini-pack assertion compares the executed count with the intact
  // id count; the old passed-only assertion would call this a full run.
  assert.notEqual(pytestExecutedCount(truncated), ids.length);
});

test('only a quarantined task is retried; notes are not retried', () => withTempDir((dir) => {
  const benchRoot = makePack(join(dir, 'bench'),
    ['task-a', 'task-b', 'task-c', 'task-d', 'task-e']);
  const calls = [];
  const runner = async (task, _ctx, attemptNo) => {
    calls.push(`${task.instance_id}#${String(attemptNo)}`);
    if (task.instance_id === 'task-a') return attemptNo === 1 ? withF2p({ failed: 0, passed: 1 }) : green();
    if (task.instance_id === 'task-b') return withF2p({ failed: 0, passed: 1 });
    if (task.instance_id === 'task-d') return withP2p({ passed: 4, failed: 1 });
    if (task.instance_id === 'task-e') {
      const missing = green();
      missing.collect.missingF2p = ['tests/a.py::test_gone'];
      return missing;
    }
    return green();
  };
  return runPreflight(makeOpts(benchRoot, join(dir, 'out'), { jobs: 1 }), { runAttempt: runner }).then((payload) => {
    assert.deepEqual(calls,
      ['task-a#1', 'task-a#2', 'task-b#1', 'task-b#2', 'task-c#1', 'task-d#1', 'task-e#1']);
    const byId = new Map(payload.tasks.map((row) => [row.instance_id, row]));
    assert.equal(byId.get('task-a').verdict, 'ok');
    assert.deepEqual(byId.get('task-a').notes, []);
    assert.equal(byId.get('task-b').verdict, 'quarantined');
    assert.deepEqual(byId.get('task-b').reasons, ['f2p-pre-passed']);
    assert.equal(byId.get('task-c').verdict, 'ok');
    assert.equal(byId.get('task-d').verdict, 'ok-with-notes');
    assert.deepEqual(byId.get('task-d').notes, ['p2p-fails-at-base']);
    assert.equal(byId.get('task-e').verdict, 'ok-with-notes');
    assert.deepEqual(byId.get('task-e').notes, ['f2p-id-missing']);
    assert.equal(payload.summary.tasks, 5);
    assert.equal(payload.summary.ok, 2);
    assert.equal(payload.summary.okWithNotes, 2);
    assert.equal(payload.summary.quarantined, 1);
    assert.equal(payload.summary.counts.retried, 2);
    assert.equal(payload.summary.counts['f2p-id-missing'], 1);
    assert.deepEqual(payload.quarantine, ['task-b']);

    const written = JSON.parse(readFileSync(join(dir, 'out', 'preflight.json'), 'utf8'));
    assert.deepEqual(written.quarantine, ['task-b']);
    assert.equal(written.summary.quarantined, 1);
    assert.equal(written.summary.okWithNotes, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'out', 'quarantine.json'), 'utf8')),
      ['task-b'],
    );
    assert.equal(byId.get('task-a').collect.ok, true);
    assert.deepEqual(byId.get('task-a').collect, {
      ok: true, missingF2p: [], missingP2p: [], truncatedF2p: [], truncatedP2p: [],
    });
    assert.deepEqual(byId.get('task-a').f2pAtBase, { failed: 2, passed: 0, errored: 0 });
    assert.equal(byId.get('task-a').error, null);
    assert.deepEqual(Object.keys(byId.get('task-a')).sort(),
      ['collect', 'error', 'f2pAtBase', 'instance_id', 'notes', 'p2pAtBase', 'reasons', 'verdict']);
  });
}));

test('--only runs one pack row; an unknown id is refused', () => withTempDir((dir) => {
  const benchRoot = makePack(join(dir, 'bench'), ['task-a', 'task-b']);
  const seen = [];
  const runner = async (task) => {
    seen.push(task.instance_id);
    return green();
  };
  const outDir = join(dir, 'out');
  return runPreflight(
    makeOpts(benchRoot, outDir, { only: 'task-b' }),
    { runAttempt: runner },
  ).then((payload) => {
    assert.deepEqual(seen, ['task-b']);
    assert.deepEqual(payload.tasks.map((row) => row.instance_id), ['task-b']);
    return assert.rejects(
      () => runPreflight(makeOpts(benchRoot, join(dir, 'out2'), { only: 'task-z' }), { runAttempt: runner }),
      /--only task-z is not in the task pack/u,
    );
  });
}));

test('bad arguments exit 2 and a missing flag is refused', async () => {
  assert.throws(() => parseCli(['--bench-root', 'x']), /--staging-root <dir> is required/u);
  assert.throws(
    () => parseCli(['--bench-root', 'b', '--staging-root', 's', '--venv-root', 'v', '--out', 'o', '--jobs', '0']),
    /--jobs must be a positive integer/u,
  );
  const savedWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['--bench-root', 'only-one']), 2);
  } finally {
    process.stderr.write = savedWrite;
  }
});
