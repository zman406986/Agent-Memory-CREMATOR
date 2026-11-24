#!/usr/bin/env node
/**
 * Build the SWE bench worlds: staging clones, per-task venvs, prep-staged arms,
 * pre-run snapshots, staged-bytes validation, the task pack, and brief input.
 *
 * Usage: node dev/bench/swe-prep.mjs --bench <lite|rebench|compounded>
 *   --tasks <validated.json> --dataset <parquet|dir|rows.json>[,…]
 *   --staging-root <dir> --venv-root <dir> --bench-root <dir>
 *   [--count N] [--dry-run] [--smoke <instance_id>]
 *
 * Layers: 1 clone <staging-root>/<bench>/<repo__dirname>/ at base_commit,
 * reused from a whole scratchpad/swe-select/work/repos/<short> clone; 2 venv
 * <venv-root>/<instance_id>/venv with deps only, never the repo (the staged
 * tree is imported through PYTHONPATH); 3 src <staging-root>/<bench>/src/swe/
 * <instance_id>/ holding only the base tree, no .git; 4 prep.mjs writes both
 * arms from that src (compounded: Aetherium-Bastion plus both benches' swe/
 * trees as compounded-src); 5 snapshot.json hashes every file under
 * racoons-arm/swe/<instance_id>, and the same bytes go to vanilla-arm; 6
 * validation on a throwaway copy: test_patch + gold + the intact F2P ids must
 * pass or the task is discarded and prep/snapshot/validation re-run without
 * it; 7 task-pack.json (no gold, no issue text); 8 brief-input.json (fences
 * rewritten to a 4-space indent, verbatim-issue sha256 for lineage).
 *
 * --dry-run prints the plan and writes nothing outside the OS temp dir.
 * --smoke <instance_id> runs every layer for one task with all paths under
 * scratchpad/swe-prep-smoke/. Plain Node >= 22, no dependencies.
 * Exit 0 = every task validated and both arms snapshotted; 1 = an arm or
 * infrastructure check failed; 2 = bad arguments or a refused step.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PREP = join(HERE, 'prep.mjs');
const SELECTOR_WORK = join(REPO_ROOT, 'scratchpad', 'swe-select', 'work');
const SELECTOR_PY = join(REPO_ROOT, 'scratchpad', 'swe-select', '.venv', 'Scripts', 'python.exe');
const HELPER_DIR = join(REPO_ROOT, 'scratchpad', 'swe-prep-helpers');
const SMOKE_ROOT = join(REPO_ROOT, 'scratchpad', 'swe-prep-smoke');
const BASTION = 'C:/Users/TZhen/Desktop/Aetherium-Bastion';
const DEFAULT_PY = '3.12';
const VALIDATE_TIMEOUT_MS = 600_000;
/** validated.json's dataset tag per bench's own staging dir. */
const BENCH_SOURCES = {
  lite: ['live-lite'],
  rebench: ['rebench'],
  compounded: ['live-lite', 'rebench'],
};
/** Dataset tag -> the bench dir its clones/src trees live under. */
const TAG_DIR = { 'live-lite': 'lite', rebench: 'rebench' };

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const PREP_OPTIONS = optionsOf([
  ['--bench', 'string'],
  ['--tasks', 'string'],
  ['--dataset', 'string'],
  ['--staging-root', 'string'],
  ['--venv-root', 'string'],
  ['--bench-root', 'string'],
  ['--count', 'string'],
  ['--dry-run', 'boolean', 'dryRun'],
  ['--smoke', 'string'],
  ['--helper-python', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: PREP_OPTIONS,
    refuse: fail,
    help: 'usage: swe-prep.mjs --bench <lite|rebench|compounded> --tasks <validated.json> '
      + '--dataset <parquet|dir|rows.json>[,…] --staging-root <dir> --venv-root <dir> '
      + '--bench-root <dir> [--count N] [--dry-run] [--smoke <instance_id>]\n',
  });
  const bench = values.bench ?? 'lite';
  if (BENCH_SOURCES[bench] === undefined) fail(`swe-prep.mjs: --bench must be one of ${Object.keys(BENCH_SOURCES).join(', ')}`);
  if (!values.tasks) fail('swe-prep.mjs: --tasks <validated.json> is required');
  if (!values.dataset) fail('swe-prep.mjs: --dataset <parquet|dir|rows.json> is required');
  const opts = {
    bench,
    tasks: resolve(values.tasks),
    dataset: values.dataset,
    stagingRoot: values.stagingRoot === undefined ? null : resolve(values.stagingRoot),
    venvRoot: values.venvRoot === undefined ? null : resolve(values.venvRoot),
    benchRoot: values.benchRoot === undefined ? null : resolve(values.benchRoot),
    count: values.count === undefined ? null : Number.parseInt(values.count, 10),
    dryRun: values.dryRun ?? false,
    smoke: values.smoke ?? null,
    helperPython: resolve(values.helperPython ?? SELECTOR_PY),
  };
  if (opts.count !== null && !(Number.isInteger(opts.count) && opts.count > 0)) fail('swe-prep.mjs: --count must be a positive integer');
  if (opts.smoke !== null) {
    // The smoke proof never touches the real bench roots.
    const benchDir = `2026-11-16-${bench}`;
    opts.stagingRoot = join(SMOKE_ROOT, 'staging');
    opts.venvRoot = join(SMOKE_ROOT, 'venvs');
    opts.benchRoot = join(SMOKE_ROOT, benchDir);
    opts.count = null;
  }
  for (const key of ['stagingRoot', 'venvRoot', 'benchRoot']) {
    if (opts[key] === null) fail(`swe-prep.mjs: --${key.replace(/[A-Z]/gu, (ch) => `-${ch.toLowerCase()}`)} <dir> is required`);
  }
  return opts;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, extra = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...extra });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

