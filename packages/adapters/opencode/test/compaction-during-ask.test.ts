// ISSUE-423: compaction during an in-flight ask (opencode adapter).
//
// `session.compaction.*` arrives on the event lane while an ask waits on the
// model. Two things must hold, and each is tested where it can fail:
//
//   1. the reply is refused by name when the compaction generation moved under
//      the ask: no verdict is stored, no receipt is recorded for the pre-ask
//      array, and no second ask is armed mid-flight (the latch re-arm is
//      deferred out of the open ask window); and
//   2. verdicts stored by an idle ask are dropped by name if a compaction lands
//      before the next transform applies them, so the apply never records a
//      receipt for an array that no longer exists.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord, OpencodeMountOptions } from '../src/plugin.js';
import type { OpencodeGenerateInput, OpencodeHostEvent, OpencodeMessage } from '../src/host.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

/** One tableable read above the test bar. */
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

/** One host usage row: the only reading the depth latch observes. */
function stepUsage(messageId: string, inputTokens: number): OpencodeHostEvent {
  return {
    type: 'session.step.ended',
    data: {
      sessionID: sessionId, assistantMessageID: messageId, finish: 'stop', cost: 0,
      tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

function options(askGenerate: OpencodeMountOptions['askGenerate'],
  records: OpencodeJournalRecord[]): OpencodeMountOptions {
  return {
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    // Deadline-off: the ask is ended by the test, never by a timer.
    askTimeoutMs: 0,
    ...(askGenerate === undefined ? {} : { askGenerate }),
    journal: record => records.push(record),
  };
}

test('ISSUE-423: a compaction during the ask refuses the reply and defers the latch',
  { timeout: 5_000 }, async () => {
    const lines = journalLines();
    let calls = 0;
    let release: (answer: { text: string }) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const askGenerate = (input: OpencodeGenerateInput) => {
      void input;
      calls += 1;
      if (calls === 1) {
        markStarted();
        return new Promise<{ text: string }>(resolve => { release = resolve; });
      }
      return Promise.resolve({ text: '{"1":{"keepall":true}}' });
    };
    const mount = createOpencodeMount(options(askGenerate, lines.records));
    let firing: Promise<void> | undefined;
    try {
      await mount.transform(sessionId, largeHostMessages());
      const second = largeHostMessages();
      firing = mount.transform(sessionId, second);
      await started;
      // The host compacts while the ask waits on the model.
      await mount.event({ type: 'session.compaction.started', data: { sessionID: sessionId } });
      await mount.event({ type: 'session.compaction.ended', data: { sessionID: sessionId } });
      assert.equal(lines.of('compaction-deferred')[0]?.['window'], 'ask',
        'the open window is the ask');
      assert.equal(lines.of('compacted').at(-1)?.['rearmed'], false,
        'the latch was not re-armed mid-ask');
      release({ text: '{"1":{"forgetall":true,"summary":"stale note"}}' });
      await firing;

      assert.equal(calls, 1, 'one ask left the seam and no second was armed');
      const refused = lines.of('ask-error').filter(line => line['stage'] === 'compaction');
      assert.equal(refused.length, 1, 'the reply is refused by name');
      assert.equal(refused[0]?.['applied'], false, 'nothing was applied');
      assert.equal(lines.of('ask').length, 0, 'no fire was recorded for the stale reply');
      assert.equal(lines.of('ask-apply').length, 0,
        'no receipt was recorded for the pre-ask array');
      assert.equal(second.some(message => message.id === 'msg_t1'), true,
        'the result keeps every byte');
      assert.equal(lines.of('compaction-stale').length, 0,
        'nothing was stored, so nothing had to be dropped later');
    } finally {
      await firing?.catch(() => undefined);
      await mount.close();
    }
  });

test('ISSUE-423: stored verdicts are dropped by name when a compaction precedes the apply',
  { timeout: 5_000 }, async () => {
    const lines = journalLines();
    let calls = 0;
    const mount = createOpencodeMount(options(async () => {
      calls += 1;
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    }, lines.records));
    try {
      await mount.transform(sessionId, largeHostMessages());
      await mount.event(stepUsage('msg_idle_1', 50));
      await mount.transform(sessionId, largeHostMessages());
      await mount.event(stepUsage('msg_idle_2', 150));
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the session is mounted');
      await mount.idle(sessionId);
      assert.equal(lines.of('ask').length, 1, 'the idle ask fired once');
      assert.equal(entry.askVerdicts.size > 0, true, 'its verdict is stored for the apply');
      assert.equal(entry.deferredApply, true, 'the apply is deferred to the next transform');

      // The host compacts before that transform: the array the verdict names is gone.
      await mount.event({ type: 'session.compaction.started', data: { sessionID: sessionId } });
      await mount.event({ type: 'session.compaction.ended', data: { sessionID: sessionId } });
      const before = largeHostMessages();
      const after = largeHostMessages();
      await mount.transform(sessionId, after);

      const stale = lines.of('compaction-stale');
      assert.equal(stale.length, 1, 'the stale verdicts are dropped by name');
      assert.ok((stale[0]?.['count'] as number) >= 1, 'the drop names how many were dropped');
      assert.equal(stale[0]?.['verdictGeneration'], 0, 'it names the generation they were read under');
      assert.equal(lines.of('ask-apply').length, 0,
        'no receipt was recorded for the pre-ask array');
      assert.equal(after.some(message => message.id === 'msg_t1'), true,
        'the result keeps every byte');
      assert.deepEqual(after.map(message => message.id), before.map(message => message.id),
        'the array is untouched');
      assert.equal(entry.verdictGeneration, null, 'the dropped generation is cleared');
      assert.equal(calls, 1, 'no stale reply produced a second ask');
    } finally {
      await mount.close();
    }
  });
