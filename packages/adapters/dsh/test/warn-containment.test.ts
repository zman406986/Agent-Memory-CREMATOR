// ISSUE-442: every mount `options.warn` call rides `safeWarn`, so a throwing
// sink can never change a storage or recovery outcome. Before the fix the
// storage-retry warn could replace the thrown `RacoonsStorageRetryError` (and
// the retry counter had already advanced), and the mark-read catch's warn
// escaped into the outer recovery catch and skipped the `appends` leg.
//
// No cap, no timeout (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  DshMountEvent, DshMountSession, RacoonsApplicationRequest,
} from '../src/plugin.js';
import {
  RacoonsStorageRetryError, createRacoonsMount, resolvePluginConfig,
} from '../src/plugin.js';
import { resolveStorage } from '../src/storage.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
}

/** A minimal fake dsh Session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const session: FakeSession = {
    id,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error('surface replace out of range');
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp } });
      log.push(event);
      return event;
    },
  };
  return session;
}

/** One committed append the mount has not published yet (the ISSUE-342 queue). */
function owedAppend(recordId: string, text: string): RacoonsApplicationRequest {
  return { application: { mode: 'append', appendRecords: [
    { recordId, bytes: new TextEncoder().encode(text) }] } } as unknown as RacoonsApplicationRequest;
}

/** The number of this package's records the host surface holds. */
function recordCount(session: FakeSession, recordId: string): number {
  let count = 0;
  for (const seq of session.surface?.nodes ?? []) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'user/message') continue;
    const source = (event.data as { source?: { kind?: string; recordId?: string } }).source;
    if (source?.kind === 'racoons/negation' && source.recordId === recordId) count += 1;
  }
  return count;
}

type Line = { kind: string; [field: string]: unknown };

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

test('ISSUE-442: a throwing warn cannot alter the storage retry budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-warn-retry-'));
  // A FILE where the storage root expects a directory: every open fails.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const root = join(blocker, 'racoons');
  const lines: Line[] = [];
  let warns = 0;
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ crematorStorageRoot: root }),
    storage: resolveStorage({ root }, root),
    journal: (record) => lines.push(record),
    warn: () => { warns += 1; throw new Error('the warn sink throws'); },
  });
  try {
    const session = fakeSession('session-442-retry');
    // The warn throws, but the named retry error must still reach the caller.
    await assert.rejects(mount.sessionFor(session.id, session),
      (error: unknown) => error instanceof RacoonsStorageRetryError,
      'the retry error is thrown unchanged, never replaced by the warn');
    assert.equal(lines.filter((line) => line.kind === 'storage-retry').length, 1,
      'the first failure is the one named retry');

    // The budget is unchanged: the SECOND failure refuses, exactly as it does
    // with a healthy warn sink.
    const entry = await mount.sessionFor(session.id, session);
    assert.ok(entry.ledger !== undefined, 'the second attempt installs the refusing ledger');
    const unavailable = lines.filter((line) => line.kind === 'storage-unavailable');
    assert.equal(unavailable.length, 1, 'the retry budget was spent by opens, not by the warn');
    assert.equal(lines.filter((line) => line.kind === 'storage-retry').length, 1,
      'no second retry line was written');
    assert.equal(warns, 1, 'the throwing warn was contained after one attempt');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});

test('ISSUE-442: a throwing warn cannot skip the recovery appends leg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-warn-appends-'));
  const root = join(dir, 'racoons');
  const lines: Line[] = [];
  let warns = 0;
  const mount = createRacoonsMount({
    config: resolvePluginConfig({ crematorStorageRoot: root }),
    storage: resolveStorage({ root }, root),
    journal: (record) => lines.push(record),
    warn: () => { warns += 1; throw new Error('the warn sink throws'); },
  });
  try {
    const session = fakeSession('session-442-appends');
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    const entry = await mount.sessionFor(session.id, session);

    // A committed append intent the previous process persisted, then died
    // before the flush (ISSUE-374): the reopened entry owes the replay.
    entry.pendingAppends.push(owedAppend('rec-442-1', 'owed record'));
    entry.persistPendingAppends?.();
    entry.pendingAppends.length = 0;

    // The ledger-derived marks read throws; its warn throws too. The appends
    // leg after it must still run.
    entry.ledger.events = (() => { throw new Error('mark read failed'); }) as never;
    entry.resumeRecovery = true;

    await mount.runStep(session, { turn: 1, step: 1 });

    assert.equal(warns, 1, 'the mark-read warn was attempted and contained');
    assert.equal(lines.filter((line) => line.kind === 'entry-recovery-mark-error').length, 1,
      'the named mark-read failure is journaled');
    const recovered = lines.filter((line) => line.kind === 'entry-resume-recovered');
    assert.equal(recovered.length, 1, 'recovery still completed its appends leg');
    assert.equal(recovered[0]?.['appends'], 1, 'the owed record was re-queued');
    assert.equal(recordCount(session, 'rec-442-1'), 1,
      'the owed append was published at the boundary');
  } finally {
    await mount.close();
    cleanup(dir);
  }
});
