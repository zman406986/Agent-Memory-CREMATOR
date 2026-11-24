/**
 * The sim fixture's own gate (ISSUE-059 T-2).
 *
 * Run: `node --test dev/bench/fixtures/sim/sim-fixture.test.mjs`
 *
 * It holds four things the plan's T-2 acceptance names, and nothing else:
 *
 *   1. the seven moment classes are all present, and the two `forget-with-partials`
 *      shapes are a LEAD gap and a MULTI gap (one marker, three markers);
 *   2. the converter's `compositionRules` reproduce `expected-composition.json`
 *      EXACTLY, applied by the parser below — which reads the transcript directly
 *      and never runs `live-convert.mjs`, so a bug in the converter cannot hide
 *      behind a fixture that agrees with it;
 *   3. a rebuild into a fresh directory is byte-identical, and the committed files
 *      match `sha256.txt`;
 *   4. one mutated kept line and one mutated marker byte each redden a NAMED
 *      failure, so the pin is not vacuous.
 *
 * The parser is deliberately a second implementation, built from the shipped
 * marker templates and receipt renderer (never from the converter's own parsing
 * helpers), so `markerBytes`, `kept` and `summary` are measured twice.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { receiptLine, SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE } from '@cremator/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const BUILDER = join(HERE, 'build-fixture.mjs');
const CONVERTER = join(REPO_ROOT, 'dev', 'bench', 'multiturn', 'live-convert.mjs');
const TRANSCRIPT = join(HERE, 'sim.session.v4.jsonl');
const CONTROL = join(HERE, 'sim-control.session.v4.jsonl');
const MANIFEST = join(HERE, 'manifest.json');
const EXPECTED = join(HERE, 'expected-composition.json');
const SHA_FILE = join(HERE, 'sha256.txt');
const FILES = ['expected-composition.json', 'manifest.json', 'sha256.txt',
  'sim.session.v4.jsonl', 'sim-control.session.v4.jsonl', 'build-fixture.mjs',
  'README.md', '.gitattributes'];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytesOf = text => Buffer.from(text, 'utf8');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------
// The independent parser
// ---------------------------------------------------------------------------

/** The text a message-shaped row carries, joined in part order. */
function textOf(row) {
  const content = row.data?.message?.content;
  if (Array.isArray(content)) {
    return content.filter(part => part.type === 'text').map(part => part.text).join('');
  }
  const parts = row.data?.content;
  if (!Array.isArray(parts)) return '';
  return parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A regex for one shipped marker template, built by walking its `<slot>` names.
 * `<ranges>` accepts the en-dash and the ASCII hyphen, as the renderer emits the
 * en-dash and a hand-edited line may carry either.
 */
function markerMatcher(template) {
  const slots = ['<ranges>', '<N>', '<B>', '<id>'];
  const parts = [];
  let cursor = 0;
  const found = slots.map(slot => ({ slot, at: template.indexOf(slot) }))
    .filter(piece => piece.at >= 0).sort((left, right) => left.at - right.at);
  for (const { slot, at } of found) {
    parts.push(escapeRegExp(template.slice(cursor, at)));
    parts.push(slot === '<ranges>' ? '(?<ranges>[0-9,\\s\\u2013-]+)'
      : slot === '<N>' ? '(?<total>\\d+)'
        : slot === '<B>' ? '(?<dropped>\\d+)'
          : '(?<recallId>[^\\s]+)');
    cursor = at + slot.length;
  }
  parts.push(escapeRegExp(template.slice(cursor)));
  return new RegExp(parts.join(''), 'g');
}

const MARKER_FULL = markerMatcher(SHAPE_MARKER_TEMPLATE);
const MARKER_EMPTY = markerMatcher(SHAPE_MARKER_EMPTY_TEMPLATE);

/** The literal parts of a receipt line, read off two probe renders. */
const RECEIPT = (() => {
  const PATH = '\u0000PATH\u0000';
  const ID = '\u0000ID\u0000';
  const rendered = receiptLine({ path: PATH, ranges: [], label: null, recallId: ID });
  const at = rendered.indexOf(PATH);
  const after = rendered.slice(at + PATH.length);
  return {
    prefix: rendered.slice(0, at),
    separator: after.slice(0, after.indexOf(ID)),
    pattern: new RegExp(`^${escapeRegExp(rendered.slice(0, at))}(?<target>.+?)`
      + `${escapeRegExp(after.slice(0, after.indexOf(ID)))}(?<recallId>\\S+)$`, 'u'),
  };
})();

/** Every marker line in a body, in body order; empty and full forms together. */
function markersIn(text) {
  const found = [];
  for (const match of text.matchAll(new RegExp(MARKER_FULL.source, 'g'))) {
    found.push({
      index: match.index, text: match[0], empty: false,
      ranges: parseRanges(match.groups.ranges), totalLines: Number(match.groups.total),
      droppedBytes: Number(match.groups.dropped), recallId: match.groups.recallId,
    });
  }
  for (const match of text.matchAll(new RegExp(MARKER_EMPTY.source, 'g'))) {
    found.push({
      index: match.index, text: match[0], empty: true, ranges: [],
      totalLines: Number(match.groups.total), droppedBytes: null, recallId: match.groups.recallId,
    });
  }
  return found.sort((left, right) => left.index - right.index);
}

/** `1–3, 7` as line spans; null when the slot is not a range list. */
function parseRanges(slot) {
  const ranges = [];
  for (const chunk of slot.split(',')) {
    const piece = chunk.trim();
    if (piece.length === 0) continue;
    const match = /^(\d+)(?:\s*[\u2013-]\s*(\d+))?$/.exec(piece);
    if (match === null) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) return null;
    ranges.push({ startLine: start, endLineInclusive: end });
  }
  return ranges.length === 0 ? null : ranges;
}

