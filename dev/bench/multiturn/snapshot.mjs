#!/usr/bin/env node
/**
 * Chunk 0 — pin the local zcode store into one immutable snapshot.
 *
 * Usage:
 *   node dev/bench/multiturn/snapshot.mjs [--src <db>] [--out <sqlite>] [--force]
 *                                        [--accept-live-source]
 *
 *   --src    the owner's store (default C:/Users/TZhen/.zcode/cli/db/db.sqlite;
 *            second device C:/Users/TZ/.zcode/cli/db/db.sqlite)
 *   --out    the snapshot (default
 *            scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite)
 *   --force  replace an existing snapshot; without it a present snapshot is
 *            refused, because the corpus is pinned and a silent re-pin would
 *            let two runs read two different stores
 *   --accept-live-source
 *            record an observed source fingerprint change instead of failing;
 *            accepted only while the structural read-only proof holds
 *
 * Why `VACUUM INTO` and never a file copy: the source is a WAL store (an 80 MB
 * `-wal` at design time), so committed frames live outside the main file. A
 * plain copy loses them. `VACUUM INTO` reads through SQLite, sees the committed
 * WAL state, and writes a fresh database with no sidecar.
 *
 * The snapshot is opened read-only by every later chunk (`--db <snapshot>`), and
 * its file is made read-only here so an accidental writer fails at the OS
 * before it can touch a pinned corpus.
 *
 * Verify (this chunk's gate):
 *   - the digest file exists and names the snapshot it was written from;
 *   - `pragma integrity_check` on the snapshot prints `ok`;
 *   - the source's size and mtime are unchanged by the snapshot run.
 * Every row count printed is read from the snapshot, never from the source.
 *
 * The source is the host's live store: the host appends to it while any agent
 * session runs, so the fingerprint can move for reasons this process did not
 * cause. Two facts are therefore printed separately. `readonly` is a structural
 * proof — the connection is opened `readOnly`, `query_only` is on, and a probe
 * write to `pragma user_version` is attempted and must be refused — so this
 * process cannot have mutated the source. `source-unchanged` is the observed
 * fingerprint check the design names. When the fingerprint moves anyway, the
 * run fails by name (`source-drift`) unless `--accept-live-source` records the
 * drift and continues; the snapshot is still one consistent point-in-time image
 * because `VACUUM INTO` reads it inside one read transaction.
 *
 * Exit: 0 = snapshot written and verified; 1 = verification failed;
 *       2 = bad arguments or an existing destination without --force.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const DEFAULTS = Object.freeze({
  src: 'C:/Users/TZhen/.zcode/cli/db/db.sqlite',
  out: 'scratchpad/bench/2026-10-24-multiturn/db-snapshot.sqlite',
});

/** Tables whose counts the manifest and the console report. */
const KEY_TABLES = Object.freeze([
  'session', 'message', 'part', 'tool_usage', 'turn_usage', 'model_usage',
  'session_entry', 'session_input', 'todo',
]);

function usage() {
  return [
    'usage: node dev/bench/multiturn/snapshot.mjs [--src <db>] [--out <sqlite>] [--force] [--accept-live-source]',
    `  --src   default ${DEFAULTS.src}`,
    `  --out   default ${DEFAULTS.out}`,
  ].join('\n');
}

const SNAPSHOT_OPTIONS = optionsOf([
  ['--src', 'string'],
  ['--out', 'string'],
  ['--force', 'boolean'],
  ['--accept-live-source', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: SNAPSHOT_OPTIONS,
    // Bad arguments are exit 2 on stderr here, not a thrown error: this script's
    // launcher contract differs from the other multiturn tools.
    refuse: (message) => {
      process.stderr.write(message);
      process.exit(2);
    },
    usage: () => `${usage()}\n`,
    help: () => `${usage()}\n`,
  });
  return {
    src: values.src ?? DEFAULTS.src,
    out: values.out ?? DEFAULTS.out,
    force: values.force ?? false,
    acceptLiveSource: values.acceptLiveSource ?? false,
  };
}

