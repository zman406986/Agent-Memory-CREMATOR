#!/usr/bin/env node
/**
 * ADR-0045 / ISSUE-195 — a measurement run must carry the agent's reasoning.
 *
 * Three things are pinned here, all offline:
 *   (a) the mock route emits reasoning BEFORE the content delta, in the field
 *       `@opencode/ai` replays (`reasoning_content`), and records what it sent;
 *   (b) a request's reasoning is counted from the body the host actually posted,
 *       and a run whose requests carry none fails by name;
 *   (c) the session seed refuses a source session that carries no reasoning, and
 *       copies exactly one session's rows — never credentials — from a host
 *       database built here, not from the owner's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  COMPACTION_PROMPT_MARKERS, countReasoningInRequest, countReceiptMessages,
  countReceiptRecallIds, DUMMY_KEY, TITLE_PROMPT_MARKER, isCompactionRequest,
  isTitleRequest, toolCallIds,
} from './opencode-mock-model.mjs';
import {
  REPLAY_SESSION_TABLES, reasoningCarryBack, reasoningCumulative, reasoningFirstRequest,
  reasoningPin, reasoningReplyFrames, reasoningSendableGate, seedSessionDb, sessionReasoningCounts,
} from './opencode-run.mjs';
import { settlesWithin, stopMock, waitForMockPort } from './mock-child.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const MOCK = join(BENCH_DIR, 'opencode-mock-model.mjs');
const OFFLINE_SCRIPT = join(BENCH_DIR, 'opencode-offline.script.json');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'racoons-replay-'));
}

/* ------------------------------------------------------------------ request counting */

test('195 reasoning: a request counts assistant reasoning by message, byte and field', () => {
  const counted = countReasoningInRequest([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, reasoning_content: 'first thought' },
    { role: 'tool', content: 'x' },
    { role: 'assistant', content: 'done', reasoning_content: 'second thought' },
  ]);
  assert.equal(counted.messages, 2);
  assert.equal(counted.bytes, Buffer.byteLength('first thought') + Buffer.byteLength('second thought'));
  assert.deepEqual(counted.fields, ['reasoning_content']);
});

test('195 reasoning: the parser-supported fields are all counted, and empty strings are not', () => {
  const counted = countReasoningInRequest([
    { role: 'assistant', reasoning: 'a' },
    { role: 'assistant', reasoning_text: 'bb' },
    { role: 'assistant', reasoning_content: '' },
    { role: 'assistant', reasoning_content: null },
  ]);
  assert.equal(counted.messages, 2);
  assert.equal(counted.bytes, 3);
  assert.deepEqual(counted.fields, ['reasoning', 'reasoning_text']);
});

test('195 reasoning: only assistant messages count, whatever another role carries', () => {
  const counted = countReasoningInRequest([
    { role: 'system', reasoning_content: 'not the agent' },
    { role: 'user', reasoning_content: 'not the agent either' },
    { role: 'tool', reasoning: 'still not the agent' },
    { role: 'assistant', reasoning_content: 'the agent' },
  ]);
  assert.equal(counted.messages, 1);
  assert.equal(counted.bytes, Buffer.byteLength('the agent'));
});

test('195 reasoning: a receipt line is recognised on the wire, a plain prompt is not', () => {
  const withReceipt = countReceiptMessages([
    { role: 'user', content: 'read the file' },
    { role: 'user', content: '[not retained] src/a.ts lines 3–9 · necromancy recall-abc' },
    { role: 'user', content: [{ type: 'text', text: '[search: missing] none matched' }] },
  ]);
  assert.equal(withReceipt, 2);
  assert.equal(countReceiptMessages([{ role: 'user', content: 'read the file' }]), 0);
});

/* ------------------------------------------------------------------ the pin */

test('195 pin: a run whose requests carry zero reasoning fails by name (ADR-0045)', () => {
  const failed = reasoningPin([
    { seq: 1, reasoning_messages: 0, reasoning_bytes: 0 },
    { seq: 2, reasoning_messages: 0, reasoning_bytes: 0 },
  ]);
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /reasoning-pin/u);
  assert.match(failed.detail, /ADR-0045/u);
  assert.match(failed.detail, /request\(s\) 2/u);
});

test('195 pin: one reasoning request out of many does not pass the pin', () => {
  const failed = reasoningPin([
    { seq: 1, reasoning_messages: 0, reasoning_bytes: 0 },
    { seq: 2, reasoning_messages: 0, reasoning_bytes: 0 },
    { seq: 3, reasoning_messages: 1, reasoning_bytes: 40 },
  ]);
  assert.equal(failed.pass, false, 'a run may not carry reasoning on one request only');
  assert.match(failed.detail, /request\(s\) 2/u);
});

