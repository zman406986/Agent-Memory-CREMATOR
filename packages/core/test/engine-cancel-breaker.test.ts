// A cancelled pass releases the queue, and the orphaned run keeps reading. The
// fence covers the write seams, but `guard.validate` is not a write: it records
// the outcome on the session's one Guard, and the fenced append right after it
// throws, so that mutation never reaches the journal (ISSUE-489). The breaker
// then disagrees with the durable streak, and a later disable fires one failure
// early or late relative to the record the notice claims.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { Rule } from '../src/rules/types.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import type { SessionSnapshot } from '../src/types/transcript.js';
import { fixture } from './engine-fixtures.js';

/** A plan the guard refuses: its base revision is already stale. */
const badRule: Rule = {
  id: 'bad',
  plan: context => ({ ruleId: 'bad', baseRevision: `${context.snapshot.revision}:stale`,
    removals: [], notes: [], operations: [] }),
};

test('a pass cancelled before validate never mutates the shared breaker (ISSUE-489)', async () => {
  const f = await fixture();
  let released = false;
  let settle: () => void = () => undefined;
  const orphanSettled = new Promise<void>(resolve => { settle = resolve; });
  const options = { ...f.options, rules: [badRule], onTelemetry: (event: TelemetryEvent) => {
    // The orphan's fenced append throws, so its post-cancellation promise is
    // abandoned and only telemetry marks the decision point: the refusal row's
    // emit today, the fence's named cancel after the fix.
    if (released && (event.kind === 'validation' || event.kind === 'error')) settle();
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
  const orphan = engine.process(f.present, controller.signal);
  await orphanStarted;                 // the orphan is hung in its snapshot read
  controller.abort();
  assert.equal((await orphan).status, 'recovery-pending', 'the cancelled pass answers named');

  // Let the orphan finish its reads and reach the fence.
  released = true;
  openGate();
  await orphanSettled;

  // Its refusal never reached the journal, so it must not count: the first real
  // refusal is the first failure of the streak the journal records.
  const firstFailure = await engine.process({ kind: 'at-rest', eventId: 'real-1', reason: 'step' });
  assert.equal(firstFailure.status, 'rejected',
    'one journaled failure is the first, so the breaker is still armed');
  assert.equal(firstFailure.validation?.breaker.consecutiveValidationFailures, 1,
    'the in-memory breaker counts the one journaled failure');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-disabled').length, 0,
    'no disable notice exists after one journaled failure');

  const secondFailure = await engine.process({ kind: 'at-rest', eventId: 'real-2', reason: 'step' });
  assert.equal(secondFailure.status, 'disabled',
    'the second journaled failure trips the breaker, exactly per the record');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-disabled').length, 1);
});