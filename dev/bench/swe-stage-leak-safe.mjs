#!/usr/bin/env node
/**
 * Stage the leak-safe 110-task SWE pack (ISSUE-288's task set) into a bench
 * root and write its brief input (ISSUE-289, plan
 * docs/plans/2026-11-18-leak-safe-110/plan.md gate 1).
 *
 * Usage:
 *   node dev/bench/swe-stage-leak-safe.mjs --tasks <tasks.jsonl>
 *     --snapshots <dir> --staging-root <dir> --venv-root <dir> --bench-root <dir>
 *     [--jobs 4] [--skip-venvs] [--dry-run]
 *
 * The task set is `tasks.jsonl` (set, instance_id, repo, base_commit,
 * problem_statement, test_patch, gold_patch, test_cmds, install, requirements,
 * FAIL_TO_PASS, PASS_TO_PASS, snapshot) beside `snapshots/<instance_id>/` —
 * exact base trees with no `.git`. Steps, in order:
 *
 *   1. copy each `snapshots/<instance_id>` into
 *      `<staging-root>/leak-safe-110/src/swe/<instance_id>` (plain copy, no git);
 *   2. one venv per task at `<venv-root>/<instance_id>/venv` — the deps
 *      install (the row's third-party `requirements`, cleaned: editable
 *      (`-e …`), `git+`, `file:///…` and `/opt/conda/…` lines are dropped;
 *      `pytest` forced present and `pytest-asyncio<1.0` pinned) and the
 *      package itself. Default = NON-EDITABLE from a throwaway copy of the
 *      pristine staging src, `pip install <copy><extras>` with extras parsed
 *      from the row's `install` string, so pyproject-declared runtime deps
 *      reach the venv even when `requirements` is null (no `--no-deps`; the
 *      tree under test still wins at run time because PYTHONPATH precedes
 *      site-packages). `--editable-ids` (owner-approved list by default)
 *      installs those tasks EDITABLE straight into the staging src tree, so
 *      setuptools-scm's generated version modules land where the arms are
 *      built from — venvs run BEFORE prep.mjs, so arms and snapshot.json
 *      hash the POST-install tree. Success writes the sentinel
 *      `<venv-root>/<instance_id>/venv/.pkg-installed`. RE-RUNS REPAIR: a
 *      venv with the sentinel is kept (an editable task's install still
 *      re-runs — the fresh src copy must be regenerated into), one without
 *      it (old-code build, failed install) is deleted and rebuilt. `--jobs`
 *      builds run concurrently; a failed build is retried once, then the
 *      task is DISCARDED (discards.json) and excluded from the pack, the
 *      brief and the staged trees;
 *   3. `dev/bench/prep.mjs --force --src <staging src> --root <bench-root>
 *      --no-sibling` — it must print IDENTITY PASS and write `racoons-arm/`
 *      and `vanilla-arm/`;
 *   4. `task-pack.json` (`[{instance_id, repo, base_commit, test_patch, f2p,
 *      p2p}]` — the shape dev/bench/swe-score.mjs `--tasks` ingests) and
 *      `snapshot.json` (`[{instance_id, files: {relpath: sha256}}]` — the
 *      shape its `--snapshot` ingests), BOTH at `<bench-root>` only: the arms
 *      carry what prep.mjs wrote and nothing else, because a file dropped
 *      into an arm after the manifest would make that arm's launch gate
 *      order-dependent (the tree digest counts it; the manifest totals
 *      predate it). Hashes come from the racoons arm and each task's two arm
 *      trees are compared byte-for-byte; scoring points swe-score at the
 *      bench-root copies;
 *   5. `<staging-root>/leak-safe-110/brief-input.json` — one entry per task,
 *      tasks.jsonl order: instance_id, order index, the launch segment
 *      (owner directive 2026-11-18: the 110 items run as six sequential
 *      segments, 20/20/20/20/20/10, one launch each resuming the same
 *      session), the verbatim problem_statement (triple-backtick lines
 *      re-indented four spaces so the brief's fence cannot break), the
 *      arm-relative repo path `swe/<id>`, the f2p array, the p2p count, the
 *      venv python absolute path and the PYTHONPATH form scoring uses — plus
 *      `discards.json` when anything was discarded.
 *
 * The brief itself is dev/bench/swe-brief-leak-safe.mjs's job. No cap is
 * applied to the brief block here: the 110 statements go out unbatched.
 *
 * `--dry-run` prints the plan and writes nothing. Plain Node >= 22, no
 * dependencies. Exit 0 = staged; 1 = prep or an identity check failed;
 * 2 = bad arguments or every task was discarded.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { inside } from '../shared/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PREP = join(HERE, 'prep.mjs');
/** The staging src the arms are built from, under --staging-root. */
const BENCH_SLUG = 'leak-safe-110';
const DEFAULT_PY = '3.12';
/** The asyncio pin every venv carries (the plan's scoring requirement). */
const PYTEST_ASYNCIO_PIN = 'pytest-asyncio<1.0';
/** Proof the non-editable package install landed (the repair key). */
const PKG_SENTINEL = '.pkg-installed';

