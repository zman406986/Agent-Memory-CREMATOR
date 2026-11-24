#!/usr/bin/env node
/**
 * The removal rule: the body proves the unit is gone AND the surviving twin is
 * still there.
 *
 * Three things are pinned here:
 *   (a) the rule reads the request body, not the receipt: a request with no
 *       receipt whose body has lost the bytes passes, and a request whose body
 *       still carries them fails even when it also carries a receipt;
 *   (b) a request with no captured body proves nothing;
 *   (c) the OpenCode adapter path itself: a host that rebuilds every request
 *       from its own store gets the removal on every rebuilt request, and the
 *       array a pass left is inert.
 *
 * Offline only: the adapter probe runs in this process's child with a ledger in
 * memory. No host binary, no API key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHash } from 'node:crypto';

import {
  countStrings, isAdapterReceiptMessage, isReceiptMessage, rawBodyAbsenceVerdict, removalBodies,
  removalAbsenceScopeLabel, sentinelResultCarriers, stringsOf,
} from './removal-bodies.mjs';
import {
  countReceiptRecallIds, isReceiptMessage as mockIsReceiptMessage,
} from './opencode-mock-model.mjs';
import { receiptLineText, receiptRecallIds, RECEIPT_LINE_MAX_CHARS } from './receipt-line.mjs';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(BENCH_DIR));
const PROBE = join(BENCH_DIR, 'removal-bodies-adapter.ts');
const HOOK = pathToFileURL(join(REPO_ROOT, 'scripts', 'ts-resolve-hooks.mjs')).href;

/** One 2.4.0-shaped tool message carrying `text` as its result. */
function toolBody(text) {
  return [{
    role: 'tool',
    content: [{ type: 'tool-result', id: 'call_1', name: 'read',
      result: { type: 'text', value: text } }],
  }];
}

/** One receipt message, in the adapter's own shape. */
function receiptMessage() {
  return {
    id: 'racoons-record:intent-1:0',
    role: 'user',
    content: [{ type: 'text', text: '[not retained] NOTES.md · necromancy recall:sha256:abc' }],
    racoonsRecordId: 'racoons-record:intent-1:0',
  };
}

/** Run one adapter probe in a child with the repo's TypeScript resolve hook. */
function probe() {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings', '--import', HOOK, PROBE,
  ], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.status, 0, `the adapter probe failed:\n${result.stderr}`);
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  assert.ok(last !== undefined, 'the adapter probe printed a result');
  return JSON.parse(last);
}

test('removal bodies: a request without a receipt is not a lost removal when the bytes are gone', () => {
  // The old receipt count called this a break: request 1 carries a receipt,
  // request 2 has none. The body says both lost the bytes, so both are correct.
  const verdict = removalBodies([
    { seq: 1, messages: [{ role: 'assistant', content: 'read it' }], receipt_messages: 1 },
    { seq: 2, messages: [{ role: 'assistant', content: 'done' }], receipt_messages: 0 },
  ], 'REMOVED-BYTES');
  assert.equal(verdict.pass, true, verdict.statement);
  assert.deepEqual(verdict.perRequest.map((row) => row.carriesRemoved), [false, false]);
  assert.equal(verdict.perRequest[1].receiptMessages, 0);
});

test('removal bodies: a receipt alone proves nothing — the body contradicts it', () => {
  const verdict = removalBodies([
    { seq: 3, messages: [...toolBody('REMOVED-BYTES'), receiptMessage()], receipt_messages: 1 },
  ], 'REMOVED-BYTES');
  assert.equal(verdict.pass, false);
  assert.match(verdict.statement, /request 3/u);
  assert.match(verdict.statement, /receipt claims a removal the body contradicts/u);
});

test('removal bodies: a request with no captured body fails by name, never passes vacuously', () => {
  const verdict = removalBodies([{ seq: 7, receipt_messages: 0 }], 'REMOVED-BYTES');
  assert.equal(verdict.pass, false);
  assert.match(verdict.statement, /request 7 .*carries no request body/u);
  assert.equal(removalBodies([
    { seq: 1, messages: [{ role: 'user', content: 'x' }] },
  ], []).pass, false, 'an empty removed list is not a vacuous pass');
});

