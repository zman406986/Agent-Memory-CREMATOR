#!/usr/bin/env node
/**
 * The "Host pruner trims" / "Tokens the host shadowed" columns of
 * `docs/research/2026-10-29-full-rerun-pair.md` §1 and §3, hand-counted until
 * this script. `derive-run-b.mjs` owns spend, delay and crossing; this adds only
 * these columns plus peak prompt, so one command carries the pair table.
 *
 * Row filter, settled against the published values (racoons 42 / 134,670,
 * vanilla 132 / 484,155): a trim is `type === 'compaction/prune'`; tokens are
 * Σ `data.shadowedTokenCount` over exactly those rows. `compaction/summary`
 * carries the same field (racoons 241,208 over 1 row, vanilla 478,928 over 2) —
 * the compaction's own shadow, not a pruner trim; folding it in breaks both
 * columns, so it is reported beside, never inside. `compaction/start` and
 * `compaction/end` do not carry the field. Peak prompt is max `billedTokens` —
 * `inputTokens + cacheReadTokens + cacheWriteTokens` — over `assistant/message`,
 * read through `session-usage.mjs` so it matches derive-run-b exactly. Inputs
 * are streamed a line at a time. Exit codes: 0 read, 2 usage or unreadable
 * input.
 *
 * usage: --session <log|dir> [--arm <l>] | --result <result.json>
 *        | --vanilla <in> --racoons <in>; flag: --json
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { messageUsage } from './session-usage.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const PAIR_TRIMS_OPTIONS = optionsOf([
  ['--session', 'string'],
  ['--result', 'string'],
  ['--vanilla', 'string'],
  ['--racoons', 'string'],
  ['--arm', 'string'],
  ['--json', 'boolean'],
]);

function refuse(message) {
  process.stderr.write(`pair-trims.mjs: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: PAIR_TRIMS_OPTIONS,
    refuse,
  });
  const opts = {
    session: values.session ?? null,
    result: values.result ?? null,
    vanilla: values.vanilla ?? null,
    racoons: values.racoons ?? null,
    arm: values.arm ?? null,
    json: values.json ?? false,
  };
  if ((opts.vanilla === null) !== (opts.racoons === null)) refuse('--vanilla and --racoons go together');
  const modes = [opts.session !== null, opts.result !== null, opts.vanilla !== null];
  if (modes.filter(Boolean).length !== 1) {
    refuse('pass exactly one of --session, --result, or the --vanilla/--racoons pair');
  }
  return opts;
}

/** One input (a result.json or a session log) resolved to its session file(s). */
function resolveInput(spec, label) {
  const full = resolve(spec);
  if (!existsSync(full)) refuse(`${label}: input not found at ${full}`);
  if (statSync(full).isDirectory()) {
    const candidate = join(full, 'session.v4.jsonl');
    if (!existsSync(candidate)) refuse(`${label}: no session.v4.jsonl under ${full}`);
    return { arm: label, sessionFiles: [candidate] };
  }
  if (full.endsWith('.jsonl')) return { arm: label, sessionFiles: [full] };
  let result;
  try {
    result = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    refuse(`${label}: ${full} is not a session log and not readable JSON (${error.message})`);
  }
  const files = result?.session?.files;
  if (!Array.isArray(files) || files.length === 0) refuse(`${label}: ${full} carries no session.files[]`);
  const named = typeof result.arm === 'string' ? result.arm : result.arm?.name;
  return { arm: typeof named === 'string' && named !== '' ? named : label, sessionFiles: files };
}

/** Stream one arm's logs and total the trim columns. */
async function scan(input) {
  const arm = {
    arm: input.arm, sessionFiles: input.sessionFiles, events: 0, messages: 0,
    pruneEvents: 0, shadowedTokens: 0, summaryRows: 0, summaryShadowedTokens: 0, peak: null,
  };
  for (const file of input.sessionFiles) {
    if (!existsSync(file)) refuse(`${input.arm}: session file listed in result.json is absent: ${file}`);
    const reader = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let line = 0;
    for await (const text of reader) {
      line += 1;
      if (text.trim() === '') continue;
      let event;
      try {
        event = JSON.parse(text);
      } catch (error) {
        refuse(`${file}: line ${String(line)} is not JSON (${error.message})`);
      }
      arm.events += 1;
      const shadowed = Number(event.data?.shadowedTokenCount);
      if (event.type === 'compaction/prune') {
        arm.pruneEvents += 1;
        if (Number.isFinite(shadowed)) arm.shadowedTokens += shadowed;
      } else if (event.type === 'compaction/summary' && Number.isFinite(shadowed)) {
        arm.summaryRows += 1;
        arm.summaryShadowedTokens += shadowed;
      }
      const message = messageUsage(event);
      if (message === null) continue;
      arm.messages += 1;
      if (arm.peak === null || message.billedTokens > arm.peak.billedTokens) {
        arm.peak = { billedTokens: message.billedTokens, seq: message.seq, turn: message.turn, step: message.step };
      }
    }
  }
  return arm;
}

const opts = parseArgs(process.argv.slice(2));
const pair = opts.vanilla !== null;
const inputs = pair
  ? [resolveInput(opts.vanilla, 'vanilla'), resolveInput(opts.racoons, 'racoons')]
  : [resolveInput(opts.session ?? opts.result, opts.arm ?? 'run')];
const arms = [];
for (const input of inputs) arms.push(await scan(input));

const doc = {
  tool: 'pair-trims (docs/research/2026-10-29-full-rerun-pair.md §1, §3)',
  rowFilter: "trim = type === 'compaction/prune'; tokens = Σ data.shadowedTokenCount over those rows",
  arms,
};

if (!opts.json) {
  for (const a of arms) {
    const peak = a.peak === null ? 'n/a'
      : `${String(a.peak.billedTokens)} at seq ${String(a.peak.seq)} (turn ${String(a.peak.turn)} step ${String(a.peak.step)})`;
    process.stdout.write(`arm=${a.arm} events=${String(a.events)} messages=${String(a.messages)}\n`
      + `prune events=${String(a.pruneEvents)} shadowed tokens=${String(a.shadowedTokens)}\n`
      + `compaction/summary shadowed=${String(a.summaryShadowedTokens)} over ${String(a.summaryRows)} row(s) — not a pruner trim, excluded\n`
      + `peak prompt=${peak}\n`);
  }
}
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
process.exit(0);
