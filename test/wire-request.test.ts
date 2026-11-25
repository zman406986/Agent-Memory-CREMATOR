/**
 * Wire-request determinism (ISSUE-026 chunk 5, ADR-0010).
 *
 * What is pinned: the body reader projects a wire-shaped payload to the fork's
 * request, and the canonical text of that request is the exact preimage of
 * core's `wireRequestHash`. From those two claims the loop
 * `parse -> canonical -> parse` is a byte fixpoint, and the hash survives it.
 *
 * The fixture is a REDACTED MOCK body shaped like the bench rig's recorded
 * bodies (`scratchpad/bench/.../requests.jsonl`, gitignored): `system` string,
 * tool records with `name`/`description`/`input_schema`, messages carrying
 * `text`, `tool_use` and `tool_result` blocks, tool results under a `user`
 * role. dsh's own session log does not carry the sent body, so equality
 * against a LIVE log is not testable here; that gap is stated in the ticket.
 *
 * The expected objects below are written out by hand, not computed from the
 * parser, so a silent change in the projection turns these red. Two `test()`
 * blocks remain: the SHAPE claims (a row table, each row a separate fact about
 * the projection) and the REFUSAL table (one row per malformed class).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha256Sync, toBytes, wireRequestHash } from '@cremator/core';
import type { WireRequest } from '@cremator/core';
import {
  WireRequestParseError, canonicalWireRequest, parseWireRequest,
} from '../src/wire-request.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

const fixturePath = new URL('fixtures/wire-request-sample.json', import.meta.url);

function fixtureBody(): unknown {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

/** The parsed fixture, as the projection is declared to render it. */
const EXPECTED: WireRequest = {
  system: 'You are a coding agent operating on a local repository. Report results as short lines.',
  tools: [
    {
      name: 'read_file',
      description: 'Read one file and return its bytes.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'run_shell',
      description: 'Run one shell command in the workspace root.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
        required: ['command'],
      },
    },
    {
      name: 'search_files',
      description: 'Search the workspace for a literal string.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
  messages: [
    { role: 'user', text: 'Inspect the example module.\nThen report one fact.' },
    { role: 'assistant', text: '[tool call read_file {"path":"src/example.ts"}]' },
    { role: 'tool', text: '[tool result call_0 export const answer = 42;\n]' },
    { role: 'assistant', text: 'The module exports one constant.' },
    { role: 'user', text: 'Keep the report under five words.' },
  ],
};

function codeOf(payload: unknown): string {
  try {
    parseWireRequest(payload);
  } catch (error) {
    assert.ok(error instanceof WireRequestParseError, String(error));
    assert.equal(error.name, 'WireRequestParseError');
    return error.code;
  }
  assert.fail('the payload parsed, but it must be refused');
}

const ROWS: readonly Row[] = [
  { name: 'the fixture parses to the hand-written expected request',
    run(at) {
      assert.deepEqual(parseWireRequest(fixtureBody()), EXPECTED,
        at('the projection matches the hand-written request'));
    } },
  { name: 'canonical text is the hash preimage and the hash is stable',
    run(at) {
      const request = parseWireRequest(fixtureBody());
      const canonical = canonicalWireRequest(request);
      // Identity: our canonical bytes ARE what core hashes, byte for byte.
      assert.equal(sha256Sync(toBytes(canonical)), wireRequestHash(request),
        at('the canonical text is the exact hash preimage'));
      assert.equal(wireRequestHash(parseWireRequest(fixtureBody())), wireRequestHash(request),
        at('re-parsing the same body yields the same hash'));
    } },
  { name: 'parse -> canonical -> parse is a byte fixpoint',
    run(at) {
      const once = canonicalWireRequest(parseWireRequest(fixtureBody()));
      const twice = canonicalWireRequest(parseWireRequest(JSON.parse(once)));
      assert.equal(twice, once, at('one round is already stable'));
      // A third round must not drift either: the fixpoint is reached immediately.
      assert.equal(canonicalWireRequest(parseWireRequest(JSON.parse(twice))), once,
        at('a third round does not drift'));
    } },
  { name: 'key order in the payload cannot move the canonical text',
    run(at) {
      const body = fixtureBody() as Record<string, unknown>;
      const reordered = {
        messages: body['messages'], tools: body['tools'], system: body['system'],
      };
      assert.equal(canonicalWireRequest(parseWireRequest(reordered)),
        canonicalWireRequest(parseWireRequest(body)),
        at('a reordered top-level payload canonicalises the same'));
      // The equality above is canonicalisation, not luck: plain stringification of
      // the two payloads differs, so a JSON.stringify-based canonical would fail.
      assert.notEqual(JSON.stringify(reordered), JSON.stringify(body),
        at('the two payloads really do stringify differently'));
      const tool = { name: 't', parameters: { b: 1, a: 2 } };
      const flipped = { name: 't', parameters: { a: 2, b: 1 } };
      assert.notEqual(JSON.stringify(tool), JSON.stringify(flipped),
        at('the two tool records really do stringify differently'));
      assert.equal(
        canonicalWireRequest(parseWireRequest({ messages: [], tools: [tool] })),
        canonicalWireRequest(parseWireRequest({ messages: [], tools: [flipped] })),
        at('a reordered schema canonicalises the same'));
    } },
  { name: 'reordering messages changes the hash',
    run(at) {
      const request = parseWireRequest(fixtureBody());
      const swapped: WireRequest = {
        ...request,
        messages: [request.messages[4]!, request.messages[3]!, request.messages[2]!,
          request.messages[1]!, request.messages[0]!],
      };
      assert.notEqual(wireRequestHash(swapped), wireRequestHash(request),
        at('the order is part of the hash'));
      assert.notEqual(canonicalWireRequest(swapped), canonicalWireRequest(request),
        at('the order is part of the canonical text'));
    } },
  { name: 'a wire tool result under the user role is carried as a tool turn',
    run(at) {
      const request = parseWireRequest({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read',
            input: { b: 1, a: 2 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
          { role: 'user', text: 'plain' },
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
            { type: 'text', text: 'mixed' }] },
        ],
      });
      assert.deepEqual(request.messages, [
        { role: 'assistant', text: '[tool call read {"a":2,"b":1}]' },
        { role: 'tool', text: '[tool result c1 ok]' },
        { role: 'user', text: 'plain' },
        // A mixed message is not a tool result turn: it keeps its declared role.
        { role: 'user', text: '[tool result c1 ok]mixed' },
      ], at('a lone tool_result becomes a tool turn, a mixed one does not'));
      // An absent system slot and tool list read as empty, never as undefined.
      assert.equal(request.system, '', at('an absent system slot is empty, not undefined'));
      assert.deepEqual(request.tools, [], at('an absent tool list is empty'));
      assert.equal(canonicalWireRequest(request), canonicalWireRequest(parseWireRequest({
        system: '', tools: [], messages: request.messages,
      })), at('the defaults canonicalise the same as an explicit empty'));
    } },
  { name: 'the parser does not alias its input',
    run(at) {
      const body = fixtureBody() as { messages: { content: { text: string }[] }[] };
      const request = parseWireRequest(body);
      const first = body.messages[0]?.content[0];
      assert.ok(first !== undefined, at('the fixture has a first text block'));
      if (first === undefined) return;
      first.text = 'MUTATED';
      assert.equal(request.messages[0]?.text, EXPECTED.messages[0]?.text,
        at('mutating the payload leaves the parsed request alone'));
    } },
];

