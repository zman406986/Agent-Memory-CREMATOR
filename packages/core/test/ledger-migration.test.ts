import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BlobStore } from "../src/ledger/blob-store.js";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import {
  LEGACY_BACKUP_SUFFIX, MIGRATION_LOCK_SUFFIX, MIGRATION_STAGING_SUFFIX, breakStaleMigrationLock,
  prepareLedgerFile, VERDICT_BACKUP_SUFFIX,
} from "../src/ledger/migration.js";
import type { MigrationStep } from "../src/ledger/migration.js";
import {
  LEGACY_SCHEMA_VERSION, LEDGER_APPLICATION_ID, LEDGER_TABLES, PREVIOUS_SCHEMA_VERSION,
  SCHEMA_VERSION, initializeSchema,
} from "../src/ledger/schema.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { RecallRecord } from "../src/ledger/manifest.js";
import type { PreparableApplication } from "../src/ledger/types.js";
import { canonicalManifestBytes } from "../src/util/bytes.js";
import { sha256, sha256Sync } from "../src/util/hash.js";
import { bytes, recallFixture } from "./ledger-fixtures.js";

const clock = { nowMs: (): number => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;
const message = (pattern: RegExp) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === "hash-mismatch" && pattern.test(error.message);

/** A temp directory that is always removed, even when an assertion fails. */
function withTemp<T>(body: (root: string) => T | Promise<T>): Promise<T> | T {
  const root = mkdtempSync(join(tmpdir(), "racoons-migration-"));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const result = body(root);
    return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
  } catch (error) { cleanup(); throw error; }
}

function fileSha(path: string): string {
  return sha256Sync(new Uint8Array(readFileSync(path)));
}

// --- application fixtures ---------------------------------------------------

interface Body {
  readonly sessionId: string;
  readonly eventId: string;
  readonly baseRevision: string;
  readonly phase: "entry" | "at-rest";
  readonly mode: "entry" | "append" | "rewrite" | "rehydrate" | "revert";
  readonly replacements: readonly { readonly bytes: Uint8Array; readonly sha256: string }[];
  readonly appendRecords: readonly unknown[];
  readonly archives: readonly unknown[];
  readonly sealedEpisodeIds: readonly string[];
  readonly createdAtMs: number;
  readonly revert?: unknown;
}

/**
 * The guard's documented `racoons:application:v1` envelope, rebuilt here by
 * hand from an independently written body. The digest must come from outside
 * the ledger (`law-verification-non-vacuity`): the ledger only compares.
 */
async function withDigest(body: Body): Promise<PreparableApplication> {
  const archives = (body.archives as readonly { recall: RecallRecord }[]).map(archive => ({
    ...archive, recall: { ...archive.recall, parts: archive.recall.parts.map(part => ({
      ...part, bytes: Array.from(part.bytes),
    })) },
  }));
  const applicationSha256 = await sha256(canonicalManifestBytes({
    domain: "racoons:application:v1", application: { ...body, archives },
  }));
  return { ...body, applicationSha256 } as unknown as PreparableApplication;
}

function verdictArchive(recall: RecallRecord): unknown {
  return { ruleId: "verdict", removalId: "removal-verdict", operationKind: "verdict",
    episodeId: null, title: "not retained src/a.ts", recall };
}

/** One internally consistent approved plan: 900 freed, 300 kept, 120 receipts. */
function plan(overrides: {
  readonly cutIndex?: number;
  readonly survivors?: readonly string[];
  readonly cost?: Readonly<Record<string, unknown>>;
} = {}): Record<string, unknown> {
  const cutIndex = overrides.cutIndex ?? 2;
  return {
    cutIndex,
    survivors: overrides.survivors ?? ["result-0", "result-2"],
    cost: overrides.cost ?? { cutIndex, freedBytes: 900, keptBytes: 300,
      receiptBytes: 120, netFreedBytes: 480 },
  };
}

async function revertBody(recall: RecallRecord, revert: unknown = plan()): Promise<Body> {
  return {
    sessionId: recall.manifest.sessionId, eventId: "event-verdict", baseRevision: "revision-1",
    phase: "at-rest", mode: "revert", replacements: [], appendRecords: [],
    archives: [verdictArchive(recall)], sealedEpisodeIds: [], createdAtMs: 90, revert,
  };
}

/** A revert body with the `revert` key absent, not present-and-undefined. */
function withoutRevert(body: Body): Body {
  const { revert: _omitted, ...rest } = body;
  return rest;
}

function countingStore(): { readonly store: BlobStore; readonly writes: () => number } {
  const memory = new MemoryBlobStore();
  let writes = 0;
  return { writes: () => writes, store: {
    put: async body => { writes++; return memory.put(body); },
    get: hash => memory.get(hash),
  } };
}

// --- older ledgers, written independently of the current schema -----------

/** Schema 1's operation kinds; the removals CHECK is the one line each rebuild changes. */
const V1_KINDS = ["cap", "seal", "evict", "span"] as const;
/** Schema 2, the revert-only schema, added `verdict`. */
const V2_KINDS = [...V1_KINDS, "verdict"] as const;

/** The removals DDL for a version's kind list, written by hand for each version. */
function removalsTable(kinds: readonly string[]): string {
  return `CREATE TABLE application_removals (
    intent_id TEXT NOT NULL REFERENCES applications(intent_id),
    rule_id TEXT NOT NULL,
    removal_id TEXT NOT NULL,
    recall_id TEXT NOT NULL REFERENCES recalls(recall_id),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (${kinds.map(kind => `'${kind}'`).join(", ")})),
    episode_id TEXT,
    title TEXT NOT NULL,
    PRIMARY KEY (intent_id, rule_id, removal_id)
  ) STRICT`;
}

