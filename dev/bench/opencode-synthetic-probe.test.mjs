#!/usr/bin/env node
/**
 * The synthetic-message probe's pure half, tested without a host (ISSUE-214 P4
 * style: no binary, no key, no paid call).
 *
 * The live probe is `opencode-synthetic-probe.mjs`; these tests pin the pieces
 * that decide what its evidence means:
 *
 *   - argv parsing and its refusals;
 *   - the composed config (loopback base URL, directory-mounted plugin, the
 *     subagent tool denied, no `compaction` key);
 *   - the generated plugin's contract (default export, the two idle seams, the
 *     synthetic call and its flags);
 *   - message text in both shapes the probe sees (host `ContentPart[]` and the
 *     OpenAI-compatible wire), and the nonce's index/role;
 *   - request classification and per-run counting;
 *   - the verdict: nonce in the context hook, extra main request at idle,
 *     durability across a restart, and the negative case where the nonce never
 *     appears;
 *   - the control: per-request prompt/nonce marking, the synthetic turn's order,
 *     the four single-prompt scenarios and the delta verdict;
 *   - the shipped fixture's host-seedable shape, and each host refusal by name,
 *     read from the real file;
 *   - the seeded copy's relocation to an existing directory;
 *   - the loopback stub's SSE shape and recorded body;
 *   - the on-disk host-store read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  analyzeProbe, classifyStubRequest, composeProbeConfig, CONTROL_SCENARIOS, decideControl,
  hostStoreRows, inspectFixture, jsonSafe, mainRequestsDetail, messageShape, messageText,
  nonceInMessages, parseProbeArgs, probePluginSource, relocateSeededSession, sessionIds,
  startStub, summarizeRequests, syntheticSessionId, syntheticTurnOrder, waitForQuiescence,
} from './opencode-synthetic-probe.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(BENCH_DIR, 'fixtures', 'opencode', 'replay.db');
const PLUGIN_DIR = join('C:', 'probe', 'plugin');

function scratch() {
  return mkdtempSync(join(tmpdir(), 'racoons-synthetic-probe-'));
}

/* ------------------------------------------------------------------ arguments */

test('parseProbeArgs: the documented invocation resolves to the shipped fixture', () => {
  const opts = parseProbeArgs(['--fixture', 'dev/bench/fixtures/opencode/replay.db']);
  assert.equal(opts.fixture, 'dev/bench/fixtures/opencode/replay.db');
  assert.equal(opts.seam, 'hook');
  assert.equal(opts.resume, false);
  assert.equal(opts.delivery, 'steer');
  assert.equal(opts.runs, 3);
  assert.equal(opts.timeoutMs, 120_000);
  assert.equal(opts.control, false);
  assert.equal(opts.preflight, false);
  assert.equal(opts.logLevel, null);
  assert.equal(opts.json, false);
});

test('parseProbeArgs: every flag parses, and the invalid values are refused by name', () => {
  const opts = parseProbeArgs([
    '--fixture', 'f.db', '--opencode-bin', 'C:/opencode.exe', '--evidence', 'E:/ev',
    '--seam', 'event', '--resume', 'true', '--delivery', 'queue', '--runs', '2',
    '--timeout-ms', '30000', '--control', '--preflight', '--log-level', 'debug',
    '--json', '--help',
  ]);
  assert.equal(opts.fixture, 'f.db');
  assert.equal(opts.opencodeBin, 'C:/opencode.exe');
  assert.equal(opts.evidence, 'E:/ev');
  assert.equal(opts.seam, 'event');
  assert.equal(opts.resume, true);
  assert.equal(opts.delivery, 'queue');
  assert.equal(opts.runs, 2);
  assert.equal(opts.timeoutMs, 30_000);
  assert.equal(opts.control, true);
  assert.equal(opts.preflight, true);
  assert.equal(opts.logLevel, 'debug');
  assert.equal(opts.json, true);
  assert.equal(opts.help, true);
  assert.equal(parseProbeArgs(['--delivery', 'none']).delivery, 'none');
  assert.throws(() => parseProbeArgs(['--seam', 'poll']), /--seam must be hook or event/);
  assert.throws(() => parseProbeArgs(['--resume', 'yes']), /--resume must be true or false/);
  assert.throws(() => parseProbeArgs(['--delivery', 'later']), /--delivery must be steer, queue or none/);
  assert.throws(() => parseProbeArgs(['--log-level', 'loud']), /--log-level must be a host level/);
  assert.throws(() => parseProbeArgs(['--runs', '1']), /--runs must be 2\.\.5/);
  assert.throws(() => parseProbeArgs(['--timeout-ms', '9']), /--timeout-ms must be an integer >= 10000/);
  assert.throws(() => parseProbeArgs(['--nope']), /unknown argument "--nope"/);
  assert.throws(() => parseProbeArgs(['--fixture']), /--fixture needs a value/);
});

