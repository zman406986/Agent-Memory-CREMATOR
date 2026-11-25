/**
 * The host usage row → core `ApiUsage` mapping (G8, ISSUE-045 D1; PRD §6.9).
 *
 * The three shapes the plan names: both counts present, the cache counter
 * absent, and no usage row at all. The first is the interesting one: the host
 * reports DISJOINT buckets (uncached input, cache read, cache write) and the
 * core counts the whole prompt with the cached part inside it, so the mapping
 * must sum them — reading the host row verbatim hands the meter a cached count
 * above its input count, which `Meter.reconcile` refuses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharHeuristicTokenMeter, Meter } from '@cremator/core';
import { readAssistantUsage, usageRequestId } from '../src/usage.js';
import type { Row } from './rows.js';
import { runRows } from './rows.js';

/** One host `assistant/message` carrying the given `usage` field. */
function message(usage: unknown, seq = 4): { type: string; seq: number; data: unknown } {
  return { type: 'assistant/message', seq, data: { turn: 1, step: 2, message: {}, usage } };
}

/**
 * Every shape the mapping must answer, one row each. A row that fails names
 * itself in the message, so a merged block still says which shape broke.
 */
const ROWS: readonly Row[] = [
  { name: 'both counts present: disjoint host buckets sum into the core prompt',
    run(at) {
      // The live shape recorded by the rig: 605 fresh input, 7424 cache reads.
      const read = readAssistantUsage(message({
        inputTokens: 605, outputTokens: 165, totalTokens: 8194,
        cacheReadTokens: 7424,
      }));
      assert.ok(read !== null && read.kind === 'usage', at('the row is a usage reading'));
      if (read === null || read.kind !== 'usage') return;
      assert.deepEqual(read.usage, { inputTokens: 605 + 7424, outputTokens: 165,
        cachedInputTokens: 7424 }, at('the cached read is summed into the prompt'));
      // And the core meter accepts it, at exactly the share the row states.
      const reading = new Meter(new CharHeuristicTokenMeter()).reconcile({
        kind: 'usage', requestId: 'request-1', revision: 'revision-1',
        estimatedInputTokens: 2000, usage: read.usage,
      });
      assert.equal(reading.inputTokens, 8029, at('the whole prompt is the input count'));
      assert.equal(reading.cachedInputTokens, 7424, at('the cache share stays readable'));
      assert.equal(reading.cachedInputShare, 7424 / 8029, at('the share is derived'));
      assert.equal(reading.estimateErrorTokens, 8029 - 2000, at('the error is derived'));
    } },
  { name: 'cached absent means null, never zero',
    run(at) {
      for (const usage of [
        { inputTokens: 120, outputTokens: 8 },
        { inputTokens: 120, outputTokens: 8, cacheReadTokens: null, cacheWriteTokens: null },
      ]) {
        const label = `${at('cached state unknown')} (${JSON.stringify(usage)})`;
        const read = readAssistantUsage(message(usage));
        assert.ok(read !== null && read.kind === 'usage', label);
        if (read === null || read.kind !== 'usage') continue;
        assert.deepEqual(read.usage, { inputTokens: 120, outputTokens: 8, cachedInputTokens: null },
          'a joined zero would claim a cold prefix nobody measured');
        const reading = new Meter(new CharHeuristicTokenMeter())
          .reconcile({ kind: 'usage', requestId: 'r', revision: 'v',
            estimatedInputTokens: 30, usage: read.usage });
        assert.equal(reading.cachedInputTokens, null, label);
        assert.equal(reading.cachedInputShare, null, label);
      }
    } },
  { name: 'no usage row at all is missing, not a zero-token request',
    run(at) {
      for (const data of [{ turn: 1, step: 1, message: {} },
        { turn: 1, step: 1, message: {}, usage: null }]) {
        assert.deepEqual(readAssistantUsage({ type: 'assistant/message', seq: 7, data }),
          { kind: 'missing' }, `${at('no row is missing')} (${JSON.stringify(data)})`);
      }
    } },
  { name: 'a cache write is counted with a cache read, never as fresh input',
    run(at) {
      const read = readAssistantUsage(message({
        inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 50,
      }));
      assert.ok(read !== null && read.kind === 'usage', at('the row is a usage reading'));
      if (read === null || read.kind !== 'usage') return;
      assert.equal(read.usage.inputTokens, 100 + 900 + 50,
        at('a cache write is part of the prompt, not fresh input'));
      assert.equal(read.usage.cachedInputTokens, 950, at('read and write share one cache count'));
    } },
  { name: 'a reading is only ever relative to its own request and revision',
    run(at) {
      assert.equal(usageRequestId('s-1', 4), 'dsh:s-1:usage:4', at('the id is the log position'));
      assert.notEqual(usageRequestId('s-1', 4), usageRequestId('s-1', 5),
        at('two positions are two requests'));
      assert.notEqual(usageRequestId('s-1', 4), usageRequestId('s-2', 4),
        at('two sessions are two requests'));
    } },
  { name: 'a malformed row is invalid and names why, never thrown',
    run(at) {
      const cases: readonly { readonly usage: unknown; readonly match: RegExp }[] = [
        { usage: 'tokens', match: /not an object/u },
        { usage: { outputTokens: 1 }, match: /inputTokens and outputTokens/u },
        { usage: { inputTokens: -1, outputTokens: 1 }, match: /inputTokens and outputTokens/u },
        { usage: { inputTokens: 1, outputTokens: 1.5 }, match: /inputTokens and outputTokens/u },
        { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: -3 }, match: /cacheReadTokens/u },
        { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 'many' }, match: /cacheWriteTokens/u },
      ];
      for (const { usage, match } of cases) {
        const label = `${at('malformed row refused')} (${JSON.stringify(usage)})`;
        const read = readAssistantUsage(message(usage));
        assert.ok(read !== null && read.kind === 'invalid', label);
        if (read === null || read.kind !== 'invalid') continue;
        assert.match(read.reason, match, label);
      }
    } },
];

test('every host usage row shape maps to its declared reading, or is refused by name', async () => {
  await runRows(ROWS);
});
