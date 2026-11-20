import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ApplyRequest, ArchiveRecord, KeptLineSpan, ProcessingUnit, RenderedRecord, ValidatedRevert,
  Verdict,
} from '@cremator/core';
import {
  canonicalManifestBytes, deriveVerdictRemoval, sha256Sync, splitLineOffsets,
} from '@cremator/core';
import type { DshTranscriptItem } from '../src/envelope.js';
import { composeEntryShapeTurn, createDshPort, entryShapePrefix } from '../src/port.js';
import type {
  DshAppendableType, DshContentBlock, DshRevertSession, DshSurfaceIntent, DshSurfaceNode,
  DshSurfaceType,
} from '../src/revert.js';
import { planRevertAppend, revertPlanSha256 } from '../src/revert.js';
import { applicationRequest, bytes, clock, hash, record, toolResult, unchanged } from './fixtures.js';












// --- a keeplines verdict through the port (ISSUE-017 wiring) ----------------

const encoder = new TextEncoder();
const BODY = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n';
const RECEIPT_TEXT = '[not retained] big.ts · necromancy recall:sha256:aa';

function textBlock(value: string): DshContentBlock {
  return { type: 'text', text: value };
}

/** One surface node as dsh exposes it: identity, type, blocks and the payload it rebuilds from. */
function surfaceNode(
  id: string, seq: number, type: DshSurfaceType, blocks: readonly DshContentBlock[],
  callId?: string,
): DshSurfaceNode {
  const data: Record<string, unknown> = type === 'user/message'
    ? { content: blocks, source: { kind: 'user' }, role: 'user', id }
    : { turn: 1, step: seq, message: {
        id, role: type === 'tool/result' ? 'tool' : type.replace('/message', ''),
        content: blocks,
        ...(callId === undefined ? {} : { toolCallId: callId, source: { kind: 'tool', callId } }),
      } };
  return { id, seq, type, blocks, ...(callId === undefined ? {} : { callId }), data };
}

/** The same five-node session the revert tests use, with a six-line result at index 3. */
function keeplinesFixture(): { surface: readonly DshSurfaceNode[]; items: readonly DshTranscriptItem[] } {
  return {
    surface: [surfaceNode('system-1', 0, 'system/message', [textBlock('system prompt')]),
      surfaceNode('user-1', 1, 'user/message', [textBlock('read big.ts')]),
      surfaceNode('assistant-1', 2, 'assistant/message', [textBlock('reading'),
        { type: 'tool-call', id: 'call-1' }]),
      surfaceNode('result-1', 3, 'tool/result', [textBlock(BODY)], 'call-1'),
      surfaceNode('user-2', 4, 'user/message', [textBlock('next question')])],
    items: [{ id: 'system-1', role: 'system', bytes: bytes('system prompt'), turnOrdinal: 1, stepOrdinal: 1 },
      { id: 'user-1', role: 'user', bytes: bytes('read big.ts'), turnOrdinal: 1, stepOrdinal: 1 },
      { id: 'assistant-1', role: 'assistant', bytes: bytes('reading'), turnOrdinal: 1, stepOrdinal: 1,
        toolCallIds: ['call-1'] },
      { id: 'result-1', role: 'tool', callId: 'call-1', toolName: 'read', bytes: bytes(BODY),
        turnOrdinal: 1, stepOrdinal: 1 },
      { id: 'user-2', role: 'user', bytes: bytes('next question'), turnOrdinal: 1, stepOrdinal: 1 }],
  };
}

/** The host seam: records the one append and splices the surface like dsh's `replace`. */
class FakeSession implements DshRevertSession {
  readonly appends: { readonly type: DshAppendableType;
    readonly data: Readonly<Record<string, unknown>>;
    readonly intent: DshSurfaceIntent }[] = [];
  #nodes: readonly DshSurfaceNode[];

