#!/usr/bin/env node
/**
 * ISSUE-060 producer — the paper's live-study cells as ONE JSON file.
 *
 * Usage:
 *   node dev/bench/multiturn/live-fill.mjs --units <dir> [--out <dir>] [--json]
 *        [--one-arm | --two-arm]
 *
 *   --units  a `live-convert.mjs` output directory (`live-units.jsonl`,
 *            `live-join.json`, `live-census.json`).
 *   --out    where `live-fill.json` lands. Default: the `--units` directory.
 *            `<name>.tmp` then rename, as the converter.
 *   --json   print the summary to stdout instead of the human block.
 *   --one-arm / --two-arm  as in `live-score.mjs`: force the reading; default
 *            is detection (one arm and no join pair is a one-arm record).
 *
 * ## Why this file exists
 *
 * The paper's live table has six reading rows and ten `\phR{...}` call sites.
 * `live-score.mjs` produces the ratios; three cells had no producer at all:
 * the re-fetch count, the ask rate, and the byte counts. This script produces
 * those and re-reads the scorer's ratios from the same population, so the
 * paper fill reads ONE file (`live-fill.json`) and never joins two runs by hand.
 *
 * ## Fields, each with the rule that produced it
 *
 *   precision, removalRecall, usedRecall  the scorer's `P`, `RR`, `UR` over the
 *                        same scored rows `live-score.mjs` scores — one rule,
 *                        imported, not re-implemented. `null` when the ratio is
 *                        null, and the null travels with its reason.
 *   refetchRestores       forgotten units (composition `forget-all` or
 *                        `forget-with-partials`) whose `usedBy` starts
 *                        `restore:`. A restore is a recall/expand naming the
 *                        marker's id.
 *   refetchRereads        forgotten units whose `usedBy` starts `reread:` —
 *                        SEPARATE, never merged: the converter records the two
 *                        witnesses separately and the paper wording picks which
 *                        one it quotes.
 *   bytesTotal            Σ `bytes` over scored rows, excluding
 *                        `machinery-at-rest-removal` and below-floor rows (the
 *                        rows the converter never emitted as units).
 *   bytesKept             Σ `keptBytes` over the same rows. A row with no
 *                        shaped turn has no `keptBytes` (`null`); it counts as
 *                        `bytes − droppedBytes`, which is the row's whole body
 *                        when nothing was dropped.
 *   bytesDropped          Σ `droppedBytes` over the same rows.
 *   overheadBytes         Σ marker + summary + framing bytes over the same
 *                        rows: what the shaping machinery itself costs. Printed
 *                        on its own line and NEVER added to `bytesKept`, so the
 *                        paper can decide whether to quote it.
 *   entryAsksPerHundredSteps  (entry asks / steps) × 100 over the scored arm(s).
 *                        ENTRY ASKS ONLY — a `user/message` append carrying the
 *                        shipped end anchor, which is the converter's
 *                        `census.asks[<arm>].prompts`. Ask-fork usage rows are a
 *                        projection and are NOT this number; it prints here as
 *                        a separate `projectedAskRows` companion.
 *   n                     the scorer's `N_P` (labelable scored rows) — the `n`
 *                        beside every ratio.
 *   censoring             the six classes, carried from the scorer verbatim.
 *
 * ## Run-B manifest requirement (G6)
 *
 * `live-convert.mjs:518` resolves a RELATIVE manifest `transcript` against
 * `dev/bench/fixtures/live`, so a run-B manifest MUST carry an ABSOLUTE
 * transcript path (`C:\...` on this machine). A relative path is not refused:
 * the converter silently reads the FIXTURE transcript instead of the run's own
 * evidence tree, and every number here would describe 040 rather than run B.
 * `--manifest <path>` (optional) makes this script check that manifest's
 * transcripts are absolute and refuses with `manifest-transcript-relative` when
 * one is not.
 *
 * ## Honest n
 *
 * Below ADR-0021's honest n the ratios are `null` with the reason, never a
 * percentage. The byte counts are not ratios and always print.
 *
 * Exit: 0 = written; 2 = bad arguments, a missing input, or a refused reading.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArms, scoredRowsOf, score } from './live-score.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const HONEST_N = 6;
const FORGOTTEN = new Set(['forget-all', 'forget-with-partials']);
const MACHINERY = 'machinery-at-rest-removal';

function usage() {
  return 'usage: node dev/bench/multiturn/live-fill.mjs --units <dir> [--out <dir>]'
    + ' [--json] [--one-arm | --two-arm] [--manifest <path>]\n'
    + '  Writes ONE `live-fill.json` holding every paper cell this bench can measure.\n'
    + '  Run-B manifest: live-convert.mjs resolves a RELATIVE transcript against\n'
    + '  dev/bench/fixtures/live, so the run-B manifest MUST carry an ABSOLUTE\n'
    + '  transcript path. Pass --manifest here and a relative one is refused.';
}

const LIVE_FILL_OPTIONS = optionsOf([
  ['--units', 'string'],
  ['--out', 'string'],
  ['--manifest', 'string'],
  ['--json', 'boolean'],
  ['--one-arm', 'boolean'],
  ['--two-arm', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: LIVE_FILL_OPTIONS,
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
    manifest: values.manifest ?? null,
  };
  if (opts.units === null) throw new Error(`--units is required\n${usage()}`);
  return opts;
}

const sum = values => values.reduce((a, b) => a + b, 0);
const round = value => (value === null ? null : Math.round(value * 1e6) / 1e6);
/**
 * The witness entries on one unit. The converter writes `usedBy` as a scalar
 * (`reread:seq582`); a census `armLabels` entry writes `seq<-witness`. Both
 * shapes are read, so a lane change cannot silently zero the count.
 */
