// The wire-level proof gate for `revertHistory` on 2.4.0 (ISSUE-192; ADR-0044;
// ADR-0017; ISSUE-010). This file is the evidence that flips the flag, so every
// assertion here is one of the six acceptance criteria, named:
//
//   1. every message before the cut is the same object and deep-equal to the
//      input, and the node bytes of the prefix hash identically (the cache-valid
//      prefix survives byte for byte);
//   2. the ledger-named unit is gone, its result message left with it, and no
//      unnamed node or message outside the unit's span moved;
//   3. each receipt is present exactly once, after its anchor;
//   4. a second run over the output is identical to the first, and a run over a
//      partially present plan refuses `intent-conflict`;
//   5. every refusal class leaves the messages byte-identical;
//   6. `createOpencodeCapabilities()` is false, `{wireRevert:true}` is true, and
//      an engine given either value answers as its flags allow.
//
// Folded into four tests: the wire apply, the replay/refusal tables, and the
// engine arms. The perturbation cases need plans core would refuse to produce —
// a wrong digest, a split anchor, a cut at the head — so they are built here with
// the same digest function the guard seals with.
//
// The 2.x unit is a `tool-result` part plus its `tool-call` part: the test's
// fixture puts the call in one assistant message and the result in a `role: tool`
// message, because that is how the provider request is shaped. Removing the unit
// drops the result message and rebuilds the assistant message at the cut.
//
// No live API, no API key, no opencode binary: the host is plain objects and the
// ledger is SQLite in memory.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ApplyRequest, CapabilityFlags, EngineResult, Ledger, TelemetryEvent, ToolResultNode,
  ValidatedRevert, WireAnswer,
} from '@cremator/core';
import {
  CharHeuristicTokenMeter, DEFAULT_CONFIG, MemoryBlobStore, Meter, RacoonsEngine, SqliteLedger,
  UnitTracker,
  applicationFromVerdicts, applyPruneAnswers, createDefaultRules, planPrunePass,
  revertBytes, sha256Sync, toBytes,
} from '@cremator/core';
import {
  OPENCODE_FORGOTTEN_NODE_FIELD, OPENCODE_RECEIPT_OF_FIELD, deriveOpencodeRevert,
  opencodeReceiptEntryId, opencodeReceiptPassSegment, opencodeReceiptTextWithPass,
} from '../src/apply.js';
import type { OpencodeAppliedPlan, OpencodeAppliedPlanIndex } from '../src/apply.js';
import { createOpencodeCapabilities } from '../src/capabilities.js';
import type { OpencodeMessage } from '../src/host.js';
import type { OpencodeJournalRecord, OpencodeSessionEntry } from '../src/plugin.js';
import { createOpencodeMount } from '../src/plugin.js';
import { createOpencodePort } from '../src/port.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot, opencodeMessageKey,
  opencodePartNodeId, opencodeToolNodeId } from '../src/snapshot.js';
import {
  assistantMessage, reasoning, sessionId, text, textResult, toolCall, toolMessage, toolResult,
  userMessage,
} from './fixtures.js';
import type { Label, Row } from './rows.js';
import { runRows } from './rows.js';

const clock = { nowMs: () => 1_700_000_000_000 };
const REVERT_CAPABILITIES: CapabilityFlags = { ...createOpencodeCapabilities(), revertHistory: true };
/** The receipt line the guard renders for a whole-node verdict; the exact text is the test's. */
const RECEIPT_TEXT = '[not retained] NOTES.md · necromancy recall:sha256:ab'.concat('c'.repeat(62));
/** Above `DEFAULT_CONFIG.protocol.barBytes` (512), so the result is one unit. */
const BIG_BODY = `# Note\n\n${'body line\n'.repeat(1100)}`;

/**
 * The wire fixture, shaped like a real 2.4.0 request: one prompt, one assistant
 * step that read a file (the text part precedes the call, so no declaration
 * stand-in is needed), the result in its own `role: tool` message, a second
 * prompt and a closing answer.
 */
function wireArray(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(BIG_BODY))]),
    userMessage('msg_u2', [text('Summarize it.')]),
    assistantMessage('msg_a2', [text('It says body.')]),
  ];
}

function ids(messages: readonly OpencodeMessage[]): string[] {
  return deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes.map(node => node.id);
}

/** The node the fixture's plan forgets: the one read result. */
function forgottenNodeId(messages: readonly OpencodeMessage[]): string {
  const node = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .find(candidate => candidate.kind === 'tool-result');
  assert.ok(node !== undefined, 'the fixture holds one tool result');
  return node.id;
}

/** One descriptor per node: its id and the hash of its bytes. The prefix claim. */
function nodeShas(messages: readonly OpencodeMessage[]): [string, string][] {
  return deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .map(node => [node.id, node.sha256]);
}

interface PlanFields {
  readonly cutIndex: number;
  readonly survivors: readonly string[];
  readonly appends: readonly { readonly afterNodeId: string | null; readonly noteId: string }[];
  /** One message per forgotten node, in transcript order (ADR-0036 §2). */
  readonly perNode: readonly { readonly nodeId: string; readonly noteId: string }[];
  readonly baseRevision: string;
}

/**
 * A plan sealed the way the guard seals one: `sha256(revertBytes(approved))`.
 */
function sealPlan(fields: PlanFields, cost: {
  readonly freedBytes: number; readonly keptBytes: number;
}, receiptText = RECEIPT_TEXT): ValidatedRevert {
  const approved = {
    unitIds: [`unit:sha256:${'1'.repeat(64)}`],
    cutIndex: fields.cutIndex,
    survivors: [...fields.survivors],
    appends: fields.appends.map(append => ({ ...append })),
    perNode: fields.perNode.map(entry => ({ ...entry })),
    cost: {
      cutIndex: fields.cutIndex, freedBytes: cost.freedBytes, keptBytes: cost.keptBytes,
      receiptBytes: toBytes(receiptText).byteLength,
      netFreedBytes: cost.freedBytes - cost.keptBytes - toBytes(receiptText).byteLength,
    },
    baseRevision: fields.baseRevision,
  };
  return { ...approved, planSha256: sha256Sync(revertBytes(approved)) };
}

/** The plan core's own per-unit rule would produce for the fixture. */
function planFor(messages: readonly OpencodeMessage[], noteId = 'note-1'): ValidatedRevert {
  const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const nodes = derived.nodes;
  const cutIndex = nodes.findIndex(node => node.kind === 'tool-result');
  assert.ok(cutIndex > 0, 'the fixture has a tool result after its prompt');
  const forgotten = nodes[cutIndex];
  assert.ok(forgotten !== undefined);
  const survivors = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id).map(node => node.id);
  const keptBytes = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id)
    .reduce((sum, node) => sum + node.byteLength, 0);
  const previous = nodes[cutIndex - 1];
  assert.ok(previous !== undefined);
  return sealPlan({
    cutIndex,
    survivors,
    appends: [{ afterNodeId: previous.id, noteId }],
    perNode: [{ nodeId: forgotten.id, noteId }],
    baseRevision: derived.revision,
  }, { freedBytes: forgotten.byteLength, keptBytes });
}

/** One request whose identity fields agree, around a plan the test sealed. */
function requestFor(
  plan: ValidatedRevert, intentId = 'intent-1', noteIds: string | readonly string[] = 'note-1',
  receiptText = RECEIPT_TEXT,
): ApplyRequest {
  const notes = typeof noteIds === 'string' ? [noteIds] : noteIds;
  const bytes = toBytes(receiptText);
  const application = {
    sessionId, eventId: 'event-1', baseRevision: plan.baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1_700_000_000_000,
    appendRecords: notes.map(recordId => ({ recordId, bytes, sha256: sha256Sync(bytes) })),
    revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId, eventId: 'event-1', baseRevision: plan.baseRevision,
      applicationSha256: application.applicationSha256,
    },
  };
}

/** A request over the fixture, with its plan derived from the array itself. */
function fixtureRequest(intentId = 'intent-1'): ApplyRequest {
  return requestFor(planFor(wireArray()), intentId);
}

function isReceipt(message: OpencodeMessage): boolean {
  return typeof message[OPENCODE_RECORD_ID_FIELD] === 'string';
}

function receiptText(message: OpencodeMessage): string {
  return message.content
    .filter(part => part.type === 'text' && typeof part['text'] === 'string')
    .map(part => part['text'] as string)
    .join('');
}

/** One receipt message in the host's 2.4.0 shape. */
function receiptMessage(
  intentId: string, index: number, noteId: string, textValue: string, forgotten: string,
): OpencodeMessage {
  const id = opencodeReceiptEntryId(intentId, index);
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: textValue }],
    [OPENCODE_RECORD_ID_FIELD]: id,
    [OPENCODE_RECEIPT_OF_FIELD]: noteId,
    [OPENCODE_FORGOTTEN_NODE_FIELD]: forgotten,
  };
}

/**
 * Seal a plan the way the guard does, after a deliberate field edit.
 */
function reseal(plan: Omit<ValidatedRevert, 'planSha256'>): ValidatedRevert {
  const body: Omit<ValidatedRevert, 'planSha256'> = {
    unitIds: plan.unitIds, cutIndex: plan.cutIndex, survivors: plan.survivors,
    appends: plan.appends, perNode: plan.perNode, cost: plan.cost, baseRevision: plan.baseRevision,
  };
  return { ...body, planSha256: sha256Sync(revertBytes(body)) };
}

/** The merged prune document core's own planner produces for the fixture. */
function pruneDocument(snapshot: ReturnType<typeof deriveOpencodeSnapshot>['snapshot']) {
  const tracker = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes });
  const units = tracker.units(snapshot);
  assert.equal(units.length, 1, 'the fixture has one above-bar result');
  const nodes = snapshot.nodes.filter(node =>
    node.kind === 'tool-result') as never as Parameters<typeof planPrunePass>[0]['nodes'];
  const plan = planPrunePass({
    units, nodes, episodes: [], classes: {}, round: 1,
  });
  assert.equal(plan.l1.removals.length, 0, 'a read with unknown outcomes proves nothing at L1');
  assert.equal(plan.askRows.length, 1);
  const row = plan.askRows[0];
  assert.ok(row !== undefined);
  const answer: Record<string, unknown> = { [String(row.index)]: { forgetall: 'notes result' } };
  const merged = applyPruneAnswers(plan, [JSON.stringify(answer)], {
    indices: plan.askRows.map(item => item.index), stamps: plan.stamps,
  });
  assert.equal(merged.removals.length, 1);
  assert.equal(merged.kept.length, 0);
  return merged;
}

/**
 * Criterion 5 — one row per refusal class.
 */
interface RefusalCase {
  readonly code: string;
  /** The expected `reason`, when the class declares one. */
  readonly reason?: string;
  build(at: Label): { readonly request: ApplyRequest; readonly messages: OpencodeMessage[] };
}

const REFUSAL_ROWS: readonly RefusalCase[] = [
  { code: 'plan-sha-mismatch',
    build(at) {
      const request = fixtureRequest();
      const tampered: ApplyRequest = {
        ...request,
        application: {
          ...request.application,
          revert: { ...request.application.revert!, cutIndex: 3 },
        } as ApplyRequest['application'],
      };
      const resealed = reseal(tampered.application.revert!);
      const second = deriveOpencodeRevert({
        ...tampered, application: { ...tampered.application, revert: resealed } as ApplyRequest['application'],
      }, wireArray());
      assert.equal(second.status, 'refused', at('the resealed plan is still refused'));
      if (second.status !== 'refused') throw new Error(at('unreachable'));
      assert.notEqual(second.code, 'plan-sha-mismatch',
        at('resealing reaches a later check, so the digest is what the tampered plan broke'));
      return { request: tampered, messages: wireArray() };
    } },
  { code: 'stale-revision', reason: 'stale-revision',
    build(at) {
      const messages = wireArray();
      const grown = [...messages, userMessage('msg_u3', [text('and then?')])];
      assert.equal(grown.length, messages.length + 1, at('the array grew by one message'));
      return { request: fixtureRequest(), messages: grown };
    } },
  { code: 'node-missing',
    build(at) {
      const messages = wireArray();
      const plan = planFor(messages);
      const wrongAnchor = reseal({ ...plan,
        appends: [{ ...plan.appends[0]!, afterNodeId: ids(messages)[0]! }] });
      const wrongSurvivor = reseal({ ...plan,
        survivors: [...plan.survivors, 'oc:ses_test:msg:msg_missing'] });
      const second = deriveOpencodeRevert(requestFor(wrongSurvivor), messages);
      assert.equal(second.status, 'refused', at('a survivor the array cannot hold is refused'));
      if (second.status === 'refused') assert.equal(second.code, 'node-missing',
        at('a missing survivor is the same class as a wrong anchor'));
      return { request: requestFor(wrongAnchor), messages };
    } },
  { code: 'tool-pair-split',
    build(at) {
      const messages = wireArray();
      const broken = structuredClone(messages) as OpencodeMessage[];
      const assistant = broken[1];
      assert.ok(assistant !== undefined, at('the fixture has an assistant message'));
      assistant.content.push(toolCall('call_1', 'read', { filePath: 'NOTES.md' }));
      return { request: fixtureRequest(), messages: broken };
    } },
  { code: 'unknown-part-shape',
    build(at) {
      // A result before its call: the projection cannot place the unit.
      const broken: OpencodeMessage[] = [
        toolMessage('msg_t0', [toolResult('call_x', 'read', textResult('early'))]),
        assistantMessage('msg_a1', [toolCall('call_x', 'read', { filePath: 'a.ts' })]),
      ];
      return { request: fixtureRequest(), messages: broken };
    } },
  { code: 'system-head',
    build(at) {
      const messages = wireArray();
      const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
      const prompt = derived.nodes[0];
      assert.ok(prompt !== undefined && prompt.kind === 'message' && prompt.role === 'user',
        at('the fixture opens with a user prompt'));
      const headless = reseal({
        unitIds: [`unit:sha256:${'2'.repeat(64)}`],
        cutIndex: 0,
        survivors: derived.nodes.slice(1).map(node => node.id),
        appends: [{ afterNodeId: null, noteId: 'note-1' }],
        perNode: [{ nodeId: prompt.id, noteId: 'note-1' }],
        cost: {
          cutIndex: 0, freedBytes: prompt.byteLength, keptBytes: 0,
          receiptBytes: toBytes(RECEIPT_TEXT).byteLength,
          netFreedBytes: prompt.byteLength - toBytes(RECEIPT_TEXT).byteLength,
        },
        baseRevision: derived.revision,
      });
      return { request: requestFor(headless), messages };
    } },
];

