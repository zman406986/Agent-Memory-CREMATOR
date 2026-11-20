import {
  closeSync, existsSync, linkSync, openSync, readFileSync, readdirSync, readSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fsyncFile, syncDirectoryChain } from "./fs-durability.js";
import { hasCode, storageError } from "./integrity.js";
import { asRow, asRows } from "./rows.js";
import type { Row, SqlValue } from "./rows.js";
import {
  LEGACY_SCHEMA_VERSION, LEDGER_APPLICATION_ID, LEDGER_TABLES, PREVIOUS_SCHEMA_VERSION,
  SCHEMA_VERSION, initializeSchema,
} from "./schema.js";
import { LedgerError } from "./types.js";

/**
 * The retired version-1 file. Its presence is the never-re-read marker for that
 * version. Each source version keeps its own suffix, so the v1 backup taken by
 * an earlier migration survives a later v2 rebuild untouched.
 */
export const LEGACY_BACKUP_SUFFIX = `.v${LEGACY_SCHEMA_VERSION}.bak`;
/** The retired version-2 file (the verdict-only CHECK). */
export const VERDICT_BACKUP_SUFFIX = `.v${PREVIOUS_SCHEMA_VERSION}.bak`;
/** The staged current-version file; renamed over the main path once durable. */
export const MIGRATION_STAGING_SUFFIX = `.v${SCHEMA_VERSION}.tmp`;
/**
 * The single-writer lock for one file's migration. It lives beside the file so
 * two processes that open the same legacy database cannot rebuild, promote or
 * delete each other's staging.
 */
export const MIGRATION_LOCK_SUFFIX = ".migration.lock";
/** A lock this old is stale even when its recorded pid still exists (pid reuse). */
const MIGRATION_LOCK_STALE_MS = 60_000;
/** How long a waiter retries a live owner's lock before refusing by name. */
const MIGRATION_LOCK_WAIT_MS = 5_000;
/** Poll interval between lock attempts while another owner's migration runs. */
const MIGRATION_LOCK_RETRY_MS = 25;
/** Staging suffixes earlier schema versions wrote; a crash may leave one complete. */
const RETIRED_STAGING_SUFFIXES = [".v2.tmp"] as const;

/** Every version `migration.ts` rebuilds, with the suffix its backup takes. */
const BACKUP_SUFFIXES: readonly (readonly [number, string])[] = [
  [LEGACY_SCHEMA_VERSION, LEGACY_BACKUP_SUFFIX],
  [PREVIOUS_SCHEMA_VERSION, VERDICT_BACKUP_SUFFIX],
];

const SQLITE_MAGIC = "SQLite format 3\u0000";
const HEADER_BYTES = 100;
const JOURNAL_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * One column list per table, in dependency order. Copied explicitly, never by
 * `SELECT *`, so an older file with an extra legacy column still migrates and
 * the insert order stays deterministic.
 */
const COLUMNS: readonly (readonly [string, readonly string[]])[] = [
  ["blobs", ["sha256", "byte_length", "created_at_ms"]],
  ["recalls", ["recall_id", "manifest_sha256", "created_at_ms"]],
  ["recall_parts", ["recall_id", "part_index", "source_node_id", "source_sha256",
    "source_byte_length", "blob_sha256"]],
  ["removed_spans", ["recall_id", "part_index", "span_index", "start_byte",
    "end_byte_exclusive", "slice_sha256"]],
  ["applications", ["intent_id", "session_id", "event_id", "base_revision", "phase",
    "application_sha256", "metadata_json", "created_at_ms"]],
  ["application_removals", ["intent_id", "rule_id", "removal_id", "recall_id",
    "operation_kind", "episode_id", "title"]],
  ["ledger_events", ["sequence", "event_key", "session_id", "intent_id", "kind",
    "at_ms", "payload_json"]],
];

export type MigrationStatus = "fresh" | "current" | "migrated" | "resumed";

/** Named points a test may stop at. Each name means "and then crash here". */
export type MigrationStep = "staged" | "durable" | "retired" | "sidecars";

export interface LedgerFileOptions {
  readonly databasePath: string;
  /** Test seam: throwing here simulates a crash at that boundary. */
  readonly onStep?: (step: MigrationStep) => void;
}

