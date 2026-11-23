// The mount entry a `plugins: ["cremator-opencode"]` row actually loads
// (ISSUE-192; ADR-0017). OpenCode 2.4.0's loader reads a default export as one of
// two variants — `{ id, setup(context) }` or `{ id, effect }` — and refuses
// anything else with `Plugin must export a default definition with an id and an
// effect or setup function.` This pin makes a module-shape edit fail here instead
// of at a user's first launch. The module is duck-typed; no host import is loaded
// at run time, and a type-only conformance check pins the shape against
// `@opencode/plugin@2.4.0`'s own `Plugin` type.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin as PluginModule } from '@opencode/plugin';
import type { OpencodePluginContext } from '../src/host.js';
import serverModule from '../src/server.js';

// Type-only conformance: the module is one of the two variants the 2.4.0 loader
// accepts. The cast narrows the host's wide `Context` to the slice the adapter
// reads; a host contract change on a version bump fails this compile.
function hostAccepts(plugin: PluginModule.Plugin): PluginModule.Plugin {
  return plugin;
}
const asHostPlugin: PluginModule.Plugin = {
  id: serverModule.id,
  setup: (context: PluginModule.Context) =>
    serverModule.setup(context as unknown as OpencodePluginContext),
};
void hostAccepts(asHostPlugin);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-server-'));
}

function fakeContext(root: string): OpencodePluginContext {
  return {
    options: { crematorStorageRoot: root, excludeTools: ['subagent'] },
    session: {
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: {
      transform: async (callback) => { await callback({ add: () => {} }); return {}; },
      hook: async () => ({}),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
            return: async () => ({ done: true as const, value: undefined }),
          };
        },
      }),
    },
  };
}

test('the default export is the 2.4.0 module shape the loader reads', async () => {
  assert.equal(typeof serverModule.id, 'string');
  assert.equal(serverModule.id, 'cremator-opencode');
  assert.equal(typeof serverModule.setup, 'function');
  assert.equal('server' in serverModule, false, 'the retired 1.x server entry is gone');
  assert.equal('effect' in serverModule, false, 'this module is the setup variant');
  const root = scratch();
  try {
    const cleanup = await serverModule.setup(fakeContext(root));
    assert.equal(typeof cleanup, 'function', 'setup returns a Cleanup');
    await cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
