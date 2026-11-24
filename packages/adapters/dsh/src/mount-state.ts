/**
 * The mount's durable identity and owed-removal state (ISSUE-414, ISSUE-417).
 *
 * The prune round store already keeps two facts beside a session's ledger
 * (`prune-round.json`): the round ordinal/latch and the pending-append intent.
 * This module keeps the three facts that must survive an UNLOAD rather than a
 * prune pass, in their own sibling file `mount-state.json` under the same
 * ADR-0013 per-session directory:
 *
 *   - `install` — the mount identity/generation and the tool-result node ids
 *     that were already on the host surface when this session's durable state
 *     was first created. A later mount that reads it knows the state is its own
 *     (a restart); a mount that reads nothing is a fresh install into a session
 *     that may already hold history, and it records that history as the
 *     session's inherited set. The set is fork/clone identity evidence
 *     (ISSUE-422, ISSUE-478); it is never an eligibility gate, so a later pass
 *     tables and removes those results exactly like one the mount observed land.
 *   - `forgets` — manual forgets the tool answered "scheduled" for and no
 *     boundary has applied yet. Written before the answer leaves, so an unload
 *     replays them instead of losing an accepted request (ISSUE-417).
 *   - `receipts` — the host receipts this port minted for applied removals.
 *     The in-process map dies with the process; this file lets a later mount's
 *     `lookupReceipt` resolve a prepared ledger row the previous process landed
 *     instead of reading `unknown` and blocking recovery forever (ISSUE-417).
 *
 * Each writer reads the current document, replaces only the fact it owns and
 * republishes the whole file atomically (temp + rename, the ISSUE-347 pattern),
 * so a kill mid-write tears only the temp and every other fact is preserved.
 *
 * ISSUE-578: two mounts of one durable root (two terminals, ADR-0075) now share
 * this file, sometimes across processes. The read-modify-write therefore runs
 * under the session ledger's own cross-process write lock, so neither mount can
 * publish a document built from a read that missed the other's fact.
 *
 * A failed read is not an absent file (ISSUE-499): an absent document reads as
 * "the in-memory state is the whole truth", but a present document that cannot
 * be read or parsed is named, and a writer refuses to republish a merged empty
 * document over it — merging into `{}` would durably erase every sibling fact
 * (ADR-0065 decision 4; the opencode ISSUE-484 refused-document protection). A
 * malformed record inside a readable document is named too, instead of reading
 * as an empty list with no cause; the read itself still fails open, and a
 * writer refuses to republish over the record it could not parse (ISSUE-568),
 * so a valid sibling receipt is never erased by a row this build cannot read.
 *
 * The document is versioned (ISSUE-523 item 4): `MOUNT_STATE_VERSION` is
 * stamped on every write, a document that declares another version is refused
 * by name, and an untagged document reads as version 1 so a pre-upgrade
 * session keeps its facts, so a future format change cannot silently drop a
 * fact and no upgrade drops one either.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ApplyReceipt } from '@cremator/core';
import type { ResolvedRacoonsStorage } from './storage.js';
import type { MountJournal } from './journal-kinds.js';

/** The state file's name, beside `ledger.sqlite`, `blobs/` and `prune-round.json`. */
export const MOUNT_STATE_FILE = 'mount-state.json';

/**
 * The document's format version (ISSUE-523 item 4). A renamed or removed field
 * would otherwise read as absent with no signal, so a future format change
 * silently drops claims, forgets or receipts. Every write stamps this value and
 * a read refuses a document that declares another one by name; an untagged
 * document is v1-shaped and reads as this version.
 */
const MOUNT_STATE_VERSION = 1;

/** A per-process token so two writes never stage the same temp name. */
let tempSeq = 0;