/** Everything an older file holds except the removals table. */
const BASE_TABLES: readonly string[] = [
  `CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE recalls (
    recall_id TEXT PRIMARY KEY,
    manifest_sha256 TEXT NOT NULL UNIQUE REFERENCES blobs(sha256),
    created_at_ms INTEGER NOT NULL,
    CHECK (recall_id = 'recall:sha256:' || manifest_sha256)
  ) STRICT`,
  `CREATE TABLE recall_parts (
    recall_id TEXT NOT NULL REFERENCES recalls(recall_id),
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    source_node_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
    source_byte_length INTEGER NOT NULL CHECK (source_byte_length >= 0),
    blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    PRIMARY KEY (recall_id, part_index),
    CHECK (source_sha256 = blob_sha256)
  ) STRICT`,
  `CREATE TABLE removed_spans (
    recall_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    span_index INTEGER NOT NULL CHECK (span_index >= 0),
    start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
    end_byte_exclusive INTEGER NOT NULL,
    slice_sha256 TEXT NOT NULL CHECK (length(slice_sha256) = 64),
    PRIMARY KEY (recall_id, part_index, span_index),
    FOREIGN KEY (recall_id, part_index) REFERENCES recall_parts(recall_id, part_index),
    CHECK (end_byte_exclusive > start_byte)
  ) STRICT`,
  `CREATE TABLE applications (
    intent_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    base_revision TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('entry', 'at-rest')),
    application_sha256 TEXT NOT NULL CHECK (length(application_sha256) = 64),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (session_id, event_id, application_sha256)
  ) STRICT`,
  `CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    intent_id TEXT REFERENCES applications(intent_id),
    kind TEXT NOT NULL CHECK (kind IN (
      'prepared', 'applied', 'abandoned', 'validation',
      'breaker-disabled', 'breaker-announced'
    )),
    at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  ) STRICT`,
];

interface LegacySeed {
  readonly recall: RecallRecord;
  readonly intentId: string;
  readonly applicationSha256: string;
  readonly eventKey: string;
}

/** Table names and the removals CHECK for one older schema version. */
function olderTables(version: number): readonly string[] {
  return [...BASE_TABLES, removalsTable(version === LEGACY_SCHEMA_VERSION ? V1_KINDS : V2_KINDS)];
}

/**
 * Writes one older schema version's rows: one recall, one cap application, one
 * prepared event. `version` selects the removals CHECK only; the rows are what
 * both versions carried.
 */
function seedLegacy(db: DatabaseSync, seed: LegacySeed, version: number = LEGACY_SCHEMA_VERSION): void {
  for (const statement of olderTables(version)) db.exec(statement);
  const at = 7;
  const insertBlob = db.prepare("INSERT INTO blobs VALUES (?, ?, ?)");
  for (const part of seed.recall.parts) {
    insertBlob.run(part.source.sha256, part.bytes.byteLength, at);
  }
  const manifestBytes = canonicalManifestBytes(seed.recall.manifest);
  insertBlob.run(seed.recall.manifestSha256, manifestBytes.byteLength, at);
  db.prepare("INSERT INTO recalls VALUES (?, ?, ?)")
    .run(seed.recall.id, seed.recall.manifestSha256, at);
  const insertPart = db.prepare("INSERT INTO recall_parts VALUES (?, ?, ?, ?, ?, ?)");
  const insertSpan = db.prepare("INSERT INTO removed_spans VALUES (?, ?, ?, ?, ?, ?)");
  seed.recall.parts.forEach((part, index) => {
    insertPart.run(seed.recall.id, index, part.source.nodeId, part.source.sha256,
      part.source.byteLength, part.source.sha256);
    part.removedRanges.forEach((span, spanIndex) => {
      insertSpan.run(seed.recall.id, index, spanIndex, span.range.startByte,
        span.range.endByteExclusive, span.sha256);
    });
  });
  db.prepare("INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    seed.intentId, "session-1", "event-legacy", "revision-legacy", "entry",
    seed.applicationSha256, JSON.stringify({ archives: [], appendRecords: [], sealedEpisodeIds: [] }), at);
  db.prepare("INSERT INTO application_removals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    seed.intentId, "cap", "removal-legacy", seed.recall.id, "cap", null, "Original body");
  db.prepare("INSERT INTO ledger_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    1, seed.eventKey, "session-1", seed.intentId, "prepared", at,
    JSON.stringify({ kind: "prepared", sessionId: "session-1", eventKey: seed.eventKey,
      atMs: at, intentId: seed.intentId, applicationSha256: seed.applicationSha256 }));
  db.exec(`CREATE INDEX ledger_events_session_sequence ON ledger_events(session_id, sequence)`);
}

async function legacySeed(): Promise<LegacySeed> {
  const recall = await recallFixture([bytes("legacy first"), bytes("legacy \uFEFF second")]);
  return { recall, intentId: "intent-legacy", eventKey: "prepared:intent-legacy",
    applicationSha256: await sha256(bytes("legacy application")) };
}

/** An older-version file at `path`, closed cleanly, plus its bodies in `store`. */
async function writeLegacyFile(
  path: string, store: BlobStore, version: number = LEGACY_SCHEMA_VERSION,
): Promise<LegacySeed> {
  const seed = await legacySeed();
  for (const part of seed.recall.parts) await store.put(part.bytes);
  await store.put(canonicalManifestBytes(seed.recall.manifest));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA foreign_keys = ON");
    seedLegacy(db, seed, version);
    db.exec(`PRAGMA user_version = ${version}`);
  } finally { db.close(); }
  return seed;
}

function pragmas(path: string): { readonly version: number; readonly applicationId: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: Number(db.prepare("PRAGMA user_version").get()?.["user_version"]),
      applicationId: Number(db.prepare("PRAGMA application_id").get()?.["application_id"]),
    };
  } finally { db.close(); }
}

/** Every table's row count, so "no rows lost" is checked table by table. */
function tableCounts(path: string): Readonly<Record<string, number>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of LEDGER_TABLES) {
      counts[table] = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    }
    return counts;
  } finally { db.close(); }
}

async function eventKinds(ledger: SqliteLedger, sessionId = "session-1"): Promise<string[]> {
  const kinds: string[] = [];
  for await (const entry of ledger.events(sessionId)) kinds.push(entry.event.kind);
  return kinds;
}

