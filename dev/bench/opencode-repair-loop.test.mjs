#!/usr/bin/env node
/**
 * opencode-repair-loop's arg parser (ISSUE-392): NaN numeric flags must be
 * refused, and a value flag must never swallow the next flag. Parser only —
 * no key is read, no brief is opened, nothing launches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './opencode-repair-loop.mjs';

const BASE = [
  '--segment', '1', '--brief', 'b.md', '--work-dir', 'w',
  '--prior', 'p', '--evidence-root', 'e',
];

test('args: a valid invocation parses with defaults and overrides', () => {
  const out = parseArgs(BASE);
  assert.equal(out.segment, 1);
  assert.equal(out.arm, 'test');
  assert.equal(out.maxAttempts, 30);
  assert.equal(out.taskTotal, 105);
  assert.equal(out.killMs, 86400000);
  assert.equal(out.grant, 300000000);
  assert.ok(out.brief.endsWith('b.md'), 'brief is resolved');
  const custom = parseArgs([
    ...BASE, '--arm', 'vanilla', '--max-attempts', '5', '--task-total', '10',
    '--kill-ms', '1000', '--grant', '2000',
  ]);
  assert.equal(custom.arm, 'vanilla');
  assert.equal(custom.maxAttempts, 5);
  assert.equal(custom.taskTotal, 10);
  assert.equal(custom.killMs, 1000);
  assert.equal(custom.grant, 2000);
});

test('args: inline --flag=value works on the shared parser', () => {
  const inline = parseArgs([...BASE, '--max-attempts=7', '--kill-ms=500']);
  assert.equal(inline.maxAttempts, 7);
  assert.equal(inline.killMs, 500);
});

test('args: NaN maxAttempts/taskTotal/killMs/grant are refused', () => {
  for (const flag of ['--max-attempts', '--task-total', '--kill-ms', '--grant']) {
    assert.throws(
      () => parseArgs([...BASE, flag, 'abc']),
      new RegExp(`${flag} takes a number`),
      `${flag} abc must be refused, not coerced to NaN`,
    );
  }
});

test('args: a value flag never swallows the next flag', () => {
  // `--brief --arm` must refuse, not resolve a directory named "--arm".
  assert.throws(
    () => parseArgs([
      '--segment', '1', '--work-dir', 'w', '--prior', 'p',
      '--evidence-root', 'e', '--brief', '--arm',
    ]),
    /--brief needs a value/u,
  );
});

test('args: refusals keep their wording', () => {
  assert.throws(() => parseArgs([...BASE, '--grant']), /--grant needs a value/u);
  assert.throws(() => parseArgs([...BASE, '--bogus', 'x']), /unknown flag --bogus/u);
  assert.throws(() => parseArgs([]), /--segment is required/u);
});