test('criterion 1+2+3: the wire apply keeps the prefix, drops the unit, lands one receipt', async () => {
  const request = fixtureRequest();
  const plan = request.application.revert;
  assert.ok(plan !== undefined);
  const messages = wireArray();
  const hostMessages = [...messages];
  const input = structuredClone(messages) as OpencodeMessage[];
  const firstMessage = messages[0];
  const assistantParts = messages[1]?.content ?? [];
  const prefixShas = nodeShas(messages).slice(0, plan.cutIndex);
  const anchorEntryIndex = 1;
  assert.equal(messages[anchorEntryIndex]?.id, 'msg_a1', 'the anchor part lives in the assistant message');

  const port = createOpencodePort({
    sessionId, clock, messages, capabilities: REVERT_CAPABILITIES,
    deriveRevert: deriveOpencodeRevert,
  });
  const base = await port.snapshot();
  assert.equal(base.revision, plan.baseRevision);
  const applied = await port.apply(request);
  assert.equal(applied.status, 'applied');
  if (applied.status !== 'applied') throw new Error('the fixture must apply');
  assert.deepEqual(messages, input, 'apply stages, never mutates');
  assert.equal(port.commit(), true);

  // Criterion 1 — the prefix. Message 0 is the very object the host handed in and
  // deep-equals its input copy; the node bytes before the cut hash identically.
  assert.equal(messages[0], firstMessage, 'the prefix message came back by reference');
  assert.deepEqual(messages[0], input[0]);
  assert.deepEqual(nodeShas(messages).slice(0, plan.cutIndex), prefixShas,
    'every node byte before the cut is unchanged');
  const rebuiltAssistant = messages[anchorEntryIndex];
  assert.ok(rebuiltAssistant !== undefined);
  assert.notEqual(rebuiltAssistant, input[anchorEntryIndex],
    'the cut message is rebuilt because it held the call');
  assert.equal(rebuiltAssistant.content[0], assistantParts[0],
    'the surviving text part is the host\'s own object');

  // Criterion 2 — the ledger-named unit is gone, and so is the tool message that
  // held only its result. Every message outside that span is the host's object.
  const forgotten = forgottenNodeId(input);
  const after = ids(messages);
  assert.equal(after.includes(forgotten), false, 'the forgotten unit left the array');
  assert.equal(messages.some(message => message.id === 'msg_t1'), false,
    'the result message left with its unit');
  assert.equal(messages[3], hostMessages[3], 'the second prompt is the host\'s own object');
  assert.equal(messages[4], hostMessages[4], 'the closing answer is the host\'s own object');
  assert.deepEqual(messages.filter(message => !isReceipt(message)).map(message => message.id),
    ['msg_u1', 'msg_a1', 'msg_u2', 'msg_a2'],
    'every unnamed node is still there, in order');
  // The prefix's node list is exactly the nodes before the cut.
  assert.deepEqual(ids(messages).slice(0, plan.cutIndex), after.slice(0, plan.cutIndex));

  // Criterion 3 — one receipt, present exactly once, after its anchor.
  const receipts = messages.filter(isReceipt);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.ok(receipt !== undefined);
  const receiptIndex = messages.indexOf(receipt);
  assert.equal(receiptIndex, anchorEntryIndex + 1, 'immediately after its anchor message');
  const receiptId = opencodeReceiptEntryId('intent-1', 0);
  assert.equal(receipt[OPENCODE_RECORD_ID_FIELD], receiptId);
  assert.equal(receipt[OPENCODE_RECEIPT_OF_FIELD], 'note-1',
    'the receipt names the ledger record it renders');
  assert.equal(receipt[OPENCODE_FORGOTTEN_NODE_FIELD], forgotten,
    'the receipt names the node it replaced');
  assert.equal(receiptText(receipt),
    opencodeReceiptTextWithPass(RECEIPT_TEXT, 'intent-1'),
    'the receipt renders the ledger bytes with its own pass');
  assert.equal(receiptText(receipt).includes(opencodeReceiptPassSegment('intent-1')), true,
    'the pass segment sits before the recall marker');
  assert.equal(receipt.role, 'user');

  assert.equal((await port.snapshot()).revision, applied.receipt.resultRevision);
  assert.deepEqual(await port.lookupReceipt('intent-1'), applied);
});

/**
 * Criterion 4 — replay and the purity claims.
 */
const REPLAY_ROWS: readonly Row[] = [
  { name: 'a second derivation over its own output is the identity',
    async run(at) {
      const request = fixtureRequest();
      const messages = wireArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES,
        deriveRevert: deriveOpencodeRevert,
      });
      const base = await port.snapshot();
      assert.equal((await port.apply(request)).status, 'applied', at('the first apply stages'));
      assert.equal(port.commit(), true, at('the first commit lands'));
      const output = structuredClone(messages) as OpencodeMessage[];

      const again = deriveOpencodeRevert(request, output, new Map([['intent-1', {
        intentId: 'intent-1', planSha256: request.application.revert?.planSha256 ?? '',
        cutIndex: 2, survivors: [], receipts: ['note-1'],
      }]]));
      assert.equal(again.status, 'staged', at('the recognition path stages'));
      if (again.status !== 'staged') return;
      assert.deepEqual(again.messages, output, at('the second run is the first run\'s output'));
      assert.equal(again.messages.length, output.length, at('nothing was appended twice'));

      const replay = await port.apply(request);
      assert.equal(replay.status, 'applied', at('the replay answers from the receipt'));
      assert.deepEqual(replay, await port.apply(request), at('a third call answers identically'));
      assert.equal(port.commit(), false, at('the replay staged nothing'));
      assert.deepEqual(messages, output, at('the array is the first run\'s output'));

      const fresh = createOpencodePort({
        sessionId, clock, messages: output, capabilities: REVERT_CAPABILITIES,
        deriveRevert: deriveOpencodeRevert,
      });
      const freshBase = await fresh.snapshot();
      assert.notEqual(freshBase.revision, base.revision, at('the output is a different array'));
      assert.deepEqual(await fresh.apply(request), {
        status: 'not-applied', reason: 'stale-revision',
      }, at('a plan approved against the pre-apply array cannot apply to the output'));
    } },
  { name: 'a partially present plan refuses intent-conflict and keeps every byte',
    run(at) {
      const request = fixtureRequest();
      const messages = wireArray();
      // The receipt is in the array, but the unit it says it replaced is still
      // there: some earlier run half-applied this plan.
      const receiptLine = opencodeReceiptTextWithPass(RECEIPT_TEXT, 'intent-1');
      assert.ok(receiptLine !== null, at('the fixture text is the product\'s receipt line'));
      const partial = [...messages, receiptMessage(
        'intent-1', 0, 'note-1', receiptLine, forgottenNodeId(messages))];
      const before = structuredClone(partial);
      const outcome = deriveOpencodeRevert(request, partial);
      assert.equal(outcome.status, 'refused', at('the half-applied array is refused'));
      if (outcome.status !== 'refused') return;
      assert.equal(outcome.code, 'intent-conflict', at('the class is intent-conflict'));
      assert.equal(outcome.reason, 'host-error', at('the reason is a host error'));
      assert.deepEqual(partial, before, at('the array keeps every byte'));

      const indexed = deriveOpencodeRevert(request, messages, new Map([['intent-1', {
        intentId: 'intent-1', planSha256: 'other-plan', cutIndex: 0, survivors: [], receipts: [],
      }]]));
      assert.equal(indexed.status, 'refused', at('a second plan under one intent is refused'));
      if (indexed.status === 'refused') assert.equal(indexed.code, 'intent-conflict',
        at('and it is the same class'));
    } },
  { name: 'the derivation never mutates its input, and the same pair derives the same array',
    run(at) {
      const request = fixtureRequest();
      const messages = wireArray();
      const before = structuredClone(messages);
      const first = deriveOpencodeRevert(request, messages);
      const second = deriveOpencodeRevert(request, structuredClone(messages) as OpencodeMessage[]);
      assert.equal(first.status, 'staged', at('the first derivation stages'));
      assert.equal(second.status, 'staged', at('the second derivation stages'));
      if (first.status !== 'staged' || second.status !== 'staged') return;
      assert.deepEqual(first.messages, second.messages, at('the same array and plan, the same result'));
      assert.deepEqual(messages, before, at('the input array is never written'));
      const derived = first.messages;
      assert.equal(derived[0], messages[0], at('the first prompt came back by reference'));
      const keptPrompt = derived.find(message => message.id === 'msg_u2');
      assert.equal(keptPrompt, messages[3], at('the unnamed prompt came back by reference'));
      const closing = derived.find(message => message.id === 'msg_a2');
      assert.equal(closing, messages[4], at('the unnamed closing answer came back by reference'));
      const rebuilt = derived.find(message => message.id === 'msg_a1');
      assert.notEqual(rebuilt, messages[1], at('the message holding the removed call is rebuilt'));
      assert.equal(rebuilt?.content.some(part => part['type'] === 'tool-call'), false,
        at('the removed call is gone from the rebuilt message'));
    } },
];

/** One row per refusal class, as a `Row` that names the class it breaks. */
const REFUSAL_RUN_ROWS: readonly Row[] = REFUSAL_ROWS.map(({ code, reason, build }) => ({
  name: `refusal class ${code}`,
  run(at) {
    const { request, messages } = build(at);
    const before = structuredClone(messages);
    const outcome = deriveOpencodeRevert(request, messages);
    assert.equal(outcome.status, 'refused', at('the derivation refuses'));
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.code, code, at(`the class is ${code}`));
    if (reason !== undefined) assert.equal(outcome.reason, reason, at('the reason matches the class'));
    assert.deepEqual(messages, before, at('the messages keep every byte'));
  },
}));

test('criteria 4+5: replays are the identity, and every refusal class refuses by name', async () => {
  await runRows(REPLAY_ROWS);
  await runRows(REFUSAL_RUN_ROWS);
});

/**
 * Criterion 6 — the flag and the two engine arms.
 */
const ENGINE_ROWS: readonly Row[] = [
  { name: 'criterion 6a: the flags are false by default and true only with wireRevert',
    run(at) {
      const shipped = createOpencodeCapabilities();
      assert.equal(shipped.revertHistory, false,
        at('a build with no proof must declare the refusal (ADR-0017; ISSUE-010)'));
      const wired = createOpencodeCapabilities({ wireRevert: true });
      assert.equal(wired.revertHistory, true, at('the literal true flips the flag'));
      const { revertHistory: _a, ...shippedRest } = shipped;
      const { revertHistory: _b, ...wiredRest } = wired;
      void _a; void _b;
      assert.deepEqual(wiredRest, shippedRest, at('no other flag moved'));
      assert.deepEqual(Object.keys(wired).sort(), Object.keys(shipped).sort(),
        at('the flag set is the same size'));
      assert.equal(createOpencodeCapabilities({ wireRevert: false }).revertHistory, false,
        at('false is not a declaration'));
    } },
  { name: 'criterion 6b: false flags record nothing, skip by name, and stage nothing',
    async run(at) {
      const messages = wireArray();
      const capabilities = createOpencodeCapabilities();
      assert.equal(capabilities.revertHistory, false, at('the shipped flags refuse the seam'));
      const ledger = await SqliteLedger.open({
        databasePath: ':memory:', blobStore: new MemoryBlobStore(), clock,
      });
      const port = createOpencodePort({ sessionId, clock, messages, capabilities });
      const telemetry: TelemetryEvent[] = [];
      const engine = await RacoonsEngine.open({
        sessionId, capabilities, config: DEFAULT_CONFIG, clock,
        meter: new Meter(new CharHeuristicTokenMeter()),
        ledger, rules: createDefaultRules(DEFAULT_CONFIG), port,
        onTelemetry: event => telemetry.push(event),
      });
      const merged = pruneDocument(deriveOpencodeSnapshot(messages, { sessionId }).snapshot);
      const before = structuredClone(messages);
      const outcome = await engine.process({
        kind: 'prune', eventId: 'prune-false', round: 1, verdicts: merged, window: 200_000,
      });
      assert.equal(outcome.status, 'unchanged',
        at('a plan the adapter cannot apply is never claimed as applied'));
      const skips = telemetry.filter(event => event.kind === 'skip');
      assert.equal(skips.length, 1, at('one skip line for the one refused plan'));
      assert.equal(skips[0]?.['reason'], 'unsupported-capability',
        at('the refusal names the missing seam (ADR-0018 §5)'));
      assert.deepEqual(messages, before, at('the messages keep every byte'));
      assert.equal(port.commit(), false, at('a refused plan stages nothing'));
      assert.deepEqual(await port.lookupReceipt('intent-anything'), { status: 'unknown' },
        at('a refusal is not a receipt'));
      await ledger.close();
    } },
  { name: 'criterion 6c: wireRevert flags, and the engine applies the revert on the wire',
    async run(at) {
      const messages = wireArray();
      const firstMessage = messages[0];
      const capabilities = REVERT_CAPABILITIES;
      const ledger = await SqliteLedger.open({
        databasePath: ':memory:', blobStore: new MemoryBlobStore(), clock,
      });
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities, deriveRevert: deriveOpencodeRevert,
      });
      const telemetry: TelemetryEvent[] = [];
      const engine = await RacoonsEngine.open({
        sessionId, capabilities, config: DEFAULT_CONFIG, clock,
        meter: new Meter(new CharHeuristicTokenMeter()),
        ledger, rules: createDefaultRules(DEFAULT_CONFIG), port,
        onTelemetry: event => telemetry.push(event),
      });
      const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
      const merged = pruneDocument(derived);
      const input = structuredClone(messages) as OpencodeMessage[];
      const prefixShas = nodeShas(messages).slice(0, derived.nodes.findIndex(
        node => node.kind === 'tool-result'));
      const forgotten = forgottenNodeId(messages);

      const outcome = await engine.process({
        kind: 'prune', eventId: 'prune-true', round: 1, verdicts: merged, window: 200_000,
      });
      assert.equal(outcome.status, 'applied', at(JSON.stringify(outcome.validation?.ok === false
        ? outcome.validation.issues : [])));
      assert.ok(outcome.receipt !== null, at('an applied plan carries a receipt'));
      assert.equal(outcome.committed, true,
        at('the engine commits the stage before it answers applied'));
      assert.equal(port.commit(), false, at('the mount has nothing left to commit'));
      assert.deepEqual(telemetry.filter(event => event.kind === 'skip'), [],
        at('nothing was skipped: the seam the plan needs exists'));

      assert.equal(messages[0], firstMessage, at('the prefix message came back by reference'));
      assert.deepEqual(messages[0], input[0], at('the prefix message deep-equals its input copy'));
      assert.deepEqual(nodeShas(messages).slice(0, prefixShas.length), prefixShas,
        at('every node byte before the cut is unchanged'));
      assert.equal(ids(messages).includes(forgotten), false, at('the forgotten unit left the array'));
      const receipts = messages.filter(isReceipt);
      assert.equal(receipts.length, 1, at('exactly one receipt message'));
      const receipt = receipts[0];
      assert.ok(receipt !== undefined, at('the receipt message exists'));
      assert.equal(messages.indexOf(receipt), 2, at('directly after the message holding the anchor'));
      const body = receiptText(receipt);
      const recallId = /· necromancy (\S+)$/u.exec(body)?.[1];
      assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
        at('the receipt carries a recall id the ledger banks'));
      const record = await ledger.recall(recallId);
      assert.ok(record.parts.length === 1, at('the ledger holds the one rendered part'));
      assert.equal(receipt[OPENCODE_RECORD_ID_FIELD],
        opencodeReceiptEntryId(outcome.intentId ?? '', 0), at('the receipt names its own entry id'));
      await ledger.close();
    } },
];

