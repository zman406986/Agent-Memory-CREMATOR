#!/usr/bin/env node
/**
 * The frozen dist's identity (Phase R v2 R-1, gate d) and the round manifest's
 * binding of the brief (the `--manifest` gate).
 *
 * `result.json.mount.dist` records a PATH, and a path cannot tell two builds
 * apart: the frozen copy carries the stamp of the build it was copied from, and
 * that stamp is inert when `--plugin-dist` names an explicit directory (the
 * launcher consults `.stamp` only for the default dist). So the run records
 * `mount.distSha256`, and this gate pins the three properties a reader depends
 * on:
 *
 *   (a) the digest covers every file's own sha256, so a changed byte moves it;
 *   (b) it names CONTENT, not location — two copies of one tree agree, and the
 *       digest does not depend on where the tree sits or on creation order;
 *   (c) `sha256(text)` is the reported digest, so `build/dist.sha256.txt` can be
 *       verified with plain `sha256sum` instead of trusting this module.
 *
 * The manifest half closes the same kind of hole: `result.json` recorded the
 * brief's `taskSha256` but nothing compared it to
 * `dev/bench/manifests/<round>.manifest.json`, so a brief edited after the
 * manifest was written launched un-detected.
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`).
 * Both launcher assertions remain static: they name the exact field and
 * the exact call, which is the whole of the write there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { distTreeSha256 } from './dist-hash.mjs';
import { manifestTaskGate, taskSha256 } from './manifest-gate.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

/** One throwaway dist-shaped tree; `files` maps a relative POSIX path to bytes. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'racoons-dist-hash-'));
  for (const [path, bytes] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return root;
}

const BASE = {
  '.stamp': 'abc123\n',
  'packages/core/src/index.js': 'export const a = 1;\n',
  'node_modules/@cremator/core/index.js': 'export * from "../../../packages/core/src/index.js";\n',
};

test('dist sha256: a changed byte in any file moves the digest', () => {
  const a = tree(BASE);
  const b = tree({ ...BASE, 'packages/core/src/index.js': 'export const a = 2;\n' });
  try {
    assert.notEqual(distTreeSha256(a).sha256, distTreeSha256(b).sha256);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('dist sha256: the covered text hashes to the reported digest', () => {
  const root = tree(BASE);
  try {
    const result = distTreeSha256(root);
    assert.equal(createHash('sha256').update(result.text).digest('hex'), result.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dist sha256: paths are POSIX-slashed, sorted, and one per file', () => {
  const root = tree(BASE);
  try {
    const lines = distTreeSha256(root).text.trimEnd().split('\n');
    assert.deepEqual(lines.map((line) => line.split('\t')[0]), [...Object.keys(BASE)].sort());
    for (const line of lines) assert.match(line, /^[^\t]+\t[0-9a-f]{64}$/u);
    assert.equal(lines.every((line) => !line.includes('\\')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The `--manifest` gate: the round manifest binds the brief, or the launch stops.
// Unit-only, and the fixtures are synthetic: the comparison is
// `manifest-gate.mjs`. The real round pair is checked by the `--manifest`
// preflight, not here: a test that read the round's own files would red the
// suite between this commit and theirs.
// ---------------------------------------------------------------------------

const TASK = 'audit these files and report\n';
const DIGEST = 'a'.repeat(64);

/** A round manifest in the shape the extended-round file carries. */
function manifest(overrides = {}) {
  return {
    schema: 'racoons-bench-round-tasks/1',
    brief: { path: 'dev/bench/bench-brief-x.md', taskSha256: taskSha256(TASK),
      taskBlockBytes: TASK.length, ...(overrides.brief ?? {}) },
    image: { digest: DIGEST, ...(overrides.image ?? {}) },
    ...(overrides.top ?? {}),
  };
}

test('manifest gate: a brief with no image.digest fails, and a missing arm manifest is skipped by name', () => {
  // The image half used to be conditional in silence: no digest in the round
  // manifest, or no arm manifest to read the multiset from, and the gate
  // returned {ok:true} with nothing printed. A round manifest that carries a
  // brief binds the image too, so a brief with no digest is a broken manifest.
  const noDigest = manifestTaskGate({
    manifest: manifest({ image: { digest: undefined } }),
    taskSha256: taskSha256(TASK), taskChars: TASK.length, armMultiset: DIGEST,
  });
  assert.equal(noDigest.ok, false);
  assert.match(noDigest.detail, /no image\.digest/u);
  // A round manifest that names a digest but whose arm has no manifest is
  // skipped BY NAME: the caller prints the reason instead of passing silently.
  const noArm = manifestTaskGate({
    manifest: manifest(), taskSha256: taskSha256(TASK), taskChars: TASK.length, armMultiset: null,
  });
  assert.equal(noArm.ok, true);
  assert.match(noArm.skipped, /no arm manifest|multisetSha256/u);
  assert.match(noArm.skipped, new RegExp(DIGEST, 'u'));
  // A real brief failure is still a failure when the arm manifest is missing;
  // the skip never masks a red comparison.
  const broken = manifestTaskGate({
    manifest: manifest(), taskSha256: 'f'.repeat(64), taskChars: TASK.length, armMultiset: null,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /task sha256/u);
});

test('manifest gate: a matching manifest passes', () => {
  const gate = manifestTaskGate({
    manifest: manifest(), taskSha256: taskSha256(TASK), taskChars: TASK.length, armMultiset: DIGEST,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.skipped, undefined);
  // A manifest with no `brief` block states no brief: skipped, never assumed green.
  assert.match(manifestTaskGate({ manifest: { schema: 'x' }, taskSha256: 'f'.repeat(64), taskChars: 1 }).skipped,
    /no brief block/u);
});

test('manifest gate: a perturbed hash fails, and the launcher refuses on it', () => {
  const perturbedTask = `x${TASK}`;
  const gate = manifestTaskGate({
    manifest: manifest(), taskSha256: taskSha256(perturbedTask), taskChars: TASK.length, armMultiset: DIGEST,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /task sha256 [0-9a-f]{64} != manifest [0-9a-f]{64}/u);
  // The size half fails on its own: the fence hash can match while the block
  // the model is handed is a different length.
  const sizeOnly = manifestTaskGate({
    manifest: manifest({ brief: { taskBlockBytes: TASK.length + 1 } }),
    taskSha256: taskSha256(TASK), taskChars: TASK.length, armMultiset: DIGEST,
  });
  assert.equal(sizeOnly.ok, false);
  assert.match(sizeOnly.detail, /taskBlockBytes/u);
  // The image half: a re-materialized arm whose multiset drifted.
  const imageOnly = manifestTaskGate({
    manifest: manifest(), taskSha256: taskSha256(TASK), taskChars: TASK.length, armMultiset: 'b'.repeat(64),
  });
  assert.equal(imageOnly.ok, false);
  assert.match(imageOnly.detail, /image\.digest/u);
  // Exit-nonzero behavior: the launcher's only path off a failed gate is refuse,
  // which writes the one-line reason to stderr and exits 2.
  const source = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');
  assert.match(source, /if \(!gate\.ok\) \{\s*refuse\(`bench-run\.mjs: --manifest \$\{opts\.manifest\} does not bind this launch: \$\{gate\.detail\}`\);/u);
});