function runOrFail(label, command, args, extra = {}) {
  const res = run(command, args, extra);
  if (res.status !== 0) {
    fail(`swe-prep.mjs: ${label} failed (${command} ${args.join(' ')})\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));
const repoDirname = (repo) => repo.replaceAll('/', '__');
const posix = (root, full) => relative(root, full).split('\\').join('/');

/** Every file under dir, as sorted posix relative paths. */
function walkFiles(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, root, out);
    else if (entry.isFile()) out.push(posix(root, full));
  }
  return out.sort();
}

/** Copy a tree, optionally leaving the top-level `.git` out. */
function copyTree(from, to, { keepGit }) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (path) => keepGit || basename(path) !== '.git',
  });
}

/** One multiset line list, the same identity proof prep.mjs prints. */
function multiset(dir) {
  return walkFiles(dir).map((rel) => `${sha256File(join(dir, rel))}  ${rel}`).sort().join('\n');
}

/** Selector output, keyed by instance_id: its short clone name, its python, its plan row. */
function selectorIndex() {
  const clones = new Map();
  const results = join(SELECTOR_WORK, 'results');
  if (existsSync(results)) {
    for (const name of readdirSync(results)) {
      if (!name.endsWith('.json')) continue;
      let record;
      try { record = readJson(join(results, name)); } catch { continue; }
      if (!record?.instance_id) continue;
      const actual = String(record.python_actual ?? '').match(/^(\d+\.\d+)/u);
      clones.set(record.instance_id, { short: record.short ?? null, python: actual?.[1] ?? null });
    }
  }
  let plan = new Map();
  const planPath = join(SELECTOR_WORK, 'plan.json');
  try { plan = new Map(readJson(planPath).map((entry) => [entry.instance_id, entry])); } catch { /* absent */ }
  return { clones, plan };
}

/** Load dataset rows for just the ids we need. Parquet goes through a helper. */
function loadRows(opts, ids) {
  if (/\.json$/iu.test(opts.dataset)) {
    const data = readJson(resolve(opts.dataset));
    const rows = Array.isArray(data) ? data : data.rows;
    if (!Array.isArray(rows)) fail(`swe-prep.mjs: ${opts.dataset} is not a rows array`);
    return new Map(rows.map((row) => [row.instance_id, row]));
  }
  const helper = join(HELPER_DIR, 'extract_rows.py');
  if (!existsSync(helper)) fail(`swe-prep.mjs: parquet helper missing at ${helper}`);
  if (!existsSync(opts.helperPython)) fail(`swe-prep.mjs: helper python missing at ${opts.helperPython}`);
  const box = mkdtempSync(join(tmpdir(), 'swe-prep-rows-'));
  const out = join(box, 'rows.json');
  const idsFile = join(box, 'ids.txt');
  writeFileSync(idsFile, `${ids.join('\n')}\n`);
  const sources = opts.dataset.split(',').map((part) => resolve(part.trim()));
  const res = run(opts.helperPython, ['-I', helper, out, idsFile, ...sources]);
  if (res.status !== 0) fail(`swe-prep.mjs: parquet read failed\n${(res.stderr || res.stdout).trim()}`);
  let report = {};
  try { report = JSON.parse(res.stdout.trim().split('\n').at(-1)); } catch { /* keep going */ }
  if (Array.isArray(report.missing) && report.missing.length > 0) {
    say(`dataset: ${report.missing.length} task(s) absent from the parquet: ${report.missing.join(', ')}`);
  }
  const rows = readJson(out);
  return new Map(rows.map((row) => [row.instance_id, row]));
}

/** Only VALIDATED tasks for this bench: lite reads live-lite, compounded reads both. */
function validatedEntries(all, bench) {
  const wanted = new Set(BENCH_SOURCES[bench]);
  return all.filter((entry) => wanted.has(entry.dataset) && /^VALIDATED/u.test(String(entry.verdict ?? '')));
}

/** The task list: validated survivors for this bench, capped by --count. */
function buildTasks(opts, rows, selector, entries) {
  const validated = entries;
  const capped = opts.count === null ? validated : validated.slice(0, opts.count);
  if (opts.count !== null && validated.length > capped.length) {
    say(`count cap: ${capped.length} of ${validated.length} validated ${opts.bench} task(s)`);
  }
  const tasks = [];
  for (const entry of capped) {
    const row = rows.get(entry.instance_id);
    if (row === undefined) {
      say(`skip: ${entry.instance_id} has no dataset row (cannot stage a world without test_patch)`);
      continue;
    }
    const planEntry = selector.plan.get(entry.instance_id);
    const f2p = (Array.isArray(entry.f2p) ? entry.f2p : null) ?? planEntry?.f2p ?? row.FAIL_TO_PASS ?? [];
    const python = entry.python ?? row.install_config?.python
      ?? selector.clones.get(entry.instance_id)?.python ?? DEFAULT_PY;
    tasks.push({
      instanceId: entry.instance_id,
      datasetTag: entry.dataset,
      repo: row.repo ?? entry.repo,
      baseCommit: row.base_commit ?? entry.base_commit,
      f2p: [...f2p],
      p2p: [...(row.PASS_TO_PASS ?? [])],
      testPatch: row.test_patch ?? '',
      goldPatch: row.patch ?? '',
      issue: row.problem_statement ?? '',
      row,
      entryDeps: entry.deps ?? null,
      python: String(python).match(/^(\d+\.\d+)/u)?.[1] ?? DEFAULT_PY,
      discard: null,
    });
  }
  if (tasks.length === 0) fail(`swe-prep.mjs: no validated ${opts.bench} task with a dataset row to stage`);
  return tasks;
}

/** One PEP 508-style requirement line; anything else is not a dependency. */
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]*\])?(?:\s*[<>=!~]=?\s*[0-9A-Za-z.*+_-]+)?(?:\s*;\s*[^:]+)?$/u;

/** Keep only installable package specs; never the repo itself. */
function cleanDeps(list) {
  const kept = [];
  const dropped = [];
  for (const raw of list) {
    const line = String(raw ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    // `-e <repo>`, `-r reqs`, `git+…`, `file://…`, and uv chatter: an editable
    // or self install, or a line that is not a requirement. The task repo is
    // imported through PYTHONPATH instead.
    if (!REQUIREMENT.test(line)) {
      dropped.push(line);
      continue;
    }
    kept.push(line);
  }
  return { kept: [...new Set(kept)], dropped };
}

/** The task's dependency list, deps-only, per bench. */
function resolveDeps(task, cloneDir) {
  const list = [];
  const install = task.row.install_config ?? {};
  if (task.datasetTag === 'rebench') {
    list.push(...String(task.row.requirements ?? '').split(/\r?\n/u));
    for (const entry of install.pip_packages ?? []) list.push(...String(entry).split(/\s+/u));
    // Fall back to the requirement files the dataset named, read from the tree.
    if (list.filter((line) => String(line).trim() !== '').length === 0) {
      for (const rel of install.reqs_path ?? []) {
        const path = join(cloneDir, ...String(rel).split('/'));
        if (existsSync(path)) list.push(...readFileSync(path, 'utf8').split(/\r?\n/u));
      }
    }
  } else {
    list.push(...(Array.isArray(task.entryDeps) ? task.entryDeps : []));
  }
  const cleaned = cleanDeps(list);
  task.deps = cleaned.kept;
  task.depsDropped = cleaned.dropped;
}

/**
 * The staging clone's working tree holds the committed bytes, not this device's
 * `core.autocrlf` conversion: the dataset's test_patch/gold patch are the bytes
 * the tree must match, and Git for Windows defaults autocrlf to true.
 */
const GIT_OPTS = ['-c', 'core.autocrlf=false'];

function git(dir, args) {
  return run('git', ['-C', dir, ...GIT_OPTS, ...args]);
}

/** A clone is reusable only when its history is complete. */
function cloneComplete(dir) {
  return existsSync(join(dir, '.git', 'HEAD')) && existsSync(join(dir, '.git', 'objects'));
}

/** Layer 1: a staging clone AT base_commit, reused from the selector when whole. */
function stageClone(task, opts, selector) {
  const dir = join(opts.stagingRoot, TAG_DIR[task.datasetTag], repoDirname(task.repo));
  task.cloneDir = dir;
  if (cloneComplete(dir)) {
    task.cloneAction = 'present';
  } else {
    const short = selector.clones.get(task.instanceId)?.short;
    const reuse = short === null || short === undefined ? null : join(SELECTOR_WORK, 'repos', short);
    if (reuse !== null && cloneComplete(reuse)) {
      copyTree(reuse, dir, { keepGit: true });
      task.cloneAction = `reused ${reuse}`;
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      const url = task.row.clone_url ?? `https://github.com/${task.repo}.git`;
      const args = url.startsWith('https://') && task.row.clone_url === undefined
        ? ['clone', '--filter=blob:none', url, dir]
        : ['clone', url, dir];
      runOrFail(`clone ${task.repo}`, 'git', [...GIT_OPTS, ...args]);
      task.cloneAction = `clone ${url}`;
    }
  }
  // The copy must BE the base tree, whatever the source checkout held. A blob
  // filter clone fetches the commit's blobs on demand; a reused selector clone
  // already has the history, and fetches only if this commit is unknown.
  const checkout = git(dir, ['checkout', '--quiet', '--force', task.baseCommit]);
  if (checkout.status !== 0) {
    git(dir, ['fetch', '--quiet', 'origin', task.baseCommit]);
    const retry = git(dir, ['checkout', '--quiet', '--force', task.baseCommit]);
    if (retry.status !== 0) {
      fail(`swe-prep.mjs: ${task.instanceId}: cannot check out ${task.baseCommit} in ${dir}\n${retry.stderr.trim()}`);
    }
  }
  git(dir, ['reset', '--quiet', '--hard', task.baseCommit]);
  git(dir, ['clean', '--quiet', '-xffd']);
  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== task.baseCommit) fail(`swe-prep.mjs: ${task.instanceId}: clone HEAD ${head} != base ${task.baseCommit}`);
}

