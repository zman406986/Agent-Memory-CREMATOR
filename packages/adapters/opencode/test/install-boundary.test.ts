// ADR-0069: results that predate the plugin mount are eligible.
//
// ISSUE-419 recorded the nodes already on the host surface at a fresh install
// and excluded them from the plan, the table and removal, so a `/cremate` on an
// existing session tabled nothing. ADR-0069 removes that exclusion: the first
// transform of a fresh install is still named on the `install` line as identity
// evidence (`fresh`, or `fork: 'unidentified'` for a durable state that holds no
// event for the session), but it filters no result. Eligibility is the shipped
// one-request rule: a node an already-sent request carried is tableable at the
// next request, whatever its age.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import type { OpencodeMessage } from '../src/host.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-install-'));
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** One large read result: tableable, above the ask floor, removable whole. */
function readConversation(tag = 'one', sentinel = 'body'): OpencodeMessage[] {
  const body = `# Note\n\n${`${sentinel}-`.repeat(240)}\n`;
  return [
    userMessage(`msg_${tag}_u1`, [text('Read the note.')]),
    assistantMessage(`msg_${tag}_a1`, [
      toolCall(`call_${tag}`, 'read', { filePath: 'NOTES.md' })],
    ),
    toolMessage(`msg_${tag}_t1`, [
      toolResult(`call_${tag}`, 'read', textResult(body))]),
    assistantMessage(`msg_${tag}_a2`, [text('The note says body.')]),
  ];
}

const FORGET_ROW_ONE = '{"1":{"forgetall":true,"summary":"stale note"}}';

test('a fresh durable install tables and removes its pre-existing result', async () => {
  const dir = scratch();
  const lines = journalLines();
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: join(dir, 'store') },
    askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: FORGET_ROW_ONE }; },
    journal: record => { lines.records.push(record); },
  });
  try {
    const messages = readConversation();
    // The first request ships the result but tables nothing: eligibility is
    // "carried by an already-sent request". The second request may table it.
    await mount.transform(sessionId, messages);
    assert.equal(asks, 0, 'the request that first carries the result tables nothing');
    await mount.transform(sessionId, messages);

    assert.equal(asks, 1, 'the pre-existing result is tableable one request later');
    assert.equal(messages.some(message => message.id === 'msg_one_t1'), false,
      'the pre-existing result is removable');
    assert.equal(lines.of('ask-apply').length, 1, 'the removal landed a receipt');

    const install = lines.of('install');
    assert.equal(install[0]?.['state'], 'fresh', 'the mount names the fresh install');
    assert.equal(install.some(line => line['state'] === 'boundary'), false,
      'no install boundary is claimed for eligibility');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart on the same durable state behaves exactly like a fresh install', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };

  const first = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => ({ text: '{}' }),
  });
  try {
    // Establish durable state (the ledger file) without ever asking.
    await first.transform(sessionId, readConversation());
  } finally { await first.close(); }

  const lines = journalLines();
  let restartedAsks = 0;
  const second = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => { restartedAsks += 1; return { text: FORGET_ROW_ONE }; },
    journal: record => { lines.records.push(record); },
  });
  try {
    const messages = readConversation();
    await second.transform(sessionId, messages);
    await second.transform(sessionId, messages);

    assert.equal(lines.of('install')[0]?.['state'], 'restart',
      'a pre-existing ledger is a restart, not a fresh install');
    assert.equal(restartedAsks, 1, 'the restart tables its history one request later');
    assert.equal(messages.some(message => message.id === 'msg_one_t1'), false,
      'the restart removes the result like a fresh install does');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an evicted and reopened session treats every result as eligible', async () => {
  const dir = scratch();
  const lines = journalLines();
  const prompts: string[] = [];
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { crematorStorageRoot: join(dir, 'store') },
    askGrammar: 'prune-two-option',
    askGenerate: async input => {
      asks += 1;
      prompts.push(input.prompt);
      return { text: FORGET_ROW_ONE };
    },
    journal: record => { lines.records.push(record); },
  });
  try {
    const before = readConversation('old', 'old');
    await mount.transform(sessionId, before);
    assert.equal(asks, 0, 'the first request tables nothing');

    // Evict the id through the host's deletion event, then reopen it through
    // the genuine context hook (ISSUE-407 permits the reopen).
    await mount.event({ type: 'session.deleted', data: { sessionID: sessionId } });
    assert.equal(mount.sessions.has(sessionId), false, 'the session was evicted');

    const after = readConversation('new', 'new');
    const reopened = [...before, ...after];
    // A reopen is a new mount entry: its first request ships the array and
    // tables nothing, exactly like any first request. The next request tables
    // every result the array carries, old and new alike.
    await mount.transform(sessionId, reopened);
    assert.equal(asks, 0, 'the reopen request that first carries the array tables nothing');
    await mount.transform(sessionId, reopened);
    assert.equal(asks, 1, 'the reopened entry tables its history one request later');
    assert.equal(prompts[0]?.includes('old-old-'), true,
      'the ask tables the result that predates the reopen');
    assert.equal(prompts[0]?.includes('new-new-'), true,
      'and the result the reopen request first carried');

    const install = lines.of('install');
    assert.equal(install.some(line => line['state'] === 'boundary'), false,
      'no boundary is restored on reopen');
    assert.equal(install.some(line => line['reopened'] === true), false,
      'the reopen claims no boundary state');
  } finally {
    await mount.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a memory mount has no durable identity and keeps the one-request rule', async () => {
  let asks = 0;
  const mount = createOpencodeMount({
    storage: { databasePath: ':memory:' },
    askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: FORGET_ROW_ONE }; },
  });
  try {
    const messages = readConversation();
    await mount.transform(sessionId, messages);
    await mount.transform(sessionId, messages);
    assert.equal(asks, 1, 'a test-only memory mount keeps the one-request rule');
    assert.equal(messages.some(message => message.id === 'msg_one_t1'), false,
      'and the result is removed as before');
  } finally { await mount.close(); }
});
