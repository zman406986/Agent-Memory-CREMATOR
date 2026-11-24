#!/usr/bin/env node
/**
 * opencode-checkpoints' arg parser on the shared `parseDevArgs` (ISSUE-392).
 * Smoke only: valid flags still parse, `--flag=value` and `-d` work, and a
 * value flag never swallows the next flag. No log is read here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './opencode-checkpoints.mjs';

test('args: valid flags parse as before', () => {
  const opts = parseArgs(['stdout.ndjson', 'result.json', '--deliverables', 'd.json', '--json']);
  assert.deepEqual(opts, {
    help: false, stdoutPath: 'stdout.ndjson', resultPath: 'result.json',
    deliverablesPath: 'd.json', json: true,
  });
  const one = parseArgs(['stdout.ndjson']);
  assert.equal(one.resultPath, null);
  assert.equal(one.deliverablesPath, null);
  assert.equal(one.json, false);
  assert.equal(parseArgs(['-d', 'd.json', 'stdout.ndjson']).deliverablesPath, 'd.json');
  assert.equal(parseArgs(['--deliverables=d.json', 'stdout.ndjson']).deliverablesPath, 'd.json');
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['-h']), { help: true });
});

test('args: refusals keep their wording and a flag is never a value', () => {
  assert.throws(() => parseArgs([]), /a stdout\.ndjson path is required/u);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /unexpected extra argument c/u);
  assert.throws(() => parseArgs(['x', '--bogus']), /unknown option --bogus/u);
  assert.throws(() => parseArgs(['x', '--deliverables']), /--deliverables needs a value/u);
  // The mis-bind class: `--deliverables --json` must refuse, not read "--json" as a path.
  assert.throws(() => parseArgs(['x', '--deliverables', '--json']), /--deliverables needs a value/u);
});