export interface LedgerFileOutcome {
  readonly status: MigrationStatus;
  /** Absolute path of the most recent retired older-version file, when any exists. */
  readonly backupPath: string | null;
  /** Rows carried into the staged file; 0 when nothing was rebuilt. */
  readonly rowsCopied: number;
}

interface Facts {
  readonly exists: boolean;
  readonly isDatabase: boolean;
  readonly version: number;
  readonly applicationId: number;
}

const ABSENT: Facts = { exists: false, isDatabase: false, version: 0, applicationId: 0 };

/**
 * Brings the file at `databasePath` to the current schema: a version-1 or
 * version-2 file is rebuilt into a fresh current-version file in one hop, and
 * the old file is then renamed `*.v<old>.bak` — never mutated in place, never
 * re-read once its own `.bak` sibling exists.
 *
 * The file at the main path is, at every instant, either the untouched old
 * file, absent, or a complete current-version file. Nothing in between is ever
 * observable.
 *
 * Synchronous on purpose: this is a short, sequential file protocol, and an
 * `await` between the retire and the promote would widen the window in which
 * the main path is absent for no gain.
 *
 * One owner lock per file serializes a rebuild or a crash repair across
 * processes. The lock is claimed only when one of those is needed: an
 * already-current (or fresh) ledger opens without it, so simultaneous opens of
 * the same current file cannot fail each other. A waiter retries for a bounded
 * time before refusing by name, and never touches the owner's staging.
 */
export function prepareLedgerFile(options: LedgerFileOptions): LedgerFileOutcome {
  if (options.databasePath === ":memory:") {
    return { status: "fresh", backupPath: null, rowsCopied: 0 };
  }
  const main = resolve(options.databasePath);
  try {
    const facts = inspect(main);
    if (!needsOwnerLock(main, facts)) {
      const plan = planFor(main, facts);
      // `resume` and `rebuild` normally imply the lock. A shape change between
      // inspection and planning falls through and takes it rather than acting
      // without the owner.
      if (plan.kind !== "resume" && plan.kind !== "rebuild") {
        return applyPlan(options, main, plan, false);
      }
    }
    const lock = acquireMigrationLock(main);
    try {
      // Another owner may have finished while this process waited; classify
      // again under the lock so a later open sees the promoted file.
      return applyPlan(options, main, planFor(main, inspect(main)), true);
    } finally {
      releaseMigrationLock(lock);
    }
  } catch (error) {
    throw storageError(error, "Cannot prepare trash ledger file");
  }
}

/**
 * True unless the file is already current/fresh or can be refused without an
 * owner. An older version takes the lock even when its `.bak` sibling means the
 * answer will be a refusal: another process may have created that backup while
 * this one was inspecting, so only the lock owner can classify it without
 * racing a live migration.
 */
function needsOwnerLock(main: string, facts: Facts): boolean {
  if (!facts.exists) return existingBackup(main) !== null;
  if (!facts.isDatabase) return false;
  if (facts.applicationId !== 0 && facts.applicationId !== LEDGER_APPLICATION_ID) return false;
  return facts.version !== SCHEMA_VERSION && facts.version !== 0;
}

type FilePlan =
  | { readonly kind: "fresh" }
  | { readonly kind: "current"; readonly backupPath: string | null }
  | { readonly kind: "resume"; readonly backup: string; readonly staged: string }
  | { readonly kind: "rebuild"; readonly backup: string }
  | { readonly kind: "refuse"; readonly error: LedgerError };