test('criterion 6: the flag is false by default, and the engine answers as its flags allow',
  async () => {
    await runRows(ENGINE_ROWS);
  });

test('the mounted context hook applies core\'s own plan onto the request messages', async () => {
  // The strongest shape: nothing here builds a plan. The mount runs core's own
  // proof rule over the messages it is handed, the guard approves it, the port
  // stages the derivation, and the hook commits it onto that same array. A second
  // read of one path with identical bytes supersedes the first (`superseded-read`,
  // ADR-0018).
  const body = `alpha ${'x'.repeat(9000)}`;
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read it.')]),
    assistantMessage('msg_a1', [text('Reading.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
    userMessage('msg_u2', [text('Read it again.')]),
    assistantMessage('msg_a2', [text('Reading again.'), toolCall('call_2', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(body))]),
  ];
  const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
  const hostMessages = [...messages];
  const before = structuredClone(messages);
  const readNode = ids(messages).find(id => id.includes('call_1'));
  assert.ok(readNode !== undefined, 'the first read is a unit of the array');
  try {
    await mount.transform(sessionId, messages);
    assert.notDeepEqual(messages, before, 'the mount applied core\'s plan on the wire');
    assert.equal(messages[0], hostMessages[0], 'the prefix prompt is the host\'s own object');
    assert.equal(ids(messages).includes(readNode), false, 'the superseded read left the array');
    // The later read survives: it is the copy the transcript keeps.
    assert.equal(messages.some(message => message.id === 'msg_t2'), true);
    const receipts = messages.filter(isReceipt);
    assert.equal(receipts.length, 1, 'one receipt for one burnt unit');
    const receipt = receipts[0];
    assert.ok(receipt !== undefined);
    const rendered = receiptText(receipt);
    assert.match(rendered, /^\[not retained\] /u, 'the receipt is core\'s own line');
    assert.ok(rendered.includes(readNode) || rendered.includes('NOTES.md'),
      'the receipt names the node it replaced, or the hit path that names it');
    assert.match(rendered, /· necromancy recall:sha256:[0-9a-f]{64}$/u,
      'the receipt carries the recall id the ledger banks the bytes under');
  } finally {
    await mount.close();
  }
});

// --- the ask's own verdict map (ADR-0054 decision 5) -------------------------

/**
 * Two units in one request: two reads of different files, both above the 512
 * floor. One is answered `forgetall`; the other is untouched and is the byte
 * witness the apply must not move.
 */
function twoUnitArray(): OpencodeMessage[] {
  const first = `# First\n\n${'alpha line\n'.repeat(1100)}`;
  const second = `# Second\n\n${'beta line\n'.repeat(1000)}`;
  return [
    userMessage('msg_u1', [text('Read the first file.')]),
    assistantMessage('msg_a1', [
      text('Reading FIRST.md.'),
      toolCall('call_a', 'read', { filePath: 'FIRST.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_a', 'read', textResult(first))]),
    userMessage('msg_u2', [text('Read the second file.')]),
    assistantMessage('msg_a2', [
      text('Reading SECOND.md.'),
      toolCall('call_b', 'read', { filePath: 'SECOND.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_b', 'read', textResult(second))]),
    assistantMessage('msg_a3', [text('Both files are read.')]),
  ];
}

/**
 * The ask lane's own event id (ADR-0054 decision 5): its own `ask` namespace,
 * never the step lane's. `rewrites` is how many plans the ledger has already
 * applied at this exact revision — the same durable count the adapter reads
 * before a step pass, so a rebuilt request gets a new id instead of a replay.
 */
function askEventId(revision: string, rewrites: number): string {
  const base = `oc:${sessionId}:ask:${revision}`;
  return rewrites === 0 ? base : `${base}#${String(rewrites + 1)}`;
}

/** How many applied plans the ledger already holds at one base revision. */
async function appliedAt(ledger: Ledger, revision: string): Promise<number> {
  let rewrites = 0;
  for await (const { event } of ledger.events(sessionId)) {
    if (event.kind === 'applied' && event.receipt.baseRevision === revision) rewrites += 1;
  }
  return rewrites;
}

/**
 * One ask apply step, driven exactly as ADR-0054 decision 5 will drive it from
 * `transformStep`: the shipped 512 floor, the ask's own units, the core document
 * and the adapter's own engine and port. The verdict map is the caller's; no
 * ask, no store and no grammar run here.
 */
async function applyAskVerdicts(
  entry: OpencodeSessionEntry,
  messages: OpencodeMessage[],
  verdicts: ReadonlyMap<string, WireAnswer>,
  window: number,
): Promise<{ readonly result: EngineResult; readonly eventId: string }> {
  const snap = entry.port.observe(messages);
  const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
    .units(snap);
  const nodes = snap.nodes.filter((node): node is ToolResultNode => node.kind === 'tool-result');
  const document = applicationFromVerdicts({ units, nodes, verdicts });
  const eventId = askEventId(snap.revision, await appliedAt(entry.ledger, snap.revision));
  const result = await entry.engine.process({
    kind: 'prune', eventId, round: 1, verdicts: document, window,
  });
  return { result, eventId };
}

/** The mount journal's applied-rewrite line; the test fails when it is absent. */
function appliedRewriteLine(journal: readonly OpencodeJournalRecord[]): OpencodeJournalRecord {
  const line = journal.find(record => record.kind === 'telemetry'
    && (record['event'] as { readonly kind?: unknown } | null)?.kind === 'revert-applied');
  assert.ok(line !== undefined, 'the mount journal records the applied rewrite');
  return line;
}

/** One readable `forgetall` for one unit, built directly, never parsed. */
function forgetAll(unitId: string, summary: string | null = 'an old read'): WireAnswer {
  return { verdict: { unitId, action: 'forgetall', summary, answeredInRound: 1 } };
}

/**
 * The provider-shape pairing rule the host enforces: every `tool` message answers
 * a `tool_calls` entry on the nearest preceding assistant message, and no user
 * message may stand between them. Returns the ids of the `tool` messages that
 * break the rule.
 */
function orphanToolMessages(messages: readonly OpencodeMessage[]): string[] {
  const orphans: string[] = [];
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      const answered = message.content
        .filter(part => part.type === 'tool-result')
        .map(part => part['id']);
      if (answered.length === 0
        || answered.some(id => typeof id !== 'string' || !pending.has(id))) {
        orphans.push(message.id ?? '(no id)');
      }
      continue;
    }
    pending = new Set();
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call' && typeof part['id'] === 'string') pending.add(part['id']);
      }
    }
  }
  return orphans;
}

/** Every 512-floor unit of one array, in the order the ask lane reads them. */
function askUnits(messages: readonly OpencodeMessage[]) {
  return new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
    .units(deriveOpencodeSnapshot(messages, { sessionId }).snapshot);
}

/**
 * The ask apply rows. Each one builds a session from the host's own array, then
 * hands the engine the verdict map the ask lane will store: the fail-fast proof
 * that the adapter's existing engine and port can carry the document, before any
 * ask wiring exists.
 */
