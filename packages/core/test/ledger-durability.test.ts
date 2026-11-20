import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BlobStore } from "../src/ledger/blob-store.js";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { initializeSchema } from "../src/ledger/schema.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

/** A temp root the row owns and removes, whatever the row does. */
async function withRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/**
 * One row per durability rule. Every row asserts the same shape: the first write
 * fails, the ledger reports it, and NOTHING survives — no prepared row, no blob,
 * no recall. A row that only checked the error code would pass on a ledger that
 * left half its work behind, which is the failure the law names.
 */
const CASES: readonly (readonly [string, () => Promise<void>])[] = [
  ["file-backed ledger reopens with the same inert prepared event and original bytes", async () => {
    const name = "file-backed ledger reopens with the same inert prepared event and original bytes";
    await withRoot("racoons-ledger-", async root => {
      const databasePath = join(root, "ledger.sqlite");
      const blobStore = new FileBlobStore(join(root, "blobs"));
      let ledger: SqliteLedger | undefined;
      try {
        ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
        const application = await applicationFixture();
        const archive = application.archives[0];
        assert.ok(archive, `row: ${name} — the fixture carries an archive`);
        const intent = await ledger.prepare(application);
        await ledger.close();
        ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
        assert.deepEqual(await ledger.recall(archive.recall.id), archive.recall,
          `row: ${name} — the archive reopens byte-exact`);
        assert.deepEqual(await ledger.prepare(application), intent,
          `row: ${name} — a repeat prepare is the same intent, not a second one`);
        const kinds: string[] = [];
        for await (const entry of ledger.events(application.sessionId)) kinds.push(entry.event.kind);
        assert.deepEqual(kinds, ["prepared"],
          `row: ${name} — the reopened ledger holds the inert prepare and nothing else`);
      } finally {
        await ledger?.close();
      }
    });
  }],
  ["failure during metadata insertion rolls back all seven tables", async () => {
    const name = "failure during metadata insertion rolls back all seven tables";
    await withRoot("racoons-rollback-", async root => {
      const databasePath = join(root, "ledger.sqlite");
      let ledger: SqliteLedger | undefined;
      try {
        const setup = new DatabaseSync(databasePath);
        initializeSchema(setup);
        setup.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON application_removals
          BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END`);
        setup.close();
        ledger = await SqliteLedger.open({ databasePath, blobStore: new MemoryBlobStore(), clock });
        await assert.rejects(ledger.prepare(await applicationFixture()), code("storage"),
          `row: ${name} — the injected abort surfaces as a storage failure`);
        await ledger.close();
        const inspection = new DatabaseSync(databasePath);
        try {
          for (const table of ["blobs", "recalls", "recall_parts", "removed_spans", "applications",
            "application_removals", "ledger_events"]) {
            assert.equal(inspection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0,
              `row: ${name} — ${table} must be empty after the rollback`);
          }
        } finally { inspection.close(); }
      } finally {
        await ledger?.close();
      }
    });
  }],
  ["removed-span hash and generated-record mismatches fail before any blob write", async () => {
    const name = "removed-span hash and generated-record mismatches fail before any blob write";
    let writes = 0;
    const memory = new MemoryBlobStore();
    const blobStore: BlobStore = {
      put: async body => { writes++; return memory.put(body); },
      get: hash => memory.get(hash),
    };
    const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore, clock });
    try {
      const recall = await recallFixture([bytes("abcdef")]);
      const application = await applicationFixture(recall);
      const first = recall.parts[0];
      assert.ok(first, `row: ${name} — the fixture recall carries a part`);
      const badPart = { ...first, bytes: bytes("abcdeg") };
      await assert.rejects(ledger.prepare({ ...application, archives: application.archives.map(archive =>
        ({ ...archive, recall: { ...recall, parts: [badPart] } })) }), code("hash-mismatch"),
        `row: ${name} — a part whose bytes do not hash to its span is refused`);
      await assert.rejects(ledger.prepare({ ...application,
        appendRecords: [{ recordId: "marker", bytes: bytes("bad marker"), sha256: "0".repeat(64) }] }),
      code("hash-mismatch"),
        `row: ${name} — a generated record whose bytes do not hash to its id is refused`);
      assert.equal(writes, 0,
        `row: ${name} — both refusals land before a single blob is written`);
    } finally { await ledger.close(); }
  }],
  ["blob publication failure leaves no prepared application", async () => {
    const name = "blob publication failure leaves no prepared application";
    const memory = new MemoryBlobStore();
    let writes = 0;
    const blobStore: BlobStore = {
      put: async body => {
        writes++;
        if (writes === 2) throw new Error("injected publication failure");
        return memory.put(body);
      },
      get: hash => memory.get(hash),
    };
    const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore, clock });
    try {
      const application = await applicationFixture();
      await assert.rejects(ledger.prepare(application), code("storage"),
        `row: ${name} — a failed publication surfaces as a storage failure`);
      const events = [];
      for await (const entry of ledger.events(application.sessionId)) events.push(entry);
      assert.equal(events.length, 0,
        `row: ${name} — a failed publication journals nothing at all`);
      const archive = application.archives[0];
      assert.ok(archive, `row: ${name} — the fixture carries an archive`);
      await assert.rejects(ledger.recall(archive.recall.id), code("not-found"),
        `row: ${name} — nothing is recallable from the failed prepare`);
      await ledger.prepare(application);
      assert.deepEqual(await ledger.recall(archive.recall.id), archive.recall,
        `row: ${name} — the retry publishes and becomes recallable`);
    } finally { await ledger.close(); }
  }],
];

test("ledger durability — one row per survived failure", async () => {
  for (const [name, run] of CASES) {
    try { await run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});
