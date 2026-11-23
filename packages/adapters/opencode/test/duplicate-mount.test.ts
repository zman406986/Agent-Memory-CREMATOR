// ISSUE-424 / ISSUE-444: one live mount per durable root.
//
// Mount construction had no process-level identity: two mounts over one durable
// root opened two ledgers for the same session, tabled duplicate asks and landed
// duplicate receipts. `server.ts` only *asserted* that setup runs once. The
// registry in `plugin.ts` is the real guard: a second mount of the same durable
// configuration is refused by name, and closing the first frees the key.
// A `':memory:'` mount is not tracked: it has no durable identity and is
// test-only.

import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { OpencodePluginContext } from '../src/host.js';
import {
  OPENCODE_DUPLICATE_MOUNT_CODE, OpencodeDuplicateMountError,
  createOpencodeMount, createOpencodePlugin,
} from '../src/plugin.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { OpencodeMessage } from '../src/host.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-duplicate-'));
}

function conversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult('# Note\n\nbody\n'))]),
  ];
}

/** The smallest host `setup` accepts: every seam it needs, no live stream. */
function setupHost(): OpencodePluginContext {
  return {
    options: {},
    session: {
      hook: async () => ({}),
      generate: async () => ({ text: '{}' }),
    },
    tool: {
      transform: async (callback) => { await callback({ add: () => {} }); return {}; },
      hook: async () => ({}),
    },
    command: {
      transform: async (callback) => { await callback({ add: () => {} }); return {}; },
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* empty() {} }) },
  };
}

test('a second mount of one durable configuration is refused, never a second ledger', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const mounted: Record<string, unknown>[] = [];
  const first = createOpencodeMount({
    storage, journal: record => { mounted.push(record as unknown as Record<string, unknown>); },
  });
  try {
    await first.transform(sessionId, conversation());
    assert.throws(() => createOpencodeMount({ storage }), (error: unknown) =>
      error instanceof OpencodeDuplicateMountError
        && error.code === OPENCODE_DUPLICATE_MOUNT_CODE,
    'the second mount is refused by name');
    assert.equal(mounted.filter(line => line['kind'] === 'mounted').length, 1,
      'the refused mount constructed no second ledger');
    // The first mount still owns its session.
    await first.transform(sessionId, conversation());
  } finally { await first.close(); }

  const reopened = createOpencodeMount({ storage });
  try { await reopened.transform(sessionId, conversation()); }
  finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory mounts are not tracked: two identical mounts coexist', async () => {
  const first = createOpencodeMount({ storage: { databasePath: ':memory:' } });
  const second = createOpencodeMount({ storage: { databasePath: ':memory:' } });
  try {
    await first.transform(sessionId, conversation());
    await second.transform(sessionId, conversation());
  } finally {
    await first.close();
    await second.close();
  }
});

