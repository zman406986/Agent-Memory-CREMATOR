#!/usr/bin/env node
/**
 * Sanitizer for the two committed sim fixture pairs (`sim.reasoning.*`,
 * `sim.prunes.*`). It removes the owner's home paths and private text from the
 * decoded JSON strings while keeping every string's UTF-8 byte length, its
 * newline count, its JSON position and the file's own layout, so sizes and other
 * byte-derived numbers are unchanged and only content hashes move.
 *
 * Usage:
 *
 *   node dev/bench/fixtures/sim/sanitize-fixture.mjs \
 *     --session-in  <in.jsonl> --session-out <out.jsonl> \
 *     --usage-in    <in.json>  --usage-out   <out.json>   [--verify]
 *
 * Rules, applied to string VALUES only (keys are never touched):
 *
 *   1. `C:\Users\TZhen` -> `C:\Users\AAAAA`, `C:\Users\TZ` -> `C:\Users\AA`.
 *      Drive letter, separator runs and the rest of the path are preserved, so
 *      the substitution is byte-for-byte the same length.
 *   2. A string of 40 or more UTF-8 bytes is masked: every ASCII letter/digit
 *      becomes `x`, every non-ASCII code point becomes `x` repeated by that
 *      code point's UTF-8 byte length. ASCII whitespace, newlines, punctuation,
 *      quotes and backslashes survive. `RACOONS-*` markers and strings that are
 *      exactly an id (`call_`, `msg_`, `ses_`, `recall:sha256:`) stay intact.
 *   3. A string under 40 bytes stays intact unless it carries a home path or a
 *      private name; then only those spans are masked (`Aetherium` -> 9 `x`,
 *      each Han ideograph -> `x` per byte).
 *   4. Output is re-serialized with JSON.stringify, key order untouched. Each
 *      input file's own layout is reproduced when it round-trips (compact for
 *      JSONL, the detected indent plus trailing newline for the usage JSON), so
 *      the byte totals of both files are unchanged too.
 *
 * `--verify` re-reads both outputs, re-parses them and checks, per string:
 * equal UTF-8 byte length, equal newline count, no `C:\Users\TZ`, no
 * `Aetherium`, no private Han word, no Han ideograph; plus equal JSON structure (keys,
 * key order, types) and equal raw file bytes. Exit code 1 on any failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { optionsOf, parseDevArgs } from '../../../shared/args.mjs';

const MIN_LONG_BYTES = 40;
const HOME_PATH_RE = /([A-Za-z]:[\\/]+[Uu]sers[\\/]+)(TZ\x68en|TZ)(?![A-Za-z0-9])/gi;
const MARKER_RE = /RACOONS-[A-Za-z0-9-]+/g;
const ID_RE = /^(?:call_|msg_|ses_|recall:sha256:)[A-Za-z0-9._:-]+$/;
const HAN_RE = /\p{Script=Han}/u;
const HAN_ALL_RE = /\p{Script=Han}/gu;
const PRIVATE_WORD_RE = /Aetherium/gi;
const PRIVATE_HAN_WORD = '\u6df1\u7a7a';
const PRIVATE_WORD_BYTES = Buffer.byteLength('Aetherium', 'utf8');

const isAsciiAlnum = (ch) => (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

function replaceHomePaths(s) {
  return s.replace(HOME_PATH_RE, (_m, prefix, name) => `${prefix}${'A'.repeat(name.length)}`);
}

/** Mask every letter/digit/non-ASCII code point, sparing `RACOONS-*` markers. */
function maskLong(s) {
  const markerEnds = new Map();
  for (const m of s.matchAll(MARKER_RE)) markerEnds.set(m.index, m.index + m[0].length);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const markerEnd = markerEnds.get(i);
    if (markerEnd !== undefined) {
      out += s.slice(i, markerEnd);
      i = markerEnd;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    let end = i + ch.length;
    // A marker can also start inside the next code point only; checked above.
    if (cp < 0x80) out += isAsciiAlnum(ch) ? 'x' : ch;
    else out += 'x'.repeat(Buffer.byteLength(ch, 'utf8'));
    i = end;
  }
  return out;
}

