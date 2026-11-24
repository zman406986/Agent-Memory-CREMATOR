import { Guard } from '../guard/guard.js';
import type { BreakerState, ValidationIssue, ValidationResult } from '../guard/types.js';
import type { Ledger, LedgerEntry, RecallOptions } from '../ledger/types.js';
import type { EpisodeId, NodeId, RecallId } from '../types/identity.js';
import type { HarnessObservation, TelemetryEvent } from '../types/telemetry.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { RulePlan } from '../rules/types.js';
import { ENTRY_SHAPE_RULE_ID } from '../rules/types.js';
import { sha256 } from '../util/hash.js';
import { computeInvalidation, withoutStaleCoverage } from '../units/invalidation.js';
import type { Invalidation } from '../units/invalidation.js';
import { UnitTracker } from '../units/tracker.js';
import { applyApplication } from './application.js';
import { committedState } from './committed.js';
import { breakerState, metadata, readEntries } from './journal.js';
import { announceBreaker, persistBreaker } from './notice.js';
import { detectEpisodes, planApplication, planEntryDecision } from './planning.js';
import type { EntryShapePlan, EntryShapeRefusal } from './planning.js';
import { recoverPending } from './recovery.js';
import { salvageShare, TranscriptTelemetry } from './telemetry.js';
import type {
  ApplicationPort, EngineInput, EngineOptions, EngineResult, PassInvalidation, ReceiptConflict,
} from './types.js';

type EventPayload<T = TelemetryEvent> = T extends TelemetryEvent
  ? Omit<T, 'sessionId' | 'atMs'> : never;
const result = (status: EngineResult['status'], validation: ValidationResult | null = null,
  invalidation: PassInvalidation | null = null): EngineResult =>
  ({ status, validation, intentId: null, receipt: null, invalidation });

/** A code the entry lane journals as its own decision record (ADR-0022 §14). */
type EntryDecisionCode = EntryShapeRefusal | 'missing-stamp' | 'keepall';

/**
 * ISSUE-605: the stability check reads the selected removal span's node
 * identities, not the session's revision. A transcript is append-only, so a
 * node appended after the span cannot falsify a removal already selected: every
 * removed source must still sit at its own index with its own id. Only when all
 * of them do is the plan prepared again against the live nodes; a span node
 * that moved, changed or vanished is not recoverable that way, and the port's
 * whole-session `stale-revision` refusal stays the answer. A plan with no
 * removal has no span to check, so it keeps the revision refusal it had.
 */
function removalSpanIntact(
  plans: readonly RulePlan[], prepared: SessionSnapshot, live: SessionSnapshot,
): boolean {
  const removed = plans.flatMap(plan => plan.removals.flatMap(removal =>
    removal.sources.map(source => source.source.nodeId)));
  if (removed.length === 0) return false;
  return removed.every(id => {
    const index = prepared.nodes.findIndex(node => node.id === id);
    return index >= 0 && live.nodes[index]?.id === id;
  });
}

/**
 * Optional cancellation for one `process` call. A signal or deadline releases
 * the queue even while a host call is still hung; the pass then answers
 * `recovery-pending`, because nothing it attempted can be proved safe.
 */
export interface ProcessControl {
  /** Aborts this pass as soon as the signal fires. */
  readonly signal?: AbortSignal;
  /** Aborts this pass after this many milliseconds. */
  readonly timeoutMs?: number;
}

/** What `process` accepts second: an options object, a signal, or a deadline. */
export type ProcessControlInput = ProcessControl | AbortSignal | number;

/**
 * A controlled pass's cancellation token, carried on its own fenced options
 * object (ISSUE-310) so the one seam that must refuse before it mutates
 * anything — the session guard's in-memory breaker — can read it without
 * threading the token through every planner. A symbol, so no host-visible
 * option key can collide with it (ISSUE-489).
 */
const PASS_FENCE = Symbol('cremator.passFence');
interface FencedOptions extends EngineOptions {
  readonly [PASS_FENCE]?: { readonly cancelled: boolean };
}

const normalizeControl = (
  control: ProcessControlInput | undefined,
): ProcessControl | undefined => {
  if (control === undefined) return undefined;
  if (typeof control === 'number') return { timeoutMs: control };
  if (control instanceof AbortSignal) return { signal: control };
  return control;
};

