import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARCHIVE_KIND } from "../src/ledger/export-file.js";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { LedgerArchive, LedgerEntry } from "../src/ledger/types.js";
import type { Bytes } from "../src/types/identity.js";
import { canonicalBytesWithByteArrays, fromBytes } from "../src/util/bytes.js";
import { sha256 } from "../src/util/hash.js";
import { applicationFixture, bytes, recallFixture } from "./ledger-fixtures.js";

/**
 * Export and hydrate (ISSUE-045 chunk C9, ADR-0019). One session becomes a
 * self-contained archive of rows, blobs and a manifest; hydrating it into
 * another ledger rebuilds the same session, and every disagreement in the
 * archive (its digest, a blob's hash, its declared session) is a refusal.
 */

const clock = { nowMs: () => 100 };
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;

/** Refusal whose message is the byte fact it names. */
const fact = (expected: string, pattern: RegExp) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected && pattern.test(error.message);

/** A temp directory that is always removed, even when an assertion fails. */
function withTemp<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "racoons-export-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function openLedger(root: string, name: string): Promise<SqliteLedger> {
  return SqliteLedger.open({
    databasePath: join(root, `${name}.sqlite`),
    blobStore: new FileBlobStore(join(root, `${name}-blobs`)),
    clock,
  });
}

async function collect(ledger: SqliteLedger, sessionId = "session-1"): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) entries.push(entry);
  return entries;
}

/** A ledger opened through the scenario's tracked opener, so it is always closed. */
type Opener = (name: string) => Promise<SqliteLedger>;

/** A seeded source ledger: one archived read, retracted by an applied receipt. */
async function seeded(open: Opener): Promise<{ ledger: SqliteLedger; recallId: string }> {
  const original = new Uint8Array([
    239, 187, 191, 104, 101, 97, 100, 13, 10, 98, 111, 100, 121, 10, 231, 154, 132, 255,
  ]);
  const ledger = await open("source");
  const recall = await recallFixture([original, bytes("second part\r\n")]);
  const application = await applicationFixture(recall);
  const intent = await ledger.prepare(application);
  await ledger.append({
    kind: "applied", eventKey: `applied:${intent.intentId}`, sessionId: intent.sessionId,
    atMs: 110, receipt: { ...intent, resultRevision: "revision-2", appliedAtMs: 109 },
  });
  return { ledger, recallId: recall.id };
}

/**
 * An archive whose digest is recomputed over an edited document: the edit
 * passes the archive digest, so only the per-element checks can refuse it.
 */
async function forge(
  archive: LedgerArchive, edit: (document: Record<string, unknown>) => void,
): Promise<LedgerArchive> {
  const document = JSON.parse(fromBytes(archive.bytes)) as Record<string, unknown>;
  edit(document);
  const forged: Bytes = canonicalBytesWithByteArrays(document);
  return { sessionId: archive.sessionId, archiveSha256: await sha256(forged), bytes: forged };
}

/** Runs one scenario in its own temp root, closing every ledger it opened. */
async function withLedgers(body: (open: Opener) => Promise<void>): Promise<void> {
  await withTemp(async root => {
    const opened: SqliteLedger[] = [];
    const open: Opener = async (name: string): Promise<SqliteLedger> => {
      const ledger = await openLedger(root, name);
      opened.push(ledger);
      return ledger;
    };
    try {
      await body(open);
    } finally {
      for (const ledger of opened) await ledger.close();
    }
  });
}

/**
 * One archive, one disagreement, one refusal. `edit` forges a document and
 * recomputes its digest, so each row is caught by the check it names and not by
 * the archive digest; `expect` names the code and the message fact.
 */
interface RefusalRow {
  readonly name: string;
  /** How the archive is broken. 'flip' and 'digest' edit the wrapper, not the bytes. */
  readonly break: "flip" | "digest" | "session" | "forge";
  /** Applied to the decoded document; only for a forged row. */
  readonly edit?: (document: Record<string, unknown>) => void;
  /** The canonical encoder is bypassed instead: the same document, other bytes. */
  readonly respell?: boolean;
  readonly code: string;
  readonly message: RegExp;
}

