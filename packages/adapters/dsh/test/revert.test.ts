import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ApplyRequest, ArchiveRecord, ByteRange, KeptLineSpan, ProcessingUnit, RecallRecord,
  RenderedRecord, ValidatedRevert, Verdict,
} from '@cremator/core';
import {
  canonicalManifestBytes, deriveVerdictRemoval, LedgerError, revertBytes, sha256Sync,
  splitLineOffsets,
} from '@cremator/core';
import { createDshAdapter } from '../src/adapter.js';
import { createDshCapabilities, DSH_CAPABILITIES } from '../src/capabilities.js';
import type { DshTranscriptItem } from '../src/envelope.js';
import { createDshPort } from '../src/port.js';
import {
  applyValidatedRevert, planRevertAppend, partialKeepsFromArchives, revertPlanSha256,
} from '../src/revert.js';
import type {
  DshAppendableType, DshContentBlock, DshRevertSession, DshSurfaceIntent, DshSurfaceNode,
  DshSurfaceType,
} from '../src/revert.js';
import {
  DSH_TOOL_SPECS, createDshTools, recallText, registerDshTools,
} from '../src/tools.js';
import type { DshRecallOutput } from '../src/tools.js';
import { bytes, clock, hash, unchanged } from './fixtures.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';

const encoder = new TextEncoder();

// --- the fake host surface --------------------------------------------------

