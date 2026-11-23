/**
 * The `/cremate` host command (ADR-0068, ISSUE-526).
 *
 * The host command handler is async and may appends at the command boundary, so
 * the registered command runs the pass directly: it awaits the mount's
 * `runPrune` and returns the outcome in the command card. The typed `/cremate`
 * user message keeps the older path — mark the session and let the next
 * `agent/pre-step`, already an at-rest boundary, run the pass.
 *
 * Structural only: this module imports no dsh package. The one host type it
 * names is the adapter's own session slice, imported type-only.
 */
import { PRUNE_COMMAND } from './prune-record.js';
import type { DshMountSession } from './plugin.js';

/** The host command name, without the leading slash. */
export const CREMATE_COMMAND_NAME = 'cremate';

/** One line the host command menu shows. */
export const CREMATE_COMMAND_DESCRIPTION = 'Remove memory trash now.';

/** The queued command card's result line (the typed-message fallback). */
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
  handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}

/** What the host hands a command handler. */
export interface DshCommandInvocation {
  readonly rawInput?: string;
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

export interface CremateCommandOptions {
  /** Record one manual prune request for this session; the next pre-step runs it. */
  request(sessionId: string, seq: number | undefined): void;
  /**
   * Run the pass directly from the command handler. Present on the shipped
   * mount; absent in a stub host, where the handler falls back to the queued
   * typed-message path.
   */
  run?(session: DshMountSession): Promise<DshCommandResult>;
}

/** A unique-enough message id for the turn the queued path opens. */
let turnOrdinal = 0;

/**
 * Build the `/cremate` command. With `run`, the handler awaits the pass and the
 * command card carries its outcome. Without `run`, it records the request and
 * opens a `/cremate` turn, so the next pre-step runs it; the message listener's
 * own request is idempotent.
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
      if (options.run !== undefined) {
        try {
          return await options.run(session);
        } catch (error) {
          return {
            kind: 'error',
            text: `Cremation failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
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
