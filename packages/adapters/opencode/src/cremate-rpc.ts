/**
 * The RPC contract the desktop and terminal menu parts call (OpenCode 2.4.0).
 *
 * A plugin command registered through `context.command.transform` is scoped to
 * the server's own location; a session opened in another folder gets an empty
 * command list and `session.command` answers 404 (`command not found`). The RPC
 * service is server-wide, so the menu parts call this instead. The handler runs
 * the same manual table pass the `/cremate` command runs.
 *
 * ADR-0073: the definition also declares the pass lifecycle events the menu
 * parts subscribe to. Each event's payload is the JSON schema the host's
 * `events.emit` call validates against; the mount publishes the events, the
 * parts only render them.
 */

/** Stable contract id; the menu parts call it by this string. */
export const CREMATE_RPC_ID = 'cremator-opencode';

/** The one method: run the manual pass for a session. */
export const CREMATE_RPC_METHOD = 'cremate';

/** The manual pass began; emitted before the table's model call. */
export const CREMATE_RPC_EVENT_STARTED = 'started';

/** The manual pass ended; emitted after the ask for every pass that reached the table. */
export const CREMATE_RPC_EVENT_ENDED = 'ended';

/** The manual pass was refused or threw; emitted instead of `started`/`ended`. */
export const CREMATE_RPC_EVENT_FAILED = 'failed';

/** An apply landed removals new to this pass; never a re-application. */
export const CREMATE_RPC_EVENT_APPLIED = 'applied';

/** The payload field names the events and the method output share. */
export const CREMATE_RPC_FIELD_SESSION_ID = 'sessionID';
export const CREMATE_RPC_FIELD_TRIGGER = 'trigger';
export const CREMATE_RPC_FIELD_FIRED = 'fired';
export const CREMATE_RPC_FIELD_REASON = 'reason';
export const CREMATE_RPC_FIELD_ROWS = 'rows';
export const CREMATE_RPC_FIELD_REMOVALS = 'removals';
export const CREMATE_RPC_FIELD_BYTES = 'bytes';

/** The one manual trigger the `started` event names. */
export const CREMATE_RPC_TRIGGER_MANUAL = 'manual';

/** One event's payload schema, sharing the `sessionID` field. */
function sessionEvent(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    properties: Object.freeze({
      [CREMATE_RPC_FIELD_SESSION_ID]: Object.freeze({ type: 'string' }),
      ...properties,
    }),
    required: Object.freeze([CREMATE_RPC_FIELD_SESSION_ID, ...required]),
    additionalProperties: false,
  });
}

/** The portable definition the host's RPC service registers. */
export const CREMATE_RPC_DEFINITION = Object.freeze({
  id: CREMATE_RPC_ID,
  methods: {
    [CREMATE_RPC_METHOD]: {
      input: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          [CREMATE_RPC_FIELD_SESSION_ID]: Object.freeze({ type: 'string' }),
        }),
        required: Object.freeze([CREMATE_RPC_FIELD_SESSION_ID]),
        additionalProperties: false,
      }),
      output: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          ok: Object.freeze({ type: 'boolean' }),
          [CREMATE_RPC_FIELD_FIRED]: Object.freeze({ type: 'boolean' }),
          [CREMATE_RPC_FIELD_REASON]: Object.freeze({ type: 'string' }),
          [CREMATE_RPC_FIELD_ROWS]: Object.freeze({ type: 'integer' }),
        }),
        required: Object.freeze(['ok']),
        additionalProperties: false,
      }),
    },
  },
  /**
   * 2.4.0's definition shape: each event is `{ schema }`, a JSON schema over an
   * object payload (`Rpc.PortableDefinition.events` in `@opencode/schema`).
   */
  events: Object.freeze({
    [CREMATE_RPC_EVENT_STARTED]: Object.freeze({
      schema: sessionEvent({
        [CREMATE_RPC_FIELD_TRIGGER]: Object.freeze({
          type: 'string', enum: Object.freeze([CREMATE_RPC_TRIGGER_MANUAL]),
        }),
      }, [CREMATE_RPC_FIELD_TRIGGER]),
    }),
    [CREMATE_RPC_EVENT_ENDED]: Object.freeze({
      schema: sessionEvent({
        [CREMATE_RPC_FIELD_FIRED]: Object.freeze({ type: 'boolean' }),
        [CREMATE_RPC_FIELD_REASON]: Object.freeze({ type: 'string' }),
        [CREMATE_RPC_FIELD_ROWS]: Object.freeze({ type: 'integer' }),
      }, [CREMATE_RPC_FIELD_FIRED, CREMATE_RPC_FIELD_REASON, CREMATE_RPC_FIELD_ROWS]),
    }),
    [CREMATE_RPC_EVENT_FAILED]: Object.freeze({
      schema: sessionEvent({
        [CREMATE_RPC_FIELD_REASON]: Object.freeze({ type: 'string' }),
      }, [CREMATE_RPC_FIELD_REASON]),
    }),
    [CREMATE_RPC_EVENT_APPLIED]: Object.freeze({
      schema: sessionEvent({
        [CREMATE_RPC_FIELD_REMOVALS]: Object.freeze({ type: 'integer' }),
        [CREMATE_RPC_FIELD_BYTES]: Object.freeze({ type: 'integer' }),
      }, [CREMATE_RPC_FIELD_REMOVALS, CREMATE_RPC_FIELD_BYTES]),
    }),
  }),
});
