/**
 * Step and ask usage → the core's reconciliation row (ISSUE-192; 2.4.0 seam
 * map; ISSUE-538).
 *
 * The main lane has exactly one per-request place where an authoritative count
 * exists: the `session.step.ended` event. Its `data` carries `{sessionID,
 * assistantMessageID, finish, cost, tokens}` and `tokens` is
 * `{input, output, reasoning, cache: {read, write}}` (`@opencode/schema@2.4.0`
 * `dist/event-manifest.d.ts`, `session.step.ended`; `TokenUsage.Info` has the
 * same shape). This module maps that event onto the core's `ApiUsage` and
 * nothing else; when the mount hands the value to `engine.observe` is the
 * mount's decision (`src/plugin.ts`).
 *
 * **The ask lane's reading is the `session.generate` answer.** 2.4.0 declares
 * the call's success body as `{data: {text, tokens, cost}}`
 * (`@opencode/protocol@2.4.0` `dist/groups/session.d.ts`,
 * `session.generate`); the plugin unwraps `data`, so the mount's own call
 * resolves to `{text, tokens, cost}`. Those are the exact cost and the same
 * four token counts a step row states, attributed by construction: the value
 * is the answer to the one ask this mount sent, so no request id is needed.
 *
 * **`session.usage.recorded` is deliberately not subscribed to.** 2.4.0
 * declares it with `source: "title" | "compaction" | "generate"` and data
 * `{sessionID, source, cost, tokens}`, but it is replay-only:
 * `session-event.js` publishes `UsageRecorded` in `DurableDefinitions`, not
 * `Definitions`, with the comment "Internal and replay-only events are
 * excluded from the public manifest". The plugin event hook is the public
 * stream (`@opencode/plugin`'s `EventDomain` is typed by
 * `EventSubscribeInput["types"]` / `EventSubscribeOutput`, neither of which
 * lists it); only `GET /api/experimental/session/:id/log` returns it, and the
 * plugin context exposes no session log. Requesting it on `event.subscribe`
 * would decode-fail the whole subscription, so the mount never asks for it.
 *
 * **`session.usage.updated` is deliberately not used.** It carries session
 * totals and no message id, so it cannot name the one request a reconciliation
 * row describes; using it would double count every step. The per-step event is
 * the only main row source; for the ask, the generate answer is.
 *
 * **The count arithmetic is the host's own contract, restated in the core's
 * terms.** `Session.getUsage()` subtracts the cached tokens from the prompt
 * count before publishing `tokens`, so the host's `input` is *non-cached input*:
 * `input, cache.read, cache.write` are three disjoint buckets of one prompt. The
 * core's `ApiUsage.inputTokens` is the whole prompt and `cachedInputTokens` is
 * the cached part OF it — `Meter.reconcile` refuses a cached count above the
 * input count and divides the share as `cachedInputTokens / inputTokens`. So the
 * three buckets are summed into `inputTokens`, and `cache.read + cache.write`
 * rides `cachedInputTokens` as one value.
 *
 * **Absent is not zero.** A row with no `tokens` object is `missing`; a row whose
 * counts are malformed is `invalid`. A row with `cache: {read: 0, write: 0}` is a
 * cold cache (`0`), which is a fact the host stated. A main row comes only from a
 * `session.step.ended` event and an ask row only from a `session.generate`
 * answer; nothing is reconstructed from the message array, which no longer
 * carries `step-finish` parts.
 *
 * `cost` is telemetry input only. It is carried for the journal and never
 * reaches `ApiUsage`, so no value of it can change a gate or a reconciliation.
 */

import { estimateContent } from '@cremator/core';
import type {
  ApiUsage, Meter, RequestPrefix, SessionSnapshot, UsageObservation,
} from '@cremator/core';

