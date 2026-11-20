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

function manifest(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
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
  assert.ok(readme.includes(NODE_RANGE),
    'README does not state the manifest Node range');
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

test('the adapter manifests declare the core dependency range', () => {
  for (const dir of ['packages/adapters/dsh', 'packages/adapters/opencode']) {
    const dependencies = manifest(dir).dependencies ?? {};
    assert.equal(dependencies['@cremator/core'], '^0.1.0',
      `${dir} does not declare the core dependency`);
  }
});
