#!/usr/bin/env node
/**
 * Chunk 9's gate: the ±20% leader-set band is REPLACED by a measured tolerance,
 * and the replacement is honest about its n.
 *
 * The broken states this file detects, each by name:
 *
 *   - the old constant survives anywhere a gate reads (a `band` field, a
 *     `withinBand` count, a ±20% message) — the design says replaced, not blended;
 *   - a frozen per-session reading drifts from what a stored calibration
 *     re-derives (the tolerance would be a memory, not a measurement);
 *   - a partial set of calibrations passes as if it were the measurement;
 *   - the record grows a range or interval claim from three sessions, two of
 *     which have no defined horizon ratio;
 *   - the record cites an `extract.mjs` fill count (ISSUE-046).
 *
 * Every fixture is synthesized here in the module's input shape, so this runs on
 * either device without the 18 GB snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEASURED_TOLERANCE, compareToMeasured, poolStats, quantile, residualStats,
} from './tolerance.mjs';

const toleranceScript = pathOf('./tolerance.mjs');
const extractScript = pathOf('./extract.mjs');

function pathOf(relative) {
  return new URL(relative, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/** A calibration file carrying exactly the residual cells a reader re-derives. */
function calibrationOf(entries) {
  return {
    schema: 'racoons-multiturn-calibration/1',
    residuals: entries.map((residual, i) => ({
      requestId: `r${i}`, querySource: 'main_turn', segment: 0,
      depth: 100, observed: 100, residual,
    })),
  };
}

test('the measured record publishes per-session values and refuses a range', () => {
  assert.equal(MEASURED_TOLERANCE.schema, 'racoons-multiturn-tolerance/1');
  assert.equal(MEASURED_TOLERANCE.sessions.length, 3, 'the measured sample is not three sessions');
  // Honest n: three scored sessions, one with a defined horizon ratio. No interval.
  assert.match(MEASURED_TOLERANCE.rangeClaim, /^none/);
  assert.equal(MEASURED_TOLERANCE.nTooSmallForRange, true);
  assert.deepEqual(MEASURED_TOLERANCE.scope, {
    measured: 'the 3 sessions the harvest-compatible subset scored (ISSUE-041 chunk 8)',
    censored: '20 answered sessions carry no verdict of this lane and contribute no reading',
    corpusWide: false,
  });
  // The envelope is the LARGEST per-session median — a measured maximum, never an
  // average, a mean of medians, or a remembered constant.
  const medians = MEASURED_TOLERANCE.sessions.map(row => row.median);
  assert.equal(MEASURED_TOLERANCE.envelope, Math.max(...medians));
  assert.equal(MEASURED_TOLERANCE.envelope, 0.297191);
  // The band is named as replaced, and the record carries no `band` field.
  assert.match(MEASURED_TOLERANCE.replaces, /±20%/);
  assert.equal(Object.hasOwn(MEASURED_TOLERANCE, 'band'), false);
  const pooled = MEASURED_TOLERANCE.pooled;
  assert.equal(pooled.comparable, MEASURED_TOLERANCE.sessions
    .reduce((total, row) => total + row.comparable, 0));
  assert.ok(pooled.median <= pooled.p90 && pooled.p90 <= pooled.max,
    'the pooled quantiles are out of order, so the record is internally inconsistent');
});

test('residualStats reproduces the stored cells with the extract.mjs index rule', () => {
  // Ten distinct absolute cells: each order statistic names exactly one cell.
  const calibration = calibrationOf([0.01, 0.02, 0.03, -0.05, 0.06, 0.07, 0.08, 0.09, 0.1, -0.5]);
  const stats = residualStats(calibration);
  const cells = [0.01, 0.02, 0.03, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.5];
  assert.equal(stats.comparable, 10);
  assert.equal(stats.median, quantile(cells, 0.5));
  assert.equal(stats.p90, quantile(cells, 0.9));
  assert.equal(stats.max, 0.5, 'a negative residual was not taken by absolute value');
});

test('a derived row matching the frozen cells compares clean, and a drift names both values', () => {
  const matching = MEASURED_TOLERANCE.sessions.map(row => ({
    comparable: row.comparable, median: row.median, p90: row.p90, max: row.max,
  }));
  assert.deepEqual(compareToMeasured(matching), []);
  const problems = compareToMeasured([{
    comparable: 454, median: 0.9, p90: 0.9, max: 0.9,
  }]);
  assert.match(problems[0],
    /sess_109bc295-… median: derived 0\.9 != measured 0\.072366/);
});

test('a partial set of calibrations fails by name, so the freeze cannot pass by omission', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-tolerance-partial-'));
  try {
    const file = join(root, 'calibration.json');
    writeFileSync(file, JSON.stringify(calibrationOf([0.03, 0.04, 0.05])));
    const result = run(toleranceScript, ['--from', file]);
    assert.equal(result.status, 1, 'a partial set of calibrations passed the freeze');
    assert.match(result.stderr, /tolerance-drift: 3 comparable requests match no frozen session/);
    assert.match(result.stderr, /sess_109bc295.*was not derived/);
    assert.match(result.stdout, /gate {9}FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a calibration with no comparable residual is refused by name', () => {
  assert.throws(() => residualStats({ residuals: [] }), /no comparable residual/);
});

test('poolStats pools the cells; three sessions are not three pooled numbers', () => {
  const pooled = poolStats([calibrationOf([0.1, 0.3]), calibrationOf([0.5])]);
  assert.equal(pooled.sessions, 2);
  assert.equal(pooled.comparable, 3);
  assert.equal(pooled.median, 0.3);
  assert.equal(pooled.max, 0.5);
});

test('the tolerance record never cites an extract.mjs fill count (ISSUE-046)', () => {
  assert.match(MEASURED_TOLERANCE.fillCounts, /ISSUE-046/);
  assert.match(MEASURED_TOLERANCE.fillCounts, /select\.mjs/);
  const text = JSON.stringify(MEASURED_TOLERANCE);
  assert.equal(/"fills?"/i.test(text), false, 'the tolerance record carries a fill ledger field');
});

test('--print prints the record without reading a store; extract.mjs reads the module, not ±20%', () => {
  const printed = run(toleranceScript, ['--print']);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /envelope {5}29\.7%/);
  assert.match(printed.stdout, /replaces {5}the ±20% leader-set band/);
  assert.match(printed.stdout, /scope {8}the 3 sessions the harvest-compatible subset scored/);
  assert.match(printed.stdout, /censored {5}20 answered sessions/);
  assert.match(printed.stdout, /range {8}none/);
  const source = readFileSync(extractScript, 'utf8');
  assert.match(source, /from '\.\/tolerance\.mjs'/, 'extract.mjs does not read the measured record');
  assert.equal(/const BAND = 0\.20/.test(source), false, 'extract.mjs still holds the ±20% band');
  assert.equal(/estimate-band:/.test(source), false, 'extract.mjs still fails by the retired band name');
});
