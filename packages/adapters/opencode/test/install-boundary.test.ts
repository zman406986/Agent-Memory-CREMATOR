// ISSUE-419: the install boundary.
//
// A mount installed into a session that already holds history must not treat
// that history as its own. Eligibility is "seen by this mount, one request
// later"; without a boundary the second transform promotes the whole
// pre-install surface and the ask/L1/dedupe lanes act on bytes the mount never
// saw arrive. The boundary is durable: the ledger file that exists before the
// open is the per-session record that this session was mounted before, so a
// restart keeps today's behavior and a `':memory:'` mount (which has no durable
// identity) does too.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeMessage } from '../src/host.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-install-'));
}

function journalLines() {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    of(kind: string): Record<string, unknown>[] {
      return records.filter(record => record['kind'] === kind);
    },
  };
}

/**
 * Two bash calls whose results are byte-identical: the L1 duplicate family. It
 * is deliberately NOT a read, because the at-rest stale/superseded rules are a
 * different lane; this fixture can only be removed by the ask pass.
 */
function duplicatedResults(): OpencodeMessage[] {
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

test('a fresh durable install never tables or removes pre-install history', async () => {
  const dir = scratch();
  const lines = journalLines();
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: join(dir, 'store') },
    askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: '{}' }; },
    journal: record => { lines.records.push(record as unknown as Record<string, unknown>); },
  });
  try {
    const messages = duplicatedResults();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);

    assert.equal(asks, 0, 'a pre-install unit is never tableable');
    assert.equal(lines.of('ask-apply').length, 0, 'no removal landed for pre-install history');
    assert.equal(messages.some(message => message.id === 'msg_ta'), true,
      'the earlier duplicate stays');
    assert.equal(messages.some(message => message.id === 'msg_tb'), true,
      'the later duplicate stays too');

    const states = lines.of('install').map(line => line['state']);
    assert.equal(states[0], 'fresh', 'the mount records the fresh install');
    assert.equal(states.includes('boundary'), true, 'it records the first-transform boundary');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart on the same durable state keeps today\'s behavior', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };

  const first = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
  });
  try {
    // Establish durable state (the ledger file) without ever asking.
    await first.transform(sessionId, duplicatedResults());
  } finally { await first.close(); }

  const lines = journalLines();
  let restartedAsks = 0;
  const second = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => { restartedAsks += 1; return { text: '{}' }; },
    journal: record => { lines.records.push(record as unknown as Record<string, unknown>); },
  });
  try {
    const messages = duplicatedResults();
    await second.transform(sessionId, messages);
    await second.transform(sessionId, messages);

    assert.equal(lines.of('install')[0]?.['state'], 'restart',
      'a pre-existing ledger is a restart, not a fresh install');
    assert.equal(restartedAsks, 1, 'the restart tables history one request later');
    assert.equal(messages.some(message => message.id === 'msg_tb'), false,
      'the restart removes the duplicate as it did before ISSUE-419');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One duplicate pair that first appears after the eviction and reopen. Its
 * body differs from `duplicatedResults` so it is a fresh tableable unit, not
 * the pre-install pair resurfacing (ISSUE-465).
 */
function postReopenUnit(): OpencodeMessage[] {
  const body = `-rw-r--r-- 1 ${'fresh-'.repeat(120)}\n`;
  return [
    assistantMessage('msg_a4', [toolCall('call_c', 'bash', { command: 'ls -l' })]),
    toolMessage('msg_tc', [toolResult('call_c', 'bash', textResult(body))]),
    assistantMessage('msg_a5', [toolCall('call_d', 'bash', { command: 'ls -l' })]),
    toolMessage('msg_td', [toolResult('call_d', 'bash', textResult(body))]),
    assistantMessage('msg_a6', [text('Same fresh listing.')]),
  ];
}

test('ISSUE-445 / ISSUE-465: an in-mount eviction and reopen keeps the install boundary', async () => {
  const dir = scratch();
  const lines = journalLines();
  let asks = 0;
  const askPrompts: string[] = [];
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: join(dir, 'store') },
    askGrammar: 'prune-two-option',
    askGenerate: async input => {
      asks += 1;
      askPrompts.push(input.prompt);
      // A whole-range keep: the ask fires and removes nothing.
      return { text: '{"1":{"keeplines":[[1,1]],"summary":"None"}}' };
    },
    journal: record => { lines.records.push(record as unknown as Record<string, unknown>); },
  });
  try {
    const messages = duplicatedResults();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    // Evict the id through the host's deletion event, then reopen it through
    // the genuine context hook (ISSUE-407 permits the reopen).
    await mount.event({ type: 'session.deleted', data: { sessionID: sessionId } });
    assert.equal(mount.sessions.has(sessionId), false, 'the session was evicted');
    /**
     * ISSUE-465: the reopened request carries a NEW unit that did not exist
     * before eviction. A reopen that wrongly recaptures the whole history as
     * pre-install excludes this unit too and asks nothing; the retained
     * boundary keeps only the original nodes out, so this unit stays eligible.
     */
    const reopenedMessages = [...messages, ...postReopenUnit()];
    await mount.transform(sessionId, reopenedMessages);
    await mount.transform(sessionId, reopenedMessages);

    assert.equal(asks, 1, 'the unit that first appears after the reopen is tableable once');
    const ask = lines.of('ask')[0];
    assert.equal(askPrompts.length, 1, 'exactly one ask was sent');
    assert.equal(askPrompts[0]?.includes('fresh-fresh-'), true,
      'the ask tables the unit that first appears after the reopen');
    assert.equal(askPrompts[0]?.includes('listing-listing-'), false,
      'no pre-install unit was asked');
    const askedUnits = (ask?.['unitIds'] as string[] | undefined) ?? [];
    assert.equal(askedUnits.length, 1, 'one post-reopen unit was asked');
    assert.equal(reopenedMessages.some(message => message.id === 'msg_ta'), true,
      'the earlier pre-install duplicate stays');
    assert.equal(reopenedMessages.some(message => message.id === 'msg_tb'), true,
      'the later pre-install duplicate stays too');
    const reopened = lines.of('install').filter(line => line['reopened'] === true);
    assert.equal(reopened.length, 1, 'the reopen names its boundary state');
    assert.equal(reopened[0]?.['state'], 'boundary', 'the retained boundary is restored');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a memory mount has no durable identity and keeps today\'s behavior', async () => {
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: '{}' }; },
  });
  try {
    const messages = duplicatedResults();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    assert.equal(asks, 1, 'a test-only memory mount keeps the one-request rule');
    assert.equal(messages.some(message => message.id === 'msg_tb'), false,
      'and the duplicate is removed as before');
  } finally { await mount.close(); }
});
