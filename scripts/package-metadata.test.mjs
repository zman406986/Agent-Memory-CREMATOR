// Publish-metadata gate for the three shipped packages (ISSUE-271).
//
// The manifests carry repository/homepage/bugs/author and a Node range that
// excludes 23.0-23.3; before this file nothing read either claim. The range
// check parses the two comparator sets the manifest uses, so a hand edit that
// re-admits 23.1 fails here rather than in a user install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  { dir: 'packages/core', name: '@cremator/core' },
  { dir: 'packages/adapters/dsh', name: 'cremator-dsh' },
  { dir: 'packages/adapters/opencode', name: 'cremator-opencode' },
];
const REPO = 'https://github.com/zman406986/Agent-Memory-CREMATOR';
const NODE_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';
// The two adapters: each declares its dependency on core in `dependencies`.
const ADAPTERS = PACKAGES.filter(({ dir }) => dir.startsWith('packages/adapters/'));

function manifest(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Parse the exact comparator set shape used in `engines.node`: whitespace-separated
// `>=x.y.z` and `<x.y.z`, alternatives split on `||`. Anything else fails closed.
function satisfies(version, range) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
    assert.ok(match, `unparseable version ${value}`);
    return match.slice(1).map(Number);
  };
  const target = parse(version);
  const compare = (a, b) => {
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
  };
  return range.split('||').some((alternative) => alternative.trim().split(/\s+/u).every((token) => {
    const match = /^(>=|<)(.+)$/u.exec(token);
    assert.ok(match, `unparseable comparator ${token}`);
    const bound = parse(match[2]);
    return match[1] === '>=' ? compare(target, bound) >= 0 : compare(target, bound) < 0;
  }));
}

test('every publishable manifest names the repository, homepage, bugs and author', () => {
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
  }
});

test('the Node range excludes 23.0-23.3 and is the one sentence the README states', () => {
  for (const { dir, name } of PACKAGES) {
    assert.equal(manifest(dir).engines?.node, NODE_RANGE, `${name} engines.node drifted`);
  }
  assert.ok(satisfies('22.13.0', NODE_RANGE));
  assert.ok(satisfies('22.12.9', NODE_RANGE) === false);
  assert.ok(satisfies('23.0.0', NODE_RANGE) === false);
  assert.ok(satisfies('23.1.0', NODE_RANGE) === false);
  assert.ok(satisfies('23.3.9', NODE_RANGE) === false);
  assert.ok(satisfies('23.4.0', NODE_RANGE));
  assert.ok(satisfies('24.0.0', NODE_RANGE));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`Node \`${NODE_RANGE}\``),
    'README Requirements does not state the manifest range');
  assert.ok(readme.includes('23.0.0–23.3.x are excluded'),
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
  for (const { dir } of ADAPTERS) {
    const range = manifest(dir).dependencies['@cremator/core'];
    assert.ok(readme.includes(`"@cremator/core": "${range}"`),
      `README Publishing does not state the core range ${dir} declares: ${range}`);
  }
});
