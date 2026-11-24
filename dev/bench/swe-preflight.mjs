#!/usr/bin/env node
/**
 * Base-image pre-flight gate for the leak-safe 110 campaign (plan
 * docs/plans/2026-11-18-leak-safe-110/plan.md, gate 2). No model is involved:
 * every check runs the packaged venv python against a fresh copy of the staged
 * pristine snapshot, with only the task's test patch applied.
 *
 * Per task:
 *   a. `pytest --collect-only` over every intact F2P + P2P id; the ids the
 *      collect run could not resolve are recorded per kind. A truncated id
 *      carries a SPACE after `::` (the selection heuristic in
 *      dev/bench/swe-score.mjs `splitIds`; the stager uses the same rule);
 *   b. the F2P ids run at base. At least one must FAIL; a passing F2P id or a
 *      run with no F2P failure is the unusable base state;
 *   c. the P2P ids are recorded at base (collected, passed, failed, errored)
 *      as the campaign's base-state reference. They NEVER gate: swe-score.mjs
 *      treats P2P as reported rows, so a missing/truncated/failed/errored P2P
 *      id only annotates the task.
 *
 * The gate mirrors what actually breaks scoring: the scorer grades the F2P
 * ids pytest actually ran, dropping ids it cannot collect. So a task is
 * quarantined IFF no F2P id failed at base (`f2pAtBase.failed === 0`), an F2P
 * id passed at base (`f2pAtBase.passed > 0`), or our own pytest invocation
 * failed (timeout/crash, `harness-error`). Missing or truncated ids are
 * recorded per kind (`collect.missingF2p` / `missingP2p` / `truncatedF2p` /
 * `truncatedP2p`) as notes; a task with at least one F2P failure is
 * `ok-with-notes`. A task whose every F2P id is missing/truncated has
 * `failed === 0` and is quarantined by the same rule.
 *
 * A quarantined task is retried once in a fresh work tree; still quarantined
 * after the retry means the campaign drops it and regenerates its brief from a
 * task pack without it. A task carrying only notes is not retried. Venvs are
 * never modified.
 *
 * Usage:
 *   node dev/bench/swe-preflight.mjs --bench-root <dir> --staging-root <dir>
 *     --venv-root <dir> --out <dir> [--jobs 4] [--timeout-ms 600000]
 *     [--only <instance_id>]
 *
 * Inputs (stager output, dev/bench/swe-stage-leak-safe.mjs):
 *   <bench-root>/task-pack.json   [{instance_id, repo, base_commit, test_patch, f2p, p2p}]
 *   <bench-root>/snapshot.json    [{instance_id, files: {relpath: sha256}}]
 *   <staging-root>/leak-safe-110/src/swe/<instance_id>/  pristine snapshot tree
 *   <venv-root>/<instance_id>/venv/  deps-only venv
 *
 * Outputs: `<out>/preflight.json` (tasks + summary + quarantine list) and
 * `<out>/quarantine.json` (array of instance_ids), plus one pytest log per
 * attempt under `<out>/logs/`.
 *
 * Mechanics deliberately mirror dev/bench/swe-score.mjs: fresh snapshot copy,
 * throwaway `git init` with the base committed, `git apply` plain then
 * `--3way`, `-m pytest <ids> -q --no-header -p no:cacheprovider`, the same
 * venv python, PYTHONPATH = `<repo>/src` when that dir exists else `<repo>`,
 * an allow-listed child env, and the same id-truncation / notCollected rules.
 * The ids go on the command line in one run, exactly as the scorer does.
 *
 * One extra apply fallback exists on purpose: the dataset snapshots were
 * materialized on Windows and commit CRLF, while the dataset test patches are
 * LF, so a plain `git apply` fails on every task. swe-prep.mjs's validation
 * tolerates that ("a repo that commits CRLF keeps those bytes in the arm"); this
 * git build has no `--ignore-cr-at-eol`, so the fallback is
 * `git apply --ignore-whitespace`. The applied tree is still validated by the
 * F2P/P2P runs below, never trusted on its own.
 *
 * Exit codes: 0 = every task ok; 1 = at least one quarantined (listed on
 * stdout); 2 = bad arguments or an unreadable pack.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';
import {
  applyTestPatch, childEnv, freshBaseCopy, initLocalRepo, isExcludedPath, loadSnapshot,
  loadTaskPack, parsePytestOutput, pythonPathFor, splitIds, venvPython, walkHashes,
} from './swe-score.mjs';

export const DEFAULT_TIMEOUT_MS = 600_000;
/** pytest children are the expensive part; the gate never runs more than 4. */
export const MAX_JOBS = 4;

