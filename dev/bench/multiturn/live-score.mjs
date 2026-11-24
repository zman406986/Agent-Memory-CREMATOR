#!/usr/bin/env node
/**
 * Phase R v2, R-2 — the metric producer: P, RR, UR, `P_b` from `live-units.jsonl`.
 *
 * Usage:
 *   node dev/bench/multiturn/live-score.mjs --units <dir> [--out <dir>] [--json]
 *        [--one-arm | --two-arm]
 *
 *   --units    a `live-convert.mjs` output directory (it must hold
 *              `live-units.jsonl`, `live-join.json` and `live-census.json`).
 *   --out      where `live-score.json` and `live-table.txt` land. Default: the
 *              `--units` directory. `<name>.tmp` then rename, as the converter.
 *   --json     print the JSON summary to stdout instead of the human block.
 *   --one-arm  force the one-arm reading (run B). `--two-arm` forces the
 *              two-arm reading. Neither flag: detect from `live-census.json`'s
 *              `arms` block — exactly one arm and no join pair is a one-arm
 *              record. Both flags at once, or a forced reading the sides
 *              contradict, is refused (exit 2).
 *
 * ## What is scored
 *
 * `J` is the racoons arm's own over-floor landed results that joined at T1.
 * `J_L` is `J` filtered to units whose `original(u)` carries a renderable
 * `<path>`; `N_P = |J_L|`. A unit's `d(u)` comes from `live-units.jsonl`
 * (`droppedBytes`: the ledger's number when a ledger was supplied, the marker's
 * own `<B>` otherwise), and `rf(u) = d(u)/b(u)` with a keep-all row entering as
 * `rf = 0`.
 *
 *   P   = 1 − Σ_{u∈J_L, used} rf(u) / N_P          null when N_P = 0
 *   RR  = mean_{u∈J_L, ¬used} rf(u)                 null when {¬used} is empty
 *   UR  = 1 − mean_{u∈J_L, used} rf(u)              null when {used} is empty
 *   P_b = Σ_{u∈J_L, ¬used} d(u) / Σ_{u∈J_L} d(u)    null when Σ d(u) = 0
 *
 * Every ratio prints `n`, `unlabelable-used`, `|never-seen|` and
 * `|racoons-only|` beside it, and every `null` prints its count and reason —
 * never `0`, because a zero would read as a measured result.
 *
 * ## One-arm records (run B)
 *
 * A one-arm record has no control side, so the converter's join has no pairs
 * and marks every unit T3 — not because a unit failed to join, but because
 * there is no second side to join to. Scoring the T1 subset would return an
 * empty population and null for every ratio. In one-arm mode `J` is the solo
 * arm's over-floor landed results at whatever tier the join assigned, and the
 * `unjoined-content`, `never-seen` and `racoons-only` counts are 0 BY NAME
 * (the T3 count prints as `scoring.byConstructionT3` instead). The two-arm
 * path is untouched: `arm === 'racoons' && tier === 'T1'`, same numbers.
 *
 * ## Run-B manifest requirement
 *
 * The converter resolves a relative manifest `transcript` against
 * `dev/bench/fixtures/live` (`live-convert.mjs:518`), so a run-B manifest MUST
 * carry an ABSOLUTE transcript path; a relative one is silently read from the
 * fixture directory instead of the run's evidence tree.
 *
 * ## Honest n
 *
 * ADR-0021: below six labelled units the unit table IS the deliverable and no
 * percentage prints. At `N_P ≥ 6` the ratios print and the table prints with
 * them, never replaced by them: thirteen units is a table, not a rate.
 *
 * ## Censoring classes, exactly these and no others
 *
 *   never-seen        a vanilla over-floor unit the racoons run never produced
 *   unjoined-content  T2/T3 — not scored
 *   refused-ask       §2's `ask-failed-fail-open`; in T1 it enters as d = 0, and
 *                     a nonzero count is a printed finding
 *   no-legal-answer   structurally empty (ADR-0020 §2) — any occurrence is a
 *                     core defect, so the run refuses on it
 *   unlabelable-used  no renderable `<path>`; outside J_L and every ratio
 *   racoons-only      an `original(u)` vanilla never produced; composition only,
 *                     never in N_P
 *
 * There is NO `bar-margin` class: land-first has one body and one bar, so "raw
 * clears the floor but the render does not" cannot occur.
 *
 * ## Transcript-only
 *
 * This module reads `live-units.jsonl` and the two sidecars. It never reads a
 * journal sink and never opens a session log: on the live route there is no
 * sink, and composition came from the surface events plus the ledger.
 *
 * Exit: 0 = scored; 2 = bad arguments, a missing input, or the no-legal-answer
 *       defect.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
/** ADR-0021's honest-n line: below this, the table is the artefact. */
const HONEST_N = 6;
const CENSORING_CLASSES = [
  'never-seen', 'unjoined-content', 'refused-ask', 'no-legal-answer',
  'unlabelable-used', 'racoons-only',
];