/* ------------------------------------------------------------------ the world */

test('composeProbeConfig: loopback provider, directory plugin, subagent denied, no compaction key', () => {
  const config = composeProbeConfig({ baseURL: 'http://127.0.0.1:4321/v1', pluginDir: PLUGIN_DIR });
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.model, 'mock/mock-model');
  assert.equal(config.providers.mock.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(config.providers.mock.settings.baseURL, 'http://127.0.0.1:4321/v1');
  assert.equal(config.providers.mock.settings.apiKey, 'mock-key-not-real');
  assert.deepEqual(config.permissions, [{ action: 'subagent', resource: '*', effect: 'deny' }]);
  assert.equal(config.plugins.length, 1);
  assert.equal(config.plugins[0].package, pathToFileURL(PLUGIN_DIR).href);
  // The plugin target must be a directory, not the index file.
  assert.equal(config.plugins[0].package.endsWith('/plugin'), true);
  assert.equal(JSON.stringify(config).includes('compaction'), false);
});

test('probePluginSource: default export, both idle seams, the synthetic flags, no literal nonce', () => {
  const source = probePluginSource();
  assert.match(source, /export default \{/);
  assert.match(source, /id: 'racoons-synthetic-probe'/);
  assert.match(source, /session\.hook\('context'/);
  assert.match(source, /session\.hook\('experimental\.idle'/);
  assert.match(source, /session\.hook\('session\.idle'/);
  assert.match(source, /context\.event\.subscribe\(\{ types: \['session\.idle'\] \}\)/);
  assert.match(source, /session\.synthetic\(args\)/);
  assert.match(source, /resume: RESUME/);
  // The control's scenario 2 sends no `delivery` key at all.
  assert.match(source, /const args = \{/);
  assert.match(source, /if \(DELIVERY !== 'none'\) args\.delivery = DELIVERY;/);
  assert.doesNotMatch(source, /session\.synthetic\(\{/);
  assert.match(source, /CREMATOR_PROBE_NONCE/);
  assert.match(source, /appendFileSync/);
  assert.match(source, /already-admitted-in-this-process/);
  assert.equal(source.includes('RACOONS-SYNTHETIC-PROBE-'), false);
});

/* ------------------------------------------------------------------ messages */

test('messageText: string content, text parts, and a non-text part', () => {
  assert.equal(messageText({ role: 'user', content: 'hello' }), 'hello');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(messageText({ role: 'user', content: [{ type: 'tool-call', id: 'c' }] }), '');
  assert.equal(messageText({ role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'say' }] }), 'say');
  assert.equal(messageText(null), '');
});

test('nonceInMessages: the wire shape and the host shape both report index and role', () => {
  const nonce = 'RACOONS-SYNTHETIC-PROBE-ABC123';
  const wire = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: nonce },
  ];
  const wireHit = nonceInMessages(wire, nonce);
  assert.equal(wireHit.index, 3);
  assert.equal(wireHit.role, 'user');
  assert.equal(wireHit.text, nonce);
  const host = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { id: 'msg_x', role: 'user', content: [{ type: 'text', text: nonce }] },
  ];
  const hostHit = nonceInMessages(host, nonce);
  assert.equal(hostHit.index, 2);
  assert.equal(hostHit.role, 'user');
  const absent = nonceInMessages(wire, 'RACOONS-SYNTHETIC-PROBE-NOT-THERE');
  assert.deepEqual(absent, { index: -1, role: null, text: null, message: null });
  assert.deepEqual(nonceInMessages(null, nonce), { index: -1, role: null, text: null, message: null });
});

test('messageShape and jsonSafe report a shape without throwing', () => {
  assert.deepEqual(messageShape([{ role: 'user' }, { type: 'assistant', role: 'assistant' }]), {
    count: 2, roles: ['user', 'assistant'], types: [null, 'assistant'],
  });
  assert.deepEqual(jsonSafe({ a: 1 }).value, { a: 1 });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(jsonSafe(cyclic).ok, false);
});

/* ------------------------------------------------------------------ requests */

test('classifyStubRequest: models, main, title and other are distinct', () => {
  assert.equal(classifyStubRequest({ method: 'GET', url: '/v1/models', body: null }), 'models');
  assert.equal(classifyStubRequest({
    method: 'POST', url: '/v1/chat/completions',
    body: { tools: [{ type: 'function' }], messages: [] },
  }), 'main');
  assert.equal(classifyStubRequest({
    method: 'POST', url: '/v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'Here is the first message. Reply with only the title.' }] },
  }), 'title');
  assert.equal(classifyStubRequest({
    method: 'POST', url: '/v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'something else' }] },
  }), 'other');
  assert.equal(classifyStubRequest({ method: 'GET', url: '/health', body: null }), 'other');
});

test('summarizeRequests: lanes, main seqs and the nonce hit', () => {
  const nonce = 'RACOONS-SYNTHETIC-PROBE-XYZ';
  const rows = [
    { seq: 1, method: 'GET', url: '/v1/models', body: null },
    { seq: 2, method: 'POST', url: '/v1/chat/completions', body: { tools: [{}], messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'first' }] } },
    { seq: 3, method: 'POST', url: '/v1/chat/completions', body: { tools: [{}], messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'r' }, { role: 'user', content: nonce }] } },
    { seq: 4, method: 'POST', url: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'Reply with only the title.' }] } },
  ];
  const summary = summarizeRequests(rows, nonce);
  assert.equal(summary.total, 4);
  assert.equal(summary.models, 1);
  assert.equal(summary.main, 2);
  assert.equal(summary.title, 1);
  assert.equal(summary.other, 0);
  assert.deepEqual(summary.mainSeqs, [2, 3]);
  assert.equal(summary.firstMainSeq, 2);
  assert.equal(summary.nonceHits.length, 1);
  assert.equal(summary.nonceHits[0].seq, 3);
  assert.equal(summary.nonceHits[0].index, 3);
  assert.equal(summary.nonceHits[0].role, 'user');
});