/** schema 3 pins its version, application id, and the proof and forget operation kinds */
async function schemaPins(): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    initializeSchema(db);
    assert.equal(SCHEMA_VERSION, 3, "row: version — schema 3");
    assert.equal(PREVIOUS_SCHEMA_VERSION, 2, "row: version — the previous schema is 2");
    assert.equal(LEGACY_SCHEMA_VERSION, 1, "row: version — the legacy schema is 1");
    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], 3, "row: version — stamped");
    assert.equal(db.prepare("PRAGMA application_id").get()?.["application_id"],
      LEDGER_APPLICATION_ID, "row: version — the application id is stamped");
    const sql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table'
      AND name = 'application_removals'`).get()?.["sql"]);
    for (const kind of ["verdict", "proof", "forget"]) {
      assert.ok(sql.includes(`'${kind}'`), `row: ${kind} — the CHECK admits the ${kind} archive kind`);
    }
    const hash = "a".repeat(64), recall = `recall:sha256:${hash}`;
    db.prepare("INSERT INTO blobs VALUES (?, 1, 1)").run(hash);
    db.prepare("INSERT INTO recalls VALUES (?, ?, 1)").run(recall, hash);
    db.prepare("INSERT INTO recall_parts VALUES (?, 0, 'node', ?, 1, ?)").run(recall, hash, hash);
    db.prepare("INSERT INTO removed_spans VALUES (?, 0, 0, 0, 1, ?)").run(recall, hash);
    db.prepare("INSERT INTO applications VALUES ('intent', 'session', 'event', 'rev', 'at-rest', ?, '{}', 1)")
      .run(hash);
    const kindRows: readonly (readonly [string, string])[] = [
      ["verdict", "removal-verdict"], ["proof", "removal-proof"], ["forget", "removal-forget"],
    ];
    for (const [rule, removal] of kindRows) {
      db.prepare("INSERT INTO application_removals VALUES ('intent', ?, ?, ?, ?, NULL, 'title')")
        .run(rule, removal, recall, rule);
    }
    assert.deepEqual(db.prepare(`SELECT operation_kind AS kind FROM application_removals
      ORDER BY rowid`).all().map(row => row["kind"]), ["verdict", "proof", "forget"],
    "row: kinds — every schema 3 kind is admitted");
    assert.throws(() => db.prepare(
      "INSERT INTO application_removals VALUES ('intent', 'cap', 'r2', ?, 'bogus', NULL, 'title')")
      .run(recall), /CHECK constraint failed/,
    "row: kinds — an unknown kind is refused by the CHECK");
  } finally { db.close(); }
}

/** a revert entry with an inconsistent plan is refused before any blob or row is written */
async function planRefusals(): Promise<void> {
  const recall = await recallFixture([bytes("unit body")]);
  const store = countingStore();
  const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore: store.store, clock });
  try {
    const cases: readonly (readonly [string, unknown, RegExp])[] = [
      ["negative freed bytes", plan({ cost: { cutIndex: 2, freedBytes: -1, keptBytes: 0,
        receiptBytes: 0, netFreedBytes: -1 } }), /non-negative integers/],
      ["negative kept bytes", plan({ cost: { cutIndex: 2, freedBytes: 10, keptBytes: -5,
        receiptBytes: 0, netFreedBytes: 15 } }), /non-negative integers/],
      ["negative receipt bytes", plan({ cost: { cutIndex: 2, freedBytes: 10, keptBytes: 0,
        receiptBytes: -2, netFreedBytes: 12 } }), /non-negative integers/],
      ["arithmetic that does not add up", plan({ cost: { cutIndex: 2, freedBytes: 900,
        keptBytes: 300, receiptBytes: 120, netFreedBytes: 500 } }), /salvage arithmetic/],
      ["cost cut index differing from the plan", plan({ cost: { cutIndex: 3, freedBytes: 900,
        keptBytes: 300, receiptBytes: 120, netFreedBytes: 480 } }), /cut index differs/],
      ["negative cut index", plan({ cutIndex: -1, cost: { cutIndex: -1, freedBytes: 0,
        keptBytes: 0, receiptBytes: 0, netFreedBytes: 0 } }), /non-negative integer/],
      ["fractional cut index", plan({ cutIndex: 1.5, cost: { cutIndex: 1.5, freedBytes: 0,
        keptBytes: 0, receiptBytes: 0, netFreedBytes: 0 } }), /non-negative integer/],
      ["repeated survivor", plan({ survivors: ["result-0", "result-0"] }), /repeat a node id/],
      ["empty survivor id", plan({ survivors: [""] }), /non-empty node ids/],
      ["missing cost", { cutIndex: 2, survivors: [] }, /must be an object/],
      ["missing revert payload", undefined, /must carry its revert payload/],
    ];
    for (const [name, revert, pattern] of cases) {
      const application = revert === undefined
        ? await withDigest(withoutRevert(await revertBody(recall)))
        : await withDigest(await revertBody(recall, revert));
      await assert.rejects(ledger.prepare(application), message(pattern), name);
    }
    // The payload is present exactly on a revert application (`types.ts`).
    const entry = await withDigest({ ...await revertBody(recall), mode: "entry" });
    await assert.rejects(ledger.prepare(entry),
      message(/Only a revert application may carry/), "revert payload on mode entry");
    assert.equal(store.writes(), 0, "no blob was published for any refused application");
    assert.deepEqual(await eventKinds(ledger), []);
  } finally { await ledger.close(); }
}

/** a version 1 file migrates into a fresh schema 3 file in one hop and keeps every entry */
async function v1Migration(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore);
    const before = fileSha(databasePath);
    const outcome = prepareLedgerFile({ databasePath });
    assert.equal(outcome.status, "migrated", "row: v1 — the file is migrated");
    assert.equal(outcome.rowsCopied, 2 * seed.recall.parts.length + 7,
      "row: v1 — one row per blob (bodies and manifest), part, span, recall, application, removal and event");
    assert.deepEqual(pragmas(databasePath),
      { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, "row: v1 — header");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall,
        "row: v1 — the archived bytes survive the rebuild");
      const events = [];
      for await (const entry of ledger.events("session-1")) events.push(entry);
      assert.deepEqual(events.map(entry => entry.event.kind), ["prepared"], "row: v1 — event kinds");
      assert.equal(events[0]?.event.eventKey, seed.eventKey, "row: v1 — event key");
      assert.equal(events[0]?.sequence, 1, "row: v1 — event sequence");
    } finally { await ledger.close(); }
    // The v1 file is proof, not working state: same bytes, new name.
    assert.equal(fileSha(`${databasePath}${LEGACY_BACKUP_SUFFIX}`), before,
      "row: v1 — the retired v1 file is byte-identical to what it was before the migration");
    assert.equal(existsSync(`${databasePath}${MIGRATION_STAGING_SUFFIX}`), false,
      "row: v1 — no staging file survives a completed migration");
  });
}

/** a version 2 file migrates into schema 3 and keeps its verdict removal */
async function v2Migration(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore, PREVIOUS_SCHEMA_VERSION);
    const before = fileSha(databasePath);
    const outcome = prepareLedgerFile({ databasePath });
    assert.equal(outcome.status, "migrated", "row: v2 — the file is migrated");
    assert.deepEqual(pragmas(databasePath),
      { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, "row: v2 — header");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(
        "SELECT operation_kind AS kind FROM application_removals").all().map(row => row["kind"]),
      ["cap"], "row: v2 — the v2 removal row survives the rebuild");
      const sql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = 'application_removals'`).get()?.["sql"]);
      assert.ok(sql.includes("'proof'") && sql.includes("'forget'"),
        "row: v2 — the rebuilt table carries the schema 3 CHECK");
    } finally { db.close(); }
    assert.equal(fileSha(`${databasePath}${VERDICT_BACKUP_SUFFIX}`), before,
      "row: v2 — the retired v2 file is byte-identical to what it was before the migration");
    assert.equal(existsSync(`${databasePath}${LEGACY_BACKUP_SUFFIX}`), false,
      "row: v2 — a v2 source is not backed up under the v1 name");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall, "row: v2 — bytes survive");
      assert.deepEqual(await eventKinds(ledger), ["prepared"], "row: v2 — events survive");
    } finally { await ledger.close(); }
  });
}