const REFUSAL_ROWS: readonly RefusalRow[] = [
  { name: "a flipped body byte breaks the archive digest", break: "flip",
    code: "hash-mismatch", message: /digest/iu },
  { name: "a rewritten digest matches no bytes", break: "digest",
    code: "hash-mismatch", message: /digest/iu },
  { name: "an archive claiming another session is refused", break: "session",
    code: "hash-mismatch", message: /session/iu },
  { name: "a blob whose bytes disagree with its hash is refused", break: "forge",
    edit: document => {
      const blobs = document["blobs"] as { bytes: number[] }[];
      const first = blobs[0];
      assert.ok(first !== undefined, "the fixture exports at least one blob");
      first.bytes[0] = ((first.bytes[0] ?? 0) + 1) % 256;
    }, code: "hash-mismatch", message: /blob/iu },
  { name: "an archive of another kind is refused", break: "forge",
    edit: document => { document["kind"] = "racoons:other-archive"; },
    code: "unsupported-schema", message: /RACOONS/iu },
  { name: "an archive of another version is refused", break: "forge",
    edit: document => { document["version"] = 2; },
    code: "unsupported-schema", message: /version/iu },
  { name: "a valid document re-spelled with other bytes is refused", break: "forge",
    respell: true, code: "hash-mismatch", message: /canonical/iu },
];

test("a disagreement in the archive is refused and imports nothing", async () => {
  for (const row of REFUSAL_ROWS) {
    await withLedgers(async open => {
      const { ledger: source, recallId } = await seeded(open);
      const target = await open("target");
      const archive = await source.export("session-1");
      let broken = archive;
      switch (row.break) {
        case "flip": {
          const flipped = new Uint8Array(archive.bytes);
          flipped[flipped.byteLength - 1] = (flipped[flipped.byteLength - 1] ?? 0) ^ 1;
          broken = { ...archive, bytes: flipped };
          break;
        }
        case "digest":
          broken = { ...archive, archiveSha256: "0".repeat(64) };
          break;
        case "session":
          broken = { ...archive, sessionId: "session-2" };
          break;
        case "forge":
          if (row.respell === true) {
            const document = JSON.parse(fromBytes(archive.bytes)) as Record<string, unknown>;
            const padded = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
            broken = { sessionId: archive.sessionId, archiveSha256: await sha256(padded),
              bytes: padded };
          } else {
            assert.ok(row.edit !== undefined, `row: ${row.name} — a forge row needs an edit`);
            broken = await forge(archive, row.edit);
            assert.notEqual(broken.archiveSha256, archive.archiveSha256,
              `row: ${row.name} — the edit is covered by the archive digest`);
          }
          break;
      }
      await assert.rejects(target.hydrate(broken), fact(row.code, row.message),
        `row: ${row.name} — the refusal names ${row.code}`);
      // Nothing of the refused archive landed, and its recall is not reachable.
      assert.deepEqual(await collect(target), [], `row: ${row.name} — nothing was imported`);
      await assert.rejects(target.recall(recallId), code("not-found"),
        `row: ${row.name} — the refused recall is not found`);
    });
  }
});

/** The archive document's rows for one table, as the forge helper sees them. */
function tableRows(document: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const tables = document["tables"] as Record<string, Record<string, unknown>[]> | undefined;
  const rows = tables?.[name];
  assert.ok(rows !== undefined, `the fixture exports ${name} rows`);
  return rows;
}

/**
 * An applied event's receipt as the archive carries it, edited for the
 * receipt-shape rows. The archive digest is recomputed after the edit, so only
 * `assertEventAgainstIntent` can refuse it (ISSUE-490).
 */
function editAppliedReceipt(
  document: Record<string, unknown>, edit: (receipt: Record<string, unknown>) => void,
): void {
  const row = tableRows(document, "ledger_events").find(entry => entry["kind"] === "applied");
  assert.ok(row !== undefined, "the fixture exports an applied event");
  const payload = JSON.parse(String(row["payload_json"])) as { receipt: Record<string, unknown> };
  edit(payload.receipt);
  row["payload_json"] = JSON.stringify(payload);
}

/**
 * The audit reproduction (ISSUE-261): each edit corrupts a fact a reader reads —
 * a span hash, a part length, an event payload, an event sequence — and `forge`
 * recomputes the archive digest over the edit. The archive digest therefore
 * passes; only the reader-shaped checks in `verifyArchive` can refuse it.
 */
