#!/usr/bin/env node
/**
 * The synthetic shape-fixture builder for `dev/bench/fixtures/sim/` (ISSUE-059 T-2).
 *
 * Usage:
 *   node dev/bench/fixtures/sim/build-fixture.mjs --verify
 *   node dev/bench/fixtures/sim/build-fixture.mjs --out <fresh-dir>
 *
 * It writes three fixtures: the synthetic shape fixture described below, the
 * reasoning fixture — the smallest faithful prefix of the 2026-10-29 full-rerun
 * vanilla session that carries 60 assistant turns and 60 reasoning parts — and
 * the prunes fixture, the smallest prefix that carries at least 20
 * `compaction/prune` rows. Both cuts come from
 * `scratchpad/launch/2026-10-29-full-rerun/` (the only real recording in the
 * tree) and are pinned in `manifest.json` by sha256, bytes and structural counts,
 * so a sim run no longer depends on a disposable scratchpad directory.
 *
 * The committed reasoning and prunes cuts are SANITIZED in place: their string
 * values are masked while every UTF-8 byte length and line count is preserved.
 * `--verify` is therefore the supported path for this directory. A build into
 * the committed directory is refused, because regenerating those cuts from the
 * private source would write the owner's home path and private text back into
 * the tree. A build with `--out` into a fresh directory still writes the
 * synthetic pair and, for inspection only, the unsanitized cuts from the
 * private source; it is never the committed fixture. `--verify` recomputes the
 * manifest pins without rebuilding and exits non-zero on any mismatch.
 *
 * The 040 fixture (`dev/bench/fixtures/live/`) is real, and its census is a valid
 * oracle for the converter — but it carries no shaped row, no ask turn and 65
 * `ask-failed-fail-open` units, so it cannot make a re-render go green. This
 * fixture is the OTHER oracle: a transcript with a KNOWN composition, built from
 * the shipped renderers, so a later ticket can check a render against expected
 * bytes instead of against a live run.
 *
 * ## What it holds
 *
 * Eight landed results, seven of them over the 1 280 B floor. One moment per
 * row the converter's `compositionRules` can produce:
 *
 *   lead-gap          forget-with-partials, one marker before the kept lines
 *   multi-gap         forget-with-partials, three markers between kept spans
 *   forget-all        forget-all, the empty-form marker and nothing kept
 *   keepall           keepall, the ask exchange rewound with no shaped sibling
 *   machinery         machinery-censored, the whole body is one at-rest receipt
 *   ask-failed-fail-open  no ask turn and no rewind after the landed result
 *   below-floor       a landed result under the floor; never a unit
 *   trailing-gap      forget-with-partials, the marker after the kept lines
 *
 * ## Determinism
 *
 * No clock, no randomness, no network: the session id, the arm root, the base
 * timestamp and every body line are constants, so two runs write byte-identical
 * files. Every file is written with an explicit `\n` and the directory carries
 * its own `.gitattributes` (`* text eol=lf`), so a checkout on a device with
 * `core.autocrlf=true` reads the same bytes the pin was taken over.
 *
 * ## The shape is the shipped shape
 *
 * A shaped body is not retyped here: it comes from `renderShapeTurn` and
 * `composeEntryShapeTurn`, the same two functions the entry seam lands, and the
 * ask prompt from `entryAskMessage`, the receipt from `receiptLine`. So the
 * fixture cannot disagree with the product about what a marker, a summary prefix
 * or a receipt looks like — only about which lines were kept.
 *
 * ## The composition rules come from the converter
 *
 * `expected-composition.json` carries the converter's own `compositionRules`
 * block, read out of `dev/bench/multiturn/live-convert.mjs` at build time. The
 * plan forbids a second definition of the six classes, so the fixture stores the
 * first one verbatim and the test checks that the stored copy is still the
 * converter's.
 *
 * Exit: 0 = files written; 2 = a bad argument or a failed invariant.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { optionsOf, parseDevArgs } from '../../../shared/args.mjs';
import { samePath } from '../../../shared/paths.mjs';
import { fileURLToPath } from 'node:url';
import {
  byteRangeForLines, entryAskMessage, receiptLine, renderShapeTurn, splitLineOffsets,
} from '@cremator/core';
import { composeEntryShapeTurn, entryAskFacts } from 'cremator-dsh';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CONVERTER = resolve(REPO_ROOT, 'dev', 'bench', 'multiturn', 'live-convert.mjs');

/** The per-model landed floor the converter defaults to (`config.ts:80`). */
const FLOOR = 1280;
const SESSION_ID = 'session-sim-5f1c0a2e';
/** A fictional arm root: the fixture must not name a real home directory. */
const ARM_ROOT = 'C:\\sim\\arm';
/** A fixed date and base timestamp, so no clock reaches the bytes. */
const BUILT_ON = '2026-10-27';
const BASE_TIME = 1_760_000_000_000;
/** The at-rest proof burn's recall id: a fixed 64-hex id, not a minted archive. */
const RECEIPT_RECALL_ID = `recall:sha256:${'7'.repeat(64)}`;
const TRANSCRIPT = 'sim.session.v4.jsonl';
/** The control arm: the same reads landed whole, no ask and no rewrite. */
const CONTROL = 'sim-control.session.v4.jsonl';
const MANIFEST = 'manifest.json';
const EXPECTED = 'expected-composition.json';
const SHA_FILE = 'sha256.txt';

/**
 * The reasoning fixture. The range is a PREFIX, not an interior window: the
 * excerpt has to carry the session row, the system prompt and the first tool
 * header, and only step 1 does. The smallest such prefix that holds both floors
 * ends at step 80; the recording's first native compaction opens at step 140,
 * so the cut is before it. The full source is the 2026-10-29 full-rerun vanilla
 * arm (`session-fab6632e-…`), the tree's only real recording.
 */
const REASONING_TRANSCRIPT = 'sim.reasoning.session.v4.jsonl';
const REASONING_USAGE = 'sim.reasoning.result.json';
const REASONING_MIN_ASSISTANT_TURNS = 60;
const REASONING_MIN_REASONING_PARTS = 60;
const REASONING_LAST_STEP = 139;