test('removal bodies: a receipt-shaped message carrying the removed bytes fails', () => {
  // The predicate accepts this message on its marker field alone, and the old
  // scan excluded every accepted message whole — so the removed bytes were
  // invisible. The receipt's own line is still allowed; its other strings are not.
  const carrying = {
    id: 'racoons-record:intent-2:0',
    role: 'user',
    racoonsRecordId: 'racoons-record:intent-2:0',
    content: [{ type: 'text', text: 'REMOVED-BYTES' }],
  };
  const verdict = removalBodies([
    { seq: 5, messages: [carrying], receipt_messages: 1 },
  ], 'REMOVED-BYTES');
  assert.equal(verdict.pass, false);
  assert.match(verdict.statement, /request 5 .*removed bytes are still/u);

  // A second content part on a real receipt is scanned too.
  const receiptWithTail = {
    ...receiptMessage(),
    content: [
      { type: 'text', text: '[not retained] NOTES.md · necromancy recall:sha256:abc' },
      { type: 'text', text: 'REMOVED-BYTES' },
    ],
  };
  assert.equal(removalBodies([
    { seq: 6, messages: [receiptWithTail], receipt_messages: 1 },
  ], 'REMOVED-BYTES').pass, false);

  // The product's own line is allowed, even when it names the removed unit.
  const own = removalBodies([
    { seq: 7, messages: [receiptMessage()], receipt_messages: 1 },
  ], 'recall:sha256:abc');
  assert.equal(own.pass, true, own.statement);

  // A "receipt line" longer than the product can render is a named failure: that
  // is where removed bytes could hide inside the one part a receipt may carry.
  const oversized = {
    id: 'racoons-record:intent-3:0',
    role: 'user',
    racoonsRecordId: 'racoons-record:intent-3:0',
    content: [{
      type: 'text',
      text: `[not retained] ${'x'.repeat(RECEIPT_LINE_MAX_CHARS)} · necromancy recall:sha256:abc`,
    }],
  };
  const tooLong = removalBodies([
    { seq: 8, messages: [oversized], receipt_messages: 1 },
  ], 'NOT-PRESENT');
  assert.equal(tooLong.pass, false);
  assert.match(tooLong.statement, /receipt line is \d+ chars/u);
  // The same receipt at the product's bound is accepted as the product's line.
  const atBound = {
    ...oversized,
    content: [{
      type: 'text',
      text: `[not retained] ${'x'.repeat(RECEIPT_LINE_MAX_CHARS - 46)} · necromancy recall:sha256:abc`,
    }],
  };
  assert.equal(removalBodies([
    { seq: 9, messages: [atBound], receipt_messages: 1 },
  ], 'NOT-PRESENT').pass, true);
});

test('removal bodies: the adapter loses the removed unit on every rebuilt request', () => {
  const captured = probe();
  assert.ok(captured.forgotten !== null, 'the probe names the unit the rule burns');
  assert.equal(typeof captured.removedUnit, 'string');

  const verdict = removalBodies(captured.requests, captured.removedUnit, {
    survives: [captured.survivingUnit, captured.sentinel],
  });
  assert.equal(verdict.pass, true, verdict.statement);
  assert.equal(verdict.perRequest.length, 4);
  assert.equal(verdict.perRequest.every((row) => row.carriesSurviving), true,
    'every rebuilt request carries the surviving twin');

  // The defect in one assertion: request 2 is the host's rebuilt original, and
  // its body must not carry the removed unit's own call id outside the receipt.
  const nonReceipt = captured.requests[1].messages.filter((message) =>
    typeof message.racoonsRecordId !== 'string'
    && !(typeof message.id === 'string' && message.id.startsWith('racoons-record:')));
  assert.equal(JSON.stringify(nonReceipt).includes(captured.removedUnit), false,
    'the rebuilt request no longer carries the removed unit');
  assert.equal(captured.requests[1].receipt_messages, 1,
    'the rebuilt request carries exactly one receipt');
  assert.equal(captured.requests[0].receipt_messages, 1,
    'the first request carries exactly one receipt');

  // The post-apply array sent twice: the probe says both hooks left it alone.
  assert.equal(captured.postApplyUnchanged, true,
    'the post-apply array is inert under repeated hooks');
  assert.equal(captured.requests[3].receipt_messages, 1, 'no second receipt was added');
});

