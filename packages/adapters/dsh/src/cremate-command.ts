/**
 * The `/cremate` host command (ADR-0068, ISSUE-529, ISSUE-535).
 *
 * A command handler runs outside an agent turn, and the host's session format
 * rejects a `tool/result` surface replacement with no open turn
 * (`SessionFormatError: tool/result is outside an open turn`); a direct run on
 * 2026-11-23 corrupted session `0cc53aca`. The host offers no way to open a
 * turn from a handler, and its idle maintenance phase opens none either, so the
 * command takes the one legal route: it registers the pass request, queues a
 * CREMATOR-owned marker message with `agent.followup` (a real host turn, the
 * same seam dsh's goal-round driver uses), and awaits the pass the marker
 * turn's `agent/pre-step` runs inside that open turn. The handler then returns
 * the outcome card, so the card is direct even though the append is in-turn.
 *
 * The marker message never reaches the model: the mount rejects the marker
 * step, which drops the claimed message and sends no request (dsh's own
 * `/compact` also opens no normal turn). Its `source.commandId` carries the
 * initiating command, the role `sourceCommandId` plays for native compaction.
 *
 * Structural only: this module imports no dsh package. The one host type it
 * names is the adapter's own session slice, imported type-only.
 */
import { messageOf } from './llm-ask.js';
import type { DshMountSession } from './plugin.js';

/** The host command name, without the leading slash. */
export const CREMATE_COMMAND_NAME = 'cremate';

/** One line the host command menu shows. */
export const CREMATE_COMMAND_DESCRIPTION = 'Remove memory trash now.';

/**
 * The source kind of the marker message that opens the command's turn. The
 * host's `MessageSourceMap` is merge-extensible, so a plugin-owned kind is a
 * supported attribution (dsh's goal-round driver uses its own `goal` kind).
 * It is never a `/cremate` user message, so the typed trigger cannot see it.
 */
export const CREMATE_MESSAGE_SOURCE = 'cremator';

/** The marker message's text; it never reaches the model-visible surface. */
export const CREMATE_TURN_TEXT = 'cremator: cremate';

/** The refusal when the host invocation names no live session. */
export const CREMATE_NO_SESSION =
  'Could not find this chat. Run /cremate from a live session.';

/** The failure when the host cannot queue the marker turn. */
export const CREMATE_NO_FOLLOWUP = 'this host cannot open the turn the pass needs';

/** The failure when the command's own request is cancelled. */
export const CREMATE_CANCELLED = 'the command was cancelled before the pass ran';

/** The card prefix every failure carries. */
export const CREMATE_FAILED_PREFIX = 'Cremation failed: ';

/** One pass's outcome as the command card reports it. */
export type CrematePassResult =
  | { readonly status: 'finished'; readonly removed: number }
  | { readonly status: 'failed'; readonly message: string };

/** The command's one-shot wait for its pass. */
export interface CremateWait {
  readonly result: Promise<CrematePassResult>;
  /** Stop waiting; the pass may still run, it just has no card. */
  abandon(message: string): void;
}

/** The host command registry's registration shape. */
export interface DshCommandRegistry {
  register(command: DshCommand): () => void;
}

/** One command definition as the host registry accepts it. */
export interface DshCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint?: string };
  handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}

/** What the host hands a command handler. */
export interface DshCommandInvocation {
  readonly rawInput?: string;
  /** The pairing id the host minted for this invocation's lifecycle events. */
  readonly commandId?: string;
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal?: AbortSignal;
  readonly agent?: {
    readonly session?: DshMountSession;
    followup?(message: unknown): unknown;
  };
}

/** What a command handler returns. */
export interface DshCommandResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** One command invocation's marker message, recognised at the turn's pre-step. */
export interface CremateMarker {
  readonly id: string;
  readonly commandId?: string;
}

export interface CremateCommandOptions {
  /**
   * Register this command invocation's pass request and return its waiter.
   * The request runs only in the turn that claims `messageId`, so the command
   * card reports that pass and no other.
   */
  begin(sessionId: string, messageId: string, commandId: string | undefined): CremateWait;
  /** Drop the request when the turn could not be opened or was cancelled. */
  cancel(sessionId: string, messageId: string, message: string): void;
}

