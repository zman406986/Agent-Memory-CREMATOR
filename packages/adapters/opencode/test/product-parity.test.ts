// Product-parity rows for the opencode adapter (ISSUE-300): the L1/dedupe pass
// that applies with the ask, the ask deadline, the planning window, and the
// survivor-cancellation release. Each row names the behavior it proves; no
// host, no API key, no live call.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApplyRequest, PrunePassPlan, WireAnswer } from '@cremator/core';
import { buildOpencodeAskBatch, buildOpencodePassPlan } from '../src/ask.js';
import {
  applyOpencodeAskVerdicts, createOpencodeMount, releaseCancelledUnits,
} from '../src/plugin.js';
import type { OpencodeJournalKind, OpencodeMountPort, OpencodeSessionEntry } from '../src/plugin.js';
import type { OpencodePortOptions } from '../src/port.js';
import { createOpencodePort } from '../src/port.js';
import { deriveOpencodeSnapshot, opencodeToolNodeId } from '../src/snapshot.js';
import type { OpencodeGenerateInput, OpencodeHostEvent, OpencodeMessage } from '../src/host.js';
import {
  assistantMessage, errorResult, sessionId, text, toolCall, toolMessage, toolResult, textResult,
  userMessage,
} from './fixtures.js';

function largeReadConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# Note\n\n${'body-'.repeat(180)}\n`))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

function duplicateBashConversation(): OpencodeMessage[] {
  const body = `-rw-r--r-- 1 ${'listing-'.repeat(120)}\n`;
  return [
    userMessage('msg_u1', [text('List twice.')]),
    assistantMessage('msg_a1', [toolCall('call_a', 'bash', { command: 'ls -l' })]),
    toolMessage('msg_ta', [toolResult('call_a', 'bash', textResult(body))]),
    assistantMessage('msg_a2', [toolCall('call_b', 'bash', { command: 'ls -l' })]),
    toolMessage('msg_tb', [toolResult('call_b', 'bash', textResult(body))]),
    assistantMessage('msg_a3', [text('Same listing.')]),
  ];
}

function journalLines() {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    of(kind: OpencodeJournalKind): Record<string, unknown>[] {
      return records.filter(record => record['kind'] === kind);
    },
  };
}

/**
 * One `session.step.ended` row that states the prompt count the host billed,
 * with a cold cache. It is the host reading the depth latch observes at the
 * next context hook (the seam `plugin.test.ts` uses).
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

/** Two reads of one path holding the same bytes: the stale-exact-reread shape. */
function identicalRereadConversation(): OpencodeMessage[] {
  const body = `# Notes\n\nSTALE_REREAD_SENTINEL_4a1\n${'same-'.repeat(200)}\n`;
  return [
    userMessage('msg_u1', [text('Read it twice.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
    assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(body))]),
    assistantMessage('msg_a3', [text('The same note.')]),
  ];
}

/**
 * Two reads of one path holding DIFFERENT bytes, the later one a whole-file
 * read. L1's stale-exact-reread needs equal bytes, so this shape belongs to the
 * dedupe's superseded-by-reread class alone.
 */
function changedRereadConversation(): OpencodeMessage[] {
  const older = `# Notes\n\nSUPERSEDED_OLD_SENTINEL_9c2\n${'old-'.repeat(180)}\n`;
  const newer = `# Notes\n\nSUPERSEDED_NEW_SENTINEL_9c2\n${'new-'.repeat(180)}\n`;
  return [
    userMessage('msg_u1', [text('Read it twice.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(older))]),
    assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(newer))]),
    assistantMessage('msg_a3', [text('Read again.')]),
  ];
}

/**
 * One read whose target the episode tracker can close as an all-miss episode.
 * The miss is the host's own structured error tag, not a text body: a
 * successful file whose content happens to contain ENOENT is still a hit.
 */
function missingReadConversation(): OpencodeMessage[] {
  const body = `ENOENT: GONE.md\n\nMISSING_SENTINEL_2b7\n${'no-such-file-'.repeat(70)}\n`;
  return [
    userMessage('msg_u1', [text('Read the missing note.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'GONE.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', errorResult(body))]),
    assistantMessage('msg_a2', [text('It is missing.')]),
  ];
}

/**
 * Two independent large reads of different paths and bytes: no L1 or dedupe
 * lane fires, so one unit can leave the array while the other keeps the plan
 * non-null. That is the shape a unit restore is proved against.
 */
function twoReadConversation(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'ONE.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# One\n\n${'one-'.repeat(200)}\n`))]),
    assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'TWO.md' })]),
    toolMessage('msg_t2', [toolResult('call_2', 'read',
      textResult(`# Two\n\n${'two-'.repeat(200)}\n`))]),
    assistantMessage('msg_a3', [text('Both read.')]),
  ];
}

/** A session entry without running the at-rest pass over the fixture array. */
async function openSession(
  mount: ReturnType<typeof createOpencodeMount>,
): Promise<OpencodeSessionEntry> {
  await mount.transform(sessionId, [userMessage('msg_u0', [text('Start.')])]);
  const entry = mount.sessions.get(sessionId);
  assert.ok(entry !== undefined, 'the first transform opened the session');
  return entry;
}

function journalSink(lines: ReturnType<typeof journalLines>) {
  return (kind: OpencodeJournalKind, fields: Record<string, unknown>): void => {
    lines.records.push({ kind, atMs: 1, ...fields });
  };
}

/** Apply one pass plan through the adapter's own prune apply path. */
async function applyPlan(
  entry: OpencodeSessionEntry, messages: OpencodeMessage[],
  plan: PrunePassPlan, lines: ReturnType<typeof journalLines>,
): Promise<boolean> {
  return applyOpencodeAskVerdicts({
    entry, messages, snapshot: entry.port.observe(messages), plan,
    answers: new Map(), window: 400_000, journal: journalSink(lines),
  });
}

/** The ledger's applied intent ids for this session. */
async function appliedIntents(entry: OpencodeSessionEntry): Promise<string[]> {
  const intents: string[] = [];
  for await (const { event } of entry.ledger.events(sessionId)) {
    if (event.kind === 'applied') intents.push(event.receipt.intentId);
  }
  return intents;
}