/**
 * The tasks whose package must be installed EDITABLE (owner-approved list,
 * 2026-11-18): setuptools-scm generates their version modules only into the
 * site-packages copy, so the generated files must land in the staging src
 * tree for the arms to carry them. Overridable with --editable-ids.
 */
const DEFAULT_EDITABLE_IDS = [
  'pytest-dev__apipkg-20',
  'ESSS__conda-devenv-114',
  'borgbackup__borgstore-26',
  'zopefoundation__zope.mkzeoinstance-7',
];

/**
 * The campaign's launch segmentation (owner directive 2026-11-18): the 110
 * items run as SIX sequential segments of 20/20/20/20/20/10, each segment one
 * launch resuming the same session. Every task's brief-input row names its
 * segment; dev/bench/swe-brief-leak-safe.mjs splits the brief files the same
 * way, so the two can never disagree.
 */
export const LEAK_SAFE_SEGMENTS = [20, 20, 20, 20, 20, 10];

/**
 * The 1-based task index ranges per segment. Six segments follow the
 * campaign's 20/20/20/20/20/rest rule (owner directive: the first five hold
 * 20 each, the sixth holds the rest — 110 tasks give exactly 20/20/20/20/20/10,
 * a quarantined 105 gives 20/20/20/20/20/5, below 100 the sixth runs empty and
 * the tail segments just stop at 20). Other segment counts split evenly with
 * the last segment shortest. `segments` is capped at `total` for those.
 * @returns {{start: number, end: number}[]}
 */
export function segmentBounds(total, segments = 6) {
  if (!Number.isInteger(total) || total <= 0) fail('segmentBounds: total must be a positive integer');
  if (!Number.isInteger(segments) || segments <= 0) fail('segmentBounds: segments must be a positive integer');
  const sizes = [];
  if (segments === 6) {
    let remaining = total;
    for (let index = 0; index < 6 && remaining > 0; index += 1) {
      const size = index < 5 ? Math.min(20, remaining) : remaining;
      sizes.push(size);
      remaining -= size;
    }
  } else {
    const count = Math.min(segments, total);
    for (let index = 0; index < count && total - index * Math.ceil(total / count) > 0; index += 1) {
      sizes.push(Math.min(Math.ceil(total / count), total - index * Math.ceil(total / count)));
    }
  }
  const bounds = [];
  let at = 1;
  for (const size of sizes) {
    bounds.push({ start: at, end: at + size - 1 });
    at += size;
  }
  if (at !== total + 1) fail(`segmentBounds: the split covers ${String(at - 1)} of ${String(total)} task(s)`);
  return bounds;
}

