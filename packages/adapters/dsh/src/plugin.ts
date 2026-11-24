/**
 * The shipped dsh mount entry: a Cordis plugin that runs the racoons engine
 * inside a live dsh process.
 *
 * Contract (verified against the installed dsh tree, ISSUE-014 §"Verified mount
 * path"):
 *   - a plugin is `apply(ctx, config)` with optional `inject` / `name`;
 *   - `agent/pre-step` is a waterfall `({agent, messages, turn, step, signal},
 *     next)`, and `agent.session` is the live `Session` with public
 *     `append(type, data, {surfaceOp, sourceEventSeqs})`;
 *   - `session/event` listeners must NEVER append synchronously (append
 *     reentrancy throws), so every append happens from `agent/pre-step` or
 *     `agent/turn-stopping`, where the loop is between steps.
 *
 * Nothing here is engine or adapter logic: this file maps host events onto the
 * public seams of `@cremator/core` and `cremator-dsh`. The subpath export keeps
 * the package's default entry free of any host dependency.
 *
 * Storage (ADR-0013, ISSUE-004 chunk 2): the ledger and blobs are durable per
 * session under `crematorStorageRoot`; `':memory:'` is the test-only pair. A
 * host that already owns durable storage may inject `openLedger` instead.
 */
import { randomUUID } from 'node:crypto';
import {
  CharHeuristicTokenMeter, DEFAULT_CONFIG, DEFAULT_FLOOR_BYTES, Meter, RacoonsEngine,
  batchVerdict, createDefaultRules, estimateContent, floorForModel, isTwoVerdictGrammar,
  landedBytesTriggerVerdict,
} from '@cremator/core';
import type {
  AnchorMode, Clock, ContentEstimate, EngineResult, EntryAskGrammar, EntryAskTriggerConfig,
  EntryBatchState, FreshZoneConfig, Ledger, MessageProvenance, ProtocolConfig,
  PrunePlanGrammar, RacoonsConfig, RecallId, RecallRecord, RequestPrefix, Rule,
  SessionSnapshot, Thresholds, ToolResultNode, UnitId, WireRequest, ApplyReceipt, EventId,
  IntentId, PruneWindowTriggerState,
} from '@cremator/core';
import { createDshCapabilities } from './capabilities.js';
import { createDshAdapter } from './adapter.js';
import type { DshAdapter } from './adapter.js';
import { DSH_TOOL_SPECS, createDshTools } from './tools.js';
import type { DshToolHost, DshToolRegistration, DshToolSources } from './tools.js';
import { forgetAnswerText } from './forget-tool.js';
import type { DshForgetScheduled } from './forget-tool.js';
import { classifyDshTool } from './evidence.js';
import type { DshResultFacts, DshPathObservation } from './evidence.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { toCoreEnvelope } from './envelope.js';
import { dshRetentionOf } from './retention.js';
import type { DshRetentionVerdict } from './retention.js';
import { createDshPort } from './port.js';
import type { DshApplicationPort, DshAskExchange } from './port.js';
import type { DshEntryAnswerOutcome } from './adapter.js';
import { askEntryBatch, entryAskTableable } from './entry-ask.js';
import { askEntry } from './entry-ask.js';
import type { EntryAskTurn } from './entry-ask.js';
import type { EntryAnswer } from '@cremator/core';
import { readAssistantUsage, usageRequestId } from './usage.js';
import { revertSessionFromHost } from './mount-revert.js';
import { DEFAULT_ASK_TIMEOUT_MS, MAX_ASK_DEADLINE_MS, messageOf } from './llm-ask.js';
import { JudgeRouteError, judgeRouteOf, normalizeJudgeRoute } from './route.js';
import type { JudgeRoute } from './route.js';
import { captureMainRequest, createMainWireCapture, seedRouteStale } from './main-wire.js';
import type { CapturedMainRequest, MainWireCapture } from './main-wire.js';
import { runRecordOnlyPrune, PRUNE_COMMAND } from './prune.js';
import type { RecordOnlyPruneOutcome } from './prune.js';
import { CREMATE_COMMAND_NAME, createCremateCommand, cremateMarkerOf } from './cremate-command.js';
import type { CrematePassResult, CremateWait, DshCommand, DshCommandRegistry }
  from './cremate-command.js';
import { PRUNE_ROUND_FILE, readEntryAskFired, readPendingAppends,
  readPruneHeaderFacts, readPruneRound, readPruneTriggerState, readTableAskFired,
  writeEntryAskFired, writePendingAppends,
  writePruneRound, writeTableAskFired } from './prune-round-store.js';
import type { DurableAppendRecord } from './prune-round-store.js';
import { MOUNT_STATE_FILE, readDurableReceipts, readInstall, readPendingForgets,
  removeDurableReceipt, writeDurableReceipt, writeInstall,
  writePendingForgets } from './mount-state.js';
import type { DurableForget, DurableInstall } from './mount-state.js';
import { PREINSTALL_RECORD_FILE, markPreinstallReconciled, readPreinstallRecord,
  writePreinstallRecord } from './preinstall-record.js';
import type { DurablePreinstallRecord } from './preinstall-record.js';
import { PruneWindowTrigger, resolveContextWindowTokens,
  resolvePruneThresholdTokens } from './prune-trigger.js';
import { applyPrunePass } from './prune-apply.js';
import {
  STORAGE_OPEN_ATTEMPTS, defaultStorageRoot, normalizeMountRoot, openLedger,
  resolveSessionStorage, resolveStorage,
} from './storage.js';
import type { RacoonsStorageOptions, ResolvedRacoonsStorage } from './storage.js';
import { RacoonsStorageError, RacoonsStorageRetryError } from './storage.js';
import { createRefusingLedger } from './refusing-ledger.js';
import {
  type MountRecordFile, joinMountRecords, readMountRecords, releaseMountRecord,
} from './mount-records.js';

export { resolveStorage } from './storage.js';
export {
  RacoonsStorageError, RacoonsStorageRetryError, STORAGE_OPEN_ATTEMPTS,
  defaultStorageRoot, resolveSessionStorage,
} from './storage.js';
export type {
  RacoonsStorageErrorCode, RacoonsStorageOptions, ResolvedRacoonsStorage,
} from './storage.js';

/** Stable Cordis plugin name. */
export const CREMATOR_PLUGIN_NAME = 'cremator';

/**
 * The title both ask status cards ride (ISSUE-372; ADR-0062 D1). The host's
 * generic command card renders a `command/run` event's `name` as its title,
 * so a custom title needs no host change — only the lifecycle pair below.
 */
const ASK_CARD_NAME = 'Cremating memory trash';

/**
 * Services the plugin needs before dsh applies it.
 *
 * `llm` is the host's own model seam — the one the shipped compaction plugin
 * declares (`dsh-compaction-basic`: `static inject = ["llm", "tokenMeter",
 * "sessions"]`). Both surviving ask moments read it (ADR-0028): the entry
 * checkpoint and the bulk prune. Declaring it here makes that dependency a host
 * fact rather than a later guess. `commands` is the host's slash-command
 * registry, used to register `/cremate` (ADR-0068).
 */
export const CREMATOR_PLUGIN_INJECT: readonly string[] = Object.freeze(['llm', 'sessions', 'commands']);

/**
 * Refused work after `close()` started (ISSUE-416). Once the mount is unloading,
 * a boundary that reaches `sessionFor` must neither reopen a released session
 * nor open a ledger nothing will close. Named so a host or a test can tell this
 * apart from a storage failure and can silence it without hiding a real one.
 */
export class RacoonsClosingError extends Error {
  constructor(sessionId: string) {
    super(`cremator: mount is closing; refusing new work for session ${sessionId}`);
    this.name = 'RacoonsClosingError';
  }
}

/** The enforcement values this mount accepts. Absent means `apply` (ADR-0008). */
export type RacoonsEnforcement = NonNullable<ProtocolConfig['enforcement']>;

/**
 * The entry-ask trigger the mount accepts: core's two cadences plus `off`
 * (ADR-0050 decision 4). `off` is a mount-level product configuration, not an
 * engine cadence, so it is not added to core's `EntryAskTriggerConfig`.
 */
export type RacoonsEntryAskTriggerConfig =
  | EntryAskTriggerConfig
  | { readonly mode: 'off'; readonly bytes?: number };

/**
 * The host-facing flat config a `--patch` row can set. Every value is a
 * threshold or a protocol knob, never engine state.
 */
export interface RacoonsPluginConfig {
  /**
   * Accepted and ignored. ADR-0014 (2026-10-23) scrapped the entry-time cap:
   * these two keys stay in the host-facing type so an old config file never
   * crashes a mount, and no value of theirs is read or wired anywhere.
   */
  readonly capBytes?: number;
  /** Accepted and ignored; see `capBytes` (ADR-0014, 2026-10-23). */
  readonly capHeadBytes?: number | null;
  readonly episodeNoNewPathSteps?: number | null;
  readonly sealMaxLatencyTurns?: 0 | 1;
  readonly barBytes?: number;
  /**
   * The size floor in bytes (ADR-0020 Decision 3; ISSUE-058 item 2). A tool
   * result under it lands whole and is never asked about. Absent means the
   * per-model table decides (`floorForModel`; authority:
   * `docs/research/floor-calibration-2026-10-26.md` §6), which is why this is
   * not a defaulted clone of `barBytes`: the table needs the model id, and only
   * the adapter sees it. It is never the bulk-pass bar.
   */
  readonly floorBytes?: number;
  /**
   * How many eligible results one entry ask covers (ISSUE-117 chunk B3;
   * ADR-0035 §3). `1` is the count path's default: when `entryAskTrigger`
   * explicitly selects `count`, every eligible result is asked the moment it
   * lands, exactly as before; the product default is `off`, so a mount that
   * names neither sends no entry ask. Above `1` a count-cadence mount holds
   * eligible results and sends ONE index-keyed ask when the count of new
   * eligible results since the last ask reaches this value; a partial batch at
   * session end is carried and never flushed, so its units keep. The arm values
   * 3, 6 and 12 live in a launch row, never here.
   */
  readonly entryAskBatchSize?: number;
  /**
   * The superseded-by-reread dedupe class (ADR-0037 decision 6;
   * ISSUE-145). Absent or `false` — the shipped state — plans exactly the prune
   * the mount planned before the pass existed. `true` lets the pass remove an
   * earlier read of a path when a later read covered the whole file and no write
   * to that path sits between the two reads; the removal rides the pass's one
   * checkpoint-revert. It maps onto core's
   * `protocol.dedupe.classes.supersededByReread`.
   */
  readonly dedupeSupersededByReread?: boolean;
  /**
   * The call-echo dedupe class (ADR-0037 decision 2, class 1; ISSUE-151).
   * Absent or `false` — the shipped state — plans nothing. `true` lets the pass
   * remove a tool result whose payload is an EXACT restatement of the argument
   * payload its own call declared and adds no state of its own; a result that
   * carries unique previous state is refused, never edited, and the whole
   * result is the only removal shape. It maps onto core's
   * `protocol.dedupe.classes.callEcho`.
   */
  readonly dedupeCallEcho?: boolean;
  /**
   * What fires the batched entry ask (ISSUE-128; ADR-0050 decision 4). Absent
   * is `off`: the product configuration sends no entry ask. An explicit `count`
   * is the retired per-result cadence, kept as a compatibility path;
   * `entryAskBatchSize` governs it and the ask stream is today's, byte for
   * byte. `landed-bytes` sums the eligible results' own byte lengths as they
   * land and fires the whole pending stream when the sum reaches `bytes`, which
   * is then required. A crossing over an empty pending stream cannot happen:
   * only a landing grows the sum, and every landing is pending.
   *
   * `{mode: "off"}` journals every result the entry gate accepts as
   * `entry-ask-off` with reason `configured-off`, and sends no entry ask. The
   * entry seam stays for manual or compatibility use.
   */
  readonly entryAskTrigger?: RacoonsEntryAskTriggerConfig;
  /**
   * The answer grammar the batched entry ask states (ISSUE-129; ISSUE-183; the
   * live run's configuration). Absent is `jsonl-20`, the shipped default (owner
   * ruling 2026-11-05): one JSON object per row per line, so a malformed line
   * refuses that row only. `3option`, the original contract, byte for byte, and
   * `two-option` stay selectable by name; `two-option` asks `{"keepall":true}` or
   * `{"forgetall":"…"}` per row, with no line-level option — a row that names
   * lines is refused and keeps. `jsonl-20-nokeepall` is core's `jsonl-20`
   * variant without `keepall`: `forgetall` or `keeplines` per row, a whole row
   * as a full-range `keeplines` with summary `None`.
   */
  readonly entryAskGrammar?: EntryAskGrammar;
  /**
   * The bulk prune ask's answer grammar (ISSUE-221; the live run's
   * configuration). Absent is `nokeepall`, the shipped default (ADR-0056).
   * `3option`, the original contract byte for byte, stays selectable by name.
   * `nokeepall` offers only `forgetall` and `keeplines`: each row carries its
   * `[L line(s)]` count, a whole unit is kept as a full-range `keeplines` with
   * summary `None`, and a literal `keepall` is refused `action-not-in-grammar`
   * and keeps. The 3option bytes are unchanged.
   */
  readonly pruneAskGrammar?: PrunePlanGrammar;
  readonly minCutFreedBytes?: number;
  /**
   * Accepted and ignored (ADR-0028). The anchor arm belonged to the removed
   * judge pass: the entry checkpoint's ask renders its anchors unconditionally,
   * so no config value selects an arm. The key stays in the host-facing type so
   * an old config row still mounts.
   */
  readonly anchors?: AnchorMode;
  /**
   * Enforcement mode. Absent means `apply`: ADR-0008's owner ruling, the same
   * default `DEFAULT_CONFIG` carries; `record-only` is the explicit opt-out.
   * What a mount can actually apply stays structural — a session with no
   * revert seam records the answers with `unsupported-capability` and plans
   * nothing, so a config value is never a capability claim.
   */
  readonly enforcement?: RacoonsEnforcement;
  /** The `source.kind` an appended negative fact carries. */
  readonly recordName?: string;
  /** The ask stream's deadline in ms; `0` disables it. Default 120 s. */
  readonly judgeTimeoutMs?: number;
  /**
   * The durable storage root (ADR-0013). Session N's ledger lands at
   * `<crematorStorageRoot>/sessions/N/ledger.sqlite` with its blobs beside it.
   * Must be absolute. Absent means `defaultStorageRoot()`:
   * `<DSH_HOME>/storages/cremator`, `DSH_HOME` defaulting to `~/.dsh`.
   */
  readonly crematorStorageRoot?: string;
  /**
   * The context window in tokens, when the host knows it. It is the fallback
   * denominator the auto prune is measured against when no explicit
   * `pruneThresholdTokens` is configured: the pass fires when the session's
   * estimated request tokens reach half of it (owner ruling 2026-10-24,
   * ADR-0009 §Amendment). That window-only path is deprecated by ADR-0050
   * decision 2 and stays only for old launch rows. The estimate is the WHOLE
   * request — the fixed system+tools prefix of main's captured request plus the
   * live transcript (ADR-0009 §Amendment 2026-10-24). Absent means no
   * window-derived bar; with no explicit threshold either, the feature is OFF
   * and the mount stays record-only, which is the rollout's first stage
   * (ADR-0008).
   *
   * Provisional default per owner ruling 2026-10-24: `null`. The owner decides
   * the shipped value; the trigger rule itself is ruled, only the number is not.
   */
  readonly contextWindowTokens?: number | null;
  /**
   * The absolute token bar for the table pass (ADR-0050 decision 1–2). An
   * explicit value wins over `contextWindowTokens`: the pass fires when the
   * session's reading reaches this number, whatever the host window is. The
   * product's test value is 60,000. Absent falls back to half the window, the
   * deprecated compatibility path; with no window either, the feature is off.
   * A bar still requires `contextWindowTokens`, because the apply leg plans
   * against the host window; a bar without a window is refused at mount.
   */
  readonly pruneThresholdTokens?: number;
  /**
   * The native-compaction backstop (ISSUE-022 DoD; wired per CRITIC-022 P1-1,
   * 2026-10-24). When on, a host `compaction/end` re-arms the prune latch
   * exactly as a completed pass does: the host rewrote the surface, so the old
   * growth baseline no longer describes the session and the next crossing is
   * pruned instead of waiting out a delta the compaction invalidated. When off,
   * native compaction is observed and ignored. The shipped default is ON (owner
   * ruling 2026-10-24): the host's own compaction stays armed as a backstop, and
   * racoons fires earlier than the host's own trigger would. `false` is the
   * explicit opt-out.
   */
  readonly nativeCompactionBackstop?: boolean;
}

/**
 * The resolved entry-ask trigger (ISSUE-128; ADR-0050 decision 4). An absent
 * trigger resolves to `off`, the product configuration: the entry lane journals
 * each eligible result and sends no ask. `count` is the retired per-result
 * cadence, selected by name as a compatibility path. `landed-bytes` always
 * carries its threshold, because a validated landed-bytes trigger without one
 * cannot exist.
 */
export type ResolvedEntryAskTrigger =
  | { readonly mode: 'count'; readonly bytes?: number }
  | { readonly mode: 'landed-bytes'; readonly bytes: number }
  | { readonly mode: 'off' };

/** `RacoonsPluginConfig` after defaults and validation. */
export interface ResolvedRacoonsConfig {
  readonly episodeNoNewPathSteps: number | null;
  readonly sealMaxLatencyTurns: 0 | 1;
  readonly barBytes: number;
  readonly minCutFreedBytes: number;
  readonly enforcement: RacoonsEnforcement;
  readonly recordName: string;
  /** Accepted and ignored (ADR-0028); see `RacoonsPluginConfig['anchors']`. */
  readonly anchors: AnchorMode;
  readonly judgeTimeoutMs: number;
  readonly crematorStorageRoot: string;
  /**
   * The half-window trigger's denominator; null means no window-derived bar
   * (ADR-0009 §Amendment; provisional default per owner ruling 2026-10-24). It
   * is only the deprecated fallback once `pruneThresholdTokens` is set.
   */
  readonly contextWindowTokens: number | null;
  /**
   * The absolute prune bar (ADR-0050 decision 2); null falls back to half the
   * window. Resolved through the trigger's own validator, so the config and the
   * latch cannot disagree about what a bar is.
   */
  readonly pruneThresholdTokens: number | null;
  /**
   * True when a host compaction re-arms the prune latch (ISSUE-022 DoD;
   * CRITIC-022 P1-1). Shipped `true` per owner ruling 2026-10-24: the host's
   * backstop stays armed and racoons fires earlier than the host's own trigger.
   */
  readonly nativeCompactionBackstop: boolean;
  /**
   * The flat floor knob, before the per-session resolution; null means "let the
   * per-model table decide" (ADR-0020 Decision 3). The model id lives on the
   * host route, so `resolvePluginConfig` cannot finish this value — the mount
   * does, once it can see the route (`RacoonsSessionEntry.floorBytes`).
   */
  readonly floorBytes: number | null;
  /**
   * The entry ask's batch size (ISSUE-117 chunk B3; ADR-0035 §3). Resolved to a
   * positive integer; absent is `1`, today's one-ask-per-result cadence. The
   * mount reads it from here so a session's ask loop needs no second lookup.
   */
  readonly entryAskBatchSize: number;
  /**
   * The superseded-by-reread dedupe switch (ADR-0037; ISSUE-145), resolved to
   * the one boolean the pass reads. Absent is `false`, the shipped state: the
   * mount plans the prune it always planned. The mount reads it here and, through
   * `engineConfig`, offers the same value as core's
   * `protocol.dedupe.classes.supersededByReread`.
   */
  readonly dedupeSupersededByReread: boolean;
  /**
   * The call-echo dedupe switch (ADR-0037 decision 2, class 1; ISSUE-151),
   * resolved to the one boolean the pass reads. Absent is `false`, the shipped
   * state. The mount reads it here and, through `engineConfig`, offers the
   * same value as core's `protocol.dedupe.classes.callEcho`.
   */
  readonly dedupeCallEcho: boolean;
  /**
   * What fires the batched entry ask (ISSUE-128; ADR-0050 decision 4). Absent
   * resolves to `off`, the product configuration that sends no entry ask;
   * `count` is the explicit compatibility path where `entryAskBatchSize`
   * decides; `landed-bytes` carries its validated threshold. Resolved here so
   * the ask loop needs no second lookup and no second validation.
   */
  readonly entryAskTrigger: ResolvedEntryAskTrigger;
  /**
   * The batched entry ask's answer grammar (ISSUE-129; ISSUE-183; ISSUE-221).
   * Resolved to one of the four core can render and read; absent is `jsonl-20`,
   * the shipped default.
   */
  readonly entryAskGrammar: EntryAskGrammar;
  /**
   * The bulk prune ask's answer grammar (ISSUE-221; ADR-0056). Resolved to
   * `nokeepall` when absent, the shipped default; `3option`, the original
   * contract byte for byte, stays selectable by name.
   */
  readonly pruneAskGrammar: PrunePlanGrammar;
}

/**
 * The journal vocabulary is a closed list in `./journal-kinds.ts` (CRITIC-022
 * P3 #14), re-exported here because this module is where a host-looking reader
 * finds it. A typo in a `journal('...')` call is a compile error.
 */
export { CREMATOR_JOURNAL_KINDS } from './journal-kinds.js';
export type { RacoonsJournalKind } from './journal-kinds.js';
import type { MountJournal, RacoonsJournalKind } from './journal-kinds.js';

/** One journal record. The host selects where it goes; this file never writes. */
export interface RacoonsJournalRecord {
  readonly kind: RacoonsJournalKind;
  readonly atMs: number;
  readonly [field: string]: unknown;
}

export type RacoonsJournalSink = (record: RacoonsJournalRecord) => void;

/** A host-owned ledger, so a caller can inspect or reopen it. */
export type RacoonsLedgerFactory = (sessionId: string) => Promise<Ledger>;

export interface RacoonsPluginOptions {
  /** Defaults a patch row may override. */
  readonly config?: RacoonsPluginConfig;
  /**
   * The storage target. Absent means the durable per-session plan under
   * `config.crematorStorageRoot` (ADR-0013); `{ databasePath: ':memory:' }` is
   * the test-only in-memory pair. Only a storage ROOT (or `':memory:'`) is
   * accepted: an explicit durable `{databasePath, blobRoot}` pair is refused
   * with `explicit-storage-paths`, because one shared file would contradict
   * ADR-0013's per-session rule (ISSUE-004 critic fix P2#3).
   */
  readonly storage?: RacoonsStorageOptions;
  /** A host that owns durable storage supplies the ledger, and wins. */
  readonly openLedger?: RacoonsLedgerFactory;
  readonly journal?: RacoonsJournalSink;
  /** The additive host tool registry, when the caller already resolved it. */
  readonly tools?: DshToolHost;
  readonly nowMs?: () => number;
  /**
   * A fixed host route, when the caller knows the provider/model pair. Absent,
   * the mount reads the live session's own request header and refuses with
   * `not-configured` when neither names a route. Both surviving asks read it
   * (ADR-0028): the entry checkpoint and the bulk prune.
   */
  readonly judgeRoute?: JudgeRoute;
}

/** The structural slice of a dsh session this mount reads. */
export interface DshMountSession {
  readonly id: string;
  readonly seq?: number;
  readonly surface?: { readonly nodes?: readonly number[];
    readonly replaceGeneration?: number;
    readonly contentGeneration?: number };
  eventAt?(seq: number): DshMountEvent | undefined;
  append(type: string, data: unknown, options?: Record<string, unknown>): DshMountEvent;
  /**
   * The host's last request header: `config` (provider/model and the call
   * scalars) plus the assembled tool schemas of the last request built under it
   * (`dsh-session`'s `EpochHeader`, `lib/types/types.d.ts`, read back through
   * `Session.requestHeader()`, `lib/types/index.d.ts`). The mount routes an ask
   * onto this header's model and, when no main request has been observed yet,
   * takes the seed's tool list from it (ISSUE-606). Absent on a fake or an old
   * host: the mount then refuses the ask rather than inventing a route.
   */
  requestHeader?(): {
    readonly config?: { readonly provider?: string; readonly model?: string };
    readonly tools?: readonly unknown[];
  } | undefined;
  /**
   * The host's own creation metadata. `cwd` is the session's workspace root,
   * which dsh validates absolute; it is the boundary the recall source lane may
   * read inside (ISSUE-053; PRD §6.7). Absent means this mount can name no root
   * and supplies no reader, so a ledger miss stays `not-found`.
   */
  header?: { readonly cwd?: string };
}

export interface DshMountEvent {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

/** A request's fixed prefix: the system slot and the tool list it carries. */
interface SeedPrefix {
  readonly system: string;
  readonly tools: readonly unknown[];
}

/** The structural slice of the Cordis context this mount uses. */
export interface DshMountContext {
  // `never[]` keeps every listener shape assignable without importing cordis.
  on(event: string, listener: (...args: never[]) => unknown,
    options?: { readonly prepend?: boolean }): unknown;
  effect?(register: () => (() => unknown) | void, label?: string): unknown;
  logger?: { warn?(message: string): void };
  sessions?: { list?(): readonly DshMountSession[] };
  /**
   * The host's model seam, declared through `CREMATOR_PLUGIN_INJECT`'s `llm`.
   * The structural slice below is what the shipped compaction plugin drives
   * (`ctx.llm.stream(options)` → an async iterable of chunks); ISSUE-024
   * chunk 2 is the first caller. Typed here, never imported: this package
   * carries no dsh dependency.
   */
  llm?: DshLlmService;
  /**
   * The host's slash-command registry, declared through
   * `CREMATOR_PLUGIN_INJECT`'s `commands` (ADR-0068). Absent on a stub host:
   * the plugin mounts without registering `/cremate`, and the typed message
   * still works.
   */
  commands?: DshCommandRegistry;
  tools?: DshToolHost;
  get?(name: string): unknown;
}

/** The one model call an ask needs: stream a request, read its text deltas. */
export interface DshLlmService {
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
  /**
   * The host's exact-route metadata (ADR-0071). Native compaction reads the
   * same seam for capacity. Optional: a stub host or an older dsh may not
   * expose it, and the mount then keeps the configured window or leaves the
   * automatic latch off rather than guessing.
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<DshLlmModelInfo>;
}

/** The host model-info answer this mount reads; extra fields are ignored. */
export interface DshLlmModelInfo {
  readonly context?: { readonly contextWindow?: number };
  readonly defaultMaxTokens?: number;
}

/** The request fields the host's `GenerateOptions` requires; extras pass through. */
export interface DshLlmStreamOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly [field: string]: unknown;
}

/**
 * The chunk shapes an ask reads. Only `text-delta` carries answer text; the
 * rest are the host's own framing, kept so a caller can see why a stream ended.
 */
export type DshLlmChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'finish'; readonly reason: string; readonly [field: string]: unknown }
  | { readonly type: string; readonly [field: string]: unknown };

/** The call facts a `tool/call` carries; a `tool/result` does not repeat them. */
interface CallFacts {
  readonly name?: unknown;
  readonly arguments?: unknown;
}

interface Capture {
  readonly eventId: string;
  readonly item: DshToolResultItem;
  readonly seq: number;
}

/** The application request the port hands back for publication. */
export interface RacoonsApplicationRequest {
  readonly intent: { readonly intentId: string };
  readonly application: {
    readonly eventId: string;
    readonly mode: string;
    readonly replacements: readonly {
      readonly source: { readonly nodeId: string; readonly byteLength: number };
      readonly bytes: Uint8Array;
      readonly generatedRanges: readonly unknown[];
      readonly retainedCopies: readonly unknown[];
      readonly evidenceRecallId: string | null;
    }[];
    readonly appendRecords: readonly {
      readonly recordId: string; readonly bytes: Uint8Array;
    }[];
    readonly archives: readonly {
      readonly ruleId: string;
      readonly removalId: string;
      readonly operationKind: string;
      readonly title: string;
      readonly recall: {
        readonly id: string;
        readonly parts: readonly {
          readonly source: {
            readonly sha256?: string;
            readonly nodeId?: string;
            readonly byteLength?: number;
          };
          readonly removedRanges: readonly {
            readonly range: { readonly startByte: number; readonly endByteExclusive: number };
          }[];
        }[];
      };
    }[];
    readonly sealedEpisodeIds: readonly string[];
    readonly applicationSha256: string;
  };
}

export interface RacoonsSessionEntry {
  readonly sessionId: string;
  readonly engine: RacoonsEngine;
  readonly adapter: DshAdapter;
  readonly port: DshApplicationPort;
  readonly ledger: Ledger;
  readonly ownedLedger: boolean;
  readonly publications: unknown[];
  /**
   * The live host session this entry opened with. It is informational for
   * callers; the revert seam was derived from the same object, so a mount that
   * opened without a host never claims the capability (ISSUE-010).
   */
  host: DshMountSession | null;
  /**
   * How many prune passes this session has run (ISSUE-022 chunks 5–6). It is
   * the pass's round ordinal, so two passes never share a stamp, and it lives
   * on the entry rather than the engine: a pass mints no engine event of its
   * own. Chunk 6 persists it beside the session's ledger: a remount reads it
   * back, so a resumed dsh process continues the count instead of starting at
   * round 1 again (`./prune-round-store.ts`).
   */
  pruneRounds: number;
  /**
   * The prune crossing latch (ISSUE-022 chunk 6; ADR-0050 decision 2). One
   * instance per session: usage that crosses the configured bar schedules one
   * pass, and the latch re-arms when a pass ends or a compaction lands. The bar
   * is the explicit `pruneThresholdTokens` when set; the half-window fallback
   * is the deprecated compatibility path. Disabled (never fires) when neither
   * an explicit bar nor a window is configured.
   */
  readonly pruneTrigger: PruneWindowTrigger;
  /**
   * The context window in force for this session (ADR-0071). Starts at the
   * configured value; with none it is null until a boundary resolves the
   * routed model's capacity from the host's model-info seam. The apply leg
   * reads THIS, not the mount option, so a pass cannot plan against a number
   * different from the one that armed it.
   */
  windowTokens: number | null;
  /** The provider/model `windowTokens` was resolved from; null when unresolved or configured. */
  windowProvider: string | null;
  windowModel: string | null;
  /** Route keys whose window lookup already wrote its one unresolved line (ADR-0071). */
  readonly windowUnresolved: Set<string>;
  /**
   * The local estimate of the request the last pre-step was about to send, and
   * the port revision that estimate describes (G8, ISSUE-045 D1). Held here
   * because a host usage row arrives in the synchronous `session/event` callback,
   * where no snapshot can be awaited. It is the estimate a row is reconciled
   * against (`estimateErrorTokens`), NOT the prune bar's reading — since
   * ISSUE-092 the trigger reads `billedPromptTokens` and this is its pre-first-
   * usage fallback. Null before the first pre-step; a row arriving before it is
   * journaled missing, never reconciled against an invented estimate.
   */
  requestEstimate: { readonly revision: string; readonly inputTokens: number } | null;
  /**
   * The host's own billed prompt for the last request it accounted, in tokens
   * (ISSUE-092): `input + cacheRead + cacheWrite` from the same usage row
   * `usage-reconciled` journals. The prune trigger reads THIS — not the
   * local estimate — because the estimate counts message text only, omits
   * tool-call arguments and runs at ~0.56 of the host meter on live runs. Null
   * until the first usage row arrives.
   */
  billedPromptTokens: number | null;
  /**
   * Usage request ids already journaled for this session. One host event is one
   * request, so a row seen twice must not read as two calls; the engine's own
   * dedup suppresses only its telemetry, not this mount's line.
   */
  readonly usageSeen: Set<string>;
  /**
   * Manual forgets the `forget` tool resolved and this session has yet to
   * apply (PRD §6.2; ISSUE-045 chunk D2). A tool call cannot apply its own
   * removal — its assistant message is still unanswered on the surface, and
   * every rebuild from the forgotten node re-emits that call unanswered
   * (`tool-pair-imbalance`) — so the mount drains this queue at its next legal
   * boundary, where every other removal applies. One entry per request; a
   * request that was refused never reaches here.
   */
  readonly pendingForgets: DshForgetScheduled[];
  /**
   * The size floor this session resolved, in bytes (ADR-0020 Decision 3;
   * ISSUE-058 item 2). The flat knob wins; otherwise the route's model id picks
   * the table entry (`floorForModel`), and no route means the default 512. It
   * is re-derived at every boundary from the live host route (ISSUE-432), so a
   * mid-session model switch does not leave the old model's floor in force.
   */
  floorBytes: number;
  /**
   * The provider/model the current `floorBytes` was derived from (ISSUE-432).
   * `null` means the floor is model-independent (an explicit `floorBytes`) or
   * no route was available. The pair makes a stale floor detectable instead of
   * silent; a change journals `model-refresh`.
   */
  floorProvider: string | null;
  floorModel: string | null;
  /**
   * Results whose entry answer SETTLED (ISSUE-058 chunk P3c-2; ADR-0025
   * §Decision 3–§5). In memory only, keyed by the capture's own result node id:
   * no ledger row and no marker on bytes, because a de-duplication ledger would
   * be a second source of truth about content the product deliberately never
   * keeps. Since the judge pass's removal (ADR-0028) it is the mount's own
   * "asked exactly once" record: it stops the ASK loop from putting the same
   * capture to the agent twice. A refused or absent answer settles nothing and
   * is not recorded here (ADR-0025 §5).
   */
  readonly entryJudged: Set<string>;
  /**
   * The subset of `entryJudged` whose entry answer was `keepall` AND applied
   * (ISSUE-073): the results a result checkpoint settled as kept content. The
   * bulk prune withholds their units from its ask, because a settled keep is
   * final and re-listing it would ask the agent to decide it twice. Only an
   * APPLIED keepall lands here: a refusal, a fail-open write and an absent
   * answer settle nothing, so their unit stays listable. Keyed the same way as
   * `entryJudged` (the capture's own result node id).
   */
  readonly entryKept: Set<string>;
  /**
   * The carried partial batch of the entry ask (ISSUE-117 chunk B3; ADR-0035
   * §1–§3, §6). In-memory session state: `pending` holds the result ids a batch
   * of size > 1 has accumulated and not yet asked, in arrival order, and it
   * dies with the session — a resumed session starts a fresh batch. At the
   * shipped default (`1`) every verdict fires at once and this stays empty.
   */
  entryBatch: EntryBatchState;
  /**
   * The landed-bytes accumulator (ISSUE-128): the sum of the pending results'
   * own byte lengths since the last fire, moved only by `landed-bytes` mode.
   * Monotone within a batch — no prune, no apply and no host rewrite lowers it —
   * and only a fire resets it. It stays `0` in count mode, which never feeds it,
   * so the count path reads and writes the same value it always did.
   */
  entryLandedBytes: number;
  /**
   * Whether this session has already put its FIRST entry ask to the model
   * (ISSUE-194). Held on the entry, never in a global: a mount with two
   * sessions keeps two answers. The ask of either shape moves it — a one-row
   * batch and a multi-row batch both count — and it is set once a request has
   * actually left, so the first fire states the `jsonl-20` 70 percent share line
   * and every later fire states 40 percent. A resume starts a fresh process, so the
   * resumed session's next ask is a later trigger's prompt only if this mount
   * has already asked; a fresh mount asks as a first trigger again, exactly as
   * it does for the batch carry.
   */
  entryAskFired: boolean;
  /**
   * Whether this session's depth table has already left a table ask
   * (ISSUE-508). The session's first table ask states the 70 percent keep
   * share; every later one states 40 percent. The flag moves only when a table
   * request actually left the seam and came back answered or refused after the
   * send — never on a refused append, a refused-before-send or a throw. It is
   * persisted beside the round and the entry flag, so a restart's first table
   * ask states the later share.
   */
  tableAskFired: boolean;
  /**
   * The held results a later batch fire must Ask about, keyed by the capture's
   * event id: the capture, its landing node and the unit minted then
   * (ISSUE-117 chunk B3). The fire does NOT ask from this node: it re-reads each
   * row from the live transcript and uses these as the comparison baseline, so
   * a row changed in between is dropped rather than described stale (ISSUE-188).
   * An id is removed from this map when the batch that carries it fires; a
   * session that ends on a partial batch leaves its rows here and asks nothing
   * more, so their units keep (ADR-0035 §6).
   */
  readonly entryBatchUnit: Map<string, {
    readonly capture: Capture; readonly node: ToolResultNode; readonly unitId: UnitId }>;
  /**
   * Whether this entry still owes its cold-boundary recovery (ISSUE-341). Set
   * at creation and cleared by the first boundary that runs it: a resumed
   * process rebuilds the checkpoint state the previous one lost — the orphaned
   * ask exchange, the settled marks and the buffered landings.
   */
  resumeRecovery: boolean;
  /**
   * The install generation this mount recorded or resumed (ISSUE-414): 1 on a
   * fresh install, one more on each later mount of the same durable state, and
   * null when the session has no durable target. It is a label for the journal,
   * never a gate; the gate is whether durable state already existed.
   */
  readonly installGeneration: number | null;
  /**
   * Which install boundary this mount is (ISSUE-422): `fresh` is state written
   * for an empty surface, `inherited` is a first mount into a session that
   * already held history (a fork/clone the host did not announce, or a fresh
   * install into history — the two shapes are indistinguishable from inside the
   * adapter), `fork` is durable state naming a different session (the host
   * copied a parent's state to a child id), `restart` is this session's own
   * state, and `none` is an in-memory session with no durable identity.
   */
  readonly installBoundary: 'fresh' | 'inherited' | 'fork' | 'restart' | 'none';
  /**
   * Retries the durable install-identity write that failed at mount (ISSUE-439).
   * The mount never journals a boundary the file does not hold; the next
   * boundary retries the same identity and journals the deferred line once it
   * lands. Null when the identity is durable (or the session is in memory).
   */
  retryInstallIdentity: (() => void) | null;
  /**
   * Bumped once per host compaction observation (ISSUE-423). An ask stamps the
   * generation it was built under; if a compaction lands before its apply, the
   * answer describes an array the host rewrote and the apply refuses by name.
   */
  compactionGeneration: number;
  /**
   * The ask/apply windows open right now, counted per lane (ISSUE-423,
   * ISSUE-501): `entryWindows` while an entry ask and its applies run,
   * `pruneWindows` while a bulk pass runs. A direct prune can overlap an
   * in-flight entry ask, so the lanes are counted apart: one lane's end never
   * closes the other's window. A compaction observed while either is non-zero
   * does not re-arm the depth latch mid-flight; it is deferred until both
   * reach zero.
   */
  entryWindows: number;
  pruneWindows: number;
  /** True when a compaction landed inside an open window and owes its re-arm. */
  compactionRearmDeferred: boolean;
  /**
   * Append applications the port committed but whose records the host may not
   * hold yet (ISSUE-342). The port's publish callback queues each committed
   * append here; a boundary flushes the queue to the surface and drops a request
   * only once `publishAppend` succeeds. A mid-list throw leaves the request
   * queued, so the next boundary retries it (idempotent by record id) instead of
   * letting `syncPass` silently drop records the host never received while the
   * ledger claims applied.
   */
  readonly pendingAppends: RacoonsApplicationRequest[];
  /**
   * Persist the queue's current intent to the session's durable store
   * (ISSUE-374). Present only when the session has a durable target; the
   * publish callback calls it at commit and `flushAppends` calls it once the
   * queue drains, so a death between the two leaves a replayable record and a
   * completed flush leaves none. Fail-open: a failed write journals and the
   * in-memory queue still flushes this process.
   */
  readonly persistPendingAppends?: () => void;
  takePublication(): RacoonsApplicationRequest | null;
}

