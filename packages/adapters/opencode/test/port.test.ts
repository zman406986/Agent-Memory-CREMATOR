// Port gate for the 2.4.0 message model (ISSUE-192; ADR-0015; ADR-0044). The
// port is record-only: with the shipped flags `apply` refuses every mode and
// never touches the request messages, and an unseen intent answers `unknown`
// rather than `not-applied`.
//
// Folded into three tests. The record-only gate keeps its own top-level test and
// its own name: it is the only proof here that this adapter refuses to remove
// anything it was not told to. The staging rows and the refusal rows are each one
// table, and the corpus read is the third test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyRequest, CapabilityFlags, Ledger, ValidatedRevert } from '@cremator/core';
import { revertBytes, sha256Sync, toBytes } from '@cremator/core';
import { OPENCODE_CAPABILITIES } from '../src/capabilities.js';
import type { OpencodeAppliedPlan } from '../src/apply.js';
import { deriveOpencodeRevert } from '../src/apply.js';
import type { OpencodeMessage } from '../src/host.js';
import type { OpencodeRevertDeriver, OpencodeStaging } from '../src/port.js';
import { createOpencodePort, opencodeAppliedPlansFromLedger } from '../src/port.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, minimalConversation, replayCorpus, sessionId, text, textResult, toolCall,
  toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

const clock = { nowMs: () => 1234 };

/** The array as the host built it: a fresh deep copy each call. */
function hostArray(): OpencodeMessage[] {
  return structuredClone(minimalConversation()) as OpencodeMessage[];
}

/**
 * A request whose identity fields agree. The guard brand is bypassed on purpose
 * (`as unknown as`): this suite probes the host-side answers, and the guard's own
 * suite owns the brand.
 */
function request(
  baseRevision: string, mode: ApplyRequest['application']['mode'] = 'revert',
  overrides: Partial<ApplyRequest['application']> = {}, intentId = 'intent-1',
): ApplyRequest {
  const application = {
    sessionId, eventId: 'event-1', baseRevision, phase: 'at-rest', mode,
    applicationSha256: 'application-1', replacements: [], appendRecords: [],
    archives: [], sealedEpisodeIds: [], createdAtMs: 1234, ...overrides,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId, sessionId: application.sessionId, eventId: application.eventId,
      baseRevision: application.baseRevision,
      applicationSha256: application.applicationSha256,
    },
  };
}

/** The earned pair: a declared revert seam and the derivation that honours it. */
const REVERT_CAPABILITIES: CapabilityFlags = { ...OPENCODE_CAPABILITIES, revertHistory: true };

/** Drops the last message and appends one receipt: the smallest visible derivation. */
const dropTail: OpencodeRevertDeriver = (request, messages): OpencodeStaging => {
  const id = `racoons-record:${request.intent.intentId}:0`;
  return {
    status: 'staged',
    messages: [
      ...messages.slice(0, -1),
      {
        id,
        role: 'user',
        content: [{ type: 'text', text: '[not retained] NOTES.md' }],
        [OPENCODE_RECORD_ID_FIELD]: id,
        racoonsReceiptOf: 'note-1',
        racoonsForgottenNodeId: 'oc:ses_test:tool:call_1',
      },
    ],
  };
};

/** The receipt line the guard renders; the exact bytes are the test's. */
const RESTART_RECEIPT_TEXT = '[not retained] NOTES.md · necromancy recall:sha256:'
  .concat('b'.repeat(64));

/** One approved revert over the minimal conversation, sealed the way the guard seals it. */
function restartPlan(messages: readonly OpencodeMessage[]): ValidatedRevert {
  const derived = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
  const nodes = derived.nodes;
  const cutIndex = nodes.findIndex(node => node.kind === 'tool-result');
  assert.ok(cutIndex > 0, 'the fixture has a tool result after its prompt');
  const forgotten = nodes[cutIndex];
  const previous = nodes[cutIndex - 1];
  assert.ok(forgotten !== undefined && previous !== undefined);
  const survivors = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id).map(node => node.id);
  const keptBytes = nodes.slice(cutIndex)
    .filter(node => node.id !== forgotten.id)
    .reduce((sum, node) => sum + node.byteLength, 0);
  const approved = {
    unitIds: [`unit:sha256:${'1'.repeat(64)}`],
    cutIndex,
    survivors,
    appends: [{ afterNodeId: previous.id, noteId: 'note-restart' }],
    perNode: [{ nodeId: forgotten.id, noteId: 'note-restart' }],
    cost: {
      cutIndex, freedBytes: forgotten.byteLength, keptBytes,
      receiptBytes: toBytes(RESTART_RECEIPT_TEXT).byteLength,
      netFreedBytes: forgotten.byteLength - keptBytes - toBytes(RESTART_RECEIPT_TEXT).byteLength,
    },
    baseRevision: derived.revision,
  };
  return { ...approved, planSha256: sha256Sync(revertBytes(approved)) };
}