test('195 pin: a fresh run may have an empty first request; every later one must carry reasoning', () => {
  assert.equal(reasoningPin([
    { seq: 1, reasoning_messages: 0, reasoning_bytes: 0 },
    { seq: 2, reasoning_messages: 1, reasoning_bytes: 35 },
  ]).pass, true, 'a fresh run cannot carry a turn that has not happened yet');
  assert.equal(reasoningPin([
    { seq: 1, reasoning_messages: 1, reasoning_bytes: 35 },
    { seq: 2, reasoning_messages: 2, reasoning_bytes: 70 },
  ]).pass, true);
  assert.equal(reasoningPin([]).pass, false);
});

test('195 pin: a replay must carry reasoning on its first request too', () => {
  const failed = reasoningPin([
    { seq: 1, reasoning_messages: 0, reasoning_bytes: 0 },
    { seq: 2, reasoning_messages: 1, reasoning_bytes: 35 },
  ], { seededBytes: 109_156 });
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /request\(s\) 1/u);
});

/* ------------------------------------------------------------------ the first request */

test('195 first: request 1 must equal the sendable source bound, not merely reach it', () => {
  const failed = reasoningFirstRequest([
    { seq: 1, reasoning_bytes: 10 },
    { seq: 2, reasoning_bytes: 109_461 },
  ], 109_621, { rawBytes: 114_223, excludedBytes: 4_602 });
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /carried 10 reasoning bytes/u);
  assert.match(failed.detail, /sendable source bound is 109621 \(raw 114223, excluded 4602\)/u);
  assert.equal(failed.carried, 10);
  assert.equal(failed.expected, 109_621);
  assert.equal(failed.rawSourceBytes, 114_223);
  assert.equal(failed.excludedBytes, 4_602);

  // Equality in both directions: carrying MORE than the host can send from the
  // source is also an accounting error.
  assert.equal(reasoningFirstRequest([
    { seq: 1, reasoning_bytes: 109_622 },
  ], 109_621, { rawBytes: 114_223, excludedBytes: 4_602 }).pass, false);

  assert.equal(reasoningFirstRequest([
    { seq: 1, reasoning_bytes: 109_621 },
  ], 109_621, { rawBytes: 114_223, excludedBytes: 4_602 }).pass, true);

  // A fresh run has no source. The pure function still compares 0 with 0, but
  // the runner records that comparison as `not-applicable` on a fresh run — it
  // carries no evidence — so this case is only the function's own contract.
  assert.equal(reasoningFirstRequest([
    { seq: 1, reasoning_bytes: 0 },
  ], 0).pass, true);
  assert.equal(reasoningFirstRequest([
    { seq: 1, reasoning_bytes: 1 },
  ], 0).pass, false);
  assert.equal(reasoningFirstRequest([], 0).pass, false);
});

test('195 cumulative: every request carries the seed plus every prior reply, one string each', () => {
  // A wire assistant message carries one reasoning string; this helper builds
  // the captured request body the check reads.
  const carried = (seq, texts, reply) => ({
    seq,
    messages: texts.map((text) => ({ role: 'assistant', content: 'ok', reasoning_content: text })),
    reasoning_messages: texts.length,
    reasoning_bytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0),
    reply_reasoning_text: reply,
  });
  const seed = ['seed-alpha', 'seed-beta'];
  const r1 = 'reply one, the same byte count as r2!';
  const r2 = 'reply two, the same byte count as r1!';
  const rows = [
    carried(1, [...seed], r1),
    carried(2, [...seed, r1], r2),
    carried(3, [...seed, r1, r2], ''),
  ];
  const passed = reasoningCumulative(rows, { texts: seed, bytes: 20 });
  assert.equal(passed.pass, true, passed.detail);
  assert.deepEqual(passed.perRequest.map((row) => row.expected), [2, 3, 4]);

  // The compensated duplicate: r2 is missing and r1 appears twice. The total
  // byte count is identical, which the old byte-sum rule accepted; the set rule
  // names r2 missing and r1 extra.
  const compensated = [
    carried(1, [...seed], r1),
    carried(2, [...seed, r1], r2),
    carried(3, [...seed, r1, r1], ''),
  ];
  const dropped = reasoningCumulative(compensated, { texts: seed, bytes: 20 });
  assert.equal(dropped.pass, false);
  assert.deepEqual(dropped.perRequest[2].missing, [r2]);
  assert.deepEqual(dropped.perRequest[2].extra, [r1]);
  assert.equal(dropped.perRequest[2].expectedBytes, dropped.perRequest[2].carriedBytes,
    'the byte totals agree; only the set comparison can fail this');
  assert.match(dropped.detail, /dropped or replaced by a duplicate/u);
});