function text(value: string): DshContentBlock {
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

function messageItem(id: string, role: 'user' | 'assistant' | 'system' | 'developer',
  body: string, toolCallIds: readonly string[] = []): DshTranscriptItem {
  return { id, role, bytes: bytes(body), turnOrdinal: 1, stepOrdinal: 1,
    ...(toolCallIds.length === 0 ? {} : { toolCallIds }) };
}

function resultItem(id: string, callId: string, body: string): DshTranscriptItem {
  return { id, role: 'tool', callId, toolName: 'read', bytes: bytes(body),
    turnOrdinal: 1, stepOrdinal: 1 };
}

/**
 * The cap fixture: system prompt at surface node 0, one user turn, one
 * assistant call, and the oversized result the verdict forgets at index 3.
 * Everything before the result stays byte-identical; one newer user message
 * after it keeps its own surface node.
 */
function capFixture() {
  return {
    surface: [surfaceNode('system-1', 0, 'system/message', [text('system prompt')]),
      surfaceNode('user-1', 1, 'user/message', [text('read big.ts')]),
      surfaceNode('assistant-1', 2, 'assistant/message', [text('reading'),
        { type: 'tool-call', id: 'call-1' }]),
      surfaceNode('result-1', 3, 'tool/result', [text('giant body')], 'call-1'),
      surfaceNode('user-2', 4, 'user/message', [text('next question')])],
    items: [messageItem('system-1', 'system', 'system prompt'),
      messageItem('user-1', 'user', 'read big.ts'),
      messageItem('assistant-1', 'assistant', 'reading', ['call-1']),
      resultItem('result-1', 'call-1', 'giant body'),
      messageItem('user-2', 'user', 'next question')],
  };
}

/** The fake `Session`: records every append and splices the surface like dsh's `replace`. */
class FakeSession implements DshRevertSession {
  readonly appends: {
    readonly type: DshAppendableType;
    readonly data: Readonly<Record<string, unknown>>;
    readonly intent: DshSurfaceIntent;
  }[] = [];
  throwOnAppend = false;
  /** 0-based append index that throws; -1 never throws (the mid-sequence case). */
  throwAtIndex = -1;
  #nodes: readonly DshSurfaceNode[];
  #seq: number;
  readonly #limit: number | null;

  constructor(nodes: readonly DshSurfaceNode[], nextSeq?: number) {
    this.#nodes = nodes;
    this.#seq = nextSeq ?? nodes.reduce((max, node) => Math.max(max, node.seq + 1), 0);
    this.#limit = nextSeq ?? null;
  }

  surface(): readonly DshSurfaceNode[] { return this.#nodes; }
  nextSeq(): number { return this.#limit ?? this.#seq; }

  append(type: DshAppendableType, data: Readonly<Record<string, unknown>>,
    intent: DshSurfaceIntent): { readonly seq: number } {
    this.appends.push(structuredClone({ type, data, intent }));
    if (this.throwOnAppend) throw new Error('host append refused');
    if (this.appends.length - 1 === this.throwAtIndex) throw new Error('host append refused mid-sequence');
    // The host projects the replacement's own message content, as `deriveMessages` does.
    const projected = type === 'user/message'
      ? data['content'] : (data['message'] as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(projected) ? projected as DshContentBlock[] : [];
    const startIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.startSeq);
    const endIdx = this.#nodes.findIndex(node => node.seq === intent.surfaceOp.endSeq);
    const replacement: DshSurfaceNode = { id: `replacement-${this.#seq}`, seq: this.#seq,
      type, blocks, data };
    this.#nodes = [...this.#nodes.slice(0, startIdx), replacement, ...this.#nodes.slice(endIdx + 1)];
    return { seq: this.#seq++ };
  }
}

function receipt(recordId: string, body: string): RenderedRecord {
  const body_ = encoder.encode(body);
  return { recordId, bytes: body_, sha256: hash(body_) };
}

const RECEIPT_TEXT = '[not retained] big.ts · necromancy recall:sha256:aa';

/** Seals a plan exactly as `guard/application.ts` does, so the port's digest check passes. */
function sealed(plan: Omit<ValidatedRevert, 'planSha256'>): ValidatedRevert {
  const unsealed = { ...plan, planSha256: '' } as ValidatedRevert;
  return { ...plan, planSha256: revertPlanSha256(unsealed) } as ValidatedRevert;
}

/** The cap plan: forget the result at surface index 3, keep the newer user turn. */
function capPlan(overrides: Partial<Omit<ValidatedRevert, 'planSha256'>> = {}): ValidatedRevert {
  const freed = 5000, kept = 13, receiptBytes = encoder.encode(RECEIPT_TEXT).length;
  return sealed({ unitIds: ['unit:sha256:one'], cutIndex: 3, survivors: ['user-2'],
    appends: [{ afterNodeId: 'assistant-1', noteId: 'racoons:receipt-1' }],
    perNode: [{ nodeId: 'result-1', noteId: 'racoons:receipt-1' }],
    cost: { cutIndex: 3, freedBytes: freed, keptBytes: kept, receiptBytes,
      netFreedBytes: freed - kept - receiptBytes },
    baseRevision: '0:0', ...overrides });
}

function refusal(outcome: ReturnType<typeof applyValidatedRevert>): string {
  assert.equal(outcome.status, 'refused');
  return outcome.status === 'refused' ? outcome.code : 'applied';
}

// --- the one-append shape ---------------------------------------------------



// --- the four §4 preconditions, each refused before any append --------------








// --- capability honesty -----------------------------------------------------



// --- the port's apply path --------------------------------------------------

function revertRequest(plan: ValidatedRevert, baseRevision: string): ApplyRequest {
  return requestWithRecords(plan, baseRevision, [
    { recordId: 'racoons:receipt-1', bytes: encoder.encode(RECEIPT_TEXT),
      sha256: hash(encoder.encode(RECEIPT_TEXT)) },
  ]);
}

function requestWithRecords(
  plan: ValidatedRevert, baseRevision: string, appendRecords: readonly RenderedRecord[],
): ApplyRequest {
  const application = {
    sessionId: 'session-1', eventId: 'verdict-event', baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: 'application-1', replacements: [],
    appendRecords,
    archives: [], sealedEpisodeIds: [], createdAtMs: 1234, revert: plan,
  } as unknown as ApplyRequest['application'];
  return { application, intent: { intentId: 'intent-1', sessionId: 'session-1',
    eventId: 'verdict-event', baseRevision, applicationSha256: 'application-1' } };
}

function multiNodeRequest(plan: ValidatedRevert, baseRevision: string): ApplyRequest {
  return requestWithRecords(plan, baseRevision, multiNodeReceipts());
}





// --- the additive tool set --------------------------------------------------

function recallRecord(...bodies: readonly string[]) {
  const records = bodies.map((body, index) => {
    const partBytes = encoder.encode(body);
    const sha = hash(partBytes);
    const source = { nodeId: `result-${index + 1}`, sha256: sha, byteLength: partBytes.length };
    return { source, bytes: partBytes, removedRanges: [], blobSha256: sha };
  });
  const manifest = { version: 1 as const, sessionId: 'session-1',
    parts: records.map(({ source, blobSha256 }) => ({ source, blobSha256, removedRanges: [] })) };
  const manifestSha256 = sha256Sync(canonicalManifestBytes(manifest));
  return { id: `recall:sha256:${manifestSha256}`, manifestSha256, manifest,
    parts: records.map(({ source, bytes, removedRanges }) => ({ source, bytes, removedRanges })) };
}





function partLength(body: string): number {
  return encoder.encode(body).length;
}



// --- keeplines: partial keeps (ISSUE-017) ----------------------------------

const BODY = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n';

/** One whole-result unit over a six-line body, the shape the tracker builds. */
function wholeResultUnit(body: string): ProcessingUnit {
  const encoded = encoder.encode(body);
  return { id: 'unit:sha256:one', nodeId: 'result-1',
    source: { nodeId: 'result-1', sha256: hash(encoded), byteLength: encoded.length },
    path: 'src/x.ts',
    span: { byteRange: { startByte: 0, endByteExclusive: encoded.length },
      lineRange: { startLine: 1, endLineInclusive: splitLineOffsets(encoded).length } },
    byteLength: encoded.length };
}

/** A `keeplines` answer over the whole-unit fixture: spans are 1-based, unit-relative. */
function keeplines(ranges: readonly KeptLineSpan[]): Verdict {
  return { unitId: 'unit:sha256:one', action: 'keeplines', ranges, answeredInRound: 1 };
}

/**
 * The archive the core planner builds for one verdict: the whole node body plus
 * the removal `deriveVerdictRemoval` derived, each removed span hashed. Building
 * it through the core export is the point — the adapter is tested against the
 * ranges the core actually plans, never a hand-computed copy.
 */
function verdictArchive(
  unit: ProcessingUnit, verdict: Verdict, body: Uint8Array,
): { readonly archive: ArchiveRecord; readonly record: RecallRecord } {
  const derived = deriveVerdictRemoval(unit, verdict, body);
  assert.ok(derived !== null, 'the fixture answer must derive a removal');
  const removedRanges = derived.byteRanges.map(range => ({ range: { ...range },
    sha256: hash(body.slice(range.startByte, range.endByteExclusive)) }));
  const source = { ...unit.source };
  const blobSha256 = hash(body);
  const manifest = { version: 1 as const, sessionId: 'session-1',
    parts: [{ source, blobSha256, removedRanges }] };
  const manifestSha256 = sha256Sync(canonicalManifestBytes(manifest));
  const record: RecallRecord = { id: `recall:sha256:${manifestSha256}`, manifestSha256, manifest,
    parts: [{ source, bytes: body, removedRanges }] };
  return { record, archive: { ruleId: 'verdict', removalId: unit.id, operationKind: 'verdict',
    episodeId: null, title: 'not retained src/x.ts', recall: record } };
}

/** The keeplines surface: the cap fixture with a six-line result at index 3. */
function keeplinesFixture() {
  const fixture = capFixture();
  const surface = fixture.surface.map(node => node.id === 'result-1'
    ? surfaceNode('result-1', 3, 'tool/result', [text(BODY)], 'call-1') : node);
  const items = fixture.items.map(item => item.id === 'result-1'
    ? resultItem('result-1', 'call-1', BODY) : item);
  return { surface, items };
}

/** The cap plan over the keeplines surface: one forgotten node at index 3. */
function keeplinesPlan(): ValidatedRevert {
  return capPlan();
}

/** The text of the rebuild's blocks, in order; the receipt text is pinned too. */
function rebuiltText(decision: ReturnType<typeof planRevertAppend>): readonly string[] {
  assert.equal(decision.status, 'planned');
  if (decision.status !== 'planned') return [];
  const content = decision.append.type === 'user/message'
    ? decision.append.data['content']
    : (decision.append.data['message'] as { content?: unknown } | undefined)?.content;
  assert.ok(Array.isArray(content));
  return (content as readonly DshContentBlock[]).map(block => block.text ?? '');
}

/**
 * The rebuild's kept text plus recall's removed bytes, in body order, must be
 * the source node exactly. This is the byte-compare the issue asks for: the
 * model re-reads the kept bytes and `recall` restores the rest, and no byte may
 * be dropped, duplicated or reordered between the two halves.
 *
 * `keptRanges`/`removedRanges` are the adapter's derivation from the archive;
 * `rebuilt` are the blocks the append carries. The kept blocks must be the kept
 * bytes verbatim, and the removed bytes appended after them must complete the
 * body without a gap or an overlap.
 */
function assertRebuildPlusRecall(
  body: string, keptRanges: readonly ByteRange[], removedRanges: readonly ByteRange[],
  rebuilt: readonly string[],
): void {
  const source = encoder.encode(body);
  const decoder = new TextDecoder();
  const keptText = keptRanges.map(range =>
    decoder.decode(source.slice(range.startByte, range.endByteExclusive)));
  assert.deepEqual(rebuilt.slice(0, keptText.length), keptText,
    'the rebuild carries the kept bytes verbatim, in order');
  const tiled = [...keptRanges.map(range => ({ range, kept: true })),
    ...removedRanges.map(range => ({ range, kept: false }))]
    .sort((a, b) => a.range.startByte - b.range.startByte);
  const restored: Uint8Array[] = [];
  let cursor = 0;
  for (const span of tiled) {
    assert.equal(span.range.startByte, cursor, 'kept and removed spans tile the body with no gap');
    restored.push(source.slice(span.range.startByte, span.range.endByteExclusive));
    cursor = span.range.endByteExclusive;
  }
  assert.equal(cursor, source.length, 'the last span reaches the body end');
  const joined = new Uint8Array(source.length);
  let offset = 0;
  for (const piece of restored) { joined.set(piece, offset); offset += piece.length; }
  assert.deepEqual(joined, source, 'kept + removed reproduce the source byte-for-byte');
}

/**
 * Two forgotten results with a survivor between them: one span that starts at a
 * `tool/result` and covers four nodes. The host refuses the batched shape, so
 * ADR-0036's fallback applies it as one replacement per forgotten node.
 */
function multiNodeFixture() {
  return {
    surface: [...capFixture().surface,
      surfaceNode('assistant-2', 5, 'assistant/message', [text('again'),
        { type: 'tool-call', id: 'call-2' }]),
      surfaceNode('result-2', 6, 'tool/result', [text('second')], 'call-2')],
    items: [...capFixture().items,
      messageItem('assistant-2', 'assistant', 'again', ['call-2']),
      resultItem('result-2', 'call-2', 'second')],
  };
}

/** The same two-forgotten-node plan both shapes ship in (ADR-0036 §2). */
function multiNodePlan(): ValidatedRevert {
  return sealed({ unitIds: ['unit:x', 'unit:y'], cutIndex: 3,
    survivors: ['user-2', 'assistant-2'],
    appends: [{ afterNodeId: 'assistant-1', noteId: 'racoons:receipt-1' },
      { afterNodeId: 'assistant-2', noteId: 'racoons:receipt-2' }],
    perNode: [{ nodeId: 'result-1', noteId: 'racoons:receipt-1' },
      { nodeId: 'result-2', noteId: 'racoons:receipt-2' }],
    cost: { cutIndex: 3, freedBytes: 10, keptBytes: 0, receiptBytes: 8, netFreedBytes: 2 },
    baseRevision: '0:0' });
}

function multiNodeReceipts(): readonly RenderedRecord[] {
  return [receipt('racoons:receipt-1', RECEIPT_TEXT), receipt('racoons:receipt-2', RECEIPT_TEXT)];
}

/**
 * The apply shapes a revert may take, one row each: a single forgotten node is
 * exactly one content-only append carrying its receipt, and a span covering two
 * forgotten nodes with a survivor between them falls back (ADR-0036) to one
 * append per node, each keeping its own call pairing and its own receipt.
 */
const APPLY_SHAPE_ROWS: readonly {
  readonly name: string;
  run(at: Label): void;
}[] = [
  {
    name: 'one forgotten node',
    run(at) {
      const fixture = capFixture();
      const session = new FakeSession(fixture.surface);
      const outcome = applyValidatedRevert(session, capPlan(),
        [receipt('racoons:receipt-1', RECEIPT_TEXT)]);
      assert.equal(outcome.status, 'applied', at('the revert applied'));
      if (outcome.status !== 'applied') return;
      assert.equal(session.appends.length, 1, at('exactly one host append, never several'));
      const only = session.appends[0];
      assert.ok(only !== undefined, at('the append was recorded'));
      // The append covers exactly the forgotten node: the cut range, one node.
      assert.deepEqual(only.intent.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 },
        at('the replace covers the one forgotten node'));
      // Every shadowed node is listed, and only those.
      assert.deepEqual(only.intent.sourceEventSeqs, [3],
        at('the one shadowed node is listed'));
      assert.equal(only.type, 'tool/result',
        at('the only legal single-node replacement here'));
      const message = only.data['message'] as { content: DshContentBlock[]; toolCallId: string };
      assert.equal(message.toolCallId, 'call-1',
        at('content-only: the call pairing is untouched'));
      assert.deepEqual(message.content, [text(RECEIPT_TEXT)],
        at('the replacement carries the receipt'));
      // The surface: prefix untouched, replacement at the cut, survivors follow.
      // The replacement is a new surface entry with its own seq, never the old node.
      assert.deepEqual(outcome.surface.map(node => node.id),
        ['system-1', 'user-1', 'assistant-1', `replacement-${outcome.seq}`, 'user-2'],
        at('the replacement takes the cut node\'s place'));
      assert.notEqual(outcome.seq, 3, at('the replacement does not reuse the shadowed seq'));
      assert.deepEqual(outcome.surface.slice(0, 3).map(node => node.data),
        fixture.surface.slice(0, 3).map(node => node.data),
        at('every byte before the cut is unchanged'));
      assert.equal(outcome.surface.at(-1)?.id, 'user-2', at('the survivor still follows'));
    },
  },
  {
    name: 'two forgotten nodes',
    run(at) {
      const fixture = multiNodeFixture();
      const session = new FakeSession(fixture.surface);
      const outcome = applyValidatedRevert(session, multiNodePlan(), multiNodeReceipts());
      assert.equal(outcome.status, 'applied', at('the revert applied'));
      if (outcome.status !== 'applied') return;
      assert.equal(session.appends.length, 2, at('one append per forgotten node'));
      const [first, second] = session.appends;
      assert.ok(first !== undefined && second !== undefined,
        at('both appends were recorded'));
      // Each append shadows exactly one node: the shape the host accepts today.
      assert.deepEqual(first.intent, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
        sourceEventSeqs: [3] }, at('the first append covers the first node'));
      assert.deepEqual(second.intent, { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 },
        sourceEventSeqs: [6] }, at('the second append covers the second node'));
      for (const [index, append] of [first, second].entries()) {
        assert.equal(append.type, 'tool/result', at('content-only, single-node'));
        const message = append.data['message'] as
          { content: DshContentBlock[]; toolCallId: string };
        assert.equal(message.toolCallId, index === 0 ? 'call-1' : 'call-2',
          at('its own call id is kept'));
        assert.deepEqual(message.content, [text(RECEIPT_TEXT)],
          at('its own receipt is carried'));
      }
      // Survivors are never re-emitted: they keep their own nodes, ids and seqs.
      const ids = outcome.surface.map(node => node.id);
      assert.equal(ids.length, 7,
        at('two replacements took the two forgotten nodes\' places'));
      assert.deepEqual(ids.filter(id => !id.startsWith('replacement-')),
        ['system-1', 'user-1', 'assistant-1', 'user-2', 'assistant-2'],
        at('the survivors keep their own ids'));
      assert.deepEqual(outcome.surface.filter(node => node.id === 'user-2')
        .map(node => node.seq), [4], at('the first survivor keeps its seq'));
      assert.deepEqual(outcome.surface.filter(node => node.id === 'assistant-2')
        .map(node => node.seq), [5], at('the second survivor keeps its seq'));
    },
  },
];

test('a revert applies as one content-only append per forgotten node', () => {
  for (const scenario of APPLY_SHAPE_ROWS) {
    const at: Label = what => `row: ${scenario.name}: ${what}`;
    try {
      scenario.run(at);
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith(`row: ${scenario.name}`)) {
        error.message = at(error.message);
      }
      throw error;
    }
  }
});

