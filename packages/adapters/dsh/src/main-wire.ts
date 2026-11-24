/**
 * Capturing main's outgoing request (ISSUE-026 chunk 3, ADR-0010).
 *
 * What this seam sees, stated exactly: the host's `llm/stream` waterfall hands a
 * listener the request OBJECT the runtime is about to dispatch — the object the
 * agent loop assembled, deep-frozen when the loop built it — before the provider
 * adapter maps it to an HTTP body. It does NOT hand over those HTTP bytes, and
 * no code in this package ever sees them. So the capture is the dispatched
 * request, not the provider wire: system, tools and messages in the exact object
 * the runtime received, before any adapter reshaping (role merging, tool-role
 * rewriting, header assembly). A capture point at the adapter boundary is what
 * would make this byte-exact; `captureMainRequest` is the one function such a
 * point would replace.
 *
 * The shape taken from that object:
 *
 * - `system` is the request's own system slot, copied as it stands — empty when
 *   the caller set none. A loop-built request carries its prompt as the leading
 *   `system`-role message; that message STAYS a message at index 0, so the
 *   fork's list starts where main's did. The old capture lifted it into the slot
 *   and dropped it from the list, which diverged at the first message
 *   (CRITIC-026 chunk B).
 * - `tools` is the request's tool schema list, copied whole.
 * - every message whose role is `system`, `user`, `assistant` or `tool` stays a
 *   message, in order: its text blocks joined, a tool-call block rendered as one
 *   bracketed line. Non-text blocks and roles the fork cannot carry (`developer`,
 *   anything unknown) are counted as dropped, never invented.
 *
 * A request this package sent itself (an entry or a prune ask) is skipped: it is
 * not main, and seeding from it would replay the wrong conversation.
 *
 * So is a request the host stamped with an auxiliary `purpose` (ISSUE-031,
 * ISSUE-553): a session-title call, and the host's own compaction request
 * (`purpose: 'compaction'`), are second requests on the same session, not
 * main's conversation. Taking one as main's last request seeds the next fork
 * from that prompt instead of the conversation. Only an absent purpose (or an
 * explicit `'main'`) is main's lane; skipping an auxiliary call leaves the
 * previous main request in place, and a session that has sent only auxiliary
 * requests has no seed at all.
 */
import type { Sha256, WireMessage, WireRequest, WireTool } from '@cremator/core';
import { wireRequestHash } from '@cremator/core';
import { isRacoonsAskRequest } from './llm-ask.js';

/** One captured request, plus what the capture had to drop to shape it. */
export interface CapturedMainRequest {
  readonly wire: WireRequest;
  readonly seedHash: Sha256;
  /**
   * Always false since CRITIC-026 chunk B: the capture no longer lifts a leading
   * `system` message into the slot, so the slot never comes from a message. Kept
   * because the `prune-seed` journal line names it.
   */
  readonly systemFromMessage: boolean;
  readonly droppedMessages: number;
  readonly droppedBlocks: number;
  /**
   * The route this request was dispatched under, when the host names one
   * (ISSUE-432). The seed is a message list, but a mid-session model switch
   * makes a captured prefix belong to the old model; both ask lanes compare
   * these against the live route and refuse a stale seed by name instead of
   * serving it silently (ISSUE-432, ISSUE-470). `null` means the request stated
   * no provider/model.
   */
  readonly provider: string | null;
  readonly model: string | null;
}

/**
 * True when a capture names a route the live route contradicts (ISSUE-432,
 * ISSUE-470). One rule for both ask lanes: a capture that states no route (an
 * older host) stays usable, because absence is not evidence.
 */
export function seedRouteStale(captured: CapturedMainRequest,
  route: { readonly provider: string; readonly model: string } | null): boolean {
  if (route === null) return false;
  return (captured.provider !== null && captured.provider !== route.provider)
    || (captured.model !== null && captured.model !== route.model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One message's text, block by block, counting what the fork cannot carry. */
function messageText(content: unknown): { text: string; dropped: number } {
  // A plain string body is one text part, the shape `wire-request.ts` also
  // accepts; the fork carries it as the turn's text (ISSUE-566).
  if (typeof content === 'string') return { text: content, dropped: 0 };
  if (!Array.isArray(content)) return { text: '', dropped: 0 };
  const parts: string[] = [];
  let dropped = 0;
  for (const block of content) {
    if (!isRecord(block)) { dropped += 1; continue; }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
      continue;
    }
    if (block['type'] === 'tool-call') {
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
      const raw = block['arguments'];
      // Non-string arguments are serialized so the payload is never silently
      // lost (ISSUE-352); a payload JSON cannot carry is counted as dropped.
      let args: string | undefined;
      if (typeof raw === 'string') args = raw;
      else if (raw === undefined) args = '';
      else { try { args = JSON.stringify(raw); } catch { args = undefined; } }
      if (args === undefined) { dropped += 1; continue; }
      parts.push(`[tool call ${name} ${args}]`);
      continue;
    }
    dropped += 1;
  }
  return { text: parts.join(''), dropped };
}

/** The roles the seed carries as messages, copied where main put them. */
const SEED_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Main's role, copied verbatim. The fork's `WireMessage` role is the ask
 * history's vocabulary — `user`, `assistant`, `tool` — and has no `system`,
 * while main's list can carry one. Nothing in the fork reads a role on seed (it
 * copies and hashes the message) and the send seam passes the role through, so
 * this is a type-level narrowing, not a reshape: widening the core role union is
 * a separate change.
 */
