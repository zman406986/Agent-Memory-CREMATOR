#!/usr/bin/env node
/**
 * ISSUE-060 prep — `live-fill.mjs`'s own gate.
 *
 * Three layers, cheapest first:
 *
 *   1. `fill` over a hand-built population: the two re-fetch counts stay
 *      separate, the byte sums exclude the machinery lane, and the overhead is
 *      reported without entering `bytesKept`.
 *   2. G6: a relative manifest transcript is refused by name; an absolute one
 *      passes.
 *   3. the CLI over the committed 040 fixture (two-arm) and a ONE-ARM
 *      conversion of the same transcript, checking the field names the paper
 *      reads and that the file is deterministic.
 *
 * Nothing here reads `scratchpad/`: it is disposable by law.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill } from './live-fill.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'live-fill.mjs');
const CONVERT = join(HERE, 'live-convert.mjs');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MANIFEST = join(REPO_ROOT, 'dev', 'bench', 'fixtures', 'live', 'manifest.json');
const FIXTURE_DIR = join(REPO_ROOT, 'dev', 'bench', 'fixtures', 'live');

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const convert = args => spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8' });
const sha256 = value => createHash('sha256').update(value).digest('hex');

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'racoons-fill-'));
}

/** A one-arm manifest naming the 040 transcript by ABSOLUTE path (G6). */
function oneArmManifest(root) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const transcript = resolve(FIXTURE_DIR, manifest.arms.racoons.transcript);
  assert.ok(isAbsolute(transcript));
  const path = join(root, 'manifest-one.json');
  writeFileSync(path, `${JSON.stringify({
    schema: 'racoons-live-fixture/1',
    arms: { racoons: { ...manifest.arms.racoons, transcript } },
  }, null, 2)}\n`);
  return path;
}

