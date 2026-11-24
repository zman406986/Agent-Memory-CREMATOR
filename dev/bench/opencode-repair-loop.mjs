#!/usr/bin/env node
/**
 * Operator loop for one opencode lane segment.
 *
 * The opencode host ends a `run` when the model returns a turn with no tool
 * call; on the leak-safe lane the product-mounted arm does this every ~2 tasks
 * while the vanilla arm ran all 10. The lane's one-session rule forbids a new
 * session, so the operator continues the SAME session with a repair message
 * naming only the tasks that still lack a report — exactly the nudge a human
 * supervisor would send. This driver automates that loop:
 *
 *   while some task in the segment has no swe-results/<id>.md:
 *     build a repair task file for the missing tasks from the segment brief
 *     launch `opencode-run.mjs --continue-from <last arm dir>` with it
 *     rescan the work copy
 *
 * Every launch's evidence lands in its own directory under --evidence-root, so
 * each result.json is preserved; the chain is the ordered list of those dirs.
 * The runner exits non-zero when the run's own gates fail (the expected case
 * for an early stop); the driver ignores the exit code and reads the reports.
 *
 * Usage:
 *   node dev/bench/opencode-repair-loop.mjs --segment 1 \
 *     --brief dev/bench/bench-brief-opencode-leak-safe-110-seg1.md \
 *     --work-dir <arm>/world/work --prior <first arm dir> \
 *     --evidence-root scratchpad/launch/2026-11-18-leak-safe-110/opencode-seg1-repair \
 *     [--max-attempts 30] [--task-total 105] [--kill-ms 86400000] [--grant 300000000]
 *
 * The key is read from the owner's opencode auth store into the child
 * environment only; it is never written to a file, argv or log.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const RUNNER = fileURLToPath(new URL('./opencode-run.mjs', import.meta.url));

function fail(message) {
  process.stderr.write(`opencode-repair-loop.mjs: ${message}\n`);
  process.exit(2);
}

/** The flag table (ISSUE-392): the shared parser binds values, never the next flag. */
const REPAIR_LOOP_OPTIONS = optionsOf([
  ['--segment', 'string'], ['--arm', 'string'], ['--brief', 'string'],
  ['--work-dir', 'string'], ['--prior', 'string'], ['--evidence-root', 'string'],
  ['--max-attempts', 'string'], ['--task-total', 'string'],
  ['--kill-ms', 'string'], ['--grant', 'string'],
]);

export function parseArgs(argv) {
  const out = { maxAttempts: 30, taskTotal: 105, killMs: 86400000, grant: 300000000, arm: 'test' };
  // Throws with a plain message; `main` hands it to `fail` for the script's
  // stderr prefix and exit 2, so the CLI refusal path is unchanged.
  const { values } = parseDevArgs(argv, {
    options: REPAIR_LOOP_OPTIONS,
    refuse: (message) => { throw new Error(message); },
    // This script's own unknown-flag wording; kept exactly.
    unknown: (rawName) => `unknown flag ${rawName}`,
  });
  if (values.segment !== undefined) out.segment = Number(values.segment);
  if (values.arm !== undefined) out.arm = values.arm;
  if (values.brief !== undefined) out.brief = resolve(values.brief);
  if (values.workDir !== undefined) out.workDir = resolve(values.workDir);
  if (values.prior !== undefined) out.prior = resolve(values.prior);
  if (values.evidenceRoot !== undefined) out.evidenceRoot = resolve(values.evidenceRoot);
  if (values.maxAttempts !== undefined) out.maxAttempts = Number(values.maxAttempts);
  if (values.taskTotal !== undefined) out.taskTotal = Number(values.taskTotal);
  if (values.killMs !== undefined) out.killMs = Number(values.killMs);
  if (values.grant !== undefined) out.grant = Number(values.grant);
  for (const [key, flag] of [['segment', '--segment'], ['brief', '--brief'],
    ['workDir', '--work-dir'], ['prior', '--prior'], ['evidenceRoot', '--evidence-root']]) {
    if (out[key] === undefined || Number.isNaN(out[key])) throw new Error(`${flag} is required`);
  }
  /**
   * A NaN count or duration would make the loop exit before its first attempt
   * ("not complete after NaN attempts") or hand the runner a `NaN` kill timer
   * and grant, so the numeric flags are refused instead of coerced (ISSUE-392).
   */
  for (const [key, flag] of [['maxAttempts', '--max-attempts'], ['taskTotal', '--task-total'],
    ['killMs', '--kill-ms'], ['grant', '--grant']]) {
    if (Number.isNaN(out[key])) {
      throw new Error(`${flag} takes a number, got ${JSON.stringify(values[key])}`);
    }
  }
  if (out.arm !== 'test' && out.arm !== 'vanilla') throw new Error('--arm must be test or vanilla');
  return out;
}

