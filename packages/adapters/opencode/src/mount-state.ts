/**
 * The opencode mount's durable state beside its ledger (ISSUE-448, ISSUE-409).
 *
 * Each session already owns one durable ledger at
 * `<root>/sessions/<segment>/ledger.sqlite` (`storage.ts`). This module keeps the
 * two facts that must survive a process boundary but are not ledger events, in
 * a sibling `mount-state.json` under the same session directory:
 *
 *   - `install` — the mount identity this session's durable state belongs to:
 *     a generation, the install wall time, the tool-result node ids present at
 *     the first mount (identity evidence, never an eligibility gate — ADR-0069)
 *     and the session id it was installed for. A remount reads it to know the
 *     state is its own (a restart) rather than a fork's copy of a parent's
 *     state, and a fork does not restore the parent's ask identity
 *     (ISSUE-521 items 1 and 7; the dsh `install` fact).
 *   - `receipts` — the host receipts this port minted for applied removals. The
 *     in-process map dies with the process; the file lets a remount resolve a
 *     prepared ledger row the previous process landed instead of reading
 *     `unknown` and blocking recovery forever (ISSUE-448; ADR-0064).
 *   - `ask` — the ask identity that was claimed or answered: the revision
 *     claims, the unit claims, and the removal verdicts an apply owes. A
 *     restart rebuilds them instead of re-asking a claimed unit or losing an
 *     unapplied verdict (ISSUE-409; ADR-0063). A whole-unit `forgetall` stops
 *     being owed once its ledger `applied` row lands, because the banked row
 *     re-applies it; a partial `keeplines` is RETAINED, because only the
 *     verdict can reconstruct the kept lines on a rebuilt request or a remount
 *     (ISSUE-509).
 *
 * Every writer reads the current document, replaces only the fact it owns and
 * republishes the whole file atomically (temp + rename), so a kill mid-write
 * tears only the temp and every other fact is preserved. Reads are fail-open:
 * an absent or corrupt document reads as "nothing durable yet", never as a
 * licence to trust garbage. A write failure is returned to the caller so the
 * mount can name it; it never throws.
 *
 * ISSUE-563: two mounts of one durable root (two terminals) now share this file.
 * The read-modify-write therefore runs under the session ledger's own
 * cross-process write lock, so neither mount can publish a document built from a
 * read that missed the other's fact.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ApplyReceipt, WireAnswer } from '@cremator/core';
import type { StorageTarget } from './storage.js';

/** The state file's name, beside `ledger.sqlite` and `blobs/`. */
export const MOUNT_STATE_FILE = 'mount-state.json';

/**
 * The schema version this build writes and the only one it reads (ISSUE-472).
 * A document tagged with another version is a different writer's format: the
 * readers refuse it by name instead of reading it as an empty record, so an
 * upgrade skew is observable and never silently re-opens a settled unit.
 */
export const MOUNT_STATE_VERSION = 1;

/** A per-process token so two writes never stage the same temp name. */
let tempSeq = 0;

/**
 * One ask verdict an apply still owes, with the node it addressed. A
 * `forgetall` is a whole-unit removal; a partial `keeplines` is a line-level
 * removal whose kept lines only the verdict itself can reconstruct, so it stays
 * durable across a process boundary (ISSUE-509).
 */
export interface DurableAskVerdict {
  readonly unitId: string;
  readonly nodeId: string;
  readonly answer: WireAnswer;
}

/**
 * The durable install identity of one session (ISSUE-521 item 1, the dsh
 * `install` fact ported). It is identity evidence, never an eligibility gate
 * (ADR-0069): it says whether a mount is a fresh install, a restart of its own
 * state, or a fork holding a copy of another session's state, and the
 * `sessionId` it names is what stops a child restoring the parent's ask
 * identity (ISSUE-521 item 7).
 */
