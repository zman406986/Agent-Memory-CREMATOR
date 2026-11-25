import assert from 'node:assert/strict';
import { test } from 'node:test';

// The browser artifact is a classic script. These tests import it as a module in
// plain Node: no dsh runtime, no window, no React. One test proves the import is
// side-effect-free off-host; the other proves it registers the dock entry when a
// loader is present.

test('the built client entry imports without a dsh runtime', async () => {
  const saved = globalThis.window;
  try {
    delete globalThis.window;
    const module = await import('../dist/client.js?no-runtime=1');
    assert.equal(typeof module, 'object');
  } finally {
    if (saved !== undefined) globalThis.window = saved;
  }
});

test('the built client entry registers one dock counter through the module loader', async () => {
  const loaded = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { loaded.push(entry); },
    },
  };
  try {
    await import('../dist/client.js?loader=1');
    assert.equal(loaded.length, 1, 'the artifact registers exactly one module');
    assert.equal(loaded[0].id, 'cremator-dsh');

    const React = {
      createElement: () => ({}),
      useState: value => [value, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
    };
    const registered = [];
    const ctx = {
      slots: {
        inject(name, activate) {
          assert.equal(name, 'conversation.composer.dock');
          activate();
        },
        register(options, component) {
          registered.push({ options, component });
          return () => {};
        },
      },
    };
    const plugin = loaded[0].factory(id => {
      if (id === 'react') return React;
      throw new Error('not provided: ' + id);
    });
    assert.deepEqual(plugin.inject, ['slots']);
    plugin.apply(ctx);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].options.order, 2);
    assert.equal(registered[0].component.name, 'CrematedCounter');
  } finally {
    delete globalThis.window;
  }
});