/** A unique-enough message id for the turn the command opens. */
let turnOrdinal = 0;

/** The card one settled pass produces. */
export function cremateCardFor(result: CrematePassResult): DshCommandResult {
  if (result.status === 'failed') {
    return { kind: 'error', text: `${CREMATE_FAILED_PREFIX}${result.message}` };
  }
  if (result.removed === 0) {
    return { kind: 'success', text: 'Cremation finished; nothing removed.' };
  }
  return {
    kind: 'success',
    text: `Cremation finished; ${String(result.removed)} result`
      + `${result.removed === 1 ? '' : 's'} removed.`,
  };
}

/** Whether one value names a CREMATOR command marker, and its identity. */
export function cremateMarkerOf(messages: readonly unknown[] | undefined): CremateMarker | undefined {
  for (const message of messages ?? []) {
    if (!isRecord(message)) continue;
    const source = message['source'];
    if (!isRecord(source) || source['kind'] !== CREMATE_MESSAGE_SOURCE) continue;
    const id = message['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const commandId = source['commandId'];
    return { id, ...(typeof commandId === 'string' ? { commandId } : {}) };
  }
  return undefined;
}

/**
 * Build the `/cremate` command. The handler records its request, opens the
 * marker turn, and awaits the pass that turn's pre-step runs; the card carries
 * the pass's own outcome.
 */
export function createCremateCommand(options: CremateCommandOptions): DshCommand {
  return {
    name: CREMATE_COMMAND_NAME,
    description: CREMATE_COMMAND_DESCRIPTION,
    async handler(invocation) {
      const session = invocation.agent?.session;
      if (session === undefined) {
        return { kind: 'error', text: CREMATE_NO_SESSION };
      }
      const agent = invocation.agent;
      const followup = agent?.followup;
      if (agent === undefined || typeof followup !== 'function') {
        return { kind: 'error', text: `${CREMATE_FAILED_PREFIX}${CREMATE_NO_FOLLOWUP}.` };
      }
      const sessionId = String(session.id);
      const commandId = typeof invocation.commandId === 'string'
        ? invocation.commandId : undefined;
      turnOrdinal += 1;
      const message: {
        id: string; role: 'user'; content: { type: 'text'; text: string }[];
        source: { kind: string; commandId?: string };
      } = {
        id: `cremator-cremate-${String(Date.now())}-${String(turnOrdinal)}`,
        role: 'user',
        content: [{ type: 'text', text: CREMATE_TURN_TEXT }],
        // The marker's attribution is the command identity, the same
        // correlation native compaction records as `sourceCommandId`.
        source: { kind: CREMATE_MESSAGE_SOURCE,
          ...(commandId === undefined ? {} : { commandId }) },
      };
      const wait = options.begin(sessionId, message.id, commandId);
      try {
        // Call on the agent: the host method uses `this.send`.
        await followup.call(agent, message);
      } catch (error) {
        const failure = `could not open the cremation turn: ${messageOf(error)}`;
        options.cancel(sessionId, message.id, failure);
        return { kind: 'error', text: `${CREMATE_FAILED_PREFIX}${failure}` };
      }
      return cremateCardFor(await waitOrAbort(wait, invocation.signal));
    },
  };
}

/**
 * The pass's outcome, or the named failure of the wait itself. An abort
 * abandons the request so the queued marker turn runs no pass; the handler
 * still returns a card instead of hanging.
 */
function waitOrAbort(wait: CremateWait, signal: AbortSignal | undefined,
): Promise<CrematePassResult> {
  const pending = wait.result.catch(
    (error: unknown): CrematePassResult => ({ status: 'failed', message: messageOf(error) }));
  if (signal === undefined) return pending;
  if (signal.aborted) {
    wait.abandon(CREMATE_CANCELLED);
    return Promise.resolve({ status: 'failed', message: CREMATE_CANCELLED });
  }
  return new Promise<CrematePassResult>((resolve) => {
    let settled = false;
    const done = (result: CrematePassResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      wait.abandon(CREMATE_CANCELLED);
      done({ status: 'failed', message: CREMATE_CANCELLED });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(done);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
