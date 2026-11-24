#!/usr/bin/env node
/**
 * Chunk 4 — the progress coordinate and the matched-progress interpolator
 * (design §4 D3, §5 D4, §7 chunk 4).
 *
 * Usage:
 *   node dev/bench/multiturn/progress.mjs [--record <dir>] [--arms <dir>] [--db <snapshot>]
 *        [--coordinate p1|p2] [--flip-progress]
 *
 *   --record       an `extract.mjs` record directory (default: the pinned probe
 *                  session). P1 and every request-level quantity come from here.
 *   --arms         where chunk 3 wrote `arms/<session>/<arm>/{series,events}.jsonl`
 *                  (default: `<record>/arms`). The readings are computed over the
 *                  lanes' OWN series, never over a re-derivation of them.
 *   --db           the chunk-0 snapshot, opened read-only, for P2 only. Default:
 *                  the pinned snapshot. A missing file is `p2=absent` by name, not
 *                  a silent zero; `--coordinate p2` then refuses (exit 2).
 *   --coordinate   which coordinate the readings use. `p1` (default, primary);
 *                  `p2` is the robustness pass (Q2: both reported, never mixed).
 *   --flip-progress
 *                  the non-vacuity control: the progress clock advances to the
 *                  NEXT actual change of the selected coordinate, and every
 *                  progress-aligned reading must move while R3 stays identical.
 *
 * ## The two coordinates (design §4)
 *
 * P1 = distinct files written: normalized `file_path` over the record's nodes
 * with `kind = tool`, `tool in {Write, Edit}`, `status = completed`. The
 * normalization is `select.mjs`'s (one file written through `C:\` and `c:/` is
 * one file), so `select.mjs` and this module cannot disagree about a path.
 *
 * P2 = tasks completed: `TodoWrite` items transitioning into `completed` between
 * consecutive completed snapshots of the session (the full list is rewritten on
 * every call, so the diff between two snapshots is well defined). An item's
 * `content` is its identity. The store is the only source: `extract.mjs`'s
 * record carries no todo bodies, so P2 needs `--db`.
 *
 * Both are cumulative per `turn_usage` row — the store's own boundary — and each
 * turn is flagged `realUser` (`promptOrigin = real_user`), which is the join the
 * design asks for: progress is credited to the turn that delivered it, and a
 * reader can tell a human turn from a delegation's.
 *
 * ## The clock, the knots and the interpolator (design §4 "Rule")
 *
 * A turn's progress is its value after the turn's last tool call. So the sample
 * grid is one point per turn END: `x = coordinate(turn)`, `y = that turn's last
 * request depth` in that lane. Turns that do not move the coordinate share an
 * `x`; the later turn wins, because it is the later observation at that progress.
 * `x = 0` is the job start, at the first request's depth. Depth between knots is
 * interpolated linearly inside the spanning turn; beyond the last knot the curve
 * is clamped, because the horizon is the last observed request and a lane is
 * never measured past it.
 *
 * Both lanes share one turn plan, so their knot values are the same set; the
 * design's "union of their knot values" is that set. What differs is the
 * `depth` each lane reports at a knot.
 *
 * ## The readings (design §5), and what each one uses
 *
 *   R1  progress and depth at T's first forced loss; right-censored at the
 *       horizon when none. Depth is the record's own pre-fill depth (OBSERVED).
 *   R2  R and T at cumulative input 0.5x / 1x / 2x / 4x the session's observed
 *       threshold: each lane's progress at its own crossing, and the OTHER
 *       lane's fullness at that progress, plus the mirror. "Cumulative input" is
 *       the lane's own depth summed over requests — the tokens that lane would
 *       have sent. The observed `input_tokens` ledger is one number per request
 *       and identical in both lanes, so using it would make the mirror vacuous.
 *       SIMULATED/ESTIMATED-BYTES, labelled as such.
 *   R3  whole-job totals: fills per lane, Sigma`input_tokens`, cache hit rate
 *       (T only). No progress term — the flip must leave these byte-identical.
 *   E1  area under depth-vs-progress, and the same area per 100 units of the
 *       coordinate (`100 x area / span`): the cost of one unit of work.
 *   E3  the first fill's position in the job: percentile of P1 and of the
 *       session's own request count, beside its absolute depth.
 *   E4  progress at R's first forced loss / at T's first forced loss; a censored
 *       arm reads ">= horizon".
 *   E5  the sensitivity point the arms in this directory provide. With one
 *       removal configuration (the empty set) it is one point at fraction 0;
 *       chunk 5 adds the frozen set, chunk 6 the oracle.
 *
 * ## The flip, and the broken state it detects
 *
 * `--flip-progress` re-reads everything on a clock whose every value is the next
 * actual change of the coordinate (`12 -> 48`, `48 -> 49`, `49 -> 49`: the last
 * value has no next change and stays). The broken state the gate detects is an
 * interpolator that returns the end-of-job value: with it, no coordinate would
 * move and every reading would survive the flip. A ratio-shaped reading (E4, E5)
 * can keep its RATIO while its coordinates move when both arms are byte-equal —
 * that is a fact about the arm pair, not about the interpolator, so it prints
 * `ratio-invariant: arms-byte-equal` and is not a silent survivor. R3 must not
 * move at all: it has no progress term, and a moving R3 is a scoping bug.
 *
 * Exit: 0 = the monotone and flip gates held; 1 = a gate failed (named on
 *       stderr); 2 = bad arguments, a missing record or arms, a series that does
 *       not line up with the record, or `--coordinate p2` without a store.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizePath } from './select.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_RECORD = 'scratchpad/bench/2026-10-24-multiturn/records/sess_418282d7';
const DEFAULT_DB = 'scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite';
/** P1's tool set, frozen by the design (§4). */
const P1_TOOLS = Object.freeze(['Write', 'Edit']);
/** R2's milestone factors of the observed threshold (§5). */
const MILESTONES = Object.freeze([0.5, 1, 2, 4]);

