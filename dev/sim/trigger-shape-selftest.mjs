#!/usr/bin/env node
/**
 * Offline trigger-shape selftest (ISSUE-298; ADR-0050 amendments 2026-11-18).
 *
 * Drives the SHIPPED `PruneWindowTrigger` with synthetic readings. No model, no
 * network, no evidence: this is a shape check, not a measurement.
 *
 *   1. The re-arm baseline is the pass's post-removal reading: a pass at
 *      200,000 that leaves 150,000 re-fires at 210,000, not at 260,000.
 *   2. The automatic ask is skipped at or above 75% of the host window:
 *      300,000 on a 400,000 window. The manual command is a different path and
 *      is not exercised here.
 *   3. A native compaction re-arms a fresh latch: the next above-bar reading
 *      fires, the same as the first trigger on a new session.
 *
 * Run: node dev/sim/trigger-shape-selftest.mjs
 * Requires: npm run build -w cremator-dsh (or the root build).
 */
import assert from 'node:assert/strict';
import { PruneWindowTrigger } from '../../packages/adapters/dsh/dist/index.js';

const WINDOW = 400_000;
const BAR = 60_000;
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function trace(trigger, steps) {
  const out = [];
  for (const step of steps) {
    if (step === 'pass') {
      trigger.notePassCompleted();
      out.push('pass');
      continue;
    }
    out.push(`${String(step)}${trigger.observe(step) ? ' FIRE' : ''}`);
  }
  return out.join(' -> ');
}

check('increment: a pass at 200,000 leaving 150,000 re-fires at 210,000', () => {
  const trigger = new PruneWindowTrigger(WINDOW, BAR);
  assert.equal(trigger.observe(200_000), true, 'the first reading over the bar fires');
  trigger.notePassCompleted();
  assert.equal(trigger.observe(150_000), false, 'the post-removal reading is the baseline');
  assert.equal(trigger.observe(209_999), false, 'one token under one bar of growth');
  assert.equal(trigger.observe(210_000), true, 'one bar above what the pass left fires');
  assert.equal(trigger.observe(260_000), false, 'the old pre-pass target is not a fire');
  return trace(new PruneWindowTrigger(WINDOW, BAR),
    [200_000, 'pass', 150_000, 209_999, 210_000, 260_000]);
});

check('skip: no automatic fire at or above 300,000 on a 400,000 window', () => {
  const trigger = new PruneWindowTrigger(WINDOW, BAR);
  assert.equal(trigger.skipThreshold, 300_000);
  const fresh = trace(new PruneWindowTrigger(WINDOW, BAR), [300_000, 319_999]);
  assert.equal(trigger.observe(300_000), false, 'the skip line itself never fires');
  assert.equal(trigger.observe(319_999), false, 'up to the host compaction it never fires');
  assert.equal(new PruneWindowTrigger(WINDOW, BAR).observe(299_999), true,
    'one token under the line is a normal first fire');
  const afterPass = new PruneWindowTrigger(WINDOW, BAR);
  assert.equal(afterPass.observe(299_999), true, 'a fire under the line');
  afterPass.notePassCompleted();
  assert.equal(afterPass.observe(310_000), false, 'the post-pass reading above the line is skipped');
  return `fresh: ${fresh}; after pass at 299,999: 310,000 skipped`;
});

check('skip: the 200,000 window skips at 150,000', () => {
  const trigger = new PruneWindowTrigger(200_000, BAR);
  assert.equal(trigger.skipThreshold, 150_000);
  assert.equal(trigger.observe(150_000), false);
  assert.equal(trigger.observe(149_999), true);
  return '150,000 skipped; 149,999 fires';
});

check('compaction: the next above-bar reading fires like a new session', () => {
  const trigger = new PruneWindowTrigger(WINDOW, BAR);
  assert.equal(trigger.observe(290_000), true, 'a fire under the skip line');
  trigger.notePassCompleted();
  assert.equal(trigger.observe(100_000), false, 'the pass baseline');
  trigger.noteNativeCompaction();
  assert.equal(trigger.observe(100_000), true, 'after compaction the fresh latch fires');
  return '290,000 FIRE -> pass -> 100,000 baseline -> compaction -> 100,000 FIRE';
});

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  if (result.detail !== '') console.log(`      ${result.detail}`);
}
console.log(`\ntrigger-shape-selftest: ${failed === 0 ? 'GREEN' : 'RED'} — ${String(results.length - failed)}/${String(results.length)} checks`);
process.exit(failed === 0 ? 0 : 1);
