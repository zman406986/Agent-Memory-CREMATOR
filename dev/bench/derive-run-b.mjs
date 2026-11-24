#!/usr/bin/env node
/**
 * Run B derivation — the delay-ratio facts read from `session.v4.jsonl`, never
 * from `result.json` (ISSUE-035 item 4; `archive/2026-10-24-live-ab-plan.md`
 * §3 chunk 11).
 *
 * Why the session log. On the live route `result.json` has no context
 * series, no `compaction` field, and its `usage.rows` carry no
 * `cacheReadTokens`; the per-message field exists in `session.v4.jsonl` alone
 * (`projcache` files hold totals, no series). Reading the run's own log is also
 * what keeps this derivation independent of the launcher that produced it.
 *
 * What it computes, per arm:
 *   (a) first forced loss — the first `compaction/start` event's
 *       `{seq, time, data.turn}`, plus the last `assistant/message` before it
 *       read as `input + cacheRead + cacheWrite` (the prompt that crossed);
 *   (b) peak prompt — the max of that same sum over every `assistant/message`;
 *   (c) cache hit rate — Σ`cacheReadTokens` ÷ Σ(`inputTokens` + `cacheReadTokens`)
 *       (a cache WRITE is a miss, so it is in neither half; ISSUE-173);
 *   (d) token volumes — the four sums, so the cap can be checked against them.
 *
 * Pair mode also prints the ratio the two first losses imply. That number
 * belongs to Run B; replaying round 1 only proves the arithmetic, because its
 * arms did different amounts of work before their boxes ran out.
 *
 * The two stop rules (R4, R5):
 *   - per arm, stop at Σ = the billed prompt-token cap (`--billed-cap`, default
 *     1 000 000 000; the old 80 000 000 default censored legitimate big runs);
 *   - an arm reaching 40 000 000 with no `compaction/start` stops and the ratio
 *     is unmeasured, with that reason. A first `compaction/start` must also land
 *     before 90 % of the arm's box with ≥ 3 completed steps after it; otherwise
 *     the ratio is unmeasured with the reason (the crossing is not evidence).
 *
 * Usage:
 *   node dev/bench/derive-run-b.mjs --session <session.v4.jsonl> [--arm <label>]
 *   node dev/bench/derive-run-b.mjs --result <evidence>/result.json
 *   node dev/bench/derive-run-b.mjs --vanilla <input> --racoons <input>
 *   flags: --box-ms <n> (default 5400000), --billed-cap <n> (default 1000000000),
 *          --json (the JSON document alone)
 *
 * An `<input>` is a `result.json` (its `session.files[]` is read) or a
 * `session.v4.jsonl` path (or a directory holding one). Files listed in
 * `result.json` that carry no `assistant/message` row are reported and ignored;
 * two files that both carry rows is an ambiguity this script refuses, not one
 * it merges: `seq` is per file, so a merged first-loss would be a fiction.
 *
 * Exit codes: 0 derived (single arm) or a measured pair ratio, 1 a stop rule
 * fired or the pair's ratio is unmeasured (the reason is printed), 2 usage or
 * unreadable input. An unmeasured pair still prints every number it could read.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The row shape and the billed-token sum are shared with the launcher's in-run
// token watchdog (`token-watchdog.mjs`): a live kill and this derivation must
// never disagree about what an arm has spent.
import { messageUsage } from './session-usage.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

/** Per-arm stop at this many billed prompt tokens unless `--billed-cap` says
 * otherwise (plan §3 chunk 11). An earlier 80 M default censored
 * legitimate big runs; an explicit flag still carries the stop-rule meaning. */
const DEFAULT_BILLED_CAP = 1_000_000_000;
/** With no forced loss at this much spend, the arm stops and the ratio is
 * unmeasured; a longer run would only cost tokens with nothing to compare. */
const NO_LOSS_STOP_TOKENS = 40_000_000;
/** The default box is Run B's `--kill-ms 5400000`. */
const DEFAULT_BOX_MS = 5_400_000;
/** A crossing must land before this share of the box to count as evidence. */
const CROSSING_SHARE = 0.9;
/** Complete steps required after the crossing for it with margin. */
const STEPS_AFTER_CROSSING = 3;

