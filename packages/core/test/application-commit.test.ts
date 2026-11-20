// The applied receipt follows the wire write (audit finding: a staged receipt
// is not an applied receipt). A staging port's `apply` leaves the host array
// untouched; its `commit` is the wire write, and the engine records the durable
// `applied` event only when that call answers true. A refused stage is
// abandoned, so no claim set names a removal the host never carried.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { committedState } from '../src/engine/committed.js';
import { RacoonsEngine } from '../src/engine/engine.js';
import { readEntries, metadata } from '../src/engine/journal.js';
import { recoverPending } from '../src/engine/recovery.js';
import type {
  ApplyRequest, ApplyResult, ReceiptLookup,
} from '../src/engine/types.js';
import type { ApplyReceipt } from '../src/ledger/types.js';
import type { IntentId } from '../src/types/identity.js';
import type { TelemetryEvent } from '../src/types/telemetry.js';
import { fixture, TestPort } from './engine-fixtures.js';

/**
 * The fixture's port, staging instead of applying: `apply` files a receipt and
 * holds it, and the caller's `commit` is the only path that lands it. This is
 * the opencode port's shape reduced to what the engine contract reads.
 */
class StagingPort extends TestPort {
  /** What `commit()` answers; the array lands only when this is true. */
  commitAnswer = false;
  commits = 0;
  /**
   * Whether a refused commit is a positive refusal the port can prove. A real
   * refusing commit seam knows nothing landed (`not-applied`); a port that lost
   * receipt certainty after a restart answers `unknown` instead (ISSUE-306).
   */
  recordRefusal = true;
  private staged: ApplyReceipt | null = null;
  private refused = new Set<IntentId>();

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    this.requests.push(structuredClone(request));
    const receipt: ApplyReceipt = {
      ...request.intent, resultRevision: `${this.live.revision}+staged`, appliedAtMs: 100,
    };
    this.staged = receipt;
    return { status: 'applied', receipt: structuredClone(receipt) };
  }

  commit(): boolean {
    this.commits += 1;
    const staged = this.staged;
    this.staged = null;
    if (!this.commitAnswer || staged === null) {
      if (staged !== null && this.recordRefusal) this.refused.add(staged.intentId);
      return false;
    }
    this.live = { ...this.live, revision: staged.resultRevision };
    this.receipts.set(staged.intentId, staged);
    return true;
  }

  async lookupReceipt(intentId: IntentId): Promise<ReceiptLookup> {
    const receipt = this.receipts.get(intentId);
    if (receipt !== undefined) return { status: 'applied', receipt: structuredClone(receipt) };
    if (this.refused.has(intentId)) return { status: 'not-applied' };
    return { status: 'unknown' };
  }
}

function stagingFixture(commitAnswer: boolean) {
  return fixture().then((f) => {
    const port = new StagingPort(f.snapshot, f.port.incoming);
    port.commitAnswer = commitAnswer;
    const telemetry: TelemetryEvent[] = [];
    return {
      f, port, telemetry,
      options: { ...f.options, port, onTelemetry: (event: TelemetryEvent) => telemetry.push(event) },
    };
  });
}

const intentIdOf = (f: Awaited<ReturnType<typeof fixture>>): IntentId => {
  const prepared = f.ledger.entries.find(({ event }) => event.kind === 'prepared');
  assert.ok(prepared?.event.kind === 'prepared', 'the ledger holds the prepared intent');
  return prepared.event.intentId;
};

