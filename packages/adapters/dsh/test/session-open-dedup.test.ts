// ISSUE-500: one first open per session id, however many boundaries arrive.
//
// `sessionFor` checked the session map, awaited the ledger open and only then
// populated the map, so two concurrent first-use boundaries for one id (a
// direct `runPrune` overlapping a first `runStep`) both opened a ledger and the
// second `sessions.set` orphaned the first entry. The mount now shares one
// in-flight open per id. Offline test: a fake session, the real mount, no host.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DshMountSession } from '../src/plugin.js';
import {
  RacoonsStorageRetryError, createRacoonsMount, resolvePluginConfig, resolveStorage,
} from '../src/plugin.js';
import { openLedger } from '../src/storage.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-dsh-open-'));
}

/** A session the open path reads but never appends through. */
function fakeSession(id: string): DshMountSession {
  return { id, append: () => { throw new Error('these tests never append'); } };
}

test('ISSUE-500: two concurrent first-use boundaries open one ledger and serve one entry', async () => {
  const opens: string[] = [];
  let release!: () => void;
  const parked = new Promise<void>((resolve) => { release = resolve; });
  const mount = createRacoonsMount({
    config: resolvePluginConfig({}),
    storage: resolveStorage(undefined),
    // The host ledger seam is the open's await: both boundaries park here.
    openLedger: async (sessionId) => {
      opens.push(sessionId);
      await parked;
      return openLedger(resolveStorage(undefined), { nowMs: () => Date.now() });
    },
    journal: () => {},
  });
  const session = fakeSession('session-500');
  try {
    const first = mount.sessionFor(session.id, session);
    const second = mount.sessionFor(session.id, session);
    // Let both boundaries reach the parked open before releasing it.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(opens.length, 1, 'one first open, never two on one ledger');
    assert.equal(a, b, 'both boundaries are served the same entry');
    assert.equal(mount.sessions.get(session.id), a,
      'the map serves the entry the boundaries hold');
    assert.equal(mount.sessions.size, 1, 'the second set never orphaned a first entry');
    // A later sequential use is the cached entry, not a reopen.
    assert.equal(await mount.sessionFor(session.id, session), a);
    assert.equal(opens.length, 1, 'the cached entry opens nothing');
  } finally {
    await mount.close();
  }
});

test('ISSUE-500: a retryable open failure throws before any entry is installed', async () => {
  const dir = scratch();
  const blockedRoot = join(dir, 'not-a-directory');
  // A file where the root must be: the durable open fails inside the adapter.
  writeFileSync(blockedRoot, 'not a directory', 'utf8');
  const lines: { kind: string; [field: string]: unknown }[] = [];
  const mount = createRacoonsMount({
    config: resolvePluginConfig({}),
    storage: resolveStorage({ root: blockedRoot }),
    journal: (record) => { lines.push(record); },
  });
  const session = fakeSession('session-500-retry');
  try {
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError,
      'the first failure is the retryable refusal, not an installed entry');
    assert.equal(mount.sessions.size, 0, 'no half-built entry became visible');
    assert.equal(lines.filter(line => line.kind === 'storage-retry').length, 1,
      'the transient failure is named');
    // The retry at the next boundary runs its own open and installs the
    // refusing ledger once the second failure is final.
    await mount.sessionFor(session.id, session);
    assert.equal(mount.sessions.size, 1, 'the retry installs one entry');
    assert.equal(lines.filter(line => line.kind === 'storage-unavailable').length, 1,
      'the final refusal is named once');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
