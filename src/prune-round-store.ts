/**
 * The persisted prune round (ISSUE-022 chunk 6; ADR-0009).
 *
 * The mount's round ordinal is the stamp on every assigned index, so two passes
 * must never share one — including across a restart. The engine keeps no pass
 * state (its `settlePrune` consumes `round` and stores nothing), so the mount
 * writes the counter to its own per-session storage: `prune-round.json` beside
 * the session's `ledger.sqlite`, under the same ADR-0013 root and the same
 * `<sessionId>` directory the ledger already uses.
 *
 * It is NOT a ledger record: a round is not a receipt, and the ledger's kinds
 * are a closed, append-only record of applied-ness (ADR-0015). One small file
 * keeps the two facts apart. The depth latch's post-pass state rides the same
 * file (ISSUE-336): a remount reads it back so the first above-bar observation
 * after a restart is the pass's baseline, not a wasted re-ask. The durable
 * pending-append intent rides it too (ISSUE-374): the records a committed
 * append owes the host, so a death before the flush replays them on remount.
 * The two first-ask flags ride it as well (ISSUE-406, ISSUE-508): the entry
 * ask's, and the depth table's, so a restart states the later 40 percent share
 * line instead of repeating the 70 percent one.
 *
 * Concurrency ruling (2026-10-24, ISSUE-035 item 9): two mounts of the SAME
 * session in one process may both read round n and both write n+1. Accepted and
 * documented, not locked: each write stages a temp and renames it onto the round
 * file (ISSUE-347), so the file always holds one complete ordinal and never a
 * torn one — last-write-wins across concurrent mounts, and a kill mid-write
 * tears only the temp, leaving the previous complete round intact (the partial
 * temp is never the round file the reader opens). A replayed
 * ordinal is harmless — the round is a stamp on the pass, not a ledger kind
 * (ADR-0015), and event ids are content-derived (76d224e,
 * `dsh:<session>:prune:<round>:<digest>`), so the engine reads a repeated id as
 * a replay and a different document as a new event. Distinct sessions never
 * meet here: ADR-0013 gives each its own directory.
 *
 * Fail-open, like every other mount seam: an unreadable or corrupt file reads
 * as round 0, and a failed write journals `prune-round-error` and does not stop
 * the pass. A failed or killed write leaves the prior complete round on disk, so
 * the ordinal does not silently restart. Worst case is a repeated round ordinal,
 * never a refused prune.
 *
 * A TRANSIENT read failure is not corruption (ISSUE-499): the file may still
 * hold an intact round, latch and owed queues, so a writer refuses to republish
 * a document merged from an empty read (which would erase them) and names the
 * refusal. Reads name the failure too and keep their fail-open answer. A
 * genuinely corrupt document keeps its documented start-over write.
 *
 * `:memory:` storage (tests) persists nothing: the in-memory entry counter is
 * the whole truth there, exactly as before this module existed.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { PruneWindowTriggerState } from '@cremator/core';
import type { ResolvedRacoonsStorage } from './storage.js';
import type { MountJournal } from './journal-kinds.js';

/** The counter's file name, beside `ledger.sqlite` and `blobs/`. */
export const PRUNE_ROUND_FILE = 'prune-round.json';

/**
 * A per-process token so two writes in one process never stage the same temp
 * name (ISSUE-035's concurrent mounts both write here). It is a uniqueness
 * token, not a bound: it never limits how many rounds may be written.
 */
let tempSeq = 0;

/** The session directory a resolved durable target names, or null when in memory. */
function sessionDirOf(target: ResolvedRacoonsStorage): string | null {
  return target.databasePath === ':memory:' ? null : dirname(target.databasePath);
}

/**
 * The round this session last completed; 0 when nothing was ever written.
 * A durable target with no file, a corrupt file, or a negative/non-integer
 * value all read as 0: the safe failure is "start over", never "trust garbage".
 * A present file or record this build cannot read is named (ISSUE-499) instead
 * of reading as a silent 0.
 */
export function readPruneRound(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): number {
  const dir = sessionDirOf(target);
  if (dir === null) return 0;
  const read = readDoc(dir);
  if (read.reason !== undefined) {
    nameReadRefusal(journal, sessionId, 'round', read.reason);
    return 0;
  }
  return roundOf(read.doc, journal, sessionId);
}

/**
 * The header facts a fork clear needs, and whether the read was refused
 * (ISSUE-572). A refused read is not "the file is absent": the two-fact
 * readers answer their fail-open default, and the fork clear would read that as
 * "the parent owes nothing". `refused` lets it treat the fact as still owed
 * instead, so only a successful write retires it (ADR-0067).
 */
export interface PruneHeaderFacts {
  readonly round: number;
  readonly trigger: PruneWindowTriggerState | null;
  readonly refused: boolean;
}

