// Mount gate for the 2.4.0 seams (ISSUE-192; plan §2; ADR-0017; ADR-0043).
//
// The mount's whole job is the seam wiring, so every test here drives the hooks
// the way the host does — a context hook over the request's own messages, an
// event stream for idle/usage/compaction, an after-result observation — against
// the real engine and a real ledger in a tmp directory. No opencode binary, no
// API key, no live call.
//
// Folded into three tests. The hook rows own what each seam writes and with what
// reason; the accounting rows own the step-ended reconciliation and the estimate;
// the registration rows own the tool set and the test's subagent-off setting.
// Every assertion names its row, so a red run says which seam broke.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG, ENTRY_ASK_END_ANCHOR,
  CharHeuristicTokenMeter, Meter, UnitTracker, revertBytes, sha256Sync, toBytes,
} from '@cremator/core';
import type {
  ApplyRequest, ApplyResult, Ledger, LedgerEvent, ValidatedRevert, WireAnswer,
} from '@cremator/core';
import {
  OPENCODE_FORGOTTEN_NODE_FIELD, OPENCODE_RECEIPT_OF_FIELD, deriveOpencodeRevert,
  opencodeReceiptEntryId, opencodeReceiptTextWithPass,
} from '../src/apply.js';
import type { OpencodeAppliedPlanIndex } from '../src/apply.js';
import { createOpencodeCapabilities } from '../src/capabilities.js';
import { buildOpencodeAskBatch } from '../src/ask.js';
import { MOUNT_STATE_FILE, readDurableAskState } from '../src/mount-state.js';
import type {
  OpencodeAfterToolInput, OpencodeGenerateInput,
  OpencodeHostEvent, OpencodeIdleHookInput, OpencodeMessage, OpencodePluginContext,
  OpencodeSessionContext, OpencodeToolDefinition, OpencodeToolResultValue,
} from '../src/host.js';
import {
  OPENCODE_SUBAGENT_TOOL, OPENCODE_TEST_EXCLUDE_TOOLS,
  appliedRewritesAt, applyOpencodeAskVerdicts, createOpencodeMount, createOpencodePlugin,
  mountOptionsFromHost, opencodeAskStanddown, releaseCancelledUnits,
} from '../src/plugin.js';
import type {
  OpencodeJournalKind, OpencodeJournalRecord, OpencodeMountPort,
} from '../src/plugin.js';
import { estimateRequestTokens, requestPrefixOf } from '../src/meter.js';
import type { OpencodePortOptions } from '../src/port.js';
import { createOpencodePort } from '../src/port.js';
import type { OpencodeStaging } from '../src/port.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot, opencodeToolNodeId } from '../src/snapshot.js';
import { openLedger, resolveStorage, sessionStorage } from '../src/storage.js';
import {
  assistantMessage, errorResult, minimalConversation, sessionContext, sessionId, text,
  textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-plugin-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

/** A fresh host array each call, like the per-request rebuild the host performs. */
function hostMessages(): OpencodeMessage[] {
  return structuredClone(minimalConversation()) as OpencodeMessage[];
}

/** One receipt line the guard renders; the recall id is archive-shaped, the bytes are the test's. */
const STALE_RECEIPT_TEXT = '[not retained] NOTES.md · necromancy recall:sha256:'
  .concat('a'.repeat(64));

/** The node the fixture's plan forgets: its one read result. */
function fixtureForgottenNodeId(messages: readonly OpencodeMessage[]): string {
  const node = deriveOpencodeSnapshot(messages, { sessionId }).snapshot.nodes
    .find(candidate => candidate.kind === 'tool-result');
  assert.ok(node !== undefined, 'the fixture holds one tool result');
  return node.id;
}

/** One revert plan sealed the way the guard seals it, over the array it is handed. */
function sealedRemoval(
  messages: readonly OpencodeMessage[], noteId: string, receiptText: string,
): ValidatedRevert {
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
    appends: [{ afterNodeId: previous.id, noteId }],
    perNode: [{ nodeId: forgotten.id, noteId }],
    cost: {
      cutIndex, freedBytes: forgotten.byteLength, keptBytes,
      receiptBytes: toBytes(receiptText).byteLength,
      netFreedBytes: forgotten.byteLength - keptBytes - toBytes(receiptText).byteLength,
    },
    baseRevision: derived.revision,
  };
  return { ...approved, planSha256: sha256Sync(revertBytes(approved)) };
}

/** One request around a plan the test sealed, with one receipt record. */
function removalRequest(
  plan: ValidatedRevert, intentId: string, noteId: string, receiptText: string,
): ApplyRequest {
  const bytes = toBytes(receiptText);
  const application = {
    sessionId, eventId: 'event-1', baseRevision: plan.baseRevision, phase: 'at-rest',
    mode: 'revert', applicationSha256: sha256Sync(toBytes(`application:${intentId}`)),
    replacements: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1234,
    appendRecords: [{ recordId: noteId, bytes, sha256: sha256Sync(bytes) }],
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

/** The receipt message a plan rendered, in the host's 2.4.0 shape. */
function receiptMessageFor(
  intentId: string, noteId: string, text: string, forgottenNodeId: string,
): OpencodeMessage {
  const id = opencodeReceiptEntryId(intentId, 0);
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    [OPENCODE_RECORD_ID_FIELD]: id,
    [OPENCODE_RECEIPT_OF_FIELD]: noteId,
    [OPENCODE_FORGOTTEN_NODE_FIELD]: forgottenNodeId,
  };
}

/**
 * One result at the product floor's side: the ask tables only units of at least
 * `DEFAULT_CONFIG.protocol.barBytes` (512) bytes, so a small fixture proves
 * nothing about the ask.
 */
function largeHostMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a_small', [
      text('Reading SMALL.md.'),
      toolCall('call_small', 'read', { filePath: 'SMALL.md' }),
    ]),
    toolMessage('msg_t_small', [toolResult('call_small', 'read', textResult('tiny'))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

/** Four independent large results: one apply that removes four units. */
function fourUnitHostMessages(): OpencodeMessage[] {
  const messages: OpencodeMessage[] = [userMessage('msg_u_four', [text('Read all four.')])];
  for (let unit = 1; unit <= 4; unit += 1) {
    const call = `call_four_${String(unit)}`;
    messages.push(assistantMessage(`msg_a_four_${String(unit)}`, [
      toolCall(call, 'read', { filePath: `FOUR_${String(unit)}.md` }),
    ]));
    messages.push(toolMessage(`msg_t_four_${String(unit)}`, [toolResult(call, 'read',
      textResult(`# Note ${String(unit)}\n\n${`body${String(unit)}-`.repeat(120)}\n`))]));
  }
  messages.push(assistantMessage('msg_a_four_end', [text('Read them all.')]));
  return messages;
}

/** Two independent large results: a multi-row table in one ask. */
function largeTwoResultMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(`# Note\n\n${'alpha-'.repeat(120)}\n`))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'),
      toolCall('call_2', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(`# Other\n\n${'bravo-'.repeat(120)}\n`))]),
    assistantMessage('msg_a3', [text('Both notes say body.')]),
  ];
}

/**
 * Three independent large results: room for a stored forget, a kept row and an
 * unreadable row in one table.
 */
function largeThreeResultMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read all three notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(`# Note\n\n${'alpha-'.repeat(120)}\n`))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'),
      toolCall('call_2', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(`# Other\n\n${'bravo-'.repeat(120)}\n`))]),
    assistantMessage('msg_a3', [
      text('Reading THIRD.md.'),
      toolCall('call_3', 'read', { filePath: 'THIRD.md' }),
    ]),
    toolMessage('msg_t3', [toolResult('call_3', 'read', textResult(`# Third\n\n${'charlie-'.repeat(120)}\n`))]),
    assistantMessage('msg_a4', [text('All three notes are read.')]),
  ];
}

/**
 * One large read, then a write to the same path: the at-rest stale-read rule
 * removes the read (the write proves its bytes stale), while the write's own
 * small result is below the ask floor. The read is therefore the one unit the
 * step pass removes and the one row the ask tables.
 */
function staleReadMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note, then rewrite it.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTE.md.'),
      toolCall('call_read', 'read', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_read', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a2', [
      text('Rewriting NOTE.md.'),
      toolCall('call_write', 'write', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_write', 'write', textResult('written'))]),
    assistantMessage('msg_a3', [text('Done.')]),
  ];
}

/** The exact result text the stale read carries; a container result repeats it. */
const STALE_READ_BODY = `# Note\n\n${'body-'.repeat(180)}\n`;

/** The plain text one message renders, or '' when it has no text part. */
function textOf(message: OpencodeMessage): string {
  return message.content
    .filter(part => part.type === 'text' && typeof part['text'] === 'string')
    .map(part => part['text'] as string)
    .join('');
}

/**
 * One `session.step.ended` row that states the prompt count the host billed,
 * with a cold cache. It is the only host reading the depth latch observes: the
 * mount pairs it with the estimate its last context hook pushed, and
 * `observeDepth` reads the reconciled count at the next hook.
 */
function stepUsage(messageId: string, inputTokens: number): OpencodeHostEvent {
  return {
    type: 'session.step.ended',
    data: {
      sessionID: sessionId, assistantMessageID: messageId, finish: 'stop', cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

/** The receipt lines the request carries, by the line's own shape. */
function receiptLines(messages: readonly OpencodeMessage[]): readonly string[] {
  return messages
    .filter(message => message.role === 'user' && textOf(message).startsWith('[not retained] '))
    .map(textOf);
}

/**
 * The host's rebuild of the stale-read fixture: the unit is back, a container
 * result repeats its exact text (so the retention rules would refuse a
 * first-time offer), and the receipt line the committed pass wrote is kept with
 * no marker fields — the shape a host store has. The line is spliced where the
 * first pass put it: after the write's result message.
 */
function rebuiltStaleRead(receiptLine: string): {
  readonly messages: OpencodeMessage[];
  readonly hostReceipt: OpencodeMessage;
} {
  const messages = staleReadMessages();
  const hostReceipt = userMessage('msg_host_receipt_restart', [text(receiptLine)]);
  messages.splice(5, 0, hostReceipt);
  messages.push(assistantMessage('msg_a4', [
    text('Checking the note body.'),
    toolCall('call_grep', 'grep', { pattern: 'body' }),
  ]));
  messages.push(toolMessage('msg_t4', [toolResult('call_grep', 'grep',
    textResult(`prefix\n${STALE_READ_BODY}\nsuffix`))]));
  return { messages, hostReceipt };
}

/**
 * Two large reads and a write to the first path: the step pass removes the
 * stale NOTE.md read and keeps the OTHER.md one. With the step ask failing,
 * the surviving unit is the one the idle fallback retries on the post-removal
 * revision.
 */
function staleReadAndOtherMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes, then rewrite NOTE.md.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTE.md.'),
      toolCall('call_read', 'read', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_read', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'),
      toolCall('call_other', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_other', 'read',
      textResult(`# Other\n\n${'other-'.repeat(180)}\n`))]),
    assistantMessage('msg_a3', [
      text('Rewriting NOTE.md.'),
      toolCall('call_write', 'write', { filePath: 'NOTE.md' }),
    ]),
    toolMessage('msg_t3', [toolResult('call_write', 'write', textResult('written'))]),
    assistantMessage('msg_a4', [text('Done.')]),
  ];
}

/** The journal as plain objects, plus a reader for one kind. */
function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** The smallest request the port's staging seam accepts. The guard brand is bypassed. */
function stagedRequest(baseRevision: string, intentId = 'intent-c6'): ApplyRequest {
  const application = {
    sessionId, eventId: 'event-c6', baseRevision, phase: 'at-rest', mode: 'revert',
    applicationSha256: 'application-c6', replacements: [], appendRecords: [],
    archives: [], sealedEpisodeIds: [], createdAtMs: 1,
  } as unknown as ApplyRequest['application'];
  return { application,
    intent: { intentId, sessionId, eventId: 'event-c6', baseRevision,
      applicationSha256: 'application-c6' } };
}

/** Drops the last message and appends one receipt: a visible derivation. */
const dropTail = (_request: ApplyRequest, messages: readonly OpencodeMessage[]):
OpencodeStaging => ({
  status: 'staged',
  messages: [...messages.slice(0, -1), {
    id: 'racoons-record:intent-c6:0',
    role: 'user',
    content: [{ type: 'text', text: '[not retained] NOTES.md' }],
    [OPENCODE_RECORD_ID_FIELD]: 'racoons-record:intent-c6:0',
    racoonsReceiptOf: 'note-1',
    racoonsForgottenNodeId: 'oc:ses_test:tool:call_1',
  }],
});

/**
 * The custom ports' derivation. The test's own staged request (`event-c6`) gets
 * `dropTail`; every engine-driven apply — including the ask lane's prune event —
 * gets the adapter's real derivation, so a test port cannot corrupt the ask path
 * with a second receipt id.
 */
const testDerive = (
  request: ApplyRequest, messages: readonly OpencodeMessage[],
  index: OpencodeAppliedPlanIndex,
): OpencodeStaging => request.intent.eventId === 'event-c6'
  ? dropTail(request, messages)
  : deriveOpencodeRevert(request, messages, index);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FakeEventStream {
  private readonly queue: OpencodeHostEvent[] = [];
  private readonly waiters: ((result: IteratorResult<OpencodeHostEvent>) => void)[] = [];
  private closed = false;

  push(event: OpencodeHostEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) { waiter({ done: false, value: event }); return; }
    this.queue.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<OpencodeHostEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false as const, value: event });
        if (this.closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise(resolve => { this.waiters.push(resolve); });
      },
      return: async () => {
        this.close();
        return { done: true as const, value: undefined };
      },
    };
  }
}

interface FakeHost {
  readonly context: OpencodePluginContext;
  readonly stream: FakeEventStream;
  readonly added: OpencodeToolDefinition[];
  /** Every `session.generate` call the mount made, in order. */
  readonly generateCalls: OpencodeGenerateInput[];
  /**
   * The `types` each `context.event.subscribe` call named, in order
   * (ISSUE-496): the plugin's subscription list is a shipped claim, so a test
   * reads it instead of driving every event the host might send.
   */
  readonly subscribedTypes: (readonly string[] | undefined)[];
  /** The reply text the next `generate` returns. */
  generateReply: string;
  /** When set, `generate` throws it instead of returning text. */
  generateError: Error | null;
  contextHook: ((input: OpencodeSessionContext) => Promise<void> | void) | null;
  afterHook: ((input: OpencodeAfterToolInput) => Promise<void> | void) | null;
}

function fakeHost(
  options: Record<string, unknown> = {}, failToolTransform = false, includeGenerate = true,
): FakeHost {
  const stream = new FakeEventStream();
  const added: OpencodeToolDefinition[] = [];
  const generateCalls: OpencodeGenerateInput[] = [];
  const subscribedTypes: (readonly string[] | undefined)[] = [];
  const host: FakeHost = {
    context: {
      options,
      session: {
        hook: async (
          name: 'context' | 'compaction' | 'generate' | 'experimental.idle',
          callback: ((input: OpencodeSessionContext) => Promise<void> | void)
            | ((input: OpencodeIdleHookInput) => Promise<void> | void),
        ) => {
          // This fake predates the awaited idle seam: the registration is
          // refused, so these rows exercise the event-path fallback. The
          // wired-hook lane lives in idle-block.test.ts (ISSUE-373). It also
          // predates ADR-0074's request hooks, so those are refused too.
          if (name !== 'context') throw new Error('unexpected session hook');
          host.contextHook = callback as (input: OpencodeSessionContext) => Promise<void> | void;
          return {};
        },
        ...(includeGenerate
          ? {
            generate: async (input: OpencodeGenerateInput) => {
              generateCalls.push(input);
              if (host.generateError !== null) throw host.generateError;
              return { text: host.generateReply };
            },
          }
          : {}),
      },
      tool: {
        transform: async (callback) => {
          if (failToolTransform) throw new Error('no editor');
          await callback({ add: tool => { added.push(tool); } });
          return {};
        },
        hook: async (
          name: 'execute.after',
          callback: (input: OpencodeAfterToolInput) => Promise<void> | void,
        ) => {
          if (name !== 'execute.after') throw new Error('unexpected tool hook');
          host.afterHook = callback;
          return {};
        },
      },
      event: {
        subscribe: (subscribeOptions?: { readonly types?: readonly string[] }) => {
          subscribedTypes.push(subscribeOptions?.types);
          return stream;
        },
      },
    },
    stream,
    added,
    generateCalls,
    subscribedTypes,
    generateReply: '{"1":{"forgetall":true,"summary":"mock ask answer"}}',
    generateError: null,
    contextHook: null,
    afterHook: null,
  };
  return host;
}

async function tick(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve); });
}

/**
 * The hook rows — one per seam the host calls. Each row owns what the hook
 * writes, what it refuses to write, and the reason it records.
 */
const HOOK_ROWS: readonly Row[] = [
  { name: 'a context hook with no staged change leaves the request deep-equal',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      const messages = hostMessages();
      const untouched = structuredClone(messages);
      const ids = messages.map(message => message.id);
      try {
        await mount.transform(sessionId, messages);
        assert.deepEqual(messages, untouched, at('not one message moved'));
        assert.deepEqual(messages.map(message => message.id), ids, at('the order is unchanged'));
        assert.equal(lines.of('commit').at(-1)?.['committed'], false,
          at('the port staged nothing, so the commit wrote nothing'));
        const atRest = lines.of('at-rest').filter(line => line['reason'] === 'step');
        assert.equal(atRest.length, 1, at('one at-rest line, with the step reason'));
        assert.equal(atRest[0]?.['status'], 'unchanged', at('the pass changed nothing'));
        const capabilities = lines.of('capabilities');
        assert.equal(capabilities.length, 1, at('one capabilities line at mount'));
        assert.equal(capabilities[0]?.['revertHistory'], true,
          at('the mount declares the seam its port actually carries'));
        assert.equal(capabilities[0]?.['reason'], 'wire-proven', at('the reason names the proof'));
        assert.equal(capabilities[0]?.['atRest'], true, at('the at-rest seam is declared'));
        assert.equal(capabilities[0]?.['liveTokens'], true, at('the live token seam is declared'));
        assert.equal(capabilities[0]?.['appendRecords'], false, at('append is still refused'));
      } finally { await mount.close(); }
    } },
  { name: 'a staged plan is committed onto the request messages exactly once',
    async run(at) {
      let stages = 0;
      let commits = 0;
      const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
        const inner = createOpencodePort({
          ...options,
          capabilities: { ...createOpencodeCapabilities(), revertHistory: true },
          deriveRevert: dropTail,
        });
        let staged = false;
        return {
          snapshot: async () => {
            if (!staged) {
              staged = true;
              stages += 1;
              const base = await inner.snapshot();
              const result = await inner.apply(stagedRequest(base.revision));
              assert.equal(result.status, 'applied', at('the test port stages one derivation'));
            }
            return inner.snapshot();
          },
          apply: request => inner.apply(request),
          lookupReceipt: intentId => inner.lookupReceipt(intentId),
          observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
          commit: () => { commits += 1; return inner.commit(); },
        };
      };
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' }, createPort,
        journal: record => lines.records.push(record),
      });
      const messages = hostMessages();
      const ids = messages.map(message => message.id);
      try {
        await mount.transform(sessionId, messages);
        assert.equal(stages, 1, at('one derivation staged during the pass'));
        assert.equal(commits, 1, at('the context hook commits once per request'));
        assert.equal(messages.length, ids.length, at('one message removed, one receipt appended'));
        assert.deepEqual(messages.map(message => message.id),
          [...ids.slice(0, -1), 'racoons-record:intent-c6:0'],
          at('the tail message is replaced by the receipt'));
        assert.equal(messages.at(-1)?.[OPENCODE_RECORD_ID_FIELD], 'racoons-record:intent-c6:0',
          at('the receipt carries the record marker'));
        assert.equal(lines.of('commit').at(-1)?.['committed'], true, at('the commit line says committed'));

        const afterFirst = structuredClone(messages);
        await mount.transform(sessionId, messages);
        assert.equal(commits, 2, at('one commit call per context hook, staged or not'));
        assert.deepEqual(messages, afterFirst, at('a second pass re-renders nothing'));
        assert.equal(messages.filter(message =>
          message[OPENCODE_RECORD_ID_FIELD] !== undefined).length,
        1, at('exactly one receipt message, never a second'));
      } finally { await mount.close(); }
    } },
  { name: 'the idle seam applies nothing: a plan it could stage leaves no ledger-applied claim',
    async run(at) {
      const lines = journalLines();
      const body = `# Note\n\n${'body line\n'.repeat(1100)}`;
      const messages: OpencodeMessage[] = [
        userMessage('msg_u1', [text('Read the note.')]),
        assistantMessage('msg_a1', [
          text('Reading NOTES.md.'),
          toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
        ]),
        toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
        assistantMessage('msg_a2', [text('It says body.')]),
      ];
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        await mount.transform(sessionId, messages);
        assert.equal(lines.of('commit').at(-1)?.['committed'], false,
          at('one read proves nothing, so the step pass staged nothing'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the session opened a ledger'));
        // A second read lands after the context hook, the way a host can append
        // before the idle event; `lastMessages` is the same array by reference.
        messages.push(userMessage('msg_u2', [text('Read it again.')]));
        messages.push(assistantMessage('msg_a3', [
          text('Reading again.'), toolCall('call_2', 'read', { filePath: 'NOTES.md' }),
        ]));
        messages.push(toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(body))]));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        const applied: string[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'applied') applied.push(event.receipt.intentId);
        }
        assert.deepEqual(applied, [],
          at('the idle seam wrote no ledger-applied claim for a plan it could not commit'));
        const idleLines = lines.of('at-rest').filter(line => line['reason'] === 'turn-end');
        assert.equal(idleLines.length, 1, at('one turn-end observation'));
        assert.equal(idleLines[0]?.['status'], 'observed', at('the seam is an observation'));
        assert.equal(idleLines[0]?.['intentId'], undefined, at('the observation names no intent'));
        assert.equal(lines.of('commit').at(-1)?.['committed'], false,
          at('idle carries no array, so nothing was committed'));
        assert.deepEqual(await entry.port.lookupReceipt('intent-anything'), { status: 'unknown' },
          at('no idle receipt exists'));
      } finally { await mount.close(); }
    } },
  { name: 'session.idle observes the turn end, applies nothing, and restores the default',
    async run(at) {
      const observed: (number | undefined)[] = [];
      const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
        const inner = createOpencodePort(options);
        return {
          snapshot: () => inner.snapshot(),
          apply: request => inner.apply(request),
          lookupReceipt: intentId => inner.lookupReceipt(intentId),
          observe: (messages, observeOptions) => {
            observed.push(observeOptions?.completedThroughTurnOrdinal);
            return inner.observe(messages, observeOptions);
          },
          commit: () => inner.commit(),
        };
      };
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' }, createPort,
        journal: record => lines.records.push(record),
      });
      const messages = hostMessages();
      try {
        await mount.transform(sessionId, messages);
        assert.equal(lines.of('at-rest').filter(line => line['reason'] === 'step').length, 1,
          at('the context hook ran one step pass'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        const idleLines = lines.of('at-rest').filter(line => line['reason'] === 'turn-end');
        assert.equal(idleLines.length, 1, at('one turn-end observation per idle'));
        assert.equal(idleLines[0]?.['status'], 'observed',
          at('the idle seam runs no applying pass'));
        assert.equal(idleLines[0]?.['intentId'], undefined,
          at('the observation names no intent: no engine pass ran'));
        assert.equal(lines.of('commit').at(-1)?.['reason'], 'no-array',
          at('idle carries no array, so nothing is committed there'));
        assert.equal(typeof idleLines[0]?.['eventId'], 'string',
          at('the idle observation has an event id'));
        assert.match(idleLines[0]?.['eventId'] as string, /^oc:ses_test:idle:oc:4:[0-9a-f]{64}$/u,
          at('the event id names the array, not a process counter'));
        assert.deepEqual(observed, [undefined, undefined],
          at('the step observes once, and the idle observes the same array without claiming a turn'));
        assert.deepEqual(lines.of('gate-presented'), [], at('no gate was presented'));
        await mount.event({ type: 'session.idle', data: { sessionID: 'ses_unseen' } });
        assert.equal(lines.of('at-rest').filter(line => line['reason'] === 'turn-end').length, 1,
          at('an idle for a session this mount never transformed is not an observation'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        const replays = lines.of('at-rest').filter(line => line['reason'] === 'turn-end');
        assert.equal(replays.length, 2, at('the replay journals a second line'));
        assert.equal(replays[1]?.['eventId'], replays[0]?.['eventId'],
          at('the same history, the same id'));
        assert.equal(replays[1]?.['status'], 'observed', at('the replay changes nothing'));
      } finally { await mount.close(); }
    } },
  { name: 'a restored unit plus its stale receipt ships no [not retained] line and names the refusal',
    async run(at) {
      const lines = journalLines();
      const base = hostMessages();
      const intentId = 'intent-partial';
      const withPass = opencodeReceiptTextWithPass(STALE_RECEIPT_TEXT, intentId);
      assert.ok(withPass !== null, at('the fixture text is the product\'s receipt line'));
      const receipt = receiptMessageFor(
        intentId, 'note-1', withPass, fixtureForgottenNodeId(base));
      const messages = [...base, receipt];
      // The plan is sealed over the array as it stands: the receipt is present
      // and so is the unit it says was not retained. That is one intent whose
      // own marker contradicts the content the model can read.
      const request = removalRequest(
        sealedRemoval(messages, 'note-1', STALE_RECEIPT_TEXT), intentId, 'note-1',
        STALE_RECEIPT_TEXT);
      let arm = false;
      let forced: ApplyResult | null = null;
      const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
        const inner = createOpencodePort(options);
        return {
          snapshot: async () => {
            if (arm) {
              arm = false;
              forced = await inner.apply(request);
            }
            return inner.snapshot();
          },
          apply: applyRequest => inner.apply(applyRequest),
          lookupReceipt: id => inner.lookupReceipt(id),
          refusal: () => inner.refusal(),
          observe: (observed, observeOptions) => inner.observe(observed, observeOptions),
          commit: () => inner.commit(),
          lastCommitKind: () => inner.lastCommitKind(),
        };
      };
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' }, createPort,
        journal: record => lines.records.push(record),
      });
      try {
        arm = true;
        await mount.transform(sessionId, messages);
        assert.ok(forced !== null, at('the half-present plan reached the port'));
        assert.deepEqual(forced, { status: 'not-applied', reason: 'host-error' },
          at('a cleanup refusal is never an applied receipt'));
        assert.equal(messages.some(message =>
          typeof message[OPENCODE_RECORD_ID_FIELD] === 'string'), false,
        at('the stale receipt left the request array'));
        assert.equal(messages.some(message => JSON.stringify(message.content)
          .includes('[not retained]')), false,
        at('no line names content the model can read in the same request'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), true,
          at('the restored unit stays readable'));
        const stepLine = lines.of('at-rest').filter(line => line['reason'] === 'step').at(-1);
        const refusal = stepLine?.['refusal'] as Record<string, unknown> | undefined;
        assert.equal(refusal?.['code'], 'intent-conflict',
          at('the refusal code reaches the journal'));
        assert.equal(refusal?.['reason'], 'host-error', at('the port reason rides beside it'));
        assert.match(String(refusal?.['detail']), /stale receipts are dropped/u,
          at('the detail says what the cleanup did'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the session opened a ledger'));
        assert.deepEqual(await entry.port.lookupReceipt(intentId), { status: 'unknown' },
          at('the cleanup minted no receipt'));
        const applied: string[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'applied') applied.push(event.receipt.intentId);
        }
        assert.deepEqual(applied, [], at('the cleanup wrote no ledger-applied record'));
      } finally { await mount.close(); }
    } },
  { name: 'the tool.execute.after observation names the call and leaves the result alone',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        const before = { content: 'ignored' };
        await mount.afterTool({ tool: 'bash', sessionID: sessionId, id: 'call_1',
          status: 'completed', result: before });
        const observed = lines.of('tool-observed');
        assert.equal(observed.length, 1, at('one observation line'));
        assert.deepEqual([observed[0]?.['tool'], observed[0]?.['callId'], observed[0]?.['sessionId']],
          ['bash', 'call_1', sessionId], at('the line names the call and its session'));
        assert.equal(mount.sessions.size, 0, at('an observation opens no ledger'));
        assert.deepEqual(lines.of('at-rest'), [], at('an observation runs no pass'));
        assert.deepEqual(lines.of('commit'), [], at('an observation commits nothing'));
      } finally { void mount.close(); }
    } },
  { name: 'each compaction event is journalled with its phase and counts, never as a forced loss',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        await mount.event({ type: 'session.compaction.started',
          data: { sessionID: sessionId, reason: 'auto' } });
        await mount.event({ type: 'session.compaction.delta',
          data: { sessionID: sessionId, text: 'partial' } });
        await mount.event({ type: 'session.compaction.ended',
          data: { sessionID: sessionId, reason: 'auto', text: 'the summary', cost: 0.01,
            tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
        await mount.event({ type: 'session.compaction.failed',
          data: { sessionID: sessionId, reason: 'manual', error: { type: 'aborted',
            message: 'cancelled' } } });
        const compacted = lines.of('compacted');
        assert.deepEqual(compacted.map(line => line['phase']),
          ['started', 'delta', 'ended', 'failed'], at('one line per phase'));
        assert.equal(compacted[0]?.['reason'], 'auto', at('the started line keeps the reason'));
        assert.equal(compacted[1]?.['textLength'], 7, at('a delta line carries only its length'));
        assert.equal(compacted[2]?.['costUsd'], 0.01, at('an ended line carries the cost'));
        assert.equal(compacted[2]?.['textLength'], 11, at('an ended line carries the summary length'));
        assert.deepEqual(compacted[2]?.['tokens'],
          { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          at('an ended line carries the token counts'));
        assert.deepEqual(lines.of('forced-loss'), [],
          at('a host compaction is never read as a forced loss'));
        const beforeUnknown = lines.records.length;
        await mount.event({ type: 'message.updated', data: { sessionID: sessionId } });
        await mount.event({ type: 'session.idle' });
        assert.equal(lines.records.length, beforeUnknown, at('an unknown event writes nothing'));
      } finally { await mount.close(); }
    } },
  { name: 'a context hook with no session id writes one refusal and opens no ledger',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        await mount.transform('', hostMessages());
        assert.deepEqual(lines.of('transform').map(line => line['reason']), ['no-session'],
          at('an empty session id is refused by name'));
        assert.equal(mount.sessions.size, 0, at('no ledger was opened for a nameless request'));
        await mount.transform(sessionId, hostMessages());
        assert.equal(mount.sessions.size, 1, at('the named session opens a ledger'));
      } finally { await mount.close(); }
    } },
];

