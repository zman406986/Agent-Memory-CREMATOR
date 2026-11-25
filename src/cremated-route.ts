/**
 * Same-origin read surface for the composer dock counter.
 *
 * The browser cannot read the ledger and must not poll a file, so the plugin
 * exposes exactly one GET: `/cremator/cremated?session=<id>`. It is display-only
 * and fails soft: an unknown session or any read error answers `null`, which the
 * client renders as "-". Nothing here writes, and no response is cached.
 */
import type { SessionId } from '@cremator/core';
import type { RacoonsMount } from './plugin.js';
import { formatByteSize, readAppliedRemovedBytes } from './cremated-bytes.js';

export const CREMATED_ROUTE_PATH = '/cremator/cremated';

interface CrematedWebServer {
  register(route: {
    kind: 'prefix';
    path: string;
    resource: (request: Request) => Promise<Response> | Response;
  }): unknown;
}

function jsonResponse(removedBytes: number | null, status = 200): Response {
  const body = removedBytes === null
    ? { removedBytes: null }
    : { removedBytes, display: formatByteSize(removedBytes) };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Answer one counter request. Never throws: every failure is `null`. */
export async function handleCrematedRequest(mount: RacoonsMount, request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') return jsonResponse(null, 405);
    const sessionId = new URL(request.url).searchParams.get('session');
    if (sessionId === null || sessionId === '') return jsonResponse(null);
    const entry = mount.sessions.get(sessionId);
    if (entry === undefined) return jsonResponse(null);
    return jsonResponse(await readAppliedRemovedBytes(entry.ledger, sessionId as SessionId));
  } catch {
    return jsonResponse(null);
  }
}

/**
 * Register the route when the host has a webserver. Returns the disposer, or
 * `null` when the host offers no registrar; the caller stays silent on `null`
 * because a profile without a browser is not an error.
 */
export function registerCrematedRoute(webServer: unknown, mount: RacoonsMount): (() => void) | null {
  try {
    if (typeof webServer !== 'object' || webServer === null) return null;
    const register = (webServer as { register?: unknown }).register;
    if (typeof register !== 'function') return null;
    const dispose: unknown = (register as (this: unknown, route: {
      kind: 'prefix';
      path: string;
      resource: (request: Request) => Promise<Response> | Response;
    }) => unknown).call(webServer, {
      kind: 'prefix',
      path: CREMATED_ROUTE_PATH,
      resource: request => handleCrematedRequest(mount, request),
    });
    return typeof dispose === 'function' ? dispose as () => void : () => {};
  } catch {
    return null;
  }
}