/** Mask only the private spans of an otherwise-kept short string. */
function scrubShort(s) {
  if (!PRIVATE_WORD_RE.test(s) && !HAN_RE.test(s)) return s;
  PRIVATE_WORD_RE.lastIndex = 0;
  return s
    .replace(PRIVATE_WORD_RE, 'x'.repeat(PRIVATE_WORD_BYTES))
    .replace(HAN_ALL_RE, (ch) => 'x'.repeat(Buffer.byteLength(ch, 'utf8')));
}

function sanitizeString(s, stats) {
  stats.strings++;
  stats.bytesIn += Buffer.byteLength(s, 'utf8');
  const homed = replaceHomePaths(s);
  let out;
  if (ID_RE.test(s) || ID_RE.test(homed)) {
    out = homed;
    stats.idsKept++;
  } else if (Buffer.byteLength(homed, 'utf8') >= MIN_LONG_BYTES) {
    out = maskLong(homed);
    stats.longMasked++;
  } else {
    out = scrubShort(homed);
    if (out !== homed) stats.shortScrubbed++;
  }
  stats.bytesOut += Buffer.byteLength(out, 'utf8');
  if (out !== s) stats.changed++;
  return out;
}

function sanitizeDeep(value, stats) {
  if (typeof value === 'string') return sanitizeString(value, stats);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, stats));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = sanitizeDeep(value[key], stats);
    return out;
  }
  return value;
}

const newStats = () => ({ strings: 0, changed: 0, bytesIn: 0, bytesOut: 0, longMasked: 0, shortScrubbed: 0, idsKept: 0 });

function splitJsonl(text) {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body === '' ? [] : body.split('\n');
  return { trailingNewline, lines };
}

function sanitizeJsonl(text) {
  const { trailingNewline, lines } = splitJsonl(text);
  const stats = newStats();
  const roundTrips = [];
  const outLines = lines.map((line, i) => {
    if (line.trim() === '') return line;
    const parsed = JSON.parse(line);
    roundTrips.push(JSON.stringify(parsed) === line);
    return JSON.stringify(sanitizeDeep(parsed, stats));
  });
  return {
    text: outLines.join('\n') + (trailingNewline ? '\n' : ''),
    stats,
    rawRoundTrip: roundTrips.every(Boolean),
  };
}

function detectJsonStyle(text, value) {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  for (const indent of [2, 4, 1, 0, '\t']) {
    if (JSON.stringify(value, null, indent) === body) {
      return { indent, trailingNewline, matched: true };
    }
  }
  return { indent: 0, trailingNewline, matched: false };
}

function sanitizeJson(text) {
  const parsed = JSON.parse(text);
  const style = detectJsonStyle(text, parsed);
  const stats = newStats();
  const out = sanitizeDeep(parsed, stats);
  return {
    text: JSON.stringify(out, null, style.indent) + (style.trailingNewline ? '\n' : ''),
    stats,
    rawRoundTrip: style.matched,
  };
}

const countNewlines = (s) => {
  let n = 0;
  for (const ch of s) if (ch === '\n') n++;
  return n;
};

