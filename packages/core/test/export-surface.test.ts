import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../src/index.js";

/**
 * The public surface of `@cremator/core` is the index's export set. A name that
 * is gone from the source but still exported here is still API: a consumer
 * could import it and build the shape it serves.
 *
 * `extendForNextCall` and `stripSuffix` grew one judge message by byte
 * extension; the provider shares no cache across that growth (ADR-0010,
 * ISSUE-026), so a second judge turn appends to a fork instead. `composePruneAsk`
 * replaced the system slot and flattened the history into one user message — the
 * same refuted cache shape (ISSUE-027). All three are deleted, not deprecated,
 * and this table is the guard that keeps them deleted.
 */
const DELETED: readonly (readonly [string, string])[] = [
  ["extendForNextCall", "the byte-extension chaining API (ADR-0010)"],
  ["stripSuffix", "the byte-extension chaining API (ADR-0010)"],
  ["composePruneAsk", "the flattened prune ask composer (ISSUE-027)"],
];

/**
 * The names each deletion had to leave behind: the bytes it built still ship,
 * so a removal that took the payload with it fails here, not in a consumer.
 */
const SURVIVORS: readonly (readonly [string, "function" | "string", string])[] = [
  ["renderPruneAskTable", "function", "the table renderer stays (ISSUE-027)"],
  ["PRUNE_ASK_SYSTEM_PROMPT", "string", "the contract asset rides inside the appended ask (ISSUE-027)"],
];

test("the public surface — one row per deleted name and its named survivor", () => {
  const keys: readonly string[] = Object.keys(core);
  for (const [name, why] of DELETED) {
    assert.equal(keys.includes(name), false, `row: ${name} — core still exports ${why}`);
    assert.equal(name in core, false, `row: ${name} — core still carries ${why}`);
  }
  for (const [name, kind, why] of SURVIVORS) {
    assert.equal(typeof (core as Record<string, unknown>)[name], kind,
      `row: ${name} — ${why}, as a ${kind}`);
  }
});
