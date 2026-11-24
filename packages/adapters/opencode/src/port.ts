/**
 * The OpenCode 2.x `ApplicationPort` — snapshot, staging, receipt lookup
 * (ISSUE-192; ADR-0044; ADR-0017).
 *
 * **One earned mode, every other seam absent.** What this build declares decides
 * what this port may do. `capabilities.ts` reports `revertHistory: false` from
 * the module constant, `appendRecords: false`, `rewriteHistory: false`,
 * `rehydrateOnResume: false` and `mutateResult: false`, so every application mode
 * except the earned revert is a seam this adapter does not have. The port never
 * replaces a result body: the product does not cap or truncate results (ADR-0048),
 * and `execute.after` is observation only. A revert is staged by `apply()` and
 * spliced onto the caller's own array by `commit()`; the flag and the derivation
 * are constructor-checked both ways.
 *
 * **Why a staging slot at all.** The host rebuilds the request before every model
 * call and hands the message list to the `context` hook by reference, so a plan's
 * effect cannot be a lasting edit this port makes on its own: it has to be a
 * complete derived array, applied to the caller's own array by one `splice` at
 * `commit()` time. `apply` derives and holds that array, never touching the
 * caller's; `commit` applies it exactly once and is a no-op afterwards. The
 * per-request rebuild is why `rehydrateOnResume` is false and why the same intent
 * is never applied twice.
 *
 * **Receipts (ADR-0015).** A port that never saw an intent answers `unknown`,
 * never `not-applied`: absence from an in-process map is not a positive host
 * record. `not-applied` is produced only for an intent this port **did** see and
 * rejected in `apply` — a receipt mismatch, a stale live revision, a second
 * staged plan, an unsupported phase, a refused derivation or a derivation error.
 * It is never produced for absence from the map. The durable statement of a
 * refusal is the ledger's `abandoned` record, written by the engine, not a
 * memory this process loses on restart.
 *
 * **A staged receipt is not an applied receipt.** `apply()` files a receipt when
 * it stages a derivation, but the array is untouched until `commit()` splices it
 * onto the caller's own messages. `lookupReceipt` therefore answers `unknown`
 * for a receipt whose intent has not committed: a stage the caller never handed
 * to the host is not a host record, and the idle seam (which has no array to
 * commit) must never produce an applied one.
 *
 * **A refusal can carry a cleanup.** A derivation that finds one of its own
 * receipts naming content the array can read again refuses (`intent-conflict`)
 * and hands back the array with those stale markers dropped. The port stages
 * that cleanup for `commit()` while answering `not-applied`: the wire stops
 * shipping a false `[not retained]` line, and no applied receipt or ledger
 * record claims the removal happened. `refusal()` reports the last refusal's
 * own `code` and `detail`, so the mount can journal it instead of dropping the
 * reason at this boundary. A cleanup still splices the caller's array, so
 * `commit()` answers `true`; `lastCommitKind()` says the splice was a cleanup
 * and not an application, and the mount journals that as the commit's
 * `reason: 'cleanup'` instead of letting the row read as a committed pass.
 */

import type {
  ApplicationPort, ApplyReceipt, ApplyRequest, ApplyResult, ArchiveRecord, CapabilityFlags, Clock,
  IndexedRecall, IntentId, Ledger, LedgerEvent, LedgerSourceReader, RecallId,
  ReceiptLookup, SessionSnapshot,
} from '@cremator/core';
import { CoverageMeter, FileSourceReader } from '@cremator/core';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { OpencodeAppliedPlan, OpencodeAppliedPlanIndex } from './apply.js';
import { opencodePartialKeeps, opencodeReceiptRecallIdOfRecord } from './apply.js';
import { createOpencodeCapabilities } from './capabilities.js';
import type { OpencodeToolClassifier } from './classifier.js';
import type { OpencodeMessage } from './host.js';
import { deriveOpencodeSnapshot } from './snapshot.js';
import type { OpencodeSnapshot } from './snapshot.js';

/** How each snapshot is derived from the messages the context hook handed in. */
export interface OpencodePortSnapshotOptions {
  /** The mount's classifier, so evidence uses exactly the vocabulary the mount reads. */
  readonly classifier?: OpencodeToolClassifier;
  /** A turn-end fact the caller holds; `session.idle` is that fact for the at-rest path. */
  readonly completedThroughTurnOrdinal?: number;
}

/**
 * One staged derivation: the complete message list a prepared plan leaves. A pure
 * function of the array the port observed and the ledger's plan — the same two
 * inputs must produce a deep-equal array — so the port can hold it and hand it to
 * the caller's array unchanged.
 */
export interface OpencodeStagedArray {
  readonly status: 'staged';
  readonly messages: readonly OpencodeMessage[];
  /**
   * The exact receipt text the derivation rendered, keyed by recall id. The
   * port copies it into the applied-plan row so a later pass whose array no
   * longer carries the line still ships the same bytes.
   */
  readonly receiptTexts?: ReadonlyMap<string, string>;
  /**
   * The `necromancy` restore call node ids the derivation's array showed. The
   * port persists them in the applied-plan row: they date the epoch a removal
   * belongs to, so a later pass can tell a removal applied in this epoch from
   * one a visible restore superseded (`apply.ts` `opencodeIsCommittedRemoval`).
   */
  readonly restores?: readonly string[];
}

