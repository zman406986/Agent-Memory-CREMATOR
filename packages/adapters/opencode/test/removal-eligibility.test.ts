// The two retention rules (ISSUE-259): what may never be removed.
//
//   1. a tool result the `necromancy` tool produced is the product's own restore
//      payload. It is never tabled for removal, a stored verdict for it is
//      skipped with `recall-answer-retained`, and the wire derivation refuses a
//      plan naming it. Removing it made the restored unit look never-sent in
//      the 1c capture and made the restore proof demand a restore for the
//      result that was itself the restore.
//   2. a unit whose exact result text is a proper substring of another live
//      result's exact text is never tabled or applied
//      (`contained-in-live-result`): every byte the removal takes is still in
//      the request. The containing unit still removes, and a merely similar
//      unit does too. Equality is not containment, so a byte-identical
//      duplicate stays removable; a plan may remove every copy, because each
//      copy is banked under its own recall id and its receipt names that id.
//
// Both rules are checked at the ask table, the ask apply and the wire
// derivation: a stored verdict can outlive the table that wrote it, and every
// lane passes through the derivation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG, MemoryBlobStore, SqliteLedger, UnitTracker,
  canonicalManifestBytes, revertBytes, sha256Sync, toBytes,
} from '@cremator/core';
import type {
  ApplyRequest, ProcessingUnit, RecallManifest, RecallRecord, ToolResultNode,
  ValidatedRevert, WireAnswer,
} from '@cremator/core';
import {
  OPENCODE_FORGOTTEN_NODE_FIELD, OPENCODE_RECEIPT_OF_FIELD, deriveOpencodeRevert,
  opencodeLiveResults, opencodeReceiptEntryId, opencodeResultText, opencodeRetentionOf,
} from '../src/apply.js';
import type {
  OpencodeAppliedPlan, OpencodeAppliedPlanIndex,
} from '../src/apply.js';
import { OPENCODE_CAPABILITIES } from '../src/capabilities.js';
import type {
  OpencodeContentPart, OpencodeMessage, OpencodeToolResultPart,
} from '../src/host.js';
import { applyOpencodeAskVerdicts, createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalKind, OpencodeJournalRecord } from '../src/plugin.js';
import { createOpencodePort } from '../src/port.js';
import { deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, errorResult, jsonResult, sessionId, text, textResult, toolCall, toolMessage,
  toolResult, userMessage,
} from './fixtures.js';

/** Above `DEFAULT_CONFIG.protocol.barBytes` (512): each result is one unit. */
const LARGE_NOTE = `# Note\n\n${'body-'.repeat(180)}\n`;

/** The recall answer: the archived bytes the `necromancy` tool hands back. */
const RECALLED = `# Restored\n\n${'restored-'.repeat(120)}\n`;

/** One normal read and one `necromancy` answer, both above the floor. */
function recallConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note, then restore HISTORY.md.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_note', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_note', 'read', textResult(LARGE_NOTE))]),
    assistantMessage('msg_a2', [
      text('Restoring HISTORY.md.'),
      toolCall('call_recall', 'necromancy', { id: `sha256:${'a'.repeat(64)}` }),
    ]),
    toolMessage('msg_t2', [
      toolResult('call_recall', 'necromancy', textResult(RECALLED)),
    ]),
    assistantMessage('msg_a3', [text('Both are read.')]),
  ];
}

/** A listing long enough to clear the floor. */
function planPaths(): string {
  return Array.from({ length: 30 },
    (_item, index) => `pipeline/output/module_plans/plan_${String(index).padStart(2, '0')}.md`)
    .join('\n');
}

/**
 * The 1c shape: a broad listing that contains the narrow one verbatim, the
 * narrow listing itself, and a merely similar listing that shares every
 * character except the directory name. All three are one unit each.
 */
function globConversation(): OpencodeMessage[] {
  const narrow = planPaths();
  const broad = `pipeline/output/:\n${narrow}\n`
    + 'pipeline/output/architecture/arch_v1.md\npipeline/output/reviews/review_v1.md';
  const similar = narrow.replaceAll('module_plans', 'module_specs');
  return [
    userMessage('msg_u1', [text('List the outputs.')]),
    assistantMessage('msg_a1', [
      text('Globbing everything.'),
      toolCall('call_broad', 'glob', { pattern: 'pipeline/output/**/*' }),
    ]),
    toolMessage('msg_t1', [
      toolResult('call_broad', 'glob', textResult(broad)),
    ]),
    assistantMessage('msg_a2', [
      text('Globbing the plans.'),
      toolCall('call_narrow', 'glob', { pattern: 'pipeline/output/module_plans/*' }),
    ]),
    toolMessage('msg_t2', [
      toolResult('call_narrow', 'glob', textResult(narrow)),
    ]),
    assistantMessage('msg_a3', [
      text('Globbing the specs.'),
      toolCall('call_similar', 'glob', { pattern: 'pipeline/output/module_specs/*' }),
    ]),
    toolMessage('msg_t3', [
      toolResult('call_similar', 'glob', textResult(similar)),
    ]),
    assistantMessage('msg_a4', [text('All listed.')]),
  ];
}

