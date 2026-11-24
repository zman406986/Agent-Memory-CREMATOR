/**
 * The host write/read boundary a `--workspace` run composes.
 *
 * 2.4.0's `Permission.Rule` is `{ action, resource, effect }`; a ruleset is
 * evaluated last-match-wins and no match is `ask`, which `--auto` approves, so
 * only a `deny` enforces. `write`/`patch` are the `edit` action, the `read`
 * check sees the work copy's relative path, and a path outside the copy adds an
 * `external_directory` check on its parent directory. The floor evaluator below
 * ports that evaluation from the installed host, so a rule block that reads
 * right is also shown to decide right:
 *
 *   - `FC(value, pattern)`: backslashes to `/`, escape `.+^${}()|[]\`, then
 *     `*` -> `.*` and `?` -> `.`, anchored, case-insensitive, dot-all. `*`
 *     crosses `/`, which is why `?:*` catches `C:/...` and `*..*` catches a
 *     relative resource that carries a traversal.
 *   - `DP(action, resource, rules)`: the last rule whose action and resource both
 *     match, else `{effect: "ask"}`.
 *   - `FileAccess.resolve`: a path inside the session directory becomes
 *     `path.relative(dir, absolute)`; a path outside keeps its absolute spelling
 *     and carries an `external_directory` rule on `path.join(dirname, "*")`.
 *
 * The evidence that the host behaves this way is the direct probe under
 * `scratchpad/perm-probe/direct/` and the `perm-guard` mock run; these tests pin
 * the composed bytes, not the host.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  HOST_WORLD_DIRS, composeConfig, hostToolPermissions, redirectEnv, workspacePathGuard,
  workspaceReadPolicy,
} from './opencode-run.mjs';

const WIN_WORLD = 'C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\launch\\guardK-vanilla\\vanilla\\world';
const WIN_WORLD_SLASHES = 'C:/Users/TZhen/Desktop/racoons/scratchpad/launch/guardK-vanilla/vanilla/world';

/** `composeConfig` input with nothing a fixture run would not carry. */
const baseInput = (extra = {}) => ({
  arm: 'vanilla',
  pluginDir: join('unused-product'),
  storageRoot: join('unused-storage'),
  excludeTools: [],
  subagentTool: 'subagent',
  ...extra,
});

/** A workspace run's input: the shell and boundary denies a copy-bound run adds. */
const workspaceInput = (extra = {}) => baseInput({
  shellTools: ['bash', 'execute', 'shell'],
  boundaryTools: ['webfetch'],
  worldDir: WIN_WORLD,
  ...extra,
});

test('a workspace run composes the guard after the tool denies, in the verified order', () => {
  const config = composeConfig(workspaceInput({ allowReadRoots: ['D:\\template'] }));
  const rules = config.permissions;
  const guard = workspacePathGuard(WIN_WORLD, ['D:\\template']);
  assert.deepEqual(rules.slice(-guard.length), guard,
    'the guard is the tail of the list, so no later rule can override its denies');
  const firstGuard = rules.findIndex((rule) => rule.action === 'external_directory');
  assert.equal(firstGuard, rules.length - guard.length,
    'the guard starts where the tool denies stop');
  assert.deepEqual(guard.slice(0, 1), [{ action: 'external_directory', resource: '*', effect: 'deny' }]);
  assert.deepEqual(guard.slice(-9), [
    ...['?:*', '/*', '*..*'].map((resource) => ({ action: 'edit', resource, effect: 'deny' })),
    ...['?:*', '/*', '*..*'].map((resource) => ({ action: 'glob', resource, effect: 'deny' })),
    ...['?:*', '/*', '*..*'].map((resource) => ({ action: 'grep', resource, effect: 'deny' })),
  ], 'the edit, glob and grep denies are the grouped tail');
  const lastExternal = guard.findLastIndex((rule) => rule.action === 'external_directory');
  assert.ok(guard.findIndex((rule) => rule.action === 'glob' || rule.action === 'grep') > lastExternal,
    'the pattern denies follow every external_directory rule, so they are the last match');
  assert.deepEqual(guard.slice(1, 7).map((rule) => rule.resource),
    HOST_WORLD_DIRS.map((dir) => `${WIN_WORLD_SLASHES}/${dir}/**`));
  assert.deepEqual(guard.slice(1, 7).every((rule) => rule.effect === 'allow'), true,
    'each host dir is re-opened after the strict outside deny');
  for (const rule of rules) {
    assert.equal(rule.resource.includes('\\'), false,
      `${rule.action} ${rule.resource} is written in the host's forward-slash spelling`);
  }
  assert.equal(rules.some((rule) => rule.action === 'read'), false,
    'no read rule: external_directory is the read guard, and a read deny would remove the tool');
});

