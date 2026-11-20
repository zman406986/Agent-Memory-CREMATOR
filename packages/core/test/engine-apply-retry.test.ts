// A pass that validates ok but whose ledger.prepare throws must be retryable:
// the same eventId applies the removal on retry instead of answering `unchanged`
// forever (ISSUE-309). The ok validation row is journaled only after the apply
// settles, and the pre-prepare candidate row is not a replay decision.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import { fixture } from './engine-fixtures.js';

test('a same-eventId retry after a prepare throw applies the removal (ISSUE-309)', async () => {
  const f = await fixture();
  const engine = await RacoonsEngine.open(f.options);
  await engine.process(f.present);

  f.ledger.failPrepare = true;
  const failed = await engine.process(f.prune);
  assert.equal(failed.status, 'recovery-pending', 'the prepare throw is a pending recovery');
  assert.equal(f.port.requests.length, 0, 'the prepare throw never reached the host');

  f.ledger.failPrepare = false;
  const retry = await engine.process(f.prune);
  assert.equal(retry.status, 'applied',
    'the retry applies the removal, not unchanged forever');
  assert.equal(f.port.requests.length, 1, 'the removal reached the host exactly once');
  assert.ok(retry.receipt !== null, 'the retry carries the applied receipt');
});