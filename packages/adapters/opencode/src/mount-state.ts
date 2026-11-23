/**
 * The opencode mount's durable state beside its ledger (ISSUE-448, ISSUE-409).
 *
 * Each session already owns one durable ledger at
 * `<root>/sessions/<segment>/ledger.sqlite` (`storage.ts`). This module keeps the
 * two facts that must survive a process boundary but are not ledger events, in
 * a sibling `mount-state.json` under the same session directory:
 *
 *   - `receipts` — the host receipts this port minted for applied removals. The
 *     in-process map dies with the process; the file lets a remount resolve a
 *     prepared ledger row the previous process landed instead of reading
 *     `unknown` and blocking recovery forever (ISSUE-448; ADR-0064).
 *   - `ask` — the ask identity that was claimed or answered: the revision
 *     claims, the unit claims, and the removal verdicts an apply owes. A
 *     restart rebuilds them instead of re-asking a claimed unit or losing an
 *     unapplied verdict (ISSUE-409; ADR-0063). A whole-unit `forgetall` stops
 *     being owed once its ledger `applied` row lands, because the banked row
 *     re-applies it; a partial `keeplines` is RETAINED, because only the
 *     verdict can reconstruct the kept lines on a rebuilt request or a remount
 *     (ISSUE-509).
 *
 * Every writer reads the current document, replaces only the fact it owns and
 * republishes the whole file atomically (temp + rename), so a kill mid-write
 * tears only the temp and every other fact is preserved. Reads are fail-open:
 * an absent or corrupt document reads as "nothing durable yet", never as a
 * licence to trust garbage. A write failure is returned to the caller so the
 * mount can name it; it never throws.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApplyReceipt, WireAnswer } from '@cremator/core';
import type { StorageTarget } from './storage.js';

/** The state file's name, beside `ledger.sqlite` and `blobs/`. */
export const MOUNT_STATE_FILE = 'mount-state.json';

/**
 * The schema version this build writes and the only one it reads (ISSUE-472).
 * A document tagged with another version is a different writer's format: the
 * readers refuse it by name instead of reading it as an empty record, so an
 * upgrade skew is observable and never silently re-opens a settled unit.
 */
export const MOUNT_STATE_VERSION = 1;

/** A per-process token so two writes never stage the same temp name. */
let tempSeq = 0;

/**
 * One ask verdict an apply still owes, with the node it addressed. A
 * `forgetall` is a whole-unit removal; a partial `keeplines` is a line-level
 * removal whose kept lines only the verdict itself can reconstruct, so it stays
 * durable across a process boundary (ISSUE-509).
 */
export interface DurableAskVerdict {
  readonly unitId: string;
  readonly nodeId: string;
  readonly answer: WireAnswer;
}

/** The ask identity a remount restores (ISSUE-409; ADR-0063). */
export interface DurableAskState {
  readonly revisions: readonly string[];
  readonly askedUnitIds: readonly string[];
  readonly retriedUnitIds: readonly string[];
  readonly refusedRetriedUnitIds: readonly string[];
  readonly verdicts: readonly DurableAskVerdict[];
  readonly deferredApply: boolean;
  readonly deferredFailures: number;
  /**
   * The table asks this session sent and had answered or refused with rows
   * (ISSUE-509). It picks the keep-share line: `0` states 70 percent, every
   * later value states 40 percent. A process boundary keeps it, so a resumed
   * segment does not restate the first ask's share. Absent in an older file
   * reads as `0` (fail-open: the share line is advisory and blocks nothing).
   */
  readonly askFires: number;
}

interface MountDoc {
  readonly version?: number;
  readonly receipts?: readonly ApplyReceipt[];
  readonly ask?: DurableAskState;
}

/** A read's result: the usable document, or the reason a present one was refused. */
interface DocRead {
  readonly doc: MountDoc;
  readonly rejected?: string;
}

/** The sink a reader calls when a present document is refused (ISSUE-472). */
export type MountStateRejection = (message: string) => void;

