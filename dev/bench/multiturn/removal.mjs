#!/usr/bin/env node
/**
 * Chunk 5 — a frozen removal set through the SHIPPED planner, with receipts
 * (design §3 stage A, §7 chunk 5).
 *
 * Usage:
 *   node dev/bench/multiturn/removal.mjs [--record <dir>] [--set <frozen.json>]
 *        [--out <dir>] [--flip-epoch <epochKey>]
 *
 *   --record      an `extract.mjs` record directory (default: the pinned probe
 *                 session).
 *   --set         a frozen removal set. Absent means the EMPTY set, which is the
 *                 floor of the bracket (design §3 "an empty set (ratio 1.00 by
 *                 construction)"). The set is data only: no judge call, no
 *                 network, no clock. A set produced in this process is never
 *                 accepted (design §8 "no keepall-by-construction").
 *   --out         where `removal.json` lands (default: the record directory).
 *   --flip-epoch  the non-vacuity control: corrupt one epoch record's applied
 *                 set and one row's applied unit list in the READ-BACK copy, so
 *                 both reusing checks must go red for that key.
 *
 * ## What runs where
 *
 * The planner is the product's: `UnitTracker` builds the units of a turn
 * boundary, `planPrunePass` plans one pass, and `appliedSetAt` decides which
 * removals a boundary sees. Nothing here re-implements any of those.
 *
 * A boundary is a step at which a result landed (in a multiturn record, a
 * turn's single step). There is no protection layer (ISSUE-058 P1a;
 * ADR-0020), so any unit the tracker mints is askable. A decision may name a
 * unit that has landed at or before its own boundary: a decision at boundary S
 * applies from S+1 (`appliedSetAt`), and the entry checkpoint's move is exactly
 * that — the result lands at step R, the answer rewinds what follows.
 *
 * ## The refusals, by name
 *
 * Every decision in the set is checked against the pass at its own decision
 * boundary, and every failure names the unit:
 *
 *   refused-unknown      the unit id is not in the boundary's catalogue. A unit
 *                        that lands LATER than the boundary is not in it either,
 *                        so "not seen yet" and "not a unit" are one refusal —
 *                        a separate `refused-in-flight` class could never fire
 *                        on its own, and it is gone.
 *   refused-not-removable  the unit survives the pass but is in neither the ask
 *                        rows nor L1's removals, so no route could remove it.
 *   refused-turn         the decision's turn (or step) is not a boundary of this
 *                        record.
 *   refused-range        the decision names a line range the unit cannot hold.
 *
 * ## Epochs, and why gate 2's checks run here
 *
 * The applied set of a boundary follows the shipped rule (a removal decided at
 * turn D applies from D+1; `appliedSetAt` is the authority) and the epoch plan
 * is the shipped `epochsFor` over the record's own call timeline. Those are
 * exactly gate 2's `epoch-plan` and `epoch-applied-set` checks, so this module
 * IMPORTS them from `dev/sim/epoch-checks.mjs`, which is where
 * `dev/sim/gate2-tables.mjs` gets them too: one implementation, two callers, no
 * drifting second copy. The checks run against `removal.json` READ BACK from
 * disk, so the persisted form is what is verified. `--flip-epoch` proves the
 * checks can go red.
 *
 * ## Receipts, and the one unbound piece
 *
 * Receipts render through the shipped `receiptLine`, one per applied unit, at
 * the first boundary that sees the removal. A removal covering every line ships
 * the floor receipt (no range segment) — the product's whole-unit rule.
 *
 * The recall id needs `buildRecallManifest` + `manifestSha256` + `recallIdFor`,
 * which the built core entry does not export publicly (the same named residue
 * gate 2 carries, and the reason its harness mints ids). This module imports
 * those three from `<dist>/ledger/manifest.js` directly and says so here: the
 * id is minted by the product's own builders, never by a copy of their rule.
 * Everything else on the receipt path — the line rendering, the hash — is the
 * public entry.
 *
 * Exit: 0 = every gate held; 1 = a gate failed (named on stderr); 2 = bad
 *       arguments, a missing record, an unreadable set, or a set that names this
 *       run as its source (a set must be frozen, not produced here).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appliedSetAt, canonicalRanges, epochsFor, planPrunePass,
  receiptLine, UnitTracker,
} from '@cremator/core';
import {
  checkAppliedSets, checkEpochPlan, deriveEpochsByArm,
} from '../../sim/epoch-checks.mjs';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_RECORD = 'scratchpad/bench/2026-10-24-multiturn/records/sess_418282d7';
/** The shipped unit bar (`config.protocol.barBytes`, 512 since ADR-0051); the mount passes the same. */
const BAR_BYTES = 512;
/** The record's own byte-to-token quotient (extract.mjs `byteQuotient`). */
const TOKEN_QUOTIENT = 4;
const SCHEMA = 'racoons-multiturn-frozen/1';