/**
 * The accounting rows — the step-ended reconciliation and the estimate. A wrong
 * bucket sum or an invented reading is a silent cost error, so these keep their
 * own table where the arithmetic is the named claim.
 */
const ACCOUNTING_ROWS: readonly Row[] = [
  { name: 'a step-ended row reconciles against the mount\'s own estimate, cache included',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        const first: OpencodeMessage[] = [userMessage('msg_u1', [text('Read NOTES.md')])];
        await mount.transform(sessionId, first);
        const estimate = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
        assert.ok(estimate !== null && estimate !== undefined, at('the mount made an estimate'));

        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a1', finish: 'stop', cost: 0.0042,
          tokens: { input: 240, output: 81, reasoning: 12, cache: { read: 7000, write: 296 } },
        } });

        const reconciled = lines.of('usage-reconciled');
        assert.equal(reconciled.length, 1, at('one reading for the one request'));
        const line = reconciled[0];
        assert.equal(line?.['inputTokens'], 240 + 7000 + 296,
          at('the host input is net of cache; the prompt is the three buckets summed'));
        assert.equal(line?.['cachedInputTokens'], 7000 + 296, at('the cached share is read plus write'));
        assert.equal(line?.['outputTokens'], 81, at('the output count is carried'));
        assert.equal(line?.['reasoningTokens'], 12, at('the reasoning count is carried'));
        assert.equal(line?.['costUsd'], 0.0042, at('cost is carried as telemetry only'));
        assert.equal(line?.['revision'], estimate.revision,
          at('the row is measured against the estimate the mount actually made'));
        assert.equal(line?.['estimatedInputTokens'], estimate.inputTokens,
          at('the estimate is carried beside the reading'));
        assert.equal(line?.['estimateErrorTokens'],
          (240 + 7000 + 296) - (estimate.inputTokens as number), at('the error is the difference'));

        const usageTelemetry = lines.of('telemetry')
          .map(record => record['event'])
          .filter(event => isRecord(event) && event['kind'] === 'usage-reconciled');
        assert.equal(usageTelemetry.length, 1, at('one usage event on telemetry'));
        const reading = isRecord(usageTelemetry[0]) ? usageTelemetry[0]['reading'] : null;
        assert.ok(isRecord(reading), at('the telemetry event carries a reading'));
        assert.equal(reading['inputTokens'], 7536, at('the meter reads the summed input'));
        assert.equal(reading['cachedInputShare'], 7296 / 7536, at('the cached share is a ratio'));

        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a1', finish: 'stop', cost: 0.0042,
          tokens: { input: 240, output: 81, reasoning: 12, cache: { read: 7000, write: 296 } },
        } });
        assert.equal(lines.of('usage-reconciled').length, 1, at('the same row is never reconciled twice'));
      } finally { await mount.close(); }
    } },
  { name: 'a step row for the bench-only ask never consumes a main request estimate',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        await mount.transform(sessionId, hostMessages());
        const estimate = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
        assert.ok(estimate !== null && estimate !== undefined, at('the mount made an estimate'));
        // The generate step's row names its own kind. It is not the main
        // request the estimate belongs to, so it must be filtered, not consumed.
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_ask', requestKind: 'generate',
          finish: 'stop', cost: 0,
          tokens: { input: 9, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        } });
        const missing = lines.of('usage-missing');
        assert.deepEqual(missing.map(line => [line['messageId'], line['reason']]),
          [['msg_ask', 'ask-request']],
          at('the ask step is recorded unmeasured with its own reason'));
        assert.equal(lines.of('usage-reconciled').length, 0,
          at('the ask step is not reconciled against the main estimate'));
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a1', finish: 'stop', cost: 0,
          tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 1, write: 1 } },
        } });
        const reconciled = lines.of('usage-reconciled');
        assert.equal(reconciled.length, 1, at('the main row still finds its estimate'));
        assert.equal(reconciled[0]?.['revision'], estimate.revision,
          at('the main row is measured against the request it answers'));
        assert.equal(reconciled[0]?.['estimatedInputTokens'], estimate.inputTokens,
          at('the ask step did not replace the main estimate'));
      } finally { await mount.close(); }
    } },
  { name: 'a step row with no request kind accounts as main and journals unstated',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        await mount.transform(sessionId, hostMessages());
        const estimate = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
        assert.ok(estimate !== null && estimate !== undefined, at('the mount made an estimate'));
        // 2.4.0 declares no request-kind field. An absent kind is a main turn,
        // never an ask: the row consumes the pending estimate and the journal
        // says the kind was unstated rather than implying it.
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_unstated', finish: 'stop', cost: 0,
          tokens: { input: 30, output: 2, reasoning: 0, cache: { read: 4, write: 1 } },
        } });
        const reconciled = lines.of('usage-reconciled');
        assert.equal(reconciled.length, 1, at('the unstated row is accounted as a main request'));
        assert.equal(reconciled[0]?.['requestKind'], 'unstated',
          at('the journal states that the host named no request kind'));
        assert.equal(reconciled[0]?.['revision'], estimate.revision,
          at('the row is measured against the main request estimate'));
        const reading = mount.sessions.get(sessionId)?.meter.latest();
        assert.equal(reading?.inputTokens, 30 + 4 + 1,
          at('the main meter reconciled the row, cache included'));
        assert.deepEqual(lines.of('usage-missing'), [],
          at('nothing was filtered as an ask request'));
      } finally { await mount.close(); }
    } },
  { name: 'a row before any measured request, or a malformed one, journals once and invents nothing',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        const messages = hostMessages();
        await mount.transform(sessionId, messages);
        // The mount has an estimate for the request; a row for a different
        // assistant message is still reconciled against that estimate. A row
        // that arrives before any context hook is the "no session" case.
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: 'ses_unseen', assistantMessageID: 'msg_other', finish: 'stop', cost: 0,
          tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } });
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_bad', finish: 'stop', cost: 0,
          tokens: { input: 'plenty', output: 1 },
        } });
        const missing = lines.of('usage-missing');
        assert.deepEqual(missing.map(line => [line['messageId'], line['reason']]),
          [['msg_other', 'no-session'],
            ['msg_bad', 'input and output must be non-negative safe integers']],
          at('each unmeasured or malformed row is reported with its own reason'));
        assert.deepEqual(lines.of('usage-reconciled'), [], at('nothing was reconciled against a guess'));
        assert.equal(mount.sessions.get(sessionId)?.meter.latest(), null, at('no reading was invented'));
        // A row with no assistant message id is not a step row at all.
        const before = lines.records.length;
        await mount.event({ type: 'session.step.ended', data: { sessionID: sessionId, tokens: {} } });
        assert.equal(lines.records.length, before, at('a row with no message id writes nothing'));
      } finally { await mount.close(); }
    } },
  { name: 'a row pairs with the request it answers even when the next hook ran first',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      try {
        const first: OpencodeMessage[] = [userMessage('msg_u1', [text('one')])];
        await mount.transform(sessionId, first);
        const est1 = mount.sessions.get(sessionId)?.pendingEstimates[0];
        const second: OpencodeMessage[] = [
          ...first, assistantMessage('msg_a1', [text('answer one')]),
        ];
        await mount.transform(sessionId, second);
        const est2 = mount.sessions.get(sessionId)?.pendingEstimates[1];
        assert.ok(est1 !== null && est1 !== undefined && est2 !== null && est2 !== undefined,
          at('the mount holds one estimate per measured request'));
        assert.notEqual(est1.revision, est2.revision, at('the two requests are different revisions'));
        // Both rows arrive after the second hook: the oldest estimate answers the
        // oldest row, so no row is measured against a request it did not make.
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a1', finish: 'stop', cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } });
        await mount.event({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a2', finish: 'stop', cost: 0,
          tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } });
        const reconciled = lines.of('usage-reconciled');
        assert.equal(reconciled.length, 2, at('both rows reconciled'));
        assert.deepEqual(reconciled.map(line => [line['revision'], line['estimatedInputTokens']]),
          [[est1.revision, est1.inputTokens], [est2.revision, est2.inputTokens]],
          at('the oldest row is measured against the oldest estimate'));
      } finally { await mount.close(); }
    } },
];

/**
 * The registration rows — what the mount offers. A tool a model can call is a
 * promise it will work, so an unregistered or extra name is its own failure.
 */
const REGISTRATION_ROWS: readonly Row[] = [
  { name: 'the mount offers necromancy and nothing else', run(at) {
    const scratchDir = scratch();
    const mount = createOpencodeMount({
      storage: { crematorStorageRoot: join(scratchDir, 'root') }, journal: () => {},
    });
    try {
      assert.equal(mount.tool.name, 'necromancy', at('the tool is necromancy'));
      assert.equal(typeof mount.tool.execute, 'function', at('the tool has an execution path'));
      assert.equal(mount.tool.input['type'], 'object', at('the tool carries JSON Schema'));
      assert.deepEqual(mount.tool.options, { codemode: false },
        at('the tool opts out of code mode, so the host names it in the request'));
    } finally {
      void mount.close();
      cleanup(scratchDir);
    }
  } },
  { name: 'the plugin registers the tool, the context hook and the after hook',
    async run(at) {
      const host = fakeHost();
      const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' },
        journal: () => {} });
      const cleanupFn = await plugin.setup(host.context);
      try {
        assert.equal(typeof host.contextHook, 'function', at('the context hook is registered'));
        assert.equal(typeof host.afterHook, 'function', at('the after hook is registered'));
        assert.deepEqual(host.added.map(tool => tool.name), ['necromancy'],
          at('the one declared tool is added through the editor'));
        assert.deepEqual(host.added[0]?.options, { codemode: false },
          at('the editor receives the direct-tool flag, not a catalog-only tool'));
        const messages = hostMessages();
        const untouched = structuredClone(messages);
        await host.contextHook?.(sessionContext(messages));
        assert.deepEqual(messages, untouched, at('the hook moved nothing on a clean request'));
        const big = `${'y'.repeat(63)}\n`.repeat(300);
        const before: OpencodeAfterToolInput = { tool: 'read', sessionID: sessionId, id: 'c1',
          status: 'completed', result: { content: big } };
        await host.afterHook?.(before);
        assert.equal(before.result?.content, big,
          at('the registered after hook leaves an oversized result whole'));
        assert.equal(before.result?.metadata, undefined,
          at('the registered hook writes no metadata, so the host truncation can run'));
        assert.deepEqual(
          host.subscribedTypes[0]?.filter(type => type.startsWith('session.revert.')),
          ['session.revert.staged', 'session.revert.committed'],
          at('the plugin subscribes to both handled revert events, never the no-op cleared one'));
        assert.equal(typeof cleanupFn, 'function', at('setup returns a cleanup'));
      } finally { await cleanupFn(); }
    } },
  { name: 'excludeTools deletes the subagent tool and leaves auto-compaction alone',
    async run(at) {
      const host = fakeHost();
      const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' },
        excludeTools: OPENCODE_TEST_EXCLUDE_TOOLS, journal: () => {} });
      const cleanupFn = await plugin.setup(host.context);
      try {
        const beforeOptions = { compaction: { auto: true, keep: { tokens: 15000 } } };
        const context = sessionContext(hostMessages(), {
          tools: {
            [OPENCODE_SUBAGENT_TOOL]: { description: 'spawn a subagent', input: { type: 'object' } },
            read: { description: 'read a file', input: { type: 'object' } },
          },
          options: beforeOptions,
        });
        await host.contextHook?.(context);
        assert.equal(context.tools?.[OPENCODE_SUBAGENT_TOOL], undefined,
          at('the subagent tool is gone from the request tool table'));
        assert.ok(context.tools?.['read'] !== undefined, at('the other tools are untouched'));
        assert.deepEqual(context.options, beforeOptions,
          at('auto-compaction options are passed through unchanged (ADR-0043)'));
      } finally { await cleanupFn(); }
    } },
  { name: 'a host config can carry the same exclusion, and a tool failure is journalled',
    async run(at) {
      const lines = journalLines();
      const host = fakeHost({ excludeTools: [OPENCODE_SUBAGENT_TOOL] }, true);
      const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      const cleanupFn = await plugin.setup(host.context);
      try {
        const context = sessionContext(hostMessages(), {
          tools: { [OPENCODE_SUBAGENT_TOOL]: { description: 'spawn a subagent', input: { type: 'object' } } },
        });
        await host.contextHook?.(context);
        assert.equal(context.tools?.[OPENCODE_SUBAGENT_TOOL], undefined,
          at('the config tuple options reach the same deletion'));
        assert.equal(lines.of('tool-error')[0]?.['reason'], 'register-failed',
          at('a tool registration failure is journalled, not hidden'));
        assert.equal(typeof cleanupFn, 'function', at('the passive seams still mount'));
      } finally { await cleanupFn(); }
    } },
  { name: 'the event consumer handles a pushed event and stops at cleanup',
    async run(at) {
      const lines = journalLines();
      const host = fakeHost();
      const plugin = createOpencodePlugin({ storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record) });
      const cleanupFn = await plugin.setup(host.context);
      try {
        await host.contextHook?.(sessionContext(hostMessages()));
        host.stream.push({ type: 'session.step.ended', data: {
          sessionID: sessionId, assistantMessageID: 'msg_a1', finish: 'stop', cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } });
        await tick();
        assert.equal(lines.of('usage-reconciled').length, 1,
          at('the pushed event reached the mount'));
        host.stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
        await tick();
        assert.equal(lines.of('at-rest').filter(line => line['reason'] === 'turn-end').length, 1,
          at('the pushed idle ran the turn-end pass'));
      } finally {
        await cleanupFn();
        assert.equal(host.stream.isClosed, true, at('cleanup stops the event iterator'));
      }
    } },
];

/**
 * The bench-only ask's mount path: one transient request per unasked revision,
 * its reading journalled, and its `forgetall` verdict applied after the at-rest
 * commit. Every row drives the real engine and a real ledger; `session.generate`
 * is a test seam, never a model call.
 */
