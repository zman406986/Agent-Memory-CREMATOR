#!/usr/bin/env node
// Gate 1 — live cache smoke for the FORK/TABLE ASK shape (ISSUE-035 item 3;
// Ruling 7 gate 1).
//
//   node dev/sim/gate1-fork-cache.mjs            # same as --plan: offline, no calls
//   node dev/sim/gate1-fork-cache.mjs --plan     # print the exact 3-call plan, exit 0
//   node dev/sim/gate1-fork-cache.mjs --live --owner-authorized [--kill-timer-s 300]
//
// WHAT IT CHECKS. The fork the mount grows for a table ask (since ADR-0028 the
// bulk prune is the one asker): seed from main's last sent wire request
// (system, tools, messages), append the ask as a user turn, append the answer as
// an assistant turn, append the next ask. Three
// calls through the SHIPPED `tableAsk` composition and the SHIPPED
// `seedFork`/`appendAsk`/`appendVerdict` growth. Pass criterion (Ruling 7 gate 1,
// ISSUE-035 item 3):
//   (1) calls 2 and 3 each byte-extend call 1's message-array prefix;
//   (2) the provider reports cache-read tokens > 0 on call 2;
//   (3) the provider reports cache-read tokens > 0 on call 3.
// The cache-read field is `usage.prompt_tokens_details.cached_tokens` only, by
// design: that is the field the product reads; top-level `cached_tokens` and
// `cache_read_input_tokens` are dead signals. `prompt_cache_hit_tokens` was
// ABSENT on the 2026-10-23 ISSUE-026 probe but PRESENT on all three calls of
// the 2026-10-24 live run (0 / 3456 / 4224, equal to `cached_tokens` each
// time; evidence: scratchpad/gate1/2026-10-24/
// gate1-fork-cache-2026-10-24T03-54-54-957Z.json). The gate still reads
// `cached_tokens` alone — the alias is provider-only. Raw usage is stored
// verbatim.
//
// OFFLINE BY DEFAULT. --plan builds and asserts the exact payloads, prints the
// plan and the criterion, and exits 0 without opening a socket. --live refuses
// unless --owner-authorized is also passed: the live run is a PENDING HUMAN GATE
// on the owner's a6 authorization, not something this script may start alone.
//
// PRIOR ART (cited, not imported):
//   scratchpad/spike-008/v4/probe-fork/2026-10-23/evidence.md
//     the fork shape measured on a6: append 92.0%, double-append 96.1%,
//     in-place byte-extension 0.0% (raw JSON beside it).
//   dev/bench/cache-probe.mjs
//     the ISSUE-019 probe: the in-process key-reading pattern and the raw-usage
//     evidence shape reused here.
//   dev/dsh-rig/scenarios/prune-apply-auto.json
//     the shape source: the prune lane's table asks appended over main's
//     untouched system slot. The rig scripts one lane now (ADR-0028); this gate
//     still sends three asks because the cache relation needs a third call.
//
// WHY THIS SHAPE AND NOT THE FAILED EPOCH SMOKE. The 2026-10-24 epoch smoke
// (commit 064acd6) byte-extended the last message in place and read 0 hits on
// all three calls; the ISSUE-026 probe measured that exact in-place shape at
// 0.0% against a warm prefix. The fork APPENDS whole messages, the shape that
// probe measured at 92.0%/96.1%. This gate asserts the append relation before
// it sends anything.
//
// THE REPLY BETWEEN ASKS. The assistant turn is the deterministic table answer
// the rig scripts (`{{tableAnswer}}` -> keepall JSON), not the
// model's live reply, so the plan and the live run send the same bytes. The
// production fork appends the model's actual reply; that changes only the
// appended assistant bytes, never the prefix relation under test.
//
// LAWS. Kill timer armed before the first call (default 300 s, --kill-timer-s
// override), hard exit 124. A6_API_KEY is read IN-PROCESS from
// ~/.dsh/.credentials.yaml (C:\Users\TZhen\.dsh\ or C:\Users\TZ\.dsh\), never
// printed, logged, or exported. At most 3 calls, one attempt each, no retries;
// the first call error aborts. Evidence only under the gitignored
// scratchpad/gate1/<yyyy-mm-dd>/ and never committed.
//
// Exit codes: 0 plan or live PASS, 1 live FAIL, 2 usage or missing input.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';
import { timerDelayRefusal } from '../shared/timer-ms.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCENARIO = path.join(REPO_ROOT, 'dev', 'dsh-rig', 'scenarios', 'prune-apply-auto.json');
// Both dist trees are overridable so the non-vacuity probe can point the gate at
// a deliberately broken copy of the shipped code and watch it go red.
const CORE_DIST = process.env.CREMATOR_CORE_DIST
  ? path.resolve(process.env.CREMATOR_CORE_DIST)
  : path.join(REPO_ROOT, 'packages', 'core', 'dist');
