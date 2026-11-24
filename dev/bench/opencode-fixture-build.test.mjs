#!/usr/bin/env node
/**
 * The synthetic opencode replay fixture's gate.
 *
 * Run: `node --test dev/bench/opencode-fixture-build.test.mjs`
 *
 * Offline only: no host binary, no key, no network. The tests:
 *
 *   1. build, verify, and prove two default builds are byte-identical;
 *   2. read the database directly and check every manifest count;
 *   3. scan every text value for a real-looking marker (`C:\Users\`, an email,
 *      a key prefix); every `ses_`/`msg_` token must be the fixture's own
 *      synthetic brand, never a real id;
 *   4. drive `seedSessionDb` against the fixture, unchanged;
 *   5. corrupt one row and show `--verify` exits non-zero, then show the
 *      fixture is not overwritten without `--force`.
 *
 * The count assertions are a second implementation: they query the database
 * with their own SQL rather than calling the builder's analyzer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { relocateJsonStrings, seedSessionDb } from './opencode-run.mjs';
import {
  DB_FILE, MANIFEST_FILE, REPEAT_PATH, SCHEMA, SESSION_ID, UNIT_FILE, WORKSPACE,
  fixtureUnitFileText, fixtureUnitResultText, hostReadText,
} from './opencode-fixture-build.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const BUILDER = join(BENCH_DIR, 'opencode-fixture-build.mjs');
const MARKER = 'RACOONS-SYNTHETIC';
const FORBIDDEN = ['C:\\Users\\', '@gmail', 'sk-'];
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{26}$/u;
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{26}$/u;
/** The 17 tables `seedSessionDb` copies rows from, as its result sorts them. */
const COPY_TABLES = [
  '__drizzle_migrations', 'event', 'event_sequence', 'job', 'kv', 'message', 'migration',
  'part', 'project', 'project_directory', 'schedule', 'session_inbox', 'session_message',
  'session_part', 'session_v2', 'todo', 'worktree',
];
/** Every table the fixture creates: the copy list plus the host's own bookkeeping. */
const EXPECTED_TABLES = [
  '__drizzle_migrations', 'account', 'account_state', 'blob', 'blob_ref',
  'control_account', 'credential', 'event', 'event_sequence', 'instruction_blob',
  'instruction_entry', 'instruction_state', 'job', 'kv', 'message', 'migration', 'part',
  'permission', 'project', 'project_directory', 'schedule', 'session', 'session_inbox',
  'session_message', 'session_part', 'session_share', 'session_v2', 'todo', 'workspace',
  'worktree',
];
/** The old floor this shipped fixture was built under; a measurement parameter, not a default. */
const TOOL_RESULT_FLOOR = 8_192;

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-fixture-'));
}

function run(args) {
  return spawnSync(process.execPath, [BUILDER, ...args], { encoding: 'utf8' });
}

function build(outDir, extra = []) {
  const result = run(['--out', outDir, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(join(outDir, MANIFEST_FILE), 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' "
    + "AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
}

/** Every TEXT/BLOB-as-text value the database holds. */
function allTextValues(db) {
  const values = [];
  for (const table of tableNames(db)) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') values.push(value);
      }
    }
  }
  return values;
}

