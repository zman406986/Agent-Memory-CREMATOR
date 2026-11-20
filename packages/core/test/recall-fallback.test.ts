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
import type { IndexedRecall, IndexedSourceReader } from "../src/ledger/source-reader.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { SourceFallbackRequest } from "../src/ledger/types.js";
import type { Bytes, RecallId } from "../src/types/identity.js";
import { sha256 } from "../src/util/hash.js";
import { applicationFixture, recallFixture } from "./ledger-fixtures.js";

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

/** A reader that records every request and answers with fixed bytes. */
function spyReader(index: readonly IndexedRecall[], answer: Bytes): IndexedSourceReader & {
  readonly requests: SourceFallbackRequest[];
  readonly located: RecallId[];
} {
  const requests: SourceFallbackRequest[] = [];
  const located: RecallId[] = [];
  const reader = new FileSourceReader(index);
  return {
    requests, located,
    locate: (id: RecallId) => { located.push(id); return reader.locate(id); },
    read: async (request: SourceFallbackRequest) => { requests.push(request); return answer; },
  };
}

/** BOM, CRLF, a lone CR and multibyte text: the bytes a round trip must not normalise. */
const original = new Uint8Array([
  239, 187, 191, 104, 101, 97, 100, 13, 10, 98, 111, 100, 121, 10, 108, 97, 115, 116,
  239, 187, 191, 13, 10, 231, 154, 132, 32, 100, 97, 116, 97, 255,
]);

/** A temp root the row owns and removes, whatever the row does. */
async function withRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/**
 * What a read of an unbaked source may and may not answer.
 *
 * Every row starts from the same record — minted when the file held `original`
 * — and one row per hazard: the bytes changed under it, the bytes grew, the
 * file went away, or the index disagrees about which record it is. A reader that
 * answered any of them would be substituting bytes the record never described,
 * which is the one thing the fallback lane may never do.
 */
interface Scene {
  readonly root: string;
  readonly path: string;
  readonly expected: Awaited<ReturnType<typeof recallFixture>>;
  readonly ledger: SqliteLedger;
}

const CASES: readonly {
  readonly name: string;
  readonly run: (scene: Scene) => Promise<void>;
}[] = [
  {
    name: "same-length edited bytes are a refusal, never a substitute",
    run: async ({ path, expected, ledger }) => {
      writeFileSync(path, original);
      const reader = new FileSourceReader([{ recallId: expected.id, manifest: expected.manifest, paths: [path] }]);
      // Same length, one byte different: a length check alone would pass this.
      const edited = Uint8Array.from(original);
      edited[3] = (edited[3] ?? 0) ^ 0xff;
      writeFileSync(path, edited);
      assert.equal(edited.byteLength, original.byteLength,
        `row: ${CASES[1]?.name} — the edit keeps the length, so only a hash check catches it`);
      await assert.rejects(ledger.recall(expected.id, { reader }), code("hash-mismatch"));
    },
  },
  {
    name: "a longer source file is refused, never truncated to fit",
    run: async ({ path, expected, ledger }) => {
      writeFileSync(path, new Uint8Array([...original, 32]));
      const reader = new FileSourceReader([{ recallId: expected.id, manifest: expected.manifest, paths: [path] }]);
      await assert.rejects(ledger.recall(expected.id, { reader }), code("hash-mismatch"));
    },
  },
  {
    name: "a deleted source file is a miss on that path",
    run: async ({ path, expected, ledger }) => {
      rmSync(path);
      const reader = new FileSourceReader([{ recallId: expected.id, manifest: expected.manifest, paths: [path] }]);
      // A file that is gone is a miss on that path, not a claim about its bytes.
      await assert.rejects(ledger.recall(expected.id, { reader }), code("not-found"));
    },
  },
  {
    name: "no reader and an unknown id both stay not-found",
    run: async ({ path, expected, ledger }) => {
      writeFileSync(path, original);
      await assert.rejects(ledger.recall(expected.id), code("not-found"));
      // An index that does not know the id answers nothing; it never reads a file
      // named by a guess.
      const empty = new FileSourceReader([]);
      await assert.rejects(ledger.recall(expected.id, { reader: empty }), code("not-found"));
      // A malformed id is refused before any lookup.
      await assert.rejects(ledger.recall("recall:sha256:not-a-hash", { reader: empty }),
        code("not-found"));
      // A reader with no lookup cannot name a path or an expected hash; its bytes
      // would be a guess, so the miss stays a miss and the reader is never called.
      let readCalls = 0;
      const lookupLess = { read: async (_request: SourceFallbackRequest) => {
        readCalls++; return original;
      } };
      await assert.rejects(ledger.recall(expected.id, { reader: lookupLess }), code("not-found"));
      assert.equal(readCalls, 0,
        `row: ${CASES[4]?.name} — a reader without an index is never asked for bytes`);
    },
  },
  {
    name: "an index record that disagrees with the requested id is refused",
    run: async ({ path, expected, ledger }) => {
      writeFileSync(path, original);
      const otherId = `recall:sha256:${"ab".repeat(32)}`;
      const reader = spyReader([{ recallId: otherId, manifest: expected.manifest, paths: [path] }], original);
      await assert.rejects(ledger.recall(otherId, { reader }), code("hash-mismatch"));
      assert.equal(reader.requests.length, 0,
        `row: ${CASES[5]?.name} — a mismatched index record must not read a file`);
      // An index that names the wrong number of files for the manifest is refused.
      const short = new FileSourceReader([
        { recallId: expected.id, manifest: expected.manifest, paths: [] },
      ]);
      await assert.rejects(ledger.recall(expected.id, { reader: short }), code("hash-mismatch"));
    },
  },
  {
    name: "an unchanged source answers the same record the banked lane returns",
    run: async ({ path, expected, ledger }) => {
      const reader = spyReader([{ recallId: expected.id, manifest: expected.manifest, paths: [path] }], original);
      const fromSource = await ledger.recall(expected.id, { reader });
      // Same record the banked lane returns: a caller cannot tell which lane answered.
      assert.deepEqual(fromSource, expected,
        `row: ${CASES[0]?.name} — the source lane's record equals the banked one field for field`);
      // The reader was asked for this part's exact source and manifest ranges.
      const request = reader.requests[0];
      assert.ok(request !== undefined, `row: ${CASES[0]?.name} — the reader was asked for the bytes`);
      assert.equal(request.path, path, `row: ${CASES[0]?.name} — the request names the indexed path`);
      assert.deepEqual(request.source, expected.manifest.parts[0]?.source,
        `row: ${CASES[0]?.name} — the request carries the part's source identity`);
      assert.deepEqual(request.ranges, [{ startByte: 0, endByteExclusive: original.byteLength }],
        `row: ${CASES[0]?.name} — the request asks for exactly the manifest's removed ranges`);
      // Now bank it: the ledger lane answers the same bytes, so the two lanes agree.
      await ledger.prepare(await applicationFixture(expected));
      assert.deepEqual(await ledger.recall(expected.id), fromSource,
        `row: ${CASES[0]?.name} — banking the record changes nothing the caller sees`);
    },
  },
];