/** One read of the file for the round and the latch, naming a refusal per fact. */
export function readPruneHeaderFacts(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): PruneHeaderFacts {
  const dir = sessionDirOf(target);
  if (dir === null) return { round: 0, trigger: null, refused: false };
  const read = readDoc(dir);
  if (read.reason !== undefined) {
    nameReadRefusal(journal, sessionId, 'round', read.reason);
    nameReadRefusal(journal, sessionId, 'trigger', read.reason);
    return { round: 0, trigger: null, refused: true };
  }
  return { round: roundOf(read.doc, journal, sessionId),
    trigger: triggerOf(read.doc, journal, sessionId), refused: false };
}

/** The round a document names; a present bad value is refused, never trusted. */
function roundOf(doc: Record<string, unknown>, journal: MountJournal | undefined,
  sessionId: string | undefined): number {
  const round = doc['round'];
  if (round === undefined) return 0;
  if (typeof round === 'number' && Number.isSafeInteger(round) && round >= 0) return round;
  nameReadRefusal(journal, sessionId, 'round',
    'the round record is structurally invalid; reading it as absent');
  return 0;
}

/**
 * A read's result: the current document and why a present one was refused.
 * `transient` is true only for a read that failed while the file may still hold
 * intact facts (ISSUE-499); a corrupt document is `false` because its facts are
 * unreadable anyway and the documented "start over" write still applies.
 */
interface RoundDocRead {
  readonly doc: Record<string, unknown>;
  readonly transient: boolean;
  readonly reason?: string;
}

/**
 * The file's current document, or `{}` when it is absent, unreadable or not a
 * JSON object. Every writer reads it first so the facts it does not own ride
 * along unchanged (ISSUE-336's trigger, ISSUE-374's appends); the safe failure
 * is "start over", never "trust garbage". An absent file is fresh; anything
 * else names its reason so a refusal can say what it could not read (ISSUE-499).
 */