test('the guard is absent without --workspace', () => {
  const fixture = composeConfig(baseInput());
  const workspace = composeConfig(workspaceInput());
  assert.equal(fixture.permissions.some((rule) => rule.action === 'external_directory'), false);
  assert.equal(fixture.permissions.some((rule) => rule.action === 'edit'), false);
  assert.equal(workspace.permissions.some((rule) => rule.action === 'external_directory'), true);
  assert.deepEqual(fixture.permissions, hostToolPermissions('subagent').map((rule) => ({ ...rule })),
    'a fixture run keeps the tool-deny list it had');
  assert.equal(workspaceReadPolicy(fixture).permissions, 1);
});

test('each --allow-read root gets an allow after the deny; none means no rule', () => {
  const roots = ['C:\\racoons-bench\\2026-10-23-aetherium\\template', 'D:/docs/'];
  const rules = workspacePathGuard(WIN_WORLD, roots);
  const deny = rules.findIndex((rule) => rule.action === 'external_directory'
    && rule.resource === '*' && rule.effect === 'deny');
  const allows = rules.filter((rule) => rule.action === 'external_directory'
    && rule.effect === 'allow').map((rule) => rule.resource);
  for (const root of ['C:/racoons-bench/2026-10-23-aetherium/template/**', 'D:/docs/**']) {
    const index = allows.indexOf(root);
    assert.notEqual(index, -1, `${root} is allowed`);
    assert.ok(rules.findIndex((rule) => rule.resource === root) > deny,
      `${root} is allowed after the external_directory deny`);
  }
  assert.equal(allows.filter((resource) => resource.startsWith('D:/docs')).length, 1,
    'a trailing separator is trimmed, so the rule is one `/**` and not `//**`');
  const none = workspacePathGuard(WIN_WORLD, []);
  assert.deepEqual(none.filter((rule) => rule.action === 'external_directory' && rule.effect === 'allow')
    .map((rule) => rule.resource), HOST_WORLD_DIRS.map((dir) => `${WIN_WORLD_SLASHES}/${dir}/**`),
  'with no --allow-read root the only allows are the host dirs');
  // The launcher reads --allow-read into composeConfig the same way it reads it
  // into the read boundary: the rendered rule set carries it.
  const config = composeConfig(workspaceInput({ allowReadRoots: roots }));
  assert.equal(config.permissions.some((rule) => rule.resource === 'D:/docs/**'), true);
});

test('the guard covers every directory the arm\'s host environment points into', () => {
  const bases = workspacePathGuard(WIN_WORLD, [])
    .filter((rule) => rule.action === 'external_directory' && rule.effect === 'allow')
    .map((rule) => rule.resource.slice(0, -'/**'.length)
      .slice(WIN_WORLD_SLASHES.length + 1));
  for (const value of Object.values(redirectEnv(WIN_WORLD))) {
    const relative = value.slice(WIN_WORLD.length + 1).replaceAll('\\', '/');
    const covered = bases.some((base) => relative === base || relative.startsWith(`${base}/`));
    assert.equal(covered, true, `redirectEnv's ${relative} is not re-opened by the guard`);
  }
});

test('a workspace run keeps the read tool available (the launch gate)', () => {
  const policy = workspaceReadPolicy(composeConfig(workspaceInput()));
  assert.equal(policy.readable, true);
  assert.deepEqual(policy.denyRules, []);
  assert.equal(policy.permissions > 0, true);
});

