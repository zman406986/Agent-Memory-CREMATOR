/**
 * The dsh adapter's storage seam (ADR-0013, ISSUE-004 chunk 2).
 *
 * The durable trash ledger lives in its own per-session SQLite file at
 * `<crematorStorageRoot>/sessions/<sessionId>/ledger.sqlite`, with the blob
 * store in a sibling `blobs/` directory. It never shares a file with dsh's
 * own storage: RACOONS stamps its own `application_id` and `user_version`
 * (`packages/core/src/ledger/schema.ts`), so a shared file is unreadable by
 * both sides. `:memory:` stays allowed for tests only.
 *
 * The product path configures the storage ROOT only: every `databasePath` and
 * `blobRoot` is derived per session under it, so an explicit durable path pair
 * is refused (`explicit-storage-paths`) rather than silently shared across
 * sessions — one shared file would contradict ADR-0013 ruling 1. `':memory:'`
 * stays the test-only pair.
 *
 * A durable open failure is typed and carries the path. `sessionFor` consumes
 * it (ADR-0013 ruling 4, ISSUE-004 chunk 4): a transient failure is retried at
 * the next step boundary and only the final failure installs
 * `refusing-ledger.ts` and journals `storage-unavailable` once; this module
 * still propagates.
 *
 * `DOMAIN_VERSION` stays 2 (ADR-0013 ruling 5): no host-domain data is touched
 * because `hostDomain` is empty for this adapter, so RACOONS neither reads nor
 * bumps the host's version.
 */
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { FileBlobStore, MemoryBlobStore, SqliteLedger } from '@cremator/core';
import type { Clock, Ledger } from '@cremator/core';

/** The raw storage options a caller may pass to the plugin. */
export interface RacoonsStorageOptions {
  /**
   * The storage root; every session's ledger and blobs are derived under it.
   * `':memory:'` (tests only) selects the in-memory pair. A durable path pair
   * is NOT accepted — see `databasePath`/`blobRoot` on `ResolvedRacoonsStorage`.
   */
  readonly root?: string;
  /**
   * Test-only durable override, refused on the product path. Kept in the type so
   * a caller that passes the pair gets a typed refusal, not a silently ignored
   * field. `resolveStorage` throws `explicit-storage-paths` for any durable
   * value here.
   */
  readonly databasePath?: string;
  /** Test-only override; refused with `explicit-storage-paths` like `databasePath`. */
  readonly blobRoot?: string;
}

/**
 * A resolved storage target. `':memory:'` on both fields is the in-memory
 * pair; otherwise both are absolute paths. `root` is present only for the
 * per-session plan `resolveStorage` returns when a durable root is configured
 * — `sessionFor` refines it through `resolveSessionStorage` before opening.
 */
export interface ResolvedRacoonsStorage {
  readonly databasePath: string;
  readonly blobRoot: string;
  readonly root?: string;
}

export type RacoonsStorageErrorCode =
  | 'relative-root'
  | 'explicit-storage-paths'
  | 'invalid-session-id'
  | 'unresolved-session'
  | 'durable-open-failed'
  | 'open-retrying';

/** A storage refusal or failure. `path` names the value at fault, when one exists. */
export class RacoonsStorageError extends Error {
  readonly code: RacoonsStorageErrorCode;
  readonly path: string | null;

  constructor(code: RacoonsStorageErrorCode, message: string, path: string | null = null,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'RacoonsStorageError';
    this.code = code;
    this.path = path;
  }
}

/** How many times one session's durable open is attempted: the open, then one retry. */
export const STORAGE_OPEN_ATTEMPTS = 2;

/**
 * A durable open that failed once and will be retried at the next step boundary
 * (ISSUE-004 critic fix P2#4). It is not a refusal: the mount aborts this
 * pre-step without feeding the engine a ledger that cannot answer, journals a
 * warn, and tries again on the next session entry / step boundary. Only when the
 * retry also fails does the mount install the refusing ledger.
 */
export class RacoonsStorageRetryError extends RacoonsStorageError {
  readonly sessionId: string;
  readonly attempt: number;

  constructor(sessionId: string, attempt: number, failure: {
    readonly code: string; readonly path: string | null; readonly message: string;
  }) {
    super('open-retrying', `racoons: the durable ledger for session ${sessionId} did not open`
      + ` (attempt ${String(attempt)} of ${String(STORAGE_OPEN_ATTEMPTS)});`
      + ` retrying at the next step boundary: ${failure.message}`, failure.path);
    this.name = 'RacoonsStorageRetryError';
    this.sessionId = sessionId;
    this.attempt = attempt;
  }
}