/* ------------------------------------------------------------------ the control */

test('mainRequestsDetail: prompt and nonce are marked per main request, body kept only with the nonce', () => {
  const nonce = 'RACOONS-SYNTHETIC-CONTROL-S2-AB';
  const prompt = 'CONTROL-ONE: reply with exactly CONTROL-OK';
  const rows = [
    { seq: 1, atMs: 10, method: 'POST', url: '/v1/chat/completions',
      body: { tools: [{}], messages: [{ role: 'system', content: 's' }, { role: 'user', content: prompt }] } },
    { seq: 2, atMs: 20, method: 'POST', url: '/v1/chat/completions',
      body: { tools: [{}], messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: prompt },
        { role: 'assistant', content: 'CONTROL-OK' },
        { role: 'user', content: nonce },
      ] } },
    { seq: 3, atMs: 30, method: 'POST', url: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Reply with only the title.' }] } },
  ];
  const details = mainRequestsDetail(rows, nonce, prompt);
  assert.equal(details.length, 2);
  assert.equal(details[0].seq, 1);
  assert.equal(details[0].carriesPrompt, true);
  assert.equal(details[0].carriesNonce, false);
  assert.equal(details[0].nonceIndex, -1);
  assert.equal('bodyMessages' in details[0], false);
  assert.equal(details[1].seq, 2);
  assert.equal(details[1].carriesNonce, true);
  assert.equal(details[1].nonceIndex, 3);
  assert.equal(details[1].nonceRole, 'user');
  assert.deepEqual(details[1].roles, ['system', 'user', 'assistant', 'user']);
  assert.equal(details[1].bodyMessages.length, 4);
  assert.deepEqual(details.map((row) => row.toolCount), [1, 1]);
  assert.deepEqual(mainRequestsDetail(null, nonce), []);
});