function readDoc(dir: string): RoundDocRead {
  let raw: string;
  try {
    raw = fs.readFileSync(join(dir, PRUNE_ROUND_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: {}, transient: false };
    return { doc: {}, transient: true, reason: 'the prune-round file could not be read: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: {}, transient: false, reason: 'the prune-round file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { doc: {}, transient: false, reason: 'the prune-round file is not a JSON object' };
  }
  return { doc: parsed as Record<string, unknown>, transient: false };
}

/**
 * Name a refused document or record read (ISSUE-499). The read still answers its
 * fail-open default; the line is what makes the loss visible with a cause.
 */
function nameReadRefusal(journal: MountJournal | undefined, sessionId: string | undefined,
  fact: string, reason: string): void {
  journal?.('prune-round-error', { sessionId, fact, refused: true, reason });
}

/**
 * Refuse to republish a merged document over a transient read failure
 * (ISSUE-499). The facts this writer does not own are still on disk for the next
 * attempt; merging them into an empty read and renaming that over the file would
 * erase the round, the latch and the owed queues. A genuinely corrupt document
 * keeps its documented "start over" write.
 */
function refusePublish(dir: string, reason: string, journal: MountJournal, sessionId: string,
  errorKind: 'prune-round-error' | 'append-persist-error',
  fields: Record<string, unknown>): false {
  journal(errorKind, { sessionId, ...fields, refused: true,
    reason: `refusing to overwrite ${join(dir, PRUNE_ROUND_FILE)}: ${reason}` });
  return false;
}

/**
 * Publish one complete document atomically (ISSUE-347): stage a temp beside
 * the round file, then rename it onto the final path. Rename is atomic, so the
 * final path only ever holds a complete file — a kill mid-write tears the temp
 * (never the round file) and leaves the previous complete document intact.
 * Returns false when it could not be written; the caller journals that and
 * keeps its in-memory state, so the pass itself is never lost — only its
 * durability across a restart.
 */
function publishDoc(dir: string, doc: Record<string, unknown>, journal: MountJournal,
  sessionId: string,
  errorKind: 'prune-round-error' | 'append-persist-error',
  fields: Record<string, unknown>): boolean {
  const final = join(dir, PRUNE_ROUND_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(doc)}\n`, 'utf8');
    fs.renameSync(temp, final);
    return true;
  } catch (error) {
    // Best-effort: a kill or a failed rename may leave the partial temp behind.
    // It is never the round file, so an orphan is harmless; remove it when we can.
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never have been created */ }
    journal(errorKind, { sessionId, ...fields,
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Write the last completed round and, when the caller supplies it, the depth
 * latch's state (ISSUE-336): the two facts ride one file, so a remount reads
 * the post-pass baseline back beside the ordinal. The pending-append intent
 * (ISSUE-374) rides the same file and is preserved here: a round write must
 * never drop the records a committed append still owes the host. Published
 * atomically (ISSUE-347); a failed write journals `prune-round-error` and the
 * caller keeps the in-memory counter.
 */
export function writePruneRound(target: ResolvedRacoonsStorage, round: number,
  journal: MountJournal, sessionId: string, trigger?: PruneWindowTriggerState): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const read = readDoc(dir);
  const fields = { round };
  if (read.transient) {
    return refusePublish(dir, read.reason ?? 'unreadable', journal, sessionId,
      'prune-round-error', fields);
  }
  const prior = read.doc;
  const appends = prior['appends'];
  return publishDoc(dir, { round,
    ...(trigger === undefined ? {} : { trigger }),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(typeof prior['tableAskFired'] === 'boolean'
      ? { tableAskFired: prior['tableAskFired'] } : {}),
    ...(Array.isArray(appends) ? { appends } : {}) },
  journal, sessionId, 'prune-round-error', fields);
}

/**
 * Whether this session already shipped its first-ask share line (ISSUE-406),
 * read from the same per-session file as the round and latch. An absent,
 * corrupt or non-boolean value reads `false`: the safe failure is to state the
 * first-ask share once more, never to claim a history the file cannot prove.
 * A fork starts false (see `plugin.ts`): the parent's ask history is not the
 * child's, exactly as the round and latch are not inherited.
 */
export function readEntryAskFired(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return false;
  const read = readDoc(dir);
  if (read.reason !== undefined) {
    nameReadRefusal(journal, sessionId, 'entryAskFired', read.reason);
    return false;
  }
  const fired = read.doc['entryAskFired'];
  if (fired === undefined) return false;
  if (typeof fired === 'boolean') return fired;
  nameReadRefusal(journal, sessionId, 'entryAskFired',
    'the entryAskFired record is structurally invalid; reading it as absent');
  return false;
}

/**
 * Record that the session has asked at least once (ISSUE-406), preserving the
 * round, the latch and the pending appends the same file carries. The flag is
 * one boolean on the existing per-session store — no new store and no cap.
 * Fail-open: a failed write journals `prune-round-error` and the in-memory flag
 * still serves this process; only the restart durability is lost.
 */
export function writeEntryAskFired(target: ResolvedRacoonsStorage, fired: boolean,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const read = readDoc(dir);
  const fields = { entryAskFired: fired };
  if (read.transient) {
    return refusePublish(dir, read.reason ?? 'unreadable', journal, sessionId,
      'prune-round-error', fields);
  }
  const prior = read.doc;
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(Array.isArray(prior['appends']) ? { appends: prior['appends'] } : {}),
    ...(typeof prior['tableAskFired'] === 'boolean'
      ? { tableAskFired: prior['tableAskFired'] } : {}),
    entryAskFired: fired,
  }, journal, sessionId, 'prune-round-error', fields);
}

/**
 * Whether this session's depth table has already left its first ask
 * (ISSUE-508), read from the same per-session file as the round, the latch and
 * the entry flag. An absent, corrupt or non-boolean value reads `false`: the
 * safe failure is to state the first-ask share once more, never to claim a
 * history the file cannot prove. A fork starts false — the parent's table
 * history is not the child's.
 */
export function readTableAskFired(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return false;
  const read = readDoc(dir);
  if (read.reason !== undefined) {
    nameReadRefusal(journal, sessionId, 'tableAskFired', read.reason);
    return false;
  }
  const fired = read.doc['tableAskFired'];
  if (fired === undefined) return false;
  if (typeof fired === 'boolean') return fired;
  nameReadRefusal(journal, sessionId, 'tableAskFired',
    'the tableAskFired record is structurally invalid; reading it as absent');
  return false;
}

/**
 * Record that this session's depth table has asked at least once (ISSUE-508),
 * preserving the round, the latch, the entry flag and the pending appends the
 * same file carries. One boolean on the existing per-session store — no new
 * store and no cap. Fail-open: a failed write journals `prune-round-error` and
 * the in-memory flag still serves this process; only the restart durability is
 * lost.
 */
export function writeTableAskFired(target: ResolvedRacoonsStorage, fired: boolean,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const read = readDoc(dir);
  const fields = { tableAskFired: fired };
  if (read.transient) {
    return refusePublish(dir, read.reason ?? 'unreadable', journal, sessionId,
      'prune-round-error', fields);
  }
  const prior = read.doc;
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(Array.isArray(prior['appends']) ? { appends: prior['appends'] } : {}),
    tableAskFired: fired,
  }, journal, sessionId, 'prune-round-error', fields);
}

/**
 * The latch state this session's file carries (ISSUE-336), or null when none
 * is readable: no file, a pre-336 round-only file, a corrupt file, or a
 * malformed `trigger` value all read as null. The safe failure is "start with
 * a fresh latch", never "trust garbage" — the same rule the round read follows.
 */
export function readPruneTriggerState(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): PruneWindowTriggerState | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const read = readDoc(dir);
  if (read.reason !== undefined) {
    nameReadRefusal(journal, sessionId, 'trigger', read.reason);
    return null;
  }
  return triggerOf(read.doc, journal, sessionId);
}

/** The latch a document names; a present bad value is refused, never trusted. */
function triggerOf(doc: Record<string, unknown>, journal: MountJournal | undefined,
  sessionId: string | undefined): PruneWindowTriggerState | null {
  const trigger = doc['trigger'];
  if (trigger === undefined) return null;
  if (typeof trigger !== 'object' || trigger === null) {
    nameReadRefusal(journal, sessionId, 'trigger',
      'the trigger record is structurally invalid; reading it as absent');
    return null;
  }
  const state = trigger as { readonly lastFireUsage?: unknown;
    readonly belowSinceFire?: unknown; readonly baselinePending?: unknown };
  const usage = state.lastFireUsage;
  const validUsage = usage === null
    || (typeof usage === 'number' && Number.isSafeInteger(usage) && usage >= 0);
  if (!validUsage || typeof state.belowSinceFire !== 'boolean'
    || typeof state.baselinePending !== 'boolean') {
    nameReadRefusal(journal, sessionId, 'trigger',
      'the trigger record is structurally invalid; reading it as absent');
    return null;
  }
  return { lastFireUsage: usage, belowSinceFire: state.belowSinceFire,
    baselinePending: state.baselinePending };
}

/**
 * One generated record a committed append owes the host (ISSUE-374). The
 * bytes ride as base64 so the JSON file stays lossless for any record body;
 * `recordId` is the stable identity `publishAppend` deduplicates by, so a
 * replay never duplicates a record the host already holds.
 */
export interface DurableAppendRecord {
  readonly recordId: string;
  readonly bytesBase64: string;
}

/**
 * The pending-append intent this session's file carries (ISSUE-374), in
 * commit order, or `[]` when none is readable: no file, a file without the
 * fact, or any malformed record all read as empty. The safe failure is "the
 * in-memory queue is the whole truth", never "trust garbage" — the same rule
 * the round and latch reads follow. A record whose base64 does not round-trip
 * is malformed: dropping the whole fact is the fail-open answer, never a
 * half-decoded body on the host's wire.
 *
 * A malformed record is named (ISSUE-430): when the caller supplies a journal,
 * one `pending-append-corrupt` line reports the record's position and defect
 * before the empty list is returned, so a fresh process's corrupt intent is
 * visible instead of silently reading as "nothing owed".
 */
export function readPendingAppends(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): DurableAppendRecord[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  try {
    const read = readDoc(dir);
    if (read.reason !== undefined) {
      nameReadRefusal(journal, sessionId, 'appends', read.reason);
      return [];
    }
    const appends = read.doc['appends'];
    if (!Array.isArray(appends)) return [];
    const records: DurableAppendRecord[] = [];
    for (const [index, value] of appends.entries()) {
      const malformed = (detail: string): DurableAppendRecord[] => {
        journal?.('pending-append-corrupt', { sessionId, position: index, detail });
        return [];
      };
      if (typeof value !== 'object' || value === null) return malformed('record is not an object');
      const record = value as { readonly recordId?: unknown; readonly bytesBase64?: unknown };
      if (typeof record.recordId !== 'string' || typeof record.bytesBase64 !== 'string') {
        return malformed('record is missing a string recordId or bytesBase64');
      }
      const bytes = Buffer.from(record.bytesBase64, 'base64');
      if (bytes.toString('base64') !== record.bytesBase64) {
        return malformed('bytesBase64 does not round-trip');
      }
      records.push({ recordId: record.recordId, bytesBase64: record.bytesBase64 });
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Write the pending-append intent (ISSUE-374), preserving the round and latch
 * facts the file already carries. An empty queue removes the fact, so a
 * flushed session's file holds no stale replay payload. Published atomically
 * through the same temp+rename as every other fact; a failed write journals
 * `append-persist-error` and returns false — the in-memory queue still flushes
 * this process (ISSUE-342), only the durability across a restart is lost.
 */
export function writePendingAppends(target: ResolvedRacoonsStorage,
  records: readonly DurableAppendRecord[], journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const read = readDoc(dir);
  const fields = { pending: records.length };
  if (read.transient) {
    return refusePublish(dir, read.reason ?? 'unreadable', journal, sessionId,
      'append-persist-error', fields);
  }
  const prior = read.doc;
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(typeof prior['tableAskFired'] === 'boolean'
      ? { tableAskFired: prior['tableAskFired'] } : {}),
    ...(records.length > 0 ? { appends: records } : {}),
  }, journal, sessionId, 'append-persist-error', fields);
}
