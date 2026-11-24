#!/usr/bin/env node
/**
 * Chunk 3 — the two-lane walker (design §3 D2), on an `extract.mjs` record.
 *
 * Usage:
 *   node dev/bench/multiturn/lanes.mjs --arm traditional|racoons --removals none
 *        [--record <dir>] [--out <dir>] [--perturb-trigger <factor>]
 *        [--route-thresholds <file.json>]
 *
 *   --arm          which lane's files are written. BOTH lanes are always walked:
 *                  the gate compares them, and a run that walked one would be
 *                  blind to the harness adding depth by itself.
 *   --removals     `none` is the only accepted value in this chunk. A frozen set
 *                  is chunk 5's; accepting one here would let this chunk report
 *                  a verdict from a set it never validated.
 *   --record       an `extract.mjs` output directory (default: the chunk-1
 *                  record of the pinned probe session).
 *   --out          where `arms/<session>/<lane>/{series,events}.jsonl` land.
 *                  Default: the record directory.
 *   --perturb-trigger
 *                  the ONLY place a trigger is re-evaluated. `0.5` halves the
 *                  record's own threshold in both lanes; the run also walks the
 *                  unperturbed baseline and fails by name (`perturb-inert`) when
 *                  the control moved nothing.
 *   --route-thresholds
 *                  a JSON object `{ "<model_id>": <threshold> }`, per-route
 *                  observed thresholds for a record with no fill of its own
 *                  (design §3). No route, no entry: T never fires and is
 *                  right-censored at the session's max observed depth, and the
 *                  run says so.
 *
 * ## One turn plan, two clocks
 *
 * `turns.jsonl` is flattened into requests in `startedAt` order. `depth` is the
 * record's ESTIMATED-BYTES depth (extract.mjs), which RESETS at each observed
 * fill. A lane needs the depth the session would have had if nothing had ever
 * been replaced, so `pristine` adds each fill's saving back:
 *
 *   pristine[i] = depth[i] + Σ { depth[j-1] − depth[j] : fill j ≤ i }
 *
 * where `j` is the first request completed after the fill. A pristine series
 * that decreases is a red gate (`pristine-not-monotone`): the record's depth
 * model and its fill ledger disagree.
 *
 * ## Traditional (T)
 *
 * No removal. With observed fills the headline run REPLAYS them: at each
 * observed fill index the depth becomes the fill's own
 * `truePostCompactTokenCount`, then grows with the pristine plan. Fill index and
 * fill depth are the session's own values (OBSERVED), and the overshoot is the
 * record's own — the fill lands after the request that crossed. Without fills,
 * the trigger is the observed threshold of the SAME model route; without that,
 * T is right-censored at the session's max observed depth.
 *
 * **The mock host's trigger is barred.** `bench-run.mjs` fires
 * `compaction-basic` at a floor of the smaller of two values: the window times
 * 0.8, and the window minus the request envelope's completion reservation and
 * the harness headroom — a bench constant for a 1M window, never a reading of a
 * real record (design §3). This module holds no numeric form of that formula and
 * no numeric trigger flag: `--threshold` and `--mock-trigger` are refused by
 * name, and the trigger can only come from the record's manifest, from a
 * same-route observed value, or from `--perturb-trigger` scaling that value.
 * The `barred` line prints the formula BY NAME so a reader can see it is the
 * thing that is absent.
 *
 * ## Racoons (R)
 *
 * The same plan plus the shipped machinery:
 *
 *   - the latch is the shipped `PruneWindowTrigger` at `W/2`, `W := T/0.8`
 *     (ESTIMATED), observed once per turn boundary;
 *   - a firing plans one pass with the shipped `planPrunePass` over the units
 *     the shipped `UnitTracker` makes. There is no protection layer (ISSUE-058
 *     P1a; ADR-0020): every unit is askable, in-flight turn included, and the
 *     `askedInFlight` count is printed;
 *   - removals become receipts at the next turn boundary (`appliedSetAt`); with
 *     `--removals none` there are no removals and no receipts, so R's series
 *     must equal T's BYTE FOR BYTE. That equality is this chunk's gate: R's
 *     series is COMPUTED through `applyRemovals` from the applied set at each
 *     request, never copied from T, so a bug in the receipt path shows as a
 *     differing series. `applyRemovals` is exported and tested directly with a
 *     decision in place, which is the proof that the gate can go red.
 *
 * The boundary is the turn's own end, with THAT turn still in flight — the
 * moment a mount observes at its last step, before the turn closes. There is
 * no protection layer (ISSUE-058 P1a; ADR-0020): a pass may ask any unit the
 * tracker mints, including the in-flight turn's own, and the `asked-in-flight`
 * count is printed so the change is visible rather than assumed.
 *
 * The latch's reading is the lane's own depth at the turn's last request — the
 * record's estimate of the tokens in use, which is the quantity the shipped
 * latch is meant to act on. The raw `ceil(bytes/4)` over the whole record is
 * NOT that quantity: the reconstructed record carries every tool output the
 * store kept, and the store keeps no per-request body, so the raw sum sits far
 * above the observed depth (6.2 MB of nodes against a ~120k-token horizon) and
 * would fire the latch on every turn. The reading is stated in the output as
 * `latch` with its value, so the choice is visible rather than assumed.
 *
 * Exit: 0 = the lane gate held; 1 = a gate failed (named on stderr);
 *       2 = bad arguments, a missing record, an unsupported removal set.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PruneWindowTrigger } from 'cremator-dsh';
import { appliedSetAt, planPrunePass, UnitTracker } from '@cremator/core';
import { median } from '../../shared/stats.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_RECORD = 'scratchpad/bench/2026-10-24-multiturn/records/sess_418282d7';
/** The design's stated assumption (§3 D2): W := T / 0.8. */
const W_RATIO = 0.8;
/** The shipped unit bar (`config.protocol.barBytes`, 512 since ADR-0051); the mount passes the same. */
const BAR_BYTES = 512;
/** The record's own byte-to-token quotient (extract.mjs `byteQuotient`). */
const TOKEN_QUOTIENT = 4;
/**
 * The barred mock-host trigger, as text only. `bench-run.mjs` computes
 * `floor(min(W × 0.8, W − O − B))` for its 1M-window mock host; this module
 * names it so its absence is legible and holds no numeric form of it, so no
 * code path here can compute it.
 */
