import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { EngineInput } from '../src/engine/types.js';
import type { SessionSnapshot } from '../src/types/transcript.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import type { Rule } from '../src/rules/types.js';
import { fixture } from './engine-fixtures.js';
import { MemoryBlobStore } from '../src/ledger/memory-blob-store.js';
import { SqliteLedger } from '../src/ledger/sqlite-ledger.js';

const badRule: Rule = {
  id: 'bad', plan: context => ({ ruleId: 'bad', baseRevision: `${context.snapshot.revision}:stale`,
    removals: [], notes: [], operations: [] }),
};

test('one bad plan rejects the pass and applies nothing', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open({ ...f.options, rules: [...f.options.rules, badRule] });
  const outcome = await engine.process(f.present);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.validation?.ok, false);
  assert.equal(f.port.requests.length, 0);
  assert.equal(f.ledger.recalls.size, 0);
});

test('two validation failures quiet one ask, never the run, and keep recall available', async () => {
  const f = await fixture();
  const first = await RacoonsEngine.open(f.options);
  await first.process(f.present);
  assert.equal((await first.process(f.prune)).status, 'applied');
  const recallId = [...f.ledger.recalls.keys()][0];
  assert.ok(recallId);
  const options = { ...f.options, rules: [badRule] };
  const engine = await RacoonsEngine.open(options);
  assert.equal((await engine.process({ kind: 'at-rest', eventId: 'bad-1', reason: 'step' })).status, 'rejected');
  const reopened = await RacoonsEngine.open(options);
  assert.equal((await reopened.process({ kind: 'at-rest', eventId: 'bad-2', reason: 'step' })).status, 'disabled');
  assert.deepEqual((await reopened.recall(recallId)).parts[0]?.bytes, f.first.bytes);
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-disabled').length, 1);
  // The next boundary is live again: a completed validation re-enables gating
  // (ISSUE-057 defect 2). The disable lasted one ask, not the session.
  const recovered = await RacoonsEngine.open(f.options);
  assert.notEqual((await recovered.process({ kind: 'at-rest', eventId: 'after-disable', reason: 'step' })).status,
    'disabled');
});

test('unknown apply blocks the next process call until host outcome is known', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  f.port.outcome = 'unknown';
  f.port.lookup = 'unknown';
  assert.equal((await engine.process(f.prune)).status, 'recovery-pending');
  assert.equal((await engine.process({ ...f.prune, eventId: 'next' })).status, 'recovery-pending');
  assert.equal(f.port.requests.length, 1);
  f.port.lookup = 'not-applied';
  assert.equal((await engine.process(f.prune)).status, 'unchanged');
  assert.equal(f.port.requests.length, 1);
});

test('same event is idempotent in one engine, concurrently, and after reopen', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  const outcomes = await Promise.all([engine.process(f.prune), engine.process(f.prune)]);
  assert.equal(outcomes[0]?.intentId, outcomes[1]?.intentId);
  assert.equal((await (await RacoonsEngine.open(f.options)).process(f.prune)).status, 'applied');
  assert.equal(f.port.requests.length, 1);
});

test('archive failure never calls the host; missing receipt write enters recovery', async () => {
  const f = await fixture();
  f.ledger.failPrepare = true;
  const first = await RacoonsEngine.open(f.options);
  await first.process(f.present);
  assert.equal((await first.process(f.prune)).status, 'recovery-pending');
  assert.equal(f.port.requests.length, 0);
  const second = await fixture();
  second.ledger.failApplied = true;
  const engine = await RacoonsEngine.open(second.options);
  await engine.process(second.present);
  assert.equal((await engine.process(second.prune)).status, 'recovery-pending');
  second.ledger.failApplied = false;
  assert.equal((await engine.process(second.prune)).status, 'applied');
  assert.equal(second.port.requests.length, 1);
});

