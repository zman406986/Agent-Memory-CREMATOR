/**
 * The OpenCode 2.2.5 mount entry: the racoons engine, the port, the recall tool
 * and the step meter wired onto the hooks the host exposes (ISSUE-192;
 * ADR-0044; ADR-0017).
 *
 * **The mount is a function of (the request messages, the ledger) and nothing
 * else.** It assumes `context.session.hook("context", cb)` hands over the
 * request's own `messages` array and that the array it commits is the request
 * the model receives; that is an assumption about the host, not a fact this
 * package can prove. The mount re-derives the snapshot from *that* array, runs
 * one at-rest pass, and lets the port commit its staged derivation in place. The
 * bench's captured request bodies are what test the assumption on a host: a
 * removal the ledger records must be absent from the next request with its twin's
 * own result still present. Nothing else in the array is touched, and a request
 * with nothing staged leaves the array byte-identical.
 *
 * The other seams:
 *   - `session.hook("context")` → the at-rest pass, then the prune pass (the
 *     same order as dsh). The bench-only ask (`crematorAskGrammar`, absent =
 *     off) calls `session.generate` once on a depth crossing that still holds a
 *     tableable unit. The pass is core's `planPrunePass`: L1
 *     (`stale-exact-reread`, `closed-episode`, `byte-identical-duplicates`),
 *     the superseded-read dedupe (default off), and every remaining unit above
 *     the 512 floor as one table row, with no row cap. A readable `forgetall`
 *     applies with the pass's L1 and dedupe removals through one core prune
 *     document (ADR-0054); a `keepall` keeps and re-tables at a later crossing;
 *     `keeplines`/`forgetlines` are refused `action-not-in-grammar` because the
 *     host's typed tool-result part cannot carry a partial keep. A failed ask or
 *     an unreadable reply is an `ask-error`, never a fire; a timeout is an
 *     `ask-error` too and is terminal for its units (the abandoned host call
 *     cannot be cancelled, so they keep their claim and no retry); a refused row
 *     is carried to one later table, and a terminal refusal spends no re-ask.
 *     Fires follow the depth trigger with no per-session cap (ADR-0060). The
 *     asked set lives in memory: a plugin reload loses it.
 *   - `context.command.transform` (when the host exposes it) → the manual
 *     `/cremate` command. It runs the same table pass on demand, not gated by
 *     the depth latch; the same-revision guard still applies, and the pass
 *     re-arms the latch like any completed pass.
 *   - `tool.transform` → both declared tools: `necromancy` (restore) and
 *     `forget` (schedule a manual removal that applies at the next request
 *     boundary through the engine's `{kind: 'forget'}` event).
 *   - `session.idle` (event) → one turn-end observation. The shipped mount
 *     makes no model call here and runs no applying pass: the idle carries no
 *     array the host will send, so the next step pass plans and commits from the
 *     array the host rebuilds. The bench-only ask keeps a fallback on this seam,
 *     and only when the last step ask did not fire for its revision, so a
 *     delivered idle never asks a second time for one turn.
 *   - `session.deleted` (event) → lifecycle eviction (ISSUE-379): after the
 *     ISSUE-356 drain settles the mount's in-flight work, the deleted session's
 *     entry leaves the open map and its owned ledger closes through the same
 *     release `close()` uses. The host's deletion is the only trigger; no cap,
 *     no LRU, no timeout (ADR-0060).
 *   - `session.compaction.started|delta|ended|failed` → journalled with their
 *     phase and counts. A host compaction is never reported as a `forced-loss`;
 *   - `tool.hook("execute.after")` → one observation of the tool and call id.
 *     The product never caps or rewrites a result body (ADR-0048): the host's
 *     own `ToolOutput.truncate` runs as it ships, and an oversized result is
 *     left whole by this mount;
 *   - `tool.transform` → the `necromancy` tool, always registered. The host's
 *     editor takes JSON Schema, so this package needs no host factory at mount.
 *     The tool carries `options.codemode: false`: the host names only tools
 *     with that exact flag in a request's tool table, and folds every other
 *     registered tool into the code-mode catalog behind its `execute` tool.
 *
 * **Capability honesty.** The engine is built with
 * `createOpencodeCapabilities({ wireRevert: true })`, and the port receives the
 * derivation `src/apply.ts` exports — the pair the constructor refuses to let
 * exist apart. `revertHistory: true` rests on `test/wire-revert.test.ts`.
 *
 * **Storage.** Each session owns one durable ledger under the configured root.
 * A refused root or session id is journalled (`storage-unavailable`) and the
 * request proceeds with the array untouched; the open is retried at the next
 * hook (ADR-0013 ruling 4).
 *
 * **Auto-compaction stays on.** The pass reads and writes `messages` only; the
 * optional `excludeTools` deletion touches `context.tools`. Neither touches
 * `context.options`. No config is written by this package and none disables
 * `compaction.auto` (ADR-0043).
 *
 * **Subagent off for a test harness.** 2.2.5 offers the subagent tool as
 * `subagent` (the built-in `opencode.tool.subagent`; the legacy name `task` is a
 * display/permission alias the host normalizes). A `tool.use` deny policy stops
 * calls but still offers the tool; the mount's `excludeTools` option deletes the
 * name from `context.tools`, which is the request's own tool table
 * (`Object.entries(R.tools ?? {})` builds the request in the binary).
 * `OPENCODE_TEST_EXCLUDE_TOOLS` is the exported value `["subagent"]` a harness
 * passes as that option. No environment variable is read: the constant is a
 * value from code, and a host config carries the same list under the JSON key
 * `excludeTools`.
 *
 * **The journal can be a file.** `options.journal` is a function, which a JSON
 * config cannot carry. A host that wants durable evidence names an absolute
 * path in `crematorJournalFile`; the mount appends one JSON record per line to
 * that file. A write failure is swallowed: a journal sink must never change an
 * outcome (ADR-0013; the bench reads the file as evidence).
 */

import {
  CharHeuristicTokenMeter, DEFAULT_CONFIG, Meter, PruneWindowTrigger, RacoonsEngine,
  UnitTracker, applyPruneAnswers, createDefaultRules, descriptorIssue,
  resolveContextWindowTokens, resolvePruneThresholdTokens,
} from '@cremator/core';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ApplicationPort, CapabilityFlags, Clock, DedupeClasses, ForgetRequest, Ledger,
  MeterReading, NodeId, PruneAnswerRow, PruneAskRow, PrunePassApplication, PrunePassPlan,
  PruneRemoval, RequestPrefix, SessionSnapshot, ToolResultNode, UnitId, WireAnswer,
} from '@cremator/core';
import {
  deriveOpencodeRevert, opencodeBankedRemovalOf, opencodeLiveResults, opencodeRetentionOf,
} from './apply.js';
import type { OpencodeAppliedPlan, OpencodeAppliedPlanIndex } from './apply.js';
import {
  buildOpencodeAskBatch, buildOpencodePassPlan, isSeenUnit, readOpencodeAskAnswer,
  OPENCODE_ASK_FLOOR_BYTES, OPENCODE_ASK_GRAMMAR,
} from './ask.js';
import type { OpencodeAskBatch, OpencodeAskGrammar } from './ask.js';
import { createOpencodeCapabilities } from './capabilities.js';
import {
  decideOpencodeForget, forgetAnswer, readOpencodeForgetArgs,
} from './forget.js';
import type { OpencodeForgetValue } from './forget.js';
import type {
  OpencodeAfterToolInput, OpencodeGenerateInput, OpencodeGenerateOutput,
  OpencodeHostEvent, OpencodeIdleHookInput, OpencodeMessage, OpencodePluginContext,
  OpencodePluginDefinition, OpencodeSessionContext, OpencodeTextPart, OpencodeToolDefinition,
} from './host.js';
import {
  costOf, estimateRequestSplit, estimateRequestTokens, isAskStepRequest, requestKindOf,
  requestPrefixOf, stepEndedRow, tokenUsageOf, usageObservation,
} from './meter.js';
import type { OpencodeUsageRow } from './meter.js';
import { createOpencodePort, opencodeAppliedPlansFromLedger } from './port.js';
import type {
  OpencodeApplyRefusal, OpencodeCommitKind, OpencodePortOptions, OpencodePortSnapshotOptions,
} from './port.js';
import { OPENCODE_RECORD_PREFIX, opencodeToolNodeId } from './snapshot.js';
import { OpencodeStorageError, openLedger, resolveStorage, sessionStorage } from './storage.js';
import type { OpencodeStorageOptions, StorageTarget } from './storage.js';
import {
  OPENCODE_RECALL_TOOL_NAME, createOpencodeForgetTool, createOpencodeTool,
} from './tools.js';

/** Stable plugin identity a host log line can name. */
export const OPENCODE_PLUGIN_NAME = 'cremator-opencode';

/** The name 2.2.5 gives the subagent tool (the built-in `opencode.tool.subagent`). */
export const OPENCODE_SUBAGENT_TOOL = 'subagent';

/**
 * The manual command this mount registers through `context.command.transform`
 * when the host exposes that seam. The host lists and invokes it as `/cremate`.
 */
export const OPENCODE_PRUNE_COMMAND = 'cremate';

/** The harness setting that leaves the subagent tool out of the request. */
export const OPENCODE_TEST_EXCLUDE_TOOLS: readonly string[] = Object.freeze([OPENCODE_SUBAGENT_TOOL]);

/**
 * What a failed ask retries. The units are released after a failed generate or
 * an unreadable parse and claimed again before the retry, and a unit that has
 * used its retry is never released again: at most one retry, only on a revision
 * after the failure (the failed revision itself stays claimed, so idle re-entry
 * cannot loop the transient call). A timeout does not use this retry: it is
 * terminal for its units (`askOnce`), because the abandoned host call may still
 * be running.
 */
export const OPENCODE_ASK_RETRY = 'next revision at most once';

/**
 * What a refused row retries (ADR-0050 decision 3; PRD §6.2/§6.5). A readable
 * table that refuses a row carries that row's unit to one later table; a second
 * refusal is final. A row answered keep or remove is not a refusal and never
 * spends this retry. A terminal `action-not-in-grammar` refusal — an action the
 * prompt does not offer, `keeplines` or `forgetlines` — spends no re-ask at all:
 * a second identical question cannot change the reading (ADR-0053 §3, as
 * amended for this host).
 */
export const OPENCODE_ASK_REFUSED_RETRY =
  'one later table; a second refusal is final; an action the prompt does not offer is terminal';

/**
 * The ask's own deadline (ISSUE-300 item 12). The dsh mount bounds its stream
 * ask at `DEFAULT_ASK_TIMEOUT_MS` (120,000 ms); this host's
 * `session.generate` takes no `AbortSignal` (`host.ts` `OpencodeGenerateInput`
 * is `{sessionID, prompt}`), so the mount races the promise against this
 * deadline and journals a timeout as an ask error, never a fire. The
 * underlying request may still complete in the host; the lane does not wait
 * for it and does not count it. The timeout is terminal for the ask's units:
 * they stay claimed and are never generated again for that unit, so a second
 * request cannot run beside the abandoned one.
 */
export const OPENCODE_ASK_TIMEOUT_MS = 120_000;

/** The seams this build wires. A host that lacks one fails to mount, loudly. */
export const OPENCODE_MOUNT_SEAMS: readonly string[] = Object.freeze([
  'session.hook.context',
  'event.subscribe',
  'tool.hook.execute.after',
  'tool.transform',
]);

/**
 * The journal vocabulary, closed: a typo in a `journal('...')` call is a compile
 * error, so a host-facing line can never drift from the list a reader greps.
 */
export type OpencodeJournalKind =
  | 'mounted'
  | 'capabilities'
  | 'storage-plan'
  | 'storage-unavailable'
  | 'at-rest'
  | 'at-rest-error'
  | 'telemetry'
  | 'usage-reconciled'
  | 'usage-missing'
  | 'estimate-dropped'
  | 'compacted'
  | 'tool-observed'
  | 'tool-error'
  | 'event-error'
  | 'session-evicted'
  | 'idle-hook-error'
  | 'prune-threshold'
  | 'prune-plan'
  | 'command-error'
  | 'cremate'
  | 'forget-scheduled'
  | 'forget'
  | 'forget-error'
  | 'ask'
  | 'ask-error'
  | 'ask-apply'
  | 'ask-retained'
  | 'ask-cancel'
  | 'commit'
  | 'transform'
  | 'transform-error';

export interface OpencodeJournalRecord {
  readonly kind: OpencodeJournalKind;
  readonly atMs: number;
  readonly [field: string]: unknown;
}

export type OpencodeJournalSink = (record: OpencodeJournalRecord) => void;

/**
 * The event id one step pass carries. The base revision names the request's
 * content; `rewrites` is how many plans the ledger has already applied at that
 * same revision. The first rewrite keeps the bare revision, so a ledger written
 * before this scheme is still read; every later delivery of the same content
 * gets its own suffix.
 *
 * Why the count: `rewriteHistory: false` says the host rebuilds each request
 * from its own store, so the array a prior pass rewrote is discarded and the
 * same base revision comes back with the removed unit still in it. The engine's
 * replay guard reads a committed event id as work the live array already shows,
 * so a second delivery under the first id returns the prior receipt and
 * commits nothing. A distinct id makes the second delivery a new pass, which is
 * what an unpersisted removal needs. The array a pass itself left is never in
 * that position: its revision is the receipt's result revision, not this base.
 */
export function opencodeStepEventId(
  sessionId: string, revision: string, rewrites: number,
): string {
  return rewrites === 0
    ? `oc:${sessionId}:step:${revision}`
    : `oc:${sessionId}:step:${revision}#${String(rewrites + 1)}`;
}

/**
 * The event id one ask apply carries (ADR-0054 decision 5). Its own `ask`
 * namespace, never the step lane's: the at-rest event at that revision owns
 * `oc:<session>:step:<revision>`, and a shared id would return that event's
 * `unchanged` or receipt instead of applying the ask's removals.
 *
 * `rewrites` is the same durable count the step lane reads, taken at the
 * apply-time revision (the array observed after the at-rest commit, not the
 * ask's base): a rebuilt request at that revision gets a new suffix, so a
 * second apply is a new pass rather than a replay of the first.
 */
export function opencodeAskEventId(
  sessionId: string, revision: string, rewrites: number,
): string {
  return rewrites === 0
    ? `oc:${sessionId}:ask:${revision}`
    : `oc:${sessionId}:ask:${revision}#${String(rewrites + 1)}`;
}

/**
 * How many plans the ledger has already applied at this exact base revision,
 * read through the public `Ledger` seam. A restarted process counts the same
 * rewrites a live one does: `rehydrateOnResume: false` loses the port's
 * in-process index, never this durable count.
 *
 * An applied receipt at this revision is also the cheap content check: a
 * receipt's result revision always differs from its base (`receiptMatches`),
 * so an application at this revision necessarily removed something and left a
 * different array. An incoming array still at this revision is therefore the
 * *before* copy — the host's original, not the pass's result — and needs the
 * pass again. No node scan is needed; the count is the durable fact.
 *
 * **Cost (ISSUE-300 item 18): O(passes) per call, O(passes²) over a segment.**
 * The ledger writes one applied event per pass, and under `rewriteHistory:
 * false` the host rebuilds every request, so a stored removal is re-applied and
 * an applied row lands per request, not per crossing. The walk is therefore
 * O(passes) per call and O(passes²) over a segment, and it runs once per request
 * boundary plus once per ask apply — never per removal.
 *
 * Measured on `dev/bench/opencode-ledger-scale.mjs` at the 105-task length
 * (1,050 requests = 105 × 10, from the lane's measured 95 consecutive pairs
 * over 10 tasks), with one stored verdict re-applied per request: 1,049
 * applied rows, 5,245 ledger events, and a worst whole-ledger walk of 5,241
 * events (54.6 ms; 65.3 ms when four removals are re-applied per request). The
 * scan is accepted at that size: the worst walk is tens of milliseconds against
 * a model request of seconds, and the pass count, not the removal count, sets
 * it. A cache was rejected because the ledger is the durable record of record:
 * a second mount on the same storage, or a plugin reload, would make an
 * in-memory count stale, and the invalidation rule costs more than the walk at
 * this size. The `ask-apply` journal's own growth (one line per removal per
 * request) is measured and named as a follow-up in the audit record; this scan
 * does not change it.
 *
 * Exported for the bound tests (ISSUE-300 item 18): a 10,000-event ledger is
 * walked once, and the mount's calls do not grow with the removal count.
 */
