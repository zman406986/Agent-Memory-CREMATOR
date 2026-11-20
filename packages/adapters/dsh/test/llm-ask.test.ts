/**
 * The ask seam's deadline boundary (ISSUE-344).
 *
 * `timeoutMs` is load-bearing numeric config. The shipped guard builds a
 * deadline only for a positive finite value, so 0, negative and NaN all meant
 * "no deadline" — a misconfiguration could hang a step behind a long-lived
 * outer signal. ISSUE-088 documents `judgeTimeoutMs: 0` as the intentional
 * deadline-off switch; that semantics is kept and pinned here. Negative and
 * non-finite values are refused by name (`invalid-timeout`) instead of silently
 * disabling the deadline.
 *
 * The hang scenario is reproduced with a stream that never yields and an outer
 * signal that stays live: before the fix a negative/NaN timeout builds no
 * deadline and the ask hangs (the test's own timeout catches it); after the fix
 * the ask refuses promptly without touching the stream.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWire } from '../src/llm-ask.js';
import type { StreamAskOptions } from '../src/llm-ask.js';
import type { DshLlmChunk, DshLlmService } from '../src/plugin.js';

const route = { provider: 'a6', model: 'm' };

/** A stream that never yields: the stalled judge the hang scenario needs. */
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

/** A minimal wire ask with no fork hashes (the deadline path is hash-free). */
function ask(options: StreamAskOptions): ReturnType<typeof askWire> {
  return askWire(stalledService(), { system: '', tools: [], messages: [] }, options);
}

for (const bad of [-1, -120_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`timeoutMs ${String(bad)} is refused by name, never a silent deadline-off`,
    { timeout: 2_000 }, async () => {
      const outer = new AbortController(); // long-lived: never aborted during the ask
      const outcome = await ask({ ...route, timeoutMs: bad, signal: outer.signal });
      assert.equal(outcome.status, 'refused');
      if (outcome.status !== 'refused') return;
      assert.equal(outcome.reason, 'invalid-timeout',
        'a negative/non-finite timeout names itself instead of hanging');
      assert.equal(outcome.code, 'invalid-timeout');
    });
}

test('timeoutMs 0 keeps the documented deadline-off switch (ISSUE-088): the outer abort still fires',
  { timeout: 2_000 }, async () => {
    const outer = new AbortController();
    const pending = ask({ ...route, timeoutMs: 0, signal: outer.signal });
    // No deadline fires on its own; only the caller's abort settles the ask, and
    // it reads as an abort, never a timeout — proving 0 built no deadline.
    setTimeout(() => { outer.abort(); }, 20);
    const outcome = await pending;
    assert.equal(outcome.status, 'refused');
    if (outcome.status !== 'refused') return;
    assert.equal(outcome.reason, 'aborted', '0 means off; the outer signal is the only deadline');
  });

test('a positive finite timeout still fires the deadline as timeout', { timeout: 2_000 }, async () => {
  const outcome = await ask({ ...route, timeoutMs: 25 });
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.reason, 'timeout');
});