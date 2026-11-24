#!/usr/bin/env node
/**
 * The live route's loopback gate — field-scoped, deduplicated.
 *
 * WHAT THE OLD GATE WAS. `JSON.stringify(event).includes('127.0.0.1')` over
 * `stdout.ndjson` and `session.v4.jsonl` read the whole RECORD as text, so any
 * tool-result content could trip it. The 2026-10-28 extended run (ISSUE-078)
 * failed it with 5 "records": all five were `tool/result` content — the frozen
 * game template's own docs mention `http://127.0.0.1:4173` — triple-logged
 * across 2 calls (3 session events, 2 stdout events), and neither file carried
 * an endpoint FIELD. No request went to loopback; gate 11 (real billing)
 * passed. The gate conflated "the model read a doc that mentions localhost"
 * with "the run routed to the mock".
 *
 * WHAT IT IS NOW. Two scopes, both required to fail a run:
 *
 *   1. **Record scope.** Only request-ish records are read: `request/header`,
 *      `request/context`, and any type whose name contains `http`, `request`
 *      or `response`. `tool/result`, `tool_result`, `user/message`,
 *      `assistant/message` and every other content carrier are never walked —
 *      a model reading a document about localhost is not a routing fact.
 *   2. **Field scope.** Inside those records only STRING values at endpoint
 *      keys are read: `url`, `baseUrl`, `baseURL`, `base_url`, `endpoint`,
 *      `host`, `hostname`, `apiBase`. The walk descends through nested objects,
 *      so the provider-adapter config object (`data.header.config`,
 *      `data.header.adapterDefaults`) is covered wherever the host puts it.
 *      A tool schema's `properties.url` is an OBJECT (`{type, description}`),
 *      not a string, so it is not an endpoint value — that shape is exactly
 *      what the 078 `request/header` carried 133 times.
 *
 * The value fails on `^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?`, or,
 * for the keys `host`/`hostname` only, when it is exactly `127.0.0.1`,
 * `localhost` or `::1` with no scheme.
 *
 * Hits are deduplicated by `callId` before counting, so the failure message
 * names distinct calls rather than log lines (the same result is written to
 * `session.v4.jsonl` and `stdout.ndjson`, and a host may log one call more
 * than once — the 078 run logged 2 calls as 5 records).
 *
 * `bench-run.mjs` runs `main()` only when it is the process entry point (the
 * guard at the bottom compares `process.argv[1]` to `import.meta.url`), so the
 * predicate could live there; it lives here anyway, pure, so the shape rules
 * are testable on their own. `bench-run.mjs` imports it on the live route
 * only; `loopback-gate.test.mjs` pins the shapes above, including the 078
 * content shape as a green case and a baseURL as the red.
 */

/** The gate's name. It keeps the name it had: readers and records cite it. */
export const LOOPBACK_GATE = 'no record names a loopback endpoint';

/** Endpoint keys whose STRING value is an endpoint, wherever the host nests them. */
const ENDPOINT_KEYS = new Set([
  'url', 'baseUrl', 'baseURL', 'base_url', 'endpoint', 'host', 'hostname', 'apiBase',
]);

/** Keys where a bare host with no scheme is also an endpoint. */
const BARE_HOST_KEYS = new Set(['host', 'hostname']);

/** `^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?` — a path may follow. */
const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/iu;

/** The bare-host spellings, exact (case-insensitive: host names are). */
const BARE_LOOPBACK = /^(?:127\.0\.0\.1|localhost|::1)$/iu;

/**
 * Is this record type one that STATES a route? `request/header` and
 * `request/context` by name, anything else only when its name says so.
 * @param {unknown} type
 * @returns {boolean}
 */
export function requestShaped(type) {
  const name = String(type ?? '').toLowerCase();
  if (name === 'request/header' || name === 'request/context') return true;
  return name.includes('http') || name.includes('request') || name.includes('response');
}

/**
 * The identity a hit is deduplicated by: the tool call when the record names
 * one, else the record's own sequence number, else its position. A `callId`
 * is the honest unit — one call may be logged as several rows.
 * @param {object} record
 * @param {number} index
 * @returns {string}
 */