const witnessesOf = unit => {
  const raw = unit.usedBy;
  const list = Array.isArray(raw) ? raw.map(String) : (raw === null || raw === undefined ? [] : [String(raw)]);
  return list.map(entry => (entry.includes('<-') ? entry.slice(entry.indexOf('<-') + 2) : entry));
};
/** A row's kept bytes: the converter's own number, else its whole body. */
const keptOf = row => (Number.isFinite(row.keptBytes)
  ? row.keptBytes : (row.bytes ?? 0) - (row.droppedBytes ?? 0));
/** The shaping machinery's own cost on one row: markers + summary + framing. */
const overheadOf = row => (row.markerCount ?? row.gaps ?? 0) * (row.markerBytes ?? 0)
  + (row.summaryBytes ?? 0) + (row.framingBytes ?? 0);

/**
 * Every paper cell from one converted directory. Exported so the test drives it
 * without a subprocess; the CLI is a thin writer around this.
 */
export function fill({ units, join: joinSidecar, census, arms = 'auto', manifest = null }) {
  if (manifest !== null) {
    // G6: a relative transcript is read from the fixture directory, not the
    // run's evidence tree. Refuse by name rather than score the wrong file.
    for (const [name, meta] of Object.entries(manifest.arms ?? {})) {
      const transcript = String(meta?.transcript ?? '');
      if (transcript === '' || !isAbsolute(transcript)) {
        throw new Error(`manifest-transcript-relative: arm ${name} names ${transcript || '(none)'};`
          + ' a run-B manifest MUST carry an ABSOLUTE transcript path, because'
          + ' live-convert.mjs resolves a relative one against dev/bench/fixtures/live');
      }
    }
  }
  const resolved = resolveArms({ census, join: joinSidecar, arms });
  const oneArm = resolved.mode === 'one-arm';
  const { soloArm, rows: scored } = scoredRowsOf({ units, resolved });
  // The scored rows already exclude the machinery lane; the below-floor rows
  // never became units at all. Both exclusions are stated, not assumed.
  const population = scored.filter(unit => unit.censoredClass !== MACHINERY);
  const belowFloorExcluded = census.compositionTable?.['below-floor'] ?? 0;
  const machineryExcluded = census.machinery?.censored ?? 0;

  const scoredResult = score({ units, join: joinSidecar, census, floor: census.floor, arms });
  const ratios = scoredResult.ratioBasis;
  const n = ratios.n;
  const printable = n >= HONEST_N;

  const forgotten = population.filter(unit => FORGOTTEN.has(unit.composition));
  const refetchRestores = forgotten.filter(unit => witnessesOf(unit)
    .some(entry => entry.startsWith('restore:')));
  const refetchRereads = forgotten.filter(unit => witnessesOf(unit)
    .some(entry => entry.startsWith('reread:')));

  // Entry asks and steps, over the arms this record actually holds. A one-arm
  // record has one; a two-arm record sums both only when asked — the paper's
  // arm is racoons, so the scored arm is the default.
  const askArms = oneArm ? [soloArm] : ['racoons'];
  const entryAsks = sum(askArms.map(arm => census.asks?.[arm]?.prompts ?? 0));
  const steps = sum(askArms.map(arm => census.arms?.[arm]?.steps ?? 0));
  const projectedAskRows = sum(askArms.map(arm => census.arms?.[arm]?.askRows
    ?? ((census.arms?.[arm]?.assistantMessages ?? 0) - (census.arms?.[arm]?.steps ?? 0))));

  const bytesTotal = sum(population.map(unit => unit.bytes ?? 0));
  const bytesKept = sum(population.map(keptOf));
  const bytesDropped = sum(population.map(unit => unit.droppedBytes ?? 0));
  const overheadBytes = sum(population.map(overheadOf));

  return {
    schema: 'racoons-live-fill/1',
    floor: census.floor ?? null,
    // The population's own identity, so a reader can re-derive every number
    // below from `live-units.jsonl` alone.
    basis: {
      mode: resolved.mode,
      detected: resolved.detected,
      arms: resolved.names,
      scoredArm: oneArm ? soloArm : 'racoons',
      scoredRows: population.length,
      tierBasis: oneArm ? 'solo arm, every tier (no control side)' : 'racoons arm, T1',
      excluded: {
        'machinery-at-rest-removal': machineryExcluded,
        'below-floor': belowFloorExcluded,
      },
    },
    // The scorer's own ratios, exactly as it reports them: the paper reads these,
    // never a second computation. A suppressed ratio is null with its reason.
    ...(printable ? {
      precision: ratios.P,
      removalRecall: ratios.RR,
      usedRecall: ratios.UR,
    } : {
      precision: null,
      removalRecall: null,
      usedRecall: null,
    }),
    ratiosPrintable: printable,
    honestN: HONEST_N,
    ratioNulls: printable ? [] : [
      { metric: 'P/RR/UR', reason: `N_P = ${n} < ${HONEST_N}: the unit table is the deliverable` },
    ],
    ...(printable ? {} : { suppressed: { P: ratios.P, RR: ratios.RR, UR: ratios.UR, P_b: ratios.P_b } }),
    // G4: two named counts, never merged. A restore is a recall/expand naming
    // the marker's id; a reread is a later READ-tool call on the same path.
    refetchRestores: refetchRestores.length,
    refetchRereads: refetchRereads.length,
    refetchBasis: {
      forgottenComposition: [...FORGOTTEN],
      forgotten: forgotten.length,
      restores: refetchRestores.map(unit => ({ seq: unit.seq, composition: unit.composition, usedBy: unit.usedBy })),
      rereads: refetchRereads.map(unit => ({ seq: unit.seq, composition: unit.composition, usedBy: unit.usedBy })),
    },
    // G5: byte sums over the scored rows; the machinery's own cost separate.
    bytesTotal,
    bytesKept,
    bytesDropped,
    overheadBytes,
    bytesBasis: {
      rows: population.length,
      // `J` is every scored row; the ratios' `n` is its path-bearing subset. The
      // two byte totals print so a reader cannot mistake one for the other.
      labelable: {
        rows: population.filter(unit => unit.path !== null && unit.path !== undefined).length,
        bytesTotal: sum(population
          .filter(unit => unit.path !== null && unit.path !== undefined)
          .map(unit => unit.bytes ?? 0)),
      },
      keptRule: 'keptBytes where the converter wrote one; else bytes − droppedBytes',
      overheadRule: 'markerCount·markerBytes + summaryBytes + framingBytes, NOT added to bytesKept',
    },
    // Entry asks only: the shipped end-anchor prompt count. The ask-fork usage
    // row is a different, projected number and prints beside it.
    entryAsks: entryAsks,
    steps,
    entryAsksPerHundredSteps: steps === 0 ? null : round((entryAsks / steps) * 100),
    // A zero here is only a measured rate when the run actually asked. When no
    // entry-ask prompt exists in the log at all, the number is 0 because the
    // ask lane never fired, and the note says so instead of letting the paper
    // quote "0 asks per 100 steps" as if the agent had chosen not to ask.
    entryAsksNote: entryAsks === 0
      ? 'no entry-ask prompt in the transcript: the ask lane did not fire on this run,'
        + ' so 0 per 100 steps is the absence of asks, not a measured ask rate'
        : null,
    entryAsksBasis: {
      arms: askArms,
      rule: 'user/message appends carrying the shipped end anchor (census.asks[arm].prompts)',
      projectedAskRows,
    },
    n,
    censoring: scoredResult.censoring,
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
  const manifest = opts.manifest === null
    ? null : JSON.parse(readFileSync(resolve(REPO_ROOT, opts.manifest), 'utf8'));
  const result = fill({ units, join: joinSidecar, census, arms: opts.arms, manifest });

  const outDir = opts.out === null ? unitsDir : resolve(REPO_ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const writeAtomic = (name, text) => {
    const path = join(outDir, name);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  };
  writeAtomic('live-fill.json', `${JSON.stringify(result, null, 2)}\n`);

  const banner = value => (value === null ? 'null' : String(value));
  const lines = [
    'live-fill',
    `  floor        ${result.floor}`,
    `  basis        ${result.basis.mode} scoredArm=${result.basis.scoredArm}`
      + ` rows=${result.basis.scoredRows} excluded=machinery(${result.basis.excluded[MACHINERY]})`
      + `+below-floor(${result.basis.excluded['below-floor']})`,
    `  precision    ${banner(result.precision)}  n=${result.n}`,
    `  removalRecall ${banner(result.removalRecall)}`,
    `  usedRecall   ${banner(result.usedRecall)}`,
    `  refetch      restores=${result.refetchRestores} rereads=${result.refetchRereads}`
      + ` (forgotten=${result.refetchBasis.forgotten})`,
    `  bytes        total=${result.bytesTotal} kept=${result.bytesKept}`
      + ` dropped=${result.bytesDropped}`,
    `  overhead     ${result.overheadBytes}  (markers+summary+framing; NOT in kept)`,
    `  entryAsks    ${result.entryAsks} over ${result.steps} steps`
      + ` = ${banner(result.entryAsksPerHundredSteps)} per 100 steps`
      + ` (projectedAskRows=${result.entryAsksBasis.projectedAskRows})`,
    ...(result.entryAsksNote === null ? [] : [`  note         ${result.entryAsksNote}`]),
    `  censoring    ${Object.entries(result.censoring).map(([name, count]) => `${name}=${count}`).join(' ')}`,
    `  out          ${join(outDir, 'live-fill.json')}`,
  ];
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
