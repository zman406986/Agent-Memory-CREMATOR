#!/usr/bin/env node
/**
 * ISSUE-132: the bench names the restore tool the product ships.
 *
 * The defect: `bench-run.mjs` read the racoons arm's request header for
 * `toolNames.includes('recall')` long after the tool was renamed `necromancy`
 * (`46b0d0b`, ISSUE-123). The header DID offer the mount's tool, so the row read
 * red on every run at that commit or later — the 2026-10-31 attempt-2 run scored
 * it as one of 3 failures. `live-convert.mjs` carried the same stale name in
 * `RESTORE_CLASS`, so a `necromancy` restore counted as no restore at all.
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`), and
 * the header row only exists after a session. These are static pins, as
 * `loopback-gate.test.mjs` pins its own gate: (a) derives the expected name from
 * the SHIPPED adapter spec rather than a second hand-written string, so the next
 * rename fails here by name instead of failing a live run's assertion;
 * (b) holds the header row to that one constant; (c) holds the converter's
 * restore class to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DSH_TOOL_SPECS } from 'cremator-dsh';

const BENCH = readFileSync(new URL('./bench-run.mjs', import.meta.url), 'utf8');
const CONVERT = readFileSync(new URL('./multiturn/live-convert.mjs', import.meta.url), 'utf8');

/**
 * The restore tool is the shipped spec whose whole argument surface is the
 * restore id: `forget` names a path and ranges, the restore names only the id a
 * marker or receipt carries. Deriving it this way keeps the test green through a
 * rename's mechanics and red exactly where the rename must be reflected.
 */
function shippedRestoreToolName() {
  const spec = DSH_TOOL_SPECS.find(
    (candidate) => Object.keys(candidate.parameters?.properties ?? {}).join(',') === 'id');
  assert.ok(spec, 'no shipped DSH_TOOL_SPEC takes only an `id`; the restore tool moved or was removed');
  return spec.name;
}

test('132 (a) the bench names the restore tool the adapter registers', () => {
  const shipped = shippedRestoreToolName();
  const bench = /const RESTORE_TOOL_NAME = '([^']+)';/u.exec(BENCH);
  assert.ok(bench, 'bench-run.mjs no longer declares RESTORE_TOOL_NAME');
  assert.equal(bench[1], shipped,
    `bench-run.mjs names the restore tool '${bench[1]}'; the adapter registers '${shipped}'`);
});

test('132 (c) the converter\'s restore class carries the shipped name', () => {
  const shipped = shippedRestoreToolName();
  const set = /const RESTORE_CLASS = new Set\(\[([^\]]*)\]\);/u.exec(CONVERT);
  assert.ok(set, 'live-convert.mjs no longer declares RESTORE_CLASS');
  assert.ok(set[1].includes(`'${shipped}'`),
    `RESTORE_CLASS omits '${shipped}'; a restore call would count as no restore`);
  assert.ok(!/'recall'/u.test(set[1]),
    'RESTORE_CLASS still names the pre-rename tool');
});