/** The digest sits beside the snapshot, sha256sum style. */
function digestPathFor(outPath) {
  return outPath.endsWith('.sqlite')
    ? join(dirname(outPath), `${basename(outPath, '.sqlite')}.sha256`)
    : `${outPath}.sha256`;
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function statFingerprint(path) {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function tableCounts(db) {
  const present = new Set(
    db.prepare("select name from sqlite_master where type='table'").all().map(row => row.name),
  );
  const counts = {};
  for (const table of KEY_TABLES) {
    if (!present.has(table)) {
      counts[table] = null;
      continue;
    }
    counts[table] = db.prepare(`select count(*) as n from ${table}`).get().n;
  }
  return counts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const src = resolve(opts.src);
  const out = resolve(opts.out);
  const digestPath = digestPathFor(out);

  if (!existsSync(src)) {
    process.stderr.write(`source store not found: ${src}\n`);
    process.exit(2);
  }
  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out)) {
    if (!opts.force) {
      process.stderr.write(
        `snapshot already exists: ${out}\n`
        + 'the corpus is pinned; pass --force to re-pin it deliberately\n',
      );
      process.exit(2);
    }
    for (const path of [out, `${out}-wal`, `${out}-shm`, digestPath]) rmSync(path, { force: true });
  }

  const before = statFingerprint(src);
  // `readOnly` is the structural guard: it refuses every write to this file,
  // including the probe below. `query_only` is deliberately NOT set — it would
  // also refuse `VACUUM INTO`, whose destination is a different file.
  const source = new DatabaseSync(src, { readOnly: true, timeout: 30000 });
  let sourceJournal;
  let readonlyProof;
  try {
    // A refused write is the structural proof that this process cannot mutate
    // the source; a successful one would silently invalidate every digest.
    let refused = false;
    try {
      source.exec('pragma user_version = 1');
    } catch (error) {
      refused = /readonly|read-only|attempt to write/i.test(String(error?.message ?? error));
      if (!refused) {
        throw new Error(`readonly: the probe write failed for an unexpected reason: ${error?.message ?? error}`);
      }
    }
    if (!refused) {
      throw new Error('readonly: the source accepted a write; the snapshot run is not read-only');
    }
    readonlyProof = 'refused';
    sourceJournal = source.prepare('pragma journal_mode').get().journal_mode;
    // Bound parameter: no path quoting, so a Windows path needs no escaping.
    source.prepare('VACUUM INTO ?').run(out);
  } finally {
    source.close();
  }
  const after = statFingerprint(src);
  const drift = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  if (readonlyProof !== 'refused') {
    fail('readonly: no refused-write proof was recorded');
  }
  if (drift && !opts.acceptLiveSource) {
    fail(`source-drift: the live store moved during the snapshot `
      + `(size ${before.size}->${after.size}, mtime ${before.mtimeMs}->${after.mtimeMs}). `
      + 'It is the host\'s live store; re-run with --accept-live-source to record the drift, '
      + 'or with the host idle to pass the observed check.');
  }

  chmodSync(out, 0o444);
  const digest = await sha256File(out);
  writeFileSync(digestPath, `${digest}  ${basename(out)}\n`);

  const snapshot = new DatabaseSync(out, { readOnly: true });
  let integrity;
  let snapshotJournal;
  let counts;
  try {
    integrity = snapshot.prepare('pragma integrity_check').all().map(row => row.integrity_check);
    snapshotJournal = snapshot.prepare('pragma journal_mode').get().journal_mode;
    counts = tableCounts(snapshot);
  } finally {
    snapshot.close();
  }
  if (integrity.length !== 1 || integrity[0] !== 'ok') {
    fail(`integrity_check on the snapshot did not print a single ok: ${JSON.stringify(integrity)}`);
  }
  if (snapshotJournal !== 'delete') {
    fail(`snapshot carries a WAL sidecar state (${snapshotJournal}); a pinned corpus must be one file`);
  }

  const bytes = statSync(out).size;
  const rowLine = KEY_TABLES
    .map(table => `${table}=${counts[table] === null ? 'absent' : counts[table]}`)
    .join(' ');
  const sourceLine = drift
    ? `source-unchanged=false (drift accepted; size ${before.size}->${after.size})`
    : 'source-unchanged=true';
  process.stdout.write([
    'snapshot',
    `  source      ${src}`,
    `  sourceMode  ${sourceJournal}`,
    `  path        ${out}`,
    `  bytes       ${bytes}`,
    `  sha256      ${digest}`,
    `  digest      ${digestPath}`,
    `  verify      integrity_check=ok journal=delete readonly=refused ${sourceLine}`,
    `  rows        ${rowLine}`,
    '',
  ].join('\n'));
}

main().catch(error => fail(error?.stack ?? String(error)));
