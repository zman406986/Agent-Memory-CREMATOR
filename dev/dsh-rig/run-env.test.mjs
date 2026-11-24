// ISSUE-260: the dsh rig's child environment is an allow-list, not a denylist.
// Focused set: `node --test dev/dsh-rig/run-env.test.mjs`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoProviderKeys, buildChildEnv, findSessionFiles, probeDshVersion,
  sessionIdForLog } from './run.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./run.mjs', import.meta.url)), 'utf8');

/** A parent env carrying every allow-listed name plus a field of sentinels. */
function parentEnv() {
  return {
    PATH: 'C:\\Windows\\System32',
    HOME: 'C:\\rig\\owner',
    USERPROFILE: 'C:\\rig\\owner',
    TEMP: 'C:\\rig\\owner\\AppData\\Local\\Temp',
    TMP: 'C:\\rig\\owner\\AppData\\Local\\Temp',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    WINDIR: 'C:\\Windows',
    OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    NUMBER_OF_PROCESSORS: '16',
    LANG: 'en_US.UTF-8',
    DSH_TELEMETRY_MODE: 'ENABLED',
    DSH_TELEMETRY_EXTRA: 'kept',
    HTTPS_PROXY: 'http://proxy.corp.example:8443',
    HTTP_PROXY: 'http://proxy.corp.example:8443',
    NO_PROXY: '.corp.example,127.0.0.1',
    ALL_PROXY: 'socks5://proxy.corp.example:1080',
    NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp-root.pem',
    SSL_CERT_FILE: 'C:\\certs\\corp-root.pem',
    // None of these may reach a dsh child.
    NODE_OPTIONS: '--require C:\\sentinel\\preload.cjs',
    OTHER_KEY: 'sentinel-other-key',
    OPENAI_API_KEY: 'sk-sentinel-openai',
    ANTHROPIC_API_KEY: 'sk-ant-sentinel',
    A6_API_KEY: 'sk-sentinel-a6',
    DEEPSEEK_API_KEY: 'sk-sentinel-deepseek',
    AWS_SECRET_ACCESS_KEY: 'sentinel-aws',
    GITHUB_TOKEN: 'sentinel-github',
    RIG_REAL_API: '1',
    RIG_KILL_TIMER_MS: '60000',
    RIG_CREDENTIALS_PATH: 'C:\\rig\\owner\\.dsh\\.credentials.yaml',
    RIG_SESSIONS_DIR: 'C:\\rig\\owner\\.dsh\\sessions',
    RIG_STORAGES_DIR: 'C:\\rig\\owner\\.dsh\\storages',
    DSH_HOME: 'C:\\rig\\owner\\.dsh',
  };
}