function refuse(message) {
  process.stderr.write(`derive-run-b.mjs: ${message}\n`);
  process.exit(2);
}

function usage() {
  process.stdout.write(
    'usage: derive-run-b.mjs --session <session.v4.jsonl> [--arm <label>] [--box-ms <n>] [--billed-cap <n>] [--json]\n'
    + '       derive-run-b.mjs --result <result.json> [--box-ms <n>] [--billed-cap <n>] [--json]\n'
    + '       derive-run-b.mjs --vanilla <result.json|session.v4.jsonl> --racoons <result.json|session.v4.jsonl> [--billed-cap <n>]\n',
  );
}

const DERIVE_OPTIONS = optionsOf([
  ['--session', 'string'],
  ['--result', 'string'],
  ['--vanilla', 'string'],
  ['--racoons', 'string'],
  ['--arm', 'string'],
  ['--box-ms', 'string', 'boxMs'],
  ['--billed-cap', 'string', 'billedCap'],
  ['--json', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: DERIVE_OPTIONS,
    refuse,
    // `usage()` writes the block itself; the helper's help path only needs to
    // print it and exit 0, exactly as the switch did.
    help: () => { usage(); return ''; },
  });
  const opts = {
    session: values.session ?? null,
    result: values.result ?? null,
    vanilla: values.vanilla ?? null,
    racoons: values.racoons ?? null,
    arm: values.arm ?? null,
    boxMs: values.boxMs === undefined ? DEFAULT_BOX_MS : Number(values.boxMs),
    billedCap: values.billedCap === undefined ? DEFAULT_BILLED_CAP : Number(values.billedCap),
    json: values.json ?? false,
  };
  if (!Number.isSafeInteger(opts.boxMs) || opts.boxMs <= 0) refuse('--box-ms must be a positive integer');
  if (!Number.isSafeInteger(opts.billedCap) || opts.billedCap <= 0) refuse('--billed-cap must be a positive integer');
  if ((opts.vanilla === null) !== (opts.racoons === null)) {
    refuse('--vanilla and --racoons are passed together or not at all');
  }
  const modes = [opts.session !== null, opts.result !== null, opts.vanilla !== null];
  if (modes.filter(Boolean).length !== 1) {
    refuse('pass exactly one of --session, --result, or the --vanilla/--racoons pair');
  }
  return opts;
}

/** Read a JSONL file into parsed events, named by line so a bad line can be reported. */
function readEvents(file) {
  const text = readFileSync(file, 'utf8');
  const events = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      refuse(`${file}: line ${String(i + 1)} is not JSON (${error.message})`);
    }
    events.push({ event, line: i + 1 });
  }
  return { file, sha256: createHash('sha256').update(text).digest('hex'), events };
}

/** One input (a result.json or a session log) resolved to its session file(s). */
function resolveInput(spec, label) {
  const full = resolve(spec);
  if (!existsSync(full)) refuse(`${label}: input not found at ${full}`);
  const info = statSync(full);
  if (info.isDirectory()) {
    const candidate = join(full, 'session.v4.jsonl');
    if (!existsSync(candidate)) refuse(`${label}: no session.v4.jsonl under ${full}`);
    return { arm: label, resultFile: null, sessionFiles: [candidate], result: null };
  }
  if (full.endsWith('.jsonl')) {
    return { arm: label, resultFile: null, sessionFiles: [full], result: null };
  }
  let result;
  try {
    result = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    refuse(`${label}: ${full} is neither a .jsonl session log nor readable JSON (${error.message})`);
  }
  const files = result?.session?.files;
  if (!Array.isArray(files) || files.length === 0) {
    refuse(`${label}: ${full} carries no session.files[] to read`);
  }
  // `result.arm` is an object in the bench's schema (`{name, dir, manifestMultiset}`);
  // take its name so a printed label is a string either way.
  const named = typeof result.arm === 'string' ? result.arm : result.arm?.name;
  return { arm: typeof named === 'string' && named !== '' ? named : label, resultFile: full, sessionFiles: files, result };
}

/** The last `assistant/message` before `seq`, or null. */
function lastMessageBefore(messages, seq) {
  let found = null;
  for (const message of messages) {
    if (message.seq < seq) found = message;
    else break;
  }
  return found;
}

