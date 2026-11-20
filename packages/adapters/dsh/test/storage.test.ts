/**
 * The storage seam (ADR-0013, ISSUE-004 chunk 2): a durable per-session SQLite
 * file with a sibling blob root, `':memory:'` for tests, and the mount journal
 * line that records which one is in use plus the runtime it ran on.
 *
 * Two tables, because the claims split on whether a mount is needed: the path
 * and refusal rules, and the two journal lines a mount writes. Every assertion
 * names its row.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DshMountContext } from '../src/plugin.js';
import { createRacoonsMount, createRacoonsPlugin, resolvePluginConfig } from '../src/plugin.js';
import {
  RacoonsStorageError, defaultStorageRoot, openLedger, resolveSessionStorage, resolveStorage,
} from '../src/storage.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

const clock = { nowMs: () => 100 };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-storage-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

const storageCode = (expected: string) => (error: unknown): boolean =>
  error instanceof RacoonsStorageError && error.code === expected;

/** The value a throwing call threw, so the refusal's own fields can be read. */
function thrown(call: () => unknown): unknown {
  try { call(); return null; } catch (caught) { return caught; }
}

const ROWS: readonly Row[] = [
  { name: 'durable-root-opens-one-file-one-blob-dir', async run(at) {
    const dir = scratch();
    const root = join(dir, 'racoons');
    try {
      const target = resolveSessionStorage(root, 'session-durable');
      const ledger = await openLedger(target, clock);
      try {
        assert.ok(existsSync(target.databasePath), at('the per-session sqlite file exists'));
        assert.ok(existsSync(target.blobRoot), at('the sibling blob directory exists'));
        assert.equal(target.databasePath,
          join(root, 'sessions', 'session-durable', 'ledger.sqlite'),
          at('the database path is derived from the root'));
        assert.equal(target.blobRoot, join(root, 'sessions', 'session-durable', 'blobs'),
          at('the blob path is derived from the root'));
      } finally { await ledger.close(); }
      // The file is a real ledger: it reopens through the same seam.
      const again = await openLedger(target, clock);
      await again.close();
    } finally { cleanup(dir); }
  } },
  { name: 'explicit-pair-is-refused-one-root-only', async run(at) {
    const dir = scratch();
    try {
      const pair = { databasePath: join(dir, 'ledger.sqlite'), blobRoot: join(dir, 'blobs') };
      assert.throws(() => resolveStorage(pair), storageCode('explicit-storage-paths'),
        at('a durable {databasePath, blobRoot} pair is refused'));
      const error = thrown(() => resolveStorage(pair));
      assert.ok(error instanceof RacoonsStorageError, at('the refusal is typed'));
      assert.equal(error.path, pair.databasePath, at('the refusal names the explicit path'));
      assert.match(error.message, /shared by every session/u, at('the reason is named'));
      // The product path refuses it at apply, before any session opens a ledger.
      const plugin = createRacoonsPlugin({ storage: pair });
      await assert.rejects(plugin.apply({
        logger: { warn: () => {} }, on: (event) => event,
      }), storageCode('explicit-storage-paths'), at('apply refuses it before any ledger opens'));
      // A lone blobRoot is refused for the same reason, not silently dropped.
      assert.throws(() => resolveStorage({ blobRoot: join(dir, 'blobs') }),
        storageCode('explicit-storage-paths'), at('a lone blobRoot is refused'));
      // ':memory:' keeps working; a durable blobRoot beside it is still refused.
      assert.deepEqual(resolveStorage({ databasePath: ':memory:' }),
        { databasePath: ':memory:', blobRoot: ':memory:' },
        at("':memory:' resolves to the in-memory pair"));
      assert.throws(() => resolveStorage({ databasePath: ':memory:', blobRoot: join(dir, 'b') }),
        storageCode('explicit-storage-paths'),
        at("a durable blobRoot beside ':memory:' is still refused"));
    } finally { cleanup(dir); }
  } },
  { name: 'escaping-session-id-is-refused', run(at) {
    const root = join(tmpdir(), 'racoons-ids');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:x']) {
      assert.throws(() => resolveSessionStorage(root, bad), storageCode('invalid-session-id'),
        at(`session id ${JSON.stringify(bad)} must be refused`));
    }
    assert.equal(resolveSessionStorage(root, 's-1').databasePath,
      join(root, 'sessions', 's-1', 'ledger.sqlite'), at('a safe id still derives its path'));
  } },
  { name: 'windows-colliding-ids-keep-separate-state', async run(at) {
    // ISSUE-345: Windows folds case and trims trailing dots, so these id pairs
    // must not share one ledger file or blob directory.
    const dir = scratch();
    const root = join(dir, 'racoons');
    try {
      for (const [idA, idB] of [['Session', 'session'], ['foo.', 'foo']] as const) {
        const targetA = resolveSessionStorage(root, idA);
        const targetB = resolveSessionStorage(root, idB);
        const a = await openLedger(targetA, clock);
        const b = await openLedger(targetB, clock);
        try {
          await a.append({ kind: 'breaker-announced', sessionId: 'probe',
            eventKey: `notice:${idA}`, atMs: 110, recordId: `rec-${idA}` });
          const seen: string[] = [];
          for await (const entry of b.events('probe')) seen.push(entry.event.eventKey);
          assert.deepEqual(seen, [],
            at(`the ledger for ${JSON.stringify(idB)} sees no row from ${JSON.stringify(idA)}`));
          assert.notEqual(realpathSync(targetA.blobRoot), realpathSync(targetB.blobRoot),
            at(`blob dirs for ${JSON.stringify(idA)} / ${JSON.stringify(idB)} are physically distinct`));
        } finally { await a.close(); await b.close(); }
      }
    } finally { cleanup(dir); }
  } },
  { name: 'default-root-is-dsh-home-storages', run(at) {
    const home = join(tmpdir(), 'home');
    assert.equal(defaultStorageRoot({}, home), join(home, '.dsh', 'storages', 'cremator'),
      at('DSH_HOME defaults to ~/.dsh'));
    // An absolute DSH_HOME is used as-is. The example is this platform's own
    // absolute root: a drive letter is absolute on Windows only (ISSUE-036).
    const absoluteDshHome = join(tmpdir(), 'dsh-home');
    assert.equal(defaultStorageRoot({ DSH_HOME: absoluteDshHome }, home),
      join(absoluteDshHome, 'storages', 'cremator'), at('an absolute DSH_HOME is used as-is'));
    // A relative DSH_HOME is read under the home directory, never the cwd.
    assert.equal(defaultStorageRoot({ DSH_HOME: '.dsh-alt' }, home),
      join(home, '.dsh-alt', 'storages', 'cremator'),
      at('a relative DSH_HOME is read under the home directory'));
    // A drive-letter DSH_HOME: absolute on Windows, relative on POSIX, where it
    // lands under `home`. Both readings are stated, never assumed.
    const driveDshHome = 'C:/dsh-home';
    assert.equal(defaultStorageRoot({ DSH_HOME: driveDshHome }, home),
      process.platform === 'win32'
        ? join(driveDshHome, 'storages', 'cremator')
        : join(home, driveDshHome, 'storages', 'cremator'),
      at('a drive-letter DSH_HOME is read by this platform\'s own rule'));
    assert.equal(resolvePluginConfig({}).crematorStorageRoot, defaultStorageRoot(),
      at('the configured plugin root is the default root'));
  } },
  { name: 'relative-or-lone-value-is-refused', run(at) {
    assert.throws(() => resolveStorage(undefined, 'relative/root'),
      storageCode('relative-root'), at('a relative durable root is refused'));
    assert.throws(() => resolveStorage({ databasePath: 'ledger.sqlite', blobRoot: 'C:/b' }),
      (error: unknown) => error instanceof RacoonsStorageError
        && error.code === 'explicit-storage-paths' && error.path === 'ledger.sqlite',
      at('a lone relative databasePath is refused and named'));
    // A relative root passed through the storage options is refused the same way.
    assert.throws(() => resolveStorage({ root: 'relative/root' }), storageCode('relative-root'),
      at('a relative root in the storage options is refused'));
  } },
  { name: 'durable-open-failure-is-typed', async run(at) {
    const dir = scratch();
    // A directory where the sqlite file must be: the open cannot succeed.
    const databasePath = join(dir, 'not-a-file');
    mkdirSync(databasePath, { recursive: true });
    try {
      await assert.rejects(openLedger({ databasePath, blobRoot: join(dir, 'blobs') }, clock),
        (error: unknown) => error instanceof RacoonsStorageError
          && error.code === 'durable-open-failed' && error.path === databasePath,
        at('the failure is typed and carries the database path'));
    } finally { cleanup(dir); }
  } },
];

