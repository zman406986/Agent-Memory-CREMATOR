import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { LedgerEntry, LedgerEvent } from "../src/ledger/types.js";

/**
 * Event identity across writers (ISSUE-323). `appendEvent` keys events by
 * `event_key`; hydrate must recognize the same facts landed at another local
 * sequence as a no-op instead of refusing, while a differing payload under one
 * `event_key` is still `idempotency-conflict`. A genuinely new event keeps its
 * archived sequence, and an occupied sequence holding a different event still
 * refuses (pinned in ledger-export.test.ts).
 */

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

async function open(): Promise<SqliteLedger> {
  return SqliteLedger.open({
    databasePath: ":memory:", blobStore: new MemoryBlobStore(), clock,
  });
}

const notice = (eventKey: string, recordId: string, atMs: number): LedgerEvent => ({
  kind: "breaker-announced", sessionId: "session-1", eventKey, atMs, recordId,
});

async function collect(ledger: SqliteLedger, sessionId = "session-1"): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) entries.push(entry);
  return entries;
}

test("the same event facts at different local sequences re-land idempotently", async () => {
  const a = await open();
  const b = await open();
  try {
    await a.append(notice("k1", "r1", 110));
    await a.append(notice("k2", "r2", 111));
    // Device B landed the same two facts in the opposite order.
    await b.append(notice("k2", "r2", 111));
    await b.append(notice("k1", "r1", 110));
    const expected = await collect(a);
    const archive = await b.export("session-1");
    const imported = await a.hydrate(archive);
    assert.deepEqual(imported, { sessionId: "session-1", events: 2, recalls: 0 });
    assert.deepEqual(await collect(a), expected,
      "the target keeps its own sequences and gains no duplicate");
    assert.deepEqual(await a.hydrate(archive), imported, "the second hydrate is a no-op");
  } finally { await a.close(); await b.close(); }
});

test("a known event_key at a new sequence is a no-op; a new event keeps its archived sequence", async () => {
  const a = await open();
  const b = await open();
  try {
    await a.append(notice("k1", "r1", 110)); // device A: k1 at sequence 1
    // Device B: another session holds sequence 1, so the same k1 fact landed
    // at sequence 2 and a new event k3 at sequence 3.
    await b.append({ ...notice("pad", "rp", 109), sessionId: "session-2" });
    const k1 = await b.append(notice("k1", "r1", 110));
    const k3 = await b.append(notice("k3", "r3", 112));
    assert.equal(k1.sequence, 2);
    assert.equal(k3.sequence, 3);
    const archive = await b.export("session-1");
    const imported = await a.hydrate(archive);
    assert.deepEqual(imported, { sessionId: "session-1", events: 2, recalls: 0 });
    assert.deepEqual(
      (await collect(a)).map(entry => [entry.event.eventKey, entry.sequence]),
      [["k1", 1], ["k3", 3]],
      "k1 keeps the target's sequence; the new k3 lands at its archived sequence");
  } finally { await a.close(); await b.close(); }
});

test("a differing payload at the same event_key still refuses", async () => {
  const a = await open();
  const b = await open();
  const c = await open();
  try {
    await a.append(notice("k1", "r1", 110));
    // Same key, different fact — at the occupied sequence and at a free one.
    await b.append(notice("k1", "other", 110));
    const sameSlot = await b.export("session-1");
    await assert.rejects(a.hydrate(sameSlot), code("idempotency-conflict"));
    await c.append({ ...notice("pad", "rp", 109), sessionId: "session-2" });
    await c.append(notice("k1", "other", 110)); // sequence 2, free in the target
    const freeSlot = await c.export("session-1");
    await assert.rejects(a.hydrate(freeSlot), code("idempotency-conflict"));
    assert.deepEqual(
      (await collect(a)).map(entry => [entry.event.eventKey, entry.sequence]),
      [["k1", 1]], "the refused hydrates changed nothing");
  } finally { await a.close(); await b.close(); await c.close(); }
});