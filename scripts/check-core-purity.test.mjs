// Self-test for scripts/check-core-purity.mjs (ISSUE-071).
//
// The gate used to extract imports with three regexes and failed open on two legal
// module forms: a side-effect import (`import "node:fs";`) and a dynamic import
// with a template literal (`` await import(`node:fs`) ``). Both are asserted twice
// here: RED under the same regexes the gate used to carry, GREEN (i.e. reported)
// under the current implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specifiers, judge } from './check-core-purity.mjs';

const GATE = fileURLToPath(new URL('./check-core-purity.mjs', import.meta.url));

// Verbatim copy of the three regexes the gate carried before ISSUE-071. It is the
// reproduction of the hole, not code under test: do not "fix" it.
const OLD_IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
const OLD_REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const OLD_DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function oldSpecifiers(source) {
  const found = [];
  for (const re of [OLD_IMPORT_RE, OLD_REQUIRE_RE, OLD_DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) found.push(m[1]);
  }
  return found;
}

// A sink outside every SCOPED_ALLOWED prefix, so path scoping cannot mask a result.
const OUTSIDE = 'not-ledger/probe.ts';

test('RED: the old regexes miss a side-effect import of a forbidden builtin', () => {
  const source = 'import "node:fs";\n';
  assert.deepEqual(oldSpecifiers(source), [], 'the old gate found nothing, so it passed the file');
  assert.deepEqual(
    judge(OUTSIDE, source),
    ['not-ledger/probe.ts: builtin "node:fs" not allowed at this path'],
    'the gate must now report it',
  );
});

test('RED: the old regexes miss a dynamic import with a template literal', () => {
  const source = 'export async function load() { return await import(`node:fs`); }\n';
  assert.deepEqual(oldSpecifiers(source), [], 'the old gate found nothing, so it passed the file');
  assert.deepEqual(
    judge(OUTSIDE, source),
    ['not-ledger/probe.ts: builtin "node:fs" not allowed at this path'],
  );
});

test('RED: a bare package via a side-effect import is a bare-package violation', () => {
  const source = 'import "lodash";\n';
  assert.deepEqual(oldSpecifiers(source), []);
  assert.deepEqual(
    judge(OUTSIDE, source),
    ['not-ledger/probe.ts: bare package import "lodash" not allowed in core'],
  );
});

test('the forms the regexes already caught keep their exact messages', () => {
  assert.deepEqual(
    judge(OUTSIDE, 'import x from "node:http";\n'),
    ['not-ledger/probe.ts: forbidden import "node:http"'],
  );
  assert.deepEqual(
    judge(OUTSIDE, 'export { y } from "node:child_process";\n'),
    ['not-ledger/probe.ts: forbidden import "node:child_process"'],
  );
  assert.deepEqual(
    judge(OUTSIDE, 'const y = require("undici");\n'),
    ['not-ledger/probe.ts: forbidden import "undici"'],
  );
  assert.deepEqual(
    judge(OUTSIDE, 'import foo from "@deepseek-ai/sdk";\n'),
    ['not-ledger/probe.ts: forbidden import "@deepseek-ai/sdk"'],
  );
  assert.deepEqual(
    judge(OUTSIDE, 'const s = await import("openai");\n'),
    ['not-ledger/probe.ts: forbidden import "openai"'],
  );
});

test('allow/deny semantics are unchanged', () => {
  assert.deepEqual(judge(OUTSIDE, 'import { h } from "node:crypto";\n'), []);
  assert.deepEqual(judge(OUTSIDE, 'import { h } from "./local.js";\n'), []);
  assert.deepEqual(
    judge(OUTSIDE, 'import { h } from "../../up.js";\n'),
    ['not-ledger/probe.ts: relative import "../../up.js" leaves packages/core/src'],
    'a relative specifier that climbs out of the tree is reported, not skipped (ISSUE-593)',
  );
  assert.deepEqual(judge('ledger/rows.ts', 'import { DatabaseSync } from "node:sqlite";\n'), []);
  assert.deepEqual(judge('ledger/rows.ts', 'import { readFile } from "node:fs/promises";\n'), []);
  assert.deepEqual(
    judge('ledger/rows.ts', 'import { readFile } from "node:fs";\n'),
    [],
    'node:fs is scoped-allowed in ledger/',
  );
  assert.deepEqual(
    judge('engine/plan.ts', 'import { DatabaseSync } from "node:sqlite";\n'),
    ['engine/plan.ts: builtin "node:sqlite" not allowed at this path'],
  );
});