function identityOf(record, index) {
  const message = record?.data?.message;
  const callId = record?.callId ?? record?.data?.callId
    ?? message?.source?.callId ?? message?.toolCallId;
  if (callId !== undefined && callId !== null && String(callId) !== '') return String(callId);
  const type = String(record?.type ?? 'record');
  return record?.seq === undefined ? `${type}#${String(index)}` : `${type}#seq${String(record.seq)}`;
}

/**
 * Walk one request-shaped record for string values at endpoint keys.
 * @param {object} record
 * @param {string} type
 * @param {number} index
 * @param {(hit: {identity: string, type: string, path: string, key: string,
 *   value: string}) => void} emit
 * @returns {number} how many endpoint-key STRING values were seen
 */
function walk(record, type, index, emit) {
  let seen = 0;
  const visit = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => { visit(item, `${path}[${String(i)}]`); });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (typeof value === 'string' && ENDPOINT_KEYS.has(key)) {
        seen += 1;
        const loopback = LOOPBACK_URL.test(value)
          || (BARE_HOST_KEYS.has(key) && BARE_LOOPBACK.test(value));
        if (loopback) emit({ identity: identityOf(record, index), type, path: here, key, value });
      }
      visit(value, here);
    }
  };
  visit(record, '');
  return seen;
}

/**
 * The gate over the two artifacts the launcher already holds.
 *
 * @param {{stdoutLines?: object[], sessionEvents?: object[]}} input
 * @returns {{ok: boolean, class: string, detail?: string, hits: object[],
 *   distinctCalls: number, endpointFields: number, requestRecords: number}}
 *   `endpointFields` counts endpoint-key string values examined (0 on a record
 *   with no endpoint naming at all); `requestRecords` is how many records the
 *   field scope opened. Both are reported so a PASS says what it looked at.
 *   With no request-shaped record at all the gate is `not-applicable`: it
 *   could not have failed, so counting it as a measured pass is an empty
 *   subject (fourteenth audit item 5). With request-shaped records but ZERO
 *   endpoint fields read it is `vacuous`, naming the reason: a renamed endpoint
 *   key or a host shape this gate does not know leaves it with no route to
 *   read, and a `measured` pass there would be the green over an absence that
 *   let a paid run reach the mock unseen (fifteenth audit item 1).
 */
export function loopbackGate({ stdoutLines = [], sessionEvents = [] } = {}) {
  const all = [...stdoutLines, ...sessionEvents];
  const hits = [];
  let endpointFields = 0;
  let requestRecords = 0;
  all.forEach((record, index) => {
    if (!requestShaped(record?.type)) return;
    requestRecords += 1;
    endpointFields += walk(record, String(record.type), index, (hit) => hits.push(hit));
  });
  const distinct = new Map();
  for (const hit of hits) if (!distinct.has(hit.identity)) distinct.set(hit.identity, hit);
  const named = [...distinct.values()];
  if (named.length === 0) {
    if (requestRecords === 0) {
      return { ok: true, class: 'not-applicable', hits: [], distinctCalls: 0, endpointFields, requestRecords,
        detail: 'no request-shaped record was read, so no route was stated; the loopback lane was not exercised' };
    }
    if (endpointFields === 0) {
      return { ok: true, class: 'vacuous', hits: [], distinctCalls: 0, endpointFields, requestRecords,
        detail: `${String(requestRecords)} request-shaped record(s), 0 endpoint field(s): no string sat at `
          + 'an endpoint key this gate reads (a renamed endpoint key or a new host shape), so it read no '
          + 'route and cannot state that none was loopback' };
    }
    return { ok: true, class: 'measured',
      detail: `${String(requestRecords)} request-shaped record(s), ${String(endpointFields)} endpoint field(s); none names loopback`,
      hits: [], distinctCalls: 0, endpointFields, requestRecords };
  }
  const sample = named.slice(0, 5)
    .map((hit) => `${hit.identity} (${hit.type} ${hit.path}=${hit.value})`)
    .join('; ');
  return {
    ok: false,
    class: 'failed',
    detail: `${String(named.length)} distinct call(s) name a loopback endpoint: ${sample}`,
    hits: named,
    distinctCalls: named.length,
    endpointFields,
    requestRecords,
  };
}
