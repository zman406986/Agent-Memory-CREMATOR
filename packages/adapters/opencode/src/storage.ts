/**
 * The OpenCode adapter's storage seam (ADR-0013, ISSUE-044 C3).
 *
 * Each session owns one durable ledger at
 * `<crematorStorageRoot>/sessions/<sessionId>/ledger.sqlite`, with the blob tree in a
 * sibling `blobs/` directory under the same session directory. RACOONS never opens a
 * file the host owns: the default root is `~/.cremator/opencode`, and the host's
 * own data directory is neither guessed nor written.
 *
 * The core's `SqliteLedger`, `FileBlobStore` and `MemoryBlobStore` are harness-agnostic
 * already, so only the path layout lives here: this package may touch the filesystem
 * while `packages/core/src` may not (the purity gate allows `node:fs`/`node:path`
 * under core only in its ledger directory).
 *
 * The product path takes a root and only a root; a durable `{databasePath, blobRoot}`
 * pair is refused (`explicit-storage-paths`) because one such pair would be one ledger
 * shared by every session, contradicting ADR-0013. `':memory:'` is accepted only as
 * that explicit pair and only for tests: an absent root resolves to the durable default,
 * never to memory — a shipped mount that silently degrades to memory is the defect
 * ADR-0013 ruling 4 exists to prevent.
 *
 * A durable open that fails is a typed `durable-open-failed` carrying the database
 * path, so the mount can report which file could not be opened (C6).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { FileBlobStore, MemoryBlobStore, SqliteLedger } from '@cremator/core';
import type { Clock, Ledger } from '@cremator/core';

/** Raw storage options, as a caller may hand them to the mount. */
export interface OpencodeStorageOptions {
  /**
   * The storage root; each session derives its ledger and blobs under it. Must be
   * absolute. Absent means `defaultStorageRoot()`.
   */
  readonly crematorStorageRoot?: string;
  /**
   * Test-only. The only accepted value is `':memory:'`; any durable value is refused
   * (`explicit-storage-paths`) because it would be one ledger shared by every session.
   */
  readonly databasePath?: string;
  /** Test-only. Accepted only as `':memory:'` beside a `':memory:'` database. */
  readonly blobRoot?: string;
}

/** What the root options resolved to: in-memory (tests) or one durable root. */
export type StorageSelection =
  | { readonly kind: 'memory' }
  | { readonly kind: 'durable'; readonly root: string };

/** A resolved place to open one ledger: the memory pair or one session's durable paths. */
export type StorageTarget =
  | { readonly kind: 'memory'; readonly databasePath: string; readonly blobRoot: string }
  | {
      readonly kind: 'durable';
      readonly root: string;
      readonly sessionId: string;
      readonly databasePath: string;
      readonly blobRoot: string;
    };

export type OpencodeStorageErrorCode =
  | 'relative-root'
  | 'explicit-storage-paths'
  | 'invalid-session-id'
  | 'durable-open-failed';

/** A storage refusal or open failure. `path` names the offending value, when one exists. */
export class OpencodeStorageError extends Error {
  readonly code: OpencodeStorageErrorCode;
  readonly path: string | null;

  constructor(code: OpencodeStorageErrorCode, message: string, path: string | null = null,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpencodeStorageError';
    this.code = code;
    this.path = path;
  }
}

/**
 * The default durable root: `<home>/.cremator/opencode`. No host environment variable
 * is consulted: OpenCode's own data directory is not a place RACOONS may write.
 */
export function defaultStorageRoot(home: string = homedir()): string {
  return join(home, '.cremator', 'opencode');
}

/**
 * Resolve the root options. An absent root is the durable default, never memory.
 * A relative root, `':memory:'` used as a root, and any durable `{databasePath,
 * blobRoot}` value are typed refusals.
 */
export function resolveStorage(options: OpencodeStorageOptions | undefined = undefined,
  home: string = homedir()): StorageSelection {
  const databasePath = options?.databasePath;
  const blobRoot = options?.blobRoot;

  if (databasePath !== undefined) {
    if (databasePath !== ':memory:') {
      throw new OpencodeStorageError('explicit-storage-paths',
        'cremator: databasePath is not a product option; pass crematorStorageRoot and each '
        + "session derives its own ledger under it (use ':memory:' for tests)", databasePath);
    }
    if (blobRoot !== undefined && blobRoot !== ':memory:') {
      throw new OpencodeStorageError('explicit-storage-paths',
        "cremator: ':memory:' keeps blobs in memory; a durable blobRoot would split the pair",
        blobRoot);
    }
    return { kind: 'memory' };
  }
  if (blobRoot !== undefined) {
    throw new OpencodeStorageError('explicit-storage-paths',
      'cremator: blobRoot is not a product option; pass crematorStorageRoot and each session '
      + 'derives its own blobs under it', blobRoot);
  }

  const root = options?.crematorStorageRoot ?? defaultStorageRoot(home);
  if (root === ':memory:') {
    throw new OpencodeStorageError('explicit-storage-paths',
      "cremator: ':memory:' is a test-only ledger pair, not a storage root", root);
  }
  if (!isAbsolute(root)) {
    throw new OpencodeStorageError('relative-root',
      `racoons: crematorStorageRoot must be an absolute path: ${root}`, root);
  }
  return { kind: 'durable', root };
}

