import { createHash } from 'node:crypto';
import type { ApplyRequest, EngineResult } from '@cremator/core';
import type { DshToolResultItem } from '../src/envelope.js';

export const clock = { nowMs: () => 1234 };
export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
export const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const unchanged: EngineResult = {
  status: 'unchanged', intentId: null, receipt: null, validation: null,
};

export function toolResult(id = 'result-1'): DshToolResultItem {
  return { id, role: 'tool', callId: 'call-1', toolName: 'read',
    bytes: bytes('\uFEFFa\r\n雪\n'), turnOrdinal: 0, stepOrdinal: 1,
    input: { path: 'source.ts' }, hostData: { order: 7, absent: undefined } };
}

export function applicationRequest(
  baseRevision: string, overrides: Partial<ApplyRequest['application']> = {}, intentId = 'intent-1',
): ApplyRequest {
  const application = {
    sessionId: 'session-1', eventId: 'event-1', baseRevision,
    phase: 'at-rest', mode: 'append', applicationSha256: 'application-1',
    replacements: [], appendRecords: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1234,
    ...overrides,
  // Port tests deliberately bypass the guard brand to probe host-side integrity checks.
  } as unknown as ApplyRequest['application'];
  return { application, intent: { intentId, sessionId: application.sessionId,
    eventId: application.eventId, baseRevision: application.baseRevision,
    applicationSha256: application.applicationSha256 } };
}

export function record(recordId = 'record-1') {
  const body = bytes('generated record');
  return { recordId, bytes: body, sha256: hash(body) };
}
