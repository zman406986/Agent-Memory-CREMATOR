import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecallManifest, manifestSha256, recallIdFor, encodeRecallManifest } from "../src/ledger/manifest.js";
import type { HashedRange, RecallManifest, RecallManifestPart } from "../src/ledger/manifest.js";
import { sha256 } from "../src/util/hash.js";
import { bytes, recallFixture } from "./ledger-fixtures.js";

test("recall id is exactly recall:sha256 plus lowercase SHA-256", async () => {
  const recall = await recallFixture();
  assert.match(recall.id, /^recall:sha256:[0-9a-f]{64}$/,
    "row: recall id shape — the id is the algorithm prefix plus 64 lowercase hex digits");
  assert.equal(recall.id, `recall:sha256:${recall.manifestSha256}`,
    "row: recall id shape — the id is derived from the manifest hash, never minted beside it");
  assert.throws(() => recallIdFor("A".repeat(64)),
    "row: recall id shape — an uppercase digest is refused, not lowercased into a second id");
});

test("manifest builder copies inputs and rejects ambiguous part indices and overlapping spans", async () => {
  const recall = await recallFixture([bytes("abcdef")]);
  const first = recall.manifest.parts[0];
  assert.ok(first);
  assert.throws(() => buildRecallManifest("session-1", [
    { ...first, part_index: 1 }, { ...first, part_index: 1 },
  ]), "row: two parts claiming one index — an ambiguous part index is refused");
  assert.throws(() => buildRecallManifest("session-1", [{
    ...first, removedRanges: [...first.removedRanges, ...first.removedRanges],
  }]), "row: overlapping removed spans — a manifest naming one byte twice is refused");
});

/** The fixture the identity rows share: two parts, and two disjoint spans over the first. */
interface Scene {
  readonly original: string;
  readonly parts: readonly RecallManifestPart[];
  readonly low: HashedRange;
  readonly high: HashedRange;
  /** Part 0 with the two disjoint spans, in construction order `order`. */
  readonly spanned: (order: "low-first" | "high-first") => RecallManifestPart;
}

/** A manifest over the given parts, each with its construction index made explicit. */
function manifestOf(parts: readonly RecallManifestPart[]): RecallManifest {
  return buildRecallManifest({ sessionId: "session-1",
    parts: parts.map((part, part_index) => ({ ...part, part_index })) });
}

/**
 * One row per field the manifest identity is made of.
 *
 * The order row builds two construction orders and compares them to EACH OTHER.
 * The fixture's own manifest is never its expected value: that would pin the
 * fixture, not the canonical form. Each remaining row moves exactly one field
 * off the fixture's manifest and must move the hash, so a field silently dropped
 * from the encoding fails its own row by name.
 */
const IDENTITY_ROWS: readonly {
  readonly name: string;
  readonly build: (scene: Scene) => RecallManifest;
  /** Present on the order row: the other construction order, which must hash the same. */
  readonly sameAs?: (scene: Scene) => RecallManifest;
}[] = [
  {
    name: "construction order",
    // The same part in the same position, its two spans built in opposite order.
    build: ({ parts, spanned }) => manifestOf([spanned("high-first"), parts[1] as RecallManifestPart]),
    sameAs: ({ parts, spanned }) => manifestOf([spanned("low-first"), parts[1] as RecallManifestPart]),
  },
  { name: "another session", build: ({ parts }) =>
    buildRecallManifest({ sessionId: "other-session",
      parts: parts.map((part, part_index) => ({ ...part, part_index })) }) },
  { name: "another source occurrence", build: ({ parts }) => manifestOf([
    { ...(parts[0] as RecallManifestPart), source: { ...(parts[0] as RecallManifestPart).source,
      nodeId: "other-node" } }, parts[1] as RecallManifestPart]) },
  { name: "another part order", build: ({ parts }) =>
    manifestOf([parts[1] as RecallManifestPart, parts[0] as RecallManifestPart]) },
  { name: "a dropped part", build: ({ parts }) => manifestOf([parts[0] as RecallManifestPart]) },
  { name: "a moved removed-span boundary", build: ({ parts }) => manifestOf([
    { ...(parts[0] as RecallManifestPart), removedRanges: [{ range: { startByte: 1, endByteExclusive: 6 },
      sha256: "0".repeat(64) }] }, parts[1] as RecallManifestPart]) },
];

test("identity — canonical order and every field that moves the hash", async () => {
  const recall = await recallFixture([bytes("abcdef"), bytes("second")]);
  const first = recall.manifest.parts[0];
  const second = recall.manifest.parts[1];
  assert.ok(first && second);
  const scene: Scene = {
    original: recall.manifestSha256,
    parts: [first, second],
    low: { range: { startByte: 0, endByteExclusive: 2 }, sha256: await sha256(bytes("ab")) },
    high: { range: { startByte: 4, endByteExclusive: 6 }, sha256: await sha256(bytes("ef")) },
    spanned: order => ({ ...first, removedRanges: order === "low-first" ? [scene.low, scene.high]
      : [scene.high, scene.low] }),
  };
  for (const row of IDENTITY_ROWS) {
    if (row.sameAs !== undefined) {
      const one = await manifestSha256(row.build(scene));
      const other = await manifestSha256(row.sameAs(scene));
      assert.equal(one, other, `row: ${row.name} — two construction orders hash the same`);
      assert.equal(recallIdFor(one), recallIdFor(other),
        `row: ${row.name} — so two construction orders are one recall id`);
      continue;
    }
    assert.notEqual(await manifestSha256(row.build(scene)), scene.original,
      `row: ${row.name} — moving this field must move the manifest hash`);
  }
  // The canonical bytes themselves, not only the hash: two orders encode to one string.
  const encoded = encodeRecallManifest(IDENTITY_ROWS[0]?.build(scene) as RecallManifest);
  assert.equal(new TextDecoder().decode(encoded), new TextDecoder().decode(
    encodeRecallManifest(IDENTITY_ROWS[0]?.sameAs?.(scene) as RecallManifest)),
  "row: construction order — the canonical bytes are identical, not merely equal-hashing");
});
