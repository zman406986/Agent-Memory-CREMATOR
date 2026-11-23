// A partial `keeplines` on the opencode wire (ISSUE-509; ADR-0053 §Amendment
// 2026-11-23; ADR-0054 §Amendment 2026-11-19 corrected 2026-11-23).
//
// The product table offers `forgetall` and `keeplines`. This file proves the
// wire side of the partial answer:
//
//   - a partial `keeplines` rewrites the unit's typed tool-result part to carry
//     ONLY the kept lines, keeps the call part, and leaves the archive/receipt
//     ranges and the recall id exactly as the plan carried them;
//   - a whole-range `keeplines` is core's clean keep: no removal, nothing moves;
//   - `forgetall` still removes the call and result parts whole;
//   - a partial answer on a non-text result refuses by name and keeps the unit;
//   - an archived body that is not the result's own text refuses by name rather
//     than shipping a fragment.
//
// Both archive geometries are read: the current one, where a unit's bytes ARE
// the decoded result text so its line numbers are the result's lines, and the
// older `{input,name,result}` envelope a stored archive may still carry (it is
// a legacy body, no longer what `snapshot.ts` writes). A body that is neither
// refuses by name rather than shipping a fragment. No live API, no host, no
// ledger.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG, UnitTracker, applyPruneAnswers, planPrunePass, revertBytes, sha256Sync,
  splitLineOffsets, toBytes,
} from '@cremator/core';
import type {
  ApplyRequest, ArchiveRecord, ByteRange, RecallRecord, ToolResultNode, ValidatedRevert,
} from '@cremator/core';
import {
  OPENCODE_FORGOTTEN_NODE_FIELD, OPENCODE_RECEIPT_OF_FIELD, deriveOpencodeRevert,
  opencodePartialKeeps, opencodeReceiptEntryId, opencodeReceiptTextWithPass, opencodeResultText,
} from '../src/apply.js';
import type { OpencodeMessage, OpencodeToolResultPart } from '../src/host.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, errorResult, jsonResult, sessionId, text, textResult, toolCall, toolMessage,
  toolResult, userMessage,
} from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';
// The host's own pre-send normalizer (`@opencode/ai` 2.4.0, `dist/tool-history.js`).
// `normalizeToolHistory` returns the request BY IDENTITY when it rewrites nothing,
// which is the mock proof that the derived request is one the host would send.
// Imported by path because the package's exports map does not publish it.
import { normalizeToolHistory } from '../../../../node_modules/@opencode/ai/dist/tool-history.js';

/** Six lines, each long enough that the body is one above-floor unit. */
const LINES = [
  `line-one ${'-'.repeat(120)}`,
  `line-two ${'-'.repeat(120)}`,
  `line-three KEEP_A ${'-'.repeat(110)}`,
  `line-four KEEP_B ${'-'.repeat(110)}`,
  `line-five KEEP_C ${'-'.repeat(110)}`,
  `line-six ${'-'.repeat(124)}`,
];
const BODY = `${LINES.join('\n')}\n`;
/** Lines 3-5, each with its own newline: what a `keeplines [[3,5]]` keeps. */
const KEPT_TEXT = `${LINES[2]}\n${LINES[3]}\n${LINES[4]}\n`;
/** The byte range of the 1-based lines `from..to` of `body`. */
function linesRangeOf(body: string, from: number, to: number): ByteRange {
  const offsets = splitLineOffsets(toBytes(body));
  const first = offsets[from - 1];
  const last = offsets[to - 1];
  assert.ok(first !== undefined && last !== undefined, 'the line range exists in the body');
  return { startByte: first.startByte, endByteExclusive: last.endByteExclusive };
}

/**
 * A LEGACY `{input,name,result}` archive body: the shape `snapshot.ts` wrote
 * before a unit's bytes became the decoded result text. The legacy-geometry rows
 * build their fixtures with it; the live rows use the result text itself.
 */
function envelopeOf(name: string, input: Record<string, unknown>, result: unknown): string {
  return `{"input":${JSON.stringify(input)},"name":${JSON.stringify(name)},`
    + `"result":${JSON.stringify(result)}}`;
}

/** The first offset of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/**
 * The byte ranges, inside the envelope's escaped result value, of the 1-based
 * lines `runsOfLines` names. This is the geometry a `keeplines` verdict archives:
 * the unit's line numbers count the inner result text, and the dropped bytes are
 * its escaped JSON spans inside the envelope.
 */
