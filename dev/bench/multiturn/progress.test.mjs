#!/usr/bin/env node
/**
 * Chunk 4's gate: the progress clock must be live.
 *
 * The design's broken state (§8): the interpolator returns the end-of-job value.
 * With it, `--flip-progress` would leave every progress-aligned reading
 * unchanged, because nothing would depend on the coordinate. So the gate is:
 * every progress-aligned reading (R1, R2, E1, E3, E4, E5) moves when the clock
 * advances to the next actual change, and R3 — which carries no progress term —
 * stays byte-identical. A moving R3 is a scoping bug; a surviving reading is a
 * dead clock.
 *
 * Fixtures are records plus arms written here (`turns.jsonl`, `manifest.json`,
 * `arms/<session>/<arm>/…`, the chunk-1/chunk-3 contracts), so this runs on
 * either device without the 18 GB snapshot. P2's fixture is a SQLite store with
 * the store's own message/part shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = new URL('./progress.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MODULE = new URL('./progress.mjs', import.meta.url).href;
const REPO_ROOT = resolve(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..', '..',
);

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function writeNode(id, filePath, { tool = 'Write', status = 'completed', bytes = 100 } = {}) {
  return {
    id, kind: 'tool', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool, callId: `call_${id}`, status, filePath,
  };
}

function textNode(id, bytes = 50) {
  return {
    id, kind: 'text', role: 'assistant', origin: 'agent_runtime', providerVisible: true,
    bytes, tool: null, callId: null, status: null, filePath: null,
  };
}

/**
 * Four turns, so the clock has three knots (2 -> 5 -> 6) and the flip has a real
 * next change at every value except the last. Depths give both lanes one forced
 * loss inside turn 0 and a crossing of every R2 milestone.
 */
function fixtureTurns() {
  return [
    {
      turnId: 'turn_0', promptOrigin: 'real_user', depths: [30, 40, 60],
      nodes: [textNode('n0'), writeNode('w0a', 'C:\\work\\a.ts'),
        writeNode('w0b', 'c:/work/b.ts'), writeNode('w0x', 'src/error.ts', { status: 'error' })],
      writesTotal: 2,
    },
    {
      turnId: 'turn_1', promptOrigin: 'real_user', depths: [70, 80],
      nodes: [textNode('n1'), writeNode('w1a', 'src/a.ts', { tool: 'Edit' })],
      writesTotal: 3,
    },
    {
      turnId: 'turn_2', promptOrigin: 'agent_runtime', depths: [90, 95],
      nodes: [textNode('n2'), writeNode('w2a', 'src/c.ts'), writeNode('w2b', 'src/d.ts'),
        writeNode('w2c', 'src/e.ts')],
      writesTotal: 6,
    },
    {
      turnId: 'turn_3', promptOrigin: 'real_user', depths: [100, 105],
      nodes: [textNode('n3'), writeNode('w3a', 'src/f.ts')],
      writesTotal: 7,
    },
  ];
}

function planOf(turns) {
  let at = 1000;
  return turns.map((turn, ordinal) => {
    const requests = turn.depths.map((depth, index) => {
      at += 10;
      return {
        id: `r${ordinal}_${index}`, logicalRequestId: `r${ordinal}_${index}`,
        querySource: 'main_turn', modelId: 'deepseek-v4.1-flash', status: 'completed',
        startedAt: at, inputTokens: depth, cacheReadInputTokens: depth,
        depth,
      };
    });
    return {
      turnOrdinal: ordinal,
      turnId: turn.turnId,
      status: 'completed',
      inFlight: false,
      startedAt: requests[0].startedAt,
      completedAt: requests[requests.length - 1].startedAt + 5,
      promptMessageId: null,
      promptOrigin: turn.promptOrigin,
      promptVisibility: 'visible',
      nodes: turn.nodes,
      nodeCount: turn.nodes.length,
      nodeBytes: turn.nodes.reduce((total, node) => total + node.bytes, 0),
      requests,
      requestCount: requests.length,
      declaredModelRequestCount: requests.length,
      declaredInputTokens: turn.depths.reduce((total, depth) => total + depth, 0),
      declaredCacheReadInputTokens: 0,
      declaredToolCallCount: turn.nodes.filter(node => node.kind === 'tool').length,
      fills: [],
      // The record's own counter is computed over RAW paths; the fixture's third
      // turn writes the same file through two spellings, so a normalization
      // difference would show as drift. Here it does not: every fixture path is
      // distinct even raw, so drift must be 0 on this fixture.
      progress: { writesTotal: turn.writesTotal, writesThisTurn: 0 },
    };
  });
}

