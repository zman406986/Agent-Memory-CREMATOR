#!/usr/bin/env node
/**
 * opencode-mock-model's arg parser on the shared `parseDevArgs` (ISSUE-392).
 * Smoke: valid flags still parse in-process (no server starts — parseArgs is
 * pure); refusals are checked through a spawned CLI, which exits 2 before any
 * listen. No request log is read or written here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './opencode-mock-model.mjs';

const TOOL = fileURLToPath(new URL('./opencode-mock-model.mjs', import.meta.url));

test('args: valid flags parse as before', () => {
  const opts = parseArgs(['--port', '8123', '--port-file', 'p.txt', '--log', 'l.jsonl', '--script', 's.json']);
  assert.deepEqual(opts, { port: 8123, portFile: 'p.txt', log: 'l.jsonl', script: 's.json' });
  const defaults = parseArgs(['--port-file', 'p.txt', '--log', 'l.jsonl', '--script', 's.json']);
  assert.equal(defaults.port, 0);
  const inline = parseArgs(['--port=9000', '--port-file=p.txt', '--log=l.jsonl', '--script=s.json']);
  assert.equal(inline.port, 9000);
  assert.equal(inline.script, 's.json');
});

test('args: CLI refusals keep their wording and exit 2; a flag is never a value', () => {
  const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const unknown = run(['--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument "--bogus"/u);
  const missing = run(['--port-file', 'p.txt', '--log', 'l.jsonl', '--script']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--script needs a value/u);
  // The mis-bind class: `--log --script s.json` must refuse, not log to "--script".
  const misbind = run(['--port-file', 'p.txt', '--log', '--script', 's.json']);
  assert.equal(misbind.status, 2);
  assert.match(misbind.stderr, /--log needs a value/u);
});