/** A plan the derivation would not apply. The array the port observed stays untouched. */
export interface OpencodeStagingRefusal {
  readonly status: 'refused';
  readonly reason: 'stale-revision' | 'unsupported' | 'host-error';
  /** The plan's own refusal code (`plan-sha-mismatch`, `tool-pair-split`, …). */
  readonly detail: string;
  /** The derivation's named class when it has one (`intent-conflict`, …). */
  readonly code?: string;
  /**
   * The array this refusal leaves behind when the wire itself needs fixing — a
   * stale receipt whose forgotten content is readable again. The port stages it
   * for `commit()` and still answers `not-applied`, so no receipt is minted and
   * the ledger records an abandonment, never a removal.
   */
  readonly cleanup?: readonly OpencodeMessage[];
}

export type OpencodeStaging = OpencodeStagedArray | OpencodeStagingRefusal;

/**
 * What one landed `commit()` did. Both kinds splice the caller's array; only
 * `applied` is a plan application with a receipt. `cleanup` drops stale receipt
 * lines the wire must not carry, and applies nothing.
 */
export type OpencodeCommitKind = 'applied' | 'cleanup';

/** The refusal one `apply` answered, carried so a journal can name it. */
export interface OpencodeApplyRefusal {
  readonly reason: OpencodeStagingRefusal['reason'];
  readonly code: string;
  readonly detail: string;
}

/**
 * The C7 seam: the pure derivation of the array a prepared revert leaves
 * (`src/apply.ts`). Supplying it is what makes a revert applicable.
 */
export type OpencodeRevertDeriver = (
  request: ApplyRequest, messages: readonly OpencodeMessage[],
  index: OpencodeAppliedPlanIndex,
) => OpencodeStaging;

export interface OpencodePortOptions extends OpencodePortSnapshotOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  /**
   * The host's own message array — the one the context hook received. It is held
   * by reference and `commit()` splices it in place. Absent, the port starts
   * empty; `observe()` replaces it every request.
   */
  readonly messages?: readonly OpencodeMessage[];
  /** Defaults to `createOpencodeCapabilities()`: the record-only declaration. */
  readonly capabilities?: CapabilityFlags;
  /** The revert derivation; refused at construction unless `revertHistory: true`. */
  readonly deriveRevert?: OpencodeRevertDeriver;
  /**
   * The applied-plan rows the ledger already holds, in applied order. A restart
   * loses this process's read cache, so the mount reads the durable rows once at
   * session open and hands them here: a unit a prior process banked is then
   * re-applied after a restart instead of being offered as first-time. Absent is
   * an empty cache, the same safe side a process that never applied anything
   * takes.
   */
  readonly appliedPlans?: readonly OpencodeAppliedPlan[];
  /**
   * The host receipts a previous process minted for this session, read back
   * from the mount's durable state (ISSUE-448; ADR-0064). They let `lookupReceipt`
   * resolve a prepared ledger row the previous process landed instead of
   * answering `unknown` and blocking recovery forever.
   */
  readonly receipts?: readonly ApplyReceipt[];
  /**
   * Called once per receipt this port mints, at the host write (`commit()`)
   * and before the engine's own `applied` ledger row (ISSUE-448). A death
   * between the two therefore leaves a durable receipt the remount can answer
   * from. Fail-open: a throwing callback never changes the apply's outcome.
   */
  readonly persistReceipt?: (receipt: ApplyReceipt) => void;
  /**
   * The folder this activation serves (ISSUE-522; dsh `workspaceRoot`). With it,
   * an applied archive's source paths are indexed and a ledger miss may answer
   * from an unchanged file on disk. Absent or not absolute, no reader is
   * supplied and a miss stays `not-found`, exactly as before.
   */
  readonly workspaceRoot?: string;
}

interface StagedCommit {
  readonly intentId: IntentId;
  readonly messages: readonly OpencodeMessage[];
  /**
   * The host array's length when the derivation was staged. `commit()` splices
   * exactly this prefix, so a host append that arrived after the staging is
   * preserved rather than overwritten (ISSUE-354).
   */
  readonly baseLength: number;
  /** `null` for a cleanup: the array changes, but nothing was applied. */
  readonly receipt: ApplyReceipt | null;
  /** The row `commit()` records when this stage's splice lands; absent on a cleanup. */
  readonly plan: OpencodeAppliedPlan | null;
}

/** True when the two arrays hold the same messages by reference, in order. */
function sameMessages(
  left: readonly OpencodeMessage[], right: readonly OpencodeMessage[],
): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The absolute path of a source inside the workspace root, or `null` when it
 * cannot be read as one (ISSUE-522; dsh `sourcePathInside`). A path outside the
 * root is refused: a source lane may name only files this mount could have read,
 * and the reader's hash check guards the bytes either way.
 */
function sourcePathInside(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null;
  }
  return absolute;
}