/** Throws at `step`, which is what the process dying there looks like. */
function crashAt(step: MigrationStep): (reached: MigrationStep) => void {
  return reached => {
    if (reached === step) throw new Error(`simulated crash at ${reached}`);
  };
}

type MainState = "absent" | "legacy" | "current";

function mainState(path: string): MainState {
  if (!existsSync(path)) return "absent";
  const { version } = pragmas(path);
  return version === LEGACY_SCHEMA_VERSION ? "legacy" : version === SCHEMA_VERSION ? "current" : "absent";
}

const CRASH_EXPECTATIONS: readonly (readonly [MigrationStep, MainState])[] = [
  ["staged", "legacy"], ["durable", "legacy"], ["retired", "absent"], ["sidecars", "absent"],
];

/** the main path stays whole wherever a migration dies, and the next open recovers */
async function crashMatrix(): Promise<void> {
  for (const [step, expected] of CRASH_EXPECTATIONS) {
    const row = `crash at ${step}`;
    await withTemp(async root => {
      const databasePath = join(root, "ledger.sqlite");
      const blobStore = new FileBlobStore(join(root, "blobs"));
      const seed = await writeLegacyFile(databasePath, blobStore);
      const original = fileSha(databasePath);
      const backup = `${databasePath}${LEGACY_BACKUP_SUFFIX}`;
      const staging = `${databasePath}${MIGRATION_STAGING_SUFFIX}`;
      assert.throws(() => prepareLedgerFile({ databasePath, onStep: crashAt(step) }),
        code("storage"), `row: ${row} — the crash surfaces as a storage refusal`);
      assert.equal(mainState(databasePath), expected,
        `row: ${row} — no half-migrated file at the main path`);
      assert.equal(existsSync(staging), true,
        `row: ${row} — the staged current-version file survives the crash`);
      if (expected === "legacy") {
        assert.equal(fileSha(databasePath), original, `row: ${row} — v1 was not written in place`);
        assert.equal(existsSync(backup), false,
          `row: ${row} — v1 was not retired before the staged file was durable`);
      } else {
        assert.equal(fileSha(backup), original, `row: ${row} — the backup is the untouched v1 file`);
        assert.equal(existsSync(databasePath), false, `row: ${row} — the main path is absent`);
      }
      // Recovery: the next open completes or repeats the migration, then works.
      const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
      try {
        assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall, `row: ${row} — bytes recovered`);
        assert.deepEqual(await eventKinds(ledger), ["prepared"], `row: ${row} — events recovered`);
      } finally { await ledger.close(); }
      assert.deepEqual(pragmas(databasePath),
        { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, `row: ${row} — header`);
      assert.equal(fileSha(backup), original,
        `row: ${row} — the backup is still the v1 file, byte for byte`);
      assert.equal(existsSync(staging), false, `row: ${row} — recovery consumed the staged file`);
      const reopened = prepareLedgerFile({ databasePath });
      assert.equal(reopened.status, "current", `row: ${row} — a second open re-reads nothing`);
      assert.equal(reopened.backupPath, backup, `row: ${row} — the backup is still reported`);
    });
  }
}

/** a fresh path reports fresh and a current path reports current, and an entry then prepares */
async function freshAndCurrent(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    assert.deepEqual(prepareLedgerFile({ databasePath }),
      { status: "fresh", backupPath: null, rowsCopied: 0 }, "row: fresh — no file, no backup");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    await ledger.close();
    assert.deepEqual(prepareLedgerFile({ databasePath }),
      { status: "current", backupPath: null, rowsCopied: 0 }, "row: current — no rebuild, no backup");
    assert.deepEqual(pragmas(databasePath),
      { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, "row: current — header");

    // A mode revert entry with a verdict archive, on the file just made current.
    const recall = await recallFixture([bytes("forgotten unit body")]);
    const application = await withDigest(await revertBody(recall));
    const writer = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      await writer.prepare(application);
      assert.deepEqual(await writer.recall(recall.id), recall, "row: mode revert — bytes recovered");
      assert.deepEqual(await eventKinds(writer), ["prepared"], "row: mode revert — one event");
    } finally { await writer.close(); }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(
        "SELECT operation_kind AS kind FROM application_removals").all().map(row => row["kind"]),
      ["verdict"], "row: mode revert — the verdict removal row");
      assert.deepEqual(db.prepare(
        "SELECT metadata_json AS json FROM applications").all().map(row =>
        JSON.parse(String(row["json"])).revert.cutIndex), [2],
      "row: mode revert — the approved plan is stored with the intent");
      assert.equal(db.prepare("SELECT count(*) AS n FROM blobs").get()?.["n"], 2,
        "row: mode revert — one body plus one manifest");
    } finally { db.close(); }
  });
}

