import type {
  EventId, ForgetRequest, LineRange, SessionId, SessionSnapshot, UnitId,
} from '@cremator/core';
import { canonicalBytesWithByteArrays, resolveForget, sha256Sync } from '@cremator/core';
import type { DshTranscriptItem } from './envelope.js';
import { dshRetentionOf } from './retention.js';
import type { DshRetentionCode, DshRetentionVerdict } from './retention.js';

/**
 * The manual forget tool (PRD §6.2 "Mistakes are recoverable: manual forget, or
 * recall by id"; ISSUE-045 chunk D2).
 *
 * ## What this file decides
 *
 * `DSH_TOOL_SPECS` declares the argument surface — one `path`, optional 1-based
 * `ranges` — and `readForgetArgs` turns that into the core's `ForgetRequest` in
 * the transcript's own spelling. `decideForget` then resolves the request
 * against the mount's live snapshot with core's own `units/lookup.ts`: the one
 * unit that holds those lines, or a refusal. A refusal is answered with the
 * lookup's own sentence, verbatim — the one place a refusal can reach the agent
 * as the tool's answer, because resolution is a pure read of the snapshot and
 * is decidable while the call is open.
 *
 * ## Why a resolvable request is scheduled, never applied here
 *
 * A revert shadows a contiguous span of the live surface and re-emits its
 * survivors. While the model's own call is unanswered, the assistant message
 * that carried it sits on the surface with a tool call and no result; every
 * rebuild from the forgotten node's cut re-emits that call unanswered, and the
 * adapter's own pairing check refuses it (`tool-pair-imbalance`; verified by a
 * probe against `planRevertAppend`, not assumed). The host also appends a tool
 * result only after `execute` returns, so no in-call ordering avoids it. The
 * mount therefore queues the resolved request and applies it at its next legal
 * boundary, where every other removal applies, and this module answers what it
 * can prove at call time.
 *
 * Nothing here renders bytes: the receipt line and its recall id are produced
 * by the guard and the ledger when the removal applies (`guard/candidate.ts`),
 * so the tool can never name a recall id it did not mint.
 */
export interface DshForgetScheduled {
  readonly status: 'scheduled';
  /** The engine event id the mount will apply this request under. */
  readonly eventId: EventId;
  /** The unit the request resolved to; the mount needs it for the event id only. */
  readonly unitId: UnitId;
  readonly request: ForgetRequest;
  /** The request's own ranges, echoed in the answer. */
  readonly ranges: readonly LineRange[];
}

/**
 * The refusal a forget answers before any guard run. `code` is the guard's own
 * validation code for this refusal, so the agent reads one vocabulary:
 * `unresolved-request` when the lookup names no single held unit,
 * `unsupported-capability` when the mount cannot apply a removal at all, and the
 * two retention markers (ISSUE-519) when the resolved unit may not be removed.
 * `detail` is core's own sentence, never a rephrasing, except the retention
 * sentences this adapter states.
 */
export interface DshForgetRefusal {
  readonly status: 'refused';
  readonly code: 'unresolved-request' | 'unsupported-capability' | DshRetentionCode;
  readonly reason: 'malformed-request' | 'absent' | 'ambiguous' | 'no-revert-seam'
    | 'not-durable' | 'retained';
  readonly detail: string;
}

export type DshForgetDecision = DshForgetScheduled | DshForgetRefusal;

/**
 * The request one tool call names, or a thrown error when the arguments are not
 * a forget call at all. A malformed CALL is the model's own error and surfaces
 * as a failed tool result; it is not a refusal the product makes about content.
 * Absent or empty `ranges` names the unit whole, exactly as the spec's
 * `required` list implies. The spec declares no label, so the receipt ships its
 * floor line (PRD §6.3).
 */