/** What the file's shape asks for; reads headers and names, changes nothing. */
function planFor(main: string, facts: Facts): FilePlan {
  if (!facts.exists) {
    // A crash between "retire" and "promote" leaves exactly this shape: no
    // main, an old-version backup, and a complete staged file. Promote it.
    const backup = existingBackup(main);
    if (backup === null) return { kind: "fresh" };
    const staged = promotableStaging(main);
    if (staged === null) {
      // Never re-read the backup (ruling), and never silently start an
      // empty ledger over one: that would lose the recorded history.
      return { kind: "refuse", error: new LedgerError("storage",
        `Trash ledger is missing; ${backup} exists but no complete rebuild is staged`) };
    }
    return { kind: "resume", backup, staged };
  }
  if (!facts.isDatabase) {
    return { kind: "refuse", error: new LedgerError("unsupported-schema",
      `Not a SQLite database: ${main}`) };
  }
  if (facts.applicationId !== 0 && facts.applicationId !== LEDGER_APPLICATION_ID) {
    return { kind: "refuse", error: new LedgerError("unsupported-schema",
      `Database is not a RACOONS trash ledger (application id ${String(facts.applicationId)})`) };
  }
  if (facts.version === SCHEMA_VERSION || facts.version === 0) {
    // 0 is an uninitialized SQLite file: `initializeSchema` stamps it, or
    // refuses when it already holds an older-shaped `application_removals`.
    return { kind: "current", backupPath: existingBackup(main) };
  }
  const backupSuffix = BACKUP_SUFFIXES.find(([version]) => version === facts.version)?.[1];
  if (backupSuffix === undefined) {
    return { kind: "refuse", error: new LedgerError("unsupported-schema",
      `Unsupported trash ledger schema ${String(facts.version)}`) };
  }
  const backup = `${main}${backupSuffix}`;
  if (existsSync(backup)) {
    // Ruling: an old-version file with its `.bak` sibling is never re-read.
    // Rebuilding again would overwrite the evidence of the first migration.
    return { kind: "refuse", error: new LedgerError("unsupported-schema",
      `Refusing to re-read a version-${String(facts.version)} trash ledger beside ${backup}`) };
  }
  return { kind: "rebuild", backup };
}

/**
 * Executes a plan. `resume` and `rebuild` are only reachable with the owner
 * lock held; the caller classifies again after acquiring it. Staging is deleted
 * only under that lock, so a waiter never removes another owner's work.
 */
function applyPlan(
  options: LedgerFileOptions, main: string, plan: FilePlan, ownsLock: boolean,
): LedgerFileOutcome {
  switch (plan.kind) {
    case "refuse":
      throw plan.error;
    case "fresh":
      if (ownsLock) discardStaging(main);
      return { status: "fresh", backupPath: null, rowsCopied: 0 };
    case "current":
      if (ownsLock) discardStaging(main);
      return { status: "current", backupPath: plan.backupPath, rowsCopied: 0 };
    case "resume": {
      // A crash between the main rename and the sidecar renames leaves the
      // WAL beside the absent main. Move it under the backup name first, so
      // the backup stays a complete database, then drop only true leftovers.
      retireJournalSidecars(main, plan.backup);
      syncDirectoryChain(dirname(main));
      deleteStaleSidecars(main);
      promote(plan.staged, main);
      if (plan.staged !== `${main}${MIGRATION_STAGING_SUFFIX}`) {
        // A crash under an earlier schema left a complete staging file of
        // that version. It is main now and still needs its own rebuild.
        return { ...applyPlan(options, main, planFor(main, inspect(main)), true), status: "resumed" };
      }
      return { status: "resumed", backupPath: plan.backup, rowsCopied: 0 };
    }
    case "rebuild":
      // A stale staging file is a crashed earlier attempt; it is untrusted.
      discardStaging(main);
      return rebuild(main, plan.backup, `${main}${MIGRATION_STAGING_SUFFIX}`, options.onStep);
  }
}

/** The most recent retired version's `.bak` sibling, or null when none exists. */
function existingBackup(main: string): string | null {
  for (const [, suffix] of [...BACKUP_SUFFIXES].reverse()) {
    const path = `${main}${suffix}`;
    if (existsSync(path)) return path;
  }
  return null;
}

/** The complete staged file a crashed migration left, current version first. */
function promotableStaging(main: string): string | null {
  for (const path of stagingPaths(main)) {
    if (stagingVersion(path) !== null) return path;
  }
  return null;
}

/** A post-retire staging file of the current version, then of retired versions. */
function stagingPaths(main: string): readonly string[] {
  return [`${main}${MIGRATION_STAGING_SUFFIX}`,
    ...RETIRED_STAGING_SUFFIXES.map(suffix => `${main}${suffix}`)];
}

