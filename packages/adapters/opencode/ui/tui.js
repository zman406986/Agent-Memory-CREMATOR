/**
 * The terminal UI's CREMATOR surface (OpenCode 2.4.0, ISSUE-551, ADR-0073).
 *
 * The server part registers the `/cremate` command; this part puts it in the
 * prompt's slash menu and invokes it by name. OpenCode loads a package's `./tui`
 * export separately from its server part, so a server-only registration never
 * appears in the menu.
 *
 * The same part observes the manual pass: it subscribes to the RPC's lifecycle
 * events and shows started, ended and failed as toasts, keeps the last applied
 * pass in an in-memory store, and puts that pass (or the current context fill)
 * in the command's title. Reading the store and the routed session inside the
 * keymap factory is what makes the title update without a re-registration.
 */

import status from './status.cjs';

const BASE_TITLE = 'Cremate memory trash';

const EVENTS = Object.freeze({
  started: 'rpc.cremator-opencode.started',
  ended: 'rpc.cremator-opencode.ended',
  failed: 'rpc.cremator-opencode.failed',
  applied: 'rpc.cremator-opencode.applied',
});

/** One event's `data` object; an unexpected payload reads as empty, never throws. */
function payload(event) {
  if (event === null || typeof event !== 'object') return {};
  return event.data !== null && typeof event.data === 'object' ? event.data : {};
}

function words(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function whole(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The selected model's declared context window, or undefined when unknown. */
function modelLimit(context, session) {
  const selected = context.ui.model.current();
  if (selected === undefined) return undefined;
  const catalog = context.data.location.model.list(session === undefined ? undefined : session.location);
  if (catalog === undefined) return undefined;
  const match = catalog.find((entry) => entry !== null && typeof entry === 'object'
    && entry.providerID === selected.providerID
    && (entry.modelID === selected.modelID || entry.id === selected.modelID));
  if (match === undefined) return undefined;
  const limit = match.limit;
  const value = limit === null || typeof limit !== 'object' ? undefined : limit.context;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The command title: in-flight pass, then the last applied pass, then fill. */
function commandTitle(store, sessionID, fill) {
  if (store.running === true) return 'Cremating memory trash…';
  if (store.last !== null && store.last !== undefined) {
    return `${BASE_TITLE} · ${status.passLabel(store.last)}`;
  }
  if (sessionID !== null && fill.percent !== null) return `${BASE_TITLE} · ${fill.percent}% ctx`;
  return BASE_TITLE;
}

export default {
  id: 'cremator-opencode-tui',
  setup(context) {
    const [store, setStore] = context.storage.memory('cremator-status', {
      initial: { running: false, last: null, expectApplied: false },
    });

    const unsubscribe = [];

    unsubscribe.push(context.data.on(EVENTS.started, (event) => {
      const data = payload(event);
      // Only a manual pass is published on this channel; anything else is not ours.
      if (data.trigger !== 'manual') return;
      setStore((draft) => {
        draft.running = true;
        draft.expectApplied = true;
      });
      context.ui.toast.show({ message: 'Cremating memory trash…', variant: 'info' });
    }));

    unsubscribe.push(context.data.on(EVENTS.ended, (event) => {
      const data = payload(event);
      setStore((draft) => {
        draft.running = false;
      });
      if (data.fired === true) {
        context.ui.toast.show({
          message: `Cremation asked ${whole(data.rows)} row(s); removals apply at the next step.`,
          variant: 'info',
        });
        return;
      }
      context.ui.toast.show({
        message: status.refusalText(words(data.reason, 'no-fire')),
        variant: 'info',
      });
    }));

    unsubscribe.push(context.data.on(EVENTS.failed, (event) => {
      const data = payload(event);
      setStore((draft) => {
        draft.running = false;
        draft.expectApplied = false;
      });
      // A refusal is a normal outcome, not an error: "no rows" means the pass
      // ran and found nothing. Only the thrown-pass reason is a failure.
      const reason = words(data.reason, 'no reason given');
      const failure = reason === 'error';
      context.ui.toast.show({
        message: failure ? 'Cremation failed.' : status.refusalText(reason),
        variant: failure ? 'error' : 'info',
      });
    }));

    unsubscribe.push(context.data.on(EVENTS.applied, (event) => {
      const data = payload(event);
      const expected = store.expectApplied === true;
      const last = { removals: whole(data.removals), bytes: whole(data.bytes) };
      setStore((draft) => {
        draft.last = last;
        draft.expectApplied = false;
      });
      // An auto pass applies too; only a pass the user asked for is announced.
      if (!expected) return;
      context.ui.toast.show({ message: `Removed ${status.passLabel(last)}.`, variant: 'success' });
    }));

    context.keymap.layer(() => {
      const route = context.ui.router.current();
      const sessionID = route.type === 'session' ? route.sessionID : null;
      const session = sessionID === null ? undefined : context.data.session.get(sessionID);
      const boundary = session === undefined || session.revert === undefined
        ? undefined
        : session.revert.messageID;
      const fill = status.contextStatus({
        messages: sessionID === null ? [] : context.data.session.message.list(sessionID),
        limit: modelLimit(context, session),
        boundary,
      });
      return {
        mode: 'global',
        commands: [{
          id: 'cremator-opencode.cremate',
          title: commandTitle(store, sessionID, fill),
          description: 'Run one CREMATOR table pass now.',
          group: 'CREMATOR',
          palette: true,
          slash: { name: 'cremate' },
          run: async () => {
            const current = context.ui.router.current();
            if (current.type !== 'session') {
              context.ui.toast.show({ message: 'Open a session first.' });
              return;
            }
            try {
              await context.client.rpc.call({
                rpcID: 'cremator-opencode',
                method: 'cremate',
                input: { sessionID: current.sessionID },
              });
            } catch (error) {
              context.ui.toast.show({
                message: `Cremation failed: ${error instanceof Error ? error.message : String(error)}`,
                variant: 'error',
              });
            }
          },
        }],
      };
    });

    return () => {
      for (const off of unsubscribe) off();
    };
  },
};