/** The durable install identity of one session (ISSUE-414). */
export interface DurableInstall {
  /** One per mount of this durable state; the first mount writes 1. */
  readonly generation: number;
  /** The wall time the first mount recorded, in ms. */
  readonly installedAtMs: number;
  /**
   * The tool-result node ids present on the host surface at the first mount.
   * They arrived before this session's state existed, so the mount never
   * observed them land. The set is retained as the fork/clone identity
   * evidence (ISSUE-422, ISSUE-478); it gates no eligibility, so a later pass
   * may table and remove these results like any other.
   */
  readonly preInstallNodeIds: readonly string[];
  /**
   * The session id this durable state was first installed for (ISSUE-422).
   * A mount that reads state naming a DIFFERENT session is holding a fork's or
   * clone's copy of the parent's state: the child inherits the parent's settled
   * history, so it must not replay it or apply the parent's owed work. Absent on
   * state written before this field existed (one process older), which reads as
   * the same session — the pre-422 restart behaviour, never a guess.
   */
  readonly sessionId?: string;
}

/** One accepted-but-unapplied manual forget (ISSUE-417). */
export interface DurableForget {
  readonly eventId: string;
  readonly unitId: string;
  readonly source: string;
  readonly label: string | null;
  readonly ranges: readonly { readonly startLine: number; readonly endLineInclusive: number }[];
}

interface MountDoc {
  /** The format this document was written under (`MOUNT_STATE_VERSION`). */
  readonly version?: number;
  readonly install?: DurableInstall;
  readonly forgets?: readonly DurableForget[];
  readonly receipts?: readonly ApplyReceipt[];
}

/** The session directory a resolved durable target names, or null in memory. */
function sessionDirOf(target: ResolvedRacoonsStorage): string | null {
  return target.databasePath === ':memory:' ? null : dirname(target.databasePath);
}

/** A read's result: the usable document, and why a present one was refused. */
interface DocRead {
  readonly doc: MountDoc;
  readonly reason?: string;
}

/** The sink a reader calls when a present document or record is refused (ISSUE-499). */
type RejectionSink = (reason: string) => void;

/**
 * Read one document. An absent file is legitimately fresh; a present file this
 * build cannot read — a transient `readFileSync` failure (Windows AV/EBUSY/
 * EPERM/EMFILE on a just-renamed file), bad JSON, or not an object — is refused
 * with its reason so the caller can name it (ISSUE-499; ADR-0065 decision 4).
 */