/** 2.4.0 `FC`: the host's glob-to-regex rule match, ported verbatim. */
function hostMatches(value, pattern) {
  const v = String(value).replaceAll('\\', '/');
  let p = String(pattern).replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.');
  if (p.endsWith(' .*')) p = `${p.slice(0, -3)}( .*)?`;
  return new RegExp(`^${p}$`, 'siu').test(v);
}

/** 2.4.0 `DP`: the last rule whose action and resource match; no match is `ask`. */
function hostEffect(rules, action, resource) {
  const hit = rules.findLast((rule) => hostMatches(action, rule.action)
    && hostMatches(resource, rule.resource));
  return hit?.effect ?? 'ask';
}

/** Lexical posix `path.resolve`, enough for the controlled inputs below. */
function resolveLexical(base, value) {
  const parts = (value.startsWith('/') ? value : `${base}/${value}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * The checks 2.4.0 runs for one path tool call, in order:
 * `FileAccess.resolve` relativises an inside path, an outside path keeps its
 * absolute spelling and adds the external gate on its parent directory, and the
 * tool's own action is asserted last.
 */
function hostChecks(rules, { cwd, tool, path, pattern = null }) {
  const action = tool === 'write' || tool === 'patch' ? 'edit' : tool;
  const absolute = resolveLexical(cwd, path);
  const inside = absolute === cwd || absolute.startsWith(`${cwd}/`);
  const resource = inside ? absolute.slice(cwd.length + 1) || '.' : absolute;
  const checks = [];
  if (!inside) {
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    checks.push({ action: 'external_directory', resource: `${parent}/*` });
  }
  checks.push({ action, resource: action === 'glob' || action === 'grep' ? pattern : resource });
  return checks.map((check) => ({ ...check, effect: hostEffect(rules, check.action, check.resource) }));
}

/** The guarded workspace config's rules, and the world they were written for. */
const guarded = () => {
  const world = '/scratch/launch/guardK-vanilla/vanilla/world';
  const rules = composeConfig(workspaceInput({ worldDir: world,
    allowReadRoots: ['/sibling/template'] })).permissions;
  return { world, cwd: `${world}/work`, rules };
};

const verdict = (checks) => (checks.some((check) => check.effect === 'deny') ? 'deny'
  : checks.some((check) => check.effect === 'ask') ? 'ask' : 'allow');

test('the evaluator denies an outside read, write, edit and glob', () => {
  const { world, cwd, rules } = guarded();
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: '/scratch/racoons/AGENTS.md' })),
    'deny', 'an absolute read outside the world is refused by external_directory');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: '../outside.txt' })), 'deny');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'write', path: '../evil.txt' })), 'deny');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'edit', path: '../outside.txt' })), 'deny');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'glob', path: '..', pattern: '**/*.txt' })),
    'deny', 'a glob whose path leaves the copy is refused by external_directory');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'grep', path: world, pattern: 'x' })), 'deny');
});

test('the evaluator allows an inside write and a host-temp read, and reports the auto-approved ask', () => {
  const { world, cwd, rules } = guarded();
  const write = hostChecks(rules, { cwd, tool: 'write', path: 'written.txt' });
  assert.equal(verdict(write), 'ask',
    'inside the copy no rule matches, so the host asks and --auto approves');
  assert.deepEqual(write.at(-1), { action: 'edit', resource: 'written.txt', effect: 'ask' });
  const absoluteInside = hostChecks(rules, { cwd, tool: 'write', path: `${cwd}/nested/x.txt` });
  assert.equal(verdict(absoluteInside), 'ask',
    'the host relativises an absolute inside path before matching, so `?:*` cannot catch it');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: `${world}/tmp/host-note.txt` })),
    'ask', 'the arm world\'s own temp dir is re-opened');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: `${world}/.local/share/opencode/opencode.db` })),
    'ask', 'the host\'s own data dir is re-opened');
});

test('the evaluator allows a --allow-read root but not a traversal out of it', () => {
  const { cwd, rules } = guarded();
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: '/sibling/template/docs/a.md' })),
    'ask', 'a declared read-only root stays readable');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: '/sibling/template/../secret.txt' })),
    'deny', 'the allow is the root and its children, not its parent');
});

