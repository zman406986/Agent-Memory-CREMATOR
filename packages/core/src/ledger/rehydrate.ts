import type { DatabaseSync } from "node:sqlite";
import type { Bytes, Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { decodeEntry } from "./event-store.js";
import type { ArchiveBlob, ArchiveRow, LedgerArchiveDocument } from "./export-file.js";
import { ARCHIVE_TABLES, parseArchiveDocument } from "./export-file.js";
import { assertHash, verifyBytes } from "./integrity.js";
import { manifestSha256, parseRecallManifest, recallIdFor } from "./manifest.js";
import { asRow, insertImmutable } from "./rows.js";
import type { SqlValue } from "./rows.js";
import type { LedgerArchive, HydratedLedger, LedgerEvent } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * Hydrate (PRD §6.7; ISSUE-045 chunk C9, ADR-0019). An exported archive is
 * verified against itself — its digest, its canonical encoding, every blob's
 * own hash and length, each recall's manifest and rows exactly as `readRecall`
 * will read them, and each event row exactly as `decodeEntry` will decode it —
 * and only then inserted, in the dependency order the ledger's foreign keys
 * require. Verification is complete before the first byte is published, so a
 * refused archive leaves the target ledger untouched.
 *
 * Additive by construction: hydrate inserts rows and never deletes one. The
 * durable per-session file stays the record of record (ADR-0015); an archive is
 * a second copy of the same facts, not a newer authority.
 */

export interface VerifiedArchive {
  readonly document: LedgerArchiveDocument;
  /** Bodies proven against their declared hash and length, in archive order. */
  readonly blobs: readonly ArchiveBlob[];
}

/**
 * The digest gate first, then the format gate: an archive whose own digest
 * disagrees with its bytes is refused before anything parses it. `sessionId`
 * must agree too — an archive is one session, and the caller names the one it
 * asked for.
 */
export async function verifyArchive(archive: LedgerArchive): Promise<VerifiedArchive> {
  assertHash(archive.archiveSha256);
  const digest = await sha256(new Uint8Array(archive.bytes));
  if (digest !== archive.archiveSha256) {
    throw new LedgerError("hash-mismatch", "Archive digest disagrees with its bytes");
  }
  const document = parseArchiveDocument(new Uint8Array(archive.bytes));
  if (document.sessionId !== archive.sessionId) {
    throw new LedgerError("hash-mismatch", "Archive names another session");
  }
  assertSessionRows(document);
  const blobs = await verifiedBlobs(document);
  // A reader now has every fact it will read later. Refuse here, before a body
  // is published, rather than storing a row `readRecall` or `events()` rejects.
  await assertArchivedRecalls(document, blobs);
  assertArchivedEvents(document);
  return { document, blobs };
}

/** Publish every body first; rows are only inserted once their content exists. */
export async function publishArchiveBlobs(
  blobs: readonly ArchiveBlob[], store: BlobStore,
): Promise<void> {
  for (const blob of blobs) {
    const published = await store.put(new Uint8Array(blob.bytes));
    if (published !== blob.sha256) {
      throw new LedgerError("hash-mismatch", `Blob store returned an incorrect hash ${blob.sha256}`);
    }
    await verifyBytes(new Uint8Array(await store.get(published)), blob.sha256, blob.bytes.byteLength);
  }
}

/**
 * Insert one verified archive inside the caller's transaction. Identical rows
 * are a no-op and a row that disagrees with an existing key is
 * `idempotency-conflict`, exactly as every other writer in this ledger answers.
 *
 * The archive's own sequence numbers are preserved for genuinely new events,
 * so `events()` answers the exported session identically — byte-equal rows in
 * the same order. An event whose `event_key` already holds an identical payload
 * is a no-op at the target's own sequence (ISSUE-323, matching `appendEvent`).
 * A target that already holds a different row at one of those numbers is
 * refused rather than renumbered: the two copies disagree about a fact, and
 * silently mixing them would make both look authoritative (ADR-0015).
 */
export function commitArchive(db: DatabaseSync, document: LedgerArchiveDocument): HydratedLedger {
  for (const spec of ARCHIVE_TABLES) {
    for (const row of document.tables[spec.name]) {
      // Event content identity is `event_key`, as `appendEvent` rules
      // (ISSUE-323): the same facts landed at another local sequence are a
      // no-op, and a different payload under one key is a conflict. The
      // sequence key below still guards the slot for a genuinely new event.
      if (spec.name === "ledger_events") {
        const eventKey = row["event_key"];
        if (typeof eventKey !== "string") {
          throw new LedgerError("hash-mismatch", "Archive ledger_events row names no event_key");
        }
        const known = db.prepare("SELECT payload_json FROM ledger_events WHERE event_key = ?")
          .get(eventKey);
        if (known !== undefined) {
          if (asRow(known, "ledger_events")["payload_json"] !== row["payload_json"]) {
            throw new LedgerError("idempotency-conflict", `Conflicting event ${eventKey}`);
          }
          continue;
        }
      }
      const key: Record<string, SqlValue> = {};
      for (const column of spec.key) {
        const found = row[column];
        if (found === undefined) {
          throw new LedgerError("hash-mismatch", `Archive ${spec.name} row names no ${column}`);
        }
        key[column] = found;
      }
      // `created_at_ms` is landing time, not content identity (PRD §6.7:
      // re-lands are idempotent keyed by (span, sha256)). Compare the content
      // columns only and pass the timestamp as the insert-only argument, as
      // `commitPreparation` does on the live write path (ISSUE-315): an
      // existing row keeps the target's own landing time.
      const values: Record<string, SqlValue> = {};
      let createdAtMs: number | undefined;
      for (const [column, value] of Object.entries(row)) {
        if (column !== "created_at_ms") { values[column] = value; continue; }
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new LedgerError("hash-mismatch",
            `Archive ${spec.name} row has a non-integer created_at_ms`);
        }
        createdAtMs = value;
      }
      insertImmutable(db, spec.name, key, values, createdAtMs);
    }
  }
  return {
    sessionId: document.sessionId,
    events: document.tables.ledger_events.length,
    recalls: document.tables.recalls.length,
  };
}

