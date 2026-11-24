#!/usr/bin/env node
/**
 * ISSUE-260 — the opencode runner's live-run isolation and key-safety gates.
 *
 * Offline only: the process table is synthetic, the home and credential paths
 * live in a temp directory, and the one child process is a `--dry-run` that
 * spawns no host and sends no request. The sentinels are values, never this
 * machine's key or PIDs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allowReadRefusal, captureLoaderSource, childEnv, concurrentDesktopServiceRecord,
  credentialReadRefusal, DEEPSEEK_OFFICIAL_ROUTE, desktopServicePreflight,
  desktopServiceProcesses, detectDesktopService, evidenceKeyLeak, HOST_SHELL_TOOLS,
  installedHostPaths,
  OPENCODE_CHILD_ENV_ALLOW, readTaskFile, realDataChanges, realDataProbeRefusal,
  realDataSnapshot, realLogPaths, realLogSnapshot, redirectEnv, redirectHeldRecord,
  taskKeyRefusal, workspaceSourceDigest, writeCaptureLoader,
} from './opencode-run.mjs';
import { CHILD_ENV_ALLOW, helperEnv } from './child-env-allow.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = join(BENCH_DIR, 'opencode-run.mjs');
const KEY = 'sk-racoons-SENTINEL-260-0123456789abcdef';
const OTHER_KEY = 'OTHER_KEY-racoons-SENTINEL-260';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'racoons-live-safety-'));
}

/** A child environment with every forbidden inherited name removed. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, NODE_OPTIONS: '', ...extra };
  for (const name of ['BENCH_REAL_API', 'RIG_REAL_API', 'BENCH_REAL_KEY']) delete env[name];
  return env;
}

/** The launcher's dry-run JSON, with its exit status checked. */
function dryRun(args, env = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8', timeout: 120_000, env: cleanEnv(env),
  });
  assert.equal(result.status, 0, result.stderr);
  return { result, output: JSON.parse(result.stdout) };
}

/* ------------------------------------------------------------ process preflight */

test('preflight: synthetic serve --service rows refuse the launch, and the override is explicit', () => {
  const rows = [
    { pid: 4101, commandline: '"C:\\Apps\\opencode\\opencode-cli.exe" serve --service' },
    { pid: 4102, commandline: '"C:\\Apps\\opencode\\opencode.exe" run --standalone x' },
  ];
  const verdict = desktopServiceProcesses(rows);
  assert.equal(verdict.detected, true);
  const service = {
    platform: 'win32', detected: verdict.detected, processes: verdict.processes,
    listed: rows.length, why: 'synthetic process table',
  };
  const refused = desktopServicePreflight({ service, platform: 'win32' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /an opencode host/u);
  assert.match(refused.message, /pid 4101/u);
  assert.equal(refused.snapshot.listed, 2);
  const overridden = desktopServicePreflight({ service, platform: 'win32', allow: true });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.override, true);
  assert.match(overridden.message, /--allow-desktop-service/u);
  // A normal opencode run is not the service.
  const quiet = desktopServiceProcesses([
    { pid: 4103, commandline: '"C:\\Apps\\opencode\\opencode.exe" run --standalone task' },
  ]);
  assert.equal(quiet.detected, false);
  assert.equal(desktopServicePreflight({
    service: { platform: 'win32', detected: false, processes: [], listed: 1, why: 'none' },
    platform: 'win32',
  }).ok, true);
  // A process list that could not be read cannot prove the service is absent.
  const unreadable = { platform: 'win32', detected: false, processes: [], listed: null,
    why: 'the process list was not JSON' };
  assert.equal(desktopServicePreflight({ service: unreadable, platform: 'win32' }).ok, false);
  assert.equal(desktopServicePreflight({
    service: unreadable, platform: 'win32', allow: true,
  }).ok, true);
  // No desktop service exists on another platform, so an unread list is not a refusal.
  assert.equal(desktopServicePreflight({
    service: { ...unreadable, platform: 'linux' }, platform: 'linux',
  }).ok, true);
});

