import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEvent, SessionId } from '@cremator/core';
import type { RacoonsMount } from '../src/plugin.js';
import { CREMATED_ROUTE_PATH, registerCrematedRoute } from '../src/cremated-route.js';

const SESSION = 'session-1' as SessionId;

function prepared(intentId: string, removedBytes: number): LedgerEvent {
  return {
    kind: 'prepared', sessionId: SESSION, eventKey: 'p-' + intentId, atMs: 0,
    intentId, applicationSha256: 'sha', engine: { removedBytes },
  } as unknown as LedgerEvent;
}

function applied(intentId: string): LedgerEvent {
  return {
    kind: 'applied', sessionId: SESSION, eventKey: 'a-' + intentId, atMs: 0,
    receipt: {
      intentId, sessionId: SESSION, baseRevision: 0, resultRevision: 1,
      applicationSha256: 'sha', appliedAtMs: 0,
    },
  } as unknown as LedgerEvent;
}

function mountWith(events: readonly LedgerEvent[], throwOnRead = false): RacoonsMount {
  const ledger = {
    async *events() {
      if (throwOnRead) throw new Error('ledger unavailable');
      for (const event of events) yield { event };
    },
  };
  return {
    sessions: new Map([[SESSION as string, { sessionId: SESSION, ledger }]]),
  } as unknown as RacoonsMount;
}

interface Route {
  path: string;
  kind: string;
  resource: (request: Request) => Promise<Response>;
}

function install(mount: RacoonsMount): { route: Route } {
  let route: Route | undefined;
  const webServer = {
    register(candidate: Route) { route = candidate; return () => {}; },
  };
  assert.equal(typeof registerCrematedRoute(webServer, mount), 'function');
  assert.ok(route);
  return { route };
}

test('the route sums applied removals for the named session', async () => {
  const { route } = install(mountWith([prepared('a', 512), prepared('b', 24), applied('a')]));
  assert.equal(route.path, CREMATED_ROUTE_PATH);
  assert.equal(route.kind, 'prefix');
  const response = await route.resource(new Request('http://127.0.0.1:3080/cremator/cremated?session=session-1'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removedBytes: 512, display: '512 B' });
});

test('an unknown session, a missing session id, and a failing ledger all answer null', async () => {
  const unknown = install(mountWith([])).route;
  for (const url of [
    'http://x/cremator/cremated?session=other',
    'http://x/cremator/cremated',
  ]) {
    const response = await unknown.resource(new Request(url));
    assert.deepEqual(await response.json(), { removedBytes: null });
  }
  const failing = install(mountWith([], true)).route;
  const response = await failing.resource(new Request('http://x/cremator/cremated?session=session-1'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removedBytes: null });
});

test('a host without a webserver registrar is a silent null, not a throw', () => {
  assert.equal(registerCrematedRoute(undefined, mountWith([])), null);
  assert.equal(registerCrematedRoute({}, mountWith([])), null);
  assert.equal(registerCrematedRoute({ register() { throw new Error('duplicate route'); } }, mountWith([])), null);
});
