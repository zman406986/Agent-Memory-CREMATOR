import type { ApplyReceipt, LedgerEntry, LedgerEvent } from '../ledger/types.js';
import type {
  ApplicationPort, CommittedState, ReceiptConflict, ReceiptReadFailure,
} from './types.js';
import { metadata, receiptMatches } from './journal.js';

type PreparedEvent = Extract<LedgerEvent, { readonly kind: 'prepared' }>;

/**
 * Rebuilds committed seal state from the durable ledger (ADR-0015). The ledger
 * is the record of record: a host answer of `unknown` commits from the ledger's
 * `applied` receipt, and only a positive host refusal that contradicts that
 * receipt blocks and journals a conflict. The `L = none` row of the decision
 * table belongs to recovery, which runs first and appends what it can prove.
 */
export async function committedState(
  entries: readonly LedgerEntry[], port: ApplicationPort,
): Promise<CommittedState> {
  const sealed = new Set<string>();
  const events = new Map<string, ApplyReceipt | null>();
  const notices = new Set<string>();
  const conflicts: ReceiptConflict[] = [];
  // A lookup that throws is the host failing to answer, not refusing: it blocks
  // and is named, because a silent block gives the operator no reason (ADR-0065).
  const unread: ReceiptReadFailure[] = [];
  // The same intent can have two prepared entries (prepare()'s and the engine's
  // enriched one); one contradiction is journaled once per intent and host.
  const journaled = new Set<string>();
  const journal = (intentId: string, host: ReceiptConflict['host']): void => {
    const key = `${intentId}\u0000${host}`;
    if (journaled.has(key)) return;
    journaled.add(key);
    conflicts.push({ intentId, host });
  };
  let blocked = false;
  const applied = new Map(entries.flatMap(({ event }) => event.kind === 'applied'
    ? [[event.receipt.intentId, event.receipt] as const] : []));
  const abandoned = new Set(entries.flatMap(({ event }) => event.kind === 'abandoned'
    ? [event.intentId] : []));
  // The same intent can have two prepared entries (prepare()'s and the engine's
  // enriched one). One intent is one host question: choose the enriched row when
  // one exists, then look the receipt up exactly once (ISSUE-268).
  const preparedByIntent = new Map<string, PreparedEvent>();
  for (const { event } of entries) {
    if (event.kind !== 'prepared') continue;
    const chosen = preparedByIntent.get(event.intentId);
    if (chosen === undefined || (metadata(chosen) === null && metadata(event) !== null)) {
      preparedByIntent.set(event.intentId, event);
    }
  }
  for (const { event } of entries) {
    if (event.kind !== 'prepared') continue;
    if (preparedByIntent.get(event.intentId) !== event) continue;
    const details = metadata(event);
    const receipt = applied.get(event.intentId);
    if (receipt === undefined) {
      if (details !== null && abandoned.has(event.intentId) && !events.has(details.intent.eventId)) {
        events.set(details.intent.eventId, null);
      }
      continue;
    }
    // A ledger record that cannot be tied to its prepared event blocks without
    // a conflict journal: the host is not the contradicting party.
    if (!receiptMatches(event, receipt)) {
      blocked = true;
      continue;
    }
    try {
      const lookup = await port.lookupReceipt(event.intentId);
      if (lookup.status === 'not-applied') {
        // R4: a durable applied record is never downgraded by a host refusal.
        blocked = true;
        journal(event.intentId, 'not-applied');
        continue;
      }
      if (lookup.status === 'applied' && (!receiptMatches(event, lookup.receipt)
        || lookup.receipt.resultRevision !== receipt.resultRevision
        || lookup.receipt.appliedAtMs !== receipt.appliedAtMs)) {
        blocked = true;
        journal(event.intentId, 'applied');
        continue;
      }
      if (details === null) {
        // An applied intent without event/seal metadata cannot safely permit new seals.
        blocked = true;
        continue;
      }
      // R2: an unknown host answer commits from the ledger receipt, never a
      // port one; the port is not asked to reproduce what the ledger recorded.
      const committed = lookup.status === 'applied' ? lookup.receipt : receipt;
      events.set(details.intent.eventId, committed);
      for (const id of details.sealedEpisodeIds) sealed.add(id);
      if (details.noticeRecordId !== null) notices.add(details.noticeRecordId);
    } catch (error: unknown) {
      blocked = true;
      unread.push({ intentId: event.intentId,
        message: error instanceof Error ? error.message : 'the receipt read failed' });
    }
  }
  return { sealedEpisodeIds: [...sealed], events, notices, blocked, conflicts, unread };
}