/** The literal a durable path uses per session; never a usable directory name. */
export const SESSION_PLACEHOLDER = '<sessionId>';

const MEMORY_STORAGE: ResolvedRacoonsStorage = Object.freeze({
  databasePath: ':memory:', blobRoot: ':memory:',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The default durable root: `<DSH_HOME>/storages/cremator`. `DSH_HOME`
 * defaults to `~/.dsh`. The `storages` level is the dsh storage
 * root the rig also redirects (`dev/dsh-rig/run.mjs`); `cremator` is a
 * subdirectory, so no dsh file is ever shared.
 */
export function defaultStorageRoot(env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()): string {
  const configured = env['DSH_HOME'];
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim() : join(home, '.dsh');
  // A relative DSH_HOME is read relative to the home directory, never the cwd:
  // the mount must not depend on where the host process was started.
  const dshHome = isAbsolute(raw) ? raw : join(home, raw);
  return join(dshHome, 'storages', 'cremator');
}

/**
 * Resolve raw storage options. The product path takes a storage ROOT and only a
 * root: every per-session path is derived under it, so a durable
 * `{databasePath, blobRoot}` pair is refused instead of becoming one ledger
 * shared by every session. `':memory:'` stays the test-only pair. Absent
 * options and no root resolve to the in-memory pair (tests).
 */
export function resolveStorage(raw: RacoonsStorageOptions | undefined,
  root?: string): ResolvedRacoonsStorage {
  const storage: RacoonsStorageOptions = isRecord(raw) ? raw : {};
  const databasePath = typeof storage.databasePath === 'string' ? storage.databasePath : undefined;
  const blobRoot = typeof storage.blobRoot === 'string' ? storage.blobRoot : undefined;
  if (databasePath === ':memory:') {
    if (blobRoot !== undefined && blobRoot !== ':memory:') {
      throw new RacoonsStorageError('explicit-storage-paths',
        "cremator: ':memory:' keeps blobs in memory; an explicit blobRoot would split the pair",
        blobRoot);
    }
    return MEMORY_STORAGE;
  }
  if (databasePath !== undefined) {
    throw new RacoonsStorageError('explicit-storage-paths',
      'cremator: an explicit databasePath would be one ledger shared by every session; '
      + 'pass a storage root and each session derives its own ledger there '
      + "(use ':memory:' for tests)", databasePath);
  }
  if (blobRoot !== undefined) {
    throw new RacoonsStorageError('explicit-storage-paths',
      'cremator: an explicit blobRoot would be one blob store shared by every session; '
      + 'pass a storage root and each session derives its own blobs there', blobRoot);
  }
  const configuredRoot = typeof storage.root === 'string' ? storage.root : root;
  if (configuredRoot === undefined) return MEMORY_STORAGE;
  if (!isAbsolute(configuredRoot)) {
    throw new RacoonsStorageError('relative-root',
      `racoons: crematorStorageRoot must be an absolute path: ${configuredRoot}`, configuredRoot);
  }
  const sessionDir = join(configuredRoot, 'sessions', SESSION_PLACEHOLDER);
  return Object.freeze({
    databasePath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs'),
    root: configuredRoot,
  });
}

/**
 * The one directory a durable root names (ISSUE-498; ADR-0066 decision 1).
 *
 * A session's ledger is `<root>/sessions/<id>/ledger.sqlite`, built with `join`,
 * which collapses a trailing separator, `.` and `..`. The duplicate-apply key
 * must describe the same directory the OS will open, or two applies over one
 * ledger claim two keys — the dsh analogue of ISSUE-464/ISSUE-481, whose
 * `normalizeMountRoot` in the opencode adapter this mirrors so both adapters
 * agree on what one root is. `resolve` handles the lexical forms; the longest
 * existing ancestor is resolved through `realpathSync.native` (a junction, a
 * symlink, an extended-length spelling and a case-insensitive volume's own
 * case); Windows' trailing dot and space trimming is applied per component;
 * and the volume is asked whether it folds case before the whole key is folded,
 * so the key cannot change the moment the first mount creates the root. A tail
 * the filesystem does not hold yet is appended as typed.
 */
export function normalizeMountRoot(root: string): string {
  const lexical = resolve(withoutExtendedPrefix(root));
  const trimmed = process.platform === 'win32' ? trimWindowsTrailing(lexical) : lexical;
  return canonicalRootDirectory(trimmed);
}

/**
 * Strip the Windows extended-length prefix (ISSUE-481): `\\?\C:\store` and
 * `\\?\UNC\server\share` name the same directory as their plain spellings.
 */
function withoutExtendedPrefix(root: string): string {
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
function trimWindowsTrailing(resolvedPath: string): string {
  const parsed = parse(resolvedPath);
  const rest = resolvedPath.slice(parsed.root.length);
  if (rest.length === 0) return resolvedPath;
  const parts = rest.split(/[\\/]+/u).map(part => part.replace(/[. ]+$/u, ''))
    .filter(part => part.length > 0);
  return parts.length === 0 ? parsed.root : join(parsed.root, ...parts);
}

/**
 * Resolve the real directory behind a lexical path (ISSUE-481), asking the
 * filesystem for the longest existing ancestor: a junction or symlink and its
 * target then yield one key, and the case is the directory's own, not the
 * platform's guess. A not-yet-existing tail is appended as typed. The volume
 * itself is asked whether it folds case, and the whole key is folded when it
 * does.
 */
function canonicalRootDirectory(lexical: string): string {
  const missing: string[] = [];
  let current = lexical;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      const canonical = missing.length === 0 ? real : join(real, ...missing);
      return rootFoldsCase(real) ? canonical.toLowerCase() : canonical;
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
 * volume resolved through a flipped spelling compared unequal to the real path.
 */
function rootFoldsCase(real: string): boolean {
  let current = real;
  for (;;) {
    const parent = dirname(current);
    const name = basename(current);
    const flipped = name.replace(/[a-z]/giu, letter => (letter === letter.toUpperCase()
      ? letter.toLowerCase() : letter.toUpperCase()));
    if (parent !== current && flipped !== name) {
      try { return sameEntryIdentity(current, join(parent, flipped)); }
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
function sameEntryIdentity(left: string, right: string): boolean {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}

/**
 * A collision-free directory name for a session id (ISSUE-345). Windows folds
 * case and trims trailing dots, so `Session`/`session` and `foo.`/`foo` would
 * share one directory if used verbatim. Ids already safe on every platform
 * (lowercase ASCII letters/digits plus `.`, `_`, `-`, no trailing dot, not a
 * reserved device name) stay verbatim; anything else becomes `~` plus the hex
 * of its UTF-8 bytes — an injective encoding, and `~` never occurs in a
 * verbatim name, so the two forms cannot collide either.
 */
function sessionDirName(sessionId: string): string {
  const safeVerbatim = /^[a-z0-9][a-z0-9._-]*$/u.test(sessionId)
    && !sessionId.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u.test(sessionId);
  return safeVerbatim ? sessionId : `~${Buffer.from(sessionId, 'utf8').toString('hex')}`;
}

/**
 * The per-session target under a durable root. A session id is a directory
 * name here, so anything that could escape the root is refused, not rewritten;
 * ids that survive that check are mapped to collision-free directory names by
 * `sessionDirName` (ISSUE-345).
 */
export function resolveSessionStorage(root: string, sessionId: string): ResolvedRacoonsStorage {
  if (sessionId === '' || sessionId === '.' || sessionId === '..'
    || /[\\/:]/u.test(sessionId) || sessionId.includes('\0')) {
    throw new RacoonsStorageError('invalid-session-id',
      `racoons: session id is not a safe directory name: ${JSON.stringify(sessionId)}`, sessionId);
  }
  const sessionDir = join(root, 'sessions', sessionDirName(sessionId));
  return Object.freeze({
    databasePath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs'),
  });
}

/**
 * Open the ledger for one resolved target. Durable opens create the session
 * directory and the blob root first; a failure is a `RacoonsStorageError`
 * carrying the database path (ADR-0013: the caller, chunk 4, decides refusal).
 */
export async function openLedger(storage: ResolvedRacoonsStorage, clock: Clock): Promise<Ledger> {
  if (storage.databasePath === ':memory:') {
    return SqliteLedger.open({
      databasePath: storage.databasePath, blobStore: new MemoryBlobStore(), clock,
    });
  }
  if (storage.root !== undefined) {
    throw new RacoonsStorageError('unresolved-session',
      `racoons: storage plan for ${storage.root} must be refined per session before opening`,
      storage.root);
  }
  try {
    mkdirSync(dirname(storage.databasePath), { recursive: true });
    mkdirSync(storage.blobRoot, { recursive: true });
    return await SqliteLedger.open({
      databasePath: storage.databasePath, blobStore: new FileBlobStore(storage.blobRoot), clock,
    });
  } catch (error) {
    if (error instanceof RacoonsStorageError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RacoonsStorageError('durable-open-failed',
      `racoons: cannot open the durable ledger at ${storage.databasePath}: ${reason}`,
      storage.databasePath, { cause: error });
  }
}