const convertFixture = (root, floor, manifest = MANIFEST) => {
  const out = join(root, `conv-${floor}-${manifest === MANIFEST ? 'two' : 'one'}`);
  const result = convert(['--manifest', manifest, '--floor', String(floor), '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  return out;
};

// ---------------------------------------------------------------------------
// 1. The hand-built population
// ---------------------------------------------------------------------------

const unit = (overrides = {}) => ({
  arm: 'racoons', tier: 'T1', step: 1, seq: 1, unitId: 'u', normKey: 'k',
  tool: 'read', bytes: 2000, path: 'C:/x/a.txt', substitutions: { arm: 0, tmp: 0 },
  composition: 'forget-with-partials', keptBytes: 500, gaps: 1, markerCount: 1,
  markerBytes: 100, summaryBytes: 20, framingBytes: 30, droppedBytes: 1500,
  ranges: [{ startLine: 1, endLineInclusive: 5 }], recallId: 'recall:x',
  rf: 0.75, used: false, usedBy: null, censoredClass: null,
  ...overrides,
});

const twoArmCensus = { floor: 1280, arms: { racoons: { steps: 10 }, vanilla: { steps: 12 } }, asks: {} };

test('the two re-fetch counts stay separate: a restore is not a reread', () => {
  const result = fill({
    units: [
      // Forgotten, restored by recall id.
      unit({ seq: 1, normKey: 'a', composition: 'forget-all', usedBy: 'restore:seq90', used: true, keptBytes: 100 }),
      // Forgotten, read again from disk.
      unit({ seq: 2, normKey: 'b', composition: 'forget-with-partials', usedBy: 'reread:seq91', used: true }),
      // Forgotten, never touched again: counted in neither re-fetch count.
      unit({ seq: 3, normKey: 'c', composition: 'forget-all', usedBy: null, used: false, keptBytes: 0 }),
      // Kept whole with a reread: NOT a re-fetch of forgotten content.
      unit({ seq: 4, normKey: 'd', composition: 'keepall', usedBy: 'reread:seq92', used: true, droppedBytes: 0 }),
    ],
    join: { pairs: [] },
    census: twoArmCensus,
    arms: 'two',
  });
  assert.equal(result.refetchRestores, 1);
  assert.equal(result.refetchRereads, 1);
  assert.equal(result.refetchBasis.forgotten, 3);
  assert.deepEqual(result.refetchBasis.restores.map(entry => entry.seq), [1]);
  assert.deepEqual(result.refetchBasis.rereads.map(entry => entry.seq), [2]);
});

test('the byte sums cover the scored rows and keep overhead out of kept', () => {
  const result = fill({
    units: [
      unit({ seq: 1, normKey: 'a', bytes: 2000, keptBytes: 500, droppedBytes: 1500,
        markerCount: 1, markerBytes: 100, summaryBytes: 20, framingBytes: 30 }),
      unit({ seq: 2, normKey: 'b', bytes: 1000, keptBytes: null, droppedBytes: 0,
        markerCount: 0, markerBytes: 0, summaryBytes: 0, framingBytes: 0,
        composition: 'ask-failed-fail-open' }),
      // The machinery lane is not a decision and is excluded from every sum.
      unit({ seq: 3, normKey: 'c', bytes: 9999, keptBytes: 0, droppedBytes: 0,
        censoredClass: 'machinery-at-rest-removal', composition: null }),
    ],
    join: { pairs: [] },
    census: { ...twoArmCensus, machinery: { censored: 1 }, compositionTable: { 'below-floor': 7 } },
    arms: 'two',
  });
  assert.equal(result.bytesTotal, 3000);
  // The keep-all row's kept is its whole body: bytes − droppedBytes = 1000.
  assert.equal(result.bytesKept, 1500);
  assert.equal(result.bytesDropped, 1500);
  // 1 marker × 100 + summary 20 + framing 30.
  assert.equal(result.overheadBytes, 150);
  assert.equal(result.bytesKept + result.overheadBytes, 1650, 'overhead must not be inside kept');
  assert.deepEqual(result.basis.excluded, { 'machinery-at-rest-removal': 1, 'below-floor': 7 });
  assert.equal(result.basis.scoredRows, 2);
});

test('entry asks per hundred steps counts entry asks only, and names the projection', () => {
  const result = fill({
    units: [unit({ seq: 1, normKey: 'a' })],
    join: { pairs: [] },
    census: {
      floor: 1280,
      arms: { racoons: { steps: 98, assistantMessages: 98 }, vanilla: { steps: 133 } },
      asks: { racoons: { prompts: 7, answers: {} }, vanilla: { prompts: 2, answers: {} } },
    },
    arms: 'two',
  });
  // 7 entry asks over the scored arm's 98 steps, never the vanilla side's asks.
  assert.equal(result.entryAsks, 7);
  assert.equal(result.steps, 98);
  assert.equal(result.entryAsksPerHundredSteps, Math.round((7 / 98) * 100 * 1e6) / 1e6);
  assert.equal(result.entryAsksBasis.projectedAskRows, 0);
});

test('below honest n the ratios are null with their reason, never a percentage', () => {
  const result = fill({
    units: [unit({ seq: 1, normKey: 'a' })],
    join: { pairs: [] },
    census: twoArmCensus,
    arms: 'two',
  });
  assert.equal(result.n, 1);
  assert.equal(result.ratiosPrintable, false);
  assert.equal(result.precision, null);
  assert.equal(result.removalRecall, null);
  assert.equal(result.usedRecall, null);
  assert.match(result.ratioNulls[0].reason, /N_P = 1 < 6/);
  // The bytes are not ratios: they still print.
  assert.equal(result.bytesTotal, 2000);
});

// ---------------------------------------------------------------------------
// 2. G6 — a relative transcript is refused by name
// ---------------------------------------------------------------------------

test('G6: a relative manifest transcript is refused, an absolute one passes', () => {
  const root = freshDir();
  try {
    const unitsDir = convertFixture(root, 1280);
    const relative = join(root, 'manifest-relative.json');
    writeFileSync(relative, `${JSON.stringify({
      arms: { racoons: { transcript: 'racoons.session.v4.jsonl', armRoot: 'C:\\x' } },
    })}\n`);
    const refused = run(['--units', unitsDir, '--manifest', relative]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /manifest-transcript-relative: arm racoons names/);
    assert.match(refused.stderr, /ABSOLUTE transcript path/);

    const accepted = run(['--units', unitsDir, '--manifest', oneArmManifest(root)]);
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The CLI over the committed fixture, both arms and one
// ---------------------------------------------------------------------------

test('the two-arm fixture fills the paper fields, deterministically', () => {
  const root = freshDir();
  try {
    const unitsDir = convertFixture(root, 1280);
    const first = join(root, 'fill-a');
    const second = join(root, 'fill-b');
    for (const out of [first, second]) {
      const result = run(['--units', unitsDir, '--out', out]);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(readdirSync(first).sort(), ['live-fill.json']);
    assert.equal(sha256(readFileSync(join(first, 'live-fill.json'))),
      sha256(readFileSync(join(second, 'live-fill.json'))), 'two fill runs differ');

    const json = JSON.parse(readFileSync(join(first, 'live-fill.json'), 'utf8'));
    assert.equal(json.schema, 'racoons-live-fill/1');
    assert.equal(json.basis.mode, 'two-arm');
    // The 040 pinned population: 13 scored rows, every one an ask that failed
    // open, so nothing was dropped and the ratios are arithmetic.
    assert.equal(json.n, 13);
    assert.equal(json.precision, 1);
    assert.equal(json.removalRecall, 0);
    assert.equal(json.usedRecall, 1);
    assert.equal(json.refetchRestores, 0);
    assert.equal(json.refetchRereads, 0);
    assert.equal(json.bytesTotal, 109460);
    assert.equal(json.bytesKept, 109460);
    assert.equal(json.bytesDropped, 0);
    assert.equal(json.overheadBytes, 0);
    assert.equal(json.steps, 98);
    assert.equal(json.entryAsks, 0);
    assert.equal(json.entryAsksPerHundredSteps, 0);
    assert.deepEqual(Object.keys(json.censoring), [
      'never-seen', 'unjoined-content', 'refused-ask', 'no-legal-answer',
      'unlabelable-used', 'racoons-only',
    ]);
    assert.equal(json.censoring['refused-ask'], 65);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a one-arm conversion fills the same fields instead of returning null', () => {
  const root = freshDir();
  try {
    const unitsDir = convertFixture(root, 1280, oneArmManifest(root));
    const out = join(root, 'fill');
    const result = run(['--units', unitsDir, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(readFileSync(join(out, 'live-fill.json'), 'utf8'));
    assert.equal(json.basis.mode, 'one-arm');
    // G1's defect, closed: every unit is T3 by construction, yet the ratios are
    // measured over the solo arm's 31 path-bearing rows instead of null.
    assert.equal(json.n, 31);
    assert.equal(json.ratiosPrintable, true);
    assert.equal(json.precision, 1);
    assert.equal(json.removalRecall, 0);
    assert.equal(json.usedRecall, 1);
    assert.equal(json.bytesTotal, 559147);
    assert.equal(json.bytesKept, 559147);
    assert.equal(json.bytesDropped, 0);
    assert.equal(json.overheadBytes, 0);
    assert.equal(json.censoring['unjoined-content'], 0, 'T3 is by construction, not a failed join');
    assert.equal(json.censoring['unlabelable-used'], 34);
    assert.equal(json.steps, 98);
    assert.equal(json.entryAsks, 0);
    // No entry-ask prompt exists in this transcript: the field says the zero is
    // the ask lane not firing, never a measured ask rate.
    assert.match(json.entryAsksNote, /no entry-ask prompt in the transcript/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one arm with join pairs is refused rather than scored as either', () => {
  const root = freshDir();
  try {
    const unitsDir = convertFixture(root, 1280);
    const out = join(root, 'fill');
    const refused = run(['--units', unitsDir, '--out', out, '--one-arm']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /arms-one-refused/);
    assert.equal(readdirSync(root).includes('fill'), false, 'a refused run wrote output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing input is an error by name, not an empty summary', () => {
  const root = freshDir();
  try {
    const result = run(['--units', join(root, 'nowhere')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /input-absent: units at /);
    mkdirSync(join(root, 'partial'), { recursive: true });
    const converted = convertFixture(root, 1280);
    writeFileSync(join(root, 'partial', 'live-units.jsonl'),
      readFileSync(join(converted, 'live-units.jsonl')));
    const second = run(['--units', join(root, 'partial')]);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /input-absent: join at /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
