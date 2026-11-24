#!/usr/bin/env node
/**
 * ISSUE-082: the real-API path gets a journal sink.
 *
 * The defect: the rig wrapper (the only thing that hands the shipped entry a
 * `journal` sink) was mounted on `replay !== null` alone, so a live run loaded
 * the shipped entry directly and every `journal(kind, fields)`
 * call the mount made was constructed and dropped. Live run B left 175 ledger
 * rows and zero journal lines; 10 of 12 unanswered entry asks have no
 * recoverable refusal code because of it.
 *
 * What these gates hold:
 *
 *   (a) a racoons arm on the live route mounts the wrapper and expects a journal —
 *       this is the line that was false before the fix;
 *   (b) `mock-replay` keeps the same wrapper and the same expectation;
 *   (c) the plain `mock` smoke keeps the shipped entry and expects no journal,
 *       so the smoke's evidence did not change;
 *   (d) `--plugin-entry` still wins on every provider and still says a journal
 *       was expected: naming the shipped entry is the red-proof, and a run that
 *       skipped its journal gates would hide the perturbation;
 *   (e) a line only the mount can write (`mounted`, naming the storage root the
 *       run used) is required, so a hand-written stub cannot satisfy the gate;
 *   (f) `bench-run.mjs` actually uses the decision and scans the real path.
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`).
 * (f) is still a static assertion, as `dist-hash.test.mjs` does for its own
 * mount field; (a)–(e) are pure functions over synthesized data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDist } from '../dsh-rig/build-dist.mjs';
import { EVIDENCE_FILE, apply } from '../dsh-rig/rig-plugin.mjs';
import { chooseMountEntry, mountedLineGate } from './mount-wiring.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(BENCH_DIR, 'bench-run.mjs'), 'utf8');

/** The two entries the racoons arm can mount. */
const WRAPPER = 'C:/repo/dev/dsh-rig/rig-plugin.mjs';
const SHIPPED = 'C:/dist/packages/adapters/dsh/src/plugin.js';

/**
 * The least a Cordis context the mount needs to apply: an event bus, an effect
 * scope and a logger. `rig-plugin.test.mjs` models the same host; this copy is
 * the two lines the mount-at-rest path actually touches.
 */
function fakeCtx() {
  const listeners = new Map();
  const cleanups = [];
  return {
    logger: { warn: () => {} },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (register) => { const fn = register(); if (typeof fn === 'function') cleanups.push(fn); },
  };
}

/** A journalState-shaped object with the lines a real run leaves behind. */
function journalOf(lines) {
  const byKind = {};
  for (const line of lines) byKind[line.kind] = (byKind[line.kind] ?? 0) + 1;
  return {
    emitted: true,
    verdict: 'parsed',
    files: [],
    unparsable: [],
    journal: {
      file: 'C:/evidence/racoons/cremator-events.jsonl',
      bytes: 1024,
      lines: lines.length,
      byKind,
      mounted: lines.find((line) => line.kind === 'mounted') ?? null,
    },
    ledger: { present: true },
  };
}

test('082 (a) the live route is gated like the replay: the wrapper is mounted', () => {
  assert.deepEqual(
    chooseMountEntry({ arm: 'racoons', provider: 'deepseek-official', pluginEntry: null }),
    { rigWrapper: true, journalGated: true },
  );
});

test('082 (a) deepseek-v4-pro is gated exactly like deepseek-official', () => {
  assert.deepEqual(
    chooseMountEntry({ arm: 'racoons', provider: 'deepseek-v4-pro', pluginEntry: null }),
    { rigWrapper: true, journalGated: true },
  );
});

test('082 (b) mock-replay keeps the wrapper and the expectation', () => {
  assert.deepEqual(
    chooseMountEntry({ arm: 'racoons', provider: 'mock-replay', pluginEntry: null }),
    { rigWrapper: true, journalGated: true },
  );
});

test('082 (c) the plain mock smoke keeps the shipped entry and expects no journal', () => {
  assert.deepEqual(
    chooseMountEntry({ arm: 'racoons', provider: 'mock', pluginEntry: null }),
    { rigWrapper: false, journalGated: false },
  );
});