function seedRole(role: string): WireMessage['role'] {
  return role as WireMessage['role'];
}

/**
 * Normalize one outgoing request into the fork's seed shape, or `null` when the
 * value is not a shaped request at all. The hash is taken over exactly the
 * three fields the fork copies, so bookkeeping keys cannot move it.
 */
export function captureMainRequest(options: unknown): CapturedMainRequest | null {
  if (!isRecord(options)) return null;
  if (isRacoonsAskRequest(options)) return null;
  // dsh stamps an auxiliary call with the purpose it serves; only the main
  // conversation may become the fork's seed. A session-title call (ISSUE-031)
  // and the host's own compaction request (`purpose: 'compaction'`, ISSUE-553)
  // are not main's conversation: taking one as main's last request seeds the
  // next ask from that prompt instead of the conversation. Absent (or an
  // explicit `main`) is the main lane.
  const purpose = options['purpose'];
  if (purpose !== undefined && purpose !== null && purpose !== 'main') return null;
  const messages = options['messages'];
  if (!Array.isArray(messages)) return null;
  const tools = Array.isArray(options['tools'])
    ? (options['tools'] as unknown[]).filter(isRecord) as unknown as WireTool[] : [];
  const system = typeof options['system'] === 'string' ? options['system'] : '';
  let droppedMessages = 0;
  let droppedBlocks = 0;
  const turns: WireMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) { droppedMessages += 1; continue; }
    const role = message['role'];
    // A `system`-role message is main's prompt or main's state; either way it
    // stays a message in the list. The raw list is preserved: no lift, no drop.
    if (typeof role !== 'string' || !SEED_ROLES.has(role)) {
      droppedMessages += 1;
      continue;
    }
    const read = messageText(message['content']);
    droppedBlocks += read.dropped;
    turns.push({ role: seedRole(role), text: read.text });
  }
  const wire: WireRequest = { system, tools, messages: turns };
  return { wire, seedHash: wireRequestHash(wire), systemFromMessage: false,
    droppedMessages, droppedBlocks,
    provider: typeof options['provider'] === 'string' ? options['provider'] : null,
    model: typeof options['model'] === 'string' ? options['model'] : null };
}

/** The per-session store of the last request main dispatched. */
export interface MainWireCapture {
  /** Called from the `llm/stream` observer; a request this package sent is skipped. */
  note(options: unknown): void;
  /** The last captured request for a session, or null when none was seen. */
  last(sessionId: string): CapturedMainRequest | null;
  /**
   * Drop a session's capture when the session ends or its mount entry is
   * released (ISSUE-350), so the store tracks live sessions, not every session
   * ever seen. Lifecycle eviction, not a size cap (ADR-0060). An id never seen
   * is a no-op.
   */
  evict(sessionId: string): void;
  /**
   * Every session id the store holds a capture for (ISSUE-455). The mount's
   * shutdown enumerates its per-session maps, and a request seen before any
   * `session/event` exists only here; without this the id escaped eviction.
   */
  sessionIds(): string[];
}

/**
 * A capture store keyed by the session id the request was stamped with. The
 * loop stamps every main request, so the map holds one entry per conversation.
 * A request with no session id is ignored: without the key, an ask could
 * only guess whose conversation it is holding.
 */
export function createMainWireCapture(): MainWireCapture {
  const bySession = new Map<string, CapturedMainRequest>();
  return {
    note(options) {
      const captured = captureMainRequest(options);
      if (captured === null) return;
      if (!isRecord(options)) return;
      const id = options['sessionId'];
      if (typeof id !== 'string' || id === '') return;
      bySession.set(id, captured);
    },
    last(sessionId) {
      return bySession.get(sessionId) ?? null;
    },
    evict(sessionId) {
      bySession.delete(sessionId);
    },
    sessionIds() {
      return [...bySession.keys()];
    },
  };
}