/** a second migration keeps both backups untouched, and a re-read beside a backup is refused */
async function idempotenceAndReread(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore);
    await SqliteLedger.open({ databasePath, blobStore, clock }).then(ledger => ledger.close());
    const legacyBackup = `${databasePath}${LEGACY_BACKUP_SUFFIX}`;
    const legacySha = fileSha(legacyBackup);
    // The v2 the previous schema would have left behind: rebuilt here by hand so
    // the second migration starts from a real v2 file, not a stamped one.
    const v2Path = join(root, "v2.sqlite");
    const v2 = new DatabaseSync(v2Path);
    try {
      v2.exec("PRAGMA journal_mode = DELETE");
      v2.exec("PRAGMA foreign_keys = ON");
      seedLegacy(v2, seed, PREVIOUS_SCHEMA_VERSION);
      v2.exec(`PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION}`);
    } finally { v2.close(); }
    rmSync(databasePath, { force: true });
    copyFileSync(v2Path, databasePath);
    const v2Sha = fileSha(databasePath);
    assert.equal(prepareLedgerFile({ databasePath }).status, "migrated",
      "row: second migration — the v2 file is rebuilt");
    assert.equal(fileSha(`${databasePath}${VERDICT_BACKUP_SUFFIX}`), v2Sha,
      "row: second migration — the retired v2 file is byte-identical to what it was");
    assert.equal(fileSha(legacyBackup), legacySha,
      "row: second migration — the earlier v1 backup is untouched");
    assert.deepEqual(pragmas(databasePath),
      { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID },
      "row: second migration — header");
    // Idempotence: a third call on the now-current file rebuilds nothing.
    const again = prepareLedgerFile({ databasePath });
    assert.equal(again.status, "current", "row: idempotence — a current file is not rebuilt");
    assert.equal(again.rowsCopied, 0, "row: idempotence — no rows are copied");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await eventKinds(ledger), ["prepared"], "row: idempotence — events are neither doubled nor lost");
    } finally { await ledger.close(); }

    // The never-re-read rule: a planted v1 file beside its own backup is refused.
    const planted = `${databasePath}.plant`;
    new DatabaseSync(planted).close();
    rmSync(databasePath, { force: true });
    const restored = new DatabaseSync(databasePath);
    try {
      restored.exec("PRAGMA journal_mode = DELETE");
      restored.exec("PRAGMA foreign_keys = ON");
      seedLegacy(restored, seed);
      restored.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION}`);
      restored.prepare("INSERT INTO ledger_events VALUES (2, 'planted', 'session-1', NULL, 'validation', 9, ?)")
        .run(JSON.stringify({ kind: "validation", sessionId: "session-1", eventKey: "planted",
          atMs: 9, eventId: "event-planted", ok: true, issues: [],
          breaker: { consecutiveValidationFailures: 0, disabled: false } }));
    } finally { restored.close(); }
    const mutatedSha = fileSha(databasePath);
    assert.throws(() => prepareLedgerFile({ databasePath }),
      (error: unknown) => error instanceof LedgerError && error.code === "unsupported-schema" &&
        /Refusing to re-read/.test(error.message),
    "row: re-read — a v1 file beside its backup is refused by name");
    await assert.rejects(SqliteLedger.open({ databasePath, blobStore, clock }),
      (error: unknown) => error instanceof LedgerError && error.code === "unsupported-schema",
      "row: re-read — opening it directly is refused too");
    assert.equal(fileSha(databasePath), mutatedSha,
      "row: re-read — the planted v1 file was not read into schema 3");
    assert.equal(fileSha(legacyBackup), legacySha,
      "row: re-read — the original backup is untouched");
    assert.equal(existsSync(`${databasePath}${MIGRATION_STAGING_SUFFIX}`), false,
      "row: re-read — a refusal stages nothing");
  });
}

/** a revert entry prepares on a migrated v1 store, and a second open re-reads nothing */
async function postMigrationRevert(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore);
    let ledger: SqliteLedger | undefined;
    try {
      ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
      assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall,
        "row: post-migration — the migrated bytes are readable");
      const recall = await recallFixture([bytes("post-migration unit")]);
      await ledger.prepare(await withDigest(await revertBody(recall)));
      assert.deepEqual(await ledger.recall(recall.id), recall,
        "row: post-migration — a new revert prepares and restores");
      await ledger.close();
      ledger = undefined;
      const backup = `${databasePath}${LEGACY_BACKUP_SUFFIX}`;
      const backupSha = fileSha(backup);
      // Second open: schema 3 directly. The backup is not consulted and not rewritten.
      assert.equal(prepareLedgerFile({ databasePath }).status, "current",
        "row: second open — no rebuild");
      ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
      assert.deepEqual(await eventKinds(ledger), ["prepared", "prepared"],
        "row: second open — both events, in order");
      await ledger.close();
      ledger = undefined;
      assert.equal(fileSha(backup), backupSha, "row: second open — the backup is never rewritten");
    } finally { await ledger?.close(); }
  });
}

/** a crash between retiring the main file and moving its sidecars still keeps the WAL with the backup */
async function walCrash(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await legacySeed();
    for (const part of seed.recall.parts) await blobStore.put(part.bytes);
    await blobStore.put(canonicalManifestBytes(seed.recall.manifest));
    const writerPath = join(root, "writer.sqlite");
    const writer = new DatabaseSync(writerPath);
    try {
      // A process that died before checkpointing leaves the newest frames in -wal.
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("PRAGMA synchronous = FULL");
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.exec("PRAGMA foreign_keys = ON");
      seedLegacy(writer, seed);
      writer.prepare(`INSERT INTO ledger_events VALUES (2, 'in-wal', 'session-1', NULL,
        'breaker-announced', 8, ?)`).run(JSON.stringify({ kind: "breaker-announced",
        sessionId: "session-1", eventKey: "in-wal", atMs: 8, recordId: "notice" }));
      writer.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION}`);
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${writerPath}${suffix}`;
        if (!existsSync(source)) continue;
        const target = `${databasePath}${suffix}`;
        rmSync(target, { force: true });
        // Copied while the writer still holds the handle: this is the crash snapshot.
        copyFileSync(source, target);
      }
    } finally { writer.close(); }
    const backup = `${databasePath}${LEGACY_BACKUP_SUFFIX}`;
    // Die exactly between the main rename and the sidecar rename.
    assert.throws(() => prepareLedgerFile({ databasePath, onStep: crashAt("retired") }),
      code("storage"), "row: WAL crash window — the crash surfaces as a storage refusal");
    assert.equal(existsSync(databasePath), false,
      "row: WAL crash window — the main path is absent");
    assert.equal(existsSync(backup), true,
      "row: WAL crash window — the old file is retired under its backup name");
    assert.equal(existsSync(`${backup}-wal`), false,
      "row: WAL crash window — the sidecars have not moved yet");
    assert.equal(existsSync(`${databasePath}-wal`), true,
      "row: WAL crash window — the uncheckpointed WAL survives the crash beside the absent main");

    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await eventKinds(ledger), ["prepared", "breaker-announced"],
        "row: WAL — frames that existed only in the WAL were migrated");
      assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall,
        "row: WAL — the archived bytes survive");
    } finally { await ledger.close(); }
    assert.equal(existsSync(`${backup}-wal`), true,
      "row: WAL — recovery moved the WAL under the backup name, so the backup stays complete");
    assert.equal(existsSync(`${databasePath}-wal`), false,
      "row: WAL — no stale sidecar remains beside the promoted main");
  });
}

/** A separate process holding the migration lock, so the collision is a real two-process race. */
function holdMigrationLock(lockPath: string, holdMs = 10_000): Promise<ChildProcess> {
  const holder = `
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CREMATOR_MIGRATION_LOCK,
      JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "other-process" }), { flag: "wx" });
    process.stdout.write("locked\\n");
    setTimeout(() => {
      try { require("node:fs").unlinkSync(process.env.CREMATOR_MIGRATION_LOCK); } catch {}
    }, Number(process.env.CREMATOR_HOLD_MS));
  `;
  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", holder], {
      env: { ...process.env, CREMATOR_MIGRATION_LOCK: lockPath, CREMATOR_HOLD_MS: String(holdMs) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.on("error", reject);
    child.stdout?.on("data", chunk => {
      if (String(chunk).includes("locked")) resolve(child);
    });
    child.on("exit", exitCode => reject(
      new Error(`migration lock holder exited early (${String(exitCode)})`)));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TS_HOOK_URL = pathToFileURL(join(REPO_ROOT, "scripts", "ts-resolve-hooks.mjs")).href;
const LEDGER_SOURCE_URL = pathToFileURL(
  join(REPO_ROOT, "packages", "core", "src", "ledger", "sqlite-ledger.ts")).href;
const MEMORY_STORE_URL = pathToFileURL(
  join(REPO_ROOT, "packages", "core", "src", "ledger", "memory-blob-store.ts")).href;

/**
 * A child that loads the ledger sources, signals ready, then waits for the
 * parent's go file before opening. Eight of these start their open together,
 * which is the shape that used to lose six or seven of eight to the lock.
 */
const OPENER_SCRIPT = `
  import { existsSync } from "node:fs";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { SqliteLedger } = await import(process.env.CREMATOR_LEDGER_SOURCE);
  const { MemoryBlobStore } = await import(process.env.CREMATOR_STORE_SOURCE);
  process.stdout.write("ready\\n");
  while (!existsSync(process.env.CREMATOR_GO)) await sleep(2);
  const ledger = await SqliteLedger.open({
    databasePath: process.env.CREMATOR_LEDGER_DB,
    blobStore: new MemoryBlobStore(),
    clock: { nowMs: () => 100 },
  });
  await ledger.close();
