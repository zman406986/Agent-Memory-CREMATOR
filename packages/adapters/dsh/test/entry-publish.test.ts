// ISSUE-441: an entry publish that throws is a durable-write failure
// (ADR-0065). It is named in the journal, stays queued, and is retried at the
// next boundary instead of being dropped while the ledger claims applied.
// No cap, no retry count, no timeout (standing rule 7 / ADR-0060).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  DshMountEvent, DshMountSession, RacoonsApplicationRequest,
} from '../src/plugin.js';
import {
  createRacoonsMount, resolvePluginConfig, resolveSessionStorage,
} from '../src/plugin.js';
import { readPendingEntryPublishes } from '../src/prune-round-store.js';
import { resolveStorage } from '../src/storage.js';

interface FakeSession extends DshMountSession {
  readonly log: DshMountEvent[];
  /** When true, the host refuses this package's surface replacement. */
  refuseReplaces: boolean;
}

/** A minimal fake dsh Session: an append-only log with surface markers. */
function fakeSession(id: string): FakeSession {
  const log: DshMountEvent[] = [];
  const surfaceNodes: number[] = [];
  const session: FakeSession = {
    id,
    refuseReplaces: false,
    get seq() { return log.length; },
    get surface() { return { nodes: surfaceNodes, contentGeneration: log.length }; },
    get log() { return log; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options['surfaceOp'];
      if (session.refuseReplaces && typeof surfaceOp === 'object') {
        throw new Error('the host surface refused the replace');
      }
      if (surfaceOp === 'append') surfaceNodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error('surface replace out of range');
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options['sourceEventSeqs'];
      const event: DshMountEvent = Object.freeze({ type, seq,
        data: Object.freeze(structuredClone(data)),
        ...surfaceOp === undefined ? {} : { surfaceOp },
        ...sourceEventSeqs === undefined ? {}
          : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) } });
      log.push(event);
      return event;
    },
  };
  return session;
}

type Line = { kind: string; [field: string]: unknown };

/** The text the live tool result holds on the surface. */
function surfaceText(session: FakeSession): string {
  const seq = (session.surface?.nodes ?? [])[0];
  const data = session.eventAt?.(seq ?? -1)?.data as
    { message?: { content?: { text?: string }[] } } | undefined;
  return data?.message?.content?.[0]?.text ?? '';
}

test('ISSUE-441: a failed entry publish is named, stays queued, and is retried', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-441-publish');
    const original = 'ORIGINAL RESULT BODY';
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read',
      arguments: '{"file_path":"big.txt"}' });
    const resultEvent = session.append('tool/result', { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: original }], isError: false, id: 'result-c1' } },
    { surfaceOp: 'append' });
    const item = mount.observe(session, resultEvent);
    assert.ok(item !== null, 'the result is observable');
    const entry = await mount.sessionFor(session.id, session);

    const request = { intent: { intentId: 'intent-441' },
      application: { eventId: item.id, mode: 'entry', replacements: [{
        source: { nodeId: item.id, byteLength: original.length },
        bytes: new TextEncoder().encode('[not retained] big.txt · necromancy recall:sha256:00'),
        generatedRanges: [], retainedCopies: [], evidenceRecallId: null }],
      appendRecords: [], archives: [], sealedEpisodeIds: [], applicationSha256: 'sha' } } as unknown as RacoonsApplicationRequest;
    const capture = { eventId: item.id, item, seq: resultEvent.seq };

    // The host surface refuses the write once: `publishEntry`'s append throws.
    const originalAppend = session.append.bind(session);
    let refuses = true;
    session.append = (type: string, data: unknown, options: Record<string, unknown> = {}) => {
      if (refuses && typeof options['surfaceOp'] === 'object') {
        refuses = false;
        throw new Error('the host surface refused the replace');
      }
      return originalAppend(type, data, options);
    };

    assert.doesNotThrow(() => mount.publishEntryApplications(session, entry, [
      { request, capture }]), 'the failure never throws into the host hook');
    const failed = lines.filter((line) => line.kind === 'entry-publish-failed');
    assert.equal(failed.length, 1, 'one named publish failure');
    assert.equal(failed[0]?.['callId'], 'c1', 'the line names the call id');
    assert.equal(failed[0]?.['eventId'], item.id, 'the line names the node');
    assert.equal(entry.pendingEntryPublishes.length, 1,
      'the failed request is never dropped');
    assert.equal(surfaceText(session), original, 'the surface still holds the original bytes');

    // The next boundary retries the same queue head; the surface catches up.
    assert.doesNotThrow(() => mount.publishEntryApplications(session, entry, []));
    assert.equal(entry.pendingEntryPublishes.length, 0, 'the publish landed once');
    assert.match(surfaceText(session), /^\[not retained\] big\.txt/u,
      'the surface and the ledger now agree');
    assert.equal(lines.filter((line) => line.kind === 'entry-publish-failed').length, 1,
      'no second failure line for the retried request');
  } finally {
    await mount.close();
  }
});

