#!/usr/bin/env node
/**
 * Offline post-run scorer for the SWE bench runs.
 *
 * One task is graded from four inputs, all paths passed as flags:
 *
 *   --arm-dir   the post-run arm directory; task repos at `<arm>/swe/<id>/`.
 *   --snapshot  PRE-RUN sha256 map written at staging:
 *               `[{ instance_id, files: { "<relpath>": "<sha256>" } }]`.
 *   --tasks     `[{ instance_id, repo, base_commit, test_patch, f2p, p2p }]`.
 *   --staging   staging clones WITH `.git` at `<staging>/<repo-dirname>/`.
 *   --base-dir  git-less base trees at `<base-dir>/<instance_id>/`; when given
 *               it replaces `--staging` as the base source (no network, no
 *               remote, `base_commit` is informational only).
 *   --base-override-dir  staging src trees at `<dir>/<instance_id>/` (post-
 *               install, with build-generated version modules). When a task has
 *               a directory there it is the fresh-copy source, else `--base-dir`.
 *   --venv-root per-task deps-only venvs at `<venv-root>/<id>/venv`.
 *
 * The agent's edits are recovered as a diff between the snapshot and the arm
 * tree, then replayed onto a FRESH clone of the staging repo at `base_commit`
 * (or, in `--base-dir` mode, a fresh copy of the base tree with a throwaway
 * local `git init` commit so patches still apply). The test patch is applied
 * there; one `pytest --collect-only` spawn drops ids that resolve to no
 * collected node, then FAIL_TO_PASS and PASS_TO_PASS run in SEPARATE pytest
 * spawns, so a malformed P2P list (pytest exits 4 on an unknown node id) can
 * never cost the F2P verdict. A task passes iff every graded F2P id passed and
 * the test patch's own files (plus any conftest.py or a config file it
 * rewrites) were not touched by the agent.
 *
 * No network: the clone is local. The task repos are untrusted, so the child
 * gets a minimised environment, cwd = the clone, `-p no:cacheprovider`, and
 * nothing but pytest is executed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { relativeInside } from '../shared/paths.mjs';

export const DEFAULT_TIMEOUT_MS = 900_000;

/** Paths that never count as agent changes. */
export function isExcludedPath(rel) {
  const path = rel.split('\\').join('/');
  const parts = path.split('/');
  if (parts.includes('swe-results')) return true;
  if (parts.includes('__pycache__')) return true;
  if (parts.includes('.pytest_cache')) return true;
  if (path.endsWith('.pyc')) return true;
  return false;
}

function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/** Every regular file under `root` as `relpath -> sha256`; `.git` dirs skipped. */
export function walkHashes(root, { skipGit = true } = {}) {
  const out = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipGit && entry.name === '.git') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/');
      out[rel] = sha256File(full);
    }
  };
  walk(root);
  return out;
}

/** `{added, modified, deleted}` between two `relpath -> sha256` maps. */
export function diffTrees(pre, post) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const path of Object.keys(post)) {
    if (!(path in pre)) added.push(path);
    else if (pre[path] !== post[path]) modified.push(path);
  }
  for (const path of Object.keys(pre)) {
    if (!(path in post)) deleted.push(path);
  }
  const keep = (path) => !isExcludedPath(path);
  return {
    added: added.filter(keep).sort(),
    modified: modified.filter(keep).sort(),
    deleted: deleted.filter(keep).sort(),
  };
}

/** All paths the diff touches. */
export function changedPaths(diff) {
  return [...new Set([...diff.added, ...diff.modified, ...diff.deleted])].sort();
}

function normalizePatchPath(raw) {
  let path = raw.split('\t')[0].trim();
  if (path === '' || path === '/dev/null') return null;
  path = path.split('\\').join('/');
  if (path.startsWith('./')) path = path.slice(2);
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  return path;
}

/** File paths a unified diff touches, from `---` / `+++` and `diff --git` lines. */
export function pathsInPatch(patchText) {
  const paths = new Set();
  for (const line of String(patchText).split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+)\s+(.+)$/u.exec(line);
    if (match) {
      const path = normalizePatchPath(match[1]);
      if (path !== null) paths.add(path);
      continue;
    }
    const gitDiff = /^diff --git\s+(\S+)\s+(\S+)$/u.exec(line);
    if (gitDiff) {
      for (const raw of [gitDiff[1], gitDiff[2]]) {
        const path = normalizePatchPath(raw);
        if (path !== null) paths.add(path);
      }
    }
  }
  return paths;
}

/** Repo config files whose agent edits block a score, unless the test patch owns them. */
const CONFIG_TAMPER_NAMES = new Set([
  'pytest.ini', 'setup.cfg', 'pyproject.toml', 'tox.ini', 'sitecustomize.py',
]);

