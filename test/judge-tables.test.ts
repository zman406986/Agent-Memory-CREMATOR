/**
 * The prune's table loop against the core's carry scheduler (ISSUE-026 chunk 3;
 * CRITIC-026 chunk A; ADR-0028 left this engine with one caller, the bulk
 * prune).
 *
 * Four claims, each pinned where it can fail:
 *
 *   1. THE CACHE PROPERTY the fork redesign exists for: after a two-table pass,
 *      request 2 carries request 1's messages as an exact prefix, with identical
 *      system and tools. The comparison is canonical bytes of the request
 *      objects this seam hands the host; the provider's HTTP body is the
 *      adapter's to serialize, not this seam's to see.
 *   2. a halted table keeps every pending row under the core's halt code
 *      (`answer-unreadable`), never a local `missing-index`.
 *   3. the send seam re-asserts the fork's system/tool hashes and refuses a
 *      drifted prefix with the fork's typed errors before the host is touched.
 *   4. a fork seeded from a raw capture keeps main's leading `system` message as
 *      messages[0], with the system slot exactly as main held it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENTRY_ASK_END_ANCHOR, entryBatchAskMessage, isRefusedPruneAnchor,
  PRUNE_ASK_FINAL_LINE, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT,
  PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT,
  PRUNE_ASK_SYSTEM_PROMPT,
  buildPruneAskRows, canonicalManifestBytes, equalBytes, hashMessages,
  renderPruneAskTable, seedFork,
} from '@cremator/core';
import type {
  EntryBatchRow, PruneAskGrammar, PruneAskRow, ProcessingUnit, ToolResultNode, WireRequest,
} from '@cremator/core';
import { captureMainRequest } from '../src/main-wire.js';
import { runTables, tableAsk } from '../src/judge-tables.js';
import { retryRefusedRows } from '../src/prune-retry.js';
import { askWire } from '../src/llm-ask.js';
import type { DshLlmChunk, DshLlmStreamOptions } from '../src/plugin.js';

const encoder = new TextEncoder();
const route = { provider: 'a6', model: 'deepseek-v4.1-flash-1017' };

interface FakeLlm {
  readonly calls: DshLlmStreamOptions[];
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** A scripted seam: reply N is the Nth function's text, so a re-ask differs. */
function scriptedLlm(answers: readonly string[]): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? '';
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: answer };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/** A reply that carries no text at all: the tool-call / empty stream case. */
function silentLlm(): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/**
 * A seam whose every send reports a `{type:'usage'}` chunk before it finishes,
 * the way the host does (ISSUE-178). `usage` counts differ per call so a test
 * can tell one send's reading from another's.
 */
function pricedLlm(answers: readonly string[]): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const ordinal = calls.length;
      const answer = answers[Math.min(ordinal - 1, answers.length - 1)] ?? '';
      return (async function* emit() {
        yield { type: 'usage',
          usage: { inputTokens: 100 * ordinal, cacheReadTokens: 50 * ordinal, outputTokens: 7 } };
        yield { type: 'text-delta', index: 0, text: answer };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

/** A priced seam whose reply carries no text: the send was paid and refused. */
function pricedSilentLlm(): FakeLlm {
  const calls: DshLlmStreamOptions[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'usage', usage: { inputTokens: 900, cacheReadTokens: 100, outputTokens: 0 } };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

function unit(index: number): ProcessingUnit {
  const nodeId = `dsh:s1:result:c${String(index)}`;
  const text = `line one of ${String(index)}\nline two of ${String(index)}\nline three`;
  const bytes = encoder.encode(text);
  return { id: `unit:${nodeId}`, nodeId,
    source: { nodeId, sha256: `sha-${String(index)}`, byteLength: bytes.length },
    path: `file-${String(index)}.txt`,
    span: { byteRange: { startByte: 0, endByteExclusive: bytes.length },
      lineRange: { startLine: 1, endLineInclusive: 3 } },
    byteLength: bytes.length };
}

/** A zero-line unit: no line span, so the table shows `[0 lines]`. */
function zeroLineUnit(index: number): ProcessingUnit {
  const nodeId = `dsh:s1:result:z${String(index)}`;
  return { id: `unit:${nodeId}`, nodeId,
    source: { nodeId, sha256: `sha-z${String(index)}`, byteLength: 0 },
    path: null,
    span: { byteRange: { startByte: 0, endByteExclusive: 0 }, lineRange: null },
    byteLength: 0 };
}

function nodeFor(value: ProcessingUnit): ToolResultNode {
  const bytes = encoder.encode('first quote\nmiddle\nlast quote');
  return { id: value.nodeId, kind: 'tool-result', callId: `c${value.nodeId}`,
    turnOrdinal: 1, stepOrdinal: 1, bytes, byteLength: bytes.length, sha256: 'sha',
    evidence: { kind: 'read', target: null, paths: [], source: {
      nodeId: value.nodeId, sha256: 'sha', byteLength: bytes.length }, sourceRecallId: null },
    embeddedRecords: [] };
}

/** Main's last sent request, as the capture would hand it to a fork. */
const MAIN: WireRequest = {
  system: 'MAIN SYSTEM PROMPT BYTES',
  tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', text: 'read big.txt' },
    { role: 'assistant', text: 'Reading it.' },
    { role: 'tool', text: 'the oversized result bytes' },
  ],
};

function rowsOf(count: number) {
  const units = Array.from({ length: count }, (_, index) => unit(index + 1));
  return buildPruneAskRows(units.map(value => ({ unit: value, node: nodeFor(value) })));
}

function stampsOf(rows: ReturnType<typeof rowsOf>) {
  return new Map(rows.map(row => [row.index,
    { unitId: row.unit.id, answeredInRound: 1 }]));
}

async function run(llm: FakeLlm, count: number, journal: {
  records: { kind: string; [field: string]: unknown }[];
}, grammar?: PruneAskGrammar) {
  const rows = rowsOf(count);
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
    stamps: stampsOf(rows), llm, route,
    ...(grammar === undefined ? {} : { grammar }),
    journal: (kind, fields) => { journal.records.push({ kind, ...fields }); },
  });
  return { rows, outcome };
}

