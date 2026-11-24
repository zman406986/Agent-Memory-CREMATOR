#!/usr/bin/env node
// Core purity gate (PRD S7). @cremator/core must not import any harness, filesystem,
// or network module. Only the ledger may touch node:sqlite and node:fs, and only
// util/hash.ts may touch node:crypto.
//
// Import extraction is done by `es-module-lexer` (a real module lexer), not by
// regexes: regexes silently missed side-effect imports (`import "node:fs";`) and
// dynamic imports with a template literal (`` await import(`node:fs`) ``), so the
// gate failed open on both. See issue-tracker/open/ISSUE-071-*.

import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, posix, relative, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_SRC = join(ROOT, 'packages', 'core', 'src');

// Builtins allowed anywhere in core.
const ALWAYS_ALLOWED = new Set(['node:crypto', 'crypto']);

// Builtins allowed only under these source directories (relative, forward slashes).
const SCOPED_ALLOWED = new Map([
  ['ledger/', new Set(['node:sqlite', 'node:fs', 'node:fs/promises', 'node:path', 'node:os'])],
]);

// Harness and network modules that must never appear in core.
const FORBIDDEN = [
  /^@deepseek-ai\//,
  /^dsh(-|$)/,
  /^@racoons\/adapter/,
  /^cremator-dsh$/,
  /^node:http/,
  /^node:https/,
  /^node:net/,
  /^node:tls/,
  /^node:dgram/,
  /^node:child_process/,
  /^undici$/,
  /^axios$/,
  /^openai$/,
  /^@anthropic/,
  /^(node:)?worker_threads$/,
];

// CommonJS `require(...)` is outside the lexer's job; core is ESM, so this stays as
// a backstop for a stray require.
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

await init();

/**
 * Extracts every module specifier a source text loads.
 *
 * The lexer reports static imports (side-effect, `from`, `export ... from`,
 * `import x = require()`), dynamic imports with a literal or template-literal
 * argument, and TS type-only imports. A dynamic import whose argument is not
 * statically known carries no specifier; those are counted in `unverifiable` so
 * the caller can fail closed rather than let them through.
 *
 * @param {string} source
 * @returns {{ specs: string[], unverifiable: number }}
 */
export function specifiers(source) {
  // A leading BOM makes the lexer treat the first import as text and skip it. Both
  // the lexer and the require backstop read this one string, so their offsets agree:
  // with the BOM kept on one side, `import x = require(...)` counted twice (ISSUE-593).
  const text = source.replace(/^\uFEFF/, '');
  const [imports] = parse(text);
  const specs = [];
  // Offsets of every specifier the lexer read, so the require backstop can tell an
  // `import x = require("y")` (already read) from a real CommonJS call.
  const covered = new Set();
  let unverifiable = 0;
  for (const entry of imports) {
    if (entry.type === 'import-meta') continue;
    if (typeof entry.specifier !== 'string') {
      unverifiable += 1;
      continue;
    }
    covered.add(entry.start);
    specs.push(entry.specifier);
  }

  // Two identical imports are two imports: no dedupe by text, exactly as before.
  REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_RE.exec(text)) !== null) {
    const specStart = m.index + m[0].indexOf(m[1]);
    if (covered.has(specStart)) continue;
    specs.push(m[1]);
  }

  return { specs, unverifiable };
}

/**
 * True when a relative specifier, resolved from the file at relToCore, names a path
 * outside the scanned tree. No filesystem lookup: a relative import that climbs out
 * of the tree is a violation whether or not its target exists (ISSUE-593).
 *
 * @param {string} relToCore path relative to the scanned root, forward slashes
 * @param {string} spec
 */
function leavesRoot(relToCore, spec) {
  const target = posix.normalize(posix.join(posix.dirname(relToCore), spec));
  return target === '..' || target.startsWith('../');
}

/**
 * Judges one file's source against the purity rules.
 *
 * @param {string} relToCore path relative to packages/core/src, forward slashes
 * @param {string} source
 * @returns {string[]} violation lines, empty when the file is clean
 */
export function judge(relToCore, source) {
  const out = [];
  let scanned;
  try {
    scanned = specifiers(source);
  } catch (error) {
    out.push(`${relToCore}: cannot parse for import extraction (${error.message}); cannot verify`);
    return out;
  }

  if (scanned.unverifiable > 0) {
    out.push(`${relToCore}: dynamic import with a non-literal specifier cannot be verified`);
  }

  for (const spec of scanned.specs) {
    // A relative specifier used to be skipped outright, so a core file importing the
    // harness through ../../../ passed as clean (ISSUE-593).
    if (spec.startsWith('.')) {
      if (leavesRoot(relToCore, spec)) {
        out.push(`${relToCore}: relative import "${spec}" leaves packages/core/src`);
      }
      continue;
    }

    const forbidden = FORBIDDEN.find((re) => re.test(spec));
    if (forbidden) {
      out.push(`${relToCore}: forbidden import "${spec}"`);
      continue;
    }

    if (ALWAYS_ALLOWED.has(spec)) continue;

    const scope = [...SCOPED_ALLOWED.entries()].find(([prefix]) => relToCore.startsWith(prefix));
    if (scope && scope[1].has(spec)) continue;

    if (spec.startsWith('node:')) {
      out.push(`${relToCore}: builtin "${spec}" not allowed at this path`);
    } else {
      out.push(`${relToCore}: bare package import "${spec}" not allowed in core`);
    }
  }
  return out;
}

async function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

export async function scan(dir = CORE_SRC) {
  const files = await collect(dir);
  if (files.length === 0) {
    console.error('purity: no source files found under packages/core/src. Cannot verify.');
    return null;
  }

  const violations = [];
  for (const file of files) {
    const relToCore = relative(dir, file).split(sep).join('/');
    violations.push(...judge(relToCore, await readFile(file, 'utf8')));
  }
  return { count: files.length, violations };
}

// Only the CLI invocation scans and exits; importing this module (the self-test)
// gets `specifiers`/`judge` without side effects. An optional path argument exists
// so the self-test can run the real gate over a fixture tree; the default is core.
// A junction or symlink leaves argv[1] spelled differently from the real path Node
// reports in import.meta.url, so both sides are compared after realpathSync: a
// spelling mismatch must not end the process with status 0 and no scan (ISSUE-593).
const SELF = fileURLToPath(import.meta.url);
function isSelf(argvPath) {
  if (argvPath === undefined) return false;
  try {
    return realpathSync(argvPath) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isSelf(process.argv[1])) {
  const result = await scan(process.argv[2] ?? CORE_SRC);
  if (result === null) process.exit(1);

  if (result.violations.length > 0) {
    console.error(`purity: ${result.violations.length} violation(s)\n`);
    for (const v of result.violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`purity: ${result.count} core files clean`);
}
