/**
 * Rig wrapper self-tests.
 *
 * The mount's seams (host-event mapping, cap/seal publication, the S7 failure
 * rule, `session/event` never appending) are product code now and are tested in
 * `packages/adapters/dsh/test/plugin.test.ts`. This file tests only what the rig
 * owns: loading the compiled entry through `CREMATOR_RIG_DIST`, splitting the
 * rig's flat config, routing the journal to the evidence file, and opening the
 * rig's file-backed ledger so a later process can recall from it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDist, importRuntime } from './build-dist.mjs';
import {
  EVIDENCE_FILE, RIG_PLUGIN_CONFIG_KEYS, apply, inject, loadShippedPlugin, name,
  sessionLedgerPaths, splitRigConfig,
} from './rig-plugin.mjs';

const DIST = ensureDist({ quiet: true }).dir;
const runtime = await importRuntime(DIST);
assert.equal(typeof runtime.SqliteLedger, 'function');

function scratch() {
  return mkdtempSync(join(tmpdir(), 'racoons-rig-wrap-'));
}

function cleanup(dir) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  throw new Error(`could not remove scratch dir ${dir}`);
}

/** The host event order is irrelevant to these tests; only freezing is modelled. */
function fakeCtx() {
  const listeners = new Map();
  const cleanups = [];
  return {
    cleanups,
    listeners,
    ctx: {
      logger: { warn: () => {} },
      on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
      effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
    },
  };
}

test('the wrapper declares the shipped entry name and injection', () => {
  assert.equal(name, 'racoons');
  assert.deepEqual(inject, ['llm', 'sessions']);
});

test('loadShippedPlugin refuses without CREMATOR_RIG_DIST', async () => {
  await assert.rejects(loadShippedPlugin(undefined), /CREMATOR_RIG_DIST is not set/u);
  await assert.rejects(loadShippedPlugin(''), /CREMATOR_RIG_DIST is not set/u);
});

test('the compiled entry exports createRacoonsPlugin', async () => {
  const loaded = await loadShippedPlugin(DIST);
  assert.equal(typeof loaded.createRacoonsPlugin, 'function');
  assert.equal(typeof loaded.core.RacoonsEngine, 'function');
  const plugin = loaded.createRacoonsPlugin({});
  assert.equal(plugin.name, 'cremator');
  assert.deepEqual(plugin.inject, ['llm', 'sessions', 'commands']);
});

test('splitRigConfig keeps entry knobs and derives the harness paths', () => {
  const paths = splitRigConfig({ capBytes: 4096, capHeadBytes: 1024, evidenceDir: 'E:/ev',
    unknownKey: 'dropped', enforcement: 'apply', log: false });
  assert.deepEqual(paths.plugin, { capBytes: 4096, capHeadBytes: 1024, enforcement: 'apply',
    crematorStorageRoot: join('E:/ev', 'storage') });
  assert.equal(paths.evidenceDir, 'E:/ev');
  assert.equal(paths.storageRoot, join('E:/ev', 'storage'));
  assert.equal(paths.log, false);
  // An explicit root wins, and the default `~/.dsh` root is never left in place.
  const explicit = splitRigConfig({ evidenceDir: 'E:/ev', crematorStorageRoot: 'E:/ev/root' });
  assert.equal(explicit.storageRoot, 'E:/ev/root');
  assert.equal(explicit.plugin.crematorStorageRoot, 'E:/ev/root');
  // The two surviving mount knobs reach the entry, not the harness keys:
  // `anchors` is accepted-and-ignored (ADR-0028) and `judgeTimeoutMs` is the
  // bulk prune's ask deadline.
  assert.deepEqual(splitRigConfig({ anchors: 'off', judgeTimeoutMs: 5000 }).plugin,
    { anchors: 'off', judgeTimeoutMs: 5000 });
  // The judge pass's protocol keys went with the pass: the split no longer
  // forwards them, so a stale scenario cannot hand the entry a dead knob.
  assert.deepEqual(splitRigConfig({ retryLimit: 2, revisitShare: 0.5,
    advertisedLabelLimit: 64 }).plugin, {});
  assert.deepEqual(splitRigConfig(undefined),
    { plugin: {}, evidenceDir: null, storageRoot: null, log: true });
});

test('splitRigConfig forwards entryAskBatchSize (ISSUE-117 chunk B3)', () => {
  // The batched entry-ask cadence (ADR-0035) is a product knob, so a scenario
  // that states it must reach the mount unchanged — before this pass-through the
  // key was silently dropped here and the rig would have measured batch 1 while
  // claiming batch N.
  assert.deepEqual(splitRigConfig({ entryAskBatchSize: 3 }).plugin,
    { entryAskBatchSize: 3 });
  // Absent stays absent: the mount's own default (1) then applies.
  assert.deepEqual(splitRigConfig({ floorBytes: 40000 }).plugin, { floorBytes: 40000 });
});