function collector() {
  const records: { kind: string; [field: string]: unknown }[] = [];
  return { records };
}

test('THE CACHE PROPERTY: a two-table pass repeats request 1 in request 2 as an exact byte prefix',
  async () => {
    // Table 1 asks all 13 rows (no row cap), answers 1-11, and leaves 12 and 13
    // out; table 2 re-asks the two carried rows.
    const answers = [
      JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, index) =>
        [String(index + 1), { keepall: true }]))),
      '{"12":{"keepall":true},"13":{"keepall":true}}',
    ];
    const llm = scriptedLlm(answers);
    const { outcome } = await run(llm, 13, collector());
    assert.equal(outcome.tables, 2, 'thirteen units split into two tables');
    assert.equal(outcome.kept.size, 13);
    const first = llm.calls[0];
    const second = llm.calls[1];
    assert.ok(first !== undefined && second !== undefined, 'two requests left the seam');
    const firstMessages = first.messages as readonly unknown[];
    const secondMessages = second.messages as readonly unknown[];

    // Identical system and tools: canonical bytes, not a shape comparison.
    assert.equal(second.system, first.system, 'system bytes must not change');
    assert.equal(
      equalBytes(canonicalManifestBytes(first.system), canonicalManifestBytes(second.system)),
      true, 'system canonical bytes drifted');
    assert.equal(
      equalBytes(canonicalManifestBytes(first.tools ?? []), canonicalManifestBytes(second.tools ?? [])),
      true, 'tool list canonical bytes drifted');

    // Every message of request 1 is a byte-for-byte prefix message of request 2.
    assert.equal(secondMessages.length, firstMessages.length + 2,
      'request 2 is request 1 plus the answer and the next ask');
    for (let index = 0; index < firstMessages.length; index += 1) {
      assert.equal(
        equalBytes(canonicalManifestBytes(firstMessages[index]),
          canonicalManifestBytes(secondMessages[index])),
        true, `message ${String(index)} is not byte-identical`);
    }
    assert.deepEqual(hashMessages(secondMessages.slice(0, firstMessages.length)),
      hashMessages(firstMessages), 'the whole prefix must hash as the first request did');

    // The literal byte-prefix statement too: serialized, the second array
    // starts with the first array's body followed by the new messages.
    const firstJson = JSON.stringify(firstMessages);
    const secondJson = JSON.stringify(secondMessages);
    assert.equal(secondJson.startsWith(`${firstJson.slice(0, -1)},`), true,
      'request 2 must carry request 1 as a literal prefix of its message array');
  });

test('a halted table defers every pending row instead of deciding it', async () => {
  // ISSUE-177: a halt produces no answer, so there is no refusal to name. The
  // old halt drain wrote every pending row into `refused` — the DECIDED map —
  // so `refusedCount` reported 13 decisions for a pass that decided nothing.
  // A deferred row keeps its unit just the same; what changes is that no count
  // reads it as decided. This test replaced "a halted table keeps every pending
  // row under the core halt code", which pinned the defect.
  const journal = collector();
  const llm = silentLlm();
  const { outcome } = await run(llm, 13, journal);
  assert.equal(outcome.halted, true);
  assert.equal(outcome.tables, 1, 'a no-text reply stops the pass, never re-asks');
  assert.equal(outcome.kept.size, 0);
  assert.equal(outcome.refused.size, 0,
    'a halt refuses nothing: no answer came back for any row');
  assert.equal(outcome.deferred.length, 13, 'every pending row is deferred, never dropped');
  assert.deepEqual(outcome.deferred.map(entry => entry.index),
    Array.from({ length: 13 }, (_, index) => index + 1), 'deferred rows keep table order');
  for (const entry of outcome.deferred) {
    assert.equal(entry.attempt, 2, 'a deferred row names the attempt it would have taken');
    assert.equal('code' in entry, false, 'a deferral carries no refusal code');
  }
  assert.equal(outcome.attemptTotals.deferred, 13, 'the pass totals count the deferral');
  assert.equal(outcome.attemptTotals.finalRefusals, 0, 'a deferred row is not final');
  const skip = journal.records.find(record => record['kind'] === 'prune-skip');
  assert.equal(skip?.['reason'], 'no-text');
});

test('a fork seeded from a raw capture keeps the leading system message at messages[0]', async () => {
  const captured = captureMainRequest({
    sessionId: 's1',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'HARNESS PROMPT' }] },
      { role: 'user', content: [{ type: 'text', text: 'read big.txt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'the bytes' }] },
    ],
  });
  assert.ok(captured !== null);
  // Main had no system slot: the prompt is message 0, and the fork keeps it there.
  assert.equal(captured.wire.system, '');
  assert.deepEqual(captured.wire.messages[0], { role: 'system', text: 'HARNESS PROMPT' });
  const rows = rowsOf(1);
  const llm = scriptedLlm(['{"1":{"keepall":true}}']);
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(captured.wire), rows,
    stamps: stampsOf(rows), llm, route, journal: () => {},
  });
  assert.equal(outcome.kept.size, 1);
  const sent = llm.calls[0];
  assert.ok(sent !== undefined);
  assert.equal(sent.system, undefined, 'the empty slot stays absent, as main sent it');
  const messages = sent.messages as readonly { role?: unknown; content?: unknown }[];
  assert.equal(messages[0]?.role, 'system', 'messages[0] is main\'s message, unlifted');
  assert.deepEqual(messages[0]?.content, [{ type: 'text', text: 'HARNESS PROMPT' }]);
  // The tool turn rides as `user` at the send seam; the role is the only projection.
  assert.deepEqual(messages.slice(1, 4).map(message => message.role),
    ['user', 'assistant', 'user']);
  assert.deepEqual(messages[3]?.content, [{ type: 'text', text: 'the bytes' }]);
});

