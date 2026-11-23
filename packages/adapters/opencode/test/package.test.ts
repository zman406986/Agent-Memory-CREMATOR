// Package gate (ISSUE-192): the source scans — no source file imports the
// OpenCode runtime packages, and none imports `cremator-dsh`. Both scans fail
// closed on an empty source set: a scan over nothing proves nothing. The
// runtime-import scanner's own separation of value imports from type imports is
// pinned by the last test, so the scan itself cannot pass vacuously.
//
// The 2.4.0 family is `@opencode/*`; `@opencode-ai/*` is the retired 1.x family
// and is scanned too, so a regression cannot creep back in.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(PACKAGE_DIR, 'src');
const OPENCODE = '@opencode/';
const RETIRED = '@opencode-ai/';
const FORBIDDEN = 'cremator-dsh';

async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSources(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Returns the offsets covered by a type-only import/export statement naming the package.
function typeOnlySpans(source: string, name: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(import|export)[ \\t]+type[ \\t][^;]*?from[ \\t]*['"]${name}[^'"]*['"]`,
    'g',
  );
  for (const match of source.matchAll(re)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

// Comment spans, so a comment that names the package (a pin note) is not read as an import.
function commentSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

// Any mention of the package outside a type-only statement or a comment is a runtime import
// candidate; an unparsed mention is a failure, never a pass, because a scanner that guesses is
// vacuous.
function runtimeImports(source: string, name: string): string[] {
  const allowed = [...typeOnlySpans(source, name), ...commentSpans(source)];
  const violations: string[] = [];
  for (const match of source.matchAll(new RegExp(name.replace(/[/.]/g, '\\$&'), 'g'))) {
    const at = match.index;
    if (allowed.some(([start, end]) => at >= start && at < end)) continue;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    violations.push(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim());
  }
  return violations;
}

async function offenders(name: string): Promise<string[]> {
  const files = await collectSources(SRC_DIR);
  assert.ok(files.length > 0, 'scan found no source files; a scan over nothing proves nothing');
  const found: string[] = [];
  for (const file of files) {
    for (const line of runtimeImports(await readFile(file, 'utf8'), name)) {
      found.push(`${file}: ${line}`);
    }
  }
  return found;
}

const ROWS: readonly Row[] = [
  { name: 'no-runtime-opencode-import', async run(at) {
    assert.deepEqual(await offenders(OPENCODE), [],
      at('runtime imports of @opencode/ are forbidden; use `import type`'));
  } },
  { name: 'no-runtime-retired-1x-import', async run(at) {
    assert.deepEqual(await offenders(RETIRED), [],
      at('the retired @opencode-ai/ family must not come back'));
  } },
  { name: 'no-cremator-dsh-import', async run(at) {
    const files = await collectSources(SRC_DIR);
    assert.ok(files.length > 0, at('scan found no source files; a scan over nothing proves nothing'));
    const found = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes(FORBIDDEN)) found.push(file);
    }
    assert.deepEqual(found, [], at('the OpenCode adapter must not depend on the dsh adapter'));
  } },
  { name: 'scanner-separates-values-from-type', run(at) {
    const flagged = [
      "import { Plugin } from '@opencode/plugin';",
      "import type { Plugin } from 'other';\nimport { Plugin } from '@opencode/plugin';",
      "export { x } from '@opencode/plugin';",
      "const p = await import('@opencode/plugin');",
      "import('@opencode/plugin');",
    ];
    for (const source of flagged) {
      assert.notDeepEqual(runtimeImports(source, OPENCODE), [], at(`should flag: ${source}`));
    }
    const clean = [
      "import type { Plugin } from '@opencode/plugin';",
      "export type { Plugin } from '@opencode/plugin';",
      "import type {\n  Plugin,\n  Context,\n} from '@opencode/plugin';",
      "// @opencode/plugin is pinned; see README.",
    ];
    for (const source of clean) {
      assert.deepEqual(runtimeImports(source, OPENCODE), [], at(`should pass: ${source}`));
    }
  } },
];

test('the package scans — one row per claim', async () => {
  await runRows(ROWS);
});