function writeRecord(root, { turns, threshold = 100, sessionId = 'sess_fixture', name = 'rec' }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const plan = planOf(turns);
  writeFileSync(join(dir, 'turns.jsonl'), `${plan.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({
    schema: 'racoons-multiturn-record/1',
    snapshot: { digest: 'a'.repeat(64) },
    session: { id: sessionId },
    selected: { turns: plan.length, prompts: plan.filter(t => t.promptOrigin === 'real_user').length },
    pinned: {
      threshold, thresholdSource: 'observed-fill',
      W: threshold === null ? null : Math.round(threshold / 0.8),
      branch: 'fixture', byteQuotient: 4, seed: 0, prefixTokens: 100,
    },
  }, null, 2)}\n`);
  return { dir, plan };
}

/** One lane's arms, written from a depth function and a forced-loss list. */
function writeArm(root, { sessionId = 'sess_fixture', arm, plan, depthOf, losses }) {
  const dir = join(root, 'arms', sessionId, arm);
  mkdirSync(dir, { recursive: true });
  const samples = [];
  let i = 0;
  for (const turn of plan) {
    for (const _ of turn.requests) {
      samples.push({ i, turn: turn.turnOrdinal, depth: depthOf(i), progress: 0 });
      i++;
    }
  }
  writeFileSync(join(dir, 'series.jsonl'),
    `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n`);
  writeFileSync(join(dir, 'events.jsonl'), losses.length === 0 ? ''
    : `${losses.map(loss => JSON.stringify({
      kind: 'forced-loss', arm, index: loss.index, turn: loss.turn,
      trigger: 100, triggerSource: 'observed-fill', pre: depthOf(loss.index),
      post: loss.post ?? 10, overshoot: 1,
    })).join('\n')}\n`);
}

/**
 * Both lanes at the fixture's own depths: request index 1 (turn 0, pre 40) is
 * the one forced loss, so R1 lands inside the first turn and the flip moves it.
 */
function writeArms(root, plan) {
  const depthOf = i => plan.flatMap(turn => turn.requests)[i].depth;
  for (const arm of ['traditional', 'racoons']) {
    writeArm(root, { arm, plan, depthOf, losses: [{ index: 1, turn: 0 }] });
  }
}

/** The fields the CLI prints for one reading line, as text. */
const readingLine = (stdout, name) => stdout.split('\n')
  .find(line => line.trimStart().startsWith(`${name} `)) ?? '';