test('no row cap: every pending row rides the first table, however many', async () => {
  // Fifteen units, one readable answer: the whole queue is ONE send. The old
  // twelve-unit cap would have split this into two sends; nothing does now
  // (2026-11-16 owner ruling, ADR-0060 §Amendment).
  const journal = collector();
  const llm = scriptedLlm([JSON.stringify(Object.fromEntries(Array.from({ length: 15 },
    (_, index) => [String(index + 1), { keepall: true }])))]);
  const { outcome } = await run(llm, 15, journal);
  assert.equal(outcome.tables, 1, 'one table for the whole queue');
  assert.equal(outcome.kept.size, 15, 'every unit was asked and answered');
  const tables = journal.records.filter(record => record['kind'] === 'prune-table');
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.['tableUnits'], 15, 'the line counts all fifteen rows');
  assert.equal(tables[0]?.['attempt'], 1);
});

test('a carry at the last table rides the front of one more table', async () => {
  // Twelve units: table 1 asks all 12 (no row cap), answers 1-11 and leaves 12
  // out. No flag asks for the second table; the loop keeps sending while a row
  // is pending, so the carried row lands at the front of table 2 (attempt 2)
  // and is answered there.
  const llm = scriptedLlm([
    JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, index) =>
      [String(index + 1), { keepall: true }]))),
    '{"12":{"keepall":true}}',
  ]);
  const journal = collector();
  const { outcome } = await run(llm, 12, journal);
  assert.equal(outcome.tables, 2, 'one catch-up table, not a dropped row');
  assert.equal(outcome.kept.size, 12);
  const table = journal.records.filter(record => record['kind'] === 'prune-table');
  assert.equal(table.length, 2);
  assert.equal(table[1]?.['attempt'], 2, 'table 2 re-asks the carried row');
  assert.equal(table[0]?.['tableUnits'], 12, 'the whole queue rode table 1');
});

test('a re-ask table journals its carried rows at the re-ask ordinal', async () => {
  // 13 units: table 1 asks all 13 (no row cap), answers 1-11, and carries 12
  // and 13. Table 2 is the two carried rows, both at attempt 2 — one attempt
  // group. With no row cap a table never mixes carried re-asks with fresh rows:
  // a later table exists only when a reply left rows carried, so the telemetry
  // still names the per-index attempt, never the table's ordinal.
  const llm = scriptedLlm([
    JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, index) =>
      [String(index + 1), { keepall: true }]))),
    '{"12":{"keepall":true},"13":{"keepall":true}}',
  ]);
  const journal = collector();
  const { outcome } = await run(llm, 13, journal);
  assert.equal(outcome.tables, 2);
  assert.equal(outcome.kept.size, 13);
  const lines = journal.records.filter(record => record['kind'] === 'prune-table');
  assert.deepEqual(lines.map(line => [line['tables'], line['attempt'], line['tableUnits']]),
    [[1, 1, 13], [2, 2, 2]],
    'table 2 is one attempt group: two carried rows at attempt 2');
  assert.deepEqual(lines.map(line => line['answered']), [11, 2]);
  // CRITIC-022 P2 #4: the pass totals report the loop's own sent count, never
  // the settled-plan count.
  assert.equal(outcome.attempts.length, 2, 'one attempt group per ordinal mix');
  assert.deepEqual(outcome.attemptTotals,
    { tables: 2, carried: 2, reasked: 2, finalRefusals: 0, deferred: 0 },
    'two tables sent, however many attempt groups they settled');
});

test('a non-JSON reply takes the pass one re-ask instead of keeping everything', async () => {
  const llm = scriptedLlm(['not json at all',
    '{"1":{"keepall":true},"2":{"keepall":true}}']);
  const journal = collector();
  const { outcome } = await run(llm, 2, journal);
  assert.equal(outcome.halted, false, 'a text reply is not a halt');
  assert.equal(outcome.tables, 2, 'the reply was re-asked once, not skipped');
  assert.equal(outcome.kept.size, 2);
  const lines = journal.records.filter(record => record['kind'] === 'prune-table');
  assert.deepEqual(lines.map(line => [line['attempt'], line['tableUnits']]), [[1, 2], [2, 2]]);
  assert.deepEqual(lines[0]?.['refusedByCode'], {
    'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
    'answer-not-an-object': 0, 'answer-unreadable': 2, 'action-not-in-grammar': 0,
    'spans-outside-result': 0,
  });
  const skip = journal.records.find(record => record['kind'] === 'prune-skip');
  assert.equal(skip?.['reason'], 'no-verdict');
});

// --- the bulk prune's ask COST (ISSUE-178) ----------------------------------
//
// The seam reads the host's `{type:'usage'}` chunk into `reply.usage`
// (`llm-ask.ts`), and before this ticket every caller of `askWire` in this
// package received that field and dropped it. The three tests below pin the
// repair: a paid send always leaves a usage-bearing journal record, in the same
// field names the entry lane's `entry-ask` rows use, so one meter reads both.

