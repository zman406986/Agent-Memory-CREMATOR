#!/usr/bin/env node
/**
 * The launcher's flag gates, in one file: `--entry-ask-batch-size`
 * (ISSUE-117 chunk B3), `--entry-ask-trigger` / `--entry-ask-grammar`
 * (ISSUE-128 / ISSUE-129), `--dedupe-superseded-by-reread` (ISSUE-163),
 * `--judge-timeout-ms` (ISSUE-126), and the host tool-result
 * pruner's opt-out `--allow-host-pruner` (ADR-0041, ISSUE-189).
 *
 * Each is a knob a live arm states. The entry-ask and judge-timeout checks reach
 * the `racoons-mount` row's config JSON. An omitted flag means the key is ABSENT,
 * so the mount's own default applies, and a value the launcher does not
 * understand must refuse by name rather than fall back to a default.
 *
 * `bench-run.mjs` runs `main()` only when invoked directly (`invokedDirectly`).
 * The checks spawn the launcher on `--preflight` against a stub dsh, so they
 * compose the real config and reach no provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./bench-run.mjs', import.meta.url));
// A launched evidence dir must resolve under the repo's scratchpad (ISSUE-260).
const SCRATCHPAD = fileURLToPath(new URL('../../scratchpad/', import.meta.url));

function scratchRoot(prefix) {
  mkdirSync(SCRATCHPAD, { recursive: true });
  return mkdtempSync(join(SCRATCHPAD, prefix));
}

// The stub does what preflight reads back: it answers `--version`, and on
// `--dump-config` it emits, as the host would compose them, the eight deny rows,
// the host's own tool-result-pruner row and the mount row's file URL.
//
// The pruner row is not a constant: ADR-0041 has the launcher PATCH it off, so
// the stub reads the row back out of `--patch` (the file the launcher wrote) and
// composes the state the patch states. Without the patch row the base layer
// ships the pruner ENABLED, which is what the opt-out lane must show. A preflight
// that lost the row therefore still fails by name instead of reading a stub
// constant that would make the gate vacuous.
const STUB = `const { readFileSync } = require('node:fs');
const rows = ${JSON.stringify([
  'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-subagent-control',
  'tool-subagent-list-agents', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'workflow-ptc',
])};
if (!process.argv.includes('--dump-config')) process.stdout.write('0.0.0-stub\\n');
else {
  const at = process.argv.indexOf('--patch');
  const patch = readFileSync(process.argv[at + 1], 'utf8');
  for (const id of rows) process.stdout.write(\`- id: \${id}\\n  disabled: true\\n\`);
  const lines = patch.split(/\\r?\\n/u);
  const prunerAt = lines.findIndex((line) => line.trim() === '- id: tool-result-pruner');
  const prunerOff = prunerAt !== -1
    && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[prunerAt + 1] ?? '');
  process.stdout.write(\`- id: tool-result-pruner\\n  disabled: \${prunerOff ? 'true' : 'false'}\\n\`);
  // The four web rows the --deny-web preflight reads back. A row absent from the
  // patch is emitted ENABLED, which is the composed state an authorized official
  // run has when the launcher did not write the deny rows: the preflight must
  // fail on it, so the stub must not invent a denial the patch never asked for.
  for (const id of ${JSON.stringify(['web-search-deepseek', 'web-deepseek-api', 'web', 'tool-web'])}) {
    const at = lines.findIndex((line) => line.trim() === \`- id: \${id}\`);
    const off = at !== -1 && /^\\s+disabled: true\\s*(#.*)?$/u.test(lines[at + 1] ?? '');
    process.stdout.write(\`- id: \${id}\\n  disabled: \${off ? 'true' : 'false'}\\n\`);
  }
  const url = (patch.match(/name: '([^']+)'/u) ?? [])[1];
  if (url !== undefined) process.stdout.write(\`- id: racoons-mount\\n  name: '\${url}'\\n\`);
}
`;

/**
 * A preflight run over a temp arm, evidence dir and stub dsh. Returns the whole
 * `patch.yml` and the mount row's parsed config; asserts the run succeeded.
 * `arm` defaults to racoons; the vanilla arm carries no mount row, so its
 * `config` is null and only `patch` is readable.
 */
