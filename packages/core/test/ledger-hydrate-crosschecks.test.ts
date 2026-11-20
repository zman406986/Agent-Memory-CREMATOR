import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { encodeRecallManifest } from "../src/ledger/manifest.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { LedgerArchive, LedgerEntry } from "../src/ledger/types.js";
import type { Bytes } from "../src/types/identity.js";
import { canonicalBytesWithByteArrays, fromBytes } from "../src/util/bytes.js";
import { sha256 } from "../src/util/hash.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";

/**
 * Hydrate enforces the live write path's cross-checks (ISSUE-316). An archive
 * edited off-line with a recomputed digest must not plant a prepared event
 * whose hash disagrees with its intent, an applied receipt that disagrees with
 * the prepared intent, an event naming a different intent than its payload, or
 * a recall whose manifest belongs to another session — `appendEvent` and
 * `verifyApplication` refuse all of these on the live path.
 */

const clock = { nowMs: () => 100 };
const fact = (expected: string, pattern: RegExp) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected && pattern.test(error.message);
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

function withTemp<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "racoons-crosscheck-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

type Opener = (name: string) => Promise<SqliteLedger>;

async function withLedgers(body: (open: Opener) => Promise<void>): Promise<void> {
  await withTemp(async root => {
    const opened: SqliteLedger[] = [];
    const open: Opener = async name => {
      const ledger = await SqliteLedger.open({
        databasePath: join(root, `${name}.sqlite`),
        blobStore: new FileBlobStore(join(root, `${name}-blobs`)),
        clock,
      });
      opened.push(ledger);
      return ledger;
    };
    try { await body(open); } finally {
      for (const ledger of opened) await ledger.close();
    }
  });
}

const ORIGINAL: Bytes = new Uint8Array([
  239, 187, 191, 104, 101, 97, 100, 13, 10, 98, 111, 100, 121, 10, 231, 154, 132, 255,
]);

/** A seeded source ledger: one archived read, retracted by an applied receipt. */
async function seeded(open: Opener): Promise<{ ledger: SqliteLedger; recallId: string }> {
  const ledger = await open("source");
  const recall = await recallFixture([ORIGINAL, bytes("second part\r\n")]);
  const intent = await ledger.prepare(await applicationFixture(recall));
  await ledger.append({
    kind: "applied", eventKey: `applied:${intent.intentId}`, sessionId: intent.sessionId,
    atMs: 110, receipt: { ...intent, resultRevision: "revision-2", appliedAtMs: 109 },
  });
  return { ledger, recallId: recall.id };
}

/** An archive whose digest is recomputed over an edited document. */
async function forge(
  archive: LedgerArchive, edit: (document: Record<string, unknown>) => void,
): Promise<LedgerArchive> {
  const document = JSON.parse(fromBytes(archive.bytes)) as Record<string, unknown>;
  edit(document);
  const forged: Bytes = canonicalBytesWithByteArrays(document);
  return { sessionId: archive.sessionId, archiveSha256: await sha256(forged), bytes: forged };
}

function tableRows(document: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const tables = document["tables"] as Record<string, Record<string, unknown>[]>;
  const rows = tables[name];
  assert.ok(rows !== undefined, `the fixture exports ${name} rows`);
  return rows;
}

function eventRow(document: Record<string, unknown>, kind: string): Record<string, unknown> {
  const row = tableRows(document, "ledger_events").find(candidate => candidate["kind"] === kind);
  assert.ok(row !== undefined, `the fixture exports a ${kind} event`);
  return row;
}

function editPayload(
  row: Record<string, unknown>, edit: (payload: Record<string, unknown>) => void,
): void {
  const payload = JSON.parse(String(row["payload_json"])) as Record<string, unknown>;
  edit(payload);
  row["payload_json"] = JSON.stringify(payload);
}

async function collect(ledger: SqliteLedger, sessionId = "session-1"): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) entries.push(entry);
  return entries;
}

const CROSSCHECK_ROWS: readonly {
  readonly name: string;
  readonly message: RegExp;
  readonly edit: (document: Record<string, unknown>) => void;
}[] = [
  { name: "a prepared hash that disagrees with its intent", message: /prepared hash/iu,
    edit: document => {
      editPayload(eventRow(document, "prepared"), payload => {
        payload["applicationSha256"] = "0".repeat(64);
      });
    } },
  { name: "a receipt base revision that disagrees with its intent", message: /receipt/iu,
    edit: document => {
      editPayload(eventRow(document, "applied"), payload => {
        (payload["receipt"] as Record<string, unknown>)["baseRevision"] = "revision-9";
      });
    } },
  { name: "a receipt session that differs from the event's session", message: /receipt/iu,
    edit: document => {
      editPayload(eventRow(document, "applied"), payload => {
        (payload["receipt"] as Record<string, unknown>)["sessionId"] = "session-2";
      });
    } },
  { name: "an applied event carrying no receipt", message: /receipt/iu,
    edit: document => {
      editPayload(eventRow(document, "applied"), payload => { delete payload["receipt"]; });
    } },
];

