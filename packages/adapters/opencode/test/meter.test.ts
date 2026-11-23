// Meter gate for the 2.4.0 event seam (ISSUE-192; plan §2.4; ADR-0044).
//
// The one number this suite pins is the one that turns a warm call from a throw
// into a reading: the host's `input` is already net of cache, so
// `inputTokens = input + cache.read + cache.write` and
// `cachedInputTokens = cache.read + cache.write`. Handing the host row through
// raw makes `cachedInputTokens` exceed `inputTokens`, and the core's
// `Meter.reconcile` refuses that (`MeterError('inconsistent-usage')`).
//
// The row now comes from one `session.step.ended` event, not a `step-finish`
// part. Every expected value is written out by hand; none is read back from the
// module under test to compare with it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharHeuristicTokenMeter, Meter } from '@cremator/core';
import { costOf, generateUsageRow, stepEndedRow, tokenUsageOf, usageObservation } from '../src/meter.js';
import { runRows } from './rows.js';
import type { Row } from './rows.js';

/**
 * The core's refusal is not re-exported by name, so the test matches the shape
 * it publishes: `name === 'MeterError'` and the code it carries.
 */
function meterRefusal(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => isRecord(error) && error['name'] === 'MeterError'
    && error['code'] === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `session.step.ended` data payload exactly as 2.4.0 declares it. */
function stepEnded(
  assistantMessageID: string | undefined,
  tokens: Record<string, unknown> | undefined,
  cost: unknown = 0.0025,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(assistantMessageID === undefined ? {} : { assistantMessageID }),
    finish: 'stop',
    ...(cost === undefined ? {} : { cost }),
    ...(tokens === undefined ? {} : { tokens }),
    ...extra,
  };
}