function preflight(extraArgs, provider = 'mock', arm = 'racoons') {
  const root = scratchRoot('test-racoons-bench-flags-');
  const bin = join(root, 'stub-bin.cjs');
  const armDir = join(root, 'arm');
  const evidenceDir = join(root, 'evidence');
  mkdirSync(armDir);
  writeFileSync(bin, STUB);
  writeFileSync(join(armDir, 'AGENTS.md'), '# rules\n');
  const result = spawnSync(process.execPath, [SCRIPT, '--preflight', '--arm', arm,
    '--provider', provider, '--plugin-dist', join(root, 'dist'),
    '--plugin-entry', SCRIPT, '--arm-dir', armDir, '--dsh-bin', bin,
    '--evidence', evidenceDir, ...extraArgs], { encoding: 'utf8', cwd: root, windowsHide: true });
  const patch = result.status === 0 ? readFileSync(join(evidenceDir, 'patch.yml'), 'utf8') : '';
  const launch = result.status === 0
    ? JSON.parse(readFileSync(join(evidenceDir, 'launch.json'), 'utf8')) : null;
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const mountLine = patch.split(/\r?\n/u).find((line) => line.startsWith('      config: '));
  if (arm !== 'racoons') return { patch, config: null, launch };
  assert.notEqual(mountLine, undefined, 'patch.yml carries no mount config row');
  return { patch, config: JSON.parse(mountLine.slice('      config: '.length)), launch };
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

/** One parse refusal: exit 2 and a message naming the value it was given. */
function refused(args, pattern) {
  const result = run(args);
  assert.equal(result.status, 2, `${args.join(' ')} must exit 2`);
  assert.match(result.stderr, pattern);
}

// Every test below runs the launcher's --preflight against a stub dsh: one real
// child process per assertion group. That is e2e shaped, so the file is opt-in —
// set E2E_BENCH_FLAGS=1 to run it. The pure helpers this file leans on
// (killMsValue, stopAfterCompactionsValue, hostPrunerState, patchRowTally) have
// their own tests in the default run.
const E2E = process.env.E2E_BENCH_FLAGS === '1'
  ? {}
  : { skip: 'opt-in: set E2E_BENCH_FLAGS=1 to run the launcher preflight' };

// ---------------------------------------------------------------------------
// --entry-ask-batch-size: the batched entry-ask cadence (ADR-0035).
// ---------------------------------------------------------------------------

test('entry-ask-batch-size: absent means the key is ABSENT, so the mount default (1) applies', { ...E2E }, () => {
  const { config } = preflight([]);
  assert.equal(Object.hasOwn(config, 'entryAskBatchSize'), false,
    'an omitted flag must not put a number in the mount config');
  // The neighbouring conditional spread still works, so the assertion above is
  // about this key and not about a mount row that failed to compose.
  assert.equal(config.capBytes, 8192);
});

test('entry-ask-batch-size: 6 reaches the mount config as entryAskBatchSize', { ...E2E }, () => {
  assert.equal(preflight(['--entry-ask-batch-size', '6']).config.entryAskBatchSize, 6);
});

test('entry-ask-batch-size: zero, negative, fractional and non-numeric are refused', { ...E2E }, () => {
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    const result = run(['--arm', 'racoons', '--entry-ask-batch-size', bad]);
    assert.equal(result.status, 2, `--entry-ask-batch-size ${bad} must exit 2`);
    assert.match(result.stderr, /--entry-ask-batch-size takes a positive integer batch size/u);
  }
});

test('entry-ask-batch-size: --help documents the flag', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--entry-ask-batch-size <n>\]/u);
});

// ---------------------------------------------------------------------------
// --entry-ask-trigger and --entry-ask-grammar: the landed-bytes trigger at
// 240,000 and the two-option answer grammar a live arm names.
// ---------------------------------------------------------------------------

