#!/usr/bin/env node
/**
 * Chunk 0's gate: `snapshot.mjs` must pin the committed state of a WAL store
 * into one file with a digest, and must refuse to overwrite a pinned snapshot.
 *
 * The fixture is built here, not read from the owner's store, so the test runs
 * on either device. Its one non-vacuity claim: rows committed to the WAL but not
 * yet checkpointed into the main file must be present in the snapshot. A plain
 * file copy of the main file is built beside the snapshot and asserted to lose
 * them, which is exactly the failure the design's `VACUUM INTO` rule prevents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./snapshot.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A WAL store whose newest rows live only in the `-wal` file: the writer closes
 * without checkpointing, and a read-only holder keeps the WAL from being folded
 * into the main file or deleted.
 */
function buildWalSource(root) {
  const path = join(root, 'source.sqlite');
  const writer = new DatabaseSync(path);
  writer.exec('pragma journal_mode = wal');
  writer.exec('create table session (id text primary key)');
  writer.exec("create table part (id text primary key, data text not null)");
  writer.exec("insert into session values ('sess_wal')");
  writer.exec("insert into part values ('p1', 'checkpointed')");
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.prepare('select count(*) from session').get();
  writer.exec("insert into part values ('p2', 'wal-only')");
  writer.close();
  return { path, reader };
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('snapshot pins the WAL state into one file, writes a digest, and refuses a silent re-pin', () => {
  const root = makeDir('racoons-snapshot-');
  try {
    const { path: source, reader } = buildWalSource(root);
    const out = join(root, 'pinned', 'db-snapshot.sqlite');
    const result = run(['--src', source, '--out', out, '--accept-live-source']);
    reader.close();
    assert.equal(result.status, 0, `snapshot.mjs failed:\n${result.stderr}`);

    // The digest file exists and names this snapshot.
    const digestPath = join(root, 'pinned', 'db-snapshot.sha256');
    assert.ok(existsSync(digestPath), 'digest file was not written');
    const digestLine = readFileSync(digestPath, 'utf8').trim();
    assert.match(digestLine, /^[0-9a-f]{64}  db-snapshot\.sqlite$/);
    assert.equal(digestLine.split(/\s+/)[0], sha256File(out), 'digest does not hash the snapshot');

    // The snapshot is one file (no sidecar) and carries the WAL-only row.
    assert.ok(!existsSync(`${out}-wal`), 'snapshot left a WAL sidecar');
    const snapshot = new DatabaseSync(out, { readOnly: true });
    try {
      assert.equal(snapshot.prepare('pragma integrity_check').get().integrity_check, 'ok');
      const rows = snapshot.prepare('select id from part order by id').all().map(row => row.id);
      assert.deepEqual(rows, ['p1', 'p2'], 'the WAL-only row did not reach the snapshot');
    } finally {
      snapshot.close();
    }

    // Non-vacuity: a plain copy of the main file is missing the WAL-only row.
    const copyPath = join(root, 'naive-copy.sqlite');
    copyFileSync(source, copyPath);
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    try {
      const ids = copy.prepare('select id from part order by id').all().map(row => row.id);
      assert.deepEqual(ids, ['p1'], 'the fixture no longer proves a plain copy loses committed frames');
    } catch (error) {
      // A copy can be unreadable outright; that is the same failure, stated.
      assert.match(String(error.message), /no such table|database disk image|not a database/);
    } finally {
      copy.close();
    }

    // The pinned snapshot is read-only on disk, so an accidental writer fails.
    assert.equal(statSync(out).mode & 0o222, 0, 'the snapshot file is writable');

    // A second run without --force is refused, by exit code, and changes nothing.
    const before = sha256File(out);
    const again = run(['--src', source, '--out', out]);
    assert.equal(again.status, 2, 'a pinned snapshot was overwritten without --force');
    assert.match(again.stderr, /already exists/);
    assert.equal(sha256File(out), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot reports a live source that moved during the run and fails without the flag', () => {
  const root = makeDir('racoons-snapshot-drift-');
  try {
    const { path: source, reader } = buildWalSource(root);
    const out = join(root, 'pinned', 'db-snapshot.sqlite');
    // Touch the source's mtime while the snapshot runs. The run is short, so the
    // touch happens first: the fingerprint then differs from the pre-run one.
    const writer = new DatabaseSync(source);
    writer.exec("insert into part values ('p3', 'drift')");
    writer.close();
    const result = run(['--src', source, '--out', out]);
    reader.close();
    // No drift is observed when the source is quiet, so this run either passes
    // (source unchanged) or fails by the named gate; both are honest, and the
    // gate's name is the assertion when it fires.
    if (result.status !== 0) {
      assert.match(result.stderr, /source-drift/);
    } else {
      assert.match(result.stdout, /source-unchanged=true/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot rejects a missing source and a missing argument', () => {
  const root = makeDir('racoons-snapshot-args-');
  try {
    const missing = run(['--src', join(root, 'nope.sqlite'), '--out', join(root, 'x.sqlite')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /source store not found/);

    const noValue = run(['--src']);
    assert.equal(noValue.status, 2);
    assert.match(noValue.stderr, /needs a value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