/**
 * Rebuild order (the crash-safety contract, one filesystem step per line):
 *
 * 1. read the old file once through a read-only handle — main is never written;
 * 2. write the whole current-version file at `*.v3.tmp` (DELETE journal, one file);
 * 3. fsync the staged file, then its directory — its bytes are flushed to
 *    the filesystem (macOS power-cut limit: see fs-durability.ts);
 * 4. rename old → `*.v<old>.bak` and fsync the directory;
 * 5. rename its journal sidecars beside the backup, then fsync the directory;
 * 6. rename `*.v3.tmp` → main, then fsync the directory.
 *
 * A crash before 3 leaves the old file untouched plus a deletable staging file.
 * A crash between 4 and 5 leaves no main, a complete backup, the old WAL still
 * beside the main path, and a complete staged file — the next open moves the
 * sidecars under the backup name, then promotes the staged file (`resumed`).
 * A crash after 5 leaves a complete current-version file. No ordering leaves a
 * half-migrated file at the main path, and the old file is never written: it is
 * only renamed.
 */
function rebuild(
  main: string, backup: string, staging: string, onStep?: (step: MigrationStep) => void,
): LedgerFileOutcome {
  const legacy = new DatabaseSync(main, { readOnly: true });
  let rows: ReadonlyMap<string, readonly Row[]>;
  try { rows = readLegacy(legacy); } finally { legacy.close(); }

  const staged = new DatabaseSync(staging);
  try {
    staged.exec("PRAGMA journal_mode = DELETE");
    staged.exec("PRAGMA synchronous = FULL");
    staged.exec("PRAGMA foreign_keys = ON");
    initializeSchema(staged);
    staged.exec("BEGIN IMMEDIATE");
    try {
      copyRows(staged, rows);
      verifyCounts(staged, rows);
      staged.exec("COMMIT");
    } catch (error) {
      staged.exec("ROLLBACK");
      throw error;
    }
    assertQuickCheck(staged, "Staged trash ledger failed its integrity check");
  } finally { staged.close(); }
  onStep?.("staged");

  fsyncFile(staging);
  syncDirectoryChain(dirname(staging));
  onStep?.("durable");

  renameSync(main, backup);
  syncDirectoryChain(dirname(main));
  onStep?.("retired");
  // The WAL and SHM travel with the file they belong to. A crash before this
  // step leaves them beside the absent main; recovery moves them under the
  // backup name, so the backup never loses uncheckpointed frames.
  retireJournalSidecars(main, backup);
  syncDirectoryChain(dirname(main));
  onStep?.("sidecars");
  deleteStaleSidecars(main);

  promote(staging, main);
  return { status: "migrated", backupPath: backup, rowsCopied: countRows(rows) };
}

function readLegacy(db: DatabaseSync): ReadonlyMap<string, readonly Row[]> {
  const tables = new Map<string, readonly Row[]>();
  for (const [table, columns] of COLUMNS) {
    tables.set(table, asRows(db.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all(), table));
  }
  return tables;
}

function copyRows(db: DatabaseSync, rows: ReadonlyMap<string, readonly Row[]>): void {
  for (const [table, columns] of COLUMNS) {
    const values = rows.get(table) ?? [];
    if (values.length === 0) continue;
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of values) insert.run(...columns.map(column => row[column] as SqlValue));
  }
}

/** The copy is only a migration if every row arrived; counts come from both sides. */
function verifyCounts(db: DatabaseSync, rows: ReadonlyMap<string, readonly Row[]>): void {
  for (const [table] of COLUMNS) {
    const expected = rows.get(table)?.length ?? 0;
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    const actual = row === undefined ? -1 : asRow(row, table)["n"];
    if (actual !== expected) {
      throw new LedgerError("storage", `Staged ${table} holds ${String(actual)} of ${expected} rows`);
    }
  }
}

function countRows(rows: ReadonlyMap<string, readonly Row[]>): number {
  let total = 0;
  for (const values of rows.values()) total += values.length;
  return total;
}

function promote(staging: string, main: string): void {
  renameSync(staging, main);
  syncDirectoryChain(dirname(main));
}

function assertQuickCheck(db: DatabaseSync, message: string): void {
  const check = db.prepare("PRAGMA quick_check").get();
  if (check === undefined || asRow(check, "quick_check")["quick_check"] !== "ok") {
    throw new LedgerError("storage", message);
  }
}