test('entry-ask-trigger: absent means no trigger, and the shipped grammar default is written', { ...E2E }, () => {
  const { config } = preflight([]);
  assert.equal(Object.hasOwn(config, 'entryAskTrigger'), false,
    'an omitted flag must not put a trigger in the mount config');
  // Owner ruling 2026-11-05: the launcher states the shipped default in the row,
  // so a launch record always names the grammar its asks were measured under.
  assert.equal(config.entryAskGrammar, 'jsonl-20',
    'an omitted grammar flag writes the shipped jsonl-20 default');
  // The neighbouring conditional spread still works, so the assertions above are
  // about these keys and not about a mount row that failed to compose.
  assert.equal(config.capBytes, 8192);
});

test('entry-ask-trigger: landed-bytes:240000 reaches the mount config as the trigger object', { ...E2E }, () => {
  assert.deepEqual(preflight(['--entry-ask-trigger', 'landed-bytes:240000']).config.entryAskTrigger,
    { mode: 'landed-bytes', bytes: 240000 });
});

test('entry-ask-trigger: {"mode":"off"} reaches the mount config unchanged (ADR-0050)', { ...E2E }, () => {
  // The off switch needs no number; it is written through as the object the run
  // named, never rewritten into a count or a landed-bytes row.
  assert.deepEqual(preflight(['--entry-ask-trigger', '{"mode":"off"}']).config.entryAskTrigger,
    { mode: 'off' });
});

test('prune-threshold-tokens: 60000 reaches the mount config beside the window (ADR-0050)', { ...E2E }, () => {
  const config = preflight(['--window-tokens', '400000', '--prune-threshold-tokens', '60000']).config;
  assert.equal(config.pruneThresholdTokens, 60000);
  assert.equal(config.contextWindowTokens, 400000);
});

test('entry-ask-grammar: 3option, two-option and jsonl-20 reach the mount config by name', { ...E2E }, () => {
  assert.equal(preflight(['--entry-ask-grammar', 'two-option']).config.entryAskGrammar, 'two-option');
  assert.equal(preflight(['--entry-ask-grammar', '3option']).config.entryAskGrammar, '3option');
  // ADR-0040 / ISSUE-183: jsonl-20 is the shipped default (asserted by the
  // "absent" test above) and is still accepted by name.
  assert.equal(preflight(['--entry-ask-grammar', 'jsonl-20']).config.entryAskGrammar, 'jsonl-20');
});

test('entry-ask-trigger: unknown specs are refused by name, never defaulted', { ...E2E }, () => {
  for (const bad of ['landed-bytes', 'landed-bytes:', 'landed-bytes:0', 'landed-bytes:-5',
    'landed-bytes:1.5', 'landed-bytes:abc', 'count', '240000',
    'landed-bytes:99999999999999999999']) {
    refused(['--arm', 'racoons', '--entry-ask-trigger', bad],
      /--entry-ask-trigger does not take "[\s\S]*": use landed-bytes:<bytes>/u);
  }
});

test('a paid provider needs a token budget; the token grant is the only cap', { ...E2E }, () => {
  // Owner ruling 2026-11-08: no wall-clock timer means a paid run without a
  // budget would be unbounded. The mock providers are offline and may omit it.
  refused(['--arm', 'racoons', '--provider', 'deepseek-official', '--allow-official-spend'],
    /--token-grant/u);
});

// ---------------------------------------------------------------------------
// --prune-ask-grammar: the bulk prune ask's answer grammar (ISSUE-221).
//
// It is a racoons-arm mount key, so the vanilla arm has no prune pass and the
// flag refuses there. The launcher always writes the key, so a launch record
// names the contract its prune asks were measured under.
// ---------------------------------------------------------------------------

test('prune-ask-grammar: absent writes the shipped nokeepall default', { ...E2E }, () => {
  // ADR-0056: the launcher default matches the product default.
  assert.equal(preflight([]).config.pruneAskGrammar, 'nokeepall');
});