test("source fallback — one row per hazard a read may meet", async () => {
  await withRoot("racoons-source-", async root => {
    const path = join(root, "source.ts");
    writeFileSync(path, original);
    const expected = await recallFixture([original]);
    const ledger = await SqliteLedger.open({ databasePath: ":memory:",
      blobStore: new MemoryBlobStore(), clock });
    try {
      for (const row of CASES) {
        // Order matters: the banking row runs last, so every earlier row meets an
        // unbaked record and is answered by the source lane, not the ledger lane.
        try { await row.run({ root, path, expected, ledger }); } catch (error) {
          throw new Error(`row: ${row.name} — ${error instanceof Error ? error.message : String(error)}`,
            { cause: error });
        }
      }
    } finally { await ledger.close(); }
  });
});

/**
 * A corrupt or absent ledger row is a refusal, never a reason to ask the source
 * index. Both halves start from the same hand-written row and the same reader,
 * and differ only in what the blob store says about the manifest blob: bytes
 * that hash differently, or no blob at all. Either way the fallback must not fire.
 */
test("a corrupt ledger row is refused, never answered from the source", async () => {
  await withRoot("racoons-corrupt-row-", async root => {
    const databasePath = join(root, "ledger.sqlite");
    const body = new TextEncoder().encode("original body");
    const bodyHash = await sha256(body);
    const manifest = buildRecallManifest("session", [{
      source: { nodeId: "node", sha256: bodyHash, byteLength: body.length },
      blobSha256: bodyHash, removedRanges: [{
        range: { startByte: 0, endByteExclusive: body.length }, sha256: bodyHash,
      }],
    }]);
    const manifestBytes = encodeRecallManifest(manifest);
    const manifestHash = await manifestSha256(manifest);
    const id = recallIdFor(manifestHash);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      initializeSchema(db);
      db.prepare("INSERT INTO blobs VALUES (?, ?, 1)").run(bodyHash, body.length);
      db.prepare("INSERT INTO blobs VALUES (?, ?, 1)").run(manifestHash, manifestBytes.length);
      db.prepare("INSERT INTO recalls VALUES (?, ?, 1)").run(id, manifestHash);
      db.prepare("INSERT INTO recall_parts VALUES (?, 0, 'node', ?, ?, ?)")
        .run(id, bodyHash, body.length, bodyHash);
      db.prepare("INSERT INTO removed_spans VALUES (?, 0, 0, 0, ?, ?)")
        .run(id, body.length, bodyHash);
    } finally { db.close(); }

    const memory = new MemoryBlobStore();
    await memory.put(body);
    const reader = spyReader([{ recallId: id, manifest, paths: [join(root, "source.ts")] }], body);
    // The manifest blob exists as a row but its bytes hash differently.
    const corrupt: BlobStore = {
      put: value => memory.put(value),
      get: async hash => hash === manifestHash ? new Uint8Array([0, 0, 0]) : memory.get(hash),
    };
    const corruptLedger = await SqliteLedger.open({ databasePath, blobStore: corrupt, clock });
    try {
      await assert.rejects(corruptLedger.recall(id, { reader }), code("hash-mismatch"));
      assert.equal(reader.located.length, 0,
        "row: corrupt manifest blob — a corrupt row must not consult the source index");
      assert.equal(reader.requests.length, 0,
        "row: corrupt manifest blob — a corrupt row must not read a source file");
    } finally { await corruptLedger.close(); }

    // A row whose manifest blob is missing is corruption too: `not-found` from the
    // blob store propagates, and the fallback never fires on it.
    const missingLedger = await SqliteLedger.open({
      databasePath, blobStore: new MemoryBlobStore(), clock,
    });
    try {
      await assert.rejects(missingLedger.recall(id, { reader }), code("not-found"));
      assert.equal(reader.requests.length, 0,
        "row: missing manifest blob — a missing blob is not a miss on the row");
    } finally { await missingLedger.close(); }
  });
});