function droppedSpansInEnvelope(
  envelope: string, text: string, runsOfLines: readonly (readonly [number, number])[],
): ByteRange[] {
  const bodyBytes = toBytes(envelope);
  const quoted = toBytes(JSON.stringify(text));
  const valueAt = indexOfBytes(bodyBytes, quoted);
  assert.ok(valueAt >= 0, 'the envelope holds its result value');
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const lengths = lines.map(line => toBytes(JSON.stringify(line).slice(1, -1)).length);
  const lineStart = (line: number): number =>
    valueAt + 1 + lengths.slice(0, line - 1).reduce((sum, size) => sum + size, 0);
  return runsOfLines.map(([from, to]) => ({
    startByte: lineStart(from),
    endByteExclusive: lineStart(to) + (lengths[to - 1] ?? 0),
  }));
}

/** The lines 1-2 and 6: the complement of a `keeplines [[3,5]]`. */
const DROPPED_LINES = [[1, 2], [6, 6]] as const;
/** The fixture unit's legacy archived body: an envelope, not the result text. */
const ENVELOPE = envelopeOf('read', { filePath: 'NOTES.md' }, { type: 'text', value: BODY });
const DROPPED_RANGES: readonly ByteRange[] =
  droppedSpansInEnvelope(ENVELOPE, BODY, DROPPED_LINES);
const RECALL_HEX = 'd'.repeat(64);
const RECALL_ID = `recall:sha256:${RECALL_HEX}`;

/** The receipt core renders for a `keeplines` answer: dropped lines, no descriptor. */
const RECEIPT_TEXT = `[not retained] NOTES.md · lines 1-2, 6 · necromancy ${RECALL_ID}`;
const NOTE_ID = 'receipt:unit-partial';

function noteConversation(result = textResult(BODY)): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }, { namespace: 'file' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', result, { namespace: 'file' })]),
    assistantMessage('msg_a2', [text('The note is read.')]),
  ];
}

/** Two independent reads of the same bytes: one partial keep and one forgetall. */
function twoUnitConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u0', [text('Read both notes.')]),
    assistantMessage('msg_a1', [toolCall('call_one', 'read', { filePath: 'ONE.md' })]),
    toolMessage('msg_t1', [toolResult('call_one', 'read', textResult(BODY))]),
    assistantMessage('msg_a2', [toolCall('call_two', 'read', { filePath: 'TWO.md' })]),
    toolMessage('msg_t2', [toolResult('call_two', 'read', textResult(BODY))]),
    assistantMessage('msg_a3', [text('Both are read.')]),
  ];
}

function snapshotOf(messages: readonly OpencodeMessage[]) {
  return deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
}

/** The one tool-result node of the fixture. */
function nodeOf(messages: readonly OpencodeMessage[]): ToolResultNode {
  const node = snapshotOf(messages).nodes
    .find((candidate): candidate is ToolResultNode => candidate.kind === 'tool-result');
  assert.ok(node !== undefined, 'the fixture holds one tool-result node');
  return node;
}

/**
 * One verdict archive over `bytes`, carrying the dropped ranges. Its body hash
 * and each range hash are real, so the derivation's verification passes.
 */
function archiveOverBytes(
  node: ToolResultNode, bytes: Uint8Array, dropped: readonly ByteRange[],
  recallId = RECALL_ID,
): ArchiveRecord {
  const removedRanges = dropped.map(range => ({
    range: { ...range },
    sha256: sha256Sync(bytes.slice(range.startByte, range.endByteExclusive)),
  }));
  const source = { nodeId: node.id, sha256: sha256Sync(bytes), byteLength: bytes.length };
  const recall: RecallRecord = {
    id: recallId,
    manifestSha256: sha256Sync(toBytes(`manifest:${node.id}`)),
    manifest: { version: 1, sessionId,
      parts: [{ source, blobSha256: source.sha256, removedRanges }] },
    parts: [{ source, bytes, removedRanges }],
  };
  return {
    ruleId: 'verdict', removalId: `unit:${node.id}`, operationKind: 'verdict',
    episodeId: null, title: 'not retained NOTES.md', recall,
  };
}

/** One verdict archive over a text body (the same, from a string). */
function archiveFor(
  node: ToolResultNode, body: string, dropped: readonly ByteRange[], recallId = RECALL_ID,
): ArchiveRecord {
  return archiveOverBytes(node, toBytes(body), dropped, recallId);
}

/** One verdict archive whose recall names no part at all. */
function emptyPartArchive(node: ToolResultNode, recallId = RECALL_ID): ArchiveRecord {
  const archive = archiveFor(node, BODY, [linesRangeOf(BODY, 1, 1)], recallId);
  return { ...archive, recall: { ...archive.recall, parts: [] } };
}

interface PlanEntry {
  readonly nodeId: string;
  readonly noteId: string;
}

/**
 * One revert plan sealed the way the guard seals it over `entries`, in snapshot
 * order: the cut starts at the first forgotten node, and every receipt anchors
 * on the nearest survivor before it.
 */