`;

interface LedgerOpener {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
}

/** One child process that opens `databasePath`; `ready` means its sources are loaded. */
function spawnLedgerOpener(databasePath: string, goPath: string): LedgerOpener {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--no-warnings", "--import", TS_HOOK_URL,
    "--input-type=module", "-e", OPENER_SCRIPT,
  ], {
    env: {
      ...process.env,
      CREMATOR_LEDGER_DB: databasePath,
      CREMATOR_GO: goPath,
      CREMATOR_LEDGER_SOURCE: LEDGER_SOURCE_URL,
      CREMATOR_STORE_SOURCE: MEMORY_STORE_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.stdout?.on("data", chunk => {
      if (String(chunk).includes("ready")) resolve();
    });
    child.on("exit", exitCode => reject(
      new Error(`ledger opener exited before ready (${String(exitCode)}): ${stderr}`)));
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", exitCode => exitCode === 0
      ? resolve()
      : reject(new Error(`ledger opener failed (${String(exitCode)}): ${stderr}`)));
  });
  // Both are awaited by the test; this just keeps an early sibling failure from
  // surfacing later as an unhandled rejection.
  void ready.catch(() => {});
  void done.catch(() => {});
  return { child, ready, done };
}

/** two processes open the same legacy file: the loser refuses by name and removes nothing */
async function concurrentMigration(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    await writeLegacyFile(databasePath, blobStore);
    const staging = `${databasePath}${MIGRATION_STAGING_SUFFIX}`;
    writeFileSync(staging, "the other opener's staged rebuild");
    const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    const child = await holdMigrationLock(lockPath);
    try {
      assert.throws(() => prepareLedgerFile({ databasePath }),
        (error: unknown) => error instanceof LedgerError && error.code === "storage" &&
          /migration is already in progress/.test(error.message) &&
          error.message.includes(lockPath),
        "row: concurrent migration — the loser waits out its bound, then refuses by name and names the lock");
      assert.equal(readFileSync(staging, "utf8"), "the other opener's staged rebuild",
        "row: concurrent migration — the loser deletes no other opener's staging");
      assert.equal(existsSync(lockPath), true,
        "row: concurrent migration — the winner's lock is untouched");
      assert.equal(pragmas(databasePath).version, LEGACY_SCHEMA_VERSION,
        "row: concurrent migration — the loser did not rebuild the legacy file");
    } finally { await stopChild(child); }
  });
}

/** eight processes open one already-current ledger at the same instant: all succeed, no row is lost */
async function simultaneousCurrentOpens(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    await writeLegacyFile(databasePath, blobStore);
    // The first open migrates; every process below opens the resulting current file.
    await SqliteLedger.open({ databasePath, blobStore, clock }).then(ledger => ledger.close());
    const before = tableCounts(databasePath);
    assert.ok((before["ledger_events"] ?? 0) > 0, "row: 8 opens — the fixture has rows to lose");
    // A live owner's lock sits beside the current file. Taking the lock on
    // every open (the regression) made these eight opens fail each other;
    // holding it here makes that failure deterministic instead of a race.
    const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    const holder = await holdMigrationLock(lockPath);
    try {
      const goPath = join(root, "go");
      const openers = Array.from({ length: 8 }, () => spawnLedgerOpener(databasePath, goPath));
      try {
        await Promise.all(openers.map(opener => opener.ready));
        writeFileSync(goPath, "");
        await Promise.all(openers.map(opener => opener.done));
      } finally {
        await Promise.all(openers.map(opener => stopChild(opener.child)));
      }
      assert.equal(existsSync(lockPath), true,
        "row: 8 opens — an already-current ledger never touches the owner's lock");
    } finally { await stopChild(holder); }
    assert.deepEqual(tableCounts(databasePath), before,
      "row: 8 opens — every row survives and no row is added");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await eventKinds(ledger), ["prepared"], "row: 8 opens — the history still reads");
    } finally { await ledger.close(); }
  });
}

/** a waiter retries a live migration lock, then completes the migration when the owner releases */
async function migrationRetry(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore);
    const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    const child = await holdMigrationLock(lockPath, 1_000);
    try {
      const started = Date.now();
      const outcome = prepareLedgerFile({ databasePath });
      const waitedMs = Date.now() - started;
      assert.equal(outcome.status, "migrated",
        "row: retry — the waiter migrates once the owner releases");
      assert.ok(waitedMs >= 250,
        `row: retry — the waiter retried for ${String(waitedMs)}ms instead of failing at once`);
      assert.deepEqual(pragmas(databasePath),
        { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, "row: retry — header");
      const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
      try {
        assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall,
          "row: retry — the archived bytes survive");
        assert.deepEqual(await eventKinds(ledger), ["prepared"], "row: retry — events survive");
      } finally { await ledger.close(); }
    } finally { await stopChild(child); }
  });
}

/** a missing main beside a backup with no complete staging is refused, and a foreign file is never overwritten */
async function refusalEdges(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    await writeLegacyFile(databasePath, blobStore);
    await SqliteLedger.open({ databasePath, blobStore, clock }).then(ledger => ledger.close());
    const backup = `${databasePath}${LEGACY_BACKUP_SUFFIX}`;
    const backupSha = fileSha(backup);
    rmSync(databasePath, { force: true });
    await assert.rejects(SqliteLedger.open({ databasePath, blobStore, clock }),
      (error: unknown) => error instanceof LedgerError && error.code === "storage" &&
        /no complete rebuild is staged/.test(error.message),
    "row: missing main — refused as storage, never silently empty");
    assert.equal(existsSync(databasePath), false,
      "row: missing main — no empty ledger was created over the history");
    assert.equal(fileSha(backup), backupSha, "row: missing main — the backup is untouched");

    // A foreign file at the main path is refused by its header, not overwritten.
    writeFileSync(databasePath, "not a database, just text that is long enough to fill a header block");
    const before = fileSha(databasePath);
    await assert.rejects(SqliteLedger.open({ databasePath,
      blobStore: new MemoryBlobStore(), clock }),
    (error: unknown) => error instanceof LedgerError && error.code === "unsupported-schema" &&
      /Not a SQLite database/.test(error.message),
    "row: foreign file — refused by name");
    assert.equal(fileSha(databasePath), before, "row: foreign file — the file was not written");
  });
}

/** a crash that left a complete v2 staging file promotes it, then rebuilds it to schema 3 */
async function v2StagingPromotion(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    const seed = await writeLegacyFile(databasePath, blobStore);
    // The shape schema 2's own migration leaves when it dies between retire and
    // promote: no main, a v1 backup, a complete staging file named `.v2.tmp`.
    const v2Staging = `${databasePath}.v2.tmp`;
    const v2 = new DatabaseSync(v2Staging);
    try {
      v2.exec("PRAGMA journal_mode = DELETE");
      v2.exec("PRAGMA foreign_keys = ON");
      seedLegacy(v2, seed, PREVIOUS_SCHEMA_VERSION);
      // A real staged file was written by `initializeSchema`, which stamps both
      // header values; reproduce them or the staging file is not promotable.
      v2.exec(`PRAGMA application_id = ${LEDGER_APPLICATION_ID}`);
      v2.exec(`PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION}`);
    } finally { v2.close(); }
    const v1Bytes = fileSha(databasePath);
    renameSync(databasePath, `${databasePath}${LEGACY_BACKUP_SUFFIX}`);
    const v2Bytes = fileSha(v2Staging);
    const outcome = prepareLedgerFile({ databasePath });
    assert.equal(outcome.status, "resumed", "row: v2 staging — the crash is resumed");
    assert.deepEqual(pragmas(databasePath),
      { version: SCHEMA_VERSION, applicationId: LEDGER_APPLICATION_ID }, "row: v2 staging — header");
    // The v2 staging was promoted, so it is now the retired v2 file.
    assert.equal(fileSha(`${databasePath}${VERDICT_BACKUP_SUFFIX}`), v2Bytes,
      "row: v2 staging — the promoted file is retired under the v2 name");
    assert.equal(fileSha(`${databasePath}${LEGACY_BACKUP_SUFFIX}`), v1Bytes,
      "row: v2 staging — the earlier v1 backup is untouched");
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall, "row: v2 staging — bytes survive");
      assert.deepEqual(await eventKinds(ledger), ["prepared"], "row: v2 staging — events survive");
    } finally { await ledger.close(); }
  });
}

// --- the tests -------------------------------------------------------------

/** release deletes only on a positive token match; an unreadable owner record is left to recovery (ISSUE-320) */
async function releaseOwnerGuard(): Promise<void> {
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    await writeLegacyFile(databasePath, blobStore);
    const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    // Corrupt the owner record while the migration holds the lock: release
    // can no longer confirm the lock is this process's (a successor's partial
    // owner write looks exactly like this), so it must not delete.
    const outcome = prepareLedgerFile({ databasePath, onStep: step => {
      if (step === "staged") writeFileSync(lockPath, "not json");
    }});
    assert.equal(outcome.status, "migrated",
      "row: release guard — the migration itself completes");
    assert.equal(existsSync(lockPath), true,
      "row: release guard — an unreadable owner record leaves the lock for stale recovery (ISSUE-320)");
  });
  await withTemp(async root => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new FileBlobStore(join(root, "blobs"));
    await writeLegacyFile(databasePath, blobStore);
    const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    // A readable successor's record: the existing token guard keeps it too.
    const outcome = prepareLedgerFile({ databasePath, onStep: step => {
      if (step === "staged") {
        writeFileSync(lockPath,
          JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "successor" }));
      }
    }});
    assert.equal(outcome.status, "migrated",
      "row: release guard — the migration itself completes");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "successor",
      "row: release guard — a readable successor's lock survives byte-exact");
  });
}

test("schema 3 pins its version, application id, and the proof and forget operation kinds", async () => {
  await schemaPins();
});

test("a version 1 and a version 2 file both migrate into schema 3 and keep their rows", async () => {
  await v1Migration();
  await v2Migration();
});

test("the main path stays whole wherever a migration dies, and the next open recovers", async () => {
  await crashMatrix();
  await v2StagingPromotion();
  await walCrash();
});

test("a concurrent migration refuses by name and deletes no other opener's staging", async () => {
  await concurrentMigration();
});

test("lock release deletes only on a positive owner-token match", async () => {
  await releaseOwnerGuard();
});

/** an ownerless migration lock (crash window) is recovered at once, not waited out (ISSUE-321) */
async function ownerlessLockRecovery(): Promise<void> {
  for (const [label, content] of [["empty", ""], ["partial write", '{"pid":']] as const) {
    await withTemp(async root => {
      const databasePath = join(root, "ledger.sqlite");
      const blobStore = new FileBlobStore(join(root, "blobs"));
      const seed = await writeLegacyFile(databasePath, blobStore);
      const lockPath = `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
      // Fresh mtime, no readable owner: a crash between creating the lock
      // and writing its owner record. Freshness must not judge it live.
      writeFileSync(lockPath, content);
      const outcome = prepareLedgerFile({ databasePath });
      assert.equal(outcome.status, "migrated",
        `row: ownerless lock (${label}) — the crash-window lock is recovered, not waited out (ISSUE-321)`);
      assert.equal(existsSync(lockPath), false,
        `row: ownerless lock (${label}) — the recovered lock is released`);
      const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
      try {
        assert.deepEqual(await ledger.recall(seed.recall.id), seed.recall,
          `row: ownerless lock (${label}) — the archived bytes survive`);
      } finally { await ledger.close(); }
    });
  }
}

