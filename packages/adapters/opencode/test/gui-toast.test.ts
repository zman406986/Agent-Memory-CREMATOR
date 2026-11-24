// ADR-0073 decisions 2 and 3 / ISSUE-604: the desktop part reports every manual
// pass result. Before this, only a thrown call raised a toast; a refusal such as
// `no-rows` changed a pill row and said nothing, so `/cremate` looked dead. The
// part is CommonJS, so it is loaded through `createRequire`, like the status
// helper's test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Toast {
  readonly title?: string;
  readonly description: string;
  readonly variant?: string;
}
interface StoreDoc {
  byKey: Record<string, unknown>;
}
interface GuiPlugin {
  setup(ctx: unknown): () => void;
}

const require = createRequire(import.meta.url);
const gui = require('../ui/gui-experimental.cjs') as GuiPlugin;

/** The composer command the desktop part registers, driven by one fake reply. */
function harness(reply: Readonly<Record<string, unknown>>): {
  readonly toasts: Toast[];
  run(): Promise<void>;
  cleanup(): void;
} {
  const toasts: Toast[] = [];
  let command: { run?: () => unknown } | null = null;
  let state: StoreDoc = { byKey: {} };
  const setStore = (mutate: (draft: StoreDoc) => void): void => {
    const draft = JSON.parse(JSON.stringify(state)) as StoreDoc;
    mutate(draft);
    state = draft;
  };
  const session = {
    id: 'ses_test',
    key: 'server-1\nses_test',
    server: {
      id: 'server-1',
      data: {},
      client: {
        rpc: { call: async () => ({ output: reply }) },
      },
    },
  };
  const ctx = {
    storage: {
      memory: (_name: string, options: { initial: StoreDoc }) => {
        state = JSON.parse(JSON.stringify(options.initial)) as StoreDoc;
        return [state, setStore];
      },
    },
    add: (_token: unknown, factory: () => unknown) => {
      const value = factory();
      if (value !== null && typeof value === 'object'
        && typeof (value as { run?: unknown }).run === 'function') {
        command = value as { run: () => unknown };
      }
      return () => {};
    },
    sessions: { current: () => session },
    toast: { show: (toast: Toast) => { toasts.push(toast); } },
  };
  const cleanup = gui.setup(ctx);
  return {
    toasts,
    async run() {
      assert.ok(command !== null, 'the desktop command registered');
      command.run?.();
      await new Promise<void>(resolve => { setImmediate(resolve); });
    },
    cleanup,
  };
}

test('a no-rows refusal is shown, not silent', async () => {
  const host = harness({ ok: true, fired: false, reason: 'no-rows', rows: 0 });
  try {
    await host.run();
    assert.deepEqual(host.toasts, [{
      title: 'CREMATOR', description: 'Nothing to cremate.', variant: 'default',
    }]);
  } finally {
    host.cleanup();
  }
});

test('a missing session is shown after a restart', async () => {
  const host = harness({ ok: true, fired: false, reason: 'no-session', rows: 0 });
  try {
    await host.run();
    assert.deepEqual(host.toasts, [{
      title: 'CREMATOR', description: 'No chat request to cremate yet.', variant: 'default',
    }]);
  } finally {
    host.cleanup();
  }
});

test('a fired pass reports the row count', async () => {
  const host = harness({ ok: true, fired: true, reason: 'table', rows: 2 });
  try {
    await host.run();
    assert.deepEqual(host.toasts, [{
      title: 'CREMATOR',
      description: 'Cremation asked 2 row(s); removals apply at the next step.',
      variant: 'success',
    }]);
  } finally {
    host.cleanup();
  }
});

test('a refusal while a pass runs is a notice, not an error', async () => {
  const host = harness({ ok: true, fired: false, reason: 'ask-in-flight', rows: 0 });
  try {
    await host.run();
    assert.deepEqual(host.toasts, [{
      title: 'CREMATOR', description: 'A cremation is already running.', variant: 'default',
    }]);
  } finally {
    host.cleanup();
  }
});

test('the desktop bundle is self-contained and its twins match', () => {
  const cjs = readFileSync(join(HERE, '..', 'ui', 'gui-experimental.cjs'), 'utf8');
  const twin = readFileSync(join(HERE, '..', 'ui', 'gui-experimental.js'), 'utf8');
  assert.equal(cjs, twin, 'the .js twin holds the same bytes');
  assert.doesNotMatch(cjs, /require\(\s*['"]\.{1,2}\//u,
    'the desktop loader refuses a local require; the bundle must inline it');
  assert.doesNotMatch(cjs, /from\s*['"]\.{1,2}\//u,
    'the desktop loader refuses a local import; the bundle must inline it');
});