/** The 1-based segment a task index (0-based) belongs to. */
export function segmentOf(zeroIndex, bounds) {
  const at = zeroIndex + 1;
  const hit = bounds.findIndex((bound) => at >= bound.start && at <= bound.end);
  return hit === -1 ? fail(`segmentOf: index ${String(at)} is outside the split`) : hit + 1;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

const STAGE_OPTIONS = optionsOf([
  ['--tasks', 'string'],
  ['--snapshots', 'string'],
  ['--staging-root', 'string'],
  ['--venv-root', 'string'],
  ['--bench-root', 'string'],
  ['--jobs', 'string'],
  ['--editable-ids', 'string', 'editableIds'],
  ['--skip-venvs', 'boolean', 'skipVenvs'],
  ['--dry-run', 'boolean', 'dryRun'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: STAGE_OPTIONS,
    refuse: fail,
    help: 'usage: swe-stage-leak-safe.mjs --tasks <tasks.jsonl> --snapshots <dir>\n'
      + '  --staging-root <dir> --venv-root <dir> --bench-root <dir>\n'
      + '  [--jobs 4] [--skip-venvs] [--dry-run]\n',
  });
  for (const [key, flag] of [
    ['tasks', '--tasks'], ['snapshots', '--snapshots'], ['stagingRoot', '--staging-root'],
    ['venvRoot', '--venv-root'], ['benchRoot', '--bench-root'],
  ]) {
    if (values[key] === undefined) fail(`swe-stage-leak-safe.mjs: ${flag} <dir> is required`);
  }
  const opts = {
    tasks: resolve(values.tasks),
    snapshots: resolve(values.snapshots),
    stagingRoot: resolve(values.stagingRoot),
    venvRoot: resolve(values.venvRoot),
    benchRoot: resolve(values.benchRoot),
    jobs: values.jobs === undefined ? 4 : Number.parseInt(values.jobs, 10),
    editableIds: new Set((values.editableIds ?? DEFAULT_EDITABLE_IDS.join(','))
      .split(',').map((id) => id.trim()).filter((id) => id !== '')),
    skipVenvs: values.skipVenvs ?? false,
    dryRun: values.dryRun ?? false,
  };
  if (!(Number.isInteger(opts.jobs) && opts.jobs > 0)) fail('swe-stage-leak-safe.mjs: --jobs must be a positive integer');
  return opts;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`swe-stage-leak-safe.mjs: cannot read ${what} ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256Bytes = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const posix = (root, full) => relative(root, full).split(sep).join('/');
const toPosixPath = (value) => String(value).split('\\').join('/');

/** Every regular file under dir, as sorted posix relative paths. */
export function walkFiles(dir, root = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, root, out);
    else if (entry.isFile()) out.push(posix(root, full));
  }
  return out.sort();
}

/** One `sha256  relpath` line list — the per-task arm identity proof. */
function multiset(dir) {
  return walkFiles(dir).map((rel) => `${sha256File(join(dir, rel))}  ${rel}`).sort().join('\n');
}

/** The issue text with every triple-backtick line indented four spaces. */
export function fenceSafe(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => (line.trimStart().startsWith('```') ? `    ${line}` : line))
    .join('\n');
}

/**
 * One PEP 508-style requirement line; anything else is not a dependency.
 * `-e …`, `git+…`, `name @ file:///croot/…` and `/opt/conda/…` workspaces fail
 * this shape and are dropped: the repo itself reaches the run through
 * PYTHONPATH, never through an editable or self install.
 */
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]*\])?(?:\s*[<>=!~]=?\s*[0-9A-Za-z.*+_-]+)?(?:\s*;\s*[^:]+)?$/u;

/** Keep only installable package specs; never the repo itself. */
export function cleanDeps(lines) {
  const kept = [];
  const dropped = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!REQUIREMENT.test(line)) {
      dropped.push(line);
      continue;
    }
    kept.push(line);
  }
  return { kept: [...new Set(kept)], dropped };
}

/**
 * The task's deps-only install list: the row's requirements string, cleaned,
 * with `pytest` present and `pytest-asyncio<1.0` pinned in every venv. Any
 * pytest-asyncio line the row carried is replaced by the pin, so an
 * `asyncio==1.x` row cannot smuggle the breaking major past it.
 */
export function depsFor(row) {
  const raw = row.requirements === null || row.requirements === undefined
    ? []
    : String(row.requirements).split(/\r?\n/u);
  const { kept, dropped } = cleanDeps(raw);
  const withoutAsyncio = kept.filter((line) => !/^pytest-asyncio\b/iu.test(line));
  const hasPytest = withoutAsyncio.some((line) => /^pytest(?:\s*[<>=!~@]|$)/iu.test(line));
  const deps = [...withoutAsyncio];
  if (!hasPytest) deps.push('pytest');
  deps.push(PYTEST_ASYNCIO_PIN);
  return { deps, dropped };
}

/** An id truncated at selection has a SPACE after `::`; it cannot be run. */
export function intactIds(ids) {
  const intact = [];
  const dropped = [];
  for (const id of ids ?? []) {
    const at = String(id).indexOf('::');
    if (at !== -1 && String(id).slice(at).includes(' ')) dropped.push(id);
    else intact.push(id);
  }
  return { intact, dropped };
}

/**
 * The path one instance id names under `root`, refused by name when the id
 * leaves it. The id is a dataset value, and the paths it builds are copied
 * into, recursively deleted, and rebuilt: an id of `..` must fail here rather
 * than reach `rmSync`. The id may be a nested segment; it may not escape.
 * @param {string} root - the containing tree.
 * @param {string} instanceId - the row's `instance_id`.
 * @returns {string}
 */
export function idPath(root, instanceId) {
  const path = join(root, instanceId);
  if (!inside(root, path)) {
    fail(`swe-stage-leak-safe.mjs: instance_id ${JSON.stringify(instanceId)} escapes ${root}; `
      + 'every id-derived path must stay inside its root');
  }
  return path;
}

export function venvPythonPath(venvRoot, instanceId) {
  return process.platform === 'win32'
    ? join(venvRoot, instanceId, 'venv', 'Scripts', 'python.exe')
    : join(venvRoot, instanceId, 'venv', 'bin', 'python');
}