test('prune-ask-grammar: 3option and nokeepall reach the mount config by name', { ...E2E }, () => {
  assert.equal(preflight(['--prune-ask-grammar', 'nokeepall']).config.pruneAskGrammar,
    'nokeepall');
  assert.equal(preflight(['--prune-ask-grammar', '3option']).config.pruneAskGrammar, '3option');
});

test('prune-ask-grammar: an unknown grammar is refused by name', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--prune-ask-grammar', '4option'],
    /--prune-ask-grammar does not take "4option": use 3option or nokeepall/u);
});

test('prune-ask-grammar: the flag belongs to the racoons arm only', { ...E2E }, () => {
  refused(['--arm', 'vanilla', '--prune-ask-grammar', 'nokeepall'],
    /--prune-ask-grammar belongs to --arm racoons/u);
});

test('prune-ask-grammar: --help documents the flag and its nokeepall default', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--prune-ask-grammar <g>\]/u);
  assert.match(help.stdout, /Absent = nokeepall/u);
});

test('entry-ask-grammar: an unknown grammar is refused by name', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--entry-ask-grammar', '4option'],
    /--entry-ask-grammar does not take "4option": use 3option, two-option or jsonl-20/u);
});

test('both flags belong to the racoons arm, which is the only arm with a mount', { ...E2E }, () => {
  refused(['--arm', 'vanilla', '--entry-ask-trigger', 'landed-bytes:240000'],
    /--entry-ask-trigger belongs to --arm racoons/u);
  refused(['--arm', 'vanilla', '--entry-ask-grammar', 'two-option'],
    /--entry-ask-grammar belongs to --arm racoons/u);
});

test('both flags are documented by --help', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--entry-ask-trigger <spec>\]/u);
  assert.match(help.stdout, /\[--entry-ask-grammar <g>\]/u);
});

// ---------------------------------------------------------------------------
// --dedupe-superseded-by-reread: the superseded-by-reread dedupe class (ISSUE-163).
// ---------------------------------------------------------------------------

test('dedupe-superseded-by-reread: off unless stated, then true in the mount config, racoons arm only', { ...E2E }, () => {
  const { config } = preflight([]);
  assert.equal(Object.hasOwn(config, 'dedupeSupersededByReread'), false,
    'an omitted flag must not put the dedupe switch in the mount config: the entry default (off) applies');
  assert.equal(config.capBytes, 8192,
    'the neighbouring unconditional spread still works, so the assertion is about this key');
  assert.equal(preflight(['--dedupe-superseded-by-reread']).config.dedupeSupersededByReread, true);
  refused(['--arm', 'vanilla', '--dedupe-superseded-by-reread'],
    /--dedupe-superseded-by-reread belongs to --arm racoons/u);
});

// ---------------------------------------------------------------------------
// --dedupe-call-echo: the exact-echo subset of the call-echo class (ISSUE-151).
// ---------------------------------------------------------------------------

test('dedupe-call-echo: off unless stated, then true in the mount config, racoons arm only', { ...E2E }, () => {
  const { config } = preflight([]);
  assert.equal(Object.hasOwn(config, 'dedupeCallEcho'), false,
    'an omitted flag must not put the switch in the mount config: the entry default (off) applies');
  assert.equal(preflight(['--dedupe-call-echo']).config.dedupeCallEcho, true);
  refused(['--arm', 'vanilla', '--dedupe-call-echo'],
    /--dedupe-call-echo belongs to --arm racoons/u);
});

// ---------------------------------------------------------------------------
// --judge-timeout-ms: the bulk prune's ask deadline (ISSUE-126).
// ---------------------------------------------------------------------------

test('judge-timeout-ms: absent means the key is ABSENT, so the mount default applies', { ...E2E }, () => {
  const { config } = preflight([]);
  assert.equal(Object.hasOwn(config, 'judgeTimeoutMs'), false,
    'an omitted flag must not put a number in the mount config');
  // The neighbouring conditional spread still works, so the assertion above is
  // about this key and not about a mount row that failed to compose.
  assert.equal(config.capBytes, 8192);
});

