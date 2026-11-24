#!/usr/bin/env node
/**
 * The loopback gate's offline re-verdict (ISSUE-078; commit 5a9f0e7).
 *
 * `result.json` states the verdict a LIVE run reached; when the gate itself was
 * wrong that verdict cannot be trusted, and the run cannot be re-bought. This
 * re-decides gate 12 over what the run left on disk — `stdout.ndjson` and every
 * `session.v4.jsonl` under `<evidence>/sessions/` — with no network, no model and
 * no dsh. The gate it calls is the one `bench-run.mjs` runs on the live
 * route, so a re-verdict cannot drift from the live gate.
 *
 * Usage: `node dev/bench/loopback-recheck.mjs <evidence dir|*.jsonl> [...]`
 * Exit codes: 0 every arm passes, 1 an arm fails, 2 an input could not be read.
 * A file is stdout lines when named `stdout.ndjson`, else session events.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { LOOPBACK_GATE, loopbackGate } from './loopback-gate.mjs';
import { parseDevArgs } from '../shared/args.mjs';

/** Parse a JSONL file; a bad line names its file and line number. */
function parseJsonl(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      throw new Error(`${file}: line ${String(index + 1)} is not JSON (${error.message})`);
    }
  });
}

/** Every `session.v4.jsonl` under `<dir>/sessions`, or none when it has no such dir. */
function sessionFiles(dir) {
  const root = join(dir, 'sessions');
  if (!existsSync(root)) return [];
  const walk = (current) => readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = join(current, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name === 'session.v4.jsonl' ? [full] : [];
  });
  return walk(root).sort();
}

/** `result.json`'s `arm.name` when it has one, else the directory that holds it. */
function labelOf(full, result) {
  const named = result?.arm?.name ?? result?.arm;
  if (typeof named === 'string' && named !== '') return named;
  const dir = statSync(full).isDirectory() ? full : dirname(full);
  return basename(basename(dir) === 'evidence' ? dirname(dir) : dir);
}

/**
 * Re-decide the gate for one input: the counts that say what it looked at, plus
 * the verdict `result.json` stored beside it, if any. An input holding no record
 * at all is refused. The stored verdict is passed through, never compared: the
 * re-verdict REPLACES it.
 * @param {string} spec - an evidence directory or one `.jsonl` file.
 * @returns {object} `{label, spec, ok, detail, offending, requestRecords, ...}`.
 */
export function recheck(spec) {
  const full = resolve(spec);
  if (!existsSync(full)) throw new Error(`no such file or directory: ${full}`);
  const file = statSync(full).isFile() ? full : null;
  const resultFile = file === null ? join(full, 'result.json') : null;
  const result = resultFile !== null && existsSync(resultFile)
    ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  const stdoutFile = file === null ? join(full, 'stdout.ndjson')
    : (basename(file) === 'stdout.ndjson' ? file : null);
  const stdoutLines = stdoutFile !== null && existsSync(stdoutFile) ? parseJsonl(stdoutFile) : [];
  const sessionEvents = file === null ? sessionFiles(full).flatMap((path) => parseJsonl(path))
    : (stdoutFile !== null ? [] : parseJsonl(file));
  if (stdoutLines.length + sessionEvents.length === 0) {
    throw new Error(`${full}: no stdout.ndjson and no session.v4.jsonl records to read`);
  }
  const gate = loopbackGate({ stdoutLines, sessionEvents });
  const row = (result?.assertions ?? []).find((entry) => entry?.name === LOOPBACK_GATE);
  return {
    label: labelOf(full, result), spec, ok: gate.ok, detail: gate.detail ?? null,
    offending: gate.distinctCalls, requestRecords: gate.requestRecords,
    endpointFields: gate.endpointFields, stdoutRecords: stdoutLines.length,
    sessionRecords: sessionEvents.length,
    stored: row === undefined || row === null ? null : { ok: row.ok === true, detail: row.detail ?? null },
  };
}

/** One block per arm: the gate, what it examined, the stored verdict, the re-verdict. */
function printReport(outcome) {
  const stored = outcome.stored === null ? 'not recorded'
    : `${outcome.stored.ok ? 'PASS' : 'FAIL'} — ${String(outcome.stored.detail ?? 'no detail')}`;
  const verdict = outcome.ok ? 'PASS' : `FAIL — ${String(outcome.detail)}`;
  process.stdout.write([
    `${outcome.label} (${outcome.spec})`, `  gate: ${LOOPBACK_GATE}`,
    `  records read: stdout ${String(outcome.stdoutRecords)}, session ${String(outcome.sessionRecords)}`,
    `  request-shaped records opened: ${String(outcome.requestRecords)}`,
    `  endpoint-key string values examined: ${String(outcome.endpointFields)}`,
    `  offending records: ${String(outcome.offending)}`,
    `  stored verdict in result.json: ${stored}`, `  VERDICT: ${verdict}`,
  ].join('\n') + '\n');
}

/** CLI: one block per input; 2 when one could not be read, else 1 when an arm fails. */
function main(argv) {
  if (argv.length === 0) {
    process.stdout.write('usage: node dev/bench/loopback-recheck.mjs <evidence dir|*.jsonl> [...]\n');
    return 2;
  }
  let positionals;
  try {
    ({ positionals } = parseDevArgs(argv, {
      allowPositionals: true,
      help: 'usage: node dev/bench/loopback-recheck.mjs <evidence dir|*.jsonl> [...]\n',
    }));
  } catch (error) {
    process.stderr.write(`loopback-recheck.mjs: ${error.message}\n`);
    return 2;
  }
  const outcomes = positionals.map((spec) => {
    try {
      const outcome = recheck(spec);
      printReport(outcome);
      return outcome;
    } catch (error) {
      process.stderr.write(`loopback-recheck.mjs: ${error.message}\n`);
      return null;
    }
  });
  if (outcomes.includes(null)) return 2;
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

// A main-module guard: `node --test` imports `recheck` without running the CLI.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
