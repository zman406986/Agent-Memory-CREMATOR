// 1f diagnosis FIX 2: a failure envelope is never a removal candidate.
//
// The 1f capture removed a once-called `question` tool's cancelled envelope —
// 219 bytes of `{"error":{…},"content":[]}` — deleting the only statement that
// the tool failed and making the bench's same-tool control impossible. The rule:
// a result whose tag is `error` (or a cancelled/error `question`) is never
// eligible. Every lane reads one rule (`opencodeRetentionOf`): the ask table
// never offers it, a stored verdict for it is dropped and journalled
// `ask-retained` with `code: 'error-result-retained'`, and the wire derivation
// refuses a plan naming it with that code. A normal result beside it still
// removes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG, UnitTracker, revertBytes, sha256Sync, toBytes,
} from '@cremator/core';
import type {
  ApplyRequest, ProcessingUnit, ToolResultNode, ValidatedRevert, WireAnswer,
} from '@cremator/core';
import {
  deriveOpencodeRevert, opencodeLiveResults, opencodeRetentionOf,
} from '../src/apply.js';
import type { OpencodeMessage, OpencodeToolResultValue } from '../src/host.js';
import { applyOpencodeAskVerdicts, createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalKind, OpencodeJournalRecord } from '../src/plugin.js';
import { deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, errorResult, jsonResult, sessionId, text, textResult, toolCall,
  toolMessage, toolResult, userMessage,
} from './fixtures.js';

/** Above `DEFAULT_CONFIG.protocol.barBytes` (512): each result is one unit. */
const LARGE_NOTE = `# Note\n\n${'body-'.repeat(180)}\n`;

/** The question text, long enough that the unit clears the 512-byte floor. */
const LONG_QUESTION = 'Should the audit be bounded to the entry documents, or should it read '
  + 'every file in the repository across several sessions? '.repeat(6);

/**
 * The host's cancelled-`question` envelope, `error` before `content`. The body
 * is the error value's own JSON text (ISSUE-509), so the message is long enough
 * that the body alone clears the 512-byte floor: a unit is minted, and the
 * retention rule — not the floor — is what keeps it.
 */
const CANCELLED_QUESTION = {
  error: {
    type: 'tool.execution',
    message: ('This non-interactive run cannot ask the user questions. Continue without an '
      + 'answer; make reasonable assumptions and state them. ').repeat(4).trim(),
  },
  content: [],
};

/** The normal `question` answer: no `error` field, so it is ordinary content. */
const ANSWERED_QUESTION = {
  answers: [{ question: LONG_QUESTION, answer: 'Bounded' }],
};

/**
 * One prompt, a `question` call whose result is `questionResult`, and one normal
 * read: the error envelope and a removable result in the same request.
 */
