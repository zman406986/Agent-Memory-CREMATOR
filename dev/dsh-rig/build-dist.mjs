#!/usr/bin/env node
/**
 * Compile the workspace TypeScript the rig plugin imports into a throwaway tree.
 *
 * Why this exists: a dsh child process is plain Node. It does not strip types and
 * does not know the repo's `@cremator/core` path alias, so `rig-plugin.mjs` cannot
 * import the workspace TypeScript sources directly. This helper runs the repo's own `tsc`
 * against `tsconfig.rig-dist.json` and emits both sources into
 * `scratchpad/dsh-rig/dist/` (gitignored), then writes the one shim Node needs to
 * resolve the bare `@cremator/core` specifier from that tree.
 *
 * Committed: this file and `tsconfig.rig-dist.json`. Never committed: the output.
 *
 * Usage:
 *   node dev/dsh-rig/build-dist.mjs            # build when stale, then print the path
 *   node dev/dsh-rig/build-dist.mjs --force    # rebuild unconditionally
 *   node dev/dsh-rig/build-dist.mjs --check    # exit 0 when the dist tree is current
 *
 * Exported: `ensureDist(options)` is what `run.mjs` and the plugin tests call.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

/** The two switches this script takes when run as a command. */
const BUILD_DIST_OPTIONS = optionsOf([
  ['--force', 'boolean'],
  ['--check', 'boolean'],
]);

const RIG_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(dirname(RIG_DIR));
export const DIST_DIR = join(REPO_ROOT, 'scratchpad', 'dsh-rig', 'dist');
const TSCONFIG = join(RIG_DIR, 'tsconfig.rig-dist.json');
const STAMP = join(DIST_DIR, '.stamp');
const SOURCE_ROOTS = [
  join(REPO_ROOT, 'packages', 'core', 'src'),
  join(REPO_ROOT, 'packages', 'adapters', 'dsh', 'src'),
];
/** Relative paths inside the dist tree the plugin imports by name. */
const SHIMS = [
  { name: '@cremator/core', target: 'packages/core/src/index.js' },
  { name: 'cremator-dsh', target: 'packages/adapters/dsh/src/index.js' },
];

function listTypeScript(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTypeScript(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A content stamp over every input the emit depends on, so a second scenario run
 * reuses the tree instead of paying for another `tsc`.
 * @returns {string} hex digest
 */
export function sourceStamp() {
  const hash = createHash('sha256');
  hash.update(readFileSync(TSCONFIG));
  const files = SOURCE_ROOTS.flatMap((root) => listTypeScript(root)).sort();
  for (const file of files) {
    hash.update(relative(REPO_ROOT, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Resolve the repo's own `tsc` entry, refusing to guess when it is absent. */
function resolveTsc() {
  const local = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(local)) return { command: process.execPath, args: [local] };
  const localCmd = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(`${localCmd}.cmd`)) return { command: `${localCmd}.cmd`, args: [] };
  throw new Error(`build-dist: no local tsc under ${join(REPO_ROOT, 'node_modules', 'typescript')}; run npm install`);
}

/**
 * Write the `node_modules` shims that let emitted adapter code resolve its bare
 * `@cremator/core` import from inside the dist tree. Each shim re-exports the real
 * emitted entry, so there is exactly one module instance per package.
 */
function writeShims() {
  const modules = join(DIST_DIR, 'node_modules');
  for (const shim of SHIMS) {
    const pkgDir = join(modules, ...shim.name.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    const depth = relative(pkgDir, DIST_DIR).split(sep).join('/');
    const target = `${depth}/${shim.target}`;
    writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({
      name: shim.name,
      private: true,
      type: 'module',
      exports: { '.': './index.js' },
    }, null, 2)}\n`);
    writeFileSync(join(pkgDir, 'index.js'), `export * from ${JSON.stringify(target)};\n`);
  }
}

/**
 * Build the dist tree when it is missing or stale.
 * @param {{force?: boolean, quiet?: boolean}} [options]
 * @returns {{dir: string, rebuilt: boolean, stamp: string}}
 */
export function ensureDist(options = {}) {
  const force = options.force === true;
  const quiet = options.quiet === true;
  const stamp = sourceStamp();
  const current = existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === stamp
    && SHIMS.every((shim) => existsSync(join(DIST_DIR, 'node_modules', ...shim.name.split('/'), 'index.js')))
    && SHIMS.every((shim) => existsSync(join(DIST_DIR, ...shim.target.split('/'))));
  if (current && !force) return { dir: DIST_DIR, rebuilt: false, stamp };
  mkdirSync(DIST_DIR, { recursive: true });
  const tsc = resolveTsc();
  const run = spawnSync(tsc.command, [...tsc.args, '-p', TSCONFIG], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
  });
  if (run.status !== 0) {
    const detail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    throw new Error(`build-dist: tsc failed (exit ${String(run.status)})\n${detail}`);
  }
  writeShims();
  writeFileSync(STAMP, `${stamp}\n`);
  if (!quiet) process.stdout.write(`build-dist: emitted ${DIST_DIR}\n`);
  return { dir: DIST_DIR, rebuilt: true, stamp };
}

/** The file URL a `--patch` row must name for the mount plugin. */
export function pluginFileUrl() {
  return pathToFileURL(join(RIG_DIR, 'rig-plugin.mjs')).href;
}

/** Import the emitted core and adapter, as the plugin does at apply time. */
export async function importRuntime(distDir = DIST_DIR) {
  const core = await import(pathToFileURL(join(distDir, 'packages', 'core', 'src', 'index.js')).href);
  const adapter = await import(pathToFileURL(join(distDir, 'packages', 'adapters', 'dsh', 'src', 'index.js')).href);
  return { ...core, ...adapter };
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: flags } = parseDevArgs(process.argv.slice(2), {
    options: BUILD_DIST_OPTIONS,
    refuse: (message) => {
      process.stderr.write(`build-dist: ${message}\n`);
      process.exit(2);
    },
    help: 'usage: node dev/dsh-rig/build-dist.mjs [--force] [--check]\n',
  });
  try {
    const result = ensureDist({ force: flags.force ?? false });
    if (flags.check ?? false) {
      process.stdout.write(result.rebuilt
        ? `build-dist: rebuilt ${result.dir}\n` : `build-dist: current ${result.dir}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
