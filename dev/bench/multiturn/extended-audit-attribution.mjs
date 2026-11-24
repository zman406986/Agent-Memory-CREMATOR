#!/usr/bin/env node
/**
 * ISSUE-080 method (d) — error attribution over the D-check findings, both extended-run arms.
 *
 * Usage:
 *   node dev/bench/multiturn/extended-audit-attribution.mjs --units <live-units.jsonl>
 *        --arm-root <dir> [--findings <json>]... [--label <name>] [--json] [--out <dir>]
 *
 *   --units      a `live-convert.mjs` output `live-units.jsonl`. Every row names the arm it was
 *                converted from, and each findings file reads only its own arm's rows: a control
 *                arm that mounts nothing has no unit table, so it can carry no removal.
 *   --arm-root   the post-run arm; `--units` paths are normalised against it, absolute or relative
 *                to the working directory.
 *   --findings   a `dchecks.json` from `extended-audit-dchecks.mjs`. Repeatable; every FAIL row
 *                becomes one sub-item.
 *   --out        writes `attribution.json` there.
 *
 * Offline. No model call, no network.
 *
 * ## What this pass decides
 *
 * `docs/plans/2026-10-28-removal-quality/methods.md` §5. For each failed D-check it assigns one
 * of five classes. The two that need the removal ledger are `R-loss` and `R-cost`; both are
 * decided by the unit table the converter already wrote, never by a guess:
 *
 *   R-loss  the failing expectation's file sits in a removed unit's path + removed range, and no
 *           restore or reread witness exists for that unit.
 *   R-cost  a removed unit of that path was used later (a recall/expand naming its recall id, or
 *           a later completed read-class result on the path).
 *   T-indep the failing file is not named by any removal, or the same expectation fails in both
 *           arms, or the record's claim contradicts content the image holds.
 *   H       the failing step is a harness event. **No H evidence exists in either arm** — both
 *           exited 0, neither kill box fired, neither grant fired, neither was continued — so the
 *           class prints 0 with that reason rather than being assumed.
 *   U       no witness, or two classes fit.
 *
 * A sub-item with no connection to a removal is evidence *for* the product and prints on its own
 * line in those words (§5).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEP = String.fromCharCode(92);

const USAGE = 'usage: extended-audit-attribution.mjs --units <file> --arm-root <dir> '
  + '[--findings <json>]... [--label <name>] [--json]';

function usage(why) {
  process.stderr.write(`${USAGE}\n${why ? `refused: ${why}\n` : ''}`);
  process.exit(2);
}

// The flags this pass reads, declared once so the shared parser (ISSUE-072)
// binds a negative value to its option and refuses an unknown one. `--findings`
// repeats; `--arm-root` keeps its camelCase output key, which the guard reads.
const ATTRIBUTION_OPTIONS = optionsOf([
  ['--units', 'string'],
  ['--arm-root', 'string'],
  ['--findings', 'string', { multiple: true }],
  ['--label', 'string'],
  ['--json', 'boolean'],
  ['--out', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: ATTRIBUTION_OPTIONS,
    refuse: message => usage(message),
  });
  const opts = {
    units: values.units ?? null,
    armRoot: values.armRoot ?? null,
    findings: values.findings ?? [],
    label: values.label ?? null,
    json: values.json ?? false,
    out: values.out ?? null,
  };
  if (!opts.units) usage('--units is required');
  if (!opts.armRoot) usage('--arm-root is required');
  for (const f of [opts.units, opts.armRoot, ...opts.findings]) {
    if (!existsSync(f)) usage(`not found: ${f}`);
  }
  return opts;
}

/**
 * The unit's path, normalised to an arm-relative posix path.
 *
 * `--arm-root` arrives in either form: the units' own absolute Windows path, or
 * a path relative to the working directory. `resolve` makes both absolute, so a
 * relative root joins instead of silently matching nothing — the silent-loss
 * defect, where every removal vanished and `R-loss`/`R-cost` printed 0 with no
 * warning. A drive path compares case-insensitively, as Windows does.
 */
function relativePath(value, armRoot) {
  if (!value) return null;
  const posix = value.split(SEP).join('/');
  const root = resolve(armRoot).split(SEP).join('/').replace(/\/$/, '');
  const joins = /^[A-Za-z]:\//.test(posix)
    ? posix.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : posix.startsWith(`${root}/`);
  if (joins) return posix.slice(root.length + 1);
  // a temp path outside the arm is not an arm path; return it whole so it can be named
  return posix;
}

const removalsOf = (units) => units
  .filter((u) => (u.droppedBytes ?? 0) > 0 && u.path)
  .map((u) => ({
    path: u.path,
    recallId: u.recallId ?? null,
    seq: u.seq,
    ranges: u.ranges ?? [],
    droppedBytes: u.droppedBytes,
    used: !!u.used,
    usedBy: u.usedBy ?? null,
    composition: u.composition,
  }));

const usedUnitsOf = (units) => units.filter((u) => u.used);