function sealedPlanForEntries(
  messages: readonly OpencodeMessage[], entries: readonly PlanEntry[], receiptBytes: number,
): ValidatedRevert {
  const snapshot = snapshotOf(messages);
  const forgotten = entries.map(entry => entry.nodeId);
  const cutIndex = snapshot.nodes.findIndex(item => item.id === forgotten[0]);
  assert.ok(cutIndex > 0, 'the first forgotten unit has a node before it');
  const previous = snapshot.nodes[cutIndex - 1];
  assert.ok(previous !== undefined, 'the first forgotten unit has a node before it');
  const survivors: string[] = [];
  const appends: { afterNodeId: string | null; noteId: string }[] = [];
  const perNode: { nodeId: string; noteId: string }[] = [];
  let anchor: string | null = previous.id;
  for (const node of snapshot.nodes.slice(cutIndex)) {
    const at = forgotten.indexOf(node.id);
    if (at < 0) {
      survivors.push(node.id);
      anchor = node.id;
      continue;
    }
    const entry = entries[at];
    assert.ok(entry !== undefined, `the plan names an entry for forgotten node ${node.id}`);
    appends.push({ afterNodeId: anchor, noteId: entry.noteId });
    perNode.push({ nodeId: node.id, noteId: entry.noteId });
  }
  const freedBytes = snapshot.nodes.filter(node => forgotten.includes(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  const keptBytes = snapshot.nodes.slice(cutIndex)
    .filter(node => !forgotten.includes(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  const approved = {
    unitIds: entries.map((_entry, index) => `unit:sha256:${String(index + 1).repeat(64)}`),
    cutIndex,
    survivors,
    appends,
    perNode,
    cost: {
      cutIndex, freedBytes, keptBytes, receiptBytes,
      netFreedBytes: freedBytes - keptBytes - receiptBytes,
    },
    baseRevision: snapshot.revision,
  };
  return { ...approved, planSha256: sha256Sync(revertBytes(approved)) };
}

/** One revert plan for the fixture's single unit. */
function sealedPlanFor(
  messages: readonly OpencodeMessage[], noteId: string,
  receiptText = RECEIPT_TEXT,
): ValidatedRevert {
  return sealedPlanForEntries(messages,
    [{ nodeId: nodeOf(messages).id, noteId }], toBytes(receiptText).byteLength);
}

interface ReceiptSpec {
  readonly noteId: string;
  readonly text: string;
}

/** One request around a sealed plan, its archives, and its receipts. */
function requestForReceipts(
  plan: ValidatedRevert, archives: readonly ArchiveRecord[],
  receipts: readonly ReceiptSpec[], intentId = 'intent-partial',
): ApplyRequest {
  const application = {
    sessionId, eventId: 'event-partial', baseRevision: plan.baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives, sealedEpisodeIds: [], createdAtMs: 1234,
    appendRecords: receipts.map((receipt) => {
      const bytes = toBytes(receipt.text);
      return { recordId: receipt.noteId, bytes, sha256: sha256Sync(bytes) };
    }),
    revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId, eventId: 'event-partial', baseRevision: plan.baseRevision,
      applicationSha256: application.applicationSha256,
    },
  };
}

/** One request around a sealed plan, its archives, and the one fixture receipt. */
function requestFor(
  plan: ValidatedRevert, archives: readonly ArchiveRecord[], intentId = 'intent-partial',
  receiptText = RECEIPT_TEXT,
): ApplyRequest {
  return requestForReceipts(plan, archives, [{ noteId: NOTE_ID, text: receiptText }], intentId);
}

/** One receipt message in the host's shape, rendered by this intent's pass. */
function receiptMessageFor(
  intentId: string, index: number, noteId: string, rawText: string, forgottenNodeId: string,
): OpencodeMessage {
  const rendered = opencodeReceiptTextWithPass(rawText, intentId);
  assert.ok(rendered !== null, 'the fixture receipt text carries its recall marker');
  const id = opencodeReceiptEntryId(intentId, index);
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: rendered }],
    [OPENCODE_RECORD_ID_FIELD]: id,
    [OPENCODE_RECEIPT_OF_FIELD]: noteId,
    [OPENCODE_FORGOTTEN_NODE_FIELD]: forgottenNodeId,
  };
}

/** The one tool-result part of an array, in the order the host carries it. */
function resultParts(messages: readonly OpencodeMessage[]): OpencodeToolResultPart[] {
  const parts: OpencodeToolResultPart[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool-result') parts.push(part as unknown as OpencodeToolResultPart);
    }
  }
  return parts;
}

/** Every tool-call part of an array. */
function callParts(messages: readonly OpencodeMessage[]): unknown[] {
  return messages.flatMap(message => message.content.filter(part => part.type === 'tool-call'));
}