/** `py -<ver>` exists? Returns the launcher command or null. */
function pythonLauncher(version) {
  if (run('py', ['-0p']).status !== 0) return null;
  return run('py', [`-${version}`, '-c', 'import sys']).status === 0 ? 'py' : null;
}

function venvPython(venv) {
  const scripts = join(venv, 'Scripts', 'python.exe');
  return existsSync(scripts) ? scripts : join(venv, 'bin', 'python');
}

/** Layer 2: the task venv with its deps, never the repo. */
function stageVenv(task, opts) {
  const dir = join(opts.venvRoot, task.instanceId);
  const venv = join(dir, 'venv');
  const python = venvPython(venv);
  if (existsSync(python)) {
    const probe = run(python, ['-c', 'import platform;print(platform.python_version())']);
    task.pythonActual = probe.status === 0 ? probe.stdout.trim() : 'unknown';
    task.venv = venv;
    resolveDeps(task, task.cloneDir); // the pack still names the deps the venv holds
    say(`  venv     present ${task.pythonActual}`);
    return;
  }
  const launcher = pythonLauncher(task.python);
  let version = task.python;
  let usable = launcher;
  if (usable === null) {
    // The task's interpreter is not on this device: use the default and record
    // the substitution in the pack, rather than silently pretending.
    usable = pythonLauncher(DEFAULT_PY);
    version = DEFAULT_PY;
    task.pythonNote = `py -${task.python} absent; substituted ${DEFAULT_PY}`;
    say(`  note     ${task.pythonNote}`);
  }
  if (usable === null) fail(`swe-prep.mjs: ${task.instanceId}: no py launcher for ${task.python} or ${DEFAULT_PY}`);
  mkdirSync(dir, { recursive: true });
  runOrFail(`venv ${task.instanceId}`, usable, [`-${version}`, '-m', 'venv', venv]);
  resolveDeps(task, task.cloneDir);
  const depsFile = join(dir, 'deps.txt');
  writeFileSync(depsFile, task.deps.length === 0 ? '' : `${task.deps.join('\n')}\n`);
  if (task.deps.length > 0) {
    runOrFail(`pip install ${task.instanceId}`, venvPython(venv),
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', depsFile]);
  }
  task.pythonActual = run(venvPython(venv), ['-c', 'import platform;print(platform.python_version())']).stdout.trim();
  task.venv = venv;
  say(`  venv     created ${task.pythonActual}, ${task.deps.length} dep(s)`
    + `${task.depsDropped.length > 0 ? `, dropped ${task.depsDropped.length} non-deps line(s)` : ''}`);
}

/** Layer 3: the base tree's committed bytes, no .git, where prep.mjs expects swe/<instance_id>/. */
function stageSrcTree(task, opts) {
  const dest = join(opts.stagingRoot, TAG_DIR[task.datasetTag], 'src', 'swe', task.instanceId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // `git archive` exports the committed blobs; a working-tree copy would carry
  // this device's line-ending conversion (autocrlf) into the arm. tar is run
  // with a relative archive name: a `C:` path reads as a remote host to tar.
  const tarball = join(dirname(dest), `${task.instanceId}.tar`);
  const archive = git(task.cloneDir, ['archive', '--format=tar', task.baseCommit, '-o', tarball]);
  if (archive.status !== 0) {
    say(`  src      archive unavailable (${archive.stderr.trim().split(/\r?\n/u)[0]}); copying the tree`);
    copyTree(task.cloneDir, dest, { keepGit: false });
  } else {
    runOrFail(`extract ${task.instanceId}`, 'tar', ['-xf', `../${task.instanceId}.tar`], { cwd: dest });
    rmSync(tarball, { force: true });
  }
  task.srcDir = dest;
}

function prepCommand(src, root) {
  return [process.execPath, PREP, '--force', '--src', src, '--root', root, '--no-sibling'];
}

function compoundedSrc(opts, tasks, { overlayOnly }) {
  const dest = join(opts.stagingRoot, 'compounded-src');
  if (!overlayOnly) {
    copyTree(BASTION, dest, { keepGit: false });
    say(`compounded-src: ${walkFiles(dest).length} file(s) from ${BASTION}`);
  }
  rmSync(join(dest, 'swe'), { recursive: true, force: true });
  mkdirSync(join(dest, 'swe'), { recursive: true });
  for (const task of tasks) {
    const from = join(opts.stagingRoot, TAG_DIR[task.datasetTag], 'src', 'swe', task.instanceId);
    cpSync(from, join(dest, 'swe', task.instanceId), { recursive: true });
  }
  return dest;
}

/** Layer 4: prep.mjs writes both arms. A stale snapshot is removed first. */
function stageArms(opts, tasks, { reoverlay }) {
  rmSync(join(opts.benchRoot, 'snapshot.json'), { force: true });
  let src;
  if (opts.bench === 'compounded') src = compoundedSrc(opts, tasks, { overlayOnly: reoverlay });
  else src = join(opts.stagingRoot, TAG_DIR[BENCH_SOURCES[opts.bench][0]], 'src');
  const [command, ...args] = prepCommand(src, opts.benchRoot);
  const res = run(command, args);
  say(res.stdout.trimEnd());
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    fail(`swe-prep.mjs: prep.mjs failed for ${opts.bench}`);
  }
  const pass = /IDENTITY PASS/u.test(res.stdout);
  if (!pass) fail(`swe-prep.mjs: prep.mjs reported no IDENTITY PASS for ${opts.bench}`);
  return src;
}

/** Layer 5: per-task file hashes of the racoons arm, written for both arms. */
function writeSnapshot(opts, tasks) {
  const racoons = join(opts.benchRoot, 'racoons-arm', 'swe');
  const vanilla = join(opts.benchRoot, 'vanilla-arm', 'swe');
  const entries = [];
  for (const task of tasks) {
    const left = join(racoons, task.instanceId);
    const right = join(vanilla, task.instanceId);
    if (!existsSync(left) || !existsSync(right)) {
      fail(`swe-prep.mjs: ${task.instanceId} missing from an arm after prep (${left} / ${right})`);
    }
    if (multiset(left) !== multiset(right)) {
      fail(`swe-prep.mjs: the arms differ for ${task.instanceId}: not byte-identical`);
    }
    const files = {};
    for (const rel of walkFiles(left)) files[rel] = sha256File(join(left, rel));
    entries.push({ instance_id: task.instanceId, files });
    say(`  snapshot ${task.instanceId}: ${Object.keys(files).length} file(s)`);
  }
  const body = `${JSON.stringify(entries, null, 2)}\n`;
  writeFileSync(join(opts.benchRoot, 'snapshot.json'), body);
  writeFileSync(join(opts.benchRoot, 'vanilla-arm', 'snapshot.json'), body);
  const back = readFileSync(join(opts.benchRoot, 'vanilla-arm', 'snapshot.json'), 'utf8');
  if (back !== body) fail('swe-prep.mjs: the two snapshot.json copies differ');
  return entries;
}

/** Layer 6: test_patch + gold + F2P on a throwaway copy; must all pass. */
function validateTask(task, opts) {
  const armTask = join(opts.benchRoot, 'racoons-arm', 'swe', task.instanceId);
  const box = mkdtempSync(join(tmpdir(), `swe-prep-${opts.bench}-`));
  const tree = join(box, 'tree');
  cpSync(armTask, tree, { recursive: true });
  try {
    runOrFail(`git init ${task.instanceId}`, 'git', ['init', '--quiet', tree]);
    const apply = (label, patch) => {
      if (typeof patch !== 'string' || patch.trim() === '') return null;
      const file = join(box, `${label}.patch`);
      writeFileSync(file, patch);
      const args = ['-C', tree, ...GIT_OPTS, 'apply', '--whitespace=nowarn', file];
      const plain = run('git', args);
      if (plain.status === 0) return null;
      // A repo that commits CRLF keeps those bytes in the arm; the dataset patch
      // is LF. Retry tolerating the CR only, and say so.
      if (run('git', [...args.slice(0, -1), '--ignore-cr-at-eol', file]).status === 0) {
        say(`  note     ${task.instanceId}: ${label} applied only with --ignore-cr-at-eol`);
        return null;
      }
      return `${label} apply: ${(plain.stderr || plain.stdout).trim().split(/\r?\n/u)[0]}`;
    };
    const testError = apply('test_patch', task.testPatch) ?? apply('gold', task.goldPatch);
    if (testError !== null) return testError;
    if (task.f2p.length === 0) return 'no intact F2P id to run';
    const pathRoot = existsSync(join(tree, 'src')) ? join(tree, 'src') : tree;
    const res = run(venvPython(task.venv),
      ['-m', 'pytest', ...task.f2p, '-q', '--no-header', '-p', 'no:cacheprovider'], {
        cwd: tree,
        timeout: VALIDATE_TIMEOUT_MS,
        env: { ...process.env, PYTHONPATH: pathRoot, PYTHONDONTWRITEBYTECODE: '1' },
      });
    if (res.error?.code === 'ETIMEDOUT') return 'pytest timed out after 600s';
    if (res.status === 0) return null;
    const lines = `${res.stdout}\n${res.stderr}`.split(/\r?\n/u).filter((line) => line.trim() !== '');
    const failed = lines.findLast((line) => /^(FAILED|ERROR)\b/u.test(line.trim()));
    return (failed ?? lines.at(-1) ?? 'pytest failed without output').trim().slice(0, 300);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

function writePack(opts, tasks) {
  const pack = tasks.map((task) => ({
    instance_id: task.instanceId,
    repo: task.repo,
    repoDirname: repoDirname(task.repo),
    base_commit: task.baseCommit,
    f2p: task.f2p,
    p2p: task.p2p,
    test_patch: task.testPatch,
    pythonVersion: task.pythonActual ?? task.python,
    deps: task.deps ?? [],
    sourceIssueSha256: sha256(Buffer.from(task.issue, 'utf8')),
    issueTextChars: task.issue.length,
  }));
  const path = join(opts.stagingRoot, opts.bench, 'task-pack.json');
  writeJson(path, pack);
  return path;
}

/** The issue text with every fence rewritten to a 4-space indent, nothing else. */
function sanitizeIssue(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text).split(/\r?\n/u)) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    out.push(fenced && line !== '' ? `    ${line}` : line);
  }
  return out.join('\n');
}