test('syntheticTurnOrder: the append turn is located relative to the prompt turn', () => {
  const detail = (seq, carriesPrompt, carriesNonce) => ({ seq, carriesPrompt, carriesNonce });
  assert.equal(syntheticTurnOrder([detail(2, true, false), detail(3, true, true)]), 'after');
  assert.equal(syntheticTurnOrder([detail(2, true, true), detail(3, true, false)]), 'before');
  assert.equal(syntheticTurnOrder([detail(2, true, true)]), 'no-prompt-turn');
  assert.equal(syntheticTurnOrder([detail(2, true, false)]), 'no-synthetic-turn');
  assert.equal(syntheticTurnOrder([]), 'no-synthetic-turn');
});

test('decideControl: one extra main request per emission is a measured delta', () => {
  const scenario = (id, mainRequests, order) => ({
    id,
    label: `s${id}`,
    mainRequests,
    syntheticTurnOrder: order,
    nonceRequestBodies: mainRequests > 1 ? [{ seq: 3 }] : [],
  });
  const decision = decideControl([
    scenario(1, 1, 'no-synthetic-turn'),
    scenario(2, 2, 'after'),
    scenario(3, 2, 'after'),
    scenario(4, 2, 'after'),
  ]);
  assert.deepEqual(decision.counts, { baseline: 1, resumeFalse: 2, queue: 2, resumeTrue: 2 });
  assert.deepEqual(decision.extraMainRequests, { resumeFalse: 1, queue: 1, resumeTrue: 1 });
  assert.equal(decision.appendCausesModelTurn, true);
  assert.equal(decision.appendCostsExactlyOneMainRequest, true);
  assert.equal(decision.queueDeliveryCausesModelTurn, true);
  assert.equal(decision.resumeTrueCausesModelTurn, true);
  assert.equal(decision.syntheticTurnOrder.resumeFalse, 'after');
  const flat = decideControl([scenario(1, 1, 'no-synthetic-turn'), scenario(2, 1, 'no-synthetic-turn')]);
  assert.equal(flat.appendCausesModelTurn, false);
  assert.equal(flat.appendCostsExactlyOneMainRequest, false);
  assert.equal(flat.counts.queue, null);
  assert.equal(flat.extraMainRequests.queue, null);
  assert.equal(decideControl(null).appendCausesModelTurn, null);
});

test('CONTROL_SCENARIOS: one prompt, four worlds, the flags the question names', () => {
  assert.deepEqual(CONTROL_SCENARIOS.map((row) => row.id), [1, 2, 3, 4]);
  assert.deepEqual(CONTROL_SCENARIOS.map((row) => row.arm), [false, true, true, true]);
  assert.deepEqual(CONTROL_SCENARIOS.map((row) => row.resume), [false, false, false, true]);
  assert.deepEqual(CONTROL_SCENARIOS.map((row) => row.delivery), ['none', 'none', 'queue', 'none']);
  assert.equal(new Set(CONTROL_SCENARIOS.map((row) => row.label)).size, 4);
});

test('syntheticSessionId: the host brand, 26 alphanumerics, deterministic per seed', () => {
  const first = syntheticSessionId('seed');
  assert.match(first, /^ses_[A-Za-z0-9]{26}$/u);
  assert.equal(first, syntheticSessionId('seed'));
  assert.notEqual(first, syntheticSessionId('other'));
});

test('waitForQuiescence: returns after the stub stops moving, and is bounded', async () => {
  let count = 0;
  const stub = { count: () => count };
  const timer = setInterval(() => { if (count < 3) count += 1; }, 10);
  try {
    const settled = await waitForQuiescence(stub, { settleMs: 40, maxMs: 2_000, pollMs: 5 });
    assert.equal(settled.requests, 3);
    assert.equal(settled.timedOut, undefined);
  } finally {
    clearInterval(timer);
  }
  const stuck = await waitForQuiescence({ count: () => 5 }, { settleMs: 10, maxMs: 60, pollMs: 5 });
  assert.equal(stuck.requests, 5);
});

