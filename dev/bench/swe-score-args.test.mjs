#!/usr/bin/env node
/**
 * swe-score's arg parser on the shared `parseDevArgs` (ISSUE-392).
 * Smoke only: valid flags still parse (dashed keys camelCase, inline values,
 * booleans), refusals keep their wording, and a value flag never swallows the
 * next flag. No scoring runs here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './swe-score.mjs';

const VALID = [
  '--arm-dir', 'arm', '--snapshot', 'snap.json', '--tasks', 'pack.json',
  '--staging', 'stage', '--venv-root', 'venv', '--out', 'out',
];

test('args: valid flags parse as before', () => {
  const opts = parseArgs([...VALID, '--keep-clones', '--timeout-ms', '5000']);
  assert.equal(opts.armDir, 'arm');
  assert.equal(opts.snapshot, 'snap.json');
  assert.equal(opts.tasks, 'pack.json');
  assert.equal(opts.staging, 'stage');
  assert.equal(opts.venvRoot, 'venv');
  assert.equal(opts.out, 'out');
  assert.equal(opts.keepClones, true);
  assert.equal(opts.timeoutMs, 5000);
  const inline = parseArgs(['--arm-dir=arm', '--base-dir=base', '--base-override-dir=over']);
  assert.equal(inline.armDir, 'arm');
  assert.equal(inline.baseDir, 'base');
  assert.equal(inline.baseOverrideDir, 'over');
  assert.equal(inline.keepClones, false);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  // A single-dash value is a value, as before.
  assert.equal(parseArgs(['--out', '-x']).out, '-x');
});

test('args: refusals keep their wording and a flag is never a value', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown flag: --bogus/u);
  assert.throws(() => parseArgs(['positional']), /unknown argument: positional/u);
  assert.throws(() => parseArgs(['--out']), /--out needs a value/u);
  assert.throws(() => parseArgs(['--out', '--arm-dir', 'a']), /--out needs a value/u);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /--timeout-ms needs a positive number, got 0/u);
  assert.throws(() => parseArgs(['--timeout-ms', 'abc']), /--timeout-ms needs a positive number, got abc/u);
});