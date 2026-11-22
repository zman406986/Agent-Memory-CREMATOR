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
 *     asked set (the revision and unit claims) and an unapplied verdict are
 *     durable; a plugin reload restores them (ISSUE-409; ADR-0063).
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
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import type {
  ApplicationPort, ApplyReceipt, CapabilityFlags, Clock, DedupeClasses, ForgetRequest, Ledger,
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
import {
  readDurableAskState, readDurableReceipts, writeDurableReceipt, writeDurableAskState,
} from './mount-state.js';
import type { DurableAskState, DurableAskVerdict } from './mount-state.js';
import { OPENCODE_RECORD_PREFIX, opencodeToolNodeId } from './snapshot.js';
import { OpencodeStorageError, openLedger, resolveStorage, sessionStorage } from './storage.js';
import type { OpencodeStorageOptions, StorageSelection, StorageTarget } from './storage.js';
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
 * they stay claimed and are never generated again for that unit. A later
 * request for a different array still runs beside the abandoned call; only a
 * generate for those claimed units is refused (ISSUE-410).
 */
export const OPENCODE_ASK_TIMEOUT_MS = 120_000;

/**
 * The largest delay a platform timer accepts (`2^31-1` ms). A larger delay is
 * clamped to 1 ms by `setTimeout`, which would turn a long deadline into an
 * immediate abort (ISSUE-425). This is the platform's range, not a cap this
 * mount invents (standing rule 7 / ADR-0060); a value beyond it is refused by
 * name at mount.
 */
export const MAX_PLATFORM_TIMER_MS = 2_147_483_647;

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
  // ISSUE-411: the awaited `experimental.idle` hook registered, so a journal
  // can tell "registered but never called" from "never registered".
  | 'idle-hook'
  | 'prune-threshold'
  | 'prune-plan'
  // ISSUE-431: a depth crossing held no tableable unit, so no ask was sent and
  // none was suppressed — a named outcome distinct from a fire and from a
  // build failure.
  | 'prune-outcome'
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
  | 'transform-error'
  // ISSUE-421: a context hook carrying a timed-out ask's own prompt was
  // skipped whole — the main array was not overwritten and no pass or ask ran.
  | 'ask-abandoned'
  // ISSUE-425: the mount closed while an ask was waiting with its deadline
  // off; the lane stopped waiting, settled unanswered, and named the outcome.
  | 'ask-close'
  // ISSUE-447: the ask lane read the durable ledger before paying the host and
  // refused the send by name (ledger-unavailable / recovery-pending /
  // breaker-open) because the apply could not use a table.
  | 'ask-standdown'
  // ISSUE-419: the durable ledger file decided fresh install vs restart, and
  // the pre-install nodes were captured for exclusion by the later passes.
  | 'install'
  // ISSUE-422: a `session.compaction.*` event arrived while an ask or its
  // deferred apply was running, so the depth latch's re-arm was deferred to the
  // end of that window instead of re-arming mid-flight (ADR-0050's backstop).
  | 'compaction-deferred'
  // ISSUE-423: stored `forgetall` verdicts were dropped by name because a host
  // compaction landed between the ask that read them and the apply that would
  // have recorded their receipts; no receipt is written for the pre-ask array.
  | 'compaction-stale'
  // ISSUE-448: durable receipts came back from the mount's own state on open,
  // so a prepared ledger row the previous process landed can be resolved instead
  // of standing the session down in recovery-pending.
  | 'receipts-resumed'
  // ISSUE-448 / ADR-0064: a prepared row with no provable receipt after seeding
  // was closed once with a named abandoned outcome, so it cannot block every
  // later pass.
  | 'intent-abandoned'
  // ISSUE-409: the ask identity a previous process claimed or answered came
  // back from the mount's durable state, so a claimed unit is not re-asked and
  // an unapplied verdict is not lost.
  | 'ask-state-resumed'
  // ISSUE-409: restored ask state was dropped by name (the ask lane is off, or
  // every row was unreadable) instead of lingering as an invisible obligation.
  | 'ask-state-dropped'
  // ISSUE-448 / ISSUE-409: a durable state write failed. The mount keeps its
  // in-memory state and names the failure; no write is read as success
  // (ADR-0065).
  | 'mount-state-error'
  // ISSUE-432: a context hook named a provider/model different from the one the
  // session's window and bar were derived from. Nothing is re-derived (the
  // operator's window is authoritative); the line stamps each stale value with
  // the model it came from, so a mid-session switch is detectable.
  | 'model-change';

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

/**
 * Whether this session's ledger holds any event at all (ISSUE-422). Read once at
 * session open, stopping at the first row: a ledger whose file exists but whose
 * events all belong to another session id is a parent's copied state, and the
 * mount names that instead of treating it as a restart. A ledger read that
 * throws counts as `true` (the pre-422 restart behaviour): the safe answer for
 * an unreadable file is not to exclude a live session's own history.
 */
async function ledgerHasAnyEvent(ledger: Ledger, sessionId: string): Promise<boolean> {
  try {
    for await (const _ of ledger.events(sessionId)) return true;
    return false;
  } catch {
    return true;
  }
}

export type OpencodeAskStanddownReason =
  'ledger-unavailable' | 'recovery-pending' | 'breaker-open';

/**
 * The durable-health gate the prune apply would apply anyway (ISSUE-447), read
 * before the host is paid. Core answers `recovery-pending` before planning when
 * a prepared intent has no applied/abandoned row, and refuses a disabled
 * breaker; paying for an ask whose table the apply cannot accept repeats on
 * every new revision. `null` means the lane may ask. A read failure is the
 * `ledger-unavailable` standdown, never a throw: the lane does nothing now and
 * a later crossing reads again (fail-open).
 */
export async function opencodeAskStanddown(
  ledger: Ledger, sessionId: string,
): Promise<OpencodeAskStanddownReason | null> {
  try {
    let disabled = false;
    const prepared = new Set<string>();
    const finished = new Set<string>();
    for await (const { event } of ledger.events(sessionId)) {
      if (event.kind === 'validation') disabled = event.breaker.disabled;
      else if (event.kind === 'prepared') prepared.add(event.intentId);
      else if (event.kind === 'abandoned') finished.add(event.intentId);
      else if (event.kind === 'applied') finished.add(event.receipt.intentId);
    }
    for (const intentId of prepared) {
      if (!finished.has(intentId)) return 'recovery-pending';
    }
    return disabled ? 'breaker-open' : null;
  } catch {
    return 'ledger-unavailable';
  }
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
 * 2026-11-19). The map is written to durable state and restored at open; a
 * plugin reload keeps the unapplied verdicts (ISSUE-409; ADR-0063).
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
   * The provider/model the window and bar above were derived from (ISSUE-432).
   * Null until a context hook names one. A later hook naming a different model
   * journals `model-change`, so a value that did not follow the switch is
   * detectable instead of silent.
   */
  parametersDerivedFrom: OpencodeModelRef | null;
  /** The model the last context hook named; one `model-change` files per switch. */
  observedModel: OpencodeModelRef | null;
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
   * The verdicts the durable record still owes an apply (ISSUE-409; ADR-0063).
   * Kept apart from `askVerdicts`: an applied verdict stays in that map so a
   * host rebuild re-applies the banked removal, while the durable record is
   * cleared once the apply landed and the ledger's applied row owns it. Only
   * this map is serialized.
   */
  readonly durableAskVerdicts: Map<UnitId, DurableAskVerdict>;
  /**
   * Publish the current ask identity to the mount's durable state. A no-op for
   * a `':memory:'` session. Called before a paid ask leaves, after a verdict is
   * stored, and after an apply or drop settles one (ISSUE-409).
   */
  readonly persistAskState: () => void;
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
   * The install boundary (ISSUE-419): the node ids present in this mount's
   * first transform of a fresh durable install. Such nodes were produced before
   * the plugin mounted, so they are never ask-eligible and never removal-eligible
   * in the ask/L1/dedupe lanes. Null when this mount has no boundary — a restart
   * on existing durable state, or a test-only `':memory:'` ledger, both keep
   * today's behavior.
   */
  preInstallNodes: Set<NodeId> | null;
  /**
   * True until the first transform captured the fresh install's pre-install
   * surface. A fresh install's first transform is the earliest observation of
   * the host's history, so it is the boundary.
   */
  installBoundaryPending: boolean;
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
   * abandoned call releases this when its late row arrives or when it truly
   * settles, whichever is first (ISSUE-410); a call that never settles can no
   * longer freeze classification. A count of live abandoned calls, never a
   * ceiling (ADR-0060).
   */
  abandonedAsks: number;
  /**
   * Obligations a late step row already consumed (ISSUE-410). The late row
   * decrements `abandonedAsks` and adds one here; the call's own settlement
   * takes this token instead of decrementing `abandonedAsks` a second time.
   */
  abandonedAsksConsumed: number;
  /**
   * Resolvers for the asks waiting on this session's `session.execution.
   * interrupted` event (ISSUE-413). The host's `generate` takes no
   * `AbortSignal`, but its event stream names the interrupt, so this is the
   * reachable cancellation seam: the waiter resolves with the host's reason and
   * the ask settles as a typed refusal instead of waiting for the deadline.
   * Empty while no ask is in flight.
   */
  askInterrupts: Set<(reason: string) => void>;
  /**
   * The prompt digests of the asks this session timed out on (ISSUE-421). The
   * timeout clears `askInFlight` while the host call still lives, so the prompt
   * is the identity that survives it: a context hook that is exactly one user
   * message carrying one of these prompts is the abandoned request re-entering,
   * not the turn's context, and is skipped whole. Never cleared: a late
   * delivery of the same abandoned request must be skipped too.
   */
  readonly abandonedAskPromptDigests: Set<string>;
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
  /**
   * How this mount's durable state was identified (ISSUE-422): `fresh` (no
   * ledger file), `restart` (a ledger file existed before the open), or
   * `no-durable-state` (`':memory:'`). A fork/clone is not identifiable from
   * the seam this adapter reads; the first transform's boundary line names
   * inherited history (`fork: 'unidentified'`) instead of guessing.
   */
  readonly installState: 'fresh' | 'restart' | 'no-durable-state';
  /**
   * Bumped once per host compaction observation (ISSUE-423). An ask stamps the
   * generation it was built under; a reply read after a compaction is refused
   * by name, and verdicts stored under an older generation are dropped before
   * any apply can record their receipts against the rewritten array.
   */
  compactionGeneration: number;
  /** The generation the last claim was made under; compared after the reply. */
  askGeneration: number;
  /**
   * The generation the stored `askVerdicts` were read under, or null when none
   * are stored. A later transform compares it with `compactionGeneration`; a
   * mismatch means the array those verdicts describe was rewritten.
   */
  verdictGeneration: number | null;
  /** True while one ask's `generate` or its deferred apply is running. */
  applyInFlight: boolean;
  /** True when a compaction landed inside those windows and owes its re-arm. */
  compactionRearmDeferred: boolean;
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
  /**
   * The install boundary (ISSUE-419): node ids present before this mount
   * started. A verdict naming one — stored or banked — is dropped, so a ledger
   * replay cannot remove pre-install history on a fresh install. Defaults to
   * `entry.preInstallNodes`; a caller holding the boundary may pass it instead.
   */
  readonly excludeNodeIds?: ReadonlySet<NodeId>;
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
  const excluded = input.excludeNodeIds ?? entry.preInstallNodes ?? undefined;
  const plan = input.plan ?? buildOpencodePassPlan({
    sessionId: entry.sessionId, snapshot, messages,
    round: input.round ?? Math.max(1, entry.passRound),
    ...(entry.dedupeClasses === undefined ? {} : { classes: entry.dedupeClasses }),
    ...(excluded === undefined ? {} : { excludeNodeIds: excluded }),
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
    entry.durableAskVerdicts.clear();
    // ISSUE-409: the durable record follows the drop, so a restart neither
    // replays a verdict naming a unit the array no longer carries nor blocks.
    entry.persistAskState();
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
      || excluded?.has(unit.nodeId) === true
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
    entry.persistAskState();
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
  if (document.removals.length === 0) {
    // ISSUE-409: the drops this pass made (retention, unseen, legacy rows) are
    // durable, so a restart does not retry a verdict the guard already settled.
    entry.persistAskState();
    return false;
  }
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
  if (applied) {
    // ISSUE-409: the ledger's `applied` row now owns these removals. A later
    // host rebuild re-applies them through the banked applied-plan index, so
    // the durable ask record stops owing them.
    for (const removal of document.removals) {
      entry.durableAskVerdicts.delete(removal.unitId);
    }
  }
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
  // ISSUE-409: persist whatever this apply settled (applied verdicts cleared,
  // guard-dropped ones gone) at the same boundary as the ledger row.
  entry.persistAskState();
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

/**
 * The provider/model one request was built for (ISSUE-432), read from 2.2.5's
 * `Model.Ref` (`{id, providerID, variant?}`) on the context hook. A field is
 * null when the host named no value; it is never a guessed substitution.
 */
export interface OpencodeModelRef {
  readonly provider: string | null;
  readonly model: string | null;
  readonly variant: string | null;
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
   * The context window the host declares for a model (ISSUE-432), read from
   * 2.2.5's `context.model` catalog by `createOpencodePlugin`. It is used only
   * to name the window a mid-session switch would need; the configured window
   * above is never overridden.
   */
  readonly resolveModelWindow?: (ref: OpencodeModelRef) => number | null;
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
   * `DEFAULT_ASK_TIMEOUT_MS` (120,000). `0` keeps the deadline off for the ask:
   * no timer is built and the lane waits for the host while the mount lives;
   * `close()` stops that wait through the mount's close signal and journals
   * `ask-close`, so teardown never hangs on it (ISSUE-425). A negative,
   * non-finite or above-platform-range value is refused by name at mount.
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
    context?: Pick<OpencodeSessionContext, 'system' | 'tools' | 'model'> | null,
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
  /**
   * True once `close()` has started (ISSUE-420). Every host callback checks it
   * and does nothing, so a callback the host kept registered after cleanup has
   * no effect: no `excludeTools` stripping, no transform, no state mutation.
   */
  readonly disposed: boolean;
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

/** The named refusal a second mount on one durable root raises (ISSUE-424, ISSUE-444). */
export const OPENCODE_DUPLICATE_MOUNT_CODE = 'duplicate-mount';

/**
 * A second live mount on one durable root (ISSUE-424, narrowed by ADR-0066 and
 * ISSUE-444). Two mounts would open two ledgers for the same session and
 * register duplicate asks and cards; the refusal is by name and names the
 * durable root it collides on, so a host log line says what happened.
 */
export class OpencodeDuplicateMountError extends Error {
  readonly code = OPENCODE_DUPLICATE_MOUNT_CODE;
  readonly key: string;

  constructor(key: string) {
    super(`cremator-opencode: a mount for the durable root ${JSON.stringify(key)} is already `
      + 'active; refusing the second mount rather than open a second ledger for the same session');
    this.name = 'OpencodeDuplicateMountError';
    this.key = key;
  }
}

/**
 * The process-level registry (ISSUE-424, narrowed by ADR-0066): the one live
 * mount per durable root. A mount's ledger paths depend on the resolved root
 * and the session id only — never on the journal, exclusion, grammar or dedupe
 * options — so two mounts on one root would eventually open the same ledger. A
 * `':memory:'` mount has no durable identity and is not tracked, so tests may
 * build as many as they need.
 */
const activeMounts = new Map<string, OpencodeMount>();

/**
 * The identity "same durable root" means for the registry (ADR-0066, ISSUE-444):
 * the resolved storage root the mount would derive every session ledger under.
 * No configuration option that leaves the ledger path alone (`journalFile`,
 * `excludeTools`, `askGrammar`, `dedupeClasses`, the token numbers) splits the
 * key. `null` for a memory mount, which is never registered.
 */
function mountRegistryKey(selection: StorageSelection): string | null {
  return selection.kind === 'durable' ? normalizeMountRoot(selection.root) : null;
}

/**
 * The one directory a durable root names (ISSUE-464, ISSUE-481). The ledger
 * path is built with `join`, which collapses a trailing separator, `.` and
 * `..`; the registry key must describe the same directory the OS will open.
 * `resolve` handles those lexical forms, `realpathSync.native` resolves the
 * longest existing ancestor (a junction or symlink, an extended-length
 * spelling, and a case-insensitive volume's own case), and Windows' trailing
 * dot and space trimming is applied per component. A tail the filesystem does
 * not hold yet is appended as typed. On Windows the volume is asked whether it
 * folds case and the whole key is folded when it does, so the key cannot change
 * the moment the first mount creates the root.
 */
function normalizeMountRoot(root: string): string {
  const lexical = resolve(stripWindowsExtendedPrefix(root));
  const trimmed = process.platform === 'win32' ? trimWindowsComponents(lexical) : lexical;
  return canonicalDirectory(trimmed);
}

/**
 * Strip the Windows extended-length prefix (ISSUE-481): `\\?\C:\store` and
 * `\\?\UNC\server\share` name the same directory as their plain spellings, so
 * two mounts must not hold two keys for them.
 */
function stripWindowsExtendedPrefix(root: string): string {
  if (process.platform !== 'win32') return root;
  if (root.startsWith('\\\\?\\UNC\\')) return `\\\\${root.slice('\\\\?\\UNC\\'.length)}`;
  if (root.startsWith('\\\\?\\')) return root.slice('\\\\?\\'.length);
  return root;
}

/**
 * Windows ignores trailing dots and spaces on every component (ISSUE-481), so
 * `C:\store.` and `C:\store ` open the same directory as `C:\store`. The
 * lexical `resolve` keeps those characters; this trims them per component,
 * never inside the volume root.
 */
function trimWindowsComponents(resolvedPath: string): string {
  const parsed = parse(resolvedPath);
  const rest = resolvedPath.slice(parsed.root.length);
  if (rest.length === 0) return resolvedPath;
  const parts = rest.split(/[\\/]+/u)
    .map(part => part.replace(/[. ]+$/u, ''))
    .filter(part => part.length > 0);
  return parts.length === 0 ? parsed.root : join(parsed.root, ...parts);
}

/**
 * Resolve the real directory behind a lexical path (ISSUE-481), asking the
 * filesystem for the longest existing ancestor: a junction or symlink and its
 * target then yield one key, and the case is the directory's own, not the
 * platform's guess. A not-yet-existing tail is appended as typed. The volume
 * itself is asked whether it folds case, and the whole key is folded when it
 * does: folding must not depend on whether the root exists yet, or the key of
 * one root would change the moment the first mount created it.
 */
function canonicalDirectory(lexical: string): string {
  const missing: string[] = [];
  let current = lexical;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      const canonical = missing.length === 0 ? real : join(real, ...missing);
      return volumeFoldsCase(real) ? canonical.toLowerCase() : canonical;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // No ancestor exists (an absent drive, for example): the lexical form
        // stays the fallback, folded on Windows like any unresolved path.
        return process.platform === 'win32' ? lexical.toLowerCase() : lexical;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether the volume holding an existing directory folds case (ISSUE-481).
 * Case is observed, not guessed from `process.platform`: the nearest ancestor
 * name that has a letter is asked for in the opposite case, and an answer whose
 * file identity (volume serial and file index) equals the original's means the
 * volume folds. Identity is used instead of comparing `realpathSync` strings:
 * on macOS `realpath` echoes the caller's case, so a case-insensitive APFS
 * volume resolved through a flipped spelling compared unequal to the real path
 * and was misreported as case-sensitive.
 */
function volumeFoldsCase(real: string): boolean {
  let current = real;
  for (;;) {
    const parent = dirname(current);
    const name = basename(current);
    const flipped = name.replace(/[a-z]/giu, letter => (letter === letter.toUpperCase()
      ? letter.toLowerCase() : letter.toUpperCase()));
    if (parent !== current && flipped !== name) {
      try { return sameFileIdentity(current, join(parent, flipped)); }
      catch { return false; }
    }
    // A drive or volume root with no letter-bearing component cannot be probed
    // by spelling; keep Windows' folding default and treat posix roots as exact.
    if (parent === current) return process.platform === 'win32';
    current = parent;
  }
}

/**
 * Whether two spellings name one file or directory (ISSUE-481). The volume
 * serial (`dev`) and file index (`ino`) are the identity the operating system
 * itself uses, so a case-flipped spelling that resolves to the same entry on a
 * case-insensitive volume compares equal. A missing flipped path throws and a
 * distinct entry reports different identity, both meaning the volume does not
 * fold. An unavailable index (`ino` 0 on some exotic volumes) is not treated as
 * a match, so the guard fails toward keeping distinct roots distinct.
 */
function sameFileIdentity(left: string, right: string): boolean {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
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

/**
 * The ask deadline a host config may name, or undefined when the option is
 * absent. A present value that is not a JS number is refused by name, like
 * `askGrammarOf` and `dedupeClassesOf`: `"crematorAskTimeoutMs": "60000"` in a
 * JSON config must never silently fall back to the 120 s default (ISSUE-446).
 * A number is returned as-is; the mount's own range checks decide whether it
 * is usable (ISSUE-425).
 */
function askTimeoutMsOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new TypeError(`racoons: crematorAskTimeoutMs is ${JSON.stringify(value)}; `
      + 'askTimeoutMs must be a number of milliseconds');
  }
  return value;
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
  const askTimeoutMs = askTimeoutMsOf(options['crematorAskTimeoutMs']);
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
    ...(askTimeoutMs === undefined ? {} : { askTimeoutMs }),
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
 * The provider/model a context hook named, or null when it named none this
 * build can read (ISSUE-432). 2.2.5's `Model.Ref` is `{id, providerID,
 * variant?}`; any other shape leaves the provenance unset rather than being
 * guessed at, so the mount never stamps a model it did not read.
 */
function modelProvenanceOf(value: unknown): OpencodeModelRef | null {
  if (!isRecord(value)) return null;
  const stringOf = (field: string): string | null => {
    const raw = value[field];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };
  const provider = stringOf('providerID');
  const model = stringOf('id');
  if (provider === null && model === null) return null;
  return { provider, model, variant: stringOf('variant') };
}

/** True when two stamps name the same provider, model and variant. */
function sameModelRef(left: OpencodeModelRef, right: OpencodeModelRef): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.variant === right.variant;
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
  /**
   * Refuse a wrong-typed value here too, not only through
   * `mountOptionsFromHost`: a JSON config arrives as `unknown` and a
   * programmatic JS caller can pass anything, and a silently ignored deadline
   * is the defect ISSUE-446 removes. The range checks below still apply to a
   * number.
   */
  const askTimeoutMs = askTimeoutMsOf(options.askTimeoutMs) ?? OPENCODE_ASK_TIMEOUT_MS;
  if (!Number.isFinite(askTimeoutMs) || askTimeoutMs < 0) {
    throw new Error('cremator: askTimeoutMs must be a non-negative millisecond count');
  }
  if (askTimeoutMs > MAX_PLATFORM_TIMER_MS) {
    // A larger delay is clamped to 1 ms by the platform timer, which would make
    // a long deadline fire immediately and terminate the lane (ISSUE-425).
    throw new Error('cremator: askTimeoutMs must not exceed the platform timer range '
      + `(${String(MAX_PLATFORM_TIMER_MS)} ms); a larger delay would fire at 1 ms`);
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
  /**
   * ISSUE-424 / ADR-0066: one live mount per durable root. The check runs here,
   * before any session is opened, so a second mount can never construct a second
   * ledger for the same session. A memory mount has no durable identity and is
   * not tracked.
   */
  const registryKey = mountRegistryKey(selection);
  if (registryKey !== null && activeMounts.has(registryKey)) {
    // The refusal names the root this caller passed, not its normalized form.
    throw new OpencodeDuplicateMountError(
      selection.kind === 'durable' ? selection.root : registryKey);
  }
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
   * True once `close()` has finished its release loop (ISSUE-407). A refused
   * cremate/idle is journalled only while teardown is in progress; after dispose
   * the ISSUE-420 contract (post-dispose calls write no journal line) stands.
   */
  let disposeComplete = false;
  /**
   * The close signal (ISSUE-425). With the ask deadline off (`0`) the lane
   * waits for the host with no timer of its own, so `close()` needs a named
   * event to stop that wait. The promise resolves once, when close starts. It
   * is an event, not a deadline: no value, no cap (standing rule 7 /
   * ADR-0060). A never-closed mount leaves it pending, which holds nothing.
   */
  let signalClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => { signalClose = resolve; });
  /**
   * In-flight mount work (ISSUE-356): every transform, event, tool call and
   * cremate the host started and has not finished. `close()` drains these
   * before closing the ledgers, so an ask that resolves after dispose never
   * writes a closed ledger and the event loop never operates on closed state.
   * An ask is bounded by the declared ask timeout, or, with the deadline off,
   * by the close signal: teardown stops waiting on it (ISSUE-425). No new cap,
   * bound or timeout is added here.
   */
  const inFlight = new Set<Promise<unknown>>();
  /**
   * The session each tracked promise belongs to (ISSUE-408). An eviction drains
   * only the deleted session's work; `close()` still drains the whole set. A
   * mount-wide event that names no session is tagged `null`.
   */
  const inFlightSession = new Map<Promise<unknown>, string | null>();
  function track<T>(work: Promise<T>, sessionId: string | null = null): Promise<T> {
    inFlight.add(work);
    inFlightSession.set(work, sessionId);
    const settled = (): void => {
      inFlight.delete(work);
      inFlightSession.delete(work);
    };
    void work.then(settled, settled);
    return work;
  }
  /**
   * The ISSUE-356 drain: every tracked transform, event, tool call and cremate
   * settles before a ledger closes, so a post-dispose ask resolution never
   * writes a closed ledger. The loop re-checks because a settling item can hand
   * off to another tracked call; asks carry the declared ask timeout, and a
   * deadline-free ask is released by the close signal (ISSUE-425), so the
   * drain is bounded by the host's own declared deadline or by teardown, never
   * by a new cap.
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
   * The per-session drain (ISSUE-408): settle only the tracked work belonging to
   * one session. `session.deleted` for A must not wait on B's ask, so deleting an
   * unrelated session no longer stalls the event consumer. The loop re-checks
   * because a settling item can hand off to new work for the same session.
   */
  async function drainSessionInFlight(
    sessionId: string, except?: Promise<unknown>,
  ): Promise<void> {
    for (;;) {
      const pending = [...inFlight].filter(work => work !== except
        && inFlightSession.get(work) === sessionId);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }
  /**
   * Sessions this mount has released (ISSUE-407). Eviction used to leave no
   * tombstone, so a late event, tool, idle or cremate naming the released id
   * could open a fresh ledger after eviction, with no owner. A released id is
   * refused by every lane except the host's own context hook (the genuine
   * lifecycle opener, which may reopen it and clears the tombstone).
   */
  const released = new Set<string>();
  /**
   * The install boundary survives an in-mount eviction/reopen (ISSUE-445).
   * Keyed by session id for the mount's life: `'pending'` until the first
   * transform captures the set, then the captured pre-install node ids. A
   * genuine process restart starts with an empty map, so today's restart
   * behavior is unchanged.
   */
  const installBoundaries = new Map<string, Set<NodeId> | 'pending'>();
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
    // ISSUE-407: a released id is a tombstone for the rest of the mount's life.
    released.add(sessionId);
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

  /**
   * ISSUE-448 / ADR-0064: seed the durable receipts before judging a prepared
   * row. A row the seeded receipts can resolve is left to recovery; a row that
   * still has no provable receipt after seeding is closed exactly once with a
   * named abandoned outcome, at the same boundary as an `applied` row, so it
   * cannot stand every later pass down in `recovery-pending`. Runs when a
   * session opens, so a row a pass writes mid-flight is never mistaken for a
   * crash-window orphan. A read or append failure is named and left fail-open.
   */
  async function settlePreparedIntents(params: {
    readonly ledger: Ledger;
    readonly receipts: readonly ApplyReceipt[];
    readonly sessionId: string;
  }): Promise<void> {
    const { ledger, receipts, sessionId } = params;
    const prepared = new Map<string, number>();
    const finished = new Set<string>();
    try {
      for await (const row of ledger.events(sessionId)) {
        const event = row.event;
        if (event.kind === 'prepared') {
          if (!prepared.has(event.intentId)) prepared.set(event.intentId, event.atMs);
        } else if (event.kind === 'applied') {
          finished.add(event.receipt.intentId);
        } else if (event.kind === 'abandoned') {
          finished.add(event.intentId);
        }
      }
    } catch (error) {
      journal('mount-state-error', { sessionId, fact: 'prepared-read',
        message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const seeded = new Set(receipts.map(receipt => receipt.intentId));
    for (const [intentId, atMs] of prepared) {
      if (finished.has(intentId) || seeded.has(intentId)) continue;
      try {
        await ledger.append({ kind: 'abandoned', sessionId, intentId, atMs,
          eventKey: `adapter-abandoned:${intentId}`,
          reason: 'A prepared intent had no durable receipt after remount seeding; '
            + 'closed once as abandoned' });
        journal('intent-abandoned', { sessionId, intentId, reason: 'no-durable-receipt' });
      } catch (error) {
        journal('mount-state-error', { sessionId, fact: 'abandoned-write', intentId,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * The one open/lookup a lane uses.
   * `allowReopen` is the host's genuine lifecycle opener (ISSUE-407): the
   * `context` hook is the only caller that passes `true`, because the host may
   * present a brand-new request for an id it released; every other lane
   * (event, tool, idle, cremate, recall) leaves it false and is refused when the
   * id is a released tombstone.
   */
  async function sessionFor(
    sessionId: string, allowReopen = false,
  ): Promise<OpencodeSessionEntry | null> {
    // ISSUE-393: once close() starts, no new session work — a still-mapped
    // entry's ledger close may be next, and a released session must not re-open.
    if (closing) return null;
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    // ISSUE-407: a released id is not reopened by late event/tool/idle/cremate
    // traffic; only a genuine context hook may revive it.
    if (!allowReopen && released.has(sessionId)) return null;
    let target: StorageTarget;
    try {
      target = sessionStorage(selection, sessionId);
    } catch (error) {
      refuseStorage(sessionId, error);
      return null;
    }
    /**
     * ISSUE-419: the durable ledger file is the per-session record that this
     * session was mounted before. Its absence at this open means a fresh
     * install, so the first transform's nodes are the pre-install boundary. A
     * `':memory:'` ledger has no durable identity and keeps today's behavior.
     * Read before `open` — the open creates the file.
     */
    const freshInstall = target.kind === 'durable' && !existsSync(target.databasePath);
    /**
     * ISSUE-445: a boundary captured earlier in this mount outlives the entry
     * that held it. A reopen of an id this mount evicted restores the same
     * pre-install set instead of recomputing it from file existence (the file
     * now exists, so the recompute would wrongly call it a restart).
     */
    const priorBoundary = installBoundaries.get(sessionId);
    if (priorBoundary === undefined && freshInstall) installBoundaries.set(sessionId, 'pending');
    const retainedBoundary = priorBoundary instanceof Set ? priorBoundary : null;
    const boundaryPending = priorBoundary === 'pending'
      || (priorBoundary === undefined && freshInstall);
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
    // ISSUE-407: a context-hook reopen makes the id live again; the tombstone goes.
    released.delete(sessionId);
    journal('storage-plan', { sessionId, databasePath: target.databasePath,
      blobRoot: target.blobRoot, node: process.version });
    /**
     * ISSUE-422: the host exposes no fork/clone event in the seam this mount
     * reads. A child id's storage is its own (fresh install → the first
     * transform's boundary excludes the inherited history). The one shape the
     * adapter cannot resolve is a durable file that exists but holds NO events
     * for this session: that is either a parent's copied ledger or a state-less
     * earlier mount of this id. It is NAMED on the install line as
     * `fork: 'unidentified'` and this mount keeps the shipped restart rule —
     * the adapter records that it cannot identify the fork instead of guessing.
     */
    const forkUnidentified = target.kind === 'durable' && !freshInstall
      && !(await ledgerHasAnyEvent(ledger, sessionId));
    const installState: OpencodeSessionEntry['installState'] = freshInstall ? 'fresh'
      : target.kind === 'durable' ? 'restart' : 'no-durable-state';
    journal('install', { sessionId, state: installState, mountedAtMs: clock.nowMs(),
      ...(forkUnidentified
        ? { fork: 'unidentified',
          reason: 'the durable ledger holds no events for this session; a fork/clone cannot be '
            + 'told apart from a reopen, so the restart rule is kept and no boundary is claimed' }
        : {}) });
    // ISSUE-445: a reopen after an in-mount eviction restores the captured
    // boundary and names that state, so the journal distinguishes it from a
    // genuine process restart (which starts with an empty map).
    if (retainedBoundary !== null) {
      journal('install', { sessionId, state: 'boundary', reopened: true,
        preInstallNodes: retainedBoundary.size, installState,
        reason: 'the install boundary is retained by this mount across eviction; the reopened '
          + 'entry keeps pre-install nodes out of the ask/L1/dedupe lanes' });
    }
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
    /**
     * ISSUE-448: the durable receipts a previous process wrote at the host
     * write. The ledger read above seeds what was *applied*; these seed what
     * was *landed*, so a prepared row whose `applied` row never arrived can be
     * resolved instead of standing down in `recovery-pending` forever. A
     * `':memory:'` target has no durable store.
     */
    let receiptsRefused = false;
    const durableReceipts = target.kind === 'durable'
      ? readDurableReceipts(target, message => {
        receiptsRefused = true;
        journal('mount-state-error', { sessionId, fact: 'receipts', message });
      })
      : [];
    if (durableReceipts.length > 0) {
      journal('receipts-resumed', { sessionId, count: durableReceipts.length });
    }
    /**
     * ISSUE-448 / ADR-0064: seed before judging. A prepared row the seeded
     * receipts resolve is left to recovery; one that still has no provable
     * receipt is closed once with a named abandoned outcome. This runs at open,
     * never per event, so a row a pass writes mid-flight is not a crash orphan.
     *
     * ISSUE-485: a refused or malformed receipts read is not "no receipt". The
     * empty list it returns would abandon every prepared row permanently, so
     * the judgement is skipped for this open and the skip is named.
     */
    if (target.kind === 'durable') {
      if (receiptsRefused) {
        journal('mount-state-error', { sessionId, fact: 'prepared-seed',
          message: 'the durable receipts record was refused; prepared intents are not judged '
            + 'against it on this open' });
      } else {
        await settlePreparedIntents({ ledger, receipts: durableReceipts, sessionId });
      }
    }
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
      ...(durableReceipts.length === 0 ? {} : { receipts: durableReceipts }),
      persistReceipt: (receipt) => {
        if (target.kind !== 'durable') return;
        const written = writeDurableReceipt(target, receipt);
        if (!written.ok) {
          journal('mount-state-error', { sessionId, fact: 'receipt',
            intentId: receipt.intentId, message: written.message ?? 'unknown write failure' });
        }
      },
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
          // ADR-0063: the asked set, the revision claims and an unapplied
          // verdict are durable; a reload restores them instead of starting
          // fresh, so a claimed unit is not re-asked.
          reload: 'the ask identity (revision claims, unit claims and unapplied verdicts) is '
            + 'written to durable state; a reload restores it' } }) });
    /**
     * ISSUE-409 / ADR-0063: the ask identity a previous process claimed or
     * answered but did not settle. Restoring it before the entry exists stops
     * the first transform from re-asking a claimed revision or losing an
     * unapplied verdict.
     */
    const durableAsk = target.kind === 'durable'
      ? readDurableAskState(target, message => journal('mount-state-error',
        { sessionId, fact: 'ask', message }))
      : null;
    /**
     * ISSUE-467 / ADR-0063 clause 3: the drop is a durable write, not a
     * read-time filter. An ask-off mount clears the record it would otherwise
     * leave for a later ask-on mount to resurrect, and loads no verdict or
     * claim of its own, so `ask-state-dropped` is true.
     */
    const seededAsk = askGrammar === undefined ? null : durableAsk;
    if (askGrammar === undefined && durableAsk !== null) {
      const cleared = writeDurableAskState(target, {
        revisions: [], askedUnitIds: [], retriedUnitIds: [], refusedRetriedUnitIds: [],
        verdicts: [], deferredApply: false, deferredFailures: 0,
      });
      if (!cleared.ok) {
        // ISSUE-483: a failed clear has its own line; claiming the drop would
        // report an intent the durable record still carries.
        journal('mount-state-error', { sessionId, fact: 'ask',
          message: cleared.message ?? 'unknown write failure' });
      } else {
        const claims = durableAsk.askedUnitIds.length;
        const revisions = durableAsk.revisions.length;
        const verdicts = durableAsk.verdicts.length;
        const retries = durableAsk.retriedUnitIds.length
          + durableAsk.refusedRetriedUnitIds.length;
        if (claims + revisions + verdicts + retries > 0
          || durableAsk.deferredApply || durableAsk.deferredFailures > 0) {
          journal('ask-state-dropped', { sessionId, count: verdicts, claims, revisions,
            reason: 'the ask lane is off at this mount, so the restored ask identity '
              + '(verdicts and claims) is erased' });
        }
      }
    }
    const restoredVerdicts = seededAsk?.verdicts ?? [];
    const durableAskVerdicts = new Map<UnitId, DurableAskVerdict>(
      restoredVerdicts.map(verdict => [verdict.unitId as UnitId, verdict] as const));
    const restoredSeen = new Set<NodeId>(
      restoredVerdicts.map(verdict => verdict.nodeId as NodeId));
    if (restoredVerdicts.length > 0) {
      journal('ask-state-resumed', { sessionId,
        revisions: seededAsk?.revisions.length ?? 0,
        claims: seededAsk?.askedUnitIds.length ?? 0,
        verdicts: restoredVerdicts.length });
    }
    const entry: OpencodeSessionEntry = {
      sessionId, ledger, port,
      appliedPlans: port.appliedPlanIndex?.()
        ?? new Map(seededAppliedPlans.map(plan => [plan.intentId, plan] as const)),
      engine, meter,
      pruneTrigger: new PruneWindowTrigger(contextWindowTokens, pruneThresholdTokens),
      parametersDerivedFrom: null, observedModel: null,
      dedupeClasses: options.dedupeClasses ?? {},
      ownedLedger: options.openLedger === undefined,
      lastMessages: null, pendingEstimates: [], droppedEstimates: 0,
      usageSeen: new Set<string>(),
      askedUnitIds: new Set<UnitId>(
        (seededAsk?.askedUnitIds ?? []) as readonly UnitId[]),
      askedRevisions: new Set<string>(seededAsk?.revisions ?? []),
      retriedUnitIds: new Set<UnitId>(
        (seededAsk?.retriedUnitIds ?? []) as readonly UnitId[]),
      refusedRetriedUnitIds: new Set<UnitId>(
        (seededAsk?.refusedRetriedUnitIds ?? []) as readonly UnitId[]),
      askVerdicts: new Map<UnitId, WireAnswer>(
        restoredVerdicts.map(verdict => [verdict.unitId as UnitId, verdict.answer] as const)),
      durableAskVerdicts,
      persistAskState: () => {
        if (target.kind !== 'durable') return;
        // A verdict an apply or a guard settled is no longer owed. It may stay
        // in `askVerdicts` so a rebuilt host request re-applies the banked
        // removal, but the ledger's applied row owns it from here (ISSUE-409).
        for (const unitId of entry.durableAskVerdicts.keys()) {
          if (!entry.askVerdicts.has(unitId)) entry.durableAskVerdicts.delete(unitId);
        }
        const written = writeDurableAskState(target, {
          revisions: [...entry.askedRevisions],
          askedUnitIds: [...entry.askedUnitIds],
          retriedUnitIds: [...entry.retriedUnitIds],
          refusedRetriedUnitIds: [...entry.refusedRetriedUnitIds],
          verdicts: [...entry.durableAskVerdicts.values()],
          deferredApply: entry.deferredApply,
          deferredFailures: entry.deferredFailures,
        } satisfies DurableAskState);
        if (!written.ok) {
          journal('mount-state-error', { sessionId, fact: 'ask',
            message: written.message ?? 'unknown write failure' });
        }
      },
      seenNodeIds: restoredSeen, pendingSeenNodeIds: new Set<NodeId>(),
      preInstallNodes: retainedBoundary, installBoundaryPending: boundaryPending,
      installState,
      compactionGeneration: 0, askGeneration: 0, verdictGeneration: null,
      applyInFlight: false, compactionRearmDeferred: false,
      stepAskFired: false, askInFlight: false, abandonedAsks: 0, abandonedAsksConsumed: 0,
      askInterrupts: new Set(), askStepRowsSeen: false,
      abandonedAskPromptDigests: new Set<string>(),
      askFires: 0, passRound: 0, passRemovalsApplied: false,
      deferredApply: (seededAsk?.deferredApply ?? false) || restoredVerdicts.length > 0,
      deferredFailures: seededAsk?.deferredFailures ?? 0,
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
      // ISSUE-410: the row consumes one abandoned-ask obligation, so a call
      // that never settles cannot freeze classification forever. Settlement
      // takes the consumed token instead of decrementing a second time.
      if (!entry.usageSeen.has(row.messageId)) {
        entry.usageSeen.add(row.messageId);
        entry.abandonedAsks -= 1;
        entry.abandonedAsksConsumed += 1;
      }
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
    for (const nodeId of entry.pendingSeenNodeIds) {
      /**
       * ISSUE-419: a node on the install boundary was present before the plugin
       * mounted. It never enters the seen set, so `isSeenUnit` keeps it out of
       * every ask table and ask apply for the life of the mount.
       */
      if (entry.preInstallNodes?.has(nodeId) === true) continue;
      entry.seenNodeIds.add(nodeId);
    }
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
      // ISSUE-432: the model these numbers describe, so a switch is visible on
      // every reading and not only on the one line that first named it.
      derivedFrom: entry.parametersDerivedFrom,
      crossed,
    });
    return crossed;
  }

  /**
   * The provider/model one request was built for, when the host names it
   * (ISSUE-432). The window and bar are mount options chosen for a model; the
   * first hook that names one stamps them. A later hook naming a different
   * provider/model files one `model-change` line naming every value that did not
   * follow and the model it came from. Nothing is re-derived: the configured
   * window is authoritative, and the host's model catalog is consulted only to
   * name the window the new model declares.
   */
  function observeModel(entry: OpencodeSessionEntry, model: unknown): void {
    const ref = modelProvenanceOf(model);
    if (ref === null) return;
    const previous = entry.observedModel;
    if (previous !== null && sameModelRef(previous, ref)) return;
    entry.observedModel = ref;
    const derivedFrom = entry.parametersDerivedFrom;
    if (derivedFrom === null) {
      entry.parametersDerivedFrom = ref;
      return;
    }
    if (sameModelRef(derivedFrom, ref)) return;
    const derivedBar = pruneThresholdTokens === null;
    const stale = contextWindowTokens === null ? []
      : [...(derivedBar ? ['bar'] : []), 'window'];
    const hostWindow = options.resolveModelWindow === undefined
      || ref.provider === null || ref.model === null
      ? null : options.resolveModelWindow(ref);
    journal('model-change', {
      sessionId: entry.sessionId, from: previous, to: ref,
      /**
       * `session.generate` takes no model (`{sessionID, prompt}`): the host
       * resolves the session's active model, so the binding follows a switch
       * with no value of its own to refresh.
       */
      generate: 'host-resolved',
      stale,
      derivedFrom,
      parameters: {
        window: { value: contextWindowTokens, derivedFrom },
        // An explicit bar is the operator's absolute count, not model-derived.
        bar: { value: entry.pruneTrigger.threshold,
          derivedFrom: derivedBar ? derivedFrom : null },
        skipAt: { value: entry.pruneTrigger.skipThreshold, derivedFrom },
      },
      reason: contextWindowTokens === null
        ? 'no-window-configured'
        : (hostWindow === null ? 'no-host-window-declared' : 'window-not-re-derived'),
      hostSeam: options.resolveModelWindow === undefined ? 'absent' : 'model-catalog',
      ...(hostWindow === null ? {} : { hostWindow }),
    });
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
    context: Pick<OpencodeSessionContext, 'system' | 'tools' | 'model'> | null = null,
  ): Promise<void> {
    // ISSUE-420: a callback the host kept after cleanup does nothing.
    if (closing) return;
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      journal('transform', { reason: 'no-session' });
      return;
    }
    // ISSUE-407: the host's own context hook is the one genuine lifecycle
    // opener, so it may reopen an id it released; every other lane is refused.
    const entry = await sessionFor(sessionId, true);
    if (entry === null) return;
    // ISSUE-432: observe the request's model before any early return, so a
    // switch is named even when this hook is otherwise skipped.
    observeModel(entry, context?.model);
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
    /**
     * ISSUE-421: the timeout cleared `askInFlight` while the host call still
     * lives, so the abandoned request's own context hook can reach here. Its
     * identity is the ask prompt, which survives the timeout: a hook that is
     * exactly one user message carrying that prompt is the generate request,
     * never the turn's context. It is skipped before `lastMessages` is
     * overwritten, so no at-rest pass runs and no second ask can fire over it.
     */
    const abandonedPrompt = abandonedAskPrompt(entry, messages);
    if (abandonedPrompt !== null) {
      journal('ask-abandoned', { sessionId, promptSha256: abandonedPrompt,
        messageCount: messages.length, reason: 'ask-request' });
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
      /**
       * ISSUE-419: the fresh install's first transform is the earliest
       * observation of the host's stored history, so its nodes are the install
       * boundary. Recorded once, before any pass runs; from here on "first
       * observed after mount" is decidable per node.
       */
      if (entry.installBoundaryPending) {
        entry.installBoundaryPending = false;
        entry.preInstallNodes = new Set(observed.nodes.map(node => node.id));
        // ISSUE-445: keep the boundary for the mount's life, so an eviction and
        // reopen of this id restores it instead of recomputing from file existence.
        installBoundaries.set(sessionId, entry.preInstallNodes);
        // ISSUE-422: nodes already on the first transform's array were never
        // seen by this mount. They are excluded from every later lane; when
        // there are any, the line names them as inherited history, because a
        // fork/clone and a fresh install into history are the same shape here.
        journal('install', { sessionId, state: 'boundary',
          preInstallNodes: entry.preInstallNodes.size,
          observedNodes: observed.nodes.length, revision: observed.revision,
          installState: entry.installState,
          inheritedHistory: entry.preInstallNodes.size > 0,
          ...(entry.preInstallNodes.size > 0 ? { fork: 'unidentified' } : {}) });
      }
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
         * ISSUE-423: a host compaction landed between the ask that stored these
         * verdicts and this apply. The array they describe was rewritten, so
         * applying them would record receipts for the pre-ask array. They are
         * dropped by name and their units released; the banked ledger index
         * still re-applies any removal an earlier apply already landed.
         */
        if (entry.askVerdicts.size > 0 && entry.verdictGeneration !== null
          && entry.verdictGeneration !== entry.compactionGeneration) {
          const droppedUnits = [...entry.askVerdicts.keys()];
          const verdictGeneration = entry.verdictGeneration;
          for (const unitId of droppedUnits) {
            entry.askVerdicts.delete(unitId);
            entry.askedUnitIds.delete(unitId);
            entry.retriedUnitIds.delete(unitId);
            entry.refusedRetriedUnitIds.delete(unitId);
          }
          entry.verdictGeneration = null;
          journal('compaction-stale', { sessionId,
            generation: entry.compactionGeneration, verdictGeneration,
            unitIds: droppedUnits, count: droppedUnits.length,
            reason: 'a host compaction landed between the ask and its apply, so the stored '
              + 'verdicts name an array that no longer exists; no receipt is recorded for it' });
        }
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
              ...(entry.preInstallNodes === null
                ? {} : { excludeNodeIds: entry.preInstallNodes }),
            });
          } catch (error) {
            buildThrew = true;
            journal('ask-error', { sessionId, origin: 'step', stage: 'rows',
              message: error instanceof Error ? error.message : String(error) });
          }
        }
        let answers: ReadonlyMap<UnitId, WireAnswer> = new Map();
        if (crossed) {
          // ISSUE-447: read the same health the prune apply checks, before the
          // host is paid. A standdown is not a pass: it is named, sends
          // nothing, and leaves the crossing live for a healthier later read.
          // With the ask off there is no send to gate, so no read is made.
          const standdown = askGrammar === undefined
            ? null : await opencodeAskStanddown(entry.ledger, entry.sessionId);
          let outcome: AskOutcome = 'no-table';
          if (standdown !== null) {
            journalAskStanddown(entry, 'step', standdown);
          } else if (batch !== null && batch.prompt !== null) {
            const sent = await askPass(entry, 'step', batch);
            outcome = sent.outcome;
            answers = sent.answers;
            entry.stepAskFired = outcome === 'fired';
          } else if (unitClaimSuppressed(batch)) {
            outcome = 'claimed-unit';
          }
          // ISSUE-431: a crossing with nothing tableable is named as its own
          // outcome, so "fired with nothing eligible" is not indistinguishable
          // from an ask the mount suppressed. ISSUE-468: a refusal by the claim
          // guard is named as the suppression it is, not as an empty crossing.
          // A build that threw already has its own ask-error line.
          if (standdown === null && !buildThrew) {
            if (outcome === 'no-table') {
              journal('prune-outcome', { sessionId, origin: 'step', outcome: 'no-eligible',
                reason: 'the depth crossing held no tableable unit; no ask was sent and none '
                  + 'was suppressed' });
            } else if (outcome === 'claimed-unit') {
              journal('prune-outcome', { sessionId, origin: 'step', outcome,
                claims: batch?.dropped.asked ?? 0,
                reason: 'the depth crossing held a tableable unit, but no row survived the '
                  + 'durable unit claim' });
            } else if (outcome === 'claimed-revision' || outcome === 'ask-in-flight') {
              journal('prune-outcome', { sessionId, origin: 'step', outcome,
                reason: 'the depth crossing held a tableable unit, but the ask was suppressed '
                  + (outcome === 'claimed-revision'
                    ? 'by a durable revision claim'
                    : 'by an ask already in flight for this session') });
            }
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
            // ISSUE-447: a standdown paid nothing and applied nothing, so it is
            // skipped like a zero-eligible crossing; the next above-bar reading
            // must still fire once the ledger is healthy. ISSUE-468: a named
            // claim or in-flight refusal takes the same latch path `no-table`
            // took before it was named, so this fix changes no timing.
            const noSend = outcome === 'no-table' || outcome === 'claimed-revision'
              || outcome === 'claimed-unit' || outcome === 'ask-in-flight';
            if (noSend
              && (entry.seenNodeIds.size === 0 || buildThrew || standdown !== null)) {
              entry.pruneTrigger.notePassSkipped();
            } else {
              entry.pruneTrigger.notePassCompleted();
            }
          }
        }
        let deferredRemoved = false;
        if (batch !== null) {
          const snap = observeRequest(messages);
          // ISSUE-423: the apply window. A compaction that ends while this
          // apply runs defers its latch re-arm instead of clearing the baseline
          // the apply is still measuring against.
          entry.applyInFlight = true;
          try {
            deferredRemoved = await applyOpencodeAskVerdicts({
              entry, messages, snapshot: snap, plan: batch.plan, answers,
              bankedRows: batch.bankedRows,
              window: contextWindowTokens
                ?? Math.max(1, estimateRequestTokens(estimateMeter, snap, prefix)),
              hostWindow: contextWindowTokens,
              ...(entry.preInstallNodes === null
                ? {} : { excludeNodeIds: entry.preInstallNodes }),
              journal,
            });
            committed = deferredRemoved || committed;
          } catch (error) {
            journal('ask-error', { sessionId, origin: 'step', stage: 'apply',
              message: error instanceof Error ? error.message : String(error) });
          } finally {
            entry.applyInFlight = false;
            settleCompactionRearm(entry);
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
        } else if (batch !== null) {
          /**
           * ISSUE-431: a step-origin fire's apply follows the same
           * one-retry-then-drop policy as the deferred paths. Without this a
           * permanently failing apply keeps the verdicts stored, and every
           * later transform retries the same removal forever.
           */
          const verdictsRemain = entry.askVerdicts.size > 0;
          if (verdictsRemain && !deferredRemoved) {
            entry.deferredFailures += 1;
            if (entry.deferredFailures >= 2) {
              const droppedUnits = [...entry.askVerdicts.keys()];
              for (const unitId of droppedUnits) {
                entry.askVerdicts.delete(unitId);
                entry.askedUnitIds.delete(unitId);
                entry.retriedUnitIds.delete(unitId);
                entry.refusedRetriedUnitIds.delete(unitId);
              }
              entry.deferredFailures = 0;
              journal('ask-error', {
                sessionId, origin: 'step', stage: 'deferred-drop',
                unitIds: droppedUnits,
                reason: 'two consecutive step applies failed; the stored verdicts are '
                  + 'dropped and their units released so they are not retried on every '
                  + 'later transform; a verdict an earlier apply already landed stays '
                  + 'banked in the ledger and re-applies from there',
              });
            }
          } else {
            entry.deferredFailures = 0;
          }
        }
        // ISSUE-409: any drop this pass made (a stale compaction, a deferred
        // give-up) is durable, so the next mount neither replays nor blocks.
        entry.persistAskState();
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

  /**
   * The prompt digest when this context hook IS a timed-out ask re-entering
   * (ISSUE-421), null otherwise. The transient `session.generate` request is
   * one user message whose text is the ask prompt; the turn's own request
   * carries a conversation, so the shape is the second half of the identity
   * and a main request that merely holds the table as history never matches.
   */
  function abandonedAskPrompt(
    entry: OpencodeSessionEntry, messages: readonly OpencodeMessage[],
  ): string | null {
    if (entry.abandonedAskPromptDigests.size === 0) return null;
    if (messages.length !== 1) return null;
    const only = messages[0];
    if (only === undefined || only.role !== 'user') return null;
    const text = only.content
      .filter((part): part is OpencodeTextPart => part.type === 'text'
        && typeof part['text'] === 'string')
      .map(part => part.text)
      .join('');
    const digest = sha256Of(text);
    return entry.abandonedAskPromptDigests.has(digest) ? digest : null;
  }

  /** One named line for an ask the durable ledger refuses (ISSUE-447). */
  function journalAskStanddown(
    entry: OpencodeSessionEntry, origin: 'step' | 'idle' | 'command',
    reason: OpencodeAskStanddownReason,
  ): void {
    journal('ask-standdown', {
      sessionId: entry.sessionId, origin, reason,
      message: reason === 'ledger-unavailable'
        ? 'the ledger read failed; standing down rather than paying for a table the '
          + 'engine cannot apply'
        : reason === 'recovery-pending'
          ? 'an unfinished prepared intent is waiting for recovery; the engine would '
            + 'answer recovery-pending'
          : 'the breaker is disabled; the engine would answer breaker-open',
    });
  }

  /**
   * What one ask attempt did: a readable fire, an attempted send, no table, or
   * a named guard refusal (ISSUE-468). A claim refusal is not the same fact as
   * "nothing was tableable": the batch held rows and the ask was suppressed.
   * ISSUE-486: a unit claim lives in the batch builder, so the refusal it
   * causes is returned here as `claimed-unit`, a sibling of the revision claim,
   * instead of being reported as an empty crossing.
   */
  type AskOutcome = 'fired' | 'attempted' | 'no-table' | 'claimed-revision'
    | 'claimed-unit' | 'ask-in-flight';

  /**
   * ISSUE-486: the batch held tableable rows and every one was dropped by a
   * durable unit claim, so no prompt was built. That is a named suppression,
   * not an empty crossing, and the three lanes journal it as `claimed-unit`.
   */
  function unitClaimSuppressed(batch: OpencodeAskBatch | null): boolean {
    return batch !== null && batch.rows.length === 0 && batch.dropped.asked > 0;
  }

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
    if (entry.askInFlight) return { outcome: 'ask-in-flight', answers: new Map() };
    if (entry.askedRevisions.has(batch.revision)) {
      return { outcome: 'claimed-revision', answers: new Map() };
    }
    entry.askInFlight = true;
    try {
      return await askOnce(entry, origin, generate, batch);
    } finally {
      entry.askInFlight = false;
      settleCompactionRearm(entry);
    }
  }

  /**
   * Take a compaction's deferred latch re-arm once no ask and no apply is
   * running (ISSUE-423). Safe to call on every window close: it does nothing
   * when nothing was deferred or another window still holds the latch.
   */
  function settleCompactionRearm(entry: OpencodeSessionEntry): void {
    if (!entry.compactionRearmDeferred || entry.askInFlight || entry.applyInFlight) return;
    entry.compactionRearmDeferred = false;
    if (entry.pruneTrigger.enabled) entry.pruneTrigger.noteNativeCompaction();
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
    // ISSUE-409: the claim is durable BEFORE the paid request leaves. A process
    // death during the call then restores the revision and unit claims, so the
    // unit is never generated a second time for a revision already asked.
    entry.persistAskState();
    // ISSUE-423: the ask carries the compaction generation it was built under.
    // A compaction observed on the event lane while it runs bumps the entry's
    // generation, and the reply is then refused by name instead of stored.
    entry.askGeneration = entry.compactionGeneration;
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
      generation: entry.askGeneration,
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
     * `terminal` is the timeout's and the interrupt's policy. The host call is
     * abandoned, not cancelled (`OpencodeGenerateInput` carries no AbortSignal),
     * so releasing the units would let a later revision table and generate the
     * same unit while the first call may still be running: two live ask requests
     * and a spend that is either double-counted or unmeasured. Both a timeout
     * and an interrupt therefore keep the permanent claim and journal `retry:
     * 'none'`, `terminal: true`. Every other ask-error stage keeps its one retry.
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
      // ISSUE-409: a failed ask moved units into the retry record (or kept the
      // terminal claim), so the durable identity follows it.
      entry.persistAskState();
      return { outcome: 'attempted', answers: new Map() };
    };
    let text = '';
    let usage: OpencodeUsageRow | null = null;
    try {
      const call = generate({ sessionID: entry.sessionId, prompt: batch.prompt ?? '' });
      /**
       * One abandoned call's obligation (ISSUE-396, ISSUE-410). Settlement
       * releases it unless a late step row already consumed it: the counter is
       * decremented by whichever arrives first, never twice.
       */
      const abandon = (): void => {
        entry.abandonedAsks += 1;
        const settled = (): void => {
          if (entry.abandonedAsksConsumed > 0) entry.abandonedAsksConsumed -= 1;
          else entry.abandonedAsks -= 1;
        };
        void call.then(settled, settled);
      };
      const raced = await (async () => {
        /**
         * ISSUE-413: the host's generate takes no `AbortSignal`, but the event
         * stream reports `session.execution.interrupted` for this session. The
         * waiter is registered only while the call runs; the event lane resolves
         * it with the host's reason, so the ask stops waiting now instead of at
         * the deadline.
         */
        let interruptReason = '';
        let signalInterrupt: () => void = () => {};
        const interrupted = new Promise<void>(resolve => { signalInterrupt = resolve; });
        const onInterrupt = (reason: string): void => {
          interruptReason = reason;
          signalInterrupt();
        };
        entry.askInterrupts.add(onInterrupt);
        try {
          const race = await askWithinDeadline(call, askTimeoutMs, closed, interrupted);
          return { race, interruptReason };
        } finally {
          entry.askInterrupts.delete(onInterrupt);
        }
      })();
      if (raced.race.status === 'interrupted') {
        /**
         * A user (or shutdown/superseded) interrupt ended the turn. The host
         * call cannot be cancelled, so it is abandoned exactly like a timeout:
         * the units keep their permanent claim and no retry is offered, but the
         * lane stops waiting and names the interrupt now.
         */
        entry.abandonedAskPromptDigests.add(promptSha256);
        abandon();
        return fail('interrupt',
          `the session was interrupted (${raced.interruptReason || 'host'}) before the ask `
          + 'replied; the host call cannot be cancelled, so the units stay claimed with no '
          + 'retry',
          { interruptReason: raced.interruptReason || 'host' }, true);
      }
      const race = raced.race;
      if (race.status === 'closed') {
        /**
         * ISSUE-425: the mount closed while this ask was waiting with its
         * deadline off. The host call is not cancelled (no `AbortSignal`), so
         * it is abandoned like a timed-out one; teardown no longer waits on it.
         */
        abandon();
        journal('ask-close', {
          ...claimed, stage: 'close', durationMs: clock.nowMs() - startedAtMs,
          applied: false, requestKind: 'ask',
          abandonedPromptSha256: promptSha256,
        });
        return { outcome: 'attempted', answers: new Map() };
      }
      if (race.status === 'timeout') {
        /**
         * ISSUE-396: the abandoned call is not cancelled — it can still end a
         * step after the lock cleared. Count it until it truly settles so its
         * late unstated row stays in the ask lane and never pairs a main
         * estimate. The lane itself does not wait.
         *
         * ISSUE-421: the prompt digest survives the timeout and identifies the
         * abandoned request if the host still delivers its context hook.
         */
        entry.abandonedAskPromptDigests.add(promptSha256);
        abandon();
        return fail('timeout',
          `the ask produced no reply within ${String(askTimeoutMs)} ms; the request may still `
          + 'be running in the host, and this lane does not wait for it. The units stay claimed '
          + 'with no retry: a second generate for them could run beside the abandoned one',
          {}, true);
      }
      if (race.status === 'rejected') throw race.error;
      const answer = race.value;
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
    /**
     * ISSUE-423: the host compacted while this ask was in flight. The reply
     * describes rows of an array that no longer exists, so it is refused by
     * name: no verdict is stored (no receipt can be recorded for the pre-ask
     * array), no fire is counted, and the units are released so a later
     * revision may table them again. The revision stays claimed, so the same
     * array is not asked twice.
     */
    if (entry.compactionGeneration !== entry.askGeneration) {
      for (const unitId of batch.unitIds) {
        entry.askedUnitIds.delete(unitId);
        entry.retriedUnitIds.delete(unitId);
        entry.refusedRetriedUnitIds.delete(unitId);
      }
      journal('ask-error', {
        ...claimed, stage: 'compaction',
        generation: entry.compactionGeneration, askGeneration: entry.askGeneration,
        answerSha256: sha256Of(text), answerChars: text.length,
        durationMs: clock.nowMs() - startedAtMs,
        applied: false, requestKind: 'ask',
        message: 'the host compacted while this ask was in flight; the reply names an array '
          + 'that no longer exists, so no verdict is stored and the units are released',
      });
      entry.persistAskState();
      return { outcome: 'attempted', answers: new Map() };
    }
    entry.askFires += 1;
    const outcome = bookkeepAnswers(entry, batch, parsed);
    // ISSUE-423: the generation these verdicts were read under. A compaction
    // before the apply makes them name a rewritten array, so the next transform
    // drops them by name rather than recording receipts for the pre-ask array.
    if (entry.askVerdicts.size > 0) entry.verdictGeneration = entry.askGeneration;
    // ISSUE-409: a readable verdict is durable before this ask returns, so a
    // process death between the reply and its apply loses nothing.
    entry.persistAskState();
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
    /** The node each row addresses, so a restored verdict can be marked seen. */
    const nodeByIndex = new Map<number, NodeId>(
      batch.rows.flatMap((row, position) => {
        const unitId = batch.unitIds[position];
        return unitId === undefined ? [] : [[row.index, row.unit.nodeId] as const];
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
          // ISSUE-409: an unapplied verdict is durable from the moment it is
          // read; a restart applies it instead of losing it.
          const nodeId = nodeByIndex.get(row.index);
          if (nodeId !== undefined) {
            entry.durableAskVerdicts.set(unitId, { unitId, nodeId, answer: row.answer });
          }
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

  /** One ask race's outcome: answered, interrupted, timed out, closed, or rejected. */
  type AskRace<T> =
    | { readonly status: 'answered'; readonly value: T }
    | { readonly status: 'interrupted' }
    | { readonly status: 'timeout' }
    | { readonly status: 'closed' }
    | { readonly status: 'rejected'; readonly error: unknown };

  /**
   * Races one `session.generate` promise against the ask deadline, the mount's
   * close signal, and the host's interrupt event (ISSUE-413). This host's
   * generate takes no `AbortSignal` (`host.ts` `OpencodeGenerateInput` is
   * `{sessionID, prompt}`), so the mount cannot cancel the host call; it stops
   * WAITING for it, journals the timeout or interrupt as an ask error, and never
   * counts it as a fire. The abandoned promise is left to settle unobserved. The
   * ask's units stay claimed (terminal): the abandoned call may still be
   * running, so a later revision must not generate them a second time.
   *
   * With the deadline off (`0`, ISSUE-425) no timer is built and the lane waits
   * for the host; the close signal and the interrupt still end that wait, so
   * teardown never hangs on a deadline-free ask. The signal is an event, not a
   * cap. A declared deadline keeps its own bound and close drains it as before
   * (ISSUE-356).
   */
  function askWithinDeadline<T>(
    value: Promise<T>, timeoutMs: number, closeSignal: Promise<void>,
    interruptSignal?: Promise<void>,
  ): Promise<AskRace<T>> {
    const settled: Promise<AskRace<T>> = value.then(
      resolved => ({ status: 'answered' as const, value: resolved }),
      error => ({ status: 'rejected' as const, error }));
    const racers: Promise<AskRace<T>>[] = [settled];
    /**
     * ISSUE-413: the host's event stream is the reachable cancellation seam.
     * When it reports an interrupt, the race ends as `interrupted`; the caller
     * settles the ask then and there instead of waiting for the deadline.
     */
    if (interruptSignal !== undefined) {
      racers.push(interruptSignal.then(() => ({ status: 'interrupted' as const })));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      racers.push(closeSignal.then(() => ({ status: 'closed' as const })));
      return Promise.race(racers);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AskRace<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), Math.floor(timeoutMs));
      timer.unref?.();
    });
    racers.push(deadline);
    return Promise.race(racers).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
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
   * exposes the seam and the journal says why it did nothing. A pass refused
   * by the ask lock is named `ask-in-flight` and leaves the depth latch
   * unchanged: it never completes a pass it did not run (ISSUE-412). A pass the
   * durable ledger refuses is named `ask-standdown` for the same reason, before
   * any host call is paid (ISSUE-447).
   */
  async function cremate(sessionId: string): Promise<boolean> {
    // ISSUE-420 / ISSUE-407: no effect after cleanup, named so a journal says
    // the command was refused because dispose had begun.
    if (closing) {
      if (!disposeComplete) {
        journal('cremate', { sessionId: sessionId || null, fired: false, reason: 'closing' });
      }
      return false;
    }
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
    let skipped = false;
    try {
      /**
       * ISSUE-412: an ask already holds the lane, so this manual pass cannot
       * run. It is NOT a completed pass: `askPass` would return `no-table`, and
       * the old `finally` recorded that as a completion, re-arming the depth
       * latch against a pass that never happened. The skip is named and the
       * latch is left exactly where the in-flight ask's own pass put it.
       */
      if (entry.askInFlight) {
        skipped = true;
        journal('cremate', { sessionId, fired: false, reason: 'ask-in-flight' });
        return false;
      }
      // ISSUE-447: a durable session the engine cannot apply a table to gets no
      // paid host call. The standdown line is the command lane's named reason.
      const standdown = await opencodeAskStanddown(entry.ledger, entry.sessionId);
      if (standdown !== null) {
        skipped = true;
        journalAskStanddown(entry, 'command', standdown);
        return false;
      }
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
          ...(entry.preInstallNodes === null
            ? {} : { excludeNodeIds: entry.preInstallNodes }),
        });
      } catch (error) {
        buildThrew = true;
        journal('ask-error', { sessionId, origin: 'command', stage: 'rows',
          message: error instanceof Error ? error.message : String(error) });
      }
      if (batch === null || batch.prompt === null) {
        // ISSUE-486: rows the durable unit claim dropped are a named
        // suppression, not an empty request; `no-rows` stays for a pass that
        // really carried none.
        if (unitClaimSuppressed(batch)) {
          journal('cremate', { sessionId, fired: false, reason: 'claimed-unit',
            claims: batch?.dropped.asked ?? 0 });
        } else {
          journal('cremate', { sessionId, fired: false, reason: 'no-rows' });
        }
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
      // ISSUE-468: a claim or in-flight refusal is named; `no-fire` stays the
      // reason a table pass ran and the model answered without a removal.
      const refused = sent.outcome === 'claimed-revision' || sent.outcome === 'ask-in-flight';
      journal('cremate', { sessionId, fired, reason: fired ? 'table' : refused ? sent.outcome : 'no-fire' });
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
      } else if (!skipped && entry.pruneTrigger.enabled && !buildThrew) {
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
    let standdown: OpencodeAskStanddownReason | null = null;
    try {
      idleSnapshot = entry.port.observe(entry.lastMessages);
      crossed = entry.pruneTrigger.enabled
        ? observeDepth(entry, idleSnapshot, entry.lastPrefix) : true;
      if (crossed) {
        // ISSUE-447: the same durable-health read the step lane makes, before
        // the host is paid. A standdown is named, sends nothing, and leaves the
        // crossing live for a later read.
        standdown = await opencodeAskStanddown(entry.ledger, entry.sessionId);
        if (standdown !== null) {
          journalAskStanddown(entry, 'idle', standdown);
        } else {
          entry.passRound += 1;
          let batch: OpencodeAskBatch | null = null;
          try {
            batch = buildOpencodeAskBatch({
              sessionId, messages: entry.lastMessages, port: entry.port,
              seenNodeIds: entry.seenNodeIds, askedUnitIds: entry.askedUnitIds,
              round: entry.passRound, classes: entry.dedupeClasses,
              appliedPlans: entry.appliedPlans,
              ...(entry.preInstallNodes === null
                ? {} : { excludeNodeIds: entry.preInstallNodes }),
            });
          } catch (error) {
            buildThrew = true;
            journal('ask-error', { sessionId, origin: 'idle', stage: 'rows',
              message: error instanceof Error ? error.message : String(error) });
          }
          if (batch !== null && batch.prompt !== null) {
            sent = await askPass(entry, 'idle', batch);
          } else if (unitClaimSuppressed(batch)) {
            // ISSUE-486: the rows the claim dropped are a named suppression.
            sent = { outcome: 'claimed-unit', answers: new Map() };
          }
          // ISSUE-431: name a crossing that had nothing tableable, distinct from
          // a suppressed ask; a build throw already journals its own ask-error.
          // ISSUE-468: a claim or in-flight refusal is the suppression, by name.
          if (sent === null) {
            if (!buildThrew) {
              journal('prune-outcome', { sessionId, origin: 'idle', outcome: 'no-eligible',
                reason: 'the depth crossing held no tableable unit; no ask was sent and none '
                  + 'was suppressed' });
            }
          } else if (sent.outcome === 'claimed-unit') {
            journal('prune-outcome', { sessionId, origin: 'idle', outcome: sent.outcome,
              claims: batch?.dropped.asked ?? 0,
              reason: 'the depth crossing held a tableable unit, but no row survived the '
                + 'durable unit claim' });
          } else if (sent.outcome === 'claimed-revision' || sent.outcome === 'ask-in-flight') {
            journal('prune-outcome', { sessionId, origin: 'idle', outcome: sent.outcome,
              reason: 'the depth crossing held a tableable unit, but the ask was suppressed '
                + (sent.outcome === 'claimed-revision'
                  ? 'by a durable revision claim'
                  : 'by an ask already in flight for this session') });
          }
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
        } else if (sent === null
          && (entry.seenNodeIds.size === 0 || buildThrew || standdown !== null)) {
          // Nothing eligible, a build throw (ISSUE-359), or a durable-health
          // standdown (ISSUE-447): no pass ran, so the crossing stays live for
          // the next above-bar reading.
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
    // ISSUE-407: refuse once close() has started, with a named reason.
    if (closing) {
      if (!disposeComplete) {
        journal('at-rest', { sessionId, reason: 'closing', status: 'skipped' });
      }
      return;
    }
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
    // ISSUE-407: refuse once close() has started, with a named reason.
    if (closing) {
      if (!disposeComplete) {
        journal('at-rest', { sessionId, reason: 'closing', status: 'skipped' });
      }
      return;
    }
    const entry = sessions.get(sessionId);
    if (entry === undefined || entry.lastMessages === null) return;
    // A nested ask's own idle hook firing is not a second pass: the ask that
    // owns the drain is still in flight (the ISSUE-353 guard family).
    if (entry.askInFlight) return;
    await idleAsk(entry, sessionId);
  }
  async function event(value: OpencodeHostEvent): Promise<void> {
    // ISSUE-420: a delivered event after cleanup has no effect.
    if (closing) return;
    const type = typeof value?.type === 'string' ? value.type : '';
    const data = isRecord(value?.data) ? value.data : {};
    const sessionId = typeof data['sessionID'] === 'string' ? data['sessionID'] : null;
    if (type === 'session.step.ended') {
      if (sessionId !== null) feedStepEnded(sessionId, data);
      return;
    }
    if (sessionId === null) return;
    if (type === 'session.execution.interrupted') {
      /**
       * ISSUE-413: the host names a turn interrupt on its event stream. Resolve
       * every ask waiting on this session so it settles as a typed refusal now,
       * not at the deadline. The host call itself is abandoned like a timeout
       * because `generate` takes no `AbortSignal`.
       */
      const entry = sessions.get(sessionId);
      if (entry !== undefined && entry.askInterrupts.size > 0) {
        const reason = typeof data['reason'] === 'string' ? data['reason'] : 'user';
        for (const interrupt of entry.askInterrupts) interrupt(reason);
        entry.askInterrupts.clear();
      }
      return;
    }
    if (type === 'session.idle') {
      await idlePass(sessionId);
      return;
    }
    if (type === 'session.compaction.started' || type === 'session.compaction.delta'
      || type === 'session.compaction.ended' || type === 'session.compaction.failed') {
      const phase = type.slice('session.compaction.'.length);
      const text = data['text'];
      const entry = sessions.get(sessionId);
      /**
       * ISSUE-423: `started` and `ended` each bump the compaction generation — a
       * reply read after either describes an array the host may have rewritten.
       * `delta`/`failed` do not: a failed or partial compaction leaves the
       * recorded fact alone. The re-arm on `ended` is the shipped backstop
       * (ADR-0050 decision 3 / ISSUE-022 DoD); when an ask or its deferred apply
       * is running it is DEFERRED to that window's end, so a second above-bar
       * ask is never armed from inside the first one's ask/apply.
       */
      if (entry !== undefined && (phase === 'started' || phase === 'ended')) {
        entry.compactionGeneration += 1;
      }
      /**
       * A native compaction rewrote the surface. Re-arm the depth latch as a
       * fresh session (ADR-0050 decision 3 / Issue-022 DoD): the next above-bar
       * reading fires, exactly like a first trigger on a new session. When an
       * ask or its deferred apply is running the re-arm is DEFERRED to that
       * window's end (ISSUE-423) and named on the same line.
       */
      let deferred = false;
      if (phase === 'ended' && entry !== undefined) {
        if (entry.askInFlight || entry.applyInFlight) {
          entry.compactionRearmDeferred = true;
          deferred = true;
          journal('compaction-deferred', { sessionId,
            generation: entry.compactionGeneration,
            window: entry.askInFlight ? 'ask' : 'apply',
            reason: 'a compaction ended while an ask or apply was running; the latch re-arms '
              + 'at that window\'s end, never mid-flight' });
        } else {
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
      journal('compacted', { sessionId, phase,
        ...(entry === undefined ? {} : { generation: entry.compactionGeneration }),
        ...(phase === 'ended' ? { rearmed: !deferred, ...(deferred ? { deferred: true } : {}) } : {}),
        ...(data['reason'] === undefined ? {} : { reason: data['reason'] }),
        ...(data['cost'] === undefined ? {} : { costUsd: costOf(data['cost']) }),
        ...(data['tokens'] === undefined ? {} : { tokens: data['tokens'] }),
        ...(typeof text === 'string' ? { textLength: text.length } : {}),
        ...(data['error'] === undefined ? {} : { error: data['error'] }),
      });
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
    if (closing) return;
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
  /**
   * The disposed answer a tool gives after cleanup (ISSUE-420): a plain tool
   * result, so a stale recall never throws outward and never touches state.
   */
  const disposedToolResult = Object.freeze({
    content: 'cremator: this mount has been disposed; no ledger is open',
  });
  const tool: OpencodeToolDefinition = Object.freeze({
    ...baseTool,
    execute: async (input: unknown, context: Parameters<OpencodeToolDefinition['execute']>[1]) => {
      if (closing) return disposedToolResult;
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
        if (closing) return disposedToolResult;
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

  const mount: OpencodeMount = {
    sessions,
    tool,
    forgetTool,
    transform: (sessionId, messages, context) => track(
      transformStep(sessionId, messages, context), sessionId),
    forget: (sessionId, args) => track(forgetRequest(sessionId, args), sessionId),
    event: value => {
      // ISSUE-420: a delivered event after cleanup has no effect.
      if (closing) return Promise.resolve();
      /**
       * `session.deleted` (ISSUE-379) is handled here, around the tracked
       * event, because the eviction must drain the mount's in-flight work
       * (the ISSUE-356 path) without awaiting its own tracked promise. The
       * payload is the sibling events' own `data: { sessionID }` (verified
       * against the installed @opencode SDK).
       */
      let work: Promise<void> | undefined;
      /**
       * ISSUE-408: the event is tagged with the session its payload names, so a
       * `session.deleted` drains only that session's in-flight work.
       */
      const eventData = isRecord(value?.data) ? value.data : {};
      const eventSessionId = typeof eventData['sessionID'] === 'string'
        ? eventData['sessionID'] : null;
      work = track((async () => {
        await event(value);
        if (value?.type !== 'session.deleted') return;
        const data = isRecord(value.data) ? value.data : {};
        const sessionId = typeof data['sessionID'] === 'string' ? data['sessionID'] : null;
        if (sessionId === null) return;
        await drainSessionInFlight(sessionId, work);
        if (await releaseSession(sessionId)) {
          journal('session-evicted', { sessionId, reason: 'session.deleted' });
        }
      })(), eventSessionId);
      return work;
    },
    afterTool: input => track(afterTool(input),
      typeof input?.sessionID === 'string' ? input.sessionID : null),
    cremate: sessionId => track(cremate(sessionId), sessionId),
    idle: sessionId => track(idleHookAsk(sessionId), sessionId),
    get idleAskOnEvent(): boolean { return idleAskOnEvent; },
    set idleAskOnEvent(value: boolean) { idleAskOnEvent = value; },
    get disposed(): boolean { return closing; },
    close: async () => {
      // Drain in-flight transforms and asks before closing the ledgers
      // (ISSUE-356): a post-dispose ask resolution must not write a closed
      // ledger. Each entry then leaves through the same release the
      // `session.deleted` eviction uses (ISSUE-379). The closing flag refuses
      // new session work for the whole release loop (ISSUE-393): a hook during
      // a ledger-close await neither transforms a closing entry nor re-opens a
      // released one.
      closing = true;
      // ISSUE-425: stop waiting on a deadline-free ask before draining, so
      // teardown terminates even when the host's generate never settles.
      signalClose();
      await drainInFlight();
      for (const sessionId of [...sessions.keys()]) await releaseSession(sessionId);
      // ISSUE-420: cleanup clears the session pointer, so no later callback can
      // name a released session and no post-dispose call can reopen one.
      activeSessionId = null;
      // ISSUE-424: the durable configuration is free again once the mount closes.
      if (registryKey !== null && activeMounts.get(registryKey) === mount) {
        activeMounts.delete(registryKey);
      }
      // ISSUE-407: from here on a post-dispose call writes no journal line
      // (the ISSUE-420 contract); the in-progress refusal lines stop.
      disposeComplete = true;
    },
  };
  if (registryKey !== null) activeMounts.set(registryKey, mount);
  return mount;
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
      // ISSUE-432: the host's model catalog names the window a newly selected
      // model declares, so a mid-session switch can be journalled with it. The
      // operator's configured window is still authoritative and is not replaced.
      const catalog = context.model;
      const resolveModelWindow = merged.resolveModelWindow
        ?? (typeof catalog?.get === 'function'
          ? (ref: OpencodeModelRef): number | null => {
            if (ref.provider === null || ref.model === null) return null;
            const declared = catalog.get(ref.provider, ref.model)?.limit?.context;
            return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
              ? declared : null;
          }
          : undefined);
      // One sink for every line this mount writes, including the two the plugin
      // itself emits when a seam fails to register or its event stream throws.
      const emit = merged.journal
        ?? (merged.journalFile === undefined ? () => {} : createFileJournalSink(merged.journalFile));
      const mount = createOpencodeMount({
        ...merged, journal: emit,
        ...(askGenerate === undefined ? {} : { askGenerate }),
        ...(resolveModelWindow === undefined ? {} : { resolveModelWindow }),
      });
      /**
       * ISSUE-420: setup is one transaction. Every registration below runs
       * inside this try; a throw from a required seam stops the consumer, closes
       * the mount — which makes every already-registered callback inert — and
       * rethrows. The context hook registers after every required seam and
       * before the tolerated idle registration, so a failure in a required step
       * leaves no context hook behind and a host retry registers exactly one.
       */
      let iterator: AsyncIterator<OpencodeHostEvent> | null = null;
      let stopped = false;
      let loop: Promise<void> | null = null;
      const stopLoop = async (): Promise<void> => {
        stopped = true;
        try { await iterator?.return?.(); } catch { /* already closed */ }
        if (loop === null) return;
        // A host iterable that does not answer `return()` may leave `next()`
        // waiting; teardown must still finish and close the ledger.
        await Promise.race([
          loop.catch(() => {}),
          new Promise<void>(resolve => { setTimeout(resolve, 250); }),
        ]);
      };
      try {
        await context.tool.hook('execute.after', async (input) => {
          if (mount.disposed) return;
          await mount.afterTool(input);
        });
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
                  if (mount.disposed) return;
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
        /**
         * ISSUE-411: subscribe and start the consumer BEFORE the idle hook
         * registers and `idleAskOnEvent` flips. A `session.idle` delivered
         * during registration is then consumed by the event path (which still
         * owns the ask) instead of being lost between the two host calls.
         */
        const types = [
          'session.idle',
          'session.deleted',
          'session.step.ended',
          // ISSUE-413: the host's interrupt notice is the ask's cancellation
          // seam (the generate call itself takes no AbortSignal).
          'session.execution.interrupted',
          'session.compaction.started',
          'session.compaction.delta',
          'session.compaction.ended',
          'session.compaction.failed',
        ];
        const source = context.event.subscribe({ types })[Symbol.asyncIterator]();
        iterator = source;
        loop = (async () => {
          try {
            while (!stopped) {
              const next = await source.next();
              if (next.done) break;
              if (mount.disposed) return;
              await mount.event(next.value);
            }
          } catch (error) {
            try {
              emit(Object.freeze({ kind: 'event-error', atMs: Date.now(),
                message: error instanceof Error ? error.message : String(error) }));
            } catch { /* a journal sink must never change an outcome */ }
          }
        })();
        /**
         * The context hook registers after every required step succeeded, so a
         * retried setup after an earlier failure registers exactly one, and an
         * already-registered hook checks `disposed` so cleanup leaves it inert.
         * ISSUE-482: it registers BEFORE the tolerated idle registration below,
         * so a request the host serves while `experimental.idle` is still
         * registering reaches a live mount and the `idleAskOnEvent` window owns
         * a real session, not a mount that never saw a request.
         */
        await context.session.hook('context', async (input: OpencodeSessionContext) => {
          if (mount.disposed) return;
          if (merged.excludeTools !== undefined && input.tools !== undefined) {
            for (const name of merged.excludeTools) delete input.tools[name];
          }
          const requestContext = input.system === undefined
            && input.tools === undefined && input.model === undefined
            ? null
            : {
              ...(input.system === undefined ? {} : { system: input.system }),
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              // ISSUE-432: the model this request is built for, so a
              // provider/model switch mid-session is observable.
              ...(input.model === undefined ? {} : { model: input.model }),
            };
          await mount.transform(input.sessionID, input.messages, requestContext);
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
            if (mount.disposed) return;
            await mount.idle(typeof input?.sessionID === 'string' ? input.sessionID : '');
          });
          mount.idleAskOnEvent = false;
          // ISSUE-411: mark the hook as registered, so a journal can tell a
          // host that accepted it from one that never called it.
          try {
            emit(Object.freeze({ kind: 'idle-hook', atMs: Date.now(),
              registered: true, askPath: 'hook' }));
          } catch { /* a journal sink must never change an outcome */ }
        } catch (error) {
          try {
            emit(Object.freeze({ kind: 'idle-hook-error', atMs: Date.now(),
              reason: 'register-failed',
              message: error instanceof Error ? error.message : String(error) }));
          } catch { /* a journal sink must never change an outcome */ }
        }
      } catch (error) {
        // A required seam failed: stop the consumer, close the mount so every
        // registered callback is inert, then let the host see the failure.
        await stopLoop();
        await mount.close().catch(() => {});
        throw error;
      }
      return async () => {
        await stopLoop();
        await mount.close();
      };
    },
  });
}

/** The default export a package `plugins` entry loads. */
export default createOpencodePlugin();