test('a commit that answers false leaves no applied claim and abandons the intent', async () => {
  const { f, port, telemetry, options } = await stagingFixture(false);
  const engine = await RacoonsEngine.open(options);
  const outcome = await engine.process(f.prune);
  assert.equal(outcome.status, 'unchanged', 'a stage the wire never received is not applied');
  assert.equal(outcome.receipt, null, 'no receipt names a removal that did not happen');
  assert.equal(outcome.committed, false, 'the result reports the failed wire write');
  assert.equal(port.commits, 1, 'the engine asked the port to commit exactly once');

  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'applied').length, 0,
    'no durable applied event exists');
  const abandoned = f.ledger.entries.filter(({ event }) => event.kind === 'abandoned');
  assert.equal(abandoned.length, 1, 'the prepared intent is abandoned, not left pending');
  assert.equal(abandoned[0]?.event.kind === 'abandoned' ? abandoned[0].event.intentId : null,
    intentIdOf(f), 'the abandonment names this pass');

  const entries = await readEntries(f.ledger, f.options.sessionId);
  const state = await committedState(entries, port);
  assert.equal(state.blocked, false, 'the host refusal is not a receipt conflict');
  assert.equal(state.events.get('prune-1'), null,
    'the event carries the abandonment marker, never a receipt');
  assert.equal((await recoverPending(f.ledger, port, f.options.sessionId)).status, 'clear',
    'abandoning the stage keeps the session live: recovery has nothing pending');

  const application = telemetry.find(event => event.kind === 'application');
  assert.equal(application?.kind === 'application' ? application.outcome : null, 'not-applied',
    'telemetry never claims an applied removal');
  assert.equal(application?.kind === 'application' ? application.removedBytes : null, 0,
    'no removed bytes are claimed');
});

test('a commit that answers true leaves exactly one applied claim', async () => {
  const { f, port, telemetry, options } = await stagingFixture(true);
  const engine = await RacoonsEngine.open(options);
  const outcome = await engine.process(f.prune);
  assert.equal(outcome.status, 'applied', 'the committed stage is applied');
  assert.equal(outcome.receipt?.intentId, outcome.intentId, 'the receipt names this intent');
  assert.equal(outcome.committed, true, 'the result reports the wire write');
  assert.equal(port.commits, 1, 'one commit for one application');

  const applied = f.ledger.entries.filter(({ event }) => event.kind === 'applied');
  assert.equal(applied.length, 1, 'exactly one durable applied event');
  assert.equal(applied[0]?.event.kind === 'applied' ? applied[0].event.receipt.intentId : null,
    outcome.intentId, 'the applied event names the committed intent');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length, 0,
    'a committed stage is never abandoned');

  const entries = await readEntries(f.ledger, f.options.sessionId);
  const state = await committedState(entries, port);
  assert.equal(state.blocked, false, 'the host receipt matches the durable one');
  assert.equal(state.events.get('prune-1')?.intentId, outcome.intentId,
    'the claim set reads the committed receipt');

  const application = telemetry.find(event => event.kind === 'application');
  assert.equal(application?.kind === 'application' ? application.outcome : null, 'applied',
    'telemetry reports the removal the wire carried');
});

test('a commit false with an unknown lookup writes no claim and no abandon (ISSUE-306)', async () => {
  const { f, port, telemetry, options } = await stagingFixture(false);
  // The port lost receipt certainty (e.g. after a restart): the refused stage is
  // an absence the host cannot prove, not a positive refusal.
  port.recordRefusal = false;
  const engine = await RacoonsEngine.open(options);
  const outcome = await engine.process(f.prune);
  assert.equal(outcome.status, 'recovery-pending', 'an unproved outcome stays pending');
  assert.equal(outcome.receipt, null, 'no receipt names an unproved removal');
  assert.equal(outcome.committed, false, 'the wire write did not land');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'applied').length, 0,
    'no durable applied claim exists');
  assert.equal(f.ledger.entries.filter(({ event }) => event.kind === 'abandoned').length, 0,
    'an unknown lookup never abandons a live intent');

  // The prepared row and its sealed metadata survive for recovery to reconcile.
  const entries = await readEntries(f.ledger, f.options.sessionId);
  const prepared = entries.find(({ event }) => event.kind === 'prepared');
  assert.ok(prepared !== undefined, 'the prepared intent is still pending');
  assert.notEqual(metadata(prepared.event), null, 'the sealed metadata survives the unknown lookup');
  assert.equal((await recoverPending(f.ledger, port, f.options.sessionId)).status, 'blocked',
    'recovery holds the session until the host outcome is known');

  const application = telemetry.find(event => event.kind === 'application');
  assert.equal(application?.kind === 'application' ? application.outcome : null, 'unknown',
    'telemetry claims neither an applied nor a refused removal');
});
