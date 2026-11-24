#!/usr/bin/env node
/**
 * opencode-ledger-scale's arg parser on the shared `parseDevArgs` (ISSUE-392).
 *
 * parseArgs is pure and the harness sits behind an entry guard, so valid parses
 * and refusals are checked in-process. One three-request harness run is spawned
 * to prove the ask reply is readable and at least one row applies under the
 * product grammar; the measured 1050-request run is never started here. The
 * CLI checks spawn with the TS resolve hook so the top-level
 * `cremator-opencode` import resolves to source rather than unbuilt dist. No
 * host, no model, no network; no request log is read or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonl20NoKeepallAnswer } from '@cremator/core';
import { askForgetAllReply, checkedForgetAllReply, parseArgs } from './opencode-ledger-scale.mjs';

const TOOL = fileURLToPath(new URL('./opencode-ledger-scale.mjs', import.meta.url));
const HOOK = pathToFileURL(
  fileURLToPath(new URL('../../scripts/ts-resolve-hooks.mjs', import.meta.url)),
).href;

// The CLI spawns need the same hook the in-process import uses, so the workspace
// `cremator-opencode` import resolves to source. parseArgs refuses before the
// mount is created, so these spawns never run the measured harness.
const run = (args) => spawnSync(process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--import', HOOK, TOOL, ...args],
  { encoding: 'utf8' });

test('args: valid flags parse as before (defaults, bounds, inline, grow)', () => {
  assert.deepEqual(parseArgs([]), { requests: 1050, units: 1, grow: false });
  assert.deepEqual(parseArgs(['--requests', '5', '--units', '3']),
    { requests: 5, units: 3, grow: false });
  assert.deepEqual(parseArgs(['--grow']), { requests: 1050, units: 1, grow: true });
  assert.deepEqual(parseArgs(['--requests=2', '--units=8']),
    { requests: 2, units: 8, grow: false });
  assert.deepEqual(parseArgs(['--requests', '2']), { requests: 2, units: 1, grow: false });
});

test('args: a flag is never bound as a value; a missing value refuses', () => {
  // The mis-bind class: `--requests --grow` must refuse, not silently coerce NaN.
  assert.throws(() => parseArgs(['--requests', '--grow']), /--requests needs a value/u);
  assert.throws(() => parseArgs(['--units', '--grow']), /--units needs a value/u);
  assert.throws(() => parseArgs(['--requests']), /--requests needs a value/u);
  assert.throws(() => parseArgs(['--units']), /--units needs a value/u);
});

test('args: numeric bounds and the grow combination keep their wording', () => {
  assert.throws(() => parseArgs(['--requests', 'abc']), /--requests takes an integer >= 2/u);
  assert.throws(() => parseArgs(['--requests', '1']), /--requests takes an integer >= 2/u);
  assert.throws(() => parseArgs(['--units', '0']), /--units takes an integer 1..8/u);
  assert.throws(() => parseArgs(['--units', '9']), /--units takes an integer 1..8/u);
  assert.throws(() => parseArgs(['--grow', '--units', '2']),
    /--grow adds one unit per request; do not combine it with --units/u);
});

test('args: unknown flag and positional keep the unquoted wording', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument --bogus/u);
  assert.throws(() => parseArgs(['positional']), /unknown argument positional/u);
});

test('args: CLI --help exits 0 with usage; a refusal exits 2 with the prefix', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout,
    'usage: opencode-ledger-scale.mjs [--requests <n>] [--units <n>] [--grow]\n');
  assert.equal(help.stderr, '');
  const refused = run(['--requests', '--grow']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /opencode-ledger-scale\.mjs: --requests needs a value/u);
  assert.equal(refused.stdout, '');
});

test('ask: the harness reply is one object per line and answers every row', () => {
  // The rows the product's table carries: two rows, each stating its line
  // count. The old shape (one object, bare-string forgetall) refused every row.
  const rows = [
    { index: 1, call: 'read', path: 'NOTE_1.md', anchorLines: ['line one'], lineCount: 3 },
    { index: 2, call: 'read', path: 'NOTE_2.md', anchorLines: ['line two'], lineCount: 2 },
  ];
  const reply = askForgetAllReply(rows);
  const lines = reply.split('\n');
  assert.equal(lines.length, 2, 'one JSON object per line');
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(Object.keys(parsed).length, 1, 'each line names exactly one row');
  }
  const reading = readJsonl20NoKeepallAnswer(reply, [1, 2]);
  assert.deepEqual(reading.rows.map((row) => row.status), ['answered', 'answered'],
    'the product reader accepts every row');
  assert.deepEqual(reading.rows.map((row) => row.answer.action), ['forgetall', 'forgetall']);
  assert.match(lines[0], /"forgetall":true/u, 'the verdict is a boolean, never a bare string');
  assert.match(lines[0], /"summary":/u);
  assert.equal(askForgetAllReply([]), '', 'a table with no rows answers nothing');
});

test('ask: a reply that does not answer every asked row is refused by name', () => {
  // One asked row left out: its line reads `missing-index`, so the harness
  // throws instead of shipping an answer that silently forgets a unit.
  const oneOfTwo = JSON.stringify({ 1: { forgetall: true, summary: 'stale note 1' } });
  assert.throws(() => checkedForgetAllReply(oneOfTwo, [1, 2]),
    (error) => /not readable by the product reader/u.test(error.message)
      && /missing-index/u.test(error.message),
    'an omitted row is a named refusal, not a silent no-op');
  // A row the reader classifies as anything but an answered `forgetall` is the
  // same refusal: `keepall` is not offered by this grammar and keeps.
  const keepAll = JSON.stringify({ 1: { keepall: true } });
  assert.throws(() => checkedForgetAllReply(keepAll, [1]),
    (error) => /not readable by the product reader/u.test(error.message)
      && /action-not-in-grammar/u.test(error.message),
    'a keep is not an applied forgetall');
});

test('ask: a measured run applies at least one row under the new grammar', () => {
  // Three requests: the first ships the unit, the second asks and applies the
  // forgetall, the third re-applies it. A malformed reply would print
  // appliedRows 0 and make the whole harness vacuous.
  const out = run(['--requests', '3']);
  assert.equal(out.status, 0, out.stderr);
  const record = JSON.parse(out.stdout);
  assert.ok(record.askGenerateCalls >= 1, 'the ask fired');
  assert.ok(record.appliedRows >= 1,
    `at least one applied row is measured, got ${String(record.appliedRows)}`);
  assert.ok(record.askApplyLines >= 1,
    `at least one ask-apply line is measured, got ${String(record.askApplyLines)}`);
  assert.ok(record.ledgerEvents >= record.appliedRows,
    'the ledger event count includes the applied rows');
});
