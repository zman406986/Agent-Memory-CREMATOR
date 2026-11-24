/**
 * Focused tests for `replay-opencode-asks.mjs` (ISSUE-510, opencode lane).
 *
 * The pure parts run on synthetic rows: the two-option table parser, the
 * corrected 70/40 ask, the stub answer's determinism against the shipped
 * reader, the send-lane gate, the failure aggregate, and the `refs:`-scoped
 * credential selection. The pinned-world cases need the 2026-11-19 opencode
 * evidence under `scratchpad/launch/` (disposable by law) and SKIP, naming the
 * path, when it is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJsonl20NoKeepallAnswer, lineCount, sha256Sync, toBytes } from '@cremator/core';
import {
  MOMENTS, anchorMatchesText, assertAllGated, assignRowLineCounts, capturedUnits, chargeOf,
  chargedTokensOf, computeOffline, correctedAsk, correctedAskGate, envelopeResultText,
  grantBlocksSend, keyFromCredentials, loadKey, normalizedWholeRangeIndexes, parseAskRows,
  partialKeepFreedBytes, recomputeRecord, sendAggregate, sizeRows, stubAnswerText, verdictBytes,
} from './replay-opencode-asks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'replay-opencode-asks.mjs');
const WORLD = path.resolve(HERE, '..', '..', 'scratchpad', 'launch', '2026-11-19-opencode-v2');
const hasWorld = fs.existsSync(WORLD);
const skip = hasWorld ? false : `input absent: ${WORLD} (scratchpad/ is disposable by law)`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'replay-opencode-asks-'));

/** The captured old table: `N. [kind] path (call #k) — anchor`, path optional. */
const OLD_PROMPT = [
  'The messages above are the production conversation. This message is one table of units.',
  '',
  '1. [read] a.ts (call #1) — line 1 of 1 ends with "alpha"',
  '2. [edit] b.ts (call #1) — line 1 of 1 ends with "beta"',
  '3. [grep] c/ (call #1) — line 1 of 1 ends with "gamma"',
  '4. [read] (call #1) — anchor unavailable: missing-node',
].join('\n');

test('parseAskRows keeps the anchor as a quote, never as L, and keeps the ordinal', () => {
  const rows = parseAskRows(OLD_PROMPT);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.call), ['read', 'edit', 'grep', 'read']);
  assert.deepEqual(rows.map((row) => row.callOrdinal), [1, 1, 1, 1]);
  assert.equal(rows[0].path, 'a.ts');
  assert.deepEqual(rows[0].anchorLines, ['line 1 of 1 ends with "alpha"']);
  assert.equal(rows[0].lineCount, undefined, 'the old anchor states a count, never sets L');
  assert.equal(rows[3].path, undefined, 'a pathless row stays pathless');
  assert.equal(rows[3].anchorLines.length, 1, 'a refused anchor stays a quote');
});

/** One captured request message pair per synthetic unit: a call and its result. */
function bodyOfUnits(units) {
  const messages = [];
  for (const unit of units) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{
      id: unit.id, type: 'function',
      function: { name: unit.call, arguments: JSON.stringify(unit.input ?? { path: unit.path }) },
    }] });
    messages.push({ role: 'tool', tool_call_id: unit.id, content: unit.text });
  }
  messages.push({ role: 'user', content: 'the ask' });
  return { messages };
}

test('a multi-line unit yields [3 line(s)], ignores the old 1-line anchor, keeps 1..2', () => {
  const text = 'alpha\nbeta\ngamma';
  const units = capturedUnits(bodyOfUnits([{ id: 'c1', call: 'read', path: 'a.ts', text }]));
  assert.equal(units.length, 1);
  assert.equal(units[0].lineCount, 3, 'the decoded text has three lines');
  const prompt = '1. [read] a.ts (call #1) — line 1 of 1 ends with "gamma"';
  const sized = assignRowLineCounts(parseAskRows(prompt), units);
  assert.deepEqual(sized.missing, []);
  assert.equal(sized.rows[0].lineCount, 3, 'the old anchor says 1, the unit has 3 lines');
  assert.equal(sized.rows[0].decodedBytes, Buffer.byteLength(text));

  const ask = correctedAsk(sized.rows, true);
  assert.match(ask, /\[3 lines\]/, 'the corrected row states the computed count');
  assert.deepEqual(sized.rows[0].anchorLines,
    ['line 1 of 3 ends with "alpha"', 'line 3 of 3 ends with "gamma"'],
    'the quotes are real lines of the matched unit, so they agree with [3 lines]');
  assert.doesNotMatch(ask, /line 1 of 1/, 'the recorded envelope quote is gone, not carried beside it');
  assert.equal(correctedAskGate(sized.rows, ask, true).ok, true);

  const reading = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,2]],"summary":"kept the head"}}', [1], new Map([[1, 3]]),
  );
  assert.equal(reading.rows[0].status, 'answered', 'a partial range inside 1..3 is accepted');
  assert.equal(reading.rows[0].answer.action, 'keeplines');

  const whole = readJsonl20NoKeepallAnswer(
    '{"1":{"keeplines":[[1,3]],"summary":"kept it all"}}', [1], new Map([[1, 3]]),
  );
  assert.equal(whole.rows[0].answer.action, 'keepall', 'the whole range normalizes to a clean keep');
});

test('a row whose unit is absent from the capture is reported, never assigned a count', () => {
  const rows = parseAskRows(OLD_PROMPT);
  const sized = assignRowLineCounts(rows, []);
  assert.deepEqual(sized.missing, [1, 2, 3, 4]);
  assert.ok(sized.rows.every((row) => row.lineCount === undefined), 'no count is invented');
});

test('two same-call units in reverse order: the anchor picks the right one, not the order', () => {
  // Two reads of one path. The first captured unit ends with "alpha tail", the
  // second with "beta tail"; the row names the SECOND (call #2) by its quote.
  const units = capturedUnits(bodyOfUnits([
    { id: 'c1', call: 'read', path: 'a.ts', text: 'first body\nalpha tail' },
    { id: 'c2', call: 'read', path: 'a.ts', text: 'second body 1\nsecond body 2\nbeta tail' },
  ]));
  const rows = parseAskRows('1. [read] a.ts (call #2) — line 1 of 1 ends with "beta tail"');
  const sized = assignRowLineCounts(rows, units);
  assert.deepEqual(sized.disagree, []);
  assert.equal(sized.rows[0].lineCount, 3, 'the anchored unit, not the first captured one');
  assert.equal(sized.rows[0].unitOrdinal, 2, 'the matched unit is the second occurrence');
  assert.equal(sized.rows[0].matchedBy, 'anchor');
  assert.equal(sized.rows[0].anchorVerified, true);
});