test('removal bodies: the old count is named for what it missed', () => {
  // The old receipt count passed this and the body rejects it: a receipt is present,
  // so the count calls this request covered, while the removed unit is back.
  const captured = probe();
  const rebuiltWithUnit = {
    seq: 2,
    messages: captured.requests[1].messages.map((message) => structuredClone(message)),
    receipt_messages: 1,
  };
  rebuiltWithUnit.messages.push({
    role: 'tool',
    content: [{ type: 'tool-result', id: captured.removedUnit, name: 'read',
      result: { type: 'text', value: 'back again' } }],
  });
  const verdict = removalBodies([rebuiltWithUnit], captured.removedUnit);
  assert.equal(verdict.pass, false);
  assert.match(verdict.statement, /removed bytes are still in the request body/u);
});

/* ------------------------------------------------------------------ scan depth */

/** A value nested `depth` objects deep, so a shallow walk cannot reach the leaf. */
function nest(depth, leaf) {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) value = { nested: [value] };
  return value;
}

test('removal bodies: a marker nested deeper than the old cap is still found', () => {
  // The removed call id sits 20 objects down. The old scan returned at depth 8,
  // visited no string that carried it, and called the request clean.
  const messages = [nest(20, { role: 'tool', content: 'DEEP-MARKER' })];
  const verdict = removalBodies([{ seq: 1, messages }], 'DEEP-MARKER');
  assert.equal(verdict.pass, false, 'a shallow scan must not read as an absent marker');
  assert.match(verdict.statement, /removed bytes are still in the request body/u);
});

test('removal bodies: the scan count equals an independent walk, so a cap fails loudly', () => {
  const messages = [
    nest(12, { role: 'tool', content: 'first' }),
    { role: 'user', content: 'second' },
    { role: 'assistant', content: [{ type: 'text', text: 'third' }] },
  ];
  assert.equal(stringsOf(messages).length, countStrings(messages));
  const verdict = removalBodies([{ seq: 1, messages }], 'NOT-PRESENT');
  assert.equal(verdict.pass, true, verdict.statement);
  assert.match(verdict.statement, /every string was visited/u);
  assert.equal(verdict.perRequest[0].stringsVisited, countStrings(messages));
});

test('removal bodies: a request that lost the removed unit AND its twin fails', () => {
  // The host dropped the tail. The old rule read this as a clean removal because
  // the removed marker is absent; the twin half must name the failure, per
  // request, and pass as soon as the twin is back.
  const removed = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_unit_RS-X' }] },
    { role: 'tool', tool_call_id: 'call_unit_RS-X', content: 'REMOVED-BYTES' },
  ];
  const tailDropped = [{ role: 'user', content: 'done' }];
  const failing = removalBodies([{ seq: 9, messages: tailDropped }], 'call_unit_RS-X', {
    survives: ['call_twin', 'FILE-SENTINEL'],
  });
  assert.equal(failing.pass, false);
  assert.match(failing.statement, /request 9 the surviving twin is absent/u);
  assert.match(failing.statement, /"call_twin"/u);
  assert.match(failing.statement, /"FILE-SENTINEL"/u);
  assert.equal(failing.perRequest[0].carriesSurviving, false);
  // The same request with the twin present: unit absent, twin present, passes.
  const twinPresent = [
    { role: 'tool', tool_call_id: 'call_twin', content: 'FILE-SENTINEL still here' },
    { role: 'user', content: 'done' },
  ];
  const passing = removalBodies([{ seq: 9, messages: twinPresent }], 'call_unit_RS-X', {
    survives: ['call_twin', 'FILE-SENTINEL'],
  });
  assert.equal(passing.pass, true, passing.statement);
  assert.equal(passing.perRequest[0].carriesSurviving, true);
  assert.match(passing.statement, /every request carried the 2 surviving-twin marker/u);
  // The twin check is per request: one clean request does not hide a later one.
  const mixed = removalBodies([
    { seq: 9, messages: twinPresent },
    { seq: 10, messages: tailDropped },
  ], 'call_unit_RS-X', { survives: ['call_twin', 'FILE-SENTINEL'] });
  assert.equal(mixed.pass, false);
  assert.match(mixed.statement, /request 10 the surviving twin is absent/u);
  assert.equal(removed.length, 2, 'the removed fixture names a call and its result');
});