/** One request over a sealed plan, with the intent and application naming it. */
function restartRequest(
  plan: ValidatedRevert, applicationSha256 = sha256Sync(toBytes('application:restart')),
): ApplyRequest {
  const bytes = toBytes(RESTART_RECEIPT_TEXT);
  const application = {
    sessionId, eventId: 'event-restart', baseRevision: plan.baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256, replacements: [], archives: [], sealedEpisodeIds: [],
    createdAtMs: 1,
    appendRecords: [{ recordId: 'note-restart', bytes, sha256: sha256Sync(bytes) }],
    revert: plan,
  } as unknown as ApplyRequest['application'];
  return {
    application,
    intent: {
      intentId: 'intent-restart', sessionId, eventId: 'event-restart',
      baseRevision: plan.baseRevision, applicationSha256,
    },
  };
}

/**
 * The durable rows a prior process left: the engine's prepared event (whose
 * archive sources bank the unit under its recall) and the applied receipt.
 */
function restartLedger(
  request: ApplyRequest, forgottenNodeId: string, recallId: string,
): Ledger {
  const intentId = request.intent.intentId;
  const prepared = {
    kind: 'prepared', sessionId, eventKey: `prepared:${intentId}`, atMs: 1,
    intentId, applicationSha256: request.application.applicationSha256,
    engine: {
      intent: { ...request.intent }, sealedEpisodeIds: [], removedBytes: 1, generatedBytes: 1,
      recallIds: [recallId], sources: [{ source: { nodeId: forgottenNodeId }, recallId }],
      noticeRecordId: null,
    },
  };
  const applied = {
    kind: 'applied', sessionId, eventKey: `applied:${intentId}`, atMs: 2,
    receipt: {
      intentId, sessionId, baseRevision: request.application.baseRevision,
      resultRevision: 'oc:restart:result', applicationSha256: request.application.applicationSha256,
      appliedAtMs: 2,
    },
  };
  let sequence = 0;
  return {
    prepare: () => Promise.reject(new Error('the seed only reads events')),
    append: () => Promise.reject(new Error('the seed only reads events')),
    events: async function* () {
      yield { sequence: sequence += 1, event: prepared as never };
      yield { sequence: sequence += 1, event: applied as never };
    },
    recall: () => Promise.reject(new Error('the seed only reads events')),
    close: () => Promise.resolve(),
  };
}

test('snapshot() carries the corpus derivation, with the corpus\'s own counts', async () => {
  const corpus = replayCorpus();
  const messages = corpus.messages;
  const port = createOpencodePort({ sessionId: corpus.sessionId, clock, messages });
  const snapshot = await port.snapshot();
  assert.equal(snapshot.sessionId, corpus.sessionId);
  assert.equal(snapshot.nodes.length, corpus.meta.counts.nodes);
  assert.equal(snapshot.nodes.length, 8);
  assert.match(snapshot.revision, new RegExp(`^oc:${String(messages.length)}:[0-9a-f]{64}$`));
  assert.equal(snapshot.nodes.filter(node => node.kind === 'racoons-record').length, 0);
  for (const node of snapshot.nodes) {
    assert.ok(node.id.startsWith(`oc:${corpus.sessionId}:`), `${node.id} is not host-keyed`);
  }
  // ISSUE-522: the port adds the per-path coverage rows the engine plans against
  // (`CoverageMeter`), so every other field still equals the raw derivation.
  const { pathCoverage, ...rest } = snapshot;
  assert.deepEqual(rest, deriveOpencodeSnapshot(messages, { sessionId: corpus.sessionId }).snapshot);
  assert.ok(pathCoverage !== undefined && pathCoverage.length > 0,
    'the snapshot carries per-path coverage rows');
  for (const row of pathCoverage) {
    assert.equal(typeof row.pathKey, 'string');
    assert.equal(row.bytes, row.hitBytes + row.missBytes + row.unknownBytes);
  }

  const minimal = createOpencodePort({ sessionId, clock, messages: hostArray() });
  const small = await minimal.snapshot();
  // One prompt, one text node, one tool unit, one closing answer.
  assert.equal(small.nodes.length, 4);
  assert.match(small.revision, /^oc:4:[0-9a-f]{64}$/);
});

