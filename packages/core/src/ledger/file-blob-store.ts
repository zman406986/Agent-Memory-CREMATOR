import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Bytes, Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { syncDirectoryChain } from "./fs-durability.js";
import { assertHash, hasCode, storageError, verifyBytes } from "./integrity.js";
import { LedgerError } from "./types.js";

/** Named points a test may stop at. Each name means "and then fail here". */
export type BlobPutStep = "locked" | "cleanup";

export interface FileBlobStoreOptions {
  /** Test seam: throwing here simulates a failure at that boundary. */
  readonly onStep?: (step: BlobPutStep) => void;
}

export class FileBlobStore implements BlobStore {
  readonly #root: string;
  readonly #onStep: ((step: BlobPutStep) => void) | undefined;

  constructor(rootPath: string, options: FileBlobStoreOptions = {}) {
    this.#root = resolve(rootPath);
    this.#onStep = options.onStep;
  }

  async put(bytes: Bytes): Promise<Sha256> {
    const copy = new Uint8Array(bytes);
    const hash = await sha256(copy);
    const target = this.#path(hash);
    const temporaryRoot = join(this.#root, "temporary");
    let staging: string | undefined;
    let unpublished: string | undefined;
    let lock: string | undefined;
    let lockToken: string | undefined;
    const lockPath = join(temporaryRoot, `${hash}.lock`);
    let failure: LedgerError | undefined;
    try {
      mkdirSync(dirname(target), { recursive: true });
      mkdirSync(temporaryRoot, { recursive: true });
      sweepCrashedStaging(temporaryRoot);
      if (existsSync(target)) {
        await this.#acceptExisting(hash, copy.byteLength);
        return hash;
      }
      staging = mkdtempSync(join(temporaryRoot, "publish-"));
      unpublished = join(staging, "body");
      const fd = openSync(unpublished, "wx");
      try {
        writeFileSync(fd, copy);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Serialize cooperating publishers across processes. The claim is a
      // fully-formed directory (owner record inside) renamed into place, so
      // the lock path never exists without its owner: a crash cannot leave
      // an ownerless lock that fresh mtime would judge live (ISSUE-321).
      // A lock whose owner is gone, or that outlived the bounded age, is
      // stolen; a live owner still makes this publisher refuse.
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        const claim = mkdtempSync(join(temporaryRoot, "claim-"));
        try {
          const token = recordLockOwner(claim);
          renameSync(claim, lockPath);
          lock = lockPath;
          lockToken = token;
          break;
        } catch (error) {
          try { rmSync(claim, { recursive: true, force: true }); }
          catch { /* the sweep recovers what this could not remove */ }
          // Windows refuses the claim with EPERM while a lock is there. A lock
          // path gone by this look means its holder released inside the
          // window, so the refusal was contention that has passed, never a
          // disk fault: retry the claim (LOCK_ATTEMPTS bounds the wait).
          const held = lockPathHeld(error, lockPath);
          if (!held && !hasCode(error, "EPERM")) throw error;
          if (existsSync(target)) {
            await this.#acceptExisting(hash, copy.byteLength);
            return hash;
          }
          if (held) breakStaleLock(lockPath);
          await new Promise<void>(done => setTimeout(done, LOCK_RETRY_MS));
        }
      }
      if (lock === undefined || lockToken === undefined) {
        const owner = readLockOwner(lockPath);
        throw new LedgerError("storage",
          `Blob publication locked: ${hash} (lock ${lockPath}${owner === null ? "" : `, pid ${String(owner.pid)}`})`);
      }
      this.#onStep?.("locked");
      if (existsSync(target)) {
        await this.#acceptExisting(hash, copy.byteLength);
        return hash;
      }
      renameSync(unpublished, target);
      unpublished = undefined;
      syncDirectoryChain(dirname(target));
      return hash;
    } catch (error) {
      failure = storageError(error, `Cannot publish blob ${hash}`);
      throw failure;
    } finally {
      // Each artifact is cleaned in its own try: a releaseLock failure must
      // not skip staging removal, and a cleanup failure must not mask the
      // original publish error (ISSUE-318). It surfaces only when the put
      // itself succeeded.
      const cleanupFailure = this.#cleanup(lock, lockToken, unpublished, staging);
      if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure;
    }
  }

  /** Clean every artifact independently; return the first cleanup failure. */
  #cleanup(
    lock: string | undefined, lockToken: string | undefined,
    unpublished: string | undefined, staging: string | undefined,
  ): LedgerError | undefined {
    let first: LedgerError | undefined;
    const attempt = (clean: () => void): void => {
      try { clean(); }
      catch (error) { first ??= storageError(error, "Cannot clean unpublished blob files"); }
    };
    attempt(() => {
      this.#onStep?.("cleanup");
      if (lock !== undefined && lockToken !== undefined) releaseLock(lock, lockToken);
    });
    attempt(() => { if (unpublished !== undefined && existsSync(unpublished)) unlinkSync(unpublished); });
    attempt(() => { if (staging !== undefined) rmdirSync(staging); });
    return first;
  }