test('195 cumulative: a request missing a string from the seed fails, not only a zero total', () => {
  const carried = (seq, texts, reply) => ({
    seq,
    messages: texts.map((text) => ({ role: 'assistant', content: 'ok', reasoning_content: text })),
    reply_reasoning_text: reply,
  });
  const dropped = reasoningCumulative([
    carried(1, ['a', 'b'], 'c'),
    carried(2, ['a', 'c'], ''),
  ], { texts: ['a', 'b'], bytes: 2 });
  assert.equal(dropped.pass, false);
  assert.deepEqual(dropped.perRequest[1].missing, ['b']);
  assert.equal(dropped.perRequest[1].expected, 3);
});

test('195 cumulative: a row with no captured body fails by name, never silently', () => {
  const result = reasoningCumulative([{ seq: 1, reasoning_bytes: 0 }], { texts: [], bytes: 0 });
  assert.equal(result.pass, false);
  assert.match(result.detail, /carries no captured body|no captured messages/u);
});

test('195 carry-back: the old name now uses the set rule', () => {
  const carried = (seq, texts, reply) => ({
    seq,
    messages: texts.map((text) => ({ role: 'assistant', content: 'ok', reasoning_content: text })),
    reply_reasoning_text: reply,
  });
  const passed = reasoningCarryBack([
    carried(1, ['seed'], 'r1'),
    carried(2, ['seed', 'r1'], 'r2'),
  ], { texts: ['seed'], bytes: 4 });
  assert.equal(passed.pass, true, passed.detail);
  const dropped = reasoningCarryBack([
    carried(1, ['seed'], 'r1'),
    carried(2, ['seed'], 'r2'),
  ], { texts: ['seed'], bytes: 4 });
  assert.equal(dropped.pass, false);
  assert.match(dropped.detail, /was dropped|replaced by a duplicate/u);
});

/* ------------------------------------------------------------------ reply frames */

test('195 frames: reasoning frames are a config fact from the script, not a host measurement', () => {
  const all = reasoningReplyFrames([
    { seq: 1, reply_reasoning_frames: 1 },
    { seq: 2, reply_reasoning_frames: 1 },
  ]);
  assert.equal(all.contributesToPassed, false);
  assert.equal(all.allAnswered, true);
  assert.match(all.source, /mock script/u);
  const missing = reasoningReplyFrames([
    { seq: 1, reply_reasoning_frames: 1 },
    { seq: 2, reply_reasoning_frames: 0 },
  ]);
  assert.equal(missing.contributesToPassed, false);
  assert.equal(missing.citableRequirement, true);
  assert.equal(missing.allAnswered, false);
  assert.equal(missing.answeredWithoutReasoning, 1);
  assert.deepEqual(missing.missing, [2]);
  assert.match(missing.detail, /not citable as any measurement/u);
  assert.equal(reasoningReplyFrames([]).allAnswered, false);
});

/* ------------------------------------------------------------------ receipts and call ids */

test('195 wire: the request capture names the recall ids and call ids it carried', () => {
  const messages = [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'a' },
    { role: 'tool', tool_call_id: 'call_b', content: 'b' },
    { role: 'user', content: '[not retained] x · necromancy recall:sha256:abc' },
    { role: 'user', content: '[not retained] y · necromancy recall:sha256:def' },
    { role: 'assistant', content: 'no receipt here' },
  ];
  assert.deepEqual(countReceiptRecallIds(messages), ['recall:sha256:abc', 'recall:sha256:def']);
  assert.deepEqual(toolCallIds(messages), {
    calls: ['call_a', 'call_b'], results: ['call_a', 'call_b'],
  });
});

/* ------------------------------------------------------------------ the host database */

const SESSION_ID = 'ses_test_0000000000000000000000';
const PROJECT_ID = 'project_test';
const REASONING = 'the first thought, long enough to have bytes';

/**
 * A host database with the shape the seed reads, built here. Only the columns
 * the seed touches exist, plus a `credential` table that must never be copied.
 */