  constructor(nodes: readonly DshSurfaceNode[]) { this.#nodes = nodes; }

  surface(): readonly DshSurfaceNode[] { return this.#nodes; }
  nextSeq(): number { return this.#nodes.reduce((max, node) => Math.max(max, node.seq + 1), 0); }

  append(type: DshAppendableType, data: Readonly<Record<string, unknown>>,
    intent: DshSurfaceIntent): { readonly seq: number } {
    this.appends.push(structuredClone({ type, data, intent }));
    const startIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.startSeq);
    const endIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.endSeq);
    this.#nodes = [...this.#nodes.slice(0, startIdx),
      { id: 'replacement', seq: this.nextSeq(), type, blocks: [], data }, ...this.#nodes.slice(endIdx + 1)];
    return { seq: this.nextSeq() };
  }
}

function receipt(recordId: string, body: string): RenderedRecord {
  const body_ = encoder.encode(body);
  return { recordId, bytes: body_, sha256: hash(body_) };
}

/** One whole-result unit over the six-line body, the shape the tracker builds. */
function wholeResultUnit(body: string): ProcessingUnit {
  const encoded = encoder.encode(body);
  return { id: 'unit:sha256:one', nodeId: 'result-1',
    source: { nodeId: 'result-1', sha256: hash(encoded), byteLength: encoded.length },
    path: 'src/x.ts',
    span: { byteRange: { startByte: 0, endByteExclusive: encoded.length },
      lineRange: { startLine: 1, endLineInclusive: splitLineOffsets(encoded).length } },
    byteLength: encoded.length };
}

/** The verdict archive the core planner builds: whole body plus the derived removal, hashed. */
function verdictArchive(
  unit: ProcessingUnit, ranges: readonly KeptLineSpan[], body: Uint8Array,
): ArchiveRecord {
  const verdict: Verdict = { unitId: unit.id, action: 'keeplines', ranges,
    answeredInRound: 1 };
  const derived = deriveVerdictRemoval(unit, verdict, body);
  assert.ok(derived !== null, 'the fixture answer must derive a removal');
  const removedRanges = derived.byteRanges.map(range => ({ range: { ...range },
    sha256: hash(body.slice(range.startByte, range.endByteExclusive)) }));
  const source = { ...unit.source };
  const blobSha256 = hash(body);
  const manifest = { version: 1 as const, sessionId: 'session-1',
    parts: [{ source, blobSha256, removedRanges }] };
  const manifestSha256 = sha256Sync(canonicalManifestBytes(manifest));
  const record = { id: `recall:sha256:${manifestSha256}`, manifestSha256, manifest,
    parts: [{ source, bytes: body, removedRanges }] };
  return { ruleId: 'verdict', removalId: unit.id, operationKind: 'verdict',
    episodeId: null, title: 'not retained src/x.ts', recall: record };
}

/** The cap-style plan: forget the result at surface index 3, keep the newer user turn. */
function keeplinesPlan(): ValidatedRevert {
  const plan = { unitIds: ['unit:sha256:one'], cutIndex: 3, survivors: ['user-2'],
    appends: [{ afterNodeId: 'assistant-1', noteId: 'racoons:receipt-1' }],
    perNode: [{ nodeId: 'result-1', noteId: 'racoons:receipt-1' }],
    cost: { cutIndex: 3, freedBytes: 5000, keptBytes: 13, receiptBytes: 1, netFreedBytes: 4986 },
    baseRevision: '0:0' };
  const unsealed = { ...plan, planSha256: '' } as ValidatedRevert;
  return { ...plan, planSha256: revertPlanSha256(unsealed) } as ValidatedRevert;
}

function keeplinesRequest(
  plan: ValidatedRevert, baseRevision: string, archives: readonly ArchiveRecord[],
): ApplyRequest {
  const body = encoder.encode(RECEIPT_TEXT);
  const application = {
    sessionId: 'session-1', eventId: 'verdict-event', baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: 'application-1', replacements: [],
    appendRecords: [receipt('racoons:receipt-1', RECEIPT_TEXT)],
    archives, sealedEpisodeIds: [], createdAtMs: 1234, revert: plan,
  } as unknown as ApplyRequest['application'];
  return { application, intent: { intentId: 'intent-1', sessionId: 'session-1',
    eventId: 'verdict-event', baseRevision, applicationSha256: 'application-1' } };
}

/** The rebuilt blocks the one append carries, in order. */
function appendedText(session: FakeSession): readonly string[] {
  assert.equal(session.appends.length, 1, 'exactly one host append');
  const append = session.appends[0];
  assert.ok(append !== undefined);
  const content = append.type === 'user/message'
    ? append.data['content']
    : (append.data['message'] as { content?: unknown } | undefined)?.content;
  assert.ok(Array.isArray(content));
  return (content as readonly DshContentBlock[]).map(block => block.text ?? '');
}




// --- the answered checkpoint's host writes (ISSUE-058 chunk P3a; ADR-0022 §11–§12)

/**
 * The surface of an ask exchange over the six-line landed result: the result
 * turn, the instruction turn, and the answer turn. `blocksOf` rebuilds a
 * replacement node's blocks from the data it carries, so a rewrite is visible to
 * the surface exactly as a host would see it.
 */
function exchangeFixture(): { surface: readonly DshSurfaceNode[]; items: readonly DshTranscriptItem[] } {
  const base = keeplinesFixture();
  return {
    surface: [...base.surface.slice(0, 4),
      surfaceNode('ask-1', 4, 'user/message', [textBlock('which lines do you keep?')]),
      surfaceNode('answer-1', 5, 'user/message', [textBlock('{"keepall":true}')])],
    items: base.items,
  };
}

/** A host seam that rebuilds what it splices, so the surface reads like dsh's. */
class ExchangeSession implements DshRevertSession {
  readonly appends: { readonly type: DshAppendableType;
    readonly data: Readonly<Record<string, unknown>>;
    readonly intent: DshSurfaceIntent }[] = [];
  #nodes: readonly DshSurfaceNode[];
  #seq: number;