/**
 * A sequence that fails part-way is uncertainty, never "not applied", and the
 * intent is never retried: the adapter answers `unknown` with the first append
 * landed, and the port loses the same failure once and locks the intent out.
 */
const PART_WAY_ROWS: readonly {
  readonly name: string;
  run(at: Label): Promise<void>;
}[] = [
  {
    name: 'the adapter',
    async run(at) {
      const fixture = multiNodeFixture();
      const session = new FakeSession(fixture.surface);
      session.throwAtIndex = 1;
      const outcome = applyValidatedRevert(session, multiNodePlan(), multiNodeReceipts());
      assert.equal(outcome.status, 'unknown',
        at('a partial sequence is uncertainty, never not-applied'));
      assert.equal(session.appends.length, 2,
        at('the first landed, the second was attempted once'));
      // The landed replacement is on the host; the second violation changed nothing.
      assert.equal(session.surface().some(node => node.id === 'result-1'), false,
        at('the first result was replaced'));
      assert.equal(session.surface().some(node => node.id === 'result-2'), true,
        at('the second result was left alone'));
    },
  },
  {
    name: 'the port',
    async run(at) {
      const fixture = multiNodeFixture();
      const session = new FakeSession(fixture.surface);
      session.throwAtIndex = 1;
      const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items,
        revert: session });
      const before = await port.snapshot();
      const request = multiNodeRequest(multiNodePlan(), before.revision);
      assert.deepEqual(await port.apply(request), { status: 'unknown' },
        at('the first attempt is unknown'));
      assert.equal(session.appends.length, 2, at('both appends were attempted'));
      assert.deepEqual(await port.apply(request), { status: 'unknown' },
        at('the intent is locked out'));
      assert.equal(session.appends.length, 2, at('no retry, ever'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('the receipt answers with the same uncertainty'));
    },
  },
];