const ASK_APPLY_ROWS: readonly Row[] = [
  { name: 'one forgetall removes its unit and a rebuilt array applies again under a new id',
    async run(at) {
      const store = twoUnitArray();
      const messages = structuredClone(store) as OpencodeMessage[];
      const journal: OpencodeJournalRecord[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        journal: record => journal.push(record),
      });
      try {
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));

        const base = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
        const removedNode = base.nodes.find(node =>
          node.kind === 'tool-result' && node.id.includes('call_a'));
        const keptNode = base.nodes.find(node =>
          node.kind === 'tool-result' && node.id.includes('call_b'));
        assert.ok(removedNode !== undefined && removedNode.kind === 'tool-result',
          at('the first read is one unit'));
        assert.ok(keptNode !== undefined && keptNode.kind === 'tool-result',
          at('the second read is the other unit'));
        const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
          .units(base);
        assert.equal(units.length, 2, at('the fixture holds exactly two units'));
        const removedUnit = units.find(unit => unit.nodeId === removedNode.id);
        const keptUnit = units.find(unit => unit.nodeId === keptNode.id);
        assert.ok(removedUnit !== undefined, at('the answered unit is one of them'));
        assert.ok(keptUnit !== undefined, at('the untouched unit is the other'));
        const untouched = messages.find(message => message.id === 'msg_t2');
        assert.ok(untouched !== undefined, at('the untouched unit has its host message'));
        const untouchedBytes = structuredClone(untouched);

        // The map is built here, not asked for: only the first unit is answered.
        const verdicts = new Map<string, WireAnswer>([
          [removedUnit.id, forgetAll(removedUnit.id)],
        ]);

        const first = await applyAskVerdicts(entry, messages, verdicts, 200_000);
        assert.equal(first.result.status, 'applied',
          at('the engine record says the pass applied'));
        assert.equal(first.result.receipt?.intentId, first.result.intentId,
          at('the engine result carries the applied receipt'));
        assert.equal(first.eventId, `oc:${sessionId}:ask:${base.revision}`,
          at('the first pass keeps the ask namespace and the bare revision'));
        assert.equal(first.result.committed, true,
          at('the engine commits the apply onto the host array'));

        // Exactly the answered unit left; every other message is still there.
        assert.equal(ids(messages).includes(removedNode.id), false,
          at('the answered unit left the array'));
        assert.equal(ids(messages).includes(keptNode.id), true,
          at('the untouched unit stayed'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the answered unit\'s result message left'));
        assert.equal(messages.some(message => message.id === 'msg_t2'), true,
          at('the untouched unit\'s message stayed'));
        assert.deepEqual(
          messages.filter(message => !isReceipt(message)).map(message => message.id),
          ['msg_u1', 'msg_a1', 'msg_u2', 'msg_a2', 'msg_t2', 'msg_a3'],
          at('every message outside the answered unit is still there, in order'),
        );

        // One receipt for the removed unit, naming its ledger record.
        const receipts = messages.filter(isReceipt);
        assert.equal(receipts.length, 1, at('one receipt for one removed unit'));
        const receipt = receipts[0];
        assert.ok(receipt !== undefined, at('the receipt message exists'));
        assert.equal(receipt[OPENCODE_FORGOTTEN_NODE_FIELD], removedNode.id,
          at('the receipt names the node it replaced'));
        assert.equal(receipt[OPENCODE_RECORD_ID_FIELD],
          opencodeReceiptEntryId(first.result.intentId ?? '', 0),
          at('the receipt names its own ledger entry'));
        const recallId = /· necromancy (\S+)$/u.exec(receiptText(receipt))?.[1];
        assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
          at('the receipt carries a recall id'));
        const recalled = await entry.ledger.recall(recallId);
        assert.equal(
          recalled.parts.reduce((sum, part) => sum + part.bytes.length, 0),
          removedNode.byteLength, at('the recall id restores the removed unit\'s bytes'),
        );

        // The record: the ledger applied this intent, and the mount journal says
        // the request was rewritten.
        const applied: NonNullable<EngineResult['receipt']>[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'applied') applied.push(event.receipt);
        }
        assert.equal(applied.length, 1, at('the ledger holds exactly one applied record'));
        assert.equal(applied[0]?.intentId, first.result.intentId,
          at('the applied record is this pass'));
        const rewrite = appliedRewriteLine(journal)['event'] as { readonly freedBytes?: unknown };
        assert.ok(typeof rewrite.freedBytes === 'number' && rewrite.freedBytes > 0,
          at('the journal names the bytes the rewrite freed'));

        // The untouched unit is byte-identical: the host's own object, same node sha.
        assert.equal(messages.find(message => message.id === 'msg_t2'), untouched,
          at('the untouched unit is the host\'s own object after the first transform'));
        assert.equal(nodeShas(messages).find(([id]) => id === keptNode.id)?.[1], keptNode.sha256,
          at('the untouched unit\'s bytes hash identically after the first transform'));

        // The host rebuilds the request from its own store: the same content
        // returns at the same base revision, so the removal must happen again.
        // A replayed event id would answer `unchanged`; this pass gets its own.
        messages.splice(0, messages.length, ...(structuredClone(store) as OpencodeMessage[]));
        assert.equal(deriveOpencodeSnapshot(messages, { sessionId }).snapshot.revision,
          base.revision, at('the rebuilt array has the same base revision'));
        const second = await applyAskVerdicts(entry, messages, verdicts, 200_000);
        assert.equal(second.result.status, 'applied',
          at('the second transform applies, never unchanged'));
        assert.equal(second.eventId, `oc:${sessionId}:ask:${base.revision}#2`,
          at('the second transform carries a new event id'));
        assert.notEqual(second.result.intentId, first.result.intentId,
          at('the second transform is its own intent, not the first receipt'));
        assert.equal(second.result.committed, true,
          at('the engine commits the second apply onto the rebuilt array'));

        assert.equal(ids(messages).includes(removedNode.id), false,
          at('the second request lost the answered unit too'));
        assert.equal(ids(messages).includes(keptNode.id), true,
          at('the second request keeps the untouched unit'));
        const secondReceipts = messages.filter(isReceipt);
        assert.equal(secondReceipts.length, 1,
          at('the second request carries exactly one receipt'));
        const secondReceipt = secondReceipts[0];
        assert.ok(secondReceipt !== undefined, at('the second receipt message exists'));
        assert.equal(secondReceipt[OPENCODE_FORGOTTEN_NODE_FIELD], removedNode.id,
          at('the second receipt names the same node'));
        assert.equal(secondReceipt[OPENCODE_RECORD_ID_FIELD],
          opencodeReceiptEntryId(second.result.intentId ?? '', 0),
          at('the second receipt names the second intent'));
        const secondRecall = /· necromancy (\S+)$/u.exec(receiptText(secondReceipt))?.[1];
        assert.ok(secondRecall !== undefined && secondRecall.startsWith('recall:sha256:'),
          at('the second receipt carries a recall id'));
        await entry.ledger.recall(secondRecall);

        // The untouched unit is byte-identical after the second transform too.
        const untouchedAfterSecond = messages.find(message => message.id === 'msg_t2');
        assert.ok(untouchedAfterSecond !== undefined, at('the untouched message survived'));
        assert.deepEqual(untouchedAfterSecond, untouchedBytes,
          at('the untouched unit is byte-identical after the second transform'));
        assert.equal(nodeShas(messages).find(([id]) => id === keptNode.id)?.[1], keptNode.sha256,
          at('the untouched unit\'s bytes hash identically after the second transform'));

        assert.equal(await appliedAt(entry.ledger, base.revision), 2,
          at('the ledger holds two applied rewrites at the base revision'));
      } finally { await mount.close(); }
    } },
  { name: 'window 0 refuses the pass and keeps every byte',
    async run(at) {
      const messages = twoUnitArray();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
          .units(deriveOpencodeSnapshot(messages, { sessionId }).snapshot);
        const unit = units[0];
        assert.ok(unit !== undefined, at('the fixture holds a unit'));
        const before = structuredClone(messages);

        const outcome = await applyAskVerdicts(entry, messages,
          new Map([[unit.id, forgetAll(unit.id)]]), 0);
        assert.equal(outcome.result.status, 'rejected',
          at('the guard refuses a non-positive window'));
        assert.equal(outcome.result.validation?.ok, false, at('the refusal is recorded'));
        assert.ok(outcome.result.validation?.ok === false
          && outcome.result.validation.issues.some(issue =>
            issue.code === 'invalid-plan' && issue.detail.includes('window')),
        at('the refusal names the window'));
        assert.equal(outcome.result.receipt, null, at('a refusal lands no receipt'));
        assert.equal(entry.port.commit(), false, at('a refusal stages nothing'));
        assert.deepEqual(messages, before, at('the host array keeps every byte'));
        assert.equal(messages.filter(isReceipt).length, 0, at('no receipt is written'));
      } finally { await mount.close(); }
    } },
  { name: 'a keeplines verdict applies nothing',
    async run(at) {
      const messages = twoUnitArray();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
          .units(deriveOpencodeSnapshot(messages, { sessionId }).snapshot);
        const unit = units[0];
        assert.ok(unit !== undefined, at('the fixture holds a unit'));
        const before = structuredClone(messages);

        const outcome = await applyAskVerdicts(entry, messages, new Map([[unit.id, {
          verdict: { unitId: unit.id, action: 'keeplines',
            ranges: [{ from: 1, to: 1 }], answeredInRound: 1 },
          keeplinesSummary: 'kept the head',
        }]]), 200_000);
        assert.equal(outcome.result.status, 'unchanged',
          at('a keeplines document plans no removal'));
        assert.equal(entry.port.commit(), false, at('nothing was staged'));
        assert.deepEqual(messages, before, at('the host array keeps every byte'));
        assert.equal(messages.filter(isReceipt).length, 0, at('no receipt is written'));
      } finally { await mount.close(); }
    } },
  { name: 'one forgetall drops its provider-shape tool message and the assistant tool_calls entry',
    async run(at) {
      const body = `# One\n\n${'alpha line\n'.repeat(1100)}`;
      const messages: OpencodeMessage[] = [
        userMessage('msg_u0', [text('Read it.')]),
        assistantMessage('msg_a0', [
          text('Reading.'),
          toolCall('call_one', 'read', { filePath: 'ONE.md' }),
        ]),
        toolMessage('msg_t0', [toolResult('call_one', 'read', textResult(body))]),
      ];
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const unit = askUnits(messages).find(candidate => candidate.nodeId.includes('call_one'));
        assert.ok(unit !== undefined, at('the read is one unit'));
        const removedNode = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
          .find(node => node.kind === 'tool-result' && node.id === unit.nodeId);
        assert.ok(removedNode !== undefined && removedNode.kind === 'tool-result',
          at('the unit is a tool-result node'));

        const outcome = await applyAskVerdicts(entry, messages,
          new Map([[unit.id, forgetAll(unit.id)]]), 200_000);
        assert.equal(outcome.result.status, 'applied', at('the ask verdict applied'));
        assert.equal(outcome.result.committed, true,
          at('the engine commits the ask apply onto the host array'));

        assert.equal(messages.some(message => message.id === 'msg_t0'), false,
          at('the tool message left with its call'));
        const assistant = messages.find(message => message.id === 'msg_a0');
        assert.ok(assistant !== undefined, at('the assistant message survives on its text'));
        assert.equal(assistant.content.some(part => part.type === 'tool-call'), false,
          at('the assistant carries no tool_calls entry'));
        assert.deepEqual(orphanToolMessages(messages), [],
          at('no tool message lacks a preceding assistant tool_calls'));

        const receipts = messages.filter(isReceipt);
        assert.equal(receipts.length, 1, at('one receipt for the forgotten unit'));
        const receipt = receipts[0];
        assert.ok(receipt !== undefined, at('the receipt message exists'));
        const recallId = /· necromancy (\S+)$/u.exec(receiptText(receipt))?.[1];
        assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
          at('the receipt carries a recall id'));
        const recalled = await entry.ledger.recall(recallId);
        assert.equal(recalled.parts.reduce((sum, part) => sum + part.bytes.length, 0),
          removedNode.byteLength, at('the receipt resolves to the removed unit bytes'));
      } finally { await mount.close(); }
    } },
  { name: 'removing one call of two keeps the other call and its tool message',
    async run(at) {
      const first = `# First\n\n${'alpha line\n'.repeat(1100)}`;
      const second = `# Second\n\n${'beta line\n'.repeat(1000)}`;
      const messages: OpencodeMessage[] = [
        userMessage('msg_u0', [text('Read both.')]),
        assistantMessage('msg_a0', [
          toolCall('call_a', 'read', { filePath: 'A.md' }),
          toolCall('call_b', 'read', { filePath: 'B.md' }),
        ]),
        toolMessage('msg_ta', [toolResult('call_a', 'read', textResult(first))]),
        toolMessage('msg_tb', [toolResult('call_b', 'read', textResult(second))]),
        userMessage('msg_u1', [text('Next.')]),
      ];
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
      try {
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const unit = askUnits(messages).find(candidate => candidate.nodeId.includes('call_b'));
        assert.ok(unit !== undefined, at('the second read is one unit'));
        const removedNode = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
          .find(node => node.kind === 'tool-result' && node.id === unit.nodeId);
        assert.ok(removedNode !== undefined && removedNode.kind === 'tool-result',
          at('the removed unit is a tool-result node'));

        const outcome = await applyAskVerdicts(entry, messages,
          new Map([[unit.id, forgetAll(unit.id)]]), 200_000);
        assert.equal(outcome.result.status, 'applied', at('the ask verdict applied'));
        assert.equal(outcome.result.committed, true,
          at('the engine commits the ask apply onto the host array'));

        assert.equal(messages.some(message => message.id === 'msg_tb'), false,
          at('the forgotten call\'s tool message left'));
        const assistant = messages.find(message => message.id === 'msg_a0');
        assert.ok(assistant !== undefined, at('the assistant message survives'));
        assert.deepEqual(
          assistant.content.filter(part => part.type === 'tool-call').map(part => part['id']),
          ['call_a'], at('only the kept call remains on the assistant'),
        );
        const keptResult = messages.find(message => message.id === 'msg_ta');
        assert.ok(keptResult !== undefined, at('the kept call\'s tool message stays'));
        assert.equal(messages.indexOf(keptResult), messages.indexOf(assistant) + 1,
          at('the kept result directly follows its assistant tool_calls'));
        assert.deepEqual(orphanToolMessages(messages), [],
          at('no tool message lacks a preceding assistant tool_calls'));

        const receipts = messages.filter(isReceipt);
        assert.equal(receipts.length, 1, at('one receipt for the forgotten unit'));
        const receipt = receipts[0];
        assert.ok(receipt !== undefined, at('the receipt message exists'));
        assert.ok(messages.indexOf(receipt) > messages.indexOf(keptResult),
          at('the receipt lands after the kept unit'));
        const recallId = /· necromancy (\S+)$/u.exec(receiptText(receipt))?.[1];
        assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
          at('the receipt carries a recall id'));
        const recalled = await entry.ledger.recall(recallId);
        assert.equal(recalled.parts.reduce((sum, part) => sum + part.bytes.length, 0),
          removedNode.byteLength, at('the receipt resolves to the removed unit bytes'));
      } finally { await mount.close(); }
    } },
];

test('the ask verdict map applies through the real engine and port (ADR-0054 decision 5)',
  async () => { await runRows(ASK_APPLY_ROWS); });

/* ------------------------------------------------- ISSUE-256 item 1: receipt <-> pass */

/** Two units in one request: separate files, so each pass has its own receipt. */
function twoUnitWireArray(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(BIG_BODY))]),
    userMessage('msg_u2', [text('Read TODO.md too.')]),
    assistantMessage('msg_a2', [
      text('Reading TODO.md.'),
      toolCall('call_2', 'read', { filePath: 'TODO.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(BIG_BODY))]),
    assistantMessage('msg_a3', [text('Both read.')]),
  ];
}

/** The plan core would produce for one named call's unit. */
function planForCall(
  messages: readonly OpencodeMessage[], callId: string, noteId: string,
  receiptText = RECEIPT_TEXT,
): ValidatedRevert {
  const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const nodes = derived.nodes;
  const forgotten = nodes.find(node =>
    node.kind === 'tool-result' && node.id === opencodeToolNodeId(sessionId, callId));
  assert.ok(forgotten !== undefined, `the array holds the unit of ${callId}`);
  const cutIndex = nodes.findIndex(node => node.id === forgotten.id);
  const survivors = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id).map(node => node.id);
  const keptBytes = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id)
    .reduce((sum, node) => sum + node.byteLength, 0);
  const previous = nodes[cutIndex - 1];
  assert.ok(previous !== undefined, 'the unit has a node before it');
  return sealPlan({
    cutIndex,
    survivors,
    appends: [{ afterNodeId: previous.id, noteId }],
    perNode: [{ nodeId: forgotten.id, noteId }],
    baseRevision: derived.revision,
  }, { freedBytes: forgotten.byteLength, keptBytes }, receiptText);
}

/** Apply one pass over the array and return what it left. */
function applyOnePass(
  messages: readonly OpencodeMessage[], passId: string, callId: string, noteId: string,
  receiptText: string, index: OpencodeAppliedPlanIndex = new Map(),
): readonly OpencodeMessage[] {
  const plan = planForCall(messages, callId, noteId, receiptText);
  const result = deriveOpencodeRevert(
    requestFor(plan, passId, noteId, receiptText), messages, index);
  assert.equal(result.status, 'staged', result.status === 'refused'
    ? `${result.code}: ${result.detail}` : 'the pass staged');
  if (result.status !== 'staged') throw new Error(`pass ${passId} did not stage`);
  return result.messages;
}

/** The canonical recall id a receipt fixture names. */
function recallIdOfText(text: string): string {
  const match = /· necromancy (\S+)$/u.exec(text);
  assert.ok(match?.[1] !== undefined, `the fixture text names a recall id: ${text}`);
  return match[1];
}

/** One applied-plan index row, as the port records a landed pass. */
function appliedPlanEntry(
  passId: string, plan: ValidatedRevert, receiptText = RECEIPT_TEXT,
  receiptTexts?: ReadonlyMap<string, string>,
): [string, OpencodeAppliedPlan] {
  const recallId = recallIdOfText(receiptText);
  return [passId, {
    intentId: passId,
    planSha256: plan.planSha256,
    cutIndex: plan.cutIndex,
    survivors: [...plan.survivors],
    receipts: plan.appends.map(append => append.noteId),
    // The port's row carries the recall id: the record id changes with the
    // event on every pass, the recall id does not.
    recalls: plan.appends.map(() => recallId),
    forgotten: plan.perNode.map(entry => entry.nodeId),
    ...(receiptTexts === undefined ? {} : { receiptTexts }),
  }];
}

const PASS_A = `intent:sha256:${'a'.repeat(64)}`;
const PASS_B = `intent:sha256:${'b'.repeat(64)}`;
const PASS_C = `intent:sha256:${'c'.repeat(64)}`;
const RECALL_A = `recall:sha256:${'a'.repeat(64)}`;
const RECEIPT_TEXT_A = `[not retained] NOTES.md · necromancy ${RECALL_A}`;
const RECEIPT_TEXT_B = `[not retained] TODO.md · necromancy recall:sha256:${'b'.repeat(64)}`;

