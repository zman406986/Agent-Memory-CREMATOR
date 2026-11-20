import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../src/ledger/file-blob-store.js";
import { MemoryBlobStore } from "../src/ledger/memory-blob-store.js";
import type { BlobStore } from "../src/ledger/blob-store.js";
import { LedgerError } from "../src/ledger/types.js";
import { sha256 } from "../src/util/hash.js";
import { bytes } from "./ledger-fixtures.js";

/** An empty body, one carrying the bytes a text pipeline would normalise, and multibyte text. */
const fixtures = [new Uint8Array(), new Uint8Array([0, 255, 128, 13, 10]),
  bytes("\uFEFFfirst\r\n第二行\nlast")];
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof LedgerError && error.code === expected;
const missing = "0".repeat(64);

/** A temp root the row owns and removes, whatever the row does. */
async function withRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const sharded = (root: string, hash: string): string =>
  join(root, "sha256", hash.slice(0, 2), hash.slice(2));

/**
 * The byte contract both stores owe, driven per lane. The memory and file lanes
 * are rows rather than two tests because one rule holding for one lane and not
 * the other is exactly the failure the pairing exists to catch.
 */
async function roundTrip(name: string, store: BlobStore, root: string | null): Promise<void> {
  for (const [index, fixture] of fixtures.entries()) {
    const row = `${name} fixture ${String(index)}`;
    const input = new Uint8Array(fixture);
    const hash = await store.put(input);
    assert.deepEqual(await store.get(hash), fixture,
      `row: ${row} — the stored bytes are the input byte for byte`);
    input.fill(42);
    assert.deepEqual(await store.get(hash), fixture,
      `row: ${row} — the store copied the caller's array`);
    const handed = await store.get(hash);
    handed.fill(91);
    assert.deepEqual(await store.get(hash), fixture,
      `row: ${row} — a read hands out a copy, never the stored array`);
    assert.equal(await store.put(fixture), hash,
      `row: ${row} — the same bytes are the same hash on a repeat put`);
    if (root !== null) {
      assert.deepEqual(new Uint8Array(readFileSync(sharded(root, hash))), fixture,
        `row: ${row} — the file holds the bytes, not a normalised form`);
    }
  }
  const hashes = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes("same"))));
  assert.equal(new Set(hashes).size, 1,
    `row: ${name} — eight concurrent puts of one body agree on one hash`);
  await assert.rejects(store.get(missing), code("not-found"),
    `row: ${name} — an unknown hash is a miss, never an empty body`);
}

/**
 * One row per store rule. Each row owns its temp root, so a failing row cannot
 * leave a body behind that the next row would read as a pass.
 */
