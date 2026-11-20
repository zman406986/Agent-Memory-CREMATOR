import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshPort } from '../src/port.js';
import { applicationRequest, clock, record, toolResult, unchanged } from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

/**
 * What the port must NOT write: a delivery is the host's write (land-first), a
 * retried delivery answers from the transcript instead of capturing again, and
 * an application append leaves the host's own envelopes untouched. One row per
 * rule, so a red run names the seam it broke.
 */
const ROWS: readonly Row[] = [
  { name: 'a delivered result is never inserted by the port: landing is the host\'s write',
    async run(at) {
      const original = toolResult();
      const port = createDshPort({ sessionId: 'session-1', clock });
      await port.deliverToolResult('event-1', original, async () => unchanged);
      // Land-first (ISSUE-058 chunk P3a; ADR-0022 §2): the port holds no pending
      // entry and writes nothing on the way in. A host whose surface already holds
      // the result is the normal case, so the transcript stays as delivered.
      assert.deepEqual(port.transcript(), [], at('an empty port stays empty'));
      const again = createDshPort({ sessionId: 'session-1', clock, transcript: [original] });
      await again.deliverToolResult('event-1', original, async node => {
        assert.deepEqual(node.bytes, original.bytes, at('the node carries the result bytes'));
        return unchanged;
      });
      assert.deepEqual(again.transcript(), [original], at('a held transcript is left as is'));
    } },
  { name: 'a retried delivery answers from the transcript, so one capture is one decision',
    async run(at) {
      const original = toolResult();
      const port = createDshPort({ sessionId: 'session-1', clock, transcript: [original] });
      const seen: string[] = [];
      const first = await port.deliverToolResult('event-1', original, async node => {
        seen.push(node.id);
        return unchanged;
      });
      assert.deepEqual(first, unchanged, at('the first delivery answers the engine result'));
      // The same event delivered twice (a host retry) hands the same node on and
      // writes nothing new; an identity change under one event id is refused.
      await port.deliverToolResult('event-1', original, async node => {
        seen.push(node.id);
        return { ...unchanged, status: 'recovery-pending' };
      });
      assert.deepEqual(seen, [original.id, original.id],
        at('both deliveries see the same node id'));
      await assert.rejects(port.deliverToolResult('event-1', toolResult('other-result'),
        async () => unchanged), /Repeated entry identity changed/u,
      at('a changed identity under one event id is refused by name'));
      assert.deepEqual(port.transcript(), [original], at('the transcript is unchanged'));
    } },
  { name: 'M1 append leaves opaque host resume markers and all existing envelopes untouched',
    async run(at) {
      const boundary = { id: 'native-boundary', role: 'system' as const,
        bytes: new Uint8Array([0, 255, 13, 10]), turnOrdinal: 0, stepOrdinal: 0,
        nativeState: { successfulResume: true, opaque: ['host-owned'] } };
      const initial = [boundary, toolResult()];
      const port = createDshPort({ sessionId: 'session-1', clock, transcript: initial });
      const request = applicationRequest((await port.snapshot()).revision,
        { appendRecords: [record()] });
      assert.equal((await port.apply(request)).status, 'applied', at('the append applied'));
      assert.deepEqual(port.transcript().slice(0, 2), initial,
        at('the host\'s own envelopes are untouched and keep their place'));
    } },
];

test('the port lands nothing of its own, answers a retry, and appends behind the host',
  async () => {
    await runRows(ROWS);
  });
