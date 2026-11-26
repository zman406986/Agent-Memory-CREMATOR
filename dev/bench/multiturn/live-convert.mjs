#!/usr/bin/env node
/**
 * Phase R v2, R-2 — a dsh `session.v4.jsonl` to the units the metrics score.
 *
 * Usage:
 *   node dev/bench/multiturn/live-convert.mjs --manifest <fixtures/live/manifest.json>
 *        [--floor 1280] [--out <dir>] [--ledger <ledger.sqlite>] [--journal <journal.jsonl>]
 *
 *   --manifest  the fixture manifest (`dev/bench/fixtures/live/manifest.json`).
 *               It names each arm's transcript, its arm root and its session
 *               id, so the join's `<ARM>` substitution is stated data rather
 *               than a constant in code. A ONE-ARM manifest (run B) is accepted:
 *               its sole arm is scored, the join has no second side, and the
 *               summary prints `join: 0 by name — one-arm record`. A zero-arm
 *               manifest is refused by name (`manifest-no-arms`).
 *   --floor     the landed-bytes floor. Default 1 280 (this model's shipped
 *               floor). `8192` reproduces the old bar's pins; anything below
 *               1 280 is refused by name (`fixture-floor-below-keep`) because
 *               the fixture's sub-floor bodies are trimmed copies.
 *   --out       where `live-units.jsonl`, `live-census.json`, `live-join.json`
 *               and the `turns.jsonl` + `manifest.json` record land. Default:
 *               `live-out/` beside the fixture (gitignored via scratchpad rules
 *               only if under scratchpad; pass --out explicitly in a gate).
 *   --ledger    a copied `ledger.sqlite`. Absent means `d` comes from the
 *               marker's own `<B>` slot and every unit prints `d-source=marker`;
 *               a present ledger must agree with the marker or the run refuses
 *               `marker-arithmetic-mismatch`.
 *   --journal   the mount's journal JSONL. Absent, the surface decides there.
 *               Present, its
 *               `entry-apply` rows name a keep-all exactly: `appends === 1 &&
 *               resultSeq === null` (`plugin.ts`'s `applyEntryAnswer`), and
 *               `resultNodeId` carries the call id. A journal row wins over the
 *               surface fallback; a row naming no landed result is counted, not
 *               guessed.
 *
 * ## The surface this reads (corrected protocol)
 *
 * A result lands whole in its own turn (surfaceOp `append`). A separate
 * instruction-only turn asks keep-or-forget. The answer applies as a rewind,
 * never an edit. On disk that is:
 *
 *   keep-all  ONE replace whose span covers only the ask turn and the answer;
 *             the result's own row is untouched.
 *   forget    TWO appends, in this order: a replace over the ask exchange
 *             (`exchangeSeq`), then a content-only replace at the RESULT'S OWN
 *             seq carrying the new turn (`resultSeq > exchangeSeq`). The shaped
 *             row keeps the original turn/step/callId.
 *
 * The rewind and the shaped turn are two host writes (`port.applyEntryShape`:
 * `writeEmptyRange` then `session.append`), so a converter awaiting one atomic
 * pair would read nothing — this module reads the pair.
 *
 * The exchange's ANSWER row is an `assistant/message` in transcripts written
 * before ISSUE-074 and a `user/message` after it (scheme A: dsh's replay
 * validator refuses a stored assistant turn outside an open step, and both
 * append seams sit outside every step). The `asks` census counts the answer by
 * the next message append after the prompt and reads the four verdict kinds out
 * of its text, so the row TYPE is never the key and both shapes score.
 *
 * ## A replace is read from ANY surface row, never `tool/result` alone
 *
 * The mount re-publishes the shadowed span in its FIRST node's own type
 * (`revert.ts`), so an ask exchange's rewind is a `user/message` (`port.ts`'s
 * `writeEmptyRange`: `system/message` when the exchange named turn/step, a
 * contentless `user/message` otherwise). The R-3 live transcript holds 43 ask
 * rewinds, all `user/message`, and 11 same-seq replaces, all `tool/result`
 * (ISSUE-065). A `tool/result`-only scan saw none of the 43 and classified every
 * unit fail-open by construction.
 *
 * Lanes, exhaustive over every replace row (the census prints the four counts
 * and they must sum to `replaces`):
 *
 *   prune-paired  the event before it is a `compaction/prune` — the host
 *                 pruner's, never an ask
 *   ask-rewind    `startSeq !== endSeq`: the ask exchange was rewound. A keep-all
 *                 when no shaped sibling sits at the result's own seq; the
 *                 exchange's own answer is counted in `census.asks.answers`.
 *   shaped        `startSeq === endSeq` and the body carries a shipped marker
 *                 line → the forget's new turn (`forget-with-partials` /
 *                 `forget-all`)
 *   at-rest       `startSeq === endSeq` and the body is one `[not retained] …
 *                 · necromancy <id>` receipt → the engine's own proof burn (a
 *                 `stale-read` removal taken at rest, ADR-0018). Its unit is
 *                 CENSORED as `machinery-at-rest-removal`: a machinery removal
 *                 is not an entry decision, so it is never scored as keep,
 *                 forget or fail-open (ISSUE-066).
 *   anything else same-seq and neither a marker nor a receipt → refused
 *                 `marker-unparseable` by name.
 *
 * ## The journal join, when a journal is at hand
 *
 * The mount journals one `entry-apply` row per answered exchange, and
 * `appends === 1 && resultSeq === null` is the authoritative keep-all signal
 * (`plugin.ts`'s `applyEntryAnswer`; a forget makes two appends). `--journal`
 * takes that JSONL. Where a row is present its `resultNodeId`
 * (`dsh:<session>:result:<callId>`) names the unit exactly and the join wins;
 * where it is absent the surface shape above decides, and each keep-all row
 * prints which rule produced it (`keepallVia`). A live run that carries no
 * journal is transcript-only, so it uses the surface.
 *
 * ## The join, and the one normalization detail §3's prose leaves short
 *
 *   key(u) = sha256(utf8(norm(original(u), armRoot)))
 *   norm   = armRoot → <ARM>, then a Temp run dir → <TMP>; nothing else.
 *
 * The second substitution is written `dsh-subprocess-<token>` in §3's prose, but
 * §1's pinned counts (269 + 6 for 040, 97 + 4 for vanilla) only come out of the
 * broader `dsh-<token>` form: both records also spill through
 * `…\Temp\dsh-spill-<token>\…`. The numbers win over the prose, so this module
 * matches `dsh-`, and `live-join.json.substitutionTotals` prints what it did so
 * the pin stays checkable. No CRLF folding, no trimming, no case folding.
 *
 * ## Two referents, never interchanged
 *
 * `original(u)` is the bytes the host landed at turn R — the bytes both arms
 * have, and the only thing the join may hash. `turn(u)` is the rewound turn
 * (kept partials, markers, the answer's summary). A forget rewrites `turn(u)`
 * and leaves `original(u)` intact, so every forget stays a T1 candidate.
 *
 * ## The five-term identity, each term printed
 *
 *   landed(u) = kept(u) + gaps(u)·markerBytes(u) + summaryBytes(u) + framing(u)
 *   b(u)      = kept(u) + d(u)
 *
 * `gaps` is the marker count, `markerBytes` one rendered marker line's own
 * length, `kept` the kept partials' bytes, `summaryBytes` the answer's note as
 * the mount writes it (`summary` + `\n\n`), and `framing` the residual — so the
 * identity re-derives from `live-units.jsonl` alone. A negative residual
 * refuses `marker-arithmetic-mismatch`; a non-zero one is printed, never
 * absorbed.
 *
 * ## `used`, first witness wins
 *
 * (1) `restore`: a recall/expand call naming the id in `u`'s marker.
 * (2) `reread`: a LATER completed result from the READ tool class only
 *     (`classifyDshTool` → `read`; `read`/`read_file`/`read-file`) whose
 *     normalized `args.file_path` equals the path `original(u)` rendered.
 *
 * "Later" is a greater `seq` **in the unit's own arm**. The two arms are two
 * separate runs with independent seq spaces, so a cross-arm witness has no
 * order and cannot be a "later" call; cross-arm matches are counted separately
 * (`crossArmPathHits`) and never label a unit. The plan's §4 says "either arm";
 * its own §5 gate pin (used seqs 83/89/722 at the old bar) only holds under
 * same-arm ordering, so the pin rules and the difference is printed.
 *
 * A write/edit/apply_patch naming a path is a change, never a reread: the tool
 * class decides before any argument is read.
 *
 * Exit: 0 = converted; 1 = a gate failed (named on stderr);
 *       2 = bad arguments, or a named refusal.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_ASK_END_ANCHOR, SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE,
  receiptLine, splitLineOffsets, unitIdFor,
} from '@cremator/core';
import { classifyDshTool, entryAskFacts, entryShapePrefix } from 'cremator-dsh';
import { optionsOf, parseDevArgs } from '../../shared/args.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_MANIFEST = 'dev/bench/fixtures/live/manifest.json';
const DEFAULT_OUT = 'dev/bench/multiturn/live-out';
/** The lowest floor the fixture can decide: bodies below it are trimmed copies. */
const FIXTURE_KEEP_FLOOR = 1280;
/** The old bar, for the §5 pin that reproduces it. */
const OLD_BAR_FLOOR = 8192;
/**
 * The tool class a witness search filters on, from the SHIPPED classifier
 * (`adapters/dsh/src/evidence.ts:44-52`): `read`/`read_file`/`read-file` map to
 * `read`; `write`/`edit`/`apply_patch` map to `write` and are excluded BEFORE
 * any argument is read, so a change can never be mistaken for a reread.
 */