const ASK_ROWS: readonly Row[] = [
  { name: 'ask off: neither the step hook nor the idle fallback makes a generate call',
    async run(at) {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      // A generate seam supplied with no grammar must not be called: off is off.
      askGenerate: async (input) => { calls.push(input); return { text: '{}' }; },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = hostMessages();
      const untouched = structuredClone(messages);
      await mount.transform(sessionId, messages);
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls.length, 0, at('no transient request left with the ask off'));
      assert.deepEqual(lines.of('ask'), [], at('no ask line was written'));
      assert.deepEqual(messages, untouched, at('idle still changes nothing'));
      const capabilities = lines.of('capabilities')[0];
      assert.equal(capabilities?.['atRest'], true,
        at('the shipped declaration still says both hooks are model-free'));
      assert.equal(capabilities?.['engineAtRest'], true,
        at('the engine still runs at-rest passes'));
      assert.equal(capabilities?.['ask'], undefined, at('no ask block is recorded when off'));
    } finally { await mount.close(); }
  } },
  { name: 'a first-request-only session asks nothing and applies nothing',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"nothing yet"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        const messages = largeHostMessages();
        const untouched = structuredClone(messages);
        await mount.transform(sessionId, messages);
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 0,
          at('one request is not enough: the seen set is empty, so no ask leaves'));
        assert.deepEqual(lines.of('ask'), [], at('no ask line was written'));
        assert.deepEqual(lines.of('ask-apply'), [], at('no apply line was written'));
        assert.deepEqual(messages, untouched, at('the host array is unchanged'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        assert.equal(entry.seenNodeIds.size, 0, at('nothing has been carried yet'));
        assert.equal(entry.askVerdicts.size, 0, at('nothing was stored'));
      } finally { await mount.close(); }
    } },
  { name: 'a result arriving in step 1 is not tabled until step 2, and step 2 loses it',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 produced the result and ships it; no request has carried it
        // before this one, so it is not tabled here.
        const carried = largeHostMessages();
        await mount.transform(sessionId, carried);
        assert.equal(calls.length, 0, at('step 1 sends no ask'));
        assert.equal(carried.some(message => message.id === 'msg_t1'), true,
          at('step 1 ships the result: the machine-readable before-body'));
        // Step 2 carries the result, so it is tabled, answered and removed; the
        // request that ships from this hook lacks it.
        const next = largeHostMessages();
        await mount.transform(sessionId, next);
        assert.equal(calls.length, 1, at('step 2 asks about the carried result'));
        assert.equal(next.some(message => message.id === 'msg_t1'), false,
          at('the request after the one that carried it lacks the result'));
        const appliedAsk = lines.of('ask-apply');
        assert.equal(appliedAsk.length, 1, at('one applied removal'));
        assert.equal(appliedAsk[0]?.['applied'], true, at('the removal landed a receipt'));
        assert.equal(lines.of('ask-error').length, 0, at('the eligibility delay is not an error'));
      } finally { await mount.close(); }
    } },
  { name: 'the at-rest pass runs first: a stale read is removed before any table',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries the read; step 2 adds the write that makes it stale.
        // The at-rest pass removes it before the prune pass, so there is no
        // unit left to table and no verdict to store (dsh's order).
        await mount.transform(sessionId, largeHostMessages());
        assert.equal(calls.length, 0, at('step 1 asks nothing'));
        const messages = [
          ...largeHostMessages(),
          assistantMessage('msg_a_write',
            [toolCall('call_write', 'write', { filePath: 'NOTES.md' })]),
          toolMessage('msg_t_write', [toolResult('call_write', 'write', textResult('written'))]),
        ];
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 0, at('the removed read is never tabled'));
        assert.equal(lines.of('ask').length, 0, at('no ask line was written'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the at-rest pass removed the unit in the same hook'));
        assert.equal(lines.of('ask-apply').length, 0,
          at('no ask-apply line names a unit that left the array'));
        assert.equal(lines.of('ask-error').length, 0,
          at('the at-rest win is not an ask error'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        assert.equal(entry.askVerdicts.size, 0, at('no verdict was stored'));
      } finally { await mount.close(); }
    } },
  { name: 'a stored verdict whose unit left the array is dropped without an error',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        journal: record => lines.records.push(record),
      });
      try {
        const messages = largeHostMessages();
        await mount.transform(sessionId, messages);
        await mount.transform(sessionId, messages);
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const snapshot = entry.port.observe(messages);
        const units = new UnitTracker({
          sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes,
        }).units(snapshot);
        const unit = units.find(candidate => candidate.nodeId.endsWith(':tool:call_1'));
        assert.ok(unit !== undefined, at('the carried read is one unit'));
        entry.askVerdicts.set(unit.id, {
          verdict: { unitId: unit.id, action: 'forgetall', summary: 'stale note',
            answeredInRound: 1 },
        });
        // The host array no longer carries the unit: the at-rest lane won.
        const gone = messages.filter(message => message.id !== 'msg_t1');
        const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
          lines.records.push({ kind, atMs: 1, ...fields });
        };
        const applied = await applyOpencodeAskVerdicts({
          entry, messages: gone, snapshot: entry.port.observe(gone), window: 200_000, journal: sink,
        });
        assert.equal(applied, false, at('an absent unit is never applied'));
        assert.equal(entry.askVerdicts.size, 0, at('the verdict is dropped'));
        assert.equal(lines.of('ask-apply').length, 0, at('no apply line claims it'));
        assert.equal(lines.of('ask-retained').length, 0, at('the drop is not a retention rule'));
      } finally { await mount.close(); }
    } },
  { name: 'ask on: step 1 asks nothing; step 2 asks once, parses, journals and applies',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1: the result first appears here. No request has carried it yet,
        // so nothing is tabled and the array ships untouched.
        const first = largeHostMessages();
        const firstUntouched = structuredClone(first);
        await mount.transform(sessionId, first);
        assert.equal(calls.length, 0, at('the step that produced the unit sends no ask'));
        assert.deepEqual(lines.of('ask'), [], at('no ask line was written in step 1'));
        assert.deepEqual(first, firstUntouched,
          at('step 1 changes nothing: the model receives the unit'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        assert.equal(entry.seenNodeIds.size, 0,
          at('the first request has no already-sent node to offer'));
        assert.equal(entry.pendingSeenNodeIds.has(`oc:${sessionId}:tool:call_1`), true,
          at('the first request records the node it ships for the next step'));
        // Step 2: the host rebuilds the request. The unit is now carried by a
        // sent request, so the table may name it and the apply may remove it.
        const before = lines.records.length;
        const messages = largeHostMessages();
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 1, at('the step after the carrying request asks once'));
        assert.equal(lines.of('ask').length, 1, at('the step ask was journalled before the idle'));
        const order = lines.records.slice(before).map(record => record.kind === 'at-rest'
          ? `at-rest:${String(record['reason'])}` : record.kind);
        assert.ok(order.indexOf('at-rest:step') < order.indexOf('ask'),
          at('the at-rest pass runs first, then the prune ask (dsh order)'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 1, at('the idle fallback does not ask twice'));
        assert.equal(calls[0]?.sessionID, sessionId, at('the request names the live session'));
        assert.match(calls[0]?.prompt ?? '',
          /keep at most 70 percent of the total lines/u,
          at('the first table ask states the 70 percent share'));
        assert.ok(String(calls[0]?.prompt).trimEnd().endsWith(ENTRY_ASK_END_ANCHOR),
          at('the message closes on the entry ask end anchor'));
        assert.match(calls[0]?.prompt ?? '', /^1\. \[read\] NOTES\.md \(call #1\).* \[3 lines\]$/mu,
          at('the prompt tables the result an earlier request carried with its line count'));
        const ask = lines.of('ask');
        assert.equal(ask.length, 1, at('one ask line per fire'));
        const line = ask[0];
        assert.equal(line?.['status'], 'read', at('the reading is recorded'));
        assert.equal(line?.['rowCount'], 1, at('the line names the row count'));
        assert.deepEqual(line?.['indices'], [1], at('the line names the assigned indices'));
        assert.equal(line?.['answered'], 1, at('the recall summary answered the row'));
        assert.equal(line?.['refused'], 0, at('no row was refused'));
        assert.equal(line?.['applied'], false,
          at('the ask line itself applies nothing; the ask-apply line names the removal'));
        assert.equal((line?.['dropped'] as Record<string, number> | undefined)?.['subFloor'], 1,
          at('the sub-floor result is journalled as dropped, not silently lost'));
        assert.equal((line?.['dropped'] as Record<string, number> | undefined)?.['unseen'], 0,
          at('nothing carried by the sent request is counted unseen'));
        assert.equal(line?.['floorBytes'], 512, at('the product floor is recorded'));
        assert.equal('maxRows' in (line ?? {}), false,
          at('no row cap is recorded: the ask table is uncapped'));
        assert.match(String(line?.['promptSha256']), /^[0-9a-f]{64}$/u,
          at('the prompt sha256 is recorded'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the tabled unit left the host array'));
        const appliedAsk = lines.of('ask-apply');
        assert.equal(appliedAsk.length, 1,
          at('one ask-apply line for the one applied unit'));
        assert.equal(appliedAsk[0]?.['applied'], true,
          at('the ask apply landed a receipt'));
        const receipt = messages.find(message =>
          typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
        assert.ok(receipt !== undefined, at('the host array carries the receipt'));
        assert.equal(receipt?.[OPENCODE_FORGOTTEN_NODE_FIELD], appliedAsk[0]?.['nodeId'],
          at('the receipt names the node the ask-apply line names'));
        const recallId = appliedAsk[0]?.['recallId'];
        assert.equal(typeof recallId, 'string', at('the ask-apply line names the recall id'));
        const recalled = await entry.ledger.recall(String(recallId));
        assert.ok(recalled.parts.length >= 1,
          at('the ask-apply line\'s recall id resolves in the ledger'));
        assert.deepEqual([...entry.askedRevisions ?? []].length, 1,
          at('one revision was claimed'));
        assert.equal(entry?.askedUnitIds.size, 1, at('one unit was claimed'));
        assert.ok((entry?.askFires ?? 0) >= 1, at('the session records that a request left'));
        const capabilities = lines.of('capabilities')[0];
        assert.equal(capabilities?.['atRest'], false,
          at('the declaration says the ask path makes one model call'));
        assert.equal(capabilities?.['engineAtRest'], true,
          at('the engine still receives the at-rest pass'));
        const askBlock = capabilities?.['ask'] as Record<string, unknown> | undefined;
        assert.equal(askBlock?.['grammar'], 'prune-two-option',
          at('the capability line records the mount-option id'));
        assert.equal(askBlock?.['promptGrammar'], 'jsonl-20-nokeepall',
          at('the capability line names the wire grammar that actually ran'));
        // Idle re-entry for the same array cannot loop the transient request.
        const deliveries = lines.of('ask').length;
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 1, at('a repeated idle sends no second ask'));
        assert.equal(lines.of('ask').length, deliveries, at('a repeated idle writes no second line'));
      } finally { await mount.close(); }
    } },
  { name: 'a literal keepall is the terminal not-in-grammar refusal and keeps',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"keepall":true}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries the unit; step 2 is the one that may table it.
        await mount.transform(sessionId, largeHostMessages());
        const messages = largeHostMessages();
        const untouched = structuredClone(messages);
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 1, at('the step after the carrying request asks once'));
        const ask = lines.of('ask');
        assert.equal(ask.length, 1, at('the refusal is still one readable fire line'));
        assert.equal(ask[0]?.['answered'], 0, at('no row was answered'));
        assert.equal(ask[0]?.['refused'], 1, at('the keepall row was refused'));
        assert.deepEqual(ask[0]?.['parsed'], [
          { index: 1, status: 'refused', code: 'action-not-in-grammar',
            detail: 'action-not-in-grammar' },
        ], at('the journal names the grammar refusal, never an offered keep'));
        const shownUnitId = (ask[0]?.['unitIds'] as string[] | undefined)?.[0];
        assert.deepEqual(ask[0]?.['terminal'], [{
          index: 1, unitId: shownUnitId, code: 'action-not-in-grammar',
        }], at('a not-in-grammar refusal is terminal and is not carried'));
        assert.deepEqual(ask[0]?.['carried'], [],
          at('a terminal refusal spends no re-ask'));
        assert.equal(ask[0]?.['applied'], false, at('the ask applied nothing'));
        assert.deepEqual(messages, untouched, at('the host array is unchanged'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        assert.equal(entry.askVerdicts.size, 0, at('no verdict was stored'));
        assert.equal(entry.askedUnitIds.size, 1,
          at('a terminal refusal keeps the permanent claim'));
        assert.equal(entry.refusedRetriedUnitIds.size, 0,
          at('a terminal refusal never enters the retry set'));
      } finally { await mount.close(); }
    } },
  { name: 'a whole-range keeplines keeps whole and releases the unit',
    async run(at) {
      const lines = journalLines();
      const probe = largeHostMessages();
      const probeBatch = buildOpencodeAskBatch({
        sessionId, messages: probe,
        port: createOpencodePort({ sessionId, clock: { nowMs: () => 1 }, messages: probe }),
        round: 1,
      });
      assert.ok(probeBatch !== null, at('the probe pass is built'));
      const unitId = probeBatch.unitIds[0];
      assert.ok(unitId !== undefined, at('the probe names the unit'));
      // The row's own L: the unit body is the result text, so a whole-range
      // `keeplines` names 1..L, not 1..1 (ISSUE-509).
      const rowLineCount = (probeBatch.rows[0]?.unit.span.lineRange?.endLineInclusive ?? 0)
        - (probeBatch.rows[0]?.unit.span.lineRange?.startLine ?? 0) + 1;
      assert.ok(rowLineCount > 1, at('the probe row is the result\'s multi-line body'));
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({
          text: `{"1":{"keeplines":[[1,${String(rowLineCount)}]],"summary":"None"}}`,
        }),
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries the unit; step 2 is the one that may table it.
        await mount.transform(sessionId, largeHostMessages());
        const messages = largeHostMessages();
        const untouched = structuredClone(messages);
        await mount.transform(sessionId, messages);
        const ask = lines.of('ask');
        assert.equal(ask.length, 1, at('the answer is one readable fire line'));
        assert.equal(ask[0]?.['answered'], 1, at('the whole-range keeplines was read'));
        assert.equal(ask[0]?.['refused'], 0, at('no row was refused'));
        assert.deepEqual(ask[0]?.['parsed'], [
          { index: 1, status: 'answered', action: 'keepall' },
        ], at('a whole-range keeplines is the clean keep, never a stored removal'));
        assert.deepEqual(messages, untouched,
          at('a keep changes no host message'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        assert.equal(entry.askedUnitIds.size, 0,
          at('a keep releases the unit for a later crossing'));
        assert.equal(entry.askVerdicts.size, 0, at('no keep is stored for apply'));
        assert.deepEqual(ask[0]?.['kept'], [{ index: 1, unitId, action: 'keepall' }],
          at('the ask line journals the kept row'));
      } finally { await mount.close(); }
    } },
  { name: 'an unasked unit is the fire condition; a new revision with nothing new stays quiet',
    async run(at) {
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"already asked"}}' };
        },
      });
      try {
        // Step 1 carries NOTES.md; it is not tableable until step 2.
        const first = largeHostMessages();
        await mount.transform(sessionId, first);
        assert.equal(calls.length, 0, at('the first step asks nothing'));
        // The host rebuilds the request with the same unit and one more turn:
        // the carried unit is now eligible and is the first fire.
        const second = [...structuredClone(first), assistantMessage('msg_a3', [text('more')])];
        await mount.transform(sessionId, second);
        assert.equal(calls.length, 1, at('the step after the carrying request asks once'));
        assert.match(calls[0]?.prompt ?? '', /keep at most 70 percent of the total lines/u,
          at('the session\'s first table ask states the 70 percent share'));
        assert.doesNotMatch(calls[0]?.prompt ?? '', /keep at most 40 percent/u,
          at('the first ask never mixes in the later share'));
        // A revision that carries the same already-asked unit asks nothing.
        await mount.transform(sessionId, second);
        assert.equal(calls.length, 1, at('a revision with no new unit asks nothing'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 1, at('the idle fallback also stays quiet'));
        // A new result is a new unit, but it arrived in this step, so it is not
        // tableable yet; the step after the one that carries it asks once more.
        const third = [
          ...structuredClone(second),
          assistantMessage('msg_a4', [toolCall('call_2', 'read', { filePath: 'MORE.md' })]),
          toolMessage('msg_t2', [toolResult('call_2', 'read',
            textResult(`# More\n\n${'second-body-'.repeat(60)}\n`))]),
        ];
        await mount.transform(sessionId, third);
        assert.equal(calls.length, 1, at('the step that produced the new unit asks nothing'));
        const fourth = [...structuredClone(third)];
        await mount.transform(sessionId, fourth);
        assert.equal(calls.length, 2, at('the step after the carrying request asks again'));
        assert.match(calls[1]?.prompt ?? '', /keep at most 40 percent of the total lines/u,
          at('a later trigger states the 40 percent share'));
        assert.doesNotMatch(calls[1]?.prompt ?? '', /keep at most 70 percent/u,
          at('a later trigger never restates the first share'));
        assert.doesNotMatch(calls[1]?.prompt ?? '', /\[read\] NOTES\.md/u,
          at('the already-asked unit is not retabled'));
        assert.match(calls[1]?.prompt ?? '', /\[read\] MORE\.md/u,
          at('only the carried new unit is tabled'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 2, at('the idle fallback does not ask again'));
      } finally { await mount.close(); }
    } },
  { name: 'a generate failure is journalled as an ask error and is not retried by idle',
    async run(at) {
      const lines = journalLines();
      let calls = 0;
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async () => {
          calls += 1;
          throw new Error('transient seam down');
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries the unit and asks nothing; step 2's ask fails.
        await mount.transform(sessionId, largeHostMessages());
        assert.equal(calls, 0, at('the first step asks nothing'));
        await mount.transform(sessionId, largeHostMessages());
        assert.equal(calls, 1, at('the step after the carrying request asks once'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        const ask = lines.of('ask');
        assert.equal(ask.length, 0, at('a failed generate writes no ask fire line'));
        const errors = lines.of('ask-error');
        assert.equal(errors.length, 1, at('the failed attempt is recorded as one ask-error line'));
        assert.equal(errors[0]?.['stage'], 'generate', at('the line names the generate stage'));
        assert.match(String(errors[0]?.['message']), /seam down/u, at('the message is carried'));
        assert.equal(errors[0]?.['retry'], 'next revision at most once',
          at('the retry policy is recorded on the error'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls, 1, at('the same revision is not retried in a loop'));
        assert.equal(mount.sessions.get(sessionId)?.askFires, 0,
          at('a failed call is not a fire'));
      } finally { await mount.close(); }
    } },
  { name: 'the at-rest removal still applies on the transform after an ask', async run(at) {
    let stages = 0;
    let armed = false;
    const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
      const inner = createOpencodePort({
        ...options,
        capabilities: { ...createOpencodeCapabilities({ wireRevert: true }), revertHistory: true },
        deriveRevert: testDerive,
      });
      return {
        snapshot: async () => {
          if (armed && stages === 0) {
            stages += 1;
            const base = await inner.snapshot();
            const result = await inner.apply(stagedRequest(base.revision, 'intent-after-ask'));
            assert.equal(result.status, 'applied', at('the test port stages one derivation'));
          }
          return inner.snapshot();
        },
        apply: request => inner.apply(request),
        lookupReceipt: intentId => inner.lookupReceipt(intentId),
        observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
        commit: () => inner.commit(),
      };
    };
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' }, createPort,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        return { text: '{"1":{"forgetall":true,"summary":"after ask"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = largeHostMessages();
      const ids = messages.map(message => message.id);
      // Step 1 carries the unit and asks nothing.
      await mount.transform(sessionId, messages);
      assert.equal(messages.length, ids.length, at('the first transform staged nothing'));
      assert.equal(calls.length, 0, at('the first transform asks nothing'));
      // Step 2 is the host's rebuild; the carried unit is tabled and applied.
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, at('the step after the carrying request asked once'));
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        at('the ask removed the carried unit on the second transform'));
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls.length, 1, at('the idle fallback did not ask again'));
      armed = true;
      // A completed turn adds one assistant message, then the next transform
      // observes THAT array by reference — the one `commit` may splice.
      messages.push(assistantMessage('msg_a3', [text('next turn')]));
      await mount.transform(sessionId, messages);
      assert.equal(stages, 1, at('the next transform ran one staged at-rest plan'));
      assert.equal(messages.length, ids.length + 1,
        at('one message removed, one receipt appended, the new turn kept'));
      assert.equal(messages.at(-1)?.[OPENCODE_RECORD_ID_FIELD], 'racoons-record:intent-c6:0',
        at('the at-rest removal applied after the ask'));
      const committed = lines.of('commit').filter(line => line['committed'] === true);
      assert.ok(committed.length >= 1, at('a commit line says the removal reached the array'));
      assert.equal(calls.length, 1,
        at('the later transform sends no ask: it carried no new eligible unit'));
    } finally { await mount.close(); }
  } },
  { name: 'a unit the same hook\'s at-rest pass removes before it shipped is never tabled',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        const messages = staleReadMessages();
        // The stale read first appears in this request; the at-rest pass removes
        // it before it ships, so the model never sees it and the ask never names
        // it (ADR-0054 decision 7).
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 0, at('the ask sends nothing: the unit arrived in this step'));
        assert.equal(lines.of('ask').length, 0, at('no ask line was written'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the step pass still removed the stale read out of the host array'));
        assert.equal(lines.of('at-rest').find(line => line['reason'] === 'step')?.['status'],
          'applied', at('the step pass is the at-rest lane that removed the read'));
        assert.equal(lines.of('commit').at(-1)?.['committed'], true,
          at('the removal reached the host array'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 0, at('the idle fallback asks nothing either'));
      } finally { await mount.close(); }
    } },
  { name: 'the at-rest pass removes the stale read before the ask can table it',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          throw new Error('transient ask seam down');
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries the read; step 2 adds the write that makes it stale.
        // The at-rest pass removes it first, so the prune pass has no unit to
        // table and the transient seam is never called.
        await mount.transform(sessionId, largeHostMessages());
        assert.equal(calls.length, 0, at('the first transform asks nothing'));
        const messages = [
          ...largeHostMessages(),
          // A fresh above-floor result that arrived in this request: it is not
          // tableable yet and is counted `unseen`, never shown as a bare row.
          assistantMessage('msg_a_fresh',
            [toolCall('call_fresh', 'read', { filePath: 'FRESH.md' })]),
          toolMessage('msg_t_fresh', [toolResult('call_fresh', 'read',
            textResult(`# Fresh\n\n${'fresh-'.repeat(120)}\n`))]),
          assistantMessage('msg_a_write',
            [toolCall('call_write', 'write', { filePath: 'NOTES.md' })]),
          toolMessage('msg_t_write', [toolResult('call_write', 'write', textResult('written'))]),
        ];
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 0,
          at('the stale read is removed before a table could name it'));
        assert.deepEqual(lines.of('ask-error'), [],
          at('no ask error is written: no ask was attempted'));
        assert.deepEqual(lines.of('ask'), [], at('no ask line is written'));
        const steps = lines.of('at-rest').filter(line => line['reason'] === 'step');
        assert.equal(steps.at(-1)?.['status'], 'applied',
          at('the step pass still applied its stale-read removal'));
        assert.equal(lines.of('commit').at(-1)?.['committed'], true,
          at('the removal still reached the host array'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the stale read left the host array despite the failed ask'));
        const entry = mount.sessions.get(sessionId);
        assert.equal(entry?.askFires, 0, at('no fire is counted'));
        assert.equal(entry?.askedUnitIds.size, 0, at('the failed units are released for one retry'));
      } finally { await mount.close(); }
    } },
  { name: 'a failed step ask retries once on a later revision, never on the same one',
    async run(at) {
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          if (calls.length === 1) throw new Error('step seam down');
          return { text: '{"1":{"forgetall":true,"summary":"other note"}}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        // Step 1 carries OTHER.md and the at-rest pass removes the stale
        // NOTE.md read before it ever ships.
        await mount.transform(sessionId, staleReadAndOtherMessages());
        assert.equal(calls.length, 0, at('the first transform asks nothing'));
        const messages = staleReadAndOtherMessages();
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 1, at('the step ask failed'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the step pass removed the stale read'));
        assert.equal(messages.some(message => message.id === 'msg_t2'), true,
          at('the other read survived the step pass'));
        assert.doesNotMatch(calls[0]?.prompt ?? '', /NOTE\.md/u,
          at('the read that never shipped is not tabled'));
        assert.match(calls[0]?.prompt ?? '', /OTHER\.md/u,
          at('the carried read is the one tabled'));
        assert.equal(mount.sessions.get(sessionId)?.stepAskFired, false,
          at('a failed step ask did not fire'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 1,
          at('the failed revision is not retried by idle: same-revision guard'));
        const ask = lines.of('ask');
        assert.equal(ask.length, 0, at('no fire was recorded for the failed revision'));
        // A later main request is a new revision: the released unit is retried
        // there, once, and the step path names the fire.
        const later = [...messages, assistantMessage('msg_turn_retry', [text('a later turn')])];
        await mount.transform(sessionId, later);
        assert.equal(calls.length, 2, at('the later revision retries the released unit once'));
        const retried = lines.of('ask');
        assert.equal(retried.length, 1, at('the readable retry is one fire'));
        assert.equal(retried[0]?.['origin'], 'step', at('the retry line names the step origin'));
        assert.equal(retried[0]?.['rowCount'], 1, at('only the surviving unit is retabled'));
        assert.doesNotMatch(calls[1]?.prompt ?? '', /NOTE\.md/u,
          at('the unit the step pass removed is not tabled again'));
        assert.match(calls[1]?.prompt ?? '', /OTHER\.md/u, at('the surviving unit is tabled'));
        await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
        assert.equal(calls.length, 2, at('a second idle does not ask again'));
      } finally { await mount.close(); }
    } },
  { name: 'two eligible units are one multi-row ask, parsed whole and both applied', async run(at) {
    let stages = 0;
    let armed = false;
    const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
      const inner = createOpencodePort({
        ...options,
        capabilities: { ...createOpencodeCapabilities({ wireRevert: true }), revertHistory: true },
        deriveRevert: testDerive,
      });
      return {
        snapshot: async () => {
          if (armed && stages === 0) {
            stages += 1;
            const base = await inner.snapshot();
            const result = await inner.apply(stagedRequest(base.revision, 'intent-after-ask'));
            assert.equal(result.status, 'applied', at('the test port stages one derivation'));
          }
          return inner.snapshot();
        },
        apply: request => inner.apply(request),
        lookupReceipt: intentId => inner.lookupReceipt(intentId),
        observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
        commit: () => inner.commit(),
      };
    };
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' }, createPort,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        return { text: '{"1":{"forgetall":true,"summary":"alpha"}}\n'
          + '{"2":{"forgetall":true,"summary":"bravo"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = largeTwoResultMessages();
      const ids = messages.map(message => message.id);
      // Step 1 carries both units and asks nothing; step 2 tables both.
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 0, at('the first transform asks nothing'));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, at('the step after the carrying request sends one multi-row ask'));
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls.length, 1, at('the idle fallback does not send a second ask'));
      const prompt = calls[0]?.prompt ?? '';
      assert.match(prompt, /^1\. \[read\] NOTES\.md/mu, at('the first row is addressed'));
      assert.match(prompt, /^2\. \[read\] OTHER\.md/mu, at('the second row is addressed'));
      assert.doesNotMatch(prompt, /^3\. \[/mu, at('no third table row is invented'));
      const ask = lines.of('ask');
      assert.equal(ask.length, 1, at('one ask line for the one fire'));
      assert.equal(ask[0]?.['origin'], 'step', at('the line names the step as its origin'));
      assert.equal(ask[0]?.['rowCount'], 2, at('the line names the multi-row table'));
      assert.deepEqual(ask[0]?.['indices'], [1, 2], at('both assigned indices are recorded'));
      assert.equal(ask[0]?.['answered'], 2, at('both replies are parsed'));
      assert.equal(ask[0]?.['refused'], 0, at('no row was refused'));
      assert.equal(ask[0]?.['applied'], false,
        at('the ask line itself applies nothing; the ask-apply lines name the removals'));
      assert.deepEqual(ask[0]?.['dropped'], {
        subFloor: 0, unseen: 0, asked: 0, orphan: 0, recallAnswer: 0, contained: 0,
        errorResult: 0, l1Removed: 0, dedupeRemoved: 0,
      }, at('every carried unit reached the table'));
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        at('the first tabled unit left the host array'));
      assert.equal(messages.some(message => message.id === 'msg_t2'), false,
        at('the second tabled unit left the host array'));
      const appliedAsk = lines.of('ask-apply');
      assert.equal(appliedAsk.length, 2, at('one ask-apply line per applied unit'));
      assert.equal(appliedAsk.every(line => line['applied'] === true), true,
        at('both units landed through the ask apply'));
      // The at-rest lane still applies on the next transform, after the ask.
      armed = true;
      messages.push(assistantMessage('msg_a4', [text('next turn')]));
      await mount.transform(sessionId, messages);
      assert.equal(stages, 1, at('the next transform ran one staged at-rest plan'));
      assert.equal(messages.length, ids.length + 1,
        at('one message removed, one receipt appended, the new turn kept'));
      assert.equal(messages.at(-1)?.[OPENCODE_RECORD_ID_FIELD], 'racoons-record:intent-c6:0',
        at('the at-rest removal applied after the multi-row ask'));
      assert.equal(calls.length, 1,
        at('the later transform sent no ask: it carried no new eligible unit'));
    } finally { await mount.close(); }
  } },
  { name: 'the store keeps a readable forgetall with its round; keeps and refused rows re-table',
    async run(at) {
    const probe = largeThreeResultMessages();
    const probeBatch = buildOpencodeAskBatch({
      sessionId, messages: probe,
      port: createOpencodePort({ sessionId, clock: { nowMs: () => 1 }, messages: probe }),
    });
    assert.ok(probeBatch !== null, at('the probe table is built'));
    const [firstUnit, secondUnit, thirdUnit] = probeBatch.unitIds;
    assert.ok(firstUnit !== undefined, at('the first unit is tabled'));
    assert.ok(secondUnit !== undefined, at('the second unit is tabled'));
    assert.ok(thirdUnit !== undefined, at('the third unit is tabled'));
    // Row 2's own L: the unit body is the result text, so a whole-range
    // `keeplines` names 1..L, not 1..1 (ISSUE-509).
    const secondUnitLines = (probeBatch.rows[1]?.unit.span.lineRange?.endLineInclusive ?? 0)
      - (probeBatch.rows[1]?.unit.span.lineRange?.startLine ?? 0) + 1;
    assert.ok(secondUnitLines > 1, at('the kept row is the result\'s multi-line body'));
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          // Row 1 forgets, row 2 keeps whole, row 3 is a malformed row (its
          // forgetall carries no summary). One JSON object per line, three
          // readings.
          return { text: '{"1":{"forgetall":true,"summary":"old read"}}\n'
            + `{"2":{"keeplines":[[1,${String(secondUnitLines)}]],"summary":"None"}}\n`
            + '{"3":{"forgetall":true}}' };
        }
        // The later table carries the kept row (index 2) and the refused row
        // (index 3); only the kept one is answered again.
        return { text: '{"2":{"forgetall":true,"summary":"new read"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      // Step 1 carries all three units; step 2 tables them.
      await mount.transform(sessionId, largeThreeResultMessages());
      assert.equal(calls.length, 0, at('the first transform asks nothing'));
      const messages = largeThreeResultMessages();
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, at('the step after the carrying request asked once'));
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        at('the stored forgetall left the host array'));
      assert.equal(messages.some(message => message.id === 'msg_t2'), true,
        at('the keepall unit never leaves'));
      assert.equal(messages.some(message => message.id === 'msg_t3'), true,
        at('the unreadable row keeps its unit'));
      const appliedAsk = lines.of('ask-apply');
      assert.equal(appliedAsk.length, 1, at('one ask-apply line for the one applied unit'));
      assert.equal(appliedAsk[0]?.['unitId'], firstUnit,
        at('the line names the stored forgetall unit'));
      assert.equal(appliedAsk[0]?.['applied'], true, at('the stored forgetall applied'));
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, at('the context hook built the session'));
      const ask = lines.of('ask')[0];
      assert.ok(ask !== undefined, at('one ask fire line was written'));
      assert.deepEqual(ask['parsed'], [
        { index: 1, status: 'answered', action: 'forgetall' },
        { index: 2, status: 'answered', action: 'keepall' },
        { index: 3, status: 'refused', code: 'malformed-row', detail: 'summary-missing' },
      ], at('the keep is recorded as the offered keep, and the malformed row keeps'));
      assert.equal(entry.askVerdicts.size, 1, at('only the readable forgetall is stored'));
      const stored = entry.askVerdicts.get(firstUnit);
      assert.ok(stored !== undefined, at('the forgetall is stored under its unit'));
      assert.equal(stored.verdict.action, 'forgetall', at('the stored verdict is a forgetall'));
      assert.equal(stored.verdict.unitId, firstUnit, at('the verdict names its unit'));
      if (stored.verdict.action === 'forgetall') {
        assert.equal(stored.verdict.summary, 'old read', at('the summary is kept'));
      }
      assert.equal(stored.verdict.answeredInRound, 2,
        at('the verdict carries the pass round it answered in'));
      assert.equal(entry.askVerdicts.has(secondUnit), false,
        at('a keepall row is never stored for apply'));
      assert.equal(entry.askVerdicts.has(thirdUnit), false,
        at('an unreadable row stores nothing'));
      assert.deepEqual([...entry.askedUnitIds], [firstUnit],
        at('only the answered forgetall stays permanently claimed'));
      assert.deepEqual([...entry.refusedRetriedUnitIds], [thirdUnit],
        at('the refused row is released for its one re-ask'));
      assert.equal(entry.askedUnitIds.has(secondUnit), false,
        at('a keep releases its unit for a later crossing'));
      assert.deepEqual(ask['kept'], [{ index: 2, unitId: secondUnit, action: 'keepall' }],
        at('the ask line names the kept row'));
      assert.deepEqual(ask['carried'], [
        { index: 3, unitId: thirdUnit, code: 'malformed-row' },
      ], at('the ask line names the refused row it carries once'));
      assert.deepEqual(ask['excluded'], [], at('no row is excluded by its first refusal'));
      // The host rebuilds the same three units and adds one new result. The
      // kept row and the refused row come back at this later revision; FOURTH.md
      // arrived in this request, so it waits one more step.
      const withFourth = (turn: string): OpencodeMessage[] => [
        ...structuredClone(largeThreeResultMessages()),
        assistantMessage('msg_a5', [toolCall('call_4', 'read', { filePath: 'FOURTH.md' })]),
        toolMessage('msg_t4', [toolResult('call_4', 'read',
          textResult(`# Fourth\n\n${'delta-'.repeat(120)}\n`))]),
        assistantMessage(turn, [text('another turn')]),
      ];
      await mount.transform(sessionId, withFourth('msg_turn_2'));
      assert.equal(calls.length, 2,
        at('the kept row and the refused retry are tabled at the later revision'));
      const secondPrompt = calls[1]?.prompt ?? '';
      assert.doesNotMatch(secondPrompt, /NOTES\.md/u, at('the forgetall row is never asked again'));
      assert.match(secondPrompt, /\[read\] OTHER\.md/u, at('the kept row is tabled again'));
      assert.match(secondPrompt, /\[read\] THIRD\.md/u, at('the refused row gets its one re-ask'));
      assert.doesNotMatch(secondPrompt, /FOURTH\.md/u,
        at('a result that arrived in this request is not tabled yet'));
      const secondAsk = lines.of('ask')[1];
      assert.ok(secondAsk !== undefined, at('the later revision wrote its own ask line'));
      assert.deepEqual(secondAsk['retried'], [{ index: 3, unitId: thirdUnit }],
        at('the ask line names the retried row'));
      assert.deepEqual(secondAsk['excluded'], [
        { index: 3, unitId: thirdUnit, code: 'missing-index' },
      ], at('the second refusal is final and journalled'));
      assert.equal(entry.askVerdicts.size, 2, at('the second fire stores its own forgetall'));
      const added = [...entry.askVerdicts.keys()].find(key => key !== firstUnit);
      assert.ok(added !== undefined, at('the second stored verdict has its own unit'));
      assert.equal(entry.askVerdicts.get(added)?.verdict.answeredInRound, 3,
        at('the second fire stamps its own round'));
      assert.equal(entry.askedUnitIds.has(thirdUnit), true,
        at('the twice-refused unit is permanently claimed'));
      assert.equal(entry.refusedRetriedUnitIds.size, 0,
        at('no retry remains outstanding'));
      // The next revision tables FOURTH.md as a first offer; nothing else returns.
      await mount.transform(sessionId, withFourth('msg_turn_3'));
      assert.equal(calls.length, 3, at('the step after FOURTH.md shipped tables it'));
      const thirdPrompt = calls[2]?.prompt ?? '';
      assert.doesNotMatch(thirdPrompt, /NOTES\.md|OTHER\.md|THIRD\.md/u,
        at('settled rows are never tableable again'));
      assert.match(thirdPrompt, /\[read\] FOURTH\.md/u, at('FOURTH.md is the one new row'));
      assert.deepEqual(lines.of('ask')[2]?.['retried'], [],
        at('a first offer is never labelled a retry'));
    } finally { await mount.close(); }
  } },
  { name: 'one ask fire: the forgetall leaves, re-applies under a new id, and a keepall stays',
    async run(at) {
      const probe = largeTwoResultMessages();
      const probeBatch = buildOpencodeAskBatch({
        sessionId, messages: probe,
        port: createOpencodePort({ sessionId, clock: { nowMs: () => 1 }, messages: probe }),
      });
      assert.ok(probeBatch !== null, at('the probe table is built'));
      const [forgottenUnitId, keptUnitId] = probeBatch.unitIds;
      assert.ok(forgottenUnitId !== undefined, at('the forgetall unit is tabled'));
      assert.ok(keptUnitId !== undefined, at('the keeplines unit is tabled'));
      // Row 2's own L: the body is the result text, so a whole-range keep is
      // 1..L (ISSUE-509).
      const keptLines = (probeBatch.rows[1]?.unit.span.lineRange?.endLineInclusive ?? 0)
        - (probeBatch.rows[1]?.unit.span.lineRange?.startLine ?? 0) + 1;
      assert.ok(keptLines > 1, at('the kept row is the result\'s multi-line body'));
      const lines = journalLines();
      const calls: OpencodeGenerateInput[] = [];
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async (input) => {
          calls.push(input);
          // Row 1 forgets whole; row 2 keeps whole (a whole-range keeplines),
          // so it never reaches the stored verdict map.
          return { text: '{"1":{"forgetall":true,"summary":"old note"}}\n'
            + `{"2":{"keeplines":[[1,${String(keptLines)}]],"summary":"None"}}` };
        },
        journal: record => lines.records.push(record),
      });
      try {
        const messages = largeTwoResultMessages();
        const store = structuredClone(messages) as OpencodeMessage[];
        // Step 1 carries both units and asks nothing; step 2 tables and applies
        // the forgetall.
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 0, at('the first transform asks nothing'));
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 1, at('the step after the carrying request asked once'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the answered forgetall unit left the array'));
        assert.equal(messages.some(message => message.id === 'msg_t2'), true,
          at('the keepall unit never leaves'));

        const firstLines = lines.of('ask-apply');
        assert.equal(firstLines.length, 1, at('one ask-apply line for the one applied unit'));
        const first = firstLines[0];
        assert.ok(first !== undefined, at('the first ask-apply line exists'));
        assert.equal(first['applied'], true, at('the engine returned a new applied receipt'));
        assert.equal(first['unitId'], forgottenUnitId, at('the line names the removed unit'));
        assert.equal(first['status'], 'applied', at('the line records the engine status'));
        assert.equal(first['committed'], true, at('the port committed the rewrite'));
        assert.match(String(first['eventId']), new RegExp(`^oc:${sessionId}:ask:`),
          at('the id uses its own ask namespace'));
        assert.doesNotMatch(String(first['eventId']), /#/u,
          at('the first apply at the revision keeps the bare id'));
        const receipt = messages.find(message =>
          typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
        assert.ok(receipt !== undefined, at('the array carries the receipt'));
        assert.equal(receipt?.[OPENCODE_FORGOTTEN_NODE_FIELD], first['nodeId'],
          at('the receipt names the node the ask-apply line names'));
        const recallId = first['recallId'];
        assert.equal(typeof recallId, 'string', at('the line names the recall id'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));
        const recalled = await entry.ledger.recall(String(recallId));
        assert.ok(recalled.parts.length >= 1, at('the first recall id resolves'));
        assert.equal(entry.askVerdicts.size, 1, at('only the forgetall was stored'));
        assert.equal(entry.askVerdicts.has(keptUnitId), false,
          at('the keepall unit is never stored for apply'));

        // The host rebuilds the request from its own store; the same content
        // returns at the same revision and the stored verdict must apply again.
        messages.splice(0, messages.length, ...(structuredClone(store) as OpencodeMessage[]));
        await mount.transform(sessionId, messages);
        assert.equal(calls.length, 1, at('no second ask: every unit was already asked'));
        const secondLines = lines.of('ask-apply');
        assert.equal(secondLines.length, 2, at('the rebuilt request re-applied the verdict'));
        const second = secondLines[1];
        assert.ok(second !== undefined, at('the second ask-apply line exists'));
        assert.equal(second['applied'], true, at('the second apply landed a new receipt'));
        assert.equal(second['unitId'], forgottenUnitId, at('the line names the same unit'));
        assert.notEqual(second['intentId'], first['intentId'],
          at('the second apply is its own intent'));
        assert.equal(second['eventId'], `${String(first['eventId'])}#2`,
          at('the second apply gets its own id suffix'));
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          at('the rebuilt request lost the answered unit too'));
        assert.equal(messages.some(message => message.id === 'msg_t2'), true,
          at('the keepall unit survives the second transform'));
        const secondReceipts = messages.filter(message =>
          typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
        assert.equal(secondReceipts.length, 1, at('one receipt on the rebuilt request'));
        assert.equal(secondReceipts[0]?.[OPENCODE_FORGOTTEN_NODE_FIELD], second['nodeId'],
          at('the second receipt names the removed node'));
        assert.equal(secondLines.some(line => line['unitId'] === keptUnitId), false,
          at('no ask-apply line ever names the keeplines unit'));
        const secondRecall = second['recallId'];
        assert.equal(typeof secondRecall, 'string', at('the second line names a recall id'));
        await entry.ledger.recall(String(secondRecall));
      } finally { await mount.close(); }
    } },
  { name: 'the apply skips while an ask is in flight and when the window is not positive',
    async run(at) {
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { databasePath: ':memory:' },
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({
          text: '{"1":{"forgetall":true,"summary":"old note"}}',
        }),
        journal: record => lines.records.push(record),
      });
      try {
        const messages = largeHostMessages();
        const store = structuredClone(messages) as OpencodeMessage[];
        // Step 1 carries the unit and asks nothing; step 2 applies the ask.
        await mount.transform(sessionId, messages);
        assert.equal(lines.of('ask-apply').length, 0, at('the first transform applies nothing'));
        await mount.transform(sessionId, messages);
        assert.equal(lines.of('ask-apply').length, 1,
          at('the step after the carrying request applied'));
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, at('the context hook built the session'));

        // The host rebuilds the request with the unit present again, then the
        // context hook runs while this session's own ask is in flight.
        messages.splice(0, messages.length, ...(structuredClone(store) as OpencodeMessage[]));
        entry.askInFlight = true;
        try {
          await mount.transform(sessionId, messages);
        } finally {
          entry.askInFlight = false;
        }
        assert.equal(messages.some(message => message.id === 'msg_t1'), true,
          at('no apply while an ask is in flight'));
        assert.equal(lines.of('ask-apply').length, 1,
          at('the in-flight transform wrote no ask-apply line'));

        // The as-shipped estimate is always positive, so the zero/NaN arms call
        // the apply seam with the window the guard must refuse.
        const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
          lines.records.push({ kind, atMs: 1, ...fields });
        };
        const before = structuredClone(messages);
        assert.equal(await applyOpencodeAskVerdicts({
          entry, messages, snapshot: entry.port.observe(messages), window: 0, journal: sink,
        }), false, at('window 0 applies nothing'));
        assert.deepEqual(messages, before, at('the unit is still in the array'));
        assert.equal(await applyOpencodeAskVerdicts({
          entry, messages, snapshot: entry.port.observe(messages),
          window: Number.NaN, journal: sink,
        }), false, at('a non-integer window applies nothing'));
        assert.deepEqual(messages, before, at('the array is unchanged after both skips'));
        assert.equal(lines.of('ask-apply').length, 1,
          at('a non-positive window writes no ask-apply line'));
      } finally { await mount.close(); }
    } },
];

test('the bench-only ask: off by default, one request per unasked revision, forgetall applied',
  async () => {
    await runRows(ASK_ROWS);
  });

