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
 */
export function readPruneRound(target: ResolvedRacoonsStorage): number {
  const dir = sessionDirOf(target);
  if (dir === null) return 0;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, PRUNE_ROUND_FILE), 'utf8'));
    const round = typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly round?: unknown }).round : undefined;
    return typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : 0;
  } catch {
    return 0;
  }
}

/**
 * The file's current document, or `{}` when it is absent, unreadable or not a
 * JSON object. Every writer reads it first so the facts it does not own ride
 * along unchanged (ISSUE-336's trigger, ISSUE-374's appends); the safe failure
 * is "start over", never "trust garbage".
 */
function readDoc(dir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, PRUNE_ROUND_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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
  errorKind: 'prune-round-error' | 'append-persist-error' | 'entry-publish-persist-error',
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
  const prior = readDoc(dir);
  const appends = prior['appends'];
  const entryPublishes = prior['entryPublishes'];
  return publishDoc(dir, { round,
    ...(trigger === undefined ? {} : { trigger }),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(Array.isArray(appends) ? { appends } : {}),
    ...(Array.isArray(entryPublishes) ? { entryPublishes } : {}) },
  journal, sessionId, 'prune-round-error', { round });
}

/**
 * Whether this session already shipped its first-ask share line (ISSUE-406),
 * read from the same per-session file as the round and latch. An absent,
 * corrupt or non-boolean value reads `false`: the safe failure is to state the
 * first-ask share once more, never to claim a history the file cannot prove.
 * A fork starts false (see `plugin.ts`): the parent's ask history is not the
 * child's, exactly as the round and latch are not inherited.
 */
export function readEntryAskFired(target: ResolvedRacoonsStorage): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return false;
  try {
    return readDoc(dir)['entryAskFired'] === true;
  } catch {
    return false;
  }
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
  const prior = readDoc(dir);
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(Array.isArray(prior['appends']) ? { appends: prior['appends'] } : {}),
    ...(Array.isArray(prior['entryPublishes'])
      ? { entryPublishes: prior['entryPublishes'] } : {}),
    entryAskFired: fired,
  }, journal, sessionId, 'prune-round-error', { entryAskFired: fired });
}

/**
 * The latch state this session's file carries (ISSUE-336), or null when none
 * is readable: no file, a pre-336 round-only file, a corrupt file, or a
 * malformed `trigger` value all read as null. The safe failure is "start with
 * a fresh latch", never "trust garbage" — the same rule the round read follows.
 */
export function readPruneTriggerState(target: ResolvedRacoonsStorage): PruneWindowTriggerState | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, PRUNE_ROUND_FILE), 'utf8'));
    const trigger = typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly trigger?: unknown }).trigger : undefined;
    if (typeof trigger !== 'object' || trigger === null) return null;
    const state = trigger as { readonly lastFireUsage?: unknown;
      readonly belowSinceFire?: unknown; readonly baselinePending?: unknown };
    const usage = state.lastFireUsage;
    if (usage !== null
      && (typeof usage !== 'number' || !Number.isSafeInteger(usage) || usage < 0)) return null;
    if (typeof state.belowSinceFire !== 'boolean'
      || typeof state.baselinePending !== 'boolean') return null;
    return { lastFireUsage: usage, belowSinceFire: state.belowSinceFire,
      baselinePending: state.baselinePending };
  } catch {
    return null;
  }
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
    const appends = readDoc(dir)['appends'];
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
  const prior = readDoc(dir);
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(Array.isArray(prior['entryPublishes'])
      ? { entryPublishes: prior['entryPublishes'] } : {}),
    ...(records.length > 0 ? { appends: records } : {}),
  }, journal, sessionId, 'append-persist-error', { pending: records.length });
}

/**
 * One entry replacement a released life still owes the host surface
 * (ISSUE-450). `callId` is the node identity `publishEntry` resolves at replay
 * time, `eventId` is the transcript id the journal names, and `bytesBase64`
 * carries the replacement body losslessly through the JSON file.
 */
export interface DurableEntryPublish {
  readonly callId: string;
  readonly eventId: string;
  readonly bytesBase64: string;
}

/**
 * The pending entry-publish intent this session's file carries (ISSUE-450), in
 * commit order, or `[]` when none is readable. The same fail-open rule as the
 * append intent: a malformed record is named through `pending-append-corrupt`
 * with `fact: 'entry-publishes'` and the whole fact reads empty rather than a
 * half-decoded body reaching the host.
 */
export function readPendingEntryPublishes(target: ResolvedRacoonsStorage,
  journal?: MountJournal, sessionId?: string): DurableEntryPublish[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  try {
    const publishes = readDoc(dir)['entryPublishes'];
    if (!Array.isArray(publishes)) return [];
    const records: DurableEntryPublish[] = [];
    for (const [index, value] of publishes.entries()) {
      const malformed = (detail: string): DurableEntryPublish[] => {
        journal?.('pending-append-corrupt', { sessionId, position: index,
          detail, fact: 'entry-publishes' });
        return [];
      };
      if (typeof value !== 'object' || value === null) return malformed('record is not an object');
      const record = value as { readonly callId?: unknown; readonly eventId?: unknown;
        readonly bytesBase64?: unknown };
      if (typeof record.callId !== 'string' || typeof record.eventId !== 'string'
        || typeof record.bytesBase64 !== 'string') {
        return malformed('record is missing a string callId, eventId or bytesBase64');
      }
      const bytes = Buffer.from(record.bytesBase64, 'base64');
      if (bytes.toString('base64') !== record.bytesBase64) {
        return malformed('bytesBase64 does not round-trip');
      }
      records.push({ callId: record.callId, eventId: record.eventId,
        bytesBase64: record.bytesBase64 });
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Write the pending entry-publish intent (ISSUE-450), preserving the round,
 * latch, first-ask flag and append intent the file already carries. An empty
 * queue removes the fact, so a fully published session leaves no stale replay
 * payload. Published atomically through the same temp+rename; a failed write
 * journals `entry-publish-persist-error` and returns false — the in-memory
 * queue still serves this process, only the restart durability is lost.
 */
export function writePendingEntryPublishes(target: ResolvedRacoonsStorage,
  records: readonly DurableEntryPublish[], journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const prior = readDoc(dir);
  return publishDoc(dir, {
    ...(typeof prior['round'] === 'number' ? { round: prior['round'] } : {}),
    ...(typeof prior['trigger'] === 'object' && prior['trigger'] !== null
      ? { trigger: prior['trigger'] } : {}),
    ...(typeof prior['entryAskFired'] === 'boolean'
      ? { entryAskFired: prior['entryAskFired'] } : {}),
    ...(Array.isArray(prior['appends']) ? { appends: prior['appends'] } : {}),
    ...(records.length > 0 ? { entryPublishes: records } : {}),
  }, journal, sessionId, 'entry-publish-persist-error', { pending: records.length });
}