/**
 * Paths that block a score: files the test patch touches and any conftest.py
 * (the existing rule, unconditional), plus the config files in
 * `CONFIG_TAMPER_NAMES` unless the test patch modifies the same path — there
 * the patch supplies the config, so the agent's edit buys nothing.
 *
 * A config name only counts as tamper where it can steer grading (ISSUE-295):
 * at the repo ROOT, or in a directory pytest reads for the graded tests (the
 * test patch's own directories and their ancestors up to the root). A config
 * file a task's own tests write into a temp/generated subdirectory (towncrier
 * writes `pyproject.toml` under `.../<rand>/temp/` during pytest) is a changed
 * file to report, not tampering.
 */
export function tamperPaths(changed, testPatchPaths) {
  const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  // The root is always graded; add each test-patch file's directory chain.
  const gradedDirs = new Set(['']);
  for (const raw of testPatchPaths) {
    let dir = dirOf(raw.split('\\').join('/'));
    while (dir !== '') {
      gradedDirs.add(dir);
      dir = dirOf(dir);
    }
  }
  const hits = new Set();
  for (const raw of changed) {
    const path = raw.split('\\').join('/');
    const name = basename(path);
    if (testPatchPaths.has(path)) {
      // Graded test files are always tamper; a config file the patch rewrites
      // is exempt because the patch supplies its content.
      if (!CONFIG_TAMPER_NAMES.has(name)) hits.add(path);
      continue;
    }
    if (name === 'conftest.py') {
      hits.add(path);
      continue;
    }
    if (CONFIG_TAMPER_NAMES.has(name) && gradedDirs.has(dirOf(path))) hits.add(path);
  }
  return [...hits].sort();
}

/**
 * An id truncated at selection has a SPACE after `::` (the selection cut a
 * test function's prose mid-id); it cannot be run and is counted as dropped.
 */
export function splitIds(ids) {
  const intact = [];
  const dropped = [];
  for (const id of ids) {
    const at = id.indexOf('::');
    if (at !== -1 && id.slice(at).includes(' ')) dropped.push(id);
    else intact.push(id);
  }
  return { intact, dropped };
}

/** Slash form used for every path and node id comparison. */
function normalisePath(path) {
  return String(path).split('\\').join('/');
}

/**
 * Node ids from one `pytest --collect-only -q` spawn, plus the ids pytest named
 * in `ERROR: not found:` / `ERROR: file or directory not found:` lines (printed
 * with an absolute path, so `cwd` is stripped to get the id back). Summary and
 * error lines are never collected ids.
 */
export function parseCollectedNodes(stdout, { cwd } = {}) {
  const collected = [];
  const notFound = [];
  const root = cwd === undefined ? null : resolve(cwd);
  for (const raw of String(stdout ?? '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    const missing = /^ERROR:\s*(?:file or directory )?not found:\s*(.+)$/u.exec(line);
    if (missing) {
      const named = missing[1].trim();
      const relativePath = root === null ? null : relativeInside(root, named);
      const path = relativePath !== null && relativePath !== ''
        ? normalisePath(relativePath)
        : normalisePath(named);
      notFound.push(path);
      continue;
    }
    if (/^(?:ERROR|FAILED|WARNING|E)\b/u.test(line) || line.startsWith('=')) continue;
    if (!/\.py(?:::.+)?$/u.test(line)) continue;
    let id = normalisePath(line);
    if (root !== '' && id.startsWith(root)) id = id.slice(root.length);
    collected.push(id);
  }
  return { collected, notFound };
}

/**
 * Keep the ids the collect-only spawn resolved; drop the rest. Only positive
 * evidence drops an id: collection produced node ids (so the set is a real
 * collected set), or pytest named the id as missing. A run that collected
 * nothing and named nothing (an env that cannot collect at all) is
 * inconclusive, and every id survives to the test run — the same conservative
 * rule the zero-execution verdict applies.
 */
export function filterUncollected(ids, { collected, notFound }) {
  const conclusive = collected.length > 0;
  const named = new Set(notFound);
  const kept = [];
  const dropped = [];
  for (const id of ids) {
    const norm = normalisePath(id);
    const missing = [...named].some((hit) => hit === norm || hit.endsWith(`/${norm}`));
    const resolved = !conclusive || collected.some((hit) => hit === norm
      || hit.endsWith(`/${norm}`)
      || hit.includes(`/${norm}::`)
      || hit.includes(`/${norm}[`)
      || hit.startsWith(`${norm}::`)
      || hit.startsWith(`${norm}[`));
    if (!missing && resolved) kept.push(id);
    else dropped.push(id);
  }
  return { kept, dropped };
}

/** `<clone>/src` when a `src/` dir exists, else `<clone>`. */
export function pythonPathFor(cloneDir) {
  const src = join(cloneDir, 'src');
  try {
    if (statSync(src).isDirectory()) return src;
  } catch {
    // no src/
  }
  return cloneDir;
}

export function venvPython(venvRoot, instanceId) {
  return process.platform === 'win32'
    ? join(venvRoot, instanceId, 'venv', 'Scripts', 'python.exe')
    : join(venvRoot, instanceId, 'venv', 'bin', 'python');
}

const ENV_ALLOW = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PYTHONUTF8',
]);