/** The line spans of a body, as byte offsets. */
function lineOffsets(bytes) {
  const offsets = [];
  let startByte = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      offsets.push({ startByte, endByteExclusive: index + 1 });
      startByte = index + 1;
    }
  }
  if (startByte < bytes.length) offsets.push({ startByte, endByteExclusive: bytes.length });
  return offsets;
}

/** The bytes a kept-line selection covers, or null when a line is out of range. */
function keptBytesOf(original, ranges) {
  const offsets = lineOffsets(original);
  let total = 0;
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLineInclusive; line += 1) {
      const offset = offsets[line - 1];
      if (offset === undefined) return null;
      total += offset.endByteExclusive - offset.startByte;
    }
  }
  return total;
}

/**
 * The parser's whole reading of the transcript: every landed result, the class
 * the six rules assign it, and — for a shaped row — its five render terms.
 */
export function parseFixture({ transcript = TRANSCRIPT, floor }) {
  const rows = readFileSync(transcript, 'utf8')
    .split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line));
  const replaces = rows.filter(row => row.surfaceOp !== undefined
    && typeof row.surfaceOp === 'object');
  const landed = rows.filter(row => row.type === 'tool/result' && row.surfaceOp === 'append');
  const landedSeqs = landed.map(row => row.seq);

  // The lanes, exactly as the surface model states them: a replace over a span
  // is a rewind; a same-seq replace is shaped (marker) or at-rest (receipt).
  const rewinds = [];
  const shapedBySeq = new Map();
  const atRestBySeq = new Map();
  for (const row of replaces) {
    const op = row.surfaceOp;
    if (op.startSeq !== op.endSeq) { rewinds.push(row); continue; }
    const body = textOf(row);
    const found = markersIn(body);
    if (found.length > 0) { shapedBySeq.set(op.startSeq, { row, markers: found, body }); continue; }
    const receipt = body.includes('\n') ? null : RECEIPT.pattern.exec(body);
    if (receipt !== null) {
      atRestBySeq.set(op.startSeq, {
        row, body, target: receipt.groups.target, recallId: receipt.groups.recallId,
      });
      continue;
    }
    throw new Error(`unclassified-replace: seq ${row.seq} is neither a marker nor a receipt`);
  }

  // The rewind that follows a landed result and opens before the next one. A
  // rewind at a landed seq is a forget's exchange rewind, never a keep-all.
  const rewindFor = seq => {
    const nextLanded = landedSeqs.find(other => other > seq) ?? Infinity;
    return rewinds.find(row => row.surfaceOp.startSeq > seq
      && row.surfaceOp.startSeq < nextLanded
      && !landedSeqs.includes(row.surfaceOp.startSeq)) ?? null;
  };

  const moments = landed.map(row => {
    const original = bytesOf(textOf(row));
    const shaped = shapedBySeq.get(row.seq) ?? null;
    const atRest = atRestBySeq.get(row.seq) ?? null;
    const rewind = rewindFor(row.seq);
    const base = {
      seq: row.seq, step: row.data?.step ?? null, bytes: original.length,
      originalSha256: sha256(original),
      class: null, keptBytes: null, gaps: 0, markerBytes: 0, summaryBytes: 0,
      framingBytes: null, droppedBytes: 0, recallId: null, ranges: null,
    };
    if (original.length < floor) return { ...base, class: 'below-floor' };
    if (atRest !== null) {
      return { ...base, class: 'machinery-censored', recallId: atRest.recallId,
        receiptTarget: atRest.target };
    }
    if (shaped !== null) {
      const first = shaped.markers[0];
      const markerBytes = bytesOf(first.text).length;
      const ranges = first.empty ? [] : first.ranges;
      const kept = keptBytesOf(original, ranges);
      if (kept === null) throw new Error(`marker-names-missing-line: seq ${row.seq}`);
      const dropped = first.empty ? original.length - kept : first.droppedBytes;
      if (dropped !== original.length - kept) {
        throw new Error(`marker-arithmetic-mismatch: seq ${row.seq} says ${dropped},`
          + ` the original holds ${original.length} - ${kept}`);
      }
      // The summary is the first line plus one blank line, when the body opens
      // with exactly that; otherwise there is no summary prefix.
      const newline = shaped.body.indexOf('\n');
      const summary = newline > 0 && shaped.body[newline + 1] === '\n'
        ? bytesOf(`${shaped.body.slice(0, newline)}\n\n`).length : 0;
      const framing = bytesOf(shaped.body).length - kept
        - shaped.markers.length * markerBytes - summary;
      if (framing < 0) throw new Error(`framing-negative: seq ${row.seq} is ${framing}`);
      // Where the gaps sit, read from the output: a marker before the first kept
      // line's text is a LEAD gap, one after the last kept line's text is a
      // TRAILING gap. The kept text is taken from the original's own lines.
      const offsets = lineOffsets(original);
      const lineText = line => {
        const offset = offsets[line - 1];
        return offset === undefined ? null
          : original.slice(offset.startByte, offset.endByteExclusive).toString('utf8');
      };
      const firstKept = ranges.length === 0 ? null : lineText(ranges[0].startLine);
      const lastKept = ranges.length === 0 ? null : lineText(ranges[ranges.length - 1].endLineInclusive);
      const leadingGap = firstKept === null
        ? true
        : shaped.markers[0].index < shaped.body.indexOf(firstKept);
      const trailingGap = lastKept === null
        ? true
        : shaped.markers[shaped.markers.length - 1].index > shaped.body.lastIndexOf(lastKept);
      return {
        ...base,
        class: first.empty ? 'forget-all' : 'forget-with-partials',
        keptBytes: kept, gaps: shaped.markers.length, markerBytes, summaryBytes: summary,
        framingBytes: framing, droppedBytes: dropped, recallId: first.recallId, ranges,
        markerCountDistinct: new Set(shaped.markers.map(marker => marker.text)).size,
        leadingGap, trailingGap,
      };
    }
    if (rewind !== null) {
      return { ...base, class: 'keepall', keepallVia: 'surface-rewind',
        rewindSpan: { startSeq: rewind.surfaceOp.startSeq, endSeq: rewind.surfaceOp.endSeq } };
    }
    return { ...base, class: 'ask-failed-fail-open' };
  });

  const table = {
    keepall: 0, 'forget-with-partials': 0, 'forget-all': 0,
    'ask-failed-fail-open': 0, 'below-floor': 0, 'machinery-censored': 0,
  };
  for (const moment of moments) table[moment.class] += 1;
  return { rows: rows.length, moments, table };
}