test('splitRigConfig forwards the live-run trigger and grammar (ISSUE-131)', () => {
  // The 2026-10-31 run had both keys stripped here, so the mount ran count
  // cadence and the 3option grammar while the patch named landed-bytes and
  // two-option. `paths.plugin` is the object `createRacoonsPlugin` receives as
  // `config`, so the entry's own validator reading them back is the proof the
  // value survives the wrapper intact.
  const trigger = { mode: 'landed-bytes', bytes: 240000 };
  const paths = splitRigConfig({ evidenceDir: 'E:/ev', entryAskTrigger: trigger,
    entryAskGrammar: 'two-option' });
  assert.deepEqual(paths.plugin.entryAskTrigger, trigger);
  assert.equal(paths.plugin.entryAskGrammar, 'two-option');
  const resolved = runtime.resolvePluginConfig(paths.plugin);
  assert.deepEqual(resolved.entryAskTrigger, trigger);
  assert.equal(resolved.entryAskGrammar, 'two-option');
});

test('the whitelist covers every key the entry accepts (ISSUE-131)', () => {
  // The expected list is the entry's OWN exported surface, derived from
  // `resolvePluginConfig`, never a second hand-written list: a mount key added
  // to the product without a matching `RIG_PLUGIN_CONFIG_KEYS` entry fails
  // here by name instead of silently reverting to its default at the mount.
  assert.equal(typeof runtime.racoonsPluginConfigKeys, 'function');
  const accepted = runtime.racoonsPluginConfigKeys();
  assert.ok(accepted.length > 0, 'the entry declares its config surface');
  // `crematorStorageRoot` is the one accepted key the wrapper does not copy: it
  // derives the root under the evidence dir (ADR-0013 ruling 3) so a rig run
  // never writes to `~/.dsh`. Asserted below, because the exclusion is only
  // honest while that stays true.
  const suppliedByWrapper = new Set(['crematorStorageRoot']);
  const missing = accepted.filter((key) => !suppliedByWrapper.has(key)
    && !RIG_PLUGIN_CONFIG_KEYS.includes(key));
  assert.deepEqual(missing, [],
    `the rig wrapper drops mount config keys: ${missing.join(', ')} — add them to RIG_PLUGIN_CONFIG_KEYS`);
  const stale = RIG_PLUGIN_CONFIG_KEYS.filter((key) => !accepted.includes(key));
  assert.deepEqual(stale, [],
    `the rig wrapper forwards keys the entry no longer accepts: ${stale.join(', ')}`);
  assert.equal(splitRigConfig({ crematorStorageRoot: 'E:/root' }).plugin.crematorStorageRoot,
    'E:/root');
});

test('sessionLedgerPaths mirrors the entry storage layout (ADR-0013)', () => {
  const paths = sessionLedgerPaths('E:/ev/storage', 'session-abc');
  assert.equal(paths.ledgerPath, join('E:/ev/storage', 'sessions', 'session-abc', 'ledger.sqlite'));
  assert.equal(paths.blobRoot, join('E:/ev/storage', 'sessions', 'session-abc', 'blobs'));
});

test('apply mounts the shipped entry and journals to the evidence file', async () => {
  const dir = scratch();
  const { ctx, cleanups } = fakeCtx();
  const previous = process.env.CREMATOR_RIG_DIST;
  process.env.CREMATOR_RIG_DIST = DIST;
  try {
    await apply(ctx, { evidenceDir: dir, capBytes: 8192, capHeadBytes: 2048 });
    const evidencePath = join(dir, EVIDENCE_FILE);
    assert.ok(existsSync(evidencePath), 'the wrapper wrote the evidence file');
    const lines = readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.kind === 'rig-mount').length, 1);
    assert.equal(lines.filter((line) => line.kind === 'mounted').length, 1);
    const mounted = lines.find((line) => line.kind === 'mounted');
    // ISSUE-029 / ADR-0014: the cap is scrapped. The keys are accepted and
    // ignored, so the mount line names neither of them.
    assert.equal('capBytes' in mounted, false, 'the scrapped cap knob is not on the mount line');
    assert.equal('capHeadBytes' in mounted, false, 'the scrapped cap knob is not on the mount line');
    // The wrapper supplies no ledger: the entry's own durable seam is under test.
    assert.equal(mounted.ledgerSource, 'durable');
    assert.equal(mounted.storageRoot, join(dir, 'storage'));
  } finally {
    for (const fn of cleanups) await fn();
    if (previous === undefined) delete process.env.CREMATOR_RIG_DIST;
    else process.env.CREMATOR_RIG_DIST = previous;
    cleanup(dir);
  }
});

test('the entry writes the session ledger the driver inspects', async () => {
  // The wrapper no longer supplies a ledger; this proves the path the driver
  // derives (`sessionLedgerPaths`) is the one the product's seam writes. A
  // drift here would make every ledger-side assertion fail by a missing file.
  const dir = scratch();
  const previous = process.env.CREMATOR_RIG_DIST;
  process.env.CREMATOR_RIG_DIST = DIST;
  try {
    await apply(fakeCtx().ctx, { evidenceDir: dir, capBytes: 8192, capHeadBytes: 2048 });
    const lines = readFileSync(join(dir, EVIDENCE_FILE), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    const mounted = lines.find((line) => line.kind === 'mounted');
    // The mount line names the configured root; the effective per-session plan
    // is its own `storage-plan` line, never a literal `<sessionId>` layout.
    assert.equal(mounted.storageRoot, join(dir, 'storage'));
    assert.equal(mounted.storage, undefined);
    assert.equal(mounted.blobRoot, undefined);
    assert.equal(mounted.node, process.version);
  } finally {
    if (previous === undefined) delete process.env.CREMATOR_RIG_DIST;
    else process.env.CREMATOR_RIG_DIST = previous;
    cleanup(dir);
  }
});
