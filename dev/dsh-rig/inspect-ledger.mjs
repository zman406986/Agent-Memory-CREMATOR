#!/usr/bin/env node
/**
 * Read one recall record out of a rig ledger, outside dsh.
 *
 * The rig's live scenarios assert the ledger side of the seam from the evidence
 * directory after the child exits: a capped result's full bytes must come back
 * from the blob store and the ledger, byte for byte. `run.mjs` spawns this
 * script so the check happens in a fresh process against a closed database —
 * the same path a later `recall` tool call would take.
 *
 * Usage:
 *   node dev/dsh-rig/inspect-ledger.mjs --ledger <db> --blobs <dir> --recall <recallId> [--sha256 <hash>]
 *   node dev/dsh-rig/inspect-ledger.mjs --ledger <db> --blobs <dir>            # ledger summary
 *
 * With `--recall` it prints one recall: `{status:"ok", recallId, parts:[...],
 * restoredText, restoredBytes, restoredSha256}`. Without it, it prints the
 * append-only ledger's own record: every applied application's sealed episode
 * ids and generated record ids, which is the evidence a seal leaves behind.
 * Failures print `{status:"error", detail}` and exit 1.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIST_DIR, ensureDist } from './build-dist.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const INSPECT_OPTIONS = optionsOf([
  ['--ledger', 'string'],
  ['--blobs', 'string'],
  ['--recall', 'string'],
  ['--sha256', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: INSPECT_OPTIONS,
    prefix: 'inspect-ledger: ',
    help: 'usage: inspect-ledger.mjs --ledger <db> --blobs <dir> --recall <recallId>\n',
  });
  const opts = {
    ledger: values.ledger ?? null,
    blobs: values.blobs ?? null,
    recall: values.recall ?? null,
    sha256: values.sha256 ?? null,
  };
  if (opts.ledger === null || opts.blobs === null) {
    throw new Error('inspect-ledger: --ledger and --blobs are required');
  }
  return opts;
}

/**
 * Read the append-only ledger's event rows. sqlite3 opens the file read-only, so
 * an evidence database can be inspected without being able to mutate it.
 * @param {string} databasePath
 */
function readLedgerRows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT session_id, intent_id, kind, payload_json FROM ledger_events ORDER BY sequence').all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', detail: error.message })}\n`);
    process.exit(1);
  }
  if (!existsSync(opts.ledger)) {
    process.stdout.write(`${JSON.stringify({ status: 'error', detail: `no ledger at ${opts.ledger}` })}\n`);
    process.exit(1);
  }
  try {
    if (DIST_DIR !== join(opts.blobs, '..', 'dist')) ensureDist({ quiet: true });
    const core = await import(pathToFileURL(join(DIST_DIR, 'packages', 'core', 'src', 'index.js')).href);
    const ledger = await core.SqliteLedger.open({
      databasePath: opts.ledger,
      blobStore: new core.FileBlobStore(opts.blobs),
      clock: { nowMs: () => Date.now() },
    });
    try {
      if (opts.recall === null) {
        // The ledger summary: the durable record a seal leaves, with no bytes.
        const sessions = new Set();
        const sealed = [];
        const records = [];
        const applications = [];
        const rows = readLedgerRows(opts.ledger);
        for (const row of rows) {
          sessions.add(row.session_id);
          if (row.kind === 'prepared') {
            const payload = JSON.parse(row.payload_json);
            const engine = payload.engine ?? null;
            applications.push({ intentId: row.intent_id, sessionId: row.session_id,
              applicationSha256: payload.applicationSha256 ?? null,
              sealedEpisodeIds: engine?.sealedEpisodeIds ?? [],
              recallIds: engine?.recallIds ?? [],
              removedBytes: engine?.removedBytes ?? null,
              generatedBytes: engine?.generatedBytes ?? null });
            for (const id of engine?.sealedEpisodeIds ?? []) sealed.push(id);
          }
          if (row.kind === 'applied') records.push({ intentId: row.intent_id });
        }
        process.stdout.write(`${JSON.stringify({ status: 'ok', sessions: [...sessions],
          applications, sealedEpisodeIds: sealed, applied: records.length })}\n`);
      } else {
        const record = await ledger.recall(opts.recall);
        const restored = Buffer.concat(record.parts.map((part) => Buffer.from(part.bytes)));
        const { createHash } = await import('node:crypto');
        const sha256 = createHash('sha256').update(restored).digest('hex');
        const sourceSha256 = record.manifest.parts[0]?.source.sha256 ?? null;
        if (opts.sha256 !== null && opts.sha256 !== '' && opts.sha256 !== sha256) {
          process.stdout.write(`${JSON.stringify({ status: 'error',
            detail: `restored sha256 ${sha256} differs from the published source ${opts.sha256}` })}\n`);
          process.exit(1);
        }
        process.stdout.write(`${JSON.stringify({
          status: 'ok',
          recallId: record.id,
          manifestSha256: record.manifestSha256,
          parts: record.parts.map((part) => ({
            nodeId: part.source.nodeId,
            byteLength: part.bytes.length,
            removedRanges: part.removedRanges,
          })),
          sourceSha256,
          restoredBytes: restored.length,
          restoredSha256: sha256,
          restoredText: restored.toString('utf8'),
        })}\n`);
      }
    } finally {
      await ledger.close();
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error',
      detail: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

await main();
