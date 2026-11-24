#!/usr/bin/env node
/**
 * The free prefix-cache simulation for a captured opencode run.
 *
 * **What it answers.** A provider's prompt cache is a strict prefix cache
 * billed in blocks (DeepSeek: 64 tokens). A product that rewrites an early
 * message — the 1d regression rewrote every receipt's ` · pass <intent id>`
 * segment on every request — forces every later request to miss from that
 * message on. This module replays the captured MAIN request bodies twice:
 *
 *   1. **as recorded**, and
 *   2. **normalized**, with ` · pass intent:sha256:<64hex>` replaced by one
 *      fixed token (what a stable receipt would have produced).
 *
 * For each sequence it reports total prompt tokens, cache-read tokens, miss
 * tokens, the reuse share, and the predicted miss-token reduction. It is
 * analysis, not evidence: it reads the capture and writes nothing.
 *
 * **The model, stated so it is not mistaken for a provider measurement.**
 * Tokens are estimated from the body's UTF-8 byte length at 4 bytes per token
 * (`BYTES_PER_TOKEN`); the provider's tokenizer is not run here. A block is
 * `BLOCK_TOKENS = 64` estimated tokens, so a block is 256 bytes. Only full
 * blocks are cacheable. The cache is a trie of block hashes from every earlier
 * request in the run, so a request reuses the longest block-aligned prefix any
 * earlier request established. The first request reads nothing. The captured
 * bodies are the mock/hook clones, before HTTP framing.
 *
 * Usage:
 *   node dev/bench/opencode-prefix-cache.mjs --capture <capture.jsonl>
 *
 * Prints one JSON object. It never writes a file; redirect stdout if a note is
 * wanted.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The cache's block size, in estimated tokens. DeepSeek's cache is 64-token. */
export const BLOCK_TOKENS = 64;
/** The token estimate: UTF-8 bytes per token. Stated, not measured. */
export const BYTES_PER_TOKEN = 4;
/** The writer's pass segment, normalized to one fixed 64-hex token. */
export const RECEIPT_PASS_SEGMENT = / · pass intent:sha256:[0-9a-f]{64}/gu;
/** The fixed token the pass segment is normalized to (same byte length). */
export const STABLE_PASS_SEGMENT = ` · pass intent:sha256:${'0'.repeat(64)}`;
/** The bytes in one cache block under this model. */
const BLOCK_BYTES = BLOCK_TOKENS * BYTES_PER_TOKEN;

/**
 * Read a capture log's MAIN request bodies. Only `kind: "primary"` lines are
 * main turns; a title, compaction or generate line is a different request and
 * is not part of the conversation's prefix. A truncated or unreadable body is
 * named and skipped: a prefix measurement over a partial body would be a
 * measurement of the wrong bytes.
 * @param {string} file
 * @returns {{capture: string, exists: boolean, bodies: {seq: number, body: string}[],
 *   counts: {primary: number, skipped: number}, problems: object[]}}
 */
export function readMainBodies(file) {
  const capture = typeof file === 'string' ? resolve(file) : '';
  const out = {
    capture,
    exists: existsSync(capture),
    bodies: [],
    counts: { primary: 0, skipped: 0 },
    problems: [],
  };
  if (!out.exists) {
    out.problems.push({ why: `no capture log at ${capture}` });
    return out;
  }
  const lines = readFileSync(capture, 'utf8').split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      out.problems.push({ at: index + 1, why: 'the line is not JSON' });
      continue;
    }
    if (record?.kind !== 'primary') continue;
    out.counts.primary += 1;
    if (record.truncated === true) {
      out.counts.skipped += 1;
      out.problems.push({ at: record.seq ?? index + 1, why: 'the body is truncated' });
      continue;
    }
    if (record.bodyReadable === false) {
      out.counts.skipped += 1;
      out.problems.push({ at: record.seq ?? index + 1, why: 'the body was not readable' });
      continue;
    }
    let body = null;
    if (typeof record.body === 'string') {
      body = record.body;
    } else if (typeof record.bodyBase64 === 'string') {
      try {
        body = new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.from(record.bodyBase64, 'base64'));
      } catch {
        body = null;
      }
    }
    if (body === null) {
      out.counts.skipped += 1;
      out.problems.push({ at: record.seq ?? index + 1, why: 'the line carries no readable body' });
      continue;
    }
    out.bodies.push({
      seq: Number.isSafeInteger(record.seq) ? record.seq : index + 1,
      body,
    });
  }
  return out;
}

