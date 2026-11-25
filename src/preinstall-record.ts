/**
 * The durable install proof (ISSUE-477, ISSUE-478).
 *
 * `mount-state.json` carries the install identity, but its own write can fail
 * (a read-only file, or a directory at the path), and the install identity is
 * the thing that was withheld. The inherited set is still a fact this mount
 * computed before its first pass: which surface results predate this session's
 * durable state, and which the fork's first mount already inherited. Keeping
 * that proof in its own sibling file makes it independent of the install
 * identity, so
 *
 *   - a mount whose install write never landed still reads back the inherited
 *     set it computed, so the retried identity records the same fork/clone
 *     facts (ISSUE-477);
 *   - a fork records the pending clear beside the set it inherited, so a death
 *     before the retry re-clears the parent's facts without recomputing the
 *     inherited set from a surface the child has since grown (ISSUE-478).
 *
 * The set is identity evidence, never an eligibility gate: nothing reads it to
 * skip a result. It exists so a re-fork can name what the child inherited, not
 * so a prune pass can exclude it.
 *
 * `pendingClear` is the durable marker that a fork still owes the parent's
 * clear. It lives here, not in the withheld install identity, because that
 * identity is exactly what must not be written while the clear is owed.
 *
 * Published atomically through the same temp+rename as every other per-session
 * fact; a failed write journals `preinstall-persist-error` and returns false —
 * the in-memory state still serves this process, only its restart durability is
 * lost. Reads are fail-open: an absent, corrupt or foreign record reads null,
 * never a licence to trust garbage.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResolvedRacoonsStorage } from './storage.js';
import type { MountJournal } from './journal-kinds.js';

/** The record's file name, beside `ledger.sqlite` and `mount-state.json`. */
export const PREINSTALL_RECORD_FILE = 'preinstall.json';

/** A per-process token so two writes never stage the same temp name. */
let tempSeq = 0;

/** One mount's inherited-set proof. */
export interface DurablePreinstallRecord {
  /** The session this proof belongs to; a copy's parent record never answers for a child. */
  readonly sessionId: string;
  /** The tool-result node ids this session never observed land (identity, not a skip). */
  readonly ids: readonly string[];
  /** Whether a fork still owes the parent's fact clear before its identity lands. */
  readonly pendingClear: boolean;
}

function sessionDirOf(target: ResolvedRacoonsStorage): string | null {
  return target.databasePath === ':memory:' ? null : dirname(target.databasePath);
}

function readDoc(dir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, PREINSTALL_RECORD_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function publishDoc(dir: string, doc: Record<string, unknown>, journal: MountJournal,
  sessionId: string, fields: Record<string, unknown>): boolean {
  const final = join(dir, PREINSTALL_RECORD_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(doc)}\n`, 'utf8');
    fs.renameSync(temp, final);
    return true;
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never have been created */ }
    journal('preinstall-persist-error', { sessionId, ...fields,
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** The proof this session's durable state carries, or null. */
export function readPreinstallRecord(target: ResolvedRacoonsStorage):
DurablePreinstallRecord | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const doc = readDoc(dir);
  const sessionId = doc['sessionId'];
  const ids = doc['ids'];
  if (typeof sessionId !== 'string' || !Array.isArray(ids)) return null;
  const strings = ids.filter((id): id is string => typeof id === 'string');
  if (strings.length !== ids.length) return null;
  return { sessionId, ids: strings, pendingClear: doc['pendingClear'] === true };
}

/** Publish one complete proof. */
export function writePreinstallRecord(target: ResolvedRacoonsStorage,
  record: DurablePreinstallRecord, journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  return publishDoc(dir, { sessionId: record.sessionId, ids: [...record.ids],
    pendingClear: record.pendingClear }, journal, sessionId,
  { fact: 'preinstall', preInstall: record.ids.length, pendingClear: record.pendingClear });
}

/**
 * Flip a pending fork clear to reconciled once the child's identity has landed.
 * An absent record or one that is not pending is already reconciled.
 */
export function markPreinstallReconciled(target: ResolvedRacoonsStorage,
  journal: MountJournal, sessionId: string): boolean {
  const current = readPreinstallRecord(target);
  if (current === null || !current.pendingClear) return true;
  return writePreinstallRecord(target, { ...current, pendingClear: false }, journal, sessionId);
}
