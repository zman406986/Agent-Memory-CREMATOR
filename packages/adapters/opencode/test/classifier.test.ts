// C2 classifier gate (plan §7): the OpenCode tool id → core evidence kind table.
// The override table that replaces the defaults wholesale, the frozen default
// table, and the unknown-id, case-insensitivity and prototype sweeps. The sweeps
// pin the four evidence kinds and the `other` fallback at their edges.
//
// Every claim is a row of one table, so a failure names the claim it broke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OPENCODE_TOOL_TABLE, OPENCODE_TOOL_CLASSES, createOpencodeToolClassifier } from '../src/classifier.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

const ROWS: readonly Row[] = [
  { name: 'override-replaces-wholesale', run(at) {
    const classify = createOpencodeToolClassifier({ table: { grep: 'search' } });
    assert.equal(classify('grep'), 'search', at('the override row applies'));
    // `read` and `glob` are rows in the default table; the override drops them.
    assert.equal(classify('read'), 'other', at('a default row not in the override is dropped'));
    assert.equal(classify('glob'), 'other', at('and so is the second default row'));
    // And the defaults were not mutated by building the override.
    assert.equal(createOpencodeToolClassifier()('read'), 'read',
      at('building an override must not mutate the defaults'));
  } },
  { name: 'default-table-frozen', run(at) {
    assert.ok(Object.isFrozen(DEFAULT_OPENCODE_TOOL_TABLE),
      at('the default table is frozen'));
    assert.deepEqual([...OPENCODE_TOOL_CLASSES], ['read', 'search', 'glob', 'write', 'other'],
      at('the core declares exactly these five kinds'));
  } },
  { name: 'write-is-its-own-kind', run(at) {
    // The stale-read proof rule only sees a later call whose kind is `write`
    // (`packages/core/src/rules/stale.ts:32-45`; ADR-0046).
    assert.equal(DEFAULT_OPENCODE_TOOL_TABLE['write'], 'write',
      at('the default table names write, not other'));
    const classify = createOpencodeToolClassifier();
    assert.equal(classify('write'), 'write', at('write is write'));
    assert.equal(classify('WRITE'), 'write', at('and the row is case-insensitive'));
    assert.equal(classify('Write'), 'write', at('mixed case reads the same row'));
  } },
  { name: 'edit-and-patch-stay-other', run(at) {
    // ADR-0046 decides only the `write` row; a later record is needed before
    // another tool is treated as a path-changing observation.
    const classify = createOpencodeToolClassifier();
    for (const name of ['edit', 'patch']) {
      assert.equal(classify(name), 'other', at(`${name} is not a write this record claims`));
    }
  } },
  { name: 'default-table-names-core-kinds', run(at) {
    for (const kind of Object.values(DEFAULT_OPENCODE_TOOL_TABLE)) {
      assert.ok((OPENCODE_TOOL_CLASSES as readonly string[]).includes(kind),
        at(`${kind} is not a core kind`));
    }
  } },
  { name: 'unlisted-id-is-other', run(at) {
    const classify = createOpencodeToolClassifier();
    for (const name of ['read_file', 'grep-all', 'globstar', 'Search', 'READER', '']) {
      assert.equal(classify(name), 'other', at(`${name} must not be guessed`));
    }
  } },
  { name: 'lookup-is-case-insensitive', run(at) {
    const classify = createOpencodeToolClassifier();
    for (const name of ['READ', 'Read', 'rEaD']) {
      assert.equal(classify(name), 'read', at(`${name} must match the read row`));
    }
    assert.equal(classify('GREP'), 'search', at('grep is case-insensitive'));
    assert.equal(classify('Glob'), 'glob', at('glob is case-insensitive'));
    assert.equal(classify('Bash'), 'other', at('an unlisted id case-folds to other too'));
  } },
  { name: 'table-keys-are-case-insensitive', run(at) {
    const upper = createOpencodeToolClassifier({ table: { READ: 'read', Grep: 'search' } });
    assert.equal(upper('read'), 'read', at('an upper-case table key matches a lower-case id'));
    assert.equal(upper('grep'), 'search', at('a mixed-case table key matches a lower-case id'));
  } },
  { name: 'prototype-members-are-other', run(at) {
    const classify = createOpencodeToolClassifier();
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(classify(name), 'other', at(`${name} leaked the object prototype`));
    }
  } },
];

test('the tool-id table — one row per claim', async () => {
  await runRows(ROWS);
});
