#!/usr/bin/env node
/**
 * Chunk 5's gate: a frozen set through the SHIPPED planner.
 *
 * The design's broken state (§8):
 *
 *   - "a removal inside the in-flight turn is refused. Broken state: the
 *     decision's bytes are not visible to the deciding pass." — so a decision
 *     naming a unit of the turn in flight at its own decision boundary must be
 *     refused BY NAME, and the accepted set must cover closed turns only. There
 *     is no protection layer to consult (ISSUE-058 P1a; ADR-0020): the
 *     in-flight unit IS askable, and the refusal is the epoch rule
 *     (`appliedSetAt` applies a decision from T+1).
 *   - "epoch checks reused, not reimplemented" — the epoch plan and the applied
 *     set are checked by importing gate 2's own checks from
 *     `dev/sim/epoch-checks.mjs`, the module `dev/sim/gate2-tables.mjs` uses. A
 *     second copy of the rule would be the drift this test exists to prevent, so
 *     the test asserts the import exists and that the checks can go red.
 *
 * Fixtures are records built here (chunk 1's contract), so this runs on either
 * device without the 18 GB snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = new URL('./removal.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = new URL('./removal.mjs', import.meta.url).href;
const MODULE = new URL('./removal.mjs', import.meta.url).href;
const EPOCH_CHECKS = new URL('../../sim/epoch-checks.mjs', import.meta.url).href;
const GATE2 = new URL('../../sim/gate2-tables.mjs', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const REPO_ROOT = resolve(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..', '..',
);

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function toolNode(id, bytes) {
  return {
    id, kind: 'tool', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool: 'Read', callId: `call_${id}`, status: 'completed', filePath: `src/${id}.log`,
  };
}

function textNode(id, bytes) {
  return {
    id, kind: 'text', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool: null, callId: null, status: null, filePath: null,
  };
}

/**
 * Three closed turns plus a fourth in flight. Each turn carries one 9,000-byte
 * tool node, so each is exactly one unit above the shipped bar (512 B, ADR-0051): every
 * boundary has a clean unit per closed turn and one protected unit for the turn
 * in flight. Turn 3 has no requests, so it is not a call in the epoch timeline —
 * the last two turns are what the epoch plan has to keep apart.
 */
function fixturePlan({ inFlightTurn = 3 } = {}) {
  let at = 1000;
  return [0, 1, 2, 3].map(ordinal => {
    const requests = ordinal === inFlightTurn || ordinal < 3
      ? [1, 2].map(index => {
        at += 10;
        return {
          id: `r${ordinal}_${index}`, logicalRequestId: `r${ordinal}_${index}`,
          querySource: 'main_turn', modelId: 'deepseek-v4.1-flash', status: 'completed',
          startedAt: at, inputTokens: 1000 + ordinal * 10 + index,
          cacheReadInputTokens: 0, depth: 1000 + ordinal * 10 + index,
        };
      })
      : [];
    return {
      turnOrdinal: ordinal,
      turnId: `turn_${ordinal}`,
      status: ordinal === inFlightTurn ? 'running' : 'completed',
      inFlight: ordinal === inFlightTurn,
      startedAt: at,
      completedAt: ordinal === inFlightTurn ? null : at + 5,
      promptMessageId: null,
      promptOrigin: 'real_user',
      promptVisibility: 'visible',
      nodes: [textNode(`m${ordinal}`, 100), toolNode(`u${ordinal}`, 9000)],
      nodeCount: 2,
      nodeBytes: 9100,
      requests,
      requestCount: requests.length,
      declaredModelRequestCount: requests.length,
      declaredInputTokens: requests.reduce((total, request) => total + request.depth, 0),
      declaredCacheReadInputTokens: 0,
      declaredToolCallCount: requests.length,
      fills: [],
      progress: { writesTotal: 0, writesThisTurn: 0 },
    };
  });
}