/**
 * The prunes fixture: the smallest PREFIX of the same recording that carries at
 * least 20 `compaction/prune` rows and at least 30 assistant turns with a
 * reasoning part. A prefix again, because the system row (seq 7) and the first
 * `request/header` (seq 12) are rows of step 1: a range that starts later cannot
 * carry them. The recording's first prunes land at step 83 (53
 * rows, each with its own replacement row at the next seq), and step 83 already
 * carries 61 reasoning turns, so the prefix ends at 83 — before the first native
 * compaction opens at step 140, which keeps `readTimeline` replayable with no
 * `--segment`. This is the cut ISSUE-190's two-arm comparison needs: unlike
 * steps 1-80, it has a host pruner layer for `--allow-host-pruner` to replay and
 * `--ignore-host-prunes` to skip.
 */
const PRUNES_TRANSCRIPT = 'sim.prunes.session.v4.jsonl';
const PRUNES_USAGE = 'sim.prunes.result.json';
const PRUNES_MIN_PRUNE_ROWS = 20;
const PRUNES_MIN_REASONING_TURNS = 30;
const PRUNES_LAST_STEP = 139;
const EVIDENCE_ROOT = resolve(REPO_ROOT, 'scratchpad', 'launch', '2026-10-29-full-rerun',
  'worlds', 'vanilla', 'evidence');
/** The session directory embeds the device's workspace label, so match the id. */
const EVIDENCE_SESSION_PREFIX = 'session-fab6632e-';
/** The source bytes are pinned: a changed source refuses instead of drifting. */
const EVIDENCE_SESSION_SHA256 = '9fb0584e1bd45ef1526c7942400fbaf82e5a9ca012af4621de170ef85ab8ff0c';
const EVIDENCE_RESULT_SHA256 = 'bbd79b8087b7aeff7e3e0a3b71d88d2915032e264dbd33f25944c5f969f6cfdb';

function usage() {
  return 'usage: node dev/bench/fixtures/sim/build-fixture.mjs --verify'
    + ' | node dev/bench/fixtures/sim/build-fixture.mjs --out <fresh-dir>';
}

const BUILD_FIXTURE_OPTIONS = optionsOf([['--out', 'string'], ['--verify', 'boolean']]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: BUILD_FIXTURE_OPTIONS,
    usage,
    help: () => `${usage()}\n`,
  });
  return { out: values.out ?? HERE, verify: values.verify === true };
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const byteLength = text => Buffer.byteLength(text, 'utf8');

/** One line of a listing: a fixed tag, a padded number, a fixed filler. */
function lineOf(tag, index) {
  return `${tag} line ${String(index).padStart(3, '0')} ${'.'.repeat(48)}`;
}

/** A listing body that ends with a newline, as a real read result does. */
function listingOf(tag, count) {
  const lines = Array.from({ length: count }, (_, i) => lineOf(tag, i + 1));
  return `${lines.join('\n')}\n`;
}

/**
 * The eight moments, in transcript order. `keep` is the answer's kept-line
 * selection for a forget (line numbers of the landed body, 1-based, inclusive);
 * the forgotten ranges are its complement, so the answer text and the shaped body
 * come from one selection and cannot disagree.
 */
const MOMENTS = [
  { name: 'lead-gap', step: 1, askStep: 2, kind: 'forget-with-partials',
    callId: 'call_sim_alpha', file: 'alpha.txt', tag: 'alpha', lines: 40,
    keep: [[4, 41]], summary: 'alpha service log: header and tail retained' },
  { name: 'multi-gap', step: 3, askStep: 4, kind: 'forget-with-partials',
    callId: 'call_sim_bravo', file: 'bravo.txt', tag: 'bravo', lines: 24,
    keep: [[1, 2], [6, 8], [12, 14]], summary: 'bravo tree listing: three spans retained' },
  { name: 'forget-all', step: 5, askStep: 6, kind: 'forget-all',
    callId: 'call_sim_charlie', file: 'charlie.txt', tag: 'charlie', lines: 30,
    keep: [], summary: 'charlie dump: nothing retained' },
  { name: 'keepall', step: 7, askStep: 8, kind: 'keepall',
    callId: 'call_sim_delta', file: 'delta.txt', tag: 'delta', lines: 24 },
  { name: 'machinery', step: 9, atRestStep: 10, kind: 'machinery',
    callId: 'call_sim_echo', file: 'echo.txt', tag: 'echo', lines: 26 },
  { name: 'ask-failed-fail-open', step: 11, kind: 'fail-open',
    callId: 'call_sim_foxtrot', file: 'foxtrot.txt', tag: 'foxtrot', lines: 22 },
  { name: 'below-floor', step: 12, kind: 'below-floor',
    callId: 'call_sim_golf', file: 'golf.txt', tag: 'golf', lines: 4 },
  { name: 'trailing-gap', step: 13, askStep: 14, kind: 'forget-with-partials',
    callId: 'call_sim_hotel', file: 'hotel.txt', tag: 'hotel', lines: 20,
    keep: [[1, 8]], summary: 'hotel config: first eight lines retained' },
];

/** The complement of `keep` over `total` lines, as the answer's forgotten spans. */
function forgottenRanges(keep, total) {
  const kept = new Set();
  for (const [from, to] of keep) {
    for (let line = from; line <= to; line += 1) kept.add(line);
  }
  const spans = [];
  for (let line = 1; line <= total; line += 1) {
    if (kept.has(line)) continue;
    const previous = spans[spans.length - 1];
    if (previous !== undefined && previous[1] === line - 1) previous[1] = line;
    else spans.push([line, line]);
  }
  return spans;
}

/**
 * The converter's `compositionRules`, read out of its source and evaluated. The
 * block is a plain object literal whose only free name is `opts.floor`, so an
 * evaluated read is faithful; a regex scrape of the strings would not be. A
 * missing block is a refusal: the fixture must never ship an unstated rule.
 */
function compositionRulesOf() {
  const source = readFileSync(CONVERTER, 'utf8');
  const block = /const compositionRules = (\{[\s\S]*?\n {2}\});/.exec(source);
  if (block === null) {
    throw new Error(`composition-rules-absent: no compositionRules block in ${CONVERTER}`);
  }
  return new Function('opts', `return ${block[1]};`)({ floor: FLOOR });
}

