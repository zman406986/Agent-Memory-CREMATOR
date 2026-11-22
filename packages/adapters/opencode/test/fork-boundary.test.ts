// ISSUE-422: the fork/clone install boundary in the opencode adapter.
//
// opencode announces no fork event in the seam this mount reads, and a child's
// storage is its own (`sessions/<id>`), so a fork arrives as a FRESH install
// whose first transform already carries the parent's settled history. That is
// exactly the ISSUE-419 boundary: the first transform's nodes are pre-install,
// excluded from the ask, L1/dedupe and banked replay lanes. These tests drive a
// parent and then a child id over the same array and pin:
//
//   1. the child tables and removes nothing it inherited, and says by name that
//      a fork cannot be identified; and
//   2. the parent's own journal shows the same boundary for its own history, so
//      the child's silence is the boundary, not luck.

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

/**
 * Two bash calls whose results are byte-identical: the L1 duplicate family, so a
 * pass that ignores the boundary would ask and remove the later one.
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

test('ISSUE-422: a forked child never re-asks or removes its parent\'s settled units',
  async () => {
    const dir = scratch();
    const storage = { crematorStorageRoot: join(dir, 'store') };
    // The parent settles the inherited history under its own id.
    const parentLines = journalLines();
    const parent = createOpencodeMount({
      storage, askGrammar: 'prune-two-option',
      askGenerate: async () => ({ text: '{}' }),
      journal: record => { parentLines.records.push(record); },
    });
    try {
      await parent.transform(sessionId, duplicatedResults());
      assert.equal(parentLines.of('install')[0]?.['state'], 'fresh',
        'the parent is a fresh install of an empty session');
      assert.equal(parentLines.of('ask').length, 0,
        'the parent\'s first request is its own boundary, never asked');
    } finally { await parent.close(); }

    const lines = journalLines();
    let asks = 0;
    // The child id has its own (absent) storage: the host replays the same array.
    const child = createOpencodeMount({
      storage, askGrammar: 'prune-two-option',
      askGenerate: async () => { asks += 1; return { text: '{}' }; },
      journal: record => { lines.records.push(record); },
    });
    try {
      const messages = duplicatedResults();
      await child.transform(childSessionId, messages);
      await child.transform(childSessionId, messages);
      await child.transform(childSessionId, messages);

      const install = lines.of('install');
      assert.equal(install[0]?.['state'], 'fresh',
        'a child id is a fresh install of its own storage, not a restart');
      const boundary = install.find(line => line['state'] === 'boundary');
      assert.ok(boundary !== undefined, 'the first transform recorded the boundary');
      assert.ok((boundary['preInstallNodes'] as number) >= 2,
        'both inherited results are pre-install history');
      assert.equal(boundary['inheritedHistory'], true, 'the line names inherited history');
      assert.equal(boundary['fork'], 'unidentified',
        'the host exposed no fork event, so the adapter records that it cannot identify it');

      assert.equal(asks, 0, 'the child never re-asks a unit its parent settled');
      assert.equal(lines.of('ask-apply').length, 0, 'no receipt was recorded for inherited units');
      const ids = messages.map(message => message.id);
      assert.equal(ids.includes('msg_ta'), true, 'the earlier duplicate stays');
      assert.equal(ids.includes('msg_tb'), true, 'the later duplicate stays too');
      const textOf = (id: string): string => messages
        .filter(message => message.id === id)
        .flatMap(message => message.content)
        .map(part => (part.type === 'text' ? part.text : ''))
        .join('');
      assert.equal(textOf('msg_tb'), textOf('msg_ta'),
        'the inherited body keeps every byte');
    } finally {
      await child.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