  async get(hash: Sha256): Promise<Bytes> {
    assertHash(hash);
    try {
      const bytes = new Uint8Array(readFileSync(this.#path(hash)));
      await verifyBytes(bytes, hash);
      return bytes;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new LedgerError("not-found", `Missing blob ${hash}`, { cause: error });
      }
      throw storageError(error, `Cannot read blob ${hash}`);
    }
  }

  #path(hash: Sha256): string {
    assertHash(hash);
    return join(this.#root, "sha256", hash.slice(0, 2), hash.slice(2));
  }

  async #acceptExisting(hash: Sha256, length: number): Promise<void> {
    await verifyBytes(await this.get(hash), hash, length);
    // Another publisher fsynced the body before renaming it, but may not yet
    // have flushed its shard. Do that here before accepting its publication.
    syncDirectoryChain(dirname(this.#path(hash)));
  }
}

/** Wait steps for a live foreign publisher: about two seconds in total. */
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 10;
/**
 * A lock older than this is stale even when its pid still exists: pids are
 * reused, so the age bound keeps a recycled pid from wedging a hash.
 */
const LOCK_STALE_MS = 60_000;
/** The owner record inside a lock directory, published with the lock by the claim rename. */
const LOCK_OWNER_FILE = "owner.json";

/**
 * Remove staging and claim directories a crashed publisher left behind
 * (ISSUE-318, ISSUE-321). The age bound is the lock's own staleness bound: a
 * publisher older than that has already lost its lock to recovery, so its
 * staging cannot belong to a live put. Best effort — a sweep failure must
 * never fail the put.
 */
function sweepCrashedStaging(temporaryRoot: string): void {
  let entries: Dirent[];
  try { entries = readdirSync(temporaryRoot, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() ||
        !(entry.name.startsWith("publish-") || entry.name.startsWith("claim-"))) continue;
    const path = join(temporaryRoot, entry.name);
    try {
      if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch { /* a later put sweeps what this one could not remove */ }
  }
}

interface LockOwner {
  readonly pid: number;
  readonly atMs: number;
  readonly token: string;
}

/**
 * Records this process as the lock owner inside the claim directory, before
 * the claim is renamed into place. The rename publishes lock and owner
 * together, so no crash window leaves an ownerless lock (ISSUE-321).
 */
function recordLockOwner(lockPath: string): string {
  const token = `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(lockPath, LOCK_OWNER_FILE),
    JSON.stringify({ pid: process.pid, atMs: Date.now(), token } satisfies LockOwner));
  return token;
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8"));
    if (typeof raw !== "object" || raw === null ||
        !("pid" in raw) || typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) ||
        !("atMs" in raw) || typeof raw.atMs !== "number" || !Number.isFinite(raw.atMs) ||
        !("token" in raw) || typeof raw.token !== "string") return null;
    return { pid: raw.pid, atMs: raw.atMs, token: raw.token };
  } catch { return null; }
}

/** Rename refusals that mean "the lock path is taken", per platform. */
function lockPathHeld(error: unknown, lockPath: string): boolean {
  if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) return true;
  // Windows refuses to replace any directory with EPERM; only treat that as
  // contention when the lock path actually exists.
  return hasCode(error, "EPERM") && existsSync(lockPath);
}

/**
 * Stop a dead publisher from wedging a hash forever. The claim rename
 * publishes the owner record atomically with the lock, so an ownerless lock
 * is a crashed legacy claim or corruption — never a live publisher — and is
 * recovered at once (ISSUE-321). A readable owner is respected while its pid
 * lives and its age is within the bound; the bound keeps a recycled pid from
 * wedging a hash.
 */
function breakStaleLock(lockPath: string): void {
  const owner = readLockOwner(lockPath);
  if (owner !== null && isProcessAlive(owner.pid) && Date.now() - owner.atMs <= LOCK_STALE_MS) return;
  // Rename first, then verify: a waiter that lost the atomic rename retries.
  const tombstone = `${lockPath}.stale-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  try { renameSync(lockPath, tombstone); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = readLockOwner(tombstone);
  const movedLive = moved !== null && isProcessAlive(moved.pid) && Date.now() - moved.atMs <= LOCK_STALE_MS;
  if (!movedLive) {
    rmSync(tombstone, { recursive: true, force: true });
    return;
  }
  // Another publisher replaced the stale lock while this one judged it: put
  // the live lock back and let the ordinary wait decide. A successor's claim
  // directory is never empty, so this rename cannot clobber it (it refuses
  // ENOTEMPTY/EPERM and the tombstone is dropped).
  try { renameSync(tombstone, lockPath); }
  catch { rmSync(tombstone, { recursive: true, force: true }); }
}

/**
 * Remove only the lock this process created, never a successor's. Deletion
 * needs a positive token match: an unreadable owner record cannot confirm
 * ownership (a successor's partial write looks the same), so the lock stays
 * for stale-lock recovery (ISSUE-320).
 */
function releaseLock(lockPath: string, token: string): void {
  const owner = readLockOwner(lockPath);
  if (owner === null || owner.token !== token) return;
  rmSync(lockPath, { recursive: true, force: true });
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return hasCode(error, "EPERM"); }
}
