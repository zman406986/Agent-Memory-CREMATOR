// Discovery gate for scripts/run-tests.mjs (ISSUE-263).
//
// The runner used to recurse without passing its extension list, so every
// nested `dev/bench/**` directory was scanned for `.test.ts` only and the
// sixteen nested `.test.mjs` files never reached `node --test`. This test fails
// when recursion drops the list, and when one of the pinned nested files is
// omitted or gone from disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTests, runTests } from './run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUNNER = join(HERE, 'run-tests.mjs');

// The nested set as committed. A new nested suite must be added here, so the
// count is an expectation from outside the discovery walk, not a value the
// walk derives from itself.
const NESTED = [
  'dev/bench/fixtures/sim/sanitize-fixture.test.mjs',
  'dev/bench/fixtures/sim/sim-fixture.test.mjs',
  'dev/bench/multiturn/determinism.test.mjs',
  'dev/bench/multiturn/extract.test.mjs',
  'dev/bench/multiturn/live-fill.test.mjs',
  'dev/bench/multiturn/live-score.test.mjs',
  'dev/bench/multiturn/progress.test.mjs',
  'dev/bench/multiturn/removal.test.mjs',
  'dev/bench/multiturn/snapshot.test.mjs',
  'dev/bench/multiturn/tolerance.test.mjs',
  'dev/bench/pwsh-guard/build.test.mjs',
].sort();

const normalize = (file) => relative(ROOT, file).split('\\').join('/');

test('recursion keeps the extension list: nested .test.mjs files are collected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-runner-discovery-'));
  try {
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    for (const file of ['top.test.mjs', 'nested/middle.test.mjs', 'nested/deeper/bottom.test.mjs']) {
      writeFileSync(join(root, ...file.split('/')), '');
    }
    // A nested file outside the requested extensions must stay out, so the
    // assertion below also proves the recursion did not simply accept every file.
    writeFileSync(join(root, 'nested', 'not-requested.test.ts'), '');
    const found = (await collectTests(root, ['.test.mjs']))
      .map((file) => relative(root, file).split('\\').join('/'))
      .sort();
    assert.deepEqual(found, [
      'nested/deeper/bottom.test.mjs',
      'nested/middle.test.mjs',
      'top.test.mjs',
    ], 'a nested .test.mjs was omitted: recursion did not pass the extension list');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the runner lists every pinned nested test, so none is silently omitted', () => {
  const result = spawnSync(process.execPath, [RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split(/\r?\n/).filter(Boolean).map(normalize);
  const nestedListed = listed
    .filter((file) => /^dev\/bench\/.+\/.+\.test\.mjs$/.test(file))
    .sort();
  assert.deepEqual(nestedListed, NESTED,
    `runner discovery nested count ${nestedListed.length}, expected ${NESTED.length}`);
});

test('the runner discovers dev/dsh-rig/run-env.test.mjs in the full suite', () => {
  const result = spawnSync(process.execPath, [RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split(/\r?\n/).filter(Boolean).map(normalize);
  assert.ok(listed.includes('dev/dsh-rig/run-env.test.mjs'),
    'the full runner omitted dev/dsh-rig/run-env.test.mjs: its env allow-list is unguarded');
});

test('a failing discovered test exits nonzero, and a passing one exits zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-runner-exit-'));
  try {
    const passes = join(root, 'passes.test.mjs');
    const fails = join(root, 'fails.test.mjs');
    writeFileSync(passes, "import test from 'node:test';\ntest('passes', () => {});\n");
    writeFileSync(fails,
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "test('fails', () => assert.equal(1, 2));\n");
    assert.equal(await runTests([passes], { stdio: 'ignore' }), 0,
      'a passing test returned a nonzero exit');
    assert.notEqual(await runTests([fails], { stdio: 'ignore' }), 0,
      'a failing test returned a zero exit: the grouped command would be false green');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