function readDoc(dir: string): DocRead {
  let raw: string;
  try {
    raw = fs.readFileSync(join(dir, MOUNT_STATE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: {} };
    return { doc: {}, reason: 'the mount-state file could not be read: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: {}, reason: 'the mount-state file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { doc: {}, reason: 'the mount-state file is not a JSON object' };
  }
  // A document written before the version field existed is v1-shaped: its three
  // facts already match `MOUNT_STATE_VERSION`, so an absent tag reads as 1 and
  // the install identity, owed forgets and receipts survive the upgrade. Only a
  // tag that states another version is refused by name.
  const version = (parsed as { readonly version?: unknown }).version;
  if (version !== undefined && version !== MOUNT_STATE_VERSION) {
    return { doc: {}, reason: 'the mount-state file declares format version '
      + `${String(version)}; this build reads only version ${String(MOUNT_STATE_VERSION)}` };
  }
  return { doc: parsed as MountDoc };
}

/**
 * Refuse a write over a document this build cannot read (ISSUE-499; ADR-0065
 * decision 4). Merging into the discarded empty read would replace the other
 * facts with this writer's version, so the refusal is named and the next
 * boundary retries once the document reads again. The in-memory fact still
 * serves this process; only its restart durability waits.
 */
function refuseWrite(dir: string, reason: string, journal: MountJournal, sessionId: string,
  fields: Record<string, unknown>): false {
  journal('mount-state-error', { sessionId, ...fields, refused: true,
    reason: `refusing to overwrite ${join(dir, MOUNT_STATE_FILE)}: ${reason}` });
  return false;
}

/** The named-rejection sink for one fact, or a no-op when the caller supplied none. */
function rejectionOf(journal: MountJournal | undefined, sessionId: string | undefined,
  fact: string): RejectionSink {
  return (reason: string): void => {
    journal?.('mount-state-error', { sessionId, fact, refused: true, reason });
  };
}

/** Publish one complete document atomically; false when it could not be written. */
function publishDoc(dir: string, doc: MountDoc, journal: MountJournal, sessionId: string,
  fields: Record<string, unknown>): boolean {
  const final = join(dir, MOUNT_STATE_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ ...doc, version: MOUNT_STATE_VERSION })}\n`, 'utf8');
    fs.renameSync(temp, final);
    return true;
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never have been created */ }
    journal('mount-state-error', { sessionId, ...fields,
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * How long one state write waits for the session ledger's write lock. The value
 * is the ledger's own (`sqlite-ledger.ts` opens every ledger with
 * `busy_timeout = 5000`), so a held lock is waited out for exactly as long as a
 * ledger append is, and no state write is lost to contention it could have
 * waited out. No new cap: the bound is the ledger's own (ADR-0060).
 */
const STATE_LOCK_TIMEOUT_MS = 5000;

/**
 * Run one read-modify-write under the ledger's cross-process write lock
 * (ISSUE-578). Two mounts of one root in different processes write this file;
 * without a lock each could publish a document whose read missed the other's
 * fact, silently dropping a receipt, a pending forget or the ask state.
 * `BEGIN IMMEDIATE` on this session's own `ledger.sqlite` is the mutex every
 * mount of the session already shares, and SQLite serializes it across
 * processes. The lock covers a synchronous section only, so no mount ever waits
 * on another mount's ledger work while holding it, and this process's own
 * ledger handle is never inside a transaction when a state write runs
 * (JavaScript is single-threaded). A lock that cannot be taken fails the write
 * by name, which the caller journals.
 */
function withLedgerLock(target: ResolvedRacoonsStorage, journal: MountJournal,
  sessionId: string, fields: Record<string, unknown>, write: () => boolean): boolean {
  const databasePath = target.databasePath;
  // No ledger file means no mount has opened this session here, so there is no
  // other writer of this session's state to interleave with.
  if (databasePath === ':memory:' || !fs.existsSync(databasePath)) return write();
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath); }
  catch (error) { return lockFailure(journal, sessionId, fields, databasePath, error); }
  try {
    db.exec(`PRAGMA busy_timeout = ${String(STATE_LOCK_TIMEOUT_MS)}`);
    db.exec('BEGIN IMMEDIATE');
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the write never started */ }
    return lockFailure(journal, sessionId, fields, databasePath, error);
  } finally {
    try { db.close(); } catch { /* the write's own result stands */ }
  }
}

/** The named failure of a state write that could not take the ledger lock. */
function lockFailure(journal: MountJournal, sessionId: string,
  fields: Record<string, unknown>, databasePath: string, error: unknown): false {
  const reason = error instanceof Error ? error.message : String(error);
  journal('mount-state-error', { sessionId, ...fields, refused: true,
    reason: `refusing to write ${join(dirname(databasePath), MOUNT_STATE_FILE)} without the `
      + `ledger's cross-process lock: ${reason}` });
  return false;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readInstallOf(doc: MountDoc): DurableInstall | null {
  const install = doc.install;
  if (typeof install !== 'object' || install === null) return null;
  const candidate = install as { readonly generation?: unknown; readonly installedAtMs?: unknown;
    readonly preInstallNodeIds?: unknown; readonly sessionId?: unknown };
  if (!isCount(candidate.generation) || candidate.generation < 1
    || !isCount(candidate.installedAtMs) || !Array.isArray(candidate.preInstallNodeIds)) return null;
  if (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string') return null;
  const ids = candidate.preInstallNodeIds.filter((id): id is string => typeof id === 'string');
  if (ids.length !== candidate.preInstallNodeIds.length) return null;
  return { generation: candidate.generation, installedAtMs: candidate.installedAtMs,
    preInstallNodeIds: ids, ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }) };
}

/**
 * The install identity this session's durable state carries, or null (fresh).
 * A present record this build cannot parse is named before it reads as fresh
 * (ISSUE-499), so "no identity" is never silently the same as "unreadable".
 */
