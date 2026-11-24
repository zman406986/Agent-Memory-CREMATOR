// ISSUE-381: sanitize-fixture now parses via the shared parseDevArgs. These pin
// the improvement (`--flag=value` works) and the refusal wording the script owns
// ("X needs a value", "unknown argument: X" — with the colon). The CLI is spawned
// because the module runs main() on import.
//
// Run: node --test dev/bench/fixtures/sim/sanitize-fixture.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'sanitize-fixture.mjs');
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('--flag=value sanitizes a pair and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanitize-args-'));
  try {
    const sessionIn = join(dir, 's.jsonl');
    const usageIn = join(dir, 'u.json');
    const sessionOut = join(dir, 's.out.jsonl');
    const usageOut = join(dir, 'u.out.json');
    writeFileSync(sessionIn, '{"a":"hi"}\n');
    writeFileSync(usageIn, '{"b":"ok"}');
    const res = run([
      `--session-in=${sessionIn}`, `--session-out=${sessionOut}`,
      `--usage-in=${usageIn}`, `--usage-out=${usageOut}`,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(sessionOut, 'utf8'), '{"a":"hi"}\n');
    assert.equal(readFileSync(usageOut, 'utf8'), '{"b":"ok"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing-value and unknown refusals keep their wording', () => {
  const missing = run(['--session-in']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /--session-in needs a value/u);

  const unknown = run(['bogus']);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /unknown argument: bogus/u);
});

test('--help and -h still print usage and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const res = run([flag]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /usage: sanitize-fixture\.mjs/u);
  }
});