/**
 * One entry decision's journal issue. The entry lane's own codes are not in the
 * guard's `ValidationCode` vocabulary, and this ticket does not widen the guard;
 * the row still carries the exact code a caller reads, so a keepall is not
 * confused with a malformed answer.
 */
const entryIssue = (code: EntryDecisionCode, detail: string,
  nodeId: NodeId | null): ValidationIssue => ({
  code: code as unknown as ValidationIssue['code'],
  ruleId: ENTRY_SHAPE_RULE_ID, operationIndex: null, nodeId, detail,
});

/** The row a caller reads when the event's own kind is outside the engine's vocabulary. */
const invalidEventIssue = (kind: unknown): ValidationIssue => ({
  code: 'invalid-event' as unknown as ValidationIssue['code'],
  ruleId: null, operationIndex: null, nodeId: null,
  detail: `the event kind ${String(kind)} is not one of entry, at-rest, prune, forget`,
});

/**
 * The landed bytes a hand-built entry event carries, or `null` when it has
 * none. A real `ToolResultNode` always carries a `Uint8Array`; a cast event may
 * omit `result` or spell `bytes` as anything, and hashing either would throw a
 * host-visible fault before the entry lane can journal its own code.
 */
const landedBytes = (result: unknown): Uint8Array | null => {
  if (result === null || typeof result !== 'object') return null;
  const bytes = (result as { readonly bytes?: unknown }).bytes;
  return bytes instanceof Uint8Array ? bytes : null;
};

/** The pass-wide invalidation fact a result reports, or `null` when nothing was written. */
const passInvalidation = (invalidation: Invalidation): PassInvalidation | null =>
  invalidation.units.length === 0 && invalidation.staleMaps.length === 0 ? null : {
    unitIds: invalidation.units.map(row => row.unit.id),
    stalePathKeys: invalidation.staleMaps.map(row => row.pathKey),
  };

export class RacoonsEngine {
  private readonly telemetry: TranscriptTelemetry;
  private options: EngineOptions;
  private queue: Promise<void> = Promise.resolve();
  private readonly unchangedEvents = new Set<string>();
  private readonly seenRefetches = new Set<string>();
  /** One `receipt-conflict` per intent and host; `committedState` runs every pass (R4). */
  private readonly reportedConflicts = new Set<string>();
  /** The session's guard, created on first use; see `guardFor`. */
  private guard: Guard | null = null;

  private constructor(options: EngineOptions) {
    this.options = options;
    this.telemetry = new TranscriptTelemetry(options.onTelemetry);
  }

  static async open(options: EngineOptions): Promise<RacoonsEngine> {
    return new RacoonsEngine({ ...options, capabilities: structuredClone(options.capabilities),
      config: structuredClone(options.config), rules: [...options.rules] });
  }

  /**
   * Re-derive the per-session config after the mount's route changed mid-session
   * (ISSUE-469). The guard reads `config.floorBytes` on every pass, so the ask
   * gate's refreshed floor and the enforced floor are one value. No cap, retry
   * count or timeout is introduced (ADR-0060; standing rule 7).
   */
  updateConfig(config: EngineOptions['config']): void {
    this.options = { ...this.options, config: structuredClone(config) };
  }