/**
 * The PEP 508 extras the row's `install` string asks for the package itself:
 * `pip install -e .[dev]` (quotes tolerated) gives `[dev]`, `pip install -e .`
 * and anything unparseable give none.
 */
export function extrasFromInstall(install) {
  const text = String(install ?? '').replace(/["']/gu, '');
  const match = /pip\s+install\s+(?:-\S+\s+)*\.(\[[^\]]*\])/u.exec(text);
  return match === null ? '' : match[1];
}

/**
 * The repair key: a venv is kept only when the non-editable package install
 * provably landed (the sentinel exists). A venv without it — an old-code
 * build or a failed install — is rebuilt on the next staging run.
 */
export function pkgInstalled(venvRoot, instanceId) {
  return existsSync(join(venvRoot, instanceId, 'venv', PKG_SENTINEL));
}

/** `py -<ver>` exists? Returns the launcher argv prefix or null. */
function pythonLauncher(version) {
  if (spawnSync('py', ['-0p'], { encoding: 'utf8', windowsHide: true }).status !== 0) return [];
  return spawnSync('py', [`-${version}`, '-c', 'import sys'], { encoding: 'utf8', windowsHide: true }).status === 0
    ? ['py', `-${version}`]
    : [];
}

/**
 * One spawned child, awaited. The venv pool below only runs concurrently when
 * this does not block the event loop, so it is `spawn` with collected output,
 * never `spawnSync` in a promise wrapper.
 */
function runChild(command, args, extra = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true, ...extra });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolvePromise({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function firstErrorLine(text) {
  const line = String(text ?? '').split(/\r?\n/u).find((candidate) => candidate.trim() !== '');
  return (line ?? 'no output').trim().slice(0, 300);
}

/** The last `count` non-empty lines of a pip output, for a discards.json reason. */
export function stderrTail(text, count = 30) {
  const lines = String(text ?? '').split(/\r?\n/u).filter((candidate) => candidate.trim() !== '');
  return lines.slice(-count).join('\n').slice(0, 8000) || 'no output';
}

/**
 * The env every pip child of this stager gets, mirroring the dataset
 * validator's own fix (scratchpad/datasets/tools/verify_env.py env()): the
 * snapshots carry no .git, so setuptools-scm cannot derive a version and the
 * build dies with `subprocess-exited-with-error` unless a pretend version is
 * on both variables.
 */
function pipEnv() {
  return {
    ...process.env,
    SETUPTOOLS_SCM_PRETEND_VERSION: '1.0.0',
    SETUPTOOLS_SCM_PRETEND_VERSION_FOR_ANY_PACKAGE: '1.0.0',
  };
}

/**
 * One venv build — deps install, then the NON-EDITABLE package install from
 * a throwaway copy of the pristine staging src, retried once. Returns null on
 * success or the failure reason a discard records. Never touches another
 * task's directory.
 *
 * The package install is a LADDER, mirroring the dataset validator
 * (scratchpad/datasets/tools/verify_env.py): every pip child runs with
 * SETUPTOOLS_SCM_PRETEND_VERSION and SETUPTOOLS_SCM_PRETEND_VERSION_FOR_ANY_
 * PACKAGE set (the snapshots carry no .git, so setuptools-scm cannot derive a
 * version); a direct `pip install` failure is followed by `pip install -U
 * "setuptools<70" wheel` and a `--no-build-isolation` retry (still
 * non-editable, still with dependencies). The sentinel records which rung
 * landed; a full pip stderr tail goes into the discard reason.
 *
 * EDITABLE tasks (`--editable-ids`, owner-approved list by default) replace
 * the ladder with `pip install -e <staging-src>/<id><extras> --no-deps`,
 * installed straight into the staging src tree: setuptools-scm generates
 * their version modules only into the site-packages copy, so the generated
 * files must land in the tree the arms are built from. Consequences:
 *   - the venvs run BEFORE prep.mjs, so arms and snapshot.json hash the
 *     POST-install tree (venv step 2, prep step 3, pack+snapshot step 4);
 *   - the staging src is re-copied from the pristine snapshot on every
 *     staging run, which would lose the generated files if the editable
 *     install were skipped on a sentinel hit — so an editable task's
 *     install ALWAYS re-runs (venv kept, only the install refreshed);
 *   - deps still come from the requirements step; no `--no-deps` on the
 *     deps install itself, but the editable install carries `--no-deps`
 *     (the requirements step is the one dependency source).
 *
 * @returns {Promise<string|null>} null on success, else the discard reason
 */
export async function buildVenv(row, srcDir, opts, launcher, editable = false) {
  const dir = idPath(opts.venvRoot, row.instance_id);
  const venv = join(dir, 'venv');
  const { deps } = depsFor(row);
  const extras = extrasFromInstall(row.install);
  const ensureVenv = async () => {
    if (existsSync(venvPythonPath(opts.venvRoot, row.instance_id))) return null;
    rmSync(venv, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const made = await runChild(launcher[0], [...launcher.slice(1), '-m', 'venv', venv]);
    if (made.status !== 0) {
      return `venv create failed: ${firstErrorLine(made.stderr || made.stdout)}`;
    }
    const depsFile = join(dir, 'deps.txt');
    writeFileSync(depsFile, `${deps.join('\n')}\n`);
    const pip = await runChild(venvPythonPath(opts.venvRoot, row.instance_id),
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', depsFile],
      { env: pipEnv() });
    if (pip.status !== 0) {
      return `pip install failed: ${firstErrorLine(pip.stderr || pip.stdout)}`;
    }
    return null;
  };
  if (editable) {
    const editableAttempt = async () => {
      const ensured = await ensureVenv();
      if (ensured !== null) return ensured;
      // Straight into the staging src tree: the generated version modules and
      // .egg-info belong there — the arms hash this post-install tree.
      const ed = await runChild(venvPythonPath(opts.venvRoot, row.instance_id),
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-e', `${srcDir}${extras}`, '--no-deps'],
        { env: pipEnv() });
      if (ed.status !== 0) {
        return `editable install failed:\n${stderrTail(ed.stderr || ed.stdout)}`;
      }
      return { ladder: 'editable' };
    };
    const firstEd = await editableAttempt();
    if (typeof firstEd === 'object') {
      writeFileSync(join(venv, PKG_SENTINEL), `${row.instance_id} extras=${extras || '(none)'} ladder=${firstEd.ladder}\n`);
      return null;
    }
    const secondEd = await editableAttempt();
    if (typeof secondEd === 'object') {
      writeFileSync(join(venv, PKG_SENTINEL), `${row.instance_id} extras=${extras || '(none)'} ladder=${secondEd.ladder}\n`);
      return null;
    }
    return `first attempt: ${firstEd}\nretry failed: ${secondEd}`;
  }
  // Non-editable repair is a FULL rebuild: a venv without the sentinel may
  // hold a partial deps install, so nothing of it survives.
  const attempt = async () => {
    rmSync(venv, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const made = await runChild(launcher[0], [...launcher.slice(1), '-m', 'venv', venv]);
    if (made.status !== 0) {
      return `venv create failed: ${firstErrorLine(made.stderr || made.stdout)}`;
    }
    const depsFile = join(dir, 'deps.txt');
    writeFileSync(depsFile, `${deps.join('\n')}\n`);
    const pip = await runChild(venvPythonPath(opts.venvRoot, row.instance_id),
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', depsFile],
      { env: pipEnv() });
    if (pip.status !== 0) {
      return `pip install failed: ${firstErrorLine(pip.stderr || pip.stdout)}`;
    }
    // The package itself, never editable (a .pth would point pytest at the
    // pristine staging copy instead of the code under test) and never
    // --no-deps (the pyproject-declared runtime deps are the point). Installed
    // from a THROWAWAY COPY of the tree: pip's setup.py path writes build/ and
    // .egg-info into the tree it builds, and the staging src must stay
    // pristine — it is the snapshot's diff base.
    const pkgBox = mkdtempSync(join(tmpdir(), 'swe-stage-pkg-'));
    try {
      const pkgSrc = join(pkgBox, 'src');
      cpSync(srcDir, pkgSrc, { recursive: true });
      const install = async (extraArgs) => runChild(venvPythonPath(opts.venvRoot, row.instance_id),
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', `${pkgSrc}${extras}`, ...extraArgs],
        { env: pipEnv() });
      const direct = await install([]);
      if (direct.status === 0) return { ladder: 'direct' };
      const directTail = stderrTail(direct.stderr || direct.stdout);
      const upgrade = await runChild(venvPythonPath(opts.venvRoot, row.instance_id),
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-U', 'setuptools<70', 'wheel'],
        { env: pipEnv() });
      if (upgrade.status !== 0) {
        return `package install failed (direct step):\n${directTail}\n`
          + `setuptools<70 upgrade also failed:\n${stderrTail(upgrade.stderr || upgrade.stdout)}`;
      }
      const legacy = await install(['--no-build-isolation']);
      if (legacy.status !== 0) {
        return `package install failed (direct step):\n${directTail}\n`
          + `legacy setuptools retry (--no-build-isolation) failed:\n${stderrTail(legacy.stderr || legacy.stdout)}`;
      }
      return { ladder: 'legacy setuptools<70 --no-build-isolation' };
    } finally {
      rmSync(pkgBox, { recursive: true, force: true });
    }
  };
  const first = await attempt();
  if (typeof first === 'object') {
    writeFileSync(join(venv, PKG_SENTINEL), `${row.instance_id} extras=${extras || '(none)'} ladder=${first.ladder}\n`);
    return null;
  }
  const second = await attempt();
  if (typeof second === 'object') {
    writeFileSync(join(venv, PKG_SENTINEL), `${row.instance_id} extras=${extras || '(none)'} ladder=${second.ladder}\n`);
    return null;
  }
  return `first attempt: ${first}\nretry failed: ${second}`;
}

/**
 * `--jobs` workers over the queue; each build runs in its own child. REPAIR:
 * a non-editable venv with the sentinel is kept as-is, one without it is
 * deleted and rebuilt. An EDITABLE task's venv is kept the same way, but its
 * install ALWAYS re-runs: the staging src was re-copied from the pristine
 * snapshot this run, so the generated version modules must be regenerated
 * into it (the sentinel keep cannot apply to the tree, only to the venv).
 */
async function buildVenvs(rows, srcDirs, opts, editableIds) {
  const launcher = pythonLauncher(DEFAULT_PY);
  const prefix = launcher.length > 0 ? launcher : [];
  if (launcher.length === 0) say(`venvs    no py -${DEFAULT_PY} launcher; falling back to the PATH python`);
  const results = new Map();
  const queue = [];
  let kept = 0;
  for (const row of rows) {
    const editable = editableIds.has(row.instance_id);
    if (pkgInstalled(opts.venvRoot, row.instance_id) && !editable) {
      kept += 1;
      results.set(row.instance_id, null);
      say(`  venv     ${row.instance_id}: sentinel present, kept`);
      continue;
    }
    if (editable && pkgInstalled(opts.venvRoot, row.instance_id)) {
      say(`  venv     ${row.instance_id}: editable task, venv kept, install re-runs`);
    }
    queue.push({ row, editable });
  }
  say(`venvs    kept ${String(kept)} with sentinel; rebuilding ${String(queue.length)} (editable installs always re-run)`);
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      results.set(next.row.instance_id, await buildVenv(next.row, srcDirs.get(next.row.instance_id), opts,
        prefix.length > 0 ? prefix : ['python'], next.editable));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, queue.length) }, worker));
  return results;
}