/** The one receipt line the fixture's removal lands. */
function receiptText(messages: readonly OpencodeMessage[]): string {
  const receipt = messages.find(message =>
    typeof message['racoonsRecordId'] === 'string');
  assert.ok(receipt !== undefined, 'the removal landed a receipt');
  return receipt.content.filter(part => part.type === 'text')
    .map(part => String(part['text'])).join('');
}

/** The recall answer as text, so a caller can search for the removed sentinel. */
async function recalledText(
  mount: ReturnType<typeof createOpencodeMount>, recallId: unknown,
): Promise<string> {
  return JSON.stringify(await mount.tool.execute({ id: recallId }, { sessionID: sessionId }));
}

test('L1 removals and the ask apply in one prune document', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = duplicateBashConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const applies = lines.of('ask-apply');
    assert.equal(applies.length, 1, 'the duplicate family produced one removal');
    assert.equal(applies[0]?.['origin'], 'l1', 'the line names the L1 lane');
    assert.equal(applies[0]?.['rule'], 'byte-identical-duplicates',
      'the line names the L1 family');
    assert.equal(applies[0]?.['applied'], true, 'the removal landed a receipt');
    assert.equal(messages.some(message => message.id === 'msg_ta'), true,
      'the earliest copy is the survivor');
    assert.equal(messages.some(message => message.id === 'msg_tb'), false,
      'the later duplicate leaves');
    const plans = lines.of('prune-plan');
    assert.ok(plans.length >= 1, 'the pass plan is journalled');
    assert.equal(plans.some(plan => plan['l1Removals'] === 1), true,
      'the first plan names the L1 removal; the later rebuild has none left');
  } finally { await mount.close(); }
});

test('the per-revision lane journals an estimate, never a host window', async () => {
  /*
   * ISSUE-300 item 14: with no configured `contextWindowTokens`, the planning
   * value the apply carries is a content estimate. It must not be presented as
   * the host's window: the journal names it `contentEstimate`, and `window`
   * appears only when the mount was configured with a host window.
   */
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = largeReadConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const apply = lines.of('ask-apply').at(-1);
    assert.ok(apply !== undefined, 'the ask pass applied a removal');
    assert.equal('window' in apply, false,
      'the per-revision apply claims no host window');
    assert.ok(Number.isSafeInteger(apply['contentEstimate']),
      'the apply journals the estimate under contentEstimate');
    const plan = lines.of('prune-plan').at(-1);
    assert.ok(plan !== undefined, 'the plan is journalled');
    assert.equal('window' in plan, false, 'the per-revision plan claims no host window');
    assert.ok(Number.isSafeInteger(plan['contentEstimate']),
      'the plan journals the estimate under contentEstimate');
  } finally { await mount.close(); }
});

test('a stale idle fact clamps to a truncated rebuild and the pass is accepted',
  async () => {
    /*
     * ISSUE-300 G6: after an idle at turn 1 the host rebuilds a one-turn array.
     * The snapshot used to carry completed=1, current=0; core refused the
     * at-rest pass `invalid-plan` (transcript ordinal), and every later at-rest
     * and prune plan was rejected for the rest of the session. The clamp keeps
     * completed <= current and the prune plan applies.
     */
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const oneTurn = largeReadConversation();
      const longer: OpencodeMessage[] = [
        ...oneTurn,
        userMessage('msg_u2', [text('Another turn.')]),
        assistantMessage('msg_a3', [text('Done.')]),
      ];
      await mount.transform(sessionId, longer);
      await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session exists');
      assert.equal(entry.completedThroughTurnOrdinal, 1, 'the idle recorded turn 1');
      const rebuilt = largeReadConversation();
      // The stale fact is exactly what the transform would pass without the fix.
      const snapshot = entry.port.observe(rebuilt, { completedThroughTurnOrdinal: 1 });
      assert.equal(snapshot.currentTurnOrdinal, 0, 'the rebuilt array carries one turn');
      assert.equal(snapshot.completedThroughTurnOrdinal, 0,
        'the supplied fact is clamped to the current turn');
      const before = lines.records.length;
      await mount.transform(sessionId, rebuilt);
      const atRest = lines.of('at-rest').at(-1);
      assert.ok(atRest !== undefined, 'the at-rest pass ran');
      assert.deepEqual(atRest['issues'], [],
        'the at-rest pass is accepted, not invalid-plan');
      const invalidPlans = lines.records.slice(before)
        .flatMap(record => Array.isArray(record['issues'])
          ? record['issues'] as { code?: unknown }[] : [])
        .filter(issue => issue.code === 'invalid-plan');
      assert.deepEqual(invalidPlans, [], 'no invalid-plan is journalled');
      const apply = lines.of('ask-apply').at(-1);
      assert.ok(apply !== undefined, 'the prune plan applied its removal');
      assert.equal(apply['applied'], true, 'the prune plan is accepted');
      assert.equal('issues' in apply, false, 'the prune plan carries no guard issue');
    } finally { await mount.close(); }
  });

