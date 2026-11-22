// ISSUE-421: an abandoned generate re-enters the context hook after the ask
// timeout. The timeout clears `askInFlight` while the host call still lives, so
// only the ask prompt identifies the request: a hook that is exactly one user
// message carrying the timed-out prompt is skipped whole — `lastMessages` is
// not overwritten, no at-rest pass runs, no second ask fires, and the skip is
// journalled by name. A later ordinary request still transforms.
//
// Offline test: no model call, no key, a fake `session.generate`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord, OpencodeMountOptions } from '../src/plugin.js';
import type { OpencodeGenerateInput, OpencodeHostEvent, OpencodeMessage } from '../src/host.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

/** One result above the ask floor, so the pass tables it. */
function largeHostMessages(): OpencodeMessage[] {
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

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** One step row; `requestKind` absent means the host declared nothing. */
function stepUsage(messageId: string, inputTokens: number,
  requestKind?: 'generate'): OpencodeHostEvent {
  return {
    type: 'session.step.ended',
    data: {
      sessionID: sessionId, assistantMessageID: messageId, finish: 'stop', cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(requestKind === undefined ? {} : { requestKind }),
    },
  };
}

test('ISSUE-421: the timed-out ask\'s own context hook is skipped whole', { timeout: 5_000 },
  async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    const options: OpencodeMountOptions = {
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askTimeoutMs: 20,
      // The generate never settles on its own: the deadline abandons it while
      // the host request lives on and may still reach the context hook.
      askGenerate: (input) => {
        calls.push(input);
        return new Promise(() => {});
      },
      journal: record => lines.records.push(record),
    };
    const mount = createOpencodeMount(options);
    try {
      await mount.transform(sessionId, largeHostMessages());
      // The second request crosses the small bar; its ask hangs past the deadline.
      const second = largeHostMessages();
      await mount.transform(sessionId, second);
      const timeout = lines.of('ask-error').at(-1);
      assert.equal(timeout?.['stage'], 'timeout', 'the ask timed out');
      assert.equal(calls.length, 1, 'one generate was sent');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session entry exists');
      assert.equal(entry.lastMessages, second, 'the main array is the turn\'s own');
      const prompt = calls[0]?.prompt ?? '';
      assert.notEqual(prompt, '', 'the generate carried the table prompt');

      const atRestBefore = lines.of('at-rest').length;
      const commitBefore = lines.of('commit').length;

      // The abandoned generate's own request re-enters the hook: one user
      // message whose text is the ask prompt.
      await mount.transform(sessionId, [userMessage('msg_ask_abandoned', [text(prompt)])]);

      const skipped = lines.of('ask-abandoned');
      assert.equal(skipped.length, 1, 'the skip is journalled by name');
      assert.equal(skipped[0]?.['sessionId'], sessionId, 'the line names the session');
      assert.equal(skipped[0]?.['reason'], 'ask-request', 'the line names what was skipped');
      assert.equal(skipped[0]?.['promptSha256'], digest(prompt),
        'the identity is the prompt that survived the timeout');
      assert.equal(entry.lastMessages, second,
        'the abandoned request never became the main array');
      assert.equal(lines.of('at-rest').length, atRestBefore,
        'no at-rest pass ran for the abandoned request');
      assert.equal(lines.of('commit').length, commitBefore, 'nothing was committed');
      assert.equal(calls.length, 1, 'no second ask fired');
      assert.equal(lines.of('ask').length, 0, 'no fire was recorded');

      // A non-abandoned request after the timeout still transforms normally.
      const third = [...largeHostMessages(), userMessage('msg_u3', [text('Continue.')])];
      await mount.transform(sessionId, third);
      assert.equal(entry.lastMessages, third, 'the ordinary request became the main array');
      assert.equal(lines.of('at-rest').length, atRestBefore + 1,
        'the ordinary request ran its at-rest pass');
    } finally { await mount.close(); }
  });

test('ISSUE-410: a never-settling abandoned ask is consumed by its late row once',
  { timeout: 5_000 }, async () => {
    const lines = journalLines();
    let release: (answer: { text: string }) => void = () => {};
    const mount = createOpencodeMount({
      storage: { databasePath: ':memory:' },
      contextWindowTokens: 400_000,
      pruneThresholdTokens: 100,
      askGrammar: 'prune-two-option',
      askTimeoutMs: 20,
      // A generate that NEVER settles on its own: only its late step row can
      // release the abandonment, and `release` later proves settlement too.
      askGenerate: () => new Promise<{ text: string }>(resolve => { release = resolve; }),
      journal: record => lines.records.push(record),
    });
    try {
      await mount.transform(sessionId, largeHostMessages());
      // A host that emits ask step rows opens the abandoned-call guard.
      await mount.event(stepUsage('msg_ask_declared', 9, 'generate'));
      const second = [...largeHostMessages(), userMessage('msg_u2', [text('Continue.')])];
      await mount.transform(sessionId, second);
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session entry exists');
      assert.equal(lines.of('ask-error').at(-1)?.['stage'], 'timeout', 'the ask timed out');
      assert.equal(entry.abandonedAsks, 1, 'the abandoned call is outstanding');

      // The abandoned call's late unstated row consumes the obligation even
      // though the generate promise never settles.
      await mount.event(stepUsage('msg_ask_late', 9));
      assert.equal(entry.abandonedAsks, 0, 'the late row consumed the obligation');
      assert.equal(entry.abandonedAsksConsumed, 1, 'the obligation moved to a consumed token');
      assert.equal(lines.of('usage-missing').at(-1)?.['reason'], 'ask-request',
        'the late row is still accounted in the ask lane');

      // Settlement takes the consumed token and does not decrement again.
      release({ text: '{}' });
      await new Promise<void>(resolve => { setImmediate(resolve); });
      assert.equal(entry.abandonedAsks, 0, 'settlement cannot drive the count below zero');
      assert.equal(entry.abandonedAsksConsumed, 0, 'settlement released the consumed token');

      // Main accounting is unfrozen: the next unstated row is a main turn and
      // pairs with a pending estimate instead of being discarded ask-lane.
      const reconciled = lines.of('usage-reconciled').length;
      await mount.event(stepUsage('msg_main_after', 300));
      assert.equal(lines.of('usage-reconciled').length, reconciled + 1,
        'a main row reconciles again once the abandoned obligation is consumed');
    } finally { await mount.close(); }
  });

