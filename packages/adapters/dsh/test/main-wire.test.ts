/**
 * The main-request capture (ISSUE-026 chunk 3, ADR-0010).
 *
 * What is pinned here is the SHAPE the capture takes from the dispatched request
 * object, and what it refuses. The seam does not see the provider's HTTP body —
 * `captureMainRequest` says so — so these tests assert the normalisation, never
 * a byte-exactness the seam cannot deliver: same object in, same seed hash out;
 * our own asks and shapeless values are skipped.
 *
 * Every shape is a row: a failing capture names the request it tried.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedFork, wireRequestHash } from '@cremator/core';
import { captureMainRequest, createMainWireCapture } from '../src/main-wire.js';
import { askWire, isRacoonsAskRequest } from '../src/llm-ask.js';
import type { DshLlmChunk, DshLlmStreamOptions } from '../src/plugin.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

function fakeLlm(): { calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk> } {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

const ROWS: readonly Row[] = [
  { name: 'a loop-built request keeps its leading system message as a message',
    run(at) {
      const captured = captureMainRequest({
        sessionId: 's1',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'HARNESS PROMPT' }] },
          { role: 'user', content: [{ type: 'text', text: 'do it' }] },
          { role: 'assistant', content: [
            { type: 'text', text: 'calling' },
            { type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }] },
          { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'bytes' }] },
        ],
      });
      assert.ok(captured !== null, at('a shaped request is a seed'));
      if (captured === null) return;
      // The slot is main's own, empty: the prompt stays where main put it.
      assert.equal(captured.wire.system, '', at('the system slot stays empty'));
      assert.equal(captured.systemFromMessage, false, at('the prompt is not lifted'));
      assert.deepEqual(captured.wire.messages.map(message => message.role),
        ['system', 'user', 'assistant', 'tool'], at('the roles survive in order'));
      assert.deepEqual(captured.wire.messages[0], { role: 'system', text: 'HARNESS PROMPT' },
        at('messages[0] is main\'s own system message'));
      assert.equal(captured.wire.messages[2]?.text, 'calling[tool call read {"path":"a"}]',
        at('a tool call is rendered inline into its assistant turn'));
      assert.equal(captured.droppedMessages, 0, at('nothing was dropped'));
      assert.equal(captured.droppedBlocks, 0, at('no block was dropped'));
      assert.equal(captured.seedHash, wireRequestHash(captured.wire),
        at('the seed hash is the request hash'));
      // The fork seeds from this shape unlifted: messages[0] IS main's message.
      const fork = seedFork(captured.wire);
      assert.deepEqual(fork.messages[0], { role: 'system', text: 'HARNESS PROMPT' },
        at('the fork keeps main\'s message at index 0'));
      assert.equal(fork.system, '', at('the fork keeps the empty slot'));
    } },
  { name: 'a shapeless value is not a request, and our own ask is not main',
    async run(at) {
      const shapeless: readonly { readonly name: string; readonly value: unknown }[] = [
        { name: 'null', value: null },
        { name: 'a non-array messages field', value: { messages: 'nope' } },
        { name: 'a string', value: 'nope' },
      ];
      for (const item of shapeless) {
        assert.equal(captureMainRequest(item.value), null, `${at('not a request')}: ${item.name}`);
      }
      const llm = fakeLlm();
      await askWire(llm, { system: 's', tools: [], messages: [{ role: 'user', text: 'a' }] },
        { provider: 'p', model: 'm' });
      const sent = llm.calls[0];
      assert.ok(sent !== undefined, at('our ask reached the seam'));
      assert.equal(isRacoonsAskRequest(sent), true, at('our own ask is recognised'));
      assert.equal(captureMainRequest(sent), null, at('a racoons ask never becomes a seed'));
    } },
  { name: 'an assistant projection carries the source the host requires',
    async run(at) {
      // The host reads `message.source.replayState` on every assistant message
      // and throws on one with no source. The seed carries only `{role, text}`,
      // so the projection supplies the route it sends on — and no `replayState`,
      // which would name a response this ask never received.
      const llm = fakeLlm();
      await askWire(llm, { system: 's', tools: [], messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'a' },
        { role: 'tool', text: 'r' },
      ] }, { provider: 'p', model: 'm' });
      const sent = llm.calls[0];
      assert.ok(sent !== undefined, at('the ask reached the seam'));
      if (sent === undefined) return;
      assert.deepEqual(sent.messages.map(message => message['role']),
        ['user', 'assistant', 'user'], at('a tool turn rides as a user message'));
      assert.equal(sent.messages[0]?.['source'], undefined, at('a user message needs no source'));
      assert.deepEqual(sent.messages[1]?.['source'],
        { kind: 'model', provider: 'p', model: 'm' }, at('the assistant carries its route'));
      assert.equal('replayState' in (sent.messages[1]?.['source'] as object), false,
        at('no replay state is claimed for a projected turn'));
      assert.equal(sent.messages[2]?.['source'], undefined,
        at('a projected tool turn goes out as a user message'));
      assert.deepEqual(sent.messages[1]?.['content'], [{ type: 'text', text: 'a' }],
        at('the assistant text is the content'));
    } },
  { name: 'an explicit system slot is kept and tools are copied whole',
    run(at) {
      const tools = [{ name: 'read', description: 'read', parameters: { type: 'object' } }];
      const captured = captureMainRequest({ sessionId: 's1', system: 'SLOT', tools,
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'LEADING' }] },
          { role: 'user', content: [{ type: 'text', text: 'x' }] },
        ] });
      assert.ok(captured !== null, at('the request is shaped enough to seed'));
      if (captured === null) return;
      assert.equal(captured.wire.system, 'SLOT', at('the explicit slot is kept'));
      assert.deepEqual(captured.wire.messages[0], { role: 'system', text: 'LEADING' },
        at('a leading system message stays a message too'));
      assert.equal(captured.systemFromMessage, false, at('nothing was lifted into the slot'));
      assert.deepEqual(captured.wire.tools, tools, at('the tool list is copied whole'));
    } },
  { name: 'an unknown role is dropped and counted; a system message stays where it is',
    run(at) {
      const captured = captureMainRequest({ sessionId: 's1',
        messages: [
          { role: 'developer', content: [{ type: 'text', text: 'tool adds' }] },
          { role: 'system', content: [{ type: 'text', text: 'late system' }] },
          { role: 'user', content: [
            { type: 'text', text: 'look' }, { type: 'image', data: 'x' }] },
        ] });
      assert.ok(captured !== null, at('a partly shaped request still seeds'));
      if (captured === null) return;
      // Only the role the seed cannot carry is dropped: a `system` message is not.
      assert.equal(captured.droppedMessages, 1, at('the developer role is the one dropped'));
      assert.equal(captured.droppedBlocks, 1, at('the image block is dropped and counted'));
      assert.deepEqual(captured.wire.messages, [
        { role: 'system', text: 'late system' },
        { role: 'user', text: 'look' },
      ], at('the surviving messages keep their order'));
    } },
  { name: 'non-string tool-call arguments ride the seed or are counted dropped (ISSUE-352)',
    run(at) {
      // An object payload used to render '' and bypass the dropped counter:
      // the seed lost the call invisibly. It must serialize or be counted.
      const captured = captureMainRequest({ sessionId: 's1',
        messages: [
          { role: 'assistant', content: [
            { type: 'tool-call', name: 'read', arguments: { path: 'a', depth: 2 } },
            { type: 'tool-call', name: 'seek', arguments: 42 }] },
        ] });
      assert.ok(captured !== null, at('the request seeds'));
      if (captured === null) return;
      assert.equal(captured.wire.messages[0]?.text,
        '[tool call read {"path":"a","depth":2}][tool call seek 42]',
        at('object and number payloads are serialized into the turn'));
      assert.equal(captured.droppedBlocks, 0, at('a carried payload is not dropped'));
      // A payload JSON cannot carry is counted, never silently emptied.
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const lost = captureMainRequest({ sessionId: 's1',
        messages: [
          { role: 'assistant', content: [
            { type: 'tool-call', name: 'loop', arguments: circular }] },
        ] });
      assert.ok(lost !== null, at('the request still seeds'));
      if (lost === null) return;
      assert.equal(lost.droppedBlocks, 1, at('an unserializable payload is counted dropped'));
      assert.equal(lost.wire.messages[0]?.text, '', at('nothing is invented for the lost payload'));
    } },
  { name: 'a session-title request never becomes main\'s seed',
    run(at) {
      // dsh's title call is a second async request on the same session: one
      // system prompt, no tools, stamped `purpose: 'session-title'`. It must not
      // displace the conversation the fork seeds from (ISSUE-031).
      const capture = createMainWireCapture();
      capture.note({ sessionId: 's1', purpose: 'session-title', messages: [
        { role: 'system', content: [{ type: 'text', text: 'Write a title.' }] },
        { role: 'user', content: [{ type: 'text', text: 'make a title' }] },
      ] });
      assert.equal(capture.last('s1'), null, at('a title-only session has no main seed'));
      capture.note({ sessionId: 's1', messages: [
        { role: 'user', content: [{ type: 'text', text: 'main turn' }] }] });
      capture.note({ sessionId: 's1', purpose: 'session-title', messages: [
        { role: 'user', content: [{ type: 'text', text: 'title turn' }] }] });
      assert.equal(capture.last('s1')?.wire.messages[0]?.text, 'main turn',
        at('the title call leaves the previous main request in place'));
      assert.equal(captureMainRequest({ purpose: 'session-title', messages: [] }), null,
        at('a title-shaped capture is never a seed'));
    } },
  { name: 'evicting a session drops only its capture (ISSUE-350)',
    run(at) {
      // The store tracks live sessions: an ended session's capture is evicted,
      // never left to accumulate for the process lifetime. No size cap is involved.
      const capture = createMainWireCapture();
      for (const id of ['s1', 's2', 's3']) {
        capture.note({ sessionId: id, messages: [
          { role: 'user', content: [{ type: 'text', text: `main ${id}` }] }] });
      }
      capture.evict('s1');
      capture.evict('s3');
      assert.equal(capture.last('s1'), null, at('the evicted session has no capture'));
      assert.equal(capture.last('s3'), null, at('the second evicted session has no capture'));
      assert.equal(capture.last('s2')?.wire.messages[0]?.text, 'main s2',
        at('the live session keeps its capture'));
      assert.deepEqual(capture.sessionIds(), ['s2'],
        at('the key list names only the live capture (ISSUE-455)'));
      // Evicting a session never seen is a no-op, never a throw.
      capture.evict('never-seen');
      assert.equal(capture.last('s2')?.wire.messages[0]?.text, 'main s2',
        at('an unknown eviction leaves the live capture intact'));
    } },
];

test('the main capture keeps main\'s shape and refuses everything else', async () => {
  await runRows(ROWS);
});