/**
 * Derive one arm. Every number is read from the session log; nothing is
 * estimated and nothing is borrowed from `result.json`.
 * @returns {object}
 */
function derive(input, boxMs, billedCap) {
  const logs = input.sessionFiles.map((file) => {
    if (!existsSync(file)) refuse(`${input.arm}: session file listed in result.json is absent: ${file}`);
    return readEvents(file);
  });
  const withMessages = logs.filter((log) => log.events.some((row) => row.event.type === 'assistant/message'));
  const ignored = logs.filter((log) => !withMessages.includes(log)).map((log) => log.file);
  if (withMessages.length === 0) refuse(`${input.arm}: no assistant/message rows in ${input.sessionFiles.join(', ')}`);
  if (withMessages.length > 1) {
    refuse(`${input.arm}: ${String(withMessages.length)} session logs each carry assistant/message rows (${withMessages
      .map((log) => log.file).join(', ')}); seq is per file, so pass one with --session`);
  }
  const log = withMessages[0];

  let header = null;
  const messages = [];
  const starts = [];
  const ends = [];
  for (const { event } of log.events) {
    if (event.type === 'session' && header === null) header = event;
    const message = messageUsage(event);
    if (message !== null) messages.push(message);
    if (event.type === 'compaction/start') starts.push(event);
    if (event.type === 'compaction/end') ends.push(event);
  }

  let sumInput = 0;
  let sumCache = 0;
  let sumCacheWrite = 0;
  let billed = 0;
  let peak = null;
  for (const message of messages) {
    sumInput += message.inputTokens;
    sumCache += message.cacheReadTokens;
    sumCacheWrite += message.cacheWriteTokens;
    // The row's own billed sum, never a second expression of it: this file and
    // the in-run watchdog must state ONE number (ISSUE-173).
    billed += message.billedTokens;
    if (peak === null || message.billedTokens > peak.billedTokens) peak = message;
  }
  // A cache write is a cache MISS. The hit rate's denominator is the read and
  // the fresh input only, so folding writes into `billed` above cannot flatter
  // the rate on a route that writes cache.
  const freshPlusRead = sumInput + sumCache;

  // The first forced loss is the first `compaction/start` in the log, in log
  // order (seq is monotonic in a session file; the gate below proves it).
  const firstStart = starts.length === 0 ? null : starts.reduce((a, b) => (a.seq <= b.seq ? a : b));
  const before = firstStart === null ? null : lastMessageBefore(messages, firstStart.seq);

  // A "completed step" is one (turn, step) pair in an `assistant/message` after
  // the crossing. The step fields are not always present; without them the
  // message row itself is the completed step.
  const key = (message) => (message.turn === null || message.step === null
    ? `seq:${String(message.seq)}` : `${String(message.turn)}:${String(message.step)}`);
  const stepsAfter = firstStart === null ? null
    : new Set(messages.filter((message) => message.seq > firstStart.seq).map(key)).size;

  const createdAt = Number(header?.createdAt ?? log.events[0]?.event.time ?? 0);
  const elapsedMs = firstStart === null ? null : firstStart.time - createdAt;
  const ninetyMs = boxMs * CROSSING_SHARE;

  const crossingReasons = [];
  if (firstStart === null) crossingReasons.push('no compaction/start in the log');
  else {
    if (!(elapsedMs < ninetyMs)) {
      crossingReasons.push(`first compaction/start at ${String(elapsedMs)} ms is not before 90 % of the ${String(boxMs)} ms box (${String(ninetyMs)} ms)`);
    }
    if (stepsAfter < STEPS_AFTER_CROSSING) {
      crossingReasons.push(`only ${String(stepsAfter)} completed step(s) after the crossing; ${String(STEPS_AFTER_CROSSING)} required`);
    }
  }
  const crossingWithMargin = firstStart !== null && crossingReasons.length === 0;

  // The stop rules. `cap` is the spend ceiling; `noLossStop` is the 40 M rule
  // that exists so an arm with no forced loss cannot burn a whole box.
  const capReached = billed >= billedCap;
  const noLossStop = firstStart === null && billed >= NO_LOSS_STOP_TOKENS;

  // The unmeasured reason, in the order the plan states the rules.
  let unmeasuredReason = null;
  if (capReached) unmeasuredReason = `the arm reached the ${String(billedCap)} billed-token cap`;
  else if (noLossStop) unmeasuredReason = `the arm reached ${String(NO_LOSS_STOP_TOKENS)} billed tokens with no compaction/start`;
  else if (firstStart === null) unmeasuredReason = 'no compaction/start: no forced loss occurred';
  else if (!crossingWithMargin) unmeasuredReason = `the crossing did not happen with margin: ${crossingReasons.join('; ')}`;

  const seqMonotonic = messages.every((message, i) => i === 0 || messages[i - 1].seq <= message.seq);

  return {
    arm: input.arm,
    resultFile: input.resultFile,
    sessionFile: log.file,
    sessionSha256: log.sha256,
    sessionId: header?.id ?? null,
    createdAt: createdAt === 0 ? null : createdAt,
    events: log.events.length,
    messages: messages.length,
    firstSeq: messages[0]?.seq ?? null,
    lastSeq: messages[messages.length - 1]?.seq ?? null,
    seqMonotonic,
    ignoredSessionFiles: ignored,
    totals: {
      inputTokens: sumInput,
      cacheReadTokens: sumCache,
      cacheWriteTokens: sumCacheWrite,
      billedPromptTokens: billed,
      outputTokens: messages.reduce((sum, message) => sum + message.outputTokens, 0),
    },
    // Hits over (fresh input + reads): a write is a miss, so it stays out of
    // both halves. `billed` is the spend and is a different question.
    cacheHitRate: freshPlusRead === 0 ? null : sumCache / freshPlusRead,
    peakPrompt: peak === null ? null : {
      billedTokens: peak.billedTokens,
      inputTokens: peak.inputTokens,
      cacheReadTokens: peak.cacheReadTokens,
      cacheWriteTokens: peak.cacheWriteTokens,
      seq: peak.seq,
      time: peak.time,
      turn: peak.turn,
      step: peak.step,
    },
    firstForcedLoss: firstStart === null ? null : {
      seq: firstStart.seq,
      time: firstStart.time,
      turn: firstStart.data?.turn ?? null,
      tokensAtCrossing: before?.billedTokens ?? null,
      inputTokens: before?.inputTokens ?? null,
      cacheReadTokens: before?.cacheReadTokens ?? null,
      lastMessageBefore: before === null ? null : { seq: before.seq, time: before.time, turn: before.turn, step: before.step },
    },
    forcedLossCount: starts.length,
    compactionEnds: ends.length,
    crossing: {
      boxMs,
      ninetyPercentMs: ninetyMs,
      elapsedMs,
      stepsAfter,
      withMargin: crossingWithMargin,
      reasons: crossingReasons,
    },
    stopRules: {
      capTokens: billedCap,
      capReached,
      noLossStopTokens: NO_LOSS_STOP_TOKENS,
      noLossStop,
    },
    unmeasuredReason,
  };
}

