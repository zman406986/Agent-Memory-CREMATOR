/**
 * The OpenCode mount's saved last request (ADR-0076, ISSUE-604).
 *
 * `entry.lastMessages` is the array the last context hook handed in, held in
 * process memory only. A restart starts with no array, so `/cremate` answered
 * `no-session` until the chat sent a new request (ISSUE-541's remaining risk).
 * This module keeps the array the mount itself saw in a per-session sidecar
 * beside the ledger:
 *
 *   <root>/sessions/<segment>/last-request.json
 *
 * Shape: one JSON object with a `version` tag, the session id the array was
 * saved for, the revision the mount computed for it, the save wall time, and
 * the message array verbatim. The array is saved as the mount saw it: the
 * adapter's own receipt messages included, because that is the request the
 * model received.
 *
 * The file is published atomically (temp + rename), so a kill mid-write tears
 * only the temp and the previous save survives. Reads are fail-open for an
 * absent file (`no-session` remains the answer) and refuse a present file by
 * name (another version, another session, a malformed array), so a corrupt
 * save is observable and never read as an empty request. A write failure is
 * returned to the caller and never throws; the request itself is unaffected.
 *
 * A `':memory:'` target has no session directory and every call is a no-op.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { OpencodeMessage } from './host.js';
import type { StorageTarget } from './storage.js';

/** The sidecar's name, beside `ledger.sqlite` and `mount-state.json`. */
export const REQUEST_SNAPSHOT_FILE = 'last-request.json';

/** The schema version this build writes and the only one it reads. */
export const REQUEST_SNAPSHOT_VERSION = 1;

/** One saved request. `revision` is the mount's content hash when known. */
export interface RequestSnapshot {
  readonly version: number;
  readonly sessionId: string;
  readonly revision: string | null;
  readonly atMs: number;
  readonly messages: readonly OpencodeMessage[];
}

/** A read's result: the usable save, or the reason a present one was refused. */
export interface RequestSnapshotRead {
  readonly snapshot: RequestSnapshot | null;
  /** Present only when a save existed but this build would not use it. */
  readonly rejected?: string;
}

/** A write's outcome. `bytes` is the published payload's size on success. */
export type RequestSnapshotWrite =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly message: string };

/** A per-process token so two writes never stage the same temp name. */
let tempSeq = 0;

/** The session directory a durable target names, or null for a memory target. */
function sessionDirOf(target: StorageTarget): string | null {
  return target.kind === 'memory' ? null : dirname(target.databasePath);
}

/** The save's path for one target, or null when the target has no directory. */
export function requestSnapshotPath(target: StorageTarget): string | null {
  const dir = sessionDirOf(target);
  return dir === null ? null : join(dir, REQUEST_SNAPSHOT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether one element is a message this adapter can table: an object with a
 * string role and an array of content parts. The role's value is not checked
 * against the host's enum, so a host role this build does not model is still a
 * message; a part this build does not model is evidence, not a refusal.
 */
function isMessage(value: unknown): value is OpencodeMessage {
  return isRecord(value) && typeof value['role'] === 'string'
    && Array.isArray(value['content']);
}

/**
 * Read one session's save. An absent file is `{snapshot: null}` with no
 * rejection: that is the ordinary fresh-session answer. A present file that
 * cannot be read, carries another version, names another session, or holds no
 * usable array is refused with its reason.
 */
export function readRequestSnapshot(
  path: string | null, sessionId: string,
): RequestSnapshotRead {
  if (path === null) return { snapshot: null };
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: null };
    return { snapshot: null, rejected: 'the saved request could not be read: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { snapshot: null, rejected: 'the saved request is not valid JSON: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  if (!isRecord(parsed)) {
    return { snapshot: null, rejected: 'the saved request is not an object' };
  }
  if (parsed['version'] !== REQUEST_SNAPSHOT_VERSION) {
    return { snapshot: null, rejected: 'the saved request carries version '
      + `${JSON.stringify(parsed['version'])}; this build reads `
      + `${REQUEST_SNAPSHOT_VERSION}` };
  }
  if (parsed['sessionId'] !== sessionId) {
    return { snapshot: null, rejected: 'the saved request names another session: '
      + JSON.stringify(parsed['sessionId']) };
  }
  const atMs = parsed['atMs'];
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return { snapshot: null, rejected: 'the saved request has no save time' };
  }
  const revision = parsed['revision'];
  if (revision !== null && revision !== undefined && typeof revision !== 'string') {
    return { snapshot: null, rejected: 'the saved request has a malformed revision' };
  }
  const messages = parsed['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return { snapshot: null, rejected: 'the saved request holds no messages' };
  }
  if (!messages.every(isMessage)) {
    return { snapshot: null, rejected: 'the saved request holds a malformed message' };
  }
  return {
    snapshot: {
      version: REQUEST_SNAPSHOT_VERSION,
      sessionId,
      revision: typeof revision === 'string' ? revision : null,
      atMs,
      messages: messages as OpencodeMessage[],
    },
  };
}

/**
 * Publish one save atomically. The payload is serialized before the temp file
 * is opened, so a message graph JSON cannot represent is a named refusal and no
 * partial file is staged. A failure leaves the previous save in place.
 */
export function writeRequestSnapshot(
  path: string | null, snapshot: Omit<RequestSnapshot, 'version'>,
): RequestSnapshotWrite {
  if (path === null) return { ok: true, bytes: 0 };
  let payload: string;
  try {
    payload = `${JSON.stringify({
      version: REQUEST_SNAPSHOT_VERSION,
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      atMs: snapshot.atMs,
      messages: snapshot.messages,
    })}\n`;
  } catch (error) {
    return { ok: false, message: 'the saved request could not be serialized: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  const temp = `${path}.${process.pid}.${tempSeq}.tmp`;
  tempSeq += 1;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, path);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may not exist */ }
    return { ok: false, message: 'the saved request could not be written: '
      + (error instanceof Error ? error.message : String(error)) };
  }
  return { ok: true, bytes: Buffer.byteLength(payload, 'utf8') };
}