function makeSourceDb(dir, options) {
  const path = join(dir, 'source.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, sandboxes TEXT NOT NULL, '
    + 'time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_active INTEGER NOT NULL)');
  db.exec('CREATE TABLE project_directory (project_id TEXT NOT NULL, directory TEXT NOT NULL, '
    + 'time_created INTEGER NOT NULL)');
  db.exec('CREATE TABLE worktree (project_id TEXT NOT NULL, directory TEXT NOT NULL, '
    + 'time_created INTEGER NOT NULL)');
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, '
    + 'slug TEXT NOT NULL, title TEXT, directory TEXT NOT NULL, agent TEXT, model TEXT, '
    + 'tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL, tokens_reasoning INTEGER NOT NULL, '
    + 'time_created INTEGER NOT NULL)');
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, '
    + 'type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, '
    + 'data TEXT NOT NULL)');
  db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, secret TEXT NOT NULL)');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL, '
    + 'time_updated INTEGER NOT NULL)');
  db.prepare('INSERT INTO kv VALUES (?, ?, ?, ?)')
    .run('migration.v1-v2', '{"phase":"completed"}', 1, 1);
  db.prepare('INSERT INTO kv VALUES (?, ?, ?, ?)')
    .run('models-dev:v2:catalog', '{"body":"a large cache that must not be copied"}', 1, 1);

  db.prepare('INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)')
    .run(PROJECT_ID, 'C:/src/project', '[]', 1, 1, 1);
  db.prepare('INSERT INTO project_directory VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'C:/src/project', 1);
  db.prepare('INSERT INTO worktree VALUES (?, ?, ?)').run(PROJECT_ID, 'C:/src/project', 1);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    SESSION_ID, PROJECT_ID, null, 'test-session', 'a coding session', 'C:/src/project',
    'build', '{"id":"m","providerID":"p"}', 1_000, 100, options.tokensReasoning, 1,
  );
  const reasoningPart = options.reasoning
    ? [{ type: 'reasoning', text: options.reasoningText ?? REASONING,
      ...(options.reasoningIncomplete === true ? {} : { time: { created: 1, completed: 2 } }) }]
    : [];
  const assistant = {
    type: 'assistant',
    content: [...reasoningPart, { type: 'text', text: 'on it' }],
    ...(options.reasoningError === true
      ? { error: { type: 'aborted', message: 'Aborted' } } : {}),
  };
  const messages = [
    { type: 'user', content: [{ type: 'text', text: 'read the file' }] },
    assistant,
  ];
  messages.forEach((message, index) => {
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
      .run(`msg_${index}`, SESSION_ID, message.type, index, JSON.stringify(message));
  });
  db.prepare('INSERT INTO credential VALUES (?, ?)').run('cred_1', 'do-not-copy-this-key');
  db.close();
  return path;
}

