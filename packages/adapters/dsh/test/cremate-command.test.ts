/**
 * The `/cremate` host command and the dsh bundle manifest (ADR-0068,
 * ISSUE-526, ISSUE-535).
 *
 * The command factory is pure: the handler records its request, opens the
 * marker turn, and reports the pass that turn settles. The mount's typed
 * request marker is tested directly; plugin apply is tested with a stub
 * context that carries the host command registry. The manifest test pins the
 * shipped bundle route so a later edit cannot silently drop it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CREMATE_COMMAND_DESCRIPTION, CREMATE_COMMAND_NAME, CREMATE_FAILED_PREFIX,
  CREMATE_MESSAGE_SOURCE, CREMATE_NO_SESSION, createCremateCommand,
} from '../src/cremate-command.js';
import type { CrematePassResult, CremateWait, DshCommand } from '../src/cremate-command.js';
import {
  createRacoonsMount, createRacoonsPlugin, resolvePluginConfig, resolveStorage,
} from '../src/plugin.js';
import type { DshMountContext, DshMountSession } from '../src/plugin.js';

/** The session slice a command handler receives; only `id` and `seq` are used. */
function fakeSession(id: string, seq?: number): DshMountSession {
  return {
    id,
    ...(seq === undefined ? {} : { seq }),
  } as unknown as DshMountSession;
}

/** A wait the test resolves by hand. */
function deferredWait(): { wait: CremateWait; settle(result: CrematePassResult): void } {
  let resolveResult!: (result: CrematePassResult) => void;
  return {
    wait: {
      result: new Promise<CrematePassResult>((resolve) => { resolveResult = resolve; }),
      abandon: () => {},
    },
    settle(next) { resolveResult(next); },
  };
}