test('judge-timeout-ms: 120000 reaches the mount config as judgeTimeoutMs', { ...E2E }, () => {
  assert.equal(preflight(['--judge-timeout-ms', '120000']).config.judgeTimeoutMs, 120000);
});

test('judge-timeout-ms: zero, negative, fractional and non-numeric are refused', { ...E2E }, () => {
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    const result = run(['--arm', 'racoons', '--judge-timeout-ms', bad]);
    assert.equal(result.status, 2, `--judge-timeout-ms ${bad} must exit 2`);
    assert.match(result.stderr, /--judge-timeout-ms takes a positive integer millisecond deadline/u);
  }
});

test('judge-timeout-ms: --help documents the flag beside --window-tokens', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--judge-timeout-ms <n>\][\s\S]*bulk-prune ask[\s\S]*default \(30000\)/u);
});

// ---------------------------------------------------------------------------
// --stop-on-compaction: the landmark stopper (ISSUE-182).
//
// It reaches no mount key and no route row: it is the launcher's own stop rule,
// so the only artifact it may move is `result.json` (asserted where the record
// is assembled, and in `launch-outcome.test.mjs`). These checks hold the two
// things preflight can prove: the flag parses, and it does not leak into the
// composed config.
// ---------------------------------------------------------------------------

test('stop-on-compaction: absent and present compose the SAME mount config', { ...E2E }, () => {
  const off = preflight([]).config;
  const on = preflight(['--stop-on-compaction']).config;
  assert.deepEqual(on, off,
    'the stop rule is the launcher\'s, so it must not reach a mount key');
  assert.equal(Object.hasOwn(on, 'stopOnCompaction'), false);
});

test('stop-on-compaction: it belongs to both arms (it is a launcher rule, not a mount key)', { ...E2E }, () => {
  // The vanilla arm has no mount and must still be stoppable: the host's native
  // compaction is exactly what a vanilla control run measures. The preflight
  // below runs on the vanilla arm and must pass, with no mount row in the patch.
  const vanilla = preflight(['--stop-on-compaction'], 'mock', 'vanilla');
  assert.equal(vanilla.patch.includes('racoons-mount'), false, 'the vanilla arm still has no mount row');
  assert.match(vanilla.patch, /id: session-persistence-jsonl/u, 'the patch still composes');
});

test('stop-on-compaction: it takes no value', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--stop-on-compaction=1'], /--stop-on-compaction takes no value/u);
});

test('stop-on-compaction: --help documents the flag and its label', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--stop-on-compaction\][^\n]*FIRST native compaction/u);
  assert.match(help.stdout, /stopped-on-compaction/u);
});

test('stop-on-compaction: it may not write a projection baseline', { ...E2E }, () => {
  // A baseline must come from a run that completed; a stopped run's projection
  // is the prefix it happened to replay. The refusal is an argument check, so it
  // fires before any record is read.
  refused(['--arm', 'racoons', '--provider', 'mock-replay', '--dry-work', '--stop-on-compaction',
    '--projection-out', 'out.json', '--record', 'r.jsonl', '--record-map', 'm.json'],
  /--stop-on-compaction may not write a baseline/u);
});

// ---------------------------------------------------------------------------
// The host's own tool-result pruner (ADR-0041, ISSUE-189; arm rule 2026-11-09).
//
// The state is ARM-DEPENDENT: the racoons arm disables it (the mount is the
// only remover), and the vanilla control leaves the host at its shipped default
// (on) and writes no row for it. `--allow-host-pruner` is the racoons arm's one
// opt-out; `--end-pressure-isolation` is the same choice under its older
// spelling, and on vanilla the flag is redundant. Preflight composes the real
// patch for any provider, so the row's presence and its `disabled: true` are
// readable here. The `--end-pressure-isolation` FOLD is not asserted at this
// level: that spelling needs `--inflate-bytes`, which needs a mock-replay
// record, so the equivalence is proved by the launcher's post-run gate and the
// mock run rather than a fixture this file would have to invent.
// ---------------------------------------------------------------------------

const PRUNER_ROW = /^- id: tool-result-pruner$/mu;