test('an answered bulk-prune table journals its usage, in the entry lane\'s field names',
  async () => {
    const journal = collector();
    const llm = pricedLlm(['{"1":{"keepall":true},"2":{"keepall":true}}']);
    const { outcome } = await run(llm, 2, journal);
    assert.equal(outcome.kept.size, 2);
    const asks = journal.records.filter(record => record['kind'] === 'prune-ask');
    assert.equal(asks.length, 1, 'one table sent, one cost line');
    const ask = asks[0];
    assert.equal(ask?.['status'], 'answered');
    assert.equal(ask?.['tables'], 1, 'the line names the send it belongs to');
    assert.equal(ask?.['round'], 1);
    assert.equal(ask?.['sessionId'], 's1');
    // The seam's one arithmetic: input + cacheRead + cacheWrite, cacheRead kept
    // as `cachedInputTokens` — the same shape `entry-ask` writes, so the two
    // lanes can be summed without a second mapping.
    assert.deepEqual(ask?.['usage'],
      { inputTokens: 150, outputTokens: 7, cachedInputTokens: 50 });
    // The send is still counted by the table line beside it; the cost line is
    // additive and does not replace it.
    assert.equal(journal.records.filter(record => record['kind'] === 'prune-table').length, 1);
  });

test('every table of a multi-table pass journals its own cost, none merged', async () => {
  // Two tables of DIFFERENT sizes; the cost line's ordinal is the only thing
  // that tells two sends apart, so a reader that summed by value would lose one.
  const llm = pricedLlm([
    JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, index) =>
      [String(index + 1), { keepall: true }]))),
    '{"12":{"keepall":true}}',
  ]);
  const journal = collector();
  const { outcome } = await run(llm, 12, journal);
  assert.equal(outcome.tables, 2);
  const asks = journal.records.filter(record => record['kind'] === 'prune-ask');
  assert.equal(asks.length, 2, 'two paid sends, two cost lines');
  assert.deepEqual(asks.map(entry => entry['tables']), [1, 2]);
  assert.deepEqual(asks.map(entry => (entry['usage'] as { inputTokens: number }).inputTokens),
    [150, 300], 'the second send carried the grown fork and cost more');
});

test('a paid send that produced no text still journals its cost', async () => {
  // The halt path: the host billed the call, the stream carried no answer. A
  // journal that named only answered asks would read this spend as zero, which
  // is the defect ISSUE-178 was filed for.
  const journal = collector();
  const llm = pricedSilentLlm();
  const { outcome } = await run(llm, 13, journal);
  assert.equal(outcome.halted, true, 'a no-text reply halts the pass');
  const asks = journal.records.filter(record => record['kind'] === 'prune-ask');
  assert.equal(asks.length, 1, 'the refused send still states what it cost');
  assert.equal(asks[0]?.['status'], 'refused');
  assert.equal(asks[0]?.['reason'], 'no-text', 'the refusal names itself');
  assert.deepEqual(asks[0]?.['usage'],
    { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 100 });
  // The halt's own line is unchanged and still present beside it.
  assert.equal(journal.records.some(record => record['kind'] === 'prune-skip'), true);
});

test('a host that reports no usage chunk journals no cost line, never a zero one',
  async () => {
    // `reply.usage` absent means the host made no claim. Writing
    // `usage: {inputTokens: 0, …}` would be a zero claim and would hide the ask
    // from the unmeasured remainder the alarm states.
    const journal = collector();
    const llm = scriptedLlm(['{"1":{"keepall":true}}']);
    const { outcome } = await run(llm, 1, journal);
    assert.equal(outcome.kept.size, 1);
    assert.equal(journal.records.some(record => record['kind'] === 'prune-ask'), false);
    assert.equal(journal.records.some(record => record['kind'] === 'prune-table'), true,
      'the table line is still written: the send happened, its cost is unknown');
  });

// --- the two-verdict bulk ask (ISSUE-221) ----------------------------------

test('the grammar selects the prompt, the closing line and the row shape; 3option is unchanged',
  () => {
    const rows = rowsOf(2);
    // Explicit `3option` (ADR-0056 keeps it selectable by name): its contract,
    // its table (no per-row count) and its closing line, byte for byte.
    const threeOption = tableAsk(rows, '3option');
    assert.ok(threeOption.includes(PRUNE_ASK_SYSTEM_PROMPT),
      'the 3option contract is in the ask');
    assert.ok(threeOption.includes(renderPruneAskTable(rows)),
      'the 3option table is the original rendering, byte for byte');
    assert.ok(threeOption.endsWith(PRUNE_ASK_FINAL_LINE),
      'the 3option final line closes the ask');
    assert.equal(threeOption.includes('line(s)]'), false, '3option rows carry no line count');
  });