  constructor(nodes: readonly DshSurfaceNode[]) {
    this.#nodes = nodes;
    this.#seq = nodes.reduce((max, node) => Math.max(max, node.seq + 1), 0);
  }

  surface(): readonly DshSurfaceNode[] { return this.#nodes; }
  nextSeq(): number { return this.#seq; }

  append(type: DshAppendableType, data: Readonly<Record<string, unknown>>,
    intent: DshSurfaceIntent): { readonly seq: number } {
    const seq = this.#seq++;
    this.appends.push(structuredClone({ type, data, intent }));
    const startIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.startSeq);
    const endIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.endSeq);
    const content = type === 'user/message'
      ? data['content']
      : (data['message'] as { content?: unknown } | undefined)?.content;
    const blocks: readonly DshContentBlock[] = Array.isArray(content)
      ? (content as readonly DshContentBlock[]).map(block => ({
          type: block.type,
          ...(typeof block.text === 'string' ? { text: block.text } : {}),
        }))
      : [];
    this.#nodes = [...this.#nodes.slice(0, startIdx),
      { id: `written-${String(seq)}`, seq, type, blocks, data },
      ...this.#nodes.slice(endIdx + 1)];
    return { seq };
  }
}

const EXCHANGE = { resultNodeId: 'result-1', askNodeId: 'ask-1', answerNodeId: 'answer-1',
  summary: '' };

test('a moved transcript revision refuses the entire request', async () => {
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: [toolResult()] });
  const request = applicationRequest((await port.snapshot()).revision, { appendRecords: [record()] });
  port.setTranscript([...port.transcript(), { id: 'next', role: 'user', bytes: bytes('next'),
    turnOrdinal: 1, stepOrdinal: 2 }]);
  const before = port.transcript();
  assert.deepEqual(await port.apply(request), { status: 'not-applied', reason: 'stale-revision' });
  assert.deepEqual(port.transcript(), before);
  assert.deepEqual(await port.lookupReceipt(request.intent.intentId), { status: 'unknown' });
});

test('an intent this process never saw answers unknown, never not-applied', async () => {
  const port = createDshPort({ sessionId: 'session-1', clock });
  assert.deepEqual(await port.lookupReceipt('intent-never-seen'), { status: 'unknown' });
});