function usage() {
  return 'usage: node dev/bench/multiturn/progress.mjs [--record <dir>] [--arms <dir>]'
    + ' [--db <snapshot>] [--coordinate p1|p2] [--flip-progress]';
}

const PROGRESS_OPTIONS = optionsOf([
  ['--record', 'string'],
  ['--arms', 'string'],
  ['--db', 'string'],
  ['--coordinate', 'string'],
  ['--flip-progress', 'boolean', 'flip'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: PROGRESS_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const opts = {
    record: values.record ?? DEFAULT_RECORD,
    arms: values.arms ?? null,
    db: values.db ?? DEFAULT_DB,
    coordinate: values.coordinate ?? 'p1',
    flip: values.flip ?? false,
  };
  if (opts.coordinate !== 'p1' && opts.coordinate !== 'p2') {
    throw new Error(`--coordinate must be p1 or p2\n${usage()}`);
  }
  return opts;
}

const mean = values => (values.length === 0 ? null
  : values.reduce((total, value) => total + value, 0) / values.length);

/** One request stream in the store's own order, ties broken on id (chunk 3's rule). */
export function flattenRequests(plan) {
  const requests = [];
  for (const turn of plan) {
    for (const request of turn.requests) requests.push({ ...request, turn: turn.turnOrdinal });
  }
  requests.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return requests;
}

/**
 * P1 per turn: cumulative distinct normalized write paths after each turn, and
 * the change list (the knot's identity: which file first appeared at which
 * turn). `recordWritesTotal` is the record's own counter, printed beside it so
 * a normalization difference is visible rather than silent.
 */
export function p1Series(plan) {
  const files = new Set();
  const values = [];
  const changes = [];
  const drift = [];
  for (const turn of plan) {
    for (const node of turn.nodes ?? []) {
      if (node.kind !== 'tool' || node.status !== 'completed') continue;
      if (!P1_TOOLS.includes(node.tool)) continue;
      if (node.filePath === null || node.filePath === undefined) continue;
      const path = normalizePath(node.filePath);
      if (files.has(path)) continue;
      files.add(path);
      changes.push({ turn: turn.turnOrdinal, path });
    }
    values.push(files.size);
    const recorded = turn.progress?.writesTotal;
    if (Number.isSafeInteger(recorded) && recorded !== files.size) {
      drift.push({ turn: turn.turnOrdinal, recorded, computed: files.size });
    }
  }
  return { values, changes, drift, files: files.size };
}

/**
 * P2 per turn: `TodoWrite` items transitioning into `completed` between
 * consecutive completed snapshots, attributed to the snapshot's turn.
 *
 * The first snapshot establishes the baseline and contributes no transition —
 * there is no predecessor to have transitioned FROM. A snapshot whose turn is
 * not in the record is counted as `unattributed` and printed, never dropped and
 * never assigned. A content that vanishes and later reappears `completed` counts
 * again: each snapshot's full list replaces the last, so that is the diff.
 */
export function p2Series(db, sessionId, plan) {
  const ordinalOf = new Map(plan.map(turn => [turn.turnId, turn.turnOrdinal]));
  const rows = db.prepare(`
    select json_extract(m.data, '$.anchor.turnId') as turn_id,
           json_extract(p.data, '$.state.input.todos') as todos,
           p.id as part_id
      from part p join message m on m.id = p.message_id
     where p.session_id = ?
       and json_extract(p.data, '$.type') = 'tool'
       and json_extract(p.data, '$.tool') = 'TodoWrite'
       and json_extract(p.data, '$.state.status') = 'completed'
     order by p.time_created, p.sequence, p.id`).all(sessionId);
  const perTurn = new Map();
  const changes = [];
  const unattributed = [];
  let baseline = 0;
  let previous = null;
  for (const row of rows) {
    const items = parseTodos(row.todos);
    const now = new Map(items.map(item => [item.content, item.status]));
    if (previous === null) {
      baseline = [...now.values()].filter(status => status === 'completed').length;
    } else {
      const ordinal = ordinalOf.get(row.turn_id);
      for (const [content, status] of now) {
        if (status !== 'completed' || previous.get(content) === 'completed') continue;
        if (ordinal === undefined) {
          unattributed.push({ partId: row.part_id, content });
          continue;
        }
        perTurn.set(ordinal, (perTurn.get(ordinal) ?? 0) + 1);
        changes.push({ turn: ordinal, content });
      }
    }
    previous = now;
  }
  const values = [];
  let running = 0;
  for (const turn of plan) {
    running += perTurn.get(turn.turnOrdinal) ?? 0;
    values.push(running);
  }
  return { values, changes, unattributed, snapshots: rows.length, baseline };
}

/** A TodoWrite input's list, or [] when the shape is not a list of items. */
function parseTodos(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(item => item !== null && typeof item === 'object'
    && typeof item.content === 'string').map(item => ({
    content: item.content, status: item.status ?? null,
  }));
}

/** The per-turn series as a clock: its values and the distinct knot values. */
export function clockOf(values) {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  return { perTurn: [...values], distinct, knots: distinct.length };
}

/**
 * The flipped clock: every value becomes the NEXT actual change of the
 * coordinate. The last value has no next change and keeps itself. A clock with
 * one value cannot be flipped — the caller refuses by name, because flipping
 * nothing is not a control.
 */
export function flipClock(clock) {
  const index = new Map(clock.distinct.map((value, position) => [value, position]));
  const perTurn = clock.perTurn.map(value => {
    const next = clock.distinct[(index.get(value) ?? 0) + 1];
    return next === undefined ? value : next;
  });
  return clockOf(perTurn);
}

/**
 * A lane's depth curve on the clock: one point per turn end (the turn's last
 * request), plus the job start at x = 0. A later turn wins a shared x.
 */
export function depthCurve(samples, clock) {
  const byX = new Map();
  for (const sample of samples) {
    byX.set(clock.perTurn[sample.turn] ?? 0, sample.depth);
  }
  const points = [...byX.entries()].sort((a, b) => a[0] - b[0]);
  if (points.length === 0) return [[0, 0]];
  if (points[0][0] !== 0) points.unshift([0, samples[0]?.depth ?? points[0][1]]);
  return points;
}

/** Linear inside the span, clamped at both ends: the lane is never read past its horizon. */
export function interpolateAt(points, x) {
  if (points.length === 0) return null;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, d1] = points[i - 1];
    const [x2, d2] = points[i];
    if (x <= x2) return d1 + ((d2 - d1) * (x - x1)) / (x2 - x1);
  }
  return last[1];
}