test('a revert is refused unsupported while revertHistory is false — the record-only gate', async () => {
  const messages = hostArray();
  const port = createOpencodePort({ sessionId, clock, messages });
  const untouched = structuredClone(messages);
  const base = (await port.snapshot()).revision;
  assert.equal(OPENCODE_CAPABILITIES.revertHistory, false);
  for (const mode of ['revert', 'append', 'entry', 'rewrite', 'rehydrate'] as const) {
    assert.deepEqual(await port.apply(request(base, mode)), {
      status: 'not-applied', reason: 'unsupported',
    }, `the ${mode} mode is refused by the record-only gate`);
  }
  assert.deepEqual(messages, untouched, 'a refusal leaves the request byte-identical');
  assert.equal(port.commit(), false, 'a refusal stages nothing to commit');
});

/**
 * The staging rows — one rule each about the stage's lifetime: what a refusal
 * reports, what a throw becomes, when a stage is dropped, and how one plan
 * renders one array exactly once.
 */
const STAGING_ROWS: readonly Row[] = [
  { name: 'apply stages invisibly and commit mutates the request messages exactly once',
    async run(at) {
      const messages = hostArray();
      const hostRef = messages;
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
      });
      const before = await port.snapshot();
      const untouched = structuredClone(messages);
      const originalIds = messages.map(message => message.id);

      const result = await port.apply(request(before.revision));
      assert.equal(result.status, 'applied', at('the derivation stages'));
      assert.deepEqual(hostRef, untouched, at('apply left the messages untouched'));
      assert.deepEqual(hostRef.map(message => message.id), originalIds, at('the order is unchanged'));
      assert.deepEqual(await port.snapshot(), before, at('the snapshot follows the array, not the stage'));

      assert.equal(port.commit(), true, at('the first commit lands'));
      const staged = await port.snapshot();
      assert.notDeepEqual(hostRef.map(message => message.id), originalIds,
        at('the commit changed the ids through the host handle'));
      assert.equal(hostRef.at(-1)?.id, 'racoons-record:intent-1:0', at('the receipt message is last'));
      assert.equal(hostRef.length, originalIds.length, at('one removed, one appended'));
      assert.equal(hostRef.at(-1)?.[OPENCODE_RECORD_ID_FIELD], 'racoons-record:intent-1:0',
        at('the receipt carries the record marker'));
      assert.equal(port.commit(), false, at('the second commit stages nothing'));
      assert.deepEqual(await port.snapshot(), staged, at('the second commit left the messages alone'));
    } },
  { name: 'repeating an intent returns one frozen receipt and never stages a second rendering',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
      });
      const base = (await port.snapshot()).revision;
      const [first, second] = await Promise.all([port.apply(request(base)), port.apply(request(base))]);
      assert.equal(first.status, 'applied', at('the first call applies'));
      assert.equal(second.status, 'applied', at('the concurrent call applies'));
      if (first.status !== 'applied' || second.status !== 'applied') throw new Error(at('apply refused'));
      assert.equal(first.receipt, second.receipt, at('one receipt object, not two equal copies'));
      assert.equal(Object.isFrozen(first.receipt), true, at('the receipt is frozen'));
      assert.equal(port.commit(), true, at('the one stage commits'));
      assert.equal((await port.snapshot()).revision, first.receipt.resultRevision,
        at('the committed messages carry the receipt\'s result revision'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), first, at('the intent is on record'));
      assert.deepEqual(await port.apply(request(base)), first, at('the replay answers the same receipt'));
      assert.equal(port.commit(), false, at('the replay stages nothing'));
      assert.deepEqual(await port.apply(request(base, 'revert', { applicationSha256: 'other' })), {
        status: 'not-applied', reason: 'host-error',
      }, at('one intent id with a different plan is a host error'));
    } },
  { name: 'a second intent while one is staged is refused, and the commit clears the slot',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
      });
      const base = (await port.snapshot()).revision;
      assert.equal((await port.apply(request(base))).status, 'applied', at('the first intent stages'));
      assert.deepEqual(await port.apply(request(base, 'revert', {}, 'intent-2')), {
        status: 'not-applied', reason: 'host-error',
      }, at('a second intent while one is staged is refused'));
      assert.equal(port.commit(), true, at('the first derivation commits'));
      assert.equal(messages.at(-1)?.id, 'racoons-record:intent-1:0', at('the receipt landed'));
      assert.deepEqual(await port.lookupReceipt('intent-2'), { status: 'unknown' },
        at('the refused intent left no receipt'));
      const next = (await port.snapshot()).revision;
      assert.equal((await port.apply(request(next, 'revert', {}, 'intent-2'))).status, 'applied',
        at('the cleared slot accepts the next plan'));
      assert.equal(port.commit(), true, at('the second commit lands'));
      // The first commit had already replaced the closing answer with a receipt;
      // the second replaces that receipt. The length stays four.
      assert.equal(messages.at(-1)?.id, 'racoons-record:intent-2:0',
        at('the second receipt is last'));
      assert.equal(messages.length, 4, at('each commit replaced one message with one receipt'));
    } },
  { name: 'a derivation refusal is reported with its own reason and stages nothing',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES,
        deriveRevert: () => ({ status: 'refused', reason: 'stale-revision', detail: 'node-missing' }),
      });
      const before = await port.snapshot();
      assert.deepEqual(await port.apply(request(before.revision)), {
        status: 'not-applied', reason: 'stale-revision',
      }, at('the derivation\'s own reason is the port\'s answer'));
      assert.equal(port.commit(), false, at('a refused derivation stages nothing'));
      assert.deepEqual(await port.snapshot(), before, at('the snapshot is unchanged'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a refusal is not a receipt'));
    } },
  { name: 'a staged intent is not on record until its commit lands',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
      });
      const base = (await port.snapshot()).revision;
      const staged = await port.apply(request(base));
      assert.equal(staged.status, 'applied', at('the derivation stages'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a staged receipt is not a host record yet'));
      assert.equal(port.lastCommitKind(), null, at('nothing has spliced yet'));
      assert.equal(port.commit(), true, at('the commit lands the stage'));
      assert.equal(port.lastCommitKind(), 'applied',
        at('the landed commit names a plan application'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), staged,
        at('the committed receipt is the host record'));
    } },
  { name: 'a refused derivation can stage its stale-receipt cleanup and still answers not applied',
    async run(at) {
      const messages = hostArray();
      const receiptId = 'racoons-record:intent-1:0';
      const cleaned = [
        ...messages.slice(0, -1),
        {
          id: 'msg_clean', role: 'user', content: [{ type: 'text', text: 'kept answer' }],
        } as OpencodeMessage,
      ];
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES,
        deriveRevert: () => ({
          status: 'refused', reason: 'host-error', code: 'intent-conflict',
          detail: `receipt ${receiptId} names a node this array can read again`,
          cleanup: cleaned,
        }),
      });
      const base = (await port.snapshot()).revision;
      assert.deepEqual(await port.apply(request(base)), {
        status: 'not-applied', reason: 'host-error',
      }, at('a cleanup refusal is never an applied receipt'));
      assert.deepEqual(port.refusal(), {
        reason: 'host-error', code: 'intent-conflict',
        detail: `receipt ${receiptId} names a node this array can read again`,
      }, at('the refusal keeps its own code and detail'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a cleanup mints no receipt'));
      assert.equal(port.commit(), true, at('the cleanup still commits onto the array'));
      assert.equal(port.lastCommitKind(), 'cleanup',
        at('the landed splice is named a cleanup, not an application'));
      assert.deepEqual(messages, cleaned, at('the stale marker left the array'));
      assert.equal(port.commit(), false, at('the cleanup commits once'));
      assert.equal(port.lastCommitKind(), null,
        at('the no-op second commit names nothing new'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('the cleanup is not an application'));
    } },
  { name: 'a derivation that throws is a definite refusal, never a claimed application',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES,
        deriveRevert: () => { throw new Error('split pair'); },
      });
      const before = await port.snapshot();
      assert.deepEqual(await port.apply(request(before.revision)), {
        status: 'not-applied', reason: 'host-error',
      }, at('a thrown derivation is a host error'));
      assert.equal(port.commit(), false, at('a thrown derivation stages nothing'));
      assert.deepEqual(await port.snapshot(), before, at('the snapshot is unchanged'));
    } },
  { name: 'observe drops a stage derived from an array the host has already replaced',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({
        sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
      });
      const base = (await port.snapshot()).revision;
      assert.equal((await port.apply(request(base))).status, 'applied', at('the stage exists'));
      const next = hostArray();
      port.observe(next);
      assert.equal(port.commit(), false, at('the stale stage was dropped'));
      assert.equal(next.length, hostArray().length, at('the next array keeps its length'));
      assert.equal(next.at(-1)?.id, 'msg_a2', at('the next array keeps its own tail'));
    } },
];

