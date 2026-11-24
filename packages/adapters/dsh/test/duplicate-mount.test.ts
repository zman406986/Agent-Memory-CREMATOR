// ISSUE-424 / ISSUE-498 / ISSUE-577: one live mount per durable root, joined.
//
// The dsh plugin had no process-level identity: two `apply` calls over one
// durable root opened two mounts and could open two ledgers for the same
// session. The registry in `plugin.ts` once refused the second apply; ADR-0075
// (owner ruling 2026-11-24) makes a second terminal on one folder supported, so
// the second apply now JOINS the live mount: one `mounted` line, one mount
// object, one ledger and one mount-state writer, and the mount closes only with
// its last holder. The host's fiber unload releases the holder.
// ADR-0066, ported here by ISSUE-498: the key is the durable root alone, so a
// differing knob or a second spelling of one directory is the same mount.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { DshMountContext } from '../src/plugin.js';
import { createRacoonsPlugin } from '../src/plugin.js';

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

/** One journal record, as plain data a test can assert on. */
type Line = Record<string, unknown> & { kind: string };

function journalLines(sink: Line[]): (line: unknown) => void {
  return (line) => { sink.push(line as Line); };
}

test('ISSUE-577: a second apply joins the live mount — one mount, one ledger — '
  + 'and the last release closes it', async () => {
  const dir = scratch();
  const lines: Line[] = [];
  const plugin = createRacoonsPlugin({ storage: { root: join(dir, 'racoons') },
    journal: journalLines(lines) });
  const first = fakeHost();
  const second = fakeHost();
  try {
    await plugin.apply(first.ctx, {});
    await plugin.apply(second.ctx, {});

    // The second apply constructed no mount: one `mounted` line means one
    // mount object, one session map and one ledger — the guard's real intent.
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 1,
      'one mount object, one ledger — the second apply did not build a second');
    const joined = lines.filter(line => line['kind'] === 'mount-shared');
    assert.equal(joined.length, 1, 'the join is journaled by name');
    assert.equal(joined[0]?.['status'], 'reused');
    assert.equal(joined[0]?.['scope'], 'process');
    assert.equal(joined[0]?.['shares'], 2, 'two holders now hold the one mount');

    // The first holder departs; the mount must stay alive for the second.
    await first.close();
    const third = fakeHost();
    await plugin.apply(third.ctx, {});
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 1,
      "the first holder's unload did not close the mount the second still uses");
    assert.equal(lines.filter(line => line['kind'] === 'mount-shared').at(-1)?.['shares'], 2,
      'the third apply joined the same live mount after the first departed');
    await third.close();
    await second.close();
    // The last release closed it: a fresh apply constructs a new mount.
    const fourth = fakeHost();
    await plugin.apply(fourth.ctx, {});
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 2,
      'after the last release a new apply mounts afresh');
    await fourth.close();
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: the same root with a differing knob joins, never a second mount', async () => {
  const dir = scratch();
  const root = join(dir, 'racoons');
  const lines: Line[] = [];
  const plugin = createRacoonsPlugin({ storage: { root }, journal: journalLines(lines) });
  const first = fakeHost();
  const second = fakeHost();
  try {
    await plugin.apply(first.ctx, {});
    // Another bar and another judge deadline: options are not part of the
    // registry key (ADR-0066 decision 3), so this is the same mount.
    await plugin.apply(second.ctx, { barBytes: 2_048, judgeTimeoutMs: 1_000 });
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 1,
      'a differing knob does not make a distinct mount on one root');
    assert.equal(lines.filter(line => line['kind'] === 'mount-shared').length, 1,
      'the differing-knob apply joined and said so');
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: one directory spelled two ways, or in another case, joins; '
  + 'a distinct root mounts on its own', async () => {
  const dir = scratch();
  const root = join(dir, 'racoons');
  mkdirSync(root, { recursive: true });
  const lines: Line[] = [];
  const first = createRacoonsPlugin({ storage: { root }, journal: journalLines(lines) });
  const host = fakeHost();
  const hosts: FakeHost[] = [];
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
    // Measure volume case behaviour with a fresh entry, not with the code under
    // test: a volume that folds case makes the uppercase root the same mount.
    mkdirSync(join(dir, 'case-probe'));
    if (existsSync(join(dir, 'CASE-PROBE'))) variants.push(root.toUpperCase());
    for (const variant of variants) {
      const variantHost = fakeHost();
      hosts.push(variantHost);
      await createRacoonsPlugin({ storage: { root: variant },
        journal: journalLines(lines) }).apply(variantHost.ctx, {});
    }
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 1,
      'every spelling opens the same one mount and ledger');
    assert.equal(lines.filter(line => line['kind'] === 'mount-shared').length,
      variants.length, 'every spelling joined that mount');
    // A genuinely different root is a second mount, never a join.
    const otherHost = fakeHost();
    hosts.push(otherHost);
    await createRacoonsPlugin({ storage: { root: join(dir, 'other') },
      journal: journalLines(lines) }).apply(otherHost.ctx, {});
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 2,
      'a distinct root mounts on its own');
  } finally {
    for (const variantHost of hosts.reverse()) await variantHost.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ISSUE-498: a memory apply is not tracked, so two identical applies coexist', async () => {
  const lines: Line[] = [];
  const first = createRacoonsPlugin({ storage: { databasePath: ':memory:' },
    journal: journalLines(lines) });
  const second = createRacoonsPlugin({ storage: { databasePath: ':memory:' },
    journal: journalLines(lines) });
  const firstHost = fakeHost();
  const secondHost = fakeHost();
  try {
    await first.apply(firstHost.ctx, {});
    await second.apply(secondHost.ctx, {});
    assert.equal(lines.filter(line => line['kind'] === 'mounted').length, 2,
      'a memory root has no durable identity and is never joined');
  } finally {
    await firstHost.close();
    await secondHost.close();
  }
});