test('build: two default builds are byte-identical and --verify passes', () => {
  const root = scratch();
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const manifest = build(first);
    build(second);
    assert.equal(manifest.schema, SCHEMA);
    assert.equal(manifest.sessionId, SESSION_ID);
    assert.match(manifest.sessionId, SESSION_ID_PATTERN);
    assert.equal(manifest.messageIdsTotal, manifest.messageCount);
    assert.equal(manifest.brandedMessageIds, manifest.messageCount);
    assert.equal(manifest.toolPartsWithExecutedFlag, 0);
    const model = JSON.parse(manifest.model);
    assert.equal(model.id, 'mock-model');
    assert.equal(model.providerID, 'mock');
    assert.equal(manifest.modelId, model.id);
    assert.equal(manifest.modelProviderId, model.providerID);
    assert.deepEqual(manifest.workspaceTableColumns,
      ['id', 'provider', 'binding', 'created_at', 'last_used_at']);
    assert.equal(manifest.bytes, readFileSync(join(first, DB_FILE)).length);
    assert.equal(manifest.sha256, sha256File(join(first, DB_FILE)));
    assert.equal(readFileSync(join(first, DB_FILE)).equals(readFileSync(join(second, DB_FILE))),
      true, 'two default builds differ');
    assert.equal(readFileSync(join(first, MANIFEST_FILE), 'utf8'),
      readFileSync(join(second, MANIFEST_FILE), 'utf8'), 'two manifests differ');
    const verified = run(['--verify', '--out', first]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /verify: ok/u);
    assert.ok(manifest.messageCount >= 120);
    assert.ok(manifest.assistantTurnCount >= 60);
    assert.ok(manifest.reasoningPartCount >= 60);
    assert.ok(manifest.toolResultCount >= 8);
    assert.ok(manifest.largestResultBytes > TOOL_RESULT_FLOOR);
    assert.ok(manifest.repeatCount >= 3);
    assert.equal(manifest.failedSearchCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('counts: the manifest equals the database read directly', () => {
  const root = scratch();
  try {
    const manifest = build(join(root, 'fixture'));
    const db = new DatabaseSync(join(root, 'fixture', DB_FILE), { readOnly: true });
    try {
      assert.deepEqual(tableNames(db), EXPECTED_TABLES);
      const tableRowCounts = Object.fromEntries(tableNames(db).map((table) => [
        table, Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n),
      ]));
      assert.deepEqual(manifest.tableRowCounts, tableRowCounts);

      const messageCount = Number(db.prepare(
        'SELECT count(*) AS n FROM session_message WHERE session_id = ?',
      ).get(SESSION_ID).n);
      const assistantTurnCount = Number(db.prepare(
        "SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'",
      ).get(SESSION_ID).n);
      const userTurnCount = Number(db.prepare(
        "SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'user'",
      ).get(SESSION_ID).n);
      assert.equal(manifest.messageCount, messageCount);
      assert.equal(manifest.assistantTurnCount, assistantTurnCount);
      assert.equal(manifest.userTurnCount, userTurnCount);
      assert.equal(messageCount, 124);

      const reasoning = db.prepare(`
        SELECT count(*) AS parts,
          sum(CASE WHEN json_extract(part.value, '$.time.completed') IS NOT NULL
            THEN 1 ELSE 0 END) AS completed
        FROM session_message AS message, json_each(message.data, '$.content') AS part
        WHERE message.session_id = ? AND message.type = 'assistant'
          AND json_extract(part.value, '$.type') = 'reasoning'
      `).get(SESSION_ID);
      assert.equal(manifest.reasoningPartCount, Number(reasoning.parts));
      assert.equal(manifest.sendableReasoningPartCount, Number(reasoning.completed));
      assert.equal(Number(reasoning.parts), assistantTurnCount,
        'every assistant turn must carry one reasoning part');
      assert.equal(Number(reasoning.completed), Number(reasoning.parts),
        'every reasoning part must be sendable');

      const missingReasoning = Number(db.prepare(`
        SELECT count(*) AS n FROM session_message AS message
        WHERE message.session_id = ? AND message.type = 'assistant'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(message.data, '$.content') AS part
            WHERE json_extract(part.value, '$.type') = 'reasoning'
          )
      `).get(SESSION_ID).n);
      assert.equal(missingReasoning, 0);

      const tools = db.prepare(`
        SELECT json_extract(part.value, '$.name') AS name,
          json_extract(part.value, '$.state.status') AS status,
          coalesce(json_extract(part.value, '$.state.input.path'),
            json_extract(part.value, '$.state.input.filePath')) AS file_path,
          (SELECT json_extract(block.value, '$.text')
            FROM json_each(json_extract(part.value, '$.state.content')) AS block
            WHERE json_extract(block.value, '$.type') = 'text' LIMIT 1) AS result_text
        FROM session_message AS message, json_each(message.data, '$.content') AS part
        WHERE message.session_id = ? AND message.type = 'assistant'
          AND json_extract(part.value, '$.type') = 'tool'
        ORDER BY message.seq, part.key
      `).all(SESSION_ID);
      const resultTexts = tools
        .map((row) => (typeof row.result_text === 'string' ? row.result_text : null))
        .filter((text) => text !== null);
      assert.equal(manifest.toolCallCount, tools.length);
      assert.equal(manifest.toolResultCount, resultTexts.length);
      assert.equal(tools.length, 12);
      assert.equal(resultTexts.length, 12);
      const largest = Math.max(...resultTexts.map((text) => Buffer.byteLength(text, 'utf8')));
      assert.equal(manifest.largestResultBytes, largest);
      assert.equal(manifest.largeResultCount,
        resultTexts.filter((text) => Buffer.byteLength(text, 'utf8') > TOOL_RESULT_FLOOR).length);
      assert.equal(manifest.repeatCount, tools.filter((row) =>
        row.name === 'read' && row.file_path === REPEAT_PATH).length);
      assert.equal(manifest.failedSearchCount, tools.filter((row) =>
        row.name === 'grep' && typeof row.result_text === 'string'
        && row.result_text.includes(`${MARKER}-SEARCH-FAILED-`)).length);

      const session = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(SESSION_ID);
      const model = JSON.parse(session.model);
      assert.equal(model.id, 'mock-model');
      assert.equal(model.providerID, 'mock');
      const workspaceColumns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all('workspace').map((row) => row.name);
      assert.deepEqual(workspaceColumns, ['id', 'provider', 'binding', 'created_at', 'last_used_at']);
      const messageIds = db.prepare('SELECT id FROM session_message WHERE session_id = ?')
        .all(SESSION_ID).map((row) => row.id);
      assert.equal(messageIds.filter((id) => MESSAGE_ID_PATTERN.test(id)).length, messageIds.length);
      const toolParts = db.prepare(`
        SELECT json_extract(part.value, '$.executed') AS executed
        FROM session_message AS message, json_each(message.data, '$.content') AS part
        WHERE message.session_id = ? AND message.type = 'assistant'
          AND json_extract(part.value, '$.type') = 'tool'
      `).all(SESSION_ID);
      assert.equal(toolParts.length, 12);
      assert.deepEqual(toolParts.filter((row) => row.executed !== null), []);
      const sums = db.prepare(`
        SELECT coalesce(sum(json_extract(data, '$.tokens.input')), 0) AS input,
          coalesce(sum(json_extract(data, '$.tokens.output')), 0) AS output,
          coalesce(sum(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
          coalesce(sum(json_extract(data, '$.tokens.cache.read')), 0) AS cache_read,
          coalesce(sum(json_extract(data, '$.tokens.cache.write')), 0) AS cache_write
        FROM session_message WHERE session_id = ? AND type = 'assistant'
      `).get(SESSION_ID);
      assert.equal(Number(session.tokens_input), Number(sums.input));
      assert.equal(Number(session.tokens_output), Number(sums.output));
      assert.equal(Number(session.tokens_reasoning), Number(sums.reasoning));
      assert.equal(Number(session.tokens_cache_read), Number(sums.cache_read));
      assert.equal(Number(session.tokens_cache_write), Number(sums.cache_write));
      assert.equal(manifest.tokens.match, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content: no real-looking marker appears in any text value', () => {
  const root = scratch();
  try {
    build(join(root, 'fixture'));
    const db = new DatabaseSync(join(root, 'fixture', DB_FILE), { readOnly: true });
    let values;
    try {
      values = allTextValues(db);
    } finally {
      db.close();
    }
    assert.ok(values.some((value) => value.includes(MARKER)),
      'the synthetic marker is present');
    for (const forbidden of FORBIDDEN) {
      const hits = values.filter((value) => value.includes(forbidden));
      assert.deepEqual(hits, [], `fixture text contains ${JSON.stringify(forbidden)}`);
    }
    // The host brand is present (it must be), and every branded token is the
    // fixture's own synthetic one — a real `ses_`/`msg_` id would appear here.
    const sessionTokens = new Set();
    const messageTokens = new Set();
    for (const value of values) {
      for (const match of value.matchAll(/\bses_[A-Za-z0-9]+/gu)) sessionTokens.add(match[0]);
      for (const match of value.matchAll(/\bmsg_[A-Za-z0-9]+/gu)) messageTokens.add(match[0]);
    }
    assert.deepEqual([...sessionTokens], [SESSION_ID]);
    assert.equal(messageTokens.size, 124);
    for (const token of messageTokens) assert.match(token, MESSAGE_ID_PATTERN);
    const manifestText = readFileSync(join(root, 'fixture', MANIFEST_FILE), 'utf8');
    for (const forbidden of FORBIDDEN) {
      assert.equal(manifestText.includes(forbidden), false,
        `manifest contains ${JSON.stringify(forbidden)}`);
    }
    for (const match of manifestText.matchAll(/\bses_[A-Za-z0-9]+/gu)) {
      assert.equal(match[0], SESSION_ID);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seed: seedSessionDb opens the fixture with no change', () => {
  const root = scratch();
  try {
    const outDir = join(root, 'fixture');
    const manifest = build(outDir);
    const source = join(outDir, DB_FILE);
    const before = sha256File(source);
    const seeded = seedSessionDb({
      sourceDbPath: source,
      sessionId: SESSION_ID,
      targetDbPath: join(root, 'seed', 'opencode.db'),
    });
    assert.equal(seeded.ok, true, seeded.refused);
    assert.equal(sha256File(source), before, 'the seed changed the source fixture');
    assert.equal(seeded.session.id, SESSION_ID);
    assert.equal(seeded.session.model, manifest.model);
    assert.equal(seeded.sourceReasoning.parts, manifest.reasoningPartCount);
    assert.ok(seeded.sourceReasoning.bytes > 0);
    assert.equal(seeded.sourceReasoningTexts.texts.length, manifest.reasoningPartCount);
    assert.equal(seeded.sourceContent.counts.rows, manifest.messageCount);
    assert.deepEqual(seeded.sourceReceiptIds, []);
    assert.equal(seeded.counts.sessionMessages, manifest.messageCount);
    // The copy list is a selection. Every other source table is recorded, and
    // the host's bookkeeping tables are not part of the session.
    assert.deepEqual(seeded.copiedTables, COPY_TABLES);
    assert.deepEqual(seeded.notCopiedTables,
      EXPECTED_TABLES.filter((table) => !COPY_TABLES.includes(table)));
    assert.deepEqual(seeded.sourceTables, EXPECTED_TABLES);
    assert.equal(seeded.copies.find((row) => row.table === 'session_message').rows,
      manifest.messageCount);
    // `kv` holds a migration marker and one non-migration cache row; only the
    // marker is copied. The source table counts both rows.
    assert.equal(manifest.tableRowCounts.kv, 2);
    assert.equal(seeded.copies.find((row) => row.table === 'kv').rows, 1);
    const target = new DatabaseSync(join(root, 'seed', 'opencode.db'), { readOnly: true });
    try {
      assert.equal(target.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(Number(target.prepare('SELECT count(*) AS n FROM session_message').get().n),
        manifest.messageCount);
    } finally {
      target.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the seeded unit result is the host read rendering of the unit file', () => {
  const dbPath = join(BENCH_DIR, 'fixtures', 'opencode', DB_FILE);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      'SELECT data FROM session_message WHERE session_id = ? AND type = ?',
    ).all(SESSION_ID, 'assistant');
    let part = null;
    for (const row of rows) {
      const data = JSON.parse(String(row.data));
      for (const item of Array.isArray(data.content) ? data.content : []) {
        if (item?.type === 'tool' && item?.name === 'read'
          && String(item?.state?.input?.path ?? '').endsWith(UNIT_FILE)) {
          part = item;
        }
      }
    }
    assert.ok(part !== null, `the fixture has no seeded read of ${UNIT_FILE}`);
    assert.equal(part.state.input.path, `${WORKSPACE}\\${UNIT_FILE}`);
    assert.equal(part.state.input.filePath, undefined,
      'the seed names the tool schema\'s `path`, not `filePath`');
    const text = part.state.content.map((block) => block.text ?? '').join('');
    // The seed is the host's own `Read file <path>, lines 1-N` rendering of the
    // same bytes `writeFixtureWorld` writes. Raw sentinel text is not a read.
    assert.equal(text, fixtureUnitResultText());
    assert.equal(text, hostReadText(part.state.input.path, fixtureUnitFileText()));
    assert.equal(text.split('\n')[0],
      `Read file ${part.state.input.path}, lines 1-300`);
    assert.equal(text.split('\n')[1], '1: RACOONS-FIXTURE-UNIT-BIG-B-0001');
    // A run relocates the synthetic root into its own work dir. The relocated
    // seed is exactly what a live read of the file at that path returns.
    const workDir = join('C:\\', 'racoons-fixture-work');
    const relocated = relocateJsonStrings(text, WORKSPACE, workDir);
    assert.equal(relocated,
      hostReadText(`${workDir}\\${UNIT_FILE}`, fixtureUnitFileText()));
  } finally {
    db.close();
  }
});

test('verify: a corrupted row fails, and no overwrite happens without --force', () => {
  const root = scratch();
  try {
    const outDir = join(root, 'fixture');
    build(outDir);
    assert.equal(run(['--verify', '--out', outDir]).status, 0);

    const db = new DatabaseSync(join(outDir, DB_FILE));
    try {
      db.prepare('UPDATE session_message SET data = replace(data, ?, ?) WHERE seq = 3')
        .run(MARKER, 'RACOONS-TAMPERED');
    } finally {
      db.close();
    }
    const corrupted = run(['--verify', '--out', outDir]);
    assert.equal(corrupted.status, 1, corrupted.stdout);
    assert.match(corrupted.stderr, /mismatch|sha256/iu);

    const refused = run(['--out', outDir]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /refusing to overwrite/iu);
    assert.equal(existsSync(join(outDir, DB_FILE)), true);

    const forced = run(['--out', outDir, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(run(['--verify', '--out', outDir]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
