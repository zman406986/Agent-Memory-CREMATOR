// The depth latch's baseline-vs-skip order (ISSUE-366; ADR-0050 Amendments
// 2026-11-18 and 2026-11-18 second). The skip line is a fire guard, not a new
// bar: the first observation after a pass IS the pass's post-removal reading
// and becomes the baseline even when it lands at or above the 75% line. The
// wider latch rule set is pinned in the dsh suite (prune-apply.test.ts §8).

import assert from "node:assert/strict";
import { test } from "node:test";
import { PruneWindowTrigger } from "../src/prune/window-trigger.js";

test("a post-pass reading above the 75% skip line is still the baseline", () => {
  // Window 400k, bar 20k: skip at 300k, re-arm delta 20k. The pass fires at
  // 250k; its post-removal reading lands at 310k, above the skip line.
  const trigger = new PruneWindowTrigger(400_000, 20_000);
  assert.equal(trigger.observe(250_000), true, "the pre-pass crossing fires");
  trigger.notePassCompleted();
  assert.equal(trigger.observe(310_000), false,
    "the skipped post-pass reading never fires");
  // The 310k reading was consumed as the baseline. A later below-skip reading
  // must NOT become the baseline: 270k is under 310k + 20k, so no fire. A stale
  // pending baseline would be consumed by the 250k reading and fire at 270k.
  assert.equal(trigger.observe(250_000), false,
    "a later reading is measured against the pass's own reading, not itself");
  assert.equal(trigger.observe(270_000), false,
    "270,000 is under one bar above the 310k baseline; a stale pending baseline "
    + "would have re-armed at 250k and fired here");
});

test("a skipped post-pass baseline still re-arms through a below-bar excursion", () => {
  const trigger = new PruneWindowTrigger(400_000, 20_000);
  assert.equal(trigger.observe(250_000), true);
  trigger.notePassCompleted();
  assert.equal(trigger.observe(310_000), false, "the skipped reading is the baseline");
  assert.equal(trigger.observe(10_000), false, "the below-bar excursion only marks");
  assert.equal(trigger.observe(20_000), true, "the next crossing fires without a full bar");
});

// ISSUE-336: the latch state survives a restart. The trigger stays pure — it
// exports and accepts the numbers; the mount owns the file they live in.

test("a restarted latch rehydrates its post-pass baseline", () => {
  const before = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(before.observe(254_000), true, "the pre-pass reading fires");
  before.notePassCompleted();
  const state = before.snapshot();
  // The restart: a fresh latch over the same session, rehydrated from storage.
  const after = new PruneWindowTrigger(400_000, 60_000);
  after.restore(state);
  assert.equal(after.observe(214_000), false,
    "the first above-bar reading after the restart is the baseline, not a wasted re-ask");
  assert.equal(after.observe(273_999), false, "one token under the rehydrated re-arm bar");
  assert.equal(after.observe(274_000), true,
    "one bar of new growth above the rehydrated baseline fires");
  // Non-vacuity: without the rehydration the same reading fires at once — the
  // defect the restore removes.
  const unrehydrated = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(unrehydrated.observe(214_000), true,
    "a fresh latch with no state re-asks immediately");
});

test("the snapshot carries the excursion mark; restore refuses garbage by name", () => {
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  assert.equal(trigger.observe(60_000), true);
  assert.equal(trigger.observe(59_999), false, "the excursion marks");
  const state = trigger.snapshot();
  assert.deepEqual(state,
    { lastFireUsage: 60_000, belowSinceFire: true, baselinePending: false });
  const restored = new PruneWindowTrigger(400_000, 60_000);
  restored.restore(state);
  assert.equal(restored.observe(60_000), true,
    "the restored excursion lets the next crossing fire without a full bar");
  assert.throws(() => restored.restore(
    { lastFireUsage: -1, belowSinceFire: false, baselinePending: false }),
  /lastFireUsage/u);
  assert.throws(() => restored.restore(
    { lastFireUsage: null, belowSinceFire: "no", baselinePending: false } as never),
  /belowSinceFire/u);
  assert.throws(() => restored.restore(
    { lastFireUsage: null, belowSinceFire: false, baselinePending: 1 } as never),
  /baselinePending/u);
});

// ADR-0071/0070: the mount may resolve the window after the session opened,
// and a routed-model change re-arms the latch without firing a pass.

test("a resolved window replaces a null one and re-arms the skip line", () => {
  const withBar = new PruneWindowTrigger(null, 60_000);
  assert.equal(withBar.enabled, true, "the explicit bar arms the latch without a window");
  assert.equal(withBar.skipThreshold, null, "no window means no 75% line");
  withBar.setWindowTokens(200_000);
  assert.equal(withBar.skipThreshold, 150_000, "the resolved window arms the skip line");
  withBar.setWindowTokens(null);
  assert.equal(withBar.skipThreshold, null, "an unresolved window disarms it again");
  assert.throws(() => withBar.setWindowTokens(0), /contextWindowTokens/u);
  const half = new PruneWindowTrigger(null);
  assert.equal(half.enabled, false, "no bar and no window is off");
  half.setWindowTokens(400_000);
  assert.equal(half.threshold, 200_000, "the deprecated half-window path follows the resolved value");
});

test("a cold boundary makes the next reading the baseline, not a fire", () => {
  // Window 400k keeps every reading below the 300k skip line, so the latch's
  // own bar is the only guard under test.
  const trigger = new PruneWindowTrigger(400_000, 60_000);
  trigger.notePassCompleted();
  assert.equal(trigger.observe(100_000), false, "the pass baseline is 100k");
  trigger.noteColdBoundary();
  assert.equal(trigger.observe(120_000), false,
    "the first reading after the switch is the new baseline");
  assert.equal(trigger.observe(160_000), false,
    "one bar above the old baseline is not one bar above the new one");
  assert.equal(trigger.observe(180_000), true,
    "one bar of growth above the switch baseline fires");
});