test("an ownerless migration lock from a crash window is recovered without waiting out the age bound", async () => {
  await ownerlessLockRecovery();
});

/** the stale-lock restore never clobbers a successor that claimed the path mid-restore (ISSUE-365) */
function restoreNoClobber(): void {
  const tombstones = (root: string): string[] =>
    readdirSync(root).filter(entry => entry.includes(".stale-"));
  // The race: a live lock was judged stale, and a successor claims the path
  // while the tombstone is being verified. The seam runs exactly there.
  withTemp(root => {
    const lockPath = join(root, `ledger.sqlite${MIGRATION_LOCK_SUFFIX}`);
    writeFileSync(lockPath,
      JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "displaced-live" }));
    breakStaleMigrationLock(lockPath, () => {
      writeFileSync(lockPath,
        JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "successor" }));
    });
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "successor",
      "row: restore — the successor's lock survives the restore (ISSUE-365)");
    assert.deepEqual(tombstones(root), [], "row: restore — no tombstone remains");
  });
  // Control: no successor — the displaced live lock is restored byte-exact.
  withTemp(root => {
    const lockPath = join(root, `ledger.sqlite${MIGRATION_LOCK_SUFFIX}`);
    const live = JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "displaced-live" });
    writeFileSync(lockPath, live);
    breakStaleMigrationLock(lockPath);
    assert.equal(readFileSync(lockPath, "utf8"), live,
      "row: restore — with no successor the live lock is restored byte-exact");
    assert.deepEqual(tombstones(root), [], "row: restore — no tombstone remains");
  });
  // Control: a genuinely stale lock is still removed.
  withTemp(root => {
    const lockPath = join(root, `ledger.sqlite${MIGRATION_LOCK_SUFFIX}`);
    writeFileSync(lockPath,
      JSON.stringify({ pid: 2_147_483_647, atMs: Date.now(), token: "dead" }));
    breakStaleMigrationLock(lockPath);
    assert.equal(existsSync(lockPath), false,
      "row: restore — a dead owner's lock is removed");
    assert.deepEqual(tombstones(root), [], "row: restore — no tombstone remains");
  });
}

test("the stale-lock restore puts a live lock back without clobbering a successor", () => {
  restoreNoClobber();
});

test("eight simultaneous opens of an already-current ledger all succeed and keep every row", async () => {
  await simultaneousCurrentOpens();
});

test("a migration in progress is retried, then completed when the owner releases", async () => {
  await migrationRetry();
});

test("plan refusals write nothing, and a fresh or current path reports itself with no rebuild", async () => {
  await planRefusals();
  await freshAndCurrent();
});

test("a second migration keeps both backups, and a re-read, a missing main or a foreign file is refused", async () => {
  await idempotenceAndReread();
  await postMigrationRevert();
  await refusalEdges();
});