/** What one terminal row says the step's model call cost, in tokens. */
export interface OpencodeTokenReading {
  readonly kind: 'usage';
  readonly usage: ApiUsage;
  /** The host's reasoning count, carried for the journal; never added to `output`. */
  readonly reasoningTokens: number;
  /**
   * The host's two cache buckets, kept apart for the journal and the result
   * (ISSUE-300 item 8). `null` when the row carried no cache object: unknown,
   * never a cold cache.
   */
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export type OpencodeTokenRead =
  | OpencodeTokenReading
  | { readonly kind: 'missing'; readonly reason: 'no-tokens' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** One assistant step's accounting, as the mount journals it. */
export interface OpencodeUsageRow {
  readonly kind: 'usage';
  readonly messageId: string;
  readonly usage: ApiUsage;
  readonly reasoningTokens: number;
  /** Telemetry only: a number when the host stated a usable one, else null. */
  readonly costUsd: number | null;
  /** The host's cache read bucket; null when the row stated none. */
  readonly cacheReadTokens: number | null;
  /** The host's cache write bucket; null when the row stated none. */
  readonly cacheWriteTokens: number | null;
}

export type OpencodeStepUsageRow =
  | OpencodeUsageRow
  | { readonly kind: 'missing'; readonly messageId: string; readonly reason: 'no-tokens' }
  | { readonly kind: 'invalid'; readonly messageId: string; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A token count the core would accept, or null when the value is not one. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A cost the journal can print, or null. Malformed never invalidates a reading. */
export function costOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The host's `tokens` object → the core's `ApiUsage`, with the three input
 * buckets summed. `output` is the host's own completion count; `reasoning` is not
 * added to it because the host's shape does not state whether reasoning is
 * already inside `output`, and a reading must never claim more than the host said.
 */
export function tokenUsageOf(tokens: unknown): OpencodeTokenRead {
  if (tokens === undefined || tokens === null) return { kind: 'missing', reason: 'no-tokens' };
  if (!isRecord(tokens)) return { kind: 'invalid', reason: 'tokens is not an object' };
  const input = countOf(tokens['input']);
  const output = countOf(tokens['output']);
  if (input === null || output === null) {
    return { kind: 'invalid',
      reason: 'input and output must be non-negative safe integers' };
  }
  let reasoningTokens = 0;
  const reasoning = tokens['reasoning'];
  if (reasoning !== undefined && reasoning !== null) {
    const count = countOf(reasoning);
    if (count === null) {
      return { kind: 'invalid', reason: 'reasoning must be a non-negative safe integer' };
    }
    reasoningTokens = count;
  }
  const cache = tokens['cache'];
  if (cache === undefined || cache === null) {
    // Both cache counters absent is an unknown cache, never a cold one.
    return { kind: 'usage', reasoningTokens,
      usage: { inputTokens: input, outputTokens: output, cachedInputTokens: null },
      cacheReadTokens: null, cacheWriteTokens: null };
  }
  if (!isRecord(cache)) return { kind: 'invalid', reason: 'cache is not an object' };
  const cacheRead = countOf(cache['read']);
  const cacheWrite = countOf(cache['write']);
  if (cacheRead === null || cacheWrite === null) {
    return { kind: 'invalid',
      reason: 'cache.read and cache.write must be non-negative safe integers' };
  }
  const cached = cacheRead + cacheWrite;
  return { kind: 'usage', reasoningTokens,
    usage: { inputTokens: input + cached, outputTokens: output, cachedInputTokens: cached },
    cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

/**
 * The request kinds the bench-only ask produces, on either seam. A step row for
 * one of these is not a main turn and must never consume a main request's
 * pending estimate: the ask's `session.generate` call can end a step, and its
 * message id is not in the session's main transcript.
 */
export const ASK_STEP_REQUEST_KINDS: readonly string[] = Object.freeze(['ask', 'generate']);

/**
 * The request kind a `session.step.ended` row names, when the host states one.
 * 2.4.0's declared payload has no kind field, so this reads the open shape (and
 * the open `native` bag) without assuming it exists: an absent or unknown value
 * is `null`, which is a main request. A host that does not state a kind gets the
 * old accounting; a host that does state `generate`/`ask` gets the filter.
 */
export function stepRequestKindOf(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const read = (record: Readonly<Record<string, unknown>>): string | null => {
    for (const key of ['requestKind', 'request_kind', 'kind']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  };
  const direct = read(data);
  if (direct !== null) return direct;
  for (const key of ['native', 'request']) {
    const nested = data[key];
    if (isRecord(nested)) {
      const value = read(nested);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * The request kinds this mount accounts, declared once. 2.4.0's
 * `session.step.ended` payload does not declare a kind field; the mount reads
 * the open shape defensively and journals what it read. A host that states
 * `ask`/`generate` gets the ask filter; a host that states nothing is accounted
 * as a main turn (the shipped 2.4.0 shape), and the journal line says
 * `requestKind: 'unstated'` so the assumption is visible rather than implied
 * (ISSUE-300 item 16). The one exception is the mount's own nested ask: while
 * an ask is in flight, an unstated row is the ask lane's and never consumes a
 * main estimate (ISSUE-357; the guard lives in the mount's `feedStepEnded`).
 */
export type OpencodeRequestKind = 'main' | 'ask' | 'unstated';

/** The declared kind one step row's own field names, or `unstated`. */
export function requestKindOf(data: unknown): OpencodeRequestKind {
  const kind = stepRequestKindOf(data);
  if (kind === null) return 'unstated';
  return ASK_STEP_REQUEST_KINDS.includes(kind) ? 'ask' : 'main';
}

/** True when a step row names the bench-only ask, never a main turn. */
export function isAskStepRequest(data: unknown): boolean {
  return requestKindOf(data) === 'ask';
}

/**
 * One row for one `session.step.ended` event, or null when the event is not a
 * step row (no usable `assistantMessageID`). The event's `finish` is not read:
 * a step that ended with an error still states what it spent.
 */
export function stepEndedRow(data: unknown): OpencodeStepUsageRow | null {
  if (!isRecord(data)) return null;
  const messageId = data['assistantMessageID'];
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  const read = tokenUsageOf(data['tokens']);
  if (read.kind === 'usage') {
    return { kind: 'usage', messageId, usage: { ...read.usage },
      reasoningTokens: read.reasoningTokens, costUsd: costOf(data['cost']),
      cacheReadTokens: read.cacheReadTokens, cacheWriteTokens: read.cacheWriteTokens };
  }
  return read.kind === 'missing'
    ? { kind: 'missing', messageId, reason: read.reason }
    : { kind: 'invalid', messageId, reason: read.reason };
}

/**
 * One `session.generate` answer's own reading, or null when the host stated
 * none (ISSUE-538).
 *
 * The declared 2.4.0 shape is `{text, tokens, cost}`: `tokens` is the same
 * `{input, output, reasoning, cache: {read, write}}` object a step row carries,
 * so it maps through the same `tokenUsageOf` arithmetic, and `cost` is
 * telemetry only. `usage` is the open field an earlier host or a bench mock may
 * state instead (ISSUE-300 item 7); when both are usable the DECLARED `tokens`
 * wins, because that is the shape 2.4.0's endpoint promises. `askId` is the
 * mount's own ask identity, never a host message id: the generate request is a
 * transient call with no assistant message row.
 */
export function generateUsageRow(answer: unknown, askId: string): OpencodeUsageRow | null {
  if (!isRecord(answer)) return null;
  const declared = tokenUsageOf(answer['tokens']);
  const read = declared.kind === 'usage' ? declared : tokenUsageOf(answer['usage']);
  if (read.kind !== 'usage') return null;
  return {
    kind: 'usage', messageId: askId,
    usage: { ...read.usage }, reasoningTokens: read.reasoningTokens,
    costUsd: costOf(answer['cost']),
    cacheReadTokens: read.cacheReadTokens, cacheWriteTokens: read.cacheWriteTokens,
  };
}

/**
 * The observation the engine reconciles: `requestId` is the host's assistant
 * message id — one message is one model request — and `revision` is the port
 * snapshot the mount measured at its last context hook, so the reading names the
 * state the estimate belongs to.
 */
export function usageObservation(
  row: OpencodeUsageRow, revision: string, estimatedInputTokens: number,
): UsageObservation {
  return {
    kind: 'usage',
    requestId: row.messageId,
    revision,
    estimatedInputTokens,
    usage: { ...row.usage },
  };
}

/**
 * The fixed system + tool-schema prefix of the request the context hook is
 * assembling, in the shape core's estimator takes. `system` is the request's
 * own array (blocks or strings); `tools` is the request's tool table. Absent
 * both, the caller has no prefix and the estimate says `content` only.
 *
 * The bytes are the request's, not a re-render from config: the context hook
 * hands the request's own `system` and `tools` fields, so this prefix is what
 * the provider will receive beside the transcript.
 */
export function requestPrefixOf(
  context: { readonly system?: readonly unknown[]; readonly tools?: Readonly<Record<string, unknown>> },
): RequestPrefix | null {
  const system = Array.isArray(context.system) ? context.system : undefined;
  const tools = context.tools !== undefined && context.tools !== null
    ? Object.values(context.tools) : undefined;
  if (system === undefined && tools === undefined) return null;
  return {
    system: JSON.stringify(system ?? []),
    tools: tools ?? [],
  };
}

/**
 * The mount's whole-request estimate of the request the next step will send, in
 * tokens: the fixed system + tool-schema prefix plus every live transcript
 * node. The depth latch reads it before the first host usage row
 * (`observeDepth`), so a first request above the bar is not read as zero; after
 * the first usage row the host meter is authoritative.
 *
 * `prefix` is the request's own fixed part (`requestPrefixOf`). `null` means
 * the caller had none — the estimate is then transcript-only, and every journal
 * line that reports it says `content` rather than claiming the whole request
 * (ISSUE-300 item 10). It is the same `estimateContent` arithmetic the core's
 * gates use, so the meter's `estimateErrorTokens` measures the provider's count
 * against one estimator, not the drift between two.
 */
export function estimateRequestTokens(
  estimateMeter: Meter, snapshot: SessionSnapshot, prefix: RequestPrefix | null = null,
): number {
  return estimateContent(estimateMeter, snapshot, null, prefix).totalTokens;
}

/** The split form of the same estimate, so a journal can name both terms. */
export function estimateRequestSplit(
  estimateMeter: Meter, snapshot: SessionSnapshot, prefix: RequestPrefix | null = null,
): { readonly contentTokens: number; readonly prefixTokens: number; readonly totalTokens: number } {
  return estimateContent(estimateMeter, snapshot, null, prefix);
}