/**
 * The converter's `compositionRules`, read from its source. The fixture stores a
 * copy, so this proves the copy is still the converter's own.
 */
function converterRules() {
  const source = readFileSync(CONVERTER, 'utf8');
  const block = /const compositionRules = (\{[\s\S]*?\n {2}\});/.exec(source);
  assert.ok(block !== null, 'the converter no longer states a compositionRules block');
  return new Function('opts', `return ${block[1]};`)({ floor: 1280 });
}

const EXPECTED_JSON = readJson(EXPECTED);
const MANIFEST_JSON = readJson(MANIFEST);
const PARSED = parseFixture({ floor: EXPECTED_JSON.floor });
const byName = name => PARSED.moments.find(moment => moment.name === name);

// ---------------------------------------------------------------------------
// 1. the seven required moments
// ---------------------------------------------------------------------------

test('the fixture holds every required moment class', () => {
  assert.equal(EXPECTED_JSON.floor, 1280);
  const names = new Set(EXPECTED_JSON.moments.map(moment => moment.name));
  for (const name of ['lead-gap', 'multi-gap', 'forget-all', 'keepall',
    'machinery', 'ask-failed-fail-open', 'below-floor']) {
    assert.ok(names.has(name), `moment ${name} is absent from expected-composition.json`);
  }
  // At least seven moments, and the table has a nonzero count for every class.
  assert.ok(PARSED.moments.length >= 7, `only ${PARSED.moments.length} landed moments`);
  for (const [name, count] of Object.entries(PARSED.table)) {
    assert.ok(count > 0, `class ${name} has no moment (${count})`);
  }
});