/** E1: the trapezoid area, and the same area per 100 coordinate units. */
export function integral(points) {
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, d1] = points[i - 1];
    const [x2, d2] = points[i];
    area += ((x2 - x1) * (d1 + d2)) / 2;
  }
  const span = points[points.length - 1][0] - points[0][0];
  return {
    area: Math.round(area),
    span,
    per100: span === 0 ? null : Math.round((area / span) * 100),
  };
}

/** The first forced loss of one lane, or null (right-censored). */
export function firstLoss(events) {
  const loss = events.find(event => event.kind === 'forced-loss');
  return loss === undefined ? null : loss;
}

/** One lane's readings, on whatever clock it is given. */
export function laneReadings({ lane, samples, events, requests, clock, threshold, horizon }) {
  const curve = depthCurve(samples, clock);
  const loss = firstLoss(events);
  return {
    lane,
    samples,
    curve,
    loss,
    progressAtLoss: loss === null ? null : clock.perTurn[loss.turn] ?? 0,
    e1: integral(curve),
    firstLossProgress: loss === null ? null : clock.perTurn[loss.turn] ?? 0,
    firstLossIndex: loss === null ? null : loss.index,
    fills: events.filter(event => event.kind === 'forced-loss').length,
  };
}

/**
 * R2: at each milestone of each lane's own cumulative depth, that lane's
 * progress and the other lane's fullness there, plus the mirror. A milestone
 * past a lane's horizon is `beyond`, never clamped into a number.
 */