test('a completed compaction drops the stored idle fact', async () => {
  /*
   * ISSUE-300 G6: a compaction rewrites the surface, so the last idle's turn
   * fact may point past the rebuilt array's current ordinal. The ended event
   * resets the stored fact; the next shorter rebuild falls back to
   * `currentTurn - 1` and its at-rest pass is accepted.
   *
   * ISSUE-362 (ISSUE-300 minor #1): the mount resetting its own fact is not
   * enough — the port's `observe` merge retains the last fact a transform
   * supplied. A transform after the idle pushes the fact into the port; the
   * ended event must drop the port's copy too, or the no-options observation
   * below clamps the stale fact up to the in-progress turn (0) instead of -1.
   */
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const oneTurn = largeReadConversation();
    const longer: OpencodeMessage[] = [
      ...oneTurn,
      userMessage('msg_u2', [text('Another turn.')]),
      assistantMessage('msg_a3', [text('Done.')]),
    ];
    await mount.transform(sessionId, longer);
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the session exists');
    assert.equal(entry.completedThroughTurnOrdinal, 1, 'the idle recorded turn 1');
    // A later transform hands the idle fact to the port, whose `observe` merge
    // retains it. This is the stale copy the ended event must also drop; without
    // it the port never holds the fact and the -1 fallback below is vacuous.
    await mount.transform(sessionId, longer);
    assert.equal(entry.port.observe(longer).completedThroughTurnOrdinal, 1,
      'the port retains the idle fact the transform supplied');
    await mount.event({ type: 'session.compaction.ended', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, null,
      'the compaction drops the turn fact that may point past the new surface');
    const rebuilt = largeReadConversation();
    const snapshot = entry.port.observe(rebuilt);
    assert.equal(snapshot.currentTurnOrdinal, 0, 'the rebuilt array carries one turn');
    assert.equal(snapshot.completedThroughTurnOrdinal, -1,
      'without a fact the projection falls back to currentTurn - 1');
    const before = lines.records.length;
    await mount.transform(sessionId, rebuilt);
    const atRest = lines.of('at-rest').at(-1);
    assert.ok(atRest !== undefined, 'the at-rest pass ran');
    assert.deepEqual(atRest['issues'], [],
      'the at-rest pass is accepted after the compaction reset');
    const invalidPlans = lines.records.slice(before)
      .flatMap(record => Array.isArray(record['issues'])
        ? record['issues'] as { code?: unknown }[] : [])
      .filter(issue => issue.code === 'invalid-plan');
    assert.deepEqual(invalidPlans, [], 'no stale ordinal reaches the guard');
  } finally { await mount.close(); }
});

test('the prune planning window is the configured host window, not a content estimate',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 1,
      askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' }),
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const messages = largeReadConversation();
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const apply = lines.of('ask-apply').at(-1);
      assert.ok(apply !== undefined, 'the pass applied');
      assert.equal(apply['window'], 400_000, 'the event carries the host window');
      const threshold = lines.of('prune-threshold').at(-1);
      assert.equal(threshold?.['window'], 400_000, 'the reading names the same window');
      assert.equal(threshold?.['threshold'], 1, 'the reading names the bar');
    } finally { await mount.close(); }
  });

test('a hung ask is a terminal timeout, never a fire, and the lane does not wait',
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      askTimeoutMs: 20,
      askGenerate: async (input) => {
        calls.push(input);
        return new Promise(() => {});
      },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const messages = largeReadConversation();
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, 'the ask was attempted once');
      const errors = lines.of('ask-error');
      assert.equal(errors.length, 1, 'the timeout is one ask-error line');
      assert.equal(errors[0]?.['stage'], 'timeout', 'the line names the deadline');
      assert.equal(errors[0]?.['timeoutMs'], 20, 'the line names the deadline value');
      assert.equal(errors[0]?.['retry'], 'none', 'the timeout grants no retry');
      assert.equal(errors[0]?.['terminal'], true, 'the line declares the units terminal');
      assert.deepEqual(lines.of('ask'), [], 'a timeout is never a fire');
      const entry = mount.sessions.get(sessionId);
      assert.equal(entry?.askFires, 0, 'the fire count did not advance');
      assert.equal(entry?.askedUnitIds.size, 1, 'the timed-out unit stays claimed');
      assert.equal(entry?.retriedUnitIds.size, 0, 'no unit is released for a retry');
    } finally { await mount.close(); }
  });

test('a timed-out unit is never generated again, and the lane still asks other units',
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 60_000,
      askGrammar: 'prune-two-option',
      askTimeoutMs: 20,
      askGenerate: async (input) => {
        calls.push(input);
        // The first call never settles: the host request is still running when
        // the deadline fires. Only the later unit's ask gets a readable reply.
        if (calls.length === 1) return new Promise(() => {});
        return { text: '{"1":{"keepall":true}}' };
      },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const messages = largeReadConversation();
      // The carrying request ships the unit; the reading at the bar asks it.
      await mount.transform(sessionId, messages);
      await mount.event(stepUsage('msg_terminal_1', 60_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, 'the crossing asked once');
      const timeout = lines.of('ask-error').at(-1);
      assert.equal(timeout?.['stage'], 'timeout', 'the timeout is journalled');
      assert.equal(timeout?.['retry'], 'none', 'the timeout grants no retry');
      assert.equal(timeout?.['terminal'], true, 'the timeout is terminal for its units');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session entry exists');
      assert.equal(entry.askedUnitIds.size, 1, 'the timed-out unit stays claimed');
      const timedOutUnit = [...entry.askedUnitIds][0];
      assert.ok(timedOutUnit !== undefined, 'the claimed unit is known');
      assert.equal(entry.retriedUnitIds.size, 0, 'nothing was released for a retry');
      /**
       * A later revision adds a second large read. Its first reading after the
       * timeout pass is the new baseline (the pass completed at the timeout),
       * so the reading is observed but does not cross.
       */
      messages.push(
        assistantMessage('msg_a9', [
          text('Read the other note.'),
          toolCall('call_9', 'read', { filePath: 'OTHER.md' }),
        ]),
        toolMessage('msg_t9', [toolResult('call_9', 'read',
          textResult(`# Other\n\n${'other-'.repeat(180)}\n`))]),
      );
      await mount.event(stepUsage('msg_terminal_2', 120_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 1, 'the revision alone re-generates nothing');
      const baseline = lines.of('prune-threshold').at(-1);
      assert.equal(baseline?.['estimatedTokens'], 120_000, 'the post-timeout reading is observed');
      assert.equal(baseline?.['crossed'], false, 'the first reading after the pass is the baseline');
      /**
       * One bar above that baseline crosses. The timed-out unit is still in the
       * array and still claimed, so the table holds only the new unit: the lane
       * keeps evaluating depth and can ask a unit it has not asked.
       */
      await mount.event(stepUsage('msg_terminal_3', 180_000));
      await mount.transform(sessionId, messages);
      assert.equal(calls.length, 2, 'the later crossing asked the new unit');
      assert.equal(entry.askedUnitIds.has(timedOutUnit), true,
        'the timed-out unit stays claimed at the later crossing');
      assert.equal(String(calls[1]?.prompt).includes('OTHER.md'), true,
        'the later table names the new unit');
      assert.equal(String(calls[1]?.prompt).includes('NOTES.md'), false,
        'the later table never names the timed-out unit');
      const fire = lines.of('prune-threshold').at(-1);
      assert.equal(fire?.['crossed'], true, 'the lane kept evaluating depth');
      assert.equal(entry.askFires, 1, 'the new unit is the only fire');
      assert.equal(lines.of('ask').length, 1, 'the readable later ask is the only ask');
    } finally { await mount.close(); }
  });