/**
 * The schema version a staged file carries, or null when it is missing,
 * foreign, or not self-consistent. The current version and the version just
 * before it are both promotable: a crash that ran under the older schema left
 * a complete staging file of that version, which is promoted and then rebuilt
 * again by the caller.
 */
function stagingVersion(staging: string): number | null {
  if (!existsSync(staging)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(staging, { readOnly: true });
    const version = pragma(db, "user_version");
    if (version === null || (version !== SCHEMA_VERSION && version !== PREVIOUS_SCHEMA_VERSION)) {
      return null;
    }
    if (pragma(db, "application_id") !== LEDGER_APPLICATION_ID) return null;
    const tables = asRows(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all(), "sqlite_master")
      .map(row => row["name"]);
    if (!LEDGER_TABLES.every(table => tables.includes(table))) return null;
    assertQuickCheck(db, "Incomplete staged ledger");
    return version;
  } catch {
    return null;
  } finally { db?.close(); }
}

/**
 * Move the old file's journal sidecars beside its backup. A destination that
 * already exists is a duplicate left by a crash during an earlier recovery:
 * the source copy is the leftover, so it is removed rather than overwriting
 * the evidence already retired.
 */
function retireJournalSidecars(main: string, backup: string): void {
  for (const suffix of JOURNAL_SIDECARS) {
    const source = `${main}${suffix}`;
    if (!existsSync(source)) continue;
    const target = `${backup}${suffix}`;
    if (existsSync(target)) rmSync(source, { force: true });
    else renameSync(source, target);
  }
}

/**
 * Delete journal files a crashed writer left beside the main path. Only called
 * where the main path is absent or already current — never beside an older file
 * whose uncheckpointed frames would be lost.
 */
function deleteStaleSidecars(main: string): void {
  for (const suffix of JOURNAL_SIDECARS) rmSync(`${main}${suffix}`, { force: true });
}

/** Deletes every staging file a crashed attempt could have left at `main`. */
function discardStaging(main: string): void {
  for (const path of stagingPaths(main)) {
    rmSync(path, { force: true });
    for (const suffix of JOURNAL_SIDECARS) rmSync(`${path}${suffix}`, { force: true });
  }
}

function pragma(db: DatabaseSync, name: string): number | null {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : asRow(row, name)[name];
  return typeof value === "number" ? value : null;
}

/**
 * Header first, so a foreign file is refused before SQLite touches it. Then
 * SQLite reads the version, because a crashed WAL writer may carry the latest
 * `user_version` only in its WAL.
 */
function inspect(path: string): Facts {
  if (!existsSync(path)) return ABSENT;
  if (statSync(path).size > 0 && readMagic(path) !== SQLITE_MAGIC) {
    return { exists: true, isDatabase: false, version: 0, applicationId: 0 };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Eight simultaneous opens of a WAL-mode current file can catch another
    // opener mid-checkpoint or mid-schema-init. Wait like the main handle does
    // instead of failing the open on SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    return {
      exists: true, isDatabase: true,
      version: pragma(db, "user_version") ?? 0,
      applicationId: pragma(db, "application_id") ?? 0,
    };
  } finally { db.close(); }
}

function readMagic(path: string): string | null {
  const buffer = Buffer.alloc(HEADER_BYTES);
  const fd = openSync(path, "r");
  let read = 0;
  try { read = readSync(fd, buffer, 0, HEADER_BYTES, 0); } finally { closeSync(fd); }
  // A short file cannot be a database; SQLite rejects it, and so does this.
  return read < HEADER_BYTES ? "" : buffer.toString("latin1", 0, SQLITE_MAGIC.length);
}

interface HeldMigrationLock {
  readonly path: string;
  readonly token: string;
}

interface MigrationLockOwner {
  readonly pid: number;
  readonly atMs: number;
  readonly token: string;
}

/**
 * Claim the single-writer migration lock for `main`. The owner record is
 * written completely to a claim temp file, then linked into place: link
 * refuses an existing path, so the lock never exists without its owner and a
 * crash cannot leave an ownerless lock that fresh mtime would judge live
 * (ISSUE-321). A live owner is waited on for a bounded time, then named in
 * the refusal; stale owner records (dead pid, or age beyond the bound) are
 * stolen with an atomic rename, so two waiters cannot both believe they
 * removed the same stale lock.
 */