/** How often `needle` occurs in `text`, counted outside the code under test. */
function occurrencesIn(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

interface ReceiptLineReader {
  isWireReceiptLine(text: string): boolean;
  receiptRecallIdsOfLine(text: string): readonly string[];
  receiptPassOfLine(text: string): {
    readonly status: string; readonly passId?: string; readonly passIds?: readonly string[];
  };
  receiptPassIdOfLine(text: string): string | null;
}

/**
 * The bench's one receipt parser, loaded at runtime. The adapter package does
 * not import `dev/bench` at build time; the test reads the same file the bench
 * checker and the mock read, so a wording change has one definition.
 */
const RECEIPT_LINE_URL = new URL('../../../../dev/bench/receipt-line.mjs', import.meta.url).href;
async function receiptLineReader(): Promise<ReceiptLineReader> {
  return await import(RECEIPT_LINE_URL) as ReceiptLineReader;
}

test('ISSUE-256 item 1: two passes, two receipt groups, each receipt names its own pass',
  async () => {
    const reader = await receiptLineReader();
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', 'note-a', RECEIPT_TEXT_A);
    const second = applyOnePass(first, PASS_B, 'call_2', 'note-b', RECEIPT_TEXT_B);
    const receipts = second.filter(isReceipt);
    assert.equal(receipts.length, 2, 'the assembled request carries both receipt groups');
    const receiptA = receipts.find(message =>
      message[OPENCODE_RECORD_ID_FIELD] === opencodeReceiptEntryId(PASS_A, 0));
    const receiptB = receipts.find(message =>
      message[OPENCODE_RECORD_ID_FIELD] === opencodeReceiptEntryId(PASS_B, 0));
    assert.ok(receiptA !== undefined, 'the first pass left its receipt');
    assert.ok(receiptB !== undefined, 'the second pass left its receipt');
    assert.equal(receiptA[OPENCODE_RECEIPT_OF_FIELD], 'note-a',
      'the first receipt still renders the first pass\'s record');
    assert.equal(receiptB[OPENCODE_RECEIPT_OF_FIELD], 'note-b',
      'the second receipt renders the second pass\'s record');
    const textA = receiptText(receiptA);
    const textB = receiptText(receiptB);
    const parsedA = reader.receiptPassOfLine(textA);
    const parsedB = reader.receiptPassOfLine(textB);
    assert.equal(parsedA.status, 'named',
      `the first receipt names a pass: ${JSON.stringify(parsedA)}`);
    assert.equal(parsedB.status, 'named',
      `the second receipt names a pass: ${JSON.stringify(parsedB)}`);
    assert.equal(parsedA.passId, PASS_A, 'the first receipt names the pass that wrote it');
    assert.equal(parsedB.passId, PASS_B, 'the second receipt names the pass that wrote it');
    assert.equal(occurrencesIn(textA, PASS_A), 1,
      'the first receipt names its pass exactly once');
    assert.equal(occurrencesIn(textB, PASS_B), 1,
      'the second receipt names its pass exactly once');
    assert.equal(textA.includes(PASS_B), false, 'a receipt never names another pass');
    assert.equal(textB.includes(PASS_A), false, 'a receipt never names another pass');
    assert.ok(second.indexOf(receiptA) < second.indexOf(receiptB),
      'the receipt groups stay in the order the passes landed');
  });

test('ISSUE-256 item 1: a receipt from an older writer names no pass', async () => {
  const reader = await receiptLineReader();
  const messages = twoUnitWireArray();
  // The pre-256 writer: the ledger's line and no pass segment.
  const oldReceipt = receiptMessage(
    'intent-old', 0, 'note-old', RECEIPT_TEXT, forgottenNodeId(messages));
  const oldText = receiptText(oldReceipt);
  const parsed = reader.receiptPassOfLine(oldText);
  assert.equal(parsed.status, 'absent', 'an older receipt is reported as naming no pass');
  assert.equal(reader.receiptPassIdOfLine(oldText), null,
    'the convenience reader returns no pass, never a guess');
  // The same line with this writer's segment is named, so `absent` is the
  // missing marker and not a parse failure.
  const newText = opencodeReceiptTextWithPass(RECEIPT_TEXT, 'intent-old');
  assert.ok(newText !== null, 'the fixture text is the product\'s receipt line');
  assert.deepEqual(reader.receiptPassOfLine(newText),
    { status: 'named', passId: 'intent-old' }, 'the new writer\'s line names its pass');

  // The record side does not silently accept an old-writer receipt as the one
  // this pass rendered: the idempotency check refuses it by name.
  const plan = planForCall(messages, 'call_1', 'note-a', RECEIPT_TEXT_A);
  const request = requestFor(plan, PASS_A, 'note-a', RECEIPT_TEXT_A);
  const applied = applyOnePass(messages, PASS_A, 'call_1', 'note-a', RECEIPT_TEXT_A);
  const stale: OpencodeMessage[] = applied.map(message => (isReceipt(message)
    ? { ...message, content: [{ type: 'text', text: RECEIPT_TEXT_A }] }
    : message));
  const outcome = deriveOpencodeRevert(request, stale);
  assert.equal(outcome.status, 'refused', 'an old-writer receipt is not accepted');
  if (outcome.status === 'refused') {
    assert.equal(outcome.code, 'intent-conflict', 'the refusal names the intent');
    assert.match(outcome.detail, /not the one this plan rendered/u);
  }
});

/* ------------------------------- ISSUE-256 item 1 cost fix: the pass is written once */

/**
 * The cost regression (scratchpad/launch/2026-11-11-cost-regression): the host
 * rebuilds every request from its own store, so the same removal is re-applied
 * on every request with a fresh intent id. A receipt that names that fresh id
 * changes bytes at an early array index on every request and breaks the
 * provider's prefix cache: cache read stayed at 6,272 tokens on 182 of 183
 * requests. The receipt's pass segment is written once instead, naming the pass
 * that first applied the removal.
 */

test('ISSUE-256 item 1 cost fix: re-applying one removal keeps the receipt bytes and its first pass id',
  async () => {
    const reader = await receiptLineReader();
    const firstPlan = planForCall(twoUnitWireArray(), 'call_1', 'note-a', RECEIPT_TEXT_A);
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', 'note-a', RECEIPT_TEXT_A);
    const firstReceipt = first.filter(isReceipt)[0];
    assert.ok(firstReceipt !== undefined, 'the first pass inserted its receipt');
    assert.deepEqual(reader.receiptPassOfLine(receiptText(firstReceipt)),
      { status: 'named', passId: PASS_A }, 'the first pass names itself');

    // The host rebuilt the request: the removed unit is back and the earlier
    // receipt is gone. The port's applied-plan index still records pass A.
    const index: OpencodeAppliedPlanIndex = new Map([
      appliedPlanEntry(PASS_A, firstPlan, RECEIPT_TEXT_A),
    ]);
    const second = applyOnePass(
      twoUnitWireArray(), PASS_B, 'call_1', 'note-a', RECEIPT_TEXT_A, index);
    const secondReceipt = second.filter(isReceipt)[0];
    assert.ok(secondReceipt !== undefined, 'the second pass inserted its receipt');
    assert.equal(JSON.stringify(secondReceipt.content), JSON.stringify(firstReceipt.content),
      'the receipt content is byte-identical across the re-application');
    const parsed = reader.receiptPassOfLine(receiptText(secondReceipt));
    assert.equal(parsed.status, 'named', 'the re-applied receipt still names a pass');
    assert.equal(parsed.passId, PASS_A, 'it keeps the first pass id');
    assert.equal(receiptText(secondReceipt).includes(PASS_B), false,
      'the second pass\'s own intent id does not appear in the receipt');
    // Only the text is wire bytes; the record id is this application's message
    // identity and the host drops it when it serializes the request.
    assert.equal(secondReceipt[OPENCODE_RECORD_ID_FIELD], opencodeReceiptEntryId(PASS_B, 0),
      'the inserted message is still this pass\'s own record');
  });

test('ISSUE-256 item 1 cost fix: a restore after the removal keeps the pre-restore pass',
  async () => {
    const reader = await receiptLineReader();
    // Pass A removed the unit. The host store later carries the restore of that
    // recall: a necromancy call naming it. The restore supersedes that removal,
    // but the rebuilt request still re-applies the same unit — a unit the array
    // places before the restore call. That is a re-application of the pre-restore
    // removal, so its line keeps the pass that first wrote it.
    const restoredFor = (stated: string): OpencodeMessage[] => [
      ...twoUnitWireArray(),
      assistantMessage('msg_ar', [
        toolCall('call_restore', 'necromancy', { id: stated }),
      ]),
      toolMessage('msg_tr', [
        toolResult('call_restore', 'necromancy', textResult('the restored bytes')),
      ]),
    ];
    const restored = restoredFor(RECALL_A);
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, RECEIPT_TEXT_A);
    // The tool accepts the canonical id, `sha256:<hex>` and the bare hex
    // (tools.ts); every spelling finds the same restore.
    const spellings = [RECALL_A, `sha256:${'a'.repeat(64)}`, 'a'.repeat(64)];
    for (const stated of spellings) {
      const second = applyOnePass(restoredFor(stated), PASS_B, 'call_1', NOTE_B,
        RECEIPT_TEXT_A, new Map([appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A)]));
      const secondReceipt = second.filter(isReceipt)[0];
      assert.ok(secondReceipt !== undefined, `the re-applied pass inserted its receipt (${stated})`);
      const named = reader.receiptPassOfLine(receiptText(secondReceipt));
      assert.equal(named.status, 'named', `the receipt names a pass (${stated})`);
      assert.equal(named.passId, PASS_A,
        `the pre-restore removal keeps the pass that wrote it (${stated})`);
      assert.equal(receiptText(secondReceipt).includes(PASS_B), false,
        `the re-application's own pass is not named (${stated})`);
    }

    // A later pass re-applies the same pre-restore removal. It keeps pass A too:
    // the restore sits after the unit, so it never opens an epoch for this line.
    const planB = planForCall(restored, 'call_1', NOTE_B, RECEIPT_TEXT_A);
    const second = applyOnePass(restored, PASS_B, 'call_1', NOTE_B, RECEIPT_TEXT_A,
      new Map([appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A)]));
    const secondReceipt = second.filter(isReceipt)[0];
    assert.ok(secondReceipt !== undefined, 'the re-applied pass inserted its receipt');
    const third = applyOnePass(restored, PASS_C, 'call_1', NOTE_C, RECEIPT_TEXT_A,
      new Map([appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A),
        appliedPlanEntry(PASS_B, planB, RECEIPT_TEXT_A)]));
    const thirdReceipt = third.filter(isReceipt)[0];
    assert.ok(thirdReceipt !== undefined, 'the later pass inserted its receipt');
    const kept = reader.receiptPassOfLine(receiptText(thirdReceipt));
    assert.equal(kept.status, 'named', 'the later receipt names a pass');
    assert.equal(kept.passId, PASS_A, 'the first pass stays named');
    assert.notEqual(kept.passId, PASS_C, 'the later pass does not replace it');
    assert.equal(JSON.stringify(thirdReceipt.content), JSON.stringify(secondReceipt.content),
      'the re-applied receipt is byte-stable across the restore');
  });

test('ISSUE-256 item 1 cost fix: a first removal writes exactly one receipt naming its pass',
  async () => {
    const reader = await receiptLineReader();
    const output = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', 'note-a', RECEIPT_TEXT_A);
    const receipts = output.filter(isReceipt);
    assert.equal(receipts.length, 1, 'a first removal writes exactly one receipt');
    const receipt = receipts[0];
    assert.ok(receipt !== undefined);
    const text = receiptText(receipt);
    const parsed = reader.receiptPassOfLine(text);
    assert.equal(parsed.status, 'named', 'the receipt names a pass');
    assert.equal(parsed.passId, PASS_A, 'it names the pass that inserted it');
    assert.equal(occurrencesIn(text, PASS_A), 1, 'the pass id occurs exactly once');
    assert.equal(text.includes(PASS_B), false, 'no other pass is named');
  });

test('ISSUE-256 item 1 cost fix: the pass segment keeps its spelling and its position',
  async () => {
    const reader = await receiptLineReader();
    const output = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', 'note-a', RECEIPT_TEXT_A);
    const receipt = output.filter(isReceipt)[0];
    assert.ok(receipt !== undefined);
    const text = receiptText(receipt);
    const expected = `[not retained] NOTES.md${opencodeReceiptPassSegment(PASS_A)}`
      + ` · necromancy ${RECALL_A}`;
    assert.equal(text, expected, 'the exact line the writer produced before the cost fix');
    assert.equal(opencodeReceiptTextWithPass(RECEIPT_TEXT_A, PASS_A), expected,
      'the writer\'s own spelling is unchanged');
    assert.equal(reader.isWireReceiptLine(text), true,
      'the bench\'s strict one-line reader still accepts it');
    assert.deepEqual(reader.receiptRecallIdsOfLine(text), [RECALL_A],
      'the recall id is still the line\'s last token');
    const segmentAt = text.indexOf(opencodeReceiptPassSegment(PASS_A));
    const recallAt = text.indexOf(' · necromancy ');
    assert.ok(segmentAt > 0 && segmentAt < recallAt,
      'the pass segment sits before the recall marker');
    assert.deepEqual(reader.receiptPassOfLine(text),
      { status: 'named', passId: PASS_A }, 'the existing parser reads the pass');
  });

/* ------------------------- ISSUE-256 item 1 cost fix, keyed by the recall id */

/**
 * The pre-1e gate's shape (`scratchpad/launch/2026-11-11-pre-1e-gate`): the
 * ledger record id hashes the event, so the host's rebuilt request carries a
 * different record id on every pass (`racoons:2743…` → `racoons:d791…`). The
 * recall id is the one id the removal keeps. The earlier fixtures reused one
 * note id across passes, which hid the lookup miss.
 */
const NOTE_A = 'receipt:unit:sha256:'.concat('1'.repeat(64));
const NOTE_B = 'receipt:unit:sha256:'.concat('2'.repeat(64));
const NOTE_C = 'receipt:unit:sha256:'.concat('3'.repeat(64));

test('ISSUE-256 item 1 cost fix: different record ids across passes keep the first pass id',
  async () => {
    const reader = await receiptLineReader();
    const firstPlan = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, RECEIPT_TEXT_A);
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', NOTE_A, RECEIPT_TEXT_A);
    const firstReceipt = first.filter(isReceipt)[0];
    assert.ok(firstReceipt !== undefined, 'the first pass inserted its receipt');
    assert.equal(firstReceipt[OPENCODE_RECEIPT_OF_FIELD], NOTE_A,
      'the first pass renders its own record id');

    // The host rebuilt the request: the removal is back, the earlier receipt is
    // gone, and this pass names a different ledger record for the same removal.
    const second = applyOnePass(twoUnitWireArray(), PASS_B, 'call_1', NOTE_B,
      RECEIPT_TEXT_A, new Map([appliedPlanEntry(PASS_A, firstPlan, RECEIPT_TEXT_A)]));
    const secondReceipt = second.filter(isReceipt)[0];
    assert.ok(secondReceipt !== undefined, 'the second pass inserted its receipt');
    assert.equal(secondReceipt[OPENCODE_RECEIPT_OF_FIELD], NOTE_B,
      'the host shape changed the record id, so the lookup cannot key on it');
    assert.notEqual(secondReceipt[OPENCODE_RECEIPT_OF_FIELD], firstReceipt[OPENCODE_RECEIPT_OF_FIELD],
      'the two passes name different per-application record ids');
    assert.equal(JSON.stringify(secondReceipt.content), JSON.stringify(firstReceipt.content),
      'the receipt bytes are identical across the record id change');
    const parsed = reader.receiptPassOfLine(receiptText(secondReceipt));
    assert.equal(parsed.status, 'named', 'the re-applied receipt names a pass');
    assert.equal(parsed.passId, PASS_A, 'it keeps the first pass id, keyed by the recall id');
    assert.equal(receiptText(secondReceipt).includes(PASS_B), false,
      'the second pass\'s own intent id does not appear in the receipt');
  });

test('ISSUE-256 item 1 cost fix: the first removal after a restore names its own pass, and keeps it',
  async () => {
    const reader = await receiptLineReader();
    // The restore reaches the transcript first, then the agent reads the same
    // file again. The unit that read lands is after the restore call, so it is a
    // post-restore removal: the first pass that removes it names itself, and a
    // later re-application in the same epoch keeps that pass.
    const postRestoreArray = (): OpencodeMessage[] => [
      ...twoUnitWireArray(),
      assistantMessage('msg_ar', [toolCall('call_restore', 'necromancy', { id: RECALL_A })]),
      toolMessage('msg_tr', [
        toolResult('call_restore', 'necromancy', textResult('the restored bytes')),
      ]),
      assistantMessage('msg_a4', [
        text('Reading NOTES.md again after the restore.'),
        toolCall('call_3', 'read', { filePath: 'NOTES.md' }),
      ]),
      toolMessage('msg_t4', [toolResult('call_3', 'read', textResult(BIG_BODY))]),
    ];
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, RECEIPT_TEXT_A);
    const planB = planForCall(postRestoreArray(), 'call_3', NOTE_B, RECEIPT_TEXT_A);
    // The first pass after the restore has no earlier pass that removed this
    // unit, so it names its own pass.
    const second = applyOnePass(postRestoreArray(), PASS_B, 'call_3', NOTE_B,
      RECEIPT_TEXT_A, new Map([appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A)]));
    const secondReceipt = second.filter(isReceipt)[0];
    assert.ok(secondReceipt !== undefined, 'the post-restore pass inserted its receipt');
    const named = reader.receiptPassOfLine(receiptText(secondReceipt));
    assert.equal(named.status, 'named', 'the post-restore receipt names a pass');
    assert.equal(named.passId, PASS_B, 'the first post-restore removal names its own pass');
    assert.equal(receiptText(secondReceipt).includes(PASS_A), false,
      'the pre-restore pass is not named');
    // The epoch lookup keys on the unit this removal took: only pass B's row
    // removed it, so a later pass keeps B byte for byte.
    const third = applyOnePass(postRestoreArray(), PASS_C, 'call_3', NOTE_C,
      RECEIPT_TEXT_A, new Map([
        appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A),
        appliedPlanEntry(PASS_B, planB, RECEIPT_TEXT_A),
      ]));
    const thirdReceipt = third.filter(isReceipt)[0];
    assert.ok(thirdReceipt !== undefined, 'the later pass inserted its receipt');
    assert.equal(thirdReceipt[OPENCODE_RECEIPT_OF_FIELD], NOTE_C,
      'the later pass names its own record id');
    const kept = reader.receiptPassOfLine(receiptText(thirdReceipt));
    assert.equal(kept.status, 'named', 'the later receipt names a pass');
    assert.equal(kept.passId, PASS_B, 'the epoch\'s first pass stays named');
    assert.equal(JSON.stringify(thirdReceipt.content), JSON.stringify(secondReceipt.content),
      'the post-restore receipt is byte-stable across record ids');
  });

