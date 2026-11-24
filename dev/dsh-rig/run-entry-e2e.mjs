#!/usr/bin/env node
/**
 * Entry-lane end-to-end, offline, through the real dsh (ISSUE-058 chunk P3d).
 *
 * ONE compact session, one real `dsh` process, the loopback mock, the shipped
 * mount. It drives the corrected protocol over the size classes the entry gate
 * distinguishes and asserts the whole lane from the evidence the run leaves:
 * `requests.jsonl`, the session log, the mount's journal, and the ledger.
 *
 * What only this file can prove (everything else lives in a fast unit test):
 *
 *   a. the floor gate — exactly the over-floor results are asked, and an
 *      under-floor result is never asked and leaves NO journal ask line;
 *   b. keep-all — the exchange is rewound, the result's bytes and id are
 *      untouched, and a later step does not ask the same result again;
 *   c. forget — one atomic apply: the exchange rewind plus ONE appended shaped
 *      turn, with `landed = kept + gaps×markerBytes + summaryBytes + framing`
 *      checked and every term printed. `kept` is measured by locating the
 *      turn's non-marker bytes in the ORIGINAL result, so `framing` is the
 *      bytes that are neither summary, marker, nor kept result text — not a
 *      residual that is zero by construction;
 *   d. recall after a forget returns the ORIGINAL bytes, byte-exact, for the
 *      unit whose own marker named that id: the recall id is bound to its
 *      unit's receipt, so a crossed id/bytes pair fails by name;
 *   e. prefix discipline — the bytes main sent before the last shared position
 *      never change across the whole run;
 *   f. fail-open (ISSUE-181 4a) — an invalid answer is refused by name, the
 *      result keeps its bytes and id, the ask exchange is collapsed, and the
 *      task runs to its last step. `E2E_ENTRY_REFUSE=1` drives this leg; the
 *      healthy run asserts zero refusals instead.
 *
 * The answers are scripted through the mock's `answers.entry` array, one per
 * ask in ask order: keepall, forgetall, keeplines — one of each.
 *
 * Usage:
 *   node dev/dsh-rig/run-entry-e2e.mjs [--keep] [--verbose]
 *   E2E_ENTRY_REFUSE=1 node dev/dsh-rig/run-entry-e2e.mjs   (the fail-open leg)
 *
 * Exit 0 means every assertion passed; 1 names the first failure; 2 is a bad
 * argument. Evidence lands under `scratchpad/dsh-rig/<date>-entry-e2e/`.
 * Target wall clock: well under a minute, no network, no key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureDist } from './build-dist.mjs';
import { optionsOf, parseDevArgs } from '../shared/args.mjs';

const RIG_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(RIG_DIR));
const RUN = join(RIG_DIR, 'run.mjs');

/** The floor the scenario states, and the sizes each class is built from. */
const FLOOR_BYTES = 512;
/**
 * The perturbation hook (the rig's non-vacuity law). It moves ONE knob — the
 * floor — so a run whose gate is dead still starts and still answers, and the
 * checks below must then fail by name instead of passing for the wrong reason.
 * `E2E_FLOOR_BYTES=40000`: every result falls under the floor, so nothing is
 * asked, and "exactly the over-floor results were asked" is the first failure.
 */
const FLOOR_OVERRIDE = process.env.E2E_FLOOR_BYTES === undefined
  ? null : Number(process.env.E2E_FLOOR_BYTES);
/**
 * The second perturbation hook, and the fail-open leg's own scenario
 * (ISSUE-181 4a). `E2E_ENTRY_REFUSE=1` scripts the FIRST entry ask an answer
 * the reader refuses — `{"1":{"keephead":true}}`, valid JSON naming row 1 with
 * an action this grammar does not offer — so the mount journals
 * `entry-ask-refused`, collapses its ask exchange, leaves the result landed
 * whole and runs the task to its last step. The healthy run asserts zero
 * refusals; this leg asserts the refusal BY NAME, so a mount that ignored it
 * cannot pass.
 */
const ENTRY_REFUSAL = process.env.E2E_ENTRY_REFUSE === '1';
/** The refused answer: row 1, an action the shipped grammar does not offer. */
const REFUSED_ANSWER = '{"1":{"keephead":true}}';
/** The refusal code the table reader names for that answer. */
const REFUSED_CODE = 'action-not-in-grammar';

/** Under the floor: ~300 B, so no ask can be about it. */
const SMALL_LINES = 3;
/** Between the floor and the bulk bar: ~2 KB. */
const MIDDLE_LINES = 24;
/** Far above both: ~20 KB. */
const BIG_LINES = 240;
/** Line width shared by every scripted body, so the classes stay comparable. */
const LINE_WIDTH = 78;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const ENTRY_E2E_OPTIONS = optionsOf([
  ['--keep', 'boolean'],
  ['--verbose', 'boolean'],
]);

function parseArgs(argv) {
  const { values } = parseDevArgs(argv, {
    options: ENTRY_E2E_OPTIONS,
    refuse: (message) => {
      process.stderr.write(`run-entry-e2e: ${message}\n`);
      process.exit(2);
    },
    help: 'usage: node dev/dsh-rig/run-entry-e2e.mjs [--keep] [--verbose]\n',
  });
  return { keep: values.keep ?? false, verbose: values.verbose ?? false };
}

/** One PowerShell body of `lines` numbered lines, each `LINE_WIDTH` bytes. */
function pwshBody(tag, lines) {
  return `1..${String(lines)} | ForEach-Object { "${tag} $_ " + ('x' * ${String(LINE_WIDTH)}) }`;
}

/**
 * The scenario. ONE session, four steps:
 *
 *   step 1  two results in one step (the parallel shape): SMALL (under floor,
 *           never asked) and MIDDLE (between floor and bar, asked → keepall)
 *   step 2  BIG (above the bar, asked → forgetall)
 *   step 3  MIDDLE again? No — a second MIDDLE (asked → keeplines), which also
 *           proves step 1's keep-all result is not re-asked
 *   step 4  a plain text answer, so the last request exists to be checked
 *
 * Every step is a separate `tool_use` reply, so each result lands in its own
 * step and the multi-step seed path is exercised (the P3c-2 blocker).
 */
