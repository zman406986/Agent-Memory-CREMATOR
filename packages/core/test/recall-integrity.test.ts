import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BlobStore } from "../src/ledger/blob-store.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import {
  buildRecallManifest, encodeRecallManifest, manifestSha256, recallIdFor,
} from "../src/ledger/manifest.js";
import { initializeSchema } from "../src/ledger/schema.js";
import { FileSourceReader } from "../src/ledger/source-reader.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import { sha256 } from "../src/util/hash.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

test("byte-exact recall across deterministic binary inputs and distinct source occurrences", async () => {
  const ledger = await SqliteLedger.open({ databasePath: ":memory:", blobStore: new MemoryBlobStore(), clock });
  try {
    let seed = 0x12345678;
    for (let caseIndex = 0; caseIndex < 24; caseIndex++) {
      // A deterministic body per part: no clock, no temp path, so a row that
      // fails names the case index rather than a run.
      const bodies = Array.from({ length: 1 + caseIndex % 4 }, (_, partIndex) => {
        const body = new Uint8Array((caseIndex * 23 + partIndex * 17) % 257);
        for (let i = 0; i < body.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          body[i] = seed >>> 24;
        }
        return body;
      });
      const recall = await recallFixture(bodies, `session-${caseIndex}`);
      await ledger.prepare(await applicationFixture(recall));
      assert.deepEqual((await ledger.recall(recall.id)).parts.map(part => part.bytes), bodies,
        `row: case ${String(caseIndex)} — every part must recall byte-exact, in order`);
    }
  } finally { await ledger.close(); }
});

/** A manifest whose one span names a hash the body does not have at that range. */
async function forgedSpanRecord(body: Uint8Array): Promise<{
  readonly manifest: ReturnType<typeof buildRecallManifest>;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: string;
  readonly bodyHash: string;
  readonly id: string;
}> {
  const bodyHash = await sha256(body);
  const manifest = buildRecallManifest("session", [{
    source: { nodeId: "node", sha256: bodyHash, byteLength: body.length },
    blobSha256: bodyHash, removedRanges: [{
      range: { startByte: 1, endByteExclusive: 4 }, sha256: "0".repeat(64),
    }],
  }]);
  const manifestBytes = encodeRecallManifest(manifest);
  const manifestHash = await manifestSha256(manifest);
  return { manifest, manifestBytes, manifestHash, bodyHash, id: recallIdFor(manifestHash) };
}

/**
 * Every lane that answers a recall must prove the REMOVED SPANS, not just the
 * whole body. The two span rows use the same forged manifest — a correct manifest
 * hash, a correct body hash, a wrong span hash — and differ only in whether the
 * bytes come from the ledger's blobs or from a source file; a check that only
 * verified the whole body would pass both, which is the defect they pin. The
 * third row is the same completeness rule on the other side: a record that holds
 * one readable part and one missing body is a miss, never a partial answer.
 */
const SPAN_ROWS: readonly (readonly [string, (record: Awaited<ReturnType<typeof forgedSpanRecord>>,
  root: string) => Promise<void>])[] = [
  ["the ledger lane refuses a wrong removed-span hash", async (record, root) => {
    const databasePath = join(root, "ledger.sqlite");
    const blobStore = new MemoryBlobStore();
    await blobStore.put(bytes("original"));
    await blobStore.put(record.manifestBytes);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      initializeSchema(db);
      db.prepare("INSERT INTO blobs VALUES (?, ?, 1)").run(record.bodyHash, 8);
      db.prepare("INSERT INTO blobs VALUES (?, ?, 1)").run(record.manifestHash, record.manifestBytes.length);
      db.prepare("INSERT INTO recalls VALUES (?, ?, 1)").run(record.id, record.manifestHash);
      db.prepare("INSERT INTO recall_parts VALUES (?, 0, 'node', ?, ?, ?)")
        .run(record.id, record.bodyHash, 8, record.bodyHash);
      db.prepare("INSERT INTO removed_spans VALUES (?, 0, 0, 1, 4, ?)").run(record.id, "0".repeat(64));
    } finally { db.close(); }
    const ledger = await SqliteLedger.open({ databasePath, blobStore, clock });
    try {
      await assert.rejects(ledger.recall(record.id), code("hash-mismatch"));
    } finally { await ledger.close(); }
  }],
  ["the source lane refuses a wrong removed-span hash", async (record, root) => {
    // The reader's bytes match the whole-body hash, so the body check passes.
    // The manifest's own span hash disagrees with the bytes at that range.
    const path = join(root, "source.ts");
    writeFileSync(path, bytes("original"));
    const reader = new FileSourceReader([{ recallId: record.id as never, manifest: record.manifest, paths: [path] }]);
    const ledger = await SqliteLedger.open({ databasePath: ":memory:",
      blobStore: new MemoryBlobStore(), clock });
    try {
      await assert.rejects(ledger.recall(record.id, { reader }), code("hash-mismatch"));
    } finally { await ledger.close(); }
  }],
  ["a missing later body rejects the whole record", async (_record, root) => {
    const memory = new MemoryBlobStore();
    let missing: string | undefined;
    const store: BlobStore = {
      put: body => memory.put(body),
      get: hash => hash === missing
        ? Promise.reject(new LedgerError("not-found", "Injected missing body"))
        : memory.get(hash),
    };
    const ledger = await SqliteLedger.open({ databasePath: join(root, "ledger.sqlite"), blobStore: store, clock });
    try {
      const recall = await recallFixture([bytes("first"), bytes("missing second")]);
      await ledger.prepare(await applicationFixture(recall));
      const later = recall.parts[1];
      assert.ok(later, "row: a missing later body — the fixture carries two parts");
      missing = later.source.sha256;
      await assert.rejects(ledger.recall(recall.id), code("not-found"));
    } finally { await ledger.close(); }
  }],
];

test("recall completeness — a wrong span hash or a missing part is a miss, on every lane", async () => {
  const body = bytes("original");
  const record = await forgedSpanRecord(body);
  const root = mkdtempSync(join(tmpdir(), "racoons-span-"));
  try {
    for (const [name, run] of SPAN_ROWS) {
      const lane = mkdtempSync(join(root, "lane-"));
      try {
        await run(record, lane);
      } catch (error) {
        throw new Error(`row: ${name} — the span hash must be proven, got ${
          error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
