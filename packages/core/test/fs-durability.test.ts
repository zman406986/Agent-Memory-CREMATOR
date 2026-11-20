import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syncDirectoryChain } from "../src/ledger/fs-durability.js";

const SOURCE = fileURLToPath(new URL("../src/ledger/fs-durability.ts", import.meta.url));

/**
 * ISSUE-324 chose the honest-comment option: node:fs exposes no fcntl, so
 * F_FULLFSYNC cannot be issued zero-dependency, and core purity forbids a
 * native or child-process seam. These gates pin that choice: the comment
 * must state the macOS power-cut limit, the unconditional durability
 * overclaim must stay gone, and the code must stay platform-uniform (the
 * Windows tolerance excepted). Expected values come from the ticket's
 * requirement, not from the source, so each gate can fail: restoring the
 * old overclaiming comment fails the first test by name.
 */
test("the directory-sync comment states the macOS power-cut limit honestly (ISSUE-324)", () => {
  const source = readFileSync(SOURCE, "utf8");
  assert.match(source, /F_FULLFSYNC/,
    "the comment names the macOS full-durability call node:fs cannot issue");
  assert.match(source, /macOS/, "the comment names the platform that carries the limit");
  assert.match(source, /power cut/, "the comment states what a power cut can still lose");
  assert.doesNotMatch(source, /itself survives a power cut/,
    "the unconditional rename-durability overclaim is gone");
});

test("the chosen fix is comment-only: no darwin code branch, no new dependency (ISSUE-324)", () => {
  const source = readFileSync(SOURCE, "utf8");
  assert.doesNotMatch(source, /process\.platform === "darwin"/,
    "no darwin-only code path exists; other platforms are unchanged");
  assert.match(source, /fsyncSync\(fd\)/, "directory sync still uses fsyncSync");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(imports, ["node:fs", "node:path", "./integrity.js"],
    "the module keeps exactly its zero-dependency imports");
});

test("syncDirectoryChain still syncs a real directory chain on this platform", () => {
  const root = mkdtempSync(join(tmpdir(), "racoons-dirsync-"));
  try {
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    syncDirectoryChain(deep);
  } finally { rmSync(root, { recursive: true, force: true }); }
});