test('preflight: the real-log window is a stat pair around the run', () => {
  const dir = scratch();
  try {
    const db = join(dir, '.local', 'share', 'opencode', 'opencode.db');
    const log = join(dir, '.local', 'share', 'opencode', 'log', 'opencode.log');
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(db, 'db\n', 'utf8');
    writeFileSync(log, 'first\n', 'utf8');
    const paths = realLogPaths([{ path: db }, { path: `${db}-wal` }]);
    assert.deepEqual(paths, [log]);
    const before = realLogSnapshot(paths);
    assert.equal(before[0].exists, true);
    writeFileSync(log, 'first\nsecond line\n', 'utf8');
    const after = realLogSnapshot(paths);
    assert.equal(after[0].exists, true);
    assert.ok(after[0].sizeBytes > before[0].sizeBytes);
    // A missing log is recorded as absent, not as an error.
    const missing = realLogSnapshot([join(dir, 'absent.log')]);
    assert.equal(missing[0].exists, false);
    assert.equal(missing[0].sizeBytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ W2: refusal strength */

test('ISSUE-260 W2: any opened opencode host executable is detected', () => {
  const installed = 'C:\\Apps\\opencode\\opencode-cli.exe';
  const rows = [
    // A run (not `serve --service`) of the installed binary still holds the real
    // data directory open; the executable path alone is enough.
    { pid: 4201, executablePath: installed,
      commandline: '"C:\\Apps\\opencode\\opencode-cli.exe" run --standalone task',
      startedAt: '2026-11-15T10:00:00.000Z' },
    { pid: 4202, executablePath: 'C:\\Other\\opencode-cli.exe',
      commandline: '"C:\\Other\\opencode-cli.exe" run --standalone task' },
  ];
  const verdict = desktopServiceProcesses(rows, { hostPaths: [installed] });
  assert.equal(verdict.detected, true);
  assert.deepEqual(verdict.processes.map((row) => row.pid), [4201],
    'a same-named exe outside the installed path is not the host');
  // The path and the command line are OR signals: an executable path the host
  // list does not name is still the service when its command line is the triple.
  const wrapped = desktopServiceProcesses([{
    pid: 4205, executablePath: 'C:\\Shim\\opencode-cli.exe', startedAt: 1000,
    commandline: '"C:\\Shim\\opencode-cli.exe" serve --service',
  }], { hostPaths: [installed] });
  assert.deepEqual(wrapped.processes.map((row) => row.pid), [4205],
    'the argv triple detects a row whose ExecutablePath is not a host path');
  // The command-line triple also stands alone when no executable path is listed.
  const fallback = desktopServiceProcesses([{
    pid: 4203, commandline: '"C:\\x\\opencode-cli.exe" serve --service',
  }], { hostPaths: [installed] });
  assert.deepEqual(fallback.processes.map((row) => row.pid), [4203]);
  assert.equal(desktopServiceProcesses([
    { pid: 4204, commandline: '"C:\\x\\opencode.exe" run --standalone task' },
  ], { hostPaths: [installed] }).detected, false);
  // A process list that could not be read cannot prove the host is absent.
  const unreadable = { platform: 'win32', detected: false, processes: [], listed: null,
    why: 'the process list was not JSON' };
  assert.equal(desktopServicePreflight({ service: unreadable, platform: 'win32' }).ok, false);
});

test('ISSUE-260 W2: the desktop app bundles outside PATH are host paths', () => {
  const dir = scratch();
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  try {
    const localAppData = join(dir, 'Local');
    const appData = join(dir, 'Roaming');
    const localBundle = join(localAppData, 'OpenCode', 'opencode.exe');
    const cliBundle = join(appData, 'ai.opencode.desktop', 'cli', '2.1.4-x64', 'opencode-cli.exe');
    for (const path of [localBundle, cliBundle]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'stub\n', 'utf8');
    }
    process.env.LOCALAPPDATA = localAppData;
    process.env.APPDATA = appData;
    const hostPaths = installedHostPaths({ pathEnv: '' });
    assert.ok(hostPaths.includes(realpathSync(localBundle).toLowerCase()),
      'the LOCALAPPDATA bundle is a host path');
    assert.ok(hostPaths.includes(realpathSync(cliBundle).toLowerCase()),
      'a versioned bundle under APPDATA\\ai.opencode.desktop\\cli is a host path');
    assert.deepEqual(desktopServiceProcesses([{
      pid: 4206, executablePath: cliBundle,
      commandline: `"${cliBundle}" serve --service`,
    }], { hostPaths }).processes.map((row) => row.pid), [4206]);
  } finally {
    for (const name of ['LOCALAPPDATA', 'APPDATA']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-260 W2: a desktop override needs a complete writer record', () => {
  const hostLog = {
    path: 'C:/u/.local/share/opencode/log/opencode.log',
    windows: [[3000, 7000]],
    matched: [{ timestamp: '2026-11-15T10:02:30.000Z', run: 'desk', role: null, line: 'x' }],
    why: 'one line names another run',
  };
  const realChanged = [{ path: 'C:/u/.local/share/opencode/opencode.db',
    why: 'mtime changed (1 -> 2)' }];
  const preflightAt = '2026-11-15T10:05:00.000Z';
  const writer = {
    pid: 5248,
    executablePath: 'C:\\Users\\TZhen\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.1.4-x64\\opencode-cli.exe',
    commandline: '"C:\\Users\\TZhen\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.1.4-x64\\opencode-cli.exe" serve --service',
    startedAt: '2026-11-15T10:00:00.000Z',
  };
  const record = concurrentDesktopServiceRecord({
    realChanged, service: { detected: true, processes: [writer], at: preflightAt }, hostLog,
  });
  assert.equal(record.status, 'not-applicable');
  for (const field of ['pid', 'executablePath', 'commandline', 'startedAt']) {
    assert.equal(concurrentDesktopServiceRecord({
      realChanged,
      service: { detected: true, processes: [{ ...writer, [field]: null }], at: preflightAt },
      hostLog,
    }), null, `a row missing ${field} is not a named writer`);
  }
  // A row started after the preflight may be the measured child itself.
  assert.equal(concurrentDesktopServiceRecord({
    realChanged,
    service: {
      detected: true,
      processes: [{ ...writer, startedAt: '2026-11-15T10:06:00.000Z' }],
      at: preflightAt,
    },
    hostLog,
  }), null);
});

test('ISSUE-260 W2: a seeded replay row alone is not a proven redirect', () => {
  const rows = [{ path: 'world/.local/share/opencode/opencode.db', exists: true, total: 1 }];
  const sessionId = 'ses_RAC00NS5YNTH3T1C0000000000';
  const seedOnly = redirectHeldRecord({ source: 'seeded' }, rows, true, {
    sessionId,
    seededSessionId: sessionId,
    hostEvidence: { ok: false, signals: [], why: 'no host log' },
  });
  assert.equal(seedOnly.status, 'fail');
  assert.equal(seedOnly.source, 'seed-only');
  assert.match(seedOnly.detail, /the redirect itself is not witnessed/u);
  const witnessed = redirectHeldRecord({ source: 'seeded' }, rows, true, {
    sessionId,
    seededSessionId: sessionId,
    hostEvidence: { ok: true, signals: ['host-log-names-session'], why: 'the host opened it' },
  });
  assert.equal(witnessed.status, 'pass');
  assert.equal(witnessed.basis, 'seeded+host');
});

test('ISSUE-260 W2: a real data file changed across the --version probe refuses before launch', () => {
  const before = [{ path: 'C:/u/.local/share/opencode/opencode.db', exists: true,
    sizeBytes: 10, mtimeMs: 1000 }];
  assert.equal(realDataProbeRefusal(before, [{ ...before[0] }]), null);
  const changed = [{ ...before[0], sizeBytes: 11 }];
  const refused = realDataProbeRefusal(before, changed);
  assert.equal(refused.code, 'redirect-real-data-changed');
  assert.match(refused.message, /opencode\.db/u);
  assert.match(refused.message, /size changed/u);
  assert.equal(realDataChanges(before, changed).length, 1,
    'the refusal is the snapshot compare, not a second rule');
  // The re-stat sits between the `--version` probe and the first world write.
  const runner = readFileSync(RUNNER, 'utf8');
  const probe = runner.indexOf("spawnSync(opts.bin, ['--version']");
  const restat = runner.indexOf(
    'realDataProbeRefusal(realDataBefore, realDataSnapshot(realDataPaths))');
  const firstWrite = runner.indexOf(
    'for (const dir of [configDir, ...(continuing ? [] : [workDir]), mockDir]) {');
  assert.ok(probe > 0 && restat > probe && firstWrite > restat,
    `probe ${probe} < re-stat ${restat} < first mkdirSync ${firstWrite}`);
});

test('ISSUE-260 W4: a route key found in an evidence file fails the leak scan', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'world'), { recursive: true });
    writeFileSync(join(dir, 'result.json'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'world', 'clean.txt'), 'nothing here\n', 'utf8');
    const clean = evidenceKeyLeak(KEY, dir);
    assert.equal(clean.ok, true);
    assert.equal(clean.scanned, 2);
    assert.deepEqual(clean.found, []);
    assert.equal(JSON.stringify(clean).includes(KEY), false, 'the scan never echoes the key');
    writeFileSync(join(dir, 'world', 'capture.jsonl'), `{"body":"${KEY}"}\n`, 'utf8');
    const leak = evidenceKeyLeak(KEY, dir);
    assert.equal(leak.ok, false);
    assert.deepEqual(leak.found, ['world/capture.jsonl']);
    assert.equal(JSON.stringify(leak).includes(KEY), false, 'the leak record carries no key bytes');
    assert.equal(evidenceKeyLeak(undefined, dir).ok, true, 'the mock route has no key to scan');
    // The scan is wired into the finalize path, before the pass verdict.
    const runner = readFileSync(RUNNER, 'utf8');
    const scan = runner.indexOf("check('evidence-key-leak'");
    const verdict = runner.indexOf('} = passedVerdict(assertions);');
    assert.ok(scan > 0 && verdict > scan, `leak check ${scan} < verdict ${verdict}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ child environment */

test('ISSUE-260 W1: sentinel credentials are stripped and only allow-list names plus the route key survive', () => {
  const worldDir = join(tmpdir(), 'racoons-w1-world');
  const redirects = redirectEnv(worldDir);
  // Every allow-listed name is present in the source, so the child key set is
  // exactly the allow-list plus the redirect writes: nothing inherited can
  // survive by escaping a pattern.
  const source = Object.fromEntries(
    OPENCODE_CHILD_ENV_ALLOW.map((name) => [name, `source-${name.toLowerCase()}`]),
  );
  Object.assign(source, {
    OTHER_KEY,
    OPENAI_API_KEY: 'sk-openai-sentinel',
    NODE_OPTIONS: '--require evil',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\xxxxx',
    DRIVERDATA: 'C:\\Windows\\System32\\Drivers\\DriverData',
    [DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv]: KEY,
  });
  const expected = [...new Set([...OPENCODE_CHILD_ENV_ALLOW, ...Object.keys(redirects)])].sort();
  const mock = childEnv(redirects, {}, source);
  assert.deepEqual(Object.keys(mock.env).sort(), expected,
    'the mock route child holds the allow-list and the redirect writes, nothing else');
  for (const name of ['OTHER_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'HOMEDRIVE']) {
    assert.equal(Object.hasOwn(mock.env, name), false, `${name} survived the allow-list`);
    assert.ok(mock.stripped.includes(name), `${name} is named as stripped`);
  }
  assert.equal(Object.hasOwn(mock.env, DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv), false,
    'the mock route admits no key name');
  assert.equal(mock.env.TEMP, redirects.TEMP, 'the redirected temp root wins over the source');
  assert.equal(mock.env.HOME, redirects.HOME, 'the redirected home wins over the source');
  // `HOMEDRIVE` is the dsh lane's, not this one's; bench-run.test.mjs proves the
  // other half of that sentence.
  assert.equal(Object.hasOwn(mock.env, 'DRIVERDATA'), false);

  const real = childEnv(redirects, { allowKeyNames: [DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv] }, source);
  assert.equal(real.env[DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv], KEY,
    'the one real-route key variable is allowed');
  assert.deepEqual(Object.keys(real.env).sort(),
    [...new Set([...expected, DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv])].sort());
  assert.deepEqual(real.allowList, [...OPENCODE_CHILD_ENV_ALLOW, DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv],
    'the recorded allow-list names the route key too');
  // The launch record writes the same list beside the key names, so evidence
  // can never claim a narrower list than the child received.
  const runner = readFileSync(RUNNER, 'utf8');
  assert.match(runner, /env: \{\r?\n\s*allowList,/u);
  assert.match(runner, /allowedKeyEnvs: allowKeyNames,/u);
});

/* ------------------------------------------------------------ helper environment */

test('ISSUE-260 audit-2: a helper spawn gets the base allow-list and no route key', () => {
  const source = Object.fromEntries(
    CHILD_ENV_ALLOW.map((name) => [name, `source-${name.toLowerCase()}`]),
  );
  Object.assign(source, {
    [DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv]: KEY,
    OTHER_KEY,
    OPENAI_API_KEY: 'sk-openai-sentinel',
    DEEPSEEK_BASE_URL: 'https://evil.invalid/v1',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\xxxxx',
  });
  const env = helperEnv(source);
  assert.deepEqual(Object.keys(env).sort(), [...CHILD_ENV_ALLOW].sort(),
    'a helper inherits the base 40 names and nothing else');
  for (const name of [DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv, OTHER_KEY, 'OPENAI_API_KEY',
    'DEEPSEEK_BASE_URL', 'HOMEDRIVE', 'HOMEPATH']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} reached a helper spawn`);
  }
});

test('ISSUE-260 audit-2: the process preflight spawns powershell with no route key', (t) => {
  const keyName = DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv;
  const previous = process.env[keyName];
  process.env[keyName] = KEY;
  t.after(() => {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  });
  let seen = null;
  const run = (bin, argv, options) => {
    seen = { bin, argv, options };
    return { stdout: '', status: 0 };
  };
  const snapshot = detectDesktopService({ platform: 'win32', run });
  assert.equal(seen.bin, 'powershell.exe');
  assert.equal(Object.hasOwn(seen.options.env, keyName), false,
    'the parent carried the key; the powershell helper did not');
  const allowed = new Set(CHILD_ENV_ALLOW);
  for (const name of Object.keys(seen.options.env)) {
    assert.ok(allowed.has(name.toUpperCase()), `${name} is not on the base allow-list`);
  }
  assert.equal(snapshot.listed, 0);
});

test('ISSUE-260 audit-2: every helper spawn call site uses the scrubbed helper env', () => {
  const runner = readFileSync(RUNNER, 'utf8');
  // npm resolves the global package root; taskkill ends the host. Neither is
  // the host child, so neither may inherit the route key or the redirect.
  assert.match(runner,
    /spawnSync\('npm', \['root', '-g'\], \{\s*\r?\n\s*encoding: 'utf8', shell: true, env: helperEnv\(\),/u);
  assert.match(runner, /env: helperEnv\(\) \}\);/u);
  assert.match(runner,
    /spawnSync\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\],\s*\r?\n\s*\{ stdio: 'ignore', env: helperEnv\(\) \}\);/u);
});