/* ------------------------------------------------------------------ one receipt definition */

test('receipt: the product line is recognised by the one predicate and parsed once', () => {
  const line = receiptLineText('src/a.ts', 'recall:sha256:abc', ' lines 3–9', ' — about: notes');
  assert.equal(line, '[not retained] src/a.ts lines 3–9 — about: notes · necromancy recall:sha256:abc');
  const messages = [
    { role: 'user', content: 'read the file' },
    { role: 'user', content: line },
    { role: 'user', content: 'no receipt here' },
    { role: 'user', content: [{ type: 'text', text: '[search: missing] nothing matched' }] },
  ];
  assert.deepEqual(receiptRecallIds(messages), ['recall:sha256:abc']);
  assert.deepEqual(countReceiptRecallIds(messages), ['recall:sha256:abc']);
  assert.equal(messages.filter(isReceiptMessage).length, 2);
});

test('receipt: a tool result that mentions the command word is still scanned, not hidden', () => {
  // The predicate used to call any message containing `necromancy <token>` a
  // receipt, and receipts are excluded from the body scan. A tool result that
  // quoted the command word therefore became invisible to the removal check.
  const hidden = {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'the tool printed necromancy x and the removed bytes REMOVED-BYTES',
  };
  assert.equal(isReceiptMessage(hidden), false);
  assert.equal(mockIsReceiptMessage(hidden), false);
  assert.deepEqual(receiptRecallIds([hidden]), [], 'a bare command word names no receipt');
  const verdict = removalBodies([{ seq: 1, messages: [hidden] }], 'REMOVED-BYTES');
  assert.equal(verdict.pass, false, 'the tool result must be scanned');
  assert.equal(verdict.perRequest[0].carriesRemoved, true);
  assert.equal(verdict.perRequest[0].receiptMessages, 0);
  // The prefix alone is not the receipt either: the product's marker line is
  // what makes a receipt, and this text carries none.
  assert.equal(isReceiptMessage({
    role: 'tool',
    content: '[not retained] but no marker line here',
  }), false);
  const prefixOnly = removalBodies([{
    seq: 2,
    messages: [{ role: 'tool', content: '[not retained] but the removed bytes REMOVED-BYTES remain' }],
  }], 'REMOVED-BYTES');
  assert.equal(prefixOnly.pass, false, 'a receipt-shaped prefix must not hide a tool result');
  // The parser reads the marker line only: a command word in the receipt's own
  // target/about text is not a record.
  assert.deepEqual(receiptRecallIds([{
    role: 'user',
    content: '[not retained] necromancy foo notes · necromancy recall:sha256:real',
  }]), ['recall:sha256:real']);
});

/* ------------------------------------------------------------------ audit finding 9 */