/** Layer 1: the snapshot's exact bytes, copied plain, no git anywhere. */
function stageTree(row, opts) {
  const from = idPath(opts.snapshots, row.instance_id);
  const dest = idPath(join(opts.stagingRoot, BENCH_SLUG, 'src', 'swe'), row.instance_id);
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    return { dest, error: 'snapshot dir missing' };
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(from, dest, { recursive: true });
  return { dest, error: null };
}

/** The scoring PYTHONPATH value for a staged tree: `src/` layout or flat. */
export function pythonPathFor(tree) {
  try {
    if (statSync(join(tree, 'src')).isDirectory()) return 'src';
  } catch {
    // flat layout
  }
  return '.';
}

/** The pack row shape dev/bench/swe-score.mjs loadTaskPack ingests. */
export function packRow(row) {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    test_patch: row.test_patch ?? '',
    f2p: row.FAIL_TO_PASS ?? [],
    p2p: row.PASS_TO_PASS ?? [],
  };
}

/** The snapshot row shape its loadSnapshot ingests: every file's relpath -> sha256. */
export function snapshotEntry(instanceId, tree) {
  const files = {};
  for (const rel of walkFiles(tree)) files[rel] = sha256File(join(tree, rel));
  return { instance_id: instanceId, files };
}

/**
 * Write the pack and the pre-run snapshot at the bench root ONLY. Nothing is
 * copied into either arm beyond what prep.mjs itself wrote: a file that lands
 * in an arm after its manifest makes the launch gate order-dependent (the
 * tree digest counts it, the manifest totals predate it), and this campaign
 * runs six launches per arm.
 */