test('both injected failures leave the complete transcript byte-identical', async () => {
  for (const failApply of ['not-applied', 'unknown'] as const) {
    const port = createDshPort({ sessionId: 'session-1', clock, failApply, transcript: [toolResult()] });
    const before = await port.snapshot();
    const original = port.transcript();
    const request = applicationRequest(before.revision, { appendRecords: [record()] });
    assert.deepEqual(await port.apply(request), failApply === 'unknown' ? { status: 'unknown' }
      : { status: 'not-applied', reason: 'host-error' });
    assert.deepEqual(await port.snapshot(), before);
    assert.deepEqual(port.transcript(), original);
    // Absence from this process's map is unknown, never a refusal (ISSUE-030 R1).
    assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' });
  }
});

test('a landed entry is read, never inserted, and host getters return independent copies', async () => {
  const original = toolResult();
  // Land-first (ISSUE-058 chunk P3a; ADR-0022 §2): the host wrote the result
  // before the entry seam ran, so a delivery must not insert a second copy.
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: [original] });
  await port.deliverToolResult('event-1', original, async node => {
    assert.equal(node.id, original.id);
    return unchanged;
  });
  await port.deliverToolResult('event-1', original, async () => unchanged);
  assert.deepEqual(port.transcript(), [original], 'one host result is one transcript node');
  const copy = port.transcript();
  copy[0]?.bytes.fill(0);
  const snapshot = await port.snapshot();
  snapshot.nodes[0]?.bytes.fill(0);
  assert.deepEqual(port.transcript(), [original]);
});

test('a keeplines verdict through applyRevert keeps its lines byte-for-byte', async () => {
  const fixture = keeplinesFixture();
  const unit = wholeResultUnit(BODY);
  const archive = verdictArchive(unit, [{ from: 1, to: 2 }], encoder.encode(BODY));
  const session = new FakeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items,
    revert: session });
  const before = await port.snapshot();
  const result = await port.apply(keeplinesRequest(keeplinesPlan(), before.revision, [archive]));
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;

  // The kept bytes are the source's first two lines exactly, then the receipt.
  const rebuilt = appendedText(session);
  assert.deepEqual(rebuilt, ['alpha\nbeta\n', RECEIPT_TEXT],
    'kept lines first, then the receipt that marks the removal');
  const source = encoder.encode(BODY);
  assert.deepEqual(encoder.encode(rebuilt[0] ?? ''), source.slice(0, encoder.encode('alpha\nbeta\n').length),
    'kept bytes are byte-identical to the source, not re-rendered text');

  // The port's ledger view drops the forgotten node and carries the receipt record.
  assert.deepEqual(port.transcript().map(item => item.id),
    ['system-1', 'user-1', 'assistant-1', 'racoons:receipt-1', 'user-2']);
  assert.deepEqual(await port.lookupReceipt('intent-1'),
    { status: 'applied', receipt: result.receipt });
});

test('keep-all rewinds exactly the ask exchange and leaves the result turn untouched', async () => {
  const fixture = exchangeFixture();
  const session = new ExchangeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const outcome = port.rewindAskExchange({ ...EXCHANGE, summary: '' });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
  // ONE atomic host write over the exchange's own range, and nothing else.
  assert.equal(session.appends.length, 1);
  const append = session.appends[0];
  assert.ok(append !== undefined);
  assert.deepEqual(append.intent.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 5 });
  assert.deepEqual([...append.intent.sourceEventSeqs], [4, 5]);
  // The range leaves the model wire: the replacement projects to no message.
  const blocks = session.surface().find(node => node.seq === 6)?.blocks ?? [];
  assert.deepEqual(blocks, [], 'a contentless node is how a range leaves the wire');
  // The landed result keeps its bytes and its id.
  const result = session.surface().find(node => node.id === 'result-1');
  assert.deepEqual(result?.blocks, [{ type: 'text', text: BODY }]);
  assert.ok(port.transcript().some(item => item.id === 'result-1'));
  assert.equal(port.transcript().some(item => item.id === 'ask-1'), false);
  assert.equal(port.transcript().some(item => item.id === 'answer-1'), false);
});

