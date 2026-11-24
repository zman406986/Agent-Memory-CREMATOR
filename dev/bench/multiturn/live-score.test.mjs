#!/usr/bin/env node
/**
 * Phase R v2 R-2(e) — the metric producer's own gate.
 *
 * Three layers, cheapest first:
 *
 *   1. `ratiosOf`'s null branches: every undefined ratio is `null` with a
 *      reason and a count, never a zero that a reader would take as measured.
 *   2. `score`'s arithmetic over a hand-built population: P, RR, UR and `P_b`,
 *      the keep-all `rf = 0` entry, the honest-n line, the six censoring
 *      classes and the no-legal-answer defect.
 *   3. the CLI over the in-repo fixture at both floors, carrying the pins the
 *      plan states (N_P = 13 at 1280 B; 4 at the old bar).
 *   4. the one-arm reading (run B): the same fixture converted with a solo
 *      manifest marks every unit T3, and the scorer must still score the solo
 *      arm's rows rather than return null for every ratio.
 *
 * Nothing here reads `scratchpad/`: it is disposable by law.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ratiosOf, resolveArms, score } from './live-score.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'live-score.mjs');
const CONVERT = join(HERE, 'live-convert.mjs');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'dev', 'bench', 'fixtures', 'live');
const MANIFEST = join(FIXTURE_DIR, 'manifest.json');

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const convert = args => spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8' });
const sha256 = value => createHash('sha256').update(value).digest('hex');

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'racoons-score-'));
}

/** Convert the in-repo fixture once into a fresh directory; return that dir. */
function convertFixture(root, floor, manifest = MANIFEST) {
  const out = join(root, `out-${floor}${manifest === MANIFEST ? '' : '-one'}`);
  const result = convert(['--manifest', manifest, '--floor', String(floor), '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  return out;
}

/**
 * A one-arm manifest naming the 040 transcript by ABSOLUTE path: the converter
 * resolves a relative one against `dev/bench/fixtures/live` (G6), and the
 * scratch directory this test writes to is not that directory.
 */
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

const readUnits = dir => readFileSync(join(dir, 'live-units.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);

/** One scored row as `ratiosOf` reads it. */
const row = (rf, used, droppedBytes, seq = 1) => ({ seq, rf, used, droppedBytes });

const CLASSES = [
  'never-seen', 'unjoined-content', 'refused-ask', 'no-legal-answer',
  'unlabelable-used', 'racoons-only',
];

// ---------------------------------------------------------------------------
// 1. The null branches
// ---------------------------------------------------------------------------

test('an undefined ratio is null with a reason, never a zero', () => {
  const empty = ratiosOf([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.P, null);
  assert.equal(empty.RR, null);
  assert.equal(empty.UR, null);
  assert.equal(empty.P_b, null);
  assert.deepEqual(empty.nulls.map(entry => entry.metric), ['P', 'RR', 'UR', 'P_b']);
  for (const entry of empty.nulls) assert.match(entry.reason, /\S/);

  // Every unit read again: the unused set is empty, so RR has no population.
  const allUsed = ratiosOf([row(0.5, true, 10), row(0.25, true, 5)]);
  assert.equal(allUsed.RR, null);
  assert.equal(allUsed.UR, 1 - (0.5 + 0.25) / 2);
  assert.equal(allUsed.P, 1 - 0.75 / 2);

  // No unit read again: UR has no population.
  const noneUsed = ratiosOf([row(0.5, false, 10), row(0.25, false, 5)]);
  assert.equal(noneUsed.UR, null);
  assert.equal(noneUsed.RR, (0.5 + 0.25) / 2);
  assert.equal(noneUsed.P, 1);

  // Nothing dropped anywhere: P_b has no denominator, and P/UR are arithmetically
  // pinned at 1 — true but empty.
  const nothingDropped = ratiosOf([row(0, false, 0), row(0, true, 0)]);
  assert.equal(nothingDropped.P_b, null);
  assert.equal(nothingDropped.sumDropped, 0);
  assert.ok(nothingDropped.nulls.some(entry => entry.metric === 'P_b'));
});

test('a keep-all row enters as rf = 0 and lowers no ratio', () => {
  // One forget (rf 0.5, unused) and one keep-all (rf 0, used).
  const ratios = ratiosOf([row(0.5, false, 50), row(0, true, 0)]);
  assert.equal(ratios.n, 2);
  assert.equal(ratios.P, 1);
  assert.equal(ratios.RR, 0.5);
  assert.equal(ratios.UR, 1);
  assert.equal(ratios.P_b, 1);
});

// ---------------------------------------------------------------------------
// 2. `score` over a hand-built population
// ---------------------------------------------------------------------------

const unit = (overrides = {}) => ({
  arm: 'racoons', tier: 'T1', step: 1, seq: 1, unitId: 'u', normKey: 'k',
  tool: 'read', bytes: 2000, path: 'C:/x/a.txt', substituted: { arm: 0, tmp: 0 },
  composition: 'forget-with-partials', keptBytes: 500, gaps: 1, markerCount: 1,
  markerBytes: 100, summaryBytes: 20, framingBytes: 0, droppedBytes: 1500,
  ranges: [{ startLine: 1, endLineInclusive: 5 }], recallId: 'recall:x',
  rf: 0.75, used: false, usedBy: null, censoredClass: null,
  ...overrides,
});

const emptyJoin = { pairs: [] };
const emptyCensus = { censoring: {} };

test('P, RR, UR and P_b are the plan\'s four formulas, over J_L only', () => {
  const result = score({
    units: [
      unit({ seq: 1, normKey: 'a', rf: 0.5, droppedBytes: 1000, used: true }),
      unit({ seq: 2, normKey: 'b', rf: 0.25, droppedBytes: 500, used: false }),
      // Not labelable: its `<path>` is absent, so it is outside J_L and outside
      // every ratio, while still counted beside them.
      unit({ seq: 3, normKey: 'c', path: null, rf: 1, droppedBytes: 2000, used: true }),
    ],
    join: emptyJoin,
    census: emptyCensus,
    floor: 1280,
  });
  assert.equal(result.ratioBasis.n, 2);
  assert.equal(result.ratioBasis.P, 1 - 0.5 / 2);
  assert.equal(result.ratioBasis.RR, 0.25);
  assert.equal(result.ratioBasis.UR, 1 - 0.5);
  assert.equal(result.ratioBasis.P_b, Math.round((500 / 1500) * 1e6) / 1e6);
  assert.equal(result.ratiosPrintable, false, 'two units is below honest n');
  assert.equal(result.beside.unlabelableUsed, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.units.length, 2);
});

test('honest n is six: at five the table is the deliverable, at six the ratios print', () => {
  const population = count => Array.from({ length: count }, (_, index) => unit({
    seq: index + 1, normKey: `k${index}`, path: `C:/x/${index}.txt`,
    rf: 0.5, droppedBytes: 100, used: index % 2 === 0,
  }));
  const five = score({ units: population(5), join: emptyJoin, census: emptyCensus, floor: 1280 });
  assert.equal(five.ratioBasis.n, 5);
  assert.equal(five.ratiosPrintable, false);
  assert.match(five.artefact, /the unit table is the deliverable; no percentage prints/);
  const six = score({ units: population(6), join: emptyJoin, census: emptyCensus, floor: 1280 });
  assert.equal(six.ratioBasis.n, 6);
  assert.equal(six.ratiosPrintable, true);
  assert.match(six.artefact, /the ratios print, and the unit table is still the artefact/);
});

/** The module's class list, read from the file so a silent edit fails here. */
function CENSORING_NAMES() {
  const source = readFileSync(join(HERE, 'live-score.mjs'), 'utf8');
  const match = /const CENSORING_CLASSES = \[\s*([\s\S]*?)\];/.exec(source);
  assert.ok(match !== null, 'CENSORING_CLASSES is not a literal in live-score.mjs');
  return [...match[1].matchAll(/'([^']+)'/g)].map(hit => hit[1]);
}

test('a no-legal-answer unit is refused as a core defect, not counted', () => {
  assert.throws(
    () => score({
      units: [unit({ censoredClass: 'no-legal-answer' })],
      join: emptyJoin,
      census: emptyCensus,
      floor: 1280,
    }),
    /no-legal-answer: a legal answer was classified unanswerable/,
  );
});

test('a population where nothing was dropped says so instead of printing 1.0', () => {
  const result = score({
    units: [
      unit({ seq: 1, normKey: 'a', rf: 0, droppedBytes: 0, used: false, composition: 'keepall' }),
      unit({ seq: 2, normKey: 'b', rf: 0, droppedBytes: 0, used: true, composition: 'keepall' }),
    ],
    join: emptyJoin,
    census: emptyCensus,
    floor: 1280,
  });
  assert.equal(result.ratioBasis.sumDropped, 0);
  assert.equal(result.ratioBasis.P, 1);
  assert.equal(result.ratioBasis.UR, 1);
  assert.equal(result.ratioBasis.P_b, null);
  assert.match(result.degenerate, /measure[s]? nothing/);
});

// ---------------------------------------------------------------------------
// 3. The CLI over the in-repo fixture
// ---------------------------------------------------------------------------

test('the fixture scores to the pinned 13-row table, and its JSON is deterministic', () => {
  const root = freshDir();
  try {
    const units = convertFixture(root, 1280);
    const first = join(root, 'score-a');
    const second = join(root, 'score-b');
    for (const out of [first, second]) {
      const result = run(['--units', units, '--out', out]);
      assert.equal(result.status, 0, result.stderr);
    }
    const filesOf = dir => Object.fromEntries(readdirSync(dir).sort()
      .map(name => [name, sha256(readFileSync(join(dir, name)))]));
    assert.deepEqual(readdirSync(first).sort(), ['live-score.json', 'live-table.txt']);
    assert.deepEqual(filesOf(first), filesOf(second), 'two scoring runs differ');

    const result = JSON.parse(readFileSync(join(first, 'live-score.json'), 'utf8'));
    assert.equal(result.schema, 'racoons-live-score/1');
    assert.equal(result.floor, 1280);
    assert.equal(result.ratioBasis.n, 13, 'N_P is not the pinned 13');
    assert.equal(result.ratiosPrintable, true);
    // Every joined unit at this floor is an ask that failed open: d = 0, so
    // P = 1 and UR = 1 are arithmetic, and the run prints that fact.
    assert.equal(result.ratioBasis.P, 1);
    assert.equal(result.ratioBasis.RR, 0);
    assert.equal(result.ratioBasis.UR, 1);
    assert.equal(result.ratioBasis.P_b, null);
    assert.equal(result.ratioBasis.sumDropped, 0);
    assert.equal(result.beside.unlabelableUsed, 34);
    assert.equal(result.beside.neverSeen, 43);
    assert.equal(result.beside.racoonsOnly, 52);
    assert.deepEqual(result.censoring, {
      'never-seen': 43,
      'unjoined-content': 52,
      'refused-ask': 65,
      'no-legal-answer': 0,
      'unlabelable-used': 34,
      'racoons-only': 52,
    });
    assert.equal(result.units.length, 13);
    assert.equal(result.units.every(entry => entry.d === 0), true);

    const table = readFileSync(join(first, 'live-table.txt'), 'utf8');
    const dataRows = table.split('\n').filter(line => /^ {2}\d+\t/.test(line));
    assert.equal(dataRows.length, 13, 'the table is not 13 rows');
    assert.match(table, /^ {2}seq\tstep\tcomposition\tb\td\trf\tused\tusedBy$/m);
    for (const name of CLASSES) assert.match(table, new RegExp(`${name}=\\d+`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('at the old bar the sample is below honest n, so no percentage prints', () => {
  const root = freshDir();
  try {
    const units = convertFixture(root, 8192);
    const out = join(root, 'score');
    const result = run(['--units', units, '--out', out]);
    assert.equal(result.status, 0, result.stderr);

    const json = JSON.parse(readFileSync(join(out, 'live-score.json'), 'utf8'));
    assert.equal(json.ratioBasis.n, 4);
    assert.equal(json.ratiosPrintable, false);
    // The values stay in the JSON so a re-derivation is checkable; the human
    // block prints the suppression instead.
    assert.equal(json.ratioBasis.P, 1);

    const table = readFileSync(join(out, 'live-table.txt'), 'utf8');
    assert.match(table, /artefact {5}N_P = 4 < 6: the unit table is the deliverable/);
    assert.match(table, /^ {2}P {12}suppressed \(honest-n\)/m);
    assert.match(table, /^ {2}RR {11}suppressed \(honest-n\)$/m);
    assert.match(table, /^ {2}UR {11}suppressed \(honest-n\)$/m);
    assert.match(table, /^ {2}P_b {10}suppressed \(honest-n\)$/m);
    assert.doesNotMatch(table, /^ {2}P {12}1\b/m, 'a percentage printed below honest n');
    assert.equal(table.split('\n').filter(line => /^ {2}\d+\t/.test(line)).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing input is an error by name, not an empty score', () => {
  const root = freshDir();
  try {
    const result = run(['--units', join(root, 'nowhere')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /input-absent: units at /);
    // The units file alone is not enough: the join and census sidecars are read.
    const converted = convertFixture(root, 1280);
    const partial = join(root, 'partial');
    mkdirSync(partial, { recursive: true });
    copyFileSync(join(converted, 'live-units.jsonl'), join(partial, 'live-units.jsonl'));
    const second = run(['--units', partial]);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /input-absent: join at /);
    assert.ok(readUnits(converted).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The two-arm reading must not move
// ---------------------------------------------------------------------------

/**
 * The 040 fixture's two-arm output, byte for byte. The paths inside come from
 * the committed manifest and transcript, so these hashes hold on either
 * machine. A change here means a two-arm number or field moved — that is a
 * product decision, never a test fix.
 *
 * ISSUE-219 redacted the committed transcripts byte-preservingly (same
 * lengths, same counts, same coverage pins). The JSON hash below moved with
 * the replaced text; the table hash and the numbers they encode did not.
 */
const TWO_ARM = {
  json: '2723989804fd590f1ee18a5d0c9d9521af3dd1f47b7fc9aa92df5903ddb30058',
  table: '7d7128f8a83ec635904122d59d6f25f91a1145ea54f2edefe5f8a6be1dbeafc8',
};

test('the two-arm output is byte-identical to the pre-one-arm scorer', () => {
  const root = freshDir();
  try {
    const units = convertFixture(root, 1280);
    const out = join(root, 'score');
    const result = run(['--units', units, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sha256(readFileSync(join(out, 'live-score.json'))), TWO_ARM.json,
      'the two-arm JSON moved');
    assert.equal(sha256(readFileSync(join(out, 'live-table.txt'))), TWO_ARM.table,
      'the two-arm table moved');
    const json = JSON.parse(readFileSync(join(out, 'live-score.json'), 'utf8'));
    // The one-arm block exists on a one-arm record only.
    assert.equal('scoring' in json, false);
    assert.doesNotMatch(readFileSync(join(out, 'live-table.txt'), 'utf8'), /^ {2}arms {9}/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. The one-arm reading (run B)
// ---------------------------------------------------------------------------

test('a forced reading the record contradicts is refused, not reinterpreted', () => {
  assert.throws(
    () => resolveArms({ census: { arms: { racoons: {}, vanilla: {} } }, join: { pairs: [] }, arms: 'one' }),
    /arms-one-refused/,
  );
  assert.throws(
    () => resolveArms({ census: { arms: { racoons: {} } }, join: { pairs: [{ key: 'k' }] }, arms: 'two' }),
    /arms-two-refused/,
  );
  assert.throws(
    () => resolveArms({ census: { arms: {} }, join: { pairs: [] } }),
    /arms-none/,
  );
  assert.equal(resolveArms({ census: { arms: { racoons: {} } }, join: { pairs: [] } }).mode, 'one-arm');
  assert.equal(resolveArms({ census: { arms: { racoons: {}, vanilla: {} } }, join: { pairs: [{}] } }).mode,
    'two-arm');
  // A hand-built census with no `arms` block stays on the two-arm path.
  assert.equal(resolveArms({ census: {}, join: { pairs: [] } }).mode, 'two-arm');
});

test('one arm scores the solo arm\'s rows at any tier instead of returning null', () => {
  const oneArmCensus = { arms: { racoons: { steps: 9 } }, asks: {}, censoring: {} };
  const result = score({
    units: [
      unit({ seq: 1, normKey: 'a', tier: 'T3', rf: 0.5, droppedBytes: 1000, used: true }),
      unit({ seq: 2, normKey: 'b', tier: 'T3', rf: 0.25, droppedBytes: 500, used: false }),
      // The machinery lane is no decision: it is not a scored row.
      unit({ seq: 3, normKey: 'c', tier: 'T3', rf: 0, droppedBytes: 0, used: false,
        censoredClass: 'machinery-at-rest-removal', composition: null }),
      unit({ seq: 4, normKey: 'd', tier: 'T3', path: null, rf: 0.9, droppedBytes: 900, used: true }),
    ],
    join: { pairs: [] },
    census: oneArmCensus,
    floor: 1280,
  });
  assert.equal(result.scoring.mode, 'one-arm');
  assert.equal(result.scoring.detected, true);
  assert.equal(result.scoring.soloArm, 'racoons');
  assert.equal(result.scoring.byConstructionT3, 4);
  assert.equal(result.ratioBasis.n, 2, 'the T1 filter emptied the population');
  assert.equal(result.ratioBasis.P, 1 - 0.5 / 2);
  assert.equal(result.ratioBasis.RR, 0.25);
  assert.equal(result.beside.unlabelableUsed, 1);
  // T3 means "no second side", so the join classes are 0 by name.
  assert.equal(result.censoring['unjoined-content'], 0);
  assert.equal(result.censoring['never-seen'], 0);
  assert.equal(result.censoring['racoons-only'], 0);
});

test('the one-arm conversion of the 040 transcript scores 31 rows, not null', () => {
  const root = freshDir();
  try {
    const units = convertFixture(root, 1280, oneArmManifest(root));
    const out = join(root, 'score');
    const result = run(['--units', units, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(readFileSync(join(out, 'live-score.json'), 'utf8'));
    assert.equal(json.scoring.mode, 'one-arm');
    assert.equal(json.scoring.byConstructionT3, 65);
    assert.equal(json.ratioBasis.n, 31);
    assert.equal(json.ratiosPrintable, true);
    assert.equal(json.ratioBasis.P, 1);
    assert.equal(json.ratioBasis.RR, 0);
    assert.equal(json.ratioBasis.UR, 1);
    assert.equal(json.beside.unlabelableUsed, 34);
    const table = readFileSync(join(out, 'live-table.txt'), 'utf8');
    assert.match(table, /^ {2}arms {9}one-arm \(detected\) solo=racoons byConstructionT3=65$/m);
    assert.equal(table.split('\n').filter(line => /^ {2}\d+\t/.test(line)).length, 31);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--two-arm on a one-arm record exits 2 with the reason, writing nothing', () => {
  const root = freshDir();
  try {
    const units = convertFixture(root, 1280, oneArmManifest(root));
    const out = join(root, 'score');
    const result = run(['--units', units, '--out', out, '--two-arm']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /arms-two-refused/);
    assert.equal(readdirSync(root).includes('score'), false, 'a refused run wrote output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--help names the one-arm flags and the absolute-transcript requirement', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--one-arm/);
  assert.match(result.stdout, /--two-arm/);
  assert.match(result.stdout, /ABSOLUTE/);
  assert.match(result.stdout, /dev\/bench\/fixtures\/live/);
});