/** The child environment: an allow-list, never the launcher's whole env. */
export function childEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_ALLOW.has(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

function git(staging, args, cwd) {
  // `core.longpaths=true` keeps the local clone working under a deep out dir
  // (a `.git/promisor` pack path over 260 chars otherwise breaks the clone).
  return run('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
  });
}

const SUMMARY_LINE_RE = /no tests ran|(\d+\s+(?:passed|failed|error|errors|skipped|deselected|xfailed|xpassed|warning|warnings)\b)/iu;
const PROGRESS_LINE_RE = /^[.FEsxX]+(?:\s+\[\s*\d+%\]\s*)?$/u;

/** Parsed counts, node ids and collection-error facts from a `-q` pytest run. */
export function parsePytestOutput(stdout) {
  const text = String(stdout ?? '');
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  let summaryLine = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line !== '' && SUMMARY_LINE_RE.test(line)) { summaryLine = line; break; }
  }
  const count = (word) => {
    const match = new RegExp(`(\\d+)\\s+${word}\\b`, 'u').exec(summaryLine);
    return match ? Number(match[1]) : 0;
  };
  const failedIds = [];
  const errorIds = [];
  const collectionErrorFiles = [];
  const noCollectorLines = [];
  let progressSeen = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (PROGRESS_LINE_RE.test(line)) { progressSeen = true; continue; }
    const noCollector = /^ERROR: found no collectors for (.+)$/u.exec(line);
    if (noCollector) { noCollectorLines.push(noCollector[1].trim()); continue; }
    const failed = /^FAILED\s+(\S+)/u.exec(line);
    if (failed) { failedIds.push(failed[1]); continue; }
    const errored = /^ERROR\s+(\S+)/u.exec(line);
    if (errored) {
      if (errored[1].includes('::')) errorIds.push(errored[1]);
      else collectionErrorFiles.push(errored[1]);
    }
  }
  return {
    summaryLine,
    counts: {
      passed: count('passed'),
      failed: count('failed'),
      errors: count('errors'),
      skipped: count('skipped'),
    },
    failedIds,
    errorIds,
    collectionErrorFiles,
    noCollectorLines,
    progressSeen,
    noTestsRan: /no tests ran/iu.test(text),
    usageError: /found no collectors/iu.test(text) || /^(?:ERROR:\s*)?usage error/imu.test(text),
  };
}