test('the bulk nokeepall ask IS the entry jsonl-20-nokeepall message, byte for byte (ISSUE-508)',
  () => {
    // Four rows: a path-bearing call, a refused anchor, and a same-kind/
    // same-path pair (ordinals 1 and 2), so the conversion is pinned on the two
    // facts the prune renderer writes — the target, the refusal note — and on the
    // pass's own occurrence ordinal.
    const units = [unit(1), unit(2), unit(3), unit(4)];
    const rows = buildPruneAskRows([
      { unit: units[0] as ProcessingUnit, node: nodeFor(units[0] as ProcessingUnit),
        callFacts: { toolName: 'Read', targetPath: 'config.ts' } },
      { unit: units[1] as ProcessingUnit,
        callFacts: { toolName: 'Grep', targetPath: 'server.ts' } },
      { unit: units[2] as ProcessingUnit, node: nodeFor(units[2] as ProcessingUnit),
        callFacts: { toolName: 'Read', targetPath: 'same.ts' } },
      { unit: units[3] as ProcessingUnit, node: nodeFor(units[3] as ProcessingUnit),
        callFacts: { toolName: 'Read', targetPath: 'same.ts' } },
    ]);
    assert.deepEqual(rows.map(row => row.anchor.callOrdinal), [1, 1, 1, 2],
      'the pass numbers by kind+path: two paths restart at 1, the repeat is 2');
    // The same rows in the entry message's own shape, built here from the prune
    // rows so the test names the equality the product path relies on. The
    // ordinal is carried across, so parity also pins that pass-through.
    const entryRowsOf = (source: readonly PruneAskRow[]): readonly EntryBatchRow[] =>
      source.map(row => ({
        index: row.index,
        call: row.anchor.kind,
        ...(row.anchor.path === undefined ? {} : { path: row.anchor.path }),
        ...(isRefusedPruneAnchor(row.anchor)
          ? { anchorLines: [], anchorRefusal: row.anchor.refusal }
          : { anchorLines: row.anchor.anchors }),
        callOrdinal: row.anchor.callOrdinal,
        lineCount: 3,
      }));
    const entryRows = entryRowsOf(rows);
    for (const firstTrigger of [true, false]) {
      assert.equal(tableAsk(rows, 'nokeepall', firstTrigger),
        entryBatchAskMessage(entryRows, 'jsonl-20-nokeepall', firstTrigger),
        `the bulk table is the entry message (firstTrigger=${String(firstTrigger)})`);
    }
    const ask = tableAsk(rows, 'nokeepall', true);
    assert.ok(ask.includes('1. [Read] config.ts (call #1) — '),
      'the row keeps its call and target, exactly as the prune renderer writes them');
    assert.match(ask, /2\. \[Grep\] server\.ts \(call #1\) — anchor unavailable: missing-node/u,
      'a refused anchor renders its own note, never an empty anchor list');
    assert.match(ask, /4\. \[Read\] same\.ts \(call #2\) — /u,
      'the repeated call keeps the pass ordinal');
    // The carried-row case: a table of that one row. Recomputing would print
    // #1; the pass ordinal is #2, and parity must hold with it carried across.
    const carried = [rows[3] as PruneAskRow];
    assert.equal(tableAsk(carried, 'nokeepall', false),
      entryBatchAskMessage(entryRowsOf(carried), 'jsonl-20-nokeepall', false),
      'a carried table is the entry message byte for byte');
    assert.match(tableAsk(carried, 'nokeepall', false), /4\. \[Read\] same\.ts \(call #2\) — /u,
      'the carried row keeps its index and is not renumbered to 1');
    assert.equal(ask.includes('[3 lines]'), true, 'every row states its own L');
  });

test('the first table ask states 70 percent; the next states 40 (ISSUE-508)', async () => {
  const rows = rowsOf(2);
  const first = tableAsk(rows, 'nokeepall', true);
  const later = tableAsk(rows, 'nokeepall', false);
  assert.ok(first.includes('keep at most 70 percent'), 'the first ask names 70');
  assert.equal(first.includes('keep at most 40 percent'), false,
    'one message never states both shares');
  assert.ok(later.includes('keep at most 40 percent'), 'the later ask names 40');
  assert.equal(later.includes('keep at most 70 percent'), false);

  // Through the loop: a pass whose first table leaves a row carried sends two
  // asks, and the second is the later share even though one flag started true.
  const llm = scriptedLlm(['{"1":{"keeplines":[[1,3]],"summary":"None"}}']);
  const send = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
    stamps: stampsOf(rows), llm, route, grammar: 'nokeepall', firstTrigger: true,
    journal: () => {},
  });
  assert.equal(send.tables, 2, 'one catch-up table carries the unanswered row');
  const askText = (call: { readonly messages: readonly unknown[] } | undefined): string => {
    const last = call?.messages.at(-1) as
      { readonly content?: readonly { readonly text?: string }[] } | undefined;
    return (last?.content ?? []).map(block => block.text ?? '').join('');
  };
  assert.ok(askText(llm.calls[0]).includes('keep at most 70 percent'),
    'the pass starts on the first share');
  assert.ok(askText(llm.calls[1]).includes('keep at most 40 percent'),
    'the later table of the same pass states 40');
});

test('the post-table repeat and the end anchor close every table ask (ISSUE-508)', () => {
  const rows = rowsOf(2);
  for (const [firstTrigger, repeat] of [
    [true, PRUNE_ASK_JSONL_20_NOKEEPALL_REPEAT],
    [false, PRUNE_ASK_JSONL_20_NOKEEPALL_LATER_REPEAT],
  ] as const) {
    const ask = tableAsk(rows, 'nokeepall', firstTrigger);
    assert.ok(ask.endsWith(repeat), 'the post-table repeat closes the ask');
    assert.ok(ask.endsWith(ENTRY_ASK_END_ANCHOR), 'the end anchor is the last line');
    assert.equal(ask.includes('<rows: the table'), false,
      'the table slot was replaced, never shipped');
  }
});

test('the reader gate: keepall refuses, a whole-range keeplines keeps, a partial one applies',
  async () => {
    // One reply, one object per line: the shape the new ask teaches.
    const answer = [
      '{"1":{"keepall":true}}',
      '{"2":{"keeplines":[[1,3]],"summary":"None"}}',
      '{"3":{"keeplines":[[1,2]],"summary":"the last line is enough"}}',
    ].join('\n');
    const llm = scriptedLlm([answer]);
    const { outcome } = await run(llm, 3, collector(), 'nokeepall');
    assert.equal(outcome.tables, 1);
    assert.equal(outcome.refused.get(1)?.code, 'action-not-in-grammar',
      'a keepall names an action the grammar does not offer, and keeps');
    assert.equal(outcome.kept.get(2)?.answer.verdict.action, 'keepall',
      'a whole-range keeplines is a clean keepall: it removes nothing');
    assert.equal(outcome.kept.get(3)?.answer.verdict.action, 'keeplines',
      'a partial keeplines reaches the apply path as itself');
  });

test('the first table ask states 70 on a fresh session and 40 once the flag moved', async () => {
  // The mount reads its persisted flag at mount; here the flag is the loop's own
  // input, which is what a restart hands it after reading `tableAskFired`.
  const rows = rowsOf(1);
  const llm = scriptedLlm(['{"1":{"keeplines":[[1,3]],"summary":"None"}}']);
  const journal = collector();
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
    stamps: stampsOf(rows), llm, route, grammar: 'nokeepall', firstTrigger: false,
    journal: (kind, fields) => { journal.records.push({ kind, ...fields }); },
  });
  assert.equal(outcome.tables, 1);
  const last = llm.calls[0]?.messages.at(-1) as
    { readonly content?: readonly { readonly text?: string }[] } | undefined;
  const text = (last?.content ?? []).map(block => block.text ?? '').join('');
  assert.ok(text.includes('keep at most 40 percent'), 'a resumed session states 40');
  assert.equal(text.includes('keep at most 70 percent'), false);
});