test("an edited archive that recomputes its digest is refused by the live path's cross-checks", async () => {
  for (const row of CROSSCHECK_ROWS) {
    await withLedgers(async open => {
      const { ledger: source, recallId } = await seeded(open);
      const target = await open("target");
      const archive = await source.export("session-1");
      const forged = await forge(archive, row.edit);
      assert.notEqual(forged.archiveSha256, archive.archiveSha256,
        `row: ${row.name} — the edit is covered by the archive digest`);
      await assert.rejects(target.hydrate(forged), fact("hash-mismatch", row.message),
        `row: ${row.name} — the refusal names the broken cross-check`);
      assert.deepEqual(await collect(target), [], `row: ${row.name} — nothing was imported`);
      await assert.rejects(target.recall(recallId), code("not-found"),
        `row: ${row.name} — the refused recall is not reachable`);
    });
  }
});

test("an event whose session differs from its intent is refused", async () => {
  await withLedgers(async open => {
    const { ledger: source } = await seeded(open);
    const target = await open("target");
    const archive = await source.export("session-1");
    // The row and its payload move together, so `decodeEntry` still reads it;
    // the session gate (assertSessionRows / the intent cross-check) must refuse.
    const forged = await forge(archive, document => {
      const row = eventRow(document, "prepared");
      row["session_id"] = "session-2";
      editPayload(row, payload => { payload["sessionId"] = "session-2"; });
    });
    await assert.rejects(target.hydrate(forged), fact("hash-mismatch", /session/iu));
    assert.deepEqual(await collect(target), []);
  });
});

test("an event naming a different intent than its payload is refused", async () => {
  await withLedgers(async open => {
    const source = await open("source");
    const first = await source.prepare(await applicationFixture());
    const second = await source.prepare({ ...await applicationFixture(), eventId: "event-2" });
    const target = await open("target");
    const archive = await source.export("session-1");
    const forged = await forge(archive, document => {
      const row = tableRows(document, "ledger_events")
        .find(candidate => candidate["intent_id"] === first.intentId);
      assert.ok(row !== undefined, "the first intent has a prepared event");
      editPayload(row, payload => { payload["intentId"] = second.intentId; });
    });
    await assert.rejects(target.hydrate(forged), fact("hash-mismatch", /intent/iu));
    assert.deepEqual(await collect(target), []);
  });
});

test("a recall whose manifest belongs to another session is refused", async () => {
  await withLedgers(async open => {
    const { ledger: source } = await seeded(open);
    const target = await open("target");
    const archive = await source.export("session-1");
    // The same parts under a session-2 manifest: every hash re-derived, so only
    // the manifest's session can refuse it.
    const wrong = await recallFixture([ORIGINAL, bytes("second part\r\n")], "session-2");
    const manifestBytes = encodeRecallManifest(wrong.manifest);
    const forged = await forge(archive, document => {
      const recallRow = tableRows(document, "recalls")[0];
      assert.ok(recallRow !== undefined, "the fixture exports one recall");
      const oldHash = String(recallRow["manifest_sha256"]);
      const oldId = String(recallRow["recall_id"]);
      const bodies = document["blobs"] as { sha256: string; bytes: number[] }[];
      const body = bodies.find(candidate => candidate.sha256 === oldHash);
      assert.ok(body !== undefined, "the manifest body travels in the archive");
      body.sha256 = wrong.manifestSha256;
      body.bytes = [...manifestBytes];
      const blobRow = tableRows(document, "blobs")
        .find(candidate => candidate["sha256"] === oldHash);
      assert.ok(blobRow !== undefined, "the manifest has a blob row");
      blobRow["sha256"] = wrong.manifestSha256;
      blobRow["byte_length"] = manifestBytes.byteLength;
      recallRow["manifest_sha256"] = wrong.manifestSha256;
      recallRow["recall_id"] = wrong.id;
      for (const name of ["recall_parts", "removed_spans", "application_removals"]) {
        for (const row of tableRows(document, name)) {
          if (row["recall_id"] === oldId) row["recall_id"] = wrong.id;
        }
      }
    });
    await assert.rejects(target.hydrate(forged), fact("hash-mismatch", /session/iu));
    assert.deepEqual(await collect(target), []);
  });
});

test("a valid archive still hydrates", async () => {
  await withLedgers(async open => {
    const { ledger: source, recallId } = await seeded(open);
    const target = await open("target");
    const archive = await source.export("session-1");
    assert.deepEqual(await target.hydrate(archive),
      { sessionId: "session-1", events: 2, recalls: 1 });
    assert.deepEqual(await collect(target), await collect(source));
    assert.deepEqual(await target.recall(recallId), await source.recall(recallId));
  });
});