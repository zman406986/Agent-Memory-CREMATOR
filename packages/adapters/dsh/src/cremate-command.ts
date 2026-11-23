/**
 * The `/cremate` host command (ADR-0068, ISSUE-526).
 *
 * The command is a menu shortcut for the trigger the mount already owns: mark
 * the invoking session for one prune pass and open a user turn carrying the
 * same `/cremate` text. The mount's `session/event` listener sees that message,
 * the marker is already present, and the next `agent/pre-step` runs the pass.
 *
 * Structural only: this module imports no dsh package. The host types below are
 * the slice dsh's command registry and invocation expose.
 */
import { PRUNE_COMMAND } from './prune-record.js';

/** The host command name, without the leading slash. */
export const CREMATE_COMMAND_NAME = 'cremate';

/** One line the host command menu shows. */
export const CREMATE_COMMAND_DESCRIPTION = 'Remove memory trash now.';

/** The command card's result line. */
export const CREMATE_COMMAND_CARD_TEXT = 'Cremation requested; it runs at the next step.';

/** The refusal when the host invocation names no live session. */
export const CREMATE_NO_SESSION =
  'Could not find this chat. Run /cremate from a live session.';

/** The host command registry's registration shape. */
export interface DshCommandRegistry {
  register(command: DshCommand): () => void;
}

/** One command definition as the host registry accepts it. */
export interface DshCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint?: string };
  handler(invocation: DshCommandInvocation): DshCommandResult;
}

/** What the host hands a command handler. */
export interface DshCommandInvocation {
  readonly rawInput?: string;
  readonly agent?: {
    readonly session?: { readonly id: string; readonly seq?: number };
    followup?(message: unknown): unknown;
  };
}

/** What a command handler returns. */
export interface DshCommandResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

export interface CremateCommandOptions {
  /** Record one manual prune request for this session; the next pre-step runs it. */
  request(sessionId: string, seq: number | undefined): void;
}

/** A unique-enough message id for the turn this command opens. */
let turnOrdinal = 0;

/**
 * Build the `/cremate` command. The handler records the request BEFORE opening
 * the turn, so a host whose followup fails still has the marker for the next
 * boundary; the message listener's own request is idempotent.
 */
export function createCremateCommand(options: CremateCommandOptions): DshCommand {
  return {
    name: CREMATE_COMMAND_NAME,
    description: CREMATE_COMMAND_DESCRIPTION,
    handler(invocation) {
      const session = invocation.agent?.session;
      if (session === undefined) {
        return { kind: 'error', text: CREMATE_NO_SESSION };
      }
      const sessionId = String(session.id);
      options.request(sessionId, session.seq);
      try {
        const followup = invocation.agent?.followup;
        if (typeof followup === 'function') {
          turnOrdinal += 1;
          // The same text a user would type. The mount's observer marks the
          // request again, sees the marker, and journals nothing.
          void Promise.resolve(followup({
            id: `cremator-cremate-${String(Date.now())}-${String(turnOrdinal)}`,
            role: 'user',
            content: [{ type: 'text', text: PRUNE_COMMAND }],
            source: { kind: 'user' },
          })).catch(() => { /* the request still stands */ });
        }
      } catch {
        // A broken followup never turns the recorded request into a failure.
      }
      return { kind: 'success', text: CREMATE_COMMAND_CARD_TEXT };
    },
  };
}