/**
 * The refusal rows — what the port refuses, and what it never claims to know.
 */
const REFUSAL_ROWS: readonly Row[] = [
  { name: 'an intent this process never saw answers unknown, never not-applied',
    async run(at) {
      const port = createOpencodePort({ sessionId, clock, messages: hostArray() });
      assert.deepEqual(await port.lookupReceipt('intent-never-seen'), { status: 'unknown' },
        at('an unseen intent is unknown'));
      const base = (await port.snapshot()).revision;
      assert.deepEqual(await port.apply(request(base)), { status: 'not-applied', reason: 'unsupported' },
        at('the shipped flags refuse the revert'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a refusal does not make the intent known'));
      const fresh = createOpencodePort({ sessionId, clock, messages: hostArray() });
      assert.deepEqual(await fresh.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a fresh process has no record of the intent'));
    } },
  { name: 'a stale revision refuses before any mode is considered, and the messages keep every byte',
    async run(at) {
      const messages = hostArray();
      const port = createOpencodePort({ sessionId, clock, messages });
      const before = await port.snapshot();
      const untouched = structuredClone(messages);
      assert.deepEqual(await port.apply(request('oc:4:000000000000')), {
        status: 'not-applied', reason: 'stale-revision',
      }, at('a stale revision is refused'));
      assert.deepEqual(await port.apply(request('oc:4:000000000000', 'append')), {
        status: 'not-applied', reason: 'stale-revision',
      }, at('the stale check runs before the mode check'));
      assert.deepEqual(messages, untouched, at('the messages keep every byte'));
      assert.deepEqual(await port.snapshot(), before, at('the snapshot is unchanged'));
      assert.deepEqual(await port.lookupReceipt('intent-1'), { status: 'unknown' },
        at('a stale refusal leaves no receipt'));
    } },
  { name: 'the flag and its derivation cannot exist without each other',
    run(at) {
      assert.throws(() => createOpencodePort({
        sessionId, clock, messages: hostArray(), deriveRevert: dropTail,
      }), /needs `revertHistory: true`/u, at('a derivation without the flag throws'));
      assert.throws(() => createOpencodePort({
        sessionId, clock, messages: hostArray(), capabilities: REVERT_CAPABILITIES,
      }), /needs the derivation that honours it/u, at('a flag without a derivation throws'));
      assert.doesNotThrow(() => createOpencodePort({ sessionId, clock, messages: hostArray() }),
        at('the shipped shape constructs'));
    } },
];

test('staging and refusals: the committed messages, the receipt, and every refusal by name',
  async () => {
    await runRows(STAGING_ROWS);
    await runRows(REFUSAL_ROWS);
  });

test('the applied-plan index records the recall ids and unit node ids a pass applied',
  async () => {
    const messages = hostArray();
    const base = (await createOpencodePort({ sessionId, clock, messages })
      .snapshot()).revision;
    const noteId = 'racoons:00000000000000a1';
    const recallId = `recall:sha256:${'b'.repeat(64)}`;
    const bytes = new TextEncoder().encode(
      `[not retained] NOTES.md · necromancy ${recallId}`);
    const unitNodeId = `oc:${sessionId}:tool:call_1`;
    // The guard brand is bypassed on purpose: this test probes what the port
    // records, and the guard's suite owns the plan's validity.
    const revert = {
      unitIds: [`unit:sha256:${'1'.repeat(64)}`],
      cutIndex: 0,
      survivors: [`oc:${sessionId}:msg:msg_u1`],
      appends: [{ afterNodeId: null, noteId }],
      perNode: [{ nodeId: unitNodeId, noteId }],
      cost: { cutIndex: 0, freedBytes: 1, keptBytes: 0, receiptBytes: bytes.length,
        netFreedBytes: 0 },
      baseRevision: base,
      planSha256: `sha256:${'2'.repeat(64)}`,
    } as unknown as ValidatedRevert;
    const application = {
      revert,
      appendRecords: [{ recordId: noteId, bytes, sha256: sha256Sync(bytes) }],
    };
    const captured: Map<string, OpencodeAppliedPlan>[] = [];
    const capture: OpencodeRevertDeriver = (request, array, index) => {
      captured.push(new Map(index));
      return dropTail(request, array, index);
    };
    const port = createOpencodePort({
      sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: capture,
    });
    const first = request(base, 'revert', application, 'intent-index-1');
    assert.equal((await port.apply(first)).status, 'applied', 'the first pass stages');
    assert.equal(port.commit(), true, 'the first pass commits');
    assert.deepEqual([...(captured[0]?.keys() ?? [])], [],
      'the first pass has no earlier row to read');

    // A second pass over the host's rebuilt array sees the first pass's row.
    const rebuilt = hostArray();
    port.observe(rebuilt);
    const second = request(base, 'revert', application, 'intent-index-2');
    assert.equal((await port.apply(second)).status, 'applied', 'the second pass stages');
    assert.equal(port.commit(), true, 'the second pass commits');
    const row = captured[1]?.get('intent-index-1');
    assert.ok(row !== undefined, 'the second derivation reads the first pass\'s row');
    assert.deepEqual(row.receipts, [noteId], 'the row still records the per-application note id');
    assert.deepEqual(row.recalls, [recallId],
      'the row records the recall id the receipt names');
    assert.deepEqual(row.forgotten, [unitNodeId],
      'the row records the unit node id the pass removed');
    assert.equal(row.planSha256, revert.planSha256, 'the row records the plan digest');
    assert.deepEqual(row.survivors, [...revert.survivors],
      'the row records the survivors the restore epoch reads');
  });

test('the applied-plan index records a row only when commit splices an application',
  async () => {
    // A staged plan is not banked: the row rides the stage and lands only after
    // the caller's array received the splice (ISSUE-262 item 3).
    const messages = hostArray();
    const port = createOpencodePort({
      sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
    });
    const base = (await port.snapshot()).revision;
    assert.equal((await port.apply(request(base, 'revert', {}, 'intent-staged'))).status, 'applied',
      'the plan stages');
    assert.deepEqual([...port.appliedPlanIndex().keys()], [],
      'a staged plan is not in the applied index yet');
    assert.equal(port.commit(), true, 'the commit splices');
    assert.deepEqual([...port.appliedPlanIndex().keys()], ['intent-staged'],
      'the spliced application is recorded');

    // A stage the host replaces before commit is dropped, never banked.
    const dropped = createOpencodePort({
      sessionId, clock, messages: hostArray(), capabilities: REVERT_CAPABILITIES,
      deriveRevert: dropTail,
    });
    const droppedBase = (await dropped.snapshot()).revision;
    assert.equal((await dropped.apply(request(droppedBase, 'revert', {}, 'intent-dropped'))).status,
      'applied', 'the first plan stages');
    dropped.observe(hostArray());
    assert.equal(dropped.commit(), false, 'the replaced stage commits nothing');
    assert.deepEqual([...dropped.appliedPlanIndex().keys()], [],
      'a dropped stage never becomes a banked row');

    // A plan whose derivation leaves the same array commits nothing.
    const noOp = createOpencodePort({
      sessionId, clock, messages: hostArray(), capabilities: REVERT_CAPABILITIES,
      deriveRevert: (_request, array) => ({ status: 'staged', messages: array }),
    });
    const noOpBase = (await noOp.snapshot()).revision;
    assert.equal((await noOp.apply(request(noOpBase, 'revert', {}, 'intent-noop'))).status,
      'applied', 'the no-op derivation stages');
    assert.equal(noOp.commit(), false, 'an unchanged array is not spliced');
    assert.deepEqual([...noOp.appliedPlanIndex().keys()], [],
      'a stage that spliced nothing is not banked');

    // A cleanup refusal splices but applies nothing, so it records no row.
    const cleanup = createOpencodePort({
      sessionId, clock, messages: hostArray(), capabilities: REVERT_CAPABILITIES,
      deriveRevert: (_request, array) => ({
        status: 'refused', reason: 'host-error', code: 'intent-conflict',
        detail: 'the stale receipt is dropped', cleanup: array.slice(0, -1),
      }),
    });
    const cleanupBase = (await cleanup.snapshot()).revision;
    assert.deepEqual(await cleanup.apply(request(cleanupBase, 'revert', {}, 'intent-cleanup')), {
      status: 'not-applied', reason: 'host-error',
    }, 'the cleanup is a refusal');
    assert.equal(cleanup.commit(), true, 'the cleanup still splices');
    assert.deepEqual([...cleanup.appliedPlanIndex().keys()], [],
      'a cleanup splice is not an application');
  });

test('ISSUE-354: a commit that cannot land keeps its stage and claims no removal', async () => {
  // A splice throw under a filed receipt: the stage survives for a retry, the
  // failure is named on the refusal surface, and neither the receipt lookup
  // nor the applied index claims a removal the array never carried.
  const messages = hostArray();
  const port = createOpencodePort({
    sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
  });
  const base = (await port.snapshot()).revision;
  const req = request(base, 'revert', {}, 'intent-throw');
  assert.equal((await port.apply(req)).status, 'applied', 'the plan stages');
  const realSplice = messages.splice.bind(messages) as
    (start: number, deleteCount: number, ...items: OpencodeMessage[]) => OpencodeMessage[];
  let spliceCalls = 0;
  messages.splice = ((start: number, deleteCount?: number, ...items: OpencodeMessage[]) => {
    spliceCalls += 1;
    if (spliceCalls === 1) throw new TypeError('the host array is frozen');
    return realSplice(start, deleteCount ?? messages.length - start, ...items);
  }) as typeof messages.splice;
  assert.throws(() => port.commit(), /the host array is frozen/u,
    'a thrown splice propagates as the engine\'s unproved signal, not a silent loss');
  assert.equal(port.refusal()?.code, 'commit-failed', 'the refusal names the failed commit');
  assert.deepEqual(await port.lookupReceipt('intent-throw'), { status: 'unknown' },
    'the filed receipt claims no removal before the splice lands');
  assert.deepEqual([...port.appliedPlanIndex().keys()], [],
    'no applied row outlives the failed commit');
  assert.equal((await port.apply(req)).status, 'applied',
    'the stage survives the throw: the same intent replays as still staged');
  assert.equal(port.commit(), true, 'a retry commits the kept stage');
  assert.equal((await port.lookupReceipt('intent-throw')).status, 'applied',
    'the landed retry is the host record');
  assert.deepEqual([...port.appliedPlanIndex().keys()], ['intent-throw'],
    'the row lands only with the splice that carried it');

  // A frozen host array: the same named refusal, and every byte stays.
  const frozen = hostArray();
  Object.freeze(frozen);
  const frozenPort = createOpencodePort({
    sessionId, clock, messages: frozen, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
  });
  const frozenBase = (await frozenPort.snapshot()).revision;
  const frozenReq = request(frozenBase, 'revert', {}, 'intent-frozen');
  assert.equal((await frozenPort.apply(frozenReq)).status, 'applied', 'the frozen array stages');
  assert.throws(() => frozenPort.commit(), 'the frozen array refuses the splice');
  assert.equal(frozenPort.refusal()?.code, 'commit-failed', 'the frozen refusal is named');
  assert.deepEqual(await frozenPort.lookupReceipt('intent-frozen'), { status: 'unknown' },
    'the frozen refusal claims no removal');
  assert.equal(frozen.length, hostArray().length, 'the frozen array keeps every byte');
  assert.equal((await frozenPort.apply(frozenReq)).status, 'applied',
    'the stage survives the frozen refusal for a retry');

  // A concurrent observe of the SAME array (the idle seam during an engine
  // await) keeps the pending stage; only a replaced array drops it.
  const kept = hostArray();
  const keptPort = createOpencodePort({
    sessionId, clock, messages: kept, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
  });
  const keptBase = (await keptPort.snapshot()).revision;
  assert.equal((await keptPort.apply(request(keptBase, 'revert', {}, 'intent-kept'))).status,
    'applied', 'the stage exists before the concurrent observe');
  keptPort.observe(kept);
  assert.equal(keptPort.commit(), true, 'a same-array observe keeps the pending stage');
  assert.equal((await keptPort.lookupReceipt('intent-kept')).status, 'applied',
    'the kept stage commits into a host record');

  // A replaced array drops the stage under a NAMED refusal, never silently.
  const replaced = hostArray();
  const replacedPort = createOpencodePort({
    sessionId, clock, messages: replaced, capabilities: REVERT_CAPABILITIES,
    deriveRevert: dropTail,
  });
  const replacedBase = (await replacedPort.snapshot()).revision;
  assert.equal((await replacedPort.apply(request(replacedBase, 'revert', {}, 'intent-replaced')))
    .status, 'applied', 'the stage exists before the replacement');
  replacedPort.observe(hostArray());
  assert.equal(replacedPort.commit(), false, 'the replaced stage commits nothing');
  assert.equal(replacedPort.refusal()?.code, 'stage-dropped',
    'the drop under a filed receipt is named, not silent');
  assert.deepEqual(await replacedPort.lookupReceipt('intent-replaced'), { status: 'unknown' },
    'the dropped stage claims no removal');
  assert.deepEqual([...replacedPort.appliedPlanIndex().keys()], [],
    'the dropped stage banks no row');

  // A host append between apply and commit survives the splice: the commit
  // replaces the prefix the derivation was staged from, not the whole array.
  const grown = hostArray();
  const grownPort = createOpencodePort({
    sessionId, clock, messages: grown, capabilities: REVERT_CAPABILITIES, deriveRevert: dropTail,
  });
  const grownBase = (await grownPort.snapshot()).revision;
  assert.equal((await grownPort.apply(request(grownBase, 'revert', {}, 'intent-append'))).status,
    'applied', 'the derivation stages against the pre-append array');
  grown.push(userMessage('msg_u2', [text('One more thing.')]));
  assert.equal(grownPort.commit(), true, 'the commit lands over the appended array');
  assert.deepEqual(grown.map(message => message.id),
    ['msg_u1', 'msg_a1', 'msg_t1', 'racoons-record:intent-append:0', 'msg_u2'],
    'the host append survives the splice; the staged prefix is replaced');
});

test('the applied-plan row persists the rendered receipt text per recall id', async () => {
  const messages = hostArray();
  const base = (await createOpencodePort({ sessionId, clock, messages })
    .snapshot()).revision;
  const noteId = 'racoons:00000000000000a2';
  const recallId = `recall:sha256:${'c'.repeat(64)}`;
  const line = `[not retained] NOTES.md · necromancy ${recallId}`;
  const rendered = `[not retained] NOTES.md · pass intent:render · necromancy ${recallId}`;
  const bytes = new TextEncoder().encode(line);
  const unitNodeId = `oc:${sessionId}:tool:call_1`;
  const revert = {
    unitIds: [`unit:sha256:${'1'.repeat(64)}`],
    cutIndex: 0,
    survivors: [`oc:${sessionId}:msg:msg_u1`],
    appends: [{ afterNodeId: null, noteId }],
    perNode: [{ nodeId: unitNodeId, noteId }],
    cost: { cutIndex: 0, freedBytes: 1, keptBytes: 0, receiptBytes: bytes.length,
      netFreedBytes: 0 },
    baseRevision: base,
    planSha256: `sha256:${'2'.repeat(64)}`,
  } as unknown as ValidatedRevert;
  const application = {
    revert,
    appendRecords: [{ recordId: noteId, bytes, sha256: sha256Sync(bytes) }],
  };
  const captured: Map<string, OpencodeAppliedPlan>[] = [];
  // The derivation's own rendered line rides into the port; the port's row is
  // where a later pass reads it when its array carries no receipt. The stage
  // drops one message so `commit()` splices and the row is recorded.
  const derive: OpencodeRevertDeriver = (_request, array) => ({
    status: 'staged',
    messages: array.slice(0, -1),
    receiptTexts: new Map([[recallId, rendered]]),
  });
  const capture: OpencodeRevertDeriver = (request, array, index) => {
    captured.push(new Map(index));
    return derive(request, array, index);
  };
  const port = createOpencodePort({
    sessionId, clock, messages, capabilities: REVERT_CAPABILITIES, deriveRevert: capture,
  });
  assert.equal((await port.apply(request(base, 'revert', application, 'intent-row-1'))).status,
    'applied', 'the first pass stages');
  port.commit();
  port.observe(hostArray());
  assert.equal((await port.apply(request(base, 'revert', application, 'intent-row-2'))).status,
    'applied', 'the second pass stages');
  const row = captured[1]?.get('intent-row-1');
  assert.ok(row !== undefined, 'the second derivation reads the first pass\'s row');
  assert.ok(row.receiptTexts !== undefined, 'the row carries the rendered receipt text');
  assert.equal(row.receiptTexts.get(recallId), rendered,
    'the exact line is persisted, keyed by the recall id');
  assert.deepEqual(row.recalls, [recallId],
    'the recall id still keys the row and its rendered text');
});

test('a ledger-seeded row replays the same intent after a restart without a false intent-conflict',
  async () => {
    const messages = structuredClone(minimalConversation()) as OpencodeMessage[];
    const plan = restartPlan(messages);
    const request = restartRequest(plan);
    const forgotten = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
      .find(node => node.kind === 'tool-result');
    assert.ok(forgotten !== undefined, 'the fixture holds one tool result');
    const recallId = `recall:sha256:${'b'.repeat(64)}`;
    const seeded = await opencodeAppliedPlansFromLedger(
      restartLedger(request, forgotten.id, recallId), sessionId);
    assert.equal(seeded.length, 1, 'the ledger seeds one applied row');
    assert.equal(seeded[0]?.planSha256, '',
      'the seeded row does not pass the application digest off as the plan digest');
    assert.equal(seeded[0]?.applicationSha256, request.application.applicationSha256,
      'the seeded row names the application its intent was keyed by');
    assert.deepEqual(seeded[0]?.forgotten, [forgotten.id],
      'the seeded row still banks the unit under its recall');
    assert.deepEqual(seeded[0]?.recalls, [recallId]);

    const restarted = structuredClone(minimalConversation()) as OpencodeMessage[];
    const port = createOpencodePort({
      sessionId, clock, messages: restarted, capabilities: REVERT_CAPABILITIES,
      deriveRevert: deriveOpencodeRevert, appliedPlans: seeded,
    });
    const replay = await port.apply(request);
    assert.equal(replay.status, 'applied',
      'the same intent replays against the seeded row without a false intent-conflict');
    assert.equal(port.refusal(), null, 'the replay names no refusal');
    assert.equal(port.commit(), true, 'the replay commits onto the restarted array');
    assert.equal(restarted.some(message => message.id === 'msg_t1'), false,
      'the replayed removal left the request');
    assert.equal(port.appliedPlanIndex().get(request.intent.intentId)?.planSha256,
      plan.planSha256,
      'the reconciled row records the approved plan digest, like a live row');

    // Non-vacuity: a different application under the same intent is still a
    // conflict, so the replay path does not accept every plan it is handed.
    const other = createOpencodePort({
      sessionId, clock, messages: structuredClone(minimalConversation()) as OpencodeMessage[],
      capabilities: REVERT_CAPABILITIES, deriveRevert: deriveOpencodeRevert,
      appliedPlans: seeded,
    });
    const different = await other.apply(
      restartRequest(plan, sha256Sync(toBytes('application:other'))));
    assert.deepEqual(different, { status: 'not-applied', reason: 'host-error' },
      'a different application under the seeded intent is refused');
    assert.equal(other.refusal()?.code, 'intent-conflict',
      'the refusal is the derivation\'s own one-intent-one-plan class');
  });