test('host pruner: racoons disables it once; vanilla writes no row at all', { ...E2E }, () => {
  const racoons = preflight([], 'mock', 'racoons').patch;
  assert.equal((racoons.match(/^- id: tool-result-pruner$/gmu) ?? []).length, 1,
    'the racoons patch must carry the disable row exactly once');
  const lines = racoons.split(/\r?\n/u);
  const at = lines.indexOf('- id: tool-result-pruner');
  assert.equal(lines[at + 1], '  disabled: true', 'the racoons row must be disabled');

  // The control leaves the composed row untouched: no disable row is written,
  // so the host's own default (on) stands.
  const vanilla = preflight([], 'mock', 'vanilla').patch;
  assert.doesNotMatch(vanilla, PRUNER_ROW,
    'the vanilla patch must carry no tool-result-pruner row');
  // The neighbouring rows still compose, so the assertion above is about this
  // row and not about a patch that failed to build.
  assert.match(vanilla, /id: session-persistence-jsonl/u, 'the vanilla patch still composes');
});

test('host pruner: --allow-host-pruner suppresses the racoons row and is a no-op on vanilla', { ...E2E }, () => {
  for (const arm of ['racoons', 'vanilla']) {
    const { patch } = preflight(['--allow-host-pruner'], 'mock', arm);
    assert.doesNotMatch(patch, PRUNER_ROW,
      `the ${arm} arm with the opt-out must write no tool-result-pruner row at all`);
    // The neighbouring rows still compose, so the assertion above is about this
    // row and not about a patch that failed to build.
    assert.match(patch, /id: session-persistence-jsonl/u, `the ${arm} arm's patch still composes`);
  }
});

test('host pruner: each arm records the state it runs under', { ...E2E }, () => {
  const racoons = preflight([], 'mock', 'racoons').launch.hostPruner;
  assert.equal(racoons.state, 'disabled');
  assert.equal(racoons.disabled, true);
  assert.equal(racoons.optOut, null);
  const vanilla = preflight([], 'mock', 'vanilla').launch.hostPruner;
  assert.equal(vanilla.state, 'host-default');
  assert.equal(vanilla.disabled, false);
  // The flag is the racoons opt-out. On vanilla it changes nothing and is not
  // recorded as a decision this run took.
  const vanillaFlag = preflight(['--allow-host-pruner'], 'mock', 'vanilla').launch.hostPruner;
  assert.equal(vanillaFlag.state, 'host-default');
  assert.equal(vanillaFlag.optOut, null);
  const racoonsFlag = preflight(['--allow-host-pruner'], 'mock', 'racoons').launch.hostPruner;
  assert.equal(racoonsFlag.state, 'host-default');
  assert.equal(racoonsFlag.optOut, '--allow-host-pruner');
});

test('host pruner: a real-provider preflight carries the racoons disable row', { ...E2E }, () => {
  // The racoons arm's rule holds on every provider, so the route a live run
  // takes is asserted directly instead of inferred from the mock lane.
  const { patch } = preflight(['--token-grant', '100000000', '--allow-official-spend'], 'deepseek-official');
  assert.match(patch, PRUNER_ROW, 'the racoons live-route patch must carry the disable row');
});

test('host pruner: --end-pressure-isolation still needs --inflate-bytes', { ...E2E }, () => {
  // Kept from the old flag: its refusal is what stops a launch line that passes
  // it bare from silently measuring something other than it asked for.
  // `--dry-work` is named so the parse reaches this check: a mock run without it
  // is refused earlier for a different reason.
  refused(['--arm', 'racoons', '--dry-work', '--end-pressure-isolation'],
    /--end-pressure-isolation needs --inflate-bytes/u);
});

test('host pruner: both spellings are documented by --help', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--allow-host-pruner\][\s\S]*?racoons arm disables[\s\S]*?vanilla arm always[\s\S]*?NOT a[\s\S]*?product measurement/u);
  assert.match(help.stdout, /\[--end-pressure-isolation\][\s\S]*?older spelling[\s\S]*?--inflate-bytes/u);
});