test('the ask journal carries the host generate usage and its cache split', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({
      text: '{"1":{"keepall":true}}',
      usage: { input: 1_000, output: 40, reasoning: 5, cache: { read: 700, write: 30 } },
    }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = largeReadConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const ask = lines.of('ask').at(-1);
    assert.ok(ask !== undefined, 'the ask fired and wrote its line');
    assert.equal(ask['requestKind'], 'ask', 'the ask line declares its request kind');
    assert.equal(ask['usageSource'], 'host-generate',
      'the host reading is named as the source');
    assert.deepEqual(ask['usage'], {
      inputTokens: 1_730, outputTokens: 40, cachedInputTokens: 730, reasoningTokens: 5,
    }, 'the usage is the tokenUsageOf mapping, cache included');
    assert.equal(ask['cacheReadTokens'], 700, 'the cache read bucket is carried');
    assert.equal(ask['cacheWriteTokens'], 30, 'the cache write bucket is carried');
  } finally { await mount.close(); }
});

test('the ask reads the declared generate answer: tokens and cost, named as the host source',
  async () => {
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      askGrammar: 'prune-two-option',
      /** 2.4.0's `session.generate` answer shape: `{text, tokens, cost}`. */
      askGenerate: async () => {
        const answer = {
          text: '{"1":{"keepall":true}}',
          tokens: { input: 1_000, output: 40, reasoning: 5, cache: { read: 700, write: 30 } },
          cost: 0.0125,
        };
        return answer;
      },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const messages = largeReadConversation();
      await mount.transform(sessionId, messages);
      await mount.transform(sessionId, messages);
      const ask = lines.of('ask').at(-1);
      assert.ok(ask !== undefined, 'the ask fired and wrote its line');
      assert.equal(ask['usageSource'], 'host-generate',
        'the declared host answer is named as the source');
      assert.deepEqual(ask['usage'], {
        inputTokens: 1_730, outputTokens: 40, cachedInputTokens: 730, reasoningTokens: 5,
      }, 'all four declared token counts are recorded through the tokenUsageOf mapping');
      assert.equal(ask['cacheReadTokens'], 700, 'the cache read bucket is carried');
      assert.equal(ask['cacheWriteTokens'], 30, 'the cache write bucket is carried');
      assert.equal(ask['costUsd'], 0.0125, 'the declared cost is recorded as telemetry');
    } finally { await mount.close(); }
  });

test('the declared generate answer wins over the open usage field', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      const answer = {
        text: '{"1":{"keepall":true}}',
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        usage: { input: 999, output: 999, reasoning: 9, cache: { read: 9, write: 9 } },
        cost: 0.5,
      };
      return answer;
    },
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = largeReadConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const ask = lines.of('ask').at(-1);
    assert.ok(ask !== undefined, 'the ask fired');
    assert.deepEqual(ask['usage'], {
      inputTokens: 17, outputTokens: 2, cachedInputTokens: 7, reasoningTokens: 1,
    }, 'the declared tokens are the reading; the open field does not override them');
    assert.equal(ask['costUsd'], 0.5, 'the declared cost is carried');
  } finally { await mount.close(); }
});

test('the ask answer\'s reading never consumes a main request estimate', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      const answer = {
        text: '{"1":{"keepall":true}}',
        tokens: { input: 900, output: 30, reasoning: 2, cache: { read: 100, write: 0 } },
        cost: 0.005,
      };
      return answer;
    },
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = largeReadConversation();
    await mount.transform(sessionId, messages);
    const estimate = mount.sessions.get(sessionId)?.pendingEstimates.at(-1);
    assert.ok(estimate !== null && estimate !== undefined, 'the mount made a main estimate');
    await mount.transform(sessionId, messages);
    assert.equal(lines.of('ask').length, 1, 'the ask fired from the second request');
    /**
     * The ask's answer is not a step row: it never shifts the main queue. The
     * next main row must pair with the estimate the mount made BEFORE the ask.
     */
    await mount.event(stepUsage('msg_main', 1_234));
    const reconciled = lines.of('usage-reconciled');
    assert.equal(reconciled.length, 1, 'the main row is the only reconciled row');
    assert.equal(reconciled[0]?.['requestId'], 'msg_main', 'the main row is reconciled');
    assert.equal(reconciled[0]?.['estimatedInputTokens'], estimate.inputTokens,
      'the main row pairs with its own estimate');
    const askMissing = lines.of('usage-missing')
      .filter(line => line['reason'] === 'ask-request');
    assert.equal(askMissing.length, 0, 'the ask answer was never treated as a step row');
  } finally { await mount.close(); }
});

test('an ask without a host reading says unmeasured, never a zero', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{"1":{"keepall":true}}' }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = largeReadConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    const ask = lines.of('ask').at(-1);
    assert.ok(ask !== undefined, 'the ask fired');
    assert.equal(ask['usage'], null, 'no host reading is recorded as null, not zero');
    assert.equal(ask['usageSource'], 'unmeasured-host', 'the absence is named');
    assert.equal(ask['costUsd'], null, 'no host cost is recorded as null, not zero');
    assert.equal(ask['cacheReadTokens'], null, 'the cache read is unknown, not cold');
    assert.equal(ask['cacheWriteTokens'], null, 'the cache write is unknown, not cold');
  } finally { await mount.close(); }
});