test('no plans returns unchanged', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open({ ...f.options, rules: [] });
  assert.equal((await engine.process(f.present)).status, 'unchanged');
  assert.equal(f.port.requests.length, 0);
});

test('a malformed event is refused by code and the next pass still applies', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  const malformed = { kind: 'prune', eventId: 'malformed-1', round: 1,
    verdicts: null, window: 200_000 } as unknown as EngineInput;
  const refused = await engine.process(malformed);
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.validation?.ok, false);
  assert.equal(refused.validation?.issues[0]?.code, 'invalid-plan');
  const row = f.ledger.entries.find(({ event }) => event.kind === 'validation'
    && event.eventId === 'malformed-1')?.event;
  assert.ok(row?.kind === 'validation', 'the malformed event appends one validation row');
  assert.equal(row.issues[0]?.code, 'invalid-plan');
  assert.equal((await engine.process(f.prune)).status, 'applied',
    'the malformed event did not permanently fault the engine');
});

test('an unknown event kind is refused by code, never skipped as no-plan', async () => {
  const f = await fixture();
  const events: TelemetryEvent[] = [];
  const engine = await RacoonsEngine.open({ ...f.options,
    onTelemetry: event => events.push(event) });
  const unknown = { kind: 'mystery', eventId: 'unknown-kind' } as unknown as EngineInput;
  const refused = await engine.process(unknown);
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.validation?.ok, false);
  assert.equal(refused.validation?.issues[0]?.code, 'invalid-event');
  const rows = (): number => f.ledger.entries.filter(({ event }) =>
    event.kind === 'validation' && event.eventId === 'unknown-kind').length;
  assert.equal(rows(), 1, 'the unknown kind appends one validation row');
  const row = f.ledger.entries.find(({ event }) => event.kind === 'validation'
    && event.eventId === 'unknown-kind')?.event;
  assert.ok(row?.kind === 'validation');
  assert.equal(row.issues[0]?.code, 'invalid-event');
  assert.equal(events.some(event => event.kind === 'skip' && event.eventId === 'unknown-kind'),
    false, 'an unknown kind never falls through to skip/no-plan');
  const retried = await engine.process(unknown);
  assert.equal(retried.status, 'rejected', 'the retry is stable');
  assert.equal(retried.validation?.ok, false);
  assert.equal(retried.validation?.issues[0]?.code, 'invalid-event');
  assert.equal(rows(), 1, 'the retry reuses the one validation row');
  assert.notEqual((await engine.process({ kind: 'at-rest', eventId: 'after-unknown',
    reason: 'step' })).status, 'recovery-pending', 'the next pass still runs');
});

test('a timed-out or aborted pass releases the queue for later passes', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  const healthy = f.port.snapshot.bind(f.port);
  let hang = true;
  f.port.snapshot = async (): Promise<SessionSnapshot> => hang
    ? new Promise<never>(() => undefined) : healthy();
  const timed = await engine.process({ kind: 'at-rest', eventId: 'hung', reason: 'step' }, 20);
  assert.equal(timed.status, 'recovery-pending', 'a timed-out pass answers a named result');
  hang = false;
  assert.equal((await engine.process({ kind: 'at-rest', eventId: 'after-timeout',
    reason: 'step' })).status, 'unchanged', 'the queue is released after a timeout');
  const healthyAgain = f.port.snapshot.bind(f.port);
  let hangAgain = true;
  f.port.snapshot = async (): Promise<SessionSnapshot> => hangAgain
    ? new Promise<never>(() => undefined) : healthyAgain();
  const controller = new AbortController();
  const aborted = engine.process({ kind: 'at-rest', eventId: 'aborted', reason: 'step' },
    controller.signal);
  controller.abort();
  assert.equal((await aborted).status, 'recovery-pending', 'an aborted pass answers a named result');
  hangAgain = false;
  assert.equal((await engine.process({ kind: 'at-rest', eventId: 'after-abort',
    reason: 'step' })).status, 'unchanged', 'the queue is released after an abort');
});