function writeBriefInput(opts, tasks) {
  const brief = tasks.map((task) => ({
    instance_id: task.instanceId,
    repo: task.repo,
    issueTextSanitized: sanitizeIssue(task.issue),
    issueTextSourceSha256: sha256(Buffer.from(task.issue, 'utf8')),
    f2p: task.f2p,
    p2p: task.p2p,
    inArmPath: `swe/${task.instanceId}`,
  }));
  const path = join(opts.stagingRoot, opts.bench, 'brief-input.json');
  writeJson(path, brief);
  return path;
}

function printPlan(opts, tasks, selector) {
  say(`bench      ${opts.bench}  (${BENCH_SOURCES[opts.bench].join(' + ')})`);
  say(`tasks      ${tasks.length} selected from ${opts.tasks}`);
  say(`staging    ${opts.stagingRoot}`);
  say(`venvs      ${opts.venvRoot}`);
  say(`arms root  ${opts.benchRoot}`);
  say(`dataset    ${opts.dataset}`);
  say('');
  say('order  instance_id                                   clone / venv');
  tasks.forEach((task, index) => {
    const present = cloneComplete(join(opts.stagingRoot, TAG_DIR[task.datasetTag], repoDirname(task.repo)));
    const short = selector.clones.get(task.instanceId)?.short;
    const reuse = present ? 'present' : short && cloneComplete(join(SELECTOR_WORK, 'repos', short))
      ? `reuse ${short}` : 'git clone';
    const venv = join(opts.venvRoot, task.instanceId, 'venv');
    const venvState = existsSync(venvPython(venv)) ? 'present' : `create py -${task.python}`;
    say(`  ${String(index + 1).padStart(2)}   ${task.instanceId.padEnd(46)} ${reuse} / ${venvState}`);
    say(`       f2p ${task.f2p.length}  p2p ${task.p2p.length}  test_patch ${task.testPatch.length}B  base ${task.baseCommit.slice(0, 10)}`);
  });
  say('');
  if (opts.bench === 'compounded') {
    say(`would copy ${BASTION} -> ${join(opts.stagingRoot, 'compounded-src')} (no .git)`);
    say(`would overlay swe/ from ${join(opts.stagingRoot, 'lite', 'src', 'swe')} and ${join(opts.stagingRoot, 'rebench', 'src', 'swe')}`);
    say(`prep: ${prepCommand(join(opts.stagingRoot, 'compounded-src'), opts.benchRoot).join(' ')}`);
  } else {
    say(`prep: ${prepCommand(join(opts.stagingRoot, TAG_DIR[BENCH_SOURCES[opts.bench][0]], 'src'),
      opts.benchRoot).join(' ')}`);
  }
  say(`would snapshot ${join(opts.benchRoot, 'snapshot.json')} (+ identical bytes in vanilla-arm/)`);
  say(`would validate in order: ${tasks.map((task) => task.instanceId).join(', ')}`);
  say(`would write ${join(opts.stagingRoot, opts.bench, 'task-pack.json')} and brief-input.json`);
  say('DRY RUN: nothing written outside the OS temp dir');
}