function acquireMigrationLock(main: string): HeldMigrationLock {
  const path = `${main}${MIGRATION_LOCK_SUFFIX}`;
  const token = `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
  sweepStaleClaims(path);
  let steals = 0;
  for (;;) {
    const claim = `${path}.claim-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    try {
      try {
        writeFileSync(claim,
          JSON.stringify({ pid: process.pid, atMs: Date.now(), token } satisfies MigrationLockOwner));
        linkSync(claim, path);
      } finally { rmSync(claim, { force: true }); }
      return { path, token };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const owner = readMigrationLockOwner(path);
      if (migrationLockIsStale(path, owner) && steals < 1) {
        breakStaleMigrationLock(path);
        steals++;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LedgerError("storage",
          `Trash ledger migration is already in progress: ${path}` +
          (owner === null ? "" : ` (pid ${String(owner.pid)})`));
      }
      sleepSync(Math.min(MIGRATION_LOCK_RETRY_MS, remaining));
    }
  }
}

/**
 * Remove claim temp files a crashed acquirer left beside the lock. The age
 * bound is the lock's own staleness bound; a live acquirer's claim is
 * milliseconds old. Best effort — a sweep failure must never fail the acquire.
 */
function sweepStaleClaims(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.claim-`;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const claim = join(dir, entry.name);
    try {
      if (Date.now() - statSync(claim).mtimeMs <= MIGRATION_LOCK_STALE_MS) continue;
      rmSync(claim, { force: true });
    } catch { /* a later acquire sweeps what this one could not remove */ }
  }
}

/** Synchronous pause: the protocol is synchronous, so a waiter must not yield. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseMigrationLock(lock: HeldMigrationLock): void {
  try {
    // Delete only on a positive token match: an unreadable owner record
    // cannot confirm ownership, so the lock stays for stale-lock recovery
    // (ISSUE-320).
    const owner = readMigrationLockOwner(lock.path);
    if (owner === null || owner.token !== lock.token) return;
    unlinkSync(lock.path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw storageError(error, "Cannot release trash ledger migration lock");
    }
  }
}

function readMigrationLockOwner(path: string): MigrationLockOwner | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null ||
        !("pid" in raw) || typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) ||
        !("atMs" in raw) || typeof raw.atMs !== "number" || !Number.isFinite(raw.atMs) ||
        !("token" in raw) || typeof raw.token !== "string") return null;
    return { pid: raw.pid, atMs: raw.atMs, token: raw.token };
  } catch { return null; }
}

function migrationLockIsStale(path: string, owner: MigrationLockOwner | null): boolean {
  // The lock is linked into place fully written, so an unreadable owner is a
  // crashed legacy claim or corruption — never a live owner (ISSUE-321).
  if (owner === null) return true;
  return !processExists(owner.pid) || Date.now() - owner.atMs > MIGRATION_LOCK_STALE_MS;
}

/**
 * Steal a judged-stale lock by renaming it to a tombstone, then verifying the
 * moved record: a live lock that replaced the stale one mid-judgment is put
 * back. `onTombstoned` is a test seam run after the tombstone rename and
 * before the verify — where a successor claims the path in the real race
 * (ISSUE-365).
 */
export function breakStaleMigrationLock(path: string, onTombstoned?: () => void): void {
  const tombstone = `${path}.stale-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  try { renameSync(path, tombstone); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  onTombstoned?.();
  const moved = readMigrationLockOwner(tombstone);
  if (migrationLockIsStale(tombstone, moved)) {
    rmSync(tombstone, { force: true });
    return;
  }
  // A live lock replaced the stale one while this process judged it. Restore
  // without clobbering: link refuses an existing path, so a successor that
  // claimed the path in the meantime keeps its lock (ISSUE-365). The
  // tombstone goes either way — a second name for the restored content, or
  // the displaced record. On a filesystem without hard links the link
  // refuses and the tombstone is dropped, the same fallback the old
  // rename-failure path took.
  try { linkSync(tombstone, path); }
  catch { /* the path reappeared, or links are unavailable */ }
  rmSync(tombstone, { force: true });
}

function processExists(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return hasCode(error, "EPERM"); }
}