/** Six lines above the floor: line numbers a `keeplines` answer can address. */
const PARTIAL_KEEP_LINES = [
  `line-one ${'-'.repeat(120)}`,
  `line-two ${'-'.repeat(120)}`,
  `line-three KEEP_A ${'-'.repeat(110)}`,
  `line-four KEEP_B ${'-'.repeat(110)}`,
  `line-five KEEP_C ${'-'.repeat(110)}`,
  `line-six ${'-'.repeat(124)}`,
];
const PARTIAL_KEEP_BODY = `${PARTIAL_KEEP_LINES.join('\n')}\n`;
const PARTIAL_KEPT_TEXT = `${PARTIAL_KEEP_LINES[2]}\n${PARTIAL_KEEP_LINES[3]}\n`
  + `${PARTIAL_KEEP_LINES[4]}\n`;

function partialKeepConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(PARTIAL_KEEP_BODY))]),
    assistantMessage('msg_a2', [text('The note is read.')]),
  ];
}

/** The first tool-result part's decoded result text, as the host carries it. */
function resultTextOf(messages: readonly OpencodeMessage[]): string {
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== 'tool-result') continue;
      const result = (part as unknown as { readonly result: OpencodeToolResultValue }).result;
      return result.type === 'text' && typeof result.value === 'string'
        ? result.value : JSON.stringify(result.value);
    }
  }
  throw new Error('the fixture carries no tool result');
}

test('ISSUE-509: a partial keeplines rides the prune document; a whole-range keep never does',
  async () => {
    // Partial: rows 3-5 are kept, 1-2 and 6 leave. The mount's own ask lane
    // reads the answer and the one prune document carries the removal.
    const lines = journalLines();
    const partial = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({
        text: '{"1":{"keeplines":[[3,5]],"summary":"keep the middle"}}',
      }),
      journal: record => lines.records.push(record),
    });
    try {
      await partial.transform(sessionId, partialKeepConversation());
      const messages = partialKeepConversation();
      await partial.transform(sessionId, messages);
      const ask = lines.of('ask').at(-1);
      assert.deepEqual(ask?.['parsed'], [
        { index: 1, status: 'answered', action: 'keeplines' },
      ], 'the reader answered the partial keep, never refused it');
      const applied = lines.of('ask-apply');
      assert.equal(applied.length, 1, 'the one prune document carries the partial removal');
      assert.equal(applied[0]?.['action'], 'keeplines', 'the removal is the line-level action');
      assert.equal(applied[0]?.['applied'], true, 'the apply landed a receipt');
      assert.equal(resultTextOf(messages), PARTIAL_KEPT_TEXT,
        'the typed result part carries ONLY the kept lines');
      assert.equal(messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'tool-call' && part['id'] === 'call_1')),
      true, 'the call part stays: the unit is kept, the unlisted lines leave');
      const receipt = messages.find(message =>
        typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
      assert.ok(receipt !== undefined, 'the removal appended its receipt');
      const entry = partial.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session exists');
      const recallId = applied[0]?.['recallId'];
      assert.equal(typeof recallId, 'string', 'the removal names the recall id');
      const recalled = await entry.ledger.recall(String(recallId));
      const restored = recalled.parts
        .map(part => new TextDecoder().decode(part.bytes)).join('');
      assert.match(restored, /line-one/u, 'the recall restores the dropped lines');
      // The next request: the host rebuilds the array and the mount re-applies
      // the stored verdict, so the request it ships still carries only the kept
      // lines and still holds the unit's call part.
      messages.push(assistantMessage('msg_a3', [text('Continue.')]));
      await partial.transform(sessionId, messages);
      assert.equal(resultTextOf(messages), PARTIAL_KEPT_TEXT,
        'the next request still carries only the kept lines');
      assert.equal(messages.some(message => message.id === 'msg_t1'), true,
        'a partial keep never removes the unit whole');
    } finally { await partial.close(); }

    // Whole range: the reader normalizes it to a clean keep, so the prune
    // document carries no removal and the host array is unchanged byte for byte.
    const wholeLines = journalLines();
    const whole = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({
        text: '{"1":{"keeplines":[[1,6]],"summary":"None"}}',
      }),
      journal: record => wholeLines.records.push(record),
    });
    try {
      await whole.transform(sessionId, partialKeepConversation());
      const messages = partialKeepConversation();
      const untouched = structuredClone(messages);
      await whole.transform(sessionId, messages);
      const ask = wholeLines.of('ask').at(-1);
      assert.deepEqual(ask?.['parsed'], [
        { index: 1, status: 'answered', action: 'keepall' },
      ], 'a whole-range keeplines is the clean keep');
      assert.deepEqual(wholeLines.of('ask-apply'), [],
        'a whole-range keep is never part of the prune document');
      assert.deepEqual(messages, untouched, 'a keep changes no host message');
    } finally { await whole.close(); }
  });

test('ISSUE-509: a remount re-applies a partial keep, never a whole-unit forgetall', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  try {
    // Process 1: the ask answers a partial keep and the apply rewrites the
    // result part. The durable ask record must keep the line-level verdict.
    const firstLines = journalLines();
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({
        text: '{"1":{"keeplines":[[3,5]],"summary":"keep the middle"}}',
      }),
      journal: record => firstLines.records.push(record),
    });
    try {
      // Fresh install: the boundary is captured before the unit arrives.
      await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
      await first.transform(sessionId, partialKeepConversation());
      const applied = partialKeepConversation();
      await first.transform(sessionId, applied);
      assert.equal(firstLines.of('ask-apply')[0]?.['action'], 'keeplines',
        'the first process applied the line-level removal');
      assert.equal(resultTextOf(applied), PARTIAL_KEPT_TEXT,
        'the first process kept lines 3-5');
    } finally { await first.close(); }

    // Process 2: the host rebuilds from its own store, so the full body is
    // back. The banked applied-plan row is a blank-summary forgetall and cannot
    // reconstruct the kept lines; the durable keeplines verdict must.
    const secondLines = journalLines();
    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{}' }),
      journal: record => secondLines.records.push(record),
    });
    try {
      const rebuilt = partialKeepConversation();
      await second.transform(sessionId, rebuilt);
      assert.equal(resultTextOf(rebuilt), PARTIAL_KEPT_TEXT,
        'the remount still keeps lines 3-5, not the whole unit');
      assert.equal(rebuilt.some(message => message.id === 'msg_t1'), true,
        'the remount does not remove the result message whole');
      assert.equal(rebuilt.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'tool-call' && part['id'] === 'call_1')),
      true, 'the remount does not remove the call part whole');
      const resumedLines = secondLines.of('ask-apply');
      assert.equal(resumedLines.length, 1,
        'the remount lands exactly one removal for the unit');
      const resumed = resumedLines[0];
      assert.equal(resumed?.['action'], 'keeplines',
        'the remount re-applied the line-level rewrite');
      assert.equal(resumed?.['applied'], true, 'the remount landed its receipt');
      assert.deepEqual(secondLines.of('ask'), [],
        'the banked unit is never re-asked after the remount');
    } finally { await second.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-509: a partial keep whose unit leaves the array takes its durable record with it',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    const target = () =>
      sessionStorage(resolveStorage({ crematorStorageRoot: root }), sessionId);
    try {
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({
          text: '{"1":{"keeplines":[[3,5]],"summary":"keep the middle"}}',
        }),
        journal: record => lines.records.push(record),
      });
      try {
        // Fresh install, then the ask answers and the apply rewrites the part.
        await mount.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
        await mount.transform(sessionId, partialKeepConversation());
        await mount.transform(sessionId, partialKeepConversation());
        const entry = mount.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the session exists');
        assert.equal(entry.durableAskVerdicts.size, 1,
          'the partial keep is owed after its apply');
        assert.equal(readDurableAskState(target())?.verdicts.length, 1,
          'the durable file carries the partial keep');
        // The host drops the unit but keeps a conversation (a compaction or a
        // different rebuild): the obligation ends with the unit, so the record
        // must not outlive it. One other above-floor unit keeps the pass real.
        const survivors: OpencodeMessage[] = [
          userMessage('msg_survivor_u', [text('Read the other note.')]),
          assistantMessage('msg_survivor_a',
            [toolCall('call_other', 'read', { filePath: 'OTHER.md' })]),
          toolMessage('msg_survivor_t', [toolResult('call_other', 'read',
            textResult(PARTIAL_KEEP_BODY))]),
          assistantMessage('msg_survivor_end', [text('Done.')]),
        ];
        await mount.transform(sessionId, survivors);
        assert.equal(entry.durableAskVerdicts.size, 0,
          'the owed verdict is gone with its unit');
        assert.equal(entry.askVerdicts.size, 0, 'the in-memory verdict is gone');
        assert.equal(readDurableAskState(target())?.verdicts.length, 0,
          'the durable file no longer carries the partial keep');
        assert.equal(survivors.some(message => message.id === 'msg_survivor_t'), true,
          'the surviving unit is untouched');
      } finally { await mount.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('a whole-range keeplines row is re-tabled at a later crossing; a forgetall row never is', async () => {
  const probe = largeTwoResultMessages();
  const probeBatch = buildOpencodeAskBatch({
    sessionId, messages: probe,
    port: createOpencodePort({ sessionId, clock: { nowMs: () => 1 }, messages: probe }),
    round: 1,
  });
  assert.ok(probeBatch !== null, 'the probe pass is built');
  const [forgottenUnitId, keptUnitId] = probeBatch.unitIds;
  assert.ok(forgottenUnitId !== undefined, 'the forgetall unit is tabled');
  assert.ok(keptUnitId !== undefined, 'the keep unit is tabled');
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      /**
       * The row's own line count from the table, so a whole-range `keeplines`
       * names 1..L. The body is the result text now (ISSUE-509), so L is the
       * result's own line count, never one.
       */
      const wholeRangeOf = (prompt: string, index: number): number => {
        const row = new RegExp(`^${String(index)}\\. \\[.*\\[([0-9]+) lines?\\]$`, 'mu')
          .exec(prompt);
        assert.ok(row?.[1] !== undefined, 'the row states its own line count');
        return Number(row[1]);
      };
      if (calls.length === 1) {
        // Row 1 forgets whole; row 2 keeps whole (a whole-range keeplines).
        return { text: '{"1":{"forgetall":true,"summary":"old note"}}\n'
          + `{"2":{"keeplines":[[1,${String(wholeRangeOf(input.prompt, 2))}]],"summary":"None"}}` };
      }
      // The later table carries only the kept unit; its index is the pass's own
      // (the settled row leaves a gap), so the reply answers the shown index.
      const shown = Number(/^([1-9]\d*)\. \[read\] OTHER/mu.exec(input.prompt)?.[1] ?? 1);
      return { text: JSON.stringify({
        [String(shown)]: { keeplines: [[1, wholeRangeOf(input.prompt, shown)]], summary: 'None' },
      }) };
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Step 1 carries both units; step 2 tables them.
    await mount.transform(sessionId, largeTwoResultMessages());
    assert.equal(calls.length, 0, 'the carrying request asks nothing');
    const asking = largeTwoResultMessages();
    const askingBefore = structuredClone(asking);
    await mount.transform(sessionId, asking);
    assert.equal(calls.length, 1, 'the step after the carrying request asks once');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.equal(entry.askVerdicts.has(forgottenUnitId), true,
      'the forgetall verdict is stored');
    assert.equal(entry.askedUnitIds.has(forgottenUnitId), true,
      'the forgetall unit is permanently claimed');
    assert.equal(entry.askedUnitIds.has(keptUnitId), false,
      'the keep releases its unit');
    assert.equal(entry.refusedRetriedUnitIds.has(keptUnitId), false,
      'a keep never enters the refusal retry set');
    const firstAsk = lines.of('ask')[0];
    assert.deepEqual(firstAsk?.['kept'], [
      { index: 2, unitId: keptUnitId, action: 'keepall' },
    ], 'the ask line journals the kept row');
    assert.deepEqual(firstAsk?.['carried'], [],
      'no row was refused, so none is carried');
    assert.deepEqual(firstAsk?.['terminal'], [],
      'no row answered an action the prompt does not offer');
    // The same revision delivered again cannot ask twice, even though the kept
    // unit is released: the revision guard is the second lock.
    await mount.transform(sessionId, structuredClone(askingBefore));
    assert.equal(calls.length, 1, 'the same revision is never asked twice');
    // A later revision: the host rebuilds both units; only the kept one is tabled.
    const later = [...largeTwoResultMessages(),
      assistantMessage('msg_turn_keep', [text('a later turn')])];
    await mount.transform(sessionId, later);
    assert.equal(calls.length, 2, 'the kept row is tabled at a later revision');
    const secondPrompt = calls[1]?.prompt ?? '';
    assert.doesNotMatch(secondPrompt, /NOTES\.md/u,
      'the forgetall unit is never re-tabled');
    assert.match(secondPrompt, /\[read\] OTHER\.md/u,
      'the kept unit is tabled again');
    const secondAsk = lines.of('ask')[1];
    assert.ok(secondAsk !== undefined, 'the later revision wrote its own ask line');
    assert.deepEqual(secondAsk['retried'], [],
      'a keep is a fresh offer, never a refusal retry');
    assert.deepEqual(secondAsk['kept'], [{ index: 2, unitId: keptUnitId, action: 'keepall' }],
      'the second keep releases the unit again');
    assert.equal(entry.askedUnitIds.has(keptUnitId), false,
      'the kept unit stays eligible for the next later revision');
    assert.equal(entry.refusedRetriedUnitIds.size, 0,
      'no refusal retry is outstanding');
  } finally { await mount.close(); }
});

test('ISSUE-509: the first ask states 70 percent and a resumed segment states 40', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const firstPrompts: string[] = [];
  const secondPrompts: string[] = [];
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        firstPrompts.push(input.prompt);
        // A whole-range keep: nothing is applied, but the ask did fire.
        return { text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}' };
      },
      journal: () => {},
    });
    try {
      // Install boundary first (no tool node), then the unit arrives later.
      await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
      await first.transform(sessionId, largeHostMessages());
      await first.transform(sessionId, largeHostMessages());
      const entry = first.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first mount built the session');
      assert.equal(firstPrompts.length, 1, 'the first mount asked once');
      assert.match(firstPrompts[0] ?? '', /keep at most 70 percent of the total lines/u,
        'the session\'s first table ask states 70 percent');
      assert.equal(entry.askFires, 1, 'the answered ask advanced the fire count');
    } finally { await first.close(); }

    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        secondPrompts.push(input.prompt);
        return { text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}' };
      },
      journal: () => {},
    });
    try {
      // A new revision carries the same unit plus one new read. The first
      // transform promotes the shipped nodes; the second is the one that asks.
      const withNew = (): OpencodeMessage[] => [
        ...largeHostMessages(),
        assistantMessage('msg_a_more', [toolCall('call_more', 'read', { filePath: 'MORE.md' })]),
        toolMessage('msg_t_more', [toolResult('call_more', 'read',
          textResult(`# More\n\n${'more-'.repeat(200)}\n`))]),
      ];
      await second.transform(sessionId, withNew());
      await second.transform(sessionId, withNew());
      assert.equal(secondPrompts.length, 1, 'the resumed segment asked once');
      assert.match(secondPrompts[0] ?? '', /keep at most 40 percent of the total lines/u,
        'a resumed segment states the later 40 percent share, not the first one');
      assert.doesNotMatch(secondPrompts[0] ?? '', /keep at most 70 percent/u,
        'the restored fire count does not restate the first share');
    } finally { await second.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-509: an ask-off mount never rewinds the 70/40 share line', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const prompts: string[] = [];
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({
        // A whole-range keep: the ask fires and removes nothing.
        text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}',
      }),
    });
    try {
      await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
      await first.transform(sessionId, largeHostMessages());
      await first.transform(sessionId, largeHostMessages());
      const entry = first.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first mount built the session');
      assert.equal(entry.askFires, 1, 'the first ask was answered');
    } finally { await first.close(); }

    // An ask-off mount opens the same session. It drops the restored claims and
    // verdicts, but the fire count is a fact about asks that already left.
    const off = createOpencodeMount({ storage: { crematorStorageRoot: root } });
    try {
      await off.transform(sessionId, [userMessage('msg_off_u', [text('Ask off.')])]);
    } finally { await off.close(); }

    const resumed = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        prompts.push(input.prompt);
        return { text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}' };
      },
    });
    try {
      // A new revision with one new unit; the second transform is the one
      // that may ask.
      const withNew = (): OpencodeMessage[] => [
        ...largeHostMessages(),
        assistantMessage('msg_a_more', [toolCall('call_more', 'read', { filePath: 'MORE.md' })]),
        toolMessage('msg_t_more', [toolResult('call_more', 'read',
          textResult(`# More\n\n${'more-'.repeat(200)}\n`))]),
      ];
      await resumed.transform(sessionId, withNew());
      await resumed.transform(sessionId, withNew());
      assert.equal(prompts.length, 1, 'the ask-on mount asked once');
      assert.match(prompts[0] ?? '', /keep at most 40 percent of the total lines/u,
        'the ask-off mount did not rewind the count, so the later ask states 40 percent');
      assert.doesNotMatch(prompts[0] ?? '', /keep at most 70 percent/u,
        'the earlier answered ask is not restated as the session first');
    } finally { await resumed.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-509: an invalid durable askFires reads as no fire, never a bad share', () => {
  const dir = scratch();
  const target = {
    kind: 'durable' as const,
    root: dir,
    sessionId,
    databasePath: join(dir, 'ledger.sqlite'),
    blobRoot: join(dir, 'blobs'),
  };
  const askDoc = (askFires: unknown): string => JSON.stringify({
    version: 1,
    ask: {
      revisions: [], askedUnitIds: [], retriedUnitIds: [], refusedRetriedUnitIds: [],
      verdicts: [], deferredApply: false, deferredFailures: 0, askFires,
    },
  });
  try {
    writeFileSync(join(dir, MOUNT_STATE_FILE), askDoc(-1), 'utf8');
    assert.equal(readDurableAskState(target)?.askFires, 0,
      'a negative count reads as no fire');
    writeFileSync(join(dir, MOUNT_STATE_FILE), askDoc('many'), 'utf8');
    assert.equal(readDurableAskState(target)?.askFires, 0,
      'a non-number count reads as no fire');
    writeFileSync(join(dir, MOUNT_STATE_FILE), JSON.stringify({
      version: 1,
      ask: {
        revisions: [], askedUnitIds: [], retriedUnitIds: [], refusedRetriedUnitIds: [],
        verdicts: [], deferredApply: false, deferredFailures: 0,
      },
    }), 'utf8');
    assert.equal(readDurableAskState(target)?.askFires, 0,
      'an absent count reads as no fire');
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-509: a failed ask never advances the first/later share flag', async () => {
  const prompts: string[] = [];
  let calls = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      prompts.push(input.prompt);
      calls += 1;
      if (calls === 1) throw new Error('transient seam down');
      return { text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}' };
    },
  });
  try {
    // Step 1 carries the unit; step 2's ask throws.
    await mount.transform(sessionId, largeHostMessages());
    await mount.transform(sessionId, largeHostMessages());
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.equal(prompts.length, 1, 'the first attempt left the process');
    assert.equal(entry.askFires, 0, 'a throw is never a fire');
    // The one retry, at a later revision, still states the session's first share.
    await mount.transform(sessionId, [...largeHostMessages(),
      assistantMessage('msg_turn_retry', [text('a later turn')])]);
    assert.equal(prompts.length, 2, 'the one retry was sent');
    assert.match(prompts[1] ?? '', /keep at most 70 percent of the total lines/u,
      'an unanswered throw leaves the 70 percent first share in place');
    assert.equal(entry.askFires, 1, 'the readable retry is the first fire');
  } finally { await mount.close(); }
});

// --- the depth trigger (ADR-0050): the mount-level latch --------------------
//
// The latch itself is core's `PruneWindowTrigger` (proven in the dsh suite).
// These tests prove the mount feeds it the host's reconciled reading, gates
// both ask paths on it, and honours the pass baseline, the 75% skip line and a
// native compaction. Each measured reading travels the real seam a host uses:
// a context hook pushes the request estimate, then `session.step.ended` states
// the prompt, and the NEXT hook observes the reconciled count.

test('the depth trigger asks at 60k on a 400k window, and not below it', async () => {
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Step 1 carries the unit; no request has been measured yet.
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 0, 'the carrying request asks nothing');
    // The first measured reading is one token under the bar.
    await mount.event(stepUsage('msg_depth_1', 59_999));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 0, 'a reading under the 60k bar sends no ask');
    const below = lines.of('prune-threshold').at(-1);
    assert.equal(below?.['estimatedTokens'], 59_999, 'the latch read the host count');
    assert.equal(below?.['crossed'], false, 'the below-bar reading only marks an excursion');
    // At the bar the next revision fires: the explicit bar wins over the half.
    await mount.event(stepUsage('msg_depth_2', 60_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 1, 'the reading at 60k fires the ask');
    const at = lines.of('prune-threshold').at(-1);
    assert.equal(at?.['estimatedTokens'], 60_000, 'the crossing reads the host count');
    assert.equal(at?.['threshold'], 60_000, 'the explicit bar wins over the window half');
    assert.equal(at?.['skipAt'], 300_000, 'the 75% line is 300k on this window');
    assert.equal(at?.['crossed'], true, 'the crossing is journalled');
    assert.equal(lines.of('ask').length, 1, 'the crossing produced one readable ask');
  } finally { await mount.close(); }
});

test('after an ask pass the post-removal reading is the baseline; the next fire is +60k', async () => {
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Step 1 carries the unit; step 2 crosses at the bar and asks.
    await mount.transform(sessionId, largeHostMessages());
    await mount.event(stepUsage('msg_pass_1', 60_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 1, 'the first crossing asks');
    // The first reading after the pass becomes the baseline, even above the bar.
    await mount.event(stepUsage('msg_pass_2', 100_000));
    await mount.transform(sessionId, largeHostMessages());
    const baseline = lines.of('prune-threshold').at(-1);
    assert.equal(baseline?.['estimatedTokens'], 100_000, 'the post-pass reading is observed');
    assert.equal(baseline?.['crossed'], false,
      'the post-pass reading only becomes the baseline');
    // 20k of growth would re-fire against the pre-pass 60k; it must not.
    await mount.event(stepUsage('msg_pass_3', 120_000));
    await mount.transform(sessionId, largeHostMessages());
    const short = lines.of('prune-threshold').at(-1);
    assert.equal(short?.['estimatedTokens'], 120_000, 'the growth reading is observed');
    assert.equal(short?.['crossed'], false,
      'growth is measured from the post-pass reading, not the fired reading');
    // One bar above the pass's own reading fires (100k + 60k, not 60k + 60k).
    await mount.event(stepUsage('msg_pass_4', 160_000));
    await mount.transform(sessionId, largeHostMessages());
    const fire = lines.of('prune-threshold').at(-1);
    assert.equal(fire?.['estimatedTokens'], 160_000, 'the one-bar reading is observed');
    assert.equal(fire?.['crossed'], true,
      'one bar of new growth above the pass baseline fires');
  } finally { await mount.close(); }
});

test('ISSUE-357: an unstated nested-ask row never consumes a main estimate', async () => {
  // Vanilla opencode 2.4.0 declares no requestKind, so the nested ask's own
  // step row reads `unstated`. The mount knows its own ask is in flight: that
  // row is the ask lane's and must not shift a pending main estimate nor
  // reconcile the ask's small counts into the main meter. The main rows arrive
  // late (after the next hook), in request order — the pairing the queue owes.
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      await mount.event({ type: 'session.step.ended', data: {
        sessionID: sessionId, assistantMessageID: 'msg_ask_nested', finish: 'stop', cost: 0,
        tokens: { input: 9, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      } });
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    const est1 = mount.sessions.get(sessionId)?.pendingEstimates[0];
    assert.ok(est1 !== null && est1 !== undefined, 'the first request was estimated');
    // The second request crosses the small bar and asks; its own estimate is
    // pushed after the ask returns.
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 1, 'the crossing fired one ask');
    const est2 = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
    assert.ok(est2 !== null && est2 !== undefined, 'the second request was estimated');
    assert.notEqual(est1.revision, est2.revision, 'the two requests are different revisions');
    const missing = lines.of('usage-missing');
    assert.deepEqual(missing.map(line => [line['messageId'], line['reason'], line['requestKind']]),
      [['msg_ask_nested', 'ask-request', 'unstated']],
      'the unstated nested row is recorded unmeasured, never reconciled');
    await mount.event(stepUsage('msg_main_1', 200));
    await mount.event(stepUsage('msg_main_2', 300));
    const reconciled = lines.of('usage-reconciled');
    assert.deepEqual(reconciled.map(line =>
      [line['requestId'], line['revision'], line['estimatedInputTokens']]),
    [['msg_main_1', est1.revision, est1.inputTokens],
      ['msg_main_2', est2.revision, est2.inputTokens]],
    'each late main row pairs with its own request estimate');
    assert.equal(mount.sessions.get(sessionId)?.meter.latest()?.inputTokens, 300,
      'the meter reads the last main prompt, never the ask\'s 9 tokens');
  } finally { await mount.close(); }
});

test('ISSUE-396: a late row from a timed-out ask never pairs a main estimate', async () => {
  const lines = journalLines();
  let releaseAbandoned: (answer: { text: string }) => void = () => {};
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askTimeoutMs: 20,
    // The generate never settles on its own: the deadline abandons it while
    // the host request lives on.
    askGenerate: () => new Promise<{ text: string }>(resolve => { releaseAbandoned = resolve; }),
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    const est1 = mount.sessions.get(sessionId)?.pendingEstimates[0];
    assert.ok(est1 !== null && est1 !== undefined, 'the first request was estimated');
    // A host that emits ask step rows: one declared generate row is the
    // evidence that opens the abandoned-call guard. Vanilla 2.4.0 emits no
    // generate step row, so its main accounting stays untouched.
    const declared = stepUsage('msg_ask_declared', 9);
    await mount.event({ type: declared.type,
      data: { ...(declared.data as Record<string, unknown>), requestKind: 'generate' } });
    // The second request crosses the bar; its ask hangs past the deadline.
    // A timeout commits nothing, so the array varies to keep the two estimates
    // distinguishable by revision.
    const second = [...largeHostMessages(), userMessage('msg_u2', [text('Continue.')])];
    await mount.transform(sessionId, second);
    assert.equal(lines.of('ask-error').at(-1)?.['stage'], 'timeout', 'the ask timed out');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session entry exists');
    assert.equal(entry.askInFlight, false, 'the lane cleared the in-flight lock');
    const est2 = entry.pendingEstimates.at(-1);
    assert.ok(est2 !== null && est2 !== undefined, 'the second request was estimated');
    assert.notEqual(est1.revision, est2.revision, 'the two requests are different revisions');
    // The abandoned generate is still live; its late unstated step row arrives.
    // While the abandoned call lives, an unstated row is the ask lane's (the
    // ISSUE-357 classification, held until the generate truly ends): the row is
    // unmeasured and the main queue keeps its alignment.
    await mount.event(stepUsage('msg_ask_late', 9));
    assert.ok(lines.of('usage-missing').some(line =>
      line['messageId'] === 'msg_ask_late' && line['reason'] === 'ask-request'),
    'the late abandoned row is recorded unmeasured in the ask lane');
    assert.equal(entry.pendingEstimates.length, 2,
      'the late abandoned row shifted no main estimate');
    assert.equal(lines.of('usage-reconciled').length, 0,
      'the abandoned ask\'s 9 tokens never reconciled into the main meter');
    // Once the abandoned generate truly ends the claim lifts.
    releaseAbandoned({ text: '{"1":{"keepall":true}}' });
    await new Promise(resolve => { setImmediate(resolve); });
    // The main rows arrive in request order and pair with their own estimates.
    await mount.event(stepUsage('msg_main_1', 200));
    await mount.event(stepUsage('msg_main_2', 300));
    const reconciled = lines.of('usage-reconciled');
    assert.deepEqual(reconciled.map(line =>
      [line['requestId'], line['revision'], line['estimatedInputTokens']]),
    [['msg_main_1', est1.revision, est1.inputTokens],
      ['msg_main_2', est2.revision, est2.inputTokens]],
    'each main row pairs with its own request estimate');
    assert.equal(entry.meter.latest()?.inputTokens, 300,
      'the meter reads the last main prompt, never the abandoned ask\'s 9 tokens');
    // A later unstated row is a main row again (here unmeasured — no estimate
    // is left), proving the claim lifted when the generate settled.
    await mount.event(stepUsage('msg_after_end', 400));
    const after = lines.of('usage-missing').find(line => line['messageId'] === 'msg_after_end');
    assert.equal(after?.['reason'], 'no-request-estimate',
      'the abandoned-call claim lifts when the generate settles');
  } finally {
    releaseAbandoned({ text: '{"1":{"keepall":true}}' });
    await mount.close();
  }
});

test('ISSUE-358: a row later than the 16-estimate bound is unmeasured, never mispaired', async () => {
  // 17 measured requests, then their rows arrive in request order. The bound
  // drops the oldest estimate; the row that answers it must be refused by name,
  // and every later row must still pair with its OWN request — the drop cannot
  // silently shift the FIFO by one.
  const lines = journalLines();
  const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record) });
  try {
    const messages: OpencodeMessage[] = [userMessage('msg_u_lag', [text('one')])];
    const estimates: { revision: string; inputTokens: number }[] = [];
    for (let request = 1; request <= 17; request += 1) {
      await mount.transform(sessionId, messages);
      const estimate = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
      assert.ok(estimate !== null && estimate !== undefined,
        `request ${String(request)} was estimated`);
      estimates.push(estimate);
      messages.push(assistantMessage(`msg_a_lag_${String(request)}`,
        [text(`answer ${String(request)}`)]));
    }
    assert.equal(mount.sessions.get(sessionId)?.pendingEstimates.length, 16,
      'the bound kept sixteen estimates');
    const dropped = lines.of('estimate-dropped');
    assert.equal(dropped.length, 1, 'the drop itself is journaled, not silent');
    assert.equal(dropped[0]?.['revision'], estimates[0]?.revision,
      'the drop names the estimate it lost');
    for (let request = 1; request <= 17; request += 1) {
      await mount.event(stepUsage(`msg_row_${String(request)}`, request));
    }
    const missing = lines.of('usage-missing');
    assert.deepEqual(missing.map(line => [line['messageId'], line['reason']]),
      [['msg_row_1', 'estimate-dropped']],
      'the row whose estimate was dropped is unmeasured by name');
    const reconciled = lines.of('usage-reconciled');
    assert.equal(reconciled.length, 16, 'the sixteen surviving estimates reconciled');
    assert.deepEqual(reconciled.map(line => [line['requestId'], line['revision']]),
      estimates.slice(1).map((estimate, index) =>
        [`msg_row_${String(index + 2)}`, estimate.revision]),
      'every late row pairs with its own request, never the next one\'s');
    assert.equal(mount.sessions.get(sessionId)?.meter.latest()?.inputTokens, 17,
      'the meter reads the last main row, not a shifted pairing');
  } finally { await mount.close(); }
});