test('195 seed: one session is copied with its reasoning, and no credential is', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 12, reasoning: true });
    const target = join(dir, 'seed', 'opencode.db');
    const seeded = seedSessionDb({ sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: target });
    assert.equal(seeded.ok, true, seeded.refused);
    assert.equal(seeded.sourceReasoning.parts, 1);
    assert.equal(seeded.sourceReasoning.bytes, Buffer.byteLength(REASONING));
    assert.equal(seeded.sourceReasoning.raw.bytes, Buffer.byteLength(REASONING));
    assert.equal(seeded.sourceReasoning.excluded.bytes, 0);
    assert.equal(seeded.sourceReasoning.excluded.breakdownConsistent, true);
    assert.equal(seeded.seededReasoning.parts, 1);
    assert.equal(seeded.seededReasoning.bytes, Buffer.byteLength(REASONING));
    assert.equal(seeded.seededReasoning.raw.bytes, Buffer.byteLength(REASONING));
    assert.equal(seeded.seededReasoning.excluded.bytes, 0);
    assert.equal(seeded.session.tokensReasoning, 12);
    // The strings the run is measured against, and the row counts the copy must
    // equal. A seed that copied fewer rows than the source is a hole, not a
    // smaller session.
    assert.deepEqual(seeded.sourceReasoningTexts.texts, [REASONING]);
    assert.equal(seeded.sourceReasoningTexts.store, 'session_message');
    assert.deepEqual(seeded.sourceContent.strings.sort(), ['on it', 'read the file']);
    assert.deepEqual(seeded.sourceCounts, { sessionMessages: 2, legacyParts: 0 });
    assert.equal(seeded.counts.sessionMessages, seeded.sourceCounts.sessionMessages);
    assert.equal(seeded.counts.legacyParts, seeded.sourceCounts.legacyParts);
    assert.deepEqual(
      seeded.copies.filter((row) => row.rows > 0).map((row) => row.table).sort(),
      ['kv', 'project', 'project_directory', 'session_message', 'session_v2', 'worktree'],
    );
    // P11: the copy lists are a selection, not "every table the source carries".
    // The tables the lists omit are recorded, so an uncopied source table is
    // visible in the record instead of silently absent.
    assert.ok(seeded.sourceTables.includes('credential'),
      'the source table list names every source table');
    assert.ok(seeded.notCopiedTables.includes('credential'),
      'a source table outside the copy list is recorded as not copied');
    assert.equal(seeded.notCopiedTables.includes('session_v2'), false,
      'a copied table is not listed as not copied');
    assert.ok(seeded.copiedTables.includes('session_message'));

    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT count(*) AS n FROM session_v2').get().n, 1);
      const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name);
      // The schema is the host's own, so the table exists; the ROWS are what
      // must never cross into a bench world.
      assert.equal(tables.includes('credential'), true);
      assert.equal(copy.prepare('SELECT count(*) AS n FROM credential').get().n, 0,
        'the seed copied credential rows into a bench world');
      // The migration marker travels; the owner's model catalog cache does not.
      assert.deepEqual(copy.prepare('SELECT key FROM kv ORDER BY key').all().map((row) => row.key),
        ['migration.v1-v2']);
      assert.equal(copy.prepare('SELECT count(*) AS n FROM session_message').get().n, 2);
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: a session with zero reasoning parts is refused by name (ADR-0045)', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 12, reasoning: false });
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: join(dir, 'seed.db'),
    });
    assert.equal(seeded.ok, false);
    assert.match(seeded.refused, /0 reasoning parts/u);
    assert.match(seeded.refused, /ADR-0045/u);
    assert.equal(existsSync(join(dir, 'seed.db')), false, 'a refused seed wrote a database anyway');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 sendable: an errored assistant turn is excluded, with its bytes and reason', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, {
      tokensReasoning: 12, reasoning: true, reasoningError: true,
    });
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      const counts = sessionReasoningCounts(db, SESSION_ID);
      assert.equal(counts.parts, 0, 'the host drops the errored turn, reasoning included');
      assert.equal(counts.bytes, 0);
      assert.equal(counts.raw.parts, 1);
      assert.equal(counts.raw.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.excluded.parts, 1);
      assert.equal(counts.excluded.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.excluded.assistantError.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.excluded.reasoningIncomplete.bytes, 0);
      assert.equal(counts.excluded.breakdownConsistent, true);
      assert.equal(counts.excluded.reasons[0].reason, 'assistant-error');
      assert.equal(counts.excluded.reasons[0].seq, 1);
    } finally {
      db.close();
    }
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: join(dir, 'seed.db'),
    });
    assert.equal(seeded.ok, false);
    assert.match(seeded.refused, /0 reasoning parts the host would send/u);
    assert.match(seeded.refused, /raw 1 part\(s\)/u);
    assert.match(seeded.refused, /excluded 1 part\(s\)/u);
    assert.match(seeded.refused, /assistant-error/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 sendable: a reasoning part without time.completed is excluded', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, {
      tokensReasoning: 12, reasoning: true, reasoningIncomplete: true,
    });
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      const counts = sessionReasoningCounts(db, SESSION_ID);
      assert.equal(counts.parts, 0);
      assert.equal(counts.raw.parts, 1);
      assert.equal(counts.excluded.reasoningIncomplete.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.excluded.assistantError.bytes, 0);
      assert.equal(counts.excluded.reasons[0].reason, 'reasoning-incomplete');
    } finally {
      db.close();
    }
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: join(dir, 'seed.db'),
    });
    assert.equal(seeded.ok, false);
    assert.match(seeded.refused, /reasoning-incomplete/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: empty reasoning strings are refused, so the request-1 equality cannot be trivial', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 12, reasoning: true, reasoningText: '' });
    const target = join(dir, 'seed.db');
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: target,
    });
    assert.equal(seeded.ok, false, 'a part count of 1 with 0 bytes is not a reasoning subject');
    assert.match(seeded.refused, /0 reasoning bytes|an empty reasoning part/u);
    assert.match(seeded.refused, /no non-empty reasoning string/u);
    assert.match(seeded.refused, /ADR-0045/u);
    assert.equal(existsSync(target), false, 'a refused empty-reasoning seed wrote a database anyway');
    // The gate names both halves, so the same refusal is reachable on a copy.
    assert.deepEqual(reasoningSendableGate({ parts: 1, bytes: 0 }, { texts: [''] }), [
      '0 reasoning bytes: an empty reasoning part is not a measurement',
      'no non-empty reasoning string the request-1 set check can compare',
    ]);
    assert.deepEqual(reasoningSendableGate({ parts: 1, bytes: 4 }, { texts: ['gone'] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: a session with tokens_reasoning 0 is refused by name (ADR-0045)', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 0, reasoning: true });
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: SESSION_ID, targetDbPath: join(dir, 'seed.db'),
    });
    assert.equal(seeded.ok, false);
    assert.match(seeded.refused, /tokens_reasoning=0/u);
    assert.match(seeded.refused, /ADR-0045/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: an unknown session id is refused, never created', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 12, reasoning: true });
    const seeded = seedSessionDb({
      sourceDbPath: source, sessionId: 'ses_nope', targetDbPath: join(dir, 'seed.db'),
    });
    assert.equal(seeded.ok, false);
    assert.match(seeded.refused, /is not a session_v2 row/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: the reasoning count reads whichever of the two stores carries the parts', () => {
  const dir = tempDir();
  try {
    const source = makeSourceDb(dir, { tokensReasoning: 12, reasoning: true });
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      const counts = sessionReasoningCounts(db, SESSION_ID);
      assert.equal(counts.parts, 1);
      assert.equal(counts.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.raw.parts, 1);
      assert.equal(counts.raw.bytes, Buffer.byteLength(REASONING));
      assert.equal(counts.excluded.parts, 0);
      assert.equal(counts.excluded.bytes, 0);
      assert.equal(counts.excluded.breakdownConsistent, true);
      assert.equal(counts.store, 'session_message');
      assert.equal(counts.legacy.parts, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 seed: every session table in the copy list is keyed, and none is a credential', () => {
  const tables = [...REPLAY_SESSION_TABLES.map((row) => row.table)];
  assert.equal(tables.includes('credential'), false);
  assert.equal(tables.includes('account'), false);
  assert.equal(tables.includes('session_message'), true);
  assert.equal(tables.includes('part'), true);
  for (const row of REPLAY_SESSION_TABLES) assert.equal(typeof row.key, 'string');
});

/* ------------------------------------------------------------------ the mock route */

async function startMock(dir, scriptPath = OFFLINE_SCRIPT) {
  const portFile = join(dir, 'port.txt');
  const log = join(dir, 'requests.jsonl');
  const child = spawn(process.execPath, [
    MOCK, '--port', '0', '--port-file', portFile, '--log', log, '--script', scriptPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await waitForMockPort(child, portFile);
    return { child, port, log };
  } catch (error) {
    // The dead mock failed before its port file; do not leak the child.
    await stopMock(child);
    throw error;
  }
}

/**
 * ISSUE-505: the dead-child cases ISSUE-504 fixed in `opencode-run.test.mjs`.
 * A child that already exited has no future `close` event, so cleanup must
 * settle instead of waiting forever; the port wait must reject on the exit.
 */
test('mock: cleanup settles when the child exited before close was awaited (ISSUE-505)',
  async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await settlesWithin(new Promise((done) => child.once('close', done)), 5_000,
      'the fixture child never closed');
    assert.notEqual(child.exitCode, null, 'the child is dead before cleanup starts');
    await settlesWithin(stopMock(child), 2_000,
      'cleanup waited for a close event that had already fired');
  });

test('mock: a dead mock fails the port wait fast instead of sleeping out the deadline',
  async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [
      '-e', 'process.stderr.write("bind refused\\n", () => process.exit(2));',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await assert.rejects(
        settlesWithin(waitForMockPort(child, join(dir, 'port.txt'), 15_000), 3_000,
          'the port wait outlived the dead mock'),
        /exited before writing its port file \(code 2, signal null\): bind refused/u,
      );
    } finally {
      await settlesWithin(stopMock(child), 2_000, 'cleanup hung after the port wait');
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('195 mock: reasoning is streamed before content and the log records what was sent', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    mock = await startMock(dir);
    const body = JSON.stringify({
      model: 'mock-model',
      stream: true,
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
      messages: [
        { role: 'user', content: 'Read missing.txt; reply with exactly: DONE' },
        { role: 'assistant', content: 'earlier', reasoning_content: 'earlier thought' },
      ],
    });
    const response = await fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
      body,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const reasoningAt = text.indexOf('"reasoning_content"');
    const contentAt = text.indexOf('"content":"Reading the large file once."');
    assert.ok(reasoningAt >= 0, 'the mock emitted no reasoning frame');
    assert.ok(contentAt >= 0, 'the mock emitted no content frame');
    assert.ok(reasoningAt < contentAt, 'the reasoning frame must come before the content frame');

    const rows = readFileSync(mock.log, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const main = rows.find((row) => row.kind === 'main');
    assert.ok(main, 'no main request was logged');
    assert.equal(main.reasoning_messages, 1);
    assert.equal(main.reasoning_bytes, Buffer.byteLength('earlier thought'));
    assert.deepEqual(main.reasoning_fields, ['reasoning_content']);
    assert.equal(main.reply_reasoning_frames, 1);
    assert.ok(main.reply_reasoning_bytes > 0);
    assert.equal(typeof main.body_bytes, 'number');
    assert.equal(Array.isArray(main.message_roles), true);
    // The removal rule reads the body itself, not a count.
    assert.equal(Array.isArray(main.messages), true);
    assert.equal(main.messages.length, 2);
    assert.deepEqual(main.tool_call_ids, []);
    assert.deepEqual(main.receipt_recall_ids, []);
    assert.equal(main.tool_less_chat, false);
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 mock: main_turn lets a replay script name its turns, not a tool count', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    const byTurn = join(dir, 'by-turn.script.json');
    writeFileSync(byTurn, JSON.stringify({
      model: 'mock-model',
      title: 'by turn',
      replies: [
        { name: 'one', match: { main_turn: 0 }, reply: { type: 'text', text: 'ONE' } },
        { name: 'two', match: { main_turn: 1 }, reply: { type: 'text', text: 'TWO' } },
      ],
    }));
    mock = await startMock(dir, byTurn);
    const send = (messages) => fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
        messages,
      }),
    }).then((response) => response.text());
    // 40 tool results from a seeded history: the offline script's counts would
    // never match, and `main_turn` is what a replay script matches instead.
    const history = Array.from({ length: 40 }, (_, index) => ({ role: 'tool', content: `r${index}` }));
    await send([{ role: 'user', content: 'go' }, ...history]);
    await send([{ role: 'user', content: 'go' }, ...history, { role: 'tool', content: 'more' }]);
    const rows = readFileSync(mock.log, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)).filter((row) => row.kind === 'main');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.main_turn), [0, 1]);
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 script: the shipped offline script and the replay script both carry reasoning', () => {
  for (const file of [OFFLINE_SCRIPT, join(BENCH_DIR, 'opencode-replay.script.json')]) {
    const script = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(script.replies.length > 0, `${file} has no replies`);
    for (const entry of script.replies) {
      assert.equal(typeof entry.reply?.reasoning, 'string', `${file}/${entry.name} carries no reasoning`);
      assert.ok(entry.reply.reasoning.length > 0, `${file}/${entry.name} reasoning is empty`);
    }
  }
});