export interface DurableInstall {
  /** One per mount of this durable state; the first mount writes 1. */
  readonly generation: number;
  /** The wall time the first mount recorded, in ms. */
  readonly installedAtMs: number;
  /**
   * The tool-result node ids on the host surface at the first mount. Identity
   * evidence for a fork/clone (ADR-0069 decision 2); it gates no eligibility.
   */
  readonly preInstallNodeIds: readonly string[];
  /**
   * The session id this durable state was first installed for. A mount reading
   * a different id holds a fork's copy of a parent's state.
   */
  readonly sessionId: string;
}

/** The ask identity a remount restores (ISSUE-409; ADR-0063). */
export interface DurableAskState {
  readonly revisions: readonly string[];
  readonly askedUnitIds: readonly string[];
  readonly retriedUnitIds: readonly string[];
  readonly refusedRetriedUnitIds: readonly string[];
  readonly verdicts: readonly DurableAskVerdict[];
  readonly deferredApply: boolean;
  readonly deferredFailures: number;
  /**
   * The table asks this session sent and had answered or refused with rows
   * (ISSUE-509). It picks the keep-share line: `0` states 70 percent, every
   * later value states 40 percent. A process boundary keeps it, so a resumed
   * segment does not restate the first ask's share. Absent in an older file
   * reads as `0` (fail-open: the share line is advisory and blocks nothing).
   */
  readonly askFires: number;
}

interface MountDoc {
  readonly version?: number;
  readonly install?: DurableInstall;
  readonly receipts?: readonly ApplyReceipt[];
  readonly ask?: DurableAskState;
}

/** A read's result: the usable document, or the reason a present one was refused. */
interface DocRead {
  readonly doc: MountDoc;
  readonly rejected?: string;
}

/** The sink a reader calls when a present document is refused (ISSUE-472). */
export type MountStateRejection = (message: string) => void;