test('ISSUE-359: a thrown batch build leaves the crossing live on step, idle and cremate',
  async () => {
    // A build throw is not a completed pass: it read nothing and removed
    // nothing, so it must not consume the depth crossing nor arm a post-pass
    // baseline. The throw is injected by setting `passRound` to -1: the pass
    // increments it to 0 and the builder refuses a non-positive round ordinal.
    // The seen set is non-empty (a prior transform shipped the units), so the
    // empty-seen exemption cannot mask the error path.
    const armed = (lines: ReturnType<typeof journalLines>) => createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
      journal: record => lines.records.push(record),
    });

    // Step: the crossing that fired the thrown build stays live.
    const stepLines = journalLines();
    const stepMount = armed(stepLines);
    try {
      await stepMount.transform(sessionId, largeHostMessages());
      const entry = stepMount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session is mounted');
      entry.passRound = -1;
      await stepMount.transform(sessionId, largeHostMessages());
      assert.ok(entry.seenNodeIds.size > 0, 'the second transform promoted the shipped nodes');
      const err = stepLines.of('ask-error')
        .find(line => line['origin'] === 'step' && line['stage'] === 'rows');
      assert.ok(err !== undefined, 'the build throw is journaled by name');
      assert.match(String(err['message']), /positive round ordinal/u);
      assert.equal(stepLines.of('ask').length, 0, 'the thrown build sent no table');
      await stepMount.transform(sessionId, largeHostMessages());
      assert.equal(stepLines.of('ask').length, 1,
        'the crossing stayed live: the next above-bar reading fires without an extra bar');
    } finally { await stepMount.close(); }

    // Idle: same rule on the turn-end fallback ask.
    const idleLines = journalLines();
    const idleMount = armed(idleLines);
    try {
      await idleMount.transform(sessionId, largeHostMessages());
      await idleMount.event(stepUsage('msg_idle_1', 50));
      await idleMount.transform(sessionId, largeHostMessages());
      const entry = idleMount.sessions.get(sessionId);
      assert.ok(entry !== undefined && entry.seenNodeIds.size > 0,
        'the seen set is non-empty before the idle');
      await idleMount.event(stepUsage('msg_idle_2', 150));
      entry.passRound = -1;
      await idleMount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      const err = idleLines.of('ask-error').find(line => line['origin'] === 'idle');
      assert.ok(err !== undefined, 'the idle build throw is journaled');
      assert.equal(idleLines.of('ask').length, 0, 'the thrown idle build sent no table');
      await idleMount.transform(sessionId, largeHostMessages());
      assert.equal(idleLines.of('ask').length, 1,
        'the idle crossing stayed live: the next above-bar reading fires');
    } finally { await idleMount.close(); }

    // Cremate: a manual command whose build threw arms no baseline either.
    const commandLines = journalLines();
    const commandMount = armed(commandLines);
    try {
      await commandMount.transform(sessionId, largeHostMessages());
      const entry = commandMount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session is mounted');
      entry.passRound = -1;
      assert.equal((await commandMount.cremate(sessionId)).fired, false,
        'the thrown command fired nothing');
      const err = commandLines.of('ask-error')
        .find(line => line['origin'] === 'command' && line['stage'] === 'rows');
      assert.ok(err !== undefined, 'the command build throw is journaled');
      assert.equal(commandLines.of('ask').length, 0, 'the thrown command sent no table');
      await commandMount.transform(sessionId, largeHostMessages());
      assert.equal(commandLines.of('ask').length, 1,
        'the command armed no baseline: the next above-bar reading still fires');
    } finally { await commandMount.close(); }
  });

test('ISSUE-353: a nested ask\'s idle never marks the live turn complete', async () => {
  // The ask's own session.generate ends a turn of its own, so the host can
  // deliver session.idle while the main transform is suspended inside the
  // ask. That idle is not the main turn's end: recording its ordinal as the
  // completed-turn fact lets the next pass close and evict the LIVE turn's
  // episodes. The fact waits for an idle delivered with no ask in flight.
  // The fixture holds one tableable read and one miss read in the SAME live
  // turn, so a wrongly recorded fact evicts the miss body through the
  // closed-episode family — and a genuine turn-end idle still does.
  const conversation = (): OpencodeMessage[] => [
    userMessage('msg_u1', [text('Read the note and the missing one.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'GONE.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read',
      errorResult(`ENOENT: GONE.md\n\n${'no-such-file-'.repeat(70)}\n`))]),
    assistantMessage('msg_a3', [text('One is missing.')]),
  ];
  const lines = journalLines();
  let askCalls = 0;
  let releaseAsk: (answer: { text: string }) => void = () => {};
  let markAskStarted: () => void = () => {};
  const askStarted = new Promise<void>(resolve => { markAskStarted = resolve; });
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: () => {
      askCalls += 1;
      if (askCalls === 1) {
        // The first ask suspends: the main transform is in flight inside it.
        markAskStarted();
        return new Promise<{ text: string }>(resolve => { releaseAsk = resolve; });
      }
      return Promise.resolve({ text: '{"1":{"keepall":true}}' });
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Step 1 ships the units; nothing is tableable yet (the seen set is empty).
    await mount.transform(sessionId, conversation());
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the first transform opened the session');
    assert.equal(entry.completedThroughTurnOrdinal, null, 'no idle has delivered a fact');
    // Step 2 tables the carried read and suspends inside the ask.
    const step2 = mount.transform(sessionId, conversation());
    await askStarted;
    assert.equal(entry.askInFlight, true, 'the ask is in flight');
    // The nested generate's own turn end arrives while the main turn lives.
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, null,
      'the nested ask\'s idle records no completed-turn fact for the live turn');
    releaseAsk?.({ text: '{"1":{"keepall":true}}' });
    await step2;
    assert.equal(entry.askInFlight, false, 'the ask resolved');
    // The next pass plans over the live turn: its miss episode stays open,
    // so the closed-episode family must not evict the miss body.
    const step3 = conversation();
    await mount.transform(sessionId, step3);
    assert.equal(step3.some(message => message.id === 'msg_t2'), true,
      'the live turn\'s miss body is not evicted');
    assert.equal(lines.of('ask-apply').some(line => line['rule'] === 'closed-episode'), false,
      'no closed-episode removal names the live turn');
    // The turn's OWN idle, with no ask in flight, still records the fact…
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, 0,
      'a genuine turn-end idle records the turn it ended');
    // …and the next pass then closes the episode: the fixture can evict, so
    // the survival above is the guard, not a dead rule.
    const step4 = conversation();
    await mount.transform(sessionId, step4);
    assert.equal(step4.some(message => message.id === 'msg_t2'), false,
      'after the genuine turn end the closed episode\'s miss body leaves');
    assert.equal(lines.of('ask-apply').some(line => line['rule'] === 'closed-episode'), true,
      'the closed-episode family fires once the turn genuinely ended');
  } finally { await mount.close(); }
});

test('ISSUE-496: a revert drops the idle turn fact, so the redone turn stays live',
  async () => {
    /*
     * The host's undo rewrites its store without a compaction event and the
     * redone turn reuses the undone ordinal. The mount cleared the turn-end fact
     * only on `session.compaction.ended`, so the redone turn's request carried
     * the stale fact, the snapshot clamp raised it to `currentTurn` — the LIVE
     * turn — and the closed-episode L1 lane evicted that turn's miss bodies
     * while the model still needed them. The native `session.revert.*` events
     * (verified against the installed 2.2.5 host binary) are the invalidation
     * hook. The fixture holds one tableable read and one miss read in the SAME
     * live turn, so a stale fact evicts the miss body and a genuine turn end
     * still does — the survival below is the guard, not a dead rule.
     */
    const conversation = (): OpencodeMessage[] => [
      userMessage('msg_u1', [text('Read the note and the missing one.')]),
      assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
      toolMessage('msg_t1', [toolResult('call_1', 'read',
        textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
      assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'GONE.md' })]),
      toolMessage('msg_t2', [toolResult('call_2', 'read',
        errorResult(`ENOENT: GONE.md\n\n${'no-such-file-'.repeat(70)}\n`))]),
      assistantMessage('msg_a3', [text('One is missing.')]),
    ];
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"keepall":true}}' }),
      journal: record => lines.records.push(record),
    });
    try {
      // Step 1 ships the units; step 2 tables them.
      await mount.transform(sessionId, conversation());
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first transform opened the session');
      await mount.transform(sessionId, conversation());
      // The turn ends: the idle records turn 0 as complete.
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(entry.completedThroughTurnOrdinal, 0, 'the idle recorded turn 0');
      // The user undoes the turn; the host rewrites its history without a
      // compaction and the redone turn reuses ordinal 0. The native revert
      // event must drop the fact the way a compaction already does.
      await mount.event({ type: 'session.revert.staged', data: { sessionID: sessionId } });
      const redone = conversation();
      await mount.transform(sessionId, redone);
      assert.equal(redone.some(message => message.id === 'msg_t2'), true,
        'the redone turn\'s live miss body is not evicted');
      assert.equal(lines.of('ask-apply').some(line => line['rule'] === 'closed-episode'), false,
        'no closed-episode removal names the live turn');
      assert.equal(entry.completedThroughTurnOrdinal, null,
        'the revert drops the turn fact that names a rewritten turn');
      // The redo's own idle, with no revert after it, still records the fact…
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(entry.completedThroughTurnOrdinal, 0,
        'a genuine turn-end idle still records the turn it ended');
      // …and the next pass then closes the episode: the fixture can evict, so
      // the survival above is the guard, not a dead rule.
      const afterTurnEnd = conversation();
      await mount.transform(sessionId, afterTurnEnd);
      assert.equal(afterTurnEnd.some(message => message.id === 'msg_t2'), false,
        'after the genuine turn end the closed episode\'s miss body leaves');
      assert.equal(lines.of('ask-apply').some(line => line['rule'] === 'closed-episode'), true,
        'the closed-episode family fires once the turn genuinely ended');
    } finally {
      await mount.close();
    }
  });

test('ISSUE-496: a committed revert also drops the idle turn fact, so the redone turn stays live',
  async () => {
    /*
     * ISSUE-496 follow-up: the shipped handler clears the fact on the staged
     * AND committed revert, but the test above drives only `staged`. The host
     * commits its undo as its own event (`session.revert.committed`), and a
     * mount that missed it would carry the pre-undo fact into the redone turn
     * exactly as the staged case describes. Same fixture as the test above —
     * that test's genuine-turn-end case is the proof this fixture can evict.
     */
    const conversation = (): OpencodeMessage[] => [
      userMessage('msg_u1', [text('Read the note and the missing one.')]),
      assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
      toolMessage('msg_t1', [toolResult('call_1', 'read',
        textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
      assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'GONE.md' })]),
      toolMessage('msg_t2', [toolResult('call_2', 'read',
        errorResult(`ENOENT: GONE.md\n\n${'no-such-file-'.repeat(70)}\n`))]),
      assistantMessage('msg_a3', [text('One is missing.')]),
    ];
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"keepall":true}}' }),
      journal: record => lines.records.push(record),
    });
    try {
      // Step 1 ships the units; step 2 tables them.
      await mount.transform(sessionId, conversation());
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first transform opened the session');
      await mount.transform(sessionId, conversation());
      // The turn ends: the idle records turn 0 as complete.
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(entry.completedThroughTurnOrdinal, 0, 'the idle recorded turn 0');
      // The host commits the undo; the history it rewrote reuses ordinal 0.
      await mount.event({ type: 'session.revert.committed', data: { sessionID: sessionId } });
      const redone = conversation();
      await mount.transform(sessionId, redone);
      assert.equal(redone.some(message => message.id === 'msg_t2'), true,
        'the redone turn\'s live miss body is not evicted');
      assert.equal(lines.of('ask-apply').some(line => line['rule'] === 'closed-episode'), false,
        'no closed-episode removal names the live turn');
      assert.equal(entry.completedThroughTurnOrdinal, null,
        'the committed revert drops the turn fact that names a rewritten turn');
      assert.equal(lines.of('reverted').at(-1)?.['phase'], 'committed',
        'the committed event is journalled with the phase that dropped the fact');
    } finally {
      await mount.close();
    }
  });

/**
 * The idle//cremate re-arm fixture: one kept read of 856,000 bytes (214k
 * estimated tokens) and one doomed read of 160,400 bytes (about 40k estimated
 * tokens; the extra 400 bytes absorb the call part and the receipt line so the
 * measured drop stays at or above 40,000). Before the pass the surface is ~254k; the pass removes the doomed
 * unit and leaves ~214k, so the growth rule — not a below-bar excursion — is
 * what the next reading exercises.
 */
function rearmFixture(): OpencodeMessage[] {
  return [
    userMessage('msg_u_rearm', [text('Read both notes.')]),
    assistantMessage('msg_a_keep', [
      toolCall('call_keep', 'read', { filePath: 'KEEP.md' }),
    ]),
    toolMessage('msg_keep', [toolResult('call_keep', 'read',
      textResult('k'.repeat(856_000)))]),
    assistantMessage('msg_a_doomed', [
      toolCall('call_doomed', 'read', { filePath: 'DOOMED.md' }),
    ]),
    toolMessage('msg_doomed', [toolResult('call_doomed', 'read',
      textResult('d'.repeat(160_400)))]),
    assistantMessage('msg_a_rearm_end', [text('Read them.')]),
  ];
}

/**
 * The shared setup: a small first request, then the big fixture shipped under a
 * below-bar host reading, then the fire reading at 254k. The array is grown in
 * place so `entry.lastMessages` is the same reference the host would rebuild.
 */
async function rearmSetup(mount: ReturnType<typeof createOpencodeMount>): Promise<{
  messages: OpencodeMessage[];
}> {
  const small = [userMessage('msg_u_rearm', [text('Read both notes.')])] as OpencodeMessage[];
  await mount.transform(sessionId, small);
  await mount.event(stepUsage('msg_rearm_small', 20_000));
  const grown = rearmFixture();
  small.splice(0, small.length, ...grown);
  await mount.transform(sessionId, small);
  // The next request is the one that first makes the grown units eligible
  // (`seenNodeIds` is promoted from the previous ship at transform entry), and
  // the 20k host row keeps it below the bar.
  await mount.transform(sessionId, small);
  await mount.event(stepUsage('msg_rearm_fire', 254_000));
  return { messages: small };
}

test('an idle fire re-arms from its post-removal surface, not the next pre-apply reading',
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 60_000,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        const prompt = String(input.prompt ?? '');
        return { text: /^2\. \[/mu.test(prompt)
          ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const { messages } = await rearmSetup(mount);
      assert.equal(calls.length, 0, 'the shipped request is below the bar');
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls.length, 1, 'the idle path asks at the 254k reading');
      assert.equal(messages.some(message => message.id === 'msg_doomed'), true,
        'the idle hook applies nothing');
      /**
       * The next request carries the idle verdict. The pre-apply reading is
       * suppressed and no local surface is installed: the baseline is the
       * first HOST reading after the removal (ADR-0050). The audit-1 probe
       * made a local baseline fire spuriously at the next host reading.
       */
      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message => message.id === 'msg_doomed'), false,
        'the idle verdict applies at the next request');
      const atApply = lines.of('prune-threshold').at(-1);
      assert.equal(atApply?.['estimatedTokens'], 254_000,
        'the deferred apply wrote no local baseline line');
      assert.equal(atApply?.['barReading'], 'host-meter',
        'the last latch reading is still the host fire reading');
      // The host's next billed reading after the removal: the baseline.
      await mount.event(stepUsage('msg_rearm_baseline', 214_000));
      await mount.transform(sessionId, messages);
      const baseline = lines.of('prune-threshold').at(-1);
      assert.equal(baseline?.['estimatedTokens'], 214_000,
        'the first host reading after the removal becomes the baseline');
      assert.equal(baseline?.['barReading'], 'host-meter',
        'the baseline is the host reading, not a local estimate');
      assert.equal(baseline?.['crossed'], false, 'the baseline reading does not fire');
      // One token under one bar above the host baseline: no fire.
      await mount.event(stepUsage('msg_rearm_short', 273_999));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, '273,999 is under 214,000 + 60,000 and does not fire');
      const short = lines.of('prune-threshold').at(-1);
      assert.equal(short?.['estimatedTokens'], 273_999, 'the short reading is observed');
      assert.equal(short?.['crossed'], false);
      // Exactly one bar above the host baseline: fires.
      await mount.event(stepUsage('msg_rearm_fire_2', 274_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 2, 'exactly 214,000 + 60,000 fires');
      assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], true);
    } finally { await mount.close(); }
  });

test('a deferred pass that removes nothing keeps the fire reading as the baseline', async () => {
  /*
   * ISSUE-300 re-audit: a deferred idle//cremate apply that removes nothing
   * must not call notePassCompleted. A synthetic local baseline of about 214k
   * would make 274,000 look like one bar of growth and fire spuriously; the
   * latch must stay at the 254,000 fire reading.
   */
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    /**
     * A 600k window keeps the 314,000 probe below the 75% skip line (450,000);
     * on the 400k window the probe would be skipped, not latched.
     */
    contextWindowTokens: 600_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      const prompt = String(input.prompt ?? '');
      return { text: /^2\. \[/mu.test(prompt)
        ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    const { messages } = await rearmSetup(mount);
    assert.equal(calls.length, 0, 'the shipped request is below the bar');
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(calls.length, 1, 'the idle path fires at the 254k reading');
    // The host rebuilds without the doomed unit: the stored verdict cannot
    // apply, so the deferred pass removes nothing.
    const doomedIndex = messages.findIndex(message => message.id === 'msg_doomed');
    assert.ok(doomedIndex >= 0, 'the fixture still carries the doomed read');
    messages.splice(doomedIndex, 1);
    await mount.transform(sessionId, messages);
    assert.equal(lines.of('ask-apply').length, 0, 'the deferred pass removed nothing');
    const atApply = lines.of('prune-threshold').at(-1);
    assert.equal(atApply?.['estimatedTokens'], 254_000,
      'the deferred pass installed no local baseline');
    assert.equal(atApply?.['crossed'], true, 'the last latch reading is still the fire');
    // 274,000 is the old local-surface bar (214,000 + 60,000) but only 20,000
    // above the actual fire: no reset means no fire here.
    await mount.event(stepUsage('msg_no_removal_probe', 274_000));
    await mount.transform(sessionId, messages);
    assert.equal(calls.length, 1, '274,000 does not fire from the 254,000 fire');
    assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], false);
    // One bar above the fire reading fires.
    await mount.event(stepUsage('msg_no_removal_fire', 314_000));
    await mount.transform(sessionId, messages);
    assert.equal(calls.length, 2, 'exactly 254,000 + 60,000 fires');
    assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], true);
  } finally { await mount.close(); }
});

test('a failed deferred apply retries and re-arms from the post-removal host reading', async () => {
  /*
   * ISSUE-300 F4: a deferred apply that throws must keep the transform deferred
   * so the next request is the retry, not an ordinary boundary. When the retry
   * removes the bytes, the pass completes and the first host reading after the
   * removal is the baseline: the next fire is 214,000 + 60,000, not 254,000 +
   * 60,000.
   */
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      const prompt = String(input.prompt ?? '');
      return { text: /^2\. \[/mu.test(prompt)
        ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    const { messages } = await rearmSetup(mount);
    assert.equal(calls.length, 0, 'the shipped request is below the bar');
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(calls.length, 1, 'the idle fire stores the verdict');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.equal(entry.deferredApply, true, 'the idle verdict is deferred');
    const engine = entry.engine;
    const original = engine.process.bind(engine);
    let failed = false;
    engine.process = async (input, control) => {
      if (input.kind === 'prune' && !failed) {
        failed = true;
        throw new Error('injected prune apply failure');
      }
      return original(input, control);
    };
    // First transform: the deferred apply throws; nothing is removed and the
    // transform stays deferred for the retry.
    await mount.transform(sessionId, messages);
    assert.equal(failed, true, 'the first deferred apply failed');
    assert.equal(entry.deferredApply, true, 'a failed deferred apply stays deferred');
    assert.equal(messages.some(message => message.id === 'msg_doomed'), true,
      'the failed apply removed nothing');
    // Second transform: the retry applies the stored verdict.
    await mount.transform(sessionId, messages);
    assert.equal(entry.deferredApply, false, 'the successful retry completes the deferred pass');
    assert.equal(messages.some(message => message.id === 'msg_doomed'), false,
      'the retry applied the removal');
    // The first host reading after the removal is the baseline, not the fire.
    await mount.event(stepUsage('msg_retry_baseline', 214_000));
    await mount.transform(sessionId, messages);
    const baseline = lines.of('prune-threshold').at(-1);
    assert.equal(baseline?.['estimatedTokens'], 214_000,
      'the first host reading after the removal is the baseline');
    assert.equal(baseline?.['barReading'], 'host-meter',
      'the baseline is the host reading, not a local estimate');
    assert.equal(baseline?.['crossed'], false, 'the baseline reading does not fire');
    await mount.event(stepUsage('msg_retry_short', 273_999));
    await mount.transform(sessionId, messages);
    assert.equal(calls.length, 1, '273,999 is under 214,000 + 60,000 and does not fire');
    await mount.event(stepUsage('msg_retry_fire', 274_000));
    await mount.transform(sessionId, messages);
    assert.equal(calls.length, 2, 'exactly 214,000 + 60,000 fires');
    assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], true);
  } finally { await mount.close(); }
});

test('a permanently failing deferred apply drops once and unfreezes the depth trigger',
  async () => {
    /*
     * ISSUE-300 G1: a deferred apply that keeps failing must not suppress every
     * later depth observation. One retry is allowed; the second consecutive
     * failure drops the unapplied verdicts and releases their units, without
     * completing the pass. The next transform observes depth again, and the
     * latch is still at the 254,000 fire reading: 274,000 (post-removal + bar)
     * does not fire, 314,000 (fire + bar) does.
     */
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 600_000,
      pruneThresholdTokens: 60_000,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        const prompt = String(input.prompt ?? '');
        return { text: /^2\. \[/mu.test(prompt)
          ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const { messages } = await rearmSetup(mount);
      assert.equal(calls.length, 0, 'the shipped request is below the bar');
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls.length, 1, 'the idle fire stores the verdict');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unitId = [...entry.askVerdicts.keys()][0];
      assert.ok(unitId !== undefined, 'the fire stored one verdict');
      assert.equal(entry.deferredApply, true, 'the idle verdict is deferred');
      const engine = entry.engine;
      const original = engine.process.bind(engine);
      let pruneCalls = 0;
      engine.process = async (input, control) => {
        if (input.kind === 'prune') {
          pruneCalls += 1;
          if (pruneCalls <= 2) throw new Error(`injected prune failure ${String(pruneCalls)}`);
        }
        return original(input, control);
      };
      const thresholdCount = lines.of('prune-threshold').length;
      // First failure: the one retry is allowed; the verdict survives.
      await mount.transform(sessionId, messages);
      assert.equal(entry.deferredFailures, 1, 'the first failure is the one retry');
      assert.equal(entry.deferredApply, true, 'the first failure stays deferred');
      assert.equal(entry.askVerdicts.has(unitId), true, 'the verdict survives the first failure');
      // Second consecutive failure: drop, release, clear.
      await mount.transform(sessionId, messages);
      assert.equal(entry.deferredApply, false, 'the second failure clears the deferred flag');
      assert.equal(entry.deferredFailures, 0, 'the drop resets the failure counter');
      assert.equal(entry.askVerdicts.size, 0, 'the unapplied verdicts are dropped');
      assert.equal(entry.askedUnitIds.has(unitId), false, 'the unit leaves the permanent claim');
      assert.equal(entry.retriedUnitIds.has(unitId), false, 'the unit leaves the retry record');
      assert.equal(entry.refusedRetriedUnitIds.has(unitId), false,
        'the unit leaves the refusal-retry record');
      const drop = lines.of('ask-error').find(line => line['stage'] === 'deferred-drop');
      assert.ok(drop !== undefined, 'the drop is a named ask-error');
      assert.deepEqual(drop['unitIds'], [unitId], 'the drop names the dropped unit');
      assert.match(String(drop['reason']), /two consecutive deferred applies failed/u);
      // ISSUE-300 close-record minor 3 (ISSUE-361): the drop takes every stored
      // verdict, including applied ones kept for re-application, so the reason
      // must not call them all unapplied.
      assert.match(String(drop['reason']), /the stored verdicts are dropped/u);
      assert.doesNotMatch(String(drop['reason']), /unapplied/u);
      assert.equal(lines.of('prune-threshold').length, thresholdCount,
        'the failed passes wrote no depth reading');
      // The latch is not frozen and still measures from the 254,000 fire.
      await mount.event(stepUsage('msg_drop_probe', 274_000));
      await mount.transform(sessionId, messages);
      const probe = lines.of('prune-threshold').at(-1);
      assert.equal(lines.of('prune-threshold').length, thresholdCount + 1,
        'the next transform observes depth again');
      assert.equal(probe?.['estimatedTokens'], 274_000, 'the host reading is observed');
      assert.equal(probe?.['crossed'], false,
        '274,000 would fire from a 214,000 baseline; the baseline is still 254,000');
      assert.equal(calls.length, 1, 'the probe does not fire');
      // A later host turn changes the revision; the idle fire's same-revision
      // guard is not what this test is about.
      messages.push(assistantMessage('msg_after_drop', [text('a later turn')]));
      await mount.event(stepUsage('msg_drop_fire', 314_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 2,
        'the next fire is 254,000 + 60,000, not post-removal + 60,000');
      assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], true);
    } finally { await mount.close(); }
  });

test('ISSUE-431: a permanently failing step-origin apply retries once and drops',
  async () => {
    /*
     * A step fire (not an idle or `/cremate` deferred pass) whose apply keeps
     * failing must follow the same one-retry-then-drop rule: otherwise the
     * stored verdicts remain and every later transform retries forever.
     */
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 600_000,
      pruneThresholdTokens: 60_000,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        const prompt = String(input.prompt ?? '');
        return { text: /^2\. \[/mu.test(prompt)
          ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const { messages } = await rearmSetup(mount);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const engine = entry.engine;
      const original = engine.process.bind(engine);
      let pruneCalls = 0;
      engine.process = async (input, control) => {
        if (input.kind === 'prune') {
          pruneCalls += 1;
          throw new Error(`injected step prune failure ${String(pruneCalls)}`);
        }
        return original(input, control);
      };
      // The step transform itself fires and its apply fails.
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, 'the step pass sent its ask');
      assert.equal(entry.deferredApply, false, 'a step fire is never a deferred pass');
      assert.equal(entry.deferredFailures, 1, 'the first failure is the one retry');
      assert.equal(entry.askVerdicts.size, 1, 'the verdict survives the first failure');
      // The retry fails too: drop the verdicts and stop retrying.
      await mount.transform(sessionId, messages);
      assert.equal(entry.deferredFailures, 0, 'the drop resets the failure counter');
      assert.equal(entry.askVerdicts.size, 0, 'the stored verdicts are dropped');
      const drop = lines.of('ask-error').find(line => line['stage'] === 'deferred-drop');
      assert.ok(drop !== undefined, 'the drop is a named ask-error');
      assert.match(String(drop['reason']), /two consecutive step applies failed/u);
      assert.equal(pruneCalls, 2, 'the second failure drops instead of retrying');
      await mount.transform(sessionId, messages);
      assert.equal(pruneCalls, 2, 'a later transform does not retry the dropped verdict');
    } finally { await mount.close(); }
  });

test('ISSUE-431: a crossing with no tableable unit journals no-eligible', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record),
  });
  try {
    // The first request crosses the tiny bar but nothing has been seen yet, so
    // the pass has zero tableable rows.
    await mount.transform(sessionId, largeHostMessages());
    const line = lines.of('prune-outcome').at(-1);
    assert.ok(line !== undefined, 'a zero-eligible crossing is named');
    assert.equal(line['outcome'], 'no-eligible');
    assert.equal(line['origin'], 'step');
    assert.match(String(line['reason']), /no tableable unit/u);
    assert.equal(lines.of('ask').length, 0, 'no ask was sent');
  } finally { await mount.close(); }
});

test('a fractional 75% line is journalled as the first integer at or above it', async () => {
  /*
   * ISSUE-300 audit bug 8: 333,333 × 0.75 = 249,999.75, which the bench's
   * safe-integer journal reader records as null. The line is the ceiling,
   * 250,000: 249,999 still crosses, 250,000 is the skip.
   */
  const belowLines = journalLines();
  const belowCalls: OpencodeGenerateInput[] = [];
  const below = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 333_333,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      belowCalls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => belowLines.records.push(record),
  });
  try {
    await below.transform(sessionId, largeHostMessages());
    await below.event(stepUsage('msg_frac_1', 249_999));
    await below.transform(sessionId, largeHostMessages());
    assert.equal(belowCalls.length, 1, '249,999 is under the skip line and fires');
    const under = belowLines.of('prune-threshold').at(-1);
    assert.equal(under?.['skipAt'], 250_000, 'the journal names 250,000, not 249,999.75');
    assert.ok(Number.isSafeInteger(under?.['skipAt']),
      'the journalled skip line is an integer, never null');
    assert.equal(under?.['crossed'], true, 'the reading under the line is a crossing');
  } finally { await below.close(); }

  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 333_333,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    await mount.event(stepUsage('msg_frac_2', 250_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 0, '250,000 is the skip line and never asks');
    const at = lines.of('prune-threshold').at(-1);
    assert.equal(at?.['skipAt'], 250_000, 'the skip line itself is the integer ceiling');
    assert.ok(Number.isSafeInteger(at?.['skipAt']), 'the skip line is journalled as an integer');
    assert.equal(at?.['crossed'], false, 'the skip refuses the crossing');
  } finally { await mount.close(); }
});