const CASES: readonly (readonly [string, () => Promise<void>])[] = [
  ["memory store round trips and isolates every array", async () => {
    await roundTrip("memory store", new MemoryBlobStore(), null);
  }],
  ["file store round trips and isolates every array", async () => {
    await withRoot("racoons-blobs-", root => roundTrip("file store", new FileBlobStore(root), root));
  }],
  ["file store publishes atomically and never overwrites on repeat", async () => {
    const name = "file store publishes atomically and never overwrites on repeat";
    await withRoot("racoons-publish-", async root => {
      const store = new FileBlobStore(root);
      // Publishing is a link, not a rewrite: a repeat put keeps the inode and both
      // timestamps, so a concurrent reader never sees a half-written body.
      for (const [index, fixture] of fixtures.entries()) {
        const row = `${name} fixture ${String(index)}`;
        const hash = await store.put(new Uint8Array(fixture));
        const path = sharded(root, hash);
        const before = statSync(path, { bigint: true });
        assert.equal(await store.put(fixture), hash, `row: ${row} — the repeat put is the same hash`);
        const after = statSync(path, { bigint: true });
        assert.equal(after.ino, before.ino, `row: ${row} — the publish never replaced the file`);
        assert.equal(after.mtimeNs, before.mtimeNs, `row: ${row} — the publish never rewrote the file`);
        assert.equal(after.ctimeNs, before.ctimeNs, `row: ${row} — the publish never relinked the file`);
      }
      await assert.rejects(store.get("../../outside"), code("hash-mismatch"),
        `row: ${name} — a traversing hash is refused by the shard join, never written outside it`);
    });
  }],
  ["a corrupt published blob is refused without repair or overwrite", async () => {
    const name = "a corrupt published blob is refused without repair or overwrite";
    await withRoot("racoons-corrupt-", async root => {
      const store = new FileBlobStore(root);
      const original = bytes("original");
      const hash = await store.put(original);
      const path = sharded(root, hash);
      const corrupt = bytes("corrupt!");
      writeFileSync(path, corrupt);
      await assert.rejects(store.get(hash), code("hash-mismatch"),
        `row: ${name} — get refuses the body rather than returning it`);
      await assert.rejects(store.put(original), code("hash-mismatch"),
        `row: ${name} — put refuses rather than repairing the file`);
      assert.deepEqual(new Uint8Array(readFileSync(path)), corrupt,
        `row: ${name} — the corrupt bytes are still there, nothing was repaired in place`);
    });
  }],
  ["a crashed publisher's lock does not wedge its hash", async () => {
    const name = "a crashed publisher's lock does not wedge its hash";
    await withRoot("racoons-stale-lock-", async root => {
      const store = new FileBlobStore(root);
      const body = bytes("body behind a crashed lock");
      const hash = await sha256(body);
      const lock = join(root, "temporary", `${hash}.lock`);
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, atMs: Date.now(), token: "crashed" }));
      assert.equal(await store.put(body), hash, `row: ${name} — the dead owner's lock is stolen`);
      assert.deepEqual(await store.get(hash), body, `row: ${name} — the body publishes`);
      assert.equal(existsSync(lock), false, `row: ${name} — the stale lock is gone`);
    });
  }],
  ["an ownerless lock is recovered without waiting out the age bound", async () => {
    const name = "an ownerless lock is recovered without waiting out the age bound";
    await withRoot("racoons-ownerless-lock-", async root => {
      const store = new FileBlobStore(root);
      const body = bytes("body behind an ownerless lock");
      const hash = await sha256(body);
      const lock = join(root, "temporary", `${hash}.lock`);
      // Fresh mtime, no owner record: the crash window between creating the
      // lock and writing its owner. Freshness must not judge it live.
      mkdirSync(lock, { recursive: true });
      assert.equal(await store.put(body), hash,
        `row: ${name} — the ownerless lock is recovered at once (ISSUE-321)`);
      assert.deepEqual(await store.get(hash), body, `row: ${name} — the body publishes`);
      assert.equal(existsSync(lock), false, `row: ${name} — the recovered lock is released`);
    });
  }],
  ["a live publisher's lock still refuses and names the hash and lock", async () => {
    const name = "a live publisher's lock still refuses and names the hash and lock";
    await withRoot("racoons-live-lock-", async root => {
      const store = new FileBlobStore(root);
      const body = bytes("body behind a live lock");
      const hash = await sha256(body);
      const lock = join(root, "temporary", `${hash}.lock`);
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "live" }));
      await assert.rejects(store.put(body), (error: unknown) =>
        error instanceof LedgerError && error.code === "storage" &&
        error.message.includes(`Blob publication locked: ${hash}`) &&
        error.message.includes(lock),
      `row: ${name} — the refusal names the hash and the lock path`);
      assert.equal(existsSync(lock), true, `row: ${name} — a live lock is never stolen`);
      assert.equal(existsSync(sharded(root, hash)), false, `row: ${name} — nothing was published`);
    });
  }],
  ["crashed staging dirs are swept on the next put; a live publisher's staging is untouched", async () => {
    const name = "crashed staging dirs are swept on the next put; a live publisher's staging is untouched";
    await withRoot("racoons-staging-sweep-", async root => {
      const store = new FileBlobStore(root);
      const temporary = join(root, "temporary");
      mkdirSync(temporary, { recursive: true });
      // A crashed publisher's staging: a body left behind, aged past the
      // lock's own staleness bound (the same 120 s the aged-lock row uses).
      const crashed = mkdtempSync(join(temporary, "publish-"));
      writeFileSync(join(crashed, "body"), bytes("crashed body"));
      const old = new Date(Date.now() - 120_000);
      utimesSync(crashed, old, old);
      // A live publisher's staging: fresh, so the sweep must leave it alone.
      const live = mkdtempSync(join(temporary, "publish-"));
      writeFileSync(join(live, "body"), bytes("live body"));
      const body = bytes("sweep trigger");
      assert.equal(await store.put(body), await sha256(body),
        `row: ${name} — the put itself publishes`);
      assert.equal(existsSync(crashed), false,
        `row: ${name} — the crashed staging dir is swept (ISSUE-318)`);
      assert.equal(existsSync(live), true,
        `row: ${name} — a fresh staging dir is never swept`);
    });
  }],
  ["a crashed claim directory is swept like crashed staging", async () => {
    const name = "a crashed claim directory is swept like crashed staging";
    await withRoot("racoons-claim-sweep-", async root => {
      const store = new FileBlobStore(root);
      const temporary = join(root, "temporary");
      mkdirSync(temporary, { recursive: true });
      const crashed = mkdtempSync(join(temporary, "claim-"));
      writeFileSync(join(crashed, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, atMs: Date.now(), token: "crashed" }));
      const old = new Date(Date.now() - 120_000);
      utimesSync(crashed, old, old);
      const live = mkdtempSync(join(temporary, "claim-"));
      writeFileSync(join(live, "owner.json"), "{}");
      const body = bytes("claim sweep trigger");
      assert.equal(await store.put(body), await sha256(body),
        `row: ${name} — the put itself publishes`);
      assert.equal(existsSync(crashed), false,
        `row: ${name} — the crashed claim dir is swept (ISSUE-321)`);
      assert.equal(existsSync(live), true,
        `row: ${name} — a fresh claim dir is never swept`);
    });
  }],
  ["a cleanup failure neither masks the publish error nor skips staging removal", async () => {
    const name = "a cleanup failure neither masks the publish error nor skips staging removal";
    await withRoot("racoons-cleanup-", async root => {
      const store = new FileBlobStore(root, {
        onStep: step => {
          if (step === "locked") throw new Error("injected publish failure");
          throw new Error("injected releaseLock EBUSY");
        },
      });
      const body = bytes("cleanup failure body");
      const hash = await sha256(body);
      await assert.rejects(store.put(body), (error: unknown) =>
        error instanceof LedgerError && error.code === "storage" &&
        error.message.includes(`Cannot publish blob ${hash}`) &&
        error.cause instanceof Error && error.cause.message === "injected publish failure",
      `row: ${name} — the original publish error surfaces, not the cleanup error (ISSUE-318)`);
      const leftover = readdirSync(join(root, "temporary")).filter(entry => entry.startsWith("publish-"));
      assert.deepEqual(leftover, [],
        `row: ${name} — staging is removed even when release fails`);
    });
  }],
  ["release deletes only on a positive owner-token match", async () => {
    const name = "release deletes only on a positive owner-token match";
    const body = bytes("release guard body");
    const hash = await sha256(body);
    // An unreadable owner record: release cannot confirm the lock is this
    // process's (a successor's partial owner write looks exactly like this),
    // so it must leave the lock to stale recovery, never delete it.
    await withRoot("racoons-release-corrupt-", async root => {
      const lock = join(root, "temporary", `${hash}.lock`);
      const store = new FileBlobStore(root, {
        onStep: step => { if (step === "locked") writeFileSync(join(lock, "owner.json"), "not json"); },
      });
      assert.equal(await store.put(body), hash, `row: ${name} — the put itself publishes`);
      assert.equal(existsSync(lock), true,
        `row: ${name} — an unreadable owner record leaves the lock in place (ISSUE-320)`);
    });
    // A readable successor's record: the existing token guard keeps it too.
    await withRoot("racoons-release-successor-", async root => {
      const lock = join(root, "temporary", `${hash}.lock`);
      const store = new FileBlobStore(root, {
        onStep: step => {
          if (step === "locked") {
            writeFileSync(join(lock, "owner.json"),
              JSON.stringify({ pid: process.pid, atMs: Date.now(), token: "successor" }));
          }
        },
      });
      assert.equal(await store.put(body), hash, `row: ${name} — the put itself publishes`);
      assert.equal(existsSync(lock), true,
        `row: ${name} — a readable successor's lock is never deleted`);
    });
  }],
];

test('blob stores — one row per store rule', async () => {
  for (const [name, run] of CASES) {
    try { await run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith(`row: ${name}`)) throw error;
      throw new Error(`row: ${name} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
});
