import type { ValidatedApplication } from '../guard/types.js';
import type { PreparedIntent } from '../ledger/types.js';
import type { ApplicationPort, EngineOptions, EngineResult } from './types.js';
import {
  applicationMeasurements, receiptMatches, recordApplied, recordCandidate, recordPrepared,
} from './journal.js';
import type { EnginePreparedEvent } from './journal.js';
import type { TranscriptTelemetry } from './telemetry.js';

type ApplicationOutcome = Pick<EngineResult, 'status' | 'intentId' | 'receipt' | 'committed'>;

interface CommitRead {
  /** True only when this pass's own call landed the wire write. */
  readonly committed: boolean;
  /**
   * `true` writes the durable applied receipt, `false` abandons the stage, and
   * `null` writes nothing because the outcome could not be proved (ADR-0015).
   */
  readonly claim: boolean | null;
}

/**
 * Commits the staged derivation, if the port stages at all, and reads what the
 * answer proves. A port whose `apply` is the host write omits `commit` and is
 * already committed. A staging port's `apply` leaves the host array untouched,
 * so its `commit` is the wire write: `false` is a positive "nothing landed" and
 * the prepared intent is abandoned, never claimed. A replayed intent can also
 * answer `false` because an earlier pass landed it; the port's receipt lookup is
 * the host record that separates that case from a refused stage. An `unknown`
 * lookup never writes anything, and neither does a failed one.
 */
async function readCommit(
  port: ApplicationPort, intent: PreparedIntent, prepared: EnginePreparedEvent,
): Promise<CommitRead> {
  const commit = port.commit;
  if (commit === undefined) return { committed: true, claim: true };
  let landed: boolean;
  try {
    landed = commit.call(port);
  } catch {
    return { committed: false, claim: null };
  }
  if (landed) return { committed: true, claim: true };
  try {
    const lookup = await port.lookupReceipt(intent.intentId);
    if (lookup.status === 'applied') {
      return receiptMatches(prepared, lookup.receipt)
        ? { committed: false, claim: true }
        : { committed: false, claim: null };
    }
    if (lookup.status === 'not-applied') {
      // A positive host refusal: the commit said the array did not change and
      // the host confirms nothing landed, so the prepared row must not linger
      // as an application.
      return { committed: false, claim: false };
    }
    // An `unknown` lookup is absence, never a refusal (R3/R6, ISSUE-030): it
    // proves nothing, so it writes no claim and no abandon, exactly like a
    // failed lookup. The intent stays pending for recovery (ISSUE-306).
    return { committed: false, claim: null };
  } catch {
    return { committed: false, claim: null };
  }
}

export async function applyApplication(
  options: EngineOptions, telemetry: TranscriptTelemetry, application: ValidatedApplication,
  noticeRecordId: string | null = null,
): Promise<ApplicationOutcome> {
  // Metadata precedes prepare, which durably writes archive bytes before host mutation.
  await recordCandidate(options.ledger, application, noticeRecordId);
  const intent = await options.ledger.prepare(structuredClone(application));
  if (intent.sessionId !== application.sessionId || intent.eventId !== application.eventId
    || intent.baseRevision !== application.baseRevision
    || intent.applicationSha256 !== application.applicationSha256) {
    throw new Error('Prepared intent does not match the validated application');
  }
  const prepared = await recordPrepared(options.ledger, intent, application, noticeRecordId);
  let outcome: Awaited<ReturnType<EngineOptions['port']['apply']>>;
  try {
    outcome = await options.port.apply(structuredClone({ intent, application }));
  } catch {
    outcome = { status: 'unknown' };
  }
  let status: ApplicationOutcome['status'] = 'recovery-pending';
  let receipt: ApplicationOutcome['receipt'] = null;
  let committed = false;
  if (outcome.status === 'applied' && receiptMatches(prepared, outcome.receipt)) {
    const read = await readCommit(options.port, intent, prepared);
    committed = read.committed;
    if (read.claim === true) {
      // Only a proved outcome names a receipt: an unproved one (claim null)
      // stays recovery-pending with no receipt, exactly like a refusal.
      receipt = structuredClone(outcome.receipt);
      try {
        await recordApplied(options.ledger, receipt);
        status = 'applied';
      } catch { /* Reconcile the host receipt before another application. */ }
    } else if (read.claim === false) {
      // The durable applied claim follows the wire write. A stage the host
      // array never received is abandoned here, so recovery reads it as
      // finished and no claim names a removal that did not happen.
      try {
        await options.ledger.append({
          kind: 'abandoned', sessionId: intent.sessionId, intentId: intent.intentId,
          eventKey: `engine-abandoned:${intent.intentId}`, atMs: options.clock.nowMs(),
          reason: 'staged rewrite never reached the host array',
        });
        status = 'unchanged';
      } catch { /* Confirm a missing abandonment through receipt lookup. */ }
    }
  } else if (outcome.status === 'not-applied') {
    try {
      await options.ledger.append({
        kind: 'abandoned', sessionId: intent.sessionId, intentId: intent.intentId,
        eventKey: `engine-abandoned:${intent.intentId}`, atMs: options.clock.nowMs(),
        reason: outcome.reason,
      });
      status = 'unchanged';
    } catch { /* Confirm a missing abandonment through receipt lookup. */ }
  }
  const measurements = applicationMeasurements(application);
  telemetry.emit({
    kind: 'application', sessionId: intent.sessionId, atMs: options.clock.nowMs(),
    intentId: intent.intentId,
    outcome: status === 'applied' ? 'applied' : status === 'unchanged' ? 'not-applied' : 'unknown',
    removedBytes: status === 'applied' ? measurements.removedBytes : 0,
    generatedBytes: status === 'applied' ? measurements.generatedBytes : 0,
    recallIds: status === 'applied' ? measurements.recallIds : [],
    sealedEpisodeIds: status === 'applied' ? application.sealedEpisodeIds : [],
  });
  return { status, intentId: intent.intentId, receipt, committed,
    ...(status === 'applied' ? { removedBytes: measurements.removedBytes } : {}) };
}
