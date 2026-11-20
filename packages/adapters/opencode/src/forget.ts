/**
 * The manual `forget` tool's pure half (PRD §6.2; ISSUE-300 item 19).
 *
 * The tool call names a path and optional 1-based line ranges, exactly the
 * surface `OPENCODE_TOOL_SPECS` advertises. Resolution against the request's
 * own snapshot is core's `resolveForget`: the one unit that holds those lines,
 * or a typed refusal. A resolved request is **scheduled**, never applied inside
 * the call: the assistant message carrying the call is still unanswered while
 * `execute` runs, and the host appends the tool result only after it returns.
 * The mount therefore drains its queue at the next request boundary, after the
 * at-rest commit, through the engine's `{kind: 'forget'}` event — the same
 * ledger/engine path every other removal uses.
 *
 * Nothing here renders bytes: the receipt and its recall id are minted by the
 * guard and the ledger when the removal applies.
 */

import {
  canonicalBytesWithByteArrays, resolveForget, sha256Sync,
} from '@cremator/core';
import type {
  EventId, ForgetRequest, LineRange, SessionId, SessionSnapshot, UnitId,
} from '@cremator/core';

/** The request one tool call names, or a thrown error for a malformed CALL. */
export function readOpencodeForgetArgs(args: unknown): ForgetRequest {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('forget expects an object with a path');
  }
  const record = args as Record<string, unknown>;
  const path = record['path'];
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('forget expects a non-empty path');
  }
  const raw = record['ranges'];
  if (raw === undefined) return { source: path, ranges: [], label: null };
  if (!Array.isArray(raw)) throw new Error('forget expects ranges to be a list of line ranges');
  const ranges: LineRange[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('forget expects each range to be an object with startLine and endLine');
    }
    const range = entry as Record<string, unknown>;
    const startLine = range['startLine'], endLine = range['endLine'];
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) {
      throw new Error('forget expects integer startLine and endLine');
    }
    if ((startLine as number) < 1 || (endLine as number) < (startLine as number)) {
      throw new Error('forget expects 1-based ranges with endLine at or after startLine');
    }
    ranges.push({ startLine: startLine as number, endLineInclusive: endLine as number });
  }
  return { source: path, ranges, label: null };
}

/** One resolved request the mount will apply at its next boundary. */
export interface OpencodeForgetScheduled {
  readonly status: 'scheduled';
  readonly eventId: EventId;
  readonly unitId: UnitId;
  readonly request: ForgetRequest;
  readonly ranges: readonly LineRange[];
}

/** The refusal the lookup itself names; `unsupported-capability` is the mount's. */
export interface OpencodeForgetRefused {
  readonly status: 'refused';
  readonly code: 'unresolved-request' | 'unsupported-capability';
  readonly reason: 'malformed-request' | 'absent' | 'ambiguous' | 'no-revert-seam' | 'no-array';
  readonly detail: string;
}

export type OpencodeForgetDecision = OpencodeForgetScheduled | OpencodeForgetRefused;

/**
 * The one engine event id for a resolved request: the session, the unit and
 * the request's own spelling. A counter would reset on reload and collide with
 * an applied receipt; this digest cannot.
 */
export function opencodeForgetEventId(
  sessionId: SessionId, unitId: UnitId, request: ForgetRequest,
): EventId {
  const digest = sha256Sync(canonicalBytesWithByteArrays({
    sessionId, unitId, source: request.source, ranges: request.ranges,
  }));
  return `oc:${sessionId}:forget:${digest}`;
}

/** Resolve one request against the mount's own snapshot. */
export function decideOpencodeForget(input: {
  readonly snapshot: SessionSnapshot;
  readonly sessionId: SessionId;
  readonly request: ForgetRequest;
}): OpencodeForgetDecision {
  const resolution = resolveForget({
    snapshot: input.snapshot, sessionId: input.sessionId, request: input.request,
  });
  if (resolution.status === 'refused') {
    return { status: 'refused', code: 'unresolved-request',
      reason: resolution.reason, detail: resolution.detail };
  }
  return { status: 'scheduled', unitId: resolution.unit.id,
    eventId: opencodeForgetEventId(input.sessionId, resolution.unit.id, input.request),
    request: { ...input.request,
      ranges: input.request.ranges.map(range => ({ ...range })) },
    ranges: input.request.ranges.map(range => ({ ...range })) };
}

/** The value the model receives: a scheduled request or the lookup's refusal. */
export type OpencodeForgetValue = {
  readonly status: 'scheduled';
  readonly path: string;
  readonly ranges: readonly { readonly startLine: number; readonly endLine: number }[];
} | {
  readonly status: 'refused';
  readonly code: 'unresolved-request' | 'unsupported-capability';
  readonly reason: string;
  readonly detail: string;
};

export function forgetAnswer(decision: OpencodeForgetDecision): OpencodeForgetValue {
  if (decision.status === 'refused') {
    return { status: 'refused', code: decision.code, reason: decision.reason,
      detail: decision.detail };
  }
  return { status: 'scheduled', path: decision.request.source,
    ranges: decision.ranges.map(range => ({ startLine: range.startLine,
      endLine: range.endLineInclusive })) };
}

/** The model-facing text of one forget answer, terse and factual. */
export function forgetAnswerText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'forget answered no outcome';
  const record = value as Record<string, unknown>;
  if (record['status'] === 'refused') {
    const code = typeof record['code'] === 'string' ? record['code'] : 'unresolved-request';
    const reason = typeof record['reason'] === 'string' ? record['reason'] : 'refused';
    const detail = typeof record['detail'] === 'string' ? record['detail'] : '';
    return `forget refused (${code}: ${reason}): ${detail}`;
  }
  if (record['status'] !== 'scheduled') return 'forget answered no outcome';
  const path = typeof record['path'] === 'string' ? record['path'] : '';
  const ranges = Array.isArray(record['ranges']) ? record['ranges'] : [];
  const span = ranges.length === 0 ? '' : ` lines ${ranges.map(range => {
    const item = range as { startLine?: unknown; endLine?: unknown };
    return `${String(item.startLine)}–${String(item.endLine)}`;
  }).join(', ')}`;
  return `forget scheduled for ${path}${span}: the removal applies at the next request boundary `
    + 'if the guard approves it, and its receipt then names the necromancy id.';
}