/** Every session-bearing row belongs to the archive's one session. */
function assertSessionRows(document: LedgerArchiveDocument): void {
  for (const table of ["applications", "ledger_events"] as const) {
    for (const row of document.tables[table]) {
      if (row["session_id"] !== document.sessionId) {
        throw new LedgerError("hash-mismatch", `Archive ${table} row belongs to another session`);
      }
    }
  }
}

/**
 * One body per metadata row, and one metadata row per body: the two lists are
 * the same set, or the archive contradicts itself. Each body is hashed here,
 * never trusted from the document, so an edited byte is refused even when the
 * archive digest was recomputed over the edit.
 */
async function verifiedBlobs(document: LedgerArchiveDocument): Promise<readonly ArchiveBlob[]> {
  const declared = new Map<Sha256, number>();
  for (const row of document.tables.blobs) {
    const hash = row["sha256"];
    const length = row["byte_length"];
    if (typeof hash !== "string" || typeof length !== "number") {
      throw new LedgerError("hash-mismatch", "Archive blob row names no hash or length");
    }
    assertHash(hash);
    declared.set(hash, length);
  }
  const blobs: ArchiveBlob[] = [];
  const seen = new Set<Sha256>();
  for (const blob of document.blobs) {
    if (seen.has(blob.sha256)) {
      throw new LedgerError("hash-mismatch", `Two archive bodies for ${blob.sha256}`);
    }
    seen.add(blob.sha256);
    const length = declared.get(blob.sha256);
    if (length === undefined) {
      throw new LedgerError("hash-mismatch", "Archive carries a body no blob row names");
    }
    const body = new Uint8Array(blob.bytes);
    if (body.byteLength !== length || await sha256(body) !== blob.sha256) {
      throw new LedgerError("hash-mismatch", `Archive blob ${blob.sha256} does not match its hash`);
    }
    blobs.push({ sha256: blob.sha256, bytes: body });
  }
  if (blobs.length !== declared.size) {
    throw new LedgerError("hash-mismatch", "Archive omits a body its blob rows name");
  }
  assertReferences(document, declared.keys());
  return blobs;
}

/**
 * Every hash and recall id a row points at is in the archive. The ledger's own
 * foreign keys would refuse these too, but only after a transaction opened;
 * this refuses before a single body is published.
 */
function assertReferences(document: LedgerArchiveDocument, hashes: Iterable<Sha256>): void {
  const known = new Set<Sha256>(hashes);
  const recalls = new Set<string>();
  for (const row of document.tables.recalls) {
    const manifest = row["manifest_sha256"];
    if (typeof manifest !== "string" || !known.has(manifest)) {
      throw new LedgerError("hash-mismatch", "Archive recall names a missing manifest blob");
    }
    recalls.add(String(row["recall_id"]));
  }
  for (const spec of ["recall_parts", "removed_spans"] as const) {
    for (const row of document.tables[spec]) {
      if (!recalls.has(String(row["recall_id"]))) {
        throw new LedgerError("hash-mismatch", `Archive ${spec} row names a missing recall`);
      }
    }
  }
  for (const row of document.tables.recall_parts) {
    if (!known.has(String(row["blob_sha256"]))) {
      throw new LedgerError("hash-mismatch", "Archive recall part names a missing body blob");
    }
  }
  const intents = new Set<string>(document.tables.applications.map(row => String(row["intent_id"])));
  for (const row of document.tables.application_removals) {
    const key = String(row["recall_id"]);
    if (!recalls.has(key)) {
      throw new LedgerError("hash-mismatch", "Archive removal names a missing recall");
    }
    if (!intents.has(String(row["intent_id"]))) {
      throw new LedgerError("hash-mismatch", "Archive removal names a missing intent");
    }
  }
  for (const row of document.tables.ledger_events) {
    const intent = row["intent_id"];
    if (intent !== null && !intents.has(String(intent))) {
      throw new LedgerError("hash-mismatch", "Archive event names a missing intent");
    }
  }
}