export interface StepOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly deliveries: EngineResult[];
  readonly atRest: EngineResult | null;
  readonly appendRequest: RacoonsApplicationRequest | null;
}

export interface TurnEndOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly atRest: EngineResult | null;
  readonly appendRequest: RacoonsApplicationRequest | null;
}

/**
 * One in-flight `session/end` release and the entry it owns (ISSUE-452): the
 * entry is what decides coalescing, so a reopened life's end starts its own
 * release instead of joining the old one. The registry holds a set of these per
 * id (ISSUE-473), so two ends that do not coalesce are both registered and both
 * drained; the promise is filled in once the release work exists.
 */
interface SessionEnding {
  readonly entry: RacoonsSessionEntry | undefined;
  promise: Promise<void>;
}

export interface RacoonsMount {
  readonly sessions: Map<string, RacoonsSessionEntry>;
  readonly counters: { entries: number; preSteps: number; publications: number; captured: number };
  /**
   * Every session id this mount still holds state for, across every per-session
   * map `close()` releases (ISSUE-433; ISSUE-474). Read-only inspection for a
   * shutdown that must leave no map holding a dead id. Lifecycle reading only —
   * no cap, no timeout (ADR-0060).
   */
  observedSessionIds(): readonly string[];
  sessionFor(sessionId: string, host?: DshMountSession): Promise<RacoonsSessionEntry>;
  syncTranscript(entry: RacoonsSessionEntry, session: DshMountSession,
    options?: TranscriptSyncOptions): ReturnType<typeof surfaceTranscript>;
  observe(session: DshMountSession, event: DshMountEvent): DshToolResultItem | null;
  /**
   * Record one manual prune request for a session; the next `agent/pre-step`
   * runs it. The typed `/cremate` message lands here; the registered host
   * command uses {@link beginCremate} instead, because its pass must run in the
   * turn that claims its marker message (ISSUE-535).
   */
  requestPrune(sessionId: string, seq?: number): void;
  /**
   * Register the `/cremate` command's pass request for one marker message
   * (ISSUE-535) and return the card's one-shot waiter. The request runs only at
   * the `agent/pre-step` that claims `messageId`, inside that open turn; its
   * waiter settles with that pass's outcome, or by name if the host cancels the
   * request before the pass runs. `null` means another request or pass already
   * holds this session, so the command reports busy and opens no turn
   * (ISSUE-545).
   */
  beginCremate(sessionId: string, messageId: string,
    commandId: string | undefined): CremateWait | null;
  /** Bind a command request to the host turn that claimed its marker. */
  claimCremate(sessionId: string, messageId: string, turn: number): void;
  /** Drop one command request by name; its waiter reports the failure. */
  cancelCremate(sessionId: string, messageId: string, message: string): void;
  /**
   * Fail every command request this session still holds (agent disposal,
   * session eviction, mount close). Lifecycle failure only — no cap, no LRU,
   * no timeout (standing rule 7 / ADR-0060).
   */
  abandonCremateWaits(sessionId: string, message: string): void;
  /** Record one request the host's `llm/stream` waterfall dispatched as main's
   * last sent request for its session (ISSUE-026 chunk 3). A request this
   * package sent itself is ignored, so an ask never becomes a seed.
   */
  observeWire(options: unknown): void;
  /**
   * One step boundary. `cremateMessageId` names the command marker the host
   * claimed for this step; the pass runs only inside such a step (ISSUE-535).
   */
  runStep(session: DshMountSession, ordinals: { turn: number; step: number },
    signal?: AbortSignal, cremateMessageId?: string): Promise<StepOutcome>;
  runTurnEnd(session: DshMountSession, turn: number): Promise<TurnEndOutcome>;
  /**
   * Run one prune pass now (ISSUE-022 chunk 5). A test or a rig may call it
   * directly; a step reaches the same pass through `runPrunePass`. With no
   * window configured nothing is applied; the pass's appends are the surface
   * writes the engine decides and the log-only ask card (ISSUE-372).
   */
  runPrune(session: DshMountSession, signal?: AbortSignal): Promise<RecordOnlyPruneOutcome | null>;
  /**
   * Run one `forget`/`recall` tool call's work as a tracked per-session boundary
   * (ISSUE-435), so `endSession`/`close()` await it before closing the ledger.
   * A call that starts once `close()` began is refused with
   * `RacoonsClosingError`. No cap or timeout (standing rule 7 / ADR-0060).
   */
  runToolWork<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
  /**
   * Emit one line through the mount's swallowing journal wrapper (ISSUE-430).
   * The shipped plugin writes its `mounted` line through this seam, so a
   * throwing sink can never reject the plugin apply; every other mount line
   * already rides the same wrapper.
   */
  emitJournal(kind: RacoonsJournalKind, fields: Record<string, unknown>): void;
  /**
   * The session-end drain+release (ISSUE-377): flush the committed-but-
   * unpublished appends through the ISSUE-342 path, then release the entry
   * through the same per-entry path `close()` uses. `observe` starts it at a
   * `session/end` surface event; a caller may await it to settle the eviction
   * (a second call for the same open entry coalesces with the in-flight one;
   * a reopened life's end starts its own release — ISSUE-452). Idempotent: an
   * already-released or never-opened session releases nothing. Lifecycle
   * eviction only — no cap, no LRU, no timeout (standing rule 7 / ADR-0060).
   */
  endSession(session: DshMountSession): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptSyncOptions {
  readonly beforeSeq?: number;
  readonly completedThroughTurnOrdinal?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The entry-ask trigger as the ask loop reads it (ISSUE-128; ADR-0050 decision
 * 4): absent is `off`, the product configuration, and a declared trigger is
 * completed or refused here. A landed-bytes trigger without a positive
 * threshold would never fire and never say why, so it is refused by name rather
 * than resolved to a silent no-op. `count` needs no number: it selects the
 * retired per-result cadence as a compatibility path.
 */
function resolveEntryAskTrigger(
  raw: RacoonsEntryAskTriggerConfig | undefined,
): ResolvedEntryAskTrigger {
  if (raw === undefined) return { mode: 'off' };
  // A plain `isRecord(raw)` narrows a union to the member that happens to be a
  // type literal, hiding `mode`; the typeof check states the same refusal while
  // keeping the union readable.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('cremator: entryAskTrigger must be an object');
  }
  const mode = raw.mode;
  if (mode !== 'count' && mode !== 'landed-bytes' && mode !== 'off') {
    throw new Error('cremator: entryAskTrigger.mode must be "count", "landed-bytes" or "off"');
  }
  const bytes = raw.bytes;
  if (bytes !== undefined && (!isCount(bytes) || bytes < 1)) {
    throw new Error('cremator: entryAskTrigger.bytes must be a positive safe integer');
  }
  if (mode === 'landed-bytes') {
    if (bytes === undefined) {
      throw new Error('cremator: entryAskTrigger.bytes is required in landed-bytes mode');
    }
    return { mode, bytes };
  }
  if (mode === 'off') return { mode };
  // A count-mode row may carry the number harmlessly; nothing reads it there.
  return bytes === undefined ? { mode } : { mode, bytes };
}

/**
 * The outcome an answer which threw would have reported: nothing planned,
 * nothing applied. Frozen and shared, because it is a statement about absence
 * and never a value a caller may mutate into a claim.
 */
const UNCHANGED_ENGINE_RESULT: EngineResult = Object.freeze({
  status: 'unchanged', validation: null, intentId: null, receipt: null, invalidation: null,
});

/**
 * The bound on an `entry-ask-refused` row's `raw`: a refusal journals the
 * answer text only as a prefix, so a pathological reply cannot bloat the
 * evidence file. Sliced by character, never by byte.
 */
const ENTRY_ASK_REFUSED_RAW_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when the signal exists and is aborted; a helper keeps TS from over-narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * The host's monotonic surface counters, snapshotted when an ask is built
 * (ISSUE-548). `replaceGeneration` counts positional replacements and
 * `contentGeneration` also counts plugin-owned message changes; either moving
 * means the array an answer describes is no longer the one that would apply.
 */
interface SurfaceStamp {
  readonly replaceGeneration: number;
  readonly contentGeneration: number;
}

/** The counters a host exposes, or null on a fake/older host that exposes none. */
function surfaceStampOf(session: DshMountSession): SurfaceStamp | null {
  const surface = session.surface;
  const replaceGeneration = surface?.replaceGeneration;
  const contentGeneration = surface?.contentGeneration;
  if (typeof replaceGeneration !== 'number' || !Number.isSafeInteger(replaceGeneration)
      || typeof contentGeneration !== 'number' || !Number.isSafeInteger(contentGeneration)) {
    return null;
  }
  return { replaceGeneration, contentGeneration };
}

/** True when the surface moved since `stamp`; a vanished counter counts as moved. */
function surfaceAdvanced(session: DshMountSession, stamp: SurfaceStamp): boolean {
  const now = surfaceStampOf(session);
  return now === null
    || now.replaceGeneration !== stamp.replaceGeneration
    || now.contentGeneration !== stamp.contentGeneration;
}

/**
 * Whether two depth-latch states are the same fact (ISSUE-475). A fork clears
 * the inherited latch only while the file still holds the value it captured at
 * mount; a child that re-armed it keeps its own state.
 */
function sameTriggerState(a: PruneWindowTriggerState | null,
  b: PruneWindowTriggerState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lastFireUsage === b.lastFireUsage
    && a.belowSinceFire === b.belowSinceFire
    && a.baselinePending === b.baselinePending;
}

/** Validate the flat knobs and fill the engine's defaults. */
export function resolvePluginConfig(raw: RacoonsPluginConfig | undefined,
  capabilities: { readonly hostModelInfo?: boolean } = {}): ResolvedRacoonsConfig {
  const config: RacoonsPluginConfig = isRecord(raw) ? raw : {};
  // ADR-0014 (2026-10-23): `capBytes` / `capHeadBytes` are accepted and ignored.
  // They are deliberately not read here: an old config file still mounts, and
  // no value of theirs can reach the engine.
  const episodeNoNewPathSteps = config.episodeNoNewPathSteps === undefined
    ? null : config.episodeNoNewPathSteps;
  const sealMaxLatencyTurns = config.sealMaxLatencyTurns ?? 1;
  // Owner ruling 2026-11-08 (ADR-0051): the eligibility floor is 512 bytes.
  const barBytes = config.barBytes ?? 512;
  // ADR-0020 Decision 3: absent (null) defers to the per-model table, resolved
  // where the route is visible. An explicit value wins for every model.
  const floorBytes = config.floorBytes ?? null;
  // ADR-0035 §3: `1` (absent) is the count path's cadence. A declared value is
  // a positive safe integer — zero would never fire an ask, so it refuses by
  // name below. The product default trigger is `off`, so this knob only acts
  // when a row explicitly selects `{mode: "count"}`.
  const entryAskBatchSize = config.entryAskBatchSize ?? 1;
  // ADR-0037 decision 6: both dedupe classes ship OFF. Only a declared boolean
  // is a value; anything else refuses by name rather than silently planning
  // nothing.
  const dedupeSupersededByReread = config.dedupeSupersededByReread ?? false;
  const dedupeCallEcho = config.dedupeCallEcho ?? false;
  // ISSUE-128; ADR-0050 decision 4: absent is `off` — the product configuration,
  // unchanged from the campaign's explicit row. An explicit `count` keeps the
  // retired per-result cadence as a compatibility path. The declared trigger is
  // validated and completed here so the ask loop reads one value.
  const entryAskTrigger = resolveEntryAskTrigger(config.entryAskTrigger);
  // ISSUE-129: absent is the shipped default (owner ruling 2026-11-05 makes it
  // `jsonl-20`). A declared value must be one the ask can render and read; a typo
  // is refused by name, never a silent default.
  const entryAskGrammar = config.entryAskGrammar ?? 'jsonl-20';
  // ISSUE-221; ADR-0056: absent is `nokeepall`, the shipped default, matching
  // core. `3option` stays selectable by name. A declared value must be one the
  // table loop can render and read; a typo is refused by name, never a silent
  // default.
  const pruneAskGrammar = config.pruneAskGrammar ?? 'nokeepall';
  const minCutFreedBytes = config.minCutFreedBytes ?? 4096;
  // ADR-0008: absent means `apply` (owner ruling 2026-10-23 — the same default
  // `DEFAULT_CONFIG` carries); `record-only` is the explicit opt-out. The mount
  // no longer pins the opt-out. That pin was a config statement about a
  // capability, and the mount now has the capability whenever a host session
  // supplies the revert seam. A mount without one still applies nothing: the
  // engine reads the structural flag and records the answers with
  // `unsupported-capability` (`packages/core/src/engine/engine.ts`,
  // `settleVerdicts`), so this default can never manufacture a removal.
  const enforcement = config.enforcement ?? 'apply';
  const recordName = config.recordName ?? 'racoons/negation';
  // ADR-0028: accepted and ignored — no ask reads an anchor arm any more.
  const anchors = config.anchors ?? 'off';
  const judgeTimeoutMs = config.judgeTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const crematorStorageRoot = config.crematorStorageRoot ?? defaultStorageRoot();
  // Provisional default per owner ruling 2026-10-24: no window. With no
  // explicit bar either, there is no auto pass. The trigger rule is ruled
  // (ADR-0050 decision 2; the half-window fallback stays deprecated); the
  // shipped numbers are the owner's. The coercion is the trigger's own
  // validator, so the config and the latch cannot disagree about what a window
  // is (CRITIC-022 P3 #16).
  const contextWindowTokens = resolveContextWindowTokens(config.contextWindowTokens);
  // ADR-0050 decision 2: the product bar is absolute and wins over the window.
  // The window alone stays as the deprecated compatibility path; the same
  // validator arms both, so no config value can reach the latch unvalidated.
  const pruneThresholdTokens = resolvePruneThresholdTokens(config.pruneThresholdTokens);
  // The apply leg still plans against the host window (`applyPrunePass` refuses
  // `no-window`), so a bar needs either a configured window or a host that can
  // answer the routed model's capacity (ADR-0071). Refuse a row that has
  // neither here, before a pass can fire and never apply.
  if (pruneThresholdTokens !== null && contextWindowTokens === null
      && capabilities.hostModelInfo !== true) {
    throw new Error('cremator: pruneThresholdTokens requires contextWindowTokens '
      + 'or a host llm.resolveModelInfo seam (the apply leg plans against the host window)');
  }
  // Owner ruling 2026-10-24: the backstop ships ON. The host's native compaction
  // stays armed, and racoons must fire earlier than the host's own trigger would
  // (the ruling applies to any harness, not only dsh); `false` is the opt-out.
  const nativeCompactionBackstop = config.nativeCompactionBackstop ?? true;
  if (episodeNoNewPathSteps !== null && !isCount(episodeNoNewPathSteps)) {
    throw new Error('cremator: episodeNoNewPathSteps must be null or a non-negative safe integer');
  }
  if (sealMaxLatencyTurns !== 0 && sealMaxLatencyTurns !== 1) {
    throw new Error('cremator: sealMaxLatencyTurns must be 0 or 1');
  }
  if (!isCount(barBytes) || barBytes < 1) {
    throw new Error('cremator: barBytes must be a positive safe integer');
  }
  if (floorBytes !== null && (!isCount(floorBytes) || floorBytes < 1)) {
    throw new Error('cremator: floorBytes must be a positive safe integer');
  }
  if (!isCount(entryAskBatchSize) || entryAskBatchSize < 1) {
    throw new Error('cremator: entryAskBatchSize must be a positive safe integer');
  }
  if (entryAskGrammar !== '3option' && entryAskGrammar !== 'two-option'
    && entryAskGrammar !== 'jsonl-20' && entryAskGrammar !== 'jsonl-20-nokeepall') {
    throw new Error('cremator: entryAskGrammar must be "3option", "two-option", '
      + '"jsonl-20" or "jsonl-20-nokeepall"');
  }
  if (pruneAskGrammar !== '3option' && !isTwoVerdictGrammar(pruneAskGrammar)) {
    throw new Error('cremator: pruneAskGrammar must be "3option", "nokeepall" or '
      + '"jsonl-20-nokeepall"');
  }
  if (!isCount(minCutFreedBytes)) {
    throw new Error('cremator: minCutFreedBytes must be a non-negative safe integer');
  }
  if (enforcement !== 'record-only' && enforcement !== 'apply') {
    throw new Error('cremator: enforcement must be "record-only" or "apply"');
  }
  if (typeof recordName !== 'string' || recordName.trim() === '') {
    throw new Error('cremator: recordName must be a non-empty string');
  }
  if (anchors !== 'off' && anchors !== 'on') {
    throw new Error('cremator: anchors must be "off" or "on"');
  }
  if (!isCount(judgeTimeoutMs)) {
    throw new Error('cremator: judgeTimeoutMs must be a non-negative safe integer');
  }
  if (judgeTimeoutMs > MAX_ASK_DEADLINE_MS) {
    // ISSUE-425: the platform clamps a delay beyond 2^31-1 ms to 1 ms, so a
    // huge but valid config would abort almost immediately. Refuse by name.
    throw new Error('cremator: judgeTimeoutMs must not exceed the platform timer range '
      + `(${String(MAX_ASK_DEADLINE_MS)} ms); a larger delay would fire at 1 ms`);
  }
  if (typeof crematorStorageRoot !== 'string' || crematorStorageRoot.trim() === '') {
    throw new Error('cremator: crematorStorageRoot must be a non-empty path');
  }
  if (typeof nativeCompactionBackstop !== 'boolean') {
    throw new Error('cremator: nativeCompactionBackstop must be a boolean');
  }
  if (typeof dedupeSupersededByReread !== 'boolean') {
    throw new Error('cremator: dedupeSupersededByReread must be a boolean');
  }
  if (typeof dedupeCallEcho !== 'boolean') {
    throw new Error('cremator: dedupeCallEcho must be a boolean');
  }
  return Object.freeze({
    episodeNoNewPathSteps, sealMaxLatencyTurns, barBytes,
    minCutFreedBytes, enforcement, recordName,
    anchors, judgeTimeoutMs, crematorStorageRoot, contextWindowTokens,
    pruneThresholdTokens, nativeCompactionBackstop,
    floorBytes, entryAskBatchSize, dedupeSupersededByReread, dedupeCallEcho,
    entryAskTrigger, entryAskGrammar, pruneAskGrammar,
  });
}

/**
 * The mount config keys this entry accepts at runtime (ISSUE-131).
 *
 * Derived from the resolver's own output, so a key `resolvePluginConfig` starts
 * reading appears here without a second edit. A host that reaches the entry
 * through a wrapper (the dsh rig does) diffs its pass-through list against this
 * surface instead of re-deriving it; a key added here but not forwarded then
 * fails loudly instead of silently reverting to its default at the mount.
 *
 * `capBytes` / `capHeadBytes` are named here because ADR-0014 made them
 * accepted-and-ignored: the resolver deliberately never reads them, so the
 * resolved object cannot carry them.
 */
export function racoonsPluginConfigKeys(): readonly string[] {
  return Object.freeze([...Object.keys(resolvePluginConfig({})), 'capBytes', 'capHeadBytes']);
}

/**
 * The engine config this mount builds from the flat knobs.
 *
 * `floorBytes` is passed in because it is resolved per session, where the route
 * (and so the model id) is visible; an absent value falls back to the flat knob
 * and then to the model-less default, so the engine config always carries one
 * number (ADR-0020 Decision 3).
 */
export function engineConfig(config: ResolvedRacoonsConfig, floorBytes?: number): RacoonsConfig {
  const thresholds: Thresholds = {
    // ADR-0014 (2026-10-23): the entry-time cap is scrapped. The core's
    // Thresholds type still carries both fields for old config files, so the
    // mount states the core defaults and never wires a caller's value in.
    capBytes: DEFAULT_CONFIG.thresholds.capBytes,
    capHeadBytes: DEFAULT_CONFIG.thresholds.capHeadBytes,
    episodeNoNewPathSteps: config.episodeNoNewPathSteps,
    sealMaxLatencyTurns: config.sealMaxLatencyTurns,
  };
  const freshZone: FreshZoneConfig = { maxNodes: null, maxBytes: null };
  const protocol: ProtocolConfig = {
    // CHUNK-2 deletes these three from core's `ProtocolConfig`; until then the
    // core defaults supply them and no caller value reaches the engine. The
    // judge pass and the turn gate they tuned are gone (ADR-0028), so this
    // mount neither resolves nor validates them.
    ...DEFAULT_CONFIG.protocol,
    barBytes: config.barBytes,
    minCutFreedBytes: config.minCutFreedBytes,
    enforcement: config.enforcement,
    // ADR-0037 decision 6: the dedupe classes, spelled as core's config names
    // them. Class 2 and class 1's exact-echo subset ship, and only when the row
    // turned them on.
    dedupe: { classes: {
      supersededByReread: config.dedupeSupersededByReread,
      callEcho: config.dedupeCallEcho,
    } },
  };
  return { thresholds, freshZone, sealMode: 'append',
    validationFailureLimit: 2, protocol,
    floorBytes: floorBytes ?? config.floorBytes ?? DEFAULT_FLOOR_BYTES,
    entryAskBatchSize: config.entryAskBatchSize,
    entryAskGrammar: config.entryAskGrammar,
    pruneAskGrammar: config.pruneAskGrammar,
    // ISSUE-128: the cadence the mount's ask loop applies, carried on the engine
    // config so one resolved value states it. `off` (ADR-0050 decision 4) is the
    // default and a mount-level switch, not an engine cadence: core never reads
    // an entry-ask trigger, and its validator knows only the two cadences, so
    // `off` is omitted rather than passed through as an invalid-plan.
    ...(config.entryAskTrigger.mode === 'off'
      ? {} : { entryAskTrigger: config.entryAskTrigger }) };
}

/** Rendered text of one host message's content blocks. */
function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => isRecord(block) && block['type'] === 'text'
    && typeof block['text'] === 'string').map((block) => block['text'] as string).join('');
}

/** Parse the tool arguments the host recorded. */
function inputOf(argumentsText: unknown): Readonly<Record<string, unknown>> {
  if (typeof argumentsText !== 'string' || argumentsText === '') return {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The call id on a tool result, from either host spelling. */
function callIdOf(event: DshMountEvent): string | null {
  const data = isRecord(event.data) ? event.data : {};
  const message = isRecord(data['message']) ? data['message'] : {};
  const source = isRecord(message['source']) ? message['source'] : {};
  if (typeof source['callId'] === 'string') return source['callId'];
  return typeof message['toolCallId'] === 'string' ? message['toolCallId'] : null;
}

/**
 * The provenance one message payload declares, or `null` when it declares none
 * (ADR-0037 decision 5; ISSUE-149).
 *
 * Read from `source.kind` and nothing else. The host's own field is the only
 * input: no role, no wording and no shape is consulted, so a message with no
 * `source.kind` stays undeclared rather than being guessed from its role. A
 * non-string kind is not a declaration either — the host typed it as opaque data,
 * and a number or an object there is a shape this seam does not interpret.
 *
 * `familyId` is deliberately not mapped. No dsh `source` in the three local
 * session stores declares a family, group, task or parent id (scanned 2026-11-02:
 * the identifiers the host does write are `senderSessionId`, `compactionId`,
 * `callId` and `recordId`). Substituting `senderSessionId` would be an inference
 * about what "family" means, so the field stays absent until a host declares one.
 */
function provenanceOf(message: Readonly<Record<string, unknown>>): MessageProvenance | null {
  const source = isRecord(message['source']) ? message['source'] : {};
  const kind = source['kind'];
  return typeof kind === 'string' && kind.length > 0 ? { sourceKind: kind } : null;
}

/**
 * The pair the host put in the tool call, when it names one. `read` names
 * `file_path`; `grep`/`glob` name `pattern` (plus an optional `path` scope).
 */
export function targetFromInput(
  toolName: string, input: Readonly<Record<string, unknown>>,
): { readonly key: string; readonly label: string } | null {
  const pick = (value: unknown): string | null =>
    (typeof value === 'string' && value.length > 0 ? value : null);
  const kind = toolName.toLowerCase();
  if (kind === 'grep' || kind === 'rg' || kind === 'search' || kind === 'glob') {
    const pattern = pick(input['pattern']);
    return pattern === null ? null : { key: pattern, label: pattern };
  }
  const path = pick(input['file_path']) ?? pick(input['filePath']) ?? pick(input['path']);
  return path === null ? null : { key: path, label: path };
}

/**
 * The lines a read result's own meta says the call returned, or `null` when the
 * meta proves none. dsh reports them as `meta.lines` (one `{number, text}` entry
 * per returned line) with `meta.offset` as the 1-based number of the first —
 * the shape every live read record this workspace holds agrees on. Only the
 * count travels: `PathEvidence` states a span's length, never its origin
 * (ISSUE-051), and the unit's own span comes from the rendered body's bytes.
 */
function readCoveredLines(meta: Readonly<Record<string, unknown>>): number | null {
  const lines = meta['lines'];
  if (!Array.isArray(lines) || lines.length === 0) return null;
  // `offset` is where the span starts; a meta without a 1-based origin does not
  // say which lines these are, so it proves no span here.
  if (!isCount(meta['offset']) || meta['offset'] < 1) return null;
  return lines.length;
}

/**
 * Turn the host's structured `meta` into the `DshResultFacts` the adapter's
 * evidence derivation reads.
 *
 * Only the host's own projections are treated as proof:
 *   - a `read` result names the path it returned and the lines it returned
 *     (`meta.lines`, 1-based from `meta.offset`): that covered span proves the
 *     call returned the path's content (ISSUE-051). The call's own spelling and
 *     the resolved `meta.path` are both recorded, so a request spelled either
 *     way resolves;
 *   - a `matches`-shaped result with `truncated:false` and `total === 0` proves a
 *     miss;
 *   - a `matches`-shaped result with matches proves a hit, per file;
 *   - a `paths`-shaped result (glob) does the same for discovered paths.
 * Every other shape stays `complete:false` with no counted paths, so it can
 * never become a negative fact.
 */
export function resultFactsFromMeta(
  toolName: string, input: Readonly<Record<string, unknown>>, meta: unknown,
): DshResultFacts {
  const scope = typeof input['path'] === 'string' && input['path'].length > 0 ? input['path'] : null;
  const fallback = scope ?? (isRecord(meta) && typeof meta['path'] === 'string' ? meta['path'] : null) ?? '.';
  const observed = (): DshPathObservation[] => {
    const path = targetFromInput(toolName, input);
    // No count: an observation that proves nothing. `DeriveToolEvidence` reads a
    // missing count and an explicit null the same way.
    return path === null ? [] : [{ path: path.key }];
  };
  if (!isRecord(meta)) return { complete: false, failed: false, paths: observed() };
  if (classifyDshTool(toolName) === 'read') {
    // The host's own truncation report (ADR-0037 decision 2, class 2): a read it
    // cut short is never a whole-file read, so the fact travels with the span
    // rather than being inferred from how many lines came back.
    const truncated = meta['truncated'] === true;
    const covered = readCoveredLines(meta);
    if (covered !== null) {
      const named = targetFromInput(toolName, input);
      const resolved = typeof meta['path'] === 'string' && meta['path'].length > 0 ? meta['path'] : null;
      const key = named?.key ?? resolved;
      if (key !== null) {
        return { complete: false, failed: false, truncated, paths: [{
          path: key, pathKey: key, lineCount: covered,
          ...(resolved !== null && resolved !== key ? { displayPath: resolved } : {}) }] };
      }
    }
    // A read whose meta proves no span stays count-free: `unknown`, never a miss.
    return { complete: false, failed: false, truncated, paths: observed() };
  }
  const files = meta['files'];
  const paths = meta['paths'];
  if (meta['shape'] === 'matches' && Array.isArray(files) && meta['truncated'] === false
    && isCount(meta['total'])) {
    if (meta['total'] === 0) {
      return { complete: true, failed: false,
        paths: [{ path: fallback, pathKey: fallback, matchCount: 0 }] };
    }
    const hits = files.flatMap((file) => (isRecord(file) && typeof file['path'] === 'string'
      && file['path'].length > 0
      // A file entry without a `matches` array carries no count: omit it, so the
      // observation stays `unknown` instead of proving zero (ISSUE-571).
      ? [{ path: file['path'], pathKey: file['path'],
        ...(Array.isArray(file['matches']) ? { matchCount: file['matches'].length } : {}) }] : []));
    return { complete: true, failed: false, paths: hits.length > 0 ? hits
      : [{ path: fallback, pathKey: fallback, matchCount: meta['total'] }] };
  }
  if (meta['shape'] === 'paths' && Array.isArray(paths) && meta['truncated'] === false
    && isCount(meta['total'])) {
    if (meta['total'] === 0) {
      return { complete: true, failed: false,
        paths: [{ path: fallback, pathKey: fallback, matchCount: 0 }] };
    }
    const discovered = paths.flatMap((path) => (typeof path === 'string' && path.length > 0
      ? [{ path, pathKey: path, matchCount: 1 }] : []));
    return { complete: true, failed: false, paths: discovered.length > 0 ? discovered
      : [{ path: fallback, pathKey: fallback, matchCount: meta['total'] }] };
  }
  return { complete: false, failed: false, paths: observed() };
}

/** Deterministic per-(session, kind, seq) ids, so a replayed event never doubles an intent. */
export function eventIdFor(sessionId: string, kind: string, seq: number | string): string {
  return `dsh:${sessionId}:${kind}:${String(seq)}`;
}

/**
 * A tool result's transcript identity: one live result per call id in dsh, so
 * the call id survives a content replacement that re-appends the node.
 */
export function resultNodeId(sessionId: string, callId: string): string {
  return `dsh:${sessionId}:result:${callId}`;
}

/** The one current surface seq for a call id, or null when none is live. */
export function currentResultSeq(session: DshMountSession, callId: string): number | null {
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  for (const seq of [...nodes].reverse()) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    if (callIdOf(event) === callId) return seq;
  }
  return null;
}

/**
 * Map one captured `tool/result` host event to the adapter's item shape.
 *
 * The body is the concatenation of the rendered `text` blocks — the same bytes
 * the model reads. `evidence` stays absent so the adapter's own
 * `deriveToolEvidence` derives it from `toolName` + `input` + `result`.
 *
 * A failed result carries `failed: true` and is never `complete`: a failure
 * proves nothing about the search space, so it can never become a negative fact
 * (S7's evidence half; the cap half is enforced in `observe`).
 */
export function toolResultItem(params: {
  eventId: string;
  event: DshMountEvent;
  call: CallFacts | null;
  turnOrdinal: number;
  stepOrdinal: number;
}): DshToolResultItem | null {
  const data = isRecord(params.event.data) ? params.event.data : {};
  const message = isRecord(data['message']) ? data['message'] : {};
  const callId = callIdOf(params.event);
  if (callId === null) return null;
  const failed = message['isError'] === true;
  const toolName = typeof params.call?.name === 'string' ? params.call.name : '';
  const input = inputOf(params.call?.arguments);
  const facts = resultFactsFromMeta(toolName, input, data['meta']);
  // The call's own declared argument payload, verbatim when the host stated it
  // as text (ADR-0037 decision 2, class 1; ISSUE-151). No re-render from
  // `input`: a parse that fell back to `{}` is not a declaration.
  const callArguments = argumentText(params.call?.arguments);
  return {
    id: params.eventId,
    role: 'tool',
    callId,
    ...(callArguments === null ? {} : { callArguments }),
    toolName,
    input,
    target: targetFromInput(toolName, input),
    result: failed ? { ...facts, failed: true, complete: false } : facts,
    bytes: new TextEncoder().encode(textOf(message['content'])),
    turnOrdinal: params.turnOrdinal,
    stepOrdinal: params.stepOrdinal,
    hostData: { meta: data['meta'] ?? null, isError: failed, seq: params.event.seq },
  };
}

/**
 * The call's declared argument text, or null when the host stated none. A
 * string is carried byte-for-byte; a structured value is serialised once, and
 * a value JSON cannot encode is not a declaration.
 */
function argumentText(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

/**
 * The ordinal a surface node's own content states, when it states one.
 *
 * A `tool/result` (and every other message type the host stamps) carries the
 * `turn` and `step` it belongs to. That pair is the node's identity; the seq it
 * currently occupies is a log position and moves when the host replaces it
 * (ISSUE-064). A pair the fold never saw as a `step/start` yields null, and the
 * caller falls back to the log position's ordinal.
 */
function ownOrdinal(event: DshMountEvent,
  stepAt: ReadonlyMap<string, number>): { turn: number; step: number } | null {
  const data = isRecord(event.data) ? event.data : {};
  if (!isCount(data['turn']) || !isCount(data['step'])) return null;
  const step = stepAt.get(`${String(data['turn'])}:${String(data['step'])}`);
  return step === undefined ? null : { turn: data['turn'], step };
}

/**
 * The ordinal of the surface position a replace took over, for a node that
 * states no `(turn, step)` of its own. A replace re-publishes content at a later
 * seq, so the seq's own log ordinal would stamp it with the publishing step and
 * the walk would go backwards; the position it replaced is the ordinal it keeps
 * (ISSUE-064).
 */
function inheritedOrdinal(event: DshMountEvent,
  ordinalAt: ReadonlyMap<number, { turn: number; step: number }>): { turn: number; step: number } | null {
  const op = event.surfaceOp;
  if (!isRecord(op)) return null;
  const startSeq = op['startSeq'];
  return isCount(startSeq) ? ordinalAt.get(startSeq) ?? null : null;
}

/**
 * Walk a session's log once and return, for every surface position, the host
 * transcript item the port should hold.
 *
 * Three host facts shape this projection:
 *   - dsh numbers `step` per turn (it restarts at 1 each turn) while the core's
 *     snapshot wants one monotone step ordinal across the transcript, so each
 *     distinct (turn, step) pair gets the next global ordinal.
 *   - a turn is complete only at its `turn/end`, so `completedThroughTurnOrdinal`
 *     is the last `turn/end`'s turn, never "current turn minus one".
 *   - a surface REPLACE re-publishes a node's content at a later log seq while
 *     the node keeps the position it occupies (ISSUE-064). An ordinal is a
 *     property of the content, so a node carrying its own (turn, step) pair
 *     takes that pair's global ordinal, and a node carrying none takes the
 *     ordinal of the position it replaced; the log position is only the
 *     fallback for a node with neither. Stamping the arrival seq instead
 *     makes the walk decrease (`1:28` then `1:5`) and the guard latches
 *     `adjacency-changed`.
 *
 * `beforeSeq` cuts the surface at one seq, exclusive. The dsh port grows by
 * appending the result it is handed, so the snapshot it plans against must be
 * the surface prefix that precedes that result — not the surface minus it.
 */
export function surfaceTranscript(session: DshMountSession, options: {
  beforeSeq?: number;
  sessionId?: string;
  calls?: ReadonlyMap<string, CallFacts>;
} = {}): {
  items: DshTranscriptItem[];
  seqs: number[];
  currentTurnOrdinal: number;
  currentStepOrdinal: number;
  completedThroughTurnOrdinal: number;
} {
  const beforeSeq = options.beforeSeq ?? Number.POSITIVE_INFINITY;
  const sessionId = options.sessionId ?? session.id;
  const length = typeof session.seq === 'number' ? session.seq : 0;
  const ordinalAt = new Map<number, { turn: number; step: number }>();
  // The fold's own one-pair-one-ordinal table, so a node that names its own
  // (turn, step) is stamped from its CONTENT and never from the seq the host
  // published it at (ISSUE-064: a replace lands at a later seq).
  const stepAt = new Map<string, number>();
  // The `tool/call` facts the log itself states, by call id. A `tool/result`
  // never repeats its call's name or arguments, so a fold that read only the
  // result would carry no target and no evidence (ISSUE-053). The mount's own
  // `observe` map wins where it has an entry: it is the same host event, read
  // once, and a caller that drove `observe` should see what it captured.
  const loggedCalls = new Map<string, CallFacts>();
  let turn = 0;
  let globalStep = 0;
  let completedThrough = -1;
  let lastKey: string | null = null;
  for (let seq = 0; seq < length; seq += 1) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && isCount(data['turn'])) turn = data['turn'];
    if (event.type === 'step/start' && isCount(data['step'])) {
      const key = `${String(turn)}:${String(data['step'])}`;
      if (key !== lastKey) { globalStep += 1; lastKey = key; }
      stepAt.set(key, globalStep);
    }
    if (event.type === 'turn/end' && isCount(data['turn'])) {
      completedThrough = Math.max(completedThrough, data['turn']);
    }
    if (event.type === 'tool/call' && typeof data['callId'] === 'string') {
      loggedCalls.set(data['callId'], { name: data['name'], arguments: data['arguments'] });
    }
    // The log position's ordinal is the fallback, never the rule: a replace's
    // own pair (or the position it took over) decides what it is stamped with,
    // and the resolved map makes a chain of replaces inherit transitively.
    ordinalAt.set(seq, ownOrdinal(event, stepAt) ?? inheritedOrdinal(event, ordinalAt)
      ?? { turn, step: globalStep });
  }
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const items: DshTranscriptItem[] = [];
  const seqs: number[] = [];
  for (const seq of nodes) {
    if (seq >= beforeSeq) break;
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const at = ordinalAt.get(seq) ?? { turn, step: globalStep };
    if (event.type === 'tool/result') {
      const callId = callIdOf(event);
      if (callId === null) continue;
      const item = toolResultItem({ eventId: resultNodeId(sessionId, callId), event,
        call: options.calls?.get(callId) ?? loggedCalls.get(callId) ?? null,
        turnOrdinal: at.turn, stepOrdinal: at.step });
      if (item === null) continue;
      items.push(item);
      seqs.push(seq);
      continue;
    }
    const role = event.type === 'user/message' ? 'user'
      : event.type === 'system/message' ? 'system'
        : event.type === 'developer/message' ? 'developer'
          : event.type === 'assistant/message' ? 'assistant' : null;
    if (role === null) continue;
    const data = isRecord(event.data) ? event.data : {};
    const message = role === 'user' ? data
      : isRecord(data['message']) ? data['message'] : {};
    const content = message['content'];
    const toolCallIds = Array.isArray(content)
      ? content.filter((block) => isRecord(block) && block['type'] === 'tool-call'
        && typeof block['id'] === 'string').map((block) => block['id'] as string) : [];
    // The host's declared source kind is carried, not discarded (ADR-0037
    // decision 5; ISSUE-149). A message that declares none keeps the key absent:
    // "the host said nothing" and "the host declared user" are different facts,
    // and core refuses to read the second into the first.
    const provenance = provenanceOf(message);
    items.push({ id: `dsh:${sessionId}:message:${String(seq)}`, role,
      bytes: new TextEncoder().encode(textOf(content)),
      turnOrdinal: at.turn, stepOrdinal: at.step,
      ...toolCallIds.length > 0 ? { toolCallIds } : {},
      ...provenance === null ? {} : { provenance } });
    seqs.push(seq);
  }
  return { items, seqs, currentTurnOrdinal: turn, currentStepOrdinal: globalStep,
    completedThroughTurnOrdinal: Math.min(completedThrough, turn) };
}