test('import.meta is not an import specifier', () => {
  assert.deepEqual(specifiers('const u = import.meta.url;\n'), { specs: [], unverifiable: 0 });
  assert.deepEqual(judge(OUTSIDE, 'const u = import.meta.url;\n'), []);
});

test('a leading BOM does not blind the lexer', () => {
  const source = '\uFEFFimport "node:fs";\n';
  assert.deepEqual(oldSpecifiers(source), []);
  assert.deepEqual(
    judge(OUTSIDE, source),
    ['not-ledger/probe.ts: builtin "node:fs" not allowed at this path'],
  );
});

test('a dynamic import with no static specifier fails closed', () => {
  const source = 'export const load = (name) => import(name);\n';
  assert.deepEqual(oldSpecifiers(source), []);
  assert.deepEqual(
    judge(OUTSIDE, source),
    ['not-ledger/probe.ts: dynamic import with a non-literal specifier cannot be verified'],
  );
});

test('TS type-only, import-equals and export-star forms are read once each', () => {
  assert.deepEqual(
    judge(OUTSIDE, 'import type { X } from "node:sqlite";\n'),
    ['not-ledger/probe.ts: builtin "node:sqlite" not allowed at this path'],
  );
  assert.deepEqual(
    judge('ledger/rows.ts', 'import x = require("node:sqlite");\n'),
    [],
    'import-equals is one statement, not a forbidden+allowed pair of hits',
  );
  assert.deepEqual(specifiers('import x = require("node:sqlite");\n'), {
    specs: ['node:sqlite'],
    unverifiable: 0,
  });
  assert.deepEqual(
    judge(OUTSIDE, 'export * from "node:http";\n'),
    ['not-ledger/probe.ts: forbidden import "node:http"'],
  );
});

test('an unparsable file fails closed instead of passing', () => {
  const [line] = judge(OUTSIDE, 'import { from "x";\n');
  assert.match(line, /^not-ledger\/probe\.ts: cannot parse for import extraction \(Parse error @/);
  assert.match(line, /; cannot verify$/);
});

// End-to-end: the real gate binary over a fixture tree. This is the acceptance
// shape of ISSUE-071 — a file the OLD regexes cleared must now turn the gate RED.
test('the gate exits 1 on a fixture tree the old regexes cleared', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'racoons-purity-'));
  try {
    await mkdir(join(fixture, 'engine'), { recursive: true });
    const body = 'import "node:fs";\nexport const load = () => import(`node:fs`);\n';
    await writeFile(join(fixture, 'engine', 'probe.ts'), body);

    // RED proof: the old extractor sees nothing in this exact text.
    assert.deepEqual(oldSpecifiers(body), []);

    const run = spawnSync(process.execPath, [GATE, fixture], { encoding: 'utf8' });
    assert.equal(run.status, 1, `gate must fail; stdout=${run.stdout} stderr=${run.stderr}`);
    assert.match(run.stderr, /engine\/probe\.ts: builtin "node:fs" not allowed at this path/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('the gate exits 0 on a clean fixture tree', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'racoons-purity-clean-'));
  try {
    await mkdir(join(fixture, 'util'), { recursive: true });
    await writeFile(join(fixture, 'util', 'hash.ts'), 'import { createHash } from "node:crypto";\n');
    const run = spawnSync(process.execPath, [GATE, fixture], { encoding: 'utf8' });
    assert.equal(run.status, 0, `gate must pass; stderr=${run.stderr}`);
    assert.match(run.stdout, /1 core files clean/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