function safeName(instanceId) {
  return String(instanceId).replace(/[\\/:*?"<>|]/gu, '_');
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${what} ${file}: ${error.message}`);
  }
}

export function loadSnapshot(file) {
  const rows = readJson(file, 'snapshot');
  const map = new Map();
  for (const row of rows) map.set(row.instance_id, row.files ?? {});
  return map;
}

export function loadTaskPack(file) {
  const rows = readJson(file, 'task pack');
  if (!Array.isArray(rows)) throw new Error('task pack must be a JSON array');
  return rows;
}

/** `<staging>/<repo-dirname>`; the repo's basename, with a couple of fallbacks. */
export function resolveStagingRepo(staging, repo) {
  const tail = String(repo).split('/').filter(Boolean).pop() ?? String(repo);
  const candidates = [
    join(staging, tail),
    join(staging, String(repo).replace(/[/\\]/gu, '__')),
    join(staging, String(repo)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`staging clone for repo ${repo} not found under ${staging} `
    + `(tried ${candidates.join(', ')})`);
}

/** Copy added/modified files from the arm and delete the removed ones. */
export function applyChanges({ cloneDir, armTaskDir, diff }) {
  const root = resolve(cloneDir);
  const safe = (rel) => {
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`change escapes the clone: ${rel}`);
    }
    return target;
  };
  for (const rel of [...diff.added, ...diff.modified]) {
    const target = safe(rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(armTaskDir, rel), target);
  }
  for (const rel of diff.deleted) {
    rmSync(safe(rel), { force: true });
  }
}

/** Clone the staging repo locally at `base_commit`. */
export function freshClone({ stagingRepo, cloneDir, baseCommit }) {
  mkdirSync(dirname(cloneDir), { recursive: true });
  rmSync(cloneDir, { recursive: true, force: true });
  const clone = git(stagingRepo, ['clone', '--no-hardlinks', stagingRepo, cloneDir]);
  if (clone.status !== 0) {
    throw new Error(`git clone failed: ${(clone.stderr || clone.stdout || '').trim()}`);
  }
  const checkout = git(stagingRepo, ['checkout', '--detach', baseCommit], cloneDir);
  if (checkout.status !== 0) {
    throw new Error(`git checkout ${baseCommit} failed: ${(checkout.stderr || '').trim()}`);
  }
  return cloneDir;
}

/**
 * The tree a fresh copy is cut from: `<overrideDir>/<instanceId>` when it
 * exists (the staged src tree, post-install, which carries build-generated
 * version modules and editable-install artifacts), else
 * `<baseDir>/<instanceId>`. Returns the chosen directory and which root won.
 */
export function resolveBaseTree({ baseDir, overrideDir, instanceId }) {
  const candidates = [];
  if (overrideDir !== undefined && overrideDir !== null) {
    candidates.push({ dir: join(overrideDir, String(instanceId)), kind: 'override' });
  }
  candidates.push({ dir: join(baseDir, String(instanceId)), kind: 'base' });
  for (const candidate of candidates) {
    try {
      if (statSync(candidate.dir).isDirectory()) return candidate;
    } catch {
      // try the next root
    }
  }
  return null;
}

/** Copy the chosen base tree (see `resolveBaseTree`) into `workDir`. */
export function freshBaseCopy({ baseDir, overrideDir, instanceId, workDir }) {
  const chosen = resolveBaseTree({ baseDir, overrideDir, instanceId });
  if (chosen === null) {
    const roots = [overrideDir, baseDir].filter((root) => root !== undefined && root !== null);
    throw new Error(`base tree for ${instanceId} not found under ${roots.join(' or ')}`);
  }
  mkdirSync(dirname(workDir), { recursive: true });
  rmSync(workDir, { recursive: true, force: true });
  // No `.git` in the dataset; drop one anyway so `git init` starts clean.
  cpSync(chosen.dir, workDir, {
    recursive: true,
    filter: (from) => basename(from) !== '.git',
  });
  return workDir;
}

/**
 * Make `workDir` a throwaway local repo with the base content committed, so
 * the existing `git apply` / `--3way` machinery works without a clone, a
 * remote, or a checkout-by-hash. Local only; no network.
 */
export function initLocalRepo(workDir) {
  const steps = [
    ['init', '-q'],
    ['config', 'core.autocrlf', 'false'],
    ['add', '-A'],
    ['-c', 'user.email=bench@example.test', '-c', 'user.name=bench',
      'commit', '-q', '--allow-empty', '-m', 'base'],
  ];
  for (const args of steps) {
    const step = git(workDir, args, workDir);
    if (step.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in base copy: `
        + `${(step.stderr || step.stdout || '').trim()}`);
    }
  }
  return workDir;
}

/**
 * Apply the test patch; plain `git apply` first, then `--3way`, then the same
 * two with `--ignore-whitespace`.
 *
 * The ISSUE-288 snapshots commit CRLF bytes while the dataset test patches are
 * LF, so the exact context match fails on every task in `--base-dir` mode. This
 * git build has no `--ignore-cr-at-eol`, so whitespace tolerance is the
 * fallback (the pre-flight gate's approach). The applied tree is still
 * validated by the pytest run, never trusted on its own. Returns the method
 * used: `plain`, `3way`, `ignore-whitespace` or `3way-ignore-whitespace`.
 */
export function applyTestPatch({ cloneDir, patchText, patchFile }) {
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, patchText, 'utf8');
  const attempts = [
    ['plain', ['apply', '--whitespace=nowarn', patchFile]],
    ['3way', ['apply', '--3way', '--whitespace=nowarn', patchFile]],
    ['ignore-whitespace', ['apply', '--ignore-whitespace', '--whitespace=nowarn', patchFile]],
    ['3way-ignore-whitespace',
      ['apply', '--3way', '--ignore-whitespace', '--whitespace=nowarn', patchFile]],
  ];
  const failures = [];
  for (const [method, args] of attempts) {
    const attempt = git(cloneDir, args, cloneDir);
    if (attempt.status === 0) return method;
    failures.push(`${method}: ${(attempt.stderr || attempt.stdout || '').trim()}`);
  }
  throw new Error(`git apply failed (${failures.join('; ')})`);
}

function uniqueIds(ids) {
  return [...new Set(ids)];
}