/** A write's outcome. `message` names a failure; the mount journals it. */
export interface DurableWriteResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** The session directory a durable target names, or null for a memory target. */
function sessionDirOf(target: StorageTarget): string | null {
  return target.kind === 'memory' ? null : dirname(target.databasePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A pre-version document (ISSUE-472 wrote before the tag existed). It is read
 * as version 1 when its shape is this build's — an `ask` object or a
 * `receipts` array — so an upgrade does not discard claims a legacy build
 * wrote (ISSUE-484).
 */
function isLegacyMountDoc(value: Record<string, unknown>): boolean {
  return Array.isArray(value.receipts) || isRecord(value.ask);
}

/**
 * Read one document. An absent file is legitimately empty; a present file this
 * build cannot read — bad JSON, not an object, or another format version — is
 * refused with its reason so the caller can journal it by name (ISSUE-472).
 */
function readDoc(dir: string): DocRead {
  let raw: string;
  try {
    raw = fs.readFileSync(join(dir, MOUNT_STATE_FILE), 'utf8');
  } catch {
    return { doc: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: {}, rejected: 'the mount-state file is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { doc: {}, rejected: 'the mount-state file is not a JSON object' };
  }
  if (parsed.version === undefined && isLegacyMountDoc(parsed)) {
    return { doc: { ...parsed, version: MOUNT_STATE_VERSION } as unknown as MountDoc };
  }
  if (parsed.version !== MOUNT_STATE_VERSION) {
    const seen = typeof parsed.version === 'number' ? String(parsed.version) : 'absent';
    return { doc: {}, rejected: `unknown mount-state format version ${seen}; `
      + `this build reads version ${String(MOUNT_STATE_VERSION)}` };
  }
  return { doc: parsed as unknown as MountDoc };
}

/**
 * Refuse a write over a document this build cannot read. Merging into the
 * discarded empty read would replace the other writer's file with this build's
 * version; the refusal is named instead, so "observable refusal" never becomes
 * "silent takeover" (ISSUE-484; ADR-0064 decision 1).
 */
function refuseWrite(dir: string, reason: string): DurableWriteResult {
  return { ok: false, message: `refusing to overwrite ${join(dir, MOUNT_STATE_FILE)}: ${reason}` };
}

/** Publish one complete document atomically; a failure is named, never thrown. */
function publishDoc(dir: string, doc: MountDoc): DurableWriteResult {
  const final = join(dir, MOUNT_STATE_FILE);
  const temp = `${final}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp,
      `${JSON.stringify({ ...doc, version: MOUNT_STATE_VERSION })}\n`, 'utf8');
    fs.renameSync(temp, final);
    return { ok: true };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp may never exist */ }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function readReceiptsOf(doc: MountDoc): ApplyReceipt[] {
  const receipts = doc.receipts;
  if (!Array.isArray(receipts)) return [];
  const out: ApplyReceipt[] = [];
  for (const value of receipts) {
    if (!isRecord(value)) return [];
    if (typeof value.intentId !== 'string' || typeof value.sessionId !== 'string'
      || typeof value.baseRevision !== 'string' || typeof value.resultRevision !== 'string'
      || typeof value.applicationSha256 !== 'string' || !isCount(value.appliedAtMs)) return [];
    out.push(value as unknown as ApplyReceipt);
  }
  return out;
}

/** The host receipts a previous process minted for this session (ISSUE-448). */
export function readDurableReceipts(
  target: StorageTarget, onReject?: MountStateRejection,
): ApplyReceipt[] {
  const dir = sessionDirOf(target);
  if (dir === null) return [];
  const read = readDoc(dir);
  if (read.rejected !== undefined) {
    onReject?.(read.rejected);
    return [];
  }
  const rows = readReceiptsOf(read.doc);
  const receipts = read.doc.receipts;
  if (receipts !== undefined && !Array.isArray(receipts)) {
    onReject?.('the receipts record is not an array; reading it as absent');
    return [];
  }
  if (rows.length === 0 && (receipts?.length ?? 0) > 0) {
    onReject?.('the receipts record is structurally invalid; reading it as absent');
    return [];
  }
  return rows;
}

/**
 * Record one applied receipt, replacing any earlier row for the same intent.
 * The port calls this at the host write, before the engine's own `applied`
 * ledger row, so a death in between leaves a durable receipt the remount can
 * answer from (ISSUE-448; ADR-0064).
 */
export function writeDurableReceipt(
  target: StorageTarget, receipt: ApplyReceipt,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  const read = readDoc(dir);
  if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
  const prior = readReceiptsOf(read.doc).filter(row => row.intentId !== receipt.intentId);
  return publishDoc(dir, { ...read.doc, receipts: [...prior, receipt] });
}

/**
 * Drop one durable receipt once the ledger's own `applied` row supersedes it
 * (ISSUE-495, the dsh adapter's ISSUE-436 collection). The receipt exists only
 * for the crash window between the host write and that row (ISSUE-448); the
 * ledger is the record of record (ADR-0015), so the copy has no further reader.
 * Garbage collection of superseded state, not a cap: no count, age or budget is
 * introduced, and an empty set removes the `receipts` field whole. A failed
 * write is returned for the mount to journal, like every other mount-state
 * write; a write that would not change the file does not touch it.
 */
export function removeDurableReceipt(
  target: StorageTarget, intentId: string,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  const read = readDoc(dir);
  if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
  const prior = readReceiptsOf(read.doc);
  const remaining = prior.filter(row => row.intentId !== intentId);
  if (remaining.length === prior.length) return { ok: true };
  const { receipts: _prior, ...rest } = read.doc;
  return publishDoc(dir, { ...rest, ...(remaining.length === 0 ? {} : { receipts: remaining }) });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isWireAnswer(value: unknown): value is WireAnswer {
  if (!isRecord(value) || !isRecord(value.verdict)) return false;
  const verdict = value.verdict;
  return typeof verdict.unitId === 'string' && typeof verdict.action === 'string'
    && isCount(verdict.answeredInRound);
}

function readAskOf(doc: MountDoc): DurableAskState | null {
  const ask = doc.ask;
  if (!isRecord(ask)) return null;
  if (!isStringArray(ask.revisions) || !isStringArray(ask.askedUnitIds)
    || !isStringArray(ask.retriedUnitIds) || !isStringArray(ask.refusedRetriedUnitIds)
    || !Array.isArray(ask.verdicts)
    || typeof ask.deferredApply !== 'boolean' || !isCount(ask.deferredFailures)) return null;
  const verdicts: DurableAskVerdict[] = [];
  for (const value of ask.verdicts) {
    if (!isRecord(value) || typeof value.unitId !== 'string'
      || typeof value.nodeId !== 'string' || !isWireAnswer(value.answer)) return null;
    verdicts.push({ unitId: value.unitId, nodeId: value.nodeId, answer: value.answer });
  }
  return {
    revisions: ask.revisions, askedUnitIds: ask.askedUnitIds,
    retriedUnitIds: ask.retriedUnitIds, refusedRetriedUnitIds: ask.refusedRetriedUnitIds,
    verdicts, deferredApply: ask.deferredApply, deferredFailures: ask.deferredFailures,
    // ISSUE-509: an older file (or a write that never carried the count) reads
    // as "no fire yet". The record is still usable, so one missing optional
    // fact does not refuse the whole ask identity.
    askFires: isCount(ask.askFires) ? ask.askFires : 0,
  };
}

/** The ask identity this session's durable state carries, or null (none). */
export function readDurableAskState(
  target: StorageTarget, onReject?: MountStateRejection,
): DurableAskState | null {
  const dir = sessionDirOf(target);
  if (dir === null) return null;
  const read = readDoc(dir);
  if (read.rejected !== undefined) {
    onReject?.(read.rejected);
    return null;
  }
  if (read.doc.ask === undefined) return null;
  const ask = readAskOf(read.doc);
  if (ask === null) {
    onReject?.('the ask record is structurally invalid; reading it as absent');
    return null;
  }
  return ask;
}

/**
 * Replace the ask identity. An empty state with no claims and no verdicts is
 * still published: the claims are what stop a later mount re-asking a settled
 * revision, so the record is only absent before the first ask (ISSUE-409).
 */
export function writeDurableAskState(
  target: StorageTarget, ask: DurableAskState,
): DurableWriteResult {
  const dir = sessionDirOf(target);
  if (dir === null) return { ok: true };
  const read = readDoc(dir);
  if (read.rejected !== undefined) return refuseWrite(dir, read.rejected);
  return publishDoc(dir, { ...read.doc, ask });
}