function usage() {
  return 'usage: node dev/bench/multiturn/live-score.mjs --units <dir> [--out <dir>] [--json]'
    + ' [--one-arm | --two-arm]\n'
    + '  --one-arm  score the solo arm of a one-arm record (run B); --two-arm forces the\n'
    + '             two-arm reading; default: detect from live-census.json\'s arms block.\n'
    + '  run-B manifest: live-convert.mjs resolves a RELATIVE transcript against\n'
    + '             dev/bench/fixtures/live, so the run-B manifest must name an ABSOLUTE\n'
    + '             transcript path (or the fixture transcript is read by mistake).';
}

const LIVE_SCORE_OPTIONS = optionsOf([
  ['--units', 'string'],
  ['--out', 'string'],
  ['--json', 'boolean'],
  ['--one-arm', 'boolean'],
  ['--two-arm', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: LIVE_SCORE_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  if (values.oneArm && values.twoArm) {
    throw new Error(`--one-arm and --two-arm are exclusive\n${usage()}`);
  }
  const opts = {
    units: values.units ?? null,
    out: values.out ?? null,
    json: values.json ?? false,
    arms: values.oneArm ? 'one' : values.twoArm ? 'two' : 'auto',
  };
  if (opts.units === null) throw new Error(`--units is required\n${usage()}`);
  return opts;
}

/**
 * One-arm or two-arm, from the record itself: exactly one arm and no join pair
 * is a one-arm record (the converter's own `oneArm` definition). A forced
 * reading the record contradicts is refused — never silently reinterpreted.
 * A census with no `arms` block at all (a hand-built population) is read as a
 * two-arm record unless `--one-arm` says otherwise.
 */
export function resolveArms({ census, join: joinSidecar, arms = 'auto' }) {
  const names = census.arms === undefined ? null : Object.keys(census.arms);
  const pairCount = (joinSidecar.pairs ?? []).length;
  if (names === null) {
    if (arms === 'two') return { mode: 'two-arm', detected: false, names: [] };
    if (arms === 'one') return { mode: 'one-arm', detected: false, names: [] };
    return { mode: 'two-arm', detected: false, names: [] };
  }
  if (names.length === 0) {
    throw new Error('arms-none: live-census.json names no arm; the record has nothing to score');
  }
  const detected = names.length === 1 && pairCount === 0;
  if (arms === 'one' && !detected) {
    throw new Error(`arms-one-refused: the record names ${names.length} arm(s) and`
      + ` ${pairCount} join pair(s), so it is not a one-arm record`);
  }
  if (arms === 'two' && detected) {
    throw new Error('arms-two-refused: the record names one arm and no join pair;'
      + ' score it with --one-arm or let the default detect it');
  }
  if (arms === 'two' && names.length === 1 && pairCount > 0) {
    throw new Error('arms-two-refused: one arm with join pairs is not a two-arm record');
  }
  return { mode: detected ? 'one-arm' : 'two-arm', detected, names };
}

const mean = values => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const sum = values => values.reduce((a, b) => a + b, 0);
const round = value => (value === null ? null : Math.round(value * 1e6) / 1e6);

/**
 * The four ratios over one list of scored rows. Every `null` carries a reason,
 * and every branch names the count that made it null.
 */
export function ratiosOf(rows) {
  const used = rows.filter(row => row.used);
  const unused = rows.filter(row => !row.used);
  const n = rows.length;
  const sumDropped = sum(rows.map(row => row.droppedBytes));
  const nulls = [];
  let precision = null;
  let removalRecall = null;
  let usedRecall = null;
  let bytePrecision = null;
  if (n === 0) {
    nulls.push({ metric: 'P', reason: 'N_P = 0: no joined, path-bearing unit to score' });
  } else {
    precision = 1 - sum(used.map(row => row.rf)) / n;
  }
  if (unused.length === 0) {
    nulls.push({ metric: 'RR', reason: 'the unused set is empty: every scored unit was read again' });
  } else {
    removalRecall = mean(unused.map(row => row.rf));
  }
  if (used.length === 0) {
    nulls.push({ metric: 'UR', reason: 'the used set is empty: no scored unit was read again' });
  } else {
    usedRecall = 1 - mean(used.map(row => row.rf));
  }
  if (sumDropped === 0) {
    nulls.push({ metric: 'P_b', reason: 'Σ d(u) = 0 over J_L: nothing was dropped to divide' });
  } else {
    bytePrecision = sum(unused.map(row => row.droppedBytes)) / sumDropped;
  }
  return {
    n,
    usedCount: used.length,
    unusedCount: unused.length,
    sumDropped,
    P: round(precision),
    RR: round(removalRecall),
    UR: round(usedRecall),
    P_b: round(bytePrecision),
    nulls,
  };
}

/**
 * The scored population `J`, exported so `live-fill.mjs` selects exactly the
 * rows this scorer scored (one rule, two readers). Two-arm: the racoons arm's
 * own T1 results. One-arm: the solo arm's scored results at whatever tier the
 * join assigned, minus the machinery lane (ISSUE-066: an at-rest removal is no
 * decision, so it is not a scored row).
 */
export function scoredRowsOf({ units, resolved }) {
  const oneArm = resolved.mode === 'one-arm';
  const soloArm = oneArm ? resolved.names[0] ?? units[0]?.arm ?? null : null;
  return {
    oneArm,
    soloArm,
    rows: oneArm
      ? units.filter(unit => unit.arm === soloArm
        && unit.censoredClass !== 'machinery-at-rest-removal')
      : units.filter(unit => unit.arm === 'racoons' && unit.tier === 'T1'),
  };
}

/** The score body, exported so a test can drive it without a subprocess. */
export function score({ units, join: joinSidecar, census, floor, arms = 'auto' }) {
  const resolved = resolveArms({ census, join: joinSidecar, arms });
  const oneArm = resolved.mode === 'one-arm';
  const { soloArm, rows: scored } = scoredRowsOf({ units, resolved });
  const labelable = scored.filter(unit => unit.path !== null && unit.path !== undefined);
  const unlabelable = scored.filter(unit => unit.path === null || unit.path === undefined);
  const ratios = ratiosOf(labelable.map(unit => ({
    seq: unit.seq, used: unit.used, rf: unit.rf, droppedBytes: unit.droppedBytes,
  })));
  const censoring = Object.fromEntries(CENSORING_CLASSES.map(name => [name, 0]));
  for (const unit of units) {
    if (unit.tier === 'T3' && !oneArm) censoring['unjoined-content'] += 1;
    if (unit.censoredClass === 'refused-ask') censoring['refused-ask'] += 1;
    if (unit.censoredClass === 'no-legal-answer') censoring['no-legal-answer'] += 1;
  }
  if (oneArm) {
    // In a one-arm record T3 means "no second side", not "failed to join": the
    // class prints as 0 and the tier-3 count prints as `byConstructionT3`.
    censoring['unjoined-content'] = 0;
    censoring['never-seen'] = 0;
    censoring['racoons-only'] = 0;
    censoring['unlabelable-used'] = unlabelable.length;
  } else {
    // `unlabelable-used` is the racoons arm's own count: a unit outside J_L is
    // outside every ratio above, so the class must print beside it.
    censoring['unlabelable-used'] = units.filter(unit => unit.arm === 'racoons'
      && unit.path === null).length;
    const racoonsKeys = new Set(units.filter(unit => unit.arm === 'racoons').map(unit => unit.normKey));
    const joinPairs = joinSidecar.pairs ?? [];
    const racoonsShared = new Set(joinPairs.map(pair => pair.key));
    censoring['racoons-only'] = [...racoonsKeys].filter(key => !racoonsShared.has(key)).length;
    // `never-seen` is a vanilla-side count the converter already made; the units
    // file holds only racoons rows, so it is carried from the census.
    censoring['never-seen'] = (census.censoring ?? {})['never-seen'] ?? 0;
  }
  if (censoring['no-legal-answer'] > 0) {
    throw new Error('no-legal-answer: a legal answer was classified unanswerable;'
      + ' ADR-0020 §2 says that is impossible, so this is a core defect, not a statistic');
  }
  const rows = labelable
    .map(unit => ({
      seq: unit.seq,
      step: unit.step,
      tool: unit.tool,
      composition: unit.composition,
      b: unit.bytes,
      d: unit.droppedBytes,
      rf: unit.rf,
      used: unit.used,
      usedBy: unit.usedBy,
      path: unit.path,
      censoredClass: unit.censoredClass,
    }))
    .sort((a, b) => a.seq - b.seq);
  // A population where nothing was dropped makes P = 1 (and UR = 1 where the used
  // set is non-empty) by arithmetic alone: those numbers are true and carry no
  // information, so the run says so rather than letting a reader take 1.0 for a
  // measurement.
  const degenerate = ratios.sumDropped === 0 && ratios.n > 0
    ? 'Σ d(u) = 0 over J_L: nothing in this population was dropped or shaped, so'
      + ' P — and UR, where the used set is non-empty — equals 1 by arithmetic'
      + ' and measures nothing'
    : null;
  return {
    schema: 'racoons-live-score/1',
    floor,
    honestN: HONEST_N,
    ratiosPrintable: ratios.n >= HONEST_N,
    artefact: ratios.n < HONEST_N
      ? `N_P = ${ratios.n} < ${HONEST_N}: the unit table is the deliverable; no percentage prints`
      : `N_P = ${ratios.n} ≥ ${HONEST_N}: the ratios print, and the unit table is still the artefact`,
    degenerate,
    // Present on a one-arm record only, so a two-arm record's JSON stays
    // byte-identical to every earlier scorer run (the pinned 040 numbers are
    // not allowed to move). In a one-arm record the T3 count here is
    // `byConstructionT3`: no second side existed, so no unit "failed" to join.
    ...(oneArm ? {
      scoring: {
        mode: resolved.mode,
        detected: resolved.detected,
        soloArm,
        tierBasis: 'solo arm, every tier (no control side)',
        byConstructionT3: units.filter(unit => unit.tier === 'T3').length,
      },
    } : {}),
    ratioBasis: ratios,
    beside: {
      n: ratios.n,
      // The arm's own count, which is the class the plan pins (040: 34 of 65):
      // a unit outside J_L is outside every ratio, whether or not it joined.
      unlabelableUsed: censoring['unlabelable-used'],
      neverSeen: censoring['never-seen'],
      racoonsOnly: censoring['racoons-only'],
    },
    censoring,
    units: rows,
    excluded: unlabelable.map(unit => ({ seq: unit.seq, reason: 'no renderable <path>' })),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const unitsDir = resolve(REPO_ROOT, opts.units);
  const paths = {
    units: join(unitsDir, 'live-units.jsonl'),
    join: join(unitsDir, 'live-join.json'),
    census: join(unitsDir, 'live-census.json'),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) throw new Error(`input-absent: ${name} at ${path}`);
  }
  const units = readFileSync(paths.units, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const joinSidecar = JSON.parse(readFileSync(paths.join, 'utf8'));
  const census = JSON.parse(readFileSync(paths.census, 'utf8'));
  const result = score({ units, join: joinSidecar, census, floor: census.floor, arms: opts.arms });

  const outDir = opts.out === null ? unitsDir : resolve(REPO_ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const writeAtomic = (name, text) => {
    const path = join(outDir, name);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  };
  writeAtomic('live-score.json', `${JSON.stringify(result, null, 2)}\n`);

  const header = ['seq', 'step', 'composition', 'b', 'd', 'rf', 'used', 'usedBy'];
  // ADR-0021's honest-n: below six labelled units no percentage prints. The
  // values stay in `live-score.json` (a re-derivation must be checkable) but the
  // human block says the table is the deliverable and shows none of them.
  const show = result.ratiosPrintable;
  const lines = [
    'live-score',
    `  floor        ${result.floor}`,
    // A one-arm record gets one extra line saying how `J` was selected; the
    // two-arm block is byte-identical to every earlier run.
    ...(result.scoring === undefined ? [] : [
      `  arms         ${result.scoring.mode}`
        + `${result.scoring.detected ? ' (detected)' : ''}`
        + ` solo=${result.scoring.soloArm} byConstructionT3=${result.scoring.byConstructionT3}`,
    ]),
    `  artefact     ${result.artefact}`,
    `  P            ${show ? banner(result.ratioBasis.P) : 'suppressed (honest-n)'}`
      + `  n=${result.beside.n} unlabelable-used=${result.beside.unlabelableUsed}`
      + ` never-seen=${result.beside.neverSeen} racoons-only=${result.beside.racoonsOnly}`,
    `  RR           ${show ? banner(result.ratioBasis.RR) : 'suppressed (honest-n)'}`,
    `  UR           ${show ? banner(result.ratioBasis.UR) : 'suppressed (honest-n)'}`,
    `  P_b          ${show ? banner(result.ratioBasis.P_b) : 'suppressed (honest-n)'}`,
    `  censoring    ${CENSORING_CLASSES.map(name => `${name}=${result.censoring[name]}`).join(' ')}`,
  ];
  if (result.degenerate !== null) lines.push(`  degenerate   ${result.degenerate}`);
  for (const nulled of result.ratioBasis.nulls) {
    lines.push(`  null         ${nulled.metric}: ${nulled.reason}`);
  }
  lines.push('', `  ${header.join('\t')}`);
  for (const row of result.units) {
    lines.push(`  ${[row.seq, row.step, row.composition, row.b, row.d, row.rf,
      row.used ? 'yes' : 'no', row.usedBy ?? '-'].join('\t')}`);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
  writeAtomic('live-table.txt', `${lines.join('\n')}\n`);
}

/** A ratio, or `null` with its reason — never a bare zero. */
function banner(value) {
  return value === null ? 'null' : String(value);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