test('one forget-with-partials is a lead gap and one is a multi gap', () => {
  const partial = PARSED.moments.filter(moment => moment.class === 'forget-with-partials');
  assert.ok(partial.length >= 2, `expected two forget-with-partials, found ${partial.length}`);
  const lead = partial.filter(moment => moment.gaps === 1 && moment.leadingGap);
  const multi = partial.filter(moment => moment.gaps >= 3);
  assert.equal(lead.length, 1, 'no single LEAD-gap forget-with-partials row');
  assert.ok(multi.length >= 1, 'no MULTI-gap forget-with-partials row');
  // A multi-gap body's markers are one rendered line repeated, never two forms.
  for (const moment of partial) {
    assert.equal(moment.markerCountDistinct, 1, `moment ${moment.seq} carries two marker forms`);
  }
  // The third partial shape: the marker sits after the kept lines.
  const trailing = partial.filter(moment => moment.gaps === 1 && moment.trailingGap);
  assert.equal(trailing.length, 1, 'no single TRAILING-gap forget-with-partials row');
});

test('the keepall is an ask rewind with no shaped sibling', () => {
  const keepall = PARSED.moments.filter(moment => moment.class === 'keepall');
  assert.equal(keepall.length, 1);
  assert.equal(keepall[0].keepallVia, 'surface-rewind');
  assert.ok(keepall[0].rewindSpan.startSeq > keepall[0].seq, 'the rewind does not follow the result');
  assert.ok(keepall[0].rewindSpan.endSeq > keepall[0].rewindSpan.startSeq,
    'the rewind covers no answer turn');
});

test('the machinery receipt is one whole-body receipt line, not a decision', () => {
  const censored = PARSED.moments.filter(moment => moment.class === 'machinery-censored');
  assert.equal(censored.length, 1);
  assert.match(censored[0].recallId, /^recall:sha256:[0-9a-f]{64}$/);
  // A receipt unit has no render terms and no composition: it is censored, not
  // scored, so every shaped term stays null.
  assert.equal(censored[0].keptBytes, null);
  assert.equal(censored[0].gaps, 0);
});

test('the below-floor landed row is under the floor and is no unit', () => {
  const below = PARSED.moments.filter(moment => moment.class === 'below-floor');
  assert.equal(below.length, 1);
  assert.ok(below[0].bytes < EXPECTED_JSON.floor, `${below[0].bytes} B is not under the floor`);
  assert.equal(EXPECTED_JSON.units, PARSED.moments.length - 1);
});

// ---------------------------------------------------------------------------
// 2. the converter's rules, applied independently
// ---------------------------------------------------------------------------

test('the stored compositionRules are still the converter\'s own block', () => {
  assert.deepEqual(EXPECTED_JSON.compositionRules, converterRules(),
    'expected-composition.json carries a compositionRules copy that has drifted');
  assert.deepEqual(Object.keys(EXPECTED_JSON.compositionRules).sort(),
    ['ask-failed-fail-open', 'below-floor', 'forget-all', 'forget-with-partials',
      'keepall', 'machinery-censored']);
});