export function milestoneRows({ traditional, racoons, clock, threshold }) {
  if (threshold === null) return [];
  const rows = [];
  const crossing = (samples, milestone) => {
    let running = 0;
    for (const [i, sample] of samples.entries()) {
      running += sample.depth;
      if (running >= milestone) return { index: i, turn: sample.turn, cumulative: running };
    }
    return null;
  };
  for (const milestone of MILESTONES) {
    const target = Math.round(threshold * milestone);
    const tCross = crossing(traditional.samples, target);
    const rCross = crossing(racoons.samples, target);
    rows.push({
      factor: milestone,
      target,
      side: 'r-at-r',
      progress: rCross === null ? null : clock.perTurn[rCross.turn] ?? 0,
      other: rCross === null ? null : interpolateAt(traditional.curve, clock.perTurn[rCross.turn] ?? 0),
      own: rCross === null ? null : interpolateAt(racoons.curve, clock.perTurn[rCross.turn] ?? 0),
    });
    rows.push({
      factor: milestone,
      target,
      side: 't-at-t',
      progress: tCross === null ? null : clock.perTurn[tCross.turn] ?? 0,
      other: tCross === null ? null : interpolateAt(racoons.curve, clock.perTurn[tCross.turn] ?? 0),
      own: tCross === null ? null : interpolateAt(traditional.curve, clock.perTurn[tCross.turn] ?? 0),
    });
  }
  return rows;
}

/**
 * Every progress-aligned reading plus R3, on one clock. Pure in its inputs so
 * the flip is the only difference between two calls, and chunk 6 can score a
 * stored reading bundle instead of walking a record again.
 */