test('a restart on the shared ledger re-applies the removal and never re-asks it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cremator-oc-restart-'));
  const sentinel = 'RESTART_SENTINEL_7a2c';
  const original = [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'),
      toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read',
      textResult(`# Note\n\n${sentinel}\n${'body-'.repeat(240)}\n`))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ] as OpencodeMessage[];
  const ledger = { crematorStorageRoot: join(dir, 'storage') };
  let firstAsks = 0;
  let recallId: string | null = null;
  const first = createOpencodeMount({
    storage: ledger,
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      firstAsks += 1;
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    },
  });
  try {
    /**
     * ISSUE-419: a fresh install's first transform is the install boundary, so
     * model a live session — the session starts with the user prompt alone, the
     * tool result arrives on the next request, and it is table-eligible one
     * request after that.
     */
    await first.transform(sessionId, [structuredClone(original[0])] as OpencodeMessage[]);
    await first.transform(sessionId, structuredClone(original) as OpencodeMessage[]);
    const messages = structuredClone(original) as OpencodeMessage[];
    await first.transform(sessionId, messages);
    assert.equal(firstAsks, 1, 'the first process asked once');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the first process removed the unit');
    const receipt = messages.find(message =>
      typeof message['racoonsRecordId'] === 'string');
    assert.ok(receipt !== undefined, 'the removal landed a receipt');
    const rendered = receipt.content.filter(part => part.type === 'text')
      .map(part => String(part['text'])).join('');
    recallId = /· necromancy (\S+)$/u.exec(rendered)?.[1] ?? null;
    assert.ok(recallId !== null, 'the receipt names its recall id');
  } finally { await first.close(); }

  let restartedAsks = 0;
  const second = createOpencodeMount({
    storage: ledger,
    askGrammar: 'prune-two-option',
    askGenerate: async () => {
      restartedAsks += 1;
      return { text: '{}' };
    },
  });
  try {
    const rebuilt = structuredClone(original) as OpencodeMessage[];
    await second.transform(sessionId, rebuilt);
    assert.equal(restartedAsks, 0,
      'the banked removal is re-applied, never re-asked after the restart');
    assert.equal(rebuilt.some(message => message.id === 'msg_t1'), false,
      'the prior removal stays in effect on the first rebuilt request');
    const recalled = await second.tool.execute({ id: recallId }, { sessionID: sessionId });
    assert.match(JSON.stringify(recalled), new RegExp(sentinel),
      'the recall id still resolves the exact removed bytes');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a survivor cancellation releases every unit whose stored verdict it drops', () => {
  // A minimal entry-shaped fixture: the helper touches only these sets.
  const fake = {
    askVerdicts: new Map<string, WireAnswer>([
      ['unit:a', { verdict: { unitId: 'unit:a', action: 'forgetall', summary: '', answeredInRound: 1 } }],
      ['unit:b', { verdict: { unitId: 'unit:b', action: 'forgetall', summary: '', answeredInRound: 1 } }],
    ]),
    askedUnitIds: new Set(['unit:a', 'unit:b', 'unit:c']),
    retriedUnitIds: new Set(['unit:a', 'unit:b', 'unit:c']),
    refusedRetriedUnitIds: new Set(['unit:a', 'unit:b', 'unit:c']),
  };
  releaseCancelledUnits(fake as never, [
    { unitId: 'unit:a', origin: 'l2' },
    { unitId: 'unit:b', origin: 'l1' },
    { unitId: 'unit:c', origin: 'dedupe' },
  ]);
  assert.equal(fake.askVerdicts.has('unit:a'), false, 'the judged verdict is dropped');
  assert.equal(fake.askedUnitIds.has('unit:a'), false, 'the judged unit is released');
  assert.equal(fake.retriedUnitIds.has('unit:a'), false,
    'the judged unit is released from the retry record too');
  assert.equal(fake.refusedRetriedUnitIds.has('unit:a'), false,
    'the judged unit is released from the refusal-retry record too');
  assert.equal(fake.askVerdicts.has('unit:b'), false, 'the L1 verdict is dropped');
  assert.equal(fake.askedUnitIds.has('unit:b'), false,
    'an L1 cancellation releases the unit whose verdict it drops, not only l2');
  assert.equal(fake.retriedUnitIds.has('unit:b'), false,
    'the L1 unit leaves the retry record with its verdict');
  assert.equal(fake.refusedRetriedUnitIds.has('unit:b'), false,
    'the L1 unit leaves the refusal-retry record with its verdict');
  assert.equal(fake.askedUnitIds.has('unit:c'), true,
    'a cancellation with no stored verdict releases nothing');
  assert.equal(fake.retriedUnitIds.has('unit:c'), true,
    'a no-verdict cancellation keeps the retry record');
  assert.equal(fake.refusedRetriedUnitIds.has('unit:c'), true,
    'a no-verdict cancellation keeps the refusal-retry record');
});

test('an L1 cancellation of a verdict-holding unit releases it to a later pass',
  async () => {
    /*
     * ISSUE-300 item 8: the helper drops a cancelled unit's verdict for every
     * origin but used to release its claims only for l2. An l1 cancellation of
     * a unit that holds a stored verdict then lost the verdict and kept the
     * permanent claim, so no later crossing could table the unit. The release
     * depends on the verdict, not on the lane that planned the cancelled
     * removal.
     */
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const entry = await openSession(mount);
      const messages = twoReadConversation();
      const plan = buildOpencodePassPlan({
        sessionId, snapshot: entry.port.observe(messages), messages, round: 1,
      });
      assert.ok(plan !== null, 'the two reads plan');
      const unit = plan.askRows[0]?.unit;
      assert.ok(unit !== undefined, 'an ask row names the unit');
      entry.askedUnitIds.add(unit.id);
      entry.retriedUnitIds.add(unit.id);
      entry.refusedRetriedUnitIds.add(unit.id);
      entry.askVerdicts.set(unit.id, { verdict: {
        unitId: unit.id, action: 'forgetall', summary: 'stale note', answeredInRound: 1,
      } });
      // The walk the apply performs for a document cancellation: an l1 proof
      // was cancelled after this unit's verdict had already been stored.
      releaseCancelledUnits(entry, [{ unitId: unit.id, origin: 'l1' }]);
      assert.equal(entry.askVerdicts.has(unit.id), false, 'the verdict is dropped');
      assert.equal(entry.askedUnitIds.has(unit.id), false,
        'the permanent claim is released with the verdict');
      assert.equal(entry.retriedUnitIds.has(unit.id), false,
        'the retry record is released with the verdict');
      assert.equal(entry.refusedRetriedUnitIds.has(unit.id), false,
        'the refusal-retry record is released with the verdict');
      const batch = buildOpencodeAskBatch({
        sessionId, messages, port: entry.port,
        seenNodeIds: new Set([unit.nodeId]),
        askedUnitIds: entry.askedUnitIds, round: 2,
      });
      assert.ok(batch !== null, 'the restored array builds a pass');
      assert.equal(batch.unitIds.includes(unit.id), true,
        'the released unit is tabled again');
    } finally { await mount.close(); }
  });