test('the breaker-disabled notice lands inside a single-turn record', async () => {
  const f = await fixture();
  // One turn throughout: the bench shape the notice used to starve in.
  assert.equal(f.port.live.currentTurnOrdinal, 2);
  const engine = await RacoonsEngine.open({ ...f.options, rules: [badRule] });
  await engine.process({ kind: 'at-rest', eventId: 'bad-1', reason: 'step' });
  await engine.process({ kind: 'at-rest', eventId: 'bad-2', reason: 'step' });
  // The next boundary announces: no turn advance is required (ISSUE-057 defect 3).
  await engine.process({ kind: 'at-rest', eventId: 'notice', reason: 'step' });
  const notices = f.port.live.nodes.filter(node => node.kind === 'racoons-record'
    && node.recordId === 'racoons:breaker-disabled:session-1');
  assert.equal(notices.length, 1);
  const only = notices[0];
  assert.ok(only?.kind === 'racoons-record');
  assert.equal(only.turnOrdinal, f.port.live.currentTurnOrdinal,
    'the notice is appended in the turn that tripped the breaker');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-announced').length, 1);
  // One notice per disable: a further pass appends nothing more.
  await engine.process({ kind: 'at-rest', eventId: 'notice-again', reason: 'step' });
  assert.equal(f.port.live.nodes.filter(node => node.kind === 'racoons-record'
    && node.recordId === 'racoons:breaker-disabled:session-1').length, 1);
});

test('not-applied leaves the transcript untouched and is not replayed after reopen', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);
  const before = structuredClone(f.port.live);
  f.port.outcome = 'not-applied';
  assert.equal((await engine.process(f.prune)).status, 'unchanged');
  assert.deepEqual(f.port.live, before);
  await (await RacoonsEngine.open(f.options)).process(f.prune);
  assert.equal(f.port.requests.length, 1);
});

test('repeated rejected event does not count as a second validation failure', async () => {
  const f = await fixture();
  const options = { ...f.options, rules: [badRule] };
  assert.equal((await (await RacoonsEngine.open(options)).process(f.present)).status, 'rejected');
  assert.equal((await (await RacoonsEngine.open(options)).process(f.present)).status, 'rejected');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'validation' && !event.ok).length, 1);
});

test('unknown breaker notice blocks until its receipt is reconciled', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open({ ...f.options, rules: [badRule] });
  await engine.process({ kind: 'at-rest', eventId: 'bad-1', reason: 'step' });
  await engine.process({ kind: 'at-rest', eventId: 'bad-2', reason: 'step' });
  f.port.live = { ...f.port.live, currentTurnOrdinal: 3 };
  f.port.outcome = 'unknown';
  f.port.lookup = 'unknown';
  const next = { kind: 'at-rest' as const, eventId: 'notice', reason: 'step' as const };
  assert.equal((await engine.process(next)).status, 'recovery-pending');
  assert.equal((await engine.process(next)).status, 'recovery-pending');
  assert.equal(f.port.requests.length, 1);
});

test('real in-memory SQLite retains engine metadata for repeat-event receipt checks', async () => {
  const f = await fixture();
  const ledger = await SqliteLedger.open({ databasePath: ':memory:',
    blobStore: new MemoryBlobStore(), clock: f.options.clock });
  try {
    const options = { ...f.options, ledger };
    const engine = await RacoonsEngine.open(options);
    await engine.process(f.present);
    assert.equal((await engine.process(f.prune)).status, 'applied');
    assert.equal((await (await RacoonsEngine.open(options)).process(f.prune)).status, 'applied');
    assert.equal(f.port.requests.length, 1);
    const id = f.port.requests[0]?.application.archives[0]?.recall.id;
    assert.ok(id);
    assert.deepEqual((await ledger.recall(id)).parts[0]?.bytes, f.first.bytes);
  } finally { await ledger.close(); }
});