const CORE_ENTRY = path.join(CORE_DIST, 'index.js');
const ADAPTER_DIST = process.env.CREMATOR_ADAPTER_DIST
  ? path.resolve(process.env.CREMATOR_ADAPTER_DIST)
  : path.join(REPO_ROOT, 'packages', 'adapters', 'dsh', 'dist');
const ADAPTER_ENTRY = path.join(ADAPTER_DIST, 'judge-tables.js');
const CRED = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml');
const CALL_TIMEOUT_MS = 120000;

function refuse(message) {
  console.error(`gate1-fork-cache: REFUSED — ${message}`);
  process.exit(2);
}

// The flags this gate reads, declared once so the shared parser can bind a
// negative value to its option (ISSUE-072). `--nonce` and the numeric knobs are
// all strings here; the conversions below are this script's own.
const GATE1_OPTIONS = optionsOf([
  ['--live', 'boolean'],
  ['--plan', 'boolean'],
  ['--owner-authorized', 'boolean', 'ownerAuthorized'],
  ['--kill-timer-s', 'string', 'killTimerS'],
  ['--gap-s', 'string', 'gapS'],
  ['--base', 'string'],
  ['--model', 'string'],
  ['--nonce', 'string'],
]);
const { values: GATE1 } = parseDevArgs(process.argv.slice(2), {
  options: GATE1_OPTIONS,
  refuse,
  prefix: 'gate1-fork-cache: ',
});
const LIVE = GATE1.live ?? false;
const PLAN_FLAG = GATE1.plan ?? false;
const OWNER = GATE1.ownerAuthorized ?? false;
if (LIVE && PLAN_FLAG) refuse('--live and --plan are exclusive; nothing was sent');
const KILL_S = Number(GATE1.killTimerS ?? '300');
const GAP_S = Number(GATE1.gapS ?? '10');
const BASE = String(GATE1.base ?? 'https://api.a6api.com/v1');
const MODEL = String(GATE1.model ?? 'deepseek-v4.1-flash-1017');
if (!Number.isFinite(KILL_S) || KILL_S <= 0) refuse('--kill-timer-s must be a positive number of seconds');
if (LIVE && KILL_S < 30) refuse('--kill-timer-s must be at least 30 seconds for a live run');
// The timer is armed from this value as milliseconds; above the platform
// maximum it would fire at 1 ms, so it is refused in either mode (ISSUE-580).
const tooLongKill = timerDelayRefusal(Math.round(KILL_S * 1000), '--kill-timer-s (converted to ms)');
if (tooLongKill !== null) refuse(tooLongKill);
if (!Number.isFinite(GAP_S) || GAP_S < 0) refuse('--gap-s must be a non-negative number of seconds');

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const DAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const STAMP = now.toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(REPO_ROOT, 'scratchpad', 'gate1', DAY);
const OUT_FILE = path.join(OUT_DIR, `gate1-fork-cache-${STAMP}.json`);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Load one shipped entry; a missing build is a named exit 2, not a stack trace. */
async function loadShipped(file, names, label) {
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    refuse(`${label} ${file} is not loadable: ${error?.message ?? error} (build it first)`);
  }
  const absent = names.filter((name) => module[name] === undefined);
  if (absent.length > 0) refuse(`${label} ${file} lacks: ${absent.join(', ')}`);
  return module;
}

const core = await loadShipped(
  CORE_ENTRY,
  ['seedFork', 'appendAsk', 'appendVerdict', 'PRUNE_ASK_SYSTEM_PROMPT',
    'PRUNE_ASK_FINAL_LINE', 'PRUNE_ASK_TABLE_HEADING',
    // The row factory and its unit cutter: the table's rows are the product's
    // own, not a hand-built anchor shape (ISSUE-058 changed it to `anchors`).
    'buildPruneAskRows', 'UnitTracker', 'toBytes', 'sha256Sync'],
  'the shipped core entry',
);
const adapter = await loadShipped(ADAPTER_ENTRY, ['tableAsk'], 'the shipped adapter entry');

