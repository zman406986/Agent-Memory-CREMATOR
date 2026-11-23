import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import type { RecallRecord } from "../src/ledger/manifest.js";
import { SCHEMA_VERSION, initializeSchema } from "../src/ledger/schema.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { ApplyReceipt, ArchiveRecord, LedgerEntry } from "../src/ledger/types.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";
import type { BlobStore } from "../src/ledger/blob-store.js";

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

async function collect(ledger: SqliteLedger, sessionId = "session-1"): Promise<LedgerEntry[]> {
  const result: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) result.push(entry);
  return result;
}

/**
 * A second process takes and holds the write lock. A process, not a second
 * connection in this one, because `append` waits synchronously inside SQLite:
 * a same-thread timer could not release the lock while the wait blocks it.
 */
function holdWriteLock(databasePath: string): Promise<ChildProcess> {
  const holder = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.CREMATOR_LEDGER_DB);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => { try { db.exec("COMMIT"); } finally { db.close(); } },
        Number(process.env.CREMATOR_HOLD_MS));
    } catch (error) {
      process.stderr.write(String(error));
      process.exit(1);
    }
  `;
  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", holder], {
      env: { ...process.env, CREMATOR_LEDGER_DB: databasePath, CREMATOR_HOLD_MS: "400" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.on("error", reject);
    child.stdout?.on("data", chunk => {
      if (String(chunk).includes("locked")) resolve(child);
    });
    child.on("exit", exitCode => reject(
      new Error(`write-lock holder exited early (${String(exitCode)})`)));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

/** One archive with a chosen operation kind the shared vocabulary has not widened to. */
function kinded(archive: ArchiveRecord, operationKind: string): ArchiveRecord {
  return { ...archive, operationKind } as unknown as ArchiveRecord;
}

/**
 * The two corruption points on the read path. Each row names the hash a
 * hostile store would answer wrongly: a later body, or the manifest itself.
 * The store is the injected one below, so the row changes exactly one side.
 */
const CORRUPTION_ROWS: readonly { name: string; hash: (recall: RecallRecord) => string }[] = [
  { name: "a corrupted later body", hash: recall => recall.parts[1]!.source.sha256 },
  { name: "a corrupted manifest", hash: recall => recall.manifestSha256 },
];

test("recall returns the exact original bytes and refuses every corruption", async () => {
  const memory = new MemoryBlobStore();
  let corruptHash: string | undefined;
  const store: BlobStore = {
    put: body => memory.put(body),
    get: async hash => {
      const body = await memory.get(hash);
      return hash === corruptHash ? new Uint8Array([0, 1, 2]) : body;
    },
  };
  const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore: store, clock });
  try {
    const original = [bytes("first\r\n"), new Uint8Array(),
      bytes("\uFEFF第二部分"), new Uint8Array([0, 255, 13, 10, 195, 169])];
    const recall = await recallFixture(original);
    await ledger.prepare(await applicationFixture(recall));

    const result = await ledger.recall(recall.id);
    assert.deepEqual(result, recall, "row: the whole record is the one that was prepared");
    assert.deepEqual(result.parts.map(part => part.bytes), original,
      "row: parts come back in order, byte-exact, with no invented separator");
    assert.deepEqual(result.parts.map(part => part.source.nodeId),
      ["node-0", "node-1", "node-2", "node-3"], "row: part order follows the manifest");
    assert.equal(result.parts.reduce((sum, part) => sum + part.bytes.length, 0),
      original.reduce((sum, part) => sum + part.length, 0), "row: the total length is unchanged");

    result.parts[0]?.bytes.fill(0);
    assert.deepEqual(await ledger.recall(recall.id), recall,
      "row: a caller zeroing a returned body does not reach the store");

    for (const row of CORRUPTION_ROWS) {
      corruptHash = row.hash(recall);
      await assert.rejects(ledger.recall(recall.id), code("hash-mismatch"), `row: ${row.name}`);
    }
    corruptHash = undefined;
    assert.deepEqual(await ledger.recall(recall.id), recall, "row: a clean store recalls again");
    await assert.rejects(ledger.recall(`recall:sha256:${"0".repeat(64)}`), code("not-found"),
      "row: an unknown recall id is not-found");
  } finally { await ledger.close(); }
});

/**
 * The append-only file: every table's rows are immutable, an edit to a stored
 * receipt is refused by name, the events read back in sequence, and a handle
 * carrying an older CHECK is refused instead of stamped with the new version.
 */
test("stored receipts are append-only, events read in sequence, and an old CHECK is refused", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    initializeSchema(db);
    const hash = "a".repeat(64);
    const recall = `recall:sha256:${hash}`;
    db.prepare("INSERT INTO blobs VALUES (?, 1, 1)").run(hash);
    db.prepare("INSERT INTO recalls VALUES (?, ?, 1)").run(recall, hash);
    db.prepare("INSERT INTO recall_parts VALUES (?, 0, 'node', ?, 1, ?)").run(recall, hash, hash);
    db.prepare("INSERT INTO removed_spans VALUES (?, 0, 0, 0, 1, ?)").run(recall, hash);
    db.prepare("INSERT INTO applications VALUES ('intent', 'session', 'event', 'rev', 'entry', ?, '{}', 1)").run(hash);
    db.prepare("INSERT INTO application_removals VALUES ('intent', 'cap', 'removal', ?, 'cap', NULL, 'title')").run(recall);
    db.exec(`INSERT INTO ledger_events VALUES (1, 'key', 'session', 'intent', 'prepared', 1, '{}')`);
    const keys = {
      blobs: "sha256", recalls: "recall_id", recall_parts: "part_index", removed_spans: "span_index",
      applications: "intent_id", application_removals: "removal_id", ledger_events: "event_key",
    };
    for (const [table, key] of Object.entries(keys)) {
      assert.throws(() => db.exec(`UPDATE ${table} SET ${key} = ${key}`), /append-only/,
        `row: ${table} UPDATE`);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/, `row: ${table} DELETE`);
    }
    // An edit that changes a receipt's value, not just a no-op rewrite.
    const receiptEdits: readonly { name: string; sql: string }[] = [
      { name: "an edit to a stored receipt's metadata", sql: `UPDATE applications SET metadata_json = '{"archives":[]}'` },
      { name: "an edit to a stored receipt's application hash",
        sql: `UPDATE applications SET application_sha256 = '${"0".repeat(64)}'` },
      { name: "a rewrite of a stored receipt's status", sql: "UPDATE ledger_events SET kind = 'applied'" },
    ];
    for (const row of receiptEdits) {
      assert.throws(() => db.exec(row.sql), /append-only/, `row: ${row.name}`);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM applications").get()?.n, 1,
      "row: the refused edits left the receipt as it was");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()?.n, 14,
      "row: fourteen triggers, two per table");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n, 7,
      "row: seven tables");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").get()?.n, 5,
      "row: five declared indexes");
  } finally { db.close(); }

  const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore: new MemoryBlobStore(), clock });
  try {
    const intent = await ledger.prepare(await applicationFixture());
    const event = {
      kind: "applied" as const, eventKey: `applied:${intent.intentId}`, sessionId: intent.sessionId, atMs: 110,
      receipt: { ...intent, resultRevision: "revision-2", appliedAtMs: 109 },
    };
    const applied = await ledger.append(event);
    assert.deepEqual(await ledger.append(event), applied, "row: an identical append is idempotent");
    await assert.rejects(ledger.append({ ...event, atMs: 111 }), code("idempotency-conflict"),
      "row: an append differing only in a payload field conflicts, so the whole key is compared");
    await ledger.append({ kind: "breaker-announced", sessionId: "other", eventKey: "other", atMs: 115,
      recordId: "notice" });
    const entries = await collect(ledger);
    assert.deepEqual(entries.map(entry => entry.event.kind), ["prepared", "applied"],
      "row: prepared then applied, in order");
    assert.ok(entries[0] && entries[1] && entries[0].sequence < entries[1].sequence,
      "row: the sequence rises");
    assert.equal((await collect(ledger, "other")).length, 1, "row: another session's events stay out");
  } finally { await ledger.close(); }

  const oldCheck = new DatabaseSync(":memory:");
  try {
    oldCheck.exec("PRAGMA foreign_keys = ON");
    oldCheck.exec(`CREATE TABLE application_removals (
      intent_id TEXT NOT NULL, rule_id TEXT NOT NULL, removal_id TEXT NOT NULL,
      recall_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('cap', 'seal', 'evict', 'span', 'verdict')),
      episode_id TEXT, title TEXT NOT NULL,
      PRIMARY KEY (intent_id, rule_id, removal_id)) STRICT`);
    oldCheck.exec("PRAGMA user_version = 2");
    assert.throws(() => initializeSchema(oldCheck),
      (error: unknown) => error instanceof LedgerError && error.code === "unsupported-schema" &&
        /can only be rebuilt/.test(error.message), "row: a schema 2 handle with the old CHECK");
    assert.equal(oldCheck.prepare("PRAGMA user_version").get()?.user_version, 2,
      "row: the refused handle keeps the version it was found with");
  } finally { oldCheck.close(); }
});

/**
 * The append boundary validates the same applied-receipt shape the engine
 * reconciles against (`receiptMatches`): a receipt whose result revision is
 * empty or unchanged can never be reconciled, so `committedState` would block
 * every pass with no conflict row and no abandon path (ISSUE-490). Such a
 * receipt must never land; the valid one still appends unchanged.
 */
test("an applied receipt the engine can never reconcile is refused by name", async () => {
  const ledger = await SqliteLedger.open({ databasePath: ":memory:",
    blobStore: new MemoryBlobStore(), clock });
  try {
    const intent = await ledger.prepare(await applicationFixture());
    const receiptRows: readonly { readonly name: string; readonly receipt: ApplyReceipt }[] = [
      { name: "a result revision equal to the base revision",
        receipt: { ...intent, resultRevision: intent.baseRevision, appliedAtMs: 109 } },
      { name: "an empty result revision",
        receipt: { ...intent, resultRevision: "", appliedAtMs: 109 } },
    ];
    for (const row of receiptRows) {
      await assert.rejects(ledger.append({ kind: "applied", sessionId: intent.sessionId,
        eventKey: `applied:${row.name}`, atMs: 110, receipt: row.receipt }),
      code("idempotency-conflict"), `row: ${row.name}`);
    }
    assert.deepEqual((await collect(ledger)).map(entry => entry.event.kind), ["prepared"],
      "row: a refused receipt appends no event");
    await ledger.append({ kind: "applied", sessionId: intent.sessionId,
      eventKey: "applied:valid", atMs: 110,
      receipt: { ...intent, resultRevision: "revision-2", appliedAtMs: 109 } });
    assert.deepEqual((await collect(ledger)).map(entry => entry.event.kind), ["prepared", "applied"],
      "row: a valid receipt still appends");
  } finally { await ledger.close(); }
});

test("prepare is idempotent, persists every admitted kind, and refuses an unadmitted one before a write", async () => {
  const root = mkdtempSync(join(tmpdir(), "racoons-kinds-"));
  const databasePath = join(root, "ledger.sqlite");
  const fileStore = new FileBlobStore(join(root, "blobs"));
  let writes = 0;
  const counted: BlobStore = {
    put: async body => { writes++; return fileStore.put(body); },
    get: hash => fileStore.get(hash),
  };
  let now = 100;
  const ledger = await SqliteLedger.open({ databasePath, blobStore: counted,
    clock: { nowMs: () => now } });
  try {
    const application = await applicationFixture(await recallFixture([bytes("a"), bytes("b")]));
    const base = application.archives[0];
    assert.ok(base);

    // A kind the CHECK does not admit: refused before any blob or row exists.
    await assert.rejects(ledger.prepare({ ...application, archives: [kinded(base, "bogus")] }),
      (error: unknown) => error instanceof LedgerError && error.code === "hash-mismatch" &&
        /Unsupported operation kind/.test(error.message),
      "row: a kind the CHECK does not admit");
    assert.equal(writes, 0, "row: a refused kind publishes no blob");
    assert.deepEqual(await collect(ledger), [], "row: a refused kind appends no event");

    // Every admitted kind, plus a second removal sharing the one recall.
    const archives = [
      kinded({ ...base, ruleId: "verdict", removalId: "removal-verdict" }, "verdict"),
      kinded({ ...base, ruleId: "stale-read", removalId: "removal-proof" }, "proof"),
      kinded({ ...base, ruleId: "forget", removalId: "removal-forget" }, "forget"),
      { ...base, removalId: "removal-second" },
    ];
    const intent = await ledger.prepare({ ...application, archives });
    now = 200;
    assert.deepEqual(await ledger.prepare({ ...application, archives }), intent,
      "row: an identical prepare is idempotent even after the clock advances");
    assert.deepEqual(await ledger.prepare({ ...application, archives: [...archives].reverse() }), intent,
      "row: archive order is not part of the intent");
    assert.equal((await collect(ledger)).length, 1, "row: idempotent prepares append one event");
    await assert.rejects(ledger.prepare({ ...application, baseRevision: "different", archives }),
      code("idempotency-conflict"), "row: a changed base revision conflicts");
    await assert.rejects(ledger.prepare({ ...application,
      archives: archives.map(archive => ({ ...archive, title: "Changed immutable title" })) }),
    code("idempotency-conflict"), "row: a changed immutable title conflicts");
    assert.equal((await collect(ledger)).length, 1, "row: a refused prepare appends no event");
    assert.deepEqual(await ledger.recall(base.recall.id), base.recall,
      "row: one recall serves every removal that names it");
  } finally { await ledger.close(); }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare(`SELECT operation_kind AS kind FROM application_removals
      ORDER BY rowid`).all().map(row => row["kind"]), ["verdict", "proof", "forget", "cap"],
    "row: every admitted kind sits in the durable file");
    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], SCHEMA_VERSION,
      "row: the file carries the current schema version");
  } finally { db.close(); }
  rmSync(root, { recursive: true, force: true });
});

test("append waits for a concurrent writer instead of faulting on the first lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "racoons-busy-"));
  const databasePath = join(root, "ledger.sqlite");
  const ledger = await SqliteLedger.open({ databasePath, blobStore: new MemoryBlobStore(), clock });
  const child = await holdWriteLock(databasePath);
  try {
    const startedAt = Date.now();
    const entry = await ledger.append({ kind: "breaker-announced", sessionId: "session-1",
      eventKey: "in-lock", atMs: 100, recordId: "notice" });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(entry.event.eventKey, "in-lock",
      "row: busy append — the append completes after the other writer commits");
    assert.ok(elapsedMs >= 100,
      `row: busy append — the append waited for the concurrent writer (${String(elapsedMs)} ms)`);
    assert.deepEqual((await collect(ledger)).map(item => item.event.eventKey), ["in-lock"],
      "row: busy append — the event is durable after the wait");
  } finally {
    await stopChild(child);
    await ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});