const isReadClass = name => classifyDshTool(String(name)) === 'read';
/**
 * Restore-class tools, by the name a dsh call carries. The shipped adapter
 * registers the restore as `necromancy` (renamed at `46b0d0b`, ISSUE-123); the
 * old `recall` name is gone, so leaving it here counted no restore at all
 * (ISSUE-132). `dev/bench/tool-name.test.mjs` pins this set to the shipped spec.
 */
const RESTORE_CLASS = new Set(['necromancy', 'expand']);
const TMP_PATTERN = /[A-Za-z]:\\[^'"<>|\r\n]*?\\Temp\\dsh-[^\\'"<>|\r\n]*?\\/g;
const PATH_PATTERN = /<path>([^<]+)<\/path>/g;
/** Methods whose result lands as a new surface row without rewriting one. */
const APPEND = 'append';

/**
 * Every event type these transcripts carry. An unknown type is a refusal, not a
 * shrug: a future host event could change the surface, and a converter that
 * skipped it would score a run it never read.
 *
 * `goal/change` is the host's goal-state record (one per `create_goal` and one
 * per its completion). It carries no `surfaceOp` and no message content, so it
 * can never be a landed result, a replace or an ask — the same no-surface class
 * as `todo/write` and `session/title`, admitted for the same reason.
 * `compaction/summary` is the host's compaction record: a log-only compaction
 * entry, no `surfaceOp` and no message content, the same class as `goal/change`
 * and `todo/write`. The rule above still holds: the set is closed, and a type
 * outside it is refused.
 */
const KNOWN_EVENTS = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'agent/inbox/spliced', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'system/message', 'user/message', 'assistant/message', 'assistant/attempt',
  'tool/call', 'tool/result', 'job/registered', 'job/settled',
  'compaction/prune', 'compaction/start', 'compaction/summary', 'compaction/end',
  'request/header', 'request/context', 'session/title', 'todo/write', 'goal/change',
  'llm/retry', 'llm/retry-started', 'session-log-deepseek/delivery-accepted',
]);

function usage() {
  return 'usage: node dev/bench/multiturn/live-convert.mjs --manifest <manifest.json>'
    + ' [--floor 1280] [--out <dir>] [--ledger <ledger.sqlite>] [--journal <journal.jsonl>]';
}