// Deterministic filler: no RNG, no clock, no locale (cache-probe.mjs construction).
const WORDS = ['harbor', 'lattice', 'copper', 'meadow', 'signal', 'canyon', 'fabric', 'orchard',
  'lantern', 'glacier', 'cobalt', 'tally', 'marrow', 'abacus', 'kettle', 'quartz'];
function filler(n) {
  let s = '';
  for (let i = 0; i < n; i += 1) {
    const w = [];
    for (let j = 0; j < 8; j += 1) w.push(WORDS[(i * 7 + j * 3) % WORDS.length]);
    s += `record ${String(i).padStart(4, '0')}: ${w.join(' ')}; checksum ${((i * 2654435761) >>> 0).toString(16)};\n`;
  }
  return s;
}

const NONCE = String(GATE1.nonce ?? `GATE1-FORK-${DAY}-${crypto.randomBytes(4).toString('hex')}`)
  .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
if (NONCE === '') refuse('--nonce left no usable characters');

// Main's wire, as the fork seeds it: the scenario's task, one tool, one big
// tool result, and the system slot the fork never rewrites. The 100-record
// filler is the size ISSUE-019 proved cacheable on this endpoint (~2343 tokens).
const SYSTEM = `nonce ${NONCE}\n${filler(100)}`;
const TOOLS = [{
  name: 'pwsh',
  description: 'Run a PowerShell command in the working directory.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The command to run.' } },
    required: ['command'],
  },
}];
const TASK = 'Run the PowerShell command in this directory and tell me how many lines its output has.';
const TOOL_RESULT = `Tool result 0: 600 rows. First row: row 1 ${'x'.repeat(96)}; `
  + `last row: row 600 ${'x'.repeat(96)}.`;

/**
 * One pass's rows, built by the SHIPPED builder. The gate used to hand-build
 * the anchor as `excerptA`/`excerptB`, the pre-ISSUE-058 shape; the shipped
 * `renderPruneAskRow` reads `anchor.anchors`, so the fixture now travels the
 * product's own path: real tool-result nodes, real units, `buildPruneAskRows`
 * numbering them 1, 2, 3… over the whole pass exactly as a real pass does.
 */
const ROW_TEXT = (letter) => `row 1 ${letter.repeat(96)}\n`
  + Array.from({ length: 598 }, (_, index) => `row ${String(index + 2)} ${letter.repeat(96)}`).join('\n')
  + `\nrow 600 ${letter.repeat(96)}`;

function resultNode(id, letter) {
  const bytes = core.toBytes(ROW_TEXT(letter));
  return {
    id,
    kind: 'tool-result',
    turnOrdinal: 1,
    stepOrdinal: 1,
    bytes,
    sha256: core.sha256Sync(bytes),
    byteLength: bytes.byteLength,
    callId: `call-${id}`,
    embeddedRecords: [],
    evidence: {
      kind: 'read',
      target: { key: 'big.txt', label: 'big.txt' },
      source: { nodeId: id, sha256: core.sha256Sync(bytes), byteLength: bytes.byteLength },
      sourceRecallId: null,
      paths: [{
        pathKey: 'big.txt', displayPath: 'big.txt', title: null,
        lineCount: 600, byteLength: bytes.byteLength, outcome: 'hit',
      }],
    },
  };
}

// Five results, one per row, cut into the three tables a pass would send: two
// full tables and one 1-row tail (the normal tail shape since ADR-0028). Each
// table numbers its own rows from 1, which is what its scripted answer indexes.
const LETTERS = ['a', 'b', 'c', 'd', 'e'];
const NODES = LETTERS.map((letter, index) =>
  resultNode(`result-${String(index + 1)}`, letter));
const UNITS = NODES.map((node) => new core.UnitTracker({
  sessionId: 'sim:gate1', barBytes: 1,
}).unitsFor(node)[0]);
const rowsFor = (...indexes) => core.buildPruneAskRows(indexes.map((index) => {
  const node = NODES[index];
  return { unit: UNITS[index], node, callFacts: { toolName: 'pwsh', targetPath: 'big.txt' } };
}));

// The three table asks the gate grows. Answers are the rig's scripted keepall /
// forgetall JSON.
const ASKS = [
  { rows: [1, 2], text: adapter.tableAsk(rowsFor(0, 1)) },
  { rows: [1], text: adapter.tableAsk(rowsFor(2)) },
  { rows: [1, 2], text: adapter.tableAsk(rowsFor(3, 4)) },
];
const REPLIES = [
  '{"1":{"keepall":true},"2":{"keepall":true}}',
  '{"1":{"forgetall":"an earlier oversized shell listing"}}',
];