test('an entry application consumes the recorded exchange and lands the shaped turn', async () => {
  const fixture = exchangeFixture();
  const session = new ExchangeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const shaped = bytes('alpha\nbeta\n[racoons] kept lines 1-2 of 6 dot 20 bytes dropped dot necromancy recall:sha256:aa\n');
  port.recordAskExchange('event-1', { ...EXCHANGE, summary: 'stale run notes' });
  const before = await port.snapshot();
  const request = applicationRequest(before.revision, { eventId: 'event-1',
    mode: 'entry', phase: 'entry',
    replacements: [{ source: { nodeId: 'result-1', sha256: hash(bytes(BODY)), byteLength: bytes(BODY).length },
      bytes: shaped, sha256: hash(shaped), retainedCopies: [],
      generatedRanges: [{ startByte: 11, endByteExclusive: 20 }], evidenceRecallId: 'recall:sha256:aa' }] });
  const applied = await port.apply(request);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.equal(session.appends.length, 2, 'the rewind and the new turn');
  const prefix = 'stale run notes\n\n';
  const landed = port.transcript().find(item => item.id === 'result-1');
  assert.deepEqual(landed?.bytes, bytes(`${prefix}${new TextDecoder().decode(shaped)}`));
  // The marker range the guard approved is shifted by the summary prefix the
  // turn now opens with, so both boundaries stay on the marker.
  assert.deepEqual(landed?.['embeddedRecords'], [{ startByte: 11 + prefix.length,
    endByteExclusive: 20 + prefix.length }]);
  const write = port.takeEntryWrite();
  assert.equal(write?.status, 'applied');
  assert.equal(port.takeEntryWrite(), null, 'the write is consumed once');
});

test('a second-append failure forgets the exchange so a later intent reads no stale entry '
  + '(ISSUE-351)', async () => {
  // The rewind commits and the shaped turn's append throws: the fail-open catch
  // must forget the exchange exactly as the applied path does. A later intent
  // under the SAME event id then finds no record and publishes no write — before
  // the fix the stale record survived and its refusal rode the slot.
  const fixture = exchangeFixture();
  class ThrowingSession extends ExchangeSession {
    #calls = 0;
    override append(type: DshAppendableType, data: Readonly<Record<string, unknown>>,
      intent: DshSurfaceIntent): { readonly seq: number } {
      this.#calls += 1;
      if (this.#calls === 2) throw new Error('the shaped-turn append failed');
      return super.append(type, data, intent);
    }
  }
  const session = new ThrowingSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items,
    revert: session });
  const shaped = bytes('alpha\nbeta\n[racoons] kept lines 1-2 of 6 dot 20 bytes dropped dot necromancy recall:sha256:aa\n');
  const replacement = { source: { nodeId: 'result-1', sha256: hash(bytes(BODY)),
    byteLength: bytes(BODY).length }, bytes: shaped, sha256: hash(shaped), retainedCopies: [],
    generatedRanges: [{ startByte: 11, endByteExclusive: 20 }], evidenceRecallId: 'recall:sha256:aa' };
  port.recordAskExchange('event-1', { ...EXCHANGE, summary: 'stale run notes' });
  const before = await port.snapshot();
  const failed = await port.apply(applicationRequest(before.revision,
    { eventId: 'event-1', mode: 'entry', phase: 'entry', replacements: [replacement] }));
  assert.equal(failed.status, 'unknown', JSON.stringify(failed));
  assert.equal(session.appends.length, 1, 'the rewind committed; the shaped turn threw');
  assert.equal(port.takeEntryWrite()?.status, 'unknown', 'the fail-open write is the unknown outcome');
  // A later intent under the same event id, on the post-failure revision.
  const after = await port.snapshot();
  const later = await port.apply(applicationRequest(after.revision,
    { eventId: 'event-1', mode: 'entry', phase: 'entry', replacements: [replacement] }, 'intent-2'));
  assert.equal(later.status, 'not-applied', JSON.stringify(later));
  assert.equal(port.takeEntryWrite(), null,
    'the exchange was forgotten: no stale entry survived to publish a write');
});

test('ordinal and cache changes also invalidate a prepared revision', async () => {
  const port = createDshPort({ sessionId: 'session-1', clock });
  const request = applicationRequest((await port.snapshot()).revision);
  port.updateState({ currentTurnOrdinal: 1 });
  assert.deepEqual(await port.apply(request), { status: 'not-applied', reason: 'stale-revision' });
  const next = applicationRequest((await port.snapshot()).revision);
  port.setColdBoundary({ kind: 'resume', observedAtMs: 1234 });
  assert.deepEqual(await port.apply(next), { status: 'not-applied', reason: 'stale-revision' });
});

