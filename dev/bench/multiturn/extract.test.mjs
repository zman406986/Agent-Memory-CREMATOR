#!/usr/bin/env node
/**
 * Chunk 1's gate: `extract.mjs` must turn one snapshot session into the three
 * files the design names, and its `--check` must fail by name on both defects it
 * names.
 *
 * Every fixture is built here, so this runs on either device without the 18 GB
 * snapshot. The fixtures are small but shaped like the real store: `turn_usage`
 * carries the turn boundary, `model_usage` carries one row per request, a
 * session-title request carries `turn_id = null` (the residue the design says to
 * report and never drop), and a fill is two `compaction` rows that must not be
 * counted twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./extract.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

/** Bytes of a text part, the same quantity the extractor renders. */
const textBytes = text => Buffer.byteLength(text, 'utf8');

/**
 * A two-turn fixture with a known depth model.
 *
 *   m0 (visible user, 400 B)      request r0: input 1100 -> prefix 1000
 *   m1 (visible assistant, 800 B) request r1: input 1300 -> depth 1300 exactly
 *   m2 (hidden user, 9000 B)      contributes no node and no live bytes
 *   m3 (visible assistant, tool)  request r2: depth 1000 + 1230/4 = 1308
 *   r-zero                        input 0: exempt, counted by name
 *   title request                 turn_id null: residue, exempt from the tolerance gate
 *
 * Turn t1 (completed) holds r0 and r1; turn t2 (running) holds r2 and r-zero.
 */