const FORGED_READER_ROWS: readonly {
  readonly name: string;
  readonly message: RegExp;
  readonly edit: (document: Record<string, unknown>) => void;
}[] = [
  { name: "a span hash that disagrees with its manifest", message: /span/iu,
    edit: document => {
      const first = tableRows(document, "removed_spans")[0];
      assert.ok(first !== undefined, "the fixture exports at least one removed span");
      first["slice_sha256"] = "0".repeat(64);
    } },
  { name: "a part length that disagrees with its manifest", message: /part/iu,
    edit: document => {
      const first = tableRows(document, "recall_parts")[0];
      assert.ok(first !== undefined, "the fixture exports at least one recall part");
      first["source_byte_length"] = Number(first["source_byte_length"]) + 1;
    } },
  { name: "an event payload that disagrees with its row", message: /event/iu,
    edit: document => {
      const first = tableRows(document, "ledger_events")[0];
      assert.ok(first !== undefined, "the fixture exports at least one event");
      const payload = JSON.parse(String(first["payload_json"])) as Record<string, unknown>;
      payload["atMs"] = Number(payload["atMs"]) + 1;
      first["payload_json"] = JSON.stringify(payload);
    } },
  { name: "an event sequence outside 1..MAX_SAFE_INTEGER", message: /sequence/iu,
    edit: document => {
      const first = tableRows(document, "ledger_events")[0];
      assert.ok(first !== undefined, "the fixture exports at least one event");
      first["sequence"] = 0;
    } },
  { name: "a recall whose manifest hash names no blob", message: /names a missing manifest blob/iu,
    edit: document => {
      const first = tableRows(document, "recalls")[0];
      assert.ok(first !== undefined, "the fixture exports at least one recall");
      const forged = "0".repeat(64);
      first["manifest_sha256"] = forged;
      // Keep the id derived from the forged hash, so the id check passes and the
      // missing-body branch is the one that refuses.
      first["recall_id"] = `recall:sha256:${forged}`;
    } },
  // A receipt the engine's own reconciliation predicate can never accept
  // (`receiptMatches`): it lands durably and `committedState` blocks every pass
  // with no conflict row, so the boundary must refuse it by name (ISSUE-490).
  { name: "an applied receipt whose result revision equals its base revision",
    message: /receipt/iu,
    edit: document => editAppliedReceipt(document, receipt => {
      receipt["resultRevision"] = receipt["baseRevision"];
    }) },
  { name: "an applied receipt with an empty result revision", message: /receipt/iu,
    edit: document => editAppliedReceipt(document, receipt => {
      receipt["resultRevision"] = "";
    }) },
];

test("a forged archive that recomputes its digest is refused before it reports counts", async () => {
  for (const row of FORGED_READER_ROWS) {
    await withLedgers(async open => {
      const { ledger: source, recallId } = await seeded(open);
      const target = await open("target");
      const archive = await source.export("session-1");
      const forged = await forge(archive, row.edit);
      assert.notEqual(forged.archiveSha256, archive.archiveSha256,
        `row: ${row.name} — the edit is covered by the archive digest`);
      // No counts are returned: hydrate refuses the forged archive whole.
      await assert.rejects(target.hydrate(forged), fact("hash-mismatch", row.message),
        `row: ${row.name} — hydrate refuses instead of reporting counts`);
      assert.deepEqual(await collect(target), [], `row: ${row.name} — nothing was imported`);
      await assert.rejects(target.recall(recallId), code("not-found"),
        `row: ${row.name} — the forged recall is not reachable`);
    });
  }
});

/**
 * What a hydrate rebuilds, one row per archive shape: a seeded session, a
 * session that also has a sibling's rows, and a session with nothing in it.
 * Each row names the export's own claims about its bytes and the counts the
 * target must answer with.
 */
interface HydrateRow {
  readonly name: string;
  readonly kind: "seeded" | "sibling" | "empty";
  /**
   * A sibling session's row occupies sequence 1 in the target first, so the
   * archive's own sequence space is held by a different fact.
   */
  readonly occupied?: boolean;
  /** The code the hydrate must refuse with, instead of importing anything. */
  readonly refuse?: "idempotency-conflict";
  /** The counts a successful hydrate reports; null when the row is refused. */
  readonly counts: { readonly sessionId: string; readonly events: number;
    readonly recalls: number } | null;
  /** Event kinds the exported session must hold, in order. */
  readonly kinds: readonly string[];
}

const HYDRATE_ROWS: readonly HydrateRow[] = [
  { name: "a seeded session rebuilds its rows, sequence numbers and byte-exact recalls",
    kind: "seeded", counts: { sessionId: "session-1", events: 2, recalls: 1 },
    kinds: ["prepared", "applied"] },
  { name: "a session with a sibling carries only its own rows and blobs",
    kind: "sibling", counts: { sessionId: "session-1", events: 2, recalls: 1 },
    kinds: ["prepared", "applied"] },
  { name: "an empty session exports an empty archive and hydrates to zero counts",
    kind: "empty", counts: { sessionId: "session-empty", events: 0, recalls: 0 }, kinds: [] },
  { name: "an occupied sequence number is a conflict, never a renumbering",
    kind: "seeded", occupied: true, refuse: "idempotency-conflict", counts: null,
    kinds: ["prepared", "applied"] },
];

