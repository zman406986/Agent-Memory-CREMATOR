#!/usr/bin/env node
/**
 * opencode-run's arg parser on the shared `parseDevArgs` (ISSUE-387).
 *
 * The safety defect: the old hand-rolled `next()` bound the FOLLOWING `--flag`
 * as a value, so `--task --dry-run` set task="--dry-run", left dryRun false and
 * LAUNCHED instead of refusing. These tests spawn the CLI (the parser exits 2
 * before main launches anything) and prove the mis-bind is refused, the
 * needs-value / unknown wording is unchanged, and valid flags still parse.
 *
 * Offline only: the mock arm never reaches a provider, and the real-route case
 * carries no key, so the gate refuses before any launch. No host, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./opencode-run.mjs', import.meta.url));
const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
/** A script path that does not exist, so the old parser refuses here, never launching. */
const NO_SUCH_SCRIPT = join(BENCH_DIR, 'opencode-run-args.no-such-script.mjs');

/**
 * The offline bench refuses when a real-API env name is set, and a real route
 * reads its key from the environment; both are cleared so a refusal is the
 * parser's, never an ambient credential's, and nothing can launch.
 */
function run(args) {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.BENCH_REAL_API;
  delete env.RIG_REAL_API;
  delete env.BENCH_REAL_KEY;
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env });
}

test('args: --task --dry-run is refused, not mis-bound into a launch (mock arm)', () => {
  // The old parser swallowed --dry-run as the task text and ran on; the shared
  // parser refuses the missing value before main() is reached, so nothing runs.
  const res = run(['--arm', 'test', '--script', NO_SUCH_SCRIPT, '--task', '--dry-run']);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /--task needs a value/u);
  assert.equal(res.stdout, '', 'a refused parse prints no config and launches nothing');
});

test('args: --task --dry-run is refused on a real-route shape too (no key, no launch)', () => {
  // Faithful to the defect: an intended real-route dry-run became a real-launch
  // attempt. With no key the old parser fell through to the key gate; the shared
  // parser refuses the mis-bind first. Either way nothing launches.
  const res = run([
    '--arm', 'test', '--provider', 'deepseek-official', '--i-am-the-owner',
    '--kill-ms', '1000', '--task', '--dry-run',
  ]);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /--task needs a value/u);
  assert.equal(res.stdout, '', 'a refused parse prints no config and launches nothing');
});

test('args: a value flag at the end still refuses with its own wording', () => {
  const res = run(['--arm', 'test', '--task']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--task needs a value/u);
});

test('args: an unknown flag keeps the quoted refusal wording', () => {
  const res = run(['--arm', 'test', '--bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown argument "--bogus"/u);
});

test('args: --dry-run still parses as a boolean and reaches the real-route gate', () => {
  // A valid mock dry-run is refused by the gate (dry-run composes a real route),
  // unchanged: the flag binds as a boolean, never as a value.
  const res = run(['--arm', 'test', '--dry-run']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--dry-run composes a real route/u);
});

test('args: --help prints usage and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: opencode-run\.mjs --arm <vanilla\|test>/u);
  assert.equal(res.stderr, '');
});