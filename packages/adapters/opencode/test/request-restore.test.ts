// ADR-0076 / ISSUE-604: a fresh process restores the saved last request for
// `/cremate`. The first mount ships one request and saves it; a second mount on
// the same durable root, with no live array, tables that save. No host call is
// made for a missing or corrupt save.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OpencodeMessage } from '../src/host.js';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import { requestSnapshotPath } from '../src/request-snapshot.js';
import { resolveStorage, sessionStorage } from '../src/storage.js';
import {
  assistantMessage, sessionId, text, textResult, toolCall, toolMessage, toolResult,
  userMessage,
} from './fixtures.js';

const NOTE_RESULT = `# Note\n\n${'alpha-'.repeat(120)}\n`;
const OTHER_RESULT = `# Other\n\n${'bravo-'.repeat(120)}\n`;
const TWO_REMOVALS = '{"1":{"forgetall":true,"summary":"alpha"}}\n'
  + '{"2":{"forgetall":true,"summary":"bravo"}}';

/** Two independent large results: a two-row table and a two-unit apply. */
function twoUnitMessages(): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read both notes.')]),
    assistantMessage('msg_a1', [
      text('Reading NOTES.md.'), toolCall('call_1', 'read', { filePath: 'NOTES.md' }),
    ]),
    toolMessage('msg_t1', [toolResult('call_1', 'read', textResult(NOTE_RESULT))]),
    assistantMessage('msg_a2', [
      text('Reading OTHER.md.'), toolCall('call_2', 'read', { filePath: 'OTHER.md' }),
    ]),
    toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(OTHER_RESULT))]),
    assistantMessage('msg_a3', [text('Both notes say body.')]),
  ];
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-restore-'));
}

function savedPath(dir: string): string {
  const target = sessionStorage(
    resolveStorage({ crematorStorageRoot: join(dir, 'store') }), sessionId);
  const path = requestSnapshotPath(target);
  assert.ok(path !== null, 'a durable target names the save');
  return path;
}

test('a manual pass after a restart tables the saved request', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  try {
    const firstLines: OpencodeJournalRecord[] = [];
    const first = createOpencodeMount({
      storage, journal: record => { firstLines.push(record); },
    });
    try {
      await first.transform(sessionId, twoUnitMessages());
    } finally {
      await first.close();
    }
    const savedLines = firstLines.filter(record => record.kind === 'request-saved');
    assert.equal(savedLines.length, 1, 'the transform saved the request');
    const saved = JSON.parse(readFileSync(savedPath(dir), 'utf8')) as {
      messages: OpencodeMessage[];
    };
    assert.equal(saved.messages.length, twoUnitMessages().length,
      'the save holds the whole array that shipped');

    let asks = 0;
    const lines: OpencodeJournalRecord[] = [];
    const second = createOpencodeMount({
      storage,
      askGrammar: 'prune-two-option',
      askGenerate: async () => { asks += 1; return { text: TWO_REMOVALS }; },
      journal: record => { lines.push(record); },
    });
    try {
      const result = await second.cremate(sessionId);
      assert.deepEqual({ fired: result.fired, reason: result.reason },
        { fired: true, reason: 'table' }, 'the saved request ran a table');
      assert.equal(asks, 1, 'one paid table pass');
      const restored = lines.filter(record => record.kind === 'request-restored');
      assert.equal(restored.length, 1, 'the restore is named on the journal');
      assert.equal(restored[0]?.['messages'], twoUnitMessages().length);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session with no save still answers no-session', async () => {
  const dir = scratch();
  try {
    let asks = 0;
    const mount = createOpencodeMount({
      storage: { crematorStorageRoot: join(dir, 'store') },
      askGrammar: 'prune-two-option',
      askGenerate: async () => { asks += 1; return { text: '{}' }; },
    });
    try {
      const result = await mount.cremate(sessionId);
      assert.deepEqual(result, { fired: false, reason: 'no-session', rows: 0 });
      assert.equal(asks, 0, 'no save means no paid call');
    } finally {
      await mount.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt save refuses request-unreadable and journals why', async () => {
  const dir = scratch();
  const storage = { crematorStorageRoot: join(dir, 'store') };
  try {
    const first = createOpencodeMount({ storage });
    try {
      await first.transform(sessionId, twoUnitMessages());
    } finally {
      await first.close();
    }
    writeFileSync(savedPath(dir), '{broken', 'utf8');

    let asks = 0;
    const lines: OpencodeJournalRecord[] = [];
    const second = createOpencodeMount({
      storage,
      askGrammar: 'prune-two-option',
      askGenerate: async () => { asks += 1; return { text: TWO_REMOVALS }; },
      journal: record => { lines.push(record); },
    });
    try {
      const result = await second.cremate(sessionId);
      assert.equal(result.reason, 'request-unreadable');
      assert.equal(result.fired, false);
      assert.equal(asks, 0, 'a corrupt save sends no host call');
      const refused = lines.filter(record => record.kind === 'mount-state-error'
        && record['fact'] === 'request');
      assert.equal(refused.length, 1, 'the read refusal is named once');
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a request-only array never replaces the saved main request', async () => {
  const dir = scratch();
  try {
    const mount = createOpencodeMount({
      storage: { crematorStorageRoot: join(dir, 'store') },
    });
    try {
      await mount.transform(sessionId, twoUnitMessages());
      const before = readFileSync(savedPath(dir), 'utf8');
      await mount.requestOnly('generate', {
        sessionID: sessionId,
        messages: [userMessage('msg_prompt', [text('a transient ask prompt')])],
      });
      const after = readFileSync(savedPath(dir), 'utf8');
      assert.equal(after, before, 'the request-only lane wrote nothing');
      const saved = JSON.parse(after) as { messages: OpencodeMessage[] };
      assert.equal(saved.messages.length, twoUnitMessages().length);
    } finally {
      await mount.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