function prepareTask(task, opts, selector) {
  say(`task ${task.instanceId} (${task.repo})`);
  stageClone(task, opts, selector);
  say(`  clone    ${task.cloneAction} -> ${task.cloneDir}`);
  say(`  base     ${task.baseCommit.slice(0, 12)} checked out, reset, cleaned`);
  stageVenv(task, opts);
  stageSrcTree(task, opts);
  say(`  src      ${task.srcDir}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selector = selectorIndex();
  const all = readJson(opts.tasks);
  if (!Array.isArray(all)) fail(`swe-prep.mjs: ${opts.tasks} is not an array`);
  const entries = validatedEntries(all, opts.bench);
  const rows = loadRows(opts, entries.map((entry) => entry.instance_id));
  let tasks = buildTasks(opts, rows, selector, entries);
  if (opts.smoke !== null) {
    const one = tasks.filter((task) => task.instanceId === opts.smoke);
    if (one.length === 0) fail(`swe-prep.mjs: --smoke ${opts.smoke} is not a validated ${opts.bench} task`);
    tasks = one.slice(0, 1);
  }

  if (opts.dryRun) {
    printPlan(opts, tasks, selector);
    return;
  }

  mkdirSync(opts.stagingRoot, { recursive: true });
  mkdirSync(opts.venvRoot, { recursive: true });
  mkdirSync(opts.benchRoot, { recursive: true });
  const discards = [];
  let survivors = tasks;
  let round = 0;
  let reoverlay = false;
  for (;;) {
    round += 1;
    say(`\n== round ${round}: ${survivors.length} task(s)`);
    for (const task of survivors) prepareTask(task, opts, selector);
    stageArms(opts, survivors, { reoverlay });
    writeSnapshot(opts, survivors);
    const packPath = writePack(opts, survivors);
    say(`pack: ${packPath}`);
    const failed = [];
    say('\n== staged-bytes validation');
    for (const task of survivors) {
      const error = validateTask(task, opts);
      if (error === null) {
        say(`  PASS ${task.instanceId}: ${task.f2p.length} F2P id(s) green on the staged tree`);
        continue;
      }
      task.discard = error;
      failed.push(task);
      say(`  DISCARD ${task.instanceId}: ${error}`);
    }
    if (failed.length === 0) break;
    for (const task of failed) {
      discards.push({ instance_id: task.instanceId, error: task.discard, at: new Date().toISOString() });
      rmSync(task.srcDir, { recursive: true, force: true });
      say(`  removed ${task.srcDir}`);
    }
    survivors = survivors.filter((task) => task.discard === null);
    // The pack on disk never names a discarded task, even when none survive.
    writePack(opts, survivors);
    if (survivors.length === 0) {
      writeJson(join(opts.stagingRoot, opts.bench, 'discards.json'), discards);
      fail(`swe-prep.mjs: every ${opts.bench} task was discarded; see the lines above`);
    }
    reoverlay = opts.bench === 'compounded';
    say(`  re-running prep + snapshot + validation for ${survivors.length} task(s)`);
  }
  if (discards.length > 0) writeJson(join(opts.stagingRoot, opts.bench, 'discards.json'), discards);
  const briefPath = writeBriefInput(opts, survivors);
  say(`survivors: ${survivors.length}`);
  say(`brief: ${briefPath}`);
  say(`snapshot: ${join(opts.benchRoot, 'snapshot.json')}`);
  for (const task of survivors) say(`  ${task.instanceId}  py ${task.pythonActual}  ${task.f2p.length} f2p`);
}

main();