/**
 * Every archived recall must be readable exactly as `readRecall` will read it:
 * the manifest body hashes to its named length, parses canonically, re-hashes to
 * the same value, and every recall, part and span row agrees with it field for
 * field, including each part body and each removed-slice hash. A forged archive
 * can recompute its own digest, so these facts are what keep it from being
 * published and then rejected on its first read.
 */
async function assertArchivedRecalls(
  document: LedgerArchiveDocument, blobs: readonly ArchiveBlob[],
): Promise<void> {
  const bodies = new Map<Sha256, Bytes>();
  for (const blob of blobs) bodies.set(blob.sha256, blob.bytes);
  const lengths = new Map<Sha256, number>();
  for (const row of document.tables.blobs) {
    lengths.set(archivedHash(row, "sha256"), archivedInteger(row, "byte_length"));
  }
  for (const row of document.tables.recalls) {
    const id = archivedText(row, "recall_id");
    const hash = archivedHash(row, "manifest_sha256");
    // `readRecall` refuses a row whose id is not derived from its manifest hash.
    if (id !== recallIdFor(hash)) mismatch("Archive recall id differs from its manifest hash");
    const manifestBytes = bodies.get(hash);
    const manifestLength = lengths.get(hash);
    if (manifestBytes === undefined || manifestLength === undefined) {
      mismatch("Archive recall names no manifest body");
    }
    await verifyBytes(manifestBytes, hash, manifestLength);
    const manifest = parseRecallManifest(manifestBytes);
    if (await manifestSha256(manifest) !== hash) mismatch("Archive manifest hash differs");
    // `verifyApplication` refuses a recall of another session on the live path
    // (ISSUE-316); an archive must not plant one either.
    if (manifest.sessionId !== document.sessionId) {
      mismatch("Archive recall manifest belongs to another session");
    }

    const parts = document.tables.recall_parts
      .filter(part => part["recall_id"] === id)
      .sort((left, right) =>
        archivedInteger(left, "part_index") - archivedInteger(right, "part_index"));
    const spans = document.tables.removed_spans
      .filter(span => span["recall_id"] === id)
      .sort((left, right) =>
        archivedInteger(left, "part_index") - archivedInteger(right, "part_index") ||
        archivedInteger(left, "span_index") - archivedInteger(right, "span_index"));
    const spanCount = manifest.parts.reduce((sum, part) => sum + part.removedRanges.length, 0);
    if (parts.length !== manifest.parts.length || spans.length !== spanCount) {
      mismatch("Archive recall row counts differ from its manifest");
    }
    for (const [index, part] of manifest.parts.entries()) {
      const stored = parts[index];
      if (stored === undefined || archivedInteger(stored, "part_index") !== index ||
          archivedText(stored, "source_node_id") !== part.source.nodeId ||
          archivedHash(stored, "source_sha256") !== part.source.sha256 ||
          archivedInteger(stored, "source_byte_length") !== part.source.byteLength ||
          archivedHash(stored, "blob_sha256") !== part.blobSha256 ||
          lengths.get(part.blobSha256) !== part.source.byteLength) {
        mismatch("Archive part metadata differs from its manifest");
      }
      const body = bodies.get(part.blobSha256);
      if (body === undefined) mismatch("Archive part names no body");
      // `readRecall` proves both names hold the same bytes of the manifest's length.
      await verifyBytes(body, part.blobSha256, part.source.byteLength);
      await verifyBytes(body, part.source.sha256, part.source.byteLength);
      const storedSpans = spans.filter(span => archivedInteger(span, "part_index") === index);
      if (storedSpans.length !== part.removedRanges.length) {
        mismatch("Archive span row count differs from its manifest");
      }
      for (const [spanIndex, span] of part.removedRanges.entries()) {
        const storedSpan = storedSpans[spanIndex];
        if (storedSpan === undefined || archivedInteger(storedSpan, "span_index") !== spanIndex ||
            archivedInteger(storedSpan, "start_byte") !== span.range.startByte ||
            archivedInteger(storedSpan, "end_byte_exclusive") !== span.range.endByteExclusive ||
            archivedHash(storedSpan, "slice_sha256") !== span.sha256) {
          mismatch("Archive span metadata differs from its manifest");
        }
        await verifyBytes(
          body.slice(span.range.startByte, span.range.endByteExclusive), span.sha256);
      }
    }
  }
}