test('removal bodies: a tool result that quotes a receipt line is still scanned', () => {
  // The text shape classifies the message as a record, but only an adapter
  // record grants the scan exemption: a marker field, or the exact user wire
  // shape opencode serializes. A tool result has neither, so the line it
  // quotes — and any removed bytes beside it — stay in the scan (finding 9).
  const line = receiptLineText('NOTES.md', 'recall:sha256:abc');
  const quoted = { role: 'tool', tool_call_id: 'call_q', content: `${line} REMOVED-BYTES` };
  assert.equal(isReceiptMessage(quoted), true, 'the text shape still classifies a record');
  assert.equal(isAdapterReceiptMessage(quoted), false, 'no adapter record: not a receipt');
  const verdict = removalBodies([{ seq: 4, messages: [quoted] }], 'REMOVED-BYTES');
  assert.equal(verdict.pass, false, verdict.statement);
  assert.equal(verdict.perRequest[0].carriesRemoved, true,
    'the quoted line did not hide the removed bytes');
  assert.match(verdict.statement, /removed bytes are still in the request body/u);

  // The same text in a restored archive (an ordinary tool/assistant message)
  // is scanned too: the archive quote is not a receipt.
  const restored = { role: 'assistant', content: [{ type: 'text', text: line + '\nREMOVED-BYTES' }] };
  assert.equal(removalBodies([{ seq: 6, messages: [restored] }], 'REMOVED-BYTES').pass, false);

  // The marker is one adapter record: an adapter-inserted record is allowed to
  // name its own recall id in its own line.
  const real = {
    ...quoted,
    role: 'user',
    id: 'racoons-record:intent-9:0',
    racoonsRecordId: 'racoons-record:intent-9:0',
  };
  assert.equal(isAdapterReceiptMessage(real), true);
  const allowed = removalBodies([{ seq: 5, messages: [real] }], 'recall:sha256:abc');
  assert.equal(allowed.pass, true, allowed.statement);

  // The other adapter record is the wire shape opencode keeps: a user message
  // whose entire text is the receipt line. Its target is the product's pointer
  // to the removed unit, so naming the removed call id there is not the unit
  // still being present (the 2026-11-10 sim-gate regression).
  const callId = 'call_single_1_RS-SINGLE-UNIT';
  const wireLine = receiptLineText(`oc:ses_1:tool:${callId}`, 'recall:sha256:xyz', '',
    '', 'intent:p1');
  const wire = { role: 'user', content: wireLine };
  assert.equal(isAdapterReceiptMessage(wire), true, 'the wire shape is an adapter receipt');
  const wireVerdict = removalBodies([{ seq: 7, messages: [wire] }], callId, {
    receiptMarkers: [callId, 'RS-SINGLE-UNIT'],
    receiptContentMarkers: ['FILE-SENTINEL'],
  });
  assert.equal(wireVerdict.pass, true, wireVerdict.statement);
  assert.equal(wireVerdict.perRequest[0].carriesRemoved, false,
    'the receipt target is the product\'s pointer, not the unit still present');

  // The same exact line in a tool result is not the wire shape: it is scanned
  // whole, and the removed call id inside it counts as present.
  const sameTextTool = { role: 'tool', tool_call_id: 'call_q', content: wireLine };
  assert.equal(isAdapterReceiptMessage(sameTextTool), false);
  const toolVerdict = removalBodies([{ seq: 8, messages: [sameTextTool] }], callId, {
    receiptMarkers: [callId],
  });
  assert.equal(toolVerdict.pass, false, toolVerdict.statement);
  assert.equal(toolVerdict.perRequest[0].carriesRemoved, true);

  // A receipt line plus any other text in a user message is not the wire shape:
  // the message is scanned whole, and the removed call id in the line counts.
  const mixed = { role: 'user', content: `${wireLine}\nREMOVED-BYTES` };
  assert.equal(isAdapterReceiptMessage(mixed), false);
  const mixedVerdict = removalBodies([{ seq: 9, messages: [mixed] }], callId, {
    receiptMarkers: [callId],
  });
  assert.equal(mixedVerdict.pass, false, mixedVerdict.statement);
  assert.equal(mixedVerdict.perRequest[0].carriesRemoved, true);
});

/* ------------------------------------------------------------------ audit finding 7 */

/** The sha256 hex of a UTF-8 fragment, written here rather than imported. */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('removal bodies: a re-encoded fragment is not a byte-level proof, and the claim says so', () => {
  // The removed text is base64 in the body: neither the decoded strings nor the
  // raw body contain the fragment. The check therefore passes at decoded-string
  // level, and the claim must say that instead of implying the raw bytes are
  // absent (finding 7).
  const removed = 'REMOVED-BYTES https://example.test/path?q=1';
  const encoded = Buffer.from(removed, 'utf8').toString('base64');
  const messages = [{
    role: 'tool',
    content: [{ type: 'tool-result', id: 'call_1', result: { type: 'text', value: encoded } }],
  }];
  const row = { seq: 1, messages, raw_body_text: JSON.stringify({ messages }) };
  const verdict = removalBodies([row], removed);
  assert.equal(verdict.pass, true, verdict.statement);
  assert.equal(verdict.scope.kind, 'decoded-string');
  assert.equal(verdict.scope.rawBodyRows, 1, 'the raw body was carried and searched');
  assert.equal(verdict.scope.measured, true);
  assert.equal(verdict.scope.status, 'pass', 'the raw body is clean at the byte level');
  assert.equal(verdict.scope.pass, true);
  assert.equal(verdict.scope.fragments.length, 1);
  assert.equal(verdict.scope.fragments[0].sha256, sha256Hex(removed),
    'the claim names the exact fragment hash the search used');
  assert.match(verdict.statement, /decoded-string absence/u);
  assert.match(verdict.statement, /a re-encoded body is not covered/u);
  assert.doesNotMatch(verdict.statement, /absent from the raw body|raw-byte proof/iu,
    'the claim never says the raw bytes are absent');
});