test('kill timer: --kill-ms 0 is accepted and the help states it is the off default', { ...E2E }, () => {
  // Owner ruling 2026-11-08: no wall-clock cap unless one is asked for; the
  // token grant is the only run cap. An explicit 0 is the same shape as the
  // default, so a preflight accepts it and the composed arm still builds.
  const { patch } = preflight(['--kill-ms', '0']);
  assert.match(patch, /id: session-persistence-jsonl/u, 'the arm still composes');
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout,
    /\[--kill-ms <n>\][\s\S]*?default 0 \(off; the[\s\S]*?token grant is the only cap\)/u);
});

// ---------------------------------------------------------------------------
// --deny-web: the four web rows, closed even on an authorized official route.
//
// `--allow-official-spend` authorizes the HOST, so `writePatch` skips the whole
// `OFFICIAL_ROUTE_ROWS` set and the four web rows mount enabled. `--deny-web`
// writes their disable rows after every row that could have opened them; the
// preflight reads the composed dump back and fails unless all four are closed.
// ---------------------------------------------------------------------------

const WEB_ROWS = ['web-search-deepseek', 'web-deepseek-api', 'web', 'tool-web'];

function webRowStates(patch) {
  const lines = patch.split(/\r?\n/u);
  const states = {};
  for (const id of WEB_ROWS) {
    const at = lines.findIndex((line) => line.trim() === `- id: ${id}`);
    states[id] = at === -1 ? 'absent'
      : /^\s+disabled: true\s*(#.*)?$/u.test(lines[at + 1] ?? '') ? 'disabled' : 'enabled';
  }
  return states;
}

test('deny-web: an authorized official run without the flag leaves all four web rows open', { ...E2E }, () => {
  // The defect the flag closes: the opt-in skips OFFICIAL_ROUTE_ROWS, so the
  // patch carries no web disable rows at all. This test is the before-state.
  const { patch } = preflight(['--allow-official-spend', '--token-grant', '60000000'],
    'deepseek-official');
  assert.deepEqual(webRowStates(patch), {
    'web-search-deepseek': 'absent', 'web-deepseek-api': 'absent', web: 'absent', 'tool-web': 'absent',
  });
});

test('deny-web: the authorized official patch carries all four disable rows', { ...E2E }, () => {
  const { patch } = preflight(['--allow-official-spend', '--token-grant', '60000000', '--deny-web'],
    'deepseek-official');
  assert.deepEqual(webRowStates(patch), {
    'web-search-deepseek': 'disabled', 'web-deepseek-api': 'disabled', web: 'disabled', 'tool-web': 'disabled',
  });
});

test('deny-web: both arms show the four rows closed on the default route', { ...E2E }, () => {
  for (const arm of ['racoons', 'vanilla']) {
    const { patch } = preflight(['--deny-web'], 'mock', arm);
    assert.deepEqual(webRowStates(patch), {
      'web-search-deepseek': 'disabled', 'web-deepseek-api': 'disabled', web: 'disabled', 'tool-web': 'disabled',
    }, `the ${arm} arm's patch must close the four web rows`);
  }
});

test('deny-web: --help documents the flag and its preflight gate', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--deny-web\][\s\S]*?web-search-deepseek[\s\S]*?compose disabled/u);
});

// ---------------------------------------------------------------------------
// --workspace-only: the strict read rule. It cannot be combined with
// --allow-read, and the strict conversion is unit-tested in bench-run.test.mjs.
// ---------------------------------------------------------------------------

test('workspace-only: --allow-read cannot be combined with it', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--workspace-only', '--allow-read', 'C:/tmp/x'],
    /--workspace-only cannot be combined with --allow-read/u);
});

test('workspace-only: --help documents the strict rule', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--workspace-only\][\s\S]*?outside it fails the run/u);
});

test('workspace-only: the launch record states the strict boundary', { ...E2E }, () => {
  const { launch } = preflight(['--workspace-only']);
  assert.equal(launch.readBoundary.workspaceOnly, true);
  assert.deepEqual(launch.readBoundary.allowRead, []);
});