function sameStructure(a, b, where, errors) {
  if (typeof a === 'string') {
    if (typeof b !== 'string') errors.push(`${where}: type ${typeof b}, expected string`);
    return;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) { errors.push(`${where}: not an array`); return; }
    if (a.length !== b.length) errors.push(`${where}: array length ${b.length}, expected ${a.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) sameStructure(a[i], b[i], `${where}[${i}]`, errors);
    return;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { errors.push(`${where}: not an object`); return; }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.join('\u0000') !== bk.join('\u0000')) errors.push(`${where}: keys differ`);
    for (const key of ak) {
      if (Object.prototype.hasOwnProperty.call(b, key)) sameStructure(a[key], b[key], `${where}.${key}`, errors);
    }
    return;
  }
  if (!Object.is(a, b)) errors.push(`${where}: ${JSON.stringify(b)}, expected ${JSON.stringify(a)}`);
}

function verifyStrings(a, b, where, report) {
  if (typeof a === 'string') {
    if (typeof b !== 'string') return;
    report.strings++;
    const inBytes = Buffer.byteLength(a, 'utf8');
    const outBytes = Buffer.byteLength(b, 'utf8');
    report.bytesIn += inBytes;
    report.bytesOut += outBytes;
    report.rawBytesEqual = report.rawBytesEqual && inBytes === outBytes;
    if (inBytes !== outBytes) report.byteFailures.push(where);
    if (countNewlines(a) !== countNewlines(b)) report.newlineFailures.push(where);
    const forbidden = [];
    if (/[A-Za-z]:[\\/]+[Uu]sers[\\/]+TZ/.test(b)) forbidden.push('home-path');
    if (b.includes('Aetherium')) forbidden.push('Aetherium');
    if (b.includes(PRIVATE_HAN_WORD)) forbidden.push('private-han-word');
    if (HAN_RE.test(b)) forbidden.push('han');
    if (forbidden.length) report.forbidden.push(`${where}: ${[...new Set(forbidden)].join(',')}`);
    return;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return;
    for (let i = 0; i < Math.min(a.length, b.length); i++) verifyStrings(a[i], b[i], `${where}[${i}]`, report);
    return;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return;
    for (const key of Object.keys(a)) {
      if (Object.prototype.hasOwnProperty.call(b, key)) verifyStrings(a[key], b[key], `${where}.${key}`, report);
    }
  }
}

const newVerifyReport = () => ({
  strings: 0,
  bytesIn: 0,
  bytesOut: 0,
  rawBytesEqual: true,
  byteFailures: [],
  newlineFailures: [],
  forbidden: [],
  structureFailures: [],
});

function verifyPair(label, inText, outText, kind) {
  const report = newVerifyReport();
  const structureErrors = [];
  if (kind === 'jsonl') {
    const a = splitJsonl(inText);
    const b = splitJsonl(outText);
    if (a.trailingNewline !== b.trailingNewline) structureErrors.push('trailing newline differs');
    if (a.lines.length !== b.lines.length) structureErrors.push(`line count ${b.lines.length}, expected ${a.lines.length}`);
    const n = Math.min(a.lines.length, b.lines.length);
    for (let i = 0; i < n; i++) {
      if (a.lines[i].trim() === '' || b.lines[i].trim() === '') {
        if (a.lines[i] !== b.lines[i]) structureErrors.push(`line ${i + 1}: blank-line mismatch`);
        continue;
      }
      let pa;
      let pb;
      try { pa = JSON.parse(a.lines[i]); } catch { structureErrors.push(`line ${i + 1}: input does not parse`); continue; }
      try { pb = JSON.parse(b.lines[i]); } catch { structureErrors.push(`line ${i + 1}: output does not parse`); continue; }
      sameStructure(pa, pb, `line ${i + 1}`, structureErrors);
      verifyStrings(pa, pb, `line ${i + 1}`, report);
    }
  } else {
    const pa = JSON.parse(inText);
    const pb = JSON.parse(outText);
    sameStructure(pa, pb, 'root', structureErrors);
    verifyStrings(pa, pb, 'root', report);
  }
  report.structureFailures = structureErrors;
  report.pass =
    report.byteFailures.length === 0 &&
    report.newlineFailures.length === 0 &&
    report.forbidden.length === 0 &&
    report.structureFailures.length === 0;
  report.label = label;
  return report;
}

function check(ok, label, detail, lines) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function formatReport(report, inBytes, outBytes) {
  const lines = [];
  let ok = true;
  ok = check(report.byteFailures.length === 0, 'string byte lengths',
    `${report.strings} strings, ${report.bytesIn} B in, ${report.bytesOut} B out`, lines) && ok;
  ok = check(report.newlineFailures.length === 0, 'newline counts',
    report.newlineFailures.length ? `${report.newlineFailures.length} differ` : 'all equal', lines) && ok;
  ok = check(report.forbidden.length === 0, 'forbidden tokens',
    report.forbidden.length ? `${report.forbidden.length} hits: ${report.forbidden.slice(0, 3).join('; ')}` : 'none', lines) && ok;
  ok = check(report.structureFailures.length === 0, 'JSON structure',
    report.structureFailures.length ? report.structureFailures.slice(0, 3).join('; ') : 'keys, order, types equal', lines) && ok;
  ok = check(inBytes === outBytes, 'raw file bytes', `${inBytes} in, ${outBytes} out`, lines) && ok;
  return { ok, lines };
}

// The four path flags keep their dashed keys (main reads opts['session-in']);
// --verify and --help/-h are booleans. `--flag=value` now works (ISSUE-381).
const SANITIZE_OPTIONS = optionsOf([
  ['--session-in', 'string', 'session-in'],
  ['--session-out', 'string', 'session-out'],
  ['--usage-in', 'string', 'usage-in'],
  ['--usage-out', 'string', 'usage-out'],
  ['--verify', 'boolean', 'verify'],
  ['--help', 'boolean', 'help', { short: 'h' }],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: SANITIZE_OPTIONS,
    refuse: (message) => { throw new Error(message); },
    // This script's unknown-argument text carries a colon; keep it exactly.
    unknown: (rawName) => `unknown argument: ${rawName}`,
  });
  return values;
}

function writeOut(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: sanitize-fixture.mjs --session-in <f> --session-out <f> --usage-in <f> --usage-out <f> [--verify]');
    return 0;
  }
  for (const key of ['session-in', 'session-out', 'usage-in', 'usage-out']) {
    if (!opts[key]) throw new Error(`missing --${key}`);
  }

  let failed = false;
  const jobs = [
    { label: path.basename(opts['session-in']), kind: 'jsonl', input: opts['session-in'], output: opts['session-out'], sanitize: sanitizeJsonl },
    { label: path.basename(opts['usage-in']), kind: 'json', input: opts['usage-in'], output: opts['usage-out'], sanitize: sanitizeJson },
  ];

  for (const job of jobs) {
    const inText = fs.readFileSync(job.input, 'utf8');
    const { text, stats, rawRoundTrip } = job.sanitize(inText);
    writeOut(job.output, text);
    const outText = fs.readFileSync(job.output, 'utf8');
    const rawEqual = Buffer.byteLength(inText, 'utf8') === Buffer.byteLength(outText, 'utf8');
    console.log(
      `${job.label}: strings ${stats.strings}, changed ${stats.changed}, ` +
      `decoded bytes ${stats.bytesIn} -> ${stats.bytesOut}, raw bytes ${Buffer.byteLength(inText, 'utf8')} -> ${Buffer.byteLength(outText, 'utf8')}` +
      `${rawRoundTrip ? '' : ' [warning: input layout did not round-trip; compacted]'}`,
    );
    if (!rawEqual) console.log(`  warning: raw byte total changed for ${job.label}`);

    if (opts.verify) {
      const report = verifyPair(job.label, inText, outText, job.kind);
      const { ok, lines } = formatReport(report, Buffer.byteLength(inText, 'utf8'), Buffer.byteLength(outText, 'utf8'));
      for (const line of lines) console.log(`  verify ${line}`);
      if (!ok) failed = true;
    }
  }

  if (opts.verify) console.log(failed ? 'FAIL' : 'PASS');
  return failed ? 1 : 0;
}

process.exitCode = main();