/** The text of a request's last message, as the host receives it. */
function lastMessageText(call: { readonly messages: readonly unknown[] } | undefined): string {
  const last = call?.messages.at(-1) as
    { readonly content?: readonly { readonly text?: string }[] } | undefined;
  return (last?.content ?? []).map(block => block.text ?? '').join('');
}

/** The one table answer shape the nokeepall correction teaches. */
const CORRECTION_FORMAT_FORGETALL = '{"N":{"forgetall":true,"summary":"<summary>"}}';

test('the nokeepall correction speaks the table grammar and reads a table-shaped reply '
  + '(ISSUE-508 F3)', async () => {
  // Table 1 refuses row 1 with a span past its L; the carry re-asks it and it
  // refuses again; the pass's one correction turn then gets a table-shaped
  // reply — one object on its own line — and applies it.
  const rows = rowsOf(1);
  const stamps = stampsOf(rows);
  const llm = scriptedLlm([
    '{"1":{"keeplines":[[1,9]],"summary":"too far"}}',
    '{"1":{"keeplines":[[1,9]],"summary":"too far"}}',
    '{"1":{"forgetall":true,"summary":"fixed"}}',
  ]);
  const loop = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows, stamps, llm, route,
    grammar: 'nokeepall', journal: () => {},
  });
  assert.equal(loop.tables, 2, 'the span refusal spends the row\'s one re-ask');
  assert.equal(loop.refused.get(1)?.code, 'spans-outside-result');
  const corrected = await retryRefusedRows({
    sessionId: 's1', round: 1, rows, loop, stamps, llm, route,
    grammar: 'nokeepall', journal: () => {},
  });
  assert.equal(corrected.halted, false);
  assert.equal(corrected.kept.get(1)?.answer.verdict.action, 'forgetall',
    'a table-shaped correction reply applies');
  assert.equal(corrected.refused.size, 0);
  // The correction ask itself teaches the table's own answer shape.
  const sent = lastMessageText(llm.calls.at(-1));
  assert.ok(sent.includes(CORRECTION_FORMAT_FORGETALL),
    'the one-object-per-line forgetall shape is stated');
  assert.equal(sent.includes('exactly one JSON object, one key per row above'), false,
    'the index-keyed instruction is not sent under this grammar');
  assert.ok(sent.includes('[3 lines]'), 'the re-asked row carries its own L');
});

test('the old index-keyed correction reply is never accepted under nokeepall (ISSUE-508 F3)',
  async () => {
    // The same pass, but the correction reply uses the retired wire shape
    // (`forgetall` value is the summary string). The line reader refuses it.
    const rows = rowsOf(1);
    const stamps = stampsOf(rows);
    const llm = scriptedLlm([
      '{"1":{"keeplines":[[1,9]],"summary":"too far"}}',
      '{"1":{"keeplines":[[1,9]],"summary":"too far"}}',
      '{"1":{"forgetall":"fixed"}}',
    ]);
    const loop = await runTables({
      sessionId: 's1', round: 1, fork: seedFork(MAIN), rows, stamps, llm, route,
      grammar: 'nokeepall', journal: () => {},
    });
    const corrected = await retryRefusedRows({
      sessionId: 's1', round: 1, rows, loop, stamps, llm, route,
      grammar: 'nokeepall', journal: () => {},
    });
    assert.equal(corrected.kept.size, 0, 'no verdict was applied');
    assert.equal(corrected.refused.get(1)?.code, 'malformed-row',
      'the summary-as-value shape is a row refusal, never a forgetall');
  });

test('the correction journal names the finer line code, not the collapsed one '
  + '(ISSUE-508 F4)', async () => {
  // One line carrying two action keys is `mixed-keys` in the line reader and
  // `malformed-row` in the bulk vocabulary. The correction's own journal line
  // must name the finer code so the re-ask is auditable.
  const rows = rowsOf(1);
  const stamps = stampsOf(rows);
  const bad = '{"1":{"forgetall":true,"keeplines":[[1,2]],"summary":"x"}}';
  const llm = scriptedLlm([bad, bad, '{"1":{"forgetall":true,"summary":"fixed"}}']);
  const journal = collector();
  const journalOf = (kind: string, fields: Record<string, unknown>): void => {
    journal.records.push({ kind, ...fields });
  };
  const loop = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows, stamps, llm, route,
    grammar: 'nokeepall', journal: journalOf,
  });
  assert.equal(loop.refused.get(1)?.code, 'malformed-row', 'the bulk code stays closed');
  assert.equal(loop.refused.get(1)?.detail, 'mixed-keys', 'the finer code rides beside it');
  const corrected = await retryRefusedRows({
    sessionId: 's1', round: 1, rows, loop, stamps, llm, route,
    grammar: 'nokeepall', journal: journalOf,
  });
  assert.equal(corrected.kept.size, 1, 'the table-shaped correction reply applies');
  const line = journal.records.find(record => record['kind'] === 'prune-correction');
  assert.deepEqual(line?.['reasons'], ['1:mixed-keys'],
    'the correction journal carries index:detail');
  const sent = lastMessageText(llm.calls.at(-1));
  assert.ok(sent.includes('index 1 carried more than one action key or an extra key'),
    'and the model is told the finer defect');
});