const ROWS: readonly Row[] = [
  { name: 'host-input-is-net-of-cache', run(at) {
    // One live-shaped row: 240 fresh input, 7000 cache read, 296 cache write.
    const read = tokenUsageOf({ input: 240, output: 81, reasoning: 12,
      cache: { read: 7000, write: 296 } });
    assert.deepEqual(read, { kind: 'usage', reasoningTokens: 12,
      usage: { inputTokens: 7536, outputTokens: 81, cachedInputTokens: 7296 },
      cacheReadTokens: 7000, cacheWriteTokens: 296 },
    at('the three buckets sum into one prompt count, and the cache split is kept'));
    // And the core accepts it: the cached share is inside the prompt count, not
    // on top of it. The raw row would fail here with `inconsistent-usage`.
    const meter = new Meter(new CharHeuristicTokenMeter());
    const reading = meter.reconcile({ kind: 'usage', requestId: 'msg_a1',
      revision: 'oc:4:abc', estimatedInputTokens: 7000, usage: read.usage });
    assert.equal(reading.inputTokens, 7536, at('the core reads the summed prompt count'));
    assert.equal(reading.cachedInputTokens, 7296, at('the cached share is inside the prompt'));
    assert.equal(reading.cachedInputShare, 7296 / 7536, at('the cached share is the ratio'));
    assert.equal(reading.estimateErrorTokens, 7536 - 7000, at('the error is prompt minus estimate'));
    // Passing the host's own `input` through raw is the defect this row names.
    assert.throws(() => meter.reconcile({ kind: 'usage', requestId: 'raw',
      revision: 'oc:4:abc', estimatedInputTokens: 240,
      usage: { inputTokens: 240, outputTokens: 81, cachedInputTokens: 7296 } }),
    meterRefusal('inconsistent-usage'),
    at('a raw row puts the cached share above the prompt and must be refused'));
  } },
  { name: 'a-row-exists-only-for-a-step-ended-event', run(at) {
    const row = stepEndedRow(stepEnded('msg_a1',
      { input: 4, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }, 0.25));
    assert.equal(row?.kind, 'usage', at('an ended step yields a usage row'));
    if (row?.kind !== 'usage') throw new Error(at('missing row'));
    assert.equal(row.messageId, 'msg_a1', at('the row is keyed by the assistant message id'));
    assert.deepEqual(row.usage,
      { inputTokens: 9, outputTokens: 2, cachedInputTokens: 5 },
      at('the three input buckets sum; output is carried as stated'));
    assert.equal(row.reasoningTokens, 1, at('reasoning is reported, never added to output'));
    assert.equal(row.costUsd, 0.25, at('the event cost is carried'));
    // A row with no tokens is a named missing row, never a zero reading.
    assert.deepEqual(stepEndedRow(stepEnded('msg_a2', undefined)),
      { kind: 'missing', messageId: 'msg_a2', reason: 'no-tokens' },
      at('an absent tokens object is missing, never zero'));
    // A malformed count is invalid, and the row names the reason.
    const bad = stepEndedRow(stepEnded('msg_a3', { input: 'plenty', output: 1 }));
    assert.equal(bad?.kind, 'invalid', at('a non-numeric input is invalid'));
    assert.equal(bad?.kind === 'invalid' ? bad.messageId : null, 'msg_a3',
      at('the malformed row still names its message'));
    // No assistant message id is not a step row at all.
    assert.equal(stepEndedRow(stepEnded(undefined, { input: 1, output: 1,
      reasoning: 0, cache: { read: 0, write: 0 } })), null,
    at('an event with no assistant message id is not a row'));
    assert.equal(stepEndedRow(null), null, at('a non-object payload is not a row'));
    // `finish` is not read: an error finish still states what it spent.
    const failed = stepEndedRow(stepEnded('msg_a4', { input: 1, output: 1,
      reasoning: 0, cache: { read: 0, write: 0 } }, 0, { finish: 'error' }));
    assert.equal(failed?.kind, 'usage', at('finish does not invalidate a stated count'));
  } },
  { name: 'a-cache-object-is-a-stated-cache-and-its-absence-is-unknown', run(at) {
    const cold = tokenUsageOf({ input: 10, output: 2, reasoning: 0,
      cache: { read: 0, write: 0 } });
    assert.deepEqual(cold.kind === 'usage' ? cold.usage : null,
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
      at('zero cache counters are a cold cache, which is a fact'));
    const unknown = tokenUsageOf({ input: 10, output: 2, reasoning: 0 });
    assert.deepEqual(unknown.kind === 'usage' ? unknown.usage : null,
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: null },
      at('an absent cache object is unknown, never a cold cache'));
    const bad = tokenUsageOf({ input: 10, output: 2, cache: { read: 1 } });
    assert.equal(bad.kind, 'invalid', at('a half-stated cache is invalid'));
  } },
  { name: 'cost-is-telemetry-only', run(at) {
    const row = stepEndedRow(stepEnded('msg_c1',
      { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, 9.75));
    const observation = row?.kind === 'usage'
      ? usageObservation(row, 'oc:4:abc', 100) : null;
    assert.ok(observation !== null, at('the row yields an observation'));
    assert.deepEqual(Object.keys(observation ?? {}).sort(),
      ['estimatedInputTokens', 'kind', 'requestId', 'revision', 'usage'],
      at('cost is not part of the core observation'));
    assert.equal(observation?.usage.inputTokens, 1, at('the usage is carried verbatim'));
    assert.equal(observation?.requestId, 'msg_c1', at('the request id is the assistant message'));
    // A malformed cost never invalidates the reading.
    const malformed = stepEndedRow(stepEnded('msg_c2',
      { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, 'free'));
    assert.equal(malformed?.kind, 'usage', at('a malformed cost is still a usage row'));
    assert.equal(malformed?.kind === 'usage' ? malformed.costUsd : 1, null,
      at('the malformed cost is null, never a number'));
    assert.equal(costOf(-1), null, at('a negative cost is not printable'));
  } },
  { name: 'the-generate-answer-is-the-ask-reading', run(at) {
    const declared = generateUsageRow({
      text: '{}',
      tokens: { input: 1_000, output: 40, reasoning: 5, cache: { read: 700, write: 30 } },
      cost: 0.0125,
    }, 'ask:1');
    assert.equal(declared?.kind, 'usage', at('the declared answer yields a usage row'));
    if (declared?.kind !== 'usage') throw new Error(at('missing row'));
    assert.deepEqual(declared.usage,
      { inputTokens: 1_730, outputTokens: 40, cachedInputTokens: 730 },
      at('the four token counts map through the step row arithmetic'));
    assert.equal(declared.reasoningTokens, 5, at('reasoning is carried, never added to output'));
    assert.equal(declared.cacheReadTokens, 700, at('the read bucket is carried'));
    assert.equal(declared.cacheWriteTokens, 30, at('the write bucket is carried'));
    assert.equal(declared.costUsd, 0.0125, at('the declared cost is carried'));
    assert.equal(declared.messageId, 'ask:1', at('the id is the mount ask identity'));
    // Precedence: the declared shape wins when both are usable.
    const both = generateUsageRow({
      text: '{}',
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
      usage: { input: 99, output: 99, reasoning: 9, cache: { read: 9, write: 9 } },
      cost: 0.5,
    }, 'ask:2');
    assert.deepEqual(both?.kind === 'usage' ? both.usage : null,
      { inputTokens: 17, outputTokens: 2, cachedInputTokens: 7 },
      at('the declared tokens beat the open usage field'));
    assert.equal(both?.kind === 'usage' ? both.costUsd : 1, 0.5,
      at('the declared cost is carried with the declared tokens'));
    // The open shape is the fallback when the declared one is absent.
    const open = generateUsageRow({ text: '{}',
      usage: { input: 5, output: 3, reasoning: 0, cache: { read: 1, write: 1 } } }, 'ask:3');
    assert.deepEqual(open?.kind === 'usage' ? open.usage : null,
      { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
      at('the open usage field still reads'));
    assert.equal(open?.kind === 'usage' ? open.costUsd : 1, null,
      at('no cost is stated, so cost is null, never zero'));
    // Nothing stated is null, never a zero reading.
    assert.equal(generateUsageRow({ text: '{}' }, 'ask:4'), null,
      at('an answer with no reading is null'));
    assert.equal(generateUsageRow(null, 'ask:5'), null, at('a non-object answer is null'));
  } },
];

test('the step-ended row — one row per claim', async () => {
  await runRows(ROWS);
});