export function readInstall(target: ResolvedRacoonsStorage, journal?: MountJournal,
  sessionId?: string): DurableInstall | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const read = readDoc(dir);
  const reject = rejectionOf(journal, sessionId, 'install');
  if (read.reason !== undefined) { reject(read.reason); return null; }
  const install = readInstallOf(read.doc);
  if (install === null && read.doc.install !== undefined) {
    reject('the install record is structurally invalid; reading it as absent');
  }
  return install;
}

/** Record the mount identity/generation, preserving every other fact. */
export function writeInstall(target: ResolvedRacoonsStorage, install: DurableInstall,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const fields = { fact: 'install', generation: install.generation };
  return withLedgerLock(target, journal, sessionId, fields, () => {
    const read = readDoc(dir);
    if (read.reason !== undefined) return refuseWrite(dir, read.reason, journal, sessionId, fields);
    return publishDoc(dir, { ...read.doc, install }, journal, sessionId, fields);
  });
}

function readForgetsOf(doc: MountDoc): DurableForget[] {
  const forgets = doc.forgets;
  if (!Array.isArray(forgets)) return [];
  const out: DurableForget[] = [];
  for (const value of forgets) {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as { readonly eventId?: unknown; readonly unitId?: unknown;
      readonly source?: unknown; readonly label?: unknown; readonly ranges?: unknown };
    if (typeof record.eventId !== 'string' || typeof record.unitId !== 'string'
      || typeof record.source !== 'string'
      || (record.label !== null && typeof record.label !== 'string')
      || !Array.isArray(record.ranges)) return [];
    const ranges: { startLine: number; endLineInclusive: number }[] = [];
    for (const range of record.ranges) {
      if (typeof range !== 'object' || range === null) return [];
      const item = range as { readonly startLine?: unknown; readonly endLineInclusive?: unknown };
      if (!isCount(item.startLine) || !isCount(item.endLineInclusive)) return [];
      ranges.push({ startLine: item.startLine, endLineInclusive: item.endLineInclusive });
    }
    out.push({ eventId: record.eventId, unitId: record.unitId, source: record.source,
      label: record.label as string | null, ranges });
  }
  return out;
}

/**
 * The accepted-but-unapplied forgets this session's state carries. A malformed
 * record is named instead of reading as an empty queue (ISSUE-499): dropping
 * it loses owed work, and a silent drop reads exactly like "nothing owed".
 */
export function readPendingForgets(target: ResolvedRacoonsStorage, journal?: MountJournal,
  sessionId?: string): DurableForget[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  const read = readDoc(dir);
  const reject = rejectionOf(journal, sessionId, 'forgets');
  if (read.reason !== undefined) { reject(read.reason); return []; }
  const forgets = read.doc.forgets;
  if (forgets !== undefined && !Array.isArray(forgets)) {
    reject('the forgets record is not an array; reading it as absent');
    return [];
  }
  const records = readForgetsOf(read.doc);
  if (records.length === 0 && (forgets?.length ?? 0) > 0) {
    reject('the forgets record is structurally invalid; reading it as absent');
  }
  return records;
}

/** Replace the owed-forget fact; an empty list removes it. */
export function writePendingForgets(target: ResolvedRacoonsStorage,
  forgets: readonly DurableForget[], journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const fields = { fact: 'forgets', pending: forgets.length };
  return withLedgerLock(target, journal, sessionId, fields, () => {
    const read = readDoc(dir);
    if (read.reason !== undefined) return refuseWrite(dir, read.reason, journal, sessionId, fields);
    const { forgets: _prior, ...rest } = read.doc;
    return publishDoc(dir, { ...rest, ...(forgets.length === 0 ? {} : { forgets }) },
      journal, sessionId, fields);
  });
}

/** The receipts fact as read, and why a readable document's copy was unusable. */
interface ReceiptsRead {
  readonly rows: ApplyReceipt[];
  readonly rejected?: string;
}

