// ADR-0076 / ISSUE-604: the saved last request. The sidecar lives beside the
// session ledger, publishes atomically, and refuses a present file by name
// while an absent file is the ordinary fresh-session answer.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  REQUEST_SNAPSHOT_FILE, readRequestSnapshot, requestSnapshotPath, writeRequestSnapshot,
} from '../src/request-snapshot.js';
import { resolveStorage, sessionStorage } from '../src/storage.js';
import type { StorageTarget } from '../src/storage.js';
import { sessionId, text, userMessage } from './fixtures.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-request-'));
}

function durableTarget(dir: string): StorageTarget {
  return sessionStorage(
    resolveStorage({ crematorStorageRoot: join(dir, 'store') }), sessionId);
}

function snapshotPath(target: StorageTarget): string {
  const path = requestSnapshotPath(target);
  assert.ok(path !== null, 'a durable target has a session directory');
  return path;
}

test('the save sits beside the ledger and round-trips the array', () => {
  const dir = scratch();
  try {
    const target = durableTarget(dir);
    const path = snapshotPath(target);
    assert.equal(path, join(dirname(target.databasePath), REQUEST_SNAPSHOT_FILE));
    const messages = [
      userMessage('msg_u1', [text('hello')]),
      userMessage('msg_u2', [text('again')]),
    ];
    const written = writeRequestSnapshot(path, {
      sessionId, revision: 'oc:1:abc', atMs: 1234, messages,
    });
    assert.equal(written.ok, true);
    if (written.ok) assert.ok(written.bytes > 0, 'the published payload has bytes');

    const read = readRequestSnapshot(path, sessionId);
    assert.equal(read.rejected, undefined, 'a readable save is not refused');
    assert.deepEqual(read.snapshot?.messages, messages);
    assert.equal(read.snapshot?.revision, 'oc:1:abc');
    assert.equal(read.snapshot?.atMs, 1234);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absent save is empty, never a refusal', () => {
  const dir = scratch();
  try {
    const read = readRequestSnapshot(snapshotPath(durableTarget(dir)), sessionId);
    assert.deepEqual(read, { snapshot: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt save is refused by name', () => {
  const dir = scratch();
  try {
    const path = snapshotPath(durableTarget(dir));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json', 'utf8');
    const read = readRequestSnapshot(path, sessionId);
    assert.equal(read.snapshot, null);
    assert.match(String(read.rejected), /not valid JSON/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('another version is refused, not read as an empty request', () => {
  const dir = scratch();
  try {
    const path = snapshotPath(durableTarget(dir));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, sessionId, atMs: 1,
      revision: null, messages: [userMessage('msg_u1', [text('hi')])] }), 'utf8');
    const read = readRequestSnapshot(path, sessionId);
    assert.equal(read.snapshot, null);
    assert.match(String(read.rejected), /version/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save naming another session is refused', () => {
  const dir = scratch();
  try {
    const path = snapshotPath(durableTarget(dir));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: 'ses_other', atMs: 1,
      revision: null, messages: [userMessage('msg_u1', [text('hi')])] }), 'utf8');
    const read = readRequestSnapshot(path, sessionId);
    assert.equal(read.snapshot, null);
    assert.match(String(read.rejected), /another session/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed message refuses the whole save', () => {
  const dir = scratch();
  try {
    const path = snapshotPath(durableTarget(dir));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, sessionId, atMs: 1, revision: null,
      messages: [{ role: 'user', content: 'not a part list' }] }), 'utf8');
    const read = readRequestSnapshot(path, sessionId);
    assert.equal(read.snapshot, null);
    assert.match(String(read.rejected), /malformed message/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a memory target has no save and both calls are no-ops', () => {
  const target = sessionStorage(resolveStorage({ databasePath: ':memory:' }), sessionId);
  const path = requestSnapshotPath(target);
  assert.equal(path, null);
  const written = writeRequestSnapshot(path, {
    sessionId, revision: null, atMs: 1, messages: [userMessage('msg_u1', [text('hi')])],
  });
  assert.deepEqual(written, { ok: true, bytes: 0 });
  assert.deepEqual(readRequestSnapshot(path, sessionId), { snapshot: null });
});
