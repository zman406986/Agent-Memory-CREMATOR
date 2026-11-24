#!/usr/bin/env node
/**
 * Chunk 9 — the MEASURED calibration tolerance, replacing the leader-set ±20%
 * band (design §7 chunk 1: "chunk 9 replaces it with the measured corpus
 * residual range").
 *
 * Usage:
 *   node dev/bench/multiturn/tolerance.mjs --from <calibration.json>...
 *   node dev/bench/multiturn/tolerance.mjs --print
 *
 *   --from   the `calibration.json` files of the records the tolerance was
 *            measured on. Each is re-derived here and matched to the frozen
 *            record by its comparable-request count; a row that drifts, or a
 *            file that matches no frozen session, is named and exits 1.
 *   --print  print the frozen record without re-deriving it.
 *
 * ## What replaced what
 *
 * `extract.mjs` used to gate the reconstruction at a fixed ±20% of
 * `model_usage.input_tokens` (median absolute residual), a number the design
 * called a leader-set tolerance *pending measurement*. That band is REPLACED,
 * not blended: there is no ±x% constant left. The gate now reads the envelope
 * below — the largest per-session median actually measured — and a session
 * above it fails by name.
 *
 * ## Why there is no "range"
 *
 * The measured reading covers the three sessions the harvest-compatible subset
 * scored (ISSUE-041 chunk 8), because those are the only sessions whose
 * `calibration.json` exists. With n = 3 — one of them with a defined horizon
 * ratio, two with an undefined one — there is no defensible interval, so the
 * record publishes the per-session values and refuses to reduce them to a band.
 * The envelope is the observed maximum of those medians, which makes the gate a
 * measured ceiling on this sample and nothing more: it is not corpus-wide, and
 * the 20 answered sessions censored by class contribute no reading.
 *
 * ## The estimate, restated, because the tolerance measures it
 *
 *   depth = base(segment) + bytesAfterTail(excluding summary) / 4
 *
 * The residual is |depth − input_tokens| / input_tokens, over requests with an
 * observed depth (`input_tokens > 0`) that are transcript-bearing (`session_title`
 * excluded, both exemptions counted by name in each `calibration.json`).
 *
 * Exit: 0 = the record holds (or every derived row matches); 1 = a drift; 2 =
 *       bad arguments or an unreadable calibration file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * The frozen tolerance record. Numbers are the 2026-10-25 chunk-9 re-run,
 * re-derived from the `residuals[]` cells each `calibration.json` publishes.
 * Those cells are rounded to six decimals, so every value here is exactly what
 * a reader recomputes from the stored file; `residualSummary` in the same file
 * carries the same readings before that rounding (they differ in the seventh
 * decimal and are print-identical at one decimal).
 */
export const MEASURED_TOLERANCE = Object.freeze({
  schema: 'racoons-multiturn-tolerance/1',
  replaces: 'the ±20% leader-set band of design §7 chunk 1 (pending measurement; now replaced)',
  reading: 'median absolute residual of the reconstructed depth against model_usage.input_tokens, per session',
  measuredOn: '2026-10-25',
  snapshotDigest: '42b95de5222f0374ad456758d4a442dcb66b4eddeb0fd897bc86c9ee04751a84',
  sessions: Object.freeze([
    Object.freeze({
      session: 'sess_109bc295-…',
      comparable: 454,
      median: 0.072366,
      p90: 0.167028,
      max: 0.284679,
    }),
    Object.freeze({
      session: 'sess_2aefabae-…',
      comparable: 229,
      median: 0.111036,
      p90: 0.367803,
      max: 0.475584,
    }),
    Object.freeze({
      session: 'sess_5904be72-…',
      comparable: 139,
      median: 0.297191,
      p90: 0.36234,
      max: 0.37928,
    }),
  ]),
  pooled: Object.freeze({
    sessions: 3,
    comparable: 822,
    median: 0.10938,
    p90: 0.342628,
    max: 0.475584,
  }),
  // The gate's ceiling: the largest per-session median on this sample. The
  // session that sets it passes exactly at it (a knife edge by construction,
  // not by luck); a session above it is either a new session class or a
  // regression in the estimator, and the gate names it either way.
  envelope: 0.297191,
  envelopeReading: 'the largest per-session median measured; a session above it fails by name',
  nTooSmallForRange: true,
  rangeClaim: 'none — three sessions, one with a defined horizon ratio; the per-session values are published individually, never reduced to a band',
  scope: Object.freeze({
    measured: 'the 3 sessions the harvest-compatible subset scored (ISSUE-041 chunk 8)',
    censored: '20 answered sessions carry no verdict of this lane and contribute no reading',
    corpusWide: false,
  }),
  fillCounts: 'not cited: extract.mjs counts a user /compact as an auto fill and drops an unbound fill (ISSUE-046); fill counts come from select.mjs',
});

/** |depth − observed| / observed, over the comparable requests of one calibration. */
export function residualStats(calibration) {
  const sorted = calibration.residuals
    .map(entry => Math.abs(entry.residual))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('calibration carries no comparable residual');
  }
  return {
    comparable: sorted.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}

