// The drift gate for the twin row-table helpers (ISSUE-166, Option B). Both
// adapters keep their own `rows.ts` and are held in step by hand, so this is the
// only thing that fails when one copy moves and the other does not. It compares
// the code below each file's leading block comment; that comment is per-copy by
// design — it names the other copy's path — and is therefore not drift.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINE = join(HERE, 'rows.ts');
const TWIN = join(HERE, '..', '..', 'opencode', 'test', 'rows.ts');

/** The code after the header comment, failing closed when the contract is absent. */
function body(source: string, path: string): string {
  const end = source.indexOf('*/');
  assert.ok(end !== -1, `${path}: no header comment to skip`);
  const code = source.slice(end + 2).trim();
  assert.ok(code.includes('export async function runRows'),
    `${path}: no runRows export; a comparison over nothing would pass`);
  return code;
}

test('the two adapter rows.ts copies share one label contract', async () => {
  const [mine, twin] = await Promise.all([readFile(MINE, 'utf8'), readFile(TWIN, 'utf8')]);
  const [left, right] = [body(mine, MINE), body(twin, TWIN)];
  const [a, b] = [left.split('\n'), right.split('\n')];
  const at = a.findIndex((line, index) => line !== b[index]);
  const where = at === -1 ? `line counts ${a.length} vs ${b.length}`
    : `line ${at + 1}: ${JSON.stringify(a[at])} vs ${JSON.stringify(b[at])}`;
  assert.equal(left, right,
    `the row-table copies drifted apart and are kept in step by hand (ISSUE-166); `
    + `${MINE} vs ${TWIN}, ${where}`);
});