test('a /cremate fire re-arms from its post-removal surface, not the next pre-apply reading',
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 60_000,
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        const prompt = String(input.prompt ?? '');
        return { text: /^2\. \[/mu.test(prompt)
          ? '{"2":{"forgetall":true,"summary":"the doomed read"}}' : '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const { messages } = await rearmSetup(mount);
      assert.equal(calls.length, 0, 'the shipped request is below the bar');
      const { fired } = await mount.cremate(sessionId);
      assert.equal(fired, true, 'the manual command asks');
      assert.equal(calls.length, 1, 'one table is sent');
      assert.equal(messages.some(message => message.id === 'msg_doomed'), true,
        'the manual command applies nothing');
      const thresholdCount = lines.of('prune-threshold').length;
      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message => message.id === 'msg_doomed'), false,
        'the command verdict applies at the next request');
      assert.equal(lines.of('prune-threshold').length, thresholdCount,
        'the deferred apply wrote no local baseline line');
      /**
       * The deferred apply leaves the baseline pending. The first HOST reading
       * after the removal is the baseline; a local surface estimate is never
       * substituted for it (ADR-0050, ISSUE-300 re-audit).
       */
      await mount.event(stepUsage('msg_cremate_baseline', 214_000));
      await mount.transform(sessionId, messages);
      const baseline = lines.of('prune-threshold').at(-1);
      assert.equal(baseline?.['estimatedTokens'], 214_000,
        'the first host reading after the removal becomes the baseline');
      assert.equal(baseline?.['barReading'], 'host-meter',
        'the baseline is the host reading, not a local estimate');
      assert.equal(baseline?.['crossed'], false, 'the baseline reading does not fire');
      await mount.event(stepUsage('msg_cremate_short', 273_999));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, '273,999 is under 214,000 + 60,000 and does not fire');
      const short = lines.of('prune-threshold').at(-1);
      assert.equal(short?.['estimatedTokens'], 273_999, 'the short reading is observed');
      assert.equal(short?.['crossed'], false);
      await mount.event(stepUsage('msg_cremate_fire_2', 274_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 2, 'exactly 214,000 + 60,000 fires');
      assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], true);
    } finally { await mount.close(); }
  });

test('no automatic ask at or above 75% of the host window', async () => {
  // Just under the 300k line: a normal crossing and an ask.
  const belowLines = journalLines();
  const belowCalls: OpencodeGenerateInput[] = [];
  const below = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      belowCalls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => belowLines.records.push(record),
  });
  try {
    await below.transform(sessionId, largeHostMessages());
    await below.event(stepUsage('msg_skip_1', 299_999));
    await below.transform(sessionId, largeHostMessages());
    assert.equal(belowCalls.length, 1, 'just under the skip line still asks');
    assert.equal(belowLines.of('prune-threshold').at(-1)?.['crossed'], true,
      'the reading under 75% is a normal crossing');
  } finally { await below.close(); }

  // At and above the line: no ask, however far above the bar.
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    await mount.event(stepUsage('msg_skip_2', 300_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 0, 'the skip line itself never asks');
    const at = lines.of('prune-threshold').at(-1);
    assert.equal(at?.['skipAt'], 300_000, 'the journal names the 75% line');
    assert.equal(at?.['crossed'], false, 'the skip refuses the crossing');
    await mount.event(stepUsage('msg_skip_3', 319_999));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 0, 'a deeper reading is skipped too');
    assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], false,
      'the deeper reading never fires');
  } finally { await mount.close(); }
});

test('session.compaction.ended re-arms the depth latch', async () => {
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async (input) => {
      calls.push(input);
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Step 1 carries the unit; step 2 crosses at 60k and asks.
    await mount.transform(sessionId, largeHostMessages());
    await mount.event(stepUsage('msg_comp_1', 60_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls.length, 1, 'the first crossing asks');
    // The pass baseline is 100k; 120k is 20k of growth and stays closed.
    await mount.event(stepUsage('msg_comp_2', 100_000));
    await mount.transform(sessionId, largeHostMessages());
    await mount.event(stepUsage('msg_comp_3', 120_000));
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(lines.of('prune-threshold').at(-1)?.['crossed'], false,
      'the latch is closed one bar below the post-pass baseline');
    assert.equal(calls.length, 1, 'no second ask is sent');
    // The host rewrites the surface; the same above-bar reading is now fresh.
    await mount.event({ type: 'session.compaction.ended', data: { sessionID: sessionId } });
    assert.equal(lines.of('compacted').at(-1)?.['phase'], 'ended',
      'the compaction phase is journalled');
    await mount.transform(sessionId, largeHostMessages());
    const after = lines.of('prune-threshold').at(-1);
    assert.equal(after?.['estimatedTokens'], 120_000,
      'the same host reading is observed after the compaction');
    assert.equal(after?.['crossed'], true,
      'the fresh latch fires on the next above-bar reading');
  } finally { await mount.close(); }
});

test('the depth fallback reads the whole request before the first usage row', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    // A bar small enough that the fixture's own transcript crosses it: the
    // test proves the first reading is not the old zero.
    pruneThresholdTokens: 1,
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // The hook's own fixed prefix: the system prompt and the tool table.
    const context = {
      system: ['you are a helpful coding agent'],
      tools: { read: { description: 'read a file', input: { type: 'object' } } },
    };
    await mount.transform(sessionId, messages, context);
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    const snapshot = entry.port.observe(messages);
    const prefix = requestPrefixOf(context);
    assert.ok(prefix !== null, 'the request prefix is measurable');
    const whole = estimateRequestTokens(
      new Meter(new CharHeuristicTokenMeter()), snapshot, prefix);
    const contentOnly = estimateRequestTokens(
      new Meter(new CharHeuristicTokenMeter()), snapshot);
    assert.ok(whole > contentOnly,
      'the whole request is strictly larger than the transcript alone');
    const first = lines.of('prune-threshold')[0];
    assert.equal(first?.['estimatedTokens'], whole,
      'the first boundary reads the whole-request estimate, not zero');
    assert.equal(first?.['barReading'], 'local-estimate',
      'no usage row has arrived yet');
    assert.equal(first?.['estimate'], 'content+prefix',
      'the journal names the whole-request estimate honestly');
    assert.equal(first?.['contentTokens'], contentOnly,
      'the journal carries the transcript term');
    assert.ok(Number(first?.['prefixTokens'] ?? 0) > 0,
      'the journal carries the fixed prefix term');
    assert.equal(first?.['crossed'], true,
      'a first request above the bar crosses without a usage row');
    const shipped = entry.pendingEstimates.at(-1);
    assert.equal(shipped?.inputTokens, whole,
      'the shipped estimate is the same whole-request number');
    // The first crossing has no seen unit, so it is NOT consumed: the next
    // above-bar reading still fires (ISSUE-300 item 11).
    await mount.transform(sessionId, largeHostMessages(), context);
    const second = lines.of('prune-threshold').at(-1);
    assert.equal(second?.['estimatedTokens'], shipped?.inputTokens,
      'the fallback reads the pending whole-request estimate');
    assert.equal(second?.['barReading'], 'local-estimate',
      'the host meter is still absent');
    assert.equal(second?.['crossed'], true,
      'the skipping carrier crossing did not consume the latch');
    // The second crossing sent a table (an empty reply is an attempted ask), so
    // it completed a pass: the next reading is its baseline, not a fire.
    await mount.transform(sessionId, largeHostMessages(), context);
    const third = lines.of('prune-threshold').at(-1);
    assert.equal(third?.['crossed'], false,
      'the reading after the attempted pass is the baseline');
  } finally { await mount.close(); }
});

test('with no bar or window the mount observes no depth and keeps the per-revision ask',
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async (input) => {
        calls.push(input);
        return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      await mount.transform(sessionId, largeHostMessages());
      await mount.transform(sessionId, largeHostMessages());
      assert.equal(calls.length, 1, 'the second revision asks as before');
      assert.deepEqual(lines.of('prune-threshold'), [],
        'no depth observation is journalled when the trigger is unconfigured');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      assert.equal(entry.pruneTrigger.enabled, false,
        'no bar and no window leaves the latch off');
    } finally { await mount.close(); }
  });

test('the depth-trigger mount options are validated by name', () => {
  const options = mountOptionsFromHost({
    crematorContextWindowTokens: 400_000, crematorPruneThresholdTokens: 60_000,
  });
  assert.equal(options.contextWindowTokens, 400_000, 'the window reaches the mount option');
  assert.equal(options.pruneThresholdTokens, 60_000, 'the bar reaches the mount option');
  // The host config is raw JS: `mountOptionsFromHost` passes the value through,
  // and `createOpencodeMount` must refuse it by name, never coerce it.
  assert.throws(() => createOpencodeMount(mountOptionsFromHost({
    crematorContextWindowTokens: '400000',
  })), /contextWindowTokens must be null or a positive safe integer/u,
  'a string window fails by name at mount');
  assert.throws(() => createOpencodeMount({ contextWindowTokens: 400_000, pruneThresholdTokens: 0 }),
    /pruneThresholdTokens must be null or a positive safe integer/u,
    'a zero bar fails by name at mount');
  assert.throws(() => createOpencodeMount({ pruneThresholdTokens: 60_000 }),
    /pruneThresholdTokens requires contextWindowTokens/u,
    'a bar without a window is refused at mount');
});

test('a summary past the reader tolerance is refused, retried once, then excluded', async () => {
  const lines = journalLines();
  let calls = 0;
  const summary = Array.from({ length: 31 }, (_, index) => `w${String(index)}`).join(' ');
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      calls += 1;
      return { text: JSON.stringify({ 1: { forgetall: true, summary } }) };
    },
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // Step 1 carries the unit; step 2 is the one that may table it.
    await mount.transform(sessionId, messages);
    assert.equal(calls, 0, 'the carrying request asks nothing');
    const asking = largeHostMessages();
    await mount.transform(sessionId, asking);
    assert.equal(calls, 1, 'the step after the carrying request asked once');
    const ask = lines.of('ask');
    assert.equal(ask.length, 1, 'the reply is one readable fire');
    assert.equal(ask[0]?.['answered'], 0, 'no row was answered');
    assert.equal(ask[0]?.['refused'], 1, 'the over-cap row was refused');
    assert.deepEqual(ask[0]?.['parsed'], [
      { index: 1, status: 'refused', code: 'malformed-row', detail: 'summary-too-long' },
    ], 'the wire parser names the cap refusal, never a stored verdict');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.equal(entry.askVerdicts.size, 0, 'the reader never stored the over-cap summary');
    assert.equal(lines.of('ask-apply').length, 0, 'nothing was offered for apply');
    assert.equal(asking.some(message => message.id === 'msg_t1'), true,
      'the refused unit stays in the array');
    assert.equal(entry.askedUnitIds.size, 0,
      'the refused row is released for its one retry');
    const unitId = [...entry.refusedRetriedUnitIds][0];
    assert.ok(unitId !== undefined, 'the refused unit is carried to a later table');
    assert.deepEqual(ask[0]?.['carried'], [
      { index: 1, unitId, code: 'malformed-row' },
    ], 'the first refusal journals the carried row');
    // The same revision is never re-asked: the failed row waits for a later one.
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(calls, 1, 'the same revision is not retried');
    assert.equal(lines.of('ask').length, 1, 'no second ask line is written yet');
    // A later revision spends the one retry. The same over-cap refusal is now
    // final: the unit is permanently claimed and no further ask names it.
    const later = [...largeHostMessages(),
      assistantMessage('msg_turn_cap', [text('a later turn')])];
    await mount.transform(sessionId, later);
    assert.equal(calls, 2, 'the later revision spends the one retry');
    const retriedAsk = lines.of('ask')[1];
    assert.ok(retriedAsk !== undefined, 'the retry is its own fire line');
    assert.deepEqual(retriedAsk['retried'], [{ index: 1, unitId }],
      'the retry line names the carried row');
    assert.deepEqual(retriedAsk['excluded'], [
      { index: 1, unitId, code: 'malformed-row' },
    ], 'the second refusal is final and journalled');
    assert.equal(entry.askedUnitIds.size, 1, 'the unit is now permanently claimed');
    assert.equal(entry.refusedRetriedUnitIds.size, 0, 'no retry remains outstanding');
    const laterAgain = [...later,
      assistantMessage('msg_turn_cap_2', [text('one more turn')])];
    await mount.transform(sessionId, laterAgain);
    assert.equal(calls, 2, 'a twice-refused unit is never asked again');
    assert.equal(lines.of('ask').length, 2, 'no third ask line is written');
    assert.equal(lines.of('ask-apply').length, 0, 'no removal is ever attempted');
  } finally { await mount.close(); }
});

test('a stored over-cap verdict is dropped once at the descriptor gate, never retried', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // Two transforms make the carried unit seen; no ask is mounted.
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    const snapshot = entry.port.observe(messages);
    const units = new UnitTracker({
      sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes,
    }).units(snapshot);
    const unit = units.find(candidate => candidate.nodeId.endsWith(':tool:call_1'));
    assert.ok(unit !== undefined, 'the carried read is one unit');
    const summary = Array.from({ length: 26 }, (_, index) => `w${String(index)}`).join(' ');
    const verdict: WireAnswer = {
      verdict: { unitId: unit.id, action: 'forgetall', summary, answeredInRound: 1 },
    };
    entry.askVerdicts.set(unit.id, verdict);
    // The guard reads the pass round; a live ask would have fired once.
    entry.askFires = 1;
    const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
      lines.records.push({ kind, atMs: 1, ...fields });
    };
    const before = structuredClone(messages);
    const applied = await applyOpencodeAskVerdicts({
      entry, messages, snapshot, window: 200_000, journal: sink,
    });
    assert.equal(applied, false, 'the over-cap descriptor is never applied');
    assert.deepEqual(messages, before, 'the rejected removal wrote nothing');
    assert.equal(entry.askVerdicts.size, 0, 'the terminal verdict is dropped');
    const rejected = lines.of('ask-error');
    assert.equal(rejected.length, 1, 'one drop is journalled');
    assert.equal(rejected[0]?.['stage'], 'descriptor', 'the line names the descriptor stage');
    assert.equal(rejected[0]?.['code'], 'summary-too-long',
      'the line names the descriptor rule');
    assert.equal(lines.of('ask-apply').length, 0, 'no apply line claims a removal');
    // The drop is terminal: the same verdict is gone, so a later transform
    // cannot spend a second rejection on it.
    const retried = await applyOpencodeAskVerdicts({
      entry, messages, snapshot: entry.port.observe(messages), window: 200_000, journal: sink,
    });
    assert.equal(retried, false, 'the dropped verdict is never retried');
    assert.equal(lines.of('ask-error').length, 1, 'no second drop line is written');
  } finally { await mount.close(); }
});

test('an error-result verdict journals its own retention sentence', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record),
  });
  try {
    const messages: OpencodeMessage[] = [
      userMessage('msg_u1', [text('Audit the repository.')]),
      assistantMessage('msg_a1', [
        text('Reading both.'),
        toolCall('call_err', 'read', { filePath: 'GONE.md' }),
        toolCall('call_ok', 'read', { filePath: 'NOTES.md' }),
      ]),
      toolMessage('msg_te', [toolResult('call_err', 'read',
        errorResult(`ENOENT: ${'missing-'.repeat(90)}`))]),
      toolMessage('msg_tn', [toolResult('call_ok', 'read',
        textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
      assistantMessage('msg_a2', [text('Continuing.')]),
    ];
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    const snapshot = entry.port.observe(messages);
    const units = new UnitTracker({
      sessionId, barBytes: DEFAULT_CONFIG.protocol.barBytes,
    }).units(snapshot);
    const errorUnit = units.find(candidate => candidate.nodeId.endsWith(':tool:call_err'));
    const normalUnit = units.find(candidate => candidate.nodeId.endsWith(':tool:call_ok'));
    assert.ok(errorUnit !== undefined, 'the error result is one unit');
    assert.ok(normalUnit !== undefined, 'the normal result is one unit too');
    entry.askVerdicts.set(errorUnit.id, {
      verdict: { unitId: errorUnit.id, action: 'forgetall',
        summary: 'a failed call', answeredInRound: 1 },
    });
    const sink = (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
      lines.records.push({ kind, atMs: 1, ...fields });
    };
    const applied = await applyOpencodeAskVerdicts({
      entry, messages, snapshot, window: 200_000, journal: sink,
    });
    assert.equal(applied, false, 'the error result is never removed');
    assert.equal(entry.askVerdicts.size, 0, 'the error verdict is dropped');
    assert.equal(messages.some(message => message.id === 'msg_te'), true,
      'the error envelope stays in the array');
    const retained = lines.of('ask-retained');
    assert.equal(retained.length, 1, 'one retention line names the skip');
    assert.equal(retained[0]?.['code'], 'error-result-retained',
      'the skip carries its named code');
    const detail = String(retained[0]?.['detail']);
    assert.match(detail, /error or a cancelled-tool/u,
      'the sentence names the error rule');
    assert.doesNotMatch(detail, /contained in the live result/u,
      'the error skip is never labelled contained');
    assert.equal(lines.of('ask-apply').length, 0, 'no apply line claims it');
  } finally { await mount.close(); }
});

test('the mount restore route proves the archived bytes from the receipt recall id', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // Step 1 carries the unit; step 2 tables and removes it.
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const receipt = messages.find(message =>
      typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
    assert.ok(receipt !== undefined, 'the array carries the receipt');
    const rendered = receipt.content
      .filter(part => part.type === 'text' && typeof part['text'] === 'string')
      .map(part => part['text'] as string).join('');
    const recallId = /· necromancy (\S+)$/u.exec(rendered)?.[1];
    assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
      'the receipt names the recall id');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    const archive = await entry.ledger.recall(recallId);
    assert.equal(archive.parts.length, 1, 'the removed unit is one archived part');
    const archivedSha = archive.parts[0]?.source.sha256;
    assert.ok(archivedSha !== undefined, 'the archive names its source hash');
    const answer = await mount.tool.execute({ id: recallId }, { sessionID: sessionId });
    assert.equal(typeof answer.content, 'string', 'the single part returns text');
    const bytes = toBytes(String(answer.content));
    assert.equal(bytes.byteLength, archive.parts[0]?.source.byteLength,
      'the mount returns the archived byte length');
    assert.equal(sha256Sync(bytes), archivedSha,
      'the mount-returned bytes hash to the archived unit, not only match its length');
  } finally { await mount.close(); }
});

test('the ask fires past the old 32-fire boundary when triggers keep demanding', async () => {
  // ADR-0060: no per-session fire cap. Each new transform adds one fresh
  // eligible unit, so the depth trigger keeps asking past the removed 32.
  const lines = journalLines();
  let calls = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      calls += 1;
      return { text: '{"1":{"forgetall":true,"summary":"uncapped"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    const messages: OpencodeMessage[] = [userMessage('msg_u0', [text('Start.')])];
    await mount.transform(sessionId, messages);
    for (let index = 0; index < 40; index += 1) {
      messages.push(assistantMessage(`msg_a_${String(index)}`,
        [toolCall(`call_${String(index)}`, 'read', { filePath: `f${String(index)}.txt` })]));
      messages.push(toolMessage(`msg_t_${String(index)}`,
        [toolResult(`call_${String(index)}`, 'read',
          textResult(`f-${String(index)}-`.repeat(200)))]));
      await mount.transform(sessionId, messages);
    }
    assert.ok(calls > 32, 'the ask fires past the removed 32-fire boundary');
    assert.equal(lines.of('ask').length, calls,
      'every successful fire is one ask line, uncapped');
    assert.equal(lines.of('ask-error').filter(line => line['stage'] === 'cap').length, 0,
      'no cap refusal line is ever written');
    const entry = mount.sessions.get(sessionId);
    assert.equal(entry?.askFires, calls,
      'the fires-issued count reports the true number of fires');
    const mounted = lines.of('mounted');
    assert.equal('askMaxFires' in (mounted[0] ?? {}), false,
      'the mounted record names no fire cap');
  } finally { await mount.close(); }
});

test('the mounted record ceilings the 75% line for an odd window', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 333_333,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record),
  });
  try {
    const trigger = lines.of('mounted')[0]?.['trigger'];
    assert.ok(isRecord(trigger), 'the mounted line carries the trigger block');
    assert.equal(trigger['window'], 333_333, 'the configured window is named');
    assert.equal(trigger['skipAt'], 250_000,
      'the mounted 75% line is the integer ceiling, not 249,999.75');
    assert.ok(Number.isSafeInteger(trigger['skipAt']),
      'the mounted skip line is a non-null integer');
  } finally { await mount.close(); }
});

test('the double-fire guards still bound the uncapped ask', async () => {
  const lines = journalLines();
  let calls = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      calls += 1;
      return { text: '{"1":{"forgetall":true,"summary":"guarded"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // Step 1 carries the unit and asks nothing; step 2 asks once.
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    assert.equal(calls, 1, 'the step after the carrying request asks once');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    const revisions = entry.askedRevisions.size;
    // The same array delivered again names a revision already asked.
    await mount.transform(sessionId, messages);
    assert.equal(calls, 1, 'an asked revision is never asked again');
    assert.equal(entry.askedRevisions.size, revisions,
      'the repeated delivery claimed no new revision');
    // A fresh eligible unit under a second ask cannot stack while in flight.
    messages.push(assistantMessage('msg_a_late', [
      text('Reading LATE.md.'), toolCall('call_late', 'read', { filePath: 'LATE.md' })]));
    messages.push(toolMessage('msg_t_late', [toolResult('call_late', 'read',
      textResult(`# Late\n\n${'later-'.repeat(120)}\n`))]));
    await mount.transform(sessionId, messages);
    entry.askInFlight = true;
    try {
      await mount.transform(sessionId, messages);
    } finally {
      entry.askInFlight = false;
    }
    assert.equal(calls, 1, 'no ask leaves while one is already in flight');
    assert.equal(entry.askedRevisions.size, revisions,
      'the in-flight refusal claimed no revision');
    await mount.transform(sessionId, messages);
    assert.equal(calls, 2, 'the same revision asks once the in-flight guard clears');
  } finally { await mount.close(); }
});

test('a failed ask retries at most once', async () => {
  // The retry: a failed generate releases its units for one later revision.
  const retryLines = journalLines();
  let retryCalls = 0;
  const retrying = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      retryCalls += 1;
      if (retryCalls === 1) throw new Error('seam down');
      return { text: '{"1":{"forgetall":true,"summary":"retried"}}' };
    },
    journal: record => retryLines.records.push(record),
  });
  try {
    const messages = largeHostMessages();
    // Step 1 carries the unit; the step ask cannot fire yet.
    await retrying.transform(sessionId, messages);
    assert.equal(retryCalls, 0, 'the first step asks nothing');
    await retrying.transform(sessionId, messages);
    assert.equal(retryCalls, 1, 'the first attempt failed');
    await retrying.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(retryCalls, 1, 'the failed revision itself is never retried');
    messages.push(assistantMessage('msg_a3', [text('a later turn')]));
    await retrying.transform(sessionId, messages);
    assert.equal(retryCalls, 2, 'a later revision retries the released unit once');
    assert.equal(retryLines.of('ask').length, 1,
      'the retry that parsed is the one fire recorded');
    messages.push(assistantMessage('msg_a4', [text('another turn')]));
    await retrying.transform(sessionId, messages);
    await retrying.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(retryCalls, 2, 'a unit that used its retry is never released again');
  } finally { await retrying.close(); }
});

test('a cancelled l2 verdict releases the retry claim, so the unit is tabled and retried again',
  async () => {
    /*
     * ISSUE-300 audit bug 3: a unit that spent its failed-ask retry and later
     * answered `forgetall` kept `retriedUnitIds` when the verdict was cancelled,
     * so the next failed ask could not release it and it stayed permanently
     * claimed with no verdict. The release must free every claim record.
     */
    const lines = journalLines();
    let calls = 0;
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        calls += 1;
        if (calls <= 2) throw new Error('seam down');
        return { text: '{"1":{"forgetall":true,"summary":"retried after release"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = largeHostMessages();
      // Step 1 carries the unit; step 2's ask fails and grants one retry.
      await mount.transform(sessionId, messages);
      assert.equal(calls, 0, 'the carrying request asks nothing');
      await mount.transform(sessionId, messages);
      assert.equal(calls, 1, 'the first ask failed');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const unitId = [...entry.retriedUnitIds][0];
      assert.ok(unitId !== undefined, 'the failed ask recorded the spent retry');
      assert.equal(entry.askedUnitIds.size, 0, 'the failed ask released the unit for retry');
      // The state a cancelled verdict leaves: a stored answer, then the
      // survivor gate cancels it through the product's own release helper.
      entry.askedUnitIds.add(unitId);
      entry.askVerdicts.set(unitId, { verdict: {
        unitId, action: 'forgetall', summary: 'stale note', answeredInRound: 1,
      } });
      releaseCancelledUnits(entry, [{ unitId, origin: 'l2' }]);
      assert.equal(entry.askVerdicts.has(unitId), false, 'the cancelled verdict is dropped');
      assert.equal(entry.askedUnitIds.has(unitId), false, 'the permanent claim is released');
      assert.equal(entry.retriedUnitIds.has(unitId), false,
        'the spent retry no longer blocks a later release');
      assert.equal(entry.refusedRetriedUnitIds.has(unitId), false,
        'the refusal-retry record is released too');
      // A later revision's failed ask releases the unit and spends a retry again.
      messages.push(assistantMessage('msg_after_cancel', [text('a later turn')]));
      await mount.transform(sessionId, messages);
      assert.equal(calls, 2, 'the later revision asks again');
      assert.equal(entry.askedUnitIds.size, 0, 'the failed ask releases the unit again');
      assert.equal(entry.retriedUnitIds.has(unitId), true,
        'the unit can use its retry path again');
      // One more revision answers forgetall: the unit is tableable again.
      messages.push(assistantMessage('msg_after_retry', [text('another turn')]));
      await mount.transform(sessionId, messages);
      assert.equal(calls, 3, 'the released unit is tabled again');
      assert.equal(lines.of('ask-apply').length, 1, 'the readable retry applies the verdict');
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the recovered unit is removed by its new verdict');
    } finally { await mount.close(); }
  });

test('an unreadable reply is an error that still spends a fire (ISSUE-522)', async () => {
  for (const [label, unreadable] of [['prose', 'The file is large and stale.'],
    ['empty', '']] as const) {
    const lines = journalLines();
    let calls = 0;
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        calls += 1;
        return { text: calls === 1 ? unreadable
          : '{"1":{"forgetall":true,"summary":"readable now"}}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      const messages = largeHostMessages();
      // Step 1 carries the unit; step 2 is the one that may ask.
      await mount.transform(sessionId, messages);
      assert.equal(calls, 0, `${label}: the carrying request asks nothing`);
      await mount.transform(sessionId, messages);
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls, 1, `${label}: one request left`);
      assert.equal(lines.of('ask').length, 0, `${label}: an unreadable reply is not a fire`);
      const errors = lines.of('ask-error');
      assert.equal(errors.length, 1, `${label}: the attempt is one ask-error line`);
      assert.equal(errors[0]?.['stage'], 'parse', `${label}: the stage names the parse`);
      assert.equal(errors[0]?.['answered'], 0, `${label}: no row was answered`);
      assert.deepEqual(errors[0]?.['codes'], ['answer-unreadable'],
        `${label}: every row was unreadable`);
      assert.equal(errors[0]?.['applied'], false, `${label}: the error applied nothing`);
      const entry = mount.sessions.get(sessionId);
      // ISSUE-522: the request left the seam, so the fire is counted even though
      // the reply could not be read; the next ask states the repeat share line.
      assert.equal(entry?.askFires, 1, `${label}: the spent request is a fire`);
      assert.equal(entry?.askedUnitIds.size, 0, `${label}: the unit was released for retry`);
      assert.equal(entry?.retriedUnitIds.size, 1, `${label}: one retry was granted`);
      // The failed revision itself stays claimed, so idle re-entry is quiet.
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls, 1, `${label}: the failed revision is not retried by idle`);
      // A later revision spends the one retry; its readable reply is the fire.
      messages.push(assistantMessage('msg_a3', [text('a later turn')]));
      await mount.transform(sessionId, messages);
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls, 2, `${label}: the released unit is retried once`);
      const ask = lines.of('ask');
      assert.equal(ask.length, 1, `${label}: the readable retry is one fire`);
      assert.equal(ask[0]?.['answered'], 1, `${label}: the retry answered its row`);
      assert.equal(ask[0]?.['applied'], false, `${label}: the fire is record-only`);
      assert.equal(entry?.askFires, 2, `${label}: the unreadable request and the retry are two fires`);
      assert.ok((entry?.askFires ?? 0) >= 2, `${label}: the readable retry is a fire`);
      // The unit used its retry, so a later revision never releases it again.
      messages.push(assistantMessage('msg_a4', [text('another turn')]));
      await mount.transform(sessionId, messages);
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      assert.equal(calls, 2, `${label}: a spent retry is never granted twice`);
    } finally { await mount.close(); }
  }
});