const USAGE = `usage: node dev/bench/swe-preflight.mjs --bench-root <dir> --staging-root <dir> \\
  --venv-root <dir> --out <dir> [--jobs 4] [--timeout-ms 600000] [--only <instance_id>]`;

const PREFLIGHT_OPTIONS = optionsOf([
  ['--bench-root', 'string'],
  ['--staging-root', 'string'],
  ['--venv-root', 'string'],
  ['--out', 'string'],
  ['--jobs', 'string'],
  ['--timeout-ms', 'string'],
  ['--only', 'string'],
]);

/** Codes that quarantine a task: each one means scoring would break. */
const QUARANTINE_CODES = [
  'no-ids',
  'f2p-pre-passed',
  'collection-error',
  'f2p-no-failure',
  'harness-error',
];

/** Codes recorded as notes: the task stays usable, P2P never gates. */
const NOTE_CODES = [
  'f2p-truncated-id',
  'f2p-id-missing',
  'p2p-truncated-id',
  'p2p-id-missing',
  'p2p-fails-at-base',
  'p2p-errors-at-base',
];

const REASON_CODES = [...QUARANTINE_CODES, ...NOTE_CODES];

function unique(values) {
  return [...new Set(values)];
}

function safeName(instanceId) {
  return String(instanceId).replace(/[\\/:*?"<>|]/gu, '_');
}

function normalise(path) {
  return String(path).split('\\').join('/');
}

/** The first path whose two hashes differ, or null when the maps agree. */
function firstHashDifference(expected, actual) {
  for (const path of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[path] !== actual[path]) return path;
  }
  return null;
}

/**
 * Hashes the snapshot comparison cares about. The snapshot was built with
 * `__pycache__` / `.pyc` (and the other swe-score exclusions) left out, so a
 * checked-in `*.cpython-34.pyc` in a dataset tree is not a mutation.
 */
function filterHashes(hashes) {
  const out = {};
  for (const [path, hash] of Object.entries(hashes)) {
    if (!isExcludedPath(path)) out[path] = hash;
  }
  return out;
}

function runGit(cwd, args) {
  return spawnSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
  });
}

/**
 * The scorer's apply (plain, then `--3way`), with the CRLF-tolerant fallback
 * the staged (Windows-materialized) snapshots need. Returns the method used.
 */
export function applyPatchTolerant({ repo, patchText, patchFile }) {
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, patchText, 'utf8');
  try {
    return applyTestPatch({ cloneDir: repo, patchText, patchFile });
  } catch (error) {
    const tolerant = runGit(repo, ['apply', '--ignore-whitespace', '--whitespace=nowarn', patchFile]);
    if (tolerant.status === 0) return 'ignore-whitespace';
    throw error;
  }
}

/**
 * Collected node ids from `pytest --collect-only -q` stdout: one id per line
 * that names a test, never the `ERROR`/`FAILED` short-summary lines.
 */