/** The transcript, and the expectations that follow from building it. */
function buildTranscript({ control = false } = {}) {
  const rows = [];
  let seq = 0;
  let time = BASE_TIME;
  let controlStep = 0;
  const push = (type, data, extra = {}) => {
    seq += 1;
    time += 1000;
    rows.push({ type, seq, time, data, ...extra });
    return seq;
  };
  const append = { surfaceOp: 'append' };
  const assistant = (step, text) => push('assistant/message', {
    turn: 1, step, usage: { inputTokens: 1000 + step * 10, outputTokens: 12 },
    message: {
      role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'a6', model: 'deepseek-v4.1-flash-1017' },
    },
  }, append);
  const toolResult = (step, callId, text, extra = append) => push('tool/result', {
    turn: 1, step,
    message: {
      role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [{ type: 'text', text }],
    },
  }, extra);

  rows.push({
    type: 'session', version: 4, id: SESSION_ID, createdAt: BASE_TIME,
    cwd: ARM_ROOT, isSeeded: false, delegationDepth: 0,
  });
  push('turn/start', { turn: 1 });

  const moments = [];
  for (const moment of MOMENTS) {
    const path = `${ARM_ROOT}\\${moment.file}`;
    const body = listingOf(moment.tag, moment.lines);
    const original = `<path>${path}</path>\n${body}`;
    const originalBytes = Buffer.from(original, 'utf8');
    if (moment.kind === 'below-floor') {
      if (originalBytes.length >= FLOOR) {
        throw new Error(`below-floor-moment-too-big: ${moment.name} is ${originalBytes.length} B`);
      }
    } else if (originalBytes.length < FLOOR) {
      throw new Error(`moment-below-floor: ${moment.name} is ${originalBytes.length} B`);
    }
    const totalLines = splitLineOffsets(originalBytes).length;

    // The read step: assistant prose, the call, the whole result landed.
    controlStep += 1;
    const step = control ? controlStep : moment.step;
    push('step/start', { turn: 1, step });
    assistant(step, `reading ${moment.file}`);
    push('tool/call', {
      turn: 1, step, callId: moment.callId, name: 'read',
      arguments: JSON.stringify({ file_path: path }),
    });
    const resultSeq = toolResult(step, moment.callId, original);
    push('step/end', { turn: 1, step });

    const record = {
      name: moment.name, seq: resultSeq, step, path,
      originalSha256: sha256(originalBytes), bytes: originalBytes.length,
      class: null, keptBytes: null, gaps: 0, markerBytes: 0, summaryBytes: 0,
      framingBytes: null, droppedBytes: 0, recallId: null, ranges: null,
    };

    if (control) {
      // The control arm is the same reads with nothing removed: no ask turn, no
      // replace. Its composition is not a decision at all and is never scored.
      moments.push(record);
      continue;
    }

    if (moment.kind === 'fail-open') {
      // No ask turn follows, so the converter reads the result as ran: fail-open.
      record.class = 'ask-failed-fail-open';
      record.censoredClass = 'refused-ask';
      moments.push(record);
      continue;
    }
    if (moment.kind === 'below-floor') {
      // Never a unit: the floor excludes the row before composition is asked.
      record.class = 'below-floor';
      moments.push(record);
      continue;
    }

    if (moment.kind === 'machinery') {
      // The engine's own at-rest proof burn: one receipt line replaces the body.
      push('step/start', { turn: 1, step: moment.atRestStep });
      assistant(moment.atRestStep, 'verifying the at-rest proof');
      const receipt = receiptLine({
        path, ranges: [], label: null, recallId: RECEIPT_RECALL_ID,
      });
      toolResult(moment.atRestStep, moment.callId, receipt,
        { surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
          sourceEventSeqs: [resultSeq] });
      push('step/end', { turn: 1, step: moment.atRestStep });
      record.class = 'machinery-censored';
      record.censoredClass = 'machinery-at-rest-removal';
      record.receipt = { recallId: RECEIPT_RECALL_ID, target: path };
      moments.push(record);
      continue;
    }

    // A decision step: the ask prompt, the answer, and the exchange rewind the
    // mount writes in the FIRST node's own type — a contentless `user/message`.
    // The prompt's facts are the product's own: the visible line count and the
    // two-or-more spread quotes every tabled row shows (ADR-0042).
    push('step/start', { turn: 1, step: moment.askStep });
    const askSeq = push('user/message', {
      turn: 1, step: moment.askStep,
      content: [{ type: 'text', text: entryAskMessage(entryAskFacts(originalBytes)) }],
    }, append);
    const answerText = moment.kind === 'keepall'
      ? JSON.stringify({ keepall: true })
      : moment.kind === 'forget-all'
        ? JSON.stringify({ forgetall: moment.summary })
        : JSON.stringify({
          forgetlines: [...forgottenRanges(moment.keep, totalLines), moment.summary],
        });
    const answerSeq = assistant(moment.askStep, answerText);
    push('user/message', { turn: 1, step: moment.askStep, content: [] }, {
      surfaceOp: { op: 'replace', startSeq: askSeq, endSeq: answerSeq },
      sourceEventSeqs: [askSeq, answerSeq],
    });
    if (moment.kind === 'keepall') {
      // ONE rewind over the exchange and no replace at the result's own seq: the
      // surface rule the converter reads as keep-all.
      record.class = 'keepall';
      record.rewindSpan = { startSeq: askSeq, endSeq: answerSeq };
      record.keepallVia = 'surface-rewind';
      push('step/end', { turn: 1, step: moment.askStep });
      moments.push(record);
      continue;
    }
    // A forget: the shaped turn replaces the result at its OWN seq.
    const keptRanges = byteRangeForLines(originalBytes, moment.keep.map(([from, to]) =>
      ({ startLine: from, endLineInclusive: to })));
    const turn = renderShapeTurn({
      source: {
        nodeId: `sim-result-${moment.file}`,
        sha256: sha256(originalBytes),
        byteLength: originalBytes.length,
      },
      original: originalBytes,
      keptRanges,
      sessionId: SESSION_ID,
    });
    if (turn === null) throw new Error(`shape-turn-null: ${moment.name} dropped nothing`);
    const shapedBytes = composeEntryShapeTurn(moment.summary, turn.bytes);
    const shaped = Buffer.from(shapedBytes).toString('utf8');
    if (!Buffer.from(shaped, 'utf8').equals(Buffer.from(shapedBytes))) {
      throw new Error(`shape-not-round-trippable: ${moment.name}`);
    }
    toolResult(moment.askStep, moment.callId, shaped,
      { surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
        sourceEventSeqs: [resultSeq] });
    push('step/end', { turn: 1, step: moment.askStep });

    const keptBytes = keptRanges.reduce((sum, range) =>
      sum + range.endByteExclusive - range.startByte, 0);
    const markerBytes = byteLength(turn.marker);
    const summaryBytes = byteLength(`${moment.summary}\n\n`);
    const framingBytes = byteLength(shaped) - keptBytes - turn.gaps.length * markerBytes
      - summaryBytes;
    if (framingBytes !== 0) {
      throw new Error(`framing-nonzero: ${moment.name} leaves ${framingBytes} B of framing`);
    }
    record.class = turn.keptLines.length === 0 ? 'forget-all' : 'forget-with-partials';
    record.keptBytes = keptBytes;
    record.gaps = turn.gaps.length;
    record.markerBytes = markerBytes;
    record.summaryBytes = summaryBytes;
    record.framingBytes = framingBytes;
    record.droppedBytes = originalBytes.length - keptBytes;
    record.recallId = turn.recallId;
    record.ranges = turn.keptLines;
    record.marker = turn.marker.replace(/\n$/, '');
    record.shapedBytes = byteLength(shaped);
    record.shapedSha256 = sha256(Buffer.from(shapedBytes));
    moments.push(record);
  }

  push('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const text = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  if (text.includes('\r')) throw new Error('crlf-in-transcript');
  return { text, moments, steps: MOMENTS.length, rows: rows.length };
}

