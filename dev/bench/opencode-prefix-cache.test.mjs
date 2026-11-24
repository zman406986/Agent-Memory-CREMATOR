/**
 * The free prefix-cache simulation's deterministic tests (ISSUE-256 item 1
 * cost fix). A synthetic capture is the only subject: no provider, no network,
 * no evidence directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCK_TOKENS, BYTES_PER_TOKEN, analyzePrefixCache, estimateTokens, main,
  normalizeReceiptPass, readMainBodies, simulatePrefixCache,
} from './opencode-prefix-cache.mjs';

/** A stable 600-byte text, so every body is several 256-byte blocks. */
const FILLER = 'synthetic fixture line '.repeat(30);
/** A receipt line in the writer's shape: target, pass, recall id. */
function receiptLine(callId, passHex) {
  return `[not retained] oc:ses_test:tool:${callId} — about: ${FILLER}`
    + ` · pass intent:sha256:${passHex} · necromancy recall:sha256:${'a'.repeat(64)}`;
}

/**
 * One conversation with a removal and a pass rewrite. Row 1 carries the unit;
 * row 2 replaces it with a receipt; row 3 appends; row 4 rewrites the receipt's
 * pass id (the 1d defect) and appends; row 5 keeps the rewritten receipt and
 * appends again.
 */
function syntheticRows() {
  const system = { role: 'system', content: `system ${FILLER}` };
  const user = { role: 'user', content: `task ${FILLER}` };
  const call = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const result = { role: 'tool', tool_call_id: 'call_1', content: FILLER };
  const receipt = (pass) => ({ role: 'user', content: receiptLine('call_1', pass) });
  const reply = (at) => ({ role: 'assistant', content: `reply ${String(at)} ${FILLER}` });
  return [
    { seq: 1, messages: [system, user, call, result] },
    { seq: 2, messages: [system, user, receipt('1'.repeat(64)), reply(2)] },
    { seq: 3, messages: [system, user, receipt('1'.repeat(64)), reply(2), reply(3)] },
    { seq: 4, messages: [system, user, receipt('2'.repeat(64)), reply(2), reply(3), reply(4)] },
    { seq: 5, messages: [system, user, receipt('2'.repeat(64)), reply(2), reply(3), reply(4),
      reply(5)] },
  ];
}

/** One capture line, in the observer's shape. */
function captureLine(row) {
  return JSON.stringify({
    seq: row.seq,
    kind: 'primary',
    body: JSON.stringify({ model: 'synthetic', messages: row.messages }),
    bodyReadable: true,
    truncated: false,
  });
}

function scratchCapture() {
  const dir = mkdtempSync(join(tmpdir(), 'racoons-prefix-cache-'));
  const file = join(dir, 'capture.jsonl');
  const lines = [
    captureLine(syntheticRows()[0]),
    // A title and a generate line are not main turns and must be skipped.
    JSON.stringify({ seq: 2, kind: 'title', body: JSON.stringify({ messages: [] }) }),
    JSON.stringify({ seq: 3, kind: 'generate', body: JSON.stringify({ messages: [] }) }),
    ...syntheticRows().slice(1).map(captureLine),
  ];
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return { dir, file };
}

