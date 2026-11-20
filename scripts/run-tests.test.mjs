// Discovery gate for scripts/run-tests.mjs.
//
// The runner recurses into workspace package test folders and passes its
// extension list down. This test fails when recursion drops the list, and
// checks that a plain `--list` run still exits 0 in this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTests } from './run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUNNER = join(HERE, 'run-tests.mjs');

test('recursion keeps the extension list: nested .test.mjs files are collected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cremator-runner-discovery-'));
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

test('the runner lists the package suites and exits 0', () => {
  const result = spawnSync(process.execPath, [RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split(/\r?\n/).filter(Boolean)
    .map((file) => relative(ROOT, file).split('\\').join('/'));
  assert.ok(listed.length > 0, 'the runner listed no test at all');
  assert.ok(listed.every((file) => file.startsWith('packages/') || file.startsWith('scripts/')),
    'a listed test sits outside the workspace packages and the repo scripts');
});