test('repeating an intent, including concurrent calls, returns one immutable receipt', async () => {
  const port = createDshPort({ sessionId: 'session-1', clock });
  const request = applicationRequest((await port.snapshot()).revision, { appendRecords: [record()] });
  const [first, second] = await Promise.all([port.apply(request), port.apply(request)]);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  if (first.status !== 'applied' || second.status !== 'applied') throw new Error('Apply refused');
  assert.equal(first.receipt, second.receipt);
  assert.equal(Object.isFrozen(first.receipt), true);
  assert.equal(port.transcript().length, 1);
  assert.deepEqual(await port.lookupReceipt('intent-1'), first);
  const snapshot = await port.snapshot();
  assert.equal(snapshot.revision, first.receipt.resultRevision);
  assert.deepEqual(await port.apply(request), first);
  assert.deepEqual(await port.snapshot(), snapshot);
  assert.deepEqual(await port.apply({ ...request,
    intent: { ...request.intent, applicationSha256: 'conflicting' } }),
  { status: 'not-applied', reason: 'host-error' });
});

test('M1 mode matrix publishes an append and refuses every history mode', async () => {
  const original = toolResult();
  const publications: unknown[] = [];
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: [original],
    publish: (request, candidate) => publications.push(structuredClone({ mode: request.application.mode, candidate })) });
  // Entry mode no longer has a staging path: an answered checkpoint's host
  // write is the port's own rewind-and-append (ADR-0022 §12), exercised below.
  assert.deepEqual(await port.apply(applicationRequest((await port.snapshot()).revision,
    { mode: 'entry', phase: 'entry' }, 'intent-entry')),
  { status: 'not-applied', reason: 'host-error' });
  assert.equal(publications.length, 0);
  const append = applicationRequest((await port.snapshot()).revision,
    { appendRecords: [record()] }, 'intent-2');
  assert.equal((await port.apply(append)).status, 'applied');
  assert.equal(port.transcript().length, 2);
  assert.deepEqual(port.transcript()[0], original);
  assert.equal(publications.length, 1);
  const before = await port.snapshot();
  for (const mode of ['rewrite', 'rehydrate'] as const) {
    assert.deepEqual(await port.apply(applicationRequest(before.revision, { mode }, `intent-${mode}`)),
      { status: 'not-applied', reason: 'unsupported' });
    assert.deepEqual(await port.snapshot(), before);
    assert.equal(publications.length, 1);
  }
});

test('unknown host publication is never replayed or reported as not-applied', async () => {
  let publications = 0;
  const port = createDshPort({ sessionId: 'session-1', clock, publish: () => {
    publications += 1;
    throw new Error('host outcome unknown');
  } });
  const request = applicationRequest((await port.snapshot()).revision, { appendRecords: [record()] });
  assert.deepEqual(await port.apply(request), { status: 'unknown' });
  assert.deepEqual(await port.apply(request), { status: 'unknown' });
  assert.deepEqual(await port.lookupReceipt(request.intent.intentId), { status: 'unknown' });
  assert.equal(publications, 1);
});

test('perturbation: the same keeplines verdict without its archives keeps no lines', async () => {
  const fixture = keeplinesFixture();
  const session = new FakeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items,
    revert: session });
  const before = await port.snapshot();
  const result = await port.apply(keeplinesRequest(keeplinesPlan(), before.revision, []));
  assert.equal(result.status, 'applied');
  // Without the archive the port has nothing to copy; the rebuild is the
  // receipt alone. This is the exact failure wiring the set removes, so the
  // assertion above is what turns red if the port stops passing the keeps.
  const rebuilt = appendedText(session);
  assert.deepEqual(rebuilt, [RECEIPT_TEXT]);
  assert.throws(() => assert.deepEqual(rebuilt, ['alpha\nbeta\n', RECEIPT_TEXT]),
    'a port that drops the kept set must fail the byte-preservation assertion');
});