test('the independent parser reproduces expected-composition.json exactly', () => {
  assert.deepEqual(PARSED.table, EXPECTED_JSON.compositionTable,
    'the transcript no longer composes to the pinned table');
  assert.deepEqual(PARSED.table, MANIFEST_JSON.pins.compositionTable,
    'manifest.pins disagrees with expected-composition.json');
  // The decision census excludes the floor's own line and the receipt lane, as
  // the converter's `compositions` block does: a censored row is no decision.
  const decisions = {};
  for (const name of ['keepall', 'forget-with-partials', 'forget-all', 'ask-failed-fail-open']) {
    const count = PARSED.moments.filter(moment => moment.class === name).length;
    if (count > 0) decisions[name] = count;
  }
  assert.deepEqual(EXPECTED_JSON.compositions, decisions,
    'the expected file\'s decision census disagrees with the parser');
  assert.deepEqual(EXPECTED_JSON.censoring, {
    'below-floor': PARSED.moments.filter(moment => moment.class === 'below-floor').length,
    'machinery-censored': PARSED.moments.filter(moment =>
      moment.class === 'machinery-censored').length,
  }, 'the expected file\'s censoring block disagrees with the parser');
});

test('every shaped row\'s five terms match the pinned values', () => {
  const shaped = PARSED.moments.filter(moment => moment.class === 'forget-with-partials'
    || moment.class === 'forget-all');
  assert.equal(shaped.length, EXPECTED_JSON.moments.filter(moment =>
    moment.class === 'forget-with-partials' || moment.class === 'forget-all').length);
  for (const moment of shaped) {
    const pinned = EXPECTED_JSON.moments.find(entry => entry.seq === moment.seq);
    assert.ok(pinned !== undefined, `no pinned moment at seq ${moment.seq}`);
    assert.equal(moment.keptBytes, pinned.keptBytes, `kept at seq ${moment.seq}`);
    assert.equal(moment.markerBytes, pinned.markerBytes, `markerBytes at seq ${moment.seq}`);
    assert.equal(moment.summaryBytes, pinned.summaryBytes, `summary at seq ${moment.seq}`);
    assert.equal(moment.framingBytes, pinned.framingBytes, `framing at seq ${moment.seq}`);
    assert.equal(moment.droppedBytes, pinned.droppedBytes, `dropped at seq ${moment.seq}`);
    // The five-term identity closes, with framing measured rather than asserted.
    assert.equal(moment.framingBytes, 0, `framing is ${moment.framingBytes} at seq ${moment.seq}`);
  }
});

// ---------------------------------------------------------------------------
// 3. determinism and the pins
// ---------------------------------------------------------------------------

test('the committed files match sha256.txt', () => {
  const lines = readFileSync(SHA_FILE, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map(line => line.slice(66)).sort(),
    ['expected-composition.json', 'manifest.json', 'sim-control.session.v4.jsonl',
      'sim.session.v4.jsonl']);
  for (const line of lines) {
    const [digest, file] = [line.slice(0, 64), line.slice(66)];
    assert.equal(sha256(readFileSync(join(HERE, file))), digest,
      `sha256-mismatch: ${file} does not match its pin`);
  }
  assert.equal(sha256(readFileSync(TRANSCRIPT)), EXPECTED_JSON.transcriptSha256,
    'transcript-sha-mismatch: the transcript differs from the pinned bytes');
  assert.equal(sha256(readFileSync(CONTROL)), EXPECTED_JSON.controlSha256,
    'control-sha-mismatch: the control transcript differs from the pinned bytes');
});

test('the committed sanitized cuts are checked by --verify, not rebuilt from the private source', () => {
  // The reasoning and prunes cuts carry masked strings with their byte lengths
  // and line counts preserved, so a rebuild from scratchpad would write private
  // text back into the tree and could never match these pins. `--verify` is the
  // supported path, and it must pass against the bytes that are committed.
  const verified = spawnSync(process.execPath, [BUILDER, '--verify'], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /sim fixture verify: ok \(\d+ checks\)/,
    'the verifier did not report its checks');

  const refused = spawnSync(process.execPath, [BUILDER], { encoding: 'utf8' });
  assert.equal(refused.status, 2, 'a build into the committed directory must refuse');
  assert.match(refused.stderr, /build-fixture-sanitized: .*--verify is the supported path/,
    'the refusal must name --verify as the supported path');
  assert.match(refused.stderr, /--out <fresh-dir>/,
    'the refusal must name the inspection-build escape hatch');
});