test('the fixture projects to its hand-written request, whose canonical text is the hash preimage',
  async () => {
    await runRows(ROWS);
  });

/** One malformed payload per refusal class, in the order the parser checks them. */
const REFUSALS: readonly { readonly name: string; readonly payload: unknown;
  readonly code: string }[] = [
  { name: 'null body', payload: null, code: 'payload-not-object' },
  { name: 'string body', payload: 'body', code: 'payload-not-object' },
  { name: 'non-string system', payload: { messages: [], system: 1 }, code: 'system-not-string' },
  { name: 'non-array tools', payload: { messages: [], tools: {} }, code: 'tools-not-array' },
  { name: 'non-object tool record', payload: { messages: [], tools: ['read'] }, code: 'tool-not-object' },
  { name: 'tool with no name', payload: { messages: [], tools: [{ description: 'x' }] },
    code: 'tool-name-not-string' },
  { name: 'tool schema that is not JSON', payload: { messages: [],
    tools: [{ name: 'read', parameters: undefined }] }, code: 'tool-not-json' },
  { name: 'no messages key', payload: {}, code: 'messages-not-array' },
  { name: 'null message', payload: { messages: [null] }, code: 'message-not-object' },
  { name: 'message with no role', payload: { messages: [{ content: 'x' }] },
    code: 'message-role-missing' },
  { name: 'unknown role', payload: { messages: [{ role: 'developer', content: 'x' }] },
    code: 'message-role-invalid' },
  { name: 'non-array, non-string content', payload: { messages: [{ role: 'user', content: 7 }] },
    code: 'message-content-invalid' },
  { name: 'both text and content', payload: { messages: [{ role: 'user', text: 'a', content: 'b' }] },
    code: 'message-content-invalid' },
  { name: 'non-object block', payload: { messages: [{ role: 'user', content: [1] }] },
    code: 'block-not-object' },
  { name: 'unsupported block type', payload: { messages: [{ role: 'user',
    content: [{ type: 'image' }] }] }, code: 'block-type-unsupported' },
  { name: 'non-string block text', payload: { messages: [{ role: 'user',
    content: [{ type: 'text', text: 1 }] }] }, code: 'block-text-not-string' },
  { name: 'tool_use with no name', payload: { messages: [{ role: 'assistant',
    content: [{ type: 'tool_use', id: 'c' }] }] }, code: 'block-tool-invalid' },
  { name: 'tool_result with no id', payload: { messages: [{ role: 'user',
    content: [{ type: 'tool_result' }] }] }, code: 'block-tool-invalid' },
];

