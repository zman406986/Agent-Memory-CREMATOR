// The breaker notice is owed once per disable, not once per session
// (ISSUE-308), and an abandoned notice intent is retried, not silenced forever
// (ISSUE-312). Both read the engine's own notice lane over the applied-removal
// fixture: a disable trips, a boundary announces, a completed validation resets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import type { Rule } from '../src/rules/types.js';
import { fixture } from './engine-fixtures.js';

const badRule: Rule = {
  id: 'bad', plan: context => ({ ruleId: 'bad', baseRevision: `${context.snapshot.revision}:stale`,
    removals: [], notes: [], operations: [] }),
};

const atRest = (eventId: string) =>
  ({ kind: 'at-rest' as const, eventId, reason: 'step' as const });

const noticeNodes = (f: Awaited<ReturnType<typeof fixture>>, recordId: string) =>
  f.port.live.nodes.filter(node => node.kind === 'racoons-record' && node.recordId === recordId);

test('a re-disable after a reset writes a fresh marker and appends a fresh notice (ISSUE-308)', async () => {
  const f = await fixture();
  const bad = { ...f.options, rules: [badRule] };
  const quiet = { ...f.options, rules: [] };

  // First disable: two refusals trip the breaker; the next boundary announces.
  const first = await RacoonsEngine.open(bad);
  await first.process(atRest('bad-1'));
  await first.process(atRest('bad-2'));
  await (await RacoonsEngine.open(quiet)).process(atRest('notice-1'));
  const firstNotice = 'racoons:breaker-disabled:session-1';
  assert.equal(noticeNodes(f, firstNotice).length, 1, 'the first disable lands its notice');

  // A completed validation resets the breaker (the prune pass applies).
  assert.equal((await (await RacoonsEngine.open(f.options)).process(f.prune)).status, 'applied');

  // Second disable: two more refusals trip it again; the next boundary must
  // announce again, not read the first disable's announcement as its own.
  const second = await RacoonsEngine.open(bad);
  await second.process(atRest('bad-3'));
  await second.process(atRest('bad-4'));
  await (await RacoonsEngine.open(quiet)).process(atRest('notice-2'));
  const secondNotice = 'racoons:breaker-disabled:session-1:2';
  assert.equal(noticeNodes(f, secondNotice).length, 1,
    'the second disable appends its own notice, not silence');
  assert.equal(noticeNodes(f, firstNotice).length, 1, 'the first notice is untouched');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-disabled').length, 2,
    'one marker per disable episode');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-announced').length, 2,
    'one announcement per disable episode');
});

test('an abandoned notice intent at unchanged revision is retried, not silenced forever (ISSUE-312)', async () => {
  const f = await fixture();
  const bad = { ...f.options, rules: [badRule] };
  const quiet = { ...f.options, rules: [] };
  const recordId = 'racoons:breaker-disabled:session-1';

  // Trip the breaker; the next boundary prepares the notice intent, but a
  // transient host error refuses the apply, abandoning it at unchanged revision.
  const first = await RacoonsEngine.open(bad);
  await first.process(atRest('bad-1'));
  await first.process(atRest('bad-2'));
  f.port.outcome = 'not-applied';
  await (await RacoonsEngine.open(quiet)).process(atRest('notice-1'));
  assert.equal(noticeNodes(f, recordId).length, 0, 'the refused notice has not landed');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length, 1,
    'the transient error abandoned the notice intent');
  const revisionAfterAbandon = f.port.live.revision;

  // The host recovers; the next boundary must deliver the owed notice with a
  // fresh intent, not read the abandoned intent at the same revision as done.
  f.port.outcome = 'applied';
  await (await RacoonsEngine.open(quiet)).process(atRest('notice-2'));
  assert.equal(noticeNodes(f, recordId).length, 1,
    'a later boundary delivers the notice the abandon never landed');
  assert.notEqual(f.port.live.revision, revisionAfterAbandon, 'the retry actually wrote the host');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'breaker-announced'
    && event.recordId === recordId).length, 1, 'the landed notice is announced once');
});