function scenario() {
  // The queue the mock serves one answer per ask. The refusal leg changes slot
  // 1 only: slot 2 (forgetall) and slot 3 (keeplines) stay, because a refused
  // ask still consumes its slot. So the refusal leg still exercises both
  // forget shapes and the recall of their units.
  const entry = [
    { type: 'text', text: '{"1":{"keepall":true}}' },
    { type: 'text', text: '{"1":{"forgetall":true,"summary":"an old numbered listing"}}' },
    { type: 'text', text: '{"1":{"keeplines":[[1,4]],"summary":"kept the head of the listing"}}' },
  ];
  if (ENTRY_REFUSAL) entry[0] = { type: 'text', text: REFUSED_ANSWER };
  return {
    slug: 'entry-e2e',
    task: 'Run each PowerShell command I ask for, in order, and report when all are done.',
    timeoutMs: 90000,
    notes: 'ISSUE-058 chunk P3d. One session proves the entry lane end to end: floor gate, '
      + 'keep-all rewind, forgetall and keeplines as one atomic rewind+append each, byte-exact '
      + 'recall of a forgotten body, and prefix discipline across every apply.',
    perturbation: 'two hooks, each driven by run-entry-e2e.test.mjs: E2E_FLOOR_BYTES=40000 moves '
      + 'every result under the floor, so nothing is asked and the runner must fail by name on '
      + '"exactly the over-floor results were asked"; E2E_ENTRY_REFUSE=1 scripts an invalid first '
      + 'entry answer, so the runner must assert that refusal by name, the result whole and the '
      + 'task running to its last step (ISSUE-181 4a)',
    // The title call is a second request that would seed the fork from a
    // title prompt; the entry lane cannot use it, so it is off.
    patches: ['- id: session-title-llm', '  disabled: true'],
    workFiles: {},
    racoons: {
      floorBytes: FLOOR_OVERRIDE ?? FLOOR_BYTES,
      // The bulk bar is held far above every body, so the judge and the prune
      // never see these results: this run measures the ENTRY lane alone.
      barBytes: 200000,
      anchors: 'off',
      // ADR-0050 decision 4: the mount's absent default is `off`, so this
      // entry-lane run selects the explicit count compatibility trigger.
      entryAskTrigger: { mode: 'count' },
    },
    script: {
      title: 'Entry lane E2E',
      // One reply object is served to every entry ask OR an array one per ask,
      // in ask order, the last repeating. The ask is the shipped `jsonl-20`
      // one-row table (`{"N": {…}}`, one object per line), so each answer names
      // row 1 in that grammar. The refusal leg replaces slot 1 only.
      answers: { entry },
      replies: [
        { name: 'step-1-two-results',
          match: { tools_length: 'present', tool_results_count: 0 },
          reply: { type: 'tool_use', text: 'Running the two small ones.',
            calls: [
              { id: 'rig_small_1', name: 'pwsh',
                input: { description: 'three short lines', command: pwshBody('small', SMALL_LINES) } },
              { id: 'rig_middle_1', name: 'pwsh',
                input: { description: 'twenty-four lines', command: pwshBody('middle', MIDDLE_LINES) } },
            ] } },
        { name: 'step-2-big',
          match: { tools_length: 'present', tool_results_count: 2 },
          reply: { type: 'tool_use', text: 'Running the big one.',
            calls: [
              { id: 'rig_big_1', name: 'pwsh',
                input: { description: 'two hundred forty lines', command: pwshBody('big', BIG_LINES) } },
            ] } },
        { name: 'step-3-middle-again',
          match: { tools_length: 'present', tool_results_count: 3 },
          reply: { type: 'tool_use', text: 'Running one more.',
            calls: [
              { id: 'rig_middle_2', name: 'pwsh',
                input: { description: 'twenty-four lines', command: pwshBody('again', MIDDLE_LINES) } },
            ] } },
        { name: 'step-4-report',
          match: { tools_length: 'present', tool_results_count: 4 },
          reply: { type: 'text', text: 'All four commands ran.' } },
      ],
    },
    expect: {
      exitCode: 0,
      mock: { mainRequests: 4, noMatchRecords: 0, allRequestsUsedDummyKey: true },
      // ISSUE-181 4a: the entry lane's own accounting, read by run.mjs. The
      // healthy run answers all three asks; the refusal leg refuses the first
      // and answers the other two; the floor leg asks nothing at all (every
      // result is under the floor), which its own runner assertion then names.
      // A run that ignores the refusal lands in the refused count and fails.
      racoons: { entryAsks: FLOOR_OVERRIDE !== null
        ? { accepted: 0, refused: 0 }
        : ENTRY_REFUSAL ? { accepted: 2, refused: 1 } : { accepted: 3, refused: 0 } },
    },
  };
}

// ── assertions ─────────────────────────────────────────────────────────────

/** One collection of named checks, in the rig's own style. */
function checker() {
  const results = [];
  return {
    results,
    check(name, fn) {
      let ok = false;
      let detail;
      try {
        const outcome = fn();
        ok = outcome === true;
        if (!ok) detail = typeof outcome === 'string' ? outcome : 'expectation not met';
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      results.push({ name, ok, detail });
      return ok;
    },
  };
}

const textOfBlocks = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text).join('');

/** One session event's model-visible body, by event type. */
function bodyOf(event) {
  const content = event?.type === 'user/message'
    ? event?.data?.content : event?.data?.message?.content;
  return textOfBlocks(content);
}

/** The call id one `tool/result` event names, from either host spelling. */
function callIdOf(event) {
  const message = event?.data?.message ?? {};
  return message?.source?.callId ?? message?.toolCallId ?? null;
}

/** Read a JSONL file into an array; a missing file is an empty list. */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** The one `session.v4.jsonl` a run leaves, or null. */
function findSessionLog(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl') out.push(full);
    }
  };
  walk(root);
  return out.length === 1 ? out[0] : null;
}

