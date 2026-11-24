#!/usr/bin/env node
// Runs the workspace test suites with the built-in node:test runner.
// `--experimental-strip-types` plus the `.js` -> `.ts` resolve hook lets Node run
// TypeScript sources directly: no build step, no transpiler dependency.
// Test files are discovered under the workspace packages named in the root manifest
// and passed explicitly. Without a path list the runner walks the whole cwd, which
// also picks up gitignored trees such as `scratchpad/` — tests that are not this repo's.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// --import needs a URL, not a Windows path with a drive letter.
const HOOK = pathToFileURL(join(ROOT, 'scripts', 'ts-resolve-hooks.mjs')).href;

// Expands one workspace glob to package directories. Only a trailing `*` segment is
// supported; that is the shape the root manifest uses (`packages/*`, `packages/adapters/*`).
async function expand(pattern) {
  const segments = pattern.split('/');
  const star = segments.indexOf('*');
  if (star === -1) return [join(ROOT, ...segments)];
  const base = join(ROOT, ...segments.slice(0, star));
  const entries = await readdir(base, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name, ...segments.slice(star + 1)));
  // A workspace is a directory holding its own manifest; anything else is not a package.
  const packages = [];
  for (const dir of candidates) {
    try {
      await access(join(dir, 'package.json'));
      packages.push(dir);
    } catch {
      // Not a workspace package.
    }
  }
  return packages;
}

// Exported for scripts/run-tests.test.mjs, which proves the recursion keeps the
// extension list: a nested directory is scanned for the same extensions as its
// parent (ISSUE-263).
export async function collectTests(dir, extensions = ['.test.ts']) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A workspace package may ship no test directory; that is not a failure.
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectTests(full, extensions)));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

export async function discoverTests() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const packages = (await Promise.all((manifest.workspaces ?? []).map(expand))).flat();

  // Counted per package, not once in total: a package whose `test/` directory was
  // renamed (or whose suites all moved off the extension list) contributes nothing,
  // and a combined list of other packages' files still looked healthy (ISSUE-593).
  const files = [];
  const withoutTests = [];
  for (const dir of packages) {
    const found = await collectTests(join(dir, 'test'));
    if (found.length === 0) withoutTests.push(relative(ROOT, dir).split(sep).join('/'));
    files.push(...found);
  }
  if (withoutTests.length > 0) {
    throw new Error(
      `test runner: no test files under ${withoutTests.join(', ')}. Cannot verify ` +
      `${withoutTests.length === 1 ? 'that package' : 'those packages'}.`,
    );
  }
  // The opencode bench lives outside the workspace packages. Its tests are part of
  // the default run, not only `npm run test:dev` (ISSUE-214 P4). The extension
  // list reaches every nested directory, so `dev/bench/multiturn/` and
  // `dev/bench/fixtures/sim/` are discovered too (ISSUE-263).
  files.push(...(await collectTests(join(ROOT, 'dev', 'bench'), ['.test.mjs'])));
  // The dsh rig also lives outside the workspace packages. Its `run-env` test
  // pins the child-environment allow-list and was reachable only through
  // `npm run test:dev` (ISSUE-260); the full runner must see it too.
  files.push(...(await collectTests(join(ROOT, 'dev', 'dsh-rig'), ['.test.mjs'])));
  // Repo-level checks that live in `scripts/`: the runner's own discovery gate
  // (ISSUE-263) and the publish-metadata/Node-range test (ISSUE-271). `scripts/`
  // is not a workspace and is not walked, so both are named here.
  files.push(join(ROOT, 'scripts', 'run-tests.test.mjs'));
  files.push(join(ROOT, 'scripts', 'package-metadata.test.mjs'));
  files.sort();
  return files;
}

export function runTests(files, { stdio = 'inherit' } = {}) {
  // When this module is imported from a `node --test` process (the discovery
  // test), the inherited NODE_TEST_CONTEXT would make the child behave as a
  // test-runner worker instead of a fresh grouped run. Strip it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--import', HOOK, '--test', ...files],
      { cwd: ROOT, stdio, env },
    );

    child.on('error', (error) => {
      console.error(`test runner could not start: ${error.message}`);
      resolveRun(1);
    });

    child.on('exit', (code, signal) => {
      if (signal !== null) {
        console.error(`test runner killed by ${signal}`);
        resolveRun(1);
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

async function main() {
  let files;
  try {
    files = await discoverTests();
  } catch (error) {
    // Discovery that cannot see a package is a failed run, not a shorter one.
    console.error(error.message);
    process.exit(1);
  }

  // Fail closed: an empty list makes `--test` fall back to the whole-tree walk this
  // script exists to avoid, and reports a vacuous pass.
  if (files.length === 0) {
    console.error('test runner: no test files found under the workspace packages. Cannot verify.');
    process.exit(1);
  }

  // `--list` prints the discovery result and exits without running tests. It is
  // what the discovery test reads, so the check exercises this entry point.
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'));
    return;
  }

  process.exit(await runTests(files));
}

// A junction or symlink leaves argv[1] spelled differently from the real path Node
// reports in import.meta.url. Comparing the spelling let `main` never run and the
// process exit 0 with zero tests, so both sides go through realpathSync (ISSUE-593).
const SELF = fileURLToPath(import.meta.url);
function isSelf(argvPath) {
  if (argvPath === undefined) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isSelf(process.argv[1])) await main();
