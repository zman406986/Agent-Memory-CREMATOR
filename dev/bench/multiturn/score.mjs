#!/usr/bin/env node
/**
 * Chunk 6 — the verdict tables (design §5 D4), scored progress-aligned.
 *
 * Usage:
 *   node dev/bench/multiturn/score.mjs [--record <dir>]... [--db <snapshot>]
 *        [--out <dir>] [--removals none|oracle|<file>] [--set-label <name>]
 *        [--coordinate p1|p2] [--swap-arms] [--flip-progress]
 *   node dev/bench/multiturn/score.mjs --verify <summary.json>
 *
 *   --record       one or more `extract.mjs` record directories (default: the
 *                  pinned probe session). Each is scored on its own and the
 *                  aggregate is the median of their per-session ratios.
 *   --db           the chunk-0 snapshot, for P2 only (default: the pinned
 *                  snapshot). Missing prints `p2=absent` by name; `--coordinate
 *                  p2` then refuses (exit 2).
 *   --out          where `summary.json` and `SUMMARY.md` land (default: the
 *                  design's data directory, `scratchpad/bench/2026-10-24-multiturn`).
 *   --removals     the measured point: `none` (the floor), `oracle` (the
 *                  right-censored ceiling), or a frozen set file — a chunk-5
 *                  `removal.json` or a `{decisions: [...]}` file. The floor and
 *                  the oracle are ALWAYS scored too: R4 is a bracket, and a
 *                  point without its bounds is not a verdict.
 *   --set-label    names the measured point in the tables.
 *   --coordinate   which progress coordinate the readings use: `p1` (primary) or
 *                  `p2` (robustness). Q2: both reported, never mixed.
 *   --swap-arms    the control: every arm-asymmetric reading takes the other arm
 *                  as its numerator. With byte-equal arms the ratio is 1.00 and
 *                  prints `ratio-invariant: arms-byte-equal`; with a real
 *                  removal set the ratio must invert or the gate fails.
 *   --flip-progress
 *                  chunk 4's non-vacuity control: the clock advances to the
 *                  next actual change of the coordinate. Every progress-aligned
 *                  reading (R1, R2, E1, E3, E4, E5) must move; R3 — which has
 *                  no progress term — must stay byte-identical.
 *   --verify       re-reads a stored summary and re-derives every cell from the
 *                  bundle in it. A drifted cell is named, never averaged away.
 *
 * ## Who owns what
 *
 * The planner, the applied-set rule and the receipt template are the product's
 * (`UnitTracker`, `planPrunePass`, `appliedSetAt`, `receiptLine`). The progress
 * clock, the interpolator and the readings R1/R2/R3/E1/E3/E4/E5-base are chunk
 * 4's (`progress.mjs`), imported so two readers of one record cannot disagree.
 * Chunk 5 owns frozen-set validation: a `--removals <file>` set is consumed as
 * already validated, and a set that names this run as its source is refused by
 * name (design §8).
 *
 * This module adds the bracket walk (a frozen set through the lane model), the
 * oracle construction, E2/E5/E6/E7, R4, the per-cell label grid, the aggregate
 * rule, and the summary round-trip.
 *
 * ## The bracket walk (design §3 D2)
 *
 * The Traditional lane is chunk 3's headline model: the record's own fills
 * replayed at their observed landing indices, with the record's own
 * `truePostCompactTokenCount` as the post-fill size. Fill position and pre-fill
 * depth are OBSERVED; the depth scale is ESTIMATED-BYTES.
 *
 * The Racoons lane runs the same plan with one frozen removal set:
 *
 *   - a decision made at turn D applies from D+1 (`appliedSetAt`, the shipped
 *     rule), taking its unit's bytes out at the record's quotient and adding
 *     back its receipt's bytes (the shipped `receiptLine`);
 *   - a native fill REWRITES the surface: one summary node replaces the prefix,
 *     so removals decided at or before the fill's turn stop paying and their
 *     receipts stop counting. `fillFloor` is that boundary. Without it a removed
 *     span would be deducted twice — once by the removal, once by the summary;
 *   - the recorded forced loss is OBSERVED, but this lane's copy of it lands at
 *     the first request at or after the observed index where THIS lane reaches
 *     the depth Traditional had just before that fill. With the empty set the
 *     two lanes agree at every request, so the floor ratio is exactly 1.00 by
 *     construction, not by luck; with removals R reaches the depth later, or
 *     never inside the horizon (`>= horizon`).
 *
 * The oracle set is the design's ceiling, never a verdict: a unit is removable at
 * boundary B when the shipped pass asks it at B, the unit carries an evidence
 * path, and NO LATER TURN uses that path again. Units without a path are
 * excluded rather than assumed removable — the record proves nothing about them,
 * and a ceiling must be made of proven units. A unit asked at several boundaries
 * enters once, at the earliest. The exclusion counts print.
 *
 * ## Labels, per cell (design §5)
 *
 *   OBSERVED                    read from the record (fill index, ledger, depth)
 *   SIMULATED                   the counterfactual lane, or between-knot progress
 *   ESTIMATED-BYTES             a depth from the `/4` byte quotient
 *   SIMULATED/ESTIMATED-BYTES   both, hardest qualification first
 *
 * Every progress-aligned reading's compared fields carry `horizon`: a censored
 * arm has no loss to place, and without the horizon it would survive every flip
 * for the reason that it is empty, not for the reason that the clock is live.
 *
 * ## The aggregate rule
 *
 * The headline is the MEDIAN of per-session horizon ratios over NON-CENSORED
 * sessions, with the censored count printed beside it. Never a ratio of sums: a
 * ratio of sums lets one long session speak for the corpus and reports a number
 * no single job produced.
 *
 * Exit: 0 = every gate held and every cell reproduced; 1 = a gate failed or a
 *       stored cell drifted (named on stderr); 2 = bad arguments, a missing
 *       record, an unreadable set, or `--coordinate p2` without a store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { appliedSetAt, planPrunePass, receiptLine, UnitTracker } from '@cremator/core';
import {
  clockOf, depthCurve, flipClock, flattenRequests, interpolateAt, laneReadings, p1Series,
  p2Series, readAll,
} from './progress.mjs';
import { boundarySnapshot, snapshotNodes } from './removal.mjs';
import { normalizePath } from './select.mjs';
import { flatten, mapFills, pristineSeries, walk } from './lanes.mjs';
import { median } from '../../shared/stats.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_RECORD = 'scratchpad/bench/2026-10-24-multiturn/records/sess_418282d7';
const DEFAULT_DB = 'scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite';
const DEFAULT_OUT = 'scratchpad/bench/2026-10-24-multiturn';
const SCHEMA = 'racoons-multiturn-score/1';
/** The design's W assumption (§3): W := T / 0.8. */
const W_RATIO = 0.8;
/** The shipped unit bar (`config.protocol.barBytes`, 512 since ADR-0051); the mount passes the same. */
const BAR_BYTES = 512;
/** The record's own byte-to-token quotient (extract.mjs `byteQuotient`). */
const TOKEN_QUOTIENT = 4;
/** The shipped receipt's recall-id shape: `recall:sha256:` plus 64 hex. */
const RECALL_ID_SHAPE = `recall:sha256:${'0'.repeat(64)}`;
/** E5's W-branch latch row (§3): W' := T + O + B. */
const W_BRANCH = Object.freeze({ outputReservation: 256000, harnessHeadroom: 65536 });

const OBSERVED = 'OBSERVED';
const SIMULATED = 'SIMULATED';
const BYTES = 'ESTIMATED-BYTES';
const COMPOUND = 'SIMULATED/ESTIMATED-BYTES';

function usage() {
  return 'usage: node dev/bench/multiturn/score.mjs [--record <dir>]... [--db <snapshot>]'
    + ' [--out <dir>] [--removals none|oracle|<file>] [--set-label <name>]'
    + ' [--coordinate p1|p2] [--swap-arms] [--flip-progress]\n'
    + '       node dev/bench/multiturn/score.mjs --verify <summary.json>';
}

const SCORE_OPTIONS = optionsOf([
  ['--db', 'string'],
  ['--out', 'string'],
  ['--removals', 'string'],
  ['--set-label', 'string', 'setLabel'],
  ['--coordinate', 'string'],
  ['--verify', 'string'],
  ['--record', 'string', 'records', { multiple: true }],
  ['--swap-arms', 'boolean', 'swap'],
  ['--flip-progress', 'boolean', 'flip'],
]);

