// No-cap proof for the OpenCode path (ADR-0048; ISSUE-200).
//
// The product never caps, shortens or rewrites a tool result. This suite drives
// the settlement seam with a 200 KB result and then models the host's own
// `ToolOutput.truncate` as the installed 2.4.0 binary runs it: head only, 2,000
// lines or 50 KiB, full text saved to a file, `metadata.truncated` and
// `outputPath` written by the host. No binary, no API key, no live call.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Sync, toBytes } from '@cremator/core';
import type { OpencodeAfterToolInput, OpencodeMessage, OpencodeToolResult } from '../src/host.js';
import { createOpencodeMount } from '../src/plugin.js';
import type { OpencodeJournalRecord } from '../src/plugin.js';
import { OPENCODE_RECORD_ID_FIELD, deriveOpencodeSnapshot } from '../src/snapshot.js';
import {
  assistantMessage, text, textResult, toolCall, toolMessage, toolResult, userMessage,
} from './fixtures.js';

const SESSION = 'ses_passthrough';
const CALL = 'call_big';

/** The host's own constants: 2,000 lines or 50 KiB, whichever comes first. */
const HOST_MAX_LINES = 2000;
const HOST_MAX_BYTES = 50 * 1024;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'racoons-oc-passthrough-'));
}

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}

function journalLines(): { records: OpencodeJournalRecord[] } {
  return { records: [] };
}

/** A text body over 200 KB with a distinct head, middle and tail sentinel. */
function bigBody(): string {
  const filler = `${'x'.repeat(40)}\n`;
  const lines = ['HEAD-SENTINEL\n'];
  for (let index = 0; index < 5000; index += 1) {
    lines.push(index === 2500 ? 'MIDDLE-SENTINEL\n' : filler);
  }
  lines.push('TAIL-SENTINEL\n');
  return lines.join('');
}

/** One request carrying the oversized result, built the way the host rebuilds it. */
function requestWith(body: string): OpencodeMessage[] {
  return [
    userMessage('msg_u1', [text('Read the big file.')]),
    assistantMessage('msg_a1', [
      text('Reading.'),
      toolCall(CALL, 'read', { filePath: 'big.txt' }),
    ]),
    toolMessage('msg_t1', [toolResult(CALL, 'read', textResult(body))]),
  ];
}

/**
 * The host's `ToolOutput.truncate`, modelled from the installed 2.4.0 binary
 * (`maxLines = 2000`, `maxBytes = 51200`). The kept prefix is the leading whole
 * lines that fit both limits — the host's byte cut can also keep a partial last
 * line, which its notice marks `(last line cut)`; this model stops at a line
 * boundary. The full text is written to `<data>/tool-output/tool_<12 hex>`; the
 * stored result carries the notice and `metadata.truncated: true` plus
 * `outputPath`.
 */
function hostTruncate(content: string, outputRoot: string): {
  text: string; metadata: Readonly<Record<string, unknown>>; outputPath: string | null;
} {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  if (lines.length <= HOST_MAX_LINES
    && Buffer.byteLength(content, 'utf8') <= HOST_MAX_BYTES) {
    return { text: content, metadata: { truncated: false }, outputPath: null };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, HOST_MAX_LINES)) {
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > HOST_MAX_BYTES) break;
    kept.push(line);
    bytes += cost;
  }
  mkdirSync(outputRoot, { recursive: true });
  const outputPath = join(outputRoot, 'tool_0123456789ab');
  writeFileSync(outputPath, content, 'utf8');
  const notice = `[showing lines 1-${kept.length} of ${lines.length};`
    + ` full output saved to ${outputPath}]`;
  return {
    text: `${kept.join('\n')}${notice}`,
    metadata: { truncated: true, outputPath },
    outputPath,
  };
}

test('a 200 KB result reaches the agent unmodified and opens no ledger', async () => {
  const records = journalLines();
  const mount = createOpencodeMount({ storage: { databasePath: ':memory:' },
    journal: record => records.records.push(record) });
  try {
    const original = bigBody();
    assert.ok(toBytes(original).byteLength >= 200 * 1024,
      'the fixture really is over 200 KB');
    const before: OpencodeToolResult = { content: original };
    const event: OpencodeAfterToolInput = { tool: 'read', sessionID: SESSION, id: CALL,
      status: 'completed', result: before };
    await mount.afterTool(event);

    assert.equal(event.result, before, 'the product leaves the same result object');
    assert.equal(event.result?.content, original, 'the 200 KB body is byte-identical');
    assert.equal(toBytes(String(event.result?.content)).byteLength, toBytes(original).byteLength,
      'every byte reaches the host');
    assert.equal(event.result?.metadata, undefined, 'the product writes no metadata');
    assert.equal(String(event.result?.content).includes('[racoons]'), false,
      'the product writes no marker');
    assert.equal(records.records.some(record => record.kind.startsWith('cap')), false,
      'no cap journal line is written');
    assert.equal(mount.sessions.size, 0, 'no ledger is opened, so nothing is archived');

    // The next request the mount sees carries the body whole: the mount makes no
    // removal out of it and writes no receipt.
    const messages = requestWith(original);
    const untouched = structuredClone(messages);
    await mount.transform(SESSION, messages);
    assert.deepEqual(messages, untouched,
      'the mount leaves the oversized result whole on the next request');
    assert.equal(messages.filter(message =>
      typeof message[OPENCODE_RECORD_ID_FIELD] === 'string').length, 0,
    'the mount appends no receipt for it');
  } finally { await mount.close(); }
});