test('the transcript is LF-only and the builder reaches no clock or random source', () => {
  for (const file of [TRANSCRIPT, CONTROL]) {
    assert.equal(readFileSync(file, 'utf8').includes('\r'), false, `${file} carries a CR`);
  }
  const source = readFileSync(BUILDER, 'utf8');
  for (const banned of ['Date.now', 'Math.random', 'new Date(', 'process.hrtime']) {
    assert.equal(source.includes(banned), false, `the builder calls ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// 4. the pin is not vacuous
// ---------------------------------------------------------------------------

/** One mutable copy of the fixture directory, so a mutation never lands here. */
function copyFixture() {
  const out = mkdtempSync(join(tmpdir(), 'sim-fixture-mutate-'));
  mkdirSync(out, { recursive: true });
  for (const file of ['sim.session.v4.jsonl', 'sim-control.session.v4.jsonl',
    'manifest.json', 'expected-composition.json', 'sha256.txt']) {
    copyFileSync(join(HERE, file), join(out, file));
  }
  return out;
}

test('one mutated marker byte reddens the arithmetic by name', () => {
  const out = copyFixture();
  try {
    const path = join(out, 'sim.session.v4.jsonl');
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    // The multi-gap shaped row: bump its `<B>` by one byte. The marker now claims
    // a count the original cannot support, so the arithmetic must refuse by name.
    const shaped = rows.find(row => row.type === 'tool/result'
      && typeof row.surfaceOp === 'object' && textOf(row).includes('[racoons] kept lines'));
    const body = textOf(shaped);
    const marker = /(\[racoons\] kept lines [^·]+· )(\d+)( bytes dropped)/.exec(body);
    assert.ok(marker !== null, 'the multi-gap row carries no full-form marker to mutate');
    shaped.data.message.content = [{ type: 'text',
      text: body.replace(marker[0], `${marker[1]}${Number(marker[2]) + 1}${marker[3]}`) }];
    writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    assert.throws(() => parseFixture({ transcript: path, floor: EXPECTED_JSON.floor }),
      (error) => {
        assert.match(error.message, /^marker-arithmetic-mismatch: /,
          `the pin did not redden by name: ${error.message}`);
        return true;
      });
    // And the sha pin reddens too, so the file cannot be "fixed" silently.
    const pinned = readFileSync(SHA_FILE, 'utf8').split('\n').filter(Boolean)
      .find(line => line.endsWith('sim.session.v4.jsonl'));
    assert.notEqual(sha256(readFileSync(path)), pinned.slice(0, 64),
      'transcript-sha-mismatch was not raised for a mutated marker');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('one mutated kept line reddens the sha pin by name', () => {
  const out = copyFixture();
  try {
    const path = join(out, 'sim.session.v4.jsonl');
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    // A kept line of the lead-gap row: same length, different byte, so the
    // arithmetic still closes and only the byte pin can see it.
    const lead = rows.find(row => row.type === 'tool/result' && row.surfaceOp === 'append'
      && textOf(row).startsWith('<path>C:\\sim\\arm\\alpha.txt</path>'));
    assert.ok(lead !== undefined, 'the lead-gap landed row is absent');
    const original = textOf(lead);
    // Index 0 is the `<path>` line, so index 11 is `alpha line 011`.
    const kept = original.split('\n')[11];
    assert.match(kept, /^alpha line 011 /, 'line 11 of the lead-gap body is not the expected line');
    lead.data.message.content = [{ type: 'text',
      text: original.replace(kept, kept.replace('alpha', 'alphA')) }];
    writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const pinned = readFileSync(join(out, 'sha256.txt'), 'utf8').split('\n').filter(Boolean)
      .find(line => line.endsWith('sim.session.v4.jsonl'));
    assert.notEqual(sha256(readFileSync(path)), pinned.slice(0, 64),
      'kept-line-mutation went unseen: the sha pin did not move');
    // The composition still parses, which is the point: only the bytes moved.
    const parsed = parseFixture({ transcript: path, floor: EXPECTED_JSON.floor });
    assert.deepEqual(parsed.table, EXPECTED_JSON.compositionTable);
    // And the pinned per-row hash catches it even where the table cannot.
    const alpha = parsed.moments.find(moment => moment.seq === lead.seq);
    assert.notEqual(alpha.originalSha256,
      EXPECTED_JSON.moments.find(entry => entry.seq === lead.seq).originalSha256,
      'the per-row original hash did not move for a mutated kept line');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the fixture directory declares LF for its own text files', () => {
  const attributes = readFileSync(join(HERE, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\* text eol=lf$/m,
    'no `* text eol=lf` rule: a Windows checkout would rewrite the pinned bytes');
  for (const file of FILES) {
    assert.ok(readFileSync(join(HERE, file)).length > 0, `${file} is empty`);
  }
});