/**
 * Replace every writer pass segment with one fixed token. The replacement has
 * the same UTF-8 length as the segment it replaces, so the block grid does not
 * move: the only difference the simulation sees is the value that changed.
 * @param {string} body
 * @returns {{body: string, replaced: number}}
 */
export function normalizeReceiptPass(body) {
  if (typeof body !== 'string') return { body: '', replaced: 0 };
  let replaced = 0;
  const normalized = body.replace(RECEIPT_PASS_SEGMENT, () => {
    replaced += 1;
    return STABLE_PASS_SEGMENT;
  });
  return { body: normalized, replaced };
}

/** The estimated token count of one body. */
export function estimateTokens(body) {
  if (typeof body !== 'string' || body.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(body, 'utf8') / BYTES_PER_TOKEN);
}

/** The block hashes of one body, in order, over full blocks only. */
function blockHashes(body) {
  const bytes = Buffer.from(body, 'utf8');
  const hashes = [];
  for (let at = 0; at + BLOCK_BYTES <= bytes.length; at += BLOCK_BYTES) {
    hashes.push(createHash('sha256').update(bytes.subarray(at, at + BLOCK_BYTES)).digest('base64'));
  }
  return hashes;
}

/**
 * Simulate a 64-token block prefix cache over a body sequence.
 * @param {{seq: number, body: string}[]} bodies
 * @returns {{totalPromptTokens: number, cacheReadTokens: number, missTokens: number,
 *   reuseShare: number, requests: object[], blockTokens: number, bytesPerToken: number,
 *   cacheableBlocks: number}}
 */
export function simulatePrefixCache(bodies) {
  const rows = Array.isArray(bodies) ? bodies.filter(
    (row) => row !== null && typeof row === 'object' && typeof row.body === 'string') : [];
  /** hash -> child trie; the path from the root is an established block prefix. */
  const cache = new Map();
  const requests = [];
  let totalPromptTokens = 0;
  let cacheReadTokens = 0;
  let cacheableBlocks = 0;
  for (const row of rows) {
    const totalTokens = estimateTokens(row.body);
    const hashes = blockHashes(row.body);
    cacheableBlocks += hashes.length;
    let node = cache;
    let matched = 0;
    for (const hash of hashes) {
      const next = node.get(hash);
      if (next === undefined) break;
      matched += 1;
      node = next;
    }
    const readTokens = Math.min(matched * BLOCK_TOKENS, totalTokens);
    const missTokens = totalTokens - readTokens;
    totalPromptTokens += totalTokens;
    cacheReadTokens += readTokens;
    requests.push({
      seq: row.seq,
      totalPromptTokens: totalTokens,
      cacheReadTokens: readTokens,
      missTokens,
      reuseShare: totalTokens === 0 ? 0 : readTokens / totalTokens,
    });
    // Insert this request's blocks after measuring its own hit: a request
    // cannot reuse a prefix only it establishes.
    node = cache;
    for (const hash of hashes) {
      let next = node.get(hash);
      if (next === undefined) {
        next = new Map();
        node.set(hash, next);
      }
      node = next;
    }
  }
  const missTokens = totalPromptTokens - cacheReadTokens;
  return {
    totalPromptTokens,
    cacheReadTokens,
    missTokens,
    reuseShare: totalPromptTokens === 0 ? 0 : cacheReadTokens / totalPromptTokens,
    requests,
    blockTokens: BLOCK_TOKENS,
    bytesPerToken: BYTES_PER_TOKEN,
    cacheableBlocks,
  };
}

