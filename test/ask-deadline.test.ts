// ISSUE-425: the dsh ask deadline is validated against the platform timer range
// at mount and again at the ask boundary. Node clamps a delay above `2^31-1` ms
// to 1 ms, so a long deadline would become an almost immediate abort.
//
// Offline test: the mount validator and the ask seam only, no key, no stream.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWire } from '../src/llm-ask.js';
import { MAX_ASK_DEADLINE_MS } from '../src/llm-ask.js';
import { resolvePluginConfig } from '../src/plugin.js';
import type { DshLlmChunk, DshLlmService } from '../src/plugin.js';

/** A stream that never yields: the guard must refuse before it is touched. */
function stalledService(): DshLlmService {
  return {
    stream() {
      return (async function* stall(): AsyncGenerator<DshLlmChunk> {
        await new Promise(() => {});
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

test('ISSUE-425: an ask deadline beyond the platform timer range is refused by name at mount',
  () => {
    assert.equal(MAX_ASK_DEADLINE_MS, 2_147_483_647, 'the platform range is 2^31-1 ms');
    for (const value of [3_000_000_000, MAX_ASK_DEADLINE_MS + 1]) {
      assert.throws(() => resolvePluginConfig({ judgeTimeoutMs: value }),
        (error: unknown) => error instanceof Error
          && /judgeTimeoutMs/u.test(error.message)
          && /platform timer range/u.test(error.message),
        `judgeTimeoutMs ${String(value)} names the option and the range`);
    }
    // The boundary itself is the platform's own maximum, not a new cap.
    assert.equal(resolvePluginConfig({ judgeTimeoutMs: MAX_ASK_DEADLINE_MS }).judgeTimeoutMs,
      MAX_ASK_DEADLINE_MS, 'the boundary value mounts unchanged');
    assert.equal(resolvePluginConfig({ judgeTimeoutMs: 0 }).judgeTimeoutMs, 0,
      '0 stays the deadline-off switch');
  });

test('ISSUE-425: the ask boundary refuses an out-of-range deadline instead of building a timer',
  { timeout: 2_000 }, async () => {
    const outcome = await askWire(stalledService(),
      { system: '', tools: [], messages: [] },
      { provider: 'a6', model: 'm', timeoutMs: 3_000_000_000 });
    assert.equal(outcome.status, 'refused', 'the ask refuses before streaming');
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.reason, 'invalid-timeout',
      'the refusal is typed as an invalid timeout');
    assert.match(outcome.message, /platform timer range/u, 'the refusal names the range');
  });
