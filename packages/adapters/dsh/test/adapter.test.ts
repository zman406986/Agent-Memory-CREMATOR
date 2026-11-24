import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColdBoundary, EngineInput, EngineResult, ToolResultNode } from '@cremator/core';
import { sha256Sync } from '@cremator/core';
import { createDshAdapter } from '../src/adapter.js';
import type { DshAdapterPort, DshEngine } from '../src/adapter.js';
import { toCoreEnvelope } from '../src/envelope.js';
import type { DshToolResultItem } from '../src/envelope.js';
import { createDshPort } from '../src/port.js';
import type { DshContentBlock, DshRevertSession, DshSurfaceIntent,
  DshSurfaceNode } from '../src/revert.js';
import { clock, toolResult, unchanged } from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

function fakeEngine() {
  const calls: EngineInput[] = [];
  const recalls: string[] = [];
  const restored = { id: 'recall-1', manifestSha256: 'manifest',
    manifest: { version: 1 as const, sessionId: 'session-1', parts: [] }, parts: [] };
  const engine: DshEngine = {
    process: async input => { calls.push(input); return unchanged; },
    recall: async id => { recalls.push(id); return restored; },
  };
  return { calls, recalls, restored, engine };
}

// --- the answered checkpoint's two host writes (ISSUE-058 chunk P3a) ---------

/** A fake engine that records the entry inputs and answers with a fixed result. */
function answeringEngine(status: EngineResult['status']) {
  const calls: EngineInput[] = [];
  const engine: DshEngine = {
    process: async input => { calls.push(input); return { ...unchanged, status }; },
    recall: async () => ({ id: 'recall-1', manifestSha256: 'manifest',
      manifest: { version: 1 as const, sessionId: 'session-1', parts: [] }, parts: [] }),
  };
  return { calls, engine };
}

/** A fake surface seam: every append is recorded and spliced like dsh's replace. */
function fakeSurface(nodes: readonly DshSurfaceNode[]) {
  const appends: { type: string; intent: DshSurfaceIntent }[] = [];
  let live = [...nodes];
  let seq = nodes.reduce((max, node) => Math.max(max, node.seq + 1), 0);
  const session: DshRevertSession = {
    surface: () => live,
    nextSeq: () => seq,
    append: (type, _data, intent) => {
      const at = seq++;
      appends.push({ type, intent });
      const start = live.findIndex(node => node.seq === intent.surfaceOp.startSeq);
      const end = live.findIndex(node => node.seq === intent.surfaceOp.endSeq);
      live = [...live.slice(0, start), { ...live[start], seq: at, id: `written-${String(at)}` } as DshSurfaceNode,
        ...live.slice(end + 1)];
      return { seq: at };
    },
  };
  return { appends, session, surface: () => live };
}

/** The landed result the mount hands an answer: one tool result with a hit path. */
function landedResultNode(): ToolResultNode {
  const bytes = new TextEncoder().encode('alpha\nbeta\ngamma\n');
  const sha256 = sha256Sync(bytes);
  return { ...toCoreEnvelope(toolResult(), 3).node, id: 'result-1', callId: 'call-1',
    turnOrdinal: 1, stepOrdinal: 1, bytes, sha256, byteLength: bytes.length,
    evidence: { kind: 'read', target: null,
      source: { nodeId: 'result-1', sha256, byteLength: bytes.length },
      sourceRecallId: null,
      paths: [{ pathKey: 'src/landed.ts', displayPath: 'src/landed.ts', title: null,
        lineCount: 3, byteLength: bytes.length, outcome: 'hit' }] } };
}
const entryNode = landedResultNode();

/** The transcript item the port holds for that landed result. */
const landedItem = { id: 'result-1', role: 'tool' as const, callId: 'call-1', toolName: 'read',
  bytes: entryNode.bytes, turnOrdinal: 1, stepOrdinal: 1 };

function exchangeSurface() {
  const blocks = (text: string): readonly DshContentBlock[] => [{ type: 'text', text }];
  return fakeSurface([
    { id: 'assistant-1', seq: 0, type: 'assistant/message', blocks: [],
      data: { turn: 1, step: 1, message: { content: [] } } },
    { id: 'result-1', seq: 1, type: 'tool/result', callId: 'call-1',
      blocks: blocks('alpha\nbeta\ngamma\n'),
      data: { turn: 1, step: 1, message: { role: 'tool', content: blocks('alpha\nbeta\ngamma\n') } } },
    { id: 'ask-1', seq: 2, type: 'user/message',
      blocks: blocks('which lines do you keep?'),
      data: { turn: 1, step: 2, content: blocks('which lines do you keep?') } },
    { id: 'answer-1', seq: 3, type: 'user/message', blocks: blocks('{"keepall":true}'),
      data: { turn: 1, step: 2, content: blocks('{"keepall":true}') } },
  ]);
}

