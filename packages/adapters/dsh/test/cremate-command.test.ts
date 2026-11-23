/**
 * The `/cremate` host command and the dsh bundle manifest (ADR-0068,
 * ISSUE-526).
 *
 * The command factory is pure; the mount's request marker is tested directly;
 * plugin apply is tested with a stub context that carries the host command
 * registry. The manifest test pins the shipped bundle route so a later edit
 * cannot silently drop it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CREMATE_COMMAND_CARD_TEXT, CREMATE_COMMAND_DESCRIPTION, CREMATE_COMMAND_NAME,
  CREMATE_NO_SESSION, createCremateCommand,
} from '../src/cremate-command.js';
import type { DshCommand } from '../src/cremate-command.js';
import {
  createRacoonsMount, createRacoonsPlugin, resolvePluginConfig, resolveStorage,
} from '../src/plugin.js';
import type { DshMountContext, DshMountSession } from '../src/plugin.js';

/** The session slice a command handler receives; only `id` and `append` are used. */
function fakeSession(id: string, seq?: number): DshMountSession {
  return {
    id,
    ...(seq === undefined ? {} : { seq }),
    append: () => ({ type: 'test', seq: 0 }),
  } as unknown as DshMountSession;
}

test('the /cremate command names itself and opens one /cremate turn', async () => {
  const requests: { sessionId: string; seq: number | undefined }[] = [];
  const followups: unknown[] = [];
  const command = createCremateCommand({
    request: (sessionId, seq) => { requests.push({ sessionId, seq }); },
  });
  assert.equal(command.name, CREMATE_COMMAND_NAME);
  assert.equal(command.name, 'cremate');
  assert.equal(command.description, CREMATE_COMMAND_DESCRIPTION);
  assert.equal(typeof command.handler, 'function');

  const result = await command.handler({
    agent: {
      session: fakeSession('session-command-1', 11),
      followup: (message) => { followups.push(message); },
    },
  });
  assert.deepEqual(result, { kind: 'success', text: CREMATE_COMMAND_CARD_TEXT });
  assert.deepEqual(requests, [{ sessionId: 'session-command-1', seq: 11 }]);
  assert.equal(followups.length, 1, 'one turn is opened');
  const message = followups[0] as {
    role?: string; source?: { kind?: string }; content?: { type?: string; text?: string }[];
  };
  assert.equal(message.role, 'user');
  assert.equal(message.source?.kind, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: '/cremate' }],
    'the turn carries the same text the typed trigger uses');
});

test('the /cremate command refuses an invocation with no live session', async () => {
  let called = false;
  const command = createCremateCommand({ request: () => { called = true; } });
  const result = await command.handler({});
  assert.deepEqual(result, { kind: 'error', text: CREMATE_NO_SESSION });
  assert.equal(called, false, 'no request is recorded without a session');
});

test('a throwing followup never loses the recorded request', async () => {
  const requests: string[] = [];
  const command = createCremateCommand({
    request: (sessionId) => { requests.push(sessionId); },
  });
  const result = await command.handler({
    agent: {
      session: fakeSession('session-command-2'),
      followup: () => { throw new Error('host followup failed'); },
    },
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(requests, ['session-command-2']);
});

test('a command with a run callback executes the pass directly', async () => {
  let ran: DshMountSession | undefined;
  const command = createCremateCommand({
    request: () => { throw new Error('the queue path must not run'); },
    run: async (session) => {
      ran = session;
      return { kind: 'success', text: 'Cremation finished; 2 results removed.' };
    },
  });
  const session = fakeSession('session-command-5', 5);
  const result = await command.handler({ agent: { session } });
  assert.deepEqual(result, { kind: 'success', text: 'Cremation finished; 2 results removed.' });
  assert.equal(ran?.id, 'session-command-5');
});

test('a throwing direct run returns an error card', async () => {
  const command = createCremateCommand({
    request: () => {},
    run: async () => { throw new Error('prune failed'); },
  });
  const result = await command.handler({ agent: { session: fakeSession('session-command-6') } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /prune failed/u);
});

test('the mount records one prune request per session, however it arrives', async () => {
  const records: { kind: string; [field: string]: unknown }[] = [];
  const mount = createRacoonsMount({
    config: resolvePluginConfig(undefined),
    storage: resolveStorage(undefined),
    journal: (record) => { records.push(record); },
  });
  try {
    mount.requestPrune('session-command-3', 3);
    mount.requestPrune('session-command-3', 4);
    const requests = records.filter(record => record.kind === 'prune-requested');
    assert.equal(requests.length, 1, 'a second request for a waiting session is a no-op');
    assert.equal(requests[0]?.['sessionId'], 'session-command-3');
    mount.requestPrune('session-command-4', 5);
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
  assert.ok(existsSync(patchUrl), 'the declared patch file exists');
  const patch = readFileSync(patchUrl, 'utf8');
  assert.match(patch, /id:\s*cremator\b/);
  assert.match(patch, /name:\s*'cremator-dsh\/plugin'/);
  assert.match(patch, /contextWindowTokens:\s*400000/);
  assert.match(patch, /pruneThresholdTokens:\s*60000/);
});