/**
 * A `sitecustomize` that puts the work copy's package directories first on any
 * namespace package a site `.pth` created at startup (`zope` is the live case:
 * its editable install's `nspkg.pth` eagerly builds `zope.__path__` from the
 * staging tree, so the work copy's tests import the staging module and pytest
 * aborts with `import file mismatch`). The shim directory is prepended to
 * PYTHONPATH, so it runs after the `.pth` files and before pytest imports.
 * Identical to dev/bench/swe-preflight.mjs's shim so both lanes agree.
 */
const WORK_SHIM = `import os
import sys

_src = os.environ.get("SWE_PREFLIGHT_SRC")
if _src:
    _src = os.path.normpath(_src)
    for _name, _module in list(sys.modules.items()):
        if "." in _name:
            continue
        _candidate = os.path.join(_src, _name)
        _path = getattr(_module, "__path__", None)
        if _path is None or not os.path.isdir(_candidate):
            continue
        _ckey = os.path.normcase(os.path.normpath(_candidate))
        try:
            _items = list(_path)
        except TypeError:
            continue
        if _items and os.path.normcase(os.path.normpath(_items[0])) == _ckey:
            continue
        _items = [_candidate] + [
            _p for _p in _items
            if os.path.normcase(os.path.normpath(_p)) != _ckey
        ]
        try:
            _module.__path__ = _items
        except (AttributeError, TypeError):
            pass
`;

/** Write the work-copy shim; returns its directory. */
export function writeWorkShim(workRoot) {
  const shimDir = join(workRoot, 'shim');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'sitecustomize.py'), WORK_SHIM, 'utf8');
  return shimDir;
}

/**
 * Grade one task. Never throws for a task-level failure: the failure is the
 * result (`verdict: error`), so one bad task cannot stop the batch.
 */