test('relocateSeededSession: the seeded copy points at an existing directory', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'seeded.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL)');
  db.exec('CREATE TABLE project_directory (project_id text, directory text, PRIMARY KEY (project_id, directory))');
  db.exec('CREATE TABLE worktree (project_id text, directory text, PRIMARY KEY (project_id, directory))');
  db.exec('CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, directory text NOT NULL)');
  db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', 'C:\\SYNTHETIC\\old');
  db.prepare('INSERT INTO project_directory VALUES (?, ?)').run('p1', 'C:\\SYNTHETIC\\old');
  db.prepare('INSERT INTO worktree VALUES (?, ?)').run('p1', 'C:\\SYNTHETIC\\old');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('ses_x', 'p1', 'C:\\SYNTHETIC\\old');
  db.close();
  const moved = relocateSeededSession(dbPath, 'ses_x', 'C:\\world\\work');
  assert.deepEqual(moved, { ok: true, from: 'C:\\SYNTHETIC\\old', to: 'C:\\world\\work' });
  const read = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(read.prepare('SELECT directory FROM session_v2 WHERE id = ?').get('ses_x').directory,
      'C:\\world\\work');
    assert.equal(read.prepare('SELECT worktree FROM project WHERE id = ?').get('p1').worktree,
      'C:\\world\\work');
    assert.equal(read.prepare('SELECT directory FROM project_directory').get().directory,
      'C:\\world\\work');
    assert.equal(read.prepare('SELECT directory FROM worktree').get().directory, 'C:\\world\\work');
  } finally {
    read.close();
  }
  assert.equal(relocateSeededSession(dbPath, 'ses_absent', 'C:\\world\\work').ok, false);
});

/* ------------------------------------------------------------------ the verdict */

const NONCE = 'RACOONS-SYNTHETIC-PROBE-ABC123';