test('removal bodies: a fragment in a JSON key is found by the raw-body search', () => {
  // The decoded scan reads values, not keys. The raw body carries the fragment
  // as a property key; without the raw search this row passes (the line below
  // proves it), with it the row fails by name.
  const removed = 'REMOVED-BYTES';
  const messages = [{ role: 'assistant', content: 'clean' }];
  const decodedOnly = removalBodies([{ seq: 3, messages }], removed);
  assert.equal(decodedOnly.pass, true, 'the decoded scan cannot see a property key');
  const raw = JSON.stringify({ messages, [removed]: 'x' });
  const verdict = removalBodies([{ seq: 3, messages, raw_body_text: raw }], removed);
  assert.equal(verdict.pass, false, verdict.statement);
  assert.match(verdict.statement, /raw request body where no decoded string explains/u);
  assert.equal(verdict.scope.unexplained[0].seq, 3);
  assert.equal(verdict.scope.measured, true, 'the raw search ran');
  assert.equal(verdict.scope.status, 'fail', 'the search found an unexplained occurrence');
  assert.equal(verdict.scope.pass, false);
});

test('removal bodies: a capture with no raw bytes records the limit, never a vacuous pass', () => {
  const verdict = removalBodies([
    { seq: 1, messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'clean' }] },
  ], 'REMOVED-BYTES');
  // The decoded-string half still passes; the raw-body half did not run, so its
  // verdict is measured:false / not-applicable and never pass.
  assert.equal(verdict.pass, true, verdict.statement);
  assert.equal(verdict.scope.rawBodyRows, 0);
  assert.equal(verdict.scope.measured, false);
  assert.equal(verdict.scope.status, 'not-applicable');
  assert.equal(verdict.scope.pass, false, 'no raw body means no raw-body pass');
  assert.match(verdict.statement, /this capture carries no raw body bytes, so no raw-body search ran/u);
  assert.match(removalAbsenceScopeLabel(verdict.scope), /decoded-string absence/u);
  // The direct verdict and the label agree, and a raw-carried row says so.
  const direct = rawBodyAbsenceVerdict([{ seq: 1, messages: [], raw_body: '{}' }], 'REMOVED-BYTES');
  assert.equal(direct.rawBodyRows, 1);
  assert.equal(direct.measured, true);
  assert.equal(direct.status, 'pass');
  assert.equal(direct.pass, true);
  assert.match(removalAbsenceScopeLabel(direct), /raw body text of all 1 request/u);
  // With no fragment named there is no subject: absent, never measured.
  const unnamed = rawBodyAbsenceVerdict([{ seq: 1, messages: [], raw_body: '{}' }], []);
  assert.equal(unnamed.measured, false);
  assert.equal(unnamed.status, 'absent');
  assert.equal(unnamed.pass, false);
  // With no fragment named there is nothing to search: the label says so
  // instead of claiming a raw-body search covered an unnamed fragment.
  assert.match(removalAbsenceScopeLabel(unnamed),
    /no removed fragment was named, so no raw-body search ran/u);
});

