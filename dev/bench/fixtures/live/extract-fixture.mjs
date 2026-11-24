#!/usr/bin/env node
/**
 * The extracted-fixture builder for `dev/bench/fixtures/live/` (Phase R v2, R-2).
 *
 * Usage:
 *   node dev/bench/fixtures/live/extract-fixture.mjs \
 *        --racoons <session.v4.jsonl> --vanilla <session.v4.jsonl> [--out <dir>]
 *
 * The two live records this repo's Phase R evidence names are:
 *
 *   040 racoons  scratchpad/launch/2026-10-25-040-live-racoons/worlds/racoons/
 *                evidence/sessions/.../session-1308e8d8-....jsonl
 *   vanilla r2   scratchpad/launch/2026-10-24-035-live-ab/bench-vanilla-r2/
 *                sessions/.../session-d7f1af3f-....jsonl
 *
 * `scratchpad/` is disposable by law, so the gate must never read it: this
 * script copies the rows the converter reads into `fixtures/live/` and records
 * what it trimmed. The copy is the fixture; the transcript is the source.
 *
 * ## What is kept whole, and what is trimmed
 *
 * Kept byte-for-byte (the converter measures or keys on these):
 *   - `tool/result` rows whose text is at or above 1 280 bytes — the lowest
 *     floor the gate tests, and this model's own shipped floor;
 *   - every `surfaceOp` replace row (the prune-paired rule reads it);
 *   - every `tool/call` row (tool class, arguments for the T2 tier, and the
 *     per-arm `tool/result` census);
 *   - every `user/message` row (an ask turn must be recognisable);
 *   - `session`, `turn/start`, `turn/end`, `step/start`, `step/end`,
 *     `compaction/prune` (counts and the prune-paired rule).
 *
 * Trimmed, because nothing reads them and they are most of the bytes:
 *   - other `tool/result` texts keep their first 120 characters (still under
 *     every tested floor, so classification is unchanged);
 *   - `assistant/message` content becomes one fixed line and its `data.stream`
 *     chunk log is dropped outright (3.1 MB + 2.7 MB of the two records, and
 *     no reader of the transcript — the converter or the metric producer —
 *     reads a stream chunk). `data.usage` is untouched: `askRows` and the
 *     per-ask usage reading need it;
 *   - `system/message` text becomes one fixed line.
 *
 * A floor below the keep-whole threshold is not decidable here: bodies between
 * the trim threshold and the keep-whole one are short copies, so the converter
 * refuses `--floor < 1280` by name (`fixture-floor-below-keep`) instead of
 * scoring a body it does not hold.
 *
 * Dropped whole: `permission/preset`, `sandbox/mode`, `approval/policy`,
 * `agent/inbox/spliced`, `job/registered`, `job/settled`, `request/header`,
 * `request/context`, `session/title`, `todo/write`, `llm/retry`,
 * `llm/retry-started`, `assistant/attempt`,
 * `session-log-deepseek/delivery-accepted`. The converter's own type whitelist
 * still names them, so a real transcript carrying one is not refused; the
 * fixture simply does not need them.
 *
 * Every dropped or trimmed row is counted and printed, and the counts are
 * written into `manifest.json.trim`.
 *
 * Exit: 0 = fixtures written; 2 = bad arguments or an unreadable transcript.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, parseDevArgs } from '../../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Event types the converter must tolerate; the fixture keeps only some. */
const DROPPED_TYPES = new Set([
  'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'job/registered', 'job/settled', 'request/header', 'request/context', 'session/title',
  'todo/write', 'llm/retry', 'llm/retry-started', 'assistant/attempt',
  'session-log-deepseek/delivery-accepted',
]);
const READ_CLASS = new Set(['read', 'read_file', 'read-file']);
/** The lowest floor the gate tests: bodies at or above it are kept whole. */
const KEEP_WHOLE_FLOOR = 1280;
const TRIM_TO = 120;
const ASSISTANT_PLACEHOLDER = '[fixture] assistant text trimmed';
const SYSTEM_PLACEHOLDER = '[fixture] system text trimmed';

function usage() {
  return 'usage: node dev/bench/fixtures/live/extract-fixture.mjs'
    + ' --racoons <session.v4.jsonl> --vanilla <session.v4.jsonl> [--out <dir>]';
}