/** The six-line table, counted off the moment list in the converter's fixed order. */
function compositionTableOf(moments) {
  const count = name => moments.filter(moment => moment.class === name).length;
  return {
    keepall: count('keepall'),
    'forget-with-partials': count('forget-with-partials'),
    'forget-all': count('forget-all'),
    'ask-failed-fail-open': count('ask-failed-fail-open'),
    'below-floor': count('below-floor'),
    'machinery-censored': count('machinery-censored'),
  };
}

/**
 * The 2026-10-29 full-rerun vanilla evidence, located without a device path:
 * the session directory embeds the workspace label, so the one
 * `session-fab6632e-*` directory under `sessions/` is the match. Both source
 * files are pinned, so a changed source refuses instead of producing a quietly
 * different fixture.
 */
function evidenceFilesOf() {
  const sessionsRoot = join(EVIDENCE_ROOT, 'sessions');
  if (!existsSync(sessionsRoot)) {
    throw new Error(`reasoning-source-absent: ${sessionsRoot}`);
  }
  const found = [];
  for (const label of readdirSync(sessionsRoot).sort()) {
    const labelDir = join(sessionsRoot, label);
    if (!existsSync(labelDir)) continue;
    for (const session of readdirSync(labelDir).sort()) {
      if (!session.startsWith(EVIDENCE_SESSION_PREFIX)) continue;
      const file = join(labelDir, session, 'session.v4.jsonl');
      if (existsSync(file)) found.push(file);
    }
  }
  if (found.length !== 1) {
    throw new Error(`reasoning-source-session: expected one ${EVIDENCE_SESSION_PREFIX}`
      + ` directory, found ${found.length}`);
  }
  const usageFile = join(EVIDENCE_ROOT, 'result.json');
  if (!existsSync(usageFile)) throw new Error(`reasoning-source-absent: ${usageFile}`);
  const sessionSha256 = sha256(readFileSync(found[0]));
  if (sessionSha256 !== EVIDENCE_SESSION_SHA256) {
    throw new Error(`reasoning-source-changed: session is ${sessionSha256}`);
  }
  const resultSha256 = sha256(readFileSync(usageFile));
  if (resultSha256 !== EVIDENCE_RESULT_SHA256) {
    throw new Error(`reasoning-source-changed: result is ${resultSha256}`);
  }
  return { sessionFile: found[0], usageFile, sessionSha256, resultSha256 };
}

/**
 * The structural counts `readTimeline` keeps: every `type:"reasoning"` content
 * part (blank ones included), every `assistant/message` row, and every
 * `blockType:"reasoning"` stream entry. A substring count would count each part
 * four times, so the parts are read off the parsed rows.
 */
function reasoningCensusOf(rows) {
  let assistantTurns = 0;
  let reasoningParts = 0;
  let reasoningStreamBlocks = 0;
  for (const row of rows) {
    const content = Array.isArray(row?.data?.message?.content) ? row.data.message.content
      : Array.isArray(row?.data?.content) ? row.data.content : [];
    reasoningParts += content.filter(part => part?.type === 'reasoning').length;
    if (row?.type === 'assistant/message') assistantTurns += 1;
    for (const entry of Array.isArray(row?.data?.stream) ? row.data.stream : []) {
      if (entry?.blockType === 'reasoning' || entry?.chunk?.blockType === 'reasoning') {
        reasoningStreamBlocks += 1;
      }
    }
  }
  return { assistantTurns, reasoningParts, reasoningStreamBlocks };
}

/** The last `step/start` at or before a row's seq: the row's owning step. */
function stepOwnerOf(rows) {
  const starts = rows
    .filter(row => row?.type === 'step/start' && Number.isSafeInteger(row.data?.step))
    .map(row => ({ seq: row.seq, step: row.data.step }));
  return row => {
    if (!Number.isSafeInteger(row?.seq)) return null;
    let step = null;
    for (const entry of starts) {
      if (entry.seq > row.seq) break;
      step = entry.step;
    }
    return step;
  };
}

/**
 * The smallest PREFIX of the recording that carries both floors. A prefix, not
 * an interior window, because the excerpt must carry the session row, the
 * system prompt and the first tool header, and only step 1 carries those. The
 * first native compaction opens at step 140, so ending at or before 139 keeps
 * `readTimeline` replayable with no `--segment`.
 */
function selectReasoningPrefix(rows) {
  const steps = rows
    .filter(row => row?.type === 'step/start' && Number.isSafeInteger(row.data?.step))
    .map(row => row.data.step);
  if (steps.length === 0) throw new Error('reasoning-steps-absent: the source declares no step/start');
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] !== steps[index - 1] + 1) {
      throw new Error(`reasoning-steps-not-contiguous: ${steps[index - 1]} then ${steps[index]}`);
    }
  }
  const ownerOf = stepOwnerOf(rows);
  const byStep = new Map(steps.map(step => [step, { assistantTurns: 0, reasoningParts: 0 }]));
  for (const row of rows) {
    const owner = ownerOf(row) ?? (Number.isSafeInteger(row?.data?.step) ? row.data.step : null);
    const bin = byStep.get(owner);
    if (bin === undefined) continue;
    const census = reasoningCensusOf([row]);
    bin.assistantTurns += census.assistantTurns;
    bin.reasoningParts += census.reasoningParts;
  }
  let assistantTurns = 0;
  let reasoningParts = 0;
  for (const step of steps) {
    if (step > REASONING_LAST_STEP) break;
    const bin = byStep.get(step);
    assistantTurns += bin.assistantTurns;
    reasoningParts += bin.reasoningParts;
    if (assistantTurns >= REASONING_MIN_ASSISTANT_TURNS
      && reasoningParts >= REASONING_MIN_REASONING_PARTS) {
      return { start: steps[0], end: step, assistantTurns, reasoningParts };
    }
  }
  throw new Error(`reasoning-floor-unmet: no prefix at or before step ${REASONING_LAST_STEP}`
    + ` reaches ${REASONING_MIN_ASSISTANT_TURNS} assistant turns and`
    + ` ${REASONING_MIN_REASONING_PARTS} reasoning parts`);
}