test('a zero-line row refuses keeplines [[1,1]] and keeps (ISSUE-508 F2)', async () => {
  // The row showed `[0 lines]`. The sentinel count used to keep the reader from
  // throwing must not turn `[[1,1]]` into a whole-range keep.
  const rows = buildPruneAskRows([{ unit: zeroLineUnit(1) }]);
  const llm = scriptedLlm(['{"1":{"keeplines":[[1,1]],"summary":"x"}}']);
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
    stamps: stampsOf(rows), llm, route, grammar: 'nokeepall', journal: () => {},
  });
  assert.equal(outcome.kept.size, 0, 'nothing was accepted as a keep');
  assert.equal(outcome.refused.get(1)?.code, 'spans-outside-result',
    'no span lies inside 1..0, so the row refuses and keeps');
  assert.equal(outcome.tables, 2, 'the refusal is re-askable, not terminal');
});

test('call ordinals are the pass\'s kind+path numbers and survive a carried table '
  + '(ISSUE-508 F1)', () => {
  // Same kind, different targets: two different calls, each occurrence 1.
  const one = unit(1);
  const two = unit(2);
  const differentPaths = buildPruneAskRows([
    { unit: one, node: nodeFor(one), callFacts: { toolName: 'Read', targetPath: 'a.ts' } },
    { unit: two, node: nodeFor(two), callFacts: { toolName: 'Read', targetPath: 'b.ts' } },
  ]);
  assert.deepEqual(differentPaths.map(row => row.anchor.callOrdinal), [1, 1],
    'the pass numbers by kind and target, so the second target restarts at 1');
  const ask = tableAsk(differentPaths, 'nokeepall', true);
  assert.match(ask, /1\. \[Read\] a\.ts \(call #1\)/u);
  assert.match(ask, /2\. \[Read\] b\.ts \(call #1\)/u);
});

test('a carried table re-asks its row with the pass ordinal, not a renumbered one '
  + '(ISSUE-508 F1)', async () => {
  const three = unit(3);
  const four = unit(4);
  const samePath = buildPruneAskRows([
    { unit: three, node: nodeFor(three), callFacts: { toolName: 'Read', targetPath: 'same.ts' } },
    { unit: four, node: nodeFor(four), callFacts: { toolName: 'Read', targetPath: 'same.ts' } },
  ]);
  assert.deepEqual(samePath.map(row => row.anchor.callOrdinal), [1, 2]);
  // Row 1 answers; row 2 is carried into table 2, alone. Its ordinal must stay 2.
  const llm = scriptedLlm(['{"1":{"keeplines":[[1,3]],"summary":"None"}}']);
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows: samePath,
    stamps: stampsOf(samePath), llm, route, grammar: 'nokeepall', journal: () => {},
  });
  assert.equal(outcome.tables, 2, 'the unanswered row is carried to one more table');
  const second = lastMessageText(llm.calls[1]);
  assert.match(second, /2\. \[Read\] same\.ts \(call #2\)/u,
    'the carried row keeps the ordinal the pass gave it');
  assert.equal(/2\. \[Read\] same\.ts \(call #1\)/u.test(second), false,
    'the carried table does not renumber it to 1');
});

test('an ask refused before the send leaves the first-ask line unspent (ISSUE-508 F6/F7)',
  async () => {
    const rows = rowsOf(1);
    const cases: readonly {
      readonly name: string;
      readonly route: { readonly provider: string; readonly model: string };
      readonly extra: { readonly timeoutMs?: number; readonly signal?: AbortSignal };
    }[] = [
      { name: 'not-configured', route: { provider: '', model: '' }, extra: {} },
      { name: 'invalid-timeout', route, extra: { timeoutMs: -1 } },
      // A signal already aborted when the send began: the seam refuses before
      // anything reaches the host.
      { name: 'pre-aborted', route, extra: { signal: AbortSignal.abort() } },
    ];
    for (const scenario of cases) {
      let moved = 0;
      const outcome = await runTables({
        sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
        stamps: stampsOf(rows), llm: scriptedLlm(['{"1":{"keeplines":[[1,3]],"summary":"None"}}']),
        route: scenario.route, grammar: 'nokeepall', firstTrigger: true,
        onTableAskLeft: () => { moved += 1; }, journal: () => {}, ...scenario.extra,
      });
      assert.equal(moved, 0, `${scenario.name}: the first-ask line is not spent`);
      assert.equal(outcome.halted, true, `${scenario.name}: the pass halts fail-open`);
    }
  });

test('a mid-stream abort spends the first-ask line (ISSUE-508 F6)', async () => {
  // The send began on a live signal; the host aborted while the stream ran. That
  // request left, so the session's 70 percent line is spent.
  const rows = rowsOf(1);
  const controller = new AbortController();
  const calls: DshLlmStreamOptions[] = [];
  const llm: FakeLlm = {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* emit() {
        yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 0 } };
        controller.abort();
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  let moved = 0;
  const outcome = await runTables({
    sessionId: 's1', round: 1, fork: seedFork(MAIN), rows,
    stamps: stampsOf(rows), llm, route, grammar: 'nokeepall', firstTrigger: true,
    signal: controller.signal, onTableAskLeft: () => { moved += 1; }, journal: () => {},
  });
  assert.equal(outcome.halted, true, 'the aborted stream halts fail-open');
  assert.equal(moved, 1, 'the request left, so the first-ask line is spent');
});

test('nokeepall: a literal keepall is action-not-in-grammar and is final, never re-asked',
  async () => {
    const journal = collector();
    const llm = scriptedLlm(['{"1":{"keepall":true}}']);
    const { outcome } = await run(llm, 1, journal, 'nokeepall');
    assert.equal(outcome.halted, false, 'a readable answer is not a halt');
    assert.equal(outcome.tables, 1, 'the gate refusal is terminal: no second table');
    assert.equal(outcome.kept.size, 0, 'the unit keeps, with no verdict applied');
    assert.equal(outcome.refused.get(1)?.code, 'action-not-in-grammar');
    assert.equal(outcome.attemptTotals.finalRefusals, 1);
    assert.equal(outcome.attemptTotals.reasked, 0, 'a grammar refusal spends no re-ask');
    const table = journal.records.find(record => record['kind'] === 'prune-table');
    assert.deepEqual(table?.['refusedByCode'], {
      'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
      'answer-not-an-object': 0, 'answer-unreadable': 0, 'action-not-in-grammar': 1,
      'spans-outside-result': 0,
    });
  });

test('nokeepall: a span past the row\'s shown L is spans-outside-result, never an L2 removal',
  async () => {
    // The audit defect: `[[1,4]]` on a three-line row passed the gate as an
    // answered removal while the engine planner dropped it, so the record
    // counted and priced a removal that never happened. The invalid span is a
    // re-askable refusal (the entry jsonl-20 reader's own code), so the same
    // reply on attempt 2 is final.
    const journal = collector();
    const llm = scriptedLlm([
      '{"1":{"keeplines":[[1,4]],"summary":"the whole row and one more"}}']);
    const { outcome } = await run(llm, 1, journal, 'nokeepall');
    assert.equal(outcome.halted, false, 'a readable answer is not a halt');
    assert.equal(outcome.tables, 2, 'the invalid span spends the row\'s one re-ask');
    assert.equal(outcome.kept.size, 0, 'the unit keeps, with no verdict applied');
    assert.equal(outcome.refused.get(1)?.code, 'spans-outside-result');
    assert.equal(outcome.attemptTotals.finalRefusals, 1);
    assert.equal(outcome.attemptTotals.reasked, 1, 'the row was carried once');
    const tables = journal.records.filter(record => record['kind'] === 'prune-table');
    assert.equal(tables.length, 2);
    for (const table of tables) {
      assert.deepEqual(table['refusedByCode'], {
        'missing-index': 0, 'duplicate-index': 0, 'malformed-row': 0,
        'answer-not-an-object': 0, 'answer-unreadable': 0, 'action-not-in-grammar': 0,
        'spans-outside-result': 1,
      }, 'no table counted the invalid span as answered');
    }
  });

test('an invalid grammar is a named refusal that defers every row, never a throw (ISSUE-346)',
  async () => {
    // Core's prompt/renderer throw RangeError on an unknown grammar name. The
    // loop must contain that as a named refusal and defer every pending row
    // (each unit keeps), not unwind past the rows it was about to ask.
    const journal = collector();
    const llm = scriptedLlm(['{"1":{"keepall":true}}']);
    const { outcome } = await run(llm, 3, journal, 'bogus' as PruneAskGrammar);
    assert.equal(outcome.halted, true, 'an invalid grammar stops the pass cleanly');
    assert.equal(outcome.tables, 0, 'no table is composed or sent');
    assert.equal(outcome.kept.size, 0);
    assert.equal(outcome.deferred.length, 3, 'every row is deferred, never dropped');
    assert.equal(llm.calls.length, 0, 'no request leaves on an invalid grammar');
    const skip = journal.records.find(record => record['kind'] === 'prune-skip');
    assert.equal(skip?.['reason'], 'invalid-grammar', 'the refusal names the grammar defect');
  });

test('an invalid grammar cannot discard answered verdicts mid-pass via the correction (ISSUE-346)',
  async () => {
    // A real loop answers row 1 and refuses row 2 (malformed), so the pass owes
    // a correction turn. The correction renders through core's grammar-gated
    // `pruneCorrectionMessage`, which throws on an unknown name. That throw must
    // be contained: the loop's answered verdicts survive and nothing escapes.
    const rows = rowsOf(2);
    const stamps = stampsOf(rows);
    const llm = scriptedLlm(['{"1":{"keepall":true}}', '{"2":{"keepall":false}}']);
    const loop = await runTables({
      sessionId: 's1', round: 1, fork: seedFork(MAIN), rows, stamps, llm, route,
      journal: () => {},
    });
    assert.equal(loop.halted, false);
    assert.equal(loop.kept.size, 1, 'row 1 answered before the correction');
    assert.equal(loop.refused.size, 1, 'row 2 is owed a correction');
    const journal = collector();
    const corrected = await retryRefusedRows({
      sessionId: 's1', round: 1, rows, loop, stamps, llm, route,
      grammar: 'bogus' as PruneAskGrammar,
      journal: (kind, fields) => { journal.records.push({ kind, ...fields }); },
    });
    assert.equal(corrected.kept.size, 1, 'the answered verdict survives the invalid grammar');
    assert.equal(corrected.kept.get(1)?.index, 1);
    assert.equal(corrected.refused.size, 1, 'the refused row keeps its unit');
    assert.equal(corrected.halted, false, 'the loop outcome rides through unchanged');
  });