test('when the host truncates, the stored content is the host\'s truncation, not ours', async () => {
  const directory = scratch();
  const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
  try {
    const original = bigBody();
    const event: OpencodeAfterToolInput = { tool: 'read', sessionID: SESSION, id: CALL,
      status: 'completed', result: { content: original } };
    await mount.afterTool(event);
    assert.equal(event.result?.metadata, undefined, 'the product left metadata unset');

    // The host runs after this hook. Its cut is the one the agent sees.
    const stored = hostTruncate(original, join(directory, 'tool-output'));
    assert.ok(stored.text.startsWith('HEAD-SENTINEL'), 'the host keeps the head');
    assert.equal(stored.text.includes('MIDDLE-SENTINEL'), false,
      'the host drops the middle with the rest of the tail');
    assert.equal(stored.text.includes('TAIL-SENTINEL'), false, 'the host keeps no tail');
    assert.equal(stored.text.includes('[racoons]'), false,
      'the stored content carries no product marker');
    assert.equal(stored.text.includes('full output saved to'), true,
      'the host says where the full output went');
    assert.equal(stored.metadata['truncated'], true, 'the host marks its own truncation');
    assert.equal(typeof stored.metadata['outputPath'], 'string', 'the host names the saved file');
    assert.equal(stored.text.includes('racoonsRecallId'), false,
      'no product recall id is written');
    assert.equal(stored.text.includes('racoonsDroppedBytes'), false,
      'no product dropped-byte field is written');

    assert.ok(Buffer.byteLength(stored.text, 'utf8') < Buffer.byteLength(original, 'utf8'),
      'the host cut reduced the stored body');
    const saved = readFileSync(String(stored.metadata['outputPath']), 'utf8');
    assert.equal(saved, original, 'the host saved the complete original');
    assert.ok(saved.includes('MIDDLE-SENTINEL') && saved.includes('TAIL-SENTINEL'),
      'the saved file holds the middle and tail the stored result lost');
  } finally {
    await mount.close();
    cleanup(directory);
  }
});

test('recall returns the exact archived bytes of a unit removed whole', async () => {
  const mount = createOpencodeMount({ storage: { databasePath: ':memory:' } });
  try {
    const body = `# Note\n\n${'body line\n'.repeat(1100)}`;
    const messages = requestWith(body);
    // Two identical reads: the later one supersedes the earlier, which leaves
    // whole as one unit with its call. The removal is not a cap.
    messages.push(
      userMessage('msg_u2', [text('Read it again.')]),
      assistantMessage('msg_a2', [
        text('Reading again.'),
        toolCall('call_2', 'read', { filePath: 'big.txt' }),
      ]),
      toolMessage('msg_t2', [toolResult('call_2', 'read', textResult(body))]),
    );
    const before = deriveOpencodeSnapshot(messages, { sessionId: SESSION }).snapshot;
    const removed = before.nodes.find(node =>
      node.kind === 'tool-result' && node.callId === CALL);
    assert.ok(removed !== undefined, 'the first read is one whole unit');
    if (removed === undefined) return;

    await mount.transform(SESSION, messages);
    const receipts = messages.filter(message =>
      typeof message[OPENCODE_RECORD_ID_FIELD] === 'string');
    assert.equal(receipts.length, 1, 'one whole unit removed, one receipt');
    const rendered = receipts[0]?.content
      .filter(part => part.type === 'text' && typeof part['text'] === 'string')
      .map(part => part['text'] as string).join('') ?? '';
    const recallId = /· necromancy (\S+)$/u.exec(rendered)?.[1];
    assert.ok(recallId !== undefined && recallId.startsWith('recall:sha256:'),
      'the receipt names the recall id');
    if (recallId === undefined) return;

    const recalled = await mount.tool.execute({ id: recallId }, { sessionID: SESSION });
    assert.equal(typeof recalled.content, 'string', 'a single-part record returns its exact text');
    if (typeof recalled.content !== 'string') return;
    const archived = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(removed.bytes);
    assert.equal(recalled.content, archived, 'the tool returns the archived bytes byte for byte');
    assert.equal(sha256Sync(toBytes(recalled.content)), removed.sha256,
      'the recalled bytes hash equal to the removed unit');
    assert.ok(recalled.content.includes('# Note') && recalled.content.includes('body line'),
      'the recalled unit carries the whole body text, not a cut one');
    assert.equal(recalled.content.includes('[racoons]'), false,
      'the recalled unit is the archived bytes, not a product marker');
  } finally { await mount.close(); }
});
