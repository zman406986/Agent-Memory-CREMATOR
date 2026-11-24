#!/usr/bin/env node
/**
 * dsh test-rig driver — one scenario, one real dsh process, loopback mock only.
 *
 * Spec: `archive/2026-10-22-dsh-test-rig.md` §4. Order of operations is fixed:
 * evidence directory -> throwaway DSH_HOME + work dir -> mock server -> launch
 * `dsh --profile headless` -> arm the kill timer -> collect -> assert.
 *
 * Usage:
 *   node dev/dsh-rig/run.mjs --scenario <scenario.json> [--date <yyyy-mm-dd>] [--dsh-bin <bin.js>]
 *
 * Scenario JSON (slice A shape; §7 requires `perturbation`):
 *   {
 *     "slug": "smoke",
 *     "date": "2026-10-22",
 *     "task": "Reply with READY.",
 *     "timeoutMs": 60000,
 *     "perturbation": "change expect.session.assistantTexts[0] to a wrong string",
 *     "script": { "title": "...", "replies": [ ... ] },     // or "scriptPath"
 *     "expect": {
 *       "exitCode": 0,
 *       "mock": { "mainRequests": 1, "titleRequests": 1, "firstRequestKind": "main",
 *                 "mainHasTools": true, "mainHasSystem": true,
 *                 "mainUserTextContains": "...", "titleRequestsHaveNoTools": true },
 *       "session": { "assistantTexts": ["..."], "userTextContains": "...",
 *                    "eventTypesAbsent": ["tool/call"] },
 *       "stdout": { "finalText": "..." }
 *     }
 *   }
 *
 * Tier 3 (spec §8) is a scenario with `"provider": "a6-real"` and no `script`.
 * It starts no mock, sets no DEEPSEEK_BASE_URL, keeps the real `DSH_HOME` so the
 * credentials store resolves `A6_API_KEY`, and passes one extra `--patch` layer
 * (`tier3-patch.yml`) that re-enables `credentials`, routes the default model at
 * the a6 provider, and redirects the session/storage roots into the evidence dir.
 * Its `expect.realApi` block asserts the run really hit the provider: a usage row
 * with output tokens, the provider/model stamped in the log, and no loopback
 * endpoint anywhere in the run.
 *
 * Evidence lands in `scratchpad/dsh-rig/<date>-<slug>/` (gitignored, disposable).
 * The child environment is an explicit allow-list (ISSUE-260): PATH, the
 * home/temp/OS variables a process needs, proxy/TLS paths, dsh telemetry
 * switches, and the rig's own knobs. No provider key inherits; tier 1/2 add
 * only the rig dummy, and tier 3 adds only the credential-store *path*, which
 * dsh resolves inside the real `DSH_HOME`. The mock, ledger inspector and
 * taskkill children get the same env, and a tier-3 launch re-checks it for a
 * provider key immediately before spawn.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDist, pluginFileUrl } from './build-dist.mjs';
import { isPruneFire } from './prune-fires.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

const RIG_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(RIG_DIR));
const MOCK = join(RIG_DIR, 'mock-messages.mjs');

/** Dummy key. Anything else in the child environment is a bug. */
const DUMMY_KEY = 'mock-key-not-real';
/** Spec §4: 2x the scenario timeout, capped at 3 minutes. */
const MAX_WATCHDOG_MS = 180_000;
/** Only used when `--dsh-bin` is omitted and global lookup fails. */
const DSH_PACKAGE = ['@deepseek-ai', 'dsh', 'lib', 'bin.js'];
/** A stuck `dsh --version` must not hold the rig before the tier gate runs. */
const VERSION_PROBE_TIMEOUT_MS = 30_000;
/** Tier-3 route, exactly as the web profile spells it (spec §1, §8). */
const TIER3_PROVIDER = 'a6';
const TIER3_MODEL = 'deepseek-v4.1-flash-1017';

/**
 * The only parent variables a dsh child may inherit (ISSUE-260). A denylist
 * lets every credential it does not happen to name through, so the default is
 * "drop": PATH and the OS variables a process needs to start, the home/temp
 * roots, proxy/TLS paths, and dsh's own telemetry switches. Every provider key
 * — DEEPSEEK, OPENAI, A6, cloud — is absent unless this list names it.
 * `DSH_HOME`, the `RIG_*` path knobs and the route variables are never
 * inherited; `main()` writes them itself through `buildChildEnv`'s override
 * map.
 */
const INHERITED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'LANG', 'LC_ALL', 'TZ',
  // Egress through a corporate proxy and trust for a private CA. These are
  // URLs/paths, not credentials, and a child that cannot use them cannot reach
  // a real provider. Copied only when the parent sets them.
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);
/**
 * `NODE_OPTIONS` is deliberately NOT inherited. Unlike the proxy/TLS names it
 * can carry `--require`, `--import` or `--loader`, which run attacker-chosen
 * code inside every child before its own entry point. Allowing it would turn
 * the env allow-list into a code-execution channel, so it must stay absent
 * and cannot be written through the override map either.
 */
/** A prefix, not a name: a future telemetry switch is inherited without an edit. */
const INHERITED_ENV_PREFIXES = ['DSH_TELEMETRY_'];
/**
 * The keys the rig may write itself. `RIG_CREDENTIALS_PATH` is a store path,
 * never key material; `DEEPSEEK_API_KEY` is the tier-1/2 dummy and is absent
 * from a tier-3 child.
 */
const RIG_ENV_KEYS = new Set([
  'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'DSH_TELEMETRY_MODE', 'DSH_PERMISSION_MODE',
  'RIG_CREDENTIALS_PATH', 'RIG_SESSIONS_DIR', 'RIG_STORAGES_DIR',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'CREMATOR_RIG_DIST',
]);

/**
 * Build the child environment from an allow-list. Inherited names are copied
 * verbatim; `overrides` are the rig's own values and are refused unless they
 * are on `RIG_ENV_KEYS`, so a later edit cannot smuggle a provider key into a
 * child by adding an assignment.
 * @param {Record<string, string|undefined>} source
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
export function buildChildEnv(source = process.env, overrides = {}) {
  const out = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    const allowed = INHERITED_ENV_NAMES.has(upper)
      || INHERITED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (!allowed) continue;
    seen.add(upper);
    out[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!RIG_ENV_KEYS.has(key)) throw new Error(`run.mjs: ${key} is not an allow-listed child env key`);
    out[key] = value;
  }
  return out;
}

/**
 * Provider credential name families the tier-3 child must never carry
 * (ISSUE-260). A name is a credential only when the family also appears with a
 * credential suffix: `DEEPSEEK_BASE_URL` is a route, not a key.
 */
const PROVIDER_KEY_FAMILY = /(?:^|_)(?:A6|DEEPSEEK|OPENAI|ANTHROPIC|GITHUB|AWS)(?:_|$)/iu;
const CREDENTIAL_SUFFIX = /(?:KEY|TOKEN|SECRET|PASSWORD)/iu;
/**
 * Value shapes of real credentials. A key renamed to an allow-listed variable
 * still fails the guard; the value is never echoed in the error.
 */
const PROVIDER_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

/**
 * Fail closed when a child env still carries a provider credential. Tier 3
 * lets dsh resolve `A6_API_KEY` from the credential store inside the real
 * `DSH_HOME`, so no key may cross the process boundary as an environment
 * value. Both the variable name and the value shape are checked.
 * @param {Record<string, string>} env
 * @returns {void}
 */
export function assertNoProviderKeys(env) {
  for (const [key, value] of Object.entries(env)) {
    if (PROVIDER_KEY_FAMILY.test(key) && CREDENTIAL_SUFFIX.test(key)) {
      throw new Error(`run.mjs: tier-3 child env carries provider credential key ${key}; refusing to launch`);
    }
    if (PROVIDER_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`run.mjs: tier-3 child env value for ${key} has a provider credential shape; refusing to launch`);
    }
  }
}

/**
 * The version probe runs dsh itself, so it gets the same allow-listed env as a
 * launch: a `--version` call must not see a provider key either. It is bounded
 * so a slow or hung dsh cannot block the tier-3 gate; a timeout or non-zero
 * exit is loud, never an empty version string.
 * @param {string} binJs
 * @param {Record<string, string>} env
 * @param {number} [timeoutMs]
 * @returns {string}
 */
export function probeDshVersion(binJs, env, timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  const run = spawnSync(process.execPath, [binJs, '--version'], {
    encoding: 'utf8', windowsHide: true, env, timeout: timeoutMs,
  });
  if (run.error !== undefined && run.error !== null) {
    const code = run.error.code ?? run.error.message;
    const reason = code === 'ETIMEDOUT' ? `timed out after ${String(timeoutMs)} ms` : String(code);
    throw new Error(`run.mjs: dsh --version ${reason}`);
  }
  if (run.status !== 0) {
    const detail = (run.stderr ?? '').trim();
    throw new Error(`run.mjs: dsh --version exited ${String(run.status)}${detail === '' ? '' : `: ${detail}`}`);
  }
  return (run.stdout ?? '').trim();
}

const RUN_OPTIONS = optionsOf([
  ['--scenario', 'string'],
  ['--date', 'string'],
  ['--dsh-bin', 'string', 'dshBin'],
  ['--projection-out', 'string', 'projectionOut'],
  ['--projection-in', 'string', 'projectionIn'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: RUN_OPTIONS,
    prefix: 'run.mjs: ',
    help: 'usage: run.mjs --scenario <scenario.json> [--date <yyyy-mm-dd>] [--dsh-bin <path-to-bin.js>]\n'
      + '       [--projection-out <file>] [--projection-in <file>]\n',
  });
  const opts = {
    scenario: values.scenario ?? null,
    date: values.date ?? null,
    dshBin: values.dshBin ?? null,
    projectionOut: values.projectionOut ?? null,
    projectionIn: values.projectionIn ?? null,
  };
  if (opts.scenario === null) throw new Error('run.mjs: --scenario is required');
  if (opts.projectionOut !== null && opts.projectionIn !== null) {
    throw new Error('run.mjs: --projection-out and --projection-in cannot be combined');
  }
  return opts;
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * One expectation against a per-table/per-pass list of observed values. A
 * scalar means every observation must equal it (the shape every single-pass
 * scenario uses); an ARRAY states one value per observation, in order, and is
 * how a multi-launch scenario names a count that legitimately differs per pass.
 * The lengths must agree, so an array can never pass on a shorter run.
 */
function perTableMatches(want, seen) {
  if (Array.isArray(want)) {
    return seen.length === want.length && want.every((value, index) => seen[index] === value);
  }
  return seen.every((value) => value === want);
}

/**
 * Load the scenario and enforce the non-vacuity contract: a perturbation line,
 * and at least one assertion that is not the exit code.
 * @param {string} scenarioPath
 * @param {string|null} dateOverride
 * @returns {object}
 */
function loadScenario(scenarioPath, dateOverride) {
  const absolute = resolve(scenarioPath);
  const scenario = JSON.parse(readFileSync(absolute, 'utf8'));
  if (typeof scenario.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(scenario.slug)) {
    throw new Error('run.mjs: scenario.slug must be kebab-case ASCII');
  }
  if (typeof scenario.task !== 'string' || scenario.task.trim() === '') throw new Error('run.mjs: scenario.task must be a non-empty string');
  if (typeof scenario.perturbation !== 'string' || scenario.perturbation.trim() === '') {
    throw new Error('run.mjs: scenario has no perturbation field (spec §4 step 1, §7)');
  }
  const expect = scenario.expect;
  if (expect === null || typeof expect !== 'object') throw new Error('run.mjs: scenario.expect is required');
  const nonExit = Object.keys(expect).filter((key) => key !== 'exitCode');
  if (nonExit.length === 0) throw new Error('run.mjs: a scenario whose only assertion is exit code 0 is rejected (spec §7)');
  if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs <= 0) throw new Error('run.mjs: scenario.timeoutMs must be a positive integer');
  // Tier 3 (spec §8) has no mock script: a real provider answers. Every other
  // scenario is a scripted mock run. `provider` is the only switch.
  const realApi = scenario.provider === 'a6-real';
  if (scenario.provider !== undefined && !realApi) {
    throw new Error(`run.mjs: unknown provider ${JSON.stringify(scenario.provider)}; only "a6-real" selects tier 3`);
  }
  let script = null;
  if (!realApi) {
    if (scenario.script !== undefined) script = scenario.script;
    else if (typeof scenario.scriptPath === 'string') script = JSON.parse(readFileSync(resolve(dirname(absolute), scenario.scriptPath), 'utf8'));
    else throw new Error('run.mjs: scenario needs `script` or `scriptPath`');
  } else if (scenario.script !== undefined || scenario.scriptPath !== undefined) {
    throw new Error('run.mjs: a tier-3 scenario takes no script; the real provider answers');
  }
  const workFiles = scenario.workFiles === undefined ? {} : scenario.workFiles;
  if (workFiles === null || typeof workFiles !== 'object' || Array.isArray(workFiles)) {
    throw new Error('run.mjs: scenario.workFiles must be an object of relative path -> file content');
  }
  for (const [path, content] of Object.entries(workFiles)) {
    if (typeof content !== 'string') throw new Error(`run.mjs: scenario.workFiles[${JSON.stringify(path)}] must be a string`);
    const normalised = path.replace(/\\/gu, '/');
    if (normalised.startsWith('/') || /^[A-Za-z]:/u.test(normalised) || normalised.split('/').includes('..')) {
      throw new Error(`run.mjs: scenario.workFiles path ${JSON.stringify(path)} must be relative and stay inside the work dir`);
    }
  }
  let projectionPath = null;
  if (typeof scenario.projectionPath === 'string') {
    // A checked-in canonical projection: two runs of the same fixture must agree
    // with it, so the expectation is not derived from the run being checked.
    projectionPath = resolve(dirname(absolute), scenario.projectionPath);
    if (!existsSync(projectionPath)) throw new Error(`run.mjs: scenario.projectionPath not found at ${projectionPath}`);
  }
  // A `racoons` block mounts the rig plugin; its keys are the plugin's config
  // knobs. Refusing malformed values here is exit 2, before any process starts.
  let racoons = null;
  if (scenario.racoons !== undefined) {
    if (scenario.racoons === null || typeof scenario.racoons !== 'object' || Array.isArray(scenario.racoons)) {
      throw new Error('run.mjs: scenario.racoons must be an object of plugin config knobs');
    }
    racoons = scenario.racoons;
  }
  // Optional launches that resume the session the first launch created
  // (`--session-id`). dsh headless sends exactly one user message per process,
  // so a mid-session whole message such as `/prune` needs its own launch, and a
  // round ordinal that must continue across a resume needs one more.
  // `secondLaunch` is one object or an array of them, so a scenario names every
  // resume launch in order.
  const resumeLaunches = [];
  if (scenario.secondLaunch !== undefined) {
    const raw = scenario.secondLaunch;
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) throw new Error('run.mjs: scenario.secondLaunch must name at least one launch');
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('run.mjs: every secondLaunch entry must be an object');
      }
      if (typeof entry.task !== 'string' || entry.task.trim() === '') {
        throw new Error('run.mjs: every secondLaunch entry needs a non-empty task');
      }
      resumeLaunches.push({ task: entry.task });
    }
  }
  if (realApi && resumeLaunches.length > 0) {
    throw new Error('run.mjs: a tier-3 scenario takes no secondLaunch; resume is a mock-run shape');
  }
  return {
    slug: scenario.slug,
    date: dateOverride ?? scenario.date ?? today(),
    task: scenario.task,
    timeoutMs: scenario.timeoutMs,
    perturbation: scenario.perturbation,
    realApi,
    script,
    workFiles,
    projectionPath,
    patches: Array.isArray(scenario.patches) ? scenario.patches : [],
    racoons,
    resumeLaunches,
    expect,
  };
}