function goodJournal(nonce = NONCE) {
  return [
    { kind: 'setup', pid: 10, hasSynthetic: 'function', hasSubscribe: 'function' },
    { kind: 'hook-registered', name: 'context' },
    { kind: 'hook-registered', name: 'experimental.idle' },
    { kind: 'hook-registered', name: 'session.idle' },
    { kind: 'context', pid: 10, line: 5, count: 1, roles: ['user'], nonceIndex: -1, nonceRole: null },
    { kind: 'idle', pid: 10, source: 'hook', sessionID: 'ses_x' },
    { kind: 'store-before', pid: 10, count: 2, types: ['user', 'assistant'], synthetic: [], nonce: [] },
    {
      kind: 'synthetic-return', pid: 10, sessionID: 'ses_x',
      keys: ['id', 'sessionID', 'time', 'type', 'payload', 'delivery'],
      json: { id: 'msg_1', sessionID: 'ses_x', time: { created: 1 }, type: 'synthetic', payload: { text: nonce, description: 'probe' }, delivery: 'steer' },
      type: 'synthetic', delivery: 'steer',
    },
    { kind: 'store-after', pid: 10, count: 2, types: ['user', 'assistant'], synthetic: [], nonce: [] },
    {
      kind: 'context', pid: 10, line: 11, count: 3, roles: ['user', 'assistant', 'user'],
      nonceIndex: 2, nonceRole: 'user', nonceText: nonce,
      nonceMessage: { id: 'msg_1', role: 'user', content: [{ type: 'text', text: nonce }] },
      previous: { id: 'msg_0', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      next: null, toolCount: 11,
    },
    { kind: 'context', pid: 20, line: 5, count: 5, roles: ['user', 'assistant', 'user', 'assistant', 'user'], nonceIndex: 2, nonceRole: 'user', nonceText: nonce },
  ];
}

function run(index, main, nonceHits, firstMainSeq) {
  return {
    index,
    task: `T${index}`,
    arm: index === 1 ? 1 : 0,
    exitCode: 0,
    requests: {
      total: main, main, title: index === 1 ? 1 : 0, other: 0, models: 0,
      mainSeqs: Array.from({ length: main }, (_, offset) => (firstMainSeq ?? 2) + offset),
      nonceHits, firstMainSeq: firstMainSeq ?? null,
    },
  };
}

test('analyzeProbe: the nonce is a user message, an extra main request ran, and it survived a restart', () => {
  const runs = [
    run(1, 2, [{ seq: 3, lane: 'main', index: 3, role: 'user', text: NONCE }], 2),
    run(2, 1, [{ seq: 4, lane: 'main', index: 3, role: 'user', text: NONCE }], 4),
    run(3, 1, [{ seq: 5, lane: 'main', index: 3, role: 'user', text: NONCE }], 5),
  ];
  const analysis = analyzeProbe({
    journal: goodJournal(),
    runs,
    nonce: NONCE,
    resume: false,
    seam: 'hook',
    store: { synthetic: [{ id: 'msg_1', type: 'synthetic' }] },
  });
  assert.equal(analysis.nonceInContextHook, true);
  assert.equal(analysis.contextHook.nonceIndex, 2);
  assert.equal(analysis.contextHook.nonceRole, 'user');
  assert.deepEqual(analysis.contextHook.nonceMessage, { id: 'msg_1', role: 'user', content: [{ type: 'text', text: NONCE }] });
  assert.equal(analysis.contextHookCalls, 3);
  assert.equal(analysis.eventLines, 0);
  assert.equal(analysis.syntheticReturn.json.type, 'synthetic');
  assert.equal(analysis.syntheticReturn.json.delivery, 'steer');
  assert.equal(analysis.wire.run1MainRequests, 2);
  assert.equal(analysis.wire.run1TitleRequests, 1);
  assert.equal(analysis.wire.run1TotalChatRequests, 3);
  assert.equal(analysis.wire.extraMainRequestAfterIdle, true);
  assert.equal(analysis.wire.run1MainRequestsBeyondOnePrompt, 1);
  assert.equal(analysis.durability.run2CarriesNonce, true);
  assert.equal(analysis.durability.run3CarriesNonce, true);
  assert.deepEqual(analysis.durability.syntheticStoreRows, [{ id: 'msg_1', type: 'synthetic' }]);
  assert.equal(analysis.delivery, 'steer');
});

test('analyzeProbe: with no nonce at all the verdict is a named absence, not a zero', () => {
  const runs = [run(1, 1, [], 2), run(2, 1, [], 3)];
  const analysis = analyzeProbe({
    journal: [
      { kind: 'setup' },
      { kind: 'hook-registered', name: 'context' },
      { kind: 'context', line: 5, count: 1, roles: ['user'], nonceIndex: -1 },
      { kind: 'idle-noop', source: 'hook', reason: 'arm=0' },
    ],
    runs,
    nonce: NONCE,
    resume: false,
    seam: 'event',
    store: { synthetic: [] },
  });
  assert.equal(analysis.nonceInContextHook, false);
  assert.equal(analysis.contextHook, null);
  assert.equal(analysis.syntheticReturn, null);
  assert.equal(analysis.wire.run1MainRequests, 1);
  assert.equal(analysis.wire.extraMainRequestAfterIdle, false);
  assert.equal(analysis.wire.run1MainRequestsBeyondOnePrompt, 0);
  assert.equal(analysis.durability.run2CarriesNonce, false);
  assert.deepEqual(analysis.durability.syntheticStoreRows, []);
});

/* ------------------------------------------------------------------ the fixture */

test('inspectFixture: the shipped fixture is host-seedable', () => {
  const fixture = inspectFixture(FIXTURE);
  assert.equal(fixture.ok, true, fixture.refusals.join('; '));
  assert.match(fixture.sessionId, /^ses_[A-Za-z0-9]{26}$/u);
  assert.equal(fixture.sessionId, 'ses_RAC00NS5YNTH3T1C0000000000');
  assert.equal(fixture.messageCount, 124);
  // Fixture provenance: the committed replay.db was built by the 2.2.5-era
  // builder, so its session row records 2.2.5. The bench target moves
  // independently of this artifact.
  assert.equal(fixture.version, '2.2.5');
  assert.ok(fixture.sha256 !== null && fixture.sha256.length === 64);
  assert.deepEqual(fixture.refusals, []);
  const model = JSON.parse(fixture.model);
  // The fixture stores the model the mock route runs (`mock/mock-model`); a
  // different stored model is rewritten by the host when it resumes the session.
  assert.equal(model.id, 'mock-model');
  assert.equal(model.providerID, 'mock');
  assert.deepEqual(fixture.workspaceColumns,
    ['id', 'provider', 'binding', 'created_at', 'last_used_at']);
  assert.equal(fixture.messageIdsBranded, 124);
  assert.equal(fixture.messageIdsTotal, 124);
});

test('inspectFixture: each host refusal is reported by name', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'refused.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_v2 (id text PRIMARY KEY, version text, model text, '
    + 'project_id text, time_created integer)');
  db.exec('CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text)');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)')
    .run('RACOONS-SYNTHETIC-SESSION-0001', '2.4.0', 'synthetic/racoons-fixture-model', 'p', 1);
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?)')
    .run('RACOONS-SYNTHETIC-MESSAGE-0001', 'RACOONS-SYNTHETIC-SESSION-0001', 'user');
  db.close();
  const fixture = inspectFixture(dbPath);
  assert.equal(fixture.ok, false);
  assert.equal(fixture.refusals.length, 4);
  assert.match(fixture.refusals[0], /is not ses_ \+ 26 alphanumerics/);
  assert.match(fixture.refusals[1], /message id\(s\) are not msg_ \+ 26 alphanumerics/);
  assert.match(fixture.refusals[2], /is not JSON/);
  assert.match(fixture.refusals[3], /no workspace table/);
});