test('ISSUE-444: same root with a different journalFile is refused by name', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const first = createOpencodeMount({
    storage, journalFile: join(dir, 'first.ndjson'), journal: () => {},
  });
  try {
    assert.throws(() => createOpencodeMount({
      storage, journalFile: join(dir, 'second.ndjson'), journal: () => {},
    }), (error: unknown) => error instanceof OpencodeDuplicateMountError
      && error.code === OPENCODE_DUPLICATE_MOUNT_CODE && error.key === storage.crematorStorageRoot,
    'a differing journal does not make a distinct mount on one root');
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-444: same root with different excludeTools is refused by name', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const first = createOpencodeMount({ storage, excludeTools: ['bash'] });
  try {
    assert.throws(() => createOpencodeMount({ storage, excludeTools: ['read'] }),
      (error: unknown) => error instanceof OpencodeDuplicateMountError
        && error.key === storage.crematorStorageRoot,
      'a differing exclusion does not make a distinct mount on one root');
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-444: distinct roots still coexist', async () => {
  const dir = scratch();
  const first = createOpencodeMount({ storage: { crematorStorageRoot: join(dir, 'one') } });
  const second = createOpencodeMount({ storage: { crematorStorageRoot: join(dir, 'two') } });
  try {
    await first.transform(sessionId, conversation());
    await second.transform(sessionId, conversation());
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-464: a trailing separator, dot or dot-dot root is the same ledger', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  const first = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    // `join` downstream collapses each of these onto `<root>/sessions/<id>`, so
    // every spelling names the same directory and must be refused by name.
    for (const variant of [
      `${root}${sep}`,
      `${root}${sep}.`,
      `${root}${sep}sub${sep}..`,
    ]) {
      assert.throws(() => createOpencodeMount({ storage: { crematorStorageRoot: variant } }),
        (error: unknown) => error instanceof OpencodeDuplicateMountError
          && error.code === OPENCODE_DUPLICATE_MOUNT_CODE && error.key === variant,
        `the ${JSON.stringify(variant)} spelling opens the same ledger`);
    }
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-464/ISSUE-481: case-differing roots follow the volume, not the platform', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(root, { recursive: true });
  const upper = root.toUpperCase();
  // ISSUE-481: measure volume behaviour with a fresh entry, not with the code
  // under test. A case-flipped spelling of an entry created in one case
  // resolves only on a case-insensitive volume; comparing `realpathSync` strings
  // would echo the caller's case on macOS and miss the APFS default.
  mkdirSync(join(dir, 'case-probe'));
  const foldsCase = existsSync(join(dir, 'CASE-PROBE'));
  const first = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    if (foldsCase) {
      assert.throws(() => createOpencodeMount({ storage: { crematorStorageRoot: upper } }),
        (error: unknown) => error instanceof OpencodeDuplicateMountError
          && error.key === upper,
        'the volume folds case, so the uppercase root names the same ledger');
    } else {
      // A case-sensitive volume really does have two directories; the second
      // mount proves the guard leaves them alone.
      const second = createOpencodeMount({ storage: { crematorStorageRoot: upper } });
      await second.close();
    }
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-481: a junction or symlink to one directory is one durable root', async () => {
  const dir = scratch();
  const real = join(dir, 'store');
  const link = join(dir, 'link');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const first = createOpencodeMount({ storage: { crematorStorageRoot: real } });
  try {
    assert.throws(() => createOpencodeMount({ storage: { crematorStorageRoot: link } }),
      (error: unknown) => error instanceof OpencodeDuplicateMountError
        && error.code === OPENCODE_DUPLICATE_MOUNT_CODE && error.key === link,
      'the link names the directory the first mount already claimed');
  } finally {
    await first.close();
    rmSync(link, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-481: a trailing dot, space or extended-length spelling is one root on Windows', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  const first = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    if (process.platform === 'win32') {
      for (const variant of [`${root}.`, `${root} `, `\\\\?\\${root}`]) {
        assert.throws(() => createOpencodeMount({ storage: { crematorStorageRoot: variant } }),
          (error: unknown) => error instanceof OpencodeDuplicateMountError
            && error.code === OPENCODE_DUPLICATE_MOUNT_CODE && error.key === variant,
          `the ${JSON.stringify(variant)} spelling opens the same directory`);
      }
    } else {
      // A trailing dot is an ordinary character on this volume.
      const second = createOpencodeMount({ storage: { crematorStorageRoot: `${root}.` } });
      await second.close();
    }
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup shares one mount across activations on the same durable configuration', async () => {
  /*
   * The host activates a plugin once per location in one process. A second
   * activation must join the live mount, not open a second ledger; every
   * activation still registers its own location-scoped command. The mount
   * closes with the last activation, and the root becomes claimable again.
   */
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const records: Record<string, unknown>[] = [];
  const journal = (record: { kind: string }): void => {
    records.push(record as unknown as Record<string, unknown>);
  };
  const cleanupFirst = await createOpencodePlugin({ storage, journal }).setup(setupHost());
  let cleanupSecond: (() => void | Promise<void>) | null = null;
  try {
    cleanupSecond = await createOpencodePlugin({ storage, journal }).setup(setupHost());
    assert.equal(records.filter(line => line['kind'] === 'mounted').length, 1,
      'one mount is constructed for the durable root');
    const shared = records.filter(line => line['kind'] === 'mount-shared');
    assert.deepEqual(shared.map(line => line['status']), ['created', 'reused'],
      'the second activation records that it reused the live mount');
  } finally {
    await cleanupFirst();
  }
  try {
    assert.equal(typeof cleanupSecond, 'function');
  } finally { await cleanupSecond?.(); }

  // The last activation released the root: a later mount can claim it.
  const reopened = createOpencodeMount({ storage });
  try { await reopened.transform(sessionId, conversation()); }
  finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One pid no process holds, so a claim naming it is a crashed mount's. */
function deadPid(): number {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  };
  for (let pid = 999_999; pid > 999_000; pid -= 1) if (!alive(pid)) return pid;
  throw new Error('no dead pid found for the crash fixture');
}

/** The claim file a durable root carries (ISSUE-497). */
const MOUNT_LOCK_FILE = 'mount.lock';

/** The claim file one durable root carries, read as plain data. */
function claimOf(root: string): Record<string, unknown> {
  const raw = readFileSync(join(root, MOUNT_LOCK_FILE), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

test('ISSUE-497: a live claim from another process refuses the mount by name', async () => {
  /*
   * The registry above is a per-process Map, so it cannot see a second
   * `opencode --resume` terminal on one root: both would open a ledger on one
   * `ledger.sqlite` and two writers would republish one mount-state file. The
   * root's claim file is the OS-level test-and-set; a live holder refuses this
   * mount with the same named error as the in-process duplicate.
   */
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(root, { recursive: true });
  const foreign = { pid: process.pid, atMs: Date.now(), token: 'the-other-process' };
  writeFileSync(join(root, MOUNT_LOCK_FILE), JSON.stringify(foreign), 'utf8');
  try {
    assert.throws(() => createOpencodeMount({ storage: { crematorStorageRoot: root } }),
      (error: unknown) => error instanceof OpencodeDuplicateMountError
        && error.code === OPENCODE_DUPLICATE_MOUNT_CODE
        && error.key === root
        && String(error.message).includes(`pid ${String(process.pid)}`),
      'the second process is refused by the named duplicate-mount error, naming the holder');
    assert.deepEqual(claimOf(root), foreign,
      'the refused mount neither takes nor rewrites the holding claim');
    assert.equal(existsSync(join(root, 'sessions')), false,
      'the refused mount opened no ledger and made no mount-state writer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-497: the root claim is held for the mount and released on close', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: root }, journal: () => {},
  });
  const lockPath = join(root, MOUNT_LOCK_FILE);
  try {
    // Taken at mount, before any session ledger can open.
    const held = claimOf(root);
    assert.equal(held['pid'], process.pid, 'the claim names this process');
    assert.equal(typeof held['token'], 'string', 'the claim carries its own release token');
    await mount.transform(sessionId, conversation());
  } finally { await mount.close(); }
  assert.equal(existsSync(lockPath), false, 'the close releases the root claim');
  // The released root is free: no stale claim blocks the next mount.
  const reopened = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    await reopened.transform(sessionId, conversation());
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-497: a claim whose process is gone is cleared, never a wedge', async () => {
  /*
   * The claim has no expiry (ADR-0066 decision 5), so it cannot be a lease: a
   * crashed mount's file must not lock the root forever. The owner record is the
   * fact —a claim naming a dead (or unreadable) process is evidence of a crash
   * and is cleared once; a claim naming a live process is refused.
   */
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(root, { recursive: true });
  const dead = deadPid();
  writeFileSync(join(root, MOUNT_LOCK_FILE),
    JSON.stringify({ pid: dead, atMs: Date.now(), token: 'crashed-mount' }), 'utf8');
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: root }, journal: () => {},
  });
  try {
    const held = claimOf(root);
    assert.equal(held['pid'], process.pid, "the dead claim is replaced by this mount's own");
    assert.notEqual(held['token'], 'crashed-mount', 'the replacement carries a fresh token');
    await mount.transform(sessionId, conversation());
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