test('prefix-cache: a synthetic capture is read as main bodies only, deterministically', () => {
  const world = scratchCapture();
  try {
    const read = readMainBodies(world.file);
    assert.equal(read.exists, true);
    assert.equal(read.counts.primary, 5);
    assert.deepEqual(read.bodies.map((row) => row.seq), [1, 2, 3, 4, 5]);
    assert.equal(read.problems.length, 0);

    const first = analyzePrefixCache(world.file);
    const second = analyzePrefixCache(world.file);
    assert.deepEqual(first, second, 'the simulation is deterministic');
    assert.equal(first.mainRequests, 5);
    assert.equal(first.normalizedPassSegments, 4, 'one pass segment on each of rows 2-5');
    assert.equal(first.basis.blockTokens, BLOCK_TOKENS);
    assert.equal(first.basis.bytesPerToken, BYTES_PER_TOKEN);
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('prefix-cache: a pass rewrite lowers the prefix reuse and normalizing it recovers', () => {
  const world = scratchCapture();
  try {
    const report = analyzePrefixCache(world.file);
    // The first four requests are unaffected: rows 1-3 have no rewrite, and
    // row 4 is where the pass id changes. Row 5 keeps the rewritten id, so the
    // as-recorded run only reuses the prefix before the receipt after row 4.
    const asRecorded = report.asRecorded;
    const normalized = report.normalized;
    assert.equal(asRecorded.totalPromptTokens, normalized.totalPromptTokens,
      'the fixed-token replacement keeps the byte length, so total tokens match');
    assert.ok(normalized.cacheReadTokens > asRecorded.cacheReadTokens,
      `normalized cache read ${String(normalized.cacheReadTokens)} should exceed `
        + `as-recorded ${String(asRecorded.cacheReadTokens)}`);
    assert.ok(normalized.reuseShare > asRecorded.reuseShare);
    assert.equal(asRecorded.missTokens,
      asRecorded.totalPromptTokens - asRecorded.cacheReadTokens);
    assert.equal(normalized.missTokens,
      normalized.totalPromptTokens - normalized.cacheReadTokens);
    assert.equal(report.predictedMissReduction.missTokens,
      asRecorded.missTokens - normalized.missTokens);
    assert.ok(report.predictedMissReduction.missTokens > 0,
      'a rewrite confined to the pass segment predicts a real miss reduction');
    assert.ok(report.predictedMissReduction.shareOfAsRecordedMiss > 0);
    assert.ok(report.requests.length === 5);
    // The rewrite first costs a block at row 4 in the as-recorded run; the
    // normalized run reuses row 3's whole prefix there.
    const rowFour = report.requests.find((row) => row.seq === 4);
    assert.ok(rowFour.normalized.cacheReadTokens > rowFour.asRecorded.cacheReadTokens);
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test('prefix-cache: the normalizer touches only the writer\'s exact pass segment', () => {
  const exact = receiptLine('call_1', 'f'.repeat(64));
  const exactResult = normalizeReceiptPass(exact);
  assert.equal(exactResult.replaced, 1);
  assert.match(exactResult.body, / · pass intent:sha256:0{64} · necromancy/u);
  assert.equal(exactResult.body.length, exact.length, 'the replacement keeps the byte length');

  const shortId = '[not retained] x · pass intent:sha256:abc · necromancy recall:sha256:aa';
  const shortResult = normalizeReceiptPass(shortId);
  assert.equal(shortResult.replaced, 0);
  assert.equal(shortResult.body, shortId);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('prefix-cache: the block simulation reuses a stable prefix and stops at a change', () => {
  const body = 'x'.repeat(2048);
  const changed = `${'y'.repeat(256)}${body.slice(256)}`;
  const stable = simulatePrefixCache([
    { seq: 1, body },
    { seq: 2, body },
  ]);
  assert.equal(stable.requests[1].cacheReadTokens, Math.floor(2048 / 256) * BLOCK_TOKENS);
  assert.equal(stable.requests[1].missTokens, estimateTokens(body)
    - Math.floor(2048 / 256) * BLOCK_TOKENS);

  const rewritten = simulatePrefixCache([
    { seq: 1, body },
    { seq: 2, body },
    { seq: 3, body },
    { seq: 4, body: changed },
  ]);
  assert.equal(rewritten.requests[3].cacheReadTokens, 0,
    'a change in the first block invalidates every later block');
  assert.equal(rewritten.requests[3].missTokens, estimateTokens(changed));
});

test('prefix-cache: the CLI refuses no capture and prints a report for one', () => {
  const usage = main([]);
  assert.equal(usage, 2);
  const world = scratchCapture();
  const originalWrite = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += String(chunk);
    return true;
  };
  try {
    const exit = main(['--capture', world.file]);
    assert.equal(exit, 0);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(world.dir, { recursive: true, force: true });
  }
  const report = JSON.parse(printed);
  assert.equal(report.mainRequests, 5);
  assert.ok(report.asRecorded.missTokens > 0);
});