/** 3× and 10× verdicts from the two arms, or null when a side is unmeasured. */
function delayRatio(vanilla, racoons) {
  if (vanilla.unmeasuredReason !== null) {
    return { measured: false, reason: `vanilla: ${vanilla.unmeasuredReason}` };
  }
  if (racoons.unmeasuredReason !== null) {
    return { measured: false, reason: `racoons: ${racoons.unmeasuredReason}` };
  }
  const denominator = vanilla.firstForcedLoss.tokensAtCrossing;
  const numerator = racoons.firstForcedLoss.tokensAtCrossing;
  if (denominator === null || numerator === null || denominator === 0) {
    return { measured: false, reason: 'a side has no assistant/message before its first compaction/start' };
  }
  const ratio = numerator / denominator;
  return {
    measured: true,
    definition: 'racoons billed prompt tokens at its first forced loss ÷ vanilla billed prompt tokens at its first forced loss',
    vanillaTokens: denominator,
    racoonsTokens: numerator,
    ratio,
    threeXMet: ratio >= 3,
    tenXMet: ratio >= 10,
  };
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(4)} %`;
}

function fix(value, places = 0) {
  return value === null ? 'n/a' : value.toFixed(places);
}

function printArm(arm) {
  const line = (text) => process.stdout.write(`${text}\n`);
  const loss = arm.firstForcedLoss;
  line(`arm=${arm.arm} session=${arm.sessionId ?? '(no header)'} events=${String(arm.events)} messages=${String(arm.messages)}`);
  if (arm.ignoredSessionFiles.length > 0) line(`ignored (no assistant/message): ${arm.ignoredSessionFiles.join(', ')}`);
  // The cache-write term is printed only when the route actually wrote cache,
  // so a log from a route without it prints the same line it always has.
  const writeSuffix = (writes) => (writes === 0 ? '' : ` + cacheWrite ${String(writes)}`);
  line(`billed prompt tokens=${String(arm.totals.billedPromptTokens)} (input ${String(arm.totals.inputTokens)} + cacheRead ${String(arm.totals.cacheReadTokens)}${writeSuffix(arm.totals.cacheWriteTokens)})`);
  line(`cache hit rate=${pct(arm.cacheHitRate)}`);
  line(arm.peakPrompt === null ? 'peak prompt=n/a'
    : `peak prompt=${String(arm.peakPrompt.billedTokens)} at seq ${String(arm.peakPrompt.seq)} (input ${String(arm.peakPrompt.inputTokens)} + cacheRead ${String(arm.peakPrompt.cacheReadTokens)}${writeSuffix(arm.peakPrompt.cacheWriteTokens)})`);
  line(loss === null ? 'first forced loss=none'
    : `first forced loss: seq ${String(loss.seq)} turn ${String(loss.turn)} ${loss.time === null ? '' : new Date(loss.time).toISOString()} tokens=${String(loss.tokensAtCrossing)}`);
  line(`forced-loss events=${String(arm.forcedLossCount)} compaction/end=${String(arm.compactionEnds)}`);
  line(`crossing: elapsed=${arm.crossing.elapsedMs === null ? 'n/a' : `${fix(arm.crossing.elapsedMs / 1000, 1)} s`} of ${fix(arm.crossing.boxMs / 1000, 0)} s box; steps after=${arm.crossing.stepsAfter === null ? 'n/a' : String(arm.crossing.stepsAfter)}; with margin=${arm.crossing.withMargin ? 'yes' : 'no'}`);
  if (arm.unmeasuredReason !== null) line(`ratio unmeasured: ${arm.unmeasuredReason}`);
}

const opts = parseArgs(process.argv.slice(2));

const pair = opts.vanilla !== null;
const inputs = pair
  ? [resolveInput(opts.vanilla, 'vanilla'), resolveInput(opts.racoons, 'racoons')]
  : [resolveInput(opts.session ?? opts.result, opts.arm ?? 'run-b')];

const arms = inputs.map((input) => derive(input, opts.boxMs, opts.billedCap));
const ratio = pair ? delayRatio(arms[0], arms[1]) : null;

if (!opts.json) {
  for (const arm of arms) printArm(arm);
  if (ratio !== null) {
    if (ratio.measured) {
      process.stdout.write(`delay ratio=${fix(ratio.ratio, 4)} (racoons ${String(ratio.racoonsTokens)} ÷ vanilla ${String(ratio.vanillaTokens)})\n`);
      process.stdout.write(`3× ${ratio.threeXMet ? 'met' : 'not met'}; 10× ${ratio.tenXMet ? 'met' : 'not met'}\n`);
    } else {
      process.stdout.write(`delay ratio unmeasured: ${ratio.reason}\n`);
    }
  }
}

// Machine output: the whole derivation, so a later note cites the exact shape.
const doc = {
  tool: 'derive-run-b (ISSUE-035 item 4; plan 2026-10-24 chunk 11)',
  boxMs: opts.boxMs,
  billedCap: opts.billedCap,
  arms,
  delayRatio: ratio,
  stopped: arms.some((arm) => arm.stopRules.capReached || arm.stopRules.noLossStop
    || (pair && arm.unmeasuredReason !== null)),
};
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
// The exit code is the launch gate: 0 means the numbers are a result, 1 means
// a rule stopped an arm or the pair has no measured ratio. A launch script that
// only checks for a crash would read an unmeasured ratio as a clean run.
const stopped = arms.some((arm) => arm.stopRules.capReached || arm.stopRules.noLossStop);
const unmeasured = pair && !ratio.measured;
process.exit(stopped || unmeasured ? 1 : 0);