export function scoreTask(task, opts, log) {
  const startedAt = Date.now();
  const result = {
    instance_id: task.instance_id,
    verdict: 'error',
    f2p: { passed: 0, failed: 0, dropped: 0, notCollected: 0 },
    p2p: { passed: 0, failed: 0, dropped: 0, notCollected: 0 },
    f2pDropped: [],
    p2pDropped: [],
    changedFiles: 0,
    tamperedPaths: [],
    applyMethod: null,
    baseSource: null,
    seconds: 0,
    notes: '',
  };
  const finish = (patch = {}) => {
    Object.assign(result, patch);
    result.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    log.push({ task, result });
    return result;
  };

  try {
    const armTaskDir = join(opts.armDir, 'swe', task.instance_id);
    const pre = opts.snapshot.get(task.instance_id);
    if (!pre) return finish({ notes: 'no pre-run snapshot row for this instance' });
    if (!existsSync(armTaskDir)) return finish({ notes: `arm task dir missing: ${armTaskDir}` });

    const post = walkHashes(armTaskDir);
    const diff = diffTrees(pre, post);
    const changed = changedPaths(diff);
    result.changedFiles = changed.length;

    const patchPaths = pathsInPatch(task.test_patch ?? '');
    const tampered = tamperPaths(changed, patchPaths);
    result.tamperedPaths = tampered;

    const f2pSplit = splitIds(task.f2p ?? []);
    const p2pSplit = splitIds(task.p2p ?? []);
    result.f2p.dropped = f2pSplit.dropped.length;

    if (tampered.length > 0) {
      return finish({ verdict: 'tampered', notes: 'agent changed test-patch or conftest paths; pytest not run' });
    }
    if (f2pSplit.intact.length === 0) {
      return finish({ verdict: 'fail', notes: 'no intact FAIL_TO_PASS ids after dropping truncated ids' });
    }

    const cloneDir = opts.cloneDir ?? join(opts.outDir, `score-${safeName(task.instance_id)}`, 'repo');
    if (opts.baseDir) {
      const chosen = resolveBaseTree({
        baseDir: opts.baseDir,
        overrideDir: opts.baseOverrideDir,
        instanceId: task.instance_id,
      });
      result.baseSource = chosen === null ? 'missing' : chosen.kind;
      freshBaseCopy({
        baseDir: opts.baseDir,
        overrideDir: opts.baseOverrideDir,
        instanceId: task.instance_id,
        workDir: cloneDir,
      });
      initLocalRepo(cloneDir);
    } else {
      result.baseSource = 'staging';
      const stagingRepo = resolveStagingRepo(opts.staging, task.repo);
      freshClone({ stagingRepo, cloneDir, baseCommit: task.base_commit });
    }
    applyChanges({ cloneDir, armTaskDir, diff });
    result.applyMethod = applyTestPatch({
      cloneDir,
      patchText: task.test_patch ?? '',
      patchFile: join(opts.outDir, `${safeName(task.instance_id)}.test.patch`),
    });

    const python = venvPython(opts.venvRoot, task.instance_id);
    if (!existsSync(python)) {
      throw new Error(`venv python missing: ${python}`);
    }
    const srcDir = pythonPathFor(cloneDir);
    const shimDir = writeWorkShim(dirname(cloneDir));
    const pytestEnv = childEnv({
      PYTHONPATH: [shimDir, srcDir].join(delimiter),
      PYTHONDONTWRITEBYTECODE: '1',
      SWE_PREFLIGHT_SRC: srcDir,
    });
    const spawnPytest = (args, logName) => {
      const child = run(python, args, {
        cwd: cloneDir,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        env: pytestEnv,
      });
      const text = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      writeFileSync(join(opts.outDir, `${safeName(task.instance_id)}.${logName}`), text, 'utf8');
      const timedOut = child.error?.code === 'ETIMEDOUT' || Boolean(child.signal);
      return { child, text, timedOut };
    };
    const pytestArgs = (ids) => [
      '-m', 'pytest', ...ids, '-q', '--no-header', '-p', 'no:cacheprovider',
    ];

    // Collect-only pre-filter: one spawn naming every intact id. pytest still
    // collects the resolvable nodes when some ids are unknown (exit 4), so the
    // unknown ones are dropped by evidence; a spawn that produced no node ids
    // and named none is inconclusive and drops nothing.
    let f2pIds = f2pSplit.intact;
    let p2pIds = p2pSplit.intact;
    const collectIds = uniqueIds([...f2pIds, ...p2pIds]);
    let collectNote = '';
    if (collectIds.length > 0) {
      const collect = spawnPytest(
        ['-m', 'pytest', '--collect-only', ...collectIds, '-q', '--no-header',
          '-p', 'no:cacheprovider'],
        'collect.log',
      );
      if (collect.timedOut) {
        collectNote = `collect-only timed out after ${opts.timeoutMs}ms; pre-filter skipped`;
      } else if (!collect.child.error) {
        const nodes = parseCollectedNodes(collect.text, { cwd: cloneDir });
        const f2pFilter = filterUncollected(f2pIds, nodes);
        const p2pFilter = filterUncollected(p2pIds, nodes);
        f2pIds = f2pFilter.kept;
        p2pIds = p2pFilter.kept;
        result.f2pDropped = f2pFilter.dropped;
        result.p2pDropped = p2pFilter.dropped;
      }
    }
    result.f2p.dropped = f2pSplit.dropped.length + result.f2pDropped.length;
    result.p2p.dropped = result.p2pDropped.length;

    if (f2pIds.length === 0) {
      return finish({
        verdict: 'error',
        notes: `collect-only pre-filter dropped every FAIL_TO_PASS id: ${result.f2pDropped.join(', ')}`,
      });
    }

    // A summary line may name the test itself (`path::test`) or the whole file
    // (`path`, a collection error), so both count against every id under it.
    // An id is `notCollected` when its test file failed at import/collection:
    // pytest reports `ERROR <file>` and `ERROR: found no collectors for ...`.
    // Those ids are disclosed, never counted as failures.
    const classifyRun = (ids, parsed, exit) => {
      const failedIds = parsed.failedIds;
      const failedFor = (id) => failedIds.some((failed) => id === failed || id.startsWith(`${failed}::`));
      const erroredFor = (id) => parsed.errorIds
        .some((errored) => id === errored || id.startsWith(`${errored}::`));
      const collectionFiles = new Set(parsed.collectionErrorFiles.map(normalisePath));
      const notCollectedFor = (id) => {
        if (parsed.noCollectorLines.some((line) => normalisePath(line).endsWith(`/${id}`))) return true;
        return collectionFiles.has(normalisePath(id.split('::')[0]));
      };
      const notCollected = ids.filter(notCollectedFor);
      const graded = ids.filter((id) => !notCollectedFor(id));
      const failed = graded.filter((id) => failedFor(id) || erroredFor(id));
      // A run that executed no test proves nothing: it is an error, never a
      // pass. `errors` from collection are not executions; a test-level
      // `ERROR <id>` is.
      const executed = parsed.counts.passed + parsed.counts.failed
        + parsed.counts.skipped + parsed.errorIds.length;
      const zeroExecution = executed === 0 || parsed.noTestsRan
        || (exit === 4 && !parsed.progressSeen);
      return { notCollected, graded, failed, executed, zeroExecution };
    };

    // 1) FAIL_TO_PASS, alone: its ids and its summary decide the verdict.
    const f2pRun = spawnPytest(pytestArgs(f2pIds), 'pytest.log');
    if (f2pRun.timedOut) {
      return finish({ verdict: 'error', notes: `F2P pytest timed out after ${opts.timeoutMs}ms` });
    }
    if (f2pRun.child.error) throw f2pRun.child.error;
    const parsed = parsePytestOutput(f2pRun.text);
    const exit = f2pRun.child.status;
    const f2pClass = classifyRun(f2pIds, parsed, exit);

    const summaryNotes = [
      `F2P pytest exit ${String(exit)}`,
      parsed.summaryLine ? `summary: ${parsed.summaryLine}` : 'no summary line',
      f2pSplit.dropped.length > 0 ? `${f2pSplit.dropped.length} truncated F2P id(s) dropped` : '',
      result.f2pDropped.length + result.p2pDropped.length > 0
        ? `${String(result.f2pDropped.length + result.p2pDropped.length)} id(s) dropped by collect-only pre-filter`
        : '',
      collectNote,
      f2pClass.notCollected.length > 0
        ? `${String(f2pClass.notCollected.length)} F2P id(s) notCollected (collection error, excluded)`
        : '',
    ].filter(Boolean).join('; ');

    if (f2pClass.zeroExecution) {
      result.f2p = {
        passed: 0,
        failed: 0,
        dropped: result.f2p.dropped,
        notCollected: f2pClass.notCollected.length,
      };
      return finish({
        verdict: 'error',
        notes: `${summaryNotes}; no test executed (exit ${String(exit)}`
          + `${parsed.usageError ? ', usage error' : ''}${parsed.noTestsRan ? ', no tests ran' : ''})`,
      });
    }

    result.f2p = {
      passed: f2pClass.graded.length - f2pClass.failed.length,
      failed: f2pClass.failed.length,
      dropped: result.f2p.dropped,
      notCollected: f2pClass.notCollected.length,
    };

    if (f2pClass.graded.length === 0) {
      return finish({
        verdict: 'error',
        notes: `${summaryNotes}; every intact F2P id failed collection`,
      });
    }

    // 2) PASS_TO_PASS, in its own spawn. A malformed or collection-breaking
    // P2P list is disclosed in the counts and the notes; it never changes the
    // F2P verdict.
    let p2pNote = '';
    if (p2pIds.length > 0) {
      const p2pRun = spawnPytest(pytestArgs(p2pIds), 'p2p.pytest.log');
      if (p2pRun.timedOut) {
        p2pNote = `P2P pytest timed out after ${opts.timeoutMs}ms (excluded)`;
      } else if (p2pRun.child.error) {
        p2pNote = `P2P pytest failed to start: ${p2pRun.child.error.message} (excluded)`;
      } else {
        const p2pExit = p2pRun.child.status;
        const p2pParsed = parsePytestOutput(p2pRun.text);
        const p2pClass = classifyRun(p2pIds, p2pParsed, p2pExit);
        result.p2p = {
          passed: p2pClass.graded.length - p2pClass.failed.length,
          failed: p2pClass.failed.length,
          dropped: result.p2pDropped.length,
          notCollected: p2pClass.notCollected.length,
        };
        if (p2pClass.zeroExecution) {
          result.p2p.passed = 0;
          result.p2p.failed = 0;
          p2pNote = `P2P pytest exit ${String(p2pExit)}: no test executed (excluded)`;
        } else if (p2pClass.failed.length > 0 || p2pClass.notCollected.length > 0) {
          p2pNote = `P2P: ${String(p2pClass.failed.length)} failed, `
            + `${String(p2pClass.notCollected.length)} notCollected (does not gate the verdict)`;
        }
      }
    }

    // The stated grade: every graded FAIL_TO_PASS id passed, tamper clean, and
    // the F2P summary reports at least that many passes. A notCollected F2P id
    // is disclosed above and does not by itself fail the task.
    const clean = f2pClass.failed.length === 0
      && parsed.counts.passed >= f2pClass.graded.length;
    const notes = p2pNote === '' ? summaryNotes : `${summaryNotes}; ${p2pNote}`;
    return finish({ verdict: clean ? 'pass' : 'fail', notes });
  } catch (error) {
    return finish({ verdict: 'error', notes: error.message });
  }
}