/** The session file dsh appends each event to. */
const SESSION_LOG_FILE = 'session.v4.jsonl';
/** A host that names the log itself (`session-<id>.v4.jsonl`). */
const SESSION_LOG_ID_PATTERN = /^session-.+\.v4\.jsonl$/u;

/**
 * Every persisted session log under a sessions root, sorted. Both the canonical
 * `session.v4.jsonl` and a host-named `session-<id>.v4.jsonl` are read: the
 * bench reader accepts both (`dev/bench/bench-run.mjs`), and a rig that matched
 * one name would let a host-named log escape the resume and the assertions.
 * @param {string} root
 * @returns {string[]}
 */
export function findSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()
        && (entry.name === SESSION_LOG_FILE || SESSION_LOG_ID_PATTERN.test(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The id a persisted log belongs to. `session.v4.jsonl` takes its directory
 * (`session-<uuid>`); a host-named `session-<id>.v4.jsonl` takes its own stem,
 * the same rule the bench's resume reader uses.
 * @param {string} file
 * @returns {string}
 */
export function sessionIdForLog(file) {
  const name = basename(file);
  if (name === SESSION_LOG_FILE) return basename(dirname(file));
  return name.slice(0, -'.v4.jsonl'.length);
}

/**
 * Resolve the installed package's `lib/bin.js`. Running that file with the
 * current Node avoids the `.cmd` shim, so the PID is the real process and
 * `taskkill /T` owns the whole tree.
 * @param {string|null} override
 * @returns {string} absolute path to bin.js
 */
function resolveDshBin(override) {
  if (override !== null) {
    const absolute = resolve(override);
    if (!existsSync(absolute)) throw new Error(`run.mjs: --dsh-bin not found at ${absolute}`);
    return absolute;
  }
  // Discovery helpers are children too: they get the same allow-listed env as
  // every other non-dsh child. A parent credential never rides into `npm root`
  // or `where` (ISSUE-260/270).
  const candidates = [];
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
    { encoding: 'utf8', windowsHide: true, env: buildChildEnv() });
  if (npmRoot.status === 0 && typeof npmRoot.stdout === 'string') candidates.push(join(npmRoot.stdout.trim(), ...DSH_PACKAGE));
  const where = spawnSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true, env: buildChildEnv() });
  if (where.status === 0 && typeof where.stdout === 'string') {
    const first = where.stdout.split(/\r?\n/u).find((line) => line.trim() !== '');
    if (first !== undefined) {
      const shimDir = dirname(first.trim());
      candidates.push(join(shimDir, 'node_modules', ...DSH_PACKAGE));
      candidates.push(join(shimDir, '..', 'node_modules', ...DSH_PACKAGE));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error('run.mjs: cannot locate dsh; pass --dsh-bin <path-to-bin.js>');
}

function writePatch(evidenceDir, extraRows) {
  const rows = [
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
  ];
  for (const row of extraRows) rows.push(...String(row).split(/\r?\n/u));
  const path = join(evidenceDir, 'patch.yml');
  writeFileSync(path, `${rows.join('\n')}\n`);
  return path;
}

/**
 * Tier-3 overlay (spec §8). Written into the evidence dir, never into
 * `~/.dsh`: the profile the real home carries stays exactly as shipped, and
 * only this path names a file here.
 *
 * Rows, in order:
 * - `credentials` re-enabled (headless disables it) and pointed at the real
 *   `.credentials.yaml` through `process.env`, so nothing about the key is
 *   spelled in the patch file or copied anywhere.
 * - the default model moved to the a6 route, and `llm-pi-ai` given that route
 *   so `agent-default-model` resolves; the model entry mirrors the web
 *   profile's (spec §1).
 * - the session and storage roots redirected into the evidence dir: tier 3
 *   keeps the real `DSH_HOME` (the credential store lives there), so without
 *   this redirect it would write into the real session store.
 * - the title call disabled: it is a second billed request that races process
 *   exit, and `expect.realApi` counts main requests only.
 * A scenario's own `patches` rows are appended last, so the documented
 * perturbation (disable the `credentials` row) is expressible without editing
 * this file.
 * @param {string} evidenceDir
 * @param {string[]} extraRows
 * @returns {string} path of the overlay file
 */
function writeTier3Patch(evidenceDir, extraRows) {
  const rows = [
    '- id: credentials',
    '  disabled: false',
    // The store path is an env value so the file carries no home directory.
    '  config:',
    '    path: !!js process.env.RIG_CREDENTIALS_PATH',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${TIER3_PROVIDER}`,
    `    model: ${TIER3_MODEL}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${TIER3_PROVIDER}:`,
    `        displayName: ${TIER3_PROVIDER}`,
    `        apiKeyEnv: A6_API_KEY`,
    '        api: openai-completions',
    '        baseURL: https://api.a6api.com/v1',
    '        models:',
    `          - id: ${TIER3_MODEL}`,
    `            name: ${TIER3_MODEL}`,
    '            input:',
    '              - text',
    '            contextWindow: 400000',
    // The web profile offers these levels; naming them keeps the resolved
    // model identical to the one the owner uses interactively.
    '            reasoningEfforts:',
    '              off: null',
    '              low: low',
    '              medium: medium',
    '              max: max',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js process.env.RIG_SESSIONS_DIR",
    '    compression: none',
    '- id: storage-json',
    '  config:',
    "    root: !!js process.env.RIG_STORAGES_DIR",
  ];
  for (const row of extraRows) rows.push(...String(row).split(/\r?\n/u));
  const path = join(evidenceDir, 'tier3-patch.yml');
  writeFileSync(path, `${rows.join('\n')}\n`);
  return path;
}

/**
 * The mount row: a local plugin loaded from a `file:///` specifier, with the
 * scenario's `racoons` block as its config plus the paths the driver owns.
 *
 * The plugin's config is written as one-line JSON so nothing in it needs YAML
 * escaping; dsh hands the parsed object to `apply(ctx, config)`.
 * @param {{plugin: string, config: object}} mount
 * @returns {string[]} patch rows
 */
function mountRows(mount) {
  return [
    '- insert:',
    '    - id: racoons-mount',
    `      name: '${mount.plugin.replace(/'/gu, "''")}'`,
    `      config: ${JSON.stringify(mount.config)}`,
  ];
}

function timestamp() {
  return new Date().toISOString();
}

async function main() {
  let opts;
  let scenario;
  try {
    opts = parseArgs(process.argv.slice(2));
    scenario = loadScenario(opts.scenario, opts.date);
    if (scenario.date !== today()) {
      throw new Error(`run.mjs: refusing to write evidence under a date that is not today (${scenario.date} vs ${today()}); scratchpad evidence is always dated at run time`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  // Tier-3 gate (spec §8): off unless the operator opts in AND names the kill
  // timer. A missing timer aborts before launch — the timer is the only thing
  // that bounds a real provider's wall clock.
  if (scenario.realApi) {
    const armed = process.env.RIG_KILL_TIMER_MS;
    if (process.env.RIG_REAL_API !== '1') {
      process.stderr.write('run.mjs: a tier-3 scenario needs RIG_REAL_API=1 (spec §8); refusing to spend a real call\n');
      process.exit(2);
    }
    if (armed === undefined || !/^[1-9][0-9]*$/u.test(armed)) {
      process.stderr.write('run.mjs: a tier-3 scenario needs RIG_KILL_TIMER_MS set to a positive integer (spec §8); refusing to launch without a bound\n');
      process.exit(2);
    }
    // A bound above the platform maximum would fire the watchdog at 1 ms, not
    // after a day (ISSUE-580).
    const tooLongArmed = timerDelayRefusal(Number(armed), 'RIG_KILL_TIMER_MS');
    if (tooLongArmed !== null) {
      process.stderr.write(`run.mjs: ${tooLongArmed}; refusing to launch\n`);
      process.exit(2);
    }
    if (scenario.timeoutMs > Number(armed)) {
      process.stderr.write(`run.mjs: tier 3 abort bound ${String(scenario.timeoutMs)} ms exceeds RIG_KILL_TIMER_MS ${armed}; shrink the scenario\n`);
      process.exit(2);
    }
  }

  const evidenceDir = join(REPO_ROOT, 'scratchpad', 'dsh-rig', `${scenario.date}-${scenario.slug}`);
  // Evidence is per run, never accumulated: a stale session log from an earlier
  // run must not be able to satisfy this run's assertions.
  rmSync(evidenceDir, { recursive: true, force: true });
  // Tier 3 keeps the real DSH_HOME: the credential store lives under it and dsh
  // is the only thing allowed to resolve A6_API_KEY from it (spec §8). The
  // overlay moves the two writable roots into the evidence dir so nothing lands
  // in the real session store.
  const realHome = scenario.realApi ? homedir() : null;
  const credentialsPath = realHome === null ? null : join(realHome, '.dsh', '.credentials.yaml');
  if (credentialsPath !== null && !existsSync(credentialsPath)) {
    process.stderr.write(`run.mjs: tier 3 needs the credential store at ${credentialsPath} (ref A6_API_KEY); it is absent\n`);
    process.exit(2);
  }
  const homeDir = scenario.realApi ? join(realHome, '.dsh') : join(evidenceDir, 'home');
  const workDir = join(evidenceDir, 'work');
  mkdirSync(workDir, { recursive: true });
  if (!scenario.realApi) mkdirSync(homeDir, { recursive: true });
  const sessionsDir = scenario.realApi ? join(evidenceDir, 'sessions') : join(homeDir, 'sessions');
  const storagesDir = scenario.realApi ? join(evidenceDir, 'storages') : join(homeDir, 'storages');
  for (const [path, content] of Object.entries(scenario.workFiles)) {
    const target = join(workDir, ...path.replace(/\\/gu, '/').split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const scriptPath = join(evidenceDir, 'script.json');
  if (scenario.realApi) writeFileSync(scriptPath, '{}\n');
  else writeFileSync(scriptPath, `${JSON.stringify(scenario.script, null, 2)}\n`);
  // A mounted scenario needs the compiled workspace (a dsh child does not strip
  // types) and a plugin row naming this plugin file. The compile step is shared
  // by both scenarios and is a no-op when the sources are unchanged.
  let mount = null;
  if (scenario.racoons !== null) {
    try {
      ensureDist({ quiet: true });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    mount = {
      plugin: pluginFileUrl(),
      config: {
        ...scenario.racoons,
        evidenceDir: join(evidenceDir, 'racoons'),
        // ADR-0013: the entry opens its own per-session ledger under
        // `<root>/sessions/<id>/ledger.sqlite`. The root is the throwaway one
        // under the evidence dir, so a rig run never touches the real `~/.dsh`
        // and a second launch on the same root finds the first launch's file.
        crematorStorageRoot: join(evidenceDir, 'racoons', 'storage'),
      },
    };
    mkdirSync(join(evidenceDir, 'racoons'), { recursive: true });
  }
  const patchPath = scenario.realApi
    ? writeTier3Patch(evidenceDir, scenario.patches)
    : writePatch(evidenceDir, mount === null ? scenario.patches : [...mountRows(mount), ...scenario.patches]);
  const requestLog = join(evidenceDir, 'requests.jsonl');
  writeFileSync(requestLog, '');

  const binJs = resolveDshBin(opts.dshBin);
  const childEnv = buildChildEnv(process.env, {
    DSH_HOME: homeDir,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'danger-full-access',
    // Tier 3 reads the store through the credentials row; the path is handed
    // over as an env value so the overlay file names no home directory. This is
    // a *path*, not key material — the value itself never leaves dsh.
    ...(scenario.realApi ? {
      RIG_CREDENTIALS_PATH: credentialsPath,
      RIG_SESSIONS_DIR: sessionsDir,
      RIG_STORAGES_DIR: storagesDir,
    } : {}),
    // The mount plugin loads the pre-compiled workspace from here; without it,
    // `apply` refuses rather than importing TypeScript sources.
    ...(mount === null ? {} : { CREMATOR_RIG_DIST: join(REPO_ROOT, 'scratchpad', 'dsh-rig', 'dist') }),
  });
  // The guard is a no-op for tiers 1/2 (they carry the rig dummy on purpose).
  // For tier 3 it runs before the version probe and again immediately before
  // every launch, so no spawn happens with a key in the env.
  const guardTier3Env = () => {
    if (!scenario.realApi) return;
    try {
      assertNoProviderKeys(childEnv);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
  };
  // Every non-dsh child (mock, ledger inspector, taskkill) gets this same
  // scrubbed env, never the parent's full environment.
  const killTree = (pid) => spawn('taskkill', ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, stdio: 'ignore', env: childEnv });
  const inspectLedger = (ledger, blobs, extra = []) => spawnSync(process.execPath,
    [join(RIG_DIR, 'inspect-ledger.mjs'), '--ledger', ledger, '--blobs', blobs, ...extra],
    { encoding: 'utf8', windowsHide: true, env: childEnv });

  guardTier3Env();
  let dshVersion;
  try {
    dshVersion = probeDshVersion(binJs, childEnv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  // Tier 3 starts no mock at all: `mock` stays null and the assertions below
  // say so. Starting it and never pointing dsh at it would weaken the proof.
  let mock = null;
  let mockOut = [];
  let mockErr = [];
  let mockExit = Promise.resolve({ code: null, signal: null });
  let flushMockLogs = () => {};
  let port = null;
  if (!scenario.realApi) {
    mock = spawn(process.execPath, [
      MOCK,
      '--port', '0',
      '--log', requestLog,
      '--script', scriptPath,
      '--expect-api-key', DUMMY_KEY,
    ], { cwd: evidenceDir, windowsHide: true, env: childEnv });

    mock.stderr.on('data', (chunk) => mockErr.push(chunk));
    mockExit = new Promise((resolveExit) => mock.on('exit', (code, signal) => resolveExit({ code, signal })));

    const mockErrPath = join(evidenceDir, 'mock.err.log');
    const mockOutPath = join(evidenceDir, 'mock.out.log');
    flushMockLogs = () => {
      writeFileSync(mockOutPath, Buffer.concat(mockOut));
      writeFileSync(mockErrPath, Buffer.concat(mockErr));
    };

    try {
      port = await new Promise((resolvePort, rejectPort) => {
        const lines = createInterface({ input: mock.stdout });
        const timer = setTimeout(() => rejectPort(new Error('mock did not report listening within 15000 ms')), 15_000);
        lines.on('line', (line) => {
          mockOut.push(Buffer.from(`${line}\n`));
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === 'listening' && Number.isInteger(parsed.port)) {
              clearTimeout(timer);
              resolvePort(parsed.port);
            }
          } catch {
            // Non-JSON diagnostics stay in mock.out.log.
          }
        });
        mock.on('exit', (code) => rejectPort(new Error(`mock exited before listening (code ${code}); see mock.err.log`)));
      });
    } catch (error) {
      flushMockLogs();
      mock.kill();
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }

  // The route variables are the only values that depend on the mock; they join
  // the same allow-listed env the version probe already used, and tier 3 adds
  // none (an empty URL is still a base URL).
  if (!scenario.realApi) {
    Object.assign(childEnv, {
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
      DEEPSEEK_API_KEY: DUMMY_KEY,
    });
  }

  // ── One launch: spawn, arm the kill timer before any wait, collect. ────────
  // dsh headless sends exactly one user message per process, so a second whole
  // message (the `/prune` command) needs a second launch that resumes the
  // session the first launch persisted.
  let liveChild = null;
  const reap = (child) => {
    if (child !== null && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killTree(child.pid);
    }
  };
  process.on('SIGINT', () => {
    reap(liveChild);
    mock?.kill();
    process.exit(130);
  });

  async function runLaunch(task, sessionId) {
    const argv = [binJs, '--profile', 'headless', '--patch', patchPath, '--json',
      ...(sessionId === null ? [] : ['--session-id', sessionId]), task];
    const launchCommand = [process.execPath, ...argv].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
    const startedAt = timestamp();
    guardTier3Env();
    const child = spawn(process.execPath, argv, { cwd: workDir, env: childEnv, windowsHide: true });
    liveChild = child;

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    const childExit = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })));

    // Tier 3 is bounded by the operator's RIG_KILL_TIMER_MS instead of 2x the
    // scenario timeout: a real call must die on the operator's bound, not on a
    // value a scenario file chose.
    const watchdogMs = scenario.realApi
      ? Number(process.env.RIG_KILL_TIMER_MS)
      : Math.min(2 * scenario.timeoutMs, MAX_WATCHDOG_MS);
    // The watchdog below is armed from `watchdogMs`; a delay above the platform
    // maximum would fire at 1 ms, so it is refused before the timer exists
    // (ISSUE-580).
    const tooLongWatchdog = timerDelayRefusal(watchdogMs,
      scenario.realApi ? 'RIG_KILL_TIMER_MS' : 'the watchdog timeout');
    if (tooLongWatchdog !== null) {
      process.stderr.write(`run.mjs: ${tooLongWatchdog}; no request is bounded by it, refusing\n`);
      process.exit(2);
    }
    const watchdogCommand = `taskkill /PID ${String(child.pid)} /T /F`;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, watchdogMs);

    const exit = await childExit;
    clearTimeout(watchdog);
    if (liveChild === child) liveChild = null;
    return {
      task, sessionId, launchCommand, startedAt, finishedAt: timestamp(), exit,
      stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks),
      watchdog: { command: watchdogCommand, timeout_ms: watchdogMs, fired: watchdogFired },
    };
  }

  const launches = [await runLaunch(scenario.task, null)];
  if (scenario.resumeLaunches.length > 0) {
    // The first launch named its own session; the persisted log is the only
    // place the id exists, so it is read back rather than guessed. Every resume
    // launch names the same id, so the second process continues the first one's
    // session (and its persisted round ordinal).
    const persisted = findSessionFiles(sessionsDir);
    if (persisted.length !== 1) {
      process.stderr.write(`run.mjs: a resume launch needs exactly one persisted session log `
        + `(session.v4.jsonl or session-<id>.v4.jsonl), saw ${persisted.length}\n`);
      mock?.kill();
      process.exit(1);
    }
    const sessionId = sessionIdForLog(persisted[0]);
    for (const resume of scenario.resumeLaunches) {
      launches.push(await runLaunch(resume.task, sessionId));
    }
  }
  const exit = launches[launches.length - 1].exit;
  const watchdogFired = launches.some((launch) => launch.watchdog.fired);

  writeFileSync(join(evidenceDir, 'stdout.ndjson'), Buffer.concat(launches.map((launch) => launch.stdout)));
  writeFileSync(join(evidenceDir, 'stderr.log'), Buffer.concat(launches.map((launch) => launch.stderr)));
  for (let index = 1; index < launches.length; index += 1) {
    const ordinal = String(index + 1);
    writeFileSync(join(evidenceDir, `launch-${ordinal}.stdout.ndjson`), launches[index].stdout);
    writeFileSync(join(evidenceDir, `launch-${ordinal}.stderr.log`), launches[index].stderr);
  }
  if (mock !== null) {
    mock.kill();
    await mockExit;
  }
  flushMockLogs();

  const requests = mock === null
    ? []
    : readFileSync(requestLog, 'utf8').split(/\r?\n/u).filter((line) => line !== '').map((line) => JSON.parse(line));
  const sessionFiles = findSessionFiles(sessionsDir);
  const sessionEvents = [];
  for (const file of sessionFiles) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      sessionEvents.push(JSON.parse(line));
    }
  }
  const stdoutLines = Buffer.concat(launches.map((launch) => launch.stdout)).toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: 'unparsed', line };
    }
  });

  /** One assertion result; `name` is what a failure must name (spec §7). */
  const results = [];
  const check = (name, fn) => {
    let ok = false;
    let detail;
    try {
      const outcome = fn();
      ok = outcome === true;
      if (!ok) detail = typeof outcome === 'string' ? outcome : 'expectation not met';
    } catch (error) {
      detail = error.message;
    }
    results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };

  const expect = scenario.expect;
  const mains = requests.filter((entry) => entry.kind === 'main');
  const titles = requests.filter((entry) => entry.kind === 'title');
  // A prune ask is its own lane (`classifyRequest`): a table ask, either the
  // fork that keeps main's tools or a tool-less one whose fork had no seed. Since
  // ADR-0028 the bulk prune is the only table asker, so every table ask is this
  // lane whatever its row count. It is never counted as a main turn, so
  // `mock.mainRequests` keeps meaning "turns the agent's loop sent".
  const prunes = requests.filter((entry) => entry.kind === 'prune');
  const assistantTexts = sessionEvents
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event.data?.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''));
  const userTexts = sessionEvents
    .filter((event) => event.type === 'user/message')
    .map((event) => (event.data?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''));
  const eventTypes = sessionEvents.map((event) => event.type);
  const finalEvent = [...stdoutLines].reverse().find((event) => event.type === 'final');
  const transcriptTurns = Array.isArray(scenario.script?.replies) ? scenario.script.replies : [];
  /** Text a scripted entry emits; a `tool_use` reply can carry text too. */
  const entryText = (entry) => (typeof entry?.reply?.text === 'string' ? entry.reply.text : '');
  const scriptedNonEmptyTexts = transcriptTurns.map(entryText).filter((text) => text !== '');
  const observedNonEmptyTexts = assistantTexts.filter((text) => text !== '');
  /** Matcher keys the mock actually saw, in request order: [count, tool names]. */
  const observedRequestKeys = mains.map((entry) => {
    const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
    const toolResults = messages
      .filter((message) => message?.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content)
      .filter((block) => block?.type === 'tool_result').length;
    const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    const names = (Array.isArray(lastAssistant?.content) ? lastAssistant.content : [])
      .filter((block) => block?.type === 'tool_use')
      .map((block) => String(block.name));
    return [toolResults, names];
  });
  const scriptedRequestKeys = transcriptTurns.map((entry) => {
    const match = entry.match ?? {};
    return [match.tool_results_count ?? 0, Array.isArray(match.last_assistant_tool_names) ? match.last_assistant_tool_names : []];
  });
  const toolCalls = sessionEvents.filter((event) => event.type === 'tool/call');
  const toolResults = sessionEvents.filter((event) => event.type === 'tool/result');
  const toolResultTexts = toolResults.map((event) => JSON.stringify(event.data?.message?.content ?? ''));
  const toolResultFailed = toolResults.filter((event) => {
    const content = event.data?.message?.content ?? [];
    return Array.isArray(content) && content.some((block) => block?.isError === true || block?.is_error === true);
  }).length;

  if ('exitCode' in expect) {
    check('exit code', () => (exit.code === expect.exitCode ? true : `expected exit ${expect.exitCode}, got ${String(exit.code)} (signal ${String(exit.signal)})`));
  }
  if (expect.mock !== undefined) {
    const mockExpect = expect.mock;
    if ('mainRequests' in mockExpect) {
      check('mock main request count', () => (mains.length === mockExpect.mainRequests ? true : `expected ${mockExpect.mainRequests} main request(s), saw ${mains.length}`));
    }
    if ('pruneRequests' in mockExpect) {
      // The wire side of the prune round-trip: the mount's ask reached the mock.
      check('prune asks reach the model', () => (prunes.length === mockExpect.pruneRequests
        ? true : `expected ${mockExpect.pruneRequests} prune request(s), saw ${prunes.length}`));
    }
    if ('pruneRequestsHaveNoTools' in mockExpect && mockExpect.pruneRequestsHaveNoTools === true) {
      const ok = prunes.length > 0 && prunes.every((entry) => !Array.isArray(entry.body?.tools)
        || entry.body.tools.length === 0);
      check('prune requests offer no tools', () => (ok ? true : `${prunes.length} prune request(s), one carried tools or none arrived`));
    }
    if ('titleRequests' in mockExpect) {
      const want = mockExpect.titleRequests;
      const ok = typeof want === 'object' ? titles.length <= want.max : titles.length === want;
      check('mock title request count', () => (ok ? true : `expected ${JSON.stringify(want)} title request(s), saw ${titles.length} (title calls race process exit; compare 0..1)`));
    }
    if ('firstRequestKind' in mockExpect) {
      // dsh starts its session-title provider as detached work when the first
      // user message lands (`dsh-session-title`: onUserMessage -> defer, begun
      // by onRequestHeader or onMainRequest), so its HTTP call races the main
      // request's own call and either may arrive first. The title lane is the
      // only one allowed to lead: an entry, prune or compaction ask ahead of
      // the first main turn is still a defect.
      const firstTurn = requests.find((entry) => entry.kind !== 'title');
      check('mock first request kind', () => (firstTurn?.kind === mockExpect.firstRequestKind
        ? true : `expected first request kind ${mockExpect.firstRequestKind}, saw ${String(firstTurn?.kind)} (a leading title call is tolerated)`));
    }
    if ('mainHasTools' in mockExpect) {
      const hasTools = mains.every((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0);
      check('mock main request carries tools', () => (hasTools === mockExpect.mainHasTools ? true : `main request tools presence ${String(hasTools)}`));
    }
    if ('mainHasSystem' in mockExpect) {
      const hasSystem = mains.every((entry) => typeof entry.body?.system === 'string' && entry.body.system.length > 0);
      check('mock main request carries system prompt', () => (hasSystem === mockExpect.mainHasSystem ? true : `main request system presence ${String(hasSystem)}`));
    }
    if ('mainUserTextContains' in mockExpect) {
      const needle = mockExpect.mainUserTextContains;
      const found = mains.some((entry) => (entry.body?.messages ?? []).some((message) => message.role === 'user' && JSON.stringify(message.content).includes(needle)));
      check('mock main request carries the task text', () => (found ? true : `no main request contained ${JSON.stringify(needle)}`));
    }
    if ('mainBodyContains' in mockExpect) {
      // Anywhere in a main request's body, not only a user message: a tool
      // result rides inside one, and this is the positive half of the
      // "the whole body reached the wire" pair (`requestTextAbsent` is the
      // negative half).
      const needle = mockExpect.mainBodyContains;
      const found = mains.some((entry) => JSON.stringify(entry.body ?? {}).includes(needle));
      check('mock main request carries the text', () => (found ? true : `no main request body contained ${JSON.stringify(needle)}`));
    }
    if ('lastMainBodyContains' in mockExpect) {
      // The LAST main turn's body: what the session still carries once every
      // pass of the run has landed. A removed result's bytes must be gone from
      // it, and a protected one's must still be there.
      const needles = Array.isArray(mockExpect.lastMainBodyContains)
        ? mockExpect.lastMainBodyContains : [mockExpect.lastMainBodyContains];
      const last = mains[mains.length - 1];
      check('the last main request carries the surviving text', () => {
        if (last === undefined) return 'no main request was sent';
        const body = JSON.stringify(last.body ?? {});
        const missing = needles.filter((needle) => !body.includes(needle));
        return missing.length === 0 ? true : `the last main request body did not carry ${JSON.stringify(missing)}`;
      });
    }
    if ('lastMainBodyAbsent' in mockExpect) {
      const needles = Array.isArray(mockExpect.lastMainBodyAbsent)
        ? mockExpect.lastMainBodyAbsent : [mockExpect.lastMainBodyAbsent];
      const last = mains[mains.length - 1];
      check('the last main request dropped the forgotten text', () => {
        if (last === undefined) return 'no main request was sent';
        const body = JSON.stringify(last.body ?? {});
        const carried = needles.filter((needle) => body.includes(needle));
        return carried.length === 0 ? true : `the last main request body still carried ${JSON.stringify(carried)}`;
      });
    }
    if ('titleRequestsHaveNoTools' in mockExpect && mockExpect.titleRequestsHaveNoTools === true) {
      const ok = titles.every((entry) => !Array.isArray(entry.body?.tools) || entry.body.tools.length === 0);
      check('title request has no tools', () => (ok ? true : 'a title request carried a tools array'));
    }
    if ('noMatchRecords' in mockExpect) {
      const noMatch = requests.filter((entry) => entry.matched === 'no-match').length;
      check('mock has no unmatched requests', () => (noMatch === mockExpect.noMatchRecords ? true : `expected ${mockExpect.noMatchRecords} no-match records, saw ${noMatch}`));
    }
    if ('allRequestsUsedDummyKey' in mockExpect && mockExpect.allRequestsUsedDummyKey === true) {
      const posts = requests.filter((entry) => entry.kind !== 'unrouted');
      const ok = posts.length > 0 && posts.every((entry) => entry.headers_redacted?.['x-api-key'] === '<dummy>');
      check('mock saw only the dummy key', () => (ok ? true : 'a request did not present the rig dummy key'));
    }
  }
  if (expect.session !== undefined) {
    const sessionExpect = expect.session;
    check('session log exists', () => (sessionFiles.length > 0
      ? true : `no session.v4.jsonl or session-<id>.v4.jsonl under ${join(homeDir, 'sessions')}`));
    check('exactly one session log', () => (sessionFiles.length === 1
      ? true : `expected 1 session.v4.jsonl or session-<id>.v4.jsonl, saw ${sessionFiles.length}: ${sessionFiles.join(', ')}`));
    if ('assistantTexts' in sessionExpect) {
      check('session assistant turn content', () => (JSON.stringify(assistantTexts) === JSON.stringify(sessionExpect.assistantTexts) ? true : `expected assistant texts ${JSON.stringify(sessionExpect.assistantTexts)}, saw ${JSON.stringify(assistantTexts)}`));
    }
    if ('assistantTextContains' in sessionExpect) {
      // Tier 3 cannot know the wording, only that the answer names the fact.
      const needle = sessionExpect.assistantTextContains;
      check('the assistant answer names the expected fact', () => (assistantTexts.some((text) => text.includes(needle))
        ? true : `no assistant text contained ${JSON.stringify(needle)}; saw ${JSON.stringify(assistantTexts.map((text) => text.slice(0, 200)))}`));
    }
    if ('userTextContains' in sessionExpect) {
      const needle = sessionExpect.userTextContains;
      check('session records the user task', () => (userTexts.some((text) => text.includes(needle)) ? true : `no user/message contained ${JSON.stringify(needle)}`));
    }
    if ('eventTypesAbsent' in sessionExpect) {
      for (const type of sessionExpect.eventTypesAbsent) {
        check(`session event ${type} absent`, () => (eventTypes.includes(type) ? `${type} appeared in the session log` : true));
      }
    }
    if ('eventTypesPresent' in sessionExpect) {
      for (const type of sessionExpect.eventTypesPresent) {
        check(`session event ${type} present`, () => (eventTypes.includes(type) ? true : `${type} missing from the session log`));
      }
    }
  }
  if (expect.replay !== undefined) {
    const replayExpect = expect.replay;
    if ('minTurns' in replayExpect) {
      const want = replayExpect.minTurns;
      check('replay turn count', () => (assistantTexts.length >= want ? true : `expected at least ${want} assistant turn(s), saw ${assistantTexts.length}`));
    }
    if ('scriptTurns' in replayExpect) {
      const want = replayExpect.scriptTurns;
      check('replay script turn count', () => (transcriptTurns.length === want ? true : `expected ${want} scripted turn(s), saw ${transcriptTurns.length}`));
    }
    if ('assistantTextsMatchScript' in replayExpect && replayExpect.assistantTextsMatchScript === true) {
      // Every scripted non-empty text must appear, in order; the session may
      // carry extra assistant turns, so this is a subsequence check, not equal.
      check('replay assistant texts reproduce the script', () => {
        let cursor = 0;
        for (const text of scriptedNonEmptyTexts) {
          const at = observedNonEmptyTexts.indexOf(text, cursor);
          if (at === -1) return `scripted text ${JSON.stringify(text.slice(0, 60))} missing from the session (or out of order)`;
          cursor = at + 1;
        }
        return true;
      });
      check('replay has no unscripted assistant text', () => {
        const scripted = new Set(scriptedNonEmptyTexts);
        const extra = observedNonEmptyTexts.filter((text) => !scripted.has(text));
        return extra.length === 0 ? true : `assistant text not present in the script: ${JSON.stringify(extra[0].slice(0, 60))}`;
      });
    }
    if ('requestKeysMatchScript' in replayExpect && replayExpect.requestKeysMatchScript === true) {
      // The canonical projection §5 names: (tool-result count, tool names).
      check('replay request keys match scripted matchers', () => {
        if (observedRequestKeys.length !== scriptedRequestKeys.length) {
          return `expected ${scriptedRequestKeys.length} main request(s), saw ${observedRequestKeys.length}`;
        }
        for (let i = 0; i < scriptedRequestKeys.length; i += 1) {
          const [sawCount, sawNames] = observedRequestKeys[i];
          const [wantCount, wantNames] = scriptedRequestKeys[i];
          if (sawCount !== wantCount) return `request ${i + 1}: expected tool-result count ${wantCount}, saw ${sawCount}`;
          if (JSON.stringify(sawNames) !== JSON.stringify(wantNames)) {
            return `request ${i + 1}: expected last assistant tools ${JSON.stringify(wantNames)}, saw ${JSON.stringify(sawNames)}`;
          }
        }
        return true;
      });
    }
  }

  // ── Canonical projection (spec §5 determinism rule) ────────────────────────
  // Drops ids, times, absolute evidence paths and usage; keeps the request keys,
  // the assistant texts, the tool call names/ids and the session event order.
  // The title request is excluded from the event list and counted separately,
  // because it races process exit; the acceptance write shifts seqs, so raw logs
  // are never compared.
  const TITLE_EVENTS = new Set(['session/title', 'session/title-llm-request']);
  const normaliseEvidence = (text) => text.split(evidenceDir).join('<evidence>').split(workDir).join('<work>').split(homeDir).join('<home>');
  const projection = {
    request_keys: observedRequestKeys,
    assistant_texts: observedNonEmptyTexts,
    tool_calls: toolCalls.map((event) => ({ id: event.data?.callId, name: event.data?.name })),
    tool_results: toolResults.map((event) => normaliseEvidence(
      Array.isArray(event.data?.message?.content) ? event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('') : '',
    )),
    event_types: eventTypes.filter((type) => type !== 'session-log-deepseek/delivery-accepted' && !TITLE_EVENTS.has(type)),
    // 0 or 1: the title call is asynchronous, so its presence is not a fact.
    title_requests_observed: Math.min(titles.length, 1),
  };
  if (opts.projectionOut !== null) {
    writeFileSync(resolve(opts.projectionOut), `${JSON.stringify(projection, null, 2)}\n`);
  }
  const projectionIn = opts.projectionIn !== null ? resolve(opts.projectionIn) : scenario.projectionPath;
  if (projectionIn !== null) {
    // The expected file was produced by an earlier run (or is checked in), so it
    // cannot be derived from this run's values.
    check('canonical projection matches the recorded run', () => {
      const wanted = readFileSync(projectionIn, 'utf8');
      const observed = `${JSON.stringify(projection, null, 2)}\n`;
      if (observed === wanted) return true;
      const observedLines = observed.split('\n');
      const wantedLines = wanted.split('\n');
      const at = observedLines.findIndex((line, index) => line !== wantedLines[index]);
      if (at === -1) return `projection differs only in length: observed ${observedLines.length} line(s), expected ${wantedLines.length}`;
      return `projection differs at line ${at + 1}:\n  observed ${JSON.stringify(observedLines[at])}\n  expected ${JSON.stringify(wantedLines[at])}`;
    });
  }

  if (expect.tools !== undefined) {
    const toolExpect = expect.tools;
    if ('calls' in toolExpect) {
      const want = toolExpect.calls;
      check('tool/call records in the session log', () => (toolCalls.length === want ? true : `expected ${want} tool/call record(s), saw ${toolCalls.length}`));
    }
    if ('results' in toolExpect) {
      const want = toolExpect.results;
      // A racoons cap re-appends the same result as a replacement, so the raw
      // count includes racoons' own artifact. When the mount is active the count
      // means the results dsh itself produced (append-origin only).
      const counted = scenario.racoons === null ? toolResults
        : toolResults.filter((event) => event.surfaceOp === 'append');
      check('tool/result records in the session log', () => (counted.length === want ? true : `expected ${want} tool/result record(s), saw ${counted.length}`));
    }
    if ('failedResults' in toolExpect) {
      const want = toolExpect.failedResults;
      check('tool results that failed', () => (toolResultFailed === want ? true : `expected ${want} failed tool result(s), saw ${toolResultFailed}`));
    }
    if ('callIds' in toolExpect) {
      const wanted = toolExpect.callIds;
      const seen = toolCalls.map((event) => String(event.data?.callId));
      check('tool/call ids equal the scripted ids', () => (JSON.stringify(seen) === JSON.stringify(wanted) ? true : `expected call ids ${JSON.stringify(wanted)}, saw ${JSON.stringify(seen)}`));
    }
    if ('names' in toolExpect) {
      const wanted = toolExpect.names;
      const seen = toolCalls.map((event) => String(event.data?.name));
      check('tool/call names equal the scripted names', () => (JSON.stringify(seen) === JSON.stringify(wanted) ? true : `expected tool names ${JSON.stringify(wanted)}, saw ${JSON.stringify(seen)}`));
    }
    if ('namesInclude' in toolExpect) {
      // Tier 3 cannot script the calls, only require that some were made: the
      // real task must make the model open a file, not answer from nothing.
      const seen = new Set(toolCalls.map((event) => String(event.data?.name)));
      check('tool calls include the required tools', () => {
        const missing = toolExpect.namesInclude.filter((name) => !seen.has(name));
        return missing.length === 0 ? true : `no ${JSON.stringify(missing)} tool call; saw ${JSON.stringify([...seen])}`;
      });
    }
    if ('resultContains' in toolExpect) {
      const needles = Array.isArray(toolExpect.resultContains) ? toolExpect.resultContains : [toolExpect.resultContains];
      check('tool results carry the expected text', () => {
        for (const needle of needles) {
          if (!toolResultTexts.some((text) => text.includes(needle))) return `no tool/result contained ${JSON.stringify(needle)}`;
        }
        return true;
      });
    }
    if ('resultAbsent' in toolExpect) {
      const needles = Array.isArray(toolExpect.resultAbsent) ? toolExpect.resultAbsent : [toolExpect.resultAbsent];
      check('tool results do not carry the forbidden text', () => {
        for (const needle of needles) {
          if (toolResultTexts.some((text) => text.includes(needle))) return `a tool/result contained ${JSON.stringify(needle)}`;
        }
        return true;
      });
    }
    if ('finalText' in toolExpect) {
      const want = toolExpect.finalText;
      check('second turn cites the tool result', () => (finalEvent?.text === want ? true : `expected final text ${JSON.stringify(want)}, saw ${JSON.stringify(finalEvent?.text)}`));
    }
  }
  if (expect.stdout !== undefined) {
    if ('finalText' in expect.stdout) {
      check('stdout final text', () => (finalEvent?.text === expect.stdout.finalText ? true : `expected final text ${JSON.stringify(expect.stdout.finalText)}, saw ${JSON.stringify(finalEvent?.text)}`));
    }
  }

  // ── Tier 3: the run really reached the provider (spec §8 non-vacuity) ──────
  // No mock is started in this mode, so a mock-shaped run cannot satisfy any of
  // these: the usage row and the provider stamp can only come from a real
  // response, and the loopback scan proves nothing pointed at a local server.
  if (expect.realApi !== undefined) {
    const want = expect.realApi;
    const usageEvents = sessionEvents.filter((event) => event.type === 'assistant/message'
      && Number.isInteger(event.data?.usage?.outputTokens));
    const totalOutput = usageEvents.reduce((sum, event) => sum + event.data.usage.outputTokens, 0);
    const loopbackHits = [...stdoutLines, ...sessionEvents].filter((event) => JSON.stringify(event).includes('127.0.0.1'));

    check('mock server was never started', () => (mock === null && !existsSync(join(evidenceDir, 'mock.out.log'))
      ? true : 'a mock process or its log exists in a tier-3 run'));
    // The hard rule: the rig never puts the key in the child environment. dsh
    // resolves it itself from the store; this proves the rig did not shortcut.
    check('the rig exported no API key', () => (childEnv.A6_API_KEY === undefined && childEnv.DEEPSEEK_API_KEY === undefined
      ? true : `the child environment carried ${['A6_API_KEY', 'DEEPSEEK_API_KEY'].filter((name) => childEnv[name] !== undefined).join(', ')}`));
    check('no record names a loopback endpoint', () => (loopbackHits.length === 0
      ? true : `${loopbackHits.length} record(s) mention 127.0.0.1, first: ${JSON.stringify(loopbackHits[0]).slice(0, 300)}`));
    check('the real provider answered with at least one turn', () => (assistantTexts.length >= want.minAssistantTurns
      ? true : `expected ${want.minAssistantTurns} assistant turn(s), saw ${assistantTexts.length}`));
    check('the answer is not empty', () => (observedNonEmptyTexts.length >= 1
      ? true : 'every assistant turn was empty text'));
    check('the provider reported real token usage', () => (usageEvents.length >= want.minUsageRows
      ? true : `expected ${want.minUsageRows} assistant/message usage row(s), saw ${usageEvents.length}`));
    check('the usage row carries output tokens', () => (totalOutput >= want.minOutputTokens
      ? true : `expected at least ${want.minOutputTokens} output token(s), saw ${totalOutput}`));
    // Spec §8 bounds: one task, at most three model requests. The title row is
    // disabled, so every assistant turn is one billed request.
    if ('maxModelRequests' in want) {
      check('the run stayed inside the request bound', () => (usageEvents.length <= want.maxModelRequests
        ? true : `expected at most ${want.maxModelRequests} model request(s), saw ${usageEvents.length}`));
    }
    check('the session log names the requested provider and model', () => {
      const stamped = sessionEvents.filter((event) => event.type === 'request/context'
        && event.data?.provider === want.provider && event.data?.model === want.model);
      return stamped.length >= 1
        ? true : `no request/context named ${want.provider}/${want.model}; saw ${JSON.stringify(sessionEvents.filter((event) => event.type === 'request/context').map((event) => `${String(event.data?.provider)}/${String(event.data?.model)}`))}`;
    });
  }

  // ── RACOONS mount (spec §6 S1–S4, §9) ─────────────────────────────────────
  // The evidence source is the plugin's own journal plus the session log. Every
  // assertion names the side of the seam it speaks for: the ledger/recall side
  // lives under `<evidence>/racoons/`, the surface side is the session log.
  if (expect.racoons !== undefined) {
    const want = expect.racoons;
    const racoonsDir = join(evidenceDir, 'racoons');
    const eventsPath = join(racoonsDir, 'cremator-events.jsonl');
    let journal = [];
    let journalUnparsable = 0;
    try {
      // Line by line: one torn line (a killed child's tail) must not erase the
      // lines that did parse (ISSUE-581).
      for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/u)) {
        if (line === '') continue;
        try {
          journal.push(JSON.parse(line));
        } catch {
          journalUnparsable += 1;
        }
      }
    } catch {
      // Missing journal: the checks below fail by name with an empty list.
    }
    if (journalUnparsable > 0) {
      process.stderr.write(`notice: ${journalUnparsable} journal line(s) did not parse and were skipped\n`);
    }
    const kinds = (kind) => journal.filter((line) => line.kind === kind);
    // ADR-0013: one ledger per session under `<racoons>/storage/sessions/<id>/`.
    // The driver derives the path from the session directories the run left, so
    // one scenario can prove a second process read the first one's file.
    const storageRoot = join(racoonsDir, 'storage');
    const storageSessionsDir = join(storageRoot, 'sessions');
    const storageSessionIds = existsSync(storageSessionsDir)
      ? readdirSync(storageSessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
    const firstStorageSession = storageSessionIds.length === 1
      ? join(storageSessionsDir, storageSessionIds[0]) : null;
    const ledgerPath = firstStorageSession === null
      ? join(storageSessionsDir, '<sessionId>', 'ledger.sqlite')
      : join(firstStorageSession, 'ledger.sqlite');
    const blobRoot = firstStorageSession === null
      ? join(storageSessionsDir, '<sessionId>', 'blobs')
      : join(firstStorageSession, 'blobs');
    const surfaceToolResults = sessionEvents.filter((event) => event.type === 'tool/result');
    const surfaceBodies = surfaceToolResults.map((event) => {
      const content = event.data?.message?.content;
      return Array.isArray(content) ? content.filter((block) => block?.type === 'text')
        .map((block) => block.text).join('') : '';
    });
    const surfaceAppends = sessionEvents.filter((event) => event.type === 'user/message'
      && typeof event.data?.source?.kind === 'string'
      && event.data.source.kind === (want.recordName ?? 'racoons/negation'));
    const surfaceAppendTexts = surfaceAppends.map((event) => (event.data.content ?? [])
      .filter((block) => block?.type === 'text').map((block) => block.text).join(''));
    /** The host's own tool result, i.e. the append-origin one, never our replacement. */
    const originToolResults = sessionEvents.filter((event) => event.type === 'tool/result'
      && event.surfaceOp === 'append');
    /** A replacement copy: the mount re-appends a result under a replace op. */
    const replacementToolResults = sessionEvents.filter((event) => event.type === 'tool/result'
      && typeof event.surfaceOp === 'object' && event.surfaceOp !== null);
    /** One result's text as bytes: the unit a byte-exact restore is checked in. */
    const toolResultBody = (event) => Buffer.from((event.data?.message?.content ?? [])
      .filter((block) => block?.type === 'text').map((block) => block.text).join(''), 'utf8');

    check('racoons plugin mounted', () => {
      const expected = want.mounted ?? 1;
      const seen = kinds('mounted').length;
      return seen === expected ? true : `expected ${expected} mounted line(s) in ${eventsPath}, saw ${seen}`;
    });

    if ('ledger' in want) {
      check('racoons ledger file exists', () => (existsSync(ledgerPath) ? true : `no ledger at ${ledgerPath}`));
    }
    if ('blobRoot' in want) {
      check('racoons blob store exists', () => (existsSync(blobRoot) ? true : `no blob store at ${blobRoot}`));
    }
    if ('storageSessions' in want) {
      // ADR-0013: one ledger file per session under the root. A restart run
      // must leave exactly one, or the second launch opened a new file.
      check('one storage directory per session', () => (storageSessionIds.length === want.storageSessions
        ? true : `expected ${want.storageSessions} session dir(s) under ${storageSessionsDir}, saw ${storageSessionIds.length}: ${JSON.stringify(storageSessionIds)}`));
    }
    if ('durableStorage' in want && want.durableStorage === true) {
      // The mount's own journal line, not the harness': `ledgerSource` says the
      // entry chose its durable seam instead of the test-only `:memory:` pair.
      check('the mount opened its own durable ledger', () => {
        const lines = kinds('mounted');
        if (lines.length === 0) return 'no mounted line to read';
        const wrong = lines.filter((line) => line.ledgerSource !== 'durable');
        if (wrong.length > 0) {
          return `mounted ledgerSource ${JSON.stringify(wrong.map((line) => line.ledgerSource))}, expected durable`;
        }
        const roots = lines.map((line) => line.storageRoot);
        const expectedRoot = join(racoonsDir, 'storage');
        if (!roots.every((root) => root === expectedRoot)) {
          return `storageRoot ${JSON.stringify(roots)}, expected ${expectedRoot}`;
        }
        // ADR-0013 ruling 8: the runtime evidence comes from inside the mount.
        return lines.every((line) => typeof line.node === 'string' && line.node !== '')
          ? true : 'a mounted line carried no node version';
      });
    }
    if ('mountedRecord' in want) {
      // The mount line states what the entry point wired (ISSUE-022 chunks 5–6):
      // `prune: 'command+threshold'` and the window the trigger measures against.
      // Read from the entry's own journal line, never inferred from config.
      check('the mounted line states the wired entry points', () => {
        const lines = kinds('mounted');
        if (lines.length === 0) return 'no mounted line to read';
        for (const [key, expected] of Object.entries(want.mountedRecord)) {
          const wrong = lines.filter((line) => line[key] !== expected);
          if (wrong.length > 0) {
            return `mounted ${key} ${JSON.stringify(wrong.map((line) => line[key]))}, expected ${JSON.stringify(expected)}`;
          }
        }
        return true;
      });
    }
    if ('surfaceApply' in want) {
      // The apply leg's own surface write: one content-only replacement of the
      // forgotten node, carrying the receipt that names its recall id. Counted
      // separately from the host's `append` (a string surfaceOp) so a host
      // result can never satisfy it.
      const replaced = sessionEvents.filter((event) => event.type === 'tool/result'
        && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
        && event.surfaceOp.op === 'replace');
      check('the apply leg replaced the forgotten node on the surface', () => (replaced.length === want.surfaceApply.replacements
        ? true : `expected ${want.surfaceApply.replacements} surface replacement(s), saw ${replaced.length}`));
      check('every surface replacement names a recall id', () => {
        if (replaced.length === 0) return 'no surface replacement to read';
        const withId = replaced.filter((event) => /recall:sha256:[0-9a-f]{64}/u.test(
          JSON.stringify(event.data?.message?.content ?? '')));
        return withId.length === want.surfaceApply.recallIds
          ? true : `expected ${want.surfaceApply.recallIds} replacement(s) carrying a recall id, saw ${withId.length}`;
      });
    }
    if ('capPlans' in want) {
      const capArchives = kinds('publish').flatMap((line) => line.archives ?? [])
        .filter((archive) => archive.operationKind === 'cap');
      check('cap plans a removal', () => (capArchives.length === want.capPlans
        ? true : `no cap plan: expected ${want.capPlans} cap archive(s), saw ${capArchives.length}`));
    }
    if ('capEntries' in want) {
      const entries = kinds('entry');
      check('cap delivers the entry through the adapter', () => (entries.length >= 1
        ? true : 'the mount never saw a tool/result capture'));
    }
    if ('sealEpisodes' in want) {
      const sealed = kinds('publish').flatMap((line) => line.sealedEpisodeIds ?? []);
      check('seal plans one episode', () => (sealed.length === want.sealEpisodes
        ? true : `expected one negative fact, saw ${sealed.length} sealed episode(s)`));
    }
    if ('negativeFacts' in want) {
      const negatives = kinds('publish').flatMap((line) => line.appendRecords ?? []);
      check('seal renders one negative-fact record', () => (negatives.length === want.negativeFacts
        ? true : `expected ${want.negativeFacts} negative-fact record(s), saw ${negatives.length}`));
    }
    if ('negativeFactPrefix' in want) {
      const negatives = kinds('publish').flatMap((line) => line.appendRecords ?? []);
      check('negative fact names the target', () => (negatives.some((record) => record.text.startsWith(want.negativeFactPrefix))
        ? true : `no appended record started with ${JSON.stringify(want.negativeFactPrefix)}: ${JSON.stringify(negatives.map((record) => record.text))}`));
    }
    if ('forgeAbsent' in want) {
      // The perturbed run's own hint: the cap must not fire when the bar is raised.
      check('no cap plan when the bar is out of reach', () => (kinds('publish').flatMap((line) => line.archives ?? [])
        .filter((archive) => archive.operationKind === 'cap').length === want.forgeAbsent
        ? true : 'a cap plan appeared although the result fits under the bar'));
    }
    if ('surfaceCapped' in want) {
      const bodyOf = (event) => Buffer.from((event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text').map((block) => block.text).join(''), 'utf8');
      check('session log stores the capped form', () => {
        if (originToolResults.length !== 1) return `expected one append-origin tool/result, saw ${originToolResults.length}`;
        if (replacementToolResults.length !== 1) return `expected one replacement tool/result, saw ${replacementToolResults.length}`;
        const replacement = replacementToolResults[0];
        const body = bodyOf(replacement);
        const markerAt = body.indexOf('[Capped: ');
        if (markerAt < 0) return 'no cap marker in the stored replacement';
        const marker = body.slice(markerAt).toString('utf8');
        if (!/^\[Capped: showing \d+–\d+ of \d+ lines · [\d.]+ kB omitted · necromancy recall:sha256:[0-9a-f]{64}\]$/u.test(marker)) {
          return `the stored replacement does not match the core cap-marker template: ${marker.slice(0, 120)}`;
        }
        // The marker must be the only generated region: head bytes, then marker.
        if (replacement.surfaceOp?.op !== 'replace'
          || replacement.surfaceOp.startSeq !== originToolResults[0].seq
          || replacement.surfaceOp.endSeq !== originToolResults[0].seq) {
          return `the replacement is not a single-node replace over the origin result: ${JSON.stringify(replacement.surfaceOp)}`;
        }
        // The head is the whole-line cover of capHeadBytes, not an arbitrary cut:
        // the same rule the core's CapRule and the guard's checkCap enforce.
        const origin = bodyOf(originToolResults[0]);
        if (want.surfaceCapped.capHeadBytes !== undefined) {
          if (markerAt < want.surfaceCapped.capHeadBytes) {
            return `cap marker starts at byte ${markerAt}, before capHeadBytes ${want.surfaceCapped.capHeadBytes}`;
          }
          let lineEnd = 0;
          for (let index = 0; index < origin.length; index += 1) {
            if (origin[index] === 0x0a) {
              lineEnd = index + 1;
              if (lineEnd >= want.surfaceCapped.capHeadBytes) break;
            }
          }
          if (lineEnd === 0) lineEnd = origin.length;
          if (markerAt !== lineEnd) {
            return `cap marker starts at byte ${markerAt}, but the whole-line head covering capHeadBytes ${want.surfaceCapped.capHeadBytes} ends at ${lineEnd}`;
          }
        }
        if (!body.subarray(0, markerAt).equals(origin.subarray(0, markerAt))) {
          return 'the retained head is not the origin bytes verbatim';
        }
        if (want.surfaceCapped.bodyBelowBytes !== undefined
          && body.length >= want.surfaceCapped.bodyBelowBytes) {
          return `capped body is ${body.length} bytes, not below ${want.surfaceCapped.bodyBelowBytes}`;
        }
        // The origin's removed tail must survive nowhere in the replacement.
        return true;
      });
    }
    if ('surfaceSealed' in want) {
      check('session log contains the appended negative fact', () => (surfaceAppendTexts.length === want.surfaceSealed
        ? true : `expected ${want.surfaceSealed} appended negative fact(s) in the session log, saw ${surfaceAppendTexts.length}`));
      check('appended negative fact is the rendered one', () => {
        const published = kinds('publish').flatMap((line) => line.appendRecords ?? []).map((record) => record.text);
        if (published.length !== surfaceAppendTexts.length) return `published ${published.length} record(s) but the surface has ${surfaceAppendTexts.length}`;
        return published.every((text, index) => text === surfaceAppendTexts[index])
          ? true : 'the appended surface text differs from the published record';
      });
      // The fact must be in the model-visible surface after the request that
      // preceded it. A one-shot run appends it at the turn-end seam, so "the next
      // request carries it" is a *later* run's observation (S4); here the claim is
      // that it entered the surface and is the last message the surface derives.
      check('appended negative fact is in the session surface', () => {
        // It lands at the turn-end seam, so the last event may be `turn/end`;
        // what matters is that the fact is the newest surface message.
        const newest = [...sessionEvents].reverse().find((event) => event.surfaceOp === 'append');
        if (newest?.type === 'user/message'
          && newest?.data?.source?.kind === (want.recordName ?? 'racoons/negation')) return true;
        return `the newest surface message is ${String(newest?.type)} (source ${String(newest?.data?.source?.kind)}), not the appended negative fact`;
      });
      check('no later request contradicted the appended fact', () => {
        const needles = surfaceAppendTexts.filter((text) => text !== '');
        if (needles.length === 0) return 'no appended negative fact to look for';
        // Every request the mock answered before the append is unaffected; this
        // check keeps the assertion honest when the append lands mid-run.
        const appends = sessionEvents.filter((event) => event.type === 'user/message'
          && event.surfaceOp === 'append'
          && event.data?.source?.kind === (want.recordName ?? 'racoons/negation'));
        if (appends.length !== needles.length) return `${appends.length} surface appends vs ${needles.length} texts`;
        return true;
      });
    }
    if ('surfaceCapAbsentFrom' in want) {
      // The whole point of the cap: the oversized tail must not reach the wire.
      check('the full oversized body never reaches the request', () => {
        const needle = want.surfaceCapAbsentFrom;
        const carried = mains.some((entry) => JSON.stringify(entry.body?.messages ?? []).includes(needle));
        return carried ? 'a main request still carried the oversized body' : true;
      });
    }
    if ('nextRequestCarriesCapped' in want) {
      // S2's outbound half: the request after the capped result carries the
      // capped body, not the origin. Only assertable when the run has a request
      // after the tool result, which the cap scenario's second scripted turn is.
      check('the next outbound request carries the capped body', () => {
        const bodies = mains.map((entry) => JSON.stringify(entry.body?.messages ?? []));
        if (bodies.length < 2) return `need a request after the tool result, saw ${bodies.length} main request(s)`;
        const later = bodies.slice(1);
        if (!later.some((body) => body.includes('[Capped: '))) {
          return 'no main request after the first carried the cap marker';
        }
        return later.some((body) => body.includes(want.nextRequestCarriesCapped))
          ? true : `no later request carried ${JSON.stringify(want.nextRequestCarriesCapped)}`;
      });
    }
    if ('recallRestores' in want) {
      // The ledger side: every published cap archive must be recallable and give
      // back the exact original bytes, checked against the host's own result.
      check('recall restores the exact original bytes', () => {
        const archives = kinds('publish').flatMap((line) => line.archives ?? [])
          .filter((archive) => archive.operationKind === 'cap');
        if (archives.length === 0) return 'no cap archive to recall';
        const origin = originToolResults[0];
        const original = origin === undefined ? '' : (origin.data.message.content ?? [])
          .filter((block) => block?.type === 'text').map((block) => block.text).join('');
        const queried = archives.map((archive) => {
          const run = inspectLedger(ledgerPath, blobRoot,
            ['--recall', archive.recallId, '--sha256', archive.sourceSha256 ?? '']);
          if (run.status !== 0) return { ok: false, detail: (run.stderr ?? '').trim() };
          return JSON.parse(run.stdout);
        });
        const bad = queried.find((entry) => entry.status !== 'ok');
        if (bad !== undefined) return `recall failed: ${bad.detail ?? JSON.stringify(bad)}`;
        const restored = queried[0].restoredText;
        if (original === '') return 'no origin result to compare against';
        if (restored !== original) {
          return `restored ${restored.length} chars, origin has ${original.length}`;
        }
        return true;
      });
    }
    if ('recallRestorable' in want) {
      check('the sealed episode is restorable by recall id', () => {
        const archives = kinds('publish').flatMap((line) => line.archives ?? []);
        const sealed = kinds('publish').flatMap((line) => line.sealedEpisodeIds ?? []);
        if (archives.length === 0) return 'no archive published with the seal';
        if (sealed.length === 0) return 'no sealed episode id published';
        const bad = archives.map((archive) => {
          const run = inspectLedger(ledgerPath, blobRoot,
            ['--recall', archive.recallId, '--sha256', archive.sourceSha256 ?? '']);
          if (run.status !== 0) return { ok: false, detail: (run.stderr ?? '').trim() };
          return JSON.parse(run.stdout);
        }).find((entry) => entry.status !== 'ok');
        return bad === undefined ? true : `recall failed: ${bad.detail ?? JSON.stringify(bad)}`;
      });
    }
    if ('recallToolRestores' in want) {
      // The in-process half of S8 across a restart: the SECOND launch asks the
      // `recall` tool the marker's id, and the tool resolves it from the ledger
      // the FIRST launch wrote and closed. The restored body must equal the
      // origin result the resumed transcript still carries — byte for byte.
      check('the necromancy tool restores the original bytes after a restart', () => {
        const callIndex = toolCalls.findIndex((event) => event.data?.name === 'necromancy');
        if (callIndex === -1) return 'no necromancy tool call in the session log';
        const callId = toolCalls[callIndex].data?.callId;
        const result = toolResults.find((event) => event.data?.toolCallId === callId
          || event.data?.message?.source?.callId === callId);
        if (result === undefined) return `no tool/result for recall call ${String(callId)}`;
        const content = result.data?.message?.content ?? [];
        if (Array.isArray(content) && content.some((block) => block?.isError === true)) {
          return `the necromancy tool failed: ${JSON.stringify(content).slice(0, 300)}`;
        }
        const body = toolResultBody(result).toString('utf8');
        const origin = originToolResults[0];
        if (origin === undefined) return 'no origin tool result to compare against';
        const original = toolResultBody(origin).toString('utf8');
        // The host renders the tool's output through its `render` seam, which
        // returns the restored text itself; a host that stores the payload
        // object instead is read through its `text` field. Both spell the same
        // bytes, so the comparison is the bytes either way.
        let recalled = body;
        try {
          const payload = JSON.parse(body);
          if (payload !== null && typeof payload === 'object'
            && typeof payload.text === 'string') recalled = payload.text;
        } catch {
          // Not JSON: the rendered body is the restored text.
        }
        if (Buffer.byteLength(recalled, 'utf8') !== Buffer.byteLength(original, 'utf8')) {
          return `recalled ${Buffer.byteLength(recalled, 'utf8')} byte(s), origin has ${Buffer.byteLength(original, 'utf8')}`;
        }
        return recalled === original
          ? true : 'the recalled text differs from the origin result bytes';
      });
    }
    if ('recoveryPending' in want && want.recoveryPending === true) {
      // ADR-0004/0013: host receipts are memory-only, so a restarted mount
      // cannot confirm the first launch's applied intent and blocks every new
      // removal. Recall is a read of the durable ledger and stays live; the
      // assertion pins that partition, so a green run cannot hide a cut.
      check('the restarted mount blocks new removals', () => {
        const atRest = kinds('at-rest');
        if (atRest.length === 0) return 'no at-rest line to read';
        const pending = atRest.filter((line) => line.status === 'recovery-pending');
        return pending.length > 0 ? true
          : `no at-rest pass reported recovery-pending; saw ${JSON.stringify(atRest.map((line) => line.status))}`;
      });
    }
    if ('atRestUnchangedAfterRestart' in want && want.atRestUnchangedAfterRestart === true) {
      // ADR-0015: the restarted mount commits from the ledger's applied
      // receipts, so every at-rest pass of the SECOND launch reports unchanged
      // and none blocks as recovery-pending. The launch boundary is the second
      // `mounted` journal line: the journal is one file per evidence dir and
      // each process mounts once.
      check('the restarted mount commits from the ledger (at-rest unchanged)', () => {
        const mounted = kinds('mounted');
        if (mounted.length < 2) {
          return `expected two mounted line(s) (one per launch), saw ${mounted.length}`;
        }
        const secondAt = journal.indexOf(mounted[1]);
        const atRest = journal.slice(secondAt).filter((line) => line.kind === 'at-rest');
        if (atRest.length === 0) return 'the second launch wrote no at-rest line';
        const statuses = atRest.map((line) => line.status);
        if (statuses.includes('recovery-pending')) {
          return `the restarted mount blocked a pass: ${JSON.stringify(statuses)}`;
        }
        const notUnchanged = statuses.filter((status) => status !== 'unchanged');
        return notUnchanged.length === 0 ? true
          : `second-launch at-rest statuses ${JSON.stringify(statuses)}, expected all unchanged`;
      });
    }
    if ('ledgerSeals' in want) {
      // The ledger's own side: the append-only record carries the sealed episode
      // ids and generated record ids, read from a closed database in a new process.
      check('ledger records the seal', () => {
        const run = inspectLedger(ledgerPath, blobRoot);
        if (run.status !== 0) return (run.stdout ?? '').trim() || `inspect-ledger exited ${String(run.status)}`;
        const summary = JSON.parse(run.stdout);
        if (summary.status !== 'ok') return summary.detail ?? 'ledger summary failed';
        const sealed = summary.sealedEpisodeIds ?? [];
        if (want.ledgerSeals.episodes !== undefined && sealed.length !== want.ledgerSeals.episodes) {
          return `expected ${want.ledgerSeals.episodes} sealed episode(s) in the ledger, saw ${sealed.length}`;
        }
        if (want.ledgerSeals.recallIds !== undefined) {
          const ids = summary.applications.flatMap((application) => application.recallIds ?? []);
          if (ids.length !== want.ledgerSeals.recallIds) {
            return `expected ${want.ledgerSeals.recallIds} recall id(s) in the ledger, saw ${ids.length}`;
          }
        }
        if (want.ledgerSeals.negativeBytes !== undefined) {
          const generated = summary.applications.reduce((sum, application) => sum + (application.generatedBytes ?? 0), 0);
          if (generated !== want.ledgerSeals.negativeBytes) {
            return `expected ${want.ledgerSeals.negativeBytes} generated byte(s), saw ${generated}`;
          }
        }
        return true;
      });
    }
    if ('secondPassAddsNothing' in want) {
      // Exactly one at-rest publish: a repeated seal would append a second fact.
      check('a second at-rest pass adds nothing', () => {
        const appends = kinds('publish').filter((line) => line.mode === 'append');
        return appends.length === want.secondPassAddsNothing
          ? true : `expected ${want.secondPassAddsNothing} append publication(s), saw ${appends.length}`;
      });
    }
    if ('entryApplications' in want) {
      const entries = kinds('entry');
      check('entry applications', () => (entries.filter((line) => line.status === 'applied').length === want.entryApplications
        ? true : `expected ${want.entryApplications} applied entry application(s), saw ${entries.filter((line) => line.status === 'applied').length}`));
    }
    if ('entries' in want) {
      // The entry seam ran: one `entry` record per captured tool result. With the
      // cap off the product path (ADR-0014) nothing applies, so this is the fact
      // that a mounted scenario asserts instead of a cap plan.
      const entries = kinds('entry');
      check('tool results reach the entry seam', () => (entries.length === want.entries
        ? true : `expected ${want.entries} entry record(s), saw ${entries.length}`));
    }
    if ('skippedFailedResults' in want) {
      // A failed result is observed for the transcript but never delivered
      // (S7): the journal's own skip record names the reason.
      const failed = kinds('skip').filter((line) => line.reason === 'failed-result');
      check('failed results are skipped, not delivered', () => (failed.length === want.skippedFailedResults
        ? true : `expected ${want.skippedFailedResults} failed-result skip record(s), saw ${failed.length}`));
    }
    if ('entryAsks' in want) {
      // ISSUE-181 4a: the ENTRY ask lane's own outcome. `refusedTotal` counts the
      // prune table only, so before this check a hard-failing entry ask left
      // every prune assertion green. A scenario that mounts the entry lane states
      // both counts: `accepted` is an answered ask (an `entry-ask` row), and
      // `refused` is a fail-open ask the reader rejected. The healthy leg is
      // zero refused with at least one accepted answer; the entry-e2e runner's
      // refusal leg expects exactly its one scripted refusal.
      const acceptedAsks = kinds('entry-ask');
      const refusedAsks = kinds('entry-ask-refused');
      check('the entry asks were answered', () => (acceptedAsks.length === want.entryAsks.accepted
        ? true : `expected ${want.entryAsks.accepted} answered entry ask(s), saw ${acceptedAsks.length}`));
      check('the entry ask refusals were the expected ones', () => (refusedAsks.length === want.entryAsks.refused
        ? true : `expected ${want.entryAsks.refused} refused entry ask(s), saw ${refusedAsks.length}: ${JSON.stringify(refusedAsks.map((line) => [line.callId, line.code]))}`));
    }
    if ('surfaceReplacements' in want) {
      // Any mount rewrite of a stored result. Zero means the surface still holds
      // the host's own append-origin results only.
      check('the surface carries the scripted replacement count', () => (replacementToolResults.length === want.surfaceReplacements
        ? true : `expected ${want.surfaceReplacements} replacement tool/result(s), saw ${replacementToolResults.length}`));
    }
    if ('requestTextAbsent' in want) {
      // The negative wire assertion: a string no outbound main request carries.
      const needle = want.requestTextAbsent;
      const carried = mains.some((entry) => JSON.stringify(entry.body?.messages ?? []).includes(needle));
      check('the forbidden text never reaches a main request', () => (carried
        ? `a main request carried ${JSON.stringify(needle)}` : true));
    }
  }

  // ── Prune round-trip (ISSUE-022 chunk 5, record-only) ─────────────────────
  // The journal is the mount's account: `prune-requested` says the whole-message
  // `/prune` was observed, `prune-plan` says what the pass saw, `prune-table`
  // says what it asked (027: a prune ask rides the shared table loop, so the
  // old `prune-ask` line is gone), and `prune-recorded` is the one telemetry
  // record. Record-only is asserted from the other side too: no `publish`
  // record, and no session event carrying a surface op.
  if (expect.prune !== undefined) {
    const want = expect.prune;
    const racoonsDir = join(evidenceDir, 'racoons');
    let journal = [];
    try {
      journal = readFileSync(join(racoonsDir, 'cremator-events.jsonl'), 'utf8')
        .split(/\r?\n/u).filter((line) => line !== '').map((line) => JSON.parse(line));
    } catch {
      // Missing journal: every check below fails by name against an empty list.
    }
    const records = (kind) => journal.filter((line) => line.kind === kind);
    const requested = records('prune-requested');
    const plans = records('prune-plan');
    // One `prune-table` line per table sent; a table whose reply arrived
    // carries `answered > 0`. A refused table writes `prune-skip` instead.
    const asks = records('prune-table').filter((line) => (line.answered ?? 0) > 0);
    const skips = records('prune-skip');
    const recorded = records('prune-recorded');
    const thresholds = records('prune-threshold');
    // The bar is journalled on every boundary that read it, with `crossed` on
    // each line, so a raw line count is an EVALUATION count. Every assertion
    // below about a threshold means "fired", so it reads the fire subset; a
    // pre-change line has no `crossed` and was a fire (`prune-fires.mjs`).
    const thresholdFires = thresholds.filter(isPruneFire);
    const applies = records('prune-apply');
    const applySkips = records('prune-apply-skipped');
    // One `mounted` line per process, so the journal's own boundaries give the
    // per-launch view: a crossing or a pass is attributed to the process that
    // wrote it, and "once per crossing, not once per step" becomes a count per
    // launch instead of a total that two launches could fake.
    const mountedAt = journal.flatMap((line, index) => (line.kind === 'mounted' ? [index] : []));
    const launchSlices = mountedAt.map((start, index) => journal.slice(start, mountedAt[index + 1] ?? journal.length));
    const perLaunch = (kind, keep = () => true) => launchSlices
      .map((slice) => slice.filter((line) => line.kind === kind && keep(line)).length);
    const firesPerLaunch = perLaunch('prune-threshold', isPruneFire);
    if ('requested' in want) {
      check('the whole /prune message was observed once', () => (requested.length === want.requested
        ? true : `expected ${want.requested} prune-requested record(s), saw ${requested.length}`));
    }
    if ('recorded' in want) {
      check('the pass wrote one prune-recorded', () => (recorded.length === want.recorded
        ? true : `expected ${want.recorded} prune-recorded record(s), saw ${recorded.length}`));
    }
    if ('reasonNull' in want && want.reasonNull === true) {
      // A null reason means the ask ran; a named reason means it never did.
      check('the pass was asked, not refused', () => (recorded.length > 0 && recorded.every((line) => line.reason === null)
        ? true : `prune-recorded reasons: ${JSON.stringify(recorded.map((line) => line.reason))}; skips: ${JSON.stringify(skips.map((line) => line.reason))}`));
    }
    if ('round' in want) {
      check('the pass carries its round ordinal', () => (recorded.length > 0 && recorded.every((line) => line.round === want.round)
        ? true : `expected round ${want.round}, saw ${JSON.stringify(recorded.map((line) => line.round))}`));
    }
    if ('rounds' in want) {
      // The ordinals in order. A resumed process reads the last one from disk,
      // so `[1, 2]` proves the count continued instead of restarting at 1.
      check('the passes carry their round ordinals', () => (JSON.stringify(recorded.map((line) => line.round))
        === JSON.stringify(want.rounds) ? true
        : `expected rounds ${JSON.stringify(want.rounds)}, saw ${JSON.stringify(recorded.map((line) => line.round))}`));
    }
    if ('resumedRounds' in want) {
      // The mount's own line: the round it read back from this session's
      // directory before it ran its first pass.
      const resumed = records('prune-round-resumed');
      check('a resumed process continued the round ordinal', () => (JSON.stringify(resumed.map((line) => line.round))
        === JSON.stringify(want.resumedRounds) ? true
        : `expected resumed rounds ${JSON.stringify(want.resumedRounds)}, saw ${JSON.stringify(resumed.map((line) => line.round))}`));
    }
    if ('thresholds' in want) {
      // The half-window trigger's own record: one firing per crossing. The
      // line count is the evaluation count, so the assertion reads fires.
      check('the half-window trigger fired once per crossing', () => (thresholdFires.length === want.thresholds
        ? true : `expected ${want.thresholds} prune-threshold fire(s), saw ${thresholdFires.length} `
          + `(${thresholds.length} evaluation line(s))`));
    }
    if ('threshold' in want) {
      // A reading, not a fire: every line the bar wrote — evaluation or fire —
      // must name the same configured bar, so this check reads all of them.
      check('the trigger measured against half the configured window', () => (thresholds.length > 0
        && thresholds.every((line) => line.threshold === want.threshold)
        ? true : `expected threshold ${want.threshold}, saw ${JSON.stringify(thresholds.map((line) => line.threshold))}`));
    }
    if ('crossingsPerLaunch' in want) {
      check('each launch crossed at most once', () => (JSON.stringify(firesPerLaunch)
        === JSON.stringify(want.crossingsPerLaunch) ? true
        : `expected crossings per launch ${JSON.stringify(want.crossingsPerLaunch)}, saw ${JSON.stringify(firesPerLaunch)}`));
    }
    if ('passesPerLaunch' in want) {
      check('each launch ran the passes its crossings called for', () => (JSON.stringify(perLaunch('prune-recorded'))
        === JSON.stringify(want.passesPerLaunch) ? true
        : `expected passes per launch ${JSON.stringify(want.passesPerLaunch)}, saw ${JSON.stringify(perLaunch('prune-recorded'))}`));
    }
    if ('applies' in want) {
      // The bridge's own line: the pass reached the engine at all.
      check('the prune apply reached the engine', () => (applies.length === want.applies
        ? true : `expected ${want.applies} prune-apply record(s), saw ${applies.length} (skips: ${JSON.stringify(applySkips.map((line) => line.reason))})`));
    }
    if ('applyStatus' in want) {
      check('the engine applied the pass', () => (applies.length > 0
        && applies.every((line) => line.status === want.applyStatus)
        ? true : `expected status ${want.applyStatus}, saw ${JSON.stringify(applies.map((line) => line.status))}`));
    }
    if ('applyRemovals' in want) {
      check('the applied pass carried the scripted removals', () => (applies.length > 0
        && applies.every((line) => line.removals === want.applyRemovals)
        ? true : `expected ${want.applyRemovals} removal(s), saw ${JSON.stringify(applies.map((line) => line.removals))}`));
    }
    if ('applyEnforcement' in want) {
      // CRITIC-022 P2 #8: the terms the engine decided under are on the line.
      check('the apply line states the enforcement mode', () => (applies.length > 0
        && applies.every((line) => line.enforcement === want.applyEnforcement)
        ? true : `expected enforcement ${JSON.stringify(want.applyEnforcement)}, saw ${JSON.stringify(applies.map((line) => line.enforcement))}`));
    }
    if ('applyRevertHistory' in want) {
      check('the apply line states the host revert capability', () => (applies.length > 0
        && applies.every((line) => line.revertHistory === want.applyRevertHistory)
        ? true : `expected revertHistory ${String(want.applyRevertHistory)}, saw ${JSON.stringify(applies.map((line) => line.revertHistory))}`));
    }
    if ('applySkipReasons' in want) {
      check('a pass with nothing to apply named its reason', () => (JSON.stringify(applySkips.map((line) => line.reason))
        === JSON.stringify(want.applySkipReasons) ? true
        : `expected apply skip reasons ${JSON.stringify(want.applySkipReasons)}, saw ${JSON.stringify(applySkips.map((line) => line.reason))}`));
    }
    if ('l2RemovalCounts' in want) {
      check('each answered map produced its scripted counts', () => (JSON.stringify(recorded.map((line) => line.l2RemovalCount))
        === JSON.stringify(want.l2RemovalCounts) ? true
        : `expected ${JSON.stringify(want.l2RemovalCounts)}, saw ${JSON.stringify(recorded.map((line) => line.l2RemovalCount))}`));
    }
    if ('asks' in want) {
      // `asks` is the TOTAL answered tables across the whole run, so a scenario
      // with two passes states 2 here. `asksPerPass` is the per-record count
      // and defaults to `asks` for the single-pass scenarios that predate it.
      // An ARRAY states one value per pass, in order: a settled-keep pass sends
      // no table at all (ISSUE-073), so its count differs from its neighbours'.
      const asksPerPass = want.asksPerPass ?? want.asks;
      check('the prune pass asked every batch', () => (asks.length === want.asks
        ? true : `expected ${want.asks} answered prune ask(s), saw ${asks.length} (skips: ${JSON.stringify(skips.map((line) => `${String(line.reason)}: ${String(line.message)}`))})`));
      check('the record counts the answered asks', () => (recorded.length > 0
        && perTableMatches(asksPerPass, recorded.map((line) => line.asks))
        ? true : `expected asks ${JSON.stringify(asksPerPass)} per pass, saw ${JSON.stringify(recorded.map((line) => line.asks))}`));
    }
    if ('tableUnits' in want) {
      // The shared table loop journals the table's row count, not its index
      // list: the indices live in the sent request, not in the journal. A
      // corrected-protocol run can ask a different row count per pass (launch
      // 1 has one landed unit, later launches have two), so an ARRAY states one
      // value per asked table, in order, and a scalar means "every table".
      // An EMPTY array is the settled-keep pass (ISSUE-073): no table was sent
      // at all, so it asserts the absence rather than skipping.
      const emptyButExpected = Array.isArray(want.tableUnits) && want.tableUnits.length === 0;
      check('the ask table carried the planned rows', () => ((asks.length > 0 || emptyButExpected)
        && perTableMatches(want.tableUnits, asks.map((line) => line.tableUnits))
        ? true : `expected ${JSON.stringify(want.tableUnits)} table row(s), saw ${JSON.stringify(asks.map((line) => line.tableUnits))}`));
    }
    if ('planUnits' in want) {
      check('the plan counted the in-memory units', () => (plans.length > 0
        && perTableMatches(want.planUnits, plans.map((line) => line.units))
        ? true : `expected ${JSON.stringify(want.planUnits)} unit(s), saw ${JSON.stringify(plans.map((line) => line.units))}`));
    }
    if ('planAskRows' in want) {
      check('the plan numbered every row', () => (plans.length > 0
        && perTableMatches(want.planAskRows, plans.map((line) => line.askRows))
        ? true : `expected ${JSON.stringify(want.planAskRows)} ask row(s), saw ${JSON.stringify(plans.map((line) => line.askRows))}`));
    }
    if ('settledWithheld' in want) {
      // ISSUE-073: the units a settled entry keep withheld from this pass's ask.
      // Counted per pass, like `planAskRows`; 0 is the ordinary "nothing was
      // settled" reading, never a claim that the exclusion is off by default.
      check('the settled keeps were withheld from the ask', () => (plans.length > 0
        && perTableMatches(want.settledWithheld, plans.map((line) => line.settledWithheld))
        ? true : `expected ${JSON.stringify(want.settledWithheld)} withheld unit(s), saw ${JSON.stringify(plans.map((line) => line.settledWithheld))}`));
    }
    if ('l2RemovalCount' in want) {
      // keepall removes nothing, so an all-keepall map yields zero here. A
      // non-zero count would mean the mock's map was read as a removal.
      check('the answered map produced the scripted counts', () => (recorded.length > 0
        && recorded.every((line) => JSON.stringify(line.l2RemovalCount) === JSON.stringify(want.l2RemovalCount))
        ? true : `expected ${JSON.stringify(want.l2RemovalCount)}, saw ${JSON.stringify(recorded.map((line) => line.l2RemovalCount))}`));
    }
    if ('refusedTotal' in want) {
      check('no index was refused', () => (recorded.length > 0 && recorded.every((line) => Object.values(line.refusedCount ?? {})
        .reduce((sum, count) => sum + count, 0) === want.refusedTotal)
        ? true : `expected ${want.refusedTotal} refused index(es), saw ${JSON.stringify(recorded.map((line) => line.refusedCount))}`));
    }
    if ('rejectedCount' in want) {
      check('no answer addressed a foreign index', () => (recorded.length > 0 && recorded.every((line) => line.rejectedCount === want.rejectedCount)
        ? true : `expected ${want.rejectedCount} rejected key(s), saw ${JSON.stringify(recorded.map((line) => line.rejectedCount))}`));
    }
    if ('keeplinesSummaries' in want) {
      check('the pass carried the scripted keeplines trailers', () => (recorded.length > 0
        && recorded.every((line) => (line.keeplinesSummaries ?? []).length === want.keeplinesSummaries)
        ? true : `expected ${want.keeplinesSummaries} trailer(s), saw ${JSON.stringify(recorded.map((line) => line.keeplinesSummaries))}`));
    }
    if ('noPublish' in want && want.noPublish === true) {
      // Record-only: nothing reached the ledger's publish seam.
      check('the record-only pass published nothing', () => (records('publish').length === 0
        ? true : `${records('publish').length} publish record(s) appeared`));
    }
    if ('correction' in want) {
      // ISSUE-120: the pass's ONE correction turn over rows whose LAST attempt
      // refused. The red proof corrupts the correction answer, so this check
      // must fail by this exact name when the turn answers nothing.
      const wantCorrection = want.correction;
      const corrections = records('prune-correction');
      check('the pass spent its one correction turn on the refused row', () => {
        const expectedTurns = wantCorrection.turns ?? 1;
        if (corrections.length !== expectedTurns) {
          return `expected ${expectedTurns} prune-correction record(s), saw ${corrections.length}`;
        }
        const line = corrections[0];
        const faults = [];
        for (const key of ['corrected', 'stillRefused', 'refusedRows', 'ofRows']) {
          if (key in wantCorrection && line[key] !== wantCorrection[key]) {
            faults.push(`${key} ${String(line[key])}, expected ${String(wantCorrection[key])}`);
          }
        }
        if ('reasons' in wantCorrection
          && JSON.stringify(line.reasons) !== JSON.stringify(wantCorrection.reasons)) {
          faults.push(`reasons ${JSON.stringify(line.reasons)}, expected ${JSON.stringify(wantCorrection.reasons)}`);
        }
        return faults.length === 0 ? true : faults.join('; ');
      });
    }
    if ('surfaceOps' in want) {
      // The host stamps `surfaceOp: 'append'` on its own surface events, so a
      // write of the mount's is the other two shapes: an object op (a replace)
      // and an appended record carrying the mount's source kind.
      const touched = sessionEvents.filter((event) =>
        (typeof event.surfaceOp === 'object' && event.surfaceOp !== null)
        || (event.type === 'user/message'
          && event.data?.source?.kind === (want.recordName ?? 'racoons/negation')));
      check('the record-only pass touched no surface', () => (touched.length === want.surfaceOps
        ? true : `expected ${want.surfaceOps} mount surface op(s), saw ${touched.length}: ${JSON.stringify(touched.map((event) => event.type))}`));
    }
    if ('noPruneError' in want && want.noPruneError === true) {
      check('the prune seam raised nothing into the host step', () => (records('prune-error').length === 0
        ? true : `prune-error: ${JSON.stringify(records('prune-error').map((line) => line.message))}`));
    }
  }

  const failures = results.filter((result) => !result.ok);
  const result = {
    scenario: {
      slug: scenario.slug,
      date: scenario.date,
      perturbation: scenario.perturbation,
      timeoutMs: scenario.timeoutMs,
      ...(scenario.realApi ? { provider: 'a6-real' } : {}),
    },
    dsh: { version: dshVersion, bin: binJs, launch_command: launches[0].launchCommand,
      launch_commands: launches.map((launch) => launch.launchCommand), cwd: workDir },
    env: {
      DSH_HOME: homeDir,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_PERMISSION_MODE: 'danger-full-access',
      // Tier 3 has neither: no mock URL, no dummy key. Recording them anyway
      // would misreport what the child saw.
      ...(scenario.realApi
        ? { A6_API_KEY: '<resolved by dsh from the credential store; never read here>', RIG_SESSIONS_DIR: sessionsDir, RIG_STORAGES_DIR: storagesDir }
        : { DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: '<dummy>' }),
    },
    launches: launches.map((launch) => ({
      task: launch.task, session_id: launch.sessionId, exit: launch.exit,
      started_at: launch.startedAt, finished_at: launch.finishedAt,
      watchdog: launch.watchdog,
    })),
    watchdog: launches[0].watchdog,
    exit: { code: exit.code, signal: exit.signal,
      started_at: launches[0].startedAt, finished_at: launches[launches.length - 1].finishedAt },
    mock: mock === null
      ? { started: false }
      : { started: true, port, requests: requests.length, main: mains.length, title: titles.length, prune: prunes.length },
    evidence: {
      dir: evidenceDir,
      requests: requestLog,
      session: sessionFiles.map((file) => file),
      stdout: join(evidenceDir, 'stdout.ndjson'),
      stderr: join(evidenceDir, 'stderr.log'),
      patch: patchPath,
      script: scriptPath,
    },
    assertions: results,
    passed: failures.length === 0 && !watchdogFired,
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);

  if (watchdogFired) {
    process.stderr.write(`FAIL: watchdog fired after ${watchdogMs} ms; tree killed with: ${watchdogCommand}\n`);
    process.exit(1);
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL: ${failure.name}: ${failure.detail ?? ''}\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS ${scenario.slug}: ${results.length} assertion(s); evidence ${evidenceDir}\n`);
}

// Run only when this file is the process entry point. The guard lets
// `run-env.test.mjs` import `buildChildEnv`/`probeDshVersion` without launching
// a run; `node dev/dsh-rig/run.mjs …` (and run-entry-e2e's spawn) still
// executes `main()` exactly once.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