const ROWS: readonly Row[] = [
  // The hot seams hand the engine the exact kinds, and nothing more.
  { name: 'entry and at-rest seams delegate with exact engine input kinds',
    async run(at) {
      const fake = fakeEngine();
      const port = createDshPort({ sessionId: 'session-1', clock });
      const adapter = createDshAdapter({ engine: fake.engine, port, clock });
      const original = toolResult();
      assert.equal(await adapter.onToolResult('entry-event', original), unchanged);
      assert.equal(await adapter.onPreStep('step-event'), unchanged);
      const first = fake.calls[0];
      assert.equal(first?.kind, 'entry', at('the entry seam sends an entry input'));
      if (first?.kind === 'entry') {
        assert.equal(first.eventId, 'entry-event', at('the event id is forwarded'));
        assert.deepEqual(first.result.bytes, original.bytes, at('the bytes are forwarded'));
        assert.equal(first.result.callId, original.callId, at('the call id is forwarded'));
      }
      assert.deepEqual(fake.calls[1],
        { kind: 'at-rest', eventId: 'step-event', reason: 'step' }, at('the step seam is at-rest'));
    } },
  // A byte getter that throws proves the adapter never reads result bytes.
  { name: 'adapter never reads raw or normalized result bytes',
    async run(at) {
      const fake = fakeEngine();
      const raw: DshToolResultItem = { ...toolResult(),
        get bytes(): Uint8Array { throw new Error('Adapter inspected raw bytes'); } };
      const node: ToolResultNode = { ...toCoreEnvelope(toolResult(), 0).node,
        get bytes(): Uint8Array { throw new Error('Adapter inspected normalized bytes'); } };
      let deliveries = 0;
      const boundaries: ColdBoundary[] = [];
      const port: DshAdapterPort = {
        snapshot: async () => { throw new Error('Adapter queried snapshot'); },
        apply: async () => { throw new Error('Adapter applied a policy'); },
        lookupReceipt: async () => ({ status: 'unknown' }),
        transcript: () => [],
        setColdBoundary: boundary => { boundaries.push(boundary); },
        deliverToolResult: async (eventId, result, process) => {
          assert.equal(eventId, 'opaque-event', at('the event id reaches the port'));
          assert.equal(result, raw, at('the raw item reaches the port untouched'));
          deliveries += 1;
          return process(node);
        },
        recordAskExchange: () => { throw new Error('Adapter recorded an exchange'); },
        landedUnitId: () => null,
        takeEntryWrite: () => null,
        rewindAskExchange: () => { throw new Error('Adapter rewound a surface'); },
        applyEntryShape: () => { throw new Error('Adapter rewrote a surface'); },
      };
      const adapter = createDshAdapter({ engine: fake.engine, port, clock });
      assert.equal(await adapter.onToolResult('opaque-event', raw), unchanged);
      assert.equal(deliveries, 1, at('the delivery happened exactly once'));
      const call = fake.calls[0];
      assert.equal(call?.kind, 'entry', at('the normalized node is processed'));
      if (call?.kind === 'entry') {
        assert.equal(call.result, node, at('the node handed on is the port\'s own'));
      }
      assert.deepEqual(boundaries, [], at('no cold boundary is set by a tool result'));
    } },
  // Cold seams set the host cache state and forward their own reason.
  { name: 'cold seams set host cache state and forward reasons; recall is delegated',
    async run(at) {
      const fake = fakeEngine();
      const port = createDshPort({ sessionId: 'session-1', clock });
      const adapter = createDshAdapter({ engine: fake.engine, port, clock });
      await adapter.onResume('resume-event');
      assert.deepEqual((await port.snapshot()).cache,
        { kind: 'cold', boundary: { kind: 'resume', observedAtMs: 1234 } },
        at('a resume sets a cold boundary'));
      await adapter.onIdlePastTtl('idle-event');
      await adapter.onModelSwitch('model-event');
      assert.deepEqual(fake.calls, [
        { kind: 'at-rest', eventId: 'resume-event', reason: 'resume' },
        { kind: 'at-rest', eventId: 'idle-event', reason: 'idle-past-ttl' },
        { kind: 'at-rest', eventId: 'model-event', reason: 'model-switch' },
      ], at('each cold seam sends its own reason'));
      assert.equal(await adapter.recall('recall-1'), fake.restored,
        at('recall is delegated unchanged'));
      assert.deepEqual(fake.recalls, ['recall-1'], at('the id reaches the engine'));
    } },
  // A keep-all still asks the engine, then rewinds the exchange once.
  { name: 'a keep-all rewinds the exchange and plans no host application',
    async run(at) {
      const fake = answeringEngine('unchanged');
      const surface = exchangeSurface();
      const port = createDshPort({ sessionId: 'session-1', clock, transcript: [landedItem],
        revert: surface.session });
      const adapter = createDshAdapter({ engine: fake.engine, port, clock });
      const outcome = await adapter.onEntryAnswer('entry-event', entryNode,
        { resultNodeId: 'result-1', askNodeId: 'ask-1', answerNodeId: 'answer-1', summary: '' },
        { action: 'keepall' }, '{"keepall":true}');
      assert.equal(outcome.status, 'rewound', at('the answer reports a rewind'));
      // The engine was asked about the answer (so a keep-all is still a decision),
      // and the port performed the ONE rewind over the exchange's own range.
      assert.equal(fake.calls.length, 1, at('the engine was asked once'));
      const call = fake.calls[0];
      assert.equal(call?.kind, 'entry', at('the answer input is an entry input'));
      if (call?.kind === 'entry') {
        assert.deepEqual(call.answer, { action: 'keepall' }, at('the answer rides the input'));
        assert.equal(call.answerText, '{"keepall":true}', at('the raw text rides the input'));
        assert.ok(call.stamp, at('the landed unit is stamped'));
      }
      assert.equal(surface.appends.length, 1, at('exactly one host append'));
      assert.deepEqual(surface.appends[0]?.intent.surfaceOp,
        { op: 'replace', startSeq: 2, endSeq: 3 }, at('the rewind covers the exchange'));
    } },
];

test('every adapter seam delegates, and no seam inspects result bytes', async () => {
  await runRows(ROWS);
});