test('fifth audit FIX 5: the raw-body sentence says the sha256 is recorded, not searched', () => {
  // Every row carries raw text: the bytes were searched, the hash was only
  // recorded beside the sentence. Saying both were searched overstates the scan.
  const all = rawBodyAbsenceVerdict([
    { seq: 1, messages: [], raw_body: '{}' },
    { seq: 2, messages: [], raw_body: '{}' },
  ], 'REMOVED-BYTES');
  const allLabel = removalAbsenceScopeLabel(all);
  assert.match(allLabel, /UTF-8 bytes were also searched/u);
  assert.match(allLabel, /sha256 is recorded below, not searched/u);
  assert.doesNotMatch(allLabel, /searched by its UTF-8 bytes and sha256/u);
  // One of two rows carries raw text: the same wording, with the partial count.
  const partial = rawBodyAbsenceVerdict([
    { seq: 1, messages: [], raw_body: '{}' },
    { seq: 2, messages: [] },
  ], 'REMOVED-BYTES');
  const partialLabel = removalAbsenceScopeLabel(partial);
  assert.match(partialLabel, /UTF-8 bytes were also searched in the raw body text of 1 of 2/u);
  assert.match(partialLabel, /sha256 is recorded below, not searched/u);
  assert.doesNotMatch(partialLabel, /searched by its UTF-8 bytes and sha256/u);
});


/* ------------------------------------------------------------------ the sentinel count (P7) */

test('sentinel carriers: a write result that echoes its input does not count as a read copy', () => {
  // A stale-read lane writes the same path it read. The write's result can echo
  // the content it wrote, so the file sentinel appears in TWO tool results: the
  // surviving twin read and the write. Only the read result is a copy of the
  // removed read; a count that ignored the tool name would fail a lane whose
  // removal reached the model.
  const messages = [
    { role: 'assistant', tool_calls: [
      { id: 'call_removed', function: { name: 'read' } },
      { id: 'call_write', function: { name: 'write' } },
      { id: 'call_twin', function: { name: 'read' } },
    ] },
    { role: 'tool', tool_call_id: 'call_removed', content: 'SENTINEL old body' },
    { role: 'tool', tool_call_id: 'call_write', content: 'SENTINEL wrote this' },
    { role: 'tool', tool_call_id: 'call_twin', content: 'SENTINEL new body' },
  ];
  // The script issued `call_write` under a non-read tool, so its echo may be
  // excluded; `call_removed` and `call_twin` were issued as reads.
  const excludedIds = ['call_write'];
  const split = sentinelResultCarriers(messages, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: excludedIds });
  assert.deepEqual(split.carriers.map((row) => [row.callId, row.toolName]),
    [['call_removed', 'read'], ['call_twin', 'read']]);
  assert.deepEqual(split.excluded.map((row) => [row.callId, row.toolName]),
    [['call_write', 'write']]);
  assert.deepEqual(split.unattributed, []);
  // The tool name comes from the request's own declaration, not a list here.
  assert.deepEqual(split.names, {
    call_removed: 'read', call_write: 'write', call_twin: 'read',
  });

  // At the point the removal is measured only the twin's read result is left,
  // and the write's echo must not make the count two.
  const measured = [
    messages[0],
    messages[2],
    messages[3],
  ];
  const after = sentinelResultCarriers(measured, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: excludedIds });
  assert.equal(after.carriers.length, 1, 'one read result carries the sentinel');
  assert.equal(after.excluded.length, 1, 'the write echo is excluded by tool name');
  assert.equal(after.carriers.length + after.unattributed.length, 1,
    'the read-side count is one, so the lane is not failed by the write echo');

  // A call id the script did not issue under a non-read tool is not the
  // script's write echo. Its declared name is not trusted: a re-keyed removed
  // result labelled `write` would otherwise be excluded and the second copy
  // would be invisible.
  const rekeyedAsWrite = [
    { role: 'assistant', tool_calls: [
      { id: 'call_rekeyed', function: { name: 'write' } },
      { id: 'call_twin', function: { name: 'read' } },
    ] },
    { role: 'tool', tool_call_id: 'call_rekeyed', content: 'SENTINEL re-keyed bytes' },
    { role: 'tool', tool_call_id: 'call_twin', content: 'SENTINEL twin bytes' },
  ];
  const unissued = sentinelResultCarriers(rekeyedAsWrite, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: excludedIds });
  assert.equal(unissued.excluded.length, 0, 'an unissued call id is never excluded');
  assert.deepEqual(unissued.unattributed.map((row) => [row.callId, row.toolName]),
    [['call_rekeyed', 'write']]);
  assert.equal(unissued.carriers.length + unissued.unattributed.length, 2,
    'the re-keyed copy is counted, so the lane fails on two carriers');
  // A call id the script issued as a READ, declared `write` in the request, is
  // not an echo either: the exclusion set names non-read issuances only.
  const readIssuedAsWrite = [
    { role: 'assistant', tool_calls: [
      { id: 'call_removed', function: { name: 'write' } },
      { id: 'call_twin', function: { name: 'read' } },
    ] },
    { role: 'tool', tool_call_id: 'call_removed', content: 'SENTINEL labelled write' },
    { role: 'tool', tool_call_id: 'call_twin', content: 'SENTINEL twin bytes' },
  ];
  const relabelled = sentinelResultCarriers(readIssuedAsWrite, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: excludedIds });
  assert.equal(relabelled.excluded.length, 0);
  assert.equal(relabelled.unattributed.length, 1);
  assert.equal(relabelled.unattributed[0].callId, 'call_removed');
  // With no excluded list at all, a name alone excludes nothing: the safe reading.
  const noList = sentinelResultCarriers(messages, 'SENTINEL', { toolNames: ['read'] });
  assert.equal(noList.excluded.length, 0);
  assert.equal(noList.carriers.length + noList.unattributed.length, 3);

  // An unattributable carrier is counted, never dropped: a call id that names no
  // tool cannot be proven not to be the removed read.
  const orphan = [
    { role: 'tool', tool_call_id: 'call_orphan', content: 'SENTINEL no declaration' },
  ];
  const orphaned = sentinelResultCarriers(orphan, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: excludedIds });
  assert.equal(orphaned.carriers.length, 0);
  assert.equal(orphaned.unattributed.length, 1);
  assert.equal(orphaned.unattributed[0].toolName, null);
});