test('ISSUE-256 item 1 cost fix: a later pass row in the index does not replace the first',
  async () => {
    const reader = await receiptLineReader();
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, RECEIPT_TEXT_A);
    const planC = planForCall(twoUnitWireArray(), 'call_1', NOTE_C, RECEIPT_TEXT_A);
    // Pass C landed after pass A and re-applied the same recall. Its row is in
    // the index behind A, so the earliest match is still A.
    const index = new Map([
      appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A),
      appliedPlanEntry(PASS_C, planC, RECEIPT_TEXT_A),
    ]);
    const output = applyOnePass(twoUnitWireArray(), PASS_B, 'call_1', NOTE_B,
      RECEIPT_TEXT_A, index);
    const receipt = output.filter(isReceipt)[0];
    assert.ok(receipt !== undefined, 'the pass inserted its receipt');
    const parsed = reader.receiptPassOfLine(receiptText(receipt));
    assert.equal(parsed.status, 'named', 'the receipt names a pass');
    assert.equal(parsed.passId, PASS_A, 'the first pass id is kept');
    assert.notEqual(parsed.passId, PASS_C, 'the later index row does not win');
    assert.notEqual(parsed.passId, PASS_B, 'this pass does not name itself');
  });

/* ------------- receipt pinning: the first pass's line keeps its bytes (1e) */

/**
 * The host shape the 1e diagnosis recorded (`scratchpad/launch/
 * 2026-11-11-diagnose-1e`): a request body keeps a receipt's text but drops
 * `racoonsRecordId` and the `racoons-record:` id. The line's own
 * `[not retained] … · necromancy <recall id>` shape is the only identity left.
 */
function hostReceipt(message: OpencodeMessage): OpencodeMessage {
  const copy: Record<string, unknown> = { ...message, id: 'msg_host_receipt_1' };
  delete copy[OPENCODE_RECORD_ID_FIELD];
  delete copy[OPENCODE_RECEIPT_OF_FIELD];
  delete copy[OPENCODE_FORGOTTEN_NODE_FIELD];
  return copy as unknown as OpencodeMessage;
}

/**
 * A fresh host request that still carries one receipt line and no marker: the
 * removed unit is back (the host rebuilds from its own store) and the receipt
 * sits where the first pass inserted it, directly after the call group.
 */
function hostShapeWithReceipt(receipt: OpencodeMessage): OpencodeMessage[] {
  const base = twoUnitWireArray();
  return [...base.slice(0, 3), hostReceipt(receipt), ...base.slice(3)];
}

/** The exact line a pass ships for a ledger text. */
function receiptWithPass(textValue: string, passId: string): string {
  const line = opencodeReceiptTextWithPass(textValue, passId);
  assert.ok(line !== null, 'the fixture text is the product\'s receipt line');
  return line;
}

/** The verdict pass's ledger line: the label is the half a proof pass lacks. */
const LABELLED_TEXT_A = `[not retained] NOTES.md — about: docs/project index content`
  + ` · necromancy ${RECALL_A}`;
/** The proof pass's ledger line for the same recall: the floor line, no label. */
const FLOOR_TEXT_A = `[not retained] NOTES.md · necromancy ${RECALL_A}`;

test('receipt pinning: a later proof pass keeps the verdict pass line byte for byte',
  async () => {
    const reader = await receiptLineReader();
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, LABELLED_TEXT_A);
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', NOTE_A, LABELLED_TEXT_A);
    const firstReceipt = first.filter(isReceipt)[0];
    assert.ok(firstReceipt !== undefined, 'the verdict pass wrote its receipt');
    assert.equal(receiptText(firstReceipt), receiptWithPass(LABELLED_TEXT_A, PASS_A),
      'the first line carries the verdict label and its pass');

    // The host rebuild: the line survives, the marker fields and the record id
    // do not. A lookup keyed on either marker finds nothing.
    const rebuilt = hostShapeWithReceipt(firstReceipt);
    assert.equal(rebuilt.filter(isReceipt).length, 0,
      'the rebuilt array carries no marker field for the receipt');
    assert.equal(rebuilt.some(message =>
      typeof message.id === 'string' && message.id.startsWith('racoons-record:')), false,
    'no receipt keeps its record id');

    // The at-rest `superseded-read` proof pass re-plans the same removal. Its
    // own record is the floor line (ADR-0018: a proof note has no label), so a
    // re-render would drop ` — about: …` and change the line's bytes.
    const second = applyOnePass(rebuilt, PASS_B, 'call_1', NOTE_B, FLOOR_TEXT_A,
      new Map([appliedPlanEntry(PASS_A, planA, LABELLED_TEXT_A)]));
    const hostLine = rebuilt.find(message => message.role === 'user'
      && receiptText(message) === receiptText(firstReceipt));
    assert.ok(hostLine !== undefined, 'the host-rebuilt line is in the request');
    const lines = receiptLinesFor(second, RECALL_A);
    assert.equal(lines.length, 1, 'the proof pass reuses the line instead of appending a duplicate');
    assert.equal(second.includes(hostLine), true,
      'the host line is the message the fixed array carries');
    assert.equal(receiptText(lines[0]!), receiptText(firstReceipt),
      'the proof pass reuses the verdict line byte for byte, label included');
    assert.equal(receiptText(lines[0]!).includes(' — about: docs/project index content'), true,
      'the verdict label survives the proof pass');
    const parsed = reader.receiptPassOfLine(receiptText(lines[0]!));
    assert.equal(parsed.status, 'named', 'the reused line still names a pass');
    assert.equal(parsed.passId, PASS_A, 'it keeps the first pass id');
    assert.equal(receiptText(lines[0]!).includes(PASS_B), false,
      'the proof pass id never reaches the line');
    assert.equal(second.filter(isReceipt).length, 0,
      'no second marker receipt is appended beside the reused line');
  });

test('receipt pinning: a verdict pass after a proof keeps the label-less line',
  async () => {
    const reader = await receiptLineReader();
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, FLOOR_TEXT_A);
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', NOTE_A, FLOOR_TEXT_A);
    const firstReceipt = first.filter(isReceipt)[0];
    assert.ok(firstReceipt !== undefined, 'the proof pass wrote its receipt');
    assert.equal(receiptText(firstReceipt).includes(' — about: '), false,
      'the proof line carries no label');

    // The reverse order: the host rebuild loses every marker, then a verdict
    // pass with a label re-plans the same recall. The first line wins; the
    // later label must not be added.
    const rebuilt = hostShapeWithReceipt(firstReceipt);
    const second = applyOnePass(rebuilt, PASS_B, 'call_1', NOTE_B,
      LABELLED_TEXT_A, new Map([appliedPlanEntry(PASS_A, planA, FLOOR_TEXT_A)]));
    const hostLine = rebuilt.find(message => message.role === 'user'
      && receiptText(message) === receiptText(firstReceipt));
    assert.ok(hostLine !== undefined, 'the host-rebuilt line is in the request');
    const lines = receiptLinesFor(second, RECALL_A);
    assert.equal(lines.length, 1, 'the verdict pass reuses the line, never appending a second');
    assert.equal(second.includes(hostLine), true, 'the host line is reused in place');
    assert.equal(receiptText(lines[0]!), receiptText(firstReceipt),
      'the label-less line is byte-identical across the verdict pass');
    assert.equal(receiptText(lines[0]!).includes(' — about: '), false,
      'a later verdict pass does not add a label to the first line');
    const parsed = reader.receiptPassOfLine(receiptText(lines[0]!));
    assert.equal(parsed.status, 'named', 'the reused line names a pass');
    assert.equal(parsed.passId, PASS_A, 'it keeps the first pass id');
    assert.equal(second.filter(isReceipt).length, 0,
      'no second marker receipt is appended beside the reused line');
  });

test('receipt reuse (ISSUE-262 item 1): one line per recall after one and two host rebuilds', () => {
  const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, RECEIPT_TEXT_A);
  const index = new Map([appliedPlanEntry(PASS_A, planA, RECEIPT_TEXT_A)]);
  const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', NOTE_A, RECEIPT_TEXT_A);
  const firstLine = first.filter(isReceipt)[0];
  assert.ok(firstLine !== undefined, 'the first pass wrote its receipt');
  const lineText = receiptText(firstLine);
  assert.equal(receiptLinesFor(first, RECALL_A).length, 1, 'the first pass writes one line');

  // The host rebuild keeps the line but drops its marker fields, and brings
  // the removed unit back. The pass re-applies the removal: the line must be
  // reused, never copied into a second line.
  const once = hostShapeWithReceipt(firstLine);
  const hostLine = once.find(message => message.role === 'user'
    && receiptText(message) === lineText);
  assert.ok(hostLine !== undefined, 'the rebuilt request carries the line');
  const second = applyOnePass(once, PASS_B, 'call_1', NOTE_B, RECEIPT_TEXT_A, index);
  assert.equal(receiptLinesFor(second, RECALL_A).length, 1, 'after one rebuild: one line');
  assert.equal(second.includes(hostLine), true, 'the rebuilt line is the message reused');
  assert.equal(second.some(message => message[OPENCODE_RECEIPT_OF_FIELD] === NOTE_B), false,
    'the re-application appends no second receipt');

  // A second rebuild repeats the shape: still one line, still the same bytes.
  const lineAfterFirst = second.find(message => message.role === 'user'
    && receiptText(message) === lineText);
  assert.ok(lineAfterFirst !== undefined, 'the request still carries the line');
  const twice = hostShapeWithReceipt(lineAfterFirst);
  const hostLineAgain = twice.find(message => message.role === 'user'
    && receiptText(message) === lineText);
  assert.ok(hostLineAgain !== undefined, 'the second rebuilt request carries the line');
  const third = applyOnePass(twice, PASS_C, 'call_1', NOTE_C, RECEIPT_TEXT_A, index);
  assert.equal(receiptLinesFor(third, RECALL_A).length, 1, 'after two rebuilds: one line');
  assert.equal(third.includes(hostLineAgain), true, 'the second rebuilt line is reused');
  assert.equal(third.some(message => message[OPENCODE_RECEIPT_OF_FIELD] === NOTE_C), false,
    'the second re-application appends no second receipt');
});

test('receipt pinning: a restored-then-removed unit gets a new line naming the new pass',
  async () => {
    const reader = await receiptLineReader();
    // The pre-restore line for the same recall is visible in the array. It is a
    // line for the removal the restore superseded, not for the unit the agent
    // reads again after the restore.
    const postRestoreArray = (): OpencodeMessage[] => {
      const base = twoUnitWireArray();
      return [
        ...base.slice(0, 3),
        { id: 'msg_old_receipt', role: 'user' as const,
          content: [{ type: 'text' as const, text: FLOOR_TEXT_A }] },
        ...base.slice(3),
        assistantMessage('msg_ar', [toolCall('call_restore', 'necromancy', { id: RECALL_A })]),
        toolMessage('msg_tr', [
          toolResult('call_restore', 'necromancy', textResult('the restored bytes')),
        ]),
        assistantMessage('msg_a4', [
          text('Reading NOTES.md again after the restore.'),
          toolCall('call_3', 'read', { filePath: 'NOTES.md' }),
        ]),
        toolMessage('msg_t4', [toolResult('call_3', 'read', textResult(BIG_BODY))]),
      ];
    };
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, FLOOR_TEXT_A);
    const newLine = `[not retained] NOTES.md — about: re-read after the restore`
      + ` · necromancy ${RECALL_A}`;
    const output = applyOnePass(postRestoreArray(), PASS_B, 'call_3', NOTE_B,
      newLine, new Map([appliedPlanEntry(PASS_A, planA, FLOOR_TEXT_A)]));
    const receipt = output.find(message =>
      message[OPENCODE_RECEIPT_OF_FIELD] === NOTE_B);
    assert.ok(receipt !== undefined, 'the epoch\'s first removal inserted its receipt');
    assert.equal(receiptText(receipt), receiptWithPass(newLine, PASS_B),
      'the new unit gets a new line, with its own label and pass');
    const parsed = reader.receiptPassOfLine(receiptText(receipt));
    assert.equal(parsed.status, 'named', 'the new line names a pass');
    assert.equal(parsed.passId, PASS_B, 'the new epoch names its own pass');
    assert.notEqual(parsed.passId, PASS_A, 'the pre-restore pass is not copied');
    // The pre-restore line itself still keeps its bytes.
    const old = output.find(message => message.id === 'msg_old_receipt');
    assert.ok(old !== undefined, 'the pre-restore line is still in the array');
    assert.equal(receiptText(old), FLOOR_TEXT_A, 'the pre-restore line is unchanged');
  });

test('receipt pinning: the applied-plan row reuses the rendered text when the array has no receipt',
  async () => {
    const reader = await receiptLineReader();
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, LABELLED_TEXT_A);
    const first = applyOnePass(twoUnitWireArray(), PASS_A, 'call_1', NOTE_A, LABELLED_TEXT_A);
    const firstReceipt = first.filter(isReceipt)[0];
    assert.ok(firstReceipt !== undefined, 'the first pass wrote its receipt');
    const rendered = receiptText(firstReceipt);
    // The host rebuilt its request without the receipt at all: no array line to
    // copy. The applied-plan row's persisted text is the exact bytes.
    const second = applyOnePass(twoUnitWireArray(), PASS_B, 'call_1', NOTE_B, FLOOR_TEXT_A,
      new Map([appliedPlanEntry(PASS_A, planA, LABELLED_TEXT_A,
        new Map([[RECALL_A, rendered]]))]));
    const secondReceipt = second.filter(isReceipt)[0];
    assert.ok(secondReceipt !== undefined, 'the later pass wrote its receipt');
    assert.equal(receiptText(secondReceipt), rendered,
      'the row\'s rendered text is reused byte for byte');
    assert.equal(receiptText(secondReceipt).includes(' — about: docs/project index content'), true,
      'the persisted label survives');
    const parsed = reader.receiptPassOfLine(receiptText(secondReceipt));
    assert.equal(parsed.status, 'named', 'the reused line names a pass');
    assert.equal(parsed.passId, PASS_A, 'it keeps the first pass id');
    assert.equal(secondReceipt[OPENCODE_RECEIPT_OF_FIELD], NOTE_B,
      'the message still renders this pass\'s record');
  });