export function writePackAndSnapshot(benchRoot, pack, snapshot) {
  const packPath = join(benchRoot, 'task-pack.json');
  const snapshotPath = join(benchRoot, 'snapshot.json');
  writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { packPath, snapshotPath };
}

function printPlan(rows, opts) {
  say(`tasks     ${String(rows.length)} row(s) from ${opts.tasks}`);
  say(`snapshots ${opts.snapshots}`);
  say(`staging   ${join(opts.stagingRoot, BENCH_SLUG)}`);
  say(`venvs     ${opts.venvRoot} (--jobs ${String(opts.jobs)}${opts.skipVenvs ? ', --skip-venvs' : ''})`);
  say(`bench     ${opts.benchRoot}`);
  say('');
  say('order  instance_id                                    venv');
  rows.forEach((row, index) => {
    const made = existsSync(venvPythonPath(opts.venvRoot, row.instance_id));
    const editable = opts.editableIds.has(row.instance_id) ? ' [editable]' : '';
    say(`  ${String(index + 1).padStart(3)} ${row.instance_id.padEnd(46)} ${made ? 'present' : `create py -${DEFAULT_PY}`}${editable}`);
    say(`       f2p ${(row.FAIL_TO_PASS ?? []).length}  p2p ${(row.PASS_TO_PASS ?? []).length}  `
      + `requirements ${row.requirements === null || row.requirements === undefined ? 'null' : `${String(row.requirements).length}B`}`);
  });
  say('');
  say(`prep: ${process.execPath} ${PREP} --force --src ${join(opts.stagingRoot, BENCH_SLUG, 'src')} --root ${opts.benchRoot} --no-sibling`);
  say(`would write ${join(opts.benchRoot, 'task-pack.json')} and snapshot.json (bench root only, never into an arm)`);
  say(`would write ${join(opts.stagingRoot, BENCH_SLUG, 'brief-input.json')} and discards.json`);
  say('DRY RUN: nothing written');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = readFileSync(opts.tasks, 'utf8');
  const rows = raw.split(/\r?\n/u).filter((line) => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return fail(`swe-stage-leak-safe.mjs: ${opts.tasks} has a row that is not JSON: ${error.message}`);
    }
  });
  if (rows.length === 0) fail(`swe-stage-leak-safe.mjs: ${opts.tasks} holds no rows`);

  if (opts.dryRun) {
    printPlan(rows, opts);
    return;
  }

  const discards = [];
  const discard = (row, reason) => {
    discards.push({ instance_id: row.instance_id, reason, at: new Date().toISOString() });
    say(`  DISCARD ${row.instance_id}: ${reason}`);
  };

  // Step 1: the exact base trees, copied plain (no .git exists to carry).
  say(`== step 1: stage ${String(rows.length)} snapshot tree(s)`);
  const staged = new Map();
  for (const row of rows) {
    if (typeof row.instance_id !== 'string' || row.instance_id === '') {
      fail('swe-stage-leak-safe.mjs: a row has no instance_id');
    }
    const { dest, error } = stageTree(row, opts);
    if (error !== null) discard(row, error);
    else staged.set(row.instance_id, dest);
  }
  say(`staged ${String(staged.size)} tree(s) under ${join(opts.stagingRoot, BENCH_SLUG, 'src', 'swe')}`);

  // Step 2: one deps-only venv per task, --jobs at a time, one retry each.
  const venvTasks = rows.filter((row) => staged.has(row.instance_id));
  if (!opts.skipVenvs) {
    say(`\n== step 2: build ${String(venvTasks.length)} venv(s), --jobs ${String(opts.jobs)}`);
    const built = await buildVenvs(venvTasks, staged, opts, opts.editableIds);
    let venvOk = 0;
    for (const [instanceId, error] of built) {
      if (error !== null) discard(rows.find((row) => row.instance_id === instanceId), error);
      else venvOk += 1;
    }
    say(`venvs ok: ${String(venvOk)} of ${String(venvTasks.length)}`);
  } else {
    say('\n== step 2: venvs SKIPPED (--skip-venvs)');
  }

  // A discarded task leaves the staging too: the arms, the pack, the snapshot
  // and the brief must name exactly the same set.
  for (const entry of discards) {
    staged.delete(entry.instance_id);
    rmSync(idPath(join(opts.stagingRoot, BENCH_SLUG, 'src', 'swe'), entry.instance_id),
      { recursive: true, force: true });
  }
  const survivors = rows.filter((row) => staged.has(row.instance_id));
  if (survivors.length === 0) {
    writeJson(join(opts.stagingRoot, BENCH_SLUG, 'discards.json'), discards);
    fail('swe-stage-leak-safe.mjs: every task was discarded; see discards.json');
  }

  // Step 3: prep.mjs freezes both arms from the staged src and proves identity.
  say('\n== step 3: prep.mjs writes both arms');
  mkdirSync(opts.benchRoot, { recursive: true });
  // prep.mjs refuses a root holding entries it never writes; task-pack.json
  // and snapshot.json are THIS script's own bench-root outputs, rewritten in
  // step 4, so a previous run's copies are removed before prep looks.
  rmSync(join(opts.benchRoot, 'task-pack.json'), { force: true });
  rmSync(join(opts.benchRoot, 'snapshot.json'), { force: true });
  const src = join(opts.stagingRoot, BENCH_SLUG, 'src');
  const prep = spawnSync(process.execPath, [PREP, '--force', '--src', src, '--root', opts.benchRoot, '--no-sibling'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  say((prep.stdout ?? '').trimEnd());
  if (prep.status !== 0) {
    process.stderr.write(prep.stderr ?? '');
    fail(`swe-stage-leak-safe.mjs: prep.mjs exited ${String(prep.status ?? '?')}`);
  }
  if (!/IDENTITY PASS/u.test(prep.stdout ?? '')) {
    fail('swe-stage-leak-safe.mjs: prep.mjs printed no IDENTITY PASS');
  }
  const racoonsArm = join(opts.benchRoot, 'racoons-arm');
  const vanillaArm = join(opts.benchRoot, 'vanilla-arm');
  for (const arm of [racoonsArm, vanillaArm]) {
    if (!existsSync(arm)) fail(`swe-stage-leak-safe.mjs: prep.mjs wrote no arm at ${arm}`);
  }

  // Step 4: the pack and the pre-run snapshot, both arms byte-identical,
  // written at the bench root only (never into an arm).
  say('\n== step 4: task-pack.json + snapshot.json');
  const pack = [];
  const snapshot = [];
  for (const row of survivors) {
    const left = join(racoonsArm, 'swe', row.instance_id);
    const right = join(vanillaArm, 'swe', row.instance_id);
    if (!existsSync(left) || !existsSync(right)) {
      fail(`swe-stage-leak-safe.mjs: ${row.instance_id} missing from an arm after prep`);
    }
    if (multiset(left) !== multiset(right)) {
      fail(`swe-stage-leak-safe.mjs: the arms differ for ${row.instance_id}: not byte-identical`);
    }
    const { intact, dropped } = intactIds(row.FAIL_TO_PASS ?? []);
    if (dropped.length > 0) {
      say(`  note ${row.instance_id}: ${String(dropped.length)} truncated F2P id(s) kept verbatim in the pack`);
    }
    if (intact.length === 0) fail(`swe-stage-leak-safe.mjs: ${row.instance_id} has no intact F2P id to grade`);
    pack.push(packRow(row));
    snapshot.push(snapshotEntry(row.instance_id, left));
    const entry = snapshot[snapshot.length - 1];
    say(`  ${row.instance_id}: ${String(Object.keys(entry.files).length)} file(s), ${String(row.FAIL_TO_PASS.length)} f2p, ${String((row.PASS_TO_PASS ?? []).length)} p2p`);
  }
  const { packPath: packWritten, snapshotPath: snapshotWritten } = writePackAndSnapshot(opts.benchRoot, pack, snapshot);

  // Step 5: the brief input, in tasks.jsonl order, each task named with the
  // launch segment (owner directive 2026-11-18: six sequential segments).
  say('\n== step 5: brief-input.json');
  const bounds = segmentBounds(survivors.length);
  const briefInput = survivors.map((row, index) => {
    const dest = staged.get(row.instance_id);
    const { intact, dropped } = intactIds(row.FAIL_TO_PASS ?? []);
    return {
      instance_id: row.instance_id,
      order: index + 1,
      segment: segmentOf(index, bounds),
      repo: row.repo,
      repoPath: `swe/${row.instance_id}`,
      problemStatement: fenceSafe(row.problem_statement ?? ''),
      issueTextSourceSha256: sha256Bytes(row.problem_statement ?? ''),
      f2p: row.FAIL_TO_PASS ?? [],
      pytestTargets: intact,
      truncatedF2P: dropped.length,
      p2pCount: (row.PASS_TO_PASS ?? []).length,
      venvPython: toPosixPath(venvPythonPath(opts.venvRoot, row.instance_id)),
      pythonPath: pythonPathFor(dest),
    };
  });
  const briefPath = join(opts.stagingRoot, BENCH_SLUG, 'brief-input.json');
  writeJson(briefPath, briefInput);
  say(`segments: ${bounds.map((bound) => `${String(bound.start)}-${String(bound.end)}`).join(', ')}`);
  if (discards.length > 0) {
    writeJson(join(opts.stagingRoot, BENCH_SLUG, 'discards.json'), discards);
  }

  say(`\nsurvivors: ${String(survivors.length)}  discards: ${String(discards.length)}`);
  say(`pack: ${packWritten}`);
  say(`snapshot: ${snapshotWritten}`);
  say(`brief input: ${briefPath}`);
  if (discards.length > 0) say(`discards: ${join(opts.stagingRoot, BENCH_SLUG, 'discards.json')}`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
