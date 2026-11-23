// ISSUE-425: the ask deadline is validated against the platform timer range,
// and `0` stays deadline-off for the ask while close still terminates.
//
// - A delay above `2^31-1` ms is refused by name at mount; Node clamps such a
//   delay to 1 ms, which would silently turn a long deadline into an abort.
// - The boundary value `2^31-1` mounts and a normal ask still answers.
// - With `0` no timer is built; `close()` ends the wait through the mount's
//   close signal, journals `ask-close`, and returns.
//
// Offline test: no model call, no key, fake `session.generate` seams.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PLATFORM_TIMER_MS, createOpencodeMount, mountOptionsFromHost,
} from '../src/plugin.js';
import type { OpencodeJournalRecord, OpencodeMountOptions } from '../src/plugin.js';
import type { OpencodeGenerateInput, OpencodeMessage } from '../src/host.js';
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

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

function askOptions(askGenerate: OpencodeMountOptions['askGenerate'],
  askTimeoutMs: number, records: OpencodeJournalRecord[]): OpencodeMountOptions {
  return {
    storage: { databasePath: ':memory:' },
    contextWindowTokens: 400_000,
    pruneThresholdTokens: 100,
    askGrammar: 'prune-two-option',
    askTimeoutMs,
    ...(askGenerate === undefined ? {} : { askGenerate }),
    journal: record => records.push(record),
  };
}

test('ISSUE-446: a present non-number crematorAskTimeoutMs is refused by name',
  () => {
    for (const bad of ['60000', true, { ms: 60_000 }] as const) {
      assert.throws(
        () => mountOptionsFromHost({ crematorAskTimeoutMs: bad }),
        (error: unknown) => error instanceof TypeError
          && /askTimeoutMs/u.test(error.message)
          && /must be a number of milliseconds/u.test(error.message),
        `the string/bool/object value ${JSON.stringify(bad)} is a typed refusal`);
    }
    assert.equal('askTimeoutMs' in mountOptionsFromHost({}), false,
      'absent leaves the 120 s default in place');
    assert.equal(mountOptionsFromHost({ crematorAskTimeoutMs: 60_000 }).askTimeoutMs, 60_000,
      'a number is forwarded unchanged for the mount range checks');
  });

test('ISSUE-425: a deadline beyond the platform timer range is refused by name at mount',
  () => {
    assert.equal(MAX_PLATFORM_TIMER_MS, 2_147_483_647,
      'the platform range is 2^31-1 ms');
    // The seam is present so the mount reaches the deadline check, not the
    // earlier "ask without a generate" refusal.
    const seam = async () => ({ text: '' });
    assert.throws(
      () => createOpencodeMount(askOptions(seam, 3_000_000_000, [])),
      (error: unknown) => error instanceof Error
        && /askTimeoutMs/u.test(error.message)
        && /platform timer range/u.test(error.message),
      'the overflow is a typed mount refusal naming the option and the range');
    assert.throws(
      () => createOpencodeMount(askOptions(seam, MAX_PLATFORM_TIMER_MS + 1, [])),
      /platform timer range/u, 'one millisecond past the boundary is refused too');
  });

test('ISSUE-425: the boundary deadline mounts and a normal ask still answers',
  { timeout: 5_000 }, async () => {
    const lines = journalLines();
    const calls: OpencodeGenerateInput[] = [];
    // The reply takes ~20 ms; a 1 ms clamp would have timed the ask out.
    const askGenerate = async (input: OpencodeGenerateInput) => {
      calls.push(input);
      await new Promise<void>(resolve => { setTimeout(resolve, 20); });
      return { text: '{"1":{"forgetall":true,"summary":"stale note"}}' };
    };
    const mount = createOpencodeMount(askOptions(askGenerate, MAX_PLATFORM_TIMER_MS,
      lines.records));
    try {
      await mount.transform(sessionId, largeHostMessages());
      await mount.transform(sessionId, largeHostMessages());
      assert.equal(calls.length, 1, 'the boundary deadline sent one ask');
      assert.equal(lines.of('ask').length, 1, 'the reply was read as a fire');
      assert.deepEqual(lines.of('ask-error'), [],
        'the boundary deadline never became a 1 ms abort');
    } finally { await mount.close(); }
  });

test('ISSUE-413: a session interrupt settles the in-flight ask, not the deadline',
  { timeout: 5_000 }, async () => {
    const lines = journalLines();
    let started: (() => void) | undefined;
    const startedAt = new Promise<void>(resolve => { started = resolve; });
    // The generate never answers on its own. With a 60 s deadline, only the
    // interrupt seam can end the wait before this test's own timeout.
    const askGenerate = () => {
      started?.();
      return new Promise<{ text: string }>(() => {});
    };
    const mount = createOpencodeMount(askOptions(askGenerate, 60_000, lines.records));
    let firing: Promise<void> | undefined;
    try {
      await mount.transform(sessionId, largeHostMessages());
      firing = mount.transform(sessionId, largeHostMessages());
      await startedAt;
      await mount.event({ type: 'session.execution.interrupted',
        data: { sessionID: sessionId, reason: 'user' } });
      await firing;
      const error = lines.of('ask-error').at(-1);
      assert.equal(error?.['stage'], 'interrupt', 'the ask settles by name');
      assert.equal(error?.['interruptReason'], 'user', 'the host reason is kept');
      assert.equal(error?.['terminal'], true, 'the abandoned call keeps its claim');
      assert.equal(error?.['retry'], 'none', 'the units are not retried');
      assert.equal(lines.of('ask-error').some(line => line['stage'] === 'timeout'), false,
        'the 60 s deadline never expired, so the interrupt was the exit');
      const entry = mount.sessions.get(sessionId);
      assert.ok(entry !== undefined, 'the context hook built the session');
      assert.equal(entry.askInFlight, false, 'the lane lock is released');
      assert.equal(entry.abandonedAsks, 1, 'the uncancellable host call is abandoned');
      assert.equal(entry.askInterrupts.size, 0, 'the waiter was removed');
    } finally {
      await firing;
      await mount.close();
    }
  });

test('ISSUE-425: 0 stays deadline-off for the ask, and close still terminates',
  { timeout: 10_000 }, async () => {
    const lines = journalLines();
    let started: () => void = () => {};
    const startedAt = new Promise<void>(resolve => { started = resolve; });
    // A deadline-free ask whose generate never settles: only close can end it.
    const askGenerate = () => {
      started();
      return new Promise<{ text: string }>(() => {});
    };
    const mount = createOpencodeMount(askOptions(askGenerate, 0, lines.records));
    let firing: Promise<void> | undefined;
    try {
      await mount.transform(sessionId, largeHostMessages());
      firing = mount.transform(sessionId, largeHostMessages());
      await startedAt;
      assert.equal(lines.of('ask-error').length, 0,
        'no deadline was built: nothing timed out on its own');
      const outcome = await Promise.race([
        mount.close().then(() => 'closed' as const),
        new Promise<'hung'>(resolve => { setTimeout(() => resolve('hung'), 2_000); }),
      ]);
      assert.equal(outcome, 'closed', 'close returned instead of waiting forever');
      const closed = lines.of('ask-close');
      assert.equal(closed.length, 1, 'the outcome is journalled by name');
      assert.equal(closed[0]?.['stage'], 'close', 'the line names the close');
      assert.equal(closed[0]?.['origin'], 'step', 'the line keeps the ask origin');
      assert.equal(closed[0]?.['applied'], false, 'a closed ask applied nothing');
    } finally {
      await firing;
      await mount.close();
    }
  });