test('receipt pinning: an array line without a pass segment gains the stable pass',
  async () => {
    const reader = await receiptLineReader();
    // A pre-256 line: the label is there, the pass segment is not.
    const oldLine = LABELLED_TEXT_A;
    const array = [
      ...twoUnitWireArray().slice(0, 3),
      { id: 'msg_old_line', role: 'user' as const,
        content: [{ type: 'text' as const, text: oldLine }] },
      ...twoUnitWireArray().slice(3),
    ];
    const planA = planForCall(twoUnitWireArray(), 'call_1', NOTE_A, oldLine);
    const output = applyOnePass(array, PASS_B, 'call_1', NOTE_B, FLOOR_TEXT_A,
      new Map([appliedPlanEntry(PASS_A, planA, oldLine)]));
    const lines = receiptLinesFor(output, RECALL_A);
    assert.equal(lines.length, 1, 'the old line is replaced in place, not copied');
    assert.equal(lines[0]?.id, 'msg_old_line', 'the replaced line keeps the message the plan kept');
    assert.equal(receiptText(lines[0]!), receiptWithPass(oldLine, PASS_A),
      'the line gains the first pass and keeps every other byte');
    const parsed = reader.receiptPassOfLine(receiptText(lines[0]!));
    assert.equal(parsed.status, 'named', 'the line now names a pass');
    assert.equal(parsed.passId, PASS_A, 'it names the first indexed pass');
    assert.equal(receiptText(lines[0]!).includes(' — about: docs/project index content'), true,
      'the label is preserved');
    assert.equal(output.filter(message => message[OPENCODE_RECEIPT_OF_FIELD] === NOTE_B).length, 0,
      'the replacement mints no second receipt');
  });


test('ISSUE-256 item 1 cost fix: the pre1e mock shape does not churn at requests 3-8',
  async () => {
    const reader = await receiptLineReader();
    // Message 139 of the pre-1e capture: the same recall re-applied on requests
    // 3-8, each under a fresh event (a fresh ledger record id and intent id).
    const recall = 'recall:sha256:bb20dcf317e7cb312eae9fa949bc4c35c4f726e249761b626340a6f65adf37d8';
    const line = '[not retained] '
      + 'oc:ses_RAC00NS5YNTH3T1C0000000000:tool:call_replay_big_1_RS-REPLAY-BIG'
      + ` · necromancy ${recall}`;
    const port = createOpencodePort({
      sessionId, clock, messages: twoUnitWireArray(),
      capabilities: REVERT_CAPABILITIES, deriveRevert: deriveOpencodeRevert,
    });
    const texts: string[] = [];
    const passIds: string[] = [];
    const noteIds: string[] = [];
    for (let seq = 3; seq <= 8; seq += 1) {
      // The host rebuilds the request from its own store every model call.
      const rebuilt = twoUnitWireArray();
      port.observe(rebuilt);
      const passId = `intent:sha256:${seq.toString(16).padStart(64, '0')}`;
      const noteId = `racoons:${seq.toString(16).padStart(16, '0')}`;
      const plan = planForCall(rebuilt, 'call_1', noteId, line);
      const outcome = await port.apply(requestFor(plan, passId, noteId, line));
      assert.equal(outcome.status, 'applied',
        `request ${String(seq)} applied: ${JSON.stringify(outcome)}`);
      assert.equal(port.commit(), true, `request ${String(seq)} committed its stage`);
      const receipt = rebuilt.filter(isReceipt)[0];
      assert.ok(receipt !== undefined, `request ${String(seq)} carries the receipt`);
      texts.push(receiptText(receipt));
      passIds.push(passId);
      noteIds.push(String(receipt[OPENCODE_RECEIPT_OF_FIELD]));
    }
    assert.equal(new Set(noteIds).size, noteIds.length,
      'every request names a different ledger record id, as the host did');
    assert.equal(new Set(passIds).size, passIds.length,
      'every request names a different intent id');
    for (const text of texts) {
      assert.equal(text, texts[0], 'no request rewrites the receipt line at message 139');
    }
    const parsed = reader.receiptPassOfLine(texts[5] ?? '');
    assert.equal(parsed.status, 'named', 'the last request still names a pass');
    assert.equal(parsed.passId, passIds[0], 'all six requests name request 3\'s pass');
    assert.equal(texts[0]?.includes(passIds[1] ?? ''), false,
      'request 4\'s pass never reaches the line');
  });

/* ---------------------------- 1g FIX 1: one anchor group, one stable receipt order */

/**
 * The 1g shape (`scratchpad/launch/2026-11-11-diagnose-1g` §4): one assistant
 * message declares three reads, and the three results are removed by more than
 * one plan. Every receipt anchors inside that one tool-call group, so all of
 * them land at one slot after the group's last result. A later plan that
 * re-applies a subset must not move the lines already there.
 */
function threeCallWireArray(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read three notes.')]),
    assistantMessage('msg_a1', [
      text('Reading the three notes.'),
      toolCall('call_a', 'read', { filePath: 'A.md' }),
      toolCall('call_b', 'read', { filePath: 'B.md' }),
      toolCall('call_c', 'read', { filePath: 'C.md' }),
    ]),
    toolMessage('msg_ta', [toolResult('call_a', 'read', textResult(BIG_BODY))]),
    toolMessage('msg_tb', [toolResult('call_b', 'read', textResult(BIG_BODY))]),
    toolMessage('msg_tc', [toolResult('call_c', 'read', textResult(BIG_BODY))]),
    userMessage('msg_u2', [text('Next.')]),
    assistantMessage('msg_a2', [text('Done.')]),
  ];
}

/** Four reads in one group, for a plan whose append order is not the sorted order. */
function fourCallWireArray(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read four notes.')]),
    assistantMessage('msg_a1', [
      text('Reading the four notes.'),
      toolCall('call_a', 'read', { filePath: 'A.md' }),
      toolCall('call_b', 'read', { filePath: 'B.md' }),
      toolCall('call_c', 'read', { filePath: 'C.md' }),
      toolCall('call_d', 'read', { filePath: 'D.md' }),
    ]),
    toolMessage('msg_ta', [toolResult('call_a', 'read', textResult(BIG_BODY))]),
    toolMessage('msg_tb', [toolResult('call_b', 'read', textResult(BIG_BODY))]),
    toolMessage('msg_tc', [toolResult('call_c', 'read', textResult(BIG_BODY))]),
    toolMessage('msg_td', [toolResult('call_d', 'read', textResult(BIG_BODY))]),
    userMessage('msg_u2', [text('Next.')]),
    assistantMessage('msg_a2', [text('Done.')]),
  ];
}

const ORDER_RECALL_A = `recall:sha256:${'a'.repeat(64)}`;
const ORDER_RECALL_B = `recall:sha256:${'b'.repeat(64)}`;
const ORDER_RECALL_C = `recall:sha256:${'c'.repeat(64)}`;
const ORDER_RECALL_D = `recall:sha256:${'d'.repeat(64)}`;
const ORDER_PASS_PREV = `intent:sha256:${'9'.repeat(64)}`;

/** One whole-node receipt line for the order fixtures. */
function orderLine(target: string, recallId: string): string {
  return `[not retained] ${target} — about: the note it read · necromancy ${recallId}`;
}

const ORDER_LINE_A = orderLine('A.md', ORDER_RECALL_A);
const ORDER_LINE_B = orderLine('B.md', ORDER_RECALL_B);
const ORDER_LINE_C = orderLine('C.md', ORDER_RECALL_C);
const ORDER_LINE_D = orderLine('D.md', ORDER_RECALL_D);

/**
 * The plan core would produce for several units in one assistant group. The
 * appends are in transcript order because that is the order the tail walk
 * yields; the receipt texts (and so the recall keys) are the caller's.
 */