const LIVE_CONVERT_OPTIONS = optionsOf([
  ['--manifest', 'string'],
  ['--floor', 'string'],
  ['--out', 'string'],
  ['--ledger', 'string'],
  ['--journal', 'string'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: LIVE_CONVERT_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  const opts = {
    manifest: values.manifest ?? DEFAULT_MANIFEST,
    floor: values.floor === undefined ? 1280 : Number(values.floor),
    out: values.out ?? DEFAULT_OUT,
    ledger: values.ledger ?? null,
    journal: values.journal ?? null,
  };
  if (!Number.isSafeInteger(opts.floor) || opts.floor <= 0) {
    throw new Error(`--floor needs a positive integer\n${usage()}`);
  }
  if (opts.floor < FIXTURE_KEEP_FLOOR) {
    throw new Error(`fixture-floor-below-keep: --floor ${opts.floor} is below`
      + ` ${FIXTURE_KEEP_FLOOR}; the fixture keeps sub-floor bodies as 120-char copies,`
      + ' so scoring them would invent a reading');
  }
  return opts;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isAbsolute = value => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

/** The text a message-shaped row carries, joined in part order. */
function textOf(row) {
  const content = row.data?.message?.content;
  if (Array.isArray(content)) {
    return content.filter(part => part.type === 'text').map(part => part.text).join('');
  }
  // A `user/message` row carries `data.content` directly; nothing else does.
  const parts = row.data?.content;
  if (!Array.isArray(parts)) return '';
  return parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
}

function callIdOf(row) {
  return row.data?.message?.toolCallId ?? row.data?.message?.source?.callId ?? null;
}

/** The two normalizations §3 allows, and nothing more: no trim, no case fold. */
function normalizeContent(text, armRoot) {
  let out = armRoot === null ? text : text.split(armRoot).join('<ARM>');
  out = out.replace(TMP_PATTERN, '<TMP>');
  return out;
}

function countSubstitutions(text, armRoot) {
  const arm = armRoot === null ? 0 : text.split(armRoot).length - 1;
  const tmp = (text.match(TMP_PATTERN) ?? []).length;
  return { arm, tmp };
}

/**
 * A path witness's normalization (the `used` rule, §4): resolve against the
 * witnessing arm's own root when relative, then arm root → `<ARM>`, temp dir →
 * `<TMP>`, `\`→`/`, lowercase. Case-insensitivity is a Windows-path rule.
 */
function normalizePath(value, armRoot) {
  let path = value.trim().replace(/^["']|["']$/g, '');
  if (!isAbsolute(path)) path = joinWindows(armRoot, path);
  path = path.split(armRoot).join('<ARM>');
  path = path.replace(TMP_PATTERN, '<TMP>');
  return path.split('\\').join('/').toLowerCase();
}

function joinWindows(root, relative) {
  const left = root.replace(/[\\/]+$/, '');
  const right = relative.replace(/^[\\/]+/, '');
  return `${left}\\${right}`;
}

/** The first renderable `<path>` in a landed body, or null. */
function firstPath(text) {
  const match = new RegExp(PATH_PATTERN.source, 'g').exec(text);
  return match !== null && match[1].trim().length > 0 ? match[1] : null;
}

function readTranscript(path) {
  const text = readFileSync(path, 'utf8');
  const raw = text.split('\n');
  const truncatedFinalLine = raw.length > 0 && raw[raw.length - 1].trim().length > 0
    && !text.endsWith('\n');
  const lines = raw.filter(line => line.trim().length > 0);
  const rows = [];
  for (const [index, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // A killed run can end mid-write. The FINAL line is an accepted
      // end-of-record; any other unreadable line is a refusal.
      if (index === lines.length - 1) return { rows, truncatedFinalLine: true };
      throw new Error(`unreadable-transcript: ${path} line ${index + 1}: ${error.message}`);
    }
  }
  return { rows, truncatedFinalLine };
}

/** The marker regexes, built FROM the shipped templates so they cannot drift. */
function markerPattern(template) {
  const slots = ['<ranges>', '<N>', '<B>', '<id>'];
  let pattern = '';
  let cursor = 0;
  const pieces = [];
  for (const slot of slots) {
    const at = template.indexOf(slot);
    if (at < 0) continue;
    pieces.push({ at, slot });
  }
  pieces.sort((a, b) => a.at - b.at);
  for (const piece of pieces) {
    pattern += escapeRegExp(template.slice(cursor, piece.at));
    pattern += piece.slot === '<ranges>' ? '(?<ranges>[0-9,\\s\\u2013-]+)'
      : piece.slot === '<N>' ? '(?<total>\\d+)'
        : piece.slot === '<B>' ? '(?<dropped>\\d+)'
          : '(?<recallId>[^\\s]+)';
    cursor = piece.at + piece.slot.length;
  }
  pattern += escapeRegExp(template.slice(cursor));
  return new RegExp(pattern, 'g');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MARKER_FULL = markerPattern(SHAPE_MARKER_TEMPLATE);
const MARKER_EMPTY = markerPattern(SHAPE_MARKER_EMPTY_TEMPLATE);

/** Parse the ranges slot `1–3, 7` into line spans; null when it is not one. */
function parseKeptRanges(slot) {
  const ranges = [];
  for (const chunk of slot.split(',')) {
    const piece = chunk.trim();
    if (piece.length === 0) continue;
    const match = /^(\d+)(?:\s*[–-]\s*(\d+))?$/.exec(piece);
    if (match === null) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    ranges.push({ startLine: start, endLineInclusive: end });
  }
  return ranges.length === 0 ? null : ranges;
}

/**
 * Every marker line in a body, in body order. Full form first, then the empty
 * form: a body that carries both would be two different claims and is refused.
 */
function findMarkers(text) {
  const found = [];
  for (const match of text.matchAll(new RegExp(MARKER_FULL.source, 'g'))) {
    found.push({
      index: match.index, text: match[0], empty: false,
      ranges: parseKeptRanges(match.groups.ranges), totalLines: Number(match.groups.total),
      droppedBytes: Number(match.groups.dropped), recallId: match.groups.recallId,
    });
  }
  for (const match of text.matchAll(new RegExp(MARKER_EMPTY.source, 'g'))) {
    found.push({
      index: match.index, text: match[0], empty: true, ranges: [],
      totalLines: Number(match.groups.total), droppedBytes: null,
      recallId: match.groups.recallId,
    });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

/**
 * The `[not retained] … · necromancy <id>` receipt, built from the SHIPPED
 * `receiptLine` renderer exactly as the marker patterns are built from their
 * templates. Two probe receipts (the floor form and the labelled form) are
 * rendered with sentinel slots, and every literal — the `[not retained] `
 * prefix, the ` · necromancy ` separator, the ` — about: ` label separator — is read
 * off those renders, so none of it is retyped here and none of it can drift.
 */
const RECEIPT_PATTERNS = (() => {
  const PATH_SLOT = '\u0000PATH\u0000';
  const ID_SLOT = '\u0000ID\u0000';
  const LABEL_SLOT = 'topic label';
  const render = label => receiptLine({ path: PATH_SLOT, ranges: [], label, recallId: ID_SLOT });
  const [floorForm, labelledForm] = [render(null), render(LABEL_SLOT)];
  const prefix = floorForm.slice(0, floorForm.indexOf(PATH_SLOT));
  const restOf = rendered => rendered.slice(rendered.indexOf(PATH_SLOT) + PATH_SLOT.length);
  const floorRest = restOf(floorForm);
  // The floor form's middle IS the recall separator, so the labelled form's
  // head can be cut with it, leaving the ` — about: ` separator.
  const recallSep = floorRest.slice(0, floorRest.indexOf(ID_SLOT));
  const labelledRest = restOf(labelledForm);
  const labelledHead = labelledRest.slice(0, labelledRest.length - ID_SLOT.length - recallSep.length);
  const aboutSep = labelledHead.slice(0, labelledHead.indexOf(LABEL_SLOT));
  const ending = `${escapeRegExp(recallSep)}(?<recallId>\\S+)$`;
  return [
    new RegExp(`^${escapeRegExp(prefix)}(?<target>.+?)${ending}`, 'u'),
    new RegExp(`^${escapeRegExp(prefix)}(?<target>.+?)${escapeRegExp(aboutSep)}`
      + `(?<label>.*?)${ending}`, 'u'),
  ];
})();

/**
 * The receipt a body IS, when the whole body is exactly one: a proof burn
 * replaces the result with the receipt and nothing else. A body carrying a
 * receipt plus other text is not one, so it is never read as an at-rest removal.
 */
function parseReceipt(text) {
  const body = text.replace(/\r?\n$/, '');
  if (body.includes('\n')) return null;
  for (const pattern of RECEIPT_PATTERNS) {
    const match = pattern.exec(body);
    if (match !== null) {
      return { text: body, target: match.groups.target.trim(), recallId: match.groups.recallId };
    }
  }
  return null;
}

/** The byte length of the lines a kept-ranges selection covers. */
function keptBytesOf(original, keptRanges) {  // `splitLineOffsets` reads BYTES, so the body is encoded first: a UTF-8 line
  // count is what the guard's own renderer sees.
  const offsets = splitLineOffsets(new TextEncoder().encode(original));
  let total = 0;
  for (const range of keptRanges) {
    for (let line = range.startLine; line <= range.endLineInclusive; line++) {
      const offset = offsets[line - 1];
      if (offset === undefined) return null;
      total += offset.endByteExclusive - offset.startByte;
    }
  }
  return total;
}

/**
 * The summary prefix a forget's turn opens with, measured — not guessed. The
 * mount writes `summary + "\n\n"` and nothing else above the shaped bytes, so
 * the prefix is either empty (a blank note) or the body's first line plus the
 * blank line after it. Both candidates are offered and the caller keeps the one
 * that makes the identity close.
 */
function summaryCandidates(text) {
  const candidates = [{ bytes: 0, text: '' }];
  const newline = text.indexOf('\n');
  // `summary + "\n\n"`: the first line, then ONE blank line. A body whose
  // second character is not a newline has no summary prefix.
  if (newline > 0 && text[newline + 1] === '\n') {
    const line = text.slice(0, newline);
    candidates.push({ bytes: Buffer.byteLength(entryShapePrefix(line)), text: line });
  }
  return candidates;
}

/** One landed row, as the join and the metrics read it. */
function unitOf({ row, arm, armRoot, call }) {
  const original = textOf(row);
  const bytes = Buffer.byteLength(original);
  const substitutions = countSubstitutions(original, armRoot);
  const normKey = sha256(Buffer.from(normalizeContent(original, armRoot), 'utf8'));
  return {
    arm, seq: row.seq, step: row.data?.step ?? null,
    callId: callIdOf(row) ?? call?.callId ?? null, tool: call?.name ?? null,
    original, bytes, normKey, substitutions,
    path: firstPath(original),
  };
}

/**
 * The unit id, minted by the product's own `unitIdFor` over a synthesized
 * whole-result node, so the id a stage-1 mint writes and the id this converter
 * prints are the same id the engine would mint for the same bytes.
 */
function mintUnitId({ sessionId, nodeId, original, spanEndExclusive }) {
  const bytes = new TextEncoder().encode(original);
  const node = {
    kind: 'tool-result', id: nodeId, turnOrdinal: 0, stepOrdinal: 0,
    bytes, sha256: sha256(bytes), byteLength: bytes.length,
    callId: nodeId, embeddedRecords: [],
    evidence: {
      kind: 'other', target: null, paths: [],
      source: { nodeId, sha256: sha256(bytes), byteLength: bytes.length }, sourceRecallId: null,
    },
  };
  return unitIdFor(sessionId, node, {
    byteRange: { startByte: 0, endByteExclusive: spanEndExclusive },
    lineRange: null,
  });
}

/** A refusal with the field names the gate asserts on. */
function refuse(code, detail, seq) {
  const error = new Error(`${code}: ${detail}${seq === undefined ? '' : ` (seq ${seq})`}`);
  error.code = code;
  error.seq = seq;
  throw error;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(REPO_ROOT, opts.manifest);
  if (!existsSync(manifestPath)) refuse('manifest-absent', manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const outDir = resolve(REPO_ROOT, opts.out);

  // A manifest with no arm at all has nothing to score and nothing to join:
  // refused by name, before any transcript is read.
  const armEntries = Object.entries(manifest.arms ?? {});
  if (armEntries.length === 0) refuse('manifest-no-arms', `${manifestPath} names no arm`);

  // ---- parse both arms, refusing anything the surface model cannot place ----
  const arms = {};
  for (const [arm, meta] of armEntries) {
    const transcript = resolve(REPO_ROOT, 'dev/bench/fixtures/live', meta.transcript);
    if (!existsSync(transcript)) refuse('transcript-absent', transcript);
    const { rows, truncatedFinalLine } = readTranscript(transcript);
    const calls = new Map();
    for (const row of rows) {
      if (!KNOWN_EVENTS.has(row.type)) refuse('unknown-event-type', row.type, row.seq);
      // The call's own fields plus the row's seq: a witness search reads the
      // name and arguments, an order rule reads the seq.
      if (row.type === 'tool/call') calls.set(row.data.callId, { ...row.data, seq: row.seq });
    }
    for (const row of rows) {
      if (row.type !== 'tool/result') continue;
      if (!Array.isArray(row.data?.message?.content)) {
        refuse('result-without-content', `${arm} tool/result carries no data.message.content`, row.seq);
      }
      const callId = callIdOf(row);
      if (callId === null || !calls.has(callId)) {
        refuse('call-id-unknown', `${arm} tool/result names ${String(callId)}, which matches no tool/call`,
          row.seq);
      }
    }
    const results = rows.filter(row => row.type === 'tool/result');
    const appends = results.filter(row => row.surfaceOp === APPEND);
    // Every surface row, not `tool/result` alone (ISSUE-065): the mount
    // re-publishes a shadowed span in its FIRST node's own type, so an ask
    // exchange's rewind is a `user/message` in every live record written by the
    // entry seam. A result-only scan saw none of the R-3 run's 43 rewinds.
    const surfaceAppends = rows.filter(row => row.surfaceOp === APPEND);
    const replaces = rows.filter(row => row.surfaceOp !== undefined
      && typeof row.surfaceOp === 'object');
    for (const row of replaces) {
      const op = row.surfaceOp;
      if (op.op !== 'replace' || !Number.isSafeInteger(op.startSeq)
        || !Number.isSafeInteger(op.endSeq) || op.startSeq > op.endSeq) {
        refuse('surface-op-unknown', `${arm} surfaceOp is not a replace range`, row.seq);
      }
      if (op.endSeq >= row.seq) {
        refuse('rewind-range-mismatch',
          `${arm} replace span ${op.startSeq}..${op.endSeq} reaches its own seq ${row.seq}`, row.seq);
      }
    }
    // A replace is prune-paired when the event immediately before it is a
    // `compaction/prune`; those are the host pruner's, never an ask.
    const bySeq = new Map(rows.filter(row => Number.isSafeInteger(row.seq)).map(row => [row.seq, row]));
    for (const row of replaces) {
      const previous = bySeq.get(row.seq - 1);
      row.prunePaired = previous?.type === 'compaction/prune';
    }
    // The four lanes, exhaustive over `replaces`: every row lands in exactly one.
    const lanes = { prunePaired: [], rewind: [], shaped: [], atRest: [], unresolved: [] };
    for (const row of replaces) {
      if (row.prunePaired) { lanes.prunePaired.push(row); continue; }
      const op = row.surfaceOp;
      if (op.startSeq !== op.endSeq) { lanes.rewind.push(row); continue; }
      const body = textOf(row);
      if (findMarkers(body).length > 0) { lanes.shaped.push(row); continue; }
      // A same-seq replace whose whole body is one `[not retained] … · recall
      // <id>` receipt is the engine's own proof burn at rest (ADR-0018), never
      // an agent answer (ISSUE-066).
      const receipt = parseReceipt(body);
      if (receipt !== null) { row.receipt = receipt; lanes.atRest.push(row); continue; }
      lanes.unresolved.push(row);
    }
    // A same-seq replace whose body is neither a marker nor a receipt is refused
    // by name: the converter cannot say whether it is a forget or a machinery
    // removal, so it must not score the row either way (ISSUE-066's DoD).
    for (const row of lanes.unresolved) {
      refuse('marker-unparseable',
        `the shaped turn at seq ${row.seq} names no shipped marker line and is no proof receipt`,
        row.seq);
    }
    arms[arm] = {
      arm, meta, rows, calls, results, appends, surfaceAppends, replaces, lanes,
      truncatedFinalLine,
      steps: rows.filter(row => row.type === 'step/start').length,
      assistantMessages: rows.filter(row => row.type === 'assistant/message').length,
      pruneEvents: rows.filter(row => row.type === 'compaction/prune').length,
      lastSeq: Math.max(0, ...rows.filter(row => Number.isSafeInteger(row.seq)).map(row => row.seq)),
      askPrompts: rows.filter(row => row.type === 'user/message' && row.surfaceOp === APPEND
        && textOf(row).includes(ENTRY_ASK_END_ANCHOR)),
    };
  }

  // ---- askRows: is ask-fork usage in the log at all? ----------------------
  // The detector asks whether an answer row carries the HOST's own usage row,
  // which only an `assistant/message` can: a step settlement is one, so the
  // surplus over the step count is the ask-fork usage. Since ISSUE-074 (scheme
  // A) the answer row is stored as a `user/message`, so a transcript written
  // after the fix can never carry ask-fork usage and this reads 0 by
  // construction — the same "a projection, not a measurement" status the
  // 040/sim fixtures carry. The census's `asks` block is the exchange count,
  // and it reads both storage shapes (see `countAnswers`).
  const askRowsOf = arm => arm.assistantMessages - arm.steps;

  // ---- the scored arm's landed rows, at the floor -------------------------
  // The scored arm is the `racoons` arm where the manifest names one; a one-arm
  // manifest (a live run with no control) names its solo arm and that arm is
  // the record. Zero arms were refused above, so the fallback is defined.
  const scored = arms.racoons ?? Object.values(arms)[0];
  const landed = scored.appends
    .map(row => unitOf({ row, arm: scored.arm, armRoot: scored.meta.armRoot, call: scored.calls.get(callIdOf(row)) }))
    .filter(unit => unit.bytes >= opts.floor);
  // Every arm's over-floor population, so the old-bar pins (12 and 17 units,
  // 7/12 and 8/17 unlabelable, used 83/89/722) re-derive from the same file.
  const overFloorByArm = {};
  for (const [name, arm] of Object.entries(arms)) {
    overFloorByArm[name] = arm.appends
      .map(row => unitOf({
        row, arm: name, armRoot: arm.meta.armRoot, call: arm.calls.get(callIdOf(row)),
      }))
      .filter(unit => unit.bytes >= opts.floor);
  }

  // ---- composition, from surface events and the ledger only ---------------
  // Four lanes, exhaustive over the scored arm's replace rows (the census
  // prints the four counts and asserts they sum to `replaces`). A shaped turn
  // is a non-prune same-seq replace whose body carries a shipped marker line; a
  // rewind is any other non-prune replace; an at-rest replace is a same-seq
  // replace whose whole body is a proof receipt; a prune-paired replace is the
  // host pruner's and never classifies.
  const shapedByResultSeq = new Map();
  for (const row of scored.lanes.shaped) shapedByResultSeq.set(row.surfaceOp.startSeq, row);
  // The engine's own proof burn, keyed by the landed seq its span covers
  // (ISSUE-066). Its unit is censored, never scored as a decision.
  const atRestByResultSeq = new Map();
  for (const row of scored.lanes.atRest) atRestByResultSeq.set(row.surfaceOp.startSeq, row);
  const rewinds = scored.lanes.rewind;
  /**
   * The ask's own facts block, `This result has N lines, so keeplines ranges sit
   * in [1,N]. Quotes to help you locate them:` plus its anchor lines, read off
   * the prompt's text. A landed BODY carries no such block — its facts come from
   * the product's own `entryAskFacts` over its bytes (below), which is the same
   * arithmetic `entryAskMessage` rendered the prompt from.
   */
  const ASK_COUNT_LINE = /^This result has (\d+) lines\b/;
  const ASK_ANCHOR_LINE = /^(?:line \d+(?: of \d+)? ends with ".*"|lines \d+–\d+ are blank)$/;
  // Old-format records state `line X of Y ends with …`; today's entry ask never
  // does (`anchorsFor` passes `withTotal: false`), so drop the clause to key
  // both against the same facts — an old record must still pair.
  const canonicalAnchor = anchor => anchor.replace(/^(line \d+) of \d+ (ends with .*)$/, '$1 $2');
  const askFactsOf = text => {
    const lines = text.split('\n');
    let at = -1;
    let lineCount = null;
    for (let index = 0; index < lines.length; index += 1) {
      const match = ASK_COUNT_LINE.exec(lines[index]);
      if (match === null) continue;
      at = index;
      lineCount = Number(match[1]);
    }
    if (at < 0) return null;
    const anchorLines = [];
    for (let index = at + 1; index < lines.length; index += 1) {
      if (!ASK_ANCHOR_LINE.test(lines[index])) break;
      anchorLines.push(canonicalAnchor(lines[index]));
    }
    return { lineCount, anchorLines };
  };
  /**
   * Which landed result each ask rewind decides, by the ask's OWN facts block
   * (ISSUE-081). The prompt states the line count and the anchor lines of the
   * result it is about — `entryAskMessage` rendered them from the landed bytes —
   * so it names its target outright; "the nearest over-floor result" does not.
   *
   * The join is the gate's (`resolveAttribution`): the landed rows before the
   * prompt whose facts block is identical, preferring the prompt's own step.
   * Two identical listings in one step are still two rows, so the LAST of them
   * is taken — a step lands its results in order and the ask sits under the one
   * it was rendered from.
   *
   * A prompt that states no facts (the synthetic fixture predates the block)
   * keeps the old positional rule and prints `no-facts`, so a fallback can never
   * hide; a prompt whose facts fit no row prints `unplaced` and decides nothing.
   */
  const factsKeyOfRow = new Map(scored.appends.map(row => {
    const facts = entryAskFacts(new TextEncoder().encode(textOf(row)));
    return [row.seq, JSON.stringify([facts.lineCount, facts.anchorLines])];
  }));
  const stepAtPrompt = seq => {
    let step = null;
    for (const row of scored.rows) {
      if (row.seq >= seq) break;
      if ((row.type === 'step/end' || row.type === 'step/start')
        && Number.isSafeInteger(row.data?.step)) step = row.data.step;
    }
    return step;
  };
  const answerActionAfter = seq => {
    const next = scored.surfaceAppends.find(row => row.seq > seq) ?? null;
    if (next === null || (next.type !== 'assistant/message' && next.type !== 'user/message')) {
      return null;
    }
    return ['keepall', 'keeplines', 'forgetall', 'forgetlines'].find(kind =>
      textOf(next).includes(`{"${kind}"`)) ?? 'unparsed';
  };
  const landedSeqs = landed.map(unit => unit.seq).sort((a, b) => a - b);
  // The facts join runs over EVERY landed row, never the over-floor units alone:
  // a sub-floor result is a real target that owns the ask, and excluding it here
  // is exactly the mis-pairing ISSUE-081 removes.
  const allLandedSeqs = scored.appends.map(row => row.seq).sort((a, b) => a - b);
  const askPairings = rewinds.map(row => {
    const promptSeq = row.surfaceOp.startSeq;
    const prompt = scored.rows.find(other => other.seq === promptSeq);
    const facts = prompt === undefined ? null : askFactsOf(textOf(prompt));
    const action = answerActionAfter(promptSeq);
    if (facts === null) {
      return { rewind: row, promptSeq, targetSeq: null, targetBytes: null, action, basis: 'no-facts' };
    }
    const key = JSON.stringify([facts.lineCount, facts.anchorLines]);
    const matching = allLandedSeqs.filter(other => other < promptSeq
      && factsKeyOfRow.get(other) === key);
    const step = stepAtPrompt(promptSeq);
    const sameStep = matching.filter(other => scored.appends
      .some(item => item.seq === other && (item.data?.step ?? null) === step));
    const pool = sameStep.length > 0 ? sameStep : matching;
    if (pool.length === 0) {
      return { rewind: row, promptSeq, targetSeq: null, targetBytes: null, action, basis: 'unplaced' };
    }
    const targetSeq = pool[pool.length - 1];
    const targetBytes = Buffer.byteLength(textOf(
      scored.appends.find(item => item.seq === targetSeq) ?? { data: {} }));
    return {
      rewind: row, promptSeq, targetSeq, targetBytes, action,
      basis: pool.length === 1 ? 'facts-unique' : 'facts-last',
    };
  });
  /**
   * A target under the floor is NOT a unit, so the ask decides nothing. It is
   * named here — prompt, target, the target's bytes, the answer's action — and
   * the over-floor unit beside it stays unasked. A unit is never credited an
   * answer whose own facts name another row (ISSUE-081).
   */
  const belowFloorAsks = askPairings.filter(entry => entry.targetBytes !== null
    && entry.targetBytes < opts.floor)
    .map(entry => ({
      promptSeq: entry.promptSeq, targetSeq: entry.targetSeq,
      targetBytes: entry.targetBytes, action: entry.action,
    }));
  const unplacedAsks = askPairings.filter(entry => entry.basis === 'unplaced')
    .map(entry => ({ promptSeq: entry.promptSeq, action: entry.action }));
  // One class per ask, disjoint: a facts match whose target is under the floor is
  // `below-floor`, never also `facts-unique` — the ask decided no unit.
  const askPairing = { 'facts-unique': 0, 'facts-last': 0, 'below-floor': 0, 'no-facts': 0,
    unplaced: 0 };
  for (const entry of askPairings) {
    const floorBound = entry.targetBytes !== null && entry.targetBytes < opts.floor;
    askPairing[floorBound ? 'below-floor' : entry.basis] += 1;
  }
  const targetBySeq = new Map();
  for (const entry of askPairings) {
    if (entry.targetBytes === null || entry.targetBytes < opts.floor) continue;
    if (!targetBySeq.has(entry.targetSeq)) targetBySeq.set(entry.targetSeq, entry.rewind);
  }
  const factless = new Set(askPairings.filter(entry => entry.basis === 'no-facts')
    .map(entry => entry.rewind.seq));
  /**
   * The ask rewind that decided the unit at `seq`: the rewind whose ask names
   * this result, or — only for a prompt that states no facts — the old
   * positional window. A shaped sibling at `seq` makes this the FORGET's
   * exchange rewind, never a keep-all; the caller checks that.
   */
  const keepAllFor = seq => {
    const named = targetBySeq.get(seq);
    if (named !== undefined) return named;
    const nextLanded = landedSeqs.find(other => other > seq) ?? Infinity;
    const positional = rewinds.find(row => row.surfaceOp.startSeq > seq
      && row.surfaceOp.startSeq < nextLanded
      && !landedSeqs.includes(row.surfaceOp.startSeq)) ?? null;
    return positional !== null && factless.has(positional.seq) ? positional : null;
  };

  const ledger = opts.ledger === null ? null : readLedger(resolve(REPO_ROOT, opts.ledger));
  const droppedByRecall = ledger?.droppedByRecall ?? new Map();
  const journal = opts.journal === null ? null : readJournal(resolve(REPO_ROOT, opts.journal), arms);

  const units = [];
  for (const unit of landed) {
    const atRest = atRestByResultSeq.get(unit.seq) ?? null;
    const shaped = shapedByResultSeq.get(unit.seq) ?? null;
    const rewind = keepAllFor(unit.seq);
    const unitRow = {
      arm: scored.arm, tier: null, step: unit.step, callId: unit.callId, seq: unit.seq,
      spanStart: shaped === null ? null : shaped.surfaceOp.startSeq,
      spanEnd: shaped === null ? null : shaped.surfaceOp.endSeq,
      unitId: mintUnitId({
        sessionId: scored.meta.sessionId,
        nodeId: `live_racoons_${unit.seq}`,
        original: unit.original,
        spanEndExclusive: Buffer.byteLength(unit.original),
      }),
      rawSha256: sha256(Buffer.from(unit.original, 'utf8')),
      normKey: unit.normKey, tool: unit.tool, bytes: unit.bytes, path: unit.path,
      substitutions: unit.substitutions,
      composition: null, keptBytes: null, gaps: 0, markerCount: 0, markerBytes: 0,
      summaryBytes: 0, framingBytes: null, droppedBytes: null, ranges: null,
      recallId: null, rf: null, used: false, usedBy: null, censoredClass: null,
      keepallVia: null, atRest: null,
    };
    if (atRest !== null) {
      // The engine removed this result at rest — a `stale-read` proof burn
      // (ADR-0018): a MACHINERY removal with no agent answer behind it. The unit
      // leaves the entry-decision population: `composition` stays null (it is
      // neither a keep nor a forget), the censoring class names why, and the
      // unit is never scored as a decision (ISSUE-066).
      unitRow.censoredClass = 'machinery-at-rest-removal';
      unitRow.droppedBytes = 0;
      unitRow.rf = 0;
      unitRow.atRest = {
        seq: atRest.seq,
        recallId: atRest.receipt.recallId,
        target: atRest.receipt.target,
        ledgerDroppedBytes: droppedByRecall.get(atRest.receipt.recallId) ?? null,
      };
      units.push(unitRow);
      continue;
    }
    if (shaped === null) {
      // No shaped sibling. Either the ask exchange was rewound away (keep-all)
      // or no ask turn follows at all (the ask lane failed open). The journal's
      // `entry-apply` row is the authoritative keep-all signal where a journal
      // exists; the surface span is the fallback, and each row prints which rule
      // decided it (ISSUE-065).
      const journalKeepAll = journal === null ? null : journal.keepAllFor(unit, scored.arm);
      if (journalKeepAll !== null) {
        const surfaceSpan = rewinds.find(row => row.surfaceOp.startSeq === journalKeepAll.exchangeSeq);
        unitRow.composition = 'keepall';
        unitRow.spanStart = journalKeepAll.exchangeSeq;
        unitRow.spanEnd = surfaceSpan?.surfaceOp.endSeq ?? journalKeepAll.exchangeSeq;
        unitRow.droppedBytes = 0;
        unitRow.rf = 0;
        unitRow.censoredClass = null;
        unitRow.keepallVia = 'journal-entry-apply';
      } else if (rewind !== null) {
        unitRow.composition = 'keepall';
        unitRow.spanStart = rewind.surfaceOp.startSeq;
        unitRow.spanEnd = rewind.surfaceOp.endSeq;
        unitRow.droppedBytes = 0;
        unitRow.rf = 0;
        unitRow.censoredClass = null;
        // The surface rule decided it: the rewind opens after this result and
        // before the next landed one. The journal was absent or silent.
        unitRow.keepallVia = 'surface-rewind';
      } else {
        unitRow.composition = 'ask-failed-fail-open';
        unitRow.droppedBytes = 0;
        unitRow.rf = 0;
        unitRow.censoredClass = 'refused-ask';
      }
      units.push(unitRow);
      continue;
    }
    const turnText = textOf(shaped);
    const markers = findMarkers(turnText);
    const [first] = markers;
    const markerBytes = Buffer.byteLength(first.text);
    const gaps = markers.length;
    const ranges = first.empty ? [] : first.ranges;
    if (!first.empty && ranges === null) {
      refuse('marker-unparseable', `the marker at seq ${shaped.seq} names unparseable ranges`, shaped.seq);
    }
    // One marker per dropped gap, so every marker is the same rendered line;
    // a body whose markers disagree is not the shipped render.
    if (new Set(markers.map(marker => marker.text)).size !== 1) {
      refuse('marker-unparseable', `the markers at seq ${shaped.seq} differ from each other`, shaped.seq);
    }
    const kept = keptBytesOf(unit.original, ranges);
    if (kept === null) {
      refuse('marker-unparseable',
        `the marker at seq ${shaped.seq} names a line the original does not have`, shaped.seq);
    }
    const landedBytes = Buffer.byteLength(turnText);
    const markerTotal = gaps * markerBytes;
    // The marker's own `<B>` slot is the ledger's `d` when no ledger is given;
    // the empty form carries no `<B>` and drops the whole body.
    const dropped = first.empty ? unit.bytes - kept : first.droppedBytes;
    if (dropped !== unit.bytes - kept) {
      refuse('marker-arithmetic-mismatch',
        `the marker at seq ${shaped.seq} says ${dropped} dropped but the original holds`
        + ` ${unit.bytes} bytes and the kept ranges ${kept}`, shaped.seq);
    }
    // Summary bytes: whichever candidate makes the identity close; the residual
    // is `framing` and must not be negative.
    let chosen = null;
    for (const candidate of summaryCandidates(turnText)) {
      const framing = landedBytes - kept - markerTotal - candidate.bytes;
      if (framing >= 0 && (chosen === null || framing < chosen.framing)) {
        chosen = { ...candidate, framing };
      }
    }
    if (chosen === null) {
      const framing = landedBytes - kept - markerTotal;
      refuse('marker-arithmetic-mismatch',
        `the shaped turn at seq ${shaped.seq} is ${landedBytes} bytes, but kept ${kept}`
        + ` + markers ${gaps}x${markerBytes} already exceed it by ${-framing}`, shaped.seq);
    }
    unitRow.composition = first.empty ? 'forget-all' : 'forget-with-partials';
    unitRow.keptBytes = kept;
    unitRow.gaps = gaps;
    unitRow.markerCount = gaps;
    unitRow.markerBytes = markerBytes;
    unitRow.summaryBytes = chosen.bytes;
    unitRow.framingBytes = chosen.framing;
    unitRow.droppedBytes = dropped;
    unitRow.ranges = ranges;
    unitRow.recallId = first.recallId;
    unitRow.rf = unit.bytes === 0 ? null : dropped / unit.bytes;
    units.push(unitRow);
  }

  // ---- the ledger must agree with every marker it has a row for -----------
  if (ledger !== null) {
    // Every recall id a marker in this transcript names — including the pruner's
    // own (a prune-paired replace carries a rendered marker just as a forget
    // does) and the proof burn's receipt — because the ledger records all of them
    // and only the transcript can say which ids are this session's. A proof
    // burn's receipt is legitimately not a marker, so without its id here the
    // ledger cross-check would refuse the whole run (ISSUE-066).
    const transcriptRecallIds = new Set();
    for (const row of scored.replaces) {
      for (const marker of findMarkers(textOf(row))) transcriptRecallIds.add(marker.recallId);
      const receipt = row.receipt ?? parseReceipt(textOf(row));
      if (receipt !== null) transcriptRecallIds.add(receipt.recallId);
    }
    for (const unit of units) {
      if (unit.recallId === null) continue;
      const fromLedger = droppedByRecall.get(unit.recallId);
      if (fromLedger === undefined) {
        // A marker with no ledger row is a CLASS, not a refusal: the ledger may
        // predate the copy, and the marker's own `<B>` is still a measurement.
        unit.ledgerState = 'no-ledger-row';
        continue;
      }
      if (fromLedger !== unit.droppedBytes) {
        refuse('marker-arithmetic-mismatch',
          `ledger says ${fromLedger} bytes dropped for ${unit.recallId}, the marker says`
          + ` ${unit.droppedBytes}`, unit.seq);
      }
      unit.ledgerState = 'agrees';
    }
    // The proof lane's own cross-check: the ledger's row for a receipt must name
    // a `proof` removal, and its bytes are printed on the unit. A receipt whose
    // id the ledger does not hold is a class (`no-ledger-row`), the same as a
    // marker's.
    for (const unit of units) {
      if (unit.atRest === null) continue;
      const fromLedger = droppedByRecall.get(unit.atRest.recallId);
      unit.atRest.ledgerState = fromLedger === undefined ? 'no-ledger-row'
        : fromLedger === unit.atRest.ledgerDroppedBytes ? 'agrees' : 'disagrees';
    }
    // The other direction IS a refusal (§5's list): a ledger row naming a recall
    // id that no marker in this transcript carries means the ledger and the
    // transcript are not the same session. Silently ignoring it would let a
    // mismatched pair score as if it agreed.
    for (const recallId of droppedByRecall.keys()) {
      if (transcriptRecallIds.has(recallId)) continue;
      refuse('ledger-row-unknown',
        `the ledger holds ${droppedByRecall.get(recallId)} dropped bytes for ${recallId},`
        + ' which no marker in this transcript names');
    }
  }

  // ---- the join: key → set per arm, cross product, no first-match dedupe ---
  const sideOf = arm => {
    const map = new Map();
    for (const row of arm.appends) {
      const unit = unitOf({
        row, arm: arm.arm, armRoot: arm.meta.armRoot, call: arm.calls.get(callIdOf(row)),
      });
      if (unit.bytes < opts.floor) continue;
      const bucket = map.get(unit.normKey) ?? [];
      bucket.push(unit);
      map.set(unit.normKey, bucket);
    }
    return map;
  };
  const racoonsSide = sideOf(scored);
  // The control side is the manifest's `vanilla` arm when it is not the scored
  // arm; failing that, the one arm that is not the scored one. A ONE-ARM record
  // (a live run with no control) has no second side at all: the cross product is
  // empty by construction, not by a failed match, and the summary says so.
  const others = Object.values(arms).filter(arm => arm !== scored);
  const control = others.length === 0 ? null
    : (arms.vanilla !== undefined && arms.vanilla !== scored ? arms.vanilla : others[0]);
  const vanillaSide = control === null ? null : sideOf(control);
  const oneArm = control === null;
  const pairs = [];
  for (const [key, left] of racoonsSide) {
    const right = vanillaSide?.get(key);
    if (right === undefined) continue;
    for (const a of left) for (const b of right) pairs.push({ key, racoonsSeq: a.seq, vanillaSeq: b.seq });
  }
  const sharedKeys = new Set(pairs.map(pair => pair.key));
  // Substitutions are counted over the over-floor population each arm is scored
  // on — the same rows §1's pinned counts (269 + 6, 97 + 4) are about.
  const substitutionTotals = Object.fromEntries(Object.entries(overFloorByArm)
    .map(([name, population]) => [name, population.reduce((total, unit) => ({
      arm: total.arm + unit.substitutions.arm,
      tmp: total.tmp + unit.substitutions.tmp,
    }), { arm: 0, tmp: 0 })]));
  // The joined set is keyed on NORMALIZED bytes. The control beside it counts
  // the same pairs keyed on RAW bytes: a join that only works after the
  // substitution prints a smaller raw figure, and a run where the two are equal
  // says the substitution matched nothing (the key is raw bytes).
  const rawShared = oneArm ? 0 : [...racoonsSide.values()].flat()
    .filter(left => [...vanillaSide.values()].flat()
      .some(right => right.original === left.original))
    .length;
  for (const unit of units) {
    unit.tier = sharedKeys.has(unit.normKey) ? 'T1' : 'T3';
  }

  // ---- `used`, first witness wins ----------------------------------------
  // A `refused-ask` unit still gets a `used` label: the class says how the ask
  // failed, not whether the bytes were read again. §4 scores it with `d = 0`.
  for (const unit of units) {
    const restore = findRestoreWitness(scored, unit);
    if (restore !== null) { unit.used = true; unit.usedBy = `restore:${restore}`; continue; }
    const reread = findRereadWitness(scored, unit);
    if (reread !== null) { unit.used = true; unit.usedBy = `reread:${reread}`; continue; }
    unit.used = false;
    unit.usedBy = null;
  }

  // ---- per-arm labels: the old-bar pins re-derive from here --------------
  // Each arm's own over-floor population, labelled by the same rule against its
  // OWN transcript. The scored rows above are the racoons arm's; this block
  // exists so "12 and 17 units, 7/12 and 8/17 unlabelable, used 83/89/722" is
  // checkable from the same run.
  const armLabels = {};
  for (const [name, population] of Object.entries(overFloorByArm)) {
    const arm = arms[name];
    const rows = population.map(unit => {
      const restore = findRestoreWitness(arm, unit);
      const reread = restore === null ? findRereadWitness(arm, unit) : null;
      return {
        seq: unit.seq,
        path: unit.path,
        used: restore !== null || reread !== null,
        usedBy: restore !== null ? `restore:${restore}` : reread !== null ? `reread:${reread}` : null,
      };
    });
    armLabels[name] = {
      units: population.length,
      labelable: rows.filter(row => row.path !== null).length,
      unlabelableUsed: rows.filter(row => row.path === null).length,
      used: rows.filter(row => row.used).length,
      usedSeqs: rows.filter(row => row.used).map(row => row.seq),
      usedBy: rows.filter(row => row.used).map(row => `${row.seq}<-${row.usedBy}`),
    };
  }

  // ---- the censoring classes, each counted -------------------------------
  const counted = {
    'never-seen': 0, 'unjoined-content': 0, 'refused-ask': 0, 'no-legal-answer': 0,
    'unlabelable-used': 0, 'racoons-only': 0,
  };
  for (const unit of units) {
    if (unit.tier === 'T3') counted['unjoined-content'] += 1;
    if (unit.censoredClass === 'refused-ask') counted['refused-ask'] += 1;
    // A machinery removal is outside the entry-decision population entirely, so
    // it is in no decision class — `unlabelable-used` included (ISSUE-066).
    if (unit.censoredClass === 'machinery-at-rest-removal') continue;
    if (unit.path === null) counted['unlabelable-used'] += 1;
  }
    // The machinery class is NOT a decision class: a unit the engine removed at
    // rest is not a keep, a forget or a fail-open, so counting it beside them
    // would inflate a decision total (ISSUE-066). It gets its own block.
    const machinery = {
      class: 'machinery-at-rest-removal',
      censored: units.filter(unit => unit.censoredClass === 'machinery-at-rest-removal').length,
      proofs: units.filter(unit => unit.atRest !== null).map(unit => ({ ...unit.atRest, seq: unit.seq })),
    };

  // ---- the composition table, one line per class, nothing summed away ------
  // The six lines the run record prints. `below-floor` is the landed results the
  // floor excluded (they never enter the unit table) and `machinery-censored` is
  // the at-rest lane, which is not a decision. The four decision classes plus
  // the two non-decision lines account for every landed result.
  const belowFloor = scored.appends.length - landed.length;
  const compositionTable = {
    keepall: units.filter(unit => unit.composition === 'keepall').length,
    'forget-with-partials': units.filter(unit => unit.composition === 'forget-with-partials').length,
    'forget-all': units.filter(unit => unit.composition === 'forget-all').length,
    'ask-failed-fail-open': units.filter(unit => unit.composition === 'ask-failed-fail-open').length,
    'below-floor': belowFloor,
    'machinery-censored': machinery.censored,
  };
  // The rule that produced each composition number: one line per class, stated
  // so a reader of the census can re-derive the count from the transcript alone
  // (ISSUE-065's DoD: "the count is stated in the run record with the rule that
  // produced it"; ISSUE-066 for the machinery line).
  const compositionRules = {
    keepall: 'entry-apply rows appends:1 resultSeq:null; surface: the ask rewind whose prompt'
      + ' names this result\'s own facts block (ISSUE-081), with no shaped sibling at its seq;'
      + ' a prompt stating no facts falls back to "after the result and before the next landed one"',
    'forget-with-partials': 'a same-seq replace at the result seq whose body carries a shipped'
      + ' full-form marker line and keeps at least one line',
    'forget-all': 'a same-seq replace at the result seq whose body carries the shipped'
      + ' empty-form marker line',
    'ask-failed-fail-open': 'no shaped sibling and no ask rewind between the result and the'
      + ' next landed one (refusal codes or off)',
    'machinery-censored': 'a same-seq replace at the result seq whose whole body is one'
      + ' [not retained] ... recall <id> receipt: an at-rest receipt replaced unit, not a decision',
    'below-floor': `a landed result under the ${opts.floor}-byte floor; never a unit`,
  };
  // Vanilla over-floor units the racoons arm never produced are `never-seen`;
  // racoons over-floor units vanilla never produced are `racoons-only`. A
  // one-arm record has no vanilla side, so neither count exists: nothing was
  // never seen (`never-seen` 0) and nothing is "racoons only" (0), because
  // there is no second arm to be only relative to.
  if (!oneArm) {
    for (const key of vanillaSide.keys()) if (!racoonsSide.has(key)) counted['never-seen'] += 1;
    for (const key of racoonsSide.keys()) if (!vanillaSide.has(key)) counted['racoons-only'] += 1;
  }
  if (counted['no-legal-answer'] > 0) {
    // Structural unreachability (ADR-0020 §2): no protection layer can refuse a
    // legal answer, so any occurrence is a core defect, not a statistic.
    refuse('no-legal-answer', 'the run classified a legal answer as unanswerable');
  }

  // ---- the record lanes.mjs / removal.mjs consume ------------------------
  const record = recordOf(scored, opts.floor);

  // ---- write --------------------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  const writeAtomic = (name, text) => {
    const path = join(outDir, name);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  };
  writeAtomic('live-units.jsonl', `${units.map(unit => JSON.stringify(unit)).join('\n')}\n`);
  writeAtomic('live-join.json', `${JSON.stringify({
    floor: opts.floor,
    tiers: {
      T1: pairs.length,
      T2: 0,
      T3: units.filter(unit => unit.tier === 'T3').length,
    },
    sharedKeys: sharedKeys.size,
    pairs,
    substitutionTotals,
    rawJoinedUnits: rawShared,
    endedBy: oneArm
      ? { [scored.arm]: scored.truncatedFinalLine ? 'truncatedFinalLine' : 'complete' }
      : Object.fromEntries(Object.entries(arms).map(([name, value]) =>
        [name, value.truncatedFinalLine ? 'truncatedFinalLine' : 'complete'])),
  }, null, 2)}\n`);
  writeAtomic('live-census.json', `${JSON.stringify({
    floor: opts.floor,
    arms: Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, {
      sessionId: value.meta.sessionId,
      rows: value.rows.length,
      toolResults: value.results.length,
      appends: value.appends.length,
      surfaceAppends: value.surfaceAppends.length,
      replaces: value.replaces.length,
      prunePaired: value.lanes.prunePaired.length,
      // The four replace lanes, exhaustive: their counts sum to `replaces`.
      replacesByLane: {
        'prune-paired': value.lanes.prunePaired.length,
        'ask-rewind': value.lanes.rewind.length,
        shaped: value.lanes.shaped.length,
        'at-rest-proof': value.lanes.atRest.length,
      },
      steps: value.steps,
      assistantMessages: value.assistantMessages,
      askRows: askRowsOf(value),
      pruneEvents: value.pruneEvents,
      landedAtFloor: value.appends.filter(row => Buffer.byteLength(textOf(row)) >= opts.floor).length,
      truncatedFinalLine: value.truncatedFinalLine,
    }])),
    units: units.length,
    armLabels,
    // The composed units only: a censored machinery removal has no composition
    // (it is no decision), so it must not appear as a `null` key here.
    compositions: units.filter(unit => unit.composition !== null)
      .reduce((totals, unit) => {
        totals[unit.composition] = (totals[unit.composition] ?? 0) + 1;
        return totals;
      }, {}),
    // The six-line table the run record prints, in fixed order: four decision
    // classes, the floor's own exclusion, and the one non-decision line.
    compositionTable,
    // The rule behind each of those numbers, stated rather than implied, so a
    // census reader can check the count against the transcript.
    compositionRules,
    // How each keep-all was decided: the journal's `entry-apply` row where one
    // exists, the surface rewind otherwise. A live run has no journal, so every
    // row prints `surface-rewind` there.
    keepallVia: units.filter(unit => unit.composition === 'keepall')
      .reduce((totals, unit) => {
        totals[unit.keepallVia] = (totals[unit.keepallVia] ?? 0) + 1;
        return totals;
      }, {}),
    // How every ask rewind found its target (ISSUE-081). `facts-unique` and
    // `facts-last` are the prompt's own facts block naming one row, or the last
    // of several identical rows in its step; `below-floor` is a target under the
    // floor, which is no unit, so the ask decides nothing and the over-floor unit
    // beside it stays unasked; `no-facts` is the positional fallback for a
    // prompt that states no facts block at all; `unplaced` is facts that fit no
    // landed row. The counts are disjoint and sum to the ask rewinds.
    askPairing,
    // Every below-floor ask by name: prompt, the target its facts named, that
    // target's bytes, and the answer's own action. A censored ask is printed,
    // never silently dropped.
    belowFloorAsks,
    // Asks whose facts fit no landed row. They decide nothing and are named for
    // the same reason.
    unplacedAsks,
    // The at-rest proof lane, OUTSIDE the decision classes: one row per machinery
    // removal with the ledger's own byte count. These units are censored, never
    // scored as keep, forget or fail-open.
    machinery,
    // The ask outcomes, when the log carries an ask exchange at all: each ask
    // prompt is followed by exactly one answer, and the answer's own action is
    // counted by name. `askPrompts` is the transcript's own ask count, which is
    // the figure `askRows` projects a cost from.
    asks: Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, {
      prompts: value.askPrompts.length,
      answers: countAnswers(value),
    }])),
    censoring: counted,
    join: { T1: pairs.length, sharedKeys: sharedKeys.size, substitutions: substitutionTotals },
  }, null, 2)}\n`);
  writeAtomic('turns.jsonl', `${record.turns.map(turn => JSON.stringify(turn)).join('\n')}\n`);
  writeAtomic('manifest.json', `${JSON.stringify(record.manifest, null, 2)}\n`);

  const summary = [
    'live-convert',
    `  floor        ${opts.floor}`,
    `  arms         ${Object.entries(arms).map(([arm, value]) =>
      `${arm}:${value.appends.length}app/${value.replaces.length}rep/${value.steps}steps`)
      .map(part => part).join(' ')}`,
    `  lanes        ${Object.entries(arms).map(([arm, value]) =>
      `${arm}:paired=${value.lanes.prunePaired.length},rewind=${value.lanes.rewind.length},`
      + `shaped=${value.lanes.shaped.length},atrest=${value.lanes.atRest.length},`
      + `replaces=${value.replaces.length}`).join(' ')}`,
    `  asks         ${Object.entries(arms).map(([arm, value]) =>
      `${arm}:prompts=${value.askPrompts.length},${Object.entries(countAnswers(value))
        .map(([action, count]) => `${action}=${count}`).join(',') || 'answers=none'}`).join(' ')}`,
    `  askRows      ${Object.entries(arms).map(([arm, value]) =>
      `${arm}=${askRowsOf(value)}`).join(' ')}`
      + `${Object.values(arms).every(value => askRowsOf(value) === 0)
        ? ' (no ask-fork usage row: an ask total is a PROJECTION)' : ''}`,
    `  substitutions ${Object.entries(substitutionTotals).map(([arm, totals]) =>
      `${arm}=${totals.arm}+${totals.tmp}`).join(' ')}`,
    // A one-arm record has no second side: the join is empty BY NAME, not by a
    // failed match, so the summary states which case it is.
    `  join         ${oneArm ? '0 by name — one-arm record'
      : `T1=${pairs.length} keys=${sharedKeys.size}`}`,
    `  units        ${units.length}`
      + ` compositions=${JSON.stringify(units.filter(unit => unit.composition !== null)
        .reduce((totals, unit) => {
          totals[unit.composition] = (totals[unit.composition] ?? 0) + 1;
          return totals;
        }, {}))}`,
    `  arm-units    ${Object.entries(armLabels).map(([name, label]) =>
      `${name}:${label.units}u/${label.unlabelableUsed}unlab/${label.used}used`).join(' ')}`,
    `  used-seqs    ${Object.entries(armLabels).map(([name, label]) =>
      `${name}:${label.usedSeqs.join(',') || 'none'}`).join(' ')}`,
    `  keepall-via  ${Object.entries(units.filter(unit => unit.composition === 'keepall')
      .reduce((totals, unit) => {
        totals[unit.keepallVia] = (totals[unit.keepallVia] ?? 0) + 1;
        return totals;
      }, {})).map(([via, count]) => `${via}=${count}`).join(' ') || 'none'}`,
    // Every rewind row this arm wrote, and how many bound to a landed result.
    // An unbound rewind is not a defect by itself: a retry exchange rewinds its
    // own failed turn, which no result of the keep-all population owns.
    `  rewinds      ${rewinds.length} bound=${units.filter(unit => unit.keepallVia !== null).length}`
      + ` unbound=${rewinds.length - units.filter(unit => unit.keepallVia !== null).length}`
      + (rewinds.length === 0 ? '' : ` seqs=${rewinds.map(row => `${row.surfaceOp.startSeq}..${row.surfaceOp.endSeq}`).join(',')}`),
    // How each ask found (or failed to find) its target, one class per ask
    // (ISSUE-081). `below-floor` asks decide no unit and are named in full on the
    // next line; a silent non-binding is what this ticket removes.
    `  ask-pairing  ${Object.entries(askPairing)
      .map(([basis, count]) => `${basis}=${count}`).join(' ')}`,
    `  below-floor  ${belowFloorAsks.length === 0 ? 'none' : belowFloorAsks.map(entry =>
      `prompt${entry.promptSeq}->seq${entry.targetSeq}(${entry.targetBytes}B,${String(entry.action)})`)
      .join(' ')}`,
    `  unplaced     ${unplacedAsks.length === 0 ? 'none' : unplacedAsks.map(entry =>
      `prompt${entry.promptSeq}(${String(entry.action)})`).join(' ')}`,
    `  at-rest      ${machinery.censored === 0 ? 'none' : machinery.proofs.map(proof =>
      `seq${proof.seq}<-${proof.recallId}(${proof.ledgerDroppedBytes ?? 'no-ledger-row'}B)`)
      .join(' ')}`,
    `  table        ${Object.entries(compositionTable)
      .map(([name, count]) => `${name}=${count}`).join(' ')}`,
    // One line per composition number, naming the rule that produced it.
    `  table-rules  ${Object.keys(compositionTable)
      .map(name => `${name} <- ${compositionRules[name]}`).join('\n               ')}`,
    `  censoring    ${Object.entries(counted).map(([name, count]) => `${name}=${count}`).join(' ')}`,
    `  out          ${outDir}`,
  ];
  process.stdout.write(`${summary.join('\n')}\n`);
}

/**
 * The ask outcomes, counted by the answer's own action.
 *
 * A prompt is a `user/message` append carrying the shipped end anchor. Its
 * answer is the NEXT surface append after the prompt, in EITHER storage shape:
 * an `assistant/message` in transcripts written before ISSUE-074 (the 040 and
 * sim fixtures) and a `user/message` after it — scheme A stores the answer as a
 * user turn because dsh's replay validator refuses an `assistant/message`
 * outside an open step, and both append seams sit outside every step (leader
 * ruling 2026-10-27). The exchange is appended back to back, so the first
 * surface append after the prompt IS the answer row; the row TYPE is never the
 * key. An answer that names none of the four verdict kinds is counted
 * `unparsed` — never dropped, because an unreadable answer is a fact about the
 * run.
 */
function countAnswers(arm) {
  const counts = {};
  for (const prompt of arm.askPrompts) {
    // The exchange is appended back to back: the ask row, then the answer row.
    // The FIRST surface append after the prompt is therefore the answer row
    // when the ask was answered at all; a refused ask appends nothing, and the
    // next append belongs to a later step (`no-answer`).
    const next = arm.surfaceAppends.find(row => row.seq > prompt.seq) ?? null;
    const answer = next !== null && (next.type === 'assistant/message' || next.type === 'user/message')
      ? next : null;
    const action = answer === null ? 'no-answer'
      : ['keepall', 'keeplines', 'forgetall', 'forgetlines'].find(kind =>
        textOf(answer).includes(`{"${kind}"`)) ?? 'unparsed';
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return counts;
}

/** A recall/expand call naming this unit's recall id, or null. */
function findRestoreWitness(arm, unit) {
  if (unit.recallId === null) return null;
  for (const [callId, call] of arm.calls) {
    if (!RESTORE_CLASS.has(String(call.name).toLowerCase())) continue;
    if (call.seq <= unit.seq) continue;
    const text = String(call.arguments ?? '');
    if (text.includes(unit.recallId)) return `seq${call.seq}:${call.name}`;
    const resultRow = arm.results.find(row => callIdOf(row) === callId);
    if (resultRow !== undefined && textOf(resultRow).includes(unit.recallId)) {
      return `seq${resultRow.seq}:${call.name}`;
    }
  }
  return null;
}

/**
 * A later read-class result in the unit's OWN arm naming the unit's path. The
 * tool class decides before any argument is read, so a write/edit never counts.
 */
function findRereadWitness(arm, unit) {
  if (unit.path === null) return null;
  const target = normalizePath(unit.path, arm.meta.armRoot);
  for (const [callId, call] of arm.calls) {
    if (!isReadClass(call.name)) continue;
    if (call.seq <= unit.seq) continue;
    let args;
    try {
      args = JSON.parse(String(call.arguments ?? '{}'));
    } catch {
      continue;
    }
    const filePath = args.file_path ?? args.filePath ?? args.path;
    if (typeof filePath !== 'string') continue;
    if (normalizePath(filePath, arm.meta.armRoot) !== target) continue;
    const resultRow = arm.results.find(row => callIdOf(row) === callId);
    if (resultRow === undefined) continue;
    return `seq${resultRow.seq}`;
  }
  return null;
}

/**
 * The ledger's dropped bytes per recall id: `application_removals` joined to
 * `removed_spans`, `end_byte_exclusive - start_byte` summed per `recall_id`.
 * A row naming no record is refused by the caller (`no-ledger-row` is a class,
 * not a refusal; a row whose recall id appears nowhere in the transcript is).
 */
function readLedger(path) {
  if (!existsSync(path)) refuse('ledger-absent', path);
  // `node:sqlite` is loaded lazily so a conversion without a ledger needs no
  // store at hand.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  const droppedByRecall = new Map();
  const rows = db.prepare(`
    SELECT r.recall_id AS recallId,
           SUM(s.end_byte_exclusive - s.start_byte) AS dropped
      FROM application_removals r
      JOIN removed_spans s ON s.recall_id = r.recall_id
     GROUP BY r.recall_id`).all();
  for (const row of rows) {
    droppedByRecall.set(String(row.recallId), Number(row.dropped));
  }
  db.close();
  return { path, droppedByRecall };
}

/**
 * The mount's journal, read for the ONE fact the surface cannot always state
 * exactly: which result a keep-all settled. `entry-apply` is journaled once per
 * answered exchange (`plugin.ts`'s `applyEntryAnswer`) with `appends` and
 * `resultSeq`; a keep-all makes ONE append and names no result seq, a forget
 * makes TWO and names the shaped turn's seq. `eventId` is
 * `dsh:<session>:result:<callId>`, so the call id comes off the row itself.
 *
 * Where no journal is given the caller falls back to the surface rewind and
 * prints that it did.
 */
function readJournal(path, arms) {
  if (!existsSync(path)) refuse('journal-absent', path);
  const text = readFileSync(path, 'utf8');
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      refuse('journal-unreadable', `${path} line ${index + 1}: ${error.message}`);
    }
  }
  const keepAll = [];
  const forgets = [];
  const unmatched = [];
  for (const row of rows) {
    if (row.kind !== 'entry-apply') continue;
    if (row.appends === 1 && row.resultSeq === null) {
      // The authoritative keep-all signal: one append, no shaped turn.
      const callId = String(row.resultNodeId ?? '').split(':result:').pop() ?? '';
      const owner = Object.values(arms).find(arm => arm.calls.has(callId)) ?? null;
      if (owner === null) { unmatched.push(row); continue; }
      keepAll.push({ callId, arm: owner.arm, sessionId: row.sessionId,
        exchangeSeq: row.exchangeSeq, status: row.status, action: row.action });
    } else if (row.resultSeq !== null && row.resultSeq !== undefined) {
      forgets.push(row);
    }
  }
  return {
    path, keepAll, forgets, unmatched,
    /**
     * The journal row that settled a keep-all for this unit, or null. A row
     * matches on the arm and the call id; `exchangeSeq` names the rewind span's
     * start so the surface can supply the span's end for the record.
     */
    keepAllFor: (unit, armName) => keepAll.find(row =>
      row.arm === armName && row.callId === unit.callId) ?? null,
  };
}

/**
 * The live transcript as an `extract.mjs`-shaped record: one turn per dsh turn,
 * one step per `step/start`, nodes carrying their own `stepOrdinal` and
 * `callId`. This is what `lanes.mjs` and `removal.mjs` consume, and the step
 * ordinal is what makes the live lane's `(step, callId)` key possible.
 */
function recordOf(arm, floor) {
  const turns = [];
  let current = null;
  let stepOrdinal = 0;
  for (const row of arm.rows) {
    if (row.type === 'turn/start') {
      current = {
        turnOrdinal: row.data.turn - 1,
        stepOrdinal: 0,
        turnId: `turn_${row.data.turn}`,
        status: 'completed',
        inFlight: false,
        startedAt: row.time,
        completedAt: null,
        promptMessageId: null,
        promptOrigin: 'real_user',
        promptVisibility: 'visible',
        nodes: [],
        requests: [],
        fills: [],
        progress: { writesTotal: 0, writesThisTurn: 0 },
      };
      turns.push(current);
      stepOrdinal = 0;
      continue;
    }
    if (current === null) continue;
    if (row.type === 'step/start') {
      stepOrdinal += 1;
      current.stepOrdinal = Math.max(current.stepOrdinal, stepOrdinal);
      continue;
    }
    if (row.type === 'turn/end') {
      current.completedAt = row.time ?? null;
      continue;
    }
    if (row.type === 'assistant/message') {
      // One request per assistant message: the usage block is the request's own.
      current.requests.push({
        id: `req_${row.seq}`,
        logicalRequestId: `req_${row.seq}`,
        querySource: 'main_turn',
        modelId: row.data?.message?.source?.model ?? 'unknown',
        status: 'completed',
        startedAt: row.time,
        inputTokens: row.data?.usage?.inputTokens ?? 0,
        cacheReadInputTokens: row.data?.usage?.cacheReadTokens ?? 0,
        depth: (row.data?.usage?.inputTokens ?? 0) + (row.data?.usage?.cacheReadTokens ?? 0),
      });
      continue;
    }
    if (row.type === 'tool/result' && row.surfaceOp === APPEND) {
      const text = textOf(row);
      const call = arm.calls.get(callIdOf(row));
      current.nodes.push({
        id: `live_${arm.arm}_${row.seq}`,
        kind: 'tool',
        role: 'assistant',
        origin: 'agent_runtime',
        providerVisible: true,
        bytes: Buffer.byteLength(text),
        tool: call?.name ?? null,
        callId: callIdOf(row),
        stepOrdinal: row.data?.step ?? stepOrdinal,
        status: 'completed',
        filePath: firstPath(text) ?? null,
      });
      continue;
    }
    if (row.type === 'tool/call') {
      const text = String(row.data?.arguments ?? '');
      if (!/"(write|edit|apply_patch)"/.test(text) && /"file_path"/.test(text)) {
        current.progress.writesThisTurn += 1;
      }
    }
  }
  for (const turn of turns) {
    turn.nodeCount = turn.nodes.length;
    turn.nodeBytes = turn.nodes.reduce((total, node) => total + node.bytes, 0);
    turn.requestCount = turn.requests.length;
    turn.declaredModelRequestCount = turn.requests.length;
    turn.declaredInputTokens = turn.requests.reduce((total, request) => total + request.inputTokens, 0);
    turn.declaredCacheReadInputTokens = 0;
    turn.declaredToolCallCount = turn.nodes.length;
  }
  return {
    turns,
    manifest: {
      schema: 'racoons-multiturn-record/1',
      snapshot: { digest: null, note: 'live transcript, not a store snapshot' },
      session: { id: arm.meta.sessionId },
      selected: { turns: turns.length, floor },
      pinned: {
        threshold: null,
        thresholdSource: 'absent',
        branch: 'live',
        byteQuotient: 4,
        seed: 0,
        prefixTokens: 0,
        keying: 'step',
      },
    },
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(error?.code === undefined ? 2 : 2);
  }
}

export {
  findMarkers, findRereadWitness, keptBytesOf, normalizeContent, normalizePath, readTranscript,
  summaryCandidates,
};
