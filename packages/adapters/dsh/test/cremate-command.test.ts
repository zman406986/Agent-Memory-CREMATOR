/**
 * The `/cremate` host command and the dsh bundle manifest (ADR-0068,
 * ISSUE-526, ISSUE-535, ISSUE-545).
 *
 * The command factory is pure: the handler rejects arguments before any work,
 * reports busy without opening a turn, then records its request, opens the
 * marker turn, and reports the pass that turn settles with the closed failure
 * vocabulary. The mount's typed request marker is tested directly; plugin apply
 * is tested with a stub context that carries the host command registry. The
 * manifest test pins the shipped bundle route so a later edit cannot drop it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CREMATE_CANCELLED, CREMATE_COMMAND_DESCRIPTION, CREMATE_COMMAND_NAME,
  CREMATE_FAILED_PREFIX, CREMATE_MESSAGE_SOURCE, CREMATE_NO_SESSION, cremateCardFor,
  createCremateCommand,
} from '../src/cremate-command.js';
import type {
  CremateFailureCode, CrematePassResult, CremateWait, DshCommand,
} from '../src/cremate-command.js';
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

/** A wait the test settles, rejects or abandons by hand. */
function deferredWait(): {
  wait: CremateWait;
  settle(result: CrematePassResult): void;
  reject(error: unknown): void;
  abandons: string[];
} {
  let resolveResult!: (result: CrematePassResult) => void;
  let rejectResult!: (error: unknown) => void;
  const abandons: string[] = [];
  return {
    wait: {
      result: new Promise<CrematePassResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      }),
      abandon: (message: string) => { abandons.push(message); },
    },
    settle(next) { resolveResult(next); },
    reject(error) { rejectResult(error); },
    abandons,
  };
}

/** Let the handler's microtasks run without moving the clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

test('the /cremate command rejects extra text before opening anything', async () => {
  const begins: unknown[] = [];
  const followups: unknown[] = [];
  const cancels: unknown[] = [];
  const command = createCremateCommand({
    begin: (...args) => { begins.push(args); return deferredWait().wait; },
    cancel: (...args) => { cancels.push(args); },
  });
  const agent = {
    session: fakeSession('session-usage'),
    followup: (message: unknown) => { followups.push(message); },
  };
  assert.deepEqual(await command.handler({ rawInput: ' please ', agent }),
    { kind: 'error', text: 'Use /cremate with no extra text.' });
  assert.deepEqual(await command.handler({ rawInput: 'please' }),
    { kind: 'error', text: 'Use /cremate with no extra text.' },
    'the usage card wins over the no-session card');
  assert.equal(begins.length, 0, 'no request is recorded');
  assert.equal(followups.length, 0, 'no turn is opened');
  assert.equal(cancels.length, 0, 'nothing was recorded, so nothing is dropped');
});

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
    rawInput: '   ',
    commandId: 'command-1',
    agent: {
      session: fakeSession('session-command-1', 11),
      followup: (message) => { followups.push(message); },
    },
  })).finally(() => { done = true; });
  await flush();
  assert.equal(done, false, 'the card waits for the pass');
  hand.settle({ status: 'finished', removed: 2, bytesRemoved: 4096 });
  assert.deepEqual(await pending,
    { kind: 'success', text: 'Cremation finished; 2 results removed, 4096 bytes removed.' });

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

test('a busy begin returns the busy card and opens no turn', async () => {
  const followups: unknown[] = [];
  const cancels: unknown[] = [];
  const command = createCremateCommand({
    begin: () => null,
    cancel: (...args) => { cancels.push(args); },
  });
  assert.deepEqual(await command.handler({
    commandId: 'command-busy',
    agent: {
      session: fakeSession('session-busy'),
      followup: (message) => { followups.push(message); },
    },
  }), { kind: 'error', text: 'A cremation pass is already running in this chat.' });
  assert.equal(followups.length, 0, 'the busy card opens no marker turn');
  assert.equal(cancels.length, 0, 'no request was recorded, so none is dropped');
});

test('the cremate card names results, bytes, nothing removed, and every failure code', () => {
  const finished: { pass: CrematePassResult; text: string }[] = [
    { pass: { status: 'finished', removed: 1, bytesRemoved: 17 },
      text: 'Cremation finished; 1 result removed, 17 bytes removed.' },
    { pass: { status: 'finished', removed: 2, bytesRemoved: 4096 },
      text: 'Cremation finished; 2 results removed, 4096 bytes removed.' },
    { pass: { status: 'finished', removed: 0, bytesRemoved: 0 },
      text: 'Cremation finished; nothing removed.' },
  ];
  for (const row of finished) {
    assert.deepEqual(cremateCardFor(row.pass), { kind: 'success', text: row.text });
  }
  const failures: { code: CremateFailureCode; text: string }[] = [
    { code: 'busy', text: 'A cremation pass is already running in this chat.' },
    { code: 'cancelled', text: 'Cremation cancelled.' },
    { code: 'no-window',
      text: "Cremation could not apply because the model's context window is unknown." },
    { code: 'changed',
      text: 'The conversation changed during the pass; nothing was removed. Try again.' },
    { code: 'ask-refused',
      text: 'Cremation could not get a usable answer; nothing was removed.' },
    { code: 'failed', text: `${CREMATE_FAILED_PREFIX}ask stream died` },
  ];
  for (const row of failures) {
    assert.deepEqual(
      cremateCardFor({ status: 'failed', code: row.code, message: 'ask stream died' }),
      { kind: 'error', text: row.text },
      `code ${row.code} has one fixed sentence`);
  }
});

test('a wait that rejects becomes the failed card with the error detail', async () => {
  const hand = deferredWait();
  const command = createCremateCommand({
    begin: () => hand.wait,
    cancel: () => {},
  });
  const pending = command.handler({
    agent: { session: fakeSession('session-reject'), followup: () => {} },
  });
  await flush();
  hand.reject(new Error('ledger closed'));
  assert.deepEqual(await pending,
    { kind: 'error', text: `${CREMATE_FAILED_PREFIX}ledger closed` });
});

test('an abort signal returns the cancelled card and abandons the request', async () => {
  const hand = deferredWait();
  const controller = new AbortController();
  const command = createCremateCommand({
    begin: () => hand.wait,
    cancel: () => {},
  });
  const pending = command.handler({
    signal: controller.signal,
    agent: { session: fakeSession('session-cancel'), followup: () => {} },
  });
  await flush();
  controller.abort();
  assert.deepEqual(await pending, { kind: 'error', text: 'Cremation cancelled.' });
  assert.deepEqual(hand.abandons, [CREMATE_CANCELLED],
    'the abandoned request names the cancellation the pass may still hit');
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