  process(input: EngineInput, control?: ProcessControlInput): Promise<EngineResult> {
    let owned: EngineInput;
    try {
      owned = structuredClone(input);
    } catch (error: unknown) {
      // A non-cloneable event is malformed before any pass starts. It is refused
      // without reaching the queue or the permanent-fault latch (ISSUE-268).
      this.emit({ kind: 'error', eventId: null, stage: 'recovery',
        message: error instanceof Error ? error.message : 'Malformed engine event' });
      return Promise.resolve(result('rejected'));
    }
    const normalized = normalizeControl(control);
    const pending = this.queue.then(() => this.runControlled(owned, normalized));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  observe(observation: HarnessObservation): void {
    try {
      if (observation.kind === 'usage') {
        const reading = this.options.meter.reconcile(structuredClone(observation));
        if (this.telemetry.usage(reading)) this.emit({ kind: 'usage-reconciled', reading });
      } else if (this.telemetry.forcedLoss(observation)) {
        this.emit({ kind: 'forced-loss', observation: structuredClone(observation) });
      }
    } catch (error: unknown) {
      // A malformed observation is a host reading, never a pass: it is recorded
      // and swallowed so it cannot throw into the host (ISSUE-268).
      this.emit({ kind: 'error', eventId: null, stage: 'apply',
        message: error instanceof Error ? error.message : 'Observation could not be reconciled' });
    }
  }

  /**
   * Exact bytes for one recall id, through the ledger. `options.reader` is the
   * source lane a mount may supply (PRD §6.7; ISSUE-053): absent, a ledger miss
   * stays `not-found` exactly as before. It is a parameter of the call, never
   * engine state, so one engine serves a mount with a reader and one without.
   */
  async recall(id: RecallId, options?: RecallOptions) {
    const record = await this.options.ledger.recall(id, options);
    this.emit({ kind: 'recall', recallId: id,
      restoredBytes: record.parts.reduce((sum, part) => sum + part.bytes.length, 0) });
    return record;
  }

  private emit(event: EventPayload): void {
    try {
      this.telemetry.emit({ ...event, sessionId: this.options.sessionId,
        atMs: this.options.clock.nowMs() } as TelemetryEvent);
    } catch { /* Telemetry failures cannot alter engine outcomes. */ }
  }

  /**
   * Emits one `receipt-conflict` per contradiction (ISSUE-030 R4). State is
   * rebuilt on every pass, so an unreconciled conflict would otherwise repeat;
   * the dedup key is the intent and the host answer (design §7 risk 4).
   */
  private reportConflicts(conflicts: readonly ReceiptConflict[]): void {
    for (const conflict of conflicts) {
      const key = `${conflict.intentId}\u0000${conflict.host}`;
      if (this.reportedConflicts.has(key)) continue;
      this.reportedConflicts.add(key);
      this.emit({ kind: 'receipt-conflict', intentId: conflict.intentId, host: conflict.host });
    }
  }

  /**
   * Runs one queued pass and contains every fault. A pass that throws before its
   * prepare cannot leave anything to recover, so it no longer latches the engine
   * into permanent `recovery-pending`; the next pass runs normally (ISSUE-268).
   * A genuine pending intent is still found by `recoverPending`.
   */
  private async runControlled(
    input: EngineInput, control?: ProcessControl,
  ): Promise<EngineResult> {
    try {
      return await this.withControl(input, control);
    } catch (error: unknown) {
      this.emit({ kind: 'error', eventId: input.eventId, stage: 'recovery',
        message: error instanceof Error ? error.message : 'Engine could not establish safe state' });
      return result('recovery-pending');
    }
  }

  /**
   * One pass under an optional abort signal or deadline. The race is what
   * releases the queue: a host call that never settles cannot hold later
   * passes, and the cancelled pass answers `recovery-pending` because it cannot
   * prove whether its apply landed (ISSUE-268).
   */
  private async withControl(
    input: EngineInput, control?: ProcessControl,
  ): Promise<EngineResult> {
    const signal = control?.signal;
    const timeoutMs = control?.timeoutMs;
    if (signal === undefined && timeoutMs === undefined) return this.run(input, this.options);
    if (signal?.aborted === true) return this.cancelled(input, 'the pass was aborted before it started');
    // The fence travels with this pass: cancellation releases the queue, and the
    // orphaned run's late host mutations and ledger appends are refused even
    // while a later pass applies (ISSUE-310).
    const fence = { cancelled: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<EngineResult>(resolve => {
      const cancel = (message: string): void => {
        fence.cancelled = true;
        resolve(this.cancelled(input, message));
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => { cancel(`the pass exceeded its ${String(timeoutMs)}ms deadline`); },
          Math.max(0, timeoutMs));
      }
      if (signal !== undefined) {
        onAbort = () => { cancel('the pass was aborted'); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([this.run(input, this.fencedOptions(fence)), stopped]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A per-pass view of the options whose write seams refuse once the pass is
   * cancelled (ISSUE-310). Reads pass through untouched; `ledger.append`,
   * `ledger.prepare`, `port.apply` and `port.commit` check the fence first, so
   * an orphaned run cannot mutate the host array or append a ledger row after
   * cancellation releases the queue. An in-flight host call the engine already
   * started is the host's own write; the fence refuses every write the engine
   * would still make, and recovery reconciles whatever the host landed.
   */
  private fencedOptions(fence: { readonly cancelled: boolean }): EngineOptions {
    const o = this.options;
    const refuse = (): never => { throw new Error('the pass was cancelled'); };
    const ledger: Ledger = {
      prepare: application => { if (fence.cancelled) refuse(); return o.ledger.prepare(application); },
      append: event => { if (fence.cancelled) refuse(); return o.ledger.append(event); },
      events: sessionId => o.ledger.events(sessionId),
      recall: (id, options) => o.ledger.recall(id, options),
      close: () => o.ledger.close(),
      ...(o.ledger.export === undefined ? {} : { export: sessionId => o.ledger.export!(sessionId) }),
      ...(o.ledger.hydrate === undefined ? {} : { hydrate: archive => o.ledger.hydrate!(archive) }),
    };
    const port: ApplicationPort = {
      snapshot: () => o.port.snapshot(),
      apply: request => { if (fence.cancelled) refuse(); return o.port.apply(request); },
      lookupReceipt: intentId => o.port.lookupReceipt(intentId),
      ...(o.port.commit === undefined ? {}
        : { commit: () => { if (fence.cancelled) refuse(); return o.port.commit!(); } }),
    };
    const fenced: FencedOptions = { ...o, ledger, port, [PASS_FENCE]: fence };
    return fenced;
  }

  private cancelled(input: EngineInput, message: string): EngineResult {
    this.emit({ kind: 'error', eventId: input.eventId, stage: 'apply', message });
    return result('recovery-pending');
  }

  /**
   * Appends one validation row the entry lane authored itself (ADR-0022 §14:
   * one journal record names the code, and the reliability switch is not
   * incremented by an ask failure). The row is the replay record too: a later
   * pass finds it by event id and never replays the event.
   */
  private async journalValidation(
    input: EngineInput, o: EngineOptions, snapshot: SessionSnapshot, state: BreakerState,
    ok: boolean, issues: readonly ValidationIssue[],
  ): Promise<void> {
    const event = { kind: 'validation' as const, sessionId: o.sessionId,
      eventKey: `engine-validation:${JSON.stringify([o.sessionId, input.eventId])}`,
      atMs: o.clock.nowMs(), eventId: input.eventId, ok, issues: [...issues],
      breaker: state, engineTurnOrdinal: snapshot.currentTurnOrdinal };
    await o.ledger.append(event);
    this.emit({ kind: 'validation', eventId: input.eventId, ok, issues: event.issues, breaker: state });
  }

  /**
   * A plan-stage throw is the event's defect, not the engine's. It appends one
   * coded refusal and leaves the engine ready for the next pass (ISSUE-268).
   */
  private async refuseMalformed(
    input: EngineInput, o: EngineOptions, snapshot: SessionSnapshot, state: BreakerState,
    error: unknown, invalidation: PassInvalidation | null,
  ): Promise<EngineResult> {
    const detail = error instanceof Error ? error.message : 'the event could not be planned';
    const issue: ValidationIssue = { code: 'invalid-plan', ruleId: null,
      operationIndex: null, nodeId: input.kind === 'entry' ? input.result?.id ?? null : null,
      detail: `the ${String(input.kind)} event could not be planned: ${detail}` };
    await this.journalValidation(input, o, snapshot, state, false, [issue]);
    return { ...result('rejected', { ok: false, issues: [issue], breaker: state }), invalidation };
  }

  /**
   * One answered entry's decision (ISSUE-056; ADR-0022 §11–§14). A shape goes
   * to the guard; a refusal or keepall appends one coded validation row, so the
   * caller can distinguish them from an unplanned entry. The reliability switch
   * is unchanged: an ask failure does not count on it.
   */
  private async settleEntryAnswer(
    input: Extract<EngineInput, { readonly kind: 'entry' }>, o: EngineOptions,
    snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
    invalidation: PassInvalidation | null,
  ): Promise<EngineResult> {
    let decision: EntryShapePlan | null;
    try {
      decision = planEntryDecision(input, snapshot);
    } catch (error: unknown) {
      return this.refuseMalformed(input, o, snapshot, state, error, invalidation);
    }
    if (decision === null) {
      const issue = entryIssue('missing-stamp',
        'the answered entry carries no landed-unit stamp', input.result?.id ?? null);
      await this.journalValidation(input, o, snapshot, state, false, [issue]);
      return { ...result('rejected', { ok: false, issues: [issue], breaker: state }), invalidation };
    }
    if (decision.action === 'refuse') {
      const issue = entryIssue(decision.code, decision.detail, input.result?.id ?? null);
      await this.journalValidation(input, o, snapshot, state, false, [issue]);
      return { ...result('rejected', { ok: false, issues: [issue], breaker: state }), invalidation };
    }
    if (decision.action === 'keepall') {
      const issue = entryIssue('keepall',
        'the answer keeps everything; no operation is planned', input.result?.id ?? null);
      await this.journalValidation(input, o, snapshot, state, true, [issue]);
      return { ...result('unchanged'), invalidation };
    }
    const outcome = await this.guardAndApply(input, o, snapshot, [decision.plan], state,
      sealedEpisodeIds, nowMs);
    return { ...outcome, invalidation };
  }

  private async run(input: EngineInput, o: EngineOptions): Promise<EngineResult> {
    // 1. Copy the live snapshot and reconcile before any new planning.
    let snapshot = structuredClone(await o.port.snapshot());
    if (snapshot.sessionId !== o.sessionId) throw new Error('Snapshot belongs to another session');
    const recovery = await recoverPending(o.ledger, o.port, o.sessionId);
    this.reportConflicts(recovery.conflicts);
    if (recovery.status === 'blocked') {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'recovery-pending' });
      return { ...result('recovery-pending'), intentId: recovery.intentIds[0] ?? null };
    }
    if (recovery.status === 'reconciled') snapshot = structuredClone(await o.port.snapshot());
    if (snapshot.sessionId !== o.sessionId) throw new Error('Snapshot belongs to another session');
    const entries = await readEntries(o.ledger, o.sessionId);
    // 2. Rebuild episodes, then confirm committed seal state against host receipts.
    const episodes = detectEpisodes(o, snapshot);
    const committed = await committedState(entries, o.port);
    this.reportConflicts(committed.conflicts);
    if (committed.blocked) {
      // A receipt read that threw is the host failing, not refusing: no conflict
      // carries it, so name the intent and the skip before blocking (ISSUE-556).
      for (const failure of committed.unread) {
        this.emit({ kind: 'error', eventId: input.eventId, stage: 'recovery',
          message: `receipt read failed for ${failure.intentId}: ${failure.message}` });
      }
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'recovery-pending' });
      return result('recovery-pending');
    }
    const state = breakerState(entries);
    // A disable read from the ledger is history: it asks for its one notice and
    // never ends the pass, because ending it would leave no validation able to
    // clear it.
    if (state.disabled) {
      await persistBreaker(o, snapshot.currentTurnOrdinal, entries);
      const notice = await announceBreaker(o, this.telemetry, snapshot,
        await readEntries(o.ledger, o.sessionId), committed.notices);
      if (notice === 'blocked') return result('recovery-pending');
      // The notice is a host application: plan against the surface it produced.
      if (notice === 'appended') snapshot = structuredClone(await o.port.snapshot());
    }
    const prior = committed.events.get(input.eventId);
    if (committed.events.has(input.eventId)) {
      return { ...result(prior === null || prior === undefined ? 'unchanged' : 'applied'),
        intentId: prior?.intentId ?? null, receipt: prior ?? null };
    }
    if (this.unchangedEvents.has(input.eventId)) return result('unchanged');
    const priorValidation = entries.find(({ event }) => event.kind === 'validation'
      && event.eventId === input.eventId && !('engineCandidate' in event))?.event;
    if (priorValidation?.kind === 'validation') {
      // Validation persisted but no applied intent: never replay this event automatically.
      return priorValidation.ok ? result('unchanged') : result('rejected', {
        ok: false, issues: priorValidation.issues, breaker: priorValidation.breaker,
      });
    }
    if (input.kind !== 'entry' && input.kind !== 'at-rest'
      && input.kind !== 'prune' && input.kind !== 'forget') {
      // An unknown kind is the event's defect, not a rule pass: it journals one
      // coded row instead of falling through to skip / no-plan (ISSUE-268).
      const issue = invalidEventIssue((input as { readonly kind?: unknown }).kind);
      await this.journalValidation(input, o, snapshot, state, false, [issue]);
      return result('rejected', { ok: false, issues: [issue], breaker: state });
    }
    if (input.kind === 'entry' && input.answer === undefined
      && landedBytes(input.result) === null) {
      // An entry observation with no usable landed result cannot be planned;
      // it is refused by code and the next pass still runs (ISSUE-268).
      return this.refuseMalformed(input, o, snapshot, state,
        new Error('the entry event carries no landed result bytes'), null);
    }
    await this.refetch(input, entries);
    if (input.kind === 'at-rest' && !o.capabilities.atRest) return result('unchanged');
    const nowMs = o.clock.nowMs();
    // The write invalidation this pass plans against (PRD §6.7; ISSUE-045 chunk
    // C6). It is derived once per pass from the snapshot's own bytes, and the
    // snapshot the planners and the guard see drops the per-path coverage views
    // a write made stale. Transcript nodes are untouched: the invalidation is a
    // fact about them, not a change to them, so revisions and bases still hold.
    const invalidation = this.invalidationFor(snapshot);
    const planning = withoutStaleCoverage(snapshot, invalidation);
    const fact = passInvalidation(invalidation);
    // A prune event carries a pass already asked and merged; it never runs the
    // rules.
    if (input.kind === 'prune') {
      return { ...await this.settlePrune(input, o, planning, state,
        committed.sealedEpisodeIds, nowMs), invalidation: fact };
    }
    // A forget event is the human's own request; it never runs the rules either
    // (ISSUE-045 chunk C1). A refused request still reaches the guard, so the
    // refusal is recorded and counts on the breaker.
    if (input.kind === 'forget') {
      return { ...await this.settleForget(input, o, planning, state,
        committed.sealedEpisodeIds, nowMs), invalidation: fact };
    }
    // 3–4. Fresh zone and isolated rules share one base revision.
    //
    // An entry event under the land-first protocol (ISSUE-058 chunk P3a;
    // ADR-0022 §2): the host wrote the result BEFORE RACOONS saw it, so an
    // OBSERVATION plans nothing in place. The result is already a snapshot node,
    // so any unit over it is the tracker's ordinary mint from the snapshot's own
    // bytes, and the result stays landed whole. The rules never see this event,
    // and nothing is asked, marked or rewritten here; the entry checkpoint's ask
    // is the mount's, at its next legal append point. A DECISION exists only
    // when the mount collected an answer and hands it in on the same kind of
    // event; even then it is one shape over the LANDED unit, never an in-place
    // rewrite of a node on its way in (ADR-0022 §11–§12).
    // An answered entry is a DECISION, not a rule pass: it is planned by the
    // entry planner directly so a refusal reaches the caller as a coded row
    // (ISSUE-058 chunk P3a; ISSUE-268; ADR-0022 §11–§14).
    if (input.kind === 'entry' && input.answer !== undefined) {
      return this.settleEntryAnswer(input, o, planning, state, committed.sealedEpisodeIds,
        nowMs, fact);
    }
    let plans: RulePlan[];
    try {
      plans = input.kind === 'entry' ? []
        : planApplication(o, input, planning, episodes, committed.sealedEpisodeIds, nowMs);
    } catch (error: unknown) {
      // A malformed event is refused by code; the engine keeps running.
      return this.refuseMalformed(input, o, snapshot, state, error, fact);
    }
    if (plans.length === 0) {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return { ...result('unchanged'), invalidation: fact };
    }
    // 5–9. Guard, apply.
    const outcome = await this.guardAndApply(input, o, planning, plans, state,
      committed.sealedEpisodeIds, nowMs);
    return { ...outcome, invalidation: fact };
  }

  /**
   * Every unit and per-path view a write invalidated in this snapshot (PRD
   * §6.7; ISSUE-045 chunk C6). The tracker's own bar decides which units exist;
   * a below-bar result has no unit, so nothing about it can be refused.
   */
  private invalidationFor(snapshot: SessionSnapshot): Invalidation {
    const units = new UnitTracker({ sessionId: this.options.sessionId,
      barBytes: this.options.config.protocol.barBytes }).units(snapshot);
    return computeInvalidation({ snapshot, units });
  }

  /**
   * Applies one prune pass (ISSUE-022 chunk 4; ADR-0009). The pass has already
   * asked the model and merged its answers; this branch never asks. The whole
   * document becomes one verdict plan, so `guardAndApply` runs ONCE: one
   * `applyApplication`, one `port.apply`, one checkpoint-revert — exactly one
   * epoch break however many units the pass removes (the single approved revert
   * is the break; ADR-0009 defines it that way, so no second record exists).
   *
   * `input.round` is the pass's own ordinal, carried by the caller. The engine
   * keeps no pass state across events, so nothing here can be resumed from; a
   * host that persists pass rounds must write them to its entry store and
   * replay them. That entry store is where `round` must plug in — this branch
   * only consumes it.
   */
  private async settlePrune(
    input: Extract<EngineInput, { kind: 'prune' }>, o: EngineOptions,
    snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    if (o.config.protocol.enforcement === 'record-only') {
      // Explicit opt-out: the pass's record belongs to the pass; nothing applies.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    if (o.capabilities.revertHistory !== true) {
      // The seam a checkpoint-revert needs is not declared: report, never apply.
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'unsupported-capability' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    let plans: RulePlan[];
    try {
      plans = planApplication(o, input, snapshot, [], sealedEpisodeIds, nowMs);
    } catch (error: unknown) {
      return this.refuseMalformed(input, o, snapshot, state, error, null);
    }
    if (plans.length === 0) {
      // Nothing left to remove (a replayed document over changed bytes).
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    return this.guardAndApply(input, o, snapshot, plans, state, sealedEpisodeIds, nowMs);
  }

  /**
   * Applies one manual forget request (PRD §6.2; ISSUE-045 chunk C1). The
   * human's request is planned by `engine/forget.ts` and applied through the
   * same `guardAndApply` every other removal uses, so a forget is one
   * checkpoint-revert with one receipt — and any refusal removes nothing and
   * counts on the breaker like every validation failure.
   *
   * A request that resolves to no unit still reaches the guard: its
   * `checks-forget` re-derives the resolution independently and records
   * `unresolved-request`, and the breaker sees the refusal. Planning nothing
   * and skipping the guard would let a bad request pass silently.
   *
   * `record-only` is the session's explicit opt-out of enforcement, so it takes
   * a forget exactly as it takes a prune pass: recorded, applied nothing.
   */
  private async settleForget(
    input: Extract<EngineInput, { kind: 'forget' }>, o: EngineOptions,
    snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    if (o.config.protocol.enforcement === 'record-only') {
      // The session's explicit opt-out of enforcement takes a forget exactly as
      // it takes a prune pass: nothing applies, and no replay applies it.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    let plans: RulePlan[];
    try {
      plans = planApplication(o, input, snapshot, [], sealedEpisodeIds, nowMs);
    } catch (error: unknown) {
      return this.refuseMalformed(input, o, snapshot, state, error, null);
    }
    return this.guardAndApply(input, o, snapshot, plans, state, sealedEpisodeIds, nowMs);
  }

  /**
   * The session's one guard. The breaker is session state, so rebuilding the
   * guard per pass would throw its accounting away; the injected guard wins when
   * a host supplies one. The ledger seeds it once, at the first pass.
   */
  private guardFor(state: BreakerState): Guard {
    const injected = this.options.guard;
    if (injected !== undefined) return injected;
    this.guard ??= new Guard({ ledger: this.options.ledger, initialState: state });
    return this.guard;
  }

  /**
   * The guard and apply block shared by rule events and the prune/forget
   * applications. It persists the validation event before deciding, applies
   * nothing on a rejection, and reports the approved revert when the host
   * accepted it.
   */
  private async guardAndApply(
    input: EngineInput, o: EngineOptions, snapshot: SessionSnapshot,
    plans: readonly RulePlan[],
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const guard = this.guardFor(state);
    // A cancelled pass's late run must not touch the session's one breaker:
    // `validate` records success or failure on it, and the fenced append below
    // would then throw, so the mutation never reaches the journal and the
    // in-memory streak stops agreeing with the record the notice claims
    // (ISSUE-489). Reads pass the fence, so reaching here cancelled is exactly
    // that orphaned run.
    if ((o as FencedOptions)[PASS_FENCE]?.cancelled === true) {
      return this.cancelled(input, 'the pass was cancelled before validation');
    }
    // ISSUE-605: one preflight against the live session. When it moved since
    // the snapshot these plans were made from and every removal source is still
    // at its own index (appends only), the same plans are prepared again
    // against the live nodes — which re-prices the revert — and applied with
    // the live base revision. There is no second look: a change after this
    // point is refused by the port's existing `stale-revision` reason.
    const live = await o.port.snapshot();
    const target = live.revision !== snapshot.revision && removalSpanIntact(plans, snapshot, live)
      ? live : snapshot;
    const validation = await guard.validate({ input, snapshot: target,
      capabilities: o.capabilities, config: o.config, plans,
      sealedEpisodeIds, nowMs });
    const validationEvent = { kind: 'validation' as const, sessionId: o.sessionId,
      eventKey: `engine-validation:${JSON.stringify([o.sessionId, input.eventId])}`,
      atMs: nowMs, eventId: input.eventId, ok: validation.ok,
      issues: validation.ok ? [] : validation.issues, breaker: validation.breaker,
      engineTurnOrdinal: target.currentTurnOrdinal };
    this.emit({ kind: 'validation', eventId: input.eventId, ok: validation.ok,
      issues: validationEvent.issues, breaker: validation.breaker });
    // A transient storage refusal is not the event's verdict (ISSUE-313 is the
    // only source of the `ledger-io` code). Journaling it as an ok:false row
    // would make the replay check below answer `rejected` for the event forever
    // once storage recovered; skipping the row leaves the event retryable, and
    // the pass answers the same retryable result the prepare-throw path does
    // (ISSUE-488; ISSUE-309).
    if (!validation.ok && validation.issues.length > 0
      && validation.issues.every(issue => issue.code === 'ledger-io')) {
      return result('recovery-pending', validation);
    }
    if (!validation.ok) {
      await o.ledger.append(validationEvent);
      if (validation.breaker.disabled) {
        // A refusal while the breaker is already quiet appends no marker, so it
        // reports no disable: the telemetry must match the ledger's one row.
        const appended = await persistBreaker(o, snapshot.currentTurnOrdinal,
          await readEntries(o.ledger, o.sessionId));
        if (appended) this.emit({ kind: 'breaker-disabled', consecutiveValidationFailures: 2 });
      }
      return result(validation.breaker.disabled ? 'disabled' : 'rejected', validation);
    }
    if (validation.application.replacements.length + validation.application.appendRecords.length === 0) {
      await o.ledger.append(validationEvent);
      return result('unchanged', validation);
    }
    try {
      const applied = await applyApplication(o, this.telemetry, validation.application);
      // The ok row is journaled only after the apply settles: a prepare throw
      // leaves the event retryable, not short-circuited to `unchanged` forever
      // (ISSUE-309). A throw below skips this append, so the retry re-applies.
      await o.ledger.append(validationEvent);
      const revert = validation.application.revert;
      if (applied.status === 'applied' && revert !== undefined) {
        this.emit({ kind: 'revert-applied', cutIndex: revert.cutIndex,
          freedBytes: revert.cost.freedBytes, keptBytes: revert.cost.keptBytes,
          receiptBytes: revert.cost.receiptBytes, netFreedBytes: revert.cost.netFreedBytes,
          salvageShare: salvageShare(revert.cost.keptBytes, revert.cost.freedBytes),
          survivorCount: revert.survivors.length, survivors: revert.survivors });
      }
      return { ...applied, validation };
    } catch (error: unknown) {
      this.emit({ kind: 'error', eventId: input.eventId, stage: 'ledger',
        message: error instanceof Error ? error.message : 'Ledger preparation failed' });
      return result('recovery-pending', validation);
    }
  }

  private async refetch(input: EngineInput, entries: readonly LedgerEntry[]): Promise<void> {
    if (input.kind !== 'entry' || this.seenRefetches.has(input.eventId)) return;
    // Hashing is the first dereference of the landed result, and a hand-built
    // event may carry no result or non-byte bytes. Hashing such an event would
    // throw into `runControlled` before its decision row exists, so the guard
    // returns here and lets the entry branch journal the code. The id is not
    // recorded, so the malformed event never looks refetched (ISSUE-268).
    const bytes = landedBytes(input.result);
    if (bytes === null) return;
    this.seenRefetches.add(input.eventId);
    const hash = await sha256(bytes);
    const applied = new Set(entries.flatMap(({ event }) => event.kind === 'applied'
      ? [event.receipt.intentId] : []));
    const emitted = new Set<string>();
    for (const { event } of entries) {
      const details = metadata(event);
      if (event.kind !== 'prepared' || details === null || !applied.has(event.intentId)) continue;
      for (const item of details.sources) {
        if (item.source.sha256 !== hash
          || item.source.byteLength !== bytes.length || emitted.has(item.recallId)) continue;
        emitted.add(item.recallId);
        this.emit({ kind: 'refetch', sourceSha256: item.source.sha256,
          recallId: item.recallId, fetchedBytes: bytes.length });
      }
    }
  }
}