test('a sequence that fails part-way reports unknown and is never retried', async () => {
  await runRows(PART_WAY_ROWS.map((scenario): Row => ({
    name: scenario.name,
    run: at => scenario.run(at),
  })));
});

/**
 * Four claims that need no seal beyond the fixture's: a plan that drops a call
 * but keeps its result never applies, the sealed digest is the guard's own
 * domain so every substituted field changes it, the factory declares only the
 * capability a seam supplies, and a thrown append leaves the transcript untouched
 * while reporting uncertainty.
 */
const INVARIANT_ROWS: readonly {
  readonly name: string;
  run(at: Label): void;
}[] = [
  {
    name: 'tool-pair imbalance',
    run(at) {
      // Forgetting the user turn and the assistant call, keeping the result: the
      // rebuilt history would carry a tool result with no call before it.
      const nodes = [surfaceNode('system-1', 0, 'system/message', [text('prompt')]),
        surfaceNode('user-1', 1, 'user/message', [text('go')]),
        surfaceNode('assistant-1', 2, 'assistant/message', [text('call'),
          { type: 'tool-call', id: 'call-1' }]),
        surfaceNode('result-1', 3, 'tool/result', [text('body')], 'call-1')];
      const plan = sealed({ unitIds: ['unit:x', 'unit:y'], cutIndex: 1,
        survivors: ['result-1'],
        appends: [{ afterNodeId: 'system-1', noteId: 'racoons:receipt-1' },
          { afterNodeId: 'system-1', noteId: 'racoons:receipt-2' }],
        perNode: [{ nodeId: 'user-1', noteId: 'racoons:receipt-1' },
          { nodeId: 'assistant-1', noteId: 'racoons:receipt-2' }],
        cost: { cutIndex: 1, freedBytes: 10, keptBytes: 0, receiptBytes: 6, netFreedBytes: 4 },
        baseRevision: '0:0' });
      const session = new FakeSession(nodes);
      assert.equal(refusal(applyValidatedRevert(session, plan,
        [receipt('racoons:receipt-1', RECEIPT_TEXT),
          receipt('racoons:receipt-2', RECEIPT_TEXT)])), 'tool-pair-imbalance',
      at('a kept result with no call is refused'));
      assert.equal(session.appends.length, 0, at('nothing was appended'));
    },
  },
  {
    name: 'plan digest',
    run(at) {
      const plan = capPlan();
      const { planSha256, ...approved } = plan;
      // The core export is the single `racoons:revert:v1` hasher; the pinned digest
      // is what the old adapter-local copy produced on this fixture, so a domain or
      // encoding drift on either side turns this red. Re-pinned for ISSUE-109 when
      // `perNode` joined the sealed plan (ADR-0036 §6): the digest covers both shapes.
      assert.equal(sha256Sync(revertBytes(approved)), planSha256,
        at('the core hasher reproduces the sealed digest'));
      assert.equal(planSha256,
        '42fb57fc6e496c1ea1e0f003fe1e628fd6420d708c97d763dbab8ea6b7e05997',
        at('the digest is the pinned one'));
      assert.notEqual(planSha256, revertPlanSha256({ ...plan, cutIndex: 4 }),
        at('a moved cut index changes the digest'));
      assert.notEqual(planSha256, revertPlanSha256({ ...plan,
        appends: [{ afterNodeId: 'user-1', noteId: 'racoons:receipt-1' }] }),
      at('a moved append anchor changes the digest'));
      assert.notEqual(planSha256, revertPlanSha256({ ...plan,
        perNode: [{ nodeId: 'result-1', noteId: 'racoons:receipt-2' }] }),
      at('the per-node shape is inside the digest, so a swapped receipt is detectable'));
    },
  },
  {
    name: 'capability honesty',
    run(at) {
      const plain = createDshCapabilities();
      assert.equal(plain.rewriteHistory, false, at('no path rewrites in place'));
      assert.equal(plain.rehydrateOnResume, false,
        at('no path rebuilds a resume context'));
      assert.equal(plain.revertHistory, false,
        at('no seam supplied, no capability declared'));
      assert.deepEqual(DSH_CAPABILITIES, plain, at('the constant is the plain factory result'));
      assert.equal(Object.isFrozen(plain), true, at('the flags are frozen'));
      const withRevert = createDshCapabilities(true);
      assert.equal(withRevert.revertHistory, true, at('a seam declares the revert capability'));
      assert.equal(withRevert.rewriteHistory, false, at('a revert seam is not a rewrite seam'));
      assert.deepEqual({ ...withRevert, revertHistory: false }, plain,
        at('the two factories differ only in the revert flag'));
    },
  },
  {
    name: 'thrown append',
    run(at) {
      const fixture = capFixture();
      const session = new FakeSession(fixture.surface);
      session.throwOnAppend = true;
      const before = structuredClone(session.surface());
      const outcome = applyValidatedRevert(session, capPlan(),
        [receipt('racoons:receipt-1', RECEIPT_TEXT)]);
      assert.equal(outcome.status, 'unknown',
        at('a lost append is uncertainty, never not-applied'));
      assert.deepEqual(session.surface(), before, at('the host log is never shortened'));
      assert.equal(session.appends.length, 1, at('one attempt; the adapter never retries'));
    },
  },
];