function conversation(questionResult: OpencodeToolResultValue): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Audit the repository.')]),
    assistantMessage('msg_a1', [
      text('I hit a hard limit.'),
      toolCall('call_question', 'question', {
        questions: [{ question: LONG_QUESTION, options: [{ label: 'Bounded' }] }],
      }),
      toolCall('call_note', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_tq', [toolResult('call_question', 'question', questionResult)]),
    toolMessage('msg_tn', [toolResult('call_note', 'read', textResult(LARGE_NOTE))]),
    assistantMessage('msg_a2', [text('Continuing without an answer.')]),
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
  return { verdict: { unitId, action: 'forgetall', summary: 'a failed call', answeredInRound: 1 } };
}

/** The receipt line the ledger renders for a removal. */
const RECEIPT_TEXT = `[not retained] NOTES.md · necromancy recall:sha256:${'a'.repeat(64)}`;

/** One revert plan sealed the way the guard seals it, over one forgotten node. */
function sealedPlanFor(
  messages: readonly OpencodeMessage[], callId: string, noteId: string,
): ValidatedRevert {
  const snapshot = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const forgotten = [nodeFor(messages, callId).id];
  const cutIndex = snapshot.nodes.findIndex(node => node.id === forgotten[0]);
  assert.ok(cutIndex > 0, 'the forgotten node has a node before it');
  const previous = snapshot.nodes[cutIndex - 1];
  assert.ok(previous !== undefined, 'the forgotten node has a node before it');
  const survivors: string[] = [];
  const appends: { afterNodeId: string | null; noteId: string }[] = [];
  const perNode: { nodeId: string; noteId: string }[] = [];
  let anchor: string | null = previous.id;
  for (const node of snapshot.nodes.slice(cutIndex)) {
    if (!forgotten.includes(node.id)) {
      survivors.push(node.id);
      anchor = node.id;
      continue;
    }
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
    unitIds: forgotten.map(() => `unit:sha256:${'1'.repeat(64)}`),
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

/** One request around a sealed plan over one forgotten node. */
function removalRequest(
  plan: ValidatedRevert, intentId: string, noteId: string,
): ApplyRequest {
  const application = {
    sessionId, eventId: 'event-error-retained', baseRevision: plan.baseRevision,
    phase: 'at-rest', mode: 'revert',
    applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1234,
    appendRecords: [(() => {
      const bytes = toBytes(RECEIPT_TEXT);
      return { recordId: noteId, bytes, sha256: sha256Sync(bytes) };
    })()],
    revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId, eventId: 'event-error-retained',
      baseRevision: plan.baseRevision, applicationSha256: application.applicationSha256,
    },
  };
}

test('1f FIX 2: the ask never offers an error result, a normal result still applies',
  async () => {
    const lines = journalLines();
    const prompts: string[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        prompts.push(input.prompt);
        // The retained result still occupies its pass index, so the normal row
        // is addressed by the index the table shows, not by position 1.
        const shown = Number(/^([1-9]\d*)\. \[read\]/mu.exec(input.prompt)?.[1] ?? 1);
        return { text: JSON.stringify({ [String(shown)]: { forgetall: true, summary: 'old read' } }) };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = conversation({ type: 'error', value: CANCELLED_QUESTION });
      // Step 1 carries both results; step 2 is the first eligible table.
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 0, 'the carrying request asks nothing');
      await mount.transform(sessionId, messages);
      assert.equal(prompts.length, 1, 'the step after the carrying request asks once');
      const prompt = prompts[0] ?? '';
      assert.match(prompt, /\[read\] NOTES\.md/u, 'the normal result is tabled');
      assert.doesNotMatch(prompt, /question/u, 'the cancelled question is never a table row');
      const ask = lines.of('ask')[0];
      assert.ok(ask !== undefined, 'one ask fire line was written');
      assert.equal(ask['rowCount'], 1, 'only the normal result reached the table');
      assert.equal(messages.some(message => message.id === 'msg_tq'), true,
        'the error envelope stayed in the array');
      assert.equal(messages.some(message => message.id === 'msg_tn'), false,
        'the normal tool result left the array');
      const applied = lines.of('ask-apply');
      assert.equal(applied.length, 1, 'one applied removal');
      assert.equal(applied[0]?.['applied'], true, 'the normal removal applied');
    } finally { await mount.close(); }
  });

test('1f FIX 2: a stored verdict for an error result is skipped by name and journalled',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = conversation({ type: 'error', value: CANCELLED_QUESTION });
      // Two transforms make every carried node eligible; nothing applies.
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unit = unitFor(messages, 'call_question');
      entry.askVerdicts.set(unit.id, forgetAll(unit.id));
      const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
        lines.records.push({ kind, atMs: 1, ...fields });
      };
      const before = structuredClone(messages) as OpencodeMessage[];
      const applied = await applyOpencodeAskVerdicts({
        entry, messages, snapshot: entry.port.observe(messages), window: 200_000, journal: sink,
      });
      assert.equal(applied, false, 'the error result is never applied');
      assert.deepEqual(messages, before, 'the error envelope stays in the array');
      assert.equal(entry.askVerdicts.size, 0, 'the refused verdict is dropped');
      const retained = lines.of('ask-retained');
      assert.equal(retained.length, 1, 'one retention line names the skip');
      assert.equal(retained[0]?.['code'], 'error-result-retained',
        'the skip carries its named code');
      assert.equal(retained[0]?.['unitId'], unit.id, 'the line names the unit');
      assert.equal(retained[0]?.['nodeId'], unit.nodeId, 'the line names the node');
      assert.equal(retained[0]?.['applied'], false, 'the line claims no removal');
      assert.equal(lines.of('ask-apply').length, 0, 'no apply line claims it either');
    } finally { await mount.close(); }
  });

test('1f FIX 2: the wire derivation refuses a plan naming an error result, not a normal one',
  () => {
    const messages = conversation({ type: 'error', value: CANCELLED_QUESTION });
    const plan = sealedPlanFor(messages, 'call_question', 'note-question');
    const outcome = deriveOpencodeRevert(
      removalRequest(plan, 'intent-question', 'note-question'), messages);
    assert.equal(outcome.status, 'refused', 'the plan is refused');
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.code, 'error-result-retained', 'the refusal carries the named code');
    assert.equal(outcome.reason, 'unsupported', 'the refusal names the core reason');
    assert.match(outcome.detail, /error or a cancelled-tool failure/u,
      'the detail names the failure envelope');
    // A normal tool result in the same array is still removable.
    const normal = sealedPlanFor(messages, 'call_note', 'note-normal');
    const staged = deriveOpencodeRevert(
      removalRequest(normal, 'intent-normal', 'note-normal'), messages);
    assert.equal(staged.status, 'staged', 'the normal tool result still stages');
    if (staged.status !== 'staged') return;
    assert.equal(staged.messages.some(message => message.id === 'msg_tn'), false,
      'the normal result is gone');
    assert.equal(staged.messages.some(message => message.id === 'msg_tq'), true,
      'the error envelope is still there');
  });

