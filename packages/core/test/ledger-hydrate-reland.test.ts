import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { commitPreparation } from "../src/ledger/commit-preparation.js";
import { appendEvent } from "../src/ledger/event-store.js";
import { exportSession } from "../src/ledger/export-file.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { publishPreparation, verifyApplication } from "../src/ledger/prepare.js";
import { initializeSchema } from "../src/ledger/schema.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { LedgerArchive, LedgerEntry } from "../src/ledger/types.js";
import { canonicalBytesWithByteArrays, fromBytes } from "../src/util/bytes.js";
import { sha256 } from "../src/util/hash.js";
import { applicationFixture } from "./ledger-fixtures.js";

/**
 * Re-land idempotency (ISSUE-315; PRD §6.7: "re-lands are idempotent keyed by
 * (span, sha256)"). The same removal content landed on two devices at two
 * wall-clock times differs only in `created_at_ms`; hydrating one device's
 * archive over the other's rows must be a no-op, while a differing content
 * column is still `idempotency-conflict`.
 */

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

function withTemp<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "racoons-reland-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

interface Device {
  readonly databasePath: string;
  readonly store: MemoryBlobStore;
  readonly archive: LedgerArchive;
  readonly recallId: string;
}

/**
 * One device's landing through the live write path at its own wall-clock time.
 * The event facts are identical on both devices — same key, payload and local
 * sequence — so only the rows' `created_at_ms` differs between the archives.
 */
async function seedDevice(root: string, name: string, atMs: number): Promise<Device> {
  const databasePath = join(root, `${name}.sqlite`);
  const store = new MemoryBlobStore();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSchema(db);
    const preparation = await verifyApplication(await applicationFixture());
    await publishPreparation(preparation, store);
    commitPreparation(db, preparation, atMs);
    appendEvent(db, {
      kind: "prepared", sessionId: preparation.intent.sessionId, atMs: 110,
      eventKey: `prepared:${preparation.intent.intentId}`,
      intentId: preparation.intent.intentId,
      applicationSha256: preparation.intent.applicationSha256,
    });
    const archive = await exportSession(db, store, preparation.intent.sessionId);
    const first = preparation.archives[0];
    assert.ok(first !== undefined, "the fixture carries one removal");
    return { databasePath, store, archive, recallId: first.recall.id };
  } finally { db.close(); }
}

async function collect(ledger: SqliteLedger, sessionId: string): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) entries.push(entry);
  return entries;
}

test("a re-landed archive differing only in created_at_ms hydrates idempotently", async () => {
  await withTemp(async root => {
    const a = await seedDevice(root, "a", 100);
    const b = await seedDevice(root, "b", 500);
    assert.notEqual(b.archive.archiveSha256, a.archive.archiveSha256,
      "the two landings differ in their timestamps, so the re-land is a real test");
    const target = await SqliteLedger.open({
      databasePath: a.databasePath, blobStore: a.store, clock,
    });
    try {
      const imported = await target.hydrate(b.archive);
      assert.deepEqual(imported, { sessionId: "session-1", events: 1, recalls: 1 });
      assert.deepEqual(await target.hydrate(b.archive), imported, "the second hydrate is a no-op");
      assert.equal((await collect(target, "session-1")).length, 1, "no second event landed");
      assert.ok((await target.recall(a.recallId)).parts.length > 0, "the recall is readable");
    } finally { await target.close(); }
    const inspect = new DatabaseSync(a.databasePath);
    try {
      for (const table of ["blobs", "recalls", "applications"]) {
        const times = inspect.prepare(`SELECT DISTINCT created_at_ms FROM ${table}`).all();
        assert.deepEqual(times.map(row => row["created_at_ms"]), [100],
          `${table} keeps the target's own landing time`);
      }
    } finally { inspect.close(); }
  });
});

test("a differing content column still refuses the re-land", async () => {
  await withTemp(async root => {
    const a = await seedDevice(root, "a", 100);
    const b = await seedDevice(root, "b", 500);
    const document = JSON.parse(fromBytes(b.archive.bytes)) as Record<string, unknown>;
    const tables = document["tables"] as Record<string, Record<string, unknown>[]>;
    const application = tables["applications"]?.[0];
    assert.ok(application !== undefined, "the fixture exports one application row");
    application["metadata_json"] = "{}";
    const bytes = canonicalBytesWithByteArrays(document);
    const forged: LedgerArchive = {
      sessionId: b.archive.sessionId, archiveSha256: await sha256(bytes), bytes,
    };
    const target = await SqliteLedger.open({
      databasePath: a.databasePath, blobStore: a.store, clock,
    });
    try {
      await assert.rejects(target.hydrate(forged), code("idempotency-conflict"));
      assert.equal((await collect(target, "session-1")).length, 1,
        "the refused re-land changed nothing");
    } finally { await target.close(); }
  });
});