/** A write's outcome. `message` names a failure; the mount journals it. */
export interface DurableWriteResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** The session directory a durable target names, or null for a memory target. */
function sessionDirOf(target: StorageTarget): string | null {
  return target.kind === 'memory' ? null : dirname(target.databasePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A pre-version document (ISSUE-472 wrote before the tag existed). It is read
 * as version 1 when its shape is this build's — an `ask` object or a
 * `receipts` array — so an upgrade does not discard claims a legacy build
 * wrote (ISSUE-484).
 */
function isLegacyMountDoc(value: Record<string, unknown>): boolean {
  return Array.isArray(value.receipts) || isRecord(value.ask) || isRecord(value.install);
}

/**
 * Read one document. An absent file is legitimately empty; a present file this
 * build cannot read — a transient `readFileSync` failure (Windows AV/EBUSY/
 * EPERM/EMFILE on a just-renamed file), bad JSON, not an object, or another
 * format version — is refused with its reason so the caller can journal it by
 * name and a writer refuses to merge over it (ISSUE-521 item 2; ISSUE-472).
 */
function readDoc(dir: string): DocRead {
  let raw: string;
  try {
    raw = fs.readFileSync(join(dir, MOUNT_STATE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: {} };
    return { doc: {}, rejected: 'the mount-state file could not be read: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: {}, rejected: 'the mount-state file is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { doc: {}, rejected: 'the mount-state file is not a JSON object' };
  }
  if (parsed.version === undefined && isLegacyMountDoc(parsed)) {
    return { doc: { ...parsed, version: MOUNT_STATE_VERSION } as unknown as MountDoc };
  }
  if (parsed.version !== MOUNT_STATE_VERSION) {
    const seen = typeof parsed.version === 'number' ? String(parsed.version) : 'absent';
    return { doc: {}, rejected: `unknown mount-state format version ${seen}; `
      + `this build reads version ${String(MOUNT_STATE_VERSION)}` };
  }
  return { doc: parsed as unknown as MountDoc };
}

/**
 * Refuse a write over a document this build cannot read. Merging into the
 * discarded empty read would replace the other writer's file with this build's
 * version; the refusal is named instead, so "observable refusal" never becomes
 * "silent takeover" (ISSUE-484; ADR-0064 decision 1).
 */
function refuseWrite(dir: string, reason: string): DurableWriteResult {
  return { ok: false, message: `refusing to overwrite ${join(dir, MOUNT_STATE_FILE)}: ${reason}` };
}

/** Publish one complete document atomically; a failure is named, never thrown. */
function publishDoc(dir: string, doc: MountDoc): DurableWriteResult {
  const final = join(dir, MOUNT_STATE_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp,
      `${JSON.stringify({ ...doc, version: MOUNT_STATE_VERSION })}\n`, 'utf8');
    fs.renameSync(temp, final);
    return { ok: true };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never exist */ }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * How long one state write waits for the session ledger's write lock. The value
 * is the ledger's own (`sqlite-ledger.ts` opens every ledger with
 * `busy_timeout = 5000`), so a held lock is waited out for exactly as long as a
 * ledger append is, and no state write is lost to contention it could have
 * waited out.
 */
const STATE_LOCK_TIMEOUT_MS = 5000;

/**
 * Run one read-modify-write under the ledger's cross-process write lock
 * (ISSUE-563). Two mounts of one root in different processes write this file;
 * without a lock each could publish a document whose read missed the other's
 * fact. `BEGIN IMMEDIATE` on this session's own `ledger.sqlite` is the mutex
 * every mount of the session already shares, and SQLite serializes it across
 * processes. The lock covers a synchronous section only, so no mount ever waits
 * on another mount's ledger work while holding it, and this process's own
 * ledger handle is never inside a transaction when a state write runs
 * (JavaScript is single-threaded). A lock that cannot be taken fails the write
 * by name, which the caller journals.
 */
function withLedgerLock(
  target: StorageTarget, write: () => DurableWriteResult,
): DurableWriteResult {
  if (target.kind !== 'durable') return write();
  const databasePath = target.databasePath;
  // No ledger file means no mount has opened this session here, so there is no
  // other writer of this session's state to interleave with.
  if (!fs.existsSync(databasePath)) return write();
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath); }
  catch (error) { return lockFailure(target, error); }
  try {
    db.exec(`PRAGMA busy_timeout = ${String(STATE_LOCK_TIMEOUT_MS)}`);
    db.exec('BEGIN IMMEDIATE');
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the write never started */ }
    return lockFailure(target, error);
  } finally {
    try { db.close(); } catch { /* the write's own result stands */ }
  }
}

/** The named failure of a state write that could not take the ledger lock. */
function lockFailure(target: StorageTarget, error: unknown): DurableWriteResult {
  const reason = error instanceof Error ? error.message : String(error);
  const dir = sessionDirOf(target);
  const path = dir === null ? MOUNT_STATE_FILE : join(dir, MOUNT_STATE_FILE);
  return { ok: false, message: `refusing to write ${path} without the ledger's `
    + `cross-process lock: ${reason}` };
}

/** The receipts fact as read, and why a readable document's copy was unusable. */
interface ReceiptsRead {
  readonly rows: ApplyReceipt[];
  readonly rejected?: string;
}

function readReceiptsOf(doc: MountDoc): ReceiptsRead {
  const receipts = doc.receipts;
  if (receipts === undefined) return { rows: [] };
  if (!Array.isArray(receipts)) {
    return { rows: [], rejected: 'the receipts record is not an array' };
  }
  const out: ApplyReceipt[] = [];
  for (const value of receipts) {
    if (!isRecord(value)) {
      return { rows: [], rejected: 'the receipts record holds a structurally invalid row' };
    }
    if (typeof value.intentId !== 'string' || typeof value.sessionId !== 'string'
      || typeof value.baseRevision !== 'string' || typeof value.resultRevision !== 'string'
      || typeof value.applicationSha256 !== 'string' || !isCount(value.appliedAtMs)) {
      return { rows: [], rejected: 'the receipts record holds a structurally invalid row' };
    }
    out.push(value as unknown as ApplyReceipt);
  }
  return { rows: out };
}