test('a valid table with one answered row still fires and records the refused row', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"one of two"}}' }),
    journal: record => lines.records.push(record),
  });
  try {
    const messages = largeTwoResultMessages();
    // Step 1 carries both units; step 2 is the one that may table them.
    await mount.transform(sessionId, messages);
    assert.equal(lines.of('ask').length, 0, 'the carrying request asks nothing');
    await mount.transform(sessionId, messages);
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    const ask = lines.of('ask');
    assert.equal(ask.length, 1, 'one answered row is a readable table and a fire');
    assert.equal(lines.of('ask-error').length, 0, 'no ask-error was written');
    assert.equal(ask[0]?.['rowCount'], 2, 'the line names both assigned rows');
    assert.equal(ask[0]?.['answered'], 1, 'the answered row is counted');
    assert.equal(ask[0]?.['refused'], 1, 'the unanswered row is counted as refused');
    assert.deepEqual(ask[0]?.['parsed'], [
      { index: 1, status: 'answered', action: 'forgetall' },
      { index: 2, status: 'refused', code: 'missing-index', detail: 'missing-index' },
    ], 'both verdicts ride the ask line');
    assert.equal(ask[0]?.['applied'], false, 'the ask applied nothing');
    assert.deepEqual(ask[0]?.['carried'], [{
      index: 2, unitId: [...(mount.sessions.get(sessionId)?.refusedRetriedUnitIds ?? [])][0],
      code: 'missing-index',
    }], 'the refused row is carried to one later table');
    const entry = mount.sessions.get(sessionId);
    assert.equal(entry?.askFires, 1, 'the partial table is one fire');
    assert.equal(entry?.askedUnitIds.size, 1,
      'only the answered forgetall unit stays permanently claimed');
    assert.equal(entry?.refusedRetriedUnitIds.size, 1,
      'the refused unit is released for its one retry');
  } finally { await mount.close(); }
});

test('the ask mount option and its host-seam check', async () => {
  assert.equal(mountOptionsFromHost({ crematorAskGrammar: 'prune-two-option' }).askGrammar,
    'prune-two-option', 'the config value reaches the mount option');
  assert.equal(mountOptionsFromHost({}).askGrammar, undefined, 'absent is off');
  assert.equal(mountOptionsFromHost({ crematorAskGrammar: '' }).askGrammar, undefined,
    'an empty value is off');
  assert.throws(() => mountOptionsFromHost({ crematorAskGrammar: 'jsonl-20' }),
    /crematorAskGrammar/u, 'another grammar is refused by name');
  assert.throws(() => createOpencodeMount({ askGrammar: 'prune-two-option' }),
    /askGenerate/u, 'an enabled ask without its seam fails at construction');
  assert.throws(() => createOpencodeMount({
    askGrammar: 'jsonl-20' as never,
    askGenerate: async () => ({ text: '{}' }),
  }), /crematorAskGrammar is "jsonl-20"/u,
  'a programmatic caller naming another grammar is refused by name');

  const host = fakeHost({}, false, false);
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' }, askGrammar: 'prune-two-option', journal: () => {},
  });
  await assert.rejects(() => plugin.setup(host.context), /session\.generate/u,
    'the plugin refuses an ask on a host without session.generate');

  const withSeam = fakeHost();
  const lines = journalLines();
  const works = createOpencodePlugin({
    storage: { databasePath: ':memory:' }, askGrammar: 'prune-two-option',
    journal: record => lines.records.push(record),
  });
  const cleanup = await works.setup(withSeam.context);
  try {
    // Step 1 carries the unit; step 2 is the one that may ask.
    await withSeam.contextHook?.(sessionContext(largeHostMessages()));
    await withSeam.contextHook?.(sessionContext(largeHostMessages()));
    withSeam.stream.push({ type: 'session.idle', data: { sessionID: sessionId } });
    for (let attempt = 0; attempt < 20 && lines.of('ask').length === 0; attempt += 1) {
      await tick();
    }
    assert.equal(withSeam.generateCalls.length, 1,
      'the plugin passes the host session.generate seam to the mount');
    assert.equal(lines.of('ask').length, 1, 'the mount journalled the fire');
    assert.ok((lines.of('mounted')[0]?.['seams'] as string[]).includes('session.generate'),
      'the mounted line names the ask seam');
  } finally { await cleanup(); }
});

test('the manual pass runs the table on demand, below the bar', async () => {
  const lines = journalLines();
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 60_000,
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      asks += 1;
      return { text: '{"1":{"forgetall":true,"summary":"mock ask answer"}}' };
    },
    journal: record => lines.records.push(record),
  });
  try {
    // Two revisions carry the unit; neither crosses the 60k bar.
    await mount.transform(sessionId, largeHostMessages());
    await mount.transform(sessionId, largeHostMessages());
    assert.equal(asks, 0, 'the automatic ask stays quiet below the bar');
    const first = await mount.cremate(sessionId);
    assert.equal(first.fired, true, 'the manual pass tables without a crossing');
    assert.equal(asks, 1, 'the manual pass runs the same table');
    const ask = lines.of('ask').at(-1);
    assert.equal(ask?.['origin'], 'command', 'the fire names the manual origin');
    assert.equal(ask?.['rowCount'], 1, 'the manual table names the carried unit');
    assert.equal(lines.of('cremate').at(-1)?.['fired'], true,
      'the manual pass journals its fire');
    assert.equal(lines.of('cremate').at(-1)?.['reason'], 'table');
    // The same-revision guard still holds: one table per revision, however it
    // was requested. ISSUE-486: the carried unit is dropped by its durable
    // claim, so the refusal is named `claimed-unit`, not an empty `no-rows`.
    const second = await mount.cremate(sessionId);
    assert.equal(second.fired, false);
    assert.equal(second.reason, 'claimed-unit');
    assert.equal(asks, 1, 'a second pass at the same revision is guarded');
    assert.equal(lines.of('cremate').at(-1)?.['claims'], 1,
      'the manual line names the claimed row it suppressed');
  } finally { await mount.close(); }

  // With the ask off there is no table to run; the command says so instead of
  // pretending it did something.
  const offLines = journalLines();
  const offMount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => offLines.records.push(record),
  });
  try {
    await offMount.transform(sessionId, largeHostMessages());
    assert.equal((await offMount.cremate(sessionId)).fired, false,
      'the ask-off command fires nothing');
    assert.equal(offLines.of('cremate').at(-1)?.['reason'], 'ask-off',
      'the journal names the missing ask');
  } finally { await offMount.close(); }
});

test('ISSUE-412: /cremate under the ask lock does not consume the depth latch', async () => {
  /*
   * A manual pass refused by the in-flight ask lock did not run, so recording
   * it as completed would re-arm the latch against a pass that never happened.
   * The skip is named `ask-in-flight` and the latch state is byte-for-byte what
   * the in-flight ask's own pass left.
   */
  const lines = journalLines();
  let started: () => void = () => {};
  const startedAt = new Promise<void>(resolve => { started = resolve; });
  let release: (answer: { text: string }) => void = () => {};
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askGenerate: () => {
      started();
      return new Promise<{ text: string }>(resolve => { release = resolve; });
    },
    journal: record => lines.records.push(record),
  });
  let step: Promise<void> | undefined;
  try {
    // The first request ships the units; the second crosses the bar and asks.
    // Its generate hangs, so the lane lock is held while /cremate is invoked.
    await mount.transform(sessionId, largeHostMessages());
    step = mount.transform(sessionId, largeHostMessages());
    await startedAt;
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.equal(entry.askInFlight, true, 'the step ask holds the lane');
    const before = entry.pruneTrigger.snapshot();

    assert.equal((await mount.cremate(sessionId)).fired, false, 'the manual pass cannot run');
    assert.deepEqual(entry.pruneTrigger.snapshot(), before,
      'the refused manual pass leaves the depth latch exactly as it was');
    const skip = lines.of('cremate').at(-1);
    assert.equal(skip?.['fired'], false, 'the skip fired nothing');
    assert.equal(skip?.['reason'], 'ask-in-flight',
      'the skip is named, distinct from deferral and failure');
    assert.equal(lines.of('ask').length, 0, 'no fire was recorded for the skipped pass');
  } finally {
    release({ text: '{}' });
    await step;
    await mount.close();
  }
});

test('ISSUE-447: a prepared-only ledger stands every ask lane down before generate',
  async () => {
    /*
     * Core answers `recovery-pending` before planning a prune while a prepared
     * intent has no applied/abandoned row. The step, idle and `/cremate` lanes
     * must read that health before paying the host, journal one named reason,
     * and send nothing.
     */
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' }, contextWindowTokens: 400_000,
      pruneThresholdTokens: 100, askGrammar: 'prune-two-option',
      askGenerate: async (input) => { calls.push(input); return { text: '{}' }; },
      journal: record => lines.records.push(record),
    });
    try {
      // The first request ships the units; with nothing yet seen it asks nothing.
      await mount.transform(sessionId, largeHostMessages());
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      await entry.ledger.prepare({
        sessionId, eventId: 'evt-447', baseRevision: 'rev-447', phase: 'entry',
        applicationSha256: sha256Sync(toBytes('guard-verified application')),
        archives: [], appendRecords: [], sealedEpisodeIds: [],
      });
      // The step crossing reads the prepared-only ledger and stands down.
      await mount.transform(sessionId, [...largeHostMessages(),
        userMessage('msg_447', [text('Continue.')])]);
      // The idle lane reads the same health.
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      // The manual command reads it too, and is not gated by the latch.
      assert.equal((await mount.cremate(sessionId)).fired, false,
        'the command runs no pass against an unhealthy ledger');
      assert.equal(calls.length, 0, 'no ask lane paid the host');
      const standdowns = lines.of('ask-standdown');
      assert.deepEqual(standdowns.map(line => line['origin']), ['step', 'idle', 'command'],
        'each lane journals exactly one stand-down');
      for (const line of standdowns) {
        assert.equal(line['reason'], 'recovery-pending', 'the reason names the standdown');
      }
    } finally { await mount.close(); }
  });

test('ISSUE-447: a disabled breaker stands the ask lane down before generate', async () => {
  const lines = journalLines();
  const calls: OpencodeGenerateInput[] = [];
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' }, contextWindowTokens: 400_000,
    pruneThresholdTokens: 100, askGrammar: 'prune-two-option',
    askGenerate: async (input) => { calls.push(input); return { text: '{}' }; },
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    await entry.ledger.append({
      kind: 'validation', sessionId, eventKey: 'disabled-447', atMs: 1,
      eventId: 'evt-447', ok: false, issues: [],
      breaker: { consecutiveValidationFailures: 2, disabled: true },
    } as unknown as LedgerEvent);
    await mount.transform(sessionId, [...largeHostMessages(),
      userMessage('msg_447_disabled', [text('Continue.')])]);
    assert.equal(calls.length, 0, 'the host was not paid');
    const line = lines.of('ask-standdown').at(-1);
    assert.equal(line?.['reason'], 'breaker-open');
    assert.equal(line?.['origin'], 'step');
  } finally { await mount.close(); }
});

test('ISSUE-447: a refusing ledger read stands down by name, never throws', async () => {
  const refusing = {
    events: async function* refusingEvents(): AsyncGenerator<never> {
      throw new Error('disk gone');
    },
  } as unknown as Ledger;
  assert.equal(await opencodeAskStanddown(refusing, sessionId), 'ledger-unavailable',
    'a throwing read is the named fail-open standdown');
});

test('the /cremate command tables a unit first carried by the last sent request', async () => {
  /*
   * ISSUE-300 audit bug 7: the command built its batch from `seenNodeIds`
   * without promoting the last transform's shipped nodes, so the unit the
   * request had just carried was not tableable. The command is the same pass as
   * a step and must promote first.
   */
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"command unit"}}' }),
    journal: record => lines.records.push(record),
  });
  try {
    await mount.transform(sessionId, largeHostMessages());
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the context hook built the session');
    assert.ok(entry.pendingSeenNodeIds.size > 0,
      'the transform recorded the unit its request shipped');
    assert.equal(entry.seenNodeIds.size, 0, 'no later request promoted it yet');
    const { fired } = await mount.cremate(sessionId);
    assert.equal(fired, true, 'the command tables the last sent request\'s unit');
    const ask = lines.of('ask').at(-1);
    assert.equal(ask?.['rowCount'], 1, 'the command table names that unit');
    assert.equal(entry.pendingSeenNodeIds.size, 0,
      'the command promoted the shipped nodes, like the step path');
    assert.ok(entry.seenNodeIds.size > 0, 'the unit is eligible after the promotion');
  } finally { await mount.close(); }
});

test('the ledger scan walks a 10,000-event session once', async () => {
  /*
   * ISSUE-300 item 18: the scan is O(events) per call, so a 10,000-event
   * session is one walk, not a call per row. A wall-clock bound would be flaky
   * on a loaded machine; the counted walk and the one `events()` call are the
   * guard.
   */
  let walked = 0;
  let calls = 0;
  const fake = {
    async *events() {
      calls += 1;
      for (let index = 0; index < 10_000; index += 1) {
        walked += 1;
        yield {
          sequence: index,
          event: index === 4_999
            ? { kind: 'applied', sessionId, receipt: { baseRevision: 'rev-x' } }
            : { kind: 'validation', sessionId },
        };
      }
    },
  };
  const rewrites = await appliedRewritesAt(fake as never, sessionId, 'rev-x');
  assert.equal(rewrites, 1, 'the one matching applied receipt is counted');
  assert.equal(calls, 1, 'the ledger is read once per scan call');
  assert.equal(walked, 10_000, 'every event is walked exactly once');
});

test('the ledger scan runs per request boundary and apply, never per removal', async () => {
  /*
   * The same two transforms over a one-unit and a four-unit fixture. The
   * four-unit apply removes four units in one document; a scan per removal
   * would read the ledger four times as often in that arm.
   */
  const run = async (units: 1 | 4) => {
    const lines = journalLines();
    const messages = units === 1 ? largeHostMessages() : fourUnitHostMessages();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: Array.from({ length: units }, (_, index) =>
        JSON.stringify({ [String(index + 1)]:
          { forgetall: true, summary: `note ${String(index + 1)}` } })).join('\n') }),
      journal: record => lines.records.push(record),
    });
    try {
      // Step 1 carries the units; step 2 is the one that may table them.
      await mount.transform(sessionId, messages);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      const original = entry.ledger.events.bind(entry.ledger);
      let scans = 0;
      entry.ledger.events = async function* counted(id) {
        scans += 1;
        yield* original(id);
      };
      await mount.transform(sessionId, messages);
      return { scans, applies: lines.of('ask-apply').length };
    } finally { await mount.close(); }
  };
  const one = await run(1);
  const four = await run(4);
  assert.equal(one.applies, 1, 'the one-unit apply journals one removal line');
  assert.equal(four.applies, 4, 'the four-unit apply journals four removal lines');
  assert.equal(four.scans, one.scans,
    'four removals in one apply read the ledger no more often than one removal');
  assert.ok(one.scans <= 8,
    `the scan count is per boundary and apply, got ${String(one.scans)} ledger reads`);
});

test('what every hook writes, and with what reason', async () => {
  await runRows(HOOK_ROWS);
});

/**
 * The cleanup commit is not a committed pass. A stale-receipt cleanup splices
 * the host array while the at-rest row says `unchanged`; without its own
 * `reason` the bench's orphan-commit rule counts it as a committed pass with no
 * applied row and fails the run. The commit line names it, and the rule as the
 * bench lane reads it accepts the row.
 */
test('a cleanup commit is journalled with reason cleanup and is not an orphan commit',
  async () => {
    const lines = journalLines();
    const base = hostMessages();
    const intentId = 'intent-cleanup-commit';
    const withPass = opencodeReceiptTextWithPass(STALE_RECEIPT_TEXT, intentId);
    assert.ok(withPass !== null, 'the fixture text is the product\'s receipt line');
    const receipt = receiptMessageFor(
      intentId, 'note-1', withPass, fixtureForgottenNodeId(base));
    const messages = [...base, receipt];
    const request = removalRequest(
      sealedRemoval(messages, 'note-1', STALE_RECEIPT_TEXT), intentId, 'note-1',
      STALE_RECEIPT_TEXT);
    let arm = false;
    const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
      const inner = createOpencodePort(options);
      return {
        snapshot: async () => {
          if (arm) {
            arm = false;
            await inner.apply(request);
          }
          return inner.snapshot();
        },
        apply: applyRequest => inner.apply(applyRequest),
        lookupReceipt: id => inner.lookupReceipt(id),
        refusal: () => inner.refusal(),
        observe: (observed, observeOptions) => inner.observe(observed, observeOptions),
        commit: () => inner.commit(),
        lastCommitKind: () => inner.lastCommitKind(),
      };
    };
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' }, createPort,
      journal: record => lines.records.push(record),
    });
    try {
      arm = true;
      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message =>
        typeof message[OPENCODE_RECORD_ID_FIELD] === 'string'), false,
      'the cleanup spliced the stale receipt out of the request');
      const step = lines.of('at-rest').filter(line => line['reason'] === 'step').at(-1);
      assert.equal(step?.['status'], 'unchanged',
        'the at-rest row applies nothing, which is why the commit needs its own name');
      const commit = lines.of('commit').at(-1);
      assert.equal(commit?.['committed'], true, 'the cleanup splice reports committed');
      assert.equal(commit?.['reason'], 'cleanup', 'the commit line names the cleanup');
      assert.equal(commit?.['eventId'], step?.['eventId'],
        'the commit names the pass whose array it spliced');
      // The bench's orphan-commit rule (dev/bench/opencode-run.mjs:18421-18425),
      // with the one predicate the bench lane is asked to add: a `cleanup`
      // commit is legitimate and is not orphaned by its unchanged at-rest row.
      const commits = lines.of('commit').map(row => ({
        eventId: typeof row['eventId'] === 'string' ? row['eventId'] : null,
        committed: row['committed'] === true,
        reason: typeof row['reason'] === 'string' ? row['reason'] : null,
      }));
      const atRest = lines.of('at-rest').map(row => ({
        eventId: typeof row['eventId'] === 'string' ? row['eventId'] : null,
        status: typeof row['status'] === 'string' ? row['status'] : null,
      }));
      const orphanCommits = commits.filter(row => row.committed
        && row.reason !== 'cleanup'
        && !atRest.some(at => at.eventId === row.eventId && at.status === 'applied'));
      assert.deepEqual(orphanCommits, [], 'a cleanup commit is not an orphan commit');
      assert.deepEqual(
        commits.filter(row => row.committed
          && !atRest.some(at => at.eventId === row.eventId && at.status === 'applied'))
          .map(row => row.reason),
        ['cleanup'], 'the only receipt-less commit is the one the line names');
    } finally { await mount.close(); }
  });

test('restart: the ledger seeds the applied index, so a banked removal is re-applied', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root }, journal: () => {},
    });
    const committed = staleReadMessages();
    try {
      await first.transform(sessionId, committed);
    } finally {
      await first.close();
    }
    const line = receiptLines(committed)[0];
    assert.ok(line !== undefined, 'the first process wrote its receipt line');
    const recallId = /· necromancy (\S+)$/u.exec(line)?.[1];
    assert.ok(recallId !== undefined, 'the line names its recall id');
    assert.equal(committed.some(message => message.id === 'msg_t1'), false,
      'the first process removed the stale read');

    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root }, journal: () => {},
    });
    try {
      // The host rebuild keeps the line and brings the unit back. A later live
      // result contains the unit's exact text, so the retention rules would
      // refuse a first-time offer; the ledger-seeded index says it is banked.
      const rebuilt = rebuiltStaleRead(line);
      await second.transform(sessionId, rebuilt.messages);
      assert.equal(rebuilt.messages.some(message => message.id === 'msg_t1'), false,
        'the banked removal is re-applied after the restart');
      assert.equal(receiptLines(rebuilt.messages).filter(value => value === line).length, 1,
        'one receipt line after the first post-restart rebuild');
      assert.equal(rebuilt.messages.includes(rebuilt.hostReceipt), true,
        'the host-rebuilt line is reused, not copied into a second line');
      const entry = second.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the reopened mount built the session');
      assert.equal([...entry.appliedPlans.values()].some(plan =>
        (plan.forgotten ?? []).includes(opencodeToolNodeId(sessionId, 'call_read'))), true,
      'the seeded index names the unit the ledger applied');

      const again = rebuiltStaleRead(line);
      await second.transform(sessionId, again.messages);
      assert.equal(again.messages.some(message => message.id === 'msg_t1'), false,
        'the second rebuild is rewritten again');
      assert.equal(receiptLines(again.messages).filter(value => value === line).length, 1,
        'still one receipt line after the second rebuild');
      assert.equal(again.messages.includes(again.hostReceipt), true,
        'the second host-rebuilt line is reused too');
    } finally {
      const entry = second.sessions.get(sessionId);
      if (entry !== undefined) await entry.ledger.close().catch(() => {});
      await second.close();
    }

    // Non-vacuity: the same durable ledger and a fresh rebuilt request through a
    // port that ignores the seed read the unit as a first-time offer and keep it.
    const unseeded = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      createPort: options => createOpencodePort({ ...options, appliedPlans: [] }),
      journal: () => {},
    });
    try {
      const control = rebuiltStaleRead(line);
      await unseeded.transform(sessionId, control.messages);
      assert.equal(control.messages.some(message => message.id === 'msg_t1'), true,
        'without the seeded index the contained unit is kept as a first-time offer');
      assert.equal(receiptLines(control.messages).filter(value => value === line).length, 1,
        'the refused first-time offer writes no second line');
    } finally {
      await unseeded.close();
    }
  } finally {
    cleanup(dir);
  }
});

test('storage-unavailable is fail-open: untouched array, one line, retry next hook', async () => {
  const lines = journalLines();
  let opens = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    openLedger: async (target, clock) => {
      opens += 1;
      if (opens === 1) throw new Error('the ledger file is gone');
      return openLedger(target, clock);
    },
    journal: record => lines.records.push(record),
  });
  const messages = staleReadMessages();
  const before = structuredClone(messages);
  try {
    await mount.transform(sessionId, messages);
    assert.deepEqual(messages, before, 'the request keeps every byte when storage is unavailable');
    assert.equal(lines.of('storage-unavailable').length, 1, 'exactly one storage line');
    assert.equal(opens, 1, 'the first open was attempted');
    assert.equal(mount.sessions.has(sessionId), false, 'no session was remembered');

    await mount.transform(sessionId, messages);
    assert.equal(opens, 2, 'the next hook retries the open');
    assert.equal(lines.of('storage-unavailable').length, 1, 'the retry writes no second line');
    assert.equal(mount.sessions.has(sessionId), true, 'the retry builds the session');
  } finally {
    const entry = mount.sessions.get(sessionId);
    if (entry !== undefined) await entry.ledger.close().catch(() => {});
    await mount.close();
  }
});

test('transform-error is fail-open: untouched array, one line, retry next hook', async () => {
  const lines = journalLines();
  let observes = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    createPort: (options) => {
      const inner = createOpencodePort(options);
      return {
        snapshot: () => inner.snapshot(),
        apply: request => inner.apply(request),
        lookupReceipt: intentId => inner.lookupReceipt(intentId),
        observe: (messages, observeOptions) => {
          observes += 1;
          if (observes === 1) throw new Error('the projection broke');
          return inner.observe(messages, observeOptions);
        },
        commit: () => inner.commit(),
        lastCommitKind: () => inner.lastCommitKind(),
        refusal: () => inner.refusal(),
        appliedPlanIndex: () => inner.appliedPlanIndex(),
      };
    },
    journal: record => lines.records.push(record),
  });
  const messages = staleReadMessages();
  const before = structuredClone(messages);
  try {
    await mount.transform(sessionId, messages);
    assert.deepEqual(messages, before, 'the request keeps every byte when the pass throws');
    assert.equal(lines.of('transform-error').length, 1, 'exactly one transform-error line');
    assert.equal(mount.sessions.has(sessionId), true, 'the session exists; its pass failed');

    await mount.transform(sessionId, messages);
    assert.equal(lines.of('transform-error').length, 1, 'the retry does not fail again');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the retry applies the stale-read removal');
  } finally { await mount.close(); }
});

test('a throwing journal sink is fail-open: the removal still lands and claims once', async () => {
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: () => { throw new Error('the journal file is unwritable'); },
  });
  const messages = staleReadMessages();
  try {
    // The sink throws on every line, including `mounted`; the hook must still
    // finish and the pass must still land its removal.
    await mount.transform(sessionId, messages);
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the removal lands even though every journal write threw');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session still opened its ledger');
    const applied: string[] = [];
    for await (const { event } of entry.ledger.events(sessionId)) {
      if (event.kind === 'applied') applied.push(event.receipt.intentId);
    }
    assert.equal(applied.length, 1, 'the ledger still holds one applied claim');
  } finally { await mount.close(); }
});

test('a throwing journal sink on a failed pass is fail-open: untouched array, retry next hook',
  async () => {
    let observes = 0;
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: () => { throw new Error('the journal file is unwritable'); },
      createPort: (options) => {
        const inner = createOpencodePort(options);
        return {
          snapshot: () => inner.snapshot(),
          apply: request => inner.apply(request),
          lookupReceipt: intentId => inner.lookupReceipt(intentId),
          observe: (messages, observeOptions) => {
            observes += 1;
            if (observes === 1) throw new Error('the projection broke');
            return inner.observe(messages, observeOptions);
          },
          commit: () => inner.commit(),
          lastCommitKind: () => inner.lastCommitKind(),
          refusal: () => inner.refusal(),
          appliedPlanIndex: () => inner.appliedPlanIndex(),
        };
      },
    });
    const messages = staleReadMessages();
    const before = structuredClone(messages);
    try {
      // The pass throws; its `transform-error` line cannot be written because
      // the sink throws too. Neither failure may reach the host or the array.
      await mount.transform(sessionId, messages);
      assert.deepEqual(messages, before, 'the failed pass keeps every byte');
      assert.equal(mount.sessions.has(sessionId), true, 'the session exists; only the pass failed');

      await mount.transform(sessionId, messages);
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the retry applies the removal while the sink still throws');
    } finally { await mount.close(); }
  });

test('a throwing ledger events read is fail-open: untouched array, one line, retry next hook',
  async () => {
    const lines = journalLines();
    const failures = { left: 2 }; // the seed read, then the pass's applied-rewrites read
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      openLedger: async (target, clock) => {
        const ledger = await openLedger(target, clock);
        return {
          prepare: application => ledger.prepare(application),
          append: event => ledger.append(event),
          events: async function* (id) {
            if (failures.left > 0) {
              failures.left -= 1;
              throw new Error('the ledger read is unavailable');
            }
            yield* ledger.events(id);
          },
          recall: (id, options) => ledger.recall(id, options),
          close: () => ledger.close(),
        };
      },
      journal: record => lines.records.push(record),
    });
    const messages = staleReadMessages();
    const before = structuredClone(messages);
    try {
      // The seed read throws and is named (`applied-plans`, ISSUE-575); the
      // pass's own read throws and becomes one `transform-error` line.
      await mount.transform(sessionId, messages);
      assert.deepEqual(messages, before, 'both failed reads leave the request byte-identical');
      assert.equal(lines.of('mount-state-error')
        .filter(record => record['fact'] === 'applied-plans').length, 1,
      'the failed applied-plan seed read is named');
      assert.equal(lines.of('transform-error').length, 1, 'exactly one transform-error line');
      assert.equal(mount.sessions.has(sessionId), true, 'the session exists; only its reads failed');

      await mount.transform(sessionId, messages);
      assert.equal(lines.of('transform-error').length, 1, 'the retry does not fail again');
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the retry applies the removal');
    } finally { await mount.close(); }
  });

test('a throwing commit is fail-open: untouched array, one line, no claim, retry next hook',
  async () => {
    const lines = journalLines();
    const control = { throws: true };
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      createPort: (options) => {
        const inner = createOpencodePort(options);
        return {
          snapshot: () => inner.snapshot(),
          apply: request => inner.apply(request),
          lookupReceipt: intentId => inner.lookupReceipt(intentId),
          observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
          commit: () => {
            if (control.throws) throw new Error('the host splice refused');
            return inner.commit();
          },
          lastCommitKind: () => inner.lastCommitKind(),
          refusal: () => inner.refusal(),
          appliedPlanIndex: () => inner.appliedPlanIndex(),
        };
      },
      journal: record => lines.records.push(record),
    });
    const messages = staleReadMessages();
    const before = structuredClone(messages);
    try {
      await mount.transform(sessionId, messages);
      assert.deepEqual(messages, before, 'a throwing commit leaves the host array untouched');
      assert.equal(lines.of('transform-error').length, 1, 'exactly one transform-error line');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session exists; the commit failed');
      const idsOf = async (kind: 'applied' | 'prepared'): Promise<string[]> => {
        const ids: string[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'applied' && kind === 'applied') ids.push(event.receipt.intentId);
          if (event.kind === 'prepared' && kind === 'prepared') ids.push(event.intentId);
        }
        return ids;
      };
      assert.deepEqual(await idsOf('applied'), [], 'a throwing commit claims no applied removal');
      const pending = [...new Set(await idsOf('prepared'))];
      assert.equal(pending.length, 1, 'the failed attempt left one prepared intent, unproved');

      // ISSUE-354: the throwing hook kept the stage, so the retry lands it. The
      // core's recovery still blocks a second engine write (the prepared intent
      // is unproved until the splice lands), but the mount's commit backstop is
      // the retry the kept stage waits for. The hook does not throw, and the
      // durable claim follows the wire write rather than preceding it.
      control.throws = false;
      await mount.transform(sessionId, messages);
      assert.equal(lines.of('transform-error').length, 1, 'the next hook does not fail again');
      assert.equal(messages.some(message => message.id === 'msg_t1'), false,
        'the retry lands the kept stage: the stale read is gone');
      assert.equal(messages.length, before.length, 'the removal is a replacement, not a drop');
      assert.ok(messages.some(message => message.id?.startsWith('racoons-record:')),
        'the receipt for the removed read rides in the array');
      assert.deepEqual(await idsOf('applied'), [],
        'the durable claim follows the wire write; recovery has not reconciled yet');
    } finally { await mount.close(); }
  });