test('1f FIX 2: the rule covers both tags and a cancelled question, and not a real answer', () => {
  const cancelled = conversation({ type: 'error', value: CANCELLED_QUESTION });
  const jsonCancelled = conversation({
    type: 'json', value: { error: { type: 'tool.execution', message: 'cancelled' }, content: [] },
  });
  const answered = conversation({ type: 'json', value: ANSWERED_QUESTION });
  const codeFor = (messages: readonly OpencodeMessage[], callId: string): string | null => {
    const live = opencodeLiveResults(messages, sessionId);
    const verdict = opencodeRetentionOf(nodeFor(messages, callId).id, live);
    return verdict === null ? null : verdict.code;
  };
  assert.equal(codeFor(cancelled, 'call_question'), 'error-result-retained',
    'the host error tag is retained whatever the tool');
  assert.equal(codeFor(jsonCancelled, 'call_question'), 'error-result-retained',
    'a cancelled question tagged json is retained too');
  assert.equal(codeFor(answered, 'call_question'), null,
    'a real question answer is ordinary content, not a failure');
  // A normal read result is not this rule's subject.
  assert.equal(codeFor(cancelled, 'call_note'), null, 'the normal result clears the rule');
  // The tag decides, not the text: an error-valued read is retained as well.
  const readError: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read it.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall('call_read', 'read', { filePath: 'GONE.md' }),
    ]),
    toolMessage('msg_t1', [
      toolResult('call_read', 'read', errorResult('ENOENT: no such file or directory')),
    ]),
    assistantMessage('msg_a2', [text('It failed.')]),
  ];
  assert.equal(codeFor(readError, 'call_read'), 'error-result-retained',
    'an error-tagged read result is retained');
});

test('a closed-episode proof exempts exactly the error-result rule', () => {
  /*
   * ADR-0054: a closed-episode proof may remove the error result it closed.
   * The other two retention rules still refuse: the proof says the bytes are
   * absent, not that they are a restore payload or contained in a live result.
   */
  const recallMessages: OpencodeMessage[] = [
    userMessage('msg_u1', [text('Read, then restore.')]),
    assistantMessage('msg_a1', [
      text('Reading and restoring.'),
      toolCall('call_note', 'read', { filePath: 'NOTES.md' }),
      toolCall('call_recall', 'necromancy', { id: `sha256:${'a'.repeat(64)}` }),
    ]),
    toolMessage('msg_tn', [toolResult('call_note', 'read', textResult(LARGE_NOTE))]),
    toolMessage('msg_tr', [toolResult('call_recall', 'necromancy', textResult(LARGE_NOTE))]),
    assistantMessage('msg_a2', [text('Done.')]),
  ];
  const recallPlan = sealedPlanFor(recallMessages, 'call_recall', 'note-recall');
  const recall = deriveOpencodeRevert(
    removalRequest(recallPlan, 'intent-recall', 'note-recall'), recallMessages,
    new Map(), new Set([nodeFor(recallMessages, 'call_recall').id]));
  assert.equal(recall.status, 'refused', 'the recall answer stays refused');
  if (recall.status === 'refused') {
    assert.equal(recall.code, 'recall-answer-retained',
      'the closed-episode set does not bypass the recall rule');
  }
  // A contained result in the closed-episode set: containment still refuses.
  const containedMessages: OpencodeMessage[] = [
    userMessage('msg_u2', [text('Read three.')]),
    assistantMessage('msg_a3', [
      text('Reading.'),
      toolCall('call_first', 'read', { filePath: 'FIRST.md' }),
      toolCall('call_small', 'read', { filePath: 'SMALL.md' }),
      toolCall('call_big', 'read', { filePath: 'BIG.md' }),
    ]),
    toolMessage('msg_tf', [toolResult('call_first', 'read', textResult(LARGE_NOTE))]),
    toolMessage('msg_ts', [toolResult('call_small', 'read', textResult('SMALL_BODY'))]),
    toolMessage('msg_tb', [toolResult('call_big', 'read',
      textResult(`HEAD ${'big-'.repeat(200)} SMALL_BODY TAIL`))]),
    assistantMessage('msg_a4', [text('All read.')]),
  ];
  const containedPlan = sealedPlanFor(containedMessages, 'call_small', 'note-small');
  const contained = deriveOpencodeRevert(
    removalRequest(containedPlan, 'intent-small', 'note-small'), containedMessages,
    new Map(), new Set([nodeFor(containedMessages, 'call_small').id]));
  assert.equal(contained.status, 'refused', 'the contained result stays refused');
  if (contained.status === 'refused') {
    assert.equal(contained.code, 'contained-in-live-result',
      'the closed-episode set does not bypass the containment rule');
  }
  // The error result itself is the one rule the set exempts.
  const errorMessages = conversation({ type: 'error', value: CANCELLED_QUESTION });
  const errorPlan = sealedPlanFor(errorMessages, 'call_question', 'note-question');
  const error = deriveOpencodeRevert(
    removalRequest(errorPlan, 'intent-error', 'note-question'), errorMessages,
    new Map(), new Set([nodeFor(errorMessages, 'call_question').id]));
  assert.equal(error.status, 'staged',
    'an error result named by the closed-episode proof still stages');
});
