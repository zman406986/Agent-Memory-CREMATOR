// The status helper shared by the terminal and desktop parts (ISSUE-551,
// ADR-0073). These tests pin the helper's own arithmetic and formatting; every
// expected value is a literal written here, not a value derived from the module
// under test. The host shapes the helper reads are the 2.4.0 message shapes:
// `assistant` steps carry `tokens`, and a `compaction` message carries a
// `status` of `running`, `completed` or `failed`.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface Message {
  id: string;
  type: 'assistant' | 'compaction' | 'user';
  status?: 'running' | 'completed' | 'failed';
  tokens?: TokenUsage;
}

interface ContextStatus {
  used: number | null;
  limit: number | null;
  percent: number | null;
}

interface StatusModule {
  usedTokens(message: Message | null | undefined): number | null;
  lastAssistantWithUsage(
    messages: readonly Message[] | null | undefined,
    boundaryMessageID?: string,
  ): Message | null;
  contextStatus(input: {
    messages?: readonly Message[] | null;
    limit?: number | null;
    boundary?: string | null;
  }): ContextStatus;
  formatBytes(bytes: number): string;
  passLabel(pass: { removals?: number; bytes?: number }): string;
  refusalText(reason: string): string;
}

// The terminal part imports this module; the test loads it with `require` so one
// plain-JavaScript source is covered rather than a TypeScript twin.
const require = createRequire(import.meta.url);
const status = require('../ui/status.cjs') as StatusModule;

const NO_FILL: ContextStatus = { used: null, limit: null, percent: null };

function assistant(id: string, tokens?: TokenUsage): Message {
  return tokens === undefined ? { id, type: 'assistant' } : { id, type: 'assistant', tokens };
}

function compaction(id: string, state: 'running' | 'completed' | 'failed'): Message {
  return { id, type: 'compaction', status: state };
}

test('usedTokens sums input, cache read, cache write, output and reasoning', () => {
  const message = assistant('m1', {
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 300, write: 40 },
  });
  assert.equal(status.usedTokens(message), 465);
  assert.equal(status.usedTokens(assistant('m2', { input: 7 })), 7);
  assert.equal(status.usedTokens(assistant('m3')), null, 'a step without tokens reports nothing');
  assert.equal(status.usedTokens({ id: 'm4', type: 'user' }), null);
  assert.equal(status.usedTokens(null), null);
});

test('lastAssistantWithUsage takes the newest step after the last completed compaction', () => {
  const messages = [
    assistant('m1', { input: 10 }),
    compaction('c1', 'completed'),
    assistant('m2', { input: 20 }),
    assistant('m3', { input: 30 }),
    compaction('c2', 'failed'),
    assistant('m4', { input: 40 }),
  ];
  assert.equal(status.lastAssistantWithUsage(messages)?.id, 'm4');

  // A completed compaction starts the window over: the step before it is gone.
  const afterCompaction = [
    assistant('m1', { input: 10 }),
    assistant('m2', { input: 20 }),
    compaction('c1', 'completed'),
  ];
  assert.equal(status.lastAssistantWithUsage(afterCompaction), null);

  // A compaction that is still running, or failed, does not reset the window.
  assert.equal(status.lastAssistantWithUsage([
    assistant('m1', { input: 10 }),
    compaction('c1', 'running'),
  ])?.id, 'm1');
  assert.equal(status.lastAssistantWithUsage([
    assistant('m1', { input: 10 }),
    compaction('c1', 'failed'),
    assistant('m2'),
  ])?.id, 'm1', 'a step without tokens is skipped for the older one with tokens');
});

test('a revert boundary excludes the step at or after it', () => {
  const messages = [
    assistant('m1', { input: 100 }),
    assistant('m2', { input: 200 }),
    assistant('m3', { input: 300 }),
  ];
  assert.equal(status.lastAssistantWithUsage(messages, 'm2')?.id, 'm1');
  assert.equal(status.lastAssistantWithUsage(messages, 'm3')?.id, 'm2');
  assert.equal(
    status.lastAssistantWithUsage(messages, 'unknown-id')?.id,
    'm3',
    'an unknown boundary is ignored, not treated as an empty window',
  );
});

test('contextStatus reports all nulls without a message window or a positive limit', () => {
  assert.deepEqual(status.contextStatus({ messages: [], limit: 1000 }), NO_FILL);
  assert.deepEqual(status.contextStatus({ messages: null, limit: 1000 }), NO_FILL);
  assert.deepEqual(status.contextStatus({ messages: [assistant('m1', { input: 100 })] }), NO_FILL);
  assert.deepEqual(status.contextStatus({ messages: [assistant('m1', { input: 100 })], limit: 0 }), NO_FILL);
  assert.deepEqual(status.contextStatus({ messages: [assistant('m1', { input: 100 })], limit: null }), NO_FILL);
});

test('contextStatus rounds the fill and clamps it to 100', () => {
  assert.deepEqual(
    status.contextStatus({ messages: [assistant('m1', { input: 200_000 })], limit: 400_000 }),
    { used: 200_000, limit: 400_000, percent: 50 },
  );
  assert.equal(
    status.contextStatus({ messages: [assistant('m1', { input: 2 })], limit: 3 }).percent,
    67,
    'two thirds of the window rounds up to 67',
  );
  assert.deepEqual(
    status.contextStatus({ messages: [assistant('m1', { input: 500_000 })], limit: 100_000 }),
    { used: 500_000, limit: 100_000, percent: 100 },
  );
});

test('formatBytes uses B, KB and MB with one decimal where useful', () => {
  assert.equal(status.formatBytes(0), '0 B');
  assert.equal(status.formatBytes(512), '512 B');
  assert.equal(status.formatBytes(1023), '1023 B');
  assert.equal(status.formatBytes(1024), '1 KB');
  assert.equal(status.formatBytes(1536), '1.5 KB');
  assert.equal(status.formatBytes(1024 * 1024), '1 MB');
  assert.equal(status.formatBytes(1.5 * 1024 * 1024), '1.5 MB');
});

test('passLabel names the units and marks the byte figure approximate', () => {
  assert.equal(status.passLabel({ removals: 1, bytes: 1536 }), '1 unit · ~1.5 KB');
  assert.equal(status.passLabel({ removals: 4, bytes: 900 }), '4 units · ~900 B');
  assert.equal(status.passLabel({ removals: 0, bytes: 0 }), '0 units · ~0 B');
});

test('refusalText says a refusal in plain words and names an unknown reason', () => {
  assert.equal(status.refusalText('no-rows'), 'Nothing to cremate.');
  assert.equal(status.refusalText('no-session'), 'No chat request to cremate yet.');
  assert.equal(status.refusalText('ask-in-flight'), 'A cremation is already running.');
  assert.equal(status.refusalText('claimed-unit'), 'Nothing new to cremate.');
  assert.equal(status.refusalText('no-fire'), 'Nothing was removed.');
  assert.equal(status.refusalText('odd'), 'Cremation: odd.');
  assert.equal(status.refusalText(''), 'Cremation: no reason given.');
});