/* ------------------------------------------------------------ --allow-read keys */

test('allow-read: the home root and every credential store path are refused', () => {
  const dir = scratch();
  try {
    const home = join(dir, 'home');
    const sibling = join(home, 'Desktop', 'sibling-template');
    mkdirSync(sibling, { recursive: true });
    for (const name of ['.dsh', '.config', '.credentials']) {
      mkdirSync(join(home, name), { recursive: true });
    }
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    const relocated = join(dir, 'relocated', 'dsh-credentials.yaml');
    mkdirSync(dirname(relocated), { recursive: true });
    const env = { DSH_CREDENTIALS_PATH: relocated };
    const roots = { home, env };
    assert.match(credentialReadRefusal({ root: home, ...roots }),
      /is the home directory or contains it/u);
    assert.match(credentialReadRefusal({ root: dir, ...roots }),
      /is the home directory or contains it/u, 'a root containing home is not narrow');
    for (const name of ['.dsh', '.config', '.credentials',
      join('.local', 'share', 'opencode')]) {
      assert.match(credentialReadRefusal({ root: join(home, name), ...roots }),
        /credential store path/u, name);
      assert.match(allowReadRefusal({ root: join(home, name), ...roots }),
        /credential store path/u, `allowReadRefusal ${name}`);
    }
    assert.match(credentialReadRefusal({ root: join(dir, 'relocated'), ...roots }),
      /credential store path/u, 'the path named by DSH_CREDENTIALS_PATH is refused');
    assert.equal(credentialReadRefusal({ root: sibling, ...roots }), null,
      'the sibling template under home is still a narrow root');
    // The named refusals have named messages, not a generic overlap.
    assert.match(allowReadRefusal({ root: join(home, '.dsh'), ...roots }),
      /credential store path .*\.dsh/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ task and brief key */

test('task/brief: a task text or a brief file carrying the key is refused', () => {
  assert.equal(taskKeyRefusal('Say DONE.', KEY, 'DEEPSEEK_API_KEY'), null);
  const direct = taskKeyRefusal(`Use ${KEY} as the token.`, KEY, 'DEEPSEEK_API_KEY');
  assert.match(direct, /task\/brief carries the DEEPSEEK_API_KEY value/u);
  assert.equal(direct.includes(KEY), false, 'the refusal never echoes the value');
  assert.equal(taskKeyRefusal('anything', undefined, 'DEEPSEEK_API_KEY'), null);

  const dir = scratch();
  try {
    const brief = join(dir, 'brief.md');
    writeFileSync(brief, [
      '# A brief whose prose leaks the key',
      `The operator exported ${KEY} before the run.`,
      '',
      '## Task text',
      '',
      '```text',
      'Write the report.',
      '```',
      '',
    ].join('\n'), 'utf8');
    const read = readTaskFile(brief);
    assert.equal(read.task, 'Write the report.', 'the task block itself is clean');
    assert.match(read.raw, new RegExp(KEY, 'u'), 'the raw brief carries the key');
    assert.match(taskKeyRefusal(read.raw, KEY, 'DEEPSEEK_API_KEY'),
      /task\/brief carries/u, 'the whole brief is checked, not only the task block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ real route composition */

test('real route: the dry run composes a shell-denied, key-free config and never prints the key', () => {
  const { result, output } = dryRun([
    '--arm', 'vanilla', '--provider', 'deepseek-official', '--i-am-the-owner',
    '--kill-ms', '60000', '--dry-run', '--slug', 'live-safety-dry-run',
  ], { DEEPSEEK_API_KEY: KEY });
  assert.equal(output.dryRun, true);
  assert.equal(output.launched, false);
  assert.equal(output.limits.allowDesktopService, false);
  const denied = output.config.permissions
    .filter((rule) => rule.resource === '*' && rule.effect === 'deny')
    .map((rule) => rule.action);
  for (const name of HOST_SHELL_TOOLS) {
    assert.ok(denied.includes(name), `${name} is denied on the real route`);
  }
  assert.equal(output.config.permissions.filter((rule) => rule.action === 'external_directory'
    && rule.resource === '*' && rule.effect === 'deny').length, 1,
  'a real route with no --workspace still carries the path guard');
  assert.equal(JSON.stringify(output).includes(KEY), false, 'the dry-run output has no key');
  assert.equal(result.stdout.includes(KEY), false);
  assert.equal(result.stderr.includes(KEY), false);
});

test('real route: --allow-shell is refused by name, and a key-bearing brief exits 2', () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'alpha\n', 'utf8');
    const args = [
      '--arm', 'vanilla', '--provider', 'deepseek-official', '--i-am-the-owner',
      '--kill-ms', '60000', '--dry-run', '--slug', 'live-safety-dry-run',
      '--workspace', source, '--workspace-digest', workspaceSourceDigest(source).sha256,
    ];
    const shell = spawnSync(process.execPath, [RUNNER, ...args, '--allow-shell'], {
      encoding: 'utf8', timeout: 120_000, env: cleanEnv({ DEEPSEEK_API_KEY: KEY }),
    });
    assert.equal(shell.status, 2, shell.stderr);
    assert.match(shell.stderr, /--allow-shell is refused on a real route/u);
    assert.equal(shell.stderr.includes(KEY), false);

    const brief = join(dir, 'brief.md');
    writeFileSync(brief, [
      `Operator note: ${KEY}`,
      '',
      '## Task text',
      '',
      '```text',
      'Write the report.',
      '```',
      '',
    ].join('\n'), 'utf8');
    const briefRun = spawnSync(process.execPath, [RUNNER, ...args, '--task-file', brief], {
      encoding: 'utf8', timeout: 120_000, env: cleanEnv({ DEEPSEEK_API_KEY: KEY }),
    });
    assert.equal(briefRun.status, 2, briefRun.stderr);
    assert.match(briefRun.stderr, /task\/brief carries the DEEPSEEK_API_KEY value/u);
    assert.equal(briefRun.stderr.includes(KEY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ capture loader */

test('capture loader: the source carries the redaction variable name, never its value', () => {
  const dir = scratch();
  const previous = process.env[DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv];
  process.env[DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv] = KEY;
  try {
    const logPath = join(dir, 'capture.jsonl');
    const loader = writeCaptureLoader(dir, logPath, {
      redactEnvNames: [DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv],
    });
    assert.deepEqual(loader.redactEnvNames, ['DEEPSEEK_API_KEY']);
    const source = readFileSync(loader.modulePath, 'utf8');
    assert.match(source, /redactEnvNames/u);
    assert.match(source, /process\.env\[name\]/u);
    assert.equal(source.includes(KEY), false, 'the loader never embeds the key value');
    const inline = captureLoaderSource({
      pluginUrl: 'file:///observer.mjs', logPath: 'capture.jsonl', summaryPath: 's.json',
      redactEnvNames: ['DEEPSEEK_API_KEY'],
    });
    assert.equal(inline.includes(KEY), false);
    assert.equal(inline.includes('DEEPSEEK_API_KEY'), true);
  } finally {
    if (previous === undefined) delete process.env[DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv];
    else process.env[DEEPSEEK_OFFICIAL_ROUTE.apiKeyEnv] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