/** One archived removal as the prepared event states it: the unit and its recall. */
interface BankedSource {
  readonly nodeId: string;
  readonly recallId: string;
}

/**
 * One applied-plan row seeded from the ledger at session open. A live row
 * (`appliedPlanOf`) carries the approved revert plan's digest; the ledger's
 * prepared event does not record that digest, only the application digest the
 * intent is keyed by. A seeded row therefore keeps `planSha256` empty (unknown,
 * the same value a live row uses when it has no revert plan) and names the
 * application digest here. The port reconciles the two on a same-intent replay:
 * it verifies the request names that application and fills the row's plan digest
 * from the request before the derivation reads it, so a restart does not turn a
 * legitimate replay into `intent-conflict`.
 */
export interface OpencodeSeededAppliedPlan extends OpencodeAppliedPlan {
  readonly applicationSha256: string;
}

/** The application digest a seeded row carries, or `null` for a live row. */
function seededApplicationShaOf(plan: OpencodeAppliedPlan): string | null {
  const value = (plan as { readonly applicationSha256?: unknown }).applicationSha256;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The archived removals one prepared event states, from the engine metadata the
 * event carries (`packages/core/src/engine/journal.ts` `recordPrepared`). Each
 * archive part pairs its source node id with the recall id it was minted under;
 * a revert removal archives exactly one tool-result unit, so the pairs are the
 * unit node ids and the recall ids the receipt names. `null` when the event is
 * not a prepared event or carries no readable metadata: a ledger row that cannot
 * state what it removed banks nothing, and the unit is read as a first-time
 * offer (the safe side).
 */
function bankedSourcesOf(event: LedgerEvent): readonly BankedSource[] | null {
  if (event.kind !== 'prepared') return null;
  const engine = (event as { readonly engine?: unknown }).engine;
  if (!isRecord(engine)) return null;
  const sources = engine['sources'];
  if (!Array.isArray(sources)) return null;
  const pairs: BankedSource[] = [];
  for (const item of sources) {
    if (!isRecord(item)) continue;
    const recallId = item['recallId'];
    const source = item['source'];
    if (typeof recallId !== 'string' || recallId.length === 0 || !isRecord(source)) continue;
    const nodeId = source['nodeId'];
    if (typeof nodeId !== 'string' || nodeId.length === 0) continue;
    pairs.push({ nodeId, recallId });
  }
  return pairs;
}

/**
 * The applied-plan index a restarted process seeds itself with, read from the
 * ledger's own applied rows (ISSUE-262). `rehydrateOnResume: false` means the
 * port's in-process index does not survive a restart, so a banked removal would
 * read as a first-time offer and the ask/retention path could refuse it. The
 * durable statement is the `applied` event plus the prepared event's archive
 * sources; joined by intent id, they name every unit the ledger says was
 * removed. Rows land in applied order, so the earliest pass a receipt names is
 * the same pass a live process would name.
 *
 * Fields this derivation does not need (cut, survivors, note ids, rendered
 * text, restore ids) stay empty: a later pass reads `forgotten` and `recalls`,
 * and a missing `receiptTexts` makes it render the ledger's own line. A ledger
 * that throws or a row without metadata is read as "nothing banked", never as a
 * licence to trust a removal.
 *
 * `planSha256` is empty because the ledger holds the application digest, not
 * the approved revert plan's digest; the row carries the application digest in
 * `applicationSha256` instead, and the port fills the plan digest from the
 * request when the same intent is replayed (`OpencodeApplicationPort.apply`).
 */
export async function opencodeAppliedPlansFromLedger(
  ledger: Ledger, sessionId: string,
): Promise<readonly OpencodeSeededAppliedPlan[]> {
  const prepared = new Map<string, readonly BankedSource[]>();
  const plans: OpencodeSeededAppliedPlan[] = [];
  /**
   * ISSUE-521 item 3: the seeded row must know which removals were partial, or
   * a restarted mount re-applies a `keeplines`/ranged removal as a whole-unit
   * one and over-removes the kept lines. The recalled record is the durable
   * proof: a part whose removed ranges do not cover its whole body was kept in
   * part. Cached by recall id (one read per applied pass, not per unit) and a
   * record that cannot be read counts as partial — the safe side, which keeps
   * the unit whole instead of removing bytes the request asked to keep.
   */
  const partialOfRecall = new Map<string, boolean>();
  const isPartial = async (nodeId: string, recallId: string): Promise<boolean> => {
    const cached = partialOfRecall.get(recallId);
    if (cached !== undefined) return cached;
    let partial = true;
    try {
      const record = await ledger.recall(recallId as Parameters<Ledger['recall']>[0]);
      const part = record.manifest.parts.find(candidate => candidate.source.nodeId === nodeId);
      if (part !== undefined) {
        const removed = part.removedRanges
          .reduce((sum, range) => sum + (range.range.endByteExclusive - range.range.startByte), 0);
        partial = removed < part.source.byteLength;
      }
    } catch { /* an unreadable record: the safe side, keep the unit whole */ }
    partialOfRecall.set(recallId, partial);
    return partial;
  };
  for await (const { event } of ledger.events(sessionId)) {
    if (event.kind === 'prepared') {
      const sources = bankedSourcesOf(event);
      if (sources !== null) prepared.set(event.intentId, sources);
      continue;
    }
    if (event.kind !== 'applied') continue;
    const sources = prepared.get(event.receipt.intentId);
    if (sources === undefined || sources.length === 0) continue;
    const forgotten: string[] = [];
    const recalls: string[] = [];
    const partial: string[] = [];
    const seen = new Set<string>();
    for (const pair of sources) {
      const firstForNode = !seen.has(pair.nodeId);
      if (firstForNode) {
        seen.add(pair.nodeId);
        forgotten.push(pair.nodeId);
        recalls.push(pair.recallId);
      }
      if (await isPartial(pair.nodeId, pair.recallId) && !partial.includes(pair.nodeId)) {
        partial.push(pair.nodeId);
      }
    }
    if (forgotten.length === 0) continue;
    plans.push(Object.freeze({
      intentId: event.receipt.intentId,
      planSha256: '',
      applicationSha256: event.receipt.applicationSha256,
      cutIndex: 0,
      survivors: Object.freeze([]),
      receipts: Object.freeze([]),
      recalls: Object.freeze(recalls),
      forgotten: Object.freeze(forgotten),
      ...(partial.length === 0 ? {} : { partial: Object.freeze(partial) }),
    }));
  }
  return plans;
}

export class OpencodeApplicationPort implements ApplicationPort {
  private readonly sessionId: string;
  private readonly clock: Clock;
  private readonly capabilities: CapabilityFlags;
  private readonly deriveRevert: OpencodeRevertDeriver | undefined;
  private snapshotOptions: OpencodePortSnapshotOptions;
  /** The caller's array, by reference: `commit()` mutates this object in place. */
  private messages: OpencodeMessage[];
  private readonly receipts = new Map<IntentId, ApplyReceipt>();
  /**
   * The receipts a previous process minted, read back from the mount's durable
   * state (ISSUE-448; ADR-0064). Kept apart from `this.receipts`: a durable
   * receipt names a host write the previous process landed, so it answers
   * `applied` without this process's `committedIntents` guard.
   */
  private readonly durableReceipts = new Map<IntentId, ApplyReceipt>();
  private readonly persistReceipt: OpencodePortOptions['persistReceipt'];
  /**
   * Per-path byte coverage over every tool-result node this port derives
   * (ISSUE-522; dsh's port; PRD §6.6). Recorded on every derivation, so the
   * rows name exactly the nodes the engine plans against; recording the same
   * node twice is a no-op, so a re-derivation cannot inflate a row.
   */
  private readonly coverage = new CoverageMeter();
  /** The folder this activation serves, when it named an absolute one. */
  private workspaceRoot: string | undefined;
  /**
   * The archives this port applied, with the file each part came from
   * (ISSUE-522). A ledger miss may answer from those files while they still
   * hold the archived bytes; nothing here caches bytes.
   */
  private readonly sources = new Map<RecallId, IndexedRecall>();
  /** Intents whose staged array `commit()` actually spliced onto the caller's array. */
  private readonly committedIntents = new Set<IntentId>();
  /** The applied-plan index (plan §4): a read cache seeded from the ledger at open. */
  private readonly applied = new Map<IntentId, OpencodeAppliedPlan>();
  /**
   * The application digest of each seeded row (`OpencodeSeededAppliedPlan`),
   * kept until the row's first same-intent replay reconciles its plan digest.
   * A live row is absent: it already carries the real plan digest.
   */
  private readonly seededApplications = new Map<IntentId, string>();
  private staged: StagedCommit | null = null;
  private lastRefusal: OpencodeApplyRefusal | null = null;
  /** What the last `commit()` that spliced did; `null` when it spliced nothing. */
  private lastCommit: OpencodeCommitKind | null = null;

  constructor(options: OpencodePortOptions) {
    if (typeof options.sessionId !== 'string' || options.sessionId.trim().length === 0) {
      throw new TypeError('cremator: the OpenCode port requires a non-empty session id');
    }
    const capabilities = options.capabilities ?? createOpencodeCapabilities();
    // Capability honesty (ISSUE-010; ADR-0017): the flag and the path behind it
    // are one claim, so each is refused without the other.
    if (options.deriveRevert !== undefined && capabilities.revertHistory !== true) {
      throw new TypeError('cremator: a revert derivation needs `revertHistory: true`; '
        + 'without the flag it would apply behind a declared refusal');
    }
    if (options.deriveRevert === undefined && capabilities.revertHistory === true) {
      throw new TypeError('cremator: `revertHistory: true` needs the derivation that honours it; '
        + 'declare the flag only where `src/apply.ts` is wired');
    }
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.capabilities = Object.freeze({ ...capabilities });
    this.deriveRevert = options.deriveRevert;
    this.snapshotOptions = {
      ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
      ...(options.completedThroughTurnOrdinal === undefined
        ? {} : { completedThroughTurnOrdinal: options.completedThroughTurnOrdinal }),
    };
    // Held by reference, not copied: `commit()` must splice the host's own array.
    this.messages = (options.messages ?? []) as OpencodeMessage[];
    // A root that is not absolute names no file this mount could have read, so
    // it supplies no reader (ISSUE-522; dsh's constructor).
    this.workspaceRoot = options.workspaceRoot !== undefined && isAbsolute(options.workspaceRoot)
      ? options.workspaceRoot : undefined;
    // Durable rows first, in applied order: the earliest pass a receipt names and
    // the units a restart must treat as banked both read this order. A row the
    // ledger seeded also names the application its intent was keyed by; it is
    // remembered until the first replay can supply the plan digest the ledger
    // does not store.
    for (const plan of options.appliedPlans ?? []) {
      this.applied.set(plan.intentId, plan);
      const applicationSha256 = seededApplicationShaOf(plan);
      if (applicationSha256 !== null) this.seededApplications.set(plan.intentId, applicationSha256);
    }
    // Durable receipts answer a prepared row a prior process landed (ISSUE-448).
    for (const receipt of options.receipts ?? []) {
      this.durableReceipts.set(receipt.intentId, receipt);
    }
    this.persistReceipt = options.persistReceipt;
    // Fail at construction, not at the first request: an array the projection
    // cannot read (a duplicate id, a bad session id) is a mount bug worth naming.
    this.derive(this.messages);
  }

  private derive(messages: readonly OpencodeMessage[]): OpencodeSnapshot {
    const derived = deriveOpencodeSnapshot(
      messages, { sessionId: this.sessionId, ...this.snapshotOptions });
    // Every tool result the derived transcript holds is metered HERE, so the
    // rows name exactly the nodes the engine plans against (ISSUE-522; dsh's
    // port; PRD §6.6). `record` is idempotent per node id, so the repeated
    // derivations a step makes cannot inflate a row.
    for (const node of derived.snapshot.nodes) {
      if (node.kind === 'tool-result') this.coverage.record(node);
    }
    return { ...derived,
      snapshot: { ...derived.snapshot, pathCoverage: this.coverage.bytesByPath() } };
  }

  /**
   * The source index a ledger miss may answer from, or `null` when this port
   * cannot name the boundary (ISSUE-522; dsh `recallReader`; PRD §6.7). A port
   * opened with no absolute workspace root supplies no reader, so a miss stays
   * `not-found`; one that has applied no archive yet has no path to name and
   * answers the same. Rebuilt per call and caching no bytes, so a file edited
   * after the archive was minted is refused by the reader's own hash check.
   */
  recallReader(): LedgerSourceReader | null {
    if (this.workspaceRoot === undefined || this.sources.size === 0) return null;
    return new FileSourceReader([...this.sources.values()]);
  }

  /**
   * Remember where each part of every archive just applied came from, so a
   * later ledger miss can re-read it (ISSUE-522; dsh `indexSources`). The path
   * is the tool-result node's own evidence path, resolved inside the workspace
   * root; a part whose node is gone or whose path is unknown or outside the root
   * drops the whole record, because a source lane may name only files this mount
   * could have read.
   */
  private indexSources(archives: readonly ArchiveRecord[]): void {
    const root = this.workspaceRoot;
    if (root === undefined) return;
    const paths = new Map<string, string | null>();
    for (const node of this.derive(this.messages).snapshot.nodes) {
      if (node.kind !== 'tool-result') continue;
      const named = node.evidence.paths;
      // One path or none: a multi-path result proves no per-part share, so it
      // names no file this archive's part came from.
      const key = named.length === 1 ? named[0]?.pathKey ?? null : null;
      paths.set(node.id, key === null ? null : sourcePathInside(root, key));
    }
    for (const archive of archives) {
      const located: string[] = [];
      for (const part of archive.recall.manifest.parts) {
        const path = paths.get(part.source.nodeId) ?? null;
        if (path === null) { located.length = 0; break; }
        located.push(path);
      }
      if (located.length === 0) continue;
      this.sources.set(archive.recall.id, { recallId: archive.recall.id,
        manifest: archive.recall.manifest, paths: located });
    }
  }

  /**
   * Re-derive the snapshot from **this** array. The host rebuilds the request
   * every model call, so the port reads each array it is handed instead of
   * trusting the one it saw before; an uncommitted stage computed from a
   * different array is dropped rather than spliced into this one. Re-observing
   * the SAME array (the idle seam reads it during an engine await) keeps the
   * pending stage: it was derived from this exact array (ISSUE-354).
   */
  observe(
    messages: readonly OpencodeMessage[], options: OpencodePortSnapshotOptions = {},
  ): SessionSnapshot {
    if (!Array.isArray(messages)) {
      throw new TypeError('cremator: the context hook hands the port the host message array');
    }
    if (options.classifier !== undefined || options.completedThroughTurnOrdinal !== undefined) {
      this.snapshotOptions = { ...this.snapshotOptions, ...options };
    }
    const replaced = this.messages !== messages;
    this.messages = messages as OpencodeMessage[];
    this.lastRefusal = null;
    if (replaced && this.staged !== null) {
      // Under a filed receipt the drop is a named refusal, never a silent loss
      // (ISSUE-354): the receipt still answers `unknown` until a commit lands,
      // so nothing claims a removal the wire never carried. A receipt-less
      // cleanup claims nothing and drops as before.
      if (this.staged.receipt !== null) {
        this.lastRefusal = Object.freeze({
          reason: 'host-error', code: 'stage-dropped',
          detail: `intent ${this.staged.intentId} was staged, then its array was replaced `
            + 'before a commit',
        });
      }
      this.staged = null;
    }
    return this.live();
  }

  /**
   * Drop the retained turn-end fact (ISSUE-362). `observe` keeps the last
   * supplied `completedThroughTurnOrdinal` so a no-options call inherits it, but
   * a native compaction rewrites the surface and restarts its turn ordinals: the
   * retained fact then names a turn the rebuilt array no longer has, and the
   * snapshot clamp would raise the completed ordinal to the in-progress turn.
   * The mount calls this on `session.compaction.ended`, next to resetting its own
   * recorded fact, so the next no-fact observation falls back to `currentTurn - 1`.
   * The classifier is construction-time and stays.
   */
  clearCompletedTurnFact(): void {
    this.snapshotOptions = {
      ...(this.snapshotOptions.classifier === undefined
        ? {} : { classifier: this.snapshotOptions.classifier }),
    };
  }

  /** The snapshot of the array the port holds right now, derived per call. */
  private live(): SessionSnapshot {
    return structuredClone(this.derive(this.messages).snapshot);
  }

  async snapshot(): Promise<SessionSnapshot> {
    return this.live();
  }

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const { application, intent } = request;
    this.lastRefusal = null;
    // Keyed by intent id (plan §4): a replay of the same intent answers from the
    // same frozen receipt instead of staging a second rendering.
    const prior = this.receipts.get(intent.intentId);
    if (prior !== undefined) {
      const sameIntent = prior.applicationSha256 === application.applicationSha256
        && prior.applicationSha256 === intent.applicationSha256
        && prior.sessionId === application.sessionId
        && prior.sessionId === intent.sessionId
        && prior.baseRevision === intent.baseRevision
        && prior.baseRevision === application.baseRevision
        && intent.eventId === application.eventId;
      if (!sameIntent) {
        return this.refuse('host-error', 'receipt-mismatch',
          `intent ${intent.intentId} already staged a different receipt`);
      }
      // A replayed intent may answer `applied` only while its stage still exists
      // (the caller can commit it) or after a commit landed it. A receipt whose
      // array was replaced before the commit is not an application.
      const stillStaged = this.staged !== null && this.staged.intentId === intent.intentId;
      return this.committedIntents.has(intent.intentId) || stillStaged
        ? { status: 'applied', receipt: prior }
        : this.refuse('host-error', 'stage-dropped',
          `intent ${intent.intentId} was staged, then its array was replaced before a commit`);
    }
    if (intent.sessionId !== this.sessionId || application.sessionId !== this.sessionId
      || intent.eventId !== application.eventId
      || intent.applicationSha256 !== application.applicationSha256
      || intent.baseRevision !== application.baseRevision) {
      return this.refuse('host-error', 'intent-mismatch',
        'the request intent and its application name different work');
    }
    // No await between reading the live revision and holding the derived array.
    const live = this.derive(this.messages).snapshot.revision;
    if (application.baseRevision !== live || intent.baseRevision !== live) {
      // The host handed in a different array since the plan was prepared; the
      // plan's indices no longer name the same messages (plan §4).
      return this.refuse('stale-revision', 'stale-revision',
        'the host array is not the one the plan was approved against');
    }
    if (this.staged !== null && this.staged.intentId !== intent.intentId) {
      // One request stages one plan.
      return this.refuse('host-error', 'second-staged-plan',
        'another intent is already staged for this array');
    }
    if (application.mode !== 'revert') {
      // Every other mode is a seam this build declares false in `capabilities.ts`.
      return this.refuse('unsupported', 'unsupported-mode',
        `the ${application.mode} mode is not a seam this port carries`);
    }
    if (this.capabilities.revertHistory !== true || this.deriveRevert === undefined) {
      // Record-only until the pair is supplied: the flag is false and the span
      // maths does not exist, so a revert is refused, not faked.
      return this.refuse('unsupported', 'unsupported-capability',
        'the revert pair (`revertHistory: true` + derivation) is not declared');
    }
    // A row seeded from the ledger names the application the prior process
    // applied, not the approved plan's digest: the ledger's prepared event
    // carries `applicationSha256` and no revert plan. The intent id is derived
    // from that digest, so a same-intent replay is the same application. Verify
    // it, then fill the row's plan digest from the request before the derivation
    // reads the index; otherwise the derivation's one-intent-one-plan check
    // would refuse a legitimate replay as `intent-conflict`. A different
    // application under the same intent keeps that refusal.
    const seededApplication = this.seededApplications.get(intent.intentId);
    if (seededApplication !== undefined) {
      if (seededApplication !== application.applicationSha256) {
        return this.refuse('host-error', 'intent-conflict',
          `intent ${intent.intentId} already applied a different plan`);
      }
      const prior = this.applied.get(intent.intentId);
      const planSha256 = request.application.revert?.planSha256 ?? '';
      if (prior !== undefined && prior.planSha256 !== planSha256) {
        this.applied.set(intent.intentId, Object.freeze({ ...prior, planSha256 }));
      }
      this.seededApplications.delete(intent.intentId);
    }
    let staging: OpencodeStaging;
    let resultRevision: string;
    try {
      staging = this.deriveRevert(request, this.messages, this.applied);
      if (staging.status === 'refused') {
        // A cleanup is the one refusal that changes the wire: the derivation
        // found its own stale receipt naming readable content. Stage the cleaned
        // array, answer not-applied, and mint no receipt.
        if (staging.cleanup !== undefined) {
          this.staged = {
            intentId: intent.intentId, messages: staging.cleanup,
            baseLength: this.messages.length, receipt: null, plan: null,
          };
        }
        return this.refuse(staging.reason, staging.code ?? staging.reason, staging.detail);
      }
      // The receipt promises the revision the caller's array carries once this
      // derivation is committed, so `snapshot()` after `commit()` equals it.
      resultRevision = this.derive(staging.messages).snapshot.revision;
    } catch (error) {
      // The derivation threw before anything was staged: a definite refusal.
      // The thrown message rides in the detail (ISSUE-360) so the mount's
      // journal line names the cause without a live reproduction.
      return this.refuse('host-error', 'derivation-error',
        'the derivation threw before it could stage anything: '
        + (error instanceof Error ? error.message : String(error)));
    }
    const receipt: ApplyReceipt = Object.freeze({
      intentId: intent.intentId,
      sessionId: this.sessionId,
      baseRevision: intent.baseRevision,
      resultRevision,
      applicationSha256: intent.applicationSha256,
      appliedAtMs: this.clock.nowMs(),
    });
    this.receipts.set(intent.intentId, receipt);
    // The row is held with the stage; `commit()` records it only when the splice
    // lands. A refused or dropped stage must not read as banked work (ISSUE-262).
    // The derivation's rendered receipt text rides along: the row is what a later
    // pass reads when its own array no longer carries the line.
    const plan = this.appliedPlanOf(
      intent.intentId, request, staging.receiptTexts, staging.restores);
    // The archives were banked before this call, and their parts' paths come from
    // the array the stage is about to replace, so the index is built while the
    // forgotten nodes are still addressable (ISSUE-522; dsh's apply).
    this.indexSources(request.application.archives);
    this.staged = {
      intentId: intent.intentId, messages: staging.messages,
      baseLength: this.messages.length, receipt, plan,
    };
    return { status: 'applied', receipt };
  }

  /** One refusal: named on the wire answer and kept for the mount's journal. */
  private refuse(
    reason: OpencodeStagingRefusal['reason'], code: string, detail: string,
  ): ApplyResult {
    this.lastRefusal = Object.freeze({ reason, code, detail });
    return { status: 'not-applied', reason };
  }

  /**
   * The refusal the last `apply` answered, or `null` when it applied or was not
   * called. A commit whose splice threw (`commit-failed`) and an observe that
   * dropped a staged receipt under a replaced array (`stage-dropped`) are named
   * here too (ISSUE-354), so the mount's journal carries the reason.
   */
  refusal(): OpencodeApplyRefusal | null {
    return this.lastRefusal;
  }

  /**
   * What the ledger's plan says this intent applied, as the index records it.
   * The record ids (`receipts`) change with the event; the recall ids
   * (`recalls`) do not, so they are the key a later pass matches a re-applied
   * removal on. `forgotten` names the unit node ids the plan removed, and
   * `survivors` dates a restore epoch: a plan derived after a visible restore
   * holds that restore call's node.
   *
   * `rendered` is the derivation's own receipt text per recall id. It is the
   * exact wire line, label and pass included, that this pass wrote; a later
   * pass whose array no longer carries the receipt reuses it byte for byte,
   * exactly as it reuses the first pass id.
   *
   * `restores` is the restore call node ids the derivation's array showed. A
   * later pass reads them to decide whether a removal offered after a visible
   * restore belongs to that restore's epoch or one it superseded.
   */
  private appliedPlanOf(
    intentId: string, request: ApplyRequest, rendered?: ReadonlyMap<string, string>,
    restores?: readonly string[],
  ): OpencodeAppliedPlan {
    const revert = request.application.revert;
    const records = new Map(
      request.application.appendRecords.map(record => [record.recordId, record] as const));
    const recalls: string[] = [];
    for (const append of revert?.appends ?? []) {
      const record = records.get(append.noteId);
      const recallId = record === undefined ? null : opencodeReceiptRecallIdOfRecord(record);
      // A staged plan's records all resolve: `deriveOpencodeRevert` refuses any
      // append whose record is missing or is not the product's receipt line.
      if (recallId !== null) recalls.push(recallId);
    }
    // ISSUE-521 item 3: the units this plan removed only partly. A banked row is
    // re-applied as a whole-unit removal, which would over-remove the lines a
    // `keeplines` verdict (or a ranged `forget`) kept.
    const keeps = opencodePartialKeeps(request.application.archives);
    const partial = keeps.status === 'derived' ? [...keeps.keeps.keys()] : [];
    return Object.freeze({
      intentId,
      planSha256: revert?.planSha256 ?? '',
      cutIndex: revert?.cutIndex ?? 0,
      survivors: [...(revert?.survivors ?? [])],
      receipts: [...(revert?.appends.map(append => append.noteId) ?? [])],
      recalls: Object.freeze(recalls),
      forgotten: [...(revert?.perNode.map(entry => entry.nodeId) ?? [])],
      ...(partial.length === 0 ? {} : { partial: Object.freeze(partial) }),
      ...(restores === undefined ? {} : { restores: [...restores] }),
      ...(rendered === undefined ? {} : { receiptTexts: new Map(rendered) }),
    });
  }

  /**
   * Apply the staged derivation to the caller's own array by one in-place
   * `splice` of the prefix the derivation was staged from. Nothing staged, or a
   * derivation that leaves the same messages by reference, mutates nothing and
   * answers `false`; a second call is always a no-op. Only a splice that landed
   * a receipt marks its intent applied **and records its applied-plan row**: a
   * refused, dropped or no-op stage must not read as banked work. A cleanup
   * changes the array but leaves the intent unknown and records no row, and
   * `lastCommitKind()` names that splice a cleanup.
   *
   * A splice that throws (a frozen host array, a spread overflow) keeps the
   * stage for a retry, names the failure on the refusal surface
   * (`commit-failed`), and rethrows: the throw is the engine's "unproved"
   * signal, so no durable row is written and the receipt stays uncommitted —
   * a failed commit claims no removal (ISSUE-354). The kept stage lands on a
   * later commit and recovery then reconciles the applied row. A host append
   * that arrived after the staging is beyond the spliced prefix and survives.
   */
  commit(): boolean {
    const staged = this.staged;
    this.lastCommit = null;
    if (staged === null) return false;
    if (sameMessages(this.messages, staged.messages)) {
      this.staged = null;
      return false;
    }
    try {
      this.messages.splice(0, staged.baseLength, ...staged.messages);
    } catch (error) {
      // The splice never landed: keep the stage for a retry and name the
      // failure, then let the throw propagate. `lookupReceipt` still answers
      // unknown and no applied row is recorded, so nothing claims a removal the
      // array never carried; the engine reads the throw as unproved and writes
      // no durable row, leaving the kept stage free to land on a retry.
      this.lastRefusal = Object.freeze({
        reason: 'host-error', code: 'commit-failed',
        detail: `the commit splice threw before intent ${staged.intentId} reached the host `
          + `array: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    this.staged = null;
    // A receipt-less stage is a cleanup: it changed the wire but applied nothing.
    this.lastCommit = staged.receipt === null ? 'cleanup' : 'applied';
    if (staged.receipt !== null) {
      this.committedIntents.add(staged.intentId);
      if (staged.plan !== null) this.applied.set(staged.intentId, staged.plan);
      // The host write is the boundary the durable receipt must survive: a
      // process death before the engine records `applied` leaves a receipt the
      // remount resolves the prepared row with (ISSUE-448; ADR-0064).
      try { this.persistReceipt?.(staged.receipt); } catch { /* the mount names its own failure */ }
    }
    return true;
  }

  /**
   * What the last `commit()` that spliced did, or `null` when it spliced
   * nothing. A cleanup is a real wire change that applies no plan, so the mount
   * journals it with its own `reason` rather than as a committed pass.
   */
  lastCommitKind(): OpencodeCommitKind | null {
    return this.lastCommit;
  }

  /**
   * The live applied-plan index this port hands every derivation. The mount
   * reads it to seed a session entry before the first derivation, and a test
   * reads it to prove a stage's row landed only after its commit.
   */
  appliedPlanIndex(): OpencodeAppliedPlanIndex {
    return this.applied;
  }

  async lookupReceipt(intentId: IntentId): Promise<ReceiptLookup> {
    // Absence from this process's map is not a refusal: only a positive host
    // record can answer not-applied (ADR-0015 ruling 1; `rehydrateOnResume: false`).
    // A receipt `apply()` filed before `commit()` is not a host record yet: the
    // array it was derived from has not been handed to the host, so the lookup
    // answers `unknown` until the splice lands.
    const receipt = this.receipts.get(intentId);
    if (receipt !== undefined && this.committedIntents.has(intentId)) {
      return { status: 'applied', receipt };
    }
    // A receipt a previous process minted is a host record already, so the
    // durable set answers it for a remount's recovery instead of leaving the
    // prepared row blocked forever (ISSUE-448; ADR-0064).
    const durable = this.durableReceipts.get(intentId);
    if (durable !== undefined) return { status: 'applied', receipt: durable };
    return { status: 'unknown' };
  }
}

export function createOpencodePort(options: OpencodePortOptions): OpencodeApplicationPort {
  return new OpencodeApplicationPort(options);
}