/** Let the handler's microtasks run without moving the clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

test('the /cremate command opens one marker turn and returns the awaited pass card', async () => {
  const hand = deferredWait();
  const begins: { sessionId: string; messageId: string; commandId: string | undefined }[] = [];
  const followups: unknown[] = [];
  const command = createCremateCommand({
    begin: (sessionId, messageId, commandId) => {
      begins.push({ sessionId, messageId, commandId });
      return hand.wait;
    },
    cancel: () => {},
  });
  assert.equal(command.name, CREMATE_COMMAND_NAME);
  assert.equal(command.name, 'cremate');
  assert.equal(command.description, CREMATE_COMMAND_DESCRIPTION);
  assert.equal(typeof command.handler, 'function');

  let done = false;
  const pending = Promise.resolve(command.handler({
    commandId: 'command-1',
    agent: {
      session: fakeSession('session-command-1', 11),
      followup: (message) => { followups.push(message); },
    },
  })).finally(() => { done = true; });
  await flush();
  assert.equal(done, false, 'the card waits for the pass');
  hand.settle({ status: 'finished', removed: 2 });
  assert.deepEqual(await pending,
    { kind: 'success', text: 'Cremation finished; 2 results removed.' });

  assert.equal(begins.length, 1);
  assert.equal(begins[0]?.sessionId, 'session-command-1');
  assert.equal(begins[0]?.commandId, 'command-1');
  assert.equal(followups.length, 1, 'one turn is opened');
  const message = followups[0] as {
    id?: string; role?: string; content?: { type?: string; text?: string }[];
    source?: { kind?: string; commandId?: string };
  };
  assert.equal(message.id, begins[0]?.messageId, 'the turn carries the request\'s marker id');
  assert.equal(message.role, 'user');
  assert.equal(message.source?.kind, CREMATE_MESSAGE_SOURCE,
    'the marker is CREMATOR-attributed, not a typed /cremate message');
  assert.equal(message.source?.commandId, 'command-1',
    'the marker names the command, as native compaction names sourceCommandId');
  assert.notEqual(message.content?.[0]?.text, '/cremate',
    'the typed /cremate trigger must never see this message');
});

test('a failed or empty pass becomes its named card', async () => {
  const rows: { pass: CrematePassResult; card: { kind: string; text: string } }[] = [
    { pass: { status: 'finished', removed: 0 },
      card: { kind: 'success', text: 'Cremation finished; nothing removed.' } },
    { pass: { status: 'failed', message: 'prune ask refused: no-llm-service' },
      card: { kind: 'error',
        text: `${CREMATE_FAILED_PREFIX}prune ask refused: no-llm-service` } },
  ];
  for (const row of rows) {
    const hand = deferredWait();
    hand.settle(row.pass);
    const command = createCremateCommand({
      begin: () => hand.wait,
      cancel: () => {},
    });
    assert.deepEqual(await command.handler({
      agent: { session: fakeSession('session-command-2'), followup: () => {} },
    }), row.card);
  }
});

test('the /cremate command refuses an invocation with no live session', async () => {
  let begun = false;
  const command = createCremateCommand({
    begin: () => { begun = true; return deferredWait().wait; },
    cancel: () => {},
  });
  assert.deepEqual(await command.handler({}), { kind: 'error', text: CREMATE_NO_SESSION });
  assert.equal(begun, false, 'no request is recorded without a session');
});

test('a throwing followup returns a named error card and cancels the request', async () => {
  const hand = deferredWait();
  const cancels: { sessionId: string; messageId: string; message: string }[] = [];
  let started = '';
  const command = createCremateCommand({
    begin: (_sessionId, messageId) => { started = messageId; return hand.wait; },
    cancel: (sessionId, messageId, message) => { cancels.push({ sessionId, messageId, message }); },
  });
  assert.deepEqual(await command.handler({
    agent: {
      session: fakeSession('session-command-3'),
      followup: () => { throw new Error('host followup failed'); },
    },
  }), { kind: 'error',
    text: `${CREMATE_FAILED_PREFIX}could not open the cremation turn: host followup failed` });
  assert.deepEqual(cancels, [{ sessionId: 'session-command-3', messageId: started,
    message: 'could not open the cremation turn: host followup failed' }]);
});

test('the mount records one prune request per session, however it arrives', async () => {
  const records: { kind: string; [field: string]: unknown }[] = [];
  const mount = createRacoonsMount({
    config: resolvePluginConfig(undefined),
    storage: resolveStorage(undefined),
    journal: (record) => { records.push(record); },
  });
  try {
    mount.requestPrune('session-command-4', 3);
    mount.requestPrune('session-command-4', 4);
    const requests = records.filter(record => record.kind === 'prune-requested');
    assert.equal(requests.length, 1, 'a second request for a waiting session is a no-op');
    assert.equal(requests[0]?.['sessionId'], 'session-command-4');
    mount.requestPrune('session-command-5', 5);
    assert.equal(records.filter(record => record.kind === 'prune-requested').length, 2,
      'a different session is its own request');
  } finally {
    await mount.close();
  }
});

test('plugin apply registers /cremate and unload removes it', async () => {
  const registered: DshCommand[] = [];
  let unregistered = 0;
  const cleanups: (() => unknown)[] = [];
  const root = mkdtempSync(join(tmpdir(), 'cremator-command-'));
  const ctx = {
    on: () => () => {},
    effect: (register: () => (() => unknown) | void) => {
      const cleanup = register();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    commands: {
      register(command: DshCommand) {
        registered.push(command);
        return () => { unregistered += 1; };
      },
    },
  } as unknown as DshMountContext;
  try {
    const plugin = createRacoonsPlugin({ journal: () => {} });
    await plugin.apply(ctx, { crematorStorageRoot: root });
    assert.equal(registered.length, 1, 'the host registry receives one command');
    assert.equal(registered[0]?.name, 'cremate');
  } finally {
    for (const cleanup of cleanups) await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(unregistered, 1, 'unload disposes the command registration');
});

test('the package ships a dsh bundle patch that inserts the mount', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } };
    files?: string[];
  };
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(manifest.files?.includes('cordis.patch.yml'),
    'the patch ships with the package');

  const patchUrl = new URL('../cordis.patch.yml', import.meta.url);
  assert.ok(existsSync(patchUrl), 'the declared patch exists');
  const patch = readFileSync(patchUrl, 'utf8');
  assert.match(patch, /id:\s*cremator\b/);
  assert.match(patch, /name:\s*'cremator-dsh\/plugin'/);
  assert.match(patch, /contextWindowTokens:\s*400000/);
  assert.match(patch, /pruneThresholdTokens:\s*60000/);
});