/** The one receipt message, or `undefined`. */
function receiptOf(messages: readonly OpencodeMessage[]): OpencodeMessage | undefined {
  return messages.find(message => typeof message['racoonsRecordId'] === 'string');
}

/** The exact text a receipt message renders. */
function receiptTextOf(message: OpencodeMessage): string {
  return message.content.filter(part => part.type === 'text')
    .map(part => String(part['text'])).join('');
}

/** The host's own normalizer leaves this request byte-identical: it would send it. */
function assertHostAccepts(messages: readonly OpencodeMessage[], at: (what: string) => string): void {
  const normalized = normalizeToolHistory(messages as never) as unknown;
  assert.equal(normalized, messages,
    at('the host normalizer rewrites nothing in the derived request'));
  assert.equal(resultParts(messages).some(part =>
    part.result.type === 'text' && part.result.value === '(no tool output)'), false,
  at('no result was rewritten to the host empty-output literal'));
}

const ROWS: readonly Row[] = [
  { name: 'a-partial-keeplines-rewrites-the-result-part-to-the-kept-lines', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const archive = archiveFor(nodeOf(messages), ENVELOPE, DROPPED_RANGES);
    const plan = sealedPlanFor(messages, NOTE_ID);

    const keeps = opencodePartialKeeps([archive]);
    assert.equal(keeps.status, 'derived', at('the archive reads as a partial keep set'));
    if (keeps.status !== 'derived') return;
    const keep = keeps.keeps.get(nodeOf(messages).id);
    assert.ok(keep !== undefined, at('the unit has one partial keep'));
    assert.deepEqual(keep?.removedRanges, [...DROPPED_RANGES],
      at('the keep names exactly the dropped bytes'));
    assert.equal(keep?.keptRanges.length, 3,
      at('the kept bytes are the envelope prefix, the kept lines and the envelope suffix'));
    assert.equal(keep?.recallId, RECALL_ID, at('the keep names the archive recall id'));
    assert.notEqual(ENVELOPE, BODY,
      at('the archived body is the envelope, not the result text'));

    const derived = deriveOpencodeRevert(requestFor(plan, [archive]), messages);
    assert.equal(derived.status, 'staged', at('the partial keep stages'));
    if (derived.status !== 'staged') return;
    assert.deepEqual(messages, before, at('the derivation never mutates its input'));

    const parts = resultParts(derived.messages);
    assert.equal(parts.length, 1, at('the unit result part is still in the request'));
    const part = parts[0];
    assert.ok(part !== undefined);
    assert.equal(part.id, 'call_1', at('the part keeps its call id'));
    assert.equal(part.name, 'read', at('the part keeps its tool name'));
    assert.equal(part['namespace'], 'file', at('the part keeps its namespace'));
    assert.equal(part.result.type, 'text', at('the part keeps its text encoding'));
    assert.equal(part.result.value, KEPT_TEXT, at('the part carries exactly the kept lines'));
    assert.equal(String(part.result.value).includes('line-one'), false,
      at('a dropped line left the part'));
    assert.equal(String(part.result.value).includes('line-six'), false,
      at('the last dropped line left the part'));
    assert.equal(callParts(derived.messages).length, 1,
      at('the call part stays, so the provider pair is intact'));
    assert.equal(derived.messages.some(message => message.id === 'msg_t1'), true,
      at('the message holding the result part stays'));

    const receipt = receiptOf(derived.messages);
    assert.ok(receipt !== undefined, at('the removal lands its receipt'));
    const text = receiptTextOf(receipt);
    assert.equal(text.includes(RECALL_ID), true, at('the receipt keeps the recall id'));
    assert.equal(text.includes('lines 1-2, 6'), true,
      at('the receipt names the dropped lines, untouched by the rewrite'));
    assert.equal(text.includes(KEPT_TEXT), false, at('the receipt does not ship kept bytes'));

    const receiptIndex = derived.messages.indexOf(receipt);
    const toolIndex = derived.messages.findIndex(message => message.id === 'msg_t1');
    assert.ok(toolIndex >= 0 && receiptIndex > toolIndex,
      at('the receipt lands after the message holding the kept lines'));
    assert.equal(derived.messages.filter(message => receiptOf([message]) !== undefined).length, 1,
      at('one receipt line for one recall id'));

    // The archive the rewrite read is untouched: the same envelope body, the
    // same dropped ranges, the same recall id. Only the request's text changed.
    const archivedBytes = archive.recall.parts[0]?.bytes ?? toBytes('');
    assert.equal(new TextDecoder().decode(archivedBytes), ENVELOPE,
      at('the archive still holds the legacy envelope'));
    assert.equal(JSON.parse(new TextDecoder().decode(archivedBytes))['result']['value'], BODY,
      at('the archived envelope still carries the whole result value'));
    assert.deepEqual(archive.recall.parts[0]?.removedRanges.map(span => span.range),
      [...DROPPED_RANGES], at('the archive still names only the dropped bytes'));
    assert.equal(archive.recall.id, RECALL_ID, at('the archive recall id is unchanged'));

    assertHostAccepts(derived.messages, at);
  } },
  { name: 'a-partial-keeplines-over-the-units-own-text-rewrites-the-same-way', run(at) {
    // The live geometry after ISSUE-509's snapshot fix: a unit's bytes ARE the
    // decoded result text, so the archive body is that text and the dropped
    // ranges are its own line spans.
    const messages = noteConversation();
    const before = structuredClone(messages);
    const dropped = [linesRangeOf(BODY, 1, 2), linesRangeOf(BODY, 6, 6)];
    const archive = archiveFor(nodeOf(messages), BODY, dropped);
    const plan = sealedPlanFor(messages, NOTE_ID);
    const derived = deriveOpencodeRevert(requestFor(plan, [archive]), messages);
    assert.equal(derived.status, 'staged', at('the partial keep stages'));
    if (derived.status !== 'staged') return;
    assert.deepEqual(messages, before, at('the derivation never mutates its input'));
    const part = resultParts(derived.messages)[0];
    assert.ok(part !== undefined, at('the unit result part is still in the request'));
    assert.equal(part.result.type, 'text', at('the part keeps its text encoding'));
    assert.equal(part.result.value, KEPT_TEXT, at('the part carries exactly the kept lines'));
    assert.equal(callParts(derived.messages).length, 1, at('the call part stays'));
    const receipt = receiptOf(derived.messages);
    assert.ok(receipt !== undefined, at('the removal lands its receipt'));
    assert.equal(receiptTextOf(receipt).includes(RECALL_ID), true,
      at('the receipt keeps the recall id'));
    assertHostAccepts(derived.messages, at);
  } },
  { name: 'a-whole-range-keeplines-keeps-the-unit-and-applies-nothing', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const snapshot = snapshotOf(messages);
    const units = new UnitTracker({ sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes })
      .units(snapshot);
    const nodes = snapshot.nodes
      .filter((node): node is ToolResultNode => node.kind === 'tool-result');
    const plan = planPrunePass({
      units, nodes, episodes: [], classes: {}, round: 1, grammar: 'nokeepall',
    });
    const row = plan.askRows[0];
    assert.ok(row !== undefined, at('the unit is tabled'));
    const lineCount = (row.unit.span.lineRange?.endLineInclusive ?? 0)
      - (row.unit.span.lineRange?.startLine ?? 0) + 1;
    const answer = JSON.stringify({
      [String(row.index)]: { keeplines: [[1, lineCount]], summary: 'None' },
    });
    const merged = applyPruneAnswers(plan, [answer], {
      indices: [row.index], stamps: plan.stamps,
    });
    assert.equal(merged.removals.length, 0,
      at('a whole-range keeplines is core\'s clean keep: no removal is merged'));
    assert.deepEqual(merged.kept, [row.unit.id], at('the unit is kept'));
    assert.deepEqual(messages, before, at('nothing was applied, so the array keeps every byte'));

    // A verifier that hands the apply an archive naming no dropped range gets a
    // named refusal, never a silent whole-unit removal or a no-op claim.
    const emptyRange = archiveFor(nodeOf(messages), BODY, []);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [emptyRange]), messages);
    assert.equal(refused.status, 'refused', at('an archive with no dropped range is refused'));
    if (refused.status === 'refused') {
      assert.equal(refused.code, 'partial-keep-unusable',
        at('the refusal names the unreadable keep'));
    }
    assert.deepEqual(messages, before, at('the refusal leaves the wire untouched'));
  } },
  { name: 'a-forgetall-still-removes-the-call-and-result-parts-whole', run(at) {
    const messages = noteConversation();
    const archive = archiveFor(nodeOf(messages), BODY,
      [{ startByte: 0, endByteExclusive: toBytes(BODY).length }]);
    const plan = sealedPlanFor(messages, NOTE_ID);

    const keeps = opencodePartialKeeps([archive]);
    assert.equal(keeps.status, 'derived', at('a whole-unit archive reads'));
    if (keeps.status === 'derived') {
      assert.equal(keeps.keeps.size, 0, at('a whole-unit removal is not a partial keep'));
    }

    const derived = deriveOpencodeRevert(requestFor(plan, [archive]), messages);
    assert.equal(derived.status, 'staged', at('the forgetall stages'));
    if (derived.status !== 'staged') return;
    assert.equal(resultParts(derived.messages).length, 0,
      at('the result part left the request'));
    assert.equal(callParts(derived.messages).length, 0,
      at('the call part left with it, so no call dangles'));
    assert.equal(derived.messages.some(message => message.id === 'msg_t1'), false,
      at('the tool message left with its unit'));
    const receipt = receiptOf(derived.messages);
    assert.ok(receipt !== undefined, at('the removal lands its receipt'));
    assert.equal(receiptTextOf(receipt).includes(RECALL_ID), true,
      at('the receipt keeps the recall id'));
    assertHostAccepts(derived.messages, at);
  } },
  { name: 'a-partial-keeplines-on-a-json-result-refuses-by-name-and-keeps', run(at) {
    const messages = noteConversation(jsonResult(['alpha', 'beta', 'gamma']));
    const before = structuredClone(messages);
    const body = `"alpha"\n"beta"\n"gamma"\n`;
    const archive = archiveFor(nodeOf(messages), body, [linesRangeOf(body, 1, 2)]);
    const keeps = opencodePartialKeeps([archive]);
    assert.equal(keeps.status, 'derived', at('the archive itself reads as a partial keep'));
    if (keeps.status === 'derived') {
      assert.equal(keeps.keeps.size, 1, at('the unit has one partial keep'));
    }

    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('a json result refuses the partial keep'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-non-text',
      at('the refusal names the non-text result'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
    assert.equal(resultParts(messages)[0]?.result.type, 'json',
      at('the json tag is never rewritten'));
  } },
  { name: 'a-partial-keep-whose-archive-describes-other-text-refuses-by-name', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    // The archived body is well formed text, but it is neither the envelope nor
    // this result's text, so no kept lines of this unit can be re-emitted.
    const body = 'another result entirely\nsecond line\n';
    const archive = archiveFor(nodeOf(messages), body, [linesRangeOf(body, 1, 1)]);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('a foreign body refuses'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-unrepresentable',
      at('the refusal names the unrepresentable keep'));
    assert.deepEqual(messages, before, at('the unit keeps every byte, never a fragment'));
  } },
  { name: 'a-mixed-plan-cleanup-drops-only-the-contradicted-receipt', run(at) {
    const messages = twoUnitConversation();
    const snapshot = snapshotOf(messages);
    const one = snapshot.nodes.find((node): node is ToolResultNode =>
      node.kind === 'tool-result' && node.id.endsWith(':tool:call_one'));
    const two = snapshot.nodes.find((node): node is ToolResultNode =>
      node.kind === 'tool-result' && node.id.endsWith(':tool:call_two'));
    assert.ok(one !== undefined && two !== undefined, 'both reads are one node each');
    const noteOne = 'receipt:one';
    const noteTwo = 'receipt:two';
    const recallTwo = `recall:sha256:${'f'.repeat(64)}`;
    const receiptOne = `[not retained] ONE.md · lines 1-2, 6 · necromancy ${RECALL_ID}`;
    const receiptTwo = `[not retained] TWO.md · necromancy ${recallTwo}`;
    const plan = sealedPlanForEntries(messages, [
      { nodeId: one.id, noteId: noteOne },
      { nodeId: two.id, noteId: noteTwo },
    ], toBytes(receiptOne).byteLength + toBytes(receiptTwo).byteLength);
    const archiveOne = archiveFor(one, BODY, [linesRangeOf(BODY, 1, 2), linesRangeOf(BODY, 6, 6)]);
    const archiveTwo = archiveFor(two, BODY,
      [{ startByte: 0, endByteExclusive: toBytes(BODY).length }], recallTwo);
    const intentId = 'intent-mixed';
    const request = requestForReceipts(plan, [archiveOne, archiveTwo], [
      { noteId: noteOne, text: receiptOne },
      { noteId: noteTwo, text: receiptTwo },
    ], intentId);

    // The array a host rebuild leaves: both results readable, this intent's two
    // receipts present, and the partial keep's result already rewritten.
    const [u0, a1, t1, a2, t2, a3] = messages;
    assert.ok(u0 !== undefined && a1 !== undefined && t1 !== undefined
      && a2 !== undefined && t2 !== undefined && a3 !== undefined, 'the fixture is whole');
    const keptTool: OpencodeMessage = {
      ...t1,
      content: [{ type: 'tool-result', id: 'call_one', name: 'read',
        result: { type: 'text', value: KEPT_TEXT } }],
    };
    const rebuilt = [
      u0, a1, keptTool, a2, t2, a3,
      receiptMessageFor(intentId, 0, noteOne, receiptOne, one.id),
      receiptMessageFor(intentId, 1, noteTwo, receiptTwo, two.id),
    ];
    const before = structuredClone(rebuilt);

    const outcome = deriveOpencodeRevert(request, rebuilt);
    assert.equal(outcome.status, 'refused', at('a partly rebuilt array refuses the intent'));
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.code, 'intent-conflict',
      at('the refusal names the stale-receipt class'));
    assert.deepEqual(rebuilt, before, at('the refusal leaves the input array untouched'));
    const cleanup = outcome.cleanup ?? [];
    assert.equal(cleanup.length, rebuilt.length - 1,
      at('exactly one stale receipt leaves the cleanup array'));
    assert.equal(cleanup.some(message =>
      message['racoonsRecordId'] === opencodeReceiptEntryId(intentId, 0)), true,
    at('the partial keep\'s valid receipt is not dropped'));
    assert.equal(cleanup.some(message =>
      message['racoonsRecordId'] === opencodeReceiptEntryId(intentId, 1)), false,
    at('the contradicted whole-unit receipt is dropped'));
  } },
  { name: 'an-input-key-named-result-does-not-shadow-the-envelope-result', run(at) {
    const messages = noteConversation();
    // The legacy envelope's input carries its own `result` key; the envelope's
    // result is its LAST member, so the lookup must anchor there, not on the
    // first `"result":` bytes it meets.
    const envelope = envelopeOf('read', { result: 'shadow', filePath: 'NOTES.md' },
      { type: 'text', value: BODY });
    const dropped = droppedSpansInEnvelope(envelope, BODY, DROPPED_LINES);
    const archive = archiveFor(nodeOf(messages), envelope, dropped);
    const derived = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(derived.status, 'staged',
      at('the envelope result is found after the input member'));
    if (derived.status !== 'staged') return;
    assert.equal(resultParts(derived.messages)[0]?.result.value, KEPT_TEXT,
      at('the kept lines come from the envelope result, not the input'));
  } },
  { name: 'a-json-string-lowers-to-its-json-text', run(at) {
    const jsonString = toolResult('call_1', 'read', jsonResult('abc')) as OpencodeToolResultPart;
    assert.equal(opencodeResultText(jsonString), '"abc"',
      at('a json string is its JSON text, never the bare value'));
    const jsonObject = toolResult('call_1', 'read', jsonResult({ a: 1 })) as OpencodeToolResultPart;
    assert.equal(opencodeResultText(jsonObject), '{"a":1}', at('a json object keeps its JSON text'));
    const errorString = toolResult('call_1', 'read', errorResult('boom')) as OpencodeToolResultPart;
    assert.equal(opencodeResultText(errorString), 'boom',
      at('a bare error value stays its own text'));
    const errorObject = toolResult('call_1', 'read',
      { type: 'error', value: { code: 1 } }) as OpencodeToolResultPart;
    assert.equal(opencodeResultText(errorObject), '{"code":1}',
      at('a structured error value is its JSON text'));
  } },
  { name: 'a-partial-keep-on-an-error-result-refuses-error-result-retained', run(at) {
    const messages = noteConversation(errorResult(BODY));
    const before = structuredClone(messages);
    const archive = archiveFor(nodeOf(messages), BODY, [linesRangeOf(BODY, 1, 2)]);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('the error result keeps the unit'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'error-result-retained',
      at('the retention rule is decided before the text check'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
  } },
  { name: 'a-second-derivation-over-the-staged-array-is-the-identity', run(at) {
    const messages = noteConversation();
    const archive = archiveFor(nodeOf(messages), BODY,
      [linesRangeOf(BODY, 1, 2), linesRangeOf(BODY, 6, 6)]);
    const request = requestFor(sealedPlanFor(messages, NOTE_ID), [archive]);
    const first = deriveOpencodeRevert(request, messages);
    assert.equal(first.status, 'staged', at('the first derivation stages'));
    if (first.status !== 'staged') return;
    const again = deriveOpencodeRevert(request, first.messages);
    assert.equal(again.status, 'staged', at('the same intent over its own output stages'));
    if (again.status !== 'staged') return;
    assert.equal(again.messages, first.messages,
      at('the array is its own result: the identity run returns it unchanged'));
    assert.equal(resultParts(again.messages)[0]?.result.value, KEPT_TEXT,
      at('the kept lines are still the lines in effect'));
    assert.equal(again.messages.filter(message => receiptOf([message]) !== undefined).length, 1,
      at('the receipt is not appended a second time'));
  } },
  { name: 'a-content-result-keeps-one-text-entry', run(at) {
    const content = { type: 'content', value: [
      { type: 'text', text: 'one\ntwo' },
      { type: 'text', text: 'three\n' },
    ] } as const;
    const messages = noteConversation(content as never);
    const body = 'one\ntwo\nthree\n';
    const archive = archiveFor(nodeOf(messages), body, [linesRangeOf(body, 1, 2)]);
    const derived = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(derived.status, 'staged', at('a text-only content result stages'));
    if (derived.status !== 'staged') return;
    const part = resultParts(derived.messages)[0];
    assert.ok(part !== undefined, at('the content result part stays'));
    assert.equal(part.result.type, 'content', at('the content encoding is kept'));
    assert.deepEqual(part.result.value, [{ type: 'text', text: 'three\n' }],
      at('the kept lines are one text blob, never one entry per line'));
  } },
  { name: 'a-range-straddling-the-legacy-text-region-refuses', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const valueAt = indexOfBytes(toBytes(ENVELOPE), toBytes(JSON.stringify(BODY)));
    assert.ok(valueAt >= 0, 'the envelope holds its result value');
    const archive = archiveFor(nodeOf(messages), ENVELOPE,
      [{ startByte: valueAt - 4, endByteExclusive: valueAt + 12 }]);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('a straddling range refuses the plan'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-unrepresentable',
      at('the refusal names the unrepresentable keep'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
  } },
  { name: 'a-non-utf8-archived-body-refuses', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const archive = archiveOverBytes(nodeOf(messages), bytes, [{ startByte: 0, endByteExclusive: 1 }]);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('a non-UTF-8 body refuses the plan'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-unrepresentable',
      at('the refusal names the unrepresentable keep'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
  } },
  { name: 'malformed-and-duplicate-archives-refuse-by-name', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const node = nodeOf(messages);
    const plan = sealedPlanFor(messages, NOTE_ID);
    const partial = archiveFor(node, BODY,
      [linesRangeOf(BODY, 1, 2), linesRangeOf(BODY, 6, 6)]);
    const whole = archiveFor(node, BODY,
      [{ startByte: 0, endByteExclusive: toBytes(BODY).length }]);
    const empty = emptyPartArchive(node);
    const foreign = archiveOverBytes({ ...node, id: 'oc:ses_test:tool:absent' },
      toBytes(BODY), [linesRangeOf(BODY, 1, 2)]);
    const firstPart = partial.recall.parts[0];
    assert.ok(firstPart !== undefined, 'the partial archive carries its part');
    const doubled: ArchiveRecord = {
      ...partial,
      recall: { ...partial.recall, parts: [firstPart, firstPart] },
    };
    const cases: readonly (readonly [string, readonly ArchiveRecord[], string])[] = [
      ['two whole-unit archives', [whole, whole], 'two verdict archives name'],
      ['a whole-unit archive then a partial one', [whole, partial], 'two verdict archives name'],
      ['one archive naming the node twice', [doubled], 'one verdict archive names'],
      ['an archive naming no part', [empty], 'names no source part'],
      ['an archive naming a foreign node', [foreign], 'which this array does not hold'],
    ];
    for (const [label, archives, detail] of cases) {
      const refused = deriveOpencodeRevert(requestFor(plan, archives), messages);
      assert.equal(refused.status, 'refused', at(`${label}: the plan refuses`));
      if (refused.status !== 'refused') continue;
      assert.equal(refused.code, 'partial-keep-unusable', at(`${label}: the code is named`));
      assert.equal(refused.detail.includes(detail), true,
        at(`${label}: the detail names the case`));
      assert.deepEqual(messages, before, at(`${label}: the array keeps every byte`));
    }
  } },
  { name: 'a-non-tail-envelope-result-refuses', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    // A legacy body whose result member is not last: the tail anchor cannot
    // find it, so the plan refuses instead of guessing an offset.
    const envelope = `{"result":{"type":"text","value":${JSON.stringify(BODY)}},`
      + '"input":{"filePath":"NOTES.md"},"name":"read"}';
    const archive = archiveFor(nodeOf(messages), envelope,
      [{ startByte: 0, endByteExclusive: 10 }]);
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID), [archive]), messages);
    assert.equal(refused.status, 'refused', at('the reordered envelope refuses the plan'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-unrepresentable',
      at('the refusal names the unrepresentable keep'));
    assert.equal(refused.detail.includes('last member'), true,
      at('the refusal names the tail anchor that could not place the result'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
  } },
  { name: 'a-receipt-naming-another-recall-than-the-archive-refuses', run(at) {
    const messages = noteConversation();
    const before = structuredClone(messages);
    const archive = archiveFor(nodeOf(messages), BODY,
      [linesRangeOf(BODY, 1, 2), linesRangeOf(BODY, 6, 6)]);
    const otherReceipt =
      `[not retained] NOTES.md · lines 1-2, 6 · necromancy recall:sha256:${'a'.repeat(64)}`;
    const refused = deriveOpencodeRevert(
      requestFor(sealedPlanFor(messages, NOTE_ID, otherReceipt), [archive],
        'intent-partial', otherReceipt), messages);
    assert.equal(refused.status, 'refused', at('a receipt and archive that disagree refuse'));
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'partial-keep-unusable',
      at('the refusal names the unreadable keep'));
    assert.deepEqual(messages, before, at('the unit keeps every byte'));
  } },
];

test('the opencode partial-keeplines apply path — one row per claim', async () => {
  await runRows(ROWS);
});