export function readForgetArgs(args: unknown): ForgetRequest {
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

/**
 * Resolve one request against the mount's own snapshot.
 *
 * The event id is derived from the resolved unit and the request, never from a
 * counter: the engine dedupes by `eventId`, and a counter that resets on
 * restart would collide with an applied forget's receipt and silently apply
 * nothing (the failure `prune-apply.ts` documents for its round). The same
 * request over the same unit is the same event; the unit is content-addressed,
 * so two different requests cannot share one.
 *
 * A resolved unit still clears the two retention rules before it is scheduled
 * (ISSUE-519): a manual forget never targets the recall tool's own answer, and
 * never targets a result another live result already contains. The refusal
 * carries the marker, so the model reads why the bytes stay.
 */
export function decideForget(input: {
  readonly snapshot: SessionSnapshot;
  readonly sessionId: SessionId;
  readonly request: ForgetRequest;
  /** The mount's live items: the retention rules read them (ISSUE-519). */
  readonly live: readonly DshTranscriptItem[];
}): DshForgetDecision {
  const resolution = resolveForget({
    snapshot: input.snapshot, sessionId: input.sessionId, request: input.request,
  });
  if (resolution.status === 'refused') {
    return { status: 'refused', code: 'unresolved-request',
      reason: resolution.reason, detail: resolution.detail };
  }
  const retention = dshRetentionOf(resolution.unit.nodeId, input.live);
  if (retention !== null) return retentionRefusal(retention);
  return { status: 'scheduled', unitId: resolution.unit.id,
    eventId: forgetEventId(input.sessionId, resolution.unit.id, input.request),
    request: { ...input.request,
      ranges: input.request.ranges.map(range => ({ ...range })) },
    ranges: input.request.ranges.map(range => ({ ...range })) };
}

/** The refusal one retention verdict answers a manual forget with (ISSUE-519). */
export function retentionRefusal(verdict: DshRetentionVerdict): DshForgetRefusal {
  return { status: 'refused', code: verdict.code, reason: 'retained',
    detail: verdict.code === 'recall-answer-retained'
      ? "the unit is the necromancy tool's own answer; the product never removes its"
        + ' restore payload'
      : "the unit's exact result text is contained in the live result "
        + `${String(verdict.containedInNodeId)}` };
}
/** The one engine event id for a resolved forget request. */
export function forgetEventId(
  sessionId: SessionId, unitId: UnitId, request: ForgetRequest,
): EventId {
  const digest = sha256Sync(canonicalBytesWithByteArrays({
    sessionId, unitId, source: request.source, ranges: request.ranges,
  }));
  return `dsh:${sessionId}:forget:${digest}`;
}

/** The one refusal a build without the revert seam can give a manual forget. */
export function forgetUnavailable(): DshForgetRefusal {
  return { status: 'refused', code: 'unsupported-capability', reason: 'no-revert-seam',
    detail: 'A manual forget requires the programmatic revert seam' };
}

/**
 * The refusal a mount gives when the accepted request could not be made
 * durable (ISSUE-417). Answering "scheduled" would promise a removal an unload
 * can lose, so the tool says what it can prove: nothing was queued.
 */
export function forgetNotDurable(): DshForgetRefusal {
  return { status: 'refused', code: 'unsupported-capability', reason: 'not-durable',
    detail: 'the removal could not be made durable, so nothing was scheduled' };
}

/**
 * The answer value the model receives. Plain JSON by construction (the host
 * snapshots every tool value), and it echoes the caller's own spellings:
 * `startLine`/`endLine` as the spec declared them.
 */
export type DshForgetValue =
  | {
      readonly status: 'scheduled';
      readonly path: string;
      readonly ranges: readonly { readonly startLine: number; readonly endLine: number }[];
    }
  | {
      readonly status: 'refused';
      readonly code: 'unresolved-request' | 'unsupported-capability' | DshRetentionCode;
      readonly reason: 'malformed-request' | 'absent' | 'ambiguous' | 'no-revert-seam'
        | 'not-durable' | 'retained';
      readonly detail: string;
    };

export function forgetAnswer(decision: DshForgetDecision): DshForgetValue {
  if (decision.status === 'refused') {
    return { status: 'refused', code: decision.code, reason: decision.reason,
      detail: decision.detail };
  }
  return { status: 'scheduled', path: decision.request.source,
    ranges: decision.ranges.map(range => ({ startLine: range.startLine,
      endLine: range.endLineInclusive })) };
}

/**
 * The model-facing text of one forget answer. Terse and factual: it names what
 * was asked for and either the boundary the removal lands at or the refusal —
 * never a claim about bytes the host has not moved yet, and never a recap.
 */
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
  return `forget scheduled for ${path}${span}: the removal applies at the next step boundary`
    + ' if the guard approves it, and its receipt line then names the recall id.';
}
