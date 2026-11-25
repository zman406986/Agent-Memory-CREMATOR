/**
 * The depth trigger is harness-agnostic: the implementation lives in
 * `@cremator/core` (`prune/window-trigger.ts`) so the dsh and opencode mounts
 * share one latch. This module keeps the dsh adapter's historical import path
 * and exports; ADR-0050 owns the rule.
 */
export {
  PruneWindowTrigger, resolveContextWindowTokens, resolvePruneThresholdTokens,
} from '@cremator/core';