test('any forget rewinds past the result turn and lands ONE new turn', async () => {
  const fixture = exchangeFixture();
  const session = new ExchangeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const shaped = bytes('alpha\nbeta\n[racoons] kept lines 1–2 of 6 · 20 bytes dropped · necromancy recall:sha256:aa\n');
  const outcome = port.applyEntryShape({ ...EXCHANGE, summary: 'stale run notes' }, shaped);
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
  // The exchange is rewound, then the result turn becomes the new turn.
  assert.equal(session.appends.length, 2);
  assert.deepEqual(session.appends[0]?.intent.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 5 });
  assert.deepEqual(session.appends[1]?.intent.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 },
    'a tool/result replacement must rewrite exactly one node');
  const text = session.surface().find(node => node.seq === (outcome.seq))?.blocks[0]?.text ?? '';
  assert.equal(text, `stale run notes\n\n${new TextDecoder().decode(shaped)}`);
  // The original bytes are nowhere on the surface, and the transcript mirrors
  // the new turn: one landed turn, no exchange.
  assert.equal(text.includes(BODY), false, 'the original bytes never reach the wire again');
  const landed = port.transcript().find(item => item.id === 'result-1');
  assert.deepEqual(landed?.bytes, bytes(`stale run notes\n\n${new TextDecoder().decode(shaped)}`));
  assert.deepEqual(port.transcript().map(item => item.id),
    ['system-1', 'user-1', 'assistant-1', 'result-1', 'user-2']);
});

test('a refused entry write leaves the surface and the transcript untouched', async () => {
  const fixture = exchangeFixture();
  const session = new ExchangeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const cases: readonly { readonly exchange: Parameters<typeof port.rewindAskExchange>[0];
    readonly code: string }[] = [
    { exchange: { ...EXCHANGE, askNodeId: 'no-such-turn' }, code: 'ask-exchange-missing' },
    { exchange: { ...EXCHANGE, answerNodeId: 'no-such-turn' }, code: 'ask-exchange-missing' },
    { exchange: { ...EXCHANGE, askNodeId: 'answer-1', answerNodeId: 'ask-1' },
      code: 'span-not-contiguous' },
    { exchange: { ...EXCHANGE, askNodeId: 'result-1' }, code: 'span-not-contiguous' },
  ];
  for (const { exchange, code } of cases) {
    const outcome = port.rewindAskExchange({ ...exchange, summary: '' });
    assert.equal(outcome.status, 'refused', `${code}: ${JSON.stringify(outcome)}`);
    if (outcome.status === 'refused') assert.equal(outcome.code, code);
  }
  assert.equal(session.appends.length, 0, 'a refusal writes nothing');
  assert.deepEqual(port.transcript(), fixture.items);
});

test('a forget refuses when the surface result differs from the body the answer judged', async () => {
  const fixture = exchangeFixture();
  const changed = fixture.surface.map(node => node.id !== 'result-1' ? node
    : { ...node, blocks: [{ type: 'text', text: 'someone else' }] });
  const session = new ExchangeSession(changed);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const outcome = port.applyEntryShape({ ...EXCHANGE, summary: 'x' }, bytes('kept\n'));
  assert.equal(outcome.status, 'refused');
  if (outcome.status === 'refused') assert.equal(outcome.code, 'result-turn-changed');
  assert.equal(session.appends.length, 0);
});

test('a forget without a host seam refuses, and an empty shaped body refuses by name', async () => {
  const fixture = exchangeFixture();
  const bare = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items });
  for (const outcome of [bare.rewindAskExchange({ ...EXCHANGE, summary: '' }),
    bare.applyEntryShape({ ...EXCHANGE, summary: 'x' }, bytes('kept\n'))]) {
    assert.equal(outcome.status, 'refused');
    if (outcome.status === 'refused') assert.equal(outcome.code, 'no-host-seam');
  }
  const session = new ExchangeSession(fixture.surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items, revert: session });
  const empty = port.applyEntryShape({ ...EXCHANGE, summary: 'x' }, new Uint8Array(0));
  assert.equal(empty.status, 'refused');
  if (empty.status === 'refused') assert.equal(empty.code, 'empty-turn');
  assert.equal(session.appends.length, 0);
});