test('195 mock: a real bearer is refused with 401 and the log never stores it', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    mock = await startMock(dir);
    // A credential that is not the mock's dummy key — the shape a real key
    // reaching the loopback route would have. The server must refuse it, and the
    // log row must record presence and a length class, never the value.
    const realBearer = 'Bearer sk-live-real-key-that-must-never-be-logged';
    const response = await fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: realBearer },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
        messages: [{ role: 'user', content: 'go' }],
      }),
    });
    assert.equal(response.status, 401);
    const refused = await response.json();
    assert.match(refused.error.message, /dummy key/u);
    const logText = readFileSync(mock.log, 'utf8');
    assert.equal(logText.includes('sk-live-real-key-that-must-never-be-logged'), false,
      'the log stores no credential value');
    const rows = logText.split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].authorization, {
      present: true, lengthClass: 'long (32-63)', dummy: false,
    });
    assert.equal(rows[0].refusal, 'non-dummy-bearer');
    assert.equal(rows[0].matched_reply, null);
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('195 mock: a title request does not consume a main turn', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    mock = await startMock(dir);
    const post = (body) => fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
      body: JSON.stringify(body),
    }).then((response) => response.text());
    const tools = [{ type: 'function', function: { name: 'read', parameters: {} } }];
    // The host's own title prompt, tool-less: this is a title request.
    const title = await post({
      model: 'mock-model', stream: true, tools: [],
      messages: [{ role: 'user', content: TITLE_PROMPT_MARKER }],
    });
    assert.ok(title.length > 0);
    // The first main request must still match the script's main_turn 0 reply.
    // If the title consumed a turn, the offline script's first reply (matched on
    // main_turn 0) would be skipped and this request would be a no-match 500.
    const main = await post({
      model: 'mock-model', stream: true, tools,
      messages: [{ role: 'user', content: 'Read the large file once; reply with exactly: DONE' }],
    });
    assert.ok(main.length > 0);
    const rows = readFileSync(mock.log, 'utf8').split(/\r?\n/u)
      .filter((line) => line.length > 0).map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.kind), ['title', 'main']);
    assert.equal(rows[0].main_turn, null, 'a title is not a main turn');
    assert.equal(rows[1].main_turn, 0, 'the first main request is turn 0');
    assert.equal(rows[1].matched_reply, 'read-single-1');
    assert.equal(rows[1].refusal, undefined);
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ title vs compaction */