export async function appliedRewritesAt(
  ledger: Ledger, sessionId: string, revision: string,
): Promise<number> {
  let rewrites = 0;
  for await (const { event } of ledger.events(sessionId)) {
    if (event.kind === 'applied' && event.receipt.baseRevision === revision) rewrites += 1;
  }
  return rewrites;
}

/** One measured request: the revision it described and the estimate it cost. */
export interface OpencodeRequestEstimate {
  readonly revision: string;
  readonly inputTokens: number;
}

/**
 * One session's stored ask verdicts: the readable `forgetall` answers only,
 * keyed by the unit each names, with the ask fire round on
 * `verdict.answeredInRound`. A `keepall` is a keep, never a stored verdict, and
 * a `keeplines`/`forgetlines` reply is a terminal `action-not-in-grammar`
 * refusal that keeps the unit and is never re-asked (ADR-0053 §Amendment
 * 2026-11-19). The map lives in the session entry and nowhere else; a plugin
 * reload loses it, like every asked mark.
 */
export type OpencodeAskVerdicts = Map<UnitId, WireAnswer>;

export interface OpencodeSessionEntry {
  readonly sessionId: string;
  readonly ledger: Ledger;
  readonly port: OpencodeMountPort;
  /**
   * The mounted port's applied-plan index (the same live map the port hands its
   * derivation), seeded at session open from the ledger's applied rows and
   * captured through the mount's `deriveRevert` wrapper. The ask pre-check reads
   * it so a unit a prior pass — or a prior process — already banked is
   * re-applied, not treated as a first-time offer (`opencodeBankedRemovalOf`).
   * A port factory that neither honours the seed nor calls the wrapper leaves it
   * empty, and every verdict reads as a first-time offer again.
   */
  appliedPlans: OpencodeAppliedPlanIndex;
  readonly engine: RacoonsEngine;
  readonly meter: Meter;
  /** The session's depth latch (ADR-0050); disabled when no bar/window is set. */
  readonly pruneTrigger: PruneWindowTrigger;
  /**
   * The superseded-read dedupe classes this mount runs (ADR-0037). Absent
   * classes are off; the shipped default is every class off, exactly dsh's.
   */
  readonly dedupeClasses: DedupeClasses;
  /** True when this mount opened the ledger (and must close it at dispose). */
  readonly ownedLedger: boolean;
  /**
   * The array the last context hook handed in, held by reference for the idle
   * path: `session.idle` carries no array, so the turn-end observation reads the
   * last one and journals its revision. The step ask reads it before the step
   * pass commits, and the idle fallback reads it after that commit.
   */
  lastMessages: readonly OpencodeMessage[] | null;
  /**
   * The estimates of the requests this mount has measured, oldest first. Each
   * `session.step.ended` row consumes one entry, so a row that arrives after the
   * next context hook has already run is still measured against the request it
   * answers, never against a fresh estimate computed after the fact. A `null`
   * entry is a request whose pass failed: its row is journalled `usage-missing`,
   * not paired with a later estimate.
   */
  readonly pendingEstimates: (OpencodeRequestEstimate | null)[];
  /**
   * How many oldest estimates the 16-entry bound has dropped whose rows have
   * not arrived yet (ISSUE-358). Rows arrive in request order, one per
   * transform, so the next `droppedEstimates` main rows answer requests whose
   * estimate is gone: each is journaled unmeasured (`estimate-dropped`)
   * WITHOUT shifting the queue, which keeps every later row paired with its
   * own request. The bound itself is unchanged (owner standing rule 7).
   */
  droppedEstimates: number;
  /** Assistant message ids already fed to the meter: one message is one request. */
  readonly usageSeen: Set<string>;
  /**
   * The ask state (bench-only). `askedUnitIds` is the permanent claim: a unit
   * answered `forgetall`, a unit whose one refusal retry was refused again, and
   * a unit with an ask in flight. A unit answered keep is removed from it, so a
   * later revision tables the unit again; `askedRevisions` is the re-entry guard
   * that stops a second ask on the same revision however the claim moved.
   */
  readonly askedUnitIds: Set<UnitId>;
  readonly askedRevisions: Set<string>;
  /** Units that have already spent their one retry after a failed ask. */
  readonly retriedUnitIds: Set<UnitId>;
  /**
   * Units whose row this session refused and whose one re-ask has not been
   * tabled yet. The unit is released from `askedUnitIds` when it enters this
   * set, so the next revision tables it once; a second refusal moves it back to
   * the permanent claim, and a keep answer clears it.
   */
  readonly refusedRetriedUnitIds: Set<UnitId>;
  /**
   * The readable `forgetall` answers this session's ask has read, keyed by the
   * unit each names. A `keepall` answer is a keep and is not stored; a
   * `keeplines`/`forgetlines` reply is a terminal refusal and is not stored
   * either (ADR-0053 §Amendment 2026-11-19).
   */
  readonly askVerdicts: OpencodeAskVerdicts;
  /**
   * Node ids an already-sent request has carried: the ask table and the stored
   * verdicts read this set, so a result that first appears in the step being
   * transformed is tabled on the next request, never the one that produced it
   * (ADR-0054 decision 7). It only grows; the first request's set is empty and
   * asks and applies nothing.
   */
  readonly seenNodeIds: Set<NodeId>;
  /**
   * Node ids the most recent transform's commit shipped. Promoted into
   * `seenNodeIds` at the start of the next transform, so an idle fallback that
   * runs after the transform — the turn that produced the result — still reads
   * the eligibility of the previous request.
   */
  pendingSeenNodeIds: Set<NodeId>;
  /**
   * True when the last `context` hook's step ask left one readable reply. The
   * step ask is primary; the idle ask is a fallback only while this is false, so
   * one turn never asks twice even when the step pass changed the revision.
   */
  stepAskFired: boolean;
  /**
   * True while one ask's `generate` call is in flight. A host whose generate
   * request re-enters this hook, or an idle that races a step ask, must not
   * stack a second table over the same units.
   */
  askInFlight: boolean;
  /**
   * Timed-out `generate` calls still live in the host (ISSUE-396). The timeout
   * clears `askInFlight` so the lane never waits, but the abandoned call can
   * still end a step: while one lives AND this session has seen an ask step
   * row (`askStepRowsSeen`), an unstated step row is the ask lane's, never a
   * main turn's — the same classification the in-flight lock makes. Each
   * abandoned call decrements this when it truly settles. A count of live
   * abandoned calls, never a ceiling (ADR-0060).
   */
  abandonedAsks: number;
  /**
   * True once this session saw a step row for the ask lane — a declared
   * `ask`/`generate` kind, or an unstated row during a live ask (ISSUE-357).
   * Vanilla 2.2.5 emits no generate step row, so it stays false there and the
   * ISSUE-396 abandoned-call guard never touches main accounting; a host that
   * emits ask rows opens the guard for its timed-out calls' late rows.
   */
  askStepRowsSeen: boolean;
  /** Fires this session has recorded: one per readable ask reply. Uncapped; it
   * is a count of fires issued, never a ceiling (ADR-0060). */
  askFires: number;
  /**
   * The pass round stamp. Every plan this session builds gets the next value;
   * the engine's prune batch requires a positive round and every assigned
   * index is stamped with it. It is per-process, like the asked set: the
   * ledger's event ids are content-addressed, so a reload cannot collide.
   */
  passRound: number;
  /**
   * True once one pass document carrying L1 or dedupe removals applied. While
   * it is true, every later transform rebuilds the pass even without a new
   * crossing, because this host discards the rewritten array and the rebuild
   * must re-apply the removals the ledger banked (`rewriteHistory: false`).
   */
  passRemovalsApplied: boolean;
  /**
   * True when an idle or `/cremate` fire stored at least one `forgetall`
   * verdict that the next step transform must apply. Those paths cannot apply
   * (the idle array is not the request the host sends), so their depth latch
   * must not re-arm on the next pre-apply observation: that observation still
   * contains the bytes the verdicts will remove. The next step transform
   * suppresses it and applies; when the apply removed bytes it leaves the
   * baseline pending, and the first HOST reading after the removal becomes the
   * baseline (ADR-0050; audit 1 and the re-audit).
   */
  deferredApply: boolean;
  /**
   * Consecutive failed applies of the current deferred pass. The first failure
   * keeps the pass deferred for exactly one retry; the second drops the
   * stored verdicts so a permanent guard rejection cannot suppress every
   * later depth observation for the session (ISSUE-300 G1). Reset by a new
   * idle//cremate fire and by a completed or dropped pass.
   */
  deferredFailures: number;
  /**
   * The last turn ordinal `session.idle` said was complete, recorded from the
   * idle's own observed snapshot. The next transform passes it to the port, so
   * a same-turn rebuild can plan a closed episode; the snapshot takes
   * `max(fact, currentTurn - 1)`, so it never claims the unfinished turn.
   * Null until the first idle.
   */
  completedThroughTurnOrdinal: number | null;
  /**
   * Node ids the prune document currently being applied names with a
   * `closed-episode` L1 proof. Set only around `engine.process` and cleared in a
   * finally. The port's retention check lets exactly these error results
   * through: `error-result-retained` otherwise keeps every failure statement,
   * while a closed-episode proof is the product's decision that the closed
   * episode's miss bodies may leave (ADR-0049 keeps `appendRecords: false` on
   * this host and still plans the rule; the negative fact is the one part not
   * paid for). No other lane is exempt.
   */
  applyingClosedEpisodeNodes: ReadonlySet<NodeId> | null;
  /**
   * Manual forgets the `forget` tool resolved and queued. Drained at the next
   * request boundary, after the at-rest commit, through the engine's
   * `{kind: 'forget'}` event; a drain never re-queues (the engine dedupes by
   * event id). A reload loses the queue, like every other in-memory mark.
   */
  readonly pendingForgets: PendingForget[];
  /** The request's fixed system + tool prefix, for the idle fallback's reading. */
  lastPrefix: RequestPrefix | null;
}

/** One resolved manual forget waiting for the next request boundary. */
export interface PendingForget {
  readonly eventId: string;
  readonly unitId: UnitId;
  readonly request: ForgetRequest;
}

/** One pass apply's inputs: the session, the post-at-rest array and its window. */
export interface OpencodeAskApplyInput {
  readonly entry: OpencodeSessionEntry;
  /** The request array the host handed in, after the at-rest commit. */
  readonly messages: readonly OpencodeMessage[];
  /** The snapshot of `messages` taken after the at-rest commit. */
  readonly snapshot: SessionSnapshot;
  /**
   * The configured host context window when one is set; otherwise the whole
   * request estimate computed after the at-rest commit. The apply is skipped
   * unless this is a positive safe integer; the guard refuses a non-positive
   * window, so the mount never passes `null` or `0`.
   */
  readonly window: number;
  /**
   * The configured host window when the mount has one, or null in the
   * per-revision lane. `window` above may be an estimate there; the journal
   * uses this field to name the host window honestly and to put the estimate
   * under `contentEstimate` instead (ISSUE-300 item 14).
   */
  readonly hostWindow?: number | null;
  /**
   * The pass this apply settles. The transform builds it once for the table and
   * the apply; a direct caller (a test, a rig) may omit it and one is built
   * from `snapshot` at `round`.
   */
  readonly plan?: PrunePassPlan | null;
  /** The pass round when `plan` is omitted; defaults to the entry's next round. */
  readonly round?: number;
  /**
   * The accepted answers from this fire, already gated by
   * `readOpencodeAskAnswer`: only `forgetall` re-encoded here becomes a
   * removal; a `keepall` removes nothing. The raw reply text is never handed
   * to the core merge, so an action the prompt did not offer cannot slip
   * through the adapter's gate.
   */
  readonly answers?: ReadonlyMap<UnitId, WireAnswer>;
  /**
   * Plan rows the ledger already banked and the table therefore did not ask
   * (ISSUE-300 item 6). Each is re-applied as a whole-unit `forgetall` with a
   * blank summary, so a prior removal stays in effect after a restart without a
   * new question; the port reuses the receipt line its recall id already names.
   */
  readonly bankedRows?: readonly PruneAskRow[];
  /**
   * The mounted port's applied-plan index. Defaults to `entry.appliedPlans`,
   * the map the mount captured from the port's own derivation; a caller that
   * holds the index itself (a test, a rig) may pass it here instead.
   */
  readonly appliedPlans?: OpencodeAppliedPlanIndex;
  readonly journal: (kind: OpencodeJournalKind, fields: Record<string, unknown>) => void;
}

/**
 * The release a survivor-gate cancellation makes (ISSUE-300 items 5 and 8):
 * every cancellation drops its stored verdict, and when the unit HAD a stored
 * verdict the cancellation releases it from the permanent claim and the
 * retry/refusal records too, whatever lane planned the removal. A verdict on a
 * unit no cancellation drops is not this call's business: a cancellation for a
 * unit with no stored verdict releases nothing, because no ask claim is being
 * un-settled. An `l1`/dedupe cancellation of a verdict-holding unit must not
 * keep the claim: the verdict is gone, so a later crossing has to be able to
 * ask the unit again. Exported so the one release rule is testable without a
 * constructed contradiction the planner cannot produce.
 */
export function releaseCancelledUnits(
  entry: OpencodeSessionEntry,
  cancellations: readonly { readonly unitId: UnitId;
    readonly origin: 'l1' | 'dedupe' | 'l2' }[],
): void {
  for (const cancellation of cancellations) {
    const hadVerdict = entry.askVerdicts.delete(cancellation.unitId);
    if (!hadVerdict) continue;
    /**
     * The unit goes back to unclaimed, including the retry record: a unit that
     * spent its one failed-ask retry and then answered `forgetall` would
     * otherwise be permanently claimed once its verdict is cancelled, with no
     * verdict left to apply and no later failed ask able to release it
     * (ISSUE-300 audit bugs 3 and 5).
     */
    entry.askedUnitIds.delete(cancellation.unitId);
    entry.retriedUnitIds.delete(cancellation.unitId);
    entry.refusedRetriedUnitIds.delete(cancellation.unitId);
  }
}

/**
 * Applies one pass's decision document (ADR-0054 decisions 1-5): the stored
 * `forgetall` verdicts plus the pass's own L1 and dedupe removals, through the
 * engine's single `{kind: 'prune'}` path.
 *
 * Runs after the at-rest commit and before the shipped estimate is pushed, so
 * the step row measures the array this apply leaves. The document is core's
 * own merge (`applyPruneAnswers`): L1 proofs first, the dedupe's proof removals
 * beside them, then the judged `forgetall` rows, with the survivor gate over
 * the whole document. A cancelled verdict releases its unit, whatever lane
 * planned the cancelled removal, so a later crossing can table it again
 * (ISSUE-300 items 5 and 8); a cancellation with no stored verdict releases
 * nothing, because no ask claim is being un-settled.
 *
 * The guards, in order:
 *   - no apply while an ask is in flight (the ask request is never transformed);
 *   - no apply unless `window` is a positive safe integer;
 *   - a verdict whose unit is absent from the post-at-rest pass is dropped (the
 *     at-rest lane won, or the host dropped it); a verdict whose unit the seen
 *     set does not carry is dropped too (it was never sent);
 *   - a verdict whose unit the retention rules keep is dropped and journalled
 *     `ask-retained` (ISSUE-259, ISSUE-269), unless the unit is already banked
 *     by a prior applied plan: a banked removal stays in effect;
 *   - a verdict the guard rejects terminally (`descriptor-too-long`) is dropped
 *     after the rejection, so every rebuilt request does not retry it;
 *   - a non-`forgetall` verdict is dropped. The reader never stores one; this
 *     covers a legacy in-memory row, and the host cannot apply a partial keep.
 *
 * A re-application on a later request is expected: `rewriteHistory: false`
 * means the host rebuilds the request, so the stored verdict (and every L1 and
 * dedupe removal, which the fresh plan recomputes) is applied again under a new
 * `ask` event id. That is the removal staying in effect, not a new removal.
 *
 * Returns `true` only when this call landed a new applied receipt and the port
 * committed a visible rewrite. A replayed id answers with a prior receipt and
 * commits nothing, so it journals `applied: false`.
 */