function planForCalls(
  messages: readonly OpencodeMessage[],
  entries: readonly { readonly callId: string; readonly noteId: string }[],
): ValidatedRevert {
  const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const nodes = derived.nodes;
  const wanted = new Map(entries.map(entry =>
    [opencodeToolNodeId(sessionId, entry.callId), entry.noteId] as const));
  const cutIndex = nodes.findIndex(node => wanted.has(node.id));
  assert.ok(cutIndex > 0, 'the first forgotten unit has a node before it');
  const tail = nodes.slice(cutIndex);
  const survivors = tail.filter(node => !wanted.has(node.id)).map(node => node.id);
  const appends: { afterNodeId: string | null; noteId: string }[] = [];
  const perNode: { nodeId: string; noteId: string }[] = [];
  let anchor: string | null = nodes[cutIndex - 1]?.id ?? null;
  for (const node of tail) {
    if (!wanted.has(node.id)) {
      anchor = node.id;
      continue;
    }
    const noteId = wanted.get(node.id);
    assert.ok(noteId !== undefined, 'the fixture names a note for every forgotten unit');
    appends.push({ afterNodeId: anchor, noteId });
    perNode.push({ nodeId: node.id, noteId });
  }
  assert.equal(appends.length, entries.length, 'the fixture forgot every named unit');
  const forgotten = new Set(wanted.keys());
  const freedBytes = nodes.filter(node => forgotten.has(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  const keptBytes = tail.filter(node => !forgotten.has(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  return sealPlan({
    cutIndex, survivors, appends, perNode, baseRevision: derived.revision,
  }, { freedBytes, keptBytes });
}

/** One request whose append records carry one exact line per note. */
function requestForNotes(
  plan: ValidatedRevert, intentId: string,
  receiptTexts: ReadonlyMap<string, string>,
): ApplyRequest {
  const appendRecords = plan.appends.map((append) => {
    const text = receiptTexts.get(append.noteId);
    assert.ok(text !== undefined, `the fixture names a receipt for ${append.noteId}`);
    const bytes = toBytes(text);
    return { recordId: append.noteId, bytes, sha256: sha256Sync(bytes) };
  });
  const application = {
    sessionId, eventId: 'event-1', baseRevision: plan.baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1_700_000_000_000,
    appendRecords, revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId, eventId: 'event-1', baseRevision: plan.baseRevision,
      applicationSha256: application.applicationSha256,
    },
  };
}

/** Apply one plan over several units and return what it left. */
function applyCallsPass(
  messages: readonly OpencodeMessage[], passId: string,
  entries: readonly { readonly callId: string; readonly noteId: string }[],
  receiptTexts: ReadonlyMap<string, string>,
): readonly OpencodeMessage[] {
  const plan = planForCalls(messages, entries);
  const result = deriveOpencodeRevert(
    requestForNotes(plan, passId, receiptTexts), messages);
  assert.equal(result.status, 'staged', result.status === 'refused'
    ? `${result.code}: ${result.detail}` : 'the pass staged');
  if (result.status !== 'staged') throw new Error(`pass ${passId} did not stage`);
  return result.messages;
}

/** The receipt lines a request carries for one recall id, by their own shape. */
function receiptLinesFor(
  messages: readonly OpencodeMessage[], recallId: string,
): readonly OpencodeMessage[] {
  return messages.filter(message => message.role === 'user'
    && receiptText(message).startsWith('[not retained] ')
    && receiptText(message).endsWith(` · necromancy ${recallId}`));
}

/** The recall ids the receipt messages name, in wire order. */
function receiptRecallOrder(messages: readonly OpencodeMessage[]): readonly string[] {
  return messages.filter(isReceipt).map(message => recallIdOfText(receiptText(message)));
}

test('receipt order (1g FIX 1): a subset re-application keeps the group order', () => {
  // Pass A forgets the first and third reads; both receipts land at the one
  // anchor slot. Pass B then re-applies the middle read only, the 1g shape: its
  // new line must take the middle place, not the head of the group.
  const first = applyCallsPass(threeCallWireArray(), PASS_A,
    [{ callId: 'call_a', noteId: 'note-a' }, { callId: 'call_c', noteId: 'note-c' }],
    new Map([['note-a', ORDER_LINE_A], ['note-c', ORDER_LINE_C]]));
  assert.deepEqual(receiptRecallOrder(first), [ORDER_RECALL_A, ORDER_RECALL_C],
    'the first pass writes its two receipts in transcript order');
  const receiptA = first.filter(isReceipt)[0];
  const receiptC = first.filter(isReceipt)[1];
  assert.ok(receiptA !== undefined && receiptC !== undefined, 'the first pass left both lines');

  const second = applyCallsPass(first, PASS_B,
    [{ callId: 'call_b', noteId: 'note-b' }],
    new Map([['note-b', ORDER_LINE_B]]));
  assert.deepEqual(receiptRecallOrder(second), [ORDER_RECALL_A, ORDER_RECALL_B, ORDER_RECALL_C],
    'the re-applied line lands between the two existing lines');
  assert.equal(second.includes(receiptA), true,
    'the first pass\'s first line is the same message object');
  assert.equal(second.includes(receiptC), true,
    'the first pass\'s second line is the same message object');
  const receiptB = second.filter(isReceipt)[1];
  assert.ok(receiptB !== undefined, 'the new line is the middle one');
  assert.ok(second.indexOf(receiptA) < second.indexOf(receiptB),
    'the new line is not at the head of the group');
  assert.ok(second.indexOf(receiptB) < second.indexOf(receiptC),
    'the existing line after it did not move ahead of the new one');
});

test('receipt order (1g FIX 1): a pass that re-applies all keeps the group order', () => {
  // The host rebuild brings the units back while the three lines stay. The plan
  // re-applies all three; each append reuses the line it re-applies, so the
  // group's first-seen order never changes and no recall gains a second line.
  const base = threeCallWireArray();
  const world = [
    ...base.slice(0, 5),
    receiptMessage('intent-prev', 0, 'note-a', receiptWithPass(ORDER_LINE_A, ORDER_PASS_PREV),
      opencodeToolNodeId(sessionId, 'call_a')),
    receiptMessage('intent-prev', 1, 'note-b', receiptWithPass(ORDER_LINE_B, ORDER_PASS_PREV),
      opencodeToolNodeId(sessionId, 'call_b')),
    receiptMessage('intent-prev', 2, 'note-c', receiptWithPass(ORDER_LINE_C, ORDER_PASS_PREV),
      opencodeToolNodeId(sessionId, 'call_c')),
    ...base.slice(5),
  ];
  const existing = world.filter(isReceipt);
  assert.equal(existing.length, 3, 'the world carries three lines at the anchor');
  const output = applyCallsPass(world, PASS_B, [
    { callId: 'call_a', noteId: 'note-a2' },
    { callId: 'call_b', noteId: 'note-b2' },
    { callId: 'call_c', noteId: 'note-c2' },
  ], new Map([
    ['note-a2', ORDER_LINE_A], ['note-b2', ORDER_LINE_B], ['note-c2', ORDER_LINE_C],
  ]));
  const recalls = receiptRecallOrder(output);
  assert.deepEqual(recalls, [ORDER_RECALL_A, ORDER_RECALL_B, ORDER_RECALL_C],
    'one line per recall after re-applying all three');
  assert.equal(receiptLinesFor(output, ORDER_RECALL_A).length, 1,
    'the first re-applied recall keeps exactly one line');
  assert.equal(receiptLinesFor(output, ORDER_RECALL_B).length, 1,
    'the second re-applied recall keeps exactly one line');
  assert.equal(receiptLinesFor(output, ORDER_RECALL_C).length, 1,
    'the third re-applied recall keeps exactly one line');
  for (const old of existing) {
    assert.equal(output.includes(old), true, 'an existing receipt message never moves out');
  }
  assert.ok(output.indexOf(existing[0]!) < output.indexOf(existing[1]!),
    'the first existing line stays ahead of the second');
  assert.ok(output.indexOf(existing[1]!) < output.indexOf(existing[2]!),
    'the second existing line stays ahead of the third');
});

test('receipt order (1g FIX 1): a new receipt takes its sorted place without moving the others', () => {
  // Pass A leaves A and C. Pass B forgets B and D, but its recall keys make the
  // plan order D, B: the group's order is the key order, never the plan order.
  const first = applyCallsPass(fourCallWireArray(), PASS_A,
    [{ callId: 'call_a', noteId: 'note-a' }, { callId: 'call_c', noteId: 'note-c' }],
    new Map([['note-a', ORDER_LINE_A], ['note-c', ORDER_LINE_C]]));
  const receiptA = first.filter(isReceipt)[0];
  const receiptC = first.filter(isReceipt)[1];
  assert.ok(receiptA !== undefined && receiptC !== undefined, 'the first pass left both lines');
  assert.deepEqual(receiptRecallOrder(first), [ORDER_RECALL_A, ORDER_RECALL_C]);

  const second = applyCallsPass(first, PASS_B,
    [{ callId: 'call_b', noteId: 'note-d' }, { callId: 'call_d', noteId: 'note-b' }],
    new Map([['note-d', ORDER_LINE_D], ['note-b', ORDER_LINE_B]]));
  assert.deepEqual(receiptRecallOrder(second),
    [ORDER_RECALL_A, ORDER_RECALL_B, ORDER_RECALL_C, ORDER_RECALL_D],
    'the new lines take their sorted places, not the plan\'s D, B order');
  assert.equal(second.includes(receiptA), true, 'the A line is still the same message object');
  assert.equal(second.includes(receiptC), true, 'the C line is still the same message object');
  assert.ok(second.indexOf(receiptA) < second.indexOf(receiptC),
    'the two existing lines keep their relative order');
  const lines = second.filter(isReceipt);
  assert.equal(lines[0]?.[OPENCODE_RECEIPT_OF_FIELD], 'note-a',
    'the first line is still the first pass\'s A line');
  assert.equal(lines[1]?.[OPENCODE_RECEIPT_OF_FIELD], 'note-b',
    'B lands between A and C');
  assert.equal(lines[2]?.[OPENCODE_RECEIPT_OF_FIELD], 'note-c',
    'the first pass\'s C line did not move ahead of B');
  assert.equal(lines[3]?.[OPENCODE_RECEIPT_OF_FIELD], 'note-d',
    'D appends after C');
});

/* ------------------------------- 1g FIX 2: a write receipt names its target path */

const WRITE_PATH = 'docs/plans/2026-10-27-extended-audit/00-index.md';
const EDIT_PATH = 'src/main.ts';
const WRITE_RECALL = `recall:sha256:${'e'.repeat(64)}`;
const EDIT_RECALL = `recall:sha256:${'f'.repeat(64)}`;
const READ_RECALL = `recall:sha256:${'1'.repeat(64)}`;

/** One tool call and its result, in one assistant group. */
function oneToolWireArray(
  callId: string, name: string, input: Readonly<Record<string, unknown>>, result: string,
): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Do the thing.')]),
    assistantMessage('msg_a1', [text('Doing it.'), toolCall(callId, name, input)]),
    toolMessage('msg_t1', [toolResult(callId, name, textResult(result))]),
    assistantMessage('msg_a2', [text('Done.')]),
  ];
}

test('receipt label (1g FIX 2): a write receipt names the path from the call arguments', async () => {
  const reader = await receiptLineReader();
  const target = `oc:${sessionId}:tool:call_w`;
  const ledger = `[not retained] ${target} — about: write confirmation for 00-index.md`
    + ` · necromancy ${WRITE_RECALL}`;
  const expected = `[not retained] ${target} — about: write confirmation for ${WRITE_PATH}`
    + ` · necromancy ${WRITE_RECALL}`;
  const output = applyOnePass(
    oneToolWireArray('call_w', 'write', { path: WRITE_PATH, content: 'body' },
      `Created file successfully: ${WRITE_PATH}`),
    PASS_A, 'call_w', 'note-w', ledger);
  const receipt = output.filter(isReceipt)[0];
  assert.ok(receipt !== undefined, 'the write receipt was inserted');
  const text = receiptText(receipt);
  assert.equal(text, receiptWithPass(expected, PASS_A),
    'the descriptor names the directory the write call named');
  assert.equal(text.includes(`about: write confirmation for ${WRITE_PATH}`), true,
    'the about label carries the full relative path');
  assert.equal(text.includes(' — about: write confirmation for 00-index.md ·'), false,
    'the basename-only label does not survive');
  // The line is still one receipt line the bench parsers read.
  assert.equal(reader.isWireReceiptLine(text), true, 'the line is the product\'s wire shape');
  assert.deepEqual(reader.receiptRecallIdsOfLine(text), [WRITE_RECALL],
    'the recall marker still closes the line');
  assert.deepEqual(reader.receiptPassOfLine(text), { status: 'named', passId: PASS_A },
    'the pass segment keeps its position');
});

test('receipt label (1g FIX 2): an edit receipt names the path from the call arguments', async () => {
  const reader = await receiptLineReader();
  const target = `oc:${sessionId}:tool:call_e`;
  const ledger = `[not retained] ${target} — about: edit confirmation for main.ts`
    + ` · necromancy ${EDIT_RECALL}`;
  const expected = `[not retained] ${target} — about: edit confirmation for ${EDIT_PATH}`
    + ` · necromancy ${EDIT_RECALL}`;
  const output = applyOnePass(
    oneToolWireArray('call_e', 'edit', { path: EDIT_PATH, oldString: 'a', newString: 'b' },
      `Edited ${EDIT_PATH}`),
    PASS_A, 'call_e', 'note-e', ledger);
  const receipt = output.filter(isReceipt)[0];
  assert.ok(receipt !== undefined, 'the edit receipt was inserted');
  assert.equal(receiptText(receipt), receiptWithPass(expected, PASS_A));
  assert.equal(reader.isWireReceiptLine(receiptText(receipt)), true);
});

test('receipt label (1g FIX 2): a read receipt keeps its label', () => {
  const target = `oc:${sessionId}:tool:call_r`;
  const ledger = `[not retained] ${target} — about: read of NOTES.md`
    + ` · necromancy ${READ_RECALL}`;
  const output = applyOnePass(
    oneToolWireArray('call_r', 'read', { filePath: 'NOTES.md' }, BIG_BODY),
    PASS_A, 'call_r', 'note-r', ledger);
  const receipt = output.filter(isReceipt)[0];
  assert.ok(receipt !== undefined, 'the read receipt was inserted');
  assert.equal(receiptText(receipt), receiptWithPass(ledger, PASS_A),
    'a read is not write-side and its label is untouched');
});

test('receipt label (1g FIX 2): a proof floor line gains no descriptor', () => {
  // A proof receipt has no descriptor slot by design (ADR-0018). The write path
  // is only folded into an `— about:` segment the ledger already rendered.
  const target = `oc:${sessionId}:tool:call_w`;
  const floor = `[not retained] ${target} · necromancy ${WRITE_RECALL}`;
  const output = applyOnePass(
    oneToolWireArray('call_w', 'write', { path: WRITE_PATH, content: 'body' }, 'written'),
    PASS_A, 'call_w', 'note-w', floor);
  const receipt = output.filter(isReceipt)[0];
  assert.ok(receipt !== undefined, 'the floor receipt was inserted');
  assert.equal(receiptText(receipt), receiptWithPass(floor, PASS_A),
    'a line with no descriptor keeps its floor shape');
});

/* --------------------------------------------- ISSUE-256 item 4: reasoning bookkeeping */
/**
 * Three reasoning-bearing assistant turns; the turn removed here carries
 * `[tool-call, reasoning]`, so dropping the call renumbers the reasoning part.
 * That is the adjacent shape the old derivation refused by node id.
 */
function reasoningWireArray(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      reasoning('R-ONE: the first read'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(BIG_BODY))]),
    assistantMessage('msg_a2', [
      toolCall('call_2', 'read', { filePath: 'TODO.md' }),
      reasoning('R-TWO: the second read'),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(BIG_BODY))]),
    assistantMessage('msg_a3', [reasoning('R-THREE: the answer'), text('Both read.')]),
  ];
}

/** The reasoning texts a conversation carries, in transcript order. */
function reasoningTextsOf(messages: readonly OpencodeMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'reasoning' && typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }
  return texts;
}

/** The reasoning parts a conversation carries, in transcript order. */
function reasoningPartsOf(messages: readonly OpencodeMessage[]): readonly unknown[] {
  const parts: unknown[] = [];
  for (const message of messages) {
    for (const part of message.content) if (part.type === 'reasoning') parts.push(part);
  }
  return parts;
}

/** How many times this exact part object occurs in the array's content. */
function occurrencesOfPart(messages: readonly OpencodeMessage[], part: unknown): number {
  let count = 0;
  for (const message of messages) {
    for (const candidate of message.content) if (candidate === part) count += 1;
  }
  return count;
}

test('ISSUE-256 item 4: a removal keeps every reasoning part exactly once, in order', () => {
  const messages = reasoningWireArray();
  const expected = reasoningTextsOf(messages);
  assert.deepEqual(expected, [
    'R-ONE: the first read', 'R-TWO: the second read', 'R-THREE: the answer',
  ], 'the fixture carries three reasoning turns in this order');
  const plan = planForCall(messages, 'call_2', 'note-1', RECEIPT_TEXT);
  const result = deriveOpencodeRevert(requestFor(plan), messages);
  assert.equal(result.status, 'staged', result.status === 'refused'
    ? `${result.code}: ${result.detail}` : 'the removal staged');
  if (result.status !== 'staged') return;
  const carried = reasoningTextsOf(result.messages);
  assert.equal(carried.length, expected.length,
    'the count after the apply equals the fixture\'s count');
  assert.deepEqual(carried, expected, 'the reasoning parts keep their transcript order');
  for (const part of reasoningPartsOf(messages)) {
    assert.equal(occurrencesOfPart(result.messages, part), 1,
      'every input reasoning part is the same object, exactly once');
  }
});

test('ISSUE-256 item 4: a removal adjacent to a reasoning-bearing message keeps it once', () => {
  const messages = reasoningWireArray();
  const adjacent = messages.find(message => message.id === 'msg_a2');
  assert.ok(adjacent !== undefined, 'the adjacent message exists');
  const adjacentReasoning = adjacent.content.filter(part => part.type === 'reasoning');
  assert.equal(adjacentReasoning.length, 1, 'the adjacent message carries one reasoning part');
  const part = adjacentReasoning[0];
  assert.ok(part !== undefined);
  const plan = planForCall(messages, 'call_2', 'note-1', RECEIPT_TEXT);
  const result = deriveOpencodeRevert(requestFor(plan), messages);
  assert.equal(result.status, 'staged', result.status === 'refused'
    ? `${result.code}: ${result.detail}` : 'the adjacent removal staged');
  if (result.status !== 'staged') return;
  assert.equal(occurrencesOfPart(result.messages, part), 1,
    'the reasoning of the rebuilt message survives as the same object, once');
  const rebuilt = result.messages.find(message => message.id === 'msg_a2');
  assert.ok(rebuilt !== undefined, 'the message that carried the reasoning survives');
  assert.equal(rebuilt.content.filter(candidate => candidate.type === 'reasoning').length, 1,
    'the rebuilt message carries its reasoning once');
  assert.deepEqual(reasoningTextsOf(result.messages), reasoningTextsOf(messages),
    'no reasoning text was dropped or duplicated next to the removal');
});

test('ISSUE-256 item 4: a plan naming a reasoning part is refused reasoning-loss', () => {
  // Two reasoning-bearing turns; the plan forgets the second turn's reasoning
  // part by its node id. The part is last in its message, so removing it moves
  // no sibling and the only thing that changes is the thinking chain itself.
  const messages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Think it through.')]),
    assistantMessage('msg_a1', [reasoning('R-ONE: first thought'), text('First answer.')]),
    assistantMessage('msg_a2', [text('Second answer.'), reasoning('R-TWO: second thought')]),
  ];
  const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const second = messages[2];
  assert.ok(second !== undefined, 'the fixture carries the second assistant message');
  const reasoningId = opencodePartNodeId(sessionId, opencodeMessageKey(second, 2), 1);
  assert.equal(second.content[1]?.type, 'reasoning',
    'the node the plan names is the message\'s reasoning part');
  const cutIndex = derived.nodes.findIndex(node => node.id === reasoningId);
  assert.ok(cutIndex > 0, 'the reasoning part is a node after the array head');
  const forgotten = derived.nodes[cutIndex];
  const previous = derived.nodes[cutIndex - 1];
  assert.ok(forgotten !== undefined && previous !== undefined);
  assert.equal(forgotten.id, reasoningId, 'the plan forgets the reasoning part node');
  const survivors = derived.nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id).map(node => node.id);
  const keptBytes = derived.nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id)
    .reduce((sum, node) => sum + node.byteLength, 0);
  const plan = sealPlan({
    cutIndex,
    survivors,
    appends: [{ afterNodeId: previous.id, noteId: 'note-1' }],
    perNode: [{ nodeId: forgotten.id, noteId: 'note-1' }],
    baseRevision: derived.revision,
  }, { freedBytes: forgotten.byteLength, keptBytes });
  const before = structuredClone(messages) as OpencodeMessage[];
  const outcome = deriveOpencodeRevert(requestFor(plan), messages);
  assert.equal(outcome.status, 'refused', 'a plan that drops a reasoning part never stages');
  if (outcome.status === 'refused') {
    assert.equal(outcome.code, 'reasoning-loss', 'the refusal carries the existing code');
    assert.match(outcome.detail, /reasoning part/u, 'the detail names the lost reasoning');
  }
  assert.deepEqual(messages, before, 'the refused derivation left every message untouched');
});