export function readAll({ traditional, racoons, clock, threshold, requests, horizon }) {
  const tLoss = traditional.loss;
  const rLoss = racoons.loss;
  const tProgress = tLoss === null ? null : clock.perTurn[tLoss.turn] ?? 0;
  const rProgress = rLoss === null ? null : clock.perTurn[rLoss.turn] ?? 0;
  const sumInput = requests.reduce((total, request) => total + (request.inputTokens ?? 0), 0);
  const sumCache = requests.reduce((total, request) => total + (request.cacheReadInputTokens ?? 0), 0);
  return {
    horizonProgress: horizon.progress,
    R1: {
      progress: tProgress,
      depth: tLoss === null ? null : tLoss.pre,
      censored: tLoss === null,
      progressAtHorizon: horizon.progress,
    },
    R2: milestoneRows({ traditional, racoons, clock, threshold }),
    R3: {
      fills: { traditional: traditional.fills, racoons: racoons.fills },
      sumInput,
      cacheHit: sumInput === 0 ? null : sumCache / sumInput,
      lane: 'cache is T only, OBSERVED (E2)',
    },
    E1: { traditional: traditional.e1, racoons: racoons.e1 },
    E3: tLoss === null ? null : {
      progress: tProgress,
      progressPercentile: horizon.progress === 0 ? null : (tProgress / horizon.progress) * 100,
      requestPercentile: ((tLoss.index + 1) / requests.length) * 100,
      depth: tLoss.pre,
    },
    E4: {
      r: rProgress,
      t: tProgress,
      ratio: rProgress === null || tProgress === null || tProgress === 0
        ? null : rProgress / tProgress,
      censored: rProgress === null || tProgress === null,
    },
    E5: {
      fraction: 0,
      r: rProgress,
      t: tProgress,
      ratio: rProgress === null || tProgress === null || tProgress === 0
        ? null : rProgress / tProgress,
      points: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// The printed form, so a flip can compare two renders field by field.

const line = value => (value === null || value === undefined ? 'n/a' : String(value));
const pct = value => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}%`);
const ratio = value => (value === null || value === undefined ? 'n/a' : value.toFixed(3));
const rate = value => (value === null || value === undefined ? 'n/a' : value.toFixed(4));

/** One reading as a map of comparable fields, for the flip's moved check. */
function readingFields(readings) {
  const fields = new Map();
  // `horizon` is part of every progress-aligned reading: a censored arm has no
  // loss to place, and without it the reading would survive every flip for the
  // reason that it is empty, not for the reason that the clock is live.
  const horizon = `horizon=${line(readings.horizonProgress)}`;
  fields.set('R1', [horizon, `progress=${line(readings.R1.progress)}`,
    `depth=${line(readings.R1.depth)}`]);
  fields.set('R2', [horizon, ...readings.R2.map(row => `${row.factor}:${row.side}:`
    + `${line(row.progress)}/${line(row.other)}/${line(row.own)}`)]);
  fields.set('R3', [`fills=${readings.R3.fills.traditional}/${readings.R3.fills.racoons}`,
    `sumInput=${readings.R3.sumInput}`, `cacheHit=${rate(readings.R3.cacheHit)}`]);
  fields.set('E1', [horizon,
    `t=${readings.E1.traditional.area}/${readings.E1.traditional.per100}`,
    `r=${readings.E1.racoons.area}/${readings.E1.racoons.per100}`]);
  fields.set('E3', readings.E3 === null ? [horizon, 'censored']
    : [horizon, `progress=${line(readings.E3.progress)}`,
      `p1=${pct(readings.E3.progressPercentile)}`,
      `request=${pct(readings.E3.requestPercentile)}`]);
  fields.set('E4', [horizon, `r=${line(readings.E4.r)}`, `t=${line(readings.E4.t)}`,
    `ratio=${ratio(readings.E4.ratio)}`]);
  fields.set('E5', [horizon, `fraction=${readings.E5.fraction}`, `r=${line(readings.E5.r)}`,
    `t=${line(readings.E5.t)}`, `ratio=${ratio(readings.E5.ratio)}`]);
  return fields;
}

function formatReadings(readings) {
  const r1 = readings.R1;
  const out = [
    `  R1           ${r1.censored ? `right-censored at progress=${r1.progressAtHorizon}`
      : `progress=${r1.progress} depth=${r1.depth} (traditional first forced loss)`}`,
    `  R2           ${readings.R2.length === 0 ? 'absent (no observed threshold)'
      : readings.R2.map(row => `${row.target}${row.side === 'r-at-r' ? 'R' : 'T'}`
        + `${row.progress === null ? ' beyond' : `:p=${row.progress}`
          + ` other=${row.other} own=${row.own}`}`).join(' | ')}`,
    `  R3           fills t=${readings.R3.fills.traditional} r=${readings.R3.fills.racoons}`
      + ` sumInput=${readings.R3.sumInput} cacheHit=${pct(readings.R3.cacheHit)}`
      + ' (whole-job, T only; the flip must leave this identical)',
    `  E1           traditional area=${readings.E1.traditional.area}`
      + ` per100=${line(readings.E1.traditional.per100)}`
      + ` | racoons area=${readings.E1.racoons.area}`
      + ` per100=${line(readings.E1.racoons.per100)}`,
    `  E3           ${readings.E3 === null ? 'censored'
      : `progress=${readings.E3.progress} p1-percentile=${pct(readings.E3.progressPercentile)}`
        + ` request-percentile=${pct(readings.E3.requestPercentile)} depth=${readings.E3.depth}`}`,
    `  E4           r=${line(readings.E4.r)} t=${line(readings.E4.t)} ratio=${ratio(readings.E4.ratio)}`
      + `${readings.E4.censored ? ' (censored: >= horizon)' : ''}`,
    `  E5           fraction=${readings.E5.fraction} r=${line(readings.E5.r)} t=${line(readings.E5.t)}`
      + ` ratio=${ratio(readings.E5.ratio)} points=${readings.E5.points}`
      + ' (one point: the empty set; chunk 5 adds the frozen set)',
  ];
  return out;
}

function readSeries(dir, sessionId, arm, requests) {
  const seriesPath = join(dir, 'arms', sessionId, arm, 'series.jsonl');
  const eventsPath = join(dir, 'arms', sessionId, arm, 'events.jsonl');
  for (const path of [seriesPath, eventsPath]) {
    if (!existsSync(path)) {
      throw new Error(`arms-missing: ${path} does not exist; run chunk 3's lanes.mjs first`);
    }
  }
  const samples = readFileSync(seriesPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (samples.length !== requests.length) {
    throw new Error(`series-misaligned: ${arm} has ${samples.length} samples against`
      + ` ${requests.length} record requests; the record and the arms are not the same run`);
  }
  for (const [i, sample] of samples.entries()) {
    if (sample.i !== i || sample.turn !== requests[i].turn) {
      throw new Error(`series-misaligned: ${arm} sample ${i} names index ${sample.i} turn`
        + ` ${sample.turn}, the record says index ${i} turn ${requests[i].turn}`);
    }
  }
  return { samples, events };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const recordDir = resolve(REPO_ROOT, opts.record);
  const armsDir = opts.arms === null ? recordDir : resolve(REPO_ROOT, opts.arms);
  const manifestPath = join(recordDir, 'manifest.json');
  const turnsPath = join(recordDir, 'turns.jsonl');
  if (!existsSync(manifestPath) || !existsSync(turnsPath)) {
    throw new Error(`record not found: ${recordDir} (needs manifest.json and turns.jsonl)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = readFileSync(turnsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (plan.length === 0) throw new Error(`record has no turns: ${recordDir}`);
  const sessionId = manifest.session?.id ?? 'unknown-session';
  const requests = flattenRequests(plan);
  const threshold = Number.isSafeInteger(manifest.pinned?.threshold) ? manifest.pinned.threshold : null;

  // ---- the coordinates ----------------------------------------------------
  const p1 = p1Series(plan);
  const dbPath = resolve(REPO_ROOT, opts.db);
  let p2 = null;
  let p2Absent = null;
  if (!existsSync(dbPath)) {
    p2Absent = `${dbPath} is not on this device`;
  } else {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      p2 = p2Series(db, sessionId, plan);
    } finally {
      db.close();
    }
    if (p2.snapshots === 0) {
      // Zero snapshots is not progress zero: the store holds no TodoWrite call
      // for this session, so the coordinate has no source here at all.
      p2Absent = `the store holds no completed TodoWrite snapshot for ${sessionId}`;
      p2 = null;
    }
  }
  if (opts.coordinate === 'p2' && p2 === null) {
    throw new Error(`p2-unavailable: ${p2Absent}; P2 needs a session with TodoWrite history`
      + ' (the record carries no todo bodies)');
  }
  const coordinate = opts.coordinate === 'p2' ? p2 : p1;

  const baselineClock = clockOf(coordinate.values);
  const flat = baselineClock.knots <= 1;
  if (opts.flip && flat) {
    throw new Error(`progress-clock-flat: the ${opts.coordinate} coordinate has`
      + ` ${baselineClock.knots} knot(s) in ${sessionId}; there is no actual change to advance to,`
      + ' so the flip would test nothing');
  }
  const clock = opts.flip ? flipClock(baselineClock) : baselineClock;

  // ---- the lanes ----------------------------------------------------------
  const traditionalArms = readSeries(armsDir, sessionId, 'traditional', requests);
  const racoonsArms = readSeries(armsDir, sessionId, 'racoons', requests);
  const horizon = {
    progress: clock.perTurn[plan[plan.length - 1].turnOrdinal] ?? 0,
    index: requests.length - 1,
    depth: traditionalArms.samples[traditionalArms.samples.length - 1]?.depth ?? null,
  };
  const traditional = laneReadings({
    lane: 'traditional', samples: traditionalArms.samples, events: traditionalArms.events,
    requests, clock, threshold, horizon,
  });
  const racoons = laneReadings({
    lane: 'racoons', samples: racoonsArms.samples, events: racoonsArms.events,
    requests, clock, threshold, horizon,
  });
  const readings = readAll({ traditional, racoons, clock, threshold, requests, horizon });

  // ---- gates --------------------------------------------------------------
  const monotone = list => list.every((value, i) => i === 0 || value >= list[i - 1]);
  const monotoneP1 = monotone(p1.values);
  const monotoneP2 = p2 === null ? null : monotone(p2.values);
  const monotoneCoordinate = monotone(coordinate.values);
  const drift = p1.drift.length;

  let flipReport = null;
  let flipHeld = null;
  if (opts.flip) {
    const baseTraditional = laneReadings({
      lane: 'traditional', samples: traditionalArms.samples, events: traditionalArms.events,
      requests, clock: baselineClock, threshold, horizon: {
        ...horizon, progress: baselineClock.perTurn[plan[plan.length - 1].turnOrdinal] ?? 0,
      },
    });
    const baseRacoons = laneReadings({
      lane: 'racoons', samples: racoonsArms.samples, events: racoonsArms.events,
      requests, clock: baselineClock, threshold, horizon: {
        ...horizon, progress: baselineClock.perTurn[plan[plan.length - 1].turnOrdinal] ?? 0,
      },
    });
    const base = readAll({
      traditional: baseTraditional, racoons: baseRacoons, clock: baselineClock,
      threshold, requests, horizon: { ...horizon,
        progress: baselineClock.perTurn[plan[plan.length - 1].turnOrdinal] ?? 0 },
    });
    const before = readingFields(base);
    const after = readingFields(readings);
    const armsEqual = traditionalArms.samples.every((sample, i) =>
      sample.depth === racoonsArms.samples[i].depth);
    flipReport = [...before.keys()].map(key => {
      const left = before.get(key);
      const right = after.get(key);
      const changed = left.filter((value, i) => value !== right[i]);
      // E4/E5 are ratios: with byte-equal arms every coordinate moves together
      // and the ratio is 1 by construction. That is a fact about the arm pair,
      // not a dead interpolator, so it is named instead of scored as a survivor.
      const ratioShaped = key === 'E4' || key === 'E5';
      const ratioSurvives = ratioShaped && armsEqual
        && left[left.length - 1] === right[right.length - 1];
      return {
        key,
        moved: changed.length > 0,
        changed,
        ratioInvariant: ratioSurvives ? 'arms-byte-equal' : null,
        before: left.join(' '),
        after: right.join(' '),
      };
    });
    const r3 = flipReport.find(row => row.key === 'R3');
    const survivors = flipReport.filter(row => row.key !== 'R3' && !row.moved);
    flipHeld = r3.moved === false && survivors.length === 0;
    flipReport.r3Fixed = r3.moved === false;
    flipReport.survivors = survivors.map(row => row.key);
  }

  // ---- output -------------------------------------------------------------
  const lines = [
    'progress',
    `  session      ${sessionId}`,
    `  record       ${recordDir}`,
    `  coordinate   ${coordinate === p1 ? 'p1' : 'p2'}`
      + `${opts.coordinate === 'p2' ? ' (robustness)' : ' (primary)'}`,
    `  flip         ${opts.flip ? 'next-knot (advance to the next actual change)' : 'none'}`,
    `  turns        ${plan.length}`
      + ` realUserTurns=${plan.filter(turn => turn.promptOrigin === 'real_user').length}`
      + ` prompts=${manifest.selected?.prompts ?? 'n/a'}`,
    `  p1           files=${p1.files} clock-knots=${baselineClock === null ? 0
      : clockOf(p1.values).knots} values=${clockOf(p1.values).distinct.join(',')}`
      + ` changes=${p1.changes.length}`
      + ` record-writesTotal-drift=${drift}`,
    `  p2           ${p2 === null ? `absent (${p2Absent}; P2 is robustness only)`
      : `snapshots=${p2.snapshots} baseline-completed=${p2.baseline}`
        + ` transitions=${p2.changes.length} clock-knots=${clockOf(p2.values).knots}`
        + ` values=${clockOf(p2.values).distinct.join(',')}`
        + ` unattributed=${p2.unattributed.length}`}`,
    `  monotone     p1=${monotoneP1 ? 'ok' : 'FAIL'}`
      + ` p2=${monotoneP2 === null ? 'n/a' : monotoneP2 ? 'ok' : 'FAIL'}`
      + ` coordinate=${monotoneCoordinate ? 'ok' : 'FAIL'}`,
  ];
  for (const turn of plan) {
    lines.push(`  turn         t${turn.turnOrdinal}`
      + ` p1=${p1.values[turn.turnOrdinal]}`
      + ` p2=${p2 === null ? 'n/a' : p2.values[turn.turnOrdinal]}`
      + ` req=${turn.requests.length}`
      + ` real=${turn.promptOrigin === 'real_user' ? 'yes' : 'no'}`);
  }
  lines.push(`  knots        ${clock.perTurn.join(',')} value-set=${clock.distinct.join(',')}`);
  if (opts.coordinate === 'p2' && p2 !== null && p2.unattributed.length > 0) {
    lines.push(`  p2-dropped   ${p2.unattributed.length} transitions outside any record turn`
      + ` (${p2.unattributed.slice(0, 3).map(row => row.partId).join(' ')}), never assigned`);
  }
  lines.push(...formatReadings(readings));
  if (flipReport !== null) {
    lines.push('  flip-progress');
    for (const row of flipReport) {
      if (row.key === 'R3') {
        lines.push(`    R3   fixed   ${row.after}${row.moved ? ' MOVED (scoping bug)' : ' byte-identical'}`);
      } else {
        lines.push(`    ${row.key}   ${row.moved ? 'moved  ' : 'SURVIVED'} ${row.after}`
          + `${row.ratioInvariant === null ? '' : ` ratio-invariant: ${row.ratioInvariant}`}`);
      }
    }
  }
  lines.push(`  gate         monotone=${monotoneP1 && monotoneCoordinate ? 'ok' : 'FAIL'}`
    + `${flipReport === null ? ''
      : ` flip-progress=${flipHeld ? 'ok' : 'FAIL'} r3=${flipReport.r3Fixed ? 'fixed' : 'MOVED'}`}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!monotoneP1 || !monotoneCoordinate) {
    process.stderr.write(`progress-not-monotone: a later turn carries less ${opts.coordinate}`
      + ` progress (${coordinate.values.join(',')}); a progress clock must never decrease\n`);
    process.exitCode = 1;
  }
  if (flipReport !== null && !flipReport.r3Fixed) {
    process.stderr.write('r3-moved: the flip changed a whole-job total; R3 has no progress term,'
      + ' so this is a scoping bug\n');
    process.exitCode = 1;
  }
  if (flipReport !== null && flipReport.survivors.length > 0) {
    process.stderr.write(`flip-progress-vacuous: ${flipReport.survivors.join(',')} survived the flip;`
      + ' the interpolator is not reading the coordinate\n');
    process.exitCode = 1;
  }
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