test('the plan, digest, capability and append invariants hold on their own', () => {
  for (const scenario of INVARIANT_ROWS) {
    const at: Label = what => `row: ${scenario.name}: ${what}`;
    try {
      scenario.run(at);
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith(`row: ${scenario.name}`)) {
        error.message = at(error.message);
      }
      throw error;
    }
  }
});

/**
 * The port's two pre-append refusals: a plan whose sealed digest no longer
 * matches the application, and a plan whose base revision no longer matches the
 * host surface. Both answer `not-applied`, append nothing, and leave the
 * snapshot where it was; only the reason differs.
 */
const PORT_REFUSAL_ROWS: readonly {
  readonly name: string;
  /**
   * Builds the fixture's port and the request it must refuse. The stale row
   * shortens the projection so the surface moved under the plan.
   */
  arrange(): Promise<{
    readonly port: ReturnType<typeof createDshPort>;
    readonly request: ApplyRequest;
    readonly before: Awaited<ReturnType<ReturnType<typeof createDshPort>['snapshot']>>;
    readonly session: FakeSession;
  }>;
  /** The reason the port must name. */
  readonly reason: 'host-error' | 'stale-revision';
}[] = [
  {
    name: 'sealed digest moved',
    reason: 'host-error',
    async arrange() {
      const fixture = capFixture();
      const session = new FakeSession(fixture.surface);
      const port = createDshPort({ sessionId: 'session-1', clock, transcript: fixture.items,
        revert: session });
      const before = await port.snapshot();
      // One field moved: the digest no longer covers the plan being applied.
      const tampered = { ...capPlan(), cutIndex: 4 } as ValidatedRevert;
      return { port, request: revertRequest(tampered, before.revision), before, session };
    },
  },
  {
    name: 'host surface moved',
    reason: 'stale-revision',
    async arrange() {
      const fixture = capFixture();
      const session = new FakeSession(fixture.surface);
      // The projection is one node short of the surface the plan was cut against.
      const port = createDshPort({ sessionId: 'session-1', clock, revert: session,
        transcript: fixture.items.slice(0, 4) });
      const before = await port.snapshot();
      return { port, request: revertRequest(capPlan(), before.revision), before, session };
    },
  },
];

