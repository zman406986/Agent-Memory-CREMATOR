// The round-manifest enforcement record (ISSUE-265).
//
// `result.json` must say which manifest blocks bound the launch and which stayed
// informational. The launcher's gates are the brief hash, the arm image and the
// deliverable count; the per-record read sets and projections are not compared.
// The record states exactly the fields the gate compared: a brief without
// `taskBlockBytes` is not claimed as enforced (ISSUE-494).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestEnforcementRecord, manifestTaskGate } from './manifest-gate.mjs';

test('no manifest: the record says absent and enforces nothing', () => {
  const record = manifestEnforcementRecord({ manifest: null });
  assert.equal(record.present, false);
  assert.deepEqual(record.enforced, []);
  assert.match(record.readSets, /not compared/u);
  assert.ok(record.notEnforced.some(line => line.startsWith('tasks')));
});

test('a full manifest names each enforced block and each unenforced one', () => {
  const record = manifestEnforcementRecord({
    // Both brief fields are named, so both are enforced and listed: the record
    // lists `taskBlockBytes` only when the brief carries it (ISSUE-494).
    manifest: {
      brief: { taskSha256: 'a'.repeat(64), taskBlockBytes: 9329 },
      image: { digest: 'a'.repeat(64) },
      deliverables: { count: 48 },
    },
  });
  assert.equal(record.present, true);
  assert.deepEqual(record.enforced, [
    'brief.taskSha256', 'brief.taskBlockBytes', 'deliverables.count', 'image.digest',
  ]);
  for (const name of ['tasks', 'totals', 'windowProjection', 'dist', 'provenance', 'expectedFiresNote']) {
    assert.ok(record.notEnforced.some(line => line.startsWith(name)), `${name} must be named unenforced`);
  }
  assert.equal(record.skipped, undefined);
});

test('a manifest without a deliverables or brief block does not claim to enforce it', () => {
  const record = manifestEnforcementRecord({ manifest: { image: { digest: 'a'.repeat(64) } } });
  assert.deepEqual(record.enforced, ['image.digest']);
});

test('a brief without taskBlockBytes: the gate does not compare it, so the record does not list it (ISSUE-494)', () => {
  const sha = 'a'.repeat(64);
  const manifest = {
    brief: { taskSha256: sha },
    image: { digest: 'b'.repeat(64) },
    deliverables: { count: 48 },
  };
  // The gate compares the sha256 and passes; no taskBlockBytes comparison runs,
  // whatever the task's character count is.
  const gate = manifestTaskGate({ manifest, taskSha256: sha, taskChars: 25199, armMultiset: 'b'.repeat(64) });
  assert.equal(gate.ok, true);
  assert.equal(gate.skipped, undefined);

  const record = manifestEnforcementRecord({ manifest });
  assert.deepEqual(record.enforced, ['brief.taskSha256', 'deliverables.count', 'image.digest'],
    'a comparison that never ran is not claimed as enforced');
});

test('a brief with taskBlockBytes: the gate compares it and the record lists it (ISSUE-494)', () => {
  const sha = 'a'.repeat(64);
  const manifest = {
    brief: { taskSha256: sha, taskBlockBytes: 25199 },
    image: { digest: 'b'.repeat(64) },
    deliverables: { count: 48 },
  };
  const record = manifestEnforcementRecord({ manifest });
  assert.deepEqual(record.enforced, [
    'brief.taskSha256', 'brief.taskBlockBytes', 'deliverables.count', 'image.digest',
  ]);
  const mismatch = manifestTaskGate({
    manifest, taskSha256: sha, taskChars: 25200, armMultiset: 'b'.repeat(64),
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /taskBlockBytes/u);
});

test('a resume round skips the brief and arm-tree gates by name', () => {
  const record = manifestEnforcementRecord({
    manifest: { brief: {}, image: { digest: 'a'.repeat(64) }, deliverables: { count: 4 } },
    resume: true,
  });
  assert.deepEqual(record.enforced, []);
  assert.match(record.skipped, /resume round/u);
});