/** Two byte-identical reads: the duplicate class the strict rule must not block. */
function duplicateConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read it twice.')]),
    assistantMessage('msg_a1', [
      text('Reading first.'),
      toolCall('call_first', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_first', 'read', textResult(LARGE_NOTE))]),
    assistantMessage('msg_a2', [
      text('Reading again.'),
      toolCall('call_second', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_second', 'read', textResult(LARGE_NOTE))]),
    assistantMessage('msg_a3', [text('Done.')]),
  ];
}

function journalLines(): {
  readonly records: OpencodeJournalRecord[];
  of(kind: OpencodeJournalKind): OpencodeJournalRecord[];
} {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** The one unit whose node id names this call id. */
function unitFor(messages: readonly OpencodeMessage[], callId: string): ProcessingUnit {
  const snapshot = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const units = new UnitTracker({
    sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes,
  }).units(snapshot);
  const unit = units.find(candidate => candidate.nodeId.endsWith(`:tool:${callId}`));
  assert.ok(unit !== undefined, `the ${callId} result is one unit`);
  return unit;
}

/** The tool-result node one call id names. */
function nodeFor(messages: readonly OpencodeMessage[], callId: string): ToolResultNode {
  const node = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .find((candidate): candidate is ToolResultNode => candidate.kind === 'tool-result'
      && candidate.id.endsWith(`:tool:${callId}`));
  assert.ok(node !== undefined, `the ${callId} result is one node`);
  return node;
}

/** One readable `forgetall` for one unit, built directly, never parsed. */
function forgetAll(unitId: string): WireAnswer {
  return { verdict: { unitId, action: 'forgetall', summary: 'an old read', answeredInRound: 1 } };
}

/** The receipt line the ledger renders; the recall id is archive-shaped. */
const RECEIPT_RECALL = `recall:sha256:${'a'.repeat(64)}`;
const RECEIPT_TEXT = `[not retained] NOTES.md · necromancy ${RECEIPT_RECALL}`;

/**
 * One revert plan sealed the way the guard seals it, over the nodes it forgets.
 * The cut starts at the first forgotten node, and each later forgotten node
 * anchors on the nearest survivor before it.
 */
function sealedPlanForCalls(
  messages: readonly OpencodeMessage[], callIds: readonly string[],
  noteIds: readonly string[],
): ValidatedRevert {
  const snapshot = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const forgotten = callIds.map(callId => nodeFor(messages, callId).id);
  const first = forgotten[0];
  assert.ok(first !== undefined, 'the plan forgets at least one node');
  const cutIndex = snapshot.nodes.findIndex(node => node.id === first);
  assert.ok(cutIndex > 0, 'the first forgotten node has a node before it');
  const previous = snapshot.nodes[cutIndex - 1];
  assert.ok(previous !== undefined, 'the first forgotten node has a node before it');
  const survivors: string[] = [];
  const appends: { afterNodeId: string | null; noteId: string }[] = [];
  const perNode: { nodeId: string; noteId: string }[] = [];
  let anchor: string | null = previous.id;
  for (const node of snapshot.nodes.slice(cutIndex)) {
    const index = forgotten.indexOf(node.id);
    if (index < 0) {
      survivors.push(node.id);
      anchor = node.id;
      continue;
    }
    const noteId = noteIds[index];
    assert.ok(noteId !== undefined, `the plan names a note for forgotten node ${String(index)}`);
    appends.push({ afterNodeId: anchor, noteId });
    perNode.push({ nodeId: node.id, noteId });
  }
  const freedBytes = snapshot.nodes.filter(node => forgotten.includes(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  const keptBytes = snapshot.nodes.slice(cutIndex)
    .filter(node => !forgotten.includes(node.id))
    .reduce((sum, node) => sum + node.byteLength, 0);
  const receiptBytes = toBytes(RECEIPT_TEXT).byteLength * perNode.length;
  const approved = {
    unitIds: forgotten.map((_nodeId, index) => `unit:sha256:${String(index + 1).repeat(64)}`),
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

/** One revert plan sealed the way the guard seals it, over the node it forgets. */
function sealedPlanFor(
  messages: readonly OpencodeMessage[], callId: string, noteId: string,
): ValidatedRevert {
  return sealedPlanForCalls(messages, [callId], [noteId]);
}

/** One request around a sealed plan, with one receipt record per forgotten node. */
function removalRequestFor(
  plan: ValidatedRevert, intentId: string,
  receipts: readonly { readonly noteId: string; readonly text: string }[],
): ApplyRequest {
  const application = {
    sessionId, eventId: 'event-eligibility', baseRevision: plan.baseRevision,
    phase: 'at-rest', mode: 'revert',
    applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1234,
    appendRecords: receipts.map((receipt) => {
      const bytes = toBytes(receipt.text);
      return { recordId: receipt.noteId, bytes, sha256: sha256Sync(bytes) };
    }),
    revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId, eventId: 'event-eligibility',
      baseRevision: plan.baseRevision, applicationSha256: application.applicationSha256,
    },
  };
}

/** One request around a sealed plan over one forgotten node. */
function removalRequest(
  plan: ValidatedRevert, intentId: string, noteId: string,
): ApplyRequest {
  return removalRequestFor(plan, intentId, [{ noteId, text: RECEIPT_TEXT }]);
}

/**
 * The archive one removed copy leaves. The manifest names the copy's own node,
 * so two byte-identical copies still get two recall ids and two ledger rows.
 */
function recallOf(nodeId: string, body: string): RecallRecord {
  const bytes = toBytes(body);
  const sha256 = sha256Sync(bytes);
  const part = {
    source: { nodeId, sha256, byteLength: bytes.byteLength },
    bytes: new Uint8Array(bytes),
    removedRanges: [{ range: { startByte: 0, endByteExclusive: bytes.byteLength }, sha256 }],
  };
  const manifest: RecallManifest = {
    version: 1, sessionId,
    parts: [{ source: part.source, blobSha256: sha256, removedRanges: [...part.removedRanges] }],
  };
  const manifestSha256 = sha256Sync(canonicalManifestBytes(manifest));
  return { id: `recall:sha256:${manifestSha256}`, manifestSha256, manifest, parts: [part] };
}

test('ISSUE-259 fix 1: the ask never offers the recall answer, a normal result still applies',
  async () => {
    const lines = journalLines();
    const prompts: string[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        prompts.push(input.prompt);
        // The recalled row keeps its pass index, so the normal row is addressed
        // by the index the table shows, not by position 1.
        const shown = Number(/^([1-9]\d*)\. \[read\]/mu.exec(input.prompt)?.[1] ?? 1);
        return { text: JSON.stringify({ [String(shown)]: { forgetall: true, summary: 'old read' } }) };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = recallConversation();
      // Step 1 carries both results; step 2 is the first eligible table.
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 0, 'the carrying request asks nothing');
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 1, 'the step after the carrying request asks once');
      const prompt = prompts[0] ?? '';
      assert.match(prompt, /\[read\] NOTES\.md/u,
        'the normal tool result is tabled');
      assert.equal([...prompt.matchAll(/^\d+\. \[/gmu)].length, 1,
        'the recall answer is never a table row');
      const ask = lines.of('ask')[0];
      assert.ok(ask !== undefined, 'one ask fire line was written');
      assert.equal(ask['rowCount'], 1, 'only the normal result reached the table');
      assert.equal((ask['dropped'] as Record<string, number> | undefined)?.['recallAnswer'], 1,
        'the recall answer is counted as retained, not silently lost');
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the normal tool result left the array');
      assert.equal(messages.some(message => message.id === 'msg_t2'), true,
        'the restore answer stayed in the array');
      const applied = lines.of('ask-apply');
      assert.equal(applied.length, 1, 'one applied removal');
      assert.equal(applied[0]?.['applied'], true, 'the normal removal applied');
    } finally { await mount.close(); }
  });

test('ISSUE-259 fix 2: the ask skips a contained unit, keeps the containing one removable',
  async () => {
    const lines = journalLines();
    const prompts: string[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        prompts.push(input.prompt);
        // The table shows the pass's own indices; the contained row leaves a
        // gap, so answer the indices the table actually shows, in row order.
        // The grammar is one JSON object per line.
        const shown = [...input.prompt.matchAll(/^([1-9]\d*)\. \[/gmu)]
          .flatMap(match => (match[1] === undefined ? [] : [match[1]]));
        const answers = shown.map((index, position) => JSON.stringify({
          [index]: { forgetall: true, summary: position === 0 ? 'whole tree' : 'specs' },
        })).join('\n');
        return { text: answers };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = globConversation();
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 0, 'the carrying request asks nothing');
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 1, 'the step after the carrying request asks once');
      const prompt = prompts[0] ?? '';
      assert.match(prompt, /pipeline\/output\/\*\*\/\*/u,
        'the containing listing is tabled');
      assert.match(prompt, /module_specs/u, 'the merely similar listing is tabled');
      // The contained listing's paths may still be quoted by the containing
      // row's anchors (they are lines of the container's own body); what must
      // never appear is a row addressed to the contained unit.
      assert.doesNotMatch(prompt, /^[1-9]\d*\. \[glob\] pipeline\/output\/module_plans\//mu,
        'the contained listing is never a table row');
      const ask = lines.of('ask')[0];
      assert.ok(ask !== undefined, 'one ask fire line was written');
      assert.equal(ask['rowCount'], 2, 'two rows reached the table');
      assert.equal((ask['dropped'] as Record<string, number> | undefined)?.['contained'], 1,
        'the contained unit is counted, not silently lost');
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the containing unit removes normally');
      assert.equal(messages.some(message => message.id === 'msg_t3'), false,
        'the merely similar unit removes normally');
      assert.equal(messages.some(message => message.id === 'msg_t2'), true,
        'the contained unit stays in the array');
      const applied = lines.of('ask-apply');
      assert.equal(applied.length, 2, 'one applied removal per tabled row');
      assert.equal(applied.every(line => line['applied'] === true), true,
        'both tabled removals applied');
    } finally { await mount.close(); }
  });

test('ISSUE-259 fix 1: a stored verdict for the recall answer is skipped by name',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = recallConversation();
      // Two transforms make every carried node eligible; nothing applies.
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unit = unitFor(messages, 'call_recall');
      entry.askVerdicts.set(unit.id, forgetAll(unit.id));
      const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
        lines.records.push({ kind, atMs: 1, ...fields });
      };
      const before = structuredClone(messages) as OpencodeMessage[];
      const applied = await applyOpencodeAskVerdicts({
        entry, messages, snapshot: entry.port.observe(messages), window: 200_000, journal: sink,
      });
      assert.equal(applied, false, 'the recall answer is never applied');
      assert.deepEqual(messages, before, 'the restore answer stays in the array');
      assert.equal(entry.askVerdicts.size, 0, 'the refused verdict is dropped');
      const retained = lines.of('ask-retained');
      assert.equal(retained.length, 1, 'one retention line names the skip');
      assert.equal(retained[0]?.['code'], 'recall-answer-retained',
        'the skip carries its named code');
      assert.equal(retained[0]?.['unitId'], unit.id, 'the line names the unit');
      assert.equal(retained[0]?.['nodeId'], unit.nodeId, 'the line names the node');
      assert.equal(retained[0]?.['applied'], false, 'the line claims no removal');
      assert.equal(lines.of('ask-apply').length, 0, 'no apply line claims it either');
    } finally { await mount.close(); }
  });

test('ISSUE-259 fix 2: a stored verdict for a contained unit is skipped by name',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = globConversation();
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unit = unitFor(messages, 'call_narrow');
      entry.askVerdicts.set(unit.id, forgetAll(unit.id));
      const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
        lines.records.push({ kind, atMs: 1, ...fields });
      };
      const before = structuredClone(messages) as OpencodeMessage[];
      const applied = await applyOpencodeAskVerdicts({
        entry, messages, snapshot: entry.port.observe(messages), window: 200_000, journal: sink,
      });
      assert.equal(applied, false, 'the contained unit is never applied');
      assert.deepEqual(messages, before, 'the contained unit stays in the array');
      assert.equal(entry.askVerdicts.size, 0, 'the refused verdict is dropped');
      const retained = lines.of('ask-retained');
      assert.equal(retained.length, 1, 'one retention line names the skip');
      assert.equal(retained[0]?.['code'], 'contained-in-live-result',
        'the skip carries its named code');
      assert.equal(retained[0]?.['unitId'], unit.id, 'the line names the unit');
      assert.equal(retained[0]?.['nodeId'], unit.nodeId, 'the line names the node');
      assert.equal(retained[0]?.['containedInNodeId'], nodeFor(messages, 'call_broad').id,
        'the line names the live result that contains it');
      assert.equal(retained[0]?.['applied'], false, 'the line claims no removal');
    } finally { await mount.close(); }
  });