test('the port refuses a stale plan before any append, and names why', async () => {
  await runRows(PORT_REFUSAL_ROWS.map((scenario): Row => ({
    name: scenario.name,
    async run(at) {
      const { port, request, before, session } = await scenario.arrange();
      assert.deepEqual(await port.apply(request),
        { status: 'not-applied', reason: scenario.reason },
        at(`the refusal names ${scenario.reason}`));
      assert.equal(session.appends.length, 0, at('no host append was attempted'));
      assert.deepEqual(await port.snapshot(), before, at('the snapshot is unchanged'));
    },
  })));
});

/**
 * The recall tool's three output claims: it restores the archived bytes by id
 * (BOM and CRLF included) and refuses a mismatched or missing id without asking
 * the ledger, a one-part record keeps the shipped flat shape, and a multi-part
 * record returns each part separately rather than a joined body.
 */
const RECALL_ROWS: readonly {
  readonly name: string;
  run(at: Label): Promise<void>;
}[] = [
  {
    name: 'restores by id',
    async run(at) {
      const body = '\uFEFFé\r\nnot normalized\r\nend';
      const record = recallRecord(body);
      const asked: string[] = [];
      // The host returns its record whatever id it was asked for, so the tool's
      // own identity check is what a mismatched request meets.
      const tools = createDshTools({ recall: async id => { asked.push(id); return record; } });
      assert.deepEqual(tools.map(tool => tool.spec.name), ['necromancy'],
        at('a source with no forget handler still offers recall alone'));
      const first = tools[0] as { execute(args: unknown): Promise<DshRecallOutput> } | undefined;
      assert.ok(first !== undefined, at('the recall tool is registered'));
      const output = await first.execute({ id: record.id });
      assert.equal(output.text, body,
        at('the restored text is the archived body, BOM included'));
      assert.deepEqual(output.parts.map(part => part.sha256),
        [record.manifest.parts[0]?.source.sha256], at('the part carries the archived hash'));
      assert.equal(output.byteLength, partLength(body), at('the byte length matches'));
      assert.equal(output.recallId, record.id, at('the recall id is echoed'));
      await assert.rejects(async () => first.execute({ id: `recall:sha256:${'1'.repeat(64)}` }),
        /not the requested archive/u, at('a valid id for another archive is refused'));
      await assert.rejects(async () => first.execute({ id: `${record.id}x` }),
        /Invalid recall id/u, at('a malformed id is refused by name'));
      await assert.rejects(async () => first.execute({}), /non-empty id/u,
        at('an empty id is refused'));
      assert.deepEqual(asked, [record.id, `recall:sha256:${'1'.repeat(64)}`],
        at('a malformed id never reaches the ledger'));
    },
  },
  {
    name: 'accepted id spellings normalize to the receipt form',
    async run(at) {
      const body = '\uFEFFé\r\nnot normalized\r\nend';
      const record = recallRecord(body);
      const asked: string[] = [];
      const tools = createDshTools({ recall: async id => { asked.push(id); return record; } });
      const recall = tools.find(tool => tool.spec.name === 'necromancy');
      assert.ok(recall !== undefined, at('the recall tool is registered'));
      for (const [form, id] of [
        ['receipt', record.id],
        ['sha256-prefix', `sha256:${record.manifestSha256}`],
        ['bare-hex', record.manifestSha256],
      ] as const) {
        const output = await recall.execute({ id }) as DshRecallOutput;
        assert.equal(output.text, body, at(`the ${form} form restores the same bytes`));
        assert.equal(output.recallId, record.id,
          at(`the ${form} form echoes the canonical id`));
      }
      assert.deepEqual(asked, [record.id, record.id, record.id],
        at('every accepted form reaches the source as the canonical id'));
      const rejected = [
        ['uppercase hex', `recall:sha256:${record.manifestSha256.toUpperCase()}`],
        ['short hex', `recall:sha256:${record.manifestSha256.slice(1)}`],
        ['leading space', ` ${record.manifestSha256}`],
        ['missing sha256 prefix', `recall:${record.manifestSha256}`],
        ['foreign algorithm', `recall:sha512:${record.manifestSha256}`],
      ] as const;
      for (const [label, id] of rejected) {
        await assert.rejects(async () => recall.execute({ id }), (error: unknown) =>
          error instanceof LedgerError && error.code === 'not-found'
          && /Invalid recall id/u.test(error.message),
        at(`the ${label} spelling is refused as an invalid recall id`));
      }
      assert.deepEqual(asked, [record.id, record.id, record.id],
        at('a rejected spelling never reaches the source'));
    },
  },
  {
    name: 'one part keeps the flat shape',
    async run(at) {
      // Pinned to the shape the adapter shipped before ISSUE-015: the single-source
      // case is every removal in production, so it must not change at all.
      const body = '\uFEFFa\r\n雪\n';
      const record = recallRecord(body);
      const part = record.manifest.parts[0];
      assert.ok(part !== undefined, at('the record has one part'));
      const output = await recallText(record, record.id);
      assert.deepEqual(output, { recallId: record.id, text: body,
        byteLength: partLength(body),
        parts: [{ nodeId: part.source.nodeId, byteLength: partLength(body),
          sha256: part.source.sha256, text: body }] },
      at('a one-part record keeps the flat shape byte-for-byte'));
    },
  },
  {
    name: 'registration is additive',
    async run(at) {
      const registered: string[] = [];
      const undone: string[] = [];
      const disposable = registerDshTools({ register: tool => {
        registered.push(tool.spec.name);
        return () => undone.push(tool.spec.name);
      } }, createDshTools({ recall: async () => { throw new Error('unused'); } }));
      assert.deepEqual(registered, ['necromancy'],
        at('exactly one tool registers, and it is the recall tool'));
      disposable.dispose();
      disposable.dispose();
      assert.deepEqual(undone, ['necromancy'], at('disposal is idempotent'));
      assert.deepEqual(DSH_TOOL_SPECS.map(spec => spec.name), ['forget', 'necromancy'],
        at('the declared inventory keeps both names'));
      // Nothing replaces a native read: every spec is its own additive tool.
      for (const spec of DSH_TOOL_SPECS) {
        assert.equal(spec.parameters['type'], 'object',
          at(`${spec.name} takes an object schema`));
        assert.ok(spec.description.length > 0, at(`${spec.name} carries a description`));
      }
    },
  },
  {
    name: 'several parts stay separate',
    async run(at) {
      const bodies = ['first body\n', 'second body \uFEFF'];
      const record = recallRecord(...bodies);
      const output = await recallText(record, record.id);
      // No field claims bytes the archive never held: a join would hand back a
      // string that belongs to neither part.
      assert.equal(output.text, null, at('several parts carry no whole-body text'));
      assert.equal(output.parts.length, 2, at('each part is its own entry'));
      assert.deepEqual(output.parts.map(part => part.text), bodies,
        at('each segment is exactly its own archived bytes'));
      assert.deepEqual(output.parts.map(part => part.sha256),
        record.parts.map(part => part.source.sha256), at('each part keeps its hash'));
      assert.deepEqual(output.parts.map(part => part.byteLength), bodies.map(partLength),
        at('each part keeps its length'));
      assert.equal(output.byteLength, bodies.reduce((sum, body) => sum + partLength(body), 0),
        at('the total is the sum of the parts'));
      for (const part of output.parts) {
        assert.equal(part.sha256, hash(encoder.encode(part.text)),
          at('each part hash matches its own text'));
        assert.equal(part.byteLength, encoder.encode(part.text).length,
          at('each part length matches its own text'));
      }
      assert.notEqual(output.text, bodies.join(''),
        at('the old join must not survive in any field'));
    },
  },
];