test('a null plan releases every stored verdict unit before it clears them',
  async () => {
    /*
     * ISSUE-300 item 8: `plan === null` cleared every verdict without touching
     * the claims, so a unit whose verdict was cleared stayed permanently
     * claimed. A restored unit could never be tabled again. The clear now
     * releases the claim, retry and refusal records for every verdict unit.
     */
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const entry = await openSession(mount);
      const messages = twoReadConversation();
      const plan = buildOpencodePassPlan({
        sessionId, snapshot: entry.port.observe(messages), messages, round: 1,
      });
      assert.ok(plan !== null, 'the two reads plan');
      const unit = plan.askRows[0]?.unit;
      assert.ok(unit !== undefined, 'an ask row names the unit');
      entry.askedUnitIds.add(unit.id);
      entry.retriedUnitIds.add(unit.id);
      entry.refusedRetriedUnitIds.add(unit.id);
      entry.askVerdicts.set(unit.id, { verdict: {
        unitId: unit.id, action: 'forgetall', summary: 'stale note', answeredInRound: 1,
      } });
      // A host array with no result units: the next plan cannot name any
      // stored verdict's unit.
      const withoutUnits: OpencodeMessage[] = [userMessage('msg_u_clear', [text('No reads.')])];
      const applied = await applyOpencodeAskVerdicts({
        entry, messages: withoutUnits,
        snapshot: entry.port.observe(withoutUnits),
        answers: new Map(), window: 400_000, journal: journalSink(lines),
      });
      assert.equal(applied, false, 'a null plan applies nothing');
      assert.equal(entry.askVerdicts.size, 0, 'the stored verdicts are cleared');
      assert.equal(entry.askedUnitIds.has(unit.id), false,
        'the permanent claim is released before the clear');
      assert.equal(entry.retriedUnitIds.has(unit.id), false,
        'the retry record is released before the clear');
      assert.equal(entry.refusedRetriedUnitIds.has(unit.id), false,
        'the refusal-retry record is released before the clear');
      // A host restore puts the unit back; a later pass can table it.
      const batch = buildOpencodeAskBatch({
        sessionId, messages, port: entry.port,
        seenNodeIds: new Set([unit.nodeId]),
        askedUnitIds: entry.askedUnitIds, round: 2,
      });
      assert.ok(batch !== null, 'the restored array builds a pass');
      assert.equal(batch.unitIds.includes(unit.id), true,
        'the restored unit is tabled again');
    } finally { await mount.close(); }
  });

test('an L2 cancellation is journalled and releases the cancelled unit', async () => {
  /*
   * How the l2 cancellation is reached: `applyOpencodeAskVerdicts` runs core's
   * `applyPruneAnswers` over a real plan built from a closed-episode miss and a
   * live read, with the plan's declared content identities crafted to make the
   * two units one content class. The gate cancels the stored `forgetall`
   * verdict on the live unit (last-live-copy), the call site journals
   * `ask-cancel`, releases the unit's claims, and the closed-episode removal
   * still lands.
   *
   * Why the identities are crafted: an opencode tool-result unit's content is
   * the whole serialized node, including the call's own input and the result
   * `type`. An error result and a text result can never hold identical bytes,
   * and L1 keeps one member per content class, so no real transcript can place
   * a closed-episode removal and an ask row in one class. Everything else here
   * is real: the plan, the stored verdict, core's merge and survivor gate.
   */
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const entry = await openSession(mount);
    const body = `ENOENT: GONE.md\n\nMISSING_SENTINEL_2b7\n${'no-such-file-'.repeat(70)}\n`;
    const messages: OpencodeMessage[] = [
      userMessage('msg_u1', [text('Read the missing note, then the copy.')]),
      assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'GONE.md' })]),
      toolMessage('msg_t1', [toolResult('call_1', 'read', errorResult(body))]),
      assistantMessage('msg_a2', [toolCall('call_2', 'read', { filePath: 'COPY.md' })]),
      toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(body))]),
      assistantMessage('msg_a3', [text('Read both.')]),
    ];
    // The turn-end fact the mount's idle seam records for this array.
    await mount.transform(sessionId, messages);
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    const snapshot = deriveOpencodeSnapshot(messages, {
      sessionId, completedThroughTurnOrdinal: 0,
    }).snapshot;
    const plan = buildOpencodePassPlan({ sessionId, snapshot, messages, round: 1 });
    assert.ok(plan !== null, 'the miss and the live read plan');
    const live = plan.askRows[0]?.unit;
    assert.ok(live !== undefined, 'the live read is an ask row');
    const miss = plan.l1.removals.find(removal => removal.rule === 'closed-episode');
    assert.ok(miss !== undefined, 'the miss body is a closed-episode removal');
    const missContent = plan.contents.find(copy => copy.unitId === miss.unitId);
    assert.ok(missContent !== undefined, 'the miss unit has a content identity');
    const crafted = {
      ...plan,
      contents: plan.contents.map(copy => copy.unitId === live.id
        ? { ...copy, contentSha256: missContent.contentSha256,
          byteLength: missContent.byteLength }
        : copy),
    };
    entry.seenNodeIds.add(live.nodeId);
    entry.askedUnitIds.add(live.id);
    entry.retriedUnitIds.add(live.id);
    entry.refusedRetriedUnitIds.add(live.id);
    entry.askVerdicts.set(live.id, { verdict: {
      unitId: live.id, action: 'forgetall', summary: 'stale copy', answeredInRound: 1,
    } });
    const applied = await applyOpencodeAskVerdicts({
      entry, messages, snapshot, plan: crafted, answers: new Map(),
      window: 400_000, journal: journalSink(lines),
    });
    assert.equal(applied, true, 'the closed-episode removal still lands');
    const cancel = lines.of('ask-cancel').at(-1);
    assert.ok(cancel !== undefined, 'the cancellation is journalled, never silent');
    assert.equal(cancel['sessionId'], sessionId, 'the line names the session');
    assert.equal(typeof cancel['eventId'], 'string', 'the line names the pass event id');
    assert.equal((cancel['eventId'] as string).length > 0, true, 'the event id is not empty');
    assert.equal(cancel['unitId'], live.id, 'the line names the cancelled unit');
    assert.equal(cancel['origin'], 'l2', 'the line names the judged lane');
    assert.equal(cancel['reason'], 'last-live-copy', 'the line names the gate rule');
    assert.equal(entry.askVerdicts.has(live.id), false, 'the cancelled verdict is dropped');
    assert.equal(entry.askedUnitIds.has(live.id), false,
      'the release is the one the apply made at the call site');
    assert.equal(entry.retriedUnitIds.has(live.id), false, 'the retry record is released');
    assert.equal(entry.refusedRetriedUnitIds.has(live.id), false,
      'the refusal-retry record is released');
    // The released unit is tableable at a later pass.
    const batch = buildOpencodeAskBatch({
      sessionId, messages, port: entry.port,
      seenNodeIds: new Set([live.nodeId]),
      askedUnitIds: entry.askedUnitIds, round: 2,
    });
    assert.ok(batch !== null, 'the rebuilt array builds a pass');
    assert.equal(batch.unitIds.includes(live.id), true, 'the released unit is tabled');
    // The removal that survived the gate is the closed episode, not the verdict.
    const applyLine = lines.of('ask-apply').at(-1);
    assert.equal(applyLine?.['rule'], 'closed-episode',
      'the surviving removal is the closed episode, not the cancelled verdict');
  } finally { await mount.close(); }
});