function usage() {
  return 'usage: node dev/bench/multiturn/removal.mjs [--record <dir>] [--set <frozen.json>]'
    + ' [--out <dir>] [--flip-epoch <epochKey>]';
}

const REMOVAL_OPTIONS = optionsOf([
  ['--record', 'string'],
  ['--set', 'string'],
  ['--out', 'string'],
  ['--flip-epoch', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: REMOVAL_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  return {
    record: values.record ?? DEFAULT_RECORD,
    set: values.set ?? null,
    out: values.out ?? null,
    flipEpoch: values.flipEpoch ?? null,
  };
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Deterministic stand-in bytes of a recorded length — the record keeps lengths
 * and hashes, not bodies, and every shipped call on this path reads only bytes,
 * lengths and spans. Same filler as chunk 3, so a node id maps to one body.
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
 * Chunk 3's snapshot carries no evidence paths because a lane only needs lengths
 * and spans; a receipt names the path, so this one carries it — the record's own
 * `filePath`, as the first hit path a unit inherits.
 *
 * `stepOrdinal` is the node's OWN step, not a constant 0: a live transcript is
 * one user turn with ~100 steps and 58 steps carrying more than one result, so
 * a step alone cannot address a landed unit and a turn alone addresses nothing.
 * The `(step, callId)` pair is the key; `stepOrdinal` is the half a node owns.
 */
export function snapshotNodes(plan) {
  const nodes = [];
  for (const turn of plan) {
    for (const node of turn.nodes) {
      const bytes = placeholderBytes(node.id, node.bytes);
      const hash = sha256(bytes);
      if (node.kind === 'tool') {
        const hit = typeof node.filePath === 'string' && node.filePath.length > 0;
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
            kind: 'other',
            target: null,
            paths: hit ? [{
              pathKey: node.filePath, displayPath: node.filePath, title: null,
              lineCount: null, byteLength: node.bytes, outcome: 'hit',
            }] : [],
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
 * The snapshot at one boundary: every node up to and including `stepOrdinal` of
 * `turnOrdinal`, with that step still in flight. With every node at step 0 this
 * is exactly one snapshot per turn, which is what the multiturn records mean.
 */
export function boundarySnapshot(nodes, turnOrdinal, sessionId, stepOrdinal = null) {
  const step = stepOrdinal ?? Math.max(0, ...nodes
    .filter(node => node.turnOrdinal === turnOrdinal)
    .map(node => node.stepOrdinal));
  return {
    sessionId,
    revision: turnOrdinal * 1000 + step,
    currentTurnOrdinal: turnOrdinal,
    completedThroughTurnOrdinal: turnOrdinal - 1,
    currentStepOrdinal: step,
    nodes: nodes.filter(node => node.turnOrdinal < turnOrdinal
      || (node.turnOrdinal === turnOrdinal && node.stepOrdinal <= step)),
    cache: { kind: 'unknown' },
    retentionEvidence: [],
  };
}

/**
 * Every boundary of a record, in order: one per `(turn, step)` that carries a
 * result, with a record-wide ordinal `epochIndex` — the number `appliedSetAt`
 * receives. A record whose nodes all sit at step 0 yields one boundary per turn,
 * which is the multiturn records' shape; a live transcript yields one per step.
 */
export function boundariesOf(plan) {
  const boundaries = [];
  let epochIndex = 0;
  for (const turn of plan) {
    const steps = [...new Set(turn.nodes.map(node => node.stepOrdinal ?? 0))].sort((a, b) => a - b);
    for (const step of steps.length === 0 ? [0] : steps) {
      boundaries.push({
        epochIndex,
        turnOrdinal: turn.turnOrdinal,
        stepOrdinal: step,
        callId: `${turn.turnId ?? `turn_${turn.turnOrdinal}`}#s${step}`,
      });
      epochIndex += 1;
    }
  }
  return boundaries;
}

/** The boundary a `(turn, step)` pair names, or undefined. */
export function boundaryAt(boundaries, turnOrdinal, stepOrdinal) {
  return boundaries.find(entry => entry.turnOrdinal === turnOrdinal
    && entry.stepOrdinal === stepOrdinal);
}

// ---------------------------------------------------------------------------
// The recall id: the product's own manifest builders, reached by dist path
// because the package entry does not export them (named in the header).

async function loadManifestBuilders() {
  const candidates = [];
  const override = process.env.CREMATOR_SIM_DIST;
  if (override !== undefined && override !== '') {
    candidates.push(resolve(REPO_ROOT, override, 'ledger', 'manifest.js'));
  }
  candidates.push(resolve(REPO_ROOT, 'packages', 'core', 'dist', 'ledger', 'manifest.js'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const module = await import(pathToFileURL(path).href);
    const required = ['buildRecallManifest', 'manifestSha256', 'recallIdFor'];
    const absent = required.filter(name => typeof module[name] !== 'function');
    if (absent.length === 0) return { path, ...module };
  }
  throw new Error('manifest-builders-absent: no dist copy of ledger/manifest.js exposes'
    + ` ${'buildRecallManifest, manifestSha256, recallIdFor'}; build @cremator/core first`
    + ` (tried ${candidates.join(', ')})`);
}

/**
 * One unit's receipt, minted exactly as the simulated bank mints it: a manifest
 * over the unit's own source with every removed byte range hashed, the id from
 * `recallIdFor(manifestSha256(...))`, then the shipped `receiptLine`.
 */
async function receiptFor(builders, { sessionId, unit, bytes, wholeUnit, label }) {
  const span = unit.span.byteRange;
  const removed = { startByte: span.startByte, endByteExclusive: span.endByteExclusive };
  const manifest = builders.buildRecallManifest({
    sessionId,
    parts: [{
      source: unit.source,
      blobSha256: unit.source.sha256,
      removedRanges: [{
        range: removed,
        sha256: sha256(bytes.subarray(removed.startByte, removed.endByteExclusive)),
      }],
    }],
  });
  const recallId = builders.recallIdFor(await builders.manifestSha256(manifest));
  // A whole-unit removal ships the floor receipt: `ranges: []` (product rule).
  const ranges = wholeUnit ? [] : [{
    startLine: unit.span.lineRange.startLine,
    endLineInclusive: unit.span.lineRange.endLineInclusive,
  }];
  return { recallId, text: receiptLine({ path: unit.path ?? 'transcript', ranges, label, recallId }) };
}

/** A unit's decision ranges in LINE form: the whole span, or the named sub-ranges. */
function lineRangesOf(unit, decision) {
  const full = { startLine: unit.span.lineRange.startLine,
    endLineInclusive: unit.span.lineRange.endLineInclusive };
  // Gate 2's two shapes, and only these: `wholeUnit: true`, or an explicit
  // non-empty `ranges` array. Inferring "the whole unit" from an absent field
  // would let a truncated set read as maximally aggressive.
  if (decision.wholeUnit === true) {
    if (Array.isArray(decision.ranges) && decision.ranges.length > 0) {
      throw new Error('wholeUnit and ranges are exclusive');
    }
    return canonicalRanges([full]);
  }
  if (!Array.isArray(decision.ranges) || decision.ranges.length === 0) {
    throw new Error('a decision needs wholeUnit: true or a non-empty ranges array'
      + ' (empty ranges is a keepall decision and removes nothing)');
  }
  const ranges = canonicalRanges(decision.ranges);
  const last = ranges[ranges.length - 1];
  if (last === undefined || last.endLineInclusive > full.endLineInclusive) {
    throw new Error(`ranges ${last?.startLine}-${last?.endLineInclusive} exceed the unit's`
      + ` ${full.endLineInclusive} lines`);
  }
  return ranges;
}

function readSet(path) {
  if (path === null) return { schema: SCHEMA, source: 'empty-set', decisions: [] };
  const absolute = resolve(REPO_ROOT, path);
  if (!existsSync(absolute)) throw new Error(`set-absent: ${absolute} does not exist`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`set-unreadable: ${absolute}: ${error.message}`);
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error(`set-invalid: ${absolute} carries no decisions array`);
  }
  // A set minted by this process cannot be a verdict (design §8). The set file
  // says where it came from; "this run" is refused by name.
  if (parsed.source === 'this-run') {
    throw new Error('set-not-frozen: the set names this run as its source; a verdict needs a set'
      + ' frozen in an earlier run');
  }
  return parsed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const recordDir = resolve(REPO_ROOT, opts.record);
  const outDir = opts.out === null ? recordDir : resolve(REPO_ROOT, opts.out);
  const manifestPath = join(recordDir, 'manifest.json');
  const turnsPath = join(recordDir, 'turns.jsonl');
  if (!existsSync(manifestPath) || !existsSync(turnsPath)) {
    throw new Error(`record not found: ${recordDir} (needs manifest.json and turns.jsonl)`);
  }
  const record = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plan = readFileSync(turnsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (plan.length === 0) throw new Error(`record has no turns: ${recordDir}`);
  const sessionId = record.session?.id ?? 'unknown-session';
  const set = readSet(opts.set);
  const builders = await loadManifestBuilders();

  const nodes = snapshotNodes(plan);
  const turnOfNode = new Map(nodes.map(node => [node.id, node.turnOrdinal]));
  // The record-wide ordinal of the boundary a node landed at. `appliedSetAt`
  // validates its argument as a turn, so the STEP ordinal is what it receives:
  // a live run is one turn with ~100 steps, and a turn-keyed epoch never fires.
  const boundaryList = boundariesOf(plan);
  const boundaryByKey = new Map(
    boundaryList.map(entry => [`${entry.turnOrdinal}:${entry.stepOrdinal}`, entry]),
  );
  const nodeEpochOf = new Map(nodes.map(node => [node.id,
    boundaryByKey.get(`${node.turnOrdinal}:${node.stepOrdinal}`)?.epochIndex ?? 0]));
  const tracker = new UnitTracker({ sessionId, barBytes: BAR_BYTES });

  /**
   * One boundary's planner call, at a `(turn, step)` pair. The step is the
   * record's own node step; with every node at step 0 (a multiturn record) the
   * snapshot is the whole turn. There is no protection layer to consult
   * (ISSUE-058 P1a; ADR-0020): the pass's own lists are the whole answer.
   */
  const planAt = (turnOrdinal, stepOrdinal) => {
    const boundary = boundarySnapshot(nodes, turnOrdinal, sessionId, stepOrdinal);
    const units = tracker.units(boundary);
    const toolNodes = boundary.nodes.filter(node => node.kind === 'tool-result');
    const pass = planPrunePass({
      units, nodes: toolNodes, episodes: [], round: 0,
      // Every superseded-read dedupe class off — the shipped default (ADR-0037), the
      // same `{}` the mount sends when no operator names a class. A class turned
      // on here would add removals this walk does not model.
      classes: {},
    });
    return {
      turnOrdinal, stepOrdinal, boundary, units, pass,
      byUnitId: new Map(units.map(unit => [unit.id, unit])),
      askable: new Set(pass.askRows.map(row => row.unit.id)),
      l1: new Set(pass.l1.removals.map(removal => removal.unitId)),
    };
  };

  // ---- every boundary, planned -------------------------------------------
  // One boundary per `(turn, step)` that carries a result. `epochIndex` is the
  // record-wide ordinal the applied-set rule consumes, because `appliedSetAt`
  // validates its argument as a turn and a live run is ONE turn with ~100 steps.
  const boundaryStats = [];
  let askedInFlight = 0;
  let askableSeen = 0;
  for (const entry of boundaryList) {
    if (!plan.some(turn => turn.turnOrdinal === entry.turnOrdinal
      && turn.requests.length > 0)) continue;
    const at = planAt(entry.turnOrdinal, entry.stepOrdinal);
    const askedInFlightHere = at.pass.askRows
      .filter(row => (turnOfNode.get(row.unit.nodeId) ?? -1) >= entry.turnOrdinal).length;
    askedInFlight += askedInFlightHere;
    askableSeen += at.pass.askRows.length;
    boundaryStats.push({
      turn: entry.turnOrdinal,
      step: entry.stepOrdinal,
      epoch: entry.epochIndex,
      units: at.units.length,
      askRows: at.pass.askRows.length,
      l1Removals: at.pass.l1.removals.length,
      askedInFlight: askedInFlightHere,
    });
  }

  // ---- every decision, through the pass at its own decision boundary ------
  // A decision names its boundary by `(turn, step)`. `step` may be omitted on a
  // record whose nodes all sit at step 0 (a multiturn record), in which case the
  // turn's last boundary is meant. The boundary's `epochIndex` — the record-wide
  // step ordinal — is what the applied-set rule consumes, because `appliedSetAt`
  // validates a TURN and a live run is one turn with ~100 steps.
  const accepted = [];
  const refusals = [];
  const decisionsByKey = new Map();
  const keyOf = (turn, step) => `${turn}:${step}`;
  for (const [index, decision] of set.decisions.entries()) {
    const where = `decisions[${index}]`;
    if (!Number.isSafeInteger(decision.turn) || decision.turn < 0) {
      throw new Error(`${where}.turn must be a non-negative safe integer`);
    }
    if (typeof decision.unitId !== 'string' || decision.unitId.length === 0) {
      throw new Error(`${where}.unitId must be a non-empty string`);
    }
    const refuse = (code, detail) => refusals.push({
      code, unitId: decision.unitId, turn: decision.turn,
      step: decision.step ?? null, label: decision.label ?? null, detail,
    });
    const turnBoundaries = boundaryList.filter(entry => entry.turnOrdinal === decision.turn);
    if (turnBoundaries.length === 0) {
      refuse('refused-turn', `turn ${decision.turn} is not a turn of ${sessionId}`);
      continue;
    }
    const target = decision.step === undefined
      ? turnBoundaries[turnBoundaries.length - 1]
      : boundaryAt(boundaryList, decision.turn, decision.step);
    if (target === undefined) {
      refuse('refused-turn',
        `step ${decision.step} is not a boundary of turn ${decision.turn}`);
      continue;
    }
    const boundary = planAt(target.turnOrdinal, target.stepOrdinal);
    decisionsByKey.set(keyOf(target.turnOrdinal, target.stepOrdinal), boundary);
    // The unit must be in the boundary's catalogue, and a unit that has not
    // landed yet simply is not: the snapshot only holds nodes up to the
    // boundary. So "not seen yet" and "not a unit" are ONE refusal, not two —
    // `refused-in-flight` would be a class that could never fire on its own
    // (the plan deletes `bar-margin` for the same reason), and it is gone.
    const unit = boundary.byUnitId.get(decision.unitId);
    if (unit === undefined) {
      refuse('refused-unknown',
        `no unit with this id at boundary t${target.turnOrdinal}s${target.stepOrdinal}`
        + ' (a unit that lands later is not in that boundary\'s catalogue)');
      continue;
    }
    const nodeEpoch = nodeEpochOf.get(unit.nodeId) ?? -1;
    if (!boundary.askable.has(decision.unitId) && !boundary.l1.has(decision.unitId)) {
      refuse('refused-not-removable',
        'the unit is in neither the pass\'s ask rows nor L1\'s removals');
      continue;
    }
    if (unit.span.lineRange === null) {
      refuse('refused-not-removable', 'the unit has no line form, so no line range can be named');
      continue;
    }
    let ranges;
    try {
      ranges = lineRangesOf(unit, decision);
    } catch (error) {
      refuse('refused-range', error.message);
      continue;
    }
    const wholeUnit = ranges.length === 1
      && ranges[0].startLine === unit.span.lineRange.startLine
      && ranges[0].endLineInclusive === unit.span.lineRange.endLineInclusive;
    accepted.push({
      turn: target.epochIndex,
      turnOrdinal: target.turnOrdinal,
      step: target.stepOrdinal,
      unitId: decision.unitId,
      nodeId: unit.nodeId,
      nodeEpoch,
      ranges,
      wholeUnit,
      route: boundary.askable.has(decision.unitId) ? 'ask' : 'l1',
      label: typeof decision.label === 'string' ? decision.label : null,
      path: unit.path,
      byteLength: unit.byteLength,
    });
  }

  // ---- the epoch plan, from the shipped `epochsFor` -----------------------
  // One call per record-wide boundary ordinal, in order. `appliedSetAt` takes
  // that ordinal in its `turn` slot: a live run has one turn and ~100 steps, so
  // a turn-keyed call would see every decision on the first one.
  const calls = boundaryList.map(entry => ({
    callId: `${sessionId}#e${entry.epochIndex}`,
    turnIndex: entry.epochIndex,
    turnOrdinal: entry.turnOrdinal,
    stepOrdinal: entry.stepOrdinal,
  }));
  const decisions = accepted.map(entry => ({
    turn: entry.turn, unitId: entry.unitId, ranges: entry.ranges,
  }));
  const epochs = epochsFor(calls, decisions);

  const recordFailureList = [];
  const recordFailure = (kind, message) => recordFailureList.push({ kind, message });
  const fail = (code, message) => {
    throw new Error(message);
  };
  // The rows a runner would persist: one per boundary, carrying the applied set
  // it saw. `checkAppliedSets` re-derives that set from `appliedSetAt`.
  const epochOfEpochIndex = new Map();
  for (const epoch of epochs) {
    for (const callId of epoch.callIds) {
      const epochIndex = Number(callId.slice(callId.lastIndexOf('#e') + 2));
      epochOfEpochIndex.set(epochIndex, epoch);
    }
  }
  const rows = calls.map(call => {
    const epoch = epochOfEpochIndex.get(call.turnIndex);
    const applied = appliedSetAt(decisions, call.turnIndex);
    return {
      tableId: call.callId,
      sessionId,
      lastTurn: call.turnIndex,
      turnOrdinal: call.turnOrdinal,
      stepOrdinal: call.stepOrdinal,
      epochKey: `${sessionId}#${epoch?.epochIndex ?? 0}`,
      epochIndex: epoch?.epochIndex ?? 0,
      epochBase: epoch?.firstCallId === call.callId,
      applied: {
        sha256: sha256(JSON.stringify(applied)),
        unitIds: applied.map(entry => entry.unitId),
      },
    };
  });
  const epochRecords = epochs.map(epoch => ({
    arm: 'on',
    epochKey: `${sessionId}#${epoch.epochIndex}`,
    firstTableId: epoch.firstCallId,
    lastTableId: epoch.lastCallId,
    tableCount: epoch.callCount,
    firstTurnIndex: epoch.firstTurnIndex,
    lastTurnIndex: epoch.lastTurnIndex,
    appliedRemovalSet: epoch.appliedRemovalSet,
    basePrefixRequired: epoch.basePrefixRequired,
    sameTurnGroups: epoch.sameTurnGroups.map(group => ({
      turnIndex: group.turnIndex, tableIds: [...group.callIds],
    })),
    activatedUnitIds: [...epoch.activatedUnitIds],
  }));

  // ---- receipts, at the first boundary that sees each removal ------------
  const receipts = [];
  // A unit accepted at turn D applies from D+1; the first boundary that SEES it
  // is D+1, or the first later boundary in the record. A removal whose decision
  // is the last boundary of the record has no boundary left to render at, and
  // that is reported, never silently dropped.
  const unreached = [];
  for (const entry of accepted) {
    const firstSeen = calls.find(call => call.turnIndex > entry.turn)?.turnIndex ?? null;
    if (firstSeen === null) {
      unreached.push({ unitId: entry.unitId, turn: entry.turn });
      continue;
    }
    // The unit's bytes come from the decision boundary's own catalogue: that is
    // the snapshot the decision was made in, and a unit id already covers the
    // node hash and the span.
    const boundary = decisionsByKey.get(keyOf(entry.turnOrdinal, entry.step))
      ?? planAt(entry.turnOrdinal, entry.step);
    const unit = boundary.byUnitId.get(entry.unitId);
    const node = nodes.find(candidate => candidate.id === unit.nodeId);
    const receipt = await receiptFor(builders, {
      sessionId, unit, bytes: node.bytes, wholeUnit: entry.wholeUnit, label: entry.label,
    });
    receipts.push({
      unitId: entry.unitId,
      decisionTurn: entry.turn,
      decisionTurnOrdinal: entry.turnOrdinal,
      decisionStep: entry.step,
      firstSeenTurn: firstSeen,
      path: unit.path,
      wholeUnit: entry.wholeUnit,
      byteLength: unit.byteLength,
      tokens: Math.ceil(unit.byteLength / TOKEN_QUOTIENT),
      recallId: receipt.recallId,
      text: receipt.text,
    });
  }

  // ---- the persisted artifact, read back before it is trusted ------------
  const output = {
    schema: 'racoons-multiturn-removal/1',
    session: sessionId,
    record: {
      dir: recordDir,
      digest: record.snapshot?.digest ?? null,
      threshold: record.pinned?.threshold ?? null,
    },
    set: {
      schema: set.schema ?? null,
      source: set.source ?? null,
      path: opts.set === null ? null : resolve(REPO_ROOT, opts.set),
      decisions: set.decisions.length,
      sha256: sha256(JSON.stringify(set.decisions)),
    },
    barred: 'min(W*0.8,W-O-B) from bench-run.mjs\'s 1M-window mock host is never used on a record',
    boundaries: boundaryStats,
    accepted,
    refused: refusals,
    unreached,
    epochs: epochRecords,
    rows,
    receipts,
  };
  const outPath = join(outDir, 'removal.json');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(outPath, 'utf8'));

  // ---- gate 2's own checks, on the read-back artifact --------------------
  const rowsByArm = { on: stored.rows };
  const recordedDecisions = stored.accepted.map(entry => ({
    turn: entry.turn, unitId: entry.unitId, ranges: entry.ranges,
  }));
  const decisionsFor = (arm, wantedSession) => (wantedSession === sessionId
    ? recordedDecisions : []);

  let flipped = null;
  if (opts.flipEpoch !== null) {
    const targetIndex = stored.epochs.findIndex(epoch => epoch.epochKey === opts.flipEpoch);
    if (targetIndex === -1) {
      throw new Error(`--flip-epoch ${opts.flipEpoch} names no epoch of ${sessionId}`
        + ` (keys: ${stored.epochs.map(epoch => epoch.epochKey).join(', ') || 'none'})`);
    }
    // Corrupt the epoch's applied set AND one row's applied unit list, so both
    // reusing checks must notice. A green flip run means the checks cannot fail.
    const target = stored.epochs[targetIndex];
    target.appliedRemovalSet = `${target.appliedRemovalSet}\u0000flip`;
    const row = stored.rows.find(entry => entry.epochKey === target.epochKey);
    if (row !== undefined) row.applied = { ...row.applied, unitIds: [...row.applied.unitIds, 'unit:flip'] };
    flipped = opts.flipEpoch;
  }

  const derived = deriveEpochsByArm({
    rowsByArm, decisionsFor, epochsFor, recordFailure, fail,
  });
  const summaryEpochByKey = { on: new Map(stored.epochs.map(epoch => [epoch.epochKey, epoch])) };
  checkEpochPlan({ rowsByArm, derivedEpochs: derived, summaryEpochByKey, recordFailure });
  checkAppliedSets({ rowsByArm, decisionsFor, appliedSetAt, sha256Sync: sha256, recordFailure });

  // ---- depth effect, per boundary ---------------------------------------
  // The pristine depth of a boundary is the last request's depth with every
  // observed fill added back (chunk 3's `pristine`), and an applied removal
  // takes its unit's bytes out at the record's own quotient.
  const depths = [];
  const requests = plan.flatMap(turn => turn.requests.map(request => ({ ...request, turn: turn.turnOrdinal })));
  requests.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const call of calls) {
    // The boundary's own turn's last request: with one request per step, the
    // turn's final request is the closest the record offers a per-step reading.
    const lastRequest = [...requests].reverse().find(request => request.turn === call.turnOrdinal);
    if (lastRequest === undefined) continue;
    const applied = appliedSetAt(decisions, call.turnIndex);
    let removedBytes = 0;
    for (const entry of applied) {
      for (const receipt of receipts) {
        if (receipt.unitId === entry.unitId) { removedBytes += receipt.byteLength; break; }
      }
    }
    const after = Math.max(0, (lastRequest.depth ?? 0) - Math.round(removedBytes / TOKEN_QUOTIENT));
    depths.push({
      epoch: call.turnIndex, turn: call.turnOrdinal, step: call.stepOrdinal,
      applied: applied.length, removedBytes, before: lastRequest.depth, after,
    });
  }

  // ---- gates -------------------------------------------------------------
  const byCode = new Map();
  for (const refusal of refusals) byCode.set(refusal.code, (byCode.get(refusal.code) ?? 0) + 1);
  const landedUnitsOnly = accepted.every(entry => entry.nodeEpoch <= entry.turn);
  const epochChecksGreen = recordFailureList.length === 0;  const flipGreen = flipped === null
    ? null : recordFailureList.some(failure => failure.kind === 'epoch-plan')
      && recordFailureList.some(failure => failure.kind === 'epoch-applied-set');

  const lines = [
    'removal',
    `  session      ${sessionId}`,
    `  set          ${stored.set.source ?? 'empty'}`
      + ` decisions=${stored.set.decisions} sha=${String(stored.set.sha256).slice(0, 16)}`
      + `${opts.set === null ? ' (no --set: the empty set, the bracket floor)' : ''}`,
    `  barred       ${stored.barred}`,
    `  accepted     ${accepted.length}`
      + ` (${accepted.filter(entry => entry.route === 'ask').length} ask,`
      + ` ${accepted.filter(entry => entry.route === 'l1').length} l1)`
      + ` units=${new Set(accepted.map(entry => entry.unitId)).size}`,
    `  refused      ${refusals.length === 0 ? 'none'
      : [...byCode.entries()].map(([code, count]) => `${code}=${count}`).join(' ')}`,
    `  boundaries   ${calls.length} epochs=${epochs.length}`
      + ` (the shipped epochsFor over the record's own call timeline)`
      + ` units=${boundaryStats.reduce((total, stat) => total + stat.units, 0)}`
      + ` askRows=${askableSeen}`
      + ` askedInFlight=${askedInFlight}`,
    `  receipts     ${receipts.length}`
      + `${unreached.length === 0 ? '' : ` unreached=${unreached.length}`}`
      + ` tokens=${receipts.reduce((total, receipt) => total + receipt.tokens, 0)}`,
    `  gate         landed-units-only=${landedUnitsOnly ? 'ok' : 'FAIL'}`
      // With --flip-epoch the checks are SUPPOSED to go red; reporting plain
      // FAIL there would read as a broken run beside flip-epoch=ok.
      + ` epoch-checks=${flipGreen === true ? 'reddened-as-required'
        : epochChecksGreen ? 'ok' : 'FAIL (gate 2\'s own)'}`
      + `${flipGreen === null ? '' : ` flip-epoch=${flipGreen ? 'ok' : 'FAIL'}`}`,
    `  out          ${outPath}`,
  ];
  for (const refusal of refusals) {
    lines.push(`    ${refusal.code} ${refusal.unitId} turn=${refusal.turn}`
      + `${refusal.step === null ? '' : ` step=${refusal.step}`}: ${refusal.detail}`);
  }
  for (const entry of unreached) {
    lines.push(`    unreached ${entry.unitId} turn=${entry.turn}`
      + ' (no later boundary in the record renders its receipt)');
  }
  for (const epoch of epochs) {
    lines.push(`  epoch        ${sessionId}#${epoch.epochIndex}`
      + ` calls=${epoch.firstCallId}..${epoch.lastCallId} n=${epoch.callCount}`
      + ` applied=${epoch.appliedRemovalSet === '[]' ? 0 : JSON.parse(epoch.appliedRemovalSet).length}`);
  }
  for (const depth of depths) {
    lines.push(`  depth        e${depth.epoch} t${depth.turn}s${depth.step} applied=${depth.applied}`
      + ` before=${depth.before} after=${depth.after}`
      + ` removed=${depth.removedBytes}B/${Math.round(depth.removedBytes / TOKEN_QUOTIENT)}tok`);
  }
  if (flipped !== null) {
    lines.push(`  flip-epoch   ${flipped} reddened: `
      + `${[...new Set(recordFailureList.map(failure => failure.kind))].sort().join(', ') || 'nothing'}`);
  }
  for (const failure of recordFailureList) {
    lines.push(`    ${failure.kind} ${failure.message}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!landedUnitsOnly) {
    process.stderr.write('landed-units-only: an accepted removal names a unit the deciding pass'
      + ' had not yet seen\n');
    process.exitCode = 1;
  }
  if (!epochChecksGreen && flipGreen !== true) {
    process.stderr.write(`epoch-checks: ${recordFailureList.map(failure => failure.message)
      .join('; ')}\n`);
    process.exitCode = 1;
  }
  if (flipGreen === false) {
    process.stderr.write(`flip-inert: --flip-epoch ${flipped} did not redden both checks`
      + ` (classes seen: ${recordFailureList.map(failure => failure.kind).join(', ') || 'none'})\n`);
    process.exitCode = 1;
  }
}

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
