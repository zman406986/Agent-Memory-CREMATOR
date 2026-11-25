import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fromCoreEnvelope, fromCoreTranscript, toCoreEnvelope, toCoreTranscript,
} from '../src/envelope.js';
import type { DshTranscriptItem } from '../src/envelope.js';
import { bytes, toolResult } from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

/**
 * The envelope seam's four claims, folded into one table: a round trip that
 * loses nothing, an independent byte copy on both directions, the same guarantee
 * for a Node `Buffer` ingress, and the two refusals (changed call pairing,
 * reordered envelopes). Each row differs only in the shape it feeds the seam,
 * so a red row names the shape it tried.
 */
const ROWS: readonly Row[] = [
  { name: 'round trip preserves bytes, roles, call IDs, ordering and every extra field',
    run(at) {
      const transcript: DshTranscriptItem[] = [
        { id: 'message-1', role: 'assistant', bytes: bytes('tool calls'),
          turnOrdinal: 0, stepOrdinal: 1, toolCallIds: ['call-1'],
          extra: { nested: [null, false, undefined, { binary: new Uint8Array([0, 255]) }] } },
        toolResult(),
        { id: 'boundary', role: 'system', bytes: bytes('opaque host boundary'),
          turnOrdinal: 0, stepOrdinal: 2, nativeBoundary: true },
        { id: 'own-record', role: 'system', bytes: new Uint8Array([0, 255, 13, 10]),
          recordId: 'own-record', turnOrdinal: 0, stepOrdinal: 2, hostOrder: 99 },
      ];
      const restored = fromCoreTranscript(toCoreTranscript(transcript));
      assert.deepEqual(restored, transcript, at('the transcript survives the round trip'));
      assert.deepEqual(restored.map(item => item.id),
        ['message-1', 'result-1', 'boundary', 'own-record'], at('the order is preserved'));
      // The UTF-8 BOM, the CRLF and the multi-byte character survive as bytes.
      assert.deepEqual(restored[1]?.bytes,
        new Uint8Array([239, 187, 191, 97, 13, 10, 233, 155, 170, 10]),
        at('the fixture bytes are reproduced byte for byte'));
    } },
  { name: 'mapping does not alias original bytes or nested passthrough fields',
    run(at) {
      const original = toolResult();
      const envelope = toCoreEnvelope(original, 0);
      envelope.node.bytes.fill(0);
      assert.deepEqual(original.bytes, bytes('\uFEFFa\r\n雪\n'),
        at('writing the envelope bytes leaves the original alone'));
      const restored = fromCoreEnvelope(toCoreEnvelope(original, 0));
      restored.bytes.fill(1);
      assert.deepEqual(original.bytes, bytes('\uFEFFa\r\n雪\n'),
        at('writing the restored bytes leaves the original alone'));
      assert.deepEqual(restored['hostData'], original['hostData'],
        at('the passthrough field is equal by value'));
      assert.notEqual(restored['hostData'], original['hostData'],
        at('the passthrough field is a distinct object'));
    } },
  { name: 'Node Buffer ingress also receives an independent byte copy',
    run(at) {
      const original = { ...toolResult(), bytes: Buffer.from([0, 255, 13, 10]) };
      const envelope = toCoreEnvelope(original, 0);
      envelope.node.bytes.fill(0);
      assert.deepEqual([...original.bytes], [0, 255, 13, 10],
        at('a Buffer ingress is copied, never aliased'));
    } },
  { name: 'changed call pairing and reordered envelopes are rejected',
    run(at) {
      const envelope = toCoreEnvelope(toolResult(), 0);
      assert.throws(() => fromCoreEnvelope({ ...envelope,
        node: { ...envelope.node, callId: 'wrong-call' } }), /pairing/,
      at('a changed call id is refused by name'));
      const first = toCoreEnvelope(toolResult('first'), 0);
      const second = toCoreEnvelope(toolResult('second'), 1);
      assert.throws(() => fromCoreTranscript([second, first]), /ordering/,
        at('a reordered pair is refused by name'));
    } },
  // ISSUE-151: the call's declared argument payload is bytes on the result
  // node, and its absence is not turned into an empty declaration.
  { name: 'a declared call argument payload maps to bytes and stays absent when undeclared',
    run(at) {
      const argumentText = '{"todos":[{"content":"one"}]}';
      const declared = toCoreEnvelope({ ...toolResult(), callArguments: argumentText }, 0);
      assert.equal(declared.node.kind, 'tool-result', at('the item maps to a tool result'));
      assert.equal(declared.node.kind === 'tool-result'
        ? new TextDecoder().decode(declared.node.callArguments) : null, argumentText,
      at('the declared payload reaches the node verbatim'));
      const restored = fromCoreEnvelope(declared);
      assert.equal(restored['callArguments'], argumentText,
        at('the round trip keeps the host declaration'));
      const undeclared = toCoreEnvelope(toolResult(), 0);
      assert.equal(undeclared.node.kind === 'tool-result'
        && 'callArguments' in undeclared.node, false,
      at('an undeclared payload keeps the key absent'));
    } },
  // ISSUE-149: the host's declared source reaches the Core node unchanged.
  { name: 'a declared source maps onto the node as provenance',
    run(at) {
      const message: DshTranscriptItem = { id: 'message-1', role: 'user', bytes: bytes('declared'),
        turnOrdinal: 0, stepOrdinal: 1,
        provenance: { sourceKind: 'user', familyId: 'family-1' } };
      const envelope = toCoreEnvelope(message, 0);
      assert.equal(envelope.node.kind, 'message', at('the item maps to a message node'));
      assert.deepEqual(envelope.node.kind === 'message' ? envelope.node.provenance : undefined,
        { sourceKind: 'user', familyId: 'family-1' }, at('the declared provenance reaches the node'));
      const restored = fromCoreEnvelope(envelope);
      assert.deepEqual(restored['provenance'], { sourceKind: 'user', familyId: 'family-1' },
        at('the round trip keeps the declared provenance'));
    } },
  // Absence is meaningful: no declaration, no key, no inferred kind.
  { name: 'an item with no declared source yields a node with no provenance key',
    run(at) {
      const message: DshTranscriptItem = { id: 'message-1', role: 'user', bytes: bytes('undeclared'),
        turnOrdinal: 0, stepOrdinal: 1 };
      const envelope = toCoreEnvelope(message, 0);
      assert.equal(envelope.node.kind === 'message' && 'provenance' in envelope.node, false,
        at('an undeclared message keeps the key absent'));
      const restored = fromCoreEnvelope(envelope);
      assert.equal('provenance' in restored, false,
        at('the round trip does not invent a provenance'));
    } },
];

test('the envelope round trip is lossless, unaliased and refuses a broken pairing', async () => {
  await runRows(ROWS);
});