test('a stored verdict whose unit leaves the array releases the claim for a later restore',
  async () => {
    /*
     * ISSUE-300 audit bug 4: dropping a verdict because the unit is absent left
     * the permanent claim set, so a restored unit could never be tabled again.
     * The claim, retry and refusal records must go with the verdict — unless a
     * banked removal owns them.
     */
    const lines = journalLines();
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      journal: record => lines.records.push(record as unknown as Record<string, unknown>),
    });
    try {
      const entry = await openSession(mount);
      const messages = twoReadConversation();
      const plan = buildOpencodePassPlan({
        sessionId, snapshot: entry.port.observe(messages), messages, round: 1,
      });
      assert.ok(plan !== null, 'the two reads plan');
      const unit = plan.units.find(candidate =>
        candidate.nodeId === opencodeToolNodeId(sessionId, 'call_1'));
      assert.ok(unit !== undefined, 'the first read is a unit');
      entry.askedUnitIds.add(unit.id);
      entry.retriedUnitIds.add(unit.id);
      entry.refusedRetriedUnitIds.add(unit.id);
      entry.askVerdicts.set(unit.id, { verdict: {
        unitId: unit.id, action: 'forgetall', summary: 'stale note', answeredInRound: 1,
      } });
      // The host rebuilds without the unit: the stored verdict cannot name it.
      const toolIndex = messages.findIndex(message => message.id === 'msg_t1');
      assert.ok(toolIndex >= 0, 'the fixture carries the first read');
      const [removedMessage] = messages.splice(toolIndex, 1);
      assert.ok(removedMessage !== undefined, 'the read was removed from the array');
      const without = buildOpencodePassPlan({
        sessionId, snapshot: entry.port.observe(messages), messages, round: 2,
      });
      assert.ok(without !== null, 'the other read keeps the pass alive');
      const applied = await applyOpencodeAskVerdicts({
        entry, messages, snapshot: entry.port.observe(messages), plan: without,
        answers: new Map(), window: 400_000, journal: journalSink(lines),
      });
      assert.equal(applied, false, 'a dropped verdict applies nothing');
      assert.equal(entry.askVerdicts.has(unit.id), false, 'the stale verdict is dropped');
      assert.equal(entry.askedUnitIds.has(unit.id), false,
        'the permanent claim is released with the verdict');
      assert.equal(entry.retriedUnitIds.has(unit.id), false,
        'the retry record is released with the verdict');
      assert.equal(entry.refusedRetriedUnitIds.has(unit.id), false,
        'the refusal-retry record is released with the verdict');
      // A host restore puts the unit back; it is tableable again.
      messages.splice(toolIndex, 0, removedMessage);
      const batch = buildOpencodeAskBatch({
        sessionId, messages, port: entry.port,
        seenNodeIds: new Set([unit.nodeId]),
        askedUnitIds: entry.askedUnitIds, round: 3,
      });
      assert.ok(batch !== null, 'the restored array builds a pass');
      assert.ok(batch.unitIds.includes(unit.id),
        'the restored unit is tableable again, not permanently claimed');
    } finally { await mount.close(); }
  });

test('stale-exact-reread is planned and applied through the opencode pass', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const entry = await openSession(mount);
    const messages = identicalRereadConversation();
    const snapshot = entry.port.observe(messages);
    const plan = buildOpencodePassPlan({ sessionId, snapshot, messages, round: 1 });
    assert.ok(plan !== null, 'the pass plans over the conversation');
    const stale = plan.l1.removals.filter(removal => removal.rule === 'stale-exact-reread');
    assert.equal(stale.length, 1, 'exactly one earlier copy is stale');
    const proof = stale[0]?.proof;
    assert.equal(proof?.rule, 'stale-exact-reread', 'the proof names the family');
    if (proof?.rule === 'stale-exact-reread') {
      assert.equal(proof.survivorNodeId, opencodeToolNodeId(sessionId, 'call_2'),
        'the later read is the named survivor');
      assert.equal(proof.targetKey, 'NOTES.md', 'the proof names the reread target');
    }

    const applied = await applyPlan(entry, messages, plan, lines);
    assert.equal(applied, true, 'the engine applied the pass');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the earlier read left the request');
    assert.equal(messages.some(message => message.id === 'msg_t2'), true,
      'the later read survives');
    const line = lines.of('ask-apply').at(-1);
    assert.equal(line?.['origin'], 'l1', 'the apply line names the L1 lane');
    assert.equal(line?.['rule'], 'stale-exact-reread', 'the apply line names the family');
    assert.ok((await appliedIntents(entry)).includes(String(line?.['intentId'])),
      'the ledger records the applied removal');
    assert.match(receiptText(messages), /NOTES\.md/u, 'the receipt names the unit path');
    assert.match(await recalledText(mount, line?.['recallId']),
      /STALE_REREAD_SENTINEL_4a1/u, 'the recall id returns the removed bytes');
  } finally { await mount.close(); }
});