test('ISSUE-259 fix 1: the wire derivation refuses a plan naming the recall answer', () => {
  const messages = recallConversation();
  const plan = sealedPlanFor(messages, 'call_recall', 'note-recall');
  const outcome = deriveOpencodeRevert(removalRequest(plan, 'intent-recall', 'note-recall'), messages);
  assert.equal(outcome.status, 'refused', 'the plan is refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.code, 'recall-answer-retained', 'the refusal carries the named code');
  assert.equal(outcome.reason, 'unsupported', 'the refusal names the core reason');
  assert.match(outcome.detail, /necromancy tool's own answer/u,
    'the detail names the recall answer');
  // A normal tool result in the same array is still removable.
  const normal = sealedPlanFor(messages, 'call_note', 'note-normal');
  const staged = deriveOpencodeRevert(removalRequest(normal, 'intent-normal', 'note-normal'),
    messages);
  assert.equal(staged.status, 'staged', 'the normal tool result still stages');
  if (staged.status !== 'staged') return;
  assert.equal(staged.messages.some(message => message.id === 'msg_t1'), false,
    'the normal result is gone');
  assert.equal(staged.messages.some(message => message.id === 'msg_t2'), true,
    'the restore answer is still there');
});

test('ISSUE-259 fix 2: the wire derivation refuses a contained unit, not the container', () => {
  const messages = globConversation();
  const narrow = sealedPlanFor(messages, 'call_narrow', 'note-narrow');
  const refused = deriveOpencodeRevert(removalRequest(narrow, 'intent-narrow', 'note-narrow'),
    messages);
  assert.equal(refused.status, 'refused', 'the contained plan is refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.code, 'contained-in-live-result', 'the refusal carries the named code');
  assert.match(refused.detail, /contained in the live result/u,
    'the detail names the containment');
  assert.match(refused.detail, new RegExp(nodeFor(messages, 'call_broad').id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    'the detail names the containing node');
  // The containing unit still removes normally.
  const broad = sealedPlanFor(messages, 'call_broad', 'note-broad');
  const staged = deriveOpencodeRevert(removalRequest(broad, 'intent-broad', 'note-broad'),
    messages);
  assert.equal(staged.status, 'staged', 'the containing unit stages');
  if (staged.status !== 'staged') return;
  assert.equal(staged.messages.some(message => message.id === 'msg_t1'), false,
    'the containing result is gone');
  assert.equal(staged.messages.some(message => message.id === 'msg_t2'), true,
    'the contained result is still there');
});

test('ISSUE-259 fix 2: containment is strict, so a byte-identical duplicate still stages', () => {
  const messages = duplicateConversation();
  const duplicate = sealedPlanFor(messages, 'call_first', 'note-duplicate');
  const outcome = deriveOpencodeRevert(
    removalRequest(duplicate, 'intent-duplicate', 'note-duplicate'), messages);
  assert.equal(outcome.status, 'staged', 'the duplicate removal is not treated as containment');
  if (outcome.status !== 'staged') return;
  assert.equal(outcome.messages.some(message => message.id === 'msg_t1'), false,
    'the duplicate copy is gone');
  assert.equal(outcome.messages.some(message => message.id === 'msg_t2'), true,
    'the surviving copy stays');
});

/* ---- fixD: a banked removal is re-applied; the rules gate a first-time offer ---- */

/**
 * One applied-plan row, as the port records a landed pass: the units the pass
 * forgot, and — when the pass wrote them — the exact receipt lines and the
 * restore calls its array showed. `port.ts` `appliedPlanOf` builds the same
 * shape; a row without `restores` is a pass from before a visible restore.
 */
function appliedRow(
  passId: string, plan: ValidatedRevert,
  receiptTexts?: ReadonlyMap<string, string>, restores?: readonly string[],
): [string, OpencodeAppliedPlan] {
  return [passId, {
    intentId: passId,
    planSha256: plan.planSha256,
    cutIndex: plan.cutIndex,
    survivors: [...plan.survivors],
    receipts: plan.appends.map(append => append.noteId),
    recalls: plan.appends.map(() => RECEIPT_RECALL),
    forgotten: plan.perNode.map(entry => entry.nodeId),
    ...(restores === undefined ? {} : { restores: [...restores] }),
    ...(receiptTexts === undefined ? {} : { receiptTexts: new Map(receiptTexts) }),
  }];
}

/** The glob conversation without the broad listing: the narrow unit is not contained yet. */
function narrowGlobConversation(): OpencodeMessage[] {
  return globConversation().filter(message => message.id !== 'msg_a1' && message.id !== 'msg_t1');
}

/** A restore of the receipt's recall, placed directly after the prompt of `base`. */
function afterPrompt(base: readonly OpencodeMessage[]): OpencodeMessage[] {
  return [
    ...base.slice(0, 1),
    assistantMessage('msg_ar', [
      text('Restoring the earlier listing.'),
      toolCall('call_restore', 'necromancy', { id: RECEIPT_RECALL }),
    ]),
    toolMessage('msg_tr', [
      toolResult('call_restore', 'necromancy', textResult('the restored listing')),
    ]),
    ...base.slice(1),
  ];
}

test('fixD: a banked removal stays applied when a later live result contains its text', () => {
  // Pass 1: the narrow listing is a first-time offer with no container.
  const first = narrowGlobConversation();
  const firstPlan = sealedPlanFor(first, 'call_narrow', 'note-narrow');
  const firstOutcome = deriveOpencodeRevert(
    removalRequest(firstPlan, 'intent-bank-1', 'note-narrow'), first);
  assert.equal(firstOutcome.status, 'staged', 'the first offer stages');
  if (firstOutcome.status !== 'staged') return;
  assert.equal(firstOutcome.messages.some(message => message.id === 'msg_t2'), false,
    'the first pass removed the unit');
  const firstReceipt = firstOutcome.messages
    .find(message => message.id === opencodeReceiptEntryId('intent-bank-1', 0));
  assert.ok(firstReceipt !== undefined, 'the first pass wrote its receipt');
  const index: OpencodeAppliedPlanIndex = new Map([
    appliedRow('intent-bank-1', firstPlan, firstOutcome.receiptTexts, firstOutcome.restores),
  ]);

  // Pass 2: the host rebuilt the request from its store, so the unit is back,
  // and the broader glob whose tail is the unit's exact text is in the array.
  // That is the 1h shape at seq 13: the same plan would be refused as a
  // first-time offer.
  const second = globConversation();
  const secondPlan = sealedPlanFor(second, 'call_narrow', 'note-narrow');
  assert.equal(
    opencodeRetentionOf(nodeFor(second, 'call_narrow').id,
      opencodeLiveResults(second, sessionId))?.code,
    'contained-in-live-result',
    'the new broader result is exactly what the first-time rule refuses',
  );
  const secondOutcome = deriveOpencodeRevert(
    removalRequest(secondPlan, 'intent-bank-2', 'note-narrow'), second, index);
  assert.equal(secondOutcome.status, 'staged',
    'the banked removal is re-applied, not refused');
  if (secondOutcome.status !== 'staged') return;
  assert.equal(secondOutcome.messages.some(message => message.id === 'msg_t2'), false,
    'the unit stays absent on the rebuilt request');
  assert.equal(secondOutcome.messages.some(message => message.id === 'msg_t1'), true,
    'the containing unit is untouched by this plan');
  const secondReceipt = secondOutcome.messages
    .find(message => message.id === opencodeReceiptEntryId('intent-bank-2', 0));
  assert.ok(secondReceipt !== undefined, 'the re-application wrote its receipt');
  assert.equal(JSON.stringify(secondReceipt.content), JSON.stringify(firstReceipt.content),
    'the receipt line is byte-stable across the re-application');
});

test('fixD: the retention rules still refuse a first-time offer in the same array', () => {
  const messages = globConversation();
  const plan = sealedPlanFor(messages, 'call_narrow', 'note-narrow');
  const refused = deriveOpencodeRevert(
    removalRequest(plan, 'intent-first-time', 'note-narrow'), messages, new Map());
  assert.equal(refused.status, 'refused', 'a first-time contained offer is refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.code, 'contained-in-live-result', 'the named code is unchanged');
  assert.equal(refused.detail.includes(nodeFor(messages, 'call_broad').id), true,
    'the detail names the container');

  // A row for another unit is not evidence for this offer.
  const otherUnit: OpencodeAppliedPlanIndex = new Map([
    appliedRow('intent-other', sealedPlanFor(messages, 'call_similar', 'note-similar')),
  ]);
  const stillRefused = deriveOpencodeRevert(
    removalRequest(plan, 'intent-first-time-2', 'note-narrow'), messages, otherUnit);
  assert.equal(stillRefused.status, 'refused',
    'a row that forgot another unit does not bank this one');
});

test('fixD: a unit banked before the rule existed is re-applied, recall answer and error alike',
  () => {
    /** One failed read and one normal read: the error envelope and a removable result. */
    const errorConversation = (): OpencodeMessage[] => [
      userMessage('msg_u1', [text('Read both notes.')]),
      assistantMessage('msg_a1', [
        text('Reading both.'),
        toolCall('call_error', 'read', { filePath: 'MISSING.md' }),
        toolCall('call_note', 'read', { filePath: 'NOTES.md' }),
      ]),
      toolMessage('msg_te', [
        toolResult('call_error', 'read', errorResult('ENOENT: no such file or directory')),
      ]),
      toolMessage('msg_tn', [toolResult('call_note', 'read', textResult(LARGE_NOTE))]),
      assistantMessage('msg_a2', [text('The first read failed.')]),
    ];
    const cases = [
      {
        name: 'recall answer', messages: recallConversation(), callId: 'call_recall',
        resultId: 'msg_t2', code: 'recall-answer-retained' as const,
      },
      {
        name: 'error result', messages: errorConversation(), callId: 'call_error',
        resultId: 'msg_te', code: 'error-result-retained' as const,
      },
    ];
    for (const item of cases) {
      const plan = sealedPlanFor(item.messages, item.callId, 'note-banked');
      // Without a banked row the rule refuses, so the fixture is its subject.
      const control = deriveOpencodeRevert(
        removalRequest(plan, `intent-control-${item.callId}`, 'note-banked'), item.messages);
      assert.equal(control.status, 'refused', `${item.name} is refused as a first-time offer`);
      if (control.status === 'refused') {
        assert.equal(control.code, item.code, `${item.name} carries its named code`);
      }
      // A row from a pass that banked the removal before the rule existed.
      const index: OpencodeAppliedPlanIndex = new Map([
        appliedRow(`intent-banked-${item.callId}`, plan),
      ]);
      const outcome = deriveOpencodeRevert(
        removalRequest(plan, `intent-reapply-${item.callId}`, 'note-banked'),
        item.messages, index);
      assert.equal(outcome.status, 'staged', `the banked ${item.name} is re-applied`);
      if (outcome.status !== 'staged') continue;
      assert.equal(outcome.messages.some(message => message.id === item.resultId), false,
        `the banked ${item.name} stays absent`);
    }
  });

test('fixD: a restore opens a new epoch, so the unit it makes visible is a first-time offer',
  () => {
    // The restore reaches the transcript first, then the broad listing and the
    // narrow unit it contains. The unit sits after the restore, so it is a new
    // instance, not the removal the restore superseded.
    const messages = afterPrompt(globConversation());
    const plan = sealedPlanFor(messages, 'call_narrow', 'note-narrow');
    const preRestorePlan = sealedPlanFor(globConversation(), 'call_narrow', 'note-narrow');
    const preRestore: OpencodeAppliedPlanIndex = new Map([
      appliedRow('intent-pre-restore', preRestorePlan),
    ]);
    const refused = deriveOpencodeRevert(
      removalRequest(plan, 'intent-post-restore', 'note-narrow'), messages, preRestore);
    assert.equal(refused.status, 'refused',
      'the pre-restore row does not bank the unit the restore made visible');
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'contained-in-live-result', 'the first-time rule applies again');

    // Control: a removal already applied in this epoch is banked and re-applies.
    const epochIndex: OpencodeAppliedPlanIndex = new Map([
      appliedRow('intent-epoch', preRestorePlan, undefined,
        [nodeFor(messages, 'call_restore').id]),
    ]);
    const epoch = deriveOpencodeRevert(
      removalRequest(plan, 'intent-epoch-again', 'note-narrow'), messages, epochIndex);
    assert.equal(epoch.status, 'staged',
      'a removal applied after the restore is re-applied in its own epoch');
    if (epoch.status !== 'staged') return;
    assert.equal(epoch.messages.some(message => message.id === 'msg_t2'), false,
      'the post-restore removal stays applied');
  });

test('fixD port: the row records the forgotten units and the restore calls its array showed',
  async () => {
    const first = afterPrompt(narrowGlobConversation());
    const narrowNode = nodeFor(first, 'call_narrow').id;
    const restoreNode = nodeFor(first, 'call_restore').id;
    const captured: OpencodeAppliedPlanIndex[] = [];
    const port = createOpencodePort({
      sessionId,
      clock: { nowMs: () => 1 },
      messages: first,
      capabilities: { ...OPENCODE_CAPABILITIES, revertHistory: true },
      deriveRevert: (request, messages, index) => {
        captured.push(new Map(index));
        return deriveOpencodeRevert(request, messages, index);
      },
    });
    const plan = sealedPlanFor(first, 'call_narrow', 'note-narrow');
    const applied = await port.apply(removalRequest(plan, 'intent-row-1', 'note-narrow'));
    assert.equal(applied.status, 'applied', 'the first pass applies');
    port.commit();
    // The next request is the rebuilt store: the unit is back, a broader live
    // result contains its text, and the port's own row is what re-applies it.
    const rebuilt = afterPrompt(globConversation());
    port.observe(rebuilt);
    const rebuiltPlan = sealedPlanFor(rebuilt, 'call_narrow', 'note-narrow');
    const again = await port.apply(removalRequest(rebuiltPlan, 'intent-row-2', 'note-narrow'));
    assert.equal(again.status, 'applied',
      'the second pass re-applies in the row\'s epoch');
    const row = captured[1]?.get('intent-row-1');
    assert.ok(row !== undefined, 'the second call saw the first pass\'s row');
    assert.deepEqual(row.forgotten, [narrowNode],
      'the row names the unit the pass removed');
    assert.deepEqual(row.restores, [restoreNode],
      'the row dates the restore epoch its array showed');
  });

/** The `[not retained] …` lines one array carries, in message order. */
function receiptLines(messages: readonly OpencodeMessage[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      const text = part['text'];
      if (part.type === 'text' && typeof text === 'string'
        && text.startsWith('[not retained] ')) lines.push(text);
    }
  }
  return lines;
}

test('fixE: the ask re-applies a banked removal after a newer result contains its text',
  async () => {
    const lines = journalLines();
    let asks = 0;
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        asks += 1;
        // The first table answers the narrow listing. The rebuilt request's
        // later table keeps every row (`{}` refuses each index), so this test
        // measures the banked removal's re-application, not a second removal.
        return { text: asks === 1
          ? '{"1":{"forgetall":true,"summary":"old listing"}}' : '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = narrowGlobConversation();
      // Step 1 carries the units and asks nothing; step 2 tables the narrow
      // listing and applies the readable forgetall.
      await mount.transform(sessionId, messages);
      assert.equal(asks, 0, 'the carrying request asks nothing');
      await mount.transform(sessionId, messages);
      assert.equal(asks, 1, 'the step after the carrying request asks once');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unit = unitFor(narrowGlobConversation(), 'call_narrow');
      const narrowNode = nodeFor(narrowGlobConversation(), 'call_narrow').id;
      assert.equal(messages.some(message => message.id === 'msg_t2'), false,
        'the first ask removed the narrow listing');
      const firstRows = entry.appliedPlans.size;
      assert.ok(firstRows >= 1, 'the mount captured the port\'s applied-plan row');
      const firstApply = lines.of('ask-apply')[0];
      assert.ok(firstApply !== undefined, 'the first apply wrote its line');
      assert.equal(firstApply['applied'], true, 'the first apply landed');
      const firstReceipt = receiptLines(messages);
      assert.equal(firstReceipt.length, 1, 'the first apply wrote one receipt line');

      // The host rebuilds the request from its own store: the narrow listing is
      // back, and a newer broad glob now contains its exact text. The stored
      // verdict must re-apply, not be refused as a first-time offer.
      messages.splice(0, messages.length, ...globConversation());
      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message => message.id === 'msg_t2'), false,
        'the banked removal stays in effect on the rebuilt request');
      assert.equal(messages.some(message => message.id === 'msg_t1'), true,
        'the containing listing is untouched by this plan');
      assert.equal(lines.of('ask-retained').length, 0,
        'no retention line reverses the banked removal');
      const applies = lines.of('ask-apply');
      assert.equal(applies.length, 2, 'the rebuilt request applied the same unit again');
      const secondApply = applies.at(-1);
      assert.ok(secondApply !== undefined, 'the re-application wrote its line');
      assert.equal(secondApply['applied'], true, 'the re-application landed');
      assert.equal(secondApply['unitId'], unit.id, 'the line names the stored verdict unit');
      assert.equal(secondApply['nodeId'], narrowNode, 'the line names the removed node');
      assert.equal(secondApply['recallId'], firstApply['recallId'],
        'the same removal keeps its recall id');
      assert.ok(entry.appliedPlans.size > firstRows,
        'the re-application added its own applied-plan row');
      assert.deepEqual(receiptLines(messages), firstReceipt,
        'the receipt line is byte-identical across the re-application');
    } finally { await mount.close(); }
  });