/**
 * The as-recorded vs normalized comparison for one capture.
 * @param {string} file
 * @returns {object}
 */
export function analyzePrefixCache(file) {
  const read = readMainBodies(file);
  const bodies = read.bodies;
  let replaced = 0;
  const normalized = bodies.map((row) => {
    const result = normalizeReceiptPass(row.body);
    replaced += result.replaced;
    return { seq: row.seq, body: result.body };
  });
  const asRecorded = simulatePrefixCache(bodies);
  const normalizedRun = simulatePrefixCache(normalized);
  const predictedMissReduction = asRecorded.missTokens - normalizedRun.missTokens;
  return {
    capture: read.capture,
    mainRequests: bodies.length,
    captureCounts: read.counts,
    problems: read.problems,
    basis: {
      blockTokens: BLOCK_TOKENS,
      bytesPerToken: BYTES_PER_TOKEN,
      blockBytes: BLOCK_BYTES,
      passNormalization: `${String(RECEIPT_PASS_SEGMENT)} -> ${JSON.stringify(STABLE_PASS_SEGMENT)}`,
      tokenEstimate: 'UTF-8 bytes / 4; the provider tokenizer is not run',
      scope: 'captured MAIN (kind primary) request bodies, in capture order',
      caveat: 'analysis only: the block grid is an estimate, so the absolute token figures are '
        + 'not the provider\'s; the as-recorded vs normalized comparison is the measurement',
    },
    normalizedPassSegments: replaced,
    asRecorded: {
      totalPromptTokens: asRecorded.totalPromptTokens,
      cacheReadTokens: asRecorded.cacheReadTokens,
      missTokens: asRecorded.missTokens,
      reuseShare: asRecorded.reuseShare,
    },
    normalized: {
      totalPromptTokens: normalizedRun.totalPromptTokens,
      cacheReadTokens: normalizedRun.cacheReadTokens,
      missTokens: normalizedRun.missTokens,
      reuseShare: normalizedRun.reuseShare,
    },
    predictedMissReduction: {
      missTokens: predictedMissReduction,
      shareOfAsRecordedMiss: asRecorded.missTokens === 0
        ? 0 : predictedMissReduction / asRecorded.missTokens,
      asRecordedMissShare: asRecorded.totalPromptTokens === 0
        ? 0 : asRecorded.missTokens / asRecorded.totalPromptTokens,
      normalizedMissShare: normalizedRun.totalPromptTokens === 0
        ? 0 : normalizedRun.missTokens / normalizedRun.totalPromptTokens,
    },
    requests: asRecorded.requests.map((row, at) => ({
      seq: row.seq,
      asRecorded: {
        totalPromptTokens: row.totalPromptTokens,
        cacheReadTokens: row.cacheReadTokens,
        missTokens: row.missTokens,
        reuseShare: row.reuseShare,
      },
      normalized: {
        totalPromptTokens: normalizedRun.requests[at].totalPromptTokens,
        cacheReadTokens: normalizedRun.requests[at].cacheReadTokens,
        missTokens: normalizedRun.requests[at].missTokens,
        reuseShare: normalizedRun.requests[at].reuseShare,
      },
    })),
  };
}

/** The CLI. Prints one JSON report; writes nothing. */
export function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  let capture = null;
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === '--capture') {
      capture = args[at + 1] ?? null;
      at += 1;
      continue;
    }
    if (args[at] === '--help' || args[at] === '-h') {
      process.stdout.write('usage: opencode-prefix-cache.mjs --capture <capture.jsonl>\n');
      return 0;
    }
    process.stderr.write(`unknown argument ${JSON.stringify(args[at])}\n`);
    return 2;
  }
  if (capture === null) {
    process.stderr.write('usage: opencode-prefix-cache.mjs --capture <capture.jsonl>\n');
    return 2;
  }
  const report = analyzePrefixCache(capture);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.mainRequests > 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
