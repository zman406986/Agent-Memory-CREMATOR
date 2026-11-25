/**
 * The composer dock's counter: how many bytes CREMATOR removed in one session.
 *
 * Ground truth is the ledger. A removal is counted only when an `applied` event
 * names an intent whose `prepared` event recorded `engine.removedBytes`; a
 * prepared-but-abandoned intent removed nothing. Reading is display-only: no
 * event is written, no state is kept, and every malformed row is ignored.
 */
import type { LedgerEvent, SessionId } from '@cremator/core';

/** The slice of a ledger the counter reads; narrow so a test can fake it. */
export interface CrematedLedgerSource {
  events(sessionId: SessionId): AsyncIterable<{ readonly event: LedgerEvent }>;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

function roundOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A short human byte size. Binary units (1024), because `removedBytes` counts
 * bytes and the rest of the product already speaks in those. Negative or
 * non-finite input is a display failure, never a throw.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let unit = 0;
  let scaled = bytes;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  let text = roundOne(scaled);
  // 1048570 bytes is 1024.0 KB, not a readable size; promote the unit instead.
  if (Number(text) >= 1024 && unit < UNITS.length - 1) {
    unit += 1;
    text = roundOne(bytes / 1024 ** unit);
  }
  return `${text} ${UNITS[unit] ?? 'B'}`;
}

/**
 * `engine.removedBytes` is written onto the prepared row by the journal writer
 * but is not in the public `LedgerEvent` union. Read it defensively: an absent
 * or malformed value means "unknown", never "zero bytes were removed".
 */
export function preparedRemovedBytes(event: LedgerEvent): number | null {
  if (event.kind !== 'prepared') return null;
  const engine: unknown = (event as unknown as { engine?: unknown }).engine;
  if (typeof engine !== 'object' || engine === null) return null;
  const value: unknown = (engine as { removedBytes?: unknown }).removedBytes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Sum the bytes of applied removals, in ledger order. */
export function sumAppliedRemovedBytes(entries: Iterable<{ readonly event: LedgerEvent }>): number {
  const events = [...entries].map(entry => entry.event);
  const prepared = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'prepared') continue;
    const bytes = preparedRemovedBytes(event);
    if (bytes !== null && !prepared.has(event.intentId)) prepared.set(event.intentId, bytes);
  }
  let total = 0;
  for (const event of events) {
    if (event.kind !== 'applied') continue;
    total += prepared.get(event.receipt.intentId) ?? 0;
  }
  return total;
}

/** Read one session's ledger and sum its applied removals. */
export async function readAppliedRemovedBytes(
  source: CrematedLedgerSource,
  sessionId: SessionId,
): Promise<number> {
  const entries: { readonly event: LedgerEvent }[] = [];
  for await (const entry of source.events(sessionId)) entries.push({ event: entry.event });
  return sumAppliedRemovedBytes(entries);
}
