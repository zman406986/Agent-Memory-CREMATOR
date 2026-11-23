// A transient ledger I/O fault during validation is not the event's verdict
// (ISSUE-313): the guard answers one `ledger-io` issue and leaves the breaker
// untouched. The engine journals a validation row for every ok:false answer, and
// `run`'s replay short-circuit answers `rejected` forever for any prior
// ok:false row naming the event — so a locked blob file permanently refused the
// event's removal even after storage recovered (ISSUE-488). The retry after the
// lock clears must replan the event instead of replaying a rejection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RacoonsEngine } from '../src/engine/engine.js';
import { recallManifestFor } from '../src/guard/recall.js';
import type { EngineInput, EngineOptions } from '../src/engine/types.js';
import type { Ledger, RecallRecord } from '../src/ledger/types.js';
import { LedgerError } from '../src/ledger/types.js';
import { Meter } from '../src/meter/meter.js';
import type { Rule, RulePlan } from '../src/rules/types.js';
import type { SessionSnapshot, ToolResultNode } from '../src/types/transcript.js';
import { TestLedger, TestPort } from './engine-fixtures.js';
import { message, result, snapshot as guardSnapshot } from './guard-fixtures.js';

/**
 * A seal pass: the guard reads the ledger for a sealed episode's evidence
 * provenance, which is the one validation path that touches storage (ISSUE-313).
 * The store is locked on demand, exactly as the ticket's Windows file lock on
 * `store.get` behaves while SQLite stays writable.
 */
class LockedBlobLedger extends TestLedger {
  locked = false;
  override async recall(id: string) {
    if (this.locked) throw new LedgerError('storage', 'Injected blob file lock');
    return super.recall(id);
  }
}

/** The seal rule over whatever episode the pass detected. */
const sealRule: Rule = {
  id: 'seal',
  plan: (context): RulePlan | null => {
    const episode = context.episodes[0];
    if (episode === undefined) return null;
    return { ruleId: 'seal', baseRevision: context.snapshot.revision, removals: [],
      notes: [{ id: 'fact', kind: 'negative-fact', episodeId: episode.id }],
      operations: [{ kind: 'seal', mode: 'append', removalId: null,
        episodeId: episode.id, noteId: 'fact' }] };
  },
};

/**
 * One closed miss episode whose evidence names a banked recall: the guard reads
 * that record from the ledger, so its absence is the storage the lock blocks.
 */
function sealSnapshot(): {
  snapshot: SessionSnapshot; node: ToolResultNode; recall: RecallRecord;
} {
  const base = result();
  const source = base.evidence.source;
  const parts = [{ source, bytes: base.bytes.slice(),
    removedRanges: [{ range: { startByte: 0, endByteExclusive: base.bytes.length },
      sha256: base.sha256 }] }];
  const { manifest, manifestSha256, id } = recallManifestFor('session', parts.map(part => ({
    source: part.source, blobSha256: part.source.sha256, removedRanges: part.removedRanges,
  })));
  const recall: RecallRecord = { id, manifestSha256, manifest, parts };
  const node: ToolResultNode = { ...base,
    evidence: { ...base.evidence, sourceRecallId: id } };
  return {
    node, recall,
    snapshot: guardSnapshot({ nodes: [message(), node], completedThroughTurnOrdinal: 1,
      currentTurnOrdinal: 2 }),
  };
}

function options(snapshot: SessionSnapshot, ledger: Ledger, node: ToolResultNode): EngineOptions {
  return {
    sessionId: snapshot.sessionId, port: new TestPort(snapshot, node), ledger,
    clock: { nowMs: () => 100 },
    meter: new Meter({ estimate: content => content.length }), rules: [sealRule],
    capabilities: { mutateResult: true, rewriteHistory: true, atRest: true, liveTokens: false,
      log: true, appendRecords: true, rehydrateOnResume: false },
    config: {
      thresholds: { capBytes: 8, capHeadBytes: 6, episodeNoNewPathSteps: null,
        sealMaxLatencyTurns: 1 },
      freshZone: { maxNodes: null, maxBytes: null }, sealMode: 'append',
      validationFailureLimit: 2,
      protocol: { barBytes: 2048, minCutFreedBytes: 4096 },
    },
  };
}

test('a transient ledger-io refusal keeps its event retryable (ISSUE-488)', async () => {
  const { snapshot, node, recall } = sealSnapshot();
  const ledger = new LockedBlobLedger();
  ledger.recalls.set(recall.id, recall);
  const passOptions = options(snapshot, ledger, node);
  const event: EngineInput = { kind: 'at-rest', eventId: 'seal-event', reason: 'turn-end' };

  ledger.locked = true;
  const blocked = await (await RacoonsEngine.open(passOptions)).process(event);
  const validation = blocked.validation;
  assert.ok(validation, 'the refused pass carries a validation result');
  if (validation.ok) assert.fail('the refusal is the transient storage classification');
  assert.deepEqual(validation.issues.map(issue => issue.code), ['ledger-io'],
    'the refusal is the transient storage classification');
  assert.equal(blocked.status, 'recovery-pending',
    'a storage refusal is a retryable pass, not the event verdict');
  assert.equal(ledger.entries.filter(({ event: row }) => row.kind === 'validation'
    && row.eventId === 'seal-event').length, 0,
  'the transient refusal is not journaled as the event verdict');

  ledger.locked = false;
  const retry = await (await RacoonsEngine.open(passOptions)).process(event);
  assert.equal(retry.status, 'applied',
    'the retry after storage recovers replans and applies the removal');
  assert.equal((passOptions.port as TestPort).requests.length, 1);
});