#!/usr/bin/env node
/**
 * The launcher's own argv (ISSUE-091).
 *
 * `result.json.dsh.launchCommand` is the CHILD's command line, so a DoD box
 * that requires a flag "recorded verbatim" could only be inferred from
 * `patch.yml`. The record now lands at `<evidence>/launch.json` beside
 * `task.txt`, before the bench child starts.
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`).
 * The checks spawn it on a `--preflight` run instead: a stub dsh composes the
 * deny rows, so the run costs nothing and reaches no provider, and the record
 * is read back from disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCHPAD } from './bench-run.mjs';

const SCRIPT = fileURLToPath(new URL('./bench-run.mjs', import.meta.url));
// The launcher refuses evidence outside its scratchpad (ISSUE-260). A test
// evidence dir is still evidence, so the temp root lives under scratchpad/tmp
// rather than the OS temp tree. The production guard is not relaxed for tests.
const TEST_ROOT = join(SCRATCHPAD, 'tmp');

// The stub answers `--version` and composes the eight deny rows and the host's
// own tool-result-pruner row, so preflight passes without a dsh install and
// without a provider call. The pruner row is read back out of the `--patch` file
// the launcher wrote: ADR-0041 has the launcher disable it, and the base layer
// ships it enabled, so the stub composes what the patch states rather than a
// constant that would make the preflight's pruner gate vacuous.
const STUB = `const { readFileSync } = require('node:fs');
const rows = ${JSON.stringify([
  'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
  'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc',
])};
if (!process.argv.includes('--dump-config')) process.stdout.write('0.0.0-stub\\n');
else {
  const at = process.argv.indexOf('--patch');
  const patch = readFileSync(process.argv[at + 1], 'utf8');
  for (const id of rows) process.stdout.write(\`- id: \${id}\\n  disabled: true\\n\`);
  const lines = patch.split(/\\r?\\n/u);
  const prunerAt = lines.findIndex((line) => line.trim() === '- id: tool-result-pruner');
  const prunerOff = prunerAt !== -1
    && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[prunerAt + 1] ?? '');
  process.stdout.write(\`- id: tool-result-pruner\\n  disabled: \${prunerOff ? 'true' : 'false'}\\n\`);
}
`;

test('091: --preflight records the launcher argv verbatim, and no env value', () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEST_ROOT, 'racoons-launch-record-'));
  try {
    // `.cjs`: the root is under this repo now, whose package.json says
    // `"type": "module"`; a `.js` stub would be parsed as ESM and `require`
    // would fail before the launcher sees it.
    const bin = join(root, 'stub-bin.cjs');
    const armDir = join(root, 'arm');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(armDir);
    writeFileSync(bin, STUB);
    const argv = ['--preflight', '--arm', 'vanilla', '--arm-dir', armDir, '--dsh-bin', bin,
      '--evidence', evidenceDir];
    const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
      encoding: 'utf8', cwd: root, windowsHide: true,
      env: { ...process.env, CREMATOR_TEST_SENTINEL: 'sk-sentinel-must-not-be-recorded' },
    });
    assert.equal(result.status, 0, result.stderr);

    const raw = readFileSync(join(evidenceDir, 'launch.json'), 'utf8');
    const record = JSON.parse(raw);
    assert.equal(record.schema, 'racoons-bench-launch/1');
    assert.equal(record.script, SCRIPT, 'the record names the full launcher path');
    assert.equal(record.cwd, root, 'the record names the cwd');
    // Verbatim: the same elements in the same order, nothing joined or reordered.
    assert.deepEqual(record.argv, argv);
    // The record is the invocation, not the environment.
    assert.doesNotMatch(raw, /sk-sentinel-must-not-be-recorded/u);
    assert.doesNotMatch(raw, /process\.env/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('091: the record is written before the patch and before the bench child starts', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const callAt = source.indexOf('writeLaunchRecord(evidenceDir, process.argv.slice(2), opts);');
  assert.notEqual(callAt, -1, 'the launcher must record its own argv');
  // The patch is the first artifact built from the flags; `preflight` is the
  // first bench child on the preflight lane. (The `--version` probe runs
  // earlier and starts no bench work.)
  assert.ok(callAt < source.indexOf('const patchPath = writePatch('), 'the record precedes the patch');
  // The `--version` probe runs earlier and starts no bench work; the bench
  // child is the `preflight(...)` call, whose argument list names the sink map.
  const childAt = source.indexOf('preflight(opts, binJs, evidenceDir, patchPath, pluginEntry, credentialsPath');
  assert.notEqual(childAt, -1, 'the bench child call site must still be here');
  assert.ok(callAt < childAt, 'the record precedes the bench child');
});