// ---------------------------------------------------------------------------
// --stop-at-checkpoint / --stop-after-compactions: the censored-partial stops.
// They are launcher-side rules: they must not reach the mount config, and the
// launch record must carry the intent before the child starts.
// ---------------------------------------------------------------------------

const CHECKPOINT = 'docs/plans/2026-10-27-extended-audit/07-plan-traceability.md';

test('stop-at-checkpoint: absent and present compose the SAME mount config', { ...E2E }, () => {
  const off = preflight([]).config;
  const on = preflight(['--stop-at-checkpoint', CHECKPOINT]).config;
  assert.deepEqual(on, off, 'the stop rule is the launcher\'s, so it must not reach a mount key');
  assert.equal(Object.hasOwn(on, 'stopAtCheckpoint'), false);
});

test('stop-at-checkpoint: the launch record carries the path and the censored-partial note', { ...E2E }, () => {
  const { launch } = preflight(['--stop-at-checkpoint', CHECKPOINT]);
  assert.deepEqual(launch.stopPolicy, {
    checkpoint: CHECKPOINT,
    afterCompactions: null,
    censoredPartial: true,
    note: 'a stop ends the run before BENCH-DONE; the result is a censored partial, never a pass',
  });
});

test('stop-at-checkpoint: absolute paths, .. and directories are refused by name', { ...E2E }, () => {
  for (const bad of ['C:/tmp/x.md', '/tmp/x.md', '../x.md', 'docs/../x.md', 'docs/']) {
    refused(['--arm', 'racoons', '--stop-at-checkpoint', bad],
      /--stop-at-checkpoint/u);
  }
});

test('stop-at-checkpoint: a file already in the arm is refused (a stop at t=0 measures nothing)', { ...E2E }, () => {
  const root = scratchRoot('test-racoons-bench-stop-');
  try {
    const armDir = join(root, 'arm');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(armDir);
    mkdirSync(join(armDir, 'docs'));
    writeFileSync(join(armDir, 'docs', 'checkpoint.md'), '# already here\n');
    const result = spawnSync(process.execPath, [SCRIPT, '--preflight', '--arm', 'racoons',
      '--provider', 'mock', '--plugin-dist', join(root, 'dist'), '--plugin-entry', SCRIPT,
      '--arm-dir', armDir, '--evidence', evidenceDir,
      '--stop-at-checkpoint', 'docs/checkpoint.md'], { encoding: 'utf8', cwd: root, windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /already exists[\s\S]*a stop at t=0 measures nothing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop-at-checkpoint: --require-done cannot be combined with it', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--stop-at-checkpoint', CHECKPOINT, '--require-done'],
    /--require-done cannot be combined with a checkpoint or compaction stop/u);
});

test('stop-at-checkpoint: it may not write a projection baseline', { ...E2E }, () => {
  refused(['--arm', 'racoons', '--provider', 'mock-replay', '--dry-work', '--stop-at-checkpoint', CHECKPOINT,
    '--projection-out', 'out.json', '--record', 'r.jsonl', '--record-map', 'm.json'],
  /--stop-at-checkpoint may not write a baseline/u);
});

test('stop-after-compactions: a positive integer, and it composes the same mount config', { ...E2E }, () => {
  const off = preflight([]).config;
  const on = preflight(['--stop-after-compactions', '2']).config;
  assert.deepEqual(on, off);
  const { launch } = preflight(['--stop-after-compactions', '2']);
  assert.equal(launch.stopPolicy.afterCompactions, 2);
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    refused(['--arm', 'racoons', '--stop-after-compactions', bad],
      /--stop-after-compactions takes a positive integer/u);
  }
});

test('stop flags: --help documents both names and the censored-partial label', { ...E2E }, () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--stop-at-checkpoint <relative path>\][\s\S]*?stopped-at-checkpoint/u);
  assert.match(help.stdout, /\[--stop-after-compactions <n>\][\s\S]*?stopped-after-compactions/u);
});
