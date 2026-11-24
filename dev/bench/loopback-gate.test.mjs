#!/usr/bin/env node
/**
 * The live route's loopback gate, field-scoped and deduplicated (ISSUE-078).
 *
 * The defect this pins: `JSON.stringify(event).includes('127.0.0.1')` read a
 * whole record as text, so the 2026-10-28 extended run failed on the frozen
 * game template's own docs mentioning `http://127.0.0.1:4173` inside
 * `tool/result` content — 5 log rows, 2 calls, no endpoint field anywhere and
 * no request to loopback (gate 11, real billing, passed).
 *
 * Held here:
 *
 *   (a) tool-result content that mentions loopback is GREEN, whatever shape the
 *       host logs it in (`tool/result` session events, `tool_result` stdout
 *       events), and the gate says it examined 0 endpoint fields;
 *   (b) a `request/header` whose `baseURL` is `http://127.0.0.1:4173` is RED and
 *       names the call;
 *   (c) hits are deduplicated by `callId`: three rows of one call plus one row
 *       of another is 2 distinct calls in the message, not 4 records;
 *   (d) the shapes that must NOT be endpoints: a tool schema's
 *       `properties.url` object, a non-loopback URL, a bare host of `example.com`;
 *   (e) `bench-run.mjs` runs this gate by name and no longer carries the
 *       whole-record string scan (static: it reads `bench-run.mjs` as text);
 *   (f) a request-shaped record whose endpoint key this gate does not know
 *       leaves zero endpoint fields read, so the row is `vacuous` and does not
 *       count as a measured pass (fifteenth audit item 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOOPBACK_GATE, loopbackGate, requestShaped } from './loopback-gate.mjs';
import { assertionRow } from './bench-run.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./bench-run.mjs', import.meta.url)), 'utf8');

/** A `tool/result` session event, the shape the host writes (078 seq 507). */
function sessionToolResult(callId, text) {
  return {
    type: 'tool/result',
    seq: 507,
    data: {
      turn: 1,
      step: 47,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
      },
    },
  };
}

/** A `tool_result` stdout event, the same call logged to the other file. */
function stdoutToolResult(callId, text) {
  return { type: 'tool_result', callId, status: 'completed', result: text };
}

/** A `request/header` record; `header` is the whole composed header. */
function requestHeader(callId, header) {
  return { type: 'request/header', seq: 12, data: { header, reason: 'series', callId } };
}

const DOC = 'start the preview at http://127.0.0.1:4173 and open /editor; '
  + 'health: http://localhost:8080/health';

test('078 (a) tool-result CONTENT naming loopback does not trip the gate', () => {
  // The 078 shape exactly: 2 calls, triple-logged across the two artifacts.
  const gate = loopbackGate({
    stdoutLines: [
      stdoutToolResult('call_A', DOC),
      stdoutToolResult('call_B', DOC),
    ],
    sessionEvents: [
      sessionToolResult('call_A', DOC),
      sessionToolResult('call_B', DOC),
      sessionToolResult('call_B', DOC),
    ],
  });
  assert.equal(gate.ok, true, gate.detail);
  assert.equal(gate.endpointFields, 0, 'content is never walked for endpoint keys');
  assert.equal(gate.requestRecords, 0, 'tool results are not request-shaped records');
});

test('078 (a) a user/message quoting localhost is content too', () => {
  const gate = loopbackGate({
    sessionEvents: [{
      type: 'user/message',
      seq: 5,
      data: { message: { role: 'user', content: [{ type: 'text', text: `see ${DOC}` }] } },
    }],
  });
  assert.equal(gate.ok, true, gate.detail);
});