/** Every `--record` is kept, in the order given; the default applies only when none was named. */
function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: SCORE_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const opts = {
    records: values.records ?? [],
    db: values.db ?? DEFAULT_DB,
    out: values.out ?? DEFAULT_OUT,
    removals: values.removals ?? 'none',
    setLabel: values.setLabel ?? null,
    coordinate: values.coordinate ?? 'p1',
    swap: values.swap ?? false,
    flip: values.flip ?? false,
    verify: values.verify ?? null,
  };
  if (opts.records.length === 0) opts.records.push(DEFAULT_RECORD);
  if (opts.coordinate !== 'p1' && opts.coordinate !== 'p2') {
    throw new Error(`--coordinate must be p1 or p2\n${usage()}`);
  }
  if (opts.verify === null && opts.removals !== 'none' && opts.removals !== 'oracle'
    && opts.setLabel === null) {
    opts.setLabel = opts.removals.split(/[\\/]/).pop() ?? 'frozen set';
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Numeric helpers. A null is "not defined on this record", never a zero.
// `median` is `dev/lib/stats.mjs` — one copy for the lane, the corpus and the
// scorer (ISSUE-072); it does not round, and `round()` below is the presentation.

const sum = values => values.reduce((total, value) => total + value, 0);
const int = value => (value === null || value === undefined ? 'n/a' : String(value));
const fixed = (value, digits) => (value === null || value === undefined ? 'n/a'
  : value.toFixed(digits));
const pct = value => (value === null || value === undefined ? 'n/a'
  : `${(value * 100).toFixed(2)}%`);
const pct1 = value => (value === null || value === undefined ? 'n/a'
  : `${value.toFixed(1)}%`);
const round = value => (value === null || value === undefined ? null : Math.round(value));

// ---------------------------------------------------------------------------
// The bracket walk.

/**
 * The recorded forced losses, one event per landing request. Multiple fills that
 * land on one request collapse to the last post size — chunk 3 reads the same
 * way, and the record has one landing per fill.
 */
export function forcedLossEvents(requests, mapped) {
  const events = [];
  for (const fill of mapped) {
    const existing = events.find(event => event.observedIndex === fill.index);
    if (existing !== undefined) {
      existing.post = fill.truePostCompactTokenCount ?? existing.post;
      existing.observedPre = fill.preCompactTokenCount ?? existing.observedPre;
      continue;
    }
    events.push({
      observedIndex: fill.index,
      observedPre: fill.preCompactTokenCount ?? null,
      post: fill.truePostCompactTokenCount ?? null,
      turn: requests[fill.index]?.turn ?? null,
      boundaryId: fill.boundaryId ?? null,
    });
  }
  return events.sort((a, b) => a.observedIndex - b.observedIndex);
}

/**
 * The Traditional lane: chunk 3's replay walk. `trigger` on each event is the
 * lane's own depth just before that fill landed — the depth the Racoons lane must
 * reach again before the same event can land in its own series.
 */
export function walkTraditional({ requests, pristine, events }) {
  const observedFills = events.map(event => ({
    index: event.observedIndex, truePostCompactTokenCount: event.post,
  }));
  const walked = walk({
    requests, pristine, observedFills, replay: true, threshold: null,
    triggerSource: 'observed-fill', postOf: () => null, progressOf: () => 0,
  });
  for (const [i, loss] of walked.events.entries()) {
    loss.observedIndex = events[i]?.observedIndex ?? null;
    loss.observedPre = events[i]?.observedPre ?? null;
    loss.deferred = 0;
    // This lane's own depth just before the fill landed: the depth the Racoons
    // lane must reach again before the same event can land there. It is
    // OBSERVED-BYTES (a reconstruction), and the empty set reproduces it exactly.
    loss.trigger = loss.index === 0 ? 0 : walked.series[loss.index - 1];
  }
  return walked;
}

/**
 * The Racoons lane with a frozen removal set over the same plan.
 *
 * `fillFloor` is the highest turn in which a native fill has landed in THIS
 * lane: decisions made at or before it no longer pay (the summary replaced their
 * span) and their receipts no longer count.
 */
export function walkBracket({ requests, pristine, events, decisions, unitMeta, receiptTokensOf: receiptOf }) {
  const series = new Array(requests.length);
  const losses = [];
  let offset = 0;
  let next = 0;
  let fillFloor = -1;
  let previous = 0;
  for (let i = 0; i < requests.length; i++) {
    const turn = requests[i].turn;
    const applied = appliedSetAt(decisions, turn)
      .filter(entry => (unitMeta.get(entry.unitId)?.turn ?? -1) > fillFloor);
    let removedBytes = 0;
    let receiptTokens = 0;
    for (const entry of applied) {
      const meta = unitMeta.get(entry.unitId);
      if (meta === undefined) continue;
      removedBytes += meta.bytes;
      receiptTokens += receiptOf(meta);
    }
    let depth = pristine[i] + offset
      - Math.round(removedBytes / TOKEN_QUOTIENT) + receiptTokens;
    // The host checks AFTER a request and the fill lands after the crossing
    // (design §2.3), so the same event lands at the first request at or after its
    // observed index where THIS lane's own depth has reached the depth the
    // Traditional lane recorded just before that fill. The trigger is that depth
    // (an OBSERVED-BYTES value), never a formula: the lane either re-earns it
    // later or stays under it and the event never lands.
    //
    // With the empty set both lanes are byte-equal at every request, so the
    // landing is the observed one by construction — that is why the floor ratio
    // is exactly 1.00 rather than approximately.
    while (next < events.length && i >= events[next].observedIndex
      && depth >= (events[next].trigger ?? 0)) {
      const event = events[next];
      offset = event.post - pristine[i];
      fillFloor = Math.max(fillFloor, turn);
      losses.push({
        kind: 'forced-loss', index: i, turn, pre: i === 0 ? 0 : previous,
        post: event.post, observedIndex: event.observedIndex,
        observedPre: event.observedPre, deferred: i - event.observedIndex,
        trigger: event.trigger, triggerSource: 'observed-fill',
      });
      depth = event.post;
      next++;
    }
    series[i] = depth;
    previous = depth;
  }
  return { series, events: losses, losses, unreached: next };
}

/** A frozen set's decisions in the shipped shape (turn, unitId, ranges). */
export function decisionsOf(entries) {
  return entries.map(entry => ({
    turn: entry.turn, unitId: entry.unitId, ranges: entry.ranges ?? [],
  }));
}

/** The unit catalogue a walk needs: bytes and the deciding turn, per unit id. */
export function unitCatalogue(entries) {
  const meta = new Map();
  for (const entry of entries) {
    meta.set(entry.unitId, {
      bytes: entry.byteLength ?? 0, path: entry.path ?? null, turn: entry.turn,
    });
  }
  return meta;
}

/**
 * The shipped receipt's token cost for one removable unit: the floor receipt
 * (a whole-unit removal ships `ranges: []`, the product's own rule) at the
 * record's quotient. The recall id is a fixed-length placeholder because only
 * the line's LENGTH enters a token estimate, and every real id has one shape.
 */
export function receiptTokensOf(meta) {
  if (meta === null || meta === undefined) return 0;
  const line = receiptLine({
    path: meta.path ?? 'transcript', ranges: [], label: null, recallId: RECALL_ID_SHAPE,
  });
  return Math.ceil(Buffer.byteLength(line, 'utf8') / TOKEN_QUOTIENT);
}

// ---------------------------------------------------------------------------
// The oracle ceiling (design §3 stage A).

/**
 * Build the oracle removal set: every unit the shipped pass asks at a boundary,
 * when it has an evidence path and no later TURN names that path again. A unit
 * asked at several boundaries enters once, at the earliest.
 */
export function buildOracle({ plan, sessionId }) {
  const nodes = snapshotNodes(plan);
  const tracker = new UnitTracker({ sessionId, barBytes: BAR_BYTES });
  const ordered = [];
  for (const turn of plan) for (const node of turn.nodes) ordered.push({ ...node, turn: turn.turnOrdinal });
  const indexOfNode = new Map(ordered.map((node, i) => [node.id, i]));
  const pathAt = ordered.map(node => (node.kind === 'tool' && node.filePath
    ? normalizePath(node.filePath) : null));
  const lastTurnOfPath = new Map();
  for (const node of ordered) {
    if (node.kind !== 'tool' || !node.filePath) continue;
    lastTurnOfPath.set(normalizePath(node.filePath), node.turn);
  }

  const decisions = [];
  const seen = new Set();
  const excluded = { noPath: 0, usedAgain: 0, unplanned: 0 };
  const boundaries = [];

  for (const turn of plan) {
    if (turn.requests.length === 0) continue;
    const boundary = boundarySnapshot(nodes, turn.turnOrdinal, sessionId);
    const units = tracker.units(boundary);
    const pass = planPrunePass({
      units, nodes: boundary.nodes.filter(node => node.kind === 'tool-result'),
      episodes: [], round: 0,
      // Every superseded-read dedupe class off — the shipped default (ADR-0037), the
      // same `{}` the mount sends when no operator names a class. The oracle this
      // builds must see exactly the ask rows the pre-dedupe runs recorded.
      classes: {},
    });
    boundaries.push({ turn: turn.turnOrdinal, askRows: pass.askRows.length });
    for (const row of pass.askRows) {
      const unit = row.unit;
      if (seen.has(unit.id)) continue;
      const index = indexOfNode.get(unit.nodeId);
      if (index === undefined) { excluded.unplanned++; continue; }
      if (pathAt[index] === null) { excluded.noPath++; continue; }
      if ((lastTurnOfPath.get(pathAt[index]) ?? -1) > turn.turnOrdinal) {
        excluded.usedAgain++;
        continue;
      }
      seen.add(unit.id);
      decisions.push({
        turn: turn.turnOrdinal,
        unitId: unit.id,
        ranges: [{ startLine: unit.span.lineRange.startLine,
          endLineInclusive: unit.span.lineRange.endLineInclusive }],
        wholeUnit: true,
        label: 'oracle',
        path: unit.path,
        byteLength: unit.byteLength,
      });
    }
  }
  return { decisions, excluded, boundaries };
}

/**
 * E6's S4 read, against a set frozen elsewhere: of the removed paths, how many
 * a later TURN names again. The oracle excludes such units by construction, so
 * its own rate is 0 and says so; the measured set's rate is the real reading.
 */
export function refetchedPaths(entries, plan) {
  const lastTurnOfPath = new Map();
  for (const turn of plan) {
    for (const node of turn.nodes) {
      if (node.kind !== 'tool' || !node.filePath) continue;
      lastTurnOfPath.set(normalizePath(node.filePath), turn.turnOrdinal);
    }
  }
  const paths = new Map();
  for (const entry of entries) {
    if (entry.path === null || entry.path === undefined) continue;
    const key = normalizePath(entry.path);
    const previous = paths.get(key);
    const last = lastTurnOfPath.get(key) ?? -1;
    paths.set(key, {
      path: key,
      decidedTurn: Math.min(previous?.decidedTurn ?? entry.turn, entry.turn),
      lastUseTurn: last,
      refetched: last > entry.turn,
    });
  }
  return [...paths.values()];
}

// ---------------------------------------------------------------------------
// Cells. Each carries its own label (design §5: labels per cell, not per row).

/**
 * One cell. Its id names the table, the ROW and the field, because rows repeat
 * field names (four lanes each print `fills`): an id of `table.field` would make
 * a Map collapse them, and a collapse is how a verification pass silently stops
 * checking four cells and checks one.
 */
function cell(table, row, id, label, value, text, invariant = null) {
  const slug = String(row).replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  return { id: `${table}.${slug}.${id}`, table, row, field: id, label, value, text, invariant };
}

const TABLE_TITLES = Object.freeze({
  R1: 'first fill',
  R2: 'the reverse at milestones',
  R3: 'whole-job totals',
  R4: 'bracket',
  E1: 'input-token integral over progress',
  E2: 'cache trajectory (T only, OBSERVED)',
  E3: 'first-fill position in the job',
  E4: 'horizon ratio',
  E5: 'sensitivity curve',
  E6: 'S1/S3 restated',
  E7: 'headroom to the trigger',
});

const PROGRESS_ALIGNED = Object.freeze(['R1', 'R2', 'E1', 'E3', 'E4', 'E5']);

/**
 * Score one stored session bundle into cells. Pure in its inputs: `--verify`
 * re-runs this function on the stored numbers, so a printed cell is one the
 * summary reproduces. `flipped` swaps in the flipped clock; nothing else changes.
 */
export function scoreSession(session, { flipped = false } = {}) {
  const clock = flipped ? session.clock.flip : session.clock;
  const requests = session.requests;
  const requestList = requests.turn.map((turn, i) => ({
    turn, inputTokens: requests.input[i], cacheReadInputTokens: requests.cache[i],
  }));
  const horizonProgress = clock.perTurn[requests.turn[requests.turn.length - 1]] ?? 0;
  const horizon = { progress: horizonProgress, index: requests.turn.length - 1 };
  const samplesOf = series => series.map((depth, i) => ({
    i, turn: requests.turn[i], depth,
  }));
  const laneOf = (name, lane) => laneReadings({
    lane: name, samples: samplesOf(lane.series), events: lane.events,
    requests: requestList, clock, threshold: session.threshold, horizon,
  });

  const lanes = {
    traditional: laneOf('traditional', session.lanes.traditional),
    selected: laneOf('racoons', session.lanes.selected),
    floor: laneOf('floor', session.lanes.floor),
    oracle: laneOf('oracle', session.lanes.oracle),
    wBranch: laneOf('w-branch', session.lanes.wBranch),
  };
  const swapped = session.swapped === true;
  const numerator = swapped ? lanes.traditional : lanes.selected;
  const denominator = swapped ? lanes.selected : lanes.traditional;
  const readings = readAll({
    traditional: denominator, racoons: numerator, clock, threshold: session.threshold,
    requests: requestList, horizon,
  });
  readings.horizonProgress = horizonProgress;

  // A bracket row: the set's own first loss against Traditional's, arm-aware.
  const laneView = (lane, bundle) => {
    const loss = lane.loss;
    const traditionalLoss = lanes.traditional.loss;
    const ownProgress = lane.firstLossProgress;
    const baseProgress = lanes.traditional.firstLossProgress;
    const numeratorCensored = swapped ? traditionalLoss === null : loss === null;
    const denominatorCensored = swapped ? loss === null : traditionalLoss === null;
    const ratio = numeratorCensored || denominatorCensored || ownProgress === null
      || baseProgress === null || ownProgress === 0 || baseProgress === 0
      ? null : (swapped ? baseProgress / ownProgress : ownProgress / baseProgress);
    return {
      loss, progress: ownProgress, numeratorCensored, denominatorCensored, ratio,
      denominatorProgress: baseProgress,
      denominatorLoss: lanes.traditional.loss,
      reached: bundle.events.length, total: session.lanes.traditional.events.length,
      deferred: bundle.events.reduce((total, event) => total + (event.deferred ?? 0), 0),
      observedIndices: bundle.events.map(event => event.observedIndex),
    };
  };
  const views = {
    floor: laneView(lanes.floor, session.lanes.floor),
    oracle: laneView(lanes.oracle, session.lanes.oracle),
    selected: laneView(lanes.selected, session.lanes.selected),
  };
  const fractionOf = entries => (session.totalBytes === 0 ? null
    : entries.reduce((total, entry) => total + (entry.byteLength ?? 0), 0) / session.totalBytes);
  const fractions = {
    floor: 0,
    oracle: fractionOf(session.lanes.oracle.decisions),
    selected: fractionOf(session.lanes.selected.decisions),
  };

  const cells = [
    ...tableR1({ traditional: denominator, horizonProgress,
      arm: swapped ? 'selected' : 'traditional' }),
    ...tableR2({ readings, crossingAt: percentileCrossing({ session, clock, readings }) }),
    ...tableR3({ readings, count: requestList.length }),
    ...tableR4({ views, fractions, selectedName: session.selectedName,
      traditionalIndices: session.lanes.traditional.events.map(event => event.observedIndex),
    }),
    ...tableE1({ readings }),
    ...tableE2({ session, clock }),
    ...tableE3({ readings }),
    ...tableE4({ readings, swapped, session }),
    ...tableE5({ views, fractions, session, lanes, swapped }),
    ...tableE6({ session, lanes, count: requestList.length }),
    ...tableE7({ lanes, requests, threshold: session.threshold }),
  ];
  return { cells, lanes, readings, views, fractions, clock, horizon, swapped };
}

/**
 * R2's cumulative-input percentile fallback (design §5: "Cumulative-input
 * percentiles are the fallback"). It fires when the threshold milestones do not
 * discriminate — every crossing lands at one progress, which happens when a
 * single turn's cumulative input already passes 4x the threshold.
 *
 * The percentile is taken over each lane's OWN cumulative depth, because the
 * observed `input_tokens` ledger is one number per request and identical in both
 * arms: using it would make the mirror vacuous. Each row is the design's mirror
 * — lane A crosses the percentile at progress p, and lane B's fullness at p is
 * reported beside it.
 */
function percentileCrossing({ session, clock }) {
  const samplesOf = series => series.map((depth, i) => ({
    i, turn: session.requests.turn[i], depth,
  }));
  const curves = {
    traditional: depthCurve(samplesOf(session.lanes.traditional.series), clock),
    racoons: depthCurve(samplesOf(session.lanes.selected.series), clock),
  };
  const cumulativeOf = series => {
    const out = [];
    let running = 0;
    for (const depth of series) { running += depth; out.push(running); }
    return out;
  };
  return percentile => {
    const rows = [];
    for (const [side, lane, other] of [['r-at-p', 'racoons', 'traditional'],
      ['t-at-p', 'traditional', 'racoons']]) {
      const series = session.lanes[lane === 'traditional' ? 'traditional' : 'selected'].series;
      const cumulative = cumulativeOf(series);
      const total = cumulative[cumulative.length - 1] ?? 0;
      if (total === 0) continue;
      const target = Math.round((percentile / 100) * total);
      const index = cumulative.findIndex(value => value >= target);
      if (index === -1) continue;
      const progress = clock.perTurn[session.requests.turn[index]] ?? 0;
      rows.push({
        side, target: cumulative[index], progress,
        own: interpolateAt(curves[lane], progress),
        other: interpolateAt(curves[other], progress),
      });
    }
    return rows;
  };
}

/** R1 — Traditional's first forced loss: progress (SIMULATED) and depth. */
function tableR1({ traditional, horizonProgress, arm }) {
  const row = `${arm} first forced loss`;
  const loss = traditional.loss;
  if (loss === null) {
    return [
      cell('R1', row, 'censored', OBSERVED, true, 'right-censored at the horizon'),
      cell('R1', row, 'horizon', SIMULATED, horizonProgress, `horizon=${horizonProgress}`),
    ];
  }
  return [
    cell('R1', row, 'progress', SIMULATED, traditional.firstLossProgress,
      `progress=${traditional.firstLossProgress}`),
    cell('R1', row, 'fillIndex', OBSERVED, loss.index, `fillIndex=${loss.index}`),
    cell('R1', row, 'depth', BYTES, loss.pre, `depth=${loss.pre}`),
    cell('R1', row, 'observedPre', OBSERVED, loss.observedPre ?? null,
      `observedPre=${int(loss.observedPre)}`),
    cell('R1', row, 'overshoot', COMPOUND, loss.trigger === null || loss.trigger === undefined
      ? null : loss.pre / loss.trigger,
    `pre/trigger=${fixed(loss.trigger === null || loss.trigger === undefined ? null
      : loss.pre / loss.trigger, 2)}`),
    cell('R1', row, 'horizon', SIMULATED, horizonProgress, `horizon=${horizonProgress}`),
  ];
}

/**
 * R2 — the reverse at milestones: each lane at its own crossing, the other lane's
 * fullness at that progress, plus the mirror (chunk 4's `milestoneRows`).
 *
 * The design names a fallback: "Cumulative-input percentiles are the fallback."
 * It fires when the milestones do not discriminate — every crossing lands at the
 * same progress, which happens when one turn's cumulative input already passes
 * 4x the threshold. Then the same comparison runs at the 25th/50th/75th/90th
 * percentile of Traditional's cumulative-input series, which is monotone, so
 * each percentile names one request. `discriminates=false` prints with the
 * fallback rows, never as a silent absence.
 */
function tableR2({ readings, crossingAt }) {
  if (readings.R2.length === 0) {
    return [cell('R2', 'milestones', 'absent', OBSERVED, null,
      'absent (no observed threshold on this record)')];
  }
  const cells = [];
  const progresses = new Set(readings.R2.map(row => `${row.side}:${row.progress}`));
  const discriminates = progresses.size > 2;
  cells.push(cell('R2', 'milestones', 'discriminates', SIMULATED, discriminates,
    `discriminates=${discriminates}`
    + `${discriminates ? '' : ' (every milestone crosses at one progress; the percentile fallback runs)'}`));
  for (const row of readings.R2) {
    const key = `${row.target}${row.side === 'r-at-r' ? 'R' : 'T'}`;
    cells.push(cell('R2', key, 'cumulative', OBSERVED, row.target,
      `cumulative=${row.target}`));
    cells.push(cell('R2', key, 'progress', SIMULATED, row.progress,
      row.progress === null ? 'beyond the lane horizon' : `progress=${row.progress}`));
    cells.push(cell('R2', key, 'own', COMPOUND, row.own, `own=${int(row.own)}`));
    cells.push(cell('R2', key, 'other', COMPOUND, row.other, `other=${int(row.other)}`));
  }
  if (!discriminates) {
    for (const percentile of [25, 50, 75, 90]) {
      for (const row of crossingAt(percentile)) {
        const key = `p${percentile}${row.side === 'r-at-p' ? 'R' : 'T'}`;
        cells.push(cell('R2', key, 'target', COMPOUND, row.target,
          `cumulative=${row.target} (p${percentile} of that lane's own cumulative input)`));
        cells.push(cell('R2', key, 'progress', SIMULATED, row.progress,
          `progress=${row.progress}`));
        cells.push(cell('R2', key, 'own', COMPOUND, row.own, `own=${int(row.own)}`));
        cells.push(cell('R2', key, 'other', COMPOUND, row.other,
          `other=${int(row.other)}`));
      }
    }
  }
  return cells;
}

/** R3 — whole-job totals. No progress term: the flip must leave these identical. */
function tableR3({ readings, count }) {
  const row = 'whole-job totals';
  return [
    cell('R3', row, 'fillsT', SIMULATED, readings.R3.fills.traditional,
      `fills.traditional=${readings.R3.fills.traditional}`),
    cell('R3', row, 'fillsR', SIMULATED, readings.R3.fills.racoons,
      `fills.racoons=${readings.R3.fills.racoons}`),
    cell('R3', row, 'sumInput', OBSERVED, readings.R3.sumInput,
      `sumInput=${readings.R3.sumInput}`),
    cell('R3', row, 'cacheHit', OBSERVED, readings.R3.cacheHit,
      `cacheHit=${pct(readings.R3.cacheHit)} (T only)`),
    cell('R3', row, 'requests', OBSERVED, count, `requests=${count}`),
  ];
}

/**
 * R4 — the bracket: the floor, the right-censored ceiling, and the measured
 * point. Each row reports the reading the design asks for (the first fill) AND
 * the deferral evidence, because on a record whose first fill lands inside the
 * first turn every set reaches it: the first loss cannot separate the arms, and
 * printing only that row would report a bracket that cannot open.
 */
function tableR4({ views, fractions, selectedName, traditionalIndices }) {
  const cells = [];
  // When the measured point IS the ceiling (`--removals oracle`) or the floor
  // (`--removals none`), the bracket has two rows, not three: printing the same
  // set twice would read as two independent readings of one number.
  const sameShape = (left, right) => left.observedIndices.length === right.observedIndices.length
    && left.observedIndices.every((value, i) => value === right.observedIndices[i])
    && left.deferred === right.deferred;
  const pointDuplicates = sameShape(views.selected, views.oracle) ? 'ceiling'
    : sameShape(views.selected, views.floor) ? 'floor' : null;
  for (const [key, view] of [['floor', views.floor], ['ceiling', views.oracle],
    ['point', views.selected]]) {
    if (key === 'point' && pointDuplicates !== null) continue;
    const name = key === 'floor' ? 'empty set (floor)' : key === 'ceiling'
      ? 'oracle set (ceiling)' : `${selectedName ?? 'selected set'} (point)`;
    const fraction = fractions[key === 'ceiling' ? 'oracle' : key === 'point' ? 'selected' : 'floor'];
    const last = view.observedIndices.length === 0 ? null
      : view.observedIndices[view.observedIndices.length - 1];
    const observedLast = traditionalIndices[traditionalIndices.length - 1] ?? null;
    cells.push(cell('R4', name, 'fraction', SIMULATED, fraction,
      `removalFraction=${fixed(fraction, 4)}`));
    cells.push(cell('R4', name, 'firstLoss', OBSERVED,
      view.loss === null ? null : view.loss.index,
      `firstLossFillIndex=${view.loss === null ? 'none' : view.loss.index}`));
    cells.push(cell('R4', name, 'progressR', SIMULATED,
      view.numeratorCensored ? null : view.progress,
      view.numeratorCensored ? 'R: >= horizon' : `R progress=${int(view.progress)}`));
    cells.push(cell('R4', name, 'progressT', SIMULATED, view.denominatorCensored ? null
      : view.denominatorProgress,
    view.denominatorCensored ? 'T: >= horizon'
      : `T progress=${int(view.denominatorProgress)}`));
    cells.push(cell('R4', name, 'ratio', SIMULATED, view.numeratorCensored ? null : view.ratio,
      view.numeratorCensored ? '>= horizon'
        : view.ratio === null ? 'n/a' : `ratio=${fixed(view.ratio, 3)}`));
    cells.push(cell('R4', name, 'fillsReached', SIMULATED, view.reached,
      `fillsReached=${view.reached}/${view.total}`
      + `${view.reached < view.total ? ' (the rest are right-censored at the horizon)' : ''}`));
    cells.push(cell('R4', name, 'deferral', SIMULATED, view.deferred,
      `deferral=${view.deferred} requests (the summed lag of every fill this set re-earned)`));
    cells.push(cell('R4', name, 'lastFill', SIMULATED, last,
      `lastFillIndex=${int(last)} (the record's own last fill: ${int(observedLast)})`));
  }
  return cells;
}

/** E1 — the input-token integral over progress: the cost of one unit of work. */
function tableE1({ readings }) {
  const row = 'area under depth-vs-progress';
  return [
    cell('E1', row, 'tArea', COMPOUND, readings.E1.traditional.area,
      `traditional.area=${readings.E1.traditional.area}`),
    cell('E1', row, 'tPer100', COMPOUND, readings.E1.traditional.per100,
      `traditional.per100=${int(readings.E1.traditional.per100)}`),
    cell('E1', row, 'rArea', COMPOUND, readings.E1.racoons.area,
      `racoons.area=${readings.E1.racoons.area}`),
    cell('E1', row, 'rPer100', COMPOUND, readings.E1.racoons.per100,
      `racoons.per100=${int(readings.E1.racoons.per100)}`),
  ];
}

/**
 * E2 — the cache trajectory, Traditional only, OBSERVED: hit rate at each turn
 * end and the drop at each fill. The Racoons lane's cache is NOT modelled: the
 * simulation has no provider and no host cache law, so no counterfactual
 * generator exists and an estimate would be a fabricated number.
 */
function tableE2({ session, clock }) {
  const requests = session.requests;
  const cells = [];
  const turns = [...new Set(requests.turn)];
  for (const turn of turns) {
    const indices = requests.turn.flatMap((value, i) => (value === turn ? [i] : []));
    const input = sum(indices.map(i => requests.input[i]));
    const cache = sum(indices.map(i => requests.cache[i]));
    cells.push(cell('E2', `turn t${turn}`, 'hitRate', OBSERVED,
      input === 0 ? null : cache / input,
      `progress=${clock.perTurn[turn]} hitRate=${pct(input === 0 ? null : cache / input)}`
      + ` cacheRead=${cache}/${input}`));
  }
  const rateAt = i => {
    const input = requests.input[i] ?? 0;
    return input === 0 ? null : (requests.cache[i] ?? 0) / input;
  };
  for (const event of session.lanes.traditional.events) {
    const before = event.index === 0 ? null : requests.input[event.index - 1];
    const after = requests.input[event.index] ?? null;
    const rateBefore = event.index === 0 ? null : rateAt(event.index - 1);
    const rateAfter = rateAt(event.index);
    cells.push(cell('E2', `fill ${event.observedIndex}`, 'hitRateDrop', OBSERVED,
      rateBefore === null || rateAfter === null ? null : rateAfter - rateBefore,
      `fillIndex=${event.observedIndex} hitRate ${pct(rateBefore)} -> ${pct(rateAfter)}`
      + ` (drop ${pct1(rateBefore === null || rateAfter === null ? null
        : (rateBefore - rateAfter) * 100)})`));
    cells.push(cell('E2', `fill ${event.observedIndex}`, 'inputDrop', OBSERVED,
      before === null || after === null ? null : before - after,
      `input ${int(before)} -> ${int(after)} (drop ${int(before === null || after === null
        ? null : before - after)})`));
  }
  return cells;
}

/** E3 — where the first fill sits in the job, not only how deep it was. */
function tableE3({ readings }) {
  const row = 'first fill in the job';
  if (readings.E3 === null) {
    return [cell('E3', row, 'censored', OBSERVED, true, 'censored (no fill inside the horizon)')];
  }
  return [
    cell('E3', row, 'progress', SIMULATED, readings.E3.progress,
      `progress=${readings.E3.progress}`),
    cell('E3', row, 'progressPercentile', SIMULATED, readings.E3.progressPercentile,
      `p1Percentile=${pct1(readings.E3.progressPercentile)}`),
    cell('E3', row, 'requestPercentile', SIMULATED, readings.E3.requestPercentile,
      `requestPercentile=${pct1(readings.E3.requestPercentile)}`),
    cell('E3', row, 'depth', BYTES, readings.E3.depth, `depth=${readings.E3.depth}`),
    cell('E3', row, 'horizon', SIMULATED, readings.horizonProgress,
      `horizon=${readings.horizonProgress}`),
  ];
}

/** E4 — the horizon ratio: the selected lane's first fill over Traditional's. */
function tableE4({ readings, session }) {
  const row = 'horizon ratio';
  const censored = readings.E4.censored;
  const cells = [
    cell('E4', row, 'r', SIMULATED, readings.E4.r, `numerator=${int(readings.E4.r)}`),
    cell('E4', row, 't', SIMULATED, readings.E4.t, `denominator=${int(readings.E4.t)}`),
    cell('E4', row, 'ratio', SIMULATED, censored ? null : readings.E4.ratio,
      censored ? `>= horizon (denominator=${int(readings.E4.t)})`
        : `ratio=${fixed(readings.E4.ratio, 3)}`),
    cell('E4', row, 'horizon', SIMULATED, readings.horizonProgress,
      `horizon=${readings.horizonProgress}`),
  ];
  if (session.armsByteEqual) {
    cells.push(cell('E4', row, 'invariance', SIMULATED, 'ratio-invariant',
      'ratio-invariant: arms-byte-equal', 'arms-byte-equal'));
  }
  return cells;
}

/** E5 — the sensitivity points by removal fraction, plus the W-branch latch row. */
function tableE5({ views, fractions, session, lanes }) {
  const points = [];
  const add = (key, fraction) => {
    const view = views[key];
    if (fraction === null) return;
    const entry = {
      fraction, ratio: view.numeratorCensored ? null : view.ratio,
      censored: view.numeratorCensored,
      r: view.numeratorCensored ? null : view.progress,
      t: view.denominatorCensored ? null : view.denominatorProgress,
    };
    if (points.some(point => point.fractionKey === fraction.toFixed(6))) return;
    entry.fractionKey = fraction.toFixed(6);
    points.push(entry);
  };
  add('floor', 0);
  add('selected', fractions.selected);
  add('oracle', fractions.oracle);
  points.sort((a, b) => a.fraction - b.fraction);

  const cells = [];
  for (const point of points) {
    const key = `fraction ${fixed(point.fraction, 4)}`;
    cells.push(cell('E5', key, 'fraction', SIMULATED, point.fraction,
      `removalFraction=${fixed(point.fraction, 4)}`));
    cells.push(cell('E5', key, 'own', SIMULATED, point.r,
      point.censored ? 'own=>= horizon' : `own=${int(point.r)}`));
    cells.push(cell('E5', key, 'other', SIMULATED, point.t,
      `traditional=${int(point.t)}`));
    cells.push(cell('E5', key, 'ratio', SIMULATED, point.ratio,
      point.censored ? '>= horizon' : `ratio=${fixed(point.ratio, 3)}`));
    if (point.fraction === 0 && session.armsByteEqual) {
      cells.push(cell('E5', key, 'invariance', SIMULATED, 'ratio-invariant',
        'ratio-invariant: arms-byte-equal', 'arms-byte-equal'));
    }
  }

  // The W-branch latch-timing row (§3): at W' the latch sits above the observed
  // threshold, so the native fill fires first, R never prunes before it, and the
  // ratio collapses toward 1.00. The row WALKS that model: the wBranch lane
  // carries only the decisions the W' latch admits.
  const width = session.threshold === null ? null
    : session.threshold + W_BRANCH.outputReservation + W_BRANCH.harnessHeadroom;
  const latch = width === null ? null : Math.round(width / 2);
  const firstFillTurn = session.lanes.traditional.events[0]?.turn ?? null;
  const suppressed = firstFillTurn === null ? 0
    : session.lanes.selected.decisions.filter(entry => entry.turn <= firstFillTurn).length;
  const wLoss = lanes.wBranch.loss;
  const tLoss = lanes.traditional.loss;
  const wCensored = wLoss === null;
  const wRatio = wCensored || tLoss === null || lanes.traditional.firstLossProgress === 0
    ? null : lanes.wBranch.firstLossProgress / lanes.traditional.firstLossProgress;
  const row = 'W-branch latch timing';
  cells.push(cell('E5', row, 'width', OBSERVED, width,
    `Wprime=${int(width)} (T+O+B, O=${W_BRANCH.outputReservation}`
    + ` B=${W_BRANCH.harnessHeadroom})`));
  cells.push(cell('E5', row, 'latch', OBSERVED, latch,
    `latch=${int(latch)} aboveTrigger=${latch === null ? 'n/a' : latch > session.threshold}`));
  cells.push(cell('E5', row, 'suppressed', OBSERVED, suppressed,
    `decisionsBeforeFirstFill=${suppressed} of ${session.lanes.selected.decisions.length}`
    + ' never apply under Wprime'));
  cells.push(cell('E5', row, 'ratio', SIMULATED, wCensored ? null : wRatio,
    wCensored ? `>= horizon (denominator=${int(tLoss === null ? null
      : lanes.traditional.firstLossProgress)})` : `ratio=${fixed(wRatio, 3)}`));
  cells.push(cell('E5', row, 't', SIMULATED,
    tLoss === null ? null : lanes.traditional.firstLossProgress,
    `denominator=${int(tLoss === null ? null : lanes.traditional.firstLossProgress)}`));
  return cells;
}

/** E6 — S1/S3 restated per lane, with S4's re-fetch rate of a removed path. */
function tableE6({ session, lanes, count }) {
  const cells = [];
  for (const [name, lane] of [['traditional', lanes.traditional],
    ['floor', lanes.floor], ['point', lanes.selected], ['oracle', lanes.oracle]]) {
    cells.push(cell('E6', name, 'fills', SIMULATED, lane.fills, `fills=${lane.fills}`));
    cells.push(cell('E6', name, 'zeroFill', SIMULATED, lane.fills === 0 ? 1 : 0,
      `zeroFillShare=${lane.fills === 0 ? '100.00%' : '0.00%'} (one session)`));
  }
  const removed = session.refetches.filter(entry => entry.path !== null);
  const again = removed.filter(entry => entry.refetched).length;
  cells.push(cell('E6', 'S4 re-fetch', 'rate', OBSERVED,
    removed.length === 0 ? null : again / removed.length,
    removed.length === 0
      ? `re-fetchRate=n/a (no removed path in ${session.selectedName ?? 'the selected set'})`
      : `re-fetchRate=${pct(again / removed.length)} (${again}/${removed.length} removed paths;`
        + ' OBSERVED later use against a SIMULATED set)'));
  cells.push(cell('E6', 'session length', 'requests', OBSERVED, count,
    `requests=${count} (long session)`));
  return cells;
}

/** E7 — the headroom to the trigger at each turn end, per lane, as a distribution. */
function tableE7({ lanes, requests, threshold }) {
  if (threshold === null) {
    return [cell('E7', 'headroom', 'absent', OBSERVED, null,
      'absent (no observed threshold on this record)')];
  }
  const cells = [];
  for (const [name, lane] of [['traditional', lanes.traditional], ['racoons', lanes.selected],
    ['oracle', lanes.oracle]]) {
    const headroom = [];
    for (let i = 0; i < requests.turn.length; i++) {
      const next = requests.turn[i + 1];
      if (next !== undefined && next === requests.turn[i]) continue;
      headroom.push(threshold - lane.samples[i].depth);
    }
    const above = headroom.filter(value => value <= 0).length;
    cells.push(cell('E7', name, 'min', COMPOUND, Math.min(...headroom),
      `min=${Math.min(...headroom)}`));
    cells.push(cell('E7', name, 'median', COMPOUND, round(median(headroom)),
      `median=${round(median(headroom))}`));
    cells.push(cell('E7', name, 'max', COMPOUND, Math.max(...headroom),
      `max=${Math.max(...headroom)}`));
    cells.push(cell('E7', name, 'above', COMPOUND, above,
      `atOrAboveTrigger=${above} of ${headroom.length} turn ends`));
  }
  return cells;
}

// ---------------------------------------------------------------------------
// The aggregate rule.

/**
 * The headline: the median of per-session horizon ratios over non-censored
 * sessions, with the censored count beside it. Never a ratio of sums.
 *
 * Right-censoring (a lane that never fills) and an UNDEFINED ratio (a ratio of
 * 0 by 0: both arms' first fill lands at progress 0, the session's first turn)
 * are different states, and the count says which. Both are excluded from the
 * median; neither is a zero and neither is a win. `nonCensored` is the n the
 * median was taken over, so a table can never print a median over a larger set
 * than the one it measured.
 */
export function aggregateOf(rows) {
  const ratios = rows.filter(row => !row.censored && row.horizonRatio !== null)
    .map(row => row.horizonRatio);
  const undefinedRatio = rows.filter(row => !row.censored && row.horizonRatio === null).length;
  return {
    sessions: rows.length,
    nonCensored: ratios.length,
    censored: rows.filter(row => row.censored).length,
    undefinedRatio,
    ratio: median(ratios),
    rule: 'median of per-session horizon ratios over non-censored sessions;'
      + ' censored sessions (a lane that never fills) and undefined-ratio sessions'
      + ' (both arms fill at progress 0) are excluded from the median and counted;'
      + ' never a ratio of sums',
  };
}

// ---------------------------------------------------------------------------
// Building a session bundle from a record.

function loadRecord(recordDir) {
  const manifestPath = join(recordDir, 'manifest.json');
  const turnsPath = join(recordDir, 'turns.jsonl');
  if (!existsSync(manifestPath) || !existsSync(turnsPath)) {
    throw new Error(`record not found: ${recordDir} (needs manifest.json and turns.jsonl)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = readFileSync(turnsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (plan.length === 0) throw new Error(`record has no turns: ${recordDir}`);
  return { manifest, plan, sessionId: manifest.session?.id ?? 'unknown-session' };
}

/**
 * A frozen set file: a chunk-5 `removal.json` (its `accepted` array, which is
 * already validated through the shipped planner) or a `{decisions: [...]}` set.
 */
export function readFrozenSet(path) {
  const absolute = resolve(REPO_ROOT, path);
  if (!existsSync(absolute)) throw new Error(`set-absent: ${absolute} does not exist`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`set-unreadable: ${absolute}: ${error.message}`);
  }
  const source = parsed.source ?? parsed.set?.source ?? 'frozen';
  // A set minted in this process cannot be a verdict (design §8). The set file
  // says where it came from; "this run" is refused by name, never scored.
  if (source === 'this-run') {
    throw new Error('set-not-frozen: the set names this run as its source; a verdict needs a set'
      + ' frozen in an earlier run');
  }
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions
    : Array.isArray(parsed.accepted) ? parsed.accepted : null;
  if (decisions === null) {
    throw new Error(`set-invalid: ${absolute} carries neither a decisions nor an accepted array`);
  }
  return {
    path: absolute,
    source,
    decisions: decisions.map(entry => ({
      turn: entry.turn, unitId: entry.unitId, ranges: entry.ranges ?? [],
      wholeUnit: entry.wholeUnit ?? true, label: entry.label ?? null,
      path: entry.path ?? null, byteLength: entry.byteLength ?? 0,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    })),
    // How many decisions name a session at all. A set with NONE is the
    // single-session shape chunk 5 has always emitted and is applied whole; a
    // set with ANY is a multi-session corpus set and is scoped per record, so a
    // decision taken on one session cannot move another session's depth.
    scoped: decisions.some(entry => typeof entry.sessionId === 'string'),
    // The producer's per-session compatibility census, when it carries one
    // (chunk 7's `verdicts.json` does). Carried through untouched: this module
    // scores the set's OWN sessions and never extrapolates to the censored ones.
    census: parsed.census ?? null,
    refused: Array.isArray(parsed.refused) ? parsed.refused.length : null,
  };
}

/**
 * One record to one stored bundle. The bundle holds exactly the numbers the
 * cells derive from, so `--verify` reproduces them without the record, the arms
 * or the store.
 */
export function buildSession({ recordDir, opts, coordinateName }) {
  const { manifest, plan, sessionId } = loadRecord(recordDir);
  const requests = flattenRequests(plan);
  if (requests.length === 0) throw new Error(`record has no requests: ${recordDir}`);
  const { mapped } = mapFills(requests, flatten(plan).fills);
  const pristine = pristineSeries(requests, mapped);
  const threshold = Number.isSafeInteger(manifest.pinned?.threshold) ? manifest.pinned.threshold : null;
  const width = threshold === null ? null : Math.round(threshold / W_RATIO);

  const events = forcedLossEvents(requests, mapped);
  const traditionalWalk = walkTraditional({ requests, pristine, events });
  // The trigger is the Traditional lane's own depth just before each fill
  // lands — the depth the Racoons lane must reach again for the same event.
  for (const [i, event] of events.entries()) event.trigger = traditionalWalk.events[i].trigger;
  const traditional = {
    series: traditionalWalk.series,
    events: traditionalWalk.events,
    decisions: [],
  };

  const walkSet = entries => walkBracket({
    requests, pristine, events, decisions: decisionsOf(entries),
    unitMeta: unitCatalogue(entries), receiptTokensOf,
  });
  const floorWalk = walkSet([]);
  if (!floorWalk.series.every((depth, i) => depth === traditional.series[i])) {
    throw new Error('floor-not-byte-equal: the empty set must reproduce the Traditional lane'
      + ' exactly; the bracket walk and the replay walk have diverged');
  }
  const oracle = buildOracle({ plan, sessionId });
  const oracleWalk = walkSet(oracle.decisions);

  let selectedEntries = [];
  let selectedName = 'empty set (floor)';
  let selectedScope = null;
  let selectedCensus = null;
  if (opts.removals === 'oracle') {
    selectedEntries = oracle.decisions;
    selectedName = 'oracle set';
  } else if (opts.removals !== 'none') {
    const frozen = readFrozenSet(opts.removals);
    selectedCensus = frozen.census;
    if (frozen.scoped) {
      // A corpus set: keep only this record's own decisions and NAME the drop.
      // Without this, a unit minted on session A would be deducted from session
      // B's depth at A's turn ordinal — a removal the record never made.
      const own = frozen.decisions.filter(entry => entry.sessionId === sessionId);
      const foreign = frozen.decisions.filter(entry => entry.sessionId !== sessionId);
      selectedEntries = own;
      selectedScope = {
        source: frozen.path, own: own.length, foreign: foreign.length,
        foreignSessions: [...new Set(foreign.map(entry => entry.sessionId ?? 'unscoped'))].sort(),
      };
    } else {
      selectedEntries = frozen.decisions;
    }
    selectedName = opts.setLabel ?? `frozen set (${frozen.source})`;
  }
  const selectedWalk = walkSet(selectedEntries);
  if (selectedEntries.length === 0
    && !selectedWalk.series.every((depth, i) => depth === traditional.series[i])) {
    throw new Error('floor-not-byte-equal: an empty selected set diverged from the Traditional lane');
  }

  // The W-branch lane: only the decisions the W' latch can admit, i.e. those
  // made after the first recorded fill (the native fill fires first there).
  const firstFillTurn = traditional.events[0]?.turn ?? null;
  const wEntries = firstFillTurn === null ? selectedEntries
    : selectedEntries.filter(entry => entry.turn > firstFillTurn);
  const wWalk = wEntries.length === selectedEntries.length ? selectedWalk : walkSet(wEntries);

  const totalBytes = plan.flatMap(turn => turn.nodes)
    .filter(node => node.kind === 'tool').reduce((total, node) => total + node.bytes, 0);

  // ---- the clock --------------------------------------------------------
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
      p2Absent = `the store holds no completed TodoWrite snapshot for ${sessionId}`;
      p2 = null;
    }
  }
  if (coordinateName === 'p2' && p2 === null) {
    throw new Error(`p2-unavailable: ${p2Absent}; P2 needs a session with TodoWrite history`
      + ' (the record carries no todo bodies)');
  }
  const values = coordinateName === 'p2' ? p2.values : p1.values;
  const baselineClock = clockOf(values);
  if (opts.flip && baselineClock.knots <= 1) {
    throw new Error(`progress-clock-flat: the ${coordinateName} coordinate has`
      + ` ${baselineClock.knots} knot(s) in ${sessionId}; the flip would test nothing`);
  }
  const flipped = opts.flip ? flipClock(baselineClock) : baselineClock;

  return {
    session: sessionId,
    record: recordDir,
    digest: manifest.snapshot?.digest ?? null,
    coordinate: coordinateName,
    threshold,
    thresholdSource: manifest.pinned?.thresholdSource ?? 'observed-fill',
    width,
    latch: width === null ? null : Math.round(width / 2),
    clock: {
      perTurn: baselineClock.perTurn, distinct: baselineClock.distinct,
      knots: baselineClock.knots,
      flip: { perTurn: flipped.perTurn, distinct: flipped.distinct, knots: flipped.knots },
    },
    requests: {
      turn: requests.map(request => request.turn),
      input: requests.map(request => request.inputTokens ?? 0),
      cache: requests.map(request => request.cacheReadInputTokens ?? 0),
    },
    totalBytes,
    lanes: {
      traditional,
      floor: { series: floorWalk.series, events: floorWalk.events, decisions: [] },
      oracle: { series: oracleWalk.series, events: oracleWalk.events,
        decisions: oracle.decisions },
      selected: { series: selectedWalk.series, events: selectedWalk.events,
        decisions: selectedEntries },
      wBranch: { series: wWalk.series, events: wWalk.events, decisions: wEntries },
    },
    refetches: refetchedPaths(selectedEntries, plan),
    removed: {
      oracle: oracle.excluded,
      oracleDecisions: oracle.decisions.length,
      selectedDecisions: selectedEntries.length,
      reached: selectedWalk.unreached,
      boundaries: oracle.boundaries,
    },
    p2Absent,
    selectedName,
    selectedScope,
    selectedCensus,
    armsByteEqual: selectedWalk.series.every((depth, i) => depth === traditional.series[i]),
    swapped: opts.swap === true,
  };
}

// ---------------------------------------------------------------------------
// Verification.

/** Re-derive every cell and the aggregate from a stored summary. */
export function verifySummary(summary) {
  const failures = [];
  let cells = 0;
  for (const session of summary.sessions) {
    const base = scoreSession(session);
    const flipped = scoreSession(session, { flipped: true });
    const stored = new Map(session.cells.map(entry => [entry.id, entry]));
    for (const derived of base.cells) {
      cells++;
      const kept = stored.get(derived.id);
      if (kept === undefined) {
        failures.push({ scope: session.session, id: derived.id, kind: 'missing',
          stored: null, derived: `${derived.text} [${derived.label}]` });
      } else if (kept.text !== derived.text || kept.label !== derived.label) {
        failures.push({ scope: session.session, id: derived.id, kind: 'drift',
          stored: `${kept.text} [${kept.label}]`,
          derived: `${derived.text} [${derived.label}]` });
      }
    }
    for (const id of stored.keys()) {
      if (!base.cells.some(entry => entry.id === id)) {
        failures.push({ scope: session.session, id, kind: 'extra', stored: id, derived: null });
      }
    }
    const storedFlip = new Map(session.flip.cells.map(entry => [entry.id, entry]));
    for (const derived of flipped.cells) {
      cells++;
      const kept = storedFlip.get(derived.id);
      if (kept === undefined) {
        failures.push({ scope: `${session.session} (flip)`, id: derived.id, kind: 'missing',
          stored: null, derived: derived.text });
      } else if (kept.text !== derived.text) {
        failures.push({ scope: `${session.session} (flip)`, id: derived.id, kind: 'drift',
          stored: kept.text, derived: derived.text });
      }
    }
  }
  const derivedAggregate = aggregateOf(summary.sessions.map(session => ({
    censored: session.censored, horizonRatio: session.horizonRatio,
  })));
  const keptAggregate = summary.aggregate;
  if (derivedAggregate.ratio !== keptAggregate.ratio
    || derivedAggregate.censored !== keptAggregate.censored
    || derivedAggregate.sessions !== keptAggregate.sessions
    || derivedAggregate.undefinedRatio !== (keptAggregate.undefinedRatio ?? 0)) {
    failures.push({ scope: 'aggregate', id: 'median', kind: 'drift',
      stored: `ratio=${keptAggregate.ratio} censored=${keptAggregate.censored}`
        + ` sessions=${keptAggregate.sessions}`
        + ` undefinedRatio=${keptAggregate.undefinedRatio ?? 0}`,
      derived: `ratio=${derivedAggregate.ratio} censored=${derivedAggregate.censored}`
        + ` sessions=${derivedAggregate.sessions}`
        + ` undefinedRatio=${derivedAggregate.undefinedRatio}` });
  }
  return { cells, failures, derivedAggregate };
}

// ---------------------------------------------------------------------------
// Rendering. One function, so stdout and SUMMARY.md cannot disagree.

function renderCell(entry) {
  return `${entry.text} [${entry.label}]`;
}

/** One table as printed: its title, then one line per cell grouped by row. */
export function renderTables(cells) {
  const lines = [];
  let table = null;
  for (const entry of cells) {
    if (entry.table !== table) {
      table = entry.table;
      lines.push(`  ${entry.table} ${TABLE_TITLES[entry.table] ?? ''}`);
    }
    lines.push(`    ${entry.row} | ${renderCell(entry)}`);
  }
  return lines;
}

/** The flip's per-table movement, as the gate reads it. */
function flipMovement(baseCells, flipCells) {
  const base = new Map(baseCells.map(entry => [entry.id, entry]));
  const flipped = new Map(flipCells.map(entry => [entry.id, entry]));
  const rows = [];
  for (const table of ['R1', 'R2', 'R3', 'E1', 'E3', 'E4', 'E5', 'E6', 'E7']) {
    const entries = baseCells.filter(entry => entry.table === table);
    const moved = entries.filter(entry => flipped.get(entry.id)?.text !== entry.text);
    const invariant = entries.filter(entry => entry.invariant !== null);
    rows.push({ table, total: entries.length, moved: moved.length, invariant });
  }
  return rows;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.verify !== null) {
    const path = resolve(REPO_ROOT, opts.verify);
    if (!existsSync(path)) throw new Error(`summary-absent: ${path} does not exist`);
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    if (summary.schema !== SCHEMA) {
      throw new Error(`summary-schema: ${path} carries ${summary.schema}, expected ${SCHEMA}`);
    }
    const report = verifySummary(summary);
    const lines = [
      'verify',
      `  summary      ${path}`,
      `  sessions     ${summary.sessions.length}`,
      `  cells        ${report.cells} re-derived from summary.json`,
      `  aggregate    ratio=${fixed(report.derivedAggregate.ratio, 3)}`
        + ` nonCensored=${report.derivedAggregate.nonCensored}`
        + ` censored=${report.derivedAggregate.censored}`,
      `  gate         ${report.failures.length === 0 ? 'ok' : 'FAIL'}`,
    ];
    for (const failure of report.failures.slice(0, 40)) {
      lines.push(`    ${failure.kind} ${failure.scope} ${failure.id}:`
        + ` stored=${failure.stored} derived=${failure.derived}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (report.failures.length > 0) {
      const first = report.failures[0];
      process.stderr.write(`verify-cell-${first.kind}: ${first.scope} ${first.id}`
        + ` stored "${first.stored}" re-derived "${first.derived}"\n`);
      process.exitCode = 1;
    }
    return;
  }

  const sessions = [];
  for (const record of opts.records) {
    sessions.push(buildSession({
      recordDir: resolve(REPO_ROOT, record), opts, coordinateName: opts.coordinate,
    }));
  }

  // ---- scores, baseline and flip -----------------------------------------
  for (const session of sessions) {
    const base = scoreSession(session);
    session.cells = base.cells;
    session.floorRatio = base.views.floor.numeratorCensored ? null : base.views.floor.ratio;
    session.horizonRatio = base.views.selected.numeratorCensored
      ? null : base.views.selected.ratio;
    session.censored = base.views.selected.numeratorCensored;
    session.undefinedRatio = !session.censored && session.horizonRatio === null;
    session.oracleCensored = base.views.oracle.numeratorCensored;
    session.flip = { cells: scoreSession(session, { flipped: true }).cells };
  }

  // ---- the gates ---------------------------------------------------------
  const problems = [];
  const report = (code, detail) => problems.push({ code, detail });
  for (const session of sessions) {
    // The floor gate detects "the R lane moved depth with no removals". A ratio
    // that is UNDEFINED (0 by 0: both arms' first fill at progress 0) cannot
    // detect that, so it is not a pass and not a failure of THIS gate: the
    // series equality below is the real check, and the undefined ratio is
    // counted in the aggregate instead. Without that split, a session whose
    // first fill lands in turn 0 would either fail a gate it never tested or
    // vanish from the n.
    if (session.floorRatio !== null && session.floorRatio !== 1) {
      report('floor-not-one', `${session.session}: the empty set scored`
        + ` ${fixed(session.floorRatio, 6)}, must be exactly 1.00 — the R lane moved depth`
        + ' with no removals');
    }
    if (!session.armsByteEqual && session.lanes.selected.decisions.length === 0) {
      report('floor-not-byte-equal', `${session.session}: an empty set has differing arms`);
    }
    if (opts.flip) {
      const movement = flipMovement(session.cells, session.flip.cells);
      for (const row of movement) {
        if (row.table === 'R3') {
          if (row.moved > 0) {
            report('r3-moved', `${session.session}: the flip changed ${row.moved} whole-job`
              + ' cell(s); R3 has no progress term, so this is a scoping bug');
          }
          continue;
        }
        if (PROGRESS_ALIGNED.includes(row.table) && row.moved === 0
          && row.invariant.length !== row.total) {
          report('flip-progress-vacuous', `${session.session}: ${row.table} survived the flip;`
            + ' the interpolator is not reading the coordinate');
        }
      }
    }
  }

  // ---- the swap control --------------------------------------------------
  let swapReport = null;
  if (opts.swap) {
    swapReport = sessions.map(session => {
      const base = scoreSession({ ...session, swapped: false });
      const swapped = scoreSession({ ...session, swapped: true });
      const before = base.views.selected.numeratorCensored ? null : base.views.selected.ratio;
      const after = swapped.views.selected.numeratorCensored ? null : swapped.views.selected.ratio;
      const armsEqual = session.armsByteEqual;
      // An undefined ratio (0 by 0) stays undefined under every arm assignment:
      // swapping 0/0 for 0/0 is not evidence that the readings ignore the arm.
      // The control checks the arithmetic only where the ratio EXISTS.
      const undefinedRatio = before === null && after === null && !session.censored;
      const inverted = before === null || after === null ? null
        : Math.abs(before * after - 1) <= 1e-9;
      return { session: session.session, before, after, inverted, armsEqual, undefinedRatio };
    });
    for (const row of swapReport) {
      if (row.undefinedRatio) continue;
      if (row.armsEqual) {
        if (row.before !== 1 || row.after !== 1) {
          report('swap-arms-inert', `${row.session}: byte-equal arms did not score 1.00 both ways`
            + ` (${fixed(row.before, 6)} / ${fixed(row.after, 6)})`);
        }
      } else if (row.inverted !== true) {
        report('swap-arms-inert', `${row.session}: swapping the arms left the ratio at`
          + ` ${fixed(row.after, 6)} against ${fixed(row.before, 6)}; the readings are not`
          + ' arm-aware');
      }
    }
  }

  const aggregate = aggregateOf(sessions.map(session => ({
    censored: session.censored, horizonRatio: session.horizonRatio,
  })));

  // ---- render ------------------------------------------------------------
  const first = sessions[0];
  const lines = [
    'score',
    `  schema       ${SCHEMA}`,
    `  sessions     ${sessions.length}`,
    `  records      ${sessions.map(session => session.session).join(', ')}`,
    `  removals     ${opts.removals}`
      + `${opts.setLabel === null ? '' : ` label=${opts.setLabel}`}`,
    `  threshold    ${int(first.threshold)} ${OBSERVED} source=${first.thresholdSource}`,
    `  W            ${int(first.width)} ESTIMATED (T/0.8) latch=${int(first.latch)} ESTIMATED`,
    `  coordinate   ${opts.coordinate}`
      + `${opts.coordinate === 'p2' ? ' (robustness)' : ' (primary)'}`
      + ` knots=${first.clock.distinct.join(',')}`
      + `${opts.flip ? ` flip=${first.clock.flip.distinct.join(',')}` : ''}`,
    `  labels       ${OBSERVED} | ${SIMULATED} | ${BYTES} | ${COMPOUND}`,
    `  aggregate    ${aggregate.rule}`,
    `  median       ratio=${fixed(aggregate.ratio, 3)}`
      + ` nonCensored=${aggregate.nonCensored} censored=${aggregate.censored}`,
    `  undefined    ratio=${aggregate.undefinedRatio} of ${aggregate.sessions}`
      + ' (both arms fill at progress 0; excluded from the median, counted, never a zero)',
  ];
  // The set's corpus census (chunk 8): every table states its n beside the
  // exclusion classes, so a headline over 2 sessions is never read as a
  // corpus-wide verdict. Carried from the set file, never re-derived here — this
  // module has no view of the sessions it was not asked to score.
  const census = first.selectedCensus;
  if (census !== null && census !== undefined) {
    lines.push(`  corpus-n     scored=${census.scored} censored=${census.censored}`
      + ` of ${census.sessions} answered session(s) in the judge set`
      + ` (this run scored ${sessions.length})`);
    lines.push(`  classes      ${Object.entries(census.classCounts ?? {})
      .sort((a, b) => b[1] - a[1]).map(([label, count]) => `${label}=${count}`).join(' ')}`);
    lines.push(`  censored-by  ${Object.entries(census.censoredByClass ?? {})
      .sort((a, b) => b[1] - a[1]).map(([label, count]) => `${label}=${count}`).join(' ')}`);
    lines.push('  no-extrapolation: the median is over the sessions this run scored; the'
      + ' censored sessions are named by class and carry no verdict of this lane');
  }
  for (const session of sessions) {
    lines.push(`  --- ${session.session} ---`);
    lines.push(`  n            ${session.censored ? 'censored: the selected arm never fills inside'
      + ' the horizon (>= horizon), excluded from the median'
      : session.undefinedRatio ? 'undefined-ratio: both arms fill at progress 0 (0/0),'
        + ' excluded from the median'
        : `scored: ratio=${fixed(session.horizonRatio, 3)}`}`);
    lines.push(`  horizon      progress=${session.clock.perTurn[session.requests.turn[session.requests.turn.length - 1]]}`
      + ` requests=${session.requests.turn.length} ${SIMULATED}`);
    lines.push(...renderTables(session.cells));
    if (opts.flip) {
      lines.push('  flip-progress');
      for (const row of flipMovement(session.cells, session.flip.cells)) {
        const note = row.table === 'R3'
          ? (row.moved === 0 ? 'byte-identical' : `MOVED ${row.moved} (scoping bug)`)
          : `${row.moved}/${row.total} cells moved`
            + `${row.invariant.length === 0 ? ''
              : ` (${row.invariant.length} ratio-invariant: arms-byte-equal)`}`;
        lines.push(`    ${row.table} ${note}`);
      }
    }
    if (session.oracleCensored) {
      lines.push(`  ceiling      >= horizon (the oracle lane never fills inside the horizon)`);
    }
    lines.push(`  exclusions   oracle: noPath=${session.removed.oracle.noPath}`
      + ` usedAgain=${session.removed.oracle.usedAgain}`
      + ` unplanned=${session.removed.oracle.unplanned}`
      + ` decisions=${session.removed.oracleDecisions}`
      + ` boundaries=${session.removed.boundaries.length}`);
    lines.push(`  point        ${session.selectedName}`
      + ` decisions=${session.removed.selectedDecisions}`
      + `${session.selectedScope === null ? ''
        : ` (own=${session.selectedScope.own} of ${session.selectedScope.own
          + session.selectedScope.foreign}, ${session.selectedScope.foreign} foreign session(s)`
          + ` dropped: ${session.selectedScope.foreignSessions.join(', ')})`}`
      + ` lossesReached=${session.removed.reached}`
      + `/${session.lanes.traditional.events.length}`);
    if (opts.swap) {
      const row = swapReport.find(entry => entry.session === session.session);
      lines.push(`  swap-arms    ratio ${fixed(row.before, 3)} -> ${fixed(row.after, 3)}`
        + `${row.armsEqual ? ' ratio-invariant: arms-byte-equal' : ''}`
        + `${row.undefinedRatio ? ' (0/0: undefined before and after the swap)'
          : ''}`);
    }
  }
  lines.push(`  gate         ${problems.length === 0 ? 'ok' : 'FAIL'}`);

  const outDir = resolve(REPO_ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const summary = {
    schema: SCHEMA,
    labels: { OBSERVED, SIMULATED, 'ESTIMATED-BYTES': BYTES, compound: COMPOUND },
    aggregate,
    selections: {
      removals: opts.removals, setLabel: opts.setLabel, coordinate: opts.coordinate,
      swapArms: opts.swap, flipProgress: opts.flip,
    },
    sessions: sessions.map(session => ({
      session: session.session,
      record: session.record,
      digest: session.digest,
      coordinate: session.coordinate,
      threshold: session.threshold,
      thresholdSource: session.thresholdSource,
      width: session.width,
      latch: session.latch,
      clock: session.clock,
      requests: session.requests,
      totalBytes: session.totalBytes,
      selectedName: session.selectedName,
      selectedScope: session.selectedScope,
      selectedCensus: session.selectedCensus,
      swapped: session.swapped === true,
      armsByteEqual: session.armsByteEqual,
      lanes: session.lanes,
      refetches: session.refetches,
      removed: session.removed,
      p2Absent: session.p2Absent,
      cells: session.cells,
      flip: { cells: session.flip.cells },
      floorRatio: session.floorRatio,
      horizonRatio: session.horizonRatio,
      censored: session.censored,
      undefinedRatio: session.undefinedRatio,
      oracleCensored: session.oracleCensored,
    })),
  };
  const summaryPath = join(outDir, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const printed = [...lines, `  summary      ${summaryPath}`];
  process.stdout.write(`${printed.join('\n')}\n`);
  writeFileSync(join(outDir, 'SUMMARY.md'),
    `# score — data, never cited\n\n\`\`\`\n${printed.join('\n')}\n\`\`\`\n`);

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem.code}: ${problem.detail}\n`);
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