function readReceiptsOf(doc: MountDoc): ReceiptsRead {
  const receipts = doc.receipts;
  if (!Array.isArray(receipts)) {
    return receipts === undefined ? { rows: [] }
      : { rows: [], rejected: 'the receipts record is not an array' };
  }
  const out: ApplyReceipt[] = [];
  for (const value of receipts) {
    if (typeof value !== 'object' || value === null) {
      return { rows: [], rejected: 'the receipts record holds a structurally invalid row' };
    }
    const receipt = value as { readonly intentId?: unknown; readonly sessionId?: unknown;
      readonly baseRevision?: unknown; readonly resultRevision?: unknown;
      readonly applicationSha256?: unknown; readonly appliedAtMs?: unknown };
    if (typeof receipt.intentId !== 'string' || typeof receipt.sessionId !== 'string'
      || typeof receipt.baseRevision !== 'string' || typeof receipt.resultRevision !== 'string'
      || typeof receipt.applicationSha256 !== 'string' || !isCount(receipt.appliedAtMs)) {
      return { rows: [], rejected: 'the receipts record holds a structurally invalid row' };
    }
    out.push(value as ApplyReceipt);
  }
  return { rows: out };
}

/**
 * The host receipts a previous process minted for this session. A malformed
 * record is named instead of reading as absent (ISSUE-499): losing one would
 * block its recovery as `unknown` with no named cause.
 */
export function readDurableReceipts(target: ResolvedRacoonsStorage, journal?: MountJournal,
  sessionId?: string): ApplyReceipt[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  const read = readDoc(dir);
  const reject = rejectionOf(journal, sessionId, 'receipts');
  if (read.reason !== undefined) { reject(read.reason); return []; }
  const rows = readReceiptsOf(read.doc);
  if (rows.rejected !== undefined) { reject(`${rows.rejected}; reading it as absent`); }
  return rows.rows;
}

/**
 * Record one applied receipt, replacing any earlier row for the same intent.
 * The port calls this at the host write, before the engine's own `applied`
 * ledger row, so a death in between leaves a durable receipt the remount's
 * `lookupReceipt` can answer from (ISSUE-417).
 */
export function writeDurableReceipt(target: ResolvedRacoonsStorage, receipt: ApplyReceipt,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const fields = { fact: 'receipts', intentId: receipt.intentId };
  return withLedgerLock(target, journal, sessionId, fields, () => {
    const read = readDoc(dir);
    if (read.reason !== undefined) return refuseWrite(dir, read.reason, journal, sessionId, fields);
    const prior = readReceiptsOf(read.doc);
    if (prior.rejected !== undefined) {
      return refuseWrite(dir, prior.rejected, journal, sessionId, fields);
    }
    const kept = prior.rows.filter(row => row.intentId !== receipt.intentId);
    return publishDoc(dir, { ...read.doc, receipts: [...kept, receipt] }, journal, sessionId,
      { ...fields, count: kept.length + 1 });
  });
}

/**
 * Drop one durable receipt once the ledger's own `applied` row supersedes it
 * (ISSUE-436). The receipt exists only for the crash window between the host
 * write and that row (ISSUE-417); the ledger is the record of record (ADR-0015),
 * so the copy has no further reader. Garbage collection of superseded state,
 * not a cap. A failed write is journaled inside `publishDoc`, like every other
 * mount-state write.
 */
export function removeDurableReceipt(target: ResolvedRacoonsStorage, intentId: string,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  return withLedgerLock(target, journal, sessionId,
    { fact: 'receipts', collected: intentId }, () => {
      const read = readDoc(dir);
      if (read.reason !== undefined) {
        return refuseWrite(dir, read.reason, journal, sessionId,
          { fact: 'receipts', collected: intentId });
      }
      const prior = readReceiptsOf(read.doc);
      if (prior.rejected !== undefined) {
        return refuseWrite(dir, prior.rejected, journal, sessionId,
          { fact: 'receipts', collected: intentId });
      }
      const remaining = prior.rows.filter(row => row.intentId !== intentId);
      if (remaining.length === prior.rows.length) return true;
      const { receipts: _prior, ...rest } = read.doc;
      return publishDoc(dir, { ...rest, ...(remaining.length === 0 ? {} : { receipts: remaining }) },
        journal, sessionId, { fact: 'receipts', collected: intentId, count: remaining.length });
    });
}