test('198 compaction: the host title prompt is the marker, a summary request is not', () => {
  assert.equal(TITLE_PROMPT_MARKER, 'Reply with only the title.');
  const firstMessage = { messages: [
    { role: 'system', content: 'You write session titles.' },
    { role: 'user', content: 'Here is the first message of the conversation:\n\n<message>\n'
      + 'read the big file\n</message>\n\nReply with only the title.' },
  ] };
  const conversation = { messages: [
    { role: 'user', content: [{ type: 'text',
      text: 'Here is the conversation so far:\n\n<conversation>\n…\n</conversation>\n\n'
        + 'Reply with only the title.' }] },
  ] };
  const compaction = { messages: [
    { role: 'system', content: 'You summarize conversations.' },
    { role: 'user', content: 'Summarize the conversation so far.' },
  ] };
  assert.equal(isTitleRequest(firstMessage), true);
  assert.equal(isTitleRequest(conversation), true);
  assert.equal(isTitleRequest(compaction), false);
  assert.equal(isTitleRequest({ messages: [] }), false);
  assert.equal(isTitleRequest(null), false);
  // The compaction prompt is its own shape, independent of the tool table.
  assert.ok(COMPACTION_PROMPT_MARKERS.length > 0);
  assert.equal(isCompactionRequest({ messages: [{ role: 'user',
    content: COMPACTION_PROMPT_MARKERS[0] }] }), true);
  assert.equal(isCompactionRequest({ messages: [{ role: 'user', content: 'read a file' }] }), false);
});