/**
 * Event rows are decoded by `decodeEntry`, the same reader `events()` uses: the
 * payload must carry the row's own kind, session, key and time, and the stored
 * sequence must be a positive safe integer. Every intent-bearing event must
 * also agree with its intent — the cross-checks `appendEvent` enforces on the
 * live write path (ISSUE-316). Without this, `commitArchive` would insert a row
 * that `events()` later rejects, or a fact the live path would never accept.
 */
function assertArchivedEvents(document: LedgerArchiveDocument): void {
  const intents = new Map<string, ArchiveRow>();
  for (const row of document.tables.applications) intents.set(String(row["intent_id"]), row);
  const seen = new Set<number>();
  for (const row of document.tables.ledger_events) {
    const sequence = archivedInteger(row, "sequence");
    if (sequence < 1 || sequence > Number.MAX_SAFE_INTEGER) {
      mismatch(`Archive event sequence ${String(sequence)} is out of range`);
    }
    if (seen.has(sequence)) mismatch(`Archive repeats event sequence ${String(sequence)}`);
    seen.add(sequence);
    let event: LedgerEvent;
    try {
      event = decodeEntry(row).event;
    } catch (error) {
      throw new LedgerError("hash-mismatch",
        `Archive event ${String(sequence)} is not a row the ledger can read`, { cause: error });
    }
    assertEventAgainstIntent(event, row, intents);
  }
}

/**
 * The intent cross-checks of `appendEvent`, applied to an archived event before
 * anything is published: the row names the payload's intent, the sessions
 * agree, a prepared hash matches the intent, and an applied receipt matches the
 * intent's session, base revision and hash with a well-formed time and result
 * revision. A kind that carries no intent must name none.
 */
function assertEventAgainstIntent(
  event: LedgerEvent, row: ArchiveRow, intents: ReadonlyMap<string, ArchiveRow>,
): void {
  if (event.kind !== "prepared" && event.kind !== "abandoned" && event.kind !== "applied") {
    if (row["intent_id"] !== null) {
      mismatch(`Archive event ${event.eventKey} names an intent its kind does not carry`);
    }
    return;
  }
  let intentId: unknown;
  let receipt: Record<string, unknown> | undefined;
  if (event.kind === "applied") {
    const raw: unknown = event.receipt;
    if (typeof raw !== "object" || raw === null) {
      mismatch(`Archive applied event ${event.eventKey} carries no receipt`);
    }
    receipt = raw as Record<string, unknown>;
    intentId = receipt["intentId"];
  } else {
    intentId = event.intentId;
  }
  if (typeof intentId !== "string") {
    mismatch(`Archive event ${event.eventKey} names no intent`);
  }
  if (row["intent_id"] !== intentId) {
    mismatch(`Archive event ${event.eventKey} names a different intent than its payload`);
  }
  const intent = intents.get(intentId);
  if (intent === undefined) {
    mismatch(`Archive event ${event.eventKey} names a missing intent`);
  }
  if (intent["session_id"] !== event.sessionId) {
    mismatch(`Archive event ${event.eventKey} session differs from its intent`);
  }
  if (event.kind === "prepared" && intent["application_sha256"] !== event.applicationSha256) {
    mismatch(`Archive prepared hash differs from its intent (${event.eventKey})`);
  }
  if (receipt !== undefined &&
      // The same applied-receipt shape the live append boundary enforces
      // (ISSUE-490): a result revision that is empty or unchanged can never be
      // reconciled, so the archive must not plant one either.
      (receipt["sessionId"] !== event.sessionId ||
       typeof receipt["baseRevision"] !== "string" || receipt["baseRevision"].length === 0 ||
       receipt["baseRevision"] !== intent["base_revision"] ||
       receipt["applicationSha256"] !== intent["application_sha256"] ||
       typeof receipt["appliedAtMs"] !== "number" || !Number.isSafeInteger(receipt["appliedAtMs"]) ||
       receipt["appliedAtMs"] < 0 ||
       typeof receipt["resultRevision"] !== "string" || receipt["resultRevision"].length === 0 ||
       receipt["resultRevision"] === receipt["baseRevision"])) {
    mismatch(`Archive receipt differs from its prepared intent (${event.eventKey})`);
  }
}

function archivedText(row: ArchiveRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") mismatch(`Archive row names no ${column}`);
  return value;
}

function archivedInteger(row: ArchiveRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    mismatch(`Archive row has no integer ${column}`);
  }
  return value;
}

function archivedHash(row: ArchiveRow, column: string): Sha256 {
  const value = archivedText(row, column);
  assertHash(value);
  return value;
}

function mismatch(message: string): never { throw new LedgerError("hash-mismatch", message); }