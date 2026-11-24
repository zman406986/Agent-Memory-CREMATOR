import { makeApplication } from '../guard/application.js';
import type { ValidatedApplication } from '../guard/types.js';
import type { LedgerEntry } from '../ledger/types.js';
import type { SessionSnapshot } from '../types/transcript.js';
import { sha256 } from '../util/hash.js';
import { applyApplication } from './application.js';
import { metadata } from './journal.js';
import type { TranscriptTelemetry } from './telemetry.js';
import type { EngineOptions } from './types.js';

/**
 * The disable episode the session is currently in: the validation that tripped
 * the breaker last, and which disable it is (1st, 2nd, …). A completed
 * validation ends an episode; the next trip starts a new one, so the notice is
 * owed once per disable, not once per session (ISSUE-308). Candidate rows
 * (`engineCandidate`) carry a pre-validation reading, not a decision, so they
 * neither start nor end an episode.
 */
function currentDisable(entries: readonly LedgerEntry[]): { trip: LedgerEntry; ordinal: number } | null {
  let trip: LedgerEntry | null = null;
  let ordinal = 0;
  let disabled = false;
  for (const entry of entries) {
    const { event } = entry;
    if (event.kind !== 'validation' || 'engineCandidate' in event) continue;
    if (event.breaker.disabled && !disabled) { ordinal += 1; trip = entry; }
    disabled = event.breaker.disabled;
  }
  return disabled && trip !== null ? { trip, ordinal } : null;
}

/** The first disable keeps the bare session key; later ones suffix their ordinal. */
const episodeSuffix = (ordinal: number): string => ordinal <= 1 ? '' : `:${String(ordinal)}`;

/** The latest `breaker-disabled` marker written after the tripping validation. */
function episodeMarker(entries: readonly LedgerEntry[], tripSequence: number): LedgerEntry | null {
  let marker: LedgerEntry | null = null;
  for (const entry of entries) {
    if (entry.event.kind === 'breaker-disabled' && entry.sequence > tripSequence) marker = entry;
  }
  return marker;
}

/**
 * Writes the one marker a disable is owed. It answers `true` only when this
 * call appended it, so the caller reports a disable once: a refusal while the
 * breaker is already quiet writes nothing and must not emit (ISSUE-557).
 */
export async function persistBreaker(
  options: EngineOptions, fallbackTurn: number, entries: readonly LedgerEntry[],
): Promise<boolean> {
  const episode = currentDisable(entries);
  if (episode === null) return false;
  const { trip } = episode;
  // A marker written after this trip belongs to this episode; an earlier marker
  // belongs to a previous disable and must not silence a re-disable (ISSUE-308).
  if (episodeMarker(entries, trip.sequence) !== null) return false;
  const failure = trip.event;
  const turn = 'engineTurnOrdinal' in failure && typeof failure.engineTurnOrdinal === 'number'
    ? failure.engineTurnOrdinal : fallbackTurn;
  await options.ledger.append({ kind: 'breaker-disabled', sessionId: options.sessionId,
    eventKey: `engine-breaker-disabled:${options.sessionId}${episodeSuffix(episode.ordinal)}`,
    atMs: failure.atMs, turnOrdinal: turn, reason: 'two-validation-failures' });
  return true;
}

/**
 * The one record that tells the model (and the operator) the judge was stopped.
 * It is owed once per disable: the pass that trips the breaker writes the
 * `breaker-disabled` marker, and the next boundary appends the notice. The
 * notice never waits for a turn to advance — a single-turn record is exactly
 * where it is needed (ISSUE-057 defect 3), so no ordinal is consulted.
 */
export async function announceBreaker(
  options: EngineOptions, telemetry: TranscriptTelemetry, snapshot: SessionSnapshot,
  entries: readonly LedgerEntry[], confirmedNotices: ReadonlySet<string>,
): Promise<'done' | 'appended' | 'blocked'> {
  const episode = currentDisable(entries);
  if (episode === null) return 'done';
  const marker = episodeMarker(entries, episode.trip.sequence);
  if (marker === null) return 'done';
  const suffix = episodeSuffix(episode.ordinal);
  const recordId = `racoons:breaker-disabled:${options.sessionId}${suffix}`;
  if (entries.some(({ event }) => event.kind === 'breaker-announced' && event.recordId === recordId)) return 'done';
  if (confirmedNotices.has(recordId)
    || snapshot.nodes.some(node => node.kind === 'racoons-record' && node.recordId === recordId)) {
    await markAnnounced(options, recordId, suffix);
    return 'done';
  }
  if (!options.capabilities.appendRecords) return 'done';
  // An abandoned notice intent is not a terminal drop: a transient host error
  // abandons it at an unchanged revision, and the notice stays owed until it
  // actually lands (ISSUE-312). Each abandoned attempt mints a fresh intent at
  // the next boundary by varying the application's event id; the record id stays
  // stable, so the host record dedup still recognises the notice once it lands
  // and the announcement above ends the episode. No retry cap is added.
  const abandoned = new Set(entries.flatMap(({ event }) => event.kind === 'abandoned' ? [event.intentId] : []));
  const priorAttempts = entries.filter(({ event }) => event.kind === 'prepared'
    && abandoned.has(event.intentId) && metadata(event)?.noticeRecordId === recordId).length;
  const eventId = priorAttempts === 0 ? recordId : `${recordId}:retry:${String(priorAttempts)}`;
  const bytes = new TextEncoder().encode('RACOONS disabled after two validation failures. Recall remains available.');
  const record = { recordId, bytes, sha256: await sha256(bytes) };
  // The disabled Guard cannot issue a notice, so the engine states this
  // application itself. It contains no source replacements, archive removals or
  // rule-provided bytes; the application body is built by the guard's own
  // builder, which is the only place the validated-application brand is
  // installed (no cast here).
  const application = makeApplication({
    input: { kind: 'at-rest', eventId, reason: 'step' },
    snapshot, capabilities: options.capabilities, config: options.config,
    plans: [], sealedEpisodeIds: [], nowMs: marker.event.atMs,
  }, {
    replacements: [], appendRecords: [record], archives: [], sealedEpisodeIds: [],
    expectedGenerated: new Map(), expectedRecords: new Map([[recordId, record.bytes]]),
    revert: null,
  });
  const outcome = await applyApplication(options, telemetry, application, recordId);
  if (outcome.status === 'applied') await markAnnounced(options, recordId, suffix);
  if (outcome.status === 'recovery-pending') return 'blocked';
  return outcome.status === 'applied' ? 'appended' : 'done';
}

async function markAnnounced(options: EngineOptions, recordId: string, suffix: string): Promise<void> {
  await options.ledger.append({
    kind: 'breaker-announced', sessionId: options.sessionId,
    eventKey: `engine-breaker-announced:${options.sessionId}${suffix}`,
    atMs: options.clock.nowMs(), recordId,
  });
}