/**
 * The longest prefix two message arrays share, compared by canonical JSON.
 * This is the KV-cache test: everything before the shared position is a hit.
 */
function sharedPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length
    && JSON.stringify(a[index]) === JSON.stringify(b[index])) index += 1;
  return index;
}

/** The whole main-wire conversation one mock record carried. */
const mainOf = (record) => (Array.isArray(record?.body?.messages) ? record.body.messages : []);

/**
 * The summary prefix a shaped turn opens with, as the mount writes it
 * (`entryShapePrefix`): the answer's note collapsed to one line, then one blank
 * line; nothing at all when the note is blank.
 */
function shapePrefixOf(summary) {
  const line = String(summary ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ').trim();
  return line.length === 0 ? Buffer.alloc(0) : Buffer.from(`${line}\n\n`, 'utf8');
}

/** The shipped marker templates' opening, which no kept line of these bodies starts with. */
const MARKER_PREFIX = Buffer.from('[racoons] kept ', 'utf8');

/** True when a marker line starts at `index`: at the payload's start or after a newline. */
function markerStartsAt(payload, index) {
  if (index !== 0 && payload[index - 1] !== 0x0a) return false;
  return payload.subarray(index, index + MARKER_PREFIX.length).equals(MARKER_PREFIX);
}

/**
 * One shaped turn's payload split into the marker lines it carries and the runs
 * of kept text between them. The split is by BYTES, so CRLF and multibyte bytes
 * survive exactly; a marker block is a whole line ending in "\n" (`renderShaped`).
 */
function splitShapedPayload(payload) {
  const markers = [];
  const keptRuns = [];
  let cursor = 0;
  let runStart = 0;
  while (cursor < payload.length) {
    if (!markerStartsAt(payload, cursor)) { cursor += 1; continue; }
    if (cursor > runStart) keptRuns.push(payload.subarray(runStart, cursor));
    const newline = payload.indexOf(0x0a, cursor);
    const end = newline < 0 ? payload.length : newline + 1;
    markers.push(payload.subarray(cursor, end));
    cursor = end;
    runStart = end;
  }
  if (runStart < payload.length) keptRuns.push(payload.subarray(runStart));
  return { markers, keptRuns };
}

/**
 * How many of a shaped turn's kept-text bytes are byte-exact copies of the
 * ORIGINAL result, at whole-line starts, in source order. This is the measured
 * `kept` term: a byte the original does not hold is NOT counted here, so the
 * identity's `framing` residual is what the mount added around the copy.
 */
function attributeKept(keptRuns, original) {
  let kept = 0;
  let from = 0;
  for (const run of keptRuns) {
    if (run.length === 0) continue;
    let at = original.indexOf(run, from);
    while (at > 0 && original[at - 1] !== 0x0a) at = original.indexOf(run, at + 1);
    if (at < 0) continue;
    kept += run.length;
    from = at + run.length;
  }
  return kept;
}

/**
 * Every check the entry lane needs, read from one run's evidence.
 * @param {object} evidence - everything the run left, already parsed.
 */
export function assertEntryLane(evidence) {
  const { requests, sessionEvents, journal, originResults, recallRecords, options } = evidence;
  // ISSUE-181 4a: the refusal leg. `options.entryRefusal` is the runner's own
  // knob, so the same assertion set serves both legs and the healthy one keeps
  // its zero-refusal claim.
  const refusal = options?.entryRefusal === true;
  const c = checker();
  const mains = requests.filter((record) => record.kind === 'main');
  const entryAsks = requests.filter((record) => record.kind === 'entry');
  const asked = journal.filter((line) => line.kind === 'entry-ask');
  const refused = journal.filter((line) => line.kind === 'entry-ask-refused');
  const applied = journal.filter((line) => line.kind === 'entry-apply');
  const applyRefused = journal.filter((line) => line.kind === 'entry-apply-refused');
  const collapsed = journal.filter((line) => line.kind === 'entry-ask-collapsed');
  const off = journal.filter((line) => line.kind === 'entry-ask-off');
  // An ask is a request that left, whatever its answer then read as. The gate
  // assertion counts both journal kinds: a refused row was still asked (4a).
  const askLines = journal.filter((line) => line.kind === 'entry-ask'
    || line.kind === 'entry-ask-refused');

  /**
   * The live surface, rebuilt from the op markers exactly as dsh builds it:
   * `append` adds the seq, `replace` swaps the named range for the replacing
   * node. The log is append-only, so only this projection says what the next
   * model turn would have seen.
   */
  const liveSurface = () => {
    const surface = [];
    for (const event of sessionEvents) {
      const op = event.surfaceOp;
      if (op === 'append') { surface.push(event.seq); continue; }
      if (typeof op !== 'object' || op === null) continue;
      const start = surface.indexOf(op.startSeq);
      const end = surface.indexOf(op.endSeq);
      if (start < 0 || end < 0) continue;
      surface.splice(start, end - start + 1, event.seq);
    }
    return surface;
  };
  const nodeSeqOf = (nodeId) => {
    const tail = String(nodeId ?? '').split(':').pop();
    const seq = Number(tail);
    return Number.isSafeInteger(seq) ? seq : null;
  };

  /**
   * The landed results, in landing order, with their own bytes. A tool result
   * is identified by its call id; the body is the host's own rendered text.
   */
  const landed = originResults.map((event) => ({
    callId: callIdOf(event),
    bytes: Buffer.from(bodyOf(event), 'utf8'),
    turn: event.data?.turn,
    step: event.data?.step,
  }));
  const byCallId = new Map(landed.map((item) => [item.callId, item]));

  // ── (a) the floor gate ───────────────────────────────────────────────────
  // The floor this run actually used: the perturbation hook moves it, and the
  // assertion must follow the knob or a perturbed run would "pass" by measuring
  // a floor nobody mounted.
  const floorBytes = FLOOR_OVERRIDE ?? FLOOR_BYTES;
  c.check('exactly the over-floor results were asked', () => {
    const overFloor = landed.filter((item) => item.bytes.length >= floorBytes);
    const underFloor = landed.filter((item) => item.bytes.length < floorBytes);
    if (overFloor.length !== 3) {
      return `expected 3 over-floor results at floor ${String(floorBytes)}, saw ${overFloor.length}: ${JSON.stringify(landed.map((i) => [i.callId, i.bytes.length]))}`;
    }
    if (underFloor.length !== 1) {
      return `expected 1 under-floor result at floor ${String(floorBytes)}, saw ${underFloor.length}: ${JSON.stringify(landed.map((i) => [i.callId, i.bytes.length]))}`;
    }
    const askedCalls = askLines.map((line) => String(line.eventId).split(':').pop());
    const expected = overFloor.map((item) => item.callId);
    if (JSON.stringify(askedCalls) !== JSON.stringify(expected)) {
      return `expected asks for ${JSON.stringify(expected)}, saw ${JSON.stringify(askedCalls)}`;
    }
    return true;
  });

  c.check('the under-floor result was NEVER asked and left NO journal ask line', () => {
    const underFloor = landed.filter((item) => item.bytes.length < floorBytes);
    const small = underFloor[0];
    if (small === undefined) return 'no under-floor result landed';
    const id = `result:${small.callId}`;
    const named = [...asked, ...refused, ...off].filter((line) => String(line.eventId).endsWith(id));
    if (named.length > 0) {
      return `the under-floor result ${small.callId} has ${named.length} journal ask line(s): ${JSON.stringify(named.map((l) => l.kind))}`;
    }
    // And no entry request ever carried its body either.
    const carried = entryAsks.filter((record) => bodyOf({
      type: 'user/message', data: record.body?.messages?.at(-2) ?? {} }).includes('small 1 '));
    return carried.length === 0 ? true
      : `${carried.length} entry ask(s) carried the under-floor body`;
  });

  if (!refusal) {
    c.check('every over-floor result got exactly one answer, none refused', () => {
      if (asked.length !== 3) return `expected 3 entry-ask lines, saw ${asked.length}`;
      if (refused.length !== 0) return `expected 0 refusals, saw ${JSON.stringify(refused.map((l) => l.code))}`;
      if (applied.length !== 3) return `expected 3 entry-apply lines, saw ${applied.length}`;
      return true;
    });
  } else {
    // ── (a2) the refused entry ask (ISSUE-181 4a) ─────────────────────────
    // The FIRST over-floor result's scripted answer names an action the grammar
    // does not offer. The mount must journal that refusal by name, leave the
    // result's bytes and id untouched on the live surface, collapse the ask
    // exchange, and run the task to its last step. Each fact gets its own named
    // check, so a mount that ignored the refusal fails by exactly one of them.
    const overFloor = landed.filter((item) => item.bytes.length >= floorBytes);
    const refusedCall = overFloor[0]?.callId;
    const refusedLine = refused[0];
    c.check('the invalid entry answer was refused by name', () => {
      if (refusedCall === undefined) return 'no over-floor result landed';
      if (refused.length !== 1) {
        return `expected 1 entry-ask-refused line, saw ${refused.length}: ${JSON.stringify(refused.map((l) => [l.callId, l.code]))}`;
      }
      const line = refusedLine;
      if (line.callId !== refusedCall) {
        return `the refusal names ${String(line.callId)}, expected ${String(refusedCall)}`;
      }
      if (line.code !== REFUSED_CODE) {
        return `expected refusal code ${REFUSED_CODE}, saw ${String(line.code)}`;
      }
      if (line.retried !== false) {
        return `a non-arithmetic refusal must not retry, saw retried ${String(line.retried)}`;
      }
      if (!(line.turns >= 2)) {
        return `the refused answer never left as an ask/answer pair, saw ${String(line.turns)} turn(s)`;
      }
      if (asked.some((row) => row.eventId === line.eventId)) {
        return 'the refused result also has an entry-ask line: the refusal was read as accepted';
      }
      // Every over-floor result was asked once, the refused one included.
      const ids = askLines.map((row) => row.eventId);
      if (new Set(ids).size !== ids.length) return `a result was asked twice: ${JSON.stringify(ids)}`;
      return true;
    });

    c.check('the refused result kept its bytes and id on the live surface', () => {
      if (refusedCall === undefined) return 'no over-floor result to check';
      const origin = originResults.find((event) => callIdOf(event) === refusedCall);
      if (origin === undefined) return `the original result ${String(refusedCall)} is gone from the log`;
      // No apply of any kind names it: a refusal writes nothing.
      const appliedToIt = [...applied, ...applyRefused].filter((line) => line.callId === refusedCall);
      if (appliedToIt.length !== 0) {
        return `${appliedToIt.length} apply line(s) named the refused result: ${JSON.stringify(appliedToIt.map((line) => line.kind))}`;
      }
      const surface = liveSurface();
      const bySeq = new Map(sessionEvents.map((event) => [event.seq, event]));
      const live = surface.map((seq) => bySeq.get(seq))
        .filter((event) => event?.type === 'tool/result' && callIdOf(event) === refusedCall);
      if (live.length !== 1) {
        return `the refused result ${String(refusedCall)} is on the surface ${String(live.length)} time(s)`;
      }
      const original = byCallId.get(refusedCall);
      if (original === undefined) return `no landed copy of ${String(refusedCall)}`;
      if (bodyOf(live[0]) !== original.bytes.toString('utf8')) {
        return `the refused result ${String(refusedCall)} changed bytes on the surface`;
      }
      // And no replace names its node: no shaped turn was written for it.
      const replaces = sessionEvents.filter((event) => typeof event.surfaceOp === 'object'
        && event.surfaceOp !== null && event.surfaceOp.op === 'replace');
      const overResult = replaces.filter((event) => event.surfaceOp.startSeq === origin.seq
        || event.surfaceOp.endSeq === origin.seq);
      if (overResult.length !== 0) return `${String(overResult.length)} replace(s) named the refused result node`;
      return true;
    });

    c.check('the refused ask exchange was collapsed and the task ran to its last step', () => {
      if (refusedCall === undefined) return 'no over-floor result to check';
      if (collapsed.length !== 1) {
        return `expected 1 entry-ask-collapsed line, saw ${String(collapsed.length)}`;
      }
      const line = collapsed[0];
      if (String(line.resultNodeId).split(':').pop() !== refusedCall) {
        return `the collapse names ${String(line.resultNodeId)}, expected the refused result ${String(refusedCall)}`;
      }
      if (line.status === 'refused') return `the collapse was refused: ${String(line.code)}`;
      // The ask and its answer are gone from the live surface: the next model
      // turn cannot answer the stale question (ISSUE-185).
      const askSeq = nodeSeqOf(line.askNodeId);
      const answerSeq = nodeSeqOf(line.answerNodeId);
      if (askSeq === null || answerSeq === null) {
        return `the collapse names no readable ask/answer seq: ${JSON.stringify([line.askNodeId, line.answerNodeId])}`;
      }
      const surface = new Set(liveSurface());
      if (surface.has(askSeq) || surface.has(answerSeq)) {
        return `the ask/answer pair survived the collapse (${String(askSeq)}/${String(answerSeq)} still live)`;
      }
      // The task continued: every step's main request left, and the last
      // assistant turn is the scenario's closing report.
      if (mains.length !== 4) return `expected 4 main requests, saw ${String(mains.length)}`;
      const assistant = sessionEvents.filter((event) => event.type === 'assistant/message').at(-1);
      const closing = assistant === undefined ? '' : bodyOf(assistant);
      if (closing !== 'All four commands ran.') {
        return `the last assistant turn is ${JSON.stringify(closing)}, expected the closing report`;
      }
      return true;
    });
  }

  // ── (b) keep-all ─────────────────────────────────────────────────────────
  // The refusal leg scripts no keepall answer (slot 1 is the refused one), so
  // this arm belongs to the healthy leg alone.
  const keepall = asked.find((line) => line.action === 'keepall');
  if (!refusal) {
    c.check('keepall: the exchange was rewound and the result bytes and id untouched', () => {
      if (keepall === undefined) return 'no keepall answer';
      const apply = applied.find((line) => line.eventId === keepall.eventId);
      if (apply === undefined) return 'the keepall result was never applied';
      if (apply.status !== 'rewound') return `expected status 'rewound', saw ${JSON.stringify(apply.status)}`;
      if (apply.resultSeq !== null) return `a keep-all writes no result turn, saw resultSeq ${String(apply.resultSeq)}`;
      if (apply.appends !== 1) return `a keep-all is one append, saw ${String(apply.appends)}`;
      // The result node still holds its own bytes under its own id.
      const callId = String(keepall.eventId).split(':').pop();
      const item = byCallId.get(callId);
      if (item === undefined) return `the landed result ${String(callId)} is gone`;
      const stillThere = originResults.filter((event) => callIdOf(event) === callId);
      if (stillThere.length !== 1) return `expected one origin node for ${String(callId)}, saw ${stillThere.length}`;
      // No replace ever names the result node: a keep-all only rewinds the exchange.
      const replaces = sessionEvents.filter((event) => typeof event.surfaceOp === 'object'
        && event.surfaceOp !== null && event.surfaceOp.op === 'replace');
      const overResult = replaces.filter((event) => event.surfaceOp.startSeq === stillThere[0].seq
        || event.surfaceOp.endSeq === stillThere[0].seq);
      if (overResult.length !== 0) return `${overResult.length} replace(s) named the kept result node`;
      return true;
    });

    c.check('keepall: the exchange left the live surface, so a later step cannot re-ask it', () => {
      // The log is append-only, so an ask turn's EVENT survives every rewind;
      // what must not survive is the NODE. The live surface is rebuilt from the
      // op markers exactly as dsh builds it.
      const surface = liveSurface();
      const bySeq = new Map(sessionEvents.map((event) => [event.seq, event]));
      const liveTexts = surface.map((seq) => bodyOf(bySeq.get(seq)));
      const askText = 'You decide what the coding agent keeps of one tool result.';
      const leaked = liveTexts.filter((text) => text.includes(askText));
      if (leaked.length !== 0) return `${leaked.length} ask turn(s) survived on the live surface`;
      // And every KEEP-ALL result is still there, under its own call id and bytes.
      const keepallLine = asked.find((line) => line.action === 'keepall');
      if (keepallLine !== undefined) {
        const callId = String(keepallLine.eventId).split(':').pop();
        const live = surface.map((seq) => bySeq.get(seq))
          .filter((event) => event?.type === 'tool/result' && callIdOf(event) === callId);
        if (live.length !== 1) return `the kept result ${String(callId)} is on the surface ${String(live.length)} time(s)`;
        const original = byCallId.get(callId);
        if (original !== undefined && bodyOf(live[0]) !== original.bytes.toString('utf8')) {
          return `the kept result ${String(callId)} changed bytes on the surface`;
        }
      }
      // And the ask count is one per result: no result was asked twice.
      const ids = asked.map((line) => line.eventId);
      if (new Set(ids).size !== ids.length) return `a result was asked twice: ${JSON.stringify(ids)}`;
      return true;
    });
  }

  // ── (c) forget: one atomic apply, one appended shaped turn ───────────────
  const forgets = asked.filter((line) => line.action !== 'keepall');
  c.check('forget: each answer applied as two ordered writes (rewind, then shaped turn)', () => {
    if (forgets.length !== 2) return `expected 2 forget answers, saw ${forgets.length}`;
    for (const line of forgets) {
      const apply = applied.find((candidate) => candidate.eventId === line.eventId);
      if (apply === undefined) return `${line.action}: no entry-apply line`;
      if (apply.status !== 'landed') return `${line.action}: expected 'landed', saw ${JSON.stringify(apply.status)}`;
      if (apply.appends !== 2) return `${line.action}: expected 2 appends, saw ${String(apply.appends)}`;
      if (typeof apply.exchangeSeq !== 'number' || typeof apply.resultSeq !== 'number') {
        return `${line.action}: expected both seqs, saw ${JSON.stringify([apply.exchangeSeq, apply.resultSeq])}`;
      }
      if (!(apply.exchangeSeq < apply.resultSeq)) {
        return `${line.action}: the rewind seq ${String(apply.exchangeSeq)} is not before the shaped seq ${String(apply.resultSeq)}`;
      }
    }
    return true;
  });

  /**
   * The identity, printed in full for every forget:
   *   landed = kept + gaps×markerBytes + summaryBytes + framing
   * Every term is measured, not derived from `landed`: `summaryBytes` is the
   * prefix the mount documents, `markerBytes` is the marker lines actually in
   * the turn, `kept` is the number of the turn's non-marker bytes found
   * byte-exact in the ORIGINAL result, and `framing` is what is left over. A
   * mount that writes any other byte around the copy makes `framing` non-zero
   * and this check fails.
   */
  const identities = [];
  c.check('forget: the landed = kept + gaps*marker + summary + framing identity holds', () => {
    if (forgets.length !== 2) return `expected 2 forget answers, saw ${forgets.length}`;
    for (const line of forgets) {
      const callId = String(line.eventId).split(':').pop();
      const original = byCallId.get(callId);
      if (original === undefined) return `${String(callId)}: no original body`;
      const apply = applied.find((candidate) => candidate.eventId === line.eventId);
      if (apply === undefined || typeof apply.resultSeq !== 'number') return `${String(callId)}: no shaped seq`;
      const shapedEvent = sessionEvents.find((event) => event.seq === apply.resultSeq);
      if (shapedEvent === undefined) return `${String(callId)}: the shaped turn ${String(apply.resultSeq)} is not in the log`;
      const landedBytes = Buffer.from(bodyOf(shapedEvent), 'utf8');
      // The summary prefix is the answer's own line plus the blank line the
      // mount writes between it and the partials; its length is a fact about
      // the land, so it is the term the identity subtracts.
      const prefix = shapePrefixOf(line.summary);
      const payload = landedBytes.subarray(prefix.length);
      // The marker blocks in the shaped turn: one per dropped gap. A block is a
      // WHOLE LINE (ISSUE-063: the shipped templates end in a newline), so its
      // bytes are the line's text PLUS the terminator the split consumed.
      const { markers, keptRuns } = splitShapedPayload(payload);
      const markerBytes = markers.reduce((sum, marker) => sum + marker.length, 0);
      const gaps = markers.length;
      // The kept partials, measured against the original body. Bytes the
      // original does not hold are not `kept`; they land in `framing`.
      const kept = attributeKept(keptRuns, original.bytes);
      const framing = payload.length - markerBytes - kept;
      identities.push({ callId, action: line.action, landedBytes: landedBytes.length,
        originalBytes: original.bytes.length, kept, gaps, markerBytes,
        summaryBytes: prefix.length, framing });
      if (gaps < 1) return `${String(callId)}: no marker line in the shaped turn`;
      if (new Set(markers.map((marker) => marker.length)).size > 1) {
        return `${String(callId)}: the marker lines differ in length, so "gaps x marker" is not one term`;
      }
      if (framing !== 0) {
        return `${String(callId)}: framing is ${String(framing)} byte(s) that are neither summary, marker, nor kept result text`;
      }
      // The kept partials are real bytes of the original: a forgetall keeps none.
      if (line.action === 'forgetall' && kept !== 0) {
        return `${String(callId)}: forgetall kept ${String(kept)} bytes`;
      }
      if (line.action === 'keeplines' && kept <= 0) {
        return `${String(callId)}: keeplines kept no bytes`;
      }
      // The summary prefix is the answer's own note, verbatim.
      if (!landedBytes.toString('utf8').startsWith(prefix.toString('utf8'))) {
        return `${String(callId)}: the shaped turn does not open with the answer's summary`;
      }
      // And the marker is the shipped template, so a later reader can parse it.
      const emptyMarker = /\[racoons\] kept 0 of (\d+) lines · necromancy (recall:sha256:[0-9a-f]{64})/u
        .exec(landedBytes.toString('utf8'));
      if (line.action === 'forgetall') {
        if (emptyMarker === null) return `${String(callId)}: the forgetall marker is not the empty form`;
      } else {
        const withRanges = /\[racoons\] kept lines (\d+–\d+(?:, \d+–\d+)*) of (\d+) · (\d+) bytes dropped · necromancy (recall:sha256:[0-9a-f]{64})/u
          .exec(landedBytes.toString('utf8'));
        if (withRanges === null) return `${String(callId)}: the keeplines marker does not match the shipped template`;
      }
    }
    return true;
  });

  // ── (d) recall returns the ORIGINAL bytes of the unit its id belongs to ──
  c.check('recall after a forget returns the original bytes, byte-exact', () => {
    if (recallRecords.length === 0) return 'no recall record was read from the ledger';
    // The receipt of each forgotten unit: the marker in THAT unit's own shaped
    // turn names the id, and the unit's landed body is the only body that id
    // may restore. Binding id to unit is the point: a recall that returns some
    // OTHER landed result's bytes is a crossed archive, not a pass.
    const receipts = [];
    for (const line of forgets) {
      const callId = String(line.eventId).split(':').pop();
      const apply = applied.find((candidate) => candidate.eventId === line.eventId);
      if (apply === undefined || typeof apply.resultSeq !== 'number') {
        return `${String(callId)}: no shaped seq to read its receipt from`;
      }
      const shapedEvent = sessionEvents.find((event) => event.seq === apply.resultSeq);
      if (shapedEvent === undefined) return `${String(callId)}: the shaped turn is not in the log`;
      const recallId = /necromancy (recall:sha256:[0-9a-f]{64})/u.exec(bodyOf(shapedEvent))?.[1];
      if (recallId === undefined) return `${String(callId)}: the shaped turn names no recall id`;
      const unit = byCallId.get(callId);
      if (unit === undefined) return `${String(callId)}: no landed body to bind its recall to`;
      receipts.push({ callId, recallId, bytes: unit.bytes });
    }
    const byId = new Map(receipts.map((receipt) => [receipt.recallId, receipt]));
    if (byId.size !== receipts.length) {
      return `two forgotten units name the same recall id: ${JSON.stringify(receipts.map((r) => [r.callId, r.recallId]))}`;
    }
    if (recallRecords.length !== receipts.length) {
      return `expected ${receipts.length} recall record(s), one per forgotten unit, saw ${recallRecords.length}`;
    }
    for (const record of recallRecords) {
      if (record.status !== 'ok') return `recall ${String(record.recallId)} failed: ${String(record.detail)}`;
      // The id must be the receipt of a forgotten unit read from THIS run.
      const unit = byId.get(record.recallId);
      if (unit === undefined) {
        return `recall ${String(record.recallId)} is not the receipt of a forgotten unit (the receipts name ${JSON.stringify([...byId.keys()])})`;
      }
      const archivedSha256 = sha256(unit.bytes);
      // The ledger's own manifest must say this archive covers THIS unit: the
      // id was minted over that body, not over another result of the session.
      if (record.sourceSha256 !== archivedSha256) {
        return `recall ${String(record.recallId)} (unit ${unit.callId}) archives source ${String(record.sourceSha256)}, the unit's bytes are ${archivedSha256}`;
      }
      // The restored bytes are the archived bytes, whole: every part's node is
      // the unit's own node, and the restored body — marker line and trailing
      // sentinel included — is that body byte for byte.
      for (const part of record.parts ?? []) {
        if (!String(part.nodeId).endsWith(`result:${unit.callId}`)) {
          return `recall ${String(record.recallId)} (unit ${unit.callId}) restores part ${String(part.nodeId)}, not the unit's node`;
        }
        if (typeof part.byteLength === 'number' && part.byteLength !== unit.bytes.length) {
          return `recall ${String(record.recallId)} (unit ${unit.callId}) archives ${String(part.byteLength)} bytes, the unit has ${String(unit.bytes.length)}`;
        }
      }
      if (record.restoredSha256 !== archivedSha256) {
        return `recall ${String(record.recallId)} (unit ${unit.callId}) restored ${String(record.restoredSha256)}, the unit's bytes are ${archivedSha256}`;
      }
      if (record.restoredBytes !== unit.bytes.length) {
        return `recall ${String(record.recallId)} (unit ${unit.callId}) restored ${String(record.restoredBytes)} bytes, the unit has ${String(unit.bytes.length)}`;
      }
      if (typeof record.restoredText !== 'string'
        || sha256(Buffer.from(record.restoredText, 'utf8')) !== archivedSha256) {
        return `recall ${String(record.recallId)} (unit ${unit.callId}) restored text is not the unit's body, byte for byte`;
      }
    }
    // Every marker id is read exactly once: the records are one per receipt (the
    // length check above) and each must name a receipt (the `byId` lookup), so a
    // missing or duplicate read has already failed by name.
    return true;
  });

  // ── (e) prefix discipline ────────────────────────────────────────────────
  c.check('prefix discipline: no main request changes bytes before the last shared position', () => {
    if (mains.length < 2) return `expected at least 2 main requests, saw ${mains.length}`;
    const lines = [];
    for (let index = 1; index < mains.length; index += 1) {
      const previous = mainOf(mains[index - 1]);
      const current = mainOf(mains[index]);
      const shared = sharedPrefixLength(previous, current);
      lines.push(`${String(mains[index - 1].n)}->${String(mains[index].n)}=+${String(shared)}/${String(previous.length)}`);
      if (shared !== previous.length) {
        return `request ${String(mains[index].n)} diverged at message ${String(shared)} of ${String(previous.length)}: `
          + `previous ${JSON.stringify(previous[shared]).slice(0, 160)} `
          + `current ${JSON.stringify(current[shared]).slice(0, 160)}`;
      }
    }
    // Every earlier request is a prefix of the next one: the cache grows, never
    // moves. Printed so a reader sees the shape the assertion checked.
    c.prefixLines = lines;
    return true;
  });

  if (!refusal) {
    c.check('no ask failed open and no ask was skipped', () => {
      if (refused.length !== 0) return `refused: ${JSON.stringify(refused.map((l) => [l.code, l.reason ?? null]))}`;
      if (off.length !== 0) return `off: ${JSON.stringify(off.map((l) => l.reason))}`;
      return true;
    });
  } else {
    // The one scripted refusal is expected; any OTHER fail-open is not, and an
    // ask that never left (off) is the lane standing down, not this leg.
    c.check('no ask failed open beyond the scripted refusal and none was skipped', () => {
      if (refused.length !== 1) {
        return `expected the 1 scripted refusal, saw ${String(refused.length)}: ${JSON.stringify(refused.map((l) => l.code))}`;
      }
      if (applyRefused.length !== 0) {
        return `an apply failed open: ${JSON.stringify(applyRefused.map((l) => [l.callId, l.code]))}`;
      }
      if (off.length !== 0) return `off: ${JSON.stringify(off.map((l) => l.reason))}`;
      return true;
    });
  }

  // ── journal shape (kept here because it joins ask and apply) ─────────────
  c.check('journal: every entry-ask row carries usage and retried', () => {
    for (const line of asked) {
      if (!('retried' in line)) return `an entry-ask row carries no retried: ${JSON.stringify(line).slice(0, 200)}`;
      if (!('usage' in line) || typeof line.usage?.inputTokens !== 'number') {
        return `an entry-ask row carries no usage: ${JSON.stringify(line).slice(0, 200)}`;
      }
    }
    return true;
  });

  // ── raw material for the printed report ─────────────────────────────────
  return { results: c.results, identities, prefixLines: c.prefixLines ?? [],
    counts: { landed: landed.length, asked: asked.length, applied: applied.length,
      mains: mains.length, entryRequests: entryAsks.length, recalls: recallRecords.length } };
}

// ── the run ────────────────────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv.slice(2));
  // The compile step first: a dsh child cannot import TypeScript.
  try {
    ensureDist({ quiet: true });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  // Written every run: the scenario is this runner's own, never a second copy
  // that can drift from the assertions below. It is committed beside the runner
  // so the shape under test is reviewable in the diff. A perturbation run moves
  // a knob the tracked copy must never carry, so either leg writes its scenario
  // to a temp path instead of leaving the tracked one perturbed.
  const trackedScenarioPath = join(RIG_DIR, 'scenarios', 'entry-e2e.json');
  const perturbed = FLOOR_OVERRIDE !== null || ENTRY_REFUSAL;
  const scenarioPath = perturbed
    ? join(tmpdir(), `racoons-entry-e2e-${String(process.pid)}-${String(Date.now())}.json`)
    : trackedScenarioPath;
  writeFileSync(scenarioPath, `${JSON.stringify(scenario(), null, 2)}\n`);
  if (scenarioPath !== trackedScenarioPath) {
    // `process.exit()` skips `finally`, so the cleanup rides the exit event; the
    // file is a disposable copy under the OS temp dir.
    process.on('exit', () => { rmSync(scenarioPath, { force: true }); });
  }
  const started = Date.now();
  // The date dir is stamped at launch, where the driver stamps it: a run that
  // crosses midnight still names the directory the child wrote (ISSUE-581).
  const stamp = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const dateDir = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`;
  const run = spawnSync(process.execPath, [RUN, '--scenario', scenarioPath],
    { encoding: 'utf8', windowsHide: true, cwd: REPO_ROOT });
  const elapsed = Date.now() - started;
  if (options.verbose) process.stdout.write(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  if (run.status !== 0) {
    // The driver's own assertions failed (exit 0, the session shape, the mock's
    // lane counts). Its output names the first one; the entry checks below would
    // only report the same run's symptoms.
    process.stderr.write(`entry-e2e: the rig driver failed (exit ${String(run.status)})\n`);
    process.stderr.write(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    process.exit(1);
  }

  // The scenario's date-dir name is part of the driver's contract; it is the
  // stamp taken before the launch above.
  const evidence = join(REPO_ROOT, 'scratchpad', 'dsh-rig', `${dateDir}-entry-e2e`);
  const racoonsDir = join(evidence, 'racoons');
  const requests = readJsonl(join(evidence, 'requests.jsonl'));
  const journal = readJsonl(join(racoonsDir, 'cremator-events.jsonl'));
  const sessionLog = findSessionLog(join(evidence, 'home', 'sessions'));
  if (sessionLog === null) {
    process.stderr.write(`entry-e2e: expected exactly one session log under ${evidence}\n`);
    process.exit(1);
  }
  const sessionEvents = readJsonl(sessionLog);
  const originResults = sessionEvents.filter((event) => event.type === 'tool/result'
    && event.surfaceOp === 'append');

  // ── the ledger's own recall, read from a fresh process ───────────────────
  const storageRoot = join(racoonsDir, 'storage', 'sessions');
  const sessionDirs = existsSync(storageRoot)
    ? readdirSync(storageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const recallRecords = [];
  if (sessionDirs.length === 1) {
    const ledgerPath = join(storageRoot, sessionDirs[0], 'ledger.sqlite');
    const blobRoot = join(storageRoot, sessionDirs[0], 'blobs');
    // The ids the shaped turns name are the ones read; a missing marker means
    // the identity check above has already failed by name.
    const shaped = journal.filter((line) => line.kind === 'entry-apply')
      .map((line) => line.resultSeq).filter((seq) => typeof seq === 'number');
    const ids = new Set();
    for (const seq of shaped) {
      const event = sessionEvents.find((candidate) => candidate.seq === seq);
      const text = event === undefined ? '' : bodyOf(event);
      for (const match of text.matchAll(/necromancy (recall:sha256:[0-9a-f]{64})/gu)) ids.add(match[1]);
    }
    for (const id of ids) {
      const out = spawnSync(process.execPath, [join(RIG_DIR, 'inspect-ledger.mjs'),
        '--ledger', ledgerPath, '--blobs', blobRoot, '--recall', id],
      { encoding: 'utf8', windowsHide: true });
      try {
        recallRecords.push(JSON.parse((out.stdout ?? '').trim().split(/\r?\n/u).pop()));
      } catch {
        recallRecords.push({ status: 'error', recallId: id,
          detail: `inspect-ledger exited ${String(out.status)}: ${(out.stderr ?? '').slice(0, 300)}` });
      }
    }
  }

  const report = assertEntryLane({ requests, sessionEvents, journal, originResults,
    recallRecords, options: { ...options, entryRefusal: ENTRY_REFUSAL } });

  // ── print ────────────────────────────────────────────────────────────────
  process.stdout.write(`entry-e2e: ${String(evidence)}\n`);
  process.stdout.write(`entry-e2e: ${String(report.counts.landed)} landed result(s), `
    + `${String(report.counts.asked)} asked, ${String(report.counts.applied)} applied, `
    + `${String(report.counts.mains)} main request(s), ${String(report.counts.recalls)} recall(s)\n`);
  if (report.prefixLines.length > 0) {
    process.stdout.write(`entry-e2e: prefix reuse (request -> next = +shared/previous): ${report.prefixLines.join('  ')}\n`);
  }
  for (const identity of report.identities) {
    // EVERY term of the identity, printed: this is the arithmetic Phase R's
    // converter re-derives, so the numbers have to be visible here.
    process.stdout.write(`entry-e2e: identity ${identity.callId} (${identity.action}) `
      + `landed=${String(identity.landedBytes)} = kept ${String(identity.kept)} + gaps ${String(identity.gaps)}`
      + ` x marker ${String(identity.markerBytes)} + summary ${String(identity.summaryBytes)}`
      + ` + framing ${String(identity.framing)}   [original ${String(identity.originalBytes)} B]\n`);
  }
  let failed = 0;
  for (const result of report.results) {
    if (result.ok) {
      process.stdout.write(`ok   ${result.name}\n`);
      continue;
    }
    failed += 1;
    process.stdout.write(`FAIL ${result.name}: ${result.detail}\n`);
  }
  process.stdout.write(`entry-e2e: ${String(report.results.length - failed)}/${String(report.results.length)} assertions passed in ${String(elapsed)} ms\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// `assertEntryLane` is exported so the gate can drive synthetic evidence — the
// crossed recall case has no way to occur in a healthy product, so only a unit
// test can prove the check refuses it.
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
