// C3 storage gate (plan §7): a durable root derives one ledger file and one blob
// directory per session, and a durable `{databasePath, blobRoot}` pair is refused
// while `':memory:'` is accepted as the test-only pair; the resume-across-reopen
// and unsafe-session-id sweeps follow.
//
// Every expected path is built with `join()` from a mkdtemp root, never from a literal
// drive letter: the assertion must be true on Windows and POSIX alike (ISSUE-036).
//
// Every claim is a row of one table, so a failure names the claim it broke.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  OpencodeStorageError, defaultStorageRoot, openLedger, resolveStorage, sessionStorage,
} from '../src/storage.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

const clock = { nowMs: () => 100 };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-storage-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof OpencodeStorageError && error.code === expected;

/** The value a throwing call threw, so the refusal's own fields can be read. */
function thrown(call: () => unknown): unknown {
  try { call(); return null; } catch (caught) { return caught; }
}

const ROWS: readonly Row[] = [
  { name: 'default-root-is-home-scoped', run(at) {
    // The default root sits under the user's home, never the host data directory.
    const home = join(tmpdir(), 'home');
    assert.equal(defaultStorageRoot(home), join(home, '.cremator', 'opencode'),
      at('the default root is <home>/.cremator/opencode, never the host data directory'));
  } },
  { name: 'absent-root-is-durable', run(at) {
    // An absent root is durable: a shipped mount must not fall back to memory.
    const home = join(tmpdir(), 'home');
    assert.deepEqual(resolveStorage(undefined, home),
      { kind: 'durable', root: join(home, '.cremator', 'opencode') },
      at('an absent root resolves durably'));
    assert.deepEqual(resolveStorage({}, home),
      { kind: 'durable', root: join(home, '.cremator', 'opencode') },
      at('an empty options object resolves durably'));
  } },
  { name: 'durable-root-derives-session-paths', async run(at) {
    const dir = scratch();
    const root = join(dir, 'racoons');
    try {
      const target = sessionStorage(resolveStorage({ crematorStorageRoot: root }), 'session-durable');
      assert.equal(target.databasePath, join(root, 'sessions', 'session-durable', 'ledger.sqlite'),
        at('the per-session sqlite path is derived from the root'));
      assert.equal(target.blobRoot, join(root, 'sessions', 'session-durable', 'blobs'),
        at('the sibling blob path is derived from the root'));
      const ledger = await openLedger(target, clock);
      try {
        assert.ok(existsSync(target.databasePath), at('the per-session sqlite file exists'));
        assert.ok(existsSync(target.blobRoot), at('the sibling blob directory exists'));
      } finally { await ledger.close(); }
    } finally { cleanup(dir); }
  } },
  { name: 'durable-pair-is-refused', run(at) {
    const dir = scratch();
    try {
      const databasePath = join(dir, 'ledger.sqlite');
      assert.throws(() => resolveStorage({ databasePath }), code('explicit-storage-paths'),
        at('a durable databasePath alone is refused'));
      const error = thrown(() => resolveStorage({ databasePath }));
      assert.ok(error instanceof OpencodeStorageError, at('the refusal is typed'));
      assert.equal((error as { path?: unknown }).path, databasePath,
        at('the refusal names the explicit path'));
      // A lone blobRoot is refused for the same reason, not silently dropped.
      assert.throws(() => resolveStorage({ blobRoot: join(dir, 'blobs') }),
        code('explicit-storage-paths'), at('a lone blobRoot is refused'));
    } finally { cleanup(dir); }
  } },
  { name: 'memory-pair-is-accepted', run(at) {
    const dir = scratch();
    try {
      // ':memory:' keeps working; a durable blobRoot beside it is still refused.
      assert.deepEqual(resolveStorage({ databasePath: ':memory:' }), { kind: 'memory' },
        at("':memory:' is the test-only pair"));
      assert.throws(() => resolveStorage({ databasePath: ':memory:', blobRoot: join(dir, 'b') }),
        code('explicit-storage-paths'), at("a durable blobRoot beside ':memory:' is refused"));
      // Memory is a whole pair: it ignores a root that is also configured.
      assert.deepEqual(
        resolveStorage({ databasePath: ':memory:', crematorStorageRoot: join(dir, 'root') }),
        { kind: 'memory' }, at('memory wins over a configured root'));
      assert.ok(!existsSync(join(dir, 'root')),
        at('the in-memory pair creates no directory'));
    } finally { cleanup(dir); }
  } },
  { name: 'reopen-resumes-the-append-only-file', async run(at) {
    const dir = scratch();
    const root = join(dir, 'racoons');
    const target = sessionStorage(resolveStorage({ crematorStorageRoot: root }), 'session-resume');
    try {
      const first = await openLedger(target, clock);
      try {
        await first.append({
          kind: 'validation', sessionId: 'session-resume', eventKey: 'v:1', atMs: 1,
          eventId: 'evt-1', ok: true, issues: [],
          breaker: { consecutiveValidationFailures: 0, disabled: false },
        });
      } finally { await first.close(); }

      // A second open is the same file, not a fresh schema: the entry is still readable.
      const second = await openLedger(target, clock);
      try {
        const sequences: number[] = [];
        for await (const entry of second.events('session-resume')) sequences.push(entry.sequence);
        assert.deepEqual(sequences, [1], at('the appended entry survived the reopen'));
        const again = await second.append({
          kind: 'validation', sessionId: 'session-resume', eventKey: 'v:2', atMs: 2,
          eventId: 'evt-2', ok: true, issues: [],
          breaker: { consecutiveValidationFailures: 0, disabled: false },
        });
        assert.equal(again.sequence, 2, at('the file keeps appending after a reopen'));
      } finally { await second.close(); }
    } finally { cleanup(dir); }
  } },
  { name: 'escaping-session-id-is-refused', run(at) {
    const root = join(tmpdir(), 'racoons-oc-ids');
    const selection = resolveStorage({ crematorStorageRoot: root });
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:x', 'a\0b']) {
      assert.throws(() => sessionStorage(selection, bad), code('invalid-session-id'),
        at(`session id ${JSON.stringify(bad)} must be refused`));
    }
    const error = thrown(() => sessionStorage(selection, '../escape'));
    assert.ok(error instanceof OpencodeStorageError, at('the refusal is typed'));
    assert.equal((error as { path?: unknown }).path, '../escape',
      at('the refusal names the id at fault'));
    assert.equal(sessionStorage(selection, 's-1').databasePath,
      join(root, 'sessions', 's-1', 'ledger.sqlite'), at('a safe id still derives its path'));
  } },
  { name: 'windows-unsafe-ids-map-to-distinct-dirs', run(at) {
    // ISSUE-378: Windows folds case, trims trailing dots/spaces and refuses device
    // names, so raw ids would share one directory (or fail to create one) and mix
    // ledgers/blobs across sessions (ADR-0013 ruling 1). The claim is checked on the
    // derived directory NAME, not the filesystem, so it is red before the fix on
    // every platform: a raw 'Session'/'session' pair differs as strings yet folds to
    // one Windows dir, so string-distinctness alone would not catch the defect.
    const root = join(tmpdir(), 'racoons-oc-collide');
    const selection = resolveStorage({ crematorStorageRoot: root });
    const segment = (id: string): string =>
      basename(dirname(sessionStorage(selection, id).databasePath));

    // Ids Windows cannot hold verbatim must be escaped, never used as the raw name.
    for (const unsafe of ['Session', 'foo.', 'bar ', 'con', 'nul', 'aux', 'prn', 'com1', 'lpt1']) {
      assert.notEqual(segment(unsafe), unsafe,
        at(`unsafe id ${JSON.stringify(unsafe)} is not used verbatim as a directory`));
    }

    // The escape is reversible: '~' + hex decodes back to the exact id, so it is injective.
    for (const id of ['Session', 'foo.', 'con']) {
      const seg = segment(id);
      assert.ok(seg.startsWith('~'), at(`${JSON.stringify(id)} is hex-escaped behind a '~' marker`));
      assert.equal(Buffer.from(seg.slice(1), 'hex').toString('utf8'), id,
        at(`the escaped directory for ${JSON.stringify(id)} decodes back to the id`));
    }

    // Pairs Windows would collapse must land on distinct directories.
    for (const [a, b] of [['Session', 'session'], ['foo.', 'foo'], ['bar ', 'bar'],
      ['con', 'nul']] as const) {
      assert.notEqual(segment(a), segment(b),
        at(`${JSON.stringify(a)} and ${JSON.stringify(b)} keep distinct directories`));
    }

    // No regression: ids already safe on every platform stay verbatim, so directories
    // created before this fix are still found (no migration for the common lowercase id).
    for (const safe of ['session', 's-1', 'session-durable', 'a.b_c-d']) {
      assert.equal(segment(safe), safe,
        at(`safe id ${JSON.stringify(safe)} stays verbatim`));
    }
  } },
  { name: 'memory-opens-a-working-ledger', async run(at) {
    const dir = scratch();
    try {
      const target = sessionStorage(resolveStorage({ databasePath: ':memory:' }), 'session-memory');
      assert.equal(target.databasePath, ':memory:', at('the memory pair names :memory:'));
      assert.equal(target.blobRoot, ':memory:', at('and so does its blob root'));
      const ledger = await openLedger(target, clock);
      try {
        const entry = await ledger.append({
          kind: 'validation', sessionId: 'session-memory', eventKey: 'v:1', atMs: 1,
          eventId: 'evt-1', ok: true, issues: [],
          breaker: { consecutiveValidationFailures: 0, disabled: false },
        });
        assert.equal(entry.sequence, 1, at('the in-memory pair is a working ledger'));
      } finally { await ledger.close(); }
      assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [],
        at('the in-memory pair created no file under the scratch root'));
    } finally { cleanup(dir); }
  } },
];

test('the storage seam — one row per claim', async () => {
  await runRows(ROWS);
});
