#!/usr/bin/env node
/**
 * Segment audit — digest ONE finished bench-run leg for the ISSUE-289 segmented
 * campaign (`docs/plans/2026-11-18-leak-safe-110/plan.md`).
 *
 * It reads, never writes, the evidence dir:
 *   - `result.json` (required): the run's own projection.
 *   - `stdout.ndjson` and/or `sessions/<project>/<session>/session.v4.jsonl`:
 *     tool calls for the loop and pacing detectors.
 *   - `racoons/cremator-events.jsonl` (product arm): the product journal.
 *   - `swe-score/swe-score.json` (optional): per-task scoring, written by
 *     `dev/bench/swe-score.mjs --out <dir>`.
 *
 * Usage:
 *   node dev/bench/segment-audit.mjs --evidence <dir> [--deliverables <file>]
 *        [--out <file>] [--json]
 *
 * `--deliverables` takes the same shapes `dsh-checkpoints.mjs` accepts: a JSON
 * array, an object with a `deliverables` array, or a newline file. With no
 * flag the expected list is `result.checkpoints.paths`.
 *
 * `--out` writes the JSON digest; a relative path lands inside the evidence
 * dir. `--json` prints the JSON instead of the human table. The exit code is 0
 * on every audit, RED included: RED is data, not an audit failure.
 *
 * Denominations. "wall" comes from the session log's `tool/call.time` (epoch
 * ms); stdout.ndjson carries no timestamps. An item span is the first-to-last
 * completed-lane tool call naming the item, `todo_write` excluded (its todo
 * text names every item at step 1 and would flatten every span to the run).
 * Timestamps/walls that cannot be read are `null`, printed as `absent`.
 */