test('ISSUE-449: a node-missing publish is named once and removed from the head', async () => {
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage(undefined), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-449-dead-head');
    // Two results on the surface: c1 is the one the host trims before the
    // publish, c2 is the application queued behind it.
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    const resultEvent = (callId: string, text: string) => session.append('tool/result',
      { turn: 1, step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
          content: [{ type: 'text', text }], isError: false, id: `result-${callId}` } },
      { surfaceOp: 'append' });
    const first = resultEvent('c1', 'ORIGINAL ONE');
    const second = resultEvent('c2', 'ORIGINAL TWO');
    const item1 = mount.observe(session, first);
    const item2 = mount.observe(session, second);
    assert.ok(item1 !== null && item2 !== null, 'both results are observable');
    const entry = await mount.sessionFor(session.id, session);

    const application = (item: NonNullable<typeof item1>, callId: string, text: string) => {
      const request = { intent: { intentId: `intent-449-${callId}` },
        application: { eventId: item.id, mode: 'entry', replacements: [{
          source: { nodeId: item.id, byteLength: 1 },
          bytes: new TextEncoder().encode(text),
          generatedRanges: [], retainedCopies: [], evidenceRecallId: null }],
        appendRecords: [], archives: [], sealedEpisodeIds: [],
        applicationSha256: 'sha' } } as unknown as RacoonsApplicationRequest;
      return { request, capture: { eventId: item.id, item, seq: 0 } };
    };

    // The host trims c1's node from the surface after the replacement was
    // committed: the node can never be republished.
    const nodes = (session.surface?.nodes ?? []) as number[];
    nodes.splice(nodes.indexOf(first.seq), 1);

    assert.doesNotThrow(() => mount.publishEntryApplications(session, entry, [
      application(item1, 'c1', '[not retained] one'),
      application(item2, 'c2', '[not retained] two'),
    ]));

    const dropped = lines.filter((line) => line.kind === 'entry-publish-dropped');
    assert.equal(dropped.length, 1, 'the dead node is named once');
    assert.equal(dropped[0]?.['callId'], 'c1');
    assert.equal(dropped[0]?.['reason'], 'no-live-result');
    assert.equal(entry.pendingEntryPublishes.length, 0,
      'the dead head was removed, and c2 published behind it');
    assert.equal(surfaceText(session), '[not retained] two',
      'the later application landed on the surface');
  } finally {
    await mount.close();
  }
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-entry-publish-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

test('ISSUE-450: a queued entry publish is named at release and replayed on reopen', async () => {
  const root = scratch();
  const lines: Line[] = [];
  const mount = createRacoonsMount({ config: resolvePluginConfig({}),
    storage: resolveStorage({ root }), journal: (record) => lines.push(record) });
  try {
    const session = fakeSession('session-450-release');
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    const resultEvent = session.append('tool/result', { turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
        content: [{ type: 'text', text: 'ORIGINAL BODY' }], isError: false, id: 'result-c1' } },
    { surfaceOp: 'append' });
    const item = mount.observe(session, resultEvent);
    assert.ok(item !== null, 'the result is observable');
    const entry = await mount.sessionFor(session.id, session);
    const target = resolveSessionStorage(root, session.id);

    const request = { intent: { intentId: 'intent-450' },
      application: { eventId: item.id, mode: 'entry', replacements: [{
        source: { nodeId: item.id, byteLength: 1 },
        bytes: new TextEncoder().encode('[not retained] big.txt'),
        generatedRanges: [], retainedCopies: [], evidenceRecallId: null }],
      appendRecords: [], archives: [], sealedEpisodeIds: [],
      applicationSha256: 'sha' } } as unknown as RacoonsApplicationRequest;

    // The host refuses the replace: the request stays queued and durable.
    session.refuseReplaces = true;
    mount.publishEntryApplications(session, entry,
      [{ request, capture: { eventId: item.id, item, seq: resultEvent.seq } }]);
    assert.equal(lines.filter((line) => line.kind === 'entry-publish-failed').length, 1,
      'the transient failure is named');
    assert.equal(readPendingEntryPublishes(target).length, 1,
      'the queue is durable before the release');

    await mount.endSession(session);
    const abandoned = lines.filter((line) => line.kind === 'entry-publish-abandoned');
    assert.equal(abandoned.length, 1, 'the release names the replacement it still owes');
    assert.equal(abandoned[0]?.['pending'], 1);
    assert.equal(abandoned[0]?.['durable'], true);
    assert.equal(abandoned[0]?.['reason'], 'session/end');
    assert.equal(mount.sessions.has(session.id), false, 'the entry released');
    assert.equal(readPendingEntryPublishes(target).length, 1,
      'the durable intent survived the release');

    // Reopen with the host accepting the write: the first boundary replays it.
    session.refuseReplaces = false;
    await mount.runStep(session, { turn: 1, step: 1 });
    assert.match(surfaceText(session), /^\[not retained\]/u,
      'the replacement landed on the reopened surface');
    assert.equal(readPendingEntryPublishes(target).length, 0,
      'a drained replay clears the durable intent');
    assert.equal(lines.filter((line) => line.kind === 'entry-publish-abandoned').length, 1,
      'only the release named the abandonment');
    const recovered = lines.find((line) => line.kind === 'entry-resume-recovered');
    assert.equal(recovered?.['entryPublishes'], 1,
      'recovery replayed one entry publish');
  } finally {
    await mount.close();
    cleanup(root);
  }
});