/**
 * Score every task in the pack. Writes `swe-score.json`, `swe-score.md` and
 * one report + pytest log per task. Temp clones are removed unless
 * `keepClones`.
 */
export function runScoring(options) {
  const outDir = resolve(options.outDir ?? options.out);
  mkdirSync(outDir, { recursive: true });
  const snapshot = loadSnapshot(options.snapshot);
  const tasks = loadTaskPack(options.tasks);
  const opts = {
    armDir: resolve(options.armDir),
    staging: options.staging === undefined ? undefined : resolve(options.staging),
    baseDir: options.baseDir === undefined ? undefined : resolve(options.baseDir),
    baseOverrideDir: options.baseOverrideDir === undefined
      ? undefined : resolve(options.baseOverrideDir),
    venvRoot: resolve(options.venvRoot),
    snapshot,
    outDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const results = [];
  const log = [];
  for (const [index, task] of tasks.entries()) {
    // Short clone dir names: `<out>/score-t1` keeps Windows path lengths down;
    // the per-task report/log file names are unchanged.
    const cloneName = `score-t${String(index + 1)}`;
    opts.cloneDir = join(outDir, cloneName, 'repo');
    const result = scoreTask(task, opts, log);
    results.push(result);
    writeFileSync(join(outDir, `${safeName(task.instance_id)}.report.json`),
      `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (!options.keepClones) {
      rmSync(join(outDir, cloneName), { recursive: true, force: true });
    }
  }

  const summary = {
    tasks: results.length,
    passed: results.filter((r) => r.verdict === 'pass').length,
    failed: results.filter((r) => r.verdict === 'fail').length,
    tampered: results.filter((r) => r.verdict === 'tampered').length,
    errored: results.filter((r) => r.verdict === 'error').length,
  };
  const payload = { summary, results };
  writeFileSync(join(outDir, 'swe-score.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'swe-score.md'), renderMarkdown(summary, results), 'utf8');
  return payload;
}

export function renderMarkdown(summary, results) {
  const lines = [
    '# SWE score',
    '',
    `tasks ${String(summary.tasks)}; passed ${String(summary.passed)}; `
      + `failed ${String(summary.failed)}; tampered ${String(summary.tampered)}; `
      + `errored ${String(summary.errored)}`,
    '',
    '| instance | verdict | F2P pass/fail/dropped/notColl | P2P pass/fail/notColl | changed | tampered | apply | seconds |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(`| ${r.instance_id} | ${r.verdict} `
      + `| ${String(r.f2p.passed)}/${String(r.f2p.failed)}/${String(r.f2p.dropped)}/${String(r.f2p.notCollected ?? 0)} `
      + `| ${String(r.p2p.passed)}/${String(r.p2p.failed)}/${String(r.p2p.notCollected ?? 0)} `
      + `| ${String(r.changedFiles)} `
      + `| ${r.tamperedPaths.length === 0 ? '-' : r.tamperedPaths.join(', ')} `
      + `| ${r.applyMethod ?? '-'} | ${String(r.seconds)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const SCORE_OPTIONS = optionsOf([
  ['--arm-dir', 'string'], ['--snapshot', 'string'], ['--tasks', 'string'],
  ['--staging', 'string'], ['--base-dir', 'string'], ['--base-override-dir', 'string'],
  ['--venv-root', 'string'], ['--out', 'string'], ['--timeout-ms', 'string'],
  ['--keep-clones', 'boolean'],
  ['--help', 'boolean', 'help', { short: 'h' }],
]);

export function parseArgs(argv) {
  const opts = { keepClones: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  const { values } = parseDevArgs(argv, {
    options: SCORE_OPTIONS,
    // This script's own two unknown-wordings, kept exactly: a dashed name is
    // an unknown flag, anything else an unknown argument.
    unknown: (rawName) => (rawName.startsWith('--')
      ? `unknown flag: ${rawName}`
      : `unknown argument: ${rawName}`),
  });
  Object.assign(opts, values);
  if (values.timeoutMs !== undefined) {
    const ms = Number(values.timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout-ms needs a positive number, got ${values.timeoutMs}`);
    opts.timeoutMs = ms;
  }
  return opts;
}

const USAGE = `usage: node dev/bench/swe-score.mjs --arm-dir <dir> --snapshot <file> \\
  --tasks <file> (--staging <dir> | --base-dir <dir> [--base-override-dir <dir>]) \\
  --venv-root <dir> --out <dir> [--keep-clones] [--timeout-ms N]`;

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`swe-score.mjs: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.baseOverrideDir !== undefined && !opts.baseDir) {
    process.stderr.write(`swe-score.mjs: --base-override-dir needs --base-dir\n${USAGE}\n`);
    return 2;
  }
  const required = [
    ['armDir', '--arm-dir'], ['snapshot', '--snapshot'], ['tasks', '--tasks'],
    ['venvRoot', '--venv-root'], ['out', '--out'],
  ];
  if (!opts.baseDir) required.push(['staging', '--staging']);
  const missing = required.filter(([key]) => !opts[key]).map(([, flag]) => flag);
  if (missing.length > 0) {
    process.stderr.write(`swe-score.mjs: missing ${missing.join(', ')}\n${USAGE}\n`);
    return 2;
  }
  const payload = runScoring(opts);
  process.stdout.write(`${JSON.stringify(payload.summary)}\n`);
  return 0;
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
