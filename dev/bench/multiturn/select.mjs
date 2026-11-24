#!/usr/bin/env node
/**
 * Chunk 2 — the corpus rule, run over the pinned snapshot.
 *
 * Usage:
 *   node dev/bench/multiturn/select.mjs [--db <snapshot>] [--out <dir>]
 *                                       [--require-fills] [--require-writes]
 *
 *   --db      the chunk-0 snapshot, opened read-only. The live store is never
 *             read. Default: scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite.
 *   --out     where `corpus.json` lands. Default: the snapshot's directory.
 *   --require-fills
 *             narrow to the sessions that filled at least once, naming every
 *             drop instead of silently shrinking the count.
 *   --require-writes
 *             narrow to the sessions with >=20 completed `Write`/`Edit` calls,
 *             naming every drop.
 *
 * ## The rule (design §4 D3, "exact filter, rebuildable")
 *
 *   entry        >=5 `real_user` prompts AND >=60 completed requests   (design 221)
 *   filled       entry AND >=1 completed auto compaction operation row
 *                carrying `preCompactTokenCount`                          (design 64)
 *   writes       filled AND >=20 completed `Write`/`Edit` calls           (design 46)
 *   matched      writes AND >=8 distinct normalized `file_path` values    (design 39)
 *
 * "Requests" is read as COMPLETED `model_usage` rows. A cancelled attempt
 * carries `input_tokens = 0` and no turn entry, so it cannot be a request the
 * turn plan holds; this reading is also the one that reproduces the design's
 * 221 exactly (the literal all-rows reading gives 222 on the pin, because one
 * session's four cancelled attempts push it over the line). Both totals print,
 * so the choice is visible rather than argued.
 *
 * Distinct paths instead of calls give 24, not 46: the design says "calls" and
 * this module counts calls. A fill is ONE operation row; its boundary row is a
 * second `compaction` part with no `timelineStatus` and is never counted, so
 * the two-row shape cannot double the count.
 *
 * ## The gate, and why the counts are not the gate
 *
 * The gate is the DIGEST: the sha256 the run computes over the snapshot file
 * must equal the one chunk 0 recorded in `<snapshot>.sha256`. The counts print;
 * a count that differs from the design prints as a **drift** line and does not
 * fail the run. The live store moved between the design probe and the pin
 * (527,618 -> 528,955 -> 529,517 -> 532,308 `model_usage` rows), so a probe
 * number is a reading of one moment, never a constant to assert.
 *
 * ## Progress (P1)
 *
 * P1 = distinct files written: normalized `file_path` over parts with
 * `type = tool`, `tool in {Write, Edit}`, `state.status = completed`. The
 * normalization is deliberate and printed: `\` -> `/`, a lowercase drive
 * letter, collapsed `//`, no trailing `/`. Per session this module prints the
 * knot count (the size of that set) and the matched-progress point count (the
 * distinct nonzero cumulative values at turn ends — the only progress points
 * two lanes can be compared at). Chunk 4 owns the interpolator; this module
 * only counts the knots it will sample.
 *
 * Exit: 0 = the digest gate held (drift is not a failure); 1 = the digest does
 *       not match the recorded one; 2 = bad arguments, a missing store or a
 *       missing digest file.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median } from '../../shared/stats.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_DB = 'scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite';

/** The design's counts (§4 D3 and §2 evidence 4). Printed beside the observed ones. */
const EXPECTED = Object.freeze({ entry: 221, filled: 64, writes: 46, matched: 39 });
/** The rule's thresholds, one place each. */
const MIN_PROMPTS = 5;
const MIN_REQUESTS = 60;
const MIN_WRITE_CALLS = 20;
const MIN_DISTINCT_PATHS = 8;

function usage() {
  return 'usage: node dev/bench/multiturn/select.mjs [--db <snapshot>] [--out <dir>]'
    + ' [--require-fills] [--require-writes]';
}