/** The row count of the prefix through the last row owned by `end`. */
function prefixLengthThrough(rows, end) {
  const ownerOf = stepOwnerOf(rows);
  let cut = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (ownerOf(rows[index]) === end) cut = index;
  }
  if (cut === -1) throw new Error(`reasoning-prefix-absent: no row owns step ${end}`);
  return cut + 1;
}

/** A file's physical line count, with or without a trailing newline. */
function lineCountOf(text) {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * The source recording's rows and their physical lines. A cut keeps the
 * source's own bytes: the lines are sliced as text, never re-serialized, so a
 * committed fixture cannot drift from the recording it claims to be a cut of.
 */
function sourceRowsOf(source, tag) {
  const raw = readFileSync(source.sessionFile, 'utf8');
  if (raw.includes('\r')) throw new Error(`${tag}-source-crlf: the source carries a CR`);
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${tag}-source-json: line ${index + 1} is not JSON`);
    }
  });
  if (rows[0]?.type !== 'session') {
    throw new Error(`${tag}-session-not-first: the prefix cannot carry the session row`);
  }
  return { lines, rows };
}

/** Assistant turns that carry at least one `type:"reasoning"` content part. */
function turnsWithReasoningOf(rows) {
  let turns = 0;
  for (const row of rows) {
    if (row?.type !== 'assistant/message') continue;
    const content = Array.isArray(row?.data?.message?.content) ? row.data.message.content : [];
    if (content.some(part => part?.type === 'reasoning')) turns += 1;
  }
  return turns;
}

/**
 * The smallest PREFIX of the recording that carries both floors: at least
 * `PRUNES_MIN_PRUNE_ROWS` host prune journals and `PRUNES_MIN_REASONING_TURNS`
 * assistant turns with reasoning. A prefix for the same reason the reasoning
 * cut is one: the system row and the first tool header are rows of step 1.
 */
function selectPrunePrefix(rows) {
  const steps = rows
    .filter(row => row?.type === 'step/start' && Number.isSafeInteger(row.data?.step))
    .map(row => row.data.step);
  if (steps.length === 0) throw new Error('prunes-steps-absent: the source declares no step/start');
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] !== steps[index - 1] + 1) {
      throw new Error(`prunes-steps-not-contiguous: ${steps[index - 1]} then ${steps[index]}`);
    }
  }
  const ownerOf = stepOwnerOf(rows);
  const byStep = new Map(steps.map(step => [step,
    { pruneRows: 0, reasoningTurns: 0, reasoningParts: 0 }]));
  for (const row of rows) {
    const owner = ownerOf(row) ?? (Number.isSafeInteger(row?.data?.step) ? row.data.step : null);
    const bin = byStep.get(owner);
    if (bin === undefined) continue;
    if (row?.type === 'compaction/prune') bin.pruneRows += 1;
    if (row?.type === 'assistant/message') {
      const content = Array.isArray(row?.data?.message?.content) ? row.data.message.content : [];
      const parts = content.filter(part => part?.type === 'reasoning').length;
      bin.reasoningParts += parts;
      if (parts > 0) bin.reasoningTurns += 1;
    }
  }
  let pruneRows = 0;
  let reasoningTurns = 0;
  let reasoningParts = 0;
  for (const step of steps) {
    if (step > PRUNES_LAST_STEP) break;
    const bin = byStep.get(step);
    pruneRows += bin.pruneRows;
    reasoningTurns += bin.reasoningTurns;
    reasoningParts += bin.reasoningParts;
    if (pruneRows >= PRUNES_MIN_PRUNE_ROWS
      && reasoningTurns >= PRUNES_MIN_REASONING_TURNS) {
      return { start: steps[0], end: step, pruneRows, reasoningTurns, reasoningParts };
    }
  }
  throw new Error(`prunes-floor-unmet: no prefix at or before step ${PRUNES_LAST_STEP}`
    + ` reaches ${PRUNES_MIN_PRUNE_ROWS} compaction/prune rows and`
    + ` ${PRUNES_MIN_REASONING_TURNS} assistant turns with reasoning`);
}

/**
 * One committed cut of the source recording: the rows through `range.end`, kept
 * as the source's own bytes, plus the usage rows for the same steps. Both files
 * are pinned by sha256, bytes, line count and the structural counts
 * `readTimeline` reports. The caller names the files, the selection sentence,
 * the usage note and any per-cut counts that belong in the manifest.
 */
function writeCutFixture({
  outDir, rows, lines, range, source, transcript, usage, selection, usageNote, counts = {},
}) {
  const cut = prefixLengthThrough(rows, range.end);
  const keptRows = rows.slice(0, cut);
  const text = `${lines.slice(0, cut).join('\n')}\n`;
  if (text.endsWith('\r\n')) throw new Error('cut-prefix-crlf: the cut carries a CRLF');
  const census = reasoningCensusOf(keptRows);
  const declared = keptRows
    .filter(row => row?.type === 'step/start' && Number.isSafeInteger(row.data?.step))
    .map(row => row.data.step);
  if (declared.length !== range.end - range.start + 1) {
    throw new Error(`cut-step-rows: expected ${range.end - range.start + 1},`
      + ` found ${declared.length}`);
  }
  for (let index = 0; index < declared.length; index += 1) {
    if (declared[index] !== range.start + index) {
      throw new Error(`cut-step-rows: step ${range.start + index} is ${declared[index]}`);
    }
  }
  if (keptRows.some(row => row?.type === 'compaction/start')) {
    throw new Error('cut-compaction-in-range: the cut carries a compaction/start');
  }
  const header = keptRows.find(row => row?.type === 'request/header');
  if (header === undefined) throw new Error('cut-header-absent: the cut carries no request/header');
  const systemRow = keptRows.find(row => row?.type === 'system/message');
  if (systemRow === undefined) throw new Error('cut-system-absent: the cut carries no system/message');

  const usageRaw = JSON.parse(readFileSync(source.usageFile, 'utf8'));
  const sourceUsageRows = Array.isArray(usageRaw?.usage?.rows) ? usageRaw.usage.rows
    : Array.isArray(usageRaw?.rows) ? usageRaw.rows : null;
  if (sourceUsageRows === null) throw new Error('cut-usage-invalid: no usage.rows in result.json');
  const usageRows = sourceUsageRows
    .filter(row => Number.isSafeInteger(row?.step) && row.step >= range.start && row.step <= range.end)
    .sort((left, right) => left.step - right.step);
  if (usageRows.length !== range.end - range.start + 1) {
    throw new Error(`cut-usage-steps: expected ${range.end - range.start + 1},`
      + ` found ${usageRows.length}`);
  }
  for (let index = 0; index < usageRows.length; index += 1) {
    const row = usageRows[index];
    if (row.step !== range.start + index) {
      throw new Error(`cut-usage-steps: step ${range.start + index} is ${row?.step}`);
    }
    if (!Number.isSafeInteger(row.inputTokens) || !Number.isSafeInteger(row.cacheReadTokens)) {
      throw new Error(`cut-usage-row: step ${row.step} carries no input/cache count`);
    }
    if (row.billedTokens !== row.inputTokens + row.cacheReadTokens) {
      throw new Error(`cut-usage-row: step ${row.step} billedTokens is not input + cache`);
    }
  }
  const sumOf = key => usageRows.reduce((total, row) => total + row[key], 0);
  const usageText = `${JSON.stringify({
    schema: 'racoons-sim-usage/1',
    note: usageNote,
    source: {
      session: rows[0].id ?? null,
      sessionSha256: source.sessionSha256,
      resultSha256: source.resultSha256,
      stepRange: { start: range.start, end: range.end },
    },
    usageIsEstimated: usageRaw?.usageIsEstimated === true,
    usage: {
      rows: usageRows,
      inputTokens: sumOf('inputTokens'),
      outputTokens: sumOf('outputTokens'),
      totalTokens: sumOf('totalTokens'),
      billedPromptTokens: sumOf('billedTokens'),
      cacheReadTokens: sumOf('cacheReadTokens'),
    },
  }, null, 2)}\n`;

  writeAtomic(join(outDir, transcript), text);
  writeAtomic(join(outDir, usage), usageText);
  const transcriptBytes = readFileSync(join(outDir, transcript));
  const usageBytes = readFileSync(join(outDir, usage));
  return {
    transcript,
    usage,
    source: {
      evidence: 'scratchpad/launch/2026-10-29-full-rerun/worlds/vanilla/evidence',
      session: rows[0].id ?? null,
      sessionSha256: source.sessionSha256,
      resultSha256: source.resultSha256,
      selection,
    },
    stepRange: { start: range.start, end: range.end },
    steps: range.end - range.start + 1,
    rows: keptRows.length,
    usageRows: usageRows.length,
    assistantTurns: census.assistantTurns,
    reasoningParts: census.reasoningParts,
    reasoningStreamBlocks: census.reasoningStreamBlocks,
    ...counts,
    toolHeaderSeq: header.seq ?? null,
    systemRowSeq: systemRow.seq ?? null,
    files: {
      transcript: {
        sha256: sha256(transcriptBytes),
        bytes: transcriptBytes.length,
        lines: lineCountOf(text),
      },
      usage: {
        sha256: sha256(usageBytes),
        bytes: usageBytes.length,
        lines: lineCountOf(usageText),
      },
    },
  };
}

/**
 * The reasoning fixture: the smallest prefix carrying 60 assistant turns and 60
 * reasoning parts, before the first native compaction.
 */
function buildReasoningFixture(outDir) {
  const source = evidenceFilesOf();
  const { lines, rows } = sourceRowsOf(source, 'reasoning');
  const range = selectReasoningPrefix(rows);
  return writeCutFixture({
    outDir,
    rows,
    lines,
    range,
    source,
    transcript: REASONING_TRANSCRIPT,
    usage: REASONING_USAGE,
    selection: `the smallest prefix carrying at least ${REASONING_MIN_ASSISTANT_TURNS}`
      + ` assistant turns and ${REASONING_MIN_REASONING_PARTS} reasoning parts, cut at or`
      + ` before step ${REASONING_LAST_STEP} so it stays before the first native compaction`,
    usageNote: 'The 2026-10-29 full-rerun vanilla arm\'s usage rows for the reasoning'
      + ' fixture\'s step range, copied from evidence/result.json. The sums cover'
      + ' only the kept steps.',
  });
}

/**
 * The prunes fixture: the smallest prefix carrying at least 20
 * `compaction/prune` rows and 30 assistant turns with reasoning. It is the cut
 * the host-pruner two-arm comparison runs on; the reasoning fixture's 1-80 cut
 * stops before the recording's first prune and cannot separate the arms.
 */
function buildPrunesFixture(outDir) {
  const source = evidenceFilesOf();
  const { lines, rows } = sourceRowsOf(source, 'prunes');
  const range = selectPrunePrefix(rows);
  const cut = prefixLengthThrough(rows, range.end);
  const keptRows = rows.slice(0, cut);
  const pruneRows = keptRows.filter(row => row?.type === 'compaction/prune').length;
  if (pruneRows !== range.pruneRows) {
    throw new Error(`prunes-count: the range declares ${range.pruneRows}, the cut carries ${pruneRows}`);
  }
  const turnsWithReasoning = turnsWithReasoningOf(keptRows);
  if (turnsWithReasoning !== range.reasoningTurns) {
    throw new Error(`prunes-turns: the range declares ${range.reasoningTurns},`
      + ` the cut carries ${turnsWithReasoning}`);
  }
  return writeCutFixture({
    outDir,
    rows,
    lines,
    range,
    source,
    transcript: PRUNES_TRANSCRIPT,
    usage: PRUNES_USAGE,
    selection: `the smallest prefix carrying at least ${PRUNES_MIN_PRUNE_ROWS} compaction/prune`
      + ` rows and ${PRUNES_MIN_REASONING_TURNS} assistant turns with reasoning, cut at or`
      + ` before step ${PRUNES_LAST_STEP} so it stays before the first native compaction`,
    usageNote: 'The 2026-10-29 full-rerun vanilla arm\'s usage rows for the prunes'
      + ' fixture\'s step range, copied from evidence/result.json. The sums cover'
      + ' only the kept steps.',
    counts: { pruneRows, turnsWithReasoning },
  });
}

function assertSame(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`verify-mismatch: ${label} is ${JSON.stringify(actual)},`
      + ` pinned ${JSON.stringify(expected)}`);
  }
}

/** One pinned file's hash, byte size and physical line count. */
function verifyFile(outDir, name, pinned) {
  const file = join(outDir, name);
  if (!existsSync(file)) throw new Error(`verify-absent: ${file}`);
  const buffer = readFileSync(file);
  assertSame(`${name} sha256`, sha256(buffer), pinned.sha256);
  assertSame(`${name} bytes`, buffer.length, pinned.bytes);
  const text = buffer.toString('utf8');
  assertSame(`${name} lines`, lineCountOf(text), pinned.lines);
  return text;
}

/**
 * Recompute every pin this directory commits without rebuilding. The existing
 * fixture is checked through `sha256.txt` and its manifest arms; the reasoning
 * and prunes cuts through their own entries, including the structural counts.
 * Any mismatch exits non-zero, so a drifted fixture cannot pass as a rebuild.
 */
function verifyFixture(outDir) {
  const manifestFile = join(outDir, MANIFEST);
  if (!existsSync(manifestFile)) throw new Error(`verify-absent: ${manifestFile}`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  let checks = 0;
  const check = (label, actual, expected) => {
    checks += 1;
    assertSame(label, actual, expected);
  };
  const shaFile = join(outDir, SHA_FILE);
  if (!existsSync(shaFile)) throw new Error(`verify-absent: ${shaFile}`);
  for (const line of readFileSync(shaFile, 'utf8').split('\n').filter(Boolean)) {
    const digest = line.slice(0, 64);
    const name = line.slice(66);
    const file = join(outDir, name);
    if (!existsSync(file)) throw new Error(`verify-absent: ${file}`);
    check(`${name} sha256.txt`, sha256(readFileSync(file)), digest);
  }
  for (const [arm, entry] of Object.entries(manifest.arms ?? {})) {
    const file = resolve(outDir, entry.transcript);
    if (!existsSync(file)) throw new Error(`verify-absent: ${file}`);
    const buffer = readFileSync(file);
    check(`arm ${arm} sha256`, sha256(buffer), entry.sha256);
    check(`arm ${arm} rows`, lineCountOf(buffer.toString('utf8')), entry.rows);
  }

  for (const [name, entry] of [['reasoning', manifest.reasoning], ['prunes', manifest.prunes]]) {
    if (entry === undefined) {
      throw new Error(`verify-${name}-absent: manifest.json carries no ${name} entry`);
    }
    if (entry.files?.transcript === undefined || entry.files?.usage === undefined) {
      throw new Error(`verify-${name}-pins: the ${name} entry carries no files block`);
    }
    const transcriptText = verifyFile(outDir, entry.transcript, entry.files.transcript);
    const usageText = verifyFile(outDir, entry.usage, entry.files.usage);
    if (transcriptText.includes('\r')) {
      throw new Error(`verify-crlf: ${entry.transcript} carries a CR`);
    }
    const rows = transcriptText.split('\n').filter(Boolean).map(line => JSON.parse(line));
    check(`${name} ${entry.transcript} rows`, rows.length, entry.rows);
    const declared = rows
      .filter(row => row?.type === 'step/start' && Number.isSafeInteger(row.data?.step))
      .map(row => row.data.step);
    if (declared.length === 0) {
      throw new Error(`verify-steps-absent: ${entry.transcript} declares no step/start`);
    }
    check(`${name} stepRange.start`, Math.min(...declared), entry.stepRange.start);
    check(`${name} stepRange.end`, Math.max(...declared), entry.stepRange.end);
    check(`${name} step range length`, new Set(declared).size,
      entry.stepRange.end - entry.stepRange.start + 1);
    if (entry.steps !== undefined) {
      check(`${name} steps`, entry.stepRange.end - entry.stepRange.start + 1, entry.steps);
    }
    for (let index = 0; index < declared.length; index += 1) {
      check(`${name} step ${entry.stepRange.start + index}`, declared[index],
        entry.stepRange.start + index);
    }
    const census = reasoningCensusOf(rows);
    check(`${name} assistantTurns`, census.assistantTurns, entry.assistantTurns);
    check(`${name} reasoningParts`, census.reasoningParts, entry.reasoningParts);
    check(`${name} reasoningStreamBlocks`, census.reasoningStreamBlocks, entry.reasoningStreamBlocks);
    if (entry.pruneRows !== undefined) {
      check(`${name} pruneRows`, rows.filter(row => row?.type === 'compaction/prune').length,
        entry.pruneRows);
    }
    if (entry.turnsWithReasoning !== undefined) {
      check(`${name} turnsWithReasoning`, turnsWithReasoningOf(rows), entry.turnsWithReasoning);
    }
    const header = rows.find(row => row?.type === 'request/header');
    const systemRow = rows.find(row => row?.type === 'system/message');
    check(`${name} toolHeaderSeq`, header?.seq ?? null, entry.toolHeaderSeq);
    check(`${name} systemRowSeq`, systemRow?.seq ?? null, entry.systemRowSeq);

    const usage = JSON.parse(usageText);
    const usageRows = Array.isArray(usage?.usage?.rows) ? usage.usage.rows
      : Array.isArray(usage?.rows) ? usage.rows : [];
    check(`${name} usageRows`, usageRows.length, entry.usageRows);
    check(`${name} usage range length`, usageRows.length,
      entry.stepRange.end - entry.stepRange.start + 1);
    for (let index = 0; index < usageRows.length; index += 1) {
      check(`${name} usage step ${entry.stepRange.start + index}`, usageRows[index]?.step,
        entry.stepRange.start + index);
    }
  }
  process.stdout.write(`sim fixture verify: ok (${checks} checks)\n`);
}

function writeAtomic(path, text) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(REPO_ROOT, opts.out);
  if (opts.verify) {
    verifyFixture(outDir);
    return;
  }
  const hereDir = resolve(HERE);
  // The committed-dir refusal is a path identity, not a string: a case variant
  // of the same directory is still the committed directory.
  if (samePath(outDir, hereDir)) {
    throw new Error('build-fixture-sanitized: the committed reasoning and prunes cuts'
      + ' are sanitized; --verify is the supported path for this directory (a rebuild'
      + ' from the private source would write the owner\'s home path and private text'
      + ' back into the tree). Pass --out <fresh-dir> for an inspection build.');
  }
  if (!existsSync(join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js'))) {
    throw new Error('packages-missing: run `npm run build` before building the fixture');
  }
  const rules = compositionRulesOf();
  // A rules object that lost a class name would silently orphan the fixture.
  const expectedClasses = ['keepall', 'forget-with-partials', 'forget-all',
    'ask-failed-fail-open', 'machinery-censored', 'below-floor'];
  for (const name of expectedClasses) {
    if (typeof rules[name] !== 'string') throw new Error(`composition-rule-missing: ${name}`);
  }

  const built = buildTranscript();
  // The control arm: the same reads, landed whole, nothing removed. It exists so
  // the converter's two-arm join runs unchanged and `T1` is a real shared key
  // rather than a fixture that claims a pair it never had.
  const control = buildTranscript({ control: true });
  const table = compositionTableOf(built.moments);
  // The converter's own `compositions` block counts only units with a decision
  // composition: a below-floor landed row is no unit, and a machinery receipt is
  // no decision. The two non-decision lines get the `censoring` block instead,
  // so neither number is read as a decision total.
  const decisionClasses = ['keepall', 'forget-with-partials', 'forget-all', 'ask-failed-fail-open'];
  const compositions = Object.fromEntries(decisionClasses
    .map(name => [name, built.moments.filter(moment => moment.class === name).length])
    .filter(([, count]) => count > 0));
  const censoring = {
    'below-floor': built.moments.filter(moment => moment.class === 'below-floor').length,
    'machinery-censored': built.moments.filter(moment => moment.class === 'machinery-censored').length,
  };
  const units = built.moments.filter(moment => moment.class !== 'below-floor').length;

  writeAtomic(join(outDir, TRANSCRIPT), built.text);
  writeAtomic(join(outDir, CONTROL), control.text);
  const reasoning = buildReasoningFixture(outDir);
  const prunes = buildPrunesFixture(outDir);

  const transcriptSha = sha256(readFileSync(join(outDir, TRANSCRIPT)));
  const controlSha = sha256(readFileSync(join(outDir, CONTROL)));
  // The converter resolves `arms.<name>.transcript` against `fixtures/live/`, so
  // a sim manifest takes one `../` hop; the path also resolves correctly if that
  // base becomes the manifest's own directory (`fixtures/sim/../sim/...`).
  const manifest = {
    schema: 'racoons-live-fixture/1',
    fixture: 'sim',
    builtOn: BUILT_ON,
    note: 'Synthetic shape fixture: a known composition over the shipped renderers,'
      + ' built by build-fixture.mjs. No live record, no clock and no randomness reach'
      + ' these bytes. The `vanilla` arm is a control pass of the SAME reads landed'
      + ' whole: it makes the join real, and nothing in it is scored. This is a render'
      + ' oracle, never a performance sample.',
    arms: {
      racoons: {
        transcript: `../sim/${TRANSCRIPT}`,
        armRoot: ARM_ROOT,
        sessionId: SESSION_ID,
        rows: built.rows,
        sha256: transcriptSha,
      },
      vanilla: {
        transcript: `../sim/${CONTROL}`,
        armRoot: ARM_ROOT,
        sessionId: SESSION_ID,
        rows: control.rows,
        sha256: controlSha,
      },
    },
    pins: {
      note: 'The oracle lives in expected-composition.json. A change there is a change'
        + ' to this fixture, never a re-freeze.',
      floor: FLOOR,
      expected: EXPECTED,
      units,
      compositionTable: table,
    },
    reasoning,
    prunes,
  };
  writeAtomic(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  const expected = {
    schema: 'racoons-sim-composition/1',
    builtOn: BUILT_ON,
    floor: FLOOR,
    sessionId: SESSION_ID,
    transcript: TRANSCRIPT,
    transcriptSha256: transcriptSha,
    controlTranscript: CONTROL,
    controlSha256: controlSha,
    note: 'The composition this fixture was built to hold, and the five render terms'
      + ' of every shaped row. `compositionRules` is the converter\'s own block,'
      + ' copied at build time; the test checks the copy is still the converter\'s.',
    landedRows: built.moments.length,
    units,
    compositionTable: table,
    compositions,
    censoring,
    compositionRules: rules,
    moments: built.moments,
  };
  writeAtomic(join(outDir, EXPECTED), `${JSON.stringify(expected, null, 2)}\n`);

  const pinned = [EXPECTED, MANIFEST, TRANSCRIPT, CONTROL]
    .map(file => `${sha256(readFileSync(join(outDir, file)))}  ${file}`)
    .sort((left, right) => (left.slice(66) < right.slice(66) ? -1 : 1));
  writeAtomic(join(outDir, SHA_FILE), `${pinned.join('\n')}\n`);

  process.stdout.write(`sim fixture: rows=${built.rows} landed=${built.moments.length}`
    + ` units=${units} ${Object.entries(table).map(([name, count]) => `${name}=${count}`).join(' ')}\n`);
  process.stdout.write(`  reasoning: steps=${reasoning.stepRange.start}-${reasoning.stepRange.end}`
    + ` rows=${reasoning.rows} usageRows=${reasoning.usageRows}`
    + ` assistant=${reasoning.assistantTurns} parts=${reasoning.reasoningParts}`
    + ` stream=${reasoning.reasoningStreamBlocks}`
    + ` headerSeq=${reasoning.toolHeaderSeq} systemSeq=${reasoning.systemRowSeq}`
    + ` bytes=${reasoning.files.transcript.bytes}\n`);
  process.stdout.write(`  prunes: steps=${prunes.stepRange.start}-${prunes.stepRange.end}`
    + ` rows=${prunes.rows} usageRows=${prunes.usageRows}`
    + ` pruneRows=${prunes.pruneRows} turnsWithReasoning=${prunes.turnsWithReasoning}`
    + ` assistant=${prunes.assistantTurns} parts=${prunes.reasoningParts}`
    + ` headerSeq=${prunes.toolHeaderSeq} systemSeq=${prunes.systemRowSeq}`
    + ` bytes=${prunes.files.transcript.bytes}\n`);
  process.stdout.write(`  transcript sha ${transcriptSha.slice(0, 16)}\n`);
  process.stdout.write(`  wrote ${outDir}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(2);
  }
}

export {
  buildPrunesFixture, buildReasoningFixture, buildTranscript, compositionTableOf,
  compositionRulesOf, evidenceFilesOf, forgottenRanges, MOMENTS, reasoningCensusOf,
  selectPrunePrefix, selectReasoningPrefix, turnsWithReasoningOf, verifyFixture,
};