/** Why a session id cannot be a directory name, or null when it can. */
function sessionIdProblem(sessionId: string): string | null {
  if (sessionId.length === 0) return 'is empty';
  if (sessionId === '.' || sessionId === '..') return 'is a traversal name';
  if (sessionId.includes('\0')) return 'contains a NUL byte';
  if (/[\\/:]/u.test(sessionId)) return 'contains a path separator or a drive colon';
  return null;
}

/**
 * Windows device names that cannot be a directory even with an extension (`con`,
 * `con.txt`, ...). Checked only after the lowercase-verbatim gate below, so an
 * uppercase `CON` is already rejected by the character-class test.
 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u;

/**
 * Whether an id can be a directory name verbatim on every platform: a leading
 * lowercase ASCII alphanumeric, then only `[a-z0-9._-]`, no trailing dot (Windows
 * trims it), and not a reserved device name. Uppercase, spaces, a trailing dot and
 * device names all fail here, so they must be escaped rather than used raw.
 */
function verbatimSafe(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(id)
    && !id.endsWith('.')
    && !WINDOWS_DEVICE_NAME.test(id);
}

/**
 * A collision-free directory segment for a session id (ISSUE-378; adapted from the
 * dsh lane's ISSUE-345 encoder). Windows folds case and strips trailing dots and
 * spaces, so `Session`/`session`, `foo.`/`foo` and device names like `con` would
 * share one directory — or fail to create one — if used raw, mixing ledgers and
 * blobs across sessions (ADR-0013 ruling 1). An id safe on every platform stays
 * verbatim; anything else becomes `~` plus the hex of its UTF-8 bytes. Hex is
 * injective and `~` never appears in a verbatim name, so the two forms cannot
 * collide and no two distinct ids map to one directory.
 */
function sessionDirSegment(id: string): string {
  return verbatimSafe(id) ? id : `~${Buffer.from(id, 'utf8').toString('hex')}`;
}

/**
 * Refine a selection to one session's target. An id that could escape the root is
 * refused rather than rewritten; an id that survives the guard is mapped to a
 * collision-free directory segment by `sessionDirSegment` (ISSUE-378), so distinct
 * ids never share one ledger/blob directory on Windows.
 */
export function sessionStorage(selection: StorageSelection, sessionId: string): StorageTarget {
  if (selection.kind === 'memory') {
    return Object.freeze({ kind: 'memory' as const, databasePath: ':memory:',
      blobRoot: ':memory:' });
  }
  const problem = sessionIdProblem(sessionId);
  if (problem !== null) {
    throw new OpencodeStorageError('invalid-session-id',
      `racoons: session id ${JSON.stringify(sessionId)} ${problem}`, sessionId);
  }
  const sessionDir = join(selection.root, 'sessions', sessionDirSegment(sessionId));
  return Object.freeze({
    kind: 'durable' as const,
    root: selection.root,
    sessionId,
    databasePath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs'),
  });
}

/**
 * Open the ledger for one target. A durable open creates the session directory and the
 * blob root first. Any failure surfaces as `durable-open-failed` with the database path;
 * whether that refusal is retried is the mount's decision (ADR-0013 ruling 4).
 */
export async function openLedger(target: StorageTarget, clock: Clock): Promise<Ledger> {
  if (target.kind === 'memory') {
    return SqliteLedger.open({
      databasePath: target.databasePath, blobStore: new MemoryBlobStore(), clock,
    });
  }
  try {
    mkdirSync(dirname(target.databasePath), { recursive: true });
    mkdirSync(target.blobRoot, { recursive: true });
    return await SqliteLedger.open({
      databasePath: target.databasePath, blobStore: new FileBlobStore(target.blobRoot), clock,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpencodeStorageError('durable-open-failed',
      `racoons: cannot open the session ledger at ${target.databasePath}: ${reason}`,
      target.databasePath, { cause: error });
  }
}