test('a relative edit resource carrying .. is denied by *..*, and an absolute one by ?:*', () => {
  const { cwd, rules } = guarded();
  // The edit action's own check, before the host resolves the input.
  assert.equal(hostEffect(rules, 'edit', '../outside.txt'), 'deny', '*..* covers a traversal');
  assert.equal(hostEffect(rules, 'edit', 'C:/racoons/AGENTS.md'), 'deny',
    '?:* covers a drive-absolute path');
  assert.equal(hostEffect(rules, 'edit', '/scratch/racoons/AGENTS.md'), 'deny',
    '/* covers a root-absolute path');
  // The resolved shapes the host actually matches, with the external gate as
  // the first net and the edit pattern as the second.
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'edit', path: '../outside.txt' })), 'deny');
  assert.equal(hostEffect(rules, 'edit', '/scratch/launch/guardK-vanilla/vanilla/world/evil.txt'),
    'deny', 'a resolved outside path is drive/root absolute, which the patterns also deny');
});

test('a glob and grep pattern carrying .. or an absolute prefix is denied', () => {
  const { cwd, rules } = guarded();
  const glob = (pattern) => verdict(hostChecks(rules, { cwd, tool: 'glob', path: '.', pattern }));
  const grep = (pattern) => verdict(hostChecks(rules, { cwd, tool: 'grep', path: '.', pattern }));
  // 2.4.0 matches glob/grep on the pattern, and the path '.' stays inside the
  // copy, so external_directory has no check to make: these denies are the net.
  for (const pattern of ['../**/*.txt', '../../**', '..']) {
    assert.equal(glob(pattern), 'deny', `glob ${pattern} carries .., which *..* denies`);
    assert.equal(grep(pattern), 'deny', `grep ${pattern} carries .., which *..* denies`);
  }
  for (const pattern of ['/scratch/racoons/**', '/etc/passwd']) {
    assert.equal(glob(pattern), 'deny', `glob ${pattern} is root-absolute, which /* denies`);
    assert.equal(grep(pattern), 'deny', `grep ${pattern} is root-absolute, which /* denies`);
  }
  for (const pattern of ['C:/Users/TZhen/Desktop/racoons/**', 'D:/notes/*.md']) {
    assert.equal(glob(pattern), 'deny', `glob ${pattern} is drive-absolute, which ?:* denies`);
    assert.equal(grep(pattern), 'deny', `grep ${pattern} is drive-absolute, which ?:* denies`);
  }
});

test('ordinary glob and grep patterns are left to the auto-approved ask', () => {
  const { cwd, rules } = guarded();
  const glob = (pattern) => verdict(hostChecks(rules, { cwd, tool: 'glob', path: '.', pattern }));
  const grep = (pattern) => verdict(hostChecks(rules, { cwd, tool: 'grep', path: '.', pattern }));
  for (const pattern of ['**/*.md', 'docs/**', '*.ts', 'src/**/test?.ts', 'a/b/c.txt']) {
    assert.equal(glob(pattern), 'ask', `glob ${pattern} matches no deny, so --auto approves it`);
  }
  for (const pattern of ['TODO', 'foo|bar', 'console\\.log', 'a|b:c']) {
    assert.equal(grep(pattern), 'ask', `grep ${pattern} matches no deny, so --auto approves it`);
  }
});

test('the pattern denies leave the read and edit decisions unchanged', () => {
  const { cwd, rules } = guarded();
  assert.deepEqual(rules.filter((rule) => rule.action === 'read'), [],
    'no read rule: external_directory is the only read guard');
  assert.equal(hostEffect(rules, 'read', '/scratch/racoons/AGENTS.md'), 'ask');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: '/scratch/racoons/AGENTS.md' })),
    'deny', 'an outside read is still refused by external_directory');
  assert.equal(verdict(hostChecks(rules, { cwd, tool: 'read', path: 'inside.txt' })), 'ask');
  assert.equal(hostEffect(rules, 'edit', '../outside.txt'), 'deny');
  assert.equal(hostEffect(rules, 'edit', 'C:/racoons/AGENTS.md'), 'deny');
  assert.equal(hostEffect(rules, 'edit', '/scratch/racoons/AGENTS.md'), 'deny');
  assert.equal(hostEffect(rules, 'edit', 'written.txt'), 'ask');
});
