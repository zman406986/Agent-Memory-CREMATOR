// A cancelled pass releases the queue, but the orphaned run must not keep
// mutating the host while a later pass applies (ISSUE-310). The fence is a
// per-pass token checked before each host mutation and ledger append: once the
// pass is cancelled, the orphan's late writes are refused.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { SessionSnapshot } from '../src/types/transcript.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import { fixture } from './engine-fixtures.js';

test('a cancelled pass performs no late host or ledger writes while the next pass runs (ISSUE-310)', async () => {
  const f = await fixture();
  const before = structuredClone(f.port.live);

  // The orphan's run ends either by the fence (an error row) or, unfenced, by
  // its own application telemetry. Whichever arrives first after the gate
  // releases is the orphan settling.
  let released = false;
  let settle: () => void = () => undefined;
  const orphanSettled = new Promise<void>(resolve => { settle = resolve; });
  const options = { ...f.options, onTelemetry: (event: TelemetryEvent) => {
    if (!released) return;
    if (event.kind === 'error' || event.kind === 'application') settle();
  } };
  const engine = await RacoonsEngine.open(options);

  // Hang the orphan in its first snapshot read; later reads are healthy.
  const healthy = f.port.snapshot.bind(f.port);
  let first = true;
  let started: () => void = () => undefined;
  const orphanStarted = new Promise<void>(resolve => { started = resolve; });
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  f.port.snapshot = (): Promise<SessionSnapshot> => {
    if (first) { first = false; started(); return gate.then(() => healthy()); }
    return healthy();
  };

  const controller = new AbortController();
  const orphan = engine.process(f.prune, controller.signal);
  await orphanStarted;                 // the orphan is hung in its snapshot read
  controller.abort();
  assert.equal((await orphan).status, 'recovery-pending', 'the cancelled pass answers named');

  // The next pass runs while the orphan is still hung.
  const next = await engine.process(f.present);
  assert.equal(next.status, 'unchanged', 'the queue is released for the next pass');

  // Let the orphan settle; its late writes must be refused.
  released = true;
  openGate();
  await orphanSettled;

  assert.equal(f.port.requests.length, 0,
    'the orphan never reached the host: no late host-array write');
  assert.deepEqual(f.port.live, before, 'the host array carries no orphan mutation');
  const orphanRows = f.ledger.entries.filter(({ event }) =>
    (event.kind === 'validation' && event.eventId === f.prune.eventId)
    || event.kind === 'applied');
  assert.equal(orphanRows.length, 0, 'the orphan appended no ledger row after cancellation');
});