// ISSUE-424: one live apply per durable configuration.
//
// The dsh plugin had no process-level identity either: two `apply` calls over
// one durable root opened two mounts and could open two ledgers for the same
// session. The registry in `plugin.ts` refuses the second apply by name and the
// host's fiber unload frees the key, so a restart after teardown mounts again.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