/** The journal fields one published application records. */
function publishFields(sessionId: string, request: RacoonsApplicationRequest): Record<string, unknown> {
  return {
    sessionId,
    eventId: request.application.eventId,
    mode: request.application.mode,
    replacements: request.application.replacements.map((replacement) => ({
      nodeId: replacement.source.nodeId,
      sourceByteLength: replacement.source.byteLength,
      byteLength: replacement.bytes.length,
      text: new TextDecoder().decode(replacement.bytes),
      generatedRanges: replacement.generatedRanges,
      retainedCopies: replacement.retainedCopies,
      evidenceRecallId: replacement.evidenceRecallId,
    })),
    appendRecords: request.application.appendRecords.map((record) => ({
      recordId: record.recordId, byteLength: record.bytes.length,
      text: new TextDecoder().decode(record.bytes),
    })),
    archives: request.application.archives.map((archive) => ({
      ruleId: archive.ruleId, removalId: archive.removalId,
      operationKind: archive.operationKind, recallId: archive.recall.id,
      title: archive.title,
      sourceSha256: archive.recall.parts[0]?.source.sha256 ?? null,
      sourceNodeId: archive.recall.parts[0]?.source.nodeId ?? null,
      sourceByteLength: archive.recall.parts[0]?.source.byteLength ?? null,
      removedBytes: archive.recall.parts.reduce((sum, part) => sum + part.removedRanges
        .reduce((count, span) => count + span.range.endByteExclusive - span.range.startByte, 0), 0),
    })),
    sealedEpisodeIds: request.application.sealedEpisodeIds,
    applicationSha256: request.application.applicationSha256,
    intentId: request.intent.intentId,
  };
}

/**
 * Build the mount runtime: engine + adapter + port + per-session observation
 * state. Separated from `apply` so a test can exercise the whole seam against
 * a fake context and fake sessions with the real engine and adapter.
 *
 * The mount owns the two pieces of host state the seams need: the `tool/call`
 * facts (name and arguments, which a `tool/result` does not repeat) and the
 * queue of results waiting for the next `agent/pre-step`.
 */