/**
 * The keeplines rebuild and the two checks that make it evidence: recall closes
 * the byte gap the rebuild leaves, and a perturbed endpoint must move the rebuild
 * with it — otherwise the exact-bytes comparison could not have been red. One
 * table because each row is a different question about the same rebuild.
 */
const REBUILD_ROWS: readonly {
  readonly name: string;
  run(at: Label): void;
}[] = [
  {
    name: 'recall closes the gap',
    run(at) {
      const unit = wholeResultUnit(BODY);
      const { archive, record } = verdictArchive(unit,
        keeplines([{ from: 1, to: 2 }, { from: 5, to: 6 }]), encoder.encode(BODY));
      const partial = partialKeepsFromArchives([archive]);
      assert.equal(partial.status, 'derived', at('the answer derives a keep'));
      if (partial.status !== 'derived') return;
      const keep = partial.keeps.get('result-1');
      assert.ok(keep !== undefined, at('the archive yields a partial keep'));
      // Recall restores the archived body whole, and its removed spans name exactly
      // the bytes the rebuild did not carry.
      const restored = recallText(record, record.id);
      assert.equal(restored.text, BODY, at('recall restores the whole body'));
      const part = record.parts[0];
      assert.ok(part !== undefined, at('the record has one part'));
      const removedBytes = part.removedRanges.map(span =>
        part.bytes.slice(span.range.startByte, span.range.endByteExclusive));
      assert.equal(new TextDecoder().decode(removedBytes[0]), 'gamma\ndelta\n',
        at('recall names the removed lines, not the kept ones'));
      assertRebuildPlusRecall(BODY, keep.keptRanges, keep.removedRanges,
        rebuiltText(planRevertAppend(keeplinesPlan(),
          [receipt('racoons:receipt-1', RECEIPT_TEXT)],
          keeplinesFixture().surface, 5, partial)));
    },
  },
  {
    name: 'a flipped endpoint goes red',
    run(at) {
      const unit = wholeResultUnit(BODY);
      const rebuildFor = (ranges: readonly KeptLineSpan[]): readonly string[] => {
        const { archive } = verdictArchive(unit, keeplines(ranges), encoder.encode(BODY));
        return rebuiltText(planRevertAppend(keeplinesPlan(),
          [receipt('racoons:receipt-1', RECEIPT_TEXT)],
          keeplinesFixture().surface, 5, partialKeepsFromArchives([archive])));
      };
      const expected = ['alpha\nbeta\n', 'epsilon\nzeta\n', RECEIPT_TEXT];
      const unperturbed = rebuildFor([{ from: 1, to: 2 }, { from: 5, to: 6 }]);
      assert.deepEqual(unperturbed, expected, at('the unperturbed answer holds'));
      // One endpoint moved by one line: line 3 joins the kept head, line 3 leaves
      // the removal. The rebuild must move with it, or the cut would not be applied.
      const flipped = rebuildFor([{ from: 1, to: 3 }, { from: 5, to: 6 }]);
      assert.deepEqual(flipped, ['alpha\nbeta\ngamma\n', 'epsilon\nzeta\n', RECEIPT_TEXT],
        at('the flipped answer moves the rebuild'));
      // The very assertion that passes on the unperturbed answer is what turns red:
      // the test is not vacuous.
      assert.throws(() => assert.deepEqual(flipped, expected),
        at('the exact-bytes comparison must reject the flipped endpoint'));
      // And the byte tiling a caller would check against the source now disagrees:
      // the flipped rebuild carries a line recall also restores, so it duplicates it.
      const flippedArchive = partialKeepsFromArchives([verdictArchive(unit,
        keeplines([{ from: 1, to: 3 }, { from: 5, to: 6 }]), encoder.encode(BODY)).archive]);
      assert.equal(flippedArchive.status, 'derived', at('the flipped answer derives a keep'));
      if (flippedArchive.status !== 'derived') return;
      const flippedKeep = flippedArchive.keeps.get('result-1');
      assert.ok(flippedKeep !== undefined, at('the flipped answer yields a partial keep'));
      assert.throws(() => assertRebuildPlusRecall(BODY, flippedKeep.keptRanges,
        flippedKeep.removedRanges, unperturbed),
      at('a rebuild from the unperturbed answer must not tile the perturbed removal'));
    },
  },
  {
    name: 'a forged range refuses',
    run(at) {
      const unit = wholeResultUnit(BODY);
      const { archive } = verdictArchive(unit,
        keeplines([{ from: 1, to: 2 }, { from: 5, to: 6 }]), encoder.encode(BODY));
      const part = archive.recall.parts[0];
      assert.ok(part !== undefined, at('the archive has one part'));
      const first = part.removedRanges[0];
      assert.ok(first !== undefined, at('the part has one removal'));
      // Widen the removal by one byte without re-hashing it: the archive no longer
      // describes its own bytes.
      const forged: ArchiveRecord = { ...archive, recall: { ...archive.recall,
        parts: [{ ...part, removedRanges: [{ ...first,
          range: { startByte: first.range.startByte,
            endByteExclusive: first.range.endByteExclusive + 1 } },
        ...part.removedRanges.slice(1)] }] } };
      const partial = partialKeepsFromArchives([forged]);
      assert.equal(partial.status, 'invalid',
        at('an archive that does not describe its own bytes is invalid'));
      const session = new FakeSession(keeplinesFixture().surface);
      const outcome = applyValidatedRevert(session, keeplinesPlan(),
        [receipt('racoons:receipt-1', RECEIPT_TEXT)], partial);
      assert.equal(outcome.status, 'refused', at('the revert is refused'));
      if (outcome.status === 'refused') {
        assert.equal(outcome.code, 'plan-shape', at('the refusal names the plan shape'));
      }
      assert.equal(session.appends.length, 0, at('refused before any append'));
    },
  },
];

test('bytes leave by keeplines and return by recall, whole or part by part', async () => {
  // The tool's own output claims first, then the rebuild's — both are the same
  // question: what bytes a caller gets back, and in what shape.
  await runRows([
    ...RECALL_ROWS.map((scenario): Row => ({
      name: scenario.name,
      run: at => scenario.run(at),
    })),
    ...REBUILD_ROWS.map((scenario): Row => ({
      name: scenario.name,
      run: at => scenario.run(at),
    })),
  ]);
});