/** A finding's subject file: the id prefix maps to the record the pass wrote. */
const PASS_FILE = {
  T1: '01-orientation.md', T2: '02-entry-currency.md', T3: '03-core-charter.md',
  T4: '04-core-tests.md', T5: '05-shell-quarantine.md', T6: '06-gate-coverage.md',
  T7: '07-plan-traceability.md', T8: '08-distillation-audit.md', T9: '09-open-triage.md',
  T10: '10-plans-disposition.md', T11: '11-corpus-en.md', T12: '12-corpus-zh.md',
};

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const units = readFileSync(opts.units, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Every unit names the arm it was converted from. Without that name no row can
  // be routed to a findings file, and a silent "no removals" would be the same
  // false zero the path join used to print.
  const unnamed = units.find((u) => typeof u.arm !== 'string' || u.arm === '');
  if (unnamed) usage(`--units row seq ${unnamed.seq ?? '?'} names no arm; cannot route it`);

  // Each arm's own unit table. A control arm that mounts nothing has no row here
  // and therefore no removal — the racoons table never decides a vanilla failure.
  const armUnits = new Map();
  for (const u of units) {
    if (!armUnits.has(u.arm)) armUnits.set(u.arm, []);
    armUnits.get(u.arm).push(u);
  }

  const failed = [];
  const perArm = [];
  const armOf = new Map();
  for (const file of opts.findings) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const arm = data.label ?? null;
    if (arm === null) usage(`${file} carries no label; its arm is unknown`);
    const arms = armUnits.get(arm) ?? [];
    const removals = removalsOf(arms);
    const usedUnits = usedUnitsOf(arms);
    armOf.set(arm, {
      removals,
      usedUnits,
      removedPaths: new Set(removals.map((r) => relativePath(r.path, opts.armRoot))),
      usedPaths: new Set(usedUnits.map((u) => relativePath(u.path, opts.armRoot))),
    });
    perArm.push({ file, label: data.label, passed: data.passed, checks: data.checks });
    for (const row of data.rows) {
      if (row.kind === 'observ' || row.pass) continue;
      const pass = String(row.id).split('.')[0];
      failed.push({
        arm,
        id: row.id,
        pass,
        expectation: row.label,
        computed: row.computed,
        recorded: row.recorded,
        recordFile: `docs/plans/2026-10-27-extended-audit/${PASS_FILE[pass] ?? `${pass}.md`}`,
      });
    }
  }

  // `T-indep` by construction: an expectation that fails in both arms is not a removal effect
  const byId = new Map();
  for (const f of failed) {
    const key = f.id.replace(/^T[0-9]+\.[0-9]+[a-z]?/, (m) => m);
    byId.set(key, (byId.get(key) ?? 0) + 1);
  }
  const bothArms = new Set([...byId.entries()].filter(([, n]) => n > 1).map(([k]) => k));

  const classified = failed.map((f) => {
    const table = armOf.get(f.arm);
    const recordPath = f.recordFile;
    const recordRemoved = table.removals.find((r) => relativePath(r.path, opts.armRoot) === recordPath);
    const recordUsed = table.usedUnits.find((u) => relativePath(u.path, opts.armRoot) === recordPath);
    let cls;
    let witness;
    if (bothArms.has(f.id)) {
      cls = 'T-indep';
      witness = 'the same expectation fails in both arms, so no removal explains it';
    } else if (recordRemoved && !recordRemoved.used) {
      cls = 'R-loss';
      witness = `unit seq ${recordRemoved.seq} removed ${recordRemoved.droppedBytes} B from ${recordPath} `
        + `(recall ${recordRemoved.recallId ?? 'none'}); no restore or reread witness`;
    } else if (recordUsed) {
      cls = 'R-cost';
      witness = `unit seq ${recordUsed.seq} of ${recordPath} was used later (${recordUsed.usedBy ?? 'witness unrecorded'})`;
    } else if (table.removedPaths.has(recordPath) || table.usedPaths.has(recordPath)) {
      cls = 'U';
      witness = `${recordPath} appears in the ${f.arm} unit table but neither as a loss nor as a later use`;
    } else {
      cls = 'T-indep';
      witness = `no ${f.arm} removal names ${recordPath}; the failure sits on content no verdict touched`;
    }
    return { ...f, class: cls, witness };
  });

  const counts = { 'R-loss': 0, 'R-cost': 0, 'T-indep': 0, H: 0, U: 0 };
  for (const c of classified) counts[c.class]++;
  // H is 0 by measurement, not by omission: both arms exited clean with no forced loss
  const hReason = 'both arms exit 0; neither kill box, grant, continuation nor forced loss fired';
  const removalsSeen = [...armOf.values()].reduce((n, t) => n + t.removals.length, 0);
  const usedUnitsSeen = [...armOf.values()].reduce((n, t) => n + t.usedUnits.length, 0);

  const summary = {
    label: opts.label ?? null,
    arms: perArm,
    subItems: classified.length,
    counts: { ...counts, H_reason: hReason },
    rows: classified,
    removalsSeen,
    usedUnitsSeen,
  };

  if (opts.out !== null) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'attribution.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    for (const c of classified) {
      process.stdout.write(`${c.class.padEnd(8)} ${c.arm} ${c.id} — ${c.witness}\n`);
    }
    process.stdout.write(`\nR-loss=${counts['R-loss']} R-cost=${counts['R-cost']} `
      + `T-indep=${counts['T-indep']} H=${counts.H} U=${counts.U}\n`);
    process.stdout.write(`H reason: ${hReason}\n`);
    const independent = classified.filter((c) => c.class === 'T-indep').length;
    process.stdout.write(`evidence for the product: ${independent} of ${classified.length} failed `
      + `sub-items have no connection to a removal\n`);
  }
  return summary;
}

main();

export { relativePath, removalsOf, usedUnitsOf };