test('fixE: the ask pre-check keeps the restore epoch, so a made-visible unit is refused',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record),
    });
    try {
      // The request shows a restore of RECEIPT_RECALL before the narrow unit.
      const messages = afterPrompt(globConversation());
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unit = unitFor(messages, 'call_narrow');
      entry.askVerdicts.set(unit.id, forgetAll(unit.id));
      // A row that banked the unit before the restore existed: it names the
      // same recall the request's restore call does, and its array showed no
      // restore, so it does not bank the instance the restore made visible.
      const preRestore: OpencodeAppliedPlanIndex = new Map([
        appliedRow('intent-pre-restore', sealedPlanFor(globConversation(), 'call_narrow',
          'note-narrow')),
      ]);
      const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
        lines.records.push({ kind, atMs: 1, ...fields });
      };
      const before = structuredClone(messages) as OpencodeMessage[];
      const applied = await applyOpencodeAskVerdicts({
        entry, messages, snapshot: entry.port.observe(messages), window: 200_000,
        appliedPlans: preRestore, journal: sink,
      });
      assert.equal(applied, false, 'the post-restore instance is a first-time offer');
      assert.deepEqual(messages, before, 'the unit the restore made visible stays');
      assert.equal(entry.askVerdicts.size, 0, 'the refused verdict is dropped');
      const retained = lines.of('ask-retained');
      assert.equal(retained.length, 1, 'one retention line names the skip');
      assert.equal(retained[0]?.['code'], 'contained-in-live-result',
        'the named code is the one the wire derivation would refuse with');
      assert.equal(retained[0]?.['unitId'], unit.id, 'the line names the unit');
      assert.equal(retained[0]?.['nodeId'], unit.nodeId, 'the line names the node');
    } finally { await mount.close(); }
  });

