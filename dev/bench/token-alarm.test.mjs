#!/usr/bin/env node
/**
 * token-alarm's arg parser on the shared `parseDevArgs` (ISSUE-392).
 * Smoke only: valid flags still parse, `--flag=value` works, the mode flags
 * keep their last-one-wins meaning, and a value flag never swallows the next
 * flag. No session log is read here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STOP, DEFAULT_WARN, parseArgs } from './token-alarm.mjs';

test('args: valid flags parse as before', () => {
  const opts = parseArgs([
    'session.v4.jsonl', '--warn', '1000', '--stop', '2000',
    '--interval-ms', '50', '--once', '--ask-journal', 'j.jsonl',
  ]);
  assert.equal(opts.mode, 'watch');
  assert.equal(opts.target, 'session.v4.jsonl');
  assert.equal(opts.warn, 1000);
  assert.equal(opts.stop, 2000);
  assert.equal(opts.intervalMs, 50);
  assert.equal(opts.once, true);
  assert.equal(opts.askJournal, 'j.jsonl');
});

test('args: defaults, --log, inline values and the mode flags', () => {
  const defaults = parseArgs(['x']);
  assert.equal(defaults.warn, DEFAULT_WARN);
  assert.equal(defaults.stop, DEFAULT_STOP);
  assert.equal(defaults.once, false);
  const inline = parseArgs(['--log=x', '--warn=10', '--stop=20']);
  assert.equal(inline.target, 'x');
  assert.equal(inline.warn, 10);
  assert.equal(inline.stop, 20);
  assert.equal(parseArgs(['--selftest']).mode, 'selftest');
  assert.equal(parseArgs(['--help']).mode, 'help');
  assert.equal(parseArgs(['-h']).mode, 'help');
  assert.equal(parseArgs(['--selftest', '--help']).mode, 'help');
  assert.equal(parseArgs(['--help', '--selftest']).mode, 'selftest');
});

test('args: refusals keep their wording and a flag is never a value', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag --bogus/u);
  assert.throws(() => parseArgs([]), /no target/u);
  assert.throws(() => parseArgs(['a', 'b']), /one target, not several/u);
  assert.throws(() => parseArgs(['x', '--log', 'y']), /name the target once/u);
  assert.throws(() => parseArgs(['--selftest', 'x']), /selftest takes no target/u);
  assert.throws(() => parseArgs(['x', '--warn', 'abc']), /--warn takes an integer, got abc/u);
  assert.throws(() => parseArgs(['x', '--warn', '5000', '--stop', '2000']), /--warn must be below --stop/u);
  // The mis-bind class: `--warn --stop 5` must refuse, not read "--stop" as a count.
  assert.throws(() => parseArgs(['x', '--warn', '--stop', '5']), /--warn needs a value/u);
  assert.throws(() => parseArgs(['x', '--log', '--once']), /--log needs a value/u);
});