export async function applyOpencodeAskVerdicts(
  input: OpencodeAskApplyInput,
): Promise<boolean> {
  const { entry, messages, snapshot, window, journal } = input;
  /**
   * The journal names the configured host window only when the mount has one.
   * In the bench-only per-revision lane `window` is a content estimate, so it
   * is journalled under `contentEstimate`, never presented as a host window
   * (ISSUE-300 item 14).
   */
  const hostWindow = input.hostWindow ?? null;
  const windowField = hostWindow === null
    ? { contentEstimate: window } : { window: hostWindow };
  if (entry.askInFlight) return false;
  if (!Number.isSafeInteger(window) || window <= 0) return false;
  const plan = input.plan ?? buildOpencodePassPlan({
    sessionId: entry.sessionId, snapshot, messages,
    round: input.round ?? Math.max(1, entry.passRound),
    ...(entry.dedupeClasses === undefined ? {} : { classes: entry.dedupeClasses }),
  });
  if (plan === null) {
    // Every unit left the array: no stored verdict can name one any more. The
    // claim and retry records go with each verdict, or a restored unit would
    // stay permanently claimed with nothing left to apply (ISSUE-300 item 8).
    for (const unitId of entry.askVerdicts.keys()) {
      entry.askedUnitIds.delete(unitId);
      entry.retriedUnitIds.delete(unitId);
      entry.refusedRetriedUnitIds.delete(unitId);
    }
    entry.askVerdicts.clear();
    return false;
  }
  const unitBy = new Map(plan.units.map(unit => [unit.id, unit] as const));
  const rowOfUnit = new Map(plan.askRows.map(row => [row.unit.id, row] as const));
  /**
   * The stored verdicts and this fire's accepted answers, keyed by unit. A
   * `keepall` carries no removal and is simply absent from the merge; only a
   * `forgetall` is re-encoded into the core's wire notation.
   */
  const wanted = new Map<UnitId, WireAnswer>(entry.askVerdicts);
  for (const [unitId, answer] of input.answers ?? []) wanted.set(unitId, answer);
  /**
   * A banked row is a prior process's removal the array still carries. It comes
   * back as a whole-unit `forgetall` with a blank summary, so the removal stays
   * in effect without a new question; the port renders the line its recall id
   * already names, so the receipt bytes do not change (ISSUE-300 item 6).
   */
  const bankedUnitIds = new Set<UnitId>();
  for (const row of input.bankedRows ?? []) {
    bankedUnitIds.add(row.unit.id);
    if (wanted.has(row.unit.id)) continue;
    wanted.set(row.unit.id, { verdict: {
      unitId: row.unit.id, action: 'forgetall', summary: '',
      answeredInRound: plan.round,
    } });
  }
  const live = opencodeLiveResults(messages, entry.sessionId);
  const appliedPlans = input.appliedPlans ?? entry.appliedPlans;
  const nodeIds = snapshot.nodes.map(node => node.id);
  const entries: [string, Record<string, unknown>][] = [];
  const indices: number[] = [];
  for (const [unitId, answer] of wanted) {
    const unit = unitBy.get(unitId);
    const row = rowOfUnit.get(unitId);
    /**
     * A banked removal is exempt from the current process's seen set: the
     * ledger's applied row proves a prior request already carried the unit, and
     * a resumed segment's first request must not ship bytes the product already
     * removed (ISSUE-300 item 6). Every other verdict still needs a sent node.
     */
    if (unit === undefined || row === undefined
      || (!bankedUnitIds.has(unitId) && !isSeenUnit(unit, entry.seenNodeIds))) {
      entry.askVerdicts.delete(unitId);
      /**
       * The array no longer carries the unit, so the current verdict cannot be
       * applied. That is not a permanent settlement: unless a banked removal
       * owns the claim, the retry and refusal records go with the verdict, so a
       * restore or rebuilt array that carries the unit again can table it
       * (ISSUE-300 audit bug 4). A banked removal keeps its claim: its applied
       * row proves a prior request carried it, and it is re-applied, never
       * re-asked.
       */
      if (!bankedUnitIds.has(unitId)) {
        entry.askedUnitIds.delete(unitId);
        entry.retriedUnitIds.delete(unitId);
        entry.refusedRetriedUnitIds.delete(unitId);
      }
      continue;
    }
    if (answer.verdict.action !== 'forgetall') {
      // The prompt offers no partial action, and a literal keep removes
      // nothing. A legacy row of either shape is not applied.
      entry.askVerdicts.delete(unitId);
      continue;
    }
    /**
     * A stored summary the wire parser would refuse is terminal here: the
     * reader never stores one, so this is a legacy in-memory row, and keeping
     * it would refuse the same row on every rebuilt request (ISSUE-269). It is
     * dropped before the merge, and named.
     */
    if (descriptorIssue(answer.verdict.summary ?? '') !== null) {
      entry.askVerdicts.delete(unitId);
      journal('ask-error', {
        sessionId: entry.sessionId, revision: snapshot.revision, origin: 'step',
        stage: 'descriptor', unitId, nodeId: unit.nodeId, code: 'summary-too-long',
        message: 'a stored forgetall summary runs past the receipt descriptor limit; the row '
          + 'is dropped and the unit keeps',
      });
      continue;
    }
    const banked = opencodeBankedRemovalOf(unit.nodeId, appliedPlans,
      messages, entry.sessionId, nodeIds);
    if (!banked) {
      const retention = opencodeRetentionOf(unit.nodeId, live);
      if (retention !== null) {
        entry.askVerdicts.delete(unitId);
        const detail = retention.code === 'recall-answer-retained'
          ? "the unit is the necromancy tool's own answer; the product never removes its "
            + 'restore payload'
          : retention.code === 'error-result-retained'
            ? 'the unit is an error or a cancelled-tool result; the product never removes '
              + 'a failure statement'
            : "the unit's exact result text is contained in the live result "
              + `${String(retention.containedInNodeId)}`;
        journal('ask-retained', {
          sessionId: entry.sessionId, revision: snapshot.revision,
          unitId, nodeId: unit.nodeId, code: retention.code,
          containedInNodeId: retention.containedInNodeId, applied: false, detail,
        });
        continue;
      }
    }
    entries.push([String(row.index), { forgetall: answer.verdict.summary ?? '' }]);
    indices.push(row.index);
  }
  journal('prune-plan', { sessionId: entry.sessionId, round: plan.round,
    units: plan.units.length, askRows: plan.askRows.length,
    l1Removals: plan.l1.removals.length, dedupeRemovals: plan.dedupe.removals.length,
    answerRows: entries.length, ...windowField });
  const texts = entries.length === 0 ? [] : [JSON.stringify(Object.fromEntries(entries))];
  let document: PrunePassApplication;
  try {
    document = applyPruneAnswers(plan, texts, { indices, stamps: plan.stamps });
  } catch (error) {
    // A caller bug in core's merge is named, never left to stall the request.
    journal('ask-error', { sessionId: entry.sessionId, origin: 'step', stage: 'merge',
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
  /**
   * A survivor-gate cancellation keeps the content and is named (ISSUE-174).
   * The line carries the event id of the pass that cancelled, so a run can tie
   * it to the `ask-apply` rows beside it; then the unit is released so a later
   * crossing can put it to the model again. A verdict a rebuilt request
   * re-applied would cancel the same way forever (ISSUE-300 item 5).
   *
   * The event id is computed before the release and before the no-removals
   * return: a pass where every removal was cancelled still has to name its
   * cancellations (and release their claims).
   */
  const rewrites = await appliedRewritesAt(entry.ledger, entry.sessionId, snapshot.revision);
  const eventId = opencodeAskEventId(entry.sessionId, snapshot.revision, rewrites);
  for (const cancellation of document.cancellations ?? []) {
    journal('ask-cancel', {
      sessionId: entry.sessionId, revision: snapshot.revision, eventId,
      round: plan.round, unitId: cancellation.unitId, origin: cancellation.origin,
      rule: cancellation.rule, reason: cancellation.reason,
      conflictsWithUnitId: cancellation.conflictsWithUnitId,
    });
  }
  releaseCancelledUnits(entry, document.cancellations ?? []);
  if (document.removals.length === 0) return false;
  if (plan.l1.removals.length + plan.dedupe.removals.length > 0) {
    entry.passRemovalsApplied = true;
  }
  /**
   * The closed-episode node ids travel to the port only for the duration of
   * this apply. The port's retention rule normally keeps an error result; a
   * closed-episode proof is the product's decision that the closed episode's
   * miss bodies are the removable content (ADR-0049 plans the rule on this host
   * with no appended negative fact). Every other lane stays refused.
   */
  const closedEpisodeNodes = new Set<NodeId>();
  for (const removal of document.removals) {
    if (removal.origin !== 'l1' || removal.rule !== 'closed-episode') continue;
    const nodeId = unitBy.get(removal.unitId)?.nodeId;
    if (nodeId !== undefined) closedEpisodeNodes.add(nodeId);
  }
  const result = await (async () => {
    entry.applyingClosedEpisodeNodes = closedEpisodeNodes.size > 0 ? closedEpisodeNodes : null;
    try {
      return await entry.engine.process({
        kind: 'prune', eventId, round: plan.round, verdicts: document, window,
      });
    } finally {
      entry.applyingClosedEpisodeNodes = null;
    }
  })();
  /**
   * A guard refusal the same content causes on every rebuilt request is terminal
   * (ISSUE-269): drop the offending verdict so the next transform does not retry
   * a removal the guard can never accept. The path this build produces is
   * `descriptor-too-long`; the ask reader refuses a 26-word summary before
   * storage too, and this drop covers a verdict already in the map.
   */
  if (result.validation !== null && !result.validation.ok) {
    const refusedNodes = new Set<NodeId>();
    for (const issue of result.validation.issues) {
      if (issue.code === 'descriptor-too-long' && issue.nodeId !== null) {
        refusedNodes.add(issue.nodeId);
      }
    }
    for (const [unitId, unit] of unitBy) {
      if (refusedNodes.has(unit.nodeId)) entry.askVerdicts.delete(unitId);
    }
  }
  const committed = result.committed === true || entry.port.commit();
  const applied = committed && result.status === 'applied' && result.receipt !== null;
  const refusal = entry.port.refusal?.() ?? null;
  const recallIds = applied
    ? recallIdsByForgottenNode(messages, result.intentId) : new Map<string, string>();
  for (const removal of document.removals) {
    const nodeId = unitBy.get(removal.unitId)?.nodeId ?? null;
    journal('ask-apply', {
      sessionId: entry.sessionId, eventId, round: plan.round,
      unitId: removal.unitId, nodeId,
      /** The host window when one is configured, else the content estimate. */
      ...windowField,
      origin: removal.origin,
      ...(bankedUnitIds.has(removal.unitId) ? { banked: true } : {}),
      ...(removal.origin === 'dedupe' ? { rule: removal.rule }
        : removal.origin === 'l1' ? { rule: removal.rule }
          : { action: removal.action }),
      intentId: result.intentId,
      recallId: nodeId === null ? null : recallIds.get(nodeId) ?? null,
      applied, status: result.status, committed,
      removals: document.removals.length,
      ...(result.validation?.ok === false ? { issues: result.validation.issues } : {}),
      ...(refusal === null ? {} : { refusal: {
        code: refusal.code, reason: refusal.reason, detail: refusal.detail,
      } }),
    });
  }
  return applied;
}

/**
 * The recall id each committed receipt message names, keyed by the node the
 * receipt replaced. The receipt is the adapter's own and its line ends on the
 * id; reading it here lets the journal name the id without re-deriving the
 * ledger's archive record.
 */
function recallIdsByForgottenNode(
  messages: readonly OpencodeMessage[], intentId: string | null,
): Map<string, string> {
  const ids = new Map<string, string>();
  if (intentId === null) return ids;
  const prefix = `${OPENCODE_RECORD_PREFIX}${intentId}:`;
  for (const message of messages) {
    const recordId = message.racoonsRecordId;
    if (typeof recordId !== 'string' || !recordId.startsWith(prefix)) continue;
    const forgotten = message.racoonsForgottenNodeId;
    if (typeof forgotten !== 'string') continue;
    const text = message.content
      .filter((part): part is OpencodeTextPart => part.type === 'text'
        && typeof part['text'] === 'string')
      .map(part => part.text)
      .join('');
    const recallId = /· necromancy (\S+)$/u.exec(text)?.[1];
    if (recallId !== undefined) ids.set(forgotten, recallId);
  }
  return ids;
}

export interface OpencodeMountOptions {
  readonly storage?: OpencodeStorageOptions;
  /** A host-owned ledger opener, for a test or a host that already has one. */
  readonly openLedger?: (target: StorageTarget, clock: Clock) => Promise<Ledger>;
  /** The port factory; the shipped mount uses `createOpencodePort`. */
  readonly createPort?: (options: OpencodePortOptions) => OpencodeMountPort;
  readonly journal?: OpencodeJournalSink;
  /**
   * A durable journal: one JSON record per line, appended to this path. The
   * function sink a test supplies wins when both are set. This is the option a
   * JSON host config can carry (`crematorJournalFile`), because a function
   * cannot cross a config file.
   */
  readonly journalFile?: string;
  readonly nowMs?: () => number;
  /**
   * Tool names to delete from `context.tools` before the request is built. The
   * test harness uses `OPENCODE_TEST_EXCLUDE_TOOLS` to leave the subagent tool
   * out; no other host setting removes an offered tool.
   */
  readonly excludeTools?: readonly string[];
  /**
   * The product's depth trigger (ADR-0050): the absolute token bar and the host
   * window. With neither, the bench-only ask keeps its per-revision cadence.
   * `pruneThresholdTokens` requires `contextWindowTokens` (the 75% skip line
   * needs the window), refused at mount otherwise.
   */
  readonly contextWindowTokens?: number | null;
  readonly pruneThresholdTokens?: number | null;
  /**
   * The superseded-read dedupe classes (ADR-0037), passed straight to the pass
   * planner. Absent means every class is off (dsh's shipped default); the lane
   * is wired and can be enabled, never silently on.
   */
  readonly dedupeClasses?: DedupeClasses;
  /**
   * The bench-only entry ask. Absent is off; `jsonl-20-nokeepall` asks one
   * `session.generate` question per fire and applies nothing. A host config
   * spells it `crematorAskGrammar`.
   */
  readonly askGrammar?: OpencodeAskGrammar;
  /**
   * The host seam the ask calls: 2.2.5's `session.generate`. Required when
   * `askGrammar` is set; `createOpencodePlugin` supplies the host's own method
   * after checking it exists.
   */
  readonly askGenerate?: (
    input: OpencodeGenerateInput,
  ) => Promise<OpencodeGenerateOutput>;
  /**
   * The ask's deadline, in milliseconds. Defaults to the dsh mount's own
   * `DEFAULT_ASK_TIMEOUT_MS` (120,000). A non-positive value disables the race;
   * the lane then waits for the host, and the journal says the deadline was off.
   */
  readonly askTimeoutMs?: number;
}

/**
 * The port surface the mount drives: the core `ApplicationPort` plus the two
 * staging calls the context hook owns (`observe`, `commit`).
 */
export interface OpencodeMountPort extends ApplicationPort {
  observe(
    messages: readonly OpencodeMessage[], options?: OpencodePortSnapshotOptions,
  ): SessionSnapshot;
  commit(): boolean;
  /**
   * Drop the retained turn-end fact, when the port keeps one (ISSUE-362). A
   * native compaction restarts the surface's turn ordinals, so the mount calls
   * this on `session.compaction.ended` next to resetting its own recorded fact;
   * the next no-fact observation then falls back to `currentTurn - 1`. A port
   * that does not expose it keeps the snapshot clamp as its only guard.
   */
  clearCompletedTurnFact?(): void;
  /**
   * What the last `commit()` that spliced did, when the port keeps it. A
   * `cleanup` splice changed the array without applying a plan, so the mount
   * names it on the commit line (`reason: 'cleanup'`) and a reader does not
   * count it as an applied pass with no at-rest row. A port that does not
   * expose it is not refused; its commit lines simply carry no `reason`.
   */
  lastCommitKind?(): OpencodeCommitKind | null;
  /**
   * The refusal the last `apply` answered, when the port keeps one. The mount
   * journals it on the at-rest line so a rejected plan's own code (a
   * `tool-pair-split`, an `intent-conflict`) is visible, not collapsed to the
   * core's three reasons. A port that does not expose it is not refused; the
   * line simply carries no `refusal` field.
   */
  refusal?(): OpencodeApplyRefusal | null;
  /**
   * The live applied-plan index the port hands its derivation, when it keeps
   * one. The mount seeds that index from the ledger at session open and reads it
   * for the ask pre-check before the first derivation; a port factory that does
   * not expose it keeps the empty seed.
   */
  appliedPlanIndex?(): OpencodeAppliedPlanIndex;
}

export interface OpencodeMount {
  readonly sessions: Map<string, OpencodeSessionEntry>;
  /** The recall tool the mount registers through `context.tool.transform`. */
  readonly tool: OpencodeToolDefinition;
  /**
   * The manual `forget` tool, when this build registers it. `null` only when a
   * mount was built without a handler (never on the shipped mount).
   */
  readonly forgetTool: OpencodeToolDefinition | null;
  /**
   * One `context` hook firing. `context` is the same payload's fixed
   * system/tools prefix, used by the pre-first-usage depth fallback; a caller
   * that omits it gets a transcript-only reading and the journal says `content`.
   */
  transform(
    sessionId: string, messages: readonly OpencodeMessage[],
    context?: Pick<OpencodeSessionContext, 'system' | 'tools'> | null,
  ): Promise<void>;
  /** One manual forget call: resolve and queue it, answering the tool value. */
  forget(sessionId: string, args: unknown): Promise<OpencodeForgetValue>;
  /** One host event firing. Unknown event types are ignored, not guessed at. */
  event(event: OpencodeHostEvent): Promise<void>;
  /**
   * One `tool.hook("execute.after")` firing. Observation only: the product never
   * caps or rewrites a result body (ADR-0048), so the result object is read and
   * left untouched for the host's own truncation to handle as it ships.
   */
  afterTool(input: OpencodeAfterToolInput): Promise<void>;
  /**
   * One manual `/cremate`: the same table pass, on demand and not gated by the
   * depth latch. Returns `true` only when the pass recorded a readable fire.
   * The same-revision guard still applies, and the pass re-arms the latch like
   * any completed pass (ADR-0050 decision 3).
   */
  cremate(sessionId: string): Promise<boolean>;
  /**
   * One awaited `session.hook('experimental.idle')` firing (ADR-0062 D2,
   * ISSUE-373): the idle-origin ask, inside the seam the host's single drain
   * awaits, so a new prompt queues behind it instead of being backgrounded.
   * Observe/turn-fact stays on `event('session.idle')`; a re-entrant firing
   * while an ask is in flight is skipped whole (the ISSUE-353 guard family).
   */
  idle(sessionId: string): Promise<void>;
  /**
   * True while the idle-origin ask runs on the `session.idle` event path (the
   * fallback for a host without the awaited hook). `createOpencodePlugin` sets
   * it false once the `experimental.idle` hook registers, so the event path
   * keeps only observe/turn-fact and one turn never asks twice.
   */
  idleAskOnEvent: boolean;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The file-backed journal sink. One record per line, appended, with the parent
 * directory created on the first write. A failure is swallowed: the journal is
 * evidence, and evidence must never change what the mount does.
 */
export function createFileJournalSink(path: string): OpencodeJournalSink {
  let ready = false;
  return (record) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch { /* a journal sink must never change an outcome */ }
  };
}

/**
 * The one ask grammar a host config may name, or null when the option is absent
 * or empty. Any other value is refused by name: a typo must never silently turn
 * the bench ask off, and a grammar this build does not measure must never mount.
 */
function askGrammarOf(value: unknown): OpencodeAskGrammar | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === OPENCODE_ASK_GRAMMAR) return value;
  throw new TypeError(`racoons: crematorAskGrammar is ${JSON.stringify(value)}; `
    + `the only grammar this build measures is "${OPENCODE_ASK_GRAMMAR}"`);
}

/** Read the config tuple's options: storage root, the ask, the exclusion, the journal. */
export function mountOptionsFromHost(options: unknown): OpencodeMountOptions {
  if (!isRecord(options)) return {};
  const root = options['crematorStorageRoot'];
  const journalFile = options['crematorJournalFile'];
  const excluded = options['excludeTools'];
  const asked = askGrammarOf(options['crematorAskGrammar']);
  const contextWindowTokens = options['crematorContextWindowTokens'];
  const pruneThresholdTokens = options['crematorPruneThresholdTokens'];
  const dedupeClasses = dedupeClassesOf(options['crematorDedupeClasses']);
  const askTimeoutMs = options['crematorAskTimeoutMs'];
  const names = Array.isArray(excluded)
    ? excluded.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : undefined;
  return {
    ...(typeof root === 'string' && root.length > 0
      ? { storage: { crematorStorageRoot: root } } : {}),
    ...(typeof journalFile === 'string' && journalFile.length > 0 ? { journalFile } : {}),
    ...(names === undefined ? {} : { excludeTools: names }),
    ...(asked === null ? {} : { askGrammar: asked }),
    ...(contextWindowTokens === undefined || contextWindowTokens === null
      ? {} : { contextWindowTokens: contextWindowTokens as number }),
    ...(pruneThresholdTokens === undefined || pruneThresholdTokens === null
      ? {} : { pruneThresholdTokens: pruneThresholdTokens as number }),
    ...(dedupeClasses === null ? {} : { dedupeClasses }),
    ...(typeof askTimeoutMs === 'number' ? { askTimeoutMs } : {}),
  };
}

/**
 * The dedupe switches a host config may name. Only the two classes this build
 * can plan are accepted (`supersededByReread`, `callEcho`, ADR-0037); a value
 * that is not an object or a field that is not a boolean is refused by name, so
 * a typo cannot silently leave a class off (or on).
 */
function dedupeClassesOf(value: unknown): DedupeClasses | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError('racoons: crematorDedupeClasses must be an object of boolean switches');
  }
  const classes: { supersededByReread?: boolean; callEcho?: boolean } = {};
  for (const key of ['supersededByReread', 'callEcho'] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      throw new TypeError(`racoons: crematorDedupeClasses.${key} must be a boolean`);
    }
    classes[key] = raw;
  }
  return classes;
}

