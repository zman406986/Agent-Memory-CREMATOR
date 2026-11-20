import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalManifestBytes } from "../src/util/bytes.js";
import { sha256 } from "../src/util/hash.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import { SqliteLedger } from "../src/ledger/sqlite-ledger.js";
import { LedgerError } from "../src/ledger/types.js";
import type { PreparableApplication } from "../src/ledger/types.js";
import { applicationFixture } from "./ledger-fixtures.js";
import { snapshotApplicationHash } from "../src/ledger/application-integrity.js";

const clock = { nowMs: () => 100 };
const hashMismatch = (error: unknown): boolean =>
  error instanceof LedgerError && error.code === "hash-mismatch";

/** The approved plan, as the guard hands it over: a structural subset suffices. */
const approvedRevert = {
  cutIndex: 3,
  survivors: ["result-0", "result-2"],
  cost: { cutIndex: 3, freedBytes: 4096, keptBytes: 512, receiptBytes: 128, netFreedBytes: 3456 },
} as const;

/**
 * The guard's envelope, built independently of `application-integrity.ts` so the
 * expected digest comes from outside the module it checks.
 */
async function applicationOf(
  extra: Record<string, unknown> = { revert: approvedRevert }, mode: "entry" | "revert" = "revert",
): Promise<PreparableApplication> {
  const subset = await applicationFixture();
  // The body keeps the ledger's own byte arrays; only the hashed envelope
  // spells them as arrays, which is the documented canonical form.
  const body: Record<string, unknown> = {
    sessionId: subset.sessionId, eventId: subset.eventId, baseRevision: subset.baseRevision,
    phase: subset.phase, appendRecords: subset.appendRecords, archives: subset.archives,
    sealedEpisodeIds: subset.sealedEpisodeIds, mode, replacements: [], createdAtMs: 90,
    ...extra,
  };
  const envelope = { domain: "racoons:application:v1", application: {
    ...body, archives: subset.archives.map(archive => ({
      ...archive, recall: { ...archive.recall, parts: archive.recall.parts.map(part => ({
        ...part, bytes: Array.from(part.bytes),
      })) },
    })) },
  };
  return { ...body,
    applicationSha256: await sha256(canonicalManifestBytes(envelope)) } as unknown as PreparableApplication;
}

/**
 * One row per way an application's digest can stop matching its body, plus one
 * row per internally impossible revert plan. Each digest row prepares against a
 * real ledger, so it is only green if the check ran before storage; each plan
 * row reads the refusal message, so a row that fails for another reason fails
 * by name. Both sets are one table: they are the same rule — a body the guard
 * never vetted is refused, never stored.
 */
const CASES: readonly {
  readonly name: string;
  readonly run: () => Promise<void>;
}[] = [
  ...([
    ["an entry application with its own digest is accepted",
      () => applicationOf({}, "entry"), true],
    ["an entry application with an altered digest is rejected before storage",
      async () => ({ ...await applicationOf({}, "entry"), applicationSha256: "0".repeat(64) }), false],
    ["a revert application hashes its approved plan inside the envelope",
      () => applicationOf(), true],
    ["a revert body stripped of its payload cannot reproduce the digest",
      async () => {
        const { revert: _omitted, ...withoutPayload } = await applicationOf();
        return withoutPayload as PreparableApplication;
      }, false],
    ["a swapped cut cannot ride the approved digest",
      async () => ({ ...await applicationOf(),
        revert: { ...approvedRevert, cutIndex: 4 } } as PreparableApplication), false],
  ] as const).map(([name, body, accepted]) => ({
    name,
    run: async (): Promise<void> => {
      const ledger = await SqliteLedger.open({ databasePath: ":memory:",
        blobStore: new MemoryBlobStore(), clock });
      try {
        const application = await (body as () => Promise<PreparableApplication>)();
        if (!accepted) {
          await assert.rejects(ledger.prepare(application), hashMismatch,
            `row: ${name} — a body that does not hash to its digest is refused`);
          return;
        }
        await ledger.prepare(application);
        const archive = application.archives[0];
        assert.ok(archive, `row: ${name} — the accepted fixture carries an archive`);
        assert.deepEqual(await ledger.recall(archive.recall.id), archive.recall,
          `row: ${name} — an accepted application's archive is restorable by its id`);
      } finally { await ledger.close(); }
    },
  })),
  ...([
    ["negative freed bytes", { ...approvedRevert, cost: { ...approvedRevert.cost,
      freedBytes: -4096, netFreedBytes: -4736 } }, /non-negative integers/],
    ["arithmetic that does not add up", { ...approvedRevert, cost: { ...approvedRevert.cost,
      netFreedBytes: 9999 } }, /salvage arithmetic/],
    ["a survivor listed twice", { ...approvedRevert,
      survivors: ["result-0", "result-0"] }, /repeat a node id/],
    ["a non-integer cut", { ...approvedRevert, cutIndex: 1.5,
      cost: { ...approvedRevert.cost, cutIndex: 1.5 } }, /non-negative integer/],
  ] as const).map(([name, payload, pattern]) => ({
    name,
    run: async (): Promise<void> => {
      assert.throws(() => snapshotApplicationHash({
        sessionId: "session-1", eventId: "event-1", baseRevision: "revision-1", phase: "at-rest",
        applicationSha256: "0".repeat(64), archives: [], appendRecords: [], sealedEpisodeIds: [],
        mode: "revert", replacements: [], createdAtMs: 90, revert: payload,
      } as PreparableApplication), (error: unknown) =>
        error instanceof LedgerError && error.code === "hash-mismatch" &&
        pattern.test(error.message), `row: ${name} — the payload is refused for this reason`);
    },
  })),
];

test("application integrity — one row per digest refusal and impossible plan", async () => {
  for (const row of CASES) await row.run();
});