// --- the rewound exchange of a batch (ISSUE-117 chunk B3; ADR-0035 §5) ------

test('a rewound exchange applies rows 2..N after the first unit took the exchange away', () => {
  // A batch asks N results under ONE ask turn and ONE answer, so unit 1's write
  // rewinds the exchange and every later unit finds no ask turn to look for. The
  // port must locate such a row's result by `resultNodeId` alone and append its
  // shaped turn WITHOUT a second rewind. The surface of a real batch is modelled
  // here as the exchange plus TWO landed results, both before the ask.
  const base = keeplinesFixture();
  const second = surfaceNode('result-2', 5, 'tool/result',
    [textBlock('one\ntwo\nthree\nfour\nfive\nsix\n')], 'call-2');
  const surface = [...base.surface.slice(0, 4), second,
    surfaceNode('ask-1', 6, 'user/message', [textBlock('which rows do you keep?')]),
    surfaceNode('answer-1', 7, 'user/message', [textBlock('{"1":{"keepall":true},"2":{"forgetall":"x"}}')])];
  const items = [...base.items, { id: 'result-2', role: 'tool' as const, callId: 'call-2',
    toolName: 'read', bytes: bytes('one\ntwo\nthree\nfour\nfive\nsix\n'),
    turnOrdinal: 1, stepOrdinal: 1 }];
  const session = new ExchangeSession(surface);
  const port = createDshPort({ sessionId: 'session-1', clock, transcript: items, revert: session });
  // Unit 1: the rewind. It takes the exchange off the surface.
  const first = port.rewindAskExchange({ ...EXCHANGE, summary: '' });
  assert.equal(first.status, 'applied', JSON.stringify(first));
  assert.equal(session.appends.length, 1, 'unit 1 rewinds once');
  // Unit 2: `rewound: true` — no ask turn exists, and none is looked for.
  const shaped = bytes('three\nfour\n[racoons] kept lines 3–4 of 6 · 20 bytes dropped\n');
  const secondWrite = port.applyEntryShape({ resultNodeId: 'result-2', askNodeId: 'ask-1',
    answerNodeId: 'answer-1', summary: 'stale log', rewound: true }, shaped);
  assert.equal(secondWrite.status, 'applied', JSON.stringify(secondWrite));
  // Exactly ONE more append, and it rewrites the result turn alone: no second
  // rewind, which the host would refuse anyway (the range is gone).
  assert.equal(session.appends.length, 2, 'unit 2 appends its shaped turn only');
  assert.deepEqual(session.appends[1]?.intent.surfaceOp,
    { op: 'replace', startSeq: 5, endSeq: 5 },
    'the second write replaces the result node, never the dead exchange range');
  const text = session.surface().find(node => node.seq === secondWrite.seq)?.blocks[0]?.text ?? '';
  assert.equal(text, `stale log\n\n${new TextDecoder().decode(shaped)}`,
    'the shaped turn carries its summary above the partials');
  // The transcript mirrors the new turn and no ask turn survives anywhere.
  const landed = port.transcript().find(item => item.id === 'result-2');
  assert.deepEqual(landed?.bytes, bytes(`stale log\n\n${new TextDecoder().decode(shaped)}`));
  assert.equal(session.surface().some(node => node.id === 'ask-1'
    || node.blocks.some(block => block.text === 'which rows do you keep?')), false,
  'no ask turn survives on the surface');

  // The control: the SAME write without `rewound` refuses by name. This is what
  // makes the test non-vacuous — the flag is the thing under test, not the shape.
  const control = createDshPort({ sessionId: 'session-1', clock, transcript: items,
    revert: new ExchangeSession(surface) });
  control.rewindAskExchange({ ...EXCHANGE, summary: '' });
  const refused = control.applyEntryShape({ ...EXCHANGE, resultNodeId: 'result-2',
    summary: 'stale log' }, shaped);
  assert.equal(refused.status, 'refused', 'without `rewound` the ask turn is missing');
  if (refused.status === 'refused') assert.equal(refused.code, 'ask-exchange-missing');
});
