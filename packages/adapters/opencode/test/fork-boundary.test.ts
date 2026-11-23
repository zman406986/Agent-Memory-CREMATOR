// ISSUE-422 / ADR-0069: fork identity stays; the eligibility exclusion does not.
//
// OpenCode announces no fork event in the seam this mount reads, and a child's
// storage is its own (`sessions/<id>`). A fork therefore arrives either as a
// fresh install whose first transform already carries the parent's transcript,
// or as a durable state that exists but holds no event for the child (a copied
// ledger). The adapter cannot tell a fork from a reopen, so the install line
// names the unidentified state (`fork: 'unidentified'`). That is identity
// evidence only: ADR-0069 makes the inherited results eligible exactly like
// results the mount observes land. These tests pin both halves — the name is
// kept, the exclusion is gone.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import type { OpencodeMessage } from '../src/host.js';
import { openLedger, resolveStorage, sessionStorage } from '../src/storage.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

/** The child id a host fork would allocate. */
const childSessionId = 'ses_fork_child';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-fork-'));
}

function journalLines(): { records: OpencodeJournalRecord[];
  of(kind: string): OpencodeJournalRecord[] } {
  const records: OpencodeJournalRecord[] = [];
  return { records, of: kind => records.filter(record => record.kind === kind) };
}

/** One large inherited read: tableable and removable whole. */
function inheritedRead(tag = 'fork'): OpencodeMessage[] {
  const body = `# Note\n\n${`${tag}-`.repeat(240)}\n`;
  return [
    userMessage('msg_u1', [text('Read the note.')]),
    assistantMessage('msg_a1', [toolCall('call_1', 'read', { filePath: 'NOTES.md' })]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(body))]),
    assistantMessage('msg_a2', [text('The note says body.')]),
  ];
}

const FORGET_ROW_ONE = '{"1":{"forgetall":true,"summary":"stale note"}}';

test('a forked child tables and removes the history it inherited', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  // The child's storage is absent: the host replays the parent's transcript
  // into a fresh session id. That is the ordinary fork shape.
  const lines = journalLines();
  let asks = 0;
  const child = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: FORGET_ROW_ONE }; },
    journal: record => { lines.records.push(record); },
  });
  try {
    const messages = inheritedRead();
    await child.transform(childSessionId, messages);
    assert.equal(asks, 0, 'the first child request tables nothing');
    await child.transform(childSessionId, messages);

    assert.equal(lines.of('install')[0]?.['state'], 'fresh',
      'a child id with absent storage is a fresh install of its own storage');
    assert.equal(asks, 1, 'the inherited result is tableable one request later');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'the inherited result is removable');
    assert.equal(lines.of('ask-apply').length, 1, 'the removal landed a receipt');
    assert.equal(lines.of('install').some(line => line['state'] === 'boundary'), false,
      'no eligibility boundary is claimed');
  } finally {
    await child.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a durable state with no event for the session is named, not used as a gate', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  // A copied/state-less ledger: the file exists, holds no event for this
  // session. The adapter cannot tell it from a reopen, so it names the
  // unidentified state. The transcript it carries is still eligible.
  const target = sessionStorage(resolveStorage(storage), childSessionId);
  const empty = await openLedger(target, { nowMs: () => Date.now() });
  await empty.close();

  const lines = journalLines();
  let asks = 0;
  const child = createOpencodeMount({
    storage, askGrammar: 'prune-two-option',
    askGenerate: async () => { asks += 1; return { text: FORGET_ROW_ONE }; },
    journal: record => { lines.records.push(record); },
  });
  try {
    const messages = inheritedRead();
    await child.transform(childSessionId, messages);
    await child.transform(childSessionId, messages);

    const install = lines.of('install');
    assert.equal(install[0]?.['state'], 'restart',
      'an existing ledger file is a restart');
    assert.equal(install[0]?.['fork'], 'unidentified',
      'the adapter names the fork it cannot identify');
    assert.equal(install.some(line => line['state'] === 'boundary'), false,
      'the unidentified fork claims no eligibility boundary');
    assert.equal(asks, 1, 'the inherited result is tableable one request later');
    assert.equal(messages.some(message => message.id === 'msg_t1'), false,
      'and removable');
  } finally {
    await child.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
