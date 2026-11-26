// Publish-metadata gate for the three shipped packages (ISSUE-271).
//
// The manifests carry repository/homepage/bugs/author and a Node range that
// excludes 23.0-23.3; before this file nothing read either claim. The range
// check parses the two comparator sets the manifest uses, so a hand edit that
// re-admits 23.1 fails here rather than in a user install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  // The repo root is the published dsh package; `directory: '.'` says so to npm and
  // to the plugin market, which reads the root manifest.
  { dir: '.', name: 'cremator-dsh' },
  { dir: 'packages/core', name: '@cremator/core' },
  { dir: 'packages/adapters/opencode', name: 'cremator-opencode' },
];
const REPO = 'https://github.com/zman406986/Agent-Memory-CREMATOR';
// ISSUE-621: the floor contains `DatabaseSync.prototype.isTransaction` (Node 22.16.0,
// and v24.0.0 — never any 23.x), which the ledger's ROLLBACK retry reads.
const NODE_RANGE = '>=22.16.0 <23.0.0 || >=24.0.0';
// ISSUE-626: the host SDK the root manifest declares as an optional peer.
const DSH_PACKAGE = '@deepseek-ai/dsh';
// The two adapters: each declares its dependency on core in `dependencies`.
const ADAPTERS = PACKAGES.filter(({ dir }) => dir === '.' || dir.startsWith('packages/adapters/'));

function manifest(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
}

// ISSUE-626: the manifests are not the whole release. package-lock.json is the dependency
// graph an install and a publish read, and nothing compared the two: the lock carried 0.1.2
// and ^0.1.2 after the manifests moved to 0.1.3. Read as JSON and compared as strings; no
// network, no npm command. npm keys the repo root workspace under "" and the rest under their
// repo path.
function lockPackages() {
  return JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages;
}

function lockKey(dir) {
  return dir === '.' ? '' : dir;
}

// ISSUE-626: `@deepseek-ai/dsh` is only an optional peer dependency of the root manifest, so a
// runtime import of it would ship a package that cannot load where the peer was never provided.
// The scanner is the shape of the OpenCode adapter's guard
// (packages/adapters/opencode/test/package.test.ts:24-87): collect the sources, report every hit
// as `file: line`, and pass only on an empty list.
function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Comment spans, so a comment that names the package (a pin note) is not read as an import.
function commentSpans(source) {
  const spans = [];
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

// One line per import specifier that names the package: static, export-from, bare and dynamic.
// Type-only is NOT skipped — a type import is still a shipped dependency edge for a package
// that is only an optional peer, and the assertion says so.
function hostImports(source) {
  const comments = commentSpans(source);
  const found = [];
  for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
    const specifier = match[1];
    if (specifier !== DSH_PACKAGE && !specifier.startsWith(`${DSH_PACKAGE}/`)) continue;
    const at = match.index;
    if (comments.some(([start, end]) => at >= start && at < end)) continue;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    found.push(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim());
  }
  return found;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  assert.ok(match, `unparseable version ${value}`);
  return match.slice(1).map(Number);
}

function compareTriples(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

// Parse the exact comparator set shape used in `engines.node`: whitespace-separated
// `>=x.y.z` and `<x.y.z`, alternatives split on `||`. Anything else fails closed.
function satisfies(version, range) {
  const target = parseVersion(version);
  return range.split('||').some((alternative) => alternative.trim().split(/\s+/u).every((token) => {
    const match = /^(>=|<)(.+)$/u.exec(token);
    assert.ok(match, `unparseable comparator ${token}`);
    const bound = parseVersion(match[2]);
    return match[1] === '>=' ? compareTriples(target, bound) >= 0 : compareTriples(target, bound) < 0;
  }));
}

test('every publishable manifest names the repository, homepage, bugs and author', () => {
  const locked = lockPackages();
  for (const { dir, name } of PACKAGES) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name);
    assert.equal(pkg.private, false, `${name} is not publishable`);
    assert.deepEqual(pkg.repository, {
      type: 'git',
      url: `git+${REPO}.git`,
      directory: dir,
    }, `${name} repository metadata drifted`);
    assert.equal(pkg.homepage, `${REPO}#readme`, `${name} homepage drifted`);
    assert.equal(pkg.bugs?.url, `${REPO}/issues`, `${name} bugs URL drifted`);
    assert.equal(pkg.author?.url, 'https://github.com/zman406986', `${name} author drifted`);
    // ISSUE-626: the lock's version is the one an install resolves; a manifest that moves
    // without the lock leaves the old version in the published dependency graph, and until
    // this assertion nothing went red for it.
    const lockedEntry = locked[lockKey(dir)];
    assert.ok(lockedEntry, `package-lock.json has no workspace entry for ${name} (${dir})`);
    assert.equal(lockedEntry.version, pkg.version,
      `package-lock.json records ${name} version ${lockedEntry.version}, but ${dir}/package.json declares ${pkg.version}`);
  }
});

