// The round-manifest generator against the REAL extended-36 inputs.
//
// `make-round-manifest.mjs` exists so the four fields a launch gates on are
// computed, never typed: `brief.taskSha256`, `brief.taskBlockBytes`,
// `image.digest` and `deliverables.count`. This pins the generator to the
// hand-authored manifest the extended-36 round actually ran under
// (dev/bench/manifests/2026-11-10-extended-36.manifest.json), so a drift in the
// brief parse, the arm digest read or the deliverable resolution fails here
// rather than at a paid launch.
//
// Only the gate fields and the passthroughs (schema, round) are compared.
// `image.source`, `image.note`, `image.reMaterialized`, `provenance` and the
// omitted informational blocks are the generator's own statements and may
// differ from the committed file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { buildRoundManifest, parseArgs } from './make-round-manifest.mjs';
import { manifestTaskGate } from './manifest-gate.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL = join(BENCH_DIR, 'make-round-manifest.mjs');
const BRIEF = join(BENCH_DIR, 'bench-brief-extended-36.md');
const COMMITTED_FILE = join(BENCH_DIR, 'manifests', '2026-11-10-extended-36.manifest.json');

// The frozen image is not in this repo. The owner's two devices mount it at
// C:\Users\TZhen\Desktop\racoons-bench and C:\Users\TZ\Desktop\racoons-bench;
// `homedir()` covers both, and the env var names another location.
const ARM_MANIFEST = process.env.RACOONS_BENCH_ARM_MANIFEST
  ?? join(homedir(), 'Desktop', 'racoons-bench', '2026-10-23-aetherium', 'racoons-arm', 'manifest.json');
const IMAGE_MISSING = `the per-arm manifest.json is absent at ${ARM_MANIFEST} `
  + '(the owner devices hold it under C:\\Users\\TZhen\\Desktop\\racoons-bench or '
  + 'C:\\Users\\TZ\\Desktop\\racoons-bench); set RACOONS_BENCH_ARM_MANIFEST to point at it';

const COMMITTED = JSON.parse(readFileSync(COMMITTED_FILE, 'utf8'));

test('the generated gate fields equal the committed extended-36 manifest', (t) => {
  if (!existsSync(ARM_MANIFEST)) return t.skip(IMAGE_MISSING);
  const { manifest, paths } = buildRoundManifest({
    briefPath: BRIEF,
    armManifestPath: ARM_MANIFEST,
    round: 'extended-36',
    today: '2026-11-16',
  });

  assert.equal(manifest.schema, COMMITTED.schema);
  assert.equal(manifest.round, COMMITTED.round);
  assert.equal(manifest.brief.path, COMMITTED.brief.path);
  assert.equal(manifest.brief.taskSha256, COMMITTED.brief.taskSha256);
  assert.equal(manifest.brief.taskBlockBytes, COMMITTED.brief.taskBlockBytes);
  assert.equal(manifest.image.digest, COMMITTED.image.digest);
  assert.match(manifest.image.digest, /^9087422d/u);
  assert.equal(manifest.imageRoot, COMMITTED.imageRoot);
  assert.equal(manifest.deliverables.count, COMMITTED.deliverables.count);
  assert.equal(paths.length, COMMITTED.deliverables.count);
  // The same gate the launcher applies, on the generated object.
  const gate = manifestTaskGate({
    manifest,
    taskSha256: manifest.brief.taskSha256,
    taskChars: manifest.brief.taskBlockBytes,
    armMultiset: manifest.image.digest,
  });
  assert.deepEqual(gate, { ok: true });
});

test('the CLI writes the same manifest and prints one summary line', (t) => {
  if (!existsSync(ARM_MANIFEST)) return t.skip(IMAGE_MISSING);
  const outDir = mkdtempSync(join(tmpdir(), 'racoons-round-manifest-'));
  try {
    const out = join(outDir, 'nested', 'extended-36.manifest.json');
    const run = spawnSync(process.execPath, [
      TOOL,
      '--brief', BRIEF,
      '--arm-manifest', ARM_MANIFEST,
      '--round', 'extended-36',
      '--out', out,
      '--note', 'written by the test',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`taskSha256 ${COMMITTED.brief.taskSha256.slice(0, 12)}`, 'u'));
    assert.match(lines[0], new RegExp(`block ${String(COMMITTED.brief.taskBlockBytes)} chars`, 'u'));
    assert.match(lines[0], new RegExp(`image ${COMMITTED.image.digest.slice(0, 12)}`, 'u'));
    assert.match(lines[0], new RegExp(`deliverables ${String(COMMITTED.deliverables.count)}\\b`, 'u'));

    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.schema, 'racoons-bench-round-tasks/1');
    assert.equal(written.round, 'extended-36');
    assert.equal(written.brief.taskSha256, COMMITTED.brief.taskSha256);
    assert.equal(written.brief.taskBlockBytes, COMMITTED.brief.taskBlockBytes);
    assert.equal(written.image.digest, COMMITTED.image.digest);
    assert.equal(written.deliverables.count, COMMITTED.deliverables.count);
    assert.match(written.provenance.note, /written by the test\./u);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a brief with no derivable list refuses instead of falling back', (t) => {
  if (!existsSync(ARM_MANIFEST)) return t.skip(IMAGE_MISSING);
  const dir = mkdtempSync(join(tmpdir(), 'racoons-round-manifest-brief-'));
  try {
    const brief = join(dir, 'brief.md');
    writeFileSync(brief, '# Brief\n\n## Task text\n\n```text\nRead the corpus and say what you found.\n```\n');
    const out = join(dir, 'out.manifest.json');
    const run = spawnSync(process.execPath, [
      TOOL,
      '--brief', brief,
      '--arm-manifest', ARM_MANIFEST,
      '--round', 'no-list',
      '--out', out,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /names no deliverable list/u);
    assert.match(run.stderr, /NOT substituted/u);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ISSUE-381: the parser is the shared parseDevArgs, so `--flag=value` is accepted
// (the hand-rolled parser refused it as unknown) and the refusals keep this
// script's own single-prefixed wording.
test('parseArgs accepts --flag=value for every flag', () => {
  const opts = parseArgs([
    '--brief=b.md', '--arm-manifest=a.json', '--round=r1',
    '--out=o.json', '--image-root=img', '--note=a note',
  ]);
  assert.deepEqual(opts, {
    brief: 'b.md', armManifest: 'a.json', round: 'r1',
    out: 'o.json', imageRoot: 'img', note: 'a note',
  });
});

test('the CLI keeps its refusal wording (missing value, unknown, required)', () => {
  const missing = spawnSync(process.execPath, [TOOL, '--brief'], { encoding: 'utf8' });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /^make-round-manifest: --brief needs a value$/m);

  const unknown = spawnSync(process.execPath, [TOOL, '--bogus', 'x'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /^make-round-manifest: unknown argument --bogus$/m);

  const required = spawnSync(process.execPath, [TOOL, '--round', 'r1'], { encoding: 'utf8' });
  assert.equal(required.status, 2, required.stderr);
  assert.match(required.stderr, /^make-round-manifest: --brief is required$/m);
});