test('sentinel carriers: a second result under a script-issued write id is counted (P2)', () => {
  // The shipped fixture issues `call_stale_write` as a write. A removed read
  // re-keyed to that id arrives beside the write's own echo, so the request holds
  // TWO results under a call id the script did issue as a non-read tool. The
  // earlier rule excluded any result under such an id, so the re-keyed copy was
  // invisible and the count stayed one.
  const messages = [
    { role: 'assistant', tool_calls: [
      { id: 'call_write', function: { name: 'write' } },
      { id: 'call_twin', function: { name: 'read' } },
    ] },
    { role: 'tool', tool_call_id: 'call_write', content: 'SENTINEL the write echo' },
    { role: 'tool', tool_call_id: 'call_write', content: 'SENTINEL the re-keyed removed body' },
    { role: 'tool', tool_call_id: 'call_twin', content: 'SENTINEL the surviving twin' },
  ];
  const failing = sentinelResultCarriers(messages, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: ['call_write'] });
  // One call has one result: only the first marker-carrying result under the
  // write id is the call's own, and the second is a read-side carrier.
  assert.equal(failing.excluded.length, 1, 'the write\'s own result is excluded');
  assert.deepEqual(failing.excluded.map((row) => row.callId), ['call_write']);
  assert.deepEqual(failing.carriers.map((row) => [row.callId, row.secondUnderCallId ?? false]),
    [['call_write', true], ['call_twin', false]]);
  assert.equal(failing.carriers.length + failing.unattributed.length, 2,
    'two carriers (the re-keyed copy and the twin), so the lane count fails');
  // With the write's own echo only, the count is one again: the exclusion still
  // works for the legitimate echo, so the fix does not fail a clean removal.
  const ownEchoOnly = [messages[0], messages[1], messages[3]];
  const passing = sentinelResultCarriers(ownEchoOnly, 'SENTINEL',
    { toolNames: ['read'], excludedCallIds: ['call_write'] });
  assert.equal(passing.excluded.length, 1);
  assert.equal(passing.carriers.length + passing.unattributed.length, 1,
    'the surviving twin is the only read-side carrier');
  assert.equal(passing.carriers[0].callId, 'call_twin');
});