test('the child env inherits only allow-listed names; OTHER_KEY never reaches it', () => {
  const source = parentEnv();
  const env = buildChildEnv(source, { DSH_HOME: 'C:\\rig\\home' });
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive',
    'ComSpec', 'PATHEXT', 'WINDIR', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'LANG', 'DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_EXTRA',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    assert.ok(Object.hasOwn(env, key), `${key} must be inherited`);
    assert.equal(env[key], source[key], `${key} must keep its parent value`);
  }
  for (const key of ['NODE_OPTIONS', 'OTHER_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'A6_API_KEY',
    'DEEPSEEK_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'RIG_REAL_API',
    'RIG_KILL_TIMER_MS', 'RIG_CREDENTIALS_PATH', 'RIG_SESSIONS_DIR', 'RIG_STORAGES_DIR']) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not inherit from the parent`);
  }
  assert.equal(env.DSH_HOME, 'C:\\rig\\home', 'DSH_HOME is the rig value, never the parent one');
});

const PROXY_TLS_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

test('proxy and TLS variables inherit only when present, preserving spelling', () => {
  const absent = buildChildEnv({ PATH: 'C:\\Windows' }, {});
  for (const key of PROXY_TLS_NAMES) {
    assert.equal(Object.hasOwn(absent, key), false, `${key} must stay absent when the parent has none`);
  }
  const lower = buildChildEnv({ PATH: 'C:\\Windows', https_proxy: 'http://lower.example:8080' }, {});
  assert.equal(lower.https_proxy, 'http://lower.example:8080',
    'lowercase proxy names are inherited too; on Windows env names are case-insensitive');
});

test('NODE_OPTIONS is neither inherited nor writable: it can inject code into a child', () => {
  const env = buildChildEnv(parentEnv(), {});
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false,
    'NODE_OPTIONS can run --require/--import inside every child, so it is not allow-listed');
  for (const value of ['--require C:\\sentinel\\preload.cjs', '--import data:text/javascript,0']) {
    assert.throws(() => buildChildEnv({}, { NODE_OPTIONS: value }),
      /not an allow-listed child env key/u, 'the override map must not open a code-execution channel');
  }
});

test('the tier-3 guard fails closed on every provider-key family sentinel', () => {
  const sentinels = {
    A6_API_KEY: 'sentinel-a6',
    DEEPSEEK_API_KEY: 'sentinel-deepseek',
    OPENAI_API_KEY: 'sentinel-openai',
    ANTHROPIC_API_KEY: 'sentinel-anthropic',
    GITHUB_TOKEN: 'sentinel-github',
    AWS_ACCESS_KEY_ID: 'sentinel-aws-id',
    AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret',
    AWS_SESSION_TOKEN: 'sentinel-aws-session',
    deepseek_api_key: 'sentinel-lowercase',
  };
  for (const [key, value] of Object.entries(sentinels)) {
    assert.throws(() => assertNoProviderKeys({ PATH: 'C:\\Windows', [key]: value }),
      /provider credential/u, `${key} must fail the tier-3 guard`);
  }
});

test('the tier-3 guard accepts the built env and still catches key-shaped values', () => {
  const env = buildChildEnv(parentEnv(), {
    DSH_HOME: 'C:\\rig\\owner\\.dsh',
    RIG_CREDENTIALS_PATH: 'C:\\rig\\owner\\.dsh\\.credentials.yaml',
    RIG_SESSIONS_DIR: 'C:\\evidence\\sessions',
    RIG_STORAGES_DIR: 'C:\\evidence\\storages',
  });
  assert.equal(Object.hasOwn(env, 'DEEPSEEK_API_KEY'), false, 'tier 3 must not carry the route key');
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
  assert.doesNotThrow(() => assertNoProviderKeys(env), 'the scrubbed tier-3 env carries no key');
  assert.doesNotThrow(() => assertNoProviderKeys({ DEEPSEEK_BASE_URL: 'https://example.invalid' }),
    'a provider route name is not a provider key');
  for (const value of ['sk-sentinel-openai-0123456789', 'ghp_0123456789abcdefghij0123456789abcdef',
    'AKIAIOSFODNN7EXAMPLE', '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.throws(() => assertNoProviderKeys({ LANG: value }),
      /provider credential/u, `key-shaped value must be refused: ${value}`);
  }
});

test('the rig knobs are explicit; RIG_CREDENTIALS_PATH stays a store path', () => {
  const env = buildChildEnv(parentEnv(), {
    DSH_HOME: 'C:\\evidence\\home',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'danger-full-access',
    RIG_CREDENTIALS_PATH: 'C:\\rig\\owner\\.dsh\\.credentials.yaml',
    RIG_SESSIONS_DIR: 'C:\\evidence\\sessions',
    RIG_STORAGES_DIR: 'C:\\evidence\\storages',
    DEEPSEEK_API_KEY: 'mock-key-not-real',
  });
  assert.equal(env.DSH_HOME, 'C:\\evidence\\home');
  assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED');
  assert.equal(env.RIG_CREDENTIALS_PATH, 'C:\\rig\\owner\\.dsh\\.credentials.yaml');
  assert.match(env.RIG_CREDENTIALS_PATH, /\.credentials\.yaml$/u);
  assert.ok(!Object.values(env).includes('sk-sentinel-a6'),
    'no provider key sentinel appears in the child env values');
  assert.equal(env.DEEPSEEK_API_KEY, 'mock-key-not-real', 'tier 1/2 carries the dummy, never a real key');
});

test('an override that names a provider key is refused', () => {
  for (const key of ['A6_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OTHER_KEY']) {
    assert.throws(() => buildChildEnv({}, { [key]: 'sentinel-literal' }),
      /not an allow-listed child env key/u, `${key} must not be assignable`);
  }
});

test('dsh --version runs with the scrubbed env: no OTHER_KEY, no provider key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-rig-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-dsh-bin.mjs');
  writeFileSync(bin, [
    "const names = ['OTHER_KEY', 'OPENAI_API_KEY', 'A6_API_KEY', 'DEEPSEEK_API_KEY', 'PATH', 'DSH_HOME'];",
    "const present = Object.fromEntries(names.map((name) => [name, typeof process.env[name] === 'string' ? process.env[name] : null]));",
    'process.stdout.write(`${JSON.stringify(present)}\\n`);',
  ].join('\n'));
  const env = buildChildEnv(parentEnv(), { DSH_HOME: 'C:\\evidence\\home' });
  const report = JSON.parse(probeDshVersion(bin, env));
  assert.equal(report.OTHER_KEY, null, 'OTHER_KEY reached dsh --version');
  assert.equal(report.OPENAI_API_KEY, null, 'OPENAI_API_KEY reached dsh --version');
  assert.equal(report.A6_API_KEY, null, 'A6_API_KEY reached dsh --version');
  assert.equal(report.DEEPSEEK_API_KEY, null, 'DEEPSEEK_API_KEY reached dsh --version');
  assert.equal(report.PATH, parentEnv().PATH, 'the version probe still needs PATH');
  assert.equal(report.DSH_HOME, 'C:\\evidence\\home', 'the version probe gets the rig home');
});

test('dsh --version is bounded and fails closed on timeout or non-zero exit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-rig-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slow = join(dir, 'slow-dsh-bin.mjs');
  writeFileSync(slow, 'setTimeout(() => {}, 60_000);\n');
  const started = Date.now();
  assert.throws(() => probeDshVersion(slow, buildChildEnv(parentEnv()), 250),
    /dsh --version timed out after 250 ms/u);
  assert.ok(Date.now() - started < 15_000, 'the probe returns after its timeout instead of hanging');
  const failing = join(dir, 'failing-dsh-bin.mjs');
  writeFileSync(failing, [
    "process.stderr.write('boom\\n');",
    'process.exit(3);',
  ].join('\n'));
  assert.throws(() => probeDshVersion(failing, buildChildEnv(parentEnv())),
    /dsh --version exited 3: boom/u);
  assert.match(SOURCE, /timeout: timeoutMs/u, 'the probe passes a timeout to spawnSync');
  assert.match(SOURCE, /VERSION_PROBE_TIMEOUT_MS = 30_000/u, 'the default probe timeout is explicit');
});

test('both persisted session-log names are found; a renamed log is ignored', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-rig-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The canonical name, a host-named log in a directory that does not repeat
  // the id, and three decoys the reader must not adopt.
  mkdirSync(join(dir, 'session-aaaa'), { recursive: true });
  writeFileSync(join(dir, 'session-aaaa', 'session.v4.jsonl'), '{}\n');
  mkdirSync(join(dir, 'host-dir'), { recursive: true });
  writeFileSync(join(dir, 'host-dir', 'session-bbbb.v4.jsonl'), '{}\n');
  writeFileSync(join(dir, 'host-dir', 'session-c.v3.jsonl'), '{}\n');
  writeFileSync(join(dir, 'host-dir', 'not-a-session.v4.jsonl'), '{}\n');
  writeFileSync(join(dir, 'host-dir', 'notes.jsonl'), '{}\n');

  const found = findSessionFiles(dir);
  assert.equal(found.length, 2, `saw ${found.join(', ')}`);
  assert.deepEqual(found.map((file) => basename(file)).sort(),
    ['session-bbbb.v4.jsonl', 'session.v4.jsonl']);
  // The canonical log takes its directory; the host-named log takes its stem,
  // even when the directory says something else. This is the id `--session-id`
  // adopts on a resume launch.
  assert.equal(sessionIdForLog(join(dir, 'session-aaaa', 'session.v4.jsonl')), 'session-aaaa');
  assert.equal(sessionIdForLog(join(dir, 'host-dir', 'session-bbbb.v4.jsonl')), 'session-bbbb');
  // Both readers use the two-name discovery; the old single-name suffix scan
  // is gone from the resume adoption and the post-run read.
  assert.match(SOURCE, /const persisted = findSessionFiles\(sessionsDir\);/u);
  assert.match(SOURCE, /const sessionFiles = findSessionFiles\(sessionsDir\);/u);
  assert.doesNotMatch(SOURCE, /findFiles\(sessionsDir, 'session\.v4\.jsonl'\)/u);
});