const BARRED_NOTE = 'min(W*0.8,W-O-B) from bench-run.mjs\'s 1M-window mock host is never used on a record';

function usage() {
  return 'usage: node dev/bench/multiturn/lanes.mjs --arm traditional|racoons --removals none'
    + ' [--record <dir>] [--out <dir>] [--perturb-trigger <factor>] [--route-thresholds <file>]';
}

const LANES_OPTIONS = optionsOf([
  ['--arm', 'string'],
  ['--removals', 'string'],
  ['--record', 'string'],
  ['--out', 'string'],
  ['--perturb-trigger', 'string', 'perturb'],
  ['--route-thresholds', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: LANES_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
    // Named refusal: a numeric trigger on a real record is the barred formula in
    // disguise. The trigger comes from the record or not at all.
    unknown: (rawName) => (rawName === '--threshold' || rawName === '--mock-trigger'
      ? `${rawName}: a numeric trigger is barred on a real record`
        + ' (the mock host\'s min(W*0.8, W-O-B) is a bench constant, not a reading)'
      : null),
  });
  const opts = {
    arm: values.arm ?? null,
    removals: values.removals ?? null,
    record: values.record ?? DEFAULT_RECORD,
    out: values.out ?? null,
    perturb: values.perturb ?? null,
    routeThresholds: values.routeThresholds ?? null,
  };
  if (opts.arm === null) throw new Error(`--arm is required\n${usage()}`);
  if (opts.arm !== 'traditional' && opts.arm !== 'racoons') {
    throw new Error(`--arm must be traditional or racoons\n${usage()}`);
  }
  if (opts.removals === null) throw new Error(`--removals is required\n${usage()}`);
  if (opts.removals !== 'none') {
    throw new Error('removals-unsupported: only "none" is accepted in chunk 3;'
      + ` a frozen set is chunk 5's (${opts.removals})`);
  }
  return opts;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Requests in the store's own order; ties on the millisecond break on id.
 * Exported so chunk 6's scorer reads the SAME flattening and the SAME
 * pristine re-derivation: a second copy would let two readings of one record
 * drift apart without either failing.
 */
export function flatten(plan) {
  const requests = [];
  for (const turn of plan) {
    for (const request of turn.requests) {
      requests.push({ ...request, turn: turn.turnOrdinal, turnStatus: turn.status });
    }
  }
  requests.sort((a, b) => a.startedAt - b.startedAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fills = [];
  for (const turn of plan) for (const fill of turn.fills) fills.push({ ...fill, turn: turn.turnOrdinal });
  fills.sort((a, b) => a.completedAt - b.completedAt
    || (a.boundaryId < b.boundaryId ? -1 : a.boundaryId > b.boundaryId ? 1 : 0));
  return { requests, fills };
}

/** Each fill's first request after it, and the saving the record shows there. */
export function mapFills(requests, fills) {
  const mapped = [];
  const unmapped = [];
  for (const fill of fills) {
    let index = -1;
    for (let i = 0; i < requests.length; i++) {
      if (requests[i].startedAt > fill.completedAt) { index = i; break; }
    }
    if (index <= 0) {
      unmapped.push({ ...fill, reason: 'no request after the fill inside the record' });
      continue;
    }
    mapped.push({ ...fill, index, saving: requests[index - 1].depth - requests[index].depth });
  }
  return { mapped, unmapped };
}

/** The depth the session would have had if nothing had been replaced. */
export function pristineSeries(requests, mapped) {
  const series = [];
  let running = 0;
  let next = 0;
  for (const [i, request] of requests.entries()) {
    while (next < mapped.length && mapped[next].index === i) {
      running += mapped[next].saving;
      next++;
    }
    series.push(request.depth + running);
  }
  return series;
}

/**
 * Deterministic stand-in bytes of a recorded length. The record keeps every
 * node's rendered length and no content, and the shipped planner only ever
 * reads lengths, hashes and spans — so a stable filler is enough and keeps the
 * run reproducible.
 */
function placeholderBytes(nodeId, length) {
  const seed = sha256(nodeId);
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = seed.charCodeAt(i % seed.length);
  return bytes;
}

/**
 * The record's turns as the shipped planner's node shapes.
 *
 * `stepOrdinal` is the node's own step, never a constant 0: a live transcript
 * is one user turn with ~100 steps and 58 steps carrying more than one result,
 * so a step alone cannot address a landed unit. Other modules in this directory
 * import `removal.mjs`'s `snapshotNodes`, which carries the same rule; this copy
 * exists because chunk 3's lane reads lengths only and must not acquire chunk
 * 5's evidence shapes.
 */
function snapshotNodes(plan) {
  const nodes = [];
  for (const turn of plan) {
    for (const node of turn.nodes) {
      const bytes = placeholderBytes(node.id, node.bytes);
      const hash = sha256(bytes);
      if (node.kind === 'tool') {
        nodes.push({
          kind: 'tool-result',
          id: node.id,
          turnOrdinal: turn.turnOrdinal,
          stepOrdinal: node.stepOrdinal ?? 0,
          bytes,
          sha256: hash,
          byteLength: bytes.length,
          callId: node.callId ?? node.id,
          embeddedRecords: [],
          evidence: {
            kind: 'other', target: null, paths: [],
            source: { nodeId: node.id, sha256: hash, byteLength: bytes.length },
            sourceRecallId: null,
          },
        });
      } else {
        nodes.push({
          kind: 'message',
          id: node.id,
          turnOrdinal: turn.turnOrdinal,
          stepOrdinal: node.stepOrdinal ?? 0,
          bytes,
          sha256: hash,
          byteLength: bytes.length,
          role: ['user', 'system', 'developer', 'assistant'].includes(node.role)
            ? node.role : 'assistant',
          toolCallIds: [],
        });
      }
    }
  }
  return nodes;
}

/**
 * The snapshot at one `(turn, step)`: every node up to and including that step,
 * with it still in flight. With every node at step 0 this is one snapshot per
 * turn, which is what a multiturn record means.
 */
function boundarySnapshot(nodes, turnOrdinal, sessionId, revision, stepOrdinal = null) {
  const step = stepOrdinal ?? Math.max(0, ...nodes
    .filter(node => node.turnOrdinal === turnOrdinal)
    .map(node => node.stepOrdinal));
  const visible = nodes.filter(node => node.turnOrdinal < turnOrdinal
    || (node.turnOrdinal === turnOrdinal && node.stepOrdinal <= step));
  return {
    sessionId,
    revision,
    currentTurnOrdinal: turnOrdinal,
    completedThroughTurnOrdinal: turnOrdinal - 1,
    currentStepOrdinal: step,
    nodes: visible,
    cache: { kind: 'unknown' },
    retentionEvidence: [],
  };
}

/**
 * Walk one lane over the flattened plan, without the R lane's own machinery.
 *
 * `observedFills` are replayed when `replay` is set (the headline run): at each
 * mapped fill index the depth becomes the fill's observed post size. Without
 * replay, the lane re-evaluates `threshold` AFTER each request and fills once
 * per crossing — the perturbation control's only behaviour.
 *
 * This is the Traditional lane. R has its own walk (`walkRacoons`) because the
 * latch fires INSIDE the walk, turn by turn, on R's own depth; a pre-computed
 * pass list would make the trigger a function of the other lane's series.
 */
export function walk({ requests, pristine, observedFills, replay, threshold, triggerSource,
  postOf, progressOf }) {
  const samples = [];
  const events = [];
  const fillIndices = [];
  const series = new Array(requests.length);
  let offset = 0;
  let nextReplay = 0;
  let firedAt = -1;
  for (const [i, request] of requests.entries()) {
    while (replay && nextReplay < observedFills.length && observedFills[nextReplay].index <= i) {
      const fill = observedFills[nextReplay];
      const post = fill.truePostCompactTokenCount ?? postOf(fill);
      offset = post - pristine[i];
      fillIndices.push({ index: i, post, source: 'observed-fill' });
      events.push({
        kind: 'forced-loss', arm: null, index: i, turn: request.turn,
        trigger: threshold, triggerSource: 'observed-fill',
        pre: pristine[i], post, overshoot: pristine[i] / threshold,
      });
      firedAt = i;
      nextReplay++;
    }
    let depth = pristine[i] + offset;
    if (!replay && threshold !== null && depth >= threshold && i > firedAt) {
      // The control checks after the request and then resets — the record's own
      // shape (median overshoot 1.33, design §2.3).
      const post = postOf(request, i);
      offset = post - pristine[i];
      fillIndices.push({ index: i, post, source: 'perturbed-trigger' });
      events.push({
        kind: 'forced-loss', arm: null, index: i, turn: request.turn,
        trigger: threshold, triggerSource,
        pre: depth, post, overshoot: depth / threshold,
      });
      depth = post;
      firedAt = i;
    }
    samples.push({
      i, turn: request.turn, depth,
      progress: progressOf(request.turn),
      observedInput: request.inputTokens,
      cacheRead: request.cacheReadInputTokens,
    });
    series[i] = depth;
  }
  return { samples, events, fillIndices, series };
}

/**
 * Walk the Racoons lane: the same plan with the shipped latch and planner
 * running INSIDE the walk, one turn boundary at a time.
 *
 * Per request:
 *   - a pending applied set (decisions made at strictly earlier turns) takes the
 *     removed units' bytes out of the depth (`applyRemovals`);
 *   - an observed native fill is replayed exactly as in T — the host's forced
 *     loss is not the lane's, so both lanes must see it.
 * Per turn end, with that turn still in flight: the latch observes R's OWN depth
 * and, on a fire, one pass is planned over every unit the tracker mints.
 *
 * `frozenSetOf(pass)` answers the units a pass would remove. In chunk 3 it is
 * always empty (`--removals none`), so no decision is ever recorded and the
 * series must equal T's; chunk 5 supplies the frozen set here instead.
 */
function walkRacoons({ requests, pristine, observedFills, replay, threshold,
  triggerSource, postOf, progressOf, latch, planPass, frozenSetOf }) {
  const samples = [];
  const events = [];
  const fillIndices = [];
  const series = new Array(requests.length);
  const passes = [];
  const observations = [];
  const decisions = [];
  const unitBytes = new Map();
  let offset = 0;
  let nextReplay = 0;
  let firedAt = -1;
  for (const [i, request] of requests.entries()) {
    while (replay && nextReplay < observedFills.length && observedFills[nextReplay].index <= i) {
      const fill = observedFills[nextReplay];
      const post = fill.truePostCompactTokenCount ?? postOf(fill);
      offset = post - pristine[i];
      fillIndices.push({ index: i, post, source: 'observed-fill' });
      events.push({
        kind: 'forced-loss', arm: null, index: i, turn: request.turn,
        trigger: threshold, triggerSource: 'observed-fill',
        pre: pristine[i], post, overshoot: pristine[i] / threshold,
      });
      firedAt = i;
      nextReplay++;
    }
    let depth = pristine[i] + offset;
    const applied = appliedSetAt(decisions, request.turn);
    const net = applyRemovals(applied, depth, unitBytes, TOKEN_QUOTIENT);
    if (net !== null) depth = net;
    if (!replay && threshold !== null && depth >= threshold && i > firedAt) {
      const post = postOf(request, i);
      offset = post - pristine[i];
      fillIndices.push({ index: i, post, source: 'perturbed-trigger' });
      events.push({
        kind: 'forced-loss', arm: null, index: i, turn: request.turn,
        trigger: threshold, triggerSource,
        pre: depth, post, overshoot: depth / threshold,
      });
      depth = post;
      firedAt = i;
    }
    samples.push({
      i, turn: request.turn, depth,
      progress: progressOf(request.turn),
      observedInput: request.inputTokens,
      cacheRead: request.cacheReadInputTokens,
    });
    series[i] = depth;

    // The turn's last request: the mount observes the latch at this boundary,
    // with this turn still in flight.
    const next = requests[i + 1];
    if (next !== undefined && next.turn === request.turn) continue;
    if (!latch.enabled) continue;
    const turnOrdinal = request.turn;
    const fired = latch.observe(depth);
    observations.push({ turn: turnOrdinal, depth, fired });
    if (!fired) continue;
    // The turn's own last step: `planPass` defaults to the highest step the
    // turn's nodes carry, which is one step for a multiturn record and the
    // real last step for a live transcript.
    const planned = planPass(turnOrdinal, null);
    for (const unit of planned.units) unitBytes.set(unit.id, unit.byteLength);
    const frozen = frozenSetOf(planned);
    const removed = planned.pass.askRows
      .filter(row => frozen.has(row.unit.id))
      .map(row => row.unit);
    for (const unit of removed) {
      decisions.push({
        turn: turnOrdinal,
        unitId: unit.id,
        ranges: [{ startLine: 1, endLineInclusive: 1 }],
      });
    }
    // With the protection layer deleted (ISSUE-058 P1a, ADR-0020) the in-flight
    // turn's units are askable like any other. The count is reported, never
    // gated: a nonzero value is the corrected protocol working, not a defect.
    const askedInFlight = planned.pass.askRows
      .filter(row => (planned.toolNodes.find(node => node.id === row.unit.nodeId)
        ?.turnOrdinal ?? -1) >= turnOrdinal).length;
    passes.push({
      turn: turnOrdinal,
      depth,
      units: planned.units.length,
      askRows: planned.pass.askRows.length,
      l1Removals: planned.pass.l1.removals.length,
      applied: appliedSetAt(decisions, turnOrdinal + 1).length,
      askedInFlight,
    });
  }
  return { samples, events, fillIndices, series, passes, observations };
}

/** The byte-stable series form both lanes are compared and hashed on. */
function seriesText(series) {
  return series.map((depth, i) => `${i}\t${depth}`).join('\n');
}

/**
 * The depth a lane reports at one request once a turn's boundary has applied a
 * removal set: every applied unit's bytes leave the transcript and the rendering
 * is the pristine depth minus those bytes at the record's own quotient.
 *
 * Exported because it is the receipt path the byte-equality gate depends on: the
 * gate is green only because this answers `null` for an empty set, and a test
 * supplies a decision to prove it moves depth when one exists. `unitBytes` maps
 * a unit id to the node bytes the unit covers; a unit the map does not know
 * contributes nothing, because the record never saw it.
 */
export function applyRemovals(applied, depth, unitBytes, tokenQuotient = 4) {
  if (applied.length === 0) return null;
  let savedBytes = 0;
  for (const entry of applied) savedBytes += unitBytes.get(entry.unitId) ?? 0;
  return Math.max(0, depth - Math.round(savedBytes / tokenQuotient));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const recordDir = resolve(REPO_ROOT, opts.record);
  const manifestPath = join(recordDir, 'manifest.json');
  const turnsPath = join(recordDir, 'turns.jsonl');
  if (!existsSync(manifestPath) || !existsSync(turnsPath)) {
    throw new Error(`record not found: ${recordDir} (needs manifest.json and turns.jsonl)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = readFileSync(turnsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const { requests, fills } = flatten(plan);
  if (requests.length === 0) throw new Error(`record has no requests: ${recordDir}`);
  const sessionId = manifest.session?.id ?? 'unknown-session';

  const { mapped, unmapped } = mapFills(requests, fills);
  const pristine = pristineSeries(requests, mapped);

  // ---- the threshold, and where it came from ------------------------------
  const pinned = manifest.pinned ?? {};
  let threshold = Number.isSafeInteger(pinned.threshold) ? pinned.threshold : null;
  let triggerSource = threshold === null ? 'absent' : 'observed-fill';
  let criterion = threshold === null ? 'fill-index-and-depth' : 'observed-fill-depth';
  if (threshold === null && opts.routeThresholds !== null) {
    const path = resolve(REPO_ROOT, opts.routeThresholds);
    if (!existsSync(path)) throw new Error(`route-thresholds file not found: ${path}`);
    const table = JSON.parse(readFileSync(path, 'utf8'));
    const routes = new Map();
    for (const request of requests) {
      if (typeof request.modelId !== 'string') continue;
      routes.set(request.modelId, (routes.get(request.modelId) ?? 0) + 1);
    }
    const route = [...routes.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
    if (route !== null && Number.isSafeInteger(table[route])) {
      threshold = table[route];
      triggerSource = 'route';
      criterion = 'route-threshold';
    }
  }
  if (threshold === null) {
    // Right-censored: the lane never fires and the horizon is the max depth.
    criterion = 'right-censored';
  }
  // Presence, not the parsed number, decides whether the control runs: a given
  // `--perturb-trigger 1` is a request for the control, not the flag's absence
  // (ISSUE-597). Only an absent flag skips the baseline walk.
  const perturbGiven = opts.perturb !== null;
  const factor = perturbGiven ? Number(opts.perturb) : 1;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error('--perturb-trigger needs a positive finite number');
  }
  const effectiveThreshold = threshold === null ? null : Math.round(threshold * factor);
  const effectiveSource = threshold === null ? 'absent'
    : !perturbGiven ? triggerSource : `perturbed-${triggerSource}`;
  const window = threshold === null ? null : Math.round(threshold / W_RATIO * factor);
  const latchThreshold = window === null ? null : window / 2;

  // ---- progress (P1), per turn end ---------------------------------------
  const progressByTurn = new Map(plan.map(turn => [turn.turnOrdinal, turn.progress.writesTotal]));
  const progressOf = turn => progressByTurn.get(turn) ?? 0;
  const knots = new Set(plan.map(turn => turn.progress.writesTotal));
  const points = new Set();
  for (const turn of plan) if (turn.progress.writesTotal > 0) points.add(turn.progress.writesTotal);
  const horizon = {
    progress: progressOf(plan[plan.length - 1].turnOrdinal),
    index: requests.length - 1,
  };

  // ---- the control's synthetic fill size ---------------------------------
  // The perturbation control needs a post-fill size for a fill that never
  // happened. It uses the record's own median observed post-fill size — an
  // observed quantity, never the barred formula's O+B. The observations are
  // integer token counts, so an even-length sample's half-token midpoint is
  // rounded: that is the copy this file carried before ISSUE-072, and it keeps
  // every printed byte the same. An odd-length sample is already an integer.
  const observedPosts = mapped
    .map(fill => fill.truePostCompactTokenCount)
    .filter(value => Number.isSafeInteger(value));
  const observedPostMedian = median(observedPosts);
  const syntheticPost = observedPosts.length > 0
    ? (observedPosts.length % 2 === 1 ? observedPostMedian : Math.round(observedPostMedian))
    : (Number.isSafeInteger(pinned.prefixTokens) ? pinned.prefixTokens : 0);

  const common = {
    requests, pristine, observedFills: mapped, progressOf,
    postOf: () => syntheticPost,
  };
  // The headline run replays the observed fills when the record has them. The
  // perturbation control re-evaluates the trigger in BOTH its arms — perturbed
  // and unperturbed baseline — so the one variable is the factor, never the mode.
  const replay = !perturbGiven && mapped.length > 0;
  const traditional = walk({
    ...common,
    replay, threshold: effectiveThreshold, triggerSource: effectiveSource,
  });
  const baseline = perturbGiven ? walk({
    ...common,
    replay: false,
    threshold,
    triggerSource,
  }) : null;

  // ---- lane R: the shipped latch, planner and protection ------------------
  const nodes = snapshotNodes(plan);
  const latch = new PruneWindowTrigger(window);
  const tracker = new UnitTracker({ sessionId, barBytes: BAR_BYTES });
  /**
   * Plan one pass at a turn boundary, with that turn still in flight. There is
   * no protection layer to consult (ISSUE-058 P1a; ADR-0020): every unit the
   * tracker mints is askable, and the pass's own lists are the answer.
   */
  const planPass = (turnOrdinal, stepOrdinal) => {
    const boundary = boundarySnapshot(nodes, turnOrdinal, sessionId, turnOrdinal, stepOrdinal);
    const units = tracker.units(boundary);
    const toolNodes = boundary.nodes.filter(node => node.kind === 'tool-result');
    const pass = planPrunePass({
      units, nodes: toolNodes, episodes: [], round: 0,
      // Every superseded-read dedupe class off — the shipped default (ADR-0037), the
      // same `{}` the mount sends when no operator names a class.
      classes: {},
    });
    return { units, pass, toolNodes };
  };
  // `--removals none`: no pass ever removes a unit, so R's depth is the plan's
  // depth plus the guard's empty applied set. Chunk 5 replaces this with the
  // frozen set; the walk already routes every removal through `applyRemovals`.
  const frozenSetOf = () => new Set();
  const racoonsLane = walkRacoons({
    requests, pristine, observedFills: mapped, replay, progressOf,
    postOf: () => syntheticPost,
    threshold: effectiveThreshold, triggerSource: effectiveSource,
    latch, planPass, frozenSetOf,
  });
  const latchObservations = racoonsLane.observations;
  const passes = racoonsLane.passes;

  // ---- gates --------------------------------------------------------------
  const traditionalText = seriesText(traditional.series);
  const racoonsText = seriesText(racoonsLane.series);
  const harnessEqual = traditionalText === racoonsText;
  const pristineMonotone = pristine.every((value, i) => i === 0 || value >= pristine[i - 1]);
  const perturbMoved = !perturbGiven ? null : {
    traditional: seriesText(baseline.series) !== traditionalText,
    racoons: seriesText(baseline.series) !== racoonsText,
    fillIndex: baseline.fillIndices.length !== traditional.fillIndices.length
      || traditional.fillIndices.some((fill, i) => baseline.fillIndices[i]?.index !== fill.index),
  };

  const lane = opts.arm === 'racoons' ? racoonsLane : traditional;
  const outDir = resolve(REPO_ROOT, opts.out ?? recordDir);
  const armDir = join(outDir, 'arms', sessionId, opts.arm);
  mkdirSync(armDir, { recursive: true });
  writeFileSync(join(armDir, 'series.jsonl'), `${lane.samples.map(sample => JSON.stringify({
    i: sample.i, turn: sample.turn, depth: sample.depth, progress: sample.progress,
  })).join('\n')}\n`);
  writeFileSync(join(armDir, 'events.jsonl'), lane.events.length
    ? `${lane.events.map(event => JSON.stringify({ ...event, arm: opts.arm })).join('\n')}\n` : '');

  const firstLoss = lane.events[0] ?? null;
  const lastDepth = lane.series[lane.series.length - 1];
  const lines = [
    'lanes',
    `  session      ${sessionId}`,
    `  arm          ${opts.arm}`,
    `  removals     ${opts.removals}`,
    `  requests     ${requests.length} turns=${plan.length}`,
    `  threshold    ${effectiveThreshold === null ? 'absent' : effectiveThreshold}`
      + ` source=${effectiveSource} criterion=${criterion}`
      + `${!perturbGiven ? '' : ` factor=${factor}`}`,
    `  W            ${window === null ? 'absent' : window}`
      + `${window === null ? '' : ' ESTIMATED (T/0.8)'}`
      + ` latch=${latchThreshold === null ? 'absent' : Math.round(latchThreshold)}`,
    `  barred       ${BARRED_NOTE}`,
    `  fills        observed=${mapped.length}`
      + ` replayed=${traditional.fillIndices.filter(fill => fill.source === 'observed-fill').length}`
      + ` unmapped=${unmapped.length}`,
    `  fill-index   ${traditional.fillIndices.map(fill => `${fill.index}:${fill.post}`).join(' ') || 'none'}`,
    `  first-loss   ${firstLoss === null ? 'none (right-censored)'
      : `index=${firstLoss.index} turn=${firstLoss.turn} pre=${firstLoss.pre}`
        + ` post=${firstLoss.post} overshoot=${firstLoss.overshoot.toFixed(2)}`}`,
    `  horizon      progress=${horizon.progress} index=${horizon.index}`
      + ` last-depth=${lastDepth}${firstLoss === null ? ' censored' : ''}`,
    `  p1           knots=${knots.size} points=${points.size}`,
    `  latch        ${latchObservations.length === 0 ? 'disabled'
      : latchObservations.map(row => `t${row.turn}:${row.depth}:${row.fired ? 'fire' : '-'}`).join(' ')}`,
    `  passes       ${passes.length === 0 ? 'none'
      : passes.map(pass => `t${pass.turn} units=${pass.units}`
        + ` askRows=${pass.askRows} applied=${pass.applied}`
        + ` askedInFlight=${pass.askedInFlight}`).join(' | ')}`,
    '  gate         '
      + `pristine-monotone=${pristineMonotone ? 'ok' : 'FAIL'}`
      + ` harness-adds-nothing=${harnessEqual ? 'ok' : 'FAIL'}`,
    `  series       traditional=${sha256(traditionalText)} racoons=${sha256(racoonsText)}`
      + `${harnessEqual ? ' byte-equal' : ' DIFFER'}`,
    ...(perturbMoved === null ? [] : [
      `  perturb      moved-t=${perturbMoved.traditional ? 'yes' : 'NO'}`
        + ` moved-r=${perturbMoved.racoons ? 'yes' : 'NO'}`
        + ` fill-index-changed=${perturbMoved.fillIndex ? 'yes' : 'NO'}`,
    ]),
    `  out          ${armDir}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!pristineMonotone) {
    process.stderr.write('pristine-not-monotone: the depth series rises after a fill is added back;'
      + ' the record\'s fill ledger and depth model disagree\n');
    process.exitCode = 1;
  }
  if (!harnessEqual) {
    process.stderr.write('harness-adds-nothing: the R lane moved depth with an empty removal set\n');
    process.exitCode = 1;
  }
  if (perturbMoved !== null && (!perturbMoved.traditional || !perturbMoved.racoons)) {
    process.stderr.write('perturb-inert: the trigger control did not move both lanes'
      + ` (traditional=${perturbMoved.traditional} racoons=${perturbMoved.racoons})\n`);
    process.exitCode = 1;
  }
  if (perturbMoved !== null && !perturbMoved.fillIndex) {
    process.stderr.write('perturb-inert: the trigger control left the fill index unchanged\n');
    process.exitCode = 1;
  }
}

// Only a direct invocation runs a lane; the chunk-3 test imports `applyRemovals`
// and must not walk a record as a side effect.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