/** Quantile with the same index rule `extract.mjs` uses, so the two agree. */
export function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** The pooled reading over the given rows (the record's own `pooled` shape). */
export function poolStats(calibrations) {
  const all = calibrations
    .flatMap(calibration => calibration.residuals.map(entry => Math.abs(entry.residual)))
    .sort((a, b) => a - b);
  return {
    sessions: calibrations.length,
    comparable: all.length,
    median: quantile(all, 0.5),
    p90: quantile(all, 0.9),
    max: all[all.length - 1],
  };
}

/** Relative-float equality, tight enough that a real drift is never equal. */
function same(left, right) {
  if (left === right) return true;
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  return Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Match each derived row to a frozen session by its comparable-request count,
 * then compare every reading. Returns the drift list, never a boolean: a
 * mismatched row is named with both values so a reader can see which end moved.
 */
export function compareToMeasured(derived, measured = MEASURED_TOLERANCE) {
  const problems = [];
  const remaining = new Map(measured.sessions.map(row => [row.comparable, row]));
  for (const row of derived) {
    const frozen = remaining.get(row.comparable);
    if (frozen === undefined) {
      problems.push(`${row.comparable} comparable requests match no frozen session`);
      continue;
    }
    remaining.delete(row.comparable);
    for (const field of ['median', 'p90', 'max']) {
      if (!same(row[field], frozen[field])) {
        problems.push(`${frozen.session} ${field}: derived ${row[field]} != measured ${frozen[field]}`);
      }
    }
  }
  if (remaining.size > 0) {
    for (const row of remaining.values()) {
      problems.push(`${row.session} was not derived (no calibration supplied)`);
    }
  }
  return problems;
}

function readCalibration(path) {
  const absolute = resolve(REPO_ROOT, path);
  if (!existsSync(absolute)) throw new Error(`calibration-absent: ${absolute} does not exist`);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  if (parsed.schema !== 'racoons-multiturn-calibration/1') {
    throw new Error(`calibration-schema: ${absolute} is ${parsed.schema}`);
  }
  return parsed;
}

function fixed(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function report(measured) {
  const lines = [
    'tolerance',
    '  reading      ' + measured.reading,
    `  replaces     ${measured.replaces}`,
    `  measured     ${measured.measuredOn} on digest ${measured.snapshotDigest.slice(0, 8)}…`,
    `  scope        ${measured.scope.measured}`,
    `  censored     ${measured.scope.censored}`,
    `  corpus-wide  ${measured.scope.corpusWide} (n too small for a range)`,
    '  session                     n     median    p90      max',
  ];
  for (const row of measured.sessions) {
    lines.push(`  ${row.session.padEnd(26)} ${String(row.comparable).padStart(4)}`
      + `  ${fixed(row.median).padStart(7)} ${fixed(row.p90).padStart(7)} ${fixed(row.max).padStart(7)}`);
  }
  lines.push(`  pooled                      ${String(measured.pooled.comparable).padStart(4)}`
    + `  ${fixed(measured.pooled.median).padStart(7)} ${fixed(measured.pooled.p90).padStart(7)}`
    + ` ${fixed(measured.pooled.max).padStart(7)}`);
  lines.push(`  envelope     ${fixed(measured.envelope)} — ${measured.envelopeReading}`);
  lines.push(`  range        ${measured.rangeClaim}`);
  lines.push(`  fills        ${measured.fillCounts}`);
  return lines.join('\n');
}

const TOLERANCE_OPTIONS = optionsOf([
  ['--from', 'string', 'from', { multiple: true }],
  ['--print', 'boolean'],
]);

const TOLERANCE_USAGE = 'usage: node dev/bench/multiturn/tolerance.mjs --from <calibration.json>... | --print\n';

function main() {
  const { values } = parseDevArgs(process.argv.slice(2), {
    options: TOLERANCE_OPTIONS,
    help: TOLERANCE_USAGE,
  });
  if (values.print === true) {
    process.stdout.write(`${report(MEASURED_TOLERANCE)}\n`);
    return;
  }
  const files = values.from ?? [];
  if (files.length === 0) throw new Error('--from or --print is required');
  const calibrations = files.map(readCalibration);
  const derived = calibrations.map(residualStats);
  const problems = compareToMeasured(derived);
  const pooledProblems = (() => {
    const pooled = poolStats(calibrations);
    const out = [];
    for (const field of ['sessions', 'comparable', 'median', 'p90', 'max']) {
      if (!same(pooled[field], MEASURED_TOLERANCE.pooled[field])) {
        out.push(`pooled ${field}: derived ${pooled[field]} != measured ${MEASURED_TOLERANCE.pooled[field]}`);
      }
    }
    return out;
  })();
  process.stdout.write(`${report(MEASURED_TOLERANCE)}\n`);
  process.stdout.write(`  gate         ${problems.length + pooledProblems.length === 0 ? 'ok' : 'FAIL'}\n`);
  for (const problem of [...problems, ...pooledProblems]) {
    process.stderr.write(`tolerance-drift: ${problem}\n`);
  }
  if (problems.length + pooledProblems.length > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