test('the Node range excludes every 23.x and is the one sentence the README states', () => {
  for (const { dir, name } of PACKAGES) {
    assert.equal(manifest(dir).engines?.node, NODE_RANGE, `${name} engines.node drifted`);
  }
  // Pinned by literal as well: moving the floor below 22.16.0 admits a runtime whose
  // `node:sqlite` has no `isTransaction`, which the ledger reads after a failed
  // ROLLBACK (ISSUE-621).
  assert.equal(NODE_RANGE, '>=22.16.0 <23.0.0 || >=24.0.0',
    'the declared floor must contain DatabaseSync.prototype.isTransaction');
  assert.ok(satisfies('22.16.0', NODE_RANGE));
  assert.ok(satisfies('22.15.9', NODE_RANGE) === false);
  assert.ok(satisfies('22.12.9', NODE_RANGE) === false);
  assert.ok(satisfies('23.0.0', NODE_RANGE) === false);
  assert.ok(satisfies('23.1.0', NODE_RANGE) === false);
  assert.ok(satisfies('23.3.9', NODE_RANGE) === false);
  assert.ok(satisfies('23.4.0', NODE_RANGE) === false);
  assert.ok(satisfies('24.0.0', NODE_RANGE));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`Node \`${NODE_RANGE}\``),
    'README Requirements does not state the manifest range');
  assert.ok(readme.includes('every 23 release is excluded'),
    'README support sentence does not name the excluded range');
});

test('source maps are off in every build config, and src is not in files', () => {
  for (const { dir, name } of PACKAGES) {
    const config = JSON.parse(readFileSync(join(ROOT, dir, 'tsconfig.build.json'), 'utf8'));
    assert.equal(config.compilerOptions.sourceMap, false, `${name} emits source maps`);
    assert.equal(config.compilerOptions.declarationMap, false, `${name} emits declaration maps`);
    const files = manifest(dir).files;
    assert.ok(!files.includes('src'), `${name} ships src without a reader for it`);
  }
  // ISSUE-626: src is not shipped (asserted just above), but it is what dist/ is built from, so
  // an import of the host SDK there is an import in the published package. `@deepseek-ai/dsh` is
  // only an optional peer of the root manifest, so such an import ships a package that cannot
  // load where the peer was never provided. Fail closed on an empty scan.
  const sources = collectSources(join(ROOT, 'src'));
  assert.ok(sources.length > 0, 'scan found no source files; a scan over nothing proves nothing');
  const offenders = [];
  for (const file of sources) {
    for (const line of hostImports(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file)}: ${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    'no source file may import @deepseek-ai/dsh, `import type` included: the host SDK is only an '
    + 'optional peer of the root manifest, so a type-only import is still a shipped dependency edge');
});

// The version and the range come from the package files, never from a typed-in
// copy here: a release moves the manifests and the README together, and this
// case does not change. It still fails when the README and a manifest disagree.
test('the publishing section names core first and the adapter dependency range', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const { version } = manifest('packages/core');
  assert.match(readme, /publish in\s+dependency order/iu);
  // The lookahead ends the version: without it 0.1.1 also matches 0.1.10 and 0.1.1-rc.1.
  const coreFirst = new RegExp(`@cremator/core@${escapeRegExp(version)}(?![\\w.+-]).*first`, 'isu');
  assert.match(readme, coreFirst, `README Publishing does not name @cremator/core@${version} first`);
  const locked = lockPackages();
  for (const { dir, name } of ADAPTERS) {
    const range = manifest(dir).dependencies['@cremator/core'];
    assert.ok(readme.includes(`"@cremator/core": "${range}"`),
      `README Publishing does not state the core range ${dir} declares: ${range}`);
    // ISSUE-614: the adapters import core statically, so ESM instantiation throws before
    // any entry code runs. A range whose floor predates an export the adapter imports
    // resolves a core that cannot even load. The floor must not be below the core this
    // repo ships; ^0.1.0 against core 0.1.2 fails here.
    const floor = /^\^(\d+\.\d+\.\d+)$/u.exec(range);
    assert.ok(floor, `${name} declares an unparseable core range: ${range}`);
    assert.ok(compareTriples(parseVersion(floor[1]), parseVersion(version)) >= 0,
      `${name} admits a core older than the shipped ${version}: ${range}`);
    // ISSUE-626: the lock carries its own copy of this range, and it is the one an install of
    // the published adapter resolves. It must be the same string the manifest declares; the
    // lock held ^0.1.2 after both manifests moved to ^0.1.3.
    const lockedRange = locked[lockKey(dir)]?.dependencies?.['@cremator/core'];
    assert.equal(lockedRange, range,
      `package-lock.json and ${dir}/package.json disagree on the @cremator/core range: lock "${lockedRange}", manifest "${range}"`);
  }
});
