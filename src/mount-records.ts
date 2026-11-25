/**
 * The mount records one durable root carries (ISSUE-578; ADR-0075).
 *
 * The in-process registry in `plugin.ts` cannot see another process, so two
 * dsh processes on one project folder would each build their own mount and
 * neither would know the other exists. Each mount therefore records itself
 * under `<root>/mounts/<token>.json`: a unique-name create that can never
 * collide, never waits and never refuses the second mount (ADR-0075 decision
 * 2 — two terminals on one folder must both work).
 *
 * The record is published by rename onto its final name, so it is either
 * absent or complete. Nothing is held for the mount's lifetime: a crashed
 * mount's record is evidence only, and the next join sweeps it. A record
 * failure never refuses a mount — the caller journals it and goes on without a
 * record, because no mount is admitted on the strength of a record.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The directory one live mount records itself in, under its durable root. */
export const MOUNT_RECORDS_DIRECTORY = 'mounts';

/** What one mount's record says: the process that holds it and a token of its own. */
export interface MountRecord {
  readonly pid: number;
  readonly atMs: number;
  readonly token: string;
}

/** One published record: the file to release and the token that proves this mount wrote it. */
export interface MountRecordFile {
  readonly path: string;
  readonly token: string;
}

/** Whether an error carries one filesystem code. */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === code;
}

/** Whether a process is still alive: EPERM means it exists but is not ours. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return hasErrorCode(error, 'EPERM'); }
}

/** The array a record file holds, or null when it is absent, partial or unreadable. */
function readRecord(path: string): MountRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as { readonly pid?: unknown; readonly atMs?: unknown; readonly token?: unknown };
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 0
    || typeof record.atMs !== 'number' || typeof record.token !== 'string') return null;
  return { pid: record.pid, atMs: record.atMs, token: record.token };
}

/**
 * Join the live mounts on one durable root (ISSUE-578). The durable state two
 * mounts share — the session ledger and `mount-state.json` — is serialized by
 * the ledger's own cross-process write lock (`mount-state.ts`), so this is a
 * presence record, not a claim: every mount writes its own unique name and
 * none consults another for admission.
 *
 * Returns null when the folder or the record could not be written. A failed
 * record is not a failed mount (ADR-0075 decision 2): the caller journals it
 * and mounts without a record.
 */
export function joinMountRecords(root: string): MountRecordFile | null {
  const dir = join(root, MOUNT_RECORDS_DIRECTORY);
  try { mkdirSync(dir, { recursive: true }); }
  catch { return null; }
  sweepCrashedMountRecords(dir);
  const token = `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  const path = join(dir, `${token}.json`);
  const temp = `${path}.partial`;
  try {
    writeFileSync(temp, JSON.stringify({ pid: process.pid, atMs: Date.now(), token }), 'utf8');
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* the temp may never exist */ }
    return null;
  }
  return { path, token };
}

/** One root's mount records, as plain data; an unreadable folder reads as none. */
export function readMountRecords(root: string): MountRecord[] {
  const dir = join(root, MOUNT_RECORDS_DIRECTORY);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const records: MountRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readRecord(join(dir, name));
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * Remove the records a crashed mount left (ISSUE-578). A record naming a dead
 * process, or one this build cannot read, is not a holder: nothing waits on a
 * record, so this is tidiness and it never fails a join. A live mount's record
 * is written by rename onto its final name, never edited in place, so a record
 * at that name is always complete.
 */
function sweepCrashedMountRecords(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const record = readRecord(path);
    if (record !== null && processAlive(record.pid)) continue;
    try { unlinkSync(path); } catch { /* a later join sweeps what this could not remove */ }
  }
}

/**
 * Remove this mount's record, and only its own: the token must match, so a
 * joining mount's record is never deleted. A failure to release is not a mount
 * failure — the next join sweeps a dead record.
 */
export function releaseMountRecord(record: MountRecordFile): void {
  const held = readRecord(record.path);
  if (held !== null && held.token !== record.token) return;
  try { unlinkSync(record.path); } catch { /* a later join sweeps it */ }
}