test('inspectFixture: a missing file is a refusal, not a throw', () => {
  const fixture = inspectFixture(join(tmpdir(), 'racoons-synthetic-probe-missing.db'));
  assert.equal(fixture.ok, false);
  assert.equal(fixture.sessionId, null);
  assert.match(fixture.refusals[0], /no database at/);
});

/* ------------------------------------------------------------------ the stub */

test('startStub: answers the OpenAI-compatible SSE shape and records the request body', async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'requests.jsonl');
  const stub = await startStub({ logPath });
  t.after(() => stub.close());
  const body = {
    model: 'mock-model',
    stream: true,
    tools: [{ type: 'function', function: { name: 'read' } }],
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: NONCE }],
  };
  const response = await fetch(`${stub.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /PROBE-STUB-REPLY/);
  assert.match(text, /\[DONE\]/);
  const rows = stub.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].url, '/v1/chat/completions');
  assert.deepEqual(rows[0].body, body);
  assert.equal(rows[0].bodyParseError, false);
  const models = await fetch(`${stub.url}/models`);
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, 'mock-model');
});

/* ------------------------------------------------------------------ the store */

test('hostStoreRows and sessionIds read the rows the host wrote', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_v2 (id text PRIMARY KEY, time_created integer)');
  db.exec('CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)');
  db.exec('CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text, type text, payload text, delivery text, enqueued_seq integer, time_created integer)');
  const insertSession = db.prepare('INSERT INTO session_v2 (id, time_created) VALUES (?, ?)');
  insertSession.run('ses_old', 1);
  insertSession.run('ses_new', 2);
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'msg_1', 'ses_new', 'synthetic', 13, 100, 101,
    JSON.stringify({ time: { created: 100 }, text: NONCE, description: 'probe' }),
  );
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'msg_2', 'ses_new', 'user', 4, 90, 90, JSON.stringify({ time: { created: 90 }, text: 'first', files: [] }),
  );
  db.prepare('INSERT INTO session_inbox VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'in_1', 'ses_new', 'synthetic', JSON.stringify({ text: NONCE }), 'queue', 1, 100,
  );
  db.close();
  const store = hostStoreRows(dbPath, 'ses_new');
  assert.equal(store.synthetic.length, 1);
  assert.equal(store.synthetic[0].id, 'msg_1');
  assert.equal(store.synthetic[0].data.text, NONCE);
  assert.equal(store.inbox.length, 1);
  assert.equal(store.inbox[0].delivery, 'queue');
  assert.deepEqual(sessionIds(dbPath), ['ses_old', 'ses_new']);
  assert.deepEqual(sessionIds(join(dir, 'missing.db')), []);
});

/* ------------------------------------------------------------------ evidence files */