function writeRecord(root, { plan, sessionId = 'sess_fixture', name = 'rec' }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turns.jsonl'), `${plan.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({
    schema: 'racoons-multiturn-record/1',
    snapshot: { digest: 'a'.repeat(64) },
    session: { id: sessionId },
    selected: { turns: plan.length, prompts: plan.length },
    pinned: {
      threshold: 166000, thresholdSource: 'observed-fill', W: 207500,
      branch: 'observed-fill', byteQuotient: 4, seed: 0, prefixTokens: 100,
    },
  }, null, 2)}\n`);
  return dir;
}

function writeSet(root, decisions, extra = {}) {
  const path = join(root, 'frozen.json');
  writeFileSync(path, `${JSON.stringify({
    schema: 'racoons-multiturn-frozen/1',
    source: 'test fixture',
    decisions,
    ...extra,
  }, null, 2)}\n`);
  return path;
}

/** The unit ids a boundary's shipped planner produces, by the node they cover. */
async function unitsAt(plan, turnOrdinal, sessionId = 'sess_fixture') {
  const { snapshotNodes, boundarySnapshot } = await import(MODULE);
  const { UnitTracker, planPrunePass } = await import('@cremator/core');
  const nodes = snapshotNodes(plan);
  const boundary = boundarySnapshot(nodes, turnOrdinal, sessionId);
  const units = new UnitTracker({ sessionId, barBytes: 8192 }).units(boundary);
  const pass = planPrunePass({
    units, nodes: boundary.nodes.filter(node => node.kind === 'tool-result'),
    episodes: [], round: 0, classes: {},
  });
  return {
    askable: pass.askRows.map(row => row.unit.id),
    byNode: new Map(units.map(unit => [unit.nodeId, unit.id])),
    turnOfNode: new Map(nodes.map(node => [node.id, node.turnOrdinal])),
  };
}

test('a decision names units in its boundary; a later one is refused by name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-inflight-'));
  try {
    const plan = fixturePlan();
    const dir = writeRecord(root, { plan });
    const at2 = await unitsAt(plan, 2);
    const at3 = await unitsAt(plan, 3);
    const sameBoundaryUnit = at2.byNode.get('u2');
    const closedUnit = at2.byNode.get('u1');
    const laterUnit = at3.byNode.get('u3');
    // There is no protection layer (ISSUE-058 P1a; ADR-0020): a unit that has
    // landed at the decision boundary IS decidable — that is the entry
    // checkpoint's own move (the result lands, the answer rewinds what follows).
    assert.ok(at2.askable.includes(sameBoundaryUnit), 'the fixture cannot ask a landed unit');
    assert.ok(at2.askable.includes(closedUnit), 'the fixture did not make the closed unit askable');

    const set = writeSet(root, [
      { turn: 2, unitId: laterUnit, wholeUnit: true, label: 'not landed yet' },
      { turn: 2, unitId: sameBoundaryUnit, wholeUnit: true, label: 'landed here' },
      { turn: 2, unitId: closedUnit, wholeUnit: true, label: 'read once' },
    ]);
    const out = join(root, 'out');
    const result = run(['--record', dir, '--set', set, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}refused +refused-unknown=1$/m);
    // A unit that has not landed yet is not in the boundary's catalogue, so the
    // one refusal names it and says why.
    assert.match(result.stdout,
      /refused-unknown unit:sha256:\w+ turn=2: no unit with this id at boundary t2s0 \(a unit that lands later/);
    assert.match(result.stdout, /^ {2}accepted +2 \(2 ask, 0 l1\) units=2$/m);
    assert.match(result.stdout, /landed-units-only=ok/);

    // The refusal names the later unit; both landed ones are accepted.
    const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
    assert.equal(artifact.refused.length, 1);
    assert.equal(artifact.refused[0].code, 'refused-unknown');
    assert.equal(artifact.refused[0].unitId, laterUnit);
    assert.deepEqual(new Set(artifact.accepted.map(entry => entry.unitId)),
      new Set([sameBoundaryUnit, closedUnit]));
    assert.ok(artifact.accepted.every(entry => entry.nodeEpoch <= entry.turn),
      'an accepted removal names a unit the deciding pass had not seen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate 2\'s epoch checks are imported, not reimplemented, and they can go red', async () => {
  const source = readFileSync(SOURCE.replace('file:///', '').replace(/^\/([A-Za-z]:)/, '$1'), 'utf8');
  // The import is the whole point: a second implementation would drift.
  assert.match(source, /from '\.\.\/\.\.\/sim\/epoch-checks\.mjs'/);
  assert.doesNotMatch(source, /function epochsFor|function appliedSetAt/,
    'the module carries its own epoch implementation');
  const checks = await import(EPOCH_CHECKS);
  for (const name of ['deriveEpochsByArm', 'checkEpochPlan', 'checkAppliedSets']) {
    assert.equal(typeof checks[name], 'function', `${name} is missing from epoch-checks.mjs`);
  }
  // And gate 2 really uses them, so "reused" is not just a name in a comment.
  const gate2 = readFileSync(GATE2, 'utf8');
  assert.match(gate2, /from "\.\/epoch-checks\.mjs"/);
  for (const name of ['deriveEpochsByArm', 'checkEpochPlan', 'checkAppliedSets']) {
    assert.match(gate2, new RegExp(`\\b${name}\\(`), `gate 2 does not call ${name}`);
  }
});

test('the epoch plan follows the shipped epochsFor, and --flip-epoch proves it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-epochs-'));
  try {
    const plan = fixturePlan();
    const dir = writeRecord(root, { plan });
    const at2 = await unitsAt(plan, 2);
    const at3 = await unitsAt(plan, 3);
    const firstUnit = at2.byNode.get('u1');
    const secondUnit = at3.byNode.get('u0');
    // Decide at t2 and again at t3: the applied set grows once, so there are two
    // epochs, and the t2 decision is NOT visible at t2 (end-of-turn semantics).
    const set = writeSet(root, [
      { turn: 2, unitId: firstUnit, wholeUnit: true },
      { turn: 3, unitId: secondUnit, wholeUnit: true },
    ]);
    const out = join(root, 'out');
    const result = run(['--record', dir, '--set', set, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}boundaries {3}4 epochs=2/m);
    const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
    assert.deepEqual(artifact.epochs.map(epoch => epoch.epochKey), ['sess_fixture#0', 'sess_fixture#1']);
    // End-of-turn: the t2 call sees nothing, the t3 call sees one removal.
    assert.deepEqual(artifact.rows.map(row => row.applied.unitIds.length), [0, 0, 0, 1]);
    assert.deepEqual(artifact.rows.map(row => row.epochIndex), [0, 0, 0, 1]);
    assert.deepEqual(artifact.rows.map(row => row.epochBase), [true, false, false, true]);
    // Receipts land at the first boundary that sees each removal. The t2 decision
    // is seen from t3; the t3 decision has no later boundary, so it is reported
    // as unreached — never rendered at a boundary that cannot see it.
    assert.deepEqual(artifact.receipts.map(receipt => receipt.firstSeenTurn), [3]);
    assert.deepEqual(artifact.unreached.map(entry => entry.turn), [3]);
    assert.ok(artifact.receipts.every(receipt => receipt.decisionTurn < receipt.firstSeenTurn),
      'a receipt renders at a boundary that cannot see its removal');
    // `epoch-checks=ok` is the imported checks' verdict on the read-back file.
    assert.match(result.stdout, /epoch-checks=ok/);

    // The control: corrupt one epoch and both checks must name it.
    const flipped = run(['--record', dir, '--set', set, '--out', out,
      '--flip-epoch', 'sess_fixture#1']);
    assert.equal(flipped.status, 0, flipped.stderr);
    assert.match(flipped.stdout, /epoch-checks=reddened-as-required flip-epoch=ok/);
    assert.match(flipped.stdout, /^ {4}epoch-plan /m);
    assert.match(flipped.stdout, /^ {4}epoch-applied-set /m);
    // An epoch key that does not exist is refused, never silently ignored.
    const unknown = run(['--record', dir, '--set', set, '--out', out,
      '--flip-epoch', 'sess_fixture#9']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^--flip-epoch sess_fixture#9 names no epoch of sess_fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the empty set is the floor: nothing accepted, nothing refused, epoch 0 only', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-empty-'));
  try {
    const dir = writeRecord(root, { plan: fixturePlan() });
    const out = join(root, 'out');
    const result = run(['--record', dir, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}set +empty-set decisions=0/m);
    assert.match(result.stdout, /\(no --set: the empty set, the bracket floor\)/);
    assert.match(result.stdout, /^ {2}accepted +0 \(0 ask, 0 l1\) units=0$/m);
    assert.match(result.stdout, /^ {2}refused +none$/m);
    assert.match(result.stdout, /^ {2}receipts +0 tokens=0$/m);
    assert.match(result.stdout, /epoch-checks=ok/);
    const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
    assert.equal(artifact.epochs.length, 1);
    assert.equal(artifact.epochs[0].appliedRemovalSet, '[]');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed or unfrozen set is refused by name, never guessed at', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-badset-'));
  try {
    const dir = writeRecord(root, { plan: fixturePlan() });
    const out = join(root, 'out');
    const missing = run(['--record', dir, '--set', join(root, 'nope.json'), '--out', out]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^set-absent: /);
    // A set minted by this run cannot be a verdict (design §8).
    const fresh = writeSet(root, [], { source: 'this-run' });
    const refused = run(['--record', dir, '--set', fresh, '--out', out]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^set-not-frozen: the set names this run as its source/);
    // A decision with neither shape is refused on the artifact, by name, and the
    // run still completes: a malformed decision is a refusal, not a crash.
    const shapeless = writeSet(root, [{ turn: 2, unitId: 'unit:sha256:whatever' }]);
    const answered = run(['--record', dir, '--set', shapeless, '--out', out]);
    assert.equal(answered.status, 0, answered.stderr);
    assert.match(answered.stdout, /refused-unknown=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipts render through the shipped receiptLine, one per removal, at the next boundary',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'racoons-removal-receipts-'));
    try {
      const plan = fixturePlan();
      const dir = writeRecord(root, { plan });
      // A decision at t2: turn 3 (the in-flight turn) is the first boundary that
      // sees it, so the receipt renders there.
      const at2 = await unitsAt(plan, 2);
      const unit = at2.byNode.get('u1');
      const set = writeSet(root, [{ turn: 2, unitId: unit, wholeUnit: true, label: 'read once' }]);
      const out = join(root, 'out');
      const result = run(['--record', dir, '--set', set, '--out', out]);
      assert.equal(result.status, 0, result.stderr);
      const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
      assert.equal(artifact.receipts.length, 1);
      const receipt = artifact.receipts[0];
      assert.equal(receipt.firstSeenTurn, 3);
      // The shipped floor receipt for a whole-unit removal: no range segment.
      assert.match(receipt.text, /^\[not retained\] .+ — about: read once · necromancy recall:sha256:[0-9a-f]{64}$/);
      assert.ok(receipt.text.endsWith(receipt.recallId),
        'the recall id on the receipt line is not the minted one');
      assert.match(receipt.recallId, /^recall:sha256:[0-9a-f]{64}$/);
      assert.equal(receipt.wholeUnit, true);
      assert.equal(receipt.tokens, Math.ceil(receipt.byteLength / 4));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('a decision at the last boundary has no boundary left, and is reported as unreached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-unreached-'));
  try {
    const plan = fixturePlan();
    const dir = writeRecord(root, { plan });
    const at3 = await unitsAt(plan, 3);
    const set = writeSet(root, [{ turn: 3, unitId: at3.byNode.get('u0'), wholeUnit: true }]);
    const out = join(root, 'out');
    const result = run(['--record', dir, '--set', set, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unreached=\d+/);
    assert.match(result.stdout, /^ {4}unreached unit:sha256:\w+ turn=3 \(no later boundary/m);
    const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
    assert.equal(artifact.accepted.length, 1, 'the decision itself is still accepted');
    assert.equal(artifact.receipts.length, 0, 'a receipt rendered without a boundary seeing it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The (step, callId) re-key (Phase R v2 §5). A live run is ONE turn with ~100
 * steps and 58 of 97 steps carrying more than one result, so a turn-indexed key
 * never fires. The fixture below is that shape: one turn, three steps, one unit
 * per step. A decision at step 1 must apply from step 2, and a decision at the
 * last step must be accepted but never reach a boundary that shows it.
 */
function singleTurnPlan() {
  return [{
    turnOrdinal: 0,
    turnId: 'turn_1',
    status: 'completed',
    inFlight: false,
    startedAt: 1000,
    completedAt: 1100,
    promptMessageId: null,
    promptOrigin: 'real_user',
    promptVisibility: 'visible',
    nodes: [
      { ...textNode('m0', 100), stepOrdinal: 0 },
      { ...toolNode('s1', 9000), stepOrdinal: 1, callId: 'call_s1' },
      { ...toolNode('s2', 9000), stepOrdinal: 2, callId: 'call_s2' },
      { ...toolNode('s3', 9000), stepOrdinal: 3, callId: 'call_s3' },
    ],
    requests: [1, 2, 3].map(index => ({
      id: `r${index}`, logicalRequestId: `r${index}`, querySource: 'main_turn',
      modelId: 'deepseek-v4.1-flash', status: 'completed',
      startedAt: 1000 + index * 10, inputTokens: 1000 + index,
      cacheReadInputTokens: 0, depth: 1000 + index,
    })),
    requestCount: 3,
    declaredModelRequestCount: 3,
    declaredInputTokens: 3000,
    declaredCacheReadInputTokens: 0,
    declaredToolCallCount: 3,
    fills: [],
    progress: { writesTotal: 0, writesThisTurn: 0 },
  }];
}

test('the lane keys on (step, callId): one turn, three steps, three addresses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-removal-steps-'));
  try {
    const plan = singleTurnPlan();
    const dir = writeRecord(root, { plan, name: 'steps' });
    const { snapshotNodes, boundarySnapshot, boundariesOf } = await import(MODULE);
    const { UnitTracker, planPrunePass } = await import('@cremator/core');
    const nodes = snapshotNodes(plan);
    // The snapshot carries each node's OWN step; a constant 0 would make all
    // three units land at one boundary and the key would address nothing.
    assert.deepEqual(nodes.filter(node => node.kind === 'tool-result').map(node => node.stepOrdinal),
      [1, 2, 3]);

    const boundaries = boundariesOf(plan);
    assert.equal(boundaries.length, 4, 'the record yields one boundary per step');
    assert.deepEqual(boundaries.map(entry => entry.epochIndex), [0, 1, 2, 3]);

    // Step 1's boundary sees only step 1's unit; step 2's sees both.
    const unitsAtStep = step => {
      const boundary = boundarySnapshot(nodes, 0, 'sess_fixture', step);
      const units = new UnitTracker({ sessionId: 'sess_fixture', barBytes: 8192 }).units(boundary);
      const pass = planPrunePass({
        units, nodes: boundary.nodes.filter(node => node.kind === 'tool-result'),
        episodes: [], round: 0, classes: {},
      });
      return new Map(units.map(unit => [unit.nodeId, unit.id, pass.askRows.length]));
    };
    const step1 = unitsAtStep(1);
    const step2 = unitsAtStep(2);
    assert.deepEqual([...step1.keys()].sort(), ['s1']);
    assert.deepEqual([...step2.keys()].sort(), ['s1', 's2']);
    const firstUnit = step1.get('s1');
    const thirdUnit = unitsAtStep(3).get('s3');

    // A decision at step 1 applies from step 2; a decision at step 3 is
    // accepted (the unit landed before it is asked) but unreached.
    const set = writeSet(root, [
      { turn: 0, step: 1, unitId: firstUnit, wholeUnit: true, label: 'step 1' },
      { turn: 0, step: 3, unitId: thirdUnit, wholeUnit: true, label: 'step 3' },
    ]);
    const out = join(root, 'out');
    const result = run(['--record', dir, '--set', set, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}accepted +2 \(2 ask, 0 l1\) units=2$/m);
    assert.match(result.stdout, /^ {2}boundaries {3}4 /m);
    const artifact = JSON.parse(readFileSync(join(out, 'removal.json'), 'utf8'));
    assert.deepEqual(artifact.rows.map(row => row.applied.unitIds.length), [0, 0, 1, 1]);
    // The step-1 receipt renders at step 2; the step-3 one has nowhere to go.
    assert.equal(artifact.receipts.length, 1);
    assert.equal(artifact.receipts[0].firstSeenTurn, 2);
    assert.deepEqual(artifact.receipts[0].decisionStep, 1);
    assert.deepEqual(artifact.unreached.map(entry => entry.turn), [3]);
    assert.equal(artifact.epochChecks, undefined, 'epochChecks is not a field of the artifact');

    // A step that is not a boundary of the record is refused by name.
    const badSet = writeSet(root, [{ turn: 0, step: 9, unitId: firstUnit, wholeUnit: true }]);
    const refused = run(['--record', dir, '--set', badSet, '--out', out]);
    assert.match(refused.stdout, /refused-turn=1/);
    assert.match(refused.stdout, /step 9 is not a boundary of turn 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
