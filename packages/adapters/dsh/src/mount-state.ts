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
 *     that may already hold history, and it must not replay, ask about or
 *     remove that history (ISSUE-414).
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
 * Reads are fail-open in the same direction as the round store: an absent or
 * corrupt document reads as "the in-memory state is the whole truth", never as
 * a licence to trust garbage.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApplyReceipt } from '@cremator/core';
import type { ResolvedRacoonsStorage } from './storage.js';
import type { MountJournal } from './journal-kinds.js';

/** The state file's name, beside `ledger.sqlite`, `blobs/` and `prune-round.json`. */
export const MOUNT_STATE_FILE = 'mount-state.json';

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
   * observed them land and never removes, tables or asks about them.
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
  readonly install?: DurableInstall;
  readonly forgets?: readonly DurableForget[];
  readonly receipts?: readonly ApplyReceipt[];
}

/** The session directory a resolved durable target names, or null in memory. */
function sessionDirOf(target: ResolvedRacoonsStorage): string | null {
  return target.databasePath === ':memory:' ? null : dirname(target.databasePath);
}

function readDoc(dir: string): MountDoc {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, MOUNT_STATE_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as MountDoc : {};
  } catch {
    return {};
  }
}

/** Publish one complete document atomically; false when it could not be written. */
function publishDoc(dir: string, doc: MountDoc, journal: MountJournal, sessionId: string,
  fields: Record<string, unknown>): boolean {
  const final = join(dir, MOUNT_STATE_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(doc)}\n`, 'utf8');
    fs.renameSync(temp, final);
    return true;
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never have been created */ }
    journal('mount-state-error', { sessionId, ...fields,
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
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

/** The install identity this session's durable state carries, or null (fresh). */
export function readInstall(target: ResolvedRacoonsStorage): DurableInstall | null {
  const dir = sessionDirOf(target);
  return dir === null ? null : readInstallOf(readDoc(dir));
}

/** Record the mount identity/generation, preserving every other fact. */
export function writeInstall(target: ResolvedRacoonsStorage, install: DurableInstall,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const doc = readDoc(dir);
  return publishDoc(dir, { ...doc, install }, journal, sessionId,
    { fact: 'install', generation: install.generation });
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

/** The accepted-but-unapplied forgets this session's state carries. */
export function readPendingForgets(target: ResolvedRacoonsStorage): DurableForget[] {
  const dir = sessionDirOf(target);
  return dir === null ? [] : readForgetsOf(readDoc(dir));
}

/** Replace the owed-forget fact; an empty list removes it. */
export function writePendingForgets(target: ResolvedRacoonsStorage,
  forgets: readonly DurableForget[], journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  const doc = readDoc(dir);
  const { forgets: _prior, ...rest } = doc;
  return publishDoc(dir, { ...rest, ...(forgets.length === 0 ? {} : { forgets }) },
    journal, sessionId, { fact: 'forgets', pending: forgets.length });
}

function readReceiptsOf(doc: MountDoc): ApplyReceipt[] {
  const receipts = doc.receipts;
  if (!Array.isArray(receipts)) return [];
  const out: ApplyReceipt[] = [];
  for (const value of receipts) {
    if (typeof value !== 'object' || value === null) return [];
    const receipt = value as { readonly intentId?: unknown; readonly sessionId?: unknown;
      readonly baseRevision?: unknown; readonly resultRevision?: unknown;
      readonly applicationSha256?: unknown; readonly appliedAtMs?: unknown };
    if (typeof receipt.intentId !== 'string' || typeof receipt.sessionId !== 'string'
      || typeof receipt.baseRevision !== 'string' || typeof receipt.resultRevision !== 'string'
      || typeof receipt.applicationSha256 !== 'string' || !isCount(receipt.appliedAtMs)) return [];
    out.push(value as ApplyReceipt);
  }
  return out;
}

/** The host receipts a previous process minted for this session. */
export function readDurableReceipts(target: ResolvedRacoonsStorage): ApplyReceipt[] {
  const dir = sessionDirOf(target);
  return dir === null ? [] : readReceiptsOf(readDoc(dir));
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
  const doc = readDoc(dir);
  const prior = readReceiptsOf(doc).filter(row => row.intentId !== receipt.intentId);
  return publishDoc(dir, { ...doc, receipts: [...prior, receipt] }, journal, sessionId,
    { fact: 'receipts', intentId: receipt.intentId, count: prior.length + 1 });
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
  const doc = readDoc(dir);
  const prior = readReceiptsOf(doc);
  const remaining = prior.filter(row => row.intentId !== intentId);
  if (remaining.length === prior.length) return true;
  const { receipts: _prior, ...rest } = doc;
  return publishDoc(dir, { ...rest, ...(remaining.length === 0 ? {} : { receipts: remaining }) },
    journal, sessionId, { fact: 'receipts', collected: intentId, count: remaining.length });
}
