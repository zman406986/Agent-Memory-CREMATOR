/**
 * The desktop app's CREMATOR surface (OpenCode 2.4.0, ISSUE-551, ADR-0073).
 *
 * Two contributions, both from this part:
 *   - the `/cremate` command, in the composer's slash menu;
 *   - a composer pill that shows context fill, the last applied pass, or the
 *     pass now in flight, with one row that runs the same RPC.
 *
 * OpenCode's desktop main process loads this file as CommonJS, so it must not
 * use `export` syntax. The `.js` twin beside it holds the same bytes because the
 * loader has asked for both names.
 *
 * `Command` and `ComposerPill` are the host's registry tokens. Each token is the
 * public `{ kind: 'registry', id }` shape; building one here keeps this part free
 * of a runtime import from the host SDK, so it loads before the desktop provides
 * that module.
 *
 * The pill subscribes to the RPC's lifecycle events lazily, once per server and
 * only when a composer asks for the pill. A guarded loop keeps retrying a closed
 * stream; one AbortController per server stops them all when the plugin goes
 * away. The store is window-local memory keyed by the session key, so two
 * sessions on two servers never share a pass.
 */

'use strict';

const status = require('./status.cjs');

const Command = Object.freeze({ kind: 'registry', id: 'command' });
const ComposerPill = Object.freeze({ kind: 'registry', id: 'composer-pill' });

const RPC_ID = 'cremator-opencode';
const RETRY_MS = 1000;
const EVENTS = Object.freeze([
  'rpc.cremator-opencode.started',
  'rpc.cremator-opencode.ended',
  'rpc.cremator-opencode.failed',
  'rpc.cremator-opencode.applied',
]);
const STARTED = EVENTS[0];
const ENDED = EVENTS[1];
const FAILED = EVENTS[2];
const APPLIED = EVENTS[3];

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

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** `client.rpc.call` answers `{ output }`; anything else reads as an empty payload. */
function outputOf(result) {
  if (result === null || typeof result !== 'object') return {};
  return result.output !== null && typeof result.output === 'object' ? result.output : {};
}

function entryOf(store, key) {
  const entry = store.byKey[key];
  return entry === null || typeof entry !== 'object' ? undefined : entry;
}

/** Edits one session's entry, creating the store slot the first time. */
function update(setStore, key, mutate) {
  setStore((draft) => {
    if (draft.byKey === null || typeof draft.byKey !== 'object') draft.byKey = {};
    const current = draft.byKey[key];
    if (current === null || typeof current !== 'object') {
      draft.byKey[key] = { running: false, failed: null, last: null };
    }
    mutate(draft.byKey[key]);
  });
}

function infoOf(data, sessionID) {
  const info = data.session.get(sessionID);
  return info === null || typeof info !== 'object' ? undefined : info;
}

