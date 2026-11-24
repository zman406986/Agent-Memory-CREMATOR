#!/usr/bin/env node
/**
 * pwsh-guard/build.mjs's arg parser (ISSUE-392): `--out --real-pwsh` must
 * refuse, not build into a directory named "--real-pwsh". Parser only — no
 * compiler runs and nothing is written here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './build.mjs';

test('args: --out --real-pwsh never binds the next flag as the out dir', () => {
  assert.throws(() => parseArgs(['--out', '--real-pwsh']), /--out needs a value/u);
  assert.throws(() => parseArgs(['--real-pwsh', '--out', 'o']), /--real-pwsh needs a value/u);
  assert.throws(() => parseArgs(['--allow-root', '--out', 'o']), /--allow-root needs a value/u);
});

test('args: valid flags parse as before', () => {
  const opts = parseArgs(['--out', 'o', '--real-pwsh', 'pwsh.exe', '--allow-root', 'r1', '--allow-root', 'r2']);
  assert.deepEqual(opts, { out: 'o', realPwsh: 'pwsh.exe', allowRoots: ['r1', 'r2'] });
  assert.deepEqual(parseArgs([]), { out: null, realPwsh: null, allowRoots: [] });
  assert.deepEqual(parseArgs(['--allow-root', 'r1']), { out: null, realPwsh: null, allowRoots: ['r1'] });
});

test('args: inline --flag=value works on the shared parser', () => {
  assert.equal(parseArgs(['--out=o']).out, 'o');
  assert.equal(parseArgs(['--real-pwsh=p.exe']).realPwsh, 'p.exe');
});