test('198 compaction: a compaction request that carries tools is still a compaction', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    mock = await startMock(dir);
    const response = await fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        // The tool table a main request would carry, plus the host's compaction
        // prompt. Having no tools is not what makes a request a compaction.
        tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
        messages: [
          { role: 'system', content: 'You summarize conversations.' },
          { role: 'user', content: COMPACTION_PROMPT_MARKERS[0] },
        ],
      }),
    });
    assert.equal(response.status, 500);
    const refusal = await response.json();
    assert.match(refusal.error.message, /compaction-request/u);
    const rows = readFileSync(mock.log, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'compaction');
    assert.equal(rows[0].compaction_prompt, true);
    assert.equal(rows[0].tool_less_chat, false, 'the tool table is present');
    assert.equal(rows[0].tools.length, 1);
    assert.equal(rows[0].matched_reply, null);
    assert.equal(rows[0].refusal, 'compaction-request');
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('198 compaction: a tool-less request without the title prompt is refused, never titled', async () => {
  const dir = tempDir();
  let mock = null;
  try {
    mock = await startMock(dir);
    const post = (messages) => fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY_KEY}` },
      body: JSON.stringify({ model: 'mock-model', stream: true, messages }),
    });
    // The host's title request: tool-less, and it carries the marker.
    const title = await post([{ role: 'user',
      content: 'Here is the first message of the conversation:\n\n<message>\nx\n</message>\n\n'
        + 'Reply with only the title.' }]);
    assert.equal(title.status, 200);
    // A compaction request: also tool-less, but the title prompt is absent.
    const compaction = await post([{ role: 'system', content: 'You summarize conversations.' },
      { role: 'user', content: 'Summarize the conversation so far.' }]);
    assert.equal(compaction.status, 500);
    const refusal = await compaction.json();
    assert.match(refusal.error.message, /compaction-request/u);

    const rows = readFileSync(mock.log, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.kind), ['title', 'compaction']);
    assert.deepEqual(rows.map((row) => row.tool_less_chat), [true, true]);
    assert.equal(rows[0].matched_reply, 'title');
    assert.equal(rows[1].matched_reply, null);
    assert.equal(rows[1].refusal, 'compaction-request');
  } finally {
    if (mock !== null) await stopMock(mock.child);
    rmSync(dir, { recursive: true, force: true });
  }
});