test('082 (d) --plugin-entry still wins and still demands a journal (the red-proof)', () => {
  for (const provider of ['mock-replay', 'deepseek-official', 'deepseek-v4-pro']) {
    assert.deepEqual(
      chooseMountEntry({ arm: 'racoons', provider, pluginEntry: SHIPPED }),
      { rigWrapper: false, journalGated: true },
      `--plugin-entry must remove the sink on ${provider} but keep the gate armed`,
    );
  }
  // An explicit wrapper path is equally a plugin entry, and equally sink-less.
  assert.deepEqual(
    chooseMountEntry({ arm: 'racoons', provider: 'deepseek-official', pluginEntry: WRAPPER }),
    { rigWrapper: false, journalGated: true },
  );
});

test('082 (e) the vanilla arm mounts nothing and expects no journal', () => {
  for (const provider of ['mock', 'mock-replay', 'deepseek-official', 'deepseek-v4-pro']) {
    assert.deepEqual(
      chooseMountEntry({ arm: 'vanilla', provider, pluginEntry: null }),
      { rigWrapper: false, journalGated: false },
    );
  }
});

test('082 (e) only a mounted line naming this run\'s storage root passes', () => {
  const root = 'C:/evidence/racoons/storage';
  assert.equal(mountedLineGate(journalOf([
    { kind: 'rig-mount', evidenceDir: 'C:/evidence/racoons' },
    { kind: 'mounted', storageRoot: root },
    { kind: 'entry-ask-refused', code: 'entry-ask-empty' },
  ]), root).ok, true);

  // No sink at all: the failure names the missing sink, not a count of zero.
  assert.match(mountedLineGate(null, root).detail, /supplied no sink/u);
  assert.match(mountedLineGate({ emitted: false, journal: null }, root).detail, /supplied no sink/u);

  // A hand-written stub: real lines, but none the mount can only have written.
  assert.match(mountedLineGate(journalOf([
    { kind: 'rig-mount' }, { kind: 'entry-ask-refused', code: 'stub' },
  ]), root).detail, /mounted/u);

  // The right line, the wrong storage root: two runs' evidence are not equal.
  assert.match(mountedLineGate(journalOf([
    { kind: 'mounted', storageRoot: 'C:/elsewhere/storage' },
  ]), root).detail, /C:\/elsewhere\/storage/u);

  // A mount that opened the memory pair instead of the run's root is named too.
  assert.match(mountedLineGate(journalOf([
    { kind: 'mounted', storage: ':memory:' },
  ]), root).detail, /":memory:"/u);
});

test('082 (g) the wrapper writes the mounted line the real path gates on', async () => {
  // The whole contract in one offline run, with the harness keys the launcher
  // writes for the live route: `<evidence>/racoons` and `<evidence>/racoons/storage`.
  // A pass here means the sink reaches a file and the file carries the line the
  // gate above demands — the two halves of the defect, joined.
  const dir = mkdtempSync(join(tmpdir(), 'racoons-082-'));
  const racoonsEvidence = join(dir, 'racoons');
  const storageRoot = join(racoonsEvidence, 'storage');
  const previous = process.env.CREMATOR_RIG_DIST;
  process.env.CREMATOR_RIG_DIST = ensureDist({ quiet: true }).dir;
  try {
    await apply(fakeCtx(), { evidenceDir: racoonsEvidence, crematorStorageRoot: storageRoot,
      capBytes: 8192, capHeadBytes: 8192, sealMaxLatencyTurns: 1 });
    const file = join(racoonsEvidence, EVIDENCE_FILE);
    assert.equal(existsSync(file), true, 'the wrapper wrote a journal under <evidence>/racoons');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    // The launcher's own extraction, asserted as source in (f); here the FACT
    // is the artifact: exactly one mounted line, naming this run's root.
    const mounted = lines.filter((line) => line.kind === 'mounted');
    assert.equal(mounted.length, 1, 'one mounted line per apply');
    assert.equal(mounted[0].storageRoot, storageRoot,
      'the mount names the storage root this run configured');
    assert.equal(mountedLineGate(journalOf(lines), storageRoot).ok, true);
    // The root the gate expects is the one the launcher derives, so the two
    // sides cannot drift apart silently.
    assert.equal(mountedLineGate(journalOf(lines), join(racoonsEvidence, 'storage')).ok, true);
  } finally {
    if (previous === undefined) delete process.env.CREMATOR_RIG_DIST;
    else process.env.CREMATOR_RIG_DIST = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