const seed = {
  system: SYSTEM,
  tools: TOOLS,
  messages: [
    { role: 'user', text: TASK },
    { role: 'assistant', text: 'Running it.' },
    { role: 'user', text: TOOL_RESULT },
  ],
};
const fork1 = core.appendAsk(core.seedFork(seed), ASKS[0].text);
const fork2 = core.appendAsk(core.appendVerdict(fork1, REPLIES[0]), ASKS[1].text);
const fork3 = core.appendAsk(core.appendVerdict(fork2, REPLIES[1]), ASKS[2].text);
const FORKS = [fork1, fork2, fork3];

// The provider body: the fork's messages in OpenAI chat form. `tools` sits
// before `messages` so the raw-body prefix check below is a plain startsWith.
const providerTools = TOOLS.map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));
const bodyOf = (fork) => ({
  model: MODEL,
  temperature: 0,
  stream: false,
  tools: providerTools,
  messages: [
    { role: 'system', content: fork.system },
    ...fork.messages.map((message) => ({ role: message.role, content: message.text })),
  ],
});
const BODIES = FORKS.map(bodyOf);

// ---- offline assertions on the exact bytes --------------------------------
const sameMessage = (a, b) => a.role === b.role && a.text === b.text;
function messagePrefix(longer, shorter) {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) if (!sameMessage(longer[i], shorter[i])) return false;
  return true;
}
function hashPrefix(longer, shorter) {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) if (longer[i] !== shorter[i]) return false;
  return true;
}
function tableRows(ask) {
  const at = ask.indexOf(core.PRUNE_ASK_TABLE_HEADING);
  const table = at < 0 ? '' : ask.slice(at);
  return [...new Set([...table.matchAll(/^(\d+)\. \[/gmu)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}
const askCarriesContract = (ask) => ask.includes(core.PRUNE_ASK_SYSTEM_PROMPT)
  && ask.includes(core.PRUNE_ASK_TABLE_HEADING)
  && ask.endsWith(core.PRUNE_ASK_FINAL_LINE);
// `messages` is the body's last key, so the shorter body ends with `]}` (the
// messages array close plus the body close); the longer body continues with
// `,` after the shared message objects. Strip both closers and compare.
const rawBodyExtends = (longer, shorter) => JSON.stringify(longer).startsWith(JSON.stringify(shorter).slice(0, -2));

const RELATIONS = {
  'call 2 = call 1 + assistant reply + ask 2': messagePrefix(fork2.messages, fork1.messages)
    && fork2.messages.length === fork1.messages.length + 2,
  'call 3 = call 2 + assistant reply + ask 3': messagePrefix(fork3.messages, fork2.messages)
    && fork3.messages.length === fork2.messages.length + 2,
  'call 3 extends call 1 prefix': messagePrefix(fork3.messages, fork1.messages),
  'fork hash chain call 2': hashPrefix(fork2.messageHashes, fork1.messageHashes),
  'fork hash chain call 3': hashPrefix(fork3.messageHashes, fork2.messageHashes),
  'raw body 2 byte-extends raw body 1': rawBodyExtends(BODIES[1], BODIES[0]),
  'raw body 3 byte-extends raw body 1': rawBodyExtends(BODIES[2], BODIES[0]),
  'ask 1 carries the shipped contract': askCarriesContract(ASKS[0].text),
  'ask 2 carries the shipped contract': askCarriesContract(ASKS[1].text),
  'ask 3 carries the shipped contract': askCarriesContract(ASKS[2].text),
  'ask 1 carries the rig table marker': ASKS[0].text.includes("The messages above are main's production conversation"),
  'row counts are 2 / 1 / 2': JSON.stringify(ASKS.map((ask) => tableRows(ask.text)))
    === JSON.stringify([[1, 2], [1], [1, 2]]),
  'nonce is byte 0 of system': SYSTEM.startsWith(`nonce ${NONCE}\n`),
  'shape source exists': fs.existsSync(SCENARIO),
};
const relationsOk = Object.values(RELATIONS).every(Boolean);

const planRows = ASKS.map((ask, index) => {
  const body = BODIES[index];
  const text = JSON.stringify(body);
  return {
    call: index + 1,
    rows: ask.rows,
    messages: body.messages.length,
    bodyBytes: Buffer.byteLength(text),
    bodySha256: sha(text),
    askBytes: Buffer.byteLength(ask.text),
    askSha256: sha(ask.text),
  };
});

function printRelations() {
  for (const [name, pass] of Object.entries(RELATIONS)) {
    console.log(`  [assert] ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }
}

if (!relationsOk) {
  console.error('gate1-fork-cache: REFUSED — a shape assertion failed; nothing was sent');
  printRelations();
  process.exit(2);
}

if (!LIVE) {
  console.log('gate1-fork-cache: PLAN — offline, no HTTP calls made');
  console.log(`  shape source: ${path.relative(REPO_ROOT, SCENARIO)}`);
  console.log(`  ask source: ${path.relative(REPO_ROOT, ADAPTER_ENTRY)} tableAsk (shipped composition)`);
  console.log(`  fork source: ${path.relative(REPO_ROOT, CORE_ENTRY)} seedFork/appendAsk/appendVerdict (shipped growth)`);
  console.log(`  nonce: ${NONCE}`);
  console.log(`  seed: system ${Buffer.byteLength(SYSTEM)}B sha256=${sha(SYSTEM)}; tools=${TOOLS.length};`
    + ` main messages=${seed.messages.length}`);
  for (const rowPlan of planRows) {
    console.log(`  call ${rowPlan.call}: rows=[${rowPlan.rows.join(',')}]`
      + ` messages=${rowPlan.messages} body=${rowPlan.bodyBytes}B sha256=${rowPlan.bodySha256}`
      + ` ask=${rowPlan.askBytes}B sha256=${rowPlan.askSha256}`);
  }
  printRelations();
  console.log('  pass criterion (Ruling 7 gate 1 / ISSUE-035 item 3):');
  console.log('    (1) calls 2 and 3 each byte-extend call 1\'s message-array prefix;');
  console.log('    (2) usage.prompt_tokens_details.cached_tokens > 0 on call 2;');
  console.log('    (3) usage.prompt_tokens_details.cached_tokens > 0 on call 3.');
  console.log('  live gate: PENDING HUMAN GATE — needs the owner\'s a6 authorization;');
  console.log('             --live refuses unless --owner-authorized is also passed.');
  console.log(`  evidence (live only): ${path.relative(REPO_ROOT, OUT_DIR)}/`);
  console.log('gate1-fork-cache: PLAN PASS — 0 calls made');
  process.exit(0);
}

// ---- live mode: owner gate, key, kill timer -------------------------------
if (!OWNER) {
  refuse('--live needs --owner-authorized; the live run is a pending human gate on the'
    + " owner's a6 authorization (ISSUE-035 item 3). Nothing was sent.");
}
function loadKey() {
  if (!fs.existsSync(CRED)) return { key: null, source: 'missing-file' };
  const m = fs.readFileSync(CRED, 'utf8').match(/^\s*A6_API_KEY:\s*(\S+)\s*$/m);
  return m ? { key: m[1], source: CRED } : { key: null, source: 'missing-in-file' };
}
const keyInfo = loadKey();
console.log(`[key] A6_API_KEY: ${keyInfo.key ? 'found' : 'not found'} in ${keyInfo.source}`);
if (!keyInfo.key) refuse(`A6_API_KEY not found in ${CRED}; no call made`);

const KILL_MS = Math.round(KILL_S * 1000);
const GAP_MS = Math.round(GAP_S * 1000);
const DEADLINE = Date.now() + KILL_MS;
const evidence = {
  gate: 'gate1-fork-cache (ISSUE-035 item 3; Ruling 7 gate 1)',
  mode: 'live',
  startedAt: now.toISOString(),
  base: BASE,
  model: MODEL,
  shapeSource: 'dev/dsh-rig/scenarios/prune-apply-auto.json',
  askSource: ADAPTER_ENTRY,
  coreEntry: CORE_ENTRY,
  nonce: NONCE,
  killTimer: { armedMs: KILL_MS, firesAt: new Date(DEADLINE).toISOString() },
  gapMs: GAP_MS,
  key: { found: true, source: keyInfo.source },
  relations: RELATIONS,
  plan: planRows,
  calls: [],
  criteria: null,
  verdict: null,
};
function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2));
  console.log(`[evidence] ${OUT_FILE}`);
}
const killTimer = setTimeout(() => {
  console.error(`FATAL kill timer fired (${KILL_MS} ms); exiting 124`);
  evidence.killedAt = new Date().toISOString();
  evidence.verdict = 'KILLED';
  try { writeEvidence(); } catch { /* best effort */ }
  process.exit(124);
}, KILL_MS);
killTimer.unref?.();
console.log(`[kill-timer] armed ${KILL_MS} ms; fires ${new Date(DEADLINE).toISOString()}`);
console.log(`[gap] ${GAP_MS} ms between calls; budget 3 calls, one attempt each`);

async function call(index) {
  const label = `call ${String(index + 1)}`;
  const remain = DEADLINE - Date.now();
  if (remain < 5000) {
    return { label, ok: false, httpStatus: null, latencyMs: 0, usage: null,
      usageRaw: null, content: null, error: `kill-timer budget too low (${remain} ms)` };
  }
  const timeout = Math.min(CALL_TIMEOUT_MS, remain);
  const text = JSON.stringify(BODIES[index]);
  const started = Date.now();
  let response;
  let rawBody = '';
  let error = null;
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyInfo.key}` },
      body: text,
      signal: AbortSignal.timeout(timeout),
    });
    rawBody = await response.text();
  } catch (e) {
    error = e?.name === 'TimeoutError'
      ? `TIMEOUT after ${timeout} ms (aborted)`
      : String(e?.message ?? e);
  }
  const latencyMs = Date.now() - started;
  if (error !== null) {
    return { label, ok: false, httpStatus: null, latencyMs, usage: null,
      usageRaw: null, content: null, error, sentAt: new Date(started).toISOString() };
  }
  let json = null;
  try { json = JSON.parse(rawBody); } catch { /* non-JSON body kept verbatim */ }
  const usagePresent = json !== null && Object.hasOwn(json, 'usage');
  const usage = usagePresent ? json.usage : null;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  console.log(`[${label}] http=${response.status} ${latencyMs} ms prompt=${usage?.prompt_tokens ?? 'n/a'}`
    + ` cached=${cached ?? 'n/a'} usage=${usagePresent ? 'present' : 'ABSENT'}`);
  console.log(`[usage ${label}] ${usagePresent ? JSON.stringify(usage) : '(usage ABSENT)'}`);
  return {
    label,
    ok: response.ok,
    httpStatus: response.status,
    latencyMs,
    sentAt: new Date(started).toISOString(),
    usagePresent,
    usage,
    usageRaw: usagePresent ? JSON.stringify(usage) : null,
    content: json?.choices?.[0]?.message?.content ?? null,
    error: response.ok ? null : `http ${response.status}`,
    rawBodyHead: rawBody.slice(0, 600),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < BODIES.length; i += 1) {
  if (i > 0) {
    const waitMs = Math.max(0, Math.min(GAP_MS, DEADLINE - Date.now() - 15000));
    console.log(`[gap] sleeping ${waitMs} ms before call ${i + 1}`);
    await sleep(waitMs);
  }
  const record = await call(i);
  evidence.calls.push(record);
  if (!record.ok) {
    console.error(`[abort] ${record.label} failed (${record.error ?? 'error'}); no further calls`);
    break;
  }
}

const cachedOf = (record) => {
  const value = record?.usage?.prompt_tokens_details?.cached_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
const criteria = [
  {
    id: 'prefix-extension',
    pass: relationsOk,
    detail: 'call 2 and call 3 byte-extend call 1\'s message array; raw bodies and fork hashes agree',
  },
  {
    id: 'cache-read-call-2',
    pass: cachedOf(evidence.calls[1]) !== null && cachedOf(evidence.calls[1]) > 0,
    detail: `prompt_tokens_details.cached_tokens=${String(cachedOf(evidence.calls[1]))}`,
  },
  {
    id: 'cache-read-call-3',
    pass: cachedOf(evidence.calls[2]) !== null && cachedOf(evidence.calls[2]) > 0,
    detail: `prompt_tokens_details.cached_tokens=${String(cachedOf(evidence.calls[2]))}`,
  },
];
const passed = criteria.every((criterion) => criterion.pass);
evidence.criteria = criteria;
evidence.verdict = passed ? 'PASS' : 'FAIL';
writeEvidence();
for (const criterion of criteria) {
  console.log(`[criterion ${criterion.id}] ${criterion.pass ? 'PASS' : 'FAIL'} — ${criterion.detail}`);
}
console.log(`gate1-fork-cache: ${evidence.verdict} — ${evidence.calls.length} calls; evidence ${OUT_FILE}`);
process.exit(passed ? 0 : 1);