/** A plugin context that records the listeners, as the host installs them. */
function context(): DshMountContext {
  return {
    logger: { warn: () => {} },
    on: (event, listener) => { void event; void listener; return () => {}; },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') void fn; },
  };
}

test('the storage path and refusal rules — one row per claim', async () => {
  await runRows(ROWS);
});

test('a mount journals which ledger it opened, and the runtime it ran on', async () => {
  const rows: readonly Row[] = [
    { name: 'durable-mount', async run(at) {
      const dir = scratch();
      const root = join(dir, 'racoons');
      const journal: { kind: string; [field: string]: unknown }[] = [];
      const plugin = createRacoonsPlugin({ journal: (record) => journal.push(record),
        config: { crematorStorageRoot: root } });
      try {
        await plugin.apply(context(), {});
        const mounted = journal.find((line) => line['kind'] === 'mounted');
        assert.ok(mounted !== undefined, at('the mount is journaled'));
        assert.equal(mounted['ledgerSource'], 'durable', at('the ledger source is durable'));
        assert.equal(mounted['node'], process.version, at('the runtime is recorded'));
        // The mount line names the configured root; no derived `<sessionId>` layout.
        assert.equal(mounted['storageRoot'], root, at('the configured root is named'));
        assert.equal(mounted['storage'], undefined,
          at('the mount line carries no placeholder ledger path'));
        assert.equal(mounted['blobRoot'], undefined,
          at('the mount line carries no placeholder blob root'));
        const mount = createRacoonsMount({
          config: resolvePluginConfig({ crematorStorageRoot: root }),
          storage: resolveStorage(undefined, root), journal: () => {} });
        try {
          const entry = await mount.sessionFor('session-journal');
          assert.equal(entry.ownedLedger, true, at('the mount owns its ledger'));
          assert.ok(existsSync(join(root, 'sessions', 'session-journal', 'ledger.sqlite')),
            at('the session ledger file exists under the root'));
          assert.ok(existsSync(join(root, 'sessions', 'session-journal', 'blobs')),
            at('the session blob directory exists under the root'));
        } finally { await mount.close(); }
      } finally { cleanup(dir); }
    } },
    { name: 'memory-mount', async run(at) {
      const target = resolveStorage({ databasePath: ':memory:' });
      assert.deepEqual(target, { databasePath: ':memory:', blobRoot: ':memory:' },
        at("':memory:' resolves to the in-memory pair"));
      const ledger = await openLedger(target, clock);
      await ledger.close();
      const journal: { kind: string; [field: string]: unknown }[] = [];
      const plugin = createRacoonsPlugin({ journal: (record) => journal.push(record),
        storage: { databasePath: ':memory:' } });
      await plugin.apply(context(), {});
      const mounted = journal.find((line) => line['kind'] === 'mounted');
      assert.equal(mounted?.['ledgerSource'], 'memory', at('the ledger source is memory'));
      assert.equal(mounted?.['node'], process.version, at('the runtime is recorded'));
    } },
  ];
  await runRows(rows);
});