/** The session's selected model's declared context window, or undefined. */
function limitOf(data, session, info) {
  const ref = info === undefined ? undefined : info.model;
  if (ref === null || typeof ref !== 'object') return undefined;
  const location = info.location !== null && typeof info.location === 'object' ? info.location : session.location;
  const catalog = data.location.model.list(location);
  if (catalog === undefined) return undefined;
  const match = catalog.find((entry) => entry !== null && typeof entry === 'object'
    && entry.providerID === ref.providerID
    && (entry.modelID === ref.id || entry.id === ref.id));
  if (match === undefined) return undefined;
  const limit = match.limit;
  const value = limit === null || typeof limit !== 'object' ? undefined : limit.context;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Context fill for the pill: the newest usage-bearing assistant step after the
 * last completed compaction and before the revert boundary, over the model's
 * window. All nulls when the host has not reported either yet.
 */
function fillOf(data, session, info) {
  const boundary = info === undefined || info.revert === undefined || info.revert === null
    ? undefined
    : info.revert.messageID;
  return status.contextStatus({
    messages: data.session.message.list(session.id),
    limit: limitOf(data, session, info),
    boundary,
  });
}

/** Applies one lifecycle event to the store; `failed` also raises a toast. */
function applyEvent(ctx, setStore, server, event) {
  if (event === null || typeof event !== 'object') return;
  const data = payload(event);
  if (typeof data.sessionID !== 'string' || data.sessionID === '') return;
  const key = `${server.id}\n${data.sessionID}`;
  if (event.type === STARTED) {
    update(setStore, key, (entry) => {
      entry.running = true;
      entry.failed = null;
    });
    return;
  }
  if (event.type === ENDED) {
    update(setStore, key, (entry) => {
      entry.running = false;
    });
    return;
  }
  if (event.type === FAILED) {
    const reason = words(data.reason, 'no reason given');
    update(setStore, key, (entry) => {
      entry.running = false;
      entry.failed = reason;
    });
    ctx.toast.show({
      title: 'CREMATOR',
      description: `Cremation failed: ${reason}.`,
      variant: 'error',
    });
    return;
  }
  if (event.type === APPLIED) {
    update(setStore, key, (entry) => {
      entry.running = false;
      entry.failed = null;
      entry.last = { removals: whole(data.removals), bytes: whole(data.bytes) };
    });
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Starts this server's event loop unless one is already running. The loop
 * tolerates a closed or refused stream and retries after a short wait; the pill
 * still renders from the store and the RPC reply meanwhile.
 */
function ensureLoop(ctx, setStore, loops, server) {
  if (loops.has(server.id)) return;
  const controller = new AbortController();
  loops.set(server.id, controller);
  const run = async () => {
    let wait = 0;
    while (!controller.signal.aborted) {
      if (wait > 0) await sleep(wait, controller.signal);
      if (controller.signal.aborted) break;
      try {
        const events = server.client.event.subscribe({ types: EVENTS, signal: controller.signal });
        for await (const event of events) {
          if (controller.signal.aborted) break;
          applyEvent(ctx, setStore, server, event);
        }
      } catch {
        // A closed or refused stream is retried; the pill does not depend on it.
      }
      wait = RETRY_MS;
    }
    if (loops.get(server.id) === controller) loops.delete(server.id);
  };
  void run();
}

/** Runs the manual pass for one session and records its typed result. */
function cremate(ctx, setStore, session) {
  update(setStore, session.key, (entry) => {
    entry.running = true;
    entry.failed = null;
  });
  session.server.client.rpc.call({
    rpcID: RPC_ID,
    method: 'cremate',
    input: { sessionID: session.id },
  }).then((result) => {
    const output = outputOf(result);
    const fired = output.fired === true;
    update(setStore, session.key, (entry) => {
      entry.running = false;
      entry.fired = fired;
      entry.reason = words(output.reason, fired ? 'table' : 'no-fire');
      entry.rows = whole(output.rows);
    });
  }).catch((error) => {
    const reason = reasonOf(error);
    update(setStore, session.key, (entry) => {
      entry.running = false;
      entry.failed = reason;
    });
    ctx.toast.show({
      title: 'CREMATOR',
      description: `Cremation failed: ${reason}.`,
      variant: 'error',
    });
  });
}

/** The pill's one view: label, tone and the row that runs the pass. */
function pillView(ctx, store, setStore, loops, input) {
  const session = input === null || typeof input !== 'object' ? undefined : input.session;
  if (session === null || typeof session !== 'object') return undefined;
  const data = session.server.data;
  ensureLoop(ctx, setStore, loops, session.server);

  const entry = entryOf(store, session.key);
  const running = entry !== undefined && entry.running === true;
  const failed = entry !== undefined && typeof entry.failed === 'string' ? entry.failed : null;
  const last = entry !== undefined && entry.last !== null && typeof entry.last === 'object' ? entry.last : null;
  const fill = fillOf(data, session, infoOf(data, session.id));

  let label;
  if (running) label = 'Cremating…';
  else if (last !== null) label = status.passLabel(last);
  else if (fill.percent !== null) label = `${fill.percent}% ctx`;
  else label = 'CREMATOR';

  const row = {
    id: 'cremate',
    label: 'Cremate now',
    run: () => cremate(ctx, setStore, session),
  };
  if (entry !== undefined && entry.fired === false && typeof entry.reason === 'string') {
    row.detail = entry.reason;
  }

  const view = { label, rows: [row] };
  if (label !== 'CREMATOR') view.title = 'CREMATOR';
  if (running) view.tone = 'warning';
  else if (failed !== null) view.tone = 'danger';
  else if (last !== null) view.tone = 'success';
  return view;
}

const plugin = {
  setup(ctx) {
    const [store, setStore] = ctx.storage.memory('cremator-status', { initial: { byKey: {} } });
    const loops = new Map();

    const removeCommand = ctx.add(Command, () => ({
      id: 'cremate',
      title: 'Cremate memory trash',
      description: 'Remove provably useless parts of this chat now.',
      keywords: 'memory context remove prune',
      group: 'CREMATOR',
      section: 'session',
      slash: { name: 'cremate' },
      run() {
        const session = ctx.sessions.current();
        if (session === undefined) return false;
        cremate(ctx, setStore, session);
        return undefined;
      },
    }));

    const removePill = ctx.add(ComposerPill, () => ({
      id: 'cremator-status',
      order: 10,
      show(input) {
        return pillView(ctx, store, setStore, loops, input);
      },
    }));

    return () => {
      removeCommand();
      removePill();
      for (const controller of loops.values()) controller.abort();
      loops.clear();
    };
  },
};

module.exports = plugin;
// The host accepts either a CommonJS module object or its `default`; expose
// both so the loader's interop does not depend on which shape it reads.
module.exports.default = plugin;