test('the P1 clock counts distinct normalized files and never decreases', async () => {
  const { p1Series, clockOf, flipClock } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-p1-'));
  try {
    const { plan } = writeRecord(root, { turns: fixtureTurns() });
    const p1 = p1Series(plan);
    // `C:\work\a.ts` and `c:/work/b.ts`: the drive letter folds, so `a.ts` and
    // `b.ts` are two files; the erroring write is not counted.
    assert.deepEqual(p1.values, [2, 3, 6, 7]);
    assert.equal(p1.files, 7);
    assert.equal(p1.changes.length, 7);
    assert.equal(p1.drift.length, 0);
    const clock = clockOf(p1.values);
    assert.deepEqual(clock.distinct, [2, 3, 6, 7]);
    assert.equal(clock.knots, 4);
    // The flip advances to the NEXT actual change; the last value keeps itself.
    assert.deepEqual(flipClock(clock).perTurn, [3, 6, 7, 7]);
    assert.deepEqual(flipClock(clock).distinct, [3, 6, 7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1 reports a record counter that disagrees with the normalized set, never silently', async () => {
  const { p1Series } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-drift-'));
  try {
    // Two spellings of ONE file: the record's raw counter says 2, P1 says 1.
    const { plan } = writeRecord(root, {
      turns: [{
        turnId: 'turn_0', promptOrigin: 'real_user', depths: [10],
        nodes: [textNode('n'), writeNode('w1', 'C:\\x\\same.ts'), writeNode('w2', 'c:/x/same.ts')],
        writesTotal: 2,
      }],
    });
    const p1 = p1Series(plan);
    assert.equal(p1.values[0], 1);
    assert.deepEqual(p1.drift, [{ turn: 0, recorded: 2, computed: 1 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the interpolator is linear inside a turn span and clamped outside it', async () => {
  const { interpolateAt, integral } = await import(MODULE);
  const points = [[0, 100], [10, 200], [30, 200]];
  assert.equal(interpolateAt(points, 0), 100);
  assert.equal(interpolateAt(points, 5), 150, 'inside the span is linear');
  assert.equal(interpolateAt(points, 10), 200);
  assert.equal(interpolateAt(points, 20), 200);
  assert.equal(interpolateAt(points, 30), 200, 'the horizon clamps');
  assert.equal(interpolateAt(points, 300), 200, 'a lane is never read past its horizon');
  assert.equal(interpolateAt([], 3), null);
  // Area: 10 * (100+200)/2 + 20 * 200, and the same area per 100 units of P1.
  const area = integral(points);
  assert.equal(area.area, 5500);
  assert.equal(area.span, 30);
  assert.equal(area.per100, Math.round((5500 / 30) * 100));
  const flat = integral([[0, 50], [5, 50]]);
  assert.deepEqual(flat, { area: 250, span: 5, per100: 5000 });
  // A single point has no span: the cost per unit of work is undefined, not 0.
  assert.deepEqual(integral([[7, 50]]), { area: 0, span: 0, per100: null });
});

test('--flip-progress moves every progress-aligned reading and leaves R3 fixed', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-flip-'));
  try {
    const { dir, plan } = writeRecord(root, { turns: fixtureTurns() });
    writeArms(dir, plan);
    const baseline = run(['--record', dir, '--db', join(root, 'absent.sqlite')]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /^ {2}knots {8}2,3,6,7 value-set=2,3,6,7$/m);
    assert.match(baseline.stdout, /R1 {11}progress=2 depth=40/);
    assert.match(baseline.stdout, /gate {9}monotone=ok$/m);

    const flipped = run(['--record', dir, '--db', join(root, 'absent.sqlite'), '--flip-progress']);
    assert.equal(flipped.status, 0, flipped.stderr);
    // The control advances to the next actual change, not by a constant.
    assert.match(flipped.stdout, /^ {2}knots {8}3,6,7,7 value-set=3,6,7$/m);
    assert.match(flipped.stdout, /^ {2}flip +next-knot/m);
    assert.match(flipped.stdout, /flip-progress=ok r3=fixed/);
    for (const key of ['R1', 'R2', 'E1', 'E3', 'E4', 'E5']) {
      assert.match(flipped.stdout, new RegExp(`^ {4}${key} +moved`, 'm'),
        `${key} survived the flip: the progress clock is dead`);
    }
    assert.match(flipped.stdout, /^ {4}R3 +fixed .*byte-identical$/m);
    // R3's fields are the same text before and after: it has no progress term.
    assert.equal(readingLine(flipped.stdout, 'R3'), readingLine(baseline.stdout, 'R3'));
    // And the readings really moved, not just their labels.
    assert.notEqual(readingLine(flipped.stdout, 'R1'), readingLine(baseline.stdout, 'R1'));
    assert.notEqual(readingLine(flipped.stdout, 'E1'), readingLine(baseline.stdout, 'E1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a flat clock is refused by name: a flip with no actual change tests nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-flat-'));
  try {
    const turns = [
      { turnId: 'turn_0', promptOrigin: 'real_user', depths: [10, 20],
        nodes: [textNode('n'), writeNode('w', 'src/a.ts')], writesTotal: 1 },
      { turnId: 'turn_1', promptOrigin: 'real_user', depths: [30],
        nodes: [textNode('n1'), writeNode('w2', 'src/a.ts')], writesTotal: 1 },
    ];
    const { dir, plan } = writeRecord(root, { turns });
    writeArms(dir, plan);
    const refused = run(['--record', dir, '--db', join(root, 'absent.sqlite'), '--flip-progress']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^progress-clock-flat: the p1 coordinate has 1 knot/);
    // Without the flag the run is fine: one knot is a legitimate record.
    const plain = run(['--record', dir, '--db', join(root, 'absent.sqlite')]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /knots {8}1,1 value-set=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3 carries no clock: two reads on different clocks are deep-equal', async () => {
  const { readAll, clockOf, flipClock, laneReadings, flattenRequests } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-r3-'));
  try {
    const { dir, plan } = writeRecord(root, { turns: fixtureTurns() });
    writeArms(dir, plan);
    const requests = flattenRequests(plan);
    const samples = requests.map((request, i) => ({
      i, turn: request.turn, depth: request.depth,
    }));
    const events = [{ kind: 'forced-loss', index: 1, turn: 0, pre: 40 }];
    const clock = clockOf([2, 3, 6, 7]);
    const lane = list => laneReadings({
      lane: 'traditional', samples: list, events, requests, clock,
      threshold: 100, horizon: { progress: 7, index: 8 },
    });
    const base = readAll({
      traditional: lane(samples), racoons: lane(samples), clock, threshold: 100,
      requests, horizon: { progress: 7, index: 8 },
    });
    const flippedClock = flipClock(clock);
    const flippedLane = list => laneReadings({
      lane: 'traditional', samples: list, events, requests, clock: flippedClock,
      threshold: 100, horizon: { progress: 7, index: 8 },
    });
    const flipped = readAll({
      traditional: flippedLane(samples), racoons: flippedLane(samples),
      clock: flippedClock, threshold: 100, requests, horizon: { progress: 7, index: 8 },
    });
    assert.deepEqual(flipped.R3, base.R3, 'R3 moved with the clock: a progress term leaked in');
    assert.notDeepEqual(flipped.R1, base.R1);
    // The horizon is a coordinate and moves with the clock.
    assert.equal(base.horizonProgress, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A store with the message/part shape P2 reads, and one TodoWrite history. */
function writeP2Store(root, { turnIds, snapshots }) {
  const path = join(root, 'p2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`create table message (id text primary key, session_id text, sequence integer,
    time_created integer, data text)`);
  db.exec(`create table part (id text primary key, message_id text, session_id text,
    sequence integer, time_created integer, data text)`);
  const insertMessage = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  const insertPart = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)');
  snapshots.forEach((snapshot, index) => {
    const messageId = `m${index}`;
    // A snapshot whose turn is not in the plan is deliberately possible: it is
    // the unattributed case, and it must be counted, never assigned.
    const turnId = snapshot.turnId ?? turnIds[index] ?? `turn_missing_${index}`;
    insertMessage.run(messageId, 'sess_fixture', index, 1000 + index,
      JSON.stringify({ role: 'assistant', anchor: { turnId } }));
    insertPart.run(`p${index}`, messageId, 'sess_fixture', 0, 1000 + index, JSON.stringify({
      type: 'tool', tool: 'TodoWrite', callID: `c${index}`,
      state: { status: 'completed', input: { todos: snapshot.todos }, output: 'ok' },
    }));
  });
  db.close();
  return path;
}

test('P2 counts items transitioning into completed, with the first snapshot as baseline', async () => {
  const { p2Series } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-p2-'));
  try {
    const turns = ['turn_0', 'turn_1', 'turn_2'];
    const store = writeP2Store(root, {
      turnIds: turns,
      snapshots: [
        // Baseline: one item already completed, so it is NOT a transition.
        { turnId: 'turn_0', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
        // b completes; a stays completed (no second transition); c appears pending.
        { turnId: 'turn_0', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'pending' }] },
        // c completes in turn 1.
        { turnId: 'turn_1', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'completed' }] },
        // c vanishes from the list; the list is rewritten each call, so a
        // vanished item is simply not completed any more.
        { turnId: 'turn_1', todos: [{ content: 'a', status: 'completed' }, { content: 'c', status: 'pending' }] },
        // c completes again: a new transition, because the diff says so.
        { turnId: 'turn_2', todos: [{ content: 'c', status: 'completed' }] },
      ],
    });
    const plan = [{ turnOrdinal: 0, turnId: 'turn_0' }, { turnOrdinal: 1, turnId: 'turn_1' },
      { turnOrdinal: 2, turnId: 'turn_2' }];
    const db = new DatabaseSync(store, { readOnly: true });
    let p2;
    try {
      p2 = p2Series(db, 'sess_fixture', plan);
    } finally {
      db.close();
    }
    assert.equal(p2.snapshots, 5);
    assert.equal(p2.baseline, 1, 'the first snapshot is a baseline, not a transition');
    // b in turn 0, c in turn 1, and c again in turn 2 (the list was rewritten
    // without c in between, so c's second completion is a real transition).
    assert.equal(p2.changes.length, 3);
    assert.equal(p2.unattributed.length, 0);
    assert.deepEqual(p2.values, [1, 2, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2 attributes a transition to no turn rather than to a neighbour', async () => {
  const { p2Series } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-p2-unattr-'));
  try {
    const store = writeP2Store(root, {
      turnIds: ['turn_0', 'turn_1'],
      snapshots: [
        { turnId: 'turn_0', todos: [{ content: 'a', status: 'pending' }] },
        { turnId: 'turn_1', todos: [{ content: 'a', status: 'completed' }] },
        { turnId: 'turn_gone', todos: [{ content: 'a', status: 'completed' }, { content: 'z', status: 'completed' }] },
      ],
    });
    const plan = [{ turnOrdinal: 0, turnId: 'turn_0' }, { turnOrdinal: 1, turnId: 'turn_1' }];
    const db = new DatabaseSync(store, { readOnly: true });
    let p2;
    try {
      p2 = p2Series(db, 'sess_fixture', plan);
    } finally {
      db.close();
    }
    // `a` completes in turn_1, which the plan owns; `z` completes in a turn the
    // plan does not own, so it is counted out, not folded into turn_1.
    assert.deepEqual(p2.values, [0, 1], 'an unowned transition must not land in a real turn');
    assert.equal(p2.unattributed.length, 1);
    assert.equal(p2.unattributed[0].content, 'z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('p2 without a store is refused for --coordinate p2 and absent otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-p2-absent-'));
  try {
    const { dir, plan } = writeRecord(root, { turns: fixtureTurns() });
    writeArms(dir, plan);
    const missing = join(root, 'no-such-store.sqlite');
    const refused = run(['--record', dir, '--db', missing, '--coordinate', 'p2']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^p2-unavailable: /);
    const p1 = run(['--record', dir, '--db', missing]);
    assert.equal(p1.status, 0, p1.stderr);
    assert.match(p1.stdout, /^ {2}p2 +absent \(.*no-such-store\.sqlite is not on this device; P2 is robustness only\)$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a store with no TodoWrite history reads absent, never progress zero', async () => {
  const { p2Series } = await import(MODULE);
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-p2-empty-'));
  try {
    const { dir, plan } = writeRecord(root, { turns: fixtureTurns() });
    writeArms(dir, plan);
    // The store exists but holds no completed TodoWrite snapshot for the session.
    const store = writeP2Store(root, { turnIds: ['turn_0'], snapshots: [] });
    const db = new DatabaseSync(store, { readOnly: true });
    let p2;
    try {
      p2 = p2Series(db, 'sess_fixture', plan);
    } finally {
      db.close();
    }
    assert.equal(p2.snapshots, 0);
    const same = run(['--record', dir, '--db', store]);
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /^ {2}p2 +absent \(the store holds no completed TodoWrite snapshot/m);
    const refused = run(['--record', dir, '--db', store, '--coordinate', 'p2']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^p2-unavailable: the store holds no completed TodoWrite snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('arms that do not line up with the record are refused, never scored', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-progress-misalign-'));
  try {
    const { dir, plan } = writeRecord(root, { turns: fixtureTurns() });
    writeArms(dir, plan);
    // Drop one sample from the racoons arm: every later index would be off by one.
    const path = join(dir, 'arms', 'sess_fixture', 'racoons', 'series.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines.slice(0, -1).join('\n')}\n`);
    const misaligned = run(['--record', dir, '--db', join(root, 'absent.sqlite')]);
    assert.equal(misaligned.status, 2);
    assert.match(misaligned.stderr, /^series-misaligned: racoons has 8 samples against 9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