function buildFixture(root, options = {}) {
  const path = join(root, 'snapshot.sqlite');
  const r2Tokens = options.r2Tokens ?? 1300;
  const db = new DatabaseSync(path);
  db.exec(`
    create table session (id text primary key, parent_id text, task_type text,
      time_created integer, time_updated integer);
    create table message (id text primary key, session_id text not null, time_created integer,
      time_updated integer, data text not null, sequence integer);
    create table part (id text primary key, message_id text not null, session_id text not null,
      time_created integer, time_updated integer, data text not null, sequence integer);
    create table turn_usage (session_id text not null, turn_id text not null, user_message_id text,
      status text not null, started_at integer not null, completed_at integer,
      model_request_count integer not null default 0, tool_call_count integer not null default 0,
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0, primary key (session_id, turn_id));
    create table model_usage (id text primary key, logical_request_id text not null,
      session_id text not null, turn_id text, parent_user_message_id text, assistant_message_id text,
      query_source text not null, model_id text not null, status text not null,
      started_at integer not null, input_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0);
    create table tool_usage (id text primary key, session_id text not null, tool_call_id text not null,
      tool_name text not null, status text not null, output_bytes integer not null default 0);
  `);
  const session = options.session ?? 'sess_fixture';
  db.prepare('insert into session values (?, null, ?, ?, ?)')
    .run(session, 'interactive', 100, 9000);

  const insertMessage = (id, sequence, time, fields) => db.prepare(
    'insert into message values (?, ?, ?, ?, ?, ?)',
  ).run(id, session, time, time, JSON.stringify(fields), sequence);
  const insertPart = (id, messageId, sequence, time, fields) => db.prepare(
    'insert into part values (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, messageId, session, time, time, JSON.stringify(fields), sequence);

  insertMessage('m0', 0, 1000, {
    role: 'user',
    semantics: { origin: 'real_user', providerVisibility: 'visible' },
    anchor: { turnId: 't1' },
  });
  insertPart('p0', 'm0', 0, 1000, { type: 'text', text: 'A'.repeat(400) });
  insertPart('p0-structural', 'm0', 1, 1000, { type: 'step-start' });

  insertMessage('m1', 1, 3000, {
    role: 'assistant',
    semantics: { origin: 'agent_runtime', providerVisibility: 'visible' },
    anchor: { turnId: 't1' },
  });
  insertPart('p1', 'm1', 0, 3000, { type: 'text', text: 'B'.repeat(800) });

  insertMessage('m2', 2, 3500, {
    role: 'user',
    semantics: { origin: 'agent_runtime', providerVisibility: 'hidden' },
    anchor: { turnId: 't2' },
  });
  insertPart('p2', 'm2', 0, 3500, { type: 'text', text: 'C'.repeat(9000) });

  insertMessage('m3', 3, 4000, {
    role: 'assistant',
    semantics: { origin: 'agent_runtime', providerVisibility: 'visible' },
    anchor: { turnId: 't2' },
  });
  insertPart('p3', 'm3', 0, 4000, {
    type: 'tool',
    tool: 'Write',
    callID: 'call_1',
    state: { status: 'completed', input: { file_path: 'src/a.ts' }, output: 'ok' },
  });
  insertPart('p3-structural', 'm3', 1, 4000, { type: 'step-finish' });

  db.prepare('insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    session, 't1', 'm0', 'completed', 1200, 3600,
    options.declaredForT1 ?? 2, 1, 2400, 10, 0,
  );
  db.prepare('insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    session, 't2', 'm2', 'running', 3700, null,
    options.declaredForT2 ?? 2, 1, r2Tokens, 5, 0,
  );

  const insertRequest = (id, turnId, source, startedAt, inputTokens) => db.prepare(
    'insert into model_usage values (?, ?, ?, ?, null, null, ?, ?, ?, ?, ?, 0)',
  ).run(id, id, session, turnId, source, 'deepseek-v4.1-flash', 'completed', startedAt, inputTokens);

  insertRequest('r0', 't1', 'main_turn', 2000, 1100);   // prefix 1000 + 400/4
  insertRequest('r1', 't1', 'main_turn', 3100, options.r1Tokens ?? 1300); // 1000 + 1200/4
  insertRequest('r2', 't2', 'main_turn', 4100, r2Tokens); // 1000 + 1231/4 = 1308
  insertRequest('r-zero', options.zeroTurnId ?? 't2', 'main_turn', 4200, 0); // exempt: no observed depth
  // The title row is residue by default; `titleTurnId` binds it to a turn, the
  // shape the store writes (a `session_title` request inside a turn).
  insertRequest('r-title', options.titleTurnId ?? null, 'session_title', 1100, 500);

  db.prepare('insert into tool_usage values (?, ?, ?, ?, ?, ?)')
    .run('tu1', session, 'call_1', 'Write', 'completed', 2);
  db.close();
  return { path, session };
}

function writeDigest(dbPath, digest) {
  const digestPath = dbPath.replace(/\.sqlite$/, '.sha256');
  writeFileSync(digestPath, `${digest}  snapshot.sqlite\n`);
  return digestPath;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('extract writes exactly the three contract files with the manifest the later chunks read', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-'));
  try {
    const { path: dbPath, session } = buildFixture(root);
    writeDigest(dbPath, 'a'.repeat(64));
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out]);
    assert.equal(result.status, 0, `extract.mjs failed:\n${result.stderr}`);

    // The four printed numbers the design names. Three nodes: p0, p1 and p3.
    // The hidden message's part is a node too, flagged `providerVisible: false`,
    // and structural parts are never nodes.
    assert.match(result.stdout, /^ {2}turns {7}2$/m);
    assert.match(result.stdout, /^ {2}nodes {7}4$/m);
    assert.match(result.stdout, /^ {2}requests {4}5$/m); // r0, r1, r2, r-zero, r-title
    assert.match(result.stdout, /^ {2}fills {7}0$/m);

    // Exactly the contract's files, nothing else.
    assert.deepEqual(readdirSync(out).sort(), ['calibration.json', 'manifest.json', 'turns.jsonl']);

    const turns = readFileSync(join(out, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map(turn => turn.turnOrdinal), [0, 1]);
    assert.equal(turns[0].requestCount, 2);
    assert.equal(turns[0].declaredModelRequestCount, 2);
    assert.equal(turns[1].inFlight, true, 'the running turn is not marked in flight');
    assert.equal(turns[0].inFlight, false);
    // The prompt's origin comes from the message the turn names.
    assert.equal(turns[0].promptOrigin, 'real_user');
    // A hidden message still appears as a node, flagged, so the plan is complete.
    const hiddenNode = turns[1].nodes.find(node => node.id === 'p2');
    assert.equal(hiddenNode.providerVisible, false);
    assert.equal(hiddenNode.bytes, 9000);
    // Structural parts are not nodes.
    assert.equal(turns.flatMap(turn => turn.nodes.map(node => node.id)).includes('p0-structural'), false);
    assert.equal(turns.flatMap(turn => turn.nodes.map(node => node.id)).includes('p3-structural'), false);
    // Node bytes are the rendered length, not the stored JSON length.
    assert.equal(turns[0].nodes.find(node => node.id === 'p0').bytes, 400);

    const manifest = readJson(join(out, 'manifest.json'));
    assert.equal(manifest.snapshot.digest, 'a'.repeat(64), 'the digest is not read from the digest file');
    assert.equal(manifest.selected.turns, 2);
    assert.equal(manifest.selected.nodes, 4);
    assert.equal(manifest.selected.requests, 5);
    assert.equal(manifest.selected.fills, 0);
    assert.equal(manifest.pinned.seed, 0);
    assert.equal(manifest.pinned.byteQuotient, 4);
    // No fills in this fixture: no observed threshold, and the branch says so.
    assert.equal(manifest.pinned.threshold, null);
    assert.equal(manifest.pinned.W, null);
    assert.equal(manifest.pinned.branch, 'route-threshold');
    for (const key of ['turns', 'nodes', 'requests', 'fills']) {
      assert.match(manifest.selectedSha256[key], /^[0-9a-f]{64}$/, `selectedSha256.${key} is not a digest`);
    }

    const calibration = readJson(join(out, 'calibration.json'));
    assert.equal(calibration.estimator, 'depth = base(segment) + bytesAfterTail(excluding summary) / 4');
    // r0 fixes the prefix at 1000; r1 sits exactly on the model.
    assert.equal(calibration.baseBySegment.length, 1);
    assert.equal(calibration.baseBySegment[0].base, 1000);
    assert.equal(calibration.baseBySegment[0].anchor, 'measured-prefix');
    const byId = new Map(calibration.residuals.map(entry => [entry.requestId, entry]));
    assert.equal(byId.get('r1').depth, 1300);
    assert.equal(byId.get('r1').residual, 0);
    // r2's depth is the same base plus the visible bytes after m1 (m3's tool part).
    assert.equal(byId.get('r2').depth, 1000 + Math.round(1231 / 4));
    // Two exemptions, each counted by name and neither gated.
    assert.equal(calibration.residualSummary.exemptZeroInput, 1);
    assert.equal(calibration.residualSummary.exemptNonTranscript, 1);
    assert.equal(byId.has('r-title'), false);
    assert.equal(byId.has('r-zero'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check fails by name when a turn holds main_turn rows it does not declare', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-requests-'));
  try {
    // t1 holds r0 and r1 (two main_turn rows) and declares one: one row is in
    // no bucket, so the four buckets sum to 4, not the 5 model_usage rows.
    const { path: dbPath, session } = buildFixture(root, { declaredForT1: 1 });
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 1, '--check passed an unaccounted main_turn row');
    assert.match(result.stderr, /^requests: 1 turn\(s\) hold more main_turn rows than they declare/m);
    assert.match(result.stderr, /^ {2}unaccounted-main_turn turn t1 rows 2 declared 1 deficit 1$/m);
    assert.match(result.stderr, /^requests: buckets declared 3 \+ inTurnNotDeclared 0 \+ nullTurnId 1 \+ unboundTurnId 0 = 4 != model_usage rows 5$/m);
    assert.match(result.stdout, /gate {8}requests=FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an in-turn session_title row is a printed class, not a gate failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-inturn-title-'));
  try {
    // The store's exact shape that used to read FAIL: t1 holds 2 main_turn rows
    // and 1 session_title row, and declares 2. The title row is bound and not
    // declared, so a two-bucket gate saw a 1-row disagreement.
    const { path: dbPath, session } = buildFixture(root, { titleTurnId: 't1' });
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `--check failed a bound non-transcript row:\n${result.stderr}`);
    assert.match(result.stdout, /gate {8}requests=ok \(declared 4 \+ inTurnNotDeclared 1 \+ nullTurnId 0 \+ unboundTurnId 0 = 5 vs rows 5\)/);
    assert.match(result.stdout, /buckets {5}declaredAndCounted=4 inTurnNotDeclared=session_title=1 nullTurnId=0 unboundTurnId=0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a model_usage row whose turn_id names no turn_usage row is named, not folded into residue', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-unbound-turn-'));
  try {
    // r-zero's turn_id names no turn of the record: the fourth bucket.
    const { path: dbPath, session } = buildFixture(root, { zeroTurnId: 'turn_missing', titleTurnId: 't1' });
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `--check failed a fully bucketed fixture:\n${result.stderr}`);
    // r-zero's turn_id names no turn of the record: the fourth bucket. t2 then
    // holds one main_turn row (r2) and declares two, so only one is counted.
    assert.match(result.stdout, /gate {8}requests=ok \(declared 3 \+ inTurnNotDeclared 1 \+ nullTurnId 0 \+ unboundTurnId 1 = 5 vs rows 5\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check fails by name when the estimate leaves the MEASURED tolerance envelope', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-tolerance-'));
  try {
    // The segment base is measured on the first comparable request, so r0 always
    // sits on the model. Moving r1 and r2 two-thirds out puts the median of the
    // three absolute residuals far outside the measured envelope: {0, .675, .74}
    // -> .675, against an envelope of .2972 (tolerance.mjs).
    const { path: dbPath, session } = buildFixture(root, { r1Tokens: 4000, r2Tokens: 5000 });
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 1, '--check passed an estimate outside the measured envelope');
    assert.match(result.stderr, /^estimate-tolerance: median residual .* leaves the measured envelope 29\.7%/m);
    assert.match(result.stdout, /gate .*estimate=FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a median residual between the old ±20% band and the measured envelope passes, so the band is replaced and not blended', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-replaced-'));
  try {
    // r1 observed 1040 against a depth of 1300 is exactly +25.0%; r2 observed
    // 1046 against 1308 is +25.05%. Median of {0, .25, .2505} = .25: above the
    // retired ±20% band and below the measured envelope (.2972). The old gate
    // would have failed this fixture; the measured one must pass it.
    const { path: dbPath, session } = buildFixture(root, { r1Tokens: 1040, r2Tokens: 1046 });
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `the measured gate refused a 25% median:\n${result.stderr}`);
    assert.match(result.stdout, /residual {4}median=25\.0%/);
    assert.match(result.stdout, /tolerance=29\.7% \(measured envelope\)/);
    const calibration = readJson(join(out, 'calibration.json'));
    assert.equal(calibration.tolerance, 0.297191, 'the gate did not read the measured envelope');
    assert.equal(calibration.residualSummary.tolerance, 0.297191);
    // The retired field is gone: a reader cannot mistake the new gate for a band.
    assert.equal(Object.hasOwn(calibration, 'band'), false);
    assert.equal(Object.hasOwn(calibration.residualSummary, 'withinBand'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check is green when the estimate is consistent, and reports the residue', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-green-'));
  try {
    const { path: dbPath, session } = buildFixture(root);
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `--check failed a consistent fixture:\n${result.stderr}`);
    assert.match(result.stdout, /gate {8}requests=ok \(declared 4 \+ inTurnNotDeclared 0 \+ nullTurnId 1 \+ unboundTurnId 0 = 5 vs rows 5\) fills=ok estimate=ok/);
    assert.match(result.stdout, /residue {5}unturned=1 exemptZeroInput=1 exemptNonTranscript=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fill is counted once from its two compaction rows, and supplies the observed threshold', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-fill-'));
  try {
    const { path: dbPath, session } = buildFixture(root);
    // Add one fill: the operation row plus its boundary row, joined on boundaryId.
    const db = new DatabaseSync(dbPath);
    insertCompaction(db, session, { boundaryId: 'compact_1', turnId: 't1' });
    db.close();

    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `extract.mjs failed with a fill:\n${result.stderr}`);
    assert.match(result.stdout, /^ {2}fills {7}1$/m, 'both compaction rows were counted, or none');

    const manifest = readJson(join(out, 'manifest.json'));
    assert.equal(manifest.selected.fills, 1);
    assert.equal(manifest.pinned.threshold, 166000);
    assert.equal(manifest.pinned.thresholdSource, 'observed-fill');
    assert.equal(manifest.pinned.W, 207500);
    assert.equal(manifest.pinned.branch, 'observed-fill');

    const turns = readFileSync(join(out, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const fill = turns[0].fills[0];
    assert.equal(fill.preCompactTokenCount, 1000);
    assert.equal(fill.truePostCompactTokenCount, 200);
    assert.equal(fill.autoCompactThreshold, 166000);
    assert.equal(fill.tailMessageId, 'm0');
    // r2 is the first comparable request after the fill, so its segment's base
    // is measured there: the depth is the segment's own anchor.
    const calibration = readJson(join(out, 'calibration.json'));
    assert.equal(calibration.baseBySegment.length, 2);
    assert.deepEqual(calibration.baseBySegment.map(entry => entry.segment), [-1, 0]);
    assert.equal(calibration.baseBySegment[1].observedTruePost, 200);
    assert.equal(calibration.baseBySegment[1].anchor, 'measured-at-first-request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * One fill: the operation row plus its boundary row, joined on `boundaryId`.
 * `auto` false spells a user-typed `/compact`; `turnId` names the boundary's
 * turn (`null` for a boundary that names no turn of the record).
 */
function insertCompaction(db, session, options = {}) {
  const boundaryId = options.boundaryId ?? 'compact_1';
  const auto = options.auto ?? true;
  const operation = {
    type: 'compaction',
    auto,
    trigger: auto ? 'auto' : 'manual',
    phase: 'mid_turn',
    compactReason: auto ? 'context_limit' : 'user_requested',
    timelineStatus: 'completed',
    boundaryId,
    summaryMessageId: 'm1',
    tail_start_id: 'm0',
    preCompactTokenCount: options.preCompactTokenCount ?? 1000,
    postCompactTokenCount: 400,
    truePostCompactTokenCount: 200,
    time: { start: options.start ?? 3200, end: options.end ?? 3300 },
  };
  const boundary = {
    type: 'compaction',
    auto,
    trigger: auto ? 'auto' : 'manual',
    phase: 'mid_turn',
    compactReason: auto ? 'context_limit' : 'user_requested',
    tail_start_id: 'm0',
    operationId: `op_${boundaryId}`,
    compactBoundary: {
      boundaryId,
      autoCompactThreshold: options.autoCompactThreshold ?? 166000,
      summarizedMessageCount: 2,
      keptMessageCount: 1,
      summaryMessageIds: ['m1'],
      turnId: options.turnId ?? 't1',
    },
  };
  db.prepare('insert into part values (?, ?, ?, ?, ?, ?, ?)')
    .run(`op-${boundaryId}`, 'm1', session, 3300, 3300, JSON.stringify(operation), 90);
  db.prepare('insert into part values (?, ?, ?, ?, ?, ?, ?)')
    .run(`bnd-${boundaryId}`, 'm1', session, 3301, 3301, JSON.stringify(boundary), 91);
}

test('a user-typed /compact is not an auto fill: it is counted apart and seeds no segment', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-user-compact-'));
  try {
    const { path: dbPath, session } = buildFixture(root);
    const db = new DatabaseSync(dbPath);
    insertCompaction(db, session, {
      boundaryId: 'compact_user', turnId: 't1', auto: false, autoCompactThreshold: 100000,
    });
    db.close();

    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 0, `extract.mjs failed on a user compaction:\n${result.stderr}`);
    assert.match(result.stdout, /^ {2}fills {7}0$/m, 'a user /compact was counted as an auto fill');
    assert.match(result.stdout, /userCompact\. 1/);

    const manifest = readJson(join(out, 'manifest.json'));
    assert.equal(manifest.selected.fills, 0);
    assert.equal(manifest.selected.userCompactions, 1);
    assert.equal(manifest.pinned.threshold, null, 'a user compaction supplied the auto threshold');
    assert.equal(manifest.pinned.branch, 'route-threshold');

    const turns = readFileSync(join(out, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(turns.flatMap(turn => turn.fills).length, 0);
    const calibration = readJson(join(out, 'calibration.json'));
    assert.equal(calibration.baseBySegment.length, 1, 'a user compaction seeded a depth segment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an auto fill that binds to no turn is named, kept out of selected.fills, and reddens the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-unbound-fill-'));
  try {
    const { path: dbPath, session } = buildFixture(root);
    const db = new DatabaseSync(dbPath);
    // One fill the record holds, and one whose boundary names no turn.
    insertCompaction(db, session, { boundaryId: 'compact_bound', turnId: 't1' });
    insertCompaction(db, session, {
      boundaryId: 'compact_stray',
      turnId: 'turn_missing',
      start: 100,
      end: 200,
      autoCompactThreshold: 166000,
    });
    db.close();

    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', session, '--out', out, '--check']);
    assert.equal(result.status, 1, '--check passed a fill that no turn holds');
    assert.match(result.stdout, /^ {2}fills {7}2$/m);
    assert.match(result.stdout, /^ {2}unboundFills 1$/m);
    assert.match(result.stdout, /gate .*fills=FAIL/);
    assert.match(result.stderr, /^fills: selected 1 != attached 1, unbound 1$/m);
    assert.match(result.stderr, /unbound-fill compact_stray turn turn_missing window 100\.\.200 requests 0/);

    const manifest = readJson(join(out, 'manifest.json'));
    assert.equal(manifest.selected.fills, 1, 'an unbound fill was counted in selected.fills');
    assert.equal(manifest.selected.fillsTotal, 2);
    assert.equal(manifest.selected.unboundFills, 1);
    assert.equal(manifest.unboundFills.length, 1);
    const named = manifest.unboundFills[0];
    assert.equal(named.boundaryId, 'compact_stray');
    assert.equal(named.turnId, 'turn_missing');
    assert.equal(named.startedAt, 100);
    assert.equal(named.completedAt, 200);
    assert.equal(named.requestsInWindow, 0);

    const turns = readFileSync(join(out, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const attached = turns.reduce((total, turn) => total + turn.fills.length, 0);
    assert.equal(attached, manifest.selected.fills, 'the manifest and turns.jsonl disagree on fills');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown session exits 2 and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'racoons-extract-unknown-'));
  try {
    const { path: dbPath } = buildFixture(root);
    const out = join(root, 'record');
    const result = run(['--db', dbPath, '--session', 'sess_missing', '--out', out]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown session: sess_missing/);
    assert.equal(existsSync(out), false, 'a refused run created the output directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing arguments are refused before the database is opened', () => {
  const result = run(['--db', 'x.sqlite', '--session', 'sess_x']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--db, --session and --out are required/);
});