test('ISSUE-448: a fresh mount resolves the prior process landed receipt and claims applied',
  async () => {
    /*
     * The old "next process" phase re-entered the SAME mount, so its
     * `receipts`/`committedIntents` maps were still populated and the assertion
     * proved nothing about durable state. This test kills the first mount after
     * the commit landed and rebuilds a mount and port on the same root.
     */
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const control = { throws: true };
      const first = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        createPort: (options) => {
          const inner = createOpencodePort(options);
          return {
            snapshot: () => inner.snapshot(),
            apply: request => inner.apply(request),
            lookupReceipt: intentId => inner.lookupReceipt(intentId),
            observe: (messages, observeOptions) => inner.observe(messages, observeOptions),
            commit: () => {
              if (control.throws) throw new Error('the host splice refused');
              return inner.commit();
            },
            lastCommitKind: () => inner.lastCommitKind(),
            refusal: () => inner.refusal(),
            appliedPlanIndex: () => inner.appliedPlanIndex(),
          };
        },
        journal: () => {},
      });
      const messages = staleReadMessages();
      const pendingIds = new Set<string>();
      try {
        // The first pass files the prepared row but its commit throws.
        await first.transform(sessionId, messages);
        const entry = first.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the first mount built the session');
        // The retry splices the kept stage, minting and persisting the receipt.
        control.throws = false;
        await first.transform(sessionId, messages);
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'prepared') pendingIds.add(event.intentId);
          if (event.kind === 'applied') pendingIds.delete(event.receipt.intentId);
        }
        assert.equal(pendingIds.size, 1,
          'the landed stage leaves one prepared intent the first process never reconciled');
        assert.ok(receiptLines(messages).length > 0, 'the landed receipt rides in the array');
      } finally {
        await first.close();
      }
      const pending = [...pendingIds];
      const line = receiptLines(messages)[0];
      assert.ok(line !== undefined, 'the committed pass wrote its receipt line');

      // A NEW mount and port on the same durable root: no in-process memory.
      const lines = journalLines();
      const second = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        journal: record => lines.records.push(record),
      });
      try {
        const rebuilt = rebuiltStaleRead(line);
        await second.transform(sessionId, rebuilt.messages);
        const entry = second.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the fresh mount built the session');
        const lookup = await entry.port.lookupReceipt(pending[0] as never);
        assert.equal(lookup.status, 'applied',
          'the remounted port resolves the durable receipt without the old process map');
        const applied: string[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'applied') applied.push(event.receipt.intentId);
        }
        assert.ok(applied.includes(pending[0] as string),
          'recovery reconciled the prepared row into the durable applied claim');
        assert.equal(lines.of('intent-abandoned').length, 0,
          'a row the durable receipt proves is never abandoned');
      } finally {
        const entry = second.sessions.get(sessionId);
        if (entry !== undefined) await entry.ledger.close().catch(() => {});
        await second.close();
      }

      // The reconciled `applied` row is now the seed a healthy remount reads:
      // the applied-plan index names the unit the recovered receipt removed.
      const third = createOpencodeMount({
        storage: { crematorStorageRoot: root }, journal: () => {},
      });
      try {
        await third.transform(sessionId, rebuiltStaleRead(line).messages);
        const thirdEntry = third.sessions.get(sessionId);
        assert.ok(thirdEntry !== undefined, 'the third mount built the session');
        assert.equal([...thirdEntry.appliedPlans.values()].some(plan =>
          (plan.forgotten ?? []).includes(opencodeToolNodeId(sessionId, 'call_read'))), true,
        'the reconciled applied row seeds the plan index for the next mount');
      } finally {
        await third.close();
      }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-448: a prepared row with no durable receipt is abandoned once on remount',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const first = createOpencodeMount({
        storage: { crematorStorageRoot: root }, journal: () => {},
      });
      let intentId = '';
      try {
        await first.transform(sessionId, staleReadMessages());
        const entry = first.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the first mount built the session');
        intentId = 'intent-448-orphan';
        await entry.ledger.prepare({
          sessionId, eventId: 'evt-448', baseRevision: 'rev-448', phase: 'entry',
          applicationSha256: sha256Sync(toBytes('orphan prepared row')),
          archives: [], appendRecords: [], sealedEpisodeIds: [],
        });
        // The ledger's prepare() mints its own intent id; read it back so the
        // assertion names the row the remount must close.
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'prepared') intentId = event.intentId;
        }
      } finally {
        await first.close();
      }
      const lines = journalLines();
      const second = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        journal: record => lines.records.push(record),
      });
      try {
        await second.transform(sessionId, staleReadMessages());
        const abandoned = lines.of('intent-abandoned');
        assert.equal(abandoned.length, 1, 'the unprovable row is closed exactly once');
        assert.equal(abandoned[0]?.['intentId'], intentId, 'the line names the row');
        assert.equal(abandoned[0]?.['reason'], 'no-durable-receipt', 'the reason is named');
        const entry = second.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the remount built the session');
        const rows: string[] = [];
        for await (const { event } of entry.ledger.events(sessionId)) {
          if (event.kind === 'abandoned') rows.push(event.intentId as string);
        }
        assert.ok(rows.includes(intentId), 'the abandoned outcome is durable');
        // A later pass is not blocked: no recovery-pending stand-down.
        const standdowns = lines.of('ask-standdown')
          .filter(row => row['reason'] === 'recovery-pending');
        assert.equal(standdowns.length, 0, 'the closed row no longer stands the session down');
      } finally {
        await second.close();
      }
    } finally {
      cleanup(dir);
    }
  });

test('the step-ended reconciliation: every bucket, and nothing invented', async () => {
  await runRows(ACCOUNTING_ROWS);
});

test('ISSUE-409: an unapplied verdict survives a restart and applies without re-asking',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    const calls: string[] = [];
    try {
      const first = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => {
          calls.push('first');
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: () => {},
      });
      try {
        // The install boundary keeps pre-existing history out of every ask
        // lane. The install array carries no tool node, so the unit a later
        // request brings is eligible (ISSUE-419).
        await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
        const messages = largeHostMessages();
        await first.transform(sessionId, messages);
        assert.equal(calls.length, 0, 'the carrying request tables nothing');
        assert.equal((await first.cremate(sessionId)).fired, true,
          'the command fires the table pass');
        const entry = first.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the first mount built the session');
        assert.equal(calls.length, 1, 'the command asked once');
        assert.equal(entry.askVerdicts.size, 1, 'the verdict is stored, not yet applied');
        assert.equal(entry.deferredApply, true, 'the next boundary owes the apply');
      } finally { await first.close(); }

      // A new mount and port: the verdict exists only in durable state now.
      const lines = journalLines();
      const second = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => {
          calls.push('second');
          return { text: '{}' };
        },
        journal: record => lines.records.push(record),
      });
      try {
        await second.transform(sessionId, largeHostMessages());
        const resumed = lines.of('ask-state-resumed');
        assert.equal(resumed.length, 1, 'the mount names the restored ask state');
        assert.equal(resumed[0]?.['verdicts'], 1, 'the line names one restored verdict');
        assert.equal(calls.length, 1, 'the restored verdict is applied, not re-asked');
        assert.equal(lines.of('ask').length, 0, 'no ask left the fresh process');
        assert.equal(lines.of('ask-apply').length, 1, 'the restored verdict applied');
      } finally { await second.close(); }

      // Applied means settled: a third mount restores no verdict to replay.
      const thirdLines = journalLines();
      const third = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => { calls.push('third'); return { text: '{}' }; },
        journal: record => thirdLines.records.push(record),
      });
      try {
        await third.transform(sessionId, largeHostMessages());
        assert.equal(thirdLines.of('ask-state-resumed').length, 0,
          'an applied verdict is cleared from durable state, so a reopen does not replay it');
      } finally { await third.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-409: a claimed revision is not re-asked after a restart', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const calls: string[] = [];
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        calls.push('first');
        return { text: '{}' };
      },
      journal: () => {},
    });
    try {
      // No boundary is claimed for eligibility (ADR-0069); the first request
      // simply carries no tool node, so the seen set stays empty.
      await first.transform(sessionId, []);
      const messages = largeHostMessages();
      await first.transform(sessionId, messages);
      assert.equal(calls.length, 0, 'the carrying request tables nothing');
      await first.transform(sessionId, messages);
      const entry = first.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first mount built the session');
      assert.equal(calls.length, 1, 'the step ask claimed the revision once');
      assert.ok(entry.askedRevisions.size > 0, 'the claim is held in memory');
      assert.equal(entry.askVerdicts.size, 0, 'the empty reply stored no verdict');
      assert.equal(entry.lastMessages?.length, messages.length,
        'the untouched array keeps the same revision');
    } finally { await first.close(); }

    const lines = journalLines();
    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => {
        calls.push('second');
        return { text: '{}' };
      },
      journal: record => lines.records.push(record),
    });
    try {
      // The first transform promotes the carried unit; the second is the one
      // that would ask. The restored revision claim must stop it.
      await second.transform(sessionId, largeHostMessages());
      await second.transform(sessionId, largeHostMessages());
      assert.equal(calls.length, 1,
        'the restored revision claim stops the same revision being asked again');
      assert.equal(lines.of('ask').length, 0, 'the fresh process sent no second table');
      assert.equal(lines.of('ask-state-resumed').length, 0,
        'a claim-only record restores without verdict journal noise');
    } finally { await second.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-467: an ask-off mount durably drops the verdicts and claims it names',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    const calls: string[] = [];
    try {
      const first = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => {
          calls.push('first');
          return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
        },
        journal: () => {},
      });
      try {
        await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
        await first.transform(sessionId, largeHostMessages());
        assert.equal((await first.cremate(sessionId)).fired, true,
          'the command fires the table pass');
        const entry = first.sessions.get(sessionId);
        assert.ok(entry !== undefined, 'the first mount built the session');
        assert.equal(entry.askVerdicts.size, 1, 'the verdict is stored durably');
        assert.ok(entry.askedRevisions.size > 0, 'the revision claim is stored durably');
      } finally { await first.close(); }

      // Reopen with the ask off: the drop must be a durable write, not a filter.
      const offLines = journalLines();
      const off = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        journal: record => offLines.records.push(record),
      });
      try {
        await off.transform(sessionId, largeHostMessages());
        const dropped = offLines.of('ask-state-dropped');
        assert.equal(dropped.length, 1, 'the ask-off mount journals the drop');
        assert.equal(dropped[0]?.['count'], 1, 'the line names the dropped verdict');
        const offEntry = off.sessions.get(sessionId);
        assert.equal(offEntry?.askVerdicts.size, 0, 'no verdict is loaded ask-off');
        assert.equal(offEntry?.askedRevisions.size, 0, 'no claim is loaded ask-off');
      } finally { await off.close(); }

      // Reopen with the ask on: nothing was left to resurrect.
      const onLines = journalLines();
      const on = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => { calls.push('third'); return { text: '{}' }; },
        journal: record => onLines.records.push(record),
      });
      try {
        await on.transform(sessionId, largeHostMessages());
        await on.transform(sessionId, largeHostMessages());
        assert.equal(onLines.of('ask-state-resumed').length, 0,
          'the dropped record restores no verdict and no claim');
        assert.equal(onLines.of('ask-apply').length, 0, 'the dropped verdict is never applied');
        assert.equal(onLines.of('ask-state-dropped').length, 0,
          'nothing durable was left for the next mount to drop');
        assert.ok(calls.includes('third'),
          'the cleared revision claim no longer suppresses a new ask');
      } finally { await on.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-468: a durable revision claim is named, not no-eligible', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const calls: string[] = [];
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => { calls.push('first'); return { text: '{}' }; },
      journal: () => {},
    });
    try {
      await first.transform(sessionId, []);
      await first.transform(sessionId, largeHostMessages());
      await first.transform(sessionId, largeHostMessages());
      assert.equal(calls.length, 1, 'the first mount claimed the revision once');
    } finally { await first.close(); }

    // A restart's first crossing is refused by the restored revision claim.
    const lines = journalLines();
    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => { calls.push('second'); return { text: '{}' }; },
      journal: record => lines.records.push(record),
    });
    try {
      await second.transform(sessionId, largeHostMessages());
      await second.transform(sessionId, largeHostMessages());
      assert.equal(calls.length, 1, 'the restored claim suppresses the second ask');
      const named = lines.of('prune-outcome').at(-1);
      assert.ok(named !== undefined, 'the refused crossing is named');
      assert.equal(named['outcome'], 'claimed-revision',
        'the journal names the claim, not an empty crossing');
      assert.equal(named['origin'], 'step');
      assert.match(String(named['reason']), /durable revision claim/u);
    } finally { await second.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-472: an unknown mount-state version is named, not read as empty',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const sessionDir = join(root, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'mount-state.json'), `${JSON.stringify({
        version: 999,
        ask: {
          revisions: ['revision-claimed'], askedUnitIds: ['unit:sha256:claimed'],
          retriedUnitIds: [], refusedRetriedUnitIds: [], verdicts: [],
          deferredApply: false, deferredFailures: 0,
        },
      })}\n`, 'utf8');
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({ text: '{}' }),
        journal: record => lines.records.push(record),
      });
      try {
        await mount.transform(sessionId, largeHostMessages());
        const refused = lines.of('mount-state-error')
          .filter(line => /version/u.test(String(line['message'])));
        assert.ok(refused.length > 0, 'the unknown version is journalled by name');
        assert.ok(refused.some(line => line['fact'] === 'ask'),
          'the ask record refusal is named with its fact');
        assert.ok(refused.some(line => line['fact'] === 'receipts'),
          'the receipts record refusal is named with its fact');
        const entry = mount.sessions.get(sessionId);
        assert.equal(entry?.askedRevisions.size, 0,
          'the skew claim is not silently restored from a refused record');
        assert.equal(lines.of('ask-state-resumed').length, 0,
          'a refused record is not reported as resumed state');
      } finally { await mount.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-483: an ask-off drop never reports a clear that failed', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const stateFile = join(root, 'sessions', sessionId, 'mount-state.json');
  try {
    // Ask on: claim the unit and store one `forgetall` verdict durably.
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
      journal: () => {},
    });
    try {
      await first.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
      await first.transform(sessionId, largeHostMessages());
      assert.equal((await first.cremate(sessionId)).fired, true,
        'the command stores the verdict');
    } finally { await first.close(); }

    /**
     * A read-only state file makes `publishDoc`'s rename fail (EPERM), so the
     * clear cannot land while the read still restores the verdict.
     */
    chmodSync(stateFile, 0o444);
    const offLines = journalLines();
    const off = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      journal: record => offLines.records.push(record),
    });
    try {
      await off.transform(sessionId, largeHostMessages());
      const failed = offLines.of('mount-state-error').filter(line => line['fact'] === 'ask');
      assert.ok(failed.length > 0, 'the failed clear is named');
      assert.match(String(failed.at(-1)?.['message']), /mount-state\.json/u,
        'the failure names the file it could not write');
      assert.equal(offLines.of('ask-state-dropped').length, 0,
        'a failed clear is never reported as a drop');
    } finally { await off.close(); }

    // The record survived the failed clear: an ask-on reopen restores it.
    const onLines = journalLines();
    const on = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{}' }),
      journal: record => onLines.records.push(record),
    });
    try {
      await on.transform(sessionId, largeHostMessages());
      const resumed = onLines.of('ask-state-resumed');
      assert.equal(resumed.length, 1, 'the restored verdict is named on the ask-on reopen');
      assert.equal(resumed[0]?.['verdicts'], 1, 'the restored record still carries the verdict');
    } finally { await on.close(); }
  } finally {
    try { chmodSync(stateFile, 0o666); } catch { /* the file may never exist */ }
    cleanup(dir);
  }
});

test('ISSUE-483: a claims-only ask-off drop names the erased claim count', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  try {
    const sessionDir = join(root, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'mount-state.json'), `${JSON.stringify({
      version: 1,
      ask: {
        revisions: ['rev-a', 'rev-b'],
        askedUnitIds: [`unit:sha256:${'a'.repeat(64)}`],
        retriedUnitIds: [], refusedRetriedUnitIds: [], verdicts: [],
        deferredApply: false, deferredFailures: 0,
      },
    })}\n`, 'utf8');
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      journal: record => lines.records.push(record),
    });
    try {
      await mount.transform(sessionId, largeHostMessages());
      const dropped = lines.of('ask-state-dropped');
      assert.equal(dropped.length, 1, 'a claims-only record is dropped by name');
      assert.equal(dropped[0]?.['claims'], 1, 'the line names the erased claim count');
      assert.equal(dropped[0]?.['revisions'], 2, 'the line names the erased revisions');
      assert.equal(dropped[0]?.['count'], 0, 'no verdict was erased');
    } finally { await mount.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-484: a refused mount-state file is never overwritten by a write',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const sessionDir = join(root, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const stateFile = join(sessionDir, 'mount-state.json');
      const foreignReceipt = {
        intentId: 'intent-999', sessionId, baseRevision: 'rev-999',
        resultRevision: 'rev-998', applicationSha256: 'a'.repeat(64), appliedAtMs: 1,
      };
      writeFileSync(stateFile, `${JSON.stringify({
        version: 999, receipts: [foreignReceipt],
      })}\n`, 'utf8');
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
        journal: record => lines.records.push(record),
      });
      try {
        await mount.transform(sessionId, [userMessage('msg_install_u', [text('Session start.')])]);
        await mount.transform(sessionId, largeHostMessages());
        await mount.cremate(sessionId);
        const named = lines.of('mount-state-error')
          .filter(line => /mount-state\.json/u.test(String(line['message'])));
        assert.ok(named.length > 0, 'the refused write names the file');
        const after = JSON.parse(readFileSync(stateFile, 'utf8')) as {
          version?: number; receipts?: readonly unknown[];
        };
        assert.equal(after.version, 999, 'the foreign file keeps its unknown version');
        assert.equal(after.receipts?.length, 1, 'the foreign receipt is preserved');
      } finally { await mount.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-484: a version-absent document is read as v1 when its shape validates',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const sessionDir = join(root, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'mount-state.json'), `${JSON.stringify({
        ask: {
          revisions: ['legacy-rev'],
          askedUnitIds: [`unit:sha256:${'b'.repeat(64)}`],
          retriedUnitIds: [], refusedRetriedUnitIds: [], verdicts: [],
          deferredApply: false, deferredFailures: 0,
        },
      })}\n`, 'utf8');
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        contextWindowTokens: 400_000, pruneThresholdTokens: 100,
        askGrammar: 'prune-two-option',
        askGenerate: async () => ({ text: '{}' }),
        journal: record => lines.records.push(record),
      });
      try {
        await mount.transform(sessionId, largeHostMessages());
        const entry = mount.sessions.get(sessionId);
        assert.equal(entry?.askedRevisions.has('legacy-rev'), true,
          'the legacy claim is restored from the untagged document');
        assert.equal(lines.of('mount-state-error')
          .filter(line => /version/u.test(String(line['message']))).length, 0,
        'a valid legacy shape is not refused as an unknown version');
      } finally { await mount.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-485: a refused receipts read never abandons prepared intents', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  try {
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root }, journal: () => {},
    });
    try {
      await first.transform(sessionId, staleReadMessages());
      const entry = first.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the first mount built the session');
      await entry.ledger.prepare({
        sessionId, eventId: 'evt-485', baseRevision: 'rev-485', phase: 'entry',
        applicationSha256: sha256Sync(toBytes('orphan prepared row')),
        archives: [], appendRecords: [], sealedEpisodeIds: [],
      });
    } finally { await first.close(); }

    const stateFile = join(root, 'sessions', sessionId, 'mount-state.json');
    writeFileSync(stateFile, `${JSON.stringify({ version: 999, receipts: [] })}\n`, 'utf8');
    const lines = journalLines();
    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      journal: record => lines.records.push(record),
    });
    try {
      await second.transform(sessionId, staleReadMessages());
      assert.ok(lines.of('mount-state-error').some(line => line['fact'] === 'receipts'),
        'the refused receipts read is named');
      assert.equal(lines.of('intent-abandoned').length, 0,
        'a refused read never closes a prepared intent');
      const entry = second.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the second mount built the session');
      let abandoned = 0;
      for await (const { event } of entry.ledger.events(sessionId)) {
        if (event.kind === 'abandoned') abandoned += 1;
      }
      assert.equal(abandoned, 0, 'no abandoned row is appended');
    } finally { await second.close(); }

    // A readable empty document: the same orphan is closed exactly once.
    writeFileSync(stateFile, `${JSON.stringify({ version: 1 })}\n`, 'utf8');
    const healthy = journalLines();
    const third = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      journal: record => healthy.records.push(record),
    });
    try {
      await third.transform(sessionId, staleReadMessages());
      assert.equal(healthy.of('intent-abandoned').length, 1,
        'a readable empty record closes the orphan once');
    } finally { await third.close(); }
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-485: a non-array receipts record is a named structural refusal',
  async () => {
    const dir = scratch();
    const root = join(dir, 'root');
    try {
      const sessionDir = join(root, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'mount-state.json'),
        `${JSON.stringify({ version: 1, receipts: {} })}\n`, 'utf8');
      const lines = journalLines();
      const mount = createOpencodeMount({
        storage: { crematorStorageRoot: root },
        journal: record => lines.records.push(record),
      });
      try {
        await mount.transform(sessionId, staleReadMessages());
        const line = lines.of('mount-state-error')
          .find(candidate => candidate['fact'] === 'receipts');
        assert.ok(line !== undefined, 'the malformed receipts record is named');
        assert.match(String(line['message']), /receipts/u,
          'the message names the receipts record');
        assert.equal(lines.of('intent-abandoned').length, 0,
          'a structural refusal never judges abandonment');
      } finally { await mount.close(); }
    } finally {
      cleanup(dir);
    }
  });

test('ISSUE-495: an applied receipt is collected, so one stored removal never grows the file',
  async () => {
    /*
     * ISSUE-436 added this collection to the dsh adapter only. Here every
     * committed apply wrote a crash-window receipt (ISSUE-448) and nothing ever
     * dropped it once the ledger's own `applied` row superseded it. Under
     * `rewriteHistory: false` the host rebuilds each request from its own store,
     * so one banked removal re-applies per request: a new intent, a new receipt,
     * a full-file rewrite, and a file that never shrinks.
     */
    const dir = scratch();
    const root = join(dir, 'root');
    const stateFile = join(root, 'sessions', sessionId, 'mount-state.json');
    const receiptsOf = (): readonly unknown[] => {
      try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { receipts?: unknown };
        return Array.isArray(parsed.receipts) ? parsed.receipts : [];
      } catch { return []; }
    };
    const mount = createOpencodeMount({
      storage: { crematorStorageRoot: root }, journal: () => {},
    });
    try {
      const store = staleReadMessages();
      const counts: number[] = [];
      let appliedRows = 0;
      for (let request = 1; request <= 4; request += 1) {
        // The host's own rebuild of the same stored history: same base revision,
        // so the banked removal is re-applied on every request.
        const messages = structuredClone(store);
        await mount.transform(sessionId, messages);
        assert.equal(messages.some(message => message.id === 'msg_t1'), false,
          `request ${String(request)} landed the stale-read removal`);
        counts.push(receiptsOf().length);
      }
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the mount built the session');
      for await (const { event } of entry.ledger.events(sessionId)) {
        if (event.kind === 'applied') appliedRows += 1;
      }
      assert.equal(appliedRows, counts.length,
        'every request recorded its own applied row: the receipt each supersedes');
      assert.deepEqual(counts, [0, 0, 0, 0],
        'a receipt whose applied row is durable is collected; the file does not grow per request');
    } finally {
      await mount.close();
      cleanup(dir);
    }
  });

test('ISSUE-486: a restored durable unit claim is named, not no-eligible', async () => {
  const dir = scratch();
  const root = join(dir, 'root');
  const calls: string[] = [];
  try {
    // A timeout keeps the unit permanently claimed and writes that claim durably.
    const first = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option', askTimeoutMs: 20,
      askGenerate: () => {
        calls.push('first');
        return new Promise<{ text: string }>(() => {});
      },
      journal: () => {},
    });
    try {
      await first.transform(sessionId, []);
      await first.transform(sessionId, largeHostMessages());
      await first.transform(sessionId, largeHostMessages());
      const entry = first.sessions.get(sessionId);
      assert.equal(calls.length, 1, 'the crossing asked once');
      assert.ok((entry?.askedUnitIds.size ?? 0) > 0, 'the timeout keeps the unit claim');
    } finally { await first.close(); }

    const lines = journalLines();
    const second = createOpencodeMount({
      storage: { crematorStorageRoot: root },
      contextWindowTokens: 400_000, pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askGenerate: async () => { calls.push('second'); return { text: '{}' }; },
      journal: record => lines.records.push(record),
    });
    try {
      // The first restart transform promotes the carried unit into the seen set.
      await second.transform(sessionId, largeHostMessages());
      const before = lines.records.length;
      // One extra tool result changes the revision; the unit claim survives it.
      await second.transform(sessionId, [...largeHostMessages(),
        assistantMessage('msg_486_a', [
          text('Reading SMALL2.md.'),
          toolCall('call_486', 'read', { filePath: 'SMALL2.md' }),
        ]),
        toolMessage('msg_486_t', [toolResult('call_486', 'read', textResult('tiny'))]),
        assistantMessage('msg_486_end', [text('Done.')])]);
      assert.equal(calls.length, 1, 'the restored unit claim suppresses the ask');
      const named = lines.of('prune-outcome').at(-1);
      assert.equal(named?.['outcome'], 'claimed-unit',
        'the step lane names the unit claim, not an empty crossing');
      assert.equal(named?.['origin'], 'step');
      assert.equal(named?.['claims'], 1, 'the line names the claimed row');
      assert.ok(lines.records.slice(before)
        .every(record => !/none was suppressed/u.test(String(record['reason'] ?? ''))),
      'the crossing writes no empty-crossing reason');
      // The command lane names the same suppression.
      assert.equal((await second.cremate(sessionId)).fired, false, 'the command fires nothing');
      assert.equal(lines.of('cremate').at(-1)?.['reason'], 'claimed-unit',
        'the command reason is the unit claim, not no-rows');
    } finally { await second.close(); }
  } finally {
    cleanup(dir);
  }
});

test('the tool surface and the test harness exclusions', async () => {
  await runRows(REGISTRATION_ROWS);
});

test('the journal can be a file the host config names', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'journal.jsonl');
    assert.equal(mountOptionsFromHost({ crematorJournalFile: path }).journalFile, path,
      'a config value reaches the mount option');
    assert.equal(mountOptionsFromHost({ crematorJournalFile: '' }).journalFile, undefined,
      'an empty value is not a path');
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' }, journalFile: path,
    });
    try {
      await mount.transform(sessionId, hostMessages());
    } finally {
      await mount.close();
    }
    const records = readFileSync(path, 'utf8').split(/\r?\n/u)
      .filter(line => line.length > 0).map(line => JSON.parse(line));
    const kinds = records.map(record => record.kind);
    for (const kind of ['mounted', 'at-rest', 'commit']) {
      assert.ok(kinds.includes(kind), `the file journal holds a ${kind} record`);
    }
    assert.equal(records.find(record => record.kind === 'mounted')?.journalFile, path,
      'the mounted line names the file it writes');
  } finally {
    cleanup(dir);
  }
});

test('ISSUE-356: cleanup drains an in-flight ask before closing the ledgers', async () => {
  const lines = journalLines();
  const host = fakeHost();
  let asked = 0;
  let releaseAsk = (): void => {};
  const askGate = new Promise<void>(resolve => { releaseAsk = resolve; });
  const plugin = createOpencodePlugin({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      asked += 1;
      await askGate;
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
    journal: record => lines.records.push(record),
  });
  const cleanupFn = await plugin.setup(host.context);
  try {
    // Step 1 carries the result; step 2 tables it and suspends inside the ask.
    await host.contextHook?.(sessionContext(largeHostMessages()));
    const inFlight = host.contextHook?.(sessionContext(largeHostMessages()));
    for (let i = 0; i < 100 && asked === 0; i += 1) await tick();
    assert.equal(asked, 1, 'the second step suspended inside a live ask');

    const cleaning = cleanupFn();
    // The old cleanup raced only the event loop (250 ms) and closed the
    // ledgers while this ask was still suspended. Give it that window.
    await new Promise(resolve => { setTimeout(resolve, 300); });
    releaseAsk();
    await inFlight;
    await cleaning;
    assert.deepEqual(lines.of('ask-error'), [],
      'the ask resolved into open ledgers: no post-dispose closed-ledger write');
    assert.equal(lines.of('ask-apply').length, 1,
      'the in-flight ask landed its removal before the ledgers closed');
  } finally {
    releaseAsk();
    await cleanupFn();
  }
});

test('ISSUE-360: a derivation throw names its cause in the refusal and the journal', async () => {
  const lines = journalLines();
  let arm = false;
  let forced: ApplyResult | null = null;
  const createPort = (options: OpencodePortOptions): OpencodeMountPort => {
    const inner = createOpencodePort({
      ...options,
      capabilities: { ...createOpencodeCapabilities(), revertHistory: true },
      deriveRevert: () => { throw new Error('the deriver broke on a split pair'); },
    });
    return {
      snapshot: async () => {
        if (arm) {
          arm = false;
          forced = await inner.apply(stagedRequest((await inner.snapshot()).revision));
        }
        return inner.snapshot();
      },
      apply: request => inner.apply(request),
      lookupReceipt: id => inner.lookupReceipt(id),
      refusal: () => inner.refusal(),
      observe: (observed, observeOptions) => inner.observe(observed, observeOptions),
      commit: () => inner.commit(),
      lastCommitKind: () => inner.lastCommitKind(),
    };
  };
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' }, createPort,
    journal: record => lines.records.push(record),
  });
  try {
    arm = true;
    await mount.transform(sessionId, hostMessages());
    assert.deepEqual(forced, { status: 'not-applied', reason: 'host-error' },
      'the thrown derivation is a definite refusal');
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session exists');
    const refusal = entry.port.refusal?.();
    assert.equal(refusal?.code, 'derivation-error', 'the refusal names the derivation error');
    assert.match(String(refusal?.detail), /the deriver broke on a split pair/u,
      'the refusal detail carries the thrown message');
    const stepLine = lines.of('at-rest').filter(line => line['reason'] === 'step').at(-1);
    const journalled = stepLine?.['refusal'] as Record<string, unknown> | undefined;
    assert.equal(journalled?.['code'], 'derivation-error',
      'the journal names the derivation error');
    assert.match(String(journalled?.['detail']), /the deriver broke on a split pair/u,
      'the journal line carries the thrown cause');
  } finally { await mount.close(); }
});
