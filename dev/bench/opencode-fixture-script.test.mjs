#!/usr/bin/env node
/**
 * The fixture script's gate.
 *
 * Run: `node --test dev/bench/opencode-fixture-script.test.mjs`
 *
 * Offline only: no host binary, no key, no network, no paid call. The tests:
 *
 *   1. the shipped `fixture.script.json` is byte-identical to a fresh build,
 *      and `--verify` exits 0 on it;
 *   2. every reply parses, names a unique turn and carries a content key the
 *      mock checks (`tool_results_count` plus `last_user_contains` /
 *      `last_tool_result_contains`);
 *   3. every key string is one the request carries: the run's task text the
 *      host appends after the seeded history, or a substring of the fixture's
 *      last tool result, and the first two counts are the fixture's 12 tool
 *      results and 13 after the first new read;
 *   4. the restore lane calls `necromancy` once per `[not retained]` receipt —
 *      the seeded read (`RACOONS-SYNTHETIC-CALL-0005`) and the scripted first
 *      read of `big-b.log`, the fixture's 22,417-byte largest result — and each
 *      placeholder names the call id its receipt carries;
 *   5. the runner's own `validateFixture` accepts the file, so the lanes and
 *      calls are the shape the bench reads;
 *   6. `--verify` exits 1 on a mutated copy and names the first difference;
 *   7. two builds are byte-identical (determinism).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFixture } from './opencode-removal-fixture.mjs';
import {
  DB_FILE, SCRIPT_FILE,
  buildFixtureScript, fixtureFacts, scriptText, verifyFixtureScript,
} from './opencode-fixture-script.mjs';
import {
  fixtureUnitFileText, fixtureUnitResultText,
} from './opencode-fixture-build.mjs';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const BUILDER = join(BENCH_DIR, 'opencode-fixture-script.mjs');
const FIXTURE_DIR = join(BENCH_DIR, 'fixtures', 'opencode');
const DB_PATH = join(FIXTURE_DIR, DB_FILE);
const SCRIPT_PATH = join(FIXTURE_DIR, SCRIPT_FILE);
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');
const READER_CAP_BYTES = 50 * 1024;
const PRODUCT_BAR_BYTES = 512;

const FACTS = fixtureFacts(DB_PATH, MANIFEST_PATH);
const SCRIPT = buildFixtureScript(FACTS);

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cremator-opencode-fixture-script-'));
}

function run(args) {
  return spawnSync(process.execPath, [BUILDER, ...args], { encoding: 'utf8' });
}

test('the shipped script is exactly what this fixture produces', () => {
  const onDisk = readFileSync(SCRIPT_PATH, 'utf8');
  assert.equal(onDisk, scriptText(SCRIPT));
  const verified = verifyFixtureScript({ dbPath: DB_PATH, scriptPath: SCRIPT_PATH });
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.ok, true);
  const cli = run(['--verify']);
  assert.equal(cli.status, 0, cli.stderr);
});

test('every reply parses and carries a content key the mock checks', () => {
  assert.ok(Array.isArray(SCRIPT.replies));
  assert.equal(SCRIPT.replies.length, 5);
  const names = new Set();
  for (const [index, entry] of SCRIPT.replies.entries()) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(names.has(entry.name), false, `reply name ${entry.name} is used twice`);
    names.add(entry.name);
    assert.equal(entry.match.main_turn, index, `${entry.name} is keyed to turn ${index}`);
    assert.equal(Number.isSafeInteger(entry.match.tool_results_count), true,
      `${entry.name} names no absolute tool_results_count`);
    const keyed = (Array.isArray(entry.match.last_user_contains)
      && entry.match.last_user_contains.length > 0)
      || (Array.isArray(entry.match.last_tool_result_contains)
        && entry.match.last_tool_result_contains.length > 0);
    assert.equal(keyed, true, `${entry.name} names no content key`);
    assert.equal(typeof entry.reply.reasoning, 'string');
    assert.ok(entry.reply.reasoning.length > 0, `${entry.name} carries no reasoning`);
  }
});

test('every content key string is the run task or the fixture\'s own result', () => {
  const task = SCRIPT.task;
  assert.equal(FACTS.messageCount, 124);
  assert.equal(FACTS.toolResultCount, 12);
  assert.equal(FACTS.reasoningPartCount, 61);
  assert.equal(FACTS.largestResult.bytes, 22_417);
  for (const entry of SCRIPT.replies) {
    for (const needle of entry.match.last_user_contains) {
      assert.equal(task.includes(needle), true,
        `${entry.name} keys on a task string the script does not carry: ${needle}`);
    }
    for (const needle of entry.match.last_tool_result_contains ?? []) {
      assert.equal(FACTS.lastToolResult.text.includes(needle), true,
        `${entry.name} keys on a tool result the fixture does not hold: ${needle}`);
    }
  }
  // The fixture supplies 12 tool results. The first reply sees them all; the
  // request after the first live read still sees 12 because the seeded copy of
  // that file is superseded and replaced by a receipt (+1 read, -1 seeded unit).
  assert.equal(SCRIPT.replies[0].match.tool_results_count, FACTS.toolResultCount);
  assert.equal(SCRIPT.replies[1].match.tool_results_count, FACTS.toolResultCount);
  assert.equal(SCRIPT.replies[2].match.tool_results_count, FACTS.toolResultCount + 1);
  // The restore turn issues one result per receipt, so the DONE request carries
  // both restored units.
  assert.equal(SCRIPT.replies[3].match.tool_results_count, FACTS.toolResultCount + 2);
  assert.equal(SCRIPT.replies[4].match.tool_results_count, FACTS.toolResultCount + 4);
});

test('the restore turn calls necromancy once per receipt in context', () => {
  const lane = SCRIPT.fixture.lanes[0];
  assert.equal(lane.rule, 'superseded-read');
  assert.equal(lane.unitFiles.length, 1);
  const unitFile = lane.unitFiles[0];
  assert.equal(unitFile, 'big-b.log');
  const unit = SCRIPT.fixture.files.find((file) => file.name === unitFile);
  // `bytes` is the world file's own size. The seeded result is the host's read
  // of that file, so it is larger: the header and the `n: ` prefixes are part of
  // the result bytes a live re-read produces.
  assert.equal(unit.bytes, 20_962);
  assert.equal(unit.bytes, Buffer.byteLength(fixtureUnitFileText(unitFile)));
  assert.equal(FACTS.largestResult.text, fixtureUnitResultText());
  assert.ok(unit.bytes >= PRODUCT_BAR_BYTES, 'the unit must clear the product bar');
  assert.ok(unit.bytes < READER_CAP_BYTES, 'the unit must be below the reader cap to restore whole');
  assert.equal(unit.sentinel.includes('RACOONS-SYNTHETIC'), false,
    'the unit sentinel must not collide with the fixture\'s own result sentinels');
  const restores = SCRIPT.replies.flatMap((entry) => (entry.reply.calls ?? [])
    .filter((call) => call.name === 'necromancy')
    .map((call) => ({ turn: entry.match.main_turn, call })));
  assert.equal(restores.length, 2, 'one necromancy call per receipt in context');
  const tokens = restores.map(({ call }) => {
    const match = /^\{\{RECALL_ID:(.+)\}\}$/u.exec(call.input.id);
    assert.ok(match !== null, `the restore input is not a recall placeholder: ${call.input.id}`);
    return match[1];
  });
  assert.deepEqual(tokens.sort(), [lane.unitCalls[0], FACTS.largestResult.callId].sort(),
    'the placeholders name the two receipt targets by call id, not the file path');
  for (const { turn } of restores) {
    assert.ok(turn > 1, 'the restores must follow the removals the re-read proves');
  }
});

test('every expected read declares its fixture sentinel', () => {
  const sentinels = new Map([
    ...SCRIPT.fixture.files.map((file) => [file.name, file.sentinel]),
    ...SCRIPT.fixture.auxiliary.map((file) => [file.name, file.sentinel]),
  ]);
  assert.equal(SCRIPT.expectedReads['big-b.log'].count, 2);
  assert.equal(SCRIPT.expectedReads['big-b-twin.txt'].count, 1);
  for (const [name, row] of Object.entries(SCRIPT.expectedReads)) {
    assert.equal(Number.isSafeInteger(row.count) && row.count > 0, true, name);
    assert.equal(row.sentinel, sentinels.get(name),
      `${name} must declare the fixture's own sentinel`);
    assert.equal(typeof row.sentinel, 'string');
    assert.ok(row.sentinel.length >= 8, `${name} names no usable sentinel`);
  }
});

test('the runner\'s own fixture validator accepts the shipped script', () => {
  const checked = validateFixture(JSON.parse(readFileSync(SCRIPT_PATH, 'utf8')));
  assert.equal(checked.ok, true, checked.refused);
});

test('--verify exits 1 on a mutated copy and names the first difference', () => {
  const dir = scratch();
  try {
    const copy = join(dir, SCRIPT_FILE);
    const text = readFileSync(SCRIPT_PATH, 'utf8');
    writeFileSync(copy, text.replace('"main_turn": 2', '"main_turn": 9'), 'utf8');
    const result = run(['--verify', '--out', dir]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /first difference at line/u);
    assert.match(result.stderr, /main_turn/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two builds are byte-identical', () => {
  const first = scriptText(buildFixtureScript(fixtureFacts(DB_PATH, MANIFEST_PATH)));
  const second = scriptText(buildFixtureScript(fixtureFacts(DB_PATH, MANIFEST_PATH)));
  assert.equal(first, second);
});