test('each malformed class throws its own typed code', () => {
  for (const row of REFUSALS) {
    assert.equal(codeOf(row.payload), row.code, `row: ${row.name}`);
  }
});

test('ISSUE-398: an own __proto__ tool argument is carried, never dropped nor prototype pollution',
  () => {
    const bodyWith = (input: string) => ({ messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: 'c1', name: 'read', input: JSON.parse(input) }] }] });
    const plain = parseWireRequest(bodyWith('{"path":"a"}'));
    // A string-valued own `__proto__` (LLM-authored input via JSON.parse) must
    // survive the copy: dropping it would hash two distinct bodies identically.
    const withProto = parseWireRequest(bodyWith('{"path":"a","__proto__":"x"}'));
    assert.notEqual(wireRequestHash(withProto), wireRequestHash(plain),
      'the own __proto__ argument is part of the hash');
    assert.notEqual(canonicalWireRequest(withProto), canonicalWireRequest(plain),
      'the own __proto__ argument is part of the canonical text');
    assert.equal(withProto.messages[0]?.text.includes('"__proto__":"x"'), true,
      'the projected tool call carries the argument');
    assert.equal(sha256Sync(toBytes(canonicalWireRequest(withProto))), wireRequestHash(withProto),
      'the canonical text stays the exact hash preimage');
    const once = canonicalWireRequest(withProto);
    assert.equal(canonicalWireRequest(parseWireRequest(JSON.parse(once))), once,
      'parse -> canonical -> parse stays a byte fixpoint with the argument');
    // An object-valued own `__proto__` used to set the copy's prototype, so
    // canonicalManifestBytes leaked a raw TypeError out of the parse. It is
    // own JSON data: carried whole, hashed distinctly, round-tripped — and any
    // refusal this lane raises stays a typed WireRequestParseError, never raw.
    const objectProto = parseWireRequest(bodyWith('{"path":"a","__proto__":{"evil":true}}'));
    const objectCanonical = canonicalWireRequest(objectProto);
    assert.notEqual(wireRequestHash(objectProto), wireRequestHash(plain),
      'the object-valued argument is part of the hash');
    assert.equal(objectProto.messages[0]?.text.includes('"__proto__":{"evil":true}'), true,
      'the projected tool call carries the object argument');
    assert.equal(sha256Sync(toBytes(objectCanonical)), wireRequestHash(objectProto),
      'the object argument keeps the hash preimage identity');
    assert.equal(canonicalWireRequest(parseWireRequest(JSON.parse(objectCanonical))),
      objectCanonical, 'the object argument round-trips without drift');
  });