import {
  existsSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'racoons-segment-audit/1';
const USAGE = 'usage: node dev/bench/segment-audit.mjs --evidence <dir> '
  + '[--deliverables <file>] [--out <file>] [--json]';

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const isStr = (value) => typeof value === 'string' && value.length > 0;
const num = (value) => (isNum(value) ? value : null);
const list = (value) => (Array.isArray(value) ? value : null);

/** Parse and normalize the deliverables file. `null` means "not supplied". */
export function loadDeliverables(file) {
  if (!isStr(file) || !existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').trim();
  if (text === '') return null;
  const pick = (entry) => (typeof entry === 'string' ? entry
    : String(entry?.path ?? entry?.file ?? entry?.raw ?? entry?.name ?? '')).trim();
  try {
    const parsed = JSON.parse(text);
    const array = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.deliverables) ? parsed.deliverables : null;
    if (array !== null) return array.map(pick).filter(Boolean);
  } catch { /* a newline file, not JSON */ }
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function readJson(file) {
  try { return { present: true, value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch { return { present: false, value: null }; }
}

function readNdjson(file) {
  if (!existsSync(file)) return { present: false, rows: [], malformed: 0 };
  const rows = [];
  let malformed = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try { rows.push(JSON.parse(line)); } catch { malformed += 1; }
  }
  return { present: true, rows, malformed };
}

function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** The session log the audit read: `session.v4.jsonl` under `sessions/`, the
 * largest when several exist (a resumed leg keeps one adopted log). */
function findSession(evidenceDir) {
  const files = walkFiles(join(evidenceDir, 'sessions'))
    .filter((file) => file.endsWith('.jsonl') || /session-.*\.v4\.jsonl$/u.test(file));
  if (files.length === 0) return { file: null, events: [] };
  files.sort((a, b) => {
    try { return statSync(b).size - statSync(a).size; } catch { return 0; }
  });
  return { file: files[0], events: readNdjson(files[0]).rows };
}

/** Tool calls from the session log first (they carry `time`), else stdout. */
export function toolCallsOf(sessionEvents, stdoutRows) {
  const fromSession = [];
  for (const event of sessionEvents) {
    if (event?.type !== 'tool/call') continue;
    const data = event.data ?? {};
    fromSession.push({
      tool: String(data.name ?? ''),
      args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null),
      seq: num(event.seq),
      time: num(event.time),
      source: 'session',
    });
  }
  if (fromSession.length > 0) return { calls: fromSession, source: 'session', timed: true };
  const fromStdout = [];
  for (const row of stdoutRows) {
    if (row?.type !== 'tool_call') continue;
    fromStdout.push({
      tool: String(row.tool ?? ''),
      args: JSON.stringify(row.input ?? null),
      seq: fromStdout.length,
      time: null,
      source: 'stdout',
    });
  }
  return { calls: fromStdout, source: 'stdout', timed: false };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Nearest-rank p95: the smallest value whose rank reaches 95 percent. */
const p95 = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
};

/** Maximal runs of >=3 consecutive calls with the same tool and identical args. */
export function findLoops(calls) {
  const runs = [];
  let index = 0;
  while (index < calls.length) {
    let end = index + 1;
    while (end < calls.length
      && calls[end].tool === calls[index].tool
      && calls[end].args === calls[index].args) end += 1;
    if (end - index >= 3) {
      runs.push({
        tool: calls[index].tool,
        count: end - index,
        firstSeq: calls[index].seq,
        firstAtMs: calls[index].time,
        args: calls[index].args.slice(0, 140),
      });
    }
    index = end;
  }
  return runs;
}

function matchKeys(path) {
  const name = basename(path);
  const stem = name.replace(/\.[^.]+$/u, '');
  const keys = [];
  if (stem !== '') keys.push(`swe/${stem.toLowerCase()}`);
  if (name !== '') keys.push(name.toLowerCase());
  return [...new Set(keys)];
}

/** Per-deliverable span: first-to-last tool call naming the item. Every match
 * key contributes (the repo path early, the report name at the write); a bare
 * stem is never a key because it matches prose. */
export function itemPacing(deliverables, calls) {
  const candidates = calls.filter((call) => call.tool !== 'todo_write');
  const items = deliverables.map((path) => {
    const keys = matchKeys(path);
    const hits = candidates.filter((call) => {
      const text = call.args.toLowerCase();
      return keys.some((key) => text.includes(key));
    });
    const matchedBy = keys.find((key) => candidates.some(
      (call) => call.args.toLowerCase().includes(key))) ?? null;
    const first = hits[0] ?? null;
    const last = hits.length > 0 ? hits[hits.length - 1] : null;
    const wallMs = first !== null && last !== null && first.time !== null && last.time !== null
      ? Math.max(0, last.time - first.time) : null;
    return {
      path,
      name: basename(path).replace(/\.[^.]+$/u, ''),
      matched: hits.length > 0,
      matchedBy,
      calls: hits.length,
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      firstAtMs: first?.time ?? null,
      lastAtMs: last?.time ?? null,
      wallMs: hits.length >= 2 ? wallMs : null,
      wall: hits.length >= 2 ? wallMs : 'absent',
    };
  });
  const walls = items.map((item) => item.wallMs).filter(isNum);
  const itemMedian = median(walls);
  const stuck = isNum(itemMedian) && itemMedian > 0
    ? items.filter((item) => isNum(item.wallMs) && item.wallMs > 3 * itemMedian)
      .map((item) => ({ path: item.path, wallMs: item.wallMs }))
    : [];
  return {
    items,
    stats: {
      derived: walls.length,
      absent: items.length - walls.length,
      maxMs: walls.length > 0 ? Math.max(...walls) : null,
      medianMs: itemMedian,
      p95Ms: p95(walls),
    },
    stuck,
  };
}

function gateRow(rows, failed, name, value, ok) {
  rows.push({ name, value, ok });
  if (ok === false) failed.push(name);
}

function gatesOf(result, present) {
  const rows = [];
  const failed = [];
  if (!present) {
    rows.push({ name: 'result.json', value: 'absent', ok: false });
    return { verdict: 'RED', rows, failed: ['result.json'], present: false };
  }
  const watchdog = result.watchdog ?? {};
  const usage = result.usage ?? {};
  const coverage = usage.coverage ?? {};
  const checkpoints = result.checkpoints ?? {};
  const paths = list(checkpoints.paths);
  const expected = num(checkpoints.expected) ?? (paths === null ? null : paths.length);
  const created = num(checkpoints.created);
  const usageRows = num(usage.usageRows);
  const turns = num(usage.assistantTurns);
  const violations = list(result.readBoundary?.violations);
  const violationCount = violations !== null ? violations.length
    : num(result.readBoundary?.violations);

  gateRow(rows, failed, 'passed', result.passed ?? 'absent', result.passed === true);
  gateRow(rows, failed, 'citableAs', result.citableAs ?? 'absent', isStr(result.citableAs));
  gateRow(rows, failed, 'watchdog.tokenGrant', watchdog.tokenGrant ?? 'absent',
    isNum(watchdog.tokenGrant));
  gateRow(rows, failed, 'watchdog.tokenFired', watchdog.tokenFired ?? 'absent',
    watchdog.tokenFired === false);
  gateRow(rows, failed, 'watchdog.fired', watchdog.fired ?? 'absent', watchdog.fired === false);
  gateRow(rows, failed, 'timeoutMs', watchdog.timeoutMs ?? 'absent',
    isNum(watchdog.timeoutMs));
  gateRow(rows, failed, 'usage.usageRows', usageRows === null ? 'absent' : `${String(usageRows)}/${String(turns ?? 'absent')}`,
    usageRows !== null && turns !== null && usageRows === turns);
  gateRow(rows, failed, 'usage.coverage.reconciled', coverage.reconciled ?? 'absent',
    coverage.reconciled === true);
  const armName = result.arm?.name ?? null;
  const prunerState = result.hostPruner?.state ?? null;
  const prunerExpected = armName === 'racoons' ? 'disabled'
    : armName === 'vanilla' ? 'host-default' : null;
  gateRow(rows, failed, 'hostPruner.state', prunerState ?? 'absent',
    prunerExpected === null ? null : prunerState === prunerExpected);
  gateRow(rows, failed, 'readBoundary.violations', violationCount ?? 'absent',
    violationCount === 0);
  gateRow(rows, failed, 'checkpoints.expected', expected ?? 'absent', isNum(expected));
  gateRow(rows, failed, 'checkpoints.created', created ?? 'absent',
    isNum(expected) && created === expected);
  gateRow(rows, failed, 'checkpoints.paths', paths === null ? 'absent' : paths.length,
    paths !== null && (expected === null || paths.length === expected));

  const round = num(result.round);
  if (round !== null) {
    const priorSeq = num(result.resumedFrom?.priorSeq);
    gateRow(rows, failed, 'round', round, round >= 1);
    gateRow(rows, failed, 'resumedFrom.priorSeq', priorSeq ?? 'absent', isNum(priorSeq));
  }
  return {
    verdict: failed.length === 0 ? 'GREEN' : 'RED',
    rows,
    failed,
    present: true,
  };
}

function findDollars(node, path = '', depth = 0) {
  if (depth > 3 || node === null || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (isNum(value) && /cost|usd|dollar|price/iu.test(key)) {
      return { name: `${path}${key}`, value };
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const found = findDollars(value, `${path}${key}.`, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function spendOf(result, present) {
  if (!present) {
    return {
      rows: [
        { name: 'true total', value: 'absent' },
        { name: 'billed prompt', value: 'absent' },
        { name: 'billed completion', value: 'absent' },
        { name: 'dollars', value: 'absent' },
      ],
      absent: true,
    };
  }
  const watchdog = result.watchdog ?? {};
  const usage = result.usage ?? {};
  const context = result.context ?? {};
  const compaction = result.compaction ?? {};
  const dollars = findDollars(result);
  const rows = [
    { name: 'true total', value: num(watchdog.trueTotalTokens) ?? 'absent' },
    { name: 'main prompt', value: num(watchdog.mainPromptTokens) ?? 'absent' },
    { name: 'main output', value: num(watchdog.mainOutputTokens) ?? 'absent' },
    { name: 'ask prompt', value: num(watchdog.askInputTokens) ?? 'absent' },
    { name: 'ask output', value: num(watchdog.askOutputTokens) ?? 'absent' },
    { name: 'billed prompt', value: num(usage.billedPromptTokens) ?? 'absent' },
    { name: 'billed completion', value: num(usage.outputTokens) ?? 'absent' },
    { name: 'cache read', value: num(usage.cacheReadTokens) ?? 'absent' },
    { name: 'cache write', value: num(usage.cacheWriteTokens) ?? 'absent' },
    { name: 'uncached input', value: num(usage.inputTokens) ?? 'absent' },
    { name: 'dollars', value: dollars === null ? 'absent' : `${String(dollars.value)} (${dollars.name})` },
    { name: 'peak context', value: num(context.peak) ?? 'absent' },
    { name: 'peak request', value: num(context.peakRequest) ?? 'absent' },
    { name: 'compaction count', value: num(compaction.count) ?? 'absent' },
    { name: 'compaction atRequests', value: list(compaction.atRequests)?.join(',') || 'none' },
    { name: 'compaction atSeqs', value: list(compaction.atSeqs)?.join(',') || 'none' },
  ];
  return {
    rows,
    trueTotalTokens: num(watchdog.trueTotalTokens),
    mainPromptTokens: num(watchdog.mainPromptTokens),
    mainOutputTokens: num(watchdog.mainOutputTokens),
    askInputTokens: num(watchdog.askInputTokens),
    askOutputTokens: num(watchdog.askOutputTokens),
    billedPromptTokens: num(usage.billedPromptTokens),
    billedCompletionTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    dollars,
    peakContext: num(context.peak),
    peakRequest: num(context.peakRequest),
    compactions: num(compaction.count),
    compactionAtRequests: list(compaction.atRequests),
    compactionAtSeqs: list(compaction.atSeqs),
    absent: false,
  };
}

/** Journal counts. On a resumed leg the file is cumulative, so the read starts
 * at `result.resumedFrom.askJournals[].bytes`, the byte boundary `bench-run.mjs`
 * itself uses. The file is the truth; `result.journal.byKind` is the fallback
 * when the product arm emitted one but the file is gone. */
export function journalOf(evidenceDir, result) {
  const file = [
    join(evidenceDir, 'racoons', 'cremator-events.jsonl'),
    join(evidenceDir, 'cremator-events.jsonl'),
  ].find(existsSync);
  let lines = [];
  let byKind = {};
  let unparsable = 0;
  let source = null;
  let fromByte = 0;
  let fileLines = null;
  if (file !== undefined) {
    source = file;
    const buffer = readFileSync(file);
    fileLines = buffer.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '').length;
    const boundaries = list(result?.resumedFrom?.askJournals) ?? [];
    const boundary = boundaries.find((entry) => isStr(entry?.file)
      && resolve(entry.file) === resolve(file));
    if (boundary !== undefined && isNum(boundary.bytes)) fromByte = boundary.bytes;
    // Re-parse from the byte boundary: line boundaries are byte boundaries.
    const legText = buffer.subarray(fromByte).toString('utf8');
    lines = [];
    for (const line of legText.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try { lines.push(JSON.parse(line)); } catch { unparsable += 1; }
    }
    for (const line of lines) {
      const kind = typeof line?.kind === 'string' ? line.kind : '(no-kind)';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  } else if (result?.journal?.byKind !== null && typeof result?.journal?.byKind === 'object'
    && Object.keys(result.journal.byKind).length > 0) {
    byKind = { ...result.journal.byKind };
    source = 'result.json.journal.byKind';
  }
  const present = source !== null;
  const fromResult = num(result?.removals?.applied);
  const appliedRemovals = fromResult ?? (present
    ? lines.filter((line) => line?.kind === 'prune-apply' && isNum(line.removals))
      .reduce((sum, line) => sum + line.removals, 0)
    : null);
  const recallPublishes = present ? (byKind.publish ?? 0) : null;
  let capArchives = present && file !== undefined ? 0 : null;
  if (present) {
    for (const [kind, count] of Object.entries(byKind)) {
      if (/archive/iu.test(kind) && /cap/iu.test(kind)) capArchives += count;
    }
    for (const line of lines) {
      for (const archive of Array.isArray(line?.archives) ? line.archives : []) {
        if (String(archive?.operationKind ?? '') === 'cap') capArchives += 1;
      }
    }
  }
  return {
    present,
    source,
    fromByte,
    fileLines,
    lines: present && file !== undefined ? lines.length : (present ? num(result?.journal?.lines) : null),
    unparsable,
    byKind,
    appliedRemovals,
    recallPublishes,
    capArchives,
    capArchiveOk: capArchives === 0 ? true : capArchives === null ? null : false,
  };
}

const SCORE_CANDIDATES = (evidenceDir) => [
  join(evidenceDir, 'swe-score', 'swe-score.json'),
  join(evidenceDir, 'swe-score.json'),
  join(dirname(evidenceDir), 'swe-score', 'swe-score.json'),
  join(dirname(evidenceDir), 'swe-score.json'),
];

export function scoringOf(evidenceDir) {
  const file = SCORE_CANDIDATES(evidenceDir).find(existsSync) ?? null;
  if (file === null) return { present: false, file: null, summary: null, tasks: [] };
  const read = readJson(file);
  if (!read.present || read.value === null) {
    return { present: true, file, summary: null, tasks: [], unreadable: true };
  }
  const summary = read.value.summary ?? null;
  const tasks = (list(read.value.results) ?? []).map((row) => {
    const raw = String(row?.verdict ?? 'absent').toLowerCase();
    const verdict = raw === 'not-collected' || raw === 'notcollected' ? 'notCollected' : raw;
    return {
      instanceId: String(row?.instance_id ?? 'absent'),
      verdict,
      tamperedPaths: list(row?.tamperedPaths)?.length ?? num(row?.tamperedPaths) ?? 0,
      seconds: num(row?.seconds),
      notes: typeof row?.notes === 'string' ? row.notes : null,
    };
  });
  return { present: true, file, summary, tasks, unreadable: false };
}

function stamp(ms) {
  if (!isNum(ms)) return 'absent';
  return new Date(ms).toISOString().slice(11, 19);
}

function wallText(ms) {
  return isNum(ms) ? `${(ms / 1000).toFixed(1)}s` : 'absent';
}

/** The whole digest. Pure read; no write. */
export function auditEvidence(evidenceDir, deliverables) {
  const dir = resolve(evidenceDir);
  const resultRead = readJson(join(dir, 'result.json'));
  const result = resultRead.value;
  const stdout = readNdjson(join(dir, 'stdout.ndjson'));
  const session = findSession(dir);
  // A resumed leg adopts the whole prior session log; only calls after the
  // boundary are this segment's pacing. stdout.ndjson is already per-leg
  // (bench-run moves the previous leg's file into round-N/).
  const priorSeq = num(result?.resumedFrom?.priorSeq);
  const legEvents = priorSeq === null ? session.events
    : session.events.filter((event) => num(event?.seq) === null || event.seq > priorSeq);
  const { calls, source: callSource, timed } = toolCallsOf(legEvents, stdout.rows);
  const expected = list(deliverables)
    ?? list(result?.checkpoints?.paths)
    ?? [];
  const pacing = itemPacing(expected, calls);
  const loops = findLoops(calls);
  const journal = journalOf(dir, result);
  const scoring = scoringOf(dir);
  const gates = gatesOf(result, resultRead.present);
  const spend = spendOf(result, resultRead.present);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    evidence: dir,
    arm: result?.arm?.name ?? null,
    resultPresent: resultRead.present,
    session: { file: session.file, events: session.events.length },
    gates,
    spend,
    pacing: {
      basis: timed
        ? `session tool/call mention span (first-to-last; todo_write excluded)`
        : `stdout tool_call mention span (no timestamps: walls absent)`,
      callSource,
      calls: calls.length,
      timestamps: timed,
      legFromSeq: priorSeq,
      deliverables: expected.length,
      ...pacing,
      loops,
      derivable: {
        itemTimestamps: timed,
        itemWall: pacing.stats.derived > 0,
        stuck: pacing.stats.derived >= 2,
        loops: calls.length > 0,
        deliverableList: expected.length > 0,
      },
    },
    journal,
    scoring,
    stdout: { present: stdout.present, rows: stdout.rows.length, malformed: stdout.malformed },
  };
}

function printHuman(digest) {
  const out = [];
  out.push(`SEGMENT AUDIT ${digest.evidence}`);
  out.push(`arm: ${digest.arm ?? 'absent'}  result.json: ${digest.resultPresent ? 'present' : 'absent'}`
    + `  session: ${digest.session.file === null ? 'absent' : `${digest.session.events} events`}`);
  out.push('');
  out.push('GATES');
  for (const row of digest.gates.rows) out.push(`  ${row.name}: ${String(row.value)}`);
  out.push(`GATES: ${digest.gates.verdict === 'GREEN' ? 'GREEN'
    : `RED (${digest.gates.failed.join(', ')})`}`);
  out.push('');
  out.push('SPEND');
  for (const row of digest.spend.rows) out.push(`  ${row.name}: ${String(row.value)}`);
  out.push('');
  out.push('ITEM PACING');
  out.push(`  basis: ${digest.pacing.basis}`);
  out.push(`  calls: ${digest.pacing.calls}  deliverables: ${digest.pacing.deliverables}`);
  for (const item of digest.pacing.items) {
    out.push(`  ${item.name}: wall ${item.matched ? wallText(item.wallMs) : 'absent'}`
      + `  first ${stamp(item.firstAtMs)}  last ${stamp(item.lastAtMs)}`
      + `  calls ${item.calls}${item.matched ? '' : '  (no mention)'}`);
  }
  const stats = digest.pacing.stats;
  out.push(`  max: ${wallText(stats.maxMs)}  median: ${wallText(stats.medianMs)}`
    + `  p95: ${wallText(stats.p95Ms)}  derivable: ${stats.derived}/${digest.pacing.deliverables}`
    + `  absent: ${stats.absent}`);
  out.push(`  stuck (>3x median): ${digest.pacing.stuck.length === 0 ? 'none'
    : digest.pacing.stuck.map((s) => `${s.path} ${wallText(s.wallMs)}`).join(', ')}`);
  out.push(`  loops (>=3 identical calls in a row): ${digest.pacing.loops.length === 0 ? 'none'
    : digest.pacing.loops.map((l) => `${l.tool} x${String(l.count)} at seq ${String(l.firstSeq)}`).join(', ')}`);
  out.push('');
  out.push('JOURNAL');
  if (!digest.journal.present) {
    out.push('  present: absent (not the product arm, or the journal is gone)');
  } else {
    out.push(`  lines: ${String(digest.journal.lines ?? 'absent')}  source: ${String(digest.journal.source)}`
      + (digest.journal.fileLines === null ? ''
        : `  file lines: ${String(digest.journal.fileLines)}  leg from byte: ${String(digest.journal.fromByte)}`));
    out.push(`  applied removals: ${String(digest.journal.appliedRemovals ?? 'absent')}`);
    out.push(`  recall publishes: ${String(digest.journal.recallPublishes ?? 'absent')}`);
    out.push(`  cap archives: ${String(digest.journal.capArchives ?? 'absent')} (must be 0)`);
    const kinds = Object.entries(digest.journal.byKind)
      .sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${String(count)}`);
    out.push(`  kinds: ${kinds.join(' ') || 'none'}`);
  }
  out.push('');
  out.push('SCORING');
  if (!digest.scoring.present) {
    out.push('  present: absent');
  } else if (digest.scoring.summary === null) {
    out.push(`  file: ${String(digest.scoring.file)} (unreadable)`);
  } else {
    const s = digest.scoring.summary;
    out.push(`  tasks: ${String(s.tasks)}  passed: ${String(s.passed)}  failed: ${String(s.failed)}`
      + `  errored: ${String(s.errored)}  tampered: ${String(s.tampered)}`);
    for (const task of digest.scoring.tasks) {
      out.push(`  ${task.instanceId}: ${task.verdict}${task.tamperedPaths ? ` (tamperedPaths ${String(task.tamperedPaths)})` : ''}`);
    }
  }
  return `${out.join('\n')}\n`;
}

export function parseCli(argv) {
  const opts = { evidence: null, deliverables: null, out: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--evidence') opts.evidence = argv[++index] ?? null;
    else if (arg === '--deliverables') opts.deliverables = argv[++index] ?? null;
    else if (arg === '--out') opts.out = argv[++index] ?? null;
    else return { ...opts, error: `unknown argument ${arg}` };
  }
  return opts;
}

function writeOut(opts, evidenceDir, digest) {
  if (!isStr(opts.out)) return null;
  const target = isAbsolute(opts.out) ? opts.out : join(evidenceDir, opts.out);
  writeFileSync(target, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
  return target;
}

function main(argv) {
  const opts = parseCli(argv);
  if (opts.help || !isStr(opts.evidence)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const deliverables = loadDeliverables(opts.deliverables);
  const digest = auditEvidence(opts.evidence, deliverables);
  const written = writeOut(opts, resolve(opts.evidence), digest);
  if (opts.json) process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
  else process.stdout.write(printHuman(digest));
  if (written !== null) process.stderr.write(`segment-audit: wrote ${written}\n`);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // The audit never fails a run. An unreadable input is reported, then exit 0.
    process.stderr.write(`segment-audit: error ${error?.message ?? String(error)}\n`);
  }
}