/** The host receipts a previous process minted for this session (ISSUE-448). */
export function readDurableReceipts(
  target: StorageTarget, onReject?: MountStateRejection,
): ApplyReceipt[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  const read = readDoc(dir);
  if (read.rejected !== undefined) {
    onReject?.(read.rejected);
    return [];
  }
  const receipts = readReceiptsOf(read.doc);
  if (receipts.rejected !== undefined) {
    onReject?.(`${receipts.rejected}; reading it as absent`);
    return [];
  }
  return receipts.rows;
}

/**
 * Record one applied receipt, replacing any earlier row for the same intent.
 * The port calls this at the host write, before the engine's own `applied`
 * ledger row, so a death in between leaves a durable receipt the remount can
 * answer from (ISSUE-448; ADR-0064).
 */
export function writeDurableReceipt(
  target: StorageTarget, receipt: ApplyReceipt,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  return withLedgerLock(target, () => {
    const read = readDoc(dir);
    if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
    const prior = readReceiptsOf(read.doc);
    // ISSUE-521 item 2 (the dsh ISSUE-568 rule): a record this build cannot
    // parse is never replaced by a merge over an empty read. Refusing by name
    // keeps a valid sibling receipt from being erased by a row this build could
    // not read, and the write is retried once the file reads again.
    if (prior.rejected !== undefined) return refuseWrite(dir, prior.rejected);
    const kept = prior.rows.filter(row => row.intentId !== receipt.intentId);
    return publishDoc(dir, { ...read.doc, receipts: [...kept, receipt] });
  });
}

/**
 * Drop one durable receipt once the ledger's own `applied` row supersedes it
 * (ISSUE-495, the dsh adapter's ISSUE-436 collection). The receipt exists only
 * for the crash window between the host write and that row (ISSUE-448); the
 * ledger is the record of record (ADR-0015), so the copy has no further reader.
 * Garbage collection of superseded state, not a cap: no count, age or budget is
 * introduced, and an empty set removes the `receipts` field whole. A failed
 * write is returned for the mount to journal, like every other mount-state
 * write; a write that would not change the file does not touch it.
 */