test("a hydrate rebuilds exactly the exported session, or refuses to renumber it", async () => {
  for (const row of HYDRATE_ROWS) {
    await withLedgers(async open => {
      const target = await open("target");
      const source = await open("source");
      let recallId: string | null = null;
      let otherRecallId: string | null = null;
      if (row.kind !== "empty") {
        const seededLedger = await seeded(open);
        recallId = seededLedger.recallId;
        if (row.kind === "sibling") {
          const otherRecall = await recallFixture([bytes("another session's body\n")], "session-2");
          otherRecallId = otherRecall.id;
          await source.prepare({
            ...await applicationFixture(otherRecall), sessionId: "session-2",
          });
        }
      }
      if (row.occupied === true) {
        await target.append({ kind: "breaker-announced", sessionId: "other",
          eventKey: "other-notice", atMs: 105, recordId: "notice" });
      }
      const sessionId = row.kind === "empty" ? "session-empty"
        : (row.counts?.sessionId ?? "session-1");
      const archive = await source.export(sessionId);
      assert.equal(archive.sessionId, sessionId, `row: ${row.name} — the archive's session`);
      assert.match(archive.archiveSha256, /^[0-9a-f]{64}$/u,
        `row: ${row.name} — the digest is a sha256`);
      assert.equal(ARCHIVE_KIND, "racoons:ledger-archive", `row: ${row.name} — the archive kind`);
      // Deterministic: the same unchanged session exports the same bytes.
      const again = await source.export(sessionId);
      assert.deepEqual(again.bytes, archive.bytes,
        `row: ${row.name} — the second export is byte-equal`);
      assert.equal(again.archiveSha256, archive.archiveSha256,
        `row: ${row.name} — and so is its digest`);

      const expected = await collect(source, sessionId);
      assert.deepEqual(expected.map(entry => entry.event.kind), row.kinds,
        `row: ${row.name} — the exported session's event kinds`);
      if (row.kind === "sibling") {
        const document = JSON.parse(fromBytes(archive.bytes)) as {
          sessionId: string;
          tables: Record<string, { session_id?: string }[]>;
          blobs: { sha256: string }[];
        };
        assert.equal(document.sessionId, sessionId,
          `row: ${row.name} — the document names one session`);
        assert.deepEqual(document.tables["ledger_events"]?.map(entry => entry["session_id"]),
          expected.map(() => sessionId), `row: ${row.name} — every archived row is the session's`);
      }

      if (row.refuse !== undefined) {
        await assert.rejects(target.hydrate(archive), code(row.refuse),
          `row: ${row.name} — the hydrate refuses with ${row.refuse}`);
        // Nothing of the archive landed: a refused merge is not a partial one.
        assert.deepEqual(await collect(target), [], `row: ${row.name} — nothing was imported`);
        assert.deepEqual((await collect(target, "other")).map(entry => entry.event.eventKey),
          ["other-notice"], `row: ${row.name} — the occupying row is untouched`);
        // Into a ledger whose sequence space is free, the same archive hydrates.
        const fresh = await open("fresh");
        await fresh.hydrate(archive);
        assert.deepEqual(await collect(fresh), expected,
          `row: ${row.name} — a free sequence space takes it, sequence numbers included`);
        return;
      }

      const imported = await target.hydrate(archive);
      assert.deepEqual(imported, row.counts, `row: ${row.name} — the hydrate counts`);
      // The rehydrated ledger answers the same rows, sequence numbers included.
      assert.deepEqual(await collect(target, sessionId), expected,
        `row: ${row.name} — events() answers identically`);
      // Hydrating one archive twice is a no-op, never a second copy.
      assert.deepEqual(await target.hydrate(archive), imported,
        `row: ${row.name} — the second hydrate is a no-op`);
      assert.deepEqual(await collect(target, sessionId), expected,
        `row: ${row.name} — and adds no row`);

      if (recallId !== null) {
        // The recalled bytes are the archived bytes, not a normalised copy.
        assert.deepEqual(await target.recall(recallId), await source.recall(recallId),
          `row: ${row.name} — the recall record travels whole`);
        assert.deepEqual((await target.recall(recallId)).parts.map(part => part.bytes),
          (await source.recall(recallId)).parts.map(part => part.bytes),
          `row: ${row.name} — the recalled bytes are byte-exact`);
      }
      if (otherRecallId !== null) {
        assert.deepEqual(await collect(target, "session-2"), [],
          `row: ${row.name} — the other session did not travel`);
        await assert.rejects(target.recall(otherRecallId), code("not-found"),
          `row: ${row.name} — the other session's recall is not in the target`);
      }
    });
  }
});