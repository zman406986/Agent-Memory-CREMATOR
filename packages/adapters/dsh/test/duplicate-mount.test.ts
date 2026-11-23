// ISSUE-424 / ISSUE-444 / ISSUE-498: one live apply per durable root.
//
// The dsh plugin had no process-level identity either: two `apply` calls over
// one durable root opened two mounts and could open two ledgers for the same
// session. The registry in `plugin.ts` refuses the second apply by name and the
// host's fiber unload frees the key, so a restart after teardown mounts again.
// ADR-0066, ported here by ISSUE-498: the key is the durable root alone, so a
// differing knob or a second spelling of one directory is the same mount.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { DshMountContext } from '../src/plugin.js';
import {
  CREMATOR_DUPLICATE_MOUNT_CODE, RacoonsDuplicateMountError, createRacoonsPlugin,
} from '../src/plugin.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-dsh-duplicate-'));
}

interface FakeHost {
  readonly ctx: DshMountContext;
  close(): Promise<void>;
}

/** The seams `apply` touches: warn, on, effect. No live session is needed to apply. */
function fakeHost(): FakeHost {
  const cleanups: (() => unknown)[] = [];
  const ctx = {
    logger: { warn: () => {} },
    on: () => () => {},
    effect: (register: () => unknown) => {
      const disposer = register();
      if (typeof disposer === 'function') cleanups.push(disposer as () => unknown);
    },
  } as unknown as DshMountContext;
  return {
    ctx,
    close: async () => {
      for (const disposer of [...cleanups].reverse()) await disposer();
      cleanups.length = 0;
    },
  };
}

test('a second apply on one durable configuration is refused, and unload frees it', async () => {
  const dir = scratch();
  const plugin = createRacoonsPlugin({ storage: { root: join(dir, 'racoons') } });

  const first = fakeHost();
  await plugin.apply(first.ctx, {});
  try {
    await assert.rejects(plugin.apply(fakeHost().ctx, {}), (error: unknown) =>
      error instanceof RacoonsDuplicateMountError
        && error.code === CREMATOR_DUPLICATE_MOUNT_CODE,
    'the second apply is refused by name');
  } finally { await first.close(); }

  const third = fakeHost();
  try {
    await plugin.apply(third.ctx, {});
  } finally {
    await third.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: the same root with a differing knob is refused, never a second mount', async () => {
  const dir = scratch();
  const root = join(dir, 'racoons');
  const mounted: Record<string, unknown>[] = [];
  const plugin = createRacoonsPlugin({ storage: { root },
    journal: (record) => { mounted.push(record as unknown as Record<string, unknown>); } });
  const first = fakeHost();
  await plugin.apply(first.ctx, {});
  try {
    // The refused apply names another bar and another judge deadline: options
    // are not part of the registry key (ADR-0066 decision 3), because the
    // ledger path a mount derives is unchanged by them.
    await assert.rejects(plugin.apply(fakeHost().ctx, { barBytes: 2_048, judgeTimeoutMs: 1_000 }),
      (error: unknown) => error instanceof RacoonsDuplicateMountError
        && error.code === CREMATOR_DUPLICATE_MOUNT_CODE && error.key === root,
      'a differing knob does not make a distinct mount on one root');
    assert.equal(mounted.filter(line => line['kind'] === 'mounted').length, 1,
      'the refused apply constructed no second mount and no second ledger');
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: one directory spelled two ways is refused, never a second mount', async () => {
  const dir = scratch();
  const root = join(dir, 'racoons');
  const first = createRacoonsPlugin({ storage: { root } });
  const host = fakeHost();
  await first.apply(host.ctx, {});
  try {
    // `join` downstream collapses every one of these onto the same session
    // directory, so each spelling names the ledger the first apply claimed.
    const variants = [root + sep, root + sep + '.', root + sep + 'sub' + sep + '..'];
    if (process.platform === 'win32') {
      // Windows trims a trailing dot or space per component, and the
      // extended-length prefix names the same directory (ISSUE-464/ISSUE-481).
      variants.push(root + '.', root + ' ', '\\\\?\\' + root);
    }
    for (const variant of variants) {
      await assert.rejects(
        createRacoonsPlugin({ storage: { root: variant } }).apply(fakeHost().ctx, {}),
        (error: unknown) => error instanceof RacoonsDuplicateMountError
          && error.code === CREMATOR_DUPLICATE_MOUNT_CODE && error.key === variant,
        'the ' + JSON.stringify(variant) + ' spelling opens the same ledger');
    }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: a memory apply is not tracked, so two identical applies coexist', async () => {
  const first = createRacoonsPlugin({ storage: { databasePath: ':memory:' } });
  const second = createRacoonsPlugin({ storage: { databasePath: ':memory:' } });
  const firstHost = fakeHost();
  const secondHost = fakeHost();
  try {
    await first.apply(firstHost.ctx, {});
    await second.apply(secondHost.ctx, {});
  } finally {
    await firstHost.close();
    await secondHost.close();
  }
});test('ISSUE-498: case-differing roots follow the volume; distinct roots coexist', async () => {
  const dir = scratch();
  const root = join(dir, 'store');
  mkdirSync(root, { recursive: true });
  // Measure volume behaviour with a fresh entry, not with the code under test.
  mkdirSync(join(dir, 'case-probe'));
  const foldsCase = existsSync(join(dir, 'CASE-PROBE'));
  const first = createRacoonsPlugin({ storage: { root } });
  const firstHost = fakeHost();
  await first.apply(firstHost.ctx, {});
  const other = createRacoonsPlugin({ storage: { root: join(dir, 'other') } });
  const otherHost = fakeHost();
  try {
    if (foldsCase) {
      await assert.rejects(
        createRacoonsPlugin({ storage: { root: root.toUpperCase() } }).apply(fakeHost().ctx, {}),
        (error: unknown) => error instanceof RacoonsDuplicateMountError
          && error.key === root.toUpperCase(),
        'the volume folds case, so the uppercase root names the same ledger');
    }
    // A genuinely different root is a second mount, never a refusal.
    await other.apply(otherHost.ctx, {});
  } finally {
    await otherHost.close();
    await firstHost.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
