import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEvent, SessionId } from '@cremator/core';
import {
  formatByteSize, preparedRemovedBytes, readAppliedRemovedBytes, sumAppliedRemovedBytes,
} from '../src/cremated-bytes.js';

const SESSION = 'session-1' as SessionId;

function prepared(intentId: string, removedBytes: number | undefined): LedgerEvent {
  const base = {
    kind: 'prepared', sessionId: SESSION, eventKey: 'prepared-' + intentId, atMs: 0,
    intentId, applicationSha256: 'sha',
  };
  const event = removedBytes === undefined ? base : { ...base, engine: { removedBytes } };
  return event as unknown as LedgerEvent;
}

function applied(intentId: string): LedgerEvent {
  return {
    kind: 'applied', sessionId: SESSION, eventKey: 'applied-' + intentId, atMs: 0,
    receipt: {
      intentId, sessionId: SESSION, baseRevision: 0, resultRevision: 1,
      applicationSha256: 'sha', appliedAtMs: 0,
    },
  } as unknown as LedgerEvent;
}

function abandoned(intentId: string): LedgerEvent {
  return {
    kind: 'abandoned', sessionId: SESSION, eventKey: 'abandoned-' + intentId, atMs: 0,
    intentId, reason: 'refused',
  } as unknown as LedgerEvent;
}

test('sums removedBytes for applied intents only', () => {
  const events = [prepared('a', 100), prepared('b', 250), applied('a'), applied('b')];
  assert.equal(sumAppliedRemovedBytes(events.map(event => ({ event }))), 350);
});

test('a prepared intent that was abandoned removed nothing', () => {
  const events = [prepared('a', 4096), abandoned('a'), applied('b'), prepared('b', 10)];
  assert.equal(sumAppliedRemovedBytes(events.map(event => ({ event }))), 10);
});

test('an applied intent without a prepared byte count adds nothing', () => {
  assert.equal(sumAppliedRemovedBytes([applied('missing')].map(event => ({ event }))), 0);
});

test('a malformed engine block is unknown, not zero-bytes evidence', () => {
  assert.equal(preparedRemovedBytes(prepared('a', undefined)), null);
  assert.equal(preparedRemovedBytes(prepared('b', -1)), null);
  assert.equal(sumAppliedRemovedBytes([prepared('c', 2048), applied('c')].map(event => ({ event }))), 2048);
});

test('reads the ledger asynchronously and sums only applied removals', async () => {
  const rows = [prepared('a', 512), prepared('b', 24), applied('a'), abandoned('b')];
  const ledger = {
    async *events() {
      for (const event of rows) yield { sequence: 0, event };
    },
  };
  assert.equal(await readAppliedRemovedBytes(ledger, SESSION), 512);
});

test('formats human byte sizes without losing the small cases', () => {
  assert.equal(formatByteSize(0), '0 B');
  assert.equal(formatByteSize(1), '1 B');
  assert.equal(formatByteSize(1023), '1023 B');
  assert.equal(formatByteSize(1024), '1 KB');
  assert.equal(formatByteSize(1536), '1.5 KB');
  assert.equal(formatByteSize(842 * 1024), '842 KB');
  assert.equal(formatByteSize(1258291), '1.2 MB');
  assert.equal(formatByteSize(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(formatByteSize(1048570), '1 MB');
});

test('non-finite or negative sizes are a display failure, never a throw', () => {
  assert.equal(formatByteSize(-1), '-');
  assert.equal(formatByteSize(Number.NaN), '-');
  assert.equal(formatByteSize(Number.POSITIVE_INFINITY), '-');
});