/** The span that exists only when the two content entries are joined with a newline. */
const SPAN_ACROSS_JOIN = 'one\nline';

/** One conversation whose live container result is the content part it is handed. */
function contentConversation(containerPart: OpencodeContentPart,
  span: string = SPAN_ACROSS_JOIN): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Compare the two outputs.')]),
    assistantMessage('msg_a1', [
      text('Reading the wide output.'),
      toolCall('call_wide', 'read', { filePath: 'WIDE.md' }),
    ]),
    toolMessage('msg_t1', [containerPart]),
    assistantMessage('msg_a2', [
      text('Reading the narrow span.'),
      toolCall('call_span', 'read', { filePath: 'SPAN.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_span', 'read', textResult(span))]),
    assistantMessage('msg_a3', [text('Compared.')]),
  ];
}

test('ISSUE-259 fix 2: a content result is lowered with the host\'s newline join, '
  + 'so a contained span is refused', () => {
  // The host lowers a `content` result to its text parts joined with a newline
  // (ISSUE-258 item 7; the bench's `archivedResultWireText`). The candidate
  // result spans that join, so the empty-string join cannot see it.
  const containerPart = toolResult('call_wide', 'read', {
    type: 'content',
    value: [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ],
  });
  const messages = contentConversation(containerPart);
  assert.equal(opencodeResultText(containerPart as OpencodeToolResultPart),
    'line one\nline two', 'the content result is lowered the way the host sends it');
  const withFile = toolResult('call_wide', 'read', {
    type: 'content',
    value: [
      { type: 'text', text: 'line one' },
      { type: 'file', uri: 'file:///big-b.log', mime: 'text/plain' },
      { type: 'text', text: 'line two' },
    ],
  });
  assert.equal(opencodeResultText(withFile as OpencodeToolResultPart),
    'line one\nline two', 'a file entry contributes no wire text, as the host lowers it');
  const hostJoin = 'line one\nline two';
  const oldJoin = 'line one' + 'line two';
  assert.equal(hostJoin.includes(SPAN_ACROSS_JOIN), true,
    'the host join contains the span across it');
  assert.equal(oldJoin.includes(SPAN_ACROSS_JOIN), false,
    'the old empty-string join would have missed it');

  const plan = sealedPlanFor(messages, 'call_span', 'note-span');
  const refused = deriveOpencodeRevert(removalRequest(plan, 'intent-span', 'note-span'), messages);
  assert.equal(refused.status, 'refused', 'the contained plan is refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.code, 'contained-in-live-result', 'the refusal carries the named code');
  assert.equal(refused.detail.includes(nodeFor(messages, 'call_wide').id), true,
    'the detail names the containing node');

  // Control: the same span against the text the old join produces stages, so
  // the refusal above is the host join's doing and not the rule's.
  const oldMessages = contentConversation(
    toolResult('call_wide', 'read', textResult(oldJoin)));
  const oldPlan = sealedPlanFor(oldMessages, 'call_span', 'note-span');
  const oldOutcome = deriveOpencodeRevert(
    removalRequest(oldPlan, 'intent-span', 'note-span'), oldMessages);
  assert.equal(oldOutcome.status, 'staged', 'the old join would have missed the span');
});

/** The span that exists only when the empty text entry is dropped before the join. */
const SPAN_ACROSS_EMPTY = 'one\nline two';

test('ISSUE-259 fix 3: an empty text entry is dropped before the newline join, '
  + 'so a span across it is refused', () => {
  // The host's normalizer drops empty text entries before the openai-chat
  // lowering joins the rest (tool-history.js:92, openai-chat.js:446-447). A
  // span that crosses the dropped entry is therefore in the live text, while
  // the unfiltered join puts a blank line in its way.
  const containerPart = toolResult('call_wide', 'read', {
    type: 'content',
    value: [
      { type: 'text', text: 'line one' },
      { type: 'text', text: '' },
      { type: 'text', text: 'line two' },
    ],
  });
  const messages = contentConversation(containerPart, SPAN_ACROSS_EMPTY);
  assert.equal(opencodeResultText(containerPart as OpencodeToolResultPart),
    'line one\nline two', 'the empty text entry is dropped before the join');
  const hostJoin = 'line one\nline two';
  const oldJoin = 'line one\n\nline two';
  assert.equal(hostJoin.includes(SPAN_ACROSS_EMPTY), true,
    'the filtered join contains the span across the empty entry');
  assert.equal(oldJoin.includes(SPAN_ACROSS_EMPTY), false,
    'the unfiltered join would have missed it');

  const plan = sealedPlanFor(messages, 'call_span', 'note-span');
  const refused = deriveOpencodeRevert(removalRequest(plan, 'intent-span', 'note-span'), messages);
  assert.equal(refused.status, 'refused', 'the contained plan is refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.code, 'contained-in-live-result', 'the refusal carries the named code');
  assert.equal(refused.detail.includes(nodeFor(messages, 'call_wide').id), true,
    'the detail names the containing node');

  // Control: the same span against the unfiltered join stages, so the refusal
  // above is the filter's doing and not the rule's.
  const oldMessages = contentConversation(
    toolResult('call_wide', 'read', textResult(oldJoin)), SPAN_ACROSS_EMPTY);
  const oldPlan = sealedPlanFor(oldMessages, 'call_span', 'note-span');
  const oldOutcome = deriveOpencodeRevert(
    removalRequest(oldPlan, 'intent-span', 'note-span'), oldMessages);
  assert.equal(oldOutcome.status, 'staged', 'the unfiltered join would have missed the span');
});

/** The host's literal for an empty tool result (`tool-history.js`: `EMPTY_TOOL_OUTPUT`). */
const HOST_EMPTY_OUTPUT = '(no tool output)';

/** The candidate span that exists only inside the host's literal. */
const CONTAINED_SPAN = 'tool output';

/** One live result (the container) and one short candidate result inside its text. */
function emptyResultConversation(containerPart: OpencodeContentPart): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Compare the empty output and the short note.')]),
    assistantMessage('msg_a1', [
      text('Reading the empty output.'),
      toolCall('call_empty', 'read', { filePath: 'EMPTY.md' }),
    ]),
    toolMessage('msg_t1', [containerPart]),
    assistantMessage('msg_a2', [
      text('Reading the short note.'),
      toolCall('call_span', 'read', { filePath: 'SPAN.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_span', 'read', textResult(CONTAINED_SPAN))]),
    assistantMessage('msg_a3', [text('Compared.')]),
  ];
}

test('ISSUE-259 fix 4: an empty content result is lowered to the host literal, '
  + 'so a span inside it is refused', () => {
  // The host's normalizer rewrites a `content` result whose entries are all
  // empty text entries to the text `(no tool output)` (tool-history.js:2,92-94),
  // so the live request carries that literal and this lowering must too.
  const emptyPart = toolResult('call_empty', 'read', { type: 'content', value: [] });
  assert.equal(opencodeResultText(emptyPart as OpencodeToolResultPart), HOST_EMPTY_OUTPUT,
    'an empty content array is lowered to the host literal');
  const blankEntries = toolResult('call_empty', 'read', {
    type: 'content', value: [{ type: 'text', text: '' }, { type: 'text', text: '' }],
  });
  assert.equal(opencodeResultText(blankEntries as OpencodeToolResultPart), HOST_EMPTY_OUTPUT,
    'an all-empty content array is lowered to the host literal');
  // Control: the host keeps a content array with a surviving entry, and a file
  // entry carries no wire text of its own.
  const fileOnly = toolResult('call_empty', 'read', {
    type: 'content', value: [{ type: 'file', uri: 'file:///empty.txt', mime: 'text/plain' }],
  });
  assert.equal(opencodeResultText(fileOnly as OpencodeToolResultPart), '',
    'a file-only content result is not rewritten by the host');
  assert.equal(HOST_EMPTY_OUTPUT.includes(CONTAINED_SPAN), true,
    'the host literal contains the candidate span');

  const messages = emptyResultConversation(emptyPart);
  const plan = sealedPlanFor(messages, 'call_span', 'note-span');
  const refused = deriveOpencodeRevert(
    removalRequest(plan, 'intent-empty-content', 'note-span'), messages);
  assert.equal(refused.status, 'refused', 'the candidate inside the literal is refused');
  if (refused.status !== 'refused') return;
  assert.equal(refused.code, 'contained-in-live-result', 'the refusal carries the named code');
  assert.equal(refused.detail.includes(nodeFor(messages, 'call_empty').id), true,
    'the detail names the empty result as the container');

  // Control: the same candidate stages when the live result lowers to `''`
  // (a file-only array), so the refusal above is the literal's doing.
  const controlMessages = emptyResultConversation(fileOnly);
  const controlPlan = sealedPlanFor(controlMessages, 'call_span', 'note-span');
  const control = deriveOpencodeRevert(
    removalRequest(controlPlan, 'intent-empty-file', 'note-span'), controlMessages);
  assert.equal(control.status, 'staged', 'an empty wire text contains no candidate');
});

test('ISSUE-259 fix 4: an empty text or error result is lowered to the host literal, '
  + 'so a span inside it is refused', () => {
  // The host's normalizer rewrites an empty `text` value and an empty `error`
  // value to the same literal (tool-history.js:86-89).
  const emptyText = toolResult('call_empty', 'read', textResult(''));
  assert.equal(opencodeResultText(emptyText as OpencodeToolResultPart), HOST_EMPTY_OUTPUT,
    'an empty text value is lowered to the host literal');
  const emptyError = toolResult('call_empty', 'read', errorResult(''));
  assert.equal(opencodeResultText(emptyError as OpencodeToolResultPart), HOST_EMPTY_OUTPUT,
    'an empty error value is lowered to the host literal');
  // Control: a json result keeps its own JSON text.
  const jsonPart = toolResult('call_empty', 'read', jsonResult(0));
  assert.equal(opencodeResultText(jsonPart as OpencodeToolResultPart), '0',
    'a json result keeps its own lowering');

  for (const [index, part] of [emptyText, emptyError].entries()) {
    const intentId = `intent-empty-${String(index)}`;
    const messages = emptyResultConversation(part);
    const plan = sealedPlanFor(messages, 'call_span', 'note-span');
    const refused = deriveOpencodeRevert(removalRequest(plan, intentId, 'note-span'), messages);
    assert.equal(refused.status, 'refused', `candidate ${String(index)} is refused`);
    if (refused.status !== 'refused') return;
    assert.equal(refused.code, 'contained-in-live-result',
      `candidate ${String(index)} carries the named code`);
    assert.equal(refused.detail.includes(nodeFor(messages, 'call_empty').id), true,
      `candidate ${String(index)} names the empty result as the container`);
  }
});

test('ISSUE-259 duplicate rule: one plan removes both identical copies, each with its own recall id',
  async () => {
    const messages = duplicateConversation();
    const firstNode = nodeFor(messages, 'call_first').id;
    const secondNode = nodeFor(messages, 'call_second').id;
    const firstArchive = recallOf(firstNode, LARGE_NOTE);
    const secondArchive = recallOf(secondNode, LARGE_NOTE);
    assert.notEqual(firstArchive.id, secondArchive.id,
      'identical bytes under two nodes get two recall ids');
    const plan = sealedPlanForCalls(messages, ['call_first', 'call_second'],
      ['note-first', 'note-second']);
    const outcome = deriveOpencodeRevert(removalRequestFor(plan, 'intent-duplicates', [
      { noteId: 'note-first', text: `[not retained] NOTES.md · necromancy ${firstArchive.id}` },
      { noteId: 'note-second', text: `[not retained] NOTES.md · necromancy ${secondArchive.id}` },
    ]), messages);
    assert.equal(outcome.status, 'staged',
      'a plan may remove every copy of byte-identical bytes');
    if (outcome.status !== 'staged') return;
    assert.equal(outcome.messages.some(message => message.id === 'msg_t1'), false,
      'the first copy is gone');
    assert.equal(outcome.messages.some(message => message.id === 'msg_t2'), false,
      'the second copy is gone');
    const receipts = [0, 1].map((index) => {
      const id = opencodeReceiptEntryId('intent-duplicates', index);
      const found = outcome.messages.filter(message => message.id === id);
      assert.equal(found.length, 1, `receipt ${String(index)} appears once`);
      const receipt = found[0];
      assert.ok(receipt !== undefined, `receipt ${String(index)} is present`);
      return receipt;
    });
    const [firstReceipt, secondReceipt] = receipts;
    assert.ok(firstReceipt !== undefined && secondReceipt !== undefined,
      'both receipts are present');
    assert.deepEqual(
      [firstReceipt, secondReceipt].map(receipt => receipt[OPENCODE_FORGOTTEN_NODE_FIELD]),
      [firstNode, secondNode], 'each receipt names the copy it removed');
    assert.deepEqual(
      [firstReceipt, secondReceipt].map(receipt => receipt[OPENCODE_RECEIPT_OF_FIELD]),
      ['note-first', 'note-second'], 'each receipt names its own record');
    const receiptText = (receipt: OpencodeMessage): string => receipt.content
      .flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
    assert.match(receiptText(firstReceipt), new RegExp(firstArchive.id, 'u'),
      'the first receipt names the first archive');
    assert.doesNotMatch(receiptText(firstReceipt), new RegExp(secondArchive.id, 'u'),
      'the first receipt names only its own archive');
    assert.match(receiptText(secondReceipt), new RegExp(secondArchive.id, 'u'),
      'the second receipt names the second archive');
    assert.doesNotMatch(receiptText(secondReceipt), new RegExp(firstArchive.id, 'u'),
      'the second receipt names only its own archive');

    // The archive guarantee: both copies are banked under their own ids, and
    // each id returns the copy it names with no live duplicate left in play.
    const ledger = await SqliteLedger.open({
      databasePath: ':memory:', blobStore: new MemoryBlobStore(), clock: { nowMs: () => 1 },
    });
    try {
      for (const [index, archive] of [firstArchive, secondArchive].entries()) {
        const identity = toBytes(`application:${String(index)}`);
        await ledger.prepare({
          sessionId, eventId: `event-duplicate-${String(index)}`,
          baseRevision: 'revision-1', phase: 'at-rest',
          applicationSha256: sha256Sync(identity),
          archives: [{ ruleId: 'superseded-read', removalId: `removal-${String(index)}`,
            operationKind: 'verdict', episodeId: null, title: 'NOTES.md', recall: archive }],
          appendRecords: [], sealedEpisodeIds: [],
        });
      }
      for (const archive of [firstArchive, secondArchive]) {
        const restored = await ledger.recall(archive.id);
        assert.equal(restored.parts[0]?.source.nodeId, archive.parts[0]?.source.nodeId,
          'the recall returns the copy its id names');
        assert.equal(new TextDecoder().decode(restored.parts[0]?.bytes), LARGE_NOTE,
          'the removed copy comes back byte-exact');
      }
    } finally { await ledger.close(); }
  });