export function removeDurableReceipt(
  target: StorageTarget, intentId: string,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  return withLedgerLock(target, () => {
    const read = readDoc(dir);
    if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
    const read1 = readReceiptsOf(read.doc);
    // A record this build cannot parse is not read as "no receipt to collect":
    // the collection would republish the document without it (ISSUE-521 item 2).
    if (read1.rejected !== undefined) return refuseWrite(dir, read1.rejected);
    const prior = read1.rows;
    const remaining = prior.filter(row => row.intentId !== intentId);
    if (remaining.length === prior.length) return { ok: true };
    const { receipts: _prior, ...rest } = read.doc;
    return publishDoc(dir, { ...rest, ...(remaining.length === 0 ? {} : { receipts: remaining }) });
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isWireAnswer(value: unknown): value is WireAnswer {
  if (!isRecord(value) || !isRecord(value.verdict)) return false;
  const verdict = value.verdict;
  return typeof verdict.unitId === 'string' && typeof verdict.action === 'string'
    && isCount(verdict.answeredInRound);
}

function readAskOf(doc: MountDoc): DurableAskState | null {
  const ask = doc.ask;
  if (!isRecord(ask)) return null;
  if (!isStringArray(ask.revisions) || !isStringArray(ask.askedUnitIds)
    || !isStringArray(ask.retriedUnitIds) || !isStringArray(ask.refusedRetriedUnitIds)
    || !Array.isArray(ask.verdicts)
    || typeof ask.deferredApply !== 'boolean' || !isCount(ask.deferredFailures)) return null;
  const verdicts: DurableAskVerdict[] = [];
  for (const value of ask.verdicts) {
    if (!isRecord(value) || typeof value.unitId !== 'string'
      || typeof value.nodeId !== 'string' || !isWireAnswer(value.answer)) return null;
    verdicts.push({ unitId: value.unitId, nodeId: value.nodeId, answer: value.answer });
  }
  return {
    revisions: ask.revisions, askedUnitIds: ask.askedUnitIds,
    retriedUnitIds: ask.retriedUnitIds, refusedRetriedUnitIds: ask.refusedRetriedUnitIds,
    verdicts, deferredApply: ask.deferredApply, deferredFailures: ask.deferredFailures,
    // ISSUE-509: an older file (or a write that never carried the count) reads
    // as "no fire yet". The record is still usable, so one missing optional
    // fact does not refuse the whole ask identity.
    askFires: isCount(ask.askFires) ? ask.askFires : 0,
  };
}

/** The ask identity this session's durable state carries, or null (none). */
export function readDurableAskState(
  target: StorageTarget, onReject?: MountStateRejection,
): DurableAskState | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const read = readDoc(dir);
  if (read.rejected !== undefined) {
    onReject?.(read.rejected);
    return null;
  }
  if (read.doc.ask === undefined) return null;
  const ask = readAskOf(read.doc);
  if (ask === null) {
    onReject?.('the ask record is structurally invalid; reading it as absent');
    return null;
  }
  return ask;
}

/**
 * Replace the ask identity. An empty state with no claims and no verdicts is
 * still published: the claims are what stop a later mount re-asking a settled
 * revision, so the record is only absent before the first ask (ISSUE-409).
 */
export function writeDurableAskState(
  target: StorageTarget, ask: DurableAskState,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  return withLedgerLock(target, () => {
    const read = readDoc(dir);
    if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
    // ISSUE-521 item 2: an ask record this build cannot parse is not merged
    // over. Replacing it with this process's empty (or partial) state would
    // erase a settled unit's claim and leave it ask-eligible again.
    if (read.doc.ask !== undefined && readAskOf(read.doc) === null) {
      return refuseWrite(dir, 'the ask record is structurally invalid');
    }
    return publishDoc(dir, { ...read.doc, ask });
  });
}

function isInstallOf(value: unknown): DurableInstall | null {
  if (!isRecord(value)) return null;
  if (!isCount(value.generation) || value.generation < 1) return null;
  if (!isCount(value.installedAtMs) || typeof value.sessionId !== 'string'
    || value.sessionId.length === 0 || !isStringArray(value.preInstallNodeIds)) return null;
  return {
    generation: value.generation, installedAtMs: value.installedAtMs,
    preInstallNodeIds: value.preInstallNodeIds, sessionId: value.sessionId,
  };
}

/**
 * The install identity this session's durable state carries, or null (fresh).
 * A present record this build cannot parse is named before it reads as fresh,
 * so "no identity" is never silently the same as "unreadable" (ISSUE-521
 * item 1). Absent in a document written before this fact existed, which reads
 * as the pre-521 behaviour (a mount that reads a ledger is a restart).
 */
export function readDurableInstall(
  target: StorageTarget, onReject?: MountStateRejection,
): DurableInstall | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const read = readDoc(dir);
  if (read.rejected !== undefined) {
    onReject?.(read.rejected);
    return null;
  }
  if (read.doc.install === undefined) return null;
  const install = isInstallOf(read.doc.install);
  if (install === null) {
    onReject?.('the install record is structurally invalid; reading it as absent');
    return null;
  }
  return install;
}

/** Record the mount identity/generation, preserving every other fact. */
export function writeDurableInstall(
  target: StorageTarget, install: DurableInstall,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  return withLedgerLock(target, () => {
    const read = readDoc(dir);
    if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
    if (read.doc.install !== undefined && isInstallOf(read.doc.install) === null) {
      return refuseWrite(dir, 'the install record is structurally invalid');
    }
    return publishDoc(dir, { ...read.doc, install });
  });
}