test('078 (b) a request/header with baseURL http://127.0.0.1:4173 is RED, by name', () => {
  const gate = loopbackGate({
    sessionEvents: [
      requestHeader('call_C', {
        config: { provider: 'deepseek', model: 'x', baseURL: 'http://127.0.0.1:4173/v1' },
        adapterDefaults: { maxTokens: true },
      }),
    ],
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /1 distinct call/u);
  assert.match(gate.detail, /call_C/u);
  assert.match(gate.detail, /baseURL=http:\/\/127\.0\.0\.1:4173/u);
  assert.equal(gate.distinctCalls, 1);
});

test('078 (b) the gate keeps its name and it names the endpoint key it read', () => {
  assert.equal(LOOPBACK_GATE, 'no record names a loopback endpoint');
  const gate = loopbackGate({
    sessionEvents: [requestHeader('call_D', { endpoint: 'https://localhost:9090/v1' })],
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /endpoint=https:\/\/localhost:9090/u);
});

test('078 (c) dedup: three rows of one call and one of another is 2 calls, not 4 rows', () => {
  const gate = loopbackGate({
    stdoutLines: [stdoutToolResult('call_E', 'http://127.0.0.1:1/x')],
    sessionEvents: [
      requestHeader('call_E', { baseUrl: 'http://127.0.0.1:1/x' }),
      requestHeader('call_E', { baseUrl: 'http://127.0.0.1:1/x' }),
      requestHeader('call_F', { host: 'localhost' }),
    ],
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.distinctCalls, 2);
  assert.match(gate.detail, /2 distinct call/u);
  // Both identities are named once each.
  assert.equal(gate.detail.match(/call_E/gu).length, 1);
  assert.equal(gate.detail.match(/call_F/gu).length, 1);
});

test('078 (d) a tool schema property named url is an OBJECT, not an endpoint value', () => {
  // The 078 `request/header` carried this 133 times; the old gate never read it
  // (no loopback string in it), and the refined gate must not either.
  const gate = loopbackGate({
    sessionEvents: [requestHeader('call_G', {
      tools: [{
        name: 'web_fetch',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The HTTP(S) URL to fetch.' } },
        },
      }],
    })],
  });
  assert.equal(gate.ok, true, gate.detail);
  assert.equal(gate.endpointFields, 0, 'a schema object is not a string endpoint value');
});

test('078 (d) non-loopback endpoints and a bare example.com host are green', () => {
  const gate = loopbackGate({
    sessionEvents: [requestHeader('call_H', {
      config: { baseURL: 'https://api.deepseek.com/v1', host: 'example.com' },
    })],
  });
  assert.equal(gate.ok, true, gate.detail);
  assert.equal(gate.endpointFields, 2, 'both string endpoint values were examined');
});

test('078 (d) bare-host loopback is caught on host/hostname only, and ::1 too', () => {
  for (const header of [{ host: '127.0.0.1' }, { hostname: 'localhost' }, { host: '::1' },
    { baseURL: 'http://[::1]:4173/v1' }]) {
    const gate = loopbackGate({ sessionEvents: [requestHeader('call_I', header)] });
    assert.equal(gate.ok, false, `expected RED for ${JSON.stringify(header)}`);
  }
  // A bare-host spelling is not an endpoint under other keys: `baseURL: 'localhost'`
  // is not a URL and cannot route a request.
  const odd = loopbackGate({ sessionEvents: [requestHeader('call_J', { baseURL: 'localhost' })] });
  assert.equal(odd.ok, true, odd.detail);
});

test('078 (e) requestShaped opens request/header, request/context and http/response types only', () => {
  assert.equal(requestShaped('request/header'), true);
  assert.equal(requestShaped('request/context'), true);
  assert.equal(requestShaped('http/response'), true);
  assert.equal(requestShaped('provider/response'), true);
  assert.equal(requestShaped('tool/result'), false);
  assert.equal(requestShaped('tool_result'), false);
  assert.equal(requestShaped('user/message'), false);
  assert.equal(requestShaped('assistant/message'), false);
});

test('audit 15 item 1: a renamed endpoint key reads zero fields, so the row is vacuous, not measured', () => {
  // `gatewayUrl` is the shape a host rename produces: request-shaped record,
  // no endpoint key this gate knows. It saw no route at all, so it must not
  // state that no route was loopback — and must not count as a measured pass.
  const renamed = loopbackGate({
    sessionEvents: [requestHeader('call_K', { gatewayUrl: 'http://127.0.0.1:4173/v1' })],
  });
  assert.equal(renamed.ok, true, renamed.detail);
  assert.equal(renamed.class, 'vacuous');
  assert.equal(renamed.requestRecords, 1);
  assert.equal(renamed.endpointFields, 0);
  assert.match(renamed.detail, /0 endpoint field/u);
  assert.match(renamed.detail, /endpoint key|host shape/u);
  assert.equal(assertionRow('loopback', renamed).contributesToPassed, false);
  // A known endpoint key still reads as measured: the fix must not vacate the gate.
  const known = loopbackGate({
    sessionEvents: [requestHeader('call_L', { baseURL: 'https://api.deepseek.com/v1' })],
  });
  assert.equal(known.class, 'measured');
  assert.equal(assertionRow('loopback', known).contributesToPassed, true);
});

