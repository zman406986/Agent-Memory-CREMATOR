// ISSUE-424 / ISSUE-444 / ISSUE-563: one shared mount per durable root.
//
// Mount construction had no process-level identity: two mounts over one durable
// root opened two ledgers for the same session, tabled duplicate asks and landed
// duplicate receipts. `server.ts` only *asserted* that setup runs once. The
// registry in `plugin.ts` is the real guard, and ISSUE-563 (owner ruling
// 2026-11-24) makes it a JOIN, never a refusal: two terminals on one project
// must both work. A second mount of a live root is handed the live mount — the
// same session map and the same ledger — and closes only when its last holder
// releases it. Across processes, every mount records itself under `mounts/` and
// shares the session ledger, whose own write lock serializes state.
// A `':memory:'` mount is not tracked: it has no durable identity.

import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { OpencodePluginContext } from '../src/host.js';
import {
  OPENCODE_MOUNT_DIRECTORY, createOpencodeMount, createOpencodePlugin, readMountRootHolders,
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

test('a second mount of one durable root joins it: one ledger, both act', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const mounted: Record<string, unknown>[] = [];
  const journal = (record: { kind: string }): void => {
    mounted.push(record as unknown as Record<string, unknown>);
  };
  const first = createOpencodeMount({ storage, journal });
  const second = createOpencodeMount({ storage, journal });
  try {
    // ISSUE-563: the second mount is the live mount, not a second ledger.
    assert.equal(second, first, 'the second mount joins the live mount');
    await first.transform(sessionId, conversation());
    await second.transform(sessionId, conversation());
    assert.equal(mounted.filter(line => line['kind'] === 'mounted').length, 1,
      'the joining mount constructed no second ledger');
    assert.deepEqual(mounted.filter(line => line['kind'] === 'mount-shared')
      .map(line => line['status']), ['reused'], 'the join is named in the journal');
    const sessionDirs = readdirSync(join(storage.crematorStorageRoot, 'sessions'));
    assert.equal(sessionDirs.length, 1, 'one session directory, so one ledger');
    assert.equal(existsSync(join(storage.crematorStorageRoot, 'sessions', sessionDirs[0] ?? '',
      'ledger.sqlite')), true, 'the one ledger exists');
  } finally {
    // The shared mount closes only with its last holder.
    await second.close();
    assert.equal(first.disposed, false, 'one holder remains, so the mount stays open');
    await first.close();
  }
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

test('ISSUE-444: same root with a different journalFile joins the same mount', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const first = createOpencodeMount({
    storage, journalFile: join(dir, 'first.ndjson'), journal: () => {},
  });
  const second = createOpencodeMount({
    storage, journalFile: join(dir, 'second.ndjson'), journal: () => {},
  });
  try {
    assert.equal(second, first, 'a differing journal does not make a distinct mount on one root');
  } finally {
    await second.close();
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-444: same root with different excludeTools joins the same mount', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const first = createOpencodeMount({ storage, excludeTools: ['bash'] });
  const second = createOpencodeMount({ storage, excludeTools: ['read'] });
  try {
    assert.equal(second, first, 'a differing exclusion does not make a distinct mount on one root');
  } finally {
    await second.close();
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-444: distinct roots still coexist', async () => {
  const dir = scratch();
  const first = createOpencodeMount({ storage: { crematorStorageRoot: join(dir, 'one') } });
  const second = createOpencodeMount({ storage: { crematorStorageRoot: join(dir, 'two') } });
  try {
    assert.notEqual(second, first, 'two roots are two mounts');
    await first.transform(sessionId, conversation());
    await second.transform(sessionId, conversation());
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-464: a trailing separator, dot or dot-dot root is the same mount', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  const first = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    // `join` downstream collapses each of these onto `<root>/sessions/<id>`, so
    // every spelling names the same directory and must join the same mount.
    for (const variant of [
      `${root}${sep}`,
      `${root}${sep}.`,
      `${root}${sep}sub${sep}..`,
    ]) {
      const joined = createOpencodeMount({ storage: { crematorStorageRoot: variant } });
      assert.equal(joined, first, `the ${JSON.stringify(variant)} spelling is the same mount`);
      await joined.close();
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
    const second = createOpencodeMount({ storage: { crematorStorageRoot: upper } });
    try {
      if (foldsCase) {
        assert.equal(second, first, 'the volume folds case, so the uppercase root is one mount');
      } else {
        // A case-sensitive volume really does have two directories.
        assert.notEqual(second, first, 'two directories on this volume are two mounts');
        await second.transform(sessionId, conversation());
      }
    } finally { await second.close(); }
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
  const second = createOpencodeMount({ storage: { crematorStorageRoot: link } });
  try {
    assert.equal(second, first, 'the link names the directory the first mount opened');
  } finally {
    await second.close();
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
        const joined = createOpencodeMount({ storage: { crematorStorageRoot: variant } });
        assert.equal(joined, first,
          `the ${JSON.stringify(variant)} spelling opens the same directory`);
        await joined.close();
      }
    } else {
      // A trailing dot is an ordinary character on this volume.
      const second = createOpencodeMount({ storage: { crematorStorageRoot: `${root}.` } });
      assert.notEqual(second, first, 'a distinct directory is a distinct mount here');
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
   * closes with the last activation, and the root is free again after that.
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

  // The last activation released the root: a later mount can construct again.
  const reopened = createOpencodeMount({ storage });
  try { await reopened.transform(sessionId, conversation()); }
  finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One pid no process holds, so a record naming it is a crashed mount's. */
function deadPid(): number {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  };
  for (let pid = 999_999; pid > 999_000; pid -= 1) if (!alive(pid)) return pid;
  throw new Error('no dead pid found for the crash fixture');
}

/** The records one durable root carries (ISSUE-563). */
function recordNames(root: string): string[] {
  return readdirSync(join(root, OPENCODE_MOUNT_DIRECTORY)).filter(name => name.endsWith('.json'));
}

test('ISSUE-563: a live record from another process never refuses this mount', async () => {
  /*
   * The record directory replaced the single-owner claim: a second `opencode
   * --resume` terminal on one root must be allowed, not refused. Both mounts
   * then share the session ledger, whose own write lock serializes the rows.
   */
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(join(root, OPENCODE_MOUNT_DIRECTORY), { recursive: true });
  const foreign = { pid: process.pid, atMs: Date.now(), token: 'the-other-process' };
  const foreignPath = join(root, OPENCODE_MOUNT_DIRECTORY, 'the-other-process.json');
  writeFileSync(foreignPath, JSON.stringify(foreign), 'utf8');
  const mounted: Record<string, unknown>[] = [];
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: root },
    journal: record => { mounted.push(record as unknown as Record<string, unknown>); },
  });
  try {
    await mount.transform(sessionId, conversation());
    const holders = readMountRootHolders(root);
    assert.equal(holders.length, 2, 'both mounts are recorded on the one root');
    assert.deepEqual(JSON.parse(readFileSync(foreignPath, 'utf8')), foreign,
      'the other mount’s record is neither taken nor rewritten');
    const line = mounted.find(record => record['kind'] === 'mounted');
    assert.equal(line?.['mounts'], 2, 'the journal names both live mounts');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-563: a mount records itself and releases only its own record', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: root }, journal: () => {},
  });
  try {
    const names = recordNames(root);
    assert.equal(names.length, 1, 'the mount records itself once');
    const held = JSON.parse(readFileSync(join(root, OPENCODE_MOUNT_DIRECTORY,
      names[0] ?? ''), 'utf8')) as Record<string, unknown>;
    assert.equal(held['pid'], process.pid, 'the record names this process');
    assert.equal(typeof held['token'], 'string', 'the record carries its own release token');
    await mount.transform(sessionId, conversation());
  } finally { await mount.close(); }
  assert.equal(recordNames(root).length, 0, 'the close releases the record');
  // The released root is free: no leftover record blocks the next mount.
  const reopened = createOpencodeMount({ storage: { crematorStorageRoot: root } });
  try {
    await reopened.transform(sessionId, conversation());
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-563: a record whose process is gone is swept, never a wedge', async () => {
  /*
   * A record is evidence of a mount, not a lease: nothing waits on one. A
   * record naming a dead process is a crashed mount's, so the next join sweeps
   * it instead of keeping a phantom mount on the root forever.
   */
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(join(root, OPENCODE_MOUNT_DIRECTORY), { recursive: true });
  const dead = deadPid();
  writeFileSync(join(root, OPENCODE_MOUNT_DIRECTORY, 'crashed.json'),
    JSON.stringify({ pid: dead, atMs: Date.now(), token: 'crashed-mount' }), 'utf8');
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: root }, journal: () => {},
  });
  try {
    const holders = readMountRootHolders(root);
    assert.equal(holders.length, 1, 'the dead record is swept; only this mount remains');
    assert.equal(holders[0]?.pid, process.pid, "the surviving record is this mount's own");
    await mount.transform(sessionId, conversation());
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