test('a row whose ordinal and anchor disagree stops the match and names the row', () => {
  const units = capturedUnits(bodyOfUnits([
    { id: 'c1', call: 'read', path: 'a.ts', text: 'first body\nalpha tail' },
    { id: 'c2', call: 'read', path: 'a.ts', text: 'second body\nbeta tail' },
  ]));
  // Call #2 claims to be the second asked occurrence, but its quote names the
  // FIRST captured unit: the ordinal and the anchor cannot both be true.
  const rows = parseAskRows('1. [read] a.ts (call #2) — line 1 of 1 ends with "alpha tail"');
  const sized = assignRowLineCounts(rows, units);
  assert.equal(sized.disagree.length, 1, 'the contradiction is reported');
  assert.equal(sized.disagree[0].index, 1);
  assert.match(sized.disagree[0].why, /call #2 names captured #1/);
});

test('an anchor that fits two different bodies is ambiguous, never a guess', () => {
  const units = capturedUnits(bodyOfUnits([
    { id: 'c1', call: 'read', path: 'a.ts', text: 'one body\nshared tail' },
    { id: 'c2', call: 'read', path: 'a.ts', text: 'other body\nshared tail' },
  ]));
  const rows = parseAskRows('1. [read] a.ts (call #1) — line 1 of 1 ends with "shared tail"');
  const sized = assignRowLineCounts(rows, units);
  assert.deepEqual(sized.ambiguous, [1]);
  assert.equal(sized.rows[0].lineCount, undefined, 'two bodies, so no count is assigned');
});

test('the archived unit text is the identity key, ahead of the anchor and the order', () => {
  const units = capturedUnits(bodyOfUnits([
    { id: 'c1', call: 'read', path: 'a.ts', text: 'one body\nshared tail' },
    { id: 'c2', call: 'read', path: 'a.ts', text: 'other body\nshared tail' },
  ]));
  // Both bodies end with the quoted words, so the anchor alone cannot decide; the
  // row's own archived unit text names the second one.
  const rows = parseAskRows('1. [read] a.ts (call #1) — line 1 of 1 ends with "shared tail"');
  assert.deepEqual(assignRowLineCounts(rows, units).ambiguous, [1], 'the anchor alone is ambiguous');
  const sized = assignRowLineCounts(rows, units, new Map([[1, 'other body\nshared tail']]));
  assert.deepEqual(sized.ambiguous, []);
  assert.equal(sized.rows[0].lineCount, 2);
  assert.equal(sized.rows[0].unitOrdinal, 2, 'the second captured read, not the first');
  assert.equal(sized.rows[0].matchedBy, 'archive');
});

test('the archived envelope decodes to the same text the wire carried', () => {
  const envelope = { input: { path: 'a.ts' }, name: 'read',
    result: { type: 'content', value: [{ type: 'text', text: 'one\ntwo\nt' }, { type: 'file', path: 'x' }] } };
  assert.equal(envelopeResultText(envelope), 'one\ntwo\nt');
  assert.equal(envelopeResultText({ result: { type: 'text', value: 'plain' } }), 'plain');
  assert.equal(envelopeResultText({ result: { type: 'error', value: { error: 'boom' } } }), '{"error":"boom"}');
  assert.equal(envelopeResultText({}), null);
});

test('anchorMatchesText reads the quoted tail of the old envelope, never as L', () => {
  const text = 'first line\nlast words here';
  assert.equal(anchorMatchesText('line 1 of 1 ends with "last words here"}}"', text), true);
  assert.equal(anchorMatchesText('line 1 of 1 ends with "nothing like this"}}"', text), false);
  assert.equal(anchorMatchesText('lines 3–5 are blank', text), false, 'no quote, no match');
});

test('an unarchived unit is sized from its decoded text; a ledger part still wins', () => {
  const rows = [
    { index: 1, call: 'write', path: 'x.md', lineCount: 1, decodedBytes: 689 },
    { index: 2, call: 'read', path: 'y.txt', lineCount: 2, decodedBytes: 40 },
    { index: 3, call: 'read', path: 'z.txt', lineCount: 1 },
  ];
  const unitIds = ['u1', 'u2', 'u3'];
  const sized = sizeRows(rows, unitIds, new Map([['u2', { bytes: 17 }]]));
  assert.deepEqual(sized.map((row) => row.unitBytes), [689, 17, null],
    'the capture sizes a kept unit, the ledger sizes an archived one, no content stays null');
  assert.deepEqual(sized.map((row) => row.unitBytesSource), ['capture', 'ledger', null]);
});

/** One priced row, in the shape `analyzeMoment` hands the accounting. */
function rowOfUnit(index, lineCountValue, text, source = 'capture') {
  return {
    index, call: 'read', callOrdinal: 1, lineCount: lineCountValue,
    decodedBytes: Buffer.byteLength(text), unitText: text,
    unitBytes: source === 'capture' ? Buffer.byteLength(text) : 0, unitBytesSource: source,
    unitId: `u${String(index)}`,
  };
}

test('a partial keep frees the dropped lines and their terminating newlines', () => {
  const text = 'alpha\nbeta\ngamma';
  assert.equal(Buffer.byteLength(text), 16);
  assert.equal(partialKeepFreedBytes(text, [{ from: 2, to: 3 }]), 6, 'drops "alpha\\n", newline included');
  assert.equal(partialKeepFreedBytes(text, [{ from: 1, to: 1 }]), 10, 'drops "beta\\ngamma"');
  assert.equal(partialKeepFreedBytes(text, [{ from: 1, to: 3 }]), 0, 'a whole range frees nothing');
  assert.equal(partialKeepFreedBytes('a\nb\nc\nd\ne', [{ from: 1, to: 1 }, { from: 5, to: 5 }]), 6,
    'two ranges drop "b\\nc\\nd\\n" between them');
  assert.equal(partialKeepFreedBytes(text, [{ from: 2, to: 9 }]), 0, 'a span past L frees nothing');
  assert.equal(partialKeepFreedBytes(undefined, [{ from: 1, to: 1 }]), 0, 'no text frees nothing');
});

test('the books price a partial keep: whole + partial + kept equals the known bytes', () => {
  const rows = [
    rowOfUnit(1, 3, 'one\ntwo\nthree'),
    rowOfUnit(2, 4, 'a\nb\nc\nd'),
    rowOfUnit(3, 2, 'kept\nwhole'),
    rowOfUnit(4, 2, 'ref\nused'),
  ];
  const text = [
    '{"1":{"forgetall":true,"summary":"gone"}}',
    '{"2":{"keeplines":[[1,1]],"summary":"head only"}}',
    '{"3":{"keeplines":[[1,2]],"summary":"None"}}',
    '{"4":{"keepall":true}}',
  ].join('\n');
  const counts = new Map(rows.map((row) => [row.index, row.lineCount]));
  const reading = readJsonl20NoKeepallAnswer(text, rows.map((row) => row.index), counts);
  const final = verdictBytes(rows, reading);
  assert.deepEqual(final.verdicts, { forgetall: 1, keeplines: 1, keepall: 1, forgetlines: 0 },
    'the whole-range keeplines normalized to a clean keep; the literal keepall is refused');
  assert.deepEqual(final.refusals, { 'action-not-in-grammar': 1 });
  assert.equal(final.wholeUnitBytesFreed, 13, 'unit 1 is forgotten whole');
  assert.equal(final.partialLineBytesFreed, 5, 'unit 2 drops "b\\nc\\nd"');
  assert.equal(final.keptBytes, 20, 'unit 2 keeps 2 B, units 3 and 4 are kept whole');
  assert.equal(final.knownBytes, 38);
  assert.equal(final.accountedBytes, 38);
  assert.equal(final.accountedOk, true, 'whole + partial + kept closes on the known bytes');
  assert.equal(final.pricedOk, true, 'every row re-closes on its own basis bytes');
  assert.deepEqual(final.unpricedRows, []);
  assert.equal(final.partialLineRows, 1);
  assert.equal(final.partialLineOk, true);
  assert.equal(final.partialZeroRows, 0);
  assert.equal(final.partialLineZeroReason, null, 'a priced partial needs no zero reason');
  assert.equal(final.decided, 3);
  assert.equal(final.rows, 4);
  assert.equal(final.allRefused, false);
});

test('pricedOk and partialLineOk can fail: an unpriced row and a zero-B partial', () => {
  // Row 1 has no known basis (unitBytes null), so its removal is NOT priced even
  // though the books still close on the rows that were priced.
  const unpriced = rowOfUnit(1, 2, 'a\nb', 'capture');
  unpriced.unitBytes = null;
  const rows = [unpriced, rowOfUnit(2, 2, 'x\ny')];
  const reading = readJsonl20NoKeepallAnswer([
    '{"1":{"forgetall":true,"summary":"gone"}}',
    '{"2":{"forgetall":true,"summary":"gone"}}',
  ].join('\n'), [1, 2], new Map([[1, 2], [2, 2]]));
  const final = verdictBytes(rows, reading);
  assert.equal(final.pricedOk, false, 'a removal with no basis cannot close');
  assert.deepEqual(final.unpricedRows, [1]);
  assert.equal(final.accountedOk, true, 'the identity still holds: it is not a gate');

  // A partial keep that frees 0 B while its text is known is a dropped line
  // nobody accounted for: `partialLineOk` must be false, not "no partials".
  const zeroRows = [rowOfUnit(1, 3, 'one\ntwo\nthree')];
  const zeroReading = readJsonl20NoKeepallAnswer('{"1":{"keeplines":[[1,3]],"summary":"all"}}',
    [1], new Map([[1, 3]]));
  // The reader normalizes [[1,3]] to keepall, so drive the zero case directly.
  const forged = { rows: [{ index: 1, status: 'answered',
    answer: { action: 'keeplines', ranges: [{ from: 1, to: 3 }] } }] };
  const zero = verdictBytes(zeroRows, forged);
  assert.equal(zeroReading.rows[0].answer.action, 'keepall', 'the reader normalizes a whole range');
  assert.equal(zero.partialZeroRows, 1);
  assert.equal(zero.partialLineOk, false, 'a zero-B partial with known text reddens the gate');
  assert.match(zero.partialLineZeroReason, /freed 0 B/);
});

test('a whole-range keeplines is marked normalized-keeplines, not a model keepall', () => {
  const counts = new Map([[1, 3], [2, 5]]);
  const text = [
    '{"1":{"keeplines":[[1,3]],"summary":"None"}}',
    '{"2":{"keeplines":[[1,2]],"summary":"head"}}',
  ].join('\n');
  assert.deepEqual([...normalizedWholeRangeIndexes(text, counts)], [1],
    'only the span that covers 1..L is marked');
  assert.deepEqual([...normalizedWholeRangeIndexes('{"1":{"keepall":true}}', counts)], [],
    'a literal keepall carries no marker');
  assert.deepEqual([...normalizedWholeRangeIndexes('not json', counts)], []);
});

test('a kept unit with a ledger archive is still priced in the captured text space', () => {
  // The old evidence archived the envelope; a partial keep addresses the
  // decoded text, so the row is booked in that space, not the envelope's.
  const text = 'first\nsecond\nthird';
  const row = rowOfUnit(1, 3, text, 'ledger');
  row.unitBytes = 999;
  const counts = new Map([[1, 3]]);
  const reading = readJsonl20NoKeepallAnswer('{"1":{"keeplines":[[1,1]],"summary":"h"}}', [1], counts);
  const final = verdictBytes([row], reading);
  assert.equal(final.partialLineBytesFreed, 12, 'drops "second\\nthird" from the decoded text');
  assert.equal(final.knownBytes, Buffer.byteLength(text));
  assert.equal(final.accountedOk, true);
});

test('the recompute re-reads a stored answer and prices its partial keeps', () => {
  const runs = [
    rowOfUnit(1, 3, 'one\ntwo\nthree'),
    rowOfUnit(2, 4, 'a\nb\nc\nd'),
  ];
  const text = [
    '{"1":{"forgetall":true,"summary":"gone"}}',
    '{"2":{"keeplines":[[1,1]],"summary":"head only"}}',
  ].join('\n');
  const sha = sha256Sync(Buffer.from(text, 'utf8'));
  const result = { ok: true, oldUnits: 1, oldBytes: 13, state: { rows: runs } };
  const stored = {
    moment: `${MOMENTS[0].run}/${MOMENTS[0].seg} j${String(MOMENTS[0].journalLine)}`,
    round: 1, share: '70', ok: true,
    firstContent: text, firstContentSha256: sha,
    newUnits: 1, newBytes: 13, wholeUnitBytesFreed: 13, partialLineBytesFreed: 0,
    partialLineOk: false, keptBytes: 20,
  };
  const recomputed = recomputeRecord(stored, result);
  assert.equal(recomputed.ok, true);
  assert.equal(recomputed.sends, 0, 'a recompute sends nothing');
  assert.equal(recomputed.newUnits, 2, 'forgetall + the partial keep');
  assert.equal(recomputed.newBytes, 18, 'whole 13 B + partial 5 B');
  assert.equal(recomputed.partialLineBytesFreed, 5);
  assert.equal(recomputed.keptBytes, 2);
  assert.equal(recomputed.accountedOk, true);
  assert.equal(recomputed.stored.newUnits, 1, 'the stored numbers ride beside the corrected ones');
  assert.equal(recomputed.stored.partialLineBytesFreed, 0);

  const altered = recomputeRecord({ ...stored, firstContentSha256: 'ffff' }, result);
  assert.equal(altered.ok, false);
  assert.match(altered.error, /does not hash to its recorded sha256/);
  assert.equal(recomputeRecord({ ...stored, firstContent: '' }, result).ok, false);
  assert.equal(recomputeRecord(stored, { ok: false }).ok, false);
});

test('the next prompt estimate stops a draw before the grant is crossed', () => {
  assert.equal(grantBlocksSend(0, 3040, 1000), false, '1000 estimated tokens fit a 1000 grant');
  assert.equal(grantBlocksSend(0, 3041, 1000), true, 'the next prompt alone crosses it');
  assert.equal(grantBlocksSend(2_999_000, 30_400, 3_000_000), true,
    'the 3,000,000 grant is not crossed by spend alone but is by the next prompt');
  assert.equal(grantBlocksSend(2_900_000, 30_400, 3_000_000), false);
});

test('the corrected ask is jsonl-20-nokeepall at 70 and 40', () => {
  const rows = parseAskRows(OLD_PROMPT)
    .map((row) => ({ ...row, lineCount: 1 })).slice(0, 3);
  const first = correctedAsk(rows, true);
  const later = correctedAsk(rows, false);
  assert.match(first, /keep at most 70 percent/);
  assert.match(later, /keep at most 40 percent/);
  assert.match(first, /\[1 line\]/);
  assert.match(first, /\[read\] a\.ts/);
  assert.match(first, /\[entry-ask-end:/);
  assert.doesNotMatch(first, /keepall/);
  assert.doesNotMatch(first, /40 percent/);
  assert.doesNotMatch(later, /70 percent/);
  assert.notEqual(first, later);
});

test('a length-trip usage row without total_tokens is charged input+output+reasoning', () => {
  assert.equal(chargedTokensOf({ prompt_tokens: 120, completion_tokens: 30 }), 150);
  assert.equal(chargedTokensOf({ prompt_tokens: 120, completion_tokens: 30, reasoning_tokens: 5 }), 155);
  assert.equal(chargedTokensOf({ promptTokens: 10, completionTokens: 2 }), 12);
  assert.equal(chargedTokensOf({ total_tokens: 999, prompt_tokens: 1 }), 999, 'total wins when present');
  assert.equal(chargedTokensOf(null), 0);
  const lengthTrip = { ok: false, error: 'length-trip',
    usage: { prompt_tokens: 120, completion_tokens: 30 } };
  assert.equal(chargedTokensOf(lengthTrip.usage), 150, 'the failed reply still charges its usage');
});

test('chargedTokensOf falls back from a non-count camel key and keeps a real 0', () => {
  assert.equal(chargedTokensOf({ promptTokens: 'lots', prompt_tokens: 10, completion_tokens: 2 }), 12,
    'a present non-numeric camel key falls back to the snake key');
  assert.equal(chargedTokensOf({ promptTokens: NaN, prompt_tokens: 10, completion_tokens: 2 }), 12);
  assert.equal(chargedTokensOf({ promptTokens: -3, prompt_tokens: 10, completion_tokens: 2 }), 12,
    'a negative camel key is not a count');
  assert.equal(chargedTokensOf({ promptTokens: 0, prompt_tokens: 999, completionTokens: 5 }), 5,
    'a legitimate 0 is returned instead of falling through to the snake key');
  assert.equal(chargedTokensOf({ promptTokens: 0, inputTokens: 7, completion_tokens: 2 }), 2,
    'a real 0 does not fall through to the alternate pair');
});

test('a reply that states no countable usage is charged a labelled estimate', () => {
  const books = { providerTokens: 0, syntheticTokens: 0, estimatedTokens: 0 };
  const charged = chargeOf({}, 'an answer', 3040, books);
  assert.equal(charged.ruler, 'estimated');
  assert.equal(charged.usage.promptTokens, 1000, 'the request is estimated at 3.04 B/token');
  assert.equal(charged.usage.completionTokens, Math.ceil(Buffer.byteLength('an answer') / 3.04));
  assert.equal(charged.tokens, charged.usage.promptTokens + charged.usage.completionTokens);
  assert.equal(books.estimatedTokens, charged.tokens, 'the grant moves on an empty usage object');
  assert.equal(books.providerTokens, 0);
  assert.equal(books.syntheticTokens, 0);

  const native = chargeOf({ promptTokens: 10, completionTokens: 2 }, 'x', 3040, books);
  assert.equal(native.ruler, 'provider');
  assert.equal(native.tokens, 12);
  assert.equal(books.providerTokens, 12, 'a real reading books to the provider total');
  assert.equal(books.estimatedTokens, charged.tokens, 'the estimate is untouched');
});

test('the corrected-ask gate names the cause of a failure', () => {
  const rows = parseAskRows(OLD_PROMPT)
    .map((row) => ({ ...row, lineCount: 1 })).slice(0, 3);
  const first = correctedAsk(rows, true);
  const pass = correctedAskGate(rows, first, true);
  assert.equal(pass.ok, true);
  assert.match(pass.detail, /3 row\(s\), 70% only, sha /, 'the pass detail keeps its shape');
  assert.match(correctedAskGate(rows, correctedAsk(rows, false), false).detail, /40% only/);

  const noShare = first.replaceAll('keep at most 70 percent', 'keep at most 50 percent');
  const missing = correctedAskGate(rows, noShare, true);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /expected share line absent: "keep at most 70 percent"/);
  assert.doesNotMatch(missing.detail, /other share line present/);

  const both = `${first}\nkeep at most 40 percent`;
  const other = correctedAskGate(rows, both, true);
  assert.equal(other.ok, false);
  assert.match(other.detail, /other share line present: "keep at most 40 percent"/);
  assert.doesNotMatch(other.detail, /expected share line absent/);

  // A row line whose [L line(s)] is not its computed count is named.
  const wrongLabel = first.replace('[1 line]', '[5 lines]');
  const label = correctedAskGate(rows, wrongLabel, true);
  assert.equal(label.ok, false);
  assert.match(label.detail, /does not end with "\[1 line\]"/);
  const noCount = correctedAskGate(rows.map(({ lineCount, ...row }) => row), first, true);
  assert.equal(noCount.ok, false);
  assert.match(noCount.detail, /has no computed line count/);

  assert.match(correctedAskGate(rows, first, true, first).detail, /equals the recorded prompt/);
});

test('the stub answer classifies as keep, forget and a refusal under the shipped reader', () => {
  const rows = [1, 2, 3, 4, 5].map((index) => ({ index, lineCount: 1 }));
  const counts = new Map(rows.map((row) => [row.index, 1]));
  const first = stubAnswerText(rows);
  assert.equal(stubAnswerText(rows), first, 'deterministic bytes');
  const reading = readJsonl20NoKeepallAnswer(first, rows.map((row) => row.index), counts);
  const byIndex = new Map(reading.rows.map((row) => [row.index, row]));
  assert.equal(byIndex.get(1).answer.action, 'keepall', '[[1,1]] on a one-line unit is a clean keep');
  assert.equal(byIndex.get(2).answer.action, 'forgetall');
  assert.equal(byIndex.get(5).code, 'action-not-in-grammar', 'a literal keepall is refused');
  assert.equal(byIndex.get(4).code, 'spans-outside-result', '[[1,2]] is past the one-line unit');
});

test('keyFromCredentials reads only immediate refs: entries and ignores decoys', () => {
  const decoy = [
    'DEEPSEEK_API_KEY: sk-outside-the-block',
    'other:',
    '  DEEPSEEK_API_KEY: sk-nested-elsewhere',
    'refs:',
    '  other:',
    '    DEEPSEEK_API_KEY: sk-nested-inside-refs',
    '  DEEPSEEK_API_KEY: "sk-top-of-refs"',
    '',
  ].join('\n');
  assert.equal(keyFromCredentials(decoy), 'sk-top-of-refs');
  assert.equal(keyFromCredentials('DEEPSEEK_API_KEY: sk-decoy-only\n'), null);
  assert.equal(keyFromCredentials('refs:\n  other:\n    DEEPSEEK_API_KEY: sk-nested\n'),
    null, 'a nested decoy is not a top-level ref');

  const home = tempDir();
  try {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dsh', '.credentials.yaml'),
      'DEEPSEEK_API_KEY: sk-decoy\nrefs:\n  DEEPSEEK_API_KEY: sk-real\n');
    const loaded = loadKey(home);
    assert.equal(loaded.key, 'sk-real');
    assert.equal(loaded.source, path.join(home, '.dsh', '.credentials.yaml'));

    fs.writeFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-decoy\n');
    assert.equal(loadKey(home).key, null, 'the decoy alone is not a key');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the send lane refuses when any gate failed', () => {
  assert.equal(assertAllGated([{ moment: { run: 'run-1', seg: 'opencode-seg1-t', journalLine: 1 }, ok: true }]), null);
  const blocked = assertAllGated([
    { moment: { run: 'run-1', seg: 'opencode-seg1-t', journalLine: 1 }, ok: true },
    { moment: { run: 'run-3', seg: 'opencode-seg8-t', journalLine: 481 }, ok: false },
  ]);
  assert.match(blocked, /run-3\/opencode-seg8-t j481/);
});

test('a failed record books no product delta and counts as a failure', () => {
  const ok = {
    ok: true, sends: 1, newUnits: 2, newBytes: 100, oldUnits: 3, oldBytes: 150,
    wholeUnitBytesFreed: 100, partialLineBytesFreed: 0, partialLineOk: true,
    keptBytes: 50, knownBytes: 150, unknownLengthRows: 0,
    verdicts: { forgetall: 2, keepall: 1 }, refusals: {},
  };
  const failed = {
    ok: false, failed: true, sends: 1, newUnits: null, newBytes: null,
    deltaUnits: null, deltaBytes: null, oldUnits: 5, oldBytes: 500,
  };
  const aggregate = sendAggregate([ok, failed], 0, 0, null);
  assert.equal(aggregate.moments, 2);
  assert.equal(aggregate.scored, 1);
  assert.equal(aggregate.failures, 1);
  assert.equal(aggregate.oldUnits, 3);
  assert.equal(aggregate.oldBytes, 150);
  assert.equal(aggregate.newUnits, 2);
  assert.equal(aggregate.deltaUnits, -1);
  assert.equal(aggregate.deltaBytes, -50);
  assert.equal(aggregate.accountedOk, true);
});

test('the aggregate carries each partialLineZeroReason once, in a stable order', () => {
  const scored = (partialLineZeroReason, extra = {}) => ({
    ok: true, sends: 1, partialLineBytesFreed: 0, partialLineOk: true,
    partialLineZeroReason, ...extra,
  });
  const aggregate = sendAggregate([
    scored('reason-a'),
    scored('reason-a'),
    scored('reason-b'),
    scored(''),
    scored(undefined),
  ], 0, 0, null);
  assert.equal(aggregate.partialLineZeroReason, 'reason-a; reason-b',
    'each distinct reason once, joined by "; " in first-seen order');
  assert.equal(sendAggregate([scored(''), scored(undefined)], 0, 0, null).partialLineZeroReason, null,
    'an empty-string reason is dropped and no non-empty reason yields null');
  assert.equal(sendAggregate([scored(undefined), scored(undefined)], 0, 0, null).partialLineZeroReason,
    null);
});

test('an all-failed aggregate reports partialLineOk as explicitly vacuous', () => {
  const failed = {
    ok: false, failed: true, sends: 1, newUnits: null, newBytes: null,
    deltaUnits: null, deltaBytes: null, oldUnits: 4, oldBytes: 400,
  };
  const aggregate = sendAggregate([failed, { ...failed }], 0, 0, null);
  assert.equal(aggregate.scored, 0);
  assert.equal(aggregate.failures, 2, 'the failure counter still counts every moment');
  assert.equal(aggregate.successOnly, true);
  assert.equal(aggregate.coverageLimited, true);
  assert.deepEqual(aggregate.coverageReasons, ['transport-failures']);
  assert.equal(aggregate.partialLineOk, null, 'zero scored records is not a vacuously passing gate');
  assert.equal(aggregate.partialLineZeroReason, null);
  assert.equal(aggregate.accountedOk, true, 'zero bytes over zero known bytes');
  assert.equal(aggregate.pricedOk, true, 'no row to price, so no row is unpriced');
});

test('a moment whose every row was refused is a failedReading, never a real zero', () => {
  const reading = {
    moment: 'run-3/opencode-seg9-t j4845',
    ok: true, sends: 1, failedReading: true, allRefused: true,
    verdicts: { forgetall: 0, keeplines: 0, keepall: 0, forgetlines: 0 }, refusals: { 'mixed-keys': 60 },
    decided: 0, rows: 60, oldUnits: 59, oldBytes: 141253, oldBytesDecoded: 108531,
    newUnits: null, newBytes: null, deltaUnits: null, deltaBytes: null,
    wholeUnitBytesFreed: 0, partialLineBytesFreed: 0, partialLineRows: 0, partialZeroRows: 0,
    partialLineOk: true, keptBytes: 165861, knownBytes: 165861,
    accountedBytes: 165861, accountedOk: true, pricedOk: true, unpricedRows: [],
    keepallSource: null, wholeKeeps: 0, normalizedWholeKeeps: 0, unknownLengthRows: 0,
  };
  const real = {
    ok: true, sends: 1, verdicts: { forgetall: 1, keepall: 0, keeplines: 0, forgetlines: 0 },
    refusals: {}, decided: 1, rows: 1, oldUnits: 1, oldBytes: 100, oldBytesDecoded: 90,
    newUnits: 1, newBytes: 90, deltaUnits: 0, deltaBytes: -10,
    wholeUnitBytesFreed: 90, partialLineBytesFreed: 0, partialLineRows: 0, partialZeroRows: 0,
    partialLineOk: true, keptBytes: 0, knownBytes: 90, accountedBytes: 90, accountedOk: true,
    pricedOk: true, unpricedRows: [], keepallSource: null, wholeKeeps: 0,
    normalizedWholeKeeps: 0, unknownLengthRows: 0,
  };
  const aggregate = sendAggregate([reading, real], 0, 0, null);
  assert.equal(aggregate.moments, 2);
  assert.equal(aggregate.scored, 1, 'the all-refused moment is not a scored reading');
  assert.equal(aggregate.failedReadings, 1);
  assert.deepEqual(aggregate.allRefusedMoments, ['run-3/opencode-seg9-t j4845'],
    'the refused moment is named, so a reader can see what the totals omit');
  assert.equal(aggregate.oldUnits, 1, 'the failed reading cannot drag the totals');
  assert.equal(aggregate.oldBytes, 100);
  assert.equal(aggregate.newUnits, 1);
  assert.equal(aggregate.deltaUnits, 0);
  assert.equal(aggregate.successOnly, true);
  assert.deepEqual(aggregate.coverageReasons, ['failed-readings']);
});

test('the paid lane needs the owner, a grant and a kill timer', () => {
  const noOwner = spawnSync(process.execPath, [SCRIPT, '--transport', 'deepseek',
    '--token-grant', '1000', '--kill-ms', '60000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(noOwner.status, 2);
  assert.match(noOwner.stderr, /--i-am-the-owner/);

  const noGrant = spawnSync(process.execPath, [SCRIPT, '--transport', 'deepseek',
    '--i-am-the-owner', '--kill-ms', '60000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(noGrant.status, 2);
  assert.match(noGrant.stderr, /--token-grant/);

  const noKill = spawnSync(process.execPath, [SCRIPT, '--transport', 'deepseek',
    '--i-am-the-owner', '--token-grant', '1000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(noKill.status, 2);
  assert.match(noKill.stderr, /--kill-ms/);
});

test('the send lane refuses to run when the offline gates fail (spawned CLI)', () => {
  const root = tempDir();
  try {
    const out = tempDir();
    try {
      const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--transport', 'stub',
        '--i-am-the-owner', '--token-grant', '100000', '--kill-ms', '60000', '--out', out],
      { encoding: 'utf8', timeout: 120000 });
      assert.equal(run.status, 2);
      assert.match(run.stderr, /offline gates failed/);
      assert.deepEqual(fs.readdirSync(out), [], 'nothing was sent or written');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Every moment's pinned shape: rows, multi-line rows, forgetall, keepall, old
 * units/bytes, and the fresh corrected ask's bytes/sha. Each ask is pinned on
 * its own, so a drift that cancels in the total still fails.
 */
const PINNED = [
  ['run-1', 'opencode-seg1-t', 166, 20, 16, 14, 6, 14, 86323, 9448,
    '88b3976b202e5457ac78b301e1a012cfaf4872311add753bed564d83212ae09e'],
  ['run-1', 'opencode-seg11-t', 21566, 59, 50, 57, 2, 57, 141883, 21120,
    'faf9afe72523f26d52497052df59ae2dfdd0dc009cb349a591e893e432c49ce1'],
  ['run-1', 'opencode-seg2-t', 7557, 61, 51, 60, 1, 60, 144277, 21675,
    'aed16b6944a1e92667a11d9fc052e4e12eaa75d017ef9ebef64ec8fdf968d0b4'],
  ['run-1', 'opencode-seg10-t', 192, 67, 46, 67, 0, 67, 151238, 22548,
    '54d7f22e78ec76b6065bacc73c1c6dc0cc858bdde7d98bcb5efaec9a17aab5f9'],
  ['run-3', 'opencode-seg1-t', 139, 23, 21, 12, 11, 12, 71455, 9623,
    '6f2824d9c233e1a1c3e38d7eae502c26fbdabdc81623ba98baf25d540f1f08a1'],
  ['run-3', 'opencode-seg4-t', 17780, 58, 48, 16, 42, 16, 52808, 14579,
    '800c730d83f648c3c81cc91fb74a0d5953c6e09d918ccaf43b104cd0bd402331'],
  ['run-3', 'opencode-seg5-t', 254, 64, 42, 64, 0, 64, 127195, 14921,
    '5d41adaf807b3d3c5a83a2067b1eabb64a49da78f9ff6ed901513e13a97fa5b2'],
  ['run-3', 'opencode-seg8-t', 481, 10, 0, 0, 10, 0, 0, 5113,
    'e9c6fed43d81202250bdc1d9416b09a34231f6b6f89b7dcfa3644e2e613af5d4'],
  ['run-3', 'opencode-seg9-t', 4845, 60, 45, 59, 1, 59, 141253, 14561,
    '31af63945a1ac1fbcccc18e04324b809dd274e097fa59e475e3547f896e17cdf'],
  ['run-3', 'opencode-seg10-t', 8598, 52, 49, 17, 35, 17, 60334, 14100,
    '1479de4b1f9708391d95ba561128506a37821c79e5a0fda1ba6dbec2bdfb7db7'],
];

/**
 * The three rows the pre-fix match got wrong, with the line count their own unit
 * has. The severity: each showed another unit's count, and one of them answered
 * `keeplines [[1,1]]` on what it believed was a one-line unit.
 */
const CORRECTED_ROWS = [
  { run: 'run-1', seg: 'opencode-seg11-t', index: 327, lines: 86 },
  { run: 'run-1', seg: 'opencode-seg11-t', index: 328, lines: 27 },
  { run: 'run-1', seg: 'opencode-seg2-t', index: 148, lines: 15 },
];

test('the ten moments replay green and pin every old removal and fresh ask', { skip }, async () => {
  assert.equal(MOMENTS.length, 10);
  const corpus = await computeOffline(WORLD);
  assert.equal(corpus.results.length, 10);
  for (const result of corpus.results) {
    assert.equal(result.ok, true, `${result.moment.run}/${result.moment.seg}: `
      + result.gates.filter((gate) => !gate.ok).map((gate) => `${gate.name} ${gate.detail}`).join('; '));
    const pinned = PINNED.find((row) => row[0] === result.moment.run && row[1] === result.moment.seg);
    assert.ok(pinned, `unpinned moment ${result.moment.seg}`);
    assert.deepEqual([result.rows, result.multiLineRows, result.verdicts.forgetall,
      result.verdicts.keepall, result.oldUnits, result.oldBytes, result.newAsk.bytes,
      result.newAsk.sha256], pinned.slice(3), result.moment.seg);
    assert.equal(result.newUnits, result.oldUnits, 'the recorded-answer replay removes the same units');
    assert.equal(result.newBytes, result.oldBytes);
    assert.equal(result.deltaUnits, 0);
    assert.equal(result.deltaBytes, 0);
    assert.equal(result.newAsk.text.includes('[[entry-ask-end:'), true);
    assert.equal(result.newAsk.text.includes('keepall keeps the whole result'), false);
    assert.equal(result.share, result.round === 1 ? '70' : '40');
    assert.equal(result.gates.find((gate) => gate.name === 'corrected-ask').detail
      .includes(`${result.share}%`), true);
    // The old prompt anchors all say `line 1 of 1`; the computed counts do not.
    const fromUnit = result.gates.find((gate) => gate.name === 'line-counts-from-unit');
    assert.equal(fromUnit.ok, true);
    if (result.multiLineRows > 0) {
      assert.match(fromUnit.detail, /row\(s\) differ from the old anchor's stated count/);
    }
    const identity = result.gates.find((gate) => gate.name === 'row-unit-match');
    assert.match(identity.detail, /matched by identity/,
      'the gate asserts the identity and the anchor for every row');
    assert.match(identity.detail, /anchor quote\(s\) verified/);
    if (result.oldUnits > 0) {
      assert.ok(result.wholeUnitBytesDecoded > 0 && result.wholeUnitBytesDecoded < result.oldBytes,
        'the decoded-text total sits beside the ledger-envelope total, in its own space');
    }
  }
  assert.equal(corpus.results.reduce((sum, row) => sum + row.oldBytes, 0), 976766);
  assert.equal(corpus.results.reduce((sum, row) => sum + row.wholeUnitBytesDecoded, 0), 787971,
    'the same removed units in decoded-text bytes');
  assert.equal(corpus.results.reduce((sum, row) => sum + row.oldUnits, 0), 366);
  assert.equal(corpus.results.reduce((sum, row) => sum + row.multiLineRows, 0), 368,
    'the identity match finds two more multi-line rows than the shifted match did');
  assert.equal(corpus.results.reduce((sum, row) => sum + row.newAsk.bytes, 0), 147688);
  assert.equal(corpus.results.reduce((sum, row) => sum + row.unknownUnits, 0), 0,
    'every row is sized: ledger for archived units, the captured text for keeps');

  // The three rows the pre-fix match got wrong, each re-read by its own unit.
  for (const corrected of CORRECTED_ROWS) {
    const result = corpus.results.find((row) => row.moment.run === corrected.run
      && row.moment.seg === corrected.seg);
    const row = result.state.rows.find((entry) => entry.index === corrected.index);
    assert.equal(row.lineCount, corrected.lines,
      `${corrected.seg} row ${String(corrected.index)} names its own unit's L`);
  }
  const seg11 = corpus.results.find((row) => row.moment.seg === 'opencode-seg11-t');
  const byRow = new Map(seg11.state.rows.map((row) => [row.index, row]));
  assert.equal(byRow.get(327).unitOrdinal, 2, 'row 327 is the second captured grep on that target');
  assert.equal(byRow.get(328).unitOrdinal, 3);
  assert.equal(byRow.get(327).lineCount, 86);
  assert.equal(byRow.get(328).lineCount, 27);

  // No row carries the recorded envelope quote beside its own count: every
  // `line N of M` in the corrected ask states that row's own L.
  for (const result of corpus.results) {
    const byIndex = new Map(result.state.rows.map((row) => [row.index, row]));
    for (const line of result.newAsk.text.split('\n').filter((entry) => /^\d+\. \[/u.test(entry))) {
      const index = Number(/^(\d+)\. /u.exec(line)[1]);
      const row = byIndex.get(index);
      assert.ok(row, `row ${String(index)} is in the state`);
      const stated = [...line.matchAll(/line \d+ of (\d+) ends with /gu)].map((match) => Number(match[1]));
      assert.ok(stated.length > 0, `row ${String(index)} shows a content anchor`);
      for (const total of stated) {
        assert.equal(total, row.lineCount,
          `row ${String(index)}: the quote's total equals its [L lines]`);
      }
      assert.doesNotMatch(line, /line 1 of 1 ends with "[\s\S]*\}"\}/u,
        'the recorded envelope quote is not carried into the corrected ask');
    }
  }
});

test('the stub transport exercises the send lane with no socket and no re-ask', { skip }, (t) => {
  const out = tempDir();
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--token-grant', '100000000', '--kill-ms', '180000', '--out', out],
  { encoding: 'utf8', timeout: 600000 });
  assert.equal(run.status, 0, run.stderr);
  const file = path.join(out, 'replay-opencode-asks-stub.json');
  assert.ok(fs.existsSync(file));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(report.transport, 'stub');
  assert.equal(report.laneKind, 'stub');
  assert.equal(report.synthetic, true);
  assert.match(report.caveat, /not a draw/);
  assert.doesNotMatch(report.caveat, /counterfactual, not an expected value/);
  assert.equal(report.records.length, 10);
  assert.equal(report.aggregate.sends, 10, 'one request per moment, no correction');
  assert.equal(report.aggregate.failures, 0);
  assert.equal(report.aggregate.scored, 10);
  assert.equal(report.aggregate.verdicts.forgetall, 192);
  assert.equal(report.aggregate.verdicts.keepall, 17, 'whole-range keeplines normalize to a clean keep');
  assert.equal(report.aggregate.verdicts.keeplines, 150, 'a partial range is now addressable');
  assert.equal(report.aggregate.refusals['action-not-in-grammar'], 93);
  assert.equal(report.aggregate.refusals['spans-outside-result'], 22,
    'only a range past a one-line unit is still refused');
  assert.equal(report.aggregate.providerTokens, 0, 'a stub reading is never a billed one');
  assert.ok(report.aggregate.syntheticTokens > 0);
  assert.equal(report.aggregate.wholeUnitBytesFreed, 508929);
  assert.equal(report.aggregate.partialLineBytesFreed, 411164,
    'every accepted partial keep frees its dropped lines, priced from the captured text');
  assert.equal(report.aggregate.partialLineRows, 150);
  assert.equal(report.aggregate.keptBytes, 270349);
  assert.equal(report.aggregate.partialLineOk, true);
  assert.equal(report.aggregate.partialZeroRows, 0, 'no priced partial freed 0 B');
  assert.equal(report.aggregate.wholeKeeps, 17);
  assert.equal(report.aggregate.normalizedWholeKeeps, 17,
    'every accepted keep was a whole-range keeplines the reader normalized');
  assert.equal(report.aggregate.keepallSource, 'normalized-keeplines');
  assert.equal(report.aggregate.failedReadings, 0);
  assert.deepEqual(report.aggregate.allRefusedMoments, []);
  assert.match(report.aggregate.partialLineZeroReason, /no partial range was answered/,
    'only the one-line moment has nothing partial to price');
  assert.equal(report.aggregate.unknownLengthRows, 0, 'a captured unit is never priced at 0 B');
  assert.equal(report.aggregate.newUnits, 342, 'forgetall 192 + keeplines 150 removal units');
  assert.equal(report.aggregate.newBytes, 920093, 'whole 508,929 B + partial 411,164 B');
  assert.equal(report.aggregate.deltaUnits, -24);
  assert.equal(report.aggregate.deltaBytes, -56673);
  assert.equal(report.aggregate.accountedOk, true,
    'whole + partial + kept equals the known unit bytes');
  assert.equal(report.aggregate.pricedOk, true,
    'every record re-closes on its own per-row basis bytes');
  assert.deepEqual(report.aggregate.unpricedRows, []);
  assert.equal(report.aggregate.oldBytesDecoded, 787971,
    'the decoded-text total of the same removed units rides beside the ledger one');
  assert.equal(report.aggregate.stopReason, null);
  assert.equal(report.records.filter((record) => record.allUnitsOneLine === true).length, 1,
    'only run-3/opencode-seg8-t tables one-line units (ten [write] results)');
  assert.equal(report.records.reduce((sum, record) => sum + record.multiLineUnits, 0), 368);
  assert.ok(report.records.every((record) => record.accountedOk === true));
  assert.ok(report.records.every((record) => record.sends === 1));
  assert.ok(report.records.every((record) => record.usage.readings.length === 1
    && record.usage.readings[0].ruler === 'synthetic'),
  'each success record keeps the raw usage reading the charge came from');
  assert.equal(report.records.filter((record) => record.partialLineOk === true).length, 10,
    'every moment prices its partials; the one-line moment has none and says so');
  assert.ok(report.records.every((record) => record.partialLineRows === record.verdicts.keeplines));
});

test('a stub length-trip charges its usage, is success-only and exits 1', { skip }, (t) => {
  const out = tempDir();
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--stub-fail', 'length-trip', '--token-grant', '100000000', '--kill-ms', '180000', '--out', out],
  { encoding: 'utf8', timeout: 600000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'replay-opencode-asks-stub.json'), 'utf8'));
  assert.equal(report.records.length, 10);
  for (const record of report.records) {
    assert.equal(record.ok, false);
    assert.equal(record.error, 'length-trip');
    assert.equal(record.sends, 1, 'a failed moment is still one request');
    assert.equal(record.chargedTokens, 1001, 'a billed truncated draw is charged');
  }
  assert.equal(report.aggregate.failures, 10);
  assert.equal(report.aggregate.scored, 0);
  assert.equal(report.aggregate.sends, 10);
  assert.equal(report.aggregate.successOnly, true);
  assert.equal(report.aggregate.coverageLimited, true);
  assert.deepEqual(report.aggregate.coverageReasons, ['transport-failures']);
  assert.equal(report.aggregate.partialLineOk, null, 'zero scored records is vacuously vacuous, never a pass');
  assert.equal(report.aggregate.partialLineZeroReason, null);
  assert.equal(report.aggregate.syntheticTokens, 10 * 1001);
  assert.equal(report.aggregate.providerTokens, 0);
  assert.equal(report.aggregate.estimatedTokens, 0);
  assert.match(report.caveat, /successOnly: true/);
});

test('a stub transport failure charges 0, is success-only and exits 1', { skip }, (t) => {
  const out = tempDir();
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [SCRIPT, '--transport', 'stub', '--i-am-the-owner',
    '--stub-fail', 'transport-error', '--token-grant', '100000000', '--kill-ms', '180000', '--out', out],
  { encoding: 'utf8', timeout: 600000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'replay-opencode-asks-stub.json'), 'utf8'));
  assert.equal(report.records.length, 10);
  for (const record of report.records) {
    assert.equal(record.ok, false);
    assert.equal(record.error, 'non-2xx');
    assert.equal(record.chargedTokens, 0, 'no usage was stated, so nothing is charged');
  }
  assert.equal(report.aggregate.failures, 10);
  assert.equal(report.aggregate.successOnly, true);
  assert.equal(report.aggregate.coverageLimited, true);
  assert.deepEqual(report.aggregate.coverageReasons, ['transport-failures']);
  assert.equal(report.aggregate.syntheticTokens, 0);
  assert.equal(report.aggregate.providerTokens, 0);
  assert.equal(report.aggregate.estimatedTokens, 0);
});

const RERUN = path.resolve(HERE, '..', '..', 'scratchpad', 'launch',
  '2026-11-23-replay-opencode-asks-live-2', 'replay-opencode-asks-deepseek.json');
const skipRerun = hasWorld && fs.existsSync(RERUN)
  ? false : `input absent: ${RERUN} (scratchpad/ is disposable by law)`;

test('--live recomputes the stored rerun without touching it and prices partials', { skip: skipRerun }, (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'replay-opencode-asks-deepseek.json');
  fs.copyFileSync(RERUN, file);
  const before = fs.readFileSync(file);
  const run = spawnSync(process.execPath, [SCRIPT, '--live', file], { encoding: 'utf8', timeout: 600000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /LIVE RECOMPUTE/);
  assert.doesNotMatch(run.stdout, /DEEPSEEK_API_KEY/);
  assert.deepEqual(fs.readFileSync(file), before, 'the stored evidence file is byte-identical after');
  const outFile = path.join(dir, 'replay-opencode-asks-deepseek-recomputed.json');
  assert.ok(fs.existsSync(outFile), 'the corrected report is written beside the source');
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(report.mode, 'live-recompute');
  assert.equal(report.aggregate.sends, 0, 'a recompute sends nothing');
  assert.ok(report.records.every((record) => record.sends === 0));
  // seg9's stored answer refused every row, so it is a failedReading: named and
  // kept out of the totalled nine.
  assert.equal(report.aggregate.scored, 9);
  assert.equal(report.aggregate.failedReadings, 1);
  assert.deepEqual(report.aggregate.allRefusedMoments, ['run-3/opencode-seg9-t j4845']);
  assert.equal(report.aggregate.oldUnits, 307);
  assert.equal(report.aggregate.oldBytes, 835513);
  assert.equal(report.aggregate.oldBytesDecoded, 679440);
  assert.equal(report.aggregate.newUnits, 380, '357 forgetall + 23 partial keeps');
  assert.equal(report.aggregate.newBytes, 973748, '885,089 B whole + 88,659 B partial');
  assert.equal(report.aggregate.partialLineBytesFreed, 88659);
  assert.equal(report.aggregate.partialLineRows, 23);
  assert.equal(report.aggregate.keptBytes, 90498);
  assert.equal(report.aggregate.accountedOk, true);
  assert.equal(report.aggregate.pricedOk, true);
  assert.equal(report.aggregate.partialLineOk, true);
  assert.equal(report.storedAggregate.newUnits, 357);
  assert.equal(report.storedAggregate.partialLineBytesFreed, 0, 'the stored lane priced no partial');
  const changed = report.differences.filter((row) => row.changedBytes).map((row) => row.moment);
  assert.deepEqual(changed, [
    'run-1/opencode-seg1-t j166',
    'run-1/opencode-seg2-t j7557',
    'run-3/opencode-seg1-t j139',
    'run-3/opencode-seg4-t j17780',
  ], 'only the moments that answered a partial keep change');
  assert.deepEqual(report.differences.filter((row) => row.changedUnits).map((row) => row.moment), changed);
  assert.deepEqual(report.differences.filter((row) => row.failedReading).map((row) => row.moment),
    ['run-3/opencode-seg9-t j4845'], 'the all-refused moment is labelled, not counted as a zero');
});
