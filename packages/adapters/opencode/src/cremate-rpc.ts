/**
 * The RPC contract the desktop and terminal menu parts call (OpenCode 2.4.0).
 *
 * A plugin command registered through `context.command.transform` is scoped to
 * the server's own location; a session opened in another folder gets an empty
 * command list and `session.command` answers 404 (`command not found`). The RPC
 * service is server-wide, so the menu parts call this instead. The handler runs
 * the same manual table pass the `/cremate` command runs.
 */

/** Stable contract id; the menu parts call it by this string. */
export const CREMATE_RPC_ID = 'cremator-opencode';

/** The one method: run the manual pass for a session. */
export const CREMATE_RPC_METHOD = 'cremate';

/** The portable definition the host's RPC service registers. */
export const CREMATE_RPC_DEFINITION = Object.freeze({
  id: CREMATE_RPC_ID,
  methods: {
    [CREMATE_RPC_METHOD]: {
      input: Object.freeze({
        type: 'object',
        properties: Object.freeze({ sessionID: Object.freeze({ type: 'string' }) }),
        required: Object.freeze(['sessionID']),
        additionalProperties: false,
      }),
      output: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          ok: Object.freeze({ type: 'boolean' }),
          fired: Object.freeze({ type: 'boolean' }),
        }),
        required: Object.freeze(['ok']),
        additionalProperties: false,
      }),
    },
  },
  events: Object.freeze({}),
});