/**
 * Build the mount runtime. Separated from the plugin factory so a test can drive
 * the context hook, the idle event and the tool observer directly, with the real
 * engine and the real ledger, and read the journal as plain objects.
 */
export function createOpencodeMount(options: OpencodeMountOptions = {}): OpencodeMount {
  /**
   * Validate the grammar here too, not only through `mountOptionsFromHost`: a
   * programmatic caller (a test, a rig, a JS host) can pass any string, and an
   * unknown grammar must never mount and then silently table nothing.
   */
  const checkedGrammar = askGrammarOf(options.askGrammar);
  const askGrammar = checkedGrammar === null ? undefined : checkedGrammar;
  if (askGrammar !== undefined && typeof options.askGenerate !== 'function') {
    // Loud at construction: an ask this mount cannot send is a bug, not a
    // silently recorded absence.
    throw new TypeError('cremator: askGrammar needs the host session.generate seam; '
      + 'no askGenerate was supplied');
  }
  // The product's depth trigger (ADR-0050). Both numbers are optional; with
  // neither, the bench-only ask keeps its per-revision cadence. A bar without a
  // window is refused: the 75% skip line and the half-window compatibility path
  // both need the window.
  const contextWindowTokens = resolveContextWindowTokens(options.contextWindowTokens ?? null);
  const pruneThresholdTokens = resolvePruneThresholdTokens(options.pruneThresholdTokens ?? null);
  if (pruneThresholdTokens !== null && contextWindowTokens === null) {
    throw new Error('cremator: pruneThresholdTokens requires contextWindowTokens '
      + '(the 75% skip line needs the host window)');
  }
  /**
   * A depth trigger with no ask lane schedules nothing: this adapter's only
   * table is the ask, so a configured bar/window that cannot fire is refused at
   * mount instead of riding the journal as an inert setting (ISSUE-300 item 13).
   */
  if (askGrammar === undefined && (contextWindowTokens !== null || pruneThresholdTokens !== null)) {
    throw new Error('cremator: contextWindowTokens/pruneThresholdTokens configure the ask lane; '
      + 'without askGrammar there is no table to fire, so the trigger would be inert');
  }
  const askTimeoutMs = options.askTimeoutMs ?? OPENCODE_ASK_TIMEOUT_MS;
  if (!Number.isFinite(askTimeoutMs) || askTimeoutMs < 0) {
    throw new Error('cremator: askTimeoutMs must be a non-negative millisecond count');
  }
  const clock: Clock = { nowMs: options.nowMs ?? (() => Date.now()) };
  const emit: OpencodeJournalSink = options.journal
    ?? (options.journalFile === undefined ? () => {} : createFileJournalSink(options.journalFile));
  const journal = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
    try {
      emit(Object.freeze({ kind, atMs: clock.nowMs(), ...fields }));
    } catch { /* a journal sink must never change an outcome */ }
  };
  // Resolved once, at mount: an unusable root is a refusal now, not at a user's
  // first request. A relative root and a durable pair are typed refusals (C3).
  const selection = resolveStorage(options.storage);
  const sessions = new Map<string, OpencodeSessionEntry>();
  /**
   * Set once `close()` starts (ISSUE-393). The per-session release awaits
   * ledger closes, and a host hook delivered during those awaits must neither
   * transform a still-mapped entry whose ledger close is next in the loop
   * (the ISSUE-356 closed-ledger write class) nor re-open a released session's
   * handle the consumed key snapshot never revisits. `sessionFor` refuses new
   * work from here on — every transform, forget and recall routes through it;
   * work already in flight still settles through the ISSUE-356 drain first.
   * Idempotent: a second close finds the flag set and the map empty.
   */
  let closing = false;
  /**
   * In-flight mount work (ISSUE-356): every transform, event, tool call and
   * cremate the host started and has not finished. `close()` drains these
   * before closing the ledgers, so an ask that resolves after dispose never
   * writes a closed ledger and the event loop never operates on closed state.
   * An ask is already bounded by the declared ask timeout, so the drain cannot
   * hang beyond it; no new cap, bound or timeout is added here.
   */
  const inFlight = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    const settled = (): void => { inFlight.delete(work); };
    void work.then(settled, settled);
    return work;
  }
  /**
   * The ISSUE-356 drain: every tracked transform, event, tool call and cremate
   * settles before a ledger closes, so a post-dispose ask resolution never
   * writes a closed ledger. The loop re-checks because a settling item can hand
   * off to another tracked call; asks carry the declared ask timeout, so the
   * drain is bounded by the host's own declared deadline, not a new cap.
   * `except` is the caller's own tracked promise — the `session.deleted`
   * eviction runs inside one — so the drain never awaits itself.
   */
  async function drainInFlight(except?: Promise<unknown>): Promise<void> {
    for (;;) {
      const pending = [...inFlight].filter(work => work !== except);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }
  /**
   * Release one session's open state — the same path `close()` uses per entry
   * (ISSUE-379): the entry leaves the open map and, when this mount opened the
   * ledger, the ledger closes (a close failure is swallowed, as at dispose).
   * Idempotent: an already-released or never-opened session returns false and
   * nothing is closed twice. Lifecycle eviction only — no cap, no LRU, no
   * timeout (standing rule 7 / ADR-0060).
   */
  async function releaseSession(sessionId: string): Promise<boolean> {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return false;
    sessions.delete(sessionId);
    if (entry.ownedLedger) await entry.ledger.close().catch(() => {});
    return true;
  }
  /** Sessions already journalled `storage-unavailable`; the line is written once. */
  const unavailable = new Set<string>();
  /** The last session a context hook saw, so a context-free recall names a ledger. */
  let activeSessionId: string | null = null;
  /**
   * Where the idle-origin ask runs (ADR-0062 D2, ISSUE-373). Default is the
   * `session.idle` event path; the plugin flips it false when the awaited
   * `experimental.idle` hook registers, moving the ask into the seam the
   * host's drain waits on.
   */
  let idleAskOnEvent = true;
  /**
   * The mount's own estimate meter. Separate from each session's reconciliation
   * meter so `meter.latest()` is only ever a provider reading, never an estimate
   * that happened to be computed last.
   */
  const estimateMeter = new Meter(new CharHeuristicTokenMeter());
  // The earned declaration: `revertHistory: true` beside the derivation that
  // performs it. The pair is C4-checked both ways, so neither half can ship alone.
  //
  // The bench-only ask changes the honesty of `atRest`: the context hook (with
  // the idle fallback) makes one transient model call per fire, so the
  // declaration says `atRest: false` when it is on. The engine is a separate
  // claim — the at-rest PASS still makes no model call and remains the only
  // applied-removal path — so it receives `atRest: true` and the journal records
  // both values by name.
  const declared: CapabilityFlags = createOpencodeCapabilities({
    wireRevert: true, askEnabled: askGrammar !== undefined,
  });
  const engineCapabilities: CapabilityFlags = declared.atRest
    ? { ...declared } : Object.freeze({ ...declared, atRest: true });

  function refuseStorage(sessionId: string, error: unknown): void {
    if (unavailable.has(sessionId)) return;
    unavailable.add(sessionId);
    const storageError = error instanceof OpencodeStorageError ? error : null;
    journal('storage-unavailable', {
      sessionId,
      code: storageError?.code ?? 'unexpected',
      path: storageError?.path ?? null,
      message: error instanceof Error ? error.message : String(error),
      node: process.version,
    });
  }

  async function sessionFor(sessionId: string): Promise<OpencodeSessionEntry | null> {
    // ISSUE-393: once close() starts, no new session work — a still-mapped
    // entry's ledger close may be next, and a released session must not re-open.
    if (closing) return null;
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    let target: StorageTarget;
    try {
      target = sessionStorage(selection, sessionId);
    } catch (error) {
      refuseStorage(sessionId, error);
      return null;
    }
    const open = options.openLedger ?? openLedger;
    let ledger: Ledger;
    try {
      ledger = await open(target, clock);
    } catch (error) {
      // A transient open failure is retried at the next hook: the session is not
      // remembered, so the next `sessionFor` tries the real open again.
      refuseStorage(sessionId, error);
      return null;
    }
    unavailable.delete(sessionId);
    journal('storage-plan', { sessionId, databasePath: target.databasePath,
      blobRoot: target.blobRoot, node: process.version });
    /**
     * A restart loses the port's in-process applied-plan index, so the durable
     * ledger is read once here: an `applied` row joined to its prepared event's
     * archive sources names every unit that process banked. A ledger read that
     * throws seeds nothing (the safe side: the unit is a first-time offer) and
     * never blocks the request.
     */
    let seededAppliedPlans: readonly OpencodeAppliedPlan[] = [];
    try {
      seededAppliedPlans = await opencodeAppliedPlansFromLedger(ledger, sessionId);
    } catch { /* the request proceeds without a seed; nothing is claimed */ }
    // The declared flags, not a caller's wish: the mount passes the pair it
    // declares, `{wireRevert: true}` beside `deriveOpencodeRevert`, and the port
    // refuses either half without the other (C4; plan §7 C7).
    const capabilities: CapabilityFlags = { ...declared };
    /**
     * The port's applied-plan index is created by the port and mutated per
     * intent; the mount never sees it except through the derivation it supplies.
     * This wrapper keeps the port's own map reference on the session entry, so
     * the ask pre-check reads exactly the committed fact the wire derivation
     * reads instead of judging a banked removal as a first-time offer. A custom
     * factory that never calls the wrapper leaves the entry's index empty.
     */
    let mountedEntry: OpencodeSessionEntry | null = null;
    const port = (options.createPort ?? createOpencodePort)({
      sessionId, clock, capabilities, appliedPlans: seededAppliedPlans,
      deriveRevert: (request, messages, index) => {
        if (mountedEntry !== null) mountedEntry.appliedPlans = index;
        return deriveOpencodeRevert(request, messages, index,
          mountedEntry?.applyingClosedEpisodeNodes ?? null);
      },
    });
    const meter = new Meter(new CharHeuristicTokenMeter());
    const engine = await RacoonsEngine.open({
      sessionId,
      // The pass itself stays model-free; the declared `atRest` above is about
      // the idle path's transient ask request, recorded beside this value.
      capabilities: { ...engineCapabilities },
      config: DEFAULT_CONFIG,
      clock,
      meter,
      ledger,
      rules: createDefaultRules(DEFAULT_CONFIG),
      port,
      onTelemetry: (event) => { journal('telemetry', { sessionId, event }); },
    });
    journal('capabilities', { sessionId, ...capabilities,
      revertHistory: capabilities.revertHistory === true, reason: 'wire-proven',
      engineAtRest: engineCapabilities.atRest === true,
      ...(askGrammar === undefined
        ? {}
        : { ask: { grammar: askGrammar, transientModelCalls: 'one per fire',
          applied: false, floorBytes: OPENCODE_ASK_FLOOR_BYTES,
          retry: OPENCODE_ASK_RETRY,
          reload: 'the asked set and the fire count live in this process; a plugin reload '
            + 'starts fresh' } }) });
    const entry: OpencodeSessionEntry = {
      sessionId, ledger, port,
      appliedPlans: port.appliedPlanIndex?.()
        ?? new Map(seededAppliedPlans.map(plan => [plan.intentId, plan] as const)),
      engine, meter,
      pruneTrigger: new PruneWindowTrigger(contextWindowTokens, pruneThresholdTokens),
      dedupeClasses: options.dedupeClasses ?? {},
      ownedLedger: options.openLedger === undefined,
      lastMessages: null, pendingEstimates: [], droppedEstimates: 0,
      usageSeen: new Set<string>(),
      askedUnitIds: new Set<UnitId>(), askedRevisions: new Set<string>(),
      retriedUnitIds: new Set<UnitId>(), refusedRetriedUnitIds: new Set<UnitId>(),
      askVerdicts: new Map<UnitId, WireAnswer>(),
      seenNodeIds: new Set<NodeId>(), pendingSeenNodeIds: new Set<NodeId>(),
      stepAskFired: false, askInFlight: false, abandonedAsks: 0, askStepRowsSeen: false,
      askFires: 0, passRound: 0, passRemovalsApplied: false, deferredApply: false,
      deferredFailures: 0,
      completedThroughTurnOrdinal: null,
      applyingClosedEpisodeNodes: null,
      pendingForgets: [], lastPrefix: null,
    };
    mountedEntry = entry;
    sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * Feed one `session.step.ended` row to the session's meter. One line per
   * assistant message, whether a row arrived, was malformed, or came before this
   * mount measured a request.
   */
  function feedStepEnded(sessionId: string, data: Readonly<Record<string, unknown>>): void {
    const row = stepEndedRow(data);
    if (row === null) return;
    /**
     * A step row for the bench-only ask is not the main request the mount
     * measured: consuming a pending estimate for it would pair the next main
     * request's estimate with the generate step's tokens. The row is recorded
     * as unmeasured for this lane and the estimate stays queued.
     *
     * Vanilla opencode 2.2.5 declares no kind, so the nested ask's row reads
     * `unstated` (ISSUE-357). The mount's own in-flight ask is the fact that
     * identifies it: while `askInFlight` holds, an unstated row is the ask
     * lane's, never a main turn. A timed-out ask's abandoned call is the same
     * fact while it lives, on a host that has shown it emits ask step rows
     * (ISSUE-396): its late row must not shift a main estimate. A host that
     * DECLARES a kind is still trusted: a stated `main` row accounts as main
     * even mid-ask.
     */
    const requestKind = requestKindOf(data);
    const entry = sessions.get(sessionId);
    if (isAskStepRequest(data)
      || (requestKind === 'unstated' && entry !== undefined && entry.askInFlight)) {
      if (entry !== undefined) {
        entry.askStepRowsSeen = true;
        if (!entry.usageSeen.has(row.messageId)) entry.usageSeen.add(row.messageId);
      }
      journal('usage-missing', { sessionId, messageId: row.messageId, reason: 'ask-request',
        requestKind });
      return;
    }
    if (entry !== undefined && entry.abandonedAsks > 0 && entry.askStepRowsSeen
      && requestKind === 'unstated') {
      // ISSUE-396: the abandoned generate's late row, on a host that emits ask
      // step rows. Unmeasured in the ask lane; the main queue keeps its place.
      if (!entry.usageSeen.has(row.messageId)) entry.usageSeen.add(row.messageId);
      journal('usage-missing', { sessionId, messageId: row.messageId, reason: 'ask-request',
        requestKind });
      return;
    }
    if (entry === undefined) {
      journal('usage-missing', { sessionId, messageId: row.messageId, reason: 'no-session',
        requestKind });
      return;
    }
    if (entry.usageSeen.has(row.messageId)) return;
    entry.usageSeen.add(row.messageId);
    // ISSUE-358: this row answers a request whose estimate the bound dropped.
    // Shifting here would pair it with a LATER request's estimate; the row is
    // unmeasured by name and the queue keeps its alignment for the next row.
    if (entry.droppedEstimates > 0) {
      entry.droppedEstimates -= 1;
      journal('usage-missing', { sessionId, messageId: row.messageId,
        reason: 'estimate-dropped', requestKind });
      return;
    }
    const measured = entry.pendingEstimates.shift();
    if (row.kind !== 'usage') {
      journal('usage-missing', { sessionId, messageId: row.messageId, reason: row.reason,
        requestKind });
      return;
    }
    if (measured === null || measured === undefined) {
      // No context hook measured the request this row answers: reconciling it
      // against a later estimate would compare two unrelated requests.
      journal('usage-missing', { sessionId, messageId: row.messageId,
        reason: 'no-request-estimate', requestKind });
      return;
    }
    const usage: OpencodeUsageRow = row;
    try {
      entry.engine.observe(usageObservation(usage, measured.revision, measured.inputTokens));
    } catch (error) {
      // The meter refuses an inconsistent row (a cached count above input).
      journal('usage-missing', { sessionId, messageId: row.messageId,
        revision: measured.revision, reason: 'inconsistent-usage', requestKind,
        message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const reading: MeterReading | null = entry.meter.latest();
    journal('usage-reconciled', { sessionId, requestId: row.messageId,
      revision: measured.revision, requestKind,
      estimatedInputTokens: measured.inputTokens,
      inputTokens: reading?.inputTokens ?? usage.usage.inputTokens,
      outputTokens: reading?.outputTokens ?? usage.usage.outputTokens,
      cachedInputTokens: reading?.cachedInputTokens ?? usage.usage.cachedInputTokens,
      /** The host's two cache buckets, kept apart for a price-table tally. */
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      estimateErrorTokens: reading?.estimateErrorTokens ?? null,
      cachedInputShare: reading?.cachedInputShare ?? null,
      reasoningTokens: usage.reasoningTokens,
      costUsd: usage.costUsd });
  }

  /**
   * Promotes the last transform's shipped node ids into the session's seen set.
   * Runs at the start of a transform, before its ask table is built, so a result
   * that first appears in this transform's array is not yet eligible: it becomes
   * eligible at the next transform, after one request has carried it (ADR-0054
   * decision 7). The idle fallback after a transform reads the same set, which
   * is why a first-request-only turn asks nothing.
   */
  function promoteShippedNodes(entry: OpencodeSessionEntry): void {
    for (const nodeId of entry.pendingSeenNodeIds) entry.seenNodeIds.add(nodeId);
    entry.pendingSeenNodeIds.clear();
  }

  /** Records the node ids of the array this transform's commits ship. */
  function recordShippedNodes(entry: OpencodeSessionEntry, shipped: SessionSnapshot): void {
    entry.pendingSeenNodeIds.clear();
    for (const node of shipped.nodes) entry.pendingSeenNodeIds.add(node.id);
  }

  /**
   * The depth reading for a step or idle boundary: the host's reconciled input
   * tokens when a usage row exists, else the whole-request estimate of the
   * request at this boundary (ADR-0050 decision 1; dsh's rule at
   * `plugin.ts:2902-2911`). The fallback is computed from the boundary's own
   * port snapshot, so the session's first request can cross the bar; the last
   * `pendingEstimates` entry is the fallback when a caller has no snapshot. The
   * host-meter path is unchanged. Every evaluation is journaled, like the dsh
   * mount, so a run can be audited after the fact.
   */
  function observeDepth(
    entry: OpencodeSessionEntry, snapshot?: SessionSnapshot | null,
    prefix: RequestPrefix | null = entry.lastPrefix,
  ): boolean {
    /**
     * A host usage row wins. The local fallback exists only before the first
     * host row; it is never substituted for a host reading. A deferred pass's
     * baseline must be the first HOST reading after the removal (ADR-0050),
     * which is why no caller may force the local path.
     */
    const measured = entry.meter.latest();
    let local = 0;
    let contentTokens: number | null = null;
    let prefixTokens: number | null = null;
    if (measured === null) {
      if (snapshot !== undefined && snapshot !== null) {
        const split = estimateRequestSplit(estimateMeter, snapshot, prefix);
        local = split.totalTokens;
        contentTokens = split.contentTokens;
        prefixTokens = split.prefixTokens;
      } else {
        for (let i = entry.pendingEstimates.length - 1; i >= 0; i -= 1) {
          const estimate = entry.pendingEstimates[i];
          if (estimate !== null && estimate !== undefined) {
            local = estimate.inputTokens;
            break;
          }
        }
      }
    }
    const reading = measured?.inputTokens ?? local;
    const crossed = entry.pruneTrigger.observe(reading);
    journal('prune-threshold', {
      sessionId: entry.sessionId, estimatedTokens: reading,
      barReading: measured === null ? 'local-estimate' : 'host-meter',
      /**
       * The fallback is the WHOLE request before the first host usage row: the
       * request's own system + tool prefix plus every live transcript node
       * (ISSUE-300 item 10). `content` names the reading honestly when the
       * caller had no prefix to measure.
       */
      estimate: measured === null
        ? (prefix === null ? 'content' : 'content+prefix') : 'host-meter',
      ...(contentTokens === null ? {} : { contentTokens, prefixTokens }),
      threshold: entry.pruneTrigger.threshold,
      bar: entry.pruneTrigger.threshold,
      skipAt: entry.pruneTrigger.skipThreshold,
      window: contextWindowTokens,
      crossed,
    });
    return crossed;
  }

  /**
   * One request: the messages the host is about to send. The stage is committed
   * by the port onto the caller's own array; nothing staged means no write.
   *
   * Order (dsh's, adapted to this host): the at-rest pass, its commit, the
   * queued manual forgets, then the prune pass. The prune pass tables the array
   * the at-rest pass left, which is the array the host will send; its L1,
   * dedupe and judged removals land through one `{kind: 'prune'}` event.
   *
   * `context` is the same hook payload's fixed prefix (`system` and `tools`).
   * The pre-first-usage depth fallback measures the WHOLE request with it; a
   * caller that passes nothing gets a transcript-only reading, and the journal
   * says `content` rather than claiming the whole request.
   */
  async function transformStep(
    sessionId: string, messages: readonly OpencodeMessage[],
    context: Pick<OpencodeSessionContext, 'system' | 'tools'> | null = null,
  ): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      journal('transform', { reason: 'no-session' });
      return;
    }
    const entry = await sessionFor(sessionId);
    if (entry === null) return;
    /**
     * A host whose transient `session.generate` request re-enters this hook
     * must not run an at-rest or prune pass over the generate request's array:
     * that array is not the turn's context, and the ask that owns the transient
     * call still holds the main array. One ask is in flight; nothing else here
     * may stack on it.
     */
    if (entry.askInFlight) {
      journal('transform', { sessionId, reason: 'ask-in-flight' });
      return;
    }
    activeSessionId = sessionId;
    entry.lastMessages = messages;
    entry.lastPrefix = requestPrefixOf(context ?? {});
    const prefix = entry.lastPrefix;
    entry.stepAskFired = false;
    // The previous request's shipped nodes are this turn's eligibility; nothing
    // that first appears in this array is tableable or applicable yet.
    promoteShippedNodes(entry);
    /**
     * The turn-end fact an idle recorded travels with every observe this
     * transform makes; the port keeps it for later snapshots too. Null before
     * the first idle leaves the projection's `currentTurn - 1` default in
     * place. The snapshot takes `min(currentTurn, max(fact, currentTurn - 1))`,
     * so the fact can raise the completed-through ordinal but never past the
     * rebuilt array's current turn (a truncated or compacted rebuild can carry
     * fewer turns than the fact names).
     */
    const observeRequest = (array: readonly OpencodeMessage[]): SessionSnapshot =>
      entry.port.observe(array, entry.completedThroughTurnOrdinal === null
        ? {} : { completedThroughTurnOrdinal: entry.completedThroughTurnOrdinal });
    try {
      let observed = observeRequest(messages);
      // The event id names the request's content and how many times that content
      // has already been rewritten. This host rebuilds every request from its own
      // store (`rewriteHistory: false`), so the ledger's applied count at that
      // revision is the durable fact that separates a flushed rewrite from a
      // fresh request.
      const rewrites = await appliedRewritesAt(entry.ledger, sessionId, observed.revision);
      const eventId = opencodeStepEventId(sessionId, observed.revision, rewrites);
      const result = await entry.engine.process({ kind: 'at-rest', eventId, reason: 'step' });
      const refusal = entry.port.refusal?.() ?? null;
      const engineCommitted = result.committed === true;
      let committed = engineCommitted || entry.port.commit();
      const commitKind = entry.port.lastCommitKind?.() ?? null;
      journal('commit', { sessionId, eventId, committed,
        ...(committed && commitKind === 'cleanup' ? { reason: 'cleanup' } : {}) });
      journal('at-rest', { sessionId, eventId, reason: 'step',
        status: result.status === 'applied' && !engineCommitted ? 'staged' : result.status,
        intentId: result.intentId,
        issues: result.validation?.ok === false ? result.validation.issues : [],
        ...(refusal === null ? {} : { refusal: {
          code: refusal.code, reason: refusal.reason, detail: refusal.detail,
        } }),
      });
      /**
       * The manual forgets the tool resolved apply here, after the at-rest
       * commit and before the prune pass. The engine owns the event, the guard
       * and the receipt; the mount only drained the queue. A forget that
       * changed the array is re-observed before the pass plans.
       */
      if (entry.pendingForgets.length > 0) {
        const forgot = await drainPendingForgets(entry, messages);
        committed = committed || forgot;
        if (forgot) observed = observeRequest(messages);
      }
      /**
       * The prune pass: the depth reading, the table when the latch crossed,
       * and the document. L1 and the dedupe run on every rebuild while their
       * removals are banked or a stored verdict exists, because the host
       * discards the rewritten array and the removals must stay in effect
       * (`rewriteHistory: false`).
       */
      if (askGrammar !== undefined) {
        /**
         * A stored `forgetall` from an idle or `/cremate` fire applies in this
         * transform. That pass is not complete until the apply, and the array
         * observed here still carries the bytes it will remove, so this
         * transform must not let the old latch consume the pre-apply reading as
         * the pass's baseline: the observation is suppressed. When the apply
         * removed bytes the baseline is left pending, and the next transform's
         * first host reading consumes it (ADR-0050; audit 1 and the re-audit).
         * A deferred apply that removed nothing resets nothing.
         */
        const deferred = entry.deferredApply;
        const post = observeRequest(messages);
        const crossed = deferred
          ? false
          : (entry.pruneTrigger.enabled ? observeDepth(entry, post, prefix) : true);
        /**
         * A seeded applied-plan row means a prior process banked a removal the
         * host's rebuilt array still carries; the pass must run below the bar so
         * that removal stays in effect (ISSUE-300 item 6). A deferred idle or
         * command verdict needs the same pass even when the suppressed
         * observation did not cross.
         */
        const needPass = deferred || crossed || entry.askVerdicts.size > 0
          || entry.passRemovalsApplied || entry.appliedPlans.size > 0;
        let batch: OpencodeAskBatch | null = null;
        let buildThrew = false;
        if (needPass) {
          entry.passRound += 1;
          try {
            batch = buildOpencodeAskBatch({
              sessionId,
              messages,
              port: entry.port,
              seenNodeIds: entry.seenNodeIds,
              askedUnitIds: entry.askedUnitIds,
              round: entry.passRound,
              classes: entry.dedupeClasses,
              appliedPlans: entry.appliedPlans,
            });
          } catch (error) {
            buildThrew = true;
            journal('ask-error', { sessionId, origin: 'step', stage: 'rows',
              message: error instanceof Error ? error.message : String(error) });
          }
        }
        let answers: ReadonlyMap<UnitId, WireAnswer> = new Map();
        if (crossed) {
          let outcome: AskOutcome = 'no-table';
          if (batch !== null && batch.prompt !== null) {
            const sent = await askPass(entry, 'step', batch);
            outcome = sent.outcome;
            answers = sent.answers;
            entry.stepAskFired = outcome === 'fired';
          }
          /**
           * A pass DID something when it sent a table (whether the reply was
           * readable or the call failed): the next reading is its post-removal
           * surface. A crossing with nothing eligible was not a pass: the
           * crossing is not consumed, so the next above-bar reading fires — the
           * seen rule can no longer eat the first crossing (ISSUE-300 item 11).
           * A build that THREW is the same: it read nothing and removed nothing,
           * so the crossing stays live even with a non-empty seen set
           * (ISSUE-359).
           */
          if (entry.pruneTrigger.enabled) {
            if (outcome === 'no-table' && (entry.seenNodeIds.size === 0 || buildThrew)) {
              entry.pruneTrigger.notePassSkipped();
            } else {
              entry.pruneTrigger.notePassCompleted();
            }
          }
        }
        let deferredRemoved = false;
        if (batch !== null) {
          const snap = observeRequest(messages);
          try {
            deferredRemoved = await applyOpencodeAskVerdicts({
              entry, messages, snapshot: snap, plan: batch.plan, answers,
              bankedRows: batch.bankedRows,
              window: contextWindowTokens
                ?? Math.max(1, estimateRequestTokens(estimateMeter, snap, prefix)),
              hostWindow: contextWindowTokens,
              journal,
            });
            committed = deferredRemoved || committed;
          } catch (error) {
            journal('ask-error', { sessionId, origin: 'step', stage: 'apply',
              message: error instanceof Error ? error.message : String(error) });
          }
        }
        /**
         * The deferred pass (an idle or `/cremate` verdict applying here) is
         * complete when no stored verdict is left to apply. A failed apply
         * (thrown, or false with verdicts still stored) keeps the transform
         * deferred: the next request is still this pass's apply, not an ordinary
         * boundary, so its depth observation stays suppressed and the retry
         * happens before any baseline is taken.
         *
         * A completed deferred pass leaves the baseline pending: the next
         * transform's first HOST reading becomes `lastFireUsage`, on the same
         * meter the fire read. Any commit in the transform counts as removed
         * bytes — the at-rest or forget lane can have taken the unit and left
         * the prune apply with nothing to do. Only a pass where no bytes left
         * the array and no commit happened keeps the fire reading, so the next
         * bar is measured from the actual fire, not a synthetic surface. A local
         * post-removal estimate is never installed (ISSUE-300 re-audit,
         * ADR-0050).
         */
        if (deferred) {
          const verdictsRemain = entry.askVerdicts.size > 0;
          /**
           * Exactly one retry. A throw and a false return with verdicts still
           * stored are the same failure: the first keeps `deferredApply` true
           * so the next transform is the retry. A second consecutive failure
           * drops the stored verdicts — applied ones kept for re-application
           * included; the banked index re-applies those — and releases their
           * units, because a persistent guard rejection must not suppress
           * every later depth observation for the session (ADR-0050: a pass
           * that throws re-arms).
           * The drop does not complete the pass: the latch keeps evaluating
           * from the fire reading.
           */
          const failed = verdictsRemain && !deferredRemoved;
          let dropped = false;
          if (failed) {
            entry.deferredFailures += 1;
            if (entry.deferredFailures >= 2) {
              const droppedUnits = [...entry.askVerdicts.keys()];
              for (const unitId of droppedUnits) {
                entry.askVerdicts.delete(unitId);
                entry.askedUnitIds.delete(unitId);
                entry.retriedUnitIds.delete(unitId);
                entry.refusedRetriedUnitIds.delete(unitId);
              }
              entry.deferredApply = false;
              entry.deferredFailures = 0;
              dropped = true;
              journal('ask-error', {
                sessionId, origin: 'step', stage: 'deferred-drop',
                unitIds: droppedUnits,
                reason: 'two consecutive deferred applies failed; the stored verdicts are '
                  + 'dropped and their units released so the depth trigger resumes from the '
                  + 'fire reading; a verdict an earlier apply already landed stays banked in '
                  + 'the ledger and re-applies from there',
              });
            }
          } else {
            entry.deferredApply = false;
            entry.deferredFailures = 0;
          }
          if (!dropped && entry.pruneTrigger.enabled && (deferredRemoved || committed)) {
            entry.pruneTrigger.notePassCompleted();
          }
        }
      }
      // The estimate belongs to the array that will actually ship: a commit
      // changed it, so re-derive instead of describing the pre-commit bytes.
      const shipped: SessionSnapshot = committed
        ? observeRequest(messages) : await entry.port.snapshot();
      // The array that ships is the request the model receives, so its nodes
      // become eligible at the next transform (ADR-0054 decision 7).
      recordShippedNodes(entry, shipped);
      entry.pendingEstimates.push({ revision: shipped.revision,
        inputTokens: estimateRequestTokens(estimateMeter, shipped, prefix) });
      if (entry.pendingEstimates.length > 16) {
        const lost = entry.pendingEstimates.shift();
        entry.droppedEstimates += 1;
        journal('estimate-dropped', { sessionId,
          revision: lost?.revision ?? null, inputTokens: lost?.inputTokens ?? null });
      }
    } catch (error) {
      // A failed pass must leave the host's request runnable: journaled, no throw.
      // The request still ships unmodified, so its step row consumes a null
      // estimate and is reported as unmeasured rather than paired with a guess.
      entry.pendingEstimates.push(null);
      if (entry.pendingEstimates.length > 16) {
        const lost = entry.pendingEstimates.shift();
        entry.droppedEstimates += 1;
        journal('estimate-dropped', { sessionId,
          revision: lost?.revision ?? null, inputTokens: lost?.inputTokens ?? null });
      }
      journal('transform-error', { sessionId,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Drain the manual forgets the tool queued, one engine event each. The queue
   * is drained one item at a time (ISSUE-355), never detached up front: a throw
   * on one item cannot abort the rest. Each item's whole body — observe, engine
   * event, commit, re-observe — is caught per item; a throw names the failure
   * (`forget-error`) and re-queues that item for the next boundary, so a
   * scheduled forget is retried rather than silently dropped against the tool's
   * promise. A landed event is deduped by the engine's event id, so only an
   * unlanded forget retries. Every outcome is journaled by name.
   */
  async function drainPendingForgets(
    entry: OpencodeSessionEntry, messages: readonly OpencodeMessage[],
  ): Promise<boolean> {
    let committed = false;
    const count = entry.pendingForgets.length;
    for (let i = 0; i < count; i += 1) {
      const pending = entry.pendingForgets.shift();
      if (pending === undefined) break;
      try {
        entry.port.observe(messages);
        const result = await entry.engine.process({ kind: 'forget', eventId: pending.eventId,
          request: pending.request });
        const did = result.committed === true || entry.port.commit();
        committed = committed || did;
        journal('forget', { sessionId: entry.sessionId, eventId: pending.eventId,
          unitId: pending.unitId, path: pending.request.source,
          ranges: pending.request.ranges.length, status: result.status,
          intentId: result.intentId, committed: did,
          issues: result.validation?.ok === false ? result.validation.issues : [] });
        if (did) entry.port.observe(messages);
      } catch (error) {
        journal('forget-error', { sessionId: entry.sessionId, eventId: pending.eventId,
          unitId: pending.unitId,
          message: error instanceof Error ? error.message : String(error) });
        // Re-queue for the next boundary: a scheduled forget is retried, never
        // silently dropped. The loop runs only `count` times, so the re-queued
        // item waits for the next drain instead of spinning in this one.
        entry.pendingForgets.push(pending);
      }
    }
    return committed;
  }
  /** The digest a prompt or answer is journalled by. */
  function sha256Of(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  /** What one ask attempt did: a readable fire, an attempted send, or no table. */
  type AskOutcome = 'fired' | 'attempted' | 'no-table';

  /**
   * The prune table ask. One `session.generate` per depth crossing (or per
   * revision in the explicit bench-only lane), only when `askGrammar` is on and
   * the pass still holds a seen, unsettled unit that an already-sent request
   * carried.
   *
   * The pass is core's: the caller built it with `planPrunePass`, so this
   * function only sends the table, reads the reply through the adapter's
   * two-option gate, records the bookkeeping, and returns the accepted
   * `forgetall` answers for the one apply that follows. L1 and the dedupe are in
   * the same plan and apply with the answers, exactly as dsh's pass does.
   *
   * **It runs after the at-rest commit, before the prune apply.** That is dsh's
   * order: the at-rest rules run first, then the prune reads the surface they
   * left. The table therefore describes the array the host is about to send.
   *
   * Guards, unchanged:
   *   - one ask at a time (`askInFlight`); a generate request that re-enters the
   *     hook is skipped whole by `transformStep`;
   *   - a revision already asked is never asked again (`askedRevisions`);
   *   - every tabled unit is claimed before the call, so a re-entrant delivery
   *     sees it as asked.
   *
   * **`fired` is a readable reply.** A generate that throws or a reply with no
   * readable verdict at all is an `ask-error`, never a fire: its units are
   * released for at most one retry. A timeout is an `ask-error` and never a
   * fire too, but it is terminal for its units: the abandoned host call cannot
   * be cancelled, so its units stay claimed and are never generated again. A
   * reply the grammar read but refused is a fire: the model answered, and the
   * refusal keeps the unit.
   *
   * **No per-session fire cap** (ADR-0060). The only bounds are the guards above.
   *
   * Returns the outcome and the accepted `forgetall` answers.
   */
  async function askPass(
    entry: OpencodeSessionEntry, origin: 'step' | 'idle' | 'command',
    batch: OpencodeAskBatch,
  ): Promise<{ readonly outcome: AskOutcome;
    readonly answers: ReadonlyMap<UnitId, WireAnswer> }> {
    const generate = options.askGenerate;
    if (askGrammar === undefined || generate === undefined) {
      return { outcome: 'no-table', answers: new Map() };
    }
    if (batch.prompt === null || batch.rows.length === 0) {
      return { outcome: 'no-table', answers: new Map() };
    }
    // One ask at a time per session, and one ask per revision however the claim
    // moved. A host whose generate request re-enters this hook is stopped at
    // `transformStep`; this is the second lock.
    if (entry.askInFlight) return { outcome: 'no-table', answers: new Map() };
    if (entry.askedRevisions.has(batch.revision)) {
      return { outcome: 'no-table', answers: new Map() };
    }
    entry.askInFlight = true;
    try {
      return await askOnce(entry, origin, generate, batch);
    } finally {
      entry.askInFlight = false;
    }
  }

  async function askOnce(
    entry: OpencodeSessionEntry,
    origin: 'step' | 'idle' | 'command',
    generate: NonNullable<OpencodeMountOptions['askGenerate']>,
    batch: OpencodeAskBatch,
  ): Promise<{ readonly outcome: AskOutcome;
    readonly answers: ReadonlyMap<UnitId, WireAnswer> }> {
    // Claim before the call: the guard is the revision and the unit set, so a
    // second delivery for the same array reaches neither a row nor a send.
    entry.askedRevisions.add(batch.revision);
    for (const unitId of batch.unitIds) entry.askedUnitIds.add(unitId);
    /**
     * The unit each TABLE row addresses, keyed by the pass index the row
     * carries. The table can leave gaps (a settled or unseen row is filtered),
     * so the row's index is not its position in `batch.rows` and a positional
     * lookup would name the wrong unit.
     */
    const unitByIndex = new Map<number, UnitId>(
      batch.rows.flatMap((row, position) => {
        const unitId = batch.unitIds[position];
        return unitId === undefined ? [] : [[row.index, unitId] as const];
      }),
    );
    /**
     * Rows this table re-asks after a refusal. The refusal released the unit at
     * its earlier revision; this table is the one re-ask, and the journal names
     * it so a run can tell a retry from a first offer.
     */
    const retried = batch.rows.flatMap(row => {
      const unitId = unitByIndex.get(row.index);
      return unitId !== undefined && entry.refusedRetriedUnitIds.has(unitId)
        ? [{ index: row.index, unitId }] : [];
    });
    const promptSha256 = sha256Of(batch.prompt ?? '');
    const startedAtMs = clock.nowMs();
    const claimed = {
      sessionId: entry.sessionId, origin, revision: batch.revision, grammar: askGrammar,
      /** The pass round the answers are stamped with, not a separate fire count. */
      round: batch.round,
      cadence: entry.pruneTrigger.enabled ? 'depth' : 'per-revision',
      rowCount: batch.rows.length, indices: [...batch.indices],
      unitIds: [...batch.unitIds], promptSha256, promptChars: batch.prompt?.length ?? 0,
      floorBytes: batch.floorBytes, dropped: batch.dropped,
      retry: OPENCODE_ASK_RETRY, refusedRetry: OPENCODE_ASK_REFUSED_RETRY,
      retried, timeoutMs: askTimeoutMs,
    };
    /**
     * A failed ask gives its units to a later revision, once. The unit is
     * removed from the claimed set only while it has not retried before; the
     * revision stays claimed, so the same delivery cannot re-run it.
     */
    const releaseForRetry = (): void => {
      for (const unitId of batch.unitIds) {
        if (entry.retriedUnitIds.has(unitId)) continue;
        entry.askedUnitIds.delete(unitId);
        entry.retriedUnitIds.add(unitId);
      }
    };
    /**
     * `terminal` is the timeout's policy. The host call is abandoned, not
     * cancelled (`OpencodeGenerateInput` carries no AbortSignal), so releasing
     * the units would let a later revision table and generate the same unit
     * while the first call may still be running: two live ask requests and a
     * spend that is either double-counted or unmeasured. A timeout therefore
     * keeps the permanent claim and journals `retry: 'none'`, `terminal: true`.
     * Every other ask-error stage keeps its one retry.
     */
    const fail = (stage: string, message: string, extra: Record<string, unknown> = {},
      terminal = false): {
      readonly outcome: AskOutcome; readonly answers: ReadonlyMap<UnitId, WireAnswer> } => {
      if (!terminal) releaseForRetry();
      journal('ask-error', {
        ...claimed, stage, message,
        durationMs: clock.nowMs() - startedAtMs,
        applied: false, requestKind: 'ask',
        ...(terminal ? { retry: 'none', terminal: true } : {}),
        ...extra,
      });
      return { outcome: 'attempted', answers: new Map() };
    };
    let text = '';
    let usage: OpencodeUsageRow | null = null;
    try {
      const call = generate({ sessionID: entry.sessionId, prompt: batch.prompt ?? '' });
      const raced = await askWithinDeadline(call, askTimeoutMs);
      if (raced.status === 'timeout') {
        /**
         * ISSUE-396: the abandoned call is not cancelled — it can still end a
         * step after the lock cleared. Count it until it truly settles so its
         * late unstated row stays in the ask lane and never pairs a main
         * estimate. The lane itself does not wait.
         */
        entry.abandonedAsks += 1;
        const settled = (): void => { entry.abandonedAsks -= 1; };
        void call.then(settled, settled);
        return fail('timeout',
          `the ask produced no reply within ${String(askTimeoutMs)} ms; the request may still `
          + 'be running in the host, and this lane does not wait for it. The units stay claimed '
          + 'with no retry: a second generate for them could run beside the abandoned one',
          {}, true);
      }
      if (raced.status === 'rejected') throw raced.error;
      const answer = raced.value;
      text = typeof answer?.text === 'string' ? answer.text : '';
      if (answer?.usage !== undefined && answer.usage !== null) {
        const read = tokenUsageOf(answer.usage);
        if (read.kind === 'usage') {
          usage = {
            kind: 'usage', messageId: `ask:${String(entry.askFires + 1)}`,
            usage: { ...read.usage }, reasoningTokens: read.reasoningTokens,
            costUsd: null, cacheReadTokens: read.cacheReadTokens,
            cacheWriteTokens: read.cacheWriteTokens,
          };
        }
      }
    } catch (error) {
      return fail('generate', error instanceof Error ? error.message : String(error));
    }
    /**
     * Parse BEFORE anything is counted. A reply the reader can read is the only
     * fire; a reply that carries no verdict at all is an `ask-error` and gives
     * its units back for the one retry. The readable test is a row the grammar
     * answered OR a row the grammar refused with a code other than
     * `answer-unreadable`.
     */
    let parsed;
    try {
      parsed = readOpencodeAskAnswer(batch, text);
    } catch (error) {
      return fail('parse', error instanceof Error ? error.message : String(error),
        { answerSha256: sha256Of(text), answerChars: text.length });
    }
    const answered = parsed.filter(row => row.status === 'answered').length;
    const refused = parsed.filter(row => row.status === 'refused').length;
    const readable = parsed.some(row => row.status === 'answered'
      || row.code !== 'answer-unreadable');
    if (!readable) {
      return fail('parse',
        'the reply carried no readable verdict for this table; no fire is recorded and the '
        + 'units are released for at most one retry',
        { answerSha256: sha256Of(text), answerChars: text.length, answered, refused,
          codes: [...new Set(parsed.flatMap(row => (row.status === 'refused' ? [row.code] : [])))] });
    }
    entry.askFires += 1;
    const outcome = bookkeepAnswers(entry, batch, parsed);
    const answers = new Map<UnitId, WireAnswer>();
    for (const row of parsed) {
      if (row.status !== 'answered') continue;
      if (row.answer.verdict.action !== 'forgetall') continue;
      const unitId = unitByIndex.get(row.index);
      if (unitId !== undefined) answers.set(unitId, row.answer);
    }
    journal('ask', {
      ...claimed, status: 'read',
      answerSha256: sha256Of(text), answerChars: text.length,
      answered, refused,
      kept: outcome.kept, carried: outcome.carried, excluded: outcome.excluded,
      terminal: outcome.terminal,
      /**
       * Every answered row is `keepall` or `forgetall`: the reader refuses every
       * other action as `action-not-in-grammar` before this line is written, so
       * a journal reader never sees an action the prompt did not offer.
       */
      parsed: parsed.map(row => row.status === 'answered'
        ? { index: row.index, status: row.status, action: row.answer.verdict.action }
        : { index: row.index, status: row.status, code: row.code }),
      durationMs: clock.nowMs() - startedAtMs,
      applied: false,
      requestKind: 'ask',
      /** The host's own reading when `session.generate` reported one. */
      usage: usage === null
        ? null : { ...usage.usage, reasoningTokens: usage.reasoningTokens },
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      usageSource: usage === null ? 'unmeasured-host' : 'host-generate',
    });
    return { outcome: 'fired', answers };
  }

  /**
   * Records one readable fire's rows in the session's ask state.
   *
   * Every tabled unit was claimed before the request left. This function then
   * decides what the claim means:
   *
   * - an answered `forgetall` stays claimed forever and its verdict is stored;
   * - an answered `keepall` releases the unit, so a later crossing tables it
   *   again (ADR-0050 decision 3; ISSUE-300 item 4). The model chose to keep
   *   the bytes now, not to forbid a later question;
   * - a refused row releases the unit for exactly one later table; a second
   *   refusal keeps the permanent claim;
   * - a terminal `action-not-in-grammar` refusal keeps the permanent claim and
   *   spends no re-ask: the prompt never offered the action, so a second ask
   *   cannot change the reading.
   */
  function bookkeepAnswers(
    entry: OpencodeSessionEntry,
    batch: OpencodeAskBatch,
    parsed: readonly PruneAnswerRow[],
  ): {
    readonly kept: readonly { index: number; unitId: UnitId; action: string }[];
    readonly carried: readonly { index: number; unitId: UnitId; code: string }[];
    readonly excluded: readonly { index: number; unitId: UnitId; code: string }[];
    readonly terminal: readonly { index: number; unitId: UnitId; code: string }[];
  } {
    const kept: { index: number; unitId: UnitId; action: string }[] = [];
    const carried: { index: number; unitId: UnitId; code: string }[] = [];
    const excluded: { index: number; unitId: UnitId; code: string }[] = [];
    const terminal: { index: number; unitId: UnitId; code: string }[] = [];
    const unitByIndex = new Map<number, UnitId>(
      batch.rows.flatMap((row, position) => {
        const unitId = batch.unitIds[position];
        return unitId === undefined ? [] : [[row.index, unitId] as const];
      }),
    );
    for (const row of parsed) {
      const unitId = unitByIndex.get(row.index);
      if (unitId === undefined) continue;
      if (row.status === 'answered') {
        entry.refusedRetriedUnitIds.delete(unitId);
        if (row.answer.verdict.action === 'forgetall') {
          entry.askedUnitIds.add(unitId);
          entry.askVerdicts.set(unitId, row.answer);
        } else {
          // `keepall`: tableable again at a later crossing; this revision is
          // still guarded by `askedRevisions`.
          entry.askedUnitIds.delete(unitId);
          kept.push({ index: row.index, unitId, action: 'keepall' });
        }
        continue;
      }
      if (row.code === 'action-not-in-grammar') {
        entry.refusedRetriedUnitIds.delete(unitId);
        entry.askedUnitIds.add(unitId);
        terminal.push({ index: row.index, unitId, code: row.code });
        continue;
      }
      if (entry.refusedRetriedUnitIds.has(unitId)) {
        // This was the one re-ask and the row was refused again: final.
        entry.refusedRetriedUnitIds.delete(unitId);
        entry.askedUnitIds.add(unitId);
        excluded.push({ index: row.index, unitId, code: row.code });
      } else {
        entry.refusedRetriedUnitIds.add(unitId);
        entry.askedUnitIds.delete(unitId);
        carried.push({ index: row.index, unitId, code: row.code });
      }
    }
    return { kept, carried, excluded, terminal };
  }

  /**
   * Races one `session.generate` promise against the ask deadline. This host's
   * generate takes no `AbortSignal` (`host.ts` `OpencodeGenerateInput` is
   * `{sessionID, prompt}`), so the mount cannot cancel the host call; it stops
   * WAITING for it, journals the timeout as an ask error, and never counts it as
   * a fire. The timed-out promise is left to settle unobserved. The ask's units
   * stay claimed (terminal): the abandoned call may still be running, so a
   * later revision must not generate them a second time.
   */
  function askWithinDeadline<T>(
    value: Promise<T>, timeoutMs: number,
  ): Promise<{ readonly status: 'answered'; readonly value: T }
    | { readonly status: 'timeout' }
    | { readonly status: 'rejected'; readonly error: unknown }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return value.then(resolved => ({ status: 'answered' as const, value: resolved }),
        error => ({ status: 'rejected' as const, error }));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout' }), Math.floor(timeoutMs));
      timer.unref?.();
      value.then(
        resolved => { clearTimeout(timer); resolve({ status: 'answered', value: resolved }); },
        error => { clearTimeout(timer); resolve({ status: 'rejected', error }); },
      );
    });
  }
  /**
   * One manual `/cremate` (ADR-0050 Amendment 2026-11-18, second): the same
   * table pass as the depth trigger, on demand. The latch is not consulted, but
   * the same-revision guard and every ask guard still apply, and the pass
   * re-arms the latch like any completed pass. Nothing is applied here; an
   * accepted `forgetall` applies at the next step transform, after its at-rest
   * commit, exactly as an automatic fire's does.
   *
   * Returns `true` only when a readable table was journalled. With the ask off
   * there is no table to run; the command is still registered when the host
   * exposes the seam and the journal says why it did nothing.
   */
  async function cremate(sessionId: string): Promise<boolean> {
    const entry = sessions.get(sessionId);
    if (entry === undefined || entry.lastMessages === null) {
      journal('cremate', { sessionId: sessionId || null, fired: false,
        reason: entry === undefined ? 'no-session' : 'no-array' });
      return false;
    }
    if (askGrammar === undefined) {
      journal('cremate', { sessionId, fired: false, reason: 'ask-off' });
      return false;
    }
    let deferred = false;
    let buildThrew = false;
    try {
      entry.passRound += 1;
      /**
       * A unit first carried by the last sent request is eligible here: the
       * command is the same table pass as a step, so it promotes the last
       * transform's shipped nodes before building its batch (ISSUE-300 audit
       * bug 7). Without this, `/cremate` could only table units a later step
       * had already promoted, not the ones the request just sent.
       */
      promoteShippedNodes(entry);
      let batch: OpencodeAskBatch | null = null;
      try {
        batch = buildOpencodeAskBatch({
          sessionId, messages: entry.lastMessages, port: entry.port,
          seenNodeIds: entry.seenNodeIds, askedUnitIds: entry.askedUnitIds,
          round: entry.passRound, classes: entry.dedupeClasses,
          appliedPlans: entry.appliedPlans,
        });
      } catch (error) {
        buildThrew = true;
        journal('ask-error', { sessionId, origin: 'command', stage: 'rows',
          message: error instanceof Error ? error.message : String(error) });
      }
      if (batch === null || batch.prompt === null) {
        journal('cremate', { sessionId, fired: false, reason: 'no-rows' });
        return false;
      }
      const sent = await askPass(entry, 'command', batch);
      const fired = sent.outcome === 'fired';
      /**
       * A readable `forgetall` applies at the next step transform, not here.
       * The latch waits for that apply: arming now would make the next
       * pre-apply reading the baseline (audit 1).
       */
      deferred = fired && sent.answers.size > 0;
      journal('cremate', { sessionId, fired, reason: fired ? 'table' : 'no-fire' });
      return fired;
    } catch (error) {
      journal('ask-error', { sessionId, origin: 'command', stage: 'command',
        message: error instanceof Error ? error.message : String(error) });
      journal('cremate', { sessionId, fired: false, reason: 'error' });
      return false;
    } finally {
      if (deferred) {
        entry.deferredApply = true;
        entry.deferredFailures = 0;
      } else if (entry.pruneTrigger.enabled && !buildThrew) {
        // A pass that stored no removal still re-arms like any completed pass
        // (ADR-0050 decision 3): nothing will change the surface later. A build
        // that THREW is not a pass at all (ISSUE-359): the latch stays exactly
        // as it was, so the next above-bar reading still fires.
        entry.pruneTrigger.notePassCompleted();
      }
    }
  }

  /**
   * The idle-origin ask. The step ask's fallback, never its primary path: it
   * runs only when the last step ask did not fire. The step hook normally asks
   * after its at-rest pass; a host that never delivers an idle therefore still
   * asks at the step, and a delivered idle never asks a second time for the
   * turn the step already covered.
   *
   * It runs inside the awaited `experimental.idle` hook when the host exposes
   * that seam (ADR-0062 D2, ISSUE-373), so the host's single drain waits for it
   * before any queued prompt; otherwise it runs on the `session.idle` event
   * path. Returns the snapshot its depth reading took, or null when no ask
   * lane ran.
   */
  async function idleAsk(
    entry: OpencodeSessionEntry, sessionId: string,
  ): Promise<SessionSnapshot | null> {
    if (entry.lastMessages === null) return null;
    if (askGrammar === undefined || entry.stepAskFired) return null;
    /**
     * The idle depth reading's own projection of the last array. It is taken
     * once and reused by the turn-end journal when the event path ran the ask:
     * `observe` records the array it saw, so a second call would only repeat it.
     * ISSUE-394: the observe and the depth reading sit INSIDE the try — a
     * non-array payload the last transform stored must fail open here like its
     * siblings, never reject `event()` and kill the consumer loop.
     */
    let idleSnapshot: SessionSnapshot | null = null;
    let crossed = false;
    let sent: { readonly outcome: AskOutcome;
      readonly answers: ReadonlyMap<UnitId, WireAnswer> } | null = null;
    let buildThrew = false;
    try {
      idleSnapshot = entry.port.observe(entry.lastMessages);
      crossed = entry.pruneTrigger.enabled
        ? observeDepth(entry, idleSnapshot, entry.lastPrefix) : true;
      if (crossed) {
        entry.passRound += 1;
        let batch: OpencodeAskBatch | null = null;
        try {
          batch = buildOpencodeAskBatch({
            sessionId, messages: entry.lastMessages, port: entry.port,
            seenNodeIds: entry.seenNodeIds, askedUnitIds: entry.askedUnitIds,
            round: entry.passRound, classes: entry.dedupeClasses,
            appliedPlans: entry.appliedPlans,
          });
        } catch (error) {
          buildThrew = true;
          journal('ask-error', { sessionId, origin: 'idle', stage: 'rows',
            message: error instanceof Error ? error.message : String(error) });
        }
        if (batch !== null && batch.prompt !== null) {
          sent = await askPass(entry, 'idle', batch);
        }
      }
    } catch (error) {
      // A broken ask must never stop the event consumer or the host's drain.
      journal('ask-error', { sessionId, origin: 'idle', stage: 'idle',
        message: error instanceof Error ? error.message : String(error) });
    } finally {
      // Only a crossing that reached the pass touches the latch; a reading
      // that never crossed (or threw before crossing) leaves it exactly as it
      // was, as the old early return did.
      if (crossed && entry.pruneTrigger.enabled) {
        if (sent !== null && sent.outcome === 'fired' && sent.answers.size > 0) {
          /**
           * The readable `forgetall` applies at the next step transform, so
           * the latch must not arm on the next pre-apply reading: that array
           * still holds the bytes the verdict removes (audit 1). The step
           * transform suppresses that reading and leaves the baseline
           * pending for the first host reading after the removal.
           */
          entry.deferredApply = true;
          entry.deferredFailures = 0;
        } else if (sent === null && (entry.seenNodeIds.size === 0 || buildThrew)) {
          // Nothing eligible, or the build threw (ISSUE-359): no pass ran,
          // so the crossing stays live for the next above-bar reading.
          entry.pruneTrigger.notePassSkipped();
        } else {
          entry.pruneTrigger.notePassCompleted();
        }
      }
    }
    return idleSnapshot;
  }

  /** One turn-end observation. The turn is complete, and no array can be committed. */
  async function idlePass(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    // A session this mount never transformed has no array and no estimate; the
    // idle is a fact about a session the adapter has not met yet.
    if (entry === undefined || entry.lastMessages === null) return;
    // ADR-0062 D2 (ISSUE-373): with the awaited idle hook wired, the ask ran
    // there; this event path keeps only the observe/turn-fact lane.
    // ISSUE-395: the same guard `idleHookAsk` holds — a nested idle during an
    // in-flight step ask is not a pass: its depth reading would consume or arm
    // a baseline for a pass the ask lock refuses (ADR-0050).
    const idleSnapshot = idleAskOnEvent && !entry.askInFlight
      ? await idleAsk(entry, sessionId) : null;
    try {
      /**
       * Observe-only (audit finding 4). `session.idle` carries no array the host
       * will send: the next context hook rebuilds the request from the host's own
       * store. An applying pass here could only stage a derivation onto an array
       * nobody ships, while the engine records the intent applied — a receipt and
       * a ledger row for a removal the wire never carried. The seam therefore
       * reads the last array, journals the turn end, and commits nothing; the
       * next step pass plans and commits from the array the host rebuilds.
       */
      const observed = idleSnapshot ?? entry.port.observe(entry.lastMessages);
      /**
       * The idle is the turn-end fact: this turn is complete. Record the
       * observed ordinal for the next transform, which passes it to the port.
       * The snapshot clamps the fact to the rebuilt array's current turn and a
       * stale value never lowers the projection's default (`max`), so a shorter
       * array cannot carry a completed ordinal above its current one. The idle
       * still applies nothing.
       *
       * A nested ask's idle is not the main turn's end (ISSUE-353): while
       * `askInFlight` holds, the transform is suspended inside the ask and the
       * live turn is still in flight. Recording its ordinal here would let the
       * next pass close and evict the LIVE turn's episodes. The fact waits for
       * an idle delivered with no ask in flight.
       */
      if (!entry.askInFlight) {
        entry.completedThroughTurnOrdinal = Math.max(
          entry.completedThroughTurnOrdinal ?? -1, observed.currentTurnOrdinal);
      }
      // The event id names the array, never a counter.
      const eventId = `oc:${sessionId}:idle:${observed.revision}`;
      journal('at-rest', { sessionId, eventId, reason: 'turn-end', status: 'observed' });
      journal('commit', { sessionId, eventId, committed: false, reason: 'no-array' });
    } catch (error) {
      journal('at-rest-error', { sessionId,
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  /**
   * One awaited `experimental.idle` hook firing (ADR-0062 D2, ISSUE-373). The
   * host awaits this inside its single drain and re-checks queued input after
   * it, so the idle-origin ask blocks new prompts exactly as the step-origin
   * ask blocks inside the context hook. Observe/turn-fact stays on the event
   * path, where the ISSUE-353 turn-ordinal guard reads it.
   */
  async function idleHookAsk(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (entry === undefined || entry.lastMessages === null) return;
    // A nested ask's own idle hook firing is not a second pass: the ask that
    // owns the drain is still in flight (the ISSUE-353 guard family).
    if (entry.askInFlight) return;
    await idleAsk(entry, sessionId);
  }
  async function event(value: OpencodeHostEvent): Promise<void> {
    const type = typeof value?.type === 'string' ? value.type : '';
    const data = isRecord(value?.data) ? value.data : {};
    const sessionId = typeof data['sessionID'] === 'string' ? data['sessionID'] : null;
    if (type === 'session.step.ended') {
      if (sessionId !== null) feedStepEnded(sessionId, data);
      return;
    }
    if (sessionId === null) return;
    if (type === 'session.idle') {
      await idlePass(sessionId);
      return;
    }
    if (type === 'session.compaction.started' || type === 'session.compaction.delta'
      || type === 'session.compaction.ended' || type === 'session.compaction.failed') {
      const phase = type.slice('session.compaction.'.length);
      const text = data['text'];
      journal('compacted', { sessionId, phase,
        ...(data['reason'] === undefined ? {} : { reason: data['reason'] }),
        ...(data['cost'] === undefined ? {} : { costUsd: costOf(data['cost']) }),
        ...(data['tokens'] === undefined ? {} : { tokens: data['tokens'] }),
        ...(typeof text === 'string' ? { textLength: text.length } : {}),
        ...(data['error'] === undefined ? {} : { error: data['error'] }),
      });
      // A native compaction rewrote the surface. Re-arm the depth latch as a
      // fresh session (ADR-0050 decision 3 / Issue-022 DoD): the next above-bar
      // reading fires, exactly like a first trigger on a new session.
      if (phase === 'ended') {
        const entry = sessions.get(sessionId);
        if (entry !== undefined) {
          entry.pruneTrigger.noteNativeCompaction();
          /**
           * The compaction rewrote the surface, so the last idle's turn fact may
           * point past the rebuilt array's current ordinal. Core refuses
           * `completedThroughTurnOrdinal > currentTurnOrdinal` (`invalid-plan`,
           * transcript ordinal), which would reject every later at-rest and
           * prune plan. Drop the stale fact; the next projection falls back to
           * its own `currentTurn - 1`. The port also retains the last fact a
           * transform supplied (its `observe` merge is sticky), so clearing the
           * mount's own fact is not enough: drop the port's too, or a no-options
           * observation still clamps the stale fact up to the in-progress turn
           * (ISSUE-362, ISSUE-300 close-record minor #1).
           */
          entry.completedThroughTurnOrdinal = null;
          entry.port.clearCompletedTurnFact?.();
        }
      }
    }
    // Unknown event types are ignored, never guessed at. `session.deleted` is
    // handled by the tracked wrapper below: its eviction drains the mount's
    // in-flight work and must not await its own tracked promise (ISSUE-379).
  }

  /**
   * One `execute.after` firing. Observation only: the product never caps,
   * shortens or rewrites a result body (ADR-0048). The result object is read
   * and left untouched, so the host's own `ToolOutput.truncate` runs as it
   * ships.
   */
  async function afterTool(input: OpencodeAfterToolInput): Promise<void> {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    const callId = typeof input.id === 'string' ? input.id : '';
    const tool = typeof input.tool === 'string' ? input.tool : '';
    journal('tool-observed', { sessionId, tool, callId });
  }

  /**
   * The recall source. The host's tool context names the session, so a
   * multi-session host reads the ledger it asked from.
   */
  async function recallRecord(id: Parameters<Ledger['recall']>[0]) {
    const sessionId = activeSessionId ?? (sessions.size === 1
      ? [...sessions.keys()][0] : null);
    if (sessionId === null || sessionId === undefined) {
      throw new Error('cremator: recall has no live session; no context hook has run yet');
    }
    const entry = await sessionFor(sessionId);
    if (entry === null) throw new Error('cremator: recall has no ledger for this session');
    return entry.ledger.recall(id);
  }

  /**
   * One manual forget call. The arguments are read as a call (a malformed call
   * is the model's error and surfaces as a failed tool result), resolved against
   * the request's own snapshot with core's `resolveForget`, and queued for the
   * next request boundary. The tool answers what it can prove now: a scheduled
   * request or the lookup's own refusal. Nothing is removed inside the call.
   */
  async function forgetRequest(sessionId: string, args: unknown): Promise<OpencodeForgetValue> {
    const request = readOpencodeForgetArgs(args);
    const entry = await sessionFor(sessionId);
    if (entry === null || entry.lastMessages === null) {
      return { status: 'refused', code: 'unsupported-capability', reason: 'no-array',
        detail: 'no request array has been observed for this session yet' };
    }
    const snapshot = entry.port.observe(entry.lastMessages);
    const decision = decideOpencodeForget({
      snapshot, sessionId, request,
    });
    if (decision.status === 'scheduled') {
      entry.pendingForgets.push({ eventId: decision.eventId, unitId: decision.unitId,
        request: decision.request });
      journal('forget-scheduled', { sessionId, eventId: decision.eventId,
        unitId: decision.unitId, path: request.source, ranges: request.ranges.length });
    }
    return forgetAnswer(decision);
  }

  const baseTool = createOpencodeTool({ recall: recallRecord });
  const tool: OpencodeToolDefinition = Object.freeze({
    ...baseTool,
    execute: async (input: unknown, context: Parameters<OpencodeToolDefinition['execute']>[1]) => {
      if (typeof context?.sessionID === 'string' && context.sessionID.length > 0) {
        activeSessionId = context.sessionID;
      }
      return baseTool.execute(input, context);
    },
  });
  const forgetBase = createOpencodeForgetTool({
    recall: recallRecord,
    forget: args => forgetRequest(activeSessionId ?? '', args),
  });
  const forgetTool: OpencodeToolDefinition | null = forgetBase === null ? null
    : Object.freeze({
      ...forgetBase,
      execute: async (input: unknown,
        context: Parameters<OpencodeToolDefinition['execute']>[1]) => {
        if (typeof context?.sessionID === 'string' && context.sessionID.length > 0) {
          activeSessionId = context.sessionID;
        }
        return forgetBase.execute(input, context);
      },
    });

  journal('mounted', { plugin: OPENCODE_PLUGIN_NAME,
    seams: askGrammar === undefined
      ? [...OPENCODE_MOUNT_SEAMS] : [...OPENCODE_MOUNT_SEAMS, 'session.generate'],
    ...selection.kind === 'durable' ? { storageRoot: selection.root }
      : { storage: ':memory:' },
    ...(options.journalFile === undefined ? {} : { journalFile: options.journalFile }),
    /** The full additive inventory this mount registers, not a subset. */
    tools: [tool.name, ...(forgetTool === null ? [] : [forgetTool.name])].join(','),
    forgetTool: forgetTool !== null,
    excludeTools: [...(options.excludeTools ?? [])],
    askGrammar: askGrammar ?? null,
    ...(askGrammar === undefined ? {} : {
      askFloorBytes: OPENCODE_ASK_FLOOR_BYTES,
      askRetry: OPENCODE_ASK_RETRY,
      askRefusedRetry: OPENCODE_ASK_REFUSED_RETRY,
      askTimeoutMs,
      /** The depth trigger and the dedupe switches this mount runs. */
      trigger: { bar: pruneThresholdTokens, window: contextWindowTokens,
        skipAt: contextWindowTokens === null ? null : Math.ceil(contextWindowTokens * 0.75) },
      dedupeClasses: { ...(options.dedupeClasses ?? {}) },
    }),
    revertHistory: declared.revertHistory === true, node: process.version });

  return {
    sessions,
    tool,
    forgetTool,
    transform: (sessionId, messages, context) => track(transformStep(sessionId, messages, context)),
    forget: (sessionId, args) => track(forgetRequest(sessionId, args)),
    event: value => {
      /**
       * `session.deleted` (ISSUE-379) is handled here, around the tracked
       * event, because the eviction must drain the mount's in-flight work
       * (the ISSUE-356 path) without awaiting its own tracked promise. The
       * payload is the sibling events' own `data: { sessionID }` (verified
       * against the installed @opencode SDK).
       */
      let work: Promise<void> | undefined;
      work = track((async () => {
        await event(value);
        if (value?.type !== 'session.deleted') return;
        const data = isRecord(value.data) ? value.data : {};
        const sessionId = typeof data['sessionID'] === 'string' ? data['sessionID'] : null;
        if (sessionId === null) return;
        await drainInFlight(work);
        if (await releaseSession(sessionId)) {
          journal('session-evicted', { sessionId, reason: 'session.deleted' });
        }
      })());
      return work;
    },
    afterTool: input => track(afterTool(input)),
    cremate: sessionId => track(cremate(sessionId)),
    idle: sessionId => track(idleHookAsk(sessionId)),
    get idleAskOnEvent(): boolean { return idleAskOnEvent; },
    set idleAskOnEvent(value: boolean) { idleAskOnEvent = value; },
    close: async () => {
      // Drain in-flight transforms and asks before closing the ledgers
      // (ISSUE-356): a post-dispose ask resolution must not write a closed
      // ledger. Each entry then leaves through the same release the
      // `session.deleted` eviction uses (ISSUE-379). The closing flag refuses
      // new session work for the whole release loop (ISSUE-393): a hook during
      // a ledger-close await neither transforms a closing entry nor re-opens a
      // released one.
      closing = true;
      await drainInFlight();
      for (const sessionId of [...sessions.keys()]) await releaseSession(sessionId);
    },
  };
}

/**
 * The plugin a host mounts through its `plugins` list. `setup` registers the
 * context hook, the tool, the manual `/cremate` command (when the host exposes
 * `context.command`) and the observer, starts one event consumer, and returns
 * the cleanup that stops it and closes every owned ledger.
 */
export function createOpencodePlugin(options: OpencodeMountOptions = {}): OpencodePluginDefinition {
  return Object.freeze({
    id: OPENCODE_PLUGIN_NAME,
    setup: async (context: OpencodePluginContext) => {
      const merged: OpencodeMountOptions = { ...mountOptionsFromHost(context.options), ...options };
      // A caller-supplied seam (a test) wins; otherwise the host's own
      // `session.generate`. An enabled ask without either is a mount bug, not a
      // silent absence: this host must answer the question the run says it
      // measured.
      const askGenerate = merged.askGenerate
        ?? (typeof context.session.generate === 'function'
          ? context.session.generate.bind(context.session) : undefined);
      if (merged.askGrammar !== undefined && askGenerate === undefined) {
        throw new TypeError('cremator: crematorAskGrammar is on but this host exposes no '
          + 'session.generate; the bench-only ask cannot be mounted');
      }
      // One sink for every line this mount writes, including the two the plugin
      // itself emits when a seam fails to register or its event stream throws.
      const emit = merged.journal
        ?? (merged.journalFile === undefined ? () => {} : createFileJournalSink(merged.journalFile));
      const mount = createOpencodeMount({
        ...merged, journal: emit,
        ...(askGenerate === undefined ? {} : { askGenerate }),
      });
      await context.session.hook('context', async (input: OpencodeSessionContext) => {
        if (merged.excludeTools !== undefined && input.tools !== undefined) {
          for (const name of merged.excludeTools) delete input.tools[name];
        }
        const prefix = input.system === undefined && input.tools === undefined
          ? null
          : {
            ...(input.system === undefined ? {} : { system: input.system }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
          };
        await mount.transform(input.sessionID, input.messages, prefix);
      });
      /**
       * The awaited idle seam (ADR-0062 D2, ISSUE-373): the host awaits this
       * hook inside its single drain, so the idle-origin ask blocks queued
       * prompts the way the step ask blocks inside the context hook. A host
       * that predates the hook refuses the registration; the mount then keeps
       * the `session.idle` event-path fallback, and the refusal is journalled.
       */
      try {
        await context.session.hook('experimental.idle', async (input: OpencodeIdleHookInput) => {
          await mount.idle(typeof input?.sessionID === 'string' ? input.sessionID : '');
        });
        mount.idleAskOnEvent = false;
      } catch (error) {
        try {
          emit(Object.freeze({ kind: 'idle-hook-error', atMs: Date.now(),
            reason: 'register-failed',
            message: error instanceof Error ? error.message : String(error) }));
        } catch { /* a journal sink must never change an outcome */ }
      }
      await context.tool.hook('execute.after', input => mount.afterTool(input));
      try {
        await context.tool.transform((editor) => {
          editor.add(mount.tool);
          if (mount.forgetTool !== null) editor.add(mount.forgetTool);
        });
      } catch (error) {
        // The passive seams still work without the tool; say so instead of
        // failing the whole mount.
        try {
          emit(Object.freeze({ kind: 'tool-error', atMs: Date.now(),
            reason: 'register-failed',
            message: error instanceof Error ? error.message : String(error) }));
        } catch { /* a journal sink must never change an outcome */ }
      }
      /**
       * The manual `/cremate` command (2.2.5's `Context.command`, the seam the
       * audit named as unused). It runs the mount's same table pass on demand.
       * A host without the seam still mounts; a throwing registration is
       * journalled and leaves the hooks working.
       */
      if (context.command !== undefined) {
        try {
          await context.command.transform((editor) => {
            editor.add({
              name: OPENCODE_PRUNE_COMMAND,
              description: 'Run one CREMATOR table pass now.',
              execute: async (input) => {
                const id = typeof input?.sessionID === 'string' ? input.sessionID : '';
                await mount.cremate(id);
              },
            });
          });
        } catch (error) {
          try {
            emit(Object.freeze({ kind: 'command-error', atMs: Date.now(),
              reason: 'register-failed',
              message: error instanceof Error ? error.message : String(error) }));
          } catch { /* a journal sink must never change an outcome */ }
        }
      }
      const types = [
        'session.idle',
        'session.deleted',
        'session.step.ended',
        'session.compaction.started',
        'session.compaction.delta',
        'session.compaction.ended',
        'session.compaction.failed',
      ];
      const iterator = context.event.subscribe({ types })[Symbol.asyncIterator]();
      let stopped = false;
      const loop = (async () => {
        try {
          while (!stopped) {
            const next = await iterator.next();
            if (next.done) break;
            await mount.event(next.value);
          }
        } catch (error) {
          try {
            emit(Object.freeze({ kind: 'event-error', atMs: Date.now(),
              message: error instanceof Error ? error.message : String(error) }));
          } catch { /* a journal sink must never change an outcome */ }
        }
      })();
      return async () => {
        stopped = true;
        try { await iterator.return?.(); } catch { /* already closed */ }
        // A host iterable that does not answer `return()` may leave `next()`
        // waiting; cleanup must still finish and close the ledger.
        await Promise.race([
          loop.catch(() => {}),
          new Promise<void>(resolve => { setTimeout(resolve, 250); }),
        ]);
        await mount.close();
      };
    },
  });
}

/** The default export a package `plugins` entry loads. */
export default createOpencodePlugin();