export function createRacoonsMount(options: {
  readonly config: ResolvedRacoonsConfig;
  readonly storage: ResolvedRacoonsStorage;
  readonly openLedger?: RacoonsLedgerFactory;
  readonly journal?: RacoonsJournalSink;
  readonly clock?: Clock;
  /**
   * The host's model seam. Absent means neither ask moment can run: the entry
   * loop journals `entry-ask-off` with `no-llm-service` and the prune pass keeps
   * its L1 layer, which is the truthful state of a mount without a model
   * (ADR-0028: two ask moments, both through this seam).
   */
  readonly llm?: DshLlmService;
  /** A fixed route, when the caller knows one; otherwise the host header decides. */
  readonly judgeRoute?: JudgeRoute;
  /**
   * The store of main's last dispatched request (ISSUE-026 chunk 3). The shipped
   * plugin fills it from its `llm/stream` observer; a test or a rig may inject
   * one it fills itself.
   */
  readonly mainWire?: MainWireCapture;
  /**
   * The host's own warning channel (`ctx.logger.warn`), when the plugin has one.
   * A storage open that will be retried is warned here as well as journaled, so
   * the operator sees the transient failure without reading the journal sink.
   */
  readonly warn?: (message: string) => void;
}): RacoonsMount {
  const { config, storage } = options;
  // A resolved config can reach here without passing through
  // `resolvePluginConfig` (a direct caller or a test). The same rule applies:
  // a bar needs a configured window or the host model-info seam (ADR-0071).
  if (config.pruneThresholdTokens !== null && config.contextWindowTokens === null
      && typeof options.llm?.resolveModelInfo !== 'function') {
    throw new Error('cremator: pruneThresholdTokens requires contextWindowTokens '
      + 'or a host llm.resolveModelInfo seam (the apply leg plans against the host window)');
  }
  const clock: Clock = options.clock ?? { nowMs: () => Date.now() };
  const emit = options.journal ?? (() => {});
  const journal = (kind: RacoonsJournalKind, fields: Record<string, unknown>): void => {
    try {
      emit(Object.freeze({ kind, atMs: clock.nowMs(), ...fields }) as RacoonsJournalRecord);
    } catch { /* a journal sink must never alter engine outcomes */ }
  };
  /**
   * The host's warning channel, guarded (ISSUE-429): a throwing `warn` sink is
   * presentation, so it can neither skip the ask nor replace its outcome.
   */
  const safeWarn = (message: string): void => {
    try { options.warn?.(message); } catch { /* a warn sink must never change an outcome */ }
  };
  /**
   * The configured route, validated and normalized ONCE at mount (ISSUE-427).
   * `routeConfigured` separates "no fixed route" (the host header decides) from
   * a configured blank pair, which means "off" and must not fall through to the
   * header. An invalid field is a typed refusal: one `route-invalid` line names
   * it and the mount runs as if no route were configured, never as if one were
   * guessed. The value handed to both ask lanes is always a normalized route or
   * null, so `askEntryBatch` keeps its no-throw contract.
   */
  let fixedRoute: JudgeRoute | null = null;
  const routeConfigured = options.judgeRoute !== undefined;
  if (routeConfigured) {
    try {
      fixedRoute = normalizeJudgeRoute(options.judgeRoute);
    } catch (error) {
      if (!(error instanceof JudgeRouteError)) throw error;
      journal('route-invalid', { field: error.field, code: error.code, message: error.message });
    }
  }
  const resolveRoute = (host: DshMountSession | null | undefined): JudgeRoute | null =>
    routeConfigured ? fixedRoute : judgeRouteOf(host);
  /**
   * ISSUE-432: re-derive every model-derived per-entry parameter from the live
   * host route. dsh exposes the route by pull (`requestHeader()`), not by a
   * model-change event, so each boundary re-reads it here instead of trusting a
   * mount-time snapshot. The floor is refreshed and stamped with the
   * provider/model it came from; a change is named in `model-refresh`. The
   * window is resolved separately (`refreshBoundaryWindow`, ADR-0071), and the
   * main-wire seed is invalidated at the ask when its own capture names a
   * different model.
   */
  function refreshModelParameters(entry: RacoonsSessionEntry): void {
    const route = resolveRoute(entry.host);
    const provider = route?.provider ?? null;
    const model = route?.model ?? null;
    // An explicit floor wins for every model and carries no model provenance.
    if (config.floorBytes !== null && config.floorBytes !== undefined) {
      entry.floorProvider = null;
      entry.floorModel = null;
      return;
    }
    const next = floorForModel(model ?? undefined);
    if (provider === entry.floorProvider && model === entry.floorModel
      && next === entry.floorBytes) return;
    const from = { provider: entry.floorProvider, model: entry.floorModel,
      floorBytes: entry.floorBytes };
    entry.floorProvider = provider;
    entry.floorModel = model;
    entry.floorBytes = next;
    // ISSUE-469: the guard reads the engine's own config, so the refreshed
    // floor must reach it too. One config, one floor: the ask gate and the
    // engine cannot disagree about the model the route now names.
    entry.engine.updateConfig(engineConfig(config, next));
    journal('model-refresh', { sessionId: entry.sessionId, from,
      to: { provider, model, floorBytes: next },
      window: config.contextWindowTokens === null ? 'host-model-info' : 'mount-option',
      seed: 'invalidated-on-model-mismatch' });
  }

  /**
   * ADR-0071 / ADR-0072: put the depth latch on the routed model's own window.
   * A configured window is authoritative and needs no lookup. Otherwise the
   * exact provider/model answers the host's model-info seam once per mount,
   * and the answer is cached. A route change re-resolves, re-arms the latch
   * from the next reading, and persists that state. A lookup that cannot
   * answer writes one `window-unresolved` per route and leaves the latch off;
   * it never invents a number.
   */
  async function refreshBoundaryWindow(entry: RacoonsSessionEntry,
    signal?: AbortSignal): Promise<void> {
    const route = resolveRoute(entry.host);
    if (route === null || route.provider.length === 0 || route.model.length === 0) return;
    // A configured window is authoritative and never asks the host, but a route
    // change still re-arms the latch (ADR-0072 decision 5).
    const configured = config.contextWindowTokens;
    if (configured !== null) {
      if (entry.windowProvider === route.provider && entry.windowModel === route.model) return;
      applyResolvedWindow(entry, route, configured, 'config');
      return;
    }
    const sameRoute = entry.windowProvider === route.provider
      && entry.windowModel === route.model;
    if (sameRoute && entry.windowTokens !== null) return;
    if (signal?.aborted === true) return;
    const key = `${route.provider}\u0000${route.model}`;
    const cached = modelWindows.get(key);
    if (cached !== undefined) {
      // A route another session already resolved still gets this session's own
      // line once, so the record names the window it acted under.
      journal('window-resolved', { sessionId: entry.sessionId,
        provider: route.provider, model: route.model, window: cached,
        source: 'host-model-info-cache' });
      applyResolvedWindow(entry, route, cached, 'host-model-info');
      return;
    }
    const host = options.llm;
    const resolveInfo = host?.resolveModelInfo;
    if (typeof resolveInfo !== 'function') {
      noteWindowUnresolved(entry, route, 'no-model-info-seam',
        'the host exposes no model-info seam');
      applyResolvedWindow(entry, route, null, 'unresolved');
      return;
    }
    try {
      const answer = await resolveInfo.call(host, route.provider, route.model, signal);
      const candidate = answer?.context?.contextWindow;
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) {
        modelWindows.set(key, candidate);
        entry.windowUnresolved.delete(key);
        journal('window-resolved', { sessionId: entry.sessionId,
          provider: route.provider, model: route.model, window: candidate,
          source: 'host-model-info' });
        applyResolvedWindow(entry, route, candidate, 'host-model-info');
        return;
      }
      noteWindowUnresolved(entry, route, 'no-positive-context-window',
        'the host model-info answer carried no positive contextWindow');
      applyResolvedWindow(entry, route, null, 'unresolved');
    } catch (error) {
      if (isAborted(signal)) return;
      noteWindowUnresolved(entry, route, 'model-info-failed', messageOf(error));
      applyResolvedWindow(entry, route, null, 'unresolved');
    }
  }

  /** Record one route's unresolved line, once per session (ADR-0071). */
  function noteWindowUnresolved(entry: RacoonsSessionEntry, route: JudgeRoute,
    reason: string, message: string): void {
    const key = `${route.provider}\u0000${route.model}`;
    if (entry.windowUnresolved.has(key)) return;
    entry.windowUnresolved.add(key);
    journal('window-unresolved', { sessionId: entry.sessionId,
      provider: route.provider, model: route.model, reason, message });
  }

  /**
   * Install one resolved (or unresolved) window on the entry and the latch.
   * A route CHANGE re-arms the latch from the next reading and persists it
   * (ADR-0072); the first resolution only enables the window.
   */
  function applyResolvedWindow(entry: RacoonsSessionEntry, route: JudgeRoute,
    window: number | null, source: 'config' | 'host-model-info' | 'unresolved'): void {
    const from = { provider: entry.windowProvider, model: entry.windowModel,
      window: entry.windowTokens };
    const switched = from.provider !== null
      && (from.provider !== route.provider || from.model !== route.model);
    entry.windowTokens = window;
    entry.windowProvider = route.provider;
    entry.windowModel = route.model;
    if (from.window !== window) entry.pruneTrigger.setWindowTokens(window);
    if (!switched) return;
    entry.pruneTrigger.noteColdBoundary();
    const target = targets.get(entry.sessionId);
    if (target !== undefined) {
      writePruneRound(target, entry.pruneRounds, journal, entry.sessionId,
        entry.pruneTrigger.snapshot());
    }
    journal('model-switch', { sessionId: entry.sessionId, from,
      to: { provider: route.provider, model: route.model, window },
      windowSource: source });
  }
  const sessions = new Map<string, RacoonsSessionEntry>();
  /**
   * Exact-route context windows resolved from the host's model-info seam
   * (ADR-0071), keyed by `provider\0model`. Successes only: a failed route is
   * retried at the next boundary, and its one journal line per session rides
   * `windowUnresolved`.
   */
  const modelWindows = new Map<string, number>();
  /**
   * First opens still in flight per session id (ISSUE-500). The session map is
   * populated only after the ledger open and the engine build complete, so two
   * concurrent first-use boundaries for one id (an ask and a direct `runPrune`,
   * both allowed by `boundaries`) would both pass the `sessions.get` check and
   * build a second engine/port/ledger; the second `sessions.set` would orphan
   * the first entry — its ledger never closed, its boundary applying through a
   * detached port. Each first open publishes its promise here, so a concurrent
   * boundary awaits the same entry instead. A failed open rejects every waiter
   * before any state is installed and leaves nothing to await, so the next
   * boundary retries. No cap, no timeout (standing rule 7 / ADR-0060).
   */
  const openingSessions = new Map<string, Promise<RacoonsSessionEntry>>();
  const calls = new Map<string, Map<string, CallFacts>>();
  const buffers = new Map<string, Capture[]>();
  /**
   * Sessions a `/cremate` user message named (ISSUE-022 chunk 5). `session/event`
   * may not append, so the trigger is only remembered here; the pass itself runs
   * at the next `agent/pre-step`, which is already the at-rest boundary.
   */
  const pruneRequests = new Set<string>();
  /**
   * Sessions with a pass in progress, whichever trigger started it (ISSUE-545).
   * A second command or typed request reports busy instead of queueing another
   * pass behind the one already running.
   */
  const passRunning = new Set<string>();
  /**
   * Record one typed `/cremate` message's request; the next `agent/pre-step`
   * runs it. A second typed message for a session already waiting is a no-op.
   * The registered command does not use this seam: its pass is scoped to the
   * marker turn that runs it ({@link beginCremate}, ISSUE-535).
   */
  function requestPrune(sessionId: string, seq: number | undefined): void {
    if (pruneRequests.has(sessionId) || passRunning.has(sessionId)
        || cremateRunning.has(sessionId)
        || (cremateRequests.get(sessionId)?.size ?? 0) > 0) return;
    pruneRequests.add(sessionId);
    journal('prune-requested', { sessionId, seq });
  }
  /**
   * The registered `/cremate` command's pass requests, by session and marker
   * message id (ISSUE-535). A command handler runs outside a turn, so it cannot
   * run the pass itself: the pass appends `tool/result` surface replacements,
   * and the host's session format accepts those only inside an open turn. Each
   * request therefore names the marker message whose `agent/pre-step` runs it,
   * and owns the one-shot wait the command card awaits.
   */
  interface PruneWaitEntry {
    done: boolean;
    settle(result: CrematePassResult): void;
  }
  interface CremateRequest {
    readonly sessionId: string;
    readonly messageId: string;
    readonly commandId: string | undefined;
    /** The host turn that claimed the marker; null until the claim. */
    turn: number | null;
    readonly waiters: PruneWaitEntry[];
  }
  const cremateRequests = new Map<string, Map<string, CremateRequest>>();
  /**
   * Sessions whose command pass has been taken and not settled. A second
   * command between the take and the settle must report busy instead of
   * queueing another pass (ISSUE-545).
   */
  const cremateRunning = new Set<string>();

  /** Register one command invocation's request and its awaited outcome. */
  function beginCremate(sessionId: string, messageId: string,
    commandId: string | undefined): CremateWait | null {
    let resolveResult!: (result: CrematePassResult) => void;
    const result = new Promise<CrematePassResult>((resolve) => { resolveResult = resolve; });
    const waiter: PruneWaitEntry = {
      done: false,
      settle(next) {
        if (waiter.done) return;
        waiter.done = true;
        resolveResult(next);
      },
    };
    const byMessage = cremateRequests.get(sessionId) ?? new Map<string, CremateRequest>();
    const existing = byMessage.get(messageId);
    if (existing !== undefined) {
      // One invocation per message id; a repeat joins the same request.
      existing.waiters.push(waiter);
      return cremateWait(sessionId, messageId, waiter, result);
    }
    // Busy is a report, not a queue: no marker turn is opened, so no second
    // pass can follow this one (native `/compact` reports the same way).
    if (byMessage.size > 0 || cremateRunning.has(sessionId)
        || passRunning.has(sessionId) || pruneRequests.has(sessionId)) {
      journal('prune-requested', { sessionId, seq: undefined, source: 'command',
        messageId, commandId, busy: true });
      return null;
    }
    byMessage.set(messageId, { sessionId, messageId, commandId, turn: null,
      waiters: [waiter] });
    cremateRequests.set(sessionId, byMessage);
    journal('prune-requested', { sessionId, seq: undefined, source: 'command',
      messageId, commandId });
    return cremateWait(sessionId, messageId, waiter, result);
  }

  /** The one wait handle a registered request hands its command. */
  function cremateWait(sessionId: string, messageId: string,
    waiter: PruneWaitEntry, result: Promise<CrematePassResult>): CremateWait {
    return {
      result,
      abandon: (message: string) => {
        waiter.settle({ status: 'failed', code: 'cancelled', message });
        // An abandoned card also drops its pending request, so the marker turn
        // that follows runs no pass the card already reported as cancelled.
        const pending = cremateRequests.get(sessionId);
        const request = pending?.get(messageId);
        if (request === undefined || !request.waiters.every(entry => entry.done)) return;
        pending?.delete(messageId);
        if (pending?.size === 0) cremateRequests.delete(sessionId);
      },
    };
  }

  /** Take one request for the pass that claimed its marker; the pass settles it. */
  function takeCremate(sessionId: string, messageId: string): CremateRequest | undefined {
    const byMessage = cremateRequests.get(sessionId);
    const request = byMessage?.get(messageId);
    if (byMessage === undefined || request === undefined) return undefined;
    byMessage.delete(messageId);
    if (byMessage.size === 0) cremateRequests.delete(sessionId);
    cremateRunning.add(sessionId);
    return request;
  }

  /** Settle an already-taken request's waiters exactly once. */
  function settleCremate(request: CremateRequest | undefined,
    result: CrematePassResult): void {
    if (request === undefined) return;
    cremateRunning.delete(request.sessionId);
    for (const waiter of request.waiters) waiter.settle(result);
  }

  /** Drop one command request: the host discarded its marker or the open failed. */
  function cancelCremate(sessionId: string, messageId: string, message: string): void {
    const request = takeCremate(sessionId, messageId);
    if (request === undefined) return;
    settleCremate(request, { status: 'failed', code: 'cancelled', message });
  }

  /** Bind a request to the turn that claimed its marker message. */
  function claimCremate(sessionId: string, messageId: string, turn: number): void {
    const request = cremateRequests.get(sessionId)?.get(messageId);
    if (request !== undefined) request.turn = turn;
  }

  /**
   * One turn ended. A request whose marker that turn claimed but whose pass
   * never ran fails by name instead of leaving the card pending: a prior
   * pre-step listener may have rejected the step (whereas this mount rejects
   * the marker step only after running the pass).
   */
  function failCremateTurn(sessionId: string, turn: number): void {
    const byMessage = cremateRequests.get(sessionId);
    if (byMessage === undefined) return;
    for (const request of [...byMessage.values()]) {
      if (request.turn !== turn) continue;
      cancelCremate(sessionId, request.messageId,
        'the turn ended before the cremation pass ran');
    }
  }

  /** Every request this session still holds fails: disposal, eviction, close. */
  function abandonCremateWaits(sessionId: string, message: string): void {
    const byMessage = cremateRequests.get(sessionId);
    if (byMessage === undefined) return;
    cremateRequests.delete(sessionId);
    for (const request of byMessage.values()) {
      settleCremate(request, { status: 'failed', code: 'cancelled', message });
    }
  }

  /** The request a marker names, if the host has not claimed its turn yet. */
  function cremateRequestOf(sessionId: string, messageId: string): CremateRequest | undefined {
    return cremateRequests.get(sessionId)?.get(messageId);
  }
  /**
   * Main's last dispatched request per session (ISSUE-026 chunk 3, ADR-0010).
   * Filled by the `llm/stream` observer at the only point this package can see
   * an outgoing request; the entry ask and the prune pass both read it. Empty
   * means the host exposed no waterfall: the pass then fails open with
   * `no-seed`.
   */
  const mainWire: MainWireCapture = options.mainWire ?? createMainWireCapture();
  const counters = { entries: 0, preSteps: 0, publications: 0, captured: 0 };
  /** Sessions already journaled `storage-unavailable`; the line is written once. */
  const unavailable = new Set<string>();
  /** Durable-open failures so far per session; the retry is bounded by `STORAGE_OPEN_ATTEMPTS`. */
  const openFailures = new Map<string, number>();
  /** Sessions whose effective per-session paths were journaled; one `storage-plan` each. */
  const planned = new Set<string>();
  /**
   * Each session's durable target, resolved once at its entry (ISSUE-022 chunk
   * 6). The prune round store writes beside the same `ledger.sqlite`; a session
   * with no durable plan (in-memory tests, or a refused id) has no entry here,
   * and its round stays in-process.
   */
  const targets = new Map<string, ResolvedRacoonsStorage>();
  /**
   * In-flight session-end evictions (ISSUE-377), so a second `endSession` call
   * for the SAME open entry coalesces with the first instead of racing its
   * ledger close. Each registration carries the entry its end owns (ISSUE-452):
   * after a reopen the mapped entry is a new life, so its `session/end` starts
   * its own release instead of being swallowed by the old end. The registry is
   * a SET per id (ISSUE-473, as `boundaries` is): two ends that legitimately do
   * not coalesce are both registered and both drained, so a later registration
   * can never drop an end that is still parked inside `ledger.close()`. Each
   * registration removes only itself when its eviction settles; this map holds
   * only live work.
   */
  const endings = new Map<string, Set<SessionEnding>>();
  /**
   * In-flight boundary work per session (ISSUE-397, ISSUE-401), so `endSession`
   * can wait out every running `runStep`/`runTurnEnd`/`runPrune` before
   * releasing: a settled boundary must never requeue buffers for an ended
   * session or reopen its released entry through the tail prune. EVERY boundary
   * registers its own promise, so a second concurrent boundary (a direct
   * `runPrune` overlapping an in-flight ask) cannot escape the drain; a promise
   * that settles removes only its own registration, whatever order the
   * boundaries settle in. This tracks work, not permission: reopen-after-end
   * stays free (ISSUE-374). No cap, no timeout (standing rule 7 / ADR-0060).
   */
  const boundaries = new Map<string, Set<Promise<unknown>>>();
  /**
   * Set once `close()` starts (ISSUE-416). The shutdown drains, flushes and
   * releases, and a pre-step or turn-end delivered during those awaits must
   * neither transform a still-mapped entry whose ledger close is next nor
   * re-open a released session's ledger. `sessionFor` refuses from here on;
   * work already in flight holds its entry and settles through the drain.
   */
  let closing = false;
  /**
   * The token estimate every boundary reads (ISSUE-022 chunk 6): the same four
   * bytes-per-token heuristic the engine's own meter uses, kept here as an
   * estimate-only instance so the trigger and the engine cannot disagree about
   * how full the session is. The trigger adds main's captured system+tools
   * prefix to it (ADR-0009 §Amendment 2026-10-24); this meter itself only
   * measures bytes it is handed. It records no usage observations.
   */
  const estimateMeter = new Meter(new CharHeuristicTokenMeter());

  /**
   * Journal the final refusal and return the wallet that refuses every call
   * (ADR-0013 ruling 4). `storage-unavailable` is written once per session.
   */
  function refuseStorage(sessionId: string, failure: {
    readonly code: string; readonly path: string | null; readonly message: string;
    readonly storagePath: string;
  }): Ledger {
    if (!unavailable.has(sessionId)) {
      unavailable.add(sessionId);
      // ADR-0013 ruling 8: runtime evidence comes from inside the mount.
      journal('storage-unavailable', { sessionId, code: failure.code, path: failure.path,
        node: process.version, storage: failure.storagePath, message: failure.message });
    }
    return createRefusingLedger({ code: failure.code, path: failure.path, message: failure.message });
  }

  /**
   * Open this session's ledger, or install a refusing one (ADR-0013 ruling 4,
   * ISSUE-004 chunk 4). Only the adapter's own open is wrapped: a host-supplied
   * `openLedger` belongs to the host, so its failure stays the host's.
   *
   * A transient failure is retried at the next boundary instead of degrading
   * the mount for its whole lifetime (critic fix P2#4): the first failure
   * journals `storage-retry`, warns, and throws `RacoonsStorageRetryError` so
   * this pre-step is skipped; the next `sessionFor` call (next pre-step,
   * turn-end or prune) tries the real open again. Only a second failure
   * installs the refusing ledger and journals `storage-unavailable` once. A
   * successful retry journals `storage-recovered`. Neither line repeats.
   */
  async function openOrRefuse(target: ResolvedRacoonsStorage,
    sessionId: string): Promise<Ledger> {
    if (options.openLedger !== undefined) return options.openLedger(sessionId);
    try {
      const ledger = await openLedger(target, clock);
      const failures = openFailures.get(sessionId) ?? 0;
      if (failures > 0) {
        openFailures.delete(sessionId);
        journal('storage-recovered', { sessionId, attempts: failures, node: process.version,
          storage: target.databasePath });
      }
      return ledger;
    } catch (error) {
      const code = error instanceof RacoonsStorageError ? error.code : 'unexpected';
      const path = error instanceof RacoonsStorageError ? error.path : target.databasePath;
      const message = error instanceof Error ? error.message : String(error);
      const failures = (openFailures.get(sessionId) ?? 0) + 1;
      openFailures.set(sessionId, failures);
      if (failures < STORAGE_OPEN_ATTEMPTS) {
        journal('storage-retry', { sessionId, attempt: failures,
          attempts: STORAGE_OPEN_ATTEMPTS, code, path, node: process.version,
          storage: target.databasePath, message });
        safeWarn(`storage open failed (${code} at ${path ?? target.databasePath});`
          + ` retrying at the next step boundary: ${message}`);
        throw new RacoonsStorageRetryError(sessionId, failures, { code, path, message });
      }
      return refuseStorage(sessionId, { code, path, message,
        storagePath: target.databasePath });
    }
  }

  /**
   * This session's own durable target, or the typed refusal when the id cannot
   * be a directory name. An unsafe id goes through the same refusal path as a
   * failed open (critic fix P3#8): a refusing ledger plus one journal line,
   * never a throw into the host's retry loop — a retry cannot fix the id.
   */
  function deriveTarget(sessionId: string):
  { readonly target: ResolvedRacoonsStorage } | { readonly refusal: {
    readonly code: string; readonly path: string | null; readonly message: string;
    readonly storagePath: string;
  } } {
    if (storage.root === undefined) return { target: storage };
    try {
      return { target: resolveSessionStorage(storage.root, sessionId) };
    } catch (error) {
      const refusal = error instanceof RacoonsStorageError ? error : null;
      return { refusal: {
        code: refusal?.code ?? 'invalid-session-id',
        path: refusal?.path ?? sessionId,
        message: error instanceof Error ? error.message : String(error),
        // No per-session plan exists (the id is the fault), so the line names
        // the durable root rather than an unrefined `<sessionId>` layout.
        storagePath: storage.root,
      } };
    }
  }

  /**
   * Adopt one boundary's host on an already-open entry (ISSUE-432). The seam and
   * the recall boundary were closed over the entry-opening host; rebuilding both
   * from the host this boundary was handed keeps a later mount or a second
   * boundary from being served the old host. A boundary that had to await
   * another's first open (ISSUE-500) takes this same path once the entry exists.
   */
  function adoptBoundaryHost(entry: RacoonsSessionEntry, host?: DshMountSession): void {
    if (host !== undefined) {
      entry.host = host;
      const nextSeam = revertSessionFromHost(host);
      const nextRoot = typeof host.header?.cwd === 'string' && host.header.cwd.length > 0
        ? host.header.cwd : undefined;
      entry.port.updateHostSeams(nextSeam, nextRoot);
    }
    // ISSUE-432: the route may have changed under the same session id.
    refreshModelParameters(entry);
  }

  /**
   * The per-session entry, opened on first use. Concurrent first uses of one id
   * share one in-flight open (ISSUE-500): the second boundary awaits the first's
   * promise instead of passing the not-yet-populated `sessions` map and building
   * a second engine/port/ledger. The map holds live work only; a settled open
   * removes its own registration whatever the outcome.
   */
  async function sessionFor(sessionId: string, host?: DshMountSession): Promise<RacoonsSessionEntry> {
    // ISSUE-416: once close() starts, no new session work. A still-mapped entry's
    // ledger close may be next in the release loop, and a released session must
    // not re-open. Work already in flight holds its entry and never re-enters
    // here (the step's tail prune is handed its caller's entry), so the refusal
    // cannot abandon a drained boundary.
    if (closing) throw new RacoonsClosingError(sessionId);
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      adoptBoundaryHost(existing, host);
      return existing;
    }
    const inFlight = openingSessions.get(sessionId);
    if (inFlight !== undefined) {
      const shared = await inFlight;
      adoptBoundaryHost(shared, host);
      return shared;
    }
    const first = openSession(sessionId, host);
    openingSessions.set(sessionId, first);
    try {
      return await first;
    } finally {
      openingSessions.delete(sessionId);
    }
  }

  /**
   * The one slow path: this session's engine, port and ledger, built and
   * installed under the `sessionFor` registration that precedes it.
   */
  async function openSession(sessionId: string, host?: DshMountSession): Promise<RacoonsSessionEntry> {
    const ownedLedger = options.openLedger === undefined;
    // ADR-0013: a durable plan carries `root`; it becomes this session's own
    // `sessions/<id>/ledger.sqlite` + `blobs/`. `':memory:'` opens the pair.
    // An unsafe id is refused here, through the same refusing ledger a failed
    // open installs (critic fix P3#8) — a retry can never fix the id.
    const derived = deriveTarget(sessionId);
    if ('target' in derived && storage.root !== undefined && !planned.has(sessionId)) {
      planned.add(sessionId);
      // The EFFECTIVE refined plan, journaled where the refinement happens
      // (critic fix P3#10): the mount line must never carry `<sessionId>`.
      journal('storage-plan', { sessionId, databasePath: derived.target.databasePath,
        blobRoot: derived.target.blobRoot, node: process.version });
    }
    const ledger = 'refusal' in derived
      ? refuseStorage(sessionId, derived.refusal)
      : await openOrRefuse(derived.target, sessionId);
    // A retryable open failure throws `RacoonsStorageRetryError` out of here
    // before any state is installed: the caller's next boundary retries, and no
    // half-built entry is ever visible to `sessions`.
    // ADR-0020 Decision 3 / ISSUE-058 item 2: the size floor is resolved here
    // because the model id reaches this package and never core. An explicit
    // `floorBytes` wins for every model; otherwise the route's model picks its
    // table entry (`floorForModel`), and a mount with no route falls back to the
    // measured default. The entry carries the number AND the provider/model it
    // came from (ISSUE-432); `refreshModelParameters` re-derives both at every
    // boundary, so a mid-session switch is not left on the old model's floor.
    const openingRoute = resolveRoute(host);
    const floorBytes = config.floorBytes
      ?? floorForModel(openingRoute?.model);
    const publications: unknown[] = [];
    let latestRequest: RacoonsApplicationRequest | null = null;
    const pendingAppends: RacoonsApplicationRequest[] = [];
    // ISSUE-024: the revert seam is derived from the live host session, never
    // from a config flag, so `revertHistory` below can only be true when one
    // exists (ISSUE-010's capability-truth law). The seam closes over the host
    // object and reads its surface at apply time, so a later host mutation is
    // seen; only a mount that opens with no host stays revert-less for good.
    const seam = revertSessionFromHost(host);
    // The workspace root the recall source lane may read inside (ISSUE-053;
    // PRD §6.7). It is the host's own `header.cwd`, which dsh validates
    // absolute; a fake or older host that names none leaves the port with no
    // boundary, so a ledger miss stays `not-found`.
    const workspaceRoot = typeof host?.header?.cwd === 'string' && host.header.cwd.length > 0
      ? host.header.cwd : undefined;
    // This session's durable target, resolved before the port exists so the
    // publish callback can persist the pending-append intent at commit
    // (ISSUE-374). `':memory:'` (tests) and a refused id have no target: their
    // queue stays in-process, exactly the ISSUE-342 behaviour.
    const durable = 'target' in derived && derived.target.databasePath !== ':memory:'
      ? derived.target : null;
    // ISSUE-422: a fork/clone is the third case beside fresh and restart. The
    // host announces no fork event in the seam this mount reads, so the in-repo
    // identity is the durable state's own install record: state that names a
    // DIFFERENT session is a parent's copy carried to a child id. The child
    // inherits history the parent already settled, so it must not replay it,
    // re-ask it or apply the parent's owed work. State written before the
    // `sessionId` field existed reads as this session's own (a restart).
    const priorInstall: DurableInstall | null = durable === null
      ? null : readInstall(durable, journal, sessionId);
    const forkFrom = priorInstall !== null && priorInstall.sessionId !== undefined
      && priorInstall.sessionId !== sessionId ? priorInstall.sessionId : null;
    const forked = forkFrom !== null;
    // ISSUE-477 / ISSUE-478: the inherited-set proof and pending-clear marker in
    // their own file, so they survive the install identity's own failed write.
    // A record that names another session is the copied parent's and never
    // answers for this child.
    const priorPreinstall: DurablePreinstallRecord | null = durable === null
      ? null : readPreinstallRecord(durable);
    const ownPreinstall = priorPreinstall !== null && priorPreinstall.sessionId === sessionId
      ? priorPreinstall : null;
    // ISSUE-417: applied receipts a previous process minted. They let this
    // mount's `lookupReceipt` resolve a prepared ledger row the previous process
    // landed, so recovery does not read `unknown` and block forever. A fork
    // reads them too (ISSUE-438, ADR-0064): the copied ledger is the child's
    // record, and these receipts describe host writes on the inherited surface,
    // so they are valid answers for that ledger.
    const durableReceipts = durable === null ? [] : readDurableReceipts(durable, journal, sessionId);
    // ISSUE-436: a receipt whose intent the ledger already records as `applied`
    // is superseded crash-window state. Collect it at mount so a file written
    // before this fix shrinks too; the ledger, not the copy, is the record of
    // record (ADR-0015).
    const receiptsInForce = durable === null || durableReceipts.length === 0
      ? durableReceipts
      : await collectSettledReceipts(durable, durableReceipts, ledger, journal, sessionId);
    if (receiptsInForce.length > 0) {
      journal('receipts-resumed', { sessionId, count: receiptsInForce.length });
    }
    const port = createDshPort({ sessionId, clock,
      ...(seam === null ? {} : { revert: seam }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      // ISSUE-417: a previous process's applied receipts come back from the
      // mount's durable state, and every receipt this process mints is written
      // there at the host write, so a prepared ledger row can be resolved after
      // an unload instead of blocking recovery as `unknown` forever.
      ...(durable === null ? {} : {
        receipts: receiptsInForce,
        persistReceipt: (receipt: ApplyReceipt) => {
          writeDurableReceipt(durable, receipt, journal, sessionId);
        },
      }),
      publish: (request) => {
        const owned = request as unknown as RacoonsApplicationRequest;
        latestRequest = owned;
        // The port committed this append; queue it for the host publication a
        // boundary flushes (ISSUE-342). A failed publishAppend leaves it queued
        // so the next boundary retries rather than losing the records.
        pendingAppends.push(owned);
        // The intent is durable BEFORE the receipt commits (ISSUE-374): a
        // process death before the flush leaves a record the remount replays.
        if (durable !== null) {
          writePendingAppends(durable, durableAppendsOf(pendingAppends), journal, sessionId);
        }
        try { publications.push(structuredClone(request)); }
        catch { publications.push(request); }
        counters.publications += 1;
        journal('publish', publishFields(sessionId, owned));
      } });
    const capabilities = createDshCapabilities(seam !== null);
    // The seam is a capability; a *removal* needs no cache watermark. ADR-0012:
    // removal applies unconditionally, and an unknown cache has no fresh-zone
    // floor (`computeFreshZone` starts at 0), so the guard never refuses a cut
    // merely for being below a watermark. Only a real warm watermark can refuse
    // `cut-below-watermark`. The mount cannot derive one from dsh yet, so it
    // states the cache as `unknown` and lets the guard apply (ISSUE-024).
    journal('capabilities', { sessionId, revertHistory: capabilities.revertHistory,
      floorBytes,
      reason: seam === null ? 'no-host-revert-seam' : 'host-session',
      cacheState: 'unknown' });
    // One config object per session, carrying this session's resolved floor, so
    // the engine and the default rules cannot read two different numbers.
    const sessionConfig = engineConfig(config, floorBytes);
    const engine = await RacoonsEngine.open({
      sessionId,
      capabilities: { ...capabilities },
      config: sessionConfig,
      clock,
      meter: new Meter(new CharHeuristicTokenMeter()),
      ledger,
      rules: createDefaultRules(sessionConfig) as readonly Rule[],
      port,
      onTelemetry: (event) => {
        journal('telemetry', { sessionId, event });
      },
    });
    // The manual forget queue (PRD §6.2; ISSUE-045 chunk D2). A `forget` tool
    // call resolves its request against the live snapshot and lands here; the
    // step and turn-end boundaries drain it through `applyForget`, so a forget
    // applies at the same seam every other removal does and never from inside a
    // host callback (which forbids appends). The queue is per session and lives
    // on the entry, so a second session can never apply another's request.
    // ISSUE-417: a request the tool answered "scheduled" for is written to the
    // durable mount state BEFORE that answer leaves, and a remount re-queues it
    // here, so an unload between the answer and the drain can never lose it.
    const pendingForgets: DshForgetScheduled[] = durable === null || forked ? []
      : readPendingForgets(durable, journal, sessionId).map(forgetFromDurable);
    if (pendingForgets.length > 0) {
      journal('forget-recovered', { sessionId, count: pendingForgets.length });
    }
    const adapter = createDshAdapter({ engine, port, clock,
      onForget: decision => {
        pendingForgets.push(decision);
        // The tool answers only after this write lands. A failed write rolls the
        // in-memory push back and throws, and the adapter refuses by name rather
        // than accept a request no remount could replay.
        if (durable !== null
          && !writePendingForgets(durable, pendingForgets.map(durableForgetOf), journal, sessionId)) {
          pendingForgets.pop();
          journal('forget-persist-error', { sessionId, eventId: decision.eventId,
            pending: pendingForgets.length });
          throw new Error('the queued forget could not be made durable');
        }
      },
      ...(seam === null ? {} : { revert: seam }) });
    // The round the last process completed, read back from this session's own
    // directory (ISSUE-022 chunk 6). `':memory:'` answers 0, so tests keep the
    // old per-process behaviour unless they opt into a durable root.
    if (durable !== null) targets.set(sessionId, durable);
    // ISSUE-414: the install boundary. Durable mount state that already exists
    // means this session's state is ours — a restart, and recovery runs exactly
    // as before. No durable state at all means this mount is being installed
    // into a session that may already hold history: it records the tool-result
    // node ids already on that surface as the install's inherited set. That set
    // is durable identity evidence for a later fork/clone mount (ISSUE-422,
    // ISSUE-477, ISSUE-478); it is NOT an eligibility gate. A result it names is
    // tableable and removable by a later pass exactly like a result this mount
    // observes land. An in-memory session has no durable state to read, so it
    // keeps the pre-414 behaviour (recover).
    let installGeneration: number | null = null;
    let preInstallNodeIds: ReadonlySet<string> = new Set<string>();
    let installBoundary: RacoonsSessionEntry['installBoundary'] = 'none';
    let retryInstallIdentity: (() => void) | null = null;
    let installWriteFailed = false;
    let forkClearPending = false;
    let forkReborn = false;
    let recoveredFromLedger = false;
    if (durable !== null) {
      // ISSUE-437 / ISSUE-456 / ISSUE-457 / ISSUE-475: the copied durable state
      // still names the parent's owed work and the parent's round history.
      // Skipping the reads is not removing the facts, and the child's next
      // mount would be a restart that replays or inherits them as its own.
      // ISSUE-475: the inherited facts are captured ONCE, at mount. A retry
      // clears only what that snapshot still finds, so anything the child wrote
      // after mount (its own round, first-ask flag, accepted forget or append)
      // is never dropped and never reported as the parent's. Each clear's
      // result is read:
      // the drop line counts only facts whose write returned true, a failed
      // clear is named beside its file and count, and the fork withholds the
      // child's install identity until every fact is gone, so the next mount is
      // still a fork and never replays them. A failed count is retried at the
      // next boundary (no new cap; ADR-0060).
      interface ForkFactsSnapshot {
        readonly forgets: readonly DurableForget[];
        readonly appends: readonly DurableAppendRecord[];
        readonly round: number;
        readonly trigger: PruneWindowTriggerState | null;
        readonly entryAskFired: boolean;
        readonly tableAskFired: boolean;
        /** ISSUE-572: the header read was refused; the fact is owed, not absent. */
        readonly headerRefused: boolean;
      }
      let forkFacts: ForkFactsSnapshot | null = null;
      const captureForkFacts = (): ForkFactsSnapshot => {
        const header = readPruneHeaderFacts(durable, journal, sessionId);
        return {
          forgets: readPendingForgets(durable, journal, sessionId),
          appends: readPendingAppends(durable, journal, sessionId),
          round: header.round,
          trigger: header.trigger,
          headerRefused: header.refused,
          entryAskFired: readEntryAskFired(durable, journal, sessionId),
          tableAskFired: readTableAskFired(durable, journal, sessionId),
        };
      };
      // The header facts are value-shaped, so "the parent's" cannot be told from
      // "the child's" by reading the file after the child has written. The
      // owed state is therefore carried across calls: a fact the mount-time
      // clear already reconciled is never attempted again (ISSUE-475).
      let owedHeader: { round: boolean; askFired: boolean; tableAskFired: boolean } | null = null;
      const clearForkFacts = (): boolean => {
        const facts = forkFacts ??= captureForkFacts();
        owedHeader ??= { round: facts.round > 0 || facts.trigger !== null
          || facts.headerRefused,
          askFired: facts.entryAskFired, tableAskFired: facts.tableAskFired };
        // Forgets: remove only the records the mount-time snapshot holds.
        const currentForgets = readPendingForgets(durable, journal, sessionId);
        const parentForgetIds = new Set(facts.forgets.map(record => record.eventId));
        const parentForgets = currentForgets.filter(record => parentForgetIds.has(record.eventId));
        let droppedForgets = 0;
        if (parentForgets.length > 0
          && writePendingForgets(durable,
            currentForgets.filter(record => !parentForgetIds.has(record.eventId)),
            journal, sessionId)) {
          droppedForgets = parentForgets.length;
        }
        const forgetsLeft = parentForgets.length - droppedForgets;
        // Appends: same rule, keyed by the durable record id.
        const currentAppends = readPendingAppends(durable, journal, sessionId);
        const parentAppendIds = new Set(facts.appends.map(record => record.recordId));
        const parentAppends = currentAppends.filter(record => parentAppendIds.has(record.recordId));
        let droppedAppends = 0;
        if (parentAppends.length > 0
          && writePendingAppends(durable,
            currentAppends.filter(record => !parentAppendIds.has(record.recordId)),
            journal, sessionId)) {
          droppedAppends = parentAppends.length;
        }
        const appendsLeft = parentAppends.length - droppedAppends;
        // The parent's round, latch and first-ask flag are not the child's
        // (ISSUE-457). Each is cleared only while it is still owed and the file
        // still holds the snapshot's value, so a child that advanced one keeps
        // it (ISSUE-475).
        let droppedRound = false;
        let droppedLatch = false;
        let currentRound = 0;
        let roundLeft = 0;
        if (owedHeader.round) {
          currentRound = readPruneRound(durable, journal, sessionId);
          // ISSUE-572: a refused snapshot read is not proof the child advanced.
          // The fact stays owed and only a successful write retires it, so a
          // failed clear withholds the identity (ADR-0067).
          if (!facts.headerRefused && currentRound !== facts.round) {
            // The child advanced the ordinal: the parent's header is gone.
            owedHeader.round = false;
          } else {
            const currentTrigger = readPruneTriggerState(durable, journal, sessionId);
            // ISSUE-475: a latch the snapshot could read and the child wrote is
            // kept; only the value the fork captured may be cleared. ISSUE-572:
            // a latch the snapshot could not read is the parent's by position —
            // it sits in the copied file — so it is dropped with the round.
            const keepTrigger = facts.headerRefused ? undefined
              : sameTriggerState(currentTrigger, facts.trigger)
                ? undefined : (currentTrigger ?? undefined);
            if (writePruneRound(durable, 0, journal, sessionId, keepTrigger)) {
              droppedRound = facts.headerRefused || facts.round > 0 || facts.trigger !== null;
              droppedLatch = facts.headerRefused
                ? currentTrigger !== null : facts.trigger !== null;
              owedHeader.round = false;
            } else {
              roundLeft = facts.headerRefused ? 1
                : (facts.round > 0 ? 1 : 0) + (facts.trigger !== null ? 1 : 0);
            }
          }
        }
        let droppedAsk = false;
        let askLeft = false;
        if (owedHeader.askFired) {
          const currentAskFired = readEntryAskFired(durable, journal, sessionId);
          if (!currentAskFired) {
            owedHeader.askFired = false;
          } else if (writeEntryAskFired(durable, false, journal, sessionId)) {
            droppedAsk = true;
            owedHeader.askFired = false;
          } else {
            askLeft = true;
          }
        }
        // ISSUE-508: the depth table's first-ask flag is the parent's history
        // too, cleared by the same rule as the entry flag.
        let droppedTableAsk = false;
        let tableAskLeft = false;
        if (owedHeader.tableAskFired) {
          const currentTableAskFired = readTableAskFired(durable, journal, sessionId);
          if (!currentTableAskFired) {
            owedHeader.tableAskFired = false;
          } else if (writeTableAskFired(durable, false, journal, sessionId)) {
            droppedTableAsk = true;
            owedHeader.tableAskFired = false;
          } else {
            tableAskLeft = true;
          }
        }
        if (droppedForgets > 0 || droppedAppends > 0 || droppedRound || droppedAsk
          || droppedTableAsk) {
          journal('fork-state-dropped', { sessionId, parentSessionId: forkFrom,
            forgets: droppedForgets, appends: droppedAppends,
            ...(droppedRound ? { round: facts.headerRefused ? currentRound : facts.round,
              latch: droppedLatch } : {}),
            ...(droppedAsk ? { entryAskFired: true } : {}),
            ...(droppedTableAsk ? { tableAskFired: true } : {}) });
        }
        if (forgetsLeft > 0) {
          journal('fork-clear-failed', { sessionId, parentSessionId: forkFrom,
            file: MOUNT_STATE_FILE, fact: 'forgets', count: forgetsLeft });
        }
        if (appendsLeft > 0) {
          journal('fork-clear-failed', { sessionId, parentSessionId: forkFrom,
            file: PRUNE_ROUND_FILE, fact: 'appends', count: appendsLeft });
        }
        if (roundLeft > 0) {
          journal('fork-clear-failed', { sessionId, parentSessionId: forkFrom,
            file: PRUNE_ROUND_FILE, fact: 'round', count: roundLeft });
        }
        if (askLeft) {
          journal('fork-clear-failed', { sessionId, parentSessionId: forkFrom,
            file: PRUNE_ROUND_FILE, fact: 'entryAskFired', count: 1 });
        }
        if (tableAskLeft) {
          journal('fork-clear-failed', { sessionId, parentSessionId: forkFrom,
            file: PRUNE_ROUND_FILE, fact: 'tableAskFired', count: 1 });
        }
        return forgetsLeft === 0 && appendsLeft === 0
          && roundLeft === 0 && !askLeft && !tableAskLeft;
      };
      const surfaceToolIds = host === undefined ? []
        : surfaceTranscript(host, { sessionId }).items
          .filter(item => item.role === 'tool').map(item => item.id);
      let identity: DurableInstall;
      if (forked) {
        // ISSUE-422: the state names the parent. Every result on the inherited
        // surface was settled by the parent, so all of it is this child's
        // inherited set; the child records its own generation-1 identity over
        // the copy so a later mount of the child is a plain restart. The set is
        // identity evidence (which results the child inherited), never a skip:
        // a later prune pass may table and remove them like any other result.
        // ISSUE-478: a re-fork of a child that already ran here keeps the
        // inherited set its own first fork recorded. Recomputing it from the
        // surface would misreport the child's own results as inherited history.
        const restoredIds = ownPreinstall !== null ? [...ownPreinstall.ids] : surfaceToolIds;
        forkReborn = ownPreinstall !== null;
        if (ownPreinstall !== null && ownPreinstall.pendingClear) {
          journal('fork-clear-pending', { sessionId, parentSessionId: forkFrom,
            ids: restoredIds.length, file: PREINSTALL_RECORD_FILE });
        }
        installGeneration = 1;
        preInstallNodeIds = new Set(restoredIds);
        installBoundary = 'fork';
        identity = { generation: 1, installedAtMs: clock.nowMs(),
          preInstallNodeIds: restoredIds, sessionId };
        forkClearPending = !clearForkFacts();
        // The marker is independent of the withheld identity, so the next mount
        // knows both the inherited set and that the clear is still owed.
        writePreinstallRecord(durable, { sessionId, ids: restoredIds,
          pendingClear: forkClearPending }, journal, sessionId);
      } else if (priorInstall === null) {
        // ISSUE-460: the failed-write retry lives only in the entry closure, so
        // a death before the boundary lands leaves no install identity. A ledger
        // row under THIS session id is proof the session already ran here (a
        // fork's copied rows carry the parent's id, so they never count). Trust
        // the ledger over the missing file: classify a restart, record the
        // inherited set, and name the fallback.
        // ISSUE-573: a ledger that could not be read is not proof of absence.
        // The only two answers left are restart or refuse, so it takes the
        // restart path (recovery stays on, nothing is promoted) and the journal
        // names the failed read instead of reporting a fresh install.
        const ledgerEvidence = await ledgerRowEvidence(ledger, sessionId);
        if (ledgerEvidence !== 'none') {
          // ISSUE-477: the inherited set the first mount computed is durable
          // proof independent of the install identity, so a death before that
          // identity lands still records the same set. Without that proof the
          // surface results cannot be shown to predate this session, so they are
          // recorded as the inherited set by name. Either way the set is
          // identity evidence, not an eligibility gate.
          const ids = ownPreinstall !== null ? [...ownPreinstall.ids] : surfaceToolIds;
          installGeneration = 1;
          preInstallNodeIds = new Set(ids);
          installBoundary = 'restart';
          identity = { generation: 1, installedAtMs: clock.nowMs(),
            preInstallNodeIds: ids, sessionId };
          recoveredFromLedger = true;
          journal('install-fallback', { sessionId,
            reason: ledgerEvidence === 'rows' ? 'ledger-rows' : 'ledger-unreadable',
            source: ownPreinstall !== null ? 'preinstall-record' : 'surface-unsafe',
            preInstall: ids.length });
          if (ownPreinstall === null) {
            writePreinstallRecord(durable, { sessionId, ids, pendingClear: false },
              journal, sessionId);
          }
        } else {
          // ISSUE-414: "pre-install" is what this mount never OBSERVED land. The
          // session/event observer has captured every result appended since the
          // plugin was applied, so a surface result absent from the capture
          // buffer predates the plugin and is recorded as the inherited set.
          // (A host that appends between apply and the first session
          // registration cannot be told apart; it is the same shape a fresh
          // install into existing history produces, so it is recorded too.) The
          // set is identity evidence only: those results stay tableable and
          // removable exactly like one this mount observed land.
          const observed = new Set((buffers.get(sessionId) ?? []).map(capture => capture.eventId));
          const ids = host === undefined ? [] : surfaceTranscript(host, { sessionId }).items
            .filter(item => item.role === 'tool' && !observed.has(item.id))
            .map(item => item.id);
          installGeneration = 1;
          preInstallNodeIds = new Set(ids);
          // ISSUE-422: history already present on a first mount is the fork shape
          // the host did not announce; NAMED `inherited` instead of guessed at.
          installBoundary = ids.length > 0 ? 'inherited' : 'fresh';
          identity = { generation: 1, installedAtMs: clock.nowMs(),
            preInstallNodeIds: ids, sessionId };
          // ISSUE-477: record the inherited set before the first pass, in its own
          // file, so a lost install write cannot erase it. The set is never read
          // as an eligibility gate; it survives as the fork/clone identity.
          writePreinstallRecord(durable, { sessionId, ids, pendingClear: false },
            journal, sessionId);
        }
      } else {
        installGeneration = priorInstall.generation + 1;
        preInstallNodeIds = new Set(priorInstall.preInstallNodeIds);
        installBoundary = 'restart';
        identity = { ...priorInstall, generation: installGeneration,
          sessionId: priorInstall.sessionId ?? sessionId };
      }
      const journalBoundary = (): void => {
        journal('install-boundary', { sessionId, generation: installGeneration,
          fresh: priorInstall === null, state: installBoundary,
          preInstall: preInstallNodeIds.size,
          ...(forkFrom === null ? {} : { parentSessionId: forkFrom }) });
      };
      const attemptedBoundary = installBoundary;
      if (forked && forkClearPending) {
        // ISSUE-456: the child must not record its own install identity while a
        // parent fact the fork could not clear still sits on the copy. Keeping
        // the parent's identity on disk makes the next mount a fork again,
        // which never replays inherited work, and the boundary retries the
        // clear until both facts are gone (ADR-0065 Decision 2/3).
        installWriteFailed = true;
        journal('install-persist-error', { sessionId, state: attemptedBoundary,
          generation: identity.generation, retry: 'next-boundary',
          reason: 'fork-clear-pending' });
        retryInstallIdentity = () => {
          if (!clearForkFacts()) {
            journal('install-persist-error', { sessionId, state: attemptedBoundary,
              generation: identity.generation, retry: 'next-boundary',
              reason: 'fork-clear-pending' });
            return;
          }
          if (writeInstall(durable, identity, journal, sessionId)) {
            journalBoundary();
            // ISSUE-478: the pending clear is done, so the marker no longer
            // says a fork still owes the parent's facts.
            markPreinstallReconciled(durable, journal, sessionId);
            retryInstallIdentity = null;
          } else {
            journal('install-persist-error', { sessionId, state: attemptedBoundary,
              generation: identity.generation, retry: 'next-boundary' });
          }
        };
      } else if (writeInstall(durable, identity, journal, sessionId)) {
        journalBoundary();
      } else {
        // ISSUE-439 / ADR-0065: a durable write that failed is never treated as
        // landed. The mount does not journal a boundary the file does not hold;
        // it fails closed and retries the identity at each boundary until it
        // lands. ISSUE-458: only a genuine restart (a prior install exists)
        // falls back to "this session's own state with the prior inherited set".
        // A first mount classified `inherited` or `fresh` keeps the set it just
        // computed — those ids were proved never observed, so the retried
        // identity records them as the inherited set. The set gates no
        // eligibility either way.
        installWriteFailed = true;
        if (!forked && priorInstall !== null) {
          installGeneration = priorInstall.generation + 1;
          preInstallNodeIds = new Set(priorInstall.preInstallNodeIds);
          installBoundary = 'restart';
          identity = { ...priorInstall, generation: installGeneration,
            installedAtMs: priorInstall.installedAtMs,
            preInstallNodeIds: [...preInstallNodeIds],
            sessionId: priorInstall.sessionId ?? sessionId };
        }
        journal('install-persist-error', { sessionId, state: attemptedBoundary,
          generation: identity.generation, retry: 'next-boundary' });
        retryInstallIdentity = () => {
          if (writeInstall(durable, identity, journal, sessionId)) {
            journalBoundary();
            retryInstallIdentity = null;
          } else {
            journal('install-persist-error', { sessionId, state: attemptedBoundary,
              generation: identity.generation, retry: 'next-boundary' });
          }
        };
      }
    }
    const persistedRound = durable === null || forked
      ? 0 : readPruneRound(durable, journal, sessionId);
    if (persistedRound > 0) {
      journal('prune-round-resumed', { sessionId, round: persistedRound });
    }
    const entry: RacoonsSessionEntry = { sessionId, engine, adapter, port, ledger, ownedLedger,
      publications, host: host ?? null, pruneRounds: persistedRound,
      pruneTrigger: new PruneWindowTrigger(config.contextWindowTokens,
        config.pruneThresholdTokens),
      windowTokens: config.contextWindowTokens,
      windowProvider: null,
      windowModel: null,
      windowUnresolved: new Set<string>(),
      requestEstimate: null, usageSeen: new Set<string>(), pendingForgets, floorBytes,
      floorProvider: (config.floorBytes === undefined || config.floorBytes === null)
        ? (openingRoute?.provider ?? null) : null,
      floorModel: (config.floorBytes === undefined || config.floorBytes === null)
        ? (openingRoute?.model ?? null) : null,
      billedPromptTokens: null,
      entryJudged: new Set<string>(), entryKept: new Set<string>(),
      // ISSUE-406: the first-ask flag is a claim about THIS session's ask
      // history, so a restart restores it from the same durable file the round
      // and latch ride. A fork starts false: the parent's history is not its.
      entryBatch: { pending: [] }, entryLandedBytes: 0,
      entryAskFired: durable === null || forked
        ? false : readEntryAskFired(durable, journal, sessionId),
      // ISSUE-508: the depth table's first-ask flag rides the same file. A
      // restart keeps the later 40 percent share; a fork starts false.
      tableAskFired: durable === null || forked
        ? false : readTableAskFired(durable, journal, sessionId),
      entryBatchUnit: new Map(),
      resumeRecovery: durable === null
        || (forked
          // ISSUE-478: a re-fork whose own proof names this session resumed, so
          // its own results on the surface are recovered; a first fork has no
          // proof and never replays the parent's inherited work.
          ? forkReborn
          : (priorInstall !== null || installWriteFailed || recoveredFromLedger)),
      installGeneration,
      installBoundary, retryInstallIdentity,
      compactionGeneration: 0, entryWindows: 0, pruneWindows: 0,
      compactionRearmDeferred: false,
      pendingAppends,
      ...(durable === null ? {} : { persistPendingAppends: () => {
        writePendingAppends(durable, durableAppendsOf(pendingAppends), journal, sessionId);
      } }),
      takePublication: () => { const value = latestRequest; latestRequest = null; return value; } };
    // The latch's post-pass state rides the round file (ISSUE-336): a remount
    // restores the baseline the last process left, so the first observation
    // after a restart is not counted as fresh growth past a stale zero. An
    // unreadable or absent state leaves the fresh latch untouched.
    const persistedTrigger = durable === null || forked
      ? null : readPruneTriggerState(durable, journal, sessionId);
    if (persistedTrigger !== null) {
      entry.pruneTrigger.restore(persistedTrigger);
      journal('prune-trigger-resumed', { sessionId, ...persistedTrigger });
    }
    sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * Sync the port's transcript from the live surface (optionally a prefix), then
   * report the ordinals. `completedThroughTurnOrdinal` may be raised by the
   * caller: at `agent/turn-stopping` the current turn is about to end, and the
   * core's `turn-end` at-rest reason exists for exactly that boundary.
   *
   * `surfaceCompletedThroughTurnOrdinal` is the surface's own last `turn/end`,
   * before that override: the host appends `turn/end` only after
   * `agent/turn-stopping`, so the turn is still being assembled there.
   */
  function syncTranscript(entry: RacoonsSessionEntry, session: DshMountSession,
    syncOptions: TranscriptSyncOptions = {}) {
    const callFacts = calls.get(entry.sessionId);
    const synced = surfaceTranscript(session, {
      ...syncOptions.beforeSeq === undefined ? {} : { beforeSeq: syncOptions.beforeSeq },
      sessionId: entry.sessionId,
      ...callFacts === undefined ? {} : { calls: callFacts },
    });
    entry.port.setTranscript(synced.items);
    const completedThrough = syncOptions.completedThroughTurnOrdinal
      ?? synced.completedThroughTurnOrdinal;
    entry.port.updateState({
      currentTurnOrdinal: synced.currentTurnOrdinal,
      currentStepOrdinal: synced.currentStepOrdinal,
      completedThroughTurnOrdinal: completedThrough,
    });
    return { ...synced, completedThroughTurnOrdinal: completedThrough,
      surfaceCompletedThroughTurnOrdinal: synced.completedThroughTurnOrdinal };
  }

  /**
   * Sync the transcript and the ordinals in one call. The mount's engine passes
   * use this wrapper (ISSUE-022 chunk 5): a pass that planned and validated
   * against a transcript older than its ordinals could cut or refuse on stale
   * facts. `syncTranscript` alone stays a transcript/ordinal projection, so a
   * caller that drives its own engine pass keeps using it directly.
   *
   * ADR-0020: there is no protection feed. The automatic protection layer is
   * deleted, so a pass states the transcript and the cache/ordinal facts and
   * nothing else.
   */
  function syncPass(entry: RacoonsSessionEntry, session: DshMountSession,
    syncOptions: TranscriptSyncOptions = {}) {
    return syncTranscript(entry, session, syncOptions);
  }

  /**
   * Record the estimate of the request the next boundary will send, and return
   * it (G8, ISSUE-045 D1; ISSUE-022 chunk 6). It is the number a usage row is
   * reconciled against, and the prune trigger's reading only before the
   * first row has arrived (ISSUE-092: from then on the bar reads the host's
   * own billed prompt, because this estimate sees message text only and read
   * ~0.56 of the host meter on the 078 run).
   *
   * The estimate is the WHOLE request — main's captured system+tools prefix plus
   * the live transcript (ADR-0009 §Amendment 2026-10-24) — and the revision is
   * the port's own, so a reading names the state it belongs to.
   */
  function measureRequest(entry: RacoonsSessionEntry, snapshot: SessionSnapshot,
    prefix: RequestPrefix | null): ContentEstimate {
    const estimate = estimateContent(estimateMeter, snapshot, null, prefix);
    entry.requestEstimate = { revision: snapshot.revision, inputTokens: estimate.totalTokens };
    return estimate;
  }

  /**
   * Feed one step's usage row to the engine (G8, ISSUE-045 D1; PRD §6.9).
   *
   * Three outcomes, each journaled once per host event:
   *
   * - a usable reading → `engine.observe({kind:'usage', …})`, and the mount
   *   journals `usage-reconciled` with the meter's own reading;
   * - no row at all → `usage-missing`, no engine call: a step with no
   *   accounting is a fact, never a zero-token request;
   * - a row the meter would refuse → `usage-missing` with the refusal's own
   *   reason. Reconciliation is the meter's, and a value it rejects must not be
   *   dressed up as a reading it accepted.
   *
   * The estimate the row is measured against is the pre-step reading of the
   * request that produced it (`requestEstimate`), never a fresh estimate
   * computed after the fact: the point of `estimateErrorTokens` is which
   * estimate the provider's count disagrees with. Before any pre-step there is
   * no request this mount measured, so the row is journaled missing rather than
   * reconciled against a guess.
   */
  function observeUsage(session: DshMountSession, event: DshMountEvent): void {
    const requestId = usageRequestId(session.id, event.seq);
    const entry = sessions.get(session.id);
    // A mount that never opened this session's entry has no engine to feed, and
    // a host can emit a message before the first pre-step.
    if (entry === undefined) return;
    // Only append-origin messages are main's own requests; a replacement this
    // package appended (a receipt) carries no usage and must stay silent.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
    if (entry.usageSeen.has(requestId)) return;
    entry.usageSeen.add(requestId);
    const read = readAssistantUsage(event);
    if (read === null) return;
    const measured = entry.requestEstimate;
    if (read.kind !== 'usage') {
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        ...(read.kind === 'invalid' ? { reason: read.reason } : {}) });
      return;
    }
    if (measured === null) {
      // No pre-step has run, so no request this mount measured exists to answer:
      // the reading would be authoritative about a request we never estimated,
      // and the meter's error count would compare two unrelated things. The
      // bar still takes the host's own depth reading (ISSUE-092): it is a valid
      // row, it just has no estimate to be reconciled against.
      entry.billedPromptTokens = read.usage.inputTokens;
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        reason: 'no-request-estimate' });
      return;
    }
    try {
      entry.engine.observe({ kind: 'usage', requestId, revision: measured.revision,
        estimatedInputTokens: measured.inputTokens, usage: read.usage });
    } catch (error) {
      // The meter refuses an inconsistent row (a cached count above input). The
      // engine throws before emitting anything, so nothing was recorded — and
      // the bar does not take a row the meter rejected (ISSUE-092).
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        revision: measured.revision, reason: 'inconsistent-usage',
        message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // ISSUE-092: the accepted row is the bar's reading — the host's billed
    // prompt, whole, cached share included.
    entry.billedPromptTokens = read.usage.inputTokens;
    journal('usage-reconciled', { sessionId: session.id, seq: event.seq, requestId,
      revision: measured.revision,
      estimatedInputTokens: measured.inputTokens,
      inputTokens: read.usage.inputTokens,
      outputTokens: read.usage.outputTokens,
      cachedInputTokens: read.usage.cachedInputTokens });
  }

  /**
   * Observe one host event. Captures a `tool/call`'s facts, queues its
   * `tool/result` for the next pre-step, and feeds a step's usage row to the
   * engine's meter (G8, ISSUE-045 D1). Never appends: the host forbids it
   * inside this callback.
   *
   * Only append-origin results are captured (`surfaceOp === 'append'`), so the
   * mount never re-caps its own replacement.
   *
   * A failed result is captured for the transcript projection but never queued
   * for the entry seam: failure is not a cappable result (S7). The transcript
   * still carries it, so the episode tracker reads `failed: true` and no search
   * episode can call it a miss.
   */
  function observe(session: DshMountSession, event: DshMountEvent): DshToolResultItem | null {
    // ISSUE-474: once `close()` starts, observation must not write. The host's
    // listeners stay attached through dispose, and the shutdown enumerates the
    // observed ids once; a late `tool/call`, `tool/result`, `/cremate` or
    // `session/end` would otherwise re-add an id that was already evicted after
    // the release loop passed it. Mirrors `sessionFor`'s refusal (ISSUE-416).
    if (closing) return null;
    const data = isRecord(event.data) ? event.data : {};
    // A step's authoritative accounting (G8, ISSUE-045 D1; PRD §6.9). The host
    // attaches the model adapter's `usage` row to `assistant/message` and emits
    // no separate usage event, so this callback is the only place a real count
    // is visible. The reading goes to `engine.observe` — never to the estimate
    // lane — and the journal carries one line per request, whether a row
    // arrived (`usage-reconciled`) or not (`usage-missing`).
    if (event.type === 'assistant/message') {
      observeUsage(session, event);
      return null;
    }
    if (event.type === 'tool/call' && typeof data['callId'] === 'string') {
      const list = calls.get(session.id) ?? new Map<string, CallFacts>();
      list.set(data['callId'], { name: data['name'], arguments: data['arguments'] });
      calls.set(session.id, list);
      return null;
    }
    // A turn closed. A `/cremate` command request whose marker that turn
    // claimed but whose pass never ran fails by name here (ISSUE-535), so the
    // card cannot wait on a turn that is already gone. A pass that ran already
    // took and settled its request, so this is a no-op for it.
    if (event.type === 'turn/end' && typeof data['turn'] === 'number') {
      failCremateTurn(session.id, data['turn']);
      return null;
    }
    // The `/cremate` command (ISSUE-022 chunk 5; ADR-0068 adds the registered
    // command). The mount owns this trigger, not the engine's tool union: the
    // pass is mount state read by mount code, and a registered host tool would
    // have to fake an engine event to reach it. A message is observed here (no
    // append) and the pass runs at the next pre-step, which is already the
    // at-rest boundary a prune may use.
    if (event.type === 'user/message') {
      const message = isRecord(data['message']) ? data['message'] : data;
      if (textOf(message['content']).trim() === PRUNE_COMMAND) {
        requestPrune(session.id, event.seq);
      }
      return null;
    }
    // The native-compaction backstop (ISSUE-022 DoD; CRITIC-022 P1-1). The host
    // rewrites the surface on its own, so the latch's growth baseline no longer
    // describes the session: with the flag on, the end of a compaction re-arms
    // exactly as a completed pass does. This mount never suppresses, intercepts
    // or rewrites the host's compaction (owner ruling 2026-10-23, ISSUE-029);
    // the flag only decides whether the observation re-arms our own latch. The
    // observation is journaled either way, so a run shows that it happened.
    //
    // ISSUE-423: `compaction/start` is read too, when the host emits it, because
    // it is the earliest moment an in-flight ask's array is known to be gone.
    // Either phase bumps the compaction generation; an ask/apply window that is
    // open DEFERS the latch re-arm instead of taking it mid-flight, so a
    // compaction during one ask cannot arm a second above-bar ask while that
    // ask's apply runs (ADR-0050's backstop still fires, at the window's end).
    if (event.type === 'compaction/start' || event.type === 'compaction/end') {
      const phase = event.type === 'compaction/start' ? 'start' : 'end';
      const armed = config.nativeCompactionBackstop;
      const entry = sessions.get(session.id);
      let generation: number | null = null;
      let rearmed = false;
      let deferred = false;
      if (entry !== undefined) {
        entry.compactionGeneration += 1;
        generation = entry.compactionGeneration;
        const window = openAskWindow(entry);
        if (window !== null) {
          entry.compactionRearmDeferred = true;
          deferred = true;
          journal('native-compaction-deferred', { sessionId: entry.sessionId,
            seq: event.seq, phase, generation, window, armed });
        } else if (phase === 'end' && armed) {
          // ISSUE-567: the billed prompt names the request the host compacted
          // away. The fresh latch's first reading must describe the surface
          // that is left, so the row is dropped and the boundary falls back to
          // its own estimate of the compacted surface.
          entry.billedPromptTokens = null;
          entry.pruneTrigger.noteNativeCompaction();
          rearmed = true;
          // The re-arm is durable too (ISSUE-336): a restart after a native
          // compaction must not resurrect the pre-compaction baseline.
          const target = targets.get(session.id);
          if (target !== undefined) {
            writePruneRound(target, entry.pruneRounds, journal, entry.sessionId,
              entry.pruneTrigger.snapshot());
          }
        }
      }
      journal('native-compaction', { sessionId: session.id, seq: event.seq,
        phase, generation, armed, rearmed, ...(deferred ? { deferred: true } : {}) });
      return null;
    }
    // The session ended (ISSUE-350, ISSUE-418): its entry, capture and call
    // facts are dead state, but an in-flight boundary may still be reading them
    // — an ask that has not read its seed yet, a later `syncPass` pairing a
    // result with its call facts. So this branch evicts NOTHING: the release
    // path does, after the drain and the flush, once no work can read them.
    // Evicting here would turn a valid seed into a false `no-seed`.
    if (event.type === 'session/end') {
      // The drain+release appends, so it must not run inside this observer:
      // `endSession` yields out of the synchronous dispatch first, and never
      // rejects (every leg fails open), so starting it here is safe.
      void endSession(session);
      return null;
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return null;
    const callId = callIdOf(event);
    // A result with no call id cannot be paired with its call, so the surface
    // projection skips it and the entry seam must not invent an identity.
    if (callId === null) return null;
    const call = calls.get(session.id)?.get(callId) ?? null;
    const item = toolResultItem({
      // One host node, one transcript id: `surfaceTranscript` names a result by
      // its call id, so the entry seam must too. A seq-based id here would make
      // the same node two units the moment the step re-syncs, and a gate would
      // present an id the next snapshot cannot reproduce (ISSUE-024 chunk 2's
      // unit resolution).
      eventId: resultNodeId(session.id, callId),
      event,
      call,
      turnOrdinal: isCount(data['turn']) ? data['turn'] : 0,
      stepOrdinal: isCount(data['step']) ? data['step'] : 0,
    });
    if (item === null) return null;
    if (isRecord(item.hostData) && item.hostData['isError'] === true) {
      journal('skip', { sessionId: session.id, eventId: item.id, callId: item.callId,
        toolName: item.toolName, byteLength: item.bytes.length, reason: 'failed-result' });
      return null;
    }
    const buffer = buffers.get(session.id) ?? [];
    buffer.push({ eventId: item.id, item, seq: event.seq });
    buffers.set(session.id, buffer);
    counters.captured += 1;
    return item;
  }

  /** Observe one request the host dispatched; junk and our own asks are skipped. */
  function observeWire(options: unknown): void {
    // ISSUE-474: a request dispatched while `close()` runs must not re-add an
    // already-released session id to the main-wire store. See `observe`.
    if (closing) return;
    mainWire.note(options);
  }

  /** Drain one captured tool result through the entry seam. */
  async function deliverEntry(entry: RacoonsSessionEntry, capture: Capture): Promise<EngineResult> {
    counters.entries += 1;
    const result = await entry.adapter.onToolResult(capture.eventId, capture.item);
    journal('entry', { sessionId: entry.sessionId, eventId: capture.eventId,
      callId: capture.item.callId, toolName: capture.item.toolName,
      byteLength: capture.item.bytes.length, status: result.status,
      intentId: result.intentId,
      issues: result.validation?.ok === false ? result.validation.issues : [],
    });
    return result;
  }

  /**
   * The result an ask loop may put to the agent (ISSUE-058 chunk P3c-2;
   * ADR-0022 §1, ADR-0025 §1–§2; ADR-0042 Decision 2 for the quote rule).
   *
   * Four facts decide, and each is a reading of the landed capture itself:
   * the body is at or above this session's resolved floor (`entry.floorBytes` —
   * the flat knob or the model's table row; ADR-0020 §Decision 3), the capture
   * is not already settled (`entry.entryJudged`), the body can render the two
   * quotes a tabled row must show (`entryAskTableable`), and — proven by the
   * caller once the unit has minted — the landed result has a unit id to
   * address. Nothing else gates it: no bar, no size ceiling, no re-entry
   * heuristic. A result between the floor and the bar IS asked (the floor is the
   * entry gate, the bar is the bulk-prune gate), and the caller states that
   * consequence rather than inventing a second threshold.
   *
   * A result under the floor or unable to show two quotes is not tabled and
   * lands untouched: no ask, no removal, no journal line, exactly as a
   * sub-floor result has always landed (ADR-0042 Decision 5).
   */
  function entryAskable(entry: RacoonsSessionEntry, capture: Capture): boolean {
    return capture.item.bytes.length >= entry.floorBytes
      && !entry.entryJudged.has(capture.eventId)
      && entryAskTableable(capture.item.bytes);
  }

  /**
   * The retention verdict on one admitted result (ISSUE-519), or `null` when
   * the result may be asked. Only a result the three gates above would table is
   * subject to it: a sub-floor or un-tableable result keeps writing nothing.
   * The capture's own item joins the read when the port has not published it
   * yet, so the candidate is always its own first witness.
   */
  function entryRetentionOf(entry: RacoonsSessionEntry, capture: Capture,
    live: readonly DshTranscriptItem[]): DshRetentionVerdict | null {
    const items = live.some(item => item.id === capture.eventId)
      ? live : [...live, capture.item];
    return dshRetentionOf(capture.eventId, items);
  }

  /**
   * The landed result as a core node. The port already holds the host's own
   * item under this id after `deliverToolResult`, so its transcript is
   * authoritative; the capture is the fallback for a host that delivered
   * without the port holding the item.
   */
  function landedNodeOf(entry: RacoonsSessionEntry, capture: Capture): ToolResultNode | null {
    const items = entry.port.transcript();
    const index = items.findIndex(item => item.id === capture.eventId);
    if (index >= 0) {
      const item = items[index];
      if (item === undefined) return null;
      return toCoreEnvelope(item, index).node as ToolResultNode;
    }
    const direct = toCoreEnvelope(capture.item, items.length).node;
    return direct.kind === 'tool-result' ? direct : null;
  }

  /**
   * The same read with NO capture fallback (ISSUE-188): what the live transcript
   * holds under this result's id at this instant. A held row was addressable
   * when it landed (`landedUnitIdOf` proved the port held it), so its absence
   * here means the host or the prune took it away — a stale row, never a reason
   * to describe the landing copy as current.
   */
  function liveTranscriptNodeOf(entry: RacoonsSessionEntry, capture: Capture): ToolResultNode | null {
    const items = entry.port.transcript();
    const index = items.findIndex(item => item.id === capture.eventId);
    const item = index < 0 ? undefined : items[index];
    if (item === undefined) return null;
    const node = toCoreEnvelope(item, index).node;
    return node.kind === 'tool-result' ? node : null;
  }

  /**
   * The live surface projected into the seed shape — every live node, or the
   * nodes up to one result and no further (ISSUE-058 chunk P3d; ISSUE-553).
   *
   * Why a request capture is not enough: a capture holds a REQUEST, and the
   * assistant turn that made a tool call is a provider RESPONSE, not something
   * any request carries until the following step. So after a session's first
   * tool call, main's next dispatched request already ends with the prior
   * `tool` turn, and appending this result to that capture would put two `tool`
   * turns in a row — the fork's `role-conflict`, which the entry lane reported
   * as a silent fail-open `no-seed` (P3c-2's live observation).
   *
   * A capture is also STALE after the product removes bytes: a turn-end
   * `forget` replaces surface nodes after that turn's last main request was
   * captured, so a fork from the capture would replay bytes the product already
   * took away. The prune lane therefore projects the WHOLE surface
   * (`stopNodeId === null`) as it stands when the ask is built, receipt and all
   * (ISSUE-553).
   *
   * Why the CUT matters where there is one: a step may land several results
   * (parallel tool calls) and the asks for them run one after another against
   * the surface as it stands at the END of the step. The ask is about the
   * result immediately above it (ADR-0022 §4), so an ask for all but the last
   * would otherwise sit under a LATER result. Cutting after this result's own
   * node gives every ask the wire state the host held when that result landed.
   *
   * It is not a second renderer: the surface nodes are re-wrapped in the host's
   * request-message shape and handed to `captureMainRequest`, the one projection
   * this package uses for a seed — the same role filter, the same text joining
   * and the same `[tool call <name> <args>]` rendering, so a surface seed and a
   * captured seed can never disagree about a shared turn.
   *
   * `system`, `tools` and the route come from the capture when one exists: they
   * are the request's fixed prefix, and the surface carries the prompt as a
   * leading `system/message` (the loop's `in-history` shape), which the
   * projection keeps where main put it. With no capture — a restarted mount has
   * observed no main request, because the session's earlier turns belong to the
   * previous process — the prefix comes from the host's logged request header
   * instead (`hostSeedPrefix`, ISSUE-606); when the host cannot supply it this
   * returns null and the caller keeps its fail-open `no-seed`.
   *
   * Returns null when the surface never reaches `stopNodeId` (a prefix that
   * cannot name its own end is not a seed for that result), yields no message at
   * all, holds a node the session holds no event for, or holds a `tool/result`
   * with no call id: an unprojectable surface is `no-seed`, never a partial
   * guess. A node type the seed does not carry (a compaction marker, a
   * `tool/call`, a turn edge) is skipped by name; only a node whose reply would
   * go missing refuses the whole projection.
   */
  function surfaceWire(session: DshMountSession, sessionId: string,
    stopNodeId: string | null,
  ): CapturedMainRequest | null {
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
    const captured = mainWire.last(sessionId);
    const prefix: SeedPrefix | null = captured !== null
      ? { system: captured.wire.system, tools: captured.wire.tools }
      : hostSeedPrefix(session, sessionId, nodes);
    if (prefix === null) return null;
    const messages: unknown[] = [];
    let reached = false;
    for (const seq of nodes) {
      const event = session.eventAt?.(seq);
      // A node with no event is a surface this projection cannot reach for
      // certain; the whole surface is no seed rather than a seed missing a turn.
      if (event === undefined) return null;
      const data = isRecord(event.data) ? event.data : {};
      if (event.type === 'tool/result') {
        const callId = callIdOf(event);
        // A result with no call id cannot be paired with its call, so dropping
        // it would leave an assistant tool-call with no reply — a partial seed.
        // `observe` already refuses to give such a result an identity above;
        // here the whole surface is no seed rather than a fork missing a turn.
        if (callId === null) return null;
        const message = isRecord(data['message']) ? data['message'] : {};
        messages.push({ role: 'tool', toolCallId: callId, content: message['content'] });
        if (stopNodeId !== null && resultNodeId(sessionId, callId) === stopNodeId) {
          reached = true;
          break;
        }
        continue;
      }
      const role = event.type === 'user/message' ? 'user'
        : event.type === 'assistant/message' ? 'assistant'
          : event.type === 'system/message' ? 'system'
            : event.type === 'developer/message' ? 'developer' : null;
      if (role === null) continue;
      const message = role === 'user' ? data : isRecord(data['message']) ? data['message'] : {};
      messages.push({ role, content: message['content'] });
    }
    if (stopNodeId !== null && !reached) return null;
    if (messages.length === 0) return null;
    return captureMainRequest({ sessionId, system: prefix.system,
      tools: prefix.tools, messages,
      ...(captured === null || captured.provider === null ? {} : { provider: captured.provider }),
      ...(captured === null || captured.model === null ? {} : { model: captured.model }) });
  }

  /**
   * The seed's fixed prefix from the host's own log when no main request has
   * been observed yet (ISSUE-606).
   *
   * Why a capture can be missing over a healthy surface: after a restart the
   * session's earlier turns were dispatched by the PREVIOUS process, so this
   * mount's `llm/stream` observer has seen nothing, and the first request of the
   * new process is the one that will carry the answer to this ask — a request
   * cannot seed itself. The host logs the prefix durably anyway: every request
   * appends its `request/header` (the call `config` plus the assembled tool
   * schemas), and `Session.requestHeader()` returns the latest one
   * (`@deepseek-ai/dsh-session` `lib/types/index.d.ts:311`; `EpochHeader` in
   * `lib/types/types.d.ts:223`) — the same read this mount already trusts for
   * the ask route (`./route.ts`).
   *
   * The system prompt is not in that header by design (`system?: never`): the
   * host carries it as the surface's node 0, a `system/message` event, which the
   * projection keeps where the host put it. So the prompt is checked for
   * presence and never guessed, and the system slot stays `''` — exactly what a
   * captured loop-built request states, because a loop-built request leaves the
   * slot undefined and the prompt is the leading message.
   *
   * No prompt node, no header, no tools, a tool entry that is not a named schema
   * (a blank name or a non-record is not a tool; a partial list is not a tool
   * list), or a throw from the host read: null, one `seed-prefix` line naming
   * the reason, and the caller keeps its named `no-seed`.
   */
  function hostSeedPrefix(session: DshMountSession, sessionId: string,
    nodes: readonly number[],
  ): SeedPrefix | null {
    const refuse = (reason: string): null => {
      journal('seed-prefix', { sessionId, source: 'request-header', reason });
      return null;
    };
    const head = nodes[0];
    const first = head === undefined ? undefined : session.eventAt?.(head);
    // A seed whose surface carries no prompt would be a conversation with no
    // system turn; refuse by name instead of shipping it.
    if (first === undefined || first.type !== 'system/message') {
      return refuse('no-system-prompt');
    }
    let header: unknown;
    try {
      header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
    } catch (error) {
      return refuse(`header-threw: ${messageOf(error)}`);
    }
    // No header at all (an old or fake host) is a different absence from a
    // header that states no tools: name each one.
    if (!isRecord(header)) return refuse('no-header');
    const tools = Array.isArray(header['tools']) ? header['tools'] : null;
    if (tools === null || tools.length === 0) return refuse('no-tools');
    if (!tools.every(tool => isRecord(tool) && typeof tool['name'] === 'string'
      && tool['name'].trim() !== '')) {
      return refuse('malformed-tools');
    }
    journal('seed-prefix', { sessionId, source: 'request-header', tools: tools.length });
    return { system: '', tools };
  }

  /** The surface wire as a request, for the entry/landing lane's `surface` slot. */
  function postLandingWire(session: DshMountSession, sessionId: string,
    stopNodeId: string,
  ): WireRequest | null {
    return surfaceWire(session, sessionId, stopNodeId)?.wire ?? null;
  }

  /**
   * The ask exchange's turns as ONE host append each (ISSUE-058 chunk P3c-2;
   * ADR-0022 §3, §6, §11). Both are NEW nodes — an append, never an edit — and
   * they are NOT published to the port as a core application: the question is
   * not a removal, and the answer only reaches the engine through
   * `onEntryAnswer`.
   *
   * BOTH rows go out as `user/message` (ISSUE-074, scheme A, leader ruling
   * 2026-10-27). The answer row was an `assistant/message` once; that shape
   * cannot survive a stored-session replay. dsh's replay validator calls
   * `requireOpenStep` on EVERY `assistant/message`, and at these two append
   * seams — `agent/pre-step` (before the host's `step/start`) and
   * `agent/turn-stopping` (after `step/end`) — no step is open. Stamping a
   * turn/step pair was measured and every candidate fails; a `user/message`
   * has no step relationship at all, so the answer is stored as a user turn
   * and the log resumes (`restoreReleasedV4Artifact` and a real dsh resume,
   * ISSUE-074). The exchange is still rewound by both applies, so no
   * model-facing turn reads the answer; a FAILED apply leaves question and
   * answer as two user turns, which is visible where the old shape left a
   * corrupt log.
   *
   * The node ids the caller records come from the host events these appends
   * return, so a rewind names the surface's own ids and never a mount-invented
   * one: `surfaceTranscript` names a message `dsh:<session>:message:<seq>`, and
   * `mount-revert.ts` repeats that formula, so both agree.
   */
  function appendAskTurns(entry: RacoonsSessionEntry, session: DshMountSession,
    turns: readonly EntryAskTurn[]): readonly DshMountEvent[] | null {
    const events: DshMountEvent[] = [];
    try {
      for (const turn of turns) {
        events.push(session.append('user/message', {
          content: [{ type: 'text', text: turn.text }],
          source: { kind: `${config.recordName}/entry-ask` },
          role: 'user',
          id: randomUUID(),
        }, { surfaceOp: 'append' }));
      }
      return events;
    } catch (error) {
      // ISSUE-403: a partial append is not the same state as "appended, then
      // apply failed". The turns already written are a question the user never
      // asked, so collapse that prefix NOW instead of waiting for cold recovery.
      const message = messageOf(error);
      const first = events[0], last = events[events.length - 1];
      const collapse = first === undefined || last === undefined ? null
        : entry.port.rewindAskExchange({ resultNodeId: '',
          askNodeId: messageNodeId(entry.sessionId, first.seq),
          answerNodeId: messageNodeId(entry.sessionId, last.seq), summary: '' });
      if (collapse !== null) {
        // The collapse is the mount's write, never a row's apply.
        entry.port.takeEntryWrite();
      }
      // ISSUE-479: a throwing append leaves the write outcome UNKNOWN. The
      // throwing turn may have landed even though no event was returned, so the
      // collapsed range built from the returned events cannot prove the
      // exchange left the surface — and with zero events there is no range at
      // all. Keep the exchange owed on every throw so the next boundary's
      // surface scan collapses whatever `entry-ask` turns actually landed
      // (ISSUE-403, ISSUE-463).
      entry.resumeRecovery = true;
      journal('entry-ask-append-failed', { sessionId: entry.sessionId,
        appended: events.length, message,
        ...(collapse === null ? {} : { collapse: collapse.status }),
        ...(collapse !== null && collapse.status === 'refused' ? { code: collapse.code } : {}) });
      return null;
    }
  }

  /**
   * The mount-side id of an appended message node: the same formula
   * `surfaceTranscript` and `mount-revert.ts` use, so the exchange the port
   * rewinds later names the nodes the surface actually holds.
   */
  function messageNodeId(sessionId: string, seq: number): string {
    return `dsh:${sessionId}:message:${String(seq)}`;
  }

  /**
   * One answered exchange, applied (ISSUE-058 chunk P3c-2; ADR-0022 §11–§14).
   *
   * The exchange is recorded under the ANSWERED event id (never the
   * observation's: the engine answers one event id once, so reusing it would
   * make the answer a replay), then `onEntryAnswer` decides the surface write:
   * `rewound` for a keep-all, `landed` for a forget, `fail-open` when core
   * refused the answer or the host write refused. The journal carries the
   * outcome with BOTH host seqs P3a's two-append design produces — the exchange
   * rewind's seq first, then (a forget only) the shaped result turn's seq.
   *
   * The seqs are read off the host, never derived from a count this mount
   * keeps: dsh's `seq === log.length` (`revert.ts`, `nextSeq`), so the appends
   * one apply makes are exactly `surfaceBefore, surfaceBefore + 1, …`. A
   * `port` outcome naming another seq would disagree with the log, which is a
   * host fact a test can pin.
   *
   * The return also states whether the host surface actually moved. A fail-open
   * apply that planned nothing appends nothing (`appends: 0`), so the exchange is
   * still on the surface and the batch must collapse it (ISSUE-215); a write that
   * landed is the fact that takes the collapse away (`movedSurface`).
   */
  async function applyEntryAnswer(entry: RacoonsSessionEntry, session: DshMountSession,
    capture: Capture, node: ToolResultNode, exchange: DshAskExchange, answerEventId: string,
    answer: EntryAnswer, answerText: string,
  ): Promise<{ readonly outcome: DshEntryAnswerOutcome; readonly movedSurface: boolean }> {
    const surfaceBefore = typeof session.seq === 'number' ? session.seq : null;
    let outcome: DshEntryAnswerOutcome;
    try {
      outcome = await entry.adapter.onEntryAnswer(answerEventId, node, exchange, answer, answerText);
    } catch (error) {
      // An answer that throws is a host-side defect, never a claim about the
      // content: the result stands whole and the journal names the failure.
      // The apply may still have committed its host write before the engine
      // threw (ISSUE-340): consume this event's slot so the next row reads its
      // OWN outcome, and let the host's own seq delta decide `movedSurface` —
      // a committed move took the exchange off the surface even though the
      // engine faulted afterwards, so later batch rows keep `rewound: true`.
      const write = entry.port.takeEntryWrite();
      const surfaceAfter = typeof session.seq === 'number' ? session.seq : null;
      const appends = surfaceBefore === null || surfaceAfter === null ? null : surfaceAfter - surfaceBefore;
      journal('entry-apply-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
        answerEventId, status: 'fail-open', code: 'host-error',
        message: error instanceof Error ? error.message : String(error) });
      return { outcome: { status: 'fail-open', engine: UNCHANGED_ENGINE_RESULT, refusal: null },
        movedSurface: appends === null ? write?.status === 'applied' : appends > 0 };
    }
    // Only an applied answer settles the result (ADR-0025 §4–§5): a keep-all
    // rewinds the exchange, a forget lands one shaped turn, and both mean the
    // agent decided this content. A refusal applied nothing and settles
    // nothing, so a repeated delivery may ask once more.
    if (outcome.status !== 'fail-open') {
      entry.entryJudged.add(capture.eventId);
      // Only an APPLIED keep-all settles the unit as kept content (ISSUE-073):
      // that is the one answer that leaves the result standing whole and says
      // the agent decided it stays. Any forget replaced it with a shaped turn.
      if (answer.action === 'keepall') entry.entryKept.add(capture.eventId);
    }
    const write = entry.port.takeEntryWrite();
    const surfaceAfter = typeof session.seq === 'number' ? session.seq : null;
    const appends = surfaceBefore === null || surfaceAfter === null ? null : surfaceAfter - surfaceBefore;
    // The first append one apply makes is the exchange's rewind (§11), and a
    // forget's second is the shaped result turn (§12). A keep-all makes only
    // the first, so it names no result seq at all.
    const exchangeSeq = appends !== null && appends > 0 && surfaceBefore !== null ? surfaceBefore
      : write?.status === 'applied' ? write.seq : null;
    const resultSeq = appends !== null && appends > 1 && surfaceBefore !== null
      ? surfaceBefore + 1 : null;
    journal('entry-apply', { sessionId: entry.sessionId, eventId: capture.eventId,
      answerEventId, status: outcome.status, action: answer.action,
      resultNodeId: exchange.resultNodeId, askNodeId: exchange.askNodeId,
      answerNodeId: exchange.answerNodeId,
      exchangeSeq, resultSeq, appends,
      ...write === null ? {} : { writeStatus: write.status },
      ...write !== null && 'code' in write ? { code: write.code } : {},
      engineStatus: outcome.engine.status, intentId: outcome.engine.intentId,
    });
    if (outcome.engine.status === 'applied') {
      // ISSUE-436: the engine wrote its `applied` row, so the crash-window copy
      // of this receipt has no further reader.
      collectSettledReceipt(entry, outcome.engine.intentId);
    }
    if (outcome.status === 'fail-open') {
      // A host write that MOVED while the engine could not record it is
      // recovery-pending, not "core planned nothing" (ISSUE-430): `recordApplied`
      // failing after the write lands leaves the receipt unproved, so the next
      // pass must reconcile before it applies again. The moved surface is read
      // from the host's own seq delta (`appends`): the adapter consumes the
      // write slot on a non-applied engine result, so the delta is the evidence
      // that survives. Name that true cause.
      const hostMoved = appends !== null ? appends > 0 : write?.status === 'applied';
      const movedUnrecorded = outcome.engine.status === 'recovery-pending' && hostMoved;
      journal('entry-apply-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
        answerEventId, status: 'fail-open',
        code: outcome.refusal?.code ?? null,
        detail: outcome.refusal?.detail ?? (movedUnrecorded
          ? 'the host write moved but its applied record could not be written; recovery-pending'
          : 'core planned nothing to apply'),
        engineStatus: outcome.engine.status });
    }
    // The surface moved exactly when the host appended: `appends` is the host's
    // own seq delta, the same number the journal line carries. A fail-open that
    // planned nothing appends 0, so the exchange is still on the surface and the
    // batch's collapse must run (ISSUE-215). Without a numeric seq the write
    // outcome is the only host fact there is; `unknown` counts as no move, and
    // the collapse then refuses by name rather than writing over a gone range.
    return { outcome, movedSurface: appends === null ? write?.status === 'applied' : appends > 0 };
  }

  /**
   * The cadence's verdict for one newly eligible result (ISSUE-128): `hold` it,
   * or `fire` the batch it completes. `count` is the explicit compatibility
   * cadence: `batchVerdict` over `entryAskBatchSize`, byte for byte as before;
   * the accumulator is not fed and stays where it is. `landed-bytes` feeds each
   * result's OWN decoded byte length to `landedBytesTriggerVerdict` — the sim's
   * rule — and journals nothing itself. `off` never reaches this function: the
   * ask loop returns before it decides anything (ADR-0050 decision 4).
   */
  function entryTriggerFor(entry: RacoonsSessionEntry, capture: Capture,
    trigger: Exclude<ResolvedEntryAskTrigger, { readonly mode: 'off' }>):
    | { readonly kind: 'hold'; readonly pending: readonly string[]; readonly landedBytes: number }
    | { readonly kind: 'fire'; readonly batch: readonly string[]; readonly landedBytes: number } {
    if (trigger.mode === 'count') {
      const verdict = batchVerdict(entry.entryBatch, config.entryAskBatchSize, capture.eventId);
      return verdict.kind === 'hold'
        ? { kind: 'hold', pending: verdict.state.pending, landedBytes: entry.entryLandedBytes }
        : { kind: 'fire', batch: verdict.batch, landedBytes: entry.entryLandedBytes };
    }
    const verdict = landedBytesTriggerVerdict(
      { pending: entry.entryBatch.pending, landedBytes: entry.entryLandedBytes },
      trigger.bytes,
      // The result's own decoded bytes as they land — never the rendered drop and
      // never a measured depth (`sim-batch-units.mjs:704-709`).
      { id: capture.eventId, bytes: capture.item.bytes.length });
    return verdict.kind === 'hold'
      ? { kind: 'hold', pending: verdict.state.pending, landedBytes: verdict.state.landedBytes }
      : { kind: 'fire', batch: verdict.batch, landedBytes: verdict.state.landedBytes };
  }

  /**
   * The entry checkpoint's ask loop for one step (ISSUE-058 chunk P3c-2;
   * ADR-0022 §1–§6, §11–§14; ADR-0025 §Decision 1; batched per ADR-0035 §1–§6).
   *
   * It runs inside `runStep`, AFTER every queued result has landed and BEFORE
   * the at-rest pass and the prune see the step: the checkpoint unit is asked
   * once before any later seam can name it, which is what keeps the two ask
   * moments disjoint by construction (ADR-0028). Never a re-ask of a settled one.
   *
   * Two cadences, one loop. At the shipped `entryAskBatchSize: 1` (or absent)
   * `batchVerdict` fires on every call with a one-row batch, whose message is
   * `entryAskMessage` byte for byte — so the default path is today's ask stream
   * exactly. Above 1 an eligible result is held: `entry-ask-hold` names it and
   * its capture/node/unit wait in `entryBatchUnit`; the fire that completes the
   * batch sends ONE index-keyed ask over the LAST held row's surface, then
   * applies every answered row through the existing entry seam, the first
   * rewinding the exchange and every later one marking `rewound: true`.
   *
   * ISSUE-128 adds the second cadence beside the count: `landed-bytes` holds
   * until the eligible results' own bytes landed since the last fire reach the
   * configured threshold, then fires the WHOLE pending stream. Eligibility is
   * unchanged — the product floor and not-error, exactly as the count path — and
   * so are the fire's rows, its one message and its per-row applies.
   *
   * ADR-0050 decision 4 adds `off`, the product configuration: every eligible
   * result is journaled `entry-ask-off` with reason `configured-off`, and no ask
   * is sent. The branch returns before the loop and touches no batch state, so
   * the entry seam stays available for manual or compatibility use.
   *
   * The seed for a fire is `postLandingWire` at the LAST row's node: that wire
   * already holds every earlier row of the batch, and the last row is the turn
   * the ask must sit under (ADR-0022 §4).
   *
   * Fail-open is the loop's shape, not an arm: the breaker is never touched
   * here (an ask failure is not a completed-validation refusal), and every
   * early exit journals ONE line naming why the seam did nothing.
   */
  async function runEntryAsks(entry: RacoonsSessionEntry, session: DshMountSession,
    captures: readonly Capture[], signal?: AbortSignal): Promise<void> {
    const trigger = config.entryAskTrigger;
    // One live read for the whole step: the retention rules witness against the
    // surface as it stands, not the landing copies (ISSUE-519).
    const live = entry.port.transcript();
    if (trigger.mode === 'off') {
      // ADR-0050 decision 4: the product configuration. Each result the entry
      // gate WOULD have asked about gets one line saying why it was not asked;
      // a non-askable result writes nothing, exactly as a sub-floor result has
      // always landed silently. A result a retention rule keeps names that rule,
      // which is the more specific reason it is not asked (ISSUE-519). The loop
      // has not started, so no pending row and no landed-bytes accumulator is
      // read or written.
      for (const capture of captures) {
        if (!entryAskable(entry, capture)) continue;
        const retention = entryRetentionOf(entry, capture, live);
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: retention?.code ?? 'configured-off',
          ...(retention === null ? {} : { containedInNodeId: retention.containedInNodeId }) });
      }
      return;
    }
    const llm = options.llm;
    const route = resolveRoute(entry.host ?? session);
    // One ledger-health reading for the whole step (ISSUE-440; ISSUE-426): the
    // same three-way read the prune lane uses before its paid send. A disabled
    // breaker is machinery health, an unreadable ledger says nothing about it,
    // and an unfinished `prepared` intent means core's next pass would answer
    // `recovery-pending` and apply nothing — so a paid ask cannot land.
    const standdown = await ledgerStanddown(entry);
    for (const capture of captures) {
      if (!entryAskable(entry, capture)) continue;
      // ISSUE-519: a result the retention rules keep is never offered. It lands
      // whole and the line names the marker, ahead of the seam conditions that
      // would otherwise describe a removal nobody may make.
      const retention = entryRetentionOf(entry, capture, live);
      if (retention !== null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: retention.code, containedInNodeId: retention.containedInNodeId });
        continue;
      }
      if (llm === undefined) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'no-llm-service' });
        continue;
      }
      if (route === null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          // The prune lane names the same condition `not-configured` (ISSUE-427):
          // one journal name for one absent route, in both lanes.
          reason: 'not-configured' });
        continue;
      }
      if (standdown !== null) {
        // `ledger-unavailable`, `recovery-pending` and `breaker-open` are the
        // same names the prune lane journals; one condition, one name.
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: standdown });
        continue;
      }
      const node = landedNodeOf(entry, capture);
      // The unit is the address the answer's apply needs (`landedUnitId` mints
      // it at bar 0, exactly as the guard re-derives it). No unit means no
      // addressable landed result, so there is nothing to ask about.
      const unitId = landedUnitIdOf(entry, node);
      if (node === null || unitId === null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'unit-absent' });
        continue;
      }
      // The trigger (ISSUE-117 chunk B1; the cadence by mode per ISSUE-128):
      // hold this result, or fire the batch it completes. `batchSize <= 1` (or
      // a landed-bytes crossing) fires at once with this landing included.
      const verdict = entryTriggerFor(entry, capture, trigger);
      if (verdict.kind === 'hold') {
        entry.entryBatch = { pending: verdict.pending };
        entry.entryLandedBytes = verdict.landedBytes;
        entry.entryBatchUnit.set(capture.eventId, { capture, node, unitId });
        journal('entry-ask-hold', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, unitId, byteLength: capture.item.bytes.length,
          pending: verdict.pending.length,
          // The count path names the size it counts, byte for byte as before; the
          // landed-bytes path names the accumulator, because a count is not what
          // held this result.
          ...(config.entryAskTrigger?.mode === 'landed-bytes'
            ? { landedBytes: verdict.landedBytes }
            : { batchSize: config.entryAskBatchSize }) });
        continue;
      }
      entry.entryBatch = { pending: [] };
      entry.entryLandedBytes = verdict.landedBytes;
      // The fired batch's rows, in arrival order: the held ones plus this one.
      const rows: { readonly capture: Capture; readonly node: ToolResultNode;
        readonly unitId: UnitId }[] = [];
      for (const id of verdict.batch) {
        const held = entry.entryBatchUnit.get(id);
        if (held !== undefined) { rows.push(held); entry.entryBatchUnit.delete(id); continue; }
        if (id === capture.eventId) rows.push({ capture, node, unitId });
      }
      if (rows.length === 0) continue;
      await askBatch(entry, session, rows, llm, route, signal);
    }
  }

  /**
   * The bracket label a batch row shows: the host's tool name and the target it
   * named (`Read config.ts`), read from the capture's own facts and never from
   * the result's text (ISSUE-117 chunk B3). A result with no facts still renders
   * a row: the label is the host tool name, or `tool result` when even that is
   * absent, so no row ships an empty bracket.
   */
  function callLabelOf(capture: Capture): string {
    const name = capture.item.toolName.trim();
    const target = capture.item.target?.key ?? null;
    if (name === '') return target === null ? 'tool result' : `tool result ${target}`;
    return target === null || target === '' ? name : `${name} ${target}`;
  }

  /**
   * ONE batched ask over a fired batch's rows, then one apply per answered row
   * (ISSUE-117 chunk B3; ADR-0035 §4–§5).
   *
   * A one-row batch delegates the message to `entryAskMessage` inside core, so
   * it sends today's bytes; this function's journal rows are the same kinds and
   * fields as before, which is the default-off gate's other half.
   *
   * Every row is RE-READ from the live transcript at the moment the ask fires
   * (ISSUE-188), never taken from the copy frozen when it landed. A held row can
   * be changed by our own bulk prune, a host trim or a dedupe pass between those
   * two moments, and a table built from the landing copy would describe bytes
   * that no longer exist — the apply would then be refused `source-hash-
   * mismatch` and count against the breaker for a defect in our reading, not
   * the answer. A row whose live unit id or content hash differs from the
   * landing copy is dropped with `entry-ask-row-stale`; the rows that survive
   * are numbered from 1 and asked in their own current bytes.
   *
   * The apply re-reads the row once more. If its bytes moved between the ask
   * and this check, the answer names content that no longer exists; the row is
   * refused locally (`entry-apply-refused`, code `ask-row-stale`) and never
   * reaches the engine, so no validation row exists for the breaker to count
   * and the guard's own arithmetic is untouched.
   */
  async function askBatchCore(entry: RacoonsSessionEntry, session: DshMountSession,
    rows: readonly { readonly capture: Capture; readonly node: ToolResultNode;
      readonly unitId: UnitId }[],
    llm: DshLlmService, route: JudgeRoute,
    signal?: AbortSignal,
  ): Promise<void> {
    if (rows.length === 0) return;
    // The live rows the ask describes: a fresh read per row, never the landing
    // copy. A row the transcript no longer holds, or one whose bytes or unit
    // changed, is dropped by name and answers nothing.
    const live: { readonly capture: Capture; readonly node: ToolResultNode;
      readonly unitId: UnitId }[] = [];
    // ISSUE-519: the retention rules are re-read at the fire, not only at
    // admission. A result that landed after this row can already carry its text,
    // and an ask about it would offer a removal that frees nothing.
    const liveItems = entry.port.transcript();
    for (const [position, row] of rows.entries()) {
      const node = liveTranscriptNodeOf(entry, row.capture);
      if (node === null) {
        journal('entry-ask-row-stale', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, unitId: row.unitId, rowIndex: position + 1,
          batchSize: rows.length, changed: 'absent' });
        continue;
      }
      const unitId = landedUnitIdOf(entry, node);
      const hashChanged = node.sha256 !== row.node.sha256;
      const unitChanged = unitId === null || unitId !== row.unitId;
      if (hashChanged || unitChanged) {
        journal('entry-ask-row-stale', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, rowIndex: position + 1, batchSize: rows.length,
          changed: hashChanged && unitChanged ? 'unit+hash' : hashChanged ? 'hash' : 'unit',
          landedSha256: row.node.sha256, liveSha256: node.sha256,
          landedUnitId: row.unitId, liveUnitId: unitId });
        continue;
      }
      // The live bytes must still carry the two quotes a tabled row shows
      // (ADR-0042 Decision 5). A row that no longer can is dropped rather than
      // tabled bare: it keeps its unit whole, and the remaining rows are
      // numbered from 1 by the caller's own positions.
      if (!entryAskTableable(node.bytes)) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, unitId, byteLength: node.bytes.length,
          rowIndex: position + 1, batchSize: rows.length, reason: 'no-quotes' });
        continue;
      }
      const retention = entryRetentionOf(entry, row.capture, liveItems);
      if (retention !== null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, unitId, byteLength: node.bytes.length,
          rowIndex: position + 1, batchSize: rows.length, reason: retention.code,
          containedInNodeId: retention.containedInNodeId });
        continue;
      }
      live.push({ capture: row.capture, node, unitId });
    }
    // Nothing survives: no request leaves, no exchange is appended and every
    // dropped row's unit stays landed whole (ADR-0022 §14).
    if (live.length === 0) return;
    // ISSUE-423: the ask is stamped with the compaction generation it was built
    // under. A compaction observed while it runs bumps the generation, and the
    // apply below then refuses by name instead of recording a receipt for an
    // array the host rewrote.
    const askGeneration = entry.compactionGeneration;
    // ISSUE-548: the host's own counters, snapshotted at the same moment. They
    // catch a surface rewrite that never emitted `compaction/start|end`.
    const askSurface = surfaceStampOf(session);
    // ISSUE-422: a forked/inherited session's first step can land a result
    // before the child's own main request is captured (the parent's request is
    // not this session's seed). Refusing `no-seed` there is a false refusal:
    // the mount has no capture YET, not no possible seed. Name the missing
    // capture instead; the result keeps its unit whole and a later pass may
    // table it.
    if (mainWire.last(entry.sessionId) === null
      && (entry.installBoundary === 'inherited' || entry.installBoundary === 'fork')) {
      for (const row of live) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, unitId: row.unitId,
          byteLength: row.capture.item.bytes.length,
          reason: 'inherited-no-capture', installBoundary: entry.installBoundary });
      }
      return;
    }
    const last = live[live.length - 1];
    if (last === undefined) return;
    // ISSUE-432: the capture records the route it was dispatched under. A
    // mid-session model switch makes that prefix belong to the old model, so
    // it is invalidated by name rather than served silently. A capture that
    // states no route (an older host) stays usable: absence is not evidence.
    const captured = mainWire.last(entry.sessionId);
    let seed = captured?.wire ?? null;
    // ISSUE-432 / ISSUE-470: one staleness rule for both ask lanes.
    if (captured !== null && seedRouteStale(captured, route)) {
      journal('seed-model-stale', { sessionId: entry.sessionId,
        seedProvider: captured.provider, seedModel: captured.model,
        routeProvider: route?.provider ?? null, routeModel: route?.model ?? null,
        action: 'seed-invalidated' });
      seed = null;
    }
    // The ask sits under the LAST SURVIVING row's turn, so a dropped tail never
    // leaves the question above a result the table does not describe.
    const surface = postLandingWire(session, entry.sessionId, last.node.id);
    // The call label rides the row's bracket slot, from the host's own tool facts.
    const batch = live.map((row, position) => ({
      index: position + 1,
      call: callLabelOf(row.capture),
      resultBytes: row.node.bytes,
      resultNodeId: row.capture.eventId,
    }));
    // The flag this ask states (ISSUE-194): the session's first ask of either
    // shape ships the 70 percent share line, every later one 40 percent. The
    // flag moves only when a request actually left — an ask refused before any
    // send (no row left tabled, no seed) leaves the session's first trigger
    // still ahead of it, and a route-off ask never reaches this function.
    const firstTrigger = !entry.entryAskFired;
    // The ask rides the native status card (ISSUE-372; ISSUE-404): the card is
    // opened before the send, but it settles only after the append/apply leg
    // with the whole pass's outcome — never with the ask's alone, because an
    // answered ask whose apply failed did not actually remove anything.
    const card = openAskCard(session);
    // ISSUE-461: the card settles exactly once on every path, in the `finally`
    // below, mirroring the prune pass. An unsettled pass is an error, never a
    // success, and a throw from the append/apply leg still closes the card.
    let cardText: { kind: 'success' | 'error'; text: string } =
      { kind: 'error', text: 'the entry ask did not settle' };
    try {
      const outcome = await askEntryBatch({ rows: batch, seed, surface, llm, route,
        grammar: config.entryAskGrammar, firstTrigger,
        // ISSUE-405: the configured judge deadline reaches the entry ask, and
        // the host's own pre-step signal preempts a cancelled turn. `0` is the
        // documented deadline-off switch, so the same contract the prune ask
        // already reads applies here byte for byte.
        timeoutMs: config.judgeTimeoutMs,
        ...(signal === undefined ? {} : { signal }) });
      const left = outcome.status === 'answered'
        || (outcome.status === 'refused' && outcome.turns.length > 0);
      if (left) {
        entry.entryAskFired = true;
        // ISSUE-406: persist the flag on the first answered/refused-with-turns ask,
        // so a restart does not repeat the 70 percent first-ask share line. The
        // write is fail-open: the in-memory flag still serves this process.
        const target = targets.get(entry.sessionId);
        if (target !== undefined) writeEntryAskFired(target, true, journal, entry.sessionId);
      }
      if (outcome.status === 'off') {
        // No request left the seam, so the card must not read as a completed ask.
        cardText = { kind: 'success', text: 'entry ask off; no ask was sent' };
        for (const row of live) {
          journal('entry-ask-off', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, byteLength: row.capture.item.bytes.length,
            reason: 'not-configured' });
        }
        return;
      }
      if (outcome.status === 'refused') {
        cardText = { kind: 'error', text: `entry ask refused: ${outcome.code}` };
        // Fail-open: every result is already landed whole, so nothing is appended
        // and nothing is marked. One line per row names the same code.
        for (const row of live) {
          journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, unitId: row.unitId, code: outcome.code,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            ...(outcome.raw === undefined
              ? {}
              : { raw: outcome.raw.slice(0, ENTRY_ASK_REFUSED_RAW_CHARS) }),
            retried: outcome.retried, turns: outcome.turns.length,
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }) });
        }
        return;
      }
      // ISSUE-423: the host compacted while this ask was in flight. The answer
      // describes rows the compaction rewrote, so nothing is appended and nothing
      // is applied: a receipt here would record a removal of the pre-ask array.
      // Each row keeps its unit whole and is refused by name.
      if (entry.compactionGeneration !== askGeneration) {
        cardText = { kind: 'error', text: 'entry ask refused: compaction-generation-changed' };
        for (const row of live) {
          journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, unitId: row.unitId,
            code: 'compaction-generation-changed',
            askGeneration, compactionGeneration: entry.compactionGeneration,
            ...(outcome.raw === undefined
              ? {}
              : { raw: outcome.raw.slice(0, ENTRY_ASK_REFUSED_RAW_CHARS) }),
            retried: outcome.retried, turns: outcome.turns.length,
            reason: 'the host compacted during the ask, so the answer names an array that no longer exists; '
              + 'the exchange was not appended and the unit keeps' });
        }
        return;
      }
      // ISSUE-548: another plugin's replacement, or any rewrite that did not
      // emit the host's compaction events, still invalidates the array this
      // answer describes. The host's monotonic surface counters catch it; a
      // host that exposes none keeps the check above only.
      if (askSurface !== null && surfaceAdvanced(session, askSurface)) {
        const now = surfaceStampOf(session);
        cardText = { kind: 'error', text: 'entry ask refused: surface-generation-changed' };
        for (const row of live) {
          journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, unitId: row.unitId,
            code: 'surface-generation-changed',
            askReplaceGeneration: askSurface.replaceGeneration,
            replaceGeneration: now?.replaceGeneration ?? null,
            askContentGeneration: askSurface.contentGeneration,
            contentGeneration: now?.contentGeneration ?? null,
            retried: outcome.retried, turns: outcome.turns.length,
            reason: 'the host surface changed during the ask without a compaction event, so the answer '
              + 'names an array that no longer exists; the exchange was not appended and the unit keeps' });
        }
        return;
      }
      // Answered: ONE exchange (ask turn … answer turn) covers the whole batch, so
      // it is appended once and recorded on every answered row's event id.
      const appended = appendAskTurns(entry, session, outcome.turns);
      if (appended === null) {
        // ISSUE-403: the partial append collapsed its own prefix; the ask fails
        // open with `entry-ask-append-failed` already naming the host error, and
        // the card must not read as a completed ask.
        cardText = { kind: 'error', text: 'entry ask failed: the exchange could not be appended' };
        return;
      }
      const askNode = appended[0], answerNode = appended[appended.length - 1];
      if (askNode === undefined || answerNode === undefined) {
        cardText = { kind: 'error', text: 'entry ask refused: empty-exchange' };
        for (const row of live) {
          journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, unitId: row.unitId, code: 'no-seed',
            retried: outcome.retried, turns: outcome.turns.length, reason: 'empty-exchange' });
        }
        return;
      }
      const askNodeId = messageNodeId(entry.sessionId, askNode.seq);
      const answerNodeId = messageNodeId(entry.sessionId, answerNode.seq);
      // True once a row's write moved the host surface, which is what takes the
      // exchange off it. A fail-open apply that wrote nothing leaves this false, so
      // the collapse below still runs (ISSUE-215); it also gates the later rows'
      // `rewound: true`, which may only name a write that happened.
      let appliedAny = false;
      // The card's apply-side truth (ISSUE-404): a row whose apply failed open or
      // threw did not land, so a card cannot read success just because the model
      // answered.
      let applyFailures = 0;
      // ISSUE-480: a row the ask did not answer, or whose bytes moved between
      // ask and apply, was refused by this lane rather than by the engine. Its
      // unit stays whole and its paid answer is lost, so the card must name it
      // exactly as the prune card names an undecided row — never settle success.
      let refusedRows = 0;
      for (const [position, row] of live.entries()) {
        const read = outcome.rows.find(candidate => candidate.index === position + 1);
        if (read === undefined || read.status !== 'answered') {
          refusedRows += 1;
          // A refused or missing row keeps its unit: no ask line's action, no
          // apply. The refusal code is the table reader's own, and `wireCode`
          // names the parser defect underneath a `malformed-row` when there was
          // one — the field that makes a refused row classifiable afterwards
          // (ISSUE-179). It is written only when the parser named a code, so an
          // old journal and a refusal with no inner defect both read the same.
          journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: row.capture.eventId,
            callId: row.capture.item.callId, unitId: row.unitId,
            code: read === undefined ? 'missing-index' : read.code,
            ...(read === undefined || read.wireCode === undefined || read.wireCode === null
              ? {}
              : { wireCode: read.wireCode }),
            // The answer text is the one fact that splits a parser defect from
            // an unreadable-answer shape; an all-unreadable batch would
            // otherwise leave no text at all (ISSUE-523 item 5).
            ...(outcome.raw === undefined
              ? {}
              : { raw: outcome.raw.slice(0, ENTRY_ASK_REFUSED_RAW_CHARS) }),
            retried: outcome.retried, turns: outcome.turns.length, batchIndex: position + 1 });
          continue;
        }
        const answer = read.answer;
        journal('entry-ask', { sessionId: entry.sessionId, eventId: row.capture.eventId,
          callId: row.capture.item.callId, unitId: row.unitId, answeredInRound: 0,
          action: answer.action,
          ...(answer.action === 'keepall' ? {} : { summary: answer.summary }),
          raw: outcome.raw, retried: outcome.retried, turns: outcome.turns.length,
          askNodeId, answerNodeId, askGeneration,
          batchIndex: position + 1, batchSize: live.length,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }) });
        // Every later unit marks `rewound: true`: unit 1's write takes the exchange
        // off the surface, so units 2..N name only their own result turn (ADR-0035
        // §5, the plan's prescribed flag — never a multi-replacement application).
        const exchange: DshAskExchange = {
          resultNodeId: row.capture.eventId,
          askNodeId, answerNodeId,
          summary: answer.action === 'keepall' ? '' : answer.summary,
          ...(appliedAny ? { rewound: true as const } : {}),
        };
        // One batch shares ONE answer turn, and the engine answers one event id
        // once (`engine.ts` dedupe): handing every row the bare answer id would
        // make rows 2..N replays that plan nothing and journal `fail-open`. So a
        // multi-row batch keys each row under its own id, `<answer>#<index>`, and
        // a one-row batch keeps the bare id — today's event id, byte for byte,
        // which is the default-off gate's third surface.
        const rowAnswerEventId = live.length === 1
          ? answerNodeId : `${answerNodeId}#${String(position + 1)}`;
        // The apply's own re-read: the answer was about the bytes the table showed
        // at fire. If they moved while the model answered, this row is refused
        // locally — nothing reaches the engine, so the guard writes no validation
        // row and the breaker counts no application failure for our stale read.
        const now = liveTranscriptNodeOf(entry, row.capture);
        if (now === null || now.sha256 !== row.node.sha256) {
          refusedRows += 1;
          journal('entry-apply-refused', { sessionId: entry.sessionId,
            eventId: row.capture.eventId, callId: row.capture.item.callId, unitId: row.unitId,
            answerEventId: rowAnswerEventId, status: 'fail-open', code: 'ask-row-stale',
            batchIndex: position + 1, askSha256: row.node.sha256,
            liveSha256: now === null ? null : now.sha256,
            detail: 'the result changed after the ask, so the answer names bytes that no longer exist; '
              + 'the row keeps its unit whole' });
          continue;
        }
        // ISSUE-428: an apply that THROWS must not skip the batch's collapse below.
        // The throw is named here and the row counts as not applied, so the
        // exchange is still collapsed as a refused batch and the orphan cannot
        // reach the next model turn.
        try {
          const applied = await applyEntryAnswer(entry, session, row.capture, now, exchange,
            rowAnswerEventId, answer, outcome.raw);
          // Only a write that moved the surface took the exchange off it. A
          // fail-open apply (`appends: 0`) leaves the pair in place, so it must not
          // suppress the batch's collapse below (ISSUE-215) — and it must not mark
          // every later row `rewound`, because no earlier write happened. The host
          // surface moved (the exchange appended at least, and possibly rewound), so
          // the port's transcript is re-read before the next row's apply and before
          // the at-rest pass plans against it.
          appliedAny = appliedAny || applied.movedSurface;
          if (applied.outcome.status === 'fail-open') applyFailures += 1;
          syncPass(entry, session);
        } catch (error) {
          applyFailures += 1;
          journal('entry-apply-refused', { sessionId: entry.sessionId,
            eventId: row.capture.eventId, callId: row.capture.item.callId, unitId: row.unitId,
            answerEventId: rowAnswerEventId, status: 'fail-open', code: 'apply-threw',
            batchIndex: position + 1,
            detail: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!appliedAny) {
        // No write took the exchange off the surface: every row was refused or
        // missing, the answer was unreadable row by row, or an answered row's apply
        // failed open and appended nothing (ISSUE-215 — a `keeplines` naming every
        // line is the live shape). Both turns are `user/message`, so the next model
        // turn would answer the stale question instead of the task (ISSUE-185). The
        // exchange is not a record (ADR-0022 §Consequences): collapse it exactly as
        // a keep-all does, one replace over `[ask … answer]`. Nothing is applied and
        // nothing settles, so every refused row's unit stays landed whole
        // (ADR-0022 §14, ADR-0028 §4) and the next bulk prune may still list it.
        // A pair the surface no longer holds is refused by name inside the port and
        // writes nothing; the journal says so.
        const collapsed = entry.port.rewindAskExchange({ resultNodeId: last.capture.eventId,
          askNodeId, answerNodeId, summary: '' });
        // This write is the mount's, never a row's apply: consume it so a later
        // `takeEntryWrite` cannot read it as that row's own outcome.
        entry.port.takeEntryWrite();
        journal('entry-ask-collapsed', { sessionId: entry.sessionId,
          resultNodeId: last.capture.eventId, askNodeId, answerNodeId,
          batchSize: live.length, status: collapsed.status,
          ...(collapsed.status === 'refused' ? { code: collapsed.code } : {}) });
        // ISSUE-463: only an applied collapse took the exchange off the surface.
        // A refused or unknown rewind keeps it owed, so the next boundary's
        // recovery retries it in the same process.
        if (collapsed.status === 'applied') {
          syncPass(entry, session);
        } else {
          entry.resumeRecovery = true;
        }
      }
      // ISSUE-404: the card settles in the `finally` below, after the
      // append/apply leg, with the pass's true outcome. A model answer whose rows
      // never landed is not a completed ask. ISSUE-480: a refused row is one
      // rule in both lanes — a fired batch with any undecided row settles
      // `error` and names the count, even when another row applied.
      if (applyFailures > 0 || refusedRows > 0) {
        const parts: string[] = [];
        if (applyFailures > 0) parts.push(`${String(applyFailures)} row(s) failed to apply`);
        if (refusedRows > 0) parts.push(`${String(refusedRows)} row(s) refused`);
        cardText = { kind: 'error', text: `entry ask answered; ${parts.join('; ')}` };
      } else {
        cardText = appliedAny ? { kind: 'success', text: 'entry ask answered' }
          : { kind: 'error', text: 'entry ask answered; no row was applied' };
      }
    } catch (error) {
      // ISSUE-461: a throw from the host surface read or the append/apply leg
      // is named here and rethrown; the `finally` still closes exactly one card.
      cardText = { kind: 'error', text: `entry ask failed: ${messageOf(error)}` };
      throw error;
    } finally {
      card.settle(cardText.kind, cardText.text);
    }
  }

  /**
   * One batch ask under the ISSUE-423 ask/apply window. The window is what a
   * compaction observed on the event lane sees while this ask and its applies
   * run: it defers the latch's native-compaction re-arm to here, so no second
   * above-bar ask is armed from inside the first one's apply. The window closes
   * on every path, including a throw from the ask seam.
   */
  async function askBatch(entry: RacoonsSessionEntry, session: DshMountSession,
    rows: readonly { readonly capture: Capture; readonly node: ToolResultNode;
      readonly unitId: UnitId }[],
    llm: DshLlmService, route: JudgeRoute,
    signal?: AbortSignal,
  ): Promise<void> {
    if (rows.length === 0) return;
    entry.entryWindows += 1;
    try {
      await askBatchCore(entry, session, rows, llm, route, signal);
    } finally {
      entry.entryWindows -= 1;
      flushDeferredCompaction(entry);
    }
  }

  /**
   * The lanes whose ask/apply windows are open, as the journal names them
   * (ISSUE-501): `entry`, `prune`, both (`entry+prune`) or null. A direct
   * prune can overlap an in-flight entry ask, so one lane's name is not enough
   * to say what is running.
   */
  function openAskWindow(entry: RacoonsSessionEntry):
  'entry' | 'prune' | 'entry+prune' | null {
    if (entry.entryWindows > 0) return entry.pruneWindows > 0 ? 'entry+prune' : 'entry';
    return entry.pruneWindows > 0 ? 'prune' : null;
  }

  /**
   * Take a compaction's deferred latch re-arm once no ask/apply window is open
   * (ISSUE-423). The re-arm is the shipped backstop (ADR-0050): the surface was
   * rewritten, so the prior baseline does not describe it. It runs here rather
   * than mid-ask, and rides the round file like the direct observation does.
   */
  function flushDeferredCompaction(entry: RacoonsSessionEntry): void {
    if (!entry.compactionRearmDeferred || openAskWindow(entry) !== null) return;
    entry.compactionRearmDeferred = false;
    if (!config.nativeCompactionBackstop) return;
    // ISSUE-567: same rule as the direct observation above — the pre-compaction
    // billed row does not describe the surface the host left behind.
    entry.billedPromptTokens = null;
    entry.pruneTrigger.noteNativeCompaction();
    const target = targets.get(entry.sessionId);
    if (target !== undefined) {
      writePruneRound(target, entry.pruneRounds, journal, entry.sessionId,
        entry.pruneTrigger.snapshot());
    }
  }

  /**
   * Why a paid ask must not run right now, read BEFORE the send, for BOTH ask
   * lanes (ISSUE-426 gave the prune lane this third question; ISSUE-440 gave
   * the entry lane the same read). One ledger read answers all three
   * healthy-or-not questions:
   *
   * - the read throws (the refusing ledger of a failed open) → `ledger-unavailable`;
   * - an unfinished `prepared` intent → `recovery-pending`: core's next pass
   *   would return `recovery-pending` and apply nothing, so the paid ask would
   *   be bought for an apply that cannot land;
   * - the last `validation` row's breaker is disabled → `breaker-open`
   *   (ISSUE-057; ADR-0020 §Decision 5b — read-only, and an ask never writes a
   *   validation, so an ask failure cannot quiet the gate).
   *
   * `null` means the ask may run. Any read failure is a standdown, never a
   * throw: the lane does nothing and later passes still run.
   */
  async function ledgerStanddown(entry: RacoonsSessionEntry):
  Promise<'ledger-unavailable' | 'recovery-pending' | 'breaker-open' | null> {
    try {
      let disabled = false;
      const prepared = new Set<string>();
      const finished = new Set<string>();
      for await (const row of entry.ledger.events(entry.sessionId)) {
        const event = row.event;
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

  /**
   * The landed result's whole-result unit id, read through the port's own mint
   * (bar 0: the answered result is one unit whatever its size, ADR-0022 §14's
   * stamped address). Absent when the transcript holds no tool result under
   * that id, which the loop journals as `unit-absent`.
   *
   * The port's mint is the same one the adapter stamps the answered event with
   * (`stampFor` → `landedUnitId`) and the same one the guard re-derives, so a
   * unit id minted here and an applied shape's `unitId` can only agree.
   */
  function landedUnitIdOf(entry: RacoonsSessionEntry, node: ToolResultNode | null): UnitId | null {
    return node === null ? null : entry.port.landedUnitId(node.id);
  }

  /**
   * Open the host's native command card (ISSUE-372; ADR-0062 D1): `command/run`
   * under `ASK_CARD_NAME`, paired by a minted id. The returned handle settles it
   * with `command/done`, exactly once; ISSUE-404 moved the settle to the caller
   * so a pass can close the card only after its append/apply leg, with the whole
   * pass's outcome rather than the ask's alone.
   *
   * Both appends are log-only (no `surfaceOp`): the pair never enters the model
   * surface, takes no lock and opens no turn, the same shape the host's own
   * command executor writes. A card append that throws is contained — the ask
   * must still run and settle — so a failed open skips the close and a failed
   * close only warns.
   */
  function openAskCard(session: DshMountSession): {
    settle(kind: 'success' | 'error', text: string): void;
  } {
    const commandId = `cremator-ask-${randomUUID()}`;
    let opened = true;
    try {
      // `source` is the host event's required slot; its only variant is `user`.
      session.append('command/run', { commandId, name: ASK_CARD_NAME,
        source: { kind: 'user' } });
    } catch (error) {
      opened = false;
      const message = messageOf(error);
      // The card could not open, so there is nothing to close; the line names
      // that failure and the ask still runs and settles (ISSUE-429).
      journal('ask-card-error', { sessionId: session.id, phase: 'open', commandId, message });
      safeWarn(`ask card open: ${message}`);
    }
    let settled = false;
    return {
      settle(kind, text) {
        if (settled) return;
        settled = true;
        if (!opened) return;
        try {
          session.append('command/done', { commandId, kind, text });
        } catch (error) {
          const message = messageOf(error);
          // `cardKind` (not `kind`) carries the card outcome: `kind` is the
          // journal record's own discriminator and must not be overwritten.
          journal('ask-card-error', { sessionId: session.id, phase: 'close',
            commandId, cardKind: kind, message });
          safeWarn(`ask card close: ${message}`);
        }
      },
    };
  }

  /**
   * Run one prune pass (ISSUE-022 chunks 5–6): the snapshot and the transcript
   * come from the port; the ask goes through the host's own model seam. The round ordinal is persisted beside the session's ledger, so a
   * resumed process continues the count instead of starting at round 1.
   *
   * Record-only stays the structural default: a pass with no window configured
   * applies nothing, and the record is telemetry. When a window IS configured
   * the enforcement mode decides — `apply` hands the merged document to the
   * engine's `{kind:'prune'}` input, which plans one checkpoint-revert for the
   * whole pass (one epoch break, ADR-0009); `record-only` still records.
   */
  async function runPrune(session: DshMountSession,
    existing?: RacoonsSessionEntry, signal?: AbortSignal): Promise<RecordOnlyPruneOutcome | null> {
    return (await runPrunePass(session, existing, signal)).outcome;
  }

  /**
   * One pass plus the command-card outcome for it (ISSUE-535). A `/cremate`
   * command's request is taken here, by marker message id, and its waiter is
   * settled on every exit — finished with the applied removal count, or failed
   * with the pass's own named failure — so the card can never outlive the pass.
   */
  async function runPrunePass(session: DshMountSession,
    existing?: RacoonsSessionEntry, signal?: AbortSignal,
    cremateMessageId?: string): Promise<{
      readonly outcome: RecordOnlyPruneOutcome | null;
      readonly result: CrematePassResult;
    }> {
    const cremate = cremateMessageId === undefined
      ? undefined : takeCremate(session.id, cremateMessageId);
    let passResult: CrematePassResult =
      { status: 'failed', code: 'failed', message: 'the prune pass did not settle' };
    try {
      const outcome = await runPruneOutcome(session, existing, signal,
        (result) => { passResult = result; });
      return { outcome, result: passResult };
    } finally {
      settleCremate(cremate, passResult);
    }
  }

  /** The pass itself; `note` records its command-card outcome at every exit. */
  async function runPruneOutcome(session: DshMountSession,
    existing: RacoonsSessionEntry | undefined, signal: AbortSignal | undefined,
    note: (result: CrematePassResult) => void): Promise<RecordOnlyPruneOutcome | null> {
    // Reached from `runStep` (which hands its own entry in, ISSUE-401/416) or
    // directly by a rig/test, where a retryable open surfaces as
    // `RacoonsStorageRetryError` to the caller — the same seam every other
    // boundary uses. Re-entering `sessionFor` here would hit the ISSUE-416
    // closing guard on a step that was already in flight at close.
    const entry = existing ?? await sessionFor(session.id, session);
    // A direct `runPrune` may reach this path without a preceding `runStep`.
    // ADR-0071 needs the resolved window before the apply leg reads it.
    await refreshBoundaryWindow(entry, signal);
    pruneRequests.delete(session.id);
    syncPass(entry, session);
    const snapshot = await entry.port.snapshot();
    entry.pruneRounds += 1;
    // ISSUE-404: the card is opened only after the standdown check (a pass that
    // sends nothing has no ask to show) and settles in the `finally` below,
    // after the apply leg, with the whole pass's outcome. Its default is the
    // honest one: an unsettled pass is an error, never a success.
    let card: ReturnType<typeof openAskCard> | null = null;
    let pruneWindowOpen = false;
    let cardText: { kind: 'success' | 'error'; text: string } =
      { kind: 'error', text: 'the prune pass did not settle' };
    passRunning.add(session.id);
    try {
      // The paid ask is refused before it is sent when the write it depends on
      // cannot land (ISSUE-426): a refusing ledger, a recovery-pending intent, or
      // a disabled breaker stands the pass down by name. The pass does nothing
      // and later passes still run (fail-open).
      const standdown = await ledgerStanddown(entry);
      if (standdown !== null) {
        journal('prune-off', { sessionId: entry.sessionId, round: entry.pruneRounds,
          reason: standdown });
        note({ status: 'failed', code: 'ask-refused',
          message: `the pass stood down: ${standdown}` });
        return null;
      }
      card = openAskCard(session);
      // ISSUE-423: the ask and its apply run inside the prune window. A
      // compaction observed here defers the latch's re-arm instead of clearing
      // the pass's baseline mid-flight; the ask's own generation decides whether
      // the document may still apply.
      const passGeneration = entry.compactionGeneration;
      // ISSUE-548: snapshot the host's own surface counters with the generation.
      const passSurface = surfaceStampOf(session);
      entry.pruneWindows += 1;
      pruneWindowOpen = true;
      const outcome: RecordOnlyPruneOutcome = await runRecordOnlyPrune({
          sessionId: entry.sessionId,
          snapshot,
          transcript: entry.port.transcript(),
          round: entry.pruneRounds,
          barBytes: config.barBytes,
          episodeNoNewPathSteps: config.episodeNoNewPathSteps,
          // The dedupe classes (ADR-0037; ISSUE-145; ISSUE-151). Both switches
          // ship off and are on only when the row turned them on.
          classes: {
            supersededByReread: config.dedupeSupersededByReread,
            callEcho: config.dedupeCallEcho,
          },
          // The units a settled entry keep already decided (ISSUE-073): a later
          // table must not re-list them. The pass reads the invalidation itself,
          // so a unit a write made stale is still listable.
          settledNodeIds: entry.entryKept,
          // ISSUE-221: the bulk ask's grammar, resolved from the row; absent is
          // `3option`, the shipped contract byte for byte.
          grammar: config.pruneAskGrammar,
          // ISSUE-508: the session's first depth table states the 70 percent
          // share line; every later one 40. The flag moves only when a table ask
          // actually left the seam, and is persisted beside the round so a
          // restart's first table ask states the later share.
          firstTrigger: !entry.tableAskFired,
          onTableAskLeft: () => {
            if (entry.tableAskFired) return;
            entry.tableAskFired = true;
            const askTarget = targets.get(entry.sessionId);
            if (askTarget !== undefined) {
              writeTableAskFired(askTarget, true, journal, entry.sessionId);
            }
          },
          ...(options.llm === undefined ? {} : { llm: options.llm }),
          route: () => resolveRoute(entry.host ?? session),
          // ISSUE-553: the seed is a projection of the LIVE surface, not the
          // capture. A turn-end `forget` replaces the surface after that turn's
          // last main request was captured, so a fork from the capture would
          // replay bytes the product already removed. No capture, or a surface
          // the projection cannot reach, is the named `no-seed` path — never a
          // partial fork.
          seed: () => surfaceWire(session, entry.sessionId, null),
          journal,
          timeoutMs: config.judgeTimeoutMs,
          // ISSUE-405: the same host pre-step signal the entry ask receives
          // preempts a cancelled prune turn instead of waiting out the deadline.
          ...(signal === undefined ? {} : { signal }),
        });
      if (outcome.refusedFor !== null) {
        // No request left the seam for this pass: the card names the refusal,
        // never the ask's success text.
        cardText = { kind: 'error', text: `prune ask refused: ${outcome.refusedFor}` };
        note({ status: 'failed', code: 'ask-refused',
          message: `prune ask refused: ${outcome.refusedFor}` });
      } else if (outcome.plan.askRows.length === 0) {
        // A pass with nothing to ask makes no model call. The card is still the
        // pass's visible trace, so it says exactly that (ISSUE-404).
        cardText = { kind: 'success', text: 'prune pass: no ask was sent' };
      }
      // The apply leg (ISSUE-022 chunk 6; ADR-0009): one engine event for the
      // whole pass, so the guard validates once and the pass costs exactly one
      // checkpoint-revert. A mount with no window stays record-only, which is
      // the rollout's first stage (ADR-0008). ISSUE-423: a compaction during the
      // ask invalidated the array this document planned against, so it is
      // refused by name instead of recording a receipt for the pre-ask array.
      if (entry.compactionGeneration !== passGeneration) {
        cardText = { kind: 'error', text: 'prune ask refused: compaction-generation-changed' };
        journal('prune-off', { sessionId: entry.sessionId, round: entry.pruneRounds,
          reason: 'compaction-generation-changed', passGeneration,
          compactionGeneration: entry.compactionGeneration });
        note({ status: 'failed', code: 'changed',
          message: 'prune ask refused: compaction-generation-changed' });
        return null;
      }
      // ISSUE-548: the host's counters catch a rewrite that emitted no
      // compaction events. The pass itself appends nothing to the surface
      // between this snapshot and the apply, so any move here is external.
      if (passSurface !== null && surfaceAdvanced(session, passSurface)) {
        const now = surfaceStampOf(session);
        cardText = { kind: 'error', text: 'prune ask refused: surface-generation-changed' };
        journal('prune-off', { sessionId: entry.sessionId, round: entry.pruneRounds,
          reason: 'surface-generation-changed',
          askReplaceGeneration: passSurface.replaceGeneration,
          replaceGeneration: now?.replaceGeneration ?? null,
          askContentGeneration: passSurface.contentGeneration,
          contentGeneration: now?.contentGeneration ?? null });
        note({ status: 'failed', code: 'changed',
          message: 'prune ask refused: surface-generation-changed' });
        return null;
      }
      const applied = await applyPrunePass({ sessionId: entry.sessionId, engine: entry.engine,
        application: outcome.application, round: outcome.plan.round,
        windowTokens: entry.windowTokens, journal,
        // Read for the journal line only: the engine decides, and its answer is
        // what the line reports (CRITIC-022 P2 #8).
        enforcement: config.enforcement,
        revertHistory: entry.adapter.capabilities.revertHistory });
      // ISSUE-436: the pass's applied row supersedes the crash-window receipt.
      if (applied !== null && applied.status === 'applied') {
        collectSettledReceipt(entry, applied.intentId);
      }
      // The command card counts what the apply leg actually landed: a pass the
      // engine skipped (no window, record-only, nothing planned) removed
      // nothing, whatever the plan proposed. An unresolved window is named as
      // the reason instead of reading as a successful no-op (ADR-0071).
      const planned = outcome.application?.removals.length ?? 0;
      if (outcome.refusedFor === null) {
        if (planned > 0 && entry.windowTokens === null) {
          note({ status: 'failed', code: 'no-window',
            message: 'the model context window is unknown' });
        } else if (planned > 0 && applied === null) {
          note({ status: 'failed', code: 'failed',
            message: 'the apply leg produced no result' });
        } else {
          note({
            status: 'finished',
            removed: applied !== null && applied.status === 'applied' ? planned : 0,
            bytesRemoved: applied !== null && applied.status === 'applied'
              ? applied.removedBytes ?? 0 : 0,
          });
        }
      }
      if (outcome.refusedFor === null && outcome.plan.askRows.length > 0) {
        // The pass's own totals: rows still refused after the one re-ask, and
        // rows a halt left undecided (ISSUE-177 — a dead stream defers, it
        // does not refuse). Either means the ask did not fully settle.
        const totals = outcome.attempts?.pass;
        const unsettled = (totals?.finalRefusals ?? 0) + (totals?.deferred ?? 0);
        cardText = unsettled > 0
          ? { kind: 'error', text: 'prune rows left undecided' }
          : { kind: 'success', text: 'prune ask settled' };
        if (unsettled > 0) note({ status: 'failed', code: 'ask-refused',
          message: 'prune rows left undecided' });
      }
      // ISSUE-462: the card reads the APPLY result too, not the ask totals
      // alone. Planned removals the engine refused did not settle, so the
      // visible trace names the status and the guard's own issue code.
      // `unchanged` is not an error: record-only is an explicit opt-out that
      // plans nothing.
      if (applied !== null && applied.status !== 'applied' && applied.status !== 'unchanged') {
        const codes = applied.validation?.ok === false
          ? applied.validation.issues.map(issue => String(issue.code)) : [];
        cardText = { kind: 'error', text: `prune apply ${applied.status}`
          + (codes.length === 0 ? '' : `: ${codes.join(', ')}`) };
        note({ status: 'failed', code: 'failed', message: cardText.text });
      }
      return outcome;
    } catch (error) {
      // A caller bug inside core's planners is the only throw; a host must
      // still see its step finish, so it lands as a named record.
      journal('prune-error', { sessionId: entry.sessionId,
        message: error instanceof Error ? error.message : String(error) });
      // ISSUE-404: an apply/host failure is the card's outcome, not a
      // success that hides the failed leg.
      cardText = { kind: 'error', text: `prune pass failed: ${messageOf(error)}` };
      note({ status: 'failed', code: 'failed', message: `prune pass failed: ${messageOf(error)}` });
      return null;
    } finally {
      passRunning.delete(session.id);
      // CRITIC-022 P1-1: a pass ends here whether it applied, refused or threw,
      // and every ending re-arms the latch. The next observation — the pass's
      // post-removal reading — is the new baseline, so the next fire needs one
      // re-arm bar of NEW growth past what the pass left, or a below-bar
      // excursion (ADR-0050 Amendment 2026-11-18). One pass (or one throw) can
      // no longer close the latch for the rest of the session.
      entry.pruneTrigger.notePassCompleted();
      // The round and the re-armed latch persist together (ISSUE-022 chunk 6;
      // ISSUE-336): the ordinal was consumed in memory above, so it lands even
      // when the pass threw. A write failure is journaled inside and never
      // fails the pass.
      const target = targets.get(entry.sessionId);
      if (target !== undefined) {
        writePruneRound(target, entry.pruneRounds, journal, entry.sessionId,
          entry.pruneTrigger.snapshot());
      }
      // ISSUE-423: the window is over on every path (applied, refused, threw).
      // A compaction that landed inside it takes its re-arm now, after the pass
      // left its own baseline, so no second ask was armed mid-pass. ISSUE-501: a
      // lane only closes its own window; the re-arm waits for every lane.
      if (pruneWindowOpen) entry.pruneWindows -= 1;
      flushDeferredCompaction(entry);
      // The card settles LAST (ISSUE-404): after the ask, the append and the
      // apply, with the pass's whole outcome. A standdown opened no card.
      card?.settle(cardText.kind, cardText.text);
    }
  }

  /**
   * Take the publication a pass produced, if the host still has to publish it.
   *
   * Only an append-mode application is a host publication. An entry application
   * is applied by the port's own rewind-and-append host write (ISSUE-058 /
   * ADR-0022 §12; ISSUE-502), and a revert splices the surface itself through the
   * derived seam (`port.applyRevert` → `applyValidatedRevert`) without ever
   * calling `publish`; taking either here would append what already landed
   * elsewhere. The journal recorded all of them (`publish`), so dropping the
   * taken value loses nothing.
   */
  function takeAppendRequest(entry: RacoonsSessionEntry): RacoonsApplicationRequest | null {
    const request = entry.takePublication();
    return request !== null && request.application.mode === 'append' ? request : null;
  }

  /** Run one at-rest pass. `turn-end` uses the engine's own turn-end reason. */
  async function runAtRest(entry: RacoonsSessionEntry, eventId: string,
    reason: 'step' | 'turn-end'): Promise<EngineResult> {
    counters.preSteps += 1;
    const result = reason === 'turn-end'
      ? await entry.engine.process({ kind: 'at-rest', eventId, reason: 'turn-end' })
      : await entry.adapter.onPreStep(eventId);
    journal('at-rest', { sessionId: entry.sessionId, eventId, reason,
      status: result.status, intentId: result.intentId,
      issues: result.validation?.ok === false ? result.validation.issues : [],
    });
    if (result.status === 'applied') collectSettledReceipt(entry, result.intentId);
    return result;
  }

  /**
   * Drop the durable copy of one receipt once the engine's own `applied` row is
   * durable (ISSUE-436). The receipt existed for the crash window before that
   * row (ISSUE-417); the port's live map still answers this process, while the
   * file tracks live obligations instead of every removal ever applied.
   */
  function collectSettledReceipt(entry: RacoonsSessionEntry, intentId: string | null): void {
    if (intentId === null) return;
    entry.port.settleDurableReceipt(intentId as IntentId);
    const target = targets.get(entry.sessionId);
    if (target !== undefined) {
      removeDurableReceipt(target, intentId, journal, entry.sessionId);
    }
  }

  /**
   * Apply every manual forget the `forget` tool queued (PRD §6.2; ISSUE-045
   * chunk D2). Runs at the step and turn-end boundaries, after the transcript
   * sync, so the engine plans and validates against the surface the host is
   * about to send.
   *
   * A request is drained BEFORE it is applied and never re-queued: the engine
   * dedupes by event id, so a request it already settled would answer the same
   * thing again, and keeping it queued would repeat the attempt at every later
   * boundary. Each outcome is journaled, so an operator can read why a forget
   * did not apply — including the `unsupported-capability` a build without the
   * revert seam records, which the adapter answers before queueing whenever it
   * can tell.
   */
  async function applyForgets(entry: RacoonsSessionEntry): Promise<EngineResult[]> {
    const outcomes: EngineResult[] = [];
    const drained = entry.pendingForgets.splice(0);
    for (const pending of drained) {
      let result: EngineResult;
      try {
        result = await entry.engine.process({ kind: 'forget', eventId: pending.eventId,
          request: pending.request });
      } catch (error) {
        // ISSUE-523 item 3: a thrown process applied nothing, so the request
        // goes back on the queue and its durable record stands. Clearing the
        // owed-forget fact here would lose an accepted forget that never
        // applied; the next boundary retries it, and the engine dedupes by
        // event id if the throw landed a partial write.
        entry.pendingForgets.push(pending);
        journal('forget-error', { sessionId: entry.sessionId, eventId: pending.eventId,
          unitId: pending.unitId, requeued: true,
          message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      journal('forget', { sessionId: entry.sessionId, eventId: pending.eventId,
        unitId: pending.unitId, path: pending.request.source,
        ranges: pending.request.ranges.length, status: result.status,
        intentId: result.intentId,
        issues: result.validation?.ok === false ? result.validation.issues : [] });
      if (result.status === 'applied') collectSettledReceipt(entry, result.intentId);
      outcomes.push(result);
    }
    // ISSUE-417: the queue is empty again, so the durable owed-forget fact goes
    // with it. A failed clear leaves the row for a remount to replay, and a
    // thrown process re-queued its request above, so the file keeps exactly the
    // requests that never applied; the engine dedupes by event id, so a replay
    // of an applied forget applies nothing.
    // Only a boundary that actually drained something rewrites the file; a
    // forget that landed during the drain was already persisted by the queue.
    const target = targets.get(entry.sessionId);
    if (drained.length > 0 && target !== undefined
      && !writePendingForgets(target, entry.pendingForgets.map(durableForgetOf), journal,
        entry.sessionId)) {
      journal('forget-persist-error', { sessionId: entry.sessionId,
        pending: entry.pendingForgets.length });
    }
    return outcomes;
  }

  /**
   * The cold boundary's recovery (ISSUE-341): a fresh session entry over a
   * surface that already holds landings is a resumed process, and the previous
   * process's checkpoint state died with it. This pass rebuilds what the
   * durable record still states, once per entry at the first boundary where a
   * host append is legal: an ask exchange orphaned by a death between
   * `appendAskTurns` and apply is collapsed (its turns are not records); a
   * shaped turn on the surface is a settled forget and the ledger's ok
   * `keepall` validation row names a settled keep, so both marks are rebuilt;
   * every landed result the buffer does not already hold is re-queued so
   * this boundary delivers it as an entry event; and the durable pending-append
   * intent (ISSUE-374) is re-queued so the boundary's flush replays the records
   * a death before the flush left owed to the host. A fresh session finds
   * nothing to recover and writes no line.
   *
   * One bound shapes the clear. ISSUE-428: the latch clears only when every leg
   * succeeds; a throw (`collapse`, `surface-read`, `marks`, `appends`, `sync`)
   * leaves a named `entry-recovery-retry` line and the next boundary retries.
   * Every surface result is re-queued, including results that predate this
   * session's install identity (ISSUE-414's eligibility guard is gone): the
   * surface the recovery reads is the whole history this session owns.
   */
  async function recoverResumedEntry(entry: RacoonsSessionEntry,
    session: DshMountSession): Promise<void> {
    if (!entry.resumeRecovery) return;
    // ISSUE-428: the latch clears only when every recovery leg succeeds. A leg
    // that throws is journaled by name and the entry keeps owing its recovery,
    // so the next boundary retries instead of the process silently losing it.
    let step = 'collapse';
    let collapsed = 0;
    let redelivered = 0;
    let kept = 0;
    let appends = 0;
    try {
    const askKind = `${config.recordName}/entry-ask`;
    const isAsk = (seq: number): boolean => {
      const event = session.eventAt?.(seq);
      if (event?.type !== 'user/message') return false;
      const data = isRecord(event.data) ? event.data : {};
      const source = isRecord(data['source']) ? data['source'] : {};
      return source['kind'] === askKind;
    };
    let run: number[] = [];
    // ISSUE-403: a refused collapse is NOT recovered. ISSUE-463: an `unknown`
    // collapse is not recovered either — the host did not confirm the write, so
    // the range may still be on the surface. Both name the retry and stop this
    // pass before any leg can clear the latch, so the next boundary tries again
    // instead of treating "the host said maybe/no" as done.
    let collapseRefused: string | null = null;
    let collapseUnknown: string | null = null;
    const collapseRun = (): void => {
      const first = run[0], last = run[run.length - 1];
      run = [];
      if (first === undefined || last === undefined) return;
      const askNodeId = messageNodeId(entry.sessionId, first);
      const answerNodeId = messageNodeId(entry.sessionId, last);
      const outcome = entry.port.rewindAskExchange({ resultNodeId: '',
        askNodeId, answerNodeId, summary: '' });
      // This write is the mount's, never a row's apply: consume it so a later
      // `takeEntryWrite` cannot read it as that row's own outcome.
      entry.port.takeEntryWrite();
      if (outcome.status === 'applied') {
        collapsed += 1;
      } else if (outcome.status === 'refused') {
        collapseRefused ??= outcome.code;
      } else {
        collapseUnknown ??= outcome.detail;
      }
      journal('entry-ask-collapsed', { sessionId: entry.sessionId, resultNodeId: '',
        askNodeId, answerNodeId, batchSize: 0, status: outcome.status, reason: 'resume',
        ...(outcome.status === 'refused' ? { code: outcome.code } : {}) });
    };
    for (const seq of session.surface?.nodes ?? []) {
      if (isAsk(seq)) run.push(seq);
      else collapseRun();
    }
    collapseRun();
    if (collapseRefused !== null) {
      journal('entry-recovery-retry', { sessionId: entry.sessionId, step: 'collapse',
        reason: 'collapse-refused', code: collapseRefused,
        message: 'the host refused the orphaned exchange rewind; recovery keeps owing' });
      return;
    }
    if (collapseUnknown !== null) {
      journal('entry-recovery-retry', { sessionId: entry.sessionId, step: 'collapse',
        reason: 'collapse-unknown', detail: collapseUnknown,
        message: 'the host did not confirm the orphaned exchange rewind; recovery keeps owing' });
      return;
    }
    // Rebuild the settled marks and re-queue the landings the buffer lost. A
    // result already queued was captured live by THIS mount and delivers
    // through the normal drain; only the surface's pre-existing rows are new.
    step = 'surface-read';
    const synced = surfaceTranscript(session, { sessionId: entry.sessionId });
    const buffer = buffers.get(entry.sessionId) ?? [];
    const queued = new Set(buffer.map(capture => capture.eventId));
    for (const [index, item] of synced.items.entries()) {
      if (item.role !== 'tool') continue;
      // A failed result is never queued, exactly as `observe` skips it.
      if (isRecord(item.hostData) && item.hostData['isError'] === true) continue;
      if ((item.embeddedRecords?.length ?? 0) > 0) entry.entryJudged.add(item.id);
      const seq = synced.seqs[index];
      if (queued.has(item.id) || seq === undefined) continue;
      buffer.push({ eventId: item.id, item, seq });
      redelivered += 1;
    }
    buffers.set(entry.sessionId, buffer);
    // A ledger that refuses the read (the refusing ledger of a failed open,
    // ISSUE-004 chunk 4) must not abort the boundary: the engine passes still
    // run and report `recovery-pending` themselves. Only the ledger-derived
    // kept marks are skipped; the surface recovery above already stands
    // (ISSUE-371). ISSUE-428: the failure is named in the journal, not a host
    // warning alone.
    step = 'marks';
    try {
      for await (const row of entry.ledger.events(entry.sessionId)) {
        if (row.event.kind !== 'validation' || !row.event.ok) continue;
        for (const issue of row.event.issues) {
          // The engine's entry lane writes `keepall` under the guard's wider
          // ValidationCode type; compare the string the row actually carries.
          if (String(issue.code) !== 'keepall' || issue.nodeId === null) continue;
          entry.entryJudged.add(issue.nodeId);
          entry.entryKept.add(issue.nodeId);
          kept += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal('entry-recovery-mark-error', { sessionId: entry.sessionId, message });
      safeWarn(`resume recovery read: ${message}`);
    }
    // The durable pending-append intent (ISSUE-374): a committed append the
    // previous process never flushed died with its in-memory queue, but the
    // publish callback persisted the records at commit. Re-queue them as ONE
    // replay request in commit order; the boundary's `flushAppends` runs right
    // after this pass and `publishAppend` skips any record already on the
    // surface, so a record that landed before the death is never duplicated.
    // A retry after a partial pass must not queue the same replay twice.
    step = 'appends';
    const appendTarget = targets.get(entry.sessionId);
    if (appendTarget !== undefined) {
      const records = readPendingAppends(appendTarget, journal, entry.sessionId);
      if (records.length > 0 && entry.pendingAppends.length === 0) {
        entry.pendingAppends.push(replayAppendRequest(records));
        appends = records.length;
      }
    }
    if (collapsed > 0 || redelivered > 0 || kept > 0 || appends > 0) {
      journal('entry-resume-recovered', { sessionId: entry.sessionId,
        collapsed, redelivered, kept, appends });
      step = 'sync';
      syncPass(entry, session);
    }
    entry.resumeRecovery = false;
    } catch (error) {
      journal('entry-recovery-retry', { sessionId: entry.sessionId, step,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * One step boundary: sync the transcript, deliver every queued result, then
   * run the at-rest pass. Publication is the caller's job, because only it holds
   * the live session.
   */
  async function runStep(session: DshMountSession,
    ordinals: { turn: number; step: number }, signal?: AbortSignal,
    cremateMessageId?: string): Promise<StepOutcome> {
    // ISSUE-439: a mount whose install-identity write failed retries it at the
    // NEXT boundary, before any pass classifies the session (ADR-0065
    // Decision 4). The boundary that created the entry already attempted it.
    const known = sessions.has(session.id);
    const entry = await sessionFor(session.id, session);
    if (known) entry.retryInstallIdentity?.();
    await recoverResumedEntry(entry, session);
    // ADR-0071/0070: put the latch on the routed model's own window before the
    // boundary observes it. A configured window returns without a host call.
    await refreshBoundaryWindow(entry, signal);
    // Retry any append an earlier boundary committed but never landed
    // (ISSUE-342): a failed publishAppend stays queued until it succeeds.
    try { flushAppends(session, entry, config, journal); }
    catch (error) {
      journal('append-publish-failed', { sessionId: entry.sessionId,
        pending: entry.pendingAppends.length,
        message: error instanceof Error ? error.message : String(error) });
    }
    const queued = buffers.get(session.id) ?? [];
    buffers.set(session.id, []);
    const deliveries: EngineResult[] = [];
    const landed: Capture[] = [];
    const requeue: Capture[] = [];
    for (const capture of queued) {
      let result: EngineResult;
      try {
        // The port appends what it is handed, so it plans against the prefix
        // that ends exactly where this result sits in the host surface.
        syncPass(entry, session, { beforeSeq: capture.seq });
        result = await deliverEntry(entry, capture);
      } catch (error) {
        // A host refusal must not stop the next result or the at-rest pass; the
        // journal records it and the scenario fails by name. The capture is
        // re-queued (ISSUE-343): a transient engine/storage error must not
        // permanently skip this landing — the next boundary delivers it again.
        journal('entry-error', { sessionId: entry.sessionId, eventId: capture.eventId,
          message: error instanceof Error ? error.message : String(error) });
        requeue.push(capture);
        continue;
      }
      deliveries.push(result);
      landed.push(capture);
    }
    // Failed deliveries go back ahead of any result that landed during this
    // loop, in their original order, so the next boundary retries them first.
    if (requeue.length > 0) {
      buffers.set(session.id, [...requeue, ...(buffers.get(session.id) ?? [])]);
    }
    // The port's transcript must hold every result this loop is about to ask
    // about, so the landed unit is addressable (`landedUnitId`) and the answer's
    // apply finds the surface node it addresses.
    syncPass(entry, session);
    // The entry checkpoint's ask loop (ISSUE-058 chunk P3c-2; ADR-0025 §1): the
    // results have landed and the at-rest pass and the prune have not seen this
    // step yet, so a result's unit is asked once before any later seam can name
    // it. Sequential, one ask per result, and fail-open throughout: the step is
    // never held past the ask's own deadline.
    await runEntryAsks(entry, session, landed, signal);
    // An answered exchange appended turns and may have rewound them: the
    // at-rest pass must plan against the surface that actually stands now.
    syncPass(entry, session);
    // Manual forgets queued by the `forget` tool apply here, before the at-rest
    // pass plans anything (ISSUE-045 chunk D2). The queue is drained once per
    // boundary: a forget is one revert, and the engine dedupes by event id, so
    // two boundaries can never apply the same request twice.
    const forgets = await applyForgets(entry);
    // A pass that applied changed the surface the at-rest pass must plan
    // against, so the transcript is re-read.
    if (forgets.some(outcome => outcome.status === 'applied')) syncPass(entry, session);
    const atRestId = eventIdFor(session.id, 'step',
      (Number(ordinals.turn) * 1_000_000) + Number(ordinals.step));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    try {
      atRest = await runAtRest(entry, atRestId, 'step');
      appendRequest = takeAppendRequest(entry);
    } catch (error) {
      journal('at-rest-error', { sessionId: entry.sessionId, eventId: atRestId,
        message: error instanceof Error ? error.message : String(error) });
    }
    // The bar's reading is observed at EVERY step boundary, whatever runs after
    // it (CRITIC-022 P2 #5). The old `else if` observed only on a step with
    // no `/cremate`, so a command step left the latch blind to its own reading and
    // the session's next crossing was judged against a stale baseline. The
    // crossing is journaled even when a manual pass also runs, and that pass
    // consumes it: `runPrune`'s finally re-arms the latch from its own reading,
    // so one step never runs two passes.
    //
    // The local reading is still measured here every boundary: it is the
    // estimate the NEXT request's usage row is reconciled against (G8,
    // ISSUE-045 D1), because this boundary ends with the state the host is about
    // to send and `assistant/message` for that request arrives after it. It is
    // NOT what the latch reads once a usage row exists (ISSUE-092, below).
    //
    // It is the WHOLE request: the fixed system+tools prefix of main's captured
    // request plus the live transcript (ADR-0009 §Amendment 2026-10-24). The
    // prefix is read from the capture's own `system` and `tools` fields — the
    // object the host dispatched — never re-rendered from config. A session
    // whose first main request is not captured yet has no prefix to count.
    //
    // What the number does NOT include is the receipt the caller appends after
    // this function returns (`publishAppend`), and — until the recompute below —
    // a cut this step's prune applied. The prune is recomputed because it
    // shrinks the transcript by design: charging its removed bytes to the
    // estimator would read as drift the meter never measured. The receipt is
    // left out and stated here: it is one short line, and the alternative is a
    // second snapshot on every step.
    const prefix = mainWire.last(entry.sessionId)?.wire ?? null;
    const snapshotNow = await entry.port.snapshot();
    let estimate = measureRequest(entry, snapshotNow, prefix);
    // ISSUE-092: the latch reads the host's billed prompt for the last
    // accounted request, with one step of staleness — the row for the request
    // in flight arrives after this boundary. The local estimate is only the
    // pre-first-usage fallback; it omits tool-call arguments and ran at ~0.56
    // of the host meter on the 078 run, so it cannot be the steady-state bar.
    // ADR-0071: an explicit bar alone arms the latch, but without a window the
    // apply leg cannot plan. Until the routed model's window resolves, no
    // automatic observation runs; the manual command still reports `no-window`.
    const windowReady = config.contextWindowTokens !== null || entry.windowTokens !== null;
    const reading = entry.pruneTrigger.enabled && windowReady
      ? entry.billedPromptTokens ?? estimate.totalTokens : null;
    const crossed = reading !== null && entry.pruneTrigger.observe(reading);
    // The automatic prune trigger (ISSUE-022 chunk 6; ADR-0050 decision 1–3):
    // the SAME seam as the command, one boundary later. The latch fires on a
    // crossing and re-arms when a pass ends or a compaction lands (CRITIC-022
    // P1-1), so a grown session re-prunes only after one re-arm bar of new
    // content — never on every step. No explicit bar and no window means the
    // latch is disabled and nothing is scheduled (record-only, ADR-0008).
    //
    // The line is written on EVERY boundary that evaluates the bar, not only on
    // a fire: a live run that never crosses must still prove which depth source
    // the bar read throughout, and `crossed` separates an evaluation (false)
    // from a fire (true). One line per boundary because the bar reads once per
    // boundary; with no bar there is no reading and no line at all.
    if (reading !== null) {
      journal('prune-threshold', { sessionId: entry.sessionId, estimatedTokens: reading,
        billedPromptTokens: entry.billedPromptTokens,
        contentTokens: estimate.contentTokens, prefixTokens: estimate.prefixTokens,
        estimate: prefix === null ? 'content' : 'content+prefix',
        barReading: entry.billedPromptTokens === null ? 'local-estimate' : 'host-billed-prompt',
        threshold: entry.pruneTrigger.threshold,
        window: entry.windowTokens,
        windowSource: config.contextWindowTokens !== null ? 'config'
          : entry.windowTokens === null ? null : 'host-model-info',
        skipAt: entry.pruneTrigger.skipThreshold, crossed });
    }
    // A `/cremate` message seen during this step runs here, after the at-rest
    // pass: that pass leaves the entry's state settled, and a prune reads that
    // state without writing any.
    // A `/cremate` command's request is scoped to the turn that claims its
    // marker message (ISSUE-535), so it cannot be consumed by an earlier turn's
    // step; the typed trigger keeps the session-wide request above.
    const commandPrune = cremateMessageId !== undefined
      && cremateRequestOf(session.id, cremateMessageId) !== undefined;
    if (pruneRequests.has(session.id) || crossed || commandPrune) {
      try {
        await runPrunePass(session, entry, signal, cremateMessageId);
        // A pass that applied changed the transcript the next request sends.
        // Re-read the estimate rather than leave the pre-pass number standing
        // (G8, ISSUE-045 D1): the row that answers the NEXT request is measured
        // against what that request will actually carry.
        const afterPrune = await entry.port.snapshot();
        estimate = measureRequest(entry, afterPrune, prefix);
      } catch (error) {
        if (cremateMessageId !== undefined) {
          cancelCremate(entry.sessionId, cremateMessageId,
            `prune pass failed: ${messageOf(error)}`);
        }
        journal('prune-error', { sessionId: entry.sessionId,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { entry, deliveries, atRest, appendRequest };
  }

  /**
   * The turn-end boundary: dsh appends `turn/end` after `agent/turn-stopping`
   * and no further pre-step follows in a one-shot run, so this is the last safe
   * place to seal an episode that just closed. Appending here is legal — the
   * dispatch is a serial hook, not the `session/event` observer.
   */
  async function runTurnEnd(session: DshMountSession, turn: number): Promise<TurnEndOutcome> {
    const known = sessions.has(session.id);
    const entry = await sessionFor(session.id, session);
    if (known) entry.retryInstallIdentity?.();
    await recoverResumedEntry(entry, session);
    // The turn-end boundary is the last chance to notice a route change in a
    // one-shot run; it re-arms and persists, but it never fires a pass
    // (ADR-0072).
    await refreshBoundaryWindow(entry);
    try { flushAppends(session, entry, config, journal); }
    catch (error) {
      journal('append-publish-failed', { sessionId: entry.sessionId,
        pending: entry.pendingAppends.length,
        message: error instanceof Error ? error.message : String(error) });
    }
    syncPass(entry, session, { completedThroughTurnOrdinal: Number(turn) });
    // A forget queued during the turn's last step applies here too: in a
    // one-shot run no pre-step follows this boundary, so a request left queued
    // would never land (ISSUE-045 chunk D2). Draining before the at-rest pass
    // means a sealed episode sees the surface the removal left.
    const forgets = await applyForgets(entry);
    if (forgets.some(outcome => outcome.status === 'applied')) {
      syncPass(entry, session, { completedThroughTurnOrdinal: Number(turn) });
    }
    const eventId = eventIdFor(session.id, 'turn', Number(turn));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    try {
      atRest = await runAtRest(entry, eventId, 'turn-end');
      appendRequest = takeAppendRequest(entry);
    } catch (error) {
      journal('at-rest-error', { sessionId: entry.sessionId, eventId,
        message: error instanceof Error ? error.message : String(error) });
    }
    // The turn is closed and the next request follows this boundary: record the
    // estimate that request will be measured against (G8, ISSUE-045 D1).
    measureRequest(entry, await entry.port.snapshot(),
      mainWire.last(entry.sessionId)?.wire ?? null);
    return { entry, atRest, appendRequest };
  }

  /**
   * Release one session's open state — the same per-entry release `close()`
   * uses (ISSUE-377): the entry leaves the open map, the owned ledger closes
   * (a close failure is swallowed, as at dispose), and the per-session call
   * facts, capture buffer, durable target and main-wire capture go with it.
   * Idempotent: an already-released or never-opened session returns false and
   * nothing closes twice. Lifecycle eviction only — no cap, no LRU, no
   * timeout (standing rule 7 / ADR-0060). The durable baseline stays on disk:
   * a reopen restores the round/latch (ISSUE-336) and replays any owed append
   * intent (ISSUE-374) through the ISSUE-341 recovery.
   */
  async function releaseSession(sessionId: string,
    reason: 'session/end' | 'close'): Promise<boolean> {
    const entry = sessions.get(sessionId);
    if (entry !== undefined) {
      sessions.delete(sessionId);
      // ISSUE-451: evict this life's maps BEFORE the ledger-close await. The
      // await yields, and the host may reopen the same id (ISSUE-374) into a
      // fresh entry; evicting afterwards would delete state that new life wrote.
      evictSessionState(sessionId);
      if (entry.ownedLedger) await entry.ledger.close().catch(() => {});
    } else {
      evictSessionState(sessionId);
    }
    return entry !== undefined;
  }

  /**
   * Evict every mount-wide map keyed by one session id (ISSUE-402, ISSUE-433,
   * ISSUE-434). Eviction is not gated on an open entry: `observe` fills the call
   * facts, captures, prune request and main wire before any entry exists, and
   * the storage bookkeeping (`openFailures`, `unavailable`, `planned`) encodes
   * one session's lifecycle. A reopen therefore starts with no carried-over
   * state, a fresh retry allowance and its own named storage lines. Lifecycle
   * eviction only — no cap, no LRU, no timeout (standing rule 7 / ADR-0060).
   */
  function evictSessionState(sessionId: string): void {
    calls.delete(sessionId);
    buffers.delete(sessionId);
    targets.delete(sessionId);
    // A `/cremate` request is per-session state too (ISSUE-402): one recorded
    // and never consumed must not survive the eviction and fire a paid pass on
    // a later reopen of the same id. `runPrune` already cleared its own on
    // consumption, so an evicted-but-consumed request leaves nothing here.
    pruneRequests.delete(sessionId);
    // A command card waiting on a vanished session fails by name instead of
    // waiting on state this eviction is releasing (ISSUE-535).
    abandonCremateWaits(sessionId, 'the session was released before the cremation pass ran');
    mainWire.evict(sessionId);
    openFailures.delete(sessionId);
    unavailable.delete(sessionId);
    planned.delete(sessionId);
  }

  /**
   * Every session id this mount holds state for, whether or not an entry was
   * ever opened (ISSUE-433). `observe` fills the maps before the first pre-step,
   * and `observeWire` can fill the main-wire store before any `session/event`,
   * so `close()` enumerates every one of them (ISSUE-455) and not only
   * `sessions`.
   */
  function observedSessionIds(): string[] {
    return [...new Set([...sessions.keys(), ...calls.keys(), ...buffers.keys(),
      ...targets.keys(), ...pruneRequests, ...cremateRequests.keys(),
      ...openFailures.keys(), ...unavailable, ...planned, ...mainWire.sessionIds()])];
  }

  /**
   * Register one boundary's work for the drain to await (ISSUE-397, ISSUE-401).
   * EVERY boundary registers its own promise and a settled promise removes only
   * its own registration, so two boundaries overlapping on one session (an ask
   * and a direct `runPrune`) are both held, in whatever order they settle.
   * Tracking work, never permission: a boundary that never started is not here.
   */
  function trackBoundary<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const promise = work();
    const inFlight = boundaries.get(sessionId) ?? new Set<Promise<unknown>>();
    boundaries.set(sessionId, inFlight);
    inFlight.add(promise);
    const settle = (): void => {
      inFlight.delete(promise);
      if (inFlight.size === 0 && boundaries.get(sessionId) === inFlight) {
        boundaries.delete(sessionId);
      }
    };
    void promise.then(settle, settle);
    return promise;
  }

  /**
   * Run one host tool call's ledger/durable work as a tracked boundary
   * (ISSUE-435). `forget` and `recall` touch the same ledger and durable state
   * as a step, so `endSession` and `close()` must wait them out before the
   * entry is released; otherwise a recall reads a closed ledger and a forget
   * writes after `session-evicted`. A call that starts once `close()` began is
   * refused by name instead of racing the release. Tracking work, never
   * permission; no cap or timeout (standing rule 7 / ADR-0060).
   */
  function runToolWork<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (closing) throw new RacoonsClosingError(sessionId);
    return trackBoundary(sessionId, work);
  }

  /**
   * Wait out every in-flight boundary of one session (ISSUE-397, ISSUE-401).
   * The loop re-checks because a settling boundary can hand off to another
   * tracked call; each ask is already bounded by its own declared ask deadline,
   * so the drain adds no cap or timeout of its own (standing rule 7 /
   * ADR-0060).
   */
  async function drainBoundaries(sessionId: string): Promise<void> {
    for (;;) {
      const inFlight = boundaries.get(sessionId);
      if (inFlight === undefined) return;
      const pending = [...inFlight];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** The `close()` drain (ISSUE-401): every session's boundaries, re-checked. */
  async function drainAllBoundaries(): Promise<void> {
    for (;;) {
      const pending = [...boundaries.values()].flatMap((inFlight) => [...inFlight]);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * The `close()` drain for in-flight session ends (ISSUE-453). An end's
   * release is not a boundary: it can be parked inside `ledger.close()`, and a
   * shutdown that resolved before that settled would let an eviction line land
   * after close. Re-checked because the release loop can meet work registered
   * while it ran. No cap or timeout (standing rule 7 / ADR-0060).
   */
  async function drainEndings(): Promise<void> {
    for (;;) {
      const pending = [...endings.values()]
        .flatMap((live) => [...live].map((ending) => ending.promise));
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Flush one session's committed-but-unpublished appends (ISSUE-342), fail-open
   * like every boundary. A session opened with no host has no surface to append
   * to, so its queue stays in-process (there is nothing to publish it to).
   */
  function flushOwed(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    const session = entry.host;
    if (session === null) return;
    try { flushAppends(session, entry, config, journal); }
    catch (error) {
      journal('append-publish-failed', { sessionId: entry.sessionId,
        pending: entry.pendingAppends.length,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Wait out the other ends registered for one id (ISSUE-473). An end that
   * finds no mapped entry evicts the observed state and has nothing to release,
   * but an earlier life's release may still be parked inside `ledger.close()`;
   * its caller must not see the id as ended before that settles. The caller's
   * own registration is excluded so the wait cannot deadlock, and the loop
   * re-checks because the releases it awaits can hand off to another end. No
   * cap or timeout (standing rule 7 / ADR-0060).
   */
  async function drainOtherEndings(sessionId: string, own: SessionEnding): Promise<void> {
    for (;;) {
      const pending = [...(endings.get(sessionId) ?? [])]
        .filter((ending) => ending !== own)
        .map((ending) => ending.promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * The session-end drain+release (ISSUE-377). Yields out of the
   * `session/event` observer's synchronous dispatch first — the host forbids
   * appends inside it, and the drain appends. Flushes the committed-but-
   * unpublished appends through the ISSUE-342 path BEFORE releasing, so a
   * graceful end loses no committed records; a failed flush journals and
   * still releases (fail-open) — the durable intent (ISSUE-374) keeps the
   * owed records replayable on reopen. Buffered captures need no drain: the
   * surface still holds them and the ISSUE-341 recovery re-queues them at the
   * reopened entry's first boundary. A second call coalesces with the
   * in-flight eviction for the same mapped entry, so an awaiter settles the
   * same work; a life that does not coalesce (a reopen, or no mapped entry at
   * all) registers its own end beside every other live one (ISSUE-452,
   * ISSUE-473). EVERY in-flight boundary is awaited FIRST (ISSUE-397,
   * ISSUE-401): their tails run on the open entry and any appends they commit
   * belong to the flush below.
   */
  function endSession(session: DshMountSession): Promise<void> {
    const current = sessions.get(session.id);
    const inFlight = endings.get(session.id);
    // ISSUE-452: coalesce only with the end that owns the entry currently
    // mapped. A reopen installs a new life, whose own end must release it;
    // ISSUE-473: every other live end stays registered beside this one.
    if (inFlight !== undefined) {
      for (const ending of inFlight) {
        if (ending.entry === current) return ending.promise;
      }
    }
    const registration: SessionEnding = { entry: current, promise: Promise.resolve() };
    const live = endings.get(session.id) ?? new Set<SessionEnding>();
    const settle = (): void => {
      live.delete(registration);
      if (live.size === 0 && endings.get(session.id) === live) endings.delete(session.id);
    };
    const work = (async () => {
      await Promise.resolve();
      // Wait out EVERY running boundary before the flush+release, not only the
      // first one registered (ISSUE-401). A failed boundary already journaled
      // its own error; the release still proceeds (fail-open), exactly as a
      // failed flush does.
      await drainBoundaries(session.id);
      const entry = sessions.get(session.id);
      if (entry === undefined) {
        // ISSUE-433: a session that never opened an entry still has observed
        // state (call facts, captures, a pending /cremate request, main wire,
        // storage bookkeeping). Evict it here; the release path is unreachable
        // for an id `sessions` does not hold. ISSUE-473: this end settles only
        // after any earlier release for the id settles too.
        evictSessionState(session.id);
        await drainOtherEndings(session.id, registration);
        return;
      }
      try { flushAppends(session, entry, config, journal); }
      catch (error) {
        journal('append-publish-failed', { sessionId: entry.sessionId,
          pending: entry.pendingAppends.length,
          message: error instanceof Error ? error.message : String(error) });
      }
      if (await releaseSession(session.id, 'session/end')) {
        journal('session-evicted', { sessionId: session.id, reason: 'session/end' });
      }
    })().finally(settle);
    registration.promise = work;
    live.add(registration);
    endings.set(session.id, live);
    return work;
  }

  return { sessions, counters, observedSessionIds, sessionFor, syncTranscript, observe, requestPrune,
    beginCremate, claimCremate, cancelCremate, abandonCremateWaits,
    observeWire,
    // Each public boundary registers its work so a concurrent `endSession`
    // waits it out before releasing (ISSUE-397). Internal calls (the tail
    // prune inside a step) ride the outer boundary's registration.
    runStep: (session: DshMountSession, ordinals: { turn: number; step: number },
      signal?: AbortSignal, cremateMessageId?: string) =>
      trackBoundary(session.id, () => runStep(session, ordinals, signal, cremateMessageId)),
    runTurnEnd: (session: DshMountSession, turn: number) =>
      trackBoundary(session.id, () => runTurnEnd(session, turn)),
    runPrune: (session: DshMountSession, signal?: AbortSignal) =>
      trackBoundary(session.id, () => runPrune(session, undefined, signal)),
    runToolWork,
    emitJournal: journal,
    endSession,
    close: async () => {
      // A shutdown, not a release loop (ISSUE-416). The guard first, so a
      // pre-step or turn-end delivered during the awaits below is refused by
      // name instead of reopening a released session or opening a ledger
      // nothing closes. Then owed appends flush; running boundaries drain
      // (ISSUE-401) — their tails may commit more appends, so the flush is
      // repeated after the drain; only then does every entry leave through the
      // same release the session/end eviction uses (ISSUE-377).
      closing = true;
      for (const sessionId of [...sessions.keys()]) flushOwed(sessionId);
      await drainAllBoundaries();
      // ISSUE-453: an in-flight session-end release is outside `boundaries`.
      // Await every one before releasing, so a gated ledger close can never
      // finish (and journal `session-evicted`) after close() resolved.
      await drainEndings();
      // ISSUE-433: every id with observed state is released, not only the ids
      // that opened an entry, so a shutdown leaves no map holding a dead id.
      for (const sessionId of observedSessionIds()) {
        flushOwed(sessionId);
        await releaseSession(sessionId, 'close');
      }
      // An end started while the release loop awaited settles before close too.
      await drainEndings();
    } };
}

/**
 * Flush the append applications the port committed but the host may not hold
 * yet (ISSUE-342), in commit order. A request leaves the queue only once
 * `publishAppend` succeeds; a transient throw propagates with the failed
 * request still at the head, so the next boundary retries it (idempotent by
 * record id) instead of letting the ledger claim applied while the surface
 * lacks the records. Once the queue drains, the durable intent is cleared
 * (ISSUE-374): a death mid-flush leaves the durable record standing, and the
 * replay skips whatever already landed, so clearing only at a full drain is
 * safe.
 *
 * ISSUE-523 item 2: a PERMANENT failure at the head is set aside instead of
 * stalling the rows behind it. A record the host can never accept (no record
 * id, or bytes that are not bytes) or a throw that states its own permanence
 * (`permanent: true`, or a `code` this mount treats as permanent) leaves the
 * queue with a named `append-publish-failed` row, and the flush carries on
 * with the next request. A transient throw still stops the flush: retrying is
 * what makes a durable intent durable.
 */
export function flushAppends(session: DshMountSession, entry: RacoonsSessionEntry,
  config: ResolvedRacoonsConfig, journal?: MountJournal): DshMountEvent[] {
  const events: DshMountEvent[] = [];
  let drained = false;
  const setAside = (request: RacoonsApplicationRequest, code: string, message: string): void => {
    entry.pendingAppends.shift();
    drained = true;
    journal?.('append-publish-failed', { sessionId: entry.sessionId, permanent: true, code,
      intentId: request.intent.intentId, pending: entry.pendingAppends.length, message });
  };
  while (entry.pendingAppends.length > 0) {
    const request = entry.pendingAppends[0];
    if (request === undefined) break;
    const poison = poisonAppendCodeOf(request);
    if (poison !== null) {
      setAside(request, poison, 'the request carries a record the host can never accept');
      continue;
    }
    try {
      events.push(...publishAppend(session, request, config));
    } catch (error) {
      const permanent = permanentAppendCodeOf(error);
      if (permanent === null) throw error;
      setAside(request, permanent, error instanceof Error ? error.message : String(error));
      continue;
    }
    entry.pendingAppends.shift();
    drained = true;
  }
  if (drained) entry.persistPendingAppends?.();
  return events;
}

/**
 * A contract defect in one queued request that no retry can fix: a record with
 * no id, or bytes that are not a byte array (ISSUE-523 item 2). Detected
 * BEFORE `publishAppend` so a poison row cannot land part of its list first.
 * `null` means the request is well-formed.
 */
function poisonAppendCodeOf(request: RacoonsApplicationRequest): string | null {
  for (const record of request.application.appendRecords) {
    if (typeof record.recordId !== 'string' || record.recordId.length === 0) {
      return 'append-record-no-id';
    }
    if (!(record.bytes instanceof Uint8Array)) return 'append-record-invalid-bytes';
  }
  return null;
}

/**
 * The code a thrown append states for itself when retrying cannot help, or
 * `null` for a transient host failure (ISSUE-523 item 2). The host is the only
 * party that knows a refusal is permanent, so it says so: `permanent: true`
 * with its own `code`, or one of the codes this mount reads as permanent. A
 * permission denial is not in that set: a restart may lift it, so it must state
 * `permanent: true` before the mount sets its records aside.
 */
function permanentAppendCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { readonly permanent?: unknown; readonly code?: unknown };
  const code = typeof value.code === 'string' && value.code.length > 0 ? value.code : null;
  if (value.permanent === true) return code ?? 'append-publish-permanent';
  return code !== null && PERMANENT_APPEND_CODES.has(code) ? code : null;
}

/**
 * Host refusal codes retrying cannot resolve: the surface cannot hold the
 * record, ever. A transient code (a lock, a busy file, a denial that a restart
 * may lift) is absent here on purpose and stays queued; such a failure must
 * state its own `permanent: true` to be set aside.
 */
const PERMANENT_APPEND_CODES: ReadonlySet<string> = new Set([
  'unsupported', 'invalid-argument', 'invalid-record',
]);

/**
 * The queue's replay payload (ISSUE-374): every owed record in commit order,
 * bytes as base64 so the durable JSON file stays lossless. Request boundaries
 * are not carried — `publishAppend` is idempotent per record id, so one flat
 * ordered list replays exactly what the queue owed.
 */
function durableAppendsOf(requests: readonly RacoonsApplicationRequest[]): DurableAppendRecord[] {
  const records: DurableAppendRecord[] = [];
  for (const request of requests) {
    for (const record of request.application.appendRecords) {
      records.push({ recordId: record.recordId,
        bytesBase64: Buffer.from(record.bytes).toString('base64') });
    }
  }
  return records;
}

/** One queued forget as the durable mount state stores it (ISSUE-417). */
function durableForgetOf(decision: DshForgetScheduled): DurableForget {
  return { eventId: decision.eventId, unitId: decision.unitId,
    source: decision.request.source, label: decision.request.label,
    ranges: decision.ranges.map(range => ({ ...range })) };
}

/**
 * What this session's own ledger says about whether it already ran here
 * (ISSUE-460). A fork's copied rows carry the parent's id, so only this
 * session's own past reads `rows`. ISSUE-573: a read failure answers
 * `unreadable`, never `none` — the caller must not read a ledger it could not
 * read as "no history" and classify a restart as a fresh install.
 */
async function ledgerRowEvidence(ledger: Ledger, sessionId: string):
Promise<'rows' | 'none' | 'unreadable'> {
  try {
    for await (const row of ledger.events(sessionId)) {
      if (row !== null) return 'rows';
    }
    return 'none';
  } catch {
    return 'unreadable';
  }
}

/**
 * Collect the durable receipts whose intents the ledger already records as
 * `applied` (ISSUE-436). A receipt exists for the crash window before that row
 * (ISSUE-417); once the row is durable the copy has no reader. A failed ledger
 * read keeps every receipt (fail-open) and the next mount retries the sweep.
 */
async function collectSettledReceipts(target: ResolvedRacoonsStorage,
  receipts: readonly ApplyReceipt[], ledger: Ledger, journal: MountJournal,
  sessionId: string): Promise<ApplyReceipt[]> {
  try {
    const applied = new Set<string>();
    for await (const row of ledger.events(sessionId)) {
      if (row.event.kind === 'applied') applied.add(row.event.receipt.intentId);
    }
    if (applied.size === 0) return [...receipts];
    for (const receipt of receipts) {
      if (applied.has(receipt.intentId)) {
        removeDurableReceipt(target, receipt.intentId, journal, sessionId);
      }
    }
    return receipts.filter(receipt => !applied.has(receipt.intentId));
  } catch {
    return [...receipts];
  }
}

/** One durable forget rebuilt as the queue's own record (ISSUE-417). */
function forgetFromDurable(record: DurableForget): DshForgetScheduled {
  return { status: 'scheduled', eventId: record.eventId as EventId,
    unitId: record.unitId as UnitId,
    request: { source: record.source,
      ranges: record.ranges.map(range => ({ ...range })), label: record.label },
    ranges: record.ranges.map(range => ({ ...range })) };
}

/**
 * One replay request over the recovered records (ISSUE-374). Only the fields
 * `publishAppend` reads are carried — the intent, receipts and archives of the
 * original application already committed to the ledger before the death; the
 * replay owes the host its records, nothing else.
 */
function replayAppendRequest(records: readonly DurableAppendRecord[]): RacoonsApplicationRequest {
  const request = { application: { mode: 'append',
    appendRecords: records.map(record => ({ recordId: record.recordId,
      bytes: new Uint8Array(Buffer.from(record.bytesBase64, 'base64')) })) } };
  return request as unknown as RacoonsApplicationRequest;
}

/**
 * Publish the append application the port just committed: every generated record
 * becomes one appended `user/message` carrying its rendered text.
 *
 * Idempotent by record id (ISSUE-342): a record already on the surface is skipped,
 * so a retry after a mid-list throw resumes at the record the host never received
 * rather than duplicating the ones that landed. The surface is the host's own
 * record of what it holds; a record's `source.recordId` is its stable identity.
 */
export function publishAppend(session: DshMountSession, request: RacoonsApplicationRequest,
  config: ResolvedRacoonsConfig): DshMountEvent[] {
  const landed = new Set<string>();
  for (const seq of session.surface?.nodes ?? []) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'user/message') continue;
    const data = isRecord(event.data) ? event.data : {};
    const source = isRecord(data['source']) ? data['source'] : {};
    // ISSUE-574: the row was stamped with whatever `recordName` was in force
    // when it landed, and a replay may mount under a different one; recordId
    // alone is the stable identity the dedupe promises.
    if (typeof source['recordId'] === 'string') {
      landed.add(source['recordId']);
    }
  }
  const events: DshMountEvent[] = [];
  for (const record of request.application.appendRecords) {
    if (landed.has(record.recordId)) continue;
    const text = new TextDecoder().decode(record.bytes);
    events.push(session.append('user/message', {
      content: [{ type: 'text', text }],
      source: { kind: config.recordName, recordId: record.recordId },
      role: 'user',
      id: randomUUID(),
    }, { surfaceOp: 'append' }));
  }
  return events;
}

/**
 * The one live session this process is driving. dsh's turn-stopping hook may
 * carry no agent, and the headless profile runs exactly one session per process,
 * so the store's single live session is that turn's owner. More than one live
 * session means this hook cannot know which one ended: it refuses rather than
 * guess.
 */
export function singleLiveSession(ctx: DshMountContext): DshMountSession | undefined {
  const store = ctx.sessions;
  if (store === undefined || typeof store.list !== 'function') return undefined;
  const live = store.list();
  return live.length === 1 ? live[0] : undefined;
}

/**
 * The caller's session id as the host tool context can name it (ISSUE-415).
 * dsh hands the tool call's context to `execute`; the identity may ride on
 * `session`, `agent.session`, or a plain `sessionId`/`sessionID`. Any shape
 * that names one session resolves; no shape returns `undefined`, never a guess.
 */
function sessionIdFromContext(context: unknown): string | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const value = context as {
    readonly session?: { readonly id?: unknown };
    readonly sessionId?: unknown;
    readonly sessionID?: unknown;
    readonly agent?: {
      readonly session?: { readonly id?: unknown };
      readonly sessionId?: unknown;
    };
  };
  for (const candidate of [value.session?.id, value.sessionId, value.sessionID,
    value.agent?.session?.id, value.agent?.sessionId]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** A named refusal: the `name` states the condition the caller must fix. */
function sessionError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Re-queue every claimed message except one (ISSUE-535). A rejected pre-step
 * drops its whole claimed batch, so the mount puts the other messages back for
 * the next step — the same restore dsh's goal-round driver performs before it
 * rejects a step. `agent.send(..., 'next-step', true)` is preferred because it
 * also wakes the driver, so a restored user message still runs after the
 * command's turn closes; the plain prepend is the structural fallback and
 * keeps the original order.
 */
function restoreClaimed(agent: {
  readonly inbox?: { prepend?(target: string, message: unknown): void };
  send?(message: unknown, target: string, wakeup: boolean): void;
} | undefined, messages: readonly unknown[] | undefined, skipId: string): void {
  const restored = (messages ?? []).filter((message) => {
    const id = isRecord(message) ? message['id'] : undefined;
    return typeof id !== 'string' || id !== skipId;
  });
  const send = agent?.send;
  if (typeof send === 'function') {
    for (const message of restored) send.call(agent, message, 'next-step', true);
    return;
  }
  const prepend = agent?.inbox?.prepend;
  if (typeof prepend !== 'function') return;
  for (const message of [...restored].reverse()) prepend.call(agent?.inbox, 'next-step', message);
}

/** How many live sessions the host reports; a direct mount counts its own. */
function liveSessionCount(ctx: DshMountContext, mount: RacoonsMount): number {
  const store = ctx.sessions;
  if (store !== undefined && typeof store.list === 'function') return store.list().length;
  return mount.sessions.size;
}

/**
 * The mount entry a tool call answers from (ISSUE-415). The caller's own
 * session wins when the host context names one. Otherwise the single live
 * session is used, and a mount driven directly (no `ctx.sessions` store) still
 * answers from its only opened entry. More than one live session and no
 * identity is a refusal by name: the wrong session must never be mutated.
 */
function resolveLiveEntry(mount: RacoonsMount, ctx: DshMountContext,
  context: unknown, tool: 'forget' | 'recall'): RacoonsSessionEntry {
  const namedId = sessionIdFromContext(context);
  if (namedId !== undefined) {
    const entry = mount.sessions.get(namedId);
    if (entry !== undefined) return entry;
    throw sessionError('CrematorToolSessionError',
      `cremator: ${tool} refused: the tool context names session ${namedId},`
      + ' but the mount has no open entry for it');
  }
  const named = singleLiveSession(ctx);
  if (named !== undefined) {
    const entry = mount.sessions.get(named.id);
    if (entry !== undefined) return entry;
  }
  const live = liveSessionCount(ctx, mount);
  if (live > 1) {
    throw sessionError('CrematorAmbiguousSessionError',
      `cremator: ${tool} refused: ${String(live)} live sessions and no caller`
      + ' session in the host tool context; the call must name its session');
  }
  const only = mount.sessions.size === 1 ? [...mount.sessions.values()][0] : undefined;
  if (only !== undefined) return only;
  throw sessionError('CrematorToolSessionError',
    `cremator: ${tool} has no live session to read from`);
}

/**
 * The sessions an unnamed `agent/turn-stopping` must seal (ISSUE-415). With a
 * host store it is every live session; a mount driven directly (no store)
 * falls back to the host sessions it has open. Every returned session is
 * sealed — more than one is never a reason to skip, and the only empty result
 * is a genuinely session-less mount.
 */
function liveTurnEndSessions(mount: RacoonsMount, ctx: DshMountContext): DshMountSession[] {
  const store = ctx.sessions;
  if (store !== undefined && typeof store.list === 'function') return [...store.list()];
  const out: DshMountSession[] = [];
  for (const entry of mount.sessions.values()) if (entry.host !== null) out.push(entry.host);
  return out;
}

/**
 * The host tool registry, when the context provides one. Resolved through
 * `ctx.get` so an unavailable service is a miss, not a proxy throw.
 */
export function resolveToolHost(ctx: DshMountContext,
  fallback: DshToolHost | undefined): DshToolHost | undefined {
  if (fallback !== undefined) return fallback;
  let value: unknown;
  try {
    value = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  } catch {
    return undefined;
  }
  if (value === undefined) {
    try { value = ctx.tools; } catch { return undefined; }
  }
  return isRecord(value) && typeof value['register'] === 'function'
    ? value as unknown as DshToolHost : undefined;
}

/**
 * Register the handler-backed tools once, at mount, and return one disposer.
 * `DSH_TOOL_SPECS` declares `forget` and `recall`, and both have execution
 * paths, so both are registered — no model is ever offered a tool that would
 * fail (design-protocol §4; ISSUE-045 chunk D2 added the forget handler).
 *
 * The host's `register` takes a `ToolDefinition` (schema plus a mandatory
 * `output` declaration), while the adapter's seam is `{ spec, execute }`. The
 * mapping lives here so the package still carries no dsh dependency, and so the
 * unregister the host returns is the only disposal contract this file relies on.
 *
 * Registration is all-or-nothing: a host that refuses the second tool leaves
 * neither registered, so a mount can never advertise half its inventory.
 *
 * `execute` must return the projected output, never a raw ledger record: the
 * record carries `Uint8Array` bodies, and the host snapshots every tool value
 * as lossless JSON (`snapshotJsonValue`; non-JSON is `INVALID_TOOL_OUTPUT`).
 * `recallText` is the recall projection — verified bytes decoded as UTF-8, so it
 * is also the second hash check between the ledger and the model — and
 * `forgetAnswerText` is the forget projection: a scheduled request or the
 * lookup's own refusal, never archived bytes.
 */
export function registerPluginTools(host: DshToolHost, sources: DshToolSources): () => void {
  const registrations = createDshTools(sources);
  const registered: (() => void)[] = [];
  try {
    for (const tool of registrations) {
      registered.push(host.register(hostTool(tool) as never));
    }
  } catch (error) {
    for (const unregister of registered.reverse()) {
      try { unregister(); } catch { /* best effort on a failed mount */ }
    }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of registered.reverse()) {
      try { unregister(); } catch { /* teardown only */ }
    }
  };
}

/**
 * The host's `ToolDefinition` as this package reads it: the adapter seam plus
 * the mandatory `output` declaration. Structural, so the package still carries
 * no dsh dependency.
 */
interface DshHostTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>;
    render(args: unknown, value: unknown): unknown;
  };
  execute(args: unknown, context?: unknown): Promise<unknown>;
}

/**
 * One registration as the host's `ToolDefinition`. `render` turns the canonical
 * JSON value into the one text block the model reads, so the raw value never
 * reaches it. The adapter's seam is `{spec, execute}`; the mandatory `output`
 * declaration is dsh's, so it lives here and not in `tools.ts`.
 */
function hostTool(tool: DshToolRegistration): DshHostTool {
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    output: {
      // Both payloads are objects; this unconstrained schema accepts them.
      schema: {},
      render: (_args: unknown, value: unknown): unknown => [{ type: 'text',
        text: tool.spec.name === 'forget' ? forgetAnswerText(value) : recallBodyText(value) }],
    },
    execute: async (args: unknown, context?: unknown): Promise<unknown> =>
      tool.execute(args, context),
  };
}

/**
 * The recall answer's one text block: its restored body, every part of a
 * multi-part restore, or nothing. The projection (`tools.ts` `recallText`) sets
 * `text` only when exactly one part exists; a multi-part record has no single
 * body, so it renders as JSON naming each part separately — the same shape the
 * opencode mount's `recallOutputText` produces — and never a join (ADR-0003).
 */
function recallBodyText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value['text'] === 'string') return value['text'];
  const parts = value['parts'];
  if (!Array.isArray(parts) || parts.length === 0) return '';
  return JSON.stringify({ recallId: value['recallId'], text: null,
    byteLength: value['byteLength'], parts });
}

/**
 * One live mount in this process and how many applies hold it (ISSUE-424,
 * ISSUE-577; ADR-0075).
 */
interface ActivePluginMount {
  readonly mount: RacoonsMount;
  /**
   * The config the mount was constructed with. A joined apply wires its own
   * ctx's hooks, but its append flushing must follow the plan the mount was
   * built with, never the options it passed and could not change.
   */
  readonly config: ResolvedRacoonsConfig;
  /** Live applies on this mount; it closes when the last one releases. */
  shares: number;
  /**
   * The `/cremate` registration this mount owns (ISSUE-603). One per mount,
   * never one per apply: the command's lifetime is the mount's long-lived
   * scope, and a joined apply or a rebuilt surface refreshes that same entry
   * instead of seeding a second one.
   */
  command?: CommandSurfaceState;
}

/**
 * One mount's live `/cremate` registration (ISSUE-603). The host lists
 * commands per agent through `list(agent)` and refreshes that view when it
 * emits `commands/change`; the entry is made when the mount is created and
 * disposed only when the last holder closes the mount.
 */
interface CommandSurfaceState {
  readonly command: DshCommand;
  /** The live registration's disposer; replaced, never kept past death. */
  unregister?: (() => void) | undefined;
}

/** Drop a surface's registration; a dead scope's disposer must not throw. */
function disposeCommandSurface(surface: CommandSurfaceState | undefined): void {
  if (surface === undefined) return;
  const dispose = surface.unregister;
  surface.unregister = undefined;
  if (dispose === undefined) return;
  try { dispose(); } catch { /* the entry died with its scope */ }
}

/**
 * The process-level registry (ISSUE-424, ISSUE-577; ADR-0075 decision 3): one
 * live mount per durable root, joined by every later apply. A mount's ledger
 * paths depend on the resolved root and the session id only — never on the
 * journal, the knobs or the bar — so two mounts over one root would open two
 * ledgers and two mount-state writers for the same session. A second apply
 * therefore gets the live mount, never a second one, and the mount closes when
 * its last holder releases. `':memory:'` has no durable identity and is not
 * tracked, so tests may apply as many memory mounts as they need.
 */
const activePluginMounts = new Map<string, ActivePluginMount>();

/**
 * The identity "same durable root" means for the registry (ADR-0066 decisions 1
 * and 3, ISSUE-498): the resolved storage root, normalized to the one directory
 * it names. No configuration option that leaves the ledger path alone splits
 * the key. `null` for a memory apply, which is never registered.
 */
function pluginApplyKey(storage: { databasePath: string; root?: string }): string | null {
  if (storage.databasePath === ':memory:') return null;
  // A host-supplied durable plan with no root keys on its own template path;
  // `resolveStorage` derives that template from the root, so one root still
  // yields one key.
  return storage.root === undefined ? storage.databasePath : normalizeMountRoot(storage.root);
}

/**
 * Create the shipped mount plugin. The returned object is the Cordis plugin
 * itself: `{ name, inject, apply }`.
 *
 * `apply(ctx, config)` merges the patch row's config over the factory defaults,
 * so a `--patch` row can tune thresholds without code.
 */
export function createRacoonsPlugin(options: RacoonsPluginOptions = {}): {
  readonly name: string;
  readonly inject: readonly string[];
  apply(ctx: DshMountContext, config?: RacoonsPluginConfig): Promise<void>;
} {
  const nowMs = options.nowMs ?? (() => Date.now());
  return {
    name: CREMATOR_PLUGIN_NAME,
    inject: CREMATOR_PLUGIN_INJECT,
    async apply(ctx, rawConfig) {
      const config = resolvePluginConfig({ ...options.config, ...rawConfig },
        { hostModelInfo: typeof ctx.llm?.resolveModelInfo === 'function' });
      const storage = resolveStorage(options.storage, config.crematorStorageRoot);
      /**
       * ISSUE-424 / ISSUE-577 / ADR-0075: one live mount per durable root. The
       * registry is read before any session opens a ledger, so a second apply
       * can never construct a second ledger for the same session; the second
       * apply JOINS the live mount instead of being refused (ADR-0075 decision
       * 2: never refuse or block). The host's fiber unload releases this
       * holder, and the last release closes the mount.
       */
      const registryKey = pluginApplyKey(storage);
      const joined = registryKey === null ? undefined : activePluginMounts.get(registryKey);
      // A host-supplied ledger wins; otherwise the default plan is durable
      // (ADR-0013) and `':memory:'` only appears when a test asks for it.
      const ledgerSource = options.openLedger !== undefined ? 'host'
        : storage.databasePath === ':memory:' ? 'memory' : 'durable';
      // The host's model seam: the same `llm` service dsh-compaction-basic
      // drives. Absent, both surviving asks (ADR-0028: the entry checkpoint
      // and the bulk prune) journal their own off-lines instead of pretending
      // they asked.
      const llm = ctx.llm ?? undefined;
      const warn = (message: string): void => {
        try { ctx.logger?.warn?.(`racoons: ${message}`); } catch { /* logging only */ }
      };
      /**
       * The wiring's own journal for a flush's set-aside row (ISSUE-523 item 2).
       * The mount keeps its journal private; this one reaches the same sink the
       * mount was given and swallows a sink failure exactly as the mount does.
       */
      const wiringJournal: MountJournal = (kind, fields): void => {
        const emit = options.journal;
        if (emit === undefined) return;
        try { emit(Object.freeze({ kind, atMs: nowMs(), ...fields }) as RacoonsJournalRecord); }
        catch { /* a sink must never alter outcomes */ }
      };
      let mount: RacoonsMount;
      /**
       * The plan the wiring below flushes against: the live mount's own when
       * this apply joined, the resolved config when it created the mount. A
       * joined apply's options cannot change a mount that already exists; the
       * `mount-shared` line names that they were not adopted.
       */
      let wiringConfig: ResolvedRacoonsConfig;
      if (joined !== undefined) {
        joined.shares += 1;
        mount = joined.mount;
        wiringConfig = joined.config;
      } else {
        mount = createRacoonsMount({ config, storage, clock: { nowMs },
          ...llm === undefined ? {} : { llm },
          ...options.judgeRoute === undefined ? {} : { judgeRoute: options.judgeRoute },
          ...options.openLedger === undefined ? {} : { openLedger: options.openLedger },
          ...options.journal === undefined ? {} : { journal: options.journal },
          warn });
        wiringConfig = config;
        if (registryKey !== null) {
          activePluginMounts.set(registryKey, { mount, config, shares: 1 });
        }
      }
      /**
       * ISSUE-578 / ADR-0075: record this mount under the root's `mounts/`
       * folder, so another process on the same folder can see it exists. The
       * create never collides and never refuses; an unwritable folder is
       * journaled and the mount continues without a record — no mount is
       * admitted on the strength of a record, and the shared ledger's own
       * write lock (`mount-state.ts`) is what keeps two mounts' facts apart.
       */
      let mountRecord: MountRecordFile | null = null;
      if (storage.root !== undefined) {
        mountRecord = joinMountRecords(storage.root);
        if (mountRecord === null) {
          mount.emitJournal('mount-record-error', { storageRoot: storage.root,
            reason: 'the mounts folder or its record could not be written; '
              + 'mounting without a record' });
        }
      }
      /** Live mount records this process can see on the root, this one included. */
      const liveMountRecords = storage.root === undefined
        ? 0 : readMountRecords(storage.root).length;
      /**
       * The `/cremate` surface this apply holds (ISSUE-603), assigned below
       * when the host has a command registry. It lives on the mount record, so
       * the last holder's release is what disposes it.
       */
      let ownedSurface: CommandSurfaceState | undefined;
      /**
       * ISSUE-577: a second apply of one root holds the same mount, so its
       * unload must not close the ledgers the other holder is still using —
       * only the last release closes anything. Registered before the wiring, so
       * an apply that throws partway still releases its holder when the host
       * unloads the fiber (ISSUE-424's cleanup rule). ISSUE-578: this holder's
       * own mount record goes with it, whatever the share count says.
       */
      ctx.effect?.(() => async () => {
        try {
          if (registryKey !== null) {
            const held = activePluginMounts.get(registryKey);
            if (held !== undefined && held.mount === mount) {
              held.shares -= 1;
              if (held.shares > 0) return;
              activePluginMounts.delete(registryKey);
            }
          }
          // The command's lifetime is the mount's; it goes before the mount it
          // calls into, and only when this holder is the one closing.
          disposeCommandSurface(ownedSurface);
          await mount.close();
        } finally {
          if (mountRecord !== null) releaseMountRecord(mountRecord);
        }
      }, 'racoons.close()');
      if (joined !== undefined) {
        // ISSUE-577 / ADR-0075: name the join and that this apply's options
        // were not adopted, so a differing knob reads as a join, never as a
        // mount that silently followed the second configuration.
        mount.emitJournal('mount-shared', {
          status: 'reused', scope: 'process',
          shares: joined.shares,
          // The line names the configured ROOT, never a derived path (the
          // `mounted` line's rule).
          ...storage.root === undefined
            ? { storage: storage.databasePath } : { storageRoot: storage.root },
          // ISSUE-578: the mount records this process can see, this one
          // included, and this mount's own record when it has one.
          mounts: liveMountRecords,
          ...mountRecord === null ? {} : { record: mountRecord.path },
        });
      } else {
        // Typed, not cast: `kind` must be a member of the closed journal
        // vocabulary, so the mount line can never drift from the union
        // (CRITIC-022 P3 #14).
        const mountedLine: RacoonsJournalRecord = Object.freeze({
          kind: 'mounted', atMs: nowMs(),
          episodeNoNewPathSteps: config.episodeNoNewPathSteps, barBytes: config.barBytes,
          enforcement: config.enforcement,
          // The mount line names the configured ROOT, never a derived path: the
          // literal `<sessionId>` is not a path any session uses (critic fix
          // P3#10). Each session's effective plan is journaled as `storage-plan`
          // where the refinement happens.
          ...storage.root === undefined
            ? { storage: storage.databasePath } : { storageRoot: storage.root },
          // ISSUE-578: the mount records this process can see, this one
          // included, and this mount's own record when it has one.
          mounts: liveMountRecords,
          ...mountRecord === null ? {} : { record: mountRecord.path },
          // ADR-0013 ruling 8: runtime evidence comes from inside the mount.
          ledgerSource, node: process.version,
          judgeTimeoutMs: config.judgeTimeoutMs,
          // ISSUE-022 chunks 5–6; ADR-0050 decision 2: both entry points are wired.
          // `command` is the `/cremate` message; `threshold` is the automatic trigger,
          // armed by an explicit `pruneThresholdTokens` bar or, on the deprecated
          // compatibility path, by the window's half. The two flags below name what
          // the apply leg will actually do with a pass, so an `unchanged` in a later
          // line is readable from this one (CRITIC-022 P2 #8, P2 #11).
          prune: config.contextWindowTokens === null && config.pruneThresholdTokens === null
            ? 'command' : 'command+threshold',
          window: config.contextWindowTokens,
          windowSource: config.contextWindowTokens === null ? 'unresolved' : 'config',
          pruneThreshold: config.pruneThresholdTokens,
          // What the threshold counts (ISSUE-092): the host's own billed prompt
          // from the last `usage` row (`input + cacheRead + cacheWrite`), one step
          // stale, because the local estimate omitted tool-call arguments and ran
          // at ~0.56 of the host meter on the 078 run. Before the first usage row
          // the local whole-request estimate is the fallback, and each
          // `prune-threshold` line says which reading it took.
          estimate: 'host-billed-prompt',
          nativeCompactionBackstop: config.nativeCompactionBackstop,
        });
        // The mounted line rides the mount's swallowing wrapper (ISSUE-430): a
        // throwing sink is contained exactly as every other line is, so it cannot
        // reject the plugin apply.
        mount.emitJournal(mountedLine.kind, { ...mountedLine });
      }

      // Both handlers need a session, resolved lazily at call time: the
      // registration must not depend on a session existing when the plugin
      // mounts. `forget` answers from the session's own live snapshot and
      // queues the request for that session's next boundary; `recall` reads the
      // ledger of the one live session.
      const toolHost = resolveToolHost(ctx, options.tools);
      // The inventory this mount tries to advertise, named in every outcome
      // (ISSUE-454): absent, registered and refused all state the same fields,
      // so an operator can read the tool outcome from one line.
      const offered = DSH_TOOL_SPECS.map(spec => spec.name);
      let unregisterTools: (() => void) | undefined;
      if (toolHost === undefined) {
        // No tools service is a named state, never silence that reads exactly
        // like a host that registered both tools (ISSUE-454).
        mount.emitJournal('tool-registration', { status: 'absent', registered: 0,
          offered, reason: 'no-tools-service' });
      } else {
        try {
          unregisterTools = registerPluginTools(toolHost, {
            recall: async (id, context) => {
              const entry = resolveLiveEntry(mount, ctx, context, 'recall');
              // ISSUE-435: the ledger read is a tracked boundary, drained
              // before this entry's ledger closes.
              return mount.runToolWork(entry.sessionId,
                () => entry.adapter.recall(id as RecallId));
            },
            forget: async (request, context) => {
              const entry = resolveLiveEntry(mount, ctx, context, 'forget');
              return mount.runToolWork(entry.sessionId, () => entry.adapter.forget(request));
            },
          });
          mount.emitJournal('tool-registration', { status: 'registered',
            registered: offered.length, offered });
          // ISSUE-577: the tools belong to THIS apply's ctx, so they are
          // unregistered by this apply's own unload. The effect is registered
          // after `racoons.close()`, and Cordis runs effects in reverse, so the
          // tools go before the mount's last holder may close it.
          ctx.effect?.(() => () => { unregisterTools?.(); }, 'racoons.tools');
        } catch (error) {
          // ISSUE-443: registration is all-or-nothing, so a host refusal leaves
          // NEITHER tool advertised while the `mounted` line above reads as a
          // healthy mount. Name the failure in the journal (ADR-0065's record
          // rule) and stay fail-open: the plugin apply still completes.
          const message = error instanceof Error ? error.message : String(error);
          mount.emitJournal('tool-registration-error', { registered: 0,
            offered, allOrNothing: true, message });
          warn(`tool registration: ${message}`);
        }
      }

      // The host command menu's `/cremate` (ADR-0068, ISSUE-535). A command
      // handler runs outside a turn, and the host's session format accepts a
      // `tool/result` surface replacement only inside one, so the handler owns
      // no pass: it registers a request for a CREMATOR marker message and opens
      // the marker turn through `agent.followup`. The turn's pre-step runs the
      // pass inside it, then rejects the marker step (no model request, no
      // `/cremate` text on the surface), and the handler returns the card the
      // pass settled. A host without a command registry mounts unchanged; the
      // typed-message path still works.
      const commands = ctx.commands;
      /**
       * ISSUE-603: the host keys a command to the plugin's long-lived context
       * and lists commands per agent (`commands.list(agent)`), so a permission
       * change that rebuilds an agent's command surface can drop the entry.
       * The registration therefore belongs to the MOUNT, not to one apply or
       * one session: it is made once when the mount is created, re-checked only
       * when the host announces `commands/change` (the same refresh native
       * commands rely on), and disposed when the last holder closes the mount.
       * A registry with no `list` is an older host, where the first
       * registration stands because the surface cannot be read back.
       */
      let ensureCremateCommand: ((agent?: unknown) => void) | undefined;
      /**
       * Re-register without the presence check (ISSUE-603). The client keeps a
       * per-session catalog snapshot and only re-pulls it on `commands/change`,
       * which the host emits on a layer mutation. A permission change emits
       * none of its triggers, so a stale snapshot must be forced to re-pull.
       */
      let forceCremateCommand: (() => void) | undefined;
      /**
       * Set only when the host has no usable `commands/change` subscription:
       * the pre-step is then the one remaining place to notice a dropped entry.
       */
      let refreshOnPreStep = false;
      /**
       * The agents this apply has seen (ISSUE-603). The host's
       * `commands/change` is emitted with no payload, so these are the agents
       * a refresh can re-list; a step names them as turns run.
       */
      const seenAgents = new Set<unknown>();
      if (commands !== undefined && typeof commands.register === 'function') {
        const surface: CommandSurfaceState = joined?.command ?? {
          command: createCremateCommand({
            begin: (sessionId, messageId, commandId) =>
              mount.beginCremate(sessionId, messageId, commandId),
            cancel: (sessionId, messageId, message) =>
              mount.cancelCremate(sessionId, messageId, message),
          }),
        };
        ownedSurface = surface;
        // One surface per mount: a joined apply refreshes this entry and never
        // seeds a second one.
        if (joined !== undefined) joined.command = surface;
        else if (registryKey !== null) {
          const created = activePluginMounts.get(registryKey);
          if (created !== undefined) created.command = surface;
        }
        /** Whether the host's list for this agent already carries `/cremate`. */
        const listedFor = (agent: unknown): boolean | undefined => {
          if (typeof commands.list !== 'function') return undefined;
          try {
            const listed = commands.list(agent);
            if (!Array.isArray(listed)) return undefined;
            return listed.some(entry => entry?.name === CREMATE_COMMAND_NAME);
          } catch {
            // A refused listing says nothing either way about the surface.
            return undefined;
          }
        };
        ensureCremateCommand = (agent?: unknown): void => {
          // No agent names no surface: at apply the entry is written once.
          const present = agent === undefined ? undefined : listedFor(agent);
          if (present === true) return;
          // With no readable surface, a second register could double the entry,
          // so an unreadable host keeps its one registration.
          if (present === undefined && surface.unregister !== undefined) return;
          disposeCommandSurface(surface);
          try {
            surface.unregister = commands.register(surface.command);
          } catch (error) {
            // A refused registration is a missing menu entry, never a failed
            // mount; the typed message still reaches the same pass.
            warn(`command registration: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        ensureCremateCommand();
        /**
         * ISSUE-603: a permission change leaves the client's catalog snapshot
         * stale or empty, and the client re-pulls only on `commands/change`.
         * The host emits that on a layer mutation, so the live entry is
         * disposed and registered again — the presence check is deliberately
         * skipped, because "already present" is exactly the state the client
         * cannot see.
         */
        forceCremateCommand = (): void => {
          disposeCommandSurface(surface);
          try {
            surface.unregister = commands.register(surface.command);
          } catch (error) {
            warn(`command re-registration: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        // A rebuilt surface is announced by name on the host's own event. It
        // carries no payload, so the agents to re-list are the ones a step has
        // already named. This is a refresh notification, not a second
        // registration path: each pass reads `list(agent)` first and does
        // nothing when the command is present.
        try {
          ctx.on('commands/change', () => {
            for (const agent of seenAgents) {
              try { ensureCremateCommand?.(agent); }
              catch (error) {
                warn(`command refresh: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          });
        } catch (error) {
          // Without the event seam, the pre-step must carry the refresh.
          refreshOnPreStep = true;
          warn(`command change hook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // ISSUE-603: the client's per-session catalog snapshot re-pulls only on
      // `commands/change`, and a permission change fires none of its triggers,
      // so a stale or empty snapshot persists. A forced re-registration is the
      // public way to emit `commands/change`. This host carries the change only
      // as session event types, never on the event bus, so the `session/event`
      // listener below is the one path that sees it. An approval policy change
      // is the same surface change as far as the client's snapshot goes.
      const surfaceChangeEvents: readonly string[] =
        ['permission/preset', 'sandbox/mode', 'approval/policy'];
      const forceOnSurfaceChange = (): void => {
        try { forceCremateCommand?.(); }
        catch (error) {
          warn(`command force: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      // Observe only. Appending here reenters the host's publication boundary.
      ctx.on('session/event', (session: DshMountSession, event: DshMountEvent) => {
        try { mount.observe(session, event); }
        catch (error) {
          warn(`observe ${String(event?.type)}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof event?.type === 'string' && surfaceChangeEvents.includes(event.type)) {
          forceOnSurfaceChange();
        }
      });

      // A `/cremate` command request is bound to the turn that claims its
      // marker message (ISSUE-535). The claim names the turn, so a turn that
      // closes without the pass fails the card by name instead of leaving it
      // pending; a discarded or disposed request fails the same way.
      ctx.on('agent/inbox/claimed', (payload: {
        agent?: { session?: DshMountSession };
        message?: { id?: unknown };
        turn?: number;
      }) => {
        const session = payload?.agent?.session;
        const id = payload?.message?.id;
        if (session === undefined || typeof id !== 'string'
          || typeof payload?.turn !== 'number') return;
        mount.claimCremate(String(session.id), id, payload.turn);
      });
      ctx.on('agent/inbox/discarded', (payload: {
        agent?: { session?: DshMountSession };
        message?: { id?: unknown };
      }) => {
        const session = payload?.agent?.session;
        const id = payload?.message?.id;
        if (session === undefined || typeof id !== 'string') return;
        mount.cancelCremate(String(session.id), id,
          'the command was discarded before its turn ran');
      });
      ctx.on('agent/disposed', (payload: {
        agent?: { session?: DshMountSession };
      }) => {
        const session = payload?.agent?.session;
        if (session === undefined) return;
        mount.abandonCremateWaits(String(session.id),
          'the agent was disposed before the cremation pass ran');
      });

      // Main's outgoing request, captured where the runtime dispatches it
      // (ISSUE-026 chunk 3 / ADR-0010). The waterfall listener must call
      // `next()`: it is an observer, never an interceptor. The host hands over
      // the request OBJECT, not the provider's HTTP body — the mount journals
      // which shape a seed came from and never claims byte-exactness.
      ctx.on('llm/stream', (options: unknown, next: () => AsyncIterable<unknown>) => {
        try { mount.observeWire(options); }
        catch (error) {
          warn(`wire capture: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
      });

      // ISSUE-549: the 75% skip line assumes the latch observes a step before
      // the host's own compactor runs. Cordis orders listeners by registration,
      // and the two plugins' activation order is a boot-time race (the base
      // composition says row order carries no load semantics), so this listener
      // prepends. It still calls `next()` on every ordinary step, so the host
      // compactor runs after it; only the command's marker step returns without
      // `next()`, and that step never enters the model.
      ctx.on('agent/pre-step', async (payload: {
        agent?: {
          session?: DshMountSession;
          inbox?: { prepend?(target: string, message: unknown): void };
          send?(message: unknown, target: string, wakeup: boolean): void;
        };
        messages?: readonly unknown[];
        turn?: number;
        step?: number;
        signal?: AbortSignal;
      }, next: () => unknown) => {
        // ISSUE-603: the step names the agent, which is what a payload-less
        // `commands/change` cannot. Only without that event seam does the step
        // also refresh; with the event available a permission edge costs the
        // step nothing but the set insert.
        if (payload.agent !== undefined && ensureCremateCommand !== undefined) {
          seenAgents.add(payload.agent);
        }
        if (refreshOnPreStep) {
          try { ensureCremateCommand?.(payload.agent); }
          catch (error) {
            warn(`command re-registration: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const session = payload.agent?.session;
        if (session === undefined) return next();
        // A host (or a rig) may name any value in the `signal` slot. Only a
        // real `AbortSignal` may reach `AbortSignal.any`, so the boundary
        // validates it and falls back to no signal rather than throwing the
        // step out on a malformed payload.
        const signal = payload.signal instanceof AbortSignal ? payload.signal : undefined;
        // A command's marker message is claimed by exactly one step (ISSUE-535).
        // That step is where the command's pass runs, inside the open turn.
        const marker = cremateMarkerOf(payload.messages);
        try {
          const stepResult = await mount.runStep(session,
            { turn: Number(payload.turn ?? 0), step: Number(payload.step ?? 0) },
            signal, marker?.id);
          if (stepResult.appendRequest !== null) {
            try { flushAppends(session, stepResult.entry, wiringConfig, wiringJournal); }
            catch (error) {
              warn(`append publish: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          if (marker !== undefined) {
            mount.cancelCremate(String(session.id), marker.id,
              `cremation pass could not start: ${messageOf(error)}`);
          }
          // A retryable storage open already warned inside the mount; the
          // boundary is simply skipped and the next one tries again.
          if (!(error instanceof RacoonsStorageRetryError)) {
            warn(`pre-step: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (marker === undefined) return next();
        // The pass is done; the marker step never enters the model. The host
        // drops the claimed marker message, and every other claimed message is
        // re-queued for the next step (dsh's goal-round driver does the same),
        // so rejecting this turn loses no user work.
        restoreClaimed(payload.agent, payload.messages, marker.id);
        return { kind: 'reject' };
      }, { prepend: true });
      // The last seal opportunity in a one-shot run: the loop appends `turn/end`
      // right after this serial hook, and no pre-step follows. Dispatching a
      // serial hook is not the `session/event` boundary, so appending is legal.
      ctx.on('agent/turn-stopping', async (payload: {
        turn?: number;
        agent?: { session?: DshMountSession };
      }) => {
        const named = payload.agent?.session;
        // A payload that names its agent seals that one; an unnamed payload
        // seals every live session, so more than one is never a silent no-op
        // (ISSUE-415). Only a session-less mount yields no work.
        const sessions = named !== undefined ? [named] : liveTurnEndSessions(mount, ctx);
        for (const session of sessions) {
          try {
            const turnResult = await mount.runTurnEnd(session, Number(payload.turn ?? 0));
            if (turnResult.appendRequest !== null) {
              try { flushAppends(session, turnResult.entry, wiringConfig, wiringJournal); }
              catch (error) {
                warn(`turn-end append publish: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          } catch (error) {
            if (!(error instanceof RacoonsStorageRetryError)) {
              warn(`turn-end: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      });
    },
  };
}

/** The default plugin instance a `file:///` patch row can name directly. */
export default createRacoonsPlugin();