test('closed-episode is planned and applied through the opencode pass', async () => {
  /*
   * ISSUE-300 G2: the idle is the turn-end fact. The mount records the turn
   * the idle ended and passes it to the next transform; no hand-passed ordinal
   * and no patched snapshot. The projection alone never claims the unfinished
   * turn complete.
   */
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const messages = missingReadConversation();
    // One unfinished user turn carrying the structured error read.
    await mount.transform(sessionId, messages);
    const entry = mount.sessions.get(sessionId);
    assert.ok(entry !== undefined, 'the first transform opened the session');
    const beforeIdle = entry.port.observe(messages);
    assert.equal(beforeIdle.currentTurnOrdinal, 0, 'one user turn');
    assert.equal(beforeIdle.completedThroughTurnOrdinal, -1,
      'the unfinished turn is not claimed complete before the idle');
    const missNode = beforeIdle.nodes.find(node =>
      node.id === opencodeToolNodeId(sessionId, 'call_1'));
    assert.equal(missNode?.kind === 'tool-result'
      && missNode.evidence.paths[0]?.outcome, 'miss',
      'the derived snapshot states the error read as a miss');
    assert.equal(missNode?.kind === 'tool-result'
      && Object.hasOwn(missNode.evidence.paths[0] ?? {}, 'coverage'), false,
      'a miss carries no coverage fact');
    assert.equal(lines.of('ask-apply').length, 0,
      'the unfinished turn plans no removal');
    // The idle ends turn 0. The next transform of the same array can close the
    // episode; without the idle fact the projection would still say -1.
    await mount.event({ type: 'session.idle', data: { sessionID: sessionId } });
    assert.equal(entry.completedThroughTurnOrdinal, 0,
      'the idle records the turn it ended');
    /*
     * The mount's own next transform plans and applies; no direct apply call
     * and no hand-passed ordinal. Without the idle fact this same-array
     * transform would still see `currentTurn - 1 = -1` and plan nothing.
     */
    await mount.transform(sessionId, messages);
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the closed episode result left the request');
    const line = lines.of('ask-apply').at(-1);
    assert.equal(line?.['origin'], 'l1', 'the apply line names the L1 lane');
    assert.equal(line?.['rule'], 'closed-episode', 'the apply line names the family');
    assert.ok((await appliedIntents(entry)).includes(String(line?.['intentId'])),
      'the ledger records the applied removal');
    /*
     * Core names a unit's receipt by its path only when a hit path exists
     * (`units/tracker.ts` `firstHitPath`). A miss body has no hit path, so the
     * receipt names the removed node; the proof above already names GONE.md.
     */
    assert.match(receiptText(messages), /oc:ses_test:tool:call_1/u,
      'the receipt names the removed miss node');
    assert.match(await recalledText(mount, line?.['recallId']),
      /MISSING_SENTINEL_2b7/u, 'the recall id returns the removed bytes');
    // A second user turn moves the projection on, but the idle fact completes
    // only turn 0; the current (unfinished) turn is not claimed.
    messages.push(userMessage('msg_u2', [text('Continue.')]));
    await mount.transform(sessionId, messages);
    const after = entry.port.observe(messages);
    assert.equal(after.currentTurnOrdinal, 1, 'the second user turn is current');
    assert.equal(after.completedThroughTurnOrdinal, 0,
      'the idle fact completes turn 0, never the unfinished turn 1');
  } finally { await mount.close(); }
});

test('the superseded-by-reread dedupe class plans only when enabled, and applies', async () => {
  const lines = journalLines();
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    journal: record => lines.records.push(record as unknown as Record<string, unknown>),
  });
  try {
    const entry = await openSession(mount);
    const messages = changedRereadConversation();
    /*
     * No coverage patch: the later whole-file read derives `coverage: 'full'`
     * from its own arguments and result (unranged, untruncated). Both plans go
     * through buildOpencodePassPlan (planPrunePass and the class switch), and
     * the apply's proof guard re-derives the same fact from the port's snapshot.
     */
    const snapshot = deriveOpencodeSnapshot(messages, { sessionId }).snapshot;
    const later = snapshot.nodes.find(node =>
      node.id === opencodeToolNodeId(sessionId, 'call_2'));
    assert.equal(later?.kind === 'tool-result'
      && later.evidence.paths[0]?.coverage, 'full',
      'the later whole read derives full coverage');
    const disabled = buildOpencodePassPlan({ sessionId, snapshot, messages, round: 1 });
    assert.ok(disabled !== null, 'the disabled pass still plans L1');
    assert.equal(disabled.l1.removals.length, 0,
      'the fixture bytes differ, so L1 proves nothing');
    assert.equal(disabled.dedupe.removals.length, 0,
      'the class is off by default and plans nothing');

    const enabled = buildOpencodePassPlan({
      sessionId, snapshot, messages, round: 1,
      classes: { supersededByReread: true },
    });
    assert.ok(enabled !== null, 'the enabled pass plans');
    assert.equal(enabled.dedupe.removals.length, 1,
      'the enabled class plans the earlier read');
    assert.equal(enabled.dedupe.removals[0]?.rule, 'superseded-by-reread',
      'the plan names the class');

    const applied = await applyPlan(entry, messages, enabled, lines);
    assert.equal(applied, true, 'the engine applied the pass');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the earlier read left the request');
    assert.equal(messages.some(message => message.id === 'msg_t2'), true,
      'the later read survives');
    const line = lines.of('ask-apply').at(-1);
    assert.equal(line?.['origin'], 'dedupe', 'the apply line names the dedupe lane');
    assert.equal(line?.['rule'], 'superseded-by-reread', 'the apply line names the class');
    assert.ok((await appliedIntents(entry)).includes(String(line?.['intentId'])),
      'the ledger records the applied removal');
    assert.match(receiptText(messages), /NOTES\.md/u, 'the receipt names the path');
    assert.match(await recalledText(mount, line?.['recallId']),
      /SUPERSEDED_OLD_SENTINEL_9c2/u, 'the recall id returns the older bytes');
  } finally { await mount.close(); }
});
