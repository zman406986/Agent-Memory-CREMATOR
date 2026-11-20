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
import type { Preparation } from "../src/ledger/prepare.js";
import { publishPreparation, verifyApplication } from "../src/ledger/prepare.js";
import { verifyArchive } from "../src/ledger/rehydrate.js";
import { initializeSchema } from "../src/ledger/schema.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";

/**
 * Export snapshot (ISSUE-317). The metadata reads must describe one consistent
 * instant: a preparation committed by a second connection between two export
 * SELECTs must not tear the archive (an event naming an intent the archive
 * never read). A read transaction pins one WAL snapshot; the archive then
 * fully excludes — or, when the commit lands before the first read, fully
 * includes — the new rows, and `verifyArchive` accepts it either way.
 */

const clock = { nowMs: () => 100 };

function withTemp<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "racoons-export-snapshot-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function preparedEvent(preparation: Preparation, atMs: number) {
  return {
    kind: "prepared" as const, sessionId: preparation.intent.sessionId, atMs,
    eventKey: `prepared:${preparation.intent.intentId}`,
    intentId: preparation.intent.intentId,
    applicationSha256: preparation.intent.applicationSha256,
  };
}

interface Seeded {
  readonly dbPath: string;
  readonly store: MemoryBlobStore;
  readonly second: Preparation;
}

/** One landed preparation; a second one verified and published, not yet landed. */
async function seed(root: string): Promise<Seeded> {
  const dbPath = join(root, "ledger.sqlite");
  const store = new MemoryBlobStore();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSchema(db);
    const first = await verifyApplication(await applicationFixture());
    await publishPreparation(first, store);
    commitPreparation(db, first, 100);
    appendEvent(db, preparedEvent(first, 100));
  } finally { db.close(); }
  const recall = await recallFixture([bytes("second device body\n")]);
  const second = await verifyApplication({
    ...await applicationFixture(recall), eventId: "event-2",
  });
  await publishPreparation(second, store);
  return { dbPath, store, second };
}

/** The second connection's commit: synchronous, so a prepare hook can run it. */
function landSecond(seeded: Seeded): void {
  const writer = new DatabaseSync(seeded.dbPath);
  try {
    writer.exec("PRAGMA foreign_keys = ON");
    writer.exec("PRAGMA busy_timeout = 5000");
    writer.exec("BEGIN IMMEDIATE");
    commitPreparation(writer, seeded.second, 200);
    appendEvent(writer, preparedEvent(seeded.second, 200));
    writer.exec("COMMIT");
  } finally { writer.close(); }
}

/**
 * A export-time view of the connection: every `prepare` first runs the hook,
 * which can land the second preparation at a chosen statement boundary.
 */
function hookedDb(db: DatabaseSync, onPrepare: (sql: string) => void): DatabaseSync {
  return {
    prepare: (sql: string) => { onPrepare(sql); return db.prepare(sql); },
    exec: (sql: string) => { db.exec(sql); },
  } as unknown as DatabaseSync;
}

/** Export with the commit injected at the boundary `trigger` names. */
async function exportWithCommit(
  seeded: Seeded, trigger: (sql: string, calls: number) => boolean,
): Promise<{ intentIds: unknown[]; events: number; recalls: number }> {
  const db = new DatabaseSync(seeded.dbPath);
  try {
    let calls = 0;
    let fired = false;
    const hooked = hookedDb(db, sql => {
      calls += 1;
      if (!fired && trigger(sql, calls)) { fired = true; landSecond(seeded); }
    });
    const archive = await exportSession(hooked, seeded.store, "session-1");
    assert.ok(fired, "the concurrent commit actually landed mid-export");
    // A torn archive is refused here; a consistent one verifies and hydrates.
    const verified = await verifyArchive(archive);
    const target = await SqliteLedger.open({
      databasePath: ":memory:", blobStore: seeded.store, clock,
    });
    try {
      const imported = await target.hydrate(archive);
      assert.equal(imported.events, verified.document.tables.ledger_events.length);
      assert.equal(imported.recalls, verified.document.tables.recalls.length);
    } finally { await target.close(); }
    return {
      intentIds: verified.document.tables.applications.map(row => row["intent_id"]),
      events: verified.document.tables.ledger_events.length,
      recalls: verified.document.tables.recalls.length,
    };
  } finally { db.close(); }
}

test("a commit before the last metadata SELECT cannot tear the archive", async () => {
  await withTemp(async root => {
    const seeded = await seed(root);
    // The last metadata read is the ledger_events SELECT: without one snapshot
    // it sees the new prepared event while `applications` was read before it.
    const result = await exportWithCommit(seeded, sql => /FROM ledger_events/u.test(sql));
    assert.ok(!result.intentIds.includes(seeded.second.intent.intentId),
      "the archive fully excludes the intent committed mid-export");
    assert.equal(result.events, 1, "the archive fully excludes the new event");
    assert.equal(result.recalls, 1, "the archive fully excludes the new recall");
  });
});

test("a commit before the first metadata SELECT is fully included", async () => {
  await withTemp(async root => {
    const seeded = await seed(root);
    const result = await exportWithCommit(seeded, (_sql, calls) => calls === 1);
    assert.ok(result.intentIds.includes(seeded.second.intent.intentId),
      "the archive fully includes the intent committed before the first read");
    assert.equal(result.events, 2);
    assert.equal(result.recalls, 2);
  });
});