const EXTRACT_FIXTURE_OPTIONS = optionsOf([
  ['--racoons', 'string'],
  ['--vanilla', 'string'],
  ['--out', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: EXTRACT_FIXTURE_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const opts = {
    racoons: values.racoons ?? null,
    vanilla: values.vanilla ?? null,
    out: values.out ?? HERE,
  };
  if (opts.racoons === null || opts.vanilla === null) {
    throw new Error(`--racoons and --vanilla are both required\n${usage()}`);
  }
  return opts;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const textOf = row => (row.data?.message?.content ?? [])
  .filter(part => part.type === 'text').map(part => part.text).join('');
const callIdOf = row => row.data?.message?.toolCallId ?? row.data?.message?.source?.callId ?? null;

/** The rows one arm keeps, with the trim counts that produced them. */
export function trimArm(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0);
  const rows = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`unreadable-transcript: ${path} line ${index + 1}: ${error.message}`);
    }
  });
  const calls = new Map();
  for (const row of rows) {
    if (row.type === 'tool/call') calls.set(row.data.callId, row.data);
  }
  const out = [];
  const trim = {
    dropped: {}, trimmedResult: 0, trimmedAssistant: 0, trimmedSystem: 0,
    droppedStream: 0, keptWhole: 0,
  };
  for (const row of rows) {
    if (DROPPED_TYPES.has(row.type)) {
      trim.dropped[row.type] = (trim.dropped[row.type] ?? 0) + 1;
      continue;
    }
    if (row.type === 'tool/result') {
      const text = textOf(row);
      const callId = callIdOf(row);
      const call = calls.get(callId);
      const isRead = call !== undefined && READ_CLASS.has(String(call.name).toLowerCase());
      const isReplace = row.surfaceOp !== undefined && typeof row.surfaceOp === 'object';
      if (Buffer.byteLength(text) >= KEEP_WHOLE_FLOOR || isRead || isReplace) {
        trim.keptWhole++;
      } else {
        row.data.message.content = [{ type: 'text', text: text.slice(0, TRIM_TO) }];
        trim.trimmedResult++;
      }
    } else if (row.type === 'assistant/message') {
      row.data.message.content = [{ type: 'text', text: ASSISTANT_PLACEHOLDER }];
      if (row.data.stream !== undefined) {
        trim.droppedStream += Buffer.byteLength(JSON.stringify(row.data.stream));
        delete row.data.stream;
      }
      trim.trimmedAssistant++;
    } else if (row.type === 'system/message') {
      row.data.message.content = [{ type: 'text', text: SYSTEM_PLACEHOLDER }];
      trim.trimmedSystem++;
    }
    out.push(row);
  }
  return { rows: out, trim };
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** The arm fields the converter needs: which transcript, which root, which session. */
function armMeta(path, armRoot, sessionId) {
  return {
    transcript: path.split('\\').join('/'),
    armRoot,
    sessionId,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(REPO_ROOT, opts.out);
  const specs = {
    racoons: {
      path: resolve(REPO_ROOT, opts.racoons),
      armRoot: String.raw`C:\Users\TZhen\Desktop\racoons\scratchpad\launch\2026-10-25-040-live-racoons\worlds\racoons\arm`,
    },
    vanilla: {
      path: resolve(REPO_ROOT, opts.vanilla),
      armRoot: String.raw`C:\Users\TZhen\Desktop\racoons\scratchpad\launch\2026-10-24-035-live-ab\arms\vanilla-arm-r2`,
    },
  };
  const built = {};
  for (const [arm, spec] of Object.entries(specs)) {
    if (!existsSync(spec.path)) throw new Error(`transcript-absent: ${spec.path}`);
    const trimmed = trimArm(spec.path);
    const session = trimmed.rows.find(row => row.type === 'session');
    const name = `${arm}.session.v4.jsonl`;
    writeAtomic(join(outDir, name), `${trimmed.rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    built[arm] = {
      ...armMeta(name, spec.armRoot, session?.id ?? 'unknown-session'),
      source: spec.path.split('\\').join('/'),
      rows: trimmed.rows.length,
      trim: trimmed.trim,
      sha256: sha256(readFileSync(join(outDir, name))),
    };
  }
  const manifest = {
    schema: 'racoons-live-fixture/1',
    extractedAt: '2026-10-26',
    note: 'Extracted from the 040 live record and the vanilla r2 record by extract-fixture.mjs.'
      + ' scratchpad/ is disposable; this directory is what the offline gate reads.',
    arms: built,
  };
  // The `pins` block is the gate's frozen expectation (R-2 gate d), not something
  // this builder can compute: only a conversion produces those numbers. A
  // re-extraction therefore carries an existing block forward verbatim, so the
  // gate still fails if the new transcripts no longer reproduce it.
  const previous = existsSync(join(outDir, 'manifest.json'))
    ? JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    : null;
  if (previous?.pins !== undefined) manifest.pins = previous.pins;
  writeAtomic(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const files = ['manifest.json', ...Object.keys(specs).map(arm => `${arm}.session.v4.jsonl`)];
  const lines = files
    .map(file => `${sha256(readFileSync(join(outDir, file)))}  ${file}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  writeAtomic(join(outDir, 'sha256.txt'), `${lines.join('\n')}\n`);
  for (const [arm, meta] of Object.entries(built)) {
    process.stdout.write(`${arm}: rows=${meta.rows} keptWhole=${meta.trim.keptWhole}`
      + ` trimmedResult=${meta.trim.trimmedResult} trimmedAssistant=${meta.trim.trimmedAssistant}`
      + ` trimmedSystem=${meta.trim.trimmedSystem} sha=${meta.sha256.slice(0, 16)}\n`);
  }
  process.stdout.write(`wrote ${outDir}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}
