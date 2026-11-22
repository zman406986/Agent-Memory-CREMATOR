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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

test('setup refuses a second plugin on the same durable configuration', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  const cleanupFirst = await createOpencodePlugin({ storage }).setup(setupHost());
  try {
    await assert.rejects(createOpencodePlugin({ storage }).setup(setupHost()),
      (error: unknown) => error instanceof OpencodeDuplicateMountError
        && error.code === OPENCODE_DUPLICATE_MOUNT_CODE,
      'the second setup is refused by name');
  } finally { await cleanupFirst(); }

  const cleanupAgain = await createOpencodePlugin({ storage }).setup(setupHost());
  try {
    assert.equal(typeof cleanupAgain, 'function');
  } finally {
    await cleanupAgain();
    rmSync(dir, { recursive: true, force: true });
  }
});