const SELECT_OPTIONS = optionsOf([
  ['--db', 'string'],
  ['--out', 'string'],
  ['--require-fills', 'boolean'],
  ['--require-writes', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: SELECT_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  return {
    db: values.db ?? DEFAULT_DB,
    out: values.out ?? null,
    requireFills: values.requireFills ?? false,
    requireWrites: values.requireWrites ?? false,
  };
}

/** Windows folds path case; POSIX does not. */
const CASE_INSENSITIVE = process.platform === 'win32';
const DRIVE_PATH = /^[A-Za-z]:\//;

/**
 * One path, normalized for the P1 set: the same file written through `C:\` and
 * `c:/` on this device is one file. A drive-qualified path is a Windows path,
 * so on win32 its whole case is folded; elsewhere only the drive letter is
 * folded, and a POSIX-shaped path keeps its case so a case-sensitive
 * filesystem is not silently merged.
 */
export function normalizePath(value) {
  let path = String(value).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const drivePath = DRIVE_PATH.test(path);
  if (drivePath && CASE_INSENSITIVE) path = path.toLowerCase();
  else if (drivePath) path = `${path[0].toLowerCase()}${path.slice(1)}`;
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function digestPathFor(dbPath) {
  return dbPath.replace(/\.sqlite$/, '.sha256');
}

/**
 * The corpus's medians, rounded in the even case only: these are counts
 * (prompts, requests, knots), so a fractional middle value was never a reading.
 * The shared `median` in `dev/lib/stats.mjs` returns the unrounded midpoint
 * (ISSUE-072); rounding just the even case here reproduces the copy this file
 * used to carry, which never rounded an odd one.
 */
const medianCount = values => (values.length === 0 || values.length % 2 === 1
  ? median(values) : Math.round(median(values)));

/**
 * The corpus, computed. Exported so a test can call it on a fixture without
 * spawning a process; the CLI below is the printed form.
 */
export function selectCorpus(db, options = {}) {
  const prompts = new Map(db.prepare(`
    select session_id, count(*) as n from message
     where data like '%"origin":"real_user"%'
       and json_extract(data, '$.semantics.origin') = 'real_user'
     group by session_id`).all().map(row => [row.session_id, row.n]));
  // "Requests" = COMPLETED `model_usage` rows. A cancelled attempt carries
  // `input_tokens = 0` and never entered the transcript, so it is not a request
  // the record's turn plan can hold; it is also the reading that reproduces the
  // design's 221 exactly (the literal "all rows" reading gives 222 on the pin).
  // Both counts print, so the difference is visible rather than argued.
  const requests = new Map(db.prepare(
    "select session_id, count(*) as n from model_usage where status = 'completed' group by session_id",
  ).all().map(row => [row.session_id, row.n]));
  const allRows = new Map(db.prepare(
    'select session_id, count(*) as n from model_usage group by session_id',
  ).all().map(row => [row.session_id, row.n]));

  // Entry: the two aggregate thresholds. A session with no prompt row has 0.
  const entry = [...requests.entries()]
    .filter(([id, count]) => (prompts.get(id) ?? 0) >= MIN_PROMPTS && count >= MIN_REQUESTS)
    .map(([id]) => id)
    .sort();

  const fillRows = db.prepare(`
    select json_extract(data, '$.preCompactTokenCount') as pre,
           coalesce(json_extract(data, '$.time.end'), time_created) as at
      from part
     where session_id = ?
       and data like '%"preCompactTokenCount"%'
       and json_extract(data, '$.type') = 'compaction'
       and json_extract(data, '$.auto') = 1
       and json_extract(data, '$.timelineStatus') = 'completed'
       and json_extract(data, '$.preCompactTokenCount') is not null
     order by at, id`);
  const writeRows = db.prepare(`
    select json_extract(p.data, '$.state.input.file_path') as path,
           json_extract(m.data, '$.anchor.turnId') as turn
      from part p join message m on m.id = p.message_id
     where p.session_id = ?
       and (p.data like '%"tool":"Write"%' or p.data like '%"tool":"Edit"%')
       and json_extract(p.data, '$.type') = 'tool'
       and json_extract(p.data, '$.tool') in ('Write', 'Edit')
       and json_extract(p.data, '$.state.status') = 'completed'
       and json_extract(p.data, '$.state.input.file_path') is not null`);
  const turnRows = db.prepare(`
    select turn_id, status from turn_usage where session_id = ? order by started_at, turn_id`);

  const drops = [];
  const rows = [];
  // `--require-writes` narrows the FILLED corpus (the design's "46 of the 64"),
  // so it implies `--require-fills`; a session that never filled can never be
  // one of the 46, and dropping it under the `writes` stage would misname it.
  const requireFills = options.requireFills === true || options.requireWrites === true;
  for (const id of entry) {
    const promptsOf = prompts.get(id) ?? 0;
    const requestsOf = requests.get(id) ?? 0;
    const fills = fillRows.all(id);
    const writes = writeRows.all(id);
    const paths = new Set(writes.map(write => normalizePath(write.path)));
    // Matched-progress points: the distinct nonzero cumulative P1 values at
    // turn ends, in turn order. A turn's progress is its value after the
    // turn's last tool call (design §4).
    const turns = turnRows.all(id);
    const byTurn = new Map();
    for (const write of writes) {
      const key = write.turn ?? null;
      if (!byTurn.has(key)) byTurn.set(key, new Set());
      byTurn.get(key).add(normalizePath(write.path));
    }
    const cumulative = new Set();
    const points = new Set();
    for (const turn of turns) {
      for (const path of byTurn.get(turn.turn_id) ?? []) cumulative.add(path);
      if (cumulative.size > 0) points.add(cumulative.size);
    }
    const row = {
      id,
      prompts: promptsOf,
      requests: requestsOf,
      requestsAllRows: allRows.get(id) ?? 0,
      fills: fills.length,
      firstFillPre: fills.length === 0 ? null : fills[0].pre,
      writeCalls: writes.length,
      p1Knots: paths.size,
      matchedPoints: points.size,
      turns: turns.length,
      inFlightTurns: turns.filter(turn => turn.status === 'running').length,
    };
    if (fills.length === 0) {
      drops.push({ id, stage: 'filled', reason: 'fills=0 (design: >=1 completed auto fill)' });
      if (requireFills) { rows.push({ ...row, tier: 'dropped-fills' }); continue; }
    }
    if (fills.length > 0 && writes.length < MIN_WRITE_CALLS) {
      drops.push({
        id, stage: 'writes',
        reason: `writeCalls=${writes.length} (design: >=${MIN_WRITE_CALLS})`,
      });
      if (options.requireWrites) { rows.push({ ...row, tier: 'dropped-writes' }); continue; }
    }
    rows.push({ ...row, tier: 'kept' });
  }

  const kept = rows.filter(row => row.tier === 'kept');
  // The four rung counts are the RULE's counts, taken over EVERY session the
  // entry rung admitted, always. The narrowing flags narrow the working set
  // below them; folding a flag's effect into these numbers would print drift
  // against the design's 221 for a value the design never defined, and a drift
  // line that is an artefact of a flag misleads the reader it exists to inform.
  const all = rows;
  const counts = {
    entry: entry.length,
    filled: all.filter(row => row.fills > 0).length,
    writes: all.filter(row => row.fills > 0 && row.writeCalls >= MIN_WRITE_CALLS).length,
    matched: all.filter(row => row.fills > 0 && row.writeCalls >= MIN_WRITE_CALLS
      && row.p1Knots >= MIN_DISTINCT_PATHS).length,
  };
  const narrowed = options.requireFills === true || options.requireWrites === true ? {
    fills: true,
    writes: options.requireWrites === true,
    kept: options.requireWrites === true
      ? counts.writes : counts.filled,
  } : null;

  const matched = kept.filter(row => row.fills > 0 && row.writeCalls >= MIN_WRITE_CALLS
    && row.p1Knots >= MIN_DISTINCT_PATHS).map(row => row.id);
  const thin = kept
    .filter(row => row.fills > 0 && row.writeCalls >= MIN_WRITE_CALLS
      && row.p1Knots < MIN_DISTINCT_PATHS);

  return {
    rule: {
      minPrompts: MIN_PROMPTS,
      minRequests: MIN_REQUESTS,
      requestRow: 'model_usage.status = completed',
      minWriteCalls: MIN_WRITE_CALLS,
      minDistinctPaths: MIN_DISTINCT_PATHS,
      pathNormalization: 'backslash->slash, lowercase drive letter, collapsed //, no trailing /',
      fillRow: 'part.type=compaction, auto=1, timelineStatus=completed, preCompactTokenCount not null',
    },
    expected: { ...EXPECTED },
    counts,
    narrowed,
    drift: Object.keys(EXPECTED)
      .filter(key => counts[key] !== EXPECTED[key])
      .map(key => `${key} ${counts[key] > EXPECTED[key] ? '+' : ''}${counts[key] - EXPECTED[key]}`
        + ` (design ${EXPECTED[key]}, observed ${counts[key]})`),
    drops,
    thin: thin.map(row => ({ id: row.id, p1Knots: row.p1Knots })),
    matched,
    sessions: rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    medians: {
      firstFillPreFilled: medianCount(kept.filter(row => row.fills > 0).map(row => row.firstFillPre)),
      firstFillPreWrites: medianCount(kept.filter(row => row.fills > 0
        && row.writeCalls >= MIN_WRITE_CALLS).map(row => row.firstFillPre)),
      firstFillPreMatched: medianCount(kept.filter(row => matched.includes(row.id))
        .map(row => row.firstFillPre)),
      p1KnotsMatched: medianCount(kept.filter(row => matched.includes(row.id)).map(row => row.p1Knots)),
      matchedPointsMatched: medianCount(kept.filter(row => matched.includes(row.id))
        .map(row => row.matchedPoints)),
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(REPO_ROOT, opts.db);
  const outDir = opts.out === null ? dirname(dbPath) : resolve(REPO_ROOT, opts.out);
  if (!existsSync(dbPath)) throw new Error(`snapshot not found: ${dbPath}`);

  const digestPath = digestPathFor(dbPath);
  if (!existsSync(digestPath)) {
    process.stderr.write(`digest-absent: ${digestPath} does not exist; the corpus has no pin\n`);
    process.exit(2);
  }
  const recorded = readFileSync(digestPath, 'utf8').trim().split(/\s+/)[0] ?? null;
  const observed = await sha256File(dbPath);
  const digestHolds = observed === recorded;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let corpus;
  let rowCounts;
  try {
    corpus = selectCorpus(db, opts);
    rowCounts = {};
    for (const table of ['session', 'message', 'part', 'model_usage', 'turn_usage']) {
      rowCounts[table] = db.prepare(`select count(*) as n from ${table}`).get().n;
    }
    rowCounts.completedRequests = db.prepare(
      "select count(*) as n from model_usage where status = 'completed'",
    ).get().n;
  } finally {
    db.close();
  }

  const output = {
    schema: 'racoons-multiturn-corpus/1',
    snapshot: {
      path: dbPath,
      digestFile: digestPath,
      digest: observed,
      recordedDigest: recorded,
      digestHolds,
      bytes: statSync(dbPath).size,
      rowCounts,
    },
    ...corpus,
  };
  writeFileSync(join(outDir, 'corpus.json'), `${JSON.stringify(output, null, 2)}\n`);

  const lines = [
    'select',
    `  snapshot     ${dbPath}`,
    `  digest       ${observed} (${digestHolds ? 'matches' : 'DIFFERS from'} ${basename(digestPath)})`,
    `  rows         model_usage=${rowCounts.model_usage} part=${rowCounts.part} sessions=${rowCounts.session}`,
    `  requests     completed=${rowCounts.completedRequests}`
      + ` all=${rowCounts.model_usage}`
      + ` (a cancelled attempt carries no depth and no turn entry)`,
    `  rule         prompts>=${MIN_PROMPTS} completedRequests>=${MIN_REQUESTS}`
      + ` writeCalls>=${MIN_WRITE_CALLS} distinctPaths>=${MIN_DISTINCT_PATHS}`,
    `  corpus       entry=${corpus.counts.entry} filled=${corpus.counts.filled}`
      + ` writes=${corpus.counts.writes} matched=${corpus.counts.matched}`,
    `  expected     entry=${EXPECTED.entry} filled=${EXPECTED.filled}`
      + ` writes=${EXPECTED.writes} matched=${EXPECTED.matched}`,
    `  drift        ${corpus.drift.length === 0 ? 'none' : corpus.drift.join('; ')}`,
    `  first-fill   filled=${corpus.medians.firstFillPreFilled}`
      + ` writes=${corpus.medians.firstFillPreWrites}`
      + ` matched=${corpus.medians.firstFillPreMatched}`,
    `  p1 knots     matched median=${corpus.medians.p1KnotsMatched}`
      + ` matched-points median=${corpus.medians.matchedPointsMatched}`,
    `  out          ${join(outDir, 'corpus.json')}`,
  ];
  if (corpus.narrowed !== null) {
    lines.push(`  narrowed     kept=${corpus.narrowed.kept}`
      + ` require-fills${corpus.narrowed.writes ? ' require-writes' : ''}`);
    // `--require-writes` implies `--require-fills` (the 46 are 46 OF the 64), so
    // the fill-rung drops print for either flag.
    const dropped = corpus.drops.filter(drop => drop.stage === 'filled'
      ? (opts.requireFills || opts.requireWrites) : opts.requireWrites);
    lines.push(`  dropped      ${dropped.length}`);
    for (const drop of dropped) lines.push(`    ${drop.id} ${drop.stage}: ${drop.reason}`);
  }
  const shown = corpus.sessions.filter(row => row.tier === 'kept' && row.fills > 0
    && (corpus.narrowed === null || row.writeCalls >= MIN_WRITE_CALLS
      || !corpus.narrowed.writes));
  lines.push(`  p1 knots per session (${shown.length} in the working set)`);
  for (const row of shown) {
    const thin = row.p1Knots < MIN_DISTINCT_PATHS ? ' THIN' : '';
    lines.push(`    ${row.id} knots=${row.p1Knots} points=${row.matchedPoints}`
      + ` turns=${row.turns} fills=${row.fills} firstPre=${row.firstFillPre}${thin}`);
  }
  if (corpus.thin.length > 0) {
    lines.push(`  thin         ${corpus.thin.map(row => `${row.id}(${row.p1Knots})`).join(' ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!digestHolds) {
    process.stderr.write(`digest-drift: the snapshot is ${observed}, ${basename(digestPath)}`
      + ` records ${recorded}; the corpus is not the pinned one\n`);
    process.exitCode = 1;
  }
}

// Only a direct invocation runs the corpus; importing this module (the test
// imports `normalizePath` and `selectCorpus`) must not touch a store.
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