/** The key the host reads; env-only, read from the owner's auth store. */
function readKey() {
  const path = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (!existsSync(path)) fail(`no opencode auth store at ${path}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  const key = doc?.deepseek?.key;
  if (typeof key !== 'string' || key.length === 0) fail(`${path} has no deepseek.key`);
  return key;
}

/**
 * The task blocks of one segment brief, in order. Fenced briefs separate
 * blocks by the next `Task k of N` marker and end at the protocol tail
 * (`- No network access`); raw follow-up files separate blocks with a line of
 * dashes. A block is the marker line through the line before the next marker
 * or the tail separator.
 */
function taskBlocks(text, total) {
  const marker = new RegExp(`^Task (\\d+) of ${String(total)} - (\\S+)$`, 'gm');
  const hits = [...text.matchAll(marker)].map((m) => ({
    k: Number(m[1]), id: m[2], at: m.index,
  }));
  if (hits.length === 0) fail('the brief names no task blocks');
  const tailAt = (from) => {
    const rest = text.slice(from);
    const fence = rest.search(/\n- No network access/u);
    const dashes = rest.search(/\n-{20,}\n/u);
    const found = [fence, dashes].filter((n) => n >= 0);
    return found.length === 0 ? text.length : from + Math.min(...found);
  };
  return hits.map((hit, index) => {
    const end = index + 1 < hits.length ? hits[index + 1].at : tailAt(hit.at);
    return { k: hit.k, id: hit.id, block: text.slice(hit.at, end).trimEnd() };
  });
}

function missingReports(workDir, ids) {
  return ids.filter((id) => !existsSync(join(workDir, 'swe-results', `${id}.md`)));
}

function composeRepair({ segment, missing, all, taskTotal }) {
  const done = all.filter((id) => !missing.includes(id));
  const lines = [
    `CONTINUATION - same session, same workspace (leak-safe segment ${String(segment)}).`,
    done.length > 0
      ? `Reports already exist for: ${done.join(', ')}. Do not redo them.`
      : 'No report exists yet for this segment.',
    'A task must end with its report file on disk. If a task is already fixed but its',
    'report is missing, write the report without redoing the fix. Work in the order',
    'below and keep going until every report named at the end exists.',
    '',
  ];
  for (const item of missing) lines.push(item.block, '');
  lines.push(
    '- Work one task at a time. Do not edit tests or files outside the task directory.',
    '- No network access. The shell is not available; the graders run the tests externally.',
    '- Write swe-results/<instance_id>.md for every task, even a BLOCKED one.',
    '',
    'The deliverables are, by exact path:',
    ...missing.map((item) => `swe-results/${item.id}.md`),
    '',
    'When every report file named above exists, print exactly one line as the last',
    'line of your final message: BENCH-DONE',
    '',
  );
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const key = readKey();
  const brief = readFileSync(opts.brief, 'utf8');
  const blocks = taskBlocks(brief, opts.taskTotal);
  const ids = blocks.map((item) => item.id);
  mkdirSync(opts.evidenceRoot, { recursive: true });
  let prior = opts.prior;
  let attempt = 0;
  for (; attempt < opts.maxAttempts; attempt += 1) {
    const missing = missingReports(opts.workDir, ids);
    process.stdout.write(`attempt ${String(attempt + 1)}: ${String(ids.length - missing.length)}/${String(ids.length)} reports; missing ${missing.join(',') || 'none'}\n`);
    if (missing.length === 0) {
      process.stdout.write(`segment ${String(opts.segment)} complete\n`);
      process.exit(0);
    }
    const missingItems = blocks.filter((item) => missing.includes(item.id));
    const taskFile = join(opts.evidenceRoot, `repair-task-${String(attempt + 1)}.md`);
    writeFileSync(taskFile, composeRepair({
      segment: opts.segment, missing: missingItems, all: ids, taskTotal: opts.taskTotal,
    }), 'utf8');
    const evidence = join(opts.evidenceRoot, `run-${String(attempt + 1)}`);
    const argv = [
      RUNNER, '--arm', opts.arm, '--provider', 'deepseek-official',
      '--i-am-the-owner', '--evidence', evidence, '--slug', `opencode-seg${String(opts.segment)}-repair`,
      '--task-file', taskFile, '--expect-final', 'BENCH-DONE',
      '--continue-from', prior, '--allow-native-compaction',
      /**
       * `attempt` is the number of launches before this one in this segment, so
       * it is the repair count through this launch (the first launch is 0). A
       * prior segment's count is not known here and is not added; the caveat
       * says earlier segments are separate arms.
       */
      '--repair-count', String(attempt),
      ...(opts.arm === 'test'
        ? ['--ask-grammar', 'jsonl-20-nokeepall',
          '--prune-threshold-tokens', '60000', '--context-window-tokens', '400000'] : []),
      '--token-grant', String(opts.grant), '--kill-ms', String(opts.killMs),
    ];
    const run = spawnSync(process.execPath, argv, {
      cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: key }, stdio: 'inherit',
    });
    const arm = join(evidence, opts.arm);
    if (!existsSync(join(arm, 'result.json'))) {
      process.stderr.write(`launch produced no result.json at ${arm}; stopping\n`);
      process.exit(1);
    }
    let result;
    try {
      result = JSON.parse(readFileSync(join(arm, 'result.json'), 'utf8'));
    } catch (error) {
      process.stderr.write(`result.json at ${arm} did not parse (${error instanceof Error ? error.message : String(error)}); stopping\n`);
      process.exit(1);
    }
    process.stdout.write(`  exit=${String(run.status)} passed=${String(result.passed)} removals=${String(result.removals?.applied ?? 'null')} final=${JSON.stringify(result.task?.finalText ?? '').slice(0, 120)}\n`);
    prior = arm;
  }
  process.stderr.write(`segment ${String(opts.segment)} not complete after ${String(opts.maxAttempts)} attempts\n`);
  process.exit(1);
}

// A direct run drives the loop; an import (the parser regression test) does not.
if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