export function parseCollectedIds(stdout) {
  const ids = new Set();
  for (const raw of String(stdout ?? '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || !line.includes('::')) continue;
    if (/^(?:ERROR|FAILED|WARNING|E)\b/u.test(line)) continue;
    ids.add(normalise(line));
  }
  return ids;
}

/**
 * How many tests the pytest run itself reported executing: passed, failed,
 * skipped and errored rows. `classifyIds` infers an id's "passed" state from
 * the absence of a failure/error row, so this count is the evidence that the
 * ids were actually run and not silently truncated (ISSUE-504).
 */
export function pytestExecutedCount(parsed) {
  return parsed.counts.passed + parsed.counts.failed
    + parsed.counts.skipped + parsed.errorIds.length;
}

/**
 * Split the ids a pytest run reported into failed / errored / passed, using
 * the scorer's matching rules. A run that executed nothing marks every id
 * errored — a usage error or a collection abort must never look like a pass.
 */
export function classifyIds(ids, parsed, { exit = 0 } = {}) {
  const failedIds = parsed.failedIds.map(normalise);
  const errorIds = parsed.errorIds.map(normalise);
  const collectionFiles = new Set(parsed.collectionErrorFiles.map(normalise));
  const noCollectorLines = parsed.noCollectorLines.map(normalise);
  const executed = pytestExecutedCount(parsed);
  const zeroExecution = executed === 0 || parsed.noTestsRan
    || (exit === 4 && !parsed.progressSeen);
  const notCollected = (testId) => {
    const norm = normalise(testId);
    if (noCollectorLines.some((line) => line.endsWith(`/${norm}`))) return true;
    return collectionFiles.has(norm.split('::')[0]);
  };
  const failed = [];
  const errored = [];
  const passed = [];
  for (const testId of ids) {
    const norm = normalise(testId);
    if (zeroExecution) {
      errored.push(testId);
      continue;
    }
    if (failedIds.some((hit) => norm === hit || norm.startsWith(`${hit}::`))) failed.push(testId);
    else if (notCollected(testId)
      || errorIds.some((hit) => norm === hit || norm.startsWith(`${hit}::`))) errored.push(testId);
    else passed.push(testId);
  }
  return { failed, errored, passed };
}

/**
 * Quarantine codes for one attempt. Diagnostic only: the verdict itself is the
 * `failed === 0 || passed > 0 || error` rule below, which a mixed run (some
 * F2P failed, some errored) passes.
 */
export function verdictReasons(result) {
  const reasons = [];
  const add = (code) => {
    if (!reasons.includes(code)) reasons.push(code);
  };
  if (result.noIds === true) add('no-ids');

  const f2p = result.f2pAtBase ?? {};
  const f2pPassed = f2p.passed ?? 0;
  const f2pFailed = f2p.failed ?? 0;
  const f2pErrored = f2p.errored ?? 0;
  if (result.noIds !== true) {
    if (f2pPassed > 0) add('f2p-pre-passed');
    else if (f2pFailed === 0 && f2pErrored > 0) add('collection-error');
    else if (f2pFailed === 0) add('f2p-no-failure');
  }

  if (result.error !== null && result.error !== undefined) add('harness-error');
  return reasons;
}

/**
 * Non-gating notes for one attempt: unresolved ids (per kind) plus every P2P
 * outcome. A task with at least one F2P base failure stays usable with these
 * notes; the rows are kept in preflight.json as the base-state reference.
 */
export function verdictNotes(result) {
  const notes = [];
  const add = (code) => {
    if (!notes.includes(code)) notes.push(code);
  };
  const collect = result.collect ?? {};
  if ((collect.missingF2p ?? []).length > 0) add('f2p-id-missing');
  if ((collect.truncatedF2p ?? []).length > 0) add('f2p-truncated-id');
  if ((collect.missingP2p ?? []).length > 0) add('p2p-id-missing');
  if ((collect.truncatedP2p ?? []).length > 0) add('p2p-truncated-id');

  const p2p = result.p2pAtBase ?? {};
  if ((p2p.failed ?? 0) > 0) add('p2p-fails-at-base');
  if ((p2p.errored ?? 0) > 0) add('p2p-errors-at-base');
  return notes;
}

/**
 * The final gate: quarantine IFF no F2P id failed at base, an F2P id passed at
 * base, or the harness itself failed. Otherwise the task is usable, with notes
 * when any id was unresolved or any P2P row is base-red.
 */
export function attemptVerdict(result) {
  if (result.error !== null && result.error !== undefined) return 'quarantined';
  const f2p = result.f2pAtBase ?? {};
  if ((f2p.failed ?? 0) === 0) return 'quarantined';
  if ((f2p.passed ?? 0) > 0) return 'quarantined';
  return verdictNotes(result).length > 0 ? 'ok-with-notes' : 'ok';
}

/** One child, awaited; the pool only runs concurrently because this is spawn. */
function runPytest(python, args, { cwd, env, timeoutMs }) {
  // The timer below is armed from `timeoutMs`; a delay above the platform
  // maximum would fire at 1 ms, so it is refused before the child starts
  // (ISSUE-580).
  const tooLong = timerDelayRefusal(timeoutMs, '--timeout-ms');
  if (tooLong !== null) throw new Error(tooLong);
  return new Promise((resolvePromise) => {
    const child = spawn(python, ['-m', 'pytest', ...args], {
      cwd,
      windowsHide: true,
      env: childEnv(env),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', (status) => finish(status));
  });
}

function emptyAttempt() {
  return {
    collect: {
      ok: false,
      missingF2p: [],
      missingP2p: [],
      truncatedF2p: [],
      truncatedP2p: [],
    },
    f2pAtBase: { failed: 0, passed: 0, errored: 0 },
    p2pAtBase: { passed: 0, failed: 0, errored: 0, executed: 0 },
    noIds: false,
    error: null,
  };
}

/**
 * A `sitecustomize` that puts the work copy's package directories first on any
 * namespace package a site `.pth` created at startup (`zope` is the live case:
 * its editable install's `nspkg.pth` eagerly builds `zope.__path__` from the
 * staging tree, so the work copy's tests import the staging module and pytest
 * aborts with `import file mismatch`). The shim directory is prepended to
 * PYTHONPATH, so it runs after the `.pth` files and before pytest imports.
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
function writeWorkShim(workRoot) {
  const shimDir = join(workRoot, 'shim');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'sitecustomize.py'), WORK_SHIM, 'utf8');
  return shimDir;
}

/**
 * One full check in a fresh work tree: snapshot copy -> local git base ->
 * test patch -> collect -> F2P run -> P2P run. Never throws for a task-level
 * problem; that becomes `error` (red row `harness-error`).
 */
export async function assessAttempt(task, ctx, attemptNo) {
  const result = emptyAttempt();
  const f2p = splitIds(task.f2p ?? []);
  const p2p = splitIds(task.p2p ?? []);
  result.collect.truncatedF2p = f2p.dropped;
  result.collect.truncatedP2p = p2p.dropped;
  const intact = unique([...f2p.intact, ...p2p.intact]);
  if (f2p.intact.length === 0) {
    result.noIds = true;
    return result;
  }

  const safe = safeName(task.instance_id);
  const workRoot = join(ctx.outDir, 'work', `${safe}-${String(attemptNo)}`);
  const repo = join(workRoot, 'repo');
  const patchFile = join(workRoot, 'test.patch');
  const logFile = join(ctx.outDir, 'logs', `${safe}.attempt-${String(attemptNo)}.log`);
  const log = [];
  try {
    const stagedTree = join(ctx.baseDir, task.instance_id);
    if (!existsSync(stagedTree) || !statSync(stagedTree).isDirectory()) {
      throw new Error(`staged tree missing: ${stagedTree}`);
    }
    const expected = ctx.snapshot.get(task.instance_id);
    if (!expected) throw new Error(`snapshot.json has no row for ${task.instance_id}`);
    const mismatch = firstHashDifference(
      filterHashes(expected),
      filterHashes(walkHashes(stagedTree)),
    );
    if (mismatch !== null) {
      throw new Error(`staged tree differs from snapshot.json at ${mismatch}`);
    }

    freshBaseCopy({ baseDir: ctx.baseDir, instanceId: task.instance_id, workDir: repo });
    initLocalRepo(repo);
    const method = applyPatchTolerant({
      repo, patchText: task.test_patch ?? '', patchFile,
    });
    log.push(`apply: ${method}`);

    const python = venvPython(ctx.venvRoot, task.instance_id);
    if (!existsSync(python)) throw new Error(`venv python missing: ${python}`);
    const srcDir = pythonPathFor(repo);
    const shimDir = writeWorkShim(workRoot);
    const env = {
      PYTHONPATH: [shimDir, srcDir].join(delimiter),
      PYTHONDONTWRITEBYTECODE: '1',
      SWE_PREFLIGHT_SRC: srcDir,
    };
    const common = ['--no-header', '-p', 'no:cacheprovider'];
    const show = (label, run) => log.push(
      `${label}: exit ${String(run.status)}${run.timedOut ? ' (timed out)' : ''}\n`
      + `${run.stdout}${run.stderr}`,
    );

    // a. every intact id must be collectable.
    const collectRun = await runPytest(python, [...intact, '--collect-only', '-q', ...common], {
      cwd: repo, env, timeoutMs: ctx.timeoutMs,
    });
    show('collect', collectRun);
    if (collectRun.timedOut) {
      result.error = `collect-only timed out after ${String(ctx.timeoutMs)}ms`;
      return result;
    }
    const collected = parseCollectedIds(collectRun.stdout);
    result.collect.missingF2p = f2p.intact
      .filter((testId) => !collected.has(normalise(testId)));
    result.collect.missingP2p = p2p.intact
      .filter((testId) => !collected.has(normalise(testId)));
    result.collect.ok = result.collect.missingF2p.length === 0
      && result.collect.missingP2p.length === 0
      && result.collect.truncatedF2p.length === 0
      && result.collect.truncatedP2p.length === 0;

    // b. FAIL_TO_PASS must fail at base (a pass is the red `f2p-pre-passed`).
    if (f2p.intact.length > 0) {
      const run = await runPytest(python, [...f2p.intact, '-q', ...common], {
        cwd: repo, env, timeoutMs: ctx.timeoutMs,
      });
      show('f2p', run);
      if (run.timedOut) {
        result.error = `F2P pytest timed out after ${String(ctx.timeoutMs)}ms`;
        return result;
      }
      const parsed = parsePytestOutput(`${run.stdout}${run.stderr}`);
      const split = classifyIds(f2p.intact, parsed, { exit: run.status });
      result.f2pAtBase = {
        failed: split.failed.length,
        passed: split.passed.length,
        errored: split.errored.length,
      };
    }

    // c. PASS_TO_PASS must pass at base (a base-red P2P is named now).
    if (p2p.intact.length > 0) {
      const run = await runPytest(python, [...p2p.intact, '-q', ...common], {
        cwd: repo, env, timeoutMs: ctx.timeoutMs,
      });
      show('p2p', run);
      if (run.timedOut) {
        result.error = `P2P pytest timed out after ${String(ctx.timeoutMs)}ms`;
        return result;
      }
      const parsed = parsePytestOutput(`${run.stdout}${run.stderr}`);
      const split = classifyIds(p2p.intact, parsed, { exit: run.status });
      result.p2pAtBase = {
        passed: split.passed.length,
        failed: split.failed.length,
        errored: split.errored.length,
        /**
         * The run's own executed count (ISSUE-504). `classifyIds` calls every id
         * without a failure/error row passed, so a truncated run can still report
         * `passed === ids.length`; this field lets a caller prove execution.
         */
        executed: pytestExecutedCount(parsed),
      };
    }
  } catch (error) {
    result.error = error.message;
  } finally {
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${log.join('\n')}\n`, 'utf8');
    rmSync(workRoot, { recursive: true, force: true });
  }
  return result;
}

/** `--jobs` workers over the queue; at most MAX_JOBS. */
async function mapWithJobs(items, jobs, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(jobs, items.length) },
    () => run(),
  ));
  return results;
}

/**
 * The gate over a whole pack. `deps.runAttempt` replaces the real check in
 * tests; the retry and quarantine rules stay the same.
 */
export async function runPreflight(options, deps = {}) {
  const opts = {
    benchRoot: resolve(options.benchRoot),
    stagingRoot: resolve(options.stagingRoot),
    venvRoot: resolve(options.venvRoot),
    outDir: resolve(options.outDir ?? options.out),
    jobs: Math.min(MAX_JOBS, options.jobs ?? MAX_JOBS),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    only: options.only ?? null,
  };
  const tasks = loadTaskPack(join(opts.benchRoot, 'task-pack.json'));
  const snapshot = loadSnapshot(join(opts.benchRoot, 'snapshot.json'));
  let selected = tasks;
  if (opts.only !== null) {
    selected = tasks.filter((task) => task.instance_id === opts.only);
    if (selected.length === 0) throw new Error(`--only ${opts.only} is not in the task pack`);
  }
  mkdirSync(join(opts.outDir, 'logs'), { recursive: true });
  mkdirSync(join(opts.outDir, 'work'), { recursive: true });

  const ctx = {
    baseDir: join(opts.stagingRoot, 'leak-safe-110', 'src', 'swe'),
    venvRoot: opts.venvRoot,
    outDir: opts.outDir,
    timeoutMs: opts.timeoutMs,
    snapshot,
  };
  const runAttempt = deps.runAttempt ?? assessAttempt;
  const outcomes = await mapWithJobs(selected, opts.jobs, async (task) => {
    let attempt = await runAttempt(task, ctx, 1);
    let attempts = 1;
    if (attemptVerdict(attempt) === 'quarantined') {
      attempts = 2;
      attempt = await runAttempt(task, ctx, 2);
    }
    return {
      attempts,
      row: {
        instance_id: task.instance_id,
        collect: attempt.collect,
        f2pAtBase: attempt.f2pAtBase,
        p2pAtBase: attempt.p2pAtBase,
        error: attempt.error,
        notes: verdictNotes(attempt),
        verdict: attemptVerdict(attempt),
        reasons: verdictReasons(attempt),
      },
    };
  });

  const rows = outcomes.map((outcome) => outcome.row);
  const quarantine = rows.filter((row) => row.verdict === 'quarantined')
    .map((row) => row.instance_id);
  const counts = {};
  for (const code of REASON_CODES) {
    counts[code] = rows.filter((row) => row.reasons.includes(code)
      || row.notes.includes(code)).length;
  }
  counts.retried = outcomes.filter((outcome) => outcome.attempts === 2).length;
  const summary = {
    tasks: rows.length,
    ok: rows.filter((row) => row.verdict === 'ok').length,
    okWithNotes: rows.filter((row) => row.verdict === 'ok-with-notes').length,
    quarantined: quarantine.length,
    counts,
  };
  const payload = { tasks: rows, summary, quarantine };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, 'preflight.json'),
    `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(join(opts.outDir, 'quarantine.json'),
    `${JSON.stringify(quarantine, null, 2)}\n`, 'utf8');
  return payload;
}

export function renderReport(payload, outDir) {
  const lines = [`preflight ${String(payload.summary.tasks)} task(s)`];
  for (const row of payload.tasks) {
    const marks = row.reasons.length > 0
      ? `  [${row.reasons.join(', ')}]`
      : (row.notes.length > 0 ? `  (notes: ${row.notes.join(', ')})` : '');
    lines.push(`  ${row.verdict.padEnd(14)} ${row.instance_id}${marks}`);
  }
  lines.push(`summary: ok ${String(payload.summary.ok)}, `
    + `ok-with-notes ${String(payload.summary.okWithNotes)}, `
    + `quarantined ${String(payload.summary.quarantined)}`
    + `${payload.summary.counts.retried > 0 ? `, retried ${String(payload.summary.counts.retried)}` : ''}`);
  if (payload.quarantine.length > 0) {
    lines.push(`quarantine: ${payload.quarantine.join(', ')}`);
  }
  lines.push(`preflight.json: ${join(outDir, 'preflight.json')}`);
  lines.push('');
  return lines.join('\n');
}

/** CLI flags -> runPreflight options. Throws with the usage text's caller. */
export function parseCli(argv) {
  const { values } = parseDevArgs(argv, {
    options: PREFLIGHT_OPTIONS,
    refuse: (message) => {
      throw new Error(message);
    },
    help: `${USAGE}\n`,
  });
  for (const [key, flag] of [
    ['benchRoot', '--bench-root'], ['stagingRoot', '--staging-root'],
    ['venvRoot', '--venv-root'], ['out', '--out'],
  ]) {
    if (values[key] === undefined) throw new Error(`${flag} <dir> is required`);
  }
  const jobs = values.jobs === undefined ? MAX_JOBS : Number.parseInt(values.jobs, 10);
  if (!(Number.isInteger(jobs) && jobs > 0)) throw new Error('--jobs must be a positive integer');
  const timeoutMs = values.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(values.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  const tooLongTimeout = timerDelayRefusal(timeoutMs, '--timeout-ms');
  if (tooLongTimeout !== null) throw new Error(tooLongTimeout);
  return {
    benchRoot: values.benchRoot,
    stagingRoot: values.stagingRoot,
    venvRoot: values.venvRoot,
    outDir: values.out,
    jobs,
    timeoutMs,
    only: values.only ?? null,
  };
}

export async function main(argv) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (error) {
    process.stderr.write(`swe-preflight.mjs: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  let payload;
  try {
    payload = await runPreflight(opts);
  } catch (error) {
    process.stderr.write(`swe-preflight.mjs: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(renderReport(payload, opts.outDir));
  return payload.summary.quarantined > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
